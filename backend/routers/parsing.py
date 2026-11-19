import json
import os
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from database import get_db, utc_now
from metrics import align_unit_to_chunks

router = APIRouter(prefix="/api/parsing", tags=["parsing"])


class ParsingUnitCreate(BaseModel):
    document_id: int
    unit_type: str = "text"
    page_num: int = 1
    title: str = ""
    source_text: str


class ParsingScoreUpdate(BaseModel):
    verdict: str  # PASS | FAIL | PARTIAL | UNRATED
    error_codes: List[str] = []
    char_error: bool = False
    severity: str = ""
    notes: str = ""


@router.get("/runs/{run_id}/units")
def list_parsing_units(run_id: int, document_id: Optional[int] = None):
    with get_db() as conn:
        q = """
            SELECT pu.*, d.doc_code, d.filename, d.format_group, d.file_path
            FROM parsing_units pu
            JOIN documents d ON d.id = pu.document_id
            WHERE pu.run_id = ?
        """
        params: list = [run_id]
        if document_id:
            q += " AND pu.document_id = ?"
            params.append(document_id)
        q += " ORDER BY d.doc_code, pu.unit_index"
        rows = conn.execute(q, params).fetchall()

        # Fetch chunks map for quick side-by-side display
        crows = conn.execute(
            "SELECT ragflow_chunk_id, chunk_index, content, page_num, char_count FROM chunks WHERE run_id = ?",
            (run_id,),
        ).fetchall()
        chunk_map = {c["ragflow_chunk_id"]: dict(c) for c in crows}

        items = []
        for r in rows:
            d = dict(r)
            matched_ids = json.loads(d["matched_chunk_ids"] or "[]")
            d["matched_chunk_ids"] = matched_ids
            d["error_codes"] = json.loads(d["error_codes"] or "[]")
            d["matched_chunks"] = [chunk_map[cid] for cid in matched_ids if cid in chunk_map]
            d["has_local_file"] = bool(d["file_path"] and os.path.exists(d["file_path"]))
            items.append(d)
        return items


@router.post("/runs/{run_id}/units")
def create_parsing_unit(run_id: int, payload: ParsingUnitCreate):
    with get_db() as conn:
        crows = conn.execute(
            "SELECT ragflow_chunk_id, content FROM chunks WHERE run_id = ? AND document_id = ?",
            (run_id, payload.document_id),
        ).fetchall()
        matched_ids, score = align_unit_to_chunks(payload.source_text, [dict(c) for c in crows])
        max_idx = conn.execute(
            "SELECT COALESCE(MAX(unit_index), 0) FROM parsing_units WHERE run_id = ? AND document_id = ?",
            (run_id, payload.document_id),
        ).fetchone()[0]
        cur = conn.execute(
            """
            INSERT INTO parsing_units (run_id, document_id, unit_index, unit_type, page_num, title, source_text, matched_chunk_ids, match_score, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id, payload.document_id, max_idx + 1, payload.unit_type, payload.page_num,
                payload.title, payload.source_text, json.dumps(matched_ids), score, utc_now(),
            ),
        )
        return {"ok": True, "id": cur.lastrowid, "matched_chunk_ids": matched_ids, "match_score": score}


@router.post("/runs/{run_id}/documents/{document_id}/auto-extract")
def auto_extract_units(run_id: int, document_id: int, max_units: int = 25):
    """Extracts ground-truth text/table units from local PDF/DOCX/TXT/MD and auto-aligns to RAGFlow chunks."""
    with get_db() as conn:
        doc = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
        if not doc:
            raise HTTPException(status_code=404, detail="Tài liệu không tồn tại")
        fp = doc["file_path"]
        if not fp or not os.path.exists(fp):
            raise HTTPException(status_code=400, detail="Tài liệu chưa có file gốc lưu local để trích xuất tự động.")

        extracted = []
        ext = os.path.splitext(fp)[1].lower()
        if ext == ".pdf":
            import fitz
            pdf = fitz.open(fp)
            for p_idx, page in enumerate(pdf, start=1):
                blocks = [b[4].strip() for b in page.get_text("blocks") if b[4].strip() and len(b[4].strip()) > 35]
                for btxt in blocks:
                    extracted.append(("text", p_idx, f"Trang {p_idx}", btxt))
                    if len(extracted) >= max_units:
                        break
                if len(extracted) >= max_units:
                    break
            pdf.close()
        elif ext == ".docx":
            import docx
            d = docx.Document(fp)
            for p in d.paragraphs:
                txt = p.text.strip()
                if len(txt) > 35:
                    u_type = "heading" if (p.style and "Heading" in p.style.name) else "text"
                    extracted.append((u_type, 1, p.style.name if p.style else "Đoạn", txt))
                if len(extracted) >= max_units:
                    break
            for t_idx, tbl in enumerate(d.tables, start=1):
                rows_txt = [" | ".join(c.text.strip() for c in r.cells) for r in tbl.rows[:10]]
                extracted.append(("table", 1, f"Bảng #{t_idx}", "\n".join(rows_txt)))
        else:
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                raw = f.read()
            paras = [p.strip() for p in raw.split("\n\n") if len(p.strip()) > 35]
            for i, p in enumerate(paras[:max_units], start=1):
                extracted.append(("text", 1, f"Đoạn #{i}", p))

        crows = conn.execute(
            "SELECT ragflow_chunk_id, content FROM chunks WHERE run_id = ? AND document_id = ?",
            (run_id, document_id),
        ).fetchall()
        chunks_list = [dict(c) for c in crows]

        conn.execute(
            "DELETE FROM parsing_units WHERE run_id = ? AND document_id = ?",
            (run_id, document_id),
        )
        for idx, (utype, pnum, title, stxt) in enumerate(extracted, start=1):
            matched_ids, score = align_unit_to_chunks(stxt, chunks_list)
            conn.execute(
                """
                INSERT INTO parsing_units (run_id, document_id, unit_index, unit_type, page_num, title, source_text, matched_chunk_ids, match_score, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id, document_id, idx, utype, pnum, title, stxt,
                    json.dumps(matched_ids), score, utc_now(),
                ),
            )
        return {"ok": True, "extracted_units": len(extracted)}


