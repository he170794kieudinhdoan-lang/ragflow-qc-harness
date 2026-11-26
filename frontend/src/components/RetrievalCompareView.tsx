import React, { useEffect, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Copy,
  ExternalLink,
  GitCompare,
  Loader2,
  Play,
  Star,
  Trophy,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { RetrievalResultGroup, RetrievalRun } from '../types';

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);
const pct1 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);

const DumbbellTrack: React.FC<{ base: number; cand: number }> = ({ base, cand }) => {
  const bPct = Math.max(0, Math.min(100, base * 100));
  const cPct = Math.max(0, Math.min(100, cand * 100));
  const left = Math.min(bPct, cPct);
  const width = Math.abs(cPct - bPct);
  const improved = cPct >= bPct;
  const changed = Math.abs(cPct - bPct) > 0.4;
  return (
    <div className="relative h-4 flex items-center w-full min-w-[90px]">
      <div className="absolute inset-x-0 h-[2px] bg-[#ecece9] rounded-full" />
      <div className="absolute left-1/2 top-1/2 -translate-y-1/2 h-2 w-px bg-[#dcdcd8]" />
      {changed && (
        <div
          className={`absolute h-[3px] rounded-full ${improved ? 'bg-[#03aa5c]' : 'bg-[#e11d48]'}`}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
      )}
      <span
        className="absolute size-2.5 rounded-full bg-white border-2 border-[#a1a1aa] -translate-x-1/2"
        style={{ left: `${bPct}%` }}
      />
      <span
        className={`absolute size-2.5 rounded-full -translate-x-1/2 ${
          !changed ? 'bg-[#18181b]' : improved ? 'bg-[#03aa5c]' : 'bg-[#e11d48]'
        }`}
        style={{ left: `${cPct}%` }}
      />
    </div>
  );
};

interface ConfigSideCardProps {
  side: 'A' | 'B';
  run: RetrievalRun | null;
  compareTo: RetrievalRun | null;
  isBaseline: boolean;
  rrList: RetrievalRun[];
  baselineId?: number;
  selectedId: number | '';
  onSelect: (id: number) => void;
  summary?: any;
  onPromoteBaseline?: (id: number) => void;
  promoting?: boolean;
}

