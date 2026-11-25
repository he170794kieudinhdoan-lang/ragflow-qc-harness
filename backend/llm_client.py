import asyncio
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
    last_resp = None
    for attempt in range(4):
        r = await client.post(url, headers=headers, json=body, timeout=timeout)
        last_resp = r
        if r.status_code == 429 and attempt < 3:
            await asyncio.sleep(1.5 * (2 ** attempt))
            continue
        break
    assert last_resp is not None
    if last_resp.status_code >= 400:
        raise LLMError(f"HTTP {last_resp.status_code}: {last_resp.text[:360]}")
    payload = last_resp.json()
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
    target_class: str = "Local",
) -> Tuple[str, str, str, str, str]:
    """
    Generates a Vietnamese RAG evaluation testcase using LLM.
    Returns (input_question, expected_outcome, question_class, intent_type, reference_context).
    """
    class_rules = {
        "Local": (
            "Loại câu hỏi BẮT BUỘC: Local — câu trả lời nằm trọn trong 1 đoạn văn bản cung cấp. "
            "Hỏi trực tiếp, tự nhiên như người dùng thật (không sao chép nguyên văn tiêu đề máy móc)."
        ),
        "Global": (
            "Loại câu hỏi BẮT BUỘC: Global — câu hỏi yêu cầu TỔNG HỢP thông tin từ nhiều đoạn hoặc nhiều khía cạnh "
            "khác nhau trong các đoạn tài liệu cung cấp (ví dụ: so sánh, liệt kê đầy đủ các nhóm/bước/điều kiện xuyên suốt nhiều đoạn)."
        ),
        "Multi-hop": (
            "Loại câu hỏi BẮT BUỘC: Multi-hop — câu hỏi yêu cầu SUY LUẬN THEO CHUỖI A → B → C từ 2 hoặc nhiều đoạn tài liệu "
            "(ví dụ: từ tình huống/điều kiện ở đoạn 1 suy ra đối tượng/phân loại, rồi áp dụng quy định/hướng dẫn ở đoạn 2 để kết luận). "
            "TUYỆT ĐỐI KHÔNG chỉ tra 1 bảng hoặc gộp 2 sự kiện độc lập không có quan hệ suy luận."
        ),
    }
    rule_txt = class_rules.get(target_class, class_rules["Local"])
    sys_prompt = (
        "Bạn là chuyên gia QC hệ thống RAG tiếng Việt. "
        f"{rule_txt}\n"
        "Trả về DUY NHẤT JSON hợp lệ với đúng 5 khóa:\n"
        '{"question": "câu hỏi tự nhiên bằng tiếng Việt", '
        '"expected_outcome": "tóm tắt đáp án đúng ngắn gọn 1-3 câu dựa trên tài liệu", '
        f'"question_class": "{target_class}", '
        '"intent_type": "Factoid|Keyword|Table|Procedural|Comparison|Reasoning", '
        '"reference_context": "đoạn trích nguyên văn 1-4 câu chứa đủ căn cứ trả lời từ nội dung cung cấp"}'
    )
    user_prompt = f"Tài liệu nguồn: {filename}\n\nNội dung tài liệu:\n{chunk_text[:3200]}"
    data = await call_llm_json(base_url, api_key, model, sys_prompt, user_prompt, timeout=60.0)
    q = str(data.get("question", "")).strip()
    expected = str(data.get("expected_outcome", "")).strip()
    q_class = target_class if target_class in ("Local", "Global", "Multi-hop") else "Local"
    intent = str(data.get("intent_type", "Factoid")).strip() or "Factoid"
    ref = str(data.get("reference_context", "")).strip() or chunk_text[:500]
    if not q:
        raise LLMError("LLM không tạo được câu hỏi.")
    return q, expected, q_class, intent, ref


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


def _systemone_endpoint(base_url: str) -> str:
    b = (base_url or "").strip().rstrip("/")
    if b.endswith("/systemone"):
        return b
    if b.endswith("/v1"):
        return f"{b}/systemone"
    return f"{b}/v1/systemone"


