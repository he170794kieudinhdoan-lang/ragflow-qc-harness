import re
from difflib import SequenceMatcher
from typing import Any, Dict, List, Tuple


PARSING_ERROR_CATALOG = [
    {"code": "P1", "name": "Mất đoạn nội dung", "severity": "High", "metric": "Text Completeness"},
    {"code": "P2", "name": "Mất nội dung trong ảnh/sơ đồ", "severity": "Medium", "metric": "Text Completeness"},
    {"code": "P3", "name": "Sai thứ tự đọc (trộn cột/dòng)", "severity": "Medium", "metric": "Text Completeness"},
    {"code": "P4", "name": "Lỗi ký tự tiếng Việt / mất dấu", "severity": "High", "metric": "Character Error"},
    {"code": "P5", "name": "Lỗi cấu trúc bảng (vỡ hàng/cột)", "severity": "High", "metric": "Table Accuracy"},
    {"code": "P6", "name": "Lỗi nhận diện OCR (file scan)", "severity": "High", "metric": "Character Error"},
    {"code": "P7", "name": "Mất cấu trúc heading / phân cấp", "severity": "Low", "metric": "Text Completeness"},
    {"code": "P8", "name": "Danh sách gộp dính / vỡ bullet", "severity": "Low", "metric": "Text Completeness"},
    {"code": "P9", "name": "Ô gộp / tiêu đề bảng bị lệch", "severity": "Medium", "metric": "Table Accuracy"},
    {"code": "P10", "name": "Dính nội dung rác (menu/header/footer)", "severity": "Low", "metric": "Text Completeness"},
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


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


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


def align_unit_to_chunks(
    source_text: str, chunks: List[Dict[str, Any]], top_n: int = 3
) -> Tuple[List[str], float]:
    """Fuzzy-align a source ground-truth paragraph/table to parsed chunks."""
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
            score = 0.98
        else:
            c_tokens = set(re.findall(r"\w+", c_norm))
            overlap = len(src_tokens & c_tokens) / max(len(src_tokens), 1)
            score = round(overlap, 4)
        if score >= 0.25:
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
