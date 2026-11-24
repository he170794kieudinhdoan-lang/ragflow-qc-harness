import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Check, FileImage, Loader2, Play, Plus, Search, Sparkles, Wand2, X } from 'lucide-react';
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
  const [genTotalCount, setGenTotalCount] = useState(40);
  const [useLlmJudge, setUseLlmJudge] = useState(true);

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

  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<any>(null);
  const [openPdfChunkId, setOpenPdfChunkId] = useState<number | null>(null);

  useEffect(() => {
    setDiagnosis(null);
    setOpenPdfChunkId(null);
  }, [selectedGroup?.testcase.id, selectedRrId]);

  const handleDiagnose = async () => {
    if (!selectedRrId || !selectedGroup || diagnosing) return;
    setDiagnosing(true);
    try {
      const res = await api.diagnoseTestcase(selectedRrId, selectedGroup.testcase.id);
      setDiagnosis(res);
    } catch (e: any) {
      toast.error(e.message || 'Không chạy được chẩn đoán');
    } finally {
      setDiagnosing(false);
    }
  };

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
      const res = await api.autoGenerateTestcases(activeRun.id, genTotalCount, true);
      const cc = res.class_counts || {};
      toast.success(
        `LLM đã sinh ${res.generated_count} câu Golden (Local: ${cc.Local || 0}, Global: ${cc.Global || 0}, Multi-hop: ${cc['Multi-hop'] || 0}).`
      );
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
            className="ts-input py-1.5 px-2.5 text-xs rounded-md bg-white min-w-[200px]"
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

          <div className="h-4 w-px bg-[#e4e4e2] mx-0.5 hidden sm:block" />

          <div className="inline-flex items-center gap-1.5 text-xs text-[#71717a]">
            <input
              type="number"
              min={5}
              max={100}
              className="ts-input py-1.5 w-14 font-mono text-center text-xs rounded-md bg-white"
              value={genTotalCount}
              onChange={(e) => setGenTotalCount(Number(e.target.value))}
              title="Tổng số câu hỏi Golden Dataset (mặc định 40: 50% Local, 35% Global, 15% Multi-hop)"
            />
            <button
              onClick={handleAutoGenerate}
              disabled={generating || busy}
              className="ts-btn-secondary py-1.5 px-2.5 text-xs rounded-md disabled:opacity-45"
              title="Bắt buộc dùng LLM đọc tài liệu và sinh Golden Dataset chuẩn tỷ lệ 50/35/15"
            >
              {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
              {generating ? 'LLM đang sinh...' : 'Sinh Golden (LLM)'}
            </button>
          </div>

          <button onClick={() => setShowRunModal(true)} disabled={busy || generating} className="ts-btn-primary py-1.5 px-3 text-xs rounded-md disabled:opacity-45">
            <Play className="size-3.5" /> Chạy test tìm kiếm
          </button>
          <button onClick={() => setShowAddTc(true)} className="ts-btn-secondary py-1.5 px-2.5 text-xs rounded-md">
            <Plus className="size-3.5" /> Thêm tay
          </button>
        </div>

        <div className="flex items-center gap-2 text-xs text-[#52525b]">
          <span className="px-2.5 py-1 rounded-md bg-white border border-[#e4e4e2]" title="Contextual Precision trung bình (Phụ lục A — 0..1)">
            Precision:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">{avgPrecision.toFixed(2)}</strong>
          </span>
          <span className="px-2.5 py-1 rounded-md bg-white border border-[#e4e4e2]" title="Context Coverage trung bình (Phụ lục A — %)">
            Coverage:{' '}
            <strong className="font-mono tabular-nums text-[#18181b]">{(avgCoverage * 100).toFixed(0)}%</strong>
          </span>
        </div>
      </div>

      {/* Split Workspace */}
      <div className="flex-1 grid grid-cols-12 min-h-0">
        {/* Left: Testcases */}
        <div className="col-span-4 border-r border-[#e8e8e6] overflow-y-auto bg-[#fafaf9]">
          <div className="px-4 py-2.5 border-b border-[#ededeb] flex items-center justify-between gap-2 sticky top-0 bg-[#fafaf9] z-10">
            <span className="ts-eyebrow">BỘ CÂU HỎI GOLDEN ({groups.length})</span>
            <button
              type="button"
              onClick={async () => {
                if (!window.confirm('Xóa toàn bộ câu hỏi Golden Dataset hiện tại?')) return;
                try {
                  const res = await api.clearTestcases();
                  toast.success(`Đã xóa ${res.deleted} câu hỏi Golden.`);
                  setGroups([]);
                  setSelectedGroup(null);
                  await loadRuns();
                } catch (e: any) {
                  toast.error(e.message || 'Không xóa được Golden Dataset');
                }
              }}
              className="text-[11px] text-[#b91c1c] hover:underline font-medium"
            >
              Xóa hết
            </button>
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
                  <span
                    className={`size-2 rounded-full shrink-0 ${
                      g.relevant_count > 0
                        ? 'bg-emerald-500'
                        : g.hits.length > 0
                        ? 'bg-rose-400'
                        : 'bg-zinc-300'
                    }`}
                  />
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

                  <button
                    type="button"
                    onClick={handleDiagnose}
                    disabled={diagnosing}
                    className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[4px] bg-[#18181b] text-white hover:bg-[#27272a] disabled:opacity-50 transition-colors"
                  >
                    {diagnosing ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                    {diagnosing ? 'Đang soi kho chunk...' : 'Soi nguyên nhân gốc'}
                  </button>
                </div>
              </div>

              {diagnosis && (
                <div className="border border-[#d4d4d8] bg-[#fafaf9] rounded-[4px] p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="ts-eyebrow">CHẨN ĐOÁN NGUYÊN NHÂN GỐC (WHITE-BOX)</span>
                      <span
                        className={`text-[11px] font-mono font-semibold px-2 py-0.5 rounded border ${
                          diagnosis.suggested_layer === 'PARSING'
                            ? 'bg-[#fef2f2] text-[#b91c1c] border-[#fecaca]'
                            : diagnosis.suggested_layer === 'CHUNKING'
                            ? 'bg-[#fffbeb] text-[#b45309] border-[#fde68a]'
                            : diagnosis.suggested_layer === 'RETRIEVAL'
                            ? 'bg-[#eff6ff] text-[#1d4ed8] border-[#bfdbfe]'
                            : 'bg-[#f0fdf4] text-[#15803d] border-[#bbf7d0]'
                        }`}
                      >
                        {diagnosis.suggested_layer}
                      </span>
                      <span className="text-[11px] text-[#71717a] font-mono">
                        Khớp cao nhất: {diagnosis.best_match_score}% / {diagnosis.total_chunks_searched} chunks
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {diagnosis.suggested_layer !== 'OK' && (
                        <button
                          type="button"
                          onClick={() => {
                            const mapped =
                              diagnosis.suggested_layer === 'RETRIEVAL' ? 'VECTOR' : diagnosis.suggested_layer;
                            handleMetaUpdate({ root_cause_layer: mapped });
                            toast.success(`Đã gắn nhãn nguyên nhân gốc: ${mapped}`);
                          }}
                          className="text-xs px-2.5 py-1 rounded bg-white border border-[#d4d4d8] hover:bg-[#f4f4f2] text-[#18181b] font-medium"
                        >
                          Áp dụng nhãn {diagnosis.suggested_layer}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setDiagnosis(null)}
                        className="text-[#71717a] hover:text-[#18181b] p-1"
                        title="Đóng chẩn đoán"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-[#27272a] leading-relaxed">{diagnosis.diagnosis_summary}</p>

                  {diagnosis.config_hints?.length > 0 && (
                    <div className="bg-white border border-[#e6e6e3] rounded-[4px] p-3 space-y-1">
                      <div className="text-[11px] font-semibold text-[#52525b]">Gợi ý chỉnh cấu hình RAGFlow:</div>
                      <ul className="list-disc pl-4 space-y-0.5 text-xs text-[#3f3f46]">
                        {diagnosis.config_hints.map((h: string, i: number) => (
                          <li key={i}>{h}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {diagnosis.matching_chunks?.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-[11px] font-semibold text-[#52525b]">
                        Top {diagnosis.matching_chunks.length} chunk gần đáp án nhất trong toàn bộ kho:
                      </div>
                      {diagnosis.matching_chunks.map((mc: any) => (
                        <div key={mc.id} className="bg-white border border-[#e6e6e3] rounded-[4px] p-3 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono font-semibold text-[#18181b]">
                                {mc.doc_code} #{mc.chunk_index}
                              </span>
                              <span className="text-[#71717a]">p.{mc.page_num}</span>
                              <span className="font-mono text-[11px] text-[#52525b]">{mc.token_est} tok</span>
                              {mc.in_retrieved_rank ? (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#f0fdf4] text-[#15803d] border border-[#bbf7d0] font-mono">
                                  Lọt Top #{mc.in_retrieved_rank}
                                </span>
                              ) : (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#fef2f2] text-[#b91c1c] border border-[#fecaca]">
                                  Không lọt Top-K
                                </span>
                              )}
                              {mc.rule_flags?.map((f: string) => (
                                <span
                                  key={f}
                                  className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#fef3c7] text-[#92400e] border border-[#fde68a]"
                                >
                                  <AlertTriangle className="size-2.5" />
                                  {f}
                                </span>
                              ))}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[11px] font-semibold text-[#18181b]">
                                Khớp {mc.match_score}%
                              </span>
                              {mc.has_local_file && mc.filename.toLowerCase().endsWith('.pdf') && (
                                <button
                                  type="button"
                                  onClick={() => setOpenPdfChunkId(openPdfChunkId === mc.id ? null : mc.id)}
                                  className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-[#e4e4e2] bg-[#fafaf9] hover:bg-[#f4f4f2] text-[#3f3f46]"
                                >
                                  <FileImage className="size-3" />
                                  {openPdfChunkId === mc.id ? 'Ẩn PDF' : 'Xem trang PDF'}
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="text-xs text-[#27272a] whitespace-pre-wrap leading-relaxed bg-[#fafaf9] p-2.5 rounded border border-[#ededeb] max-h-40 overflow-y-auto">
                            {mc.content}
                          </div>
                          {openPdfChunkId === mc.id && (
                            <img
                              src={`/api/parsing/documents/${mc.document_id}/page/${mc.page_num}`}
                              alt={`Trang ${mc.page_num}`}
                              className="w-full border border-[#e4e4e2] rounded"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

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
              <div className="text-[11px] text-[#027a42] bg-[#f2fbf6] border border-[#03aa5c]/30 px-2.5 py-1.5 rounded">
                Mặc định dùng <strong>LLM-as-a-Judge</strong> chấm độ liên quan Top-10 chunk.
              </div>
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
