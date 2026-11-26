import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Layers,
  Loader2,
  Play,
  Sliders,
  Sparkles,
  Square,
  Trash2,
  Trophy,
  Zap,
} from 'lucide-react';
import { api } from '../api/client';
import { CanaryTunerPanel } from '../components/CanaryTunerPanel';
import { ConfigAdvisorPanel } from '../components/ConfigAdvisorPanel';
import { ParetoScatterChart } from '../components/ParetoScatterChart';
import {
  AdvisorResponse,
  CandidateConfigPack,
  CanaryVariantDef,
  HypothesisPack,
  OptimizationStudy,
  OptimizationTrial,
  RunItem,
  SwarmDiagnosisReport,
} from '../types';

interface Props {
  activeRun: RunItem | null;
  isActive?: boolean;
  onReloadRuns: (preferredRunId?: number) => void;
  onSelectRun: (run: RunItem) => void;
  onOpenWorkspace?: () => void;
  onOpenRetrieval?: () => void;
}

const VEC_WEIGHT_OPTS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.7];
const THRESHOLD_OPTS = [0.05, 0.1, 0.15, 0.2, 0.3];
const TOP_K_OPTS = [5, 8, 10, 12, 15];
const PRESET_RERANKERS = [
  { id: '', label: 'Tắt Rerank' },
  { id: 'BAAI/bge-reranker-v2-m3', label: 'BAAI/bge-reranker-v2-m3' },
  { id: 'BAAI/bge-reranker-large', label: 'BAAI/bge-reranker-large' },
];

const OBJECTIVE_PROFILES = [
  { id: 'balanced', label: 'Cân bằng (Balanced)', desc: '40% Precision + 30% Coverage + 20% MRR + 10% Hit@3' },
  { id: 'high_precision', label: 'Chính xác cao (Y tế / Pháp lý)', desc: '45% Precision + 30% MRR + 15% Hit@1 + 10% Coverage' },
  { id: 'high_recall', label: 'Bao phủ rộng (Global / Multi-hop)', desc: '50% Coverage + 25% Hit@K + 15% Precision + 10% MRR' },
  { id: 'low_latency', label: 'Tốc độ & Tiết kiệm Token', desc: 'Tối ưu chất lượng có trừ phạt Latency & Context Tokens' },
] as const;

const pct = (v?: number | null) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);

