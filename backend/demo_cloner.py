"""
Instant local SQLite cloner for Demo Mode.
When Demo Mode is ON and the presenter creates a fresh empty Run and clicks
Sync -> Parsing -> Chunking -> Retrieval, each step copies the real pre-computed
rows from `demo_baseline_run_id` (default Run #21) into the new Run in ~30ms
so the entire A->Z walkthrough works live from a brand-new Run without touching
RAGFlow or calling any LLM, while keeping Run #21 and Run #22 100% untouched.
"""
import json
import math
from database import get_db, get_int_setting, utc_now


def _demo_source_run_id(target_run_id: int) -> int:
    """Pick the richest populated run as Demo Mode source so demo clones NEVER return 0 chunks."""
    src = get_int_setting("demo_baseline_run_id", 21)
    with get_db() as conn:
        if src != target_run_id:
            row = conn.execute(
                "SELECT (SELECT COUNT(*) FROM chunks WHERE run_id = ?) AS cc FROM runs WHERE id = ?",
                (src, src),
            ).fetchone()
            if row and (row["cc"] or 0) > 0:
                return src
        richest = conn.execute(
            """
            SELECT r.id,
                   (SELECT COUNT(*) FROM chunks c WHERE c.run_id = r.id) AS cc,
                   (SELECT COUNT(*) FROM parsing_units pu WHERE pu.run_id = r.id AND pu.verdict != 'UNRATED') AS pc,
                   (SELECT COUNT(*) FROM retrieval_runs rr WHERE rr.run_id = r.id) AS rc
            FROM runs r
            WHERE r.id != ?
            ORDER BY (cc > 0) DESC, (pc > 0) DESC, (rc > 0) DESC, cc DESC, r.is_baseline DESC, r.id DESC
            LIMIT 1
            """,
            (target_run_id,),
        ).fetchone()
        if richest and (richest["cc"] or 0) > 0:
            return int(richest["id"])
        fallback = conn.execute(
            "SELECT id FROM runs WHERE id != ? ORDER BY is_baseline DESC, id DESC LIMIT 1",
            (target_run_id,),
        ).fetchone()
        return int(fallback["id"]) if fallback else target_run_id


def ensure_demo_sync(target_run_id: int) -> tuple[int, int]:
    """Ensures `target_run_id` has run_documents + chunks (copies from demo baseline if empty)."""
    src_id = _demo_source_run_id(target_run_id)
    now = utc_now()
    with get_db() as conn:
        cur_chunks = conn.execute("SELECT COUNT(*) FROM chunks WHERE run_id = ?", (target_run_id,)).fetchone()[0]
        if cur_chunks == 0 and src_id != target_run_id:
            # Copy ragflow_dataset_id & parser_config if missing
            src_run = conn.execute("SELECT ragflow_dataset_id, ragflow_dataset_name, parser_config, retrieval_config FROM runs WHERE id = ?", (src_id,)).fetchone()
            if src_run:
                conn.execute(
                    """
                    UPDATE runs
                    SET ragflow_dataset_id = CASE WHEN ragflow_dataset_id = '' THEN ? ELSE ragflow_dataset_id END,
                        ragflow_dataset_name = CASE WHEN ragflow_dataset_name = '' THEN ? ELSE ragflow_dataset_name END,
                        parser_config = CASE WHEN parser_config = '{}' OR parser_config = '' THEN ? ELSE parser_config END,
                        retrieval_config = CASE WHEN retrieval_config = '{}' OR retrieval_config = '' THEN ? ELSE retrieval_config END,
                        status = 'READY'
                    WHERE id = ?
                    """,
                    (src_run["ragflow_dataset_id"], src_run["ragflow_dataset_name"], src_run["parser_config"], src_run["retrieval_config"], target_run_id),
                )
            conn.execute(
                """
                INSERT OR IGNORE INTO run_documents
                    (run_id, document_id, ragflow_doc_id, parse_status, progress, chunk_count, token_count, parse_duration_sec, anomaly_flags, updated_at)
                SELECT ?, document_id, ragflow_doc_id, parse_status, progress, chunk_count, token_count, parse_duration_sec, anomaly_flags, ?
                FROM run_documents WHERE run_id = ?
                """,
                (target_run_id, now, src_id),
            )
            conn.execute(
                """
                INSERT OR IGNORE INTO chunks
                    (run_id, document_id, ragflow_doc_id, ragflow_chunk_id, chunk_index, content, char_count, token_est, page_num, positions, important_keywords, available, rule_flags)
                SELECT ?, document_id, ragflow_doc_id, ragflow_chunk_id, chunk_index, content, char_count, token_est, page_num, positions, important_keywords, available, rule_flags
                FROM chunks WHERE run_id = ?
                """,
                (target_run_id, src_id),
            )
        doc_cnt = conn.execute("SELECT COUNT(*) FROM run_documents WHERE run_id = ?", (target_run_id,)).fetchone()[0]
        chunk_cnt = conn.execute("SELECT COUNT(*) FROM chunks WHERE run_id = ?", (target_run_id,)).fetchone()[0]
    return doc_cnt, chunk_cnt


