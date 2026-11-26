import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  Bug,
  CheckCircle2,
  Copy,
  Download,
  GitCompare,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { RetrievalRun, RunItem, SwarmDiagnosisReport } from '../types';

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);

interface Props {
  activeRun?: RunItem | null;
}

export const CompareLabPage: React.FC<Props> = ({ activeRun }) => {
  const [rrList, setRrList] = useState<RetrievalRun[]>([]);
  const [baseId, setBaseId] = useState<number | ''>('');
  const [candId, setCandId] = useState<number | ''>('');
  const [diff, setDiff] = useState<any>(null);
  const [diag, setDiag] = useState<any>(null);
  const [matrix, setMatrix] = useState<any[]>([]);
  const [bugReport, setBugReport] = useState<any>(null);
  const [autopsy, setAutopsy] = useState<SwarmDiagnosisReport | null>(null);
  const [loadingAutopsy, setLoadingAutopsy] = useState(false);

  useEffect(() => {
    api
      .getRunsMatrix()
      .then((res) => setMatrix(res?.runs || []))
      .catch(() => setMatrix([]));
  }, [activeRun?.id]);

  useEffect(() => {
    if (!activeRun) {
      setDiag(null);
      setBugReport(null);
      return;
    }
    api.getDiagnostics(activeRun.id).then(setDiag).catch(() => setDiag(null));
    api.getBugReport(activeRun.id, 5).then(setBugReport).catch(() => setBugReport(null));
  }, [activeRun?.id]);

  useEffect(() => {
    api.listRetrievalRuns().then((list) => {
      setRrList(list);
      if (list.length >= 2) {
        setBaseId(list[list.length - 1].id);
        setCandId(list[0].id);
      }
    });
  }, []);

  useEffect(() => {
    setAutopsy(null);
    if (baseId && candId && baseId !== candId) {
      api.compareRuns(Number(baseId), Number(candId)).then(setDiff);
    }
  }, [baseId, candId]);

  const handleRunAutopsy = async (forceRefresh = false) => {
    if (!baseId || !candId || baseId === candId || loadingAutopsy) return;
    setLoadingAutopsy(true);
    try {
      const res: SwarmDiagnosisReport = await api.runCompareAutopsy(Number(baseId), Number(candId), forceRefresh);
      setAutopsy(res);
      toast.success(`Đã hoàn tất giải phẫu ${res.regressions_analyzed?.length || 0} câu Regression.`);
    } catch (e: any) {
      toast.error(e.message || 'Không chạy được giải phẫu Regression');
    } finally {
      setLoadingAutopsy(false);
    }
  };

  const bSum = diff?.baseline?.summary;
  const cSum = diff?.candidate?.summary;
  const deltaCp = bSum && cSum ? cSum.avg_contextual_precision - bSum.avg_contextual_precision : 0;
  const deltaCc = bSum && cSum ? cSum.avg_context_coverage - bSum.avg_context_coverage : 0;

  const handleCopyBugMarkdown = async () => {
    if (!bugReport?.markdown_report) return;
    try {
      await navigator.clipboard.writeText(bugReport.markdown_report);
      toast.success('Đã sao chép Markdown Top 5 Bug Report vào clipboard!');
    } catch {
      toast.error('Không thể sao chép vào clipboard.');
    }
  };

  return (
    <div className="min-h-[calc(100dvh-48px)] bg-[#fefefe]">
      <div className="max-w-5xl mx-auto px-8 py-8 space-y-6">
        {/* 3-Layer Diagnostic Summary & Auto-Recommendations */}
        {diag && (
          <div className="border border-[#e6e4de] rounded-xl shadow-xs bg-white p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#dedede]">
              <div>
                <div className="ts-eyebrow">BÁO CÁO TỔNG KẾT & CHẨN ĐOÁN 3 TẦNG</div>
                <h2 className="text-base font-semibold text-[#161616] mt-0.5">Phiên: {diag.run_name}</h2>
              </div>
              <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                <span className="px-2 py-0.5 border border-[#dedede] bg-[#f7f7f6]">
                  Parsing: <strong>{pct(diag.parsing?.text_completeness || 0)}</strong>
                </span>
                <span className="px-2 py-0.5 border border-[#dedede] bg-[#f7f7f6]">
                  Chunking: <strong>{pct(diag.chunking?.chunk_integrity || 0)}</strong>
                </span>
                <span className="px-2 py-0.5 border border-[#dedede] bg-[#f7f7f6]">
                  Retrieval: <strong>{diag.retrieval ? pct(diag.retrieval.avg_contextual_precision || 0) : '—'}</strong>
                </span>
                {activeRun && (
                  <a
                    href={api.exportXlsxUrl(activeRun.id)}
                    className="ts-btn-primary text-xs py-1 px-2.5 ml-1"
                    title="Xuất trọn bộ Excel (Config, Danh mục, Thống kê + Detail Parsing/Chunking/Retrieval, 40 Testcases)"
                  >
                    <Download className="size-3.5" />
                    Xuất Excel chuẩn
                  </a>
                )}
              </div>
            </div>

            <div className="space-y-2">
              {(diag.recommendations || []).map((rec: any, idx: number) => (
                <div
                  key={idx}
                  className={`p-3 border text-xs flex items-start gap-2.5 ${
                    rec.severity === 'high'
                      ? 'bg-[#fef2f2] border-[#fecaca]'
                      : rec.severity === 'medium'
                      ? 'bg-[#fffbeb] border-[#fde68a]'
                      : 'bg-[#f2fbf6] border-[#03aa5c]/35'
                  }`}
                >
                  {rec.severity === 'ok' ? (
                    <CheckCircle2 className="size-4 text-[#03aa5c] shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle
                      className={`size-4 shrink-0 mt-0.5 ${
                        rec.severity === 'high' ? 'text-[#cf222e]' : 'text-[#b45309]'
                      }`}
                    />
                  )}
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 bg-white border border-[#dedede] text-[#161616]">
                        {rec.layer}
                      </span>
                      <span className="font-semibold text-[#161616]">{rec.title}</span>
                    </div>
                    <p className="text-[#3d3d3d] leading-relaxed">{rec.action}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Multi-Run 3-Layer Comparison Matrix (Baseline vs Experiments) */}
        {matrix.length > 0 && (
          <div className="border border-[#e4e4e2] rounded-lg bg-white overflow-hidden shadow-2xs">
            <div className="px-5 py-3.5 border-b border-[#e4e4e2] bg-[#fafaf9] flex items-center justify-between">
              <div>
                <div className="ts-eyebrow">BẢNG SO SÁNH ĐA CẤU HÌNH (3 TẦNG)</div>
                <div className="text-xs text-[#71717a] mt-0.5">
                  Tổng hợp Baseline vs các thử nghiệm thay đổi tham số trên cùng 1 bảng
                </div>
              </div>
              <span className="font-mono text-[11px] text-[#52525b]">{matrix.length} phiên</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[#e4e4e2] bg-[#f7f7f6] font-mono text-[10px] uppercase tracking-wider text-[#52525b]">
                    <th className="py-2.5 px-3">Phiên</th>
                    <th className="py-2.5 px-3">Cấu hình chính</th>
                    <th className="py-2.5 px-2.5 text-right">Text Comp.</th>
                    <th className="py-2.5 px-2.5 text-right">Table Acc.</th>
                    <th className="py-2.5 px-2.5 text-right">Chunk Int.</th>
                    <th className="py-2.5 px-2.5 text-right">Noise</th>
                    <th className="py-2.5 px-2.5 text-right">Ans. Cont.</th>
                    <th className="py-2.5 px-2.5 text-right">Coverage</th>
                    <th className="py-2.5 px-3 text-right">Precision</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#ededeb]">
                  {matrix.map((m) => (
                    <tr
                      key={m.run_id}
                      className={m.run_id === activeRun?.id ? 'bg-[#f2fbf6]/60' : 'hover:bg-[#fafaf9]'}
                    >
                      <td className="py-2.5 px-3 font-medium text-[#161616]">
                        <div className="flex items-center gap-1.5">
                          <span>{m.name}</span>
                          {m.is_baseline && (
                            <span className="font-mono text-[9px] px-1.5 py-0.5 bg-[#161616] text-white">BASE</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-[#52525b]">
                        {m.config.chunk_method} · {m.config.chunk_token_size}tok · ovl {m.config.overlap}% · vec{' '}
                        {m.config.vector_weight} {m.config.rerank ? '· rerank' : ''}
                      </td>
                      <td className="py-2.5 px-2.5 text-right font-mono tabular-nums">{pct(m.parsing.text_completeness)}</td>
                      <td className="py-2.5 px-2.5 text-right font-mono tabular-nums">{pct(m.parsing.table_accuracy)}</td>
                      <td className="py-2.5 px-2.5 text-right font-mono tabular-nums">{pct(m.chunking.chunk_integrity)}</td>
                      <td className="py-2.5 px-2.5 text-right font-mono tabular-nums">{pct(m.chunking.noise_rate)}</td>
                      <td className="py-2.5 px-2.5 text-right font-mono tabular-nums">
                        {pct(m.retrieval.answer_containment_full)}
                      </td>
                      <td className="py-2.5 px-2.5 text-right font-mono tabular-nums">{pct(m.retrieval.context_coverage)}</td>
                      <td className="py-2.5 px-3 text-right font-mono font-semibold tabular-nums text-[#161616]">
                        {pct(m.retrieval.contextual_precision)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Top 5 Bug Report (Cross-Layer) */}
        {bugReport && (
          <div className="border border-[#e4e4e2] rounded-lg bg-white overflow-hidden shadow-2xs">
            <div className="px-5 py-3.5 border-b border-[#e4e4e2] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Bug className="size-4 text-[#161616]" />
                <div>
                  <div className="ts-eyebrow">TOP 5 BUG REPORT (XUYÊN SUỐT 3 TẦNG)</div>
                  <div className="text-xs text-[#71717a]">
                    Tự động gom lỗi nghiêm trọng nhất từ Parsing, Chunking & Retrieval cho Test Report
                  </div>
                </div>
              </div>
              <button
                onClick={handleCopyBugMarkdown}
                disabled={!bugReport.bugs?.length}
                className="ts-btn-secondary text-xs py-1 px-2.5 disabled:opacity-40"
              >
                <Copy className="size-3.5" />
                Copy Markdown (Test Report)
              </button>
            </div>
            {!bugReport.bugs?.length ? (
              <div className="p-6 text-xs text-[#71717a] text-center">
                Chưa có lỗi nào được ghi nhận ở phiên này (hãy chấm Parsing, Chunking hoặc Retrieval để tự động gom Bug Report).
              </div>
            ) : (
              <div className="divide-y divide-[#ededeb]">
                {bugReport.bugs.map((b: any) => (
                  <div key={b.bug_id} className="p-4 space-y-1.5 hover:bg-[#fafaf9]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-bold px-1.5 py-0.5 bg-[#161616] text-white">
                          {b.bug_id}
                        </span>
                        <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 border border-[#dedede] bg-[#f7f7f6] text-[#161616]">
                          {b.layer} · {b.error_code}
                        </span>
                        <span className="text-xs font-semibold text-[#161616]">{b.title}</span>
                      </div>
                      <div className="flex items-center gap-2 font-mono text-[11px]">
                        <span
                          className={`px-2 py-0.5 rounded-full font-medium ${
                            b.severity === 'Nghiêm trọng'
                              ? 'bg-rose-50 text-rose-700'
                              : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          {b.severity}
                        </span>
                        <span className="text-[#52525b] font-semibold">{b.count} lỗi</span>
                      </div>
                    </div>
                    {b.samples?.length > 0 && (
                      <ul className="text-[11px] text-[#52525b] list-disc pl-5 space-y-0.5">
                        {b.samples.map((s: string, i: number) => (
                          <li key={i} className="truncate">
                            {s}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="text-xs text-[#027a42] pt-0.5">
                      <strong>Đề xuất:</strong> {b.suggested_fix}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 1-vs-1 Retrieval A/B Diff */}
        <div className="flex flex-wrap items-end justify-between gap-4 pt-2">
          <div>
            <div className="ts-eyebrow">A/B EXPERIMENT LAB</div>
            <h1 className="text-2xl font-semibold text-[#18181b] mt-1">So sánh 2 cấu hình tìm kiếm</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              className="ts-input py-1.5 text-xs bg-[#fafafa]"
              value={baseId}
              onChange={(e) => setBaseId(Number(e.target.value))}
            >
              <option value="">Chọn bản chuẩn (A)...</option>
              {rrList.map((r) => (
                <option key={r.id} value={r.id}>
                  [A] {r.name}
                </option>
              ))}
            </select>
            <GitCompare className="size-4 text-[#a1a1aa]" />
            <select
              className="ts-input py-1.5 text-xs bg-[#fafafa]"
              value={candId}
              onChange={(e) => setCandId(Number(e.target.value))}
            >
              <option value="">Chọn bản mới (B)...</option>
              {rrList.map((r) => (
                <option key={r.id} value={r.id}>
                  [B] {r.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {!diff ? (
          <div className="border border-[#e6e6e3] rounded-[4px] p-10 text-center text-sm text-[#71717a] bg-[#fafaf9]">
            Cần ít nhất 2 lần chạy tìm kiếm khác nhau để so sánh A/B.
          </div>
        ) : (
          <>
            {/* Architectural 4-Column Metric Strip */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border border-[#e4e4e2] rounded-lg overflow-hidden divide-y sm:divide-y-0 sm:divide-x divide-[#e4e4e2] bg-white shadow-2xs">
              <div className="p-5">
                <div className="ts-eyebrow">XẾP ĐÚNG LÊN ĐẦU</div>
                <div className="mt-2 flex items-baseline gap-2 font-mono tabular-nums">
                  <span className="text-[#71717a] text-sm">{pct(bSum.avg_contextual_precision)}</span>
                  <span className="text-[#a1a1aa]">→</span>
                  <span className="text-2xl font-semibold text-[#18181b]">{pct(cSum.avg_contextual_precision)}</span>
                </div>
                <div className="mt-1.5">
                  <span
                    className={`inline-block text-[11px] font-mono font-medium px-2 py-0.5 rounded-full ${
                      deltaCp >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                    }`}
                  >
                    {deltaCp >= 0 ? `+${pct(deltaCp)} tốt hơn` : `${pct(deltaCp)} thấp hơn`}
                  </span>
                </div>
              </div>

              <div className="p-5">
                <div className="ts-eyebrow">TÌM ĐỦ THÔNG TIN</div>
                <div className="mt-2 flex items-baseline gap-2 font-mono tabular-nums">
                  <span className="text-[#71717a] text-sm">{pct(bSum.avg_context_coverage)}</span>
                  <span className="text-[#a1a1aa]">→</span>
                  <span className="text-2xl font-semibold text-[#18181b]">{pct(cSum.avg_context_coverage)}</span>
                </div>
                <div className="mt-1.5">
                  <span
                    className={`inline-block text-[11px] font-mono font-medium px-2 py-0.5 rounded-full ${
                      deltaCc >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                    }`}
                  >
                    {deltaCc >= 0 ? `+${pct(deltaCc)}` : pct(deltaCc)}
                  </span>
                </div>
              </div>

              <div className="p-5">
                <div className="ts-eyebrow">FAIL → PASS</div>
                <div className="mt-2 text-2xl font-mono font-semibold text-emerald-700 flex items-center gap-1">
                  <ArrowUpRight className="size-5" />
                  {diff.improvements_fail_to_pass.length}
                </div>
                <div className="text-xs text-[#71717a] mt-1">Câu được cứu ở bản mới</div>
              </div>

              <div className="p-5">
                <div className="ts-eyebrow">PASS → FAIL</div>
                <div className="mt-2 text-2xl font-mono font-semibold text-rose-600 flex items-center gap-1">
                  <ArrowDownRight className="size-5" />
                  {diff.regressions_pass_to_fail.length}
                </div>
                <div className="text-xs text-[#71717a] mt-1">Câu bị tụt hạng</div>
              </div>
            </div>

            {diff.performance && (
              <div className="border border-[#e4e4e2] rounded-lg bg-white overflow-hidden shadow-2xs">
                <div className="px-5 py-3 border-b border-[#e4e4e2] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="ts-eyebrow">SO SÁNH HIỆU SUẤT JUDGE (A vs B)</div>
                    <div className="text-xs text-[#71717a] mt-0.5">
                      Đo tốc độ chấm, số lỗi fallback và tỷ lệ đồng thuận trên từng chunk cùng testcase
                    </div>
                  </div>
                  {diff.performance.hit_agreement_rate !== null && diff.performance.hit_agreement_rate !== undefined && (
                    <span className="font-mono text-xs px-2.5 py-1 rounded-full bg-[#f2fbf6] text-[#027a42] border border-[#03aa5c]/35 font-semibold">
                      Đồng thuận: {(diff.performance.hit_agreement_rate * 100).toFixed(1)}% ({diff.performance.agreed_hits}/{diff.performance.compared_hits} hits)
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[#ededeb] text-xs">
                  {[
                    { tag: '[A] Bản chuẩn', meta: diff.baseline?.meta, perf: diff.performance.baseline },
                    { tag: '[B] Bản mới', meta: diff.candidate?.meta, perf: diff.performance.candidate },
                  ].map((item, idx) => (
                    <div key={idx} className="p-4 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-[#18181b] truncate">
                          {item.tag}: {item.meta?.name}
                        </span>
                        <span className="font-mono text-[10px] uppercase px-2 py-0.5 rounded bg-[#f4f4f2] border border-[#dedede] text-[#18181b]">
                          {item.perf?.judge_engine || 'llm'}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 font-mono text-[11px] pt-1">
                        <div className="p-2 rounded bg-[#fafaf9] border border-[#ededeb]">
                          <div className="text-[10px] text-[#71717a] font-sans">Thời gian</div>
                          <div className="font-semibold text-[#18181b] mt-0.5">
                            {item.perf?.judge_duration_ms ? `${item.perf.judge_duration_ms} ms` : '—'}
                          </div>
                        </div>
                        <div className="p-2 rounded bg-[#fafaf9] border border-[#ededeb]">
                          <div className="text-[10px] text-[#71717a] font-sans">TB / Hit</div>
                          <div className="font-semibold text-[#18181b] mt-0.5">
                            {item.perf?.ms_per_hit !== null && item.perf?.ms_per_hit !== undefined ? `${item.perf.ms_per_hit} ms` : '—'}
                          </div>
                        </div>
                        <div className="p-2 rounded bg-[#fafaf9] border border-[#ededeb]">
                          <div className="text-[10px] text-[#71717a] font-sans">Calls / Lỗi</div>
                          <div className="font-semibold text-[#18181b] mt-0.5">
                            {item.perf?.judge_call_count ?? 0} /{' '}
                            <span className={item.perf?.judge_error_count ? 'text-rose-600' : 'text-emerald-700'}>
                              {item.perf?.judge_error_count ?? 0}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {diff.performance.disagreed_samples?.length > 0 && (
                  <div className="border-t border-[#ededeb] px-5 py-3 bg-[#fafaf9]/60 space-y-2">
                    <div className="text-[11px] font-semibold text-[#52525b]">
                      Mẫu chunk lệch nhãn giữa [A] và [B] ({diff.performance.disagreed_samples.length}):
                    </div>
                    <div className="space-y-1.5">
                      {diff.performance.disagreed_samples.map((ds: any, i: number) => (
                        <div key={i} className="text-[11px] bg-white border border-[#ededeb] rounded px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <span className="font-mono font-semibold text-[#18181b] mr-2">{ds.tc_code}</span>
                            <span className="text-[#52525b] mr-2">{ds.doc_name}</span>
                            <span className="font-mono text-[#71717a]">
                              [A:{ds.baseline_relevant}] {ds.baseline_reason || '—'} | [B:{ds.candidate_relevant}] {ds.candidate_reason || '—'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Diff Lists */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="border border-[#e4e4e2] rounded-lg bg-white overflow-hidden shadow-2xs">
                <div className="px-4 py-3 border-b border-[#e4e4e2] bg-[#fafaf9] flex items-center justify-between">
                  <span className="ts-eyebrow text-emerald-800">CÁC CÂU CẢI THIỆN (FAIL → PASS)</span>
                  <span className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-semibold">
                    {diff.improvements_fail_to_pass.length}
                  </span>
                </div>
                <DiffList rows={diff.improvements_fail_to_pass} />
              </div>

              <div className="border border-[#e4e4e2] rounded-lg bg-white overflow-hidden shadow-2xs">
                <div className="px-4 py-3 border-b border-[#e4e4e2] bg-[#fafaf9] flex items-center justify-between gap-2">
                  <span className="ts-eyebrow text-rose-800">CÁC CÂU BỊ TỤT (PASS → FAIL)</span>
                  <div className="flex items-center gap-2">
                    {diff.regressions_pass_to_fail.length > 0 && (
                      <button
                        type="button"
                        disabled={loadingAutopsy}
                        onClick={() => handleRunAutopsy(Boolean(autopsy))}
                        className="ts-btn-primary text-[11px] py-1 px-2.5"
                        title="Dùng Multi-Agent phân tích nguyên nhân các câu Pass → Fail bị tụt điểm"
                      >
                        {loadingAutopsy ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Sparkles className="size-3 text-[#03aa5c]" />
                        )}
                        {loadingAutopsy ? 'Đang phân tích...' : autopsy ? 'Phân tích lại' : 'Phân tích câu bị tụt (AI)'}
                      </button>
                    )}
                    <span className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 font-semibold">
                      {diff.regressions_pass_to_fail.length}
                    </span>
                  </div>
                </div>
                <DiffList rows={diff.regressions_pass_to_fail} />
              </div>
            </div>

            {/* Multi-Agent Regression Autopsy Report */}
            {autopsy && (
              <div className="border border-[#e4e4e2] rounded-lg bg-white p-5 space-y-4 shadow-2xs">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#ededeb]">
                  <div>
                    <div className="ts-eyebrow flex items-center gap-1.5">
                      <Bot className="size-3.5 text-[#03aa5c]" />
                      PHÂN TÍCH CÁC CÂU BỊ TỤT ĐIỂM (PASS → FAIL)
                    </div>
                    <p className="text-xs text-[#161616] font-medium mt-1">{autopsy.executive_summary}</p>
                  </div>
                  <div className="font-mono text-[11px] text-[#71717a]">
                    {autopsy.model_used} · {autopsy.llm_calls} calls · {autopsy.duration_ms}ms
                  </div>
                </div>

                {autopsy.regressions_analyzed?.length > 0 && (
                  <div className="divide-y divide-[#ededeb] border border-[#ededeb] rounded-md">
                    {autopsy.regressions_analyzed.map((item) => (
                      <div key={item.tc_code} className="p-3 text-xs space-y-1 bg-[#fafaf9]/50">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono font-semibold text-[#161616]">{item.tc_code}</span>
                            <span className="ts-tag-neutral text-[10px]">{item.question_class}</span>
                          </div>
                          <span className="font-mono text-[11px] text-rose-700">
                            {(item.baseline_cp * 100).toFixed(0)}% → {(item.candidate_cp * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div className="text-[#27272a]">{item.question}</div>
                        {item.why_failed && (
                          <div className="text-[#52525b]">
                            <strong className="text-[#161616]">Nguyên nhân:</strong> {item.why_failed}
                          </div>
                        )}
                        {item.fix_hint && (
                          <div className="text-[#027a42]">
                            <strong>Hướng dung hòa:</strong> {item.fix_hint}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {autopsy.hypothesis_packs?.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {autopsy.hypothesis_packs.map((p) => (
                      <div key={p.id} className="p-3.5 rounded-md border border-[#e4e4e2] bg-[#fafaf9] space-y-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-[#161616]">{p.name}</span>
                          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#161616] text-white">
                            {p.scope}
                          </span>
                        </div>
                        <p className="text-[#3d3d3d] leading-relaxed">{p.hypothesis_statement}</p>
                        {p.diff?.length > 0 && (
                          <div className="font-mono text-[11px] text-[#027a42] space-y-0.5">
                            {p.diff.map((d, i) => (
                              <div key={i}>
                                • {d.param}: {String(d.from ?? '—')} → <strong>{String(d.to)}</strong>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const DiffList: React.FC<{ rows: any[] }> = ({ rows }) => {
  if (rows.length === 0) {
    return <div className="p-5 text-[13px] text-[#71717a]">Không có câu hỏi nào thay đổi trạng thái.</div>;
  }
  return (
    <div className="divide-y divide-[#ededeb]">
      {rows.map((r) => (
        <div key={r.tc_code} className="px-4 py-3 flex items-start justify-between gap-3 hover:bg-[#fafaf9]">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-xs font-semibold text-[#18181b]">{r.tc_code}</span>
              <span className="ts-tag-neutral text-[10px]">{r.question_class}</span>
            </div>
            <div className="text-[13px] text-[#27272a] mt-1">{r.question}</div>
          </div>
          <div className="text-right shrink-0 font-mono tabular-nums text-xs text-[#52525b]">
            {(r.baseline_cp * 100).toFixed(0)}% → {(r.candidate_cp * 100).toFixed(0)}%
          </div>
        </div>
      ))}
    </div>
  );
};
