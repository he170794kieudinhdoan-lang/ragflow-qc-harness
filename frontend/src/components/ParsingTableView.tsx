import React, { useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Filter, Search, Table2 } from 'lucide-react';
import { api } from '../api/client';
import { DocumentItem, ParsingUnit } from '../types';
import { ExcelContextMenu, ExcelMenuState, extractExcelCellInfo } from './ExcelContextMenu';

interface Props {
  runId?: number;
  units: ParsingUnit[];
  docs: DocumentItem[];
  getUnitEffectiveState: (u: ParsingUnit) => 'PASS' | 'FAIL';
  onSelectUnit: (u: ParsingUnit) => void;
}

type TableSubTab = 'summary' | 'detail';
type MetricTab = 'ALL' | 'TEXT' | 'TABLE' | 'LAYOUT' | 'ORDER' | 'FIDELITY';
type VerdictFilter = 'ALL' | 'PASS' | 'FAIL' | 'UNRATED';

interface CodeMeta {
  group: string;
  name: string;
  severity: 'Nghiêm trọng' | 'Trung bình' | 'Nhẹ';
}

const PARSING_CODE_META: Record<string, CodeMeta> = {
  P1: { group: 'Mất nội dung', name: 'Mất đoạn văn bản', severity: 'Nghiêm trọng' },
  P2: { group: 'Mất nội dung', name: 'Mất nội dung ảnh / sơ đồ / scan', severity: 'Nghiêm trọng' },
  P3: { group: 'Sai thứ tự', name: 'Trộn dòng / sai thứ tự đọc / đảo nghĩa', severity: 'Nghiêm trọng' },
  P4: { group: 'Lỗi ký tự', name: 'Mất dấu tiếng Việt / lỗi ký tự', severity: 'Trung bình' },
  P5: { group: 'Lỗi ký tự', name: 'Ký tự rác / hỏng font', severity: 'Trung bình' },
  P6: { group: 'Lỗi ký tự', name: 'Lỗi OCR (tài liệu scan/ảnh)', severity: 'Trung bình' },
  P7: { group: 'Mất cấu trúc', name: 'Mất cấu trúc heading', severity: 'Trung bình' },
  P8: { group: 'Mất cấu trúc', name: 'Mất cấu trúc danh sách (bullet/numbering)', severity: 'Trung bình' },
  P9: { group: 'Vỡ bảng', name: 'Vỡ cấu trúc bảng (mất hàng/cột/ô gộp)', severity: 'Nghiêm trọng' },
  P10: { group: 'Mất nội dung', name: 'Thiếu / sai số liệu trong bảng', severity: 'Nghiêm trọng' },
  TEXT: { group: 'Thiếu chữ / OCR', name: 'Thiếu chữ / Lỗi dấu & OCR', severity: 'Nghiêm trọng' },
  TABLE: { group: 'Vỡ bảng', name: 'Vỡ cấu trúc bảng / Sai số liệu', severity: 'Nghiêm trọng' },
  ORDER: { group: 'Sai thứ tự', name: 'Sai thứ tự đọc / Đảo cột', severity: 'Trung bình' },
  LAYOUT: { group: 'Hình / Bố cục', name: 'Mất nội dung ảnh / Sơ đồ / Bố cục', severity: 'Nghiêm trọng' },
  FIDELITY: { group: 'Sai nội dung', name: 'Sai lệch số liệu / đảo nghĩa', severity: 'Nghiêm trọng' },
};

const SEVERITY_RANK: Record<string, number> = {
  'Nghiêm trọng': 3,
  'Trung bình': 2,
  'Nhẹ': 1,
};

function getEffectiveCodes(u: ParsingUnit): { codes: string[]; isAuto: boolean } {
  if (u.verdict !== 'UNRATED') {
    return { codes: u.error_codes || [], isAuto: false };
  }
  const suggested = u.matched_chunks?.[0]?.alignment?.suggested_error_codes || [];
  if (suggested.length > 0) {
    return { codes: suggested, isAuto: true };
  }
  if (!u.matched_chunks || u.matched_chunks.length === 0) {
    return {
      codes: [u.unit_type === 'image' || u.unit_type === 'diagram' ? 'P2' : 'P1'],
      isAuto: true,
    };
  }
  return { codes: [], isAuto: true };
}

function getGroupAndSeverity(codes: string[]): { groups: string[]; severity: string } {
  if (!codes.length) return { groups: [], severity: '' };
  const groupSet = new Set<string>();
  let maxSev = '';
  let maxRank = 0;
  for (const c of codes) {
    const meta = PARSING_CODE_META[c];
    if (meta) {
      groupSet.add(meta.group);
      const rank = SEVERITY_RANK[meta.severity] || 0;
      if (rank > maxRank) {
        maxRank = rank;
        maxSev = meta.severity;
      }
    }
  }
  return { groups: Array.from(groupSet), severity: maxSev };
}

