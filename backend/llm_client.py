import base64
import json
import re
from typing import Any, Dict, Tuple
from ragflow_client import get_shared_http_client


class LLMError(Exception):
    pass


def _extract_json(text: str) -> Dict[str, Any]:
    s = (text or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    try:
        data = json.loads(s)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    m = re.search(r"\{[\s\S]*\}", s)
    if m:
        try:
            data = json.loads(m.group(0))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    raise LLMError(f"LLM không trả về JSON hợp lệ: {s[:160]}")


async def call_llm_json(
    base_url: str,
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    timeout: float = 45.0,
) -> Dict[str, Any]:
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"

    body: Dict[str, Any] = {
        "model": model.strip(),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
    }

    client = get_shared_http_client()
    r = await client.post(url, headers=headers, json=body, timeout=timeout)
    if r.status_code >= 400:
        raise LLMError(f"HTTP {r.status_code}: {r.text[:260]}")
    payload = r.json()
    choices = payload.get("choices") or []
    if not choices:
        raise LLMError("LLM trả về phản hồi rỗng.")
    content = choices[0].get("message", {}).get("content", "")
    return _extract_json(content)


async def test_llm_connection(base_url: str, api_key: str, model: str) -> Dict[str, Any]:
    res = await call_llm_json(
        base_url=base_url,
        api_key=api_key,
        model=model,
        system_prompt="You are a ping responder. Reply strictly with JSON: {\"ok\": true}",
        user_prompt="ping",
        timeout=25.0,
    )
    return {"ok": True, "model": model, "reply": res}


async def llm_generate_question(
    base_url: str,
    api_key: str,
    model: str,
    chunk_text: str,
    filename: str,
) -> Tuple[str, str, str, str]:
    """
    Returns (input_question, question_class, intent_type, reference_context).
    """
    sys_prompt = (
        "Bạn là chuyên gia QC hệ thống RAG tiếng Việt. "
        "Từ đoạn tài liệu cung cấp, hãy tạo 1 câu hỏi tự nhiên giống người dùng thật hỏi "
        "(diễn đạt tự nhiên, không sao chép nguyên văn máy móc) để kiểm thử khả năng tìm kiếm (Retrieval). "
        "Trả về DUY NHẤT JSON với đúng 4 khóa:\n"
        '{"question": "...", "question_class": "Local|Global|Multi-hop", '
        '"intent_type": "Factoid|Keyword|Table|Procedural", "reference_context": "đoạn trích ngắn 1-3 câu nguyên văn chứa đáp án từ văn bản gốc"}'
    )
    user_prompt = f"Tên tài liệu: {filename}\n\nNội dung đoạn trích:\n{chunk_text[:1800]}"
    data = await call_llm_json(base_url, api_key, model, sys_prompt, user_prompt)
    q = str(data.get("question", "")).strip()
    q_class = str(data.get("question_class", "Local")).strip()
    if q_class not in ("Local", "Global", "Multi-hop"):
        q_class = "Local"
    intent = str(data.get("intent_type", "Factoid")).strip()
    ref = str(data.get("reference_context", "")).strip() or chunk_text[:450]
    if not q:
        raise LLMError("LLM không tạo được câu hỏi.")
    return q, q_class, intent, ref


async def llm_judge_relevance(
    base_url: str,
    api_key: str,
    model: str,
    question: str,
    reference_context: str,
    chunk_content: str,
) -> Tuple[int, str]:
    """
    LLM-as-a-Judge: evaluates if `chunk_content` is relevant for answering `question`
    given `reference_context`. Returns (1|0, short_reason).
    """
    sys_prompt = (
        "Bạn là giám khảo đánh giá Retrieval cho hệ thống RAG. "
        "Cho câu hỏi, đoạn căn cứ chuẩn (reference_context) và 1 đoạn văn bản tìm được (chunk). "
        "Hãy chấm chunk có liên quan và chứa thông tin hữu ích để trả lời câu hỏi hay không. "
        'Trả về DUY NHẤT JSON: {"relevant": 1 hoặc 0, "reason": "giải thích ngắn gọn <= 18 từ bằng tiếng Việt"}'
    )
    user_prompt = (
        f"Câu hỏi: {question}\n\n"
        f"Căn cứ chuẩn: {reference_context[:800]}\n\n"
        f"Chunk tìm được: {chunk_content[:1400]}"
    )
    data = await call_llm_json(base_url, api_key, model, sys_prompt, user_prompt)
    rel = 1 if int(data.get("relevant", 0)) == 1 else 0
    reason = str(data.get("reason", "")).strip()[:160]
    return rel, reason or ("LLM: Liên quan" if rel == 1 else "LLM: Không liên quan")


async def llm_ocr_image(
    base_url: str,
    api_key: str,
    model: str,
    png_bytes: bytes,
    timeout: float = 60.0,
) -> str:
    """Calls an OpenAI-compatible Vision LLM to transcribe a scanned PDF page into clean Vietnamese text."""
    b64 = base64.b64encode(png_bytes).decode("ascii")
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"

    body: Dict[str, Any] = {
        "model": model.strip(),
        "messages": [
            {
                "role": "system",
                "content": (
                    "Bạn là công cụ OCR tiếng Việt chính xác cao. "
                    "Hãy chép lại NGUYÊN VĂN toàn bộ chữ và số có trong ảnh trang tài liệu theo đúng thứ tự đọc. "
                    "Giữ đúng dấu tiếng Việt; nếu có bảng biểu hãy trình bày dạng cột ngăn cách bởi dấu '|'. "
                    "Chỉ trả về nội dung văn bản đã trích xuất, KHÔNG thêm lời giải thích hay markdown thừa."
                ),
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Trích xuất toàn bộ nội dung văn bản từ trang tài liệu này:"},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                ],
            },
        ],
        "temperature": 0.1,
    }

    client = get_shared_http_client()
    r = await client.post(url, headers=headers, json=body, timeout=timeout)
    if r.status_code >= 400:
        raise LLMError(f"HTTP {r.status_code}: {r.text[:260]}")
    payload = r.json()
    choices = payload.get("choices") or []
    if not choices:
        raise LLMError("Vision LLM trả về phản hồi rỗng.")
    text = str(choices[0].get("message", {}).get("content", "")).strip()
    if not text:
        raise LLMError("Vision LLM không trích xuất được văn bản.")
    return text
