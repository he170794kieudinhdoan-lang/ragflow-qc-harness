"""
Canary Index-Time Tuner & Joint Recipe Finder (Phase 2).

Selects 3-5 representative & hardest "Canary" documents from a run, spins up isolated temporary
RAGFlow datasets for 2-4 candidate Index Config variants (inheriting the baseline embedding_model),
uploads & parses ONLY the Canary subset, evaluates all 3 layers (Parsing Alignment + 100% Chunking
Rules + Joint Retrieval Mini-Sweep using Content-Hash Cache), and returns the Winning Joint Recipe.
"""

import asyncio
import json
import os
import time
from typing import Any, Dict, List, Optional, Tuple

from config_advisor import analyze_and_propose_configs, merge_index_knobs_into_parser_config
from database import UPLOAD_DIR, get_bool_setting, get_current_account_key, get_db, get_float_setting, get_int_setting, get_setting, utc_now
from metrics import (
    align_unit_to_chunks,
    analyze_chunk_rules,
    detect_duplicates_classified,
    extract_best_aligned_span_with_stitching,
    mark_pareto_frontier,
    nfc,
)
from optimizer_engine import (
    CANCEL_STUDY_FLAGS,
    _aggregate_trial_metrics,
    _evaluate_trial_testcases,
    _resolve_judge_cfg,
)
from ragflow_client import RAGFlowClient

_DONE_STATUSES = {"3", "DONE", "SUCCESS", "COMPLETED"}
_FAIL_STATUSES = {"4", "2", "FAIL", "FAILED", "CANCEL", "CANCELED", "CANCELLED"}


