"""
Flexible Excel (.xlsx) & CSV Golden Dataset importer with 3-layer column detection:
  1. Smart header-row finder + Vietnamese/English header & content heuristics (0 LLM cost).
  2. Optional 5-row AI column mapper (calls LLM once with <= 5 sample rows for arbitrary/unusual sheets).
  3. Explicit user column-mapping overrides for 100% control before committing to SQLite.
"""
import csv
import io
import json
import re
from typing import Any, Dict, List, Optional, Tuple

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation

from metrics import nfc

TARGET_FIELDS = [
    "tc_code",
    "input_question",
    "expected_outcome",
    "reference_context",
    "source_file",
    "question_class",
    "intent_type",
    "notes",
]

_HEADER_PATTERNS: Dict[str, List[str]] = {
    "tc_code": [r"^m[aã]\s*(tc|c[aâ]u|id)", r"^tc[\s_-]*code$", r"^id$", r"^stt$", r"^code$", r"^#"],
    "input_question": [
        r"c[aâ]u\s*h[oỏ]i",
        r"input[\s_-]*question",
        r"^question$",
        r"^query$",
        r"^prompt$",
        r"n[oộ]i\s*dung\s*h[oỏ]i",
        r"^q$",
    ],
    "expected_outcome": [
        r"[đd][aá]p\s*[aá]n",
        r"k[eế]t\s*qu[aả]\s*(k[yỳ]\s*v[oọ]ng|mong\s*[đd][oợ]i|chu[aẩ]n)",
        r"expected[\s_-]*(outcome|answer|output)",
        r"^answer$",
        r"tr[aả]\s*l[oờ]i",
        r"^a$",
    ],
    "reference_context": [
        r"c[aă]n\s*c[uứ]",
        r"reference[\s_-]*context",
        r"ground[\s_-]*truth",
        r"ng[uữ]\s*c[aả]nh",
        r"tr[ií]ch\s*d[aẫ]n",
        r"context",
        r"evidence",
        r"b[aằ]ng\s*ch[uứ]ng",
        r"[đd]o[aạ]n\s*g[oố]c",
    ],
    "source_file": [
        r"t[aà]i\s*li[eệ]u",
        r"file\s*ngu[oồ]n",
        r"source[\s_-]*(file|doc|document)",
        r"ngu[oồ]n",
        r"document",
        r"filename",
    ],
    "question_class": [
        r"ph[aâ]n\s*lo[aạ]i",
        r"lo[aạ]i\s*c[aâ]u",
        r"question[\s_-]*class",
        r"^class$",
        r"m[uứ]c\s*[đd][oộ]",
        r"category",
    ],
    "intent_type": [
        r"[yý]\s*[đd][iị]nh",
        r"intent",
        r"d[aạ]ng\s*c[aâ]u",
        r"type",
    ],
    "notes": [
        r"ghi\s*ch[uú]",
        r"^notes?$",
        r"comment",
        r"remark",
    ],
}

_FILE_EXT_RE = re.compile(r"\.(pdf|docx?|xlsx?|pptx?|html?|md|txt|csv)\b", re.IGNORECASE)
_TC_CODE_RE = re.compile(r"^(TC|Q|TEST|ID)[-_#]?\d+$", re.IGNORECASE)


def _cell_str(v: Any) -> str:
    if v is None:
        return ""
    return nfc(str(v)).strip()


def read_tabular_file(
    file_bytes: bytes,
    filename: str,
    sheet_name: Optional[str] = None,
) -> Tuple[List[str], str, List[List[str]]]:
    """
    Parses .xlsx or .csv into (sheet_names, active_sheet_name, rows_matrix).
    """
    low = (filename or "").lower()
    if low.endswith(".csv"):
        text = ""
        for enc in ("utf-8-sig", "utf-8", "cp1258", "latin-1"):
            try:
                text = file_bytes.decode(enc)
                break
            except Exception:
                continue
        reader = csv.reader(io.StringIO(text))
        rows = [[_cell_str(c) for c in row] for row in reader]
        # Drop completely empty trailing rows
        rows = [r for r in rows if any(c for c in r)]
        return ["CSV"], "CSV", rows

    # Excel (.xlsx / .xlsm)
    wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True, read_only=True)
    try:
        sheet_names = list(wb.sheetnames)
        if not sheet_names:
            return [], "", []
        active = sheet_name if sheet_name in sheet_names else sheet_names[0]
        ws = wb[active]
        rows: List[List[str]] = []
        for raw_row in ws.iter_rows(values_only=True):
            vals = [_cell_str(c) for c in raw_row]
            if any(vals):
                rows.append(vals)
            if len(rows) >= 2000:
                break
        return sheet_names, active, rows
    finally:
        wb.close()


