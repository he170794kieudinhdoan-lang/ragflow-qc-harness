import asyncio
import json
import math
import os
import re
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from database import get_bool_setting, get_db, get_float_setting, get_int_setting, get_setting, utc_now
from llm_client import llm_judge_chunk
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


def compute_doc_sample_size(
    n: int,
    mode: str = "adaptive",
    per_doc: int = 5,
    min_per_doc: int = 5,
    max_per_doc: int = 20,
    sqrt_k: float = 2.0,
) -> int:
    """
    Bankier (1988) Power Allocation (q = 0.5, Square-Root Allocation) by default:
        k = clamp(round(sqrt_k * sqrt(n)), min_per_doc, max_per_doc)
    Balances document-level reliability on short files with corpus-level coverage on long files.
    """
    if n <= 0:
        return 0
    m = (mode or "adaptive").strip().lower()
    if m == "full" or (m == "fixed" and per_doc <= 0):
        return n
    if m == "fixed":
        return min(n, max(1, per_doc))
    lo = max(1, min_per_doc)
    hi = max(lo, max_per_doc)
    k = int(round(max(0.5, sqrt_k) * math.sqrt(n)))
    return min(n, max(lo, min(hi, k)))


@router.post("/runs/{run_id}/sample")
async def auto_sample_chunks(
    run_id: int,
    per_doc: Optional[int] = None,
    mode: Optional[str] = None,
):
    """
    Deterministic stratified sampling with 3 modes:
      - adaptive (default): Bankier (1988) Square-Root Allocation k = clamp(round(c * sqrt(n)), min, max)
      - fixed: fixed `per_doc` chunks per document
      - full: 100% of chunks
    Runs mechanical rule engine across 100% of chunks so rule_flags have full corpus coverage,
    and chains LLM-as-a-Judge only on newly sampled (unjudged) chunks to preserve prior scores.
    """
    eff_mode = (mode or get_setting("chunk_sample_mode", "adaptive")).strip().lower()
    if eff_mode not in ("adaptive", "fixed", "full"):
        eff_mode = "adaptive"
    if per_doc is None:
        per_doc = get_int_setting("chunk_sample_per_doc", 5)
    min_per_doc = get_int_setting("chunk_sample_min", 5)
    max_per_doc = get_int_setting("chunk_sample_max", 20)
    sqrt_k = get_float_setting("chunk_sample_sqrt_k", 2.0)

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
            rep_lines = repeated_by_doc.get(doc_id, set())

            # 1) Run mechanical rule engine on 100% of chunks for full corpus rule_flags coverage
            rule_results: dict = {}
            for ch in clist:
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
                rule_results[ch["id"]] = res
                conn.execute(
                    "UPDATE chunks SET rule_flags = ? WHERE id = ?",
                    (json.dumps(res["rule_flags"]), ch["id"]),
                )

            # 2) Select stratified sample according to active allocation mode
            target_k = compute_doc_sample_size(
                n,
                mode=eff_mode,
                per_doc=per_doc,
                min_per_doc=min_per_doc,
                max_per_doc=max_per_doc,
                sqrt_k=sqrt_k,
            )
            if target_k >= n:
                chosen = clist
            elif target_k == 1:
                chosen = [clist[0]]
            else:
                # Stratified sampling: first + last + up to 2 table chunks + evenly spaced middle
                picked_idxs = {0, n - 1}
                table_idxs = [
                    i for i, ch in enumerate(clist)
                    if "<table" in (ch.get("content") or "").lower()
                    or "<td" in (ch.get("content") or "").lower()
                    or bool(re.search(r"(?m)^\s*\|.*\|\s*$", ch.get("content") or ""))
                ]
                if table_idxs and len(picked_idxs) < target_k:
                    cand_tables = [table_idxs[0]]
                    if len(table_idxs) > 1:
                        cand_tables.append(table_idxs[len(table_idxs) // 2])
                    for ti in cand_tables:
                        if len(picked_idxs) < target_k:
                            picked_idxs.add(ti)
                for i in range(target_k):
                    if len(picked_idxs) >= target_k:
                        break
                    pos = round(i * (n - 1) / max(target_k - 1, 1))
                    if pos not in picked_idxs:
                        picked_idxs.add(pos)
                for pos in range(n):
                    if len(picked_idxs) >= target_k:
                        break
                    picked_idxs.add(pos)
                chosen = [clist[i] for i in sorted(picked_idxs)]

            for ch in chosen:
                res = rule_results[ch["id"]]
                existing = conn.execute(
                    "SELECT judge_source, error_codes FROM chunk_evaluations WHERE run_id = ? AND chunk_id = ?",
                    (run_id, ch["id"]),
                ).fetchone()

                if existing and existing["judge_source"] == "MANUAL":
                    conn.execute(
                        "UPDATE chunk_evaluations SET is_sampled = 1 WHERE run_id = ? AND chunk_id = ?",
                        (run_id, ch["id"]),
                    )
                elif existing and existing["judge_source"] == "LLM":
                    try:
                        prev_codes = set(json.loads(existing["error_codes"] or "[]"))
                    except Exception:
                        prev_codes = set()
                    sem_codes = prev_codes - {"DUPLICATE", "SIZE"}
                    new_mech = set(res["error_codes"]) & {"DUPLICATE", "SIZE"}
                    merged_codes = sorted(sem_codes | new_mech)
                    conn.execute(
                        """
                        UPDATE chunk_evaluations
                        SET is_sampled = 1, no_duplicate = ?, valid_size = ?, error_codes = ?
                        WHERE run_id = ? AND chunk_id = ?
                        """,
                        (res["no_duplicate"], res["valid_size"], json.dumps(merged_codes), run_id, ch["id"]),
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

    llm_judged = 0
    try:
        llm_res = await llm_judge_sampled_chunks(run_id, overwrite_manual=False, only_unjudged=True)
        llm_judged = int(llm_res.get("judged_count", 0))
    except HTTPException:
        pass
    return {
        "ok": True,
        "mode": eff_mode,
        "total_chunks": len(all_chunks),
        "sampled_chunks": sampled_count,
        "llm_judged": llm_judged,
    }


@router.post("/runs/{run_id}/llm-judge")
async def llm_judge_sampled_chunks(run_id: int, overwrite_manual: bool = False, only_unjudged: bool = False):
    """
    Runs LLM-as-a-Judge across sampled chunks in `run_id` (concurrently with Semaphore(6)),
    merging semantic LLM verdicts with deterministic mechanical rules.
    When `only_unjudged=True`, skips chunks already judged by MANUAL or LLM.
    """
    llm_base = get_setting("llm_base_url", "").strip()
    llm_key = get_setting("llm_api_key", "").strip()
    llm_model = get_setting("llm_model", "").strip()
    if not llm_base or not llm_model or (not llm_key and "localhost" not in llm_base and "127.0.0.1" not in llm_base):
        raise HTTPException(
            status_code=400,
            detail="Chưa cấu hình LLM (Base URL, Model, API Key) trong Cài đặt để chấm Chunking bằng LLM.",
        )

    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT ce.*, c.id AS chunk_pk, c.document_id, c.chunk_index, c.content, d.filename
            FROM chunk_evaluations ce
            JOIN chunks c ON c.id = ce.chunk_id
            LEFT JOIN documents d ON d.id = c.document_id
            WHERE ce.run_id = ? AND ce.is_sampled = 1
            ORDER BY d.doc_code, c.chunk_index
            """,
            (run_id,),
        ).fetchall()
        if not rows:
            raise HTTPException(status_code=400, detail="Chưa có mẫu chunk nào. Hãy bấm 'Lấy mẫu & Quét' trước.")

        all_pos = conn.execute(
            "SELECT document_id, chunk_index, content FROM chunks WHERE run_id = ?", (run_id,)
        ).fetchall()
        pos_map = {(r["document_id"], r["chunk_index"]): r["content"] or "" for r in all_pos}

    if only_unjudged:
        targets = [dict(r) for r in rows if r["judge_source"] not in ("MANUAL", "LLM")]
    else:
        targets = [dict(r) for r in rows if overwrite_manual or r["judge_source"] != "MANUAL"]
    if not targets:
        return {"ok": True, "judged_count": 0, "skipped_manual": len(rows), "failed_count": 0}

    sem = asyncio.Semaphore(6)
    updates = []
    errors = []

    async def _judge_one(item: dict):
        prev_txt = pos_map.get((item["document_id"], item["chunk_index"] - 1), "")
        next_txt = pos_map.get((item["document_id"], item["chunk_index"] + 1), "")
        async with sem:
            try:
                res = await llm_judge_chunk(
                    llm_base,
                    llm_key,
                    llm_model,
                    item["content"] or "",
                    prev_txt,
                    next_txt,
                    item["filename"] or "",
                )
                try:
                    existing_codes = set(json.loads(item["error_codes"] or "[]"))
                except Exception:
                    existing_codes = set()
                mech_codes = existing_codes & {"DUPLICATE", "SIZE"}
                merged_codes = sorted(mech_codes | set(res["error_codes"]))

                integrity = 0 if "INTEGRITY" in merged_codes else res["integrity"]
                ctx_suff = 0 if "CONTEXT" in merged_codes else res["context_sufficiency"]
                no_noise = 0 if "NOISE" in merged_codes else res["no_noise"]
                no_dup = 0 if "DUPLICATE" in mech_codes else (item["no_duplicate"] if item["no_duplicate"] is not None else 1)
                valid_size = 0 if "SIZE" in mech_codes else (item["valid_size"] if item["valid_size"] is not None else 1)

                updates.append((
                    integrity,
                    ctx_suff,
                    no_noise,
                    no_dup,
                    valid_size,
                    json.dumps(merged_codes),
                    res["reason"],
                    utc_now(),
                    run_id,
                    item["chunk_pk"],
                ))
            except Exception as e:
                errors.append(str(e)[:160])

    await asyncio.gather(*(_judge_one(t) for t in targets))

    with get_db() as conn:
        for u in updates:
            conn.execute(
                """
                UPDATE chunk_evaluations
                SET integrity=?, context_sufficiency=?, no_noise=?, no_duplicate=?, valid_size=?,
                    error_codes=?, notes=?, judge_source='LLM', updated_at=?
                WHERE run_id=? AND chunk_id=?
                """,
                u,
            )

    return {
        "ok": True,
        "judged_count": len(updates),
        "skipped_manual": len(rows) - len(targets),
        "failed_count": len(errors),
        "model": llm_model,
    }


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
            SELECT ce.*, c.document_id, d.format_group
            FROM chunk_evaluations ce
            JOIN chunks c ON c.id = ce.chunk_id
            LEFT JOIN documents d ON d.id = c.document_id
            WHERE ce.run_id = ? AND ce.is_sampled = 1
            """,
            (run_id,),
        ).fetchall()
        doc_totals_rows = conn.execute(
            "SELECT document_id, COUNT(*) AS cnt FROM chunks WHERE run_id = ? GROUP BY document_id",
            (run_id,),
        ).fetchall()
        testcases = conn.execute("SELECT reference_context FROM golden_testcases").fetchall()
        snap_chunks = (
            [dict(c) for c in conn.execute("SELECT ragflow_chunk_id, content FROM chunks WHERE run_id = ?", (run_id,)).fetchall()]
            if testcases
            else []
        )

    doc_totals = {r["document_id"]: r["cnt"] for r in doc_totals_rows}
    total_corpus_chunks = sum(doc_totals.values())

    by_doc: dict = {}
    for r in rows:
        by_doc.setdefault(r["document_id"], []).append(r)

    def unweighted_rate(field: str, invert: bool = False) -> float:
        vals = [r[field] for r in rows if r[field] is not None]
        if not vals:
            return 0.0
        ok = sum(1 for v in vals if (v == 0 if invert else v == 1))
        return round(ok / len(vals), 4)

    def weighted_rate(field: str, invert: bool = False) -> float:
        """
        Cochran (1977) Stratified Weighted Estimator:
            P_hat = sum_h (N_h * p_h) / sum_h N_h
        Ensures long documents carry weight proportional to their true chunk count N_h.
        """
        num = 0.0
        den = 0.0
        for doc_id, doc_rows in by_doc.items():
            vals = [r[field] for r in doc_rows if r[field] is not None]
            if not vals:
                continue
            ok = sum(1 for v in vals if (v == 0 if invert else v == 1))
            p_h = ok / len(vals)
            w_h = float(doc_totals.get(doc_id, len(vals)))
            num += w_h * p_h
            den += w_h
        if den <= 0:
            return unweighted_rate(field, invert=invert)
        return round(num / den, 4)

    ac_full = 0
    if testcases and snap_chunks:
        for tc in testcases:
            if compute_answer_containment(tc["reference_context"], snap_chunks) == "FULL":
                ac_full += 1

    size_comp = weighted_rate("valid_size")
    sample_mode = get_setting("chunk_sample_mode", "adaptive")
    sqrt_k = get_float_setting("chunk_sample_sqrt_k", 2.0)
    min_s = get_int_setting("chunk_sample_min", 5)
    max_s = get_int_setting("chunk_sample_max", 20)
    per_doc_cfg = get_int_setting("chunk_sample_per_doc", 5)

    return {
        "sampled_total": len(rows),
        "total_chunks": total_corpus_chunks,
        "coverage_pct": round((len(rows) / total_corpus_chunks) * 100.0, 1) if total_corpus_chunks else 0.0,
        "rated_manual": sum(1 for r in rows if r["judge_source"] == "MANUAL"),
        "rated_integrity": sum(1 for r in rows if r["integrity"] is not None),
        "chunk_integrity": weighted_rate("integrity"),
        "context_sufficiency": weighted_rate("context_sufficiency"),
        "noise_rate": weighted_rate("no_noise", invert=True),
        "duplicate_rate": weighted_rate("no_duplicate", invert=True),
        "valid_size_rate": size_comp,
        "size_compliance": size_comp,
        "unweighted": {
            "chunk_integrity": unweighted_rate("integrity"),
            "context_sufficiency": unweighted_rate("context_sufficiency"),
            "noise_rate": unweighted_rate("no_noise", invert=True),
            "duplicate_rate": unweighted_rate("no_duplicate", invert=True),
            "valid_size_rate": unweighted_rate("valid_size"),
        },
        "sampling_meta": {
            "mode": sample_mode,
            "sqrt_k": sqrt_k,
            "min_per_doc": min_s,
            "max_per_doc": max_s,
            "per_doc": per_doc_cfg,
            "weighting": "cochran_1977",
        },
        "answer_containment": round(ac_full / len(testcases), 4) if testcases else 0.0,
        "testcase_count": len(testcases),
    }


@router.get("/runs/{run_id}/chunks")
def list_all_chunks(
    run_id: int,
    q: str = Query(default=""),
    document_id: Optional[int] = Query(default=None),
    format_group: Optional[str] = Query(default=None),
    flag: Optional[str] = Query(default=None),
    min_tokens: Optional[int] = Query(default=None),
    max_tokens: Optional[int] = Query(default=None),
    sort: str = Query(default="doc_chunk"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """Browse and research all chunks in a run with search, filters, stats, and prev/next context."""
    with get_db() as conn:
        all_rows = conn.execute(
            """
            SELECT c.id, c.document_id, c.ragflow_doc_id, c.ragflow_chunk_id, c.chunk_index,
                   c.content, c.char_count, c.token_est, c.page_num, c.important_keywords,
                   c.available, c.rule_flags,
                   d.doc_code, d.filename, d.format_group, d.file_path,
                   COALESCE(ce.is_sampled, 0) AS is_sampled
            FROM chunks c
            LEFT JOIN documents d ON d.id = c.document_id
            LEFT JOIN chunk_evaluations ce ON ce.run_id = c.run_id AND ce.chunk_id = c.id
            WHERE c.run_id = ?
            ORDER BY d.doc_code, c.chunk_index
            """,
            (run_id,),
        ).fetchall()

    pos_map = {}
    doc_map = {}
    flag_counts = {}
    for r in all_rows:
        txt = nfc(r["content"] or "")
        pos_map[(r["document_id"], r["chunk_index"])] = txt
        did = r["document_id"]
        if did is not None:
            if did not in doc_map:
                doc_map[did] = {
                    "id": did,
                    "doc_code": r["doc_code"] or f"DOC{did}",
                    "filename": r["filename"] or "",
                    "format_group": r["format_group"] or "",
                    "chunk_count": 0,
                }
            doc_map[did]["chunk_count"] += 1
        try:
            rflags = json.loads(r["rule_flags"] or "[]")
        except Exception:
            rflags = []
        for f in rflags:
            flag_counts[f] = flag_counts.get(f, 0) + 1

    q_norm = nfc(q).strip().lower()
    filtered = []
    for r in all_rows:
        if document_id is not None and r["document_id"] != document_id:
            continue
        if format_group and (r["format_group"] or "") != format_group:
            continue
        tok = r["token_est"] or 0
        if min_tokens is not None and tok < min_tokens:
            continue
        if max_tokens is not None and tok > max_tokens:
            continue
        try:
            rflags = json.loads(r["rule_flags"] or "[]")
        except Exception:
            rflags = []
        if flag == "ANY" and len(rflags) == 0:
            continue
        elif flag == "NONE" and len(rflags) > 0:
            continue
        elif flag and flag not in ("ANY", "NONE") and flag not in rflags:
            continue

        txt = pos_map[(r["document_id"], r["chunk_index"])]
        if q_norm:
            hay = f"{txt}\n{r['doc_code'] or ''}\n{r['filename'] or ''}\n{r['important_keywords'] or ''}".lower()
            if q_norm not in hay:
                continue

        filtered.append((r, txt, rflags))

    if sort == "tokens_desc":
        filtered.sort(key=lambda x: (-(x[0]["token_est"] or 0), x[0]["doc_code"] or "", x[0]["chunk_index"] or 0))
    elif sort == "tokens_asc":
        filtered.sort(key=lambda x: ((x[0]["token_est"] or 0), x[0]["doc_code"] or "", x[0]["chunk_index"] or 0))
    elif sort == "chars_desc":
        filtered.sort(key=lambda x: (-(x[0]["char_count"] or 0), x[0]["doc_code"] or "", x[0]["chunk_index"] or 0))
    elif sort == "flags_desc":
        filtered.sort(key=lambda x: (-len(x[2]), x[0]["doc_code"] or "", x[0]["chunk_index"] or 0))

    total_filtered = len(filtered)
    if total_filtered > 0:
        toks = [x[0]["token_est"] or 0 for x in filtered]
        stats = {
            "avg_tokens": round(sum(toks) / total_filtered, 1),
            "min_tokens": min(toks),
            "max_tokens": max(toks),
            "flagged_count": sum(1 for x in filtered if len(x[2]) > 0),
        }
    else:
        stats = {"avg_tokens": 0, "min_tokens": 0, "max_tokens": 0, "flagged_count": 0}

    page_slice = filtered[offset : offset + limit]
    items = []
    for r, txt, rflags in page_slice:
        prev_txt = pos_map.get((r["document_id"], (r["chunk_index"] or 0) - 1), "")
        next_txt = pos_map.get((r["document_id"], (r["chunk_index"] or 0) + 1), "")
        try:
            kws = json.loads(r["important_keywords"] or "[]")
            if not isinstance(kws, list):
                kws = []
        except Exception:
            kws = []
        items.append(
            {
                "id": r["id"],
                "document_id": r["document_id"],
                "doc_code": r["doc_code"] or "",
                "filename": r["filename"] or "",
                "format_group": r["format_group"] or "",
                "has_local_file": bool(r["file_path"] and os.path.exists(r["file_path"])),
                "ragflow_chunk_id": r["ragflow_chunk_id"] or "",
                "chunk_index": r["chunk_index"],
                "content": txt,
                "char_count": r["char_count"] or 0,
                "token_est": r["token_est"] or 0,
                "page_num": r["page_num"] or 1,
                "important_keywords": kws,
                "rule_flags": rflags,
                "is_sampled": bool(r["is_sampled"]),
                "prev_tail": prev_txt[-240:].strip() if prev_txt else "",
                "next_head": next_txt[:240].strip() if next_txt else "",
            }
        )

    docs_list = sorted(doc_map.values(), key=lambda d: d["doc_code"])
    return {
        "total": total_filtered,
        "total_all": len(all_rows),
        "limit": limit,
        "offset": offset,
        "stats": stats,
        "documents": docs_list,
        "flag_counts": flag_counts,
        "items": items,
    }
