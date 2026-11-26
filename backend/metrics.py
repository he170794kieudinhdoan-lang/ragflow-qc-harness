import hashlib
import re
import unicodedata
from difflib import SequenceMatcher
from typing import Any, Dict, List, Tuple
from rapidfuzz import fuzz


PARSING_ERROR_CATALOG = [
    {"code": "TEXT", "group": "Thiếu chữ / OCR", "name": "Thiếu chữ, sai số liệu hoặc lỗi dấu/OCR", "severity": "Nghiêm trọng", "metric": "Text Completeness"},
    {"code": "TABLE", "group": "Vỡ bảng", "name": "Vỡ cấu trúc bảng, mất hàng/cột hoặc lệch ô", "severity": "Nghiêm trọng", "metric": "Table Accuracy"},
    {"code": "ORDER", "group": "Sai thứ tự", "name": "Đảo cột, trộn dòng hoặc sai thứ tự đọc", "severity": "Trung bình", "metric": "Reading Order"},
    {"code": "LAYOUT", "group": "Hình / Bố cục", "name": "Mất nội dung sơ đồ/ảnh hoặc vỡ heading/danh sách", "severity": "Nghiêm trọng", "metric": "Layout Accuracy"},
]

CHUNKING_ERROR_CATALOG = [
    {"code": "INTEGRITY", "group": "Toàn vẹn đoạn", "name": "Cắt ngang câu / danh sách hoặc vỡ bảng", "severity": "Nghiêm trọng", "metric": "Chunk Integrity"},
    {"code": "CONTEXT", "group": "Thiếu ngữ cảnh", "name": "Đọc độc lập thiếu chủ thể / ngữ cảnh", "severity": "Trung bình", "metric": "Context Sufficiency"},
    {"code": "NOISE", "group": "Nhiễu / Rác", "name": "Chứa menu web, header/footer, OCR rác, chunk rỗng", "severity": "Trung bình", "metric": "Noise Rate"},
    {"code": "DUPLICATE", "group": "Trùng lặp", "name": "Lặp nội dung giữa các chunk hoặc lặp header", "severity": "Trung bình", "metric": "Duplicate Rate"},
    {"code": "SIZE", "group": "Kích thước", "name": "Quá ngắn hoặc quá dài bất thường", "severity": "Nhẹ", "metric": "Size Compliance"},
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


_ZERO_WIDTH_RE = re.compile(r"[\u200b\u200c\u200d\ufeff\u00ad]")
_MD_IMG_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\((?:<[^>]+>|[^()]*|\([^()]*\))*\)")
_MD_ESCAPE_RE = re.compile(r"\\([.\-*_#()\[\]])")
_MD_HEADING_PREFIX_RE = re.compile(r"(?m)^\s*#{1,6}\s+")


def canonicalize_text(text: str) -> str:
    """
    Document-agnostic canonical normalization for both ground-truth source_text and parsed chunks:
    strips invisible Unicode chars, normalizes dashes/quotes/NBSP, removes Markdown link URLs
    (including quoted titles) & inline markup so comparison measures semantic text fidelity.
    """
    t = nfc(text or "")
    t = _ZERO_WIDTH_RE.sub("", t)
    t = t.replace("\u00a0", " ")
    t = t.replace("–", "-").replace("—", "-").replace("−", "-")
    t = t.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    t = _MD_IMG_RE.sub(r"\1", t)
    t = _MD_LINK_RE.sub(r"\1", t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"\1", t)
    t = re.sub(r"__([^_]+)__", r"\1", t)
    t = re.sub(r"`([^`]+)`", r"\1", t)
    t = _MD_ESCAPE_RE.sub(r"\1", t)
    t = _MD_HEADING_PREFIX_RE.sub("", t)
    return t


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", canonicalize_text(text).strip().lower())


def collapse_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", canonicalize_text(text).strip())


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


def _extract_table_rows(text: str) -> List[List[str]]:
    """Extract normalized non-empty rows of cells from pipe-delimited or HTML table text."""
    pipe_txt = _html_table_to_pipe(text)
    rows: List[List[str]] = []
    for ln in nfc(pipe_txt).splitlines():
        cells = [normalize_text(raw_cell) for raw_cell in ln.split("|")]
        cells = [c for c in cells if c]
        if cells:
            rows.append(cells)
    return rows


def _extract_table_cells(text: str) -> List[str]:
    """Extract normalized non-empty table cells from either pipe-delimited or HTML table text."""
    return [c for row in _extract_table_rows(text) for c in row]


def _cell_matches(src_cell: str, cand_cells: List[str], cand_row_flat: str) -> bool:
    """Match a single source cell against candidate row cells; short cells require exact cell match."""
    if src_cell in cand_cells:
        return True
    if len(src_cell) < 4:
        return False
    if src_cell in cand_row_flat:
        return True
    return any(float(fuzz.partial_ratio(src_cell, cc)) >= 88.0 for cc in cand_cells if len(cc) >= 3)


def _compute_table_cell_recall(source_text: str, candidate_text: str) -> float:
    """
    Fast structure-aware table evaluation (O(R*C)): matches source rows against candidate rows
    using an inverted cell index while preserving row grouping and relative column order,
    preventing scrambled-column false PASS without O(R^2*C^2) slowdowns on huge Excel sheets.
    """
    src_rows = _extract_table_rows(source_text)
    if not src_rows:
        return 0.0
    cand_rows = _extract_table_rows(candidate_text)
    if not cand_rows:
        return 0.0

    has_cand_structure = (
        len(cand_rows) >= 2
        or "<td" in candidate_text.lower()
        or "<tr" in candidate_text.lower()
        or "|" in candidate_text
    )

    total_cells = sum(len(r) for r in src_rows)
    if total_cells == 0:
        return 0.0

    # Inverted index: cell -> candidate row indices for O(1) candidate row lookup
    cell_to_rows: Dict[str, List[int]] = {}
    for c_idx, c_row in enumerate(cand_rows):
        for cc in set(c_row):
            cell_to_rows.setdefault(cc, []).append(c_idx)

    use_fuzzy = len(src_rows) <= 35 and len(cand_rows) <= 60
    matched_cells = 0.0
    used_cand_rows = set()

    for s_idx, s_row in enumerate(src_rows):
        # Gather candidate rows that share at least one exact cell; fallback to nearby rows
        cand_counts: Dict[int, int] = {}
        for s_cell in s_row:
            for c_idx in cell_to_rows.get(s_cell, ()):
                if c_idx not in used_cand_rows:
                    cand_counts[c_idx] = cand_counts.get(c_idx, 0) + 1

        if cand_counts:
            top_cands = sorted(cand_counts.keys(), key=lambda i: cand_counts[i], reverse=True)[:5]
        elif use_fuzzy:
            top_cands = [i for i in range(max(0, s_idx - 3), min(len(cand_rows), s_idx + 4)) if i not in used_cand_rows]
        else:
            top_cands = []

        best_row_score = 0.0
        best_row_idx = -1
        for c_idx in top_cands:
            c_row = cand_rows[c_idx]
            c_set = set(c_row)
            row_hits = 0.0
            last_pos = -1
            for s_cell in s_row:
                found_idx = -1
                for j in range(last_pos + 1, len(c_row)):
                    cc = c_row[j]
                    if s_cell == cc:
                        found_idx = j
                        break
                    if len(s_cell) >= 4 and (s_cell in cc or (use_fuzzy and len(cc) >= 3 and float(fuzz.partial_ratio(s_cell, cc)) >= 88.0)):
                        found_idx = j
                        break
                if found_idx != -1:
                    row_hits += 1.0
                    last_pos = found_idx
                elif s_cell in c_set:
                    # Out-of-order cell in same row gets half credit
                    row_hits += 0.5
            if row_hits > best_row_score:
                best_row_score = row_hits
                best_row_idx = c_idx

        if best_row_idx != -1:
            used_cand_rows.add(best_row_idx)
            matched_cells += best_row_score

    score = (matched_cells / total_cells) * 100.0
    if len(src_rows) >= 2 and not has_cand_structure:
        score = min(score, 65.0)
    return round(score, 2)


def strip_diacritics(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text or "")
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return stripped.replace("đ", "d").replace("Đ", "D")


_NUM_TOKEN_RE = re.compile(
    r"(?:<=|>=|[<>±])?\s*\d+(?:[.,]\d+)?(?:\s*(?:%|mg|ml|g|kg|vnd|usd|tỷ|triệu|/l|/mm3|mm3|tuần|tháng|ngày|giờ|năm))?",
    re.IGNORECASE,
)
# Leading structural numbering (e.g. "4. ", "2.1. ", "Điều 5: ") that should not trigger CRITICAL_NUM_DIFF
_LEADING_STRUCT_NUM_RE = re.compile(
    r"^\s*(?:(?:chương|phần|mục|điều|khoản|bài|câu)\s+\d+[.:)]?\s*|\d+(?:\.\d+)*[.)]\s+)",
    re.IGNORECASE,
)
# Universal domain-agnostic polarity & obligation terms (matched with word boundaries)
_NEGATION_TERMS = [
    "chống chỉ định",
    "không chỉ định",
    "nghiêm cấm",
    "miễn trừ",
    "ngoại trừ",
    "bắt buộc",
    "tối thiểu",
    "tối đa",
    "âm tính",
    "dương tính",
    "trước thuế",
    "sau thuế",
    "không",
    "chưa",
    "cấm",
]
_NEGATION_TERM_RES = [
    (term, re.compile(rf"(?<!\w){re.escape(term)}(?!\w)", re.IGNORECASE))
    for term in _NEGATION_TERMS
]


def _extract_num_multiset(text: str, strip_leading_struct: bool = False) -> Dict[str, int]:
    t = canonicalize_text(text)
    if strip_leading_struct:
        t = _LEADING_STRUCT_NUM_RE.sub("", t)
    counts: Dict[str, int] = {}
    for m in _NUM_TOKEN_RE.findall(t):
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
        code = "P2" if unit_type in ("image", "diagram") or "scan" in (format_group or "").lower() else "P1"
        flags.append({"code": "MISSING_CONTENT", "label": f"Không tìm thấy nội dung khớp ({code})", "severity": "Nghiêm trọng"})
        return flags, [code]

    # P5: Garbage / corrupted characters
    if re.search(r"[\ufffd\x00-\x08\x0b\x0c\x0e-\x1f]", exc_c):
        flags.append({"code": "GARBAGE_CHAR", "label": "Phát hiện ký tự rác / lỗi mã hóa (P5)", "severity": "Trung bình"})
        add_code("P5")

    # P4: Vietnamese diacritic loss/corruption — only trigger when texts actually match after stripping diacritics
    # (prevents false P4 when two unrelated short phrases happen to share ASCII letters)
    has_diacritic_issue = False
    if src_c.lower() != exc_c.lower():
        acc_sim = float(fuzz.ratio(src_c.lower(), exc_c.lower()))
        no_acc_sim = float(fuzz.ratio(strip_diacritics(src_c.lower()), strip_diacritics(exc_c.lower())))
        word_diacritic_lost = False
        if no_acc_sim >= 80.0 and no_acc_sim - acc_sim < 1.5:
            src_words = set(re.findall(r"[^\W\d_]{2,}", src_c.lower()))
            exc_words = set(re.findall(r"[^\W\d_]{2,}", exc_c.lower()))
            for w in src_words - exc_words:
                stripped = strip_diacritics(w)
                if stripped != w and stripped in exc_words and stripped not in src_words:
                    word_diacritic_lost = True
                    break
        if (no_acc_sim >= 85.0 and (no_acc_sim - acc_sim >= 1.5)) or word_diacritic_lost:
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

    # P3: Scrambled reading order — require substantial text (>=80 chars) and true word-order inversion
    # (token_sort_ratio >> text_sim, not just 1 extra inserted word)
    if len(src_c) >= 80 and len(exc_c) >= 80 and text_sim < 85.0:
        tok_sort = float(fuzz.token_sort_ratio(src_c.lower(), exc_c.lower()))
        if tok_sort >= 88.0 and (tok_sort - text_sim) >= 10.0:
            flags.append({
                "code": "READING_ORDER_SCRAMBLED",
                "label": "Nghi đảo thứ tự dòng / trộn cột (P3)",
                "severity": "Nghiêm trọng",
            })
            add_code("P3")

    # P10 / P3: Critical numeric / operator mismatch (both missing AND extra/duplicated numbers;
    # ignore leading structural numbering like "4. " on non-table text units)
    strip_struct = unit_type != "table"
    src_nums = _extract_num_multiset(src_c, strip_leading_struct=strip_struct)
    exc_nums = _extract_num_multiset(exc_c, strip_leading_struct=strip_struct)
    if src_nums != exc_nums and (src_nums or exc_nums):
        missing_nums = [k for k, v in src_nums.items() if exc_nums.get(k, 0) < v]
        extra_nums = [k for k, v in exc_nums.items() if src_nums.get(k, 0) < v]
        if missing_nums or extra_nums:
            parts = []
            if missing_nums:
                parts.append(f"thiếu {', '.join(missing_nums[:3])}")
            if extra_nums:
                parts.append(f"dư {', '.join(extra_nums[:3])}")
            err_code = "P10" if unit_type == "table" else "P3"
            flags.append({
                "code": "CRITICAL_NUM_DIFF",
                "label": f"Lệch số liệu ({'; '.join(parts)}) ({err_code})",
                "severity": "Nghiêm trọng",
            })
            add_code(err_code)

    # P3: Critical negation / polarity flip (word-boundary regex, domain-agnostic)
    src_low = src_c.lower()
    exc_low = exc_c.lower()
    diff_terms = [
        term for term, rx in _NEGATION_TERM_RES
        if len(rx.findall(src_low)) != len(rx.findall(exc_low))
    ]
    if diff_terms:
        flags.append({
            "code": "CRITICAL_NEGATION_DIFF",
            "label": f"Lệch từ phủ định/đối lập: {', '.join(diff_terms[:3])} (P3)",
            "severity": "Nghiêm trọng",
        })
        add_code("P3")

    # P9: Table structure broken (cell-level recall, tolerant to colspan/rowspan formatting)
    if unit_type == "table":
        cell_recall = _compute_table_cell_recall(source_text, excerpt)
        if cell_recall < 80.0 and text_sim < 85.0:
            flags.append({
                "code": "TABLE_BROKEN",
                "label": f"Bảng nghi bị vỡ/thiếu ô (Cell recall {cell_recall:.0f}%) (P9)",
                "severity": "Nghiêm trọng",
            })
            add_code("P9")
    else:
        src_lines = [ln.strip() for ln in nfc(source_text).splitlines() if ln.strip()]
        exc_lines = [ln.strip() for ln in nfc(excerpt).splitlines() if ln.strip()]
        # P7: Heading merged into body paragraph (check first line even if excerpt has > 1 line)
        if len(src_lines) >= 2 and _HEADING_LINE_RE.match(src_lines[0]) and len(src_lines[0]) <= 110:
            if exc_lines and len(exc_lines[0]) > len(src_lines[0]) + 25:
                add_code("P7")
        # P8: List merged
        src_list_cnt = sum(1 for ln in src_lines if _LIST_LINE_RE.match(ln))
        exc_list_cnt = sum(1 for ln in exc_lines if _LIST_LINE_RE.match(ln))
        if src_list_cnt >= 2 and exc_list_cnt < src_list_cnt:
            add_code("P8")

    # Severe missing content -> P2 / P1
    if text_sim < 72.0:
        if unit_type in ("image", "diagram") or "scan" in (format_group or "").lower():
            add_code("P2")
        elif unit_type != "table":
            add_code("P1")

    return flags, suggested_codes


_CHUNK_NOISE_PATTERNS = [
    r"\btrang\s+\d+\s*/\s*\d+\b",
    r"\bpage\s+\d+\s+of\s+\d+\b",
    r"bản quyền|copyright|all rights reserved",
    r"cookie|privacy policy|đăng nhập|đăng ký ngay|tìm kiếm\.\.\.",
    r"mục lục|table of contents",
]


def detect_chunk_rule_flags(
    content: str, min_chars: int = 50, max_chars: int = 2600, exempt_intact_table: bool = True
) -> List[str]:
    """
    Lightweight single-chunk flag detector used during chunk sync; shares the exact same
    size, table-exemption, noise, and char-corruption definitions as `analyze_chunk_rules`.
    """
    res = analyze_chunk_rules(
        {"content": content},
        min_chars=min_chars,
        max_chars=max_chars,
        exempt_intact_table=exempt_intact_table,
    )
    # Keep sync-time flags focused on per-chunk anomalies (exclude boundary/neighbor flags that need prev/next context)
    return [f for f in res["rule_flags"] if f not in ("BROKEN_TABLE", "BAD_BOUNDARY", "LOW_CONTEXT")]


def compute_weighted_chunking_rates(
    rows: List[Any],
    doc_totals: Dict[Any, int],
) -> Dict[str, Any]:
    """
    Single source of truth for Chunking metrics using Cochran (1977) Stratified Weighted Estimator:
        P_hat = sum_h (N_h * p_h) / sum_h N_h
    where N_h is the true total chunk count of document h and p_h is its sampled pass/error rate.
    Used consistently across Step 3 (ChunkingPage), Step 5 (Analytics/Compare), and Excel export.
    """
    by_doc: Dict[Any, List[Any]] = {}
    for r in rows:
        did = r["document_id"]
        by_doc.setdefault(did, []).append(r)

    def _unweighted(field: str, invert: bool = False) -> float:
        vals = [r[field] for r in rows if r[field] is not None]
        if not vals:
            return 0.0
        ok = sum(1 for v in vals if (v == 0 if invert else v == 1))
        return round(ok / len(vals), 4)

    def _weighted(field: str, invert: bool = False) -> float:
        num = 0.0
        den = 0.0
        for doc_id, doc_rows in by_doc.items():
            vals = [r[field] for r in doc_rows if r[field] is not None]
            if not vals:
                continue
            ok = sum(1 for v in vals if (v == 0 if invert else v == 1))
            p_h = ok / len(vals)
            w_h = float(doc_totals.get(doc_id, len(vals)))
            num += w_h * p_h
            den += w_h
        if den <= 0:
            return _unweighted(field, invert=invert)
        return round(num / den, 4)

    return {
        "chunk_integrity": _weighted("integrity"),
        "context_sufficiency": _weighted("context_sufficiency"),
        "noise_rate": _weighted("no_noise", invert=True),
        "duplicate_rate": _weighted("no_duplicate", invert=True),
        "valid_size_rate": _weighted("valid_size"),
        "unweighted": {
            "chunk_integrity": _unweighted("integrity"),
            "context_sufficiency": _unweighted("context_sufficiency"),
            "noise_rate": _unweighted("no_noise", invert=True),
            "duplicate_rate": _unweighted("no_duplicate", invert=True),
            "valid_size_rate": _unweighted("valid_size"),
        },
    }


def _dup_compare_text(raw: str) -> str:
    """
    For HTML table chunks, strip repeated <caption>/<th> headers and HTML tag boilerplate
    (<table>, <tr>, <td>) so duplicate detection compares actual cell data values only.
    """
    txt = raw or ""
    low = txt.lower()
    if "<table" in low and "<td" in low:
        stripped = re.sub(r"<caption\b[^>]*>.*?</caption>", " ", txt, flags=re.I | re.S)
        stripped = re.sub(r"<th\b[^>]*>.*?</th>", " ", stripped, flags=re.I | re.S)
        stripped = re.sub(r"<[^>]+>", " ", stripped)
        return normalize_text(stripped)
    return normalize_text(txt)


def detect_duplicates_classified(
    chunks: List[Dict[str, Any]], threshold: float = 0.85, adj_overlap_threshold: float = 88.0
) -> Tuple[set, set]:
    """
    Returns (adjacent_dup_ids, far_dup_ids) using RapidFuzz C++:
    - adjacent_dup_ids: high similarity or heavy boundary overlap between consecutive chunks of the same doc.
    - far_dup_ids: high similarity between non-adjacent chunks (redundant content).
    For HTML tables, compares <td> data rows (excluding repeated <th>/<caption> headers).
    """
    adjacent_dups = set()
    far_dups = set()
    normed = [
        (c["id"], c.get("document_id"), c.get("chunk_index", 0), _dup_compare_text(c["content"]))
        for c in chunks
    ]
    cutoff = threshold * 100.0
    n = len(normed)
    for i in range(n):
        id_i, doc_i, idx_i, txt_i = normed[i]
        if len(txt_i) < 40:
            continue
        pref_i = txt_i[:1200]
        for j in range(i + 1, n):
            id_j, doc_j, idx_j, txt_j = normed[j]
            if len(txt_j) < 40:
                continue
            is_adj = doc_i == doc_j and abs(idx_i - idx_j) == 1
            if is_adj:
                tail_i = txt_i[-220:]
                head_j = txt_j[:260]
                if len(tail_i) >= 60 and fuzz.partial_ratio(tail_i, head_j, score_cutoff=adj_overlap_threshold) >= adj_overlap_threshold:
                    adjacent_dups.add(id_i)
                    adjacent_dups.add(id_j)
                    continue
            pref_j = txt_j[:1200]
            if min(len(pref_i), len(pref_j)) / max(len(pref_i), len(pref_j)) < 0.7:
                continue
            sim = fuzz.ratio(pref_i, pref_j, score_cutoff=cutoff)
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
    exempt_intact_table: bool = True,
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
        add("NOISE", "EMPTY")
        add("INTEGRITY")
        add("CONTEXT")
        add("SIZE")
    elif is_junk:
        add("NOISE", "NUMERIC_ONLY_NOISE")
        add("INTEGRITY")
        add("CONTEXT")
        add("SIZE")

    lower = raw.lower()
    has_td = "<td" in lower or "<tr" in lower
    has_table_open = "<table" in lower
    has_table_close = "</table" in lower
    # Intact table exception: balanced standalone tables are exempt from SIZE TOO_LONG
    is_intact_table = has_table_open and has_table_close and (lower.count("<table") == lower.count("</table"))

    if 0 < n < min_chars:
        add("SIZE", "TOO_SHORT")
    elif n > max_chars and not (exempt_intact_table and is_intact_table):
        add("SIZE", "TOO_LONG")

    has_rep_line = bool(repeated_lines and any(ln in repeated_lines for ln in lines))
    has_isolated_page_num = len(lines) >= 3 and any(re.fullmatch(r"\d{1,3}", ln) for ln in lines)
    has_cta_footer = bool(
        re.search(r"(?:quét mã|truy cập website|để xem chi tiết|để biết thêm chi tiết|\.gov\.vn)", lower)
    )
    if has_rep_line or has_isolated_page_num or has_cta_footer or any(re.search(p, lower) for p in _CHUNK_NOISE_PATTERNS):
        add("NOISE", "ISOLATED_PAGE_NUM" if has_isolated_page_num else "SUSPECTED_NOISE")

    # Detect internal duplicate lines (e.g. accented + unaccented OCR double-extraction in same chunk)
    has_internal_dup = False
    if not is_junk and not has_td and len(lines) >= 3:
        norm_lines = [re.sub(r"[^a-z0-9]+", " ", strip_diacritics(ln).lower()).strip() for ln in lines]
        long_norm = [ln for ln in norm_lines if len(ln) >= 22]
        for i_ln in range(len(long_norm)):
            for j_ln in range(i_ln + 1, len(long_norm)):
                if fuzz.ratio(long_norm[i_ln], long_norm[j_ln], score_cutoff=95) >= 95:
                    has_internal_dup = True
                    break
            if has_internal_dup:
                break
        # Also catch repeated half-line inside same line (e.g. "... de xem chi tiet ... de xem chi tiet")
        if not has_internal_dup:
            for ln in long_norm:
                toks = ln.split()
                if len(toks) >= 10:
                    half = len(toks) // 2
                    left_s = " ".join(toks[:half])
                    right_s = " ".join(toks[half:])
                    if fuzz.partial_ratio(left_s, right_s, score_cutoff=92) >= 92:
                        has_internal_dup = True
                        break

    if is_adj_dup:
        add("DUPLICATE", "ADJACENT_DUPLICATE")
    if is_far_dup or has_internal_dup:
        add("DUPLICATE", "INTERNAL_DUPLICATE" if has_internal_dup else "DUPLICATE")

    prev_has_td = "<td" in (prev_content or "").lower()
    next_has_td = "<td" in (next_content or "").lower()
    has_th_header = "<th" in lower
    if has_td and ((has_table_open != has_table_close) or (not has_table_open) or ((prev_has_td or next_has_td) and not (is_intact_table and has_th_header))):
        add("INTEGRITY", "BROKEN_TABLE")

    prev_lines = [ln.strip() for ln in nfc(prev_content or "").splitlines() if ln.strip()]
    prev_opened_list = any(
        pl.endswith(":") and re.search(r"(?:con đường|bao gồm|sau đây|như sau|triệu chứng|yếu tố|nhóm|bước|giai đoạn|gồm|sau)\s*:$", pl.lower())
        for pl in prev_lines[-5:]
    )

    has_heading = False
    if not is_junk and lines:
        first_line = lines[0]
        has_heading = bool(
            _HEADING_LINE_RE.match(first_line)
            or first_line.startswith("#")
            or (len(first_line) <= 100 and sum(1 for c in first_line if c.isupper()) >= max(6, int(0.75 * max(1, sum(1 for c in first_line if c.isalpha())))))
        )

    if not is_junk and not has_td and lines:
        first_ch = lines[0][0]
        last_line = lines[-1]
        last_ch = last_line[-1]
        starts_mid = first_ch.islower() or first_ch in ",;)]"
        ends_mid = last_ch not in ".!?:;\"')]" and not _HEADING_LINE_RE.match(last_line) and len(last_line) > 30
        trailing_colon = last_ch == ":" and len(lines) <= 2 and bool(next_content.strip())
        list_split = prev_opened_list and not has_heading and len(lines[0]) <= 220
        if starts_mid or ends_mid or trailing_colon or list_split:
            add("INTEGRITY", "LIST_SPLIT" if (list_split and not (starts_mid or ends_mid or trailing_colon)) else "BAD_BOUNDARY")

    if not is_junk and lines:
        first_line = lines[0]
        if not has_heading and (_AMBIGUOUS_START_RE.match(first_line) or first_line[0].islower() or prev_opened_list):
            add("CONTEXT", "LOW_CONTEXT")

    integrity = 0 if "INTEGRITY" in codes else 1
    context_sufficiency = 0 if "CONTEXT" in codes else 1
    no_noise = 0 if "NOISE" in codes else 1
    no_duplicate = 0 if "DUPLICATE" in codes else 1
    valid_size = 0 if "SIZE" in codes else 1

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


def _locate_best_span(src_low: str, chk_low: str) -> Tuple[int, int]:
    """
    Fast span locator: uses exact/prefix anchor windowing when strings are long so
    RapidFuzz partial_ratio_alignment runs on a small local window (O(ms) instead of O(N*M) seconds).
    """
    n_src = len(src_low)
    n_chk = len(chk_low)
    if n_src <= 1800 and n_chk <= 3500:
        aln = fuzz.partial_ratio_alignment(src_low, chk_low)
        if aln is not None and aln.dest_end > aln.dest_start:
            return aln.dest_start, aln.dest_end
        return 0, n_chk

    # Try exact substring anchor from start/middle/end of src_low
    anchor_pos = -1
    for probe in (src_low[:80], src_low[n_src // 3 : n_src // 3 + 80], src_low[:40]):
        probe = probe.strip()
        if len(probe) >= 16:
            idx = chk_low.find(probe)
            if idx != -1:
                anchor_pos = max(0, idx - (n_src // 3 if probe != src_low[:80] and probe != src_low[:40] else 0))
                break

    if anchor_pos != -1:
        win_start = max(0, anchor_pos - 120)
        win_end = min(n_chk, win_start + max(n_src + 500, 2600))
        sub_chk = chk_low[win_start:win_end]
        aln = fuzz.partial_ratio_alignment(src_low[:1800], sub_chk[:3500])
        if aln is not None and aln.dest_end > aln.dest_start:
            # Extend end proportionally if src_low was longer than 1800
            est_end = win_start + aln.dest_end
            if n_src > 1800:
                est_end = min(n_chk, max(est_end, win_start + aln.dest_start + n_src + 120))
            return win_start + aln.dest_start, est_end
        return win_start, min(n_chk, win_start + n_src)

    aln = fuzz.partial_ratio_alignment(src_low[:1500], chk_low[:3000])
    if aln is not None and aln.dest_end > aln.dest_start:
        est_end = aln.dest_end if n_src <= 1500 else min(n_chk, aln.dest_start + n_src + 120)
        return aln.dest_start, est_end
    return 0, min(n_chk, max(n_src, 3000))


def extract_best_aligned_span(
    source_text: str, chunk_content: str, unit_type: str = "text", format_group: str = ""
) -> Dict[str, Any]:
    """
    Uses RapidFuzz partial_ratio_alignment (with fast anchor windowing) to locate the exact
    substring of `chunk_content` that best matches `source_text`, even with OCR typos,
    missing Vietnamese accents, or reformatted line breaks.
    """
    src_raw = canonicalize_text(source_text).strip()
    chk_input = _html_table_to_pipe(chunk_content) if unit_type == "table" else chunk_content
    chk_raw = canonicalize_text(chk_input).strip()

    # Placeholder ground-truth (embedded images or un-OCRed scanned pages) cannot be auto-scored via text diff
    if src_raw.startswith("[Hình ảnh / Sơ đồ") or src_raw.startswith("[Trang "):
        return {
            "matched_excerpt": chk_raw[:1200],
            "start": 0,
            "end": min(len(chk_raw), 1200),
            "raw_similarity": 0.0,
            "text_similarity": 0.0,
            "has_format_diff": False,
            "has_text_diff": False,
            "suggested_verdict": "UNRATED",
            "stitched_with_chunk_index": None,
            "risk_flags": [{"code": "NEEDS_VISUAL_REVIEW", "label": "Cần QC đối chiếu ảnh/scan hoặc chạy Vision OCR", "severity": "Trung bình"}],
            "suggested_error_codes": [],
        }

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
    raw_s, raw_e = _locate_best_span(src_low, chk_low)
    s, e = _expand_to_word_bounds(chk_raw, raw_s, raw_e)
    excerpt = chk_raw[s:e].strip() or chk_raw[:min(len(chk_raw), len(src_raw) + 200)]

    raw_sim = round(float(fuzz.ratio(src_raw, excerpt)), 2)
    src_collapsed = collapse_whitespace(src_raw)
    exc_collapsed = collapse_whitespace(excerpt)
    text_sim = round(float(fuzz.ratio(src_collapsed, exc_collapsed)), 2)

    # For tables, use cell-level recall so HTML colspan/rowspan formatting doesn't cause false FAILs
    if unit_type == "table":
        cell_recall = _compute_table_cell_recall(src_raw, excerpt)
        text_sim = max(text_sim, cell_recall)

    has_text_diff = src_collapsed != exc_collapsed
    has_format_diff = (not has_text_diff) and (src_raw != excerpt)

    risk_flags, suggested_codes = analyze_parsing_risks(
        src_raw, excerpt, unit_type=unit_type, text_sim=text_sim, format_group=format_group
    )
    has_critical = any(f["severity"] == "Nghiêm trọng" for f in risk_flags)

    if has_critical:
        suggested = "FAIL"
    elif text_sim >= 98.0:
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
    # Skip expensive neighbor stitching if source is an oversized sheet/table that already fits inside chunk_content
    if len(source_text) > 3500 and len(chunk_content) > 4000 and base["text_similarity"] >= 70.0:
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

    if prev_chunk_content and next_chunk_content and best["text_similarity"] < 92.0:
        combined_3 = f"{prev_chunk_content}\n{chunk_content}\n{next_chunk_content}"
        stitched_3 = extract_best_aligned_span(source_text, combined_3, unit_type=unit_type, format_group=format_group)
        if stitched_3["text_similarity"] >= best["text_similarity"] + 1.0:
            stitched_3["stitched_with_chunk_index"] = next_chunk_index
            best = stitched_3

    return best


def align_unit_to_chunks(
    source_text: str, chunks: List[Dict[str, Any]], top_n: int = 3, page_num: int | None = None
) -> Tuple[List[str], float]:
    """Fuzzy-align a source ground-truth paragraph/table to parsed chunks using RapidFuzz."""
    # For multi-row pipe tables, match on body rows (skipping the repeated header row) so split
    # multi-page tables align to their actual data chunk instead of the first header chunk.
    raw_lines = [ln.strip() for ln in (source_text or "").splitlines() if ln.strip()]
    is_pipe_table = len(raw_lines) >= 2 and ("|" in raw_lines[0]) and ("|" in raw_lines[1])
    match_text = "\n".join(raw_lines[1:]) if is_pipe_table else source_text
    src_norm = normalize_text(match_text) or normalize_text(source_text)
    if not src_norm:
        return [], 0.0
    src_tokens = set(re.findall(r"\w+", src_norm))
    if not src_tokens:
        return [], 0.0

    # Fast 2-stage alignment:
    # Stage 1: O(1) prefix hit or token-overlap pre-filter across all chunks.
    # Stage 2: RapidFuzz partial_ratio only on the top-8 token-overlap candidates (600x1500 cap)
    # so 50k-char Excel sheets and 200-chunk DOCX files align in milliseconds instead of minutes.
    src_fuzzy = src_norm[:600]
    src_prefix = src_norm[:120]

    exact_hits = []
    candidates = []
    for ch in chunks:
        c_norm = ch.get("_norm")
        if c_norm is None:
            c_norm = normalize_text(ch.get("content", ""))
            ch["_norm"] = c_norm
        if not c_norm:
            continue
        cid = ch.get("ragflow_chunk_id", "")
        page_bonus = 0.06 if (page_num and ch.get("page_num") == page_num) else 0.0
        if src_prefix and src_prefix in c_norm:
            exact_hits.append((round(min(0.99 + page_bonus, 1.0), 4), cid))
            continue
        c_tokens = ch.get("_tokens")
        if c_tokens is None:
            c_tokens = set(re.findall(r"\w+", c_norm))
            ch["_tokens"] = c_tokens
        if not c_tokens:
            continue
        shared = len(src_tokens & c_tokens)
        if shared == 0:
            continue
        overlap = shared / max(len(src_tokens), 1)
        contain = shared / max(min(len(src_tokens), len(c_tokens)), 1)
        if contain < 0.15:
            continue
        candidates.append((max(overlap, contain * 0.8) + page_bonus, overlap, page_bonus, c_norm, cid))

    scored = list(exact_hits)
    if len(scored) < top_n and candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        for _, overlap, page_bonus, c_norm, cid in candidates[:8]:
            pr = fuzz.partial_ratio(src_fuzzy, c_norm[:1500]) / 100.0
            score = round(min(max(pr * 0.7 + overlap * 0.3, overlap) + page_bonus, 1.0), 4)
            if score >= 0.45:
                scored.append((score, cid))

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
        c_tokens = ch.get("_tokens")
        if c_tokens is None:
            c_tokens = set(re.findall(r"\w+", normalize_text(ch.get("content", ""))))
            ch["_tokens"] = c_tokens
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


def compute_content_hash(text: str) -> str:
    """Stable SHA-256 prefix over normalized text so relevancy cache survives chunk re-IDs."""
    norm = normalize_text(text)
    if not norm:
        return ""
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:32]


def compute_mrr(relevancies: List[int]) -> float:
    """Mean Reciprocal Rank component for a single query: 1 / rank of first relevant chunk."""
    for idx, rel in enumerate(relevancies, start=1):
        if rel == 1:
            return round(1.0 / idx, 4)
    return 0.0


def compute_hit_at_k(relevancies: List[int], k: int) -> float:
    """Binary Hit@K (1.0 if at least 1 relevant chunk appears in top-K, else 0.0)."""
    if k <= 0 or not relevancies:
        return 0.0
    return 1.0 if any(r == 1 for r in relevancies[:k]) else 0.0


def compute_multi_objective_score(
    avg_cp: float,
    avg_cc: float,
    avg_mrr: float,
    hit_1: float,
    hit_3: float,
    hit_k: float,
    avg_latency_ms: float = 0.0,
    avg_context_tokens: float = 0.0,
    profile: str = "balanced",
) -> float:
    """
    Computes a unified [0, 1] optimization objective score tailored to user priority:
      - balanced:       0.40*CP + 0.30*Coverage + 0.20*MRR + 0.10*Hit@3
      - high_precision: 0.45*CP + 0.30*MRR + 0.15*Hit@1 + 0.10*Coverage
      - high_recall:    0.50*Coverage + 0.25*Hit@K + 0.15*CP + 0.10*MRR
      - low_latency:    0.45*CP + 0.30*Coverage + 0.15*MRR - latency/token penalty
    """
    prof = (profile or "balanced").strip().lower()
    if prof == "high_precision":
        raw = 0.45 * avg_cp + 0.30 * avg_mrr + 0.15 * hit_1 + 0.10 * avg_cc
    elif prof == "high_recall":
        raw = 0.50 * avg_cc + 0.25 * hit_k + 0.15 * avg_cp + 0.10 * avg_mrr
    elif prof == "low_latency":
        lat_pen = min(0.18, max(0.0, (avg_latency_ms - 180.0) / 3500.0))
        tok_pen = min(0.10, max(0.0, (avg_context_tokens - 1500.0) / 18000.0))
        raw = 0.45 * avg_cp + 0.30 * avg_cc + 0.15 * avg_mrr + 0.10 * hit_3 - lat_pen - tok_pen
    else:
        raw = 0.40 * avg_cp + 0.30 * avg_cc + 0.20 * avg_mrr + 0.10 * hit_3
    return round(max(0.0, min(1.0, raw)), 4)


def mark_pareto_frontier(
    trials: List[Dict[str, Any]],
    x_key: str = "avg_latency_ms",
    y_key: str = "objective_score",
) -> List[Dict[str, Any]]:
    """
    Marks non-dominated trials on the Pareto frontier (maximize y_key, minimize x_key).
    """
    if not trials:
        return trials
    for i, t in enumerate(trials):
        tx = float(t.get(x_key) or 0.0)
        ty = float(t.get(y_key) or 0.0)
        dominated = False
        for j, other in enumerate(trials):
            if i == j:
                continue
            ox = float(other.get(x_key) or 0.0)
            oy = float(other.get(y_key) or 0.0)
            if oy >= ty and ox <= tx and (oy > ty or ox < tx):
                dominated = True
                break
        t["is_pareto"] = not dominated
    return trials


def compute_parameter_sensitivity(trials: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Computes main-effect sensitivity for each swept retrieval parameter across trials:
    identifies which parameter creates the largest objective_score swing and its best value.
    """
    if len(trials) < 2:
        return []
    param_keys = [
        ("vector_similarity_weight", "Tỷ trọng Vector"),
        ("similarity_threshold", "Ngưỡng lọc (Threshold)"),
        ("top_k", "Top-K trả về"),
        ("keyword_enabled", "Tìm kiếm từ khóa (BM25)"),
        ("rerank_id", "Model Rerank"),
    ]
    results: List[Dict[str, Any]] = []
    for key, label in param_keys:
        buckets: Dict[str, List[float]] = {}
        for t in trials:
            cfg = t.get("config") or {}
            if key not in cfg:
                continue
            raw_v = cfg[key]
            if key == "rerank_id":
                v_str = str(raw_v).strip() or "Tắt"
            elif key == "keyword_enabled":
                v_str = "Bật" if raw_v else "Tắt"
            else:
                v_str = str(raw_v)
            buckets.setdefault(v_str, []).append(float(t.get("objective_score") or 0.0))
        if len(buckets) < 2:
            continue
        means = {k: round(sum(vs) / len(vs), 4) for k, vs in buckets.items() if vs}
        best_val = max(means.keys(), key=lambda k: means[k])
        worst_val = min(means.keys(), key=lambda k: means[k])
        swing = round(means[best_val] - means[worst_val], 4)
        results.append({
            "param": key,
            "label": label,
            "swing": swing,
            "best_value": best_val,
            "best_avg_score": means[best_val],
            "worst_value": worst_val,
            "worst_avg_score": means[worst_val],
            "levels": [{"value": k, "avg_score": v, "count": len(buckets[k])} for k, v in means.items()],
        })
    results.sort(key=lambda x: -x["swing"])
    return results


def compute_parsing_metrics(rows: List[Any]) -> Dict[str, Any]:
    """
    Single Source of Truth for Parsing metrics across parsing.py and analytics.py (zero double-counting):
    - text_completeness: text units passing completeness without P1/TEXT (PASS=1.0, PARTIAL=0.5, FAIL=0.0)
    - table_accuracy: table units without P9/P10/TABLE (PASS=1.0, PARTIAL=0.5 if no P9/P10, FAIL=0.0)
    - character_error_rate: ONLY P4/P5/P6 or char_error == 1
    - layout_accuracy: unified with Phụ lục B — P2 (image/diagram) + P7 (heading) + P8 (list)
    - reading_order_accuracy: rated units without P3/ORDER and NOT FAIL/missing (P1/P2)
    - content_fidelity: rated units without P3/P10/FIDELITY and NOT FAIL/missing (P1/P2)
    - coverage_rate: rated_units / total_units (prevents cherry-picking illusion)
    - parsing_score: weighted composite over available metrics
    """
    import json

    rated = [r for r in rows if r["verdict"] != "UNRATED"]
    text_units = [r for r in rated if r["unit_type"] not in ("table", "image", "diagram")]
    table_units = [r for r in rated if r["unit_type"] == "table"]
    image_units = [r for r in rated if r["unit_type"] in ("image", "diagram")]

    text_ok = 0.0
    table_ok = 0.0
    layout_ok = 0
    order_ok = 0
    fidelity_ok = 0
    char_err = 0
    critical_fail_count = 0

    for r in rated:
        raw_codes = r["error_codes"]
        codes = set(json.loads(raw_codes) if isinstance(raw_codes, str) else (raw_codes or []))
        is_fail = r["verdict"] == "FAIL"
        is_partial = r["verdict"] == "PARTIAL"
        is_missing = bool(codes & {"P1", "P2"})
        is_char_err = bool(codes & {"P4", "P5", "P6"}) or r["char_error"] == 1
        # Strict axis separation (zero double-counting across Parsing axes)
        has_completeness_err = bool(codes & {"TEXT", "P1"})
        has_table_err = bool(codes & {"TABLE", "P9", "P10"})
        has_order_err = bool(codes & {"ORDER", "P3"})
        has_layout_err = bool(codes & {"LAYOUT", "P2", "P7", "P8"}) or (
            r["unit_type"] in ("image", "diagram") and r["verdict"] != "PASS"
        )
        fid_flag = (r.get("fidelity_error") if isinstance(r, dict) else (r["fidelity_error"] if "fidelity_error" in r.keys() else 0)) == 1
        has_fidelity_err = fid_flag or bool(codes & {"FIDELITY", "P10"})
        is_critical = (
            is_fail
            or (r.get("severity") == "Nghiêm trọng" if isinstance(r, dict) else (r["severity"] == "Nghiêm trọng" if "severity" in r.keys() else False))
            or bool(codes & {"P1", "P2", "P3", "P9", "P10"})
        )

        if is_critical:
            critical_fail_count += 1
        if is_char_err:
            char_err += 1
        if r["unit_type"] not in ("table", "image", "diagram"):
            if not has_completeness_err and r["verdict"] == "PASS":
                text_ok += 1.0
            elif is_partial and not is_missing:
                text_ok += 0.5
        if r["unit_type"] == "table":
            if not has_table_err and r["verdict"] == "PASS":
                table_ok += 1.0
            elif is_partial and not has_table_err:
                table_ok += 0.5
        if not has_layout_err:
            layout_ok += 1
        if not has_order_err:
            order_ok += 1
        if not has_fidelity_err:
            fidelity_ok += 1

    text_completeness = round(text_ok / len(text_units), 4) if text_units else None
    table_accuracy = round(table_ok / len(table_units), 4) if table_units else None
    character_error_rate = round(char_err / len(rated), 4) if rated else 0.0
    layout_accuracy = round(layout_ok / len(rated), 4) if rated else None
    reading_order_accuracy = round(order_ok / len(rated), 4) if rated else None
    content_fidelity = round(fidelity_ok / len(rated), 4) if rated else None
    coverage_rate = round(len(rated) / len(rows), 4) if rows else 0.0

    # Dynamically re-normalize weights over available metrics so N/A categories don't distort score
    weighted_terms = [
        (0.25, text_completeness),
        (0.20, content_fidelity),
        (0.20, table_accuracy),
        (0.15, (1.0 - character_error_rate) if rated else None),
        (0.10, layout_accuracy),
        (0.10, reading_order_accuracy),
    ]
    avail = [(w, v) for w, v in weighted_terms if v is not None]
    w_sum = sum(w for w, _ in avail)
    parsing_score = round(sum(w * v for w, v in avail) / w_sum, 4) if w_sum > 0 else 0.0

    return {
        "total_units": len(rows),
        "rated_units": len(rated),
        "coverage_rate": coverage_rate,
        "critical_fail_count": critical_fail_count,
        "text_completeness": text_completeness if text_completeness is not None else 0.0,
        "table_accuracy": table_accuracy if table_accuracy is not None else 0.0,
        "table_total": len(table_units),
        "character_error_rate": character_error_rate,
        "content_fidelity": content_fidelity if content_fidelity is not None else 0.0,
        "layout_accuracy": layout_accuracy,
        "layout_total": len(image_units),
        "reading_order_accuracy": reading_order_accuracy if reading_order_accuracy is not None else 0.0,
        "parsing_score": parsing_score,
    }
