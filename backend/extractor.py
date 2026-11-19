import os
import re
from typing import List, Tuple
from metrics import nfc

# Tuple format: (unit_type, page_num, title, source_text)
ExtractedUnit = Tuple[str, int, str, str]

_HEADING_RE = re.compile(
    r"^(?:(?:CHƯƠNG|PHẦN|MỤC|BÀI)\s+[\dIVXLC]+|[IVXLC]+\.\s+|\d+(?:\.\d+)*\.?\s+)",
    re.IGNORECASE,
)


def _is_heading(text: str) -> bool:
    t = text.strip()
    if len(t) > 140 or "\n" in t:
        return False
    if _HEADING_RE.match(t):
        return True
    alpha = [c for c in t if c.isalpha()]
    if len(alpha) >= 6 and sum(1 for c in alpha if c.isupper()) / len(alpha) >= 0.85:
        return True
    return False


def _stratified_sample(units: List[ExtractedUnit], max_units: int) -> List[ExtractedUnit]:
    """
    Keep tables prioritized (up to half of max_units) and spread text/heading units
    evenly across the entire document (start -> middle -> end) instead of only the first N.
    """
    if len(units) <= max_units:
        return units

    tables = [(i, u) for i, u in enumerate(units) if u[0] == "table"]
    others = [(i, u) for i, u in enumerate(units) if u[0] != "table"]

    max_tables = min(len(tables), max(1, max_units // 2))
    if len(tables) <= max_tables:
        picked_tables = tables
    else:
        t_idxs = sorted(set(round(k * (len(tables) - 1) / max(max_tables - 1, 1)) for k in range(max_tables)))
        picked_tables = [tables[k] for k in t_idxs]

    rem = max_units - len(picked_tables)
    if len(others) <= rem:
        picked_others = others
    elif rem <= 1:
        picked_others = others[:rem]
    else:
        o_idxs = sorted(set(round(k * (len(others) - 1) / (rem - 1)) for k in range(rem)))
        picked_others = [others[k] for k in o_idxs]

    combined = sorted(picked_tables + picked_others, key=lambda pair: pair[0])
    return [u for _, u in combined]


def _box_overlaps(b1: Tuple[float, float, float, float], b2: Tuple[float, float, float, float]) -> bool:
    x0 = max(b1[0], b2[0])
    y0 = max(b1[1], b2[1])
    x1 = min(b1[2], b2[2])
    y1 = min(b1[3], b2[3])
    if x1 <= x0 or y1 <= y0:
        return False
    inter = (x1 - x0) * (y1 - y0)
    area1 = max((b1[2] - b1[0]) * (b1[3] - b1[1]), 1.0)
    return (inter / area1) >= 0.35


def _merge_blocks_into_paragraphs(
    blocks: List[str], page_num: int, min_chars: int = 220, max_chars: int = 900
) -> List[ExtractedUnit]:
    """
    Merges fragmented PDF text blocks on a page into complete paragraphs/sections:
    - Joins mid-sentence breaks (previous block didn't end with sentence punctuation or
      next block starts with a lowercase letter).
    - Keeps headings attached to the body text right after them.
    - Groups short consecutive bullet/list lines into one coherent unit (220–900 chars)
      so QC never gets tiny 1-line truncated fragments.
    """
    merged: List[ExtractedUnit] = []
    buf = ""
    buf_title = ""

    def flush():
        nonlocal buf, buf_title
        txt = buf.strip()
        if len(txt) >= 60:
            first_line = (buf_title or txt.splitlines()[0]).strip()[:60]
            merged.append(("text", page_num, f"Trang {page_num} · {first_line}", txt))
        buf = ""
        buf_title = ""

    for raw in blocks:
        txt = re.sub(r"[ \t]+", " ", nfc(raw)).strip()
        if not txt:
            continue
        # Drop isolated page numbers
        if re.fullmatch(r"[\d\s\-/]+", txt):
            continue

        is_h = _is_heading(txt)

        if not buf:
            buf = txt
            buf_title = txt.splitlines()[0]
            continue

        # If a new heading starts and current buffer is already substantial, start a new unit
        if is_h and len(buf) >= min_chars:
            flush()
            buf = txt
            buf_title = txt.splitlines()[0]
            continue

        # Detect mid-sentence continuation (broken PDF line / superscript / bullet wrap)
        prev_last = buf[-1]
        next_first = txt[0]
        is_continuation = (
            next_first.islower()
            or prev_last not in ".!?:;\"')]"
        )

        sep = " " if is_continuation else "\n"
        if len(buf) + len(sep) + len(txt) <= max_chars and (is_continuation or len(buf) < min_chars or txt.startswith(("-", "•", "+", "*"))):
            buf = f"{buf}{sep}{txt}"
        else:
            flush()
            buf = txt
            buf_title = txt.splitlines()[0]

    flush()
    return merged


def _extract_pdf(fp: str) -> List[ExtractedUnit]:
    import fitz
    import pdfplumber

    units: List[ExtractedUnit] = []
    table_boxes_by_page = {}

    # 1. Extract structured tables per page via pdfplumber
    try:
        with pdfplumber.open(fp) as plumber_pdf:
            for p_idx, page in enumerate(plumber_pdf.pages, start=1):
                found_tables = page.find_tables() or []
                boxes = []
                for t_idx, tbl in enumerate(found_tables, start=1):
                    boxes.append(tbl.bbox)
                    rows = tbl.extract() or []
                    clean_rows = []
                    for r in rows[:20]:
                        cells = [re.sub(r"\s+", " ", nfc(c or "")).strip() for c in r]
                        if any(cells):
                            clean_rows.append(" | ".join(cells))
                    if len(clean_rows) >= 2:
                        units.append(("table", p_idx, f"Trang {p_idx} · Bảng #{t_idx}", "\n".join(clean_rows)))
                if boxes:
                    table_boxes_by_page[p_idx] = boxes
    except Exception:
        table_boxes_by_page = {}

    # 2. Extract text & heading blocks outside tables via PyMuPDF and merge into full paragraphs
    pdf = fitz.open(fp)
    try:
        for p_idx, page in enumerate(pdf, start=1):
            t_boxes = table_boxes_by_page.get(p_idx, [])
            blocks = page.get_text("blocks")
            # Sort top-to-bottom, left-to-right
            blocks.sort(key=lambda b: (round(b[1] / 12), b[0]))
            page_texts: List[str] = []
            for b in blocks:
                if len(b) < 5:
                    continue
                bbox = (b[0], b[1], b[2], b[3])
                txt = nfc(b[4]).strip()
                if not txt:
                    continue
                if any(_box_overlaps(bbox, tb) for tb in t_boxes):
                    continue
                # Normalize internal soft line wraps inside a PDF block
                lines = [ln.strip() for ln in txt.splitlines() if ln.strip()]
                joined_block = " ".join(lines)
                page_texts.append(joined_block)

            units.extend(_merge_blocks_into_paragraphs(page_texts, p_idx))
    finally:
        pdf.close()

    # Keep natural page order (text/sections then tables per page)
    units.sort(key=lambda u: (u[1], 0 if u[0] != "table" else 1))
    return units


def _extract_docx(fp: str) -> List[ExtractedUnit]:
    import docx

    d = docx.Document(fp)
    units: List[ExtractedUnit] = []
    for p in d.paragraphs:
        txt = nfc(p.text).strip()
        if len(txt) > 35:
            is_h = bool(p.style and "Heading" in p.style.name) or _is_heading(txt)
            u_type = "heading" if is_h else "text"
            title = txt[:55] if is_h else (p.style.name if p.style else "Đoạn")
            units.append((u_type, 1, title, txt))
    for t_idx, tbl in enumerate(d.tables, start=1):
        rows_txt = [
            " | ".join(re.sub(r"\s+", " ", nfc(c.text)).strip() for c in r.cells)
            for r in tbl.rows[:20]
        ]
        rows_txt = [r for r in rows_txt if r.replace("|", "").strip()]
        if rows_txt:
            units.append(("table", 1, f"Bảng #{t_idx}", "\n".join(rows_txt)))
    return units


def _extract_html(fp: str) -> List[ExtractedUnit]:
    from bs4 import BeautifulSoup

    with open(fp, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()

    soup = BeautifulSoup(raw, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "noscript", "svg", "aside"]):
        tag.decompose()

    root = soup.find("article") or soup.find("main") or soup.body or soup
    units: List[ExtractedUnit] = []
    tbl_idx = 0
    for el in root.find_all(["h1", "h2", "h3", "h4", "p", "li", "table"]):
        if el.name == "table":
            tbl_idx += 1
            rows_txt = []
            for tr in el.find_all("tr")[:20]:
                cells = [re.sub(r"\s+", " ", nfc(td.get_text(" ", strip=True))).strip() for td in tr.find_all(["th", "td"])]
                if any(cells):
                    rows_txt.append(" | ".join(cells))
            if len(rows_txt) >= 2:
                units.append(("table", 1, f"Bảng HTML #{tbl_idx}", "\n".join(rows_txt)))
        elif el.find_parent("table") is None:
            txt = re.sub(r"\s+", " ", nfc(el.get_text(" ", strip=True))).strip()
            if len(txt) < 35 and el.name not in ("h1", "h2", "h3", "h4"):
                continue
            if len(txt) < 12:
                continue
            utype = "heading" if el.name in ("h1", "h2", "h3", "h4") else "text"
            units.append((utype, 1, txt[:55], txt))
    return units


def _extract_pptx(fp: str) -> List[ExtractedUnit]:
    from pptx import Presentation

    prs = Presentation(fp)
    units: List[ExtractedUnit] = []
    for s_idx, slide in enumerate(prs.slides, start=1):
        slide_texts = []
        slide_title = ""
        t_idx = 0
        for shape in slide.shapes:
            if shape.has_table:
                t_idx += 1
                rows_txt = []
                for row in shape.table.rows:
                    cells = [re.sub(r"\s+", " ", nfc(c.text)).strip() for c in row.cells]
                    if any(cells):
                        rows_txt.append(" | ".join(cells))
                if rows_txt:
                    units.append(("table", s_idx, f"Slide {s_idx} · Bảng #{t_idx}", "\n".join(rows_txt)))
            elif shape.has_text_frame:
                txt = nfc(shape.text_frame.text).strip()
                if txt:
                    if not slide_title and shape == slide.shapes.title:
                        slide_title = txt.splitlines()[0][:55]
                    slide_texts.append(txt)
        merged = "\n".join(slide_texts).strip()
        if len(merged) >= 25:
            units.append(("text", s_idx, f"Slide {s_idx}" + (f" · {slide_title}" if slide_title else ""), merged))
    return units


def _extract_markdown_or_text(fp: str) -> List[ExtractedUnit]:
    with open(fp, "r", encoding="utf-8", errors="replace") as f:
        raw = nfc(f.read())

    units: List[ExtractedUnit] = []
    blocks = [b.strip() for b in re.split(r"\n\s*\n", raw) if b.strip()]
    idx = 0
    for b in blocks:
        lines = [ln.strip() for ln in b.splitlines() if ln.strip()]
        # Detect Markdown pipe table
        if len(lines) >= 2 and all("|" in ln for ln in lines[:2]):
            idx += 1
            units.append(("table", 1, f"Bảng MD #{idx}", b))
            continue
        if b.startswith("#"):
            clean_h = b.lstrip("#").strip()
            if len(clean_h) >= 8:
                units.append(("heading", 1, clean_h[:55], clean_h))
            continue
        if len(b) >= 35:
            idx += 1
            units.append(("text", 1, f"Đoạn #{idx} · {b[:40]}", b))
    return units


def extract_document_units(fp: str, max_units: int = 25) -> List[ExtractedUnit]:
    """
    Format-aware ground-truth extractor supporting PDF (tables + text via pdfplumber & PyMuPDF),
    DOCX, HTML, PPTX, Markdown, and plain text, with stratified sampling across the whole document.
    """
    ext = os.path.splitext(fp)[1].lower()
    if ext == ".pdf":
        raw_units = _extract_pdf(fp)
    elif ext == ".docx":
        raw_units = _extract_docx(fp)
    elif ext in (".html", ".htm"):
        raw_units = _extract_html(fp)
    elif ext == ".pptx":
        raw_units = _extract_pptx(fp)
    else:
        raw_units = _extract_markdown_or_text(fp)

    return _stratified_sample(raw_units, max_units=max_units)