def systemone_requires_key(base_url: str) -> bool:
    """Cloud hosted endpoints (TypeSafe / Vercel AI Gateway) require an API key; Colab/local Kev may omit it."""
    b = (base_url or "").strip().lower()
    return "api.typesafe.ai" in b or "ai-gateway.vercel.sh" in b


def resolve_systemone_credentials(get_setting_fn) -> Tuple[str, str, str, float]:
    """Resolve (base_url, api_key, model, threshold), sharing Vercel AI Gateway key when appropriate."""
    base_url = (get_setting_fn("systemone_base_url", "https://ai-gateway.vercel.sh/typesafe") or "").strip()
    api_key = (get_setting_fn("systemone_api_key", "") or "").strip()
    if not api_key and "ai-gateway.vercel.sh" in base_url.lower():
        llm_base = (get_setting_fn("llm_base_url", "") or "").strip().lower()
        if "ai-gateway.vercel.sh" in llm_base:
            api_key = (get_setting_fn("llm_api_key", "") or "").strip()
    model = (get_setting_fn("systemone_model", "typesafe-ai/jev") or "typesafe-ai/jev").strip()
    try:
        threshold = float(get_setting_fn("systemone_threshold", "0.50") or "0.50")
    except (TypeError, ValueError):
        threshold = 0.50
    threshold = max(0.05, min(0.95, threshold))
    return base_url, api_key, model, threshold


async def call_system_one(
    base_url: str,
    api_key: str,
    model: str,
    state: Any,
    questions: Dict[str, Any],
    timeout: float = 60.0,
) -> Dict[str, Any]:
    """Call TypeSafe System One / Kev decision endpoint (/v1/systemone)."""
    url = _systemone_endpoint(base_url)
    headers = {"Content-Type": "application/json"}
    if api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"

    body: Dict[str, Any] = {
        "model": model.strip() or "typesafe-ai/jev",
        "state": state,
        "questions": questions,
    }
    client = get_shared_http_client()
    r = None
    for attempt in range(3):
        r = await client.post(url, headers=headers, json=body, timeout=timeout)
        if r.status_code in (429, 503) and attempt < 2:
            await asyncio.sleep(1.5 * (attempt + 1))
            continue
        break
    assert r is not None
    if r.status_code >= 400:
        raise LLMError(f"System One HTTP {r.status_code}: {r.text[:400]}")
    payload = r.json()
    answers = payload.get("answers")
    if not isinstance(answers, dict):
        raise LLMError(f"System One không trả về trường answers hợp lệ: {str(payload)[:180]}")
    return answers


async def test_system_one_connection(base_url: str, api_key: str, model: str) -> Dict[str, Any]:
    answers = await call_system_one(
        base_url=base_url,
        api_key=api_key,
        model=model,
        state="Câu hỏi: Liều dùng PrEP hàng ngày là gì?\nĐoạn tìm được: Uống 1 viên mỗi ngày vào giờ cố định.",
        questions={
            "relevant": {
                "type": "noul",
                "instructions": "Đoạn tìm được có chứa thông tin trả lời cho câu hỏi không?",
            }
        },
        timeout=25.0,
    )
    ans = answers.get("relevant") or {}
    prob = ans.get("noul")
    return {"ok": True, "model": model, "sample_noul": prob, "answers": answers}


