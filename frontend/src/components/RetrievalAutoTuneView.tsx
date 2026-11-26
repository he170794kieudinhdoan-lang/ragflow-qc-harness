import React, { useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { toast } from 'sonner';
import {
  AlertTriangle,
  BookmarkPlus,
  Check,
  Copy,
  Play,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { api } from '../api/client';
import { TrackedOperationOptions } from './FloatingProgressOverlay';
import { RunItem } from '../types';

export interface AutoTuneTrial {
  rank: number;
  vector_similarity_weight: number;
  similarity_threshold: number;
  top_k: number;
  rerank_id: string;
  hit_rate: number;
  mrr: number;
  ndcg: number;
  precision: number;
  empty_rate: number;
  composite: number;
  avg_latency_ms: number;
}

interface BaselineSummary {
  retrieval_run_id: number;
  name: string;
  top_k: number;
  similarity_threshold: number;
  vector_similarity_weight: number;
  rerank_id: string;
  hit_rate: number;
  mrr: number;
  ndcg: number;
  precision: number;
  composite: number;
}

interface AutoTuneResponse {
  ok: boolean;
  objective: string;
  judge_engine: string;
  updated_at?: string;
  best_config: AutoTuneTrial | null;
  baseline_summary: BaselineSummary | null;
  trials: AutoTuneTrial[];
  grid_axes: {
    vector_weights: number[];
    thresholds: number[];
    top_ks: number[];
    rerank_ids: string[];
  };
  stats: {
    total_combinations: number;
    ragflow_fetch_groups: number;
    saved_fetch_ratio: number;
    total_testcases: number;
    cache_hit_rate: number;
    llm_calls: number;
    elapsed_sec: number;
    overfit_warning: boolean;
    demo?: boolean;
  };
}

interface Props {
  activeRun: RunItem;
  testcaseCount: number;
  rerankModels: { id: string; name: string; label: string }[];
  runTracked: <T>(opts: TrackedOperationOptions, fn: () => Promise<T>) => Promise<T>;
  onSaveConfigAsRun: (cfg: AutoTuneTrial) => Promise<void>;
}

const WEIGHT_OPTIONS = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const THRESHOLD_OPTIONS = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7];
const TOPK_OPTIONS = [1, 3, 5, 8, 10, 12, 15, 20];

const OBJECTIVE_LABELS: Record<string, string> = {
  composite: 'Tổng hợp',
  mrr: 'MRR',
  hit_rate: 'Hit@K',
  ndcg: 'NDCG@K',
  precision: 'Precision',
};

function shortRerankName(id: string): string {
  if (!id) return 'Không Rerank';
  return id.split('@')[0];
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtScore(v: number): string {
  return v.toFixed(3);
}

/** GSAP-tweened metric readout */
const TweenNumber: React.FC<{ value: number; format: 'pct' | 'dec'; className?: string }> = ({
  value,
  format,
  className = '',
}) => {
  const [shown, setShown] = useState(0);
  const objRef = useRef({ v: 0 });

  useEffect(() => {
    const tween = gsap.to(objRef.current, {
      v: value,
      duration: 0.65,
      ease: 'power3.out',
      onUpdate: () => setShown(objRef.current.v),
    });
    return () => {
      tween.kill();
    };
  }, [value]);

  return <span className={className}>{format === 'pct' ? fmtPct(shown) : fmtScore(shown)}</span>;
};

/** Subtle GSAP-animated geometric Grid-Search SVG for empty state */
const GridSearchHeroSvg: React.FC = () => {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current) return;
    const ctx = gsap.context(() => {
      const cells = svgRef.current!.querySelectorAll('.gs-cell');
      gsap.fromTo(
        cells,
        { opacity: 0.28, scale: 0.92, transformOrigin: 'center center' },
        {
          opacity: 1,
          scale: 1,
          duration: 0.7,
          stagger: { amount: 0.9, from: 'start', repeat: -1, yoyo: true },
          ease: 'sine.inOut',
        }
      );
      const ring = svgRef.current!.querySelector('.gs-ring');
      if (ring) {
        gsap.to(ring, {
          scale: 1.08,
          opacity: 0.55,
          transformOrigin: 'center center',
          duration: 1.1,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut',
        });
      }
    }, svgRef);
    return () => ctx.revert();
  }, []);

  const coords = [
    [18, 18, '#e4e4e7'],
    [42, 18, '#bbf7d0'],
    [66, 18, '#e4e4e7'],
    [18, 42, '#bbf7d0'],
    [42, 42, '#03aa5c'],
    [66, 42, '#86efac'],
    [18, 66, '#f4f4f5'],
    [42, 66, '#d4d4d8'],
    [66, 66, '#e4e4e7'],
  ] as const;

  return (
    <svg ref={svgRef} viewBox="0 0 100 100" className="size-20 mx-auto" fill="none" aria-hidden="true">
      {/* Subtle architectural axes */}
      <line x1="10" y1="88" x2="90" y2="88" stroke="#d4d4d8" strokeWidth="1.2" />
      <line x1="10" y1="12" x2="10" y2="88" stroke="#d4d4d8" strokeWidth="1.2" />
      {coords.map(([x, y, fill], i) => (
        <rect
          key={i}
          className="gs-cell"
          x={x}
          y={y}
          width="18"
          height="18"
          rx="2.5"
          fill={fill}
        />
      ))}
      <rect
        className="gs-ring"
        x="39"
        y="39"
        width="24"
        height="24"
        rx="4"
        stroke="#141414"
        strokeWidth="1.6"
      />
    </svg>
  );
};

const STORAGE_KEY_PREFIX = 'ragflow_qc_autotune_v1_';

export function clearAllAutoTuneCache() {
  try {
    for (const k of Object.keys(window.localStorage)) {
      if (k.startsWith(STORAGE_KEY_PREFIX)) window.localStorage.removeItem(k);
    }
  } catch {
    // ignore storage errors
  }
}

export function clearAutoTuneCacheForRun(runId: number) {
  try {
    window.localStorage.removeItem(`${STORAGE_KEY_PREFIX}${runId}`);
  } catch {
    // ignore storage errors
  }
}

