import hashlib
import sqlite3
import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
DB_PATH = os.path.join(DATA_DIR, "ragflow_qc.db")

os.makedirs(UPLOAD_DIR, exist_ok=True)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
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
            """
        )

        # Default settings if empty
        defaults = {
            "ragflow_base_url": "http://13.236.9.207",
            "ragflow_api_key": "",
            "llm_base_url": "https://api.openai.com/v1",
            "llm_api_key": "",
            "llm_model": "gpt-4o-mini",
            "min_chunk_chars": "50",
            "max_chunk_chars": "2600",
        }
        now = utc_now()
        for k, v in defaults.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
                (k, v, now),
            )

        # Self-heal snapshots produced by older versions (orphan chunks -> parsing/chunking empty).
        repair_chunk_document_links(conn)

        # Ensure runs.account_key column exists so datasets are cleanly scoped per RAGFlow (base_url + api_key)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(runs)").fetchall()}
        if "account_key" not in cols:
            conn.execute("ALTER TABLE runs ADD COLUMN account_key TEXT DEFAULT ''")


def get_current_account_key() -> str:
    base_url = get_setting("ragflow_base_url", "").strip().rstrip("/").lower()
    api_key = get_setting("ragflow_api_key", "").strip()
    if not base_url and not api_key:
        return ""
    return hashlib.sha256(f"{base_url}|{api_key}".encode("utf-8")).hexdigest()[:16]


def get_setting(key: str, default: str = "") -> str:
    with get_db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default


def get_all_settings() -> dict:
    with get_db() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}


def set_setting(key: str, value: str):
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (key, value, utc_now()),
        )
