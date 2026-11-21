import os
import openpyxl

base = r"C:\Users\Davil\Downloads\tai_lieu_chuan_extracted\Tài liệu chuẩn"
f_p = os.path.join(base, r"Tuần 2\Tuần 2\File task tuần 2.xlsx")
wb_p = openpyxl.load_workbook(f_p, data_only=True)
ws_err = wb_p["Tiêu chí & Danh mục lỗi"]

print("--- Danh mục mã lỗi (Phụ lục B) ---")
for r in list(ws_err.iter_rows(values_only=True))[20:65]:
    non_empty = [str(c).strip() for c in r if c is not None and str(c).strip()]
    if non_empty:
        print(" | ".join(non_empty[:5]))
