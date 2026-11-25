import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Check,
  Copy,
  FileImage,
  FileText,
  LayoutGrid,
  Loader2,
  Play,
  Plus,
  Search,
  Sparkles,
  Table2,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { ChunkContentView } from '../components/ChunkContentView';
import { GoldenTableView } from '../components/GoldenTableView';
import { RetrievalTableView } from '../components/RetrievalTableView';
import { GoldenTestcase, RetrievalResultGroup, RetrievalRun, RunItem } from '../types';

interface Props {
  activeRun: RunItem | null;
}

const AC_LABELS: Record<string, string> = {
  FULL: 'Trọn trong 1 chunk',
  SPLIT: 'Tách nhiều chunk',
  MISSING: 'Không có trong kho',
  UNCHECKED: 'Chưa kiểm tra',
};

const CLASS_BADGE: Record<string, string> = {
  Local: 'bg-[#f2fbf6] text-[#027a42] border-[#bbf7d0]',
  Global: 'bg-[#fffbeb] text-[#b45309] border-[#fde68a]',
  'Multi-hop': 'bg-[#f4f4f5] text-[#18181b] border-[#d4d4d8]',
};

const INTENT_LABELS: Record<string, string> = {
  Factoid: 'Tra sự kiện',
  Procedural: 'Quy trình',
  Table: 'Tra bảng',
  Keyword: 'Từ khóa',
  Comparison: 'So sánh',
  Reasoning: 'Suy luận',
};

interface EvidenceItem {
  label: string;
  source: string;
  text: string;
}

/**
 * Parses Reference Context into clean, self-explanatory evidence cards paired directly
 * with their corresponding source document (no duplicate/confusing tag soup).
 */
function buildEvidenceItems(raw: string, sourceFile?: string, notes?: string): EvidenceItem[] {
  const txt = (raw || '').trim();
  if (!txt) return [];

  const files = (sourceFile || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  // Extract clean location hint from notes (strip "LLM (model) · File gốc: DOCxx · " and internal keyword parens)
  const cleanLoc = (notes || '')
    .replace(/^LLM\s*\([^)]*\)\s*·\s*/i, '')
    .replace(/^File gốc:\s*/i, '')
    .replace(/DOC\d+\s*↔\s*DOC\d+\s*\([^)]*\)/i, '')
    .replace(/^DOC\d+\s*[·:]?\s*/i, '')
    .trim();

  // Keep HTML/Markdown tables intact in a single card
  if (/<table\b|<tr\b/i.test(txt) || /^\s*\|.*\|\s*$/m.test(txt)) {
    return [{ label: cleanLoc || 'Bảng trích dẫn', source: files[0] || '', text: txt }];
  }

  // 1) Explicit "Đoạn A: ... Đoạn B: ..." or "[Đoạn 1] ... [Đoạn 2] ..." markers
  const markerRe = /(?:^|\s)(?:\[?(Đoạn\s+[A-Z0-9]+|Nguồn\s+\d+)\]?\s*:?)\s*/gi;
  const matches = Array.from(txt.matchAll(markerRe));
  if (matches.length >= 2) {
    const items: EvidenceItem[] = [];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const start = (m.index ?? 0) + m[0].length;
      const end = i + 1 < matches.length ? (matches[i + 1].index ?? txt.length) : txt.length;
      const body = txt.slice(start, end).trim().replace(/^['"]|['"]\.?$/g, '').trim();
      if (!body) continue;
      items.push({
        label: m[1].trim(),
        source: files[i] || files[0] || '',
        text: body,
      });
    }
    if (items.length > 0) return items;
  }

  // 2) Multi-paragraph split (\n\n or " ... ")
  const byBlank = txt
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  const parts =
    byBlank.length > 1
      ? byBlank
      : txt
          .split(/\s*\.\.\.\s+|\s*…\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 25);

  const finalParts = parts.length > 0 ? parts : [txt];
  return finalParts.map((p, idx) => ({
    label: finalParts.length === 1 ? cleanLoc || 'Trích dẫn gốc' : `Đoạn ${idx + 1}`,
    source: files[idx] || files[0] || '',
    text: p,
  }));
}

