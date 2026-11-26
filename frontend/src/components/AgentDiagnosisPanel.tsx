import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  Eye,
  FileSearch,
  GitBranch,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react';
import { HypothesisPack, SwarmDiagnosisReport } from '../types';

interface Props {
  report: SwarmDiagnosisReport | null;
  isStale?: boolean;
  loading: boolean;
  applyingPackId?: string;
  onRunDiagnosis: (forceRefresh: boolean) => void;
  onApplyPack?: (pack: HypothesisPack, forkNewRun: boolean) => void;
}

const PARAM_LABELS: Record<string, string> = {
  chunk_method: 'Cách chia tài liệu',
  pdf_parse_method: 'Bộ đọc PDF',
  enable_vision_enhancement: 'Đọc ảnh/sơ đồ bằng AI',
  chunk_token_size: 'Kích thước đoạn (token)',
  overlapped_percent: 'Độ chồng lấp giữa các đoạn (%)',
  delimiters: 'Ký tự ngắt đoạn',
  table_context_size: 'Ngữ cảnh kèm theo bảng',
  image_context_size: 'Ngữ cảnh kèm theo ảnh',
  use_parent_child: 'Cắt theo cấu trúc Cha - Con',
  keywords_top_n: 'Tự trích từ khóa',
  questions_top_n: 'Tự sinh câu hỏi gợi ý',
  filename_embd_weight: 'Trọng số tên file',
  top_k: 'Số đoạn lấy về (Top-K)',
  similarity_threshold: 'Ngưỡng lọc độ khớp',
  vector_similarity_weight: 'Tỷ trọng ngữ nghĩa (Vector)',
  keyword_enabled: 'Tìm kiếm từ khóa (BM25)',
  rerank_id: 'Model xếp hạng lại',
  use_kg: 'Tìm kiếm theo đồ thị tri thức',
};

const getParamLabel = (rawKey: string) => {
  const clean = rawKey.replace(/^(index|retrieval)\./, '');
  return {
    label: PARAM_LABELS[clean] || clean,
    techKey: rawKey,
  };
};

const fmtVal = (v: any): string => {
  if (v === '' || v === null || v === undefined) return 'Tắt / Trống';
  if (typeof v === 'boolean') return v ? 'Bật' : 'Tắt';
  return String(v);
};

const LAYER_META: Record<string, { title: string; subtitle: string; icon: React.FC<{ className?: string }> }> = {
  PARSING: {
    title: '1. Chuyên viên Đọc tài liệu',
    subtitle: 'Kiểm tra chữ, bảng biểu & OCR',
    icon: FileSearch,
  },
  CHUNKING: {
    title: '2. Chuyên viên Cắt đoạn',
    subtitle: 'Kiểm tra ranh giới, trùng lặp & ngữ cảnh',
    icon: Layers,
  },
  RETRIEVAL: {
    title: '3. Chuyên viên Tìm kiếm',
    subtitle: 'Đối chiếu độ khớp & thứ tự xếp hạng',
    icon: Search,
  },
};

const STATUS_STYLE: Record<string, { label: string; dot: string; badge: string; topBar: string }> = {
  ISSUES_FOUND: {
    label: 'Cần chỉnh sửa',
    dot: 'bg-rose-500',
    badge: 'bg-rose-50 text-rose-700 border-rose-200',
    topBar: 'border-t-2 border-t-rose-500',
  },
  OK: {
    label: 'Ổn định',
    dot: 'bg-[#03aa5c]',
    badge: 'bg-[#f2fbf6] text-[#027a42] border-[#03aa5c]/30',
    topBar: 'border-t-2 border-t-[#03aa5c]',
  },
  SKIPPED_NO_DATA: {
    label: 'Chưa có lỗi để soi',
    dot: 'bg-zinc-400',
    badge: 'bg-zinc-50 text-zinc-600 border-zinc-200',
    topBar: 'border-t-2 border-t-zinc-300',
  },
  FALLBACK_ERROR: {
    label: 'Chưa kiểm tra được',
    dot: 'bg-amber-500',
    badge: 'bg-amber-50 text-amber-800 border-amber-200',
    topBar: 'border-t-2 border-t-amber-400',
  },
};

const SEVERITY_DOT: Record<string, { label: string; cls: string }> = {
  high: { label: 'Nghiêm trọng', cls: 'text-rose-700 bg-rose-50' },
  medium: { label: 'Trung bình', cls: 'text-amber-700 bg-amber-50' },
  low: { label: 'Nhẹ', cls: 'text-zinc-600 bg-zinc-100' },
};