def detect_header_row_index(rows: List[List[str]]) -> int:
    """Finds the most likely header row among the first 10 non-empty rows."""
    if not rows:
        return 0
    best_idx = 0
    best_score = -1.0
    scan_limit = min(10, len(rows))
    for i in range(scan_limit):
        r = rows[i]
        non_empty = [c for c in r if c]
        if len(non_empty) < 2:
            continue
        score = float(len(non_empty)) * 1.2
        # Reward rows matching known header keywords
        for cell in non_empty:
            cl = cell.lower()
            if len(cell) <= 45:
                score += 0.4
            for pats in _HEADER_PATTERNS.values():
                if any(re.search(p, cl) for p in pats):
                    score += 3.0
                    break
        # Penalize rows that look like long prose sentences / questions
        if any(len(c) > 90 or "?" in c for c in non_empty):
            score -= 4.0
        if score > best_score:
            best_score = score
            best_idx = i
    return best_idx


def heuristic_map_columns(headers: List[str], sample_rows: List[List[str]]) -> Tuple[Dict[str, Optional[int]], float]:
    """
    Maps spreadsheet column indices to TARGET_FIELDS using header regexes + sample cell content.
    Returns (mapping_dict, confidence 0..1).
    """
    mapping: Dict[str, Optional[int]] = {f: None for f in TARGET_FIELDS}
    used_cols: set = set()

    # Pass 1: header regex matching
    for field, patterns in _HEADER_PATTERNS.items():
        for idx, h in enumerate(headers):
            if idx in used_cols or not h:
                continue
            hl = h.lower().strip()
            if any(re.search(p, hl) for p in patterns):
                mapping[field] = idx
                used_cols.add(idx)
                break

    # Pass 2: content-based heuristics for unmapped critical fields
    num_cols = max(len(headers), max((len(r) for r in sample_rows), default=0))
    col_stats = []
    for idx in range(num_cols):
        vals = [r[idx] for r in sample_rows if idx < len(r) and r[idx]]
        if not vals:
            continue
        avg_len = sum(len(v) for v in vals) / len(vals)
        q_ratio = sum(1 for v in vals if "?" in v or v.lower().startswith(("tại sao", "như thế nào", "là gì", "khi nào", "bao nhiêu", "how ", "what ", "why "))) / len(vals)
        file_ratio = sum(1 for v in vals if _FILE_EXT_RE.search(v)) / len(vals)
        code_ratio = sum(1 for v in vals if _TC_CODE_RE.match(v)) / len(vals)
        cls_ratio = sum(1 for v in vals if v.lower() in ("local", "global", "multi-hop", "multihop")) / len(vals)
        col_stats.append({
            "idx": idx,
            "avg_len": avg_len,
            "q_ratio": q_ratio,
            "file_ratio": file_ratio,
            "code_ratio": code_ratio,
            "cls_ratio": cls_ratio,
        })

    if mapping["tc_code"] is None:
        cand = [c for c in col_stats if c["idx"] not in used_cols and c["code_ratio"] >= 0.6]
        if cand:
            mapping["tc_code"] = cand[0]["idx"]
            used_cols.add(cand[0]["idx"])

    if mapping["source_file"] is None:
        cand = [c for c in col_stats if c["idx"] not in used_cols and c["file_ratio"] >= 0.5]
        if cand:
            mapping["source_file"] = cand[0]["idx"]
            used_cols.add(cand[0]["idx"])

    if mapping["question_class"] is None:
        cand = [c for c in col_stats if c["idx"] not in used_cols and c["cls_ratio"] >= 0.5]
        if cand:
            mapping["question_class"] = cand[0]["idx"]
            used_cols.add(cand[0]["idx"])

    if mapping["input_question"] is None:
        cand = sorted(
            [c for c in col_stats if c["idx"] not in used_cols and c["q_ratio"] >= 0.3],
            key=lambda x: -x["q_ratio"],
        )
        if cand:
            mapping["input_question"] = cand[0]["idx"]
            used_cols.add(cand[0]["idx"])

    if mapping["reference_context"] is None:
        cand = sorted(
            [c for c in col_stats if c["idx"] not in used_cols and c["avg_len"] >= 60],
            key=lambda x: -x["avg_len"],
        )
        if cand:
            mapping["reference_context"] = cand[0]["idx"]
            used_cols.add(cand[0]["idx"])

    if mapping["expected_outcome"] is None:
        cand = sorted(
            [c for c in col_stats if c["idx"] not in used_cols and c["avg_len"] >= 15],
            key=lambda x: -x["avg_len"],
        )
        if cand:
            mapping["expected_outcome"] = cand[0]["idx"]
            used_cols.add(cand[0]["idx"])

    # Confidence score
    conf = 0.0
    if mapping["input_question"] is not None:
        conf += 0.5
    if mapping["reference_context"] is not None or mapping["expected_outcome"] is not None:
        conf += 0.35
    if mapping["tc_code"] is not None or mapping["source_file"] is not None:
        conf += 0.15
    return mapping, round(conf, 2)


