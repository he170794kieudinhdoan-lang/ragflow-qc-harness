import json
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from database import get_db, utc_now
from exporter import export_run_workbook
from metrics import compute_contextual_precision, detect_chunk_rule_flags

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


def _compute_retrieval_summary(conn, retrieval_run_id: int):
    tcs = conn.execute("SELECT * FROM golden_testcases ORDER BY tc_code").fetchall()
    res_rows = conn.execute(
        "SELECT * FROM retrieval_results WHERE retrieval_run_id = ? ORDER BY testcase_id, rank",
        (retrieval_run_id,),
    ).fetchall()
    meta_rows = conn.execute(
        "SELECT * FROM testcase_eval_meta WHERE retrieval_run_id = ?", (retrieval_run_id,)
    ).fetchall()
    meta_map = {m["testcase_id"]: dict(m) for m in meta_rows}

    by_tc = {}
    for r in res_rows:
        by_tc.setdefault(r["testcase_id"], []).append(dict(r))

    cp_list = []
    cc_list = []
    ac_counts = {"FULL": 0, "SPLIT": 0, "MISSING": 0, "UNCHECKED": 0}
    by_class = {}
    per_tc = {}

    for tc in tcs:
        hits = by_tc.get(tc["id"], [])
        rels = [h["relevant"] for h in hits if h["relevant"] is not None]
        cp = compute_contextual_precision(rels)
        meta = meta_map.get(tc["id"], {})
        cc = float(meta.get("context_coverage", 0.0) or 0.0)
        ac = meta.get("answer_containment", "UNCHECKED")
        ac_counts[ac] = ac_counts.get(ac, 0) + 1

        # Pass threshold: CP >= 0.5 and at least 1 relevant hit
        passed = (cp >= 0.5 and any(v == 1 for v in rels))
        cp_list.append(cp)
        cc_list.append(cc)

        cls = tc["question_class"]
        b = by_class.setdefault(cls, {"count": 0, "cp_sum": 0.0, "cc_sum": 0.0, "pass": 0})
        b["count"] += 1
        b["cp_sum"] += cp
        b["cc_sum"] += cc
        if passed:
            b["pass"] += 1

        per_tc[tc["tc_code"]] = {
            "testcase_id": tc["id"],
            "tc_code": tc["tc_code"],
            "question": tc["input_question"],
            "question_class": cls,
            "source_file": tc["source_file"],
            "cp": cp,
            "cc": cc,
            "ac": ac,
            "passed": passed,
            "root_cause_layer": meta.get("root_cause_layer", ""),
            "root_cause_notes": meta.get("root_cause_notes", ""),
        }

    class_summary = {}
    for cls, b in by_class.items():
        n = max(b["count"], 1)
        class_summary[cls] = {
            "count": b["count"],
            "avg_cp": round(b["cp_sum"] / n, 4),
            "avg_cc": round(b["cc_sum"] / n, 4),
            "pass_rate": round(b["pass"] / n, 4),
        }

    return {
        "total_testcases": len(tcs),
        "avg_contextual_precision": round(sum(cp_list) / len(cp_list), 4) if cp_list else 0.0,
        "avg_context_coverage": round(sum(cc_list) / len(cc_list), 4) if cc_list else 0.0,
        "answer_containment": ac_counts,
        "by_class": class_summary,
        "per_testcase": per_tc,
    }


