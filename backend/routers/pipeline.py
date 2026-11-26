import asyncio
import json
import os
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from database import (
    UPLOAD_DIR,
    get_bool_setting,
    get_current_account_key,
    get_db,
    get_int_setting,
    get_setting,
    utc_now,
)
from ragflow_client import RAGFlowClient, RAGFlowError

router = APIRouter(prefix="/api/pipeline", tags=["pipeline"])

# In-memory registry of active asyncio tasks & cancel events keyed by job_id
_ACTIVE_JOBS: Dict[int, asyncio.Task] = {}
_CANCEL_EVENTS: Dict[int, asyncio.Event] = {}
_MODELS_CACHE: Dict[str, Any] = {"ts": 0.0, "key": "", "data": None}
# In-memory demo jobs (negative IDs, never written to SQLite)
_DEMO_JOBS: Dict[int, Dict[str, Any]] = {}
_DEMO_SEQ = 0

STAGES = [
    ("create_dataset", "Tạo Dataset mới trên RAGFlow"),
    ("upload_docs", "Đồng bộ tài liệu nguồn"),
    ("ragflow_parse", "RAGFlow Parse & Chunking"),
    ("parsing_qc", "Chấm chất lượng Parsing"),
    ("chunking_qc", "Chấm chất lượng Chunking"),
    ("retrieval_qc", "Chấm Retrieval (Golden Dataset)"),
]


class CloneAndRunRequest(BaseModel):
    source_run_id: int
    name: str
    # RAGFlow dataset / parser / chunker config
    parser_id: str = "general"
    embedding_model: Optional[str] = None
    pagerank: int = 0
    parser_config: Dict[str, Any] = {}
    # Retrieval config
    top_k: int = 10
    similarity_threshold: float = 0.2
    vector_similarity_weight: float = 0.3
    rerank_id: str = ""
    rerank_top_k: int = 64
    keyword_enabled: bool = False
    # Auto-QC options
    parsing_mode: str = "deep"  # "deep" (Heuristic + AI) | "heuristic" (fast)
    retrieval_judge_engine: str = "llm"


def _get_ragflow_client() -> RAGFlowClient:
    base_url = get_setting("ragflow_base_url", "")
    api_key = get_setting("ragflow_api_key", "")
    if not base_url or not api_key:
        raise HTTPException(status_code=400, detail="Chưa cấu hình RAGFlow URL hoặc API Key trong Settings.")
    return RAGFlowClient(base_url, api_key)


def _init_stage_progress() -> Dict[str, Any]:
    return {
        key: {
            "label": label,
            "status": "pending",  # pending | running | done | failed | cancelled
            "detail": "",
            "progress": 0,
            "duration_ms": 0,
        }
        for key, label in STAGES
    }


def _update_job(
    job_id: int,
    *,
    status: Optional[str] = None,
    current_stage: Optional[str] = None,
    stage_progress: Optional[Dict[str, Any]] = None,
    target_run_id: Optional[int] = None,
    target_dataset_id: Optional[str] = None,
    error_message: Optional[str] = None,
    total_duration_ms: Optional[int] = None,
) -> None:
    sets = ["updated_at = ?"]
    params: List[Any] = [utc_now()]
    if status is not None:
        sets.append("status = ?")
        params.append(status)
    if current_stage is not None:
        sets.append("current_stage = ?")
        params.append(current_stage)
    if stage_progress is not None:
        sets.append("stage_progress_json = ?")
        params.append(json.dumps(stage_progress, ensure_ascii=False))
    if target_run_id is not None:
        sets.append("target_run_id = ?")
        params.append(target_run_id)
    if target_dataset_id is not None:
        sets.append("target_dataset_id = ?")
        params.append(target_dataset_id)
    if error_message is not None:
        sets.append("error_message = ?")
        params.append(error_message)
    if total_duration_ms is not None:
        sets.append("total_duration_ms = ?")
        params.append(int(total_duration_ms))
    params.append(job_id)
    with get_db() as conn:
        conn.execute(f"UPDATE pipeline_jobs SET {', '.join(sets)} WHERE id = ?", tuple(params))


def _serialize_job(row: Any) -> Dict[str, Any]:
    d = dict(row)
    try:
        d["stage_progress"] = json.loads(d.pop("stage_progress_json", "{}") or "{}")
    except Exception:
        d["stage_progress"] = {}
    try:
        d["config"] = json.loads(d.pop("config_json", "{}") or "{}")
    except Exception:
        d["config"] = {}
    d["stages_order"] = [k for k, _ in STAGES]
    return d


