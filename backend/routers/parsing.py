import asyncio
import json
import os
import re
from functools import lru_cache
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from database import UPLOAD_DIR, get_db, get_setting, repair_chunk_document_links, utc_now
from ragflow_client import RAGFlowClient, RAGFlowError
from llm_client import LLMError, llm_judge_parsing_unit, llm_ocr_image, llm_ocr_images_batch, local_ocr_with_vietnamese_restore
from metrics import align_unit_to_chunks, compute_parsing_metrics, extract_best_aligned_span, extract_best_aligned_span_with_stitching, nfc, normalize_text
from extractor import extract_document_units
from unit_sync import UNIT_SYNC_STATUS, get_unit_sync_status, realign_units, units_need_realign

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
    # Cap huge source/chunk strings (e.g. 50k-char Excel sheets) so O(N*M)
    # partial_ratio_alignment stays fast (<1s for 400+ units), while next_chunk_content
    # carries a continuous multi-chunk window up to 6k chars.
    return extract_best_aligned_span_with_stitching(
        source_text[:4000],
        chunk_content[:6000],
        prev_chunk_content=prev_chunk_content[:3000],
        prev_chunk_index=prev_chunk_index,
        next_chunk_content=next_chunk_content[:6000],
        next_chunk_index=next_chunk_index,
        unit_type=unit_type,
        format_group=format_group,
    )


