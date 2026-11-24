import json
import os
from functools import lru_cache
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from database import UPLOAD_DIR, get_db, get_setting, repair_chunk_document_links, utc_now
from ragflow_client import RAGFlowClient, RAGFlowError
from llm_client import LLMError, llm_ocr_image
from metrics import align_unit_to_chunks, compute_parsing_metrics, extract_best_aligned_span_with_stitching, nfc
from extractor import extract_document_units
from unit_sync import realign_units, units_need_realign

router = APIRouter(prefix="/api/parsing", tags=["parsing"])


@lru_cache(maxsize=4096)
def _cached_alignment(
    source_text: str,
    chunk_content: str,
    prev_chunk_content: str,
    prev_chunk_index: Optional[int],
    next_chunk_content: str,
    next_chunk_index: Optional[int],
    unit_type: str,
    format_group: str,
):
    # Cap huge source/chunk strings (e.g. 50k-char Excel sheets) so word-level
    # SequenceMatcher alignment cannot hang the /units endpoint.
    return extract_best_aligned_span_with_stitching(
        source_text[:4000],
        chunk_content[:6000],
        prev_chunk_content=prev_chunk_content[:3000],
        prev_chunk_index=prev_chunk_index,
        next_chunk_content=next_chunk_content[:3000],
        next_chunk_index=next_chunk_index,
        unit_type=unit_type,
        format_group=format_group,
    )


class ParsingUnitCreate(BaseModel):
    document_id: int
    unit_type: str = "text"
    page_num: int = 1
    title: str = ""
    source_text: str


class ParsingScoreUpdate(BaseModel):
    verdict: str  # PASS | FAIL | PARTIAL | UNRATED
    error_codes: List[str] = []
    char_error: bool = False
    severity: str = ""
    notes: str = ""


@router.get("/runs/{run_id}/units")
def list_parsing_units(run_id: int, document_id: Optional[int] = None):
    with get_db() as conn:
        q = """
            SELECT pu.*, d.doc_code, d.filename, d.format_group, d.file_path
            FROM parsing_units pu
            JOIN documents d ON d.id = pu.document_id
            WHERE pu.run_id = ?
        """
        params: list = [run_id]
        if document_id:
            q += " AND pu.document_id = ?"
            params.append(document_id)
        q += " ORDER BY d.doc_code, pu.unit_index"
        rows = conn.execute(q, params).fetchall()

        # Self-heal orphan chunk document_id links before building chunk_map
        repair_chunk_document_links(conn)

        # Fetch chunks map for quick side-by-side display + neighbor lookup for cross-chunk stitching
        crows = conn.execute(
            "SELECT document_id, ragflow_chunk_id, chunk_index, content, page_num, char_count FROM chunks WHERE run_id = ? ORDER BY chunk_index",
            (run_id,),
        ).fetchall()
        chunk_map = {c["ragflow_chunk_id"]: dict(c) for c in crows}
        chunk_by_pos = {(c["document_id"], c["chunk_index"]): dict(c) for c in crows}
        chunks_by_doc: dict = {}
        for c in crows:
            chunks_by_doc.setdefault(c["document_id"], []).append(dict(c))

        items = []
        now = utc_now()
        for r in rows:
            d = dict(r)
            d["source_text"] = nfc(d["source_text"])
            matched_ids = json.loads(d["matched_chunk_ids"] or "[]")
            # Auto-realign if matched_ids is empty or references missing chunks, when chunks exist for this doc
            valid_matched = [cid for cid in matched_ids if cid in chunk_map]
            if not valid_matched and d["document_id"] in chunks_by_doc:
                doc_chunks = chunks_by_doc[d["document_id"]]
                new_ids, new_score = align_unit_to_chunks(d["source_text"], doc_chunks)
                if not new_ids and d.get("page_num"):
                    page_matches = [c["ragflow_chunk_id"] for c in doc_chunks if c["page_num"] == d["page_num"]][:3]
                    if page_matches:
                        new_ids = page_matches
                        new_score = 0.01
                if new_ids:
                    matched_ids = new_ids
                    d["match_score"] = new_score
                    conn.execute(
                        "UPDATE parsing_units SET matched_chunk_ids = ?, match_score = ?, updated_at = ? WHERE id = ?",
                        (json.dumps(matched_ids), new_score, now, d["id"]),
                    )
            d["matched_chunk_ids"] = matched_ids
            d["error_codes"] = json.loads(d["error_codes"] or "[]")
            matched_chunks = []
            for cid in matched_ids:
                if cid in chunk_map:
                    ch_item = dict(chunk_map[cid])
                    ch_item["content"] = nfc(ch_item["content"])
                    prev_ch = chunk_by_pos.get((ch_item["document_id"], ch_item["chunk_index"] - 1))
                    next_ch = chunk_by_pos.get((ch_item["document_id"], ch_item["chunk_index"] + 1))
                    ch_item["alignment"] = _cached_alignment(
                        d["source_text"],
                        ch_item["content"],
                        nfc(prev_ch["content"]) if prev_ch else "",
                        prev_ch["chunk_index"] if prev_ch else None,
                        nfc(next_ch["content"]) if next_ch else "",
                        next_chunk_index=next_ch["chunk_index"] if next_ch else None,
                        unit_type=d.get("unit_type", "text"),
                        format_group=d.get("format_group", ""),
                    )
                    matched_chunks.append(ch_item)
            d["matched_chunks"] = matched_chunks
            d["has_local_file"] = bool(d["file_path"] and os.path.exists(d["file_path"]))
            items.append(d)
        return items