@router.get("/ragflow-models")
async def list_ragflow_models(force: bool = False):
    """Returns live embedding and rerank models configured on the connected RAGFlow server (cached 60s)."""
    base_url = get_setting("ragflow_base_url", "")
    api_key = get_setting("ragflow_api_key", "")
    if not base_url or not api_key:
        return {"embedding_models": [], "rerank_models": []}

    import hashlib
    cache_key = hashlib.sha256(f"{base_url.rstrip('/')}|{api_key.strip()}".encode("utf-8")).hexdigest()
    now_ts = time.monotonic()
    if (
        not force
        and _MODELS_CACHE["data"] is not None
        and _MODELS_CACHE["key"] == cache_key
        and (now_ts - float(_MODELS_CACHE["ts"])) < 60.0
    ):
        return _MODELS_CACHE["data"]

    from ragflow_client import get_shared_http_client

    client = get_shared_http_client()
    try:
        r = await client.get(
            f"{base_url.rstrip('/')}/api/v1/models",
            headers={"Authorization": f"Bearer {api_key.strip()}"},
            timeout=20.0,
        )
        if r.status_code >= 400:
            return {"embedding_models": [], "rerank_models": []}
        payload = r.json()
        data = payload.get("data") if isinstance(payload, dict) else []
        if not isinstance(data, list):
            data = []
    except Exception:
        return {"embedding_models": [], "rerank_models": []}

    emb_models: List[Dict[str, Any]] = []
    rerank_models: List[Dict[str, Any]] = []
    for m in data:
        if not isinstance(m, dict):
            continue
        mtype = str(m.get("model_type") or m.get("type") or "").lower()
        name = str(m.get("name") or m.get("llm_name") or "").strip()
        provider = str(m.get("provider") or m.get("provider_name") or m.get("fid") or "").strip()
        mid = str(m.get("model_id") or m.get("id") or name).strip()
        item = {
            "id": mid,
            "name": name,
            "provider": provider,
            "full_name": f"{name}@{provider}" if provider and "@" not in name else name,
        }
        if "embed" in mtype:
            emb_models.append(item)
        elif "rerank" in mtype:
            rerank_models.append(item)

    result = {"embedding_models": emb_models, "rerank_models": rerank_models}
    _MODELS_CACHE["ts"] = now_ts
    _MODELS_CACHE["key"] = cache_key
    _MODELS_CACHE["data"] = result
    return result


