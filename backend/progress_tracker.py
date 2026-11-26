import time
from contextvars import ContextVar
from typing import Any, Dict, Optional

CURRENT_TASK_ID: ContextVar[Optional[str]] = ContextVar("CURRENT_TASK_ID", default=None)

_TASKS: Dict[str, Dict[str, Any]] = {}
_MAX_AGE_SEC = 600.0
_MAX_TASKS = 500


def _prune_old() -> None:
    now = time.monotonic()
    stale = [k for k, v in _TASKS.items() if now - v.get("updated_at", now) > _MAX_AGE_SEC]
    for k in stale:
        _TASKS.pop(k, None)
    if len(_TASKS) >= _MAX_TASKS:
        oldest = sorted(_TASKS.items(), key=lambda kv: kv[1].get("updated_at", 0))
        for k, _ in oldest[: len(_TASKS) - _MAX_TASKS + 50]:
            _TASKS.pop(k, None)


def init_task(task_id: str) -> None:
    if not task_id:
        return
    if len(_TASKS) > 200:
        _prune_old()
    now = time.monotonic()
    _TASKS[task_id] = {
        "status": "running",
        "current": 0,
        "total": 0,
        "percent": 0,
        "stage": "",
        "detail": "",
        "has_real_progress": False,
        "started_at": now,
        "updated_at": now,
    }


def finish_task(task_id: Optional[str], status: str = "done") -> None:
    tid = task_id or CURRENT_TASK_ID.get()
    if not tid or tid not in _TASKS:
        return
    t = _TASKS[tid]
    t["status"] = status
    if status == "done":
        t["percent"] = 100
        if t["total"] > 0:
            t["current"] = t["total"]
    t["updated_at"] = time.monotonic()


def progress_stage(
    stage: str,
    detail: str = "",
    current: Optional[int] = None,
    total: Optional[int] = None,
    task_id: Optional[str] = None,
) -> None:
    tid = task_id or CURRENT_TASK_ID.get()
    if not tid:
        return
    t = _TASKS.get(tid)
    if not t:
        init_task(tid)
        t = _TASKS[tid]
    if stage:
        t["stage"] = stage
    if detail is not None:
        t["detail"] = detail
    if total is not None:
        t["total"] = max(0, int(total))
    if current is not None:
        t["current"] = max(0, int(current))
    if t["total"] > 0:
        t["has_real_progress"] = True
        t["percent"] = min(99, max(0, int(round((t["current"] / t["total"]) * 100))))
    t["updated_at"] = time.monotonic()


def progress_start(total: int, stage: str, detail: str = "", task_id: Optional[str] = None) -> None:
    progress_stage(stage=stage, detail=detail, current=0, total=total, task_id=task_id)


def progress_inc(
    step: int = 1,
    stage: Optional[str] = None,
    detail: Optional[str] = None,
    task_id: Optional[str] = None,
) -> None:
    tid = task_id or CURRENT_TASK_ID.get()
    if not tid:
        return
    t = _TASKS.get(tid)
    if not t:
        return
    t["current"] = int(t.get("current", 0)) + step
    if stage is not None:
        t["stage"] = stage
    if detail is not None:
        t["detail"] = detail
    total = int(t.get("total", 0))
    if total > 0:
        t["has_real_progress"] = True
        t["percent"] = min(99, max(0, int(round((t["current"] / total) * 100))))
    t["updated_at"] = time.monotonic()


def get_task_progress(task_id: str) -> Dict[str, Any]:
    t = _TASKS.get(task_id)
    if not t:
        return {
            "found": False,
            "status": "unknown",
            "current": 0,
            "total": 0,
            "percent": 0,
            "stage": "",
            "detail": "",
            "has_real_progress": False,
            "elapsed_ms": 0,
        }
    elapsed_ms = int((time.monotonic() - t["started_at"]) * 1000)
    return {
        "found": True,
        "status": t["status"],
        "current": t["current"],
        "total": t["total"],
        "percent": t["percent"],
        "stage": t["stage"],
        "detail": t["detail"],
        "has_real_progress": t["has_real_progress"],
        "elapsed_ms": elapsed_ms,
    }
