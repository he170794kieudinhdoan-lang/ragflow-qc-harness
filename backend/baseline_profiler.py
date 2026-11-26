import math
import os
import re
from typing import Any, Dict, List

_LAW_RE = re.compile(r"(?:^|\n)\s*(?:CHƯƠNG\s+[IVXLC\d]+|Điều\s+\d+[\.:]|Khoản\s+\d+)", re.IGNORECASE)
_QA_RE = re.compile(r"(?:^|\n)\s*(?:Q\s*[:.]|Câu\s*hỏi\s*\d*\s*[:.]|Hỏi\s*[:.])", re.IGNORECASE)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_HTML_TABLE_RE = re.compile(r"<table[\s>]", re.IGNORECASE)
_HTML_HEADING_RE = re.compile(r"<h[1-4][\s>]", re.IGNORECASE)
_MD_HEADING_RE = re.compile(r"(?:^|\n)#{1,4}\s+\S")
_MD_TABLE_RE = re.compile(r"(?:^|\n)\s*\|.+\|\s*\n\s*\|[\s:\-|]+\|")


def _est_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, int(round(len(text.strip()) / 4.0)))


def _percentile(values: List[int], p: float) -> int:
    if not values:
        return 0
    s = sorted(values)
    idx = min(len(s) - 1, max(0, int(math.ceil(p * len(s))) - 1))
    return int(s[idx])


def _sample_indices(total: int, max_samples: int = 12) -> List[int]:
    if total <= max_samples:
        return list(range(total))
    return sorted({round(k * (total - 1) / (max_samples - 1)) for k in range(max_samples)})


