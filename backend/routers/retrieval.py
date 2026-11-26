import asyncio
import json
import math
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from database import get_bool_setting, get_current_account_key, get_db, get_setting, resolve_golden_run_id, utc_now
from ragflow_client import RAGFlowClient, RAGFlowError
from llm_client import (
    jev_judge_relevance,
    llm_generate_question,
    llm_judge_relevance,
    llm_judge_relevance_batch,
    resolve_systemone_credentials,
    systemone_requires_key,
)
from metrics import (
    compute_answer_containment,
    compute_content_hash,
    compute_context_coverage,
    compute_contextual_precision,
    compute_parsing_metrics,
    nfc,
    score_chunk_relevance,
)
from progress_tracker import progress_inc, progress_stage, progress_start

router = APIRouter(prefix="/api/retrieval", tags=["retrieval"])


class TestcaseCreate(BaseModel):
    run_id: int = 0
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
    top_k: int = 10  # Top N returned chunks (page_size in RAGFlow)
    rerank_candidates: int = 64  # Candidate pool passed to vector/rerank (top_k in RAGFlow API)
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
def list_testcases(run_id: Optional[int] = None):
    acct = get_current_account_key()
    with get_db() as conn:
        if run_id is not None and run_id > 0:
            owner_id = resolve_golden_run_id(conn, run_id)
            rows = conn.execute(
                "SELECT * FROM golden_testcases WHERE run_id = ? ORDER BY tc_code",
                (owner_id,),
            ).fetchall()
        elif acct:
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
        owner_id = resolve_golden_run_id(conn, payload.run_id)
        conn.execute(
            """
            INSERT INTO golden_testcases (run_id, tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, notes, account_key, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, tc_code) DO UPDATE SET
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
                owner_id,
                payload.tc_code.strip(), payload.input_question.strip(), payload.expected_outcome,
                payload.reference_context.strip(), payload.source_file, payload.question_class,
                payload.intent_type, payload.notes, acct, utc_now(),
            ),
        )
        row = conn.execute(
            "SELECT * FROM golden_testcases WHERE run_id = ? AND tc_code = ?",
            (owner_id, payload.tc_code.strip()),
        ).fetchone()
        if row:
            conn.execute("DELETE FROM relevancy_cache WHERE testcase_id = ?", (row["id"],))
        return dict(row)


@router.delete("/testcases/{tc_id}")
def delete_testcase(tc_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM golden_testcases WHERE id = ?", (tc_id,))
    return {"ok": True}


@router.delete("/testcases")
def clear_all_testcases(run_id: Optional[int] = None):
    acct = get_current_account_key()
    with get_db() as conn:
        if run_id is not None and run_id > 0:
            owner_id = resolve_golden_run_id(conn, run_id)
            cur = conn.execute("DELETE FROM golden_testcases WHERE run_id = ?", (owner_id,))
        elif acct:
            cur = conn.execute("DELETE FROM golden_testcases WHERE account_key = ? OR account_key = ''", (acct,))
        else:
            cur = conn.execute("DELETE FROM golden_testcases")
        deleted = cur.rowcount
    return {"ok": True, "deleted": deleted}


@router.get("/testcases/template-xlsx")
def download_golden_template():
    from golden_importer import build_golden_template_xlsx

    data = build_golden_template_xlsx()
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="golden_dataset_template.xlsx"'},
    )


@router.post("/testcases/import-preview")
async def preview_import_golden_testcases(
    file: UploadFile = File(...),
    sheet_name: str = Form(""),
    header_row_idx: int = Form(-1),
    mapping_json: str = Form(""),
    use_ai: bool = Form(False),
):
    from golden_importer import (
        ai_map_columns,
        detect_header_row_index,
        extract_rows_with_mapping,
        heuristic_map_columns,
        read_tabular_file,
    )

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="File trống.")
    try:
        sheet_names, active_sheet, rows = read_tabular_file(
            content, file.filename or "upload.xlsx", sheet_name.strip() or None
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không đọc được file Excel/CSV: {e}")

    if len(rows) < 2:
        raise HTTPException(status_code=400, detail="File cần ít nhất 1 dòng tiêu đề và 1 dòng dữ liệu.")

    h_idx = header_row_idx if 0 <= header_row_idx < len(rows) else detect_header_row_index(rows)
    headers = rows[h_idx]
    data_rows = rows[h_idx + 1 :]

    used_ai = False
    ai_note = ""
    if mapping_json.strip():
        try:
            mapping = json.loads(mapping_json)
            conf = 1.0
        except Exception:
            mapping, conf = heuristic_map_columns(headers, data_rows[:20])
    else:
        mapping, conf = heuristic_map_columns(headers, data_rows[:20])
        # Optionally run 5-row AI column mapper when requested or when heuristic couldn't find input_question
        if use_ai or mapping.get("input_question") is None:
            llm_base = get_setting("llm_base_url", "").strip()
            llm_key = get_setting("llm_api_key", "").strip()
            llm_model = get_setting("llm_model", "").strip()
            if llm_base and llm_model and not get_bool_setting("demo_mode", False):
                try:
                    mapping = await ai_map_columns(headers, data_rows[:5], llm_base, llm_key, llm_model)
                    used_ai = True
                    conf = 0.95
                except Exception as ae:
                    ai_note = f"AI ghép cột chưa khả dụng ({str(ae)[:90]}), đang dùng nhận diện tự động."

    valid_items, error_rows = extract_rows_with_mapping(data_rows, mapping, header_row_1based=h_idx + 1)
    warning_count = sum(1 for x in valid_items if x.get("warning"))

    # Pad column labels cleanly for UI dropdown
    num_cols = max(len(headers), max((len(r) for r in data_rows[:20]), default=0))
    col_options = [
        {
            "index": i,
            "label": (headers[i] if i < len(headers) and headers[i] else f"Cột {i + 1}"),
            "sample": next((r[i][:60] for r in data_rows[:5] if i < len(r) and r[i]), ""),
        }
        for i in range(num_cols)
    ]

    return {
        "ok": True,
        "filename": file.filename,
        "sheet_names": sheet_names,
        "active_sheet": active_sheet,
        "header_row_idx": h_idx,
        "columns": col_options,
        "mapping": mapping,
        "confidence": conf,
        "used_ai": used_ai,
        "ai_note": ai_note,
        "total_data_rows": len(data_rows),
        "valid_count": len(valid_items),
        "warning_count": warning_count,
        "error_count": len(error_rows),
        "preview_items": valid_items[:100],
        "errors": error_rows[:30],
    }


@router.post("/testcases/import-commit")
async def commit_import_golden_testcases(
    file: UploadFile = File(...),
    run_id: int = Form(0),
    mode: str = Form("append"),  # "append" | "replace"
    sheet_name: str = Form(""),
    header_row_idx: int = Form(-1),
    mapping_json: str = Form(""),
):
    from golden_importer import (
        detect_header_row_index,
        extract_rows_with_mapping,
        heuristic_map_columns,
        read_tabular_file,
    )

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="File trống.")
    try:
        _, _, rows = read_tabular_file(
            content, file.filename or "upload.xlsx", sheet_name.strip() or None
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không đọc được file Excel/CSV: {e}")

    if len(rows) < 2:
        raise HTTPException(status_code=400, detail="File không có dữ liệu hợp lệ.")

    h_idx = header_row_idx if 0 <= header_row_idx < len(rows) else detect_header_row_index(rows)
    headers = rows[h_idx]
    data_rows = rows[h_idx + 1 :]

    if mapping_json.strip():
        mapping = json.loads(mapping_json)
    else:
        mapping, _ = heuristic_map_columns(headers, data_rows[:20])

    valid_items, error_rows = extract_rows_with_mapping(data_rows, mapping, header_row_1based=h_idx + 1)
    if not valid_items:
        raise HTTPException(status_code=400, detail="Không có dòng câu hỏi hợp lệ nào để nhập. Hãy kiểm tra lại cột Câu hỏi.")

    now = utc_now()
    acct = get_current_account_key()
    eff_mode = "replace" if (mode or "").strip().lower() == "replace" else "append"

    with get_db() as conn:
        owner_id = resolve_golden_run_id(conn, run_id)
        if eff_mode == "replace":
            conn.execute("DELETE FROM golden_testcases WHERE run_id = ?", (owner_id,))
        existing_codes = {
            r["tc_code"]
            for r in conn.execute("SELECT tc_code FROM golden_testcases WHERE run_id = ?", (owner_id,)).fetchall()
        }
        next_idx = 1
        imported = 0
        for item in valid_items:
            raw_code = (item["tc_code"] or "").strip()
            if raw_code and raw_code not in existing_codes:
                tc_code = raw_code
            else:
                while f"TC{next_idx:02d}" in existing_codes:
                    next_idx += 1
                tc_code = f"TC{next_idx:02d}"
                next_idx += 1
            existing_codes.add(tc_code)
            conn.execute(
                """
                INSERT INTO golden_testcases
                    (run_id, tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, notes, account_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    owner_id,
                    tc_code,
                    item["input_question"],
                    item["expected_outcome"],
                    item["reference_context"],
                    item["source_file"],
                    item["question_class"],
                    item["intent_type"],
                    item["notes"],
                    acct,
                    now,
                ),
            )
            imported += 1

    return {
        "ok": True,
        "imported_count": imported,
        "skipped_count": len(error_rows),
        "mode": eff_mode,
    }


