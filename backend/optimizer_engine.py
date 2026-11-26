"""
Retrieval Combination Optimizer Engine (Multi-Fidelity Successive Halving + Pareto Analysis).

Executes empirical parameter sweeps over RAGFlow /api/v1/retrieval without re-indexing:
  - Stage 1 (Screening): evaluates all candidate combinations on a stratified subset (~35% of
    Golden Testcases, balanced across Local/Global/Multi-hop & prioritizing failing testcases).
  - Stage 2 (Full Validation): promotes top ~30% (min 3, max 6) combinations + baseline config
    to 100% of Golden Testcases, reusing Stage 1 hits/judgements with zero duplicate API calls.
  - Multi-Layer Cache: combines DB relevancy_cache, relevancy_content_cache, and an in-study
    memory cache so overlapping chunks across trials cost 0 extra LLM/Jev calls.
"""

import asyncio
import itertools
import json
import math
import time
from typing import Any, Dict, List, Optional, Tuple

from database import get_current_account_key, get_db, get_setting, utc_now
from llm_client import (
    jev_judge_relevance,
    llm_judge_relevance,
    llm_judge_relevance_batch,
    resolve_systemone_credentials,
    systemone_requires_key,
)
from metrics import (
    compute_content_hash,
    compute_context_coverage,
    compute_contextual_precision,
    compute_hit_at_k,
    compute_mrr,
    compute_multi_objective_score,
    compute_parameter_sensitivity,
    mark_pareto_frontier,
    score_chunk_relevance,
)
from ragflow_client import RAGFlowClient

CANCEL_STUDY_FLAGS: Dict[int, bool] = {}


def request_cancel_study(study_id: int) -> None:
    CANCEL_STUDY_FLAGS[study_id] = True


def _resolve_judge_cfg(judge_engine: str) -> Dict[str, Any]:
    eng = (judge_engine or "rule").strip().lower()
    if eng not in ("jev", "llm", "rule"):
        eng = "rule"
    if eng == "jev":
        base_url, api_key, model, threshold = resolve_systemone_credentials(get_setting)
        if not base_url or not model or (systemone_requires_key(base_url) and not api_key):
            raise ValueError("Chưa cấu hình Jev / Kev System One trong Cài đặt.")
        return {"engine": "jev", "base_url": base_url, "api_key": api_key, "model": model, "threshold": threshold}
    if eng == "llm":
        base_url = get_setting("llm_base_url", "").strip()
        api_key = get_setting("llm_api_key", "").strip()
        model = get_setting("llm_model", "").strip()
        if not base_url or not model or (not api_key and "localhost" not in base_url and "127.0.0.1" not in base_url):
            raise ValueError("Chưa cấu hình LLM API Key / Model trong Cài đặt.")
        return {"engine": "llm", "base_url": base_url, "api_key": api_key, "model": model}
    return {"engine": "rule"}


