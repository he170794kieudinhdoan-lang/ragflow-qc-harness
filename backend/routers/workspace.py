import asyncio
import json
import os
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from database import UPLOAD_DIR, get_bool_setting, get_current_account_key, get_db, get_float_setting, get_setting, repair_chunk_document_links, utc_now
from ragflow_client import RAGFlowClient, RAGFlowError
from metrics import detect_chunk_rule_flags
from unit_sync import UNIT_SYNC_STATUS, ensure_units_for_document_async

router = APIRouter(prefix="/api/workspace", tags=["workspace"])


def _get_client() -> RAGFlowClient:
    base_url = get_setting("ragflow_base_url", "")
    api_key = get_setting("ragflow_api_key", "")
    if not base_url or not api_key:
        raise HTTPException(status_code=400, detail="Chưa cấu hình RAGFlow URL hoặc API Key trong Settings.")
    return RAGFlowClient(base_url, api_key)


class RunCreate(BaseModel):
    name: str
    description: str = ""
    is_baseline: bool = False
    ragflow_dataset_id: str = ""
    ragflow_dataset_name: str = ""
    create_remote_dataset: bool = False
    chunk_method: str = "naive"
    parser_config: Dict[str, Any] = {}
    retrieval_config: Dict[str, Any] = {
        "top_k": 10,
        "similarity_threshold": 0.2,
        "vector_similarity_weight": 0.3,
        "rerank_id": "",
    }


