import asyncio
import json
import os
import re
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_current_account_key, get_db, get_setting, utc_now
from ragflow_client import RAGFlowClient, RAGFlowError
from llm_client import llm_generate_question, llm_judge_relevance, llm_judge_relevance_batch
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
    acct = get_current_account_key()
    with get_db() as conn:
        if acct:
            rows = conn.execute(
                "SELECT * FROM golden_testcases WHERE account_key = ? OR account_key = '' ORDER BY tc_code",
                (acct,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM golden_testcases ORDER BY tc_code").fetchall()
        return [dict(r) for r in rows]


@router.post("/testcases")
def create_testcase(payload: TestcaseCreate):
    acct = get_current_account_key()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO golden_testcases (tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, notes, account_key, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tc_code) DO UPDATE SET
                input_question=excluded.input_question,
                expected_outcome=excluded.expected_outcome,
                reference_context=excluded.reference_context,
                source_file=excluded.source_file,
                question_class=excluded.question_class,
                intent_type=excluded.intent_type,
                notes=excluded.notes,
                account_key=excluded.account_key
            """,
            (
                payload.tc_code.strip(), payload.input_question.strip(), payload.expected_outcome,
                payload.reference_context.strip(), payload.source_file, payload.question_class,
                payload.intent_type, payload.notes, acct, utc_now(),
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
    acct = get_current_account_key()
    with get_db() as conn:
        if acct:
            cur = conn.execute("DELETE FROM golden_testcases WHERE account_key = ? OR account_key = ''", (acct,))
        else:
            cur = conn.execute("DELETE FROM golden_testcases")
        deleted = cur.rowcount
    return {"ok": True, "deleted": deleted}


class AutoGenRequest(BaseModel):
    run_id: int
    total_count: int = 50
    replace_existing: bool = True
    style_prompt: str = ""


@router.post("/testcases/auto-generate")
async def auto_generate_golden_testcases(payload: AutoGenRequest):
    """
    Standalone Original-File Golden Dataset generator (default 50 testcases):
    Reads directly from original source files (`documents.file_path`) — 100% independent of
    RAGFlow chunks — allocates quotas via Bankier (1988) Adaptive √n, builds 50% Local /
    35% Global / 15% Multi-hop (keyword-matched pairs), and batches LLM calls for low latency.
    """
    import time
    from golden_generator import generate_golden_dataset_from_originals

    t0 = time.perf_counter()
    llm_base = get_setting("llm_base_url", "").strip()
    llm_key = get_setting("llm_api_key", "").strip()
    llm_model = get_setting("llm_model", "").strip()
    if not llm_base or not llm_model or (not llm_key and "localhost" not in llm_base and "127.0.0.1" not in llm_base):
        raise HTTPException(
            status_code=400,
            detail="Bắt buộc phải cấu hình LLM (Base URL, Model, API Key) trong Cài đặt trước khi sinh Golden Dataset.",
        )

    with get_db() as conn:
        doc_rows = conn.execute(
            """
            SELECT DISTINCT d.id, d.doc_code, d.filename, d.file_path, d.format_group
            FROM documents d
            JOIN chunks c ON c.document_id = d.id
            WHERE c.run_id = ?
            ORDER BY d.doc_code
            """,
            (payload.run_id,),
        ).fetchall()
        if not doc_rows:
            doc_rows = conn.execute(
                "SELECT id, doc_code, filename, file_path, format_group FROM documents ORDER BY doc_code"
            ).fetchall()
        if not doc_rows:
            raise HTTPException(
                status_code=400,
                detail="Chưa có file tài liệu gốc nào để sinh Golden Dataset. Hãy tải tài liệu lên ở Bước 1 trước.",
            )
        docs = [dict(r) for r in doc_rows]

    final_items, class_counts, errors, meta = await generate_golden_dataset_from_originals(
        docs=docs,
        total_count=payload.total_count,
        llm_base=llm_base,
        llm_key=llm_key,
        llm_model=llm_model,
        style_prompt=payload.style_prompt,
    )

    if not final_items:
        raise HTTPException(
            status_code=502,
            detail=f"LLM không sinh được câu hỏi nào từ file gốc. Lỗi gần nhất: {errors[0] if errors else 'Không rõ'}",
        )

    now = utc_now()
    acct = get_current_account_key()
    created = []
    with get_db() as conn:
        if payload.replace_existing:
            if acct:
                conn.execute("DELETE FROM golden_testcases WHERE account_key = ? OR account_key = ''", (acct,))
            else:
                conn.execute("DELETE FROM golden_testcases")
        existing_codes = {r["tc_code"] for r in conn.execute("SELECT tc_code FROM golden_testcases").fetchall()}
        next_idx = 1
        for item in final_items:
            while f"TC{next_idx:02d}" in existing_codes:
                next_idx += 1
            tc_code = f"TC{next_idx:02d}"
            existing_codes.add(tc_code)
            next_idx += 1
            conn.execute(
                """
                INSERT INTO golden_testcases (tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, notes, account_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tc_code,
                    item["question"],
                    item["expected_outcome"],
                    item["reference_context"][:2500],
                    item["source_file"],
                    item["question_class"],
                    item["intent_type"],
                    item["notes"],
                    acct,
                    now,
                ),
            )
            created.append({
                "tc_code": tc_code,
                "input_question": item["question"],
                "question_class": item["question_class"],
                "source_file": item["source_file"],
            })

    elapsed = round(time.perf_counter() - t0, 2)
    return {
        "ok": True,
        "generated_count": len(created),
        "llm_used_count": len(created),
        "class_counts": class_counts,
        "failed_count": len(errors),
        "elapsed_sec": elapsed,
        "meta": meta,
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


@router.post("/runs/execute")
async def execute_retrieval_benchmark(payload: RetrievalRunCreate):
    """
    Runs ALL Golden Testcases against RAGFlow /api/v1/retrieval, applies Smart Relevancy Cache
    to automatically inherit previously judged (testcase_id, ragflow_chunk_id) labels,
    and computes Answer Containment against the run's snapshot chunks.
    """
    base_url = get_setting("ragflow_base_url", "")
    api_key = get_setting("ragflow_api_key", "")
    if not base_url or not api_key:
        raise HTTPException(status_code=400, detail="Chưa cấu hình RAGFlow URL/API Key trong Settings.")

    llm_base = get_setting("llm_base_url", "").strip()
    llm_key = get_setting("llm_api_key", "").strip()
    llm_model = get_setting("llm_model", "").strip()
    if payload.use_llm and (not llm_base or not llm_model or (not llm_key and "localhost" not in llm_base and "127.0.0.1" not in llm_base)):
        raise HTTPException(
            status_code=400,
            detail="Chưa cấu hình LLM API Key / Model trong Cài đặt API để dùng LLM-as-a-Judge.",
        )

    acct = get_current_account_key()
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (payload.run_id,)).fetchone()
        if not run or not run["ragflow_dataset_id"]:
            raise HTTPException(status_code=400, detail="Run chưa gắn RAGFlow Dataset ID.")
        dataset_id = run["ragflow_dataset_id"]
        if acct:
            testcases = conn.execute(
                "SELECT * FROM golden_testcases WHERE account_key = ? OR account_key = '' ORDER BY tc_code",
                (acct,),
            ).fetchall()
        else:
            testcases = conn.execute("SELECT * FROM golden_testcases ORDER BY tc_code").fetchall()
        if not testcases:
            raise HTTPException(status_code=400, detail="Golden Dataset đang trống. Hãy thêm testcase trước.")

        # Load Smart Relevancy Cache
        cache_rows = conn.execute("SELECT * FROM relevancy_cache").fetchall()
        cache_map = {(c["testcase_id"], c["ragflow_chunk_id"]): (c["relevant"], c["reason"]) for c in cache_rows}

        # Load local snapshot chunks for Answer Containment check
        snap_chunks = [
            dict(c)
            for c in conn.execute("SELECT ragflow_chunk_id, content FROM chunks WHERE run_id = ?", (payload.run_id,)).fetchall()
        ]

    client = RAGFlowClient(base_url, api_key)
    now = utc_now()

    import time
    t0 = time.perf_counter()

    cache_hits = 0
    total_retrieved = 0
    use_full_ac = bool(snap_chunks) and (len(testcases) * len(snap_chunks) <= 40000)

    # Phase 1: Query RAGFlow /api/v1/retrieval cleanly with gentle concurrency Semaphore(2)
    rag_sem = asyncio.Semaphore(2)
    llm_sem = asyncio.Semaphore(10)

    async def fetch_from_ragflow(tc):
        async with rag_sem:
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
                    await asyncio.sleep(0.1)
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
            return tc, chunks

    # Phase 2: Score ALL uncached Top-K hits per question in ONE batched LLM call (Semaphore(10))
    async def judge_testcase(tc, chunks):
        ac_pool = snap_chunks if use_full_ac else chunks
        ac = compute_answer_containment(tc["reference_context"], ac_pool) if ac_pool else "UNCHECKED"
        cov = compute_context_coverage(tc["reference_context"], chunks)

        uncached_cands = []
        parsed_hits = []
        for rank, ch in enumerate(chunks, start=1):
            cid = ch.get("id") or ch.get("chunk_id") or f"unk_{rank}"
            ch_content = ch.get("content") or ch.get("content_with_weight") or ""
            ch_doc_name = ch.get("document_keyword") or ch.get("document_name") or ch.get("docnm_kwd", "")
            cached = cache_map.get((tc["id"], cid))
            parsed_hits.append((rank, cid, ch, ch_content, ch_doc_name, cached))
            if cached is None and payload.use_llm:
                uncached_cands.append({"rank": rank, "content": ch_content})

        llm_verdicts: dict = {}
        if uncached_cands and payload.use_llm:
            async with llm_sem:
                try:
                    llm_verdicts = await llm_judge_relevance_batch(
                        llm_base,
                        llm_key,
                        llm_model,
                        tc["input_question"],
                        tc["reference_context"],
                        uncached_cands,
                    )
                except Exception:
                    llm_verdicts = {}

        scored_hits = []
        local_cache_hits = 0
        for rank, cid, ch, ch_content, ch_doc_name, cached in parsed_hits:
            if cached is not None:
                rel_val, reason = cached
                src = "CACHED"
                local_cache_hits += 1
            elif rank in llm_verdicts:
                rel_val, reason = llm_verdicts[rank]
                src = "LLM_DRAFT"
            else:
                rel_val, reason = score_chunk_relevance(tc["reference_context"], ch_content)
                src = "RULE"
            scored_hits.append((rank, cid, ch, ch_content, ch_doc_name, rel_val, src, reason))

        rel_ranks = [h[0] for h in scored_hits if h[5] == 1]
        src_file = (tc["source_file"] or "").lower()
        suggested_layer = "NONE"
        if not rel_ranks:
            if ac == "FULL":
                suggested_layer = "THRESHOLD"
            elif ac == "SPLIT":
                suggested_layer = "CHUNKING"
            else:
                suggested_layer = "KEYWORD" if tc["intent_type"] == "Keyword" else "VECTOR"
        elif rel_ranks[0] > 1 and src_file:
            top_wrong_docs = [h[4].lower() for h in scored_hits if h[0] < rel_ranks[0] and h[5] == 0]
            if any(d and d != src_file for d in top_wrong_docs):
                suggested_layer = "SIMILAR_DOC"

        return tc["id"], ac, cov, suggested_layer, scored_hits, local_cache_hits

    async def process_one(tc):
        tc_obj, chunks = await fetch_from_ragflow(tc)
        return await judge_testcase(tc_obj, chunks)

    results = await asyncio.gather(*(process_one(tc) for tc in testcases))

    # Only insert retrieval_runs row once all queries & judging succeed (prevents half-baked orphan runs!)
    with get_db() as conn:
        cur = conn.execute(
            """
            INSERT INTO retrieval_runs (run_id, name, top_k, similarity_threshold, vector_similarity_weight, rerank_id, keyword_enabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.run_id, payload.name.strip(), payload.top_k, payload.similarity_threshold,
                payload.vector_similarity_weight, payload.rerank_id.strip(),
                1 if payload.keyword_enabled else 0, now,
            ),
        )
        rr_id = cur.lastrowid
        for tc_id, ac, cov, suggested_layer, scored_hits, local_cache_hits in results:
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

    elapsed = round(time.perf_counter() - t0, 2)
    return {
        "ok": True,
        "retrieval_run_id": rr_id,
        "testcases_executed": len(testcases),
        "total_chunks_retrieved": total_retrieved,
        "smart_cache_hits": cache_hits,
        "elapsed_sec": elapsed,
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