@router.get("/runs/{run_id}/overview")
def get_run_overview(run_id: int):
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")

        doc_cnt = conn.execute("SELECT COUNT(*) FROM run_documents WHERE run_id = ?", (run_id,)).fetchone()[0]
        chunk_cnt = conn.execute("SELECT COUNT(*) FROM chunks WHERE run_id = ?", (run_id,)).fetchone()[0]

        # Parsing stats
        p_rows = conn.execute("SELECT * FROM parsing_units WHERE run_id = ? AND verdict != 'UNRATED'", (run_id,)).fetchall()
        p_text = [r for r in p_rows if r["unit_type"] != "table"]
        p_tbl = [r for r in p_rows if r["unit_type"] == "table"]
        parsing = {
            "rated": len(p_rows),
            "text_completeness": round(sum(1 for r in p_text if r["verdict"] == "PASS") / len(p_text), 4) if p_text else 0.0,
            "table_accuracy": round(sum(1 for r in p_tbl if r["verdict"] == "PASS") / len(p_tbl), 4) if p_tbl else 0.0,
            "character_error_rate": round(sum(1 for r in p_rows if r["char_error"] == 1) / len(p_rows), 4) if p_rows else 0.0,
        }

        # Chunking stats
        c_rows = conn.execute("SELECT * FROM chunk_evaluations WHERE run_id = ? AND is_sampled = 1", (run_id,)).fetchall()
        def _rate(field, inv=False):
            vals = [r[field] for r in c_rows if r[field] is not None]
            if not vals:
                return 0.0
            return round(sum(1 for v in vals if (v == 0 if inv else v == 1)) / len(vals), 4)

        chunking = {
            "sampled": len(c_rows),
            "chunk_integrity": _rate("integrity"),
            "context_sufficiency": _rate("context_sufficiency"),
            "noise_rate": _rate("no_noise", inv=True),
            "duplicate_rate": _rate("no_duplicate", inv=True),
            "valid_size_rate": _rate("valid_size"),
        }

        # Latest retrieval run for this run_id
        rr = conn.execute("SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1", (run_id,)).fetchone()
        retrieval = _compute_retrieval_summary(conn, rr["id"]) if rr else None

    return {
        "run": dict(run),
        "doc_count": doc_cnt,
        "chunk_count": chunk_cnt,
        "parsing": parsing,
        "chunking": chunking,
        "latest_retrieval_run": dict(rr) if rr else None,
        "retrieval": retrieval,
    }


@router.get("/compare")
def compare_retrieval_runs(baseline_rr_id: int, candidate_rr_id: int):
    with get_db() as conn:
        b_rr = conn.execute("SELECT * FROM retrieval_runs WHERE id = ?", (baseline_rr_id,)).fetchone()
        c_rr = conn.execute("SELECT * FROM retrieval_runs WHERE id = ?", (candidate_rr_id,)).fetchone()
        if not b_rr or not c_rr:
            raise HTTPException(status_code=404, detail="Không tìm thấy Retrieval Run để so sánh")

        b_sum = _compute_retrieval_summary(conn, baseline_rr_id)
        c_sum = _compute_retrieval_summary(conn, candidate_rr_id)

        regressions = []
        improvements = []
        for code, b_tc in b_sum["per_testcase"].items():
            c_tc = c_sum["per_testcase"].get(code)
            if not c_tc:
                continue
            delta_cp = round(c_tc["cp"] - b_tc["cp"], 4)
            entry = {
                "tc_code": code,
                "question": b_tc["question"],
                "question_class": b_tc["question_class"],
                "baseline_cp": b_tc["cp"],
                "candidate_cp": c_tc["cp"],
                "delta_cp": delta_cp,
                "baseline_passed": b_tc["passed"],
                "candidate_passed": c_tc["passed"],
                "root_cause_layer": c_tc["root_cause_layer"] or b_tc["root_cause_layer"],
            }
            if b_tc["passed"] and not c_tc["passed"]:
                regressions.append(entry)
            elif not b_tc["passed"] and c_tc["passed"]:
                improvements.append(entry)

    return {
        "baseline": {"meta": dict(b_rr), "summary": b_sum},
        "candidate": {"meta": dict(c_rr), "summary": c_sum},
        "regressions_pass_to_fail": regressions,
        "improvements_fail_to_pass": improvements,
    }


@router.get("/runs/{run_id}/export-xlsx")
def export_excel(run_id: int):
    try:
        data = export_run_workbook(run_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Run không tồn tại")
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="ragflow_qc_run_{run_id}.xlsx"'},
    )


