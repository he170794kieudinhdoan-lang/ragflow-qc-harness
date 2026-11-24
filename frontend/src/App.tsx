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
import SettingsModal from './components/SettingsModal';

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
  const [workflowMode, setWorkflowModeState] = useState<WorkflowModeId | null>(() => {
    try {
      const saved = localStorage.getItem('ragflow_qc_workflow_mode');
      return saved && saved in WORKFLOW_STEPS ? (saved as WorkflowModeId) : null;
    } catch {
      return null;
    }
  });
  const [tab, setTabState] = useState<string>(() => {
    try {
      return localStorage.getItem('ragflow_qc_active_tab') || 'overview';
    } catch {
      return 'overview';
    }
  });
  const [visitedTabs, setVisitedTabs] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('ragflow_qc_active_tab') || 'overview';
      return { overview: true, [saved]: true };
    } catch {
      return { overview: true };
    }
  });
  const [parsingProgress, setParsingProgress] = useState<{ rated: number; total: number }>({ rated: 0, total: 0 });

  const setWorkflowMode = (mode: WorkflowModeId | null) => {
    setWorkflowModeState(mode);
    try {
      if (mode) localStorage.setItem('ragflow_qc_workflow_mode', mode);
      else localStorage.removeItem('ragflow_qc_workflow_mode');
    } catch {
      // ignore storage errors
    }
  };

  const setTab = (next: string) => {
    setTabState(next);
    setVisitedTabs((prev) => (prev[next] ? prev : { ...prev, [next]: true }));
    try {
      localStorage.setItem('ragflow_qc_active_tab', next);
    } catch {
      // ignore storage errors
    }
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
  const [settingDefaults, setSettingDefaults] = useState<Record<string, string>>({});
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
    if (sRes.defaults) setSettingDefaults(sRes.defaults);
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
        persistActiveRun(null);
        await loadRuns();
        setRefreshKey((k) => k + 1);
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
            <svg viewBox="0 0 32 32" className="size-6 shrink-0" fill="none" aria-hidden="true">
              <rect width="32" height="32" rx="7" fill="#161616" />
              <polygon
                points="16 4.5 26 10.25 26 21.75 16 27.5 6 21.75 6 10.25 16 4.5"
                stroke="#fefefe"
                strokeWidth="1.6"
                strokeLinejoin="round"
                opacity="0.92"
              />
              <g strokeLinecap="round">
                <line x1="10.2" y1="15.2" x2="15.2" y2="10.2" stroke="#B2DDFF" strokeWidth="2.5" />
                <line x1="10.8" y1="20.4" x2="20.4" y2="10.8" stroke="#1570EF" strokeWidth="2.7" />
                <line x1="16.2" y1="21.0" x2="21.5" y2="15.7" stroke="#53B1FD" strokeWidth="2.5" />
              </g>
              <circle cx="24.5" cy="23.5" r="4.2" fill="#03aa5c" stroke="#161616" strokeWidth="1.5" />
              <path d="M22.7 23.5l1.2 1.2 2.4-2.4" stroke="#fefefe" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
                    Chọn Datasets
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
                  className={`inline-flex items-center gap-1.5 px-2 py-2 text-xs transition-colors shrink-0 border-b-2 -mb-px ${
                    active
                      ? 'text-[#18181b] border-[#18181b] font-semibold'
                      : gate.locked
                      ? 'text-[#a1a1aa] border-transparent cursor-not-allowed'
                      : 'text-[#52525b] border-transparent hover:text-[#18181b] hover:border-[#d4d4d8]'
                  }`}
                >
                  <span
                    className={`font-mono text-[10px] ${
                      active ? 'text-[#52a478] font-bold' : gate.locked ? 'text-[#a1a1aa]' : 'text-[#a1a1aa]'
                    }`}
                  >
                    {step.num}
                  </span>
                  <span>{step.label}</span>
                  {gate.locked ? (
                    <Lock className="size-3 text-[#a1a1aa]" />
                  ) : isDone ? (
                    <Check className="size-3 text-[#52a478]" />
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
            <CompareLabPage activeRun={activeRun} />
          </div>
        )}
      </main>

      {/* Pipeline & System Settings Modal */}
      {showSettings && (
        <SettingsModal
          settings={settings}
          defaults={settingDefaults}
          setSettings={setSettings}
          onClose={() => setShowSettings(false)}
          onSave={() => handleSaveAndTest(false)}
          onTestRagflow={() => handleSaveAndTest(true)}
          testing={testing}
          connMsg={connMsg}
          setConnMsg={setConnMsg}
        />
      )}
    </div>
  );
}