async def jev_judge_relevance(
    base_url: str,
    api_key: str,
    model: str,
    question: str,
    reference_context: str,
    chunk_content: str,
    threshold: float = 0.50,
) -> Tuple[int, str]:
    """
    System One (Jev / Kev) Strict Retrieval Relevancy Judge: returns (1|0, calibrated_reason).
    Uses structured English binary (noul) questions — empirically calibrated for Kev/Jev —
    to verify concrete answer-bearing facts and filter pure metadata/header chunks.
    """
    ref_text = (reference_context or "").strip()[:800]
    chunk_text = (chunk_content or "").strip()[:1400]
    state = (
        f"User Question: {question.strip()}\n\n"
        + (f"Gold Reference Context: {ref_text}\n\n" if ref_text else "")
        + f"Candidate Chunk:\n{chunk_text}"
    )
    rel_instruction = (
        "Does the Candidate Chunk itself state key facts found in the Gold Reference Context to answer the User Question? "
        "Answer NO if Candidate Chunk is only metadata, headers, URLs, or unrelated."
        if ref_text
        else "Does the Candidate Chunk itself contain specific factual details to answer the User Question? "
        "Answer NO if Candidate Chunk is only metadata, headers, URLs, or unrelated."
    )
    answers = await call_system_one(
        base_url=base_url,
        api_key=api_key,
        model=model,
        state=state,
        questions={
            "relevant": {
                "type": "noul",
                "instructions": rel_instruction,
            },
            "metadata_only": {
                "type": "noul",
                "instructions": (
                    "Does the Candidate Chunk consist mostly of metadata fields "
                    "(source, source_url, topic, domain, disease) or headings without body facts?"
                ),
            },
        },
        timeout=35.0,
    )
    raw_ans = answers.get("relevant") or {}
    p = raw_ans.get("noul")
    if p is None:
        raise LLMError(f"Jev không trả về giá trị noul: {raw_ans}")
    prob = float(p)

    raw_meta = answers.get("metadata_only") or {}
    p_meta = raw_meta.get("noul")
    prob_meta = float(p_meta) if p_meta is not None else 0.0

    # Reject chunks dominated by metadata/headings unless answer-bearing evidence strongly outweighs meta signal
    if prob_meta >= 0.44 and (prob - prob_meta) < 0.20:
        return 0, f"Jev: Không liên quan (tiêu đề/metadata · p={prob:.2f}, meta={prob_meta:.2f})"

    rel = 1 if prob >= threshold else 0
    borderline = " · Cần duyệt" if abs(prob - threshold) <= 0.08 else ""
    label = "Liên quan" if rel == 1 else "Không liên quan"
    meta_note = f", meta={prob_meta:.2f}" if prob_meta >= 0.38 else ""
    return rel, f"Jev: {label} (p={prob:.2f}{meta_note}{borderline})"


