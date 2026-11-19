import React, { useEffect, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, GitCompare } from 'lucide-react';
import { api } from '../api/client';
import { RetrievalRun } from '../types';

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

export const CompareLabPage: React.FC = () => {
  const [rrList, setRrList] = useState<RetrievalRun[]>([]);
  const [baseId, setBaseId] = useState<number | ''>('');
  const [candId, setCandId] = useState<number | ''>('');
  const [diff, setDiff] = useState<any>(null);

  useEffect(() => {
    api.listRetrievalRuns().then((list) => {
      setRrList(list);
      if (list.length >= 2) {
        setBaseId(list[list.length - 1].id);
        setCandId(list[0].id);
      }
    });
  }, []);

  useEffect(() => {
    if (baseId && candId && baseId !== candId) {
      api.compareRuns(Number(baseId), Number(candId)).then(setDiff);
    }
  }, [baseId, candId]);

  const bSum = diff?.baseline?.summary;
  const cSum = diff?.candidate?.summary;
  const deltaCp = bSum && cSum ? cSum.avg_contextual_precision - bSum.avg_contextual_precision : 0;
  const deltaCc = bSum && cSum ? cSum.avg_context_coverage - bSum.avg_context_coverage : 0;

  return (
    <div className="max-w-5xl mx-auto px-8 py-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="ts-eyebrow">A/B EXPERIMENT LAB</div>
          <h1 className="text-2xl font-semibold text-[#18181b] mt-1">So sánh 2 cấu hình tìm kiếm</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            className="ts-input py-1.5 text-xs bg-[#fafafa]"
            value={baseId}
            onChange={(e) => setBaseId(Number(e.target.value))}
          >
            <option value="">Chọn bản chuẩn (A)...</option>
            {rrList.map((r) => (
              <option key={r.id} value={r.id}>
                [A] {r.name}
              </option>
            ))}
          </select>
          <GitCompare className="size-4 text-[#a1a1aa]" />
          <select
            className="ts-input py-1.5 text-xs bg-[#fafafa]"
            value={candId}
            onChange={(e) => setCandId(Number(e.target.value))}
          >
            <option value="">Chọn bản mới (B)...</option>
            {rrList.map((r) => (
              <option key={r.id} value={r.id}>
                [B] {r.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!diff ? (
        <div className="border border-[#e6e6e3] rounded-[4px] p-10 text-center text-sm text-[#71717a] bg-[#fafaf9]">
          Cần ít nhất 2 lần chạy tìm kiếm khác nhau để so sánh A/B.
        </div>
      ) : (
        <>
          {/* Architectural 4-Column Metric Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border border-[#e6e6e3] rounded-[4px] divide-y sm:divide-y-0 sm:divide-x divide-[#e6e6e3] bg-[#fafaf9]">
            <div className="p-5">
              <div className="ts-eyebrow">XẾP ĐÚNG LÊN ĐẦU</div>
              <div className="mt-2 flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-[#71717a] text-sm">{pct(bSum.avg_contextual_precision)}</span>
                <span className="text-[#a1a1aa]">→</span>
                <span className="text-2xl font-semibold text-[#18181b]">{pct(cSum.avg_contextual_precision)}</span>
              </div>
              <div className={`text-xs font-mono mt-1 ${deltaCp >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                {deltaCp >= 0 ? `+${pct(deltaCp)} tốt hơn` : `${pct(deltaCp)} thấp hơn`}
              </div>
            </div>

            <div className="p-5">
              <div className="ts-eyebrow">TÌM ĐỦ THÔNG TIN</div>
              <div className="mt-2 flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-[#71717a] text-sm">{pct(bSum.avg_context_coverage)}</span>
                <span className="text-[#a1a1aa]">→</span>
                <span className="text-2xl font-semibold text-[#18181b]">{pct(cSum.avg_context_coverage)}</span>
              </div>
              <div className={`text-xs font-mono mt-1 ${deltaCc >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                {deltaCc >= 0 ? `+${pct(deltaCc)}` : pct(deltaCc)}
              </div>
            </div>

            <div className="p-5">
              <div className="ts-eyebrow">FAIL → PASS</div>
              <div className="mt-2 text-2xl font-mono font-semibold text-emerald-700 flex items-center gap-1">
                <ArrowUpRight className="size-5" />
                {diff.improvements_fail_to_pass.length}
              </div>
              <div className="text-xs text-[#71717a] italic mt-1">Câu được cứu ở bản mới</div>
            </div>

            <div className="p-5">
              <div className="ts-eyebrow">PASS → FAIL</div>
              <div className="mt-2 text-2xl font-mono font-semibold text-rose-600 flex items-center gap-1">
                <ArrowDownRight className="size-5" />
                {diff.regressions_pass_to_fail.length}
              </div>
              <div className="text-xs text-[#71717a] italic mt-1">Câu bị tụt hạng</div>
            </div>
          </div>

          {/* Diff Lists */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="border border-[#e6e6e3] rounded-[4px] bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-[#e6e6e3] bg-[#fafaf9] ts-eyebrow text-emerald-800">
                CÁC CÂU CẢI THIỆN (FAIL → PASS)
              </div>
              <DiffList rows={diff.improvements_fail_to_pass} />
            </div>

            <div className="border border-[#e6e6e3] rounded-[4px] bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-[#e6e6e3] bg-[#fafaf9] ts-eyebrow text-rose-800">
                CÁC CÂU BỊ TỤT (PASS → FAIL)
              </div>
              <DiffList rows={diff.regressions_pass_to_fail} />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const DiffList: React.FC<{ rows: any[] }> = ({ rows }) => {
  if (rows.length === 0) {
    return <div className="p-5 text-[13px] text-[#71717a]">Không có câu hỏi nào thay đổi trạng thái.</div>;
  }
  return (
    <div className="divide-y divide-[#ededeb]">
      {rows.map((r) => (
        <div key={r.tc_code} className="px-4 py-3 flex items-start justify-between gap-3 hover:bg-[#fafaf9]">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-xs font-semibold text-[#18181b]">{r.tc_code}</span>
              <span className="ts-tag-neutral text-[10px]">{r.question_class}</span>
            </div>
            <div className="text-[13px] text-[#27272a] mt-1">{r.question}</div>
          </div>
          <div className="text-right shrink-0 font-mono tabular-nums text-xs text-[#52525b]">
            {(r.baseline_cp * 100).toFixed(0)}% → {(r.candidate_cp * 100).toFixed(0)}%
          </div>
        </div>
      ))}
    </div>
  );
};