async def ai_map_columns(
    headers: List[str],
    sample_rows: List[List[str]],
    llm_base: str,
    llm_key: str,
    llm_model: str,
) -> Dict[str, Optional[int]]:
    """
    Sends ONLY column headers + first 5 sample rows (~500 tokens) to LLM to detect column mapping
    for arbitrary/unfamiliar Excel spreadsheets.
    """
    from llm_client import call_llm_json

    cols_preview = []
    num_cols = max(len(headers), max((len(r) for r in sample_rows), default=0))
    for i in range(num_cols):
        h = headers[i] if i < len(headers) else f"Col_{i}"
        samples = [r[i][:120] for r in sample_rows[:5] if i < len(r) and r[i]]
        cols_preview.append({"col_index": i, "header": h, "samples": samples})

    sys_prompt = (
        "Bạn là chuyên gia phân tích cấu trúc bảng Excel kiểm thử RAG (Golden Dataset). "
        "Cho danh sách các cột kèm 5 giá trị mẫu của từng cột, hãy ánh xạ đúng chỉ số `col_index` (số nguyên >= 0, hoặc null nếu không có) vào 8 trường chuẩn sau:\n"
        "- tc_code: mã câu hỏi (VD: TC01, Q1, STT)\n"
        "- input_question: câu hỏi kiểm thử (BẮT BUỘC tìm đúng cột hỏi)\n"
        "- expected_outcome: đáp án kỳ vọng / câu trả lời chuẩn ngắn gọn\n"
        "- reference_context: đoạn văn căn cứ trích từ tài liệu gốc (ground truth context)\n"
        "- source_file: tên file tài liệu nguồn (.pdf, .docx, .xlsx...)\n"
        "- question_class: phân loại câu hỏi (Local / Global / Multi-hop)\n"
        "- intent_type: dạng ý định (Factoid, Table, Procedural, Comparison, Reasoning...)\n"
        "- notes: ghi chú thêm\n"
        'Trả về DUY NHẤT JSON hợp lệ dạng: {"tc_code": null hoặc số, "input_question": số hoặc null, "expected_outcome": ..., "reference_context": ..., "source_file": ..., "question_class": ..., "intent_type": ..., "notes": ...}'
    )
    res = await call_llm_json(
        base_url=llm_base,
        api_key=llm_key,
        model=llm_model,
        system_prompt=sys_prompt,
        user_prompt=json.dumps(cols_preview, ensure_ascii=False),
        timeout=30.0,
    )
    out: Dict[str, Optional[int]] = {}
    for f in TARGET_FIELDS:
        v = res.get(f)
        if isinstance(v, int) and 0 <= v < num_cols:
            out[f] = v
        else:
            out[f] = None
    return out


def _norm_question_class(raw: str) -> str:
    s = (raw or "").strip().lower()
    if "multi" in s or "hop" in s or "liên" in s:
        return "Multi-hop"
    if "global" in s or "tổng" in s or "toàn" in s:
        return "Global"
    return "Local"