async def llm_judge_chunk(
    base_url: str,
    api_key: str,
    model: str,
    chunk_content: str,
    prev_content: str,
    next_content: str,
    filename: str,
) -> Dict[str, Any]:
    """
    LLM-as-a-Judge for Chunking QC (Phụ lục A & B):
    Catches semantic errors missed by 0-LLM rules (implicit missing subject C3,
    topic/sentence/plain-table split C1/C2, web menu/breadcrumb/OCR noise C4).
    """
    sys_prompt = (
        "Bạn là chuyên gia QC đánh giá chất lượng Chunk của hệ thống RAG tiếng Việt theo 3 tiêu chí ngữ nghĩa:\n"
        "1. integrity (1=Đạt, 0=Lỗi): Chunk trọn ý, KHÔNG cắt ngang câu, ngang danh sách hay vỡ bảng (INTEGRITY).\n"
        "2. context_sufficiency (1=Đạt, 0=Lỗi): Đọc ĐỘC LẬP chunk hiện tại vẫn hiểu rõ đang nói về chủ thể/đối tượng nào "
        "(nếu mở đầu mơ hồ, thiếu chủ thể ngầm như 'Uống 1 viên/ngày' mà không rõ thuốc gì → 0, mã CONTEXT).\n"
        "3. no_noise (1=Sạch, 0=Nhiễu): KHÔNG chứa menu web, breadcrumb, quảng cáo, nút đặt lịch, header/footer, số trang rác, "
        "hoặc văn bản OCR mất dấu/sai chính tả nghiêm trọng (nếu có → 0, mã NOISE).\n"
        "Trả về DUY NHẤT JSON hợp lệ:\n"
        '{"integrity": 0 hoặc 1, "context_sufficiency": 0 hoặc 1, "no_noise": 0 hoặc 1, '
        '"error_codes": ["INTEGRITY"|"CONTEXT"|"NOISE"], "reason": "lý do lỗi ngắn gọn <= 25 từ bằng tiếng Việt (để trống nếu cả 3 đều bằng 1)"}'
    )
    user_prompt = (
        f"Tài liệu: {filename}\n\n"
        f"[Đuôi chunk trước]:\n{(prev_content or '')[-400:]}\n\n"
        f"[CHUNK HIỆN TẠI CẦN CHẤM]:\n{(chunk_content or '')[:2200]}\n\n"
        f"[Đầu chunk sau]:\n{(next_content or '')[:400]}"
    )
    data = await call_llm_json(base_url, api_key, model, sys_prompt, user_prompt, timeout=60.0)
    valid_codes = {"INTEGRITY", "CONTEXT", "NOISE"}
    raw_codes = data.get("error_codes") or []
    codes = [str(c).strip().upper() for c in raw_codes if str(c).strip().upper() in valid_codes]
    integrity = 1 if int(data.get("integrity", 1)) == 1 else 0
    ctx_suff = 1 if int(data.get("context_sufficiency", 1)) == 1 else 0
    no_noise = 1 if int(data.get("no_noise", 1)) == 1 else 0
    if integrity == 0 and "INTEGRITY" not in codes:
        codes.append("INTEGRITY")
    if ctx_suff == 0 and "CONTEXT" not in codes:
        codes.append("CONTEXT")
    if no_noise == 0 and "NOISE" not in codes:
        codes.append("NOISE")
    reason = str(data.get("reason", "")).strip()[:200]
    return {
        "integrity": integrity,
        "context_sufficiency": ctx_suff,
        "no_noise": no_noise,
        "error_codes": codes,
        "reason": reason,
    }


async def jev_judge_chunk(
    base_url: str,
    api_key: str,
    model: str,
    chunk_content: str,
    prev_content: str,
    next_content: str,
    filename: str = "",
    threshold: float = 0.50,
) -> Dict[str, Any]:
    """
    System One (Jev / Kev) Chunking QC Judge: evaluates integrity, standalone context sufficiency,
    and cleanliness (no_noise) in one /v1/systemone call using calibrated positive defect questions.
    """
    prev_tail = (prev_content or "").strip()[-400:] or "N/A"
    next_head = (next_content or "").strip()[:400] or "N/A"
    cur_text = (chunk_content or "").strip()[:2200]
    state = (
        f"TEXT TO CHECK:\n{cur_text}\n\n"
        f"(Context before: {prev_tail} | Context after: {next_head})"
    )
    answers = await call_system_one(
        base_url=base_url,
        api_key=api_key,
        model=model,
        state=state,
        questions={
            "is_broken": {
                "type": "noul",
                "instructions": (
                    "Does TEXT TO CHECK begin or end mid-sentence or split a bullet list/table across adjacent context?"
                ),
            },
            "missing_subject": {
                "type": "noul",
                "instructions": (
                    "Looking ONLY inside TEXT TO CHECK (ignoring Document Title), does it fail to name the specific medicine, "
                    "disease, or subject it talks about (ambiguous standalone snippet)?"
                ),
            },
            "has_noise": {
                "type": "noul",
                "instructions": (
                    "Does TEXT TO CHECK contain website UI junk such as menus, breadcrumbs ('Trang chủ >'), "
                    "booking buttons, hotlines, copyright notices, isolated page numbers, or garbled OCR characters?"
                ),
            },
        },
        timeout=35.0,
    )

    def _prob(key: str) -> float:
        val = (answers.get(key) or {}).get("noul")
        if val is None:
            raise LLMError(f"Jev/Kev không trả về giá trị noul cho '{key}'")
        return float(val)

    p_broken = _prob("is_broken")
    p_missing_subj = _prob("missing_subject")
    p_noise = _prob("has_noise")

    broken_cut = max(0.30, min(0.80, threshold - 0.06))
    ctx_cut = max(0.25, min(0.75, threshold - 0.22))
    integrity = 0 if p_broken >= broken_cut else 1
    ctx_suff = 0 if p_missing_subj >= ctx_cut else 1
    no_noise = 0 if p_noise >= threshold else 1

    codes = []
    if integrity == 0:
        codes.append("INTEGRITY")
    if ctx_suff == 0:
        codes.append("CONTEXT")
    if no_noise == 0:
        codes.append("NOISE")

    borderline = (
        abs(p_broken - broken_cut) <= 0.06
        or abs(p_missing_subj - ctx_cut) <= 0.06
        or abs(p_noise - threshold) <= 0.08
    )
    b_tag = " · Cần duyệt" if borderline else ""
    scores_str = f"broken={p_broken:.2f}, no_ctx={p_missing_subj:.2f}, noise={p_noise:.2f}"
    if codes:
        reason = f"Jev/Kev phát hiện {', '.join(codes)} ({scores_str}{b_tag})"
    else:
        reason = f"Jev/Kev: Đạt chuẩn ({scores_str}{b_tag})"

    return {
        "integrity": integrity,
        "context_sufficiency": ctx_suff,
        "no_noise": no_noise,
        "error_codes": codes,
        "reason": reason[:200],
    }


