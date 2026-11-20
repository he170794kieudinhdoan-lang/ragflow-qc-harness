import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, ChevronLeft, ChevronRight, Loader2, Shuffle, X } from 'lucide-react';
import { api } from '../api/client';
import { ChunkEvalItem, ErrorCodeDef, RunItem } from '../types';

interface Props {
  activeRun: RunItem | null;
  errorCatalog: ErrorCodeDef[];
  onNextStep?: () => void;
}

type ChunkFilter = 'ALL' | 'OK' | 'WARN' | 'SEVERE' | 'UNCONFIRMED';

const FLAG_LABELS: Record<string, string> = {
  EMPTY: 'Chunk rỗng (C5)',
  TOO_SHORT: 'Quá ngắn (<50 ký tự · C8)',
  TOO_LONG: 'Quá dài (>2600 ký tự · C8)',
  NUMERIC_ONLY_NOISE: 'Chunk rác / chỉ có số (C5)',
  SUSPECTED_NOISE: 'Dính header/footer/nhiễu (C4)',
  CHAR_CORRUPTION: 'Lỗi mã hóa ký tự',
  ADJACENT_DUPLICATE: 'Trùng lặp do overlap liền kề (C6)',
  DUPLICATE: 'Trùng lặp với chunk khác (C7)',
  BROKEN_TABLE: 'Vỡ bảng khi cắt chunk (C1)',
  BAD_BOUNDARY: 'Cắt ngang câu / sai ranh giới (C2)',
  LOW_CONTEXT: 'Nghi thiếu ngữ cảnh / mất heading (C3)',
};

