import React, { useEffect, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  FlaskConical,
  Lock,
  Settings,
  X,
} from 'lucide-react';
import { api } from './api/client';
import { ErrorCodeDef, RunItem } from './types';
import { OverviewPage, WORKFLOW_MODES, WorkflowModeId } from './pages/OverviewPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { ParsingPage } from './pages/ParsingPage';
import { ChunkingPage } from './pages/ChunkingPage';
import { RetrievalPage } from './pages/RetrievalPage';
import { CompareLabPage } from './pages/CompareLabPage';

type StepId = 'workspace' | 'parsing' | 'chunking' | 'retrieval' | 'compare';

interface WorkflowStepDef {
  id: StepId;
  num: string;
  label: string;
}

const WORKFLOW_STEPS: Record<WorkflowModeId, WorkflowStepDef[]> = {
  full_pipeline: [
    { id: 'workspace', num: '01', label: 'Dataset & Đồng bộ' },
    { id: 'parsing', num: '02', label: 'Chấm Parsing' },
    { id: 'chunking', num: '03', label: 'Chấm Chunking' },
    { id: 'retrieval', num: '04', label: 'Golden & Retrieval' },
    { id: 'compare', num: '05', label: 'Tinh chỉnh & A/B' },
  ],
  retrieval_only: [
    { id: 'retrieval', num: '01', label: 'Golden & Retrieval' },
    { id: 'compare', num: '02', label: 'Tinh chỉnh & A/B' },
  ],
  parsing_only: [
    { id: 'workspace', num: '01', label: 'Dataset & Đồng bộ' },
    { id: 'parsing', num: '02', label: 'Chấm Parsing' },
  ],
  compare_only: [{ id: 'compare', num: '01', label: 'So sánh A/B Lab' }],
};