class AutoGenRequest(BaseModel):
    run_id: int
    total_count: int = 50
    replace_existing: bool = True
    style_prompt: str = ""


@router.post("/testcases/auto-generate")
async def auto_generate_golden_testcases(payload: AutoGenRequest):
    if get_bool_setting("demo_mode", False):
        await asyncio.sleep(2.2)
        with get_db() as conn:
            rows = conn.execute("SELECT question_class FROM golden_testcases").fetchall()
        cc = {"Local": 0, "Global": 0, "Multi-hop": 0}
        for r in rows:
            qc = r["question_class"] or "Local"
            cc[qc] = cc.get(qc, 0) + 1
        return {
            "ok": True,
            "generated_count": len(rows),
            "class_counts": cc,
            "elapsed_sec": 2.2,
            "demo": True,
        }
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

    progress_stage("Đang đọc tài liệu gốc & sinh câu hỏi Golden", f"{len(docs)} tài liệu · mục tiêu {payload.total_count} câu hỏi")
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
        owner_id = resolve_golden_run_id(conn, payload.run_id)
        if payload.replace_existing:
            conn.execute("DELETE FROM golden_testcases WHERE run_id = ?", (owner_id,))
        existing_codes = {
            r["tc_code"]
            for r in conn.execute("SELECT tc_code FROM golden_testcases WHERE run_id = ?", (owner_id,)).fetchall()
        }
        next_idx = 1
        for item in final_items:
            while f"TC{next_idx:02d}" in existing_codes:
                next_idx += 1
            tc_code = f"TC{next_idx:02d}"
            existing_codes.add(tc_code)
            next_idx += 1
            conn.execute(
                """
                INSERT INTO golden_testcases (run_id, tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, notes, account_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    owner_id,
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


@router.get("/ragflow-rerank-models")
async def list_ragflow_rerank_models():
    """Fetch configured rerank models directly from the connected RAGFlow server (/api/v1/models)."""
    base_url = get_setting("ragflow_base_url", "").strip().rstrip("/")
    api_key = get_setting("ragflow_api_key", "").strip()
    if not base_url or not api_key:
        return []
    from ragflow_client import get_shared_http_client

    client = get_shared_http_client()
    try:
        r = await client.get(
            f"{base_url}/api/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10.0,
        )
        if r.status_code >= 400:
            return []
        payload = r.json()
        data = payload.get("data") or []
        out = []
        for m in data:
            raw_mt = m.get("model_type") or []
            mtypes = [raw_mt.lower()] if isinstance(raw_mt, str) else [str(t).lower() for t in raw_mt]
            if "rerank" not in mtypes:
                continue
            mid = str(m.get("model_id") or m.get("id") or "").strip()
            name = str(m.get("name") or mid).strip()
            prov = str(m.get("provider_name") or "").strip()
            inst = str(m.get("instance_name") or "").strip()
            suffix = " · ".join(x for x in (prov, inst) if x)
            out.append({
                "id": mid,
                "name": name,
                "provider_name": prov,
                "instance_name": inst,
                "label": f"{name} ({suffix})" if suffix else name,
            })
        return out
    except Exception:
        return []


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


@router.delete("/runs/{retrieval_run_id}")
def delete_retrieval_run(retrieval_run_id: int):
    with get_db() as conn:
        rr = conn.execute("SELECT id, name FROM retrieval_runs WHERE id = ?", (retrieval_run_id,)).fetchone()
        if not rr:
            raise HTTPException(status_code=404, detail="Không tìm thấy lần chạy Retrieval")
        conn.execute("DELETE FROM retrieval_results WHERE retrieval_run_id = ?", (retrieval_run_id,))
        conn.execute("DELETE FROM testcase_eval_meta WHERE retrieval_run_id = ?", (retrieval_run_id,))
        conn.execute("DELETE FROM retrieval_runs WHERE id = ?", (retrieval_run_id,))
    return {"ok": True, "deleted_id": retrieval_run_id, "name": rr["name"]}


@router.post("/runs/{retrieval_run_id}/set-baseline")
def set_baseline_retrieval_run(retrieval_run_id: int):
    with get_db() as conn:
        rr = conn.execute("SELECT id, run_id, name FROM retrieval_runs WHERE id = ?", (retrieval_run_id,)).fetchone()
        if not rr:
            raise HTTPException(status_code=404, detail="Không tìm thấy lần chạy Retrieval")
        conn.execute("UPDATE retrieval_runs SET is_baseline_rr = 0 WHERE run_id = ?", (rr["run_id"],))
        conn.execute("UPDATE retrieval_runs SET is_baseline_rr = 1 WHERE id = ?", (retrieval_run_id,))
    return {"ok": True, "baseline_id": retrieval_run_id, "name": rr["name"]}


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


def _load_doc_layer_health(conn, run_id: int) -> Dict[str, Dict[str, Any]]:
    """Aggregate per-document Parsing & Chunking health for cross-layer root-cause attribution."""
    health: Dict[str, Dict[str, Any]] = {}
    docs = conn.execute("SELECT id, doc_code, filename FROM documents").fetchall()
    doc_keys: Dict[int, List[str]] = {}
    for d in docs:
        keys = [k for k in [(d["filename"] or "").strip().lower(), (d["doc_code"] or "").strip().lower()] if k]
        doc_keys[d["id"]] = keys
        entry = {"parsing_bad": False, "parsing_note": "", "chunking_bad": False, "chunking_note": ""}
        for k in keys:
            health[k] = entry

    # Parsing health per document using the exact shared compute_parsing_metrics
    p_rows = conn.execute("SELECT * FROM parsing_units WHERE run_id = ?", (run_id,)).fetchall()
    p_by_doc: Dict[int, list] = {}
    for r in p_rows:
        p_by_doc.setdefault(r["document_id"], []).append(dict(r))
    for doc_id, units in p_by_doc.items():
        keys = doc_keys.get(doc_id, [])
        if not keys:
            continue
        pm = compute_parsing_metrics(units)
        if pm["rated_units"] == 0:
            continue
        has_table = pm["table_total"] > 0
        if pm["text_completeness"] < 0.70 or (has_table and pm["table_accuracy"] < 0.65):
            parts = [f"Text {pm['text_completeness'] * 100:.0f}%"]
            if has_table:
                parts.append(f"Table {pm['table_accuracy'] * 100:.0f}%")
            health[keys[0]]["parsing_bad"] = True
            health[keys[0]]["parsing_note"] = f"Đối chiếu Parsing file nguồn thấp ({', '.join(parts)})"

    # Chunking health per document
    c_rows = conn.execute(
        """
        SELECT c.document_id,
               COUNT(*) AS sampled_c,
               AVG(ce.integrity) AS avg_int,
               AVG(ce.context_sufficiency) AS avg_ctx
        FROM chunk_evaluations ce
        JOIN chunks c ON c.id = ce.chunk_id
        WHERE ce.run_id = ? AND ce.is_sampled = 1
        GROUP BY c.document_id
        """,
        (run_id,),
    ).fetchall()
    for r in c_rows:
        keys = doc_keys.get(r["document_id"], [])
        if not keys or not r["sampled_c"]:
            continue
        avg_int = float(r["avg_int"] if r["avg_int"] is not None else 1.0)
        avg_ctx = float(r["avg_ctx"] if r["avg_ctx"] is not None else 1.0)
        if avg_int < 0.70 or avg_ctx < 0.65:
            health[keys[0]]["chunking_bad"] = True
            health[keys[0]]["chunking_note"] = (
                f"Đối chiếu Chunking file nguồn thấp (Integrity {avg_int * 100:.0f}%, Context {avg_ctx * 100:.0f}%)"
            )
    return health


def _suggest_root_cause_layer(
    rel_ranks: List[int],
    scored_doc_names_and_rels: List[Tuple[int, str, int]],
    source_file: str,
    ac: str,
    intent_type: str,
    doc_health: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Tuple[str, str]:
    src_parts = [p.strip().lower() for p in (source_file or "").split(";") if p.strip()]
    src_file = src_parts[0] if src_parts else ""
    p_notes = []
    c_notes = []
    if doc_health and src_parts:
        for sp in src_parts:
            h = doc_health.get(sp)
            if not h:
                for k, v in doc_health.items():
                    if k and (k in sp or sp in k):
                        h = v
                        break
            if h:
                if h.get("parsing_bad") and h.get("parsing_note"):
                    p_notes.append(h["parsing_note"])
                if h.get("chunking_bad") and h.get("chunking_note"):
                    c_notes.append(h["chunking_note"])

    if not rel_ranks:
        if ac in ("MISSING", "SPLIT") and p_notes:
            return "PARSING", f"{p_notes[0]} · Answer Containment={ac}"
        if ac == "SPLIT":
            return "CHUNKING", c_notes[0] if c_notes else "Đáp án bị cắt rời (SPLIT) qua nhiều chunk"
        if ac == "MISSING" and c_notes:
            return "CHUNKING", f"{c_notes[0]} · Answer Containment=MISSING"
        if ac == "FULL":
            return "THRESHOLD", "Đáp án có đủ trong kho chunk (FULL) nhưng không lọt Top-K"
        return ("KEYWORD" if intent_type == "Keyword" else "VECTOR"), ""
    if rel_ranks[0] > 1 and src_parts:
        top_wrong_docs = [doc_name.lower() for rank, doc_name, rel in scored_doc_names_and_rels if rank < rel_ranks[0] and rel == 0]
        if any(d and all(d != sp for sp in src_parts) for d in top_wrong_docs):
            return "SIMILAR_DOC", "Tài liệu khác cùng chủ đề chen lên trước hạng #1"
        if c_notes:
            return "CHUNKING", c_notes[0]
    return "NONE", ""


@router.post("/runs/execute")
async def execute_retrieval_benchmark(payload: RetrievalRunCreate):
    """
    Runs ALL Golden Testcases against RAGFlow /api/v1/retrieval, applies Smart Relevancy Cache
    (unless bypass_cache=True), judges Top-K hits concurrently with Jev or LLM, and records timing metrics.
    """
    if get_bool_setting("demo_mode", False):
        await asyncio.sleep(2.5)
        from demo_cloner import ensure_demo_retrieval
        rr_id, rr_name, tc_cnt, rr_eng = ensure_demo_retrieval(payload.run_id, payload.name)
        if rr_id:
            return {
                "ok": True,
                "retrieval_run_id": rr_id,
                "name": rr_name,
                "total_testcases": tc_cnt,
                "testcases_executed": tc_cnt,
                "judge_engine": rr_eng,
                "elapsed_sec": 2.5,
                "demo": True,
            }

    base_url = get_setting("ragflow_base_url", "")
    api_key = get_setting("ragflow_api_key", "")
    if not base_url or not api_key:
        raise HTTPException(status_code=400, detail="Chưa cấu hình RAGFlow URL/API Key trong Settings.")

    judge_cfg = _resolve_retrieval_judge(payload.judge_engine, payload.use_llm)

    acct = get_current_account_key()
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (payload.run_id,)).fetchone()
        if not run or not run["ragflow_dataset_id"]:
            raise HTTPException(status_code=400, detail="Run chưa gắn RAGFlow Dataset ID.")
        dataset_id = run["ragflow_dataset_id"]
        owner_id = resolve_golden_run_id(conn, payload.run_id)
        testcases = conn.execute(
            "SELECT * FROM golden_testcases WHERE run_id = ? ORDER BY tc_code",
            (owner_id,),
        ).fetchall()
        if not testcases:
            raise HTTPException(status_code=400, detail="Dataset này chưa có câu hỏi Golden nào. Hãy sinh hoặc thêm câu hỏi trước.")

        # Load Smart Relevancy Cache (chunk_id exact + content_hash fallback)
        cache_map = {}
        content_cache_map = {}
        if not payload.bypass_cache:
            cache_rows = conn.execute("SELECT * FROM relevancy_cache").fetchall()
            cache_map = {(c["testcase_id"], c["ragflow_chunk_id"]): (c["relevant"], c["reason"]) for c in cache_rows}
            cc_rows = conn.execute("SELECT * FROM relevancy_content_cache").fetchall()
            content_cache_map = {(c["testcase_id"], c["content_hash"]): (c["relevant"], c["reason"]) for c in cc_rows}

        # Load local snapshot chunks for Answer Containment check & per-doc Parsing/Chunking health
        snap_chunks = [
            dict(c)
            for c in conn.execute("SELECT ragflow_chunk_id, content FROM chunks WHERE run_id = ?", (payload.run_id,)).fetchall()
        ]
        doc_health = _load_doc_layer_health(conn, payload.run_id)

    client = RAGFlowClient(base_url, api_key)
    now = utc_now()

    t0 = time.perf_counter()

    cache_hits = 0
    total_retrieved = 0
    use_full_ac = bool(snap_chunks) and (len(testcases) * len(snap_chunks) <= 40000)

    # Phase 1: Query RAGFlow /api/v1/retrieval cleanly with gentle concurrency Semaphore(2)
    rag_sem = asyncio.Semaphore(2)
    llm_sem = asyncio.Semaphore(10)
    judge_sem = _judge_semaphore(judge_cfg["engine"])

    async def fetch_from_ragflow(tc):
        async with rag_sem:
            last_err = None
            chunks = []
            for attempt in range(6):
                try:
                    resp = await client.retrieve(
                        question=tc["input_question"],
                        dataset_ids=[dataset_id],
                        top_k=max(int(payload.rerank_candidates or 64), int(payload.top_k)),
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

    # Phase 2: Evaluate Relevancy using Jev/Kev, batched LLM-as-a-Judge, or RapidFuzz rule
    async def judge_testcase(tc, chunks):
        ac_pool = snap_chunks if use_full_ac else chunks
        ac = compute_answer_containment(tc["reference_context"], ac_pool) if ac_pool else "UNCHECKED"
        cov = compute_context_coverage(tc["reference_context"], chunks)

        t_judge_start = time.perf_counter()
        engine = judge_cfg["engine"]
        scored_hits = []
        local_cache_hits = 0
        local_calls = 0
        local_errors = 0
        first_err = None

        if engine == "llm":
            uncached_cands = []
            parsed_hits = []
            for rank, ch in enumerate(chunks, start=1):
                cid = ch.get("id") or ch.get("chunk_id") or f"unk_{rank}"
                ch_content = ch.get("content") or ch.get("content_with_weight") or ""
                ch_doc_name = ch.get("document_keyword") or ch.get("document_name") or ch.get("docnm_kwd", "")
                cached = cache_map.get((tc["id"], cid))
                cache_src = "CACHED"
                if cached is None and not payload.bypass_cache and ch_content:
                    ch_hash = compute_content_hash(ch_content)
                    if ch_hash:
                        cached = content_cache_map.get((tc["id"], ch_hash))
                        if cached is not None:
                            cache_src = "CACHED"
                parsed_hits.append((rank, cid, ch, ch_content, ch_doc_name, cached, cache_src))
                if cached is None:
                    uncached_cands.append({"rank": rank, "content": ch_content})

            llm_verdicts: dict = {}
            batch_err = None
            if uncached_cands:
                local_calls = 1
                async with llm_sem:
                    try:
                        llm_verdicts = await llm_judge_relevance_batch(
                            judge_cfg["base_url"],
                            judge_cfg["api_key"],
                            judge_cfg["model"],
                            tc["input_question"],
                            tc["reference_context"],
                            uncached_cands,
                        )
                    except Exception as e:
                        batch_err = str(e)
                        local_errors = 1
                        first_err = batch_err

            for rank, cid, ch, ch_content, ch_doc_name, cached, cache_src in parsed_hits:
                if cached is not None:
                    rel_val, reason = cached
                    src = cache_src
                    local_cache_hits += 1
                elif rank in llm_verdicts:
                    rel_val, reason = llm_verdicts[rank]
                    src = "LLM_DRAFT"
                else:
                    rel_val, r_rule = score_chunk_relevance(tc["reference_context"], ch_content)
                    src = "RULE"
                    reason = (
                        f"[Fallback RapidFuzz: {batch_err[:70]}] {r_rule}"[:180]
                        if batch_err
                        else r_rule
                    )
                scored_hits.append((rank, cid, ch, ch_content, ch_doc_name, rel_val, src, reason))
        else:
            hit_tasks = []
            hit_meta = []
            for rank, ch in enumerate(chunks, start=1):
                cid = ch.get("id") or ch.get("chunk_id") or f"unk_{rank}"
                ch_content = ch.get("content") or ch.get("content_with_weight") or ""
                ch_doc_name = ch.get("document_keyword") or ch.get("document_name") or ch.get("docnm_kwd", "")
                hit_meta.append((rank, cid, ch, ch_content, ch_doc_name))
                cached = cache_map.get((tc["id"], cid))
                if cached is None and not payload.bypass_cache and ch_content:
                    ch_hash = compute_content_hash(ch_content)
                    if ch_hash:
                        cached = content_cache_map.get((tc["id"], ch_hash))
                if cached is not None:
                    async def _from_cache(val=cached):
                        return val[0], "CACHED", val[1], None, 0
                    hit_tasks.append(_from_cache())
                else:
                    hit_tasks.append(_judge_single_hit(judge_sem, judge_cfg, tc["input_question"], tc["reference_context"], ch_content))

            judged_list = await asyncio.gather(*hit_tasks) if hit_tasks else []
            for (rank, cid, ch, ch_content, ch_doc_name), (rel_val, src, reason, err_msg, ai_calls) in zip(hit_meta, judged_list):
                if src == "CACHED":
                    local_cache_hits += 1
                local_calls += ai_calls
                if err_msg:
                    local_errors += 1
                    if first_err is None:
                        first_err = err_msg
                scored_hits.append((rank, cid, ch, ch_content, ch_doc_name, rel_val, src, reason))

        tc_judge_ms = int((time.perf_counter() - t_judge_start) * 1000)
        rel_ranks = [h[0] for h in scored_hits if h[5] == 1]
        suggested_layer, suggested_notes = _suggest_root_cause_layer(
            rel_ranks,
            [(h[0], h[4], h[5]) for h in scored_hits],
            tc["source_file"],
            ac,
            tc["intent_type"],
            doc_health=doc_health,
        )
        return tc["id"], ac, cov, suggested_layer, suggested_notes, scored_hits, local_cache_hits, tc_judge_ms, local_calls, local_errors, first_err

    progress_start(
        len(testcases),
        f"Đang truy vấn RAGFlow & chấm ({judge_cfg['engine'].upper()})",
        f"Top-{payload.top_k} · {len(testcases)} câu hỏi Golden",
    )

    async def process_one(tc):
        tc_obj, chunks = await fetch_from_ragflow(tc)
        res = await judge_testcase(tc_obj, chunks)
        progress_inc(1)
        return res

    results = await asyncio.gather(*(process_one(tc) for tc in testcases))

    total_judge_ms = 0
    total_calls = 0
    total_errors = 0
    first_fatal_err = None
    for _, _, _, _, _, _, _, tc_ms, local_calls, local_errors, err_msg in results:
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

    # Only insert retrieval_runs row once all queries & judging succeed (prevents half-baked orphan runs!)
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
        for tc_id, ac, cov, suggested_layer, suggested_notes, scored_hits, local_cache_hits, _, _, _, _ in results:
            cache_hits += local_cache_hits
            conn.execute(
                """
                INSERT OR REPLACE INTO testcase_eval_meta (retrieval_run_id, testcase_id, answer_containment, context_coverage, root_cause_layer, root_cause_notes)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (rr_id, tc_id, ac, cov, suggested_layer, suggested_notes),
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
        "judge_engine": judge_cfg["engine"],
        "testcases_executed": len(testcases),
        "total_chunks_retrieved": total_retrieved,
        "smart_cache_hits": cache_hits,
        "judge_duration_ms": total_judge_ms,
        "judge_call_count": total_calls,
        "judge_error_count": total_errors,
        "elapsed_sec": elapsed,
    }


