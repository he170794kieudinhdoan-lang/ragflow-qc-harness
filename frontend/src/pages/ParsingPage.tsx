import React, { useEffect, useState } from 'react';
import { Check, Plus, Sparkles, X } from 'lucide-react';
import { api } from '../api/client';
import { DocumentItem, ErrorCodeDef, ParsingUnit, RunItem } from '../types';

interface Props {
  activeRun: RunItem | null;
  errorCatalog: ErrorCodeDef[];
}

export const ParsingPage: React.FC<Props> = ({ activeRun, errorCatalog }) => {
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<number | undefined>(undefined);
  const [units, setUnits] = useState<ParsingUnit[]>([]);
  const [selectedUnit, setSelectedUnit] = useState<ParsingUnit | null>(null);
  const [metrics, setMetrics] = useState<any>(null);
  const [showAdd, setShowAdd] = useState(false);

  const [newType, setNewType] = useState('text');
  const [newPage, setNewPage] = useState(1);
  const [newTitle, setNewTitle] = useState('');
  const [newText, setNewText] = useState('');

  const [errCodes, setErrCodes] = useState<string[]>([]);
  const [charErr, setCharErr] = useState(false);
  const [notes, setNotes] = useState('');

  const load = async (advanceFromId?: number) => {
    if (!activeRun) return;
    const [dRes, uRes, mRes] = await Promise.all([
      api.listDocuments(),
      api.listParsingUnits(activeRun.id, selectedDocId),
      api.getParsingMetrics(activeRun.id),
    ]);
    setDocs(dRes);
    setUnits(uRes);
    setMetrics(mRes);
    if (uRes.length > 0) {
      if (advanceFromId) {
        const idx = uRes.findIndex((u: ParsingUnit) => u.id === advanceFromId);
        selectUnit(idx >= 0 && idx + 1 < uRes.length ? uRes[idx + 1] : uRes[idx] || uRes[0]);
      } else {
        const keep = selectedUnit ? uRes.find((u: ParsingUnit) => u.id === selectedUnit.id) : null;
        selectUnit(keep || uRes[0]);
      }
    } else {
      setSelectedUnit(null);
    }
  };

  const selectUnit = (u: ParsingUnit) => {
    setSelectedUnit(u);
    setErrCodes(u.error_codes || []);
    setCharErr(Boolean(u.char_error));
    setNotes(u.notes || '');
  };

  useEffect(() => {
    load();
  }, [activeRun?.id, selectedDocId]);

  if (!activeRun) {
    return <div className="p-8 text-sm text-[#71717a]">Hãy chọn hoặc tạo một phiên kiểm thử trước.</div>;
  }

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

  const handleAutoExtract = async () => {
    if (!selectedDocId) return;
    try {
      await api.autoExtractUnits(activeRun.id, selectedDocId);
      await load();
    } catch (e: any) {
      alert(e.message);
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
    setErrCodes((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  const badge = (v: string) => {
    if (v === 'PASS') return { text: 'Đúng', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    if (v === 'PARTIAL') return { text: 'Thiếu 1 phần', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
    if (v === 'FAIL') return { text: 'Sai', cls: 'bg-rose-50 text-rose-700 border-rose-200' };
    return { text: 'Chưa chấm', cls: 'bg-[#f4f4f2] text-[#71717a] border-[#e6e6e3]' };
  };

  return (
    <div className="h-[calc(100dvh-48px)] flex flex-col bg-white">
      {/* Sub-header Toolbar */}
      <div className="px-5 py-2.5 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-3">
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
            <button onClick={handleAutoExtract} className="ts-btn-secondary py-1 text-xs">
              <Sparkles className="size-3.5 text-[#6d2e58]" />
              Tự tách đoạn từ file gốc
            </button>
          )}
          <button onClick={() => setShowAdd(true)} className="ts-btn-secondary py-1 text-xs">
            <Plus className="size-3.5" />
            Thêm đoạn so sánh
          </button>
        </div>

        <div className="flex items-center gap-4 text-xs text-[#52525b]">
          <span>
            Đọc đủ chữ:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">
              {((metrics?.text_completeness || 0) * 100).toFixed(0)}%
            </strong>
          </span>
          <span>
            Giữ đúng bảng:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">
              {((metrics?.table_accuracy || 0) * 100).toFixed(0)}%
            </strong>
          </span>
          <span>
            Lỗi dấu/OCR:{' '}
            <strong className="font-mono tabular-nums text-rose-600">
              {((metrics?.character_error_rate || 0) * 100).toFixed(0)}%
            </strong>
          </span>
        </div>
      </div>

      {/* Edge-to-Edge Split Workbench */}
      <div className="flex-1 grid grid-cols-12 min-h-0">
        {/* Left List */}
        <div className="col-span-3 border-r border-[#e8e8e6] overflow-y-auto bg-[#fafaf9]">
          <div className="px-4 py-2 border-b border-[#ededeb] ts-eyebrow">
            ĐÃ CHẤM {metrics?.rated_units || 0} / {units.length}
          </div>
          {units.map((u) => {
            const b = badge(u.verdict);
            return (
              <button
                key={u.id}
                onClick={() => selectUnit(u)}
                className={`w-full text-left px-4 py-3 border-b border-[#ededeb] transition-colors ${
                  selectedUnit?.id === u.id ? 'bg-white border-l-2 border-l-[#18181b]' : 'hover:bg-white/70'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-[#78716c]">
                    {u.doc_code} · p.{u.page_num}
                  </span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-[3px] border ${b.cls}`}>
                    {b.text}
                  </span>
                </div>
                <div className="text-[13px] font-medium text-[#18181b] truncate mt-1">
                  {u.title || u.source_text.slice(0, 55)}
                </div>
              </button>
            );
          })}
        </div>

        {/* Right Side-by-Side Comparison */}
        <div className="col-span-9 flex flex-col min-h-0 bg-white">
          {selectedUnit ? (
            <>
              <div className="flex-1 grid grid-cols-2 min-h-0 divide-x divide-[#e8e8e6] overflow-hidden">
                {/* Original */}
                <div className="p-6 overflow-y-auto space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="ts-eyebrow">NỘI DUNG TÀI LIỆU GỐC ({selectedUnit.doc_code})</span>
                    <span className="ts-tag-neutral">Trang {selectedUnit.page_num}</span>
                  </div>
                  <div className="bg-[#f7f7f5] border border-[#e6e6e3] rounded-[4px] p-4 text-[14px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty">
                    {selectedUnit.source_text}
                  </div>
                  {selectedUnit.has_local_file && selectedUnit.filename.toLowerCase().endsWith('.pdf') && (
                    <img
                      src={`/api/parsing/documents/${selectedUnit.document_id}/page/${selectedUnit.page_num}`}
                      alt="Trang PDF gốc"
                      className="w-full rounded-[4px] border border-[#e6e6e3]"
                    />
                  )}
                </div>

                {/* Parsed */}
                <div className="p-6 overflow-y-auto space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="ts-eyebrow">KẾT QUẢ RAGFLOW ĐỌC RA</span>
                    <span className="ts-tag-mauve">{selectedUnit.matched_chunks.length} đoạn khớp</span>
                  </div>
                  {selectedUnit.matched_chunks.map((ch) => (
                    <div key={ch.ragflow_chunk_id} className="bg-[#f7f7f5] border border-[#e6e6e3] rounded-[4px] p-4 space-y-2">
                      <div className="flex items-center justify-between font-mono text-[11px] text-[#78716c]">
                        <span>Đoạn #{ch.chunk_index}</span>
                        <span>{ch.char_count} ký tự</span>
                      </div>
                      <div className="text-[14px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty">
                        {ch.content}
                      </div>
                    </div>
                  ))}
                  {selectedUnit.matched_chunks.length === 0 && (
                    <div className="bg-rose-50 border border-rose-200 rounded-[4px] p-4 text-[13px] text-rose-800">
                      Không tìm thấy đoạn nào khớp sau khi đọc file (có thể bị mất đoạn hoặc ảnh không OCR được).
                    </div>
                  )}
                </div>
              </div>

              {/* Crisp Bottom Action Bar */}
              <div className="px-6 py-4 border-t border-[#e8e8e6] bg-[#fafaf9] space-y-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-[#71717a] mr-1">Gắn lỗi (nếu sai):</span>
                  {errorCatalog.slice(0, 6).map((ec) => {
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
                  <label className="ml-2 flex items-center gap-1.5 text-xs text-[#3f3f46] cursor-pointer">
                    <input type="checkbox" checked={charErr} onChange={(e) => setCharErr(e.target.checked)} />
                    Lỗi dấu / chữ tiếng Việt
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <input
                    className="ts-input flex-1 min-w-[200px]"
                    placeholder="Ghi chú ngắn (không bắt buộc)..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                  <button
                    onClick={() => handleScore('PASS')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[4px] text-[13px] font-medium bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    <Check className="size-3.5" /> Đọc đúng
                  </button>
                  <button
                    onClick={() => handleScore('PARTIAL')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[4px] text-[13px] font-medium bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300"
                  >
                    Thiếu 1 phần
                  </button>
                  <button
                    onClick={() => handleScore('FAIL')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[4px] text-[13px] font-medium bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-300"
                  >
                    <X className="size-3.5" /> Đọc sai
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-[#71717a]">
              Chọn một đoạn bên trái để đối chiếu.
            </div>
          )}
        </div>
      </div>

      {/* Modal: Add Unit */}
      {showAdd && (
        <div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4">
          <form onSubmit={handleAddUnit} className="bg-white border border-[#e4e4e2] rounded-[6px] w-full max-w-lg p-6 space-y-4 shadow-lg">
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
                  <option value="image">Ảnh / Scan</option>
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
