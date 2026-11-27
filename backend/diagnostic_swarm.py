"""
Multi-Agent Diagnostic & Config Hypothesis Swarm for RAGFlow QC Harness.

Implements a bounded 2-phase DAG over `asyncio`:
  Phase 0 (Deterministic Sampler): Extracts high-impact failure slices + optional PDF images
      and computes an `evidence_sig` for SQLite caching.
  Phase 1 (Parallel Forensic Agents):
      1. Parsing Forensic Agent (multimodal when Vision model is configured, else text-only)
      2. Chunk Topology Agent (prev/curr/next boundary & context inspection)
      3. Retrieval Contrastive Agent (Wrong Top-K vs Missing Gold Chunk / Pass->Fail regressions)
  Phase 2 (Hypothesis Synthesizer & Arbitrator):
      Reconciles cross-layer parameter conflicts, validates all patches against strict
      RAGFlow knob whitelists, and outputs testable Hypothesis Packs + diffs.
"""

import asyncio
import hashlib
import json
import os
import time
from typing import Any, Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, Field
from rapidfuzz import fuzz

from config_advisor import analyze_and_propose_configs
from database import get_current_account_key, get_db, get_setting, resolve_golden_run_id, utc_now
from llm_client import call_llm_json, call_llm_vision_json
from metrics import compute_contextual_precision, nfc


# ---------------------------------------------------------------------------
# Strict Knob Whitelist & Guardrails
# ---------------------------------------------------------------------------

INDEX_KNOB_SPECS: Dict[str, Dict[str, Any]] = {
    "chunk_method": {
        "type": "enum",
        "allowed": {"general", "naive", "laws", "table", "paper", "book", "manual", "qa", "presentation", "one"},
    },
    "pdf_parse_method": {"type": "enum", "allowed": {"DeepDOC", "Plain Text", "MinerU"}},
    "enable_vision_enhancement": {"type": "bool"},
    "chunk_token_size": {"type": "int", "min": 128, "max": 2048},
    "overlapped_percent": {"type": "int", "min": 0, "max": 40},
    "delimiters": {"type": "str", "max_len": 64},
    "table_context_size": {"type": "int", "min": 0, "max": 1024},
    "image_context_size": {"type": "int", "min": 0, "max": 1024},
    "use_parent_child": {"type": "bool"},
    "keywords_top_n": {"type": "int", "min": 0, "max": 10},
    "questions_top_n": {"type": "int", "min": 0, "max": 5},
    "filename_embd_weight": {"type": "float", "min": 0.0, "max": 1.0, "round": 2},
}

RETRIEVAL_KNOB_SPECS: Dict[str, Dict[str, Any]] = {
    "top_k": {"type": "int", "min": 3, "max": 30},
    "similarity_threshold": {"type": "float", "min": 0.0, "max": 0.9, "round": 2},
    "vector_similarity_weight": {"type": "float", "min": 0.0, "max": 1.0, "round": 2},
    "rerank_id": {"type": "str", "max_len": 120},
    "keyword_enabled": {"type": "bool"},
    "use_kg": {"type": "bool"},
}


class ForensicFinding(BaseModel):
    pattern: str
    severity: Literal["high", "medium", "low"] = "medium"
    summary: str
    evidence_refs: List[str] = Field(default_factory=list)


class LayerDiagnosis(BaseModel):
    layer: Literal["PARSING", "CHUNKING", "RETRIEVAL"]
    status: Literal["OK", "ISSUES_FOUND", "SKIPPED_NO_DATA", "FALLBACK_ERROR"] = "OK"
    headline: str = ""
    findings: List[ForensicFinding] = Field(default_factory=list)
    recommended_knobs: Dict[str, Any] = Field(default_factory=dict)
    vision_used: bool = False
    model_used: str = ""


class ConfigDiffRow(BaseModel):
    param: str
    from_val: Any = None
    to_val: Any = None


class HypothesisPack(BaseModel):
    id: str
    name: str
    scope: Literal["RETRIEVAL", "INDEX", "JOINT"] = "JOINT"
    reparse_required: bool = True
    priority: str = "AI Hypothesis"
    hypothesis_statement: str
    conflict_resolution: str = ""
    evidence_refs: List[str] = Field(default_factory=list)
    expected_gains: List[str] = Field(default_factory=list)
    regression_warnings: List[str] = Field(default_factory=list)
    index_patch: Dict[str, Any] = Field(default_factory=dict)
    retrieval_patch: Dict[str, Any] = Field(default_factory=dict)
    diff: List[Dict[str, Any]] = Field(default_factory=list)


class SwarmDiagnosisReport(BaseModel):
    ok: bool = True
    run_id: int
    run_name: str
    report_type: Literal["ADVISOR_SWARM", "REGRESSION_AUTOPSY"] = "ADVISOR_SWARM"
    cached: bool = False
    evidence_sig: str = ""
    model_used: str = ""
    models_by_agent: Dict[str, str] = Field(default_factory=dict)
    duration_ms: int = 0
    llm_calls: int = 0
    executive_summary: str = ""
    improvement_plan: List[str] = Field(default_factory=list)
    architecture_mode: str = "supervisor_worker"
    drilldown_triggered: bool = False
    supervisor_notes: List[str] = Field(default_factory=list)
    evidence_counts: Dict[str, int] = Field(default_factory=dict)
    layer_diagnoses: List[LayerDiagnosis] = Field(default_factory=list)
    hypothesis_packs: List[HypothesisPack] = Field(default_factory=list)
    regressions_analyzed: List[Dict[str, Any]] = Field(default_factory=list)
    created_at: str = ""


def _coerce_knob_value(raw_val: Any, spec: Dict[str, Any]) -> Tuple[bool, Any]:
    """Validates and clamps a single knob value against its spec."""
    kind = spec["type"]
    if raw_val is None:
        return False, None
    try:
        if kind == "bool":
            if isinstance(raw_val, bool):
                return True, raw_val
            if isinstance(raw_val, str):
                low = raw_val.strip().lower()
                if low in ("true", "1", "yes", "on"):
                    return True, True
                if low in ("false", "0", "no", "off"):
                    return True, False
            if isinstance(raw_val, (int, float)):
                return True, bool(raw_val)
            return False, None
        if kind == "int":
            val = int(round(float(raw_val)))
            return True, max(int(spec["min"]), min(int(spec["max"]), val))
        if kind == "float":
            val = float(raw_val)
            clamped = max(float(spec["min"]), min(float(spec["max"]), val))
            return True, round(clamped, int(spec.get("round", 2)))
        if kind == "enum":
            s = str(raw_val).strip()
            # Case-insensitive match returning canonical enum string
            for opt in spec["allowed"]:
                if s.lower() == opt.lower():
                    return True, opt
            return False, None
        if kind == "str":
            s = str(raw_val).strip()[: int(spec.get("max_len", 100))]
            return True, s
    except Exception:
        return False, None
    return False, None


