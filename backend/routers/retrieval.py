import asyncio
import json
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_db, get_setting, utc_now
from ragflow_client import RAGFlowClient, RAGFlowError
from llm_client import (
    jev_judge_relevance,
    llm_generate_question,
    llm_judge_relevance,
    resolve_systemone_credentials,
    systemone_requires_key,
)
from metrics import (
    compute_answer_containment,
    compute_context_coverage,
    compute_contextual_precision,
    nfc,
    score_chunk_relevance,
)

router = APIRouter(prefix="/api/retrieval", tags=["retrieval"])


class TestcaseCreate(BaseModel):
    tc_code: str
    input_question: str
    expected_outcome: str = ""
    reference_context: str
    source_file: str = ""
    question_class: str = "Local"  # Local | Global | Multi-hop
    intent_type: str = "Factoid"
    notes: str = ""


class RetrievalRunCreate(BaseModel):
    run_id: int
    name: str
    top_k: int = 10
    similarity_threshold: float = 0.2
    vector_similarity_weight: float = 0.3
    rerank_id: str = ""
    keyword_enabled: bool = True
    use_llm: bool = True
    judge_engine: Optional[str] = None  # "jev" | "llm" | "rule"
    bypass_cache: bool = False


class RejudgeRequest(BaseModel):
    judge_engine: str = "jev"  # "jev" | "llm" | "rule"
    name: Optional[str] = None


class ResultScoreUpdate(BaseModel):
    relevant: int  # 1 | 0
    reason: str = ""


class TestcaseMetaUpdate(BaseModel):
    answer_containment: str = "UNCHECKED"
    context_coverage: float = 0.0
    root_cause_layer: str = ""
    root_cause_notes: str = ""


# ---------- Golden Dataset ----------
@router.get("/testcases")
def list_testcases():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM golden_testcases ORDER BY tc_code").fetchall()
        return [dict(r) for r in rows]