@router.post("/runs/{retrieval_run_id}/rejudge")
async def rejudge_retrieval_run(retrieval_run_id: int, payload: RejudgeRequest):
    """
    Clones an existing retrieval_run's exact Top-K retrieved chunks and re-judges every hit
    concurrently using the selected engine ('jev', 'llm', or 'rule') for fair performance comparison.
    """
    if get_bool_setting("demo_mode", False):
        await asyncio.sleep(2.2)
        with get_db() as conn:
            src_rr = conn.execute("SELECT * FROM retrieval_runs WHERE id = ?", (retrieval_run_id,)).fetchone()
            hit_cnt = conn.execute("SELECT COUNT(*) FROM retrieval_results WHERE retrieval_run_id = ?", (retrieval_run_id,)).fetchone()[0]
        if src_rr:
            return {
                "ok": True,
                "retrieval_run_id": src_rr["id"],
                "source_retrieval_run_id": retrieval_run_id,
                "name": src_rr["name"],
                "judge_engine": payload.judge_engine or "llm",
                "total_hits": hit_cnt,
                "judge_duration_ms": 2200,
                "avg_ms_per_hit": round(2200 / max(hit_cnt, 1), 1),
                "judge_call_count": 48,
                "judge_error_count": 0,
                "demo": True,
            }

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

    total_calls = 0
    error_count = 0
    first_err = None
    agreed = 0
    compared = 0
    by_tc_hits: Dict[int, list] = {}

    t0 = time.perf_counter()
    if engine == "llm":
        llm_sem = asyncio.Semaphore(10)
        grouped_src: Dict[int, list] = {}
        for h in src_hits:
            grouped_src.setdefault(h["testcase_id"], []).append(h)

        progress_start(len(grouped_src), "Đang chấm lại Retrieval bằng LLM", f"{len(grouped_src)} câu hỏi ({len(src_hits)} hits)")

        async def _eval_tc_batch(tc_id: int, hits: list):
            tc = tc_map.get(tc_id)
            q = tc["input_question"] if tc else ""
            ref = tc["reference_context"] if tc else ""
            cands = [{"rank": h["rank"], "content": h.get("content") or ""} for h in hits]
            verdicts: dict = {}
            batch_err = None
            async with llm_sem:
                try:
                    verdicts = await llm_judge_relevance_batch(
                        judge_cfg["base_url"],
                        judge_cfg["api_key"],
                        judge_cfg["model"],
                        q,
                        ref,
                        cands,
                    )
                except Exception as e:
                    batch_err = str(e)
            out = []
            for h in hits:
                rank = h["rank"]
                if rank in verdicts:
                    rel_val, reason = verdicts[rank]
                    src = "LLM_DRAFT"
                else:
                    rel_val, r_rule = score_chunk_relevance(ref, h.get("content") or "")
                    src = "RULE"
                    reason = (
                        f"[Fallback RapidFuzz: {batch_err[:70]}] {r_rule}"[:180]
                        if batch_err
                        else r_rule
                    )
                out.append((h, rel_val, src, reason))
            progress_inc(1)
            return tc_id, out, batch_err

        batch_results = await asyncio.gather(*(_eval_tc_batch(tid, hs) for tid, hs in grouped_src.items()))
        duration_ms = int((time.perf_counter() - t0) * 1000)
        for tc_id, entries, batch_err in batch_results:
            total_calls += 1
            if batch_err:
                error_count += 1
                if first_err is None:
                    first_err = batch_err
            for hit, rel_val, src, reason in entries:
                if hit.get("relevant") is not None:
                    compared += 1
                    if int(hit["relevant"]) == int(rel_val):
                        agreed += 1
                by_tc_hits.setdefault(tc_id, []).append((hit, rel_val, src, reason))
    else:
        sem = _judge_semaphore(engine)
        progress_start(len(src_hits), f"Đang chấm lại Retrieval bằng {engine.upper()}", f"{len(src_hits)} hits")

        async def _eval_hit(hit: Dict[str, Any]):
            tc = tc_map.get(hit["testcase_id"])
            q = tc["input_question"] if tc else ""
            ref = tc["reference_context"] if tc else ""
            res = await _judge_single_hit(sem, judge_cfg, q, ref, hit.get("content") or "")
            progress_inc(1)
            return hit, res

        evaluated = await asyncio.gather(*(_eval_hit(h) for h in src_hits))
        duration_ms = int((time.perf_counter() - t0) * 1000)

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

        doc_health = _load_doc_layer_health(conn, src_rr["run_id"])
        for tc_id, hit_entries in by_tc_hits.items():
            tc = tc_map.get(tc_id)
            s_meta = src_meta_map.get(tc_id, {})
            ac = s_meta.get("answer_containment", "UNCHECKED")
            cov = float(s_meta.get("context_coverage", 0.0) or 0.0)
            rel_ranks = [h["rank"] for h, rel_val, _, _ in hit_entries if rel_val == 1]
            suggested_layer, suggested_notes = _suggest_root_cause_layer(
                rel_ranks,
                [(h["rank"], h.get("doc_name") or "", rel_val) for h, rel_val, _, _ in hit_entries],
                tc["source_file"] if tc else "",
                ac,
                tc["intent_type"] if tc else "Factoid",
                doc_health=doc_health,
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO testcase_eval_meta (retrieval_run_id, testcase_id, answer_containment, context_coverage, root_cause_layer, root_cause_notes)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (new_rr_id, tc_id, ac, cov, suggested_layer, suggested_notes),
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
        rr = conn.execute("SELECT run_id FROM retrieval_runs WHERE id = ?", (retrieval_run_id,)).fetchone()
        owner_id = resolve_golden_run_id(conn, rr["run_id"]) if rr else 0
        tcs = (
            conn.execute("SELECT * FROM golden_testcases WHERE run_id = ? ORDER BY tc_code", (owner_id,)).fetchall()
            if owner_id
            else []
        )
        if not tcs:
            tcs = conn.execute(
                """
                SELECT * FROM golden_testcases
                WHERE id IN (SELECT DISTINCT testcase_id FROM retrieval_results WHERE retrieval_run_id = ?)
                ORDER BY tc_code
                """,
                (retrieval_run_id,),
            ).fetchall()
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
        # Update Smart Relevancy Cache (both chunk_id and content_hash)
        now = utc_now()
        conn.execute(
            """
            INSERT INTO relevancy_cache (testcase_id, ragflow_chunk_id, relevant, reason, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(testcase_id, ragflow_chunk_id) DO UPDATE SET
                relevant=excluded.relevant,
                reason=excluded.reason,
                updated_at=excluded.updated_at
            """,
            (row["testcase_id"], row["ragflow_chunk_id"], payload.relevant, payload.reason, now),
        )
        ch_hash = compute_content_hash(row["content"] or "")
        if ch_hash:
            conn.execute(
                """
                INSERT INTO relevancy_content_cache (testcase_id, content_hash, relevant, reason, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(testcase_id, content_hash) DO UPDATE SET
                    relevant=excluded.relevant,
                    reason=excluded.reason,
                    updated_at=excluded.updated_at
                """,
                (row["testcase_id"], ch_hash, payload.relevant, payload.reason, now),
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


class AutoTuneRequest(BaseModel):
    run_id: int
    vector_weights: List[float] = [0.3, 0.5, 0.7]
    thresholds: List[float] = [0.15, 0.25, 0.35]
    top_ks: List[int] = [5, 10]
    rerank_ids: List[str] = [""]
    rerank_candidates: int = 64
    objective: str = "composite"  # composite | mrr | hit_rate | ndcg | precision
    judge_engine: str = "llm"  # default llm | rule | jev
    bypass_cache: bool = False


def _compute_ir_metrics_from_rel_lists(
    tc_rel_lists: Dict[int, List[int]],
    tc_ideal_rel_counts: Dict[int, int],
    top_k: int,
) -> Dict[str, float]:
    n = len(tc_rel_lists)
    if n == 0:
        return {"hit_rate": 0.0, "mrr": 0.0, "ndcg": 0.0, "precision": 0.0, "empty_rate": 0.0, "composite": 0.0}

    hit_sum = 0.0
    mrr_sum = 0.0
    ndcg_sum = 0.0
    prec_sum = 0.0
    empty_cnt = 0

    for tc_id, rels in tc_rel_lists.items():
        if not rels:
            empty_cnt += 1
            continue
        first_rel_rank = next((idx for idx, r in enumerate(rels, start=1) if r == 1), None)
        if first_rel_rank is not None:
            hit_sum += 1.0
            mrr_sum += 1.0 / first_rel_rank

        dcg = sum(1.0 / math.log2(idx + 1) for idx, r in enumerate(rels, start=1) if r == 1)
        ideal_cnt = min(top_k, max(1, tc_ideal_rel_counts.get(tc_id, 1)))
        idcg = sum(1.0 / math.log2(idx + 1) for idx in range(1, ideal_cnt + 1))
        ndcg_sum += (dcg / idcg) if idcg > 0 else 0.0
        prec_sum += compute_contextual_precision(rels)

    hit_rate = round(hit_sum / n, 4)
    mrr = round(mrr_sum / n, 4)
    ndcg = round(ndcg_sum / n, 4)
    precision = round(prec_sum / n, 4)
    empty_rate = round(empty_cnt / n, 4)
    composite = round(0.40 * mrr + 0.35 * hit_rate + 0.25 * ndcg, 4)
    return {
        "hit_rate": hit_rate,
        "mrr": mrr,
        "ndcg": ndcg,
        "precision": precision,
        "empty_rate": empty_rate,
        "composite": composite,
    }


def _load_baseline_summary(conn, run_id: int) -> Optional[Dict[str, Any]]:
    rr = conn.execute(
        """
        SELECT * FROM retrieval_runs
        WHERE run_id = ?
        ORDER BY is_baseline_rr DESC, id ASC
        LIMIT 1
        """,
        (run_id,),
    ).fetchone()
    if not rr:
        return None
    rows = conn.execute(
        """
        SELECT testcase_id, rank, relevant
        FROM retrieval_results
        WHERE retrieval_run_id = ?
        ORDER BY testcase_id, rank
        """,
        (rr["id"],),
    ).fetchall()
    if not rows:
        return None
    owner_id = resolve_golden_run_id(conn, run_id)
    tc_rows = conn.execute("SELECT id FROM golden_testcases WHERE run_id = ?", (owner_id,)).fetchall()
    by_tc: Dict[int, List[int]] = {r["id"]: [] for r in tc_rows}
    for r in rows:
        by_tc.setdefault(r["testcase_id"], []).append(1 if r["relevant"] == 1 else 0)
    if not by_tc:
        return None
    ideal_counts = {tid: max(1, sum(rels)) for tid, rels in by_tc.items()}
    metrics = _compute_ir_metrics_from_rel_lists(by_tc, ideal_counts, int(rr["top_k"] or 10))
    return {
        "retrieval_run_id": rr["id"],
        "name": rr["name"],
        "top_k": int(rr["top_k"] or 10),
        "similarity_threshold": float(rr["similarity_threshold"] or 0.2),
        "vector_similarity_weight": float(rr["vector_similarity_weight"] or 0.3),
        "rerank_id": rr["rerank_id"] or "",
        **metrics,
    }


def _save_auto_tune_report(run_id: int, config_obj: Dict[str, Any], result_obj: Dict[str, Any]) -> str:
    now = utc_now()
    result_obj["updated_at"] = now
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO auto_tune_reports (run_id, config_json, result_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                config_json = excluded.config_json,
                result_json = excluded.result_json,
                updated_at = excluded.updated_at
            """,
            (
                run_id,
                json.dumps(config_obj, ensure_ascii=False),
                json.dumps(result_obj, ensure_ascii=False),
                now,
            ),
        )
    return now


@router.get("/auto-tune/latest")
def get_latest_auto_tune(run_id: int):
    with get_db() as conn:
        row = conn.execute(
            "SELECT config_json, result_json, updated_at FROM auto_tune_reports WHERE run_id = ?",
            (run_id,),
        ).fetchone()
    if not row:
        return {"found": False, "config": None, "result": None, "updated_at": None}
    try:
        cfg = json.loads(row["config_json"] or "{}")
        res = json.loads(row["result_json"] or "{}")
    except Exception:
        return {"found": False, "config": None, "result": None, "updated_at": None}
    res["updated_at"] = row["updated_at"]
    return {"found": True, "config": cfg, "result": res, "updated_at": row["updated_at"]}


@router.delete("/auto-tune/latest")
def delete_latest_auto_tune(run_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM auto_tune_reports WHERE run_id = ?", (run_id,))
    return {"ok": True}


@router.post("/auto-tune")
async def auto_tune_retrieval(payload: AutoTuneRequest):
    """
    Optimized Grid Search over (vector_similarity_weight, similarity_threshold, top_k, rerank_id):
    - Groups RAGFlow fetches by (vector_weight, rerank_id) at min(thresholds) and max(top_ks),
      evaluating all higher thresholds & smaller top_ks instantaneously in RAM (3x-6x fewer RAGFlow calls).
    - Reuses & populates SQLite relevancy_cache so LLM judging runs once per unique (testcase, chunk).
    """
    v_weights = sorted({round(max(0.0, min(1.0, float(v))), 2) for v in (payload.vector_weights or [0.3, 0.5, 0.7])})[:15]
    thresholds = sorted({round(max(0.0, min(0.95, float(t))), 2) for t in (payload.thresholds or [0.15, 0.25, 0.35])})[:20]
    top_ks = sorted({max(1, min(30, int(k))) for k in (payload.top_ks or [5, 10])})[:10]
    rerank_ids = list(dict.fromkeys([(r or "").strip() for r in (payload.rerank_ids or [""])]))[:8]
    if not v_weights:
        v_weights = [0.3, 0.5, 0.7]
    if not thresholds:
        thresholds = [0.15, 0.25, 0.35]
    if not top_ks:
        top_ks = [5, 10]
    if not rerank_ids:
        rerank_ids = [""]

    objective = (payload.objective or "composite").strip().lower()
    if objective not in ("composite", "mrr", "hit_rate", "ndcg", "precision"):
        objective = "composite"

    total_combos = len(v_weights) * len(thresholds) * len(top_ks) * len(rerank_ids)
    fetch_groups = [(vw, rr_id) for rr_id in rerank_ids for vw in v_weights]

    # Demo mode: smooth realistic grid simulation
    if get_bool_setting("demo_mode", False):
        progress_start(len(fetch_groups), "Đang quét không gian tham số (Demo)", f"{total_combos} tổ hợp")
        trials = []
        for idx_g, (vw, rr_id) in enumerate(fetch_groups, start=1):
            await asyncio.sleep(0.35)
            progress_inc(1)
            rr_bonus = 0.065 if rr_id else 0.0
            for th in thresholds:
                for k in top_ks:
                    # Smooth unimodal surface centered around vw=0.55, th=0.18
                    vw_pen = abs(vw - 0.55) * 0.22
                    th_pen = abs(th - 0.18) * 0.38 + (0.08 if th >= 0.35 else 0.0)
                    k_hit_bonus = 0.05 if k >= 10 else 0.0
                    k_prec_pen = 0.025 if k >= 10 else 0.0
                    hit_rate = round(max(0.35, min(0.98, 0.86 + rr_bonus + k_hit_bonus - vw_pen - th_pen)), 4)
                    mrr = round(max(0.28, min(0.96, 0.77 + rr_bonus * 1.15 - vw_pen * 1.1 - th_pen * 0.85)), 4)
                    ndcg = round(max(0.30, min(0.96, 0.80 + rr_bonus - vw_pen - th_pen * 0.9)), 4)
                    precision = round(max(0.25, min(0.95, 0.72 + rr_bonus - k_prec_pen - vw_pen * 0.8 + (0.04 if th >= 0.25 else 0.0))), 4)
                    composite = round(0.40 * mrr + 0.35 * hit_rate + 0.25 * ndcg, 4)
                    trials.append(
                        {
                            "vector_similarity_weight": vw,
                            "similarity_threshold": th,
                            "top_k": k,
                            "rerank_id": rr_id,
                            "hit_rate": hit_rate,
                            "mrr": mrr,
                            "ndcg": ndcg,
                            "precision": precision,
                            "empty_rate": round(max(0.0, (th - 0.22) * 0.45), 4),
                            "composite": composite,
                            "avg_latency_ms": int(145 + (110 if rr_id else 0) + vw * 18),
                        }
                    )
        trials.sort(key=lambda x: (x[objective], x["composite"], -x["avg_latency_ms"]), reverse=True)
        for rank_i, tr in enumerate(trials, start=1):
            tr["rank"] = rank_i
        best = trials[0]
        with get_db() as conn:
            baseline = _load_baseline_summary(conn, payload.run_id)
        demo_resp = {
            "ok": True,
            "objective": objective,
            "judge_engine": "llm",
            "best_config": best,
            "baseline_summary": baseline,
            "trials": trials,
            "grid_axes": {
                "vector_weights": v_weights,
                "thresholds": thresholds,
                "top_ks": top_ks,
                "rerank_ids": rerank_ids,
            },
            "stats": {
                "total_combinations": total_combos,
                "ragflow_fetch_groups": len(fetch_groups),
                "saved_fetch_ratio": round(total_combos / max(1, len(fetch_groups)), 1),
                "total_testcases": 30,
                "cache_hit_rate": 0.78,
                "llm_calls": 18,
                "elapsed_sec": round(len(fetch_groups) * 0.35, 2),
                "overfit_warning": False,
                "demo": True,
            },
        }
        return demo_resp

    base_url = get_setting("ragflow_base_url", "")
    api_key = get_setting("ragflow_api_key", "")
    if not base_url or not api_key:
        raise HTTPException(status_code=400, detail="Chưa cấu hình RAGFlow URL/API Key trong Cài đặt.")

    judge_cfg = _resolve_retrieval_judge(payload.judge_engine or "llm", (payload.judge_engine or "llm") != "rule")
    engine = judge_cfg["engine"]

    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (payload.run_id,)).fetchone()
        if not run or not run["ragflow_dataset_id"]:
            raise HTTPException(status_code=400, detail="Run chưa gắn RAGFlow Dataset ID.")
        dataset_id = run["ragflow_dataset_id"]
        owner_id = resolve_golden_run_id(conn, payload.run_id)
        testcases = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM golden_testcases WHERE run_id = ? ORDER BY tc_code",
                (owner_id,),
            ).fetchall()
        ]
        if not testcases:
            raise HTTPException(status_code=400, detail="Dataset này chưa có câu hỏi Golden nào. Hãy sinh hoặc thêm câu hỏi trước.")

        baseline_summary = _load_baseline_summary(conn, payload.run_id)

        cache_map: Dict[Tuple[int, str], Tuple[int, str]] = {}
        if not payload.bypass_cache:
            for c in conn.execute("SELECT testcase_id, ragflow_chunk_id, relevant, reason FROM relevancy_cache").fetchall():
                cache_map[(c["testcase_id"], c["ragflow_chunk_id"])] = (int(c["relevant"]), c["reason"] or "")

    client = RAGFlowClient(base_url, api_key)
    min_threshold = min(thresholds)
    max_top_k = max(top_ks)
    t0 = time.perf_counter()

    rag_sem = asyncio.Semaphore(2)
    llm_sem = asyncio.Semaphore(8)
    judge_sem = _judge_semaphore(engine)

    total_steps = len(fetch_groups) * len(testcases)
    progress_start(
        total_steps,
        f"Auto-Tune · {len(fetch_groups)} nhóm ({total_combos} tổ hợp)",
        f"{len(testcases)} câu hỏi · {engine.upper()} + Cache",
    )

    total_hits_evaluated = 0
    total_cache_hits = 0
    total_llm_calls = 0
    total_judge_errors = 0
    first_judge_err: Optional[str] = None
    new_cache_entries: Dict[Tuple[int, str], Tuple[int, str]] = {}

    # Stores fetched chunks + latency per (vw, rr_id): { tc_id: [(chunk_id, similarity, relevant), ...] }
    group_results: Dict[Tuple[float, str], Dict[str, Any]] = {}
    # Tracks union of all known relevant chunk_ids per testcase across all groups for accurate IDCG
    known_relevant_chunks: Dict[int, set] = {tc["id"]: set() for tc in testcases}

    async def _fetch_one(tc: Dict[str, Any], vw: float, rr_id: str):
        async with rag_sem:
            q_start = time.perf_counter()
            last_err = None
            chunks = []
            for attempt in range(5):
                try:
                    resp = await client.retrieve(
                        question=tc["input_question"],
                        dataset_ids=[dataset_id],
                        top_k=max(int(payload.rerank_candidates or 64), max_top_k),
                        similarity_threshold=min_threshold,
                        vector_similarity_weight=vw,
                        rerank_id=rr_id or None,
                        keyword=True,
                        page=1,
                        page_size=max_top_k,
                    )
                    chunks = resp.get("chunks", [])[:max_top_k]
                    last_err = None
                    await asyncio.sleep(0.06)
                    break
                except RAGFlowError as e:
                    last_err = e
                    msg = str(e)
                    if ("429" in msg or "CONCURRENCY" in msg.upper() or "RATE" in msg.upper()) and attempt < 4:
                        await asyncio.sleep(1.2 * (attempt + 1))
                        continue
                    raise HTTPException(status_code=400, detail=f"Lỗi Retrieval khi Auto-Tune ({tc['tc_code']}): {e}")
            if last_err is not None:
                raise HTTPException(status_code=400, detail=f"Lỗi Retrieval khi Auto-Tune ({tc['tc_code']}): {last_err}")
            latency_ms = int((time.perf_counter() - q_start) * 1000)
            return tc, chunks, latency_ms

    async def _judge_fetched(tc: Dict[str, Any], chunks: List[Dict[str, Any]]):
        nonlocal total_hits_evaluated, total_cache_hits, total_llm_calls, total_judge_errors, first_judge_err
        scored: List[Tuple[str, float, int]] = []
        parsed_hits = []
        uncached_cands = []

        for rank, ch in enumerate(chunks, start=1):
            cid = str(ch.get("id") or ch.get("chunk_id") or f"unk_{rank}")
            sim = float(ch.get("similarity", 0) or 0)
            content = ch.get("content") or ch.get("content_with_weight") or ""
            cached = cache_map.get((tc["id"], cid))
            parsed_hits.append((rank, cid, sim, content, cached))
            if cached is None:
                uncached_cands.append({"rank": rank, "cid": cid, "content": content})

        verdicts_by_rank: Dict[int, Tuple[int, str]] = {}
        if uncached_cands:
            if engine == "llm":
                total_llm_calls += 1
                async with llm_sem:
                    try:
                        verdicts_by_rank = await llm_judge_relevance_batch(
                            judge_cfg["base_url"],
                            judge_cfg["api_key"],
                            judge_cfg["model"],
                            tc["input_question"],
                            tc["reference_context"],
                            [{"rank": c["rank"], "content": c["content"]} for c in uncached_cands],
                        )
                    except Exception as e:
                        total_judge_errors += 1
                        if first_judge_err is None:
                            first_judge_err = str(e)
            else:
                tasks = [
                    _judge_single_hit(judge_sem, judge_cfg, tc["input_question"], tc["reference_context"], c["content"])
                    for c in uncached_cands
                ]
                res_list = await asyncio.gather(*tasks)
                for c, (rel_v, _src, reason, err_msg, ai_calls) in zip(uncached_cands, res_list):
                    total_llm_calls += ai_calls
                    if err_msg:
                        total_judge_errors += 1
                        if first_judge_err is None:
                            first_judge_err = err_msg
                    verdicts_by_rank[c["rank"]] = (int(rel_v), reason)

        for rank, cid, sim, content, cached in parsed_hits:
            total_hits_evaluated += 1
            if cached is not None:
                rel_val = int(cached[0])
                total_cache_hits += 1
            elif rank in verdicts_by_rank:
                rel_val, reason = verdicts_by_rank[rank]
                rel_val = int(rel_val)
                cache_map[(tc["id"], cid)] = (rel_val, reason)
                new_cache_entries[(tc["id"], cid)] = (rel_val, reason)
            else:
                rel_val, reason = score_chunk_relevance(tc["reference_context"], content)
                rel_val = int(rel_val)
            if rel_val == 1:
                known_relevant_chunks[tc["id"]].add(cid)
            scored.append((cid, sim, rel_val))

        return scored

    # Execute groups sequentially so group #2..N benefit maximally from group #1's newly cached LLM verdicts!
    for g_idx, (vw, rr_id) in enumerate(fetch_groups, start=1):
        rr_label = rr_id.split("@")[0] if rr_id else "Không Rerank"
        progress_stage(
            f"Quét nhóm {g_idx}/{len(fetch_groups)} · vec={vw} ({rr_label})",
            f"Tối ưu gộp {len(thresholds) * len(top_ks)} cấu hình từ 1 lượt gọi",
        )

        async def _run_tc(tc_item: Dict[str, Any]):
            tc_obj, chunks, lat_ms = await _fetch_one(tc_item, vw, rr_id)
            scored = await _judge_fetched(tc_obj, chunks)
            progress_inc(1)
            return tc_obj["id"], scored, lat_ms

        tc_outcomes = await asyncio.gather(*(_run_tc(tc) for tc in testcases))
        latencies = [lat for _, _, lat in tc_outcomes]
        group_results[(vw, rr_id)] = {
            "by_tc": {tid: sc for tid, sc, _ in tc_outcomes},
            "avg_latency_ms": int(round(sum(latencies) / max(1, len(latencies)))),
        }

    if engine != "rule" and total_llm_calls > 0 and total_judge_errors == total_llm_calls:
        raise HTTPException(
            status_code=400,
            detail=f"Auto-Tune chấm {engine.upper()} thất bại hoàn toàn ({total_judge_errors}/{total_llm_calls} lượt lỗi): {first_judge_err}",
        )

    # Persist newly judged entries into relevancy_cache ONLY when engine == 'llm'
    # (prevents RULE/JEV verdicts from polluting shared LLM relevancy_cache; INSERT OR IGNORE protects MANUAL)
    if engine == "llm" and new_cache_entries and not payload.bypass_cache:
        now = utc_now()
        with get_db() as conn:
            conn.executemany(
                """
                INSERT OR IGNORE INTO relevancy_cache (testcase_id, ragflow_chunk_id, relevant, reason, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                [(tid, cid, rel, rsn, now) for (tid, cid), (rel, rsn) in new_cache_entries.items()],
            )

    tc_ideal_counts = {tid: max(1, len(cids)) for tid, cids in known_relevant_chunks.items()}

    # Instant in-RAM evaluation across all (vector_weight × rerank_id × threshold × top_k)
    trials: List[Dict[str, Any]] = []
    for (vw, rr_id), gdata in group_results.items():
        by_tc_scored = gdata["by_tc"]
        avg_lat = gdata["avg_latency_ms"]
        for th in thresholds:
            for k in top_ks:
                tc_rel_lists: Dict[int, List[int]] = {}
                for tc in testcases:
                    tid = tc["id"]
                    filtered = [rel for (_cid, sim, rel) in by_tc_scored.get(tid, []) if sim >= th][:k]
                    tc_rel_lists[tid] = filtered
                m = _compute_ir_metrics_from_rel_lists(tc_rel_lists, tc_ideal_counts, k)
                trials.append(
                    {
                        "vector_similarity_weight": vw,
                        "similarity_threshold": th,
                        "top_k": k,
                        "rerank_id": rr_id,
                        **m,
                        "avg_latency_ms": avg_lat,
                    }
                )

    trials.sort(key=lambda x: (x[objective], x["composite"], -x["avg_latency_ms"]), reverse=True)
    for rank_i, tr in enumerate(trials, start=1):
        tr["rank"] = rank_i

    best = trials[0] if trials else None
    elapsed = round(time.perf_counter() - t0, 2)
    cache_hit_rate = round(total_cache_hits / max(1, total_hits_evaluated), 4)

    final_resp = {
        "ok": True,
        "objective": objective,
        "judge_engine": engine,
        "best_config": best,
        "baseline_summary": baseline_summary,
        "trials": trials,
        "grid_axes": {
            "vector_weights": v_weights,
            "thresholds": thresholds,
            "top_ks": top_ks,
            "rerank_ids": rerank_ids,
        },
        "stats": {
            "total_combinations": total_combos,
            "ragflow_fetch_groups": len(fetch_groups),
            "saved_fetch_ratio": round(total_combos / max(1, len(fetch_groups)), 1),
            "total_testcases": len(testcases),
            "cache_hit_rate": cache_hit_rate,
            "llm_calls": total_llm_calls,
            "elapsed_sec": elapsed,
            "overfit_warning": len(testcases) < 25,
        },
    }
    _save_auto_tune_report(
        payload.run_id,
        {
            "vector_weights": v_weights,
            "thresholds": thresholds,
            "top_ks": top_ks,
            "rerank_ids": rerank_ids,
            "objective": objective,
            "judge_engine": engine,
        },
        final_resp,
    )
    return final_resp
