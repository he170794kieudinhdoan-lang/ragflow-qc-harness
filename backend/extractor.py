import os
import re
from typing import List, Tuple
from metrics import canonicalize_text, nfc

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


_LIST_ITEM_RE = re.compile(r"^(?:[-•+*▪◦]|\d+[.)]|[a-zA-Z][.)])\s+")


def _group_blocks_into_sections(
    items: List[Tuple[bool, str]],
    page_num: int = 1,
    title_prefix: str = "",
    min_chars: int = 180,
    max_chars: int = 1000,
) -> List[ExtractedUnit]:
    """
    Groups ordered (is_heading, text) items into complete natural sections BEFORE sampling:
    - Headings NEVER stand alone; they attach to the body text & lists that follow them.
    - Lead-in sentences ending in ':' NEVER separate from the bullet/numbered list right below.
    - Short boilerplate fragments (< 45 chars with no digits and no body) are skipped.
    """
    units: List[ExtractedUnit] = []
    buf: List[str] = []
    buf_len = 0
    buf_title = ""

    def flush():
        nonlocal buf, buf_len, buf_title
        txt = "\n".join(buf).strip()
        # Drop isolated tiny non-numeric fragments (cover titles, stray nav items)
        if len(txt) >= 55 or (len(txt) >= 25 and re.search(r"\d", txt)):
            raw_title = (buf_title or txt.splitlines()[0]).strip()[:55]
            full_title = f"{title_prefix}{raw_title}" if title_prefix else raw_title
            units.append(("text", page_num, full_title, txt))
        buf = []
        buf_len = 0
        buf_title = ""

    for is_h, raw_txt in items:
        txt = re.sub(r"[ \t]+", " ", nfc(raw_txt)).strip()
        if not txt:
            continue
        if re.fullmatch(r"[\d\s\-/.,|]+", txt):
            continue

        if not buf:
            buf = [txt]
            buf_len = len(txt)
            buf_title = txt.splitlines()[0]
            continue

        prev = buf[-1]
        is_lead_in = prev.rstrip().endswith(":")
        is_list = bool(_LIST_ITEM_RE.match(txt))

        # Start a new section when a new heading arrives and current section already has body
        if is_h and buf_len >= min_chars and not is_lead_in:
            flush()
            buf = [txt]
            buf_len = len(txt)
            buf_title = txt.splitlines()[0]
            continue

        # Keep lead-ins (':') + list items + short paragraphs together up to a generous soft cap
        soft_cap = max_chars + (350 if (is_lead_in or is_list) else 0)
        if buf_len + 1 + len(txt) <= soft_cap and (buf_len < min_chars or is_lead_in or is_list or not is_h):
            buf.append(txt)
            buf_len += 1 + len(txt)
        else:
            flush()
            buf = [txt]
            buf_len = len(txt)
            buf_title = txt.splitlines()[0]

    flush()
    return units


