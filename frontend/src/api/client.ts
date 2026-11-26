const BASE = '';

// In-flight deduplication + lightweight TTL cache for GET requests (prevents StrictMode & modal double-fetching)
const _INFLIGHT = new Map<string, Promise<any>>();
const _GET_CACHE = new Map<string, { ts: number; data: any }>();
// Monotonic epoch prevents slow in-flight GETs from re-poisoning _GET_CACHE after a mutation/account switch
let _cacheEpoch = 0;

// Active progress task ID attached synchronously to the next outgoing fetch() call
let _pendingProgressTaskId: string | null = null;

export function runWithProgressTask<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  _pendingProgressTaskId = taskId;
  try {
    return fn();
  } finally {
    _pendingProgressTaskId = null;
  }
}

export interface BackendTaskProgress {
  found: boolean;
  status: string;
  current: number;
  total: number;
  percent: number;
  stage: string;
  detail: string;
  has_real_progress: boolean;
  elapsed_ms: number;
}

export function invalidateApiCache(prefix?: string) {
  _cacheEpoch += 1;
  if (!prefix) {
    _GET_CACHE.clear();
    _INFLIGHT.clear();
    return;
  }
  for (const k of Array.from(_GET_CACHE.keys())) {
    if (k.startsWith(prefix)) _GET_CACHE.delete(k);
  }
  for (const k of Array.from(_INFLIGHT.keys())) {
    if (k.startsWith(prefix)) _INFLIGHT.delete(k);
  }
}

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const progressTaskId = _pendingProgressTaskId;
  const method = (options?.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    // Any mutation invalidates cached GET metadata before AND after settling
    _cacheEpoch += 1;
    _GET_CACHE.clear();
    _INFLIGHT.clear();
  }
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(progressTaskId ? { 'X-Progress-Task-Id': progressTaskId } : {}),
        ...(options?.headers || {}),
      },
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      const rawText = await res.text().catch(() => '');
      if (rawText) {
        try {
          const err = JSON.parse(rawText);
          msg = err.detail || err.message || msg;
        } catch {
          msg = rawText.slice(0, 300);
        }
      }
      throw new Error(msg);
    }
    return res.json();
  } finally {
    if (method !== 'GET') {
      _cacheEpoch += 1;
      _GET_CACHE.clear();
    }
  }
}

function cachedGet<T>(path: string, ttlMs = 15000): Promise<T> {
  const now = Date.now();
  const hit = _GET_CACHE.get(path);
  if (hit && now - hit.ts < ttlMs) {
    return Promise.resolve(hit.data as T);
  }
  const existing = _INFLIGHT.get(path);
  if (existing) return existing as Promise<T>;
  const startEpoch = _cacheEpoch;
  const p = req<T>(path)
    .then((data) => {
      if (_cacheEpoch === startEpoch) {
        _GET_CACHE.set(path, { ts: Date.now(), data });
      }
      return data;
    })
    .finally(() => {
      if (_INFLIGHT.get(path) === p) {
        _INFLIGHT.delete(path);
      }
    });
  _INFLIGHT.set(path, p);
  return p;
}