export const RetrievalPage: React.FC<Props> = ({ activeRun }) => {
  const [subTab, setSubTab] = useState<'golden' | 'results'>('golden');
  const [goldenViewMode, setGoldenViewMode] = useState<'split' | 'excel'>('split');
  const [resultsViewMode, setResultsViewMode] = useState<'split' | 'excel'>('split');

  // Golden Dataset state (always loaded independently of retrieval runs)
  const [testcases, setTestcases] = useState<GoldenTestcase[]>([]);
  const [loadingTc, setLoadingTc] = useState(false);
  const [selectedTcId, setSelectedTcId] = useState<number | null>(null);
  const [tcSearch, setTcSearch] = useState('');
  const [classFilter, setClassFilter] = useState<'ALL' | 'Local' | 'Global' | 'Multi-hop'>('ALL');

  // Retrieval Runs & Results state
  const [rrList, setRrList] = useState<RetrievalRun[]>([]);
  const [selectedRrId, setSelectedRrId] = useState<number | null>(null);
  const [groups, setGroups] = useState<RetrievalResultGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<RetrievalResultGroup | null>(null);

  // Modals & Actions
  const [showAddTc, setShowAddTc] = useState(false);
  const [showRunModal, setShowRunModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genTotalCount, setGenTotalCount] = useState(50);
  const [stylePrompt, setStylePrompt] = useState('');
  const [useLlmJudge] = useState(true);

  const [tcCode, setTcCode] = useState('TC51');
  const [tcClass, setTcClass] = useState('Local');
  const [tcSource, setTcSource] = useState('');
  const [tcQ, setTcQ] = useState('');
  const [tcExpected, setTcExpected] = useState('');
  const [tcRef, setTcRef] = useState('');

  const [rrName, setRrName] = useState('Baseline Retrieval');
  const [topK, setTopK] = useState(10);
  const [threshold, setThreshold] = useState(0.2);
  const [vecWeight, setVecWeight] = useState(0.3);
  const [rerankId, setRerankId] = useState('');

  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<any>(null);
  const [openPdfChunkId, setOpenPdfChunkId] = useState<number | null>(null);

  const loadTestcases = async () => {
    setLoadingTc(true);
    try {
      const list = await api.listTestcases();
      setTestcases(list || []);
      if (list && list.length > 0) {
        setSelectedTcId((prev) => (prev && list.some((t: GoldenTestcase) => t.id === prev) ? prev : list[0].id));
        setTcCode(`TC${String(list.length + 1).padStart(2, '0')}`);
      } else {
        setSelectedTcId(null);
        setTcCode('TC01');
      }
    } finally {
      setLoadingTc(false);
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
    } else {
      setSelectedGroup(null);
    }
  };

  useEffect(() => {
    loadTestcases();
    loadRuns();
  }, [activeRun?.id]);

  useEffect(() => {
    if (selectedRrId) loadResults(selectedRrId);
  }, [selectedRrId]);

  useEffect(() => {
    setDiagnosis(null);
    setOpenPdfChunkId(null);
  }, [selectedGroup?.testcase.id, selectedRrId]);

  const classCounts = useMemo(() => {
    const acc = { ALL: testcases.length, Local: 0, Global: 0, 'Multi-hop': 0 };
    for (const tc of testcases) {
      if (tc.question_class === 'Local') acc.Local += 1;
      else if (tc.question_class === 'Global') acc.Global += 1;
      else if (tc.question_class === 'Multi-hop') acc['Multi-hop'] += 1;
    }
    return acc;
  }, [testcases]);

  const uniqueSourceCount = useMemo(() => {
    const set = new Set<string>();
    for (const tc of testcases) {
      for (const part of (tc.source_file || '').split(';')) {
        const s = part.trim();
        if (s) set.add(s);
      }
    }
    return set.size;
  }, [testcases]);

  const filteredTestcases = useMemo(() => {
    const q = tcSearch.trim().toLowerCase();
    return testcases.filter((tc) => {
      if (classFilter !== 'ALL' && tc.question_class !== classFilter) return false;
      if (!q) return true;
      return (
        tc.tc_code.toLowerCase().includes(q) ||
        tc.input_question.toLowerCase().includes(q) ||
        (tc.source_file || '').toLowerCase().includes(q) ||
        (tc.reference_context || '').toLowerCase().includes(q)
      );
    });
  }, [testcases, tcSearch, classFilter]);

  const selectedTc = useMemo(
    () => filteredTestcases.find((t) => t.id === selectedTcId) || filteredTestcases[0] || null,
    [filteredTestcases, selectedTcId]
  );

  if (!activeRun) {
    return <div className="p-8 text-sm text-[#71717a]">Hãy chọn hoặc tạo một phiên kiểm thử trước.</div>;
  }

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

  const handleAddTc = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const created = await api.createTestcase({
        tc_code: tcCode,
        input_question: tcQ,
        expected_outcome: tcExpected,
        reference_context: tcRef,
        source_file: tcSource,
        question_class: tcClass,
      });
      setTcQ('');
      setTcExpected('');
      setTcRef('');
      setShowAddTc(false);
      await loadTestcases();
      if (created?.id) setSelectedTcId(created.id);
      if (selectedRrId) await loadResults(selectedRrId);
      toast.success(`Đã lưu câu hỏi ${tcCode}.`);
    } catch (err: any) {
      toast.error(err.message || 'Không lưu được câu hỏi');
    }
  };

  const handleDeleteTc = async (tc: GoldenTestcase) => {
    if (!window.confirm(`Xóa câu hỏi ${tc.tc_code}?`)) return;
    try {
      await api.deleteTestcase(tc.id);
      await loadTestcases();
      if (selectedRrId) await loadResults(selectedRrId);
      toast.success(`Đã xóa ${tc.tc_code}.`);
    } catch (err: any) {
      toast.error(err.message || 'Không xóa được câu hỏi');
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm(`Xóa toàn bộ ${testcases.length} câu hỏi Golden Dataset hiện tại?`)) return;
    try {
      const res = await api.clearTestcases();
      toast.success(`Đã xóa ${res.deleted} câu hỏi Golden.`);
      setTestcases([]);
      setSelectedTcId(null);
      setGroups([]);
      setSelectedGroup(null);
      await loadRuns();
    } catch (e: any) {
      toast.error(e.message || 'Không xóa được Golden Dataset');
    }
  };

  const handleAutoGenerate = async () => {
    if (!activeRun || generating) return;
    if (rrList.length > 0) {
      const ok = window.confirm(
        `Phiên này đã có ${rrList.length} lần chạy Retrieval. Sinh lại Golden Dataset sẽ thay thế bộ câu hỏi cũ và xóa các kết quả Retrieval gắn với bộ cũ. Bạn có chắc muốn tiếp tục?`
      );
      if (!ok) return;
    }
    setGenerating(true);
    try {
      const res = await api.autoGenerateTestcases(activeRun.id, genTotalCount, true, stylePrompt.trim());
      const cc = res.class_counts || {};
      if (res.meta?.style_fallback && res.meta?.style_notice) {
        toast.warning(res.meta.style_notice, { duration: 4500 });
      }
      toast.success(
        `Đã sinh ${res.generated_count} câu từ file gốc (${res.elapsed_sec ?? '?'}s · Local: ${cc.Local || 0}, Global: ${cc.Global || 0}, Multi-hop: ${cc['Multi-hop'] || 0}).`
      );
      await loadTestcases();
      setSubTab('golden');
      if (selectedRrId) await loadResults(selectedRrId);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setGenerating(false);
    }
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
      setSubTab('results');
      toast.success(
        `Chạy xong ${res.testcases_executed} câu hỏi · Kế thừa ${res.smart_cache_hits} nhãn từ cache.`
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

  const avgPrecision =
    groups.length > 0 ? groups.reduce((s, g) => s + (g.contextual_precision || 0), 0) / groups.length : 0;
  const avgCoverage =
    groups.length > 0 ? groups.reduce((s, g) => s + (g.meta?.context_coverage || 0), 0) / groups.length : 0;
  const fullAcCount = groups.filter((g) => g.meta?.answer_containment === 'FULL').length;

  return (
    <div className="h-[calc(100dvh-48px)] flex flex-col bg-white">
      {/* Sub-navigation Tabs (matches Step 3 Chunking) */}
      <div className="px-5 border-b border-[#e8e8e6] bg-white flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSubTab('golden')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              subTab === 'golden'
                ? 'border-[#027a42] text-[#141414]'
                : 'border-transparent text-[#71717a] hover:text-[#141414]'
            }`}
          >
            <BookOpen className="size-3.5" />
            Bộ câu hỏi Golden
            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#f4f4f2] text-[#18181b] font-semibold">
              {testcases.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setSubTab('results')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              subTab === 'results'
                ? 'border-[#027a42] text-[#141414]'
                : 'border-transparent text-[#71717a] hover:text-[#141414]'
            }`}
          >
            <Search className="size-3.5" />
            Kết quả Retrieval
            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#f4f4f2] text-[#52525b]">
              {rrList.length} lần chạy
            </span>
          </button>
        </div>

        <div className="flex items-center gap-2 py-1.5">
          {subTab === 'results' && groups.length > 0 && (
            <div className="hidden md:flex items-center gap-1.5 text-[11px] text-[#52525b]">
              <span className="px-2 py-0.5 rounded bg-[#fafaf9] border border-[#e4e4e2]">
                Precision: <strong className="font-mono text-[#18181b]">{(avgPrecision * 100).toFixed(0)}%</strong>
              </span>
              <span className="px-2 py-0.5 rounded bg-[#fafaf9] border border-[#e4e4e2]">
                Coverage: <strong className="font-mono text-[#18181b]">{(avgCoverage * 100).toFixed(0)}%</strong>
              </span>
              <span className="px-2 py-0.5 rounded bg-[#f2fbf6] border border-[#bbf7d0] text-[#027a42]">
                Trọn 1 chunk:{' '}
                <strong className="font-mono">
                  {fullAcCount}/{groups.length}
                </strong>
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowRunModal(true)}
            disabled={busy || generating || testcases.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#141414] hover:bg-[#27272a] text-white disabled:opacity-40 transition-colors"
            title={testcases.length === 0 ? 'Hãy sinh hoặc thêm câu hỏi Golden trước' : 'Chạy benchmark tìm kiếm trên RAGFlow'}
          >
            <Play className="size-3.5" />
            Chạy test tìm kiếm
          </button>
        </div>
      </div>

      {/* ==================== TAB 1: GOLDEN DATASET ==================== */}
      {subTab === 'golden' ? (
        <>
          {/* Golden Toolbar */}
          <div className="px-5 py-2 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-2.5 shrink-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center h-7 bg-white border border-[#dcdcd8] focus-within:border-[#141414] rounded-md px-2.5 gap-2 w-[220px] transition-colors">
                <Search className="size-3.5 text-[#a1a1aa] shrink-0" />
                <input
                  type="text"
                  value={tcSearch}
                  onChange={(e) => setTcSearch(e.target.value)}
                  placeholder="Tìm câu hỏi, mã TC, file..."
                  className="w-full text-xs text-[#141414] placeholder:text-[#a1a1aa] bg-transparent focus:outline-none"
                />
                {tcSearch && (
                  <button
                    type="button"
                    onClick={() => setTcSearch('')}
                    className="text-[#a1a1aa] hover:text-[#141414]"
                    aria-label="Xóa tìm kiếm"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>

              <div className="h-4 w-px bg-[#e4e4e2] hidden sm:block" />

              <div className="inline-flex items-center h-7 p-0.5 rounded-md bg-[#ededeb] border border-[#e4e4e2] gap-0.5">
                {(['ALL', 'Local', 'Global', 'Multi-hop'] as const).map((cls) => (
                  <button
                    key={cls}
                    type="button"
                    onClick={() => setClassFilter(cls)}
                    className={`h-6 px-2.5 text-[11px] rounded-[4px] transition-colors font-medium inline-flex items-center gap-1 ${
                      classFilter === cls
                        ? 'bg-[#141414] text-white shadow-2xs'
                        : 'text-[#52525b] hover:text-[#141414] hover:bg-white/60'
                    }`}
                  >
                    <span>{cls === 'ALL' ? 'Tất cả' : cls}</span>
                    <span className={`font-mono text-[10px] ${classFilter === cls ? 'text-white/75' : 'text-[#8e8e93]'}`}>
                      {classCounts[cls]}
                    </span>
                  </button>
                ))}
              </div>

              {/* (!) Tag Explanation Hover Note */}
              <div className="relative group inline-flex items-center">
                <button
                  type="button"
                  aria-label="Giải thích các loại nhãn câu hỏi"
                  className="inline-flex items-center justify-center size-6 rounded-full border border-[#dcdcd8] bg-white text-[#71717a] hover:border-[#141414] hover:text-[#141414] transition-colors cursor-help"
                >
                  <AlertCircle className="size-3.5" />
                </button>
                <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute left-0 top-full mt-2 z-50 w-[370px] rounded-lg border border-[#e4e4e2] bg-white p-4 shadow-xl text-[11px] text-[#3f3f46] leading-relaxed">
                  <div className="font-semibold text-xs text-[#141414] pb-2 mb-2 border-b border-[#f0f0ee]">
                    Giải thích các nhãn phân loại câu hỏi
                  </div>
                  <div className="space-y-2.5">
                    <div>
                      <div className="font-semibold text-[#141414] mb-1">1. Phạm vi truy xuất (3 cấp độ khó):</div>
                      <ul className="space-y-1 pl-3 list-disc">
                        <li>
                          <strong className="text-[#027a42]">Local (Đơn đoạn):</strong> Đáp án nằm gọn trong 1 đoạn — kiểm tra tìm đúng điểm.
                        </li>
                        <li>
                          <strong className="text-[#b45309]">Global (Tổng hợp):</strong> Cần gom thông tin từ nhiều đoạn trong cùng tài liệu — kiểm tra độ phủ Top-K.
                        </li>
                        <li>
                          <strong className="text-[#141414]">Multi-hop (Suy luận nối tầng):</strong> Nối chuỗi A → B → C từ 2 đoạn/tài liệu khác nhau — kiểm tra tìm đủ cả 2 mảnh ghép.
                        </li>
                      </ul>
                    </div>
                    <div className="pt-2 border-t border-[#f0f0ee]">
                      <div className="font-semibold text-[#141414] mb-1">2. Dạng câu hỏi (dùng để soi lỗi Retrieval):</div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10.5px]">
                        <div><strong>Tra sự kiện:</strong> Hỏi số liệu/thông tin cụ thể</div>
                        <div><strong>Quy trình:</strong> Hỏi các bước xử lý</div>
                        <div><strong>Tra bảng:</strong> Đọc đúng hàng/cột bảng</div>
                        <div><strong>Từ khóa:</strong> Mã luật, tên thuốc (test BM25)</div>
                        <div><strong>So sánh:</strong> Đối chiếu 2 nhóm/phác đồ</div>
                        <div><strong>Suy luận:</strong> Kết hợp điều kiện để kết luận</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center h-7 border border-[#dcdcd8] bg-white rounded-md overflow-hidden">
                <input
                  type="number"
                  min={5}
                  max={100}
                  className="w-10 h-full pl-2 pr-0.5 text-xs font-mono font-medium text-right bg-white text-[#141414] focus:outline-none"
                  value={genTotalCount}
                  onChange={(e) => setGenTotalCount(Math.max(5, Math.min(100, Number(e.target.value) || 50)))}
                  disabled={generating || busy}
                  title="Tổng số câu hỏi Golden Dataset (mặc định 50)"
                />
                <span className="pr-2 text-[11px] text-[#71717a] select-none">câu</span>
                <button
                  type="button"
                  onClick={handleAutoGenerate}
                  disabled={generating || busy}
                  className="inline-flex items-center gap-1.5 h-full px-2.5 text-xs font-medium bg-[#f7f7f6] hover:bg-[#ededeb] text-[#141414] border-l border-[#dcdcd8] disabled:opacity-45 transition-colors"
                >
                  {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5 text-[#027a42]" />}
                  {generating ? 'Đang sinh...' : 'Sinh tự động'}
                </button>
              </div>

              {/* (!) Methodology Hover Note */}
              <div className="relative group inline-flex items-center">
                <button
                  type="button"
                  aria-label="Phương pháp sinh Golden Dataset"
                  className="inline-flex items-center justify-center size-6 rounded-full border border-[#dcdcd8] bg-white text-[#71717a] hover:border-[#141414] hover:text-[#141414] transition-colors cursor-help"
                >
                  <AlertCircle className="size-3.5" />
                </button>
                <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute right-0 top-full mt-2 z-50 w-[360px] rounded-lg border border-[#e4e4e2] bg-white p-4 shadow-xl text-[11px] text-[#3f3f46] leading-relaxed">
                  <div className="font-semibold text-xs text-[#141414] pb-2 mb-2 border-b border-[#f0f0ee]">
                    Cơ chế sinh Golden Dataset độc lập
                  </div>
                  <ul className="space-y-2 list-disc pl-3.5">
                    <li>
                      <strong className="text-[#141414]">Đọc trực tiếp từ file tài liệu gốc</strong> (PDF, PDF scan qua RapidOCR, DOCX, XLSX ghép đủ 2 tầng header, PPTX, HTML đã lọc nav/footer) — 100% độc lập với chunks RAGFlow để tránh tự chấm mình.
                    </li>
                    <li>
                      <strong className="text-[#141414]">Phân bổ Adaptive √n (Bankier, 1988):</strong> chia quota theo căn bậc hai độ dài từng file gốc, sàn tối thiểu 1 câu/file.
                    </li>
                    <li>
                      <strong className="text-[#141414]">Tỷ lệ 50 / 35 / 15:</strong> 50% Local · 35% Global · 15% Multi-hop (ghép cặp có chung từ khóa chuyên môn).
                    </li>
                    <li>
                      <strong className="text-[#141414]">Quality Gate:</strong> tự động lọc câu trùng (RapidFuzz ≥ 85%) và chặn câu hỏi rác hotline/menu.
                    </li>
                  </ul>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowAddTc(true)}
                className="inline-flex items-center gap-1 h-7 px-2.5 text-xs font-medium rounded-md bg-white border border-[#dcdcd8] hover:bg-[#f4f4f2] text-[#141414] transition-colors"
              >
                <Plus className="size-3.5" /> Thêm tay
              </button>

              <div className="inline-flex items-center h-7 p-0.5 rounded-md bg-[#ededeb] border border-[#e4e4e2]">
                <button
                  type="button"
                  onClick={() => setGoldenViewMode('split')}
                  className={`inline-flex items-center gap-1 h-6 px-2.5 text-[11px] rounded-[4px] transition-colors ${
                    goldenViewMode === 'split'
                      ? 'bg-white text-[#141414] font-semibold shadow-2xs'
                      : 'text-[#52525b] hover:text-[#141414]'
                  }`}
                  title="Xem dạng danh sách & thẻ chi tiết"
                >
                  <LayoutGrid className="size-3" />
                  Chi tiết
                </button>
                <button
                  type="button"
                  onClick={() => setGoldenViewMode('excel')}
                  className={`inline-flex items-center gap-1 h-6 px-2.5 text-[11px] rounded-[4px] transition-colors ${
                    goldenViewMode === 'excel'
                      ? 'bg-white text-[#141414] font-semibold shadow-2xs'
                      : 'text-[#52525b] hover:text-[#141414]'
                  }`}
                  title="Xem toàn bộ Golden Dataset dạng bảng Excel"
                >
                  <Table2 className="size-3" />
                  Bảng Excel
                </button>
              </div>
            </div>
          </div>

          {/* Compact Question Style Prompt Bar (with automatic off-topic guardrail) */}
          <div className="px-5 py-1.5 border-b border-[#e8e8e6] bg-white flex flex-wrap items-center gap-2 text-xs shrink-0">
            <span className="text-[11px] font-medium text-[#52525b] shrink-0">Phong cách hỏi:</span>
            <div className="inline-flex items-center gap-1 shrink-0">
              {[
                {
                  label: 'Phổ thông',
                  prompt: 'Hỏi ngắn gọn, đời thường như người dùng phổ thông nhắn chatbot, ít thuật ngữ chuyên sâu.',
                },
                {
                  label: 'Tra cứu nhanh',
                  prompt: 'Câu hỏi cực ngắn (6-14 từ), đi thẳng vào ý chính như người dùng vội vàng gõ tìm kiếm.',
                },
                {
                  label: 'Chuyên môn',
                  prompt: 'Hỏi theo góc nhìn chuyên gia trong lĩnh vực của tài liệu, dùng đúng thuật ngữ chuyên môn, quy định và chỉ số cụ thể.',
                },
              ].map((p) => {
                const active = stylePrompt.trim() === p.prompt;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setStylePrompt(active ? '' : p.prompt)}
                    disabled={generating}
                    className={`h-6 px-2 text-[11px] rounded border transition-colors ${
                      active
                        ? 'bg-[#f2fbf6] border-[#027a42] text-[#027a42] font-medium'
                        : 'bg-[#fafaf9] border-[#e4e4e2] text-[#52525b] hover:border-[#a1a1aa] hover:text-[#141414]'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="flex-1 min-w-[240px] inline-flex items-center h-6 bg-[#fafaf9] border border-[#e4e4e2] focus-within:border-[#141414] focus-within:bg-white rounded px-2 gap-1.5 transition-colors">
              <input
                type="text"
                value={stylePrompt}
                onChange={(e) => setStylePrompt(e.target.value)}
                disabled={generating}
                maxLength={280}
                placeholder="Tự nhập phong cách hỏi (VD: ngắn gọn như người bình thường nhắn chat)... Có guardrail tự fallback mặc định nếu lạc đề"
                className="w-full text-[11.5px] text-[#141414] placeholder:text-[#a1a1aa] bg-transparent focus:outline-none"
              />
              {stylePrompt && (
                <button
                  type="button"
                  onClick={() => setStylePrompt('')}
                  className="text-[#a1a1aa] hover:text-[#141414]"
                  title="Xóa về phong cách mặc định"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          </div>

          {/* Golden 2-Column Workspace */}
          {loadingTc ? (
            <div className="flex-1 flex items-center justify-center gap-2 text-xs text-[#71717a]">
              <Loader2 className="size-4 animate-spin" /> Đang tải bộ câu hỏi Golden...
            </div>
          ) : testcases.length === 0 ? (
            <div
              className="flex-1 flex items-center justify-center p-8"
              style={{
                backgroundColor: '#f8f7f4',
                backgroundImage: 'radial-gradient(#e4e2dc 0.8px, transparent 0.8px)',
                backgroundSize: '18px 18px',
              }}
            >
              <div className="max-w-md w-full bg-white border border-[#e6e4de] rounded-xl shadow-xs p-7 text-center space-y-4">
                <div className="size-11 rounded-full bg-[#f2fbf6] border border-[#bbf7d0] text-[#027a42] flex items-center justify-center mx-auto">
                  <BookOpen className="size-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-[#141414]">Chưa có bộ câu hỏi Golden Dataset</h3>
                  <p className="text-xs text-[#71717a] leading-relaxed">
                    Hệ thống sẽ đọc trực tiếp từ <strong>file tài liệu gốc</strong> (độc lập với RAGFlow) để sinh{' '}
                    <strong className="font-mono text-[#141414]">{genTotalCount} câu hỏi chuẩn</strong> theo tỷ lệ 50% Local · 35% Global · 15% Multi-hop.
                  </p>
                </div>
                <div className="flex items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleAutoGenerate}
                    disabled={generating}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-[#141414] hover:bg-[#27272a] text-white disabled:opacity-45"
                  >
                    {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
                    {generating ? 'Đang sinh từ file gốc...' : `Sinh ${genTotalCount} câu Golden`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAddTc(true)}
                    className="px-3 py-2 text-xs font-medium rounded-md bg-white border border-[#e4e4e2] hover:bg-[#f4f4f2] text-[#141414]"
                  >
                    + Thêm thủ công
                  </button>
                </div>
              </div>
            </div>
          ) : goldenViewMode === 'excel' ? (
            <GoldenTableView
              runId={activeRun.id}
              testcases={filteredTestcases}
              onSelectTestcase={(tc) => {
                setSelectedTcId(tc.id);
                setGoldenViewMode('split');
              }}
              onDeleteTestcase={handleDeleteTc}
            />
          ) : (
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0 overflow-hidden">
              {/* Left: Question List */}
              <div className="lg:col-span-5 border-r border-[#e8e8e6] flex flex-col min-h-0 bg-white">
                <div className="px-4 py-2 border-b border-[#ededeb] flex items-center justify-between text-[11px] bg-[#fafaf9] shrink-0">
                  <span className="font-mono text-[#52525b]">
                    Hiển thị <strong className="text-[#141414]">{filteredTestcases.length}</strong>/{testcases.length} câu ·{' '}
                    <strong className="text-[#027a42]">{uniqueSourceCount}</strong> file gốc
                  </span>
                  <button
                    type="button"
                    onClick={handleClearAll}
                    className="text-[#b91c1c] hover:underline font-medium"
                  >
                    Xóa hết
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto divide-y divide-[#f0f0ee]">
                  {filteredTestcases.map((tc) => {
                    const isSel = selectedTc?.id === tc.id;
                    return (
                      <button
                        key={tc.id}
                        type="button"
                        onClick={() => setSelectedTcId(tc.id)}
                        className={`w-full text-left px-4 py-3 transition-colors ${
                          isSel
                            ? 'bg-[#f8f7f4] border-l-2 border-l-[#027a42]'
                            : 'hover:bg-[#fafaf9]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-mono text-xs font-bold text-[#141414]">{tc.tc_code}</span>
                            <span
                              className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${
                                CLASS_BADGE[tc.question_class] || CLASS_BADGE.Local
                              }`}
                            >
                              {tc.question_class}
                            </span>
                            {tc.intent_type && (
                              <span className="text-[10px] text-[#52525b] bg-[#f4f4f2] px-1.5 py-0.5 rounded">
                                {INTENT_LABELS[tc.intent_type] || tc.intent_type}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-[13px] text-[#18181b] leading-snug line-clamp-2 font-medium">
                          {tc.input_question}
                        </div>
                        <div className="text-[11px] text-[#78716c] truncate mt-1 flex items-center gap-1">
                          <FileText className="size-3 shrink-0 text-[#a1a1aa]" />
                          <span className="truncate">{tc.source_file || '—'}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Right: Selected Golden Testcase Detail (Editorial dot-grid canvas) */}
              <div
                className="lg:col-span-7 overflow-y-auto p-6 space-y-4"
                style={{
                  backgroundColor: '#f8f7f4',
                  backgroundImage: 'radial-gradient(#e4e2dc 0.8px, transparent 0.8px)',
                  backgroundSize: '18px 18px',
                }}
              >
                {selectedTc ? (
                  <div className="bg-white border border-[#e6e4de] rounded-xl shadow-xs p-6 space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#efede8]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-[#141414] text-white">
                          {selectedTc.tc_code}
                        </span>
                        <span
                          className={`text-[11px] font-medium px-2 py-0.5 rounded border ${
                            CLASS_BADGE[selectedTc.question_class] || CLASS_BADGE.Local
                          }`}
                        >
                          {selectedTc.question_class}
                        </span>
                        {selectedTc.intent_type && (
                          <span className="text-[11px] px-2 py-0.5 rounded bg-[#f4f4f2] text-[#52525b]">
                            {INTENT_LABELS[selectedTc.intent_type] || selectedTc.intent_type}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteTc(selectedTc)}
                        className="inline-flex items-center gap-1 text-[11px] text-[#71717a] hover:text-[#b91c1c] px-2 py-1 rounded hover:bg-[#fef2f2] transition-colors"
                        title="Xóa câu hỏi này"
                      >
                        <Trash2 className="size-3.5" />
                        Xóa câu này
                      </button>
                    </div>

                    {/* Input Question */}
                    <div className="space-y-1.5">
                      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[#78716c]">
                        Câu hỏi kiểm thử (Input Question)
                      </div>
                      <h2 className="text-[16px] font-semibold text-[#141414] leading-snug text-pretty">
                        {selectedTc.input_question}
                      </h2>
                      <div className="text-xs text-[#71717a] flex flex-wrap items-center gap-1.5 pt-0.5">
                        <FileText className="size-3.5 text-[#a1a1aa]" />
                        <span>Nguồn:</span>
                        <span className="font-mono text-[11px] text-[#18181b] bg-[#fafaf9] border border-[#e6e4de] px-1.5 py-0.5 rounded">
                          {selectedTc.source_file || '—'}
                        </span>
                      </div>
                    </div>

                    {/* Expected Outcome */}
                    {selectedTc.expected_outcome && (
                      <div className="rounded-lg bg-[#f2fbf6] border border-[#cdebd9] p-4 space-y-1">
                        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[#027a42]">
                          Đáp án kỳ vọng (Expected Outcome)
                        </div>
                        <div className="text-[13.5px] text-[#141414] leading-relaxed whitespace-pre-wrap">
                          {selectedTc.expected_outcome}
                        </div>
                      </div>
                    )}

                    {/* Reference Context — Clean Scrollable Evidence Section */}
                    {(() => {
                      const rawRef = (selectedTc.reference_context || '').trim();
                      const items = buildEvidenceItems(rawRef, selectedTc.source_file, selectedTc.notes);
                      return (
                        <div className="rounded-lg border border-[#e4e4e0] bg-[#fafaf9] overflow-hidden">
                          <div className="px-4 py-2.5 bg-[#f4f4f2] border-b border-[#e4e4e0] flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[#141414]">
                                Căn cứ trích từ file gốc
                              </span>
                              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white border border-[#dcdcd8] text-[#52525b]">
                                {items.length} đoạn · {rawRef.length} ký tự
                              </span>
                            </div>
                            {rawRef && (
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard?.writeText(rawRef).then(() => {
                                    toast.success(`Đã copy toàn bộ căn cứ ${selectedTc.tc_code}`, { duration: 1500 });
                                  });
                                }}
                                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-white border border-[#dcdcd8] hover:border-[#141414] text-[#3f3f46] hover:text-[#141414] transition-colors"
                              >
                                <Copy className="size-3" /> Copy căn cứ
                              </button>
                            )}
                          </div>

                          {/* Scrollable Evidence Cards — each paired directly with its own source file */}
                          <div className="max-h-[340px] overflow-y-auto p-3.5 space-y-2.5">
                            {items.length === 0 ? (
                              <div className="text-xs text-[#71717a] italic py-4 text-center">
                                Chưa có đoạn căn cứ trích dẫn.
                              </div>
                            ) : (
                              items.map((ev, idx) => (
                                <div
                                  key={idx}
                                  className="rounded-md bg-white border border-[#e6e4de] overflow-hidden"
                                >
                                  <div className="px-3 py-1.5 bg-[#fcfcfb] border-b border-[#efede8] flex items-center justify-between gap-2 text-[11px]">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span className="font-mono text-[10.5px] font-semibold text-[#027a42] bg-[#f2fbf6] border border-[#bbf7d0] px-1.5 py-0.5 rounded shrink-0">
                                        {ev.label}
                                      </span>
                                      {ev.source && (
                                        <span
                                          className="inline-flex items-center gap-1 font-mono text-[10.5px] text-[#52525b] truncate"
                                          title={ev.source}
                                        >
                                          <FileText className="size-3 shrink-0 text-[#a1a1aa]" />
                                          <span className="truncate">{ev.source}</span>
                                        </span>
                                      )}
                                    </div>
                                    <span className="font-mono text-[10px] text-[#a1a1aa] shrink-0">
                                      {ev.text.length} ký tự
                                    </span>
                                  </div>
                                  <div className="p-3">
                                    {/<table\b|<tr\b/i.test(ev.text) || /^\s*\|.*\|\s*$/m.test(ev.text) ? (
                                      <ChunkContentView content={ev.text} />
                                    ) : (
                                      <div className="text-[13px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty">
                                        {ev.text}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-xs text-[#71717a]">
                    Không có câu hỏi nào khớp bộ lọc.
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        /* ==================== TAB 2: RETRIEVAL RESULTS ==================== */
        <>
          <div className="px-5 py-2.5 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-3 shrink-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[#71717a]">Lần chạy:</span>
              <select
                className="ts-input py-1 px-2.5 text-xs rounded-md bg-white min-w-[240px]"
                value={selectedRrId ?? ''}
                onChange={(e) => setSelectedRrId(Number(e.target.value))}
              >
                {rrList.map((rr) => (
                  <option key={rr.id} value={rr.id}>
                    {rr.name} (Top-{rr.top_k} · th={rr.similarity_threshold} · vec={rr.vector_similarity_weight})
                  </option>
                ))}
                {rrList.length === 0 && <option value="">Chưa có lần chạy tìm kiếm nào</option>}
              </select>
            </div>
            <div className="flex items-center gap-2 text-xs text-[#52525b]">
              <span className="px-2.5 py-1 rounded-md bg-white border border-[#e4e4e2]">
                Precision:{' '}
                <strong className="font-mono tabular-nums text-[#141414]">{(avgPrecision * 100).toFixed(1)}%</strong>
              </span>
              <span className="px-2.5 py-1 rounded-md bg-white border border-[#e4e4e2]">
                Coverage:{' '}
                <strong className="font-mono tabular-nums text-[#141414]">{(avgCoverage * 100).toFixed(1)}%</strong>
              </span>
              {rrList.length > 0 && (
                <div className="inline-flex items-center h-7 p-0.5 rounded-md bg-[#ededeb] border border-[#e4e4e2]">
                  <button
                    type="button"
                    onClick={() => setResultsViewMode('split')}
                    className={`inline-flex items-center gap-1 h-6 px-2.5 text-[11px] rounded-[4px] transition-colors ${
                      resultsViewMode === 'split'
                        ? 'bg-white text-[#141414] font-semibold shadow-2xs'
                        : 'text-[#52525b] hover:text-[#141414]'
                    }`}
                    title="Xem chi tiết câu hỏi & Top-K đoạn trả về"
                  >
                    <LayoutGrid className="size-3" />
                    Chi tiết
                  </button>
                  <button
                    type="button"
                    onClick={() => setResultsViewMode('excel')}
                    className={`inline-flex items-center gap-1 h-6 px-2.5 text-[11px] rounded-[4px] transition-colors ${
                      resultsViewMode === 'excel'
                        ? 'bg-white text-[#141414] font-semibold shadow-2xs'
                        : 'text-[#52525b] hover:text-[#141414]'
                    }`}
                    title="Xem bảng tổng hợp & Top-K hits dạng Excel"
                  >
                    <Table2 className="size-3" />
                    Bảng Excel
                  </button>
                </div>
              )}
            </div>
          </div>

          {rrList.length === 0 ? (
            <div
              className="flex-1 flex items-center justify-center p-8"
              style={{
                backgroundColor: '#f8f7f4',
                backgroundImage: 'radial-gradient(#e4e2dc 0.8px, transparent 0.8px)',
                backgroundSize: '18px 18px',
              }}
            >
              <div className="max-w-md w-full bg-white border border-[#e6e4de] rounded-xl shadow-xs p-7 text-center space-y-4">
                <div className="size-11 rounded-full bg-[#f4f4f2] border border-[#e4e4e2] text-[#141414] flex items-center justify-center mx-auto">
                  <Play className="size-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-[#141414]">Chưa chạy Retrieval Benchmark nào</h3>
                  <p className="text-xs text-[#71717a] leading-relaxed">
                    Hiện đã sẵn sàng <strong className="font-mono text-[#027a42]">{testcases.length} câu hỏi Golden</strong> từ{' '}
                    <strong>{uniqueSourceCount} file gốc</strong>. Bấm nút bên dưới để bắn truy vấn lên RAGFlow và chấm tự động bằng LLM-as-a-Judge.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowRunModal(true)}
                  disabled={busy || testcases.length === 0}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-[#141414] hover:bg-[#27272a] text-white disabled:opacity-45"
                >
                  <Play className="size-3.5" /> Chạy test tìm kiếm đầu tiên
                </button>
              </div>
            </div>
          ) : resultsViewMode === 'excel' ? (
            <RetrievalTableView
              runId={activeRun.id}
              groups={groups}
              onSelectGroup={(g) => {
                setSelectedGroup(g);
                setResultsViewMode('split');
              }}
            />
          ) : (
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0 overflow-hidden">
              {/* Left: Testcases with Retrieval Scores */}
              <div className="lg:col-span-4 border-r border-[#e8e8e6] overflow-y-auto bg-[#fafaf9]">
                <div className="px-4 py-2 border-b border-[#ededeb] text-[11px] font-mono text-[#52525b] sticky top-0 bg-[#fafaf9] z-10">
                  KẾT QUẢ THEO CÂU HỎI ({groups.length})
                </div>
                {groups.map((g) => (
                  <button
                    key={g.testcase.id}
                    type="button"
                    onClick={() => setSelectedGroup(g)}
                    className={`w-full text-left px-4 py-3 border-b border-[#ededeb] transition-colors ${
                      selectedGroup?.testcase.id === g.testcase.id
                        ? 'bg-white border-l-2 border-l-[#027a42]'
                        : 'hover:bg-white/70'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`size-2 rounded-full shrink-0 ${
                            g.relevant_count > 0
                              ? 'bg-[#03aa5c]'
                              : g.hits.length > 0
                              ? 'bg-[#d6656c]'
                              : 'bg-[#d4d4d8]'
                          }`}
                        />
                        <span className="font-mono text-xs font-semibold text-[#141414]">{g.testcase.tc_code}</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded border ${
                            CLASS_BADGE[g.testcase.question_class] || CLASS_BADGE.Local
                          }`}
                        >
                          {g.testcase.question_class}
                        </span>
                      </div>
                      <span
                        className={`font-mono text-xs font-semibold tabular-nums ${
                          g.contextual_precision >= 0.5 ? 'text-[#027a42]' : 'text-[#b91c1c]'
                        }`}
                      >
                        {(g.contextual_precision * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="text-[13px] text-[#27272a] line-clamp-2 mt-1.5">{g.testcase.input_question}</div>
                    <div className="text-[11px] text-[#78716c] mt-1">
                      Đúng {g.relevant_count}/{g.hits.length} đoạn trả về · {AC_LABELS[g.meta.answer_containment] || g.meta.answer_containment}
                    </div>
                  </button>
                ))}
              </div>

              {/* Right: Question & Top-K Hits */}
              <div className="lg:col-span-8 overflow-y-auto p-6 space-y-5 bg-white">
                {selectedGroup ? (
                  <>
                    <div className="border border-[#e6e6e3] rounded-lg p-5 space-y-3.5 bg-[#fafaf9]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-[#141414] text-white">
                            {selectedGroup.testcase.tc_code}
                          </span>
                          <span className="text-xs text-[#71717a]">
                            Nguồn: {selectedGroup.testcase.source_file || '—'} ·{' '}
                            {AC_LABELS[selectedGroup.meta.answer_containment] || selectedGroup.meta.answer_containment}
                          </span>
                        </div>
                        <span className="font-mono text-xs font-semibold text-[#027a42]">
                          Precision: {(selectedGroup.contextual_precision * 100).toFixed(0)}%
                        </span>
                      </div>

                      <h2 className="text-base font-semibold text-[#141414] text-balance">
                        {selectedGroup.testcase.input_question}
                      </h2>

                      <div className="bg-white border border-[#e6e6e3] rounded-md p-3.5 space-y-1">
                        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[#78716c]">
                          Đoạn căn cứ chuẩn trong tài liệu gốc
                        </div>
                        <div className="text-[13px] text-[#27272a] leading-relaxed text-pretty whitespace-pre-wrap">
                          {selectedGroup.testcase.reference_context}
                        </div>
                      </div>

                      <div className="pt-2 border-t border-[#e8e8e6] flex flex-wrap items-center gap-4 text-xs">
                        <label className="flex items-center gap-2 text-[#3f3f46]">
                          <span>Độ phủ (0–1):</span>
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
                          <span>Nguyên nhân gốc:</span>
                          <select
                            className="ts-input py-1 text-xs"
                            value={selectedGroup.meta.root_cause_layer || 'NONE'}
                            onChange={(e) => handleMetaUpdate({ root_cause_layer: e.target.value })}
                          >
                            <option value="NONE">Không lỗi (Pass)</option>
                            <option value="KEYWORD">R1 · Miss nhánh keyword</option>
                            <option value="VECTOR">R2 · Miss nhánh vector</option>
                            <option value="RERANK">R3 · Lỗi rerank</option>
                            <option value="THRESHOLD">R4 · Lỗi ngưỡng / top-k</option>
                            <option value="SIMILAR_DOC">R5 · Nhiễu tài liệu tương tự</option>
                            <option value="PARSING">Tầng 1 · Lỗi Parsing</option>
                            <option value="CHUNKING">Tầng 2 · Lỗi Chunking</option>
                          </select>
                        </label>

                        <button
                          type="button"
                          onClick={handleDiagnose}
                          disabled={diagnosing}
                          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#141414] text-white hover:bg-[#27272a] disabled:opacity-50 transition-colors"
                        >
                          {diagnosing ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                          {diagnosing ? 'Đang soi kho chunk...' : 'Soi nguyên nhân gốc'}
                        </button>
                      </div>
                    </div>

                    {diagnosis && (
                      <div className="border border-[#d4d4d8] bg-[#fafaf9] rounded-lg p-4 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="ts-eyebrow">CHẨN ĐOÁN NGUYÊN NHÂN GỐC (WHITE-BOX)</span>
                            <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded border bg-white text-[#141414] border-[#d4d4d8]">
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
                                className="text-xs px-2.5 py-1 rounded bg-white border border-[#d4d4d8] hover:bg-[#f4f4f2] text-[#141414] font-medium"
                              >
                                Áp dụng nhãn {diagnosis.suggested_layer}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setDiagnosis(null)}
                              className="text-[#71717a] hover:text-[#141414] p-1"
                              title="Đóng chẩn đoán"
                            >
                              <X className="size-3.5" />
                            </button>
                          </div>
                        </div>

                        <p className="text-xs text-[#27272a] leading-relaxed">{diagnosis.diagnosis_summary}</p>

                        {diagnosis.config_hints?.length > 0 && (
                          <div className="bg-white border border-[#e6e6e3] rounded p-3 space-y-1">
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
                              <div key={mc.id} className="bg-white border border-[#e6e6e3] rounded p-3 space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-mono font-semibold text-[#141414]">
                                      {mc.doc_code} #{mc.chunk_index}
                                    </span>
                                    <span className="text-[#71717a]">p.{mc.page_num}</span>
                                    <span className="font-mono text-[11px] text-[#52525b]">{mc.token_est} tok</span>
                                    {mc.in_retrieved_rank ? (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#f2fbf6] text-[#027a42] border border-[#bbf7d0] font-mono">
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
                                    <span className="font-mono text-[11px] font-semibold text-[#141414]">
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
                          className={`border rounded-lg p-4 space-y-3 transition-colors ${
                            hit.relevant === 1
                              ? 'border-[#bbf7d0] bg-[#f2fbf6]/60'
                              : hit.relevant === 0
                              ? 'border-[#ededeb] bg-[#fafaf9] opacity-85'
                              : 'border-[#e6e6e3] bg-white'
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-[#141414] text-white">
                                #{hit.rank}
                              </span>
                              <span className="font-medium text-[#141414]">{hit.doc_name || 'Tài liệu'}</span>
                              {hit.relevancy_source === 'CACHED' && (
                                <span className="inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded bg-[#f4f4f2] text-[#52525b]">
                                  <Sparkles className="size-3 text-[#027a42]" /> Kế thừa cache
                                </span>
                              )}
                            </div>
                            <span className="font-mono text-[#71717a] tabular-nums">
                              Khớp: <strong className="text-[#141414]">{(hit.similarity * 100).toFixed(0)}%</strong>
                            </span>
                          </div>

                          <ChunkContentView content={hit.content} />

                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] text-[#71717a] truncate">{hit.reason || ''}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={() => handleScoreHit(hit.id, 1, 'Chứa thông tin trả lời')}
                                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium border ${
                                  hit.relevant === 1
                                    ? 'bg-[#027a42] text-white border-[#027a42]'
                                    : 'bg-white text-[#3f3f46] border-[#e4e4e2] hover:border-[#027a42]'
                                }`}
                              >
                                <Check className="size-3.5" /> Đúng
                              </button>
                              <button
                                type="button"
                                onClick={() => handleScoreHit(hit.id, 0, 'Không liên quan')}
                                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium border ${
                                  hit.relevant === 0
                                    ? 'bg-[#b91c1c] text-white border-[#b91c1c]'
                                    : 'bg-white text-[#3f3f46] border-[#e4e4e2] hover:border-[#b91c1c]'
                                }`}
                              >
                                <X className="size-3.5" /> Không liên quan
                              </button>
                            </div>
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
          )}
        </>
      )}

      {/* Modal: Run Retrieval */}
      {showRunModal && (
        <div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4">
          <form onSubmit={handleExecuteBenchmark} className="bg-white border border-[#e4e4e2] rounded-lg w-full max-w-md p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#141414]">Chạy kiểm thử tìm kiếm mới</h2>
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
                Sẽ chạy <strong>{testcases.length} câu hỏi Golden</strong> và dùng <strong>LLM-as-a-Judge</strong> chấm độ liên quan Top-{topK}.
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
          <form onSubmit={handleAddTc} className="bg-white border border-[#e4e4e2] rounded-lg w-full max-w-lg p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#141414]">Thêm câu hỏi Golden thủ công</h2>
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
                <input className="ts-input w-full font-mono" placeholder="DOC01..." value={tcSource} onChange={(e) => setTcSource(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="block text-xs text-[#52525b] mb-1">Câu hỏi người dùng</label>
              <input className="ts-input w-full" value={tcQ} onChange={(e) => setTcQ(e.target.value)} required />
            </div>
            <div>
              <label className="block text-xs text-[#52525b] mb-1">Đáp án kỳ vọng (tuỳ chọn)</label>
              <input className="ts-input w-full" value={tcExpected} onChange={(e) => setTcExpected(e.target.value)} />
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