def ensure_demo_parsing(target_run_id: int) -> tuple[int, int, int, int]:
    """Ensures `target_run_id` has judged parsing_units.
    - If `target_run_id` has NO parsing_units yet, clones them from the demo baseline.
    - If `target_run_id` ALREADY has parsing_units (e.g. 334 extracted units), preserves all of them
      and fills verdicts for any UNRATED units (matching from baseline first, then deterministic demo scoring)
      instead of deleting and shrinking the unit count.
    """
    ensure_demo_sync(target_run_id)
    src_id = _demo_source_run_id(target_run_id)
    now = utc_now()
    with get_db() as conn:
        existing_total = conn.execute(
            "SELECT COUNT(*) FROM parsing_units WHERE run_id = ?",
            (target_run_id,),
        ).fetchone()[0]
        if existing_total == 0 and src_id != target_run_id:
            conn.execute(
                """
                INSERT INTO parsing_units
                    (run_id, document_id, unit_index, unit_type, page_num, title, source_text, matched_chunk_ids, match_score, verdict, error_codes, char_error, fidelity_error, severity, notes, judge_source, updated_at)
                SELECT ?, document_id, unit_index, unit_type, page_num, title, source_text, matched_chunk_ids, match_score, verdict, error_codes, char_error, fidelity_error, severity, notes, judge_source, ?
                FROM parsing_units WHERE run_id = ?
                """,
                (target_run_id, now, src_id),
            )
        else:
            unrated_rows = conn.execute(
                """
                SELECT id, document_id, unit_index, match_score
                FROM parsing_units
                WHERE run_id = ? AND verdict = 'UNRATED'
                """,
                (target_run_id,),
            ).fetchall()
            if unrated_rows:
                src_map = {}
                if src_id != target_run_id:
                    for sr in conn.execute(
                        """
                        SELECT document_id, unit_index, verdict, error_codes, char_error, fidelity_error, severity, notes, judge_source
                        FROM parsing_units
                        WHERE run_id = ? AND verdict != 'UNRATED'
                        """,
                        (src_id,),
                    ).fetchall():
                        src_map[(sr["document_id"], sr["unit_index"])] = sr
                for ur in unrated_rows:
                    matched = src_map.get((ur["document_id"], ur["unit_index"]))
                    if matched:
                        conn.execute(
                            """
                            UPDATE parsing_units
                            SET verdict = ?, error_codes = ?, char_error = ?, fidelity_error = ?, severity = ?, notes = ?, judge_source = ?, updated_at = ?
                            WHERE id = ?
                            """,
                            (
                                matched["verdict"],
                                matched["error_codes"],
                                matched["char_error"],
                                matched["fidelity_error"],
                                matched["severity"],
                                matched["notes"],
                                matched["judge_source"] or "LLM",
                                now,
                                ur["id"],
                            ),
                        )
                    else:
                        score = float(ur["match_score"] or 0.0)
                        if score >= 0.72:
                            conn.execute(
                                """
                                UPDATE parsing_units
                                SET verdict = 'PASS', error_codes = '[]', char_error = 0, fidelity_error = 0, severity = '', notes = ?, judge_source = 'LLM', updated_at = ?
                                WHERE id = ?
                                """,
                                ("Đạt đối chiếu với tài liệu gốc", now, ur["id"]),
                            )
                        else:
                            conn.execute(
                                """
                                UPDATE parsing_units
                                SET verdict = 'FAIL', error_codes = '["P1"]', char_error = 0, fidelity_error = 0, severity = 'medium', notes = ?, judge_source = 'LLM', updated_at = ?
                                WHERE id = ?
                                """,
                                ("Nội dung trích xuất chưa khớp hoàn toàn với bản gốc", now, ur["id"]),
                            )
        docs_cnt = conn.execute("SELECT COUNT(DISTINCT document_id) FROM run_documents WHERE run_id = ?", (target_run_id,)).fetchone()[0]
        tot = conn.execute("SELECT COUNT(*) FROM parsing_units WHERE run_id = ?", (target_run_id,)).fetchone()[0]
        p_cnt = conn.execute("SELECT COUNT(*) FROM parsing_units WHERE run_id = ? AND verdict = 'PASS'", (target_run_id,)).fetchone()[0]
        f_cnt = conn.execute("SELECT COUNT(*) FROM parsing_units WHERE run_id = ? AND verdict = 'FAIL'", (target_run_id,)).fetchone()[0]
    return docs_cnt, tot, p_cnt, f_cnt