@router.post("/testcases")
def create_testcase(payload: TestcaseCreate):
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO golden_testcases (tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tc_code) DO UPDATE SET
                input_question=excluded.input_question,
                expected_outcome=excluded.expected_outcome,
                reference_context=excluded.reference_context,
                source_file=excluded.source_file,
                question_class=excluded.question_class,
                intent_type=excluded.intent_type,
                notes=excluded.notes
            """,
            (
                payload.tc_code.strip(), payload.input_question.strip(), payload.expected_outcome,
                payload.reference_context.strip(), payload.source_file, payload.question_class,
                payload.intent_type, payload.notes, utc_now(),
            ),
        )
        row = conn.execute("SELECT * FROM golden_testcases WHERE tc_code = ?", (payload.tc_code.strip(),)).fetchone()
        return dict(row)


@router.delete("/testcases/{tc_id}")
def delete_testcase(tc_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM golden_testcases WHERE id = ?", (tc_id,))
    return {"ok": True}


@router.delete("/testcases")
def clear_all_testcases():
    with get_db() as conn:
        cur = conn.execute("DELETE FROM golden_testcases")
        deleted = cur.rowcount
    return {"ok": True, "deleted": deleted}


class AutoGenRequest(BaseModel):
    run_id: int
    total_count: int = 40
    replace_existing: bool = True


def _clean_chunk_text(raw: str, max_len: int = 1200) -> str:
    txt = nfc(raw or "").strip()
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = re.sub(r"[ \t]+", " ", txt)
    return txt.strip()[:max_len]


@router.post("/testcases/auto-generate")
async def auto_generate_golden_testcases(payload: AutoGenRequest):
    """
    Mandatory LLM Golden Dataset generator with exact spec class distribution:
    Local 50%, Global 35%, Multi-hop 15% (default 40 testcases = 20 / 14 / 6).
    """
    llm_base = get_setting("llm_base_url", "").strip()
    llm_key = get_setting("llm_api_key", "").strip()
    llm_model = get_setting("llm_model", "").strip()
    if not llm_base or not llm_model or (not llm_key and "localhost" not in llm_base and "127.0.0.1" not in llm_base):
        raise HTTPException(
            status_code=400,
            detail="Bắt buộc phải cấu hình LLM (Base URL, Model, API Key) trong Cài đặt trước khi sinh Golden Dataset.",
        )

    total_count = max(5, min(payload.total_count, 100))
    n_local = round(total_count * 0.50)
    n_global = round(total_count * 0.35)
    n_multihop = max(0, total_count - n_local - n_global)

    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT c.document_id, c.chunk_index, c.content, d.doc_code, d.filename
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE c.run_id = ? AND LENGTH(TRIM(c.content)) >= 140
            ORDER BY d.doc_code, c.chunk_index
            """,
            (payload.run_id,),
        ).fetchall()
        if not rows:
            raise HTTPException(
                status_code=400,
                detail="Phiên này chưa có chunks nào để sinh bộ câu hỏi. Hãy Đồng bộ RAGFlow ở Bước 1 trước.",
            )

        if payload.replace_existing:
            conn.execute("DELETE FROM golden_testcases")

        existing_codes = {r["tc_code"] for r in conn.execute("SELECT tc_code FROM golden_testcases").fetchall()}

    by_doc: dict = {}
    for r in rows:
        by_doc.setdefault(r["document_id"], []).append(dict(r))
    doc_lists = list(by_doc.values())
    num_docs = len(doc_lists)

    jobs = []

    # 1. Local (50%): 1 chunk per job, round-robin across documents
    doc_cursor = {i: 0 for i in range(num_docs)}
    for k in range(n_local):
        d_idx = k % num_docs
        clist = doc_lists[d_idx]
        pos = (doc_cursor[d_idx] * max(1, len(clist) // 3)) % len(clist)
        doc_cursor[d_idx] += 1
        ch = clist[pos]
        jobs.append((
            "Local",
            _clean_chunk_text(ch["content"], 1600),
            ch["filename"],
            f"{ch['doc_code']} #{ch['chunk_index']}",
        ))

    # 2. Global (35%): 2-3 spread-out chunks from same doc (or 2 docs if doc is short)
    for k in range(n_global):
        d_idx = k % num_docs
        clist = doc_lists[d_idx]
        if len(clist) >= 3:
            picks = [clist[0], clist[len(clist) // 2], clist[-1]]
            src_name = clist[0]["filename"]
            ref_tag = f"{clist[0]['doc_code']} (tổng hợp 3 đoạn)"
        elif len(clist) == 2:
            picks = clist
            src_name = clist[0]["filename"]
            ref_tag = f"{clist[0]['doc_code']} (tổng hợp 2 đoạn)"
        else:
            other = doc_lists[(d_idx + 1) % num_docs]
            picks = [clist[0], other[0]]
            src_name = f"{clist[0]['filename']}; {other[0]['filename']}"
            ref_tag = f"{clist[0]['doc_code']}+{other[0]['doc_code']}"
        combined = "\n\n".join(
            f"[Đoạn {i+1} - {c['filename']} #{c['chunk_index']}]\n{_clean_chunk_text(c['content'], 950)}"
            for i, c in enumerate(picks)
        )
        jobs.append(("Global", combined, src_name, ref_tag))

    # 3. Multi-hop (15%): 2 distinct chunks from different sections/docs for A -> B -> C reasoning
    for k in range(n_multihop):
        d1 = doc_lists[(k * 2) % num_docs]
        d2 = doc_lists[(k * 2 + 1) % num_docs] if num_docs > 1 else d1
        c1 = d1[min(len(d1) - 1, k % len(d1))]
        c2 = d2[min(len(d2) - 1, (k + len(d2) // 2) % len(d2))]
        src_name = c1["filename"] if c1["filename"] == c2["filename"] else f"{c1['filename']}; {c2['filename']}"
        combined = (
            f"[Đoạn A - {c1['filename']} #{c1['chunk_index']}]\n{_clean_chunk_text(c1['content'], 1300)}\n\n"
            f"[Đoạn B - {c2['filename']} #{c2['chunk_index']}]\n{_clean_chunk_text(c2['content'], 1300)}"
        )
        jobs.append(("Multi-hop", combined, src_name, f"{c1['doc_code']}→{c2['doc_code']}"))

    sem = asyncio.Semaphore(6)
    results = []
    errors = []

    async def _run_job(idx_job: int, job: tuple):
        target_class, ctx_text, src_file, ref_tag = job
        async with sem:
            try:
                q, expected, q_class, intent, ref_ctx = await llm_generate_question(
                    llm_base, llm_key, llm_model, ctx_text, src_file, target_class=target_class
                )
                results.append((idx_job, q, expected, ref_ctx[:600], src_file, q_class, intent, f"LLM ({llm_model}) · {ref_tag}"))
            except Exception as e:
                errors.append(str(e)[:180])

    await asyncio.gather(*(_run_job(i, j) for i, j in enumerate(jobs)))

    if not results:
        raise HTTPException(
            status_code=502,
            detail=f"LLM không sinh được câu hỏi nào. Lỗi gần nhất: {errors[0] if errors else 'Không rõ'}",
        )

    results.sort(key=lambda x: x[0])
    next_idx = 1
    now = utc_now()
    created = []
    class_counts = {"Local": 0, "Global": 0, "Multi-hop": 0}

    with get_db() as conn:
        for _, q, expected, ref_ctx, src_file, q_class, intent, note in results:
            while f"TC{next_idx:02d}" in existing_codes:
                next_idx += 1
            tc_code = f"TC{next_idx:02d}"
            existing_codes.add(tc_code)
            next_idx += 1
            conn.execute(
                """
                INSERT INTO golden_testcases (tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (tc_code, q, expected, ref_ctx, src_file, q_class, intent, note, now),
            )
            class_counts[q_class] = class_counts.get(q_class, 0) + 1
            created.append({"tc_code": tc_code, "input_question": q, "question_class": q_class, "source_file": src_file})

    return {
        "ok": True,
        "generated_count": len(created),
        "llm_used_count": len(created),
        "class_counts": class_counts,
        "failed_count": len(errors),
        "testcases": created,
    }


# ---------- Retrieval Benchmark Runs ----------
@router.get("/runs")
def list_retrieval_runs(run_id: Optional[int] = None):
    with get_db() as conn:
        q = """
            SELECT rr.*, r.name as parent_run_name, r.is_baseline
            FROM retrieval_runs rr
            JOIN runs r ON r.id = rr.run_id
        """
        params: list = []
        if run_id:
            q += " WHERE rr.run_id = ?"
            params.append(run_id)
        q += " ORDER BY rr.id DESC"
        rows = conn.execute(q, params).fetchall()
        return [dict(r) for r in rows]


def _resolve_retrieval_judge(requested_engine: Optional[str], use_llm: bool) -> Dict[str, Any]:
    raw = (requested_engine or "").strip().lower()
    if raw in ("jev", "llm", "rule"):
        engine = raw
    elif not use_llm:
        engine = "rule"
    else:
        pref = (get_setting("retrieval_judge_provider", "jev") or "jev").strip().lower()
        engine = pref if pref in ("jev", "llm", "rule") else "jev"

    if engine == "jev":
        sys_base, sys_key, sys_model, threshold = resolve_systemone_credentials(get_setting)
        if not sys_base or not sys_model or (systemone_requires_key(sys_base) and not sys_key):
            raise HTTPException(
                status_code=400,
                detail="Chưa cấu hình Jev / Kev System One (URL, Model và API Key nếu dùng cloud) trong Cài đặt.",
            )
        return {"engine": "jev", "base_url": sys_base, "api_key": sys_key, "model": sys_model, "threshold": threshold}

    if engine == "llm":
        llm_base = get_setting("llm_base_url", "").strip()
        llm_key = get_setting("llm_api_key", "").strip()
        llm_model = get_setting("llm_model", "").strip()
        if not llm_base or not llm_model or (not llm_key and "localhost" not in llm_base and "127.0.0.1" not in llm_base):
            raise HTTPException(
                status_code=400,
                detail="Chưa cấu hình LLM API Key / Model trong Cài đặt API để dùng LLM-as-a-Judge.",
            )
        return {"engine": "llm", "base_url": llm_base, "api_key": llm_key, "model": llm_model}

    return {"engine": "rule"}


def _judge_semaphore(engine: str) -> asyncio.Semaphore:
    if engine == "llm":
        return asyncio.Semaphore(2)  # Avoid free-tier 429 burst on OpenAI/Vercel Azure
    if engine == "jev":
        return asyncio.Semaphore(4)  # Balanced for Colab T4 GPU / System One endpoint
    return asyncio.Semaphore(16)


async def _judge_single_hit(
    sem: asyncio.Semaphore,
    cfg: Dict[str, Any],
    question: str,
    reference_context: str,
    chunk_content: str,
) -> Tuple[int, str, str, Optional[str], int]:
    """
    Evaluate one (question, chunk) pair with Jev/Kev, generative LLM, or RapidFuzz rule.
    Returns (relevant, source, reason, error_message, ai_calls).
    """
    engine = cfg["engine"]
    if engine == "rule":
        rel_val, reason = score_chunk_relevance(reference_context, chunk_content)
        return rel_val, "RULE", reason, None, 0

    async with sem:
        try:
            if engine == "jev":
                rel_val, reason = await jev_judge_relevance(
                    cfg["base_url"],
                    cfg["api_key"],
                    cfg["model"],
                    question,
                    reference_context,
                    chunk_content,
                    threshold=cfg["threshold"],
                )
                return rel_val, "JEV_DRAFT", reason, None, 1
            rel_val, reason = await llm_judge_relevance(
                cfg["base_url"],
                cfg["api_key"],
                cfg["model"],
                question,
                reference_context,
                chunk_content,
            )
            return rel_val, "LLM_DRAFT", reason, None, 1
        except Exception as e:
            err_str = str(e)
            rel_val, reason = score_chunk_relevance(reference_context, chunk_content)
            fb_reason = f"[Fallback RapidFuzz: {err_str[:70]}] {reason}".strip()
            return rel_val, "RULE", fb_reason[:180], err_str, 1


def _suggest_root_cause_layer(
    rel_ranks: List[int],
    scored_doc_names_and_rels: List[Tuple[int, str, int]],
    source_file: str,
    ac: str,
    intent_type: str,
) -> str:
    src_file = (source_file or "").lower()
    if not rel_ranks:
        if ac == "FULL":
            return "THRESHOLD"
        if ac == "SPLIT":
            return "CHUNKING"
        return "KEYWORD" if intent_type == "Keyword" else "VECTOR"
    if rel_ranks[0] > 1 and src_file:
        top_wrong_docs = [doc_name.lower() for rank, doc_name, rel in scored_doc_names_and_rels if rank < rel_ranks[0] and rel == 0]
        if any(d and d != src_file for d in top_wrong_docs):
            return "SIMILAR_DOC"
    return "NONE"


@router.post("/runs/execute")
async def execute_retrieval_benchmark(payload: RetrievalRunCreate):
    """
    Runs ALL Golden Testcases against RAGFlow /api/v1/retrieval, applies Smart Relevancy Cache
    (unless bypass_cache=True), judges Top-K hits concurrently with Jev or LLM, and records timing metrics.
    """
    base_url = get_setting("ragflow_base_url", "")
    api_key = get_setting("ragflow_api_key", "")
    if not base_url or not api_key:
        raise HTTPException(status_code=400, detail="Chưa cấu hình RAGFlow URL/API Key trong Settings.")

    judge_cfg = _resolve_retrieval_judge(payload.judge_engine, payload.use_llm)

    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (payload.run_id,)).fetchone()
        if not run or not run["ragflow_dataset_id"]:
            raise HTTPException(status_code=400, detail="Run chưa gắn RAGFlow Dataset ID.")
        dataset_id = run["ragflow_dataset_id"]
        testcases = conn.execute("SELECT * FROM golden_testcases ORDER BY tc_code").fetchall()
        if not testcases:
            raise HTTPException(status_code=400, detail="Golden Dataset đang trống. Hãy thêm testcase trước.")

        # Load Smart Relevancy Cache
        cache_map = {}
        if not payload.bypass_cache:
            cache_rows = conn.execute("SELECT * FROM relevancy_cache").fetchall()
            cache_map = {(c["testcase_id"], c["ragflow_chunk_id"]): (c["relevant"], c["reason"]) for c in cache_rows}

        # Load local snapshot chunks for Answer Containment check
        snap_chunks = [
            dict(c)
            for c in conn.execute("SELECT ragflow_chunk_id, content FROM chunks WHERE run_id = ?", (payload.run_id,)).fetchall()
        ]

    client = RAGFlowClient(base_url, api_key)
    now = utc_now()

    cache_hits = 0
    total_retrieved = 0
    use_full_ac = bool(snap_chunks) and (len(testcases) * len(snap_chunks) <= 40000)
    ragflow_sem = asyncio.Semaphore(1)
    judge_sem = _judge_semaphore(judge_cfg["engine"])

    async def process_one(tc):
        async with ragflow_sem:
            last_err = None
            chunks = []
            for attempt in range(6):
                try:
                    resp = await client.retrieve(
                        question=tc["input_question"],
                        dataset_ids=[dataset_id],
                        top_k=payload.top_k,
                        similarity_threshold=payload.similarity_threshold,
                        vector_similarity_weight=payload.vector_similarity_weight,
                        rerank_id=payload.rerank_id.strip() or None,
                        keyword=payload.keyword_enabled,
                        page=1,
                        page_size=payload.top_k,
                    )
                    chunks = resp.get("chunks", [])[: payload.top_k]
                    last_err = None
                    await asyncio.sleep(0.25)
                    break
                except RAGFlowError as e:
                    last_err = e
                    msg = str(e)
                    if ("429" in msg or "CONCURRENCY" in msg.upper() or "RATE" in msg.upper()) and attempt < 5:
                        await asyncio.sleep(1.5 * (attempt + 1))
                        continue
                    raise HTTPException(status_code=400, detail=f"Lỗi Retrieval tại {tc['tc_code']}: {e}")
            if last_err is not None:
                raise HTTPException(status_code=400, detail=f"Lỗi Retrieval tại {tc['tc_code']}: {last_err}")

        ac_pool = snap_chunks if use_full_ac else chunks
        ac = compute_answer_containment(tc["reference_context"], ac_pool) if ac_pool else "UNCHECKED"
        cov = compute_context_coverage(tc["reference_context"], chunks)

        t_judge_start = time.perf_counter()
        hit_tasks = []
        hit_meta = []
        for rank, ch in enumerate(chunks, start=1):
            cid = ch.get("id") or ch.get("chunk_id") or f"unk_{rank}"
            ch_content = ch.get("content") or ch.get("content_with_weight") or ""
            ch_doc_name = ch.get("document_keyword") or ch.get("document_name") or ch.get("docnm_kwd", "")
            hit_meta.append((rank, cid, ch, ch_content, ch_doc_name))
            cached = cache_map.get((tc["id"], cid))
            if cached is not None:
                async def _from_cache(val=cached):
                    return val[0], "CACHED", val[1], None, 0
                hit_tasks.append(_from_cache())
            else:
                hit_tasks.append(_judge_single_hit(judge_sem, judge_cfg, tc["input_question"], tc["reference_context"], ch_content))

        judged_list = await asyncio.gather(*hit_tasks) if hit_tasks else []
        tc_judge_ms = int((time.perf_counter() - t_judge_start) * 1000)

        scored_hits = []
        local_cache_hits = 0
        local_calls = 0
        local_errors = 0
        first_err = None
        for (rank, cid, ch, ch_content, ch_doc_name), (rel_val, src, reason, err_msg, ai_calls) in zip(hit_meta, judged_list):
            if src == "CACHED":
                local_cache_hits += 1
            local_calls += ai_calls
            if err_msg:
                local_errors += 1
                if first_err is None:
                    first_err = err_msg
            scored_hits.append((rank, cid, ch, ch_content, ch_doc_name, rel_val, src, reason))

        rel_ranks = [h[0] for h in scored_hits if h[5] == 1]
        suggested_layer = _suggest_root_cause_layer(
            rel_ranks,
            [(h[0], h[4], h[5]) for h in scored_hits],
            tc["source_file"],
            ac,
            tc["intent_type"],
        )

        return tc["id"], ac, cov, suggested_layer, scored_hits, local_cache_hits, tc_judge_ms, local_calls, local_errors, first_err

    results = await asyncio.gather(*(process_one(tc) for tc in testcases))

    total_judge_ms = 0
    total_calls = 0
    total_errors = 0
    first_fatal_err = None
    for _, _, _, _, _, _, tc_ms, local_calls, local_errors, err_msg in results:
        total_judge_ms += tc_ms
        total_calls += local_calls
        total_errors += local_errors
        if err_msg and first_fatal_err is None:
            first_fatal_err = err_msg

    if judge_cfg["engine"] != "rule" and total_calls > 0 and total_errors == total_calls:
        raise HTTPException(
            status_code=400,
            detail=f"Chấm {judge_cfg['engine'].upper()} thất bại hoàn toàn ({total_errors}/{total_calls} lượt lỗi): {first_fatal_err}",
        )

    with get_db() as conn:
        cur = conn.execute(
            """
            INSERT INTO retrieval_runs (run_id, name, top_k, similarity_threshold, vector_similarity_weight, rerank_id, keyword_enabled, judge_engine, judge_duration_ms, judge_call_count, judge_error_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.run_id, payload.name.strip(), payload.top_k, payload.similarity_threshold,
                payload.vector_similarity_weight, payload.rerank_id.strip(),
                1 if payload.keyword_enabled else 0, judge_cfg["engine"], total_judge_ms, total_calls, total_errors, now,
            ),
        )
        rr_id = cur.lastrowid

        for tc_id, ac, cov, suggested_layer, scored_hits, local_cache_hits, _, _, _, _ in results:
            cache_hits += local_cache_hits
            conn.execute(
                """
                INSERT OR REPLACE INTO testcase_eval_meta (retrieval_run_id, testcase_id, answer_containment, context_coverage, root_cause_layer, root_cause_notes)
                VALUES (?, ?, ?, ?, ?, '')
                """,
                (rr_id, tc_id, ac, cov, suggested_layer),
            )
            for rank, cid, ch, ch_content, ch_doc_name, rel_val, src, reason in scored_hits:
                conn.execute(
                    """
                    INSERT INTO retrieval_results
                    (retrieval_run_id, testcase_id, rank, ragflow_chunk_id, ragflow_doc_id, doc_name, content, similarity, vector_similarity, term_similarity, relevant, relevancy_source, reason)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rr_id, tc_id, rank, cid, ch.get("document_id", "") or ch.get("doc_id", ""),
                        ch_doc_name,
                        ch_content,
                        float(ch.get("similarity", 0) or 0),
                        float(ch.get("vector_similarity", 0) or 0),
                        float(ch.get("term_similarity", 0) or 0),
                        rel_val, src, reason,
                    ),
                )
                total_retrieved += 1

    return {
        "ok": True,
        "retrieval_run_id": rr_id,
        "judge_engine": judge_cfg["engine"],
        "testcases_executed": len(testcases),
        "total_chunks_retrieved": total_retrieved,
        "smart_cache_hits": cache_hits,
        "judge_duration_ms": total_judge_ms,
        "judge_call_count": total_calls,
        "judge_error_count": total_errors,
    }


@router.post("/runs/{retrieval_run_id}/rejudge")
async def rejudge_retrieval_run(retrieval_run_id: int, payload: RejudgeRequest):
    """
    Clones an existing retrieval_run's exact Top-K retrieved chunks and re-judges every hit
    concurrently using the selected engine ('jev', 'llm', or 'rule') for fair performance comparison.
    """
    judge_cfg = _resolve_retrieval_judge(payload.judge_engine, True)
    engine = judge_cfg["engine"]

    with get_db() as conn:
        src_rr = conn.execute("SELECT * FROM retrieval_runs WHERE id = ?", (retrieval_run_id,)).fetchone()
        if not src_rr:
            raise HTTPException(status_code=404, detail="Retrieval Run gốc không tồn tại")

        src_hits = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM retrieval_results WHERE retrieval_run_id = ? ORDER BY testcase_id, rank",
                (retrieval_run_id,),
            ).fetchall()
        ]
        if not src_hits:
            raise HTTPException(status_code=400, detail="Retrieval Run gốc chưa có hit nào để chấm lại.")

        tc_map = {
            r["id"]: dict(r)
            for r in conn.execute("SELECT * FROM golden_testcases").fetchall()
        }
        src_meta_map = {
            r["testcase_id"]: dict(r)
            for r in conn.execute(
                "SELECT * FROM testcase_eval_meta WHERE retrieval_run_id = ?",
                (retrieval_run_id,),
            ).fetchall()
        }

    prefix = {"jev": "[Jev]", "llm": "[LLM]", "rule": "[Rule]"}.get(engine, "[Judge]")
    base_name = re.sub(r"^\[(?:Jev|LLM|Rule)\]\s*", "", src_rr["name"] or "").strip()
    new_name = (payload.name or f"{prefix} {base_name}").strip()

    sem = _judge_semaphore(engine)

    async def _eval_hit(hit: Dict[str, Any]):
        tc = tc_map.get(hit["testcase_id"])
        q = tc["input_question"] if tc else ""
        ref = tc["reference_context"] if tc else ""
        res = await _judge_single_hit(sem, judge_cfg, q, ref, hit.get("content") or "")
        return hit, res

    t0 = time.perf_counter()
    evaluated = await asyncio.gather(*(_eval_hit(h) for h in src_hits))
    duration_ms = int((time.perf_counter() - t0) * 1000)

    total_calls = 0
    error_count = 0
    first_err = None
    agreed = 0
    compared = 0
    by_tc_hits: Dict[int, list] = {}

    for hit, (rel_val, src, reason, err_msg, ai_calls) in evaluated:
        total_calls += ai_calls
        if err_msg:
            error_count += 1
            if first_err is None:
                first_err = err_msg
        if hit.get("relevant") is not None:
            compared += 1
            if int(hit["relevant"]) == int(rel_val):
                agreed += 1
        by_tc_hits.setdefault(hit["testcase_id"], []).append((hit, rel_val, src, reason))

    if engine != "rule" and total_calls > 0 and error_count == total_calls:
        raise HTTPException(
            status_code=400,
            detail=f"Chấm lại bằng {engine.upper()} thất bại hoàn toàn ({error_count}/{total_calls} hits lỗi): {first_err}",
        )

    now = utc_now()
    with get_db() as conn:
        cur = conn.execute(
            """
            INSERT INTO retrieval_runs
            (run_id, name, top_k, similarity_threshold, vector_similarity_weight, rerank_id, keyword_enabled, judge_engine, judge_duration_ms, judge_call_count, judge_error_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                src_rr["run_id"],
                new_name,
                src_rr["top_k"],
                src_rr["similarity_threshold"],
                src_rr["vector_similarity_weight"],
                src_rr["rerank_id"],
                src_rr["keyword_enabled"],
                engine,
                duration_ms,
                total_calls,
                error_count,
                now,
            ),
        )
        new_rr_id = cur.lastrowid

        for tc_id, hit_entries in by_tc_hits.items():
            tc = tc_map.get(tc_id)
            s_meta = src_meta_map.get(tc_id, {})
            ac = s_meta.get("answer_containment", "UNCHECKED")
            cov = float(s_meta.get("context_coverage", 0.0) or 0.0)
            rel_ranks = [h["rank"] for h, rel_val, _, _ in hit_entries if rel_val == 1]
            suggested_layer = _suggest_root_cause_layer(
                rel_ranks,
                [(h["rank"], h.get("doc_name") or "", rel_val) for h, rel_val, _, _ in hit_entries],
                tc["source_file"] if tc else "",
                ac,
                tc["intent_type"] if tc else "Factoid",
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO testcase_eval_meta (retrieval_run_id, testcase_id, answer_containment, context_coverage, root_cause_layer, root_cause_notes)
                VALUES (?, ?, ?, ?, ?, '')
                """,
                (new_rr_id, tc_id, ac, cov, suggested_layer),
            )
            for hit, rel_val, src, reason in hit_entries:
                conn.execute(
                    """
                    INSERT INTO retrieval_results
                    (retrieval_run_id, testcase_id, rank, ragflow_chunk_id, ragflow_doc_id, doc_name, content, similarity, vector_similarity, term_similarity, relevant, relevancy_source, reason)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        new_rr_id,
                        tc_id,
                        hit["rank"],
                        hit["ragflow_chunk_id"],
                        hit["ragflow_doc_id"],
                        hit["doc_name"],
                        hit["content"],
                        hit["similarity"],
                        hit["vector_similarity"],
                        hit["term_similarity"],
                        rel_val,
                        src,
                        reason,
                    ),
                )

    agreement_rate = round(agreed / compared, 4) if compared else None
    avg_ms = round(duration_ms / len(src_hits), 1) if src_hits else 0.0
    return {
        "ok": True,
        "retrieval_run_id": new_rr_id,
        "source_retrieval_run_id": retrieval_run_id,
        "name": new_name,
        "judge_engine": engine,
        "total_hits": len(src_hits),
        "judge_duration_ms": duration_ms,
        "avg_ms_per_hit": avg_ms,
        "judge_call_count": total_calls,
        "judge_error_count": error_count,
        "agreement_rate": agreement_rate,
        "agreed_hits": agreed,
        "compared_hits": compared,
    }


@router.get("/runs/{retrieval_run_id}/results")
def get_retrieval_results(retrieval_run_id: int, testcase_id: Optional[int] = None):
    with get_db() as conn:
        tcs = conn.execute("SELECT * FROM golden_testcases ORDER BY tc_code").fetchall()
        q = "SELECT * FROM retrieval_results WHERE retrieval_run_id = ?"
        params: list = [retrieval_run_id]
        if testcase_id:
            q += " AND testcase_id = ?"
            params.append(testcase_id)
        q += " ORDER BY testcase_id, rank"
        res_rows = conn.execute(q, params).fetchall()
        meta_rows = conn.execute(
            "SELECT * FROM testcase_eval_meta WHERE retrieval_run_id = ?", (retrieval_run_id,)
        ).fetchall()
        meta_map = {m["testcase_id"]: dict(m) for m in meta_rows}

        by_tc = {}
        for r in res_rows:
            by_tc.setdefault(r["testcase_id"], []).append(dict(r))

        output = []
        for tc in tcs:
            if testcase_id and tc["id"] != testcase_id:
                continue
            hits = by_tc.get(tc["id"], [])
            rels = [h["relevant"] for h in hits if h["relevant"] is not None]
            cp = compute_contextual_precision(rels)
            meta = meta_map.get(tc["id"], {"answer_containment": "UNCHECKED", "context_coverage": 0.0, "root_cause_layer": "", "root_cause_notes": ""})
            output.append({
                "testcase": dict(tc),
                "meta": meta,
                "contextual_precision": cp,
                "relevant_count": sum(1 for v in rels if v == 1),
                "rated_count": len(rels),
                "hits": hits,
            })
        return output


@router.put("/results/{result_id}/score")
def score_retrieval_result(result_id: int, payload: ResultScoreUpdate):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM retrieval_results WHERE id = ?", (result_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Kết quả không tồn tại")
        conn.execute(
            """
            UPDATE retrieval_results
            SET relevant = ?, relevancy_source = 'MANUAL', reason = ?
            WHERE id = ?
            """,
            (payload.relevant, payload.reason, result_id),
        )
        # Update Smart Relevancy Cache!
        conn.execute(
            """
            INSERT INTO relevancy_cache (testcase_id, ragflow_chunk_id, relevant, reason, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(testcase_id, ragflow_chunk_id) DO UPDATE SET
                relevant=excluded.relevant,
                reason=excluded.reason,
                updated_at=excluded.updated_at
            """,
            (row["testcase_id"], row["ragflow_chunk_id"], payload.relevant, payload.reason, utc_now()),
        )
    return {"ok": True}


@router.put("/runs/{retrieval_run_id}/testcases/{testcase_id}/meta")
def update_testcase_meta(retrieval_run_id: int, testcase_id: int, payload: TestcaseMetaUpdate):
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO testcase_eval_meta (retrieval_run_id, testcase_id, answer_containment, context_coverage, root_cause_layer, root_cause_notes)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(retrieval_run_id, testcase_id) DO UPDATE SET
                answer_containment=excluded.answer_containment,
                context_coverage=excluded.context_coverage,
                root_cause_layer=excluded.root_cause_layer,
                root_cause_notes=excluded.root_cause_notes
            """,
            (
                retrieval_run_id, testcase_id, payload.answer_containment,
                payload.context_coverage, payload.root_cause_layer, payload.root_cause_notes,
            ),
        )
    return {"ok": True}


@router.get("/runs/{retrieval_run_id}/testcases/{testcase_id}/diagnose")
def diagnose_testcase(retrieval_run_id: int, testcase_id: int):
    """
    White-box 1-click Root-Cause Triage for a testcase in a retrieval run:
    Searches all chunks in the run to determine whether the failure is in
    PARSING (missing/corrupt text), CHUNKING (fragmented/flagged), or RETRIEVAL (exists cleanly but missed Top-K).
    """
    from rapidfuzz import fuzz

    with get_db() as conn:
        rr = conn.execute("SELECT * FROM retrieval_runs WHERE id = ?", (retrieval_run_id,)).fetchone()
        if not rr:
            raise HTTPException(status_code=404, detail="Retrieval run không tồn tại")
        tc = conn.execute("SELECT * FROM golden_testcases WHERE id = ?", (testcase_id,)).fetchone()
        if not tc:
            raise HTTPException(status_code=404, detail="Testcase không tồn tại")

        hits = conn.execute(
            "SELECT ragflow_chunk_id, rank, similarity, relevant FROM retrieval_results WHERE retrieval_run_id = ? AND testcase_id = ? ORDER BY rank",
            (retrieval_run_id, testcase_id),
        ).fetchall()
        hit_map = {h["ragflow_chunk_id"]: dict(h) for h in hits}

        chunk_rows = conn.execute(
            """
            SELECT c.id, c.document_id, c.ragflow_chunk_id, c.chunk_index, c.content,
                   c.char_count, c.token_est, c.page_num, c.rule_flags,
                   d.doc_code, d.filename, d.format_group, d.file_path
            FROM chunks c
            LEFT JOIN documents d ON d.id = c.document_id
            WHERE c.run_id = ?
            """,
            (rr["run_id"],),
        ).fetchall()

    ref_text = nfc((tc["reference_context"] or "").strip())
    q_text = nfc((tc["input_question"] or "").strip())
    target = ref_text if len(ref_text) >= 12 else q_text
    target_low = target.lower()

    pos_map = {(c["document_id"], c["chunk_index"]): nfc(c["content"] or "") for c in chunk_rows}

    scored = []
    for c in chunk_rows:
        txt = pos_map[(c["document_id"], c["chunk_index"])]
        txt_low = txt.lower()
        if not target_low or not txt_low:
            score = 0.0
        else:
            p_ratio = fuzz.partial_ratio(target_low[:500], txt_low[:2500])
            ts_ratio = fuzz.token_set_ratio(target_low[:500], txt_low[:2500])
            score = round(0.65 * p_ratio + 0.35 * ts_ratio, 1)
        try:
            rflags = json.loads(c["rule_flags"] or "[]")
        except Exception:
            rflags = []
        scored.append((score, c, txt, rflags))

    scored.sort(key=lambda x: -x[0])
    top_matches = scored[:5]

    best_score = top_matches[0][0] if top_matches else 0.0
    best_flags = top_matches[0][3] if top_matches else []
    best_hit = hit_map.get(top_matches[0][1]["ragflow_chunk_id"]) if top_matches else None
    has_relevant_hit = any(h["relevant"] == 1 for h in hits)

    if has_relevant_hit and best_hit and best_hit.get("relevant") == 1:
        suggested_layer = "OK"
        summary = f"Chunk chứa đáp án (khớp {best_score}%) đã lọt Top-{best_hit['rank']} và được đánh dấu liên quan."
        config_hints = []
    elif best_score < 45.0:
        suggested_layer = "PARSING"
        summary = (
            f"Không tìm thấy đoạn chứa đáp án trong toàn bộ {len(chunk_rows)} chunks (độ khớp cao nhất chỉ {best_score}%). "
            "Khả năng cao RAGFlow bị mất nội dung khi đọc file (PDF scan, bảng biểu phức tạp hoặc OCR lỗi)."
        )
        config_hints = [
            "Đổi Layout Recognize sang DeepDOC / MinerU hoặc bật VLM (Vision) cho tài liệu scan/bảng.",
            "Kiểm tra trang PDF gốc xem đoạn này có nằm trong ảnh hoặc bảng không.",
        ]
    elif best_score < 72.0 or len(best_flags) > 0:
        suggested_layer = "CHUNKING"
        flag_str = f" (cờ: {', '.join(best_flags)})" if best_flags else ""
        summary = (
            f"Nội dung có xuất hiện trong kho chunk (khớp {best_score}%){flag_str}, "
            "nhưng bị cắt vỡ, thiếu ngữ cảnh hoặc dính nhiễu nên khó khớp truy vấn."
        )
        config_hints = [
            "Tăng chunk_token_num hoặc chỉnh delimiter để tránh cắt ngang đoạn/bảng.",
            "Thử bật Parent-Child Chunking hoặc Auto-Keywords / Auto-Questions trên RAGFlow.",
        ]
    else:
        suggested_layer = "RETRIEVAL"
        rank_note = (
            f"Chunk khớp {best_score}% nằm ở hạng #{best_hit['rank']} nhưng chưa được chấm liên quan."
            if best_hit
            else f"Chunk chứa đáp án tồn tại rõ ràng trong kho (khớp {best_score}%), nhưng KHÔNG lọt vào Top-K trả về."
        )
        summary = rank_note
        config_hints = [
            "Tăng Top-K hoặc hạ Similarity Threshold trong cấu hình truy xuất.",
            "Điều chỉnh Vector Similarity Weight (tăng trọng số từ khóa BM25 cho câu hỏi có mã/thuật ngữ chính xác).",
            "Bật Reranker hoặc dùng model Embedding tiếng Việt tốt hơn.",
        ]

    matching_chunks = []
    for score, c, txt, rflags in top_matches:
        h = hit_map.get(c["ragflow_chunk_id"])
        prev_txt = pos_map.get((c["document_id"], (c["chunk_index"] or 0) - 1), "")
        next_txt = pos_map.get((c["document_id"], (c["chunk_index"] or 0) + 1), "")
        matching_chunks.append(
            {
                "id": c["id"],
                "document_id": c["document_id"],
                "doc_code": c["doc_code"] or "",
                "filename": c["filename"] or "",
                "format_group": c["format_group"] or "",
                "has_local_file": bool(c["file_path"] and os.path.exists(c["file_path"])),
                "ragflow_chunk_id": c["ragflow_chunk_id"] or "",
                "chunk_index": c["chunk_index"],
                "page_num": c["page_num"] or 1,
                "token_est": c["token_est"] or 0,
                "char_count": c["char_count"] or 0,
                "content": txt,
                "rule_flags": rflags,
                "match_score": score,
                "in_retrieved_rank": h["rank"] if h else None,
                "in_retrieved_similarity": h["similarity"] if h else None,
                "prev_tail": prev_txt[-200:].strip() if prev_txt else "",
                "next_head": next_txt[:200].strip() if next_txt else "",
            }
        )

    return {
        "suggested_layer": suggested_layer,
        "diagnosis_summary": summary,
        "config_hints": config_hints,
        "best_match_score": best_score,
        "total_chunks_searched": len(chunk_rows),
        "matching_chunks": matching_chunks,
    }