def _merge_blocks_into_paragraphs(
    blocks: List[str], page_num: int, min_chars: int = 220, max_chars: int = 1050
) -> List[ExtractedUnit]:
    """
    Merges fragmented PDF text blocks on a page into complete paragraphs/sections:
    - Joins mid-sentence breaks (previous block didn't end with sentence punctuation or
      next block starts with a lowercase letter).
    - Keeps headings and ':' lead-ins attached to the body/list text right after them.
    """
    merged: List[ExtractedUnit] = []
    buf = ""
    buf_title = ""

    def flush():
        nonlocal buf, buf_title
        txt = buf.strip()
        if len(txt) >= 50 or (len(txt) >= 20 and re.search(r"\d", txt)):
            first_line = (buf_title or txt.splitlines()[0]).strip()[:60]
            merged.append(("text", page_num, f"Trang {page_num} · {first_line}", txt))
        buf = ""
        buf_title = ""

    for raw in blocks:
        txt = re.sub(r"[ \t]+", " ", nfc(raw)).strip()
        if not txt:
            continue
        if re.fullmatch(r"[\d\s\-/]+", txt):
            continue

        is_h = _is_heading(txt)

        if not buf:
            buf = txt
            buf_title = txt.splitlines()[0]
            continue

        is_lead_in = buf.rstrip().endswith(":")
        if is_h and len(buf) >= min_chars and not is_lead_in:
            flush()
            buf = txt
            buf_title = txt.splitlines()[0]
            continue

        prev_last = buf[-1]
        next_first = txt[0]
        is_continuation = next_first.islower() or prev_last not in ".!?:;\"')]"
        is_list = bool(_LIST_ITEM_RE.match(txt))

        sep = " " if is_continuation else "\n"
        soft_cap = max_chars + (300 if (is_lead_in or is_list) else 0)
        if len(buf) + len(sep) + len(txt) <= soft_cap and (is_continuation or is_lead_in or is_list or len(buf) < min_chars):
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
                    for r in rows:
                        cells = [re.sub(r"\s+", " ", nfc(c or "")).strip() for c in r]
                        if any(cells):
                            clean_rows.append(" | ".join(cells))
                    if len(clean_rows) >= 2:
                        units.append(("table", p_idx, f"Trang {p_idx} · Bảng #{t_idx}", "\n".join(clean_rows)))
                if boxes:
                    table_boxes_by_page[p_idx] = boxes
    except Exception:
        table_boxes_by_page = {}

    # 2. Extract text, heading, and significant image blocks outside tables via PyMuPDF
    pdf = fitz.open(fp)
    try:
        total_pages = len(pdf)
        # Pre-scan top/bottom short lines across pages to auto-strip running headers/footers (>= 60% of pages)
        repeated_hf: set = set()
        if total_pages >= 3:
            edge_counts: dict = {}
            for page in pdf:
                raw_b = page.get_text("blocks", sort=True)
                t_b = [nfc(b[4]).strip() for b in raw_b if len(b) >= 5 and (len(b) < 7 or b[6] == 0) and nfc(b[4]).strip()]
                seen_on_page = set()
                for edge_txt in (t_b[:2] + t_b[-2:]):
                    first_ln = re.sub(r"\s+", " ", edge_txt.splitlines()[0]).strip()
                    if 4 <= len(first_ln) <= 90 and first_ln not in seen_on_page:
                        seen_on_page.add(first_ln)
                        edge_counts[first_ln] = edge_counts.get(first_ln, 0) + 1
            threshold = max(3, int(total_pages * 0.6))
            repeated_hf = {k for k, v in edge_counts.items() if v >= threshold}

        for p_idx, page in enumerate(pdf, start=1):
            t_boxes = table_boxes_by_page.get(p_idx, [])
            page_w = float(page.rect.width) if page.rect else 600.0
            mid_x = page_w * 0.5

            # Use PyMuPDF's native reading-order sort instead of naive y/12 interleaving
            raw_blocks = page.get_text("blocks", sort=True)

            # Detect 2-column layout: if >= 3 text blocks sit strictly left of mid_x and >= 3 strictly right
            text_blocks = [b for b in raw_blocks if len(b) >= 5 and (len(b) < 7 or b[6] == 0) and nfc(b[4]).strip()]
            left_col = [b for b in text_blocks if b[2] <= mid_x + 12]
            right_col = [b for b in text_blocks if b[0] >= mid_x - 12]
            if len(left_col) >= 3 and len(right_col) >= 3:
                full_width = [b for b in text_blocks if b[2] > mid_x + 12 and b[0] < mid_x - 12]
                ordered_text_blocks = (
                    sorted(full_width, key=lambda b: b[1])
                    + sorted(left_col, key=lambda b: b[1])
                    + sorted(right_col, key=lambda b: b[1])
                )
            else:
                ordered_text_blocks = text_blocks

            page_texts: List[str] = []
            for b in ordered_text_blocks:
                bbox = (b[0], b[1], b[2], b[3])
                txt = nfc(b[4]).strip()
                if not txt:
                    continue
                if any(_box_overlaps(bbox, tb) for tb in t_boxes):
                    continue
                # Normalize internal soft line wraps inside a PDF block & drop running headers/footers
                lines = [ln.strip() for ln in txt.splitlines() if ln.strip()]
                if repeated_hf:
                    lines = [ln for ln in lines if re.sub(r"\s+", " ", ln) not in repeated_hf]
                if not lines:
                    continue
                joined_block = " ".join(lines)
                page_texts.append(joined_block)

            units.extend(_merge_blocks_into_paragraphs(page_texts, p_idx))

        # Pass 2: Extract real embedded images/diagrams via get_image_info(xrefs=True)
        # (PyMuPDF's get_text("blocks") omits image blocks by default in newer versions).
        # Filter out clipping masks (xref==0), tiny icons, full-page backgrounds, and repeated headers/footers.
        total_pages_now = len(pdf)
        if units:  # Only for digital PDFs; 100% scanned PDFs are handled below as per-page OCR units
            img_sig_counts: Dict[Tuple[int, int, int], int] = {}
            img_candidates: List[Tuple[int, int, float, float, Tuple[int, int, int, int], Tuple[int, int, int]]] = []
            for p_idx, page in enumerate(pdf, start=1):
                pw = float(page.rect.width) if page.rect else 600.0
                ph = float(page.rect.height) if page.rect else 800.0
                seen_xrefs = set()
                for ii in page.get_image_info(xrefs=True):
                    xref = int(ii.get("xref") or 0)
                    if not xref or xref in seen_xrefs:
                        continue
                    seen_xrefs.add(xref)
                    x0, y0, x1, y1 = ii["bbox"]
                    w, h = float(x1) - float(x0), float(y1) - float(y0)
                    if w < 100 or h < 70 or w * h < 15000:
                        continue
                    if w >= pw * 0.92 and h >= ph * 0.92:
                        continue
                    sig = (round(w), round(h), round(float(y0) / 10.0))
                    img_sig_counts[sig] = img_sig_counts.get(sig, 0) + 1
                    img_candidates.append((p_idx, xref, w, h, (int(x0), int(y0), int(x1), int(y1)), sig))

            rep_limit = max(3, int(total_pages_now * 0.35))
            img_per_page: Dict[int, int] = {}
            for p_idx, _xref, w, h, bbox, sig in img_candidates:
                if img_sig_counts.get(sig, 0) >= rep_limit:
                    continue
                img_per_page[p_idx] = img_per_page.get(p_idx, 0) + 1
                img_idx = img_per_page[p_idx]
                bx0, by0, bx1, by1 = bbox
                units.append((
                    "image",
                    p_idx,
                    f"Trang {p_idx} · Hình/Sơ đồ #{img_idx}",
                    f"[Hình ảnh / Sơ đồ trang {p_idx} ({int(w)}×{int(h)}px) | bbox={bx0},{by0},{bx1},{by1} — Cần OCR lấy nội dung chuẩn.]",
                ))
    finally:
        total_pages = len(pdf)
        pdf.close()

    # If PDF is 100% scanned without digital text, generate per-page units across the whole document
    # (stratified_sample will spread them evenly from start -> middle -> end instead of only first 25 pages)
    if not units and total_pages > 0:
        for pno in range(1, min(total_pages + 1, 201)):
            units.append((
                "text",
                pno,
                f"Trang {pno} (Bản scan / Cần OCR)",
                f"[Trang {pno}/{total_pages} - Tài liệu ảnh quét scan, không có digital text. Cần kiểm tra chất lượng OCR của RAGFlow.]",
            ))

    # Keep natural page order (text -> tables -> images per page)
    units.sort(key=lambda u: (u[1], 0 if u[0] == "text" else (1 if u[0] == "table" else 2)))
    return units