@router.get("/jobs")
def list_pipeline_jobs(source_run_id: Optional[int] = None, limit: int = 20):
    if get_bool_setting("demo_mode", False):
        # Return running & completed in-memory demo jobs (newest first; negative IDs: -2 is newer than -1)
        demo_jobs = [
            j for j in _DEMO_JOBS.values()
            if j.get("status") in ("queued", "running", "completed")
            and (source_run_id is None or j.get("source_run_id") == source_run_id)
        ]
        demo_jobs.sort(key=lambda x: x["id"])
        return demo_jobs[:limit]

    with get_db() as conn:
        if source_run_id is not None:
            rows = conn.execute(
                "SELECT * FROM pipeline_jobs WHERE source_run_id = ? ORDER BY id DESC LIMIT ?",
                (source_run_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM pipeline_jobs ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
    return [_serialize_job(r) for r in rows]


@router.get("/jobs/{job_id}")
def get_pipeline_job(job_id: int):
    if job_id < 0:
        demo = _DEMO_JOBS.get(job_id)
        if not demo:
            raise HTTPException(status_code=404, detail="Demo job không tồn tại")
        return demo
    with get_db() as conn:
        row = conn.execute("SELECT * FROM pipeline_jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Pipeline job không tồn tại")
    return _serialize_job(row)


@router.post("/jobs/{job_id}/cancel")
async def cancel_pipeline_job(job_id: int):
    ev = _CANCEL_EVENTS.get(job_id)
    if ev:
        ev.set()
    task = _ACTIVE_JOBS.get(job_id)
    if task and not task.done():
        task.cancel()
    if job_id < 0:
        demo = _DEMO_JOBS.get(job_id)
        if demo:
            demo["status"] = "cancelled"
            demo["error_message"] = "Đã hủy bởi người dùng."
            demo["updated_at"] = utc_now()
        return {"ok": True, "job_id": job_id, "status": "cancelled"}
    with get_db() as conn:
        row = conn.execute("SELECT * FROM pipeline_jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Pipeline job không tồn tại")
    # Best-effort stop RAGFlow parsing if dataset already created
    if row["target_dataset_id"]:
        try:
            client = _get_ragflow_client()
            docs = await client.list_documents(row["target_dataset_id"])
            doc_ids = [d["id"] for d in docs if isinstance(d, dict) and d.get("id")]
            if doc_ids:
                await client.stop_parsing(row["target_dataset_id"], doc_ids)
        except Exception:
            pass
    _update_job(job_id, status="cancelled", error_message="Đã hủy bởi người dùng.")
    return {"ok": True, "job_id": job_id, "status": "cancelled"}


@router.post("/clone-and-run")
async def start_clone_and_run(payload: CloneAndRunRequest):
    global _DEMO_SEQ
    if get_bool_setting("demo_mode", False):
        target_demo_id = get_int_setting("demo_candidate_run_id", 22)
        with get_db() as conn:
            t_run = conn.execute("SELECT * FROM runs WHERE id = ?", (target_demo_id,)).fetchone()
            if not t_run:
                t_run = conn.execute(
                    "SELECT * FROM runs WHERE id != ? ORDER BY id DESC LIMIT 1",
                    (payload.source_run_id,),
                ).fetchone()
        if not t_run:
            raise HTTPException(status_code=400, detail="Chưa có Run thứ 2 để chạy Demo Clone.")

        _DEMO_SEQ -= 1
        job_id = _DEMO_SEQ
        now = utc_now()
        job_obj: Dict[str, Any] = {
            "id": job_id,
            "source_run_id": payload.source_run_id,
            "target_run_id": int(t_run["id"]),
            "target_dataset_id": t_run["ragflow_dataset_id"] or "",
            "name": payload.name.strip() or t_run["name"],
            "status": "running",
            "current_stage": "create_dataset",
            "stage_progress": _init_stage_progress(),
            "stages_order": [k for k, _ in STAGES],
            "config": payload.model_dump(),
            "error_message": "",
            "total_duration_ms": 0,
            "created_at": now,
            "updated_at": now,
        }
        _DEMO_JOBS[job_id] = job_obj
        cancel_event = asyncio.Event()
        _CANCEL_EVENTS[job_id] = cancel_event
        _ACTIVE_JOBS[job_id] = asyncio.create_task(_execute_demo_clone_pipeline(job_id, int(t_run["id"]), cancel_event))
        return job_obj

    with get_db() as conn:
        src_run = conn.execute("SELECT * FROM runs WHERE id = ?", (payload.source_run_id,)).fetchone()
        if not src_run:
            raise HTTPException(status_code=404, detail="Baseline Run nguồn không tồn tại.")
        if not src_run["ragflow_dataset_id"]:
            raise HTTPException(status_code=400, detail="Baseline Run nguồn chưa gắn RAGFlow Dataset ID.")

    # Verify RAGFlow credentials early
    _get_ragflow_client()

    now = utc_now()
    stages = _init_stage_progress()
    cfg_dict = payload.model_dump()
    with get_db() as conn:
        cur = conn.execute(
            """
            INSERT INTO pipeline_jobs
                (source_run_id, name, status, current_stage, stage_progress_json, config_json, created_at, updated_at)
            VALUES (?, ?, 'queued', 'create_dataset', ?, ?, ?, ?)
            """,
            (
                payload.source_run_id,
                payload.name.strip() or f"Clone of #{payload.source_run_id}",
                json.dumps(stages, ensure_ascii=False),
                json.dumps(cfg_dict, ensure_ascii=False),
                now,
                now,
            ),
        )
        job_id = cur.lastrowid

    cancel_event = asyncio.Event()
    _CANCEL_EVENTS[job_id] = cancel_event
    task = asyncio.create_task(_execute_clone_pipeline(job_id, cancel_event))
    _ACTIVE_JOBS[job_id] = task

    with get_db() as conn:
        row = conn.execute("SELECT * FROM pipeline_jobs WHERE id = ?", (job_id,)).fetchone()
    return _serialize_job(row)


async def _execute_demo_clone_pipeline(job_id: int, target_run_id: int, cancel_event: asyncio.Event) -> None:
    """
    100% read-only fast simulation of the 6-stage clone pipeline for Demo Mode.
    Reads real counts from `target_run_id` (e.g., Run #22) and plays proportional loading steps (~14s total).
    Never writes to RAGFlow or SQLite.
    """
    t_total = time.perf_counter()
    job = _DEMO_JOBS.get(job_id)
    if not job:
        return
    stages = job["stage_progress"]

    # Read real stats from the pre-computed target run
    with get_db() as conn:
        doc_cnt = conn.execute("SELECT COUNT(*) FROM run_documents WHERE run_id = ?", (target_run_id,)).fetchone()[0] or 20
        chunk_cnt = conn.execute("SELECT COUNT(*) FROM chunks WHERE run_id = ?", (target_run_id,)).fetchone()[0] or 641
        unit_pass = conn.execute("SELECT COUNT(*) FROM parsing_units WHERE run_id = ? AND verdict = 'PASS'", (target_run_id,)).fetchone()[0] or 248
        unit_fail = conn.execute("SELECT COUNT(*) FROM parsing_units WHERE run_id = ? AND verdict = 'FAIL'", (target_run_id,)).fetchone()[0] or 80
        unit_tot = conn.execute("SELECT COUNT(*) FROM parsing_units WHERE run_id = ?", (target_run_id,)).fetchone()[0] or (unit_pass + unit_fail)
        samp_cnt = conn.execute("SELECT COUNT(*) FROM chunk_evaluations WHERE run_id = ? AND is_sampled = 1", (target_run_id,)).fetchone()[0] or 196
        rr = conn.execute("SELECT id FROM retrieval_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1", (target_run_id,)).fetchone()
        rr_id = rr["id"] if rr else 25
        tc_cnt = conn.execute("SELECT COUNT(DISTINCT testcase_id) FROM retrieval_results WHERE retrieval_run_id = ?", (rr_id,)).fetchone()[0] or 48

    def _upd(sk: str, st: str, detail: str, prog: int, dur_ms: int = 0):
        stages[sk]["status"] = st
        stages[sk]["detail"] = detail
        stages[sk]["progress"] = prog
        if dur_ms:
            stages[sk]["duration_ms"] = dur_ms
        job["current_stage"] = sk
        job["total_duration_ms"] = int((time.perf_counter() - t_total) * 1000)
        job["updated_at"] = utc_now()

    async def _wait(sec: float):
        if cancel_event.is_set():
            raise asyncio.CancelledError()
        await asyncio.sleep(sec)
        if cancel_event.is_set():
            raise asyncio.CancelledError()

    try:
        # 1. Create dataset (~0.6s)
        t0 = time.perf_counter()
        _upd("create_dataset", "running", "Đang khởi tạo Dataset trên RAGFlow...", 40)
        await _wait(0.6)
        _upd("create_dataset", "done", f"Đã tạo Dataset {job['name']} (Run #{target_run_id})", 100, int((time.perf_counter() - t0) * 1000))

        # 2. Upload docs (~1.8s)
        t0 = time.perf_counter()
        for frac in (0.3, 0.7, 1.0):
            n = max(1, int(round(doc_cnt * frac)))
            _upd("upload_docs", "running", f"Đã đẩy {n}/{doc_cnt} tài liệu...", min(99, int(frac * 100)))
            await _wait(0.6)
        _upd("upload_docs", "done", f"Đã đồng bộ {doc_cnt}/{doc_cnt} tài liệu", 100, int((time.perf_counter() - t0) * 1000))

        # 3. RAGFlow Parse (~4.5s — longest step, realistic pacing)
        t0 = time.perf_counter()
        for frac in (0.15, 0.35, 0.6, 0.85, 0.96):
            n = max(1, int(round(doc_cnt * frac)))
            _upd("ragflow_parse", "running", f"Đã parse xong {n}/{doc_cnt} tài liệu...", int(frac * 100))
            await _wait(0.9)
        _upd("ragflow_parse", "done", f"Hoàn tất parse {doc_cnt}/{doc_cnt} tài liệu", 100, int((time.perf_counter() - t0) * 1000))

        # 4. Parsing QC (~3.0s)
        t0 = time.perf_counter()
        _upd("parsing_qc", "running", "Đang kéo chunks & trích xuất Parsing units...", 35)
        await _wait(1.0)
        _upd("parsing_qc", "running", f"Đang chạy Vision OCR & AI chấm {unit_tot} units...", 75)
        await _wait(2.0)
        _upd("parsing_qc", "done", f"AI chấm xong {unit_tot} units (Pass {unit_pass}, Fail {unit_fail})", 100, int((time.perf_counter() - t0) * 1000))

        # 5. Chunking QC (~2.2s)
        t0 = time.perf_counter()
        _upd("chunking_qc", "running", f"Đang lấy mẫu Cochran ({samp_cnt}/{chunk_cnt} chunks) & AI chấm...", 55)
        await _wait(2.2)
        _upd("chunking_qc", "done", f"Mẫu {samp_cnt}/{chunk_cnt} chunks · Hoàn tất đánh giá", 100, int((time.perf_counter() - t0) * 1000))

        # 6. Retrieval QC (~2.5s)
        t0 = time.perf_counter()
        _upd("retrieval_qc", "running", f"Đang chạy {tc_cnt} câu Golden Dataset & chấm LLM Batch...", 50)
        await _wait(2.5)
        _upd("retrieval_qc", "done", f"Hoàn tất {tc_cnt} câu Golden (RR #{rr_id})", 100, int((time.perf_counter() - t0) * 1000))

        job["status"] = "completed"
        job["current_stage"] = "completed"
        job["total_duration_ms"] = int((time.perf_counter() - t_total) * 1000)
        job["updated_at"] = utc_now()
    except asyncio.CancelledError:
        for k in stages:
            if stages[k]["status"] == "running":
                stages[k]["status"] = "cancelled"
        job["status"] = "cancelled"
        job["error_message"] = "Đã hủy bởi người dùng."
    finally:
        _ACTIVE_JOBS.pop(job_id, None)
        _CANCEL_EVENTS.pop(job_id, None)


async def _execute_clone_pipeline(job_id: int, cancel_event: asyncio.Event) -> None:
    t_total = time.perf_counter()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM pipeline_jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            return
        cfg = json.loads(row["config_json"] or "{}")
        stages = json.loads(row["stage_progress_json"] or "{}") or _init_stage_progress()
        source_run_id = int(row["source_run_id"])
        src_run = conn.execute("SELECT * FROM runs WHERE id = ?", (source_run_id,)).fetchone()

    def _check_cancel():
        if cancel_event.is_set():
            raise asyncio.CancelledError("Cancelled by user")

    def _mark(stage_key: str, st: str, detail: str = "", progress: int = 0, dur_ms: int = 0):
        stages[stage_key]["status"] = st
        if detail:
            stages[stage_key]["detail"] = detail
        stages[stage_key]["progress"] = progress
        if dur_ms:
            stages[stage_key]["duration_ms"] = int(dur_ms)
        _update_job(
            job_id,
            status="running",
            current_stage=stage_key,
            stage_progress=stages,
            total_duration_ms=int((time.perf_counter() - t_total) * 1000),
        )

    target_run_id: Optional[int] = None
    target_dataset_id: str = ""

    try:
        client = _get_ragflow_client()
        acct = get_current_account_key()
        run_name = (cfg.get("name") or f"Clone #{job_id}").strip()
        parser_id = (cfg.get("parser_id") or "general").strip()
        embedding_model = (cfg.get("embedding_model") or "").strip() or None
        pagerank = int(cfg.get("pagerank") or 0)
        parser_config = cfg.get("parser_config") or {}

        # ---------------- STAGE 1: CREATE DATASET ----------------
        _check_cancel()
        t0 = time.perf_counter()
        _mark("create_dataset", "running", "Đang khởi tạo Dataset trên RAGFlow...", 20)

        # Ensure unique dataset name on RAGFlow
        ds_name = f"{run_name} [QC-{job_id}]"
        created_ds = await client.create_dataset(
            name=ds_name,
            chunk_method=parser_id,
            embedding_model=embedding_model,
            parser_config=parser_config or None,
        )
        target_dataset_id = str((created_ds or {}).get("id") or "")
        if not target_dataset_id:
            raise RuntimeError("RAGFlow không trả về dataset_id sau khi tạo Dataset.")
        _update_job(job_id, target_dataset_id=target_dataset_id)

        # Apply pagerank & exact parser_config via update_dataset to be 100% certain
        try:
            await client.update_dataset(
                target_dataset_id,
                chunk_method=parser_id,
                parser_config=parser_config or None,
                pagerank=pagerank,
            )
        except Exception:
            pass

        # Create local Run row (ensure unique name since runs.name is UNIQUE)
        ret_cfg_snapshot = {
            "top_k": int(cfg.get("top_k") or 10),
            "similarity_threshold": float(cfg.get("similarity_threshold") if cfg.get("similarity_threshold") is not None else 0.2),
            "vector_similarity_weight": float(cfg.get("vector_similarity_weight") if cfg.get("vector_similarity_weight") is not None else 0.3),
            "rerank_id": str(cfg.get("rerank_id") or ""),
            "rerank_top_k": int(cfg.get("rerank_top_k") or 64),
            "keyword_enabled": bool(cfg.get("keyword_enabled", False)),
        }
        with get_db() as conn:
            from database import resolve_golden_run_id
            golden_owner = resolve_golden_run_id(conn, source_run_id)
            final_run_name = run_name
            if conn.execute("SELECT 1 FROM runs WHERE name = ?", (final_run_name,)).fetchone():
                final_run_name = f"{run_name} (#{job_id})"
            cur = conn.execute(
                """
                INSERT INTO runs
                    (name, description, is_baseline, ragflow_dataset_id, ragflow_dataset_name, parser_config, retrieval_config, status, account_key, golden_source_run_id, created_at)
                VALUES (?, ?, 0, ?, ?, ?, ?, 'READY', ?, ?, ?)
                """,
                (
                    final_run_name,
                    f"Clone từ Run #{source_run_id} (Job #{job_id})",
                    target_dataset_id,
                    ds_name,
                    json.dumps(parser_config, ensure_ascii=False),
                    json.dumps(ret_cfg_snapshot, ensure_ascii=False),
                    acct,
                    golden_owner,
                    utc_now(),
                ),
            )
            target_run_id = cur.lastrowid

        _update_job(job_id, target_run_id=target_run_id, target_dataset_id=target_dataset_id)
        _mark(
            "create_dataset",
            "done",
            f"Đã tạo Dataset {ds_name} (Run #{target_run_id})",
            100,
            int((time.perf_counter() - t0) * 1000),
        )

        # ---------------- STAGE 2: UPLOAD DOCS ----------------
        _check_cancel()
        t0 = time.perf_counter()
        _mark("upload_docs", "running", "Đang thu thập danh sách tài liệu từ Baseline...", 5)

        with get_db() as conn:
            src_docs = conn.execute(
                """
                SELECT d.id, d.doc_code, d.filename, d.file_path, rd.ragflow_doc_id
                FROM run_documents rd
                JOIN documents d ON d.id = rd.document_id
                WHERE rd.run_id = ?
                ORDER BY d.doc_code
                """,
                (source_run_id,),
            ).fetchall()
            src_docs_list = [dict(r) for r in src_docs]

        src_dataset_id = src_run["ragflow_dataset_id"] if src_run else ""
        if not src_docs_list and src_dataset_id:
            remote_src_docs = await client.list_documents(src_dataset_id)
            for idx, rdoc in enumerate(remote_src_docs):
                src_docs_list.append(
                    {
                        "id": None,
                        "doc_code": f"DOC{idx + 1:02d}",
                        "filename": rdoc.get("name") or f"doc_{idx + 1}",
                        "file_path": "",
                        "ragflow_doc_id": rdoc.get("id") or "",
                    }
                )

        if not src_docs_list:
            raise RuntimeError("Baseline Run không có tài liệu nào để nhân bản.")

        uploaded_doc_ids: List[str] = []
        upload_sem = asyncio.Semaphore(3)
        completed_uploads = 0
        total_docs = len(src_docs_list)

        async def _transfer_one(doc: Dict[str, Any]):
            nonlocal completed_uploads
            _check_cancel()
            async with upload_sem:
                fp = doc.get("file_path") or ""
                fname = os.path.basename(doc.get("filename") or f"{doc.get('doc_code', 'doc')}.bin")
                file_bytes: Optional[bytes] = None
                if fp and os.path.exists(fp):
                    with open(fp, "rb") as f:
                        file_bytes = f.read()
                elif src_dataset_id and doc.get("ragflow_doc_id"):
                    file_bytes = await client.download_document(src_dataset_id, doc["ragflow_doc_id"])
                    # Cache locally for future runs & parsing extraction
                    save_path = os.path.join(UPLOAD_DIR, f"{doc.get('doc_code', 'DOC')}_{fname}")
                    with open(save_path, "wb") as f:
                        f.write(file_bytes)
                    if doc.get("id"):
                        with get_db() as conn:
                            conn.execute("UPDATE documents SET file_path = ? WHERE id = ?", (save_path, doc["id"]))
                if not file_bytes:
                    return None
                res = await client.upload_document(target_dataset_id, fname, file_bytes)
                completed_uploads += 1
                pct = min(99, int(completed_uploads * 100 / max(total_docs, 1)))
                _mark("upload_docs", "running", f"Đã đẩy {completed_uploads}/{total_docs} tài liệu...", pct)
                if isinstance(res, list) and res and isinstance(res[0], dict):
                    return res[0].get("id")
                if isinstance(res, dict):
                    return res.get("id")
                return None

        results = await asyncio.gather(*(_transfer_one(d) for d in src_docs_list))
        uploaded_doc_ids = [rid for rid in results if rid]
        if not uploaded_doc_ids:
            # Fallback list from remote dataset
            rdocs = await client.list_documents(target_dataset_id)
            uploaded_doc_ids = [d["id"] for d in rdocs if isinstance(d, dict) and d.get("id")]

        if not uploaded_doc_ids:
            raise RuntimeError("Không thể tải tài liệu lên Dataset mới.")

        _mark(
            "upload_docs",
            "done",
            f"Đã đồng bộ {len(uploaded_doc_ids)}/{total_docs} tài liệu",
            100,
            int((time.perf_counter() - t0) * 1000),
        )

        # ---------------- STAGE 3: RAGFLOW PARSE ----------------
        _check_cancel()
        t0 = time.perf_counter()
        _mark("ragflow_parse", "running", f"Đang kích hoạt RAGFlow parse {len(uploaded_doc_ids)} tài liệu...", 5)

        await client.parse_documents(target_dataset_id, uploaded_doc_ids)

        from routers.workspace import _extract_remote_doc_meta

        poll_interval = 2.0
        max_wait_sec = 3600  # 60 minutes hard cap
        consecutive_poll_errs = 0
        while True:
            _check_cancel()
            await asyncio.sleep(poll_interval)
            poll_interval = min(5.0, poll_interval + 0.5)

            try:
                rdocs = await client.list_documents(target_dataset_id)
                consecutive_poll_errs = 0
            except Exception as poll_err:
                consecutive_poll_errs += 1
                if consecutive_poll_errs >= 5:
                    raise RuntimeError(f"Mất kết nối RAGFlow khi theo dõi tiến độ parse: {poll_err}")
                continue

            done_cnt = 0
            fail_cnt = 0
            total_prog = 0.0
            for rd in rdocs:
                st, prog, _cc, _tc, _dur = _extract_remote_doc_meta(rd)
                if st == "DONE":
                    done_cnt += 1
                    total_prog += 1.0
                elif st in ("FAIL", "CANCEL"):
                    fail_cnt += 1
                    total_prog += 1.0
                else:
                    total_prog += max(0.0, min(0.99, prog))

            total_r = max(len(rdocs), 1)
            pct = min(99, int((total_prog / total_r) * 100))
            _mark(
                "ragflow_parse",
                "running",
                f"Đã parse xong {done_cnt}/{total_r} tài liệu" + (f" ({fail_cnt} lỗi)" if fail_cnt else "..."),
                pct,
            )

            if (done_cnt + fail_cnt) >= total_r:
                break
            if (time.perf_counter() - t0) > max_wait_sec:
                raise RuntimeError("RAGFlow parse quá thời gian chờ (60 phút).")

        _mark(
            "ragflow_parse",
            "done",
            f"Hoàn tất parse {done_cnt}/{len(rdocs)} tài liệu" + (f" ({fail_cnt} lỗi)" if fail_cnt else ""),
            100,
            int((time.perf_counter() - t0) * 1000),
        )

        # ---------------- STAGE 4: SYNC + PARSING QC ----------------
        _check_cancel()
        t0 = time.perf_counter()
        parsing_mode = (cfg.get("parsing_mode") or "deep").strip().lower()
        _mark("parsing_qc", "running", "Đang kéo chunks từ RAGFlow về SQLite...", 15)

        from routers.workspace import sync_run_from_ragflow
        from routers.parsing import (
            auto_extract_units,
            bulk_approve_fail,
            bulk_approve_pass,
            BulkApprovePayload,
            BulkFailPayload,
            run_batch_llm_judge_parsing,
            run_batch_vision_ocr_for_run,
        )

        # Pass a fresh BackgroundTasks that we intentionally don't execute, because Stage 4 runs extraction synchronously below
        await sync_run_from_ragflow(target_run_id, BackgroundTasks(), pull_chunks=True, force=True)
        _check_cancel()
        _mark("parsing_qc", "running", "Đang trích xuất & căn chỉnh Parsing units...", 40)

        with get_db() as conn:
            doc_rows = conn.execute(
                "SELECT DISTINCT d.id FROM documents d JOIN run_documents rd ON rd.document_id = d.id WHERE rd.run_id = ?",
                (target_run_id,),
            ).fetchall()

        extracted_total = 0
        for idx, drow in enumerate(doc_rows):
            _check_cancel()
            try:
                res = await auto_extract_units(target_run_id, drow["id"], max_units=25)
                extracted_total += int(res.get("extracted_units", 0))
            except Exception:
                continue
            pct = 40 + int(((idx + 1) / max(len(doc_rows), 1)) * 25)
            _mark("parsing_qc", "running", f"Đã trích xuất {idx + 1}/{len(doc_rows)} tài liệu ({extracted_total} units)...", pct)

        if parsing_mode == "heuristic":
            _mark("parsing_qc", "running", "Đang áp dụng chấm Heuristic tự động...", 80)
            from routers.parsing import BulkFailItem, list_parsing_units

            try:
                units = list_parsing_units(target_run_id)
                pass_ids: List[int] = []
                fail_items: List[BulkFailItem] = []
                partial_ids: List[int] = []
                for u in units:
                    if u.get("verdict") != "UNRATED":
                        continue
                    mc = (u.get("matched_chunks") or [{}])[0]
                    al = mc.get("alignment") or {}
                    sv = str(al.get("suggested_verdict") or "").upper()
                    if sv == "PASS":
                        pass_ids.append(int(u["id"]))
                    elif sv == "FAIL":
                        fail_items.append(
                            BulkFailItem(
                                unit_id=int(u["id"]),
                                error_codes=list(al.get("suggested_error_codes") or []),
                                notes="Auto-heuristic",
                            )
                        )
                    elif sv == "PARTIAL":
                        partial_ids.append(int(u["id"]))
                if pass_ids:
                    bulk_approve_pass(target_run_id, BulkApprovePayload(unit_ids=pass_ids, force=True))
                if fail_items:
                    bulk_approve_fail(target_run_id, BulkFailPayload(items=fail_items))
                if partial_ids:
                    with get_db() as conn:
                        ph = ",".join("?" for _ in partial_ids)
                        conn.execute(
                            f"UPDATE parsing_units SET verdict = 'PARTIAL', judge_source = 'RULE', updated_at = ? WHERE run_id = ? AND id IN ({ph})",
                            [utc_now(), target_run_id, *partial_ids],
                        )
                p_detail = f"Heuristic xong: {len(pass_ids)} Pass, {len(partial_ids)} Partial, {len(fail_items)} Fail"
            except Exception as he:
                p_detail = f"Heuristic cảnh báo: {str(he)[:120]}"
        else:
            _mark("parsing_qc", "running", "Đang chạy Vision OCR & AI chấm các trang Parsing...", 72)
            try:
                await run_batch_vision_ocr_for_run(target_run_id, update_sync_status=False)
            except Exception:
                pass
            _check_cancel()
            llm_res = await run_batch_llm_judge_parsing(target_run_id, only_unrated=True, update_sync_status=False)
            p_detail = f"AI chấm xong {llm_res.get('judged', 0)} units (Pass {llm_res.get('pass_count', 0)}, Fail {llm_res.get('fail_count', 0)})"

        _mark("parsing_qc", "done", p_detail, 100, int((time.perf_counter() - t0) * 1000))

        # ---------------- STAGE 5: CHUNKING QC ----------------
        _check_cancel()
        t0 = time.perf_counter()
        _mark("chunking_qc", "running", "Đang lấy mẫu phân tầng (Cochran) & AI chấm Chunking...", 30)

        from routers.chunking import auto_sample_chunks

        c_res = await auto_sample_chunks(target_run_id)
        c_detail = f"Mẫu {c_res.get('sampled_chunks', 0)}/{c_res.get('total_chunks', 0)} chunks · AI chấm {c_res.get('llm_judged', 0)}"
        _mark("chunking_qc", "done", c_detail, 100, int((time.perf_counter() - t0) * 1000))

        # ---------------- STAGE 6: RETRIEVAL QC (GOLDEN DATASET) ----------------
        _check_cancel()
        t0 = time.perf_counter()
        _mark("retrieval_qc", "running", "Đang chạy bộ Golden Dataset & chấm LLM Batch...", 25)

        from routers.retrieval import execute_retrieval_benchmark, RetrievalRunCreate

        ret_payload = RetrievalRunCreate(
            run_id=target_run_id,
            name=f"[GỐC] {run_name}",
            top_k=int(cfg.get("top_k") or 10),
            rerank_candidates=int(cfg.get("rerank_top_k") or 32),
            similarity_threshold=float(cfg.get("similarity_threshold") if cfg.get("similarity_threshold") is not None else 0.2),
            vector_similarity_weight=float(cfg.get("vector_similarity_weight") if cfg.get("vector_similarity_weight") is not None else 0.3),
            rerank_id=str(cfg.get("rerank_id") or ""),
            keyword_enabled=bool(cfg.get("keyword_enabled", False)),
            use_llm=True,
            judge_engine=str(cfg.get("retrieval_judge_engine") or "llm"),
            bypass_cache=False,
        )
        r_res = await execute_retrieval_benchmark(ret_payload)
        rr_id = r_res.get("retrieval_run_id")
        if rr_id:
            with get_db() as conn:
                conn.execute("UPDATE retrieval_runs SET is_baseline_rr = 1 WHERE id = ?", (rr_id,))

        tc_done = r_res.get("total_testcases") or r_res.get("testcases_executed") or 0
        r_detail = f"Hoàn tất {tc_done} câu Golden (RR #{rr_id})"
        _mark("retrieval_qc", "done", r_detail, 100, int((time.perf_counter() - t0) * 1000))

        _update_job(
            job_id,
            status="completed",
            current_stage="completed",
            stage_progress=stages,
            total_duration_ms=int((time.perf_counter() - t_total) * 1000),
        )

    except asyncio.CancelledError:
        for k in stages:
            if stages[k]["status"] == "running":
                stages[k]["status"] = "cancelled"
        _update_job(
            job_id,
            status="cancelled",
            stage_progress=stages,
            error_message="Đã hủy bởi người dùng.",
            total_duration_ms=int((time.perf_counter() - t_total) * 1000),
        )
    except Exception as e:
        err_msg = str(e)
        for k in stages:
            if stages[k]["status"] == "running":
                stages[k]["status"] = "failed"
                stages[k]["detail"] = err_msg[:200]
        _update_job(
            job_id,
            status="failed",
            stage_progress=stages,
            error_message=err_msg[:500],
            total_duration_ms=int((time.perf_counter() - t_total) * 1000),
        )
    finally:
        _ACTIVE_JOBS.pop(job_id, None)
        _CANCEL_EVENTS.pop(job_id, None)
