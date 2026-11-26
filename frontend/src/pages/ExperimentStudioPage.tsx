import React, { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  FileSearch,
  GitCompare,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { AiAdvisorReport, PipelineJob, RunItem } from '../types';
import { AnimatedNumber } from '../components/AnimatedNumber';
import { CloneConfigWorkbench } from '../components/CloneConfigWorkbench';
import { RunThreeLayerCompareModal } from '../components/RunThreeLayerCompareModal';

interface Props {
  activeRun: RunItem | null;
  runs: RunItem[];
  onSelectRun: (run: RunItem) => void;
  onRefreshRuns: () => Promise<void>;
  onOpenFullAnalysis: (run?: RunItem) => void;
}

function fmtSec(ms?: number) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}

export const ExperimentStudioPage: React.FC<Props> = ({
  activeRun,
  runs,
  onSelectRun,
  onRefreshRuns,
  onOpenFullAnalysis,
}) => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const menuARef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const nodeBRef = useRef<HTMLDivElement>(null);
  const connectorPathRef = useRef<SVGPathElement>(null);

  const [overviewA, setOverviewA] = useState<any>(null);
  const [menuAOpen, setMenuAOpen] = useState(false);

  // Right node [B] state
  const [clonedDraft, setClonedDraft] = useState(false);
  const [activeJob, setActiveJob] = useState<PipelineJob | null>(null);
  const [otherRunningJob, setOtherRunningJob] = useState<PipelineJob | null>(null);
  const [comparePreview, setComparePreview] = useState<any>(null);

  // Modals / Drawers
  const [showBaselineConfig, setShowBaselineConfig] = useState(false);
  const [showWorkbench, setShowWorkbench] = useState(false);
  const [aiPatchForWorkbench, setAiPatchForWorkbench] = useState<Record<string, any> | null>(null);
  const [showCompareModal, setShowCompareModal] = useState(false);

  // AI Advisor Drawer state
  const [showAdvisor, setShowAdvisor] = useState(false);
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const [advisorData, setAdvisorData] = useState<{
    report: AiAdvisorReport;
    model_used?: string;
    duration_ms?: number;
    created_at?: string;
  } | null>(null);

  const cloneAnimCtxRef = useRef<gsap.Context | null>(null);
  useEffect(() => {
    return () => {
      cloneAnimCtxRef.current?.revert();
      cloneAnimCtxRef.current = null;
    };
  }, []);

  // Load overview metrics + latest pipeline job for activeRun (single listPipelineJobs call + cancellation guard)
  useEffect(() => {
    let cancelled = false;
    if (!activeRun) {
      setOverviewA(null);
      setActiveJob(null);
      setOtherRunningJob(null);
      setAdvisorData(null);
      setComparePreview(null);
      setClonedDraft(false);
      return;
    }
    api
      .getOverview(activeRun.id)
      .then((ov) => {
        if (!cancelled) setOverviewA(ov);
      })
      .catch(() => {
        if (!cancelled) setOverviewA(null);
      });
    api
      .listPipelineJobs()
      .then((allJobs) => {
        if (cancelled) return;
        const list: PipelineJob[] = allJobs || [];
        const ownJobs = list.filter((j) => j.source_run_id === activeRun.id);
        if (ownJobs.length > 0) {
          setActiveJob(ownJobs[0]);
          setClonedDraft(true);
        } else {
          setActiveJob(null);
          setClonedDraft(false);
        }
        const runningOther = list.find(
          (j) => (j.status === 'running' || j.status === 'queued') && j.source_run_id !== activeRun.id
        );
        setOtherRunningJob(runningOther || null);
      })
      .catch(() => {
        if (!cancelled) setOtherRunningJob(null);
      });
    api
      .getAiAdvisor(activeRun.id)
      .then((res) => {
        if (cancelled) return;
        if (res?.cached && res?.report) setAdvisorData(res);
        else setAdvisorData(null);
      })
      .catch(() => {
        if (!cancelled) setAdvisorData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRun?.id]);

  // Poll active job when queued or running (with in-flight guard, cancelled check, and document.hidden pause)
  useEffect(() => {
    if (!activeJob || (activeJob.status !== 'queued' && activeJob.status !== 'running')) return;
    let cancelled = false;
    let inFlight = false;
    const jobId = activeJob.id;
    const timer = window.setInterval(async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const fresh = await api.getPipelineJob(jobId);
        if (cancelled) return;
        setActiveJob(fresh);
        if (fresh.status === 'completed') {
          toast.success(`Nhánh "${fresh.name}" đã hoàn tất toàn bộ 6 bước!`);
          await onRefreshRuns();
        } else if (fresh.status === 'failed') {
          toast.error(`Nhánh "${fresh.name}" lỗi: ${fresh.error_message}`);
        }
      } catch {
        // ignore transient poll error
      } finally {
        inFlight = false;
      }
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeJob?.id, activeJob?.status]);

  // Load 3-layer delta preview once job completes
  useEffect(() => {
    let cancelled = false;
    if (!activeRun || !activeJob || activeJob.status !== 'completed' || !activeJob.target_run_id) {
      setComparePreview(null);
      return;
    }
    api
      .compareTwoRunsFull(activeRun.id, activeJob.target_run_id)
      .then((res) => {
        if (!cancelled) setComparePreview(res);
      })
      .catch(() => {
        if (!cancelled) setComparePreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRun?.id, activeJob?.status, activeJob?.target_run_id]);

  // Entrance GSAP choreography
  useEffect(() => {
    if (!canvasRef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      tl.fromTo('.studio-head', { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.42, stagger: 0.06 })
        .fromTo('.studio-node', { opacity: 0, y: 18, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: 0.1 }, '-=0.22');
      if (connectorPathRef.current) {
        const len = connectorPathRef.current.getTotalLength();
        gsap.fromTo(
          connectorPathRef.current,
          { strokeDasharray: len, strokeDashoffset: len },
          { strokeDashoffset: 0, duration: 0.75, ease: 'power2.inOut', delay: 0.25 }
        );
      }
    }, canvasRef);
    return () => ctx.revert();
  }, [activeRun?.id]);

  // Staggered reveal for [A] floating action menu
  useEffect(() => {
    if (!menuAOpen || !menuARef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        '.menu-a-item',
        { opacity: 0, y: -10, scale: 0.97 },
        { opacity: 1, y: 0, scale: 1, duration: 0.3, stagger: 0.055, ease: 'power3.out' }
      );
    }, menuARef);
    return () => ctx.revert();
  }, [menuAOpen]);

  // Refined GSAP Clone Transition (no clunky hardcoded ghost box)
  const triggerCloneAnimation = (openWorkbenchAfter = false, patch: Record<string, any> | null = null) => {
    setActiveJob(null);
    setComparePreview(null);
    setAiPatchForWorkbench(patch);
    setClonedDraft(true);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !nodeBRef.current) {
      if (openWorkbenchAfter) setShowWorkbench(true);
      return;
    }

    cloneAnimCtxRef.current?.revert();
    cloneAnimCtxRef.current = gsap.context(() => {
      // When accepting AI recommendations, skip canvas ghost completely and open Workbench crisply
      if (openWorkbenchAfter) {
        if (connectorPathRef.current) {
          const len = connectorPathRef.current.getTotalLength();
          gsap.fromTo(
            connectorPathRef.current,
            { strokeDasharray: len, strokeDashoffset: len },
            { strokeDashoffset: 0, duration: 0.32, ease: 'power2.out' }
          );
        }
        gsap.fromTo(
          nodeBRef.current,
          { opacity: 0.5, y: 6 },
          {
            opacity: 1,
            y: 0,
            duration: 0.24,
            ease: 'power2.out',
            clearProps: 'transform',
            onComplete: () => setShowWorkbench(true),
          }
        );
        return;
      }

      // Direct click on [+]: crisp SVG rail draw + subtle editorial settle on [B]
      const tl = gsap.timeline();
      if (connectorPathRef.current) {
        const len = connectorPathRef.current.getTotalLength();
        tl.fromTo(
          connectorPathRef.current,
          { strokeDasharray: len, strokeDashoffset: len },
          { strokeDashoffset: 0, duration: 0.38, ease: 'power2.out' },
          0
        );
      }
      tl.fromTo(
        nodeBRef.current,
        { opacity: 0, y: 8, scale: 0.985 },
        { opacity: 1, y: 0, scale: 1, duration: 0.32, ease: 'power3.out', clearProps: 'transform' },
        0.08
      );
    });
  };

  const handleRunAiAdvisor = async (forceRegen = false) => {
    if (!activeRun) return;
    setShowAdvisor(true);
    if (!forceRegen && advisorData?.report) return;
    setAdvisorLoading(true);
    try {
      const res = await api.generateAiAdvisor(activeRun.id);
      setAdvisorData(res);
    } catch (e: any) {
      toast.error(e.message || 'AI Advisor gặp lỗi');
    } finally {
      setAdvisorLoading(false);
    }
  };

  const handleCancelJob = async () => {
    if (!activeJob) return;
    try {
      await api.cancelPipelineJob(activeJob.id);
      const fresh = await api.getPipelineJob(activeJob.id);
      setActiveJob(fresh);
      toast.info('Đã hủy quy trình chạy nhánh [B].');
    } catch (e: any) {
      toast.error(e.message || 'Không hủy được job');
    }
  };

  const p = overviewA?.parsing || {};
  const c = overviewA?.chunking || {};
  const r = overviewA?.retrieval || {};

  // Compute overall progress ring for running job
  const stagesOrder = activeJob?.stages_order || [
    'create_dataset',
    'upload_docs',
    'ragflow_parse',
    'parsing_qc',
    'chunking_qc',
    'retrieval_qc',
  ];
  const overallPct = activeJob
    ? Math.round(
        stagesOrder.reduce((acc, k) => {
          const st = activeJob.stage_progress?.[k];
          if (!st) return acc;
          if (st.status === 'done') return acc + 100;
          if (st.status === 'running') return acc + (st.progress || 10);
          return acc;
        }, 0) / Math.max(stagesOrder.length, 1)
      )
    : 0;

  if (!activeRun) {
    return (
      <div className="max-w-3xl mx-auto py-20 text-center space-y-3">
        <p className="text-[14px] text-[#52525b]">Chưa có phiên Baseline nào được chọn.</p>
        <button
          onClick={() => onOpenFullAnalysis()}
          className="px-4 py-2 text-[13px] font-medium bg-[#161616] text-white rounded-[4px]"
        >
          Đi tới bước 01 để chọn Dataset
        </button>
      </div>
    );
  }

  const anyOverlayOpen = showBaselineConfig || showWorkbench || showAdvisor || showCompareModal;

  return (
    <div className="relative min-h-full w-full bg-[#fefefe] overflow-hidden">
      {/* Full-bleed subtle architectural illustration backdrop matched to OverviewPage */}
      <div
        aria-hidden="true"
        className="pointer-events-none select-none absolute inset-0 bg-no-repeat bg-bottom bg-cover opacity-[0.26]"
        style={{
          backgroundImage: 'url(/homepage-bg.png?v=2)',
          maskImage: 'linear-gradient(to top, rgba(0,0,0,1) 45%, rgba(0,0,0,0.45) 80%, rgba(0,0,0,0) 100%)',
          WebkitMaskImage: 'linear-gradient(to top, rgba(0,0,0,1) 45%, rgba(0,0,0,0.45) 80%, rgba(0,0,0,0) 100%)',
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none select-none absolute inset-0 bg-[#0f172a]/[0.06]"
      />

      <div ref={canvasRef} className="relative z-10 max-w-[1080px] mx-auto py-9 px-5 space-y-9">
      {/* Editorial Minimalist Header (Aligned with OverviewPage) */}
      <div className="text-center space-y-2">
        <div className="studio-head ts-eyebrow text-[#027a42]">
          EXPERIMENT STUDIO · BASELINE ↔ CLONE LAB
        </div>
        <h1 className="studio-head text-[25px] font-semibold tracking-[-0.02em] text-[#161616]">
          Tối ưu & Đối chiếu toàn luồng 3 tầng
        </h1>
        <p className="studio-head text-[13px] text-[#52525b] max-w-xl mx-auto leading-relaxed">
          Chọn khối <strong className="text-[#161616] font-medium">Baseline [A]</strong> để phân tích hoặc nhận đề xuất AI; nhân bản sang{' '}
          <strong className="text-[#161616] font-medium">[B]</strong> để tạo Dataset mới và đối chiếu trực tiếp cả 3 tầng.
        </p>
      </div>

      {otherRunningJob && (
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-3 rounded-[6px] border border-[#bbf7d0] bg-[#ecfdf5] px-4 py-2 text-xs text-[#027a42]">
          <span className="flex items-center gap-2 font-medium">
            <Loader2 className="size-3.5 animate-spin shrink-0" />
            Tiến trình &ldquo;{otherRunningJob.name}&rdquo; vẫn đang chạy ngầm ở Run #{otherRunningJob.source_run_id}.
          </span>
          <button
            type="button"
            onClick={() => {
              const src = runs.find((r) => r.id === otherRunningJob.source_run_id);
              if (src) onSelectRun(src);
            }}
            className="shrink-0 rounded bg-[#03aa5c] px-2.5 py-1 font-semibold text-white hover:bg-[#028a4b]"
          >
            Quay lại xem tiến độ
          </button>
        </div>
      )}

      {/* 2-Node Minimalist Animation Art Canvas */}
      <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_140px_1fr] items-start gap-6 lg:gap-0 pt-2">
        {/* ================= LEFT NODE [A]: BASELINE RUN ================= */}
        <div className="studio-node flex flex-col items-center">
          <button
            type="button"
            onClick={() => setMenuAOpen((v) => !v)}
            className={`group relative w-full max-w-[400px] min-h-[286px] flex flex-col justify-between text-left rounded-[6px] border border-t-2 border-t-[#161616] transition-all duration-150 p-5 bg-[#fefefe]/95 ${
              menuAOpen
                ? 'border-[#161616] shadow-md'
                : 'border-[#dedede] hover:border-[#161616] shadow-2xs hover:shadow-sm'
            }`}
          >
            <div>
              {/* Top Row */}
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-[2px] bg-[#161616] text-white">
                  GỐC · BASELINE [A]
                </span>
                <span className="font-mono text-[11px] text-[#71717a]">Run #{activeRun.id}</span>
              </div>

              {/* Title */}
              <div className="mt-4 flex items-center justify-between gap-2">
                <h2 className="text-[17px] font-semibold text-[#161616] truncate">{activeRun.name}</h2>
                <ChevronRight
                  className={`size-4 text-[#71717a] transition-transform duration-200 ${
                    menuAOpen ? 'rotate-90 text-[#161616]' : 'group-hover:translate-x-0.5'
                  }`}
                />
              </div>

              {/* Minimalist 3-Layer Metric Strip */}
              <div className="mt-5 grid grid-cols-3 divide-x divide-[#f0f0ee] pt-4 border-t border-[#f0f0ee]">
                <div className="pr-2">
                  <div className="font-mono text-[10px] text-[#71717a]">PARSING</div>
                  <div className="font-mono text-[17px] font-semibold text-[#161616] tabular-nums">
                    <AnimatedNumber value={(p.text_completeness || 0) * 100} suffix="%" />
                  </div>
                </div>
                <div className="px-3">
                  <div className="font-mono text-[10px] text-[#71717a]">CHUNKING</div>
                  <div className="font-mono text-[17px] font-semibold text-[#161616] tabular-nums">
                    <AnimatedNumber value={(c.chunk_integrity || 0) * 100} suffix="%" />
                  </div>
                </div>
                <div className="pl-3">
                  <div className="font-mono text-[10px] text-[#027a42]">RETRIEVAL</div>
                  <div className="font-mono text-[17px] font-semibold text-[#027a42] tabular-nums">
                    <AnimatedNumber value={(r.avg_contextual_precision || 0) * 100} suffix="%" />
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-[#f4f4f2] flex items-center justify-between text-[11px] font-mono text-[#71717a]">
              <span>{menuAOpen ? 'Đang mở tùy chọn bên dưới' : 'Nhấn để mở tùy chọn'}</span>
              <span>{r.total_testcases ?? 0} TC Golden</span>
            </div>
          </button>

          {/* Unified Hairline Action Tray under [A] */}
          {menuAOpen && (
            <div
              ref={menuARef}
              className="w-full max-w-[400px] mt-2.5 rounded-[6px] border border-[#dedede] bg-[#fefefe]/95 divide-y divide-[#f0f0ee] overflow-hidden shadow-2xs"
            >
              <button
                onClick={() => onOpenFullAnalysis(activeRun)}
                className="menu-a-item w-full px-4 py-3 hover:bg-[#fafaf9] transition-colors flex items-center justify-between text-left group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="size-7 rounded-[4px] bg-[#f4f4f2] flex items-center justify-center text-[#161616] shrink-0">
                    <FileSearch className="size-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-semibold text-[#161616]">Xem chi tiết phân tích</div>
                    <div className="text-[11px] text-[#71717a] truncate">Mở luồng 3 tầng (Dataset → Parse → Chunk → Retrieval)</div>
                  </div>
                </div>
                <ArrowRight className="size-3.5 text-[#a1a1aa] group-hover:text-[#161616] group-hover:translate-x-0.5 transition-all shrink-0" />
              </button>

              <button
                onClick={() => handleRunAiAdvisor(false)}
                className="menu-a-item w-full px-4 py-3 hover:bg-[#f2fbf6]/70 transition-colors flex items-center justify-between text-left group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="size-7 rounded-[4px] bg-[#03aa5c]/15 text-[#027a42] flex items-center justify-center shrink-0">
                    <Sparkles className="size-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-semibold text-[#027a42]">Đánh giá tối ưu & Đề xuất sửa Baseline</div>
                    <div className="text-[11px] text-[#52525b] truncate">
                      AI phân tích 3 tầng và gợi ý tham số cần chỉnh
                    </div>
                  </div>
                </div>
                <ArrowRight className="size-3.5 text-[#03aa5c] group-hover:translate-x-0.5 transition-all shrink-0" />
              </button>

              <button
                onClick={() => setShowBaselineConfig(true)}
                className="menu-a-item w-full px-4 py-3 hover:bg-[#fafaf9] transition-colors flex items-center justify-between text-left group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="size-7 rounded-[4px] bg-[#f4f4f2] flex items-center justify-center text-[#161616] shrink-0">
                    <Settings2 className="size-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-semibold text-[#161616]">Cấu hình Baseline</div>
                    <div className="text-[11px] text-[#71717a] truncate">Xem toàn bộ 6 phân mục cấu hình RAGFlow hiện tại</div>
                  </div>
                </div>
                <ArrowRight className="size-3.5 text-[#a1a1aa] group-hover:text-[#161616] group-hover:translate-x-0.5 transition-all shrink-0" />
              </button>
            </div>
          )}
        </div>

        {/* ================= CENTER CONNECTOR ART (SVG + PULSE) ================= */}
        <div className="hidden lg:flex flex-col items-center justify-center pt-[120px] relative">
          <svg viewBox="0 0 140 44" className="w-[140px] h-[44px] overflow-visible">
            <path
              ref={connectorPathRef}
              d="M 4 22 L 134 22"
              fill="none"
              stroke={clonedDraft ? '#03aa5c' : '#d4d4d8'}
              strokeWidth={clonedDraft ? 1.5 : 1.2}
              strokeDasharray={clonedDraft ? 'none' : '3 3'}
            />
            {!anyOverlayOpen && (
              <circle cy="22" r="2.6" fill={clonedDraft ? '#03aa5c' : '#a1a1aa'}>
                <animate
                  attributeName="cx"
                  values="6;132"
                  dur={activeJob?.status === 'running' ? '1.1s' : '2.6s'}
                  repeatCount="indefinite"
                />
              </circle>
            )}
            <path
              d="M128 18 L134 22 L128 26"
              fill="none"
              stroke={clonedDraft ? '#03aa5c' : '#a1a1aa'}
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>

          {/* Compact Delta Bridge when [B] completed */}
          {comparePreview && (
            <div className="mt-1 px-2.5 py-1.5 rounded-[6px] bg-white border border-[#dedede] shadow-sm text-center space-y-0.5">
              <div className="font-mono text-[9px] uppercase text-[#71717a]">RET. DELTA</div>
              <div
                className={`font-mono text-[12px] font-bold ${
                  comparePreview.deltas.retrieval_precision >= 0 ? 'text-[#027a42]' : 'text-[#dc2626]'
                }`}
              >
                {comparePreview.deltas.retrieval_precision >= 0 ? '+' : ''}
                {(comparePreview.deltas.retrieval_precision * 100).toFixed(1)}%
              </div>
            </div>
          )}
        </div>

        {/* ================= RIGHT NODE [B]: CLONE / EXPERIMENT ================= */}
        <div className="studio-node relative flex flex-col items-center">
          <div ref={nodeBRef} className="w-full max-w-[400px]">
            {!clonedDraft ? (
              /* State 1: Empty "+" Clone Trigger Card */
              <button
                type="button"
                onClick={() => triggerCloneAnimation(false, null)}
                className="group w-full min-h-[286px] rounded-[6px] border border-dashed border-[#cbd5e1] hover:border-[#03aa5c] bg-[#fefefe]/90 hover:bg-[#f2fbf6]/80 transition-colors p-6 flex flex-col items-center justify-center text-center gap-3"
              >
                <div className="size-10 rounded-[6px] border border-[#dedede] group-hover:border-[#03aa5c] group-hover:bg-[#03aa5c] group-hover:text-white bg-white text-[#161616] flex items-center justify-center transition-colors">
                  <Plus className="size-4" />
                </div>
                <div>
                  <div className="text-[14px] font-semibold text-[#161616]">Tạo nhánh so sánh [B]</div>
                  <div className="text-[12px] text-[#71717a] mt-1 max-w-[260px]">
                    Nhân bản từ Baseline để tạo Dataset mới và tự động chạy đối chiếu 3 tầng.
                  </div>
                </div>
              </button>
            ) : !activeJob ? (
              /* State 2: Cloned Draft */
              <div className="min-h-[286px] flex flex-col justify-between rounded-[6px] border border-[#03aa5c]/60 border-t-2 border-t-[#03aa5c] bg-[#fefefe]/95 p-5 shadow-sm">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-[2px] bg-[#03aa5c] text-white">
                      NHÁNH SO SÁNH [B] · NHÁP
                    </span>
                    <button
                      onClick={() => {
                        setClonedDraft(false);
                        setAiPatchForWorkbench(null);
                      }}
                      className="text-[#a1a1aa] hover:text-[#161616]"
                      title="Hủy bản nháp"
                    >
                      <X className="size-4" />
                    </button>
                  </div>

                  <div>
                    <h3 className="text-[16px] font-semibold text-[#161616]">Sẵn sàng cấu hình Dataset mới</h3>
                    <p className="text-[12px] text-[#52525b] mt-1.5 leading-relaxed">
                      Mở bảng thiết lập 6 phân mục Parse, Chunking & Retrieval của RAGFlow.
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => setShowWorkbench(true)}
                  className="w-full py-2.5 px-4 rounded-[4px] bg-[#161616] hover:bg-black text-white text-[12.5px] font-semibold flex items-center justify-center gap-2 transition-colors"
                >
                  <SlidersHorizontal className="size-3.5" />
                  Mở bảng thiết lập cấu hình [B]
                </button>
              </div>
            ) : activeJob.status === 'queued' || activeJob.status === 'running' ? (
              /* State 3: Live Executing Pipeline */
              <div className="min-h-[286px] rounded-[6px] border border-[#03aa5c]/60 border-t-2 border-t-[#03aa5c] bg-[#fefefe]/95 p-5 shadow-sm space-y-3.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin text-[#03aa5c]" />
                    <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#027a42]">
                      ĐANG CHẠY · {overallPct}%
                    </span>
                  </div>
                  <button
                    onClick={handleCancelJob}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono text-[#dc2626] hover:bg-[#fef2f2] rounded border border-[#fecaca]"
                  >
                    <Square className="size-3 fill-current" /> Hủy
                  </button>
                </div>

                <div>
                  <div className="text-[15px] font-semibold text-[#161616] truncate">{activeJob.name}</div>
                  <div className="w-full h-1.5 bg-[#f1f1ef] rounded-full overflow-hidden mt-2">
                    <div
                      className="h-full bg-[#03aa5c] transition-all duration-500"
                      style={{ width: `${Math.max(4, overallPct)}%` }}
                    />
                  </div>
                </div>

                <div className="space-y-1.5 pt-1">
                  {stagesOrder.map((sk) => {
                    const st = activeJob.stage_progress?.[sk];
                    if (!st) return null;
                    return (
                      <div key={sk} className="flex items-start justify-between gap-2 text-[11px]">
                        <div className="flex items-start gap-2 min-w-0">
                          {st.status === 'done' ? (
                            <CheckCircle2 className="size-3.5 text-[#03aa5c] shrink-0 mt-0.5" />
                          ) : st.status === 'running' ? (
                            <Loader2 className="size-3.5 animate-spin text-[#03aa5c] shrink-0 mt-0.5" />
                          ) : st.status === 'failed' ? (
                            <AlertCircle className="size-3.5 text-[#dc2626] shrink-0 mt-0.5" />
                          ) : (
                            <span className="size-3.5 rounded-full border border-[#d4d4d8] shrink-0 mt-0.5 inline-block" />
                          )}
                          <div className="min-w-0">
                            <div
                              className={`font-medium truncate ${
                                st.status === 'running'
                                  ? 'text-[#161616]'
                                  : st.status === 'done'
                                  ? 'text-[#3f3f46]'
                                  : 'text-[#a1a1aa]'
                              }`}
                            >
                              {st.label}
                            </div>
                            {st.detail && (
                              <div className="text-[10px] text-[#71717a] truncate">{st.detail}</div>
                            )}
                          </div>
                        </div>
                        <span className="font-mono text-[10px] text-[#71717a] shrink-0">
                          {st.duration_ms ? fmtSec(st.duration_ms) : st.status === 'running' ? `${st.progress}%` : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : activeJob.status === 'completed' ? (
              /* State 4: Completed [B] */
              <div className="min-h-[286px] flex flex-col justify-between rounded-[6px] border border-[#03aa5c]/60 border-t-2 border-t-[#03aa5c] bg-[#fefefe]/95 p-5 shadow-sm space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-[3px] bg-[#03aa5c] text-white">
                    HOÀN TẤT · [B]
                  </span>
                  <span className="font-mono text-[11px] text-[#71717a] inline-flex items-center gap-1">
                    <Clock className="size-3" /> {fmtSec(activeJob.total_duration_ms)}
                  </span>
                </div>

                <h3 className="text-[17px] font-semibold text-[#161616] truncate">{activeJob.name}</h3>

                {comparePreview && (
                  <div className="grid grid-cols-3 gap-2 pt-3 border-t border-[#f0f0ee]">
                    <div>
                      <div className="font-mono text-[10px] text-[#71717a]">PARSING</div>
                      <div className="font-mono text-[16px] font-semibold text-[#161616]">
                        {Math.round((comparePreview.candidate.parsing.text_completeness || 0) * 100)}%
                      </div>
                    </div>
                    <div>
                      <div className="font-mono text-[10px] text-[#71717a]">CHUNKING</div>
                      <div className="font-mono text-[16px] font-semibold text-[#161616]">
                        {Math.round((comparePreview.candidate.chunking.chunk_integrity || 0) * 100)}%
                      </div>
                    </div>
                    <div>
                      <div className="font-mono text-[10px] text-[#027a42]">RETRIEVAL</div>
                      <div className="font-mono text-[16px] font-semibold text-[#027a42]">
                        {Math.round((comparePreview.candidate.retrieval.avg_contextual_precision || 0) * 100)}%
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={() => setShowCompareModal(true)}
                    className="col-span-2 py-2.5 px-3 rounded-[6px] bg-[#03aa5c] hover:bg-[#028a4b] text-white text-[12px] font-semibold flex items-center justify-center gap-1.5"
                  >
                    <GitCompare className="size-3.5" /> So sánh toàn luồng A ↔ B
                  </button>
                  <button
                    onClick={() => {
                      const target = runs.find((x) => x.id === activeJob.target_run_id);
                      if (target) onOpenFullAnalysis(target);
                    }}
                    className="py-2 px-3 rounded-[6px] border border-[#dedede] hover:border-[#161616] text-[12px] font-medium text-[#161616]"
                  >
                    Mở chi tiết [B]
                  </button>
                  <button
                    onClick={() => triggerCloneAnimation(true, null)}
                    className="py-2 px-3 rounded-[6px] border border-[#dedede] hover:border-[#03aa5c] text-[12px] font-medium text-[#027a42]"
                  >
                    + Nhánh mới
                  </button>
                </div>
              </div>
            ) : (
              /* State 5: Failed or Cancelled */
              <div className="rounded-[12px] border border-[#fecaca] bg-[#fef2f2]/40 p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] font-bold uppercase text-[#dc2626]">
                    {activeJob.status === 'cancelled' ? 'ĐÃ HỦY' : 'LỖI THỰC THI'}
                  </span>
                  <button
                    onClick={() => triggerCloneAnimation(true, null)}
                    className="text-[11px] font-mono text-[#161616] underline"
                  >
                    Thử lại
                  </button>
                </div>
                <div className="text-[14px] font-semibold text-[#161616]">{activeJob.name}</div>
                <div className="text-[12px] text-[#b91c1c] break-words">{activeJob.error_message}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ================= AI ADVISOR SLIDE-OVER DRAWER ================= */}
      {showAdvisor && (
        <div className="fixed inset-0 z-50 bg-black/45 flex justify-end">
          <div className="w-full max-w-[540px] h-full bg-[#fefefe] border-l border-[#dedede] shadow-2xl flex flex-col">
            <div className="px-6 py-4 border-b border-[#e5e5e5] flex items-center justify-between bg-[#fafaf9]">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-[#03aa5c]" />
                <h3 className="text-[15px] font-semibold text-[#161616]">AI Đề xuất tối ưu Baseline</h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleRunAiAdvisor(true)}
                  disabled={advisorLoading}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono border border-[#dedede] rounded bg-white hover:border-[#161616] disabled:opacity-50"
                >
                  <RefreshCw className={`size-3 ${advisorLoading ? 'animate-spin' : ''}`} /> Phân tích lại
                </button>
                <button onClick={() => setShowAdvisor(false)} className="p-1 text-[#71717a] hover:text-[#161616]">
                  <X className="size-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {advisorLoading ? (
                <div className="py-20 flex flex-col items-center gap-3 text-center">
                  <Loader2 className="size-6 animate-spin text-[#03aa5c]" />
                  <div className="text-[13px] font-medium text-[#161616]">
                    AI đang tổng hợp dữ liệu Parsing, Chunking & Retrieval...
                  </div>
                  <div className="text-[11px] text-[#71717a]">Thường mất 5–12 giây cho 1 lần gọi LLM.</div>
                </div>
              ) : advisorData?.report ? (
                <>
                  <div className="p-4 rounded-[6px] border border-[#bbf7d0] bg-[#ecfdf5]/50 space-y-1.5">
                    <div className="flex items-center justify-between font-mono text-[10px] uppercase">
                      <span className="font-bold text-[#027a42]">
                        ĐIỂM NGHẼN CHÍNH: {advisorData.report.bottleneck_layer}
                      </span>
                      {advisorData.report.expected_gain && (
                        <span className="text-[#027a42]">{advisorData.report.expected_gain}</span>
                      )}
                    </div>
                    <p className="text-[13px] text-[#161616] leading-relaxed">{advisorData.report.diagnosis}</p>
                  </div>

                  <div className="space-y-3">
                    <div className="font-mono text-[10px] uppercase tracking-wider text-[#71717a]">
                      ĐỀ XUẤT THAY ĐỔI CẤU HÌNH ({advisorData.report.proposed_changes?.length || 0})
                    </div>
                    {(advisorData.report.proposed_changes || []).map((ch, idx) => (
                      <div key={idx} className="p-3.5 rounded-[6px] border border-[#e5e5e5] bg-white space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#f4f4f2] text-[#161616]">
                            {ch.layer}
                          </span>
                          <span
                            className={`font-mono text-[10px] uppercase font-semibold ${
                              ch.priority === 'high' ? 'text-[#dc2626]' : 'text-[#b45309]'
                            }`}
                          >
                            Ưu tiên {ch.priority}
                          </span>
                        </div>
                        <div className="text-[13px] font-semibold text-[#161616]">{ch.param_label}</div>
                        <div className="font-mono text-[12px] flex items-center gap-2">
                          <span className="text-[#71717a] line-through">{ch.current_value}</span>
                          <ArrowRight className="size-3 text-[#03aa5c]" />
                          <span className="font-semibold text-[#027a42]">{ch.recommended_value}</span>
                        </div>
                        <p className="text-[12px] text-[#52525b] leading-relaxed">{ch.reason}</p>
                        {ch.affected_tcs && ch.affected_tcs.length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-1">
                            {ch.affected_tcs.map((tc) => (
                              <span
                                key={tc}
                                className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#fef3c7] text-[#92400e]"
                              >
                                {tc}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="py-16 text-center text-[13px] text-[#71717a]">
                  Chưa có báo cáo phân tích. Nhấn &ldquo;Phân tích lại&rdquo; để AI đánh giá Baseline này.
                </div>
              )}
            </div>

            {advisorData?.report && (
              <div className="px-6 py-4 border-t border-[#e5e5e5] bg-[#fafaf9]">
                <button
                  onClick={() => {
                    setShowAdvisor(false);
                    triggerCloneAnimation(true, advisorData.report.patch_config || {});
                  }}
                  className="w-full py-2.5 px-4 rounded-[6px] bg-[#03aa5c] hover:bg-[#028a4b] text-white text-[13px] font-semibold flex items-center justify-center gap-2"
                >
                  <Sparkles className="size-4" /> Áp dụng đề xuất → Thiết lập nhánh [B]
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Baseline Config Full-Screen 90% Workbench (Read-only Inspect) */}
      {showBaselineConfig && (
        <CloneConfigWorkbench
          mode="baseline"
          baselineRun={activeRun}
          onClose={() => setShowBaselineConfig(false)}
          onCloneFromBaseline={() => triggerCloneAnimation(true, null)}
        />
      )}

      {/* Clone [B] Full-Screen 90% Workbench (Editable + Amber Diffs) */}
      {showWorkbench && (
        <CloneConfigWorkbench
          mode="clone"
          baselineRun={activeRun}
          aiPatch={aiPatchForWorkbench}
          onClose={() => setShowWorkbench(false)}
          onStarted={(job) => {
            setShowWorkbench(false);
            setActiveJob(job);
          }}
        />
      )}

      {/* 3-Layer Run Comparison Modal */}
      {showCompareModal && activeJob?.target_run_id && (
        <RunThreeLayerCompareModal
          baselineRunId={activeRun.id}
          candidateRunId={activeJob.target_run_id}
          onClose={() => setShowCompareModal(false)}
          onPromoted={async (newBaselineId) => {
            setShowCompareModal(false);
            await onRefreshRuns();
            const freshRuns = await api.listRuns().catch(() => runs);
            const found = freshRuns.find((x: RunItem) => x.id === newBaselineId);
            if (found) onSelectRun(found);
          }}
        />
      )}
      </div>
    </div>
  );
};
