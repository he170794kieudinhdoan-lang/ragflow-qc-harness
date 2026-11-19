import React, { useEffect, useState } from 'react';
import { diffChars, diffWordsWithSpace } from 'diff';
import { Check, ChevronLeft, ChevronRight, Plus, Sparkles, X } from 'lucide-react';
import { api } from '../api/client';
import { DocumentItem, ErrorCodeDef, ParsingUnit, RunItem } from '../types';

interface Props {
  activeRun: RunItem | null;
  errorCatalog: ErrorCodeDef[];
}

type ColorFilter = 'ALL' | 'PASS' | 'PARTIAL' | 'FAIL' | 'UNRATED';

export const ParsingPage: React.FC<Props> = ({ activeRun, errorCatalog }) => {
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
  const [extracting, setExtracting] = useState(false);
  const [showDiff, setShowDiff] = useState(true);
  const [checkFormat, setCheckFormat] = useState(false);
  const [charLevel, setCharLevel] = useState(false);
  const [showFullChunk, setShowFullChunk] = useState(false);

  const getUnitEffectiveState = (u: ParsingUnit): 'PASS' | 'PARTIAL' | 'FAIL' => {
    if (u.verdict === 'PASS' || u.verdict === 'PARTIAL' || u.verdict === 'FAIL') return u.verdict;
    if (!u.matched_chunks || u.matched_chunks.length === 0) return 'FAIL';
    return u.matched_chunks[0]?.alignment?.suggested_verdict || 'PARTIAL';
  };

  const filteredUnits = units.filter((u) => {
    if (colorFilter === 'ALL') return true;
    if (colorFilter === 'UNRATED') return u.verdict === 'UNRATED';
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
    const [dRes, uRes, mRes] = await Promise.all([
      api.listDocuments(activeRun.id),
      api.listParsingUnits(activeRun.id, selectedDocId),
      api.getParsingMetrics(activeRun.id),
    ]);
    setDocs(dRes);
    setUnits(uRes);
    setMetrics(mRes);
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
  };

  useEffect(() => {
    setSelectedUnit(null);
    setHoveredUnit(null);
    load();
  }, [activeRun?.id, selectedDocId]);

  const handleScore = async (verdict: 'PASS' | 'PARTIAL' | 'FAIL') => {
    if (!selectedUnit) return;
    await api.scoreParsingUnit(selectedUnit.id, {
      verdict,
      error_codes: verdict === 'PASS' ? [] : errCodes,
      char_error: charErr,
      severity: verdict === 'FAIL' ? 'High' : verdict === 'PARTIAL' ? 'Medium' : '',
      notes,
    });
    await load(selectedUnit.id);
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
      } else if (selectedUnit) {
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
  }, [selectedUnit, filteredUnits, errCodes, charErr, notes]);

  if (!activeRun) {
    return <div className="p-8 text-sm text-[#71717a]">Hãy chọn hoặc tạo một phiên kiểm thử trước.</div>;
  }

  const handleAutoExtract = async () => {
    if (!selectedDocId || extracting) return;
    setExtracting(true);
    try {
      await api.autoExtractUnits(activeRun.id, selectedDocId);
      setSelectedUnit(null);
      await load();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setExtracting(false);
    }
  };

  const handleAddUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    const docId = selectedDocId || docs[0]?.id;
    if (!docId || !newText.trim()) return;
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
    if (v === 'PASS') return { text: 'Đúng', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    if (v === 'PARTIAL') return { text: 'Thiếu 1 phần', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
    if (v === 'FAIL') return { text: 'Sai', cls: 'bg-rose-50 text-rose-700 border-rose-200' };
    return { text: 'Chưa chấm', cls: 'bg-[#f4f4f2] text-[#71717a] border-[#e6e6e3]' };
  };

  // Sharp, borderless, rich-color squares
  const getTileClass = (u: ParsingUnit, isSelected: boolean) => {
    const sel = isSelected
      ? 'outline outline-2 outline-[#18181b] outline-offset-1 z-10'
      : 'hover:brightness-90';
    // Human-confirmed: deep vivid colors
    if (u.verdict === 'PASS') return `bg-emerald-600 ${sel}`;
    if (u.verdict === 'PARTIAL') return `bg-amber-500 ${sel}`;
    if (u.verdict === 'FAIL') return `bg-rose-600 ${sel}`;
    // Unrated preview: bold, unmistakable tints without borders
    const auto = getUnitEffectiveState(u);
    if (auto === 'PASS') return `bg-emerald-400 ${sel}`;
    if (auto === 'PARTIAL') return `bg-amber-300 ${sel}`;
    return `bg-rose-400 ${sel}`;
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

  return (
    <div className="h-[calc(100dvh-48px)] flex flex-col bg-white">
      {/* Sub-header Toolbar */}
      <div className="px-5 py-2.5 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <select
            className="ts-input py-1 text-xs"
            value={selectedDocId ?? ''}
            onChange={(e) => setSelectedDocId(e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">Tất cả tài liệu ({docs.length})</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.doc_code} — {d.filename.slice(0, 36)}
              </option>
            ))}
          </select>
          {selectedDocId && (
            <button onClick={handleAutoExtract} disabled={extracting} className="ts-btn-secondary py-1 text-xs">
              <Sparkles className="size-3.5 text-[#6d2e58]" />
              {extracting ? 'Đang tải & tách đoạn...' : 'Tự tách đoạn từ file gốc'}
            </button>
          )}
          <button onClick={() => setShowAdd(true)} className="ts-btn-secondary py-1 text-xs">
            <Plus className="size-3.5" />
            Thêm đoạn
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3.5 text-xs text-[#52525b]">
          <span title="Text Completeness (Phụ lục A)">
            Đọc đủ chữ:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">
              {((metrics?.text_completeness || 0) * 100).toFixed(0)}%
            </strong>
          </span>
          <span title="Table Accuracy (Phụ lục A)">
            Đúng bảng:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">
              {((metrics?.table_accuracy || 0) * 100).toFixed(0)}%
            </strong>
          </span>
          <span title="Character Error (Phụ lục A — P4/P5/P6)">
            Lỗi ký tự:{' '}
            <strong className="font-mono tabular-nums text-rose-600">
              {((metrics?.character_error_rate || 0) * 100).toFixed(0)}%
            </strong>
          </span>
          <span title="Layout Accuracy (Phụ lục A — sơ đồ/ảnh)">
            Đúng sơ đồ:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">
              {metrics?.layout_total ? `${((metrics.layout_accuracy || 0) * 100).toFixed(0)}%` : '—'}
            </strong>
          </span>
          <span title="Reading Order Accuracy (Phụ lục A — không bị lỗi P3)">
            Đúng thứ tự:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">
              {metrics?.rated_units ? `${((metrics.reading_order_accuracy || 0) * 100).toFixed(0)}%` : '—'}
            </strong>
          </span>
        </div>
      </div>

      {/* Sharp GitHub-style Matrix Overview */}
      <div
        className={`px-6 py-4 border-b border-[#e8e8e6] bg-white ${
          selectedUnit ? 'shrink-0' : 'flex-1 overflow-y-auto'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          {/* Interactive Color Filter Pills */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono text-[11px] font-semibold text-[#18181b] mr-2">
              {metrics?.rated_units || 0}/{units.length}
            </span>
            {(
              [
                { id: 'ALL', label: `Tất cả (${units.length})`, dot: 'bg-[#18181b]' },
                { id: 'PASS', label: `${counts.PASS}`, dot: 'bg-emerald-600' },
                { id: 'PARTIAL', label: `${counts.PARTIAL}`, dot: 'bg-amber-500' },
                { id: 'FAIL', label: `${counts.FAIL}`, dot: 'bg-rose-600' },
                { id: 'UNRATED', label: `Chưa chấm (${counts.UNRATED})`, dot: 'bg-[#d4d4d8]' },
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
                <span className={`size-2.5 inline-block ${f.dot}`} />
                <span className="font-mono tabular-nums">{f.label}</span>
              </button>
            ))}
          </div>

          {/* Instant Hover Status Line */}
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
                  <span className="text-rose-600 font-semibold">⚠ {previewFlags[0].code}</span>
                )}
              </>
            ) : (
              <span className="text-[#a1a1aa] font-sans">Di chuột hoặc bấm ô vuông để xem chi tiết</span>
            )}
          </div>
        </div>

        {units.length === 0 ? (
          <div className="py-12 text-center text-xs text-[#71717a] bg-[#fafaf9]">
            Chưa có đoạn đối chiếu nào. Chọn tài liệu phía trên và bấm <strong>Tự tách đoạn từ file gốc</strong>.
          </div>
        ) : (
          <div className={`space-y-3 ${selectedUnit ? 'max-h-[140px] overflow-y-auto pr-1' : ''}`}>
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
                        className={`relative size-[22px] rounded-none border-0 transition-transform cursor-pointer ${getTileClass(
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
          <div className="px-6 py-2 border-b border-[#ededeb] bg-[#fafaf9] flex items-center justify-between text-xs shrink-0">
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
                ←/→ chuyển · 1/2/3 chấm nhanh · Esc đóng
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
            <div className="p-6 overflow-y-auto space-y-3">
              <div className="flex items-center justify-between">
                <span className="ts-eyebrow">ĐOẠN TRÍCH GỐC ({selectedUnit.doc_code})</span>
                <span className="ts-tag-neutral">Trang {selectedUnit.page_num}</span>
              </div>
              <div className="bg-[#f7f7f5] border border-[#e6e6e3] p-4 text-[14px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty">
                {selectedUnit.source_text}
              </div>
              {selectedUnit.has_local_file && selectedUnit.filename.toLowerCase().endsWith('.pdf') && (
                <img
                  src={`/api/parsing/documents/${selectedUnit.document_id}/page/${selectedUnit.page_num}`}
                  alt="Trang PDF gốc"
                  className="w-full border border-[#e6e6e3]"
                />
              )}
            </div>

            {/* Parsed */}
            <div className="p-6 overflow-y-auto space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="ts-eyebrow">ĐOẠN SO SÁNH & KẾT QUẢ</span>
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
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
                    ? 'bg-emerald-600 text-white'
                    : sim >= 75
                    ? 'bg-amber-500 text-white'
                    : 'bg-rose-600 text-white';
                const targetText = showFullChunk || !aln?.matched_excerpt ? ch.content : aln.matched_excerpt;

                return (
                  <div key={ch.ragflow_chunk_id} className="bg-[#f7f7f5] border border-[#e6e6e3] p-4 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[#78716c]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>
                          Chunk #{ch.chunk_index}
                          {aln?.stitched_with_chunk_index ? ` + #${aln.stitched_with_chunk_index}` : ''}
                        </span>
                        {aln?.stitched_with_chunk_index && (
                          <span className="px-1.5 py-0.5 bg-sky-600 text-white font-sans font-medium">
                            Nối 2 chunk
                          </span>
                        )}
                        {aln && (
                          <span className={`px-1.5 py-0.5 font-sans font-semibold ${simCls}`}>
                            {sim.toFixed(1)}%
                          </span>
                        )}
                        {aln && !aln.has_text_diff && !aln.has_format_diff && (
                          <span className="text-emerald-700 font-sans font-medium">Khớp 100%</span>
                        )}
                        {aln && aln.has_format_diff && !aln.has_text_diff && (
                          <span className="text-amber-700 font-sans">Chỉ khác format</span>
                        )}
                      </div>
                      <span>{ch.char_count} ký tự</span>
                    </div>
                    {aln?.risk_flags && aln.risk_flags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {aln.risk_flags.map((rf, idx) => (
                          <span
                            key={idx}
                            className={`text-[11px] px-2 py-0.5 font-medium ${
                              rf.severity === 'Nghiêm trọng'
                                ? 'bg-rose-600 text-white'
                                : 'bg-amber-500 text-white'
                            }`}
                          >
                            ⚠ {rf.label}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="text-[14px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty">
                      {showDiff && !showFullChunk
                        ? renderDiffText(selectedUnit.source_text, targetText)
                        : targetText}
                    </div>
                  </div>
                );
              })}
              {selectedUnit.matched_chunks.length === 0 && (
                <div className="bg-rose-50 border border-rose-200 p-4 text-[13px] text-rose-800">
                  Không tìm thấy đoạn nào khớp sau khi đọc file (có thể bị mất đoạn hoặc ảnh không OCR được).
                </div>
              )}
            </div>
          </div>

          {/* Crisp Bottom Action Bar */}
          <div className="px-6 py-3 border-t border-[#e8e8e6] bg-[#fafaf9] space-y-2.5 shrink-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-[#71717a] mr-1">
                Mã lỗi{autoSuggested ? ' (tự chọn sẵn):' : ':'}
              </span>
              {errorCatalog.map((ec) => {
                const active = errCodes.includes(ec.code);
                const isCritical = ec.severity === 'Nghiêm trọng' || ec.severity === 'High';
                return (
                  <button
                    key={ec.code}
                    onClick={() => toggleCode(ec.code)}
                    title={`${ec.code} · ${ec.name} (${ec.severity})`}
                    className={`text-xs px-2 py-1 border transition-colors ${
                      active
                        ? isCritical
                          ? 'bg-rose-600 text-white border-rose-600 font-medium'
                          : 'bg-[#18181b] text-white border-[#18181b] font-medium'
                        : 'bg-white text-[#52525b] border-[#e4e4e2] hover:bg-[#f4f4f2]'
                    }`}
                  >
                    <span className="font-mono font-semibold mr-1">{ec.code}</span>
                    {ec.name}
                  </button>
                );
              })}
              <label className="ml-2 flex items-center gap-1.5 text-xs text-[#3f3f46] cursor-pointer">
                <input type="checkbox" checked={charErr} onChange={(e) => setCharErr(e.target.checked)} />
                Lỗi ký tự (P4–P6)
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <input
                className="ts-input flex-1 min-w-[200px]"
                placeholder="Ghi chú ngắn..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <button
                onClick={() => handleScore('PASS')}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[13px] font-medium bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                <Check className="size-3.5" /> Đọc đúng (1)
              </button>
              <button
                onClick={() => handleScore('PARTIAL')}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[13px] font-medium bg-amber-500 hover:bg-amber-600 text-white"
              >
                Thiếu 1 phần (2)
              </button>
              <button
                onClick={() => handleScore('FAIL')}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[13px] font-medium bg-rose-600 hover:bg-rose-700 text-white"
              >
                <X className="size-3.5" /> Đọc sai (3)
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