# ---------- Documents ----------
@router.get("/documents")
def list_documents(run_id: Optional[int] = None):
    with get_db() as conn:
        if run_id is not None:
            # Only documents belonging to this run, plus brand-new local uploads that were not
            # assigned to any run yet. Documents of other runs must never leak into this view,
            # otherwise "Đẩy & Parse" would push another dataset's files into this dataset.
            rows = conn.execute(
                """
                SELECT d.*
                FROM documents d
                WHERE EXISTS (
                        SELECT 1 FROM run_documents rd
                         WHERE rd.run_id = ? AND rd.document_id = d.id
                      )
                   OR (
                        d.file_path != ''
                        AND NOT EXISTS (
                            SELECT 1 FROM run_documents rd2 WHERE rd2.document_id = d.id
                        )
                      )
                ORDER BY d.doc_code
                """,
                (run_id,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM documents ORDER BY doc_code").fetchall()
        return [dict(r) for r in rows]


@router.post("/documents/upload")
async def upload_document(
    file: UploadFile = File(...),
    doc_code: str = Form(...),
    format_group: str = Form("PDF văn bản"),
    source_url: str = Form(""),
    has_tables: bool = Form(False),
    has_images: bool = Form(False),
    is_scan: bool = Form(False),
    notes: str = Form(""),
    run_id: int = Form(0),
):
    safe_name = os.path.basename(file.filename or f"{doc_code}.bin")
    content = await file.read()

    with get_db() as conn:
        effective_code = doc_code.strip()
        existing_by_code = conn.execute(
            "SELECT id, filename FROM documents WHERE doc_code = ?", (effective_code,)
        ).fetchone()
        if existing_by_code:
            # Never overwrite an existing document belonging to another run; allocate next free DOCxx
            belongs_other = conn.execute(
                "SELECT 1 FROM run_documents WHERE document_id = ? AND (? = 0 OR run_id != ?) LIMIT 1",
                (existing_by_code["id"], run_id, run_id),
            ).fetchone()
            if belongs_other or (existing_by_code["filename"] or "").lower() != safe_name.lower():
                existing_codes = {r["doc_code"] for r in conn.execute("SELECT doc_code FROM documents").fetchall()}
                idx = 1
                while f"DOC{idx:02d}" in existing_codes:
                    idx += 1
                effective_code = f"DOC{idx:02d}"

    save_path = os.path.join(UPLOAD_DIR, f"{effective_code}_{safe_name}")

    def _write_and_count_pdf() -> int:
        with open(save_path, "wb") as f:
            f.write(content)
        if safe_name.lower().endswith(".pdf"):
            try:
                import fitz
                with fitz.open(save_path) as doc:
                    return len(doc)
            except Exception:
                return 0
        return 0

    page_count = await asyncio.to_thread(_write_and_count_pdf)

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO documents (doc_code, filename, format_group, source_url, file_path, page_count, has_tables, has_images, is_scan, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(doc_code) DO UPDATE SET
                filename=excluded.filename,
                format_group=excluded.format_group,
                source_url=excluded.source_url,
                file_path=excluded.file_path,
                page_count=excluded.page_count,
                has_tables=excluded.has_tables,
                has_images=excluded.has_images,
                is_scan=excluded.is_scan,
                notes=excluded.notes
            """,
            (
                effective_code,
                safe_name,
                format_group,
                source_url,
                save_path,
                page_count,
                1 if has_tables else 0,
                1 if has_images else 0,
                1 if is_scan else 0,
                notes,
                utc_now(),
            ),
        )
        row = conn.execute("SELECT * FROM documents WHERE doc_code = ?", (effective_code,)).fetchone()
        if run_id:
            conn.execute(
                """
                INSERT INTO run_documents
                    (run_id, document_id, ragflow_doc_id, parse_status, progress, chunk_count,
                     token_count, parse_duration_sec, anomaly_flags, updated_at)
                VALUES (?, ?, '', 'UNSTART', 0, 0, 0, 0, '[]', ?)
                ON CONFLICT(run_id, document_id) DO NOTHING
                """,
                (run_id, row["id"], utc_now()),
            )
        return dict(row)


def _guess_format_group(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".pdf":
        return "PDF văn bản"
    if ext in (".docx", ".doc"):
        return "DOCX có bảng"
    if ext in (".html", ".htm", ".md", ".markdown"):
        return "Trang web (HTML / MD)"
    if ext in (".pptx", ".ppt", ".xlsx", ".xls", ".csv"):
        return "Slide / Excel"
    return "PDF scan / ảnh"


@router.post("/documents/upload-batch")
async def upload_documents_batch(
    files: List[UploadFile] = File(...),
    format_group: str = Form("AUTO"),
    run_id: int = Form(0),
):
    if not files:
        raise HTTPException(status_code=400, detail="Chưa chọn file nào để tải lên.")

    # 1. Allocate doc codes in a fast read transaction (never hold SQLite write lock across await file.read() / PDF parsing!)
    with get_db() as conn:
        existing_codes = {r["doc_code"] for r in conn.execute("SELECT doc_code FROM documents").fetchall()}

    staged = []
    next_idx = 1
    for file in files:
        safe_name = os.path.basename(file.filename or f"file_{next_idx}.bin")
        while f"DOC{next_idx:02d}" in existing_codes:
            next_idx += 1
        doc_code = f"DOC{next_idx:02d}"
        existing_codes.add(doc_code)
        next_idx += 1
        save_path = os.path.join(UPLOAD_DIR, f"{doc_code}_{safe_name}")
        content = await file.read()

        def _save_and_inspect(p: str, raw: bytes, name: str):
            with open(p, "wb") as f:
                f.write(raw)
            pg = 0
            scan = 0
            if name.lower().endswith(".pdf"):
                try:
                    import fitz
                    with fitz.open(p) as doc:
                        pg = len(doc)
                        total_text_len = sum(len(page.get_text().strip()) for page in doc)
                        if pg > 0 and (total_text_len / pg < 25 or "scan" in name.lower()):
                            scan = 1
                except Exception:
                    pg = 0
            return pg, scan

        page_count, is_scan = await asyncio.to_thread(_save_and_inspect, save_path, content, safe_name)
        grp = ("PDF scan / ảnh" if is_scan else _guess_format_group(safe_name)) if (not format_group or format_group == "AUTO") else format_group
        staged.append((doc_code, safe_name, grp, save_path, page_count, is_scan))

    # 2. Persist all metadata rows in a single fast SQLite transaction
    created = []
    now = utc_now()
    with get_db() as conn:
        for doc_code, safe_name, grp, save_path, page_count, is_scan in staged:
            conn.execute(
                """
                INSERT INTO documents (doc_code, filename, format_group, source_url, file_path, page_count, is_scan, created_at)
                VALUES (?, ?, ?, '', ?, ?, ?, ?)
                """,
                (doc_code, safe_name, grp, save_path, page_count, is_scan, now),
            )
            row = conn.execute("SELECT * FROM documents WHERE doc_code = ?", (doc_code,)).fetchone()
            if run_id:
                conn.execute(
                    """
                    INSERT INTO run_documents
                        (run_id, document_id, ragflow_doc_id, parse_status, progress, chunk_count,
                         token_count, parse_duration_sec, anomaly_flags, updated_at)
                    VALUES (?, ?, '', 'UNSTART', 0, 0, 0, 0, '[]', ?)
                    ON CONFLICT(run_id, document_id) DO NOTHING
                    """,
                    (run_id, row["id"], now),
                )
            created.append(dict(row))

    return {"ok": True, "uploaded_count": len(created), "documents": created}


@router.get("/documents/{doc_id}/file")
def open_document_file(doc_id: int):
    with get_db() as conn:
        doc = conn.execute("SELECT filename, file_path FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not doc or not doc["file_path"] or not os.path.exists(doc["file_path"]):
        raise HTTPException(status_code=404, detail="Không tìm thấy file gốc trên máy chủ local.")
    return FileResponse(
        path=doc["file_path"],
        filename=doc["filename"],
        content_disposition_type="inline",
    )


@router.delete("/documents/{doc_id}")
async def delete_document(
    doc_id: int,
    run_id: Optional[int] = None,
    delete_remote: bool = True,
):
    """
    Remove a document from ONE run (and delete it on RAGFlow Dataset when delete_remote=True and
    linked to a ragflow_doc_id). Chunks & parsing_units of that run are dropped cleanly, and the
    global document row is deleted when no other run still references it.
    """
    remote_deleted = False
    remote_warning = ""
    dataset_id = ""
    ragflow_doc_id = ""

    if delete_remote and run_id is not None and not get_bool_setting("demo_mode", False):
        with get_db() as conn:
            run_row = conn.execute(
                "SELECT ragflow_dataset_id FROM runs WHERE id = ?", (run_id,)
            ).fetchone()
            rd_row = conn.execute(
                "SELECT ragflow_doc_id FROM run_documents WHERE run_id = ? AND document_id = ?",
                (run_id, doc_id),
            ).fetchone()
            dataset_id = (run_row["ragflow_dataset_id"] if run_row else "") or ""
            ragflow_doc_id = (rd_row["ragflow_doc_id"] if rd_row else "") or ""

        if dataset_id and ragflow_doc_id:
            try:
                await _get_client().delete_documents(dataset_id, [ragflow_doc_id])
                remote_deleted = True
            except Exception as e:
                remote_warning = str(e)

    with get_db() as conn:
        if run_id is not None:
            conn.execute(
                "DELETE FROM run_documents WHERE run_id = ? AND document_id = ?",
                (run_id, doc_id),
            )
            conn.execute(
                "DELETE FROM chunks WHERE run_id = ? AND document_id = ?",
                (run_id, doc_id),
            )
            conn.execute(
                "DELETE FROM parsing_units WHERE run_id = ? AND document_id = ?",
                (run_id, doc_id),
            )
            conn.execute(
                "DELETE FROM baseline_advisor_reports WHERE run_id = ?",
                (run_id,),
            )
            still_linked = conn.execute(
                "SELECT COUNT(*) FROM run_documents WHERE document_id = ?", (doc_id,)
            ).fetchone()[0]
            still_chunked = conn.execute(
                "SELECT COUNT(*) FROM chunks WHERE document_id = ?", (doc_id,)
            ).fetchone()[0]
            if still_linked == 0 and still_chunked == 0:
                conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        else:
            conn.execute("DELETE FROM parsing_units WHERE document_id = ?", (doc_id,))
            conn.execute("DELETE FROM chunks WHERE document_id = ?", (doc_id,))
            conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    return {"ok": True, "remote_deleted": remote_deleted, "remote_warning": remote_warning}


@router.delete("/documents")
def clear_documents(synced_only: bool = False, run_id: Optional[int] = None):
    with get_db() as conn:
        if run_id is not None:
            conn.execute("DELETE FROM run_documents WHERE run_id = ?", (run_id,))
            conn.execute("DELETE FROM chunks WHERE run_id = ?", (run_id,))
            conn.execute("DELETE FROM parsing_units WHERE run_id = ?", (run_id,))
            conn.execute(
                """
                DELETE FROM documents
                WHERE id NOT IN (SELECT DISTINCT document_id FROM run_documents)
                  AND id NOT IN (SELECT DISTINCT document_id FROM chunks)
                """
            )
        elif synced_only:
            conn.execute(
                """
                DELETE FROM documents
                WHERE file_path = ''
                  AND id NOT IN (SELECT DISTINCT document_id FROM run_documents)
                """
            )
        else:
            conn.execute("DELETE FROM chunks")
            conn.execute("DELETE FROM documents")
    return {"ok": True}


# ---------- Runs / Experiments ----------
@router.get("/runs")
def list_runs():
    acct = get_current_account_key()
    with get_db() as conn:
        if acct:
            rows = conn.execute(
                "SELECT * FROM runs WHERE account_key = ? ORDER BY is_baseline DESC, id DESC",
                (acct,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM runs ORDER BY is_baseline DESC, id DESC").fetchall()
        chunk_counts = {
            r["run_id"]: r["cnt"]
            for r in conn.execute("SELECT run_id, COUNT(*) AS cnt FROM chunks GROUP BY run_id").fetchall()
        }
        doc_counts = {
            r["run_id"]: r["cnt"]
            for r in conn.execute("SELECT run_id, COUNT(*) AS cnt FROM run_documents GROUP BY run_id").fetchall()
        }
        out = []
        for r in rows:
            d = dict(r)
            d["parser_config"] = json.loads(d["parser_config"] or "{}")
            d["retrieval_config"] = json.loads(d["retrieval_config"] or "{}")
            d["chunk_count"] = chunk_counts.get(r["id"], 0)
            d["doc_count"] = doc_counts.get(r["id"], 0)
            out.append(d)
        return out


@router.post("/runs")
async def create_run(payload: RunCreate):
    base_name = payload.name.strip() or "Phiên mới"
    with get_db() as conn:
        existing_names = {r["name"] for r in conn.execute("SELECT name FROM runs").fetchall()}
    run_name = base_name
    suffix = 2
    while run_name in existing_names:
        run_name = f"{base_name} ({suffix})"
        suffix += 1

    dataset_id = payload.ragflow_dataset_id.strip()
    dataset_name = payload.ragflow_dataset_name.strip() or run_name

    if payload.create_remote_dataset:
        if get_bool_setting("demo_mode", False):
            import time as _time
            dataset_id = f"demo_ds_{int(_time.time())}"
        else:
            client = _get_client()
            try:
                ds = await client.create_dataset(
                    name=dataset_name,
                    chunk_method=payload.chunk_method,
                    parser_config=payload.parser_config or None,
                    description=payload.description,
                )
                dataset_id = ds.get("id", "")
                dataset_name = ds.get("name", dataset_name)
            except RAGFlowError as e:
                raise HTTPException(status_code=400, detail=f"Tạo dataset trên RAGFlow thất bại: {e}")

    acct = get_current_account_key()
    with get_db() as conn:
        if payload.is_baseline:
            conn.execute("UPDATE runs SET is_baseline = 0 WHERE account_key = ?", (acct,))
        try:
            cur = conn.execute(
                """
                INSERT INTO runs (name, description, is_baseline, ragflow_dataset_id, ragflow_dataset_name, parser_config, retrieval_config, status, account_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?)
                """,
                (
                    run_name,
                    payload.description,
                    1 if payload.is_baseline else 0,
                    dataset_id,
                    dataset_name,
                    json.dumps(payload.parser_config, ensure_ascii=False),
                    json.dumps(payload.retrieval_config, ensure_ascii=False),
                    acct,
                    utc_now(),
                ),
            )
            run_id = cur.lastrowid
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Tên run đã tồn tại hoặc lỗi dữ liệu: {e}")
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        return dict(row)


class RunParserConfigUpdate(BaseModel):
    chunk_method: str = "general"
    parser_config: Dict[str, Any] = {}
    pagerank: Optional[int] = None
    sync_remote: bool = True


@router.get("/runs/{run_id}/parser-config")
async def get_run_parser_config(run_id: int):
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")
        dataset_id = run["ragflow_dataset_id"] or ""
        local_cfg = json.loads(run["parser_config"] or "{}")

    remote_ds = None
    remote_error = ""
    if dataset_id:
        try:
            client = _get_client()
            remote_ds = await client.get_dataset(dataset_id)
        except Exception as e:
            remote_error = str(e)

    if remote_ds and isinstance(remote_ds.get("parser_config"), dict):
        pc = remote_ds["parser_config"]
        parser_id = remote_ds.get("parser_id") or remote_ds.get("chunk_method") or "general"
        pagerank = int(remote_ds.get("pagerank") or 0)
        embedding_model = remote_ds.get("embedding_model") or ""
        source = "ragflow"
    else:
        pc = local_cfg
        parser_id = local_cfg.get("chunk_method") or "general"
        pagerank = int(local_cfg.get("pagerank") or 0)
        embedding_model = ""
        source = "local"

    return {
        "ok": True,
        "source": source,
        "dataset_id": dataset_id,
        "parser_id": parser_id,
        "pagerank": pagerank,
        "embedding_model": embedding_model,
        "parser_config": pc,
        "remote_error": remote_error,
    }


@router.put("/runs/{run_id}/parser-config")
async def update_run_parser_config(run_id: int, payload: RunParserConfigUpdate):
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")
        dataset_id = run["ragflow_dataset_id"] or ""

    remote_cfg = dict(payload.parser_config or {})
    chunk_method = payload.chunk_method or "general"

    remote_synced = False
    remote_warning = ""
    if payload.sync_remote and dataset_id:
        try:
            client = _get_client()
            await client.update_dataset(
                dataset_id=dataset_id,
                chunk_method=chunk_method,
                parser_config=remote_cfg,
                pagerank=payload.pagerank,
            )
            remote_synced = True
        except Exception as e:
            remote_warning = str(e)

    stored_cfg = dict(remote_cfg)
    stored_cfg["chunk_method"] = chunk_method
    if payload.pagerank is not None:
        stored_cfg["pagerank"] = payload.pagerank

    with get_db() as conn:
        conn.execute(
            "UPDATE runs SET parser_config = ? WHERE id = ?",
            (json.dumps(stored_cfg, ensure_ascii=False), run_id),
        )
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        out = dict(row)
        out["parser_config"] = stored_cfg
        out["retrieval_config"] = json.loads(out["retrieval_config"] or "{}")

    return {
        "ok": True,
        "run": out,
        "remote_synced": remote_synced,
        "remote_warning": remote_warning,
    }


@router.post("/runs/sync-datasets")
async def sync_datasets_from_ragflow():
    """
    Reconcile local runs list against live RAGFlow Datasets:
    - Prunes local runs whose ragflow_dataset_id no longer exists on RAGFlow.
    - Adds any RAGFlow Dataset not yet tracked locally (with its live parser_config).
    - Keeps local dataset names synced with RAGFlow.
    """
    if get_bool_setting("demo_mode", False):
        await asyncio.sleep(0.4)
        with get_db() as conn:
            cnt = conn.execute("SELECT COUNT(*) FROM runs WHERE account_key = '__demo__'").fetchone()[0]
        return {"ok": True, "total_remote": cnt, "added": 0, "removed": 0, "updated": 0, "demo": True}

    client = _get_client()
    remote_datasets = await client.list_datasets(page=1, page_size=100)
    remote_by_id = {
        str(ds.get("id")): ds
        for ds in (remote_datasets or [])
        if isinstance(ds, dict) and ds.get("id")
    }
    acct = get_current_account_key()
    now = utc_now()

    added = 0
    removed = 0
    updated = 0

    with get_db() as conn:
        local_runs = conn.execute(
            "SELECT * FROM runs WHERE (account_key = ? OR account_key = '')",
            (acct,),
        ).fetchall()

        existing_by_ds: Dict[str, Any] = {}
        for r in local_runs:
            ds_id = (r["ragflow_dataset_id"] or "").strip()
            if not ds_id:
                continue
            if ds_id not in remote_by_id:
                rid = r["id"]
                conn.execute("DELETE FROM ai_advisor_reports WHERE run_id = ?", (rid,))
                conn.execute("DELETE FROM auto_tune_reports WHERE run_id = ?", (rid,))
                conn.execute("DELETE FROM baseline_advisor_reports WHERE run_id = ?", (rid,))
                conn.execute("DELETE FROM pipeline_jobs WHERE source_run_id = ? OR target_run_id = ?", (rid, rid))
                conn.execute("DELETE FROM run_documents WHERE run_id = ?", (rid,))
                conn.execute("DELETE FROM chunks WHERE run_id = ?", (rid,))
                conn.execute("DELETE FROM parsing_units WHERE run_id = ?", (rid,))
                conn.execute("DELETE FROM runs WHERE id = ?", (rid,))
                removed += 1
            else:
                existing_by_ds[ds_id] = r
                remote_name = str(remote_by_id[ds_id].get("name") or r["name"])
                if remote_name != (r["ragflow_dataset_name"] or ""):
                    conn.execute(
                        "UPDATE runs SET ragflow_dataset_name = ? WHERE id = ?",
                        (remote_name, r["id"]),
                    )
                    updated += 1

        # Clean up orphaned documents no longer linked to any run or chunk
        if removed > 0:
            conn.execute(
                """
                DELETE FROM documents
                WHERE id NOT IN (SELECT DISTINCT document_id FROM run_documents)
                  AND id NOT IN (SELECT DISTINCT document_id FROM chunks WHERE document_id IS NOT NULL)
                """
            )

        existing_names = {
            row["name"] for row in conn.execute("SELECT name FROM runs").fetchall()
        }
        for ds_id, ds in remote_by_id.items():
            if ds_id in existing_by_ds:
                continue
            base_name = str(ds.get("name") or f"Dataset {ds_id[:8]}").strip()
            run_name = base_name
            suffix = 2
            while run_name in existing_names:
                run_name = f"{base_name} ({suffix})"
                suffix += 1
            existing_names.add(run_name)

            pc = ds.get("parser_config") if isinstance(ds.get("parser_config"), dict) else {}
            pc_store = dict(pc)
            if ds.get("parser_id") or ds.get("chunk_method"):
                pc_store["chunk_method"] = ds.get("parser_id") or ds.get("chunk_method")
            conn.execute(
                """
                INSERT INTO runs (name, description, is_baseline, ragflow_dataset_id, ragflow_dataset_name, parser_config, retrieval_config, status, account_key, created_at)
                VALUES (?, '', 0, ?, ?, ?, '{}', 'READY', ?, ?)
                """,
                (
                    run_name,
                    ds_id,
                    base_name,
                    json.dumps(pc_store, ensure_ascii=False),
                    acct,
                    now,
                ),
            )
            added += 1

    return {
        "ok": True,
        "total_remote": len(remote_by_id),
        "added": added,
        "removed": removed,
        "updated": updated,
    }


@router.delete("/runs/{run_id}")
def delete_run(run_id: int):
    with get_db() as conn:
        # Preserve Golden testcases if surviving cloned runs still share this run as their golden_source_run_id
        clones = conn.execute(
            "SELECT id FROM runs WHERE golden_source_run_id = ? AND id != ? ORDER BY id ASC",
            (run_id, run_id),
        ).fetchall()
        if clones:
            new_owner = clones[0]["id"]
            conn.execute("UPDATE golden_testcases SET run_id = ? WHERE run_id = ?", (new_owner, run_id))
            conn.execute("UPDATE runs SET golden_source_run_id = NULL WHERE id = ?", (new_owner,))
            conn.execute("UPDATE runs SET golden_source_run_id = ? WHERE golden_source_run_id = ?", (new_owner, run_id))
        else:
            conn.execute("DELETE FROM golden_testcases WHERE run_id = ?", (run_id,))

        conn.execute("DELETE FROM ai_advisor_reports WHERE run_id = ?", (run_id,))
        conn.execute("DELETE FROM auto_tune_reports WHERE run_id = ?", (run_id,))
        conn.execute("DELETE FROM baseline_advisor_reports WHERE run_id = ?", (run_id,))
        conn.execute("DELETE FROM pipeline_jobs WHERE source_run_id = ? OR target_run_id = ?", (run_id, run_id))
        conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
        conn.execute(
            """
            DELETE FROM documents
            WHERE file_path = ''
              AND id NOT IN (SELECT DISTINCT document_id FROM run_documents)
            """
        )
    try:
        from unit_sync import UNIT_SYNC_STATUS
        UNIT_SYNC_STATUS.pop(run_id, None)
    except Exception:
        pass
    try:
        from routers.parsing import clear_alignment_cache
        clear_alignment_cache()
    except Exception:
        pass
    return {"ok": True}


@router.get("/runs/{run_id}/documents")
def get_run_documents(run_id: int):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT rd.*, d.doc_code, d.filename, d.format_group, d.page_count
            FROM run_documents rd
            JOIN documents d ON d.id = rd.document_id
            WHERE rd.run_id = ?
            ORDER BY d.doc_code
            """,
            (run_id,),
        ).fetchall()
        res = []
        for r in rows:
            item = dict(r)
            item["anomaly_flags"] = json.loads(item["anomaly_flags"] or "[]")
            res.append(item)
        return res


STATUS_MAP = {
    "0": "UNSTART",
    "1": "RUNNING",
    "2": "CANCEL",
    "3": "DONE",
    "4": "FAIL",
    "SUCCESS": "DONE",
    "COMPLETED": "DONE",
    "FAILED": "FAIL",
    "PENDING": "RUNNING",
    "QUEUED": "RUNNING",
    "SCHEDULED": "RUNNING",
    "IN_PROGRESS": "RUNNING",
    "PROCESSING": "RUNNING",
    "PARSING": "RUNNING",
}


def _extract_remote_doc_meta(rdoc: Dict[str, Any]) -> Dict[str, Any]:
    raw_status = rdoc.get("ingestion_status") or rdoc.get("run") or "UNSTART"
    r_status = STATUS_MAP.get(str(raw_status).upper(), str(raw_status).upper())
    r_progress = float(rdoc.get("progress", 0) or 0)
    if r_progress > 1.0:
        r_progress = r_progress / 100.0
    r_chunk_cnt = int(rdoc.get("chunk_count", 0) or 0)
    r_token_cnt = int(rdoc.get("token_count", 0) or 0)
    r_dur = float(rdoc.get("process_duration", 0) or 0)
    if r_chunk_cnt > 0 and r_status not in ("RUNNING", "FAIL"):
        r_status = "DONE"

    err_msg = ""
    evt = rdoc.get("latest_ingestion_event")
    if isinstance(evt, dict) and evt.get("message"):
        err_msg = str(evt.get("message", "")).strip()
    elif rdoc.get("progress_msg"):
        err_msg = str(rdoc.get("progress_msg", "")).strip()

    return {
        "ragflow_doc_id": rdoc.get("id", ""),
        "name": rdoc.get("name", f"doc_{str(rdoc.get('id', ''))[:6]}"),
        "status": r_status,
        "progress": r_progress,
        "chunk_count": r_chunk_cnt,
        "token_count": r_token_cnt,
        "duration": r_dur,
        "error_msg": err_msg if r_status == "FAIL" else "",
    }


@router.get("/runs/{run_id}/parse-status")
async def get_run_parse_status(run_id: int):
    """
    Lightweight polling endpoint: queries RAGFlow list_documents (no chunks),
    updates run_documents status/progress/chunk_count, and returns live progress + errors.
    """
    client = _get_client()
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")
        dataset_id = run["ragflow_dataset_id"]
        if not dataset_id:
            raise HTTPException(status_code=400, detail="Run này chưa gắn RAGFlow Dataset ID")

    try:
        remote_docs = await client.list_documents(dataset_id, page=1, page_size=100)
    except RAGFlowError as e:
        raise HTTPException(status_code=400, detail=f"Lỗi kiểm tra tiến độ từ RAGFlow: {e}")

    errors: Dict[int, str] = {}
    counts = {"total": 0, "done": 0, "running": 0, "failed": 0, "unstart": 0}

    with get_db() as conn:
        existing_docs = conn.execute("SELECT * FROM documents").fetchall()
        by_filename = {d["filename"].lower(): d for d in existing_docs}
        used_codes = {d["doc_code"] for d in existing_docs}
        next_idx = 1

        for rdoc in remote_docs:
            meta = _extract_remote_doc_meta(rdoc)
            r_name = meta["name"]
            r_status = meta["status"]

            local_doc = by_filename.get(r_name.lower())
            if not local_doc:
                ext = os.path.splitext(r_name)[1].lower()
                fmt_group = (
                    "PDF văn bản" if ext == ".pdf"
                    else "DOCX có bảng" if ext in (".docx", ".doc")
                    else "Trang web (HTML / MD)" if ext in (".html", ".htm", ".md")
                    else "Slide / Excel" if ext in (".pptx", ".ppt", ".xlsx", ".xls", ".csv")
                    else "PDF scan / ảnh"
                )
                while f"DOC{next_idx:02d}" in used_codes:
                    next_idx += 1
                doc_code = f"DOC{next_idx:02d}"
                used_codes.add(doc_code)
                next_idx += 1
                cur = conn.execute(
                    "INSERT INTO documents (doc_code, filename, format_group, created_at) VALUES (?, ?, ?, ?)",
                    (doc_code, r_name, fmt_group, utc_now()),
                )
                local_doc_id = cur.lastrowid
                local_doc = conn.execute("SELECT * FROM documents WHERE id = ?", (local_doc_id,)).fetchone()
                by_filename[r_name.lower()] = local_doc
            else:
                local_doc_id = local_doc["id"]

            slow_threshold = get_float_setting("slow_parse_threshold_sec", 180.0)
            anomalies = []
            if r_status == "FAIL":
                anomalies.append("PARSE_FAILED")
            if r_status == "DONE" and meta["chunk_count"] == 0:
                anomalies.append("ZERO_CHUNKS")
            if slow_threshold > 0 and meta["duration"] > slow_threshold:
                anomalies.append("SLOW_PARSE")

            conn.execute(
                """
                INSERT INTO run_documents (run_id, document_id, ragflow_doc_id, parse_status, progress, chunk_count, token_count, parse_duration_sec, anomaly_flags, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, document_id) DO UPDATE SET
                    ragflow_doc_id=excluded.ragflow_doc_id,
                    parse_status=excluded.parse_status,
                    progress=excluded.progress,
                    chunk_count=excluded.chunk_count,
                    token_count=excluded.token_count,
                    parse_duration_sec=excluded.parse_duration_sec,
                    anomaly_flags=excluded.anomaly_flags,
                    updated_at=excluded.updated_at
                """,
                (
                    run_id, local_doc_id, meta["ragflow_doc_id"], r_status, meta["progress"],
                    meta["chunk_count"], meta["token_count"], meta["duration"], json.dumps(anomalies), utc_now(),
                ),
            )

            counts["total"] += 1
            if r_status == "DONE":
                counts["done"] += 1
            elif r_status == "RUNNING":
                counts["running"] += 1
            elif r_status == "FAIL":
                counts["failed"] += 1
                if meta["error_msg"]:
                    errors[local_doc_id] = meta["error_msg"]
            else:
                counts["unstart"] += 1

        rows = conn.execute(
            """
            SELECT rd.*, d.doc_code, d.filename, d.format_group, d.page_count
            FROM run_documents rd
            JOIN documents d ON d.id = rd.document_id
            WHERE rd.run_id = ?
            ORDER BY d.doc_code
            """,
            (run_id,),
        ).fetchall()
        docs_out = []
        for r in rows:
            item = dict(r)
            item["anomaly_flags"] = json.loads(item["anomaly_flags"] or "[]")
            docs_out.append(item)

    return {
        "ok": True,
        "is_parsing": counts["running"] > 0,
        "counts": counts,
        "documents": docs_out,
        "errors": errors,
    }


async def _bg_ensure_units(
    run_id: int,
    dataset_id: str,
    client: RAGFlowClient,
    docs_for_units: List[tuple],
) -> None:
    """Offloads heavy pdfplumber/PyMuPDF + RapidFuzz alignment in parallel worker threads."""
    import logging

    logger = logging.getLogger(__name__)
    if not docs_for_units:
        UNIT_SYNC_STATUS[run_id] = {"running": False, "done": 0, "total": 0}
        return

    UNIT_SYNC_STATUS[run_id] = {"running": True, "done": 0, "total": len(docs_for_units)}
    sem = asyncio.Semaphore(4)

    async def _run_one(item: tuple) -> None:
        local_doc_id, r_doc_id, doc_code, r_name, existing_fp = item
        async with sem:
            try:
                await ensure_units_for_document_async(
                    run_id,
                    local_doc_id,
                    r_doc_id,
                    doc_code,
                    r_name,
                    existing_fp,
                    client=client,
                    dataset_id=dataset_id,
                )
            except Exception as e:
                logger.warning("_bg_ensure_units failed for %s (%s): %s", doc_code, r_name, e)
            finally:
                st = UNIT_SYNC_STATUS.get(run_id)
                if st:
                    st["done"] = int(st.get("done", 0)) + 1

    try:
        await asyncio.gather(*(_run_one(item) for item in docs_for_units))
    finally:
        st = UNIT_SYNC_STATUS.get(run_id)
        if st:
            st["running"] = False


@router.post("/runs/{run_id}/sync-from-ragflow")
async def sync_run_from_ragflow(
    run_id: int,
    background_tasks: BackgroundTasks,
    pull_chunks: bool = True,
    force: bool = False,
):
    """
    Pulls the document list and (optionally) the chunk snapshot of the linked RAGFlow dataset.

    Consistency rules:
    - Documents are matched by filename and registered once per run (run_documents).
    - Chunks are only re-downloaded when the remote chunk_count changed (or force=true), so a
      normal sync is cheap and does not wipe manual state.
    - Chunk rows are re-linked to their local document on every upsert, which repairs snapshots
      where an old document deletion had set chunks.document_id = NULL.
    - Existing parsing units are re-aligned against the fresh chunks (verdicts are preserved).
    """
    if get_bool_setting("demo_mode", False):
        await asyncio.sleep(1.4)
        from demo_cloner import ensure_demo_sync
        doc_cnt, chunk_cnt = ensure_demo_sync(run_id)
        return {
            "ok": True,
            "run_id": run_id,
            "synced_documents": doc_cnt,
            "synced_chunks": chunk_cnt,
            "documents_synced": doc_cnt,
            "chunks_synced": chunk_cnt,
            "demo": True,
        }

    client = _get_client()
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")
        dataset_id = run["ragflow_dataset_id"]
        if not dataset_id:
            raise HTTPException(status_code=400, detail="Run này chưa gắn RAGFlow Dataset ID")
        existing_docs = [dict(d) for d in conn.execute("SELECT * FROM documents").fetchall()]
        local_chunk_counts = {
            r["ragflow_doc_id"]: r["n"]
            for r in conn.execute(
                "SELECT ragflow_doc_id, COUNT(*) AS n FROM chunks WHERE run_id = ? GROUP BY ragflow_doc_id",
                (run_id,),
            ).fetchall()
        }

    try:
        remote_docs = await client.list_documents(dataset_id, page=1, page_size=100)
    except RAGFlowError as e:
        raise HTTPException(status_code=400, detail=f"Lỗi lấy danh sách tài liệu từ RAGFlow: {e}")

    min_chars = int(get_setting("min_chunk_chars", "50") or "50")
    max_chars = int(get_setting("max_chunk_chars", "2600") or "2600")
    exempt_intact_table = get_bool_setting("exempt_intact_table_from_max_chars", True)

    # ---- Phase 1: map every remote document to a local document row (no DB writes yet) ----
    by_filename = {d["filename"].lower(): d for d in existing_docs}
    used_codes = {d["doc_code"] for d in existing_docs}
    next_idx = 1
    plan: List[tuple] = []

    for rdoc in remote_docs:
        meta = _extract_remote_doc_meta(rdoc)
        r_name = meta["name"]
        local_doc = by_filename.get(r_name.lower())
        if not local_doc:
            ext = os.path.splitext(r_name)[1].lower()
            fmt_group = (
                "PDF scan / ảnh" if (ext == ".pdf" and "scan" in r_name.lower())
                else "PDF văn bản" if ext == ".pdf"
                else "DOCX có bảng" if ext in (".docx", ".doc")
                else "Trang web (HTML / MD)" if ext in (".html", ".htm", ".md")
                else "Slide / Excel" if ext in (".pptx", ".ppt", ".xlsx", ".xls", ".csv")
                else "PDF scan / ảnh"
            )
            while f"DOC{next_idx:02d}" in used_codes:
                next_idx += 1
            doc_code = f"DOC{next_idx:02d}"
            used_codes.add(doc_code)
            next_idx += 1
            local_doc = {
                "id": None,
                "doc_code": doc_code,
                "filename": r_name,
                "format_group": fmt_group,
                "file_path": "",
                "page_count": 0,
            }
            by_filename[r_name.lower()] = local_doc
        plan.append((meta, local_doc))

    # ---- Phase 2: parallel network I/O outside the SQLite write transaction ----
    chunk_payloads: Dict[str, List[Dict[str, Any]]] = {}
    failed_docs: List[Dict[str, str]] = []
    sem = asyncio.Semaphore(5)

    async def _fetch_doc_chunks(meta: Dict[str, Any]) -> None:
        r_doc_id = meta["ragflow_doc_id"]
        async with sem:
            try:
                chunk_payloads[r_doc_id] = await client.list_all_chunks(dataset_id, r_doc_id)
            except Exception as e:  # network / API error must be visible, never silently ignored
                failed_docs.append({"name": meta["name"], "error": str(e)[:300]})

    to_fetch = [
        meta
        for meta, _local in plan
        if (
            pull_chunks
            and meta["status"] == "DONE"
            and (force or local_chunk_counts.get(meta["ragflow_doc_id"], 0) != meta["chunk_count"])
        )
    ]
    if to_fetch:
        await asyncio.gather(*(_fetch_doc_chunks(m) for m in to_fetch))

    # ---- Phase 3: single write transaction ----
    synced_docs = 0
    synced_chunks = 0
    skipped_chunk_docs = 0
    docs_for_units: List[tuple] = []
    now = utc_now()

    with get_db() as conn:
        for meta, local_doc in plan:
            r_doc_id = meta["ragflow_doc_id"]
            r_name = meta["name"]
            local_doc_id = local_doc.get("id")

            if local_doc_id is None:
                cur = conn.execute(
                    """
                    INSERT INTO documents (doc_code, filename, format_group, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (local_doc["doc_code"], r_name, local_doc["format_group"], now),
                )
                local_doc_id = cur.lastrowid
                local_doc["id"] = local_doc_id

            slow_threshold = get_float_setting("slow_parse_threshold_sec", 180.0)
            anomalies = []
            if meta["status"] == "FAIL":
                anomalies.append("PARSE_FAILED")
            if meta["status"] == "DONE" and meta["chunk_count"] == 0:
                anomalies.append("ZERO_CHUNKS")
            if slow_threshold > 0 and meta["duration"] > slow_threshold:
                anomalies.append("SLOW_PARSE")

            conn.execute(
                """
                INSERT INTO run_documents (run_id, document_id, ragflow_doc_id, parse_status, progress, chunk_count, token_count, parse_duration_sec, anomaly_flags, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, document_id) DO UPDATE SET
                    ragflow_doc_id=excluded.ragflow_doc_id,
                    parse_status=excluded.parse_status,
                    progress=excluded.progress,
                    chunk_count=excluded.chunk_count,
                    token_count=excluded.token_count,
                    parse_duration_sec=excluded.parse_duration_sec,
                    anomaly_flags=excluded.anomaly_flags,
                    updated_at=excluded.updated_at
                """,
                (
                    run_id, local_doc_id, r_doc_id, meta["status"], meta["progress"],
                    meta["chunk_count"], meta["token_count"], meta["duration"],
                    json.dumps(anomalies), now,
                ),
            )
            synced_docs += 1

            remote_chunks = chunk_payloads.get(r_doc_id)
            if remote_chunks is None:
                if pull_chunks and meta["status"] == "DONE":
                    skipped_chunk_docs += 1
                docs_for_units.append(
                    (local_doc_id, r_doc_id, local_doc["doc_code"], r_name, local_doc.get("file_path") or "")
                )
                continue

            remote_ids: List[str] = []
            for idx_c, ch in enumerate(remote_chunks, start=1):
                cid = ch.get("id") or ch.get("chunk_id") or f"{r_doc_id}_{idx_c}"
                content = ch.get("content") or ch.get("content_with_weight") or ""
                flags = detect_chunk_rule_flags(
                    content, min_chars=min_chars, max_chars=max_chars, exempt_intact_table=exempt_intact_table
                )
                positions = ch.get("positions", []) or []
                page_num = 0
                if positions and isinstance(positions[0], list) and len(positions[0]) > 0:
                    try:
                        page_num = int(positions[0][0])
                    except Exception:
                        page_num = 0
                remote_ids.append(cid)
                conn.execute(
                    """
                    INSERT INTO chunks (run_id, document_id, ragflow_doc_id, ragflow_chunk_id, chunk_index, content, char_count, token_est, page_num, positions, important_keywords, available, rule_flags)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(run_id, ragflow_chunk_id) DO UPDATE SET
                        document_id=excluded.document_id,
                        ragflow_doc_id=excluded.ragflow_doc_id,
                        chunk_index=excluded.chunk_index,
                        content=excluded.content,
                        char_count=excluded.char_count,
                        token_est=excluded.token_est,
                        page_num=excluded.page_num,
                        positions=excluded.positions,
                        important_keywords=excluded.important_keywords,
                        available=excluded.available,
                        rule_flags=excluded.rule_flags
                    """,
                    (
                        run_id,
                        local_doc_id,
                        r_doc_id,
                        cid,
                        idx_c,
                        content,
                        len(content),
                        max(1, len(content) // 4),
                        page_num,
                        json.dumps(positions),
                        json.dumps(ch.get("important_keywords", []) or [], ensure_ascii=False),
                        1 if ch.get("available", True) else 0,
                        json.dumps(flags),
                    ),
                )
                synced_chunks += 1

            # Drop chunks that no longer exist on RAGFlow (re-parse / re-chunk), so counts match.
            if remote_ids:
                placeholders = ",".join("?" for _ in remote_ids)
                conn.execute(
                    f"DELETE FROM chunks WHERE run_id = ? AND ragflow_doc_id = ? AND ragflow_chunk_id NOT IN ({placeholders})",
                    [run_id, r_doc_id, *remote_ids],
                )
            else:
                conn.execute(
                    "DELETE FROM chunks WHERE run_id = ? AND ragflow_doc_id = ?",
                    (run_id, r_doc_id),
                )

            docs_for_units.append(
                (local_doc_id, r_doc_id, local_doc["doc_code"], r_name, local_doc.get("file_path") or "")
            )

        # Prune documents that were deleted on RAGFlow (only rows already linked to a ragflow_doc_id,
        # preserving newly uploaded local-only files waiting to be pushed).
        active_remote_doc_ids = [meta["ragflow_doc_id"] for meta, _local in plan if meta.get("ragflow_doc_id")]
        removed_docs = 0
        if active_remote_doc_ids:
            ph = ",".join("?" for _ in active_remote_doc_ids)
            conn.execute(
                f"DELETE FROM chunks WHERE run_id = ? AND ragflow_doc_id IS NOT NULL AND ragflow_doc_id != '' AND ragflow_doc_id NOT IN ({ph})",
                [run_id, *active_remote_doc_ids],
            )
            cur_rm = conn.execute(
                f"DELETE FROM run_documents WHERE run_id = ? AND ragflow_doc_id IS NOT NULL AND ragflow_doc_id != '' AND ragflow_doc_id NOT IN ({ph})",
                [run_id, *active_remote_doc_ids],
            )
            removed_docs = cur_rm.rowcount or 0
        else:
            conn.execute(
                "DELETE FROM chunks WHERE run_id = ? AND ragflow_doc_id IS NOT NULL AND ragflow_doc_id != ''",
                (run_id,),
            )
            cur_rm = conn.execute(
                "DELETE FROM run_documents WHERE run_id = ? AND ragflow_doc_id IS NOT NULL AND ragflow_doc_id != ''",
                (run_id,),
            )
            removed_docs = cur_rm.rowcount or 0

        # Legacy repair: chunks whose document row was deleted in an older version.
        repair_chunk_document_links(conn)
        conn.execute("UPDATE runs SET status = 'SYNCED' WHERE id = ?", (run_id,))

    # ---- Phase 4: offload ground-truth unit extraction/alignment to background ----
    if docs_for_units:
        background_tasks.add_task(_bg_ensure_units, run_id, dataset_id, client, docs_for_units)

    return {
        "ok": True,
        "synced_documents": synced_docs,
        "removed_documents": removed_docs,
        "synced_chunks": synced_chunks,
        "auto_extracted_units": 0,
        "realigned_units": 0,
        "units_syncing_in_background": bool(docs_for_units),
        "skipped_chunk_documents": skipped_chunk_docs,
        "failed_documents": failed_docs,
    }


@router.post("/runs/{run_id}/documents/{doc_id}/parse")
async def parse_single_document(run_id: int, doc_id: int):
    """Triggers parsing for a single document on RAGFlow (mirrors RAGFlow per-file Play button)."""
    client = _get_client()
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run or not run["ragflow_dataset_id"]:
            raise HTTPException(status_code=400, detail="Run chưa gắn RAGFlow Dataset ID")
        dataset_id = run["ragflow_dataset_id"]
        doc = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if not doc:
            raise HTTPException(status_code=404, detail="Tài liệu không tồn tại")
        rd = conn.execute(
            "SELECT * FROM run_documents WHERE run_id = ? AND document_id = ?",
            (run_id, doc_id),
        ).fetchone()

    ragflow_doc_id = rd["ragflow_doc_id"] if (rd and rd["ragflow_doc_id"]) else ""
    if not ragflow_doc_id:
        if not doc["file_path"] or not os.path.exists(doc["file_path"]):
            raise HTTPException(status_code=400, detail="Không tìm thấy file gốc local để đẩy lên RAGFlow.")
        with open(doc["file_path"], "rb") as f:
            b = f.read()
        res = await client.upload_document(dataset_id, doc["filename"], b)
        if isinstance(res, list) and res and res[0].get("id"):
            ragflow_doc_id = res[0]["id"]
        elif isinstance(res, dict) and res.get("id"):
            ragflow_doc_id = res["id"]
        else:
            raise HTTPException(status_code=400, detail="Upload file lên RAGFlow thất bại.")

    await client.parse_documents(dataset_id, [ragflow_doc_id])
    now = utc_now()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO run_documents (run_id, document_id, ragflow_doc_id, parse_status, progress, chunk_count, token_count, parse_duration_sec, anomaly_flags, updated_at)
            VALUES (?, ?, ?, 'RUNNING', 0, 0, 0, 0, '[]', ?)
            ON CONFLICT(run_id, document_id) DO UPDATE SET
                ragflow_doc_id=excluded.ragflow_doc_id,
                parse_status='RUNNING',
                progress=0,
                updated_at=excluded.updated_at
            """,
            (run_id, doc_id, ragflow_doc_id, now),
        )
    return {"ok": True, "ragflow_doc_id": ragflow_doc_id}


@router.post("/runs/{run_id}/upload-and-parse")
async def upload_local_docs_and_parse(run_id: int):
    """Uploads all local documents that have file_path to the linked RAGFlow dataset and triggers parsing."""
    client = _get_client()
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run or not run["ragflow_dataset_id"]:
            raise HTTPException(status_code=400, detail="Run chưa gắn RAGFlow Dataset ID")
        dataset_id = run["ragflow_dataset_id"]
        docs = conn.execute(
            """
            SELECT d.*, COALESCE(rd.ragflow_doc_id, '') AS linked_ragflow_doc_id
            FROM documents d
            LEFT JOIN run_documents rd ON rd.document_id = d.id AND rd.run_id = ?
            WHERE d.file_path != ''
              AND (
                    (rd.id IS NOT NULL AND (rd.ragflow_doc_id = '' OR rd.parse_status = 'FAIL'))
                 OR (rd.id IS NULL AND NOT EXISTS (SELECT 1 FROM run_documents rd2 WHERE rd2.document_id = d.id))
              )
            ORDER BY d.doc_code
            """,
            (run_id,),
        ).fetchall()

    uploaded_ids: List[str] = []
    uploaded_pairs: List[tuple] = []
    for d in docs:
        if not os.path.exists(d["file_path"]):
            continue
        with open(d["file_path"], "rb") as f:
            b = f.read()
        res = await client.upload_document(dataset_id, d["filename"], b)
        if isinstance(res, list):
            for item in res:
                if item.get("id"):
                    uploaded_ids.append(item["id"])
                    uploaded_pairs.append((d["id"], item["id"]))
        elif isinstance(res, dict) and res.get("id"):
            uploaded_ids.append(res["id"])
            uploaded_pairs.append((d["id"], res["id"]))

    if uploaded_ids:
        await client.parse_documents(dataset_id, uploaded_ids)
        now = utc_now()
        with get_db() as conn:
            for local_doc_id, r_doc_id in uploaded_pairs:
                # A re-upload produces a new RAGFlow document id: drop the old snapshot so the
                # next sync does not mix chunks from both versions.
                conn.execute(
                    "DELETE FROM chunks WHERE run_id = ? AND document_id = ?",
                    (run_id, local_doc_id),
                )
                conn.execute(
                    """
                    INSERT INTO run_documents (run_id, document_id, ragflow_doc_id, parse_status, progress, chunk_count, token_count, parse_duration_sec, anomaly_flags, updated_at)
                    VALUES (?, ?, ?, 'RUNNING', 0, 0, 0, 0, '[]', ?)
                    ON CONFLICT(run_id, document_id) DO UPDATE SET
                        ragflow_doc_id=excluded.ragflow_doc_id,
                        parse_status='RUNNING',
                        progress=0,
                        updated_at=excluded.updated_at
                    """,
                    (run_id, local_doc_id, r_doc_id, now),
                )

    return {"ok": True, "uploaded_and_triggered": len(uploaded_ids), "ragflow_doc_ids": uploaded_ids}


# ---------- Pre-flight Document Profiler & Baseline Advisor ----------
@router.get("/runs/{run_id}/baseline-advisor")
def get_baseline_advisor_report(run_id: int):
    with get_db() as conn:
        row = conn.execute(
            "SELECT report_json, updated_at FROM baseline_advisor_reports WHERE run_id = ?",
            (run_id,),
        ).fetchone()
    if not row:
        return {"found": False, "report": None, "updated_at": None}
    try:
        report = json.loads(row["report_json"] or "{}")
    except Exception:
        return {"found": False, "report": None, "updated_at": None}
    report["updated_at"] = row["updated_at"]
    return {"found": True, "report": report, "updated_at": row["updated_at"]}


def _find_pipeline_key(pc: Dict[str, Any], prefix: str) -> Optional[str]:
    for k in pc.keys():
        if isinstance(k, str) and k.startswith(prefix):
            return k
    return None


def _extract_current_baseline_config(remote_ds: Optional[Dict[str, Any]], local_pc: Dict[str, Any]) -> Dict[str, Any]:
    """Read current parser config cleanly from RAGFlow v1.0 Pipeline schema or legacy flat schema."""
    pc = (
        remote_ds.get("parser_config")
        if remote_ds and isinstance(remote_ds.get("parser_config"), dict)
        else local_pc
    ) or {}
    parser_id = (
        (remote_ds.get("parser_id") or remote_ds.get("chunk_method"))
        if remote_ds
        else (local_pc.get("chunk_method") or local_pc.get("parser_id"))
    ) or "general"
    if parser_id == "naive":
        parser_id = "general"

    p_key = _find_pipeline_key(pc, "Parser:")
    c_key = _find_pipeline_key(pc, "GeneralChunker:")

    layout_recognize = "DeepDOC"
    if p_key and isinstance(pc.get(p_key), dict):
        p_node = pc[p_key]
        layout_recognize = str((p_node.get("pdf") or {}).get("parse_method") or "DeepDOC")
    elif pc.get("layout_recognize"):
        layout_recognize = str(pc.get("layout_recognize"))

    chunk_token_num = 512
    overlapped_percent = 0
    table_context_size = 0
    if c_key and isinstance(pc.get(c_key), dict):
        c_node = pc[c_key]
        chunk_token_num = int(c_node.get("chunk_token_size") or 512)
        raw_ov = float(c_node.get("overlapped_percent") or 0)
        # RAGFlow Pipeline stores overlapped_percent as 0..1 ratio (e.g. 0.1 -> 10% on RAGFlow UI)
        overlapped_percent = int(round(raw_ov * 100)) if 0 < raw_ov <= 1 else int(round(raw_ov))
        table_context_size = int(c_node.get("table_context_size") or 0)
    else:
        chunk_token_num = int(pc.get("chunk_token_num") or pc.get("chunk_token_size") or 512)
        raw_ov = float(pc.get("overlapped_percent") or 0)
        overlapped_percent = int(round(raw_ov * 100)) if 0 < raw_ov <= 1 else int(round(raw_ov))
        table_context_size = int(pc.get("table_context_size") or 0)

    return {
        "chunk_method": str(parser_id),
        "layout_recognize": layout_recognize,
        "chunk_token_num": chunk_token_num,
        "overlapped_percent": overlapped_percent,
        "table_context_size": table_context_size,
    }


def _merge_baseline_into_parser_config(base_pc: Dict[str, Any], rec: Dict[str, Any]) -> Dict[str, Any]:
    """Safely patch RAGFlow v1.0 Pipeline nodes (preserving Extractor/Tokenizer/VLM) or legacy flat keys."""
    next_pc = json.loads(json.dumps(base_pc or {}))
    p_key = _find_pipeline_key(next_pc, "Parser:")
    c_key = _find_pipeline_key(next_pc, "GeneralChunker:")

    layout = str(rec.get("layout_recognize") or "DeepDOC")
    tok = int(rec.get("chunk_token_num") or 512)
    overlap_pct = float(rec.get("overlapped_percent") or 0)
    # Convert human percentage (e.g. 10 -> 0.1) for RAGFlow Pipeline API
    overlap_ratio = round(overlap_pct / 100.0, 4) if overlap_pct > 1 else round(overlap_pct, 4)
    tbl_ctx = int(rec.get("table_context_size") or 0)

    if p_key or c_key:
        if p_key and isinstance(next_pc.get(p_key), dict):
            if isinstance(next_pc[p_key].get("pdf"), dict):
                next_pc[p_key]["pdf"]["parse_method"] = layout
            if isinstance(next_pc[p_key].get("spreadsheet"), dict):
                next_pc[p_key]["spreadsheet"]["parse_method"] = layout
        if c_key and isinstance(next_pc.get(c_key), dict):
            next_pc[c_key]["chunk_token_size"] = tok
            next_pc[c_key]["overlapped_percent"] = overlap_ratio
            next_pc[c_key]["table_context_size"] = tbl_ctx
        return next_pc

    next_pc["chunk_token_num"] = tok
    next_pc["layout_recognize"] = layout
    next_pc["overlapped_percent"] = overlap_ratio
    next_pc["table_context_size"] = tbl_ctx
    return next_pc


@router.post("/runs/{run_id}/baseline-advisor")
async def run_baseline_advisor(run_id: int, use_llm: bool = True, force: bool = False):
    """
    Pre-flight Document Profiler & Baseline Config Recommender:
    - Phase A: Fast parallel Python structural scan (PDF/DOCX/XLSX/PPTX/HTML/MD) in worker threads.
    - Phase B (optional): Single lightweight LLM synthesis call (~1000-token JSON summary, ~$0.001)
      to refine RAGFlow Baseline parser_config & Vietnamese rationale.
    """
    import time as _time
    from baseline_profiler import aggregate_corpus_profile, profile_document_sync
    from database import get_bool_setting
    from progress_tracker import progress_inc, progress_stage, progress_start

    t0 = _time.perf_counter()
    is_demo = get_bool_setting("demo_mode", False)

    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Phiên kiểm thử không tồn tại.")
        dataset_id = run["ragflow_dataset_id"] or ""
        local_pc = json.loads(run["parser_config"] or "{}")
        if not force and not is_demo:
            cached = conn.execute(
                "SELECT report_json, updated_at FROM baseline_advisor_reports WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if cached:
                try:
                    rep = json.loads(cached["report_json"])
                    rep["updated_at"] = cached["updated_at"]
                    rep["from_cache"] = True
                    return rep
                except Exception:
                    pass

        docs = [
            dict(r)
            for r in conn.execute(
                """
                SELECT d.id, d.doc_code, d.filename, d.format_group, d.page_count, d.is_scan, d.file_path
                FROM documents d
                WHERE EXISTS (
                        SELECT 1 FROM run_documents rd
                         WHERE rd.run_id = ? AND rd.document_id = d.id
                      )
                   OR (
                        d.file_path != ''
                        AND NOT EXISTS (
                            SELECT 1 FROM run_documents rd2 WHERE rd2.document_id = d.id
                        )
                      )
                ORDER BY d.doc_code
                """,
                (run_id,),
            ).fetchall()
        ]
        if not docs:
            raise HTTPException(status_code=400, detail="Dataset này chưa có tài liệu nào để phân tích.")

    # Fetch live RAGFlow dataset config so current_config reflects exact RAGFlow values
    remote_ds = None
    if dataset_id and not is_demo:
        try:
            remote_ds = await _get_client().get_dataset(dataset_id)
        except Exception:
            remote_ds = None
    current_config = _extract_current_baseline_config(remote_ds, local_pc)

    # Phase A: Parallel structural scan in worker threads
    progress_start(len(docs), "Đang quét cấu trúc tài liệu gốc", f"{len(docs)} tài liệu")
    sem = asyncio.Semaphore(6)

    async def _scan_one(d: dict) -> dict:
        async with sem:
            res = await asyncio.to_thread(profile_document_sync, d)
            progress_inc(1)
            return res

    file_profiles = await asyncio.gather(*(_scan_one(d) for d in docs))
    agg = aggregate_corpus_profile(file_profiles)

    recommended = dict(agg["recommended"])
    param_reasons = dict(agg["param_reasons"])
    split_warnings = list(agg["split_warnings"])
    _method_vn = {
        "general": "Tổng hợp",
        "naive": "Tổng hợp",
        "laws": "Văn bản quy phạm",
        "paper": "Bài báo học thuật",
        "table": "Chuyên bảng biểu",
        "qa": "Hỏi – Đáp",
        "presentation": "Slide trình chiếu",
    }
    _layout_vn = "đọc bố cục & OCR (DeepDOC)" if recommended["layout_recognize"] == "DeepDOC" else "lấy chữ thuần"
    _approx_chunk_words = int(round(int(recommended["chunk_token_num"]) * 0.75))
    _scan_note = (
        f", trong đó có {agg['summary']['scan_doc_count']} tài liệu ảnh scan cần nhận dạng chữ"
        if agg["summary"]["scan_doc_count"] > 0
        else ""
    )
    _tbl_note = (
        f" và {agg['summary']['total_tables']} bảng biểu"
        if agg["summary"]["total_tables"] > 0
        else ""
    )
    executive_summary = (
        f"Bộ {agg['summary']['total_docs']} tài liệu ({agg['summary']['format_count']} định dạng{_scan_note}{_tbl_note}) "
        f"phù hợp nhất với chế độ {_method_vn.get(recommended['chunk_method'], recommended['chunk_method'])}, "
        f"bật {_layout_vn} và chia mỗi đoạn khoảng {recommended['chunk_token_num']} token (~{_approx_chunk_words} từ)."
    )
    engine_used = "rule"
    llm_model_used = ""

    # Phase B: Optional single lightweight LLM call (~1k tokens JSON summary)
    if use_llm and not is_demo:
        llm_base = get_setting("llm_base_url", "").strip()
        llm_key = get_setting("llm_api_key", "").strip()
        llm_model = get_setting("llm_model", "").strip()
        if llm_base and llm_model and (llm_key or "localhost" in llm_base or "127.0.0.1" in llm_base):
            progress_stage("Đang tổng hợp đề xuất Baseline bằng LLM", f"Model: {llm_model}")
            from llm_client import call_llm_json

            compact_payload = {
                "summary": agg["summary"],
                "format_breakdown": agg["format_breakdown"],
                "current_config": current_config,
                "rule_baseline": recommended,
                "split_warnings": split_warnings,
                "sample_excerpts": agg["excerpts"][:4],
            }
            sys_prompt = (
                "Bạn là chuyên gia tư vấn hệ thống tìm kiếm tài liệu (RAGFlow), giải thích cho NGƯỜI DÙNG PHỔ THÔNG dễ hiểu ngay.\n"
                "Dựa trên số liệu quét thực tế (TUYỆT ĐỐI KHÔNG bịa số liệu), hãy chốt bộ cấu hình Baseline tối ưu cho RAGFlow.\n"
                "Quy tắc viết tiếng Việt BẮT BUỘC cho executive_summary và param_reasons:\n"
                "1. Viết tự nhiên, mạch lạc, rõ ý như tư vấn viên: nêu thực tế bộ tài liệu -> lý do chọn cài đặt -> lợi ích cụ thể.\n"
                "2. CẤM dùng thuật ngữ thống kê/lập trình khó hiểu như 'p50', 'p75', 'section', 'max_table_tokens', 'naive', 'overlapped_percent', 'table_context_size', 'tok'.\n"
                "3. Thay vào đó dùng từ ngữ đời thường: 'độ dài đoạn văn phổ biến (~X từ)', 'chế độ Tổng hợp', 'bộ đọc bố cục & OCR (DeepDOC)', 'độ chồng lấn giữa các đoạn', 'ngữ cảnh xung quanh bảng biểu'. Khi nhắc đến kích thước đoạn (token), kèm ước lượng số từ (1 token ~ 0.75 từ tiếng Việt) để người đọc dễ hình dung.\n"
                "4. Số liệu lớn dùng dấu chấm ngăn cách hàng nghìn (ví dụ: 1.024, 5.020).\n"
                "Trả về DUY NHẤT JSON hợp lệ với schema:\n"
                "{\n"
                '  "chunk_method": "general"|"laws"|"paper"|"table"|"qa"|"presentation",\n'
                '  "layout_recognize": "DeepDOC"|"Plain Text",\n'
                '  "chunk_token_num": 256|384|512|768|1024,\n'
                '  "overlapped_percent": 0|5|10|15,\n'
                '  "table_context_size": 0|64|128|256,\n'
                '  "executive_summary": "2 câu tóm tắt sắc bén, thân thiện, nêu rõ đặc điểm nổi bật của bộ tài liệu và hướng cấu hình chốt",\n'
                '  "param_reasons": {\n'
                '    "chunk_method": "1 câu giải thích tự nhiên, dẫn số liệu thật dễ hiểu",\n'
                '    "layout_recognize": "1 câu giải thích tự nhiên, dẫn số liệu thật dễ hiểu",\n'
                '    "chunk_token_num": "1 câu giải thích tự nhiên, quy đổi dễ hình dung",\n'
                '    "overlapped_percent": "1 câu giải thích tự nhiên",\n'
                '    "table_context_size": "1 câu giải thích tự nhiên"\n'
                "  }\n"
                "}"
            )
            try:
                llm_out = await call_llm_json(
                    base_url=llm_base,
                    api_key=llm_key,
                    model=llm_model,
                    system_prompt=sys_prompt,
                    user_prompt=json.dumps(compact_payload, ensure_ascii=False),
                    timeout=35.0,
                )
                valid_methods = {"general", "naive", "laws", "paper", "table", "qa", "presentation"}
                valid_layouts = {"DeepDOC", "Plain Text"}
                valid_tokens = {256, 384, 512, 768, 1024}
                valid_overlaps = {0, 5, 10, 15}
                valid_tbl_ctx = {0, 64, 128, 256}

                cm = str(llm_out.get("chunk_method") or "")
                if cm in valid_methods:
                    recommended["chunk_method"] = "general" if cm == "naive" else cm
                if str(llm_out.get("layout_recognize") or "") in valid_layouts:
                    recommended["layout_recognize"] = str(llm_out["layout_recognize"])
                try:
                    t_num = int(llm_out.get("chunk_token_num") or 0)
                    if t_num in valid_tokens:
                        recommended["chunk_token_num"] = t_num
                except (TypeError, ValueError):
                    pass
                try:
                    ov = int(llm_out.get("overlapped_percent"))
                    if ov in valid_overlaps:
                        recommended["overlapped_percent"] = ov
                except (TypeError, ValueError):
                    pass
                try:
                    tc = int(llm_out.get("table_context_size"))
                    if tc in valid_tbl_ctx:
                        recommended["table_context_size"] = tc
                except (TypeError, ValueError):
                    pass
                if isinstance(llm_out.get("executive_summary"), str) and llm_out["executive_summary"].strip():
                    executive_summary = llm_out["executive_summary"].strip()
                if isinstance(llm_out.get("param_reasons"), dict):
                    for k in ("chunk_method", "layout_recognize", "chunk_token_num", "overlapped_percent", "table_context_size"):
                        v = llm_out["param_reasons"].get(k)
                        if isinstance(v, str) and v.strip():
                            param_reasons[k] = v.strip()
                engine_used = "llm"
                llm_model_used = llm_model
            except Exception:
                # Graceful fallback to deterministic rule recommendation
                engine_used = "rule"

    elapsed_sec = round(_time.perf_counter() - t0, 2)
    now = utc_now()
    report = {
        "ok": True,
        "run_id": run_id,
        "engine_used": engine_used,
        "model_used": llm_model_used,
        "elapsed_sec": elapsed_sec,
        "updated_at": now,
        "demo": is_demo,
        "from_cache": False,
        "executive_summary": executive_summary,
        "summary": agg["summary"],
        "format_breakdown": agg["format_breakdown"],
        "current_config": current_config,
        "recommended": recommended,
        "param_reasons": param_reasons,
        "split_warnings": split_warnings,
        "files": agg["files"],
    }

    if not is_demo:
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO baseline_advisor_reports (run_id, report_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    report_json = excluded.report_json,
                    updated_at = excluded.updated_at
                """,
                (run_id, json.dumps(report, ensure_ascii=False), now),
            )

    return report


class ApplyBaselinePayload(BaseModel):
    chunk_method: str = "general"
    layout_recognize: str = "DeepDOC"
    chunk_token_num: int = 512
    overlapped_percent: int = 0
    table_context_size: int = 0


@router.post("/runs/{run_id}/baseline-advisor/apply")
async def apply_baseline_advisor(run_id: int, payload: ApplyBaselinePayload):
    """Safely merge recommended baseline settings into the live RAGFlow Dataset pipeline config and persist."""
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Phiên kiểm thử không tồn tại.")
        dataset_id = run["ragflow_dataset_id"] or ""
        local_pc = json.loads(run["parser_config"] or "{}")

    is_demo = get_bool_setting("demo_mode", False)
    remote_ds = None
    remote_synced = False
    remote_warning = ""
    client = None
    if dataset_id and not is_demo:
        try:
            client = _get_client()
            remote_ds = await client.get_dataset(dataset_id)
        except Exception as e:
            remote_warning = str(e)

    base_pc = (
        remote_ds.get("parser_config")
        if remote_ds and isinstance(remote_ds.get("parser_config"), dict)
        else local_pc
    ) or {}
    rec_dict = payload.model_dump()
    target_method = "general" if rec_dict["chunk_method"] == "naive" else rec_dict["chunk_method"]
    merged_pc = _merge_baseline_into_parser_config(base_pc, rec_dict)

    verified_config = None
    if is_demo:
        await asyncio.sleep(0.35)
        remote_synced = True
        verified_config = {
            "chunk_method": target_method,
            "layout_recognize": rec_dict["layout_recognize"],
            "chunk_token_num": int(rec_dict["chunk_token_num"]),
            "overlapped_percent": int(rec_dict["overlapped_percent"]),
            "table_context_size": int(rec_dict["table_context_size"]),
        }
    elif dataset_id and client is not None:
        try:
            await client.update_dataset(
                dataset_id=dataset_id,
                chunk_method=target_method,
                parser_config=merged_pc,
            )
            remote_synced = True
            refreshed = await client.get_dataset(dataset_id)
            if refreshed:
                verified_config = _extract_current_baseline_config(refreshed, merged_pc)
                if isinstance(refreshed.get("parser_config"), dict):
                    merged_pc = refreshed["parser_config"]
        except Exception as e:
            remote_warning = str(e)

    stored_pc = dict(merged_pc)
    stored_pc["chunk_method"] = target_method
    with get_db() as conn:
        conn.execute(
            "UPDATE runs SET parser_config = ? WHERE id = ?",
            (json.dumps(stored_pc, ensure_ascii=False), run_id),
        )
        cached = conn.execute(
            "SELECT report_json FROM baseline_advisor_reports WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        if cached:
            try:
                rep = json.loads(cached["report_json"])
                rep["current_config"] = verified_config or {
                    "chunk_method": target_method,
                    "layout_recognize": rec_dict["layout_recognize"],
                    "chunk_token_num": int(rec_dict["chunk_token_num"]),
                    "overlapped_percent": int(rec_dict["overlapped_percent"]),
                    "table_context_size": int(rec_dict["table_context_size"]),
                }
                conn.execute(
                    "UPDATE baseline_advisor_reports SET report_json = ? WHERE run_id = ?",
                    (json.dumps(rep, ensure_ascii=False), run_id),
                )
            except Exception:
                pass

    return {
        "ok": True,
        "remote_synced": remote_synced,
        "remote_warning": remote_warning,
        "verified_config": verified_config,
        "parser_config": stored_pc,
    }
