import os
import sys
sys.path.append(r"C:\Users\Davil\ragflow-qc-harness\backend")
from extractor import extract_document_units

folder = r"C:\Users\Davil\Downloads\tai_lieu_chuan_extracted\Tài liệu chuẩn\Tuần 2\20 tài liệu - file gốc"
files = sorted(os.listdir(folder))

print(f"Testing extract_document_units on {len(files)} files...\n")
for f in files:
    fp = os.path.join(folder, f)
    try:
        units = extract_document_units(fp, max_units=25)
        types = [u[0] for u in units]
        t_tbl = types.count("table")
        t_txt = types.count("text")
        avg_len = sum(len(u[3]) for u in units) / max(len(units), 1)
        print(f"[{f[:40]:<40}] => {len(units):>2} units (Text: {t_txt:>2}, Table: {t_tbl:>2}, Avg chars: {avg_len:>5.0f})")
    except Exception as e:
        print(f"[{f[:40]:<40}] => ERROR: {e}")
