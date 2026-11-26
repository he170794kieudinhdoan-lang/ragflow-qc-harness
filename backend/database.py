import hashlib
import sqlite3
import json
import os
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
DB_PATH = os.path.join(DATA_DIR, "ragflow_qc.db")

os.makedirs(UPLOAD_DIR, exist_ok=True)

_SETTINGS_LOCK = threading.Lock()
_SETTINGS_CACHE: dict[str, str] | None = None


def invalidate_settings_cache() -> None:
    global _SETTINGS_CACHE
    with _SETTINGS_LOCK:
        _SETTINGS_CACHE = None


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=15.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA busy_timeout = 15000;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def repair_chunk_document_links(conn) -> int:
    """
    Chunks are keyed by (run_id, ragflow_chunk_id) and keep their ragflow_doc_id even when the
    local document row is removed (ON DELETE SET NULL). Re-link them through run_documents so
    parsing/chunking can find them again instead of silently losing every matched chunk.
    """
    cur = conn.execute(
        """
        UPDATE chunks
           SET document_id = (
               SELECT rd.document_id
                 FROM run_documents rd
                WHERE rd.run_id = chunks.run_id
                  AND rd.ragflow_doc_id = chunks.ragflow_doc_id
                LIMIT 1
           )
         WHERE (document_id IS NULL OR document_id NOT IN (SELECT id FROM documents))
           AND ragflow_doc_id != ''
           AND EXISTS (
               SELECT 1 FROM run_documents rd
                WHERE rd.run_id = chunks.run_id
                  AND rd.ragflow_doc_id = chunks.ragflow_doc_id
           )
        """
    )
    return cur.rowcount


