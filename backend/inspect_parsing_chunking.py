import os
import openpyxl

base = r"C:\Users\Davil\Downloads\tai_lieu_chuan_extracted\Tài liệu chuẩn"

# 1. Parsing Sheet
f_p = os.path.join(base, r"Tuần 2\Tuần 2\File task tuần 2.xlsx")
wb_p = openpyxl.load_workbook(f_p, data_only=True)
print("=== PARSING SHEETS IN File task tuần 2.xlsx ===")
for s in wb_p.sheetnames:
    ws = wb_p[s]
    print(f"Sheet '{s}': {ws.max_row} rows, {ws.max_column} cols")

# Check Tiêu chí & Danh mục lỗi
ws_err = wb_p["Tiêu chí & Danh mục lỗi"]
for r in list(ws_err.iter_rows(values_only=True))[:25]:
    if any(r):
        print("  ERR ROW:", [str(c)[:30] for c in r if c is not None][:6])

# 2. Chunking Sheet
f_c = os.path.join(base, r"Tuần 3\File chấm chunking.xlsx")
wb_c = openpyxl.load_workbook(f_c, data_only=True)
print("\n=== CHUNKING SHEETS IN File chấm chunking.xlsx ===")
for s in wb_c.sheetnames:
    ws = wb_c[s]
    print(f"Sheet '{s}': {ws.max_row} rows, {ws.max_column} cols")

ws_c100 = wb_c["Chấm 100 chunks"]
rows_c = list(ws_c100.iter_rows(values_only=True))
print("Header Chấm 100 chunks:", rows_c[1][:12])
sample_rows = [r for r in rows_c[2:] if r[0] is not None]
print(f"Total sampled chunks: {len(sample_rows)}")
# Check scores across the 5 criteria
# STT, Mã tài liệu, Mã chunk, Nội dung chunk, Trọn ý, Tự đủ ngữ cảnh, Không nhiễu, Không trùng lặp, Kích thước hợp lệ
int_scores = [float(r[4]) for r in sample_rows if r[4] is not None]
ctx_scores = [float(r[5]) for r in sample_rows if r[5] is not None]
noi_scores = [float(r[6]) for r in sample_rows if r[6] is not None]
dup_scores = [float(r[7]) for r in sample_rows if r[7] is not None]
siz_scores = [float(r[8]) for r in sample_rows if len(r) > 8 and r[8] is not None]

print(f"Chunk Integrity avg: {sum(int_scores)/len(int_scores):.4f} ({sum(int_scores)}/{len(int_scores)})")
print(f"Context Sufficiency avg: {sum(ctx_scores)/len(ctx_scores):.4f} ({sum(ctx_scores)}/{len(ctx_scores)})")
print(f"No Noise avg: {sum(noi_scores)/len(noi_scores):.4f} ({sum(noi_scores)}/{len(noi_scores)})")
print(f"No Duplicate avg: {sum(dup_scores)/len(dup_scores):.4f} ({sum(dup_scores)}/{len(dup_scores)})")
if siz_scores:
    print(f"Valid Size avg: {sum(siz_scores)/len(siz_scores):.4f} ({sum(siz_scores)}/{len(siz_scores)})")
