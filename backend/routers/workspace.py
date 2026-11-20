import json
import os
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from database import UPLOAD_DIR, get_db, get_setting, repair_chunk_document_links, utc_now, repair_chunk_document_links
from ragflow_client import RAGFlowClient, RAGFlowError
from metrics import detect_chunk_rule_flags
from unit_sync import ensure_units_for_document_async

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
    save_path = os.path.join(UPLOAD_DIR, f"{doc_code}_{safe_name}")
    content = await file.read()
    with open(save_path, "wb") as f:
        f.write(content)

    page_count = 0
    if safe_name.lower().endswith(".pdf"):
        try:
            import fitz
            doc = fitz.open(save_path)
            page_count = len(doc)
            doc.close()
        except Exception:
            page_count = 0

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
                doc_code.strip(),
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
        row = conn.execute("SELECT * FROM documents WHERE doc_code = ?", (doc_code.strip(),)).fetchone()
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

    created = []
    with get_db() as conn:
        existing_codes = {r["doc_code"] for r in conn.execute("SELECT doc_code FROM documents").fetchall()}
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
            with open(save_path, "wb") as f:
                f.write(content)

            page_count = 0
            is_scan = 0
            if safe_name.lower().endswith(".pdf"):
                try:
                    import fitz
                    doc = fitz.open(save_path)
                    page_count = len(doc)
                    total_text_len = sum(len(p.get_text().strip()) for p in doc)
                    if page_count > 0 and (total_text_len / page_count < 25 or "scan" in safe_name.lower()):
                        is_scan = 1
                    doc.close()
                except Exception:
                    page_count = 0

            grp = ("PDF scan / ảnh" if is_scan else _guess_format_group(safe_name)) if (not format_group or format_group == "AUTO") else format_group
            conn.execute(
                """
                INSERT INTO documents (doc_code, filename, format_group, source_url, file_path, page_count, is_scan, created_at)
                VALUES (?, ?, ?, '', ?, ?, ?, ?)
                """,
                (doc_code, safe_name, grp, save_path, page_count, is_scan, utc_now()),
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
                    (run_id, row["id"], utc_now()),
                )
            created.append(dict(row))

    return {"ok": True, "uploaded_count": len(created), "documents": created}


@router.delete("/documents/{doc_id}")
def delete_document(doc_id: int, run_id: Optional[int] = None):
    """
    Remove a document from ONE run by default (run-scoped). Chunks of that run are dropped so the
    next sync re-pulls a clean snapshot. The global document row is only deleted when no other run
    still references it, which keeps other datasets intact.
    """
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
            still_linked = conn.execute(
                "SELECT COUNT(*) FROM run_documents WHERE document_id = ?", (doc_id,)
            ).fetchone()[0]
            still_chunked = conn.execute(
                "SELECT COUNT(*) FROM chunks WHERE document_id = ?", (doc_id,)
            ).fetchone()[0]
            if still_linked == 0 and still_chunked == 0:
                conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        else:
            # Global removal: drop chunks first so they don't become orphans.
            conn.execute("DELETE FROM chunks WHERE document_id = ?", (doc_id,))
            conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    return {"ok": True}


@router.delete("/documents")
def clear_documents(synced_only: bool = False, run_id: Optional[int] = None):
    with get_db() as conn:
        if run_id is not None:
            conn.execute("DELETE FROM run_documents WHERE run_id = ?", (run_id,))
            conn.execute("DELETE FROM chunks WHERE run_id = ?", (run_id,))
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
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM runs ORDER BY is_baseline DESC, id DESC").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["parser_config"] = json.loads(d["parser_config"] or "{}")
            d["retrieval_config"] = json.loads(d["retrieval_config"] or "{}")
            chunk_cnt = conn.execute("SELECT COUNT(*) FROM chunks WHERE run_id = ?", (r["id"],)).fetchone()[0]
            doc_cnt = conn.execute("SELECT COUNT(*) FROM run_documents WHERE run_id = ?", (r["id"],)).fetchone()[0]
            d["chunk_count"] = chunk_cnt
            d["doc_count"] = doc_cnt
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

    with get_db() as conn:
        if payload.is_baseline:
            conn.execute("UPDATE runs SET is_baseline = 0")
        try:
            cur = conn.execute(
                """
                INSERT INTO runs (name, description, is_baseline, ragflow_dataset_id, ragflow_dataset_name, parser_config, retrieval_config, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'READY', ?)
                """,
                (
                    run_name,
                    payload.description,
                    1 if payload.is_baseline else 0,
                    dataset_id,
                    dataset_name,
                    json.dumps(payload.parser_config, ensure_ascii=False),
                    json.dumps(payload.retrieval_config, ensure_ascii=False),
                    utc_now(),
                ),
            )
            run_id = cur.lastrowid
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Tên run đã tồn tại hoặc lỗi dữ liệu: {e}")
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        return dict(row)


class RunParserConfigUpdate(BaseModel):
    chunk_method: str = "naive"
    parser_config: Dict[str, Any] = {}
    sync_remote: bool = True


