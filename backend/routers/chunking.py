import json
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_db, get_setting, utc_now
from metrics import detect_duplicates

router = APIRouter(prefix="/api/chunking", tags=["chunking"])


class ChunkScoreUpdate(BaseModel):
    integrity: Optional[int] = None
    context_sufficiency: Optional[int] = None
    no_noise: Optional[int] = None
    no_duplicate: Optional[int] = None
    valid_size: Optional[int] = None
    error_codes: List[str] = []
    notes: str = ""
    judge_source: str = "MANUAL"


@router.post("/runs/{run_id}/sample")
def auto_sample_chunks(run_id: int, per_doc: int = 5):
    """
    Deterministic stratified sampling: picks `per_doc` chunks per document covering
    start, middle, end, and table-containing chunks, then applies rule-based pre-checks.
    """
    with get_db() as conn:
        all_chunks = conn.execute(
            "SELECT * FROM chunks WHERE run_id = ? ORDER BY document_id, chunk_index",
            (run_id,),
        ).fetchall()
        if not all_chunks:
            raise HTTPException(status_code=400, detail="Run chưa có chunk nào. Hãy Sync từ RAGFlow trước.")

        # Duplicate detection across the run
        dup_map = detect_duplicates([dict(c) for c in all_chunks])

        by_doc = {}
        for c in all_chunks:
            by_doc.setdefault(c["document_id"], []).append(c)

        sampled_count = 0
        now = utc_now()
        for doc_id, clist in by_doc.items():
            n = len(clist)
            if n <= per_doc:
                chosen = clist
            else:
                # Deterministic indices spread across start -> middle -> end
                idxs = sorted(set(round(i * (n - 1) / (per_doc - 1)) for i in range(per_doc)))
                chosen = [clist[i] for i in idxs]

            for ch in chosen:
                flags = json.loads(ch["rule_flags"] or "[]")
                is_dup = ch["id"] in dup_map
                if is_dup and "DUPLICATE" not in flags:
                    flags.append("DUPLICATE")

                valid_size = 0 if ("TOO_SHORT" in flags or "TOO_LONG" in flags or "EMPTY" in flags) else 1
                no_noise = 0 if ("NUMERIC_ONLY_NOISE" in flags or "SUSPECTED_NOISE" in flags) else 1
                no_dup = 0 if is_dup else 1

                err_codes = []
                if "TOO_SHORT" in flags or "NUMERIC_ONLY_NOISE" in flags:
                    err_codes.append("C8")
                if "TOO_LONG" in flags:
                    err_codes.append("C6")
                if no_noise == 0:
                    err_codes.append("C4")
                if no_dup == 0:
                    err_codes.append("C5")

                conn.execute(
                    """
                    INSERT INTO chunk_evaluations (run_id, chunk_id, is_sampled, no_noise, no_duplicate, valid_size, error_codes, judge_source, updated_at)
                    VALUES (?, ?, 1, ?, ?, ?, ?, 'RULE', ?)
                    ON CONFLICT(run_id, chunk_id) DO UPDATE SET is_sampled = 1
                    """,
                    (run_id, ch["id"], no_noise, no_dup, valid_size, json.dumps(err_codes), now),
                )
                sampled_count += 1

    return {"ok": True, "sampled_chunks": sampled_count}


@router.get("/runs/{run_id}/evaluations")
def list_chunk_evaluations(run_id: int, sampled_only: bool = True, document_id: Optional[int] = None):
    with get_db() as conn:
        q = """
            SELECT c.id as chunk_pk, c.ragflow_chunk_id, c.chunk_index, c.content, c.char_count,
                   c.token_est, c.page_num, c.rule_flags, c.document_id,
                   d.doc_code, d.filename, d.format_group,
                   ce.id as eval_id, ce.is_sampled, ce.integrity, ce.context_sufficiency,
                   ce.no_noise, ce.no_duplicate, ce.valid_size, ce.error_codes, ce.judge_source, ce.notes
            FROM chunks c
            LEFT JOIN documents d ON d.id = c.document_id
            LEFT JOIN chunk_evaluations ce ON ce.chunk_id = c.id AND ce.run_id = c.run_id
            WHERE c.run_id = ?
        """
        params: list = [run_id]
        if sampled_only:
            q += " AND ce.is_sampled = 1"
        if document_id:
            q += " AND c.document_id = ?"
            params.append(document_id)
        q += " ORDER BY d.doc_code, c.chunk_index"
        rows = conn.execute(q, params).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["rule_flags"] = json.loads(item["rule_flags"] or "[]")
            item["error_codes"] = json.loads(item["error_codes"] or "[]")
            out.append(item)
        return out


@router.put("/runs/{run_id}/chunks/{chunk_pk}/score")
def score_chunk(run_id: int, chunk_pk: int, payload: ChunkScoreUpdate):
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO chunk_evaluations (run_id, chunk_id, is_sampled, integrity, context_sufficiency, no_noise, no_duplicate, valid_size, error_codes, judge_source, notes, updated_at)
            VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, chunk_id) DO UPDATE SET
                integrity=excluded.integrity,
                context_sufficiency=excluded.context_sufficiency,
                no_noise=excluded.no_noise,
                no_duplicate=excluded.no_duplicate,
                valid_size=excluded.valid_size,
                error_codes=excluded.error_codes,
                judge_source=excluded.judge_source,
                notes=excluded.notes,
                updated_at=excluded.updated_at
            """,
            (
                run_id, chunk_pk, payload.integrity, payload.context_sufficiency,
                payload.no_noise, payload.no_duplicate, payload.valid_size,
                json.dumps(payload.error_codes), payload.judge_source, payload.notes, utc_now(),
            ),
        )
    return {"ok": True}


@router.get("/runs/{run_id}/metrics")
def get_chunking_metrics(run_id: int):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT ce.*, d.format_group
            FROM chunk_evaluations ce
            JOIN chunks c ON c.id = ce.chunk_id
            LEFT JOIN documents d ON d.id = c.document_id
            WHERE ce.run_id = ? AND ce.is_sampled = 1
            """,
            (run_id,),
        ).fetchall()

    def rate(field: str, invert: bool = False):
        vals = [r[field] for r in rows if r[field] is not None]
        if not vals:
            return 0.0
        ok = sum(1 for v in vals if (v == 0 if invert else v == 1))
        return round(ok / len(vals), 4)

    return {
        "sampled_total": len(rows),
        "rated_integrity": sum(1 for r in rows if r["integrity"] is not None),
        "chunk_integrity": rate("integrity"),
        "context_sufficiency": rate("context_sufficiency"),
        "noise_rate": rate("no_noise", invert=True),
        "duplicate_rate": rate("no_duplicate", invert=True),
        "valid_size_rate": rate("valid_size"),
    }
