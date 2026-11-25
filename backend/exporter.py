import io
import json
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.comments import Comment
from database import get_db
from metrics import compute_contextual_precision, compute_parsing_metrics


def _style_header(ws, headers, row_idx=1):
    for col_idx, text in enumerate(headers, start=1):
        cell = ws.cell(row=row_idx, column=col_idx, value=text)
        cell.fill = PatternFill(start_color="18181B", end_color="18181B", fill_type="solid")
        cell.font = Font(color="FFFFFF", bold=True, size=10)
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    if row_idx == 1:
        ws.freeze_panes = "A2"


def _pct(val):
    if val is None:
        return "N/A"
    return f"{round(float(val) * 100, 1)}%"


def export_run_workbook(run_id: int) -> bytes:
    wb = Workbook()

    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise ValueError("Run not found")

        # 1. Overview / Config
        ws_cfg = wb.active
        ws_cfg.title = "Config_Run"
        _style_header(ws_cfg, ["Field", "Value"])
        ws_cfg.append(["Run Name", run["name"]])
        ws_cfg.append(["Is Baseline", "Yes" if run["is_baseline"] else "No"])
        ws_cfg.append(["RAGFlow Dataset ID", run["ragflow_dataset_id"]])
        ws_cfg.append(["RAGFlow Dataset Name", run["ragflow_dataset_name"]])
        ws_cfg.append(["Parser Config", run["parser_config"]])
        ws_cfg.append(["Retrieval Config", run["retrieval_config"]])
        ws_cfg.append(["Created At", run["created_at"]])

        # 2. Documents
        ws_docs = wb.create_sheet("Danh_muc_Tai_lieu")
        _style_header(
            ws_docs,
            [
                "Doc Code", "Filename", "Format Group", "Pages",
                "Parse Status", "Chunks", "Tokens", "Duration (s)", "Anomalies", "Source URL"
            ],
        )
        docs = conn.execute(
            """
            SELECT d.*, rd.parse_status, rd.chunk_count, rd.token_count, rd.parse_duration_sec, rd.anomaly_flags
            FROM documents d
            LEFT JOIN run_documents rd ON rd.document_id = d.id AND rd.run_id = ?
            ORDER BY d.doc_code
            """,
            (run_id,),
        ).fetchall()
        for d in docs:
            ws_docs.append([
                d["doc_code"], d["filename"], d["format_group"], d["page_count"],
                d["parse_status"] or "UNSTART", d["chunk_count"] or 0, d["token_count"] or 0,
                round(d["parse_duration_sec"] or 0, 2), d["anomaly_flags"] or "[]", d["source_url"],
            ])

        # 3. Parsing Summary (by Document + by Format Group + Overall) & Detail
        units = conn.execute(
            """
            SELECT pu.*, d.doc_code, d.filename, d.format_group
            FROM parsing_units pu
            JOIN documents d ON d.id = pu.document_id
            WHERE pu.run_id = ?
            ORDER BY d.doc_code, pu.unit_index
            """,
            (run_id,),
        ).fetchall()

        # 3a. Per-document Parsing Summary (matches Excel View 1-for-1)
        ws_p_doc = wb.create_sheet("Tong_hop_Diem_Parsing")
        _style_header(
            ws_p_doc,
            [
                "Mã", "Tên tài liệu", "Nhóm định dạng",
                "Text Đạt/Tổng", "Text %",
                "Bảng Đạt/Tổng", "Table %",
                "Lỗi KT", "CER %",
                "Hình Đạt/Tổng", "Layout %",
                "Sai TT", "ROA %",
                "Fidelity %", "Parsing Score",
            ],
        )
        by_doc_p = {}
        for u in units:
            by_doc_p.setdefault(u["doc_code"], []).append(u)
        for dcode, grp_rows in sorted(by_doc_p.items()):
            pm = compute_parsing_metrics(grp_rows)
            text_u = [r for r in grp_rows if r["unit_type"] not in ("table", "image", "diagram")]
            text_pass = sum(1 for r in text_u if r["verdict"] == "PASS")
            tbl_u = [r for r in grp_rows if r["unit_type"] == "table"]
            tbl_pass = sum(1 for r in tbl_u if r["verdict"] == "PASS")
            img_u = [r for r in grp_rows if r["unit_type"] in ("image", "diagram")]
            img_pass = sum(1 for r in img_u if r["verdict"] == "PASS")
            char_err_cnt = sum(
                1 for r in grp_rows
                if r["char_error"] == 1 or any(c in ("P4", "P5", "P6") for c in json.loads(r["error_codes"] or "[]"))
            )
            order_err_cnt = sum(
                1 for r in grp_rows
                if any(c in ("P3", "ORDER") for c in json.loads(r["error_codes"] or "[]"))
            )
            ws_p_doc.append([
                dcode,
                grp_rows[0]["filename"] or "",
                grp_rows[0]["format_group"] or "",
                f"{text_pass}/{len(text_u)}" if text_u else "—",
                _pct(pm["text_completeness"]),
                f"{tbl_pass}/{len(tbl_u)}" if tbl_u else "—",
                _pct(pm["table_accuracy"]) if pm["table_total"] > 0 else "—",
                char_err_cnt,
                _pct(pm["character_error_rate"]),
                f"{img_pass}/{len(img_u)}" if img_u else "—",
                _pct(pm["layout_accuracy"]),
                order_err_cnt,
                _pct(pm["reading_order_accuracy"]),
                _pct(pm["content_fidelity"]),
                _pct(pm["parsing_score"]),
            ])
        pm_all = compute_parsing_metrics(units)
        all_text_u = [r for r in units if r["unit_type"] not in ("table", "image", "diagram")]
        all_tbl_u = [r for r in units if r["unit_type"] == "table"]
        all_img_u = [r for r in units if r["unit_type"] in ("image", "diagram")]
        ws_p_doc.append([
            "TỔNG",
            f"{len(by_doc_p)} tài liệu ({len(units)} đoạn)",
            "Toàn bộ",
            f"{sum(1 for r in all_text_u if r['verdict'] == 'PASS')}/{len(all_text_u)}",
            _pct(pm_all["text_completeness"]),
            f"{sum(1 for r in all_tbl_u if r['verdict'] == 'PASS')}/{len(all_tbl_u)}",
            _pct(pm_all["table_accuracy"]) if pm_all["table_total"] > 0 else "—",
            sum(1 for r in units if r["char_error"] == 1 or any(c in ("P4", "P5", "P6") for c in json.loads(r["error_codes"] or "[]"))),
            _pct(pm_all["character_error_rate"]),
            f"{sum(1 for r in all_img_u if r['verdict'] == 'PASS')}/{len(all_img_u)}" if all_img_u else "—",
            _pct(pm_all["layout_accuracy"]),
            sum(1 for r in units if any(c in ("P3", "ORDER") for c in json.loads(r["error_codes"] or "[]"))),
            _pct(pm_all["reading_order_accuracy"]),
            _pct(pm_all["content_fidelity"]),
            _pct(pm_all["parsing_score"]),
        ])

        ws_p_sum = wb.create_sheet("Thong_ke_Parsing")
        _style_header(
            ws_p_sum,
            [
                "Nhóm định dạng", "Tổng đoạn", "Đã chấm",
                "Text Completeness", "Content Fidelity", "Table Accuracy", "Character Error",
                "Layout Accuracy", "Reading Order", "Parsing Score",
            ],
        )
        by_fmt_p = {}
        for u in units:
            fmt = u["format_group"] or "Khác"
            by_fmt_p.setdefault(fmt, []).append(u)
        for fmt, grp_rows in sorted(by_fmt_p.items()):
            pm = compute_parsing_metrics(grp_rows)
            ws_p_sum.append([
                fmt, pm["total_units"], pm["rated_units"],
                _pct(pm["text_completeness"]),
                _pct(pm["content_fidelity"]),
                _pct(pm["table_accuracy"]) if pm["table_total"] > 0 else "N/A",
                _pct(pm["character_error_rate"]),
                _pct(pm["layout_accuracy"]),
                _pct(pm["reading_order_accuracy"]),
                _pct(pm["parsing_score"]),
            ])
        ws_p_sum.append([
            "TOÀN BỘ DATASET", pm_all["total_units"], pm_all["rated_units"],
            _pct(pm_all["text_completeness"]),
            _pct(pm_all["content_fidelity"]),
            _pct(pm_all["table_accuracy"]) if pm_all["table_total"] > 0 else "N/A",
            _pct(pm_all["character_error_rate"]),
            _pct(pm_all["layout_accuracy"]),
            _pct(pm_all["reading_order_accuracy"]),
            _pct(pm_all["parsing_score"]),
        ])

        ws_parse = wb.create_sheet("Cham_Parsing_Detail")
        _style_header(
            ws_parse,
            [
                "Doc Code", "Format Group", "Unit #", "Type", "Page", "Title", "Source Preview",
                "Matched Chunks", "Match Score", "Verdict", "Error Codes", "Char Error", "Fidelity Error", "Severity", "Notes"
            ],
        )
        for u in units:
            fid_err = u["fidelity_error"] if "fidelity_error" in u.keys() else 0
            ws_parse.append([
                u["doc_code"], u["format_group"], u["unit_index"], u["unit_type"], u["page_num"], u["title"],
                (u["source_text"] or "")[:200], u["matched_chunk_ids"], u["match_score"],
                u["verdict"], u["error_codes"], u["char_error"], fid_err, u["severity"], u["notes"],
            ])

        # 4. Chunking Summary (by Document + by Format Group + Overall) & Detail
        from metrics import compute_weighted_chunking_rates

        cevals = conn.execute(
            """
            SELECT ce.*, c.document_id, c.chunk_index, c.ragflow_chunk_id, c.char_count, c.rule_flags, c.content,
                   d.doc_code, d.filename, d.format_group
            FROM chunk_evaluations ce
            JOIN chunks c ON c.id = ce.chunk_id
            LEFT JOIN documents d ON d.id = c.document_id
            WHERE ce.run_id = ? AND ce.is_sampled = 1
            ORDER BY d.doc_code, c.chunk_index
            """,
            (run_id,),
        ).fetchall()
        c_doc_totals = {
            r["document_id"]: r["cnt"]
            for r in conn.execute(
                "SELECT document_id, COUNT(*) AS cnt FROM chunks WHERE run_id = ? GROUP BY document_id",
                (run_id,),
            ).fetchall()
        }

        def _chunk_rates(rows_in):
            cm = compute_weighted_chunking_rates(rows_in, c_doc_totals)
            return (
                len(rows_in),
                _pct(cm["chunk_integrity"]),
                _pct(cm["context_sufficiency"]),
                _pct(cm["noise_rate"]),
                _pct(cm["duplicate_rate"]),
                _pct(cm["valid_size_rate"]),
            )

        # 4a. Per-document Chunking Summary (matches ChunkingTableView 1-for-1)
        ws_c_doc = wb.create_sheet("Tong_hop_Diem_Chunking")
        _style_header(
            ws_c_doc,
            [
                "Mã", "Tên tài liệu", "Nhóm định dạng", "Số mẫu",
                "Trọn ý %", "Đủ nghĩa %", "Nhiễu % ↓", "Trùng % ↓", "Độ dài %", "Đạt 5/5", "Chunk Score",
            ],
        )
        by_doc_c = {}
        for ev in cevals:
            dcode = ev["doc_code"] or "DOC"
            by_doc_c.setdefault(dcode, []).append(ev)

        def _chunk_doc_row(label, fname, fmt, rows_in):
            n = len(rows_in)
            if not n:
                return [label, fname, fmt, 0, "—", "—", "—", "—", "—", "0/0", "—"]
            integ = sum(1 for x in rows_in if x["integrity"] == 1) / n
            ctx = sum(1 for x in rows_in if x["context_sufficiency"] == 1) / n
            noise = sum(1 for x in rows_in if x["no_noise"] == 0) / n
            dup = sum(1 for x in rows_in if x["no_duplicate"] == 0) / n
            sz = sum(1 for x in rows_in if x["valid_size"] == 1) / n
            ok5 = sum(
                1 for x in rows_in
                if x["integrity"] == 1 and x["context_sufficiency"] == 1
                and x["no_noise"] == 1 and x["no_duplicate"] == 1 and x["valid_size"] == 1
            )
            score = (integ + ctx + (1 - noise) + (1 - dup) + sz) / 5.0
            return [
                label, fname, fmt, n,
                _pct(integ), _pct(ctx), _pct(noise), _pct(dup), _pct(sz),
                f"{ok5}/{n}", _pct(score),
            ]

        for dcode, grp_rows in sorted(by_doc_c.items()):
            ws_c_doc.append(_chunk_doc_row(dcode, grp_rows[0]["filename"] or "", grp_rows[0]["format_group"] or "", grp_rows))
        ws_c_doc.append(_chunk_doc_row("TỔNG", f"{len(by_doc_c)} tài liệu ({len(cevals)} mẫu)", "Toàn bộ", cevals))

        ws_c_sum = wb.create_sheet("Thong_ke_Chunking")
        _style_header(
            ws_c_sum,
            [
                "Nhóm định dạng", "Số chunk chấm",
                "Chunk Integrity", "Context Sufficiency", "Noise Rate", "Duplicate Rate", "Size Compliance",
            ],
        )
        by_fmt_c = {}
        for ev in cevals:
            fmt = ev["format_group"] or "Khác"
            by_fmt_c.setdefault(fmt, []).append(ev)
        for fmt, grp_rows in sorted(by_fmt_c.items()):
            ws_c_sum.append([fmt, *_chunk_rates(grp_rows)])
        ws_c_sum.append(["TOÀN BỘ MẪU CHUNK", *_chunk_rates(cevals)])

        ws_chunk = wb.create_sheet("Cham_Chunking_Detail")
        _style_header(
            ws_chunk,
            [
                "Doc Code", "Format Group", "Chunk #", "Chunk ID", "Chars", "Rule Flags",
                "Integrity", "Context Suff.", "No Noise", "No Dup", "Valid Size",
                "Error Codes", "Judge", "Notes"
            ],
        )
        for idx_row, ev in enumerate(cevals, start=2):
            ws_chunk.append([
                ev["doc_code"] or "-", ev["format_group"] or "-", ev["chunk_index"], ev["ragflow_chunk_id"],
                ev["char_count"], ev["rule_flags"], ev["integrity"], ev["context_sufficiency"],
                ev["no_noise"], ev["no_duplicate"], ev["valid_size"], ev["error_codes"],
                ev["judge_source"], ev["notes"],
            ])
            cell = ws_chunk.cell(row=idx_row, column=4)
            cell.comment = Comment((ev["content"] or "")[:1800], "RAGFlow QC")

        # 5. Golden Testcases (exact 6 spec columns)
        tcs = conn.execute("SELECT * FROM golden_testcases ORDER BY tc_code").fetchall()
        ws_tc = wb.create_sheet("Golden_Testcases")
        _style_header(
            ws_tc,
            ["input", "expected_outcome", "reference_context", "source_file", "class", "intent_type"],
        )
        for tc in tcs:
            ws_tc.append([
                tc["input_question"],
                tc["expected_outcome"],
                tc["reference_context"],
                tc["source_file"],
                tc["question_class"],
                tc["intent_type"],
            ])

        # 6. Retrieval Detail & Summary (latest retrieval run for this run_id)
        rr = conn.execute(
            "SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1",
            (run_id,),
        ).fetchone()
        if rr:
            ws_ret = wb.create_sheet("Cham_Retrieval_Detail")
            _style_header(
                ws_ret,
                [
                    "TC Code", "Class", "Question", "Rank", "Chunk ID", "Doc Name",
                    "Similarity", "Vector Sim", "Term Sim", "Relevant", "Source", "Reason"
                ],
            )
            rrows = conn.execute(
                """
                SELECT res.*, gt.tc_code, gt.question_class, gt.input_question
                FROM retrieval_results res
                JOIN golden_testcases gt ON gt.id = res.testcase_id
                WHERE res.retrieval_run_id = ?
                ORDER BY gt.tc_code, res.rank
                """,
                (rr["id"],),
            ).fetchall()
            for idx_row, r in enumerate(rrows, start=2):
                ws_ret.append([
                    r["tc_code"], r["question_class"], r["input_question"], r["rank"],
                    r["ragflow_chunk_id"], r["doc_name"], round(r["similarity"], 4),
                    round(r["vector_similarity"], 4), round(r["term_similarity"], 4),
                    r["relevant"], r["relevancy_source"], r["reason"],
                ])
                cell = ws_ret.cell(row=idx_row, column=5)
                cell.comment = Comment((r["content"] or "")[:1800], "RAGFlow QC")

            # Summary sheet: Aggregated by question class + Per-testcase detail
            ws_sum = wb.create_sheet("Thong_ke_Retrieval")
            _style_header(
                ws_sum,
                [
                    "Loại câu hỏi", "Số câu", "Answer Containment (FULL)",
                    "Avg Context Coverage", "Avg Contextual Precision", "Pass Rate (CP>=0.5)",
                ],
            )
            tc_detail_rows = []
            by_cls = {}
            all_cp, all_cc, all_full, all_pass = [], [], 0, 0

            for tc in tcs:
                rels = [
                    r["relevant"]
                    for r in rrows
                    if r["testcase_id"] == tc["id"] and r["relevant"] is not None
                ]
                cp = compute_contextual_precision(rels)
                meta = conn.execute(
                    "SELECT * FROM testcase_eval_meta WHERE retrieval_run_id = ? AND testcase_id = ?",
                    (rr["id"], tc["id"]),
                ).fetchone()
                ac = meta["answer_containment"] if meta else "UNCHECKED"
                cc = float(meta["context_coverage"] or 0.0) if meta else 0.0
                passed = 1 if (cp >= 0.5 and any(v == 1 for v in rels)) else 0

                cls = tc["question_class"] or "Local"
                b = by_cls.setdefault(cls, {"n": 0, "full": 0, "cc": 0.0, "cp": 0.0, "pass": 0})
                b["n"] += 1
                if ac == "FULL":
                    b["full"] += 1
                    all_full += 1
                b["cc"] += cc
                b["cp"] += cp
                b["pass"] += passed
                all_cp.append(cp)
                all_cc.append(cc)
                all_pass += passed

                tc_detail_rows.append([
                    tc["tc_code"], cls, ac, round(cc, 4), round(cp, 4),
                    "PASS" if passed else "FAIL",
                    meta["root_cause_layer"] if meta else "",
                    meta["root_cause_notes"] if meta else "",
                ])

            row_cursor = 2
            for cls, b in sorted(by_cls.items()):
                n = max(b["n"], 1)
                ws_sum.append([
                    cls, b["n"], _pct(b["full"] / n),
                    _pct(b["cc"] / n), _pct(b["cp"] / n), _pct(b["pass"] / n),
                ])
                row_cursor += 1
            total_n = max(len(tcs), 1)
            ws_sum.append([
                "TOÀN BỘ DATASET", len(tcs), _pct(all_full / total_n),
                _pct(sum(all_cc) / total_n), _pct(sum(all_cp) / total_n), _pct(all_pass / total_n),
            ])
            row_cursor += 2

            _style_header(
                ws_sum,
                [
                    "TC Code", "Class", "Answer Containment", "Context Coverage",
                    "Contextual Precision", "Status", "Root Cause Layer", "Root Cause Notes",
                ],
                row_idx=row_cursor,
            )
            for detail_row in tc_detail_rows:
                ws_sum.append(detail_row)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