export const api = {
  // Real-time task progress polling
  getTaskProgress: (taskId: string) =>
    req<BackendTaskProgress>(`/api/progress/${encodeURIComponent(taskId)}`),

  // Settings
  getSettings: () => cachedGet<any>('/api/settings', 15000),
  saveSettings: (settings: Record<string, string>) =>
    req<{
      ok: boolean;
      workspace_cleared?: boolean;
      account_changed?: boolean;
      demo_changed?: boolean;
      has_ragflow_key?: boolean;
    }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    }),
  testRagflow: () => req<any>('/api/settings/test-ragflow', { method: 'POST' }),
  testLlm: () => req<any>('/api/settings/test-llm', { method: 'POST' }),
  testVision: () => req<any>('/api/settings/test-vision', { method: 'POST' }),
  testSystemOne: () => req<any>('/api/settings/test-systemone', { method: 'POST' }),

  // Workspace
  listDocuments: (runId?: number) =>
    req<any[]>(`/api/workspace/documents${runId ? `?run_id=${runId}` : ''}`),
  uploadDocument: (formData: FormData) =>
    req<any>('/api/workspace/documents/upload', { method: 'POST', body: formData }),
  uploadDocumentsBatch: (formData: FormData) =>
    req<any>('/api/workspace/documents/upload-batch', { method: 'POST', body: formData }),
  deleteDocument: (id: number) =>
    req<any>(`/api/workspace/documents/${id}`, { method: 'DELETE' }),
  clearDocuments: (syncedOnly = false) =>
    req<any>(`/api/workspace/documents?synced_only=${syncedOnly}`, { method: 'DELETE' }),

  listRuns: () => req<any[]>('/api/workspace/runs'),
  createRun: (payload: any) =>
    req<any>('/api/workspace/runs', { method: 'POST', body: JSON.stringify(payload) }),
  getRunParserConfig: (runId: number) =>
    cachedGet<any>(`/api/workspace/runs/${runId}/parser-config`, 30000),
  updateRunParserConfig: (runId: number, payload: any) =>
    req<any>(`/api/workspace/runs/${runId}/parser-config`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteRun: (id: number) => req<any>(`/api/workspace/runs/${id}`, { method: 'DELETE' }),
  getRunDocuments: (runId: number) => req<any[]>(`/api/workspace/runs/${runId}/documents`),
  getRunParseStatus: (runId: number) => req<any>(`/api/workspace/runs/${runId}/parse-status`),
  syncRunFromRagflow: (runId: number) =>
    req<any>(`/api/workspace/runs/${runId}/sync-from-ragflow?pull_chunks=true`, { method: 'POST' }),
  uploadAndParseRun: (runId: number) =>
    req<any>(`/api/workspace/runs/${runId}/upload-and-parse`, { method: 'POST' }),
  parseSingleDocument: (runId: number, docId: number) =>
    req<any>(`/api/workspace/runs/${runId}/documents/${docId}/parse`, { method: 'POST' }),

  // Parsing
  listParsingUnits: (runId: number, docId?: number) =>
    req<any[]>(`/api/parsing/runs/${runId}/units${docId ? `?document_id=${docId}` : ''}`),
  createParsingUnit: (runId: number, payload: any) =>
    req<any>(`/api/parsing/runs/${runId}/units`, { method: 'POST', body: JSON.stringify(payload) }),
  autoExtractUnits: (runId: number, docId: number) =>
    req<any>(`/api/parsing/runs/${runId}/documents/${docId}/auto-extract`, { method: 'POST' }),
  reExtractRunUnits: (runId: number, maxUnits = 25) =>
    req<any>(`/api/parsing/runs/${runId}/re-extract?max_units=${maxUnits}`, { method: 'POST' }),
  scoreParsingUnit: (unitId: number, payload: any) =>
    req<any>(`/api/parsing/units/${unitId}/score`, { method: 'PUT', body: JSON.stringify(payload) }),
  bulkApproveParsingUnits: (runId: number, unitIds: number[]) =>
    req<any>(`/api/parsing/runs/${runId}/bulk-approve-pass`, {
      method: 'POST',
      body: JSON.stringify({ unit_ids: unitIds }),
    }),
  bulkApproveFailParsingUnits: (
    runId: number,
    items: { unit_id: number; error_codes: string[]; char_error: boolean; severity: string; notes: string }[]
  ) =>
    req<any>(`/api/parsing/runs/${runId}/bulk-approve-fail`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),
  visionOcrUnit: (unitId: number) =>
    req<any>(`/api/parsing/units/${unitId}/vision-ocr`, { method: 'POST' }),
  batchVisionOcr: (runId: number) =>
    req<any>(`/api/parsing/runs/${runId}/batch-vision-ocr`, { method: 'POST' }),
  visionOcrDocument: (runId: number, documentId: number) =>
    req<any>(`/api/parsing/runs/${runId}/documents/${documentId}/vision-ocr`, { method: 'POST' }),
  llmJudgeParsing: (runId: number, onlyUnrated = true) =>
    req<any>(`/api/parsing/runs/${runId}/llm-judge?only_unrated=${onlyUnrated}`, { method: 'POST' }),
  getParsingMetrics: (runId: number) => cachedGet<any>(`/api/parsing/runs/${runId}/metrics`, 5000),

  // Chunking
  sampleChunks: (runId: number, opts?: number | { mode?: 'adaptive' | 'fixed' | 'full'; perDoc?: number }) => {
    const sp = new URLSearchParams();
    if (typeof opts === 'number') {
      sp.set('per_doc', String(opts));
    } else if (opts) {
      if (opts.mode) sp.set('mode', opts.mode);
      if (opts.mode === 'fixed' && typeof opts.perDoc === 'number') {
        sp.set('per_doc', String(opts.perDoc));
      }
    }
    const qs = sp.toString();
    return req<any>(`/api/chunking/runs/${runId}/sample${qs ? `?${qs}` : ''}`, { method: 'POST' });
  },
  llmJudgeChunks: (runId: number, overwriteManual = false, judgeEngine: 'auto' | 'jev' | 'llm' = 'auto') =>
    req<any>(
      `/api/chunking/runs/${runId}/llm-judge?overwrite_manual=${overwriteManual}&judge_engine=${judgeEngine}`,
      { method: 'POST' },
    ),
  listChunkEvals: (runId: number, sampledOnly = true) =>
    req<any[]>(`/api/chunking/runs/${runId}/evaluations?sampled_only=${sampledOnly}`),
  scoreChunk: (runId: number, chunkPk: number, payload: any) =>
    req<any>(`/api/chunking/runs/${runId}/chunks/${chunkPk}/score`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  getChunkingMetrics: (runId: number) => req<any>(`/api/chunking/runs/${runId}/metrics`),
  listAllChunks: (
    runId: number,
    params: {
      q?: string;
      document_id?: number;
      format_group?: string;
      flag?: string;
      min_tokens?: number;
      max_tokens?: number;
      sort?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const sp = new URLSearchParams();
    if (params.q) sp.set('q', params.q);
    if (params.document_id !== undefined) sp.set('document_id', String(params.document_id));
    if (params.format_group) sp.set('format_group', params.format_group);
    if (params.flag) sp.set('flag', params.flag);
    if (params.min_tokens !== undefined) sp.set('min_tokens', String(params.min_tokens));
    if (params.max_tokens !== undefined) sp.set('max_tokens', String(params.max_tokens));
    if (params.sort) sp.set('sort', params.sort);
    if (params.limit !== undefined) sp.set('limit', String(params.limit));
    if (params.offset !== undefined) sp.set('offset', String(params.offset));
    const qs = sp.toString();
    return req<any>(`/api/chunking/runs/${runId}/chunks${qs ? `?${qs}` : ''}`);
  },

  // Retrieval
  listTestcases: (runId?: number) =>
    req<any[]>(`/api/retrieval/testcases${runId ? `?run_id=${runId}` : ''}`),
  createTestcase: (payload: any) =>
    req<any>('/api/retrieval/testcases', { method: 'POST', body: JSON.stringify(payload) }),
  autoGenerateTestcases: (runId: number, totalCount = 50, replaceExisting = true, stylePrompt = '') =>
    req<any>('/api/retrieval/testcases/auto-generate', {
      method: 'POST',
      body: JSON.stringify({
        run_id: runId,
        total_count: totalCount,
        replace_existing: replaceExisting,
        style_prompt: stylePrompt,
      }),
    }),
  deleteTestcase: (id: number) => req<any>(`/api/retrieval/testcases/${id}`, { method: 'DELETE' }),
  clearTestcases: (runId?: number) =>
    req<any>(`/api/retrieval/testcases${runId ? `?run_id=${runId}` : ''}`, { method: 'DELETE' }),
  goldenTemplateXlsxUrl: () => '/api/retrieval/testcases/template-xlsx',
  previewImportGolden: (formData: FormData) =>
    req<any>('/api/retrieval/testcases/import-preview', { method: 'POST', body: formData }),
  commitImportGolden: (formData: FormData) =>
    req<any>('/api/retrieval/testcases/import-commit', { method: 'POST', body: formData }),
  listRagflowRerankModels: () => cachedGet<any[]>('/api/retrieval/ragflow-rerank-models', 60000),
  listRetrievalRuns: (runId?: number) =>
    cachedGet<any[]>(`/api/retrieval/runs${runId ? `?run_id=${runId}` : ''}`, 15000),
  executeRetrieval: (payload: any) =>
    req<any>('/api/retrieval/runs/execute', { method: 'POST', body: JSON.stringify(payload) }),
  autoTuneRetrieval: (payload: {
    run_id: number;
    vector_weights: number[];
    thresholds: number[];
    top_ks: number[];
    rerank_ids: string[];
    rerank_candidates?: number;
    objective?: string;
    judge_engine?: 'llm' | 'rule' | 'jev';
    bypass_cache?: boolean;
  }) => req<any>('/api/retrieval/auto-tune', { method: 'POST', body: JSON.stringify(payload) }),
  getLatestAutoTune: (runId: number) =>
    req<any>(`/api/retrieval/auto-tune/latest?run_id=${runId}`),
  clearLatestAutoTune: (runId: number) =>
    req<any>(`/api/retrieval/auto-tune/latest?run_id=${runId}`, { method: 'DELETE' }),
  rejudgeRetrievalRun: (rrId: number, payload: { judge_engine: 'jev' | 'llm' | 'rule'; name?: string }) =>
    req<any>(`/api/retrieval/runs/${rrId}/rejudge`, { method: 'POST', body: JSON.stringify(payload) }),
  deleteRetrievalRun: (rrId: number) =>
    req<any>(`/api/retrieval/runs/${rrId}`, { method: 'DELETE' }),
  setBaselineRetrievalRun: (rrId: number) =>
    req<any>(`/api/retrieval/runs/${rrId}/set-baseline`, { method: 'POST' }),
  getRetrievalResults: (rrId: number) => req<any[]>(`/api/retrieval/runs/${rrId}/results`),
  scoreRetrievalResult: (resultId: number, relevant: number, reason: string) =>
    req<any>(`/api/retrieval/results/${resultId}/score`, {
      method: 'PUT',
      body: JSON.stringify({ relevant, reason }),
    }),
  updateTestcaseMeta: (rrId: number, tcId: number, payload: any) =>
    req<any>(`/api/retrieval/runs/${rrId}/testcases/${tcId}/meta`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  diagnoseTestcase: (rrId: number, tcId: number) =>
    req<any>(`/api/retrieval/runs/${rrId}/testcases/${tcId}/diagnose`),

  // Analytics
  getOverview: (runId: number) => cachedGet<any>(`/api/analytics/runs/${runId}/overview`, 10000),
  getDiagnostics: (runId: number) => cachedGet<any>(`/api/analytics/runs/${runId}/diagnostics`, 15000),
  getRunsMatrix: () => cachedGet<any>('/api/analytics/runs-matrix', 15000),
  getRetrievalMatrix: (runId: number, rrId?: number) =>
    req<any>(`/api/analytics/runs/${runId}/retrieval-matrix${rrId ? `?retrieval_run_id=${rrId}` : ''}`),
  getBugReport: (runId: number, topN = 5) => req<any>(`/api/analytics/runs/${runId}/bug-report?top_n=${topN}`),
  compareRuns: (baselineRrId: number, candidateRrId: number) =>
    req<any>(`/api/analytics/compare?baseline_rr_id=${baselineRrId}&candidate_rr_id=${candidateRrId}`),
  compareTwoRunsFull: (baselineId: number, candidateId: number) =>
    cachedGet<any>(`/api/analytics/compare-runs?baseline_id=${baselineId}&candidate_id=${candidateId}`, 15000),
  getAiAdvisor: (runId: number) => cachedGet<any>(`/api/analytics/runs/${runId}/ai-advisor`, 30000),
  generateAiAdvisor: (runId: number) =>
    req<any>(`/api/analytics/runs/${runId}/ai-advisor`, { method: 'POST' }),
  promoteRunBaseline: (runId: number) =>
    req<any>(`/api/analytics/runs/${runId}/promote-baseline`, { method: 'POST' }),
  exportXlsxUrl: (runId: number) => `/api/analytics/runs/${runId}/export-xlsx`,

  // Optimizer & Config Advisor
  getConfigAdvisor: (runId: number) => req<any>(`/api/optimizer/runs/${runId}/advisor`),
  listOptimizationStudies: (runId: number) => req<any[]>(`/api/optimizer/runs/${runId}/studies`),
  getOptimizationStudy: (studyId: number) => req<any>(`/api/optimizer/studies/${studyId}`),
  startRetrievalSweep: (runId: number, payload: any) =>
    req<any>(`/api/optimizer/runs/${runId}/sweep`, { method: 'POST', body: JSON.stringify(payload) }),
  cancelOptimizationStudy: (studyId: number) =>
    req<any>(`/api/optimizer/studies/${studyId}/cancel`, { method: 'POST' }),
  deleteOptimizationStudy: (studyId: number) =>
    req<any>(`/api/optimizer/studies/${studyId}`, { method: 'DELETE' }),
  applyRecommendedConfig: (runId: number, payload: any) =>
    req<any>(`/api/optimizer/runs/${runId}/apply-config`, { method: 'POST', body: JSON.stringify(payload) }),
  getCanaryCandidates: (runId: number, maxDocs = 4) =>
    req<any>(`/api/optimizer/runs/${runId}/canary-candidates?max_docs=${maxDocs}`),
  startCanarySweep: (runId: number, payload: any) =>
    req<any>(`/api/optimizer/runs/${runId}/canary-sweep`, { method: 'POST', body: JSON.stringify(payload) }),
  getLatestAgentDiagnose: (runId: number) =>
    req<{ ok: boolean; report: any | null; is_stale?: boolean }>(`/api/optimizer/runs/${runId}/agent-diagnose/latest`),
  runAgentDiagnose: (runId: number, forceRefresh = false, includeVision = true) =>
    req<any>(`/api/optimizer/runs/${runId}/agent-diagnose`, {
      method: 'POST',
      body: JSON.stringify({ force_refresh: forceRefresh, include_vision: includeVision }),
    }),
  runCompareAutopsy: (baselineRrId: number, candidateRrId: number, forceRefresh = false) =>
    req<any>('/api/analytics/compare/autopsy', {
      method: 'POST',
      body: JSON.stringify({
        baseline_rr_id: baselineRrId,
        candidate_rr_id: candidateRrId,
        force_refresh: forceRefresh,
      }),
    }),

  // Clone-and-Run Pipeline
  listRagflowModels: () => cachedGet<{ embedding_models: any[]; rerank_models: any[] }>('/api/pipeline/ragflow-models', 60000),
  listPipelineJobs: (sourceRunId?: number) =>
    req<any[]>(`/api/pipeline/jobs${sourceRunId ? `?source_run_id=${sourceRunId}` : ''}`),
  getPipelineJob: (jobId: number) => req<any>(`/api/pipeline/jobs/${jobId}`),
  startCloneAndRun: (payload: any) =>
    req<any>('/api/pipeline/clone-and-run', { method: 'POST', body: JSON.stringify(payload) }),
  cancelPipelineJob: (jobId: number) =>
    req<any>(`/api/pipeline/jobs/${jobId}/cancel`, { method: 'POST' }),
};
