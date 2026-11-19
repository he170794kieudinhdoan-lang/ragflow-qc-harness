import re
import unicodedata
from difflib import SequenceMatcher
from typing import Any, Dict, List, Tuple
from rapidfuzz import fuzz


PARSING_ERROR_CATALOG = [
    {"code": "P1", "group": "Mất nội dung", "name": "Mất đoạn nội dung", "severity": "Nghiêm trọng", "metric": "Text Completeness"},
    {"code": "P2", "group": "Mất nội dung", "name": "Nội dung trong ảnh không được đọc", "severity": "Nghiêm trọng", "metric": "Layout Accuracy"},
    {"code": "P3", "group": "Sai thứ tự", "name": "Sai nội dung / sai thứ tự", "severity": "Nghiêm trọng", "metric": "Reading Order Accuracy"},
    {"code": "P4", "group": "Lỗi ký tự", "name": "Mất dấu / lỗi ký tự", "severity": "Trung bình", "metric": "Character Error"},
    {"code": "P5", "group": "Lỗi ký tự", "name": "Ký tự rác", "severity": "Trung bình", "metric": "Character Error"},
    {"code": "P6", "group": "Lỗi ký tự", "name": "Lỗi OCR", "severity": "Trung bình", "metric": "Character Error"},
    {"code": "P7", "group": "Mất cấu trúc", "name": "Heading bị dính vào đoạn văn", "severity": "Trung bình", "metric": "Text Completeness"},
    {"code": "P8", "group": "Mất cấu trúc", "name": "Danh sách bị gộp", "severity": "Trung bình", "metric": "Text Completeness"},
    {"code": "P9", "group": "Mất cấu trúc", "name": "Bảng bị vỡ cấu trúc", "severity": "Trung bình", "metric": "Table Accuracy"},
    {"code": "P10", "group": "Mất nội dung", "name": "Mất số liệu trong bảng", "severity": "Nghiêm trọng", "metric": "Table Accuracy"},
]

CHUNKING_ERROR_CATALOG = [
    {"code": "C1", "name": "Cắt ngang câu / đoạn", "severity": "High", "metric": "Chunk Integrity"},
    {"code": "C2", "name": "Cắt vỡ bảng giữa chừng", "severity": "High", "metric": "Chunk Integrity"},
    {"code": "C3", "name": "Thiếu ngữ cảnh / mất heading chủ thể", "severity": "Medium", "metric": "Context Sufficiency"},
    {"code": "C4", "name": "Nhiễu header / footer / số trang", "severity": "Medium", "metric": "Noise Rate"},
    {"code": "C5", "name": "Trùng lặp nội dung giữa các chunk", "severity": "Low", "metric": "Duplicate Rate"},
    {"code": "C6", "name": "Chunk quá khổ (> max chars)", "severity": "Medium", "metric": "Valid Size"},
    {"code": "C7", "name": "Cắt tách danh sách khỏi tiêu đề", "severity": "Medium", "metric": "Chunk Integrity"},
    {"code": "C8", "name": "Chunk quá vụn (< min chars / chỉ có số)", "severity": "High", "metric": "Valid Size"},
]

RETRIEVAL_ERROR_CATALOG = [
    {"code": "R1", "name": "Miss nhánh Keyword (mã số / tên riêng)", "layer": "KEYWORD"},
    {"code": "R2", "name": "Miss nhánh Vector (paraphrase / ngữ nghĩa)", "layer": "VECTOR"},
    {"code": "R3", "name": "Lỗi Rerank (tụt hạng sau rerank)", "layer": "RERANK"},
    {"code": "R4", "name": "Lỗi Ngưỡng / Top-K (bị cắt bởi threshold)", "layer": "THRESHOLD"},
]


def nfc(text: str) -> str:
    """Normalize Vietnamese Unicode to NFC so NFD vs NFC diacritics don't cause false diffs."""
    return unicodedata.normalize("NFC", text or "")


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", nfc(text).strip().lower())


def collapse_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", nfc(text).strip())


