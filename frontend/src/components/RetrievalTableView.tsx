import React, { useMemo, useState } from 'react';
import { Copy, Download, FileSpreadsheet } from 'lucide-react';
import { api } from '../api/client';
import { RetrievalResultGroup } from '../types';
import {
  copyToClipboard,
  ExcelContextMenu,
  ExcelMenuState,
  extractExcelCellInfo,
  SelectedCellInfo,
} from './ExcelContextMenu';

interface Props {
  runId?: number;
  groups: RetrievalResultGroup[];
  onSelectGroup: (g: RetrievalResultGroup) => void;
}

type SheetTab = 'summary' | 'hits';

const SUMMARY_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const HITS_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

const AC_BADGE: Record<string, { label: string; cls: string }> = {
  FULL: { label: 'Trọn 1 chunk', cls: 'bg-[#dcfce7]/65 text-[#166534] font-semibold' },
  SPLIT: { label: 'Tách nhiều chunk', cls: 'bg-[#fef9c3]/75 text-[#854d0e] font-semibold' },
  MISSING: { label: 'Không có', cls: 'bg-[#fee2e2]/75 text-[#991b1b] font-semibold' },
  UNCHECKED: { label: 'Chưa kiểm tra', cls: 'text-[#71717a]' },
};

function scoreTone(pct: number): string {
  if (pct >= 75) return 'bg-[#dcfce7]/60 text-[#166534] font-semibold';
  if (pct >= 45) return 'bg-[#fef9c3]/75 text-[#854d0e] font-semibold';
  return 'bg-[#fee2e2]/75 text-[#991b1b] font-semibold';
}

