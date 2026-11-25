import React, { useMemo, useState } from 'react';
import { Copy, Download, FileSpreadsheet, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { GoldenTestcase } from '../types';
import {
  copyToClipboard,
  ExcelContextMenu,
  ExcelMenuState,
  extractExcelCellInfo,
  SelectedCellInfo,
} from './ExcelContextMenu';

interface Props {
  runId?: number;
  testcases: GoldenTestcase[];
  onSelectTestcase: (tc: GoldenTestcase) => void;
  onDeleteTestcase: (tc: GoldenTestcase) => void;
}

type SheetTab = 'detail' | 'summary';

const DETAIL_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const SUMMARY_COLS = ['A', 'B', 'C', 'D', 'E', 'F'];

const CLASS_CELL: Record<string, string> = {
  Local: 'bg-[#dcfce7]/60 text-[#166534] font-semibold',
  Global: 'bg-[#fef9c3]/75 text-[#854d0e] font-semibold',
  'Multi-hop': 'bg-[#f4f4f5] text-[#18181b] font-semibold',
};

const INTENT_LABELS: Record<string, string> = {
  Factoid: 'Tra sự kiện',
  Procedural: 'Quy trình',
  Table: 'Tra bảng',
  Keyword: 'Từ khóa',
  Comparison: 'So sánh',
  Reasoning: 'Suy luận',
};

export const GoldenTableView: React.FC<Props> = ({
  runId,
  testcases,
  onSelectTestcase,
  onDeleteTestcase,
}) => {
  const [sheet, setSheet] = useState<SheetTab>('detail');
  const [docFilter, setDocFilter] = useState<string>('ALL');
  const [selectedCell, setSelectedCell] = useState<SelectedCellInfo | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ExcelMenuState | null>(null);

  const docSummary = useMemo(() => {
    const map = new Map<
      string,
      { source: string; total: number; local: number; global: number; multihop: number }
    >();
    for (const tc of testcases) {
      const parts = (tc.source_file || 'Không rõ')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      const primary = parts[0] || 'Không rõ';
      const entry = map.get(primary) || {
        source: primary,
        total: 0,
        local: 0,
        global: 0,
        multihop: 0,
      };
      entry.total += 1;
      if (tc.question_class === 'Local') entry.local += 1;
      else if (tc.question_class === 'Global') entry.global += 1;
      else if (tc.question_class === 'Multi-hop') entry.multihop += 1;
      map.set(primary, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
  }, [testcases]);

  const visibleRows = useMemo(() => {
    if (docFilter === 'ALL') return testcases;
    return testcases.filter((tc) => (tc.source_file || '').includes(docFilter));
  }, [testcases, docFilter]);

  const totals = useMemo(() => {
    let local = 0;
    let global = 0;
    let multihop = 0;
    for (const tc of testcases) {
      if (tc.question_class === 'Local') local += 1;
      else if (tc.question_class === 'Global') global += 1;
      else if (tc.question_class === 'Multi-hop') multihop += 1;
    }
    return { total: testcases.length, local, global, multihop };
  }, [testcases]);

  const cellBorder = 'border border-[#d4d4d8]';

  const activeCols = sheet === 'detail' ? DETAIL_COLS : SUMMARY_COLS;

  const handleCellSelect = (e: React.MouseEvent<HTMLTableSectionElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, select')) return;
    const info = extractExcelCellInfo(target, activeCols);
    if (info) setSelectedCell({ cellRef: info.cellRef, text: info.cellText });
  };

  const openCellContextMenu = (
    e: React.MouseEvent<HTMLTableRowElement>,
    opts: { onOpen?: () => void; openLabel?: string; onDelete?: () => void }
  ) => {
    const target = e.target as HTMLElement;
    const info = extractExcelCellInfo(target, activeCols);
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
      {/* Real Interactive Cell Inspector / Summary Ribbon (zero decoration!) */}
      <div className="px-4 py-1.5 bg-white border-b border-[#d4d4d8] flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {selectedCell ? (
            <>
              <span className="font-mono text-[11px] font-bold text-[#027a42] px-1.5 py-0.5 bg-[#f2fbf6] border border-[#bbf7d0] rounded-[3px] shrink-0">
                {selectedCell.cellRef}
              </span>
              <span
                className="text-[11.5px] text-[#18181b] truncate flex-1 select-all"
                title={selectedCell.text}
              >
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
              {sheet === 'detail'
                ? `${visibleRows.length}/${totals.total} câu · Local ${totals.local} · Global ${totals.global} · Multi-hop ${totals.multihop} — Click ô bất kỳ để soi nội dung đầy đủ, chuột phải để mở menu`
                : `Tổng hợp ${docSummary.length} tài liệu gốc · ${totals.total} câu hỏi — Chuột phải để copy hoặc nhấp đúp để lọc`}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {sheet === 'detail' && (
            <select
              className="ts-input py-0.5 px-2 text-[11px] rounded-[3px] bg-white max-w-[220px]"
              value={docFilter}
              onChange={(e) => setDocFilter(e.target.value)}
            >
              <option value="ALL">Tất cả tài liệu ({docSummary.length})</option>
              {docSummary.map((d) => (
                <option key={d.source} value={d.source}>
                  {d.source.slice(0, 38)} ({d.total})
                </option>
              ))}
            </select>
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

      {/* Main Excel Grid Area */}
      <div className="flex-1 overflow-auto bg-white">
        {sheet === 'detail' ? (
          <table className="w-full border-collapse text-[12px] text-[#18181b] min-w-[1100px]">
            <thead className="sticky top-0 z-20">
              {/* Excel Column Letters Row */}
              <tr className="bg-[#ededeb] text-[10.5px] font-mono text-[#71717a] select-none">
                <th className={`${cellBorder} w-10 py-0.5 text-center bg-[#e5e5e2]`}>#</th>
                {DETAIL_COLS.map((col) => (
                  <th key={col} className={`${cellBorder} py-0.5 text-center font-medium`}>
                    {col}
                  </th>
                ))}
              </tr>
              {/* Header Titles Row */}
              <tr className="bg-[#f4f4f2] text-[11.5px] font-semibold text-[#18181b]">
                <th className={`${cellBorder} py-2 text-center font-mono text-[10.5px] text-[#71717a] bg-[#ededeb]`}>
                  1
                </th>
                <th className={`${cellBorder} px-2.5 py-2 text-left w-[74px]`}>Mã TC</th>
                <th className={`${cellBorder} px-2.5 py-2 text-center w-[92px]`}>Phân loại</th>
                <th className={`${cellBorder} px-2.5 py-2 text-center w-[104px]`}>Dạng câu hỏi</th>
                <th className={`${cellBorder} px-2.5 py-2 text-left w-[26%]`}>Câu hỏi kiểm thử (Input Question)</th>
                <th className={`${cellBorder} px-2.5 py-2 text-left w-[22%]`}>Đáp án kỳ vọng (Expected Outcome)</th>
                <th className={`${cellBorder} px-2.5 py-2 text-left w-[24%]`}>Căn cứ file gốc (Reference Context)</th>
                <th className={`${cellBorder} px-2.5 py-2 text-left w-[15%]`}>Tài liệu nguồn</th>
                <th className={`${cellBorder} px-2 py-2 text-center w-[48px]`}>Xóa</th>
              </tr>
            </thead>
            <tbody onClick={handleCellSelect}>
              {visibleRows.map((tc, idx) => (
                <tr
                  key={tc.id}
                  onDoubleClick={() => onSelectTestcase(tc)}
                  onContextMenu={(e) =>
                    openCellContextMenu(e, {
                      onOpen: () => onSelectTestcase(tc),
                      openLabel: `Mở chi tiết ${tc.tc_code}`,
                      onDelete: () => onDeleteTestcase(tc),
                    })
                  }
                  className={`${
                    idx % 2 === 0 ? 'bg-white' : 'bg-[#fafaf9]'
                  } hover:bg-[#f2fbf6]/70 cursor-cell transition-colors`}
                >
                  <td className={`${cellBorder} py-2 text-center font-mono text-[10.5px] text-[#71717a] bg-[#f4f4f2] select-none`}>
                    {idx + 2}
                  </td>
                  <td className={`${cellBorder} px-2.5 py-2 font-mono font-bold text-[#141414] whitespace-nowrap align-top`}>
                    {tc.tc_code}
                  </td>
                  <td
                    className={`${cellBorder} px-2 py-2 text-center text-[11px] whitespace-nowrap align-top ${
                      CLASS_CELL[tc.question_class] || ''
                    }`}
                  >
                    {tc.question_class}
                  </td>
                  <td className={`${cellBorder} px-2 py-2 text-center text-[11px] text-[#52525b] whitespace-nowrap align-top`}>
                    {tc.intent_type ? (INTENT_LABELS[tc.intent_type] || tc.intent_type) : '—'}
                  </td>
                  <td className={`${cellBorder} px-2.5 py-2 text-[#141414] font-medium leading-snug align-top`}>
                    {tc.input_question}
                  </td>
                  <td className={`${cellBorder} px-2.5 py-2 text-[#166534] leading-snug align-top text-[11.5px]`}>
                    {tc.expected_outcome || '—'}
                  </td>
                  <td
                    data-copy={tc.reference_context || ''}
                    className={`${cellBorder} px-2.5 py-2 text-[#3f3f46] leading-snug align-top text-[11.5px]`}
                  >
                    <div className="line-clamp-4 whitespace-pre-wrap">{tc.reference_context || '—'}</div>
                  </td>
                  <td className={`${cellBorder} px-2.5 py-2 font-mono text-[11px] text-[#52525b] align-top break-words`}>
                    <div>{tc.source_file || '—'}</div>
                    {tc.notes && <div className="text-[10px] text-[#a1a1aa] mt-0.5">{tc.notes}</div>}
                  </td>
                  <td
                    className={`${cellBorder} px-2 py-2 text-center align-top`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteTestcase(tc);
                    }}
                  >
                    <button
                      type="button"
                      className="p-1 text-[#a1a1aa] hover:text-[#b91c1c] rounded hover:bg-[#fef2f2]"
                      title={`Xóa ${tc.tc_code}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full border-collapse text-[12px] text-[#18181b] min-w-[780px]">
            <thead className="sticky top-0 z-20">
              <tr className="bg-[#ededeb] text-[10.5px] font-mono text-[#71717a] select-none">
                <th className={`${cellBorder} w-10 py-0.5 text-center bg-[#e5e5e2]`}>#</th>
                {SUMMARY_COLS.map((col) => (
                  <th key={col} className={`${cellBorder} py-0.5 text-center font-medium`}>
                    {col}
                  </th>
                ))}
              </tr>
              <tr className="bg-[#f4f4f2] text-[11.5px] font-semibold text-[#18181b]">
                <th className={`${cellBorder} py-2 text-center font-mono text-[10.5px] text-[#71717a] bg-[#ededeb]`}>
                  1
                </th>
                <th className={`${cellBorder} px-3 py-2 text-left`}>Tài liệu gốc</th>
                <th className={`${cellBorder} px-3 py-2 text-right w-[100px]`}>Tổng câu</th>
                <th className={`${cellBorder} px-3 py-2 text-right w-[100px]`}>Local</th>
                <th className={`${cellBorder} px-3 py-2 text-right w-[100px]`}>Global</th>
                <th className={`${cellBorder} px-3 py-2 text-right w-[100px]`}>Multi-hop</th>
                <th className={`${cellBorder} px-3 py-2 text-right w-[100px]`}>Tỷ trọng %</th>
              </tr>
            </thead>
            <tbody onClick={handleCellSelect}>
              {docSummary.map((d, idx) => (
                <tr
                  key={d.source}
                  onDoubleClick={() => {
                    setDocFilter(d.source);
                    setSheet('detail');
                  }}
                  onContextMenu={(e) =>
                    openCellContextMenu(e, {
                      onOpen: () => {
                        setDocFilter(d.source);
                        setSheet('detail');
                      },
                      openLabel: 'Lọc các câu hỏi của tài liệu này',
                    })
                  }
                  className={`${
                    idx % 2 === 0 ? 'bg-white' : 'bg-[#fafaf9]'
                  } hover:bg-[#f2fbf6]/70 cursor-cell transition-colors`}
                >
                  <td className={`${cellBorder} py-2 text-center font-mono text-[10.5px] text-[#71717a] bg-[#f4f4f2]`}>
                    {idx + 2}
                  </td>
                  <td className={`${cellBorder} px-3 py-2 font-mono text-[11.5px] text-[#141414]`}>{d.source}</td>
                  <td className={`${cellBorder} px-3 py-2 text-right font-mono font-bold text-[#141414]`}>{d.total}</td>
                  <td className={`${cellBorder} px-3 py-2 text-right font-mono text-[#166534]`}>{d.local}</td>
                  <td className={`${cellBorder} px-3 py-2 text-right font-mono text-[#854d0e]`}>{d.global}</td>
                  <td className={`${cellBorder} px-3 py-2 text-right font-mono text-[#3f3f46]`}>{d.multihop}</td>
                  <td className={`${cellBorder} px-3 py-2 text-right font-mono text-[#52525b]`}>
                    {totals.total ? `${((d.total / totals.total) * 100).toFixed(1)}%` : '0%'}
                  </td>
                </tr>
              ))}
              <tr className="bg-[#f2fbf6] font-bold text-[#141414]">
                <td className={`${cellBorder} py-2 text-center font-mono text-[10.5px] text-[#71717a] bg-[#ededeb]`}>
                  Σ
                </td>
                <td className={`${cellBorder} px-3 py-2`}>TỔNG CỘNG ({docSummary.length} tài liệu gốc)</td>
                <td className={`${cellBorder} px-3 py-2 text-right font-mono`}>{totals.total}</td>
                <td className={`${cellBorder} px-3 py-2 text-right font-mono text-[#166534]`}>{totals.local}</td>
                <td className={`${cellBorder} px-3 py-2 text-right font-mono text-[#854d0e]`}>{totals.global}</td>
                <td className={`${cellBorder} px-3 py-2 text-right font-mono`}>{totals.multihop}</td>
                <td className={`${cellBorder} px-3 py-2 text-right font-mono`}>100.0%</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* Bottom Excel Sheet Tabs */}
      <div className="px-3 py-1 bg-[#ededeb] border-t border-[#d4d4d8] flex items-center justify-between gap-2 text-[11px] shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSheet('detail')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-t-[3px] border-t border-x transition-colors ${
              sheet === 'detail'
                ? 'bg-white text-[#166534] font-semibold border-[#d4d4d8] -mt-1 pt-1.5 border-b-2 border-b-[#166534]'
                : 'bg-[#e4e4e0] text-[#52525b] border-transparent hover:bg-[#f4f4f2]'
            }`}
          >
            <FileSpreadsheet className="size-3" />
            Danh_sach_Golden ({visibleRows.length})
          </button>
          <button
            type="button"
            onClick={() => setSheet('summary')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-t-[3px] border-t border-x transition-colors ${
              sheet === 'summary'
                ? 'bg-white text-[#166534] font-semibold border-[#d4d4d8] -mt-1 pt-1.5 border-b-2 border-b-[#166534]'
                : 'bg-[#e4e4e0] text-[#52525b] border-transparent hover:bg-[#f4f4f2]'
            }`}
          >
            <FileSpreadsheet className="size-3" />
            Thong_ke_theo_Tai_lieu ({docSummary.length})
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