def extract_rows_with_mapping(
    data_rows: List[List[str]],
    mapping: Dict[str, Optional[int]],
    header_row_1based: int = 1,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Applies `mapping` across `data_rows`, returning (valid_items, error_rows).
    """
    valid: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []

    def _get(row: List[str], field: str) -> str:
        idx = mapping.get(field)
        if idx is None or idx < 0 or idx >= len(row):
            return ""
        return row[idx].strip()

    for offset, row in enumerate(data_rows):
        row_num = header_row_1based + 1 + offset
        q = _get(row, "input_question")
        if not q:
            errors.append({"row_num": row_num, "reason": "Thiếu nội dung câu hỏi kiểm thử"})
            continue

        expected = _get(row, "expected_outcome")
        ref_ctx = _get(row, "reference_context")
        warning = ""
        if not ref_ctx and expected:
            ref_ctx = expected
            warning = "Dùng Đáp án kỳ vọng làm Căn cứ gốc"
        elif not ref_ctx and not expected:
            ref_ctx = q
            warning = "Chưa có Căn cứ gốc (tạm dùng câu hỏi)"

        valid.append({
            "row_num": row_num,
            "tc_code": _get(row, "tc_code"),
            "input_question": q,
            "expected_outcome": expected,
            "reference_context": ref_ctx[:2500],
            "source_file": _get(row, "source_file"),
            "question_class": _norm_question_class(_get(row, "question_class")),
            "intent_type": _get(row, "intent_type") or "Factoid",
            "notes": _get(row, "notes"),
            "warning": warning,
        })

    return valid, errors


def build_golden_template_xlsx() -> bytes:
    """Generates a clean, formatted Excel template for Golden Dataset import."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Golden_Testcases"

    headers = [
        ("Mã TC", 12),
        ("Câu hỏi kiểm thử *", 46),
        ("Đáp án kỳ vọng", 42),
        ("Căn cứ gốc (Reference Context) *", 54),
        ("Tài liệu nguồn", 28),
        ("Phân loại", 16),
        ("Nhóm ý định", 16),
        ("Ghi chú", 24),
    ]

    header_fill = PatternFill(start_color="161616", end_color="161616", fill_type="solid")
    header_font = Font(color="FFFFFF", bold=True, size=11)
    for col_idx, (title, width) in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx, value=title)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(vertical="center", horizontal="left", wrap_text=True)
        ws.column_dimensions[openpyxl.utils.get_column_letter(col_idx)].width = width
    ws.row_dimensions[1].height = 26

    samples = [
        [
            "TC01",
            "Phác đồ ARV ưu tiên cho phụ nữ mang thai nhiễm HIV là gì?",
            "Phác đồ ưu tiên gồm TDF + 3TC + DTG (hoặc EFV tùy giai đoạn thai kỳ).",
            "Phụ nữ mang thai phát hiện nhiễm HIV cần được điều trị ARV ngay, phác đồ bậc 1 ưu tiên là TDF + 3TC + DTG.",
            "Huong-dan-dieu-tri-HIV.pdf",
            "Local",
            "Procedural",
            "Ví dụ mẫu 1",
        ],
        [
            "TC02",
            "So sánh điều kiện bắt đầu và tần suất tái khám của PrEP hàng ngày so với PrEP tình huống?",
            "PrEP hàng ngày dùng cho mọi đối tượng nguy cơ cao, tái khám mỗi 3 tháng; PrEP tình huống (ED-PrEP) chỉ dành cho MSM.",
            "[Đoạn A] PrEP uống hàng ngày áp dụng cho mọi nhóm có nguy cơ cao, xét nghiệm HIV định kỳ mỗi 3 tháng.\n[Đoạn B] PrEP tình huống (2-1-1) chỉ khuyến cáo cho nam quan hệ tình dục đồng giới (MSM).",
            "So-tay-PrEP.pdf",
            "Global",
            "Comparison",
            "Ví dụ mẫu 2",
        ],
    ]
    for r_idx, srow in enumerate(samples, start=2):
        for c_idx, val in enumerate(srow, start=1):
            c = ws.cell(row=r_idx, column=c_idx, value=val)
            c.alignment = Alignment(vertical="top", wrap_text=True)

    dv = DataValidation(type="list", formula1='"Local,Global,Multi-hop"', allow_blank=True)
    ws.add_data_validation(dv)
    dv.add("F2:F500")
    ws.freeze_panes = "A2"

    # Sheet 2: Guide
    ws2 = wb.create_sheet("Huong_dan")
    ws2.column_dimensions["A"].width = 30
    ws2.column_dimensions["B"].width = 75
    guide_rows = [
        ("Cột", "Hướng dẫn điền"),
        ("Mã TC", "Không bắt buộc. Nếu để trống hệ thống tự đánh số TC01, TC02..."),
        ("Câu hỏi kiểm thử *", "BẮT BUỘC. Câu hỏi người dùng thật để test Retrieval."),
        ("Đáp án kỳ vọng", "Tóm tắt câu trả lời đúng ngắn gọn (1-3 câu)."),
        ("Căn cứ gốc (Reference Context) *", "Đoạn văn trích từ tài liệu gốc dùng để chấm Coverage & Relevancy. Nếu trống sẽ tạm lấy Đáp án kỳ vọng."),
        ("Tài liệu nguồn", "Tên file gốc chứa đáp án (VD: tai_lieu.pdf)."),
        ("Phân loại", "Chọn 1 trong 3: Local (1 đoạn), Global (tổng hợp), Multi-hop (suy luận nhiều đoạn)."),
        ("Nhóm ý định", "Factoid, Keyword, Table, Procedural, Comparison, Reasoning."),
        ("Lưu ý đặc biệt", "Bạn cũng có thể tải lên bất kỳ file Excel/CSV nào sẵn có (dù khác tên cột/thứ tự cột) — hệ thống sẽ tự nhận diện cột hoặc dùng AI ghép cột cho bạn."),
    ]
    for r_i, (k, v) in enumerate(guide_rows, start=1):
        c1 = ws2.cell(row=r_i, column=1, value=k)
        c2 = ws2.cell(row=r_i, column=2, value=v)
        if r_i == 1:
            c1.font = Font(bold=True)
            c2.font = Font(bold=True)
        c2.alignment = Alignment(wrap_text=True)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
