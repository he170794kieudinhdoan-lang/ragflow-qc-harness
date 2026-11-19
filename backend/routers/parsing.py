import json
import os
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from database import UPLOAD_DIR, get_db, get_setting, utc_now
from ragflow_client import RAGFlowClient, RAGFlowError
from metrics import align_unit_to_chunks, extract_best_aligned_span_with_stitching, nfc
from extractor import extract_document_units

router = APIRouter(prefix="/api/parsing", tags=["parsing"])


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

        # Fetch chunks map for quick side-by-side display + neighbor lookup for cross-chunk stitching
        crows = conn.execute(
            "SELECT document_id, ragflow_chunk_id, chunk_index, content, page_num, char_count FROM chunks WHERE run_id = ?",
            (run_id,),
        ).fetchall()
        chunk_map = {c["ragflow_chunk_id"]: dict(c) for c in crows}
        chunk_by_pos = {(c["document_id"], c["chunk_index"]): dict(c) for c in crows}

        items = []
        for r in rows:
            d = dict(r)
            d["source_text"] = nfc(d["source_text"])
            matched_ids = json.loads(d["matched_chunk_ids"] or "[]")
            d["matched_chunk_ids"] = matched_ids
            d["error_codes"] = json.loads(d["error_codes"] or "[]")
            matched_chunks = []
            for cid in matched_ids:
                if cid in chunk_map:
                    ch_item = dict(chunk_map[cid])
                    ch_item["content"] = nfc(ch_item["content"])
                    prev_ch = chunk_by_pos.get((ch_item["document_id"], ch_item["chunk_index"] - 1))
                    next_ch = chunk_by_pos.get((ch_item["document_id"], ch_item["chunk_index"] + 1))
                    ch_item["alignment"] = extract_best_aligned_span_with_stitching(
                        d["source_text"],
                        ch_item["content"],
                        prev_chunk_content=nfc(prev_ch["content"]) if prev_ch else "",
                        prev_chunk_index=prev_ch["chunk_index"] if prev_ch else None,
                        next_chunk_content=nfc(next_ch["content"]) if next_ch else "",
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
    text_units = [r for r in rated if r["unit_type"] not in ("table", "image", "diagram")]
    table_units = [r for r in rated if r["unit_type"] == "table"]
    layout_units = [r for r in rated if r["unit_type"] in ("image", "diagram")]

    text_pass = sum(1 for r in text_units if r["verdict"] == "PASS")
    table_pass = sum(1 for r in table_units if r["verdict"] == "PASS")
    layout_pass = sum(1 for r in layout_units if r["verdict"] == "PASS")

    char_err = 0
    order_ok = 0
    for r in rated:
        codes = json.loads(r["error_codes"] or "[]")
        if r["char_error"] == 1 or any(c in ("P4", "P5", "P6") for c in codes):
            char_err += 1
        if "P3" not in codes:
            order_ok += 1

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
        if r["char_error"] == 1:
            b["char_err"] += 1

    return {
        "total_units": len(rows),
        "rated_units": len(rated),
        "text_completeness": round(text_pass / len(text_units), 4) if text_units else 0.0,
        "table_accuracy": round(table_pass / len(table_units), 4) if table_units else 0.0,
        "character_error_rate": round(char_err / len(rated), 4) if rated else 0.0,
        "layout_accuracy": round(layout_pass / len(layout_units), 4) if layout_units else 0.0,
        "layout_total": len(layout_units),
        "reading_order_accuracy": round(order_ok / len(rated), 4) if rated else 0.0,
        "by_format_group": by_group,
    }
