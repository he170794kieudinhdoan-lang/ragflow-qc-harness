import os
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import database  # noqa: E402
import diagnostic_swarm  # noqa: E402
from routers import optimizer as optimizer_router  # noqa: E402


class TestDiagnosticSwarm(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.tmp_db = os.path.join(self.tmp_dir.name, "test_qc.db")
        self.orig_db_path = database.DB_PATH
        database.DB_PATH = self.tmp_db
        database.init_db()

        with database.get_db() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("llm_base_url", "http://localhost:11434/v1", "2026-01-01T00:00:00Z"),
            )
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("llm_model", "mock-model", "2026-01-01T00:00:00Z"),
            )
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("llm_api_key", "test-key", "2026-01-01T00:00:00Z"),
            )
            conn.execute(
                "INSERT INTO documents (id, doc_code, filename, format_group, has_tables, is_scan, created_at) "
                "VALUES (1, 'DOC01', 'huong_dan.pdf', 'PDF bảng biểu', 1, 0, '2026-01-01T00:00:00Z')"
            )
            conn.execute(
                "INSERT INTO runs (id, name, ragflow_dataset_id, parser_config, retrieval_config, status, created_at) "
                "VALUES (1, 'Baseline Run', 'ds_1', '{\"chunk_method\": \"general\", \"chunk_token_num\": 512}', "
                "'{\"top_k\": 10, \"similarity_threshold\": 0.2, \"vector_similarity_weight\": 0.3}', 'READY', '2026-01-01T00:00:00Z')"
            )
            conn.execute(
                "INSERT INTO run_documents (run_id, document_id, ragflow_doc_id, parse_status, chunk_count, updated_at) "
                "VALUES (1, 1, 'rdoc_1', 'DONE', 3, '2026-01-01T00:00:00Z')"
            )
            conn.execute(
                "INSERT INTO chunks (id, run_id, document_id, ragflow_doc_id, ragflow_chunk_id, chunk_index, content, char_count, token_est, page_num, rule_flags) "
                "VALUES (1, 1, 1, 'rdoc_1', 'chk_1', 0, 'Điều 5. Hướng dẫn dự phòng HIV bằng PrEP cho nhóm nguy cơ cao.', 66, 20, 1, '[\"BAD_BOUNDARY\"]')"
            )
            conn.execute(
                "INSERT INTO chunks (id, run_id, document_id, ragflow_doc_id, ragflow_chunk_id, chunk_index, content, char_count, token_est, page_num, rule_flags) "
                "VALUES (2, 1, 1, 'rdoc_1', 'chk_2', 1, 'Liều dùng TDF/FTC mỗi ngày 1 viên liên tục trong 28 ngày.', 58, 18, 1, '[\"BROKEN_TABLE\"]')"
            )
            conn.execute(
                "INSERT INTO chunks (id, run_id, document_id, ragflow_doc_id, ragflow_chunk_id, chunk_index, content, char_count, token_est, page_num, rule_flags) "
                "VALUES (3, 1, 1, 'rdoc_1', 'chk_3', 2, 'Tài liệu tham khảo chung về xét nghiệm định kỳ.', 48, 14, 2, '[]')"
            )
            conn.execute(
                "INSERT INTO parsing_units (id, run_id, document_id, unit_index, unit_type, page_num, title, source_text, matched_chunk_ids, match_score, verdict, error_codes, fidelity_error, updated_at) "
                "VALUES (1, 1, 1, 0, 'table', 1, 'Bảng liều dùng', 'Thuốc | Liều | TDF/FTC | 1 viên/ngày', '[\"chk_2\"]', 0.42, 'FAIL', '[\"TABLE\"]', 1, '2026-01-01T00:00:00Z')"
            )
            conn.execute(
                "INSERT INTO chunk_evaluations (run_id, chunk_id, is_sampled, integrity, context_sufficiency, no_noise, no_duplicate, valid_size, error_codes, judge_source, updated_at) "
                "VALUES (1, 2, 1, 0, 0, 1, 1, 1, '[\"INTEGRITY\", \"CONTEXT\"]', 'RULE', '2026-01-01T00:00:00Z')"
            )
            conn.execute(
                "INSERT INTO golden_testcases (id, run_id, tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, created_at) "
                "VALUES (1, 1, 'TC-01', 'Liều dùng PrEP TDF/FTC hàng ngày là bao nhiêu?', '1 viên mỗi ngày', 'Liều dùng TDF/FTC mỗi ngày 1 viên liên tục trong 28 ngày.', 'huong_dan.pdf', 'Local', 'Factoid', '2026-01-01T00:00:00Z')"
            )
            # Foreign run + foreign golden testcase to verify strict run_id isolation
            conn.execute(
                "INSERT INTO runs (id, name, ragflow_dataset_id, parser_config, retrieval_config, status, created_at) "
                "VALUES (2, 'Other Run', 'ds_other', '{}', '{}', 'READY', '2026-01-01T00:00:00Z')"
            )
            conn.execute(
                "INSERT INTO golden_testcases (id, run_id, tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, created_at) "
                "VALUES (2, 2, 'TC-FOREIGN', 'Câu hỏi của dataset khác?', 'Đáp án khác', 'Ngữ cảnh khác', 'other.pdf', 'Local', 'Factoid', '2026-01-01T00:00:00Z')"
            )
            conn.execute(
                "INSERT INTO retrieval_runs (id, run_id, name, top_k, similarity_threshold, vector_similarity_weight, rerank_id, keyword_enabled, created_at) "
                "VALUES (1, 1, 'RR Baseline', 10, 0.2, 0.3, '', 1, '2026-01-01T00:00:00Z')"
            )
            conn.execute(
                "INSERT INTO retrieval_runs (id, run_id, name, top_k, similarity_threshold, vector_similarity_weight, rerank_id, keyword_enabled, created_at) "
                "VALUES (2, 1, 'RR Candidate', 10, 0.35, 0.7, '', 0, '2026-01-01T00:00:00Z')"
            )
            # Baseline PASS (rank 1 relevant=1); Candidate FAIL (rank 1 relevant=0)
            conn.execute(
                "INSERT INTO retrieval_results (retrieval_run_id, testcase_id, rank, ragflow_chunk_id, doc_name, content, similarity, relevant, relevancy_source, reason) "
                "VALUES (1, 1, 1, 'chk_2', 'huong_dan.pdf', 'Liều dùng TDF/FTC mỗi ngày 1 viên liên tục trong 28 ngày.', 0.88, 1, 'MANUAL', 'Đúng')"
            )
            conn.execute(
                "INSERT INTO retrieval_results (retrieval_run_id, testcase_id, rank, ragflow_chunk_id, doc_name, content, similarity, relevant, relevancy_source, reason) "
                "VALUES (2, 1, 1, 'chk_3', 'huong_dan.pdf', 'Tài liệu tham khảo chung về xét nghiệm định kỳ.', 0.61, 0, 'MANUAL', 'Sai chunk')"
            )

    def tearDown(self):
        database.DB_PATH = self.orig_db_path
        self.tmp_dir.cleanup()

    def test_knob_whitelist_and_clamping(self):
        raw_idx = {
            "chunk_token_size": 99999,
            "overlapped_percent": -10,
            "use_parent_child": "true",
            "pdf_parse_method": "deepdoc",
            "hallucinated_knob": "drop table",
        }
        clean_idx = diagnostic_swarm.sanitize_patch(raw_idx, diagnostic_swarm.INDEX_KNOB_SPECS)
        self.assertEqual(clean_idx["chunk_token_size"], 2048)
        self.assertEqual(clean_idx["overlapped_percent"], 0)
        self.assertIs(clean_idx["use_parent_child"], True)
        self.assertEqual(clean_idx["pdf_parse_method"], "DeepDOC")
        self.assertNotIn("hallucinated_knob", clean_idx)

        raw_ret = {
            "top_k": 1,
            "similarity_threshold": 1.5,
            "vector_similarity_weight": 0.256,
            "use_kg": 1,
            "unknown_param": 123,
        }
        clean_ret = diagnostic_swarm.sanitize_patch(raw_ret, diagnostic_swarm.RETRIEVAL_KNOB_SPECS)
        self.assertEqual(clean_ret["top_k"], 3)
        self.assertEqual(clean_ret["similarity_threshold"], 0.9)
        self.assertEqual(clean_ret["vector_similarity_weight"], 0.26)
        self.assertIs(clean_ret["use_kg"], True)
        self.assertNotIn("unknown_param", clean_ret)

    async def test_swarm_diagnosis_and_sqlite_cache(self):
        async def fake_llm(base_url, api_key, model, sys_prompt, user_prompt, timeout=45.0):
            if "Parsing Worker" in sys_prompt:
                return {
                    "headline": "Bảng liều dùng bị vỡ cột khi đọc PDF.",
                    "findings": [
                        {
                            "pattern": "Vỡ cấu trúc bảng liều dùng",
                            "severity": "high",
                            "summary": "Bảng TDF/FTC bị mất cấu trúc cột.",
                            "evidence_refs": ["DOC01:PU#0 (p.1)"],
                        }
                    ],
                    "recommended_knobs": {"pdf_parse_method": "DeepDOC", "table_context_size": 256},
                }
            if "Chunking Worker" in sys_prompt:
                return {
                    "headline": "Đoạn cắt bị thiếu tiêu đề mục cha.",
                    "findings": [
                        {
                            "pattern": "Thiếu tiêu đề mục cha",
                            "severity": "high",
                            "summary": "Đoạn số 1 không giữ tiêu đề Điều 5.",
                            "evidence_refs": ["DOC01#chunk-1"],
                        }
                    ],
                    "recommended_knobs": {"use_parent_child": True, "chunk_token_size": 768},
                }
            if "Retrieval Worker" in sys_prompt:
                return {
                    "headline": "Tắt tìm kiếm từ khóa khiến rớt mã TDF/FTC.",
                    "findings": [
                        {
                            "pattern": "Rớt từ khóa chuyên ngành",
                            "severity": "high",
                            "summary": "Đoạn chk_3 sai lọt Top-1 do thiếu BM25.",
                            "evidence_refs": ["TC-01"],
                        }
                    ],
                    "per_case": [{"tc_code": "TC-01", "why_failed": "Miss TDF/FTC", "fix_hint": "Bật keyword"}],
                    "recommended_knobs": {"keyword_enabled": True, "vector_similarity_weight": 0.2},
                }
            return {
                "executive_summary": "Lỗi phối hợp giữa vỡ bảng đọc file, thiếu chủ thể đoạn và tắt tìm kiếm từ khóa.",
                "improvement_plan": [
                    "Bước 1: Bật cắt Cha - Con và nâng ngữ cảnh bảng lên 256.",
                    "Bước 2: Bật tìm kiếm từ khóa BM25 và chỉnh tỷ trọng vector về 0.2.",
                ],
                "packs": [
                    {
                        "name": "Cắt Cha - Con & BM25",
                        "scope": "JOINT",
                        "hypothesis_statement": "Bật Cha - Con và BM25 giúp giữ Điều 5 và bắt đúng mã TDF/FTC.",
                        "conflict_resolution": "Dùng Cha - Con thay vì tăng kích thước đoạn quá lớn.",
                        "evidence_refs": ["TC-01", "DOC01#chunk-1"],
                        "expected_gains": ["Cứu TC-01"],
                        "regression_warnings": ["Tăng nhẹ thời gian đọc lại"],
                        "index_patch": {"use_parent_child": True, "table_context_size": 256, "bad_key": 1},
                        "retrieval_patch": {"keyword_enabled": True, "vector_similarity_weight": 0.2},
                    }
                ],
            }

        with patch("diagnostic_swarm.call_llm_json", side_effect=fake_llm) as mock_llm:
            rep1 = await diagnostic_swarm.run_agent_diagnosis_swarm(run_id=1, force_refresh=False, include_vision=False)
            self.assertFalse(rep1["cached"])
            self.assertEqual(rep1["architecture_mode"], "supervisor_worker")
            self.assertFalse(rep1["drilldown_triggered"])
            self.assertEqual(rep1["llm_calls"], 4)
            self.assertEqual(rep1["evidence_counts"]["golden_total"], 1)
            self.assertEqual(
                rep1["models_by_agent"],
                {
                    "parsing": "google/gemini-2.5-flash",
                    "chunking": "openai/gpt-4.1",
                    "retrieval": "openai/gpt-5-mini",
                    "supervisor": "openai/gpt-5.2",
                },
            )
            self.assertEqual(len(rep1["layer_diagnoses"]), 3)
            self.assertEqual(len(rep1["improvement_plan"]), 2)
            # LLM mock returned 1 JOINT pack; backend complements distinct RETRIEVAL + INDEX packs from workers
            self.assertEqual(len(rep1["hypothesis_packs"]), 3)
            self.assertEqual({p["scope"] for p in rep1["hypothesis_packs"]}, {"JOINT", "RETRIEVAL", "INDEX"})
            pack = rep1["hypothesis_packs"][0]
            self.assertEqual(pack["index_patch"], {"use_parent_child": True, "table_context_size": 256})
            self.assertNotIn("bad_key", pack["index_patch"])

            # Second call with identical evidence hits SQLite cache with 0 extra LLM calls
            rep2 = await diagnostic_swarm.run_agent_diagnosis_swarm(run_id=1, force_refresh=False, include_vision=False)
            self.assertTrue(rep2["cached"])
            self.assertEqual(mock_llm.call_count, 4)

            st_fresh = diagnostic_swarm.get_latest_agent_diagnosis_status(run_id=1)
            self.assertFalse(st_fresh["is_stale"])

            # Simulate adding a new chunk after sync -> staleness must flip to True
            with database.get_db() as conn:
                conn.execute(
                    "INSERT INTO chunks (id, run_id, document_id, ragflow_doc_id, ragflow_chunk_id, chunk_index, content, char_count, token_est, page_num, rule_flags) "
                    "VALUES (4, 1, 1, 'rdoc_1', 'chk_4', 3, 'Đoạn mới đồng bộ thêm.', 22, 8, 2, '[]')"
                )
            st_stale = diagnostic_swarm.get_latest_agent_diagnosis_status(run_id=1)
            self.assertTrue(st_stale["is_stale"])

    async def test_per_agent_model_fallback_to_default(self):
        async def flaky_chunk_llm(base_url, api_key, model, sys_prompt, user_prompt, timeout=45.0):
            if "Chunking Worker" in sys_prompt and model == "openai/gpt-4.1":
                raise RuntimeError("429 rate limit on gpt-4.1")
            if "Parsing Worker" in sys_prompt:
                return {"headline": "OK", "findings": [], "recommended_knobs": {}}
            if "Chunking Worker" in sys_prompt:
                return {
                    "headline": "Fallback thành công về mock-model.",
                    "findings": [{"pattern": "Đứt câu", "severity": "medium", "summary": "Fallback OK", "evidence_refs": ["DOC01#chunk-1"]}],
                    "recommended_knobs": {"chunk_token_size": 768},
                }
            if "Retrieval Worker" in sys_prompt:
                return {"headline": "OK", "findings": [], "per_case": [], "recommended_knobs": {}}
            return {
                "executive_summary": "Tổng hợp sau fallback.",
                "improvement_plan": ["Bước 1: Tăng chunk size."],
                "packs": [
                    {
                        "name": "Tăng chunk size",
                        "scope": "INDEX",
                        "hypothesis_statement": "Tăng lên 768.",
                        "index_patch": {"chunk_token_size": 768},
                        "retrieval_patch": {},
                    }
                ],
            }

        with patch("diagnostic_swarm.call_llm_json", side_effect=flaky_chunk_llm):
            rep = await diagnostic_swarm.run_agent_diagnosis_swarm(run_id=1, force_refresh=True, include_vision=False)
            self.assertEqual(rep["models_by_agent"]["chunking"], "mock-model")
            self.assertEqual(rep["models_by_agent"]["supervisor"], "openai/gpt-5.2")
            chunk_layer = next(d for d in rep["layer_diagnoses"] if d["layer"] == "CHUNKING")
            self.assertEqual(chunk_layer["status"], "ISSUES_FOUND")
            self.assertEqual(chunk_layer["model_used"], "mock-model")

    async def test_supervisor_bounded_drilldown_on_missing_text(self):
        # Remove failing parsing_unit so Parsing Worker initially returns SKIPPED_NO_DATA,
        # while testcase TC-01 has missing text (low match_score) -> Supervisor triggers 1 drill-down.
        with database.get_db() as conn:
            conn.execute("DELETE FROM parsing_units")
            conn.execute(
                "UPDATE golden_testcases SET reference_context = 'Nội dung hoàn toàn không tồn tại trong kho đoạn xyz123456' WHERE id = 1"
            )
            conn.execute(
                "INSERT INTO retrieval_results (retrieval_run_id, testcase_id, rank, ragflow_chunk_id, doc_name, content, similarity, relevant, relevancy_source, reason) "
                "VALUES (2, 1, 2, 'chk_1', 'huong_dan.pdf', 'Điều 5', 0.4, 0, 'MANUAL', 'Sai')"
            )

        calls_seen = []

        async def fake_llm(base_url, api_key, model, sys_prompt, user_prompt, timeout=45.0):
            calls_seen.append(sys_prompt[:60])
            if "Parsing Worker" in sys_prompt:
                return {
                    "headline": "Phát hiện trang PDF có thể bị đọc sót chữ.",
                    "findings": [
                        {
                            "pattern": "Sót chữ khi đọc PDF",
                            "severity": "high",
                            "summary": "Kho đoạn không chứa thông tin về xyz123456.",
                            "evidence_refs": ["TC-01"],
                        }
                    ],
                    "recommended_knobs": {"pdf_parse_method": "MinerU", "enable_vision_enhancement": True},
                }
            if "Chunking Worker" in sys_prompt:
                return {"headline": "Ổn định", "findings": [], "recommended_knobs": {}}
            if "Retrieval Worker" in sys_prompt:
                return {
                    "headline": "Thiếu đoạn nguồn trong kho.",
                    "findings": [{"pattern": "Thiếu dữ liệu gốc", "severity": "high", "summary": "Không tìm thấy đoạn nguồn.", "evidence_refs": ["TC-01"]}],
                    "per_case": [],
                    "recommended_knobs": {},
                }
            return {
                "executive_summary": "Điều phối viên phát hiện sót dữ liệu ở bước đọc file.",
                "improvement_plan": ["Bước 1: Đổi bộ đọc PDF sang MinerU hoặc bật đọc ảnh AI."],
                "packs": [
                    {
                        "name": "Nâng cấp bộ đọc PDF",
                        "scope": "INDEX",
                        "hypothesis_statement": "Chuyển sang MinerU để lấy lại phần nội dung bị sót.",
                        "conflict_resolution": "",
                        "evidence_refs": ["TC-01"],
                        "expected_gains": ["Lấy đủ nội dung bị mất"],
                        "regression_warnings": [],
                        "index_patch": {"pdf_parse_method": "MinerU"},
                        "retrieval_patch": {},
                    }
                ],
            }

        with patch("diagnostic_swarm.call_llm_json", side_effect=fake_llm):
            rep = await diagnostic_swarm.run_agent_diagnosis_swarm(run_id=1, force_refresh=True, include_vision=False)
            self.assertTrue(rep["drilldown_triggered"])
            self.assertEqual(rep["llm_calls"], 4)  # chunking(1) + retrieval(1) + parsing_drilldown(1) + synthesizer(1)
            self.assertEqual(rep["layer_diagnoses"][0]["status"], "ISSUES_FOUND")
            self.assertTrue(any("kiểm tra bổ sung" in n for n in rep["supervisor_notes"]))

    async def test_compare_regression_autopsy(self):
        async def fake_llm(base_url, api_key, model, sys_prompt, user_prompt, timeout=45.0):
            if "Retrieval Worker" in sys_prompt:
                return {
                    "headline": "Tắt keyword + tăng threshold làm rớt TC-01.",
                    "findings": [
                        {
                            "pattern": "REGRESSION_BM25_OFF",
                            "severity": "high",
                            "summary": "Bản B tắt keyword khiến TDF/FTC tụt hạng.",
                            "evidence_refs": ["TC-01"],
                        }
                    ],
                    "per_case": [
                        {"tc_code": "TC-01", "why_failed": "Mất khớp từ khóa TDF/FTC", "fix_hint": "Bật lại keyword_enabled=true"}
                    ],
                    "recommended_knobs": {"keyword_enabled": True, "similarity_threshold": 0.15},
                }
            return {
                "executive_summary": "Bản B bị regression ở TC-01 do tắt BM25 và đẩy vector_similarity_weight lên 0.7.",
                "packs": [
                    {
                        "name": "Khôi phục Hybrid BM25",
                        "scope": "RETRIEVAL",
                        "hypothesis_statement": "Bật lại keyword_enabled và hạ threshold xuống 0.15.",
                        "conflict_resolution": "",
                        "evidence_refs": ["TC-01"],
                        "expected_gains": ["Khôi phục TC-01"],
                        "regression_warnings": [],
                        "index_patch": {},
                        "retrieval_patch": {"keyword_enabled": True, "similarity_threshold": 0.15},
                    }
                ],
            }

        with patch("diagnostic_swarm.call_llm_json", side_effect=fake_llm):
            autopsy = await diagnostic_swarm.run_compare_regression_autopsy(1, 2)
            self.assertEqual(autopsy["report_type"], "REGRESSION_AUTOPSY")
            self.assertEqual(len(autopsy["regressions_analyzed"]), 1)
            self.assertEqual(autopsy["regressions_analyzed"][0]["tc_code"], "TC-01")
            self.assertIn("TDF/FTC", autopsy["regressions_analyzed"][0]["why_failed"])
            self.assertEqual(len(autopsy["hypothesis_packs"]), 1)

    async def test_fork_run_copies_docs_and_triggers_parse(self):
        with database.get_db() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("ragflow_base_url", "http://ragflow.local", "2026-01-01T00:00:00Z"),
            )
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("ragflow_api_key", "rf-key", "2026-01-01T00:00:00Z"),
            )

        sample_file = os.path.join(self.tmp_dir.name, "huong_dan.pdf")
        with open(sample_file, "wb") as f:
            f.write(b"%PDF-1.4 mock content")
        with database.get_db() as conn:
            conn.execute("UPDATE documents SET file_path = ? WHERE id = 1", (sample_file,))

        mock_client = AsyncMock()
        mock_client.get_dataset.return_value = {"id": "ds_1", "embedding_model": "BAAI/bge-m3"}
        mock_client.create_dataset.return_value = {"id": "ds_2", "name": "Forked"}
        mock_client.upload_document.return_value = [{"id": "new_rdoc_1"}]
        mock_client.parse_documents.return_value = {}

        payload = optimizer_router.ApplyConfigRequest(
            index_patch={"chunk_token_size": 768, "use_parent_child": True},
            retrieval_patch={"top_k": 10},
            sync_remote=True,
            fork_new_run=True,
            new_run_name="Test Fork",
            copy_docs=True,
            auto_parse=True,
        )
        with patch("routers.optimizer.RAGFlowClient", return_value=mock_client):
            res = await optimizer_router.apply_recommended_config(1, payload)

        self.assertTrue(res["ok"])
        self.assertTrue(res["forked"])
        self.assertTrue(res["remote_synced"])
        self.assertEqual(res["run"]["golden_source_run_id"], 1)
        self.assertEqual(res["copied_docs"], 1)
        self.assertTrue(res["parse_triggered"])
        mock_client.create_dataset.assert_awaited_once()
        self.assertEqual(mock_client.create_dataset.call_args.kwargs.get("embedding_model"), "BAAI/bge-m3")
        mock_client.upload_document.assert_awaited_once_with("ds_2", "huong_dan.pdf", b"%PDF-1.4 mock content")
        mock_client.parse_documents.assert_awaited_once_with("ds_2", ["new_rdoc_1"])

        new_run_id = res["run"]["id"]
        with database.get_db() as conn:
            rds = conn.execute("SELECT * FROM run_documents WHERE run_id = ?", (new_run_id,)).fetchall()
            self.assertEqual(len(rds), 1)
            self.assertEqual(rds[0]["ragflow_doc_id"], "new_rdoc_1")
            self.assertEqual(rds[0]["parse_status"], "RUNNING")


if __name__ == "__main__":
    unittest.main()
