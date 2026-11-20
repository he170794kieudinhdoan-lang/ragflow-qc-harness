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
    {"code": "C1", "group": "Vỡ bảng", "name": "Vỡ bảng khi cắt chunk", "severity": "Nghiêm trọng", "metric": "Chunk Integrity"},
    {"code": "C2", "group": "Cắt sai ranh giới", "name": "Cắt sai ranh giới", "severity": "Trung bình", "metric": "Chunk Integrity"},
    {"code": "C3", "group": "Thiếu ngữ cảnh", "name": "Thiếu ngữ cảnh", "severity": "Trung bình", "metric": "Context Sufficiency"},
    {"code": "C4", "group": "Nhiễu", "name": "Chunk chứa nội dung nhiễu", "severity": "Trung bình", "metric": "Noise Rate"},
    {"code": "C5", "group": "Nhiễu", "name": "Chunk rỗng / chunk rác", "severity": "Nhẹ", "metric": "Noise Rate"},
    {"code": "C6", "group": "Trùng lặp", "name": "Trùng lặp do cắt chunk", "severity": "Trung bình", "metric": "Duplicate Rate"},
    {"code": "C7", "group": "Trùng lặp", "name": "Thừa nội dung / trùng lặp", "severity": "Trung bình", "metric": "Duplicate Rate"},
    {"code": "C8", "group": "Kích thước bất thường", "name": "Kích thước bất thường", "severity": "Nhẹ", "metric": "Size Compliance"},
]