interface PersistedAutoTuneState {
  preset?: 'fast' | 'deep' | 'full' | 'custom';
  weights?: number[];
  thresholds?: number[];
  topKs?: number[];
  rerankIds?: string[];
  objective?: 'composite' | 'mrr' | 'hit_rate' | 'ndcg';
  judgeEngine?: 'llm' | 'rule';
  result?: AutoTuneResponse | null;
}

function readLocalAutoTune(runId: number): PersistedAutoTuneState | null {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${runId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLocalAutoTune(runId: number, data: PersistedAutoTuneState) {
  try {
    window.localStorage.setItem(`${STORAGE_KEY_PREFIX}${runId}`, JSON.stringify(data));
  } catch {
    // Ignore storage quota errors
  }
}

export const RetrievalAutoTuneView: React.FC<Props> = ({
  activeRun,
  testcaseCount,
  rerankModels,
  runTracked,
  onSaveConfigAsRun,
}) => {
  const initialSaved = useMemo(() => readLocalAutoTune(activeRun.id), [activeRun.id]);

  const [preset, setPreset] = useState<'fast' | 'deep' | 'full' | 'custom'>(() => initialSaved?.preset ?? 'fast');
  const [weights, setWeights] = useState<number[]>(() =>
    initialSaved?.weights?.length ? initialSaved.weights : [0.3, 0.5, 0.7]
  );
  const [thresholds, setThresholds] = useState<number[]>(() =>
    initialSaved?.thresholds?.length ? initialSaved.thresholds : [0.15, 0.25, 0.35]
  );
  const [topKs, setTopKs] = useState<number[]>(() => (initialSaved?.topKs?.length ? initialSaved.topKs : [5, 10]));
  const [rerankIds, setRerankIds] = useState<string[]>(() =>
    initialSaved?.rerankIds?.length ? initialSaved.rerankIds : ['']
  );
  const [objective, setObjective] = useState<'composite' | 'mrr' | 'hit_rate' | 'ndcg'>(
    () => initialSaved?.objective ?? 'composite'
  );
  const [judgeEngine, setJudgeEngine] = useState<'llm' | 'rule'>(() => initialSaved?.judgeEngine ?? 'llm');

  const [customWeight, setCustomWeight] = useState('');
  const [customThreshold, setCustomThreshold] = useState('');
  const [customTopK, setCustomTopK] = useState('');

  const [running, setRunning] = useState(false);
  const [savingRank, setSavingRank] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const [result, setResult] = useState<AutoTuneResponse | null>(() => initialSaved?.result ?? null);
  const [localReranks, setLocalReranks] = useState<{ id: string; name: string; label: string }[]>(rerankModels);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (rerankModels.length > 0) {
      setLocalReranks(rerankModels);
      return;
    }
    api
      .listRagflowRerankModels()
      .then((list) => {
        if (!cancelled && Array.isArray(list) && list.length > 0) setLocalReranks(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rerankModels]);

  // Active slice for 2D Heatmap when multiple top_ks or rerank_ids exist
  const [hmTopK, setHmTopK] = useState<number>(initialSaved?.result?.best_config?.top_k ?? 10);
  const [hmRerank, setHmRerank] = useState<string>(initialSaved?.result?.best_config?.rerank_id ?? '');
  const [hoveredCell, setHoveredCell] = useState<AutoTuneTrial | null>(null);

  const resultsContainerRef = useRef<HTMLDivElement>(null);
  const loadedRunRef = useRef<number>(activeRun.id);
  const [syncedRunId, setSyncedRunId] = useState<number>(activeRun.id);

  // Restore saved Auto-Tune state & result whenever activeRun.id changes (instant localStorage + SQLite sync)
  useEffect(() => {
    let cancelled = false;
    loadedRunRef.current = activeRun.id;
    const cached = readLocalAutoTune(activeRun.id);

    setPreset(cached?.preset ?? 'fast');
    setWeights(cached?.weights?.length ? cached.weights : [0.3, 0.5, 0.7]);
    setThresholds(cached?.thresholds?.length ? cached.thresholds : [0.15, 0.25, 0.35]);
    setTopKs(cached?.topKs?.length ? cached.topKs : [5, 10]);
    setRerankIds(cached?.rerankIds?.length ? cached.rerankIds : ['']);
    setObjective(cached?.objective ?? 'composite');
    setJudgeEngine(cached?.judgeEngine ?? 'llm');
    setResult(cached?.result ?? null);
    setHoveredCell(null);
    setSyncedRunId(activeRun.id);

    api
      .getLatestAutoTune(activeRun.id)
      .then((resp) => {
        if (cancelled || loadedRunRef.current !== activeRun.id) return;
        if (resp?.found && resp.result) {
          const cfg = resp.config || {};
          const nextWeights = Array.isArray(cfg.vector_weights) && cfg.vector_weights.length ? cfg.vector_weights : undefined;
          const nextTh = Array.isArray(cfg.thresholds) && cfg.thresholds.length ? cfg.thresholds : undefined;
          const nextK = Array.isArray(cfg.top_ks) && cfg.top_ks.length ? cfg.top_ks : undefined;
          const nextRr = Array.isArray(cfg.rerank_ids) && cfg.rerank_ids.length ? cfg.rerank_ids : undefined;
          const nextObj = cfg.objective || undefined;
          const nextEng = cfg.judge_engine === 'rule' ? 'rule' : cfg.judge_engine === 'llm' ? 'llm' : undefined;

          if (nextWeights) setWeights(nextWeights);
          if (nextTh) setThresholds(nextTh);
          if (nextK) setTopKs(nextK);
          if (nextRr) setRerankIds(nextRr);
          if (nextObj) setObjective(nextObj);
          if (nextEng) setJudgeEngine(nextEng);
          setResult(resp.result);

          writeLocalAutoTune(activeRun.id, {
            preset: cached?.preset ?? 'custom',
            weights: nextWeights ?? cached?.weights ?? [0.3, 0.5, 0.7],
            thresholds: nextTh ?? cached?.thresholds ?? [0.15, 0.25, 0.35],
            topKs: nextK ?? cached?.topKs ?? [5, 10],
            rerankIds: nextRr ?? cached?.rerankIds ?? [''],
            objective: nextObj ?? cached?.objective ?? 'composite',
            judgeEngine: nextEng ?? cached?.judgeEngine ?? 'llm',
            result: resp.result,
          });
        } else if (resp && resp.found === false) {
          // Backend has no saved Auto-Tune report for this run_id -> purge stale localStorage result (e.g. old account/demo/deleted run)
          if (cached?.result && !cached.result.stats?.demo) {
            setResult(null);
            writeLocalAutoTune(activeRun.id, { ...cached, result: null });
          } else if (cached?.result?.stats?.demo) {
            setResult(null);
            writeLocalAutoTune(activeRun.id, { ...cached, result: null });
          }
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [activeRun.id]);

  // Persist user's search-space selections + latest result to localStorage only after state is synced to activeRun.id
  useEffect(() => {
    if (syncedRunId !== activeRun.id) return;
    writeLocalAutoTune(activeRun.id, {
      preset,
      weights,
      thresholds,
      topKs,
      rerankIds,
      objective,
      judgeEngine,
      result,
    });
  }, [syncedRunId, activeRun.id, preset, weights, thresholds, topKs, rerankIds, objective, judgeEngine, result]);

  // Keep heatmap slice synced to winning config whenever a new result arrives
  useEffect(() => {
    if (result?.best_config) {
      setHmTopK(result.best_config.top_k);
      setHmRerank(result.best_config.rerank_id);
      setHoveredCell(null);
    }
  }, [result]);

  // GSAP staggered entrance when results appear
  useEffect(() => {
    if (!result || !resultsContainerRef.current) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        '.at-hero',
        { opacity: 0, y: 10 },
        { opacity: 1, y: 0, duration: 0.36, ease: 'power3.out' }
      );
      gsap.fromTo(
        '.at-cell',
        { opacity: 0, scale: 0.92 },
        { opacity: 1, scale: 1, duration: 0.3, stagger: 0.025, ease: 'power3.out', delay: 0.08 }
      );
      gsap.fromTo(
        '.at-row',
        { opacity: 0, y: 6 },
        { opacity: 1, y: 0, duration: 0.26, stagger: 0.025, ease: 'power2.out', delay: 0.14 }
      );
    }, resultsContainerRef);
    return () => ctx.revert();
  }, [result]);

  const applyPreset = (mode: 'fast' | 'deep' | 'full') => {
    setPreset(mode);
    if (mode === 'fast') {
      setWeights([0.3, 0.5, 0.7]);
      setThresholds([0.15, 0.25, 0.35]);
      setTopKs([5, 10]);
      setRerankIds(['']);
    } else if (mode === 'deep') {
      setWeights([0.1, 0.3, 0.5, 0.7, 0.9]);
      setThresholds([0.05, 0.15, 0.25, 0.35, 0.5]);
      setTopKs([3, 5, 10]);
      setRerankIds(localReranks.length > 0 ? ['', localReranks[0].id] : ['']);
    } else {
      setWeights([...WEIGHT_OPTIONS]);
      setThresholds([...THRESHOLD_OPTIONS]);
      setTopKs([3, 5, 10, 15]);
      setRerankIds(['', ...localReranks.map((r) => r.id)]);
    }
  };

  const addCustomValue = (
    raw: string,
    min: number,
    max: number,
    isInt: boolean,
    list: number[],
    setter: (next: number[]) => void,
    clear: () => void
  ) => {
    const parsed = Number(raw.replace(',', '.').trim());
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(min, Math.min(max, isInt ? Math.round(parsed) : Number(parsed.toFixed(2))));
    if (!list.includes(clamped)) {
      setPreset('custom');
      setter([...list, clamped].sort((a, b) => a - b));
    }
    clear();
  };

  const toggleNum = (list: number[], val: number, setter: (next: number[]) => void) => {
    setPreset('custom');
    if (list.includes(val)) {
      if (list.length <= 1) return;
      setter(list.filter((x) => x !== val));
    } else {
      setter([...list, val].sort((a, b) => a - b));
    }
  };

  const toggleRerank = (id: string) => {
    setPreset('custom');
    if (rerankIds.includes(id)) {
      if (rerankIds.length <= 1) return;
      setRerankIds(rerankIds.filter((x) => x !== id));
    } else {
      setRerankIds([...rerankIds, id]);
    }
  };

  const totalCombos = weights.length * thresholds.length * topKs.length * rerankIds.length;
  const fetchGroupsCount = weights.length * rerankIds.length;
  const savedRatio = (totalCombos / Math.max(1, fetchGroupsCount)).toFixed(0);

  const handleRunAutoTune = async () => {
    if (running || testcaseCount === 0) return;
    setRunning(true);
    try {
      const res: AutoTuneResponse = await runTracked(
        {
          title: `Auto-Tune (${totalCombos} tổ hợp)`,
          subtitle: `${fetchGroupsCount} lượt gọi RAGFlow · ${judgeEngine.toUpperCase()} + Cache`,
          estimatedMs: Math.max(8000, fetchGroupsCount * 6000),
        },
        () =>
          api.autoTuneRetrieval({
            run_id: activeRun.id,
            vector_weights: weights,
            thresholds,
            top_ks: topKs,
            rerank_ids: rerankIds,
            objective,
            judge_engine: judgeEngine,
          })
      );
      setResult(res);
      toast.success(
        `Đã quét ${res.stats.total_combinations} tổ hợp (${res.stats.ragflow_fetch_groups} lượt gọi · ${res.stats.elapsed_sec}s · Cache ${(res.stats.cache_hit_rate * 100).toFixed(0)}%).`
      );
    } catch (e: any) {
      toast.error(e.message || 'Auto-Tune thất bại');
    } finally {
      setRunning(false);
    }
  };

  const handleCopyJson = async (cfg: AutoTuneTrial) => {
    const payload = {
      vector_similarity_weight: cfg.vector_similarity_weight,
      similarity_threshold: cfg.similarity_threshold,
      top_k: cfg.top_k,
      rerank_id: cfg.rerank_id || null,
      keyword: true,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      toast.success('Đã copy JSON cấu hình RAGFlow');
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('Không copy được vào clipboard');
    }
  };

  const handleSave = async (cfg: AutoTuneTrial) => {
    if (savingRank !== null) return;
    setSavingRank(cfg.rank);
    try {
      await onSaveConfigAsRun(cfg);
    } finally {
      setSavingRank(null);
    }
  };

  // Heatmap lookup for active (hmTopK, hmRerank) slice
  const heatmapData = useMemo(() => {
    if (!result) return null;
    const slice = result.trials.filter((t) => t.top_k === hmTopK && t.rerank_id === hmRerank);
    const map = new Map<string, AutoTuneTrial>();
    let minVal = 1;
    let maxVal = 0;
    const objKey = (result.objective || 'composite') as keyof AutoTuneTrial;
    for (const t of slice) {
      map.set(`${t.vector_similarity_weight}|${t.similarity_threshold}`, t);
      const v = Number(t[objKey] ?? t.composite);
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    return { map, minVal, maxVal, objKey };
  }, [result, hmTopK, hmRerank]);

  const getCellStyle = (val: number, minVal: number, maxVal: number): React.CSSProperties => {
    const span = Math.max(0.02, maxVal - minVal);
    const norm = Math.max(0, Math.min(1, (val - minVal) / span));
    // Crisp editorial scale: stone-50 -> soft emerald -> saturated emerald
    const alpha = 0.06 + norm * 0.78;
    return {
      backgroundColor: `rgba(3, 170, 92, ${alpha.toFixed(3)})`,
      color: norm > 0.62 ? '#ffffff' : '#141414',
    };
  };

  const renderDelta = (curr: number, base?: number | null) => {
    if (base === undefined || base === null) return null;
    const diff = curr - base;
    if (Math.abs(diff) < 0.0005) {
      return <span className="font-mono text-[10px] text-[#a1a1aa]">0.0%</span>;
    }
    const pos = diff > 0;
    return (
      <span
        className={`font-mono text-[10.5px] font-medium tabular-nums ${
          pos ? 'text-[#027a42]' : 'text-[#cf222e]'
        }`}
      >
        {pos ? '+' : ''}
        {(diff * 100).toFixed(1)}%
      </span>
    );
  };

  const best = result?.best_config ?? null;
  const base = result?.baseline_summary ?? null;

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden bg-white">
      {/* ==================== LEFT RAIL: SEARCH SPACE ==================== */}
      <aside className="w-[316px] shrink-0 border-r border-[#e8e8e6] bg-[#fafaf9] flex flex-col overflow-y-auto">
        <div className="p-4 space-y-4 flex-1">
          {/* Header + 3 presets */}
          <div className="space-y-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#52525b] flex items-center gap-1.5">
              <SlidersHorizontal className="size-3.5 text-[#141414]" />
              Không gian quét
            </span>
            <div className="grid grid-cols-3 p-0.5 rounded-md bg-[#ededeb] text-[11px]">
              <button
                type="button"
                onClick={() => applyPreset('fast')}
                className={`py-1 rounded whitespace-nowrap transition-colors ${
                  preset === 'fast' ? 'bg-white text-[#141414] font-medium shadow-xs' : 'text-[#71717a] hover:text-[#141414]'
                }`}
              >
                Nhanh
              </button>
              <button
                type="button"
                onClick={() => applyPreset('deep')}
                className={`py-1 rounded whitespace-nowrap transition-colors ${
                  preset === 'deep' ? 'bg-white text-[#141414] font-medium shadow-xs' : 'text-[#71717a] hover:text-[#141414]'
                }`}
              >
                Chuyên sâu
              </button>
              <button
                type="button"
                onClick={() => applyPreset('full')}
                className={`py-1 rounded whitespace-nowrap transition-colors ${
                  preset === 'full' ? 'bg-white text-[#141414] font-medium shadow-xs' : 'text-[#71717a] hover:text-[#141414]'
                }`}
              >
                Phủ kín
              </button>
            </div>
          </div>

          {/* Vector Weight (0.0 -> 1.0 full coverage + custom) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-medium text-[#18181b]">Vector Weight (0.0 → 1.0)</span>
              <button
                type="button"
                onClick={() => {
                  setPreset('custom');
                  setWeights(weights.length === WEIGHT_OPTIONS.length ? [0.3, 0.5, 0.7] : [...WEIGHT_OPTIONS]);
                }}
                className="font-mono text-[10.5px] text-[#71717a] hover:text-[#141414] transition-colors"
              >
                {weights.length === WEIGHT_OPTIONS.length ? 'Thu gọn' : `Chọn hết (${WEIGHT_OPTIONS.length})`}
              </button>
            </div>
            <div className="grid grid-cols-6 gap-1">
              {Array.from(new Set([...WEIGHT_OPTIONS, ...weights])).sort((a, b) => a - b).map((w) => {
                const on = weights.includes(w);
                return (
                  <button
                    key={w}
                    type="button"
                    onClick={() => toggleNum(weights, w, setWeights)}
                    className={`py-1 rounded text-[11px] font-mono tabular-nums border transition-all ${
                      on
                        ? 'bg-[#141414] text-white border-[#141414]'
                        : 'bg-white text-[#52525b] border-[#dcdcd8] hover:border-[#a1a1aa]'
                    }`}
                  >
                    {w.toFixed(1)}
                  </button>
                );
              })}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addCustomValue(customWeight, 0, 1, false, weights, setWeights, () => setCustomWeight(''));
                }}
                className="flex"
              >
                <input
                  type="text"
                  inputMode="decimal"
                  value={customWeight}
                  onChange={(e) => setCustomWeight(e.target.value)}
                  placeholder="+ số"
                  title="Nhập thêm giá trị Vector Weight (0.00 - 1.00) rồi Enter"
                  className="w-full py-1 px-1 text-center rounded text-[10.5px] font-mono bg-white border border-dashed border-[#d4d4d8] focus:border-[#141414] focus:outline-none text-[#141414] placeholder:text-[#a1a1aa]"
                />
              </form>
            </div>
          </div>

          {/* Similarity Threshold (0.00 -> 0.70 full coverage + custom, free in RAM) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-medium text-[#18181b]">
                Threshold <span className="font-mono text-[10px] text-[#027a42] font-normal">(gộp RAM)</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setPreset('custom');
                  setThresholds(
                    thresholds.length === THRESHOLD_OPTIONS.length ? [0.15, 0.25, 0.35] : [...THRESHOLD_OPTIONS]
                  );
                }}
                className="font-mono text-[10.5px] text-[#71717a] hover:text-[#141414] transition-colors"
              >
                {thresholds.length === THRESHOLD_OPTIONS.length ? 'Thu gọn' : `Chọn hết (${THRESHOLD_OPTIONS.length})`}
              </button>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {Array.from(new Set([...THRESHOLD_OPTIONS, ...thresholds])).sort((a, b) => a - b).map((t) => {
                const on = thresholds.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleNum(thresholds, t, setThresholds)}
                    className={`py-1 rounded text-[11px] font-mono tabular-nums border transition-all ${
                      on
                        ? 'bg-[#141414] text-white border-[#141414]'
                        : 'bg-white text-[#52525b] border-[#dcdcd8] hover:border-[#a1a1aa]'
                    }`}
                  >
                    {t.toFixed(2)}
                  </button>
                );
              })}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addCustomValue(customThreshold, 0, 0.95, false, thresholds, setThresholds, () =>
                    setCustomThreshold('')
                  );
                }}
                className="col-span-2 flex items-center gap-1"
              >
                <input
                  type="text"
                  inputMode="decimal"
                  value={customThreshold}
                  onChange={(e) => setCustomThreshold(e.target.value)}
                  placeholder="+ thêm (vd 0.45)"
                  title="Nhập thêm giá trị Threshold (0.00 - 0.95) rồi Enter"
                  className="w-full py-1 px-2 rounded text-[10.5px] font-mono bg-white border border-dashed border-[#d4d4d8] focus:border-[#141414] focus:outline-none text-[#141414] placeholder:text-[#a1a1aa]"
                />
                {customThreshold.trim() && (
                  <button
                    type="submit"
                    className="p-1 rounded bg-[#141414] text-white shrink-0"
                    title="Thêm mốc"
                  >
                    <Plus className="size-3" />
                  </button>
                )}
              </form>
            </div>
          </div>

          {/* Top-K (1 -> 20 full coverage + custom, free in RAM) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-medium text-[#18181b]">
                Top-K <span className="font-mono text-[10px] text-[#027a42] font-normal">(gộp RAM)</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setPreset('custom');
                  setTopKs(topKs.length === TOPK_OPTIONS.length ? [5, 10] : [...TOPK_OPTIONS]);
                }}
                className="font-mono text-[10.5px] text-[#71717a] hover:text-[#141414] transition-colors"
              >
                {topKs.length === TOPK_OPTIONS.length ? 'Thu gọn' : `Chọn hết (${TOPK_OPTIONS.length})`}
              </button>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {Array.from(new Set([...TOPK_OPTIONS, ...topKs])).sort((a, b) => a - b).map((k) => {
                const on = topKs.includes(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleNum(topKs, k, setTopKs)}
                    className={`py-1 rounded text-[11px] font-mono tabular-nums border transition-all ${
                      on
                        ? 'bg-[#141414] text-white border-[#141414]'
                        : 'bg-white text-[#52525b] border-[#dcdcd8] hover:border-[#a1a1aa]'
                    }`}
                  >
                    K={k}
                  </button>
                );
              })}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addCustomValue(customTopK, 1, 30, true, topKs, setTopKs, () => setCustomTopK(''));
                }}
                className="col-span-2 flex items-center gap-1"
              >
                <input
                  type="text"
                  inputMode="numeric"
                  value={customTopK}
                  onChange={(e) => setCustomTopK(e.target.value)}
                  placeholder="+ thêm (1–30)"
                  title="Nhập thêm giá trị Top-K (1 - 30) rồi Enter"
                  className="w-full py-1 px-2 rounded text-[10.5px] font-mono bg-white border border-dashed border-[#d4d4d8] focus:border-[#141414] focus:outline-none text-[#141414] placeholder:text-[#a1a1aa]"
                />
                {customTopK.trim() && (
                  <button
                    type="submit"
                    className="p-1 rounded bg-[#141414] text-white shrink-0"
                    title="Thêm Top-K"
                  >
                    <Plus className="size-3" />
                  </button>
                )}
              </form>
            </div>
          </div>

          {/* Rerank (ALL models from RAGFlow) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-medium text-[#18181b]">Rerank Model</span>
              {localReranks.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setPreset('custom');
                    const allIds = ['', ...localReranks.map((r) => r.id)];
                    setRerankIds(rerankIds.length === allIds.length ? [''] : allIds);
                  }}
                  className="font-mono text-[10.5px] text-[#71717a] hover:text-[#141414] transition-colors"
                >
                  {rerankIds.length === localReranks.length + 1 ? 'Chỉ tắt' : 'Chọn hết'}
                </button>
              )}
            </div>
            <div className="space-y-1 max-h-32 overflow-y-auto pr-0.5">
              <button
                type="button"
                onClick={() => toggleRerank('')}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-[11.5px] border transition-colors ${
                  rerankIds.includes('')
                    ? 'bg-[#141414] text-white border-[#141414]'
                    : 'bg-white text-[#52525b] border-[#dcdcd8] hover:border-[#a1a1aa]'
                }`}
              >
                <span>Không dùng Rerank</span>
                {rerankIds.includes('') && <Check className="size-3" />}
              </button>
              {localReranks.map((rm) => {
                const on = rerankIds.includes(rm.id);
                return (
                  <button
                    key={rm.id}
                    type="button"
                    onClick={() => toggleRerank(rm.id)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-[11.5px] border transition-colors ${
                      on
                        ? 'bg-[#141414] text-white border-[#141414]'
                        : 'bg-white text-[#52525b] border-[#dcdcd8] hover:border-[#a1a1aa]'
                    }`}
                    title={rm.id}
                  >
                    <span className="truncate">{rm.name || shortRerankName(rm.id)}</span>
                    {on && <Check className="size-3 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Objective & Judge */}
          <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#e8e8e6]">
            <div>
              <label className="block text-[10.5px] font-medium text-[#71717a] mb-1">Ưu tiên xếp hạng</label>
              <select
                value={objective}
                onChange={(e) => setObjective(e.target.value as any)}
                className="ts-input w-full py-1 px-2 text-[11.5px] rounded bg-white"
              >
                <option value="composite">Tổng hợp</option>
                <option value="mrr">MRR</option>
                <option value="hit_rate">Hit@K</option>
                <option value="ndcg">NDCG@K</option>
              </select>
            </div>
            <div>
              <label className="block text-[10.5px] font-medium text-[#71717a] mb-1">Bộ chấm</label>
              <select
                value={judgeEngine}
                onChange={(e) => setJudgeEngine(e.target.value as 'llm' | 'rule')}
                className="ts-input w-full py-1 px-2 text-[11.5px] rounded bg-white"
              >
                <option value="llm">LLM + Cache</option>
                <option value="rule">Rule (nhanh)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Sticky Bottom CTA + Optimization Math */}
        <div className="p-4 border-t border-[#e8e8e6] bg-white space-y-2.5">
          <div className="flex items-center justify-between text-[11px] font-mono text-[#52525b]">
            <span>
              <strong className="text-[#141414]">{totalCombos}</strong> tổ hợp
            </span>
            <span className="text-[#027a42] font-medium">
              {fetchGroupsCount} lượt gọi ({savedRatio}× nhanh)
            </span>
          </div>
          <button
            type="button"
            onClick={handleRunAutoTune}
            disabled={running || testcaseCount === 0}
            className="w-full inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-xs font-medium bg-[#141414] hover:bg-[#27272a] text-white disabled:opacity-40 transition-colors"
          >
            <Play className="size-3.5" />
            {testcaseCount === 0 ? 'Chưa có câu hỏi Golden' : 'Chạy Auto-Tune'}
          </button>
        </div>
      </aside>

      {/* ==================== RIGHT CANVAS: RESULTS ==================== */}
      <main className="flex-1 min-w-0 overflow-y-auto bg-white">
        {!result || !best ? (
          <div className="h-full flex items-center justify-center p-8">
            <div className="max-w-sm w-full text-center space-y-4">
              <GridSearchHeroSvg />
              <div className="space-y-1.5">
                <h3 className="text-[15px] font-semibold text-[#141414] tracking-tight">
                  Tự động dò tham số Retrieval tối ưu
                </h3>
                <p className="text-xs text-[#71717a] leading-relaxed">
                  Gộp <span className="font-mono text-[#141414]">threshold</span> và{' '}
                  <span className="font-mono text-[#141414]">top_k</span> trong RAM kết hợp{' '}
                  <span className="font-mono text-[#141414]">Smart Cache</span> để tìm vùng tham số đạt MRR &amp; Hit@K cao nhất.
                </p>
              </div>
              <div className="inline-flex items-center gap-3 px-3 py-1.5 rounded-md bg-[#fafaf9] border border-[#e8e8e6] text-[11px] font-mono text-[#52525b]">
                <span>{testcaseCount} câu Golden</span>
                <span className="text-[#d4d4d8]">·</span>
                <span>{totalCombos} tổ hợp</span>
                <span className="text-[#d4d4d8]">·</span>
                <span className="text-[#027a42]">{fetchGroupsCount} lượt RAGFlow</span>
              </div>
              <div>
                <button
                  type="button"
                  onClick={handleRunAutoTune}
                  disabled={running || testcaseCount === 0}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-medium bg-[#141414] hover:bg-[#27272a] text-white disabled:opacity-40 transition-colors"
                >
                  <Sparkles className="size-3.5 text-[#03aa5c]" />
                  Bắt đầu quét {totalCombos} tổ hợp
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div ref={resultsContainerRef} className="p-6 max-w-5xl mx-auto space-y-6">
            {/* Overfit micro-notice */}
            {result.stats.overfit_warning && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-[#fafaf9] border border-[#e4e4e2] text-[11.5px] text-[#71717a]">
                <AlertTriangle className="size-3.5 text-[#d97706] shrink-0" />
                <span>
                  Bộ Golden hiện có <strong className="font-mono text-[#141414]">{result.stats.total_testcases}</strong> câu (&lt;25). Nên ưu tiên chọn cấu hình nằm giữa vùng xanh ổn định trên Heatmap để tránh overfit.
                </span>
              </div>
            )}

            {/* 1. BEST CONFIG HERO STRIP */}
            <section className="at-hero rounded-lg border border-[#e4e4e2] border-l-[3px] border-l-[#03aa5c] bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-[#f0f0ee]">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] font-semibold text-[#027a42]">
                      Cấu hình tối ưu #1 · {OBJECTIVE_LABELS[result.objective] || result.objective}
                    </span>
                    {result.stats.demo && (
                      <span className="font-mono text-[9.5px] uppercase px-1.5 py-0.5 rounded bg-[#f4f4f2] text-[#71717a] border border-[#e4e4e2]">
                        Demo
                      </span>
                    )}
                    <span className="font-mono text-[10.5px] text-[#a1a1aa]">
                      {best.avg_latency_ms}ms / câu
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
                    <span className="px-2 py-0.5 rounded bg-[#f4f4f2] text-[#141414] font-semibold">
                      vector_weight = {best.vector_similarity_weight.toFixed(2)}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-[#f4f4f2] text-[#141414] font-semibold">
                      threshold = {best.similarity_threshold.toFixed(2)}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-[#f4f4f2] text-[#141414] font-semibold">
                      top_k = {best.top_k}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-[#f4f4f2] text-[#52525b]">
                      {shortRerankName(best.rerank_id)}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      setResult(null);
                      setHoveredCell(null);
                      writeLocalAutoTune(activeRun.id, {
                        preset,
                        weights,
                        thresholds,
                        topKs,
                        rerankIds,
                        objective,
                        judgeEngine,
                        result: null,
                      });
                      await api.clearLatestAutoTune(activeRun.id).catch(() => {});
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-[#71717a] hover:text-[#141414] hover:bg-[#f4f4f2] transition-colors"
                    title="Xóa kết quả đã lưu của dataset này"
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopyJson(best)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-[#dcdcd8] bg-white hover:bg-[#fafaf9] text-[#141414] transition-colors"
                  >
                    {copied ? <Check className="size-3.5 text-[#03aa5c]" /> : <Copy className="size-3.5" />}
                    {copied ? 'Đã copy' : 'Copy JSON'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSave(best)}
                    disabled={savingRank !== null}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[#141414] hover:bg-[#27272a] text-white disabled:opacity-45 transition-colors"
                  >
                    <BookmarkPlus className="size-3.5 text-[#03aa5c]" />
                    {savingRank === best.rank ? 'Đang lưu...' : 'Lưu vào Kết quả đo'}
                  </button>
                </div>
              </div>

              {/* 4 KPI Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4">
                <div>
                  <div className="text-[11px] text-[#71717a] mb-0.5">Điểm tổng hợp</div>
                  <div className="flex items-baseline gap-2">
                    <TweenNumber
                      value={best.composite}
                      format="pct"
                      className="font-mono text-xl font-bold text-[#141414] tabular-nums"
                    />
                    {renderDelta(best.composite, base?.composite)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-[#71717a] mb-0.5">MRR</div>
                  <div className="flex items-baseline gap-2">
                    <TweenNumber
                      value={best.mrr}
                      format="dec"
                      className="font-mono text-xl font-bold text-[#141414] tabular-nums"
                    />
                    {renderDelta(best.mrr, base?.mrr)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-[#71717a] mb-0.5">Hit@{best.top_k}</div>
                  <div className="flex items-baseline gap-2">
                    <TweenNumber
                      value={best.hit_rate}
                      format="pct"
                      className="font-mono text-xl font-bold text-[#141414] tabular-nums"
                    />
                    {renderDelta(best.hit_rate, base?.hit_rate)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-[#71717a] mb-0.5">NDCG@{best.top_k}</div>
                  <div className="flex items-baseline gap-2">
                    <TweenNumber
                      value={best.ndcg}
                      format="dec"
                      className="font-mono text-xl font-bold text-[#141414] tabular-nums"
                    />
                    {renderDelta(best.ndcg, base?.ndcg)}
                  </div>
                </div>
              </div>
            </section>

            {/* 2. 2D HEATMAP: VECTOR WEIGHT x THRESHOLD */}
            {heatmapData && (
              <section className="rounded-lg border border-[#e4e4e2] bg-white p-5 space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h4 className="text-xs font-semibold text-[#141414]">
                      Bản đồ vùng tối ưu (Vector Weight × Threshold)
                    </h4>
                    <p className="text-[11px] text-[#71717a]">
                      Ô xanh liền mạch = vùng tham số bền vững · Viền đen = tổ hợp dẫn đầu lát cắt
                    </p>
                  </div>

                  {/* Slice switches */}
                  <div className="flex items-center gap-2">
                    {result.grid_axes.top_ks.length > 1 && (
                      <div className="inline-flex p-0.5 rounded bg-[#f4f4f2] border border-[#e4e4e2] text-[11px] font-mono">
                        {result.grid_axes.top_ks.map((k) => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => setHmTopK(k)}
                            className={`px-2 py-0.5 rounded transition-colors ${
                              hmTopK === k ? 'bg-white text-[#141414] font-semibold shadow-xs' : 'text-[#71717a]'
                            }`}
                          >
                            K={k}
                          </button>
                        ))}
                      </div>
                    )}
                    {result.grid_axes.rerank_ids.length > 1 && (
                      <div className="inline-flex p-0.5 rounded bg-[#f4f4f2] border border-[#e4e4e2] text-[11px]">
                        {result.grid_axes.rerank_ids.map((rid) => (
                          <button
                            key={rid || 'none'}
                            type="button"
                            onClick={() => setHmRerank(rid)}
                            className={`px-2 py-0.5 rounded transition-colors ${
                              hmRerank === rid ? 'bg-white text-[#141414] font-medium shadow-xs' : 'text-[#71717a]'
                            }`}
                          >
                            {shortRerankName(rid)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Matrix */}
                <div className="overflow-x-auto">
                  <div
                    className="grid gap-1.5 min-w-[360px]"
                    style={{
                      gridTemplateColumns: `84px repeat(${result.grid_axes.thresholds.length}, minmax(64px, 1fr))`,
                    }}
                  >
                    {/* Column header */}
                    <div className="text-[10px] font-mono text-[#a1a1aa] flex items-end pb-1">
                      vec \ th
                    </div>
                    {result.grid_axes.thresholds.map((th) => (
                      <div key={th} className="text-center font-mono text-[11px] text-[#52525b] pb-1">
                        {th.toFixed(2)}
                      </div>
                    ))}

                    {/* Rows */}
                    {result.grid_axes.vector_weights.map((vw) => (
                      <React.Fragment key={vw}>
                        <div className="flex items-center font-mono text-[11px] text-[#52525b] pr-2">
                          vec {vw.toFixed(2)}
                        </div>
                        {result.grid_axes.thresholds.map((th) => {
                          const cell = heatmapData.map.get(`${vw}|${th}`);
                          if (!cell) {
                            return <div key={`${vw}-${th}`} className="h-11 rounded bg-[#fafaf9]" />;
                          }
                          const score = Number(cell[heatmapData.objKey] ?? cell.composite);
                          const isBest = cell.rank === 1;
                          return (
                            <button
                              key={`${vw}-${th}`}
                              type="button"
                              onMouseEnter={() => setHoveredCell(cell)}
                              onMouseLeave={() => setHoveredCell(null)}
                              onClick={() => handleSave(cell)}
                              style={getCellStyle(score, heatmapData.minVal, heatmapData.maxVal)}
                              className={`at-cell h-11 rounded flex flex-col items-center justify-center font-mono transition-transform hover:scale-[1.03] ${
                                isBest ? 'ring-2 ring-[#141414] ring-offset-1 font-bold' : 'font-medium'
                              }`}
                              title="Bấm để lưu cấu hình này thành Retrieval Run"
                            >
                              <span className="text-[12px] leading-none tabular-nums">
                                {fmtPct(score)}
                              </span>
                              <span className="text-[9.5px] opacity-80 mt-0.5 tabular-nums">
                                #{cell.rank}
                              </span>
                            </button>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </div>
                </div>

                {/* Hover detail strip */}
                <div className="h-6 flex items-center justify-between text-[11px] font-mono text-[#52525b] pt-1 border-t border-[#f4f4f2]">
                  {hoveredCell ? (
                    <>
                      <span>
                        vec={hoveredCell.vector_similarity_weight.toFixed(2)} · th=
                        {hoveredCell.similarity_threshold.toFixed(2)} · K={hoveredCell.top_k}
                      </span>
                      <span className="flex items-center gap-3 tabular-nums">
                        <span>MRR {fmtScore(hoveredCell.mrr)}</span>
                        <span>Hit {fmtPct(hoveredCell.hit_rate)}</span>
                        <span>NDCG {fmtScore(hoveredCell.ndcg)}</span>
                        <span>Rỗng {fmtPct(hoveredCell.empty_rate)}</span>
                      </span>
                    </>
                  ) : (
                    <span className="font-sans text-[#a1a1aa]">
                      Di chuột vào từng ô để xem chi tiết MRR / Hit@K / NDCG / tỷ lệ trả rỗng
                    </span>
                  )}
                </div>
              </section>
            )}

            {/* 3. RANKED LEADERBOARD */}
            <section className="rounded-lg border border-[#e4e4e2] bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[#e8e8e6] bg-[#fafaf9] flex items-center justify-between">
                <span className="text-xs font-semibold text-[#141414]">
                  Bảng xếp hạng ({result.trials.length} tổ hợp)
                </span>
                <span className="font-mono text-[11px] text-[#71717a] tabular-nums">
                  {result.stats.ragflow_fetch_groups} lượt RAGFlow · Cache{' '}
                  {(result.stats.cache_hit_rate * 100).toFixed(0)}% · {result.stats.llm_calls} LLM calls ·{' '}
                  {result.stats.elapsed_sec}s
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#ededeb] text-[10.5px] uppercase tracking-[0.04em] text-[#71717a]">
                      <th className="py-2 pl-4 pr-2 font-medium w-10">#</th>
                      <th className="py-2 px-2 font-medium">Tham số</th>
                      <th className="py-2 px-2 font-medium w-40">Tổng hợp</th>
                      <th className="py-2 px-2 font-medium text-right">MRR</th>
                      <th className="py-2 px-2 font-medium text-right">Hit@K</th>
                      <th className="py-2 px-2 font-medium text-right">NDCG</th>
                      <th className="py-2 px-2 font-medium text-right">Rỗng</th>
                      <th className="py-2 px-2 font-medium text-right">Latency</th>
                      <th className="py-2 pl-2 pr-4 font-medium text-right w-20"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f4f4f2]">
                    {result.trials.map((t) => {
                      const isTop = t.rank === 1;
                      return (
                        <tr
                          key={`${t.vector_similarity_weight}-${t.similarity_threshold}-${t.top_k}-${t.rerank_id}`}
                          className={`at-row transition-colors hover:bg-[#fafaf9] ${
                            isTop ? 'bg-[#f2fbf6]/60' : ''
                          }`}
                        >
                          <td className="py-2 pl-4 pr-2 font-mono text-[11px] font-semibold text-[#52525b]">
                            {isTop ? (
                              <span className="inline-flex items-center justify-center size-5 rounded bg-[#03aa5c] text-white text-[10px]">
                                1
                              </span>
                            ) : (
                              t.rank
                            )}
                          </td>
                          <td className="py-2 px-2 font-mono text-[11.5px] text-[#141414] whitespace-nowrap">
                            vec={t.vector_similarity_weight.toFixed(2)} · th={t.similarity_threshold.toFixed(2)} · K=
                            {t.top_k}
                            {t.rerank_id ? (
                              <span className="ml-1.5 text-[10.5px] text-[#027a42]">
                                [{shortRerankName(t.rerank_id)}]
                              </span>
                            ) : null}
                          </td>
                          <td className="py-2 px-2">
                            <div className="flex items-center gap-2">
                              <svg viewBox="0 0 100 4" className="w-20 h-1 rounded-full overflow-hidden shrink-0">
                                <rect x="0" y="0" width="100" height="4" fill="#ededeb" />
                                <rect
                                  x="0"
                                  y="0"
                                  width={Math.round(t.composite * 100)}
                                  height="4"
                                  fill={isTop ? '#03aa5c' : '#141414'}
                                />
                              </svg>
                              <span className="font-mono text-[11.5px] font-semibold text-[#141414] tabular-nums">
                                {fmtPct(t.composite)}
                              </span>
                            </div>
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-[11.5px] tabular-nums text-[#18181b]">
                            {fmtScore(t.mrr)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-[11.5px] tabular-nums text-[#18181b]">
                            {fmtPct(t.hit_rate)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-[11.5px] tabular-nums text-[#52525b]">
                            {fmtScore(t.ndcg)}
                          </td>
                          <td
                            className={`py-2 px-2 text-right font-mono text-[11.5px] tabular-nums ${
                              t.empty_rate > 0.15 ? 'text-[#cf222e]' : 'text-[#71717a]'
                            }`}
                          >
                            {fmtPct(t.empty_rate)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-[11px] tabular-nums text-[#71717a]">
                            {t.avg_latency_ms}ms
                          </td>
                          <td className="py-2 pl-2 pr-4 text-right">
                            <button
                              type="button"
                              onClick={() => handleSave(t)}
                              disabled={savingRank !== null}
                              className="px-2 py-0.5 rounded text-[11px] font-medium border border-[#dcdcd8] bg-white hover:border-[#141414] text-[#141414] disabled:opacity-40 transition-colors"
                            >
                              {savingRank === t.rank ? '...' : 'Lưu'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
};