def _html_table_to_pipe(text: str) -> str:
    """Convert RAGFlow HTML tables (<tr><td>...) into clean pipe-separated rows for fair comparison."""
    if not text or ("<td" not in text.lower() and "<th" not in text.lower()):
        return text
    t = re.sub(r"</t[dh]\s*>\s*<t[dh][^>]*>", " | ", text, flags=re.IGNORECASE)
    t = re.sub(r"</tr\s*>", "\n", t, flags=re.IGNORECASE)
    t = re.sub(r"<br\s*/?>", " ", t, flags=re.IGNORECASE)
    t = re.sub(r"<[^>]+>", " ", t)
    lines = [re.sub(r"[ \t]+", " ", ln).strip(" |") for ln in t.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def strip_diacritics(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text or "")
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return stripped.replace("đ", "d").replace("Đ", "D")


_NUM_TOKEN_RE = re.compile(
    r"(?:<=|>=|[<>±])?\s*\d+(?:[.,]\d+)?(?:\s*(?:%|mg|ml|g|kg|/l|/mm3|mm3|tuần|tháng|ngày|giờ))?",
    re.IGNORECASE,
)
_NEGATION_TERMS = [
    "chống chỉ định",
    "không chỉ định",
    "âm tính",
    "dương tính",
    "không",
    "chưa",
    "prep",
    "pep",
    "bậc 1",
    "bậc 2",
]


def _extract_num_multiset(text: str) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for m in _NUM_TOKEN_RE.findall(nfc(text)):
        tok = re.sub(r"\s+", "", m.lower())
        if tok:
            counts[tok] = counts.get(tok, 0) + 1
    return counts


_LIST_LINE_RE = re.compile(r"^\s*(?:[-•+*]|\d+[.)]|[a-zA-Z][.)])\s+")
_HEADING_LINE_RE = re.compile(
    r"^(?:(?:CHƯƠNG|PHẦN|MỤC|BÀI)\s+[\dIVXLC]+|[IVXLC]+\.\s+|\d+(?:\.\d+)*\.?\s+)",
    re.IGNORECASE,
)


def analyze_parsing_risks(
    source_text: str,
    excerpt: str,
    unit_type: str = "text",
    text_sim: float = 100.0,
    format_group: str = "",
) -> Tuple[List[Dict[str, str]], List[str]]:
    """
    0-LLM rule engine mapping detected parsing issues directly to Phụ lục B (P1..P10):
    - P1: Missing text segment
    - P2: Unread image/diagram content
    - P3: Wrong content / scrambled reading order / negation flip
    - P4: Vietnamese diacritic loss / char error
    - P5: Garbage / corrupted characters
    - P6: OCR error (for scan/image docs)
    - P7: Heading merged into body text
    - P8: Numbered/bulleted list merged into single line
    - P9: Table structure broken (row/column mismatch)
    - P10: Missing/altered numbers inside table
    """
    flags: List[Dict[str, str]] = []
    suggested_codes: List[str] = []

    def add_code(c: str):
        if c not in suggested_codes:
            suggested_codes.append(c)

    src_c = collapse_whitespace(source_text)
    exc_c = collapse_whitespace(excerpt)

    if not exc_c:
        code = "P2" if unit_type in ("image", "diagram") else "P1"
        flags.append({"code": "MISSING_CONTENT", "label": f"Không tìm thấy nội dung khớp ({code})", "severity": "Nghiêm trọng"})
        return flags, [code]

    # P5: Garbage / corrupted characters
    if re.search(r"[\ufffd\x00-\x08\x0b\x0c\x0e-\x1f]", exc_c):
        flags.append({"code": "GARBAGE_CHAR", "label": "Phát hiện ký tự rác / lỗi mã hóa (P5)", "severity": "Trung bình"})
        add_code("P5")

    # P4: Vietnamese diacritic loss/corruption
    has_diacritic_issue = False
    if src_c.lower() != exc_c.lower():
        acc_sim = float(fuzz.ratio(src_c.lower(), exc_c.lower()))
        no_acc_sim = float(fuzz.ratio(strip_diacritics(src_c.lower()), strip_diacritics(exc_c.lower())))
        if no_acc_sim - acc_sim >= 1.5:
            has_diacritic_issue = True
            flags.append({
                "code": "DIACRITIC_LOSS",
                "label": "Nghi mất dấu / sai dấu tiếng Việt (P4)",
                "severity": "Trung bình",
            })
            add_code("P4")

    # P6: OCR error for scan/image format group
    if ("scan" in (format_group or "").lower() or "ảnh" in (format_group or "").lower()) and (
        has_diacritic_issue or text_sim < 90.0
    ):
        add_code("P6")

    # P3: Scrambled reading order (high bag-of-words overlap, low sequential ratio)
    if text_sim < 78.0:
        tok_set = float(fuzz.token_set_ratio(src_c.lower(), exc_c.lower()))
        if tok_set >= 85.0 and (tok_set - text_sim) >= 12.0:
            flags.append({
                "code": "READING_ORDER_SCRAMBLED",
                "label": "Nghi đảo thứ tự dòng / trộn cột (P3)",
                "severity": "Nghiêm trọng",
            })
            add_code("P3")

    # P10 (table) / P3 (text): Critical numeric / operator mismatch
    src_nums = _extract_num_multiset(src_c)
    exc_nums = _extract_num_multiset(exc_c)
    if src_nums and src_nums != exc_nums:
        missing_nums = [k for k, v in src_nums.items() if exc_nums.get(k, 0) < v]
        if missing_nums:
            sample = ", ".join(missing_nums[:4])
            err_code = "P10" if unit_type == "table" else "P3"
            flags.append({
                "code": "CRITICAL_NUM_DIFF",
                "label": f"Lệch / mất số liệu: {sample} ({err_code})",
                "severity": "Nghiêm trọng",
            })
            add_code(err_code)

    # P3: Critical negation / polarity flip
    src_low = src_c.lower()
    exc_low = exc_c.lower()
    diff_terms = [term for term in _NEGATION_TERMS if src_low.count(term) != exc_low.count(term)]
    if diff_terms:
        flags.append({
            "code": "CRITICAL_NEGATION_DIFF",
            "label": f"Lệch từ phủ định/đối lập: {', '.join(diff_terms[:3])} (P3)",
            "severity": "Nghiêm trọng",
        })
        add_code("P3")

    # P9: Table structure broken
    if unit_type == "table":
        src_rows = [ln for ln in nfc(source_text).splitlines() if ln.strip()]
        exc_rows = [ln for ln in nfc(excerpt).splitlines() if ln.strip()]
        src_pipes = source_text.count("|")
        exc_pipes = excerpt.count("|")
        row_mismatch = len(src_rows) >= 2 and abs(len(src_rows) - len(exc_rows)) >= max(2, len(src_rows) // 3)
        pipe_mismatch = src_pipes >= 3 and abs(src_pipes - exc_pipes) >= max(3, src_pipes // 3)
        if text_sim < 85.0 or row_mismatch or pipe_mismatch:
            flags.append({
                "code": "TABLE_BROKEN",
                "label": "Bảng nghi bị vỡ hàng/cột (P9)",
                "severity": "Trung bình",
            })
            add_code("P9")
    else:
        src_lines = [ln.strip() for ln in nfc(source_text).splitlines() if ln.strip()]
        exc_lines = [ln.strip() for ln in nfc(excerpt).splitlines() if ln.strip()]
        # P7: Heading merged into body paragraph
        if len(src_lines) >= 2 and _HEADING_LINE_RE.match(src_lines[0]) and len(src_lines[0]) <= 110:
            if len(exc_lines) == 1 and len(exc_lines[0]) > len(src_lines[0]) + 25:
                add_code("P7")
        # P8: List merged
        src_list_cnt = sum(1 for ln in src_lines if _LIST_LINE_RE.match(ln))
        exc_list_cnt = sum(1 for ln in exc_lines if _LIST_LINE_RE.match(ln))
        if src_list_cnt >= 2 and exc_list_cnt < src_list_cnt:
            add_code("P8")

    # P1 / P2: Severe missing content
    if text_sim < 72.0:
        if unit_type in ("image", "diagram"):
            add_code("P2")
        elif unit_type != "table":
            add_code("P1")

    return flags, suggested_codes


def detect_chunk_rule_flags(
    content: str, min_chars: int = 50, max_chars: int = 2600
) -> List[str]:
    flags: List[str] = []
    stripped = (content or "").strip()
    n = len(stripped)

    if n == 0:
        flags.append("EMPTY")
    elif n < min_chars:
        flags.append("TOO_SHORT")
    if n > max_chars:
        flags.append("TOO_LONG")

    # Page number / pure numeric noise
    if re.fullmatch(r"[\d\s\-/.,|]+", stripped) and n > 0:
        flags.append("NUMERIC_ONLY_NOISE")

    # Common Vietnamese/web boilerplate noise
    lower = stripped.lower()
    noise_patterns = [
        r"trang\s+\d+\s*/\s*\d+",
        r"bản quyền thuộc về",
        r"cookie|privacy policy|đăng nhập|đăng ký ngay|tìm kiếm\.\.\.",
    ]
    if any(re.search(p, lower) for p in noise_patterns):
        flags.append("SUSPECTED_NOISE")

    # Garbled / replacement characters (OCR / encoding)
    if re.search(r"[\ufffd\x00-\x08\x0b\x0c\x0e-\x1f]", stripped):
        flags.append("CHAR_CORRUPTION")

    return flags


def detect_duplicates(chunks: List[Dict[str, Any]], threshold: float = 0.85) -> Dict[int, List[int]]:
    """Find near-duplicate chunks within a run using normalized prefix + SequenceMatcher."""
    dup_map: Dict[int, List[int]] = {}
    normed = [(c["id"], normalize_text(c["content"])) for c in chunks]
    n = len(normed)
    for i in range(n):
        id_i, txt_i = normed[i]
        if len(txt_i) < 40:
            continue
        for j in range(i + 1, n):
            id_j, txt_j = normed[j]
            if len(txt_j) < 40:
                continue
            # Fast length ratio pre-filter
            ratio_len = min(len(txt_i), len(txt_j)) / max(len(txt_i), len(txt_j))
            if ratio_len < 0.7:
                continue
            sim = SequenceMatcher(None, txt_i[:500], txt_j[:500]).ratio()
            if sim >= threshold:
                dup_map.setdefault(id_i, []).append(id_j)
                dup_map.setdefault(id_j, []).append(id_i)
    return dup_map


def _expand_to_word_bounds(text: str, start: int, end: int) -> Tuple[int, int]:
    n = len(text)
    s = max(0, min(start, n))
    e = max(s, min(end, n))
    while s > 0 and not text[s - 1].isspace():
        s -= 1
    while e < n and not text[e].isspace():
        e += 1
    return s, e


def extract_best_aligned_span(
    source_text: str, chunk_content: str, unit_type: str = "text", format_group: str = ""
) -> Dict[str, Any]:
    """
    Uses RapidFuzz partial_ratio_alignment to locate the exact substring of `chunk_content`
    that best matches `source_text`, even with OCR typos, missing Vietnamese accents, or
    reformatted line breaks.
    """
    src_raw = nfc(source_text).strip()
    chk_input = _html_table_to_pipe(chunk_content) if unit_type == "table" else chunk_content
    chk_raw = nfc(chk_input).strip()
    if not src_raw or not chk_raw:
        return {
            "matched_excerpt": "",
            "start": 0,
            "end": 0,
            "raw_similarity": 0.0,
            "text_similarity": 0.0,
            "has_format_diff": False,
            "has_text_diff": True,
            "suggested_verdict": "FAIL",
            "stitched_with_chunk_index": None,
            "risk_flags": [{"code": "MISSING_CONTENT", "label": "Không tìm thấy nội dung khớp", "severity": "Nghiêm trọng"}],
            "suggested_error_codes": ["P1"],
        }

    src_low = src_raw.lower()
    chk_low = chk_raw.lower()
    aln = fuzz.partial_ratio_alignment(src_low, chk_low)

    if aln is not None and aln.dest_end > aln.dest_start:
        s, e = _expand_to_word_bounds(chk_raw, aln.dest_start, aln.dest_end)
        excerpt = chk_raw[s:e].strip()
    else:
        s, e = 0, len(chk_raw)
        excerpt = chk_raw

    raw_sim = round(float(fuzz.ratio(src_raw, excerpt)), 2)
    src_collapsed = collapse_whitespace(src_raw)
    exc_collapsed = collapse_whitespace(excerpt)
    text_sim = round(float(fuzz.ratio(src_collapsed, exc_collapsed)), 2)

    has_text_diff = src_collapsed != exc_collapsed
    has_format_diff = (not has_text_diff) and (src_raw != excerpt)

    risk_flags, suggested_codes = analyze_parsing_risks(
        src_raw, excerpt, unit_type=unit_type, text_sim=text_sim, format_group=format_group
    )
    has_critical = any(f["severity"] == "Nghiêm trọng" for f in risk_flags)

    if text_sim >= 98.0 and not has_critical:
        suggested = "PASS"
    elif text_sim >= 72.0:
        suggested = "PARTIAL"
    else:
        suggested = "FAIL"

    return {
        "matched_excerpt": excerpt,
        "start": s,
        "end": e,
        "raw_similarity": raw_sim,
        "text_similarity": text_sim,
        "has_format_diff": has_format_diff,
        "has_text_diff": has_text_diff,
        "suggested_verdict": suggested,
        "stitched_with_chunk_index": None,
        "risk_flags": risk_flags,
        "suggested_error_codes": suggested_codes,
    }


def extract_best_aligned_span_with_stitching(
    source_text: str,
    chunk_content: str,
    prev_chunk_content: str = "",
    prev_chunk_index: int | None = None,
    next_chunk_content: str = "",
    next_chunk_index: int | None = None,
    unit_type: str = "text",
    format_group: str = "",
) -> Dict[str, Any]:
    """
    Prevents false-FAIL and boundary false-flags when RAGFlow splits one paragraph across
    consecutive chunks: tries stitching with both prev_chunk (i-1) and next_chunk (i+1)
    whenever single-chunk similarity < 99.5% or has risk flags, picking the best match.
    """
    base = extract_best_aligned_span(source_text, chunk_content, unit_type=unit_type, format_group=format_group)
    if base["text_similarity"] >= 99.5 and not base["risk_flags"]:
        return base

    best = base
    candidates = []
    if prev_chunk_content:
        candidates.append((f"{prev_chunk_content}\n{chunk_content}", prev_chunk_index))
    if next_chunk_content:
        candidates.append((f"{chunk_content}\n{next_chunk_content}", next_chunk_index))

    for combined, neighbor_idx in candidates:
        stitched = extract_best_aligned_span(source_text, combined, unit_type=unit_type, format_group=format_group)
        better_sim = stitched["text_similarity"] >= best["text_similarity"] + 1.0
        fewer_risks = (
            stitched["text_similarity"] >= best["text_similarity"]
            and len(stitched["risk_flags"]) < len(best["risk_flags"])
        )
        if better_sim or fewer_risks:
            stitched["stitched_with_chunk_index"] = neighbor_idx
            best = stitched

    return best


def align_unit_to_chunks(
    source_text: str, chunks: List[Dict[str, Any]], top_n: int = 3
) -> Tuple[List[str], float]:
    """Fuzzy-align a source ground-truth paragraph/table to parsed chunks using RapidFuzz."""
    src_norm = normalize_text(source_text)
    if not src_norm:
        return [], 0.0
    src_tokens = set(re.findall(r"\w+", src_norm))
    if not src_tokens:
        return [], 0.0

    scored = []
    for ch in chunks:
        c_norm = normalize_text(ch.get("content", ""))
        if not c_norm:
            continue
        if src_norm[:120] in c_norm:
            score = 0.99
        else:
            pr = fuzz.partial_ratio(src_norm, c_norm) / 100.0
            c_tokens = set(re.findall(r"\w+", c_norm))
            overlap = len(src_tokens & c_tokens) / max(len(src_tokens), 1)
            score = round(max(pr * 0.7 + overlap * 0.3, overlap), 4)
        if score >= 0.45:
            scored.append((score, ch.get("ragflow_chunk_id", "")))

    scored.sort(key=lambda x: x[0], reverse=True)
    matched_ids = [cid for _, cid in scored[:top_n]]
    best_score = scored[0][0] if scored else 0.0
    return matched_ids, best_score


def compute_contextual_precision(relevancies: List[int]) -> float:
    """
    Standard Contextual Precision (Average Precision @ K):
    AP = (1 / R) * sum_{k=1..K} (Precision@k * rel(k))
    """
    total_rel = sum(1 for r in relevancies if r == 1)
    if total_rel == 0:
        return 0.0
    running_rel = 0
    prec_sum = 0.0
    for idx, rel in enumerate(relevancies, start=1):
        if rel == 1:
            running_rel += 1
            prec_sum += running_rel / idx
    return round(prec_sum / total_rel, 4)


def compute_answer_containment(reference_context: str, chunks: List[Dict[str, Any]]) -> str:
    """
    Check if reference_context is contained in 1 single chunk (FULL),
    split across multiple chunks (SPLIT), or missing (MISSING).
    """
    ref_tokens = set(re.findall(r"\w+", normalize_text(reference_context)))
    if not ref_tokens:
        return "UNCHECKED"

    best_single = 0.0
    covered_union = set()
    for ch in chunks:
        c_tokens = set(re.findall(r"\w+", normalize_text(ch.get("content", ""))))
        inter = ref_tokens & c_tokens
        ratio = len(inter) / len(ref_tokens)
        if ratio > best_single:
            best_single = ratio
        if ratio >= 0.2:
            covered_union |= inter

    if best_single >= 0.78:
        return "FULL"
    if len(covered_union) / len(ref_tokens) >= 0.72:
        return "SPLIT"
    return "MISSING"