def select_canary_candidates(run_id: int, max_docs: int = 4) -> Dict[str, Any]:
    """
    Ranks documents in `run_id` by difficulty + format diversity + Golden testcase coverage,
    proposing 3-5 Canary documents and 3-4 ready-to-test Index Config variants.
    """
    advisor = analyze_and_propose_configs(run_id)
    acct = get_current_account_key()

    with get_db() as conn:
        docs = conn.execute(
            """
            SELECT d.*, rd.ragflow_doc_id, rd.parse_status, rd.chunk_count, rd.parse_duration_sec, rd.anomaly_flags
            FROM documents d
            JOIN run_documents rd ON rd.document_id = d.id
            WHERE rd.run_id = ?
            ORDER BY d.doc_code
            """,
            (run_id,),
        ).fetchall()

        pu_rows = conn.execute(
            "SELECT document_id, unit_type, verdict, char_error FROM parsing_units WHERE run_id = ?",
            (run_id,),
        ).fetchall()

        chunk_rows = conn.execute(
            "SELECT document_id, rule_flags FROM chunks WHERE run_id = ?",
            (run_id,),
        ).fetchall()

        if acct:
            tcs = conn.execute(
                "SELECT id, tc_code, source_file FROM golden_testcases WHERE account_key = ? OR account_key = ''",
                (acct,),
            ).fetchall()
        else:
            tcs = conn.execute("SELECT id, tc_code, source_file FROM golden_testcases").fetchall()

    pu_stats: Dict[int, Dict[str, int]] = {}
    for u in pu_rows:
        st = pu_stats.setdefault(u["document_id"], {"total": 0, "fail": 0, "table_fail": 0})
        st["total"] += 1
        if u["verdict"] in ("FAIL", "PARTIAL"):
            st["fail"] += 1
            if u["unit_type"] == "table":
                st["table_fail"] += 1

    chk_stats: Dict[int, Dict[str, int]] = {}
    for c in chunk_rows:
        st = chk_stats.setdefault(c["document_id"], {"total": 0, "flagged": 0})
        st["total"] += 1
        try:
            fls = json.loads(c["rule_flags"] or "[]")
        except Exception:
            fls = []
        if fls:
            st["flagged"] += 1

    scored_docs: List[Dict[str, Any]] = []
    for d in docs:
        did = d["id"]
        fname = (d["filename"] or "").lower()
        dcode = (d["doc_code"] or "").lower()
        matching_tcs = sum(
            1 for tc in tcs
            if fname and (fname in (tc["source_file"] or "").lower() or (dcode and dcode in (tc["source_file"] or "").lower()))
        )
        p_st = pu_stats.get(did, {"total": 0, "fail": 0, "table_fail": 0})
        c_st = chk_stats.get(did, {"total": 0, "flagged": 0})

        p_fail_rate = p_st["fail"] / max(p_st["total"], 1)
        c_flag_rate = c_st["flagged"] / max(c_st["total"], 1)
        is_scan = bool(d["is_scan"] == 1 or "scan" in (d["format_group"] or "").lower())
        has_table = bool(d["has_tables"] == 1 or "bảng" in (d["format_group"] or "").lower() or "excel" in (d["format_group"] or "").lower())
        zero_chunks = (d["chunk_count"] or 0) == 0

        diff_score = (
            p_fail_rate * 3.0
            + c_flag_rate * 2.5
            + (1.5 if p_st["table_fail"] > 0 else 0.0)
            + (1.0 if is_scan else 0.0)
            + (0.8 if has_table else 0.0)
            + (2.0 if zero_chunks else 0.0)
            + min(2.0, matching_tcs * 0.35)
        )
        reasons = []
        if p_st["fail"] > 0:
            reasons.append(f"{p_st['fail']}/{p_st['total']} đoạn Parsing lỗi")
        if c_st["flagged"] > 0:
            reasons.append(f"{c_st['flagged']}/{c_st['total']} chunk có cờ")
        if is_scan:
            reasons.append("PDF scan/ảnh")
        if has_table:
            reasons.append("Có bảng biểu")
        if matching_tcs > 0:
            reasons.append(f"{matching_tcs} câu Golden")

        scored_docs.append({
            "id": did,
            "doc_code": d["doc_code"],
            "filename": d["filename"],
            "format_group": d["format_group"],
            "page_count": d["page_count"],
            "chunk_count": d["chunk_count"] or 0,
            "has_local_file": bool(d["file_path"] and os.path.exists(d["file_path"])),
            "golden_tc_count": matching_tcs,
            "difficulty_score": round(diff_score, 2),
            "reasons": reasons,
            "recommended": False,
        })

    # Pick diverse + hardest up to `max_docs`
    ranked = sorted(scored_docs, key=lambda x: (-x["difficulty_score"], -x["golden_tc_count"], x["doc_code"]))
    picked_ids = set()
    seen_groups = set()
    for item in ranked:
        if len(picked_ids) >= max_docs:
            break
        grp = item["format_group"] or "other"
        if grp not in seen_groups:
            seen_groups.add(grp)
            picked_ids.add(item["id"])
    for item in ranked:
        if len(picked_ids) >= max_docs:
            break
        picked_ids.add(item["id"])

    for item in scored_docs:
        item["recommended"] = item["id"] in picked_ids

    # Build 3-4 sensible Index Variants from Advisor + standard alternatives
    cur_idx = advisor["current_config"]["index"]
    variants: List[Dict[str, Any]] = [
        {
            "id": "canary_baseline",
            "name": "Baseline (Cấu hình hiện tại)",
            "description": f"{cur_idx['chunk_method']} · {cur_idx['pdf_parse_method']} · {cur_idx['chunk_token_size']} tok · overlap {cur_idx['overlapped_percent']}%",
            "index_patch": {},
            "is_baseline": True,
        }
    ]

    seen_patches = {json.dumps({}, sort_keys=True)}
    for pack in advisor.get("candidate_packs", []):
        if pack.get("reparse_required") and pack.get("index_patch"):
            sig = json.dumps(pack["index_patch"], sort_keys=True)
            if sig not in seen_patches:
                seen_patches.add(sig)
                variants.append({
                    "id": f"canary_{pack['id']}",
                    "name": pack["name"],
                    "description": pack["summary"],
                    "index_patch": pack["index_patch"],
                    "is_baseline": False,
                })

    # Ensure at least 3 variants by adding a Parent-Child or Larger-Chunk fallback if needed
    fallback_candidates = [
        {
            "id": "canary_chunk_768_ovl12",
            "name": "Chunk 768 + Overlap 12% + Table Context 256",
            "description": "Tăng kích thước chunk để giữ trọn đoạn/bảng và thêm 12% overlap tránh cắt ngang câu.",
            "index_patch": {
                "chunk_token_size": 768 if cur_idx["chunk_token_size"] != 768 else 1024,
                "overlapped_percent": 12,
                "table_context_size": 256,
            },
            "is_baseline": False,
        },
        {
            "id": "canary_parent_child",
            "name": "Parent-Child Chunking + DeepDOC",
            "description": "Tìm kiếm chính xác trên chunk con, trả về chunk cha đủ chủ thể và ngữ cảnh.",
            "index_patch": {
                "pdf_parse_method": "DeepDOC",
                "use_parent_child": True,
                "chunk_token_size": 768,
                "table_context_size": 256,
            },
            "is_baseline": False,
        },
    ]
    for fb in fallback_candidates:
        if len(variants) >= 4:
            break
        sig = json.dumps(fb["index_patch"], sort_keys=True)
        if sig not in seen_patches:
            seen_patches.add(sig)
            variants.append(fb)

    return {
        "ok": True,
        "run_id": run_id,
        "documents": scored_docs,
        "recommended_doc_ids": sorted(picked_ids),
        "total_golden_testcases": len(tcs),
        "variants": variants[:4],
    }


