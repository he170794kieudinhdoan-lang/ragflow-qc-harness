from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any, Dict
from database import DEFAULT_SETTINGS, get_all_settings, set_setting, get_setting, get_db
from ragflow_client import RAGFlowClient, RAGFlowError
from llm_client import (
    LLMError,
    resolve_systemone_credentials,
    systemone_requires_key,
    test_llm_connection,
    test_system_one_connection,
)
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
    masked["has_vision_key"] = bool(data.get("vision_api_key", "").strip())
    _, resolved_sys1_key, _, _ = resolve_systemone_credentials(get_setting)
    sys1_url = data.get("systemone_base_url", "").strip()
    masked["has_systemone_key"] = bool(resolved_sys1_key) or (bool(sys1_url) and not systemone_requires_key(sys1_url))
    return {
        "settings": masked,
        "defaults": DEFAULT_SETTINGS,
        "catalogs": {
            "parsing_errors": PARSING_ERROR_CATALOG,
            "chunking_errors": CHUNKING_ERROR_CATALOG,
            "retrieval_errors": RETRIEVAL_ERROR_CATALOG,
        },
    }


@router.put("")
def update_settings(payload: SettingsPayload):
    old_api_key = get_setting("ragflow_api_key", "").strip()
    old_base_url = get_setting("ragflow_base_url", "").strip().rstrip("/")

    for k, v in payload.settings.items():
        if k in ("has_ragflow_key", "has_llm_key", "has_vision_key", "has_systemone_key"):
            continue
        value = str(v)
        if k == "ragflow_base_url":
            value = value.strip().rstrip("/")
        set_setting(k, value)

    new_api_key = str(payload.settings.get("ragflow_api_key", old_api_key)).strip()
    new_base_url = str(payload.settings.get("ragflow_base_url", old_base_url)).strip().rstrip("/")

    # Changing the connection target never deletes local snapshots implicitly: silently wiping
    # runs was what made the selected dataset jump to another one after saving settings.
    account_changed = (
        (bool(old_api_key) and new_api_key != old_api_key)
        or (bool(old_base_url) and new_base_url != old_base_url)
    )

    return {"ok": True, "workspace_cleared": False, "account_changed": account_changed}


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


@router.post("/test-llm")
async def test_llm_endpoint():
    base_url = get_setting("llm_base_url", "").strip()
    api_key = get_setting("llm_api_key", "").strip()
    model = get_setting("llm_model", "").strip()
    if not base_url or not model:
        raise HTTPException(status_code=400, detail="Vui lòng nhập LLM Base URL và tên Model trước.")
    try:
        return await test_llm_connection(base_url, api_key, model)
    except LLMError as e:
        raise HTTPException(status_code=400, detail=f"Lỗi kết nối LLM: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Không gọi được tới LLM: {e}")


@router.post("/test-vision")
async def test_vision_endpoint():
    base_url = get_setting("vision_base_url", "").strip() or get_setting("llm_base_url", "").strip()
    api_key = get_setting("vision_api_key", "").strip() or get_setting("llm_api_key", "").strip()
    model = get_setting("vision_model", "").strip() or get_setting("llm_model", "").strip()
    if not base_url or not model:
        raise HTTPException(status_code=400, detail="Vui lòng nhập Vision Base URL và tên Vision Model trước.")
    try:
        return await test_llm_connection(base_url, api_key, model)
    except LLMError as e:
        raise HTTPException(status_code=400, detail=f"Lỗi kết nối Vision LLM: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Không gọi được tới Vision LLM: {e}")


@router.post("/test-systemone")
async def test_systemone_endpoint():
    base_url, api_key, model, _ = resolve_systemone_credentials(get_setting)
    if not base_url or not model or (systemone_requires_key(base_url) and not api_key):
        raise HTTPException(
            status_code=400,
            detail="Vui lòng cấu hình System One Base URL, Model (và API Key nếu dùng Vercel/TypeSafe Cloud).",
        )
    try:
        return await test_system_one_connection(base_url, api_key, model)
    except LLMError as e:
        raise HTTPException(status_code=400, detail=f"Lỗi kết nối Jev System One: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Không gọi được tới Jev System One: {e}")