export const RetrievalTableView: React.FC<Props> = ({ runId, groups, onSelectGroup }) => {
  const [sheet, setSheet] = useState<SheetTab>('summary');
  const [classFilter, setClassFilter] = useState<string>('ALL');
  const [hitRelFilter, setHitRelFilter] = useState<'ALL' | '1' | '0'>('ALL');
  const [tcFilter, setTcFilter] = useState<string>('ALL');
  const [selectedCell, setSelectedCell] = useState<SelectedCellInfo | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ExcelMenuState | null>(null);

  const visibleGroups = useMemo(() => {
    if (classFilter === 'ALL') return groups;
    return groups.filter((g) => g.testcase.question_class === classFilter);
  }, [groups, classFilter]);

  const flatHits = useMemo(() => {
    const out: { group: RetrievalResultGroup; hit: RetrievalResultGroup['hits'][number] }[] = [];
    for (const g of groups) {
      if (tcFilter !== 'ALL' && g.testcase.tc_code !== tcFilter) continue;
      for (const h of g.hits) {
        if (hitRelFilter === '1' && h.relevant !== 1) continue;
        if (hitRelFilter === '0' && h.relevant !== 0) continue;
        out.push({ group: g, hit: h });
      }
    }
    return out;
  }, [groups, tcFilter, hitRelFilter]);

  const stats = useMemo(() => {
    const n = visibleGroups.length;
    if (n === 0) return { n: 0, avgPrec: 0, avgCov: 0, fullAc: 0, totalHits: 0, relHits: 0 };
    const avgPrec = (visibleGroups.reduce((s, g) => s + (g.contextual_precision || 0), 0) / n) * 100;
    const avgCov = (visibleGroups.reduce((s, g) => s + (g.meta?.context_coverage || 0), 0) / n) * 100;
    const fullAc = visibleGroups.filter((g) => g.meta?.answer_containment === 'FULL').length;
    const totalHits = visibleGroups.reduce((s, g) => s + g.hits.length, 0);
    const relHits = visibleGroups.reduce((s, g) => s + g.relevant_count, 0);
    return { n, avgPrec, avgCov, fullAc, totalHits, relHits };
  }, [visibleGroups]);

  const activeCols = sheet === 'summary' ? SUMMARY_COLS : HITS_COLS;
  const cellBorder = 'border border-[#d4d4d8]';

  const handleCellSelect = (e: React.MouseEvent<HTMLTableSectionElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, select')) return;
    const info = extractExcelCellInfo(target, activeCols);
    if (info) setSelectedCell({ cellRef: info.cellRef, text: info.cellText });
  };

  const openCellContextMenu = (
    e: React.MouseEvent<HTMLTableRowElement>,
    opts: { onOpen?: () => void; openLabel?: string }
  ) => {
    const info = extractExcelCellInfo(e.target as HTMLElement, activeCols);
    if (!info) return;
    e.preventDefault();
    setSelectedCell({ cellRef: info.cellRef, text: info.cellText });
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      cellRef: info.cellRef,
      cellText: info.cellText,
      rowTsv: info.rowTsv,
      ...opts,
    });
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#f3f3f1] overflow-hidden">
      {/* Real Cell Inspector / Filter Ribbon */}
      <div className="px-4 py-1.5 bg-white border-b border-[#d4d4d8] flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {selectedCell ? (
            <>
              <span className="font-mono text-[11px] font-bold text-[#027a42] px-1.5 py-0.5 bg-[#f2fbf6] border border-[#bbf7d0] rounded-[3px] shrink-0">
                {selectedCell.cellRef}
              </span>
              <span className="text-[11.5px] text-[#18181b] truncate flex-1 select-all" title={selectedCell.text}>
                {selectedCell.text || '(Ô trống)'}
              </span>
              {selectedCell.text && (
                <button
                  type="button"
                  onClick={() => copyToClipboard(selectedCell.text, `Đã copy ô ${selectedCell.cellRef}`)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[10.5px] rounded border border-[#dcdcd8] bg-[#fafaf9] hover:bg-[#f2fbf6] hover:text-[#027a42] text-[#3f3f46] shrink-0 transition-colors"
                >
                  <Copy className="size-3" /> Copy
                </button>
              )}
            </>
          ) : (
            <span className="text-[11.5px] text-[#52525b] truncate">
              {sheet === 'summary'
                ? `${stats.n} câu · Precision TB: ${stats.avgPrec.toFixed(1)}% · Coverage TB: ${stats.avgCov.toFixed(1)}% · Trọn 1 chunk: ${stats.fullAc}/${stats.n} — Chuột phải ô để Copy, nhấp đúp dòng để mở chi tiết`
                : `Đang hiển thị ${flatHits.length} đoạn trả về — Chuột phải ô để Copy, nhấp đúp dòng để mở câu hỏi`}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {sheet === 'summary' ? (
            <select
              className="ts-input py-0.5 px-2 text-[11px] rounded-[3px] bg-white"
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
            >
              <option value="ALL">Tất cả loại ({groups.length})</option>
              <option value="Local">Local</option>
              <option value="Global">Global</option>
              <option value="Multi-hop">Multi-hop</option>
            </select>
          ) : (
            <>
              <select
                className="ts-input py-0.5 px-2 text-[11px] rounded-[3px] bg-white"
                value={tcFilter}
                onChange={(e) => setTcFilter(e.target.value)}
              >
                <option value="ALL">Tất cả câu ({groups.length})</option>
                {groups.map((g) => (
                  <option key={g.testcase.tc_code} value={g.testcase.tc_code}>
                    {g.testcase.tc_code}
                  </option>
                ))}
              </select>
              <select
                className="ts-input py-0.5 px-2 text-[11px] rounded-[3px] bg-white"
                value={hitRelFilter}
                onChange={(e) => setHitRelFilter(e.target.value as 'ALL' | '1' | '0')}
              >
                <option value="ALL">Tất cả đánh giá</option>
                <option value="1">Chỉ đoạn Đúng</option>
                <option value="0">Chỉ Không liên quan</option>
              </select>
            </>
          )}
          {runId && (
            <a
              href={api.exportXlsxUrl(runId)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-[3px] bg-[#166534] hover:bg-[#14532d] text-white transition-colors"
              title="Tải file Excel (.xlsx) đầy đủ của phiên kiểm thử"
            >
              <Download className="size-3" />
              Xuất Excel (.xlsx)
            </a>
          )}
        </div>
      </div>

      {/* Main Excel Grid */}
      <div className="flex-1 overflow-auto bg-white">
        {sheet === 'summary' ? (
          <table className="w-full border-collapse text-[12px] text-[#18181b] min-w-[1120px]">
            <thead className="sticky top-0 z-20">
              <tr className="bg-[#ededeb] text-[10.5px] font-mono text-[#71717a] select-none">
                <th className={`${cellBorder} w-10 py-0.5 text-center bg-[#e5e5e2]`}>#</th>
                {SUMMARY_COLS.map((c) => (
                  <th key={c} className={`${cellBorder} py-0.5 text-center font-medium`}>
                    {c}
                  </th>
                ))}
              </tr>
              <tr className="bg-[#f4f4f2] text-[11.5px] font-semibold text-[#18181b]">
                <th className={`${cellBorder} py-2 text-center font-mono text-[10.5px] text-[#71717a] bg-[#ededeb]`}>1</th>
                <th className={`${cellBorder} px-2.5 py-2 text-left w-[68px]`}>Mã TC</th>
                <th className={`${cellBorder} px-2 py-2 text-center w-[86px]`}>Phân loại</th>
                <th className={`${cellBorder} px-2.5 py-2 text-left w-[30%]`}>Câu hỏi kiểm thử</th>
                <th className={`${cellBorder} px-2 py-2 text-center w-[78px]`}>Đúng/Top</th>
                <th className={`${cellBorder} px-2 py-2 text-right w-[88px]`}>Precision %</th>
                <th className={`${cellBorder} px-2 py-2 text-right w-[88px]`}>Coverage %</th>
                <th className={`${cellBorder} px-2 py-2 text-center w-[112px]`}>Trọn đáp án</th>
                <th className={`${cellBorder} px-2 py-2 text-right w-[78px]`}>Top-1 Sim</th>
                <th className={`${cellBorder} px-2 py-2 text-center w-[104px]`}>Nguyên nhân</th>
                <th className={`${cellBorder} px-2.5 py-2 text-left`}>Tài liệu nguồn</th>
              </tr>
            </thead>
            <tbody onClick={handleCellSelect}>
              {visibleGroups.map((g, idx) => {
                const precPct = (g.contextual_precision || 0) * 100;
                const covPct = (g.meta?.context_coverage || 0) * 100;
                const ac = AC_BADGE[g.meta?.answer_containment || 'UNCHECKED'] || AC_BADGE.UNCHECKED;
                const top1Sim = g.hits[0]?.similarity ?? null;
                const rc = g.meta?.root_cause_layer || 'NONE';
                return (
                  <tr
                    key={g.testcase.id}
                    onDoubleClick={() => onSelectGroup(g)}
                    onContextMenu={(e) =>
                      openCellContextMenu(e, {
                        onOpen: () => onSelectGroup(g),
                        openLabel: `Mở chi tiết ${g.testcase.tc_code}`,
                      })
                    }
                    className={`${idx % 2 === 0 ? 'bg-white' : 'bg-[#fafaf9]'} hover:bg-[#f2fbf6]/70 cursor-cell transition-colors`}
                  >
                    <td className={`${cellBorder} py-2 text-center font-mono text-[10.5px] text-[#71717a] bg-[#f4f4f2] select-none`}>
                      {idx + 2}
                    </td>
                    <td className={`${cellBorder} px-2.5 py-2 font-mono font-bold text-[#141414] whitespace-nowrap align-top`}>
                      {g.testcase.tc_code}
                    </td>
                    <td className={`${cellBorder} px-2 py-2 text-center text-[11px] whitespace-nowrap align-top`}>
                      {g.testcase.question_class}
                    </td>
                    <td className={`${cellBorder} px-2.5 py-2 text-[#141414] leading-snug align-top`}>
                      {g.testcase.input_question}
                    </td>
                    <td className={`${cellBorder} px-2 py-2 text-center font-mono text-[11.5px] whitespace-nowrap align-top`}>
                      {g.relevant_count}/{g.hits.length}
                    </td>
                    <td className={`${cellBorder} px-2 py-2 text-right font-mono text-[11.5px] whitespace-nowrap align-top ${scoreTone(precPct)}`}>
                      {precPct.toFixed(1)}%
                    </td>
                    <td className={`${cellBorder} px-2 py-2 text-right font-mono text-[11.5px] whitespace-nowrap align-top ${scoreTone(covPct)}`}>
                      {covPct.toFixed(1)}%
                    </td>
                    <td className={`${cellBorder} px-2 py-2 text-center text-[11px] whitespace-nowrap align-top ${ac.cls}`}>
                      {ac.label}
                    </td>
                    <td className={`${cellBorder} px-2 py-2 text-right font-mono text-[11.5px] text-[#3f3f46] whitespace-nowrap align-top`}>
                      {top1Sim !== null ? `${(top1Sim * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td
                      className={`${cellBorder} px-2 py-2 text-center font-mono text-[10.5px] whitespace-nowrap align-top ${
                        rc && rc !== 'NONE' ? 'text-[#991b1b] bg-[#fee2e2]/45 font-semibold' : 'text-[#71717a]'
                      }`}
                    >
                      {rc === 'NONE' || !rc ? '—' : rc}
                    </td>
                    <td className={`${cellBorder} px-2.5 py-2 font-mono text-[11px] text-[#52525b] align-top break-words`}>
                      {g.testcase.source_file || '—'}
                    </td>
                  </tr>
                );
              })}
              {stats.n > 0 && (
                <tr className="bg-[#f2fbf6] font-bold text-[#141414]">
                  <td className={`${cellBorder} py-2 text-center font-mono text-[10.5px] text-[#71717a] bg-[#ededeb]`}>Σ</td>
                  <td className={`${cellBorder} px-2.5 py-2`} colSpan={3}>
                    TRUNG BÌNH / TỔNG ({stats.n} câu hỏi)
                  </td>
                  <td className={`${cellBorder} px-2 py-2 text-center font-mono`}>
                    {stats.relHits}/{stats.totalHits}
                  </td>
                  <td className={`${cellBorder} px-2 py-2 text-right font-mono text-[#166534]`}>
                    {stats.avgPrec.toFixed(1)}%
                  </td>
                  <td className={`${cellBorder} px-2 py-2 text-right font-mono text-[#166534]`}>
                    {stats.avgCov.toFixed(1)}%
                  </td>
                  <td className={`${cellBorder} px-2 py-2 text-center font-mono`}>
                    {stats.fullAc}/{stats.n} FULL
                  </td>
                  <td className={`${cellBorder} px-2 py-2`} colSpan={3} />
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <table className="w-full border-collapse text-[12px] text-[#18181b] min-w-[1140px]">
            <thead className="sticky top-0 z-20">
              <tr className="bg-[#ededeb] text-[10.5px] font-mono text-[#71717a] select-none">
                <th className={`${cellBorder} w-10 py-0.5 text-center bg-[#e5e5e2]`}>#</th>
                {HITS_COLS.map((c) => (
                  <th key={c} className={`${cellBorder} py-0.5 text-center font-medium`}>
                    {c}
                  </th>
                ))}
              </tr>
              <tr className="bg-[#f4f4f2] text-[11.5px] font-semibold text-[#18181b]">
                <th className={`${cellBorder} py-2 text-center font-mono text-[10.5px] text-[#71717a] bg-[#ededeb]`}>1</th>
                <th className={`${cellBorder} px-2 py-2 text-left w-[68px]`}>Mã TC</th>
                <th className={`${cellBorder} px-2 py-2 text-center w-[56px]`}>Hạng</th>
                <th className={`${cellBorder} px-2.5 py-2 text-left w-[18%]`}>Tài liệu trả về</th>
                <th className={`${cellBorder} px-2 py-2 text-right w-[70px]`}>Khớp %</th>
                <th className={`${cellBorder} px-2 py-2 text-right w-[70px]`}>Vector %</th>
                <th className={`${cellBorder} px-2 py-2 text-right w-[70px]`}>Term %</th>
                <th className={`${cellBorder} px-2 py-2 text-center w-[100px]`}>Đánh giá</th>
                <th className={`${cellBorder} px-2 py-2 text-left w-[18%]`}>Lý do chấm</th>
                <th className={`${cellBorder} px-2.5 py-2 text-left`}>Nội dung đoạn (Chunk)</th>
              </tr>
            </thead>
            <tbody onClick={handleCellSelect}>
              {flatHits.map(({ group, hit }, idx) => (
                <tr
                  key={hit.id}
                  onDoubleClick={() => onSelectGroup(group)}
                  onContextMenu={(e) =>
                    openCellContextMenu(e, {
                      onOpen: () => onSelectGroup(group),
                      openLabel: `Mở câu hỏi ${group.testcase.tc_code}`,
                    })
                  }
                  className={`${idx % 2 === 0 ? 'bg-white' : 'bg-[#fafaf9]'} hover:bg-[#f2fbf6]/70 cursor-cell transition-colors`}
                >
                  <td className={`${cellBorder} py-2 text-center font-mono text-[10.5px] text-[#71717a] bg-[#f4f4f2] select-none`}>
                    {idx + 2}
                  </td>
                  <td className={`${cellBorder} px-2 py-2 font-mono font-bold text-[#141414] whitespace-nowrap align-top`}>
                    {group.testcase.tc_code}
                  </td>
                  <td className={`${cellBorder} px-2 py-2 text-center font-mono font-semibold whitespace-nowrap align-top`}>
                    #{hit.rank}
                  </td>
                  <td className={`${cellBorder} px-2.5 py-2 font-mono text-[11px] text-[#3f3f46] align-top break-words`}>
                    {hit.doc_name || '—'}
                  </td>
                  <td className={`${cellBorder} px-2 py-2 text-right font-mono text-[11.5px] whitespace-nowrap align-top`}>
                    {(hit.similarity * 100).toFixed(0)}%
                  </td>
                  <td className={`${cellBorder} px-2 py-2 text-right font-mono text-[11px] text-[#52525b] whitespace-nowrap align-top`}>
                    {(hit.vector_similarity * 100).toFixed(0)}%
                  </td>
                  <td className={`${cellBorder} px-2 py-2 text-right font-mono text-[11px] text-[#52525b] whitespace-nowrap align-top`}>
                    {(hit.term_similarity * 100).toFixed(0)}%
                  </td>
                  <td
                    className={`${cellBorder} px-2 py-2 text-center text-[11px] whitespace-nowrap align-top ${
                      hit.relevant === 1
                        ? 'bg-[#dcfce7]/65 text-[#166534] font-semibold'
                        : hit.relevant === 0
                        ? 'bg-[#fee2e2]/65 text-[#991b1b] font-semibold'
                        : 'text-[#71717a]'
                    }`}
                  >
                    {hit.relevant === 1 ? 'Đúng' : hit.relevant === 0 ? 'Không liên quan' : 'Chưa chấm'}
                  </td>
                  <td className={`${cellBorder} px-2 py-2 text-[11.5px] text-[#3f3f46] leading-snug align-top`}>
                    {hit.reason || '—'}
                  </td>
                  <td
                    data-copy={hit.content || ''}
                    className={`${cellBorder} px-2.5 py-2 text-[11.5px] text-[#27272a] leading-snug align-top`}
                  >
                    <div className="line-clamp-3 whitespace-pre-wrap">{hit.content || '—'}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Bottom Excel Sheet Tabs */}
      <div className="px-3 py-1 bg-[#ededeb] border-t border-[#d4d4d8] flex items-center justify-between gap-2 text-[11px] shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setSheet('summary');
              setSelectedCell(null);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-t-[3px] border-t border-x transition-colors ${
              sheet === 'summary'
                ? 'bg-white text-[#166534] font-semibold border-[#d4d4d8] -mt-1 pt-1.5 border-b-2 border-b-[#166534]'
                : 'bg-[#e4e4e0] text-[#52525b] border-transparent hover:bg-[#f4f4f2]'
            }`}
          >
            <FileSpreadsheet className="size-3" />
            Tong_hop_Cau_hoi ({visibleGroups.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setSheet('hits');
              setSelectedCell(null);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-t-[3px] border-t border-x transition-colors ${
              sheet === 'hits'
                ? 'bg-white text-[#166534] font-semibold border-[#d4d4d8] -mt-1 pt-1.5 border-b-2 border-b-[#166534]'
                : 'bg-[#e4e4e0] text-[#52525b] border-transparent hover:bg-[#f4f4f2]'
            }`}
          >
            <FileSpreadsheet className="size-3" />
            Chi_tiet_TopK_Hits ({flatHits.length})
          </button>
        </div>
        <span className="text-[10.5px] text-[#71717a] hidden sm:inline">
          Chuột phải ô để Copy / Thao tác · Nhấp đúp dòng để mở chi tiết
        </span>
      </div>

      <ExcelContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
    </div>
  );
};