def _extract_docx(fp: str) -> List[ExtractedUnit]:
    import docx

    d = docx.Document(fp)
    units: List[ExtractedUnit] = []
    # Walk document body in natural order (paragraphs + tables) so headings stay attached
    # to their following paragraphs/lists and never become isolated fragments.
    sec_blocks: List[Tuple[bool, str]] = []
    tbl_idx = 0

    from docx.oxml.table import CT_Tbl
    from docx.oxml.text.paragraph import CT_P
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    for child in d.element.body.iterchildren():
        if isinstance(child, CT_P):
            p = Paragraph(child, d)
            txt = nfc(p.text).strip()
            if not txt:
                continue
            is_h = bool(p.style and "Heading" in p.style.name) or _is_heading(txt)
            sec_blocks.append((is_h, txt))
        elif isinstance(child, CT_Tbl):
            if sec_blocks:
                units.extend(_group_blocks_into_sections(sec_blocks, page_num=1))
                sec_blocks = []
            tbl_idx += 1
            tbl = Table(child, d)
            rows_txt = [
                " | ".join(re.sub(r"\s+", " ", nfc(c.text)).strip() for c in r.cells)
                for r in tbl.rows
            ]
            rows_txt = [r for r in rows_txt if r.replace("|", "").strip()]
            if rows_txt:
                units.append(("table", 1, f"Bảng #{tbl_idx}", "\n".join(rows_txt)))

    if sec_blocks:
        units.extend(_group_blocks_into_sections(sec_blocks, page_num=1))
    return units