async def llm_judge_parsing_unit(
    base_url: str,
    api_key: str,
    model: str,
    source_text: str,
    parsed_text: str,
    unit_type: str,
    filename: str,
) -> Dict[str, Any]:
    """
    Mandatory LLM-as-a-Judge for Step 2 (Parsing QC):
    Compares original ground-truth unit against the best-aligned RAGFlow parsed span,
    eliminating false negatives (neighbor chunk text, decorative section numbers,
    HTML vs pipe table formatting) while catching real TEXT/TABLE/ORDER/LAYOUT/OCR defects.
    """
    sys_prompt = (
        "Bạn là chuyên gia QC kiểm thử Parsing (đọc file) của hệ thống RAG tiếng Việt.\n"
        "Mục tiêu: Kiểm tra xem nội dung của [ĐOẠN TRÍCH GỐC] có được trích xuất ĐẦY ĐỦ, CHÍNH XÁC, ĐÚNG THỨ TỰ bên trong [KẾT QUẢ RAGFLOW PARSE] hay không.\n\n"
        "QUY TẮC BẮT BUỘC (TRÁNH ĐÁNH FAIL OAN):\n"
        "1. [KẾT QUẢ RAGFLOW PARSE] trích từ chunk của RAGFlow nên HOÀN TOÀN BÌNH THƯỜNG nếu đầu hoặc cuối nó có kèm thêm câu/đoạn liền kề của tài liệu. "
        "TUYỆT ĐỐI KHÔNG đánh FAIL chỉ vì [KẾT QUẢ RAGFLOW PARSE] dài hơn hoặc có thêm đoạn liền kề!\n"
        "2. BỎ QUA khác biệt hình thức không làm sai nghĩa: số thứ tự đề mục/icon (VD: số '3' cạnh 'PrEP dành cho ai?'), "
        "xuống dòng, dấu gạch đầu dòng, khoảng trắng thừa, hoặc bảng pipe '|' chuyển sang HTML <table> nếu giữ đủ dữ liệu và đúng quan hệ hàng/cột.\n"
        "   - RIÊNG VỚI `Loại đoạn: image` / `diagram` (biểu đồ, lịch, sơ đồ): Nếu RAGFlow bật VLM và trả về đoạn mô tả/diễn giải bằng câu văn tự nhiên "
        "nhưng NẮM ĐÚNG ý chính, mối quan hệ mũi tên/thời gian và các con số/nhãn quan trọng của sơ đồ (VD tóm tắt 'ngày 1 đến 31' hoặc dịch 'Mon–Sun' thành 'Thứ 2–Chủ nhật') "
        "thì VẪN CHẤM PASS — không bắt bẻ việc diễn đạt lại hay không liệt kê từng số liên tiếp.\n"
        "3. CHỈ đánh FAIL khi có lỗi THỰC SỰ bên trong phần đối chiếu với [ĐOẠN TRÍCH GỐC]:\n"
        "   - TEXT: Thiếu câu/ý/số liệu chuyên môn quan trọng (liều dùng, tỷ lệ %, điều luật) hoặc sai/mất dấu tiếng Việt, lỗi OCR nặng.\n"
        "   - TABLE: Vỡ cấu trúc bảng, mất hàng/cột, ghép sai dữ liệu giữa các cột làm sai nghĩa.\n"
        "   - ORDER: Các câu/cột CỦA CHÍNH ĐOẠN GỐC bị đảo lộn thứ tự đọc làm sai nghĩa.\n"
        "   - LAYOUT: Mất cấu trúc heading/danh sách nghiêm trọng hoặc mất nội dung hình ảnh/sơ đồ.\n"
        "4. QUY TẮC CHO `char_error` (RẤT CHẶT):\n"
        "   - `char_error = 1` CHỈ KHI có lỗi ký tự thực sự trong phần văn bản khớp (mất dấu tiếng Việt kiểu 'c6 the', 'sur dung', hỏng font, ký tự rác, dính chữ kiểu 'PrEPlagi?', sai OCR).\n"
        "   - Nếu chữ tiếng Việt đúng chính tả & đúng dấu thì `char_error` BẮT BUỘC = 0 (kể cả khi verdict là FAIL vì thiếu đoạn hoặc vỡ bảng).\n"
        "5. QUY TẮC CHO `fidelity_error` (ĐỘ TRUNG THỰC NỘI DUNG — ĐỘC LẬP VỚI `char_error`):\n"
        "   - `fidelity_error = 1` CHỈ KHI kết quả parse làm SAI LỆCH SỰ THẬT / Ý NGHĨA CỐT LÕI: sai hoặc mất số liệu chuyên môn (liều dùng, %, ngày tháng, ngưỡng xét nghiệm), "
        "đảo ngược từ phủ định ('không'/'chưa'/'cấm'), hoặc lệch cột/hàng bảng khiến giá trị bị ghép sai đối tượng.\n"
        "   - Nếu chỉ mất dấu nhẹ nhưng vẫn hiểu đúng nghĩa, hoặc thiếu câu dẫn phụ không làm sai thông tin sự thật thì `fidelity_error = 0`.\n\n"
        "Trả về DUY NHẤT JSON hợp lệ:\n"
        '{"verdict": "PASS" hoặc "FAIL", "error_codes": ["TEXT"|"TABLE"|"ORDER"|"LAYOUT"], '
        '"char_error": 0 hoặc 1, "fidelity_error": 0 hoặc 1, "severity": "Nhẹ"|"Trung bình"|"Nghiêm trọng", '
        '"notes": "lý do ngắn gọn <= 22 từ bằng tiếng Việt (để trống nếu PASS)"}'
    )
    user_prompt = (
        f"Tài liệu: {filename} (Loại đoạn: {unit_type})\n\n"
        f"[ĐOẠN TRÍCH GỐC]:\n{(source_text or '')[:3200]}\n\n"
        f"[KẾT QUẢ RAGFLOW PARSE]:\n{(parsed_text or '(TRỐNG — KHÔNG TÌM THẤY TRONG CHUNK)')[:4000]}"
    )
    data = await call_llm_json(base_url, api_key, model, sys_prompt, user_prompt, timeout=60.0)
    verdict = "PASS" if str(data.get("verdict", "")).strip().upper() == "PASS" else "FAIL"
    valid_codes = {"TEXT", "TABLE", "ORDER", "LAYOUT"}
    raw_codes = data.get("error_codes") or []
    codes = [str(c).strip().upper() for c in raw_codes if str(c).strip().upper() in valid_codes]
    char_err = 1 if int(data.get("char_error", 0)) == 1 else 0
    fidelity_err = 1 if int(data.get("fidelity_error", 0)) == 1 else 0
    if verdict == "PASS":
        codes = []
        char_err = 0
        fidelity_err = 0
        severity = ""
    else:
        if not codes:
            codes = ["TABLE" if unit_type == "table" else "TEXT"]
        severity = str(data.get("severity", "Trung bình")).strip()
        if severity not in ("Nhẹ", "Trung bình", "Nghiêm trọng"):
            severity = "Nghiêm trọng" if ("TABLE" in codes or "TEXT" in codes) else "Trung bình"
    notes = str(data.get("notes", "")).strip()[:200]
    return {
        "verdict": verdict,
        "error_codes": codes,
        "char_error": char_err,
        "fidelity_error": fidelity_err,
        "severity": severity,
        "notes": notes,
    }


