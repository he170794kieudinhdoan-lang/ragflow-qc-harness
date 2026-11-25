import React, { useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Filter, Search, Table2 } from 'lucide-react';
import { api } from '../api/client';
import { ChunkEvalItem } from '../types';

interface Props {
  runId?: number;
  chunks: ChunkEvalItem[];
  getChunkState: (c: ChunkEvalItem) => 'OK' | 'FAIL';
  onSelectChunk: (c: ChunkEvalItem) => void;
}

type SheetTab = 'summary' | 'detail';
type CodeFilter = 'ALL' | 'INTEGRITY' | 'CONTEXT' | 'NOISE' | 'DUPLICATE' | 'SIZE';
type StatusFilter = 'ALL' | 'OK' | 'ERR';

function excelTone(val: number | null, invert = false): string {
  if (val === null) return 'text-[#9ca3af] bg-transparent';
  if (invert) {
    if (val <= 10) return 'text-[#166534] bg-[#dcfce7]/55 font-semibold';
    if (val <= 25) return 'text-[#854d0e] bg-[#fef9c3]/75 font-semibold';
    return 'text-[#991b1b] bg-[#fee2e2]/75 font-semibold';
  }
  if (val >= 85) return 'text-[#166534] bg-[#dcfce7]/55 font-semibold';
  if (val >= 65) return 'text-[#854d0e] bg-[#fef9c3]/75 font-semibold';
  return 'text-[#991b1b] bg-[#fee2e2]/75 font-semibold';
}

function fmtPct(val: number | null): string {
  if (val === null) return '—';
  return `${val.toFixed(1)}%`;
}

const SUMMARY_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
const DETAIL_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

