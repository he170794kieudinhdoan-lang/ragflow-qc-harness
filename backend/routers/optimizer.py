import json
import os
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from canary_tuner import run_canary_optimization_study, select_canary_candidates
from config_advisor import analyze_and_propose_configs, merge_index_knobs_into_parser_config
from database import UPLOAD_DIR, get_db, get_setting, utc_now
from diagnostic_swarm import get_latest_agent_diagnosis_status, run_agent_diagnosis_swarm
from optimizer_engine import build_candidate_configs, request_cancel_study, run_retrieval_optimization_study
from ragflow_client import RAGFlowClient

router = APIRouter(prefix="/api/optimizer", tags=["optimizer"])


class SweepStartRequest(BaseModel):
    name: str = "Retrieval Auto-Tuner"
    objective_profile: str = "balanced"  # balanced | high_precision | high_recall | low_latency
    judge_engine: str = "rule"  # jev | llm | rule
    use_two_stage: bool = True
    max_trials: int = 24
    save_best_retrieval_run: bool = True
    search_space: Dict[str, Any] = {}


class ApplyConfigRequest(BaseModel):
    index_patch: Dict[str, Any] = {}
    retrieval_patch: Dict[str, Any] = {}
    sync_remote: bool = True
    fork_new_run: bool = False
    new_run_name: str = ""
    copy_docs: bool = True
    auto_parse: bool = True


class CanarySweepRequest(BaseModel):
    name: str = "Canary Index-Time Tuner"
    doc_ids: List[int] = []
    variants: List[Dict[str, Any]] = []
    objective_profile: str = "balanced"
    judge_engine: str = "rule"
    rerank_id: str = ""
    cleanup_sandbox: bool = True


class AgentDiagnoseRequest(BaseModel):
    force_refresh: bool = False
    include_vision: bool = True