@lru_cache(maxsize=4096)
def _cached_single_alignment(
    source_text: str,
    chunk_content: str,
    unit_type: str,
    format_group: str,
):
    return extract_best_aligned_span(
        source_text[:4000],
        chunk_content[:6000],
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
    fidelity_error: bool = False
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
                new_ids, new_score = align_unit_to_chunks(d["source_text"], doc_chunks, page_num=d.get("page_num"))
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
            for m_idx, cid in enumerate(matched_ids):
                if cid in chunk_map:
                    ch_item = dict(chunk_map[cid])
                    ch_item["content"] = nfc(ch_item["content"])
                    if m_idx == 0:
                        prev_ch = chunk_by_pos.get((ch_item["document_id"], ch_item["chunk_index"] - 1))
                        next_ch = chunk_by_pos.get((ch_item["document_id"], ch_item["chunk_index"] + 1))
                        # Build a dynamic forward continuous-stream window covering source_text length
                        # so Parsing evaluation is decoupled from RAGFlow's chunk_token_num boundary.
                        target_win_len = min(max(len(d["source_text"]) + 600, 1800), 6000)
                        fwd_parts = []
                        fwd_len = len(ch_item["content"])
                        offset = 1
                        while fwd_len < target_win_len and offset <= 4:
                            nxt = chunk_by_pos.get((ch_item["document_id"], ch_item["chunk_index"] + offset))
                            if not nxt:
                                break
                            nxt_txt = nfc(nxt["content"])
                            fwd_parts.append(nxt_txt)
                            fwd_len += len(nxt_txt) + 1
                            offset += 1
                        next_window = "\n".join(fwd_parts).strip()
                        ch_item["alignment"] = _cached_alignment(
                            d["source_text"],
                            ch_item["content"],
                            nfc(prev_ch["content"]) if prev_ch else "",
                            prev_ch["chunk_index"] if prev_ch else None,
                            next_window,
                            next_chunk_index=next_ch["chunk_index"] if next_ch else None,
                            unit_type=d.get("unit_type", "text"),
                            format_group=d.get("format_group", ""),
                        )
                    else:
                        ch_item["alignment"] = _cached_single_alignment(
                            d["source_text"],
                            ch_item["content"],
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
    """Re-extracts parsing_units for all documents in `run_id` using natural section grouping."""
    max_units = max(1, min(max_units, 500))
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
    # Automatically OCR any pending scanned/image units first, then run LLM-as-a-Judge
    await run_batch_vision_ocr_for_run(run_id, update_sync_status=False)
    llm_res = await run_batch_llm_judge_parsing(run_id, only_unrated=True, update_sync_status=False)
    return {
        "ok": True,
        "documents": len(docs),
        "extracted_units": total_extracted,
        "max_units": max_units,
        "llm_judged": llm_res.get("judged", 0),
        "llm_pass": llm_res.get("pass_count", 0),
        "llm_fail": llm_res.get("fail_count", 0),
    }


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
            "SELECT ragflow_chunk_id, content, page_num FROM chunks WHERE run_id = ? AND document_id = ?",
            (run_id, document_id),
        ).fetchall()
        chunks_list = [dict(c) for c in crows]

        # Preserve existing manual/LLM QC ratings (including fidelity_error & judge_source) before re-extracting
        prev_rows = conn.execute(
            """
            SELECT unit_type, page_num, source_text, verdict, error_codes, char_error, fidelity_error, severity, notes, judge_source
            FROM parsing_units
            WHERE run_id = ? AND document_id = ? AND verdict != 'UNRATED'
            """,
            (run_id, document_id),
        ).fetchall()
        preserved = {
            (r["unit_type"], r["page_num"], normalize_text(r["source_text"])[:120]): dict(r)
            for r in prev_rows
        }

        conn.execute(
            "DELETE FROM parsing_units WHERE run_id = ? AND document_id = ?",
            (run_id, document_id),
        )
        preserved_count = 0
        for idx, (utype, pnum, title, stxt) in enumerate(extracted, start=1):
            matched_ids, score = align_unit_to_chunks(stxt, chunks_list, page_num=pnum)
            prev_rating = preserved.get((utype, pnum, normalize_text(stxt)[:120]))
            if prev_rating:
                preserved_count += 1
                conn.execute(
                    """
                    INSERT INTO parsing_units (run_id, document_id, unit_index, unit_type, page_num, title, source_text, matched_chunk_ids, match_score, verdict, error_codes, char_error, fidelity_error, severity, notes, judge_source, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run_id, document_id, idx, utype, pnum, title, stxt,
                        json.dumps(matched_ids), score,
                        prev_rating["verdict"], prev_rating["error_codes"], prev_rating["char_error"],
                        prev_rating.get("fidelity_error", 0),
                        prev_rating["severity"], prev_rating["notes"], prev_rating.get("judge_source") or "", utc_now(),
                    ),
                )
            else:
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
        return {
            "ok": True,
            "extracted_units": len(extracted),
            "preserved_ratings": preserved_count,
            "downloaded_from_ragflow": downloaded,
        }


class BulkApprovePayload(BaseModel):
    unit_ids: List[int]
    force: bool = False


@router.post("/runs/{run_id}/bulk-approve-pass")
def bulk_approve_pass(run_id: int, payload: BulkApprovePayload):
    if not payload.unit_ids:
        return {"ok": True, "updated": 0, "skipped_ids": []}
    now = utc_now()
    placeholders = ",".join("?" for _ in payload.unit_ids)
    with get_db() as conn:
        allowed_ids = list(payload.unit_ids)
        skipped_ids: List[int] = []
        if not payload.force:
            rows = conn.execute(
                f"SELECT id, verdict, match_score FROM parsing_units WHERE run_id = ? AND id IN ({placeholders})",
                [run_id, *payload.unit_ids],
            ).fetchall()
            allowed_ids = []
            for r in rows:
                if r["verdict"] == "FAIL" or (r["match_score"] is not None and float(r["match_score"]) < 0.72):
                    skipped_ids.append(r["id"])
                else:
                    allowed_ids.append(r["id"])
        if not allowed_ids:
            return {"ok": True, "updated": 0, "skipped_ids": skipped_ids}
        allow_ph = ",".join("?" for _ in allowed_ids)
        cur = conn.execute(
            f"""
            UPDATE parsing_units
            SET verdict = 'PASS', error_codes = '[]', char_error = 0, severity = '', updated_at = ?
            WHERE run_id = ? AND id IN ({allow_ph})
            """,
            [now, run_id, *allowed_ids],
        )
        return {"ok": True, "updated": cur.rowcount, "skipped_ids": skipped_ids}


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
                SET verdict = 'FAIL', error_codes = ?, char_error = ?, severity = ?, notes = ?, judge_source = 'MANUAL', updated_at = ?
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
    fid_err_flag = 1 if (payload.fidelity_error or any(c in ("FIDELITY", "P10") for c in payload.error_codes)) else 0
    with get_db() as conn:
        conn.execute(
            """
            UPDATE parsing_units
            SET verdict = ?, error_codes = ?, char_error = ?, fidelity_error = ?, severity = ?, notes = ?, judge_source = 'MANUAL', updated_at = ?
            WHERE id = ?
            """,
            (
                payload.verdict,
                json.dumps(payload.error_codes),
                char_err_flag,
                fid_err_flag,
                payload.severity,
                payload.notes,
                utc_now(),
                unit_id,
            ),
        )
    return {"ok": True}


_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
_BBOX_RE = re.compile(r"bbox=(-?\d+),(-?\d+),(-?\d+),(-?\d+)")


def _parse_bbox_from_source(source_text: str) -> Optional[tuple]:
    m = _BBOX_RE.search(source_text or "")
    if not m:
        return None
    x0, y0, x1, y1 = (int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)))
    if x1 > x0 + 10 and y1 > y0 + 10:
        return (x0, y0, x1, y1)
    return None


def _render_unit_image_bytes(fp: str, page_num: int, bbox: Optional[tuple] = None) -> bytes:
    ext = os.path.splitext(fp)[1].lower()
    if ext == ".pdf":
        import fitz
        pdf = fitz.open(fp)
        try:
            idx = max(0, min((page_num or 1) - 1, len(pdf) - 1))
            page = pdf[idx]
            if bbox:
                clip = fitz.Rect(*bbox) & page.rect
                if clip.width > 10 and clip.height > 10:
                    pix = page.get_pixmap(clip=clip, dpi=180)
                    return pix.tobytes("png")
            pix = page.get_pixmap(dpi=120)
            return pix.tobytes("jpeg", jpg_quality=82)
        finally:
            pdf.close()
    if ext in _IMAGE_EXTS:
        with open(fp, "rb") as f:
            return f.read()
    raise HTTPException(status_code=400, detail="Chỉ hỗ trợ Vision OCR cho tài liệu PDF hoặc ảnh (PNG/JPG/WEBP/BMP).")


def _get_vision_config() -> tuple:
    """Returns (base_url, api_key, model) for Vision OCR, preferring dedicated vision_* settings with fallback to llm_*."""
    v_model = get_setting("vision_model", "").strip()
    if v_model:
        v_base = get_setting("vision_base_url", "").strip() or get_setting("llm_base_url", "").strip()
        v_key = get_setting("vision_api_key", "").strip() or get_setting("llm_api_key", "").strip()
        return v_base, v_key, v_model
    return (
        get_setting("llm_base_url", "").strip(),
        get_setting("llm_api_key", "").strip(),
        get_setting("llm_model", "").strip(),
    )


async def run_batch_vision_ocr_for_run(run_id: int, update_sync_status: bool = True) -> dict:
    """Runs Vision LLM OCR on all pending scanned/image placeholder units in a run."""
    llm_base, llm_key, llm_model = _get_vision_config()
    if not llm_base or not llm_model:
        return {"ok": False, "reason": "not_configured", "total": 0, "done": 0, "failed": 0}

    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT pu.id, pu.run_id, pu.document_id, pu.page_num, pu.unit_type, pu.source_text, d.file_path
            FROM parsing_units pu
            JOIN documents d ON d.id = pu.document_id
            WHERE pu.run_id = ?
              AND (pu.source_text LIKE '[Trang %' OR pu.source_text LIKE '[Hình ảnh / Sơ đồ%')
            ORDER BY d.doc_code, pu.unit_index
            """,
            (run_id,),
        ).fetchall()

    targets = [
        dict(r) for r in rows
        if r["file_path"] and os.path.exists(r["file_path"])
        and (r["file_path"].lower().endswith(".pdf") or r["file_path"].lower().endswith(_IMAGE_EXTS))
    ]
    if not targets:
        return {"ok": True, "total": 0, "done": 0, "failed": 0}

    if update_sync_status:
        UNIT_SYNC_STATUS[run_id] = {"running": True, "done": 0, "total": len(targets)}

    sem = asyncio.Semaphore(3)
    done_cnt = 0
    fail_cnt = 0
    dropped_decorative = 0

    llm_base_txt = get_setting("llm_base_url", "").strip()
    llm_key_txt = get_setting("llm_api_key", "").strip()
    llm_model_txt = get_setting("llm_model", "").strip()
    use_local_ocr = llm_model.lower() in ("local-rapidocr", "rapidocr")

    async def _ocr_one(item: dict) -> None:
        nonlocal done_cnt, fail_cnt, dropped_decorative
        async with sem:
            try:
                bbox = _parse_bbox_from_source(item.get("source_text") or "")
                img_bytes = await asyncio.to_thread(_render_unit_image_bytes, item["file_path"], item["page_num"] or 1, bbox)
                if use_local_ocr:
                    ocr_text = await local_ocr_with_vietnamese_restore(img_bytes, llm_base_txt, llm_key_txt, llm_model_txt)
                else:
                    try:
                        ocr_text = await llm_ocr_image(llm_base, llm_key, llm_model, img_bytes)
                    except Exception:
                        ocr_text = await local_ocr_with_vietnamese_restore(img_bytes, llm_base_txt, llm_key_txt, llm_model_txt)
                cleaned_ocr = (ocr_text or "").strip()
                alnum_len = len(re.findall(r"[0-9A-Za-zÀ-ỹ]", cleaned_ocr))
                # Purely decorative embedded photo (no readable text/labels) -> drop automatically so it never creates fake FAILs
                if item.get("unit_type") in ("image", "diagram") and alnum_len < 12:
                    with get_db() as conn:
                        conn.execute("DELETE FROM parsing_units WHERE id = ?", (item["id"],))
                    dropped_decorative += 1
                    return
                if cleaned_ocr:
                    with get_db() as conn:
                        crows = conn.execute(
                            "SELECT ragflow_chunk_id, content, page_num FROM chunks WHERE run_id = ? AND document_id = ? ORDER BY chunk_index",
                            (item["run_id"], item["document_id"]),
                        ).fetchall()
                        matched_ids, score = align_unit_to_chunks(cleaned_ocr, [dict(c) for c in crows], page_num=item["page_num"] or 0)
                        conn.execute(
                            "UPDATE parsing_units SET source_text = ?, matched_chunk_ids = ?, match_score = ?, verdict = 'UNRATED', updated_at = ? WHERE id = ?",
                            (cleaned_ocr, json.dumps(matched_ids), score, utc_now(), item["id"]),
                        )
                    done_cnt += 1
                else:
                    fail_cnt += 1
            except Exception as e:
                # For embedded image/diagram units inside digital PDFs, if RapidOCR finds 0 text boxes
                # ("không đọc được chữ nào"), it is a purely decorative photo -> auto-drop cleanly.
                if item.get("unit_type") in ("image", "diagram") and "không đọc được chữ" in str(e).lower():
                    with get_db() as conn:
                        conn.execute("DELETE FROM parsing_units WHERE id = ?", (item["id"],))
                    dropped_decorative += 1
                else:
                    fail_cnt += 1
            finally:
                if update_sync_status:
                    st = UNIT_SYNC_STATUS.get(run_id)
                    if st:
                        st["done"] = int(st.get("done", 0)) + 1

    try:
        await asyncio.gather(*(_ocr_one(t) for t in targets))
    finally:
        if update_sync_status:
            st = UNIT_SYNC_STATUS.get(run_id)
            if st:
                st["running"] = False

    return {"ok": True, "total": len(targets), "done": done_cnt, "failed": fail_cnt, "dropped_decorative": dropped_decorative}


@router.post("/runs/{run_id}/batch-vision-ocr")
async def batch_vision_ocr(run_id: int):
    llm_base, _llm_key, llm_model = _get_vision_config()
    if not llm_base or not llm_model:
        raise HTTPException(
            status_code=400,
            detail="Chưa cấu hình Vision LLM trong Cài đặt → Kết nối & API (khuyên dùng Gemini Flash / GPT-4o-mini / Qwen2.5-VL).",
        )
    return await run_batch_vision_ocr_for_run(run_id, update_sync_status=True)


@router.post("/runs/{run_id}/documents/{document_id}/vision-ocr")
async def vision_ocr_document(run_id: int, document_id: int):
    """
    Runs Vision LLM enhancement (OCR) on all units of a single OCR/scanned document,
    re-aligns against RAGFlow chunks, and re-judges those units with LLM-as-a-Judge.
    """
    v_base, v_key, v_model = _get_vision_config()
    if not v_base or not v_model:
        raise HTTPException(
            status_code=400,
            detail="Chưa cấu hình Vision LLM trong Cài đặt → Kết nối & API → Vision LLM.",
        )

    with get_db() as conn:
        doc = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
        if not doc:
            raise HTTPException(status_code=404, detail="Tài liệu không tồn tại")
        fp = doc["file_path"]
        if not fp or not os.path.exists(fp):
            raise HTTPException(status_code=400, detail="Tài liệu chưa có file gốc local.")
        if not (fp.lower().endswith(".pdf") or fp.lower().endswith(_IMAGE_EXTS)):
            raise HTTPException(status_code=400, detail="Chỉ hỗ trợ Vision Enhancement cho file PDF hoặc ảnh.")
        units = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM parsing_units WHERE run_id = ? AND document_id = ? ORDER BY unit_index",
                (run_id, document_id),
            ).fetchall()
        ]
        crows = [
            dict(c)
            for c in conn.execute(
                "SELECT ragflow_chunk_id, content, page_num FROM chunks WHERE run_id = ? AND document_id = ? ORDER BY chunk_index",
                (run_id, document_id),
            ).fetchall()
        ]

    if not units:
        return {"ok": True, "total": 0, "done": 0, "failed": 0, "model": v_model}

    BATCH_SIZE = 4
    batches = [units[i : i + BATCH_SIZE] for i in range(0, len(units), BATCH_SIZE)]
    sem = asyncio.Semaphore(5)
    done_cnt = 0
    fail_cnt = 0
    last_err = ""

    def _render_batch(batch_units: list) -> list:
        out = []
        if fp.lower().endswith(".pdf"):
            import fitz
            pdf = fitz.open(fp)
            try:
                for u in batch_units:
                    idx = max(0, min((u["page_num"] or 1) - 1, len(pdf) - 1))
                    pix = pdf[idx].get_pixmap(dpi=120)
                    out.append((u["id"], pix.tobytes("jpeg", jpg_quality=82)))
            finally:
                pdf.close()
        else:
            with open(fp, "rb") as f:
                raw_b = f.read()
            for u in batch_units:
                out.append((u["id"], raw_b))
        return out

    llm_base_txt = get_setting("llm_base_url", "").strip()
    llm_key_txt = get_setting("llm_api_key", "").strip()
    llm_model_txt = get_setting("llm_model", "").strip()
    use_local_ocr = v_model.lower() in ("local-rapidocr", "rapidocr")

    async def _ocr_batch(batch_units: list):
        nonlocal done_cnt, fail_cnt, last_err
        async with sem:
            pages = await asyncio.to_thread(_render_batch, batch_units)
            page_map = dict(pages)
            ocr_map: dict = {}
            if not use_local_ocr:
                for attempt in range(3):
                    try:
                        ocr_map = await llm_ocr_images_batch(v_base, v_key, v_model, pages)
                        if ocr_map:
                            break
                    except Exception as e:
                        last_err = str(e)[:180]
                        if attempt < 2 and ("503" in last_err or "429" in last_err):
                            await asyncio.sleep(2.0 * (attempt + 1))
                            continue
                        break

            for u in batch_units:
                uid = u["id"]
                if not ocr_map.get(uid):
                    try:
                        if use_local_ocr:
                            single_txt = await local_ocr_with_vietnamese_restore(
                                page_map[uid], llm_base_txt, llm_key_txt, llm_model_txt
                            )
                        else:
                            try:
                                single_txt = await llm_ocr_image(v_base, v_key, v_model, page_map[uid])
                            except Exception as e_vlm:
                                last_err = str(e_vlm)[:180]
                                single_txt = await local_ocr_with_vietnamese_restore(
                                    page_map[uid], llm_base_txt, llm_key_txt, llm_model_txt
                                )
                        if single_txt and single_txt.strip():
                            ocr_map[uid] = single_txt
                    except Exception as e:
                        last_err = str(e)[:180]

            with get_db() as conn:
                now = utc_now()
                for u in batch_units:
                    ocr_text = (ocr_map.get(u["id"]) or "").strip()
                    if ocr_text:
                        matched_ids, score = align_unit_to_chunks(ocr_text, crows, page_num=u["page_num"] or 0)
                        conn.execute(
                            """
                            UPDATE parsing_units
                            SET source_text = ?, matched_chunk_ids = ?, match_score = ?, verdict = 'UNRATED', updated_at = ?
                            WHERE id = ?
                            """,
                            (ocr_text, json.dumps(matched_ids), score, now, u["id"]),
                        )
                        done_cnt += 1
                    else:
                        fail_cnt += 1

    await asyncio.gather(*(_ocr_batch(b) for b in batches))

    # Automatically re-judge the freshly OCR'd units with LLM-as-a-Judge
    # Automatically OCR any pending scanned/image units first, then run LLM-as-a-Judge
    await run_batch_vision_ocr_for_run(run_id, update_sync_status=False)
    llm_res = await run_batch_llm_judge_parsing(run_id, only_unrated=True, update_sync_status=False)
    return {
        "ok": True,
        "total": len(units),
        "done": done_cnt,
        "failed": fail_cnt,
        "last_error": last_err if fail_cnt else "",
        "vision_model": v_model,
        "llm_judged": llm_res.get("judged", 0),
    }


