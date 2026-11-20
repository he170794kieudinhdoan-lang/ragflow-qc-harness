"""Keeps parsing_units aligned with the chunk snapshot of a run.

The parsing screen shows the RAGFlow chunk(s) that best match each ground-truth unit.
Historically those links were computed once (at extraction time) and then frozen, so a later
sync that added/fixed chunks left every unit with `matched_chunk_ids = []` forever.
These helpers re-run the alignment cheaply and never touch manual verdicts.
"""
import json
import os
from typing import Any, Dict, Optional

from database import UPLOAD_DIR, get_db, utc_now
from extractor import extract_document_units
from metrics import align_unit_to_chunks


def _load_chunks(conn, run_id: int, document_id: int) -> list:
    rows = conn.execute(
        "SELECT ragflow_chunk_id, content FROM chunks WHERE run_id = ? AND document_id = ?",
        (run_id, document_id),
    ).fetchall()
    return [dict(r) for r in rows]


def realign_units(conn, run_id: int, document_id: Optional[int] = None) -> int:
    """Recompute matched_chunk_ids/match_score for existing units. Returns updated count."""
    where = "run_id = ?" + (" AND document_id = ?" if document_id else "")
    params = (run_id, document_id) if document_id else (run_id,)
    units = conn.execute(
        f"SELECT id, document_id, source_text, matched_chunk_ids, match_score FROM parsing_units WHERE {where}",
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
        ids, score = align_unit_to_chunks(u["source_text"], chunks)
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
        with get_db() as conn:
            result["realigned"] = realign_units(conn, run_id, document_id)
        return result

    if chunk_count == 0:
        return result

    fp = file_path or ""
    if not fp or not os.path.exists(fp):
        if not (client and dataset_id and ragflow_doc_id):
            return result
        try:
            file_bytes = await client.download_document(dataset_id, ragflow_doc_id)
        except Exception:
            return result
        safe_name = os.path.basename(filename or f"{doc_code}.bin")
        fp = os.path.join(UPLOAD_DIR, f"{doc_code}_{safe_name}")
        with open(fp, "wb") as f:
            f.write(file_bytes)
        page_count = 0
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
        result["downloaded"] = 1

    try:
        extracted = extract_document_units(fp, max_units=max_units)
    except Exception:
        return result

    if not extracted:
        return result

    with get_db() as conn:
        chunks_list = _load_chunks(conn, run_id, document_id)
        if not chunks_list:
            return result
        now = utc_now()
        for idx, (utype, pnum, title, stxt) in enumerate(extracted, start=1):
            matched_ids, score = align_unit_to_chunks(stxt, chunks_list)
            conn.execute(
                """
                INSERT INTO parsing_units
                    (run_id, document_id, unit_index, unit_type, page_num, title, source_text,
                     matched_chunk_ids, match_score, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (run_id, document_id, idx, utype, pnum, title, stxt, json.dumps(matched_ids), score, now),
            )
            result["extracted"] += 1
    return result
