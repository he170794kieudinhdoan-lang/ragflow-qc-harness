import json
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from database import get_current_account_key, get_db, get_float_setting
from diagnostic_swarm import run_compare_regression_autopsy
from exporter import export_run_workbook
from metrics import (
    CHUNKING_ERROR_CATALOG,
    PARSING_ERROR_CATALOG,
    RETRIEVAL_ERROR_CATALOG,
    compute_contextual_precision,
    compute_parsing_metrics,
    compute_weighted_chunking_rates,
)

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


@router.get("/runs/{run_id}/diagnostics")
def get_run_diagnostics(run_id: int):
    """
    Aggregates all 3 layers (Parsing, Chunking, Retrieval) for `run_id` and generates
    actionable RAGFlow configuration recommendations based on detected failure patterns.
    """
    from routers.parsing import get_parsing_metrics
    from routers.chunking import get_chunking_metrics

    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")
        latest_rr = conn.execute(
            "SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1",
            (run_id,),
        ).fetchone()
        ret_summary = _compute_retrieval_summary(conn, latest_rr["id"]) if latest_rr else None

    p = get_parsing_metrics(run_id)
    c = get_chunking_metrics(run_id)

    recommendations = []

    # Layer 1: Parsing diagnostics
    if p["rated_units"] > 0:
        if p["table_accuracy"] < get_float_setting("target_table_accuracy", 0.75):
            recommendations.append({
                "layer": "PARSING",
                "severity": "high",
                "title": f"Độ chính xác bảng biểu thấp ({round(p['table_accuracy'] * 100)}%)",
                "action": "Trong Cấu hình Parse → Parser & OCR: bật DeepDOC, tăng Table Context Size (256–512) hoặc đổi Chunk Method sang 'table' cho tài liệu nhiều bảng.",
            })
        if p["text_completeness"] < get_float_setting("target_text_completeness", 0.80):
            recommendations.append({
                "layer": "PARSING",
                "severity": "high",
                "title": f"Chất lượng đọc chữ / OCR chưa đạt ({round(p['text_completeness'] * 100)}%)",
                "action": "Bật 'Enable Vision Enhancement' trong Cấu hình Parse hoặc chuyển PDF Parser sang MinerU đối với tài liệu scan / mờ.",
            })
        if p["reading_order_accuracy"] < get_float_setting("target_reading_order", 0.80):
            recommendations.append({
                "layer": "PARSING",
                "severity": "medium",
                "title": f"Lỗi thứ tự đọc / đảo cột ({round(p['reading_order_accuracy'] * 100)}%)",
                "action": "Kiểm tra lại PDF nhiều cột; dùng DeepDOC layout-aware thay vì Plain Text.",
            })

    # Layer 2: Chunking diagnostics
    if c["sampled_total"] > 0:
        if c["chunk_integrity"] < get_float_setting("target_chunk_integrity", 0.80):
            recommendations.append({
                "layer": "CHUNKING",
                "severity": "high",
                "title": f"Tính toàn vẹn chunk thấp ({round(c['chunk_integrity'] * 100)}%)",
                "action": "Tăng Chunk Token Size (VD: 512 → 768/1024) hoặc tăng Overlapped Percent lên 10–15% để tránh cắt đứt câu/bảng.",
            })
        if c["noise_rate"] > get_float_setting("max_chunk_noise_rate", 0.15):
            recommendations.append({
                "layer": "CHUNKING",
                "severity": "medium",
                "title": f"Tỷ lệ chunk dính nhiễu cao ({round(c['noise_rate'] * 100)}%)",
                "action": "Kiểm tra header/footer lặp lại trong PDF và điều chỉnh Delimiters trong Cấu hình Parse → Chunker.",
            })
        if c["valid_size_rate"] < get_float_setting("target_valid_size_rate", 0.85):
            recommendations.append({
                "layer": "CHUNKING",
                "severity": "medium",
                "title": f"Nhiều chunk sai kích thước chuẩn ({round((1 - c['valid_size_rate']) * 100)}%)",
                "action": "Điều chỉnh Chunk Token Size hoặc bật Parent-Child Chunking để cân bằng độ dài chunk.",
            })

    # Layer 3: Retrieval diagnostics
    if ret_summary and ret_summary["total_testcases"] > 0:
        if ret_summary["avg_contextual_precision"] < get_float_setting("target_contextual_precision", 0.65):
            recommendations.append({
                "layer": "RETRIEVAL",
                "severity": "high",
                "title": f"Contextual Precision thấp ({round(ret_summary['avg_contextual_precision'] * 100)}%)",
                "action": "Bật Rerank model, tăng trọng số Hybrid Search (vector_similarity_weight ~ 0.3–0.5) hoặc giảm similarity_threshold xuống 0.15.",
            })
        if ret_summary["avg_context_coverage"] < get_float_setting("target_context_coverage", 0.70):
            recommendations.append({
                "layer": "RETRIEVAL",
                "severity": "medium",
                "title": f"Độ phủ ngữ cảnh (Context Coverage) còn thấp ({round(ret_summary['avg_context_coverage'] * 100)}%)",
                "action": "Tăng Top-K (VD: 10 → 15) hoặc bật Parent-Child Chunking để trả về ngữ cảnh rộng hơn.",
            })

    if not recommendations:
        recommendations.append({
            "layer": "OK",
            "severity": "ok",
            "title": "Các chỉ số hiện tại đạt ngưỡng tốt",
            "action": "Bạn có thể tiếp tục chạy so sánh A/B với các cấu hình tinh chỉnh nhỏ để tối ưu thêm.",
        })

    return {
        "run_id": run_id,
        "run_name": run["name"],
        "parsing": p,
        "chunking": c,
        "retrieval": ret_summary,
        "recommendations": recommendations,
    }


