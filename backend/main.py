import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from database import get_db, init_db, utc_now
from progress_tracker import CURRENT_TASK_ID, finish_task, get_task_progress, init_task
from ragflow_client import close_shared_http_client
from routers import settings, workspace, parsing, chunking, retrieval, analytics, pipeline


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    # Recover any pipeline_jobs left stuck in queued/running across server restart
    try:
        with get_db() as conn:
            conn.execute(
                """
                UPDATE pipeline_jobs
                SET status = 'failed',
                    error_message = 'Server khởi động lại khi tác vụ đang chạy.',
                    updated_at = ?
                WHERE status IN ('queued', 'running')
                """,
                (utc_now(),),
            )
    except Exception:
        pass
    try:
        yield
    finally:
        active = list(pipeline._ACTIVE_JOBS.values())
        for task in active:
            if not task.done():
                task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)
        pipeline._ACTIVE_JOBS.clear()
        await close_shared_http_client()


app = FastAPI(title="RAGFlow QC Harness API", version="0.1.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def progress_task_middleware(request: Request, call_next):
    task_id = (request.headers.get("x-progress-task-id") or "").strip()
    if not task_id:
        return await call_next(request)
    init_task(task_id)
    token = CURRENT_TASK_ID.set(task_id)
    status = "done"
    try:
        resp = await call_next(request)
        if resp.status_code >= 400:
            status = "error"
        return resp
    except Exception:
        status = "error"
        raise
    finally:
        finish_task(task_id, status=status)
        CURRENT_TASK_ID.reset(token)


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "ragflow-qc-harness"}


@app.get("/api/progress/{task_id}")
def read_task_progress(task_id: str):
    return get_task_progress(task_id)


app.include_router(settings.router)
app.include_router(workspace.router)
app.include_router(parsing.router)
app.include_router(chunking.router)
app.include_router(retrieval.router)
app.include_router(analytics.router)
app.include_router(pipeline.router)