export const ChunkingPage: React.FC<Props> = ({ activeRun, errorCatalog, onNextStep }) => {
  const [chunks, setChunks] = useState<ChunkEvalItem[]>([]);
  const [selected, setSelected] = useState<ChunkEvalItem | null>(null);
  const [hovered, setHovered] = useState<ChunkEvalItem | null>(null);
  const [metrics, setMetrics] = useState<any>(null);
  const [perDoc, setPerDoc] = useState(5);
  const [docFilter, setDocFilter] = useState('');
  const [colorFilter, setColorFilter] = useState<ChunkFilter>('ALL');
  const [sampling, setSampling] = useState(false);
  const [saving, setSaving] = useState(false);

  const [integrity, setIntegrity] = useState<number>(1);
  const [contextSuff, setContextSuff] = useState<number>(1);
  const [noNoise, setNoNoise] = useState<number>(1);
  const [noDup, setNoDup] = useState<number>(1);
  const [validSize, setValidSize] = useState<number>(1);
  const [errCodes, setErrCodes] = useState<string[]>([]);
  const [notes, setNotes] = useState('');

  const getChunkState = (c: ChunkEvalItem): 'OK' | 'WARN' | 'SEVERE' => {
    const codes = c.error_codes || [];
    const badCount =
      (c.integrity === 0 ? 1 : 0) +
      (c.context_sufficiency === 0 ? 1 : 0) +
      (c.no_noise === 0 ? 1 : 0) +
      (c.no_duplicate === 0 ? 1 : 0) +
      (c.valid_size === 0 ? 1 : 0);
    if (codes.includes('C1') || badCount >= 3) return 'SEVERE';
    if (codes.length > 0 || badCount > 0) return 'WARN';
    return 'OK';
  };

  const getTileClass = (c: ChunkEvalItem, isSel: boolean) => {
    const ring = isSel ? 'outline outline-2 outline-[#18181b] outline-offset-1 z-10' : 'hover:opacity-80';
    const st = getChunkState(c);
    const manual = c.judge_source === 'MANUAL';
    if (st === 'OK') return `${manual ? 'bg-[#2da44e]' : 'bg-[#4ac26b]/70'} ${ring}`;
    if (st === 'WARN') return `${manual ? 'bg-[#d4a72c]' : 'bg-[#eac54f]/85'} ${ring}`;
    return `${manual ? 'bg-[#cf222e]' : 'bg-[#f87171]/80'} ${ring}`;
  };

  const pickChunk = (c: ChunkEvalItem) => {
    setSelected(c);
    setIntegrity(c.integrity ?? 1);
    setContextSuff(c.context_sufficiency ?? 1);
    setNoNoise(c.no_noise ?? 1);
    setNoDup(c.no_duplicate ?? 1);
    setValidSize(c.valid_size ?? 1);
    setErrCodes(c.error_codes || []);
    setNotes(c.notes || '');
  };

  const load = async (advanceFromPk?: number, autoSampleIfEmpty = false) => {
    if (!activeRun) return;
    const [list, m] = await Promise.all([
      api.listChunkEvals(activeRun.id, true),
      api.getChunkingMetrics(activeRun.id),
    ]);
    if (list.length === 0 && autoSampleIfEmpty && (activeRun.chunk_count ?? 0) > 0) {
      setSampling(true);
      try {
        await api.sampleChunks(activeRun.id, perDoc);
        const [list2, m2] = await Promise.all([
          api.listChunkEvals(activeRun.id, true),
          api.getChunkingMetrics(activeRun.id),
        ]);
        setChunks(list2);
        setMetrics(m2);
      } catch (e: any) {
        toast.error(e.message);
      } finally {
        setSampling(false);
      }
      return;
    }
    setChunks(list);
    setMetrics(m);
    if (list.length > 0) {
      if (advanceFromPk) {
        const idx = list.findIndex((c: ChunkEvalItem) => c.chunk_pk === advanceFromPk);
        const nextItem = idx >= 0 && idx + 1 < list.length ? list[idx + 1] : null;
        if (nextItem) pickChunk(nextItem);
        else setSelected(null);
      } else if (selected) {
        const keep = list.find((c: ChunkEvalItem) => c.chunk_pk === selected.chunk_pk);
        if (keep) pickChunk(keep);
        else setSelected(null);
      }
    } else {
      setSelected(null);
    }
  };

  useEffect(() => {
    setSelected(null);
    setHovered(null);
    load(undefined, true);
  }, [activeRun?.id]);

  const handleAutoSample = async () => {
    if (!activeRun || sampling) return;
    setSampling(true);
    try {
      const res = await api.sampleChunks(activeRun.id, perDoc);
      setSelected(null);
      await load();
      toast.success(`Đã chọn mẫu & quét lỗi ${res.sampled_chunks ?? ''} đoạn cắt.`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSampling(false);
    }
  };

  const handleSaveScore = async () => {
    if (!activeRun || !selected || saving) return;
    setSaving(true);
    try {
      await api.scoreChunk(activeRun.id, selected.chunk_pk, {
        integrity,
        context_sufficiency: contextSuff,
        no_noise: noNoise,
        no_duplicate: noDup,
        valid_size: validSize,
        error_codes: errCodes,
        notes,
        judge_source: 'MANUAL',
      });
      await load(selected.chunk_pk);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleCode = (code: string) => {
    setErrCodes((prev) => {
      const next = prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code];
      // Sync 5 criteria toggles cleanly with Phụ lục B codes
      setIntegrity(next.includes('C1') || next.includes('C2') ? 0 : 1);
      setContextSuff(next.includes('C3') || next.includes('C5') ? 0 : 1);
      setNoNoise(next.includes('C4') || next.includes('C5') ? 0 : 1);
      setNoDup(next.includes('C6') || next.includes('C7') ? 0 : 1);
      setValidSize(next.includes('C8') || next.includes('C5') ? 0 : 1);
      return next;
    });
  };

  const docOptions = Array.from(
    new Map(chunks.map((c) => [c.doc_code || 'DOC', { code: c.doc_code || 'DOC', name: c.filename || '' }])).values()
  );

  const visibleChunks = chunks.filter((c) => {
    if (docFilter && (c.doc_code || 'DOC') !== docFilter) return false;
    if (colorFilter === 'ALL') return true;
    if (colorFilter === 'UNCONFIRMED') return c.judge_source !== 'MANUAL';
    return getChunkState(c) === colorFilter;
  });

  const stepChunk = (delta: -1 | 1) => {
    if (!selected || visibleChunks.length === 0) return;
    const idx = visibleChunks.findIndex((c) => c.chunk_pk === selected.chunk_pk);
    if (idx < 0) return;
    const target = visibleChunks[idx + delta];
    if (target) pickChunk(target);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        setSelected(null);
      } else if (selected && !saving) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          stepChunk(-1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          stepChunk(1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          handleSaveScore();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, visibleChunks, integrity, contextSuff, noNoise, noDup, validSize, errCodes, notes, saving]);

  if (!activeRun) {
    return <div className="p-8 text-sm text-[#71717a]">Hãy chọn hoặc tạo một phiên kiểm thử trước.</div>;
  }

  const counts = chunks.reduce(
    (acc, c) => {
      if (docFilter && (c.doc_code || 'DOC') !== docFilter) return acc;
      acc.TOTAL += 1;
      acc[getChunkState(c)] += 1;
      if (c.judge_source !== 'MANUAL') acc.UNCONFIRMED += 1;
      return acc;
    },
    { TOTAL: 0, OK: 0, WARN: 0, SEVERE: 0, UNCONFIRMED: 0 }
  );

  const grouped = visibleChunks.reduce<Record<string, { doc_code: string; filename: string; items: ChunkEvalItem[] }>>(
    (acc, c) => {
      const code = c.doc_code || 'DOC';
      if (!acc[code]) acc[code] = { doc_code: code, filename: c.filename || '', items: [] };
      acc[code].items.push(c);
      return acc;
    },
    {}
  );

  const selectedIdx = selected ? visibleChunks.findIndex((c) => c.chunk_pk === selected.chunk_pk) : -1;
  const preview = hovered || selected;

  return (
    <div className="h-[calc(100dvh-48px)] flex flex-col bg-white">
      {/* Toolbar + 6 Phụ lục A Metrics */}
      <div className="px-5 py-2.5 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="ts-input py-1 text-xs"
            value={docFilter}
            onChange={(e) => {
              setDocFilter(e.target.value);
              setSelected(null);
            }}
          >
            <option value="">Tất cả tài liệu ({docOptions.length})</option>
            {docOptions.map((d) => (
              <option key={d.code} value={d.code}>
                {d.code} — {d.name.slice(0, 32)}
              </option>
            ))}
          </select>
          <div className="inline-flex items-center gap-1.5 text-xs text-[#71717a]">
            <span>Mẫu/file:</span>
            <input
              type="number"
              min={1}
              max={100}
              className="ts-input py-1 w-14 font-mono text-center text-xs"
              value={perDoc}
              onChange={(e) => setPerDoc(Number(e.target.value))}
            />
          </div>
          <button
            onClick={handleAutoSample}
            disabled={sampling}
            className="ts-btn-secondary py-1 text-xs disabled:opacity-45"
          >
            {sampling ? <Loader2 className="size-3.5 animate-spin" /> : <Shuffle className="size-3.5" />}
            {sampling ? 'Đang quét...' : 'Lấy mẫu & Quét'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-[#52525b]">
          <span title="Chunk Integrity (Phụ lục A)">
            Trọn ý:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">
              {((metrics?.chunk_integrity || 0) * 100).toFixed(0)}%
            </strong>
          </span>
          <span title="Context Sufficiency (Phụ lục A)">
            Đủ nghĩa:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">
              {((metrics?.context_sufficiency || 0) * 100).toFixed(0)}%
            </strong>
          </span>
          <span title="Noise Rate (Phụ lục A — càng thấp càng tốt)">
            Nhiễu:{' '}
            <strong className="font-mono tabular-nums text-[#b45309]">
              {((metrics?.noise_rate || 0) * 100).toFixed(0)}%
            </strong>
          </span>
          <span title="Duplicate Rate (Phụ lục A — càng thấp càng tốt)">
            Trùng:{' '}
            <strong className="font-mono tabular-nums text-[#b45309]">
              {((metrics?.duplicate_rate || 0) * 100).toFixed(0)}%
            </strong>
          </span>
          <span title="Size Compliance (Phụ lục A)">
            Độ dài:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">
              {((metrics?.size_compliance ?? metrics?.valid_size_rate ?? 0) * 100).toFixed(0)}%
            </strong>
          </span>
          <span title="Answer Containment (Phụ lục A — theo Golden Testcases)">
            Trọn đáp án:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">
              {metrics?.testcase_count ? `${((metrics.answer_containment || 0) * 100).toFixed(0)}%` : '—'}
            </strong>
          </span>
          {onNextStep && (
            <button onClick={onNextStep} className="ts-btn-primary py-1 text-xs ml-1">
              Bước 4: Tìm kiếm
              <ArrowRight className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Sharp GitHub-style Matrix Overview */}
      <div
        className={`px-6 py-3.5 border-b border-[#e8e8e6] bg-white ${
          selected ? 'shrink-0' : 'flex-1 overflow-y-auto'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono text-[11px] font-semibold text-[#18181b] mr-2" title="Đã chốt thủ công / Tổng mẫu">
              {metrics?.rated_manual || 0}/{counts.TOTAL}
            </span>
            {(
              [
                { id: 'ALL', label: `Tất cả (${counts.TOTAL})`, dot: 'bg-[#18181b]' },
                { id: 'OK', label: `${counts.OK}`, dot: 'bg-[#2da44e]' },
                { id: 'WARN', label: `${counts.WARN}`, dot: 'bg-[#d4a72c]' },
                { id: 'SEVERE', label: `${counts.SEVERE}`, dot: 'bg-[#cf222e]' },
                { id: 'UNCONFIRMED', label: `Chưa chốt (${counts.UNCONFIRMED})`, dot: 'bg-[#d4d4d8]' },
              ] as { id: ChunkFilter; label: string; dot: string }[]
            ).map((f) => (
              <button
                key={f.id}
                onClick={() => {
                  setColorFilter(f.id);
                  setSelected(null);
                }}
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
            {preview ? (
              <>
                <span className="font-semibold text-[#18181b]">
                  {preview.doc_code} #{preview.chunk_index}
                </span>
                <span>{preview.char_count}c</span>
                <span>p.{preview.page_num || '—'}</span>
                {(preview.error_codes || []).length > 0 && (
                  <span className="text-[#cf222e]">{preview.error_codes.join(', ')}</span>
                )}
              </>
            ) : (
              <span className="text-[#a1a1aa] font-sans">Bấm vào ô vuông để xem chi tiết & ranh giới cắt</span>
            )}
          </div>
        </div>

        {sampling && chunks.length === 0 ? (
          <div className="py-12 flex items-center justify-center gap-2 text-xs text-[#71717a]">
            <Loader2 className="size-4 animate-spin" /> Đang lấy mẫu & quét lỗi tự động...
          </div>
        ) : visibleChunks.length === 0 ? (
          <div className="py-12 text-center text-xs text-[#71717a] bg-[#fafaf9]">
            Không có đoạn nào phù hợp bộ lọc. Bấm <strong>Lấy mẫu & Quét</strong> hoặc đổi bộ lọc màu.
          </div>
        ) : (
          <div className={`space-y-2.5 ${selected ? 'max-h-[120px] overflow-y-auto pr-1' : ''}`}>
            {Object.values(grouped).map((grp) => (
              <div key={grp.doc_code} className="flex items-start gap-3">
                <div
                  className="w-20 shrink-0 font-mono text-[11px] font-medium text-[#52525b] pt-0.5 truncate"
                  title={grp.filename}
                >
                  {grp.doc_code}
                </div>
                <div className="flex flex-wrap gap-[3px]">
                  {grp.items.map((c) => {
                    const isSel = selected?.chunk_pk === c.chunk_pk;
                    return (
                      <button
                        key={c.chunk_pk}
                        type="button"
                        onClick={() => (isSel ? setSelected(null) : pickChunk(c))}
                        onMouseEnter={() => setHovered(c)}
                        onMouseLeave={() => setHovered(null)}
                        aria-label={`${c.doc_code} #${c.chunk_index}`}
                        className={`relative size-[22px] rounded-none border-0 transition-opacity cursor-pointer ${getTileClass(
                          c,
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

      {/* Expandable Detail Inspector — ONLY visible when a tile is clicked */}
      {selected && (
        <div className="flex-1 flex flex-col min-h-0 bg-white">
          <div className="px-5 py-2 border-b border-[#ededeb] bg-[#fafaf9] flex items-center justify-between text-xs shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="inline-flex items-center border border-[#e4e4e2] bg-white">
                <button
                  onClick={() => stepChunk(-1)}
                  disabled={selectedIdx <= 0}
                  className="p-1 text-[#52525b] hover:bg-[#f4f4f2] disabled:opacity-30"
                  title="Đoạn trước (←)"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
                <span className="px-2 font-mono text-[11px] text-[#18181b] border-x border-[#e4e4e2]">
                  {selectedIdx + 1}/{visibleChunks.length}
                </span>
                <button
                  onClick={() => stepChunk(1)}
                  disabled={selectedIdx < 0 || selectedIdx >= visibleChunks.length - 1}
                  className="p-1 text-[#52525b] hover:bg-[#f4f4f2] disabled:opacity-30"
                  title="Đoạn sau (→)"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </div>
              <span className="font-mono font-semibold text-[#18181b]">
                {selected.doc_code} · Chunk #{selected.chunk_index}
              </span>
              <span className="ts-tag-neutral">Trang {selected.page_num || '—'}</span>
              <span className="font-mono text-[11px] text-[#78716c]">
                {selected.char_count} ký tự · ~{selected.token_est} token
              </span>
              <span className="text-[11px] px-1.5 py-0.5 bg-[#f4f4f2] text-[#52525b]">
                {selected.judge_source === 'MANUAL' ? 'Đã chốt' : 'Gợi ý tự động'}
              </span>
            </div>

            <div className="flex items-center gap-3">
              <span className="hidden md:inline text-[11px] text-[#a1a1aa] font-mono">
                ←/→ chuyển · Enter lưu & tiếp · Esc đóng
              </span>
              <button
                onClick={() => setSelected(null)}
                className="inline-flex items-center gap-1 text-xs text-[#52525b] hover:text-[#18181b] px-2 py-1 hover:bg-[#ededeb]"
              >
                <X className="size-3.5" /> Đóng
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
            {/* Auto-detected flags */}
            {(selected.rule_flags || []).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selected.rule_flags.map((f) => (
                  <span key={f} className="text-[11px] px-2 py-0.5 bg-[#fffbeb] text-[#b45309] border border-[#fde68a]">
                    {FLAG_LABELS[f] || f}
                  </span>
                ))}
              </div>
            )}

            {/* Boundary Context: Prev Chunk Tail */}
            {selected.prev_tail && (
              <div className="bg-[#fafaf9] border border-dashed border-[#e4e4e2] px-3.5 py-2 text-xs text-[#78716c]">
                <span className="font-mono text-[10px] uppercase tracking-wide text-[#a1a1aa] mr-2">
                  Cuối Chunk #{selected.chunk_index - 1}:
                </span>
                …{selected.prev_tail}
              </div>
            )}

            {/* Main Chunk Content */}
            <div className="bg-[#fafaf9] border border-[#d4d4d0] p-4 text-[13.5px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty">
              {selected.content}
            </div>

            {/* Boundary Context: Next Chunk Head */}
            {selected.next_head && (
              <div className="bg-[#fafaf9] border border-dashed border-[#e4e4e2] px-3.5 py-2 text-xs text-[#78716c]">
                <span className="font-mono text-[10px] uppercase tracking-wide text-[#a1a1aa] mr-2">
                  Đầu Chunk #{selected.chunk_index + 1}:
                </span>
                {selected.next_head}…
              </div>
            )}
          </div>

          {/* Calm, Compact Bottom Action Bar */}
          <div className="px-5 py-2.5 border-t border-[#e8e8e6] bg-[#fafaf9] space-y-2 shrink-0">
            {/* 5 Criteria Compact Toggles */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-[11px] text-[#78716c] mr-1">5 tiêu chí:</span>
              <MiniToggle label="Trọn ý" value={integrity} onChange={setIntegrity} />
              <MiniToggle label="Đủ nghĩa" value={contextSuff} onChange={setContextSuff} />
              <MiniToggle label="Sạch rác" value={noNoise} onChange={setNoNoise} />
              <MiniToggle label="Không trùng" value={noDup} onChange={setNoDup} />
              <MiniToggle label="Độ dài ổn" value={validSize} onChange={setValidSize} />
            </div>

            {/* 1-Row Monochrome C1..C8 Pills */}
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-[#78716c] mr-1.5">Lỗi (C1–C8):</span>
              {errorCatalog.map((ec) => {
                const active = errCodes.includes(ec.code);
                return (
                  <button
                    key={ec.code}
                    disabled={saving}
                    onClick={() => toggleCode(ec.code)}
                    title={`${ec.code} · ${ec.name} (${ec.severity})`}
                    className={`font-mono text-[11px] px-2 py-0.5 border transition-colors ${
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
                <span className="text-[11px] text-[#52525b] ml-1.5 truncate max-w-[320px]">
                  {errCodes
                    .map((c) => errorCatalog.find((e) => e.code === c)?.name)
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <input
                className="ts-input flex-1 py-1 text-xs"
                placeholder="Ghi chú ngắn..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <button
                onClick={handleSaveScore}
                disabled={saving}
                className="ts-btn-primary py-1.5 text-xs disabled:opacity-45"
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Lưu & Tiếp (Enter)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const MiniToggle: React.FC<{ label: string; value: number; onChange: (v: number) => void }> = ({
  label,
  value,
  onChange,
}) => (
  <button
    type="button"
    onClick={() => onChange(value === 1 ? 0 : 1)}
    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border transition-colors ${
      value === 1
        ? 'bg-white text-[#18181b] border-[#e4e4e2] hover:bg-[#f4f4f2]'
        : 'bg-[#fef2f2] text-[#b91c1c] border-[#fecaca] font-medium'
    }`}
  >
    <span className={`size-1.5 inline-block ${value === 1 ? 'bg-[#2da44e]' : 'bg-[#cf222e]'}`} />
    {label}
  </button>
);
