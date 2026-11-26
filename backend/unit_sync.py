"""Keeps parsing_units aligned with the chunk snapshot of a run.

The parsing screen shows the RAGFlow chunk(s) that best match each ground-truth unit.
Historically those links were computed once (at extraction time) and then frozen, so a later
sync that added/fixed chunks left every unit with `matched_chunk_ids = []` forever.
These helpers re-run the alignment cheaply and never touch manual verdicts.
"""
import asyncio
import json
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from database import UPLOAD_DIR, get_db, utc_now
from extractor import extract_document_units
from metrics import align_unit_to_chunks

logger = logging.getLogger(__name__)

# In-memory tracker for background unit extraction per run_id so Step 2 can display
# live loading/progress animations and auto-poll until extraction finishes.
UNIT_SYNC_STATUS: Dict[int, Dict[str, Any]] = {}


def get_unit_sync_status(run_id: int) -> Dict[str, Any]:
    st = UNIT_SYNC_STATUS.get(run_id)
    if not st:
        return {"running": False, "done": 0, "total": 0}
    return dict(st)


def _load_chunks(conn, run_id: int, document_id: int) -> list:
    rows = conn.execute(
        "SELECT ragflow_chunk_id, content, page_num FROM chunks WHERE run_id = ? AND document_id = ? ORDER BY chunk_index",
        (run_id, document_id),
    ).fetchall()
    return [dict(r) for r in rows]


def realign_units(conn, run_id: int, document_id: Optional[int] = None) -> int:
    """Recompute matched_chunk_ids/match_score for existing units. Returns updated count."""
    where = "run_id = ?" + (" AND document_id = ?" if document_id else "")
    params = (run_id, document_id) if document_id else (run_id,)
    units = conn.execute(
        f"SELECT id, document_id, page_num, source_text, matched_chunk_ids, match_score FROM parsing_units WHERE {where}",
        params,
    ).fetchall()
    if not units:
        return 0

    chunk_cache: Dict[int, list] = {}
    updated = 0
    now = utc_now()
    for u in units:
        doc_id = u["document_id"]
        if doc_id not in chunk_cache:
            chunk_cache[doc_id] = _load_chunks(conn, run_id, doc_id)
        chunks = chunk_cache[doc_id]
        if not chunks:
            continue
        ids, score = align_unit_to_chunks(u["source_text"], chunks, page_num=u["page_num"])
        current = json.loads(u["matched_chunk_ids"] or "[]")
        if ids == current and abs(float(u["match_score"] or 0) - score) < 0.001:
            continue
        conn.execute(
            "UPDATE parsing_units SET matched_chunk_ids = ?, match_score = ?, updated_at = ? WHERE id = ?",
            (json.dumps(ids), score, now, u["id"]),
        )
        updated += 1
    return updated


def units_need_realign(conn, run_id: int) -> bool:
    """True when at least one unit has no chunk link but its document already has chunks."""
    row = conn.execute(
        """
        SELECT 1
          FROM parsing_units pu
         WHERE pu.run_id = ?
           AND (pu.matched_chunk_ids IS NULL OR pu.matched_chunk_ids IN ('', '[]'))
           AND EXISTS (
               SELECT 1 FROM chunks c
                WHERE c.run_id = pu.run_id AND c.document_id = pu.document_id
           )
         LIMIT 1
        """,
        (run_id,),
    ).fetchone()
    return row is not None


async def ensure_units_for_document_async(
    run_id: int,
    document_id: int,
    ragflow_doc_id: str,
    doc_code: str,
    filename: str,
    file_path: str,
    client: Any = None,
    dataset_id: str = "",
    max_units: int = 25,
) -> Dict[str, int]:
    """
    - Units exist -> re-align them against the current chunks (keeps verdicts/notes).
    - No units yet -> download the original file if needed, extract ground-truth units, align.
    """
    result = {"realigned": 0, "extracted": 0, "downloaded": 0}
    with get_db() as conn:
        unit_count = conn.execute(
            "SELECT COUNT(*) FROM parsing_units WHERE run_id = ? AND document_id = ?",
            (run_id, document_id),
        ).fetchone()[0]
        chunk_count = conn.execute(
            "SELECT COUNT(*) FROM chunks WHERE run_id = ? AND document_id = ?",
            (run_id, document_id),
        ).fetchone()[0]

    if unit_count > 0:
        if chunk_count == 0:
            return result

        def _realign_sync() -> int:
            with get_db() as conn:
                return realign_units(conn, run_id, document_id)

        result["realigned"] = await asyncio.to_thread(_realign_sync)
        return result

    if chunk_count == 0:
        return result

    fp = file_path or ""
    if not fp or not os.path.exists(fp):
        if not (client and dataset_id and ragflow_doc_id):
            return result
        try:
            file_bytes = await client.download_document(dataset_id, ragflow_doc_id)
        except Exception as e:
            logger.warning("download_document failed for %s (%s): %s", doc_code, filename, e)
            return result
        safe_name = os.path.basename(filename or f"{doc_code}.bin")
        fp = os.path.join(UPLOAD_DIR, f"{doc_code}_{safe_name}")
        with open(fp, "wb") as f:
            f.write(file_bytes)
        page_count = 0
        if fp.lower().endswith(".pdf"):
            try:
                import fitz
                with fitz.open(fp) as pdf_tmp:
                    page_count = len(pdf_tmp)
            except Exception:
                pass
        with get_db() as conn:
            conn.execute(
                "UPDATE documents SET file_path = ?, page_count = ? WHERE id = ?",
                (fp, page_count, document_id),
            )
        result["downloaded"] = 1

    with get_db() as conn:
        chunks_list = _load_chunks(conn, run_id, document_id)
    if not chunks_list:
        return result

    def _extract_and_align() -> List[Tuple[Any, ...]]:
        extracted = extract_document_units(fp, max_units=max_units)
        if not extracted:
            return []
        now = utc_now()
        rows: List[Tuple[Any, ...]] = []
        for idx, (utype, pnum, title, stxt) in enumerate(extracted, start=1):
            matched_ids, score = align_unit_to_chunks(stxt, chunks_list, page_num=pnum)
            rows.append(
                (
                    run_id,
                    document_id,
                    idx,
                    utype,
                    pnum,
                    title,
                    stxt,
                    json.dumps(matched_ids),
                    score,
                    now,
                )
            )
        return rows

    try:
        rows_to_insert = await asyncio.to_thread(_extract_and_align)
    except Exception as e:
        logger.warning("extract_document_units failed for %s (%s): %s", doc_code, filename, e)
        return result

    if not rows_to_insert:
        return result

    with get_db() as conn:
        conn.executemany(
            """
            INSERT INTO parsing_units
                (run_id, document_id, unit_index, unit_type, page_num, title, source_text,
                 matched_chunk_ids, match_score, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows_to_insert,
        )
        result["extracted"] = len(rows_to_insert)
    return result