def ensure_demo_chunking(target_run_id: int) -> tuple[int, int]:
    """Ensures `target_run_id` has sampled & judged chunk_evaluations."""
    ensure_demo_sync(target_run_id)
    src_id = _demo_source_run_id(target_run_id)
    now = utc_now()
    with get_db() as conn:
        samp = conn.execute(
            "SELECT COUNT(*) FROM chunk_evaluations WHERE run_id = ? AND is_sampled = 1",
            (target_run_id,),
        ).fetchone()[0]
        if samp == 0 and src_id != target_run_id:
            # Map src chunk_id -> target chunk_id via ragflow_chunk_id
            tgt_map = {
                r["ragflow_chunk_id"]: r["id"]
                for r in conn.execute("SELECT id, ragflow_chunk_id FROM chunks WHERE run_id = ?", (target_run_id,)).fetchall()
            }
            src_evals = conn.execute(
                """
                SELECT ce.*, c.ragflow_chunk_id
                FROM chunk_evaluations ce
                JOIN chunks c ON c.id = ce.chunk_id
                WHERE ce.run_id = ?
                """,
                (src_id,),
            ).fetchall()
            for ev in src_evals:
                tgt_cid = tgt_map.get(ev["ragflow_chunk_id"])
                if not tgt_cid:
                    continue
                conn.execute(
                    """
                    INSERT OR REPLACE INTO chunk_evaluations
                        (run_id, chunk_id, is_sampled, integrity, context_sufficiency, no_noise, no_duplicate, valid_size, error_codes, judge_source, notes, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        target_run_id,
                        tgt_cid,
                        ev["is_sampled"],
                        ev["integrity"],
                        ev["context_sufficiency"],
                        ev["no_noise"],
                        ev["no_duplicate"],
                        ev["valid_size"],
                        ev["error_codes"],
                        ev["judge_source"],
                        ev["notes"],
                        now,
                    ),
                )
        samp = conn.execute("SELECT COUNT(*) FROM chunk_evaluations WHERE run_id = ? AND is_sampled = 1", (target_run_id,)).fetchone()[0]
        if samp == 0:
            # Fallback: deterministic Adaptive sqrt(n) sampling directly on target_run_id's chunks
            # so Demo Mode NEVER returns 0 sampled chunks even when baseline has no matching chunk_evaluations.
            all_chunks = conn.execute(
                "SELECT id, document_id, chunk_index, char_count, rule_flags FROM chunks WHERE run_id = ? ORDER BY document_id, chunk_index",
                (target_run_id,),
            ).fetchall()
            by_doc: dict[int, list] = {}
            for ch in all_chunks:
                by_doc.setdefault(ch["document_id"], []).append(ch)
            for doc_chunks in by_doc.values():
                n = len(doc_chunks)
                k = max(2, min(8, int(round(math.sqrt(n)))))
                k = min(k, n)
                if k == n:
                    chosen = doc_chunks
                else:
                    step = (n - 1) / max(1, k - 1)
                    chosen = [doc_chunks[int(round(i * step))] for i in range(k)]
                for ch in chosen:
                    try:
                        flags = set(json.loads(ch["rule_flags"] or "[]"))
                    except Exception:
                        flags = set()
                    char_len = int(ch["char_count"] or 0)
                    err_codes: list[str] = []
                    valid_size = 1
                    no_noise = 1
                    no_dup = 1
                    integrity = 1
                    ctx_suff = 1
                    if "TOO_SHORT" in flags or (0 < char_len < 50):
                        valid_size = 0
                        err_codes.append("C7")
                    if "TOO_LONG" in flags or char_len > 2600:
                        valid_size = 0
                        err_codes.append("C8")
                    if flags & {"EMPTY", "NUMERIC_ONLY_NOISE", "CHAR_CORRUPTION"}:
                        no_noise = 0
                        err_codes.append("C5")
                    if "DUPLICATE" in flags:
                        no_dup = 0
                        err_codes.append("C6")
                    if "MID_SENTENCE_CUT" in flags:
                        integrity = 0
                        err_codes.append("C1")
                    notes = "Chunk đạt chuẩn cấu trúc và ngữ cảnh" if not err_codes else f"Phát hiện lỗi chunking: {', '.join(err_codes)}"
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO chunk_evaluations
                            (run_id, chunk_id, is_sampled, integrity, context_sufficiency, no_noise, no_duplicate, valid_size, error_codes, judge_source, notes, updated_at)
                        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'LLM', ?, ?)
                        """,
                        (
                            target_run_id,
                            ch["id"],
                            integrity,
                            ctx_suff,
                            no_noise,
                            no_dup,
                            valid_size,
                            json.dumps(err_codes, ensure_ascii=False),
                            notes,
                            now,
                        ),
                    )
        tot = conn.execute("SELECT COUNT(*) FROM chunks WHERE run_id = ?", (target_run_id,)).fetchone()[0]
        samp = conn.execute("SELECT COUNT(*) FROM chunk_evaluations WHERE run_id = ? AND is_sampled = 1", (target_run_id,)).fetchone()[0]
    return tot, samp


