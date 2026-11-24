import json
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_bool_setting, get_db, get_float_setting, get_int_setting, get_setting, utc_now
from metrics import analyze_chunk_rules, compute_answer_containment, detect_duplicates_classified, nfc

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
def auto_sample_chunks(run_id: int, per_doc: Optional[int] = None):
    """
    Deterministic stratified sampling: picks `per_doc` chunks per document covering
    start -> middle -> end, then runs the 0-LLM Chunking QC rule engine (C1..C8).
    """
    if per_doc is None:
        per_doc = get_int_setting("chunk_sample_per_doc", 5)
    min_chars = get_int_setting("min_chunk_chars", 50)
    max_chars = get_int_setting("max_chunk_chars", 2600)
    exempt_intact_table = get_bool_setting("exempt_intact_table_from_max_chars", True)
    dup_threshold = get_float_setting("chunk_dup_threshold", 0.85)
    adj_overlap_threshold = get_float_setting("chunk_adj_overlap_threshold", 88.0)
    repeated_line_min = max(2, get_int_setting("chunk_repeated_line_min", 3))

    with get_db() as conn:
        all_chunks = [
            dict(c)
            for c in conn.execute(
                "SELECT * FROM chunks WHERE run_id = ? ORDER BY document_id, chunk_index",
                (run_id,),
            ).fetchall()
        ]
        if not all_chunks:
            raise HTTPException(status_code=400, detail="Run chưa có chunk nào. Hãy Đồng bộ từ RAGFlow trước.")

        conn.execute("UPDATE chunk_evaluations SET is_sampled = 0 WHERE run_id = ?", (run_id,))

        adj_dups, far_dups = detect_duplicates_classified(
            all_chunks,
            threshold=dup_threshold,
            adj_overlap_threshold=adj_overlap_threshold,
        )

        by_doc: dict = {}
        chunk_by_pos: dict = {}
        for c in all_chunks:
            by_doc.setdefault(c["document_id"], []).append(c)
            chunk_by_pos[(c["document_id"], c["chunk_index"])] = c

        repeated_by_doc: dict = {}
        for doc_id, clist in by_doc.items():
            line_counts: dict = {}
            for ch in clist:
                seen_in_chunk = set()
                for ln in nfc(ch["content"]).splitlines():
                    s = ln.strip()
                    if 6 <= len(s) <= 100 and s not in seen_in_chunk:
                        seen_in_chunk.add(s)
                        line_counts[s] = line_counts.get(s, 0) + 1
            repeated_by_doc[doc_id] = {ln for ln, cnt in line_counts.items() if cnt >= repeated_line_min}

        sampled_count = 0
        now = utc_now()
        for doc_id, clist in by_doc.items():
            n = len(clist)
            if per_doc <= 0 or n <= per_doc:
                chosen = clist
            elif per_doc == 1:
                chosen = [clist[0]]
            else:
                idxs = sorted(set(round(i * (n - 1) / (per_doc - 1)) for i in range(per_doc)))
                chosen = [clist[i] for i in idxs]

            rep_lines = repeated_by_doc.get(doc_id, set())
            for ch in chosen:
                prev_ch = chunk_by_pos.get((doc_id, ch["chunk_index"] - 1))
                next_ch = chunk_by_pos.get((doc_id, ch["chunk_index"] + 1))
                res = analyze_chunk_rules(
                    ch,
                    prev_content=prev_ch["content"] if prev_ch else "",
                    next_content=next_ch["content"] if next_ch else "",
                    repeated_lines=rep_lines,
                    is_adj_dup=ch["id"] in adj_dups,
                    is_far_dup=ch["id"] in far_dups,
                    min_chars=min_chars,
                    max_chars=max_chars,
                    exempt_intact_table=exempt_intact_table,
                )

                conn.execute(
                    "UPDATE chunks SET rule_flags = ? WHERE id = ?",
                    (json.dumps(res["rule_flags"]), ch["id"]),
                )

                existing = conn.execute(
                    "SELECT judge_source FROM chunk_evaluations WHERE run_id = ? AND chunk_id = ?",
                    (run_id, ch["id"]),
                ).fetchone()

                if existing and existing["judge_source"] == "MANUAL":
                    conn.execute(
                        "UPDATE chunk_evaluations SET is_sampled = 1 WHERE run_id = ? AND chunk_id = ?",
                        (run_id, ch["id"]),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO chunk_evaluations (run_id, chunk_id, is_sampled, integrity, context_sufficiency, no_noise, no_duplicate, valid_size, error_codes, judge_source, updated_at)
                        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'RULE', ?)
                        ON CONFLICT(run_id, chunk_id) DO UPDATE SET
                            is_sampled=1,
                            integrity=excluded.integrity,
                            context_sufficiency=excluded.context_sufficiency,
                            no_noise=excluded.no_noise,
                            no_duplicate=excluded.no_duplicate,
                            valid_size=excluded.valid_size,
                            error_codes=excluded.error_codes,
                            judge_source='RULE',
                            updated_at=excluded.updated_at
                        """,
                        (
                            run_id,
                            ch["id"],
                            res["integrity"],
                            res["context_sufficiency"],
                            res["no_noise"],
                            res["no_duplicate"],
                            res["valid_size"],
                            json.dumps(res["error_codes"]),
                            now,
                        ),
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

        all_pos = conn.execute(
            "SELECT document_id, chunk_index, content FROM chunks WHERE run_id = ?",
            (run_id,),
        ).fetchall()
        pos_map = {(r["document_id"], r["chunk_index"]): nfc(r["content"]).strip() for r in all_pos}

        out = []
        for r in rows:
            item = dict(r)
            item["content"] = nfc(item["content"])
            item["rule_flags"] = json.loads(item["rule_flags"] or "[]")
            item["error_codes"] = json.loads(item["error_codes"] or "[]")
            prev_txt = pos_map.get((item["document_id"], item["chunk_index"] - 1), "")
            next_txt = pos_map.get((item["document_id"], item["chunk_index"] + 1), "")
            item["prev_tail"] = prev_txt[-180:].strip() if prev_txt else ""
            item["next_head"] = next_txt[:180].strip() if next_txt else ""
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
        testcases = conn.execute("SELECT reference_context FROM golden_testcases").fetchall()
        snap_chunks = (
            [dict(c) for c in conn.execute("SELECT ragflow_chunk_id, content FROM chunks WHERE run_id = ?", (run_id,)).fetchall()]
            if testcases
            else []
        )

    def rate(field: str, invert: bool = False):
        vals = [r[field] for r in rows if r[field] is not None]
        if not vals:
            return 0.0
        ok = sum(1 for v in vals if (v == 0 if invert else v == 1))
        return round(ok / len(vals), 4)

    ac_full = 0
    if testcases and snap_chunks:
        for tc in testcases:
            if compute_answer_containment(tc["reference_context"], snap_chunks) == "FULL":
                ac_full += 1

    size_comp = rate("valid_size")
    return {
        "sampled_total": len(rows),
        "rated_manual": sum(1 for r in rows if r["judge_source"] == "MANUAL"),
        "rated_integrity": sum(1 for r in rows if r["integrity"] is not None),
        "chunk_integrity": rate("integrity"),
        "context_sufficiency": rate("context_sufficiency"),
        "noise_rate": rate("no_noise", invert=True),
        "duplicate_rate": rate("no_duplicate", invert=True),
        "valid_size_rate": size_comp,
        "size_compliance": size_comp,
        "answer_containment": round(ac_full / len(testcases), 4) if testcases else 0.0,
        "testcase_count": len(testcases),
    }
