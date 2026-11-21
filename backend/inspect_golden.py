import os
import openpyxl
import unicodedata
from collections import Counter

fp = r"C:\Users\Davil\Downloads\tai_lieu_chuan_extracted\Tài liệu chuẩn\Tuần 3\GOLDEN-DATASET-TONG-HOP-110-CHUAN_FIXED_V3.xlsx"
wb = openpyxl.load_workbook(fp, data_only=True)
ws = wb["Tong_hop_110"]
rows = list(ws.iter_rows(values_only=True))
header = rows[0]
print("Header columns:", header)

# Map columns
col_map = {name: i for i, name in enumerate(header) if name}
print("Mapped columns:", col_map)

tcs = []
for r in rows[1:]:
    if not r[0] or not str(r[0]).strip().startswith("TC"):
        continue
    tc_id = str(r[col_map.get("id", 0)]).strip()
    q = str(r[col_map.get("input", 1)] or "").strip()
    ans = str(r[col_map.get("expected_outcome", 2)] or "").strip()
    ref = str(r[col_map.get("reference_context", 3)] or "").strip()
    cids_str = str(r[col_map.get("reference_chunk_ids", 5)] or "").strip()
    src = str(r[col_map.get("source_file", 6)] or "").strip()
    q_class = str(r[col_map.get("class", 7)] or "Local").strip()
    intent = str(r[col_map.get("intent_type", 8)] or "Factoid").strip() if "intent_type" in col_map else "Factoid"
    
    cids = [c.strip() for c in cids_str.split(",") if c.strip()]
    tcs.append({
        "id": tc_id,
        "q": q,
        "ans": ans,
        "ref": ref,
        "cids": cids,
        "src": src,
        "class": q_class,
        "intent": intent,
        "q_len": len(q),
        "ref_len": len(ref),
        "nfc_q": q == unicodedata.normalize("NFC", q),
        "nfc_ref": ref == unicodedata.normalize("NFC", ref),
    })

print(f"\nTotal testcases loaded: {len(tcs)}")
class_counts = Counter(tc["class"] for tc in tcs)
print("Question Classes:", class_counts)

# Check single vs multiple chunks (Answer Containment Ingestion)
single_chunk = sum(1 for tc in tcs if len(tc["cids"]) == 1)
multi_chunk = sum(1 for tc in tcs if len(tc["cids"]) > 1)
zero_chunk = sum(1 for tc in tcs if len(tc["cids"]) == 0)
print(f"Ground-truth Chunking: Single chunk (ACI=1): {single_chunk} ({single_chunk/len(tcs)*100:.1f}%), Multi chunk (ACI=0): {multi_chunk} ({multi_chunk/len(tcs)*100:.1f}%), Zero chunk: {zero_chunk}")

# Source doc distribution
src_counts = Counter(tc["src"].split("_")[0] for tc in tcs)
print("Distribution by Doc:", sorted(src_counts.items()))

# Length statistics
q_lens = [tc["q_len"] for tc in tcs]
ref_lens = [tc["ref_len"] for tc in tcs]
print(f"Question Length (chars): min={min(q_lens)}, max={max(q_lens)}, avg={sum(q_lens)/len(q_lens):.1f}")
print(f"Reference Length (chars): min={min(ref_lens)}, max={max(ref_lens)}, avg={sum(ref_lens)/len(ref_lens):.1f}")

# Non-NFC check
non_nfc_q = [tc["id"] for tc in tcs if not tc["nfc_q"]]
non_nfc_ref = [tc["id"] for tc in tcs if not tc["nfc_ref"]]
print(f"Non-NFC Questions: {len(non_nfc_q)} {non_nfc_q[:5]}")
print(f"Non-NFC References: {len(non_nfc_ref)} {non_nfc_ref[:5]}")