_RAPID_OCR_ENGINE = None


def _run_rapidocr_sync(img_bytes: bytes) -> str:
    global _RAPID_OCR_ENGINE
    if _RAPID_OCR_ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR
        _RAPID_OCR_ENGINE = RapidOCR()
    res, _ = _RAPID_OCR_ENGINE(img_bytes)
    if not res:
        return ""
    return "\n".join(str(item[1]).strip() for item in res if len(item) >= 2 and str(item[1]).strip())


async def local_ocr_with_vietnamese_restore(
    img_bytes: bytes,
    llm_base: str = "",
    llm_key: str = "",
    llm_model: str = "",
    timeout: float = 60.0,
) -> str:
    """
    Runs local RapidOCR (0 API cost, 0 RECITATION filter, exact numbers) and then
    restores Vietnamese diacritics & word spacing using the configured text LLM (e.g. DeepSeek).
    """
    import asyncio
    raw_ocr = await asyncio.to_thread(_run_rapidocr_sync, img_bytes)
    if not raw_ocr.strip():
        raise LLMError("RapidOCR local không nhận diện được chữ trên ảnh.")
    if not llm_base or not llm_model:
        return raw_ocr

    url = f"{llm_base.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if llm_key.strip():
        headers["Authorization"] = f"Bearer {llm_key.strip()}"
    body: Dict[str, Any] = {
        "model": llm_model.strip(),
        "messages": [
            {
                "role": "system",
                "content": (
                    "Bạn là chuyên gia hiệu đính văn bản OCR tiếng Việt. "
                    "Hãy khôi phục dấu tiếng Việt và tách khoảng trắng bị dính cho đoạn văn bản OCR thô dưới đây. "
                    "TUYỆT ĐỐI GIỮ NGUYÊN mọi con số, ngày tháng, tỷ lệ %, tên riêng và cấu trúc dòng/bảng. "
                    "KHÔNG thêm lời giải thích, CHỈ trả về văn bản tiếng Việt đã khôi phục."
                ),
            },
            {"role": "user", "content": raw_ocr[:4500]},
        ],
        "temperature": 0.1,
    }
    try:
        client = get_shared_http_client()
        r = await client.post(url, headers=headers, json=body, timeout=timeout)
        if r.status_code < 400:
            choices = (r.json().get("choices") or [])
            if choices:
                restored = str(choices[0].get("message", {}).get("content") or "").strip()
                if restored:
                    return restored
    except Exception:
        pass
    return raw_ocr