export const AgentDiagnosisPanel: React.FC<Props> = ({
  report,
  isStale = false,
  loading,
  applyingPackId = '',
  onRunDiagnosis,
  onApplyPack,
}) => {
  const [selectedPackIdx, setSelectedPackIdx] = useState(0);

  useEffect(() => {
    setSelectedPackIdx(0);
  }, [report?.evidence_sig, report?.created_at]);

  const packs = report?.hypothesis_packs || [];
  const activePack = packs[selectedPackIdx] || packs[0] || null;

  const stepPlan =
    report?.improvement_plan && report.improvement_plan.length > 0
      ? report.improvement_plan
      : packs.flatMap((p) => p.expected_gains || []).slice(0, 3);

  return (
    <div className="space-y-6">
      {/* Clean Hero Bar */}
      <div className="rounded-xl border border-[#e4e4e2] bg-white p-5 flex flex-wrap items-center justify-between gap-4 shadow-2xs">
        <div className="space-y-1 max-w-2xl">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[#027a42]">
            <Bot className="size-3.5" />
            Mô hình Supervisor – Worker (3 chuyên viên · 1 điều phối)
          </div>
          <h2 className="text-base font-semibold text-[#161616]">
            Kiểm tra lỗi toàn diện &amp; Đề xuất cấu hình mới
          </h2>
          <p className="text-xs text-[#52525b] leading-relaxed">
            Điều phối viên giao 3 chuyên viên kiểm tra song song Đọc tài liệu, Cắt đoạn và Tìm kiếm, tự kiểm tra bổ sung nếu phát hiện điểm lệch rồi tổng hợp phương án sửa.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {report && (
            <button
              type="button"
              disabled={loading}
              onClick={() => onRunDiagnosis(true)}
              className="ts-btn-secondary text-xs"
            >
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              Kiểm tra lại
            </button>
          )}
          <button
            type="button"
            disabled={loading}
            onClick={() => onRunDiagnosis(Boolean(report))}
            className="ts-btn-primary text-xs px-4 py-2"
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5 text-[#03aa5c]" />}
            {loading ? 'Đang kiểm tra...' : report ? 'Cập nhật phân tích' : 'Phân tích & Đề xuất'}
          </button>
        </div>
      </div>

      {/* Empty / Loading states */}
      {!report && !loading && (
        <div className="rounded-xl border border-dashed border-[#d4d4d8] bg-[#fafaf9] py-12 px-6 text-center space-y-2.5">
          <Bot className="size-8 mx-auto text-[#03aa5c]" />
          <div className="text-sm font-semibold text-[#161616]">Chưa có kết quả phân tích cho phiên này</div>
          <p className="text-xs text-[#71717a] max-w-md mx-auto leading-relaxed">
            Nhấn <strong>Phân tích &amp; Đề xuất</strong> để hệ thống kiểm tra dữ liệu lỗi thực tế và gợi ý cấu hình phù hợp nhất.
          </p>
        </div>
      )}

      {loading && !report && (
        <div className="rounded-xl border border-[#e4e4e2] bg-white py-12 px-6 text-center space-y-2.5">
          <Loader2 className="size-7 animate-spin mx-auto text-[#03aa5c]" />
          <div className="text-sm font-semibold text-[#161616]">
            3 chuyên viên đang chấm song song &amp; Điều phối viên đang tổng hợp...
          </div>
          <div className="text-xs text-[#71717a]">Thường mất khoảng 10–20 giây.</div>
        </div>
      )}

      {/* Results */}
      {report && (
        <div className="space-y-6">
          {/* Staleness alert */}
          {isStale && (
            <div className="px-4 py-3 rounded-xl border border-amber-200 bg-amber-50 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-4 shrink-0 text-amber-600" />
                <span>
                  Tài liệu hoặc kết quả chấm vừa thay đổi. Nhấn <strong>Cập nhật ngay</strong> để kiểm tra lại trên dữ liệu mới nhất.
                </span>
              </div>
              <button
                type="button"
                disabled={loading}
                onClick={() => onRunDiagnosis(true)}
                className="ts-btn-primary text-xs py-1 px-3"
              >
                Cập nhật ngay
              </button>
            </div>
          )}

          {/* SECTION 1: 3 Parallel Workers */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center size-5 rounded-full bg-[#161616] text-white text-[11px] font-semibold">
                  1
                </span>
                <h3 className="text-sm font-semibold text-[#161616]">Đánh giá từ 3 chuyên viên (chấm song song)</h3>
              </div>
              <span className="text-[11px] font-mono text-[#71717a]">
                {report.model_used} · {(report.duration_ms / 1000).toFixed(1)}s
                {report.cached && !isStale ? ' · Đã lưu' : ''}
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {(report.layer_diagnoses || []).map((ld) => {
                const meta = LAYER_META[ld.layer] || { title: ld.layer, subtitle: '', icon: Bot };
                const Icon = meta.icon;
                const st = STATUS_STYLE[ld.status] || STATUS_STYLE.OK;

                return (
                  <div
                    key={ld.layer}
                    className={`rounded-xl border border-[#e4e4e2] ${st.topBar} bg-white p-4 space-y-3 shadow-2xs flex flex-col`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="p-2 rounded-lg bg-[#fafaf9] border border-[#ededeb] shrink-0">
                          <Icon className="size-4 text-[#161616]" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[#161616]">{meta.title}</div>
                          <div className="text-[11px] text-[#71717a]">{meta.subtitle}</div>
                        </div>
                      </div>
                      <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${st.badge}`}>
                        <span className={`size-1.5 rounded-full ${st.dot}`} />
                        {st.label}
                      </span>
                    </div>

                    {ld.vision_used && (
                      <div className="inline-flex items-center gap-1 text-[11px] text-[#027a42] font-medium">
                        <Eye className="size-3.5" /> Đã xem ảnh trang PDF gốc
                      </div>
                    )}

                    <p className="text-xs font-medium text-[#161616] leading-relaxed">{ld.headline}</p>

                    {ld.findings.length > 0 && (
                      <div className="space-y-2.5 pt-2 border-t border-[#f0f0ee]">
                        {ld.findings.map((f, idx) => {
                          const sev = SEVERITY_DOT[f.severity] || SEVERITY_DOT.medium;
                          return (
                            <div key={idx} className="space-y-1 text-xs">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold text-[#161616]">{f.pattern}</span>
                                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${sev.cls}`}>
                                  {sev.label}
                                </span>
                              </div>
                              <p className="text-[#52525b] leading-relaxed text-[11.5px]">{f.summary}</p>
                              {f.evidence_refs.length > 0 && (
                                <div className="text-[10.5px] font-mono text-[#71717a]">
                                  Vị trí: {f.evidence_refs.join(' · ')}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* SECTION 2: Supervisor Synthesis */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center size-5 rounded-full bg-[#027a42] text-white text-[11px] font-semibold">
                  2
                </span>
                <h3 className="text-sm font-semibold text-[#161616]">
                  Tổng hợp &amp; Đề xuất cải tiến (Điều phối viên)
                </h3>
              </div>
              {report.drilldown_triggered && (
                <span className="text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-800">
                  Đã tự động kiểm tra bổ sung điểm lệch
                </span>
              )}
            </div>

            <div className="rounded-xl border border-[#e4e4e2] bg-white overflow-hidden shadow-2xs">
              {/* Top Synthesis Summary + Step-by-step Plan */}
              <div className="p-5 bg-[#f2fbf6]/60 border-b border-[#e4e4e2] space-y-4">
                <p className="text-sm text-[#161616] font-medium leading-relaxed">{report.executive_summary}</p>

                {report.supervisor_notes && report.supervisor_notes.length > 0 && (
                  <div className="px-3 py-2 rounded-lg bg-white/80 border border-[#03aa5c]/20 text-[11.5px] text-[#52525b] space-y-0.5">
                    {report.supervisor_notes.map((n, ni) => (
                      <div key={ni}>• {n}</div>
                    ))}
                  </div>
                )}

                {stepPlan.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-[#027a42] uppercase tracking-wider">
                      Các bước nên thực hiện
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                      {stepPlan.map((step, i) => (
                        <div
                          key={i}
                          className="p-3 rounded-lg bg-white border border-[#03aa5c]/25 flex items-start gap-2.5 text-xs text-[#161616]"
                        >
                          <span className="inline-flex items-center justify-center size-5 rounded-full bg-[#f2fbf6] border border-[#03aa5c]/40 text-[#027a42] font-mono font-semibold text-[11px] shrink-0">
                            {i + 1}
                          </span>
                          <span className="leading-relaxed">{step.replace(/^Bước\s*\d+\s*:\s*/i, '')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Config Selector Tabs + Clean Detail View */}
              {packs.length > 0 && activePack && (
                <div className="p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {packs.map((p, idx) => {
                        const selected = idx === selectedPackIdx;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setSelectedPackIdx(idx)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                              selected
                                ? 'bg-[#161616] text-white border-[#161616]'
                                : 'bg-[#fafaf9] text-[#52525b] border-[#e4e4e2] hover:border-[#161616] hover:text-[#161616]'
                            }`}
                          >
                            Gợi ý {idx + 1}: {p.name}
                          </button>
                        );
                      })}
                    </div>

                    <span
                      className={`text-[11px] font-medium px-2.5 py-1 rounded-full border ${
                        activePack.reparse_required
                          ? 'bg-amber-50 border-amber-200 text-amber-800'
                          : 'bg-[#f2fbf6] border-[#03aa5c]/30 text-[#027a42]'
                      }`}
                    >
                      {activePack.reparse_required ? 'Cần đọc lại tài liệu' : 'Áp dụng ngay · Không cần đọc lại'}
                    </span>
                  </div>

                  {/* Active Pack Detail */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                    {/* Left: Explanation, Gains, Warnings */}
                    <div className="lg:col-span-5 space-y-3 text-xs">
                      <div className="p-3.5 rounded-lg bg-[#fafaf9] border border-[#ededeb] space-y-2">
                        <div className="font-semibold text-[#161616]">Lý do &amp; hiệu quả dự kiến</div>
                        <p className="text-[#3d3d3d] leading-relaxed">{activePack.hypothesis_statement}</p>
                        {activePack.conflict_resolution && (
                          <p className="text-[#52525b] leading-relaxed pt-1.5 border-t border-[#ededeb]">
                            <strong className="text-[#161616]">Cách cân bằng giữa các bước:</strong> {activePack.conflict_resolution}
                          </p>
                        )}
                      </div>

                      {activePack.expected_gains.length > 0 && (
                        <div className="space-y-1.5 text-[#027a42]">
                          {activePack.expected_gains.map((g, gi) => (
                            <div key={gi} className="flex items-start gap-2">
                              <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" />
                              <span className="leading-relaxed">{g}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {activePack.regression_warnings.length > 0 && (
                        <div className="space-y-1.5 text-[#b45309]">
                          {activePack.regression_warnings.map((w, wi) => (
                            <div key={wi} className="flex items-start gap-2">
                              <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                              <span className="leading-relaxed">Lưu ý: {w}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Right: Clean Diff Table + Apply Actions */}
                    <div className="lg:col-span-7 space-y-3">
                      {activePack.diff.length > 0 && (
                        <div className="border border-[#e4e4e2] rounded-lg overflow-hidden">
                          <table className="w-full text-xs text-left border-collapse">
                            <thead>
                              <tr className="bg-[#fafaf9] border-b border-[#e4e4e2] text-[11px] text-[#71717a]">
                                <th className="py-2 px-3 font-medium">Thông số cấu hình</th>
                                <th className="py-2 px-3 font-medium">Đang dùng</th>
                                <th className="py-2 px-3 font-medium">Đề xuất</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[#f0f0ee]">
                              {activePack.diff.map((d, di) => {
                                const { label, techKey } = getParamLabel(d.param);
                                return (
                                  <tr key={di} className="hover:bg-[#fafaf9]/60">
                                    <td className="py-2.5 px-3">
                                      <div className="font-medium text-[#161616]">{label}</div>
                                      <div className="font-mono text-[10.5px] text-[#71717a]">{techKey}</div>
                                    </td>
                                    <td className="py-2.5 px-3 font-mono text-[#71717a]">{fmtVal(d.from)}</td>
                                    <td className="py-2.5 px-3 font-mono text-[#027a42] font-semibold">
                                      <span className="inline-flex items-center gap-1.5">
                                        <ArrowRight className="size-3.5 shrink-0" />
                                        {fmtVal(d.to)}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {onApplyPack && (
                        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                          {activePack.reparse_required ? (
                            <>
                              <button
                                type="button"
                                disabled={Boolean(applyingPackId)}
                                onClick={() => onApplyPack(activePack, false)}
                                className="ts-btn-secondary text-xs"
                              >
                                {applyingPackId === activePack.id ? 'Đang lưu...' : 'Lưu vào phiên hiện tại'}
                              </button>
                              <button
                                type="button"
                                disabled={Boolean(applyingPackId)}
                                onClick={() => onApplyPack(activePack, true)}
                                className="ts-btn-primary text-xs px-4 py-2"
                              >
                                <GitBranch className="size-3.5 text-[#03aa5c]" />
                                {applyingPackId === activePack.id ? 'Đang tạo...' : 'Tạo phiên mới để thử'}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={Boolean(applyingPackId)}
                              onClick={() => onApplyPack(activePack, false)}
                              className="ts-btn-primary text-xs px-4 py-2"
                            >
                              <CheckCircle2 className="size-3.5 text-[#03aa5c]" />
                              {applyingPackId === activePack.id ? 'Đang áp dụng...' : 'Áp dụng ngay'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
