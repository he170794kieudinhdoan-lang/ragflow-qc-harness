export interface ErrorCodeDef {
  code: string;
  name: string;
  severity?: string;
  metric?: string;
  layer?: string;
}

export interface DocumentItem {
  id: number;
  doc_code: string;
  filename: string;
  format_group: string;
  source_url: string;
  file_path: string;
  page_count: number;
  has_tables: number;
  has_images: number;
  is_scan: number;
  notes: string;
  created_at: string;
}

export interface RunItem {
  id: number;
  name: string;
  description: string;
  is_baseline: number;
  ragflow_dataset_id: string;
  ragflow_dataset_name: string;
  parser_config: Record<string, any>;
  retrieval_config: Record<string, any>;
  status: string;
  chunk_count?: number;
  doc_count?: number;
  created_at: string;
}

export interface RunDocumentItem {
  id: number;
  run_id: number;
  document_id: number;
  doc_code: string;
  filename: string;
  format_group: string;
  page_count: number;
  ragflow_doc_id: string;
  parse_status: string;
  progress: number;
  chunk_count: number;
  token_count: number;
  parse_duration_sec: number;
  anomaly_flags: string[];
}

export interface ParsingUnit {
  id: number;
  run_id: number;
  document_id: number;
  doc_code: string;
  filename: string;
  format_group: string;
  unit_index: number;
  unit_type: string;
  page_num: number;
  title: string;
  source_text: string;
  matched_chunk_ids: string[];
  matched_chunks: {
    ragflow_chunk_id: string;
    chunk_index: number;
    content: string;
    page_num: number;
    char_count: number;
    alignment?: {
      matched_excerpt: string;
      start: number;
      end: number;
      raw_similarity: number;
      text_similarity: number;
      has_format_diff: boolean;
      has_text_diff: boolean;
      suggested_verdict: 'PASS' | 'PARTIAL' | 'FAIL';
      stitched_with_chunk_index?: number | null;
      risk_flags?: { code: string; label: string; severity: string }[];
      suggested_error_codes?: string[];
    };
  }[];
  match_score: number;
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'UNRATED';
  error_codes: string[];
  char_error: number;
  fidelity_error?: number;
  severity: string;
  notes: string;
  has_local_file: boolean;
}

export interface ChunkEvalItem {
  chunk_pk: number;
  ragflow_chunk_id: string;
  chunk_index: number;
  content: string;
  char_count: number;
  token_est: number;
  page_num: number;
  rule_flags: string[];
  document_id: number | null;
  doc_code: string | null;
  filename: string | null;
  format_group: string | null;
  is_sampled: number | null;
  integrity: number | null;
  context_sufficiency: number | null;
  no_noise: number | null;
  no_duplicate: number | null;
  valid_size: number | null;
  error_codes: string[];
  judge_source: string | null;
  notes: string | null;
  prev_tail?: string;
  next_head?: string;
}

export interface GoldenTestcase {
  id: number;
  tc_code: string;
  input_question: string;
  expected_outcome: string;
  reference_context: string;
  source_file: string;
  question_class: 'Local' | 'Global' | 'Multi-hop';
  intent_type: string;
  notes: string;
}

export interface RetrievalRun {
  id: number;
  run_id: number;
  parent_run_name: string;
  is_baseline: number;
  name: string;
  top_k: number;
  similarity_threshold: number;
  vector_similarity_weight: number;
  rerank_id: string;
  keyword_enabled: number;
  judge_engine?: string;
  judge_duration_ms?: number;
  judge_call_count?: number;
  judge_error_count?: number;
  is_baseline_rr?: number;
  created_at: string;
}

export interface RetrievalHit {
  id: number;
  rank: number;
  ragflow_chunk_id: string;
  ragflow_doc_id: string;
  doc_name: string;
  content: string;
  similarity: number;
  vector_similarity: number;
  term_similarity: number;
  relevant: number | null;
  relevancy_source: 'MANUAL' | 'CACHED' | 'LLM_DRAFT' | 'JEV_DRAFT' | 'RULE' | 'UNRATED';
  reason: string;
}

export interface RetrievalResultGroup {
  testcase: GoldenTestcase;
  meta: {
    answer_containment: string;
    context_coverage: number;
    root_cause_layer: string;
    root_cause_notes: string;
  };
  contextual_precision: number;
  relevant_count: number;
  rated_count: number;
  hits: RetrievalHit[];
}

export interface ConfigDiffItem {
  param: string;
  from: any;
  to: any;
}

export interface CandidateConfigPack {
  id: string;
  name: string;
  scope: 'RETRIEVAL' | 'INDEX' | 'JOINT';
  reparse_required: boolean;
  priority: string;
  summary: string;
  reasons: string[];
  tradeoff: string;
  index_patch: Record<string, any>;
  retrieval_patch: Record<string, any>;
  diff: ConfigDiffItem[];
}

export interface AdvisorResponse {
  ok: boolean;
  run_id: number;
  run_name: string;
  current_config: {
    index: Record<string, any>;
    retrieval: {
      top_k: number;
      similarity_threshold: number;
      vector_similarity_weight: number;
      rerank_id: string;
      keyword_enabled: boolean;
    };
  };
  corpus_profile: {
    doc_count: number;
    total_chunks: number;
    avg_chunk_tokens: number;
    pdf_docs: number;
    scan_docs: number;
    scan_ratio: number;
    table_ratio: number;
    legal_ratio: number;
    zero_chunk_docs: number;
    archetype: string;
    flag_counts: Record<string, number>;
  };
  failure_signals: {
    layer: string;
    code: string;
    severity: 'high' | 'medium' | 'low';
    metric: string;
    detail: string;
  }[];
  candidate_packs: CandidateConfigPack[];
  recommended_sweep_space: {
    vector_similarity_weight: number[];
    similarity_threshold: number[];
    top_k: number[];
    keyword_enabled: boolean[];
    rerank_ids: string[];
  };
}

