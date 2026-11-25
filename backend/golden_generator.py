"""
Standalone Original-File Golden Dataset Generator for RAGFlow QC.
Reads directly from original source files (`documents.file_path`) — 100% independent of
RAGFlow's chunks and Step 2's sampled parsing_units — with disk caching, Bankier (1988)
Adaptive √n document allocation, keyword-matched Multi-hop pairing, and batched LLM calls.
"""

import asyncio
import hashlib
import json
import math
import os
import re
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

import docx
import openpyxl
import pymupdf
from bs4 import BeautifulSoup
from pptx import Presentation
from rapidfuzz import fuzz

from database import DATA_DIR
from llm_client import (
    _run_rapidocr_sync,
    llm_generate_questions_batch,
    local_ocr_with_vietnamese_restore,
    validate_question_style_prompt,
)
from metrics import nfc

CACHE_DIR = os.path.join(DATA_DIR, "golden_source_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

_VI_STOPWORDS = {
    "những", "được", "trong", "không", "người", "nhiều", "cùng", "theo", "khác", "nhất",
    "hiện", "ngày", "tháng", "phần", "bằng", "nhưng", "hoặc", "trên", "dưới", "giữa",
    "trước", "đang", "phải", "cần", "việc", "chỉ", "như", "các", "của", "cho", "với",
    "từ", "đến", "khi", "nếu", "thì", "vào", "này", "đó", "còn", "một", "hai", "ba",
    "tại", "bởi", "sau", "trước", "về", "làm", "nên", "hay", "tuy", "nhiên", "để",
    "thể", "cũng", "đều", "đã", "sẽ", "vẫn", "hơn", "nhau", "mọi", "tất", "cả",
}

_JUNK_QUESTION_RE = re.compile(
    r"(?:hotline|số điện thoại|tổng đài|nhánh\s*\d|địa chỉ liên hệ|tải app|ứng dụng di động|đăng nhập|đăng ký tài khoản|cookie|chính sách bảo mật|menu điều hướng|website.*nào)",
    re.IGNORECASE,
)

_JUNK_SECTION_RE = re.compile(
    r"(?:góp ý,?\s*khiếu nại|tải ứng dụng|đăng ký nhận tin|tổng đài miễn phí|bản quyền thuộc về|chính sách cookie|kết nối với chúng tôi)",
    re.IGNORECASE,
)


def _clean_text(text: str) -> str:
    txt = nfc(text or "")
    txt = re.sub(r"[ \t]+", " ", txt)
    txt = re.sub(r"\n{3,}", "\n\n", txt)
    return txt.strip()


def _split_into_sections(full_text: str, min_len: int = 220, target_len: int = 1100, max_len: int = 1600) -> List[str]:
    """Splits clean document text into coherent ~700-1500 char sections on paragraph boundaries."""
    paras = [p.strip() for p in re.split(r"\n{2,}", _clean_text(full_text)) if p.strip()]
    sections: List[str] = []
    buf: List[str] = []
    buf_len = 0

    for p in paras:
        if _JUNK_SECTION_RE.search(p) and len(p) < 400:
            continue
        if len(p) > max_len:
            if buf and buf_len >= min_len:
                sections.append("\n\n".join(buf))
                buf, buf_len = [], 0
            # Split oversized paragraph on sentence/line boundaries
            lines = [ln.strip() for ln in p.splitlines() if ln.strip()]
            cur = ""
            for ln in lines:
                if len(cur) + len(ln) + 1 > max_len and len(cur) >= min_len:
                    sections.append(cur.strip())
                    cur = ln
                else:
                    cur = f"{cur}\n{ln}".strip()
            if len(cur) >= min_len:
                sections.append(cur.strip())
            continue

        if buf_len + len(p) + 2 > target_len and buf_len >= min_len:
            sections.append("\n\n".join(buf))
            buf = [p]
            buf_len = len(p)
        else:
            buf.append(p)
            buf_len += len(p) + 2

    if buf:
        joined = "\n\n".join(buf)
        if len(joined) >= min_len:
            sections.append(joined)
        elif sections:
            sections[-1] = f"{sections[-1]}\n\n{joined}"
        elif len(joined) >= 80:
            sections.append(joined)

    return sections


def _extract_xlsx_sections(file_path: str) -> Tuple[int, List[Dict[str, Any]]]:
    """
    Extracts clean, self-contained table sections from Excel (.xlsx) preserving multi-row headers
    (e.g. both metric names AND year labels 2011..2024) grouped into compact 6-row slices.
    """
    wb = openpyxl.load_workbook(file_path, data_only=True, read_only=True)
    sections: List[Dict[str, Any]] = []
    total_chars = 0

    for ws in wb.worksheets:
        all_rows = []
        for row in ws.iter_rows(values_only=True):
            vals = [str(v).strip() if v is not None else "" for v in row]
            if any(vals):
                all_rows.append(vals)
        if not all_rows:
            continue

        # Detect header rows (rows before first row with >= 3 numeric values)
        header_rows: List[List[str]] = []
        data_start = 0
        for idx, r in enumerate(all_rows[:8]):
            num_cells = sum(1 for v in r[1:] if re.fullmatch(r"\d+(?:[.,]\d+)?", v))
            # Year row like 2011, 2012, 2013... is still a header row!
            year_cells = sum(1 for v in r if re.fullmatch(r"(?:19|20)\d{2}", v))
            if year_cells >= 3 or num_cells < 3:
                header_rows.append(r)
                data_start = idx + 1
            else:
                break

        data_rows = all_rows[data_start:]
        if not data_rows:
            data_rows = all_rows
            header_rows = []

        # Build compact column labels combining multi-row headers (forward-filled)
        max_cols = max(len(r) for r in all_rows)
        filled_headers: List[List[str]] = []
        for hr in header_rows:
            ff = []
            last = ""
            for ci in range(max_cols):
                v = hr[ci] if ci < len(hr) else ""
                if v:
                    last = v
                ff.append(last if len(header_rows) > 1 and ci > 0 else v)
            filled_headers.append(ff)

        # For very wide tables (> 16 cols), pick representative columns (col 0 + first 10 + last 5)
        if max_cols > 18:
            col_idxs = [0] + list(range(1, 11)) + list(range(max_cols - 6, max_cols))
            col_idxs = sorted(set(i for i in col_idxs if 0 <= i < max_cols))
        else:
            col_idxs = list(range(max_cols))

        col_names = []
        for ci in col_idxs:
            parts = []
            for fh in filled_headers:
                val = fh[ci].strip() if ci < len(fh) else ""
                if val and val not in parts:
                    parts.append(val)
            col_names.append(" / ".join(parts) if parts else f"Cột {ci+1}")

        header_line = " | ".join(col_names)
        # Group data rows into clean 6-row table sections
        step = 6
        for start in range(0, len(data_rows), step):
            chunk_rows = data_rows[start : start + step]
            lines = [f"[Sheet: {ws.title}]", f"Cột: {header_line}"]
            for dr in chunk_rows:
                vals = [dr[ci] if ci < len(dr) and dr[ci] else "—" for ci in col_idxs]
                lines.append(" | ".join(vals))
            sec_txt = "\n".join(lines)
            total_chars += len(sec_txt)
            sections.append({"text": sec_txt, "kind": "table", "loc": f"Sheet {ws.title} dòng {start+1}-{start+len(chunk_rows)}"})

    wb.close()
    return total_chars, sections


def _extract_digital_file_sync(file_path: str) -> Dict[str, Any]:
    """Extracts clean full-document sections synchronously from any digital original file."""
    ext = os.path.splitext(file_path)[1].lower()
    sections: List[Dict[str, Any]] = []

    if ext == ".pdf":
        doc = pymupdf.open(file_path)
        page_count = len(doc)
        page_texts = [(_clean_text(p.get_text("text")), i + 1) for i, p in enumerate(doc)]
        doc.close()

        total_chars = sum(len(t) for t, _ in page_texts)
        if total_chars < 150 and page_count > 0:
            # Scanned PDF — handled asynchronously via RapidOCR
            return {
                "is_scan": True,
                "page_count": page_count,
                "total_chars": page_count * 1600,  # estimated weight for Adaptive √n
                "sections": [],
            }

        # Filter repeated header/footer lines across pages
        line_freq: Counter = Counter()
        for txt, _ in page_texts:
            seen = set()
            for ln in txt.splitlines():
                s = ln.strip()
                if 4 <= len(s) <= 90 and s not in seen:
                    seen.add(s)
                    line_freq[s] += 1
        rep_threshold = max(3, int(page_count * 0.45)) if page_count >= 5 else 999
        repeated = {ln for ln, c in line_freq.items() if c >= rep_threshold}

        for txt, pnum in page_texts:
            clean_lines = [
                ln for ln in txt.splitlines()
                if ln.strip() and ln.strip() not in repeated and not re.fullmatch(r"\d{1,3}", ln.strip())
            ]
            cleaned = "\n".join(clean_lines).strip()
            for sec in _split_into_sections(cleaned, min_len=200, target_len=1150):
                sections.append({"text": sec, "kind": "text", "loc": f"Trang {pnum}"})
        return {"is_scan": False, "page_count": page_count, "total_chars": total_chars, "sections": sections}

    if ext == ".docx":
        d = docx.Document(file_path)
        blocks: List[Tuple[str, str]] = []
        # Iterate body children in document order so paragraphs & tables stay in true order
        from docx.oxml.table import CT_Tbl
        from docx.oxml.text.paragraph import CT_P
        from docx.table import Table
        from docx.text.paragraph import Paragraph

        for child in d.element.body.iterchildren():
            if isinstance(child, CT_P):
                txt = Paragraph(child, d).text.strip()
                if txt:
                    blocks.append(("text", txt))
            elif isinstance(child, CT_Tbl):
                tbl = Table(child, d)
                t_lines = []
                for row in tbl.rows:
                    cells = [c.text.replace("\n", " ").strip() for c in row.cells]
                    if any(cells):
                        t_lines.append(" | ".join(cells))
                if t_lines:
                    blocks.append(("table", "\n".join(t_lines)))

        text_buf: List[str] = []
        total_chars = 0
        sec_idx = 0
        for kind, btxt in blocks:
            total_chars += len(btxt)
            if kind == "table":
                if text_buf:
                    for s in _split_into_sections("\n\n".join(text_buf)):
                        sec_idx += 1
                        sections.append({"text": s, "kind": "text", "loc": f"Mục {sec_idx}"})
                    text_buf = []
                for s in _split_into_sections(btxt, min_len=160, target_len=1200, max_len=1700):
                    sec_idx += 1
                    sections.append({"text": s, "kind": "table", "loc": f"Bảng {sec_idx}"})
            else:
                text_buf.append(btxt)
        if text_buf:
            for s in _split_into_sections("\n\n".join(text_buf)):
                sec_idx += 1
                sections.append({"text": s, "kind": "text", "loc": f"Mục {sec_idx}"})
        return {"is_scan": False, "page_count": max(1, total_chars // 2500), "total_chars": total_chars, "sections": sections}

    if ext == ".pptx":
        prs = Presentation(file_path)
        slide_texts = []
        for idx, slide in enumerate(prs.slides, start=1):
            parts = []
            for shape in slide.shapes:
                if shape.has_text_frame:
                    t = shape.text_frame.text.strip()
                    if t:
                        parts.append(t)
                if shape.has_table:
                    for row in shape.table.rows:
                        cells = [c.text.strip() for c in row.cells]
                        if any(cells):
                            parts.append(" | ".join(cells))
            st = _clean_text("\n".join(parts))
            if len(st) >= 30:
                slide_texts.append((idx, st))
        total_chars = sum(len(t) for _, t in slide_texts)
        # Group every 2-3 slides so each section has rich context
        i = 0
        while i < len(slide_texts):
            grp = slide_texts[i : i + 3]
            loc = f"Slide {grp[0][0]}-{grp[-1][0]}" if len(grp) > 1 else f"Slide {grp[0][0]}"
            txt = "\n\n".join(f"[Slide {sn}]\n{st}" for sn, st in grp)
            if len(txt) >= 120:
                sections.append({"text": txt, "kind": "text", "loc": loc})
            i += 3
        return {"is_scan": False, "page_count": len(prs.slides), "total_chars": total_chars, "sections": sections}

    if ext in (".xlsx", ".xls"):
        total_chars, sections = _extract_xlsx_sections(file_path)
        return {"is_scan": False, "page_count": len(sections), "total_chars": total_chars, "sections": sections}

    if ext in (".html", ".htm"):
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            soup = BeautifulSoup(f.read(), "html.parser")
        for tag in soup(["script", "style", "nav", "header", "footer", "aside", "form", "noscript", "iframe"]):
            tag.decompose()
        main_node = soup.find("article") or soup.find("main") or soup.body or soup
        blocks = []
        for el in main_node.find_all(["h1", "h2", "h3", "h4", "p", "li", "table"]):
            if el.name == "table":
                t_rows = []
                for tr in el.find_all("tr"):
                    cells = [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]
                    if any(cells):
                        t_rows.append(" | ".join(cells))
                if t_rows:
                    blocks.append("\n".join(t_rows))
            else:
                txt = el.get_text(" ", strip=True)
                if len(txt) >= 20 and not _JUNK_SECTION_RE.search(txt):
                    blocks.append(txt)
        joined = "\n\n".join(blocks)
        total_chars = len(joined)
        for idx, sec in enumerate(_split_into_sections(joined, min_len=200, target_len=1100), start=1):
            sections.append({"text": sec, "kind": "text", "loc": f"Đoạn {idx}"})
        return {"is_scan": False, "page_count": max(1, total_chars // 2500), "total_chars": total_chars, "sections": sections}

    # Markdown / plain text
    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        raw = f.read()
    # Strip markdown image/link URLs cluttering text
    cleaned = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", raw)
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cleaned)
    total_chars = len(cleaned.strip())
    for idx, sec in enumerate(_split_into_sections(cleaned, min_len=200, target_len=1100), start=1):
        sections.append({"text": sec, "kind": "text", "loc": f"Đoạn {idx}"})
    return {"is_scan": False, "page_count": max(1, total_chars // 2500), "total_chars": total_chars, "sections": sections}


def _cache_path_for(file_path: str) -> str:
    st = os.stat(file_path)
    key = hashlib.sha256(f"{os.path.abspath(file_path)}|{st.st_size}|{int(st.st_mtime)}|v1".encode("utf-8")).hexdigest()[:20]
    return os.path.join(CACHE_DIR, f"{key}.json")


async def _extract_scan_pdf_sections(
    file_path: str,
    page_count: int,
    target_pages: int,
    llm_base: str,
    llm_key: str,
    llm_model: str,
) -> List[Dict[str, Any]]:
    """
    Renders `target_pages` evenly spread pages (skipping cover page 1 when possible),
    runs RapidOCR in thread pool + Vietnamese accent restoration in parallel.
    """
    n_pick = min(page_count, max(6, target_pages))
    if page_count <= n_pick:
        page_idxs = list(range(page_count))
    else:
        start_p = 1 if page_count >= 5 else 0
        end_p = page_count - 1
        page_idxs = sorted({round(start_p + i * (end_p - start_p) / max(n_pick - 1, 1)) for i in range(n_pick)})

    def _render_pages() -> List[Tuple[int, bytes]]:
        doc = pymupdf.open(file_path)
        out = []
        for pi in page_idxs:
            pix = doc[pi].get_pixmap(dpi=160)
            out.append((pi + 1, pix.tobytes("png")))
        doc.close()
        return out

    rendered = await asyncio.to_thread(_render_pages)

    sem = asyncio.Semaphore(6)
    sections: List[Dict[str, Any]] = []

    async def _ocr_one(pnum: int, img_bytes: bytes):
        async with sem:
            try:
                txt = await local_ocr_with_vietnamese_restore(
                    img_bytes, llm_base=llm_base, llm_key=llm_key, llm_model=llm_model, timeout=45.0
                )
            except Exception:
                txt = await asyncio.to_thread(_run_rapidocr_sync, img_bytes)
            txt = _clean_text(txt)
            if len(txt) >= 160:
                sections.append({"text": txt[:1600], "kind": "scan", "loc": f"Trang scan {pnum}"})

    await asyncio.gather(*(_ocr_one(pn, b) for pn, b in rendered))
    sections.sort(key=lambda s: int(re.search(r"\d+", s["loc"]).group(0)))
    return sections


async def load_original_doc_sections(
    doc_row: Dict[str, Any],
    llm_base: str,
    llm_key: str,
    llm_model: str,
    scan_target_pages: int = 8,
) -> Dict[str, Any]:
    """Loads clean original-file sections with mtime-based disk cache."""
    fp = doc_row.get("file_path") or ""
    if not fp or not os.path.exists(fp):
        return {**doc_row, "total_chars": 0, "sections": [], "is_scan": False}

    cpath = _cache_path_for(fp)
    if os.path.exists(cpath):
        try:
            with open(cpath, "r", encoding="utf-8") as f:
                cached = json.load(f)
            if cached.get("sections"):
                return {**doc_row, **cached}
        except Exception:
            pass

    parsed = await asyncio.to_thread(_extract_digital_file_sync, fp)
    if parsed.get("is_scan"):
        scan_secs = await _extract_scan_pdf_sections(
            fp, parsed["page_count"], scan_target_pages, llm_base, llm_key, llm_model
        )
        parsed["sections"] = scan_secs
        parsed["total_chars"] = max(parsed["total_chars"], sum(len(s["text"]) for s in scan_secs) * 2)

    try:
        with open(cpath, "w", encoding="utf-8") as f:
            json.dump(parsed, f, ensure_ascii=False)
    except Exception:
        pass

    return {**doc_row, **parsed}


def allocate_quotas_sqrt(docs: List[Dict[str, Any]], total_count: int) -> Dict[int, int]:
    """
    Bankier (1988) Square-Root Allocation (q = 0.5) across original documents:
    Every document with content gets at least 1 question, while longer documents receive
    proportionally more questions according to sqrt(total_chars).
    """
    valid = [d for d in docs if d.get("sections")]
    if not valid:
        return {}
    n = len(valid)
    if total_count <= n:
        # Sort by size descending and give 1 each to top `total_count`
        ranked = sorted(valid, key=lambda d: -d.get("total_chars", 0))
        return {d["id"]: (1 if i < total_count else 0) for i, d in enumerate(ranked)}

    # Base 1 per doc, distribute remaining by sqrt(max(chars, 1500))
    quotas = {d["id"]: 1 for d in valid}
    rem = total_count - n
    weights = {d["id"]: math.sqrt(max(d.get("total_chars", 0), 1500)) for d in valid}
    w_sum = sum(weights.values()) or 1.0

    raw_extra = {did: rem * (w / w_sum) for did, w in weights.items()}
    floors = {did: int(math.floor(v)) for did, v in raw_extra.items()}
    for did, fl in floors.items():
        quotas[did] += fl

    leftover = rem - sum(floors.values())
    remainders = sorted(raw_extra.keys(), key=lambda did: -(raw_extra[did] - floors[did]))
    for did in remainders[:leftover]:
        quotas[did] += 1

    return quotas


def _extract_keywords(text: str) -> set:
    words = re.findall(r"[a-zA-ZÀ-ỹ0-9]{4,}", (text or "").lower())
    return {w for w in words if w not in _VI_STOPWORDS and not w.isdigit()}


def _pick_spread_sections(sections: List[Dict[str, Any]], k: int, offset: int = 0) -> List[Dict[str, Any]]:
    n = len(sections)
    if n == 0 or k <= 0:
        return []
    if k >= n:
        return list(sections)
    # Prefer mixing table + text when available
    idxs = sorted({round((i + offset * 0.35) * (n - 1) / max(k - 1, 1)) % n for i in range(k)})
    pos = 0
    while len(idxs) < k and pos < n:
        if pos not in idxs:
            idxs.append(pos)
        pos += 1
    return [sections[i] for i in sorted(idxs)[:k]]


async def generate_golden_dataset_from_originals(
    docs: List[Dict[str, Any]],
    total_count: int,
    llm_base: str,
    llm_key: str,
    llm_model: str,
    style_prompt: str = "",
) -> Tuple[List[Dict[str, Any]], Dict[str, int], List[str], Dict[str, Any]]:
    """
    Full optimized pipeline:
    1. Guardrail validation on optional `style_prompt` (auto-fallback to default if off-topic)
    2. Parallel original-file extraction + disk cache (with RapidOCR for scan PDFs)
    3. Bankier (1988) Adaptive √n quota allocation across all documents
    4. 50% Local / 35% Global / 15% Multi-hop (DF/IDF keyword-matched pairs)
    5. Batched concurrent LLM generation (Semaphore(10)) + Quality Gate
    """
    total_count = max(5, min(total_count, 100))

    # Run style guardrail concurrently with file extraction so latency overhead is 0ms!
    style_task = validate_question_style_prompt(llm_base, llm_key, llm_model, style_prompt)
    extract_task = asyncio.gather(
        *(load_original_doc_sections(d, llm_base, llm_key, llm_model, scan_target_pages=8) for d in docs)
    )
    (eff_style, style_fallback, style_notice), loaded_docs = await asyncio.gather(style_task, extract_task)
    valid_docs = [d for d in loaded_docs if d.get("sections")]
    if not valid_docs:
        return [], {}, ["Không trích xuất được nội dung sạch từ các file tài liệu gốc."], {}

    # 2. Over-generate ~20% buffer so after Quality Gate dedup/junk filtering we still land on exact `total_count`
    n_local_goal = round(total_count * 0.50)
    n_global_goal = round(total_count * 0.35)
    n_multi_goal = max(0, total_count - n_local_goal - n_global_goal)

    plan_total = min(130, total_count + max(6, round(total_count * 0.22)))
    quotas = allocate_quotas_sqrt(valid_docs, plan_total)
    n_local_target = round(plan_total * 0.50)
    n_global_target = round(plan_total * 0.35)
    n_multi_target = max(0, plan_total - n_local_target - n_global_target)

    # 3. Assign each document's quota across Local / Global / Multi-hop cleanly
    local_items: List[Dict[str, Any]] = []
    global_items: List[Dict[str, Any]] = []

    # Sort docs by size descending so Global questions go naturally to richer documents
    docs_by_size = sorted(valid_docs, key=lambda d: -d.get("total_chars", 0))
    doc_rem = dict(quotas)

    # Reserve Multi-hop slots from the largest docs first
    multi_budget = n_multi_target
    for d in docs_by_size:
        if multi_budget <= 0:
            break
        if doc_rem[d["id"]] >= 2:
            doc_rem[d["id"]] -= 1
            multi_budget -= 1

    # Assign Global slots to docs with >= 3 sections
    global_budget = n_global_target
    for d in docs_by_size:
        if global_budget <= 0:
            break
        secs = d["sections"]
        if len(secs) < 2 or doc_rem[d["id"]] <= 0:
            continue
        # Give up to ~45% of a rich doc's quota to Global
        take = min(global_budget, max(1, doc_rem[d["id"]] // 2) if doc_rem[d["id"]] >= 2 else 0)
        for g_idx in range(take):
            picks = _pick_spread_sections(secs, min(3, len(secs)), offset=g_idx)
            combined = "\n\n".join(f"[{p['loc']}]\n{p['text'][:950]}" for p in picks)
            global_items.append({
                "target_class": "Global",
                "context": combined,
                "source_file": d["filename"],
                "ref_tag": f"File gốc: {d['doc_code']} ({', '.join(p['loc'] for p in picks)})",
            })
            doc_rem[d["id"]] -= 1
            global_budget -= 1

    # Remaining per-doc quotas go to Local (guaranteed every doc gets >= 1 Local!)
    for d in docs_by_size:
        k_loc = doc_rem[d["id"]]
        if k_loc <= 0:
            continue
        picks = _pick_spread_sections(d["sections"], k_loc, offset=1)
        for p in picks:
            local_items.append({
                "target_class": "Local",
                "context": p["text"][:1600],
                "source_file": d["filename"],
                "ref_tag": f"File gốc: {d['doc_code']} · {p['loc']}",
            })

    # Build semantically matched Multi-hop pairs using Dynamic DF/IDF filtering
    # (automatically excludes generic corpus-wide terms appearing in >35% of sections)
    multi_items: List[Dict[str, Any]] = []
    if n_multi_target > 0:
        pool = []
        df_counter: Counter = Counter()
        for d in docs_by_size:
            for s in _pick_spread_sections(d["sections"], min(5, len(d["sections"]))):
                kws = _extract_keywords(s["text"])
                if len(kws) >= 6:
                    pool.append((d, s, kws))
                    for w in kws:
                        df_counter[w] += 1

        pool_n = max(len(pool), 1)
        # Keep only domain-specific rare terms (appear in 2 .. 35% of pool sections)
        max_df = max(2, int(pool_n * 0.35))
        rare_idf = {
            w: math.log((pool_n + 1) / (cnt + 1)) + 1.0
            for w, cnt in df_counter.items()
            if 2 <= cnt <= max_df
        }

        scored_pairs = []
        for i in range(len(pool)):
            d1, s1, kw1 = pool[i]
            r1 = kw1 & rare_idf.keys()
            if len(r1) < 2:
                continue
            for j in range(i + 1, len(pool)):
                d2, s2, kw2 = pool[j]
                if d1["id"] == d2["id"] and s1["loc"] == s2["loc"]:
                    continue
                overlap = r1 & kw2
                if len(overlap) >= 2:
                    idf_score = sum(rare_idf[w] for w in overlap)
                    cross_bonus = 1.6 if d1["id"] != d2["id"] else 1.0
                    score = idf_score * cross_bonus
                    top_terms = sorted(overlap, key=lambda w: -rare_idf[w])[:4]
                    scored_pairs.append((score, top_terms, d1, s1, d2, s2))
        scored_pairs.sort(key=lambda x: -x[0])

        used_pairs = set()
        used_doc_pairs: Counter = Counter()
        for _, shared_kws, d1, s1, d2, s2 in scored_pairs:
            if len(multi_items) >= n_multi_target:
                break
            sig = tuple(sorted([f"{d1['doc_code']}:{s1['loc']}", f"{d2['doc_code']}:{s2['loc']}"]))
            dp_sig = tuple(sorted([d1["doc_code"], d2["doc_code"]]))
            if sig in used_pairs or used_doc_pairs[dp_sig] >= 2:
                continue
            used_pairs.add(sig)
            used_doc_pairs[dp_sig] += 1
            src_name = d1["filename"] if d1["id"] == d2["id"] else f"{d1['filename']}; {d2['filename']}"
            combined = (
                f"[Đoạn A — {d1['doc_code']} ({s1['loc']})]\n{s1['text'][:1250]}\n\n"
                f"[Đoạn B — {d2['doc_code']} ({s2['loc']})]\n{s2['text'][:1250]}"
            )
            multi_items.append({
                "target_class": "Multi-hop",
                "context": combined,
                "source_file": src_name,
                "ref_tag": f"File gốc: {d1['doc_code']}↔{d2['doc_code']} ({', '.join(shared_kws[:3])})",
            })

    # 4. Batch LLM calls for low latency:
    #    - Local: batch 3 items per call (~8-9 calls)
    #    - Global: batch 2 items per call (~8-9 calls)
    #    - Multi-hop: 1 item per call for highest reasoning quality (~7-8 calls)
    batches: List[List[Dict[str, Any]]] = []
    for i in range(0, len(local_items), 3):
        batches.append(local_items[i : i + 3])
    for i in range(0, len(global_items), 2):
        batches.append(global_items[i : i + 2])
    for m in multi_items:
        batches.append([m])

    sem = asyncio.Semaphore(10)
    raw_results: List[Tuple[int, Dict[str, Any]]] = []
    errors: List[str] = []

    async def _run_batch(b_idx: int, batch: List[Dict[str, Any]]):
        async with sem:
            try:
                gen = await llm_generate_questions_batch(llm_base, llm_key, llm_model, batch, style_prompt=eff_style)
                for offset, item in enumerate(gen):
                    raw_results.append((b_idx * 10 + offset, item))
            except Exception as e:
                errors.append(str(e)[:180])

    await asyncio.gather(*(_run_batch(i, b) for i, b in enumerate(batches)))
    raw_results.sort(key=lambda x: x[0])

    # 5. Automated Quality Gate: strip accidental meta-prefixes, remove junk & near-duplicate topics
    _meta_prefix_re = re.compile(
        r"^(?:theo\s+(?:tài liệu|báo cáo|hướng dẫn|văn bản|cẩm nang)(?:\s+(?:của\s+)?[A-Za-zÀ-ỹ0-9\s]{0,25})?\s*,\s*)",
        re.IGNORECASE,
    )
    clean_by_class: Dict[str, List[Dict[str, Any]]] = {"Local": [], "Global": [], "Multi-hop": []}
    seen_qs: List[str] = []
    filtered_out = 0

    for _, item in raw_results:
        q = (item.get("question") or "").strip()
        q = _meta_prefix_re.sub("", q).strip()
        if q and q[0].islower():
            q = q[0].upper() + q[1:]
        item["question"] = q
        if len(q) < 12 or _JUNK_QUESTION_RE.search(q):
            filtered_out += 1
            continue
        q_low = q.lower()
        if any(fuzz.token_set_ratio(q_low, prev) >= 74 for prev in seen_qs):
            filtered_out += 1
            continue
        seen_qs.append(q_low)
        qc = item.get("question_class", "Local")
        if qc not in clean_by_class:
            qc = "Local"
        clean_by_class[qc].append(item)

    # Select exact `total_count`:
    # Pass 1: Guarantee at least 1 clean question per original document (100% file coverage!)
    # Pass 2: Fill remaining slots respecting Local / Global / Multi-hop target ratios
    final_items: List[Dict[str, Any]] = []
    picked_ids: set = set()
    covered_files: set = set()
    class_picked = {"Local": 0, "Global": 0, "Multi-hop": 0}
    class_goals = {"Local": n_local_goal, "Global": n_global_goal, "Multi-hop": n_multi_goal}

    all_clean = clean_by_class["Local"] + clean_by_class["Global"] + clean_by_class["Multi-hop"]
    for idx_it, it in enumerate(all_clean):
        if len(final_items) >= total_count:
            break
        primary_src = (it.get("source_file") or "").split(";")[0].strip()
        if primary_src and primary_src not in covered_files:
            covered_files.add(primary_src)
            picked_ids.add(idx_it)
            final_items.append(it)
            qc = it.get("question_class", "Local")
            class_picked[qc] = class_picked.get(qc, 0) + 1

    # Pass 2: Fill up to each class goal
    for cls in ("Local", "Global", "Multi-hop"):
        for idx_it, it in enumerate(all_clean):
            if len(final_items) >= total_count or class_picked[cls] >= class_goals[cls]:
                break
            if idx_it in picked_ids or it.get("question_class", "Local") != cls:
                continue
            picked_ids.add(idx_it)
            final_items.append(it)
            class_picked[cls] += 1

    # Pass 3: Top up any remaining slots from leftovers if a class had fewer clean items than goal
    if len(final_items) < total_count:
        for idx_it, it in enumerate(all_clean):
            if len(final_items) >= total_count:
                break
            if idx_it not in picked_ids:
                picked_ids.add(idx_it)
                final_items.append(it)
                qc = it.get("question_class", "Local")
                class_picked[qc] = class_picked.get(qc, 0) + 1

    # Sort cleanly: Local -> Global -> Multi-hop
    order_map = {"Local": 0, "Global": 1, "Multi-hop": 2}
    final_items.sort(key=lambda x: order_map.get(x.get("question_class", "Local"), 0))
    class_counts = class_picked

    meta = {
        "docs_used": len(valid_docs),
        "llm_batches": len(batches),
        "filtered_out": filtered_out,
        "style_used": eff_style or "default",
        "style_fallback": style_fallback,
        "style_notice": style_notice,
        "quotas": {d["doc_code"]: quotas.get(d["id"], 0) for d in docs_by_size},
    }
    return final_items, class_counts, errors, meta
