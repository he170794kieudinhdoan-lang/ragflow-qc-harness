import json
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from database import get_current_account_key, get_db, get_float_setting, resolve_golden_run_id
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


def _extract_file_formats(source_file: str) -> list[str]:
    """Extract normalized uppercase format labels (PDF, DOCX, XLSX, PPTX, HTML, MD) from source_file."""
    parts = [p.strip() for p in (source_file or "").split(";") if p.strip()]
    fmts: list[str] = []
    for p in parts:
        dot = p.rfind(".")
        ext = p[dot + 1 :].upper() if dot != -1 else "KHÁC"
        if ext in ("HTM", "HTML"):
            ext = "HTML"
        elif ext in ("XLS", "XLSX", "CSV"):
            ext = "XLSX"
        elif ext in ("DOC", "DOCX"):
            ext = "DOCX"
        elif ext in ("PPT", "PPTX"):
            ext = "PPTX"
        elif ext not in ("PDF", "MD", "TXT"):
            ext = ext or "KHÁC"
        if ext not in fmts:
            fmts.append(ext)
    return fmts or ["KHÁC"]


def _compute_retrieval_summary(conn, retrieval_run_id: int):
    rr = conn.execute("SELECT run_id FROM retrieval_runs WHERE id = ?", (retrieval_run_id,)).fetchone()
    owner_id = resolve_golden_run_id(conn, rr["run_id"]) if rr else 0
    tcs = (
        conn.execute("SELECT * FROM golden_testcases WHERE run_id = ? ORDER BY tc_code", (owner_id,)).fetchall()
        if owner_id
        else []
    )
    if not tcs:
        tcs = conn.execute(
            """
            SELECT * FROM golden_testcases
            WHERE id IN (SELECT DISTINCT testcase_id FROM retrieval_results WHERE retrieval_run_id = ?)
            ORDER BY tc_code
            """,
            (retrieval_run_id,),
        ).fetchall()
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
    by_format = {}
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

        for fmt in _extract_file_formats(tc["source_file"]):
            fb = by_format.setdefault(fmt, {"count": 0, "cp_sum": 0.0, "cc_sum": 0.0, "pass": 0})
            fb["count"] += 1
            fb["cp_sum"] += cp
            fb["cc_sum"] += cc
            if passed:
                fb["pass"] += 1

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

    format_summary = {}
    for fmt, fb in sorted(by_format.items(), key=lambda kv: (-kv[1]["count"], kv[0])):
        n = max(fb["count"], 1)
        format_summary[fmt] = {
            "count": fb["count"],
            "avg_cp": round(fb["cp_sum"] / n, 4),
            "avg_cc": round(fb["cc_sum"] / n, 4),
            "pass_rate": round(fb["pass"] / n, 4),
        }

    return {
        "total_testcases": len(tcs),
        "avg_contextual_precision": round(sum(cp_list) / len(cp_list), 4) if cp_list else 0.0,
        "avg_context_coverage": round(sum(cc_list) / len(cc_list), 4) if cc_list else 0.0,
        "answer_containment": ac_counts,
        "by_class": class_summary,
        "by_format": format_summary,
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

        def _layer_snap(rid: int):
            r_row = conn.execute("SELECT id, name FROM runs WHERE id = ?", (rid,)).fetchone()
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
            dt = {
                r["document_id"]: r["cnt"]
                for r in conn.execute(
                    "SELECT document_id, COUNT(*) AS cnt FROM chunks WHERE run_id = ? GROUP BY document_id",
                    (rid,),
                ).fetchall()
            }
            cm = compute_weighted_chunking_rates(c_rows, dt) if c_rows else None
            return {
                "run_id": rid,
                "run_name": r_row["name"] if r_row else f"Run #{rid}",
                "parsing": {
                    "rated_units": pm["rated_units"],
                    "text_completeness": pm["text_completeness"] if pm["rated_units"] > 0 else None,
                    "table_accuracy": pm["table_accuracy"] if pm["table_total"] > 0 else None,
                    "reading_order_accuracy": pm["reading_order_accuracy"] if pm["rated_units"] > 0 else None,
                },
                "chunking": {
                    "sampled": len(c_rows),
                    "chunk_integrity": cm["chunk_integrity"] if cm else None,
                    "context_sufficiency": cm["context_sufficiency"] if cm else None,
                    "noise_rate": cm["noise_rate"] if cm else None,
                    "duplicate_rate": cm["duplicate_rate"] if cm else None,
                    "valid_size_rate": cm["valid_size_rate"] if cm else None,
                },
            }

        layers = {
            "same_run": b_rr["run_id"] == c_rr["run_id"],
            "baseline": _layer_snap(b_rr["run_id"]),
            "candidate": _layer_snap(c_rr["run_id"]),
        }

    return {
        "baseline": {"meta": b_meta, "summary": b_sum},
        "candidate": {"meta": c_meta, "summary": c_sum},
        "regressions_pass_to_fail": regressions,
        "improvements_fail_to_pass": improvements,
        "performance": performance,
        "layers": layers,
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


@router.get("/runs/{run_id}/retrieval-matrix")
def get_retrieval_experiment_matrix(run_id: int, retrieval_run_id: int | None = None):
    """
    Week 5 Multi-Retrieval-Experiment Matrix & Root Cause Breakdown for a single Ingestion Run.
    Places all Retrieval Runs (Baseline + vector/keyword/rerank/threshold experiments) side-by-side
    and summarizes failed testcase root causes with evidence + ready-to-copy Markdown report.
    """
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")
        rrs = conn.execute(
            "SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY id ASC",
            (run_id,),
        ).fetchall()

        rows = []
        summaries: dict[int, dict] = {}
        explicit_base = next((r for r in rrs if int(r["is_baseline_rr"] or 0) == 1), None)
        base_rr_id = explicit_base["id"] if explicit_base else (rrs[0]["id"] if rrs else None)
        for rr in rrs:
            summaries[rr["id"]] = _compute_retrieval_summary(conn, rr["id"])
        base_cp = summaries[base_rr_id]["avg_contextual_precision"] if base_rr_id in summaries else None

        for rr in rrs:
            s = summaries[rr["id"]]
            total_tc = s["total_testcases"]
            passed_cnt = sum(1 for tc in s["per_testcase"].values() if tc["passed"])
            failed_cnt = total_tc - passed_cnt
            cp = s["avg_contextual_precision"]
            ac_full_rate = round(s["answer_containment"].get("FULL", 0) / total_tc, 4) if total_tc else 0.0
            rows.append({
                "id": rr["id"],
                "name": rr["name"],
                "is_baseline_rr": rr["id"] == base_rr_id,
                "top_k": rr["top_k"],
                "similarity_threshold": rr["similarity_threshold"],
                "vector_similarity_weight": rr["vector_similarity_weight"],
                "rerank_id": rr["rerank_id"] or "",
                "keyword_enabled": bool(rr["keyword_enabled"]),
                "judge_engine": rr["judge_engine"] or "llm",
                "judge_duration_ms": int(rr["judge_duration_ms"] or 0),
                "total_testcases": total_tc,
                "pass_count": passed_cnt,
                "fail_count": failed_cnt,
                "pass_rate": round(passed_cnt / total_tc, 4) if total_tc else 0.0,
                "avg_contextual_precision": cp,
                "delta_cp_vs_first": round(cp - base_cp, 4) if base_cp is not None else 0.0,
                "avg_context_coverage": s["avg_context_coverage"],
                "ac_full_rate": ac_full_rate,
                "created_at": rr["created_at"],
            })

        # Root cause breakdown for selected retrieval_run_id (defaults to latest retrieval run)
        focus_rr = None
        if rrs:
            if retrieval_run_id is not None:
                focus_rr = next((r for r in rrs if r["id"] == retrieval_run_id), rrs[-1])
            else:
                focus_rr = rrs[-1]

        rc_buckets: dict[str, dict] = {}
        failed_total = 0
        if focus_rr:
            fs = summaries[focus_rr["id"]]
            for code, tc in fs["per_testcase"].items():
                if tc["passed"]:
                    continue
                failed_total += 1
                layer = (tc.get("root_cause_layer") or "").strip().upper()
                if not layer or layer == "NONE":
                    layer = "UNCLASSIFIED"
                b = rc_buckets.setdefault(layer, {"layer": layer, "count": 0, "samples": []})
                b["count"] += 1
                if len(b["samples"]) < 4:
                    note = (tc.get("root_cause_notes") or "").strip()
                    b["samples"].append({
                        "tc_code": code,
                        "source_file": tc.get("source_file") or "",
                        "cp": tc["cp"],
                        "ac": tc["ac"],
                        "note": note,
                    })

        root_causes = []
        for b in sorted(rc_buckets.values(), key=lambda x: (-x["count"], x["layer"])):
            root_causes.append({
                **b,
                "pct": round(b["count"] / failed_total, 4) if failed_total else 0.0,
            })

    # Build Markdown report (Week 5 deliverables)
    md = [
        f"# Báo cáo So sánh Cấu hình Retrieval & Root Cause — {run['name']}",
        "",
        "## 1. Bảng so sánh các cấu hình Retrieval (cùng bộ Golden Testcases)",
        "| Thử nghiệm | Top-K | Threshold | Vec Weight | Rerank | Judge | Pass | Coverage | Precision | Δ Precision |",
        "|---|---:|---:|---:|---|---|---:|---:|---:|---:|",
    ]
    for r in rows:
        d_txt = f"{r['delta_cp_vs_first'] * 100:+.1f}%"
        md.append(
            f"| {r['name']} | {r['top_k']} | {r['similarity_threshold']} | {r['vector_similarity_weight']} "
            f"| {r['rerank_id'] or 'Off'} | {r['judge_engine'].upper()} | {r['pass_count']}/{r['total_testcases']} ({r['pass_rate']*100:.0f}%) "
            f"| {r['avg_context_coverage']*100:.1f}% | **{r['avg_contextual_precision']*100:.1f}%** | {d_txt} |"
        )
    if focus_rr:
        md.extend([
            "",
            f"## 2. Phân bố Nguyên nhân gốc (Root Cause) các câu Fail — {focus_rr['name']} ({failed_total} câu fail)",
            "| Tầng / Nguyên nhân gốc | Số câu fail | Tỷ lệ | Ví dụ & Bằng chứng |",
            "|---|---:|---:|---|",
        ])
        for rc in root_causes:
            ex = "; ".join(
                f"{s['tc_code']} ({s['ac']}{': ' + s['note'] if s['note'] else ''})" for s in rc["samples"][:3]
            )
            md.append(f"| **{rc['layer']}** | {rc['count']} | {rc['pct']*100:.0f}% | {ex} |")

    return {
        "run_id": run_id,
        "run_name": run["name"],
        "experiments": rows,
        "focus_retrieval_run_id": focus_rr["id"] if focus_rr else None,
        "focus_retrieval_run_name": focus_rr["name"] if focus_rr else "",
        "failed_total": failed_total,
        "root_causes": root_causes,
        "markdown_report": "\n".join(md),
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


@router.post("/seed-canonical")
def seed_canonical_endpoint():
    """Seeds the full canonical HIV_Chuan dataset (20 docs, 695 chunks, 110 testcases, Baseline & TN2 runs)."""
    try:
        from canonical_seeder import seed_full_canonical_dataset
        return seed_full_canonical_dataset()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi nạp dữ liệu chuẩn: {e}")


def _pick_run_primary_rr(conn, run_id: int):
    rr = conn.execute(
        "SELECT * FROM retrieval_runs WHERE run_id = ? AND is_baseline_rr = 1 ORDER BY id DESC LIMIT 1",
        (run_id,),
    ).fetchone()
    if not rr:
        rr = conn.execute(
            "SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1",
            (run_id,),
        ).fetchone()
    return rr


@router.get("/runs/{run_id}/ai-advisor")
def get_cached_ai_advisor(run_id: int):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM ai_advisor_reports WHERE run_id = ?", (run_id,)).fetchone()
    if not row:
        return {"cached": False, "report": None}
    try:
        rep = json.loads(row["report_json"] or "{}")
    except Exception:
        rep = {}
    return {
        "cached": True,
        "run_id": run_id,
        "retrieval_run_id": row["retrieval_run_id"],
        "model_used": row["model_used"],
        "duration_ms": row["duration_ms"],
        "created_at": row["created_at"],
        "report": rep,
    }


@router.post("/runs/{run_id}/ai-advisor")
async def generate_ai_advisor(run_id: int):
    """
    Aggregates real 3-layer QC evidence (Parsing + Chunking + Retrieval + current RAGFlow config)
    for `run_id`, runs 1 structured LLM call, and returns actionable Baseline config changes
    plus a `patch_config` object that can be 1-click applied to a cloned experiment [B].
    """
    import asyncio
    import time
    from routers.parsing import get_parsing_metrics
    from routers.chunking import get_chunking_metrics
    from routers.workspace import get_run_parser_config
    from llm_client import call_llm_json, LLMError
    from database import get_bool_setting, get_int_setting, get_setting, utc_now

    # Demo Mode fast-path: realistic ~2s thinking delay -> return real cached AI report
    if get_bool_setting("demo_mode", False):
        await asyncio.sleep(2.0)
        demo_base_id = get_int_setting("demo_baseline_run_id", 21)
        with get_db() as conn:
            row = conn.execute("SELECT * FROM ai_advisor_reports WHERE run_id = ?", (run_id,)).fetchone()
            if not row:
                row = conn.execute("SELECT * FROM ai_advisor_reports WHERE run_id = ?", (demo_base_id,)).fetchone()
        if row:
            return {
                "cached": True,
                "run_id": run_id,
                "retrieval_run_id": row["retrieval_run_id"],
                "model_used": row["model_used"],
                "duration_ms": 2040,
                "created_at": row["created_at"],
                "report": json.loads(row["report_json"] or "{}"),
            }

    llm_url = get_setting("llm_base_url", "")
    llm_key = get_setting("llm_api_key", "")
    llm_model = get_setting("llm_model", "")
    if not llm_url or not llm_model:
        raise HTTPException(status_code=400, detail="Chưa cấu hình LLM (Base URL / Model) trong Cài đặt.")

    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")
        primary_rr = _pick_run_primary_rr(conn, run_id)
        ret_summary = _compute_retrieval_summary(conn, primary_rr["id"]) if primary_rr else None

        # Top failing parsing docs
        bad_parse_docs = conn.execute(
            """
            SELECT d.filename, COUNT(*) AS total_u,
                   SUM(CASE WHEN pu.verdict = 'FAIL' THEN 1 ELSE 0 END) AS fail_u,
                   SUM(CASE WHEN pu.verdict = 'PARTIAL' THEN 1 ELSE 0 END) AS partial_u
            FROM parsing_units pu
            JOIN documents d ON d.id = pu.document_id
            WHERE pu.run_id = ? AND pu.verdict IN ('PASS', 'PARTIAL', 'FAIL')
            GROUP BY d.id
            HAVING fail_u > 0 OR partial_u > 0
            ORDER BY fail_u DESC, partial_u DESC
            LIMIT 6
            """,
            (run_id,),
        ).fetchall()

        # Top chunking error codes
        chunk_err_rows = conn.execute(
            "SELECT error_codes FROM chunk_evaluations WHERE run_id = ? AND is_sampled = 1",
            (run_id,),
        ).fetchall()

    err_counts: Dict[str, int] = {}
    for cr in chunk_err_rows:
        try:
            codes = json.loads(cr["error_codes"] or "[]")
            for c in codes:
                err_counts[str(c)] = err_counts.get(str(c), 0) + 1
        except Exception:
            pass

    p_metrics = get_parsing_metrics(run_id)
    c_metrics = get_chunking_metrics(run_id)
    try:
        parser_cfg_info = await get_run_parser_config(run_id)
    except Exception:
        parser_cfg_info = {"parser_id": "general", "parser_config": {}, "embedding_model": "", "pagerank": 0}

    # Build compact evidence payload (~1.5K tokens)
    fail_samples = []
    ret_pass_count = 0
    ret_total = 0
    if ret_summary:
        per_tc_vals = list((ret_summary.get("per_testcase") or {}).values())
        ret_total = ret_summary.get("total_testcases", len(per_tc_vals))
        ret_pass_count = sum(1 for t in per_tc_vals if t.get("passed"))
        failed_tcs = [t for t in per_tc_vals if not t.get("passed")]
        failed_tcs.sort(key=lambda x: x.get("cp", 0.0))
        for ft in failed_tcs[:12]:
            fail_samples.append({
                "tc_code": ft["tc_code"],
                "class": ft["question_class"],
                "source_file": ft["source_file"],
                "cp": round(ft.get("cp", 0.0) * 100, 1),
                "ac": ft.get("ac", "UNCHECKED"),
                "root_cause": ft.get("root_cause_layer", ""),
                "note": (ft.get("root_cause_notes") or "")[:120],
                "q": (ft.get("question") or "")[:110],
            })

    evidence = {
        "run_name": run["name"],
        "current_config": {
            "parser_id": parser_cfg_info.get("parser_id", "general"),
            "pagerank": parser_cfg_info.get("pagerank", 0),
            "embedding_model": parser_cfg_info.get("embedding_model", ""),
            "parser_config": parser_cfg_info.get("parser_config", {}),
            "retrieval": {
                "top_k": primary_rr["top_k"] if primary_rr else 10,
                "similarity_threshold": primary_rr["similarity_threshold"] if primary_rr else 0.2,
                "vector_similarity_weight": primary_rr["vector_similarity_weight"] if primary_rr else 0.3,
                "rerank_id": primary_rr["rerank_id"] if primary_rr else "",
                "keyword_enabled": bool(primary_rr["keyword_enabled"]) if primary_rr else False,
            },
        },
        "parsing_metrics": {
            "rated_units": p_metrics.get("rated_units", 0),
            "text_completeness": round(p_metrics.get("text_completeness", 0) * 100, 1),
            "table_accuracy": round(p_metrics.get("table_accuracy", 0) * 100, 1),
            "reading_order_accuracy": round(p_metrics.get("reading_order_accuracy", 0) * 100, 1),
            "top_problem_docs": [dict(r) for r in bad_parse_docs],
        },
        "chunking_metrics": {
            "sampled_total": c_metrics.get("sampled_total", 0),
            "chunk_integrity": round(c_metrics.get("chunk_integrity", 0) * 100, 1),
            "context_sufficiency": round(c_metrics.get("context_sufficiency", 0) * 100, 1),
            "noise_rate": round(c_metrics.get("noise_rate", 0) * 100, 1),
            "valid_size_rate": round(c_metrics.get("valid_size_rate", 0) * 100, 1),
            "error_code_counts": err_counts,
        },
        "retrieval_metrics": {
            "total_testcases": ret_total,
            "avg_contextual_precision": round(ret_summary["avg_contextual_precision"] * 100, 1) if ret_summary else 0,
            "avg_context_coverage": round(ret_summary["avg_context_coverage"] * 100, 1) if ret_summary else 0,
            "pass_count": ret_pass_count,
            "pass_rate": round((ret_pass_count / max(ret_total, 1)) * 100, 1) if ret_total else 0,
            "by_class": ret_summary.get("by_class", {}) if ret_summary else {},
            "by_format": ret_summary.get("by_format", {}) if ret_summary else {},
            "top_failed_testcases": fail_samples,
        },
    }

    sys_prompt = (
        "Bạn là Kiến trúc sư tối ưu hệ thống RAG (RAGFlow) tiếng Việt. "
        "Nhiệm vụ: đọc bằng chứng kiểm thử 3 tầng (Parsing, Chunking, Retrieval) + cấu hình Baseline hiện tại, "
        "chỉ ra điểm nghẽn thực sự và đề xuất các thay đổi cấu hình CỤ THỂ, KHẢ THI trên RAGFlow để cải thiện chất lượng tổng thể.\n"
        "QUY TẮC:\n"
        "1. Chỉ đề xuất thay đổi có căn cứ từ số liệu thật (dẫn chứng số % hoặc mã TC cụ thể).\n"
        "2. Không bịa tham số ngoài RAGFlow. Chỉ dùng các khóa hợp lệ trong patch_config.\n"
        "3. Trả về DUY NHẤT JSON hợp lệ theo schema:\n"
        "{\n"
        '  "diagnosis": "Tóm tắt 2-3 câu về điểm nghẽn lớn nhất của Baseline hiện tại",\n'
        '  "bottleneck_layer": "PARSING | CHUNKING | RETRIEVAL | BALANCED",\n'
        '  "expected_gain": "Ước lượng ngắn gọn (VD: Precision +8–15%, giảm lỗi cắt bảng)",\n'
        '  "proposed_changes": [\n'
        "    {\n"
        '      "layer": "PARSING | CHUNKING | RETRIEVAL",\n'
        '      "priority": "high | medium | low",\n'
        '      "param_label": "Tên tham số dễ hiểu (VD: Chunk Token Size)",\n'
        '      "current_value": "Giá trị hiện tại",\n'
        '      "recommended_value": "Giá trị đề xuất",\n'
        '      "reason": "Giải thích ngắn gọn dựa trên bằng chứng thực tế",\n'
        '      "affected_tcs": ["TC02", "TC14"]\n'
        "    }\n"
        "  ],\n"
        '  "patch_config": {\n'
        '    "parser_id": "general|laws|manual|paper|book|table|qa|presentation|one (chỉ điền nếu cần đổi)",\n'
        '    "pdf_parse_method": "DeepDOC|Plain Text|MinerU (chỉ điền nếu cần đổi)",\n'
        '    "vision_enhance": true/false (tùy chọn),\n'
        '    "chunk_token_size": số nguyên 128..2048 (tùy chọn),\n'
        '    "overlapped_percent": số nguyên 0..30 (tùy chọn),\n'
        '    "table_context_size": số nguyên 0..512 (tùy chọn),\n'
        '    "use_parent_child": true/false (tùy chọn),\n'
        '    "top_k": số nguyên 5..20 (tùy chọn),\n'
        '    "similarity_threshold": số thực 0.05..0.5 (tùy chọn),\n'
        '    "vector_similarity_weight": số thực 0.1..0.9 (tùy chọn),\n'
        '    "enable_rerank": true/false (tùy chọn)\n'
        "  }\n"
        "}"
    )

    t0 = time.perf_counter()
    try:
        report = await call_llm_json(
            base_url=llm_url,
            api_key=llm_key,
            model=llm_model,
            system_prompt=sys_prompt,
            user_prompt=f"Bằng chứng 3 tầng của Baseline:\n{json.dumps(evidence, ensure_ascii=False)}",
            timeout=60.0,
        )
    except LLMError as e:
        raise HTTPException(status_code=502, detail=f"AI Advisor gọi LLM lỗi: {e}")

    duration_ms = int((time.perf_counter() - t0) * 1000)
    now = utc_now()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO ai_advisor_reports (run_id, retrieval_run_id, report_json, model_used, duration_ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                retrieval_run_id=excluded.retrieval_run_id,
                report_json=excluded.report_json,
                model_used=excluded.model_used,
                duration_ms=excluded.duration_ms,
                created_at=excluded.created_at
            """,
            (run_id, primary_rr["id"] if primary_rr else None, json.dumps(report, ensure_ascii=False), llm_model, duration_ms, now),
        )

    return {
        "cached": False,
        "run_id": run_id,
        "retrieval_run_id": primary_rr["id"] if primary_rr else None,
        "model_used": llm_model,
        "duration_ms": duration_ms,
        "created_at": now,
        "report": report,
    }


@router.get("/compare-runs")
def compare_two_runs_full(baseline_id: int, candidate_id: int):
    """Full 3-layer comparison between two Runs (Parsing + Chunking + Retrieval)."""
    from routers.parsing import get_parsing_metrics
    from routers.chunking import get_chunking_metrics

    with get_db() as conn:
        b_run = conn.execute("SELECT * FROM runs WHERE id = ?", (baseline_id,)).fetchone()
        c_run = conn.execute("SELECT * FROM runs WHERE id = ?", (candidate_id,)).fetchone()
        if not b_run or not c_run:
            raise HTTPException(status_code=404, detail="Một trong hai Run không tồn tại")
        b_rr = _pick_run_primary_rr(conn, baseline_id)
        c_rr = _pick_run_primary_rr(conn, candidate_id)
        b_ret = _compute_retrieval_summary(conn, b_rr["id"]) if b_rr else None
        c_ret = _compute_retrieval_summary(conn, c_rr["id"]) if c_rr else None
        b_chunk_cnt = conn.execute("SELECT COUNT(*) FROM chunks WHERE run_id = ?", (baseline_id,)).fetchone()[0]
        c_chunk_cnt = conn.execute("SELECT COUNT(*) FROM chunks WHERE run_id = ?", (candidate_id,)).fetchone()[0]
        b_doc_cnt = conn.execute("SELECT COUNT(*) FROM run_documents WHERE run_id = ?", (baseline_id,)).fetchone()[0]
        c_doc_cnt = conn.execute("SELECT COUNT(*) FROM run_documents WHERE run_id = ?", (candidate_id,)).fetchone()[0]

    bp = get_parsing_metrics(baseline_id)
    cp = get_parsing_metrics(candidate_id)
    bc = get_chunking_metrics(baseline_id)
    cc = get_chunking_metrics(candidate_id)

    tc_changes = []
    b_vals = list((b_ret.get("per_testcase") or {}).values()) if b_ret else []
    c_vals = list((c_ret.get("per_testcase") or {}).values()) if c_ret else []
    b_pass_cnt = sum(1 for t in b_vals if t.get("passed"))
    c_pass_cnt = sum(1 for t in c_vals if t.get("passed"))
    b_total = b_ret["total_testcases"] if b_ret else 0
    c_total = c_ret["total_testcases"] if c_ret else 0

    if b_ret and c_ret:
        b_map = {t["testcase_id"]: t for t in b_vals}
        c_map = {t["testcase_id"]: t for t in c_vals}
        for tid in sorted(set(b_map.keys()) | set(c_map.keys())):
            bt = b_map.get(tid)
            ct = c_map.get(tid)
            if not bt or not ct:
                continue
            b_pass = bool(bt.get("passed"))
            c_pass = bool(ct.get("passed"))
            b_cp = float(bt.get("cp", 0.0))
            c_cp = float(ct.get("cp", 0.0))
            status = "unchanged"
            if not b_pass and c_pass:
                status = "rescued"
            elif b_pass and not c_pass:
                status = "regressed"
            elif c_cp > b_cp + 0.01:
                status = "improved"
            elif c_cp < b_cp - 0.01:
                status = "worsened"
            tc_changes.append({
                "testcase_id": tid,
                "tc_code": bt["tc_code"],
                "question_class": bt["question_class"],
                "input_question": bt.get("question", ""),
                "baseline_cp": b_cp,
                "candidate_cp": c_cp,
                "delta_cp": round(c_cp - b_cp, 4),
                "baseline_passed": b_pass,
                "candidate_passed": c_pass,
                "status": status,
            })

    return {
        "baseline": {
            "id": b_run["id"],
            "name": b_run["name"],
            "ragflow_dataset_id": b_run["ragflow_dataset_id"],
            "doc_count": b_doc_cnt,
            "chunk_count": b_chunk_cnt,
            "parsing": bp,
            "chunking": bc,
            "retrieval": {
                "retrieval_run_id": b_rr["id"] if b_rr else None,
                "name": b_rr["name"] if b_rr else "",
                "top_k": b_rr["top_k"] if b_rr else 10,
                "similarity_threshold": b_rr["similarity_threshold"] if b_rr else 0.2,
                "vector_similarity_weight": b_rr["vector_similarity_weight"] if b_rr else 0.3,
                "rerank_id": b_rr["rerank_id"] if b_rr else "",
                "avg_contextual_precision": b_ret["avg_contextual_precision"] if b_ret else 0,
                "avg_context_coverage": b_ret["avg_context_coverage"] if b_ret else 0,
                "pass_rate": round(b_pass_cnt / max(b_total, 1), 4) if b_total else 0,
                "pass_count": b_pass_cnt,
                "total_testcases": b_total,
                "by_class": b_ret.get("by_class", {}) if b_ret else {},
                "by_format": b_ret.get("by_format", {}) if b_ret else {},
            },
        },
        "candidate": {
            "id": c_run["id"],
            "name": c_run["name"],
            "ragflow_dataset_id": c_run["ragflow_dataset_id"],
            "doc_count": c_doc_cnt,
            "chunk_count": c_chunk_cnt,
            "parsing": cp,
            "chunking": cc,
            "retrieval": {
                "retrieval_run_id": c_rr["id"] if c_rr else None,
                "name": c_rr["name"] if c_rr else "",
                "top_k": c_rr["top_k"] if c_rr else 10,
                "similarity_threshold": c_rr["similarity_threshold"] if c_rr else 0.2,
                "vector_similarity_weight": c_rr["vector_similarity_weight"] if c_rr else 0.3,
                "rerank_id": c_rr["rerank_id"] if c_rr else "",
                "avg_contextual_precision": c_ret["avg_contextual_precision"] if c_ret else 0,
                "avg_context_coverage": c_ret["avg_context_coverage"] if c_ret else 0,
                "pass_rate": round(c_pass_cnt / max(c_total, 1), 4) if c_total else 0,
                "pass_count": c_pass_cnt,
                "total_testcases": c_total,
                "by_class": c_ret.get("by_class", {}) if c_ret else {},
                "by_format": c_ret.get("by_format", {}) if c_ret else {},
            },
        },
        "deltas": {
            "parsing_text": round(cp.get("text_completeness", 0) - bp.get("text_completeness", 0), 4),
            "parsing_table": round(cp.get("table_accuracy", 0) - bp.get("table_accuracy", 0), 4),
            "chunking_integrity": round(cc.get("chunk_integrity", 0) - bc.get("chunk_integrity", 0), 4),
            "chunking_noise": round(cc.get("noise_rate", 0) - bc.get("noise_rate", 0), 4),
            "retrieval_precision": round(
                (c_ret["avg_contextual_precision"] if c_ret else 0) - (b_ret["avg_contextual_precision"] if b_ret else 0),
                4,
            ),
            "retrieval_coverage": round(
                (c_ret["avg_context_coverage"] if c_ret else 0) - (b_ret["avg_context_coverage"] if b_ret else 0),
                4,
            ),
        },
        "tc_changes": tc_changes,
    }


@router.post("/runs/{run_id}/promote-baseline")
def promote_run_as_baseline(run_id: int):
    from database import get_bool_setting
    if get_bool_setting("demo_mode", False):
        return {"ok": True, "baseline_run_id": run_id, "demo": True}
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")
        acct = run["account_key"] or ""
        conn.execute("UPDATE runs SET is_baseline = 0 WHERE account_key = ? OR account_key = ''", (acct,))
        conn.execute("UPDATE runs SET is_baseline = 1 WHERE id = ?", (run_id,))
    return {"ok": True, "baseline_run_id": run_id}


