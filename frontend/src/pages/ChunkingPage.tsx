import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertCircle, ArrowRight, BarChart3, ChevronLeft, ChevronRight, LayoutGrid, List, Loader2, Maximize2, Search, Shuffle, Sparkles, Table2, Wand2, X } from 'lucide-react';
import { api } from '../api/client';
import { ChunkEvalItem, ErrorCodeDef, RunItem } from '../types';
import { ChunkExplorer } from '../components/ChunkExplorer';
import { ChunkingTableView } from '../components/ChunkingTableView';
import { ChunkContentView } from '../components/ChunkContentView';

interface Props {
  activeRun: RunItem | null;
  errorCatalog: ErrorCodeDef[];
  isActive?: boolean;
  onNextStep?: () => void;
}

type ChunkFilter = 'ALL' | 'OK' | 'FAIL' | 'UNCONFIRMED';

const FLAG_LABELS: Record<string, string> = {
  EMPTY: 'Chunk rỗng',
  TOO_SHORT: 'Quá ngắn (<50 ký tự)',
  TOO_LONG: 'Quá dài (>2600 ký tự)',
  NUMERIC_ONLY_NOISE: 'Chunk rác / chỉ có số',
  SUSPECTED_NOISE: 'Dính header/footer/nhiễu web',
  ISOLATED_PAGE_NUM: 'Dính số trang đơn lẻ giữa chunk',
  CHAR_CORRUPTION: 'Lỗi mã hóa ký tự',
  ADJACENT_DUPLICATE: 'Trùng lặp do overlap liền kề',
  DUPLICATE: 'Trùng lặp với chunk khác',
  INTERNAL_DUPLICATE: 'Lặp nội dung trong cùng chunk',
  BROKEN_TABLE: 'Vỡ bảng khi cắt chunk',
  BAD_BOUNDARY: 'Cắt ngang câu / sai ranh giới',
  LIST_SPLIT: 'Cắt ngang danh sách từ chunk trước',
  LOW_CONTEXT: 'Nghi thiếu ngữ cảnh / mất heading',
};

