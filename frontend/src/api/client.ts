const BASE = '';

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options?.headers || {}),
    },
    ...options,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      msg = err.detail || err.message || msg;
    } catch {
      msg = await res.text();
    }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  // Settings
  getSettings: () => req<any>('/api/settings'),
  saveSettings: (settings: Record<string, string>) =>
    req<{ ok: boolean; workspace_cleared?: boolean; account_changed?: boolean }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    }),
  testRagflow: () => req<any>('/api/settings/test-ragflow', { method: 'POST' }),
  testLlm: () => req<any>('/api/settings/test-llm', { method: 'POST' }),

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
    req<any>(`/api/workspace/runs/${runId}/parser-config`),
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
  getParsingMetrics: (runId: number) => req<any>(`/api/parsing/runs/${runId}/metrics`),

  // Chunking
  sampleChunks: (runId: number, perDoc = 5) =>
    req<any>(`/api/chunking/runs/${runId}/sample?per_doc=${perDoc}`, { method: 'POST' }),
  listChunkEvals: (runId: number, sampledOnly = true) =>
    req<any[]>(`/api/chunking/runs/${runId}/evaluations?sampled_only=${sampledOnly}`),
  scoreChunk: (runId: number, chunkPk: number, payload: any) =>
    req<any>(`/api/chunking/runs/${runId}/chunks/${chunkPk}/score`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  getChunkingMetrics: (runId: number) => req<any>(`/api/chunking/runs/${runId}/metrics`),

  // Retrieval
  listTestcases: () => req<any[]>('/api/retrieval/testcases'),
  createTestcase: (payload: any) =>
    req<any>('/api/retrieval/testcases', { method: 'POST', body: JSON.stringify(payload) }),
  autoGenerateTestcases: (runId: number, perDoc = 3, replaceExisting = false, useLlm = false) =>
    req<any>('/api/retrieval/testcases/auto-generate', {
      method: 'POST',
      body: JSON.stringify({ run_id: runId, per_doc: perDoc, replace_existing: replaceExisting, use_llm: useLlm }),
    }),
  deleteTestcase: (id: number) => req<any>(`/api/retrieval/testcases/${id}`, { method: 'DELETE' }),
  listRetrievalRuns: (runId?: number) =>
    req<any[]>(`/api/retrieval/runs${runId ? `?run_id=${runId}` : ''}`),
  executeRetrieval: (payload: any) =>
    req<any>('/api/retrieval/runs/execute', { method: 'POST', body: JSON.stringify(payload) }),
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

  // Analytics & Demo
  getOverview: (runId: number) => req<any>(`/api/analytics/runs/${runId}/overview`),
  getDiagnostics: (runId: number) => req<any>(`/api/analytics/runs/${runId}/diagnostics`),
  compareRuns: (baselineRrId: number, candidateRrId: number) =>
    req<any>(`/api/analytics/compare?baseline_rr_id=${baselineRrId}&candidate_rr_id=${candidateRrId}`),
  seedDemo: () => req<any>('/api/analytics/seed-demo', { method: 'POST' }),
  seedCanonical: () => req<any>('/api/analytics/seed-canonical', { method: 'POST' }),
  exportXlsxUrl: (runId: number) => `/api/analytics/runs/${runId}/export-xlsx`,
};
