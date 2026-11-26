import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  FileImage,
  FileSpreadsheet,
  FileText,
  GitCompare,
  LayoutGrid,
  Loader2,
  Play,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { ChunkContentView } from '../components/ChunkContentView';
import { GoldenTableView } from '../components/GoldenTableView';
import { ImportGoldenModal } from '../components/ImportGoldenModal';
import { RetrievalCompareView } from '../components/RetrievalCompareView';
import { AutoTuneTrial, RetrievalAutoTuneView } from '../components/RetrievalAutoTuneView';
import { RetrievalTableView } from '../components/RetrievalTableView';
import { FloatingProgressOverlay, useProgressTask } from '../components/FloatingProgressOverlay';
import { GoldenTestcase, RetrievalResultGroup, RetrievalRun, RunItem } from '../types';

interface Props {
  activeRun: RunItem | null;
  isActive?: boolean;
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

export const RetrievalPage: React.FC<Props> = ({ activeRun, isActive = true }) => {
  const [subTab, setSubTab] = useState<'golden' | 'results' | 'compare' | 'autotune'>('golden');
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
  const [resFilter, setResFilter] = useState<'ALL' | 'FAIL' | 'PASS'>('ALL');
  const [resSearch, setResSearch] = useState('');
  const [showRejudgeMenu, setShowRejudgeMenu] = useState(false);
  const [refCollapsed, setRefCollapsed] = useState(false);
  const [onlyRelHits, setOnlyRelHits] = useState(false);
  const [inspectHitId, setInspectHitId] = useState<number | null>(null);

  // Modals & Actions
  const [showAddTc, setShowAddTc] = useState(false);
  const [showImportExcel, setShowImportExcel] = useState(false);
  const [showRunModal, setShowRunModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejudging, setRejudging] = useState<'' | 'jev' | 'llm'>('');
  const [generating, setGenerating] = useState(false);
  const [genTotalCount, setGenTotalCount] = useState(50);
  const [stylePrompt, setStylePrompt] = useState('');
  const [judgeEngine, setJudgeEngine] = useState<'jev' | 'llm' | 'rule'>('llm');
  const [bypassCache, setBypassCache] = useState(false);

  const [tcCode, setTcCode] = useState('TC51');
  const [tcClass, setTcClass] = useState('Local');
  const [tcSource, setTcSource] = useState('');
  const [tcQ, setTcQ] = useState('');
  const [tcExpected, setTcExpected] = useState('');
  const [tcRef, setTcRef] = useState('');

  const [rrName, setRrName] = useState('Baseline Retrieval');
  const [topK, setTopK] = useState(10);
  const [rerankCandidates, setRerankCandidates] = useState(64);
  const [threshold, setThreshold] = useState(0.2);
  const [vecWeight, setVecWeight] = useState(0.3);
  const [useRerank, setUseRerank] = useState(false);
  const [rerankModels, setRerankModels] = useState<{ id: string; name: string; label: string }[]>([]);
  const [selectedRerankId, setSelectedRerankId] = useState('');
  const [loadingReranks, setLoadingReranks] = useState(false);

  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<any>(null);
  const [openPdfChunkId, setOpenPdfChunkId] = useState<number | null>(null);
  const { progress: taskProgress, runTracked } = useProgressTask();

  const tcSeqRef = useRef(0);
  const runsSeqRef = useRef(0);
  const resultsSeqRef = useRef(0);
  const coverageTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (coverageTimerRef.current !== null) window.clearTimeout(coverageTimerRef.current);
    };
  }, []);

  const loadTestcases = async () => {
    const seq = ++tcSeqRef.current;
    const runId = activeRun?.id;
    setLoadingTc(true);
    try {
      const list = await api.listTestcases(runId);
      if (seq !== tcSeqRef.current) return;
      setTestcases(list || []);
      if (list && list.length > 0) {
        setSelectedTcId((prev) => (prev && list.some((t: GoldenTestcase) => t.id === prev) ? prev : list[0].id));
        setTcCode(`TC${String(list.length + 1).padStart(2, '0')}`);
      } else {
        setSelectedTcId(null);
        setTcCode('TC01');
      }
    } catch (e: any) {
      if (seq === tcSeqRef.current) toast.error(e?.message || 'Không tải được bộ câu hỏi Golden.');
    } finally {
      if (seq === tcSeqRef.current) setLoadingTc(false);
    }
  };

  const loadRuns = async (resetSelection = false) => {
    if (!activeRun) return;
    const seq = ++runsSeqRef.current;
    const runId = activeRun.id;
    try {
      const list = await api.listRetrievalRuns(runId);
      if (seq !== runsSeqRef.current) return;
      setRrList(list);
      if (list.length > 0) {
        setSelectedRrId((prev) =>
          !resetSelection && prev && list.some((x: any) => x.id === prev) ? prev : list[0].id
        );
      } else {
        setSelectedRrId(null);
        setGroups([]);
        setSelectedGroup(null);
      }
    } catch (e: any) {
      if (seq === runsSeqRef.current) toast.error(e?.message || 'Không tải được danh sách lần chạy Retrieval.');
    }
  };

  const loadResults = async (rrId: number) => {
    const seq = ++resultsSeqRef.current;
    try {
      const data = await api.getRetrievalResults(rrId);
      if (seq !== resultsSeqRef.current) return;
      setGroups(data);
      if (data.length > 0) {
        setSelectedGroup((prev) => {
          const keep = prev ? data.find((g: RetrievalResultGroup) => g.testcase.id === prev.testcase.id) : null;
          return keep || data[0];
        });
      } else {
        setSelectedGroup(null);
      }
    } catch (e: any) {
      if (seq === resultsSeqRef.current) toast.error(e?.message || 'Không tải được kết quả Retrieval.');
    }
  };

  useEffect(() => {
    // Clear previous run's state immediately so stale data from Run A never flashes inside Run B
    setTestcases([]);
    setSelectedTcId(null);
    setRrList([]);
    setSelectedRrId(null);
    setGroups([]);
    setSelectedGroup(null);
    setDiagnosis(null);
    setInspectHitId(null);
    loadTestcases();
    loadRuns(true);
    const rc = (activeRun?.retrieval_config || {}) as Record<string, any>;
    if (rc.top_k !== undefined) setTopK(Number(rc.top_k) || 10);
    if (rc.similarity_threshold !== undefined) setThreshold(Number(rc.similarity_threshold));
    if (rc.vector_similarity_weight !== undefined) setVecWeight(Number(rc.vector_similarity_weight));
    if (rc.rerank_id !== undefined) {
      const rid = String(rc.rerank_id || '');
      setUseRerank(Boolean(rid));
      if (rid) setSelectedRerankId(rid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, activeRun?.retrieval_config]);

  const syncRetrievalSettings = () => {
    api
      .getSettings()
      .then((res) => {
        const pref = res?.settings?.retrieval_judge_provider;
        if (pref === 'jev' || pref === 'llm' || pref === 'rule') {
          setJudgeEngine(pref);
        }
      })
      .catch(() => {});
    setLoadingReranks(true);
    api
      .listRagflowRerankModels()
      .then((list) => {
        const models = Array.isArray(list) ? list : [];
        setRerankModels(models);
        if (models.length > 0) {
          setSelectedRerankId((prev) => (prev && models.some((m) => m.id === prev) ? prev : models[0].id));
        } else {
          setSelectedRerankId('');
          setUseRerank(false);
        }
      })
      .catch(() => setRerankModels([]))
      .finally(() => setLoadingReranks(false));
  };

  useEffect(() => {
    syncRetrievalSettings();
  }, []);

  useEffect(() => {
    if (selectedRrId) loadResults(selectedRrId);
  }, [selectedRrId]);

  useEffect(() => {
    setDiagnosis(null);
    setOpenPdfChunkId(null);
    setInspectHitId(null);
  }, [selectedGroup?.testcase.id, selectedRrId]);

  useEffect(() => {
    if (!isActive || !inspectHitId || !selectedGroup) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        setInspectHitId(null);
        return;
      }
      const hits = selectedGroup.hits;
      const idx = hits.findIndex((h) => h.id === inspectHitId);
      if (idx === -1) return;
      if (e.key === 'ArrowLeft' && idx > 0) {
        e.preventDefault();
        setInspectHitId(hits[idx - 1].id);
      } else if (e.key === 'ArrowRight' && idx < hits.length - 1) {
        e.preventDefault();
        setInspectHitId(hits[idx + 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive, inspectHitId, selectedGroup]);

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
        run_id: activeRun?.id || 0,
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
      const res = await api.clearTestcases(activeRun?.id);
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
      const res = await runTracked(
        {
          title: 'Đang sinh bộ câu hỏi Golden từ file gốc',
          subtitle: `Mục tiêu ${genTotalCount} câu hỏi (Local · Global · Multi-hop)`,
          estimatedMs: 22000,
        },
        () => api.autoGenerateTestcases(activeRun.id, genTotalCount, true, stylePrompt.trim())
      );
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
    setShowRunModal(false);
    try {
      const res = await runTracked(
        {
          title: `Đang chạy Retrieval Benchmark (${judgeEngine.toUpperCase()})`,
          subtitle: `${rrName || 'Phiên đo mới'} · Top-${topK}`,
          estimatedMs: 25000,
        },
        () =>
          api.executeRetrieval({
            run_id: activeRun.id,
            name: rrName,
            top_k: topK,
            rerank_candidates: rerankCandidates,
            similarity_threshold: threshold,
            vector_similarity_weight: vecWeight,
            rerank_id: useRerank ? selectedRerankId : '',
            keyword_enabled: true,
            use_llm: judgeEngine !== 'rule',
            judge_engine: judgeEngine,
            bypass_cache: bypassCache,
          })
      );
      await loadRuns();
      setSelectedRrId(res.retrieval_run_id);
      setSubTab('results');
      const msTxt = res.judge_duration_ms ? ` · ${res.judge_duration_ms}ms` : '';
      const errCnt = Number(res.judge_error_count || 0);
      const errTxt = errCnt ? ` (${errCnt} lượt fallback)` : '';
      const msg = `Chạy xong ${res.testcases_executed} câu (${String(res.judge_engine || judgeEngine).toUpperCase()})${msTxt}${errTxt} · Cache: ${res.smart_cache_hits}.`;
      if (errCnt > 0) toast.warning(msg);
      else toast.success(msg);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleRejudge = async (engine: 'jev' | 'llm') => {
    if (!selectedRrId || rejudging) return;
    setRejudging(engine);
    try {
      const res = await runTracked(
        {
          title: `Đang chấm lại Retrieval bằng ${engine.toUpperCase()}`,
          subtitle: 'Đánh giá lại độ liên quan Top-K hits trên cùng tập kết quả',
          estimatedMs: 20000,
        },
        () => api.rejudgeRetrievalRun(selectedRrId, { judge_engine: engine })
      );
      await loadRuns();
      setSelectedRrId(res.retrieval_run_id);
      const agreeTxt =
        typeof res.agreement_rate === 'number'
          ? ` · Đồng thuận ${(res.agreement_rate * 100).toFixed(0)}% (${res.agreed_hits}/${res.compared_hits})`
          : '';
      const errTxt = res.judge_error_count > 0 ? ` · ${res.judge_error_count} lỗi fallback` : '';
      const msg = `Đã chấm lại ${res.total_hits} hits bằng ${engine.toUpperCase()} trong ${res.judge_duration_ms}ms (${res.avg_ms_per_hit}ms/hit)${agreeTxt}${errTxt}`;
      if (res.judge_error_count > 0) {
        toast.warning(msg);
      } else {
        toast.success(msg);
      }
    } catch (e: any) {
      toast.error(e.message || `Không chấm lại được bằng ${engine.toUpperCase()}`);
    } finally {
      setRejudging('');
    }
  };

  const baselineRr =
    rrList.find((r) => Number(r.is_baseline_rr) === 1) ||
    (rrList.length > 0 ? rrList[rrList.length - 1] : null);

  const handleDeleteRetrievalRun = async (rrId: number) => {
    const target = rrList.find((r) => r.id === rrId);
    const isBase = baselineRr && baselineRr.id === rrId;
    if (isBase && rrList.length > 1) {
      toast.warning('Đây là cấu hình gốc (Baseline) đang dùng làm mốc so sánh. Hãy xóa các thử nghiệm khác trước nếu muốn xóa Baseline.');
      return;
    }
    if (!window.confirm(`Xóa lần chạy "${target?.name || `#${rrId}`}" và toàn bộ kết quả chấm của nó?`)) return;
    try {
      await api.deleteRetrievalRun(rrId);
      toast.success(`Đã xóa lần chạy "${target?.name || `#${rrId}`}"`);
      const nextList = await api.listRetrievalRuns(activeRun?.id);
      setRrList(nextList);
      if (nextList.length > 0) {
        setSelectedRrId(nextList[0].id);
      } else {
        setSelectedRrId(null);
        setGroups([]);
        setSelectedGroup(null);
      }
    } catch (e: any) {
      toast.error(e.message || 'Không xóa được lần chạy.');
    }
  };

  const openNewExperimentModal = () => {
    syncRetrievalSettings();
    if (rrList.length === 0) {
      setRrName('Baseline (Cấu hình gốc)');
    } else {
      setRrName(`Thử nghiệm #${rrList.length} (vec=${vecWeight})`);
    }
    setShowRunModal(true);
  };

  const handleScoreHit = async (hitId: number, relevant: number, reason: string) => {
    // Optimistically update the single hit & recompute contextual precision without refetching all 500 chunks
    const computeCp = (rels: number[]) => {
      let relSoFar = 0;
      let sum = 0;
      let totalRel = 0;
      rels.forEach((v, i) => {
        if (v === 1) {
          relSoFar += 1;
          totalRel += 1;
          sum += relSoFar / (i + 1);
        }
      });
      return totalRel > 0 ? Number((sum / totalRel).toFixed(4)) : 0;
    };
    const patchGroup = (g: RetrievalResultGroup): RetrievalResultGroup => {
      if (!g.hits.some((h) => h.id === hitId)) return g;
      const nextHits = g.hits.map((h) =>
        h.id === hitId ? { ...h, relevant, reason, relevancy_source: 'MANUAL' as const } : h
      );
      const rels = nextHits.filter((h) => h.relevant !== null && h.relevant !== undefined).map((h) => Number(h.relevant));
      return {
        ...g,
        hits: nextHits,
        relevant_count: rels.filter((v) => v === 1).length,
        contextual_precision: computeCp(rels),
      };
    };
    const prevGroups = groups;
    const prevSel = selectedGroup;
    setGroups((curr) => curr.map(patchGroup));
    setSelectedGroup((curr) => (curr ? patchGroup(curr) : null));
    try {
      await api.scoreRetrievalResult(hitId, relevant, reason);
    } catch (e: any) {
      setGroups(prevGroups);
      setSelectedGroup(prevSel);
      toast.error(e?.message || 'Không lưu được điểm chunk.');
    }
  };

  const handleMetaUpdate = async (patch: any, debounceMs = 0) => {
    if (!selectedRrId || !selectedGroup) return;
    const rrId = selectedRrId;
    const tcId = selectedGroup.testcase.id;
    const nextMeta = { ...selectedGroup.meta, ...patch };
    setGroups((curr) =>
      curr.map((g) => (g.testcase.id === tcId ? { ...g, meta: nextMeta } : g))
    );
    setSelectedGroup((curr) => (curr && curr.testcase.id === tcId ? { ...curr, meta: nextMeta } : curr));

    const commit = async () => {
      try {
        await api.updateTestcaseMeta(rrId, tcId, nextMeta);
      } catch (e: any) {
        toast.error(e?.message || 'Không lưu được metadata câu hỏi.');
      }
    };
    if (debounceMs > 0) {
      if (coverageTimerRef.current !== null) window.clearTimeout(coverageTimerRef.current);
      coverageTimerRef.current = window.setTimeout(commit, debounceMs);
    } else {
      await commit();
    }
  };

  const { avgPrecision, avgCoverage, fullAcCount, passGroupCount, failGroupCount } = useMemo(() => {
    const n = groups.length;
    if (n === 0) return { avgPrecision: 0, avgCoverage: 0, fullAcCount: 0, passGroupCount: 0, failGroupCount: 0 };
    let precSum = 0;
    let covSum = 0;
    let fullAc = 0;
    let passCnt = 0;
    for (const g of groups) {
      precSum += g.contextual_precision || 0;
      covSum += g.meta?.context_coverage || 0;
      if (g.meta?.answer_containment === 'FULL') fullAc += 1;
      if (g.contextual_precision >= 0.5 && g.relevant_count > 0) passCnt += 1;
    }
    return {
      avgPrecision: precSum / n,
      avgCoverage: covSum / n,
      fullAcCount: fullAc,
      passGroupCount: passCnt,
      failGroupCount: n - passCnt,
    };
  }, [groups]);

  const filteredGroups = useMemo(() => {
    const q = resSearch.trim().toLowerCase();
    return groups.filter((g) => {
      const isPass = g.contextual_precision >= 0.5 && g.relevant_count > 0;
      if (resFilter === 'PASS' && !isPass) return false;
      if (resFilter === 'FAIL' && isPass) return false;
      if (q) {
        const hay = `${g.testcase.tc_code} ${g.testcase.input_question} ${g.testcase.source_file || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [groups, resFilter, resSearch]);

  return (
    <div className="h-full flex flex-col bg-white">
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
          <button
            type="button"
            onClick={() => setSubTab('compare')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              subTab === 'compare'
                ? 'border-[#027a42] text-[#141414]'
                : 'border-transparent text-[#71717a] hover:text-[#141414]'
            }`}
          >
            <GitCompare className="size-3.5" />
            So sánh A → B
          </button>
          <button
            type="button"
            onClick={() => setSubTab('autotune')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              subTab === 'autotune'
                ? 'border-[#027a42] text-[#141414]'
                : 'border-transparent text-[#71717a] hover:text-[#141414]'
            }`}
          >
            <SlidersHorizontal className="size-3.5" />
            Auto-Tune
          </button>
        </div>

        <div className="flex items-center gap-2 py-1.5">
          {subTab === 'results' && groups.length > 0 && (
            <div className="hidden md:flex items-center gap-1.5 text-[11px] text-[#52525b]">
              <span className="px-2 py-0.5 rounded bg-[#fafaf9] border border-[#e4e4e2]">
                Precision: <strong className="font-mono tabular-nums text-[#18181b]">{(avgPrecision * 100).toFixed(1)}%</strong>
              </span>
              <span className="px-2 py-0.5 rounded bg-[#fafaf9] border border-[#e4e4e2]">
                Coverage: <strong className="font-mono tabular-nums text-[#18181b]">{(avgCoverage * 100).toFixed(1)}%</strong>
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
            onClick={openNewExperimentModal}
            disabled={busy || generating || testcases.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#141414] hover:bg-[#27272a] text-white disabled:opacity-40 transition-colors"
            title={testcases.length === 0 ? 'Hãy sinh hoặc thêm câu hỏi Golden trước' : 'Tạo lần chạy thử nghiệm cấu hình Retrieval mới (đổi vector weight, rerank, threshold...)'}
          >
            <Play className="size-3.5" />
            {rrList.length === 0 ? 'Chạy Baseline' : '+ Chạy thử nghiệm mới'}
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
                onClick={() => setShowImportExcel(true)}
                className="inline-flex items-center gap-1 h-7 px-2.5 text-xs font-medium rounded-md bg-white border border-[#dcdcd8] hover:border-[#03aa5c] hover:text-[#027a42] text-[#141414] transition-colors"
                title="Nhập bộ câu hỏi Golden từ file Excel (.xlsx) hoặc CSV bất kỳ"
              >
                <FileSpreadsheet className="size-3.5 text-[#027a42]" /> Nhập Excel
              </button>

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
            <div className="flex-1 flex items-center justify-center text-xs text-[#71717a]">
              Đang chuẩn bị bộ câu hỏi Golden...
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
                    onClick={() => setShowImportExcel(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md bg-white border border-[#03aa5c]/50 hover:bg-[#f2fbf6] text-[#027a42]"
                  >
                    <FileSpreadsheet className="size-3.5" /> Nhập từ Excel
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
                      <div
                        key={tc.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedTcId(tc.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedTcId(tc.id);
                          }
                        }}
                        className={`group w-full text-left px-4 py-3 transition-colors cursor-pointer ${
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
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteTc(tc);
                            }}
                            title={`Xóa ${tc.tc_code}`}
                            aria-label={`Xóa ${tc.tc_code}`}
                            className="shrink-0 p-1 rounded-md text-[#a1a1aa] opacity-60 group-hover:opacity-100 hover:text-[#dc2626] hover:bg-[#fef2f2] transition-colors"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                        <div className="text-[13px] text-[#18181b] leading-snug line-clamp-2 font-medium">
                          {tc.input_question}
                        </div>
                        <div className="text-[11px] text-[#78716c] truncate mt-1 flex items-center gap-1">
                          <FileText className="size-3 shrink-0 text-[#a1a1aa]" />
                          <span className="truncate">{tc.source_file || '—'}</span>
                        </div>
                      </div>
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
      ) : subTab === 'autotune' ? (
        /* ==================== TAB 4: AUTO-TUNE GRID SEARCH ==================== */
        <RetrievalAutoTuneView
          activeRun={activeRun}
          testcaseCount={testcases.length}
          rerankModels={rerankModels}
          runTracked={runTracked}
          onSaveConfigAsRun={async (cfg: AutoTuneTrial) => {
            const name = `[Auto-Tune #${cfg.rank}] vec=${cfg.vector_similarity_weight.toFixed(2)} · th=${cfg.similarity_threshold.toFixed(2)} · K=${cfg.top_k}`;
            const res = await runTracked(
              {
                title: 'Lưu cấu hình Auto-Tune',
                subtitle: name,
                estimatedMs: 12000,
              },
              () =>
                api.executeRetrieval({
                  run_id: activeRun.id,
                  name,
                  top_k: cfg.top_k,
                  rerank_candidates: rerankCandidates,
                  similarity_threshold: cfg.similarity_threshold,
                  vector_similarity_weight: cfg.vector_similarity_weight,
                  rerank_id: cfg.rerank_id || '',
                  keyword_enabled: true,
                  use_llm: true,
                  judge_engine: 'llm',
                  bypass_cache: false,
                })
            );
            await loadRuns();
            setSelectedRrId(res.retrieval_run_id);
            setSubTab('results');
            toast.success(`Đã lưu cấu hình "${name}" vào Kết quả Retrieval.`);
          }}
        />
      ) : subTab === 'compare' ? (
        /* ==================== TAB 3: COMPARE A -> B ==================== */
        <RetrievalCompareView
          runId={activeRun.id}
          rrList={rrList}
          onReloadRuns={loadRuns}
          onOpenNewExperiment={openNewExperimentModal}
          onJumpToTestcase={(rrId, tcCode) => {
            setSelectedRrId(rrId);
            setSubTab('results');
            setResultsViewMode('split');
            setResFilter('ALL');
            setResSearch(tcCode);
          }}
        />
      ) : (
        /* ==================== TAB 2: RETRIEVAL RESULTS ==================== */
        <>
          <div className="px-5 py-2 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-2.5 shrink-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[#71717a]">Lần chạy:</span>
              <select
                className="ts-input py-1 px-2.5 text-xs rounded-md bg-white min-w-[240px]"
                value={selectedRrId ?? ''}
                onChange={(e) => setSelectedRrId(Number(e.target.value))}
              >
                {rrList.map((rr) => (
                  <option key={rr.id} value={rr.id}>
                    {rr.id === baselineRr?.id ? '[GỐC · BASELINE] ' : ''}
                    {rr.name} (Top-{rr.top_k} · th={rr.similarity_threshold} · vec={rr.vector_similarity_weight})
                  </option>
                ))}
                {rrList.length === 0 && <option value="">Chưa có lần chạy tìm kiếm nào</option>}
              </select>
              {selectedRrId && (
                <>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowRejudgeMenu((v) => !v)}
                      disabled={!!rejudging || busy || generating}
                      className="inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-md border border-[#dcdcd8] bg-white hover:bg-[#f4f4f2] text-[#141414] transition-colors disabled:opacity-45"
                    >
                      {rejudging ? <Loader2 className="size-3.5 animate-spin text-[#027a42]" /> : <Wand2 className="size-3.5 text-[#52525b]" />}
                      {rejudging === 'llm'
                        ? 'LLM đang chấm...'
                        : rejudging === 'jev'
                          ? 'Jev đang chấm...'
                          : 'Chấm lại'}
                      <ChevronDown className="size-3 text-[#71717a]" />
                    </button>
                    {showRejudgeMenu && (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setShowRejudgeMenu(false)} />
                        <div className="absolute left-0 top-full mt-1.5 z-30 w-60 rounded-lg border border-[#e4e4e2] bg-white shadow-lg py-1 text-xs">
                          <button
                            type="button"
                            onClick={() => {
                              setShowRejudgeMenu(false);
                              handleRejudge('llm');
                            }}
                            className="w-full text-left px-3 py-2 hover:bg-[#fafaf9] flex items-start gap-2"
                          >
                            <Wand2 className="size-3.5 text-[#141414] mt-0.5 shrink-0" />
                            <div>
                              <div className="font-medium text-[#141414]">Chấm lại bằng LLM (Khuyên dùng)</div>
                              <div className="text-[10.5px] text-[#71717a]">Batched Top-K · chính xác tiếng Việt</div>
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowRejudgeMenu(false);
                              handleRejudge('jev');
                            }}
                            className="w-full text-left px-3 py-2 hover:bg-[#fafaf9] flex items-start gap-2 border-t border-[#f0f0ee]"
                          >
                            <Sparkles className="size-3.5 text-[#027a42] mt-0.5 shrink-0" />
                            <div>
                              <div className="font-medium text-[#141414]">Chấm lại bằng Jev / Kev</div>
                              <div className="text-[10.5px] text-[#71717a]">Tạo bản phụ để so A/B</div>
                            </div>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteRetrievalRun(selectedRrId)}
                    disabled={!!rejudging || busy || generating}
                    className="inline-flex items-center justify-center size-7 rounded-md border border-[#dcdcd8] bg-white text-[#71717a] hover:text-[#b91c1c] hover:border-[#fecaca] hover:bg-[#fef2f2] transition-colors disabled:opacity-40"
                    title="Xóa lần chạy Retrieval này"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-[#52525b]">
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
              {/* Left: Compact Filterable Testcase List */}
              <div className="lg:col-span-4 border-r border-[#e8e8e6] flex flex-col min-h-0 bg-[#fafaf9]">
                <div className="px-3 py-2 border-b border-[#e8e8e6] bg-[#fafaf9] space-y-2 shrink-0">
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="inline-flex items-center p-0.5 rounded-md bg-[#ededeb] border border-[#e4e4e2] text-[11px]">
                      {(
                        [
                          { id: 'ALL', label: `Tất cả (${groups.length})` },
                          { id: 'FAIL', label: `Fail (${failGroupCount})` },
                          { id: 'PASS', label: `Pass (${passGroupCount})` },
                        ] as const
                      ).map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => setResFilter(f.id)}
                          className={`px-2 py-0.5 rounded-[4px] transition-colors ${
                            resFilter === f.id
                              ? f.id === 'FAIL'
                                ? 'bg-white text-[#b91c1c] font-semibold shadow-2xs'
                                : f.id === 'PASS'
                                  ? 'bg-white text-[#027a42] font-semibold shadow-2xs'
                                  : 'bg-white text-[#141414] font-semibold shadow-2xs'
                              : 'text-[#52525b] hover:text-[#141414]'
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="inline-flex items-center w-full h-7 bg-white border border-[#dcdcd8] focus-within:border-[#141414] rounded-md px-2 gap-1.5 transition-colors">
                    <Search className="size-3 text-[#a1a1aa] shrink-0" />
                    <input
                      type="text"
                      value={resSearch}
                      onChange={(e) => setResSearch(e.target.value)}
                      placeholder="Tìm mã TC, câu hỏi, tên file..."
                      className="w-full text-xs text-[#141414] placeholder:text-[#a1a1aa] bg-transparent focus:outline-none"
                    />
                    {resSearch && (
                      <button
                        type="button"
                        onClick={() => setResSearch('')}
                        className="text-[#a1a1aa] hover:text-[#141414]"
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto">
                  {filteredGroups.map((g) => {
                    const isPass = g.contextual_precision >= 0.5 && g.relevant_count > 0;
                    const isSel = selectedGroup?.testcase.id === g.testcase.id;
                    return (
                      <button
                        key={g.testcase.id}
                        type="button"
                        onClick={() => {
                          setSelectedGroup(g);
                          setOnlyRelHits(false);
                          setInspectHitId(null);
                        }}
                        className={`w-full text-left px-3.5 py-2.5 border-b border-[#ededeb] transition-colors ${
                          isSel
                            ? 'bg-white border-l-[3px] border-l-[#027a42]'
                            : 'hover:bg-white/75'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span
                              className={`size-1.5 rounded-full shrink-0 ${
                                isPass ? 'bg-[#03aa5c]' : 'bg-[#d6656c]'
                              }`}
                            />
                            <span className="font-mono text-xs font-semibold text-[#141414]">{g.testcase.tc_code}</span>
                            <span
                              className={`text-[10px] px-1.5 py-0 rounded border ${
                                CLASS_BADGE[g.testcase.question_class] || CLASS_BADGE.Local
                              }`}
                            >
                              {g.testcase.question_class}
                            </span>
                            <span className="font-mono text-[10.5px] text-[#78716c]">
                              {g.relevant_count}/{g.hits.length}
                            </span>
                          </div>
                          <span
                            className={`font-mono text-xs font-semibold tabular-nums ${
                              isPass ? 'text-[#027a42]' : 'text-[#b91c1c]'
                            }`}
                          >
                            {(g.contextual_precision * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div className="text-[12.5px] text-[#27272a] line-clamp-2 mt-1 leading-snug">
                          {g.testcase.input_question}
                        </div>
                      </button>
                    );
                  })}
                  {filteredGroups.length === 0 && (
                    <div className="p-6 text-center text-xs text-[#71717a]">
                      Không có câu hỏi nào khớp bộ lọc.
                    </div>
                  )}
                </div>
              </div>

              {/* Right: Compact Question Header + Quick-Jump Top-K Hits */}
              <div className="lg:col-span-8 overflow-y-auto px-6 py-4 space-y-4 bg-white">
                {selectedGroup ? (
                  <>
                    <div className="border border-[#e6e6e3] rounded-lg p-4 space-y-2.5 bg-[#fafaf9]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-[#141414] text-white shrink-0">
                            {selectedGroup.testcase.tc_code}
                          </span>
                          <span className="text-xs text-[#71717a] truncate">
                            {selectedGroup.testcase.source_file || '—'} ·{' '}
                            {AC_LABELS[selectedGroup.meta.answer_containment] || selectedGroup.meta.answer_containment}
                          </span>
                        </div>
                        <span
                          className={`font-mono text-xs font-semibold px-2 py-0.5 rounded-full ${
                            selectedGroup.contextual_precision >= 0.5 && selectedGroup.relevant_count > 0
                              ? 'bg-[#f2fbf6] text-[#027a42] border border-[#bbf7d0]'
                              : 'bg-[#fef2f2] text-[#b91c1c] border border-[#fecaca]'
                          }`}
                        >
                          Precision {(selectedGroup.contextual_precision * 100).toFixed(0)}% · Đúng {selectedGroup.relevant_count}/{selectedGroup.hits.length}
                        </span>
                      </div>

                      <h2 className="text-[15px] font-semibold text-[#141414] leading-snug">
                        {selectedGroup.testcase.input_question}
                      </h2>

                      <div className="bg-white border border-[#e6e6e3] rounded-md px-3 py-2 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#78716c]">
                            Đoạn căn cứ chuẩn trong tài liệu gốc
                          </span>
                          <button
                            type="button"
                            onClick={() => setRefCollapsed((v) => !v)}
                            className="inline-flex items-center gap-0.5 text-[11px] text-[#71717a] hover:text-[#141414]"
                          >
                            {refCollapsed ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
                            {refCollapsed ? 'Mở rộng' : 'Thu gọn'}
                          </button>
                        </div>
                        {!refCollapsed && (
                          <div className="text-[12.5px] text-[#27272a] leading-relaxed whitespace-pre-wrap max-h-28 overflow-y-auto">
                            {selectedGroup.testcase.reference_context}
                          </div>
                        )}
                      </div>

                      <div className="pt-2 border-t border-[#e8e8e6] flex flex-wrap items-center gap-3 text-xs">
                        <label className="flex items-center gap-1.5 text-[#52525b]">
                          <span>Độ phủ:</span>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            max="1"
                            className="ts-input py-0.5 w-14 text-center font-mono text-xs bg-white"
                            value={selectedGroup.meta.context_coverage}
                            onChange={(e) => handleMetaUpdate({ context_coverage: Number(e.target.value) }, 400)}
                          />
                        </label>

                        <label className="flex items-center gap-1.5 text-[#52525b]">
                          <span>Nguyên nhân:</span>
                          <select
                            className="ts-input py-0.5 text-xs bg-white"
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
                          className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-[#d4d4d8] bg-white hover:bg-[#141414] hover:text-white hover:border-[#141414] text-[#141414] disabled:opacity-50 transition-colors"
                        >
                          {diagnosing ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                          {diagnosing ? 'Đang soi...' : 'Soi nguyên nhân gốc'}
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

                    {/* Top-K Hits: Compact Clickable List (Click any row to open floating detail modal) */}
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-1.5 border-b border-[#f0f0ee]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="ts-eyebrow">TOP {selectedGroup.hits.length} ĐOẠN RAGFLOW TÌM ĐƯỢC</span>
                          <span className="text-[11px] text-[#71717a]">(Nhấn vào từng đoạn để xem chi tiết)</span>
                        </div>
                        <div className="inline-flex items-center p-0.5 rounded-md bg-[#f4f4f2] border border-[#e4e4e2] text-[11px]">
                          <button
                            type="button"
                            onClick={() => setOnlyRelHits(false)}
                            className={`px-2 py-0.5 rounded-[4px] ${!onlyRelHits ? 'bg-white text-[#141414] font-medium shadow-2xs' : 'text-[#71717a]'}`}
                          >
                            Tất cả ({selectedGroup.hits.length})
                          </button>
                          <button
                            type="button"
                            onClick={() => setOnlyRelHits(true)}
                            className={`px-2 py-0.5 rounded-[4px] ${onlyRelHits ? 'bg-white text-[#027a42] font-medium shadow-2xs' : 'text-[#71717a]'}`}
                          >
                            Đoạn đúng ({selectedGroup.relevant_count})
                          </button>
                        </div>
                      </div>

                      <div className="border border-[#e6e6e3] rounded-lg overflow-hidden divide-y divide-[#ededeb] bg-white">
                        {selectedGroup.hits
                          .filter((hit) => !onlyRelHits || hit.relevant === 1)
                          .map((hit) => {
                            const isRel = hit.relevant === 1;
                            return (
                              <div
                                id={`hit-card-${hit.id}`}
                                key={hit.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => setInspectHitId(hit.id)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setInspectHitId(hit.id);
                                  }
                                }}
                                className={`px-3.5 py-2.5 flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                                  isRel
                                    ? 'bg-[#f2fbf6]/55 hover:bg-[#ecfdf3] border-l-[3px] border-l-[#03aa5c]'
                                    : 'bg-white hover:bg-[#fafaf9] border-l-[3px] border-l-transparent'
                                }`}
                              >
                                <div className="min-w-0 flex-1 space-y-1">
                                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                    <span
                                      className={`font-mono text-[11px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                                        isRel ? 'bg-[#027a42] text-white' : 'bg-[#52525b] text-white'
                                      }`}
                                    >
                                      #{hit.rank}
                                    </span>
                                    {isRel ? (
                                      <span className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded bg-[#dcfce7] text-[#027a42] shrink-0">
                                        Liên quan
                                      </span>
                                    ) : hit.relevant === 0 ? (
                                      <span className="text-[10.5px] font-medium px-1.5 py-0.5 rounded bg-[#ededeb] text-[#71717a] shrink-0">
                                        Không liên quan
                                      </span>
                                    ) : null}
                                    <span className="font-medium text-[#141414] truncate">{hit.doc_name || 'Tài liệu'}</span>
                                    {hit.relevancy_source === 'CACHED' && (
                                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[#f4f4f2] text-[#52525b] shrink-0">
                                        <Sparkles className="size-2.5 text-[#027a42]" /> Cache
                                      </span>
                                    )}
                                    {hit.relevancy_source === 'JEV_DRAFT' && (
                                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#f2fbf6] border border-[#03aa5c]/40 text-[#027a42] font-semibold shrink-0">
                                        JEV
                                      </span>
                                    )}
                                    {hit.relevancy_source === 'LLM_DRAFT' && (
                                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#fafaf9] border border-[#e4e4e2] text-[#52525b] shrink-0">
                                        LLM
                                      </span>
                                    )}
                                    {hit.relevancy_source === 'RULE' && (
                                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#fffbeb] border border-[#fde68a] text-[#92400e] shrink-0">
                                        RULE
                                      </span>
                                    )}
                                    {hit.relevancy_source === 'MANUAL' && (
                                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#141414] text-white shrink-0">
                                        MANUAL
                                      </span>
                                    )}
                                  </div>
                                  {hit.reason && (
                                    <div
                                      className={`text-[11.5px] truncate ${
                                        hit.reason.includes('Cần duyệt') || hit.reason.includes('Fallback')
                                          ? 'text-[#92400e]'
                                          : isRel
                                            ? 'text-[#027a42]'
                                            : 'text-[#71717a]'
                                      }`}
                                    >
                                      {hit.reason}
                                    </div>
                                  )}
                                </div>

                                <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                                  <span className="font-mono text-[11px] text-[#71717a] tabular-nums w-12 text-right">
                                    {(hit.similarity * 100).toFixed(0)}%
                                  </span>
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => handleScoreHit(hit.id, 1, 'Chứa thông tin trả lời')}
                                      title="Đánh dấu Đúng (Liên quan)"
                                      className={`inline-flex items-center justify-center size-6 rounded border transition-colors ${
                                        isRel
                                          ? 'bg-[#027a42] text-white border-[#027a42]'
                                          : 'bg-white text-[#71717a] border-[#e4e4e2] hover:border-[#027a42] hover:text-[#027a42]'
                                      }`}
                                    >
                                      <Check className="size-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleScoreHit(hit.id, 0, 'Không liên quan')}
                                      title="Đánh dấu Không liên quan"
                                      className={`inline-flex items-center justify-center size-6 rounded border transition-colors ${
                                        hit.relevant === 0
                                          ? 'bg-[#b91c1c] text-white border-[#b91c1c]'
                                          : 'bg-white text-[#71717a] border-[#e4e4e2] hover:border-[#b91c1c] hover:text-[#b91c1c]'
                                      }`}
                                    >
                                      <X className="size-3.5" />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                      {onlyRelHits && selectedGroup.relevant_count === 0 && (
                        <div className="p-6 text-center text-xs text-[#71717a] border border-dashed border-[#e4e4e2] rounded-lg">
                          Không có đoạn nào được đánh dấu liên quan trong Top-{selectedGroup.hits.length}.
                        </div>
                      )}
                    </div>

                    {/* Floating Modal: Chunk Hit Detail */}
                    {(() => {
                      const inspectHit = inspectHitId
                        ? selectedGroup.hits.find((h) => h.id === inspectHitId) || null
                        : null;
                      if (!inspectHit) return null;
                      const hitIdx = selectedGroup.hits.findIndex((h) => h.id === inspectHit.id);
                      const isRel = inspectHit.relevant === 1;
                      return (
                        <div
                          className="fixed inset-0 z-50 bg-black/35 flex items-center justify-center p-4"
                          onClick={() => setInspectHitId(null)}
                        >
                          <div
                            className="bg-white border border-[#dedede] rounded-xl w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden shadow-2xl"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {/* Modal Header */}
                            <div className="px-5 py-3 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-3 shrink-0">
                              <div className="flex flex-wrap items-center gap-2 min-w-0">
                                <div className="inline-flex items-center rounded border border-[#dcdcd8] bg-white overflow-hidden">
                                  <button
                                    type="button"
                                    disabled={hitIdx <= 0}
                                    onClick={() => setInspectHitId(selectedGroup.hits[hitIdx - 1].id)}
                                    className="p-1 text-[#52525b] hover:bg-[#f4f4f2] disabled:opacity-30"
                                    title="Đoạn trước (←)"
                                  >
                                    <ChevronLeft className="size-3.5" />
                                  </button>
                                  <span className="px-2 font-mono text-[11px] font-semibold text-[#141414] border-x border-[#ededeb]">
                                    #{inspectHit.rank}/{selectedGroup.hits.length}
                                  </span>
                                  <button
                                    type="button"
                                    disabled={hitIdx < 0 || hitIdx >= selectedGroup.hits.length - 1}
                                    onClick={() => setInspectHitId(selectedGroup.hits[hitIdx + 1].id)}
                                    className="p-1 text-[#52525b] hover:bg-[#f4f4f2] disabled:opacity-30"
                                    title="Đoạn sau (→)"
                                  >
                                    <ChevronRight className="size-3.5" />
                                  </button>
                                </div>
                                <span
                                  className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
                                    isRel ? 'bg-[#dcfce7] text-[#027a42]' : 'bg-[#ededeb] text-[#52525b]'
                                  }`}
                                >
                                  {isRel ? 'Liên quan' : inspectHit.relevant === 0 ? 'Không liên quan' : 'Chưa chấm'}
                                </span>
                                <span className="text-xs font-semibold text-[#141414] truncate">
                                  {inspectHit.doc_name || 'Tài liệu'}
                                </span>
                              </div>
                              <div className="flex items-center gap-3 shrink-0">
                                <span className="font-mono text-xs text-[#71717a] tabular-nums">
                                  Khớp <strong className="text-[#141414]">{(inspectHit.similarity * 100).toFixed(0)}%</strong>
                                </span>
                                <span className="text-[11px] text-[#a1a1aa] hidden sm:inline">←/→ chuyển · Esc đóng</span>
                                <button
                                  type="button"
                                  onClick={() => setInspectHitId(null)}
                                  className="p-1 rounded hover:bg-[#ededeb] text-[#52525b] hover:text-[#141414]"
                                  aria-label="Đóng"
                                >
                                  <X className="size-4" />
                                </button>
                              </div>
                            </div>

                            {/* Modal Body */}
                            <div className="flex-1 overflow-y-auto p-5 space-y-4">
                              {/* Reference Comparison Strip */}
                              <div className="bg-[#fafaf9] border border-[#e6e6e3] rounded-lg p-3.5 space-y-1.5">
                                <div className="flex items-center gap-2 text-xs">
                                  <span className="font-mono font-bold px-1.5 py-0.5 rounded bg-[#141414] text-white text-[10.5px]">
                                    {selectedGroup.testcase.tc_code}
                                  </span>
                                  <span className="font-semibold text-[#141414]">
                                    {selectedGroup.testcase.input_question}
                                  </span>
                                </div>
                                <div className="text-[12px] text-[#52525b] leading-relaxed whitespace-pre-wrap max-h-24 overflow-y-auto pl-1 border-l-2 border-[#d4d4d8]">
                                  {selectedGroup.testcase.reference_context}
                                </div>
                              </div>

                              {/* AI Reason Banner */}
                              {inspectHit.reason && (
                                <div
                                  className={`text-xs px-3 py-2 rounded-md border ${
                                    inspectHit.reason.includes('Cần duyệt') || inspectHit.reason.includes('Fallback')
                                      ? 'bg-[#fffbeb] border-[#fde68a] text-[#92400e]'
                                      : isRel
                                        ? 'bg-[#f2fbf6] border-[#bbf7d0] text-[#027a42]'
                                        : 'bg-[#fafaf9] border-[#e4e4e2] text-[#3f3f46]'
                                  }`}
                                >
                                  <span className="font-mono text-[10px] uppercase font-semibold mr-2 px-1.5 py-0.5 rounded bg-white border border-black/10">
                                    {inspectHit.relevancy_source}
                                  </span>
                                  {inspectHit.reason}
                                </div>
                              )}

                              {/* Full Chunk Content */}
                              <div className="space-y-1.5">
                                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[#71717a]">
                                  Nội dung đoạn #{inspectHit.rank} RAGFlow tìm được
                                </div>
                                <ChunkContentView content={inspectHit.content} />
                              </div>
                            </div>

                            {/* Modal Footer: Manual Scoring */}
                            <div className="px-5 py-3 border-t border-[#e8e8e6] bg-[#fafaf9] flex items-center justify-between gap-2 shrink-0">
                              <span className="text-[11px] text-[#71717a]">
                                Chấm lại thủ công sẽ lưu vào Smart Cache cho các lần chạy sau.
                              </span>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleScoreHit(inspectHit.id, 1, 'Chứa thông tin trả lời')}
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border ${
                                    isRel
                                      ? 'bg-[#027a42] text-white border-[#027a42]'
                                      : 'bg-white text-[#3f3f46] border-[#e4e4e2] hover:border-[#027a42]'
                                  }`}
                                >
                                  <Check className="size-3.5" /> Đúng (Liên quan)
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleScoreHit(inspectHit.id, 0, 'Không liên quan')}
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border ${
                                    inspectHit.relevant === 0
                                      ? 'bg-[#b91c1c] text-white border-[#b91c1c]'
                                      : 'bg-white text-[#3f3f46] border-[#e4e4e2] hover:border-[#b91c1c]'
                                  }`}
                                >
                                  <X className="size-3.5" /> Không liên quan
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
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
              <h2 className="text-base font-semibold text-[#141414]">
                {baselineRr ? 'Chạy thử nghiệm cấu hình mới' : 'Chạy cấu hình gốc (Baseline)'}
              </h2>
              <button type="button" onClick={() => setShowRunModal(false)} aria-label="Đóng">
                <X className="size-4 text-[#71717a]" />
              </button>
            </div>
            {baselineRr && (
              <div className="text-[11px] bg-[#fafaf9] border border-[#e8e8e6] rounded-md px-3 py-2 text-[#52525b] font-mono">
                <span className="font-sans font-semibold text-[#141414] mr-1.5">Cấu hình gốc (Baseline):</span>
                Top-{baselineRr.top_k} · th={baselineRr.similarity_threshold} · vec={baselineRr.vector_similarity_weight}{' '}
                · {baselineRr.rerank_id ? `rerank=${baselineRr.rerank_id}` : 'no-rerank'}
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-[#52525b] mb-1">Tên lần chạy</label>
                <input className="ts-input w-full" value={rrName} onChange={(e) => setRrName(e.target.value)} required />
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-xs text-[#52525b] mb-1">Top N (trả về)</label>
                  <input type="number" min={1} max={50} className="ts-input w-full font-mono" value={topK} onChange={(e) => setTopK(Number(e.target.value))} />
                </div>
                <div>
                  <label className="block text-xs text-[#52525b] mb-1">Ngưỡng lọc</label>
                  <input type="number" step="0.05" min={0} max={1} className="ts-input w-full font-mono" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
                </div>
                <div>
                  <label className="block text-xs text-[#52525b] mb-1">Tỷ trọng Vector</label>
                  <input type="number" step="0.1" min={0} max={1} className="ts-input w-full font-mono" value={vecWeight} onChange={(e) => setVecWeight(Number(e.target.value))} />
                </div>
              </div>
              <div className="text-[11px] text-[#71717a] font-mono -mt-1.5">
                Tỷ lệ tìm kiếm: Vector {Math.round(Math.max(0, Math.min(1, vecWeight)) * 100)}% · Keyword{' '}
                {Math.round((1 - Math.max(0, Math.min(1, vecWeight))) * 100)}%
              </div>
              <div className="rounded-md border border-[#e8e8e6] bg-[#fafaf9] px-3 py-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label
                    className={`flex items-center gap-2 text-xs font-medium ${
                      rerankModels.length > 0 ? 'text-[#141414] cursor-pointer' : 'text-[#a1a1aa] cursor-not-allowed'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={useRerank && rerankModels.length > 0}
                      disabled={rerankModels.length === 0}
                      onChange={(e) => setUseRerank(e.target.checked)}
                      className="rounded border-[#d4d4d8]"
                    />
                    <span>Dùng Rerank (từ RAGFlow)</span>
                    {loadingReranks ? (
                      <span className="text-[11px] font-normal text-[#71717a]">đang tải...</span>
                    ) : rerankModels.length === 0 ? (
                      <span className="text-[11px] font-normal text-[#a1a1aa]">(chưa có model Rerank trên RAGFlow)</span>
                    ) : (
                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white border border-[#e4e4e2] text-[#52525b]">
                        {rerankModels.length} model
                      </span>
                    )}
                  </label>
                  {useRerank && rerankModels.length > 0 && (
                    <label
                      className="flex items-center gap-1.5 text-[11px] text-[#52525b] shrink-0"
                      title="Số ứng viên vòng sơ loại đưa vào Reranker"
                    >
                      <span>Cand.</span>
                      <input
                        type="number"
                        min={10}
                        max={1024}
                        className="ts-input py-0.5 w-14 text-center font-mono text-xs bg-white"
                        value={rerankCandidates}
                        onChange={(e) => setRerankCandidates(Number(e.target.value) || 64)}
                      />
                    </label>
                  )}
                </div>
                {useRerank && rerankModels.length > 0 && (
                  <select
                    className="ts-input w-full text-xs bg-white font-mono"
                    value={selectedRerankId}
                    onChange={(e) => setSelectedRerankId(e.target.value)}
                  >
                    {rerankModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className="block text-xs text-[#52525b] mb-1">Bộ chấm Relevancy ({testcases.length} câu · Top-{topK})</label>
                <select
                  className="ts-input w-full text-xs"
                  value={judgeEngine}
                  onChange={(e) => setJudgeEngine(e.target.value as 'jev' | 'llm' | 'rule')}
                >
                  <option value="jev">Jev / Kev System One (/v1/systemone · Nhanh + có xác suất p)</option>
                  <option value="llm">Generative LLM (/chat/completions · Batched Top-K)</option>
                  <option value="rule">RapidFuzz Rule (0-AI · Miễn phí)</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-xs text-[#3f3f46] cursor-pointer">
                <input
                  type="checkbox"
                  checked={bypassCache}
                  onChange={(e) => setBypassCache(e.target.checked)}
                  className="rounded border-[#d4d4d8]"
                />
                Bỏ qua Smart Cache (chấm mới toàn bộ thay vì kế thừa nhãn cũ)
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

      {/* Modal: Import Golden Testcases from Excel / CSV */}
      {showImportExcel && activeRun && (
        <ImportGoldenModal
          runId={activeRun.id}
          runName={activeRun.name}
          onClose={() => setShowImportExcel(false)}
          onImported={async () => {
            await loadTestcases();
            if (selectedRrId) await loadResults(selectedRrId);
          }}
        />
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

      <FloatingProgressOverlay
        state={taskProgress}
        fallback={
          loadingTc
            ? {
                title: 'Đang tải bộ câu hỏi Golden',
                subtitle: 'Đang nạp danh sách testcase & ngữ cảnh chuẩn...',
              }
            : diagnosing
            ? {
                title: 'Đang chẩn đoán nguyên nhân lỗi Retrieval',
                subtitle: 'Đối chiếu tầng Parsing, Chunking và Retrieval...',
              }
            : null
        }
        moduleLabel="RETRIEVAL QC"
      />
    </div>
  );
};