/** Full-cell Excel conditional formatting fill */
function excelCellTone(val: number | null, invert = false): string {
  if (val === null) return 'text-[#9ca3af] bg-transparent';
  if (invert) {
    if (val <= 5) return 'text-[#166534] bg-[#dcfce7]/55 font-semibold';
    if (val <= 15) return 'text-[#854d0e] bg-[#fef9c3]/75 font-semibold';
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

const SUMMARY_COL_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'];
const DETAIL_COL_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];

export const ParsingTableView: React.FC<Props> = ({
  runId,
  units,
  docs,
  getUnitEffectiveState,
  onSelectUnit,
}) => {
  const [subTab, setSubTab] = useState<TableSubTab>('summary');
  const [metricTab, setMetricTab] = useState<MetricTab>('ALL');
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('ALL');
  const [docCodeFilter, setDocCodeFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Per-document summary rows (aligned with backend compute_parsing_metrics)
  const docSummaryRows = useMemo(() => {
    const byDoc = new Map<
      string,
      {
        doc_code: string;
        filename: string;
        format_group: string;
        units: ParsingUnit[];
      }
    >();

    for (const u of units) {
      const entry = byDoc.get(u.doc_code) || {
        doc_code: u.doc_code,
        filename: u.filename,
        format_group: u.format_group,
        units: [],
      };
      entry.units.push(u);
      byDoc.set(u.doc_code, entry);
    }

    return Array.from(byDoc.values())
      .sort((a, b) => a.doc_code.localeCompare(b.doc_code, undefined, { numeric: true }))
      .map((d) => {
        const all = d.units;
        const textU = all.filter((u) => u.unit_type !== 'table' && u.unit_type !== 'image' && u.unit_type !== 'diagram');
        const tableU = all.filter((u) => u.unit_type === 'table');
        const layoutImgU = all.filter((u) => u.unit_type === 'image' || u.unit_type === 'diagram');

        const textPass = textU.filter((u) => getUnitEffectiveState(u) === 'PASS').length;
        const tablePass = tableU.filter((u) => getUnitEffectiveState(u) === 'PASS').length;
        const layoutImgPass = layoutImgU.filter((u) => getUnitEffectiveState(u) === 'PASS').length;

        const layoutOk = all.filter((u) => {
          const { codes } = getEffectiveCodes(u);
          const hasLayoutErr = codes.some((c) => c === 'LAYOUT' || c === 'P2' || c === 'P7' || c === 'P8');
          const failedImg = (u.unit_type === 'image' || u.unit_type === 'diagram') && getUnitEffectiveState(u) !== 'PASS';
          return !hasLayoutErr && !failedImg;
        }).length;

        const charErr = all.filter((u) => {
          const { codes } = getEffectiveCodes(u);
          return u.char_error === 1 || codes.some((c) => c === 'P4' || c === 'P5' || c === 'P6');
        }).length;

        const orderErr = all.filter((u) => {
          const { codes } = getEffectiveCodes(u);
          return codes.some((c) => c === 'P3' || c === 'ORDER');
        }).length;
        const orderPass = all.length - orderErr;

        const fidelityPass = all.filter((u) => {
          const { codes } = getEffectiveCodes(u);
          return u.fidelity_error !== 1 && !codes.some((c) => c === 'P10' || c === 'FIDELITY');
        }).length;

        const textPct = textU.length ? (textPass / textU.length) * 100 : null;
        const tablePct = tableU.length ? (tablePass / tableU.length) * 100 : null;
        const cerPct = all.length ? (charErr / all.length) * 100 : 0;
        const layoutPct = all.length ? (layoutOk / all.length) * 100 : null;
        const orderPct = all.length ? (orderPass / all.length) * 100 : null;
        const fidelityPct = all.length ? (fidelityPass / all.length) * 100 : null;

        const weightedTerms: [number, number | null][] = [
          [0.25, textPct],
          [0.20, fidelityPct],
          [0.20, tablePct],
          [0.15, all.length ? 100 - cerPct : null],
          [0.10, layoutPct],
          [0.10, orderPct],
        ];
        const availTerms = weightedTerms.filter(([, v]) => v !== null) as [number, number][];
        const wSum = availTerms.reduce((acc, [w]) => acc + w, 0);
        const parsingScore = wSum > 0 ? availTerms.reduce((acc, [w, v]) => acc + w * v, 0) / wSum : 0;

        return {
          doc_code: d.doc_code,
          filename: d.filename,
          format_group: d.format_group,
          totalUnits: all.length,
          textTotal: textU.length,
          textPass,
          textPct,
          tableTotal: tableU.length,
          tablePass,
          tablePct,
          charErr,
          cerPct,
          layoutTotal: layoutImgU.length,
          layoutPass: layoutImgPass,
          layoutOk,
          layoutPct,
          orderErr,
          orderPass,
          orderPct,
          fidelityPass,
          fidelityPct,
          parsingScore,
        };
      });
  }, [units, getUnitEffectiveState]);

  const overall = useMemo(() => {
    const sum = (fn: (r: (typeof docSummaryRows)[number]) => number) =>
      docSummaryRows.reduce((acc, r) => acc + fn(r), 0);

    const totalUnits = sum((r) => r.totalUnits);
    const textTotal = sum((r) => r.textTotal);
    const textPass = sum((r) => r.textPass);
    const tableTotal = sum((r) => r.tableTotal);
    const tablePass = sum((r) => r.tablePass);
    const charErr = sum((r) => r.charErr);
    const layoutTotal = sum((r) => r.layoutTotal);
    const layoutPass = sum((r) => r.layoutPass);
    const layoutOk = sum((r) => r.layoutOk);
    const orderErr = sum((r) => r.orderErr);
    const orderPass = sum((r) => r.orderPass);
    const fidelityPass = sum((r) => r.fidelityPass);

    const textPct = textTotal ? (textPass / textTotal) * 100 : null;
    const tablePct = tableTotal ? (tablePass / tableTotal) * 100 : null;
    const cerPct = totalUnits ? (charErr / totalUnits) * 100 : 0;
    const layoutPct = totalUnits ? (layoutOk / totalUnits) * 100 : null;
    const orderPct = totalUnits ? (orderPass / totalUnits) * 100 : null;
    const fidelityPct = totalUnits ? (fidelityPass / totalUnits) * 100 : null;

    const weightedTerms: [number, number | null][] = [
      [0.25, textPct],
      [0.20, fidelityPct],
      [0.20, tablePct],
      [0.15, totalUnits ? 100 - cerPct : null],
      [0.10, layoutPct],
      [0.10, orderPct],
    ];
    const availTerms = weightedTerms.filter(([, v]) => v !== null) as [number, number][];
    const wSum = availTerms.reduce((acc, [w]) => acc + w, 0);
    const parsingScore = wSum > 0 ? availTerms.reduce((acc, [w, v]) => acc + w * v, 0) / wSum : 0;

    return {
      docCount: docSummaryRows.length,
      totalUnits,
      textTotal,
      textPass,
      textPct,
      tableTotal,
      tablePass,
      tablePct,
      charErr,
      cerPct,
      layoutTotal,
      layoutPass,
      layoutOk,
      layoutPct,
      orderErr,
      orderPass,
      orderPct,
      fidelityPass,
      fidelityPct,
      parsingScore,
    };
  }, [docSummaryRows]);

  // Filtered rows for Detail sheet
  const detailRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return units.filter((u) => {
      if (docCodeFilter !== 'ALL' && u.doc_code !== docCodeFilter) return false;

      const state = getUnitEffectiveState(u);
      if (verdictFilter === 'UNRATED' && u.verdict !== 'UNRATED') return false;
      if (verdictFilter === 'PASS' && state !== 'PASS') return false;
      if (verdictFilter === 'FAIL' && state !== 'FAIL') return false;

      const { codes } = getEffectiveCodes(u);
      if (metricTab === 'TEXT' && (u.unit_type === 'table' || u.unit_type === 'image' || u.unit_type === 'diagram')) {
        return false;
      }
      if (metricTab === 'TABLE' && u.unit_type !== 'table') return false;
      if (
        metricTab === 'LAYOUT' &&
        u.unit_type !== 'image' &&
        u.unit_type !== 'diagram' &&
        !codes.some((c) => c === 'P2' || c === 'P7' || c === 'P8' || c === 'LAYOUT')
      ) {
        return false;
      }
      if (metricTab === 'ORDER' && !codes.some((c) => c === 'P3' || c === 'ORDER')) return false;
      if (metricTab === 'FIDELITY' && u.fidelity_error !== 1 && !codes.some((c) => c === 'P10' || c === 'FIDELITY')) return false;

      if (q) {
        const hay = `${u.doc_code} ${u.title} ${u.source_text} ${u.notes || ''} ${codes.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [units, docCodeFilter, verdictFilter, metricTab, searchQuery, getUnitEffectiveState]);

  const docCodes = useMemo(
    () =>
      Array.from(new Set(units.map((u) => u.doc_code))).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      ),
    [units]
  );

  const cellBorder = 'border border-[#d1d5db]';
  const hdrBorder = 'border border-[#cbd5e1]';
  const SUMMARY_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'];
  const DETAIL_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
  const [ctxMenu, setCtxMenu] = useState<ExcelMenuState | null>(null);

  const openCellMenu = (
    e: React.MouseEvent<HTMLTableRowElement>,
    cols: string[],
    opts: { onOpen?: () => void; openLabel?: string }
  ) => {
    const info = extractExcelCellInfo(e.target as HTMLElement, cols);
    if (!info) return;
    e.preventDefault();
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
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-white select-text">
      {/* Compact Excel Formula / Summary Ribbon */}
      <div className="shrink-0 bg-[#f8fafc] border-b border-[#cbd5e1] px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
        <div className="flex flex-wrap items-center divide-x divide-[#d1d5db] font-mono">
          <div className="pr-2.5 flex items-center gap-1.5 font-sans">
            <span className="font-semibold text-[#1e293b]">Score:</span>
            <span className="font-mono font-bold text-[#166534] text-xs">{fmtPct(overall.parsingScore)}</span>
          </div>
          <div className="px-2.5 flex items-center gap-1">
            <span className="text-[#64748b] font-sans">Text:</span>
            <span className="font-semibold text-[#1e293b]">{fmtPct(overall.textPct)}</span>
            <span className="text-[10px] text-[#94a3b8]">({overall.textPass}/{overall.textTotal})</span>
          </div>
          <div className="px-2.5 flex items-center gap-1">
            <span className="text-[#64748b] font-sans">Table:</span>
            <span className="font-semibold text-[#1e293b]">{fmtPct(overall.tablePct)}</span>
            <span className="text-[10px] text-[#94a3b8]">({overall.tablePass}/{overall.tableTotal})</span>
          </div>
          <div className="px-2.5 flex items-center gap-1">
            <span className="text-[#64748b] font-sans">CER:</span>
            <span className="font-semibold text-[#1e293b]">{fmtPct(overall.cerPct)}</span>
            <span className="text-[10px] text-[#94a3b8]">({overall.charErr})</span>
          </div>
          <div className="px-2.5 flex items-center gap-1">
            <span className="text-[#64748b] font-sans">Layout:</span>
            <span className="font-semibold text-[#1e293b]">{fmtPct(overall.layoutPct)}</span>
            {overall.layoutTotal > 0 && (
              <span className="text-[10px] text-[#94a3b8]">({overall.layoutPass}/{overall.layoutTotal} hình)</span>
            )}
          </div>
          <div className="px-2.5 flex items-center gap-1">
            <span className="text-[#64748b] font-sans">ROA:</span>
            <span className="font-semibold text-[#1e293b]">{fmtPct(overall.orderPct)}</span>
          </div>
          <div className="pl-2.5 flex items-center gap-1">
            <span className="text-[#64748b] font-sans">Fidelity:</span>
            <span className="font-semibold text-[#1e293b]">{fmtPct(overall.fidelityPct)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="text-[11px] text-[#64748b] font-sans hidden xl:block">
            Chuột phải ô để Copy · Nhấp đúp dòng để mở đối chiếu · {overall.docCount}/{docs.length || overall.docCount} tài liệu · {overall.totalUnits} đoạn
          </div>
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

      {/* Main Spreadsheet Viewport */}
      {subTab === 'summary' ? (
        <div className="flex-1 overflow-auto bg-white">
          <table className="w-full border-collapse text-[12px] tabular-nums">
            <thead className="sticky top-0 z-20">
              {/* Excel Column Letters Row */}
              <tr className="bg-[#f1f5f9] text-[#64748b] font-mono text-[10px]">
                <th className={`sticky left-0 z-30 bg-[#e2e8f0] ${hdrBorder} w-8 py-0.5 text-center select-none`} />
                {SUMMARY_COL_LETTERS.map((col, idx) => (
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
              {/* Tier 1 Grouped Headers */}
              <tr className="bg-[#e6f0ea] text-[#1e293b] text-[11px] font-semibold">
                <th
                  rowSpan={2}
                  className={`sticky left-0 z-30 bg-[#e2e8f0] ${hdrBorder} w-8 text-center font-mono text-[10px] text-[#64748b]`}
                >
                  #
                </th>
                <th
                  rowSpan={2}
                  className={`sticky left-8 z-30 bg-[#e6f0ea] ${hdrBorder} px-2 py-1.5 text-left whitespace-nowrap`}
                >
                  Mã
                </th>
                <th rowSpan={2} className={`${hdrBorder} px-2.5 py-1.5 text-left min-w-[230px]`}>
                  Tên tài liệu
                </th>
                <th rowSpan={2} className={`${hdrBorder} px-2.5 py-1.5 text-left whitespace-nowrap`}>
                  Nhóm định dạng
                </th>
                <th colSpan={2} className={`${hdrBorder} px-2 py-1 text-center whitespace-nowrap bg-[#e2ece7]`}>
                  Văn bản (Text)
                </th>
                <th colSpan={2} className={`${hdrBorder} px-2 py-1 text-center whitespace-nowrap bg-[#e8eef5]`}>
                  Bảng biểu (Table)
                </th>
                <th colSpan={2} className={`${hdrBorder} px-2 py-1 text-center whitespace-nowrap bg-[#f5efe6]`}>
                  Lỗi ký tự (CER)
                </th>
                <th colSpan={2} className={`${hdrBorder} px-2 py-1 text-center whitespace-nowrap bg-[#eee9f5]`}>
                  Hình &amp; Bố cục
                </th>
                <th colSpan={2} className={`${hdrBorder} px-2 py-1 text-center whitespace-nowrap bg-[#e6f0ea]`}>
                  Thứ tự (ROA)
                </th>
                <th rowSpan={2} className={`${hdrBorder} px-2 py-1.5 text-right whitespace-nowrap`}>
                  Fidelity %
                </th>
                <th
                  rowSpan={2}
                  className={`${hdrBorder} px-2.5 py-1.5 text-right whitespace-nowrap bg-[#d1fae5]/70 text-[#14532d]`}
                >
                  Score
                </th>
              </tr>
              {/* Tier 2 Sub-headers */}
              <tr className="bg-[#f8fafc] text-[#475569] text-[10.5px] font-semibold">
                <th className={`${hdrBorder} px-2 py-1 text-right whitespace-nowrap`}>Đạt/Tổng</th>
                <th className={`${hdrBorder} px-2 py-1 text-right whitespace-nowrap`}>Text %</th>
                <th className={`${hdrBorder} px-2 py-1 text-right whitespace-nowrap`}>Đạt/Tổng</th>
                <th className={`${hdrBorder} px-2 py-1 text-right whitespace-nowrap`}>Table %</th>
                <th className={`${hdrBorder} px-2 py-1 text-right whitespace-nowrap`}>Số lỗi</th>
                <th className={`${hdrBorder} px-2 py-1 text-right whitespace-nowrap`}>CER %</th>
                <th className={`${hdrBorder} px-2 py-1 text-right whitespace-nowrap`}>Hình</th>
                <th className={`${hdrBorder} px-2 py-1 text-right whitespace-nowrap`}>Layout %</th>
                <th className={`${hdrBorder} px-2 py-1 text-right whitespace-nowrap`}>Sai TT</th>
                <th className={`${hdrBorder} px-2 py-1 text-right whitespace-nowrap`}>ROA %</th>
              </tr>
            </thead>
            <tbody>
              {docSummaryRows.map((r, rowIdx) => (
                <tr
                  key={r.doc_code}
                  onDoubleClick={() => {
                    setDocCodeFilter(r.doc_code);
                    setMetricTab('ALL');
                    setVerdictFilter('ALL');
                    setSubTab('detail');
                  }}
                  onContextMenu={(e) =>
                    openCellMenu(e, SUMMARY_COLS, {
                      onOpen: () => {
                        setDocCodeFilter(r.doc_code);
                        setMetricTab('ALL');
                        setVerdictFilter('ALL');
                        setSubTab('detail');
                      },
                      openLabel: `Lọc chi tiết ${r.doc_code}`,
                    })
                  }
                  className="bg-white even:bg-[#f9fafb] hover:bg-[#f2fbf6] cursor-cell group"
                >
                  <td
                    className={`sticky left-0 z-10 bg-[#f1f5f9] group-hover:bg-[#dbeafe] ${cellBorder} text-center font-mono text-[10.5px] text-[#64748b] py-1.5 select-none`}
                  >
                    {rowIdx + 1}
                  </td>
                  <td
                    className={`sticky left-8 z-10 bg-white group-even:bg-[#f9fafb] group-hover:bg-[#eff6ff] ${cellBorder} px-2 py-1.5 font-mono font-semibold text-[#0f172a] whitespace-nowrap`}
                  >
                    {r.doc_code}
                  </td>
                  <td
                    className={`${cellBorder} px-2.5 py-1.5 text-[#0f172a] max-w-[290px] truncate`}
                    title={r.filename}
                  >
                    {r.filename}
                  </td>
                  <td className={`${cellBorder} px-2.5 py-1.5 text-[#475569] whitespace-nowrap text-[11px]`}>
                    {r.format_group}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono text-[#475569] whitespace-nowrap`}>
                    {r.textTotal > 0 ? `${r.textPass}/${r.textTotal}` : '—'}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono whitespace-nowrap ${excelCellTone(r.textPct)}`}>
                    {fmtPct(r.textPct)}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono text-[#475569] whitespace-nowrap`}>
                    {r.tableTotal > 0 ? `${r.tablePass}/${r.tableTotal}` : '—'}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono whitespace-nowrap ${excelCellTone(r.tablePct)}`}>
                    {fmtPct(r.tablePct)}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono text-[#475569] whitespace-nowrap`}>
                    {r.charErr}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono whitespace-nowrap ${excelCellTone(r.cerPct, true)}`}>
                    {fmtPct(r.cerPct)}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono text-[#475569] whitespace-nowrap`}>
                    {r.layoutTotal > 0 ? `${r.layoutPass}/${r.layoutTotal}` : '—'}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono whitespace-nowrap ${excelCellTone(r.layoutPct)}`}>
                    {fmtPct(r.layoutPct)}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono text-[#475569] whitespace-nowrap`}>
                    {r.orderErr}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono whitespace-nowrap ${excelCellTone(r.orderPct)}`}>
                    {fmtPct(r.orderPct)}
                  </td>
                  <td className={`${cellBorder} px-2 py-1.5 text-right font-mono whitespace-nowrap ${excelCellTone(r.fidelityPct)}`}>
                    {fmtPct(r.fidelityPct)}
                  </td>
                  <td
                    className={`${cellBorder} px-2.5 py-1.5 text-right font-mono font-bold whitespace-nowrap ${excelCellTone(r.parsingScore)}`}
                  >
                    {fmtPct(r.parsingScore)}
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
                  {overall.docCount} tài liệu ({overall.totalUnits} đoạn)
                </td>
                <td className={`${hdrBorder} px-2.5 py-2 text-[#475569] text-[11px]`}>Toàn bộ</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>
                  {overall.textPass}/{overall.textTotal}
                </td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{fmtPct(overall.textPct)}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>
                  {overall.tablePass}/{overall.tableTotal}
                </td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{fmtPct(overall.tablePct)}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{overall.charErr}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{fmtPct(overall.cerPct)}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>
                  {overall.layoutTotal > 0 ? `${overall.layoutPass}/${overall.layoutTotal}` : '—'}
                </td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{fmtPct(overall.layoutPct)}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{overall.orderErr}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{fmtPct(overall.orderPct)}</td>
                <td className={`${hdrBorder} px-2 py-2 text-right font-mono`}>{fmtPct(overall.fidelityPct)}</td>
                <td className={`${hdrBorder} px-2.5 py-2 text-right font-mono font-bold text-[#14532d] bg-[#bbf7d0]/70`}>
                  {fmtPct(overall.parsingScore)}
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
                  { id: 'TEXT', label: 'Text' },
                  { id: 'TABLE', label: 'Table' },
                  { id: 'LAYOUT', label: 'Hình & Layout' },
                  { id: 'ORDER', label: 'Reading Order' },
                  { id: 'FIDELITY', label: 'Fidelity' },
                ] as { id: MetricTab; label: string }[]
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setMetricTab(t.id)}
                  className={`px-2 py-0.5 text-[11px] border transition-colors ${
                    metricTab === t.id
                      ? 'bg-[#166534] text-white border-[#166534] font-medium'
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
                value={verdictFilter}
                onChange={(e) => setVerdictFilter(e.target.value as VerdictFilter)}
                className="py-0.5 px-2 text-[11.5px] bg-white border border-[#cbd5e1] text-[#0f172a]"
              >
                <option value="ALL">Mọi kết luận</option>
                <option value="PASS">Đúng (PASS)</option>
                <option value="FAIL">Lỗi (FAIL)</option>
                <option value="UNRATED">Chưa chấm</option>
              </select>

              <div className="relative">
                <Search className="size-3 text-[#94a3b8] absolute left-2 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Lọc nội dung, mã lỗi..."
                  className="pl-6 pr-2 py-0.5 text-[11.5px] bg-white border border-[#cbd5e1] w-48 focus:outline-none focus:border-[#166534]"
                />
              </div>

              <span className="text-[11px] font-mono text-[#475569] pl-1">
                {detailRows.length}/{units.length} dòng
              </span>
            </div>
          </div>

          {/* Excel Detail Grid */}
          <div className="flex-1 overflow-auto bg-white">
            <table className="w-full border-collapse text-[12px] tabular-nums">
              <thead className="sticky top-0 z-20">
                <tr className="bg-[#f1f5f9] text-[#64748b] font-mono text-[10px]">
                  <th className={`sticky left-0 z-30 bg-[#e2e8f0] ${hdrBorder} w-9 py-0.5 text-center select-none`} />
                  {DETAIL_COL_LETTERS.map((col, idx) => (
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
                  <th className={`${hdrBorder} px-2 py-1.5 text-right whitespace-nowrap`}>STT</th>
                  <th className={`${hdrBorder} px-2 py-1.5 text-center whitespace-nowrap`}>Loại</th>
                  <th className={`${hdrBorder} px-2 py-1.5 text-center whitespace-nowrap`}>Trang</th>
                  <th className={`${hdrBorder} px-2.5 py-1.5 text-left min-w-[170px]`}>Đoạn / Tiêu đề</th>
                  <th className={`${hdrBorder} px-2.5 py-1.5 text-left min-w-[240px]`}>Nội dung gốc</th>
                  <th className={`${hdrBorder} px-2 py-1.5 text-left whitespace-nowrap`}>Chunk khớp</th>
                  <th className={`${hdrBorder} px-2 py-1.5 text-center whitespace-nowrap`}>Kết luận</th>
                  <th className={`${hdrBorder} px-2 py-1.5 text-left whitespace-nowrap`}>Mã lỗi</th>
                  <th className={`${hdrBorder} px-2 py-1.5 text-left whitespace-nowrap`}>Nhóm / Mức độ</th>
                  <th className={`${hdrBorder} px-2.5 py-1.5 text-left min-w-[200px]`}>Ghi chú lỗi</th>
                </tr>
              </thead>
              <tbody>
                {detailRows.length === 0 ? (
                  <tr>
                    <td colSpan={12} className={`${cellBorder} text-center py-10 text-[#64748b]`}>
                      Không có dòng nào khớp bộ lọc hiện tại.
                    </td>
                  </tr>
                ) : (
                  detailRows.map((u, idx) => {
                    const effectiveState = getUnitEffectiveState(u);
                    const { codes, isAuto } = getEffectiveCodes(u);
                    const { groups, severity } = getGroupAndSeverity(codes);
                    const displaySeverity = u.severity || severity;
                    const topChunk = u.matched_chunks?.[0];
                    const simPct =
                      topChunk?.alignment?.text_similarity !== undefined
                        ? Math.round(topChunk.alignment.text_similarity)
                        : Math.round((u.match_score || 0) * 100);
                    const autoNote =
                      !u.notes && isAuto && topChunk?.alignment?.risk_flags?.length
                        ? topChunk.alignment.risk_flags.map((f) => f.label).join('; ')
                        : '';
                    const typeLabel =
                      u.unit_type === 'table' ? 'TABLE' : u.unit_type === 'image' || u.unit_type === 'diagram' ? 'IMAGE' : 'TEXT';

                    return (
                      <tr
                        key={u.id}
                        onDoubleClick={() => onSelectUnit(u)}
                        onContextMenu={(e) =>
                          openCellMenu(e, DETAIL_COLS, {
                            onOpen: () => onSelectUnit(u),
                            openLabel: `Mở đối chiếu ${u.doc_code || ''} #${u.unit_index}`,
                          })
                        }
                        className="bg-white even:bg-[#f9fafb] hover:bg-[#f2fbf6] cursor-cell align-top group"
                      >
                        <td
                          className={`sticky left-0 z-10 bg-[#f1f5f9] group-hover:bg-[#dbeafe] ${cellBorder} text-center font-mono text-[10.5px] text-[#64748b] py-1.5 select-none`}
                        >
                          {idx + 1}
                        </td>
                        <td
                          className={`sticky left-9 z-10 bg-white group-even:bg-[#f9fafb] group-hover:bg-[#eff6ff] ${cellBorder} px-2 py-1.5 font-mono font-semibold text-[#0f172a] whitespace-nowrap`}
                        >
                          {u.doc_code}
                        </td>
                        <td className={`${cellBorder} px-2 py-1.5 text-right font-mono text-[#64748b] whitespace-nowrap`}>
                          {u.unit_index}
                        </td>
                        <td className={`${cellBorder} px-2 py-1.5 text-center font-mono text-[10px] font-semibold text-[#475569] whitespace-nowrap`}>
                          {typeLabel}
                        </td>
                        <td className={`${cellBorder} px-2 py-1.5 text-center font-mono text-[#475569] whitespace-nowrap`}>
                          {u.page_num || '—'}
                        </td>
                        <td className={`${cellBorder} px-2.5 py-1.5 text-[#0f172a] max-w-[200px]`} title={u.title}>
                          <div className="line-clamp-2 font-medium text-[11.5px]">{u.title || `Đoạn #${u.unit_index}`}</div>
                        </td>
                        <td className={`${cellBorder} px-2.5 py-1.5 text-[#334155] max-w-[280px]`} title={u.source_text}>
                          <div className="line-clamp-2 text-[11.5px] leading-snug">{u.source_text}</div>
                        </td>
                        <td className={`${cellBorder} px-2 py-1.5 font-mono text-[11px] text-[#475569] whitespace-nowrap`}>
                          {u.matched_chunks && u.matched_chunks.length > 0 ? (
                            <div className="flex flex-col gap-0.5">
                              {u.matched_chunks.slice(0, 2).map((c) => {
                                const fullId = c.ragflow_chunk_id || '';
                                const shortId = fullId ? `${fullId.slice(0, 10)}…` : '';
                                return (
                                  <span
                                    key={fullId || c.chunk_index}
                                    onClick={(e) => {
                                      if (!fullId) return;
                                      e.stopPropagation();
                                      navigator.clipboard?.writeText(fullId).catch(() => {});
                                    }}
                                    title={fullId ? `Chunk #${c.chunk_index} · ID: ${fullId} (nhấn để copy ID)` : `Chunk #${c.chunk_index}`}
                                    className="inline-flex items-center gap-1 cursor-pointer hover:text-[#03aa5c] transition-colors"
                                  >
                                    <span className="font-semibold text-[#18181b]">#{c.chunk_index}</span>
                                    {shortId && <span className="text-[10px] text-[#64748b]">{shortId}</span>}
                                  </span>
                                );
                              })}
                              <span className="text-[10px] text-[#94a3b8]">Khớp {simPct}%</span>
                            </div>
                          ) : (
                            <span className="text-[#991b1b] font-semibold">Không khớp</span>
                          )}
                        </td>
                        <td
                          className={`${cellBorder} px-2 py-1.5 text-center font-mono text-[11px] font-bold whitespace-nowrap ${
                            effectiveState === 'PASS'
                              ? 'bg-[#dcfce7]/70 text-[#166534]'
                              : 'bg-[#fee2e2]/75 text-[#991b1b]'
                          }`}
                        >
                          {effectiveState === 'PASS' ? 'ĐẠT' : 'LỖI'}
                        </td>
                        <td className={`${cellBorder} px-2 py-1.5 font-mono text-[11px] font-semibold text-[#991b1b] whitespace-nowrap`}>
                          {codes.length > 0 ? codes.join(', ') : <span className="text-[#cbd5e1] font-normal">—</span>}
                        </td>
                        <td className={`${cellBorder} px-2 py-1.5 text-[11px] text-[#475569] whitespace-nowrap`}>
                          {groups.length > 0 ? (
                            <span>
                              {groups[0]}
                              {displaySeverity ? ` · ${displaySeverity}` : ''}
                            </span>
                          ) : (
                            <span className="text-[#cbd5e1]">—</span>
                          )}
                        </td>
                        <td className={`${cellBorder} px-2.5 py-1.5 text-[11.5px] text-[#334155] max-w-[260px]`}>
                          {u.notes ? (
                            <div className="line-clamp-2">{u.notes}</div>
                          ) : autoNote ? (
                            <div className="line-clamp-2 italic text-[#94a3b8]">{autoNote}</div>
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
            onClick={() => setSubTab('summary')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[11.5px] border-x border-t transition-colors ${
              subTab === 'summary'
                ? 'bg-white text-[#166534] font-semibold border-[#cbd5e1] border-t-2 border-t-[#166534] -mb-px'
                : 'bg-[#f1f5f9] text-[#475569] border-transparent hover:bg-[#f8fafc] hover:text-[#0f172a]'
            }`}
          >
            <FileSpreadsheet className="size-3.5" />
            Tong_hop_diem ({overall.docCount})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('detail')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[11.5px] border-x border-t transition-colors ${
              subTab === 'detail'
                ? 'bg-white text-[#166534] font-semibold border-[#cbd5e1] border-t-2 border-t-[#166534] -mb-px'
                : 'bg-[#f1f5f9] text-[#475569] border-transparent hover:bg-[#f8fafc] hover:text-[#0f172a]'
            }`}
          >
            <Table2 className="size-3.5" />
            Chi_tiet_tung_doan ({units.length})
          </button>
        </div>
        <div className="pb-1 pr-2 text-[10.5px] font-mono text-[#64748b]">
          Sheet: {subTab === 'summary' ? `A1:O${docSummaryRows.length + 3}` : `A1:K${detailRows.length + 2}`}
        </div>
      </div>

      <ExcelContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
    </div>
  );
};