@router.post("/runs/{run_id}/units")
def create_parsing_unit(run_id: int, payload: ParsingUnitCreate):
    with get_db() as conn:
        crows = conn.execute(
            "SELECT ragflow_chunk_id, content FROM chunks WHERE run_id = ? AND document_id = ?",
            (run_id, payload.document_id),
        ).fetchall()
        matched_ids, score = align_unit_to_chunks(payload.source_text, [dict(c) for c in crows])
        max_idx = conn.execute(
            "SELECT COALESCE(MAX(unit_index), 0) FROM parsing_units WHERE run_id = ? AND document_id = ?",
            (run_id, payload.document_id),
        ).fetchone()[0]
        cur = conn.execute(
            """
            INSERT INTO parsing_units (run_id, document_id, unit_index, unit_type, page_num, title, source_text, matched_chunk_ids, match_score, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id, payload.document_id, max_idx + 1, payload.unit_type, payload.page_num,
                payload.title, payload.source_text, json.dumps(matched_ids), score, utc_now(),
            ),
        )
        return {"ok": True, "id": cur.lastrowid, "matched_chunk_ids": matched_ids, "match_score": score}


@router.post("/runs/{run_id}/re-extract")
async def re_extract_run_units(run_id: int, max_units: int = 25):
    """Re-extracts parsing_units for all documents in `run_id` with a custom `max_units` per document."""
    max_units = max(1, min(max_units, 200))
    with get_db() as conn:
        docs = conn.execute(
            """
            SELECT DISTINCT d.id
            FROM documents d
            JOIN run_documents rd ON rd.document_id = d.id
            WHERE rd.run_id = ?
            ORDER BY d.doc_code
            """,
            (run_id,),
        ).fetchall()
    total_extracted = 0
    for d in docs:
        try:
            res = await auto_extract_units(run_id, d["id"], max_units=max_units)
            total_extracted += int(res.get("extracted_units", 0))
        except Exception:
            continue
    return {"ok": True, "documents": len(docs), "extracted_units": total_extracted, "max_units": max_units}


@router.post("/runs/{run_id}/documents/{document_id}/auto-extract")
async def auto_extract_units(run_id: int, document_id: int, max_units: int = 25):
    """
    Extracts ground-truth text/table units from local PDF/DOCX/TXT/MD and auto-aligns to RAGFlow chunks.
    If the original file is not saved locally yet, automatically downloads it from RAGFlow first.
    """
    with get_db() as conn:
        doc = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
        if not doc:
            raise HTTPException(status_code=404, detail="Tài liệu không tồn tại")
        fp = doc["file_path"]
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        rd = conn.execute(
            "SELECT ragflow_doc_id FROM run_documents WHERE run_id = ? AND document_id = ?",
            (run_id, document_id),
        ).fetchone()

    downloaded = False
    if not fp or not os.path.exists(fp):
        dataset_id = run["ragflow_dataset_id"] if run else ""
        ragflow_doc_id = rd["ragflow_doc_id"] if rd else ""
        base_url = get_setting("ragflow_base_url", "")
        api_key = get_setting("ragflow_api_key", "")

        if not (dataset_id and ragflow_doc_id and base_url and api_key):
            raise HTTPException(
                status_code=400,
                detail="Tài liệu chưa có file gốc lưu local và chưa có đủ thông tin RAGFlow để tự tải về.",
            )

        client = RAGFlowClient(base_url, api_key)
        try:
            file_bytes = await client.download_document(dataset_id, ragflow_doc_id)
        except RAGFlowError as e:
            raise HTTPException(status_code=400, detail=f"Không tải được file gốc từ RAGFlow: {e}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Lỗi khi tải file gốc từ RAGFlow: {e}")

        safe_name = os.path.basename(doc["filename"] or f"{doc['doc_code']}.bin")
        fp = os.path.join(UPLOAD_DIR, f"{doc['doc_code']}_{safe_name}")
        with open(fp, "wb") as f:
            f.write(file_bytes)

        page_count = doc["page_count"] or 0
        if fp.lower().endswith(".pdf"):
            try:
                import fitz
                pdf_tmp = fitz.open(fp)
                page_count = len(pdf_tmp)
                pdf_tmp.close()
            except Exception:
                pass

        with get_db() as conn:
            conn.execute(
                "UPDATE documents SET file_path = ?, page_count = ? WHERE id = ?",
                (fp, page_count, document_id),
            )
        downloaded = True

    extracted = extract_document_units(fp, max_units=max_units)

    with get_db() as conn:
        crows = conn.execute(
            "SELECT ragflow_chunk_id, content FROM chunks WHERE run_id = ? AND document_id = ?",
            (run_id, document_id),
        ).fetchall()
        chunks_list = [dict(c) for c in crows]

        conn.execute(
            "DELETE FROM parsing_units WHERE run_id = ? AND document_id = ?",
            (run_id, document_id),
        )
        for idx, (utype, pnum, title, stxt) in enumerate(extracted, start=1):
            matched_ids, score = align_unit_to_chunks(stxt, chunks_list)
            conn.execute(
                """
                INSERT INTO parsing_units (run_id, document_id, unit_index, unit_type, page_num, title, source_text, matched_chunk_ids, match_score, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id, document_id, idx, utype, pnum, title, stxt,
                    json.dumps(matched_ids), score, utc_now(),
                ),
            )
        return {"ok": True, "extracted_units": len(extracted), "downloaded_from_ragflow": downloaded}