export default function App() {
  const [workflowMode, setWorkflowMode] = useState<WorkflowModeId | null>(null);
  const [tab, setTabState] = useState<string>('overview');
  const [visitedTabs, setVisitedTabs] = useState<Record<string, boolean>>({ overview: true });
  const [parsingProgress, setParsingProgress] = useState<{ rated: number; total: number }>({ rated: 0, total: 0 });

  const setTab = (next: string) => {
    setTabState(next);
    setVisitedTabs((prev) => (prev[next] ? prev : { ...prev, [next]: true }));
  };

  const startWorkflow = (mode: WorkflowModeId) => {
    setWorkflowMode(mode);
    const firstStep = WORKFLOW_STEPS[mode][0].id;
    setTab(firstStep);
  };

  const goHome = () => {
    setWorkflowMode(null);
    setTab('overview');
  };
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [activeRun, setActiveRunState] = useState<RunItem | null>(null);
  const activeRunIdRef = useRef<number | null>(
    (() => {
      try {
        const saved = localStorage.getItem('ragflow_qc_active_run_id');
        return saved ? Number(saved) : null;
      } catch {
        return null;
      }
    })()
  );

  const setActiveRun = (run: RunItem | null) => {
    activeRunIdRef.current = run ? run.id : null;
    try {
      if (run) localStorage.setItem('ragflow_qc_active_run_id', String(run.id));
      else localStorage.removeItem('ragflow_qc_active_run_id');
    } catch {
      // ignore storage errors
    }
    setActiveRunState(run);
  };
  const [catalogs, setCatalogs] = useState<{
    parsing_errors: ErrorCodeDef[];
    chunking_errors: ErrorCodeDef[];
  }>({ parsing_errors: [], chunking_errors: [] });

  // Settings Modal & Session Switcher
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'ragflow' | 'llm' | 'thresholds'>('ragflow');
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (sessionMenuRef.current && !sessionMenuRef.current.contains(e.target as Node)) {
        setSessionMenuOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSessionMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onEsc);
    };
  }, []);
  const [settings, setSettings] = useState<Record<string, string>>({
    ragflow_base_url: 'http://13.236.9.207',
    ragflow_api_key: '',
    min_chunk_chars: '50',
    max_chunk_chars: '2600',
  });
  const [hasKey, setHasKey] = useState(false);
  const [connMsg, setConnMsg] = useState<{ ok?: boolean; text?: string }>({});
  const [testing, setTesting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const ACTIVE_RUN_STORAGE_KEY = 'ragflow_qc_active_run_id';

  const persistActiveRun = (run: RunItem | null) => {
    setActiveRun(run);
    try {
      if (run) localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, String(run.id));
      else localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const loadRuns = async (preferredRunId?: number) => {
    const [rList, sRes] = await Promise.all([api.listRuns(), api.getSettings()]);
    setRuns(rList);
    setCatalogs(sRes.catalogs || { parsing_errors: [], chunking_errors: [] });
    const cleanSettings: Record<string, string> = {};
    for (const [k, v] of Object.entries(sRes.settings || {})) {
      if (typeof v === 'string') cleanSettings[k] = v;
    }
    setSettings((prev) => ({ ...prev, ...cleanSettings }));
    setHasKey(Boolean(sRes.settings?.has_ragflow_key));
    const targetId = preferredRunId ?? activeRunIdRef.current ?? Number(localStorage.getItem(ACTIVE_RUN_STORAGE_KEY) || '');
    if (rList.length > 0) {
      const keep = targetId ? rList.find((r: RunItem) => r.id === targetId) : null;
      const fallback = keep || rList.find((r: RunItem) => r.is_baseline) || rList[0];
      setActiveRun(fallback);
    } else {
      setActiveRun(null);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadRuns();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveAndTest = async (doTest: boolean) => {
    setTesting(true);
    setConnMsg({});
    try {
      const saveRes = await api.saveSettings(settings);
      setHasKey(Boolean(settings.ragflow_api_key?.trim()));
      if (saveRes?.account_changed) {
        // Connection moved to a different RAGFlow account: the local snapshot may be stale, but we
        // no longer silently delete runs. Reload to drop stale selections without touching data.
        await loadRuns();
      }
      if (doTest) {
        const res = await api.testRagflow();
        const msg = `Kết nối thành công · Tìm thấy ${res.dataset_count} dataset`;
        setConnMsg({ ok: true, text: msg });
        toast.success(msg);
      } else {
        setConnMsg({ ok: true, text: 'Đã lưu cấu hình kết nối.' });
        toast.success('Đã lưu cấu hình kết nối.');
      }
    } catch (e: any) {
      setConnMsg({ ok: false, text: e.message });
      toast.error(e.message);
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (!activeRun) {
      setParsingProgress({ rated: 0, total: 0 });
      return;
    }
    api
      .getParsingMetrics(activeRun.id)
      .then((m) => setParsingProgress({ rated: m?.rated_units || 0, total: m?.total_units || 0 }))
      .catch(() => setParsingProgress({ rated: 0, total: 0 }));
  }, [activeRun?.id]);

  const hasSyncedChunks = (activeRun?.chunk_count ?? 0) > 0;
  const isParsingComplete = parsingProgress.total > 0 && parsingProgress.rated >= parsingProgress.total;

  const isStepLocked = (stepId: StepId): { locked: boolean; reason: string } => {
    if (workflowMode !== 'full_pipeline') {
      if (stepId === 'parsing' && !hasSyncedChunks) {
        return { locked: true, reason: 'Cần đồng bộ chunks từ RAGFlow ở Bước 1 trước' };
      }
      return { locked: false, reason: '' };
    }
    if (stepId === 'workspace') return { locked: false, reason: '' };
    if (stepId === 'parsing') {
      return hasSyncedChunks
        ? { locked: false, reason: '' }
        : { locked: true, reason: 'Cần tạo/chọn Dataset và đồng bộ chunks ở Bước 1 trước' };
    }
    if (stepId === 'chunking' || stepId === 'retrieval' || stepId === 'compare') {
      if (!hasSyncedChunks) {
        return { locked: true, reason: 'Cần hoàn tất Bước 1 (Dataset & Đồng bộ) trước' };
      }
      if (!isParsingComplete) {
        return {
          locked: true,
          reason: `Cần chấm xong toàn bộ đoạn Parsing (${parsingProgress.rated}/${parsingProgress.total}) để mở khóa`,
        };
      }
    }
    return { locked: false, reason: '' };
  };

  const activeWorkflowMeta = workflowMode ? WORKFLOW_MODES.find((m) => m.id === workflowMode) : null;
  const currentSteps = workflowMode ? WORKFLOW_STEPS[workflowMode] : [];

  return (
    <div className="h-dvh w-screen flex flex-col bg-[#fefefe] text-[#161616] overflow-hidden">
      <Toaster
        position="bottom-right"
        richColors
        closeButton
        toastOptions={{ style: { borderRadius: '3px', fontSize: '13px' } }}
      />

      {/* TypeSafe AI Minimal 48px Top Bar (No Left Sidebar) */}
      <header className="h-12 shrink-0 px-5 border-b border-[#dedede] bg-[#fefefe] flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={goHome}
            className="flex items-center gap-2 text-[#161616] hover:opacity-75 transition-opacity shrink-0"
            title="Về Trang chủ"
          >
            <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.75">
              <polygon points="12 2 21 7 21 17 12 22 3 17 3 7 12 2" />
              <line x1="12" y1="22" x2="12" y2="12" />
              <line x1="21" y1="7" x2="12" y2="12" />
              <line x1="3" y1="7" x2="12" y2="12" />
            </svg>
            <span className="font-mono text-[12px] font-semibold tracking-wider whitespace-nowrap">RAGFLOW QC</span>
          </button>

          {activeWorkflowMeta && (
            <>
              <span className="text-[#dedede]">/</span>
              <button
                onClick={goHome}
                className="inline-flex items-center gap-1 text-xs text-[#71717a] hover:text-[#161616] transition-colors"
              >
                <ArrowLeft className="size-3.5" />
                <span>Trang chủ</span>
              </button>
              <span className="hidden sm:inline-flex ts-tag-teal">{activeWorkflowMeta.title}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Refined TypeSafe-style Session Switcher */}
          <div className="relative" ref={sessionMenuRef}>
            <button
              type="button"
              onClick={() => setSessionMenuOpen((v) => !v)}
              className={`inline-flex items-center gap-2.5 h-8 px-2.5 rounded-[3px] border text-left transition-colors ${
                sessionMenuOpen
                  ? 'border-[#03aa5c] bg-[#f2fbf6]'
                  : 'border-[#dedede] bg-[#f7f7f6] hover:border-[#161616]'
              }`}
              title="Chuyển phiên kiểm thử (Dataset)"
            >
              <span className={`size-1.5 rounded-full shrink-0 ${activeRun ? 'bg-[#03aa5c]' : 'bg-[#a1a1aa]'}`} />
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-medium text-[#161616] max-w-[150px] truncate">
                  {activeRun ? activeRun.name : 'Chưa có phiên'}
                </span>
                {activeRun?.is_baseline ? (
                  <span className="font-mono text-[9px] uppercase px-1 py-0.5 bg-[#03aa5c]/15 text-[#027a42] border border-[#03aa5c]/30 rounded-[2px]">
                    Chuẩn
                  </span>
                ) : null}
                {activeRun && (
                  <span className="hidden md:inline font-mono text-[10px] text-[#71717a] tabular-nums">
                    {activeRun.doc_count ?? 0}f · {activeRun.chunk_count ?? 0}c
                  </span>
                )}
              </div>
              <ChevronDown
                className={`size-3.5 text-[#71717a] shrink-0 transition-transform ${sessionMenuOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {sessionMenuOpen && (
              <div className="absolute right-0 mt-1.5 w-72 bg-[#fefefe] border border-[#dedede] rounded-[3px] shadow-md z-50 overflow-hidden">
                <div className="px-3 py-2 border-b border-[#ededeb] bg-[#f7f7f6] flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-[#71717a]">
                    Chọn phiên kiểm thử
                  </span>
                  <span className="font-mono text-[10px] text-[#71717a]">{runs.length} phiên</span>
                </div>
                <div className="max-h-64 overflow-y-auto divide-y divide-[#f0f0ee]">
                  {runs.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-[#71717a] text-center">Chưa có phiên nào</div>
                  ) : (
                    runs.map((r) => {
                      const isCur = activeRun?.id === r.id;
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => {
                            persistActiveRun(r);
                            setSessionMenuOpen(false);
                          }}
                          className={`w-full px-3 py-2 text-left flex items-center justify-between gap-2 transition-colors ${
                            isCur ? 'bg-[#f2fbf6]' : 'hover:bg-[#f7f7f6]'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={`text-xs truncate ${isCur ? 'font-semibold text-[#161616]' : 'font-medium text-[#3d3d3d]'}`}>
                                {r.name}
                              </span>
                              {r.is_baseline ? (
                                <span className="font-mono text-[9px] uppercase px-1 bg-[#03aa5c]/15 text-[#027a42] rounded-[2px] shrink-0">
                                  Chuẩn
                                </span>
                              ) : null}
                            </div>
                            <div className="font-mono text-[10px] text-[#71717a] mt-0.5 tabular-nums">
                              {r.doc_count ?? 0} tài liệu · {r.chunk_count ?? 0} chunks
                            </div>
                          </div>
                          {isCur && <Check className="size-3.5 text-[#03aa5c] shrink-0" />}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          <button
            onClick={() => setShowSettings(true)}
            className="ts-btn-secondary h-8 py-0 px-2.5 text-xs"
            title="Cài đặt kết nối RAGFlow, LLM & Ngưỡng kiểm thử"
          >
            <span className={`size-1.5 rounded-full ${hasKey ? 'bg-[#03aa5c]' : 'bg-amber-500'}`} />
            <Settings className="size-3.5" strokeWidth={1.6} />
            <span>Cài đặt</span>
          </button>
        </div>
      </header>

      {/* Unified Gated Horizontal Workflow Stepper */}
      {workflowMode && currentSteps.length > 1 && (
        <nav className="shrink-0 px-5 py-2 border-b border-[#dedede] bg-[#f7f7f6] flex items-center gap-1 overflow-x-auto">
          {currentSteps.map((step, idx) => {
            const active = tab === step.id;
            const gate = isStepLocked(step.id);
            const isDone =
              (step.id === 'workspace' && hasSyncedChunks) ||
              (step.id === 'parsing' && isParsingComplete);
            return (
              <React.Fragment key={step.id}>
                {idx > 0 && <span className="text-[#d4d4d2] font-mono text-xs px-1">→</span>}
                <button
                  type="button"
                  disabled={gate.locked}
                  onClick={() => !gate.locked && setTab(step.id)}
                  title={gate.locked ? gate.reason : step.label}
                  className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-[2px] text-xs transition-colors shrink-0 border ${
                    active
                      ? 'bg-[#161616] text-[#fefefe] border-[#161616] font-medium'
                      : gate.locked
                      ? 'bg-transparent text-[#a1a1aa] border-transparent cursor-not-allowed'
                      : 'bg-[#fefefe] text-[#3d3d3d] border-[#dedede] hover:border-[#161616] hover:text-[#161616]'
                  }`}
                >
                  <span
                    className={`font-mono text-[10px] ${
                      active ? 'text-[#03aa5c]' : gate.locked ? 'text-[#a1a1aa]' : 'text-[#71717a]'
                    }`}
                  >
                    {step.num}
                  </span>
                  <span>{step.label}</span>
                  {gate.locked ? (
                    <Lock className="size-3 text-[#a1a1aa]" />
                  ) : isDone ? (
                    <Check className={`size-3 ${active ? 'text-[#03aa5c]' : 'text-[#03aa5c]'}`} />
                  ) : null}
                </button>
              </React.Fragment>
            );
          })}
        </nav>
      )}

      <main className="flex-1 overflow-y-auto bg-[#fefefe]">
        {visitedTabs.overview && (
          <div className={tab === 'overview' ? '' : 'hidden'}>
            <OverviewPage activeRun={activeRun} onStartWorkflow={startWorkflow} />
          </div>
        )}
        {visitedTabs.workspace && (
          <div className={tab === 'workspace' ? '' : 'hidden'}>
            <WorkspacePage
              activeRun={activeRun}
              runs={runs}
              refreshKey={refreshKey}
              onReloadRuns={loadRuns}
              onSelectRun={persistActiveRun}
              onOpenSettings={() => setShowSettings(true)}
              onNextStep={() => setTab('parsing')}
            />
          </div>
        )}
        {visitedTabs.parsing && (
          <div className={tab === 'parsing' ? 'h-full' : 'hidden'}>
            <ParsingPage
              activeRun={activeRun}
              errorCatalog={catalogs.parsing_errors}
              onProgressChange={(rated, total) => setParsingProgress({ rated, total })}
              onNextStep={workflowMode === 'parsing_only' ? undefined : () => setTab('chunking')}
            />
          </div>
        )}
        {visitedTabs.chunking && (
          <div className={tab === 'chunking' ? 'h-full' : 'hidden'}>
            <ChunkingPage
              activeRun={activeRun}
              errorCatalog={catalogs.chunking_errors}
              onNextStep={() => setTab('retrieval')}
            />
          </div>
        )}
        {visitedTabs.retrieval && (
          <div className={tab === 'retrieval' ? 'h-full' : 'hidden'}>
            <RetrievalPage activeRun={activeRun} />
          </div>
        )}
        {visitedTabs.compare && (
          <div className={tab === 'compare' ? '' : 'hidden'}>
            <CompareLabPage />
          </div>
        )}
      </main>

      {/* Clean 3-Tab Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4">
          <div className="bg-[#fefefe] border border-[#dedede] rounded-[4px] w-full max-w-lg overflow-hidden shadow-lg">
            {/* Modal Header */}
            <div className="px-6 pt-5 pb-3 border-b border-[#dedede] flex items-start justify-between">
              <div>
                <div className="ts-eyebrow">SYSTEM SETTINGS</div>
                <h2 className="text-base font-semibold text-[#161616] mt-0.5">Cài đặt hệ thống</h2>
              </div>
              <button
                onClick={() => setShowSettings(false)}
                aria-label="Đóng"
                className="p-1 text-[#71717a] hover:text-[#161616] rounded-[3px] hover:bg-[#f4f4f2]"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* 3 Organized Tabs */}
            <div className="px-6 border-b border-[#dedede] bg-[#f7f7f6] flex items-center gap-1">
              {(
                [
                  { id: 'ragflow', label: 'Kết nối RAGFlow' },
                  { id: 'llm', label: 'LLM Chấm tự động' },
                  { id: 'thresholds', label: 'Ngưỡng kiểm thử' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setSettingsTab(t.id);
                    setConnMsg({});
                  }}
                  className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                    settingsTab === t.id
                      ? 'border-[#03aa5c] text-[#161616]'
                      : 'border-transparent text-[#71717a] hover:text-[#161616]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="p-6 space-y-4">
              {settingsTab === 'ragflow' && (
                <div className="space-y-3.5">
                  <div>
                    <label className="block text-xs font-medium text-[#3d3d3d] mb-1">
                      Địa chỉ RAGFlow (Base URL)
                    </label>
                    <input
                      className="ts-input w-full font-mono text-xs"
                      value={settings.ragflow_base_url || ''}
                      onChange={(e) => setSettings({ ...settings, ragflow_base_url: e.target.value })}
                      placeholder="http://13.236.9.207"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#3d3d3d] mb-1">
                      RAGFlow API Key
                    </label>
                    <input
                      type="password"
                      className="ts-input w-full font-mono text-xs"
                      value={settings.ragflow_api_key || ''}
                      onChange={(e) => setSettings({ ...settings, ragflow_api_key: e.target.value })}
                      placeholder="ragflow-xxxxxxxxxxxxxxxx"
                    />
                  </div>
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => handleSaveAndTest(true)}
                      disabled={testing}
                      className="ts-btn-secondary text-xs"
                    >
                      <FlaskConical className="size-3.5 text-[#03aa5c]" />
                      {testing ? 'Đang kiểm tra...' : 'Kiểm tra kết nối RAGFlow'}
                    </button>
                  </div>
                </div>
              )}

              {settingsTab === 'llm' && (
                <div className="space-y-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-[#71717a]">Chọn nhanh nhà cung cấp:</span>
                    <div className="flex items-center gap-1 text-[11px]">
                      {[
                        { label: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
                        { label: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
                        { label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
                        { label: 'Ollama', url: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
                      ].map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => setSettings({ ...settings, llm_base_url: p.url, llm_model: p.model })}
                          className="px-2 py-0.5 bg-[#f7f7f6] hover:bg-[#03aa5c]/15 hover:text-[#027a42] border border-[#dedede] text-[#3d3d3d] rounded-[2px] transition-colors"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-[#3d3d3d] mb-1">LLM Base URL</label>
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={settings.llm_base_url || ''}
                        onChange={(e) => setSettings({ ...settings, llm_base_url: e.target.value })}
                        placeholder="https://api.deepseek.com/v1"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#3d3d3d] mb-1">Model</label>
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={settings.llm_model || ''}
                        onChange={(e) => setSettings({ ...settings, llm_model: e.target.value })}
                        placeholder="deepseek-chat"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#3d3d3d] mb-1">LLM API Key</label>
                    <input
                      type="password"
                      className="ts-input w-full font-mono text-xs"
                      value={settings.llm_api_key || ''}
                      onChange={(e) => setSettings({ ...settings, llm_api_key: e.target.value })}
                      placeholder="sk-... hoặc AIza..."
                    />
                  </div>
                  <div className="pt-1">
                    <button
                      type="button"
                      disabled={testing}
                      onClick={async () => {
                        setTesting(true);
                        try {
                          await api.saveSettings(settings);
                          const res = await api.testLlm();
                          toast.success(`Kết nối LLM thành công (${res.model}).`);
                          setConnMsg({ ok: true, text: `Kết nối LLM thành công (${res.model}).` });
                        } catch (e: any) {
                          toast.error(e.message);
                          setConnMsg({ ok: false, text: e.message });
                        } finally {
                          setTesting(false);
                        }
                      }}
                      className="ts-btn-secondary text-xs"
                    >
                      <FlaskConical className="size-3.5 text-[#03aa5c]" />
                      {testing ? 'Đang kiểm tra...' : 'Kiểm tra kết nối LLM'}
                    </button>
                  </div>
                </div>
              )}

              {settingsTab === 'thresholds' && (
                <div className="space-y-3.5">
                  <p className="text-xs text-[#71717a] leading-relaxed">
                    Các ngưỡng ký tự dùng để tự động gắn cờ cảnh báo chunk vụn hoặc chunk quá dài khi đồng bộ và chấm ở Bước 3 (Chunking).
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-[#3d3d3d] mb-1">
                        Ngưỡng chunk vụn (ký tự)
                      </label>
                      <input
                        type="number"
                        className="ts-input w-full font-mono text-xs"
                        value={settings.min_chunk_chars || '50'}
                        onChange={(e) => setSettings({ ...settings, min_chunk_chars: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#3d3d3d] mb-1">
                        Ngưỡng quá dài (ký tự)
                      </label>
                      <input
                        type="number"
                        className="ts-input w-full font-mono text-xs"
                        value={settings.max_chunk_chars || '2600'}
                        onChange={(e) => setSettings({ ...settings, max_chunk_chars: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              )}

              {connMsg.text && (
                <div
                  className={`text-xs px-3 py-2 rounded-[3px] border flex items-center gap-2 ${
                    connMsg.ok
                      ? 'bg-[#f2fbf6] border-[#03aa5c]/40 text-[#027a42]'
                      : 'bg-rose-50 border-rose-200 text-rose-800'
                  }`}
                >
                  {connMsg.ok && <CheckCircle2 className="size-3.5 shrink-0" />}
                  <span>{connMsg.text}</span>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3.5 bg-[#f7f7f6] border-t border-[#dedede] flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                className="ts-btn-secondary text-xs"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={async () => {
                  await handleSaveAndTest(false);
                  setShowSettings(false);
                }}
                disabled={testing}
                className="ts-btn-primary text-xs"
              >
                Lưu cài đặt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