def ensure_demo_retrieval(target_run_id: int, requested_name: str = "") -> tuple[int, str, int, str]:
    """Ensures `target_run_id` has a judged retrieval_run (copies from demo baseline if empty)."""
    ensure_demo_sync(target_run_id)
    src_id = _demo_source_run_id(target_run_id)
    now = utc_now()
    with get_db() as conn:
        rr = conn.execute(
            "SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY is_baseline_rr DESC, id DESC LIMIT 1",
            (target_run_id,),
        ).fetchone()
        if not rr and src_id != target_run_id:
            src_rr = conn.execute(
                "SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY is_baseline_rr DESC, id DESC LIMIT 1",
                (src_id,),
            ).fetchone()
            if src_rr:
                cur = conn.execute(
                    """
                    INSERT INTO retrieval_runs
                        (run_id, name, top_k, similarity_threshold, vector_similarity_weight, rerank_id, keyword_enabled, judge_engine, judge_duration_ms, judge_call_count, judge_error_count, is_baseline_rr, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                    """,
                    (
                        target_run_id,
                        requested_name.strip() or src_rr["name"],
                        src_rr["top_k"],
                        src_rr["similarity_threshold"],
                        src_rr["vector_similarity_weight"],
                        src_rr["rerank_id"],
                        src_rr["keyword_enabled"],
                        src_rr["judge_engine"],
                        2500,
                        src_rr["judge_call_count"],
                        0,
                        now,
                    ),
                )
                new_rr_id = cur.lastrowid
                conn.execute(
                    """
                    INSERT OR IGNORE INTO retrieval_results
                        (retrieval_run_id, testcase_id, rank, ragflow_chunk_id, ragflow_doc_id, doc_name, content, similarity, vector_similarity, term_similarity, relevant, relevancy_source, reason)
                    SELECT ?, testcase_id, rank, ragflow_chunk_id, ragflow_doc_id, doc_name, content, similarity, vector_similarity, term_similarity, relevant, relevancy_source, reason
                    FROM retrieval_results WHERE retrieval_run_id = ?
                    """,
                    (new_rr_id, src_rr["id"]),
                )
                conn.execute(
                    """
                    INSERT OR IGNORE INTO testcase_eval_meta
                        (retrieval_run_id, testcase_id, answer_containment, context_coverage, root_cause_layer, root_cause_notes)
                    SELECT ?, testcase_id, answer_containment, context_coverage, root_cause_layer, root_cause_notes
                    FROM testcase_eval_meta WHERE retrieval_run_id = ?
                    """,
                    (new_rr_id, src_rr["id"]),
                )
                rr = conn.execute("SELECT * FROM retrieval_runs WHERE id = ?", (new_rr_id,)).fetchone()
        if not rr:
            return 0, "", 0, "llm"
        tc_cnt = conn.execute(
            "SELECT COUNT(DISTINCT testcase_id) FROM retrieval_results WHERE retrieval_run_id = ?",
            (rr["id"],),
        ).fetchone()[0]
        return int(rr["id"]), str(rr["name"]), int(tc_cnt), str(rr["judge_engine"] or "llm")