def init_db():
    with get_db() as conn:
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_code TEXT UNIQUE NOT NULL,
                filename TEXT NOT NULL,
                format_group TEXT NOT NULL,
                source_url TEXT DEFAULT '',
                file_path TEXT DEFAULT '',
                page_count INTEGER DEFAULT 0,
                has_tables INTEGER DEFAULT 0,
                has_images INTEGER DEFAULT 0,
                is_scan INTEGER DEFAULT 0,
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                description TEXT DEFAULT '',
                is_baseline INTEGER DEFAULT 0,
                ragflow_dataset_id TEXT DEFAULT '',
                ragflow_dataset_name TEXT DEFAULT '',
                parser_config TEXT DEFAULT '{}',
                retrieval_config TEXT DEFAULT '{}',
                status TEXT DEFAULT 'DRAFT',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS run_documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                ragflow_doc_id TEXT DEFAULT '',
                parse_status TEXT DEFAULT 'UNSTART',
                progress REAL DEFAULT 0,
                chunk_count INTEGER DEFAULT 0,
                token_count INTEGER DEFAULT 0,
                parse_duration_sec REAL DEFAULT 0,
                anomaly_flags TEXT DEFAULT '[]',
                updated_at TEXT NOT NULL,
                UNIQUE(run_id, document_id)
            );

            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
                ragflow_doc_id TEXT DEFAULT '',
                ragflow_chunk_id TEXT NOT NULL,
                chunk_index INTEGER DEFAULT 0,
                content TEXT NOT NULL,
                char_count INTEGER DEFAULT 0,
                token_est INTEGER DEFAULT 0,
                page_num INTEGER DEFAULT 0,
                positions TEXT DEFAULT '[]',
                important_keywords TEXT DEFAULT '[]',
                available INTEGER DEFAULT 1,
                rule_flags TEXT DEFAULT '[]',
                UNIQUE(run_id, ragflow_chunk_id)
            );

            CREATE TABLE IF NOT EXISTS parsing_units (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                unit_index INTEGER NOT NULL,
                unit_type TEXT NOT NULL DEFAULT 'text', -- text | table | heading | list | image
                page_num INTEGER DEFAULT 1,
                title TEXT DEFAULT '',
                source_text TEXT NOT NULL,
                matched_chunk_ids TEXT DEFAULT '[]',
                match_score REAL DEFAULT 0.0,
                verdict TEXT DEFAULT 'UNRATED', -- PASS | FAIL | PARTIAL | UNRATED
                error_codes TEXT DEFAULT '[]',  -- P1..P10
                char_error INTEGER DEFAULT 0,
                fidelity_error INTEGER DEFAULT 0,
                severity TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chunk_evaluations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
                is_sampled INTEGER DEFAULT 1,
                integrity INTEGER,            -- 1 / 0 / NULL
                context_sufficiency INTEGER,  -- 1 / 0 / NULL
                no_noise INTEGER,             -- 1 / 0 / NULL
                no_duplicate INTEGER,         -- 1 / 0 / NULL
                valid_size INTEGER,           -- 1 / 0 / NULL
                error_codes TEXT DEFAULT '[]', -- C1..C8
                judge_source TEXT DEFAULT 'MANUAL', -- MANUAL | RULE | LLM_DRAFT
                notes TEXT DEFAULT '',
                updated_at TEXT NOT NULL,
                UNIQUE(run_id, chunk_id)
            );

            CREATE TABLE IF NOT EXISTS golden_testcases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tc_code TEXT UNIQUE NOT NULL,
                input_question TEXT NOT NULL,
                expected_outcome TEXT DEFAULT '',
                reference_context TEXT NOT NULL,
                source_file TEXT DEFAULT '',
                question_class TEXT DEFAULT 'Local', -- Local | Global | Multi-hop
                intent_type TEXT DEFAULT 'Factoid',
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS retrieval_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                top_k INTEGER DEFAULT 10,
                similarity_threshold REAL DEFAULT 0.2,
                vector_similarity_weight REAL DEFAULT 0.3,
                rerank_id TEXT DEFAULT '',
                keyword_enabled INTEGER DEFAULT 1,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS retrieval_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                retrieval_run_id INTEGER NOT NULL REFERENCES retrieval_runs(id) ON DELETE CASCADE,
                testcase_id INTEGER NOT NULL REFERENCES golden_testcases(id) ON DELETE CASCADE,
                rank INTEGER NOT NULL,
                ragflow_chunk_id TEXT NOT NULL,
                ragflow_doc_id TEXT DEFAULT '',
                doc_name TEXT DEFAULT '',
                content TEXT NOT NULL,
                similarity REAL DEFAULT 0.0,
                vector_similarity REAL DEFAULT 0.0,
                term_similarity REAL DEFAULT 0.0,
                relevant INTEGER,               -- 1 | 0 | NULL
                relevancy_source TEXT DEFAULT 'UNRATED', -- MANUAL | CACHED | LLM_DRAFT | UNRATED
                reason TEXT DEFAULT '',
                UNIQUE(retrieval_run_id, testcase_id, rank)
            );

            CREATE TABLE IF NOT EXISTS relevancy_cache (
                testcase_id INTEGER NOT NULL REFERENCES golden_testcases(id) ON DELETE CASCADE,
                ragflow_chunk_id TEXT NOT NULL,
                relevant INTEGER NOT NULL,
                reason TEXT DEFAULT '',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (testcase_id, ragflow_chunk_id)
            );

            CREATE TABLE IF NOT EXISTS testcase_eval_meta (
                retrieval_run_id INTEGER NOT NULL REFERENCES retrieval_runs(id) ON DELETE CASCADE,
                testcase_id INTEGER NOT NULL REFERENCES golden_testcases(id) ON DELETE CASCADE,
                answer_containment TEXT DEFAULT 'UNCHECKED', -- FULL | SPLIT | MISSING | UNCHECKED
                context_coverage REAL DEFAULT 0.0,
                root_cause_layer TEXT DEFAULT '', -- PARSING | CHUNKING | KEYWORD | VECTOR | RERANK | THRESHOLD | NONE
                root_cause_notes TEXT DEFAULT '',
                PRIMARY KEY (retrieval_run_id, testcase_id)
            );

            CREATE TABLE IF NOT EXISTS pipeline_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_run_id INTEGER NOT NULL,
                target_run_id INTEGER,
                target_dataset_id TEXT DEFAULT '',
                name TEXT NOT NULL,
                status TEXT DEFAULT 'queued', -- queued | running | completed | failed | cancelled
                current_stage TEXT DEFAULT 'queued',
                stage_progress_json TEXT DEFAULT '{}',
                config_json TEXT DEFAULT '{}',
                error_message TEXT DEFAULT '',
                total_duration_ms INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ai_advisor_reports (
                run_id INTEGER PRIMARY KEY,
                retrieval_run_id INTEGER,
                report_json TEXT NOT NULL,
                model_used TEXT DEFAULT '',
                duration_ms INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS auto_tune_reports (
                run_id INTEGER PRIMARY KEY,
                config_json TEXT DEFAULT '{}',
                result_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )

        # Default settings if empty
        now = utc_now()
        for k, v in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
                (k, v, now),
            )

        # Self-heal snapshots produced by older versions (orphan chunks -> parsing/chunking empty).
        repair_chunk_document_links(conn)

        # Ensure runs.account_key and runs.golden_source_run_id columns exist
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(runs)").fetchall()}
        if "account_key" not in cols:
            conn.execute("ALTER TABLE runs ADD COLUMN account_key TEXT DEFAULT ''")
        if "golden_source_run_id" not in cols:
            conn.execute("ALTER TABLE runs ADD COLUMN golden_source_run_id INTEGER DEFAULT 0")

        # Ensure parsing_units.judge_source and fidelity_error columns exist
        pu_cols = {r["name"] for r in conn.execute("PRAGMA table_info(parsing_units)").fetchall()}
        if "judge_source" not in pu_cols:
            conn.execute("ALTER TABLE parsing_units ADD COLUMN judge_source TEXT DEFAULT ''")
        if "fidelity_error" not in pu_cols:
            conn.execute("ALTER TABLE parsing_units ADD COLUMN fidelity_error INTEGER DEFAULT 0")

        # Ensure retrieval_runs judge performance tracking columns exist
        rr_cols = {r["name"] for r in conn.execute("PRAGMA table_info(retrieval_runs)").fetchall()}
        if "judge_engine" not in rr_cols:
            conn.execute("ALTER TABLE retrieval_runs ADD COLUMN judge_engine TEXT DEFAULT ''")
        if "judge_duration_ms" not in rr_cols:
            conn.execute("ALTER TABLE retrieval_runs ADD COLUMN judge_duration_ms INTEGER DEFAULT 0")
        if "judge_call_count" not in rr_cols:
            conn.execute("ALTER TABLE retrieval_runs ADD COLUMN judge_call_count INTEGER DEFAULT 0")
        if "judge_error_count" not in rr_cols:
            conn.execute("ALTER TABLE retrieval_runs ADD COLUMN judge_error_count INTEGER DEFAULT 0")
        if "is_baseline_rr" not in rr_cols:
            conn.execute("ALTER TABLE retrieval_runs ADD COLUMN is_baseline_rr INTEGER DEFAULT 0")

        # Ensure golden_testcases.account_key and per-dataset run_id with UNIQUE(run_id, tc_code)
        gt_cols = {r["name"] for r in conn.execute("PRAGMA table_info(golden_testcases)").fetchall()}
        if "account_key" not in gt_cols:
            conn.execute("ALTER TABLE golden_testcases ADD COLUMN account_key TEXT DEFAULT ''")
        if "run_id" not in gt_cols:
            conn.execute("PRAGMA foreign_keys = OFF;")
            conn.executescript(
                """
                CREATE TABLE golden_testcases_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id INTEGER DEFAULT 0,
                    tc_code TEXT NOT NULL,
                    input_question TEXT NOT NULL,
                    expected_outcome TEXT DEFAULT '',
                    reference_context TEXT NOT NULL,
                    source_file TEXT DEFAULT '',
                    question_class TEXT DEFAULT 'Local',
                    intent_type TEXT DEFAULT 'Factoid',
                    notes TEXT DEFAULT '',
                    account_key TEXT DEFAULT '',
                    created_at TEXT NOT NULL,
                    UNIQUE(run_id, tc_code)
                );
                INSERT INTO golden_testcases_new
                    (id, run_id, tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, notes, account_key, created_at)
                SELECT id, 0, tc_code, input_question, expected_outcome, reference_context, source_file, question_class, intent_type, notes, account_key, created_at
                FROM golden_testcases;
                DROP TABLE golden_testcases;
                ALTER TABLE golden_testcases_new RENAME TO golden_testcases;
                """
            )
            conn.execute("PRAGMA foreign_keys = ON;")

            # Backfill legacy global testcases (run_id = 0) to the baseline run so existing datasets keep them
            base_run = conn.execute(
                "SELECT id FROM runs ORDER BY is_baseline DESC, id ASC LIMIT 1"
            ).fetchone()
            if base_run:
                bid = int(base_run["id"])
                conn.execute("UPDATE golden_testcases SET run_id = ? WHERE run_id = 0", (bid,))
                # Any other run that already had retrieval_runs sharing those testcases links via golden_source_run_id
                conn.execute(
                    """
                    UPDATE runs SET golden_source_run_id = ?
                    WHERE id != ? AND golden_source_run_id = 0
                      AND EXISTS (SELECT 1 FROM retrieval_runs rr WHERE rr.run_id = runs.id)
                    """,
                    (bid, bid),
                )

        # Secondary indexes for hot QC queries & cascade deletes
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_chunks_run_doc_idx ON chunks(run_id, document_id, chunk_index);
            CREATE INDEX IF NOT EXISTS idx_chunks_run_rfdoc ON chunks(run_id, ragflow_doc_id);
            CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
            CREATE INDEX IF NOT EXISTS idx_parsing_units_run_doc ON parsing_units(run_id, document_id, unit_index);
            CREATE INDEX IF NOT EXISTS idx_parsing_units_run_verdict ON parsing_units(run_id, verdict);
            CREATE INDEX IF NOT EXISTS idx_chunk_evals_run_sampled ON chunk_evaluations(run_id, is_sampled);
            CREATE INDEX IF NOT EXISTS idx_chunk_evals_chunk ON chunk_evaluations(chunk_id);
            CREATE INDEX IF NOT EXISTS idx_run_docs_doc ON run_documents(document_id);
            CREATE INDEX IF NOT EXISTS idx_retrieval_runs_run ON retrieval_runs(run_id, is_baseline_rr, id);
            CREATE INDEX IF NOT EXISTS idx_retrieval_results_tc ON retrieval_results(testcase_id);
            CREATE INDEX IF NOT EXISTS idx_testcase_eval_meta_tc ON testcase_eval_meta(testcase_id);
            CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_src ON pipeline_jobs(source_run_id, id DESC);
            """
        )
    invalidate_settings_cache()


def resolve_golden_run_id(conn, run_id: int) -> int:
    """Returns the owning run_id for Golden testcases (cloned runs share their source run's Golden set)."""
    if not run_id:
        return 0
    row = conn.execute("SELECT golden_source_run_id FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row and row["golden_source_run_id"]:
        return int(row["golden_source_run_id"])
    return int(run_id)


DEFAULT_SETTINGS: dict[str, str] = {
    # Demo / Presentation Mode (100% read-only over saved runs)
    "demo_mode": "false",
    "demo_baseline_run_id": "21",
    "demo_candidate_run_id": "22",
    # Connection
    "ragflow_base_url": "http://13.236.9.207",
    "ragflow_api_key": "",
    "llm_base_url": "https://api.openai.com/v1",
    "llm_api_key": "",
    "llm_model": "gpt-4o-mini",
    "vision_base_url": "local",
    "vision_api_key": "",
    "vision_model": "local-rapidocr",
    # System One / Jev (Retrieval & Chunking Judge via Colab Kev, Vercel AI Gateway, or TypeSafe)
    "retrieval_judge_provider": "llm",
    "systemone_base_url": "https://ai-gateway.vercel.sh/typesafe",
    "systemone_api_key": "",
    "systemone_model": "typesafe-ai/jev",
    "systemone_threshold": "0.50",
    # Step 1: Workspace / Sync
    "slow_parse_threshold_sec": "180",
    # Step 2: Parsing
    "parsing_table_cell_match_threshold": "88",
    "target_text_completeness": "0.80",
    "target_table_accuracy": "0.75",
    "target_reading_order": "0.80",
    # Step 3: Chunking
    "chunking_judge_provider": "llm",
    "chunk_sample_mode": "adaptive",
    "chunk_sample_per_doc": "5",
    "chunk_sample_min": "5",
    "chunk_sample_max": "20",
    "chunk_sample_sqrt_k": "2.0",
    "min_chunk_chars": "50",
    "max_chunk_chars": "2600",
    "exempt_intact_table_from_max_chars": "true",
    "chunk_dup_threshold": "0.85",
    "chunk_adj_overlap_threshold": "88",
    "chunk_repeated_line_min": "3",
    "target_chunk_integrity": "0.80",
    "max_chunk_noise_rate": "0.15",
    "target_valid_size_rate": "0.85",
    # Step 4: Retrieval
    "default_top_k": "10",
    "default_similarity_threshold": "0.2",
    "default_vector_similarity_weight": "0.3",
    "default_rerank_id": "",
    "default_keyword_enabled": "true",
    "golden_gen_per_doc": "3",
    "target_contextual_precision": "0.65",
    "target_context_coverage": "0.70",
}


def get_current_account_key() -> str:
    base_url = get_setting("ragflow_base_url", "").strip().rstrip("/").lower()
    api_key = get_setting("ragflow_api_key", "").strip()
    if not base_url and not api_key:
        return ""
    return hashlib.sha256(f"{base_url}|{api_key}".encode("utf-8")).hexdigest()[:16]


def _load_settings_cached() -> dict[str, str]:
    global _SETTINGS_CACHE
    with _SETTINGS_LOCK:
        if _SETTINGS_CACHE is not None:
            return _SETTINGS_CACHE
    merged = dict(DEFAULT_SETTINGS)
    with get_db() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        for r in rows:
            merged[r["key"]] = r["value"]
    with _SETTINGS_LOCK:
        _SETTINGS_CACHE = merged
        return _SETTINGS_CACHE


def get_setting(key: str, default: str | None = None) -> str:
    data = _load_settings_cached()
    if key in data:
        return data[key]
    return DEFAULT_SETTINGS.get(key, "") if default is None else default


def get_int_setting(key: str, default: int | None = None) -> int:
    raw = get_setting(key)
    try:
        return int(float(raw))
    except (TypeError, ValueError):
        return default if default is not None else int(float(DEFAULT_SETTINGS.get(key, "0")))


def get_float_setting(key: str, default: float | None = None) -> float:
    raw = get_setting(key)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default if default is not None else float(DEFAULT_SETTINGS.get(key, "0"))


def get_bool_setting(key: str, default: bool | None = None) -> bool:
    raw = get_setting(key).strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    if default is not None:
        return default
    return DEFAULT_SETTINGS.get(key, "false").lower() == "true"


def get_all_settings() -> dict:
    return dict(_load_settings_cached())


def set_setting(key: str, value: str):
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (key, value, utc_now()),
        )
    with _SETTINGS_LOCK:
        if _SETTINGS_CACHE is not None:
            _SETTINGS_CACHE[key] = value
