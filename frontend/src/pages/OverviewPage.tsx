import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  FileSearch,
  GitCompare,
  Layers,
  Search,
} from 'lucide-react';
import { api } from '../api/client';
import { RunItem } from '../types';

export type WorkflowModeId = 'full_pipeline' | 'retrieval_only' | 'parsing_only' | 'compare_only';

export interface WorkflowModeDef {
  id: WorkflowModeId;
  tag: string;
  title: string;
  desc: string;
  stepsLabel: string;
  primary?: boolean;
}

export const WORKFLOW_MODES: WorkflowModeDef[] = [
  {
    id: 'full_pipeline',
    tag: 'Khuyên dùng · Gated A→Z',
    title: 'Kiểm thử toàn luồng 3 tầng (A → Z)',
    desc: 'Quy trình chuẩn khép kín: tạo/chọn Dataset, đồng bộ chunks, chấm Parsing (bắt buộc hoàn tất trước khi mở Chunking), chấm Chunking, rồi tạo Golden Dataset & tinh chỉnh Retrieval.',
    stepsLabel: 'Dataset → Đồng bộ → Parsing → Chunking → Retrieval → A/B',
    primary: true,
  },
  {
    id: 'retrieval_only',
    tag: 'Chế độ nhanh',
    title: 'Chỉ chấm Retrieval & Tinh chỉnh',
    desc: 'Đi thẳng vào bước quản lý Golden Dataset, chạy batch /api/v1/retrieval với Smart Relevancy Cache / LLM và tinh chỉnh top-k, threshold, rerank.',
    stepsLabel: 'Golden & Retrieval → Tinh chỉnh A/B',
  },
  {
    id: 'parsing_only',
    tag: 'Chế độ nhanh',
    title: 'Chỉ chấm Parsing & OCR',
    desc: 'Tập trung kiểm tra chất lượng đọc file gốc (PDF văn bản, scan, bảng biểu, DOCX) đối chiếu song song với chunks RAGFlow trích xuất.',
    stepsLabel: 'Dataset & Đồng bộ → Chấm Parsing',
  },
  {
    id: 'compare_only',
    tag: 'A/B Lab',
    title: 'So sánh 2 cấu hình (A/B Lab)',
    desc: 'Đối chiếu trực tiếp Baseline với cấu hình thử nghiệm, lọc câu Pass → Fail / Fail → Pass và xác định tầng gây lỗi gốc.',
    stepsLabel: 'Phòng so sánh A/B',
  },
];

interface Props {
  activeRun: RunItem | null;
  onStartWorkflow: (mode: WorkflowModeId) => void;
}

const pct = (v?: number) => `${((v || 0) * 100).toFixed(0)}%`;

