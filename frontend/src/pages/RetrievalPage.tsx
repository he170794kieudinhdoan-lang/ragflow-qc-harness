import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, Play, Plus, Sparkles, Wand2, X } from 'lucide-react';
import { api } from '../api/client';
import { RetrievalResultGroup, RetrievalRun, RunItem } from '../types';

interface Props {
  activeRun: RunItem | null;
}

const AC_LABELS: Record<string, string> = {
  FULL: 'Đáp án nằm gọn trong 1 đoạn',
  SPLIT: 'Đáp án bị tách nhiều đoạn',
  MISSING: 'Không có trong bản cắt',
  UNCHECKED: 'Chưa kiểm tra',
};

export const RetrievalPage: React.FC<Props> = ({ activeRun }) => {
  const [rrList, setRrList] = useState<RetrievalRun[]>([]);
  const [selectedRrId, setSelectedRrId] = useState<number | null>(null);
  const [groups, setGroups] = useState<RetrievalResultGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<RetrievalResultGroup | null>(null);
  const [showAddTc, setShowAddTc] = useState(false);
  const [showRunModal, setShowRunModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genPerDoc, setGenPerDoc] = useState(3);
  const [useLlmGen, setUseLlmGen] = useState(false);
  const [useLlmJudge, setUseLlmJudge] = useState(false);

  const [tcCode, setTcCode] = useState('TC04');
  const [tcClass, setTcClass] = useState('Local');
  const [tcSource, setTcSource] = useState('DOC01');
  const [tcQ, setTcQ] = useState('');
  const [tcRef, setTcRef] = useState('');

  const [rrName, setRrName] = useState('Thử nghiệm tìm kiếm mới');
  const [topK, setTopK] = useState(10);
  const [threshold, setThreshold] = useState(0.2);
  const [vecWeight, setVecWeight] = useState(0.3);
  const [rerankId, setRerankId] = useState('');

  const loadRuns = async () => {
    if (!activeRun) return;
    const list = await api.listRetrievalRuns(activeRun.id);
    setRrList(list);
    if (list.length > 0) {
      const targetId = selectedRrId && list.some((x: any) => x.id === selectedRrId) ? selectedRrId : list[0].id;
      setSelectedRrId(targetId);
    } else {
      setSelectedRrId(null);
      setGroups([]);
      setSelectedGroup(null);
    }
  };

  const loadResults = async (rrId: number) => {
    const data = await api.getRetrievalResults(rrId);
    setGroups(data);
    if (data.length > 0) {
      const keep = selectedGroup ? data.find((g: RetrievalResultGroup) => g.testcase.id === selectedGroup.testcase.id) : null;
      setSelectedGroup(keep || data[0]);
    }
  };

  useEffect(() => {
    loadRuns();
  }, [activeRun?.id]);

  useEffect(() => {
    if (selectedRrId) loadResults(selectedRrId);
  }, [selectedRrId]);

  if (!activeRun) {
    return <div className="p-8 text-sm text-[#71717a]">Hãy chọn hoặc tạo một phiên kiểm thử trước.</div>;
  }

  const handleAddTc = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.createTestcase({
      tc_code: tcCode,
      input_question: tcQ,
      reference_context: tcRef,
      source_file: tcSource,
      question_class: tcClass,
    });
    setTcQ('');
    setTcRef('');
    setShowAddTc(false);
    if (selectedRrId) loadResults(selectedRrId);
  };

  const handleExecuteBenchmark = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.executeRetrieval({
        run_id: activeRun.id,
        name: rrName,
        top_k: topK,
        similarity_threshold: threshold,
        vector_similarity_weight: vecWeight,
        rerank_id: rerankId,
        keyword_enabled: true,
        use_llm: useLlmJudge,
      });
      setShowRunModal(false);
      await loadRuns();
      setSelectedRrId(res.retrieval_run_id);
      toast.success(
        `Chạy xong ${res.testcases_executed} câu hỏi · Giữ lại ${res.smart_cache_hits} nhãn đã chấm.`
      );
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleScoreHit = async (hitId: number, relevant: number, reason: string) => {
    await api.scoreRetrievalResult(hitId, relevant, reason);
    if (selectedRrId) await loadResults(selectedRrId);
  };

  const handleMetaUpdate = async (patch: any) => {
    if (!selectedRrId || !selectedGroup) return;
    await api.updateTestcaseMeta(selectedRrId, selectedGroup.testcase.id, {
      ...selectedGroup.meta,
      ...patch,
    });
    await loadResults(selectedRrId);
  };

  const handleAutoGenerate = async () => {
    if (!activeRun || generating) return;
    setGenerating(true);
    try {
      const res = await api.autoGenerateTestcases(activeRun.id, genPerDoc, false, useLlmGen);
      const modeNote = res.llm_used_count ? ` (${res.llm_used_count} câu bằng LLM)` : ' (0-LLM)';
      toast.success(`Đã sinh ${res.generated_count} câu hỏi Golden Dataset${modeNote}.`);
      await loadRuns();
      if (selectedRrId) await loadResults(selectedRrId);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const avgPrecision =
    groups.length > 0
      ? groups.reduce((s, g) => s + (g.contextual_precision || 0), 0) / groups.length
      : 0;
  const avgCoverage =
    groups.length > 0
      ? groups.reduce((s, g) => s + (g.meta?.context_coverage || 0), 0) / groups.length
      : 0;

  return (
    <div className="h-[calc(100dvh-48px)] flex flex-col bg-white">
      {/* Toolbar */}
      <div className="px-5 py-2.5 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="ts-input py-1 text-xs min-w-[200px]"
            value={selectedRrId ?? ''}
            onChange={(e) => setSelectedRrId(Number(e.target.value))}
          >
            {rrList.map((rr) => (
              <option key={rr.id} value={rr.id}>
                {rr.name}
              </option>
            ))}
            {rrList.length === 0 && <option value="">Chưa có lần chạy tìm kiếm nào</option>}
          </select>

          <div className="inline-flex items-center gap-1.5 text-xs text-[#71717a]">
            <input
              type="number"
              min={1}
              max={15}
              className="ts-input py-1 w-12 font-mono text-center text-xs"
              value={genPerDoc}
              onChange={(e) => setGenPerDoc(Number(e.target.value))}
              title="Số câu hỏi sinh ra trên mỗi tài liệu"
            />
            <label className="inline-flex items-center gap-1 text-[11px] text-[#52525b] cursor-pointer select-none" title="Bật để dùng LLM trong Cài đặt API (tắt = 0 LLM miễn phí)">
              <input type="checkbox" checked={useLlmGen} onChange={(e) => setUseLlmGen(e.target.checked)} />
              LLM
            </label>
            <button
              onClick={handleAutoGenerate}
              disabled={generating || busy}
              className="ts-btn-secondary py-1 text-xs disabled:opacity-45"
              title="Tự động sinh Golden Dataset từ các tài liệu trong phiên hiện tại"
            >
              {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
              {generating ? 'Đang sinh...' : 'Tự sinh Golden'}
            </button>
          </div>

          <button onClick={() => setShowRunModal(true)} disabled={busy || generating} className="ts-btn-primary py-1 text-xs disabled:opacity-45">
            <Play className="size-3.5" /> Chạy test tìm kiếm
          </button>
          <button onClick={() => setShowAddTc(true)} className="ts-btn-secondary py-1 text-xs">
            <Plus className="size-3.5" /> Thêm tay
          </button>
        </div>

        <div className="flex items-center gap-4 text-xs text-[#52525b]">
          <span title="Contextual Precision trung bình (Phụ lục A — 0..1)">
            Contextual Precision:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">{avgPrecision.toFixed(2)}</strong>
          </span>
          <span title="Context Coverage trung bình (Phụ lục A — %)">
            Context Coverage:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">{(avgCoverage * 100).toFixed(0)}%</strong>
          </span>
        </div>
      </div>

      {/* Split Workspace */}
      <div className="flex-1 grid grid-cols-12 min-h-0">
        {/* Left: Testcases */}
        <div className="col-span-4 border-r border-[#e8e8e6] overflow-y-auto bg-[#fafaf9]">
          <div className="px-4 py-2 border-b border-[#ededeb] ts-eyebrow">
            BỘ CÂU HỎI GOLDEN ({groups.length})
          </div>
          {groups.map((g) => (
            <button
              key={g.testcase.id}
              onClick={() => setSelectedGroup(g)}
              className={`w-full text-left px-4 py-3 border-b border-[#ededeb] transition-colors ${
                selectedGroup?.testcase.id === g.testcase.id
                  ? 'bg-white border-l-2 border-l-[#18181b]'
                  : 'hover:bg-white/70'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs font-semibold text-[#18181b]">{g.testcase.tc_code}</span>
                  <span className="ts-tag-neutral text-[10px]">{g.testcase.question_class}</span>
                </div>
                <span
                  className={`font-mono text-xs font-semibold tabular-nums ${
                    g.contextual_precision >= 0.5 ? 'text-emerald-700' : 'text-rose-600'
                  }`}
                >
                  {(g.contextual_precision * 100).toFixed(0)}%
                </span>
              </div>
              <div className="text-[13px] text-[#27272a] line-clamp-2 mt-1.5">{g.testcase.input_question}</div>
              <div className="text-[11px] text-[#78716c] mt-1">
                Đúng {g.relevant_count}/{g.hits.length} đoạn trả về
              </div>
            </button>
          ))}
        </div>

        {/* Right: Question & Top-K Hits */}
        <div className="col-span-8 overflow-y-auto p-6 space-y-5 bg-white">
          {selectedGroup ? (
            <>
              <div className="border border-[#e6e6e3] rounded-[4px] p-5 space-y-3.5 bg-[#fafaf9]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="ts-tag-mauve">{selectedGroup.testcase.tc_code}</span>
                    <span className="text-xs text-[#71717a]">
                      Nguồn: {selectedGroup.testcase.source_file || '—'} ·{' '}
                      {AC_LABELS[selectedGroup.meta.answer_containment] || selectedGroup.meta.answer_containment}
                    </span>
                  </div>
                  <span className="font-mono text-xs font-semibold text-emerald-700">
                    Xếp hạng: {(selectedGroup.contextual_precision * 100).toFixed(0)}%
                  </span>
                </div>

                <h2 className="text-base font-semibold text-[#18181b] text-balance">
                  {selectedGroup.testcase.input_question}
                </h2>

                <div className="bg-white border border-[#e6e6e3] rounded-[4px] p-3.5 space-y-1">
                  <div className="ts-eyebrow">ĐOẠN CĂN CỨ CHUẨN TRONG TÀI LIỆU GỐC</div>
                  <div className="text-[13px] text-[#27272a] leading-relaxed text-pretty">
                    {selectedGroup.testcase.reference_context}
                  </div>
                </div>

                <div className="pt-2 border-t border-[#e8e8e6] flex flex-wrap items-center gap-4 text-xs">
                  <label className="flex items-center gap-2 text-[#3f3f46]">
                    <span>Độ phủ thông tin (0–1):</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="1"
                      className="ts-input py-1 w-16 text-center font-mono text-xs"
                      value={selectedGroup.meta.context_coverage}
                      onChange={(e) => handleMetaUpdate({ context_coverage: Number(e.target.value) })}
                    />
                  </label>

                  <label className="flex items-center gap-2 text-[#3f3f46]">
                    <span>Nguyên nhân gốc (nếu Fail):</span>
                    <select
                      className="ts-input py-1 text-xs"
                      value={selectedGroup.meta.root_cause_layer || 'NONE'}
                      onChange={(e) => handleMetaUpdate({ root_cause_layer: e.target.value })}
                    >
                      <option value="NONE">Không lỗi (Pass)</option>
                      <option value="KEYWORD">R1 · Miss nhánh keyword (Nghiêm trọng)</option>
                      <option value="VECTOR">R2 · Miss nhánh vector (Nghiêm trọng)</option>
                      <option value="RERANK">R3 · Lỗi rerank (Trung bình)</option>
                      <option value="THRESHOLD">R4 · Lỗi ngưỡng / top-k (Trung bình)</option>
                      <option value="SIMILAR_DOC">R5 · Nhiễu tài liệu tương tự (Trung bình)</option>
                      <option value="PARSING">Tầng 1 · Lỗi đọc file (Parsing)</option>
                      <option value="CHUNKING">Tầng 2 · Lỗi cắt đoạn (Chunking)</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className="space-y-3">
                <div className="ts-eyebrow">TOP {selectedGroup.hits.length} ĐOẠN RAGFLOW TÌM ĐƯỢC</div>
                {selectedGroup.hits.map((hit) => (
                  <div
                    key={hit.id}
                    className={`border rounded-[4px] p-4 space-y-3 transition-colors ${
                      hit.relevant === 1
                        ? 'border-emerald-300 bg-emerald-50/40'
                        : hit.relevant === 0
                        ? 'border-[#ededeb] bg-[#fafaf9] opacity-80'
                        : 'border-[#e6e6e3] bg-white'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="ts-tag-neutral font-semibold">#{hit.rank}</span>
                        <span className="font-medium text-[#18181b]">{hit.doc_name || 'Tài liệu'}</span>
                        {hit.relevancy_source === 'CACHED' && (
                          <span className="ts-tag-mauve gap-1">
                            <Sparkles className="size-3" /> Đã chấm từ lần trước
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[#71717a] tabular-nums">
                        Khớp: <strong className="text-[#18181b]">{(hit.similarity * 100).toFixed(0)}%</strong>
                      </span>
                    </div>

                    <div className="text-[14px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty">
                      {hit.content}
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleScoreHit(hit.id, 1, 'Chứa thông tin trả lời')}
                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-[4px] text-xs font-medium border ${
                          hit.relevant === 1
                            ? 'bg-emerald-600 text-white border-emerald-600'
                            : 'bg-white text-[#3f3f46] border-[#e4e4e2] hover:border-emerald-500'
                        }`}
                      >
                        <Check className="size-3.5" /> Đúng (Relevant)
                      </button>
                      <button
                        onClick={() => handleScoreHit(hit.id, 0, 'Không liên quan')}
                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-[4px] text-xs font-medium border ${
                          hit.relevant === 0
                            ? 'bg-rose-600 text-white border-rose-600'
                            : 'bg-white text-[#3f3f46] border-[#e4e4e2] hover:border-rose-400'
                        }`}
                      >
                        <X className="size-3.5" /> Không liên quan
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-[#71717a]">
              Chọn một câu hỏi bên trái để xem kết quả tìm kiếm.
            </div>
          )}
        </div>
      </div>

      {/* Modal: Run Retrieval */}
      {showRunModal && (
        <div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4">
          <form onSubmit={handleExecuteBenchmark} className="bg-white border border-[#e4e4e2] rounded-[6px] w-full max-w-md p-6 space-y-4 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#18181b]">Chạy kiểm thử tìm kiếm mới</h2>
              <button type="button" onClick={() => setShowRunModal(false)} aria-label="Đóng">
                <X className="size-4 text-[#71717a]" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-[#52525b] mb-1">Tên lần chạy</label>
                <input className="ts-input w-full" value={rrName} onChange={(e) => setRrName(e.target.value)} required />
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-xs text-[#52525b] mb-1">Top-K</label>
                  <input type="number" className="ts-input w-full font-mono" value={topK} onChange={(e) => setTopK(Number(e.target.value))} />
                </div>
                <div>
                  <label className="block text-xs text-[#52525b] mb-1">Ngưỡng lọc</label>
                  <input type="number" step="0.05" className="ts-input w-full font-mono" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
                </div>
                <div>
                  <label className="block text-xs text-[#52525b] mb-1">Tỷ trọng Vector</label>
                  <input type="number" step="0.1" className="ts-input w-full font-mono" value={vecWeight} onChange={(e) => setVecWeight(Number(e.target.value))} />
                </div>
              </div>
              <div>
                <label className="block text-xs text-[#52525b] mb-1">Model Rerank (để trống nếu tắt)</label>
                <input className="ts-input w-full font-mono text-xs" placeholder="BAAI/bge-reranker-v2-m3" value={rerankId} onChange={(e) => setRerankId(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-xs text-[#3f3f46] cursor-pointer pt-1">
                <input type="checkbox" checked={useLlmJudge} onChange={(e) => setUseLlmJudge(e.target.checked)} />
                <span>Chấm nháp độ liên quan bằng LLM-as-a-Judge (tắt = RapidFuzz 0 đồng)</span>
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#ededeb]">
              <button type="button" onClick={() => setShowRunModal(false)} className="ts-btn-secondary">Hủy</button>
              <button type="submit" disabled={busy} className="ts-btn-primary">
                {busy ? 'Đang chạy...' : 'Bắt đầu chạy'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: Add Golden Testcase */}
      {showAddTc && (
        <div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4">
          <form onSubmit={handleAddTc} className="bg-white border border-[#e4e4e2] rounded-[6px] w-full max-w-lg p-6 space-y-4 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#18181b]">Thêm câu hỏi kiểm thử</h2>
              <button type="button" onClick={() => setShowAddTc(false)} aria-label="Đóng">
                <X className="size-4 text-[#71717a]" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-[#52525b] mb-1">Mã câu</label>
                <input className="ts-input w-full font-mono" value={tcCode} onChange={(e) => setTcCode(e.target.value)} required />
              </div>
              <div>
                <label className="block text-xs text-[#52525b] mb-1">Loại</label>
                <select className="ts-input w-full" value={tcClass} onChange={(e) => setTcClass(e.target.value)}>
                  <option value="Local">Local</option>
                  <option value="Global">Global</option>
                  <option value="Multi-hop">Multi-hop</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#52525b] mb-1">Tài liệu nguồn</label>
                <input className="ts-input w-full font-mono" value={tcSource} onChange={(e) => setTcSource(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="block text-xs text-[#52525b] mb-1">Câu hỏi người dùng</label>
              <input className="ts-input w-full" value={tcQ} onChange={(e) => setTcQ(e.target.value)} required />
            </div>
            <div>
              <label className="block text-xs text-[#52525b] mb-1">Đoạn căn cứ chuẩn trong tài liệu gốc</label>
              <textarea rows={3} className="ts-input w-full" value={tcRef} onChange={(e) => setTcRef(e.target.value)} required />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#ededeb]">
              <button type="button" onClick={() => setShowAddTc(false)} className="ts-btn-secondary">Hủy</button>
              <button type="submit" className="ts-btn-primary">Lưu câu hỏi</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