@router.put("/runs/{run_id}/parser-config")
async def update_run_parser_config(run_id: int, payload: RunParserConfigUpdate):
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Run không tồn tại")
        dataset_id = run["ragflow_dataset_id"] or ""

    stored_cfg = dict(payload.parser_config or {})
    stored_cfg["chunk_method"] = payload.chunk_method or "naive"

    remote_synced = False
    remote_warning = ""
    if payload.sync_remote and dataset_id:
        try:
            client = _get_client()
            remote_cfg = {k: v for k, v in stored_cfg.items() if k != "chunk_method"}
            await client.update_dataset(
                dataset_id=dataset_id,
                chunk_method=stored_cfg["chunk_method"],
                parser_config=remote_cfg,
            )
            remote_synced = True
        except Exception as e:
            remote_warning = str(e)

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


@router.delete("/runs/{run_id}")
def delete_run(run_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
        conn.execute(
            """
            DELETE FROM documents
            WHERE file_path = ''
              AND id NOT IN (SELECT DISTINCT document_id FROM run_documents)
            """
        )
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
}


def _extract_remote_doc_meta(rdoc: Dict[str, Any]) -> Dict[str, Any]:
    raw_status = rdoc.get("ingestion_status") or rdoc.get("run") or "UNSTART"
    r_status = STATUS_MAP.get(str(raw_status).upper(), str(raw_status).upper())
    r_progress = float(rdoc.get("progress", 0) or 0)
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
        remote_docs = await client.list_documents(dataset_id, page=1, page_size=200)
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

            anomalies = []
            if r_status == "FAIL":
                anomalies.append("PARSE_FAILED")
            if r_status == "DONE" and meta["chunk_count"] == 0:
                anomalies.append("ZERO_CHUNKS")
            if meta["duration"] > 180:
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


@router.post("/runs/{run_id}/sync-from-ragflow")
async def sync_run_from_ragflow(run_id: int, pull_chunks: bool = True, force: bool = False):
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
        remote_docs = await client.list_documents(dataset_id, page=1, page_size=200)
    except RAGFlowError as e:
        raise HTTPException(status_code=400, detail=f"Lỗi lấy danh sách tài liệu từ RAGFlow: {e}")

    min_chars = int(get_setting("min_chunk_chars", "50") or "50")
    max_chars = int(get_setting("max_chunk_chars", "2600") or "2600")

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

    # ---- Phase 2: network I/O outside the SQLite write transaction ----
    chunk_payloads: Dict[str, List[Dict[str, Any]]] = {}
    failed_docs: List[Dict[str, str]] = []
    for meta, _local in plan:
        r_doc_id = meta["ragflow_doc_id"]
        needs_pull = (
            pull_chunks
            and meta["status"] == "DONE"
            and (force or local_chunk_counts.get(r_doc_id, 0) != meta["chunk_count"])
        )
        if not needs_pull:
            continue
        try:
            chunk_payloads[r_doc_id] = await client.list_all_chunks(dataset_id, r_doc_id)
        except Exception as e:  # network / API error must be visible, never silently ignored
            failed_docs.append({"name": meta["name"], "error": str(e)[:300]})

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

            anomalies = []
            if meta["status"] == "FAIL":
                anomalies.append("PARSE_FAILED")
            if meta["status"] == "DONE" and meta["chunk_count"] == 0:
                anomalies.append("ZERO_CHUNKS")
            if meta["duration"] > 180:
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
                flags = detect_chunk_rule_flags(content, min_chars=min_chars, max_chars=max_chars)
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

        # Legacy repair: chunks whose document row was deleted in an older version.
        repair_chunk_document_links(conn)
        conn.execute("UPDATE runs SET status = 'SYNCED' WHERE id = ?", (run_id,))

    # ---- Phase 4: keep ground-truth units aligned with the fresh chunks ----
    auto_extracted_units = 0
    realigned_units = 0
    for local_doc_id, r_doc_id, doc_code, r_name, existing_fp in docs_for_units:
        try:
            res = await ensure_units_for_document_async(
                run_id,
                local_doc_id,
                r_doc_id,
                doc_code,
                r_name,
                existing_fp,
                client=client,
                dataset_id=dataset_id,
            )
        except Exception:
            continue
        auto_extracted_units += res.get("extracted", 0)
        realigned_units += res.get("realigned", 0)

    return {
        "ok": True,
        "synced_documents": synced_docs,
        "synced_chunks": synced_chunks,
        "auto_extracted_units": auto_extracted_units,
        "realigned_units": realigned_units,
        "skipped_chunk_documents": skipped_chunk_docs,
        "failed_documents": failed_docs,
    }


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
            SELECT d.*, rd.ragflow_doc_id AS linked_ragflow_doc_id
            FROM documents d
            JOIN run_documents rd ON rd.document_id = d.id AND rd.run_id = ?
            WHERE d.file_path != ''
              AND (rd.ragflow_doc_id = '' OR rd.parse_status = 'FAIL')
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