def profile_document_sync(doc: Dict[str, Any]) -> Dict[str, Any]:
    """
    Fast, read-only structural profiler for a single local file.
    Always closes native handles cleanly. Never mutates files or DB.
    """
    doc_code = str(doc.get("doc_code") or "")
    filename = str(doc.get("filename") or "")
    fp = str(doc.get("file_path") or "")
    ext = os.path.splitext(filename or fp)[1].lower()
    size_bytes = os.path.getsize(fp) if fp and os.path.exists(fp) else 0

    out: Dict[str, Any] = {
        "document_id": doc.get("id"),
        "doc_code": doc_code,
        "filename": filename,
        "ext": ext or "(khác)",
        "size_kb": round(size_bytes / 1024.0, 1),
        "pages_or_units": int(doc.get("page_count") or 0),
        "is_scan": bool(doc.get("is_scan")),
        "scan_pages": 0,
        "table_count": 0,
        "max_table_tokens": 0,
        "image_count": 0,
        "section_tokens": [],
        "p75_section_tokens": 0,
        "has_law_structure": False,
        "has_qa_structure": False,
        "has_wide_excel": False,
        "excerpt": "",
    }

    if not fp or not os.path.exists(fp):
        return out

    try:
        if ext == ".pdf":
            import fitz

            with fitz.open(fp) as pdf:
                total_pages = len(pdf)
                out["pages_or_units"] = total_pages
                if total_pages == 0:
                    return out
                sample_idxs = _sample_indices(total_pages, 12)
                scan_hits = 0
                law_hits = 0
                qa_hits = 0
                img_total = 0
                table_est = 0
                sec_toks: List[int] = []
                excerpts: List[str] = []

                for idx in sample_idxs:
                    page = pdf[idx]
                    txt = (page.get_text("text") or "").strip()
                    imgs = page.get_images(full=False)
                    img_total += len(imgs)
                    if len(txt) < 30:
                        scan_hits += 1
                    else:
                        if not excerpts and len(txt) >= 60:
                            excerpts.append(re.sub(r"\s+", " ", txt)[:180])
                        if _LAW_RE.search(txt):
                            law_hits += 1
                        if _QA_RE.search(txt):
                            qa_hits += 1
                        # Heuristic table detection via horizontal/vertical drawings or tab/pipe density
                        drawings = page.get_drawings()
                        if len(drawings) >= 18:
                            table_est += 1
                        blocks = [b[4].strip() for b in page.get_text("blocks") if len(b) > 4 and str(b[4]).strip()]
                        for btxt in blocks:
                            if len(btxt) >= 40:
                                sec_toks.append(_est_tokens(btxt))

                scale = total_pages / max(1, len(sample_idxs))
                out["scan_pages"] = int(round(scan_hits * scale))
                out["is_scan"] = (scan_hits / max(1, len(sample_idxs))) >= 0.45 or "scan" in filename.lower()
                out["image_count"] = int(round(img_total * scale))
                out["table_count"] = int(round(table_est * scale))
                out["has_law_structure"] = law_hits >= 2
                out["has_qa_structure"] = qa_hits >= 2
                out["section_tokens"] = sec_toks
                out["p75_section_tokens"] = _percentile(sec_toks, 0.75)
                out["excerpt"] = excerpts[0] if excerpts else ""

        elif ext in (".docx", ".doc"):
            import docx

            d = docx.Document(fp)
            paras = [p.text.strip() for p in d.paragraphs if p.text and p.text.strip()]
            full_sample = "\n".join(paras[:60])
            sec_toks = [_est_tokens(p) for p in paras if len(p) >= 40]
            tbl_toks: List[int] = []
            for tbl in d.tables:
                cell_texts = []
                for row in tbl.rows[:40]:
                    cell_texts.append(" | ".join(c.text.strip() for c in row.cells))
                tbl_toks.append(_est_tokens("\n".join(cell_texts)))

            out["pages_or_units"] = max(1, len(paras))
            out["table_count"] = len(d.tables)
            out["max_table_tokens"] = max(tbl_toks) if tbl_toks else 0
            out["image_count"] = len(d.inline_shapes)
            out["has_law_structure"] = len(_LAW_RE.findall(full_sample)) >= 2
            out["has_qa_structure"] = len(_QA_RE.findall(full_sample)) >= 2
            out["section_tokens"] = sec_toks + tbl_toks
            out["p75_section_tokens"] = _percentile(out["section_tokens"], 0.75)
            out["excerpt"] = re.sub(r"\s+", " ", full_sample)[:180]

        elif ext in (".xlsx", ".xlsm"):
            import openpyxl

            wb = openpyxl.load_workbook(fp, data_only=True, read_only=True)
            try:
                sheet_names = list(wb.sheetnames)
                out["pages_or_units"] = len(sheet_names)
                out["table_count"] = len(sheet_names)
                max_cols = 0
                row_toks: List[int] = []
                excerpt_lines: List[str] = []
                for sname in sheet_names[:5]:
                    ws = wb[sname]
                    r_cnt = 0
                    for raw_row in ws.iter_rows(values_only=True):
                        vals = [str(v).strip() for v in raw_row if v is not None and str(v).strip()]
                        if not vals:
                            continue
                        max_cols = max(max_cols, len(vals))
                        line = " | ".join(vals)
                        row_toks.append(_est_tokens(line))
                        if len(excerpt_lines) < 3:
                            excerpt_lines.append(line[:90])
                        r_cnt += 1
                        if r_cnt >= 60:
                            break
                out["has_wide_excel"] = max_cols >= 4
                out["max_table_tokens"] = min(2000, sum(row_toks[:20])) if row_toks else 0
                out["section_tokens"] = row_toks
                out["p75_section_tokens"] = _percentile(row_toks, 0.75)
                out["excerpt"] = " ; ".join(excerpt_lines)[:180]
            finally:
                wb.close()

        elif ext in (".pptx", ".ppt"):
            from pptx import Presentation

            prs = Presentation(fp)
            slides = list(prs.slides)
            out["pages_or_units"] = len(slides)
            slide_toks: List[int] = []
            tbl_cnt = 0
            excerpts: List[str] = []
            for sl in slides[:30]:
                parts = []
                for sh in sl.shapes:
                    if getattr(sh, "has_table", False):
                        tbl_cnt += 1
                    if getattr(sh, "has_text_frame", False) and sh.text_frame:
                        t = sh.text_frame.text.strip()
                        if t:
                            parts.append(t)
                joined = "\n".join(parts)
                if joined:
                    slide_toks.append(_est_tokens(joined))
                    if not excerpts:
                        excerpts.append(re.sub(r"\s+", " ", joined)[:180])
            out["table_count"] = tbl_cnt
            out["section_tokens"] = slide_toks
            out["p75_section_tokens"] = _percentile(slide_toks, 0.75)
            out["excerpt"] = excerpts[0] if excerpts else ""

        elif ext in (".html", ".htm", ".md", ".markdown", ".txt", ".csv"):
            with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                raw = f.read(160_000)
            if ext in (".html", ".htm"):
                out["table_count"] = len(_HTML_TABLE_RE.findall(raw))
                headings = len(_HTML_HEADING_RE.findall(raw))
                plain = re.sub(r"\s+", " ", _HTML_TAG_RE.sub(" ", raw)).strip()
            else:
                out["table_count"] = len(_MD_TABLE_RE.findall(raw))
                headings = len(_MD_HEADING_RE.findall(raw))
                plain = raw.strip()

            chunks = [p.strip() for p in re.split(r"\n{2,}", plain) if len(p.strip()) >= 40]
            if not chunks and plain:
                chunks = [plain[i : i + 1200] for i in range(0, min(len(plain), 12000), 1200)]
            sec_toks = [_est_tokens(c) for c in chunks[:80]]
            out["pages_or_units"] = max(1, headings or len(chunks))
            out["has_law_structure"] = len(_LAW_RE.findall(plain[:20000])) >= 2
            out["has_qa_structure"] = len(_QA_RE.findall(plain[:20000])) >= 2
            out["section_tokens"] = sec_toks
            out["p75_section_tokens"] = _percentile(sec_toks, 0.75)
            out["excerpt"] = re.sub(r"\s+", " ", plain)[:180]
    except Exception as exc:
        out["scan_error"] = str(exc)[:140]

    return out