RETRIEVAL_ERROR_CATALOG = [
    {"code": "R1", "group": "Miss nhánh keyword", "name": "Miss nhánh keyword", "severity": "Nghiêm trọng", "layer": "KEYWORD"},
    {"code": "R2", "group": "Miss nhánh vector", "name": "Miss nhánh vector", "severity": "Nghiêm trọng", "layer": "VECTOR"},
    {"code": "R3", "group": "Lỗi rerank", "name": "Lỗi rerank", "severity": "Trung bình", "layer": "RERANK"},
    {"code": "R4", "group": "Lỗi ngưỡng / top-k", "name": "Lỗi ngưỡng / top-k", "severity": "Trung bình", "layer": "THRESHOLD"},
    {"code": "R5", "group": "Nhiễu tài liệu tương tự", "name": "Nhiễu tài liệu tương tự", "severity": "Trung bình", "layer": "SIMILAR_DOC"},
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


def detect_duplicates_classified(
    chunks: List[Dict[str, Any]], threshold: float = 0.85
) -> Tuple[set, set]:
    """
    Returns (adjacent_dup_ids [C6], far_dup_ids [C7]) using RapidFuzz C++:
    - C6: high similarity or heavy boundary overlap between consecutive chunks of the same doc.
    - C7: high similarity between non-adjacent chunks (redundant content).
    """
    adjacent_dups = set()
    far_dups = set()
    normed = [
        (c["id"], c.get("document_id"), c.get("chunk_index", 0), normalize_text(c["content"]))
        for c in chunks
    ]
    cutoff = threshold * 100.0
    n = len(normed)
    for i in range(n):
        id_i, doc_i, idx_i, txt_i = normed[i]
        if len(txt_i) < 40:
            continue
        pref_i = txt_i[:500]
        for j in range(i + 1, n):
            id_j, doc_j, idx_j, txt_j = normed[j]
            if len(txt_j) < 40:
                continue
            is_adj = doc_i == doc_j and abs(idx_i - idx_j) == 1
            if is_adj:
                tail_i = txt_i[-220:]
                head_j = txt_j[:260]
                if len(tail_i) >= 60 and fuzz.partial_ratio(tail_i, head_j, score_cutoff=88.0) >= 88.0:
                    adjacent_dups.add(id_i)
                    adjacent_dups.add(id_j)
                    continue
            if min(len(pref_i), len(txt_j[:500])) / max(len(pref_i), len(txt_j[:500])) < 0.7:
                continue
            sim = fuzz.ratio(pref_i, txt_j[:500], score_cutoff=cutoff)
            if sim >= cutoff:
                if is_adj:
                    adjacent_dups.add(id_i)
                    adjacent_dups.add(id_j)
                else:
                    far_dups.add(id_i)
                    far_dups.add(id_j)
    return adjacent_dups, far_dups


_AMBIGUOUS_START_RE = re.compile(
    r"^(?:tuy nhiên|do đó|vì vậy|ngoài ra|bên cạnh đó|theo đó|trong đó|những người này|đối tượng này|các đối tượng này|nhóm này|thuốc này|phác đồ này|điều này|họ\s|nó\s|[-•+*]\s)",
    re.IGNORECASE,
)


def analyze_chunk_rules(
    chunk: Dict[str, Any],
    prev_content: str = "",
    next_content: str = "",
    repeated_lines: set | None = None,
    is_adj_dup: bool = False,
    is_far_dup: bool = False,
    min_chars: int = 50,
    max_chars: int = 2600,
) -> Dict[str, Any]:
    """
    0-LLM Chunking QC rule engine aligned with Phụ lục A (6 metrics) & Phụ lục B (C1..C8).
    """
    raw = nfc(chunk.get("content") or "").strip()
    n = len(raw)
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    flags: List[str] = []
    codes: List[str] = []

    def add(code: str, flag: str = ""):
        if code not in codes:
            codes.append(code)
        if flag and flag not in flags:
            flags.append(flag)

    alpha_cnt = sum(1 for c in raw if c.isalpha())
    is_junk = n == 0 or alpha_cnt < 12 or bool(re.fullmatch(r"[\d\s\-/.,|]+", raw))
    if n == 0:
        add("C5", "EMPTY")
    elif is_junk:
        add("C5", "NUMERIC_ONLY_NOISE")

    lower = raw.lower()
    has_td = "<td" in lower or "<tr" in lower
    has_table_open = "<table" in lower
    has_table_close = "</table" in lower
    # Intact table exception (DOC07 #3, DOC11 #3): balanced standalone tables are exempt from C8 TOO_LONG
    is_intact_table = has_table_open and has_table_close and (lower.count("<table") == lower.count("</table"))

    if 0 < n < min_chars:
        add("C8", "TOO_SHORT")
    elif n > max_chars and not is_intact_table:
        add("C8", "TOO_LONG")
    has_rep_line = bool(repeated_lines and any(ln in repeated_lines for ln in lines))
    if has_rep_line or any(re.search(p, lower) for p in noise_patterns):
        add("C4", "SUSPECTED_NOISE")

    if is_adj_dup:
        add("C6", "ADJACENT_DUPLICATE")
    if is_far_dup:
        add("C7", "DUPLICATE")

    has_td = "<td" in lower or "<tr" in lower
    has_table_open = "<table" in lower
    has_table_close = "</table" in lower
    prev_has_td = "<td" in (prev_content or "").lower()
    next_has_td = "<td" in (next_content or "").lower()
    if has_td and ((has_table_open != has_table_close) or (not has_table_open) or prev_has_td or next_has_td):
        add("C1", "BROKEN_TABLE")

    if not is_junk and not has_td and lines:
        first_ch = lines[0][0]
        last_line = lines[-1]
        last_ch = last_line[-1]
        starts_mid = first_ch.islower() or first_ch in ",;)]"
        ends_mid = last_ch not in ".!?:;\"')]" and not _HEADING_LINE_RE.match(last_line) and len(last_line) > 30
        trailing_colon = last_ch == ":" and len(lines) <= 2 and bool(next_content.strip())
        if starts_mid or ends_mid or trailing_colon:
            add("C2", "BAD_BOUNDARY")

    if not is_junk and lines:
        first_line = lines[0]
        has_heading = bool(
            _HEADING_LINE_RE.match(first_line)
            or first_line.startswith("#")
            or (len(first_line) <= 100 and sum(1 for c in first_line if c.isupper()) >= max(6, int(0.75 * max(1, sum(1 for c in first_line if c.isalpha())))))
        )
        if not has_heading and (_AMBIGUOUS_START_RE.match(first_line) or first_line[0].islower()):
            add("C3", "LOW_CONTEXT")

    integrity = 0 if ("C1" in codes or "C2" in codes) else 1
    context_sufficiency = 0 if ("C3" in codes or "C5" in codes) else 1
    no_noise = 0 if ("C4" in codes or "C5" in codes) else 1
    no_duplicate = 0 if ("C6" in codes or "C7" in codes) else 1
    valid_size = 0 if ("C8" in codes or "C5" in codes) else 1

    return {
        "integrity": integrity,
        "context_sufficiency": context_sufficiency,
        "no_noise": no_noise,
        "no_duplicate": no_duplicate,
        "valid_size": valid_size,
        "error_codes": codes,
        "rule_flags": flags,
    }


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


def score_chunk_relevance(reference_context: str, chunk_content: str) -> Tuple[int, str]:
    """0-LLM RapidFuzz relevance pre-scorer comparing a retrieved chunk to reference_context."""
    ref_norm = normalize_text(reference_context)
    chk_norm = normalize_text(chunk_content)
    if not ref_norm or not chk_norm:
        return 0, ""
    if ref_norm[:100] in chk_norm:
        return 1, "Khớp trực tiếp đoạn căn cứ"
    pr = float(fuzz.partial_ratio(ref_norm[:600], chk_norm))
    ref_tokens = set(re.findall(r"\w+", ref_norm))
    chk_tokens = set(re.findall(r"\w+", chk_norm))
    overlap = len(ref_tokens & chk_tokens) / max(len(ref_tokens), 1)
    if pr >= 72.0 or overlap >= 0.55:
        return 1, f"Tự động khớp (RapidFuzz {pr:.0f}%, từ khóa {overlap*100:.0f}%)"
    return 0, ""


def compute_context_coverage(reference_context: str, retrieved_chunks: List[Dict[str, Any]]) -> float:
    """
    Computes Context Coverage (Phụ lục A): fraction of essential tokens from reference_context
    present in the union of Top-K retrieved chunks (order-independent).
    """
    ref_tokens = {t for t in re.findall(r"\w+", normalize_text(reference_context)) if len(t) >= 2}
    if not ref_tokens:
        return 0.0
    union_tokens = set()
    for ch in retrieved_chunks:
        txt = ch.get("content") or ch.get("content_with_weight") or ""
        union_tokens |= {t for t in re.findall(r"\w+", normalize_text(txt)) if len(t) >= 2}
    return round(len(ref_tokens & union_tokens) / len(ref_tokens), 4)