def sanitize_patch(raw_patch: Any, specs: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Filters and clamps a candidate config patch strictly to whitelisted RAGFlow knobs."""
    if not isinstance(raw_patch, dict):
        return {}
    clean: Dict[str, Any] = {}
    for k, v in raw_patch.items():
        if k not in specs:
            continue
        ok, coerced = _coerce_knob_value(v, specs[k])
        if ok:
            clean[k] = coerced
    return clean


def build_diff_against_current(
    index_patch: Dict[str, Any],
    retrieval_patch: Dict[str, Any],
    current_config: Dict[str, Any],
) -> Tuple[Dict[str, Any], Dict[str, Any], List[Dict[str, Any]]]:
    """Drops no-op knobs that already match `current_config` and returns effective patches + diff list."""
    cur_idx = current_config.get("index") or {}
    cur_ret = current_config.get("retrieval") or {}

    eff_idx = {k: v for k, v in index_patch.items() if cur_idx.get(k) != v}
    eff_ret = {k: v for k, v in retrieval_patch.items() if cur_ret.get(k) != v}

    diff: List[Dict[str, Any]] = []
    if eff_idx and eff_ret:
        for k, v in eff_idx.items():
            diff.append({"param": f"index.{k}", "from": cur_idx.get(k), "to": v})
        for k, v in eff_ret.items():
            diff.append({"param": f"retrieval.{k}", "from": cur_ret.get(k), "to": v})
    else:
        for k, v in eff_idx.items():
            diff.append({"param": k, "from": cur_idx.get(k), "to": v})
        for k, v in eff_ret.items():
            diff.append({"param": k, "from": cur_ret.get(k), "to": v})
    return eff_idx, eff_ret, diff


# ---------------------------------------------------------------------------
# LLM Configuration & Safe Call Helpers
# ---------------------------------------------------------------------------

def _resolve_llm_creds() -> Tuple[str, str, str]:
    base = get_setting("llm_base_url", "").strip()
    key = get_setting("llm_api_key", "").strip()
    model = get_setting("llm_model", "").strip()
    if not base or not model or (not key and "localhost" not in base and "127.0.0.1" not in base):
        raise ValueError("Chưa cấu hình LLM (Base URL, Model, API Key) trong Cài đặt để chạy Multi-Agent.")
    return base, key, model


def _is_vision_capable_model(model_name: str) -> bool:
    low = (model_name or "").strip().lower()
    if not low or low in ("local-rapidocr", "rapidocr", "local"):
        return False
    return any(
        tok in low
        for tok in ("gemini", "gpt-4o", "gpt-4.1", "gpt-5", "claude", "vl", "qwen3.5", "qwen3.6", "qwen3.7", "llama-4", "mistral", "vision")
    )


def _resolve_swarm_models(fallback_model: str) -> Dict[str, str]:
    """Resolves per-agent models, falling back to `fallback_model` when unset."""
    fb = (fallback_model or "").strip()
    return {
        "parsing": get_setting("swarm_parsing_model", "").strip() or fb,
        "chunking": get_setting("swarm_chunking_model", "").strip() or fb,
        "retrieval": get_setting("swarm_retrieval_model", "").strip() or fb,
        "supervisor": get_setting("swarm_supervisor_model", "").strip() or fb,
    }


def _resolve_explicit_vision_creds() -> Optional[Tuple[str, str, str]]:
    """
    Returns Vision credentials when an explicit cloud Vision model is configured,
    ignoring local OCR placeholders (`local-rapidocr`), or falling back to a
    multimodal `swarm_parsing_model` on `llm_base_url`.
    """
    v_model = get_setting("vision_model", "").strip()
    if v_model and v_model.lower() not in ("local-rapidocr", "rapidocr", "local"):
        v_base = get_setting("vision_base_url", "").strip()
        if not v_base or v_base.lower() == "local":
            v_base = get_setting("llm_base_url", "").strip()
        v_key = get_setting("vision_api_key", "").strip() or get_setting("llm_api_key", "").strip()
        if v_base and (v_key or "localhost" in v_base or "127.0.0.1" in v_base):
            return v_base, v_key, v_model

    parsing_model = get_setting("swarm_parsing_model", "").strip()
    if _is_vision_capable_model(parsing_model):
        llm_base = get_setting("llm_base_url", "").strip()
        llm_key = get_setting("llm_api_key", "").strip()
        if llm_base and (llm_key or "localhost" in llm_base or "127.0.0.1" in llm_base):
            return llm_base, llm_key, parsing_model
    return None


async def _call_json_with_fallback(
    base_url: str,
    api_key: str,
    primary_model: str,
    fallback_model: str,
    sys_prompt: str,
    user_text: str,
    timeout: float = 55.0,
) -> Tuple[Dict[str, Any], str]:
    """Calls `primary_model` and falls back once to `fallback_model` if distinct and errored."""
    try:
        data = await call_llm_json(base_url, api_key, primary_model, sys_prompt, user_text, timeout=timeout)
        return data, primary_model
    except Exception:
        if fallback_model and fallback_model.strip() and fallback_model.strip() != primary_model.strip():
            data = await call_llm_json(base_url, api_key, fallback_model, sys_prompt, user_text, timeout=timeout)
            return data, fallback_model
        raise


# ---------------------------------------------------------------------------
# Deterministic Evidence Samplers
# ---------------------------------------------------------------------------

def _find_best_gold_chunk(
    target_text: str,
    chunk_rows: List[Dict[str, Any]],
    pu_by_doc_page: Optional[Dict[Tuple[int, int], str]] = None,
    pu_by_doc: Optional[Dict[int, str]] = None,
) -> Optional[Dict[str, Any]]:
    """Finds the single local chunk best matching `target_text` and attaches upstream layer flags."""
    target = nfc((target_text or "").strip()).lower()[:450]
    if len(target) < 8 or not chunk_rows:
        return None
    best_score = -1.0
    best_c: Optional[Dict[str, Any]] = None
    best_txt = ""
    for c in chunk_rows:
        txt = nfc(c.get("content") or "")
        txt_low = txt.lower()[:2200]
        if not txt_low:
            continue
        score = 0.65 * fuzz.partial_ratio(target, txt_low) + 0.35 * fuzz.token_set_ratio(target, txt_low)
        if score > best_score:
            best_score = score
            best_c = c
            best_txt = txt
    if not best_c:
        return None
    doc_id = best_c.get("document_id")
    page_num = best_c.get("page_num") or 1
    p_verdict = ""
    if doc_id is not None:
        if pu_by_doc_page and (doc_id, page_num) in pu_by_doc_page:
            p_verdict = pu_by_doc_page[(doc_id, page_num)]
        elif pu_by_doc and doc_id in pu_by_doc:
            p_verdict = pu_by_doc[doc_id]
    return {
        "chunk_id": best_c.get("ragflow_chunk_id") or "",
        "document_id": doc_id,
        "doc_code": best_c.get("doc_code") or "",
        "filename": best_c.get("filename") or "",
        "chunk_index": best_c.get("chunk_index"),
        "page_num": page_num,
        "rule_flags": best_c.get("rule_flags") or "[]",
        "linked_parsing_verdict": p_verdict or "UNKNOWN",
        "match_score": round(best_score, 1),
        "excerpt": best_txt[:420],
    }


def _find_gold_fragments(
    reference_context: str,
    fallback_question: str,
    chunk_rows: List[Dict[str, Any]],
    pu_by_doc_page: Optional[Dict[Tuple[int, int], str]] = None,
    pu_by_doc: Optional[Dict[int, str]] = None,
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
    """Splits Multi-hop/Global `reference_context` into fragments and matches each across all chunks."""
    import re as _re

    raw = nfc((reference_context or "").strip())
    parts = [
        p.strip()
        for p in _re.split(r"\[Đoạn\s+[A-Za-z0-9]+\]|\n{2,}", raw)
        if len(p.strip()) >= 20
    ]
    if not parts:
        target = raw or nfc((fallback_question or "").strip())
        one = _find_best_gold_chunk(target, chunk_rows, pu_by_doc_page, pu_by_doc)
        return one, ([one] if one else [])

    frags: List[Dict[str, Any]] = []
    for p in parts[:3]:
        m = _find_best_gold_chunk(p, chunk_rows, pu_by_doc_page, pu_by_doc)
        if m:
            frags.append(m)
    if not frags:
        return None, []
    best = max(frags, key=lambda x: x["match_score"])
    return best, frags


def _maybe_render_unit_image(file_path: str, page_num: int, source_text: str) -> Optional[bytes]:
    if not file_path or not os.path.exists(file_path):
        return None
    try:
        from routers.parsing import _parse_bbox_from_source, _render_unit_image_bytes

        bbox = _parse_bbox_from_source(source_text)
        return _render_unit_image_bytes(file_path, page_num or 1, bbox=bbox)
    except Exception:
        return None


def collect_run_evidence(run_id: int, include_vision: bool = True) -> Dict[str, Any]:
    """Extracts bounded, high-signal failure slices across Parsing, Chunking, and Retrieval."""
    advisor = analyze_and_propose_configs(run_id)
    acct = get_current_account_key()

    with get_db() as conn:
        all_pu_rows = [
            dict(r)
            for r in conn.execute(
                "SELECT document_id, page_num, verdict FROM parsing_units WHERE run_id = ?",
                (run_id,),
            ).fetchall()
        ]
        doc_rows = [
            dict(r)
            for r in conn.execute(
                """
                SELECT d.id, d.doc_code, d.filename, d.file_path
                FROM documents d
                JOIN run_documents rd ON rd.document_id = d.id
                WHERE rd.run_id = ?
                """,
                (run_id,),
            ).fetchall()
        ]

        pu_rows = [
            dict(r)
            for r in conn.execute(
                """
                SELECT pu.id, pu.document_id, pu.unit_index, pu.unit_type, pu.page_num, pu.title,
                       pu.source_text, pu.matched_chunk_ids, pu.match_score, pu.verdict,
                       pu.error_codes, pu.char_error, pu.fidelity_error, pu.notes,
                       d.doc_code, d.filename, d.format_group, d.file_path
                FROM parsing_units pu
                JOIN documents d ON d.id = pu.document_id
                WHERE pu.run_id = ? AND pu.verdict IN ('FAIL', 'PARTIAL')
                ORDER BY COALESCE(pu.fidelity_error, 0) DESC,
                         COALESCE(pu.char_error, 0) DESC,
                         CASE WHEN pu.unit_type = 'table' THEN 0 ELSE 1 END,
                         pu.match_score ASC
                LIMIT 6
                """,
                (run_id,),
            ).fetchall()
        ]

        all_chunks = [
            dict(r)
            for r in conn.execute(
                """
                SELECT c.id, c.document_id, c.ragflow_chunk_id, c.chunk_index, c.content,
                       c.char_count, c.token_est, c.page_num, c.rule_flags,
                       d.doc_code, d.filename
                FROM chunks c
                LEFT JOIN documents d ON d.id = c.document_id
                WHERE c.run_id = ?
                ORDER BY c.document_id, c.chunk_index
                """,
                (run_id,),
            ).fetchall()
        ]

        flagged_ce = [
            dict(r)
            for r in conn.execute(
                """
                SELECT ce.*, c.document_id, c.chunk_index, c.content, c.rule_flags, c.token_est,
                       d.doc_code, d.filename
                FROM chunk_evaluations ce
                JOIN chunks c ON c.id = ce.chunk_id
                LEFT JOIN documents d ON d.id = c.document_id
                WHERE ce.run_id = ?
                  AND (ce.integrity = 0 OR ce.context_sufficiency = 0 OR ce.no_noise = 0)
                ORDER BY COALESCE(ce.integrity, 1) ASC, COALESCE(ce.context_sufficiency, 1) ASC, c.id ASC
                LIMIT 8
                """,
                (run_id,),
            ).fetchall()
        ]

        latest_rr = conn.execute(
            "SELECT * FROM retrieval_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1",
            (run_id,),
        ).fetchone()

        retrieval_samples: List[Dict[str, Any]] = []
        golden_total = 0
        if latest_rr:
            owner_id = resolve_golden_run_id(conn, run_id)
            tcs = conn.execute(
                "SELECT * FROM golden_testcases WHERE run_id = ? ORDER BY tc_code",
                (owner_id,),
            ).fetchall()
            golden_total = len(tcs)
            hits = conn.execute(
                "SELECT * FROM retrieval_results WHERE retrieval_run_id = ? ORDER BY testcase_id, rank",
                (latest_rr["id"],),
            ).fetchall()
            metas = {
                m["testcase_id"]: dict(m)
                for m in conn.execute(
                    "SELECT * FROM testcase_eval_meta WHERE retrieval_run_id = ?",
                    (latest_rr["id"],),
                ).fetchall()
            }
            hits_by_tc: Dict[int, List[Dict[str, Any]]] = {}
            for h in hits:
                hits_by_tc.setdefault(h["testcase_id"], []).append(dict(h))

            failing_tcs: List[Tuple[float, str, Dict[str, Any], List[Dict[str, Any]], Dict[str, Any]]] = []
            suboptimal_tcs: List[Tuple[float, str, Dict[str, Any], List[Dict[str, Any]], Dict[str, Any]]] = []
            for tc in tcs:
                tc_hits = hits_by_tc.get(tc["id"], [])
                rels = [h["relevant"] for h in tc_hits if h["relevant"] is not None]
                cp = compute_contextual_precision(rels)
                meta = metas.get(tc["id"], {})
                ac_val = meta.get("answer_containment") or "UNCHECKED"
                passed = cp >= 0.5 and any(v == 1 for v in rels)
                if not passed:
                    failing_tcs.append((cp, "FAIL", dict(tc), tc_hits, meta))
                else:
                    rank1_miss = bool(rels) and rels[0] == 0
                    is_suboptimal = cp < 0.90 or rank1_miss or ac_val == "SPLIT"
                    if is_suboptimal:
                        suboptimal_tcs.append((cp, "SUBOPTIMAL", dict(tc), tc_hits, meta))

            # Balance FAIL cases across Local / Global / Multi-hop up to 8; backfill with SUBOPTIMAL cases if needed
            failing_tcs.sort(key=lambda x: (x[0], x[2].get("tc_code", "")))
            suboptimal_tcs.sort(key=lambda x: (x[0], x[2].get("tc_code", "")))
            picked: List[Tuple[float, str, Dict[str, Any], List[Dict[str, Any]], Dict[str, Any]]] = []
            picked_ids = set()
            for cls in ("Local", "Global", "Multi-hop"):
                cls_items = [it for it in failing_tcs if (it[2].get("question_class") or "Local") == cls]
                for it in cls_items[:3]:
                    if len(picked) < 8 and it[2]["id"] not in picked_ids:
                        picked.append(it)
                        picked_ids.add(it[2]["id"])
            for it in failing_tcs:
                if len(picked) >= 8:
                    break
                if it[2]["id"] not in picked_ids:
                    picked.append(it)
                    picked_ids.add(it[2]["id"])
            for it in suboptimal_tcs:
                if len(picked) >= 8:
                    break
                if it[2]["id"] not in picked_ids:
                    picked.append(it)
                    picked_ids.add(it[2]["id"])

            pu_by_doc_page: Dict[Tuple[int, int], str] = {}
            pu_by_doc: Dict[int, str] = {}
            for pr in all_pu_rows:
                did = pr["document_id"]
                pg = pr["page_num"] or 1
                verd = pr["verdict"] or "UNRATED"
                if verd in ("FAIL", "PARTIAL") or (did, pg) not in pu_by_doc_page:
                    pu_by_doc_page[(did, pg)] = verd
                if verd in ("FAIL", "PARTIAL") or did not in pu_by_doc:
                    pu_by_doc[did] = verd

            for cp, sample_level, tc, tc_hits, meta in picked:
                gold_chunk, gold_frags = _find_gold_fragments(
                    tc.get("reference_context") or "",
                    tc.get("input_question") or "",
                    all_chunks,
                    pu_by_doc_page=pu_by_doc_page,
                    pu_by_doc=pu_by_doc,
                )
                retrieval_samples.append({
                    "tc_code": tc["tc_code"],
                    "sample_level": sample_level,
                    "question": tc["input_question"][:280],
                    "expected_outcome": (tc.get("expected_outcome") or "")[:280],
                    "question_class": tc.get("question_class") or "Local",
                    "intent_type": tc.get("intent_type") or "Factoid",
                    "source_file": tc.get("source_file") or "",
                    "cp": round(cp, 3),
                    "answer_containment": meta.get("answer_containment", "UNCHECKED"),
                    "root_cause_layer": meta.get("root_cause_layer", ""),
                    "top_hits": [
                        {
                            "rank": h["rank"],
                            "doc_name": h.get("doc_name") or "",
                            "similarity": round(float(h.get("similarity") or 0.0), 3),
                            "relevant": h.get("relevant"),
                            "reason": (h.get("reason") or "")[:120],
                            "excerpt": nfc(h.get("content") or "")[:360],
                        }
                        for h in tc_hits[:3]
                    ],
                    "gold_candidate": gold_chunk,
                    "gold_fragments": gold_frags,
                })

    chunk_by_id = {c["ragflow_chunk_id"]: c for c in all_chunks}
    chunk_by_pos = {(c["document_id"], c["chunk_index"]): c for c in all_chunks}

    # Build Parsing slice (+ max 3 images if vision available)
    vision_creds = _resolve_explicit_vision_creds() if include_vision else None
    parsing_samples: List[Dict[str, Any]] = []
    parsing_images: List[Tuple[str, bytes]] = []
    for u in pu_rows[:4]:
        try:
            mids = json.loads(u.get("matched_chunk_ids") or "[]")
        except Exception:
            mids = []
        matched_text = "\n---\n".join(
            nfc(chunk_by_id[cid]["content"])[:750] for cid in mids[:2] if cid in chunk_by_id
        )
        ref_tag = f"{u['doc_code']}:PU#{u['unit_index']} (p.{u['page_num']})"
        parsing_samples.append({
            "ref": ref_tag,
            "unit_type": u["unit_type"],
            "verdict": u["verdict"],
            "error_codes": u["error_codes"],
            "char_error": u["char_error"],
            "fidelity_error": u["fidelity_error"],
            "source_text": nfc(u["source_text"])[:900],
            "parsed_text": matched_text or "(KHÔNG TÌM THẤY CHUNK KHỚP)",
            "notes": u.get("notes") or "",
        })
        if vision_creds and len(parsing_images) < 3:
            img_b = _maybe_render_unit_image(u.get("file_path") or "", u.get("page_num") or 1, u.get("source_text") or "")
            if img_b:
                parsing_images.append((ref_tag, img_b))

    # Build Chunking topology slice (fallback to rule-flagged chunks if chunk_evaluations empty)
    chunk_samples: List[Dict[str, Any]] = []
    seen_chunk_pks = set()
    for ce in flagged_ce[:5]:
        seen_chunk_pks.add(ce["chunk_id"])
        doc_id = ce["document_id"]
        idx = ce["chunk_index"]
        prev_c = chunk_by_pos.get((doc_id, idx - 1))
        next_c = chunk_by_pos.get((doc_id, idx + 1))
        chunk_samples.append({
            "ref": f"{ce.get('doc_code') or 'DOC'}#chunk-{idx}",
            "token_est": ce.get("token_est") or 0,
            "rule_flags": ce.get("rule_flags") or "[]",
            "eval_flags": {
                "integrity": ce.get("integrity"),
                "context_sufficiency": ce.get("context_sufficiency"),
                "no_noise": ce.get("no_noise"),
            },
            "prev_tail": nfc(prev_c["content"])[-220:] if prev_c else "",
            "content": nfc(ce["content"])[:700],
            "next_head": nfc(next_c["content"])[:220] if next_c else "",
        })

    if len(chunk_samples) < 5:
        for c in all_chunks:
            if c["id"] in seen_chunk_pks:
                continue
            try:
                fls = json.loads(c.get("rule_flags") or "[]")
            except Exception:
                fls = []
            if any(f in fls for f in ("BROKEN_TABLE", "BAD_BOUNDARY", "LIST_SPLIT", "TOO_SHORT", "REPEATED_BOILERPLATE")):
                seen_chunk_pks.add(c["id"])
                prev_c = chunk_by_pos.get((c["document_id"], (c["chunk_index"] or 0) - 1))
                next_c = chunk_by_pos.get((c["document_id"], (c["chunk_index"] or 0) + 1))
                chunk_samples.append({
                    "ref": f"{c.get('doc_code') or 'DOC'}#chunk-{c['chunk_index']}",
                    "token_est": c.get("token_est") or 0,
                    "rule_flags": json.dumps(fls),
                    "prev_tail": nfc(prev_c["content"])[-220:] if prev_c else "",
                    "content": nfc(c["content"])[:700],
                    "next_head": nfc(next_c["content"])[:220] if next_c else "",
                })
                if len(chunk_samples) >= 5:
                    break

    swarm_models = _resolve_swarm_models(get_setting("llm_model", "").strip())
    sig_payload = {
        "current_config": advisor["current_config"],
        "doc_count": advisor["corpus_profile"].get("doc_count", 0),
        "total_chunks": advisor["corpus_profile"].get("total_chunks", 0),
        "parsing_refs": [x["ref"] for x in parsing_samples],
        "chunk_refs": [x["ref"] for x in chunk_samples],
        "retrieval_refs": [(x["tc_code"], x["cp"], [h["rank"] for h in x["top_hits"]]) for x in retrieval_samples],
        "swarm_models": swarm_models,
    }
    evidence_sig = hashlib.sha256(json.dumps(sig_payload, sort_keys=True).encode("utf-8")).hexdigest()[:20]

    return {
        "run_id": run_id,
        "run_name": advisor["run_name"],
        "current_config": advisor["current_config"],
        "corpus_profile": advisor["corpus_profile"],
        "baseline_metrics": advisor["baseline_metrics"],
        "failure_signals": advisor["failure_signals"],
        "parsing_samples": parsing_samples,
        "parsing_images": parsing_images,
        "chunk_samples": chunk_samples,
        "retrieval_samples": retrieval_samples,
        "golden_total": golden_total,
        "evidence_sig": evidence_sig,
        "_all_chunks": all_chunks,
        "_doc_rows": doc_rows,
        "_capabilities": {
            "has_explicit_vision": bool(vision_creds),
            "configured_llm_model": get_setting("llm_model", "").strip(),
            "current_rerank_id": (advisor["current_config"].get("retrieval") or {}).get("rerank_id") or "",
            "pdf_parse_method": (advisor["current_config"].get("index") or {}).get("pdf_parse_method") or "DeepDOC",
        },
    }


def collect_compare_evidence(baseline_rr_id: int, candidate_rr_id: int) -> Dict[str, Any]:
    """Collects Pass->Fail regression samples and config diffs between two Retrieval Runs."""
    with get_db() as conn:
        b_rr = conn.execute("SELECT * FROM retrieval_runs WHERE id = ?", (baseline_rr_id,)).fetchone()
        c_rr = conn.execute("SELECT * FROM retrieval_runs WHERE id = ?", (candidate_rr_id,)).fetchone()
        if not b_rr or not c_rr:
            raise ValueError("Không tìm thấy Retrieval Run để giải phẫu.")

        run_id = int(c_rr["run_id"])
        owner_id = resolve_golden_run_id(conn, run_id)
        tcs = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM golden_testcases WHERE run_id = ? ORDER BY tc_code",
                (owner_id,),
            ).fetchall()
        ]
        b_hits_rows = [
            dict(r) for r in conn.execute(
                "SELECT * FROM retrieval_results WHERE retrieval_run_id = ? ORDER BY testcase_id, rank",
                (baseline_rr_id,),
            ).fetchall()
        ]
        c_hits_rows = [
            dict(r) for r in conn.execute(
                "SELECT * FROM retrieval_results WHERE retrieval_run_id = ? ORDER BY testcase_id, rank",
                (candidate_rr_id,),
            ).fetchall()
        ]
        all_chunks = [
            dict(r) for r in conn.execute(
                """
                SELECT c.id, c.document_id, c.ragflow_chunk_id, c.chunk_index, c.content,
                       c.page_num, c.rule_flags, d.doc_code, d.filename
                FROM chunks c
                LEFT JOIN documents d ON d.id = c.document_id
                WHERE c.run_id = ?
                """,
                (run_id,),
            ).fetchall()
        ]

    advisor = analyze_and_propose_configs(run_id)
    b_by_tc: Dict[int, List[Dict[str, Any]]] = {}
    c_by_tc: Dict[int, List[Dict[str, Any]]] = {}
    for h in b_hits_rows:
        b_by_tc.setdefault(h["testcase_id"], []).append(h)
    for h in c_hits_rows:
        c_by_tc.setdefault(h["testcase_id"], []).append(h)

    regressions: List[Dict[str, Any]] = []
    improvements_count = 0
    for tc in tcs:
        bh = b_by_tc.get(tc["id"], [])
        ch = c_by_tc.get(tc["id"], [])
        b_rels = [h["relevant"] for h in bh if h["relevant"] is not None]
        c_rels = [h["relevant"] for h in ch if h["relevant"] is not None]
        b_cp = compute_contextual_precision(b_rels)
        c_cp = compute_contextual_precision(c_rels)
        b_pass = b_cp >= 0.5 and any(v == 1 for v in b_rels)
        c_pass = c_cp >= 0.5 and any(v == 1 for v in c_rels)
        if not b_pass and c_pass:
            improvements_count += 1
        elif b_pass and not c_pass:
            regressions.append({
                "tc_id": tc["id"],
                "tc_code": tc["tc_code"],
                "question": tc["input_question"][:260],
                "expected_outcome": (tc.get("expected_outcome") or "")[:240],
                "question_class": tc.get("question_class") or "Local",
                "intent_type": tc.get("intent_type") or "Factoid",
                "source_file": tc.get("source_file") or "",
                "baseline_cp": round(b_cp, 3),
                "candidate_cp": round(c_cp, 3),
                "baseline_top3": [
                    {
                        "rank": h["rank"],
                        "doc_name": h.get("doc_name") or "",
                        "similarity": round(float(h.get("similarity") or 0.0), 3),
                        "relevant": h.get("relevant"),
                        "excerpt": nfc(h.get("content") or "")[:300],
                    }
                    for h in bh[:3]
                ],
                "candidate_top3": [
                    {
                        "rank": h["rank"],
                        "doc_name": h.get("doc_name") or "",
                        "similarity": round(float(h.get("similarity") or 0.0), 3),
                        "relevant": h.get("relevant"),
                        "excerpt": nfc(h.get("content") or "")[:300],
                    }
                    for h in ch[:3]
                ],
                "gold_candidate": _find_best_gold_chunk(
                    tc.get("reference_context") or tc.get("input_question") or "",
                    all_chunks[:1200],
                ),
            })

    b_cfg = {
        "top_k": int(b_rr["top_k"]),
        "similarity_threshold": float(b_rr["similarity_threshold"]),
        "vector_similarity_weight": float(b_rr["vector_similarity_weight"]),
        "rerank_id": b_rr["rerank_id"] or "",
        "keyword_enabled": bool(b_rr["keyword_enabled"]),
    }
    c_cfg = {
        "top_k": int(c_rr["top_k"]),
        "similarity_threshold": float(c_rr["similarity_threshold"]),
        "vector_similarity_weight": float(c_rr["vector_similarity_weight"]),
        "rerank_id": c_rr["rerank_id"] or "",
        "keyword_enabled": bool(c_rr["keyword_enabled"]),
    }

    sig_payload = {
        "b_id": baseline_rr_id,
        "c_id": candidate_rr_id,
        "b_cfg": b_cfg,
        "c_cfg": c_cfg,
        "reg_codes": [r["tc_code"] for r in regressions[:8]],
    }
    evidence_sig = hashlib.sha256(json.dumps(sig_payload, sort_keys=True).encode("utf-8")).hexdigest()[:20]

    return {
        "run_id": run_id,
        "run_name": advisor["run_name"],
        "baseline_rr_name": b_rr["name"],
        "candidate_rr_name": c_rr["name"],
        "baseline_ret_cfg": b_cfg,
        "candidate_ret_cfg": c_cfg,
        "current_config": {**advisor["current_config"], "retrieval": c_cfg},
        "corpus_profile": advisor["corpus_profile"],
        "improvements_count": improvements_count,
        "regressions": regressions[:8],
        "total_regressions": len(regressions),
        "evidence_sig": evidence_sig,
    }


# ---------------------------------------------------------------------------
# Phase 1: Parallel Forensic Agents
# ---------------------------------------------------------------------------

async def _run_parsing_forensic_agent(
    evidence: Dict[str, Any],
    llm_base: str,
    llm_key: str,
    llm_model: str,
    drilldown_instruction: str = "",
    override_samples: Optional[List[Dict[str, Any]]] = None,
    override_images: Optional[List[Tuple[str, bytes]]] = None,
    fallback_model: str = "",
) -> Tuple[LayerDiagnosis, int]:
    samples = override_samples if override_samples is not None else (evidence.get("parsing_samples") or [])
    if not samples:
        return LayerDiagnosis(
            layer="PARSING",
            status="SKIPPED_NO_DATA",
            headline="Không có đoạn nào bị lỗi đọc file trong phiên này.",
            model_used=llm_model,
        ), 0

    focus_note = f"\nYÊU CẦU KIỂM TRA BỔ SUNG TỪ ĐIỀU PHỐI VIÊN: {drilldown_instruction}\n" if drilldown_instruction else ""
    sys_prompt = (
        "Bạn là Chuyên viên Đọc tài liệu (Parsing Worker) kiểm tra chất lượng trích xuất PDF/DOCX/Excel tiếng Việt trên RAGFlow.\n"
        f"{focus_note}"
        "Hãy phân tích các mẫu lỗi dưới đây (và ảnh trang gốc nếu có) để tìm nguyên nhân gốc:\n"
        "- Lỗi OCR / mất hoặc sai dấu tiếng Việt?\n"
        "- Bảng biểu bị vỡ cột hoặc mất hàng?\n"
        "- PDF nhiều cột bị đọc lộn thứ tự?\n"
        "- Sơ đồ/biểu đồ/ảnh bị bỏ sót vì chưa bật đọc ảnh bằng AI?\n"
        "LƯU Ý QUAN TRỌNG: KHÔNG đề xuất hạ từ `DeepDOC` xuống `Plain Text` nếu bộ tài liệu có bảng biểu hoặc file scan.\n"
        "Viết `pattern`, `headline`, `summary` bằng tiếng Việt tự nhiên, dễ hiểu (KHÔNG dùng mã tiếng Anh viết hoa kiểu BROKEN_TABLE).\n"
        "CHỈ đề xuất các thông số Parsing hợp lệ: "
        "{pdf_parse_method: 'DeepDOC'|'Plain Text'|'MinerU', enable_vision_enhancement: bool, "
        "chunk_method: 'general'|'laws'|'table'|'paper'|'manual', table_context_size: 0..1024, image_context_size: 0..1024}.\n"
        "Trả về DUY NHẤT JSON hợp lệ:\n"
        '{"headline": "tóm tắt 1 câu tự nhiên", '
        '"findings": [{"pattern": "tên lỗi ngắn bằng tiếng Việt tự nhiên", "severity": "high|medium|low", "summary": "giải thích nguyên nhân dễ hiểu", "evidence_refs": ["mã mẫu"]}], '
        '"recommended_knobs": {"pdf_parse_method": "...", ...}}'
    )
    user_text = (
        f"Cấu hình đọc/cắt hiện tại: {json.dumps(evidence['current_config']['index'], ensure_ascii=False)}\n"
        f"Thông tin bộ tài liệu: {json.dumps(evidence['corpus_profile'], ensure_ascii=False)}\n\n"
        f"Các mẫu cần kiểm tra:\n{json.dumps(samples, ensure_ascii=False)}"
    )

    images = override_images if override_images is not None else (evidence.get("parsing_images") or [])
    vision_creds = _resolve_explicit_vision_creds() if images else None
    vision_used = False
    used_model = llm_model
    calls = 0

    try:
        if vision_creds and images:
            v_base, v_key, v_model = vision_creds
            try:
                calls += 1
                data = await call_llm_vision_json(v_base, v_key, v_model, sys_prompt, user_text, images, timeout=75.0)
                vision_used = True
                used_model = v_model
            except Exception:
                calls += 1
                data, used_model = await _call_json_with_fallback(
                    llm_base, llm_key, llm_model, fallback_model, sys_prompt, user_text, timeout=55.0
                )
        else:
            calls += 1
            data, used_model = await _call_json_with_fallback(
                llm_base, llm_key, llm_model, fallback_model, sys_prompt, user_text, timeout=55.0
            )

        findings = [
            ForensicFinding(
                pattern=str(f.get("pattern") or "Lỗi đọc nội dung")[:60],
                severity=f.get("severity") if f.get("severity") in ("high", "medium", "low") else "medium",
                summary=str(f.get("summary") or "")[:320],
                evidence_refs=[str(x) for x in (f.get("evidence_refs") or [])[:5]],
            )
            for f in (data.get("findings") or [])[:4]
            if isinstance(f, dict)
        ]
        knobs = sanitize_patch(data.get("recommended_knobs"), INDEX_KNOB_SPECS)
        return LayerDiagnosis(
            layer="PARSING",
            status="ISSUES_FOUND" if findings else "OK",
            headline=str(data.get("headline") or "Đã kiểm tra xong phần đọc tài liệu.")[:220],
            findings=findings,
            recommended_knobs=knobs,
            vision_used=vision_used,
            model_used=used_model,
        ), calls
    except Exception as e:
        return LayerDiagnosis(
            layer="PARSING",
            status="FALLBACK_ERROR",
            headline=f"Không kiểm tra được phần đọc tài liệu: {str(e)[:120]}",
            model_used=used_model,
        ), calls


async def _run_chunk_topology_agent(
    evidence: Dict[str, Any],
    llm_base: str,
    llm_key: str,
    llm_model: str,
    drilldown_instruction: str = "",
    override_samples: Optional[List[Dict[str, Any]]] = None,
    fallback_model: str = "",
) -> Tuple[LayerDiagnosis, int]:
    samples = override_samples if override_samples is not None else (evidence.get("chunk_samples") or [])
    split_count = (evidence.get("baseline_metrics", {}).get("answer_containment") or {}).get("SPLIT", 0)
    if not samples and split_count == 0:
        return LayerDiagnosis(
            layer="CHUNKING",
            status="SKIPPED_NO_DATA",
            headline="Không ghi nhận lỗi ranh giới cắt đoạn nào cần kiểm tra.",
            model_used=llm_model,
        ), 0

    focus_note = f"\nYÊU CẦU KIỂM TRA BỔ SUNG TỪ ĐIỀU PHỐI VIÊN: {drilldown_instruction}\n" if drilldown_instruction else ""
    sys_prompt = (
        "Bạn là Chuyên viên Cắt đoạn (Chunking Worker) phân tích cách chia văn bản trên RAGFlow.\n"
        f"{focus_note}"
        "Hãy soi ngữ cảnh liền trước/sau (prev_tail -> content -> next_head), các cờ lỗi và tỷ lệ câu bị chia mảnh để xác định:\n"
        "- Đoạn có bị cắt ngang câu/danh sách/bảng hoặc mất tiêu đề mục cha khiến đọc riêng không rõ chủ thể không?\n"
        "- Độ chồng lấp quá thấp (đứt mạch ý) hay quá cao (lặp nội dung)?\n"
        "- Có cần bật cắt Cha - Con, tự trích từ khóa hoặc tăng ngữ cảnh kèm bảng không?\n"
        "Viết `pattern`, `headline`, `summary` bằng tiếng Việt tự nhiên, dễ hiểu (KHÔNG dùng mã tiếng Anh viết hoa).\n"
        "CHỈ đề xuất thông số trong tập: {chunk_method, chunk_token_size: 128..2048, overlapped_percent: 0..40, "
        "use_parent_child: bool, table_context_size: 0..1024, keywords_top_n: 0..10, questions_top_n: 0..5, delimiters}.\n"
        "Trả về DUY NHẤT JSON hợp lệ:\n"
        '{"headline": "tóm tắt 1 câu tự nhiên", '
        '"findings": [{"pattern": "tên lỗi ngắn bằng tiếng Việt tự nhiên", "severity": "high|medium|low", "summary": "mô tả ngắn gọn, dễ hiểu", "evidence_refs": ["DOC#chunk"]}], '
        '"recommended_knobs": {"chunk_token_size": 768, ...}}'
    )
    user_text = (
        f"Cấu hình đọc/cắt hiện tại: {json.dumps(evidence['current_config']['index'], ensure_ascii=False)}\n"
        f"Thống kê cờ & độ phủ đáp án: {json.dumps({'flags': evidence['corpus_profile'].get('flag_counts'), 'ac': evidence['baseline_metrics'].get('answer_containment')}, ensure_ascii=False)}\n\n"
        f"Các cụm đoạn mẫu:\n{json.dumps(samples, ensure_ascii=False)}"
    )
    try:
        data, used_model = await _call_json_with_fallback(
            llm_base, llm_key, llm_model, fallback_model, sys_prompt, user_text, timeout=55.0
        )
        findings = [
            ForensicFinding(
                pattern=str(f.get("pattern") or "Lỗi ranh giới đoạn")[:60],
                severity=f.get("severity") if f.get("severity") in ("high", "medium", "low") else "medium",
                summary=str(f.get("summary") or "")[:320],
                evidence_refs=[str(x) for x in (f.get("evidence_refs") or [])[:5]],
            )
            for f in (data.get("findings") or [])[:4]
            if isinstance(f, dict)
        ]
        knobs = sanitize_patch(data.get("recommended_knobs"), INDEX_KNOB_SPECS)
        return LayerDiagnosis(
            layer="CHUNKING",
            status="ISSUES_FOUND" if findings else "OK",
            headline=str(data.get("headline") or "Đã kiểm tra xong phần cắt đoạn.")[:220],
            findings=findings,
            recommended_knobs=knobs,
            model_used=used_model,
        ), 1
    except Exception as e:
        return LayerDiagnosis(
            layer="CHUNKING",
            status="FALLBACK_ERROR",
            headline=f"Không kiểm tra được phần cắt đoạn: {str(e)[:120]}",
            model_used=llm_model,
        ), 1


async def _run_retrieval_contrastive_agent(
    samples: List[Dict[str, Any]],
    ret_cfg: Dict[str, Any],
    llm_base: str,
    llm_key: str,
    llm_model: str,
    compare_context: Optional[Dict[str, Any]] = None,
    fallback_model: str = "",
) -> Tuple[LayerDiagnosis, int]:
    if not samples:
        return LayerDiagnosis(
            layer="RETRIEVAL",
            status="SKIPPED_NO_DATA",
            headline="Chưa có câu hỏi tìm kiếm bị trượt để đối chứng.",
            model_used=llm_model,
        ), 0

    mode_note = (
        "CHẾ ĐỘ PHÂN TÍCH TỤT ĐIỂM (Pass -> Fail khi chuyển từ cấu hình A sang B): "
        "So sánh `baseline_top3` (lúc đúng) với `candidate_top3` (lúc trượt) và `gold_candidate`."
        if compare_context
        else "CHẾ ĐỘ ĐỐI CHỨNG TÌM KIẾM: So sánh `top_hits` sai lọt Top-3 với `gold_candidate` / `gold_fragments` (các mảnh đáp án thật, kèm `linked_parsing_verdict` và `rule_flags` từ bước trước)."
    )

    sys_prompt = (
        "Bạn là Chuyên viên Tìm kiếm (Retrieval Worker).\n"
        f"{mode_note}\n"
        "Hãy chỉ rõ TẠI SAO đoạn sai lại xếp cao hơn đoạn đúng (hoặc vì sao đoạn đúng bị mất):\n"
        "- Nếu `gold_candidate` có `match_score < 55` hoặc `linked_parsing_verdict == 'FAIL'` → lỗi bắt nguồn từ Đọc tài liệu bị thiếu chữ/vỡ bảng, KHÔNG đổ cho cấu hình tìm kiếm.\n"
        "- Hỏi khác cách diễn đạt / từ đồng nghĩa → cần tăng `vector_similarity_weight`.\n"
        "- Rớt mã hiệu, tên thuốc, con số chính xác → cần giảm `vector_similarity_weight` để ưu tiên từ khóa BM25 / bật `keyword_enabled`.\n"
        "- Nhầm sang tài liệu khác cùng chủ đề → cần bật model xếp hạng lại `rerank_id`.\n"
        "- Câu hỏi tổng hợp/đa mảnh bị cắt rớt bớt mảnh → cần hạ `similarity_threshold`, tăng `top_k` hoặc bật `use_kg`.\n"
        "- Nếu mẫu có `sample_level == 'SUBOPTIMAL'` (đã có chunk đúng nhưng vẫn lẫn đoạn nhiễu hoặc tụt khỏi Rank 1) → phân tích vì sao đoạn nhiễu chen lên trên và đề xuất cách đẩy đoạn đúng lên Rank 1.\n"
        "CHỈ trích dẫn các mã `tc_code` thực sự xuất hiện trong danh sách mẫu dưới đây vào `evidence_refs`.\n"
        "Viết `pattern`, `headline`, `summary` bằng tiếng Việt tự nhiên, dễ hiểu (KHÔNG dùng mã tiếng Anh viết hoa).\n"
        "CHỈ đề xuất thông số trong tập: {top_k: 3..30, similarity_threshold: 0.0..0.9, vector_similarity_weight: 0.0..1.0, "
        "rerank_id: str, keyword_enabled: bool, use_kg: bool}.\n"
        "Trả về DUY NHẤT JSON hợp lệ:\n"
        '{"headline": "tóm tắt 1 câu tự nhiên", '
        '"findings": [{"pattern": "tên lỗi ngắn bằng tiếng Việt tự nhiên", "severity": "high|medium|low", "summary": "nguyên nhân đối chứng cụ thể", "evidence_refs": ["TC-01"]}], '
        '"per_case": [{"tc_code": "TC-01", "why_failed": "1 câu giải thích ngắn", "fix_hint": "hướng xử lý"}], '
        '"recommended_knobs": {"vector_similarity_weight": 0.25, ...}}'
    )
    ctx_block = (
        f"So sánh cấu hình: A={json.dumps(compare_context['b_cfg'], ensure_ascii=False)} -> B={json.dumps(compare_context['c_cfg'], ensure_ascii=False)}\n"
        if compare_context
        else f"Cấu hình Tìm kiếm hiện tại: {json.dumps(ret_cfg, ensure_ascii=False)}\n"
    )
    user_text = f"{ctx_block}\nCác câu hỏi lỗi cần đối chứng:\n{json.dumps(samples, ensure_ascii=False)}"

    try:
        data, used_model = await _call_json_with_fallback(
            llm_base, llm_key, llm_model, fallback_model, sys_prompt, user_text, timeout=60.0
        )
        allowed_tc_codes = {str(s.get("tc_code") or "").strip() for s in samples if s.get("tc_code")}
        findings = [
            ForensicFinding(
                pattern=str(f.get("pattern") or "Lệch kết quả tìm kiếm")[:60],
                severity=f.get("severity") if f.get("severity") in ("high", "medium", "low") else "medium",
                summary=str(f.get("summary") or "")[:320],
                evidence_refs=[
                    str(x)
                    for x in (f.get("evidence_refs") or [])[:5]
                    if not allowed_tc_codes or not str(x).strip().upper().startswith("TC") or str(x).strip() in allowed_tc_codes
                ],
            )
            for f in (data.get("findings") or [])[:5]
            if isinstance(f, dict)
        ]
        knobs = sanitize_patch(data.get("recommended_knobs"), RETRIEVAL_KNOB_SPECS)
        diag = LayerDiagnosis(
            layer="RETRIEVAL",
            status="ISSUES_FOUND" if findings else "OK",
            headline=str(data.get("headline") or "Đã phân tích đối chứng phần tìm kiếm.")[:220],
            findings=findings,
            recommended_knobs=knobs,
            model_used=used_model,
        )
        diag_dict = {"diagnosis": diag, "per_case": data.get("per_case") or []}
        return diag_dict, 1  # type: ignore[return-value]
    except Exception as e:
        return {"diagnosis": LayerDiagnosis(
            layer="RETRIEVAL",
            status="FALLBACK_ERROR",
            headline=f"Không kiểm tra được phần tìm kiếm: {str(e)[:120]}",
            model_used=llm_model,
        ), "per_case": []}, 1  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Phase 2: Supervisor Cross-Check & Bounded Drill-Down + Synthesis
# ---------------------------------------------------------------------------

def _merge_layer_diagnosis(base: LayerDiagnosis, extra: LayerDiagnosis) -> LayerDiagnosis:
    """Merges drill-down worker findings and knobs cleanly into the initial layer report."""
    seen_patterns = {f.pattern.lower() for f in base.findings}
    merged_findings = list(base.findings)
    for f in extra.findings:
        if f.pattern.lower() not in seen_patterns and len(merged_findings) < 5:
            merged_findings.append(f)
            seen_patterns.add(f.pattern.lower())
    merged_knobs = {**base.recommended_knobs, **extra.recommended_knobs}
    status = "ISSUES_FOUND" if merged_findings else (extra.status if base.status == "SKIPPED_NO_DATA" else base.status)
    headline = extra.headline if (base.status in ("OK", "SKIPPED_NO_DATA") and extra.findings) else base.headline
    return LayerDiagnosis(
        layer=base.layer,
        status=status,
        headline=headline,
        findings=merged_findings,
        recommended_knobs=merged_knobs,
        vision_used=base.vision_used or extra.vision_used,
        model_used=extra.model_used or base.model_used,
    )


async def _supervisor_drilldown_if_needed(
    evidence: Dict[str, Any],
    p_diag: LayerDiagnosis,
    c_diag: LayerDiagnosis,
    r_diag: LayerDiagnosis,
    llm_base: str,
    llm_key: str,
    parsing_model: str,
    chunking_model: str,
    fallback_model: str = "",
) -> Tuple[LayerDiagnosis, LayerDiagnosis, int, bool, List[str]]:
    """
    Bounded Supervisor cross-layer check (max 1 targeted worker drill-down):
      - Case A: Retrieval sees missing text (match_score < 55) while Parsing reported OK/SKIPPED -> drill down Parsing Worker.
      - Case B: Retrieval sees fragmented/SPLIT answers while Chunking reported OK/SKIPPED -> drill down Chunking Worker.
    """
    notes: List[str] = [
        f"Điều phối viên đã giao 3 chuyên viên kiểm tra song song ({len(evidence.get('parsing_samples') or [])} mẫu đọc file, "
        f"{len(evidence.get('chunk_samples') or [])} cụm đoạn, {len(evidence.get('retrieval_samples') or [])} câu tìm kiếm)."
    ]
    ret_samples = evidence.get("retrieval_samples") or []
    all_chunks = evidence.get("_all_chunks") or []
    doc_rows = evidence.get("_doc_rows") or []

    # Case A: Retrieval missing content (<55% match) but Parsing saw no issues
    missing_tcs = [
        rs for rs in ret_samples
        if (rs.get("gold_candidate") or {}).get("match_score", 100.0) < 55.0
    ]
    if missing_tcs and p_diag.status in ("OK", "SKIPPED_NO_DATA"):
        target_files = {(rs.get("source_file") or "").lower() for rs in missing_tcs if rs.get("source_file")}
        suspected_docs = [
            d for d in doc_rows
            if not target_files or any((d.get("filename") or "").lower() in tf or tf in (d.get("filename") or "").lower() for tf in target_files)
        ][:2]
        dd_samples = []
        dd_images: List[Tuple[str, bytes]] = []
        for rs in missing_tcs[:3]:
            gc = rs.get("gold_candidate") or {}
            dd_samples.append({
                "ref": f"Truy vấn {rs['tc_code']} ({rs.get('source_file') or 'không rõ file'})",
                "unit_type": "missing_content",
                "verdict": "SUSPECT_MISSING",
                "source_text": f"Câu hỏi: {rs['question']} | Đáp án kỳ vọng: {rs.get('expected_outcome', '')}",
                "parsed_text": gc.get("excerpt") or "(KHÔNG TÌM THẤY NỘI DUNG KHỚP TRONG KHO ĐOẠN)",
            })
        if _resolve_explicit_vision_creds():
            for d in suspected_docs:
                img_b = _maybe_render_unit_image(d.get("file_path") or "", 1, "")
                if img_b:
                    dd_images.append((f"{d.get('doc_code')} (trang 1)", img_b))

        if dd_samples:
            instr = (
                f"Chuyên viên Tìm kiếm phát hiện {len(missing_tcs)} câu không tìm thấy nội dung khớp trong kho chunk "
                f"({', '.join(x['tc_code'] for x in missing_tcs[:3])}), dù phần Đọc tài liệu trước đó chưa ghi nhận lỗi. "
                "Hãy kiểm tra xem tài liệu có bị đọc sót chữ, vỡ bảng hay PDF scan chưa nhận diện được không."
            )
            extra_p, p2_calls = await _run_parsing_forensic_agent(
                evidence,
                llm_base,
                llm_key,
                parsing_model,
                drilldown_instruction=instr,
                override_samples=dd_samples,
                override_images=dd_images,
                fallback_model=fallback_model,
            )
            merged_p = _merge_layer_diagnosis(p_diag, extra_p)
            notes.append(
                f"Phát hiện điểm lệch: Tìm kiếm báo thiếu nội dung ở {', '.join(x['tc_code'] for x in missing_tcs[:3])} "
                "nhưng Đọc tài liệu chưa thấy lỗi → Điều phối viên đã yêu cầu Chuyên viên Đọc tài liệu kiểm tra bổ sung."
            )
            return merged_p, c_diag, p2_calls, True, notes

    # Case B: Retrieval sees SPLIT / fragmentation while Chunking saw no issues
    split_tcs = [
        rs for rs in ret_samples
        if rs.get("answer_containment") == "SPLIT" or len(rs.get("gold_fragments") or []) >= 2
    ]
    if split_tcs and c_diag.status in ("OK", "SKIPPED_NO_DATA") and all_chunks:
        chunk_by_pos = {(c["document_id"], c["chunk_index"]): c for c in all_chunks}
        chunk_by_id = {c["ragflow_chunk_id"]: c for c in all_chunks}
        dd_chunks: List[Dict[str, Any]] = []
        seen_cids = set()
        for rs in split_tcs[:3]:
            gc = rs.get("gold_candidate") or {}
            cid = gc.get("chunk_id")
            c_row = chunk_by_id.get(cid) if cid else None
            if not c_row or cid in seen_cids:
                continue
            seen_cids.add(cid)
            did, idx = c_row["document_id"], c_row["chunk_index"]
            prev_c = chunk_by_pos.get((did, idx - 1))
            next_c = chunk_by_pos.get((did, idx + 1))
            dd_chunks.append({
                "ref": f"{c_row.get('doc_code') or 'DOC'}#chunk-{idx} (liên quan {rs['tc_code']})",
                "token_est": c_row.get("token_est") or 0,
                "rule_flags": c_row.get("rule_flags") or "[]",
                "prev_tail": nfc(prev_c["content"])[-220:] if prev_c else "",
                "content": nfc(c_row["content"])[:700],
                "next_head": nfc(next_c["content"])[:220] if next_c else "",
            })
        if dd_chunks:
            instr = (
                f"Chuyên viên Tìm kiếm ghi nhận đáp án của {', '.join(x['tc_code'] for x in split_tcs[:3])} bị chia rời qua nhiều đoạn. "
                "Hãy kiểm tra các đoạn xung quanh xem ranh giới cắt có làm đứt ý hoặc mất tiêu đề mục cha không."
            )
            extra_c, c2_calls = await _run_chunk_topology_agent(
                evidence,
                llm_base,
                llm_key,
                chunking_model,
                drilldown_instruction=instr,
                override_samples=dd_chunks,
                fallback_model=fallback_model,
            )
            merged_c = _merge_layer_diagnosis(c_diag, extra_c)
            notes.append(
                f"Phát hiện câu trả lời bị chia mảnh ở {', '.join(x['tc_code'] for x in split_tcs[:3])} "
                "→ Điều phối viên đã yêu cầu Chuyên viên Cắt đoạn kiểm tra lại vùng ranh giới liên quan."
            )
            return p_diag, merged_c, c2_calls, True, notes

    notes.append("Kết quả của 3 chuyên viên nhất quán nhau, Điều phối viên tổng hợp phương án trực tiếp.")
    return p_diag, c_diag, 0, False, notes


async def _run_hypothesis_synthesizer(
    current_config: Dict[str, Any],
    corpus_profile: Dict[str, Any],
    layer_diags: List[LayerDiagnosis],
    llm_base: str,
    llm_key: str,
    llm_model: str,
    is_autopsy: bool = False,
    capabilities: Optional[Dict[str, Any]] = None,
    supervisor_notes: Optional[List[str]] = None,
    fallback_model: str = "",
) -> Tuple[str, List[str], List[HypothesisPack], int, str]:
    sys_prompt = (
        "Bạn là Điều phối viên Tổng hợp (Supervisor) cho hệ thống kiểm thử RAGFlow.\n"
        "Bạn nhận báo cáo từ 3 chuyên viên (Đọc tài liệu, Cắt đoạn, Tìm kiếm), cấu hình hiện tại và năng lực model đang cấu hình.\n"
        "NHIỆM VỤ:\n"
        "1. Hòa giải xung đột tham số giữa các bước (VD: Cắt đoạn muốn tăng kích thước đoạn để hết đứt ý, nhưng Tìm kiếm cảnh báo đoạn quá dài gây nhiễu → chọn giải pháp cân bằng như `use_parent_child: true`).\n"
        "2. Viết `improvement_plan`: 3 bước hành động cụ thể bằng tiếng Việt tự nhiên, rõ ràng (làm gì trước, làm gì sau).\n"
        "3. BẮT BUỘC đề xuất đủ 3 phương án cấu hình tách bạch theo 3 mức độ (`packs` có đúng 3 phần tử khác nhau):\n"
        "   - Gợi ý 1 (scope='RETRIEVAL'): Chỉ chỉnh tham số tìm kiếm để áp dụng ngay (không cần đọc lại tài liệu).\n"
        "   - Gợi ý 2 (scope='JOINT' hoặc 'INDEX'): Cải thiện cân bằng bước đọc/cắt đoạn + tìm kiếm (ít xáo trộn, an toàn).\n"
        "   - Gợi ý 3 (scope='JOINT' hoặc 'INDEX'): Tối ưu triệt để (VD bật Cha-Con, đọc ảnh AI hoặc Rerank).\n"
        "   Mỗi cấu hình PHẢI khác `current_config` ở ít nhất 1 thông số. KHÔNG đề xuất hạ từ `DeepDOC` xuống `Plain Text` khi tài liệu có bảng biểu hoặc scan.\n"
        "4. Viết tự nhiên, súc tích, tránh thuật ngữ kỹ thuật nặng nề; vẫn giữ trích mã `TC-...` hoặc `DOC...` trong `evidence_refs`.\n"
        "5. CHỈ dùng đúng tên tham số hợp lệ:\n"
        "   - `index_patch`: chunk_method, pdf_parse_method, enable_vision_enhancement, chunk_token_size (128..2048), overlapped_percent (0..40), delimiters, table_context_size (0..1024), image_context_size (0..1024), use_parent_child (bool), keywords_top_n (0..10), questions_top_n (0..5), filename_embd_weight (0..1)\n"
        "   - `retrieval_patch`: top_k (3..30), similarity_threshold (0..0.9), vector_similarity_weight (0..1), rerank_id (str), keyword_enabled (bool), use_kg (bool)\n"
        "Trả về DUY NHẤT JSON hợp lệ:\n"
        '{"executive_summary": "tóm tắt 2-3 câu tự nhiên, dễ hiểu về nguyên nhân chính", '
        '"improvement_plan": ["Bước 1: ...", "Bước 2: ...", "Bước 3: ..."], '
        '"packs": [{"name": "Tên gợi ý ngắn gọn, dễ hiểu", "scope": "RETRIEVAL|INDEX|JOINT", '
        '"hypothesis_statement": "Giải thích dễ hiểu thay đổi này giúp cải thiện điều gì", "conflict_resolution": "cách cân bằng giữa các bước nếu có", '
        '"evidence_refs": ["TC-01", "DOC02#chunk-5"], "expected_gains": ["lợi ích dự kiến ..."], '
        '"regression_warnings": ["điểm cần lưu ý ..."], "index_patch": {...}, "retrieval_patch": {...}}]}'
    )
    mode_tag = "PHÂN TÍCH CÂU BỊ TỤT ĐIỂM A→B" if is_autopsy else "KIỂM TRA TOÀN DIỆN 3 BƯỚC"
    user_text = (
        f"Chế độ: {mode_tag}\n"
        f"Cấu hình hiện tại: {json.dumps(current_config, ensure_ascii=False)}\n"
        f"Năng lực model hiện có: {json.dumps(capabilities or {}, ensure_ascii=False)}\n"
        f"Hồ sơ tài liệu: {json.dumps(corpus_profile, ensure_ascii=False)}\n"
        f"Ghi chú điều phối: {json.dumps(supervisor_notes or [], ensure_ascii=False)}\n"
        f"Báo cáo từ các chuyên viên:\n{json.dumps([d.model_dump() for d in layer_diags], ensure_ascii=False)}"
    )

    data, used_model = await _call_json_with_fallback(
        llm_base, llm_key, llm_model, fallback_model, sys_prompt, user_text, timeout=60.0
    )
    exec_sum = str(data.get("executive_summary") or "").strip()[:500]
    improvement_plan = [
        str(step).strip()[:240]
        for step in (data.get("improvement_plan") or [])[:5]
        if str(step).strip()
    ]
    packs: List[HypothesisPack] = []
    seen_sigs = set()

    def _append_pack(
        name: str,
        statement: str,
        conflict_res: str,
        ev_refs: List[str],
        gains: List[str],
        warnings: List[str],
        raw_idx: Dict[str, Any],
        raw_ret: Dict[str, Any],
    ) -> None:
        eff_idx, eff_ret, diff = build_diff_against_current(raw_idx, raw_ret, current_config)
        if not diff:
            return
        sig = json.dumps({"i": eff_idx, "r": eff_ret}, sort_keys=True)
        if sig in seen_sigs:
            return
        seen_sigs.add(sig)
        scope: Literal["RETRIEVAL", "INDEX", "JOINT"] = (
            "JOINT" if (eff_idx and eff_ret) else "INDEX" if eff_idx else "RETRIEVAL"
        )
        idx_num = len(packs) + 1
        packs.append(HypothesisPack(
            id=f"hyp_{idx_num}",
            name=name[:90],
            scope=scope,
            reparse_required=bool(eff_idx),
            priority="Cần đọc lại tài liệu" if eff_idx else "Áp dụng ngay",
            hypothesis_statement=statement[:400],
            conflict_resolution=conflict_res[:300],
            evidence_refs=ev_refs[:6],
            expected_gains=gains[:4],
            regression_warnings=warnings[:3],
            index_patch=eff_idx,
            retrieval_patch=eff_ret,
            diff=diff,
        ))

    for idx, raw_p in enumerate((data.get("packs") or [])[:3], start=1):
        if not isinstance(raw_p, dict):
            continue
        raw_idx_patch = sanitize_patch(raw_p.get("index_patch"), INDEX_KNOB_SPECS)
        raw_ret_patch = sanitize_patch(raw_p.get("retrieval_patch"), RETRIEVAL_KNOB_SPECS)
        _append_pack(
            name=str(raw_p.get("name") or f"Gợi ý #{idx}"),
            statement=str(raw_p.get("hypothesis_statement") or ""),
            conflict_res=str(raw_p.get("conflict_resolution") or ""),
            ev_refs=[str(x)[:60] for x in (raw_p.get("evidence_refs") or [])],
            gains=[str(x)[:180] for x in (raw_p.get("expected_gains") or [])],
            warnings=[str(x)[:180] for x in (raw_p.get("regression_warnings") or [])],
            raw_idx=raw_idx_patch,
            raw_ret=raw_ret_patch,
        )

    # Guarantee distinct layered alternatives from worker knobs if the LLM returned < 3 packs
    if len(packs) < 3:
        by_layer = {d.layer: d for d in layer_diags}
        p_knobs = dict((by_layer.get("PARSING").recommended_knobs if by_layer.get("PARSING") else {}) or {})
        c_knobs = dict((by_layer.get("CHUNKING").recommended_knobs if by_layer.get("CHUNKING") else {}) or {})
        r_knobs = dict((by_layer.get("RETRIEVAL").recommended_knobs if by_layer.get("RETRIEVAL") else {}) or {})

        if r_knobs and not any(p.scope == "RETRIEVAL" for p in packs):
            _append_pack(
                name="Tinh chỉnh tìm kiếm (Áp dụng ngay)",
                statement="Điều chỉnh trực tiếp các tham số tìm kiếm từ đề xuất của Chuyên viên Tìm kiếm mà không cần đọc lại toàn bộ tài liệu.",
                conflict_res="Giữ nguyên cấu trúc đoạn hiện có để thử nghiệm nhanh độ chính xác tìm kiếm trước.",
                ev_refs=[],
                gains=["Áp dụng được ngay không tốn thời gian xử lý lại file"],
                warnings=["Không xử lý được các lỗi mất chữ hoặc vỡ bảng từ khâu đọc file"],
                raw_idx={},
                raw_ret=sanitize_patch(r_knobs, RETRIEVAL_KNOB_SPECS),
            )

        merged_idx = sanitize_patch({**p_knobs, **c_knobs}, INDEX_KNOB_SPECS)
        if merged_idx and len(packs) < 3 and not any(p.scope == "INDEX" for p in packs):
            _append_pack(
                name="Sửa khâu Đọc tài liệu & Cắt đoạn",
                statement="Áp dụng riêng các chỉnh sửa đọc file và chia đoạn theo đề xuất của Chuyên viên Đọc tài liệu và Cắt đoạn.",
                conflict_res="Tách riêng khâu xử lý dữ liệu đầu vào để dễ so sánh A/B với cấu hình tìm kiếm hiện tại.",
                ev_refs=[],
                gains=["Khắc phục tận gốc lỗi vỡ bảng, đứt ý hoặc thiếu ngữ cảnh đoạn"],
                warnings=["Cần tạo phiên mới và đọc lại tài liệu trên RAGFlow"],
                raw_idx=merged_idx,
                raw_ret={},
            )

    return exec_sum, improvement_plan, packs[:3], 1, used_model


# ---------------------------------------------------------------------------
# SQLite Cache & Public Orchestrators
# ---------------------------------------------------------------------------

def _load_cached_report(
    run_id: int,
    report_type: str,
    ref_key: str,
    evidence_sig: Optional[str] = None,
) -> Optional[SwarmDiagnosisReport]:
    with get_db() as conn:
        if evidence_sig:
            row = conn.execute(
                """
                SELECT * FROM agent_diagnostic_reports
                WHERE run_id = ? AND report_type = ? AND ref_key = ? AND evidence_sig = ?
                ORDER BY id DESC LIMIT 1
                """,
                (run_id, report_type, ref_key, evidence_sig),
            ).fetchone()
        else:
            row = conn.execute(
                """
                SELECT * FROM agent_diagnostic_reports
                WHERE run_id = ? AND report_type = ? AND ref_key = ?
                ORDER BY id DESC LIMIT 1
                """,
                (run_id, report_type, ref_key),
            ).fetchone()
    if not row:
        return None
    try:
        payload = json.loads(row["summary_json"] or "{}")
        rep = SwarmDiagnosisReport(**payload)
        rep.cached = True
        rep.created_at = row["created_at"]
        return rep
    except Exception:
        return None


def _save_report_cache(report: SwarmDiagnosisReport, ref_key: str = "") -> None:
    now = report.created_at or utc_now()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO agent_diagnostic_reports
            (run_id, report_type, ref_key, evidence_sig, summary_json, model_used, duration_ms, llm_calls, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                report.run_id,
                report.report_type,
                ref_key,
                report.evidence_sig,
                report.model_dump_json(),
                report.model_used,
                report.duration_ms,
                report.llm_calls,
                now,
            ),
        )


def get_latest_agent_diagnosis(run_id: int) -> Optional[Dict[str, Any]]:
    rep = _load_cached_report(run_id, "ADVISOR_SWARM", "")
    return rep.model_dump() if rep else None


def get_latest_agent_diagnosis_status(run_id: int) -> Dict[str, Any]:
    """Returns latest cached report plus `is_stale` flag compared to live corpus evidence."""
    rep = _load_cached_report(run_id, "ADVISOR_SWARM", "")
    if not rep:
        return {"report": None, "is_stale": False}
    try:
        live_ev = collect_run_evidence(run_id, include_vision=False)
        is_stale = live_ev["evidence_sig"] != rep.evidence_sig
    except Exception:
        is_stale = False
    return {"report": rep.model_dump(), "is_stale": is_stale}


async def run_agent_diagnosis_swarm(
    run_id: int,
    force_refresh: bool = False,
    include_vision: bool = True,
) -> Dict[str, Any]:
    """Runs the 4-agent Diagnostic & Hypothesis Swarm for `run_id`, with SQLite evidence caching."""
    t0 = time.perf_counter()
    evidence = collect_run_evidence(run_id, include_vision=include_vision)

    if not force_refresh:
        cached = _load_cached_report(run_id, "ADVISOR_SWARM", "", evidence_sig=evidence["evidence_sig"])
        if cached:
            return cached.model_dump()

    llm_base, llm_key, llm_model = _resolve_llm_creds()
    swarm_models = _resolve_swarm_models(llm_model)

    # Phase 1: Parallel Workers (each routed to its specialized model with safe fallback)
    p_task = _run_parsing_forensic_agent(
        evidence, llm_base, llm_key, swarm_models["parsing"], fallback_model=llm_model
    )
    c_task = _run_chunk_topology_agent(
        evidence, llm_base, llm_key, swarm_models["chunking"], fallback_model=llm_model
    )
    r_task = _run_retrieval_contrastive_agent(
        evidence["retrieval_samples"],
        evidence["current_config"]["retrieval"],
        llm_base,
        llm_key,
        swarm_models["retrieval"],
        fallback_model=llm_model,
    )
    (p_diag, p_calls), (c_diag, c_calls), (r_wrap, r_calls) = await asyncio.gather(p_task, c_task, r_task)
    r_diag = r_wrap["diagnosis"] if isinstance(r_wrap, dict) else r_wrap

    # Phase 2: Supervisor Cross-Check & Bounded Drill-Down (max 1 targeted re-check)
    p_diag, c_diag, dd_calls, drilldown_triggered, supervisor_notes = await _supervisor_drilldown_if_needed(
        evidence=evidence,
        p_diag=p_diag,
        c_diag=c_diag,
        r_diag=r_diag,
        llm_base=llm_base,
        llm_key=llm_key,
        parsing_model=swarm_models["parsing"],
        chunking_model=swarm_models["chunking"],
        fallback_model=llm_model,
    )
    layer_diags = [p_diag, c_diag, r_diag]

    # Phase 3: Supervisor Synthesis & Capability-Aware Plan
    exec_sum, imp_plan, packs, s_calls, sup_used_model = await _run_hypothesis_synthesizer(
        current_config=evidence["current_config"],
        corpus_profile=evidence["corpus_profile"],
        layer_diags=layer_diags,
        llm_base=llm_base,
        llm_key=llm_key,
        llm_model=swarm_models["supervisor"],
        is_autopsy=False,
        capabilities=evidence.get("_capabilities"),
        supervisor_notes=supervisor_notes,
        fallback_model=llm_model,
    )

    models_by_agent = {
        "parsing": p_diag.model_used or swarm_models["parsing"],
        "chunking": c_diag.model_used or swarm_models["chunking"],
        "retrieval": r_diag.model_used or swarm_models["retrieval"],
        "supervisor": sup_used_model or swarm_models["supervisor"],
    }
    distinct_models = list(dict.fromkeys(v for v in models_by_agent.values() if v))
    summary_model_label = (
        f"{len(distinct_models)} models · Sup: {models_by_agent['supervisor']}"
        if len(distinct_models) > 1
        else (distinct_models[0] if distinct_models else llm_model)
    )

    total_calls = p_calls + c_calls + r_calls + dd_calls + s_calls
    duration_ms = int((time.perf_counter() - t0) * 1000)
    report = SwarmDiagnosisReport(
        ok=True,
        run_id=run_id,
        run_name=evidence["run_name"],
        report_type="ADVISOR_SWARM",
        cached=False,
        evidence_sig=evidence["evidence_sig"],
        model_used=summary_model_label,
        models_by_agent=models_by_agent,
        duration_ms=duration_ms,
        llm_calls=total_calls,
        executive_summary=exec_sum or "Đã tổng hợp đánh giá từ 3 chuyên viên và đề xuất cấu hình cải tiến.",
        improvement_plan=imp_plan,
        architecture_mode="supervisor_worker",
        drilldown_triggered=drilldown_triggered,
        supervisor_notes=supervisor_notes,
        evidence_counts={
            "parsing_samples": len(evidence["parsing_samples"]),
            "parsing_images": len(evidence["parsing_images"]),
            "chunk_samples": len(evidence["chunk_samples"]),
            "retrieval_samples": len(evidence["retrieval_samples"]),
            "golden_total": int(evidence.get("golden_total") or 0),
        },
        layer_diagnoses=layer_diags,
        hypothesis_packs=packs,
        created_at=utc_now(),
    )
    _save_report_cache(report, ref_key="")
    return report.model_dump()


async def run_compare_regression_autopsy(
    baseline_rr_id: int,
    candidate_rr_id: int,
    force_refresh: bool = False,
) -> Dict[str, Any]:
    """Runs Multi-Agent Regression Autopsy on Pass -> Fail cases between two Retrieval Runs."""
    t0 = time.perf_counter()
    ev = collect_compare_evidence(baseline_rr_id, candidate_rr_id)
    ref_key = f"{baseline_rr_id}:{candidate_rr_id}"

    if not force_refresh:
        cached = _load_cached_report(ev["run_id"], "REGRESSION_AUTOPSY", ref_key, evidence_sig=ev["evidence_sig"])
        if cached:
            return cached.model_dump()

    if not ev["regressions"]:
        rep = SwarmDiagnosisReport(
            ok=True,
            run_id=ev["run_id"],
            run_name=ev["run_name"],
            report_type="REGRESSION_AUTOPSY",
            cached=False,
            evidence_sig=ev["evidence_sig"],
            model_used="none",
            duration_ms=int((time.perf_counter() - t0) * 1000),
            llm_calls=0,
            executive_summary="Không có câu hỏi nào bị tụt hạng (Pass → Fail) giữa hai phiên chạy.",
            evidence_counts={"regressions": 0, "improvements": ev["improvements_count"]},
            created_at=utc_now(),
        )
        return rep.model_dump()

    llm_base, llm_key, llm_model = _resolve_llm_creds()
    swarm_models = _resolve_swarm_models(llm_model)
    r_wrap, r_calls = await _run_retrieval_contrastive_agent(
        ev["regressions"],
        ev["candidate_ret_cfg"],
        llm_base,
        llm_key,
        swarm_models["retrieval"],
        compare_context={"b_cfg": ev["baseline_ret_cfg"], "c_cfg": ev["candidate_ret_cfg"]},
        fallback_model=llm_model,
    )
    r_diag = r_wrap["diagnosis"] if isinstance(r_wrap, dict) else r_wrap
    per_case_raw = r_wrap.get("per_case", []) if isinstance(r_wrap, dict) else []
    per_case_map = {str(x.get("tc_code")): x for x in per_case_raw if isinstance(x, dict)}

    regressions_analyzed = []
    for reg in ev["regressions"]:
        note = per_case_map.get(reg["tc_code"], {})
        regressions_analyzed.append({
            "tc_code": reg["tc_code"],
            "question_class": reg["question_class"],
            "question": reg["question"],
            "baseline_cp": reg["baseline_cp"],
            "candidate_cp": reg["candidate_cp"],
            "why_failed": str(note.get("why_failed") or "")[:240],
            "fix_hint": str(note.get("fix_hint") or "")[:180],
        })

    exec_sum, imp_plan, packs, s_calls, sup_used_model = await _run_hypothesis_synthesizer(
        current_config=ev["current_config"],
        corpus_profile=ev["corpus_profile"],
        layer_diags=[r_diag],
        llm_base=llm_base,
        llm_key=llm_key,
        llm_model=swarm_models["supervisor"],
        is_autopsy=True,
        fallback_model=llm_model,
    )

    models_by_agent = {
        "retrieval": r_diag.model_used or swarm_models["retrieval"],
        "supervisor": sup_used_model or swarm_models["supervisor"],
    }
    duration_ms = int((time.perf_counter() - t0) * 1000)
    report = SwarmDiagnosisReport(
        ok=True,
        run_id=ev["run_id"],
        run_name=ev["run_name"],
        report_type="REGRESSION_AUTOPSY",
        cached=False,
        evidence_sig=ev["evidence_sig"],
        model_used=sup_used_model,
        models_by_agent=models_by_agent,
        duration_ms=duration_ms,
        llm_calls=r_calls + s_calls,
        executive_summary=exec_sum or r_diag.headline,
        improvement_plan=imp_plan,
        evidence_counts={
            "regressions": ev["total_regressions"],
            "analyzed": len(regressions_analyzed),
            "improvements": ev["improvements_count"],
        },
        layer_diagnoses=[r_diag],
        hypothesis_packs=packs,
        regressions_analyzed=regressions_analyzed,
        created_at=utc_now(),
    )
    _save_report_cache(report, ref_key=ref_key)
    return report.model_dump()
