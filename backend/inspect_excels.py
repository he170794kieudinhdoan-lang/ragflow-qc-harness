import os
import openpyxl

base = r"C:\Users\Davil\Downloads\tai_lieu_chuan_extracted\Tài liệu chuẩn"

excel_files = [
    r"Tuần 2\20 tài liệu - mô tả\20 Tài Liệu Test.xlsx",
    r"Tuần 2\Tuần 2\File task tuần 2.xlsx",
    r"Tuần 3\File chấm chunking.xlsx",
    r"Tuần 3\GOLDEN-DATASET-TONG-HOP-110-CHUAN_FIXED_V3.xlsx",
    r"Tuần 4\File_cham_Retrieval_Baseline_110TC.xlsx",
    r"Tuần 5\File-cham-TN1-110TC.xlsx",
    r"List chunk.xlsx",
]

for rel_path in excel_files:
    full_path = os.path.join(base, rel_path)
    if not os.path.exists(full_path):
        print(f"NOT FOUND: {rel_path}")
        continue
    wb = openpyxl.load_workbook(full_path, data_only=True)
    print(f"\n=======================================================")
    print(f"FILE: {rel_path}")
    print(f"SHEETS: {wb.sheetnames}")
    for sname in wb.sheetnames[:3]:
        ws = wb[sname]
        print(f"  --- Sheet: '{sname}' (max_row={ws.max_row}, max_col={ws.max_column}) ---")
        rows = list(ws.iter_rows(values_only=True))
        for r_idx, row in enumerate(rows[:4], 1):
            row_clean = [str(c)[:35].replace('\n', ' ') if c is not None else '' for c in row[:8]]
            print(f"    R{r_idx}: {row_clean}")