@router.post("/seed-demo")
def seed_demo_data():
    """Seeds a realistic HIV/AIDS RAGFlow QC workspace so the user can test all 6 screens immediately."""
    now = utc_now()
    with get_db() as conn:
        exists = conn.execute("SELECT id FROM runs WHERE name = 'Baseline_General_512'").fetchone()
        if exists:
            return {"ok": True, "message": "Demo data already exists", "run_id": exists["id"]}

        # Documents
        docs_seed = [
            ("DOC01", "DOC01_VAAC_Nhung-dieu-can-biet-ve-PrEP.pdf", "PDF văn bản", "https://vaac.gov.vn/prep", 18, 1, 1, 0),
            ("DOC06", "DOC06_BYT_BC604_Scan.pdf", "PDF scan / ảnh", "https://moh.gov.vn/bc604", 12, 0, 1, 1),
            ("DOC08", "DOC08_BYT_Huong-dan-chan-doan-HIV.docx", "DOCX có bảng", "https://moh.gov.vn/hd-hiv", 42, 1, 1, 0),
            ("DOC17", "DOC17_Vinmec_HIV-AIDS-la-gi.html", "Trang web (HTML / MD)", "https://vinmec.com/hiv", 4, 0, 1, 0),
            ("DOC11", "DOC11_GSO_Nien-giam-thong-ke-HIV.xlsx", "Slide / Excel", "https://gso.gov.vn/hiv", 6, 1, 0, 0),
        ]
        doc_ids = {}
        for code, fname, grp, url, pgs, tbl, img, scn in docs_seed:
            conn.execute(
                """
                INSERT OR IGNORE INTO documents (doc_code, filename, format_group, source_url, page_count, has_tables, has_images, is_scan, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (code, fname, grp, url, pgs, tbl, img, scn, now),
            )
            doc_ids[code] = conn.execute("SELECT id FROM documents WHERE doc_code = ?", (code,)).fetchone()["id"]

        # Runs
        cur = conn.execute(
            """
            INSERT INTO runs (name, description, is_baseline, ragflow_dataset_id, ragflow_dataset_name, parser_config, retrieval_config, status, created_at)
            VALUES (?, ?, 1, 'demo_ds_baseline', 'HIV_Baseline', ?, ?, 'SYNCED', ?)
            """,
            (
                "Baseline_General_512",
                "Cấu hình chuẩn: General parser, chunk_token_size=512, overlap=0%, DeepDOC OCR",
                json.dumps({"chunk_method": "naive", "chunk_token_num": 512, "overlap": 0, "layout_recognize": "DeepDOC"}),
                json.dumps({"top_k": 10, "similarity_threshold": 0.2, "vector_similarity_weight": 0.3, "rerank_id": ""}),
                now,
            ),
        )
        run_id = cur.lastrowid

        # Run documents
        rd_seed = [
            ("DOC01", "DONE", 1.0, 24, 9800, 14.2, []),
            ("DOC06", "DONE", 1.0, 12, 4100, 48.5, ["OCR_LOW_CONF"]),
            ("DOC08", "DONE", 1.0, 68, 29400, 32.1, []),
            ("DOC17", "DONE", 1.0, 11, 3900, 5.4, []),
            ("DOC11", "DONE", 1.0, 5, 1800, 6.1, []),
        ]
        for code, st, prog, ccnt, tcnt, dur, flags in rd_seed:
            conn.execute(
                """
                INSERT INTO run_documents (run_id, document_id, ragflow_doc_id, parse_status, progress, chunk_count, token_count, parse_duration_sec, anomaly_flags, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (run_id, doc_ids[code], f"rf_{code.lower()}", st, prog, ccnt, tcnt, dur, json.dumps(flags), now),
            )

        # Sample chunks
        chunks_seed = [
            ("DOC01", "chk_d01_01", 1, "Hiệu quả của PrEP: Các thử nghiệm lâm sàng chứng minh sử dụng PrEP đúng cách làm giảm nguy cơ lây nhiễm HIV đến hơn 90% qua đường tình dục và hơn 70% đối với nhóm tiêm chích ma túy.", 3),
            ("DOC01", "chk_d01_02", 2, "6", 4),
            ("DOC06", "chk_d06_01", 1, "Báo c4o công tác ph0ng chong HIV/AIDS năm 2011: Ty le nhiem moi giam 12% so voi cung ky.", 1),
            ("DOC08", "chk_d08_01", 1, "Bảng 4.2 Phác đồ điều trị dự phòng sau phơi nhiễm (PEP): Thời điểm vàng tốt nhất trong vòng 6 giờ và tối đa không quá 72 giờ. Điều trị ARV liên tục trong 28 ngày (4 tuần).", 15),
            ("DOC17", "chk_d17_01", 1, "Trang chủ > Chuyên khoa > Truyền nhiễm | Đăng ký khám | HIV/AIDS là hội chứng suy giảm miễn dịch mắc phải do virus HIV gây ra.", 1),
        ]
        chunk_pks = {}
        for code, cid, cidx, txt, pnum in chunks_seed:
            flags = detect_chunk_rule_flags(txt)
            cur_c = conn.execute(
                """
                INSERT INTO chunks (run_id, document_id, ragflow_doc_id, ragflow_chunk_id, chunk_index, content, char_count, token_est, page_num, rule_flags)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (run_id, doc_ids[code], f"rf_{code.lower()}", cid, cidx, txt, len(txt), max(1, len(txt)//4), pnum, json.dumps(flags)),
            )
            chunk_pks[cid] = cur_c.lastrowid

        # Parsing units
        p_units = [
            ("DOC01", 1, "text", 3, "Câu 2 – Hiệu quả phòng ngừa PrEP", "Các thử nghiệm lâm sàng chứng minh sử dụng PrEP đúng cách làm giảm nguy cơ lây nhiễm HIV đến hơn 90% qua đường tình dục và hơn 70% đối với nhóm tiêm chích ma túy.", ["chk_d01_01"], 0.98, "PASS", [], 0, ""),
            ("DOC06", 1, "text", 1, "Mục 1 – Báo cáo công tác 2011 (Scan)", "Báo cáo công tác phòng chống HIV/AIDS năm 2011: Tỷ lệ nhiễm mới giảm 12% so với cùng kỳ.", ["chk_d06_01"], 0.72, "FAIL", ["P6", "P4"], 1, "High"),
            ("DOC08", 1, "table", 15, "Bảng 4.2 – Phác đồ PEP", "Thời điểm vàng bắt đầu PEP tốt nhất trong vòng 6 giờ, tối đa 72 giờ, uống ARV liên tục 28 ngày.", ["chk_d08_01"], 0.91, "PASS", [], 0, ""),
            ("DOC17", 1, "text", 1, "Mục 1 – Định nghĩa HIV/AIDS", "HIV/AIDS là hội chứng suy giảm miễn dịch mắc phải do virus HIV gây ra.", ["chk_d17_01"], 0.85, "PARTIAL", ["P10"], 0, "Low"),
        ]
        for code, uidx, utype, pnum, title, stxt, mids, msc, verd, errs, cerr, sev in p_units:
            conn.execute(
                """
                INSERT INTO parsing_units (run_id, document_id, unit_index, unit_type, page_num, title, source_text, matched_chunk_ids, match_score, verdict, error_codes, char_error, severity, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (run_id, doc_ids[code], uidx, utype, pnum, title, stxt, json.dumps(mids), msc, verd, json.dumps(errs), cerr, sev, now),
            )

        # Chunk evaluations
        ce_seed = [
            ("chk_d01_01", 1, 1, 1, 1, 1, [], "MANUAL", "Chunk trọn ý, có heading"),
            ("chk_d01_02", 0, 0, 0, 1, 0, ["C4", "C8"], "RULE", "Chunk rác chỉ chứa số trang 6"),
            ("chk_d06_01", 1, 1, 1, 1, 1, [], "MANUAL", "Ranh giới ổn nhưng text lỗi OCR từ tầng Parsing"),
            ("chk_d08_01", 1, 1, 1, 1, 1, [], "MANUAL", "Giữ trọn nội dung bảng 4.2"),
            ("chk_d17_01", 1, 1, 0, 1, 1, ["C4"], "RULE", "Dính breadcrumb và menu Đăng ký khám"),
        ]
        for cid, integ, csuf, nnoise, ndup, vsize, errs, src, note in ce_seed:
            conn.execute(
                """
                INSERT INTO chunk_evaluations (run_id, chunk_id, is_sampled, integrity, context_sufficiency, no_noise, no_duplicate, valid_size, error_codes, judge_source, notes, updated_at)
                VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (run_id, chunk_pks[cid], integ, csuf, nnoise, ndup, vsize, json.dumps(errs), src, note, now),
            )

        # Golden Testcases
        tcs_seed = [
            ("TC01", "Sử dụng PrEP đúng cách giúp giảm bao nhiêu phần trăm nguy cơ lây nhiễm HIV qua đường tình dục?", "Giảm hơn 90% qua đường tình dục.", "Các thử nghiệm lâm sàng chứng minh sử dụng PrEP đúng cách làm giảm nguy cơ lây nhiễm HIV đến hơn 90% qua đường tình dục.", "DOC01", "Local", "Factoid"),
            ("TC02", "Thời điểm vàng bắt đầu điều trị dự phòng sau phơi nhiễm PEP là bao lâu và uống thuốc trong mấy ngày?", "Tốt nhất trong 6 giờ, tối đa 72 giờ, uống ARV liên tục 28 ngày.", "Thời điểm vàng tốt nhất trong vòng 6 giờ và tối đa không quá 72 giờ. Điều trị ARV liên tục trong 28 ngày (4 tuần).", "DOC08", "Local", "Procedural"),
            ("TC03", "Theo báo cáo công tác năm 2011 của Bộ Y tế, tỷ lệ nhiễm HIV mới giảm bao nhiêu phần trăm?", "Giảm 12% so với cùng kỳ.", "Báo cáo công tác phòng chống HIV/AIDS năm 2011: Tỷ lệ nhiễm mới giảm 12% so với cùng kỳ.", "DOC06", "Local", "Factoid"),
        ]
        tc_ids = {}
        for code, q, exp, ref, sfile, cls, intent in tcs_seed:
            conn.execute(
                """
                INSERT OR IGNORE INTO golden_testcases (tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (code, q, exp, ref, sfile, cls, intent, now),
            )
            tc_ids[code] = conn.execute("SELECT id FROM golden_testcases WHERE tc_code = ?", (code,)).fetchone()["id"]

        # Two retrieval runs (Baseline vs Rerank) for A/B Compare Lab
        rr1 = conn.execute(
            "INSERT INTO retrieval_runs (run_id, name, top_k, similarity_threshold, vector_similarity_weight, rerank_id, keyword_enabled, created_at) VALUES (?, 'Baseline (No Rerank, vec=0.3)', 10, 0.2, 0.3, '', 1, ?)",
            (run_id, now),
        ).lastrowid
        rr2 = conn.execute(
            "INSERT INTO retrieval_runs (run_id, name, top_k, similarity_threshold, vector_similarity_weight, rerank_id, keyword_enabled, created_at) VALUES (?, 'Exp1 (BGE-Reranker, vec=0.5)', 10, 0.2, 0.5, 'BAAI/bge-reranker-v2-m3', 1, ?)",
            (run_id, now),
        ).lastrowid

        # Populate retrieval results & cache
        rr_hits = [
            (rr1, "TC01", 1, "chk_d01_01", "DOC01_VAAC_PrEP.pdf", chunks_seed[0][3], 0.88, 0.91, 0.81, 1, "MANUAL", "Trúng trực tiếp số liệu 90%"),
            (rr1, "TC01", 2, "chk_d17_01", "DOC17_Vinmec.html", chunks_seed[4][3], 0.41, 0.45, 0.32, 0, "MANUAL", "Chỉ định nghĩa chung"),
            (rr1, "TC02", 1, "chk_d17_01", "DOC17_Vinmec.html", chunks_seed[4][3], 0.52, 0.55, 0.44, 0, "MANUAL", "Nhiễu rank 1"),
            (rr1, "TC02", 2, "chk_d08_01", "DOC08_BYT_HD.docx", chunks_seed[3][3], 0.49, 0.48, 0.51, 1, "MANUAL", "Đúng bảng 4.2 PEP"),
            (rr1, "TC03", 1, "chk_d17_01", "DOC17_Vinmec.html", chunks_seed[4][3], 0.36, 0.40, 0.25, 0, "MANUAL", "Miss do DOC06 bị lỗi OCR mất dấu"),

            (rr2, "TC01", 1, "chk_d01_01", "DOC01_VAAC_PrEP.pdf", chunks_seed[0][3], 0.94, 0.91, 0.81, 1, "CACHED", "Trúng trực tiếp số liệu 90%"),
            (rr2, "TC02", 1, "chk_d08_01", "DOC08_BYT_HD.docx", chunks_seed[3][3], 0.91, 0.72, 0.51, 1, "CACHED", "Đúng bảng 4.2 PEP"),
            (rr2, "TC03", 1, "chk_d06_01", "DOC06_BYT_Scan.pdf", chunks_seed[2][3], 0.61, 0.65, 0.30, 1, "MANUAL", "Vector weight 0.5 cứu được ca OCR mất dấu"),
        ]
        for rrid, tcc, rk, cid, dname, txt, sim, vsim, tsim, rel, src, rsn in rr_hits:
            conn.execute(
                """
                INSERT INTO retrieval_results (retrieval_run_id, testcase_id, rank, ragflow_chunk_id, doc_name, content, similarity, vector_similarity, term_similarity, relevant, relevancy_source, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (rrid, tc_ids[tcc], rk, cid, dname, txt, sim, vsim, tsim, rel, src, rsn),
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO relevancy_cache (testcase_id, ragflow_chunk_id, relevant, reason, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (tc_ids[tcc], cid, rel, rsn, now),
            )

        # Meta for root cause
        metas = [
            (rr1, "TC01", "FULL", 1.0, "NONE", ""),
            (rr1, "TC02", "FULL", 1.0, "RERANK", "Chunk đúng bị xếp sau chunk định nghĩa chung khi chưa có rerank"),
            (rr1, "TC03", "FULL", 0.0, "PARSING", "DOC06 bị lỗi OCR mất dấu (P6/P4) làm nhánh BM25 không khớp từ khóa"),
            (rr2, "TC01", "FULL", 1.0, "NONE", ""),
            (rr2, "TC02", "FULL", 1.0, "NONE", ""),
            (rr2, "TC03", "FULL", 1.0, "NONE", ""),
        ]
        for rrid, tcc, ac, cc, rc, rcn in metas:
            conn.execute(
                "INSERT OR REPLACE INTO testcase_eval_meta VALUES (?, ?, ?, ?, ?, ?)",
                (rrid, tc_ids[tcc], ac, cc, rc, rcn),
            )

    return {"ok": True, "message": "Seeded realistic demo workspace", "run_id": run_id}


@router.post("/seed-canonical")
def seed_canonical_endpoint():
    """Seeds the full canonical HIV_Chuan dataset (20 docs, 695 chunks, 110 testcases, Baseline & TN2 runs)."""
    try:
        from canonical_seeder import seed_full_canonical_dataset
        return seed_full_canonical_dataset()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi nạp dữ liệu chuẩn: {e}")

