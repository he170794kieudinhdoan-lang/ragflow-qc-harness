import json
import re
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_db, get_setting, utc_now
from ragflow_client import RAGFlowClient, RAGFlowError
from llm_client import llm_generate_question, llm_judge_relevance
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
    use_llm: bool = False


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


class AutoGenRequest(BaseModel):
    run_id: int
    per_doc: int = 3
    replace_existing: bool = False
    use_llm: bool = False


def _build_question_from_text(text: str, filename: str) -> tuple:
    """0-LLM Vietnamese question generator from document headings, tables, numbers, or paragraphs."""
    clean = nfc(text).strip()
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in clean.splitlines() if ln.strip()]
    first = lines[0] if lines else clean[:100]
    short_doc = re.sub(r"\.(pdf|docx|html|md|pptx)$", "", filename or "", flags=re.IGNORECASE)
    short_doc = re.sub(r"^DOC\d+_", "", short_doc).replace("_", " ").replace("-", " ")[:48].strip()

    m_tbl = re.search(r"(Bảng\s*\d+[^<\n]{0,80})", clean, flags=re.IGNORECASE)
    if m_tbl or "<table" in clean.lower():
        tbl_title = re.sub(r"<[^>]+>", "", m_tbl.group(1)).strip() if m_tbl else first[:80]
        q = f"Nội dung chi tiết trong {tbl_title} (tài liệu {short_doc}) quy định những gì?"
        return q, "Local", "Table"

    m_art = re.search(r"(Điều\s+\d+\.?[^\n]{0,90})", clean)
    if m_art:
        art = m_art.group(1).strip().rstrip(".:")
        q = f"Theo tài liệu {short_doc}, {art} quy định những nội dung nào?"
        return q, "Local", "Keyword"

    m_sec = re.match(r"^(?:\d+(?:\.\d+)*\.?|[IVXLC]+\.)\s+(.{8,95})$", first)
    if m_sec:
        topic = m_sec.group(1).strip().rstrip(".:")
        q = f"{topic} trong {short_doc} được trình bày như thế nào?"
        return q, "Local", "Factoid"

    m_code = re.search(r"\b(\d+/[A-ZĐ0-9\-]+|\d+[.,]\d+\s*(?:%|mg|ml|người|trường hợp)|CD4\s*[<>≤≥]?\s*\d+)\b", clean)
    if m_code:
        kw = m_code.group(1)
        q = f"Thông tin liên quan đến '{kw}' trong tài liệu {short_doc} là gì?"
        return q, "Local", "Keyword"

    sent = re.split(r"[.!?]", first)[0].strip()[:95]
    q = f"Tài liệu {short_doc} nêu những thông tin gì về: \"{sent}\"?"
    return q, "Global", "Factoid"