class BulkApprovePayload(BaseModel):
    unit_ids: List[int]


@router.post("/runs/{run_id}/bulk-approve-pass")
def bulk_approve_pass(run_id: int, payload: BulkApprovePayload):
    if not payload.unit_ids:
        return {"ok": True, "updated": 0}
    now = utc_now()
    placeholders = ",".join("?" for _ in payload.unit_ids)
    with get_db() as conn:
        cur = conn.execute(
            f"""
            UPDATE parsing_units
            SET verdict = 'PASS', error_codes = '[]', char_error = 0, severity = '', updated_at = ?
            WHERE run_id = ? AND id IN ({placeholders})
            """,
            [now, run_id, *payload.unit_ids],
        )
        return {"ok": True, "updated": cur.rowcount}


class BulkFailItem(BaseModel):
    unit_id: int
    error_codes: List[str] = []
    char_error: bool = False
    severity: str = ""
    notes: str = ""


class BulkFailPayload(BaseModel):
    items: List[BulkFailItem]


@router.post("/runs/{run_id}/bulk-approve-fail")
def bulk_approve_fail(run_id: int, payload: BulkFailPayload):
    if not payload.items:
        return {"ok": True, "updated": 0}
    now = utc_now()
    updated = 0
    with get_db() as conn:
        for item in payload.items:
            has_char_code = any(c in ("P4", "P5", "P6") for c in item.error_codes)
            char_err_flag = 1 if (item.char_error or has_char_code) else 0
            cur = conn.execute(
                """
                UPDATE parsing_units
                SET verdict = 'FAIL', error_codes = ?, char_error = ?, severity = ?, notes = ?, updated_at = ?
                WHERE run_id = ? AND id = ?
                """,
                (
                    json.dumps(item.error_codes, ensure_ascii=False),
                    char_err_flag,
                    item.severity,
                    item.notes,
                    now,
                    run_id,
                    item.unit_id,
                ),
            )
            updated += cur.rowcount
    return {"ok": True, "updated": updated}


