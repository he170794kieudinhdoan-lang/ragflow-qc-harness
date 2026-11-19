import io
import json
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.comments import Comment
from database import get_db
from metrics import compute_contextual_precision


def _style_header(ws, headers):
    ws.append(headers)
    fill = PatternFill(start_color="18181B", end_color="18181B", fill_type="solid")
    font = Font(color="FFFFFF", bold=True, size=10)
    for col_idx in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.fill = fill
        cell.font = font
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.freeze_panes = "A2"


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

        # 3. Parsing Detail
        ws_parse = wb.create_sheet("Cham_Parsing")
        _style_header(
            ws_parse,
            [
                "Doc Code", "Unit #", "Type", "Page", "Title", "Source Preview",
                "Matched Chunks", "Match Score", "Verdict", "Error Codes", "Char Error", "Severity", "Notes"
            ],
        )
        units = conn.execute(
            """
            SELECT pu.*, d.doc_code
            FROM parsing_units pu
            JOIN documents d ON d.id = pu.document_id
            WHERE pu.run_id = ?
            ORDER BY d.doc_code, pu.unit_index
            """,
            (run_id,),
        ).fetchall()
        for u in units:
            ws_parse.append([
                u["doc_code"], u["unit_index"], u["unit_type"], u["page_num"], u["title"],
                (u["source_text"] or "")[:200], u["matched_chunk_ids"], u["match_score"],
                u["verdict"], u["error_codes"], u["char_error"], u["severity"], u["notes"],
            ])

        # 4. Chunking Detail
        ws_chunk = wb.create_sheet("Cham_Chunking")
        _style_header(
            ws_chunk,
            [
                "Doc Code", "Chunk #", "Chunk ID", "Chars", "Rule Flags",
                "Integrity", "Context Suff.", "No Noise", "No Dup", "Valid Size",
                "Error Codes", "Judge", "Notes"
            ],
        )
        cevals = conn.execute(
            """
            SELECT ce.*, c.chunk_index, c.ragflow_chunk_id, c.char_count, c.rule_flags, c.content, d.doc_code
            FROM chunk_evaluations ce
            JOIN chunks c ON c.id = ce.chunk_id
            LEFT JOIN documents d ON d.id = c.document_id
            WHERE ce.run_id = ? AND ce.is_sampled = 1
            ORDER BY d.doc_code, c.chunk_index
            """,
            (run_id,),
        ).fetchall()
        for idx_row, ev in enumerate(cevals, start=2):
            ws_chunk.append([
                ev["doc_code"] or "-", ev["chunk_index"], ev["ragflow_chunk_id"], ev["char_count"],
                ev["rule_flags"], ev["integrity"], ev["context_sufficiency"], ev["no_noise"],
                ev["no_duplicate"], ev["valid_size"], ev["error_codes"], ev["judge_source"], ev["notes"],
            ])
            # Hover note containing full chunk content!
            cell = ws_chunk.cell(row=idx_row, column=3)
            cell.comment = Comment((ev["content"] or "")[:1800], "RAGFlow QC")

        # 5. Retrieval Detail (latest retrieval run for this run_id)
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

            # Summary sheet per testcase
            ws_sum = wb.create_sheet("Thong_ke_Retrieval")
            _style_header(
                ws_sum,
                ["TC Code", "Class", "Answer Containment", "Context Coverage", "Contextual Precision", "Root Cause"],
            )
            tcs = conn.execute("SELECT * FROM golden_testcases ORDER BY tc_code").fetchall()
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
                ws_sum.append([
                    tc["tc_code"],
                    tc["question_class"],
                    meta["answer_containment"] if meta else "UNCHECKED",
                    meta["context_coverage"] if meta else 0.0,
                    cp,
                    meta["root_cause_layer"] if meta else "",
                ])

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