@router.post("/testcases/auto-generate")
async def auto_generate_golden_testcases(payload: AutoGenRequest):
    """
    Automatically generates a Golden Dataset from the documents/chunks already synced
    in `run_id`. Supports both 0-LLM (fast, free regex) and optional LLM mode.
    """
    llm_base = get_setting("llm_base_url", "").strip()
    llm_key = get_setting("llm_api_key", "").strip()
    llm_model = get_setting("llm_model", "").strip()
    if payload.use_llm and (not llm_base or not llm_model or (not llm_key and "localhost" not in llm_base and "127.0.0.1" not in llm_base)):
        raise HTTPException(
            status_code=400,
            detail="Chưa cấu hình LLM API Key / Model trong Cài đặt API. Hãy nhập key (vd: Gemini Free / OpenAI) hoặc tắt tùy chọn Dùng LLM.",
        )

    per_doc = max(1, min(payload.per_doc, 15))
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT c.document_id, c.chunk_index, c.content, d.doc_code, d.filename
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE c.run_id = ? AND LENGTH(TRIM(c.content)) >= 120
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

    next_idx = 1
    by_doc: dict = {}
    for r in rows:
        by_doc.setdefault(r["document_id"], []).append(dict(r))

    to_insert = []
    created = []
    llm_used_count = 0
    now = utc_now()

    for doc_id, clist in by_doc.items():
        n = len(clist)
        if n <= per_doc:
            chosen = clist
        elif per_doc == 1:
            chosen = [clist[0]]
        else:
            idxs = sorted(set(round(i * (n - 1) / (per_doc - 1)) for i in range(per_doc)))
            chosen = [clist[i] for i in idxs]

        for ch in chosen:
            while f"TC{next_idx:02d}" in existing_codes:
                next_idx += 1
            tc_code = f"TC{next_idx:02d}"
            existing_codes.add(tc_code)
            next_idx += 1

            raw_txt = nfc(ch["content"]).strip()
            clean_ref = re.sub(r"<[^>]+>", " ", raw_txt)
            clean_ref = re.sub(r"[ \t]+", " ", clean_ref).strip()[:500]
            note_prefix = "Auto-gen"

            if payload.use_llm:
                try:
                    question, q_class, intent, ref_ctx = await llm_generate_question(
                        llm_base, llm_key, llm_model, clean_ref, ch["filename"]
                    )
                    clean_ref = ref_ctx[:500]
                    note_prefix = f"LLM ({llm_model})"
                    llm_used_count += 1
                except Exception:
                    question, q_class, intent = _build_question_from_text(raw_txt, ch["filename"])
            else:
                question, q_class, intent = _build_question_from_text(raw_txt, ch["filename"])

            to_insert.append(
                (
                    tc_code,
                    question,
                    clean_ref,
                    ch["filename"],
                    q_class,
                    intent,
                    f"{note_prefix} từ {ch['doc_code']} #{ch['chunk_index']}",
                    now,
                )
            )
            created.append({"tc_code": tc_code, "input_question": question, "source_file": ch["filename"]})

    with get_db() as conn:
        for row_vals in to_insert:
            conn.execute(
                """
                INSERT INTO golden_testcases (tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, notes, created_at)
                VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)
                """,
                row_vals,
            )

    return {
        "ok": True,
        "generated_count": len(created),
        "llm_used_count": llm_used_count,
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

    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (payload.run_id,)).fetchone()
        if not run or not run["ragflow_dataset_id"]:
            raise HTTPException(status_code=400, detail="Run chưa gắn RAGFlow Dataset ID.")
        dataset_id = run["ragflow_dataset_id"]
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

    cache_hits = 0
    total_retrieved = 0

    for tc in testcases:
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
        except RAGFlowError as e:
            raise HTTPException(status_code=400, detail=f"Lỗi Retrieval tại {tc['tc_code']}: {e}")

        ac = compute_answer_containment(tc["reference_context"], snap_chunks) if snap_chunks else "UNCHECKED"
        cov = compute_context_coverage(tc["reference_context"], chunks)

        scored_hits = []
        for rank, ch in enumerate(chunks, start=1):
            cid = ch.get("id") or ch.get("chunk_id") or f"unk_{rank}"
            ch_content = ch.get("content") or ch.get("content_with_weight") or ""
            ch_doc_name = ch.get("document_keyword") or ch.get("document_name") or ch.get("docnm_kwd", "")
            cached = cache_map.get((tc["id"], cid))
            if cached is not None:
                rel_val, reason = cached
                src = "CACHED"
                cache_hits += 1
            elif payload.use_llm:
                try:
                    rel_val, reason = await llm_judge_relevance(
                        llm_base, llm_key, llm_model, tc["input_question"], tc["reference_context"], ch_content
                    )
                    src = "LLM_DRAFT"
                except Exception:
                    rel_val, reason = score_chunk_relevance(tc["reference_context"], ch_content)
                    src = "RULE"
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

        with get_db() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO testcase_eval_meta (retrieval_run_id, testcase_id, answer_containment, context_coverage, root_cause_layer, root_cause_notes)
                VALUES (?, ?, ?, ?, ?, '')
                """,
                (rr_id, tc["id"], ac, cov, suggested_layer),
            )
            for rank, cid, ch, ch_content, ch_doc_name, rel_val, src, reason in scored_hits:
                conn.execute(
                    """
                    INSERT INTO retrieval_results
                    (retrieval_run_id, testcase_id, rank, ragflow_chunk_id, ragflow_doc_id, doc_name, content, similarity, vector_similarity, term_similarity, relevant, relevancy_source, reason)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rr_id, tc["id"], rank, cid, ch.get("document_id", "") or ch.get("doc_id", ""),
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
        "testcases_executed": len(testcases),
        "total_chunks_retrieved": total_retrieved,
        "smart_cache_hits": cache_hits,
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