@router.get("/runs/{run_id}/advisor")
def get_config_advisor(run_id: int):
    try:
        return analyze_and_propose_configs(run_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/runs/{run_id}/agent-diagnose/latest")
def get_latest_agent_diagnose(run_id: int):
    res = get_latest_agent_diagnosis_status(run_id)
    return {"ok": True, **res}


@router.post("/runs/{run_id}/agent-diagnose")
async def run_agent_diagnose(run_id: int, payload: AgentDiagnoseRequest):
    try:
        return await run_agent_diagnosis_swarm(
            run_id=run_id,
            force_refresh=payload.force_refresh,
            include_vision=payload.include_vision,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi Multi-Agent Diagnose: {e}")


@router.get("/runs/{run_id}/studies")
def list_studies(run_id: int):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM optimization_studies WHERE run_id = ? ORDER BY id DESC",
            (run_id,),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["search_space"] = json.loads(d.pop("search_space_json") or "{}")
            d["summary"] = json.loads(d.pop("summary_json") or "{}")
            out.append(d)
        return out


@router.get("/studies/{study_id}")
def get_study_detail(study_id: int):
    with get_db() as conn:
        s = conn.execute("SELECT * FROM optimization_studies WHERE id = ?", (study_id,)).fetchone()
        if not s:
            raise HTTPException(status_code=404, detail="Không tìm thấy phiên tối ưu")
        trials = conn.execute(
            "SELECT * FROM optimization_trials WHERE study_id = ? ORDER BY stage DESC, objective_score DESC, avg_latency_ms ASC, id ASC",
            (study_id,),
        ).fetchall()

        study_dict = dict(s)
        study_dict["search_space"] = json.loads(study_dict.pop("search_space_json") or "{}")
        study_dict["summary"] = json.loads(study_dict.pop("summary_json") or "{}")
        trial_list = []
        for t in trials:
            td = dict(t)
            td["config"] = json.loads(td.pop("config_json") or "{}")
            td["metrics"] = json.loads(td.pop("metrics_json", "{}") or "{}")
            td["is_pareto"] = bool(td["is_pareto"])
            trial_list.append(td)
        return {"study": study_dict, "trials": trial_list}


@router.get("/runs/{run_id}/canary-candidates")
def get_canary_candidates(run_id: int, max_docs: int = 4):
    try:
        return select_canary_candidates(run_id, max_docs=max(1, min(8, max_docs)))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/runs/{run_id}/canary-sweep")
async def start_canary_sweep(run_id: int, payload: CanarySweepRequest, background_tasks: BackgroundTasks):
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run or not run["ragflow_dataset_id"]:
            raise HTTPException(status_code=400, detail="Run chưa gắn RAGFlow Dataset ID.")
        dataset_id = run["ragflow_dataset_id"]
        try:
            rc = json.loads(run["retrieval_config"] or "{}")
        except Exception:
            rc = {}
        latest_rr = conn.execute(
            "SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1",
            (run_id,),
        ).fetchone()
        base_ret = {
            "top_k": int(latest_rr["top_k"]) if latest_rr else int(rc.get("top_k", 10)),
            "similarity_threshold": float(latest_rr["similarity_threshold"]) if latest_rr else float(rc.get("similarity_threshold", 0.2)),
            "vector_similarity_weight": float(latest_rr["vector_similarity_weight"]) if latest_rr else float(rc.get("vector_similarity_weight", 0.3)),
            "rerank_id": (latest_rr["rerank_id"] if latest_rr else rc.get("rerank_id", "")) or "",
            "keyword_enabled": bool(latest_rr["keyword_enabled"]) if latest_rr else bool(rc.get("keyword_enabled", True)),
        }

    if not payload.doc_ids:
        raise HTTPException(status_code=400, detail="Hãy chọn ít nhất 1 tài liệu Canary.")
    if not payload.variants:
        raise HTTPException(status_code=400, detail="Hãy chọn ít nhất 1 biến thể cấu hình Index.")

    retrieval_configs = [base_ret]
    alt_ret = {
        "top_k": 10,
        "similarity_threshold": 0.12,
        "vector_similarity_weight": 0.25,
        "rerank_id": payload.rerank_id.strip() or base_ret["rerank_id"],
        "keyword_enabled": True,
    }
    if alt_ret != base_ret:
        retrieval_configs.append(alt_ret)
    if payload.rerank_id.strip() and payload.rerank_id.strip() != base_ret["rerank_id"]:
        retrieval_configs.append({**base_ret, "rerank_id": payload.rerank_id.strip()})

    now = utc_now()
    with get_db() as conn:
        cur = conn.execute(
            """
            INSERT INTO optimization_studies
            (run_id, name, study_type, objective_profile, search_space_json, status, progress_done, progress_total, stage_label, created_at, updated_at)
            VALUES (?, ?, 'CANARY_INDEX', ?, ?, 'RUNNING', 0, ?, 'Đang chuẩn bị Canary Tuner...', ?, ?)
            """,
            (
                run_id,
                payload.name.strip() or "Canary Index-Time Tuner",
                payload.objective_profile,
                json.dumps({"doc_ids": payload.doc_ids, "variants": payload.variants}, ensure_ascii=False),
                len(payload.variants),
                now,
                now,
            ),
        )
        study_id = cur.lastrowid

    background_tasks.add_task(
        run_canary_optimization_study,
        study_id=study_id,
        run_id=run_id,
        baseline_dataset_id=dataset_id,
        study_name=payload.name.strip() or "Canary Index-Time Tuner",
        doc_ids=payload.doc_ids[:6],
        variants=payload.variants[:5],
        retrieval_configs=retrieval_configs,
        objective_profile=payload.objective_profile,
        judge_engine=payload.judge_engine,
        cleanup_sandbox=payload.cleanup_sandbox,
    )
    return {"ok": True, "study_id": study_id, "variant_count": len(payload.variants[:5])}


@router.post("/runs/{run_id}/sweep")
async def start_retrieval_sweep(run_id: int, payload: SweepStartRequest, background_tasks: BackgroundTasks):
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run or not run["ragflow_dataset_id"]:
            raise HTTPException(status_code=400, detail="Run chưa gắn RAGFlow Dataset ID.")
        dataset_id = run["ragflow_dataset_id"]
        try:
            rc = json.loads(run["retrieval_config"] or "{}")
        except Exception:
            rc = {}
        latest_rr = conn.execute(
            "SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1",
            (run_id,),
        ).fetchone()
        baseline_cfg = {
            "top_k": int(latest_rr["top_k"]) if latest_rr else int(rc.get("top_k", 10)),
            "similarity_threshold": float(latest_rr["similarity_threshold"]) if latest_rr else float(rc.get("similarity_threshold", 0.2)),
            "vector_similarity_weight": float(latest_rr["vector_similarity_weight"]) if latest_rr else float(rc.get("vector_similarity_weight", 0.3)),
            "rerank_id": (latest_rr["rerank_id"] if latest_rr else rc.get("rerank_id", "")) or "",
            "keyword_enabled": bool(latest_rr["keyword_enabled"]) if latest_rr else bool(rc.get("keyword_enabled", True)),
        }

        tc_count = conn.execute("SELECT COUNT(*) FROM golden_testcases").fetchone()[0]
        if tc_count == 0:
            raise HTTPException(status_code=400, detail="Golden Dataset đang trống. Hãy tạo câu hỏi ở Bước 4 trước.")

        candidates = build_candidate_configs(
            payload.search_space,
            baseline_cfg=baseline_cfg,
            max_trials=max(2, min(48, payload.max_trials)),
        )
        now = utc_now()
        cur = conn.execute(
            """
            INSERT INTO optimization_studies
            (run_id, name, study_type, objective_profile, search_space_json, status, progress_done, progress_total, stage_label, created_at, updated_at)
            VALUES (?, ?, 'RETRIEVAL_SWEEP', ?, ?, 'RUNNING', 0, ?, 'Đang khởi tạo...', ?, ?)
            """,
            (
                run_id,
                payload.name.strip() or "Retrieval Auto-Tuner",
                payload.objective_profile,
                json.dumps(payload.search_space, ensure_ascii=False),
                len(candidates),
                now,
                now,
            ),
        )
        study_id = cur.lastrowid

    background_tasks.add_task(
        run_retrieval_optimization_study,
        study_id=study_id,
        run_id=run_id,
        dataset_id=dataset_id,
        study_name=payload.name.strip() or "Retrieval Auto-Tuner",
        objective_profile=payload.objective_profile,
        judge_engine=payload.judge_engine,
        candidates=candidates,
        use_two_stage=payload.use_two_stage,
        save_best_retrieval_run=payload.save_best_retrieval_run,
    )
    return {"ok": True, "study_id": study_id, "candidate_count": len(candidates)}


@router.post("/studies/{study_id}/cancel")
def cancel_study(study_id: int):
    request_cancel_study(study_id)
    with get_db() as conn:
        conn.execute(
            "UPDATE optimization_studies SET stage_label = 'Đang hủy...', updated_at = ? WHERE id = ? AND status = 'RUNNING'",
            (utc_now(), study_id),
        )
    return {"ok": True}


@router.delete("/studies/{study_id}")
def delete_study(study_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM optimization_studies WHERE id = ?", (study_id,))
    return {"ok": True}


@router.post("/runs/{run_id}/apply-config")
async def apply_recommended_config(run_id: int, payload: ApplyConfigRequest):
    """
    Applies a Candidate Config Pack (or winning Auto-Tuner config) either directly to the
    current run or by forking a brand-new experiment Run + remote RAGFlow Dataset.
    """
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")
        cur_pc = json.loads(run["parser_config"] or "{}")
        cur_rc = json.loads(run["retrieval_config"] or "{}")

    next_pc = merge_index_knobs_into_parser_config(cur_pc, payload.index_patch) if payload.index_patch else cur_pc
    next_rc = {**cur_rc, **(payload.retrieval_patch or {})}

    base_url = get_setting("ragflow_base_url", "")
    api_key = get_setting("ragflow_api_key", "")
    remote_synced = False
    remote_warning = ""

    if payload.fork_new_run:
        fork_name = (payload.new_run_name or f"{run['name']} · Optimized").strip()
        with get_db() as conn:
            existing_names = {r["name"] for r in conn.execute("SELECT name FROM runs").fetchall()}
            source_docs = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT d.id, d.doc_code, d.filename, d.file_path, COALESCE(rd.ragflow_doc_id, '') AS ragflow_doc_id
                    FROM run_documents rd
                    JOIN documents d ON d.id = rd.document_id
                    WHERE rd.run_id = ?
                    ORDER BY d.doc_code
                    """,
                    (run_id,),
                ).fetchall()
            ]
        cand_name = fork_name
        suffix = 2
        while cand_name in existing_names:
            cand_name = f"{fork_name} ({suffix})"
            suffix += 1

        new_ds_id = ""
        new_ds_name = cand_name
        client: Optional[RAGFlowClient] = None
        if payload.sync_remote and base_url and api_key:
            try:
                client = RAGFlowClient(base_url, api_key)
                embedding_model = None
                if run["ragflow_dataset_id"]:
                    base_ds = await client.get_dataset(run["ragflow_dataset_id"])
                    embedding_model = (base_ds or {}).get("embedding_model") or None
                ds = await client.create_dataset(
                    name=cand_name,
                    chunk_method=str(next_pc.get("chunk_method") or "general"),
                    embedding_model=embedding_model,
                    parser_config=next_pc,
                    description=f"Forked & optimized from {run['name']}",
                )
                new_ds_id = ds.get("id", "")
                new_ds_name = ds.get("name", cand_name)
                remote_synced = True
            except Exception as e:
                remote_warning = str(e)

        now = utc_now()
        with get_db() as conn:
            cur = conn.execute(
                """
                INSERT INTO runs (name, description, is_baseline, ragflow_dataset_id, ragflow_dataset_name, parser_config, retrieval_config, status, account_key, created_at)
                VALUES (?, ?, 0, ?, ?, ?, ?, 'READY', ?, ?)
                """,
                (
                    cand_name,
                    f"Tối ưu từ {run['name']}",
                    new_ds_id,
                    new_ds_name,
                    json.dumps(next_pc, ensure_ascii=False),
                    json.dumps(next_rc, ensure_ascii=False),
                    run["account_key"] if "account_key" in run.keys() else "",
                    now,
                ),
            )
            new_run_id = cur.lastrowid
            if payload.copy_docs and source_docs:
                for d in source_docs:
                    conn.execute(
                        """
                        INSERT INTO run_documents (run_id, document_id, ragflow_doc_id, parse_status, progress, chunk_count, token_count, parse_duration_sec, anomaly_flags, updated_at)
                        VALUES (?, ?, '', 'UNSTART', 0, 0, 0, 0, '[]', ?)
                        ON CONFLICT(run_id, document_id) DO NOTHING
                        """,
                        (new_run_id, d["id"], now),
                    )

        copied_docs = 0
        parse_triggered = False
        if payload.copy_docs and source_docs and new_ds_id and client is not None:
            uploaded_pairs: List[tuple] = []
            copy_errors: List[str] = []
            for d in source_docs:
                try:
                    file_bytes: Optional[bytes] = None
                    fp = d.get("file_path") or ""
                    if fp and os.path.exists(fp):
                        with open(fp, "rb") as f:
                            file_bytes = f.read()
                    elif d.get("ragflow_doc_id") and run["ragflow_dataset_id"]:
                        file_bytes = await client.download_document(run["ragflow_dataset_id"], d["ragflow_doc_id"])
                        safe_name = os.path.basename(d["filename"] or f"{d['doc_code']}.bin")
                        save_fp = os.path.join(UPLOAD_DIR, f"{d['doc_code']}_{safe_name}")
                        with open(save_fp, "wb") as f:
                            f.write(file_bytes)
                        with get_db() as conn:
                            conn.execute("UPDATE documents SET file_path = ? WHERE id = ?", (save_fp, d["id"]))

                    if not file_bytes:
                        copy_errors.append(f"{d['doc_code']}: không có file gốc")
                        continue

                    up_res = await client.upload_document(new_ds_id, d["filename"], file_bytes)
                    new_rdoc_id = ""
                    if isinstance(up_res, list) and up_res and up_res[0].get("id"):
                        new_rdoc_id = up_res[0]["id"]
                    elif isinstance(up_res, dict) and up_res.get("id"):
                        new_rdoc_id = up_res["id"]

                    if new_rdoc_id:
                        uploaded_pairs.append((d["id"], new_rdoc_id))
                    else:
                        copy_errors.append(f"{d['doc_code']}: upload không trả về ID")
                except Exception as e:
                    copy_errors.append(f"{d['doc_code']}: {str(e)[:80]}")

            copied_docs = len(uploaded_pairs)
            if uploaded_pairs:
                status_after = "UNSTART"
                if payload.auto_parse:
                    try:
                        await client.parse_documents(new_ds_id, [rid for _, rid in uploaded_pairs])
                        parse_triggered = True
                        status_after = "RUNNING"
                    except Exception as e:
                        copy_errors.append(f"Auto-parse: {str(e)[:120]}")

                now2 = utc_now()
                with get_db() as conn:
                    for local_did, r_did in uploaded_pairs:
                        conn.execute(
                            """
                            UPDATE run_documents
                               SET ragflow_doc_id = ?, parse_status = ?, updated_at = ?
                             WHERE run_id = ? AND document_id = ?
                            """,
                            (r_did, status_after, now2, new_run_id, local_did),
                        )

            if copy_errors:
                warn_txt = "; ".join(copy_errors[:3])
                remote_warning = f"{remote_warning}; {warn_txt}".strip("; ")

        with get_db() as conn:
            new_row = dict(conn.execute("SELECT * FROM runs WHERE id = ?", (new_run_id,)).fetchone())
        return {
            "ok": True,
            "forked": True,
            "run": new_row,
            "remote_synced": remote_synced,
            "remote_warning": remote_warning,
            "copied_docs": copied_docs,
            "total_source_docs": len(source_docs),
            "parse_triggered": parse_triggered,
        }

    # Update current run in place
    if payload.index_patch and payload.sync_remote and run["ragflow_dataset_id"] and base_url and api_key:
        try:
            client = RAGFlowClient(base_url, api_key)
            await client.update_dataset(
                dataset_id=run["ragflow_dataset_id"],
                chunk_method=str(next_pc.get("chunk_method") or "general"),
                parser_config=next_pc,
            )
            remote_synced = True
        except Exception as e:
            remote_warning = str(e)

    with get_db() as conn:
        conn.execute(
            "UPDATE runs SET parser_config = ?, retrieval_config = ? WHERE id = ?",
            (json.dumps(next_pc, ensure_ascii=False), json.dumps(next_rc, ensure_ascii=False), run_id),
        )
        updated_row = dict(conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone())

    return {
        "ok": True,
        "forked": False,
        "run": updated_row,
        "remote_synced": remote_synced,
        "remote_warning": remote_warning,
    }