@router.put("/units/{unit_id}/score")
def score_parsing_unit(unit_id: int, payload: ParsingScoreUpdate):
    with get_db() as conn:
        conn.execute(
            """
            UPDATE parsing_units
            SET verdict = ?, error_codes = ?, char_error = ?, severity = ?, notes = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                payload.verdict,
                json.dumps(payload.error_codes),
                1 if payload.char_error else 0,
                payload.severity,
                payload.notes,
                utc_now(),
                unit_id,
            ),
        )
    return {"ok": True}


@router.get("/documents/{document_id}/page/{page_num}")
def render_pdf_page(document_id: int, page_num: int):
    """Renders a crisp PNG preview of a PDF page for Side-by-Side inspection."""
    with get_db() as conn:
        doc = conn.execute("SELECT file_path FROM documents WHERE id = ?", (document_id,)).fetchone()
    if not doc or not doc["file_path"] or not os.path.exists(doc["file_path"]):
        raise HTTPException(status_code=404, detail="Không tìm thấy file gốc")
    if not doc["file_path"].lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Chỉ hỗ trợ render ảnh trang cho PDF")
    import fitz
    pdf = fitz.open(doc["file_path"])
    idx = max(0, min(page_num - 1, len(pdf) - 1))
    pix = pdf[idx].get_pixmap(dpi=150)
    png_bytes = pix.tobytes("png")
    pdf.close()
    return Response(content=png_bytes, media_type="image/png")


@router.get("/runs/{run_id}/metrics")
def get_parsing_metrics(run_id: int):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT pu.*, d.doc_code, d.format_group
            FROM parsing_units pu
            JOIN documents d ON d.id = pu.document_id
            WHERE pu.run_id = ?
            """,
            (run_id,),
        ).fetchall()

    rated = [r for r in rows if r["verdict"] != "UNRATED"]
    text_units = [r for r in rated if r["unit_type"] != "table"]
    table_units = [r for r in rated if r["unit_type"] == "table"]

    text_pass = sum(1 for r in text_units if r["verdict"] == "PASS")
    table_pass = sum(1 for r in table_units if r["verdict"] == "PASS")
    char_err = sum(1 for r in rated if r["char_error"] == 1)

    by_group = {}
    for r in rated:
        g = r["format_group"]
        b = by_group.setdefault(g, {"total": 0, "pass": 0, "table_total": 0, "table_pass": 0, "char_err": 0})
        b["total"] += 1
        if r["verdict"] == "PASS":
            b["pass"] += 1
        if r["unit_type"] == "table":
            b["table_total"] += 1
            if r["verdict"] == "PASS":
                b["table_pass"] += 1
        if r["char_error"] == 1:
            b["char_err"] += 1

    return {
        "total_units": len(rows),
        "rated_units": len(rated),
        "text_completeness": round(text_pass / len(text_units), 4) if text_units else 0.0,
        "table_accuracy": round(table_pass / len(table_units), 4) if table_units else 0.0,
        "character_error_rate": round(char_err / len(rated), 4) if rated else 0.0,
        "by_format_group": by_group,
    }
