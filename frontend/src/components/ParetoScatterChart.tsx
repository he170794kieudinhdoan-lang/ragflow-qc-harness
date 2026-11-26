import React, { useMemo, useState } from 'react';
import { OptimizationTrial, SensitivityItem } from '../types';

interface Props {
  trials: OptimizationTrial[];
  sensitivity: SensitivityItem[];
  bestTrialId: number | null;
}

export const ParetoScatterChart: React.FC<Props> = ({ trials, sensitivity, bestTrialId }) => {
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  const fullTrials = useMemo(() => {
    const f = trials.filter((t) => t.stage === '2_FULL');
    return f.length > 0 ? f : trials;
  }, [trials]);

  const paretoLine = useMemo(() => {
    return fullTrials
      .filter((t) => t.is_pareto)
      .slice()
      .sort((a, b) => a.avg_latency_ms - b.avg_latency_ms);
  }, [fullTrials]);

  const bounds = useMemo(() => {
    if (trials.length === 0) {
      return { minX: 0, maxX: 500, minY: 0, maxY: 1 };
    }
    const xs = trials.map((t) => t.avg_latency_ms || 0);
    const ys = trials.map((t) => t.objective_score || 0);
    const minX = Math.max(0, Math.min(...xs) * 0.85);
    const maxX = Math.max(...xs) * 1.12 || 200;
    const minY = Math.max(0, Math.min(...ys) - 0.08);
    const maxY = Math.min(1.0, Math.max(...ys) + 0.06);
    return {
      minX,
      maxX: maxX <= minX ? minX + 100 : maxX,
      minY,
      maxY: maxY <= minY ? minY + 0.2 : maxY,
    };
  }, [trials]);

  const W = 520;
  const H = 250;
  const PAD = { l: 46, r: 20, t: 18, b: 36 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  const toX = (ms: number) => PAD.l + ((ms - bounds.minX) / (bounds.maxX - bounds.minX)) * plotW;
  const toY = (sc: number) => PAD.t + (1 - (sc - bounds.minY) / (bounds.maxY - bounds.minY)) * plotH;

  const hovered = trials.find((t) => t.id === hoveredId) || null;
  const maxSwing = sensitivity.length > 0 ? Math.max(...sensitivity.map((s) => s.swing), 0.01) : 0.01;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      {/* Left: SVG Pareto Frontier */}
      <div className="lg:col-span-7 border border-[#e4e4e2] rounded-lg bg-white p-4 space-y-2 shadow-2xs">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="ts-eyebrow">BIỂU ĐỒ PARETO (CHẤT LƯỢNG VS TỐC ĐỘ)</div>
            <div className="text-[11px] text-[#71717a]">
              Góc trên bên trái = điểm lý tưởng (Điểm cao + Độ trễ thấp)
            </div>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono text-[#52525b]">
            <span className="inline-flex items-center gap-1">
              <span className="size-2.5 rounded-full bg-[#03aa5c] inline-block" /> Pareto / Top
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="size-2.5 rounded-full bg-[#161616] inline-block" /> Baseline (#1)
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="size-2 rounded-full bg-[#d4d4d8] inline-block" /> Screening
            </span>
          </div>
        </div>

        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[230px] block select-none">
            {/* Horizontal gridlines */}
            {[0, 0.25, 0.5, 0.75, 1].map((f, idx) => {
              const val = bounds.minY + f * (bounds.maxY - bounds.minY);
              const y = toY(val);
              return (
                <g key={idx}>
                  <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="#f0f0ee" strokeWidth="1" />
                  <text x={PAD.l - 6} y={y + 3} textAnchor="end" fontSize="9.5" fontFamily="monospace" fill="#71717a">
                    {(val * 100).toFixed(0)}%
                  </text>
                </g>
              );
            })}

            {/* Vertical gridlines */}
            {[0, 0.33, 0.66, 1].map((f, idx) => {
              const val = bounds.minX + f * (bounds.maxX - bounds.minX);
              const x = toX(val);
              return (
                <g key={idx}>
                  <line x1={x} y1={PAD.t} x2={x} y2={H - PAD.b} stroke="#f0f0ee" strokeWidth="1" />
                  <text x={x} y={H - PAD.b + 14} textAnchor="middle" fontSize="9.5" fontFamily="monospace" fill="#71717a">
                    {Math.round(val)}ms
                  </text>
                </g>
              );
            })}

            {/* Axes */}
            <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b} stroke="#d4d4d8" strokeWidth="1" />
            <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke="#d4d4d8" strokeWidth="1" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9.5" fill="#71717a">
              Độ trễ trung bình mỗi câu (ms)
            </text>

            {/* Pareto Frontier Polyline */}
            {paretoLine.length >= 2 && (
              <polyline
                fill="none"
                stroke="#03aa5c"
                strokeWidth="1.5"
                strokeDasharray="4 3"
                points={paretoLine.map((t) => `${toX(t.avg_latency_ms)},${toY(t.objective_score)}`).join(' ')}
              />
            )}

            {/* Scatter Points */}
            {trials.map((t) => {
              const cx = toX(t.avg_latency_ms);
              const cy = toY(t.objective_score);
              const isBest = t.id === bestTrialId;
              const isBase = t.trial_index === 1 && t.stage === (fullTrials[0]?.stage || t.stage);
              const isFull = t.stage === '2_FULL';
              const r = isBest ? 6.5 : t.is_pareto ? 5.2 : isFull ? 4.2 : 3.0;
              const fill = isBest
                ? '#03aa5c'
                : t.is_pareto
                ? '#34d399'
                : isBase
                ? '#161616'
                : isFull
                ? '#71717a'
                : '#d4d4d8';
              const stroke = isBest || isBase ? '#161616' : '#ffffff';
              return (
                <circle
                  key={t.id}
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={isBest ? 2 : 1}
                  className="cursor-pointer transition-all"
                  onMouseEnter={() => setHoveredId(t.id)}
                  onMouseLeave={() => setHoveredId(null)}
                />
              );
            })}
          </svg>

          {hovered && (
            <div className="mt-1 px-3 py-2 rounded border border-[#dedede] bg-[#fafaf9] text-[11px] font-mono flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong>#{hovered.trial_index}</strong> ({hovered.stage === '2_FULL' ? 'Full' : 'Vòng 1'}) ·{' '}
                vw={hovered.config.vector_similarity_weight} · th={hovered.config.similarity_threshold} · k={hovered.config.top_k}{' '}
                {hovered.config.rerank_id ? `· rerank` : ''}
              </span>
              <span className="text-[#027a42] font-semibold">
                Score {(hovered.objective_score * 100).toFixed(1)}% · CP {(hovered.avg_cp * 100).toFixed(1)}% · {Math.round(hovered.avg_latency_ms)}ms
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Right: Parameter Sensitivity */}
      <div className="lg:col-span-5 border border-[#e4e4e2] rounded-lg bg-white p-4 space-y-3 shadow-2xs">
        <div>
          <div className="ts-eyebrow">ĐỘ NHẠY THAM SỐ (PARAMETER IMPACT)</div>
          <div className="text-[11px] text-[#71717a]">
            Mức chênh lệch điểm trung bình giữa giá trị tốt nhất và kém nhất của từng tham số
          </div>
        </div>

        {sensitivity.length === 0 ? (
          <div className="py-10 text-center text-xs text-[#71717a]">
            Cần sweep nhiều giá trị khác nhau cho ít nhất 1 tham số để tính độ nhạy.
          </div>
        ) : (
          <div className="space-y-3 pt-1">
            {sensitivity.map((s) => {
              const barPct = Math.max(8, Math.round((s.swing / maxSwing) * 100));
              return (
                <div key={s.param} className="space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-[#161616] truncate">{s.label}</span>
                    <span className="font-mono text-[11px] text-[#027a42] font-semibold shrink-0">
                      +{(s.swing * 100).toFixed(1)}% · Tốt nhất: {s.best_value}
                    </span>
                  </div>
                  <div className="h-2 w-full bg-[#f4f4f2] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#03aa5c] rounded-full transition-all"
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[10px] font-mono text-[#71717a]">
                    {s.levels.map((lv) => (
                      <span
                        key={lv.value}
                        className={`px-1.5 py-0.5 rounded border ${
                          lv.value === s.best_value
                            ? 'bg-[#f2fbf6] border-[#03aa5c]/40 text-[#027a42] font-semibold'
                            : 'bg-[#fafaf9] border-[#ededeb]'
                        }`}
                      >
                        {lv.value}: {(lv.avg_score * 100).toFixed(1)}%
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