export const ChunkingPage: React.FC<Props> = ({ activeRun, errorCatalog, isActive = true, onNextStep }) => {
  const [activeTab, setActiveTab] = useState<'qc' | 'explore'>('qc');
  const [pageViewMode, setPageViewMode] = useState<'overview' | 'table'>('overview');
  const [sidebarViewMode, setSidebarViewMode] = useState<'grid' | 'list'>('grid');
  const [chunks, setChunks] = useState<ChunkEvalItem[]>([]);
  const [selected, setSelected] = useState<ChunkEvalItem | null>(null);
  const [hovered, setHovered] = useState<ChunkEvalItem | null>(null);
  const [metrics, setMetrics] = useState<any>(null);
  const [sampleMode, setSampleMode] = useState<'adaptive' | 'fixed' | 'full'>('adaptive');
  const [perDoc, setPerDoc] = useState(5);
  const [docFilter, setDocFilter] = useState('');
  const [colorFilter, setColorFilter] = useState<ChunkFilter>('ALL');
  const [sampling, setSampling] = useState(false);
  const [judgingEngine, setJudgingEngine] = useState<'' | 'jev' | 'llm'>('');
  const [saving, setSaving] = useState(false);

  const [integrity, setIntegrity] = useState<number>(1);
  const [contextSuff, setContextSuff] = useState<number>(1);
  const [noNoise, setNoNoise] = useState<number>(1);
  const [noDup, setNoDup] = useState<number>(1);
  const [validSize, setValidSize] = useState<number>(1);
  const [errCodes, setErrCodes] = useState<string[]>([]);
  const [notes, setNotes] = useState('');

  const getChunkState = (c: ChunkEvalItem): 'OK' | 'FAIL' => {
    const codes = c.error_codes || [];
    const badCount =
      (c.integrity === 0 ? 1 : 0) +
      (c.context_sufficiency === 0 ? 1 : 0) +
      (c.no_noise === 0 ? 1 : 0) +
      (c.no_duplicate === 0 ? 1 : 0) +
      (c.valid_size === 0 ? 1 : 0);
    if (codes.length > 0 || badCount > 0) return 'FAIL';
    return 'OK';
  };

  const getTileClass = (c: ChunkEvalItem, isSel: boolean) => {
    const ring = isSel ? 'outline outline-2 outline-[#18181b] outline-offset-1 z-10' : 'hover:opacity-80';
    const st = getChunkState(c);
    const manual = c.judge_source === 'MANUAL';
    if (st === 'OK') return `${manual ? 'bg-[#2da44e]' : 'bg-[#4ea874]'} ${ring}`;
    return `${manual ? 'bg-[#cf222e]' : 'bg-[#d6656c]'} ${ring}`;
  };

  const pickChunk = (c: ChunkEvalItem) => {
    setSelected(c);
    setIntegrity(c.integrity ?? 1);
    setContextSuff(c.context_sufficiency ?? 1);
    setNoNoise(c.no_noise ?? 1);
    setNoDup(c.no_duplicate ?? 1);
    setValidSize(c.valid_size ?? 1);
    setErrCodes(c.error_codes || []);
    setNotes(c.notes || '');
  };

  const load = async (advanceFromPk?: number, autoSampleIfEmpty = false) => {
    if (!activeRun) return;
    const [list, m] = await Promise.all([
      api.listChunkEvals(activeRun.id, true),
      api.getChunkingMetrics(activeRun.id),
    ]);
    if (list.length === 0 && autoSampleIfEmpty && (activeRun.chunk_count ?? 0) > 0) {
      setSampling(true);
      try {
        await api.sampleChunks(activeRun.id, { mode: sampleMode, perDoc });
        const [list2, m2] = await Promise.all([
          api.listChunkEvals(activeRun.id, true),
          api.getChunkingMetrics(activeRun.id),
        ]);
        setChunks(list2);
        setMetrics(m2);
        if (m2?.sampling_meta?.mode) {
          setSampleMode(m2.sampling_meta.mode);
        }
      } catch (e: any) {
        toast.error(e.message);
      } finally {
        setSampling(false);
      }
      return;
    }
    setChunks(list);
    setMetrics(m);
    if (m?.sampling_meta?.mode && !advanceFromPk) {
      setSampleMode(m.sampling_meta.mode);
    }
    if (list.length > 0) {
      if (advanceFromPk) {
        const idx = list.findIndex((c: ChunkEvalItem) => c.chunk_pk === advanceFromPk);
        const nextItem = idx >= 0 && idx + 1 < list.length ? list[idx + 1] : null;
        if (nextItem) pickChunk(nextItem);
        else setSelected(null);
      } else if (selected) {
        const keep = list.find((c: ChunkEvalItem) => c.chunk_pk === selected.chunk_pk);
        if (keep) pickChunk(keep);
        else setSelected(null);
      }
    } else {
      setSelected(null);
    }
  };

  useEffect(() => {
    setSelected(null);
    setHovered(null);
    load(undefined, true);
  }, [activeRun?.id]);

  const handleAutoSample = async () => {
    if (!activeRun || sampling) return;
    setSampling(true);
    try {
      const res = await api.sampleChunks(activeRun.id, { mode: sampleMode, perDoc });
      setSelected(null);
      await load();
      const modeLabel =
        sampleMode === 'adaptive' ? 'Adaptive √n (Bankier 1988)' : sampleMode === 'full' ? 'Toàn bộ 100%' : `Cố định ${perDoc}/file`;
      toast.success(
        `Đã chọn mẫu [${modeLabel}]: ${res.sampled_chunks ?? ''}/${res.total_chunks ?? ''} chunks · Rule 100% · LLM chấm mới ${res.llm_judged ?? 0}.`
      );
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSampling(false);
    }
  };

  const handleAiJudge = async (engine: 'jev' | 'llm') => {
    if (!activeRun || judgingEngine || sampling) return;
    setJudgingEngine(engine);
    try {
      const res = await api.llmJudgeChunks(activeRun.id, false, engine);
      setSelected(null);
      await load();
      const engLabel = (res.judge_engine || engine) === 'jev' ? 'Kev/Jev' : 'LLM';
      const msTxt = res.judge_duration_ms ? ` trong ${res.judge_duration_ms}ms` : '';
      const errTxt = res.failed_count > 0 ? ` · ${res.failed_count} chunk lỗi` : '';
      const msg = `${engLabel} (${res.model || 'AI'}) đã chấm ${res.judged_count} chunk${msTxt}${errTxt} (giữ nguyên ${res.skipped_manual || 0} chunk đã duyệt tay).`;
      if (res.failed_count > 0) {
        toast.warning(msg);
      } else {
        toast.success(msg);
      }
    } catch (e: any) {
      toast.error(e.message || 'Không chấm được Chunking');
    } finally {
      setJudgingEngine('');
    }
  };

  const handleSaveScore = async () => {
    if (!activeRun || !selected || saving) return;
    setSaving(true);
    try {
      await api.scoreChunk(activeRun.id, selected.chunk_pk, {
        integrity,
        context_sufficiency: contextSuff,
        no_noise: noNoise,
        no_duplicate: noDup,
        valid_size: validSize,
        error_codes: errCodes,
        notes,
        judge_source: 'MANUAL',
      });
      await load(selected.chunk_pk);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleCode = (code: string) => {
    setErrCodes((prev) => {
      const next = prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code];
      // Sync 5 criteria toggles 1-to-1 with 5 clean Chunking error codes
      setIntegrity(next.includes('INTEGRITY') ? 0 : 1);
      setContextSuff(next.includes('CONTEXT') ? 0 : 1);
      setNoNoise(next.includes('NOISE') ? 0 : 1);
      setNoDup(next.includes('DUPLICATE') ? 0 : 1);
      setValidSize(next.includes('SIZE') ? 0 : 1);
      return next;
    });
  };

  // 2-way sync: clicking a criterion toggle immediately updates errCodes too
  const setCriterion = (code: 'INTEGRITY' | 'CONTEXT' | 'NOISE' | 'DUPLICATE' | 'SIZE', val: number) => {
    if (code === 'INTEGRITY') setIntegrity(val);
    else if (code === 'CONTEXT') setContextSuff(val);
    else if (code === 'NOISE') setNoNoise(val);
    else if (code === 'DUPLICATE') setNoDup(val);
    else if (code === 'SIZE') setValidSize(val);
    setErrCodes((prev) =>
      val === 0 ? (prev.includes(code) ? prev : [...prev, code]) : prev.filter((x) => x !== code)
    );
  };

  const docOptions = Array.from(
    new Map(chunks.map((c) => [c.doc_code || 'DOC', { code: c.doc_code || 'DOC', name: c.filename || '' }])).values()
  );

  const visibleChunks = chunks.filter((c) => {
    if (docFilter && (c.doc_code || 'DOC') !== docFilter) return false;
    if (colorFilter === 'ALL') return true;
    if (colorFilter === 'UNCONFIRMED') return c.judge_source !== 'MANUAL';
    return getChunkState(c) === colorFilter;
  });

  const stepChunk = (delta: -1 | 1) => {
    if (!selected || visibleChunks.length === 0) return;
    const idx = visibleChunks.findIndex((c) => c.chunk_pk === selected.chunk_pk);
    if (idx < 0) return;
    const target = visibleChunks[idx + delta];
    if (target) pickChunk(target);
  };

  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        setSelected(null);
      } else if (selected && !saving) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          stepChunk(-1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          stepChunk(1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          handleSaveScore();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive, selected, visibleChunks, integrity, contextSuff, noNoise, noDup, validSize, errCodes, notes, saving]);

  if (!activeRun) {
    return <div className="p-8 text-sm text-[#71717a]">Hãy chọn hoặc tạo một phiên kiểm thử trước.</div>;
  }

  const counts = chunks.reduce(
    (acc, c) => {
      if (docFilter && (c.doc_code || 'DOC') !== docFilter) return acc;
      acc.TOTAL += 1;
      acc[getChunkState(c)] += 1;
      if (c.judge_source !== 'MANUAL') acc.UNCONFIRMED += 1;
      return acc;
    },
    { TOTAL: 0, OK: 0, FAIL: 0, UNCONFIRMED: 0 }
  );

  const grouped = visibleChunks.reduce<Record<string, { doc_code: string; filename: string; items: ChunkEvalItem[] }>>(
    (acc, c) => {
      const code = c.doc_code || 'DOC';
      if (!acc[code]) acc[code] = { doc_code: code, filename: c.filename || '', items: [] };
      acc[code].items.push(c);
      return acc;
    },
    {}
  );

  const selectedIdx = selected ? visibleChunks.findIndex((c) => c.chunk_pk === selected.chunk_pk) : -1;
  const preview = hovered || selected;

  return (
    <div className="h-[calc(100dvh-48px)] flex flex-col bg-white">
      {/* Sub-navigation Tabs */}
      <div className="px-5 border-b border-[#e8e8e6] bg-white flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setActiveTab('qc')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${activeTab === 'qc'
                ? 'border-[#18181b] text-[#18181b]'
                : 'border-transparent text-[#71717a] hover:text-[#18181b]'
              }`}
          >
            <LayoutGrid className="size-3.5" />
            Chấm điểm QC (Mẫu)
            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#f4f4f2] text-[#52525b]">
              {chunks.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('explore')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${activeTab === 'explore'
                ? 'border-[#18181b] text-[#18181b]'
                : 'border-transparent text-[#71717a] hover:text-[#18181b]'
              }`}
          >
            <Search className="size-3.5" />
            Research toàn bộ Chunks
            {typeof activeRun.chunk_count === 'number' && (
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#f4f4f2] text-[#52525b]">
                {activeRun.chunk_count}
              </span>
            )}
          </button>
        </div>
      </div>

      {activeTab === 'explore' ? (
        <ChunkExplorer runId={activeRun.id} flagLabels={FLAG_LABELS} />
      ) : (
        <>
          {/* Toolbar + 6 Phụ lục A Metrics */}
          <div className="px-5 py-2.5 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-3 shrink-0">
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="ts-input py-1.5 px-2.5 text-xs rounded-md bg-white min-w-[200px]"
                value={docFilter}
                onChange={(e) => {
                  setDocFilter(e.target.value);
                  setSelected(null);
                }}
              >
                <option value="">Tất cả tài liệu ({docOptions.length})</option>
                {docOptions.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.code} — {d.name.slice(0, 32)}
                  </option>
                ))}
              </select>
              <div className="inline-flex items-center border border-[#e4e4e2] bg-white rounded-md">
                <select
                  className="py-1 pl-2 pr-1.5 text-xs font-medium bg-white text-[#18181b] rounded-l-md focus:outline-none cursor-pointer"
                  value={sampleMode}
                  onChange={(e) => setSampleMode(e.target.value as 'adaptive' | 'fixed' | 'full')}
                  disabled={sampling || !!judgingEngine}
                  title="Chọn phương pháp phân bổ mẫu Chunking"
                >
                  <option value="adaptive">Adaptive √n</option>
                  <option value="fixed">Cố định</option>
                  <option value="full">Toàn bộ 100%</option>
                </select>
                {sampleMode === 'fixed' && (
                  <>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      className="w-11 py-1 px-1.5 text-xs font-mono text-right bg-white text-[#18181b] border-l border-[#ededeb] focus:outline-none"
                      value={perDoc}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        setPerDoc(Number.isFinite(v) ? Math.max(1, Math.min(100, v)) : 5);
                      }}
                      disabled={sampling || !!judgingEngine}
                      title="Nhập số chunk mẫu mỗi tài liệu (1–100)"
                    />
                    <span className="pr-2 text-[11px] text-[#71717a] select-none">/file</span>
                  </>
                )}
                <button
                  type="button"
                  onClick={handleAutoSample}
                  disabled={sampling || !!judgingEngine}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-[#f7f7f6] hover:bg-[#ededeb] text-[#18181b] border-l border-[#e4e4e2] rounded-r-md disabled:opacity-45 transition-colors"
                  title="Lấy mẫu lại theo chế độ đã chọn, quét Rule 100% chunks & chấm AI mặc định các mẫu mới"
                >
                  {sampling ? <Loader2 className="size-3 animate-spin" /> : <Shuffle className="size-3" />}
                  {sampling ? 'Đang lấy mẫu...' : 'Lấy mẫu lại'}
                </button>
              </div>
              {/* (!) Methodology & Formula Hover Note */}
              <div className="relative group inline-flex items-center">
                <button
                  type="button"
                  aria-label="Ghi chú phương pháp phân bổ mẫu & tính điểm"
                  className="inline-flex items-center justify-center size-6 rounded-full border border-[#dcdcd9] bg-white text-[#52525b] hover:border-[#18181b] hover:text-[#18181b] transition-colors cursor-help"
                >
                  <AlertCircle className="size-3.5" />
                </button>
                <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute left-0 top-full mt-2 z-50 w-[370px] rounded-lg border border-[#e4e4e2] bg-white p-4 shadow-xl text-[11px] text-[#3f3f46] leading-relaxed">
                  <div className="flex items-center justify-between gap-2 pb-2 mb-2.5 border-b border-[#f0f0ee]">
                    <span className="font-semibold text-xs text-[#18181b]">
                      Phương pháp phân bổ mẫu &amp; chấm điểm
                    </span>
                    <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#03aa5c]/10 text-[#027a42] font-semibold">
                      {metrics?.sampled_total ?? chunks.length}/{metrics?.total_chunks ?? activeRun.chunk_count ?? 0} ({metrics?.coverage_pct ?? 0}%)
                    </span>
                  </div>
                  <div className="space-y-2.5">
                    <div>
                      <div className="font-semibold text-[#18181b] mb-0.5">
                        1. Adaptive √n — Power Allocation (Bankier, 1988)
                      </div>
                      <p>
                        Số mẫu mỗi tài liệu tính theo{' '}
                        <span className="font-mono text-[10px] bg-[#f4f4f2] px-1 py-0.5 rounded text-[#18181b]">
                          k = clamp(round({metrics?.sampling_meta?.sqrt_k ?? 2} × √n), {metrics?.sampling_meta?.min_per_doc ?? 5}, {metrics?.sampling_meta?.max_per_doc ?? 20})
                        </span>
                        . Cân bằng giữa độ tin cậy file ngắn (luôn giữ sàn ≥ {metrics?.sampling_meta?.min_per_doc ?? 5}) và độ phủ file dài (tăng theo √n thay vì cố định 5 mẫu/file).
                      </p>
                      <p className="text-[10px] text-[#71717a] mt-0.5">
                        Phân tầng trong file: Đầu file → Bảng biểu → Giữa file (chia đều) → Cuối file.
                      </p>
                    </div>
                    <div>
                      <div className="font-semibold text-[#18181b] mb-0.5">
                        2. Quét Rule-based 100% + LLM-as-a-Judge
                      </div>
                      <p>
                        Bộ quy tắc tự động quét <strong className="text-[#18181b]">100% toàn bộ chunks</strong> để bắt sạch lỗi cơ học (SIZE, DUPLICATE, NOISE). LLM-as-a-Judge chấm ngữ nghĩa trên tập mẫu (tự giữ nguyên các mẫu đã chấm khi đổi cỡ mẫu).
                      </p>
                    </div>
                    <div>
                      <div className="font-semibold text-[#18181b] mb-0.5">
                        3. Điểm tổng có trọng số — Cochran (1977)
                      </div>
                      <p>
                        Điểm tổng áp dụng <span className="font-mono text-[10px] bg-[#f4f4f2] px-1 py-0.5 rounded text-[#18181b]">P̂ = Σ (Nₕ / N) · pₕ</span> — nhân trọng số theo tổng số chunk thật (<span className="font-mono text-[10px]">Nₕ</span>) của từng tài liệu để file ngắn không làm lệch điểm toàn corpus.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              {chunks.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => handleAiJudge('jev')}
                    disabled={!!judgingEngine || sampling}
                    className="ts-btn-ghost py-1 px-2 text-xs rounded-md border border-emerald-200 bg-emerald-50/70 text-emerald-800 hover:bg-emerald-100 disabled:opacity-45"
                    title="Chấm lại toàn bộ chunk mẫu bằng Kev / Jev System One (giữ nguyên các chunk đã duyệt tay)"
                  >
                    {judgingEngine === 'jev' ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    {judgingEngine === 'jev' ? 'Kev/Jev đang chấm...' : 'Chấm lại Kev / Jev'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAiJudge('llm')}
                    disabled={!!judgingEngine || sampling}
                    className="ts-btn-ghost py-1 px-2 text-xs rounded-md disabled:opacity-45"
                    title="Chấm lại toàn bộ chunk mẫu bằng Generative LLM (giữ nguyên các chunk đã duyệt tay)"
                  >
                    {judgingEngine === 'llm' ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
                    {judgingEngine === 'llm' ? 'Đang chấm LLM...' : 'Chấm lại LLM'}
                  </button>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xs text-[#52525b]">
              <div className="inline-flex items-center p-0.5 rounded-md bg-[#f4f4f2] border border-[#e4e4e2] mr-1">
                <button
                  type="button"
                  onClick={() => setPageViewMode('overview')}
                  className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${pageViewMode === 'overview'
                      ? 'bg-white text-[#18181b] font-medium shadow-xs'
                      : 'text-[#71717a] hover:text-[#18181b]'
                    }`}
                  title="Xem ma trận ô màu tổng quan"
                >
                  <LayoutGrid className="size-3" />
                  Tổng quan
                </button>
                <button
                  type="button"
                  onClick={() => setPageViewMode('table')}
                  className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${pageViewMode === 'table'
                      ? 'bg-white text-[#18181b] font-medium shadow-xs'
                      : 'text-[#71717a] hover:text-[#18181b]'
                    }`}
                  title="Xem bảng tổng hợp & chi tiết dạng Excel"
                >
                  <Table2 className="size-3" />
                  Bảng chi tiết
                </button>
              </div>

              <button
                type="button"
                disabled={sampling || visibleChunks.length === 0}
                onClick={() => {
                  const firstTarget = visibleChunks.find((c) => c.judge_source !== 'MANUAL') || visibleChunks[0];
                  if (firstTarget) pickChunk(firstTarget);
                }}
                className="py-1 px-2.5 text-xs font-medium rounded-md inline-flex items-center gap-1.5 bg-[#18181b] text-white hover:bg-[#27272a] disabled:opacity-45 transition-colors"
                title="Mở chế độ chấm toàn màn hình"
              >
                <Maximize2 className="size-3" />
                Chế độ chấm
              </button>

              {onNextStep && (
                <button onClick={onNextStep} className="ts-btn-secondary py-1 px-2.5 text-xs rounded-md">
                  Bước 4
                  <ArrowRight className="size-3" />
                </button>
              )}
            </div>
          </div>

          {pageViewMode === 'table' ? (
            <ChunkingTableView
              runId={activeRun.id}
              chunks={chunks}
              getChunkState={getChunkState}
              onSelectChunk={(c) => pickChunk(c)}
            />
          ) : (
            /* 2-Column Overview: Left = Matrix (DOC01..DOC20), Right = Thống kê chất lượng & lỗi (matching Parsing) */
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0 overflow-hidden bg-white">
              {/* Left: Matrix Overview */}
              <div className="lg:col-span-7 overflow-y-auto px-6 py-4 border-b lg:border-b-0 lg:border-r border-[#e8e8e6] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-mono text-[11px] font-semibold text-[#18181b] mr-2" title="Đã chốt thủ công / Tổng mẫu">
                      {metrics?.rated_manual || 0}/{counts.TOTAL}
                    </span>
                    {(
                      [
                        { id: 'ALL', label: `Tất cả (${counts.TOTAL})`, dot: 'bg-[#18181b]' },
                        { id: 'OK', label: `Đạt (${counts.OK})`, dot: 'bg-[#4ea874]' },
                        { id: 'FAIL', label: `Có lỗi (${counts.FAIL})`, dot: 'bg-[#d6656c]' },
                        { id: 'UNCONFIRMED', label: `Chưa chốt (${counts.UNCONFIRMED})`, dot: 'bg-[#d4d4d8]' },
                      ] as { id: ChunkFilter; label: string; dot: string }[]
                    ).map((f) => (
                      <button
                        key={f.id}
                        onClick={() => {
                          setColorFilter(f.id);
                          setSelected(null);
                        }}
                        className={`inline-flex items-center gap-1.5 px-2 py-1 text-[11px] transition-colors ${colorFilter === f.id
                            ? 'bg-[#18181b] text-white font-medium'
                            : 'bg-[#f4f4f2] text-[#52525b] hover:bg-[#e8e8e5]'
                          }`}
                      >
                        <span className={`size-2 inline-block ${f.dot}`} />
                        <span className="font-mono tabular-nums">{f.label}</span>
                      </button>
                    ))}
                  </div>

                  <div className="text-[11px] font-mono text-[#52525b] min-h-[18px] flex items-center gap-2">
                    {preview ? (
                      <>
                        <span className="font-semibold text-[#18181b]">
                          {preview.doc_code} #{preview.chunk_index}
                        </span>
                        <span>{preview.char_count}c</span>
                        <span>p.{preview.page_num || '—'}</span>
                        {(preview.error_codes || []).length > 0 && (
                          <span className="text-[#cf222e]">{preview.error_codes.join(', ')}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-[#a1a1aa] font-sans">Bấm vào ô vuông để mở chế độ chấm</span>
                    )}
                  </div>
                </div>

                {sampling && chunks.length === 0 ? (
                  <div className="py-12 flex items-center justify-center gap-2 text-xs text-[#71717a]">
                    <Loader2 className="size-4 animate-spin" /> Đang lấy mẫu &amp; quét lỗi tự động...
                  </div>
                ) : visibleChunks.length === 0 ? (
                  <div className="py-12 text-center text-xs text-[#71717a] bg-[#fafaf9]">
                    Không có đoạn nào phù hợp bộ lọc. Bấm <strong>Lấy mẫu &amp; Quét</strong> hoặc đổi bộ lọc màu.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {Object.values(grouped).map((grp) => (
                      <div key={grp.doc_code} className="flex items-start gap-3">
                        <div
                          className="w-20 shrink-0 font-mono text-[11px] font-medium text-[#52525b] pt-0.5 truncate"
                          title={grp.filename}
                        >
                          {grp.doc_code}
                        </div>
                        <div className="flex flex-wrap gap-[3px]">
                          {grp.items.map((c) => {
                            const isSel = selected?.chunk_pk === c.chunk_pk;
                            return (
                              <button
                                key={c.chunk_pk}
                                type="button"
                                onClick={() => (isSel ? setSelected(null) : pickChunk(c))}
                                onMouseEnter={() => setHovered(c)}
                                onMouseLeave={() => setHovered(null)}
                                aria-label={`${c.doc_code} #${c.chunk_index}`}
                                className={`relative size-[22px] rounded-none border-0 transition-opacity cursor-pointer ${getTileClass(
                                  c,
                                  isSel
                                )}`}
                              />
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Right: Editorial Thống kê chất lượng & lỗi Panel (matching Step 2 Parsing) */}
              <div
                className="lg:col-span-5 overflow-y-auto px-5 py-4 space-y-4"
                style={{
                  backgroundColor: '#f8f7f4',
                  backgroundImage: 'radial-gradient(#e4e2dc 0.8px, transparent 0.8px)',
                  backgroundSize: '18px 18px',
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#27272a]">
                    <span className="size-6 rounded-full bg-white border border-[#e6e4de] shadow-2xs flex items-center justify-center">
                      <BarChart3 className="size-3.5 text-[#52a478]" />
                    </span>
                    <span>Thống kê chất lượng &amp; lỗi</span>
                  </div>
                  <div className="relative group inline-flex items-center gap-1">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border border-[#e6e4de] text-[10px] font-mono text-[#52525b] cursor-help">
                      Weighted
                      <AlertCircle className="size-3 text-[#71717a]" />
                    </span>
                    <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute right-0 top-full mt-2 z-50 w-[300px] rounded-lg border border-[#e4e4e2] bg-white p-3 shadow-xl text-[11px] text-[#3f3f46] leading-relaxed">
                      <div className="font-semibold text-[#18181b] mb-1">
                        Cochran (1977) Stratified Weighted Score
                      </div>
                      <p>
                        5 chỉ số Radar &amp; Chunking Score được tính có trọng số theo tổng số chunk thật (<span className="font-mono text-[10px]">Nₕ</span>) của từng tài liệu.
                      </p>
                      {metrics?.unweighted && (
                        <div className="mt-2 pt-2 border-t border-[#f0f0ee] text-[10px] font-mono text-[#71717a] space-y-0.5">
                          <div>
                            Unweighted (mẫu thô):{' '}
                            {(
                              ((metrics.unweighted.chunk_integrity +
                                metrics.unweighted.context_sufficiency +
                                (1 - metrics.unweighted.noise_rate) +
                                (1 - metrics.unweighted.duplicate_rate) +
                                metrics.unweighted.valid_size_rate) /
                                5) *
                              100
                            ).toFixed(1)}
                            %
                          </div>
                          <div>
                            Độ phủ mẫu: {metrics.sampled_total}/{metrics.total_chunks} ({metrics.coverage_pct}%)
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {chunks.length === 0 ? (
                  <div className="text-xs text-[#71717a] py-8 text-center">Chưa có dữ liệu thống kê.</div>
                ) : (() => {
                  const total = Math.max(chunks.length, 1);
                  const okCnt = chunks.filter((c) => getChunkState(c) === 'OK').length;
                  const failCnt = chunks.length - okCnt;
                  const passPct = Math.round((okCnt / total) * 100);

                  const hasWeighted = metrics && typeof metrics.chunk_integrity === 'number' && metrics.sampled_total > 0;
                  const vInteg = Math.max(
                    0,
                    Math.min(100, hasWeighted ? metrics.chunk_integrity * 100 : (chunks.filter((c) => c.integrity === 1).length / total) * 100)
                  );
                  const vCtx = Math.max(
                    0,
                    Math.min(100, hasWeighted ? metrics.context_sufficiency * 100 : (chunks.filter((c) => c.context_sufficiency === 1).length / total) * 100)
                  );
                  const vClean = Math.max(
                    0,
                    Math.min(100, hasWeighted ? (1 - metrics.noise_rate) * 100 : (chunks.filter((c) => c.no_noise === 1).length / total) * 100)
                  );
                  const vNoDup = Math.max(
                    0,
                    Math.min(100, hasWeighted ? (1 - metrics.duplicate_rate) * 100 : (chunks.filter((c) => c.no_duplicate === 1).length / total) * 100)
                  );
                  const vSize = Math.max(
                    0,
                    Math.min(100, hasWeighted ? metrics.valid_size_rate * 100 : (chunks.filter((c) => c.valid_size === 1).length / total) * 100)
                  );
                  const chunkScore = (vInteg + vCtx + vClean + vNoDup + vSize) / 5;
                  const noiseRate = 100 - vClean;

                  const cx = 160;
                  const cy = 104;
                  const maxR = 58;
                  const angles = [-90, -18, 54, 126, 198];
                  const pt = (angleDeg: number, pctVal: number) => {
                    const rad = (angleDeg * Math.PI) / 180;
                    const r = (pctVal / 100) * maxR;
                    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
                  };
                  const pts = [
                    pt(angles[0], vInteg),
                    pt(angles[1], vCtx),
                    pt(angles[2], vClean),
                    pt(angles[3], vNoDup),
                    pt(angles[4], vSize),
                  ];
                  const polyPoints = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

                  const codeCounts: Record<string, number> = {};
                  for (const c of chunks) {
                    for (const code of c.error_codes || []) {
                      codeCounts[code] = (codeCounts[code] || 0) + 1;
                    }
                  }
                  const codeBreakdown = Object.entries(codeCounts).sort((a, b) => b[1] - a[1]);

                  const docHotspots = Object.values(
                    chunks.reduce<Record<string, { doc_code: string; filename: string; fail: number; total: number; firstFail: ChunkEvalItem | null }>>((acc, c) => {
                      const code = c.doc_code || 'DOC';
                      if (!acc[code]) acc[code] = { doc_code: code, filename: c.filename || '', fail: 0, total: 0, firstFail: null };
                      acc[code].total += 1;
                      if (getChunkState(c) === 'FAIL') {
                        acc[code].fail += 1;
                        if (!acc[code].firstFail) acc[code].firstFail = c;
                      }
                      return acc;
                    }, {})
                  )
                    .filter((d) => d.fail > 0)
                    .sort((a, b) => b.fail / b.total - a.fail / a.total || b.fail - a.fail)
                    .slice(0, 5);

                  return (
                    <>
                      {/* 1. 5-Axis Radar Chart Card */}
                      <div className="bg-white border border-[#e6e4de] rounded-xl shadow-xs p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-xs font-semibold text-[#18181b]">5 Metric Chunking · Radar 5 trục</div>
                            <div className="text-[11px] text-[#78716c]">
                              Đạt 5/5 <span className="font-mono font-semibold text-[#027a42]">{passPct}%</span> ({okCnt}/{chunks.length} mẫu)
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 text-[11px] font-mono">
                            <span className="px-2 py-0.5 rounded-full bg-[#f2f7f4] text-[#027a42] border border-[#d6eadf]">
                              {okCnt} đạt
                            </span>
                            <span className="px-2 py-0.5 rounded-full bg-[#fef2f2] text-[#b91c1c] border border-[#f5d0d3]">
                              {failCnt} lỗi
                            </span>
                          </div>
                        </div>

                        <div className="flex justify-center">
                          <svg viewBox="0 0 320 210" className="w-full max-w-[330px] h-auto select-none">
                            {[25, 50, 75, 100].map((lvl) => {
                              const ring = angles
                                .map((a) => pt(a, lvl))
                                .map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`)
                                .join(' ');
                              return (
                                <polygon
                                  key={lvl}
                                  points={ring}
                                  fill="none"
                                  stroke={lvl === 100 ? '#d8d5ce' : '#eceae4'}
                                  strokeWidth={lvl === 100 ? 1.2 : 1}
                                  strokeDasharray={lvl === 100 ? undefined : '2 2'}
                                />
                              );
                            })}
                            {angles.map((a, idx) => {
                              const end = pt(a, 100);
                              return (
                                <line
                                  key={idx}
                                  x1={cx}
                                  y1={cy}
                                  x2={end[0].toFixed(1)}
                                  y2={end[1].toFixed(1)}
                                  stroke="#e6e4de"
                                  strokeWidth="1"
                                />
                              );
                            })}
                            <polygon
                              points={polyPoints}
                              fill="rgba(82, 164, 120, 0.16)"
                              stroke="#52a478"
                              strokeWidth="2"
                              strokeLinejoin="round"
                              className="transition-all duration-500 ease-out"
                            />
                            {pts.map((p, idx) => (
                              <circle
                                key={idx}
                                cx={p[0]}
                                cy={p[1]}
                                r="3.5"
                                fill="#ffffff"
                                stroke="#52a478"
                                strokeWidth="2"
                              />
                            ))}

                            <text x={cx} y={16} textAnchor="middle" className="fill-[#52525b] text-[10px] font-medium">
                              Chunk Integrity
                            </text>
                            <text x={cx} y={28} textAnchor="middle" className="fill-[#18181b] text-[10px] font-mono font-semibold">
                              {vInteg.toFixed(0)}%
                            </text>

                            <text x={226} y={79} textAnchor="start" className="fill-[#52525b] text-[10px] font-medium">
                              Context Sufficiency
                            </text>
                            <text x={226} y={91} textAnchor="start" className="fill-[#18181b] text-[10px] font-mono font-semibold">
                              {vCtx.toFixed(0)}%
                            </text>

                            <text x={208} y={170} textAnchor="start" className="fill-[#52525b] text-[10px] font-medium">
                              No Noise
                            </text>
                            <text x={208} y={182} textAnchor="start" className="fill-[#18181b] text-[10px] font-mono font-semibold">
                              {vClean.toFixed(0)}%
                            </text>

                            <text x={112} y={170} textAnchor="end" className="fill-[#52525b] text-[10px] font-medium">
                              No Duplicate
                            </text>
                            <text x={112} y={182} textAnchor="end" className="fill-[#18181b] text-[10px] font-mono font-semibold">
                              {vNoDup.toFixed(0)}%
                            </text>

                            <text x={94} y={79} textAnchor="end" className="fill-[#52525b] text-[10px] font-medium">
                              Size Compliance
                            </text>
                            <text x={94} y={91} textAnchor="end" className="fill-[#18181b] text-[10px] font-mono font-semibold">
                              {vSize.toFixed(0)}%
                            </text>
                          </svg>
                        </div>

                        {/* Noise Rate & Chunk Score cards */}
                        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#efede8]">
                          <div className="px-3 py-2 rounded-lg bg-[#fafaf9] border border-[#eceae4] flex items-center justify-between">
                            <div>
                              <div className="text-[11px] font-medium text-[#52525b]">Noise Rate</div>
                              <div className="text-[10px] text-[#a1a1aa]">Càng thấp càng tốt</div>
                            </div>
                            <span className="font-mono text-sm font-bold text-[#b45309] tabular-nums">
                              {noiseRate.toFixed(1)}%
                            </span>
                          </div>
                          <div className="px-3 py-2 rounded-lg bg-[#f2fbf6] border border-[#d6eadf] flex items-center justify-between">
                            <div>
                              <div className="text-[11px] font-medium text-[#027a42]">Chunk Score</div>
                              <div className="text-[10px] text-[#52525b]">
                                Trọn đáp án: {metrics?.testcase_count ? `${((metrics.answer_containment || 0) * 100).toFixed(0)}%` : '—'}
                              </div>
                            </div>
                            <span className="font-mono text-sm font-bold text-[#027a42] tabular-nums">
                              {chunkScore.toFixed(1)}%
                            </span>
                          </div>
                        </div>

                        {/* Error code chips */}
                        {codeBreakdown.length > 0 && (
                          <div className="pt-2 border-t border-[#efede8] flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span className="text-[#78716c] mr-0.5">Nhóm lỗi:</span>
                            {codeBreakdown.map(([code, cnt]) => (
                              <span
                                key={code}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#fafaf9] border border-[#e6e4de] font-mono text-[10.5px]"
                              >
                                <span className="font-semibold text-[#18181b]">{code}</span>
                                <span className="font-bold text-[#b91c1c]">{cnt}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* 2. Top 5 Hotspot Files */}
                      <div className="bg-white border border-[#e6e4de] rounded-xl shadow-xs p-4 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#18181b]">
                            <AlertCircle className="size-3.5 text-[#dc2626]" />
                            <span>Điểm nóng cần chú ý</span>
                          </div>
                          <span className="text-[11px] text-[#78716c]">Top 5 file lỗi nhiều</span>
                        </div>
                        {docHotspots.length === 0 ? (
                          <div className="text-xs text-[#027a42] py-2">Không có file nào dính lỗi chunking!</div>
                        ) : (
                          <div className="space-y-1.5">
                            {docHotspots.map((d, idx) => {
                              const errRate = Math.round((d.fail / d.total) * 100);
                              return (
                                <button
                                  key={d.doc_code}
                                  type="button"
                                  onClick={() => {
                                    if (d.firstFail) pickChunk(d.firstFail);
                                  }}
                                  className="w-full text-left px-3 py-2 rounded-lg border border-[#efede8] hover:border-[#d4d4d8] hover:bg-[#fafaf9] transition-colors flex items-center justify-between gap-2 group"
                                >
                                  <div className="flex items-center gap-2.5 min-w-0">
                                    <span className="size-5 rounded-full bg-[#fef2f2] text-[#b91c1c] font-mono text-[10px] font-bold flex items-center justify-center shrink-0">
                                      {idx + 1}
                                    </span>
                                    <div className="min-w-0">
                                      <div className="text-xs font-medium text-[#18181b] truncate">
                                        <span className="font-mono font-bold mr-1.5">{d.doc_code}</span>
                                        <span className="text-[#52525b] font-normal">{d.filename}</span>
                                      </div>
                                      <div className="text-[10px] text-[#78716c] mt-0.5">
                                        Lỗi <strong className="font-mono text-[#b91c1c]">{d.fail}/{d.total}</strong> mẫu ({errRate}%)
                                      </div>
                                    </div>
                                  </div>
                                  <span className="text-[11px] font-medium text-[#78716c] group-hover:text-[#18181b] inline-flex items-center gap-0.5 shrink-0">
                                    Chấm <ArrowRight className="size-3" />
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Fullscreen Scoring Mode — opened via "Chế độ chấm", clicking a tile, or clicking an Excel row */}
          {selected && (
            <div className="fixed inset-0 z-30 flex flex-col bg-white">
              <div className="px-5 py-2 border-b border-[#ededeb] bg-[#fafaf9] flex items-center justify-between text-xs shrink-0">
                <div className="flex items-center gap-2.5">
                  <div className="inline-flex items-center border border-[#e4e4e2] bg-white">
                    <button
                      onClick={() => stepChunk(-1)}
                      disabled={selectedIdx <= 0}
                      className="p-1 text-[#52525b] hover:bg-[#f4f4f2] disabled:opacity-30"
                      title="Đoạn trước (←)"
                    >
                      <ChevronLeft className="size-3.5" />
                    </button>
                    <span className="px-2 font-mono text-[11px] text-[#18181b] border-x border-[#e4e4e2]">
                      {selectedIdx + 1}/{visibleChunks.length}
                    </span>
                    <button
                      onClick={() => stepChunk(1)}
                      disabled={selectedIdx < 0 || selectedIdx >= visibleChunks.length - 1}
                      className="p-1 text-[#52525b] hover:bg-[#f4f4f2] disabled:opacity-30"
                      title="Đoạn sau (→)"
                    >
                      <ChevronRight className="size-3.5" />
                    </button>
                  </div>
                  <span className="font-mono font-semibold text-[#18181b]">
                    {selected.doc_code} · Chunk #{selected.chunk_index}
                  </span>
                  <span className="ts-tag-neutral">Trang {selected.page_num || '—'}</span>
                  <span className="font-mono text-[11px] text-[#78716c]">
                    {selected.char_count} ký tự · ~{selected.token_est} token
                  </span>
                  <span className="text-[11px] px-1.5 py-0.5 bg-[#f4f4f2] text-[#52525b]">
                    {selected.judge_source === 'MANUAL' ? 'Đã chốt' : 'Gợi ý tự động'}
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  <span className="hidden md:inline text-[11px] text-[#a1a1aa] font-mono">
                    ←/→ chuyển · Enter lưu & tiếp · Esc đóng
                  </span>
                  <button
                    onClick={() => setSelected(null)}
                    className="inline-flex items-center gap-1 text-xs text-[#52525b] hover:text-[#18181b] px-2 py-1 hover:bg-[#ededeb]"
                  >
                    <X className="size-3.5" /> Đóng
                  </button>
                </div>
              </div>

              {/* Main 2-Column Workspace: Left Content + Right Dedicated Sidebar */}
              <div className="flex-1 flex min-h-0 overflow-hidden">
                {/* Left Main Reading Pane */}
                <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
                  {/* Pinned LLM Evaluation / Note Banner — always visible without scrolling */}
                  {(() => {
                    const st = getChunkState(selected);
                    const activeCodes = selected.error_codes || [];
                    const isOk = st === 'OK';
                    const bannerCls = isOk
                      ? 'bg-[#f2fbf6] border-[#bbf7d0] text-[#027a42]'
                      : 'bg-[#fef2f2] border-[#fecaca] text-[#991b1b]';
                    const sourceLabel =
                      selected.judge_source === 'MANUAL'
                        ? 'Đã duyệt tay'
                        : selected.judge_source === 'JEV'
                          ? 'Đánh giá Kev / Jev'
                          : selected.judge_source === 'LLM'
                            ? 'Đánh giá LLM'
                            : 'Rule tự động';
                    const displayNote =
                      (selected.notes || '').trim() ||
                      (isOk
                        ? 'Đạt 5/5 tiêu chí (trọn ý, đủ ngữ cảnh độc lập, sạch rác, không trùng, kích thước hợp lệ).'
                        : 'Phát hiện lỗi cắt đoạn theo tiêu chí đã gắn ở bên phải.');
                    return (
                      <div className={`px-6 py-2.5 border-b shrink-0 ${bannerCls}`}>
                        <div className="flex flex-wrap items-center gap-1.5 mb-1">
                          <span className="font-mono text-[10px] font-bold uppercase px-1.5 py-0.5 bg-white border border-current/25">
                            {isOk ? 'ĐẠT 5/5' : 'KHÔNG ĐẠT'}
                          </span>
                          <span className="text-[10.5px] font-medium opacity-80">{sourceLabel}</span>
                          {activeCodes.map((code) => (
                            <span
                              key={code}
                              className="font-mono text-[10px] font-semibold px-1.5 py-0.5 bg-[#18181b] text-white"
                            >
                              {code}
                            </span>
                          ))}
                        </div>
                        <div className="text-[12.5px] leading-snug text-[#18181b] font-normal">
                          {displayNote}
                        </div>
                      </div>
                    );
                  })()}

                  <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
                    {/* Auto-detected flags */}
                    {(selected.rule_flags || []).length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {selected.rule_flags.map((f) => (
                          <span key={f} className="text-[11px] px-2 py-0.5 bg-[#fffbeb] text-[#b45309] border border-[#fde68a]">
                            {FLAG_LABELS[f] || f}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Boundary Context: Prev Chunk Tail */}
                    {selected.prev_tail && (
                      <div className="bg-[#fafaf9] border border-dashed border-[#e4e4e2] px-3.5 py-2 text-xs text-[#78716c]">
                        <span className="font-mono text-[10px] uppercase tracking-wide text-[#a1a1aa] mr-2">
                          Cuối Chunk #{selected.chunk_index - 1}:
                        </span>
                        …{selected.prev_tail}
                      </div>
                    )}

                    {/* Main Chunk Content (renders HTML/Markdown tables cleanly with Raw toggle) */}
                    <ChunkContentView content={selected.content} />

                    {/* Boundary Context: Next Chunk Head */}
                    {selected.next_head && (
                      <div className="bg-[#fafaf9] border border-dashed border-[#e4e4e2] px-3.5 py-2 text-xs text-[#78716c]">
                        <span className="font-mono text-[10px] uppercase tracking-wide text-[#a1a1aa] mr-2">
                          Đầu Chunk #{selected.chunk_index + 1}:
                        </span>
                        {selected.next_head}…
                      </div>
                    )}
                  </div>
                </div>

                {/* Dedicated Right Sidebar: Navigation List + Pinned Scoring Controls (matching Step 2 Parsing) */}
                <aside className="w-[310px] shrink-0 border-l border-[#e4e4e2] bg-[#fafaf9] flex flex-col min-h-0 overflow-hidden divide-y divide-[#e8e8e6]">
                  {/* 1. Document Selector & Scrollable Chunk List */}
                  {(() => {
                    const groupsList = Object.values(grouped);
                    const activeDocCode = selected.doc_code || groupsList[0]?.doc_code || '';
                    const activeGroup = groupsList.find((g) => g.doc_code === activeDocCode) || groupsList[0];
                    return (
                      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                        <div className="p-3.5 pb-2.5 space-y-2 shrink-0">
                          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-[#52525b]">
                            <span>
                              Danh sách{' '}
                              <span className="font-mono font-normal text-[#71717a]">
                                ({chunks.length}/{chunks.length})
                              </span>
                            </span>
                            <div className="inline-flex items-center rounded-[2px] border border-[#e4e4e2] bg-white p-0.5">
                              <button
                                type="button"
                                onClick={() => setSidebarViewMode('grid')}
                                title="Hiển thị dạng ô vuông"
                                className={`p-1 rounded-[2px] transition-colors ${sidebarViewMode === 'grid'
                                    ? 'bg-[#18181b] text-white'
                                    : 'text-[#71717a] hover:text-[#18181b]'
                                  }`}
                              >
                                <LayoutGrid className="size-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setSidebarViewMode('list')}
                                title="Hiển thị dạng danh sách"
                                className={`p-1 rounded-[2px] transition-colors ${sidebarViewMode === 'list'
                                    ? 'bg-[#18181b] text-white'
                                    : 'text-[#71717a] hover:text-[#18181b]'
                                  }`}
                              >
                                <List className="size-3" />
                              </button>
                            </div>
                          </div>
                          <select
                            className="w-full py-1.5 px-2 text-[11px] font-medium bg-white border border-[#e4e4e2] rounded-[3px] text-[#18181b] focus:outline-none focus:border-[#18181b]"
                            value={activeGroup?.doc_code || ''}
                            title={activeGroup?.filename || ''}
                            onChange={(e) => {
                              const target = groupsList.find((g) => g.doc_code === e.target.value);
                              if (target && target.items.length > 0) {
                                pickChunk(target.items[0]);
                              }
                            }}
                          >
                            {groupsList.map((grp) => {
                              const okCnt = grp.items.filter((c) => getChunkState(c) === 'OK').length;
                              const cleanName = (grp.filename || '').replace(new RegExp(`^${grp.doc_code}[_\\-\\s]*`, 'i'), '');
                              return (
                                <option key={grp.doc_code} value={grp.doc_code}>
                                  {grp.doc_code} ({okCnt}/{grp.items.length}) · {cleanName}
                                </option>
                              );
                            })}
                          </select>
                        </div>

                        {activeGroup && sidebarViewMode === 'grid' && (
                          <div className="flex-1 overflow-y-auto px-3.5 pb-3.5">
                            <div className="flex flex-wrap gap-[4px]">
                              {activeGroup.items.map((c) => {
                                const isSel = selected.chunk_pk === c.chunk_pk;
                                return (
                                  <button
                                    key={c.chunk_pk}
                                    type="button"
                                    onClick={() => pickChunk(c)}
                                    aria-label={`${c.doc_code} #${c.chunk_index}`}
                                    title={`${c.doc_code} · Chunk #${c.chunk_index} (${c.token_est} tok)`}
                                    className={`size-[22px] rounded-none border-0 transition-opacity cursor-pointer ${getTileClass(
                                      c,
                                      isSel
                                    )}`}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {activeGroup && sidebarViewMode === 'list' && (
                          <div className="flex-1 overflow-y-auto px-2.5 pb-2.5 space-y-1">
                            {activeGroup.items.map((c) => {
                              const isSel = selected.chunk_pk === c.chunk_pk;
                              const st = getChunkState(c);
                              const dotCls = st === 'OK' ? 'bg-[#4ea874]' : 'bg-[#d6656c]';
                              const previewTxt = (c.content || '').replace(/\s+/g, ' ').trim();
                              return (
                                <button
                                  key={c.chunk_pk}
                                  type="button"
                                  onClick={() => pickChunk(c)}
                                  className={`w-full text-left px-2.5 py-2 rounded-md border transition-colors flex items-start gap-2 ${isSel
                                      ? 'bg-white border-[#18181b] shadow-2xs'
                                      : 'bg-transparent border-transparent hover:bg-white/80 hover:border-[#e4e4e2]'
                                    }`}
                                >
                                  <span className={`size-2 rounded-full mt-1.5 shrink-0 ${dotCls}`} />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center justify-between gap-1.5">
                                      <span className="font-mono text-[11px] font-semibold text-[#18181b]">
                                        Chunk #{c.chunk_index}
                                      </span>
                                      <span className="font-mono text-[10px] text-[#71717a] tabular-nums">
                                        {c.token_est} tok
                                      </span>
                                    </div>
                                    <div className="text-[11px] text-[#52525b] truncate mt-0.5">
                                      {previewTxt || '(Trống)'}
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* 2. Pinned Scoring Controls */}
                  <div className="p-3.5 space-y-3 shrink-0 bg-white">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-[#52525b]">
                        Chấm điểm (5 tiêu chí)
                      </span>
                      {saving && <Loader2 className="size-3.5 animate-spin text-[#4ea874]" />}
                    </div>

                    <div className="flex flex-wrap gap-1.5 text-xs">
                      <MiniToggle label="Trọn ý" value={integrity} onChange={(v) => setCriterion('INTEGRITY', v)} />
                      <MiniToggle label="Đủ nghĩa" value={contextSuff} onChange={(v) => setCriterion('CONTEXT', v)} />
                      <MiniToggle label="Sạch rác" value={noNoise} onChange={(v) => setCriterion('NOISE', v)} />
                      <MiniToggle label="Không trùng" value={noDup} onChange={(v) => setCriterion('DUPLICATE', v)} />
                      <MiniToggle label="Độ dài ổn" value={validSize} onChange={(v) => setCriterion('SIZE', v)} />
                    </div>

                    <div className="space-y-1.5">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[#52525b]">
                        Mã lỗi ({errCodes.length})
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {errorCatalog.map((ec) => {
                          const active = errCodes.includes(ec.code);
                          return (
                            <button
                              key={ec.code}
                              type="button"
                              disabled={saving}
                              onClick={() => toggleCode(ec.code)}
                              title={`${ec.code} · ${ec.name} (${ec.severity})`}
                              className={`font-mono text-[10.5px] px-2 py-0.5 border transition-colors ${active
                                  ? 'bg-[#18181b] text-white border-[#18181b] font-semibold'
                                  : 'bg-white text-[#52525b] border-[#e4e4e2] hover:border-[#a1a1aa] hover:text-[#18181b]'
                                }`}
                            >
                              {ec.code}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <input
                      className="ts-input w-full py-1.5 text-xs rounded-md bg-white"
                      placeholder="Ghi chú ngắn..."
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />

                    <button
                      onClick={handleSaveScore}
                      disabled={saving}
                      className="ts-btn-primary w-full justify-center py-2 text-xs rounded-md disabled:opacity-45"
                    >
                      {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                      Lưu &amp; Tiếp (Enter)
                    </button>
                  </div>
                </aside>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const MiniToggle: React.FC<{ label: string; value: number; onChange: (v: number) => void }> = ({
  label,
  value,
  onChange,
}) => (
  <button
    type="button"
    onClick={() => onChange(value === 1 ? 0 : 1)}
    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border transition-colors ${value === 1
        ? 'bg-white text-[#18181b] border-[#e4e4e2] hover:bg-[#f4f4f2]'
        : 'bg-[#fef2f2] text-[#b91c1c] border-[#fecaca] font-medium'
      }`}
  >
    <span className={`size-1.5 inline-block ${value === 1 ? 'bg-[#2da44e]' : 'bg-[#cf222e]'}`} />
    {label}
  </button>
);