def _detect_image_mime(img_bytes: bytes) -> str:
    if img_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if img_bytes[:4] == b"RIFF" and img_bytes[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


async def llm_ocr_image(
    base_url: str,
    api_key: str,
    model: str,
    img_bytes: bytes,
    timeout: float = 60.0,
) -> str:
    """Calls an OpenAI-compatible Vision LLM to transcribe a scanned PDF page into clean Vietnamese text."""
    b64 = base64.b64encode(img_bytes).decode("ascii")
    mime = _detect_image_mime(img_bytes)
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
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ],
            },
        ],
        "temperature": 0.1,
    }

    client = get_shared_http_client()
    last_resp = None
    for attempt in range(4):
        r = await client.post(url, headers=headers, json=body, timeout=timeout)
        last_resp = r
        if r.status_code == 429 and attempt < 3:
            await asyncio.sleep(1.5 * (2 ** attempt))
            continue
        break
    assert last_resp is not None
    if last_resp.status_code >= 400:
        raise LLMError(f"HTTP {last_resp.status_code}: {last_resp.text[:360]}")
    payload = last_resp.json()
    choices = payload.get("choices") or []
    if not choices:
        raise LLMError("Vision LLM trả về phản hồi rỗng.")
    finish_reason = str(choices[0].get("finish_reason") or "")
    text = str(choices[0].get("message", {}).get("content") or "").strip()
    if not text:
        if "content_filter" in finish_reason.lower() or "recitation" in finish_reason.lower():
            raise LLMError(f"Vision LLM chặn phản hồi ({finish_reason}).")
        raise LLMError("Vision LLM không trích xuất được văn bản.")
    return text