@router.get("/runs/{run_id}/overview")
def get_run_overview(run_id: int):
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")

        doc_cnt = conn.execute("SELECT COUNT(*) FROM run_documents WHERE run_id = ?", (run_id,)).fetchone()[0]
        chunk_cnt = conn.execute("SELECT COUNT(*) FROM chunks WHERE run_id = ?", (run_id,)).fetchone()[0]

        # Parsing stats (Single Source of Truth via compute_parsing_metrics)
        p_rows = conn.execute("SELECT * FROM parsing_units WHERE run_id = ?", (run_id,)).fetchall()
        pm = compute_parsing_metrics(p_rows)
        parsing = {
            **pm,
            "rated": pm["rated_units"],
        }

        # Chunking stats (Cochran 1977 Stratified Weighted — matches Step 3 ChunkingPage 1-for-1)
        c_rows = conn.execute(
            """
            SELECT ce.*, c.document_id
            FROM chunk_evaluations ce
            JOIN chunks c ON c.id = ce.chunk_id
            WHERE ce.run_id = ? AND ce.is_sampled = 1
            """,
            (run_id,),
        ).fetchall()
        doc_totals = {
            r["document_id"]: r["cnt"]
            for r in conn.execute(
                "SELECT document_id, COUNT(*) AS cnt FROM chunks WHERE run_id = ? GROUP BY document_id",
                (run_id,),
            ).fetchall()
        }
        cm = compute_weighted_chunking_rates(c_rows, doc_totals)
        chunking = {
            "sampled": len(c_rows),
            "chunk_integrity": cm["chunk_integrity"],
            "context_sufficiency": cm["context_sufficiency"],
            "noise_rate": cm["noise_rate"],
            "duplicate_rate": cm["duplicate_rate"],
            "valid_size_rate": cm["valid_size_rate"],
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

        b_hits = conn.execute(
            "SELECT testcase_id, ragflow_chunk_id, doc_name, relevant, reason FROM retrieval_results WHERE retrieval_run_id = ?",
            (baseline_rr_id,),
        ).fetchall()
        c_hits = conn.execute(
            "SELECT testcase_id, ragflow_chunk_id, doc_name, relevant, reason FROM retrieval_results WHERE retrieval_run_id = ?",
            (candidate_rr_id,),
        ).fetchall()
        tc_code_map = {
            r["id"]: r["tc_code"]
            for r in conn.execute("SELECT id, tc_code FROM golden_testcases").fetchall()
        }

        b_hit_map = {(r["testcase_id"], r["ragflow_chunk_id"]): dict(r) for r in b_hits}
        agreed_hits = 0
        compared_hits = 0
        disagreed_samples = []
        for ch in c_hits:
            bh = b_hit_map.get((ch["testcase_id"], ch["ragflow_chunk_id"]))
            if not bh or bh["relevant"] is None or ch["relevant"] is None:
                continue
            compared_hits += 1
            if int(bh["relevant"]) == int(ch["relevant"]):
                agreed_hits += 1
            elif len(disagreed_samples) < 10:
                disagreed_samples.append({
                    "tc_code": tc_code_map.get(ch["testcase_id"], f"TC#{ch['testcase_id']}"),
                    "doc_name": ch["doc_name"] or bh["doc_name"] or "",
                    "ragflow_chunk_id": ch["ragflow_chunk_id"],
                    "baseline_relevant": int(bh["relevant"]),
                    "candidate_relevant": int(ch["relevant"]),
                    "baseline_reason": bh["reason"] or "",
                    "candidate_reason": ch["reason"] or "",
                })

        b_meta = dict(b_rr)
        c_meta = dict(c_rr)
        b_cnt = len(b_hits)
        c_cnt = len(c_hits)
        performance = {
            "baseline": {
                "judge_engine": b_meta.get("judge_engine") or "llm",
                "judge_duration_ms": int(b_meta.get("judge_duration_ms") or 0),
                "judge_call_count": int(b_meta.get("judge_call_count") or 0),
                "judge_error_count": int(b_meta.get("judge_error_count") or 0),
                "total_hits": b_cnt,
                "ms_per_hit": round(int(b_meta.get("judge_duration_ms") or 0) / b_cnt, 1) if b_cnt and b_meta.get("judge_duration_ms") else None,
            },
            "candidate": {
                "judge_engine": c_meta.get("judge_engine") or "llm",
                "judge_duration_ms": int(c_meta.get("judge_duration_ms") or 0),
                "judge_call_count": int(c_meta.get("judge_call_count") or 0),
                "judge_error_count": int(c_meta.get("judge_error_count") or 0),
                "total_hits": c_cnt,
                "ms_per_hit": round(int(c_meta.get("judge_duration_ms") or 0) / c_cnt, 1) if c_cnt and c_meta.get("judge_duration_ms") else None,
            },
            "compared_hits": compared_hits,
            "agreed_hits": agreed_hits,
            "hit_agreement_rate": round(agreed_hits / compared_hits, 4) if compared_hits else None,
            "disagreed_samples": disagreed_samples,
        }

    return {
        "baseline": {"meta": b_meta, "summary": b_sum},
        "candidate": {"meta": c_meta, "summary": c_sum},
        "regressions_pass_to_fail": regressions,
        "improvements_fail_to_pass": improvements,
        "performance": performance,
    }


@router.get("/runs-matrix")
def get_runs_comparison_matrix():
    """
    Returns a unified 3-layer comparison table (Parsing + Chunking + Retrieval) across all runs
    for the current account, enabling Week 5-6 Baseline vs >=4 Experiments comparison in one view.
    """
    acct = get_current_account_key()
    with get_db() as conn:
        runs = conn.execute(
            "SELECT * FROM runs WHERE account_key = ? OR account_key = '' ORDER BY is_baseline DESC, id ASC",
            (acct,),
        ).fetchall()

        matrix = []
        for run in runs:
            rid = run["id"]
            p_rows = conn.execute("SELECT * FROM parsing_units WHERE run_id = ?", (rid,)).fetchall()
            pm = compute_parsing_metrics(p_rows)

            c_rows = conn.execute(
                """
                SELECT ce.*, c.document_id
                FROM chunk_evaluations ce
                JOIN chunks c ON c.id = ce.chunk_id
                WHERE ce.run_id = ? AND ce.is_sampled = 1
                """,
                (rid,),
            ).fetchall()
            doc_totals = {
                r["document_id"]: r["cnt"]
                for r in conn.execute(
                    "SELECT document_id, COUNT(*) AS cnt FROM chunks WHERE run_id = ? GROUP BY document_id",
                    (rid,),
                ).fetchall()
            }
            cm = compute_weighted_chunking_rates(c_rows, doc_totals) if c_rows else None

            rr = conn.execute(
                "SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1", (rid,)
            ).fetchone()
            ret = _compute_retrieval_summary(conn, rr["id"]) if rr else None

            try:
                pc = json.loads(run["parser_config"] or "{}")
            except Exception:
                pc = {}
            try:
                rc = json.loads(run["retrieval_config"] or "{}")
            except Exception:
                rc = {}

            chunk_token_size = pc.get("chunk_token_num")
            overlap = pc.get("overlapped_percent")
            for k, v in pc.items():
                if isinstance(v, dict) and k.startswith("GeneralChunker:"):
                    chunk_token_size = v.get("chunk_token_size", chunk_token_size)
                    overlap = v.get("overlapped_percent", overlap)

            ac_full_rate = None
            if ret and ret["total_testcases"] > 0:
                ac_full_rate = round(ret["answer_containment"].get("FULL", 0) / ret["total_testcases"], 4)

            matrix.append({
                "run_id": rid,
                "name": run["name"],
                "is_baseline": bool(run["is_baseline"]),
                "config": {
                    "chunk_method": pc.get("chunk_method") or "general",
                    "chunk_token_size": chunk_token_size or 512,
                    "overlap": overlap or 0,
                    "vector_weight": rc.get("vector_similarity_weight", 0.3),
                    "rerank": bool(rc.get("rerank_id")),
                    "top_k": rc.get("top_k", 10),
                },
                "parsing": {
                    "rated": pm["rated_units"],
                    "text_completeness": pm["text_completeness"] if pm["rated_units"] > 0 else None,
                    "table_accuracy": pm["table_accuracy"] if pm["table_total"] > 0 else None,
                    "character_error_rate": pm["character_error_rate"] if pm["rated_units"] > 0 else None,
                },
                "chunking": {
                    "sampled": len(c_rows),
                    "chunk_integrity": cm["chunk_integrity"] if cm else None,
                    "context_sufficiency": cm["context_sufficiency"] if cm else None,
                    "noise_rate": cm["noise_rate"] if cm else None,
                    "duplicate_rate": cm["duplicate_rate"] if cm else None,
                    "size_compliance": cm["valid_size_rate"] if cm else None,
                },
                "retrieval": {
                    "run_name": rr["name"] if rr else None,
                    "answer_containment_full": ac_full_rate,
                    "context_coverage": ret["avg_context_coverage"] if ret else None,
                    "contextual_precision": ret["avg_contextual_precision"] if ret else None,
                },
            })

    return {"runs": matrix}


@router.get("/runs/{run_id}/bug-report")
def get_run_bug_report(run_id: int, top_n: int = 5):
    """
    Aggregates the Top N most impactful bugs across Parsing, Chunking, and Retrieval for Week 6
    Test Report & Bug Report deliverables, plus a ready-to-copy Markdown summary.
    """
    p_cat = {x["code"]: x for x in PARSING_ERROR_CATALOG}
    c_cat = {x["code"]: x for x in CHUNKING_ERROR_CATALOG}
    p_cat.update({
        "TEXT": {"group": "Mất nội dung / Lỗi ký tự", "name": "Thiếu hoặc sai văn bản khi parse", "severity": "Nghiêm trọng"},
        "TABLE": {"group": "Vỡ bảng", "name": "Vỡ cấu trúc bảng (hàng/cột/ô gộp)", "severity": "Nghiêm trọng"},
        "ORDER": {"group": "Sai thứ tự", "name": "Đảo thứ tự đọc / trộn cột", "severity": "Nghiêm trọng"},
        "LAYOUT": {"group": "Mất cấu trúc", "name": "Mất heading, danh sách hoặc ảnh/sơ đồ", "severity": "Trung bình"},
    })

    buckets = {}

    def _add_bug(layer: str, code: str, group: str, title: str, severity: str, sample: str, fix: str):
        key = (layer, code)
        b = buckets.setdefault(key, {
            "layer": layer,
            "error_code": code,
            "error_group": group,
            "title": title,
            "severity": severity,
            "count": 0,
            "samples": [],
            "suggested_fix": fix,
        })
        b["count"] += 1
        if sample and len(b["samples"]) < 4 and sample not in b["samples"]:
            b["samples"].append(sample)

    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")

        p_rows = conn.execute(
            """
            SELECT pu.*, d.doc_code, d.filename
            FROM parsing_units pu
            JOIN documents d ON d.id = pu.document_id
            WHERE pu.run_id = ? AND pu.verdict IN ('FAIL', 'PARTIAL')
            """,
            (run_id,),
        ).fetchall()
        for u in p_rows:
            try:
                codes = json.loads(u["error_codes"] or "[]")
            except Exception:
                codes = []
            if not codes:
                codes = ["TABLE" if u["unit_type"] == "table" else "TEXT"]
            for code in codes:
                meta = p_cat.get(code, {"group": "Lỗi Parsing", "name": code, "severity": "Trung bình"})
                fix = (
                    "Bật DeepDOC + tăng Table Context Size hoặc dùng chunk_method='table'."
                    if code in ("TABLE", "P9", "P10")
                    else "Bật Vision Enhancement / OCR chất lượng cao (MinerU/VLM) cho file scan."
                    if code in ("TEXT", "P1", "P2", "P4", "P5", "P6")
                    else "Dùng layout-aware parser (DeepDOC) để giữ đúng thứ tự đọc & heading."
                )
                _add_bug(
                    "PARSING", code, meta["group"], meta["name"],
                    u["severity"] or meta["severity"],
                    f"{u['doc_code']} (trang {u['page_num']}): {(u['title'] or u['source_text'] or '')[:70]}",
                    fix,
                )

        c_rows = conn.execute(
            """
            SELECT ce.*, c.chunk_index, d.doc_code
            FROM chunk_evaluations ce
            JOIN chunks c ON c.id = ce.chunk_id
            LEFT JOIN documents d ON d.id = c.document_id
            WHERE ce.run_id = ? AND ce.is_sampled = 1
            """,
            (run_id,),
        ).fetchall()
        for ev in c_rows:
            try:
                codes = json.loads(ev["error_codes"] or "[]")
            except Exception:
                codes = []
            if not codes:
                if ev["integrity"] == 0:
                    codes.append("INTEGRITY")
                if ev["context_sufficiency"] == 0:
                    codes.append("CONTEXT")
                if ev["no_noise"] == 0:
                    codes.append("NOISE")
                if ev["no_duplicate"] == 0:
                    codes.append("DUPLICATE")
                if ev["valid_size"] == 0:
                    codes.append("SIZE")
            for code in codes:
                meta = c_cat.get(code, {"group": "Lỗi Chunking", "name": code, "severity": "Trung bình"})
                fix = (
                    "Tăng chunk_token_size (512→768/1024), thêm overlap 10-15% hoặc bật Parent-Child / gắn heading vào đầu chunk."
                    if code in ("INTEGRITY", "CONTEXT", "C1", "C2", "C3")
                    else "Lọc boilerplate HTML (nav/footer/form), header/footer lặp lại và bỏ chunk rác < 30 ký tự."
                    if code in ("NOISE", "C4", "C5")
                    else "Chuyển Excel/bảng sang template 'Table' và giảm overlapped_percent để tránh lặp nội dung."
                    if code in ("DUPLICATE", "C6", "C7")
                    else "Chuẩn hóa lại chunk_token_size (min/max) và gộp các đoạn quá ngắn."
                )
                _add_bug(
                    "CHUNKING", code, meta["group"], meta["name"], meta["severity"],
                    f"{ev['doc_code'] or 'DOC'}#chunk-{ev['chunk_index']}: {(ev['notes'] or meta['name'])[:70]}",
                    fix,
                )

        rr = conn.execute(
            "SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1", (run_id,)
        ).fetchone()
        if rr:
            ret_sum = _compute_retrieval_summary(conn, rr["id"])
            for code_tc, item in ret_sum["per_testcase"].items():
                if not item["passed"]:
                    rc_layer = item["root_cause_layer"] or "RETRIEVAL"
                    _add_bug(
                        "RETRIEVAL", rc_layer, f"Retrieval Fail ({rc_layer})",
                        f"Truy xuất thất bại (CP < 0.5) · nguyên nhân {rc_layer}",
                        "Nghiêm trọng",
                        f"{code_tc} [{item['question_class']}]: {item['question'][:70]}",
                        "Điều chỉnh tỷ trọng vector/keyword, bật Rerank hoặc tăng Top-K / giảm similarity_threshold.",
                    )

    sev_rank = {"Nghiêm trọng": 0, "Trung bình": 1, "Nhẹ": 2}
    ranked = sorted(buckets.values(), key=lambda x: (sev_rank.get(x["severity"], 1), -x["count"]))[:top_n]
    bugs = []
    md_lines = [
        f"# Test Report & Top {len(ranked)} Bug Reports — {run['name']}",
        "",
        "| Bug ID | Tầng phát sinh | Mã lỗi | Nhóm lỗi | Mức độ | Số lần gặp | Đề xuất khắc phục |",
        "|---|---|---|---|---|---:|---|",
    ]
    for idx, b in enumerate(ranked, start=1):
        bug_id = f"BUG-{idx:02d}"
        entry = {"bug_id": bug_id, **b}
        bugs.append(entry)
        md_lines.append(
            f"| {bug_id} | {b['layer']} | {b['error_code']} | {b['error_group']} | {b['severity']} | {b['count']} | {b['suggested_fix']} |"
        )
    md_lines.append("")
    for b in bugs:
        md_lines.append(f"### {b['bug_id']}: [{b['layer']}] {b['title']} ({b['severity']}, {b['count']} trường hợp)")
        for s in b["samples"]:
            md_lines.append(f"- Bằng chứng: {s}")
        md_lines.append(f"- Khuyến nghị: {b['suggested_fix']}")
        md_lines.append("")

    return {
        "run_id": run_id,
        "run_name": run["name"],
        "bugs": bugs,
        "markdown_report": "\n".join(md_lines),
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


class CompareAutopsyRequest(BaseModel):
    baseline_rr_id: int
    candidate_rr_id: int
    force_refresh: bool = False


@router.post("/compare/autopsy")
async def compare_regression_autopsy(payload: CompareAutopsyRequest):
    try:
        return await run_compare_regression_autopsy(
            baseline_rr_id=payload.baseline_rr_id,
            candidate_rr_id=payload.candidate_rr_id,
            force_refresh=payload.force_refresh,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi giải phẫu Regression: {e}")


@router.post("/seed-canonical")
def seed_canonical_endpoint():
    """Seeds the full canonical HIV_Chuan dataset (20 docs, 695 chunks, 110 testcases, Baseline & TN2 runs)."""
    try:
        from canonical_seeder import seed_full_canonical_dataset
        return seed_full_canonical_dataset()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi nạp dữ liệu chuẩn: {e}")