def _extract_html(fp: str) -> List[ExtractedUnit]:
    from bs4 import BeautifulSoup

    with open(fp, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()

    soup = BeautifulSoup(raw, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "noscript", "svg", "aside", "form", "iframe", "button"]):
        tag.decompose()

    # Strip common web boilerplate containers (breadcrumbs, sidebars, related articles, comments, menus)
    _boilerplate_re = re.compile(r"(?:breadcrumb|sidebar|related|comment|cookie|menu|navbar|toc|share|social|banner|popup)", re.IGNORECASE)
    for el in list(soup.find_all(True)):
        if getattr(el, "attrs", None) is None:
            continue
        cls_id = " ".join(el.get("class", []) or []) + " " + str(el.get("id") or "")
        if cls_id.strip() and _boilerplate_re.search(cls_id) and el.name not in ("body", "html", "main", "article"):
            el.decompose()

    root = soup.find("article") or soup.find("main") or soup.body or soup
    units: List[ExtractedUnit] = []
    sec_blocks: List[Tuple[bool, str]] = []
    tbl_idx = 0

    for el in root.find_all(["h1", "h2", "h3", "h4", "p", "li", "table"]):
        if el.name == "table":
            if sec_blocks:
                units.extend(_group_blocks_into_sections(sec_blocks, page_num=1))
                sec_blocks = []
            tbl_idx += 1
            rows_txt = []
            for tr in el.find_all("tr"):
                cells = [re.sub(r"\s+", " ", nfc(td.get_text(" ", strip=True))).strip() for td in tr.find_all(["th", "td"])]
                if any(cells):
                    rows_txt.append(" | ".join(cells))
            if len(rows_txt) >= 2:
                units.append(("table", 1, f"Bảng HTML #{tbl_idx}", "\n".join(rows_txt)))
        elif el.find_parent("table") is None:
            # Avoid duplicating text when <p> sits inside <li>
            if el.name == "li" and el.find(["p"]):
                continue
            txt = re.sub(r"\s+", " ", nfc(el.get_text(" ", strip=True))).strip()
            if not txt or len(txt) < 6:
                continue
            is_h = el.name in ("h1", "h2", "h3", "h4")
            if el.name == "li" and not _LIST_ITEM_RE.match(txt):
                txt = f"• {txt}"
            sec_blocks.append((is_h, txt))

    if sec_blocks:
        units.extend(_group_blocks_into_sections(sec_blocks, page_num=1))
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
                raw_lines = [ln.strip() for ln in nfc(shape.text_frame.text).splitlines() if ln.strip()]
                # Drop isolated slide numbers (e.g. "9", "4") and decorative bullet-only lines ("■")
                clean_lines = [
                    ln for ln in raw_lines
                    if not re.fullmatch(r"\d{1,3}", ln) and not re.fullmatch(r"[■▪▫•●◦]+", ln)
                ]
                txt = "\n".join(clean_lines).strip()
                if txt:
                    if not slide_title and shape == slide.shapes.title:
                        slide_title = txt.splitlines()[0][:55]
                    slide_texts.append(txt)
        merged = "\n".join(slide_texts).strip()
        # Skip tiny cover-only title slides (< 45 chars and only 1-2 lines)
        if len(merged) >= 45 or (len(merged) >= 25 and merged.count("\n") >= 2):
            units.append(("text", s_idx, f"Slide {s_idx}" + (f" · {slide_title}" if slide_title else ""), merged))
    return units


