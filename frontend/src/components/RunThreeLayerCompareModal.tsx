import React, { useEffect, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  FileSearch,
  Layers,
  Loader2,
  Search,
  Star,
  TrendingUp,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';

interface Props {
  baselineRunId: number;
  candidateRunId: number;
  onClose: () => void;
  onPromoted: (newBaselineId: number) => void;
}

function fmtPct(v?: number) {
  return `${Math.round((v || 0) * 1000) / 10}%`;
}

function DeltaPill({ delta, invert = false }: { delta: number; invert?: boolean }) {
  const pct = Math.round(delta * 1000) / 10;
  if (Math.abs(pct) < 0.1) {
    return <span className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-[#f4f4f2] text-[#71717a]">0.0%</span>;
  }
  const good = invert ? pct < 0 : pct > 0;
  return (
    <span
      className={`font-mono text-[10.5px] font-semibold px-1.5 py-0.5 rounded ${
        good ? 'bg-[#ecfdf5] text-[#027a42]' : 'bg-[#fef2f2] text-[#dc2626]'
      }`}
    >
      {pct > 0 ? '+' : ''}
      {pct}%
    </span>
  );
}

function MetricRow({
  label,
  baseVal,
  candVal,
  invert = false,
}: {
  label: string;
  baseVal?: number;
  candVal?: number;
  invert?: boolean;
}) {
  const b = baseVal || 0;
  const c = candVal || 0;
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-[#f4f4f2] last:border-0 text-[12px]">
      <span className="text-[#52525b]">{label}</span>
      <div className="flex items-center gap-2 font-mono">
        <span className="text-[#a1a1aa]">{fmtPct(b)}</span>
        <span className="text-[#d4d4d8]">→</span>
        <span className="font-semibold text-[#161616] w-[46px] text-right">{fmtPct(c)}</span>
        <div className="w-[54px] text-right">
          <DeltaPill delta={c - b} invert={invert} />
        </div>
      </div>
    </div>
  );
}

function DumbbellRow({
  label,
  count,
  baseVal,
  candVal,
}: {
  label: string;
  count: number;
  baseVal: number;
  candVal: number;
}) {
  const bPct = Math.max(0, Math.min(100, Math.round(baseVal * 100)));
  const cPct = Math.max(0, Math.min(100, Math.round(candVal * 100)));
  const left = Math.min(bPct, cPct);
  const width = Math.max(0, Math.abs(cPct - bPct));
  const improved = cPct >= bPct;

  return (
    <div className="grid grid-cols-[120px_1fr_135px] items-center gap-3 py-1.5">
      <div className="text-[12px] font-medium text-[#161616] truncate">
        {label} <span className="font-mono text-[10.5px] text-[#a1a1aa]">({count})</span>
      </div>
      <div className="relative h-4 flex items-center">
        <div className="w-full h-[2px] bg-[#ececea] rounded-full" />
        <div
          className={`absolute h-[3px] rounded-full ${improved ? 'bg-[#03aa5c]' : 'bg-[#ef4444]'}`}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
        <span
          className="absolute size-2.5 rounded-full bg-white border-2 border-[#71717a] -translate-x-1/2"
          style={{ left: `${bPct}%` }}
          title={`Baseline: ${bPct}%`}
        />
        <span
          className={`absolute size-2.5 rounded-full -translate-x-1/2 ${
            improved ? 'bg-[#03aa5c]' : 'bg-[#ef4444]'
          }`}
          style={{ left: `${cPct}%` }}
          title={`Thí nghiệm [B]: ${cPct}%`}
        />
      </div>
      <div className="flex items-center justify-end gap-1.5 font-mono text-[11px]">
        <span className="text-[#a1a1aa]">{bPct}%→</span>
        <span className="font-semibold text-[#161616]">{cPct}%</span>
        <DeltaPill delta={candVal - baseVal} />
      </div>
    </div>
  );
}

export const RunThreeLayerCompareModal: React.FC<Props> = ({
  baselineRunId,
  candidateRunId,
  onClose,
  onPromoted,
}) => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [promoting, setPromoting] = useState(false);
  const [chartTab, setChartTab] = useState<'class' | 'format'>('class');
  const [tcFilter, setTcFilter] = useState<'changed' | 'rescued' | 'regressed' | 'all'>('changed');

  useEffect(() => {
    setLoading(true);
    api
      .compareTwoRunsFull(baselineRunId, candidateRunId)
      .then(setData)
      .catch((e) => toast.error(e.message || 'Không tải được dữ liệu so sánh'))
      .finally(() => setLoading(false));
  }, [baselineRunId, candidateRunId]);

  const handlePromote = async () => {
    if (!window.confirm('Đặt nhánh [B] làm Baseline gốc mới cho toàn bộ không gian làm việc?')) return;
    setPromoting(true);
    try {
      await api.promoteRunBaseline(candidateRunId);
      toast.success('Đã thăng nhánh [B] làm Baseline gốc mới!');
      onPromoted(candidateRunId);
    } catch (e: any) {
      toast.error(e.message || 'Thăng Baseline thất bại');
    } finally {
      setPromoting(false);
    }
  };

  const allTcs: any[] = data?.tc_changes || [];
  const rescued = allTcs.filter((t) => t.status === 'rescued');
  const regressed = allTcs.filter((t) => t.status === 'regressed');
  const improved = allTcs.filter((t) => t.status === 'improved');
  const worsened = allTcs.filter((t) => t.status === 'worsened');

  const visibleTcs = allTcs.filter((t) => {
    if (tcFilter === 'rescued') return t.status === 'rescued';
    if (tcFilter === 'regressed') return t.status === 'regressed';
    if (tcFilter === 'changed') return t.status !== 'unchanged';
    return true;
  });

  const baseByClass = data?.baseline?.retrieval?.by_class || {};
  const candByClass = data?.candidate?.retrieval?.by_class || {};
  const classKeys = Array.from(new Set([...Object.keys(baseByClass), ...Object.keys(candByClass)]));

  const baseByFormat = data?.baseline?.retrieval?.by_format || {};
  const candByFormat = data?.candidate?.retrieval?.by_format || {};
  const formatKeys = Array.from(new Set([...Object.keys(baseByFormat), ...Object.keys(candByFormat)]));

  return (
    <div className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-3 sm:p-5">
      <div className="w-[93vw] h-[90vh] max-w-[1320px] bg-[#f7f7f5] border border-[#d8d8d4] rounded-[8px] shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-3.5 border-b border-[#e4e4e0] flex items-center justify-between bg-white shrink-0">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-[#027a42] font-semibold">
              BÁO CÁO ĐỐI CHIẾU TOÀN LUỒNG 3 TẦNG · PARSING · CHUNKING · RETRIEVAL
            </div>
            <h2 className="text-[16px] font-semibold text-[#161616] mt-0.5 flex items-center gap-2">
              <span>{data ? data.baseline.name : '...'}</span>
              <span className="text-[#a1a1aa] font-normal">→</span>
              <span className="text-[#027a42]">{data ? data.candidate.name : '...'}</span>
            </h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[#ededeb] text-[#71717a]">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div style={{ contain: 'layout style' }} className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading || !data ? (
            <div className="py-24 flex items-center justify-center gap-2 text-[13px] text-[#71717a]">
              <Loader2 className="size-5 animate-spin text-[#03aa5c]" /> Đang tổng hợp báo cáo chi tiết 3 tầng...
            </div>
          ) : (
            <>
              {/* Executive Verdict Summary Strip */}
              <div className="p-4 rounded-[6px] border border-[#bbf7d0] bg-[#ecfdf5]/70 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-start gap-2.5">
                  <TrendingUp className="size-4 text-[#027a42] shrink-0 mt-0.5" />
                  <div className="text-[12.5px] text-[#161616] leading-relaxed">
                    <strong>Tổng kết đối chiếu:</strong> Retrieval{' '}
                    <span className="font-mono font-semibold text-[#027a42]">
                      {fmtPct(data.baseline.retrieval.avg_contextual_precision)} →{' '}
                      {fmtPct(data.candidate.retrieval.avg_contextual_precision)}
                    </span>{' '}
                    (Pass{' '}
                    <span className="font-mono font-semibold">
                      {data.baseline.retrieval.pass_count} → {data.candidate.retrieval.pass_count}/
                      {data.candidate.retrieval.total_testcases}
                    </span>
                    , cứu <strong>{rescued.length}</strong> câu, tụt hạng <strong>{regressed.length}</strong> câu).
                    Kho chunk:{' '}
                    <span className="font-mono">
                      {data.baseline.chunk_count ?? 0} → {data.candidate.chunk_count ?? 0} chunks
                    </span>{' '}
                    trên {data.candidate.doc_count ?? 20} tài liệu.
                  </div>
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px] shrink-0">
                  <span className="px-2 py-1 rounded bg-white border border-[#bbf7d0] text-[#027a42]">
                    +{rescued.length} cứu
                  </span>
                  <span className="px-2 py-1 rounded bg-white border border-[#d1fae5] text-[#047857]">
                    ↑{improved.length} tăng điểm
                  </span>
                  <span className="px-2 py-1 rounded bg-white border border-[#fecaca] text-[#dc2626]">
                    -{regressed.length} tụt hạng
                  </span>
                </div>
              </div>

              {/* 3-Layer Detailed Breakdown Cards */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Layer 1: Parsing */}
                <div className="p-4 rounded-[6px] border border-[#e4e4e0] bg-white flex flex-col">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#f0f0ee]">
                    <span className="font-mono text-[11px] font-semibold text-[#161616] flex items-center gap-1.5">
                      <FileSearch className="size-3.5 text-[#03aa5c]" /> TẦNG 1 · PARSING
                    </span>
                    <span className="font-mono text-[10px] text-[#71717a]">
                      {data.baseline.parsing.rated_units ?? 0} → {data.candidate.parsing.rated_units ?? 0} units
                    </span>
                  </div>
                  <MetricRow
                    label="Đọc đủ chữ (Text)"
                    baseVal={data.baseline.parsing.text_completeness}
                    candVal={data.candidate.parsing.text_completeness}
                  />
                  <MetricRow
                    label="Chính xác bảng biểu"
                    baseVal={data.baseline.parsing.table_accuracy}
                    candVal={data.candidate.parsing.table_accuracy}
                  />
                  <MetricRow
                    label="Thứ tự đọc (Reading Order)"
                    baseVal={data.baseline.parsing.reading_order_accuracy}
                    candVal={data.candidate.parsing.reading_order_accuracy}
                  />
                </div>

                {/* Layer 2: Chunking */}
                <div className="p-4 rounded-[6px] border border-[#e4e4e0] bg-white flex flex-col">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#f0f0ee]">
                    <span className="font-mono text-[11px] font-semibold text-[#161616] flex items-center gap-1.5">
                      <Layers className="size-3.5 text-[#03aa5c]" /> TẦNG 2 · CHUNKING
                    </span>
                    <span className="font-mono text-[10px] text-[#71717a]">
                      Mẫu {data.baseline.chunking.sampled_total ?? 0} → {data.candidate.chunking.sampled_total ?? 0}
                    </span>
                  </div>
                  <MetricRow
                    label="Tính toàn vẹn (Integrity)"
                    baseVal={data.baseline.chunking.chunk_integrity}
                    candVal={data.candidate.chunking.chunk_integrity}
                  />
                  <MetricRow
                    label="Đủ ngữ cảnh (Sufficiency)"
                    baseVal={data.baseline.chunking.context_sufficiency}
                    candVal={data.candidate.chunking.context_sufficiency}
                  />
                  <MetricRow
                    label="Tỷ lệ nhiễu (thấp hơn tốt)"
                    baseVal={data.baseline.chunking.noise_rate}
                    candVal={data.candidate.chunking.noise_rate}
                    invert
                  />
                  <MetricRow
                    label="Đúng kích thước chuẩn"
                    baseVal={data.baseline.chunking.valid_size_rate}
                    candVal={data.candidate.chunking.valid_size_rate}
                  />
                </div>

                {/* Layer 3: Retrieval */}
                <div className="p-4 rounded-[6px] border border-[#03aa5c]/50 bg-white flex flex-col">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#f0f0ee]">
                    <span className="font-mono text-[11px] font-semibold text-[#027a42] flex items-center gap-1.5">
                      <Search className="size-3.5 text-[#03aa5c]" /> TẦNG 3 · RETRIEVAL
                    </span>
                    <span className="font-mono text-[10px] text-[#027a42]">
                      {data.candidate.retrieval.total_testcases} câu Golden
                    </span>
                  </div>
                  <MetricRow
                    label="Precision (Xếp hạng)"
                    baseVal={data.baseline.retrieval.avg_contextual_precision}
                    candVal={data.candidate.retrieval.avg_contextual_precision}
                  />
                  <MetricRow
                    label="Coverage (Độ phủ)"
                    baseVal={data.baseline.retrieval.avg_context_coverage}
                    candVal={data.candidate.retrieval.avg_context_coverage}
                  />
                  <MetricRow
                    label="Tỷ lệ Pass"
                    baseVal={data.baseline.retrieval.pass_rate}
                    candVal={data.candidate.retrieval.pass_rate}
                  />
                  <div className="mt-auto pt-2 flex items-center justify-between text-[11px] font-mono text-[#71717a]">
                    <span>
                      Rerank: {data.baseline.retrieval.rerank_id ? 'Bật' : 'Tắt'} →{' '}
                      <strong className="text-[#161616]">
                        {data.candidate.retrieval.rerank_id ? 'Bật' : 'Tắt'}
                      </strong>
                    </span>
                    <span>
                      Vec: {Math.round((data.baseline.retrieval.vector_similarity_weight ?? 0.3) * 100)}% →{' '}
                      {Math.round((data.candidate.retrieval.vector_similarity_weight ?? 0.3) * 100)}%
                    </span>
                  </div>
                </div>
              </div>

              {/* Bottom 2-Column Analytical Split: Dumbbell Chart + Full 48-TC Diff Table */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                {/* Left 5 cols: Dumbbell breakdown by Question Class / File Format */}
                <div className="lg:col-span-5 p-4 rounded-[6px] border border-[#e4e4e0] bg-white space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="inline-flex bg-[#f4f4f2] p-0.5 rounded-[4px] border border-[#e5e5e5] text-[11px]">
                      <button
                        type="button"
                        onClick={() => setChartTab('class')}
                        className={`px-2.5 py-1 rounded-[3px] font-medium ${
                          chartTab === 'class' ? 'bg-white text-[#161616] shadow-sm' : 'text-[#71717a]'
                        }`}
                      >
                        Theo loại câu hỏi
                      </button>
                      <button
                        type="button"
                        onClick={() => setChartTab('format')}
                        className={`px-2.5 py-1 rounded-[3px] font-medium ${
                          chartTab === 'format' ? 'bg-white text-[#161616] shadow-sm' : 'text-[#71717a]'
                        }`}
                      >
                        Theo định dạng file
                      </button>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-mono text-[#71717a]">
                      <span className="inline-flex items-center gap-1">
                        <span className="size-2 rounded-full border border-[#71717a] inline-block" /> [A]
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="size-2 rounded-full bg-[#03aa5c] inline-block" /> [B]
                      </span>
                    </div>
                  </div>

                  <div className="divide-y divide-[#f4f4f2]">
                    {chartTab === 'class'
                      ? classKeys.map((k) => (
                          <DumbbellRow
                            key={k}
                            label={k}
                            count={candByClass[k]?.count ?? baseByClass[k]?.count ?? 0}
                            baseVal={baseByClass[k]?.avg_cp ?? 0}
                            candVal={candByClass[k]?.avg_cp ?? 0}
                          />
                        ))
                      : formatKeys.map((k) => (
                          <DumbbellRow
                            key={k}
                            label={k}
                            count={candByFormat[k]?.count ?? baseByFormat[k]?.count ?? 0}
                            baseVal={baseByFormat[k]?.avg_cp ?? 0}
                            candVal={candByFormat[k]?.avg_cp ?? 0}
                          />
                        ))}
                  </div>
                </div>

                {/* Right 7 cols: Full Filterable Testcase Changes Table */}
                <div className="lg:col-span-7 rounded-[6px] border border-[#e4e4e0] bg-white overflow-hidden flex flex-col">
                  <div className="px-4 py-2.5 bg-[#fafaf9] border-b border-[#ececea] flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-[11px] font-semibold text-[#161616]">
                      CHI TIẾT BIẾN ĐỘNG TỪNG CÂU HỎI ({visibleTcs.length}/{allTcs.length})
                    </span>
                    <div className="inline-flex rounded border border-[#dedede] overflow-hidden text-[11px]">
                      {(
                        [
                          ['changed', `Có đổi (${rescued.length + regressed.length + improved.length + worsened.length})`],
                          ['rescued', `Cứu (${rescued.length})`],
                          ['regressed', `Tụt (${regressed.length})`],
                          ['all', `Tất cả (${allTcs.length})`],
                        ] as const
                      ).map(([id, lbl]) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setTcFilter(id)}
                          className={`px-2 py-0.5 font-medium border-r last:border-r-0 border-[#dedede] ${
                            tcFilter === id ? 'bg-[#161616] text-white' : 'bg-white text-[#52525b] hover:bg-[#f4f4f2]'
                          }`}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="divide-y divide-[#f1f1ef] max-h-[280px] overflow-y-auto">
                    {visibleTcs.length === 0 ? (
                      <div className="p-6 text-center text-[12px] text-[#71717a] flex items-center justify-center gap-1.5">
                        <CheckCircle2 className="size-4 text-[#03aa5c]" /> Không có câu hỏi nào trong nhóm lọc này.
                      </div>
                    ) : (
                      visibleTcs.map((t) => (
                        <div key={t.testcase_id} className="px-4 py-2 flex items-center justify-between gap-3 hover:bg-[#fafaf9]">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 font-mono text-[11px]">
                              <span className="font-semibold text-[#161616]">{t.tc_code}</span>
                              <span className="text-[#71717a]">{t.question_class}</span>
                              {t.status === 'rescued' && (
                                <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.2 rounded bg-[#ecfdf5] text-[#027a42] font-semibold">
                                  <ArrowUpRight className="size-3" /> Fail→Pass
                                </span>
                              )}
                              {t.status === 'regressed' && (
                                <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.2 rounded bg-[#fef2f2] text-[#dc2626] font-semibold">
                                  <ArrowDownRight className="size-3" /> Pass→Fail
                                </span>
                              )}
                            </div>
                            <div className="text-[12px] text-[#52525b] truncate mt-0.5">{t.input_question}</div>
                          </div>
                          <div className="flex items-center gap-2 font-mono text-[11px] shrink-0">
                            <span className="text-[#a1a1aa]">{fmtPct(t.baseline_cp)} →</span>
                            <span className="font-semibold text-[#161616]">{fmtPct(t.candidate_cp)}</span>
                            <DeltaPill delta={t.delta_cp} />
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-[#e4e4e0] bg-white flex items-center justify-between shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-[12px] font-medium text-[#52525b] border border-[#dedede] rounded-[4px] bg-white hover:text-[#161616]"
          >
            Đóng
          </button>
          <button
            onClick={handlePromote}
            disabled={promoting || loading}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-semibold text-white bg-[#03aa5c] hover:bg-[#028a4b] rounded-[4px] disabled:opacity-50"
          >
            {promoting ? <Loader2 className="size-3.5 animate-spin" /> : <Star className="size-3.5 fill-current" />}
            Đặt nhánh [B] làm Baseline gốc mới
          </button>
        </div>
      </div>
    </div>
  );
};