@router.put("/units/{unit_id}/score")
def score_parsing_unit(unit_id: int, payload: ParsingScoreUpdate):
    # Sync Character Error automatically if any Phụ lục B char-error code (P4, P5, P6) is tagged
    has_char_code = any(c in ("P4", "P5", "P6") for c in payload.error_codes)
    char_err_flag = 1 if (payload.char_error or has_char_code) else 0
    with get_db() as conn:
        conn.execute(
            """
            UPDATE parsing_units
            SET verdict = ?, error_codes = ?, char_error = ?, severity = ?, notes = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                payload.verdict,
                json.dumps(payload.error_codes),
                char_err_flag,
                payload.severity,
                payload.notes,
                utc_now(),
                unit_id,
            ),
        )
    return {"ok": True}


@router.post("/units/{unit_id}/vision-ocr")
async def vision_ocr_unit(unit_id: int):
    """Uses the configured Vision LLM to OCR a scanned PDF page as ground-truth source_text."""
    llm_base = get_setting("llm_base_url", "").strip()
    llm_key = get_setting("llm_api_key", "").strip()
    llm_model = get_setting("llm_model", "").strip()
    if not llm_base or not llm_model:
        raise HTTPException(
            status_code=400,
            detail="Chưa cấu hình Vision LLM trong Cài đặt → LLM Chấm tự động (khuyên dùng Gemini / GPT-4o-mini / Qwen2.5-VL).",
        )

    with get_db() as conn:
        row = conn.execute(
            """
            SELECT pu.*, d.file_path
            FROM parsing_units pu
            JOIN documents d ON d.id = pu.document_id
            WHERE pu.id = ?
            """,
            (unit_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Đoạn đối chiếu không tồn tại")
    fp = row["file_path"]
    if not fp or not os.path.exists(fp) or not fp.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Chỉ hỗ trợ Vision OCR cho tài liệu PDF có file gốc local.")

    import fitz
    pdf = fitz.open(fp)
    idx = max(0, min((row["page_num"] or 1) - 1, len(pdf) - 1))
    pix = pdf[idx].get_pixmap(dpi=150)
    png_bytes = pix.tobytes("png")
    pdf.close()

    try:
        ocr_text = await llm_ocr_image(llm_base, llm_key, llm_model, png_bytes)
    except LLMError as e:
        raise HTTPException(status_code=400, detail=f"Lỗi Vision LLM: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Không gọi được Vision LLM: {e}")

    with get_db() as conn:
        crows = conn.execute(
            "SELECT ragflow_chunk_id, content FROM chunks WHERE run_id = ? AND document_id = ? ORDER BY chunk_index",
            (row["run_id"], row["document_id"]),
        ).fetchall()
        matched_ids, score = align_unit_to_chunks(ocr_text, [dict(c) for c in crows])
        conn.execute(
            "UPDATE parsing_units SET source_text = ?, matched_chunk_ids = ?, match_score = ?, updated_at = ? WHERE id = ?",
            (ocr_text, json.dumps(matched_ids), score, utc_now(), unit_id),
        )
    return {"ok": True, "source_text": ocr_text, "matched_chunk_ids": matched_ids, "match_score": score}


@router.get("/documents/{document_id}/page/{page_num}")
def render_pdf_page(document_id: int, page_num: int):
    """Renders a crisp PNG preview of a PDF page for Side-by-Side inspection."""
    with get_db() as conn:
        doc = conn.execute("SELECT file_path FROM documents WHERE id = ?", (document_id,)).fetchone()
    if not doc or not doc["file_path"] or not os.path.exists(doc["file_path"]):
        raise HTTPException(status_code=404, detail="Không tìm thấy file gốc")
    if not doc["file_path"].lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Chỉ hỗ trợ render ảnh trang cho PDF")
    import fitz
    pdf = fitz.open(doc["file_path"])
    idx = max(0, min(page_num - 1, len(pdf) - 1))
    pix = pdf[idx].get_pixmap(dpi=150)
    png_bytes = pix.tobytes("png")
    pdf.close()
    return Response(content=png_bytes, media_type="image/png")


@router.get("/runs/{run_id}/metrics")
def get_parsing_metrics(run_id: int):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT pu.*, d.doc_code, d.format_group
            FROM parsing_units pu
            JOIN documents d ON d.id = pu.document_id
            WHERE pu.run_id = ?
            """,
            (run_id,),
        ).fetchall()

    rated = [r for r in rows if r["verdict"] != "UNRATED"]
    summary = compute_parsing_metrics(rows)

    by_group = {}
    for r in rated:
        g = r["format_group"]
        b = by_group.setdefault(g, {"total": 0, "pass": 0, "table_total": 0, "table_pass": 0, "char_err": 0})
        b["total"] += 1
        if r["verdict"] == "PASS":
            b["pass"] += 1
        if r["unit_type"] == "table":
            b["table_total"] += 1
            if r["verdict"] == "PASS":
                b["table_pass"] += 1
        raw_codes = r["error_codes"]
        codes = set(json.loads(raw_codes) if isinstance(raw_codes, str) else (raw_codes or []))
        if r["char_error"] == 1 or bool(codes & {"P4", "P5", "P6"}):
            b["char_err"] += 1

    summary["by_format_group"] = by_group
    return summary