export const ChunkingTableView: React.FC<Props> = ({
  runId,
  chunks,
  getChunkState,
  onSelectChunk,
}) => {
  const [sheet, setSheet] = useState<SheetTab>('summary');
  const [codeFilter, setCodeFilter] = useState<CodeFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [docCodeFilter, setDocCodeFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const docRows = useMemo(() => {
    const byDoc = new Map<
      string,
      { doc_code: string; filename: string; format_group: string; items: ChunkEvalItem[] }
    >();
    for (const c of chunks) {
      const code = c.doc_code || 'DOC';
      const entry = byDoc.get(code) || {
        doc_code: code,
        filename: c.filename || '',
        format_group: c.format_group || '',
        items: [],
      };
      entry.items.push(c);
      byDoc.set(code, entry);
    }
    return Array.from(byDoc.values())
      .sort((a, b) => a.doc_code.localeCompare(b.doc_code, undefined, { numeric: true }))
      .map((d) => {
        const n = d.items.length;
        const integPass = d.items.filter((c) => c.integrity === 1).length;
        const ctxPass = d.items.filter((c) => c.context_sufficiency === 1).length;
        const noiseErr = d.items.filter((c) => c.no_noise === 0).length;
        const dupErr = d.items.filter((c) => c.no_duplicate === 0).length;
        const sizePass = d.items.filter((c) => c.valid_size === 1).length;
        const okAll = d.items.filter((c) => getChunkState(c) === 'OK').length;

        const integPct = n ? (integPass / n) * 100 : null;
        const ctxPct = n ? (ctxPass / n) * 100 : null;
        const noisePct = n ? (noiseErr / n) * 100 : 0;
        const dupPct = n ? (dupErr / n) * 100 : 0;
        const sizePct = n ? (sizePass / n) * 100 : null;
        const score = n
          ? ((integPct ?? 0) + (ctxPct ?? 0) + (100 - noisePct) + (100 - dupPct) + (sizePct ?? 0)) / 5
          : 0;

        return {
          doc_code: d.doc_code,
          filename: d.filename,
          format_group: d.format_group,
          total: n,
          integPass,
          integPct,
          ctxPass,
          ctxPct,
          noiseErr,
          noisePct,
          dupErr,
          dupPct,
          sizePass,
          sizePct,
          okAll,
          score,
        };
      });
  }, [chunks, getChunkState]);

  const overall = useMemo(() => {
    const sum = (fn: (r: (typeof docRows)[number]) => number) =>
      docRows.reduce((acc, r) => acc + fn(r), 0);
    const total = sum((r) => r.total);
    const integPass = sum((r) => r.integPass);
    const ctxPass = sum((r) => r.ctxPass);
    const noiseErr = sum((r) => r.noiseErr);
    const dupErr = sum((r) => r.dupErr);
    const sizePass = sum((r) => r.sizePass);
    const okAll = sum((r) => r.okAll);

    const integPct = total ? (integPass / total) * 100 : null;
    const ctxPct = total ? (ctxPass / total) * 100 : null;
    const noisePct = total ? (noiseErr / total) * 100 : 0;
    const dupPct = total ? (dupErr / total) * 100 : 0;
    const sizePct = total ? (sizePass / total) * 100 : null;
    const score = total
      ? ((integPct ?? 0) + (ctxPct ?? 0) + (100 - noisePct) + (100 - dupPct) + (sizePct ?? 0)) / 5
      : 0;

    return {
      docCount: docRows.length,
      total,
      integPass,
      integPct,
      ctxPass,
      ctxPct,
      noiseErr,
      noisePct,
      dupErr,
      dupPct,
      sizePass,
      sizePct,
      okAll,
      score,
    };
  }, [docRows]);

  const detailRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return chunks.filter((c) => {
      if (docCodeFilter !== 'ALL' && (c.doc_code || 'DOC') !== docCodeFilter) return false;
      const st = getChunkState(c);
      if (statusFilter === 'OK' && st !== 'OK') return false;
      if (statusFilter === 'ERR' && st === 'OK') return false;
      const codes = c.error_codes || [];
      if (codeFilter !== 'ALL' && !codes.includes(codeFilter)) return false;
      if (q) {
        const hay = `${c.doc_code || ''} #${c.chunk_index} ${c.content} ${c.notes || ''} ${codes.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [chunks, docCodeFilter, statusFilter, codeFilter, searchQuery, getChunkState]);

  const docCodes = useMemo(
    () =>
      Array.from(new Set(chunks.map((c) => c.doc_code || 'DOC'))).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      ),
    [chunks]
  );

  const cellBorder = 'border border-[#d1d5db]';
  const hdrBorder = 'border border-[#cbd5e1]';

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-white select-text">
      {/* Compact Excel fx Summary Ribbon */}
      <div className="shrink-0 bg-[#f8fafc] border-b border-[#cbd5e1] px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
        <div className="flex flex-wrap items-center divide-x divide-[#d1d5db] font-mono">
          <div className="pr-2.5 flex items-center gap-1.5 font-sans">
            <span className="inline-flex items-center justify-center px-1.5 py-0.5 bg-[#166534] text-white font-mono text-[10px] font-bold">
              fx
            </span>
            <span className="font-semibold text-[#1e293b]">Chunk Score:</span>
            <span className="font-mono font-bold text-[#166534] text-xs">{fmtPct(overall.score)}</span>
          </div>
          <div className="px-2.5 flex items-center gap-1">
            <span className="text-[#64748b] font-sans">Trọn ý:</span>
            <span className="font-semibold text-[#1e293b]">{fmtPct(overall.integPct)}</span>
          </div>
          <div className="px-2.5 flex items-center gap-1">
            <span className="text-[#64748b] font-sans">Đủ nghĩa:</span>
            <span className="font-semibold text-[#1e293b]">{fmtPct(overall.ctxPct)}</span>
          </div>
          <div className="px-2.5 flex items-center gap-1">
            <span className="text-[#64748b] font-sans">Nhiễu:</span>
            <span className="font-semibold text-[#991b1b]">{fmtPct(overall.noisePct)}</span>
          </div>
          <div className="px-2.5 flex items-center gap-1">
            <span className="text-[#64748b] font-sans">Trùng:</span>
            <span className="font-semibold text-[#854d0e]">{fmtPct(overall.dupPct)}</span>
          </div>
          <div className="pl-2.5 flex items-center gap-1">
            <span className="text-[#64748b] font-sans">Độ dài:</span>
            <span className="font-semibold text-[#1e293b]">{fmtPct(overall.sizePct)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <span className="text-[11px] text-[#64748b] font-sans hidden xl:inline">
            Click dòng để mở chế độ chấm · {overall.docCount} tài liệu · {overall.total} mẫu
          </span>
          {runId && (
            <a
              href={api.exportXlsxUrl(runId)}
              download={`ragflow_qc_run_${runId}.xlsx`}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#166534] hover:bg-[#15803d] text-white text-[11px] font-medium font-sans transition-colors"
              title="Tải xuống toàn bộ bảng tổng hợp & chi tiết dạng file Excel (.xlsx)"
            >
              <Download className="size-3.5" />
              Xuất Excel (.xlsx)
            </a>
          )}
        </div>
      </div>

      {/* Main Excel Viewport */}
      {sheet === 'summary' ? (
        <div className="flex-1 overflow-auto bg-white">
          <table className="w-full border-collapse text-[12px] tabular-nums">
            <thead className="sticky top-0 z-20">
              <tr className="bg-[#f1f5f9] text-[#64748b] font-mono text-[10px]">
                <th className={`sticky left-0 z-30 bg-[#e2e8f0] ${hdrBorder} w-8 py-0.5 text-center select-none`} />
                {SUMMARY_COLS.map((col, idx) => (
                  <th
                    key={col}
                    className={`${hdrBorder} py-0.5 text-center font-normal select-none ${
                      idx === 0 ? 'sticky left-8 z-30 bg-[#f1f5f9]' : ''
                    }`}
                  >
                    {col}
                  </th>
                ))}
              </tr>
              <tr className="bg-[#e6f0ea] text-[#1e293b] text-[11px] font-semibold">
                <th className={`sticky left-0 z-30 bg-[#e2e8f0] ${hdrBorder} w-8 py-1.5 text-center font-mono text-[10px] text-[#64748b]`}>
                  #
                </th>
                <th className={`sticky left-8 z-30 bg-[#e6f0ea] ${hdrBorder} px-2 py-1.5 text-left whitespace-nowrap`}>
                  Mã
                </th>
                <th className={`${hdrBorder} px-2.5 py-1.5 text-left min-w-[230px]`}>Tên tài liệu</th>
                <th className={`${hdrBorder} px-2.5 py-1.5 text-left whitespace-nowrap`}>Nhóm định dạng</th>
                <th className={`${hdrBorder} px-2 py-1.5 text-right whitespace-nowrap`}>Số mẫu</th>
                <th className={`${hdrBorder} px-2 py-1.5 text-right whitespace-nowrap`}>Trọn ý %</th>
                <th className={`${hdrBorder} px-2 py-1.5 text-right whitespace-nowrap`}>Đủ nghĩa %</th>
                <th className={`${hdrBorder} px-2 py-1.5 text-right whitespace-nowrap`}>Nhiễu % ↓</th>
                <th className={`${hdrBorder} px-2 py-1.5 text-right whitespace-nowrap`}>Trùng % ↓</th>
                <th className={`${hdrBorder} px-2 py-1.5 text-right whitespace-nowrap`}>Độ dài %</th>
                <th className={`${hdrBorder} px-2 py-1.5 text-right whitespace-nowrap`}>Đạt 5/5</th>
                <th className={`${hdrBorder} px-2.5 py-1.5 text-right whitespace-nowrap bg-[#d1fae5]/70 text-[#14532d]`}>
                  Score
                </th>
              </tr>
            </thead>
            <tbody>
              {docRows.map((r, rowIdx) => (
                <tr
                  key={r.doc_code}
                  onClick={() => {
                    setDocCodeFilter(r.doc_code);
                    setCodeFilter('ALL');
                    setStatusFilter('ALL');
                    setSheet('detail');
                  }}
                  className="bg-white even:bg-[#f9fafb] hover:bg-[#eff6ff] cursor-pointer group"
                >
                  <td className={`sticky left-0 z-10 bg-[#f1f5f9] group-hover:bg-[#dbeafe] ${cellBorder} text-center font-mono text-[10.5px] text-[#64748b] py-1.5 select-none`}>
                    {rowIdx + 1}
                  </td>
                  <td className={`sticky left-8 z-10 bg-white group-even:bg-[#f9fafb] group-hover:bg-[#eff6ff] ${cellBorder} px-2 py-1.5 font-mono font-semibold text-[#0f172a] whitespace-nowrap`}>
                    {r.doc_code}
                  </td>
                  <td className={`${cellBorder} px-2.5 py-1.5 text-[#0f172a] max-w-[300px] truncate`} title={r.filename}>
                    {r.filename}
                  </td>
                  <td className={`${cellBorder} px-2.5 py-1.5 text-[#475569] whitespace-nowrap text-[11px]`}>
                    {r.format_group}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono text-[#475569]`}>{r.total}</td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono ${excelTone(r.integPct)}`}>
                    {fmtPct(r.integPct)}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono ${excelTone(r.ctxPct)}`}>
                    {fmtPct(r.ctxPct)}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono ${excelTone(r.noisePct, true)}`}>
                    {fmtPct(r.noisePct)}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono ${excelTone(r.dupPct, true)}`}>
                    {fmtPct(r.dupPct)}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono ${excelTone(r.sizePct)}`}>
                    {fmtPct(r.sizePct)}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono text-[#475569]`}>
                    {r.okAll}/{r.total}
                  </td>
                  <td className={`${cellBorder} px-2.5 py-1.5 text-right font-mono font-bold ${excelTone(r.score)}`}>
                    {fmtPct(r.score)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="sticky bottom-0 z-20">
              <tr className="bg-[#e6f0ea] font-semibold text-[#0f172a] shadow-[0_-1px_0_#94a3b8]">
                <td className={`sticky left-0 z-30 bg-[#cbd5e1] ${hdrBorder} text-center font-mono text-[10px] text-[#334155] py-2`}>
                  Σ
                </td>
                <td className={`sticky left-8 z-30 bg-[#e6f0ea] ${hdrBorder} px-2 py-2 font-mono whitespace-nowrap`}>
                  TỔNG
                </td>
                <td className={`${hdrBorder} px-2.5 py-2 whitespace-nowrap`}>
                  {overall.docCount} tài liệu ({overall.total} mẫu)
                </td>
                <td className={`${hdrBorder} px-2.5 py-2 text-[#475569] text-[11px]`}>Toàn bộ</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{overall.total}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{fmtPct(overall.integPct)}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{fmtPct(overall.ctxPct)}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{fmtPct(overall.noisePct)}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{fmtPct(overall.dupPct)}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{fmtPct(overall.sizePct)}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>
                  {overall.okAll}/{overall.total}
                </td>
                <td className={`${hdrBorder} px-2.5 py-2 text-right font-mono font-bold text-[#14532d] bg-[#bbf7d0]/70`}>
                  {fmtPct(overall.score)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-white">
          {/* Excel AutoFilter Bar */}
          <div className="shrink-0 px-3 py-1.5 bg-[#f8fafc] border-b border-[#cbd5e1] flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
            <div className="flex flex-wrap items-center gap-1">
              <Filter className="size-3.5 text-[#64748b] mr-1" />
              {(
                [
                  { id: 'ALL', label: 'Tất cả' },
                  { id: 'INTEGRITY', label: 'INTEGRITY' },
                  { id: 'CONTEXT', label: 'CONTEXT' },
                  { id: 'NOISE', label: 'NOISE' },
                  { id: 'DUPLICATE', label: 'DUPLICATE' },
                  { id: 'SIZE', label: 'SIZE' },
                ] as { id: CodeFilter; label: string }[]
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setCodeFilter(t.id)}
                  className={`px-2 py-0.5 text-[11px] font-mono border transition-colors ${
                    codeFilter === t.id
                      ? 'bg-[#166534] text-white border-[#166534] font-semibold'
                      : 'bg-white text-[#334155] border-[#cbd5e1] hover:bg-[#f1f5f9]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <select
                value={docCodeFilter}
                onChange={(e) => setDocCodeFilter(e.target.value)}
                className="py-0.5 px-2 text-[11.5px] bg-white border border-[#cbd5e1] text-[#0f172a]"
              >
                <option value="ALL">Tất cả tài liệu</option>
                {docCodes.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="py-0.5 px-2 text-[11.5px] bg-white border border-[#cbd5e1] text-[#0f172a]"
              >
                <option value="ALL">Mọi trạng thái</option>
                <option value="OK">Đạt 5/5</option>
                <option value="ERR">Có lỗi</option>
              </select>

              <div className="relative">
                <Search className="size-3 text-[#94a3b8] absolute left-2 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Lọc nội dung, lý do..."
                  className="pl-6 pr-2 py-0.5 text-[11.5px] bg-white border border-[#cbd5e1] w-48 focus:outline-none focus:border-[#166534]"
                />
              </div>

              <span className="text-[11px] font-mono text-[#475569] pl-1">
                {detailRows.length}/{chunks.length} dòng
              </span>
            </div>
          </div>

          {/* Excel Detail Grid */}
          <div className="flex-1 overflow-auto bg-white">
            <table className="w-full border-collapse text-[12px] tabular-nums">
              <thead className="sticky top-0 z-20">
                <tr className="bg-[#f1f5f9] text-[#64748b] font-mono text-[10px]">
                  <th className={`sticky left-0 z-30 bg-[#e2e8f0] ${hdrBorder} w-9 py-0.5 text-center select-none`} />
                  {DETAIL_COLS.map((col, idx) => (
                    <th
                      key={col}
                      className={`${hdrBorder} py-0.5 text-center font-normal select-none ${
                        idx === 0 ? 'sticky left-9 z-30 bg-[#f1f5f9]' : ''
                      }`}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
                <tr className="bg-[#e6f0ea] text-[#1e293b] text-[11px] font-semibold">
                  <th className={`sticky left-0 z-30 bg-[#e2e8f0] ${hdrBorder} w-9 py-1.5 text-center font-mono text-[10px] text-[#64748b]`}>
                    #
                  </th>
                  <th className={`sticky left-9 z-30 bg-[#e6f0ea] ${hdrBorder} px-2 py-1.5 text-left whitespace-nowrap`}>
                    Tài liệu
                  </th>
                  <th className={`${hdrBorder} px-2 py-1.5 text-right whitespace-nowrap`}>Chunk</th>
                  <th className={`${hdrBorder} px-2 py-1.5 text-center whitespace-nowrap`}>Trang</th>
                  <th className={`${hdrBorder} px-2 py-1.5 text-right whitespace-nowrap`}>Token</th>
                  <th className={`${hdrBorder} px-2.5 py-1.5 text-left min-w-[260px]`}>Nội dung chunk</th>
                  <th className={`${hdrBorder} px-1.5 py-1.5 text-center whitespace-nowrap`}>Trọn ý</th>
                  <th className={`${hdrBorder} px-1.5 py-1.5 text-center whitespace-nowrap`}>Đủ nghĩa</th>
                  <th className={`${hdrBorder} px-1.5 py-1.5 text-center whitespace-nowrap`}>Sạch rác</th>
                  <th className={`${hdrBorder} px-1.5 py-1.5 text-center whitespace-nowrap`}>Ko trùng</th>
                  <th className={`${hdrBorder} px-1.5 py-1.5 text-center whitespace-nowrap`}>Độ dài</th>
                  <th className={`${hdrBorder} px-2 py-1.5 text-left whitespace-nowrap`}>Mã lỗi</th>
                  <th className={`${hdrBorder} px-2.5 py-1.5 text-left min-w-[220px]`}>Đánh giá AI / Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {detailRows.length === 0 ? (
                  <tr>
                    <td colSpan={13} className={`${cellBorder} text-center py-10 text-[#64748b]`}>
                      Không có chunk nào khớp bộ lọc hiện tại.
                    </td>
                  </tr>
                ) : (
                  detailRows.map((c, idx) => {
                    const codes = c.error_codes || [];
                    const flagCell = (ok: number | null) =>
                      ok === 1
                        ? `${cellBorder} px-1.5 py-1.5 text-center font-mono text-[11px] font-bold bg-[#dcfce7]/65 text-[#166534]`
                        : `${cellBorder} px-1.5 py-1.5 text-center font-mono text-[11px] font-bold bg-[#fee2e2]/75 text-[#991b1b]`;

                    return (
                      <tr
                        key={c.chunk_pk}
                        onClick={() => onSelectChunk(c)}
                        className="bg-white even:bg-[#f9fafb] hover:bg-[#eff6ff] cursor-pointer align-top group"
                      >
                        <td className={`sticky left-0 z-10 bg-[#f1f5f9] group-hover:bg-[#dbeafe] ${cellBorder} text-center font-mono text-[10.5px] text-[#64748b] py-1.5 select-none`}>
                          {idx + 1}
                        </td>
                        <td className={`sticky left-9 z-10 bg-white group-even:bg-[#f9fafb] group-hover:bg-[#eff6ff] ${cellBorder} px-2 py-1.5 font-mono font-semibold text-[#0f172a] whitespace-nowrap`}>
                          {c.doc_code || 'DOC'}
                        </td>
                        <td className={`${cellBorder} px-2 py-1.5 text-right font-mono text-[#475569] whitespace-nowrap`}>
                          #{c.chunk_index}
                        </td>
                        <td className={`${cellBorder} px-2 py-1.5 text-center font-mono text-[#475569] whitespace-nowrap`}>
                          {c.page_num || '—'}
                        </td>
                        <td className={`${cellBorder} px-2 py-1.5 text-right font-mono text-[#475569] whitespace-nowrap`}>
                          {c.token_est}
                        </td>
                        <td className={`${cellBorder} px-2.5 py-1.5 text-[#334155] max-w-[300px]`} title={c.content}>
                          <div className="line-clamp-2 text-[11.5px] leading-snug">{c.content}</div>
                        </td>
                        <td className={flagCell(c.integrity)}>{c.integrity === 1 ? '✓' : '✗'}</td>
                        <td className={flagCell(c.context_sufficiency)}>{c.context_sufficiency === 1 ? '✓' : '✗'}</td>
                        <td className={flagCell(c.no_noise)}>{c.no_noise === 1 ? '✓' : '✗'}</td>
                        <td className={flagCell(c.no_duplicate)}>{c.no_duplicate === 1 ? '✓' : '✗'}</td>
                        <td className={flagCell(c.valid_size)}>{c.valid_size === 1 ? '✓' : '✗'}</td>
                        <td className={`${cellBorder} px-2 py-1.5 font-mono text-[11px] font-semibold text-[#991b1b] whitespace-nowrap`}>
                          {codes.length > 0 ? codes.join(', ') : <span className="text-[#cbd5e1] font-normal">—</span>}
                        </td>
                        <td className={`${cellBorder} px-2.5 py-1.5 text-[11.5px] text-[#334155] max-w-[260px]`}>
                          {c.notes ? (
                            <div className="line-clamp-2">{c.notes}</div>
                          ) : (
                            <span className="text-[#cbd5e1]">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Authentic Excel Bottom Sheet Tabs Bar */}
      <div className="shrink-0 bg-[#e2e8f0] border-t border-[#cbd5e1] px-2 flex items-end justify-between gap-2 select-none">
        <div className="flex items-end gap-0.5 pt-1">
          <button
            type="button"
            onClick={() => setSheet('summary')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[11.5px] border-x border-t transition-colors ${
              sheet === 'summary'
                ? 'bg-white text-[#166534] font-semibold border-[#cbd5e1] border-t-2 border-t-[#166534] -mb-px'
                : 'bg-[#f1f5f9] text-[#475569] border-transparent hover:bg-[#f8fafc] hover:text-[#0f172a]'
            }`}
          >
            <FileSpreadsheet className="size-3.5" />
            Tong_hop_Chunking ({overall.docCount})
          </button>
          <button
            type="button"
            onClick={() => setSheet('detail')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[11.5px] border-x border-t transition-colors ${
              sheet === 'detail'
                ? 'bg-white text-[#166534] font-semibold border-[#cbd5e1] border-t-2 border-t-[#166534] -mb-px'
                : 'bg-[#f1f5f9] text-[#475569] border-transparent hover:bg-[#f8fafc] hover:text-[#0f172a]'
            }`}
          >
            <Table2 className="size-3.5" />
            Chi_tiet_Chunk ({chunks.length})
          </button>
        </div>
        <div className="pb-1 pr-2 text-[10.5px] font-mono text-[#64748b]">
          Sheet: {sheet === 'summary' ? `A1:K${docRows.length + 2}` : `A1:L${detailRows.length + 2}`}
        </div>
      </div>
    </div>
  );
};