def build_candidate_configs(
    search_space: Dict[str, Any],
    baseline_cfg: Optional[Dict[str, Any]] = None,
    max_trials: int = 24,
) -> List[Dict[str, Any]]:
    """Generates unique valid Retrieval config combinations, always placing baseline_cfg first if given."""
    vec_weights = [round(float(x), 3) for x in (search_space.get("vector_similarity_weight") or [0.2, 0.3, 0.5])]
    thresholds = [round(float(x), 3) for x in (search_space.get("similarity_threshold") or [0.1, 0.2])]
    top_ks = [int(x) for x in (search_space.get("top_k") or [5, 10, 15])]
    kw_opts = [bool(x) for x in (search_space.get("keyword_enabled") if search_space.get("keyword_enabled") is not None else [True])]
    reranks = [str(x).strip() for x in (search_space.get("rerank_ids") if search_space.get("rerank_ids") is not None else [""])]
    if not reranks:
        reranks = [""]

    raw_combos: List[Dict[str, Any]] = []
    seen = set()

    def _add_cfg(c: Dict[str, Any]) -> None:
        sig = (
            round(float(c["vector_similarity_weight"]), 3),
            round(float(c["similarity_threshold"]), 3),
            int(c["top_k"]),
            bool(c["keyword_enabled"]),
            str(c["rerank_id"]).strip(),
        )
        if sig not in seen:
            seen.add(sig)
            raw_combos.append({
                "vector_similarity_weight": sig[0],
                "similarity_threshold": sig[1],
                "top_k": sig[2],
                "keyword_enabled": sig[3],
                "rerank_id": sig[4],
            })

    if baseline_cfg:
        _add_cfg({
            "vector_similarity_weight": baseline_cfg.get("vector_similarity_weight", 0.3),
            "similarity_threshold": baseline_cfg.get("similarity_threshold", 0.2),
            "top_k": baseline_cfg.get("top_k", 10),
            "keyword_enabled": baseline_cfg.get("keyword_enabled", True),
            "rerank_id": baseline_cfg.get("rerank_id", ""),
        })

    for vw, th, tk, kw, rr in itertools.product(vec_weights, thresholds, top_ks, kw_opts, reranks):
        _add_cfg({
            "vector_similarity_weight": vw,
            "similarity_threshold": th,
            "top_k": tk,
            "keyword_enabled": kw,
            "rerank_id": rr,
        })

    if len(raw_combos) <= max_trials:
        return raw_combos

    # Deterministic stratified down-sampling while keeping baseline at index 0
    head = raw_combos[:1] if baseline_cfg else []
    tail = raw_combos[1:] if baseline_cfg else raw_combos
    need = max_trials - len(head)
    step = len(tail) / max(need, 1)
    picked = [tail[min(len(tail) - 1, int(i * step))] for i in range(need)]
    return head + picked


def _select_stratified_subset(
    testcases: List[Dict[str, Any]],
    failing_tc_ids: set,
    ratio: float = 0.35,
    min_count: int = 12,
) -> List[Dict[str, Any]]:
    n = len(testcases)
    if n <= min_count:
        return list(testcases)
    target = min(n, max(min_count, int(round(n * ratio))))

    by_class: Dict[str, List[Dict[str, Any]]] = {"Local": [], "Global": [], "Multi-hop": []}
    for tc in testcases:
        cls = tc.get("question_class") or "Local"
        by_class.setdefault(cls, []).append(tc)

    # Sort each class so failing baseline testcases come first (more informative)
    for cls in by_class:
        by_class[cls].sort(key=lambda t: (0 if t["id"] in failing_tc_ids else 1, t.get("tc_code", "")))

    chosen: List[Dict[str, Any]] = []
    chosen_ids = set()
    for cls, items in by_class.items():
        if not items:
            continue
        k = max(1, int(round(target * len(items) / n)))
        for it in items[:k]:
            if len(chosen) < target and it["id"] not in chosen_ids:
                chosen.append(it)
                chosen_ids.add(it["id"])

    if len(chosen) < target:
        for tc in testcases:
            if len(chosen) >= target:
                break
            if tc["id"] not in chosen_ids:
                chosen.append(tc)
                chosen_ids.add(tc["id"])

    chosen.sort(key=lambda t: t.get("tc_code", ""))
    return chosen


