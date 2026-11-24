import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bug,
  CheckCircle2,
  Copy,
  Download,
  GitCompare,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { RetrievalRun, RunItem } from '../types';

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
    if (baseId && candId && baseId !== candId) {
      api.compareRuns(Number(baseId), Number(candId)).then(setDiff);
    }
  }, [baseId, candId]);

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
                <div className="px-4 py-3 border-b border-[#e4e4e2] bg-[#fafaf9] flex items-center justify-between">
                  <span className="ts-eyebrow text-rose-800">CÁC CÂU BỊ TỤT (PASS → FAIL)</span>
                  <span className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 font-semibold">
                    {diff.regressions_pass_to_fail.length}
                  </span>
                </div>
                <DiffList rows={diff.regressions_pass_to_fail} />
              </div>
            </div>
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
