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