async def _evaluate_trial_testcases(
    client: RAGFlowClient,
    dataset_id: str,
    cfg: Dict[str, Any],
    testcases: List[Dict[str, Any]],
    judge_cfg: Dict[str, Any],
    mem_id_cache: Dict[Tuple[int, str], Tuple[int, str]],
    mem_hash_cache: Dict[Tuple[int, str], Tuple[int, str]],
    rag_sem: asyncio.Semaphore,
    judge_sem: asyncio.Semaphore,
    prior_tc_outputs: Optional[Dict[int, Dict[str, Any]]] = None,
) -> Dict[int, Dict[str, Any]]:
    """
    Runs `/api/v1/retrieval` + Judge for `testcases` under `cfg`.
    Reuses `prior_tc_outputs[tc_id]` when already computed in Stage 1 of the same trial!
    """
    prior = prior_tc_outputs or {}
    to_run = [tc for tc in testcases if tc["id"] not in prior]
    outputs: Dict[int, Dict[str, Any]] = {tc["id"]: prior[tc["id"]] for tc in testcases if tc["id"] in prior}

    async def _run_one(tc: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        tc_id = tc["id"]
        chunks: List[Dict[str, Any]] = []
        latency_ms = 0.0

        async with rag_sem:
            for attempt in range(5):
                t0 = time.perf_counter()
                try:
                    resp = await client.retrieve(
                        question=tc["input_question"],
                        dataset_ids=[dataset_id],
                        top_k=int(cfg["top_k"]),
                        similarity_threshold=float(cfg["similarity_threshold"]),
                        vector_similarity_weight=float(cfg["vector_similarity_weight"]),
                        rerank_id=cfg["rerank_id"].strip() or None,
                        keyword=bool(cfg["keyword_enabled"]),
                        page=1,
                        page_size=int(cfg["top_k"]),
                    )
                    latency_ms = (time.perf_counter() - t0) * 1000.0
                    chunks = (resp.get("chunks") or [])[: int(cfg["top_k"])]
                    await asyncio.sleep(0.05)
                    break
                except Exception as e:
                    msg = str(e)
                    if ("429" in msg or "CONCURRENCY" in msg.upper() or "RATE" in msg.upper()) and attempt < 4:
                        await asyncio.sleep(1.2 * (attempt + 1))
                        continue
                    latency_ms = (time.perf_counter() - t0) * 1000.0
                    chunks = []
                    break

        cov = compute_context_coverage(tc["reference_context"], chunks)
        ctx_tokens = sum(max(1, len((ch.get("content") or ch.get("content_with_weight") or "")) // 4) for ch in chunks)

        engine = judge_cfg["engine"]
        cache_hits = 0
        judge_calls = 0
        scored_hits: List[Dict[str, Any]] = []

        if engine == "llm":
            uncached = []
            parsed = []
            for rank, ch in enumerate(chunks, start=1):
                cid = str(ch.get("id") or ch.get("chunk_id") or f"unk_{rank}")
                content = ch.get("content") or ch.get("content_with_weight") or ""
                ch_hash = compute_content_hash(content)
                cached = mem_id_cache.get((tc_id, cid)) or (mem_hash_cache.get((tc_id, ch_hash)) if ch_hash else None)
                parsed.append((rank, cid, ch, content, ch_hash, cached))
                if cached is None:
                    uncached.append({"rank": rank, "content": content})

            llm_verdicts: Dict[int, Tuple[int, str]] = {}
            if uncached:
                judge_calls = 1
                async with judge_sem:
                    try:
                        llm_verdicts = await llm_judge_relevance_batch(
                            judge_cfg["base_url"],
                            judge_cfg["api_key"],
                            judge_cfg["model"],
                            tc["input_question"],
                            tc["reference_context"],
                            uncached,
                        )
                    except Exception:
                        llm_verdicts = {}

            for rank, cid, ch, content, ch_hash, cached in parsed:
                if cached is not None:
                    rel_val, reason = cached
                    src = "CACHED"
                    cache_hits += 1
                elif rank in llm_verdicts:
                    rel_val, reason = llm_verdicts[rank]
                    src = "LLM_DRAFT"
                    mem_id_cache[(tc_id, cid)] = (rel_val, reason)
                    if ch_hash:
                        mem_hash_cache[(tc_id, ch_hash)] = (rel_val, reason)
                else:
                    rel_val, reason = score_chunk_relevance(tc["reference_context"], content)
                    src = "RULE"
                scored_hits.append({
                    "rank": rank,
                    "ragflow_chunk_id": cid,
                    "ragflow_doc_id": ch.get("document_id", "") or ch.get("doc_id", ""),
                    "doc_name": ch.get("document_keyword") or ch.get("document_name") or ch.get("docnm_kwd", ""),
                    "content": content,
                    "similarity": float(ch.get("similarity", 0) or 0),
                    "vector_similarity": float(ch.get("vector_similarity", 0) or 0),
                    "term_similarity": float(ch.get("term_similarity", 0) or 0),
                    "relevant": rel_val,
                    "relevancy_source": src,
                    "reason": reason,
                })
        else:
            async def _judge_hit(rank: int, ch: Dict[str, Any]):
                cid = str(ch.get("id") or ch.get("chunk_id") or f"unk_{rank}")
                content = ch.get("content") or ch.get("content_with_weight") or ""
                ch_hash = compute_content_hash(content)
                cached = mem_id_cache.get((tc_id, cid)) or (mem_hash_cache.get((tc_id, ch_hash)) if ch_hash else None)
                c_hit = 0
                j_call = 0
                if cached is not None:
                    rel_val, reason = cached
                    src = "CACHED"
                    c_hit = 1
                elif engine == "jev":
                    j_call = 1
                    async with judge_sem:
                        try:
                            rel_val, reason = await jev_judge_relevance(
                                judge_cfg["base_url"],
                                judge_cfg["api_key"],
                                judge_cfg["model"],
                                tc["input_question"],
                                tc["reference_context"],
                                content,
                                threshold=judge_cfg["threshold"],
                            )
                            src = "JEV_DRAFT"
                            mem_id_cache[(tc_id, cid)] = (rel_val, reason)
                            if ch_hash:
                                mem_hash_cache[(tc_id, ch_hash)] = (rel_val, reason)
                        except Exception:
                            rel_val, reason = score_chunk_relevance(tc["reference_context"], content)
                            src = "RULE"
                else:
                    rel_val, reason = score_chunk_relevance(tc["reference_context"], content)
                    src = "RULE"
                    mem_id_cache[(tc_id, cid)] = (rel_val, reason)
                    if ch_hash:
                        mem_hash_cache[(tc_id, ch_hash)] = (rel_val, reason)

                return c_hit, j_call, {
                    "rank": rank,
                    "ragflow_chunk_id": cid,
                    "ragflow_doc_id": ch.get("document_id", "") or ch.get("doc_id", ""),
                    "doc_name": ch.get("document_keyword") or ch.get("document_name") or ch.get("docnm_kwd", ""),
                    "content": content,
                    "similarity": float(ch.get("similarity", 0) or 0),
                    "vector_similarity": float(ch.get("vector_similarity", 0) or 0),
                    "term_similarity": float(ch.get("term_similarity", 0) or 0),
                    "relevant": rel_val,
                    "relevancy_source": src,
                    "reason": reason,
                }

            hit_res = await asyncio.gather(*(_judge_hit(r, ch) for r, ch in enumerate(chunks, start=1))) if chunks else []
            for c_h, j_c, hit_obj in hit_res:
                cache_hits += c_h
                judge_calls += j_c
                scored_hits.append(hit_obj)

        rels = [h["relevant"] for h in scored_hits]
        cp = compute_contextual_precision(rels)
        mrr = compute_mrr(rels)
        h1 = compute_hit_at_k(rels, 1)
        h3 = compute_hit_at_k(rels, 3)
        hk = compute_hit_at_k(rels, int(cfg["top_k"]))

        return tc_id, {
            "cp": cp,
            "cc": cov,
            "mrr": mrr,
            "hit_1": h1,
            "hit_3": h3,
            "hit_k": hk,
            "latency_ms": latency_ms,
            "context_tokens": ctx_tokens,
            "cache_hits": cache_hits,
            "judge_calls": judge_calls,
            "hits": scored_hits,
        }

    if to_run:
        res_pairs = await asyncio.gather(*(_run_one(tc) for tc in to_run))
        for tc_id, obj in res_pairs:
            outputs[tc_id] = obj
    return outputs


def _aggregate_trial_metrics(
    tc_outputs: Dict[int, Dict[str, Any]],
    profile: str,
) -> Dict[str, Any]:
    vals = list(tc_outputs.values())
    n = len(vals)
    if n == 0:
        return {
            "testcase_count": 0,
            "avg_cp": 0.0,
            "avg_cc": 0.0,
            "avg_mrr": 0.0,
            "hit_at_1": 0.0,
            "hit_at_3": 0.0,
            "hit_at_k": 0.0,
            "avg_latency_ms": 0.0,
            "avg_context_tokens": 0.0,
            "objective_score": 0.0,
            "cache_hits": 0,
            "judge_calls": 0,
        }
    avg_cp = round(sum(v["cp"] for v in vals) / n, 4)
    avg_cc = round(sum(v["cc"] for v in vals) / n, 4)
    avg_mrr = round(sum(v["mrr"] for v in vals) / n, 4)
    hit_1 = round(sum(v["hit_1"] for v in vals) / n, 4)
    hit_3 = round(sum(v["hit_3"] for v in vals) / n, 4)
    hit_k = round(sum(v["hit_k"] for v in vals) / n, 4)
    avg_lat = round(sum(v["latency_ms"] for v in vals) / n, 1)
    avg_tok = round(sum(v["context_tokens"] for v in vals) / n, 1)
    obj = compute_multi_objective_score(avg_cp, avg_cc, avg_mrr, hit_1, hit_3, hit_k, avg_lat, avg_tok, profile=profile)
    return {
        "testcase_count": n,
        "avg_cp": avg_cp,
        "avg_cc": avg_cc,
        "avg_mrr": avg_mrr,
        "hit_at_1": hit_1,
        "hit_at_3": hit_3,
        "hit_at_k": hit_k,
        "avg_latency_ms": avg_lat,
        "avg_context_tokens": avg_tok,
        "objective_score": obj,
        "cache_hits": sum(v["cache_hits"] for v in vals),
        "judge_calls": sum(v["judge_calls"] for v in vals),
    }


def _persist_trial_as_retrieval_run(
    conn,
    run_id: int,
    study_name: str,
    cfg: Dict[str, Any],
    judge_engine: str,
    tc_outputs: Dict[int, Dict[str, Any]],
) -> int:
    now = utc_now()
    rr_name = f"[Auto-Tuner] {study_name[:36]} · vw={cfg['vector_similarity_weight']} th={cfg['similarity_threshold']} k={cfg['top_k']}"
    cur = conn.execute(
        """
        INSERT INTO retrieval_runs
        (run_id, name, top_k, similarity_threshold, vector_similarity_weight, rerank_id, keyword_enabled, judge_engine, judge_duration_ms, judge_call_count, judge_error_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)
        """,
        (
            run_id,
            rr_name,
            int(cfg["top_k"]),
            float(cfg["similarity_threshold"]),
            float(cfg["vector_similarity_weight"]),
            cfg["rerank_id"],
            1 if cfg["keyword_enabled"] else 0,
            judge_engine,
            sum(v["judge_calls"] for v in tc_outputs.values()),
            now,
        ),
    )
    rr_id = cur.lastrowid
    for tc_id, out in tc_outputs.items():
        hits = out["hits"]
        rel_cnt = sum(1 for h in hits if h["relevant"] == 1)
        ac = "FULL" if rel_cnt > 0 and out["cc"] >= 0.78 else ("SPLIT" if out["cc"] >= 0.35 else "MISSING")
        conn.execute(
            """
            INSERT OR REPLACE INTO testcase_eval_meta
            (retrieval_run_id, testcase_id, answer_containment, context_coverage, root_cause_layer, root_cause_notes)
            VALUES (?, ?, ?, ?, '', '')
            """,
            (rr_id, tc_id, ac, out["cc"]),
        )
        for h in hits:
            conn.execute(
                """
                INSERT INTO retrieval_results
                (retrieval_run_id, testcase_id, rank, ragflow_chunk_id, ragflow_doc_id, doc_name, content, similarity, vector_similarity, term_similarity, relevant, relevancy_source, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rr_id,
                    tc_id,
                    h["rank"],
                    h["ragflow_chunk_id"],
                    h["ragflow_doc_id"],
                    h["doc_name"],
                    h["content"],
                    h["similarity"],
                    h["vector_similarity"],
                    h["term_similarity"],
                    h["relevant"],
                    h["relevancy_source"],
                    h["reason"],
                ),
            )
    return rr_id


async def run_retrieval_optimization_study(
    study_id: int,
    run_id: int,
    dataset_id: str,
    study_name: str,
    objective_profile: str,
    judge_engine: str,
    candidates: List[Dict[str, Any]],
    use_two_stage: bool = True,
    save_best_retrieval_run: bool = True,
) -> None:
    """Background worker executing 2-Stage Successive Halving Retrieval Sweep."""
    CANCEL_STUDY_FLAGS[study_id] = False
    try:
        base_url = get_setting("ragflow_base_url", "")
        api_key = get_setting("ragflow_api_key", "")
        if not base_url or not api_key:
            raise ValueError("Chưa cấu hình RAGFlow URL/API Key trong Settings.")
        judge_cfg = _resolve_judge_cfg(judge_engine)
        client = RAGFlowClient(base_url, api_key)

        acct = get_current_account_key()
        with get_db() as conn:
            if acct:
                tcs = [dict(r) for r in conn.execute("SELECT * FROM golden_testcases WHERE account_key = ? OR account_key = '' ORDER BY tc_code", (acct,)).fetchall()]
            else:
                tcs = [dict(r) for r in conn.execute("SELECT * FROM golden_testcases ORDER BY tc_code").fetchall()]
            if not tcs:
                raise ValueError("Golden Dataset đang trống.")

            # Prioritize failing testcases from latest retrieval run during Stage 1 screening
            failing_ids = set()
            latest_rr = conn.execute("SELECT id FROM retrieval_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1", (run_id,)).fetchone()
            if latest_rr:
                rr_rows = conn.execute(
                    "SELECT testcase_id, relevant FROM retrieval_results WHERE retrieval_run_id = ? ORDER BY testcase_id, rank",
                    (latest_rr["id"],),
                ).fetchall()
                by_tc_rel: Dict[int, List[int]] = {}
                for r in rr_rows:
                    if r["relevant"] is not None:
                        by_tc_rel.setdefault(r["testcase_id"], []).append(int(r["relevant"]))
                for tid, rels in by_tc_rel.items():
                    if compute_contextual_precision(rels) < 0.5 or not any(v == 1 for v in rels):
                        failing_ids.add(tid)

            mem_id_cache = {
                (r["testcase_id"], r["ragflow_chunk_id"]): (r["relevant"], r["reason"])
                for r in conn.execute("SELECT * FROM relevancy_cache").fetchall()
            }
            mem_hash_cache = {
                (r["testcase_id"], r["content_hash"]): (r["relevant"], r["reason"])
                for r in conn.execute("SELECT * FROM relevancy_content_cache").fetchall()
            }

        do_two_stage = use_two_stage and len(tcs) >= 18 and len(candidates) >= 5
        subset = _select_stratified_subset(tcs, failing_ids, ratio=0.35, min_count=12) if do_two_stage else tcs
        promote_k = min(len(candidates), max(3, math.ceil(len(candidates) * 0.30), 4)) if do_two_stage else 0

        total_steps = len(candidates) + (promote_k if do_two_stage else 0)
        with get_db() as conn:
            conn.execute(
                "UPDATE optimization_studies SET progress_done = 0, progress_total = ?, stage_label = ?, updated_at = ? WHERE id = ?",
                (total_steps, "Vòng 1: Sàng lọc nhanh" if do_two_stage else "Đánh giá toàn bộ Golden Dataset", utc_now(), study_id),
            )

        rag_sem = asyncio.Semaphore(3)
        judge_sem = asyncio.Semaphore(2 if judge_cfg["engine"] == "llm" else (4 if judge_cfg["engine"] == "jev" else 16))

        stage1_records: List[Dict[str, Any]] = []
        done_steps = 0

        for idx, cfg in enumerate(candidates, start=1):
            if CANCEL_STUDY_FLAGS.get(study_id):
                with get_db() as conn:
                    conn.execute("UPDATE optimization_studies SET status = 'CANCELLED', updated_at = ? WHERE id = ?", (utc_now(), study_id))
                return

            tc_out = await _evaluate_trial_testcases(
                client, dataset_id, cfg, subset, judge_cfg, mem_id_cache, mem_hash_cache, rag_sem, judge_sem
            )
            agg = _aggregate_trial_metrics(tc_out, objective_profile)
            stage_tag = "1_SCREENING" if do_two_stage else "2_FULL"

            with get_db() as conn:
                cur = conn.execute(
                    """
                    INSERT INTO optimization_trials
                    (study_id, trial_index, stage, config_json, testcase_count, avg_cp, avg_cc, avg_mrr, hit_at_1, hit_at_3, hit_at_k, avg_latency_ms, avg_context_tokens, objective_score, is_pareto, cache_hits, judge_calls, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'DONE', ?)
                    """,
                    (
                        study_id, idx, stage_tag, json.dumps(cfg, ensure_ascii=False),
                        agg["testcase_count"], agg["avg_cp"], agg["avg_cc"], agg["avg_mrr"],
                        agg["hit_at_1"], agg["hit_at_3"], agg["hit_at_k"],
                        agg["avg_latency_ms"], agg["avg_context_tokens"], agg["objective_score"],
                        agg["cache_hits"], agg["judge_calls"], utc_now(),
                    ),
                )
                trial_db_id = cur.lastrowid
                done_steps += 1
                conn.execute(
                    "UPDATE optimization_studies SET progress_done = ?, updated_at = ? WHERE id = ?",
                    (done_steps, utc_now(), study_id),
                )

            stage1_records.append({
                "trial_id": trial_db_id,
                "trial_index": idx,
                "config": cfg,
                "agg": agg,
                "tc_outputs": tc_out,
            })

        # Stage 2: Promote top K (always keep Trial #1 baseline if present)
        final_records: List[Dict[str, Any]] = []
        if do_two_stage:
            ranked_s1 = sorted(stage1_records, key=lambda r: (-r["agg"]["objective_score"], r["agg"]["avg_latency_ms"]))
            promoted = ranked_s1[:promote_k]
            if stage1_records and stage1_records[0] not in promoted and len(promoted) < len(stage1_records):
                promoted.append(stage1_records[0])
                total_steps += 1

            with get_db() as conn:
                conn.execute(
                    "UPDATE optimization_studies SET progress_total = ?, stage_label = ?, updated_at = ? WHERE id = ?",
                    (total_steps, f"Vòng 2: Kiểm chứng 100% ({len(promoted)} tổ hợp top)", utc_now(), study_id),
                )

            for p_idx, rec in enumerate(promoted, start=1):
                if CANCEL_STUDY_FLAGS.get(study_id):
                    with get_db() as conn:
                        conn.execute("UPDATE optimization_studies SET status = 'CANCELLED', updated_at = ? WHERE id = ?", (utc_now(), study_id))
                    return

                full_out = await _evaluate_trial_testcases(
                    client, dataset_id, rec["config"], tcs, judge_cfg,
                    mem_id_cache, mem_hash_cache, rag_sem, judge_sem,
                    prior_tc_outputs=rec["tc_outputs"],
                )
                agg_full = _aggregate_trial_metrics(full_out, objective_profile)
                with get_db() as conn:
                    cur = conn.execute(
                        """
                        INSERT INTO optimization_trials
                        (study_id, trial_index, stage, config_json, testcase_count, avg_cp, avg_cc, avg_mrr, hit_at_1, hit_at_3, hit_at_k, avg_latency_ms, avg_context_tokens, objective_score, is_pareto, cache_hits, judge_calls, status, created_at)
                        VALUES (?, ?, '2_FULL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'DONE', ?)
                        """,
                        (
                            study_id, rec["trial_index"], json.dumps(rec["config"], ensure_ascii=False),
                            agg_full["testcase_count"], agg_full["avg_cp"], agg_full["avg_cc"], agg_full["avg_mrr"],
                            agg_full["hit_at_1"], agg_full["hit_at_3"], agg_full["hit_at_k"],
                            agg_full["avg_latency_ms"], agg_full["avg_context_tokens"], agg_full["objective_score"],
                            agg_full["cache_hits"], agg_full["judge_calls"], utc_now(),
                        ),
                    )
                    full_trial_id = cur.lastrowid
                    done_steps += 1
                    conn.execute(
                        "UPDATE optimization_studies SET progress_done = ?, updated_at = ? WHERE id = ?",
                        (done_steps, utc_now(), study_id),
                    )

                final_records.append({
                    "id": full_trial_id,
                    "trial_index": rec["trial_index"],
                    "config": rec["config"],
                    "avg_latency_ms": agg_full["avg_latency_ms"],
                    "objective_score": agg_full["objective_score"],
                    "agg": agg_full,
                    "tc_outputs": full_out,
                })
        else:
            for rec in stage1_records:
                final_records.append({
                    "id": rec["trial_id"],
                    "trial_index": rec["trial_index"],
                    "config": rec["config"],
                    "avg_latency_ms": rec["agg"]["avg_latency_ms"],
                    "objective_score": rec["agg"]["objective_score"],
                    "agg": rec["agg"],
                    "tc_outputs": rec["tc_outputs"],
                })

        # Compute Pareto Frontier & Parameter Sensitivity on full-evaluated (or Stage 1) trials
        mark_pareto_frontier(final_records, x_key="avg_latency_ms", y_key="objective_score")
        best_rec = max(final_records, key=lambda r: (r["objective_score"], -r["avg_latency_ms"]))
        sensitivity_source = [
            {"config": r["config"], "objective_score": r["agg"]["objective_score"]}
            for r in stage1_records
        ]
        sensitivity = compute_parameter_sensitivity(sensitivity_source)

        with get_db() as conn:
            for r in final_records:
                conn.execute(
                    "UPDATE optimization_trials SET is_pareto = ? WHERE id = ?",
                    (1 if r.get("is_pareto") else 0, r["id"]),
                )

            saved_rr_id = None
            if save_best_retrieval_run and best_rec.get("tc_outputs"):
                saved_rr_id = _persist_trial_as_retrieval_run(
                    conn, run_id, study_name, best_rec["config"], judge_cfg["engine"], best_rec["tc_outputs"]
                )
                conn.execute(
                    "UPDATE optimization_trials SET retrieval_run_id = ? WHERE id = ?",
                    (saved_rr_id, best_rec["id"]),
                )

            baseline_rec = next((r for r in final_records if r["trial_index"] == 1), None)
            summary = {
                "total_candidates": len(candidates),
                "two_stage": do_two_stage,
                "subset_size": len(subset),
                "full_size": len(tcs),
                "best_trial_id": best_rec["id"],
                "best_config": best_rec["config"],
                "best_score": best_rec["objective_score"],
                "baseline_score": baseline_rec["objective_score"] if baseline_rec else None,
                "delta_score": round(best_rec["objective_score"] - baseline_rec["objective_score"], 4) if baseline_rec else None,
                "saved_retrieval_run_id": saved_rr_id,
                "sensitivity": sensitivity,
            }
            conn.execute(
                """
                UPDATE optimization_studies
                SET status = 'COMPLETED', stage_label = 'Hoàn tất', best_trial_id = ?, summary_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (best_rec["id"], json.dumps(summary, ensure_ascii=False), utc_now(), study_id),
            )
    except Exception as e:
        with get_db() as conn:
            conn.execute(
                "UPDATE optimization_studies SET status = 'FAILED', error_message = ?, updated_at = ? WHERE id = ?",
                (str(e)[:400], utc_now(), study_id),
            )
    finally:
        CANCEL_STUDY_FLAGS.pop(study_id, None)
