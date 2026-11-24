import React, { useMemo, useState } from 'react';
import { ExternalLink, FileSpreadsheet, Filter, Search, Table2 } from 'lucide-react';
import { DocumentItem, ParsingUnit } from '../types';

interface Props {
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
  // Fallback for legacy coarse codes
  TEXT: { group: 'Lỗi ký tự', name: 'Thiếu chữ / Lỗi dấu & OCR', severity: 'Nghiêm trọng' },
  TABLE: { group: 'Vỡ bảng', name: 'Vỡ cấu trúc bảng / Sai số liệu', severity: 'Nghiêm trọng' },
  ORDER: { group: 'Sai thứ tự', name: 'Sai thứ tự đọc / Đảo cột', severity: 'Trung bình' },
  LAYOUT: { group: 'Mất nội dung', name: 'Mất nội dung ảnh / Sơ đồ / Scan', severity: 'Nghiêm trọng' },
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

function pctColor(val: number | null, invert = false): string {
  if (val === null) return 'text-[#a1a1aa]';
  if (invert) {
    if (val <= 5) return 'text-[#027a42] bg-[#f2f7f4]';
    if (val <= 15) return 'text-[#b45309] bg-[#fffbeb]';
    return 'text-[#b91c1c] bg-[#fef2f2]';
  }
  if (val >= 85) return 'text-[#027a42] bg-[#f2f7f4]';
  if (val >= 65) return 'text-[#b45309] bg-[#fffbeb]';
  return 'text-[#b91c1c] bg-[#fef2f2]';
}

function fmtPct(val: number | null): string {
  if (val === null) return '—';
  return `${val.toFixed(1)}%`;
}

export const ParsingTableView: React.FC<Props> = ({
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

  // Per-document summary rows (mirrors "Tổng hợp điểm" sheet)
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
        const layoutU = all.filter((u) => u.unit_type === 'image' || u.unit_type === 'diagram');

        const textPass = textU.filter((u) => getUnitEffectiveState(u) === 'PASS').length;
        const tablePass = tableU.filter((u) => getUnitEffectiveState(u) === 'PASS').length;
        const layoutPass = layoutU.filter((u) => getUnitEffectiveState(u) === 'PASS').length;
        const layoutTotal = layoutU.length;

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
          return !codes.some((c) => c === 'P3' || c === 'P10' || c === 'FIDELITY');
        }).length;

        const textPct = textU.length ? (textPass / textU.length) * 100 : null;
        const tablePct = tableU.length ? (tablePass / tableU.length) * 100 : null;
        const cerPct = all.length ? (charErr / all.length) * 100 : 0;
        const layoutPct = layoutTotal ? (layoutPass / layoutTotal) * 100 : null;
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
          layoutTotal,
          layoutPass,
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

  // Overall totals for KPI bar & tfoot
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
    const orderErr = sum((r) => r.orderErr);
    const orderPass = sum((r) => r.orderPass);
    const fidelityPass = sum((r) => r.fidelityPass);

    const textPct = textTotal ? (textPass / textTotal) * 100 : null;
    const tablePct = tableTotal ? (tablePass / tableTotal) * 100 : null;
    const cerPct = totalUnits ? (charErr / totalUnits) * 100 : 0;
    const layoutPct = layoutTotal ? (layoutPass / layoutTotal) * 100 : null;
    const orderPct = totalUnits ? (orderPass / totalUnits) * 100 : null;
    const fidelityPct = totalUnits ? (fidelityPass / totalUnits) * 100 : null;

