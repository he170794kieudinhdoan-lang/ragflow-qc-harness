import React, { useEffect, useState } from 'react';
import { diffChars, diffWordsWithSpace } from 'diff';
import { ArrowRight, BarChart3, ChevronLeft, ChevronRight, Loader2, Lock, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { DocumentItem, ErrorCodeDef, ParsingUnit, RunItem } from '../types';

interface Props {
  activeRun: RunItem | null;
  errorCatalog: ErrorCodeDef[];
  onNextStep?: () => void;
  onProgressChange?: (rated: number, total: number) => void;
}

type ColorFilter = 'ALL' | 'PASS' | 'PARTIAL' | 'FAIL';

export const ParsingPage: React.FC<Props> = ({ activeRun, errorCatalog, onNextStep, onProgressChange }) => {
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<number | undefined>(undefined);
  const [units, setUnits] = useState<ParsingUnit[]>([]);
  const [selectedUnit, setSelectedUnit] = useState<ParsingUnit | null>(null);
  const [hoveredUnit, setHoveredUnit] = useState<ParsingUnit | null>(null);
  const [colorFilter, setColorFilter] = useState<ColorFilter>('ALL');
  const [metrics, setMetrics] = useState<any>(null);
  const [showAdd, setShowAdd] = useState(false);

  const [newType, setNewType] = useState('text');
  const [newPage, setNewPage] = useState(1);
  const [newTitle, setNewTitle] = useState('');
  const [newText, setNewText] = useState('');

  const [errCodes, setErrCodes] = useState<string[]>([]);
  const [autoSuggested, setAutoSuggested] = useState(false);
  const [charErr, setCharErr] = useState(false);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [showDiff, setShowDiff] = useState(true);
  const [checkFormat, setCheckFormat] = useState(false);
  const [charLevel, setCharLevel] = useState(false);
  const [showFullChunk, setShowFullChunk] = useState(false);
  const [showCharts, setShowCharts] = useState(false);

  const getUnitEffectiveState = (u: ParsingUnit): 'PASS' | 'PARTIAL' | 'FAIL' => {
    if (u.verdict === 'PASS' || u.verdict === 'PARTIAL' || u.verdict === 'FAIL') return u.verdict;
    if (!u.matched_chunks || u.matched_chunks.length === 0) return 'FAIL';
    return u.matched_chunks[0]?.alignment?.suggested_verdict || 'PARTIAL';
  };

  const filteredUnits = units.filter((u) => {
    if (colorFilter === 'ALL') return true;
    return getUnitEffectiveState(u) === colorFilter;
  });

  const selectUnit = (u: ParsingUnit) => {
    setSelectedUnit(u);
    if (u.verdict === 'UNRATED') {
      const suggested =
        u.matched_chunks && u.matched_chunks.length > 0
          ? u.matched_chunks[0]?.alignment?.suggested_error_codes || []
          : [u.unit_type === 'image' || u.unit_type === 'diagram' ? 'P2' : 'P1'];
      setErrCodes(suggested);
      setAutoSuggested(suggested.length > 0);
      setCharErr(suggested.some((c) => c === 'P4' || c === 'P5' || c === 'P6'));
    } else {
      setErrCodes(u.error_codes || []);
      setAutoSuggested(false);
      setCharErr(Boolean(u.char_error));
    }
    setNotes(u.notes || '');
  };

  const load = async (advanceFromId?: number) => {
    if (!activeRun) return;
    setLoading(true);
    try {
      const [dRes, uRes, mRes] = await Promise.all([
        api.listDocuments(activeRun.id),
        api.listParsingUnits(activeRun.id, selectedDocId),
        api.getParsingMetrics(activeRun.id),
      ]);
      setDocs(dRes);
      setUnits(uRes);
      setMetrics(mRes);
      onProgressChange?.(mRes?.rated_units || 0, mRes?.total_units || uRes.length);
      if (uRes.length > 0) {
        if (advanceFromId) {
          const idx = uRes.findIndex((u: ParsingUnit) => u.id === advanceFromId);
          const nextUnit = idx >= 0 && idx + 1 < uRes.length ? uRes[idx + 1] : null;
          if (nextUnit) selectUnit(nextUnit);
          else setSelectedUnit(null);
        } else if (selectedUnit) {
          const keep = uRes.find((u: ParsingUnit) => u.id === selectedUnit.id);
          if (keep) selectUnit(keep);
          else setSelectedUnit(null);
        }
      } else {
        setSelectedUnit(null);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedUnit(null);
    setHoveredUnit(null);
    load();
  }, [activeRun?.id, selectedDocId]);

  const handleScore = async (verdict: 'PASS' | 'PARTIAL' | 'FAIL') => {
    if (!selectedUnit || scoring) return;
    setScoring(true);
    const savedCodes = verdict === 'PASS' ? [] : errCodes;
    const savedCharErr = verdict === 'PASS' ? false : charErr || savedCodes.some((c) => c === 'P4' || c === 'P5' || c === 'P6');
    const savedSeverity = verdict === 'FAIL' ? 'High' : verdict === 'PARTIAL' ? 'Medium' : '';
    const scoredId = selectedUnit.id;
    try {
      await api.scoreParsingUnit(scoredId, {
        verdict,
        error_codes: savedCodes,
        char_error: savedCharErr,
        severity: savedSeverity,
        notes,
      });
      // Patch local state immediately instead of re-fetching & re-aligning all 125 units
      const updatedUnits = units.map((u) =>
        u.id === scoredId
          ? { ...u, verdict, error_codes: savedCodes, char_error: savedCharErr ? 1 : 0, severity: savedSeverity, notes }
          : u
      );
      setUnits(updatedUnits);
      const ratedNow = updatedUnits.filter((u) => u.verdict !== 'UNRATED').length;
      onProgressChange?.(ratedNow, updatedUnits.length);
      const curIdx = filteredUnits.findIndex((u) => u.id === scoredId);
      const nextFiltered = curIdx >= 0 && curIdx + 1 < filteredUnits.length ? filteredUnits[curIdx + 1] : null;
      if (nextFiltered) {
        const freshNext = updatedUnits.find((u) => u.id === nextFiltered.id) || nextFiltered;
        selectUnit(freshNext);
      } else {
        setSelectedUnit(null);
      }
      // Refresh lightweight metrics in background (~5ms)
      if (activeRun) {
        api.getParsingMetrics(activeRun.id).then(setMetrics).catch(() => {});
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setScoring(false);
    }
  };

  const stepUnit = (delta: -1 | 1) => {
    if (!selectedUnit || filteredUnits.length === 0) return;
    const idx = filteredUnits.findIndex((u) => u.id === selectedUnit.id);
    if (idx < 0) return;
    const target = filteredUnits[idx + delta];
    if (target) selectUnit(target);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        setSelectedUnit(null);
      } else if (selectedUnit && !scoring) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          stepUnit(-1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          stepUnit(1);
        } else if (e.key === '1') {
          handleScore('PASS');
        } else if (e.key === '2') {
          handleScore('PARTIAL');
        } else if (e.key === '3') {
          handleScore('FAIL');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedUnit, filteredUnits, errCodes, charErr, notes, scoring]);

  if (!activeRun) {
    return <div className="p-8 text-sm text-[#71717a]">Hãy chọn hoặc tạo một phiên kiểm thử trước.</div>;
  }

  const handleAddUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    const docId = selectedDocId || docs[0]?.id;
    if (!docId || !newText.trim()) return;
    try {
      await api.createParsingUnit(activeRun.id, {
        document_id: docId,
        unit_type: newType,
        page_num: newPage,
        title: newTitle,
        source_text: newText,
      });
      setNewTitle('');
      setNewText('');
      setShowAdd(false);
      await load();
      toast.success('Đã thêm đoạn đối chiếu.');
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const toggleCode = (code: string) => {
    setAutoSuggested(false);
    setErrCodes((prev) => {
      const next = prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code];
      if (['P4', 'P5', 'P6'].includes(code) && next.includes(code)) {
        setCharErr(true);
      }
      return next;
    });
  };

  const badge = (v: string) => {
    if (v === 'PASS') return { text: 'Đúng', cls: 'bg-[#f0fdf4] text-[#15803d] border-[#bbf7d0]' };
    if (v === 'PARTIAL') return { text: 'Thiếu 1 phần', cls: 'bg-[#fffbeb] text-[#b45309] border-[#fde68a]' };
    if (v === 'FAIL') return { text: 'Sai', cls: 'bg-[#fef2f2] text-[#b91c1c] border-[#fecaca]' };
    return { text: 'Chưa chấm', cls: 'bg-[#f4f4f2] text-[#71717a] border-[#e6e6e3]' };
  };

  // TypeSafe-inspired crisp tiles: pale when unrated, solid & bold once confirmed
  const getTileClass = (u: ParsingUnit, isSelected: boolean) => {
    const sel = isSelected
      ? 'outline outline-2 outline-[#161616] outline-offset-1 z-10'
      : 'hover:opacity-85';
    if (u.verdict === 'PASS') return `bg-[#03aa5c] ${sel}`;
    if (u.verdict === 'PARTIAL') return `bg-[#d4a72c] ${sel}`;
    if (u.verdict === 'FAIL') return `bg-[#cf222e] ${sel}`;
    const auto = getUnitEffectiveState(u);
    if (auto === 'PASS') return `bg-[#03aa5c]/30 ${sel}`;
    if (auto === 'PARTIAL') return `bg-[#d4a72c]/35 ${sel}`;
    return `bg-[#cf222e]/30 ${sel}`;
  };

  const counts = units.reduce(
    (acc, u) => {
      const st = getUnitEffectiveState(u);
      acc[st] += 1;
      if (u.verdict === 'UNRATED') acc.UNRATED += 1;
      return acc;
    },
    { PASS: 0, PARTIAL: 0, FAIL: 0, UNRATED: 0 }
  );

  const groupedUnits = filteredUnits.reduce<
    Record<string, { doc_code: string; filename: string; items: ParsingUnit[] }>
  >((acc, u) => {
    if (!acc[u.doc_code]) {
      acc[u.doc_code] = { doc_code: u.doc_code, filename: u.filename, items: [] };
    }
    acc[u.doc_code].items.push(u);
    return acc;
  }, {});

  const renderDiffText = (sourceText: string, targetText: string) => {
    const src = checkFormat
      ? sourceText.normalize('NFC').trim()
      : sourceText.normalize('NFC').replace(/\s+/g, ' ').trim();
    const tgt = checkFormat
      ? targetText.normalize('NFC').trim()
      : targetText.normalize('NFC').replace(/\s+/g, ' ').trim();
    const parts = charLevel ? diffChars(src, tgt) : diffWordsWithSpace(src, tgt);
    return (
      <span>
        {parts.map((part, i) => {
          if (part.removed) {
            return (
              <span
                key={i}
                className="bg-rose-100 text-rose-800 line-through px-0.5"
                title="Có trong bản gốc nhưng RAGFlow đọc thiếu / khác"
              >
                {part.value}
              </span>
            );
          }
          if (part.added) {
            return (
              <span
                key={i}
                className="bg-emerald-100 text-emerald-900 underline decoration-emerald-600 px-0.5"
                title="RAGFlow đọc thêm / đọc khác so với bản gốc"
              >
                {part.value}
              </span>
            );
          }
          return <React.Fragment key={i}>{part.value}</React.Fragment>;
        })}
      </span>
    );
  };

  const selectedIdx = selectedUnit ? filteredUnits.findIndex((u) => u.id === selectedUnit.id) : -1;
  const previewUnit = hoveredUnit || selectedUnit;
  const previewSim = previewUnit?.matched_chunks?.[0]?.alignment?.text_similarity;
  const previewFlags = previewUnit?.matched_chunks?.[0]?.alignment?.risk_flags || [];

  // Visual analytics data (uses rated metrics when available, falls back to auto-alignment preview when unrated)
  const isAutoPreview = (metrics?.rated_units || 0) === 0 && units.length > 0;
  const effectiveMetrics = (() => {
    if (!isAutoPreview) {
      return {
        textCompleteness: (metrics?.text_completeness || 0) * 100,
        tableAccuracy: (metrics?.table_accuracy || 0) * 100,
        charErrorRate: (metrics?.character_error_rate || 0) * 100,
        layoutAccuracy: metrics?.layout_total ? (metrics.layout_accuracy || 0) * 100 : null,
        readingOrder: metrics?.rated_units ? (metrics.reading_order_accuracy || 0) * 100 : null,
      };
    }
    const textU = units.filter((u) => u.unit_type !== 'table' && u.unit_type !== 'image' && u.unit_type !== 'diagram');
    const tableU = units.filter((u) => u.unit_type === 'table');
    const layoutU = units.filter((u) => u.unit_type === 'image' || u.unit_type === 'diagram');
    const getCodes = (u: ParsingUnit) =>
      u.verdict !== 'UNRATED'
        ? u.error_codes || []
        : u.matched_chunks?.[0]?.alignment?.suggested_error_codes || [];
    const charErrCnt = units.filter((u) => getCodes(u).some((c) => c === 'P4' || c === 'P5' || c === 'P6')).length;
    const orderOkCnt = units.filter((u) => !getCodes(u).includes('P3')).length;
    return {
      textCompleteness: textU.length ? (textU.filter((u) => getUnitEffectiveState(u) === 'PASS').length / textU.length) * 100 : 0,
      tableAccuracy: tableU.length ? (tableU.filter((u) => getUnitEffectiveState(u) === 'PASS').length / tableU.length) * 100 : 0,
      charErrorRate: units.length ? (charErrCnt / units.length) * 100 : 0,
      layoutAccuracy: layoutU.length ? (layoutU.filter((u) => getUnitEffectiveState(u) === 'PASS').length / layoutU.length) * 100 : null,
      readingOrder: units.length ? (orderOkCnt / units.length) * 100 : null,
    };
  })();

  const errorCodeBreakdown = (() => {
    const map: Record<string, number> = {};
    for (const u of units) {
      const codes =
        u.verdict !== 'UNRATED'
          ? u.error_codes || []
          : u.matched_chunks && u.matched_chunks.length > 0
          ? u.matched_chunks[0]?.alignment?.suggested_error_codes || []
          : [u.unit_type === 'image' || u.unit_type === 'diagram' ? 'P2' : 'P1'];
      for (const c of codes) {
        map[c] = (map[c] || 0) + 1;
      }
    }
    return Object.entries(map)
      .map(([code, count]) => ({
        code,
        count,
        name: errorCatalog.find((e) => e.code === code)?.name || code,
        severity: errorCatalog.find((e) => e.code === code)?.severity || '',
      }))
      .sort((a, b) => b.count - a.count);
  })();
  const maxErrCount = Math.max(1, ...errorCodeBreakdown.map((e) => e.count));

  const docBreakdown = Object.values(
    units.reduce<
      Record<string, { doc_code: string; filename: string; pass: number; partial: number; fail: number; total: number }>
    >((acc, u) => {
      if (!acc[u.doc_code]) {
        acc[u.doc_code] = { doc_code: u.doc_code, filename: u.filename, pass: 0, partial: 0, fail: 0, total: 0 };
      }
      const st = getUnitEffectiveState(u);
      if (st === 'PASS') acc[u.doc_code].pass += 1;
      else if (st === 'PARTIAL') acc[u.doc_code].partial += 1;
      else acc[u.doc_code].fail += 1;
      acc[u.doc_code].total += 1;
      return acc;
    }, {})
  );

  return (
    <div className="h-[calc(100dvh-48px)] flex flex-col bg-white">
      {/* Sub-header Toolbar */}
      <div className="px-5 py-2.5 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <select
            className="ts-input py-1 text-xs"
            value={selectedDocId ?? ''}
            onChange={(e) => setSelectedDocId(e.target.value ? Number(e.target.value) : undefined)}
            disabled={loading}
          >
            <option value="">Tất cả tài liệu ({docs.length})</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.doc_code} — {d.filename.slice(0, 36)}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowAdd(true)}
            disabled={loading}
            className="ts-btn-secondary py-1 text-xs disabled:opacity-45"
          >
            <Plus className="size-3.5" />
            Thêm đoạn
          </button>
          {loading && <Loader2 className="size-3.5 animate-spin text-[#71717a]" />}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-[#52525b]">
          {[
            { label: 'Đủ chữ', val: effectiveMetrics.textCompleteness, invert: false, tip: 'Text Completeness (Phụ lục A)' },
            { label: 'Bảng', val: effectiveMetrics.tableAccuracy, invert: false, tip: 'Table Accuracy (Phụ lục A)' },
            { label: 'Lỗi ký tự', val: effectiveMetrics.charErrorRate, invert: true, tip: 'Character Error (P4/P5/P6)' },
            { label: 'Sơ đồ', val: effectiveMetrics.layoutAccuracy, invert: false, tip: 'Layout Accuracy (sơ đồ/ảnh)' },
            { label: 'Thứ tự', val: effectiveMetrics.readingOrder, invert: false, tip: 'Reading Order (không bị P3)' },
          ].map((m) => {
            const hasVal = m.val !== null;
            const pctVal = hasVal ? Math.max(0, Math.min(100, m.val as number)) : 0;
            const barColor = !hasVal
              ? 'bg-[#e4e4e2]'
              : m.invert
              ? pctVal <= 5
                ? 'bg-[#2da44e]'
                : pctVal <= 20
                ? 'bg-[#d4a72c]'
                : 'bg-[#cf222e]'
              : pctVal >= 85
              ? 'bg-[#2da44e]'
              : pctVal >= 60
              ? 'bg-[#d4a72c]'
              : 'bg-[#cf222e]';
            return (
              <div key={m.label} title={`${m.tip}${isAutoPreview ? ' (ước tính tự động)' : ''}`} className="flex flex-col gap-0.5 min-w-[68px]">
                <div className="flex items-baseline justify-between gap-1.5 text-[11px] leading-none">
                  <span className="text-[#71717a]">{m.label}</span>
                  <strong className={`font-mono tabular-nums ${m.invert && pctVal > 5 ? 'text-[#cf222e]' : 'text-[#18181b]'}`}>
                    {hasVal ? `${pctVal.toFixed(0)}%` : '—'}
                  </strong>
                </div>
                <div className="h-[3px] w-full bg-[#e6e6e3] overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${barColor}`}
                    style={{ width: `${hasVal ? Math.max(pctVal, pctVal > 0 ? 6 : 0) : 0}%` }}
                  />
                </div>
              </div>
            );
          })}
          <button
            onClick={() => setShowCharts((v) => !v)}
            className={`py-1 px-2 text-[11px] inline-flex items-center gap-1 border transition-colors ${
              showCharts
                ? 'bg-[#18181b] text-white border-[#18181b]'
                : 'bg-white text-[#52525b] border-[#e4e4e2] hover:bg-[#f4f4f2]'
            }`}
            title="Mở/đóng biểu đồ chi tiết mã lỗi P1–P10 và theo từng tài liệu"
          >
            <BarChart3 className="size-3" />
            Chi tiết lỗi
          </button>
          {onNextStep && (() => {
            const ratedNow = units.filter((u) => u.verdict !== 'UNRATED').length;
            const isParsingComplete = units.length > 0 && ratedNow >= units.length;
            return (
              <button
                onClick={onNextStep}
                disabled={!isParsingComplete}
                title={
                  isParsingComplete
                    ? 'Sang Bước 3: Chấm cắt đoạn'
                    : `Cần chấm xong toàn bộ đoạn Parsing (${ratedNow}/${units.length}) để mở khóa Bước 3`
                }
                className="ts-btn-primary py-1 text-xs"
              >
                {!isParsingComplete && <Lock className="size-3" />}
                Bước 3: Cắt đoạn
                {isParsingComplete && <ArrowRight className="size-3.5" />}
              </button>
            );
          })()}
        </div>
      </div>

      {/* Collapsible Compact Error Breakdown Drawer */}
      {showCharts && units.length > 0 && (
        <div className="px-5 py-2.5 border-b border-[#e8e8e6] bg-[#fafaf9] shrink-0">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Left: Compact P1-P10 Error Distribution */}
            <div className="bg-white border border-[#e6e6e3] px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold text-[#18181b]">
                  Phân bố mã lỗi (P1–P10)
                  {isAutoPreview && <span className="ml-1.5 font-normal text-amber-700">· ước tính</span>}
                </span>
                <span className="font-mono text-[10px] text-[#78716c]">
                  {errorCodeBreakdown.reduce((s, e) => s + e.count, 0)} lượt
                </span>
              </div>
              {errorCodeBreakdown.length === 0 ? (
                <div className="text-[11px] text-[#71717a] py-1">Chưa phát hiện mã lỗi nào.</div>
              ) : (
                <div className="space-y-1 max-h-24 overflow-y-auto pr-1">
                  {errorCodeBreakdown.map((item) => (
                    <div key={item.code} className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono font-semibold text-[#18181b] w-6 shrink-0">{item.code}</span>
                      <span className="text-[#52525b] truncate w-36 shrink-0" title={item.name}>{item.name}</span>
                      <div className="flex-1 h-1.5 bg-[#f4f4f2] overflow-hidden">
                        <div
                          className={`h-full ${item.severity === 'Nghiêm trọng' ? 'bg-[#cf222e]' : 'bg-[#d4a72c]'}`}
                          style={{ width: `${Math.max(6, (item.count / maxErrCount) * 100)}%` }}
                        />
                      </div>
                      <span className="font-mono tabular-nums text-[#18181b] w-6 text-right shrink-0">{item.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Right: Compact Per-Document Stacked Bar */}
            <div className="bg-white border border-[#e6e6e3] px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold text-[#18181b]">Đúng / Thiếu / Sai theo file</span>
                <span className="font-mono text-[10px] text-[#78716c]">{docBreakdown.length} file</span>
              </div>
              <div className="space-y-1 max-h-24 overflow-y-auto pr-1">
                {docBreakdown.map((d) => {
                  const pPct = (d.pass / d.total) * 100;
                  const paPct = (d.partial / d.total) * 100;
                  const fPct = (d.fail / d.total) * 100;
                  return (
                    <div key={d.doc_code} className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono font-medium text-[#18181b] w-12 shrink-0" title={d.filename}>{d.doc_code}</span>
                      <div className="flex-1 h-1.5 bg-[#f4f4f2] flex overflow-hidden">
                        {pPct > 0 && <div className="h-full bg-[#2da44e]" style={{ width: `${pPct}%` }} title={`Đúng: ${d.pass}`} />}
                        {paPct > 0 && <div className="h-full bg-[#d4a72c]" style={{ width: `${paPct}%` }} title={`Thiếu 1 phần: ${d.partial}`} />}
                        {fPct > 0 && <div className="h-full bg-[#cf222e]" style={{ width: `${fPct}%` }} title={`Sai: ${d.fail}`} />}
                      </div>
                      <span className="font-mono tabular-nums text-[10px] text-[#52525b] w-14 text-right shrink-0">
                        <span className="text-[#15803d]">{d.pass}</span>/
                        <span className="text-[#b45309]">{d.partial}</span>/
                        <span className="text-[#b91c1c]">{d.fail}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sharp GitHub-style Matrix Overview */}
      <div
        className={`px-6 py-3.5 border-b border-[#e8e8e6] bg-white ${
          selectedUnit ? 'shrink-0' : 'flex-1 overflow-y-auto'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono text-[11px] font-semibold text-[#18181b] mr-2">
              {metrics?.rated_units || 0}/{units.length}
            </span>
            {(
              [
                { id: 'ALL', label: `Tất cả (${units.length})`, dot: 'bg-[#161616]' },
                { id: 'PASS', label: `${counts.PASS}`, dot: 'bg-[#03aa5c]' },
                { id: 'PARTIAL', label: `${counts.PARTIAL}`, dot: 'bg-[#d4a72c]' },
                { id: 'FAIL', label: `${counts.FAIL}`, dot: 'bg-[#cf222e]' },
              ] as { id: ColorFilter; label: string; dot: string }[]
            ).map((f) => (
              <button
                key={f.id}
                onClick={() => setColorFilter(f.id)}
                className={`inline-flex items-center gap-1.5 px-2 py-1 text-[11px] transition-colors ${
                  colorFilter === f.id
                    ? 'bg-[#18181b] text-white font-medium'
                    : 'bg-[#f4f4f2] text-[#52525b] hover:bg-[#e8e8e5]'
                }`}
              >
                <span className={`size-2 inline-block ${f.dot}`} />
                <span className="font-mono tabular-nums">{f.label}</span>
              </button>
            ))}
          </div>

          <div className="text-[11px] font-mono text-[#52525b] min-h-[18px] flex items-center gap-2">
            {previewUnit ? (
              <>
                <span className="font-semibold text-[#18181b]">
                  {previewUnit.doc_code} #{previewUnit.unit_index}
                </span>
                <span>p.{previewUnit.page_num}</span>
                <span>{previewUnit.unit_type === 'table' ? 'BẢNG' : 'TEXT'}</span>
                {previewSim !== undefined && <span>{previewSim.toFixed(1)}%</span>}
                {previewFlags.length > 0 && (
                  <span className="text-[#cf222e]">{previewFlags[0].code}</span>
                )}
              </>
            ) : (
              <span className="text-[#a1a1aa] font-sans">Bấm vào ô vuông để xem chi tiết</span>
            )}
          </div>
        </div>

        {loading && units.length === 0 ? (
          <div className="py-12 flex items-center justify-center gap-2 text-xs text-[#71717a]">
            <Loader2 className="size-4 animate-spin" /> Đang tải dữ liệu đối chiếu...
          </div>
        ) : units.length === 0 ? (
          <div className="py-12 text-center text-xs text-[#71717a] bg-[#fafaf9]">
            Chưa có đoạn đối chiếu nào. Hãy vào <strong>Bước 1</strong> bấm <strong>Đồng bộ RAGFlow</strong> để tự động tách đoạn.
          </div>
        ) : (
          <div className={`space-y-2.5 ${selectedUnit ? 'max-h-[130px] overflow-y-auto pr-1' : ''}`}>
            {Object.values(groupedUnits).map((grp) => (
              <div key={grp.doc_code} className="flex items-start gap-3">
                <div
                  className="w-20 shrink-0 font-mono text-[11px] font-medium text-[#52525b] pt-0.5 truncate"
                  title={grp.filename}
                >
                  {grp.doc_code}
                </div>
                <div className="flex flex-wrap gap-[3px]">
                  {grp.items.map((u) => {
                    const isSel = selectedUnit?.id === u.id;
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => (isSel ? setSelectedUnit(null) : selectUnit(u))}
                        onMouseEnter={() => setHoveredUnit(u)}
                        onMouseLeave={() => setHoveredUnit(null)}
                        aria-label={`${u.doc_code} #${u.unit_index}`}
                        className={`relative size-[22px] rounded-none border-0 transition-opacity cursor-pointer ${getTileClass(
                          u,
                          isSel
                        )}`}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Expandable Side-by-Side Detail Panel — ONLY shown when a square is clicked */}
      {selectedUnit && (
        <div className="flex-1 flex flex-col min-h-0 bg-white">
          <div className="px-5 py-2 border-b border-[#ededeb] bg-[#fafaf9] flex items-center justify-between text-xs shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="inline-flex items-center border border-[#e4e4e2] bg-white">
                <button
                  onClick={() => stepUnit(-1)}
                  disabled={selectedIdx <= 0}
                  className="p-1 text-[#52525b] hover:bg-[#f4f4f2] disabled:opacity-30"
                  title="Đoạn trước (←)"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
                <span className="px-2 font-mono text-[11px] text-[#18181b] border-x border-[#e4e4e2]">
                  {selectedIdx + 1}/{filteredUnits.length}
                </span>
                <button
                  onClick={() => stepUnit(1)}
                  disabled={selectedIdx < 0 || selectedIdx >= filteredUnits.length - 1}
                  className="p-1 text-[#52525b] hover:bg-[#f4f4f2] disabled:opacity-30"
                  title="Đoạn sau (→)"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </div>
              <span className="font-mono font-semibold text-[#18181b]">
                {selectedUnit.doc_code} · #{selectedUnit.unit_index}
              </span>
              <span className="ts-tag-neutral">Trang {selectedUnit.page_num}</span>
              <span className="ts-tag-neutral">
                {selectedUnit.unit_type === 'table'
                  ? 'Bảng biểu'
                  : selectedUnit.unit_type === 'image'
                  ? 'Sơ đồ / Ảnh'
                  : 'Văn bản'}
              </span>
              <span className={`text-[11px] font-medium px-2 py-0.5 border ${badge(selectedUnit.verdict).cls}`}>
                {badge(selectedUnit.verdict).text}
              </span>
            </div>

            <div className="flex items-center gap-3">
              <span className="hidden md:inline text-[11px] text-[#a1a1aa] font-mono">
                ←/→ chuyển · 1/2/3 chấm · Esc đóng
              </span>
              <button
                onClick={() => setSelectedUnit(null)}
                className="inline-flex items-center gap-1 text-xs text-[#52525b] hover:text-[#18181b] px-2 py-1 hover:bg-[#ededeb]"
                title="Đóng (Esc)"
              >
                <X className="size-3.5" /> Đóng
              </button>
            </div>
          </div>

          <div className="flex-1 grid grid-cols-2 min-h-0 divide-x divide-[#e8e8e6] overflow-hidden">
            {/* Original */}
            <div className="p-5 overflow-y-auto space-y-3">
              <div className="ts-eyebrow">ĐOẠN TRÍCH GỐC</div>
              <div className="bg-[#fafaf9] border border-[#ededeb] p-4 text-[13.5px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty">
                {selectedUnit.source_text}
              </div>
              {selectedUnit.has_local_file && selectedUnit.filename.toLowerCase().endsWith('.pdf') && (
                <img
                  src={`/api/parsing/documents/${selectedUnit.document_id}/page/${selectedUnit.page_num}`}
                  alt="Trang PDF gốc"
                  className="w-full border border-[#ededeb]"
                />
              )}
            </div>

            {/* Parsed */}
            <div className="p-5 overflow-y-auto space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="ts-eyebrow">ĐOẠN SO SÁNH & KẾT QUẢ</span>
                <div className="flex flex-wrap items-center gap-2.5 text-[11px]">
                  <label className="flex items-center gap-1 cursor-pointer text-[#52525b]">
                    <input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} />
                    Diff
                  </label>
                  {showDiff && (
                    <>
                      <label className="flex items-center gap-1 cursor-pointer text-[#52525b]">
                        <input
                          type="checkbox"
                          checked={checkFormat}
                          onChange={(e) => setCheckFormat(e.target.checked)}
                        />
                        Format (\n)
                      </label>
                      <label className="flex items-center gap-1 cursor-pointer text-[#52525b]">
                        <input
                          type="checkbox"
                          checked={charLevel}
                          onChange={(e) => setCharLevel(e.target.checked)}
                        />
                        Ký tự
                      </label>
                    </>
                  )}
                  <label className="flex items-center gap-1 cursor-pointer text-[#52525b]">
                    <input
                      type="checkbox"
                      checked={showFullChunk}
                      onChange={(e) => setShowFullChunk(e.target.checked)}
                    />
                    Cả chunk
                  </label>
                </div>
              </div>

              {selectedUnit.matched_chunks.map((ch) => {
                const aln = ch.alignment;
                const sim = aln ? aln.text_similarity : 0;
                const simCls =
                  sim >= 98
                    ? 'text-[#15803d] bg-[#f0fdf4] border-[#bbf7d0]'
                    : sim >= 75
                    ? 'text-[#b45309] bg-[#fffbeb] border-[#fde68a]'
                    : 'text-[#b91c1c] bg-[#fef2f2] border-[#fecaca]';
                const targetText = showFullChunk || !aln?.matched_excerpt ? ch.content : aln.matched_excerpt;

                return (
                  <div key={ch.ragflow_chunk_id} className="bg-[#fafaf9] border border-[#ededeb] p-4 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[#78716c]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>
                          Chunk #{ch.chunk_index}
                          {aln?.stitched_with_chunk_index ? ` + #${aln.stitched_with_chunk_index}` : ''}
                        </span>
                        {aln?.stitched_with_chunk_index && (
                          <span className="px-1.5 py-0.5 bg-[#f4f4f2] text-[#3f3f46] border border-[#e4e4e2] font-sans">
                            Nối 2 chunk
                          </span>
                        )}
                        {aln && (
                          <span className={`px-1.5 py-0.5 border font-sans font-medium ${simCls}`}>
                            {sim.toFixed(1)}%
                          </span>
                        )}
                      </div>
                      <span>{ch.char_count} ký tự</span>
                    </div>
                    {aln?.risk_flags && aln.risk_flags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {aln.risk_flags.map((rf, idx) => (
                          <span
                            key={idx}
                            className={`text-[11px] px-2 py-0.5 border ${
                              rf.severity === 'Nghiêm trọng'
                                ? 'bg-[#fef2f2] text-[#b91c1c] border-[#fecaca]'
                                : 'bg-[#fffbeb] text-[#b45309] border-[#fde68a]'
                            }`}
                          >
                            {rf.label}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="text-[13.5px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty">
                      {showDiff && !showFullChunk
                        ? renderDiffText(selectedUnit.source_text, targetText)
                        : targetText}
                    </div>
                  </div>
                );
              })}
              {selectedUnit.matched_chunks.length === 0 && (
                <div className="bg-[#fef2f2] border border-[#fecaca] p-4 text-[13px] text-[#991b1b]">
                  Không tìm thấy đoạn nào khớp sau khi đọc file (có thể bị mất đoạn hoặc ảnh không OCR được).
                </div>
              )}
            </div>
          </div>

          {/* Calm, Compact Bottom Action Bar */}
          <div className="px-5 py-2.5 border-t border-[#e8e8e6] bg-[#fafaf9] space-y-2 shrink-0">
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-[#78716c] mr-1.5">
                Lỗi{autoSuggested ? ' (gợi ý)' : ''}:
              </span>
              {errorCatalog.map((ec) => {
                const active = errCodes.includes(ec.code);
                return (
                  <button
                    key={ec.code}
                    disabled={scoring}
                    onClick={() => toggleCode(ec.code)}
                    title={`${ec.code} · ${ec.name} (${ec.severity})`}
                    className={`font-mono text-[11px] px-2 py-0.5 border transition-colors disabled:opacity-45 ${
                      active
                        ? 'bg-[#18181b] text-white border-[#18181b] font-semibold'
                        : 'bg-white text-[#52525b] border-[#e4e4e2] hover:border-[#a1a1aa] hover:text-[#18181b]'
                    }`}
                  >
                    {ec.code}
                  </button>
                );
              })}
              {errCodes.length > 0 && (
                <span className="text-[11px] text-[#52525b] ml-1.5 truncate max-w-[300px]">
                  {errCodes
                    .map((c) => errorCatalog.find((e) => e.code === c)?.name)
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
              <label className="ml-auto flex items-center gap-1.5 text-[11px] text-[#52525b] cursor-pointer">
                <input type="checkbox" checked={charErr} onChange={(e) => setCharErr(e.target.checked)} />
                Lỗi ký tự
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                className="ts-input flex-1 min-w-[200px] py-1 text-xs"
                placeholder="Ghi chú ngắn..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <button
                onClick={() => handleScore('PASS')}
                disabled={scoring}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#18181b] hover:bg-[#27272a] text-white disabled:opacity-45"
              >
                <span className="size-2 bg-[#4ac26b] inline-block" /> Đọc đúng (1)
              </button>
              <button
                onClick={() => handleScore('PARTIAL')}
                disabled={scoring}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white hover:bg-[#f4f4f2] text-[#18181b] border border-[#d4d4d0] disabled:opacity-45"
              >
                <span className="size-2 bg-[#d4a72c] inline-block" /> Thiếu 1 phần (2)
              </button>
              <button
                onClick={() => handleScore('FAIL')}
                disabled={scoring}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white hover:bg-[#fef2f2] text-[#18181b] border border-[#d4d4d0] disabled:opacity-45"
              >
                <span className="size-2 bg-[#cf222e] inline-block" /> Đọc sai (3)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Add Unit */}
      {showAdd && (
        <div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4">
          <form onSubmit={handleAddUnit} className="bg-white border border-[#e4e4e2] w-full max-w-lg p-6 space-y-4 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#18181b]">Thêm đoạn gốc để đối chiếu</h2>
              <button type="button" onClick={() => setShowAdd(false)} aria-label="Đóng">
                <X className="size-4 text-[#71717a]" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[#52525b] mb-1">Loại nội dung</label>
                <select className="ts-input w-full" value={newType} onChange={(e) => setNewType(e.target.value)}>
                  <option value="text">Đoạn văn bản</option>
                  <option value="table">Bảng biểu</option>
                  <option value="image">Sơ đồ / Ảnh (Layout)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#52525b] mb-1">Số trang</label>
                <input type="number" className="ts-input w-full font-mono" value={newPage} onChange={(e) => setNewPage(Number(e.target.value))} />
              </div>
            </div>
            <div>
              <label className="block text-xs text-[#52525b] mb-1">Tiêu đề ngắn</label>
              <input className="ts-input w-full" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-[#52525b] mb-1">Nội dung chuẩn trích từ tài liệu gốc</label>
              <textarea rows={4} className="ts-input w-full" value={newText} onChange={(e) => setNewText(e.target.value)} required />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#ededeb]">
              <button type="button" onClick={() => setShowAdd(false)} className="ts-btn-secondary">Hủy</button>
              <button type="submit" className="ts-btn-primary">Lưu & Tìm đoạn khớp</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