def _eval_canary_chunking_rules(chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Runs 100% deterministic rule-engine QC over Canary chunks."""
    if not chunks:
        return {
            "chunk_count": 0,
            "chunk_integrity": 0.0,
            "size_compliance": 0.0,
            "clean_rate": 0.0,
            "no_dup_rate": 0.0,
            "chunking_score": 0.0,
        }

    min_chars = get_int_setting("min_chunk_chars", 50)
    max_chars = get_int_setting("max_chunk_chars", 2600)
    exempt_intact_table = get_bool_setting("exempt_intact_table_from_max_chars", True)
    dup_threshold = get_float_setting("chunk_dup_threshold", 0.85)
    adj_overlap_threshold = get_float_setting("chunk_adj_overlap_threshold", 88.0)
    repeated_line_min = max(2, get_int_setting("chunk_repeated_line_min", 3))

    adj_dups, far_dups = detect_duplicates_classified(
        chunks,
        threshold=dup_threshold,
        adj_overlap_threshold=adj_overlap_threshold,
    )

    by_doc: Dict[Any, List[Dict[str, Any]]] = {}
    pos_map: Dict[Tuple[Any, int], Dict[str, Any]] = {}
    for ch in chunks:
        by_doc.setdefault(ch["document_id"], []).append(ch)
        pos_map[(ch["document_id"], ch["chunk_index"])] = ch

    repeated_by_doc: Dict[Any, set] = {}
    for doc_id, clist in by_doc.items():
        lc: Dict[str, int] = {}
        for ch in clist:
            seen = set()
            for ln in nfc(ch["content"]).splitlines():
                s = ln.strip()
                if 6 <= len(s) <= 100 and s not in seen:
                    seen.add(s)
                    lc[s] = lc.get(s, 0) + 1
        repeated_by_doc[doc_id] = {ln for ln, cnt in lc.items() if cnt >= repeated_line_min}

    n = len(chunks)
    integ_ok = 0
    size_ok = 0
    clean_ok = 0
    dup_ok = 0
    for ch in chunks:
        doc_id = ch["document_id"]
        prev_ch = pos_map.get((doc_id, ch["chunk_index"] - 1))
        next_ch = pos_map.get((doc_id, ch["chunk_index"] + 1))
        res = analyze_chunk_rules(
            ch,
            prev_content=prev_ch["content"] if prev_ch else "",
            next_content=next_ch["content"] if next_ch else "",
            repeated_lines=repeated_by_doc.get(doc_id, set()),
            is_adj_dup=ch["id"] in adj_dups,
            is_far_dup=ch["id"] in far_dups,
            min_chars=min_chars,
            max_chars=max_chars,
            exempt_intact_table=exempt_intact_table,
        )
        integ_ok += 1 if res["integrity"] == 1 else 0
        size_ok += 1 if res["valid_size"] == 1 else 0
        clean_ok += 1 if res["no_noise"] == 1 else 0
        dup_ok += 1 if res["no_duplicate"] == 1 else 0

    r_integ = round(integ_ok / n, 4)
    r_size = round(size_ok / n, 4)
    r_clean = round(clean_ok / n, 4)
    r_dup = round(dup_ok / n, 4)
    score = round(0.40 * r_integ + 0.25 * r_size + 0.20 * r_clean + 0.15 * r_dup, 4)
    return {
        "chunk_count": n,
        "chunk_integrity": r_integ,
        "size_compliance": r_size,
        "clean_rate": r_clean,
        "no_dup_rate": r_dup,
        "chunking_score": score,
    }


def _eval_canary_parsing_alignment(
    parsing_units: List[Dict[str, Any]],
    chunks: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Evaluates how well Canary chunks preserve the ground-truth `parsing_units`."""
    units = [
        u for u in parsing_units
        if (u.get("source_text") or "").strip()
        and not (u.get("source_text") or "").strip().startswith(("[Trang ", "[Hình ảnh"))
    ]
    if not units:
        return {"unit_count": 0, "parsing_pass_rate": None, "avg_similarity": None, "parsing_score": None}

    by_doc: Dict[int, List[Dict[str, Any]]] = {}
    by_pos: Dict[Tuple[int, int], Dict[str, Any]] = {}
    by_id: Dict[str, Dict[str, Any]] = {}
    for ch in chunks:
        by_doc.setdefault(ch["document_id"], []).append(ch)
        by_pos[(ch["document_id"], ch["chunk_index"])] = ch
        by_id[ch["ragflow_chunk_id"]] = ch

    pass_sum = 0.0
    sim_sum = 0.0
    for u in units:
        doc_chunks = by_doc.get(u["document_id"], [])
        if not doc_chunks:
            continue
        mids, _ = align_unit_to_chunks(u["source_text"], doc_chunks, page_num=u.get("page_num"))
        top = next((by_id[cid] for cid in mids if cid in by_id), None)
        if not top:
            continue
        prev_c = by_pos.get((top["document_id"], top["chunk_index"] - 1))
        next_parts = [
            by_pos[(top["document_id"], top["chunk_index"] + off)]["content"]
            for off in (1, 2, 3)
            if (top["document_id"], top["chunk_index"] + off) in by_pos
        ]
        aln = extract_best_aligned_span_with_stitching(
            u["source_text"][:4000],
            top["content"][:6000],
            prev_chunk_content=prev_c["content"][:3000] if prev_c else "",
            prev_chunk_index=prev_c["chunk_index"] if prev_c else None,
            next_chunk_content="\n".join(next_parts)[:6000],
            next_chunk_index=top["chunk_index"] + 1 if next_parts else None,
            unit_type=u.get("unit_type") or "text",
            format_group=u.get("format_group") or "",
        )
        sim = float(aln.get("text_similarity") or 0.0) / 100.0
        sim_sum += sim
        sv = aln.get("suggested_verdict")
        if sv == "PASS":
            pass_sum += 1.0
        elif sv == "PARTIAL":
            pass_sum += 0.5

    n = len(units)
    pass_rate = round(pass_sum / n, 4)
    avg_sim = round(sim_sum / n, 4)
    score = round(0.55 * pass_rate + 0.45 * avg_sim, 4)
    return {
        "unit_count": n,
        "parsing_pass_rate": pass_rate,
        "avg_similarity": avg_sim,
        "parsing_score": score,
    }


async def run_canary_optimization_study(
    study_id: int,
    run_id: int,
    baseline_dataset_id: str,
    study_name: str,
    doc_ids: List[int],
    variants: List[Dict[str, Any]],
    retrieval_configs: List[Dict[str, Any]],
    objective_profile: str = "balanced",
    judge_engine: str = "rule",
    cleanup_sandbox: bool = True,
) -> None:
    """
    Background worker running Canary Index-Time Optimization across `variants`.
    Each variant creates a temporary RAGFlow dataset for `doc_ids`, parses them,
    evaluates 3 layers (Parsing + Chunking + Retrieval mini-sweep), and cleans up.
    """
    CANCEL_STUDY_FLAGS[study_id] = False
    created_sandbox_ids: List[str] = []

    try:
        base_url = get_setting("ragflow_base_url", "")
        api_key = get_setting("ragflow_api_key", "")
        if not base_url or not api_key:
            raise ValueError("Chưa cấu hình RAGFlow URL/API Key trong Settings.")
        judge_cfg = _resolve_judge_cfg(judge_engine)
        client = RAGFlowClient(base_url, api_key)

        baseline_ds = await client.get_dataset(baseline_dataset_id)
        embedding_model = (baseline_ds or {}).get("embedding_model") or None

        acct = get_current_account_key()
        with get_db() as conn:
            run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            base_pc = json.loads((run["parser_config"] if run else "{}") or "{}")

            ph = ",".join("?" for _ in doc_ids)
            canary_docs = [
                dict(r)
                for r in conn.execute(
                    f"""
                    SELECT d.*, COALESCE(rd.ragflow_doc_id, '') AS ragflow_doc_id
                    FROM documents d
                    LEFT JOIN run_documents rd ON rd.document_id = d.id AND rd.run_id = ?
                    WHERE d.id IN ({ph})
                    ORDER BY d.doc_code
                    """,
                    [run_id, *doc_ids],
                ).fetchall()
            ]
            if not canary_docs:
                raise ValueError("Không tìm thấy tài liệu Canary đã chọn.")

            pu_rows = [
                dict(r)
                for r in conn.execute(
                    f"""
                    SELECT pu.*, d.format_group
                    FROM parsing_units pu
                    JOIN documents d ON d.id = pu.document_id
                    WHERE pu.run_id = ? AND pu.document_id IN ({ph})
                    ORDER BY pu.document_id, pu.unit_index
                    """,
                    [run_id, *doc_ids],
                ).fetchall()
            ]

            if acct:
                all_tcs = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM golden_testcases WHERE account_key = ? OR account_key = '' ORDER BY tc_code",
                        (acct,),
                    ).fetchall()
                ]
            else:
                all_tcs = [dict(r) for r in conn.execute("SELECT * FROM golden_testcases ORDER BY tc_code").fetchall()]

            mem_id_cache = {
                (r["testcase_id"], r["ragflow_chunk_id"]): (r["relevant"], r["reason"])
                for r in conn.execute("SELECT * FROM relevancy_cache").fetchall()
            }
            mem_hash_cache = {
                (r["testcase_id"], r["content_hash"]): (r["relevant"], r["reason"])
                for r in conn.execute("SELECT * FROM relevancy_content_cache").fetchall()
            }

        # Filter Golden Testcases tied to Canary docs (fallback to first 15 if none match by filename)
        canary_names = {(d["filename"] or "").lower() for d in canary_docs if d.get("filename")}
        canary_codes = {(d["doc_code"] or "").lower() for d in canary_docs if d.get("doc_code")}
        canary_tcs = [
            tc for tc in all_tcs
            if any(fn in (tc.get("source_file") or "").lower() for fn in canary_names)
            or any(dc in (tc.get("source_file") or "").lower() for dc in canary_codes)
        ]
        if len(canary_tcs) < 3:
            canary_tcs = all_tcs[: min(15, len(all_tcs))]

        # Ensure local file bytes exist for every Canary doc
        doc_bytes_map: Dict[int, bytes] = {}
        for d in canary_docs:
            fp = d.get("file_path") or ""
            if fp and os.path.exists(fp):
                with open(fp, "rb") as f:
                    doc_bytes_map[d["id"]] = f.read()
            elif d.get("ragflow_doc_id"):
                b = await client.download_document(baseline_dataset_id, d["ragflow_doc_id"])
                safe_name = os.path.basename(d["filename"] or f"{d['doc_code']}.bin")
                save_fp = os.path.join(UPLOAD_DIR, f"{d['doc_code']}_{safe_name}")
                with open(save_fp, "wb") as f:
                    f.write(b)
                with get_db() as conn:
                    conn.execute("UPDATE documents SET file_path = ? WHERE id = ?", (save_fp, d["id"]))
                doc_bytes_map[d["id"]] = b

        uploadable_docs = [d for d in canary_docs if d["id"] in doc_bytes_map]
        if not uploadable_docs:
            raise ValueError("Không lấy được nội dung file gốc của các tài liệu Canary.")

        total_variants = len(variants)
        with get_db() as conn:
            conn.execute(
                "UPDATE optimization_studies SET progress_done = 0, progress_total = ?, stage_label = ?, updated_at = ? WHERE id = ?",
                (total_variants, f"Chuẩn bị {len(uploadable_docs)} file Canary · {len(canary_tcs)} câu Golden...", utc_now(), study_id),
            )

        rag_sem = asyncio.Semaphore(3)
        judge_sem = asyncio.Semaphore(2 if judge_cfg["engine"] == "llm" else (4 if judge_cfg["engine"] == "jev" else 16))

        variant_records: List[Dict[str, Any]] = []

        for v_idx, var in enumerate(variants, start=1):
            if CANCEL_STUDY_FLAGS.get(study_id):
                with get_db() as conn:
                    conn.execute("UPDATE optimization_studies SET status = 'CANCELLED', updated_at = ? WHERE id = ?", (utc_now(), study_id))
                return

            v_name = var.get("name") or f"Variant {v_idx}"
            index_patch = var.get("index_patch") or {}
            merged_pc = merge_index_knobs_into_parser_config(base_pc, index_patch) if index_patch else base_pc
            chunk_method = str(merged_pc.get("chunk_method") or merged_pc.get("parser_id") or "general")

            with get_db() as conn:
                conn.execute(
                    "UPDATE optimization_studies SET stage_label = ?, updated_at = ? WHERE id = ?",
                    (f"[{v_idx}/{total_variants}] Tạo & parse sandbox: {v_name}...", utc_now(), study_id),
                )

            ds_name = f"CANARY_S{study_id}_V{v_idx}_{int(time.time()) % 10000}"
            ds = await client.create_dataset(
                name=ds_name,
                chunk_method=chunk_method,
                embedding_model=embedding_model,
                parser_config=merged_pc or None,
                description=f"Canary Study #{study_id}: {v_name}",
            )
            sandbox_ds_id = ds.get("id", "")
            if not sandbox_ds_id:
                raise RuntimeError(f"Không tạo được sandbox dataset trên RAGFlow cho {v_name}.")
            created_sandbox_ids.append(sandbox_ds_id)

            # Upload Canary files & trigger parse
            remote_doc_to_local: Dict[str, Dict[str, Any]] = {}
            remote_doc_ids: List[str] = []
            for d in uploadable_docs:
                up_res = await client.upload_document(sandbox_ds_id, d["filename"], doc_bytes_map[d["id"]])
                r_id = ""
                if isinstance(up_res, list) and up_res and up_res[0].get("id"):
                    r_id = up_res[0]["id"]
                elif isinstance(up_res, dict) and up_res.get("id"):
                    r_id = up_res["id"]
                if r_id:
                    remote_doc_ids.append(r_id)
                    remote_doc_to_local[r_id] = d

            if not remote_doc_ids:
                raise RuntimeError(f"Upload file Canary thất bại ở {v_name}.")

            t_parse_start = time.perf_counter()
            await client.parse_documents(sandbox_ds_id, remote_doc_ids)

            # Poll RAGFlow until all Canary docs finish (max 360s)
            done_rids: List[str] = []
            for _ in range(120):
                if CANCEL_STUDY_FLAGS.get(study_id):
                    with get_db() as conn:
                        conn.execute("UPDATE optimization_studies SET status = 'CANCELLED', updated_at = ? WHERE id = ?", (utc_now(), study_id))
                    return
                await asyncio.sleep(3.0)
                rdocs = await client.list_documents(sandbox_ds_id, page=1, page_size=50)
                running = 0
                cur_done: List[str] = []
                for rd in rdocs:
                    raw_st = str(rd.get("ingestion_status") or rd.get("run") or "").upper()
                    c_cnt = int(rd.get("chunk_count") or 0)
                    if raw_st in _DONE_STATUSES or (c_cnt > 0 and raw_st not in _FAIL_STATUSES):
                        cur_done.append(rd["id"])
                    elif raw_st in _FAIL_STATUSES:
                        continue
                    else:
                        running += 1
                done_rids = cur_done
                if running == 0 and len(rdocs) >= len(remote_doc_ids):
                    break
            parse_duration_sec = round(time.perf_counter() - t_parse_start, 1)

            # Pull chunks in-memory
            pulled_chunks: List[Dict[str, Any]] = []
            seq_id = 1
            for rid in done_rids:
                loc_doc = remote_doc_to_local.get(rid)
                if not loc_doc:
                    continue
                raw_chunks = await client.list_all_chunks(sandbox_ds_id, rid)
                for idx_c, ch in enumerate(raw_chunks, start=1):
                    content = ch.get("content") or ch.get("content_with_weight") or ""
                    pulled_chunks.append({
                        "id": seq_id,
                        "document_id": loc_doc["id"],
                        "ragflow_chunk_id": str(ch.get("id") or ch.get("chunk_id") or f"{rid}_{idx_c}"),
                        "chunk_index": idx_c,
                        "content": content,
                        "char_count": len(content),
                    })
                    seq_id += 1

            # Evaluate Layer 1 (Parsing) + Layer 2 (Chunking)
            with get_db() as conn:
                conn.execute(
                    "UPDATE optimization_studies SET stage_label = ?, updated_at = ? WHERE id = ?",
                    (f"[{v_idx}/{total_variants}] Chấm Parsing, Chunking & Retrieval: {v_name}...", utc_now(), study_id),
                )
            p_metrics = _eval_canary_parsing_alignment(pu_rows, pulled_chunks)
            c_metrics = _eval_canary_chunking_rules(pulled_chunks)

            # Evaluate Layer 3 (Retrieval mini-sweep using Content-Hash Cache)
            best_ret_cfg = retrieval_configs[0]
            best_ret_agg = {
                "testcase_count": 0, "avg_cp": 0.0, "avg_cc": 0.0, "avg_mrr": 0.0,
                "hit_at_1": 0.0, "hit_at_3": 0.0, "hit_at_k": 0.0,
                "avg_latency_ms": 0.0, "avg_context_tokens": 0.0,
                "objective_score": 0.0, "cache_hits": 0, "judge_calls": 0,
            }
            if canary_tcs and pulled_chunks:
                best_obj = -1.0
                for r_cfg in retrieval_configs:
                    tc_out = await _evaluate_trial_testcases(
                        client, sandbox_ds_id, r_cfg, canary_tcs, judge_cfg,
                        mem_id_cache, mem_hash_cache, rag_sem, judge_sem,
                    )
                    agg = _aggregate_trial_metrics(tc_out, objective_profile)
                    if agg["objective_score"] > best_obj:
                        best_obj = agg["objective_score"]
                        best_ret_cfg = r_cfg
                        best_ret_agg = agg

            # Compute 3-layer Joint Score
            ret_score = best_ret_agg["objective_score"]
            chk_score = c_metrics["chunking_score"]
            prs_score = p_metrics["parsing_score"]
            if prs_score is not None:
                joint_score = round(0.25 * prs_score + 0.25 * chk_score + 0.50 * ret_score, 4)
            else:
                joint_score = round(0.35 * chk_score + 0.65 * ret_score, 4)

            trial_cfg = {
                "variant_id": var.get("id") or f"v{v_idx}",
                "variant_name": v_name,
                "is_baseline": bool(var.get("is_baseline")),
                "index_patch": index_patch,
                "chunk_method": chunk_method,
                **best_ret_cfg,
            }
            layer_metrics = {
                "parse_duration_sec": parse_duration_sec,
                "sandbox_dataset_id": sandbox_ds_id,
                "parsing": p_metrics,
                "chunking": c_metrics,
                "best_retrieval_config": best_ret_cfg,
                "joint_score": joint_score,
            }

            with get_db() as conn:
                cur = conn.execute(
                    """
                    INSERT INTO optimization_trials
                    (study_id, trial_index, stage, config_json, metrics_json, testcase_count, avg_cp, avg_cc, avg_mrr, hit_at_1, hit_at_3, hit_at_k, avg_latency_ms, avg_context_tokens, objective_score, is_pareto, cache_hits, judge_calls, status, created_at)
                    VALUES (?, ?, 'CANARY_VARIANT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'DONE', ?)
                    """,
                    (
                        study_id,
                        v_idx,
                        json.dumps(trial_cfg, ensure_ascii=False),
                        json.dumps(layer_metrics, ensure_ascii=False),
                        best_ret_agg["testcase_count"],
                        best_ret_agg["avg_cp"],
                        best_ret_agg["avg_cc"],
                        best_ret_agg["avg_mrr"],
                        best_ret_agg["hit_at_1"],
                        best_ret_agg["hit_at_3"],
                        best_ret_agg["hit_at_k"],
                        best_ret_agg["avg_latency_ms"],
                        best_ret_agg["avg_context_tokens"],
                        joint_score,
                        best_ret_agg["cache_hits"],
                        best_ret_agg["judge_calls"],
                        utc_now(),
                    ),
                )
                trial_db_id = cur.lastrowid
                conn.execute(
                    "UPDATE optimization_studies SET progress_done = ?, updated_at = ? WHERE id = ?",
                    (v_idx, utc_now(), study_id),
                )

            variant_records.append({
                "id": trial_db_id,
                "trial_index": v_idx,
                "config": trial_cfg,
                "metrics": layer_metrics,
                "avg_latency_ms": best_ret_agg["avg_latency_ms"],
                "objective_score": joint_score,
            })

            if cleanup_sandbox and sandbox_ds_id:
                try:
                    await client.delete_datasets([sandbox_ds_id])
                    created_sandbox_ids.remove(sandbox_ds_id)
                except Exception:
                    pass

        mark_pareto_frontier(variant_records, x_key="avg_latency_ms", y_key="objective_score")
        best_rec = max(variant_records, key=lambda r: (r["objective_score"], -r["avg_latency_ms"]))
        base_rec = next((r for r in variant_records if r["config"].get("is_baseline")), variant_records[0])

        with get_db() as conn:
            for r in variant_records:
                conn.execute(
                    "UPDATE optimization_trials SET is_pareto = ? WHERE id = ?",
                    (1 if r.get("is_pareto") else 0, r["id"]),
                )
            summary = {
                "study_mode": "CANARY_INDEX",
                "canary_doc_count": len(uploadable_docs),
                "canary_docs": [{"id": d["id"], "doc_code": d["doc_code"], "filename": d["filename"]} for d in uploadable_docs],
                "canary_testcase_count": len(canary_tcs),
                "best_trial_id": best_rec["id"],
                "best_variant_name": best_rec["config"]["variant_name"],
                "best_index_patch": best_rec["config"]["index_patch"],
                "best_retrieval_config": best_rec["metrics"]["best_retrieval_config"],
                "best_score": best_rec["objective_score"],
                "baseline_score": base_rec["objective_score"],
                "delta_score": round(best_rec["objective_score"] - base_rec["objective_score"], 4),
            }
            conn.execute(
                """
                UPDATE optimization_studies
                SET status = 'COMPLETED', stage_label = 'Hoàn tất Canary Tuner', best_trial_id = ?, summary_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (best_rec["id"], json.dumps(summary, ensure_ascii=False), utc_now(), study_id),
            )
    except Exception as e:
        with get_db() as conn:
            conn.execute(
                "UPDATE optimization_studies SET status = 'FAILED', error_message = ?, updated_at = ? WHERE id = ?",
                (str(e)[:400], utc_now(), study_id),
            )
    finally:
        CANCEL_STUDY_FLAGS.pop(study_id, None)
        if cleanup_sandbox and created_sandbox_ids:
            try:
                base_url = get_setting("ragflow_base_url", "")
                api_key = get_setting("ragflow_api_key", "")
                if base_url and api_key:
                    await RAGFlowClient(base_url, api_key).delete_datasets(created_sandbox_ids)
            except Exception:
                pass