export const OverviewPage: React.FC<Props> = ({ activeRun, onStartWorkflow }) => {
  const [overview, setOverview] = useState<any>(null);

  useEffect(() => {
    if (!activeRun) {
      setOverview(null);
      return;
    }
    api.getOverview(activeRun.id).then(setOverview).catch(() => {});
  }, [activeRun?.id]);

  const p = overview?.parsing || {};
  const c = overview?.chunking || {};
  const r = overview?.retrieval || null;

  const modeArt = (id: WorkflowModeId) => {
    if (id === 'full_pipeline') {
      return (
        <svg viewBox="0 0 112 64" className="w-[104px] h-[60px] shrink-0" fill="none" strokeWidth="1.35">
          {/* Node 1: Doc */}
          <rect x="4" y="14" width="24" height="32" rx="2" stroke="#161616" fill="#fefefe" />
          <line x1="9" y1="23" x2="23" y2="23" stroke="#abbab9" />
          <line x1="9" y1="29" x2="20" y2="29" stroke="#abbab9" />
          <rect x="9" y="34" width="14" height="7" rx="1" stroke="#03aa5c" fill="#03aa5c" fillOpacity="0.14" />
          {/* Arrow 1 -> 2 */}
          <path d="M31 30 L41 30" stroke="#03aa5c" strokeDasharray="2.5 2" />
          <path d="M38 27 L41 30 L38 33" stroke="#03aa5c" />
          {/* Node 2: Cube */}
          <polygon points="56 15 69 22.5 69 37.5 56 45 43 37.5 43 22.5 56 15" stroke="#161616" fill="#03aa5c" fillOpacity="0.1" />
          <line x1="56" y1="45" x2="56" y2="30" stroke="#161616" />
          <line x1="69" y1="22.5" x2="56" y2="30" stroke="#161616" />
          <line x1="43" y1="22.5" x2="56" y2="30" stroke="#161616" />
          {/* Arrow 2 -> 3 */}
          <path d="M72 30 L82 30" stroke="#03aa5c" strokeDasharray="2.5 2" />
          <path d="M79 27 L82 30 L79 33" stroke="#03aa5c" />
          {/* Node 3: Ranked results */}
          <rect x="85" y="16" width="23" height="7" rx="1.5" stroke="#03aa5c" fill="#03aa5c" fillOpacity="0.15" />
          <rect x="85" y="27" width="18" height="7" rx="1.5" stroke="#161616" />
          <rect x="85" y="38" width="13" height="7" rx="1.5" stroke="#abbab9" />
        </svg>
      );
    }
    if (id === 'retrieval_only') {
      return (
        <svg viewBox="0 0 96 64" className="w-[88px] h-[60px] shrink-0" fill="none" strokeWidth="1.35">
          <rect x="6" y="10" width="52" height="11" rx="2" stroke="#03aa5c" fill="#03aa5c" fillOpacity="0.1" />
          <rect x="6" y="26" width="42" height="11" rx="2" stroke="#161616" fill="#fefefe" />
          <rect x="6" y="42" width="30" height="11" rx="2" stroke="#abbab9" />
          <circle cx="74" cy="24" r="10" stroke="#161616" fill="#fefefe" />
          <circle cx="74" cy="24" r="4" stroke="#03aa5c" />
          <line x1="81" y1="31" x2="89" y2="39" stroke="#161616" strokeWidth="1.7" />
        </svg>
      );
    }
    if (id === 'parsing_only') {
      return (
        <svg viewBox="0 0 96 64" className="w-[88px] h-[60px] shrink-0" fill="none" strokeWidth="1.35">
          <rect x="10" y="8" width="38" height="48" rx="2.5" stroke="#161616" fill="#fefefe" />
          <line x1="17" y1="18" x2="41" y2="18" stroke="#abbab9" />
          <line x1="17" y1="25" x2="36" y2="25" stroke="#abbab9" />
          <rect x="17" y="32" width="24" height="15" rx="1.5" stroke="#03aa5c" fill="#03aa5c" fillOpacity="0.14" />
          <line x1="6" y1="32" x2="52" y2="32" stroke="#03aa5c" strokeDasharray="3 2" />
          <path d="M58 18 L74 18 L74 46 L58 46" stroke="#abbab9" strokeDasharray="3 3" />
          <circle cx="64" cy="32" r="5" stroke="#03aa5c" fill="#03aa5c" fillOpacity="0.15" />
          <path d="M62 32 L63.5 33.5 L66.5 30.5" stroke="#027a42" />
        </svg>
      );
    }
    return (
      <svg viewBox="0 0 96 64" className="w-[88px] h-[60px] shrink-0" fill="none" strokeWidth="1.35">
        <rect x="10" y="12" width="26" height="40" rx="2" stroke="#161616" fill="#fefefe" />
        <line x1="15" y1="22" x2="31" y2="22" stroke="#abbab9" />
        <line x1="15" y1="29" x2="28" y2="29" stroke="#abbab9" />
        <circle cx="23" cy="40" r="3" fill="#161616" />
        <rect x="60" y="12" width="26" height="40" rx="2" stroke="#03aa5c" fill="#03aa5c" fillOpacity="0.12" />
        <line x1="65" y1="22" x2="81" y2="22" stroke="#03aa5c" />
        <line x1="65" y1="29" x2="78" y2="29" stroke="#03aa5c" />
        <circle cx="73" cy="40" r="3" fill="#03aa5c" />
        <path d="M40 26 L56 26 M52 22 L56 26 L52 30" stroke="#161616" />
        <path d="M56 38 L40 38 M44 34 L40 38 L44 42" stroke="#03aa5c" />
      </svg>
    );
  };

  return (
    <div className="max-w-5xl mx-auto px-8 py-10 space-y-10">
      {/* Editorial Hero */}
      <div className="space-y-4">
        <span className="ts-eyebrow">
          RAGFLOW QC · {activeRun ? activeRun.name.toUpperCase() : 'WORKSPACE'}
        </span>

        <h1 className="text-[32px] leading-[1.15] font-semibold tracking-[-0.02em] text-[#161616]">
          Kiểm thử chất lượng hệ thống RAG theo luồng chuẩn hóa.
        </h1>

        <p className="text-[14px] text-[#3d3d3d] max-w-2xl leading-relaxed">
          Chọn một chế độ kiểm thử bên dưới để bắt đầu. Ở chế độ toàn luồng 3 tầng, các bước được kiểm soát tuần tự
          (hoàn tất Parsing mới mở khóa Chunking) giúp kết quả đánh giá nhất quán từ đầu đến cuối.
        </p>

        {/* Raw Brutalist Technical Blueprint Pipeline Banner */}
        <div
          onClick={() => onStartWorkflow('full_pipeline')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && onStartWorkflow('full_pipeline')}
          title="Bấm để bắt đầu luồng kiểm thử 3 tầng (A → Z)"
          className="ts-editorial-banner border-2 border-[#161616] shadow-[4px_4px_0_#161616] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[3px_3px_0_#03aa5c] px-5 py-4 cursor-pointer transition-all overflow-hidden"
        >
          <svg
            viewBox="0 0 820 120"
            className="w-full h-[100px] md:h-[116px] block"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Raw corner registration marks */}
            <path d="M2 10 L2 2 L10 2" stroke="#161616" strokeWidth="1.5" />
            <path d="M810 2 L818 2 L818 10" stroke="#161616" strokeWidth="1.5" />
            <path d="M2 110 L2 118 L10 118" stroke="#161616" strokeWidth="1.5" />
            <path d="M810 118 L818 118 L818 110" stroke="#161616" strokeWidth="1.5" />

            {/* Stage 01: DOCS */}
            <g transform="translate(22, 18)">
              <rect x="4" y="4" width="142" height="82" fill="#161616" />
              <rect x="0" y="0" width="142" height="82" fill="#fefefe" stroke="#161616" strokeWidth="2" />
              <rect x="0" y="0" width="26" height="18" fill="#161616" />
              <text x="5" y="12.5" fill="#fefefe" fontSize="9.5" fontWeight="700" fontFamily="monospace">01</text>
              <rect x="14" y="28" width="28" height="38" fill="#f2fbf6" stroke="#161616" strokeWidth="1.75" />
              <line x1="19" y1="38" x2="37" y2="38" stroke="#161616" strokeWidth="1.5" />
              <line x1="19" y1="46" x2="33" y2="46" stroke="#161616" strokeWidth="1.5" />
              <line x1="19" y1="54" x2="36" y2="54" stroke="#161616" strokeWidth="1.5" />
              <line x1="10" y1="33" x2="46" y2="33" stroke="#03aa5c" strokeWidth="2.2" className="ts-anim-scan" />
              <text x="54" y="44" fill="#161616" fontSize="13" fontWeight="700" fontFamily="monospace">DOCS</text>
              <text x="54" y="60" fill="#52525b" fontSize="9.5" fontFamily="monospace">[PDF/DOCX]</text>
            </g>

            {/* Connector 1 -> 2 */}
            <circle cx="170" cy="59" r="2.5" fill="#161616" />
            <line x1="173" y1="59" x2="229" y2="59" stroke="#161616" strokeWidth="1.6" className="ts-anim-flow" />
            <path d="M223 53.5 L229.5 59 L223 64.5" stroke="#03aa5c" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" />

            {/* Stage 02: PARSING */}
            <g transform="translate(234, 18)">
              <rect x="4" y="4" width="150" height="82" fill="#161616" />
              <rect x="0" y="0" width="150" height="82" fill="#fefefe" stroke="#161616" strokeWidth="2" />
              <rect x="0" y="0" width="26" height="18" fill="#03aa5c" />
              <text x="5" y="12.5" fill="#fefefe" fontSize="9.5" fontWeight="700" fontFamily="monospace">02</text>
              <rect x="14" y="28" width="32" height="40" fill="#fefefe" stroke="#161616" strokeWidth="1.75" />
              <rect x="19" y="34" width="22" height="8" fill="#03aa5c" />
              <rect x="19" y="46" width="22" height="7" fill="#161616" fillOpacity="0.2" />
              <rect x="19" y="57" width="14" height="6" fill="#161616" />
              <text x="58" y="44" fill="#161616" fontSize="13" fontWeight="700" fontFamily="monospace">PARSE</text>
              <text x="58" y="60" fill="#027a42" fontSize="9.5" fontWeight="700" fontFamily="monospace">[OCR/TBL]</text>
            </g>

            {/* Connector 2 -> 3 */}
            <circle cx="390" cy="59" r="2.5" fill="#161616" />
            <line x1="393" y1="59" x2="449" y2="59" stroke="#161616" strokeWidth="1.6" className="ts-anim-flow" />
            <path d="M443 53.5 L449.5 59 L443 64.5" stroke="#03aa5c" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" />

            {/* Stage 03: CHUNKS */}
            <g transform="translate(454, 18)">
              <rect x="4" y="4" width="150" height="82" fill="#161616" />
              <rect x="0" y="0" width="150" height="82" fill="#fefefe" stroke="#161616" strokeWidth="2" />
              <rect x="0" y="0" width="26" height="18" fill="#161616" />
              <text x="5" y="12.5" fill="#fefefe" fontSize="9.5" fontWeight="700" fontFamily="monospace">03</text>
              <polygon
                points="32 26 48 35 48 53 32 62 16 53 16 35 32 26"
                fill="#03aa5c"
                fillOpacity="0.2"
                stroke="#161616"
                strokeWidth="1.8"
              />
              <line x1="32" y1="62" x2="32" y2="44" stroke="#161616" strokeWidth="1.6" />
              <line x1="48" y1="35" x2="32" y2="44" stroke="#161616" strokeWidth="1.6" />
              <line x1="16" y1="35" x2="32" y2="44" stroke="#161616" strokeWidth="1.6" />
              <rect x="29.5" y="41.5" width="5" height="5" fill="#03aa5c" className="ts-anim-pulse" />
              <text x="60" y="44" fill="#161616" fontSize="13" fontWeight="700" fontFamily="monospace">CHUNKS</text>
              <text x="60" y="60" fill="#52525b" fontSize="9.5" fontFamily="monospace">[SPLIT/QC]</text>
            </g>

            {/* Connector 3 -> 4 */}
            <circle cx="610" cy="59" r="2.5" fill="#161616" />
            <line x1="613" y1="59" x2="663" y2="59" stroke="#161616" strokeWidth="1.6" className="ts-anim-flow" />
            <path d="M657 53.5 L663.5 59 L657 64.5" stroke="#03aa5c" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" />

            {/* Stage 04: TOP-K / A-B */}
            <g transform="translate(668, 18)">
              <rect x="4" y="4" width="128" height="82" fill="#03aa5c" />
              <rect x="0" y="0" width="128" height="82" fill="#161616" stroke="#161616" strokeWidth="2" />
              <rect x="12" y="14" width="102" height="10" fill="#03aa5c" />
              <rect x="12" y="30" width="78" height="10" fill="#fefefe" />
              <rect x="12" y="46" width="52" height="10" fill="#71717a" />
              <text x="12" y="72" fill="#03aa5c" fontSize="10" fontWeight="700" fontFamily="monospace">
                &gt; TOP-K / A-B
              </text>
            </g>
          </svg>
        </div>
      </div>

      {/* Workflow Mode Selector Grid */}
      <div className="space-y-3">
        <span className="ts-eyebrow">CHỌN CHẾ ĐỘ KIỂM THỬ</span>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-[#dedede] border border-[#dedede] rounded-[3px] overflow-hidden">
          {WORKFLOW_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => onStartWorkflow(m.id)}
              className="group p-6 text-left bg-[#fefefe] hover:bg-[#f7f7f6] transition-colors flex flex-col justify-between min-h-[196px]"
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  {modeArt(m.id)}
                  <span className={m.primary ? 'ts-tag-teal' : 'ts-tag-mauve'}>{m.tag}</span>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-[15px] font-semibold text-[#161616] group-hover:text-black">
                      {m.title}
                    </h2>
                    <ArrowRight className="size-4 text-[#a1a1aa] group-hover:text-[#161616] group-hover:translate-x-0.5 transition-all shrink-0" />
                  </div>
                  <p className="text-[13px] text-[#52525b] leading-relaxed">{m.desc}</p>
                </div>
              </div>

              <div className="pt-4 mt-3 border-t border-[#ededeb] font-mono text-[11px] text-[#71717a] truncate">
                {m.stepsLabel}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Compact Live Metrics Strip for Active Run */}
      {activeRun && (
        <div className="space-y-3">
          <div className="ts-eyebrow">CHỈ SỐ HIỆN TẠI CỦA PHIÊN "{activeRun.name}"</div>
          <div className="grid grid-cols-2 md:grid-cols-4 border border-[#dedede] rounded-[3px] divide-x divide-[#dedede] bg-[#fefefe]">
            <div className="p-4 space-y-1">
              <div className="font-mono text-[11px] text-[#71717a] flex items-center gap-1.5">
                <FileSearch className="size-3.5" /> PARSING
              </div>
              <div className="font-mono text-xl font-semibold tabular-nums text-[#161616]">
                {pct(p.text_completeness)}
              </div>
              <div className="text-[11px] text-[#71717a]">Đọc đủ chữ · Đã chấm {p.rated ?? 0}</div>
            </div>

            <div className="p-4 space-y-1">
              <div className="font-mono text-[11px] text-[#71717a] flex items-center gap-1.5">
                <Layers className="size-3.5" /> CHUNKING
              </div>
              <div className="font-mono text-xl font-semibold tabular-nums text-[#161616]">
                {pct(c.chunk_integrity)}
              </div>
              <div className="text-[11px] text-[#71717a]">Toàn vẹn · Mẫu {c.sampled ?? 0}</div>
            </div>

            <div className="p-4 space-y-1">
              <div className="font-mono text-[11px] text-[#71717a] flex items-center gap-1.5">
                <Search className="size-3.5" /> RETRIEVAL
              </div>
              <div className="font-mono text-xl font-semibold tabular-nums text-[#161616]">
                {r ? pct(r.avg_contextual_precision) : '—'}
              </div>
              <div className="text-[11px] text-[#71717a]">
                {r ? `${r.total_testcases} TC · Phủ ${pct(r.avg_context_coverage)}` : 'Chưa chạy'}
              </div>
            </div>

            <div className="p-4 space-y-1">
              <div className="font-mono text-[11px] text-[#71717a] flex items-center gap-1.5">
                <GitCompare className="size-3.5" /> DATASET
              </div>
              <div className="font-mono text-xl font-semibold tabular-nums text-[#161616]">
                {overview?.chunk_count ?? activeRun.chunk_count ?? 0}
              </div>
              <div className="text-[11px] text-[#71717a]">
                Chunks trong {overview?.doc_count ?? activeRun.doc_count ?? 0} tài liệu
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