const ConfigSideCard: React.FC<ConfigSideCardProps> = ({
  side,
  run,
  compareTo,
  isBaseline,
  rrList,
  baselineId,
  selectedId,
  onSelect,
  summary,
  onPromoteBaseline,
  promoting,
}) => {
  const isB = side === 'B';
  const vecPct = run ? Math.round(Number(run.vector_similarity_weight || 0) * 100) : 0;
  const kwPct = 100 - vecPct;
  const passCnt = summary?.per_testcase
    ? Object.values(summary.per_testcase).filter((t: any) => t.passed).length
    : null;
  const totalCnt = summary?.total_testcases ?? null;

  const isDiff = (a: any, b: any) => isB && compareTo != null && a !== b;

  const rows = run
    ? [
        {
          label: 'Top N (trả về)',
          val: `Top-${run.top_k}`,
          changed: isDiff(run.top_k, compareTo?.top_k),
        },
        {
          label: 'Ngưỡng lọc',
          val: String(run.similarity_threshold),
          changed: isDiff(run.similarity_threshold, compareTo?.similarity_threshold),
        },
        {
          label: 'Vector / Keyword',
          val: `${vecPct}% / ${kwPct}%`,
          changed: isDiff(run.vector_similarity_weight, compareTo?.vector_similarity_weight),
        },
        {
          label: 'Rerank',
          val: run.rerank_id ? 'Bật' : 'Tắt',
          title: run.rerank_id || 'Không dùng Rerank',
          changed: isDiff(Boolean(run.rerank_id), Boolean(compareTo?.rerank_id)),
        },
        {
          label: 'Bộ chấm',
          val: (run.judge_engine || 'llm').toUpperCase(),
          changed: isDiff(run.judge_engine || 'llm', compareTo?.judge_engine || 'llm'),
        },
      ]
    : [];

  return (
    <div
      className={`bg-white border rounded-xl shadow-2xs overflow-hidden xl:sticky xl:top-6 ${
        isB ? 'border-[#bbf7d0]' : 'border-[#e6e4de]'
      }`}
    >
      <div
        className={`px-4 py-3 border-b space-y-2 ${
          isB ? 'bg-[#f2fbf6]/70 border-[#dcfce7]' : 'bg-[#fafaf9] border-[#f0f0ee]'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className={`font-mono text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
              isBaseline
                ? 'bg-[#141414] text-white'
                : isB
                  ? 'bg-[#027a42] text-white'
                  : 'bg-[#52525b] text-white'
            }`}
          >
            {isBaseline ? 'GỐC · BASELINE' : isB ? 'THỬ NGHIỆM [B]' : 'SO SÁNH [A]'}
          </span>
          <span className="font-mono text-[10px] text-[#71717a]">#{run?.id ?? '—'}</span>
        </div>
        <select
          className="ts-input w-full py-1 px-2 text-xs bg-white rounded-md font-medium"
          value={selectedId}
          onChange={(e) => onSelect(Number(e.target.value))}
        >
          {rrList.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id === baselineId ? `[GỐC] ${r.name}` : r.name}
            </option>
          ))}
        </select>
      </div>

      {run && (
        <div className="p-4 space-y-3">
          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[#71717a]">
              Cấu hình tìm kiếm
            </div>
            <div className="divide-y divide-[#f4f4f2] border border-[#f0f0ee] rounded-lg overflow-hidden bg-[#fafaf9]/50">
              {rows.map((r) => (
                <div
                  key={r.label}
                  title={r.title}
                  className={`px-3 py-1.5 flex items-center justify-between gap-2 text-xs ${
                    r.changed ? 'bg-[#fffbeb]' : ''
                  }`}
                >
                  <span className="text-[#52525b]">{r.label}</span>
                  <span
                    className={`font-mono font-semibold tabular-nums ${
                      r.changed ? 'text-[#b45309]' : 'text-[#141414]'
                    }`}
                  >
                    {r.val}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {summary && (
            <div className="pt-2 border-t border-[#f0f0ee] grid grid-cols-3 gap-1.5 text-center font-mono">
              <div className="p-2 rounded-lg bg-[#fafaf9] border border-[#f0f0ee]">
                <div className="text-[9.5px] font-sans text-[#71717a]">Precision</div>
                <div className={`text-xs font-bold mt-0.5 tabular-nums ${isB ? 'text-[#027a42]' : 'text-[#141414]'}`}>
                  {pct1(summary.avg_contextual_precision)}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-[#fafaf9] border border-[#f0f0ee]">
                <div className="text-[9.5px] font-sans text-[#71717a]">Coverage</div>
                <div className="text-xs font-bold mt-0.5 text-[#141414] tabular-nums">
                  {pct1(summary.avg_context_coverage)}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-[#fafaf9] border border-[#f0f0ee]">
                <div className="text-[9.5px] font-sans text-[#71717a]">Pass</div>
                <div className="text-xs font-bold mt-0.5 text-[#141414] tabular-nums">
                  {passCnt != null && totalCnt != null ? `${passCnt}/${totalCnt}` : '—'}
                </div>
              </div>
            </div>
          )}

          {isB && !isBaseline && onPromoteBaseline && (
            <button
              type="button"
              disabled={promoting}
              onClick={() => onPromoteBaseline(run.id)}
              className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-medium border border-[#03aa5c]/40 bg-[#f2fbf6] text-[#027a42] hover:bg-[#027a42] hover:text-white transition-colors disabled:opacity-50"
              title="Chuyển cấu hình này thành Baseline gốc mới để làm mốc so sánh cho các thử nghiệm tiếp theo"
            >
              <Star className="size-3.5" />
              {promoting ? 'Đang cập nhật...' : 'Đặt làm Baseline gốc'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

interface Props {
  runId: number;
  rrList: RetrievalRun[];
  onReloadRuns: () => Promise<void>;
  onOpenNewExperiment: () => void;
  onJumpToTestcase: (rrId: number, tcCode: string) => void;
}

type TableView = 'class' | 'format' | 'all';

export const RetrievalCompareView: React.FC<Props> = ({
  runId,
  rrList,
  onReloadRuns,
  onOpenNewExperiment,
  onJumpToTestcase,
}) => {
  const [baseId, setBaseId] = useState<number | ''>('');
  const [candId, setCandId] = useState<number | ''>('');
  const [diff, setDiff] = useState<any>(null);
  const [retMatrix, setRetMatrix] = useState<any>(null);
  const [tableView, setTableView] = useState<TableView>('class');
  const [promoting, setPromoting] = useState(false);

  // Side-by-side TC detail inspector modal state
  const [inspectTc, setInspectTc] = useState<{
    tc_code: string;
    question_class: string;
    question: string;
    baseline_cp: number;
    candidate_cp: number;
    kind: 'regressed' | 'rescued';
  } | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [resultsCache, setResultsCache] = useState<Record<number, RetrievalResultGroup[]>>({});

  useEffect(() => {
    if (!inspectTc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInspectTc(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inspectTc]);

  const openTcInspector = async (
    row: any,
    kind: 'regressed' | 'rescued'
  ) => {
    setInspectTc({
      tc_code: row.tc_code,
      question_class: row.question_class,
      question: row.question,
      baseline_cp: row.baseline_cp,
      candidate_cp: row.candidate_cp,
      kind,
    });
    const bId = Number(baseId);
    const cId = Number(candId);
    const missing: number[] = [];
    if (bId && !resultsCache[bId]) missing.push(bId);
    if (cId && cId !== bId && !resultsCache[cId]) missing.push(cId);
    if (missing.length === 0) return;

    setInspectLoading(true);
    try {
      const fetched = await Promise.all(
        missing.map(async (id) => [id, await api.getRetrievalResults(id)] as const)
      );
      setResultsCache((prev) => {
        const next = { ...prev };
        for (const [id, data] of fetched) next[id] = data || [];
        return next;
      });
    } catch (e: any) {
      toast.error(e.message || 'Không tải được chi tiết kết quả câu hỏi.');
    } finally {
      setInspectLoading(false);
    }
  };

  // Explicit Baseline (is_baseline_rr === 1), falling back to oldest retrieval run
  const baselineRun =
    rrList.find((r) => Number(r.is_baseline_rr) === 1) ||
    (rrList.length > 0 ? rrList[rrList.length - 1] : null);

  const handlePromoteBaseline = async (rrId: number) => {
    setPromoting(true);
    try {
      const res = await api.setBaselineRetrievalRun(rrId);
      const prevBase = baseId;
      await onReloadRuns();
      const mat = await api.getRetrievalMatrix(runId).catch(() => null);
      if (mat) setRetMatrix(mat);
      setBaseId(rrId);
      if (prevBase && prevBase !== rrId) {
        setCandId(prevBase);
      }
      toast.success(`Đã đặt "${res.name}" làm Baseline gốc mới!`);
    } catch (e: any) {
      toast.error(e.message || 'Không thể đặt làm Baseline gốc.');
    } finally {
      setPromoting(false);
    }
  };

  useEffect(() => {
    if (rrList.length >= 2 && baselineRun) {
      setBaseId((prev) => (prev && rrList.some((r) => r.id === prev) ? prev : baselineRun.id));
      const latestExp = rrList.find((r) => r.id !== baselineRun.id) || rrList[0];
      setCandId((prev) =>
        prev && prev !== baselineRun.id && rrList.some((r) => r.id === prev) ? prev : latestExp.id
      );
    } else {
      setBaseId('');
      setCandId('');
      setDiff(null);
    }
  }, [rrList, baselineRun?.id]);

  useEffect(() => {
    setResultsCache({});
    setInspectTc(null);
  }, [runId, rrList]);

  useEffect(() => {
    let cancelled = false;
    api
      .getRetrievalMatrix(runId)
      .then((res) => {
        if (!cancelled) setRetMatrix(res);
      })
      .catch(() => {
        if (!cancelled) setRetMatrix(null);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, rrList.length]);

  useEffect(() => {
    let cancelled = false;
    if (baseId && candId && baseId !== candId) {
      api
        .compareRuns(Number(baseId), Number(candId))
        .then((res) => {
          if (!cancelled) setDiff(res);
        })
        .catch(() => {
          if (!cancelled) setDiff(null);
        });
    } else {
      setDiff(null);
    }
    return () => {
      cancelled = true;
    };
  }, [baseId, candId]);

  if (rrList.length < 2) {
    return (
      <div
        className="flex-1 flex items-center justify-center p-8"
        style={{
          backgroundColor: '#f8f7f4',
          backgroundImage: 'radial-gradient(#e4e2dc 0.8px, transparent 0.8px)',
          backgroundSize: '18px 18px',
        }}
      >
        <div className="max-w-md w-full bg-white border border-[#e6e4de] rounded-xl shadow-xs p-7 text-center space-y-4">
          <div className="size-11 rounded-full bg-[#f4f4f2] border border-[#e4e4e2] text-[#141414] flex items-center justify-center mx-auto">
            <GitCompare className="size-5" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-[#141414]">Cần ít nhất 2 lần chạy để so sánh A → B</h3>
            <p className="text-xs text-[#71717a] leading-relaxed">
              Hiện mới có <strong className="font-mono text-[#141414]">{rrList.length}</strong> lần chạy. Hãy bấm nút
              bên dưới để tạo thêm 1 thử nghiệm đổi tham số (VD: tăng <strong>Trọng số Vector</strong> hoặc bật{' '}
              <strong>Rerank</strong>).
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenNewExperiment}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-[#141414] hover:bg-[#27272a] text-white"
          >
            <Play className="size-3.5" /> Chạy thử nghiệm mới
          </button>
        </div>
      </div>
    );
  }

  const runA = rrList.find((r) => r.id === baseId) || null;
  const runB = rrList.find((r) => r.id === candId) || null;
  const bSum = diff?.baseline?.summary;
  const cSum = diff?.candidate?.summary;
  const deltaCp = bSum && cSum ? cSum.avg_contextual_precision - bSum.avg_contextual_precision : 0;
  const deltaCc = bSum && cSum ? cSum.avg_context_coverage - bSum.avg_context_coverage : 0;

  const activeMapBase = tableView === 'class' ? bSum?.by_class || {} : bSum?.by_format || {};
  const activeMapCand = tableView === 'class' ? cSum?.by_class || {} : cSum?.by_format || {};
  const activeKeys = Array.from(new Set([...Object.keys(activeMapBase), ...Object.keys(activeMapCand)]));

  return (
    <div
      className="flex-1 overflow-y-auto"
      style={{
        backgroundColor: '#f8f7f4',
        backgroundImage: 'radial-gradient(#e4e2dc 0.8px, transparent 0.8px)',
        backgroundSize: '18px 18px',
      }}
    >
      <div className="max-w-[1440px] mx-auto px-5 py-6 grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* LEFT RAIL: [A] Baseline Config Card */}
        <div className="xl:col-span-3">
          <ConfigSideCard
            side="A"
            run={runA}
            compareTo={runB}
            isBaseline={Boolean(runA && baselineRun && runA.id === baselineRun.id)}
            rrList={rrList}
            baselineId={baselineRun?.id}
            selectedId={baseId}
            onSelect={setBaseId}
            summary={bSum}
          />
        </div>

        {/* CENTER COLUMN: Focused A -> B Comparison */}
        <div className="xl:col-span-6 space-y-5 min-w-0">
          {baseId === candId ? (
            <div className="bg-white border border-[#e6e4de] rounded-xl p-8 text-center text-xs text-amber-700 font-medium shadow-2xs">
              Đang chọn trùng 1 lần chạy ở cả 2 bên — hãy chọn 1 thử nghiệm khác ở cột bên phải để so sánh.
            </div>
          ) : diff ? (
            <>
              {/* 3 Focused KPIs */}
              <div className="bg-white border border-[#e6e4de] rounded-xl shadow-2xs overflow-hidden grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[#f0f0ee]">
                <div className="p-4 space-y-1">
                  <div className="ts-eyebrow">PRECISION (XẾP HẠNG)</div>
                  <div className="flex items-baseline gap-1.5 font-mono tabular-nums flex-wrap">
                    <span className="text-sm text-[#a1a1aa]">{pct1(bSum.avg_contextual_precision)}</span>
                    <span className="text-[#d4d4d8]">→</span>
                    <span className="text-2xl font-bold text-[#141414]">{pct1(cSum.avg_contextual_precision)}</span>
                    <span
                      className={`text-[11px] font-medium px-1.5 py-0.5 rounded-full ${
                        deltaCp >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                      }`}
                    >
                      {deltaCp >= 0 ? `+${pct1(deltaCp)}` : pct1(deltaCp)}
                    </span>
                  </div>
                </div>

                <div className="p-4 space-y-1">
                  <div className="ts-eyebrow">COVERAGE (ĐỘ PHỦ)</div>
                  <div className="flex items-baseline gap-1.5 font-mono tabular-nums flex-wrap">
                    <span className="text-sm text-[#a1a1aa]">{pct1(bSum.avg_context_coverage)}</span>
                    <span className="text-[#d4d4d8]">→</span>
                    <span className="text-2xl font-bold text-[#141414]">{pct1(cSum.avg_context_coverage)}</span>
                    <span
                      className={`text-[11px] font-medium px-1.5 py-0.5 rounded-full ${
                        deltaCc >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                      }`}
                    >
                      {deltaCc >= 0 ? `+${pct1(deltaCc)}` : pct1(deltaCc)}
                    </span>
                  </div>
                </div>

                <div className="p-4 space-y-1">
                  <div className="ts-eyebrow">BIẾN ĐỘNG CÂU HỎI</div>
                  <div className="flex items-center gap-3 pt-0.5 font-mono tabular-nums">
                    <span className="inline-flex items-center gap-1 text-emerald-700 font-bold text-xl">
                      <ArrowUpRight className="size-4" />
                      {diff.improvements_fail_to_pass.length}
                      <span className="text-[11px] font-sans font-normal text-[#71717a]">cứu</span>
                    </span>
                    <span className="inline-flex items-center gap-1 text-rose-600 font-bold text-xl">
                      <ArrowDownRight className="size-4" />
                      {diff.regressions_pass_to_fail.length}
                      <span className="text-[11px] font-sans font-normal text-[#71717a]">tụt</span>
                    </span>
                  </div>
                </div>
              </div>

              {/* Single Focused Switchable Breakdown Card */}
              <div className="bg-white border border-[#e6e4de] rounded-xl shadow-2xs overflow-hidden">
                <div className="px-4 py-3 border-b border-[#f0f0ee] flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex items-center p-0.5 rounded-md bg-[#f4f4f2] border border-[#e4e4e2] text-xs">
                    {(
                      [
                        { id: 'class', label: 'Theo loại câu hỏi' },
                        { id: 'format', label: 'Theo định dạng file' },
                        { id: 'all', label: `Tất cả lần chạy (${retMatrix?.experiments?.length || rrList.length})` },
                      ] as const
                    ).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setTableView(t.id)}
                        className={`px-2.5 py-1 rounded-[4px] transition-colors ${
                          tableView === t.id
                            ? 'bg-white text-[#141414] font-semibold shadow-2xs'
                            : 'text-[#71717a] hover:text-[#141414]'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  {tableView === 'all' && retMatrix?.markdown_report && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(retMatrix.markdown_report);
                          toast.success('Đã sao chép bảng so sánh Markdown!');
                        } catch {
                          toast.error('Không sao chép được.');
                        }
                      }}
                      className="ts-btn-secondary text-xs py-1 px-2.5 rounded-md"
                    >
                      <Copy className="size-3.5" /> Copy Markdown
                    </button>
                  )}
                </div>

                {tableView !== 'all' ? (
                  <div className="p-5 space-y-3">
                    {activeKeys.map((k) => {
                      const bm = activeMapBase[k];
                      const cm = activeMapCand[k];
                      const bCp = bm?.avg_cp ?? 0;
                      const cCp = cm?.avg_cp ?? 0;
                      const dCp = cCp - bCp;
                      return (
                        <div key={k} className="grid grid-cols-12 items-center gap-3 text-xs">
                          <div className="col-span-3 flex items-center gap-1.5 min-w-0">
                            <span className="font-mono font-semibold text-[#141414] truncate">{k}</span>
                            <span className="font-mono text-[10.5px] text-[#a1a1aa]">
                              ({cm?.count ?? bm?.count ?? 0})
                            </span>
                          </div>
                          <div className="col-span-5">
                            <DumbbellTrack base={bCp} cand={cCp} />
                          </div>
                          <div className="col-span-4 text-right font-mono tabular-nums whitespace-nowrap">
                            <span className="text-[#a1a1aa]">{pct(bCp)}</span>
                            <span className="text-[#d4d4d8] mx-1">→</span>
                            <strong className="text-[#141414]">{pct(cCp)}</strong>
                            <span
                              className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                                dCp > 0.001
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : dCp < -0.001
                                    ? 'bg-rose-50 text-rose-700'
                                    : 'bg-[#f4f4f2] text-[#71717a]'
                              }`}
                            >
                              {dCp >= 0 ? `+${pct(dCp)}` : pct(dCp)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-[#e8e8e6] bg-[#fafaf9] font-mono text-[10px] uppercase tracking-wider text-[#52525b]">
                          <th className="py-2.5 px-3">Lần chạy</th>
                          <th className="py-2.5 px-2.5">Tham số</th>
                          <th className="py-2.5 px-2 text-right">Pass</th>
                          <th className="py-2.5 px-3 text-right">Precision (Δ)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#f0f0ee]">
                        {(() => {
                          const exps: any[] = retMatrix?.experiments || [];
                          const bestCp = exps.length
                            ? Math.max(...exps.map((e) => Number(e.avg_contextual_precision || 0)))
                            : 0;
                          return exps.map((ex, i) => {
                            const isBest =
                              exps.length > 1 && Number(ex.avg_contextual_precision || 0) >= bestCp - 0.0001;
                            const d = Number(ex.delta_cp_vs_first || 0);
                            return (
                              <tr key={ex.id} className={isBest ? 'bg-[#f2fbf6]/50' : 'hover:bg-[#fafaf9]'}>
                                <td className="py-2.5 px-3 font-medium text-[#141414]">
                                  <div className="flex items-center gap-1.5">
                                    {isBest && <Trophy className="size-3.5 text-[#03aa5c] shrink-0" />}
                                    <span className="truncate max-w-[150px]">{ex.name}</span>
                                    {ex.is_baseline_rr && (
                                      <span className="font-mono text-[9px] px-1 py-0.2 rounded bg-[#141414] text-white shrink-0">
                                        GỐC
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="py-2.5 px-2.5 font-mono text-[10.5px] text-[#52525b] whitespace-nowrap">
                                  N={ex.top_k} · th={ex.similarity_threshold} · vec={ex.vector_similarity_weight}{' '}
                                  {ex.rerank_id ? '· rerank' : ''}
                                </td>
                                <td className="py-2.5 px-2 text-right font-mono tabular-nums text-[#3f3f46]">
                                  {ex.pass_count}/{ex.total_testcases}
                                </td>
                                <td className="py-2.5 px-3 text-right font-mono font-bold tabular-nums text-[#141414] whitespace-nowrap">
                                  {pct1(ex.avg_contextual_precision)}
                                  {!ex.is_baseline_rr && (
                                    <span
                                      className={`ml-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                                        d > 0.001
                                          ? 'bg-emerald-50 text-emerald-700'
                                          : d < -0.001
                                            ? 'bg-rose-50 text-rose-700'
                                            : 'bg-[#f4f4f2] text-[#71717a]'
                                      }`}
                                    >
                                      {d >= 0 ? `+${pct1(d)}` : pct1(d)}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          });
                        })()}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Flipped Testcases */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white border border-[#e6e4de] rounded-xl shadow-2xs overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-[#f0f0ee] bg-[#fef2f2]/55 flex items-center justify-between">
                    <span className="ts-eyebrow text-rose-700">PASS → FAIL (TỤT HẠNG)</span>
                    <span className="font-mono text-xs font-semibold text-rose-700">
                      {diff.regressions_pass_to_fail.length}
                    </span>
                  </div>
                  <div className="divide-y divide-[#f4f4f2] max-h-[280px] overflow-y-auto">
                    {diff.regressions_pass_to_fail.length === 0 ? (
                      <div className="p-6 text-center text-xs text-[#71717a]">Không có câu nào bị tụt hạng.</div>
                    ) : (
                      diff.regressions_pass_to_fail.map((r: any) => (
                        <button
                          key={r.tc_code}
                          type="button"
                          onClick={() => openTcInspector(r, 'regressed')}
                          className="w-full text-left px-4 py-2.5 text-xs space-y-1 hover:bg-[#fafaf9] transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono font-semibold text-[#141414]">
                              {r.tc_code} · <span className="text-[#71717a] font-normal">{r.question_class}</span>
                            </span>
                            <span className="font-mono text-rose-600 tabular-nums">
                              {pct(r.baseline_cp)} → {pct(r.candidate_cp)}
                            </span>
                          </div>
                          <div className="text-[#3f3f46] line-clamp-1">{r.question}</div>
                        </button>
                      ))
                    )}
                  </div>
                </div>

                <div className="bg-white border border-[#e6e4de] rounded-xl shadow-2xs overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-[#f0f0ee] bg-[#f2fbf6]/55 flex items-center justify-between">
                    <span className="ts-eyebrow text-emerald-700">FAIL → PASS (ĐƯỢC CỨU)</span>
                    <span className="font-mono text-xs font-semibold text-emerald-700">
                      {diff.improvements_fail_to_pass.length}
                    </span>
                  </div>
                  <div className="divide-y divide-[#f4f4f2] max-h-[280px] overflow-y-auto">
                    {diff.improvements_fail_to_pass.length === 0 ? (
                      <div className="p-6 text-center text-xs text-[#71717a]">Chưa có câu mới nào được cứu.</div>
                    ) : (
                      diff.improvements_fail_to_pass.map((r: any) => (
                        <button
                          key={r.tc_code}
                          type="button"
                          onClick={() => openTcInspector(r, 'rescued')}
                          className="w-full text-left px-4 py-2.5 text-xs space-y-1 hover:bg-[#fafaf9] transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono font-semibold text-[#141414]">
                              {r.tc_code} · <span className="text-[#71717a] font-normal">{r.question_class}</span>
                            </span>
                            <span className="font-mono text-emerald-700 tabular-nums">
                              {pct(r.baseline_cp)} → {pct(r.candidate_cp)}
                            </span>
                          </div>
                          <div className="text-[#3f3f46] line-clamp-1">{r.question}</div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>

        {/* RIGHT RAIL: [B] Candidate Experiment Config Card */}
        <div className="xl:col-span-3">
          <ConfigSideCard
            side="B"
            run={runB}
            compareTo={runA}
            isBaseline={Boolean(runB && baselineRun && runB.id === baselineRun.id)}
            rrList={rrList}
            baselineId={baselineRun?.id}
            selectedId={candId}
            onSelect={setCandId}
            summary={cSum}
            onPromoteBaseline={handlePromoteBaseline}
            promoting={promoting}
          />
        </div>
      </div>

      {/* Side-by-Side Testcase Detail Modal */}
      {inspectTc && (() => {
        const bGroup = (resultsCache[Number(baseId)] || []).find(
          (g) => g.testcase.tc_code === inspectTc.tc_code
        );
        const cGroup = (resultsCache[Number(candId)] || []).find(
          (g) => g.testcase.tc_code === inspectTc.tc_code
        );
        const tcMeta = cGroup?.testcase || bGroup?.testcase;

        const renderHitsCol = (
          label: string,
          runName: string,
          group: RetrievalResultGroup | undefined,
          accent: 'base' | 'cand'
        ) => (
          <div className="flex flex-col min-h-0 border border-[#e5e5e5] rounded-lg bg-white overflow-hidden">
            <div
              className={`px-3.5 py-2.5 border-b border-[#ececea] flex items-center justify-between gap-2 ${
                accent === 'cand' ? 'bg-[#ecfdf5]/70' : 'bg-[#fafaf9]'
              }`}
            >
              <div className="min-w-0">
                <span
                  className={`font-mono text-[10px] font-bold px-1.5 py-0.5 rounded ${
                    accent === 'cand' ? 'bg-[#03aa5c] text-white' : 'bg-[#161616] text-white'
                  }`}
                >
                  {label}
                </span>
                <span className="ml-2 text-xs font-semibold text-[#161616] truncate">{runName}</span>
              </div>
              {group && (
                <span className="font-mono text-xs font-bold text-[#161616] shrink-0">
                  {pct(group.contextual_precision)} ({group.relevant_count}/{group.hits.length} đạt)
                </span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-[#f1f1ef] max-h-[420px]">
              {!group || group.hits.length === 0 ? (
                <div className="p-5 text-center text-xs text-[#71717a]">Không có chunk trả về.</div>
              ) : (
                group.hits.map((h) => (
                  <div
                    key={h.id}
                    className={`p-3 space-y-1.5 text-xs ${
                      h.relevant === 1 ? 'bg-[#f2fbf6]/45' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono text-[11px] font-bold text-[#161616]">#{h.rank}</span>
                        {h.relevant === 1 ? (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <CheckCircle2 className="size-3" /> Đạt
                          </span>
                        ) : h.relevant === 0 ? (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">
                            <XCircle className="size-3" /> Không đạt
                          </span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#f4f4f2] text-[#71717a]">Chưa chấm</span>
                        )}
                        <span className="font-mono text-[10.5px] text-[#52525b] truncate">{h.doc_name}</span>
                      </div>
                      <span className="font-mono text-[10.5px] text-[#71717a] shrink-0">
                        sim {(h.similarity * 100).toFixed(0)}%
                      </span>
                    </div>
                    {h.reason && (
                      <div className="text-[11px] text-[#027a42] bg-[#fafaf9] border border-[#ececea] rounded px-2 py-1">
                        {h.reason}
                      </div>
                    )}
                    <div className="text-[11.5px] text-[#3f3f46] whitespace-pre-wrap leading-relaxed line-clamp-4">
                      {h.content}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        );

        return (
          <div
            className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-3 sm:p-5"
            onClick={() => setInspectTc(null)}
          >
            <div
              className="w-[92vw] max-w-[1260px] max-h-[90vh] bg-[#f7f7f5] border border-[#d8d8d4] rounded-lg shadow-xl flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div className="px-5 py-3.5 bg-white border-b border-[#e4e4e0] flex items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-[#161616] text-white">
                    {inspectTc.tc_code}
                  </span>
                  <span className="font-mono text-xs text-[#71717a]">{inspectTc.question_class}</span>
                  <span
                    className={`font-mono text-xs font-semibold px-2 py-0.5 rounded ${
                      inspectTc.kind === 'rescued'
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-rose-50 text-rose-700'
                    }`}
                  >
                    {pct(inspectTc.baseline_cp)} → {pct(inspectTc.candidate_cp)}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {candId && (
                    <button
                      type="button"
                      onClick={() => {
                        const code = inspectTc.tc_code;
                        setInspectTc(null);
                        onJumpToTestcase(Number(candId), code);
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-[#dedede] rounded bg-white hover:border-[#161616] text-[#161616]"
                    >
                      <ExternalLink className="size-3.5" /> Mở ở tab Kết quả
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setInspectTc(null)}
                    className="p-1.5 rounded hover:bg-[#ededeb] text-[#71717a] hover:text-[#161616]"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </div>

              {/* Modal Content */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {/* Question & Ground Truth */}
                <div className="p-4 rounded-lg border border-[#e4e4e0] bg-white space-y-2.5">
                  <div>
                    <div className="font-mono text-[10px] uppercase text-[#71717a]">CÂU HỎI KIỂM THỬ</div>
                    <div className="text-[14px] font-semibold text-[#161616] mt-0.5">
                      {tcMeta?.input_question || inspectTc.question}
                    </div>
                  </div>
                  {tcMeta?.expected_outcome && (
                    <div className="p-2.5 rounded bg-[#ecfdf5]/60 border border-[#bbf7d0] text-xs text-[#161616]">
                      <span className="font-mono text-[10px] font-bold text-[#027a42] uppercase mr-2">
                        ĐÁP ÁN KỲ VỌNG:
                      </span>
                      {tcMeta.expected_outcome}
                    </div>
                  )}
                  {tcMeta?.reference_context && (
                    <details className="text-xs">
                      <summary className="cursor-pointer font-mono text-[10.5px] text-[#52525b] hover:text-[#161616]">
                        Xem căn cứ gốc ({tcMeta.source_file || 'tài liệu nguồn'})
                      </summary>
                      <div className="mt-2 p-2.5 rounded bg-[#fafaf9] border border-[#ececea] text-[11.5px] text-[#3f3f46] whitespace-pre-wrap max-h-40 overflow-y-auto">
                        {tcMeta.reference_context}
                      </div>
                    </details>
                  )}
                </div>

                {/* Side-by-Side Hits */}
                {inspectLoading ? (
                  <div className="py-12 flex items-center justify-center gap-2 text-xs text-[#71717a]">
                    <Loader2 className="size-4 animate-spin text-[#03aa5c]" /> Đang tải Top-K hits của [A] và [B]...
                  </div>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {renderHitsCol('GỐC [A]', runA?.name || 'Baseline', bGroup, 'base')}
                    {renderHitsCol('THỬ NGHIỆM [B]', runB?.name || 'Thử nghiệm', cGroup, 'cand')}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
