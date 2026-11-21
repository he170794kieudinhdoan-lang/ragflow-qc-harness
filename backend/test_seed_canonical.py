import os
import openpyxl

base = r"C:\Users\Davil\Downloads\tai_lieu_chuan_extracted\Tài liệu chuẩn"

print("1. Checking 20 documents list...")
f_docs = os.path.join(base, r"Tuần 2\20 tài liệu - mô tả\20 Tài Liệu Test.xlsx")
wb_d = openpyxl.load_workbook(f_docs, data_only=True)
ws_d = wb_d["Danh mục 20 tài liệu test"]
docs_list = []
for r in list(ws_d.iter_rows(values_only=True))[3:23]:
    if r[1] and str(r[1]).startswith("DOC"):
        docs_list.append({
            "code": str(r[1]).strip(),
            "name": str(r[2]).strip(),
            "filename": str(r[3]).strip(),
            "source": str(r[4]).strip(),
            "format_group": str(r[5]).strip(),
            "ext": str(r[6]).strip(),
            "pages_str": str(r[7]).strip(),
        })
print(f"Loaded {len(docs_list)} documents: {[d['code'] for d in docs_list]}")

print("2. Checking 695 chunks from List chunk.xlsx...")
f_chunks = os.path.join(base, "List chunk.xlsx")
wb_c = openpyxl.load_workbook(f_chunks, data_only=True)
ws_c = wb_c["Toàn bộ chunk"]
chunks_list = []
for idx, r in enumerate(list(ws_c.iter_rows(values_only=True))[1:], 2):
    if not r[1] or not str(r[1]).startswith("DOC"):
        continue
    content = str(r[8] or "")
    char_count = len(content)
    try:
        if r[7] is not None:
            char_count = int(float(str(r[7]).strip()))
    except Exception:
        char_count = len(content)
        
    chunks_list.append({
        "doc_code": str(r[1]).strip(),
        "filename": str(r[2]).strip(),
        "chunk_index": int(float(str(r[3] or 0))),
        "chunk_id": str(r[4]).strip(),
        "unit_type": str(r[5]).strip(),
        "page": str(r[6]).strip(),
        "char_count": char_count,
        "content": content,
    })
print(f"Loaded {len(chunks_list)} chunks! (Row 684 fixed via len(content))")

print("3. Checking 110 Golden testcases...")
f_tc = os.path.join(base, r"Tuần 3\GOLDEN-DATASET-TONG-HOP-110-CHUAN_FIXED_V3.xlsx")
wb_tc = openpyxl.load_workbook(f_tc, data_only=True)
ws_tc = wb_tc["Tong_hop_110"]
tc_list = []
for r in list(ws_tc.iter_rows(values_only=True))[1:]:
    if not r[0] or not str(r[0]).startswith("TC"):
        continue
    tc_list.append({
        "tc_code": str(r[0]).strip(),
        "question": str(r[1] or "").strip(),
        "expected": str(r[2] or "").strip(),
        "reference": str(r[3] or "").strip(),
        "cids": str(r[5] or "").strip(),
        "source_file": str(r[6] or "").strip(),
        "class": str(r[7] or "Local").strip(),
        "intent": str(r[8] or "Factoid").strip(),
    })
print(f"Loaded {len(tc_list)} testcases!")

print("4. Checking 1,100 Baseline retrieval results...")
f_ret = os.path.join(base, r"Tuần 4\File_cham_Retrieval_Baseline_110TC.xlsx")
wb_ret = openpyxl.load_workbook(f_ret, data_only=True)
ws_ret = wb_ret["Detail"]
ret_results = []
for r in list(ws_ret.iter_rows(values_only=True))[1:]:
    if not r[0] or not str(r[0]).startswith("TC"):
        continue
    rel_val = None
    if r[9] is not None:
        try:
            rel_val = int(float(str(r[9])))
        except Exception:
            pass
    ret_results.append({
        "tc_code": str(r[0]).strip(),
        "class": str(r[1]).strip(),
        "question": str(r[2] or "").strip(),
        "rank": int(float(str(r[3] or 1))),
        "similarity": float(r[4] or 0.0),
        "term_similarity": float(r[5] or 0.0),
        "vector_similarity": float(r[6] or 0.0),
        "chunk_id": str(r[7]).strip(),
        "doc_name": str(r[8] or "").strip(),
        "relevant": rel_val,
        "reason": str(r[10] or "").strip(),
    })
print(f"Loaded {len(ret_results)} baseline retrieval results!")

# Check TN2 results for A/B comparison test
print("5. Checking 1,100 TN2 retrieval results for A/B Lab...")
f_tn2 = os.path.join(base, r"Tuần 5\File-cham-TN2-110TC.xlsx")
wb_tn2 = openpyxl.load_workbook(f_tn2, data_only=True)
ws_tn2 = wb_tn2["Detail"]
tn2_results = []
for r in list(ws_tn2.iter_rows(values_only=True))[1:]:
    if not r[0] or not str(r[0]).startswith("TC"):
        continue
    rel_val = None
    if r[9] is not None:
        try:
            rel_val = int(float(str(r[9])))
        except Exception:
            pass
    tn2_results.append({
        "tc_code": str(r[0]).strip(),
        "class": str(r[1]).strip(),
        "question": str(r[2] or "").strip(),
        "rank": int(float(str(r[3] or 1))),
        "similarity": float(r[4] or 0.0),
        "term_similarity": float(r[5] or 0.0),
        "vector_similarity": float(r[6] or 0.0),
        "chunk_id": str(r[7]).strip(),
        "doc_name": str(r[8] or "").strip(),
        "relevant": rel_val,
    })
print(f"Loaded {len(tn2_results)} TN2 retrieval results!")
