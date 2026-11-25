import React, { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { Toaster, toast } from 'sonner';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  FileSearch,
  FlaskConical,
  GitCompare,
  Layers,
  Lock,
  Search,
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
import { BrandWordmark } from './components/BrandWordmark';
import { CompareLabPage } from './pages/CompareLabPage';
import SettingsModal from './components/SettingsModal';
import { PageLoader } from './components/PageLoader';

type StepId = 'workspace' | 'parsing' | 'chunking' | 'retrieval' | 'compare';

interface WorkflowStepDef {
  id: StepId;
  num: string;
  label: string;
}

const WORKFLOW_STEPS: Record<WorkflowModeId, WorkflowStepDef[]> = {
  full_pipeline: [
    { id: 'workspace', num: '01', label: 'Dataset & Đồng bộ' },
    { id: 'parsing', num: '02', label: 'Parsing' },
    { id: 'chunking', num: '03', label: 'Chunking' },
    { id: 'retrieval', num: '04', label: 'Golden & Retrieval' },
    { id: 'compare', num: '05', label: 'So sánh A/B' },
  ],
  retrieval_only: [
    { id: 'retrieval', num: '01', label: 'Golden & Retrieval' },
    { id: 'compare', num: '02', label: 'So sánh A/B' },
  ],
};

const MODULE_ICONS: Record<StepId, React.FC<{ className?: string }>> = {
  workspace: Database,
  parsing: FileSearch,
  chunking: Layers,
  retrieval: Search,
  compare: GitCompare,
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
  const [parsingProgress, setParsingProgress] = useState<{ rated: number; total: number }>({ rated: 0, total: 0 });
  const mainRef = useRef<HTMLElement>(null);
  const logoBeamRef = useRef<SVGRectElement>(null);

  useEffect(() => {
    if (!mainRef.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const tween = gsap.fromTo(
      mainRef.current,
      { opacity: 0.35, y: 6 },
      { opacity: 1, y: 0, duration: 0.22, ease: 'power2.out', clearProps: 'transform' }
    );
    return () => {
      tween.kill();
    };
  }, [tab]);

  const pulseLogoBeam = () => {
    if (!logoBeamRef.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    gsap.fromTo(
      logoBeamRef.current,
      { scaleX: 0.35, transformOrigin: 'left center' },
      { scaleX: 1, duration: 0.32, ease: 'power3.out' }
    );
  };

  const setWorkflowMode = (mode: WorkflowModeId | null) => {
    setWorkflowModeState(mode);
    try {
      if (mode) localStorage.setItem('ragflow_qc_workflow_mode', mode);
      else localStorage.removeItem('ragflow_qc_workflow_mode');
    } catch {
      // ignore storage errors
    }
  };

  const [visitedTabs, setVisitedTabs] = useState<string[]>(() => [tab]);

  const setTab = (next: string) => {
    setTabState(next);
    setVisitedTabs((prev) => (prev.includes(next) ? prev : [...prev, next]));
    try {
      localStorage.setItem('ragflow_qc_active_tab', next);
    } catch {
      // ignore storage errors
    }
  };

  const [transitionKey, setTransitionKey] = useState(0);
  const pendingNavRef = useRef<(() => void) | null>(null);

  const startWorkflow = (mode: WorkflowModeId) => {
    const firstStep = WORKFLOW_STEPS[mode][0].id;
    pendingNavRef.current = () => {
      setWorkflowMode(mode);
      setTab(firstStep);
    };
    setTransitionKey((k) => k + 1);
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

  useEffect(() => {
    setVisitedTabs([tab]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, refreshKey]);

  const hasVisited = (id: string) => tab === id || visitedTabs.includes(id);

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
    if (stepId === 'workspace' || stepId === 'retrieval' || stepId === 'compare') {
      return { locked: false, reason: '' };
    }
    if ((stepId === 'parsing' || stepId === 'chunking') && !hasSyncedChunks) {
      return { locked: true, reason: 'Cần tạo/chọn Dataset và đồng bộ chunks ở Bước 1 trước' };
    }
    return { locked: false, reason: '' };
  };

  const activeWorkflowMeta = workflowMode ? WORKFLOW_MODES.find((m) => m.id === workflowMode) : null;
  const currentSteps = workflowMode ? WORKFLOW_STEPS[workflowMode] : [];

  return (
    <div className="h-dvh w-screen flex flex-col bg-[#fefefe] text-[#161616] overflow-hidden">
      <PageLoader
        transitionKey={transitionKey}
        onMidpoint={() => {
          pendingNavRef.current?.();
          pendingNavRef.current = null;
        }}
      />
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
            onMouseEnter={pulseLogoBeam}
            className="flex items-center gap-2.5 text-[#141414] hover:opacity-85 transition-opacity shrink-0"
            title="Về Trang chủ"
          >
            <svg viewBox="0 0 32 32" className="size-6 shrink-0" fill="none" aria-hidden="true">
              {/* Precision QC viewfinder brackets (monochrome) */}
              <path d="M4.5 11V5.5C4.5 4.95 4.95 4.5 5.5 4.5H11" stroke="#141414" strokeWidth="2.2" strokeLinecap="square" />
              <path d="M27.5 21V26.5C27.5 27.05 27.05 27.5 26.5 27.5H21" stroke="#141414" strokeWidth="2.2" strokeLinecap="square" />
              {/* 3-Layer RAG pipeline bars: monochrome charcoal + single Emerald Green (#03aa5c) focal slice */}
              <rect x="8" y="9" width="11.5" height="2.6" rx="0.6" fill="#141414" />
              <rect x="21.5" y="9" width="2.5" height="2.6" rx="0.6" fill="#141414" opacity="0.35" />
              <rect ref={logoBeamRef} x="8" y="14.7" width="16" height="2.8" rx="0.6" fill="#03aa5c" />
              <rect x="12.5" y="20.4" width="11.5" height="2.6" rx="0.6" fill="#141414" />
              <circle cx="9.3" cy="21.7" r="1.4" fill="#03aa5c" />
            </svg>
            <BrandWordmark className="h-[19px] w-auto shrink-0" autoAnimate />
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

      {/* Independent Module Navigation Tabs (Monochrome + Sky Blue accent) */}
      {workflowMode && currentSteps.length > 1 && (
        <nav className="shrink-0 px-5 border-b border-[#e4e4e2] bg-[#fafaf9] flex items-center gap-1 overflow-x-auto">
          {currentSteps.map((step) => {
            const active = tab === step.id;
            const gate = isStepLocked(step.id);
            const Icon = MODULE_ICONS[step.id];
            const isDone =
              (step.id === 'workspace' && hasSyncedChunks) ||
              (step.id === 'parsing' && isParsingComplete);
            return (
              <button
                key={step.id}
                type="button"
                disabled={gate.locked}
                onClick={() => !gate.locked && setTab(step.id)}
                title={gate.locked ? gate.reason : step.label}
                className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-xs transition-colors shrink-0 border-b-2 -mb-px ${
                  active
                    ? 'text-[#141414] border-[#027a42] font-semibold bg-white'
                    : gate.locked
                    ? 'text-[#a1a1aa] border-transparent cursor-not-allowed'
                    : 'text-[#52525b] border-transparent hover:text-[#141414] hover:bg-white/60'
                }`}
              >
                <Icon
                  className={`size-3.5 ${
                    active ? 'text-[#027a42]' : gate.locked ? 'text-[#d4d4d8]' : 'text-[#71717a]'
                  }`}
                />
                <span>{step.label}</span>
                {gate.locked ? (
                  <Lock className="size-3 text-[#a1a1aa]" />
                ) : isDone ? (
                  <Check className="size-3 text-[#03aa5c]" />
                ) : null}
              </button>
            );
          })}
        </nav>
      )}

      <main ref={mainRef} className="flex-1 overflow-y-auto bg-[#fefefe]">
        {tab === 'overview' && (
          <OverviewPage activeRun={activeRun} onStartWorkflow={startWorkflow} />
        )}
        {hasVisited('workspace') && (
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
        {hasVisited('parsing') && (
          <div className={tab === 'parsing' ? 'h-full' : 'hidden'}>
            <ParsingPage
              activeRun={activeRun}
              errorCatalog={catalogs.parsing_errors}
              isActive={tab === 'parsing'}
              onProgressChange={(rated, total) => setParsingProgress({ rated, total })}
              onNextStep={() => setTab('chunking')}
            />
          </div>
        )}
        {hasVisited('chunking') && (
          <div className={tab === 'chunking' ? 'h-full' : 'hidden'}>
            <ChunkingPage
              activeRun={activeRun}
              errorCatalog={catalogs.chunking_errors}
              isActive={tab === 'chunking'}
              onNextStep={() => setTab('retrieval')}
            />
          </div>
        )}
        {hasVisited('retrieval') && (
          <div className={tab === 'retrieval' ? 'h-full' : 'hidden'}>
            <RetrievalPage activeRun={activeRun} />
          </div>
        )}
        {hasVisited('compare') && (
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