def aggregate_corpus_profile(file_profiles: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregates per-file structural profiles into Corpus X-Ray + Deterministic Rule Baseline."""
    n = len(file_profiles)
    total_kb = round(sum(float(f.get("size_kb") or 0.0) for f in file_profiles), 1)
    scan_docs = [f for f in file_profiles if f.get("is_scan")]
    total_tables = sum(int(f.get("table_count") or 0) for f in file_profiles)
    total_images = sum(int(f.get("image_count") or 0) for f in file_profiles)
    max_table_tok = max((int(f.get("max_table_tokens") or 0) for f in file_profiles), default=0)

    all_sec_toks: List[int] = []
    for f in file_profiles:
        all_sec_toks.extend(f.get("section_tokens") or [])
    p75_tokens = _percentile(all_sec_toks, 0.75)
    p50_tokens = _percentile(all_sec_toks, 0.50)

    ext_counts: Dict[str, int] = {}
    for f in file_profiles:
        e = f.get("ext") or "(khác)"
        ext_counts[e] = ext_counts.get(e, 0) + 1
    format_breakdown = [
        {"ext": k.lstrip(".").upper(), "count": v, "ratio": round(v / max(1, n), 3)}
        for k, v in sorted(ext_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]

    # Classify dominant document archetypes
    pptx_docs = [f for f in file_profiles if f.get("ext") in (".pptx", ".ppt")]
    xlsx_docs = [f for f in file_profiles if f.get("ext") in (".xlsx", ".xlsm", ".csv")]
    law_docs = [f for f in file_profiles if f.get("has_law_structure")]
    qa_docs = [f for f in file_profiles if f.get("has_qa_structure")]
    pdf_docs = [f for f in file_profiles if f.get("ext") == ".pdf"]
    docs_with_tables = [f for f in file_profiles if (f.get("table_count") or 0) > 0]
    total_pages_or_units = sum(int(f.get("pages_or_units") or 0) for f in file_profiles)
    approx_words_per_section = max(0, int(round(p75_tokens * 0.75)))
    largest_table_doc = ""
    if max_table_tok > 0:
        top_tbl = max(file_profiles, key=lambda f: f.get("max_table_tokens") or 0)
        largest_table_doc = str(top_tbl.get("doc_code") or "")

    def _fmt_num(val: int) -> str:
        return f"{int(val):,}".replace(",", ".")

    # 1. Recommended chunk_method (RAGFlow v1.0 uses "general" instead of legacy "naive")
    if n > 0 and len(pptx_docs) / n >= 0.65:
        rec_method = "presentation"
        method_reason = (
            f"Phần lớn tài liệu là bài trình chiếu ({len(pptx_docs)}/{n} file PowerPoint), nên dùng chế độ đọc theo từng Slide để nội dung mỗi trang chiếu không bị cắt rời."
        )
    elif n > 0 and len(xlsx_docs) / n >= 0.65:
        rec_method = "table"
        method_reason = (
            f"Phần lớn tài liệu là bảng tính ({len(xlsx_docs)}/{n} file Excel/CSV), nên dùng chế độ chuyên đọc Bảng để giữ đúng tiêu đề cột và từng dòng dữ liệu."
        )
    elif n > 0 and len(law_docs) / n >= 0.60:
        rec_method = "laws"
        method_reason = (
            f"Có {len(law_docs)}/{n} tài liệu trình bày theo cấu trúc Chương, Điều, Khoản — dùng chế độ Văn bản quy phạm giúp giữ trọn vẹn từng điều khoản khi tìm kiếm."
        )
    elif n > 0 and len(qa_docs) / n >= 0.60:
        rec_method = "qa"
        method_reason = (
            f"Có {len(qa_docs)}/{n} tài liệu mang cấu trúc Hỏi – Đáp rõ ràng, dùng chế độ Hỏi đáp giúp ghép chặt câu hỏi với câu trả lời tương ứng."
        )
    else:
        rec_method = "general"
        top_exts = ", ".join(f"{b['ext']} ({b['count']})" for b in format_breakdown[:4])
        method_reason = (
            f"Bộ tài liệu pha trộn {len(ext_counts)} định dạng khác nhau ({top_exts}). Chế độ Tổng hợp là lựa chọn an toàn và đồng đều nhất khi xử lý chung trong một kho."
        )

    # 2. Recommended layout_recognize (maps to Parser:*.pdf.parse_method & spreadsheet.parse_method)
    needs_deepdoc = bool(scan_docs) or total_tables >= 3 or len(pdf_docs) > 0
    rec_layout = "DeepDOC" if needs_deepdoc else "Plain Text"
    if scan_docs:
        scan_codes = ", ".join(d["doc_code"] for d in scan_docs[:3])
        layout_reason = (
            f"Phát hiện {len(scan_docs)} tài liệu PDF dạng ảnh scan ({scan_codes}) cùng {_fmt_num(total_tables)} bảng biểu và {_fmt_num(total_images)} hình ảnh — cần bật bộ đọc bố cục & OCR (DeepDOC) để đọc chữ trên ảnh và giữ đúng khung bảng."
        )
    elif total_tables >= 3 or pdf_docs:
        layout_reason = (
            f"Bộ tài liệu có {len(pdf_docs)} file PDF và {_fmt_num(total_tables)} bảng biểu — bật bộ đọc bố cục thông minh (DeepDOC) giúp tách cột, bảng và tiêu đề chính xác hơn nhiều so với chỉ trích chữ thuần."
        )
    else:
        layout_reason = (
            "Toàn bộ tài liệu là văn bản số thuần túy, ít bảng biểu phức tạp — chế độ chỉ lấy chữ thuần giúp xử lý nhanh hơn và nội dung sạch hơn."
        )

    # 3. Recommended chunk_token_num (maps to GeneralChunker:*.chunk_token_size)
    target_tok = max(p75_tokens * 2, max_table_tok)
    if target_tok >= 850 or (total_tables >= 12 and p75_tokens >= 320):
        rec_tokens = 1024
        approx_tbl_words = _fmt_num(int(round(max(max_table_tok, p75_tokens) * 0.75)))
        token_reason = (
            f"Bộ tài liệu có nhiều bảng lớn (bảng dài nhất chứa khoảng {approx_tbl_words} từ). Mở rộng kích thước mỗi đoạn lên 1.024 token (~768 từ) giúp hạn chế cắt đôi bảng dữ liệu."
        )
    elif target_tok >= 520 or total_tables >= 5:
        rec_tokens = 768
        token_reason = (
            f"Các mục văn bản ở mức trung bình (~{_fmt_num(approx_words_per_section)} từ/mục) nhưng đi kèm {_fmt_num(total_tables)} bảng biểu — mức 768 token (~576 từ) cân bằng tốt giữa giữ trọn bảng và độ chính xác khi tra cứu."
        )
    elif p75_tokens > 0 and p75_tokens <= 140 and total_tables == 0:
        rec_tokens = 384
        token_reason = (
            f"Nội dung chia thành các đoạn ngắn gọn (khoảng {_fmt_num(approx_words_per_section)} từ/mục, không có bảng lớn) — mức 384 token (~288 từ) giúp hệ thống tìm đúng ý nhỏ mà không bị loãng thông tin."
        )
    else:
        rec_tokens = 512
        token_reason = (
            f"Các đoạn văn có độ dài vừa phải (phổ biến quanh ~{_fmt_num(approx_words_per_section)} từ/mục) — mức tiêu chuẩn 512 token (~384 từ, tương đương nửa trang A4) là cân bằng nhất."
        )

    # 4. Recommended overlapped_percent (maps to GeneralChunker:*.overlapped_percent)
    if len(law_docs) >= 2 or total_tables >= 10 or (p75_tokens > 0 and p75_tokens <= 100):
        rec_overlap = 10
        overlap_reason = (
            "Đặt độ chồng lấn 10% giữa hai đoạn liền kề để câu chữ ở ranh giới (tiêu đề, điều khoản hoặc chú thích bảng) không bị đứt mạch ngữ cảnh."
        )
    else:
        rec_overlap = 5
        overlap_reason = (
            "Đặt độ chồng lấn nhẹ 5% để giữ mạch liên kết tự nhiên giữa các đoạn mà không làm phình dung lượng chỉ mục."
        )

    # 5. Recommended table_context_size (maps to GeneralChunker:*.table_context_size)
    if total_tables >= 15 or max_table_tok >= 800:
        rec_table_ctx = 128
        table_ctx_reason = (
            f"Bộ tài liệu có {_fmt_num(total_tables)} bảng biểu nằm rải rác ở {len(docs_with_tables)} tệp — bật ngữ cảnh bảng 128 token để hệ thống luôn đính kèm tiêu đề và mô tả xung quanh mỗi bảng khi tìm kiếm."
        )
    elif total_tables >= 1:
        rec_table_ctx = 64
        table_ctx_reason = (
            f"Phát hiện {_fmt_num(total_tables)} bảng biểu — bật ngữ cảnh bảng 64 token giúp giữ lại dòng tiêu đề giải thích ý nghĩa của bảng."
        )
    else:
        rec_table_ctx = 0
        table_ctx_reason = "Không phát hiện bảng biểu đáng kể nên để 0 token."

    # 6. Split Dataset Warnings (high-value insight when mixing incompatible archetypes)
    split_warnings: List[Dict[str, Any]] = []
    if rec_method == "general":
        if pptx_docs and len(pptx_docs) < n:
            split_warnings.append(
                {
                    "group": "Bài trình chiếu PowerPoint",
                    "doc_codes": [d["doc_code"] for d in pptx_docs],
                    "suggested_method": "presentation",
                    "reason": f"Có {len(pptx_docs)} file slide trình chiếu. Nếu tách sang kho riêng dùng chế độ Slide, mỗi trang chiếu sẽ được giữ trọn vẹn thay vì bị gộp lẫn lộn.",
                }
            )
        if xlsx_docs and len(xlsx_docs) < n:
            split_warnings.append(
                {
                    "group": "Bảng tính Excel",
                    "doc_codes": [d["doc_code"] for d in xlsx_docs],
                    "suggested_method": "table",
                    "reason": f"Có {len(xlsx_docs)} file bảng tính. Nếu chứa nhiều bảng tra cứu số liệu quan trọng, bạn có thể tách sang kho dùng chế độ Chuyên bảng biểu.",
                }
            )
        if law_docs and len(law_docs) < n and len(law_docs) >= 2:
            split_warnings.append(
                {
                    "group": "Văn bản quy chế / Điều khoản",
                    "doc_codes": [d["doc_code"] for d in law_docs],
                    "suggested_method": "laws",
                    "reason": f"Phát hiện {len(law_docs)} tài liệu chia theo Chương, Điều, Khoản. Tách sang kho dùng chế độ Văn bản quy phạm sẽ giữ nguyên mạch từng điều khoản khi tra cứu.",
                }
            )

    clean_files = [
        {
            "document_id": f["document_id"],
            "doc_code": f["doc_code"],
            "filename": f["filename"],
            "ext": f["ext"].lstrip(".").upper(),
            "size_kb": f["size_kb"],
            "pages_or_units": f["pages_or_units"],
            "is_scan": f["is_scan"],
            "table_count": f["table_count"],
            "image_count": f["image_count"],
            "p75_section_tokens": f["p75_section_tokens"],
            "max_table_tokens": f["max_table_tokens"],
            "has_law_structure": f["has_law_structure"],
        }
        for f in file_profiles
    ]

    return {
        "summary": {
            "total_docs": n,
            "total_mb": round(total_kb / 1024.0, 2),
            "total_pages_or_units": total_pages_or_units,
            "scan_doc_count": len(scan_docs),
            "scan_doc_codes": [d["doc_code"] for d in scan_docs],
            "total_tables": total_tables,
            "docs_with_tables": len(docs_with_tables),
            "total_images": total_images,
            "p50_section_tokens": p50_tokens,
            "p75_section_tokens": p75_tokens,
            "approx_words_per_section": approx_words_per_section,
            "max_table_tokens": max_table_tok,
            "largest_table_doc": largest_table_doc,
            "format_count": len(ext_counts),
        },
        "format_breakdown": format_breakdown,
        "recommended": {
            "chunk_method": rec_method,
            "layout_recognize": rec_layout,
            "chunk_token_num": rec_tokens,
            "overlapped_percent": rec_overlap,
            "table_context_size": rec_table_ctx,
        },
        "param_reasons": {
            "chunk_method": method_reason,
            "layout_recognize": layout_reason,
            "chunk_token_num": token_reason,
            "overlapped_percent": overlap_reason,
            "table_context_size": table_ctx_reason,
        },
        "split_warnings": split_warnings,
        "files": clean_files,
        "excerpts": [
            {"doc_code": f["doc_code"], "ext": f["ext"], "excerpt": f["excerpt"]}
            for f in file_profiles[:6]
            if f.get("excerpt")
        ],
    }