export const OptimizationLabPage: React.FC<Props> = ({
  activeRun,
  isActive = true,
  onReloadRuns,
  onSelectRun,
  onOpenWorkspace,
  onOpenRetrieval,
}) => {
  const [subTab, setSubTab] = useState<'advisor' | 'sweep' | 'canary'>('advisor');

  // Advisor state
  const [advisor, setAdvisor] = useState<AdvisorResponse | null>(null);
  const [loadingAdvisor, setLoadingAdvisor] = useState(false);
  const [applyingPackId, setApplyingPackId] = useState('');
  const [agentReport, setAgentReport] = useState<SwarmDiagnosisReport | null>(null);
  const [isAgentReportStale, setIsAgentReportStale] = useState(false);
  const [loadingAgentReport, setLoadingAgentReport] = useState(false);
  const [injectedCanaryVariants, setInjectedCanaryVariants] = useState<CanaryVariantDef[]>([]);

  // Sweep config state
  const [studyName, setStudyName] = useState('Retrieval Auto-Tuner');
  const [profile, setProfile] = useState<'balanced' | 'high_precision' | 'high_recall' | 'low_latency'>('balanced');
  const [judgeEngine, setJudgeEngine] = useState<'rule' | 'jev' | 'llm'>('rule');
  const [useTwoStage, setUseTwoStage] = useState(true);
  const [maxTrials, setMaxTrials] = useState(24);
  const [vecWeights, setVecWeights] = useState<number[]>([0.15, 0.25, 0.35, 0.5]);
  const [thresholds, setThresholds] = useState<number[]>([0.1, 0.2]);
  const [topKs, setTopKs] = useState<number[]>([5, 10, 15]);
  const [kwOpts, setKwOpts] = useState<boolean[]>([true]);
  const [rerankIds, setRerankIds] = useState<string[]>(['']);
  const [customRerank, setCustomRerank] = useState('');

  // Studies & trials state
  const [studies, setStudies] = useState<OptimizationStudy[]>([]);
  const [activeStudy, setActiveStudy] = useState<OptimizationStudy | null>(null);
  const [trials, setTrials] = useState<OptimizationTrial[]>([]);
  const [trialFilter, setTrialFilter] = useState<'all' | 'full' | 'pareto'>('all');
  const [startingSweep, setStartingSweep] = useState(false);
  const [applyingTrialId, setApplyingTrialId] = useState<number | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const loadAdvisor = async (runId: number) => {
    setLoadingAdvisor(true);
    try {
      const res: AdvisorResponse = await api.getConfigAdvisor(runId);
      setAdvisor(res);
    } catch (e: any) {
      toast.error(e.message || 'Không tải được đề xuất cấu hình');
    } finally {
      setLoadingAdvisor(false);
    }
  };

  const loadStudies = async (runId: number, preferredStudyId?: number) => {
    try {
      const list: OptimizationStudy[] = await api.listOptimizationStudies(runId);
      const retStudies = (list || []).filter((s) => s.study_type !== 'CANARY_INDEX');
      setStudies(retStudies);
      const targetId = preferredStudyId ?? retStudies[0]?.id;
      if (targetId) {
        const detail = await api.getOptimizationStudy(targetId);
        setActiveStudy(detail.study);
        setTrials(detail.trials || []);
      } else {
        setActiveStudy(null);
        setTrials([]);
      }
    } catch {
      setStudies([]);
    }
  };

  const loadLatestAgentReport = async (runId: number) => {
    try {
      const res = await api.getLatestAgentDiagnose(runId);
      setAgentReport(res.report || null);
      setIsAgentReportStale(Boolean(res.is_stale));
    } catch {
      setAgentReport(null);
      setIsAgentReportStale(false);
    }
  };

  useEffect(() => {
    if (!activeRun) {
      setAdvisor(null);
      setAgentReport(null);
      setIsAgentReportStale(false);
      setInjectedCanaryVariants([]);
      setStudies([]);
      setActiveStudy(null);
      setTrials([]);
      return;
    }
    setInjectedCanaryVariants([]);
    loadAdvisor(activeRun.id);
    loadLatestAgentReport(activeRun.id);
    loadStudies(activeRun.id);
  }, [activeRun?.id]);

  // Auto-refresh live corpus stats & staleness check whenever user returns to this tab
  useEffect(() => {
    if (!isActive || !activeRun) return;
    loadAdvisor(activeRun.id);
    loadLatestAgentReport(activeRun.id);
  }, [isActive, activeRun?.id]);

  // Poll while active study is RUNNING
  useEffect(() => {
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (!activeStudy || activeStudy.status !== 'RUNNING') return;

    pollTimerRef.current = window.setInterval(async () => {
      try {
        const detail = await api.getOptimizationStudy(activeStudy.id);
        setActiveStudy(detail.study);
        setTrials(detail.trials || []);
        if (detail.study.status !== 'RUNNING') {
          if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
          if (activeRun) loadStudies(activeRun.id, detail.study.id);
          if (detail.study.status === 'COMPLETED') {
            toast.success(`Tối ưu hoàn tất! Điểm cao nhất: ${pct(detail.study.summary?.best_score)}`);
          } else if (detail.study.status === 'FAILED') {
            toast.error(`Tối ưu thất bại: ${detail.study.error_message}`);
          }
        }
      } catch {
        // ignore transient poll error
      }
    }, 1500);

    return () => {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [activeStudy?.id, activeStudy?.status]);

  const rawComboCount =
    Math.max(1, vecWeights.length) *
    Math.max(1, thresholds.length) *
    Math.max(1, topKs.length) *
    Math.max(1, kwOpts.length) *
    Math.max(1, rerankIds.length);

  const toggleArr = <T,>(arr: T[], val: T, setter: React.Dispatch<React.SetStateAction<T[]>>) => {
    setter((prev) => {
      if (prev.includes(val)) {
        return prev.length > 1 ? prev.filter((x) => x !== val) : prev;
      }
      return [...prev, val];
    });
  };

  const addCustomRerank = () => {
    const clean = customRerank.trim();
    if (!clean) return;
    if (!rerankIds.includes(clean)) {
      setRerankIds((prev) => [...prev, clean]);
    }
    setCustomRerank('');
  };

  const handleRunAgentDiagnosis = async (forceRefresh: boolean) => {
    if (!activeRun || loadingAgentReport) return;
    setLoadingAgentReport(true);
    try {
      const res: SwarmDiagnosisReport = await api.runAgentDiagnose(activeRun.id, forceRefresh, true);
      setAgentReport(res);
      setIsAgentReportStale(false);
      toast.success(
        res.cached
          ? 'Đã tải kết quả Multi-Agent từ cache.'
          : `Multi-Agent hoàn tất (${res.llm_calls} LLM calls · ${res.duration_ms}ms).`
      );
    } catch (e: any) {
      toast.error(e.message || 'Không chạy được chẩn đoán Multi-Agent');
    } finally {
      setLoadingAgentReport(false);
    }
  };

  const handlePushHypothesisToCanary = (pack: HypothesisPack) => {
    if (!pack.index_patch || Object.keys(pack.index_patch).length === 0) return;
    const variant: CanaryVariantDef = {
      id: `ai_${pack.id}_${Date.now()}`,
      name: `[AI] ${pack.name}`,
      description: pack.hypothesis_statement,
      index_patch: pack.index_patch,
      is_baseline: false,
    };
    setInjectedCanaryVariants((prev) => [...prev, variant]);
    setSubTab('canary');
    toast.success(`Đã đẩy giả thuyết "${pack.name}" sang Canary Index Tuner.`);
  };

  const handlePushHypothesisToSweep = (pack: HypothesisPack) => {
    const rp = pack.retrieval_patch || {};
    if (rp.vector_similarity_weight !== undefined) {
      setVecWeights((prev) => Array.from(new Set([...prev, Number(rp.vector_similarity_weight)])));
    }
    if (rp.similarity_threshold !== undefined) {
      setThresholds((prev) => Array.from(new Set([...prev, Number(rp.similarity_threshold)])));
    }
    if (rp.top_k !== undefined) {
      setTopKs((prev) => Array.from(new Set([...prev, Number(rp.top_k)])));
    }
    if (rp.keyword_enabled !== undefined) {
      setKwOpts((prev) => Array.from(new Set([...prev, Boolean(rp.keyword_enabled)])));
    }
    if (rp.rerank_id !== undefined) {
      setRerankIds((prev) => Array.from(new Set([...prev, String(rp.rerank_id)])));
    }
    setSubTab('sweep');
    toast.success(`Đã nạp tham số Retrieval từ "${pack.name}" vào Auto-Tuner.`);
  };

  const handleApplyHypothesisPack = async (pack: HypothesisPack, forkNewRun: boolean) => {
    const asCandidate: CandidateConfigPack = {
      id: pack.id,
      name: pack.name,
      scope: pack.scope,
      reparse_required: pack.reparse_required,
      priority: pack.priority,
      summary: pack.hypothesis_statement,
      reasons: pack.expected_gains,
      tradeoff: pack.regression_warnings.join(' · ') || 'Cần kiểm tra lại sau khi áp dụng.',
      index_patch: pack.index_patch,
      retrieval_patch: pack.retrieval_patch,
      diff: pack.diff,
    };
    await handleApplyPack(asCandidate, forkNewRun);
  };

  const handleSeedFromAdvisor = () => {
    if (advisor?.recommended_sweep_space) {
      const sp = advisor.recommended_sweep_space;
      if (sp.vector_similarity_weight?.length) setVecWeights(sp.vector_similarity_weight);
      if (sp.similarity_threshold?.length) setThresholds(sp.similarity_threshold);
      if (sp.top_k?.length) setTopKs(sp.top_k);
      if (sp.keyword_enabled?.length) setKwOpts(sp.keyword_enabled);
      if (sp.rerank_ids?.length) setRerankIds(sp.rerank_ids);
    }
    setSubTab('sweep');
    toast.success('Đã nạp dải tham số khuyến nghị vào Auto-Tuner.');
  };

  const handleApplyPack = async (pack: CandidateConfigPack, forkNewRun: boolean) => {
    if (!activeRun || applyingPackId) return;
    setApplyingPackId(pack.id);
    try {
      const res = await api.applyRecommendedConfig(activeRun.id, {
        index_patch: pack.index_patch,
        retrieval_patch: pack.retrieval_patch,
        sync_remote: true,
        fork_new_run: forkNewRun,
        new_run_name: forkNewRun ? `${activeRun.name} · ${pack.name.split(':')[0]}` : '',
        copy_docs: true,
        auto_parse: true,
      });
      if (res.forked && res.run) {
        onSelectRun(res.run);
        await onReloadRuns(res.run.id);
        if (res.remote_synced) {
          const docNote =
            res.copied_docs > 0
              ? res.parse_triggered
                ? `, đã copy ${res.copied_docs} tài liệu và bắt đầu đọc lại trên RAGFlow`
                : `, đã copy ${res.copied_docs} tài liệu`
              : '';
          toast.success(`Đã tạo phiên mới "${res.run.name}"${docNote}.`);
          if (res.remote_warning) {
            toast.warning(`Lưu ý khi copy file: ${res.remote_warning}`);
          }
          if (onOpenWorkspace) onOpenWorkspace();
        } else {
          toast.warning(`Đã tạo phiên local "${res.run.name}" (${res.remote_warning || 'chưa đồng bộ RAGFlow'}).`);
        }
      } else {
        await onReloadRuns(activeRun.id);
        await loadAdvisor(activeRun.id);
        toast.success(
          pack.reparse_required
            ? 'Đã cập nhật cấu hình phiên (hãy vào Bước 01 để đọc lại tài liệu).'
            : 'Đã áp dụng cấu hình tìm kiếm mới vào phiên.'
        );
      }
    } catch (e: any) {
      toast.error(e.message || 'Không áp dụng được cấu hình');
    } finally {
      setApplyingPackId('');
    }
  };

  const handleStartSweep = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRun || startingSweep) return;
    setStartingSweep(true);
    try {
      const res = await api.startRetrievalSweep(activeRun.id, {
        name: studyName.trim() || 'Retrieval Auto-Tuner',
        objective_profile: profile,
        judge_engine: judgeEngine,
        use_two_stage: useTwoStage,
        max_trials: maxTrials,
        save_best_retrieval_run: true,
        search_space: {
          vector_similarity_weight: vecWeights,
          similarity_threshold: thresholds,
          top_k: topKs,
          keyword_enabled: kwOpts,
          rerank_ids: rerankIds,
        },
      });
      await loadStudies(activeRun.id, res.study_id);
      toast.success(`Đã khởi chạy Auto-Tuner với ${res.candidate_count} tổ hợp.`);
    } catch (e: any) {
      toast.error(e.message || 'Không khởi chạy được Auto-Tuner');
    } finally {
      setStartingSweep(false);
    }
  };

  const handleCancelStudy = async () => {
    if (!activeStudy) return;
    await api.cancelOptimizationStudy(activeStudy.id);
    toast.info('Đang dừng phiên tối ưu...');
  };

  const handleDeleteStudy = async (id: number) => {
    if (!activeRun) return;
    await api.deleteOptimizationStudy(id);
    await loadStudies(activeRun.id);
    toast.success('Đã xóa phiên tối ưu.');
  };

  const handleApplyTrial = async (t: OptimizationTrial) => {
    if (!activeRun || applyingTrialId !== null) return;
    setApplyingTrialId(t.id);
    try {
      await api.applyRecommendedConfig(activeRun.id, {
        index_patch: {},
        retrieval_patch: t.config,
        sync_remote: false,
        fork_new_run: false,
      });
      await onReloadRuns(activeRun.id);
      await loadAdvisor(activeRun.id);
      toast.success(`Đã áp dụng cấu hình Trial #${t.trial_index} làm cấu hình mặc định của Run.`);
    } catch (e: any) {
      toast.error(e.message || 'Không áp dụng được Trial');
    } finally {
      setApplyingTrialId(null);
    }
  };

  const visibleTrials = useMemo(() => {
    if (trialFilter === 'full') return trials.filter((t) => t.stage === '2_FULL');
    if (trialFilter === 'pareto') return trials.filter((t) => t.is_pareto);
    return trials;
  }, [trials, trialFilter]);

  const bestTrial = useMemo(() => {
    if (!activeStudy?.best_trial_id) return null;
    return trials.find((t) => t.id === activeStudy.best_trial_id) || null;
  }, [trials, activeStudy?.best_trial_id]);

  if (!activeRun) {
    return (
      <div className="p-10 text-sm text-[#71717a]">
        Hãy chọn hoặc tạo một phiên kiểm thử ở Bước 1 trước khi sử dụng Config Advisor &amp; Auto-Tuner.
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-96px)] bg-[#fefefe]">
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        {/* Top Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#e4e4e2] pb-4">
          <div>
            <div className="ts-eyebrow">TỐI ƯU CẤU HÌNH</div>
            <h1 className="text-xl font-semibold text-[#161616] mt-0.5">
              Phân tích lỗi &amp; Đề xuất cấu hình
            </h1>
            <p className="text-xs text-[#71717a] mt-0.5">
              Phiên kiểm thử: <strong className="text-[#161616]">{activeRun.name}</strong>
            </p>
          </div>
        </div>

        {/* ==================== MAIN: 3+1 MULTI-AGENT ADVISOR ==================== */}
        <ConfigAdvisorPanel
          advisor={advisor}
          loading={loadingAdvisor}
          applyingPackId={applyingPackId}
          onApplyPack={handleApplyPack}
          agentReport={agentReport}
          isAgentReportStale={isAgentReportStale}
          loadingAgentReport={loadingAgentReport}
          onRunAgentDiagnosis={handleRunAgentDiagnosis}
          onApplyHypothesisPack={handleApplyHypothesisPack}
        />

        {activeRun && subTab === 'canary' && (
          <CanaryTunerPanel
            activeRun={activeRun}
            onReloadRuns={onReloadRuns}
            onSelectRun={onSelectRun}
            injectedVariants={injectedCanaryVariants}
          />
        )}

        {/* ==================== SUB-TAB 2: RETRIEVAL AUTO-TUNER ==================== */}
        {subTab === 'sweep' && (
          <div className="space-y-6">
            {/* Search Space Builder Form */}
            <form
              onSubmit={handleStartSweep}
              className="border border-[#e4e4e2] rounded-lg bg-white p-5 space-y-5 shadow-2xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#ededeb]">
                <div>
                  <div className="ts-eyebrow">KHÔNG GIAN TÌM KIẾM TỔ HỢP (SEARCH SPACE)</div>
                  <div className="text-xs text-[#71717a] mt-0.5">
                    Chọn các mức giá trị muốn thử. Hệ thống tự giữ lại Baseline (#1) để đối chiếu mức cải thiện.
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs px-2.5 py-1 rounded bg-[#fafaf9] border border-[#dedede] text-[#161616]">
                    {Math.min(rawComboCount, maxTrials)}/{rawComboCount} tổ hợp
                  </span>
                  {activeStudy?.status === 'RUNNING' ? (
                    <button
                      type="button"
                      onClick={handleCancelStudy}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium bg-[#cf222e] text-white hover:bg-[#a40e26]"
                    >
                      <Square className="size-3.5" />
                      Dừng Sweep
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={startingSweep || !activeRun.ragflow_dataset_id}
                      className="ts-btn-primary text-xs"
                    >
                      {startingSweep ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Play className="size-3.5 text-[#03aa5c]" />
                      )}
                      Chạy Auto-Tuner
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div>
                  <label className="block font-medium text-[#161616] mb-1">Tên phiên tối ưu</label>
                  <input
                    className="ts-input w-full text-xs"
                    value={studyName}
                    onChange={(e) => setStudyName(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="block font-medium text-[#161616] mb-1">Mục tiêu tối ưu (Objective Profile)</label>
                  <select
                    className="ts-input w-full text-xs"
                    value={profile}
                    onChange={(e) => setProfile(e.target.value as any)}
                  >
                    {OBJECTIVE_PROFILES.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <div className="text-[10.5px] text-[#71717a] mt-1">
                    {OBJECTIVE_PROFILES.find((p) => p.id === profile)?.desc}
                  </div>
                </div>
                <div>
                  <label className="block font-medium text-[#161616] mb-1">Bộ chấm Relevancy</label>
                  <select
                    className="ts-input w-full text-xs"
                    value={judgeEngine}
                    onChange={(e) => setJudgeEngine(e.target.value as any)}
                  >
                    <option value="rule">RapidFuzz + Smart Cache (Siêu nhanh · 0 chi phí)</option>
                    <option value="jev">Jev / Kev System One + Smart Cache</option>
                    <option value="llm">Generative LLM + Smart Cache</option>
                  </select>
                  <label className="flex items-center gap-2 mt-2 text-[11px] text-[#3d3d3d] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useTwoStage}
                      onChange={(e) => setUseTwoStage(e.target.checked)}
                      className="rounded border-[#d4d4d8] accent-[#03aa5c]"
                    />
                    Bật 2-Stage Successive Halving (Lọc nhanh 35% → Kiểm chứng Top 100%)
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pt-2 border-t border-[#ededeb] text-xs">
                <div>
                  <div className="font-medium text-[#161616] mb-1.5">Vector Weight (0 = thuần BM25)</div>
                  <div className="flex flex-wrap gap-1.5">
                    {VEC_WEIGHT_OPTS.map((v) => {
                      const on = vecWeights.includes(v);
                      return (
                        <button
                          key={v}
                          type="button"
                          onClick={() => toggleArr(vecWeights, v, setVecWeights)}
                          className={`px-2 py-1 font-mono text-[11px] rounded border transition-colors ${
                            on
                              ? 'bg-[#161616] text-white border-[#161616]'
                              : 'bg-[#fafaf9] text-[#52525b] border-[#dedede] hover:border-[#161616]'
                          }`}
                        >
                          {v}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="font-medium text-[#161616] mb-1.5">Similarity Threshold</div>
                  <div className="flex flex-wrap gap-1.5">
                    {THRESHOLD_OPTS.map((v) => {
                      const on = thresholds.includes(v);
                      return (
                        <button
                          key={v}
                          type="button"
                          onClick={() => toggleArr(thresholds, v, setThresholds)}
                          className={`px-2 py-1 font-mono text-[11px] rounded border transition-colors ${
                            on
                              ? 'bg-[#161616] text-white border-[#161616]'
                              : 'bg-[#fafaf9] text-[#52525b] border-[#dedede] hover:border-[#161616]'
                          }`}
                        >
                          {v}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="font-medium text-[#161616] mb-1.5">Top-K (Page Size)</div>
                  <div className="flex flex-wrap gap-1.5">
                    {TOP_K_OPTS.map((v) => {
                      const on = topKs.includes(v);
                      return (
                        <button
                          key={v}
                          type="button"
                          onClick={() => toggleArr(topKs, v, setTopKs)}
                          className={`px-2 py-1 font-mono text-[11px] rounded border transition-colors ${
                            on
                              ? 'bg-[#161616] text-white border-[#161616]'
                              : 'bg-[#fafaf9] text-[#52525b] border-[#dedede] hover:border-[#161616]'
                          }`}
                        >
                          {v}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[11px] text-[#71717a]">Giới hạn trials:</span>
                    <input
                      type="number"
                      min={2}
                      max={48}
                      value={maxTrials}
                      onChange={(e) => setMaxTrials(Number(e.target.value) || 24)}
                      className="ts-input w-16 py-0.5 font-mono text-xs text-right"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="font-medium text-[#161616]">Rerank &amp; Keyword</div>
                  <div className="flex flex-wrap gap-1.5">
                    {PRESET_RERANKERS.map((r) => {
                      const on = rerankIds.includes(r.id);
                      return (
                        <button
                          key={r.id || 'none'}
                          type="button"
                          onClick={() => toggleArr(rerankIds, r.id, setRerankIds)}
                          className={`px-2 py-1 font-mono text-[10.5px] rounded border transition-colors ${
                            on
                              ? 'bg-[#03aa5c]/15 text-[#027a42] border-[#03aa5c] font-semibold'
                              : 'bg-[#fafaf9] text-[#52525b] border-[#dedede]'
                          }`}
                        >
                          {r.label}
                        </button>
                      );
                    })}
                    {rerankIds
                      .filter((id) => !PRESET_RERANKERS.some((p) => p.id === id))
                      .map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => toggleArr(rerankIds, id, setRerankIds)}
                          className="px-2 py-1 font-mono text-[10.5px] rounded border bg-[#03aa5c]/15 text-[#027a42] border-[#03aa5c] font-semibold"
                        >
                          {id}
                        </button>
                      ))}
                  </div>
                  <div className="flex gap-1">
                    <input
                      className="ts-input flex-1 py-1 text-[11px] font-mono"
                      placeholder="Thêm model rerank khác..."
                      value={customRerank}
                      onChange={(e) => setCustomRerank(e.target.value)}
                    />
                    <button type="button" onClick={addCustomRerank} className="ts-btn-secondary py-1 px-2 text-xs">
                      +
                    </button>
                  </div>
                  <div className="flex items-center gap-2 pt-0.5">
                    <span className="text-[11px] text-[#71717a]">Keyword:</span>
                    {[true, false].map((flag) => (
                      <button
                        key={String(flag)}
                        type="button"
                        onClick={() => toggleArr(kwOpts, flag, setKwOpts)}
                        className={`px-2 py-0.5 font-mono text-[10.5px] rounded border ${
                          kwOpts.includes(flag)
                            ? 'bg-[#161616] text-white border-[#161616]'
                            : 'bg-[#fafaf9] text-[#52525b] border-[#dedede]'
                        }`}
                      >
                        {flag ? 'Bật' : 'Tắt'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </form>

            {/* Study Switcher & Live Progress */}
            {studies.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border border-[#e4e4e2] rounded-lg bg-[#fafaf9]">
                <div className="flex items-center gap-2 text-xs">
                  <span className="ts-eyebrow">PHIÊN SWEEP:</span>
                  <select
                    className="ts-input py-1 text-xs bg-white"
                    value={activeStudy?.id || ''}
                    onChange={async (e) => {
                      const sid = Number(e.target.value);
                      if (!sid) return;
                      const detail = await api.getOptimizationStudy(sid);
                      setActiveStudy(detail.study);
                      setTrials(detail.trials || []);
                    }}
                  >
                    {studies.map((s) => (
                      <option key={s.id} value={s.id}>
                        #{s.id} · {s.name} ({s.status})
                      </option>
                    ))}
                  </select>
                  {activeStudy && (
                    <button
                      type="button"
                      onClick={() => handleDeleteStudy(activeStudy.id)}
                      className="p-1 text-[#71717a] hover:text-[#cf222e]"
                      title="Xóa phiên sweep này"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>

                {activeStudy && (
                  <div className="flex items-center gap-3 text-xs font-mono">
                    {activeStudy.status === 'RUNNING' && (
                      <Loader2 className="size-3.5 animate-spin text-[#03aa5c]" />
                    )}
                    <span className="text-[#52525b]">{activeStudy.stage_label}</span>
                    <span className="font-semibold text-[#161616]">
                      {activeStudy.progress_done}/{activeStudy.progress_total}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Winning Recipe Banner */}
            {activeStudy?.status === 'COMPLETED' && bestTrial && (
              <div className="border-2 border-[#03aa5c] rounded-lg bg-[#f2fbf6] p-5 flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <Trophy className="size-4 text-[#027a42]" />
                    <span className="ts-eyebrow text-[#027a42]">TỔ HỢP TỐI ƯU NHẤT (WINNING RECIPE)</span>
                    {typeof activeStudy.summary?.delta_score === 'number' && (
                      <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded-full bg-[#03aa5c] text-white">
                        {activeStudy.summary.delta_score >= 0 ? '+' : ''}
                        {(activeStudy.summary.delta_score * 100).toFixed(1)}% so với Baseline
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-xs text-[#161616] flex flex-wrap items-center gap-2">
                    <span>
                      vector_weight=<strong>{bestTrial.config.vector_similarity_weight}</strong>
                    </span>
                    <span>·</span>
                    <span>
                      threshold=<strong>{bestTrial.config.similarity_threshold}</strong>
                    </span>
                    <span>·</span>
                    <span>
                      top_k=<strong>{bestTrial.config.top_k}</strong>
                    </span>
                    <span>·</span>
                    <span>
                      keyword=<strong>{bestTrial.config.keyword_enabled ? 'Bật' : 'Tắt'}</strong>
                    </span>
                    <span>·</span>
                    <span>
                      rerank=<strong>{bestTrial.config.rerank_id || 'Tắt'}</strong>
                    </span>
                  </div>
                  <div className="text-xs text-[#3d3d3d] font-mono">
                    Objective: <strong>{pct(bestTrial.objective_score)}</strong> · Precision:{' '}
                    <strong>{pct(bestTrial.avg_cp)}</strong> · Coverage: <strong>{pct(bestTrial.avg_cc)}</strong> · MRR:{' '}
                    <strong>{pct(bestTrial.avg_mrr)}</strong> · Latency: <strong>{Math.round(bestTrial.avg_latency_ms)}ms</strong>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={applyingTrialId !== null}
                    onClick={() => handleApplyTrial(bestTrial)}
                    className="ts-btn-primary text-xs"
                  >
                    <CheckCircle2 className="size-3.5 text-[#03aa5c]" />
                    Áp dụng vào Run
                  </button>
                  {onOpenRetrieval && (
                    <button type="button" onClick={onOpenRetrieval} className="ts-btn-secondary text-xs">
                      <Sparkles className="size-3.5 text-[#03aa5c]" />
                      Mở tab Retrieval
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Pareto Frontier & Sensitivity */}
            {trials.length > 0 && (
              <ParetoScatterChart
                trials={trials}
                sensitivity={activeStudy?.summary?.sensitivity || []}
                bestTrialId={activeStudy?.best_trial_id ?? null}
              />
            )}

            {/* Trials Leaderboard */}
            {trials.length > 0 && (
              <div className="border border-[#e4e4e2] rounded-lg bg-white overflow-hidden shadow-2xs">
                <div className="px-5 py-3 border-b border-[#e4e4e2] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="ts-eyebrow">BẢNG XẾP HẠNG TẤT CẢ TỔ HỢP ({visibleTrials.length})</div>
                  </div>
                  <div className="inline-flex border border-[#dedede] rounded bg-white p-0.5 text-[11px]">
                    {[
                      { id: 'all', label: 'Tất cả' },
                      { id: 'full', label: 'Vòng 2 (100%)' },
                      { id: 'pareto', label: 'Biên Pareto' },
                    ].map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setTrialFilter(f.id as any)}
                        className={`px-2.5 py-0.5 rounded-[2px] ${
                          trialFilter === f.id ? 'bg-[#161616] text-white font-medium' : 'text-[#52525b]'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-[#e4e4e2] bg-[#f7f7f6] font-mono text-[10px] uppercase text-[#52525b]">
                        <th className="py-2 px-3">Trial</th>
                        <th className="py-2 px-3">Vòng</th>
                        <th className="py-2 px-3">Cấu hình Retrieval</th>
                        <th className="py-2 px-2.5 text-right">Objective</th>
                        <th className="py-2 px-2.5 text-right">Precision</th>
                        <th className="py-2 px-2.5 text-right">Coverage</th>
                        <th className="py-2 px-2.5 text-right">MRR</th>
                        <th className="py-2 px-2.5 text-right">Hit@3</th>
                        <th className="py-2 px-2.5 text-right">Latency</th>
                        <th className="py-2 px-3 text-right">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#ededeb] font-mono text-[11px]">
                      {visibleTrials.map((t) => {
                        const isBest = t.id === activeStudy?.best_trial_id;
                        return (
                          <tr
                            key={t.id}
                            className={isBest ? 'bg-[#f2fbf6]' : 'hover:bg-[#fafaf9]'}
                          >
                            <td className="py-2 px-3 font-semibold text-[#161616]">
                              <div className="flex items-center gap-1.5">
                                <span>#{t.trial_index}</span>
                                {t.trial_index === 1 && (
                                  <span className="text-[9px] px-1 py-0.5 bg-[#161616] text-white rounded-[2px]">
                                    BASE
                                  </span>
                                )}
                                {t.is_pareto && (
                                  <span className="text-[9px] px-1 py-0.5 bg-[#03aa5c]/15 text-[#027a42] border border-[#03aa5c]/40 rounded-[2px]">
                                    PARETO
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="py-2 px-3 text-[#52525b]">
                              {t.stage === '2_FULL' ? `Full (${t.testcase_count})` : `Sàng lọc (${t.testcase_count})`}
                            </td>
                            <td className="py-2 px-3 text-[#161616]">
                              vw={t.config.vector_similarity_weight} · th={t.config.similarity_threshold} · k={t.config.top_k} ·{' '}
                              {t.config.keyword_enabled ? 'BM25' : 'No-KW'}
                              {t.config.rerank_id ? ` · ${t.config.rerank_id}` : ''}
                            </td>
                            <td className="py-2 px-2.5 text-right font-semibold text-[#027a42]">
                              {pct(t.objective_score)}
                            </td>
                            <td className="py-2 px-2.5 text-right">{pct(t.avg_cp)}</td>
                            <td className="py-2 px-2.5 text-right">{pct(t.avg_cc)}</td>
                            <td className="py-2 px-2.5 text-right">{pct(t.avg_mrr)}</td>
                            <td className="py-2 px-2.5 text-right">{pct(t.hit_at_3)}</td>
                            <td className="py-2 px-2.5 text-right text-[#52525b]">{Math.round(t.avg_latency_ms)}ms</td>
                            <td className="py-2 px-3 text-right">
                              <button
                                type="button"
                                disabled={applyingTrialId !== null}
                                onClick={() => handleApplyTrial(t)}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[#dedede] bg-white hover:border-[#161616] text-[10.5px] font-sans font-medium text-[#161616]"
                              >
                                <Sliders className="size-3" />
                                Áp dụng
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
