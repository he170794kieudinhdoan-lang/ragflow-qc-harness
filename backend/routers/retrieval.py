import json
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_db, get_setting, utc_now
from ragflow_client import RAGFlowClient, RAGFlowError
from metrics import compute_contextual_precision, compute_answer_containment

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

        with get_db() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO testcase_eval_meta (retrieval_run_id, testcase_id, answer_containment, context_coverage, root_cause_layer, root_cause_notes)
                VALUES (?, ?, ?, 0.0, '', '')
                """,
                (rr_id, tc["id"], ac),
            )
            for rank, ch in enumerate(chunks, start=1):
                cid = ch.get("id") or ch.get("chunk_id") or f"unk_{rank}"
                cached = cache_map.get((tc["id"], cid))
                if cached is not None:
                    rel_val, reason = cached
                    src = "CACHED"
                    cache_hits += 1
                else:
                    rel_val, reason, src = None, "", "UNRATED"

                conn.execute(
                    """
                    INSERT INTO retrieval_results
                    (retrieval_run_id, testcase_id, rank, ragflow_chunk_id, ragflow_doc_id, doc_name, content, similarity, vector_similarity, term_similarity, relevant, relevancy_source, reason)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rr_id, tc["id"], rank, cid, ch.get("document_id", "") or ch.get("doc_id", ""),
                        ch.get("document_keyword") or ch.get("document_name") or ch.get("docnm_kwd", ""),
                        ch.get("content") or ch.get("content_with_weight") or "",
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
