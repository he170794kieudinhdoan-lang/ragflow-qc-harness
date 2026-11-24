import os
import openpyxl
from database import get_db, utc_now
from metrics import nfc

CANONICAL_BASE = r"C:\Users\Davil\Downloads\tai_lieu_chuan_extracted\Tài liệu chuẩn"


def _build_header_map(row) -> dict:
    return {str(c).strip().lower(): i for i, c in enumerate(row) if c}


def _get_col(row, hmap, *candidates, default=None):
    for c in candidates:
        idx = hmap.get(c.lower())
        if idx is not None and idx < len(row):
            return row[idx]
    return default


def seed_full_canonical_dataset() -> dict:
    if not os.path.exists(CANONICAL_BASE):
        raise FileNotFoundError(f"Thư mục chuẩn không tồn tại: {CANONICAL_BASE}")

    now = utc_now()

    # 1. Read 20 documents
    f_docs = os.path.join(CANONICAL_BASE, r"Tuần 2\20 tài liệu - mô tả\20 Tài Liệu Test.xlsx")
    wb_d = openpyxl.load_workbook(f_docs, data_only=True)
    ws_d = wb_d["Danh mục 20 tài liệu test"]
    docs_info = []
    for r in list(ws_d.iter_rows(values_only=True))[3:23]:
        if r[1] and str(r[1]).startswith("DOC"):
            code = str(r[1]).strip()
            name = str(r[2]).strip()
            fname = str(r[3]).strip()
            src = str(r[4] or "").strip()
            grp = str(r[5] or "").strip()
            p_str = str(r[7] or "").strip()
            p_cnt = 0
            try:
                p_cnt = int("".join(filter(str.isdigit, p_str.split()[0])))
            except Exception:
                pass
            docs_info.append({
                "code": code,
                "name": name,
                "filename": fname,
                "source": src,
                "format_group": grp,
                "pages": p_cnt,
                "is_scan": 1 if "scan" in fname.lower() or "scan" in grp.lower() else 0,
            })

    raw_folder = os.path.join(CANONICAL_BASE, r"Tuần 2\20 tài liệu - file gốc")
    raw_files_map = {}
    if os.path.exists(raw_folder):
        for fn in os.listdir(raw_folder):
            code = fn.split("_")[0]
            raw_files_map[code] = os.path.join(raw_folder, fn)

    with get_db() as conn:
        # Create Run: Baseline (HIV_Chuan 512, 0.7/0.3)
        existing_run = conn.execute("SELECT id FROM runs WHERE name = 'HIV_Chuan_Baseline'").fetchone()
        if existing_run:
            run_id = existing_run["id"]
        else:
            cur = conn.execute(
                """
                INSERT INTO runs (name, description, is_baseline, ragflow_dataset_id, ragflow_dataset_name, parser_config, retrieval_config, status, created_at)
                VALUES (?, ?, 1, ?, ?, ?, ?, 'SYNCED', ?)
                """,
                (
                    "HIV_Chuan_Baseline",
                    "Bộ chuẩn 20 tài liệu HIV_Chuan (chunk 512, delimiter tiêu chuẩn, keyword/vector 0.7/0.3, Top N 10, threshold 0.2)",
                    "552b04f4f43646b585206",
                    "HIV_Chuan",
                    '{"chunk_token_size": 512, "delimiter": "\\n ! ? ; 。 ； ！ ？", "overlap": 0}',
                    '{"keyword_weight": 0.7, "vector_weight": 0.3, "top_n": 10, "similarity_threshold": 0.2}',
                    now,
                ),
            )
            run_id = cur.lastrowid

        # Insert / Update documents
        doc_pk_map = {}
        for d in docs_info:
            fp = raw_files_map.get(d["code"], "")
            conn.execute(
                """
                INSERT INTO documents (doc_code, filename, format_group, source_url, file_path, page_count, is_scan, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(doc_code) DO UPDATE SET
                    filename = excluded.filename,
                    format_group = excluded.format_group,
                    file_path = excluded.file_path,
                    page_count = excluded.page_count,
                    is_scan = excluded.is_scan
                """,
                (d["code"], d["filename"], d["format_group"], d["source"], fp, d["pages"], d["is_scan"], d["name"], now),
            )
            doc_row = conn.execute("SELECT id FROM documents WHERE doc_code = ?", (d["code"],)).fetchone()
            doc_pk_map[d["code"]] = doc_row["id"]

            conn.execute(
                """
                INSERT INTO run_documents (run_id, document_id, ragflow_doc_id, parse_status, progress, chunk_count, updated_at)
                VALUES (?, ?, ?, 'DONE', 1.0, 0, ?)
                ON CONFLICT(run_id, document_id) DO UPDATE SET parse_status = 'DONE', progress = 1.0
                """,
                (run_id, doc_row["id"], f"rdoc_{d['code']}", now),
            )

        # 2. Read 695 chunks from List chunk.xlsx
        f_chunks = os.path.join(CANONICAL_BASE, "List chunk.xlsx")
        wb_c = openpyxl.load_workbook(f_chunks, data_only=True)
        ws_c = wb_c["Toàn bộ chunk"]
        doc_chunk_counts = {}
        chunk_pk_map = {}

        for r in list(ws_c.iter_rows(values_only=True))[1:]:
            if not r[1] or not str(r[1]).startswith("DOC"):
                continue
            doc_code = str(r[1]).strip()
            doc_id = doc_pk_map.get(doc_code)
            c_idx = int(float(str(r[3] or 0)))
            cid = str(r[4]).strip()
            content = nfc(str(r[8] or ""))
            char_count = len(content)
            try:
                if r[7] is not None:
                    char_count = int(float(str(r[7]).strip()))
            except Exception:
                char_count = len(content)

            p_num = 1
            try:
                p_str = str(r[6] or "1").split("–")[0].split("-")[0]
                p_num = int("".join(filter(str.isdigit, p_str)) or 1)
            except Exception:
                pass

            conn.execute(
                """
                INSERT INTO chunks (run_id, document_id, ragflow_doc_id, ragflow_chunk_id, chunk_index, content, char_count, token_est, page_num, rule_flags)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
                ON CONFLICT(run_id, ragflow_chunk_id) DO UPDATE SET content = excluded.content, char_count = excluded.char_count
                """,
                (run_id, doc_id, f"rdoc_{doc_code}", cid, c_idx, content, char_count, char_count // 4, p_num),
            )
            ch_row = conn.execute("SELECT id FROM chunks WHERE run_id = ? AND ragflow_chunk_id = ?", (run_id, cid)).fetchone()
            chunk_pk_map[cid] = ch_row["id"]
            doc_chunk_counts[doc_id] = doc_chunk_counts.get(doc_id, 0) + 1

        for doc_id, cnt in doc_chunk_counts.items():
            conn.execute("UPDATE run_documents SET chunk_count = ? WHERE run_id = ? AND document_id = ?", (cnt, run_id, doc_id))

        # 3. Read 100 sampled chunk evaluations from File chấm chunking.xlsx
        f_ce = os.path.join(CANONICAL_BASE, r"Tuần 3\File chấm chunking.xlsx")
        wb_ce = openpyxl.load_workbook(f_ce, data_only=True)
        ws_ce = wb_ce["Chấm 100 chunks"]
        ce_rows = list(ws_ce.iter_rows(values_only=True))
        for r in ce_rows[2:]:
            if not r[0] or not r[2]:
                continue
            cid = str(r[2]).strip()
            ch_pk = chunk_pk_map.get(cid)
            if not ch_pk:
                continue
            int_v = int(float(str(r[4]))) if r[4] is not None else 1
            ctx_v = int(float(str(r[5]))) if r[5] is not None else 1
            noi_v = int(float(str(r[6]))) if r[6] is not None else 1
            dup_v = int(float(str(r[7]))) if r[7] is not None else 1
            siz_v = int(float(str(r[8]))) if len(r) > 8 and r[8] is not None else 1
            note = str(r[10] or "")
            code_str = str(r[11] or "")

            _legacy_c_map = {
                "C1": "INTEGRITY", "C2": "INTEGRITY", "C3": "CONTEXT",
                "C4": "NOISE", "C5": "NOISE", "C6": "DUPLICATE", "C7": "DUPLICATE", "C8": "SIZE",
            }
            err_set = set()
            for c, mapped in _legacy_c_map.items():
                if c in code_str or c in note or mapped in code_str:
                    err_set.add(mapped)
            err_codes = sorted(err_set)

            conn.execute(
                """
                INSERT INTO chunk_evaluations (run_id, chunk_id, is_sampled, integrity, context_sufficiency, no_noise, no_duplicate, valid_size, error_codes, judge_source, notes, updated_at)
                VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, ?)
                ON CONFLICT(run_id, chunk_id) DO UPDATE SET
                    is_sampled = 1,
                    integrity = excluded.integrity,
                    context_sufficiency = excluded.context_sufficiency,
                    no_noise = excluded.no_noise,
                    no_duplicate = excluded.no_duplicate,
                    valid_size = excluded.valid_size,
                    error_codes = excluded.error_codes,
                    judge_source = 'MANUAL',
                    notes = excluded.notes,
                    updated_at = excluded.updated_at
                """,
                (run_id, ch_pk, int_v, ctx_v, noi_v, dup_v, siz_v, str(err_codes).replace("'", '"'), note, now),
            )

        # 4. Read 110 Golden testcases
        f_tc = os.path.join(CANONICAL_BASE, r"Tuần 3\GOLDEN-DATASET-TONG-HOP-110-CHUAN_FIXED_V3.xlsx")
        wb_tc = openpyxl.load_workbook(f_tc, data_only=True)
        ws_tc = wb_tc["Tong_hop_110"]
        tc_pk_map = {}
        for r in list(ws_tc.iter_rows(values_only=True))[1:]:
            if not r[0] or not str(r[0]).startswith("TC"):
                continue
            code = str(r[0]).strip()
            q = nfc(str(r[1] or "")).strip()
            ans = nfc(str(r[2] or "")).strip()
            ref = nfc(str(r[3] or "")).strip()
            src = str(r[6] or "").strip()
            q_class = str(r[7] or "Local").strip()
            intent = str(r[8] or "Factoid").strip() if len(r) > 8 else "Factoid"

            conn.execute(
                """
                INSERT INTO golden_testcases (tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(tc_code) DO UPDATE SET
                    input_question = excluded.input_question,
                    expected_outcome = excluded.expected_outcome,
                    reference_context = excluded.reference_context,
                    source_file = excluded.source_file,
                    question_class = excluded.question_class,
                    intent_type = excluded.intent_type
                """,
                (code, q, ans, ref, src, q_class, intent, now),
            )
            tc_row = conn.execute("SELECT id FROM golden_testcases WHERE tc_code = ?", (code,)).fetchone()
            tc_pk_map[code] = tc_row["id"]

        # 5. Insert Baseline Retrieval Run & Results
        rr_base = conn.execute("SELECT id FROM retrieval_runs WHERE run_id = ? AND name = 'Baseline_Top10_v1'", (run_id,)).fetchone()
        if rr_base:
            rr_base_id = rr_base["id"]
        else:
            cur = conn.execute(
                """
                INSERT INTO retrieval_runs (run_id, name, top_k, similarity_threshold, vector_similarity_weight, keyword_enabled, created_at)
                VALUES (?, 'Baseline_Top10_v1', 10, 0.2, 0.3, 1, ?)
                """,
                (run_id, now),
            )
            rr_base_id = cur.lastrowid

        f_ret = os.path.join(CANONICAL_BASE, r"Tuần 4\File_cham_Retrieval_Baseline_110TC.xlsx")
        wb_ret = openpyxl.load_workbook(f_ret, data_only=True)
        ws_ret = wb_ret["Detail"]
        ret_rows = list(ws_ret.iter_rows(values_only=True))
        hmap_base = _build_header_map(ret_rows[0])

        for r in ret_rows[1:]:
            tc_val = _get_col(r, hmap_base, "mã tc", "tc_code")
            if not tc_val or not str(tc_val).startswith("TC"):
                continue
            tc_code = str(tc_val).strip()
            tc_id = tc_pk_map.get(tc_code)
            if not tc_id:
                continue
            rank = int(float(str(_get_col(r, hmap_base, "thứ hạng (rank)", "rank", default=1))))
            sim = float(_get_col(r, hmap_base, "điểm hybrid", "hybrid", "similarity", default=0.0) or 0.0)
            term_sim = float(_get_col(r, hmap_base, "điểm bm25", "bm25", "term_similarity", default=0.0) or 0.0)
            vec_sim = float(_get_col(r, hmap_base, "điểm vector", "vector", "vector_similarity", default=0.0) or 0.0)
            cid = str(_get_col(r, hmap_base, "mã chunk", "chunk_id", default="") or "").strip()
            doc_name = str(_get_col(r, hmap_base, "file nguồn", "doc_name", default="") or "").strip()
            rel_raw = _get_col(r, hmap_base, "đánh giá (relevant)", "relevant", default=None)
            rel_val = 0
            if rel_raw is not None:
                try:
                    rel_val = int(float(str(rel_raw)))
                except Exception:
                    rel_val = 0
            reason = str(_get_col(r, hmap_base, "lý do chấm ngắn gọn", "reason", default="") or "").strip()

            conn.execute(
                """
                INSERT INTO retrieval_results (retrieval_run_id, testcase_id, rank, ragflow_chunk_id, doc_name, content, similarity, vector_similarity, term_similarity, relevant, relevancy_source, reason)
                VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, 'MANUAL', ?)
                ON CONFLICT(retrieval_run_id, testcase_id, rank) DO UPDATE SET
                    ragflow_chunk_id = excluded.ragflow_chunk_id,
                    doc_name = excluded.doc_name,
                    similarity = excluded.similarity,
                    vector_similarity = excluded.vector_similarity,
                    term_similarity = excluded.term_similarity,
                    relevant = excluded.relevant,
                    relevancy_source = 'MANUAL',
                    reason = excluded.reason
                """,
                (rr_base_id, tc_id, rank, cid, doc_name, sim, vec_sim, term_sim, rel_val, reason),
            )
            conn.execute(
                """
                INSERT INTO relevancy_cache (testcase_id, ragflow_chunk_id, relevant, reason, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(testcase_id, ragflow_chunk_id) DO UPDATE SET relevant = excluded.relevant, reason = excluded.reason, updated_at = excluded.updated_at
                """,
                (tc_id, cid, rel_val, reason, now),
            )

        # 6. Insert TN2 (Best candidate, vec=0.7) for A/B Lab
        rr_tn2 = conn.execute("SELECT id FROM retrieval_runs WHERE run_id = ? AND name = 'TN2_Optimal_Vector0.7'", (run_id,)).fetchone()
        if rr_tn2:
            rr_tn2_id = rr_tn2["id"]
        else:
            cur = conn.execute(
                """
                INSERT INTO retrieval_runs (run_id, name, top_k, similarity_threshold, vector_similarity_weight, keyword_enabled, created_at)
                VALUES (?, 'TN2_Optimal_Vector0.7', 10, 0.2, 0.7, 1, ?)
                """,
                (run_id, now),
            )
            rr_tn2_id = cur.lastrowid

        f_tn2 = os.path.join(CANONICAL_BASE, r"Tuần 5\File-cham-TN2-110TC.xlsx")
        wb_tn2 = openpyxl.load_workbook(f_tn2, data_only=True)
        ws_tn2 = wb_tn2["Detail"]
        tn2_rows = list(ws_tn2.iter_rows(values_only=True))
        hmap_tn2 = _build_header_map(tn2_rows[0])

        for r in tn2_rows[1:]:
            tc_val = _get_col(r, hmap_tn2, "mã tc", "tc_code")
            if not tc_val or not str(tc_val).startswith("TC"):
                continue
            tc_code = str(tc_val).strip()
            tc_id = tc_pk_map.get(tc_code)
            if not tc_id:
                continue
            rank = int(float(str(_get_col(r, hmap_tn2, "thứ hạng (rank)", "rank", default=1))))
            sim = float(_get_col(r, hmap_tn2, "điểm hybrid", "hybrid", "similarity", default=0.0) or 0.0)
            term_sim = float(_get_col(r, hmap_tn2, "điểm bm25", "bm25", "term_similarity", default=0.0) or 0.0)
            vec_sim = float(_get_col(r, hmap_tn2, "điểm vector", "vector", "vector_similarity", default=0.0) or 0.0)
            cid = str(_get_col(r, hmap_tn2, "mã chunk", "chunk_id", default="") or "").strip()
            doc_name = str(_get_col(r, hmap_tn2, "file nguồn", "doc_name", default="") or "").strip()
            rel_raw = _get_col(r, hmap_tn2, "đánh giá (relevant)", "relevant", default=None)
            rel_val = 0
            if rel_raw is not None:
                try:
                    rel_val = int(float(str(rel_raw)))
                except Exception:
                    rel_val = 0
            reason = str(_get_col(r, hmap_tn2, "lý do chấm ngắn gọn", "reason", default="") or "").strip()

            conn.execute(
                """
                INSERT INTO retrieval_results (retrieval_run_id, testcase_id, rank, ragflow_chunk_id, doc_name, content, similarity, vector_similarity, term_similarity, relevant, relevancy_source, reason)
                VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, 'MANUAL', ?)
                ON CONFLICT(retrieval_run_id, testcase_id, rank) DO UPDATE SET
                    ragflow_chunk_id = excluded.ragflow_chunk_id,
                    doc_name = excluded.doc_name,
                    similarity = excluded.similarity,
                    vector_similarity = excluded.vector_similarity,
                    term_similarity = excluded.term_similarity,
                    relevant = excluded.relevant,
                    relevancy_source = 'MANUAL',
                    reason = excluded.reason
                """,
                (rr_tn2_id, tc_id, rank, cid, doc_name, sim, vec_sim, term_sim, rel_val, reason),
            )

    return {
        "ok": True,
        "run_id": run_id,
        "run_name": "HIV_Chuan_Baseline",
        "documents": len(docs_info),
        "chunks": len(doc_chunk_counts),
        "golden_testcases": len(tc_pk_map),
        "retrieval_runs": ["Baseline_Top10_v1", "TN2_Optimal_Vector0.7"],
    }