@router.post("/units/{unit_id}/vision-ocr")
async def vision_ocr_unit(unit_id: int):
    """Uses the configured Vision LLM to OCR a scanned PDF page or image as ground-truth source_text."""
    llm_base, llm_key, llm_model = _get_vision_config()
    if not llm_base or not llm_model:
        raise HTTPException(
            status_code=400,
            detail="Chưa cấu hình Vision LLM trong Cài đặt → Kết nối & API (khuyên dùng Gemini Flash / GPT-4o-mini / Qwen2.5-VL).",
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
    if not fp or not os.path.exists(fp):
        raise HTTPException(status_code=400, detail="Tài liệu chưa có file gốc local.")

    bbox = _parse_bbox_from_source(row["source_text"] or "")
    png_bytes = _render_unit_image_bytes(fp, row["page_num"] or 1, bbox=bbox)
    llm_base_txt = get_setting("llm_base_url", "").strip()
    llm_key_txt = get_setting("llm_api_key", "").strip()
    llm_model_txt = get_setting("llm_model", "").strip()

    try:
        if llm_model.lower() in ("local-rapidocr", "rapidocr"):
            ocr_text = await local_ocr_with_vietnamese_restore(png_bytes, llm_base_txt, llm_key_txt, llm_model_txt)
        else:
            try:
                ocr_text = await llm_ocr_image(llm_base, llm_key, llm_model, png_bytes)
            except LLMError:
                ocr_text = await local_ocr_with_vietnamese_restore(png_bytes, llm_base_txt, llm_key_txt, llm_model_txt)
    except LLMError as e:
        raise HTTPException(status_code=400, detail=f"Lỗi Vision/OCR: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Không chạy được Vision/OCR: {e}")

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


async def run_batch_llm_judge_parsing(
    run_id: int,
    only_unrated: bool = True,
    overwrite_manual: bool = False,
    update_sync_status: bool = False,
) -> dict:
    """
    Runs LLM-as-a-Judge across parsing units in `run_id` (concurrently with Semaphore(6)),
    comparing original ground-truth text/table against the best-aligned multi-chunk window,
    while protecting MANUAL verdicts unless `overwrite_manual=True`.
    """
    llm_base = get_setting("llm_base_url", "").strip()
    llm_key = get_setting("llm_api_key", "").strip()
    llm_model = get_setting("llm_model", "").strip()
    if not llm_base or not llm_model or (not llm_key and "localhost" not in llm_base and "127.0.0.1" not in llm_base):
        return {"ok": False, "judged": 0, "pass_count": 0, "fail_count": 0, "failed": 0, "skipped_reason": "no_llm_config"}

    with get_db() as conn:
        q = """
            SELECT pu.*, d.filename, d.format_group
            FROM parsing_units pu
            JOIN documents d ON d.id = pu.document_id
            WHERE pu.run_id = ?
        """
        if only_unrated:
            q += " AND pu.verdict = 'UNRATED'"
        elif not overwrite_manual:
            q += " AND COALESCE(pu.judge_source, '') != 'MANUAL'"
        q += " ORDER BY pu.id"
        units = [dict(r) for r in conn.execute(q, (run_id,)).fetchall()]
        chunk_rows = conn.execute(
            "SELECT ragflow_chunk_id, document_id, chunk_index, content FROM chunks WHERE run_id = ? ORDER BY document_id, chunk_index",
            (run_id,),
        ).fetchall()
        chunk_map = {r["ragflow_chunk_id"]: dict(r) for r in chunk_rows}
        chunks_by_doc_pos = {(r["document_id"], r["chunk_index"]): r["content"] or "" for r in chunk_rows}

    targets = [
        u for u in units
        if (u.get("source_text") or "").strip()
        and not (u.get("source_text") or "").strip().startswith(("[Trang scan", "[Hình ảnh"))
    ]
    if not targets:
        return {"ok": True, "judged": 0, "pass_count": 0, "fail_count": 0, "failed": 0, "model": llm_model}

    if update_sync_status:
        st = UNIT_SYNC_STATUS.get(run_id)
        if st:
            st["total"] = int(st.get("total", 0)) + len(targets)

    sem = asyncio.Semaphore(6)
    updates = []
    pass_cnt = 0
    fail_cnt = 0
    err_cnt = 0

    async def _judge_one(u: dict):
        nonlocal pass_cnt, fail_cnt, err_cnt
        src_txt = u.get("source_text") or ""
        utype = u.get("unit_type") or "text"
        fmt_grp = u.get("format_group") or ""
        try:
            mids = json.loads(u.get("matched_chunk_ids") or "[]")
        except Exception:
            mids = []

        # Guaranteed multi-chunk stitching: if top chunk alone covers < 85% of source_text length
        # (e.g. a section split across Chunk k and Chunk k+1), align over the full stitched window.
        parsed_txt = ""
        top_chunk = next((chunk_map[cid] for cid in mids if cid in chunk_map), None)
        if top_chunk:
            doc_id = top_chunk["document_id"]
            c_idx = top_chunk["chunk_index"]
            prev_c = chunks_by_doc_pos.get((doc_id, c_idx - 1), "")
            next_parts = [
                chunks_by_doc_pos.get((doc_id, c_idx + offset), "")
                for offset in (1, 2, 3, 4, 5)
                if chunks_by_doc_pos.get((doc_id, c_idx + offset))
            ]
            next_c = "\n".join(next_parts)
            aln = _cached_alignment(
                src_txt,
                top_chunk["content"] or "",
                prev_c,
                c_idx - 1 if prev_c else None,
                next_c,
                c_idx + 1 if next_c else None,
                utype,
                fmt_grp,
            )
            parsed_txt = (aln.get("matched_excerpt") or top_chunk["content"] or "").strip()
            if prev_c or next_c:
                stitched_window = "\n".join(p for p in (prev_c, top_chunk["content"] or "", next_c) if p)
                aln_full = _cached_single_alignment(src_txt, stitched_window[:10000], utype, fmt_grp)
                s_idx = int(aln_full.get("start") or 0)
                e_idx = int(aln_full.get("end") or 0)
                if e_idx > s_idx:
                    pad_start = max(0, s_idx - 250)
                    pad_end = min(len(stitched_window), e_idx + 250)
                    cand_full = stitched_window[pad_start:pad_end].strip()
                    if len(cand_full) >= len(parsed_txt):
                        parsed_txt = cand_full
        if not parsed_txt and mids:
            parsed_txt = "\n---\n".join(chunk_map[cid]["content"] for cid in mids if cid in chunk_map)

        # VLM support for image/diagram units: always include chunks on the same page_num
        # so VLM natural-language descriptions (which may paraphrase OCR labels) are always visible to LLM Judge.
        if utype in ("image", "diagram") and u.get("page_num"):
            doc_id_u = u["document_id"]
            pnum_u = u["page_num"]
            same_page_chunks = [
                ch["content"]
                for ch in chunk_map.values()
                if ch["document_id"] == doc_id_u and ch.get("page_num") == pnum_u and ch.get("content")
            ]
            if same_page_chunks:
                page_blob = "\n---\n".join(same_page_chunks[:4])
                if page_blob and page_blob not in parsed_txt:
                    parsed_txt = f"{parsed_txt}\n---\n{page_blob}".strip() if parsed_txt else page_blob

        async with sem:
            try:
                res = await llm_judge_parsing_unit(
                    llm_base,
                    llm_key,
                    llm_model,
                    src_txt,
                    parsed_txt,
                    utype,
                    u.get("filename") or "",
                )
                if res["verdict"] == "PASS":
                    pass_cnt += 1
                else:
                    fail_cnt += 1
                updates.append((
                    res["verdict"],
                    json.dumps(res["error_codes"]),
                    res["char_error"],
                    res["fidelity_error"],
                    res["severity"],
                    res["notes"],
                    utc_now(),
                    u["id"],
                ))
            except Exception:
                err_cnt += 1
            finally:
                if update_sync_status:
                    st = UNIT_SYNC_STATUS.get(run_id)
                    if st:
                        st["done"] = int(st.get("done", 0)) + 1

    await asyncio.gather(*(_judge_one(u) for u in targets))

    with get_db() as conn:
        for row_vals in updates:
            conn.execute(
                """
                UPDATE parsing_units
                SET verdict=?, error_codes=?, char_error=?, fidelity_error=?, severity=?, notes=?, judge_source='LLM', updated_at=?
                WHERE id=?
                """,
                row_vals,
            )

    return {
        "ok": True,
        "judged": len(updates),
        "pass_count": pass_cnt,
        "fail_count": fail_cnt,
        "failed": err_cnt,
        "model": llm_model,
    }


@router.post("/runs/{run_id}/llm-judge")
async def llm_judge_parsing_endpoint(run_id: int, only_unrated: bool = True, overwrite_manual: bool = False):
    # Ensure any pending scanned/image units are OCR'd first so LLM judges them too
    await run_batch_vision_ocr_for_run(run_id, update_sync_status=False)
    res = await run_batch_llm_judge_parsing(
        run_id,
        only_unrated=only_unrated,
        overwrite_manual=overwrite_manual,
        update_sync_status=False,
    )
    if res.get("skipped_reason") == "no_llm_config":
        raise HTTPException(
            status_code=400,
            detail="Bắt buộc phải cấu hình LLM (Base URL, Model, API Key) trong Cài đặt trước khi chấm Parsing bằng LLM.",
        )
    return res


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
        chunk_flags_rows = conn.execute(
            "SELECT rule_flags FROM chunks WHERE run_id = ?",
            (run_id,),
        ).fetchall()

    rated = [r for r in rows if r["verdict"] != "UNRATED"]
    summary = compute_parsing_metrics(rows)

    # Parser-side precision / noise indicator (junk chunks generated by parser)
    total_chunks = len(chunk_flags_rows)
    junk_chunks = 0
    for cf in chunk_flags_rows:
        try:
            fl = set(json.loads(cf["rule_flags"] or "[]"))
        except Exception:
            fl = set()
        if fl & {"EMPTY", "NUMERIC_ONLY_NOISE", "CHAR_CORRUPTION"}:
            junk_chunks += 1
    summary["total_chunks"] = total_chunks
    summary["parser_junk_chunks"] = junk_chunks
    summary["parser_junk_rate"] = round(junk_chunks / total_chunks, 4) if total_chunks else 0.0

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
    summary["unit_sync_status"] = get_unit_sync_status(run_id)
    return summary
