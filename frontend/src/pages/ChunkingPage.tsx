import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Filter, Shuffle } from 'lucide-react';
import { api } from '../api/client';
import { ChunkEvalItem, ErrorCodeDef, RunItem } from '../types';

interface Props {
  activeRun: RunItem | null;
  errorCatalog: ErrorCodeDef[];
}

const FLAG_LABELS: Record<string, string> = {
  EMPTY: 'Đoạn rỗng',
  TOO_SHORT: 'Quá ngắn (<50 ký tự)',
  TOO_LONG: 'Quá dài (>2600 ký tự)',
  NUMERIC_ONLY_NOISE: 'Chỉ chứa số (nghi số trang)',
  SUSPECTED_NOISE: 'Nghi dính rác menu/header',
  CHAR_CORRUPTION: 'Có ký tự lỗi font',
  DUPLICATE: 'Trùng lặp với đoạn khác',
};

export const ChunkingPage: React.FC<Props> = ({ activeRun, errorCatalog }) => {
  const [chunks, setChunks] = useState<ChunkEvalItem[]>([]);
  const [selected, setSelected] = useState<ChunkEvalItem | null>(null);
  const [metrics, setMetrics] = useState<any>(null);
  const [perDoc, setPerDoc] = useState(5);
  const [filterFlagged, setFilterFlagged] = useState(false);

  const [integrity, setIntegrity] = useState<number>(1);
  const [contextSuff, setContextSuff] = useState<number>(1);
  const [noNoise, setNoNoise] = useState<number>(1);
  const [noDup, setNoDup] = useState<number>(1);
  const [validSize, setValidSize] = useState<number>(1);
  const [errCodes, setErrCodes] = useState<string[]>([]);
  const [notes, setNotes] = useState('');

  const load = async (advanceFromPk?: number) => {
    if (!activeRun) return;
    const [list, m] = await Promise.all([
      api.listChunkEvals(activeRun.id, true),
      api.getChunkingMetrics(activeRun.id),
    ]);
    setChunks(list);
    setMetrics(m);
    if (list.length > 0) {
      if (advanceFromPk) {
        const idx = list.findIndex((c: ChunkEvalItem) => c.chunk_pk === advanceFromPk);
        pickChunk(idx >= 0 && idx + 1 < list.length ? list[idx + 1] : list[idx] || list[0]);
      } else {
        const keep = selected ? list.find((c: ChunkEvalItem) => c.chunk_pk === selected.chunk_pk) : null;
        pickChunk(keep || list[0]);
      }
    } else {
      setSelected(null);
    }
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

  useEffect(() => {
    load();
  }, [activeRun?.id]);

  if (!activeRun) {
    return <div className="p-8 text-sm text-[#71717a]">Hãy chọn hoặc tạo một phiên kiểm thử trước.</div>;
  }

  const handleAutoSample = async () => {
    try {
      await api.sampleChunks(activeRun.id, perDoc);
      await load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleSaveScore = async () => {
    if (!selected) return;
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
  };

  const toggleCode = (code: string) => {
    setErrCodes((prev) => (prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]));
  };

  const visibleChunks = filterFlagged
    ? chunks.filter((c) => (c.rule_flags || []).length > 0)
    : chunks;

  return (
    <div className="h-[calc(100dvh-48px)] flex flex-col bg-white">
      {/* Toolbar */}
      <div className="px-5 py-2.5 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#71717a]">Mẫu/file:</span>
          <input
            type="number"
            min={1}
            max={50}
            className="ts-input py-1 w-14 font-mono text-center text-xs"
            value={perDoc}
            onChange={(e) => setPerDoc(Number(e.target.value))}
          />
          <button onClick={handleAutoSample} className="ts-btn-primary py-1 text-xs">
            <Shuffle className="size-3.5" /> Chọn mẫu & Quét lỗi
          </button>
          <button
            onClick={() => setFilterFlagged(!filterFlagged)}
            className={`ts-btn-secondary py-1 text-xs ${
              filterFlagged ? 'bg-[#f3e5ef] border-[#d8b4ce] text-[#6d2e58]' : ''
            }`}
          >
            <Filter className="size-3.5" /> Chỉ đoạn nghi lỗi
          </button>
        </div>

        <div className="flex items-center gap-4 text-xs text-[#52525b]">
          <span>
            Trọn ý:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">
              {((metrics?.chunk_integrity || 0) * 100).toFixed(0)}%
            </strong>
          </span>
          <span>
            Đọc riêng vẫn hiểu:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">
              {((metrics?.context_sufficiency || 0) * 100).toFixed(0)}%
            </strong>
          </span>
          <span>
            Dính rác:{' '}
            <strong className="font-mono tabular-nums text-amber-700">
              {((metrics?.noise_rate || 0) * 100).toFixed(0)}%
            </strong>
          </span>
        </div>
      </div>

      {/* Split Workspace */}
      <div className="flex-1 grid grid-cols-12 min-h-0">
        {/* Left List */}
        <div className="col-span-4 border-r border-[#e8e8e6] overflow-y-auto bg-[#fafaf9]">
          <div className="px-4 py-2 border-b border-[#ededeb] ts-eyebrow">
            ĐÃ CHẤM {metrics?.rated_integrity || 0} / {chunks.length} ĐOẠN MẪU
          </div>
          {visibleChunks.map((c) => {
            const hasFlags = (c.rule_flags || []).length > 0;
            const rated = c.integrity !== null;
            return (
              <button
                key={c.chunk_pk}
                onClick={() => pickChunk(c)}
                className={`w-full text-left px-4 py-3 border-b border-[#ededeb] transition-colors ${
                  selected?.chunk_pk === c.chunk_pk
                    ? 'bg-white border-l-2 border-l-[#18181b]'
                    : 'hover:bg-white/70'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] font-medium text-[#52525b]">
                    {c.doc_code || 'DOC'} · #{c.chunk_index}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[11px] text-[#a1a1aa]">{c.char_count}c</span>
                    {hasFlags && <AlertTriangle className="size-3.5 text-amber-600" />}
                    <span className={`size-2 rounded-full ${rated ? 'bg-emerald-600' : 'bg-[#d4d4d8]'}`} />
                  </div>
                </div>
                <div className="text-[13px] text-[#3f3f46] truncate mt-1">{c.content}</div>
              </button>
            );
          })}
          {visibleChunks.length === 0 && (
            <div className="p-8 text-center text-[13px] text-[#71717a]">
              Chưa có đoạn mẫu. Bấm <strong>Chọn mẫu & Quét lỗi</strong> ở trên.
            </div>
          )}
        </div>

        {/* Right Review Pane */}
        <div className="col-span-8 overflow-y-auto p-6 space-y-5 bg-white">
          {selected ? (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <div className="ts-eyebrow">
                    {selected.doc_code} · ĐOẠN #{selected.chunk_index} · TRANG {selected.page_num || '—'}
                  </div>
                  <div className="text-xs text-[#71717a] mt-0.5 font-mono">
                    {selected.char_count} ký tự · ~{selected.token_est} token
                  </div>
                </div>
                <span className="ts-tag-neutral">{selected.ragflow_chunk_id.slice(0, 14)}</span>
              </div>

              {(selected.rule_flags || []).length > 0 && (
                <div className="ts-editorial-banner border border-[#e3c8da] rounded-[4px] px-4 py-3 flex items-start gap-2.5 text-[13px] text-[#4a1d3b]">
                  <AlertTriangle className="size-4 text-[#6d2e58] shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">Phát hiện tự động: </span>
                    {selected.rule_flags.map((f) => FLAG_LABELS[f] || f).join(' · ')}
                  </div>
                </div>
              )}

              {/* Light Editorial Content Block with Line Number Margin (TypeSafe style) */}
              <div className="bg-[#f7f7f5] border border-[#e6e6e3] rounded-[4px] flex overflow-hidden">
                <div className="w-9 shrink-0 bg-[#f0f0ee] border-r border-[#e6e6e3] py-4 text-center font-mono text-[11px] text-[#a1a1aa] select-none">
                  1
                </div>
                <div className="p-4 text-[14px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty max-h-[280px] overflow-y-auto flex-1">
                  {selected.content}
                </div>
              </div>

              {/* 5 Criteria Grid (like TypeSafe's question-type tiles) */}
              <div className="space-y-4 pt-1">
                <div className="ts-eyebrow">ĐÁNH GIÁ 5 TIÊU CHÍ (BẤM ĐỂ ĐỔI ĐẠT / LỖI)</div>
                <div className="grid grid-cols-2 sm:grid-cols-5 border border-[#e6e6e3] rounded-[4px] divide-x divide-[#e6e6e3] overflow-hidden">
                  <TileToggle tag="integrity" label="Trọn ý?" hint="Không cắt ngang câu" value={integrity} onChange={setIntegrity} />
                  <TileToggle tag="context" label="Đủ nghĩa?" hint="Đọc riêng vẫn hiểu" value={contextSuff} onChange={setContextSuff} />
                  <TileToggle tag="clean" label="Sạch sẽ?" hint="Không dính rác" value={noNoise} onChange={setNoNoise} />
                  <TileToggle tag="unique" label="Không trùng?" hint="Không lặp đoạn" value={noDup} onChange={setNoDup} />
                  <TileToggle tag="size" label="Độ dài ổn?" hint="Không vụn/quá dài" value={validSize} onChange={setValidSize} />
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {errorCatalog.map((ec) => {
                    const active = errCodes.includes(ec.code);
                    return (
                      <button
                        key={ec.code}
                        onClick={() => toggleCode(ec.code)}
                        className={`text-xs px-2 py-1 rounded-[3px] border transition-colors ${
                          active
                            ? 'bg-[#f3e5ef] text-[#6d2e58] border-[#d8b4ce] font-medium'
                            : 'bg-white text-[#52525b] border-[#e4e4e2] hover:bg-[#f4f4f2]'
                        }`}
                      >
                        {ec.name}
                      </button>
                    );
                  })}
                </div>

                <div className="flex gap-2.5 pt-1">
                  <input
                    className="ts-input flex-1"
                    placeholder="Ghi chú ngắn (không bắt buộc)..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                  <button onClick={handleSaveScore} className="ts-btn-primary">
                    <Check className="size-3.5" /> Lưu & Sang đoạn tiếp
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-[#71717a]">
              Chọn một đoạn bên trái để bắt đầu chấm.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const TileToggle: React.FC<{
  tag: string;
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
}> = ({ tag, label, hint, value, onChange }) => (
  <button
    type="button"
    onClick={() => onChange(value === 1 ? 0 : 1)}
    className={`p-3 text-left transition-colors ${
      value === 1 ? 'bg-white hover:bg-[#fafaf9]' : 'bg-rose-50/70 hover:bg-rose-50'
    }`}
  >
    <span className="ts-tag-neutral text-[10px]">{tag}</span>
    <div className="text-[13px] font-semibold text-[#18181b] mt-2">{label}</div>
    <div className="text-[11px] text-[#71717a] italic mt-0.5">{hint}</div>
    <div
      className={`text-xs font-mono font-semibold mt-2.5 ${
        value === 1 ? 'text-emerald-700' : 'text-rose-600'
      }`}
    >
      {value === 1 ? '✓ ĐẠT' : '✕ LỖI'}
    </div>
  </button>
);