def _clean_markdown_inline(text: str) -> str:
    """Delegate to canonicalize_text so Markdown links (including quoted titles), escapes, and headings are cleanly normalized."""
    return canonicalize_text(text)


_MD_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$")


def _extract_markdown_or_text(fp: str) -> List[ExtractedUnit]:
    with open(fp, "r", encoding="utf-8", errors="replace") as f:
        raw = nfc(f.read())

    units: List[ExtractedUnit] = []
    sec_blocks: List[Tuple[bool, str]] = []
    blocks = [b.strip() for b in re.split(r"\n\s*\n", raw) if b.strip()]
    tbl_idx = 0

    for b in blocks:
        lines = [ln.strip() for ln in b.splitlines() if ln.strip()]
        # Detect real Markdown pipe table (must have a |---| separator row)
        if len(lines) >= 2 and any(_MD_TABLE_SEP_RE.match(ln) for ln in lines[:3]):
            if sec_blocks:
                units.extend(_group_blocks_into_sections(sec_blocks, page_num=1))
                sec_blocks = []
            tbl_idx += 1
            units.append(("table", 1, f"Bảng MD #{tbl_idx}", _clean_markdown_inline(b)))
            continue
        if b.startswith("#"):
            clean_h = _clean_markdown_inline(b.lstrip("#").strip()).strip()
            if clean_h:
                sec_blocks.append((True, clean_h))
            continue
        clean_b = _clean_markdown_inline(b).strip()
        if clean_b:
            sec_blocks.append((_is_heading(clean_b), clean_b))

    if sec_blocks:
        units.extend(_group_blocks_into_sections(sec_blocks, page_num=1))
    return units


def _extract_excel(fp: str) -> List[ExtractedUnit]:
    import openpyxl

    wb = openpyxl.load_workbook(fp, data_only=True, read_only=True)
    units: List[ExtractedUnit] = []
    ROWS_PER_UNIT = 15
    try:
        for s_idx, sheet_name in enumerate(wb.sheetnames, start=1):
            ws = wb[sheet_name]
            rows_txt = []
            for row in ws.iter_rows(values_only=True):
                cells = [re.sub(r"\s+", " ", nfc(str(c))).strip() for c in row if c is not None and str(c).strip()]
                if cells:
                    rows_txt.append(" | ".join(cells))
            if len(rows_txt) < 2:
                continue
            header = rows_txt[0]
            data_rows = rows_txt[1:]
            if len(data_rows) <= ROWS_PER_UNIT:
                units.append(("table", s_idx, f"Sheet {s_idx} · {sheet_name}", "\n".join(rows_txt)))
            else:
                for start in range(0, len(data_rows), ROWS_PER_UNIT):
                    part = data_rows[start : start + ROWS_PER_UNIT]
                    r_from = start + 2
                    r_to = start + len(part) + 1
                    units.append((
                        "table",
                        s_idx,
                        f"Sheet {s_idx} · {sheet_name} (dòng {r_from}–{r_to})",
                        "\n".join([header, *part]),
                    ))
    finally:
        wb.close()
    return units


def _extract_csv(fp: str) -> List[ExtractedUnit]:
    import csv

    rows_txt = []
    with open(fp, "r", encoding="utf-8-sig", errors="replace", newline="") as f:
        for row in csv.reader(f):
            cells = [re.sub(r"\s+", " ", nfc(c or "")).strip() for c in row]
            if any(cells):
                rows_txt.append(" | ".join(cells))
    if len(rows_txt) >= 2:
        return [("table", 1, "Bảng CSV", "\n".join(rows_txt))]
    return []


_INVISIBLE_CHARS_RE = re.compile(r"[\u200b\u200c\u200d\ufeff\u00ad]")


