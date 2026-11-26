"""
Diagnostic & Corpus-Aware Config Advisor for RAGFlow QC Harness.

Analyzes:
1. Corpus profile (scan ratio, tables, legal numbering, document lengths, format mix)
2. Quantified 3-layer failure signals (Parsing -> Chunking -> Retrieval)
3. Current RAGFlow parser_config & retrieval_config

Produces concrete, explainable Candidate Config Packs (with JSON diffs, expected impact,
tradeoffs, and a ready-to-run recommended Retrieval Sweep space).
"""

import json
import re
from typing import Any, Dict, List, Optional, Tuple

from database import get_db
from metrics import compute_contextual_precision, compute_parsing_metrics, compute_weighted_chunking_rates

_LEGAL_RE = re.compile(r"(?:^|\n)\s*(?:Điều|Khoản|Chương|Mục)\s+\d+", re.IGNORECASE)


def _extract_current_knobs(parser_cfg: Dict[str, Any], retrieval_cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Extracts normalized flat knobs from either RAGFlow v1.0 node schema or legacy flat schema."""
    pc = parser_cfg or {}
    rc = retrieval_cfg or {}

    chunk_method = str(pc.get("chunk_method") or pc.get("parser_id") or "general")
    pdf_parser = str(pc.get("layout_recognize") or "DeepDOC")
    vision_enhance = bool(pc.get("enable_vision_enhancement", False))
    chunk_token_size = int(pc.get("chunk_token_num") or 512)
    overlapped_percent = int(pc.get("overlapped_percent") or 0)
    delimiters = pc.get("delimiter") or "\\n!?;。；！？"
    table_context_size = int(pc.get("table_context_size") or 0)
    image_context_size = int(pc.get("image_context_size") or 0)
    use_parent_child = False
    keywords_top_n = int(pc.get("auto_keywords") or 0)
    questions_top_n = int(pc.get("auto_questions") or 0)
    filename_embd_weight = 0.1

    for k, v in pc.items():
        if not isinstance(v, dict):
            continue
        if k.startswith("Parser:"):
            pdf_parser = str((v.get("pdf") or {}).get("parse_method") or pdf_parser)
            vision_enhance = bool(v.get("enable_vision_enhancement", vision_enhance))
        elif k.startswith("GeneralChunker:"):
            chunk_token_size = int(v.get("chunk_token_size") or chunk_token_size)
            overlapped_percent = int(v.get("overlapped_percent") or overlapped_percent)
            if isinstance(v.get("delimiters"), list):
                delimiters = " ".join("\\n" if d == "\n" else str(d) for d in v["delimiters"])
            table_context_size = int(v.get("table_context_size") or table_context_size)
            image_context_size = int(v.get("image_context_size") or image_context_size)
            use_parent_child = bool((v.get("parent_child") or {}).get("use_parent_child", False))
        elif k.startswith("Extractor:"):
            keywords_top_n = int((v.get("keywords") or {}).get("top_n") or keywords_top_n)
            questions_top_n = int((v.get("questions") or {}).get("top_n") or questions_top_n)
        elif k.startswith("Tokenizer:"):
            filename_embd_weight = float(v.get("filename_embd_weight") or filename_embd_weight)

    return {
        "index": {
            "chunk_method": chunk_method,
            "pdf_parse_method": pdf_parser,
            "enable_vision_enhancement": vision_enhance,
            "chunk_token_size": chunk_token_size,
            "overlapped_percent": overlapped_percent,
            "delimiters": delimiters,
            "table_context_size": table_context_size,
            "image_context_size": image_context_size,
            "use_parent_child": use_parent_child,
            "keywords_top_n": keywords_top_n,
            "questions_top_n": questions_top_n,
            "filename_embd_weight": filename_embd_weight,
        },
        "retrieval": {
            "top_k": int(rc.get("top_k") or rc.get("top_n") or 10),
            "similarity_threshold": float(rc.get("similarity_threshold") if rc.get("similarity_threshold") is not None else 0.2),
            "vector_similarity_weight": float(
                rc.get("vector_similarity_weight")
                if rc.get("vector_similarity_weight") is not None
                else rc.get("vector_weight", 0.3)
            ),
            "rerank_id": str(rc.get("rerank_id") or ""),
            "keyword_enabled": bool(rc.get("keyword_enabled", True)),
        },
    }


def merge_index_knobs_into_parser_config(base_pc: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    """Applies flat index knob updates back onto either RAGFlow v1.0 node schema or legacy flat schema."""
    next_pc = json.loads(json.dumps(base_pc or {}))
    has_pipeline = any(
        isinstance(k, str) and k.startswith(("Parser:", "GeneralChunker:", "Extractor:", "Tokenizer:"))
        for k in next_pc.keys()
    )
    if "chunk_method" in patch:
        next_pc["chunk_method"] = patch["chunk_method"]

    if has_pipeline:
        for k, v in next_pc.items():
            if not isinstance(v, dict):
                continue
            if k.startswith("Parser:"):
                if "enable_vision_enhancement" in patch:
                    v["enable_vision_enhancement"] = bool(patch["enable_vision_enhancement"])
                if "pdf_parse_method" in patch:
                    v.setdefault("pdf", {})["parse_method"] = patch["pdf_parse_method"]
            elif k.startswith("GeneralChunker:"):
                if "chunk_token_size" in patch:
                    v["chunk_token_size"] = int(patch["chunk_token_size"])
                if "overlapped_percent" in patch:
                    v["overlapped_percent"] = int(patch["overlapped_percent"])
                if "table_context_size" in patch:
                    v["table_context_size"] = int(patch["table_context_size"])
                if "image_context_size" in patch:
                    v["image_context_size"] = int(patch["image_context_size"])
                if "delimiters" in patch and isinstance(patch["delimiters"], str):
                    v["delimiters"] = ["\n" if t == "\\n" else t for t in patch["delimiters"].split() if t]
                if "use_parent_child" in patch:
                    v.setdefault("parent_child", {})["use_parent_child"] = bool(patch["use_parent_child"])
                    v["parent_child"].setdefault("children_delimiter", "\n")
            elif k.startswith("Extractor:"):
                if "keywords_top_n" in patch:
                    v.setdefault("keywords", {})["top_n"] = int(patch["keywords_top_n"])
                if "questions_top_n" in patch:
                    v.setdefault("questions", {})["top_n"] = int(patch["questions_top_n"])
            elif k.startswith("Tokenizer:"):
                if "filename_embd_weight" in patch:
                    v["filename_embd_weight"] = float(patch["filename_embd_weight"])
        return next_pc

    mapping = {
        "pdf_parse_method": "layout_recognize",
        "enable_vision_enhancement": "enable_vision_enhancement",
        "chunk_token_size": "chunk_token_num",
        "overlapped_percent": "overlapped_percent",
        "table_context_size": "table_context_size",
        "image_context_size": "image_context_size",
        "keywords_top_n": "auto_keywords",
        "questions_top_n": "auto_questions",
    }
    for src_k, dst_k in mapping.items():
        if src_k in patch:
            next_pc[dst_k] = patch[src_k]
    if "delimiters" in patch:
        next_pc["delimiter"] = str(patch["delimiters"]).replace(" ", "")
    return next_pc


def analyze_and_propose_configs(run_id: int) -> Dict[str, Any]:
    """
    Produces full Corpus Profile, 3-Layer Failure Signals, Concrete Candidate Config Packs,
    and a tailored Retrieval Sweep Search Space for `run_id`.
    """
    with get_db() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            raise ValueError("Run không tồn tại")

        docs = conn.execute(
            """
            SELECT d.*, rd.parse_status, rd.chunk_count, rd.parse_duration_sec, rd.anomaly_flags
            FROM documents d
            JOIN run_documents rd ON rd.document_id = d.id
            WHERE rd.run_id = ?
            ORDER BY d.doc_code
            """,
            (run_id,),
        ).fetchall()

        chunks = conn.execute(
            "SELECT id, document_id, content, char_count, token_est, rule_flags FROM chunks WHERE run_id = ?",
            (run_id,),
        ).fetchall()

        p_rows = conn.execute("SELECT * FROM parsing_units WHERE run_id = ?", (run_id,)).fetchall()
        c_rows = conn.execute(
            """
            SELECT ce.*, c.document_id
            FROM chunk_evaluations ce
            JOIN chunks c ON c.id = ce.chunk_id
            WHERE ce.run_id = ? AND ce.is_sampled = 1
            """,
            (run_id,),
        ).fetchall()

        latest_rr = conn.execute(
            "SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1",
            (run_id,),
        ).fetchone()

        ret_hits = []
        ret_meta = []
        tcs = []
        if latest_rr:
            ret_hits = conn.execute(
                "SELECT * FROM retrieval_results WHERE retrieval_run_id = ? ORDER BY testcase_id, rank",
                (latest_rr["id"],),
            ).fetchall()
            ret_meta = conn.execute(
                "SELECT * FROM testcase_eval_meta WHERE retrieval_run_id = ?",
                (latest_rr["id"],),
            ).fetchall()
            tcs = conn.execute("SELECT * FROM golden_testcases ORDER BY tc_code").fetchall()

    try:
        parser_cfg = json.loads(run["parser_config"] or "{}")
    except Exception:
        parser_cfg = {}
    try:
        retrieval_cfg = json.loads(run["retrieval_config"] or "{}")
    except Exception:
        retrieval_cfg = {}

    if latest_rr:
        retrieval_cfg = {
            "top_k": latest_rr["top_k"],
            "similarity_threshold": latest_rr["similarity_threshold"],
            "vector_similarity_weight": latest_rr["vector_similarity_weight"],
            "rerank_id": latest_rr["rerank_id"] or "",
            "keyword_enabled": bool(latest_rr["keyword_enabled"]),
        }

    current = _extract_current_knobs(parser_cfg, retrieval_cfg)
    cur_idx = current["index"]
    cur_ret = current["retrieval"]

    # ---- 1. Corpus Profiling ----
    doc_count = len(docs)
    scan_docs = sum(1 for d in docs if d["is_scan"] == 1 or "scan" in (d["format_group"] or "").lower())
    table_docs = sum(
        1 for d in docs
        if d["has_tables"] == 1 or "bảng" in (d["format_group"] or "").lower() or "excel" in (d["format_group"] or "").lower()
    )
    pdf_docs = sum(1 for d in docs if (d["filename"] or "").lower().endswith(".pdf"))
    zero_chunk_docs = sum(1 for d in docs if (d["chunk_count"] or 0) == 0)

    total_chunks = len(chunks)
    avg_tokens = round(sum(c["token_est"] or 0 for c in chunks) / total_chunks, 1) if total_chunks else 0.0
    flag_counts: Dict[str, int] = {}
    legal_hits = 0
    table_chunk_hits = 0
    for c in chunks:
        txt = c["content"] or ""
        if _LEGAL_RE.search(txt):
            legal_hits += 1
        if "<table" in txt.lower() or "<td" in txt.lower():
            table_chunk_hits += 1
        try:
            fls = json.loads(c["rule_flags"] or "[]")
        except Exception:
            fls = []
        for f in fls:
            flag_counts[f] = flag_counts.get(f, 0) + 1

    scan_ratio = round(scan_docs / doc_count, 3) if doc_count else 0.0
    table_ratio = round(max(table_docs / max(doc_count, 1), table_chunk_hits / max(total_chunks, 1)), 3)
    legal_ratio = round(legal_hits / total_chunks, 3) if total_chunks else 0.0

    archetype = "Tài liệu tổng hợp"
    if legal_ratio >= 0.25:
        archetype = "Văn bản quy phạm / Pháp lý / Điều khoản"
    elif table_ratio >= 0.35:
        archetype = "Tài liệu nhiều bảng biểu / Số liệu"
    elif scan_ratio >= 0.35:
        archetype = "Hồ sơ PDF Scan / Hình ảnh"

    corpus_profile = {
        "doc_count": doc_count,
        "total_chunks": total_chunks,
        "avg_chunk_tokens": avg_tokens,
        "pdf_docs": pdf_docs,
        "scan_docs": scan_docs,
        "scan_ratio": scan_ratio,
        "table_ratio": table_ratio,
        "legal_ratio": legal_ratio,
        "zero_chunk_docs": zero_chunk_docs,
        "archetype": archetype,
        "flag_counts": flag_counts,
    }

    # ---- 2. Failure Signals ----
    pm = compute_parsing_metrics(p_rows)
    doc_totals: Dict[Any, int] = {}
    for c in chunks:
        doc_totals[c["document_id"]] = doc_totals.get(c["document_id"], 0) + 1
    cm = compute_weighted_chunking_rates(c_rows, doc_totals) if c_rows else {}

    rc_counts: Dict[str, int] = {}
    ac_counts = {"FULL": 0, "SPLIT": 0, "MISSING": 0, "UNCHECKED": 0}
    for m in ret_meta:
        ac = m["answer_containment"] or "UNCHECKED"
        ac_counts[ac] = ac_counts.get(ac, 0) + 1
        rc = (m["root_cause_layer"] or "").strip()
        if rc and rc != "NONE":
            rc_counts[rc] = rc_counts.get(rc, 0) + 1

    cp_list: List[float] = []
    class_cp: Dict[str, List[float]] = {}
    if latest_rr and tcs:
        by_tc: Dict[int, List[int]] = {}
        for h in ret_hits:
            if h["relevant"] is not None:
                by_tc.setdefault(h["testcase_id"], []).append(int(h["relevant"]))
        for tc in tcs:
            rels = by_tc.get(tc["id"], [])
            cp = compute_contextual_precision(rels)
            cp_list.append(cp)
            class_cp.setdefault(tc["question_class"] or "Local", []).append(cp)

    avg_cp = round(sum(cp_list) / len(cp_list), 4) if cp_list else None
    class_avg_cp = {k: round(sum(v) / len(v), 4) for k, v in class_cp.items() if v}

    signals: List[Dict[str, Any]] = []

    # Parsing signals
    if pm["rated_units"] > 0:
        if pm["table_total"] > 0 and pm["table_accuracy"] < 0.78:
            signals.append({
                "layer": "PARSING",
                "code": "LOW_TABLE_ACC",
                "severity": "high",
                "metric": f"Table Accuracy = {round(pm['table_accuracy'] * 100)}%",
                "detail": "Bảng biểu bị mất cột/hàng hoặc gộp sai ô khi parse.",
            })
        if pm["text_completeness"] < 0.82 or pm["character_error_rate"] > 0.12:
            signals.append({
                "layer": "PARSING",
                "code": "OCR_OR_TEXT_LOSS",
                "severity": "high",
                "metric": f"Text = {round(pm['text_completeness'] * 100)}% · CER = {round(pm['character_error_rate'] * 100)}%",
                "detail": "Thiếu chữ, sai dấu tiếng Việt hoặc lỗi OCR trên file PDF/Scan.",
            })

    # Chunking signals
    boundary_bad = flag_counts.get("BAD_BOUNDARY", 0) + flag_counts.get("LIST_SPLIT", 0) + flag_counts.get("BROKEN_TABLE", 0)
    boundary_rate = boundary_bad / max(total_chunks, 1)
    dup_rate = (flag_counts.get("ADJACENT_DUPLICATE", 0) + flag_counts.get("DUPLICATE", 0)) / max(total_chunks, 1)
    short_rate = flag_counts.get("TOO_SHORT", 0) / max(total_chunks, 1)

    if boundary_rate >= 0.15 or (cm and cm.get("chunk_integrity", 1.0) < 0.80):
        signals.append({
            "layer": "CHUNKING",
            "code": "BROKEN_BOUNDARY",
            "severity": "high",
            "metric": f"Cờ cắt vỡ {round(boundary_rate * 100)}% · Integrity {round((cm.get('chunk_integrity', 0)) * 100) if cm else '—'}%",
            "detail": "Nhiều chunk bị cắt ngang câu, ngang danh sách hoặc vỡ bảng.",
        })
    if cm and cm.get("context_sufficiency", 1.0) < 0.78:
        signals.append({
            "layer": "CHUNKING",
            "code": "MISSING_CONTEXT",
            "severity": "medium",
            "metric": f"Context Sufficiency = {round(cm['context_sufficiency'] * 100)}%",
            "detail": "Chunk đứng độc lập bị thiếu chủ thể / tiêu đề mục cha.",
        })
    if dup_rate >= 0.12 or (cm and cm.get("duplicate_rate", 0.0) > 0.15):
        signals.append({
            "layer": "CHUNKING",
            "code": "HIGH_DUPLICATE",
            "severity": "medium",
            "metric": f"Duplicate flag = {round(dup_rate * 100)}%",
            "detail": "Overlap quá cao hoặc lặp header/footer giữa các chunk liền kề.",
        })

    # Retrieval signals
    if avg_cp is not None:
        if rc_counts.get("THRESHOLD", 0) >= 2:
            signals.append({
                "layer": "RETRIEVAL",
                "code": "THRESHOLD_TOO_HIGH",
                "severity": "high",
                "metric": f"{rc_counts['THRESHOLD']} câu rớt do Threshold",
                "detail": "Đáp án nằm trọn trong chunk (AC=FULL) nhưng bị ngưỡng similarity_threshold chặn.",
            })
        if rc_counts.get("KEYWORD", 0) >= 2 or rc_counts.get("VECTOR", 0) >= 2:
            signals.append({
                "layer": "RETRIEVAL",
                "code": "HYBRID_IMBALANCE",
                "severity": "high",
                "metric": f"Miss Keyword={rc_counts.get('KEYWORD', 0)} · Vector={rc_counts.get('VECTOR', 0)}",
                "detail": "Tỷ trọng Vector/BM25 chưa cân bằng cho truy vấn thuật ngữ/số liệu.",
            })
        if rc_counts.get("SIMILAR_DOC", 0) >= 2 or (avg_cp < 0.72 and not cur_ret["rerank_id"]):
            signals.append({
                "layer": "RETRIEVAL",
                "code": "NEEDS_RERANK",
                "severity": "high",
                "metric": f"Precision = {round(avg_cp * 100)}% · Nhầm tài liệu = {rc_counts.get('SIMILAR_DOC', 0)}",
                "detail": "Chunk đúng bị chìm xuống hạng dưới hoặc lẫn tài liệu tương tự vì chưa bật Rerank.",
            })
        total_ret_tc = max(len(tcs), 1)
        if ac_counts.get("SPLIT", 0) / total_ret_tc >= 0.25 or (class_avg_cp.get("Global", 1.0) < 0.55):
            signals.append({
                "layer": "RETRIEVAL",
                "code": "SPLIT_OR_GLOBAL_GAP",
                "severity": "medium",
                "metric": f"AC=SPLIT {ac_counts.get('SPLIT', 0)}/{total_ret_tc} · Global CP={round(class_avg_cp.get('Global', 0) * 100)}%",
                "detail": "Câu tổng hợp/multi-hop thiếu ngữ cảnh vì Top-K nhỏ hoặc chunk bị chia mảnh.",
            })

    # ---- 3. Build Concrete Candidate Config Packs ----
    packs: List[Dict[str, Any]] = []

    # Pack 1: Query-Time Quick Win (0 re-parse)
    ret_patch: Dict[str, Any] = {}
    ret_reasons: List[str] = []

    if rc_counts.get("THRESHOLD", 0) >= 1 or cur_ret["similarity_threshold"] > 0.15:
        new_th = 0.10 if rc_counts.get("THRESHOLD", 0) >= 2 else 0.15
        if abs(new_th - cur_ret["similarity_threshold"]) >= 0.04:
            ret_patch["similarity_threshold"] = new_th
            ret_reasons.append(f"Hạ similarity_threshold ({cur_ret['similarity_threshold']} → {new_th}) để không lọc nhầm chunk đúng.")

    # Hybrid weight tuning
    kw_heavy = (rc_counts.get("KEYWORD", 0) > rc_counts.get("VECTOR", 0)) or legal_ratio >= 0.25
    target_vw = 0.20 if kw_heavy else 0.45 if rc_counts.get("VECTOR", 0) >= 2 else 0.30
    if abs(target_vw - cur_ret["vector_similarity_weight"]) >= 0.05:
        ret_patch["vector_similarity_weight"] = target_vw
        ret_reasons.append(
            f"Điều chỉnh vector_similarity_weight ({cur_ret['vector_similarity_weight']} → {target_vw}) để "
            + ("ưu tiên khớp từ khóa/mã hiệu chính xác (BM25)." if kw_heavy else "tăng độ phủ ngữ nghĩa khi hỏi diễn giải.")
        )

    if not cur_ret["rerank_id"]:
        ret_patch["rerank_id"] = "BAAI/bge-reranker-v2-m3"
        ret_reasons.append("Bật Rerank (bge-reranker-v2-m3) để đẩy chunk đúng lên Top 1-3 và loại nhiễu tài liệu tương tự.")

    if not cur_ret["keyword_enabled"]:
        ret_patch["keyword_enabled"] = True
        ret_reasons.append("Bật Hybrid Keyword (BM25) kết hợp Vector.")

    if (ac_counts.get("SPLIT", 0) >= 3 or class_avg_cp.get("Global", 1.0) < 0.6) and cur_ret["top_k"] < 15:
        ret_patch["top_k"] = 15
        ret_reasons.append(f"Tăng Top-K ({cur_ret['top_k']} → 15) để gom đủ mảnh thông tin cho câu Global / Multi-hop.")
    elif cur_ret["rerank_id"] and cur_ret["top_k"] > 10:
        ret_patch["top_k"] = 8
        ret_reasons.append("Rerank đã bật nên thu gọn page_size về 8 để giảm nhiễu context.")

    if not ret_patch:
        ret_patch = {
            "similarity_threshold": 0.15,
            "vector_similarity_weight": 0.25 if legal_ratio >= 0.2 else 0.35,
            "top_k": 10,
            "rerank_id": cur_ret["rerank_id"] or "BAAI/bge-reranker-v2-m3",
            "keyword_enabled": True,
        }
        ret_reasons = ["Bộ tham số Retrieval cân bằng chuẩn giữa độ chính xác Top-3 và độ phủ ngữ cảnh."]

    packs.append({
        "id": "pack_retrieval_quickwin",
        "name": "Quick Win: Tối ưu Retrieval tức thì",
        "scope": "RETRIEVAL",
        "reparse_required": False,
        "priority": "P0 · Chạy ngay không cần parse lại",
        "summary": "Tinh chỉnh ngưỡng lọc, tỷ trọng Hybrid Vector/BM25, Top-K và Rerank trực tiếp trên index hiện tại.",
        "reasons": ret_reasons,
        "tradeoff": "0s re-index · Bật Rerank cộng thêm ~80-150ms mỗi truy vấn nhưng thường tăng +10% đến +20% Precision.",
        "index_patch": {},
        "retrieval_patch": ret_patch,
        "diff": [
            {"param": k, "from": cur_ret.get(k), "to": v}
            for k, v in ret_patch.items()
            if cur_ret.get(k) != v
        ],
    })

    # Pack 2: Chunking & Context Pack
    chk_patch: Dict[str, Any] = {}
    chk_reasons: List[str] = []
    if boundary_rate >= 0.12 or short_rate >= 0.10 or (cm and cm.get("chunk_integrity", 1.0) < 0.82):
        new_size = 768 if cur_idx["chunk_token_size"] <= 512 else 1024
        if new_size != cur_idx["chunk_token_size"]:
            chk_patch["chunk_token_size"] = new_size
            chk_reasons.append(f"Tăng chunk_token_size ({cur_idx['chunk_token_size']} → {new_size}) để giữ trọn đoạn/danh sách/bảng.")
    if dup_rate >= 0.12 and cur_idx["overlapped_percent"] > 10:
        chk_patch["overlapped_percent"] = 8
        chk_reasons.append(f"Giảm overlapped_percent ({cur_idx['overlapped_percent']}% → 8%) để hạn chế trùng lặp liền kề.")
    elif cur_idx["overlapped_percent"] == 0 and (boundary_rate >= 0.10 or ac_counts.get("SPLIT", 0) >= 2):
        chk_patch["overlapped_percent"] = 12
        chk_reasons.append("Tăng overlapped_percent (0% → 12%) để nối câu chuyển tiếp ở ranh giới chunk.")

    if (cm and cm.get("context_sufficiency", 1.0) < 0.80) or legal_ratio >= 0.25:
        if not cur_idx["use_parent_child"]:
            chk_patch["use_parent_child"] = True
            chk_reasons.append("Bật Parent-Child Chunking: index bằng đoạn nhỏ để match chính xác, trả về chunk cha đủ chủ thể.")
        if cur_idx["keywords_top_n"] == 0:
            chk_patch["keywords_top_n"] = 5
            chk_reasons.append("Bật Auto-Keywords (top_n=5) để gắn thêm từ khóa chủ đề vào chunk thiếu ngữ cảnh.")

    if table_ratio >= 0.25 and cur_idx["table_context_size"] < 256:
        chk_patch["table_context_size"] = 256
        chk_reasons.append("Tăng table_context_size (→ 256) để bảng luôn giữ kèm tiêu đề/ghi chú xung quanh.")

    if chk_patch:
        packs.append({
            "id": "pack_chunking_fix",
            "name": "Chunking & Context Recovery",
            "scope": "INDEX",
            "reparse_required": True,
            "priority": "P1 · Cần re-parse Dataset (hoặc Fork Dataset mới)",
            "summary": "Sửa triệt để lỗi cắt vỡ câu/bảng và thiếu chủ thể khi đọc chunk độc lập.",
            "reasons": chk_reasons,
            "tradeoff": "Cần re-parse lại tài liệu. Nếu bật Auto-Keywords sẽ tốn thêm token LLM lúc ingest.",
            "index_patch": chk_patch,
            "retrieval_patch": {},
            "diff": [
                {"param": k, "from": cur_idx.get(k), "to": v}
                for k, v in chk_patch.items()
                if cur_idx.get(k) != v
            ],
        })

    # Pack 3: Parser / OCR / Template Upgrade
    prs_patch: Dict[str, Any] = {}
    prs_reasons: List[str] = []
    if legal_ratio >= 0.30 and cur_idx["chunk_method"] != "laws":
        prs_patch["chunk_method"] = "laws"
        prs_reasons.append("Corpus có tỷ lệ điều khoản/quy định cao → đổi Chunk Method sang 'laws' để cắt theo Chương/Điều/Khoản.")
    elif table_ratio >= 0.50 and cur_idx["chunk_method"] not in ("table", "general", "naive"):
        prs_patch["chunk_method"] = "table"
        prs_reasons.append("Corpus chủ yếu là bảng biểu → thử template 'table'.")

    if scan_ratio >= 0.25 or (pm["rated_units"] > 0 and pm["text_completeness"] < 0.80):
        if cur_idx["pdf_parse_method"] == "Plain Text":
            prs_patch["pdf_parse_method"] = "DeepDOC"
            prs_reasons.append("Chuyển PDF Parser từ Plain Text sang DeepDOC (OCR + Layout + Table Recognition).")
        elif not cur_idx["enable_vision_enhancement"] and (scan_ratio >= 0.25 or pm.get("layout_accuracy", 1.0) is not None and (pm.get("layout_accuracy") or 1.0) < 0.75):
            prs_patch["enable_vision_enhancement"] = True
            prs_reasons.append("Bật Enable Vision Enhancement để VLM đọc bảng scan, biểu đồ và sơ đồ phức tạp.")

    if pm["rated_units"] > 0 and pm["table_total"] > 0 and pm["table_accuracy"] < 0.78 and cur_idx["table_context_size"] < 256:
        prs_patch["table_context_size"] = 256
        prs_reasons.append("Nâng table_context_size lên 256 để giữ ngữ cảnh bảng.")

    if prs_patch:
        packs.append({
            "id": "pack_parser_upgrade",
            "name": "Parser & Layout Specialization",
            "scope": "INDEX",
            "reparse_required": True,
            "priority": "P1 · Cần re-parse Dataset",
            "summary": "Chuyên biệt hóa bộ đọc file theo định dạng tài liệu (OCR/Layout/Template) để giảm rơi mất chữ và vỡ bảng.",
            "reasons": prs_reasons,
            "tradeoff": "DeepDOC / Vision Enhancement làm tăng thời gian parse (~2–4x trên file scan) nhưng cứu trực tiếp dữ liệu gốc bị mất.",
            "index_patch": prs_patch,
            "retrieval_patch": {},
            "diff": [
                {"param": k, "from": cur_idx.get(k), "to": v}
                for k, v in prs_patch.items()
                if cur_idx.get(k) != v
            ],
        })

    # Pack 4: Joint Optimal Recipe (Index + Retrieval)
    joint_idx = {**prs_patch, **chk_patch}
    if not joint_idx:
        joint_idx = {"chunk_token_size": 768, "overlapped_percent": 12, "table_context_size": 256}
    joint_ret = dict(ret_patch)
    # Harmonize top_k with chunk_token_size: larger chunks / parent-child need tighter top_k when rerank is on
    if joint_idx.get("use_parent_child") or joint_idx.get("chunk_token_size", cur_idx["chunk_token_size"]) >= 768:
        joint_ret["top_k"] = 8 if joint_ret.get("rerank_id") else 10
    joint_diff = (
        [{"param": f"index.{k}", "from": cur_idx.get(k), "to": v} for k, v in joint_idx.items() if cur_idx.get(k) != v]
        + [{"param": f"retrieval.{k}", "from": cur_ret.get(k), "to": v} for k, v in joint_ret.items() if cur_ret.get(k) != v]
    )
    if joint_diff:
        packs.append({
            "id": "pack_joint_recipe",
            "name": "Tổ hợp kép toàn diện (Index + Retrieval)",
            "scope": "JOINT",
            "reparse_required": True,
            "priority": "Khuyên dùng cho Run thử nghiệm B",
            "summary": "Đồng bộ cả kích thước/ngữ cảnh chunk lẫn ngưỡng tìm kiếm + Rerank để tối đa điểm cả 3 tầng.",
            "reasons": list(dict.fromkeys([*prs_reasons, *chk_reasons, *ret_reasons]))[:6],
            "tradeoff": "Phù hợp nhất khi tạo Dataset B (Fork) để chạy so sánh A/B chuẩn mực với Baseline.",
            "index_patch": joint_idx,
            "retrieval_patch": joint_ret,
            "diff": joint_diff,
        })

    # ---- 4. Tailored Retrieval Sweep Search Space ----
    vw_candidates = sorted({0.15, 0.25, 0.35, 0.55, round(cur_ret["vector_similarity_weight"], 2)})
    th_candidates = sorted({0.10, 0.20, round(cur_ret["similarity_threshold"], 2)})
    tk_candidates = sorted({5, 10, 15} | ({cur_ret["top_k"]} if cur_ret["top_k"] in (5, 8, 10, 12, 15, 20) else set()))
    rerank_candidates = ["", cur_ret["rerank_id"] or "BAAI/bge-reranker-v2-m3"]
    rerank_candidates = list(dict.fromkeys(rerank_candidates))

    return {
        "ok": True,
        "run_id": run_id,
        "run_name": run["name"],
        "current_config": current,
        "raw_parser_config": parser_cfg,
        "corpus_profile": corpus_profile,
        "baseline_metrics": {
            "parsing": pm if pm["rated_units"] > 0 else None,
            "chunking": cm if c_rows else None,
            "retrieval_avg_cp": avg_cp,
            "retrieval_by_class": class_avg_cp,
            "answer_containment": ac_counts,
            "root_cause_counts": rc_counts,
        },
        "failure_signals": signals,
        "candidate_packs": packs,
        "recommended_sweep_space": {
            "vector_similarity_weight": vw_candidates[:4],
            "similarity_threshold": th_candidates[:3],
            "top_k": tk_candidates[:3],
            "keyword_enabled": [True] if cur_ret["keyword_enabled"] else [True, False],
            "rerank_ids": rerank_candidates,
        },
    }
