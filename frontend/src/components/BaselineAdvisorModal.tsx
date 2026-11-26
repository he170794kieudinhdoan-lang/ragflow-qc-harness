import React, { useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { toast } from 'sonner';
import { ArrowRight, Check, ChevronDown, ChevronUp, RefreshCw, X } from 'lucide-react';
import { api } from '../api/client';
import { TrackedOperationOptions } from './FloatingProgressOverlay';
import { RunItem } from '../types';

export interface BaselineAdvisorReport {
  ok: boolean;
  run_id: number;
  engine_used: 'llm' | 'rule';
  model_used?: string;
  elapsed_sec: number;
  updated_at?: string;
  demo?: boolean;
  from_cache?: boolean;
  executive_summary: string;
  summary: {
    total_docs: number;
    total_mb: number;
    total_pages_or_units?: number;
    scan_doc_count: number;
    scan_doc_codes?: string[];
    total_tables: number;
    docs_with_tables?: number;
    total_images: number;
    p50_section_tokens: number;
    p75_section_tokens: number;
    approx_words_per_section?: number;
    max_table_tokens: number;
    largest_table_doc?: string;
    format_count: number;
  };
  format_breakdown: { ext: string; count: number; ratio: number }[];
  current_config: {
    chunk_method: string;
    layout_recognize: string;
    chunk_token_num: number;
    overlapped_percent?: number;
    table_context_size?: number;
  };
  recommended: {
    chunk_method: string;
    layout_recognize: string;
    chunk_token_num: number;
    overlapped_percent?: number;
    table_context_size?: number;
  };
  param_reasons: Record<string, string>;
  split_warnings: {
    group: string;
    doc_codes: string[];
    suggested_method: string;
    reason: string;
  }[];
  files: {
    document_id: number;
    doc_code: string;
    filename: string;
    ext: string;
    size_kb: number;
    pages_or_units: number;
    is_scan: boolean;
    table_count: number;
    image_count: number;
    p75_section_tokens: number;
    max_table_tokens: number;
    has_law_structure: boolean;
  }[];
}

interface Props {
  activeRun: RunItem;
  docCount: number;
  onClose: () => void;
  onApplied: () => Promise<void> | void;
  runTracked: <T>(opts: TrackedOperationOptions, fn: () => Promise<T>) => Promise<T>;
}

const METHOD_LABELS: Record<string, string> = {
  general: 'General',
  naive: 'General',
  laws: 'Laws',
  paper: 'Paper',
  table: 'Table',
  qa: 'Q&A',
  presentation: 'Presentation',
};

const LAYOUT_LABELS: Record<string, string> = {
  DeepDOC: 'DeepDOC',
  'Plain Text': 'Plain Text',
};

const UNIT_LABEL_BY_EXT: Record<string, string> = {
  PDF: 'trang',
  PPTX: 'slide',
  PPT: 'slide',
  XLSX: 'sheet',
  XLSM: 'sheet',
  CSV: 'bảng',
  DOCX: 'mục',
  HTML: 'mục',
  HTM: 'mục',
  MD: 'mục',
};

// Quiet monochrome ink scale (no jarring multi-color bars)
const FORMAT_TONES = ['#18181b', '#52525b', '#71717a', '#a1a1aa', '#d4d4d8', '#e4e4e7'];

const fmtInt = (n: number) => Math.round(n).toLocaleString('vi-VN');

const fmtMb = (mb: number) =>
  mb >= 10
    ? mb.toLocaleString('vi-VN', { maximumFractionDigits: 1 })
    : mb.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

const formatChunkSize = (tokens: number) => {
  const words = Math.round(tokens * 0.75);
  return `${fmtInt(tokens)} token (~${fmtInt(words)} từ)`;
};

const formatOverlap = (pct: number) => `${pct}%`;

const formatTableCtx = (tokens: number) => `${fmtInt(tokens)}`;

const describeSectionDensity = (approxWords: number) => {
  if (approxWords <= 0) return { label: 'Ít chữ số', sub: 'Chủ yếu ảnh hoặc bảng' };
  if (approxWords <= 80) return { label: 'Ngắn gọn', sub: `~${fmtInt(approxWords)} từ / mục` };
  if (approxWords <= 220) return { label: 'Vừa phải', sub: `~${fmtInt(approxWords)} từ / mục` };
  return { label: 'Dài, nhiều ý', sub: `~${fmtInt(approxWords)} từ / mục` };
};

const TweenInt: React.FC<{ value: number; className?: string }> = ({ value, className }) => {
  const [shown, setShown] = useState(0);
  const objRef = useRef({ v: 0 });
  useEffect(() => {
    const t = gsap.to(objRef.current, {
      v: value,
      duration: 0.45,
      ease: 'power3.out',
      onUpdate: () => setShown(Math.round(objRef.current.v)),
    });
    return () => {
      t.kill();
    };
  }, [value]);
  return <span className={className}>{fmtInt(shown)}</span>;
};

export const BaselineAdvisorModal: React.FC<Props> = ({
  activeRun,
  docCount,
  onClose,
  onApplied,
  runTracked,
}) => {
  const [useLlm, setUseLlm] = useState(true);
  const [report, setReport] = useState<BaselineAdvisorReport | null>(null);
  const [loadingInit, setLoadingInit] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [showSplits, setShowSplits] = useState(true);
  const [confirmApplyOpen, setConfirmApplyOpen] = useState(false);
  const [fileFilter, setFileFilter] = useState<'all' | 'notable' | 'tables'>('all');
  const [hoveredExt, setHoveredExt] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !scanning && !applying) {
        if (confirmApplyOpen) {
          setConfirmApplyOpen(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, scanning, applying, confirmApplyOpen]);

  useEffect(() => {
    if (!confirmApplyOpen || !confirmRef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const ctx = gsap.context(() => {
      gsap.fromTo(
        confirmRef.current,
        { opacity: 0, y: 6, scale: 0.97 },
        { opacity: 1, y: 0, scale: 1, duration: 0.18, ease: 'power2.out' }
      );
    });
    return () => ctx.revert();
  }, [confirmApplyOpen]);

  useEffect(() => {
    if (!modalRef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        modalRef.current,
        { opacity: 0, y: 10, scale: 0.99 },
        { opacity: 1, y: 0, scale: 1, duration: 0.24, ease: 'power3.out' }
      );
    });
    return () => ctx.revert();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadingInit(true);
    api
      .getBaselineAdvisor(activeRun.id)
      .then(async (res) => {
        if (cancelled) return;
        if (res?.found && res.report) {
          setReport(res.report);
          setLoadingInit(false);
        } else {
          setLoadingInit(false);
          await triggerScan(true, true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadingInit(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun.id]);

  useEffect(() => {
    if (!report || !bodyRef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        '.ba-reveal',
        { opacity: 0, y: 6 },
        { opacity: 1, y: 0, duration: 0.26, stagger: 0.035, ease: 'power2.out' }
      );
      gsap.fromTo(
        '.ba-bar-seg',
        { scaleX: 0, transformOrigin: 'left center' },
        { scaleX: 1, duration: 0.42, stagger: 0.03, ease: 'power3.out', delay: 0.05 }
      );
    }, bodyRef);
    return () => ctx.revert();
  }, [report]);

  const triggerScan = async (llmFlag = useLlm, force = true) => {
    if (scanning) return;
    setScanning(true);
    try {
      const res: BaselineAdvisorReport = await runTracked(
        {
          title: `Khám cấu trúc ${docCount} tài liệu`,
          subtitle: llmFlag ? 'Quét cấu trúc file & tổng hợp tư vấn' : 'Quét cấu trúc file nhanh',
          estimatedMs: llmFlag ? 8000 : 3800,
        },
        () => api.runBaselineAdvisor(activeRun.id, llmFlag, force)
      );
      setReport(res);
    } catch (e: any) {
      toast.error(e?.message || 'Không thể phân tích tài liệu.');
    } finally {
      setScanning(false);
    }
  };

  const handleApply = async () => {
    if (!report || applying) return;
    setApplying(true);
    try {
      const rec = report.recommended;
      const res = await api.applyBaselineAdvisor(activeRun.id, {
        chunk_method: rec.chunk_method === 'naive' ? 'general' : rec.chunk_method,
        layout_recognize: rec.layout_recognize,
        chunk_token_num: Number(rec.chunk_token_num) || 512,
        overlapped_percent: Number(rec.overlapped_percent ?? 0),
        table_context_size: Number(rec.table_context_size ?? 0),
      });
      await onApplied();
      const summaryLines = (changedRows.length > 0 ? changedRows : diffRows)
        .map((r) => `${r.title}: ${r.next}`)
        .join(' · ');
      if (res?.remote_synced) {
        toast.success('Đã đồng bộ cấu hình lên RAGFlow', { description: summaryLines });
      } else if (res?.remote_warning) {
        toast.warning(`Đã lưu cấu hình local (RAGFlow báo: ${res.remote_warning})`, {
          description: summaryLines,
        });
      } else {
        toast.success('Đã áp dụng cấu hình Baseline', { description: summaryLines });
      }
      setConfirmApplyOpen(false);
      onClose();
    } catch (e: any) {
      toast.error(e?.message || 'Không áp dụng được cấu hình.');
    } finally {
      setApplying(false);
    }
  };

  const filenameByCode = useMemo(() => {
    const map: Record<string, string> = {};
    if (report) {
      for (const f of report.files) map[f.doc_code] = f.filename;
    }
    return map;
  }, [report]);

  const diffRows = useMemo(() => {
    if (!report) return [];
    const normMethod = (m: string) => (m === 'naive' ? 'general' : m);
    const currMethod = normMethod(report.current_config.chunk_method || 'general');
    const nextMethod = normMethod(report.recommended.chunk_method || 'general');
    const currOverlap = Number(report.current_config.overlapped_percent ?? 0);
    const nextOverlap = Number(report.recommended.overlapped_percent ?? 0);
    const currTblCtx = Number(report.current_config.table_context_size ?? 0);
    const nextTblCtx = Number(report.recommended.table_context_size ?? 0);

    return [
      {
        key: 'chunk_method',
        title: 'Chunk method',
        techKey: 'parser_id',
        curr: METHOD_LABELS[currMethod] || currMethod,
        next: METHOD_LABELS[nextMethod] || nextMethod,
        changed: currMethod !== nextMethod,
        reason: report.param_reasons.chunk_method,
      },
      {
        key: 'layout_recognize',
        title: 'Parser (PDF & Spreadsheet)',
        techKey: 'Parser → parse_method',
        curr: LAYOUT_LABELS[report.current_config.layout_recognize] || report.current_config.layout_recognize,
        next: LAYOUT_LABELS[report.recommended.layout_recognize] || report.recommended.layout_recognize,
        changed: report.current_config.layout_recognize !== report.recommended.layout_recognize,
        reason: report.param_reasons.layout_recognize,
      },
      {
        key: 'chunk_token_num',
        title: 'Recommended chunk size',
        techKey: 'General Chunker → chunk_token_size',
        curr: formatChunkSize(Number(report.current_config.chunk_token_num)),
        next: formatChunkSize(Number(report.recommended.chunk_token_num)),
        changed: Number(report.current_config.chunk_token_num) !== Number(report.recommended.chunk_token_num),
        reason: report.param_reasons.chunk_token_num,
      },
      {
        key: 'overlapped_percent',
        title: 'Overlapped percent (%)',
        techKey: 'General Chunker → overlapped_percent',
        curr: formatOverlap(currOverlap),
        next: formatOverlap(nextOverlap),
        changed: currOverlap !== nextOverlap,
        reason: report.param_reasons.overlapped_percent,
      },
      {
        key: 'table_context_size',
        title: 'Table context window',
        techKey: 'General Chunker → table_context_size',
        curr: formatTableCtx(currTblCtx),
        next: formatTableCtx(nextTblCtx),
        changed: currTblCtx !== nextTblCtx,
        reason: report.param_reasons.table_context_size,
      },
    ];
  }, [report]);

  const changedRows = useMemo(() => diffRows.filter((r) => r.changed), [diffRows]);
  const unchangedRows = useMemo(() => diffRows.filter((r) => !r.changed), [diffRows]);

  const filteredFiles = useMemo(() => {
    if (!report) return [];
    if (fileFilter === 'notable') {
      return report.files.filter((f) => f.is_scan || f.has_law_structure || f.max_table_tokens >= 800);
    }
    if (fileFilter === 'tables') {
      return report.files.filter((f) => f.table_count > 0);
    }
    return report.files;
  }, [report, fileFilter]);

  const docsWithTablesCount = useMemo(() => {
    if (!report) return 0;
    if (typeof report.summary.docs_with_tables === 'number') return report.summary.docs_with_tables;
    return report.files.filter((f) => f.table_count > 0).length;
  }, [report]);

  const approxWords = useMemo(() => {
    if (!report) return 0;
    if (typeof report.summary.approx_words_per_section === 'number') {
      return report.summary.approx_words_per_section;
    }
    return Math.round((report.summary.p75_section_tokens || 0) * 0.75);
  }, [report]);

  const densityInfo = describeSectionDensity(approxWords);

  return (
    <div className="fixed inset-0 z-50 bg-[#141414]/30 backdrop-blur-[1.5px] flex items-center justify-center p-4">
      <div
        ref={modalRef}
        className="w-full max-w-[680px] max-h-[86vh] rounded-lg bg-white border border-[#e4e4e2] shadow-[0_24px_60px_-18px_rgba(20,20,20,0.22)] flex flex-col overflow-hidden"
      >
        {/* Clean Minimal Header */}
        <header className="px-5 py-3.5 border-b border-[#ecece9] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-[#141414] truncate">
              Gợi ý cấu hình Baseline
            </h2>
            <span className="text-[11.5px] text-[#8a8a8e] truncate">
              {activeRun.name}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <div className="inline-flex p-0.5 rounded bg-[#f4f4f2] text-[11px]">
              <button
                type="button"
                onClick={() => setUseLlm(true)}
                className={`px-2 py-0.5 rounded-[3px] transition-colors ${
                  useLlm ? 'bg-white text-[#141414] font-medium shadow-[0_1px_1px_rgba(0,0,0,0.06)]' : 'text-[#71717a] hover:text-[#141414]'
                }`}
              >
                AI
              </button>
              <button
                type="button"
                onClick={() => setUseLlm(false)}
                className={`px-2 py-0.5 rounded-[3px] transition-colors ${
                  !useLlm ? 'bg-white text-[#141414] font-medium shadow-[0_1px_1px_rgba(0,0,0,0.06)]' : 'text-[#71717a] hover:text-[#141414]'
                }`}
              >
                Nhanh
              </button>
            </div>
            <button
              type="button"
              onClick={() => triggerScan(useLlm, true)}
              disabled={scanning || applying}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11.5px] text-[#52525b] hover:text-[#141414] hover:bg-[#f4f4f2] disabled:opacity-40 transition-colors"
              title="Quét lại toàn bộ tài liệu gốc"
            >
              <RefreshCw className={`size-3 ${scanning ? 'animate-spin' : ''}`} />
              Quét lại
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={scanning || applying}
              className="p-1 text-[#8a8a8e] hover:text-[#141414] rounded transition-colors"
              aria-label="Đóng"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        {/* Body */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto">
          {loadingInit || !report ? (
            <div className="py-16 px-5 text-center text-[12.5px] text-[#71717a]">
              {scanning ? 'Đang đọc cấu trúc bộ tài liệu...' : 'Nhấn "Quét lại" để bắt đầu phân tích.'}
            </div>
          ) : (
            <div className="divide-y divide-[#f0f0ed]">
              {/* 1. Summary + Corpus Numbers */}
              <section className="ba-reveal px-5 py-4 space-y-4">
                <p className="text-[13px] leading-[1.6] text-[#27272a]">
                  {report.executive_summary}
                </p>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                  <div>
                    <div className="text-[11px] text-[#8a8a8e]">Tài liệu</div>
                    <div className="mt-0.5 flex items-baseline gap-1">
                      <TweenInt value={report.summary.total_docs} className="font-mono text-[17px] font-semibold text-[#141414] tabular-nums" />
                      <span className="text-[11.5px] text-[#71717a]">tệp</span>
                    </div>
                    <div className="text-[11px] text-[#8a8a8e] tabular-nums">
                      {fmtMb(report.summary.total_mb)} MB · {report.summary.format_count} loại
                    </div>
                  </div>

                  <div className="sm:pl-3 sm:border-l sm:border-[#f0f0ed]">
                    <div className="text-[11px] text-[#8a8a8e]">Ảnh scan</div>
                    <div className="mt-0.5 flex items-baseline gap-1">
                      <TweenInt value={report.summary.scan_doc_count} className="font-mono text-[17px] font-semibold text-[#141414] tabular-nums" />
                      <span className="text-[11.5px] text-[#71717a]">/ {report.summary.total_docs}</span>
                    </div>
                    <div className="text-[11px] text-[#8a8a8e]">
                      {report.summary.scan_doc_count > 0 ? 'Cần OCR đọc ảnh' : 'Toàn bộ chữ gốc'}
                    </div>
                  </div>

                  <div className="sm:pl-3 sm:border-l sm:border-[#f0f0ed]">
                    <div className="text-[11px] text-[#8a8a8e]">Bảng biểu</div>
                    <div className="mt-0.5 flex items-baseline gap-1">
                      <TweenInt value={report.summary.total_tables} className="font-mono text-[17px] font-semibold text-[#141414] tabular-nums" />
                      <span className="text-[11.5px] text-[#71717a]">bảng</span>
                    </div>
                    <div className="text-[11px] text-[#8a8a8e]">
                      {report.summary.total_tables > 0 ? `Trong ${docsWithTablesCount} tệp` : 'Không có bảng'}
                    </div>
                  </div>

                  <div className="sm:pl-3 sm:border-l sm:border-[#f0f0ed]">
                    <div className="text-[11px] text-[#8a8a8e]">Độ dài mục</div>
                    <div className="mt-0.5 text-[15px] font-semibold text-[#141414] leading-[1.45]">
                      {densityInfo.label}
                    </div>
                    <div className="text-[11px] text-[#8a8a8e]">{densityInfo.sub}</div>
                  </div>
                </div>

                {/* Quiet Monochrome SVG Distribution Bar */}
                {report.format_breakdown.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <svg viewBox="0 0 100 1.8" preserveAspectRatio="none" className="w-full h-1.5 block overflow-visible">
                      {(() => {
                        const gap = 0.5;
                        const totalGap = gap * Math.max(0, report.format_breakdown.length - 1);
                        const usable = Math.max(20, 100 - totalGap);
                        let offset = 0;
                        return report.format_breakdown.map((seg, i) => {
                          const w = Math.max(1.5, seg.ratio * usable);
                          const x = offset;
                          offset += w + gap;
                          const dimmed = hoveredExt !== null && hoveredExt !== seg.ext;
                          return (
                            <rect
                              key={seg.ext}
                              className="ba-bar-seg transition-opacity duration-150 cursor-pointer"
                              x={x}
                              y={0}
                              width={w}
                              height={1.8}
                              rx={0.6}
                              fill={FORMAT_TONES[i % FORMAT_TONES.length]}
                              opacity={dimmed ? 0.25 : 1}
                              onMouseEnter={() => setHoveredExt(seg.ext)}
                              onMouseLeave={() => setHoveredExt(null)}
                            />
                          );
                        });
                      })()}
                    </svg>
                    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-[#71717a]">
                      {report.format_breakdown.map((seg, i) => {
                        const pct = Math.round(seg.ratio * 100);
                        const active = hoveredExt === seg.ext;
                        return (
                          <span
                            key={seg.ext}
                            onMouseEnter={() => setHoveredExt(seg.ext)}
                            onMouseLeave={() => setHoveredExt(null)}
                            className={`inline-flex items-center gap-1.5 cursor-default transition-opacity ${
                              hoveredExt && !active ? 'opacity-35' : 'opacity-100'
                            }`}
                          >
                            <span
                              className="size-1.5 rounded-full inline-block shrink-0"
                              style={{ backgroundColor: FORMAT_TONES[i % FORMAT_TONES.length] }}
                            />
                            <span className="font-medium text-[#27272a]">{seg.ext}</span>
                            <span className="tabular-nums">
                              {seg.count} ({pct}%)
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>

              {/* 2. Configuration Proposal */}
              <section className="ba-reveal px-5 py-4 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[#8a8a8e]">
                    Đề xuất cài đặt ·{' '}
                    <span className="text-[#141414]">
                      {changedRows.length > 0 ? `${changedRows.length} mục nên đổi` : 'Đã phù hợp'}
                    </span>
                  </span>
                  {changedRows.length > 0 && unchangedRows.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowUnchanged((v) => !v)}
                      className="text-[11.5px] text-[#71717a] hover:text-[#141414] inline-flex items-center gap-0.5 transition-colors"
                    >
                      {showUnchanged ? 'Ẩn mục giữ nguyên' : `+${unchangedRows.length} mục giữ nguyên`}
                      {showUnchanged ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                    </button>
                  )}
                </div>

                <div className="divide-y divide-[#f2f2ef]">
                  {changedRows.map((row) => (
                    <div key={row.key} className="py-2.5 first:pt-1 last:pb-0.5 space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span
                          className="inline-flex items-center gap-2 text-[12.5px] font-medium text-[#141414]"
                          title={`Tham số: ${row.techKey}`}
                        >
                          <span className="size-1.5 rounded-full bg-[#03aa5c] shrink-0" />
                          {row.title}
                        </span>
                        <div className="flex items-center gap-1.5 text-[12px] tabular-nums">
                          <span className="text-[#a1a1aa] line-through">{row.curr}</span>
                          <ArrowRight className="size-3 text-[#03aa5c] shrink-0" />
                          <span className="font-semibold text-[#141414]">
                            {row.next}
                          </span>
                        </div>
                      </div>
                      {row.reason && (
                        <p className="pl-3.5 text-[12px] text-[#6e6e73] leading-[1.55]">{row.reason}</p>
                      )}
                    </div>
                  ))}

                  {(changedRows.length === 0 || showUnchanged) &&
                    unchangedRows.map((row) => (
                      <div key={row.key} className="py-2.5 first:pt-1 last:pb-0.5 space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span
                            className="inline-flex items-center gap-2 text-[12.5px] text-[#52525b]"
                            title={`Tham số: ${row.techKey}`}
                          >
                            <Check className="size-3 text-[#a1a1aa] shrink-0" />
                            {row.title}
                          </span>
                          <span className="text-[12px] text-[#52525b] tabular-nums">
                            {row.next}
                          </span>
                        </div>
                        {row.reason && (
                          <p className="pl-5 text-[11.5px] text-[#8a8a8e] leading-[1.5]">{row.reason}</p>
                        )}
                      </div>
                    ))}
                </div>
              </section>

              {/* 3. Split Dataset Suggestions (Quiet Collapsible) */}
              {report.split_warnings.length > 0 && (
                <section className="ba-reveal px-5 py-3.5 space-y-2.5">
                  <button
                    type="button"
                    onClick={() => setShowSplits((v) => !v)}
                    className="w-full flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.05em] text-[#8a8a8e] hover:text-[#141414] transition-colors"
                  >
                    <span>Gợi ý tách nhóm tài liệu ({report.split_warnings.length} nhóm)</span>
                    {showSplits ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                  </button>
                  {showSplits && (
                    <div className="divide-y divide-[#f2f2ef]">
                      {report.split_warnings.map((w, idx) => (
                        <div key={idx} className="py-2 first:pt-0 last:pb-0 space-y-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                              <span className="font-medium text-[#141414]">{w.group}</span>
                              <span className="text-[#a1a1aa]">·</span>
                              <span className="font-mono text-[11px] text-[#71717a]">
                                {w.doc_codes.slice(0, 5).map((code, ci) => (
                                  <span key={code} title={filenameByCode[code] || code} className="cursor-help">
                                    {ci > 0 ? ', ' : ''}
                                    {code}
                                  </span>
                                ))}
                                {w.doc_codes.length > 5 ? ` +${w.doc_codes.length - 5}` : ''}
                              </span>
                            </div>
                            <span className="text-[11.5px] text-[#52525b]">
                              Chunk method:{' '}
                              <strong className="font-medium text-[#141414]">
                                {METHOD_LABELS[w.suggested_method] || w.suggested_method}
                              </strong>
                            </span>
                          </div>
                          <p className="text-[12px] text-[#6e6e73] leading-[1.5]">{w.reason}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {/* 4. Per-File Table */}
              <section className="px-5 py-3.5">
                <button
                  type="button"
                  onClick={() => setShowFiles((v) => !v)}
                  className="w-full flex items-center justify-between text-[12px] font-medium text-[#52525b] hover:text-[#141414] transition-colors"
                >
                  <span>Chi tiết từng tài liệu ({report.files.length} tệp)</span>
                  {showFiles ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                </button>

                {showFiles && (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-3 text-[11.5px] border-b border-[#f0f0ed] pb-1.5">
                      {(
                        [
                          ['all', `Tất cả (${report.files.length})`],
                          [
                            'notable',
                            `Cần chú ý (${
                              report.files.filter((f) => f.is_scan || f.has_law_structure || f.max_table_tokens >= 800)
                                .length
                            })`,
                          ],
                          ['tables', `Có bảng (${docsWithTablesCount})`],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setFileFilter(key)}
                          className={`transition-colors ${
                            fileFilter === key ? 'text-[#141414] font-semibold' : 'text-[#8a8a8e] hover:text-[#141414]'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <div className="max-h-52 overflow-y-auto">
                      <table className="w-full text-left border-collapse text-[11.5px]">
                        <thead className="sticky top-0 bg-white border-b border-[#ecece9] text-[10.5px] text-[#8a8a8e]">
                          <tr>
                            <th className="py-1.5 pr-2 font-medium">Mã</th>
                            <th className="py-1.5 px-2 font-medium">Tên tài liệu</th>
                            <th className="py-1.5 px-2 font-medium text-right">Loại</th>
                            <th className="py-1.5 px-2 font-medium text-right">Quy mô</th>
                            <th className="py-1.5 px-2 font-medium text-right">Bảng</th>
                            <th className="py-1.5 px-2 font-medium text-right">Độ dài</th>
                            <th className="py-1.5 pl-2 font-medium text-right">Ghi chú</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#f5f5f3]">
                          {filteredFiles.map((f) => {
                            const unit = UNIT_LABEL_BY_EXT[f.ext] || 'mục';
                            const estWords = Math.round((f.p75_section_tokens || 0) * 0.75);
                            return (
                              <tr key={f.doc_code} className="hover:bg-[#fafaf8]">
                                <td className="py-1.5 pr-2 font-mono text-[11px] font-medium text-[#141414]">
                                  {f.doc_code}
                                </td>
                                <td className="py-1.5 px-2 text-[#27272a] max-w-[190px] truncate" title={f.filename}>
                                  {f.filename}
                                </td>
                                <td className="py-1.5 px-2 text-right font-mono text-[10.5px] text-[#8a8a8e]">
                                  {f.ext}
                                </td>
                                <td className="py-1.5 px-2 text-right text-[#52525b] tabular-nums whitespace-nowrap">
                                  {f.pages_or_units > 0 ? `${fmtInt(f.pages_or_units)} ${unit}` : '—'}
                                </td>
                                <td className="py-1.5 px-2 text-right font-mono tabular-nums text-[#52525b]">
                                  {f.table_count > 0 ? fmtInt(f.table_count) : '—'}
                                </td>
                                <td className="py-1.5 px-2 text-right text-[#52525b] tabular-nums whitespace-nowrap">
                                  {estWords > 0 ? `~${fmtInt(estWords)} từ` : '—'}
                                </td>
                                <td className="py-1.5 pl-2 text-right whitespace-nowrap text-[11px]">
                                  {f.is_scan ? (
                                    <span className="font-medium text-[#141414]">Ảnh scan</span>
                                  ) : f.has_law_structure ? (
                                    <span className="text-[#52525b]">Điều khoản</span>
                                  ) : f.max_table_tokens >= 800 ? (
                                    <span className="text-[#52525b]">Bảng lớn</span>
                                  ) : (
                                    <span className="text-[#c4c4c8]">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="px-5 py-3 border-t border-[#ecece9] bg-white flex items-center justify-between gap-3 shrink-0">
          <span className="text-[11px] text-[#8a8a8e] truncate">
            {report
              ? `Đồng bộ trực tiếp lên Cấu hình Parse của RAGFlow · không tự parse lại`
              : ''}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={applying}
              className="px-3 py-1.5 rounded text-[12px] font-medium text-[#52525b] hover:text-[#141414] hover:bg-[#f4f4f2] transition-colors"
            >
              Đóng
            </button>
            <button
              type="button"
              onClick={() => setConfirmApplyOpen(true)}
              disabled={!report || scanning || applying}
              className="px-3.5 py-1.5 rounded text-[12px] font-medium bg-[#141414] hover:bg-[#27272a] text-white disabled:opacity-40 transition-colors"
            >
              {applying ? 'Đang áp dụng...' : 'Áp dụng cấu hình'}
            </button>
          </div>
        </footer>

        {/* Floating Apply Confirmation Popover */}
        {confirmApplyOpen && report && (
          <div
            className="fixed inset-0 z-[60] bg-[#141414]/35 backdrop-blur-[1px] flex items-center justify-center p-4"
            onClick={() => {
              if (!applying) setConfirmApplyOpen(false);
            }}
          >
            <div
              ref={confirmRef}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-[440px] rounded-lg bg-white border border-[#e4e4e2] shadow-[0_24px_60px_-16px_rgba(20,20,20,0.3)] overflow-hidden"
            >
              <div className="px-5 py-3.5 border-b border-[#ecece9] flex items-center justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold text-[#141414]">
                  Các thay đổi sau sẽ áp dụng
                </h3>
                <button
                  type="button"
                  onClick={() => setConfirmApplyOpen(false)}
                  disabled={applying}
                  className="p-1 text-[#8a8a8e] hover:text-[#141414] rounded transition-colors"
                  aria-label="Đóng"
                >
                  <X className="size-3.5" />
                </button>
              </div>

              <div className="px-5 py-4 space-y-3">
                <p className="text-[12px] text-[#6e6e73] leading-relaxed">
                  Cấu hình Parse của phiên <strong className="text-[#141414] font-medium">{activeRun.name}</strong> sẽ được đồng bộ trực tiếp lên Dataset trên RAGFlow:
                </p>

                <ul className="space-y-2 text-[12.5px]">
                  {(changedRows.length > 0 ? changedRows : diffRows).map((row) => (
                    <li key={row.key} className="flex items-start justify-between gap-3">
                      <span className="inline-flex items-center gap-2 text-[#27272a] shrink-0">
                        <span
                          className={`size-1.5 rounded-full shrink-0 ${
                            row.changed ? 'bg-[#03aa5c]' : 'bg-[#d4d4d8]'
                          }`}
                        />
                        {row.title}
                      </span>
                      <span className="text-right tabular-nums">
                        {row.changed ? (
                          <span className="inline-flex items-center justify-end flex-wrap gap-1">
                            <span className="text-[#a1a1aa] line-through">{row.curr}</span>
                            <ArrowRight className="size-3 text-[#03aa5c] shrink-0" />
                            <strong className="font-semibold text-[#141414]">{row.next}</strong>
                          </span>
                        ) : (
                          <span className="text-[#52525b]">{row.next}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>

                <p className="pt-2 border-t border-[#f0f0ed] text-[11.5px] text-[#8a8a8e] leading-relaxed">
                  Không tự động tách kho tài liệu hay chạy Parse lại. Nếu các tệp đã Parse trước đó, bạn cần bấm Parse lại ở Bước 1 để áp dụng cấu hình mới.
                </p>
              </div>

              <div className="px-5 py-3 border-t border-[#ecece9] bg-[#fafaf8] flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmApplyOpen(false)}
                  disabled={applying}
                  className="px-3 py-1.5 rounded text-[12px] font-medium text-[#52525b] hover:text-[#141414] hover:bg-[#efefec] transition-colors"
                >
                  Hủy
                </button>
                <button
                  type="button"
                  onClick={handleApply}
                  disabled={applying}
                  className="px-3.5 py-1.5 rounded text-[12px] font-medium bg-[#141414] hover:bg-[#27272a] text-white disabled:opacity-40 transition-colors"
                >
                  {applying ? 'Đang đồng bộ...' : 'Xác nhận áp dụng'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