export interface OptimizationTrial {
  id: number;
  study_id: number;
  trial_index: number;
  stage: '1_SCREENING' | '2_FULL' | 'CANARY_VARIANT';
  config: {
    vector_similarity_weight: number;
    similarity_threshold: number;
    top_k: number;
    keyword_enabled: boolean;
    rerank_id: string;
    variant_id?: string;
    variant_name?: string;
    is_baseline?: boolean;
    index_patch?: Record<string, any>;
    chunk_method?: string;
  };
  testcase_count: number;
  avg_cp: number;
  avg_cc: number;
  avg_mrr: number;
  hit_at_1: number;
  hit_at_3: number;
  hit_at_k: number;
  avg_latency_ms: number;
  avg_context_tokens: number;
  objective_score: number;
  is_pareto: boolean;
  cache_hits: number;
  judge_calls: number;
  retrieval_run_id: number | null;
  status: string;
  created_at: string;
  metrics?: Record<string, any>;
}

export interface SensitivityItem {
  param: string;
  label: string;
  swing: number;
  best_value: string;
  best_avg_score: number;
  worst_value: string;
  worst_avg_score: number;
  levels: { value: string; avg_score: number; count: number }[];
}

export interface OptimizationStudy {
  id: number;
  run_id: number;
  name: string;
  study_type: string;
  objective_profile: 'balanced' | 'high_precision' | 'high_recall' | 'low_latency';
  search_space: Record<string, any>;
  status: 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  progress_done: number;
  progress_total: number;
  stage_label: string;
  best_trial_id: number | null;
  summary: {
    total_candidates?: number;
    two_stage?: boolean;
    subset_size?: number;
    full_size?: number;
    best_trial_id?: number;
    best_config?: Record<string, any>;
    best_score?: number;
    baseline_score?: number | null;
    delta_score?: number | null;
    saved_retrieval_run_id?: number | null;
    sensitivity?: SensitivityItem[];
    study_mode?: string;
    canary_doc_count?: number;
    canary_testcase_count?: number;
    best_variant_name?: string;
    best_index_patch?: Record<string, any>;
    best_retrieval_config?: Record<string, any>;
  };
  error_message: string;
  created_at: string;
  updated_at: string;
}

export interface PipelineStageState {
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  detail: string;
  progress: number;
  duration_ms: number;
}

export interface PipelineJob {
  id: number;
  source_run_id: number;
  target_run_id: number | null;
  target_dataset_id: string;
  name: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  current_stage: string;
  stage_progress: Record<string, PipelineStageState>;
  stages_order: string[];
  config: Record<string, any>;
  error_message: string;
  total_duration_ms: number;
  created_at: string;
  updated_at: string;
}

export interface ForensicFinding {
  pattern: string;
  severity: 'high' | 'medium' | 'low';
  summary: string;
  evidence_refs: string[];
}

export interface LayerDiagnosis {
  layer: 'PARSING' | 'CHUNKING' | 'RETRIEVAL';
  status: 'OK' | 'ISSUES_FOUND' | 'SKIPPED_NO_DATA' | 'FALLBACK_ERROR';
  headline: string;
  findings: ForensicFinding[];
  recommended_knobs: Record<string, any>;
  vision_used?: boolean;
}

export interface HypothesisPack {
  id: string;
  name: string;
  scope: 'RETRIEVAL' | 'INDEX' | 'JOINT';
  reparse_required: boolean;
  priority: string;
  hypothesis_statement: string;
  conflict_resolution?: string;
  evidence_refs: string[];
  expected_gains: string[];
  regression_warnings: string[];
  index_patch: Record<string, any>;
  retrieval_patch: Record<string, any>;
  diff: ConfigDiffItem[];
}

export interface RegressionAutopsyItem {
  tc_code: string;
  question_class: string;
  question: string;
  baseline_cp: number;
  candidate_cp: number;
  why_failed: string;
  fix_hint: string;
}

export interface SwarmDiagnosisReport {
  ok: boolean;
  run_id: number;
  run_name: string;
  report_type: 'ADVISOR_SWARM' | 'REGRESSION_AUTOPSY';
  cached: boolean;
  evidence_sig: string;
  model_used: string;
  duration_ms: number;
  llm_calls: number;
  executive_summary: string;
  improvement_plan?: string[];
  architecture_mode?: string;
  drilldown_triggered?: boolean;
  supervisor_notes?: string[];
  evidence_counts: Record<string, number>;
  layer_diagnoses: LayerDiagnosis[];
  hypothesis_packs: HypothesisPack[];
  regressions_analyzed: RegressionAutopsyItem[];
  created_at: string;
}

export interface CanaryVariantDef {
  id: string;
  name: string;
  description: string;
  index_patch: Record<string, any>;
  is_baseline?: boolean;
}

export interface AiAdvisorChange {
  layer: 'PARSING' | 'CHUNKING' | 'RETRIEVAL';
  priority: 'high' | 'medium' | 'low';
  param_label: string;
  current_value: string;
  recommended_value: string;
  reason: string;
  affected_tcs?: string[];
}

export interface AiAdvisorReport {
  diagnosis: string;
  bottleneck_layer: 'PARSING' | 'CHUNKING' | 'RETRIEVAL' | 'BALANCED';
  expected_gain: string;
  proposed_changes: AiAdvisorChange[];
  patch_config: Record<string, any>;
}