def _postprocess_units(raw_units: List[ExtractedUnit]) -> List[ExtractedUnit]:
    """
    Universal, document-agnostic normalizer applied to ALL formats (PDF/DOCX/XLSX/CSV/HTML/PPTX/MD):
    1. Strips invisible Unicode chars (zero-width spaces, BOM, soft hyphens).
    2. Drops trivial noise units (standalone short headings < 45 chars, empty/stub tables).
    3. Splits any huge table (> 15 data rows or > 2200 chars) into header-prefixed slices so
       LLM-as-a-Judge never truncates long multi-page tables (eliminating FALSE PASS on long tables).
    """
    MAX_TBL_ROWS = 15
    MAX_TBL_CHARS = 2200
    cleaned: List[ExtractedUnit] = []

    for utype, pnum, title, text in raw_units:
        txt = _INVISIBLE_CHARS_RE.sub("", nfc(text or "")).strip()
        if not txt:
            continue

        # Keep image/scan placeholders intact
        if utype in ("image", "diagram") or txt.startswith(("[Trang scan", "[Hình ảnh")):
            cleaned.append((utype, pnum, title, txt))
            continue

        if utype == "table":
            rows = [ln.strip() for ln in txt.splitlines() if ln.strip()]
            if len(rows) < 2:
                continue
            header = rows[0]
            data_rows = rows[1:]
            # Drop stub/empty tables (e.g. "Tổng | | " with < 2 meaningful data cells)
            meaningful_cells = [
                c.strip()
                for r in data_rows
                for c in r.split("|")
                if len(re.sub(r"[^0-9A-Za-zÀ-ỹ]+", "", c)) >= 1
            ]
            if len(meaningful_cells) < 2 or len(txt) < 40:
                continue

            if len(data_rows) <= MAX_TBL_ROWS and len(txt) <= MAX_TBL_CHARS:
                cleaned.append((utype, pnum, title, "\n".join(rows)))
            else:
                buf: List[str] = []
                buf_len = len(header)
                part_idx = 0
                for r in data_rows:
                    if buf and (len(buf) >= MAX_TBL_ROWS or buf_len + len(r) + 1 > MAX_TBL_CHARS):
                        part_idx += 1
                        cleaned.append((utype, pnum, f"{title} (phần {part_idx})", "\n".join([header, *buf])))
                        buf = []
                        buf_len = len(header)
                    buf.append(r)
                    buf_len += len(r) + 1
                if buf:
                    part_idx += 1
                    lbl = f"{title} (phần {part_idx})" if part_idx > 1 else title
                    cleaned.append((utype, pnum, lbl, "\n".join([header, *buf])))
        else:
            # Drop standalone short headings / cover-only fragments (< 45 chars)
            if len(txt) < 45:
                continue
            cleaned.append((utype, pnum, title, txt))

    return cleaned


def extract_raw_natural_units(fp: str) -> List[ExtractedUnit]:
    """Extracts ALL complete natural sections/pages/slides/tables across the document without sampling."""
    ext = os.path.splitext(fp)[1].lower()
    if ext == ".pdf":
        raw = _extract_pdf(fp)
    elif ext == ".docx":
        raw = _extract_docx(fp)
    elif ext in (".xlsx", ".xlsm"):
        raw = _extract_excel(fp)
    elif ext == ".csv":
        raw = _extract_csv(fp)
    elif ext in (".html", ".htm"):
        raw = _extract_html(fp)
    elif ext == ".pptx":
        raw = _extract_pptx(fp)
    else:
        raw = _extract_markdown_or_text(fp)
    return _postprocess_units(raw)


def extract_document_units(fp: str, max_units: int = 25) -> List[ExtractedUnit]:
    """
    Format-aware ground-truth extractor supporting PDF (tables + text via pdfplumber & PyMuPDF),
    DOCX, XLSX, CSV, HTML, PPTX, Markdown, and plain text, with stratified sampling across complete natural units.
    """
    return _stratified_sample(extract_raw_natural_units(fp), max_units=max_units)
