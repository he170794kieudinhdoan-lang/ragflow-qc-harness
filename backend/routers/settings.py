from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any, Dict
from database import get_all_settings, set_setting, get_setting, get_db
from ragflow_client import RAGFlowClient, RAGFlowError
from metrics import PARSING_ERROR_CATALOG, CHUNKING_ERROR_CATALOG, RETRIEVAL_ERROR_CATALOG

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsPayload(BaseModel):
    settings: Dict[str, Any]


@router.get("")
def read_settings():
    data = get_all_settings()
    # Mask API keys slightly for display safety while returning a boolean flag
    masked = dict(data)
    masked["has_ragflow_key"] = bool(data.get("ragflow_api_key", "").strip())
    masked["has_llm_key"] = bool(data.get("llm_api_key", "").strip())
    return {
        "settings": masked,
        "catalogs": {
            "parsing_errors": PARSING_ERROR_CATALOG,
            "chunking_errors": CHUNKING_ERROR_CATALOG,
            "retrieval_errors": RETRIEVAL_ERROR_CATALOG,
        },
    }


@router.put("")
def update_settings(payload: SettingsPayload):
    old_api_key = get_setting("ragflow_api_key", "").strip()
    old_base_url = get_setting("ragflow_base_url", "").strip()

    for k, v in payload.settings.items():
        if k in ("has_ragflow_key", "has_llm_key"):
            continue
        set_setting(k, str(v))

    new_api_key = str(payload.settings.get("ragflow_api_key", old_api_key)).strip()
    new_base_url = str(payload.settings.get("ragflow_base_url", old_base_url)).strip()

    account_changed = (
        (bool(old_api_key) and new_api_key != old_api_key)
        or (bool(old_base_url) and new_base_url != old_base_url)
    )

    workspace_cleared = False
    if account_changed:
        with get_db() as conn:
            conn.execute("DELETE FROM runs")
            conn.execute("DELETE FROM documents WHERE file_path = ''")
        workspace_cleared = True

    return {"ok": True, "workspace_cleared": workspace_cleared}


@router.post("/test-ragflow")
async def test_ragflow_connection():
    base_url = get_setting("ragflow_base_url", "")
    api_key = get_setting("ragflow_api_key", "")
    if not base_url or not api_key:
        raise HTTPException(status_code=400, detail="Vui lòng nhập RAGFlow Base URL và API Key trước.")
    client = RAGFlowClient(base_url, api_key)
    try:
        res = await client.test_connection()
        return res
    except RAGFlowError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Không kết nối được tới RAGFlow: {e}")
