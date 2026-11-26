import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckSquare,
  FlaskConical,
  GitBranch,
  Layers,
  Loader2,
  Play,
  Plus,
  Square,
  Trash2,
  Trophy,
} from 'lucide-react';
import { api } from '../api/client';
import { CanaryVariantDef, OptimizationStudy, OptimizationTrial, RunItem } from '../types';

interface Props {
  activeRun: RunItem;
  onReloadRuns: (preferredRunId?: number) => void;
  onSelectRun: (run: RunItem) => void;
  injectedVariants?: CanaryVariantDef[];
}

interface CanaryDocCandidate {
  id: number;
  doc_code: string;
  filename: string;
  format_group: string;
  page_count: number;
  chunk_count: number;
  golden_tc_count: number;
  difficulty_score: number;
  reasons: string[];
  recommended: boolean;
}

const pct = (v?: number | null) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);

export const CanaryTunerPanel: React.FC<Props> = ({
  activeRun,
  onReloadRuns,
  onSelectRun,
  injectedVariants = [],
}) => {
  const [loadingInit, setLoadingInit] = useState(false);
  const [docCandidates, setDocCandidates] = useState<CanaryDocCandidate[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<number[]>([]);
  const [variants, setVariants] = useState<CanaryVariantDef[]>([]);
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>([]);
  const [totalGolden, setTotalGolden] = useState(0);

  // Custom variant quick builder
  const [showAddVar, setShowAddVar] = useState(false);
  const [customName, setCustomName] = useState('Custom Variant');
  const [customMethod, setCustomMethod] = useState('general');
  const [customPdfParser, setCustomPdfParser] = useState('DeepDOC');
  const [customChunkSize, setCustomChunkSize] = useState(768);
  const [customOverlap, setCustomOverlap] = useState(12);
  const [customParentChild, setCustomParentChild] = useState(false);

  // Execution options
  const [studyName, setStudyName] = useState('Canary Index-Time Tuner');
  const [objectiveProfile, setObjectiveProfile] = useState<'balanced' | 'high_precision' | 'high_recall' | 'low_latency'>('balanced');
  const [judgeEngine, setJudgeEngine] = useState<'rule' | 'jev' | 'llm'>('rule');
  const [rerankId, setRerankId] = useState('');
  const [cleanupSandbox, setCleanupSandbox] = useState(true);

  // Studies state
  const [studies, setStudies] = useState<OptimizationStudy[]>([]);
  const [activeStudy, setActiveStudy] = useState<OptimizationStudy | null>(null);
  const [trials, setTrials] = useState<OptimizationTrial[]>([]);
  const [starting, setStarting] = useState(false);
  const [forking, setForking] = useState(false);
  const pollRef = useRef<number | null>(null);

  const loadAll = async (preferredStudyId?: number) => {
    setLoadingInit(true);
    try {
      const [candRes, studyList] = await Promise.all([
        api.getCanaryCandidates(activeRun.id, 4),
        api.listOptimizationStudies(activeRun.id),
      ]);
      setDocCandidates(candRes.documents || []);
      setSelectedDocIds(candRes.recommended_doc_ids || []);
      const baseVars: CanaryVariantDef[] = candRes.variants || [];
      const mergedVars = [...baseVars];
      for (const iv of injectedVariants) {
        if (!mergedVars.some((v) => v.id === iv.id)) {
          mergedVars.push(iv);
        }
      }
      setVariants(mergedVars);
      setSelectedVariantIds(mergedVars.map((v) => v.id));
      setTotalGolden(candRes.total_golden_testcases || 0);

      const canaryStudies = (studyList || []).filter((s: OptimizationStudy) => s.study_type === 'CANARY_INDEX');
      setStudies(canaryStudies);
      const targetId = preferredStudyId ?? canaryStudies[0]?.id;
      if (targetId) {
        const detail = await api.getOptimizationStudy(targetId);
        setActiveStudy(detail.study);
        setTrials(detail.trials || []);
      } else {
        setActiveStudy(null);
        setTrials([]);
      }
    } catch (e: any) {
      toast.error(e.message || 'Không tải được dữ liệu Canary Tuner');
    } finally {
      setLoadingInit(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [activeRun.id]);

  useEffect(() => {
    if (!injectedVariants.length) return;
    setVariants((prev) => {
      const next = [...prev];
      for (const iv of injectedVariants) {
        if (!next.some((v) => v.id === iv.id)) {
          next.push(iv);
        }
      }
      return next;
    });
    setSelectedVariantIds((prev) => {
      const s = new Set(prev);
      for (const iv of injectedVariants) s.add(iv.id);
      return Array.from(s);
    });
  }, [injectedVariants]);

  useEffect(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!activeStudy || activeStudy.status !== 'RUNNING') return;

    pollRef.current = window.setInterval(async () => {
      try {
        const detail = await api.getOptimizationStudy(activeStudy.id);
        setActiveStudy(detail.study);
        setTrials(detail.trials || []);
        if (detail.study.status !== 'RUNNING') {
          if (pollRef.current) window.clearInterval(pollRef.current);
          loadAll(detail.study.id);
          if (detail.study.status === 'COMPLETED') {
            toast.success(`Canary Tuner hoàn tất! Công thức tốt nhất: ${detail.study.summary?.best_variant_name || ''}`);
          } else if (detail.study.status === 'FAILED') {
            toast.error(`Canary Tuner lỗi: ${detail.study.error_message}`);
          }
        }
      } catch {
        // ignore transient polling error
      }
    }, 2000);

    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [activeStudy?.id, activeStudy?.status]);

  const toggleDoc = (id: number) => {
    setSelectedDocIds((prev) =>
      prev.includes(id) ? (prev.length > 1 ? prev.filter((x) => x !== id) : prev) : prev.length < 6 ? [...prev, id] : prev
    );
  };

  const toggleVariant = (id: string) => {
    setSelectedVariantIds((prev) =>
      prev.includes(id) ? (prev.length > 1 ? prev.filter((x) => x !== id) : prev) : [...prev, id]
    );
  };

  const handleAddCustomVariant = (e: React.FormEvent) => {
    e.preventDefault();
    const id = `custom_${Date.now()}`;
    const patch: Record<string, any> = {
      chunk_method: customMethod,
      pdf_parse_method: customPdfParser,
      chunk_token_size: Number(customChunkSize) || 768,
      overlapped_percent: Number(customOverlap) || 0,
      use_parent_child: customParentChild,
    };
    const nextVar: CanaryVariantDef = {
      id,
      name: customName.trim() || `Custom ${customChunkSize}`,
      description: `${customMethod} · ${customPdfParser} · ${customChunkSize} tok · ovl ${customOverlap}%${customParentChild ? ' · Parent-Child' : ''}`,
      index_patch: patch,
      is_baseline: false,
    };
    setVariants((prev) => [...prev, nextVar]);
    setSelectedVariantIds((prev) => [...prev, id]);
    setShowAddVar(false);
  };

  const handleStartCanary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (starting) return;
    const pickedVariants = variants.filter((v) => selectedVariantIds.includes(v.id));
    if (selectedDocIds.length === 0 || pickedVariants.length === 0) {
      toast.error('Hãy chọn ít nhất 1 tài liệu Canary và 1 biến thể cấu hình.');
      return;
    }
    setStarting(true);
    try {
      const res = await api.startCanarySweep(activeRun.id, {
        name: studyName.trim() || 'Canary Index-Time Tuner',
        doc_ids: selectedDocIds,
        variants: pickedVariants,
        objective_profile: objectiveProfile,
        judge_engine: judgeEngine,
        rerank_id: rerankId.trim(),
        cleanup_sandbox: cleanupSandbox,
      });
      const detail = await api.getOptimizationStudy(res.study_id);
      setActiveStudy(detail.study);
      setTrials(detail.trials || []);
      setStudies((prev) => [detail.study, ...prev]);
      toast.success(`Đã khởi chạy Canary Tuner cho ${pickedVariants.length} biến thể trên ${selectedDocIds.length} file!`);
    } catch (err: any) {
      toast.error(err.message || 'Không khởi chạy được Canary Tuner');
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!activeStudy) return;
    await api.cancelOptimizationStudy(activeStudy.id);
    toast.info('Đang dừng Canary Tuner & dọn sandbox...');
  };

  const handleDeleteStudy = async (id: number) => {
    await api.deleteOptimizationStudy(id);
    await loadAll();
    toast.success('Đã xóa phiên Canary.');
  };

  const handleForkJointRecipe = async (indexPatch: Record<string, any>, retrievalPatch: Record<string, any>, label: string) => {
    if (forking) return;
    setForking(true);
    try {
      const res = await api.applyRecommendedConfig(activeRun.id, {
        index_patch: indexPatch,
        retrieval_patch: retrievalPatch,
        sync_remote: true,
        fork_new_run: true,
        new_run_name: `${activeRun.name} · ${label}`,
      });
      if (res.run) {
        onSelectRun(res.run);
        await onReloadRuns(res.run.id);
        toast.success(
          res.remote_synced
            ? `Đã tạo Dataset & Run Full "${res.run.name}" trên RAGFlow! Hãy sang Bước 1 để đẩy toàn bộ tài liệu.`
            : `Đã tạo Run local "${res.run.name}" (${res.remote_warning || 'chưa đồng bộ RAGFlow'}).`
        );
      }
    } catch (e: any) {
      toast.error(e.message || 'Không tạo được Run mới');
    } finally {
      setForking(false);
    }
  };

  const bestTrial = useMemo(() => {
    if (!activeStudy?.best_trial_id) return null;
    return trials.find((t) => t.id === activeStudy.best_trial_id) || null;
  }, [trials, activeStudy?.best_trial_id]);

  if (loadingInit && docCandidates.length === 0) {
    return (
      <div className="p-10 text-center text-xs text-[#71717a] border border-[#e4e4e2] rounded-lg bg-white">
        Đang chọn tập tài liệu Canary đại diện &amp; sinh các biến thể Index...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleStartCanary} className="space-y-5">
        {/* 1. Canary Documents Selector */}
        <div className="border border-[#e4e4e2] rounded-lg bg-white p-5 space-y-4 shadow-2xs">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#ededeb]">
            <div>
              <div className="ts-eyebrow">BƯỚC 1 · TẬP TÀI LIỆU CANARY (CHỈ TEST TRÊN FILE ĐẠI DIỆN &amp; KHÓ NHẤT)</div>
              <p className="text-xs text-[#71717a] mt-0.5">
                Hệ thống tự chọn sẵn {selectedDocIds.length} tài liệu đại diện (tối đa 6 file) để thử nghiệm Parsing + Chunking siêu nhanh trước khi nhân rộng toàn bộ corpus ({totalGolden} câu Golden sẵn có).
              </p>
            </div>
            <span className="font-mono text-xs px-2.5 py-1 rounded bg-[#f2fbf6] border border-[#03aa5c]/35 text-[#027a42] font-semibold">
              Đã chọn {selectedDocIds.length}/{docCandidates.length} file
            </span>
          </div>

          {docCandidates.length === 0 ? (
            <div className="p-4 text-xs text-[#71717a] bg-[#fafaf9] border border-dashed border-[#dedede] rounded text-center">
              Run này chưa có tài liệu nào. Hãy đồng bộ tài liệu ở Bước 1 trước.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 max-h-64 overflow-y-auto pr-1">
              {docCandidates.map((d) => {
                const checked = selectedDocIds.includes(d.id);
                return (
                  <label
                    key={d.id}
                    className={`p-3 rounded border text-xs cursor-pointer flex items-start gap-2.5 transition-colors ${
                      checked ? 'border-[#03aa5c] bg-[#f2fbf6]/60' : 'border-[#ededeb] bg-[#fafaf9] hover:border-[#d4d4d8]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleDoc(d.id)}
                      className="mt-0.5 size-4 accent-[#03aa5c] shrink-0"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-[#161616] truncate">
                          {d.doc_code} · {d.filename}
                        </span>
                        {d.recommended && (
                          <span className="font-mono text-[9px] px-1.5 py-0.5 bg-[#161616] text-white rounded-[2px] shrink-0">
                            GỢI Ý
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] font-mono text-[#71717a]">
                        <span>{d.format_group}</span>
                        <span>·</span>
                        <span>{d.chunk_count}c</span>
                        <span>·</span>
                        <span>Độ khó: {d.difficulty_score}</span>
                      </div>
                      {d.reasons.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {d.reasons.map((r, i) => (
                            <span
                              key={i}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-white border border-[#e4e4e2] text-[#3d3d3d]"
                            >
                              {r}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* 2. Candidate Index Variants */}
        <div className="border border-[#e4e4e2] rounded-lg bg-white p-5 space-y-4 shadow-2xs">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#ededeb]">
            <div>
              <div className="ts-eyebrow">BƯỚC 2 · CÁC BIẾN THỂ PARSING &amp; CHUNKING CẦN ĐỐI CHỨNG</div>
              <p className="text-xs text-[#71717a] mt-0.5">
                Mỗi biến thể sẽ tạo 1 sandbox dataset tạm trên RAGFlow, parse tập Canary và chạy thử Retrieval để tìm Joint Recipe tối ưu
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAddVar((v) => !v)}
              className="ts-btn-secondary text-xs"
            >
              <Plus className="size-3.5" />
              Thêm biến thể tùy chỉnh
            </button>
          </div>

          {showAddVar && (
            <div className="p-4 rounded border border-[#dedede] bg-[#fafaf9] space-y-3 text-xs">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
                <div>
                  <label className="block text-[11px] text-[#52525b] mb-1">Tên biến thể</label>
                  <input className="ts-input w-full text-xs" value={customName} onChange={(e) => setCustomName(e.target.value)} />
                </div>
                <div>
                  <label className="block text-[11px] text-[#52525b] mb-1">Chunk Method</label>
                  <select className="ts-input w-full text-xs" value={customMethod} onChange={(e) => setCustomMethod(e.target.value)}>
                    <option value="general">general</option>
                    <option value="laws">laws</option>
                    <option value="manual">manual</option>
                    <option value="paper">paper</option>
                    <option value="table">table</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-[#52525b] mb-1">PDF Parser</label>
                  <select className="ts-input w-full text-xs" value={customPdfParser} onChange={(e) => setCustomPdfParser(e.target.value)}>
                    <option value="DeepDOC">DeepDOC</option>
                    <option value="MinerU">MinerU</option>
                    <option value="Plain Text">Plain Text</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-[#52525b] mb-1">Chunk Token Size</label>
                  <input type="number" min={128} max={2048} step={64} className="ts-input w-full font-mono text-xs" value={customChunkSize} onChange={(e) => setCustomChunkSize(Number(e.target.value))} />
                </div>
                <div>
                  <label className="block text-[11px] text-[#52525b] mb-1">Overlap (%)</label>
                  <input type="number" min={0} max={40} className="ts-input w-full font-mono text-xs" value={customOverlap} onChange={(e) => setCustomOverlap(Number(e.target.value))} />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input type="checkbox" checked={customParentChild} onChange={(e) => setCustomParentChild(e.target.checked)} className="accent-[#03aa5c]" />
                  Bật Parent-Child Chunking
                </label>
                <button type="button" onClick={handleAddCustomVariant} className="ts-btn-primary text-xs py-1">
                  Thêm vào danh sách test
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {variants.map((v) => {
              const on = selectedVariantIds.includes(v.id);
              return (
                <label
                  key={v.id}
                  className={`p-3.5 rounded border text-xs cursor-pointer flex items-start gap-2.5 transition-colors ${
                    on ? 'border-[#161616] bg-[#fafaf9]' : 'border-[#ededeb] bg-white opacity-70'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggleVariant(v.id)}
                    className="mt-0.5 size-4 accent-[#03aa5c] shrink-0"
                  />
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[#161616]">{v.name}</span>
                      {v.is_baseline && (
                        <span className="font-mono text-[9px] px-1.5 py-0.5 bg-[#161616] text-white rounded-[2px]">
                          BASELINE
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-[#52525b] leading-relaxed">{v.description}</p>
                    {Object.keys(v.index_patch || {}).length > 0 && (
                      <div className="font-mono text-[10px] text-[#027a42] bg-[#f2fbf6] px-2 py-1 rounded border border-[#03aa5c]/30">
                        {Object.entries(v.index_patch)
                          .map(([k, val]) => `${k}=${String(val)}`)
                          .join(' · ')}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>

          {/* Controls */}
          <div className="pt-3 border-t border-[#ededeb] grid grid-cols-1 md:grid-cols-4 gap-3 text-xs items-end">
            <div>
              <label className="block font-medium text-[#161616] mb-1">Tên phiên Canary</label>
              <input className="ts-input w-full text-xs" value={studyName} onChange={(e) => setStudyName(e.target.value)} />
            </div>
            <div>
              <label className="block font-medium text-[#161616] mb-1">Mục tiêu &amp; Judge</label>
              <div className="flex gap-1.5">
                <select className="ts-input flex-1 text-xs" value={objectiveProfile} onChange={(e) => setObjectiveProfile(e.target.value as any)}>
                  <option value="balanced">Cân bằng</option>
                  <option value="high_precision">Chính xác cao</option>
                  <option value="high_recall">Bao phủ rộng</option>
                  <option value="low_latency">Tốc độ</option>
                </select>
                <select className="ts-input w-24 text-xs" value={judgeEngine} onChange={(e) => setJudgeEngine(e.target.value as any)}>
                  <option value="rule">Rule</option>
                  <option value="jev">Jev</option>
                  <option value="llm">LLM</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block font-medium text-[#161616] mb-1">Thử kèm Rerank (tùy chọn)</label>
              <input
                className="ts-input w-full font-mono text-xs"
                placeholder="BAAI/bge-reranker-v2-m3"
                value={rerankId}
                onChange={(e) => setRerankId(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-[11px] text-[#3d3d3d] cursor-pointer">
                <input
                  type="checkbox"
                  checked={cleanupSandbox}
                  onChange={(e) => setCleanupSandbox(e.target.checked)}
                  className="accent-[#03aa5c]"
                />
                Tự xóa sandbox
              </label>

              {activeStudy?.status === 'RUNNING' ? (
                <button
                  type="button"
                  onClick={handleCancel}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[#cf222e] text-white"
                >
                  <Square className="size-3.5" />
                  Dừng
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={starting || !activeRun.ragflow_dataset_id || selectedDocIds.length === 0}
                  className="ts-btn-primary text-xs"
                >
                  {starting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 text-[#03aa5c]" />}
                  Chạy Canary Tuner
                </button>
              )}
            </div>
          </div>
        </div>
      </form>

      {/* Canary Study History & Live Progress */}
      {studies.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border border-[#e4e4e2] rounded-lg bg-[#fafaf9]">
          <div className="flex items-center gap-2 text-xs">
            <span className="ts-eyebrow">PHIÊN CANARY:</span>
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
                title="Xóa phiên Canary này"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>

          {activeStudy && (
            <div className="flex items-center gap-2.5 text-xs font-mono">
              {activeStudy.status === 'RUNNING' && <Loader2 className="size-3.5 animate-spin text-[#03aa5c]" />}
              <span className="text-[#52525b]">{activeStudy.stage_label}</span>
              <span className="font-semibold text-[#161616]">
                {activeStudy.progress_done}/{activeStudy.progress_total}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Winning Joint Recipe Banner */}
      {activeStudy?.status === 'COMPLETED' && bestTrial && (
        <div className="border-2 border-[#03aa5c] rounded-lg bg-[#f2fbf6] p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center gap-2">
              <Trophy className="size-4 text-[#027a42]" />
              <span className="ts-eyebrow text-[#027a42]">CÔNG THỨC KÉP THẮNG CUỘC (WINNING JOINT RECIPE)</span>
              {typeof activeStudy.summary?.delta_score === 'number' && (
                <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded-full bg-[#03aa5c] text-white">
                  {activeStudy.summary.delta_score >= 0 ? '+' : ''}
                  {(activeStudy.summary.delta_score * 100).toFixed(1)}% Joint Score
                </span>
              )}
            </div>
            <div className="text-sm font-semibold text-[#161616]">
              {activeStudy.summary?.best_variant_name || bestTrial.config?.variant_name}
            </div>
            <div className="font-mono text-[11px] text-[#3d3d3d] flex flex-wrap gap-2">
              <span>
                Index:{' '}
                <strong>
                  {Object.keys(activeStudy.summary?.best_index_patch || {}).length > 0
                    ? Object.entries(activeStudy.summary?.best_index_patch || {})
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ')
                    : 'Giữ nguyên Baseline'}
                </strong>
              </span>
              <span>|</span>
              <span>
                Retrieval:{' '}
                <strong>
                  vw={bestTrial.config?.vector_similarity_weight} · th={bestTrial.config?.similarity_threshold} · k=
                  {bestTrial.config?.top_k}
                  {bestTrial.config?.rerank_id ? ` · ${bestTrial.config.rerank_id}` : ''}
                </strong>
              </span>
            </div>
          </div>

          <button
            type="button"
            disabled={forking}
            onClick={() =>
              handleForkJointRecipe(
                activeStudy.summary?.best_index_patch || {},
                activeStudy.summary?.best_retrieval_config || {},
                String(activeStudy.summary?.best_variant_name || 'Joint Recipe').slice(0, 24)
              )
            }
            className="ts-btn-primary text-xs shrink-0"
          >
            <GitBranch className="size-3.5 text-[#03aa5c]" />
            {forking ? 'Đang tạo Dataset Full...' : 'Tạo Dataset Full với công thức này'}
          </button>
        </div>
      )}

      {/* 3-Layer Comparison Matrix */}
      {trials.length > 0 && (
        <div className="border border-[#e4e4e2] rounded-lg bg-white overflow-hidden shadow-2xs">
          <div className="px-5 py-3 border-b border-[#e4e4e2] bg-[#fafaf9] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="size-4 text-[#03aa5c]" />
              <div className="ts-eyebrow">MA TRẬN SO SÁNH 3 TẦNG TRÊN TẬP CANARY ({trials.length} BIẾN THỂ)</div>
            </div>
            <span className="font-mono text-[11px] text-[#71717a]">
              Joint = 25% Parsing + 25% Chunking + 50% Retrieval
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#e4e4e2] bg-[#f7f7f6] font-mono text-[10px] uppercase text-[#52525b]">
                  <th className="py-2.5 px-3">Biến thể Index</th>
                  <th className="py-2.5 px-2.5 text-right">Chunks</th>
                  <th className="py-2.5 px-2.5 text-right">Parse Sim</th>
                  <th className="py-2.5 px-2.5 text-right">Chunk Int.</th>
                  <th className="py-2.5 px-2.5 text-right">Ret. Precision</th>
                  <th className="py-2.5 px-2.5 text-right">Ret. Coverage</th>
                  <th className="py-2.5 px-2.5 text-right">Parse Time</th>
                  <th className="py-2.5 px-2.5 text-right">Joint Score</th>
                  <th className="py-2.5 px-3 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#ededeb] font-mono text-[11px]">
                {trials.map((t) => {
                  const m = t.metrics || {};
                  const p = m.parsing || {};
                  const c = m.chunking || {};
                  const isBest = t.id === activeStudy?.best_trial_id;
                  return (
                    <tr key={t.id} className={isBest ? 'bg-[#f2fbf6]' : 'hover:bg-[#fafaf9]'}>
                      <td className="py-2.5 px-3 font-sans">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-[#161616]">{t.config?.variant_name}</span>
                          {t.config?.is_baseline && (
                            <span className="font-mono text-[9px] px-1 py-0.5 bg-[#161616] text-white rounded-[2px]">
                              BASE
                            </span>
                          )}
                          {isBest && (
                            <span className="font-mono text-[9px] px-1 py-0.5 bg-[#03aa5c] text-white rounded-[2px]">
                              BEST
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[10px] text-[#71717a] mt-0.5">
                          Ret: vw={t.config?.vector_similarity_weight} · th={t.config?.similarity_threshold} · k=
                          {t.config?.top_k}
                        </div>
                      </td>
                      <td className="py-2.5 px-2.5 text-right">{c.chunk_count ?? '—'}</td>
                      <td className="py-2.5 px-2.5 text-right">{pct(p.avg_similarity)}</td>
                      <td className="py-2.5 px-2.5 text-right">{pct(c.chunk_integrity)}</td>
                      <td className="py-2.5 px-2.5 text-right">{pct(t.avg_cp)}</td>
                      <td className="py-2.5 px-2.5 text-right">{pct(t.avg_cc)}</td>
                      <td className="py-2.5 px-2.5 text-right text-[#71717a]">
                        {m.parse_duration_sec ? `${m.parse_duration_sec}s` : '—'}
                      </td>
                      <td className="py-2.5 px-2.5 text-right font-semibold text-[#027a42]">
                        {pct(t.objective_score)}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <button
                          type="button"
                          disabled={forking}
                          onClick={() =>
                            handleForkJointRecipe(
                              t.config?.index_patch || {},
                              m.best_retrieval_config || {},
                              String(t.config?.variant_name || `V${t.trial_index}`).slice(0, 22)
                            )
                          }
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[#dedede] bg-white hover:border-[#161616] font-sans text-[10.5px] font-medium text-[#161616]"
                        >
                          <FlaskConical className="size-3 text-[#03aa5c]" />
                          Fork Full
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
  );
};
