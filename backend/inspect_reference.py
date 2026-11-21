import os
import sys
import unicodedata
import fitz  # PyMuPDF
import docx
import openpyxl
import pptx
from bs4 import BeautifulSoup

folder = r"C:\Users\Davil\Downloads\tai_lieu_chuan_extracted\Tài liệu chuẩn\Tuần 2\20 tài liệu - file gốc"
files = sorted(os.listdir(folder))
print(f"Total documents in folder: {len(files)}")

report_rows = []

for idx, fn in enumerate(files, 1):
    fp = os.path.join(folder, fn)
    ext = os.path.splitext(fn)[1].lower()
    sz = os.path.getsize(fp)
    text = ""
    pages = 0
    tables = 0
    images = 0
    notes = []

    if ext == ".pdf":
        doc = fitz.open(fp)
        pages = len(doc)
        zero_text_pages = 0
        for pno, p in enumerate(doc):
            t = p.get_text()
            if len(t.strip()) < 20:
                zero_text_pages += 1
            imgs = p.get_images()
            images += len(imgs)
            text += t + "\n"
        doc.close()
        if zero_text_pages > 0:
            notes.append(f"{zero_text_pages}/{pages} trang không có digital text (scan/ảnh)")
    elif ext == ".docx":
        d = docx.Document(fp)
        tables = len(d.tables)
        for p in d.paragraphs:
            text += p.text + "\n"
        for tbl in d.tables:
            for row in tbl.rows:
                for cell in row.cells:
                    text += cell.text + " "
    elif ext == ".pptx":
        prs = pptx.Presentation(fp)
        pages = len(prs.slides)
        for s in prs.slides:
            for shape in s.shapes:
                if shape.has_text_frame:
                    text += shape.text_frame.text + "\n"
                if shape.has_table:
                    tables += 1
                if shape.shape_type == 13:
                    images += 1
    elif ext == ".xlsx":
        wb = openpyxl.load_workbook(fp, data_only=True)
        pages = len(wb.sheetnames)
        tables = pages
        for sname in wb.sheetnames:
            ws = wb[sname]
            for row in ws.iter_rows(values_only=True):
                for val in row:
                    if val is not None:
                        text += str(val) + " "
    elif ext in (".html", ".htm"):
        with open(fp, "r", encoding="utf-8", errors="ignore") as f:
            raw = f.read()
        soup = BeautifulSoup(raw, "html.parser")
        tables = len(soup.find_all("table"))
        images = len(soup.find_all("img"))
        text = soup.get_text()
    elif ext == ".md":
        with open(fp, "r", encoding="utf-8", errors="ignore") as f:
            text = f.read()
            tables = text.count("|---")

    char_len = len(text)
    nfc_len = len(unicodedata.normalize("NFC", text))
    nfd_len = len(unicodedata.normalize("NFD", text))
    is_pure_nfc = (text == unicodedata.normalize("NFC", text))

    # Check for replacement characters, null bytes, special symbols
    corrupt_chars = text.count("\ufffd") + text.count("\x00")
    # Character breakdown
    alpha_cnt = sum(1 for c in text if c.isalpha())
    digit_cnt = sum(1 for c in text if c.isdigit())
    space_cnt = sum(1 for c in text if c.isspace())
    punct_cnt = char_len - alpha_cnt - digit_cnt - space_cnt

    note_str = "; ".join(notes) if notes else "OK"
    report_rows.append({
        "idx": idx,
        "fn": fn,
        "ext": ext,
        "size_kb": round(sz / 1024, 1),
        "pages": pages,
        "chars": char_len,
        "alphas": alpha_cnt,
        "digits": digit_cnt,
        "tables": tables,
        "images": images,
        "nfc": is_pure_nfc,
        "nfd_diff": nfd_len - char_len,
        "corrupt": corrupt_chars,
        "notes": note_str,
    })

print(f"{'#':<3} | {'Tên File':<48} | {'Định dạng':<6} | {'Kích thước':<10} | {'Trang/Slide':<11} | {'Ký tự':<8} | {'Bảng':<5} | {'Ảnh':<5} | {'NFC':<5} | {'Ghi chú'}")
print("-" * 135)
for r in report_rows:
    print(f"{r['idx']:<3} | {r['fn'][:48]:<48} | {r['ext']:<6} | {r['size_kb']:>7} KB | {r['pages']:>11} | {r['chars']:>8} | {r['tables']:>5} | {r['images']:>5} | {str(r['nfc']):<5} | {r['notes']}")