async def llm_ocr_images_batch(
    base_url: str,
    api_key: str,
    model: str,
    pages: list,
    timeout: float = 95.0,
) -> Dict[int, str]:
    """
    Batches multiple page images (e.g. 4 pages) into ONE Vision LLM request for 4-5x speedup
    and 75% fewer RPM calls. `pages` is a list of (unit_id, img_bytes).
    Returns {unit_id: extracted_text}.
    """
    if not pages:
        return {}
    if len(pages) == 1:
        uid, img_b = pages[0]
        return {uid: await llm_ocr_image(base_url, api_key, model, img_b, timeout=timeout)}

    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"

    ids_str = ", ".join(str(uid) for uid, _ in pages)
    user_content: list = [
        {
            "type": "text",
            "text": (
                f"Dưới đây là {len(pages)} ảnh trang tài liệu với các mã lần lượt: {ids_str}.\n"
                "Hãy OCR NGUYÊN VĂN từng ảnh theo đúng thứ tự, giữ đúng dấu tiếng Việt (bảng dùng dấu '|').\n"
                "BẮT BUỘC mở đầu mỗi trang bằng đúng dòng phân cách: <<<PAGE:ID>>> (ví dụ <<<PAGE:123>>>), "
                "sau đó là toàn bộ nội dung trang đó. KHÔNG thêm lời giải thích."
            ),
        }
    ]
    for uid, img_b in pages:
        mime = _detect_image_mime(img_b)
        b64 = base64.b64encode(img_b).decode("ascii")
        user_content.append({"type": "text", "text": f"[Ảnh ID={uid}]"})
        user_content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})

    body: Dict[str, Any] = {
        "model": model.strip(),
        "messages": [
            {
                "role": "system",
                "content": (
                    "Bạn là công cụ OCR tiếng Việt chính xác cao. "
                    "Chép lại nguyên văn từng ảnh và phân tách chính xác bằng thẻ <<<PAGE:ID>>>."
                ),
            },
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.1,
    }

    client = get_shared_http_client()
    last_resp = None
    for attempt in range(4):
        r = await client.post(url, headers=headers, json=body, timeout=timeout)
        last_resp = r
        if r.status_code == 429 and attempt < 3:
            await asyncio.sleep(1.5 * (2 ** attempt))
            continue
        break
    assert last_resp is not None
    if last_resp.status_code >= 400:
        raise LLMError(f"HTTP {last_resp.status_code}: {last_resp.text[:360]}")
    payload = last_resp.json()
    choices = payload.get("choices") or []
    if not choices:
        raise LLMError("Vision LLM trả về phản hồi rỗng.")
    raw_out = str(choices[0].get("message", {}).get("content", "")).strip()

    out: Dict[int, str] = {}
    matches = list(re.finditer(r"<<<\s*PAGE\s*:\s*(\d+)\s*>>>", raw_out))
    for i, m in enumerate(matches):
        uid = int(m.group(1))
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(raw_out)
        txt = raw_out[start:end].strip()
        if txt:
            out[uid] = txt
    return out