    const vText = textPct ?? 0;
    const vFid = fidelityPct ?? 0;
    const vTbl = tablePct ?? vText;
    const vLay = layoutPct ?? 0;
    const vOrd = orderPct ?? 0;
    const parsingScore = totalUnits
      ? 0.25 * vText + 0.20 * vFid + 0.20 * vTbl + 0.15 * (100 - cerPct) + 0.10 * vLay + 0.10 * vOrd
      : 0;

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
      layoutPct,
      orderErr,
      orderPass,
      orderPct,
      fidelityPass,
      fidelityPct,
      parsingScore,
    };
  }, [docSummaryRows]);

  // Filtered rows for Detail tab
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
        !codes.some((c) => c === 'P2' || c === 'LAYOUT')
      ) {
        return false;
      }
      if (metricTab === 'ORDER' && !codes.some((c) => c === 'P3' || c === 'ORDER')) return false;
      if (metricTab === 'FIDELITY' && !codes.some((c) => c === 'P3' || c === 'P10' || c === 'FIDELITY')) return false;

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

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#fafaf9]">
      {/* Sub-tab Switcher Bar */}
      <div className="shrink-0 px-5 py-2.5 bg-white border-b border-[#e8e8e6] flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center p-0.5 rounded-lg bg-[#f4f4f2] border border-[#e6e4de]">
          <button
            type="button"
            onClick={() => setSubTab('summary')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              subTab === 'summary'
                ? 'bg-white text-[#18181b] shadow-xs'
                : 'text-[#71717a] hover:text-[#18181b]'
            }`}
          >
            <FileSpreadsheet className="size-3.5" />
            Tổng hợp điểm ({overall.docCount} tài liệu)
          </button>
          <button
            type="button"
            onClick={() => setSubTab('detail')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              subTab === 'detail'
                ? 'bg-white text-[#18181b] shadow-xs'
                : 'text-[#71717a] hover:text-[#18181b]'
            }`}
          >
            <Table2 className="size-3.5" />
            Chi tiết từng đoạn ({units.length})
          </button>
        </div>

        <div className="text-[11px] text-[#78716c]">
          Click vào dòng bất kỳ để mở <span className="font-medium text-[#18181b]">đối chiếu Side-by-Side</span> &amp; sửa điểm
        </div>
      </div>

      {subTab === 'summary' ? (
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {/* Top KPI Strip (matching sheet "Tổng hợp điểm") */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5">
            {[
              {
                label: 'Text Completeness',
                val: fmtPct(overall.textPct),
                sub: `${overall.textPass}/${overall.textTotal} đoạn chữ`,
                cls: pctColor(overall.textPct),
              },
              {
                label: 'Table Accuracy',
                val: fmtPct(overall.tablePct),
                sub: `${overall.tablePass}/${overall.tableTotal} bảng`,
                cls: pctColor(overall.tablePct),
              },
              {
                label: 'Character Error',
                val: fmtPct(overall.cerPct),
                sub: `${overall.charErr}/${overall.totalUnits} đoạn lỗi`,
                cls: pctColor(overall.cerPct, true),
              },
              {
                label: 'Layout & Struct',
                val: fmtPct(overall.layoutPct),
                sub: `${overall.layoutPass}/${overall.layoutTotal} mục`,
                cls: pctColor(overall.layoutPct),
              },
              {
                label: 'Reading Order',
                val: fmtPct(overall.orderPct),
                sub: `${overall.orderPass}/${overall.totalUnits} đúng thứ tự`,
                cls: pctColor(overall.orderPct),
              },
              {
                label: 'Content Fidelity',
                val: fmtPct(overall.fidelityPct),
                sub: `${overall.fidelityPass}/${overall.totalUnits} trung thực`,
                cls: pctColor(overall.fidelityPct),
              },
              {
                label: 'Parsing Score',
                val: fmtPct(overall.parsingScore),
                sub: `${overall.docCount}/${docs.length || overall.docCount} tài liệu`,
                cls: 'text-[#027a42] bg-[#f2f7f4] border-[#d6eadf]',
              },
            ].map((k) => (
              <div
                key={k.label}
                className="bg-white border border-[#e6e4de] rounded-xl p-3 flex flex-col justify-between gap-1"
              >
                <div className="text-[10.5px] font-medium text-[#78716c] truncate">{k.label}</div>
                <div className={`inline-flex self-start px-1.5 py-0.5 rounded font-mono text-sm font-bold ${k.cls}`}>
                  {k.val}
                </div>
                <div className="text-[10px] text-[#a1a1aa] font-mono">{k.sub}</div>
              </div>
            ))}
          </div>

          {/* Summary Matrix Table */}
          <div className="bg-white border border-[#e6e4de] rounded-xl overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-[#f7f7f5] border-b border-[#e6e4de] text-[10.5px] text-[#52525b] uppercase tracking-wider">
                    <th className="sticky left-0 z-20 bg-[#f7f7f5] text-left px-3 py-2.5 font-semibold border-r border-[#e6e4de] whitespace-nowrap">
                      Tài liệu
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold min-w-[200px] border-r border-[#efede8]">
                      Tên tài liệu
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold whitespace-nowrap border-r border-[#efede8]">
                      Nhóm định dạng
                    </th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap">Đoạn chữ</th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap">Đúng</th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap border-r border-[#efede8]">
                      Text %
                    </th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap">Bảng</th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap">Đúng</th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap border-r border-[#efede8]">
                      Table %
                    </th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap">Lỗi KT</th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap border-r border-[#efede8]">
                      CER %
                    </th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap">Layout</th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap border-r border-[#efede8]">
                      Layout %
                    </th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap">Sai TT</th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap border-r border-[#efede8]">
                      ROA %
                    </th>
                    <th className="text-right px-2.5 py-2.5 font-semibold whitespace-nowrap">Fidelity %</th>
                    <th className="text-right px-3 py-2.5 font-semibold whitespace-nowrap bg-[#f2f7f4]/60 text-[#027a42]">
                      Score
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#efede8]">
                  {docSummaryRows.map((r) => (
                    <tr
                      key={r.doc_code}
                      onClick={() => {
                        setDocCodeFilter(r.doc_code);
                        setMetricTab('ALL');
                        setVerdictFilter('ALL');
                        setSubTab('detail');
                      }}
                      className="hover:bg-[#faf9f6] cursor-pointer transition-colors group"
                    >
                      <td className="sticky left-0 z-10 bg-white group-hover:bg-[#faf9f6] px-3 py-2 font-mono font-semibold text-[#18181b] border-r border-[#e6e4de] whitespace-nowrap">
                        {r.doc_code}
                      </td>
                      <td className="px-3 py-2 text-[#18181b] border-r border-[#efede8] max-w-[260px] truncate" title={r.filename}>
                        {r.filename}
                      </td>
                      <td className="px-3 py-2 text-[#71717a] border-r border-[#efede8] whitespace-nowrap text-[11px]">
                        {r.format_group}
                      </td>
                      <td className="px-2.5 py-2 text-right font-mono text-[#52525b]">{r.textTotal}</td>
                      <td className="px-2.5 py-2 text-right font-mono text-[#52525b]">{r.textPass}</td>
                      <td className="px-2.5 py-2 text-right font-mono border-r border-[#efede8]">
                        <span className={`px-1.5 py-0.5 rounded font-semibold ${pctColor(r.textPct)}`}>
                          {fmtPct(r.textPct)}
                        </span>
                      </td>
                      <td className="px-2.5 py-2 text-right font-mono text-[#52525b]">{r.tableTotal}</td>
                      <td className="px-2.5 py-2 text-right font-mono text-[#52525b]">{r.tablePass}</td>
                      <td className="px-2.5 py-2 text-right font-mono border-r border-[#efede8]">
                        <span className={`px-1.5 py-0.5 rounded font-semibold ${pctColor(r.tablePct)}`}>
                          {fmtPct(r.tablePct)}
                        </span>
                      </td>
                      <td className="px-2.5 py-2 text-right font-mono text-[#52525b]">{r.charErr}</td>
                      <td className="px-2.5 py-2 text-right font-mono border-r border-[#efede8]">
                        <span className={`px-1.5 py-0.5 rounded font-semibold ${pctColor(r.cerPct, true)}`}>
                          {fmtPct(r.cerPct)}
                        </span>
                      </td>
                      <td className="px-2.5 py-2 text-right font-mono text-[#52525b]">
                        {r.layoutPass}/{r.layoutTotal}
                      </td>
                      <td className="px-2.5 py-2 text-right font-mono border-r border-[#efede8]">
                        <span className={`px-1.5 py-0.5 rounded font-semibold ${pctColor(r.layoutPct)}`}>
                          {fmtPct(r.layoutPct)}
                        </span>
                      </td>
                      <td className="px-2.5 py-2 text-right font-mono text-[#52525b]">{r.orderErr}</td>
                      <td className="px-2.5 py-2 text-right font-mono border-r border-[#efede8]">
                        <span className={`px-1.5 py-0.5 rounded font-semibold ${pctColor(r.orderPct)}`}>
                          {fmtPct(r.orderPct)}
                        </span>
                      </td>
                      <td className="px-2.5 py-2 text-right font-mono">
                        <span className={`px-1.5 py-0.5 rounded font-semibold ${pctColor(r.fidelityPct)}`}>
                          {fmtPct(r.fidelityPct)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-[#027a42] bg-[#f2f7f4]/40">
                        {fmtPct(r.parsingScore)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-[#f7f7f5] border-t-2 border-[#dedede] font-semibold text-[#18181b]">
                    <td className="sticky left-0 z-10 bg-[#f7f7f5] px-3 py-2.5 font-mono border-r border-[#e6e4de]">
                      TỔNG
                    </td>
                    <td className="px-3 py-2.5 border-r border-[#efede8]">
                      {overall.docCount} tài liệu ({overall.totalUnits} đoạn)
                    </td>
                    <td className="px-3 py-2.5 border-r border-[#efede8] text-[#71717a]">Toàn bộ</td>
                    <td className="px-2.5 py-2.5 text-right font-mono">{overall.textTotal}</td>
                    <td className="px-2.5 py-2.5 text-right font-mono">{overall.textPass}</td>
                    <td className="px-2.5 py-2.5 text-right font-mono border-r border-[#efede8]">
                      {fmtPct(overall.textPct)}
                    </td>
                    <td className="px-2.5 py-2.5 text-right font-mono">{overall.tableTotal}</td>
                    <td className="px-2.5 py-2.5 text-right font-mono">{overall.tablePass}</td>
                    <td className="px-2.5 py-2.5 text-right font-mono border-r border-[#efede8]">
                      {fmtPct(overall.tablePct)}
                    </td>
                    <td className="px-2.5 py-2.5 text-right font-mono">{overall.charErr}</td>
                    <td className="px-2.5 py-2.5 text-right font-mono border-r border-[#efede8]">
                      {fmtPct(overall.cerPct)}
                    </td>
                    <td className="px-2.5 py-2.5 text-right font-mono">
                      {overall.layoutPass}/{overall.layoutTotal}
                    </td>
                    <td className="px-2.5 py-2.5 text-right font-mono border-r border-[#efede8]">
                      {fmtPct(overall.layoutPct)}
                    </td>
                    <td className="px-2.5 py-2.5 text-right font-mono">{overall.orderErr}</td>
                    <td className="px-2.5 py-2.5 text-right font-mono border-r border-[#efede8]">
                      {fmtPct(overall.orderPct)}
                    </td>
                    <td className="px-2.5 py-2.5 text-right font-mono">{fmtPct(overall.fidelityPct)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-[#027a42] bg-[#f2f7f4]/70">
                      {fmtPct(overall.parsingScore)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Detail Filter Bar */}
          <div className="shrink-0 px-5 py-2.5 bg-white border-b border-[#e8e8e6] flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Filter className="size-3.5 text-[#78716c] mr-0.5" />
              {(
                [
                  { id: 'ALL', label: 'Tất cả' },
                  { id: 'TEXT', label: 'Text Completeness' },
                  { id: 'TABLE', label: 'Table Accuracy' },
                  { id: 'LAYOUT', label: 'Layout & Struct' },
                  { id: 'ORDER', label: 'Reading Order' },
                  { id: 'FIDELITY', label: 'Content Fidelity' },
                ] as { id: MetricTab; label: string }[]
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setMetricTab(t.id)}
                  className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${
                    metricTab === t.id
                      ? 'bg-[#18181b] text-white font-medium'
                      : 'bg-[#f4f4f2] text-[#52525b] hover:bg-[#e8e8e5]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={docCodeFilter}
                onChange={(e) => setDocCodeFilter(e.target.value)}
                className="py-1 px-2 text-xs bg-white border border-[#e4e4e2] rounded-md text-[#18181b]"
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
                className="py-1 px-2 text-xs bg-white border border-[#e4e4e2] rounded-md text-[#18181b]"
              >
                <option value="ALL">Mọi kết luận</option>
                <option value="PASS">Đúng (PASS)</option>
                <option value="FAIL">Lỗi (FAIL)</option>
                <option value="UNRATED">Chưa chấm</option>
              </select>

              <div className="relative">
                <Search className="size-3.5 text-[#a1a1aa] absolute left-2 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Tìm nội dung, mã lỗi..."
                  className="pl-7 pr-2.5 py-1 text-xs bg-white border border-[#e4e4e2] rounded-md w-48 focus:outline-none focus:border-[#18181b]"
                />
              </div>

              <span className="text-[11px] font-mono text-[#78716c]">
                {detailRows.length}/{units.length} dòng
              </span>
            </div>
          </div>

          {/* 11-Column Detail Table */}
          <div className="flex-1 overflow-auto p-4">
            <div className="bg-white border border-[#e6e4de] rounded-xl overflow-hidden shadow-xs">
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-[#f7f7f5] border-b border-[#e6e4de] text-[10.5px] text-[#52525b] uppercase tracking-wider">
                      <th className="text-left px-2.5 py-2.5 font-semibold whitespace-nowrap">Tài liệu</th>
                      <th className="text-right px-2 py-2.5 font-semibold whitespace-nowrap">STT</th>
                      <th className="text-left px-2.5 py-2.5 font-semibold min-w-[160px]">Đoạn / Tiêu đề</th>
                      <th className="text-center px-2 py-2.5 font-semibold whitespace-nowrap">Trang</th>
                      <th className="text-left px-2.5 py-2.5 font-semibold min-w-[240px]">Nội dung gốc</th>
                      <th className="text-left px-2.5 py-2.5 font-semibold whitespace-nowrap">Chunk đối chiếu</th>
                      <th className="text-center px-2.5 py-2.5 font-semibold whitespace-nowrap">Kết luận</th>
                      <th className="text-left px-2.5 py-2.5 font-semibold whitespace-nowrap">Nhóm lỗi</th>
                      <th className="text-left px-2.5 py-2.5 font-semibold whitespace-nowrap">Mã lỗi</th>
                      <th className="text-left px-2.5 py-2.5 font-semibold whitespace-nowrap">Mức độ</th>
                      <th className="text-left px-2.5 py-2.5 font-semibold min-w-[180px]">Ghi chú lỗi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#efede8]">
                    {detailRows.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="text-center py-10 text-[#78716c]">
                          Không có dòng nào khớp bộ lọc hiện tại.
                        </td>
                      </tr>
                    ) : (
                      detailRows.map((u) => {
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

                        return (
                          <tr
                            key={u.id}
                            onClick={() => onSelectUnit(u)}
                            className="hover:bg-[#faf9f6] cursor-pointer transition-colors align-top group"
                          >
                            <td className="px-2.5 py-2 font-mono font-semibold text-[#18181b] whitespace-nowrap">
                              <span className="inline-flex items-center gap-1">
                                {u.doc_code}
                                <ExternalLink className="size-3 text-[#a1a1aa] opacity-0 group-hover:opacity-100 transition-opacity" />
                              </span>
                            </td>
                            <td className="px-2 py-2 text-right font-mono text-[#71717a] whitespace-nowrap">
                              {u.unit_index}
                            </td>
                            <td className="px-2.5 py-2 text-[#18181b]">
                              <div className="font-medium line-clamp-2">{u.title || `Đoạn #${u.unit_index}`}</div>
                              <span className="inline-block mt-0.5 px-1.5 py-0.2 text-[9.5px] font-mono uppercase rounded bg-[#f4f4f2] text-[#71717a]">
                                {u.unit_type}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-center font-mono text-[#52525b] whitespace-nowrap">
                              {u.page_num || '—'}
                            </td>
                            <td className="px-2.5 py-2 text-[#3f3f46] max-w-[300px]" title={u.source_text}>
                              <div className="line-clamp-2 text-[11.5px] leading-relaxed">{u.source_text}</div>
                            </td>
                            <td className="px-2.5 py-2 font-mono text-[11px] text-[#52525b] whitespace-nowrap">
                              {u.matched_chunks && u.matched_chunks.length > 0 ? (
                                <div className="flex flex-col gap-0.5">
                                  <span>
                                    {u.matched_chunks
                                      .slice(0, 3)
                                      .map((c) => `#${c.chunk_index}`)
                                      .join(', ')}
                                  </span>
                                  <span className="text-[10px] text-[#a1a1aa]">{simPct}% khớp</span>
                                </div>
                              ) : (
                                <span className="text-[#b91c1c]">Không khớp</span>
                              )}
                            </td>
                            <td className="px-2.5 py-2 text-center whitespace-nowrap">
                              <div className="inline-flex flex-col items-center gap-0.5">
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[10.5px] font-medium ${
                                    effectiveState === 'PASS'
                                      ? 'bg-[#f2f7f4] text-[#027a42] border border-[#d6eadf]'
                                      : 'bg-[#fef2f2] text-[#b91c1c] border border-[#f5d0d3]'
                                  }`}
                                >
                                  {effectiveState === 'PASS' ? 'Đúng' : 'Lỗi'}
                                </span>
                                {isAuto && (
                                  <span className="text-[9px] font-mono text-[#a1a1aa]">auto</span>
                                )}
                              </div>
                            </td>
                            <td className="px-2.5 py-2 text-[11px] text-[#52525b] whitespace-nowrap">
                              {groups.length > 0 ? groups.join(', ') : <span className="text-[#d4d4d8]">—</span>}
                            </td>
                            <td className="px-2.5 py-2 whitespace-nowrap">
                              {codes.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {codes.map((code) => {
                                    const meta = PARSING_CODE_META[code];
                                    return (
                                      <span
                                        key={code}
                                        title={meta ? `${code}: ${meta.name}` : code}
                                        className={`px-1.5 py-0.5 rounded font-mono text-[10.5px] font-semibold ${
                                          isAuto
                                            ? 'border border-dashed border-[#d97706]/60 bg-[#fffbeb] text-[#b45309]'
                                            : 'border border-[#f5d0d3] bg-[#fef2f2] text-[#b91c1c]'
                                        }`}
                                      >
                                        {code}
                                      </span>
                                    );
                                  })}
                                </div>
                              ) : (
                                <span className="text-[#d4d4d8]">—</span>
                              )}
                            </td>
                            <td className="px-2.5 py-2 whitespace-nowrap text-[11px]">
                              {displaySeverity ? (
                                <span
                                  className={`px-1.5 py-0.5 rounded font-medium ${
                                    displaySeverity === 'Nghiêm trọng'
                                      ? 'bg-[#fef2f2] text-[#b91c1c]'
                                      : displaySeverity === 'Trung bình'
                                      ? 'bg-[#fffbeb] text-[#b45309]'
                                      : 'bg-[#f4f4f2] text-[#52525b]'
                                  }`}
                                >
                                  {displaySeverity}
                                </span>
                              ) : (
                                <span className="text-[#d4d4d8]">—</span>
                              )}
                            </td>
                            <td className="px-2.5 py-2 text-[11px] text-[#52525b] max-w-[240px]">
                              {u.notes ? (
                                <div className="line-clamp-2">{u.notes}</div>
                              ) : autoNote ? (
                                <div className="line-clamp-2 italic text-[#a1a1aa]">{autoNote}</div>
                              ) : (
                                <span className="text-[#d4d4d8]">—</span>
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
          </div>
        </div>
      )}
    </div>
  );
};
