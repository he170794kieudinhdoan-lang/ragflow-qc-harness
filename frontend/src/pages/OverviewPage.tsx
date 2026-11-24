import React, { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import {
  ArrowRight,
  FileSearch,
  GitCompare,
  Layers,
  Search,
} from 'lucide-react';
import { api } from '../api/client';
import { AnimatedNumber } from '../components/AnimatedNumber';
import { RunItem } from '../types';

export type WorkflowModeId = 'full_pipeline' | 'retrieval_only';

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
    tag: 'Khuyên dùng · 3 Tầng',
    title: 'Kiểm thử toàn luồng 3 tầng (A → Z)',
    desc: 'Quy trình chuẩn đầy đủ: chọn Dataset & đồng bộ chunks, chấm Parsing (10+ file đại diện), chấm Chunking (5 chunk/file), chạy Golden Dataset Retrieval và so sánh A/B đa cấu hình.',
    stepsLabel: 'Dataset → Parsing → Chunking → Retrieval → A/B & Bug Report',
    primary: true,
  },
  {
    id: 'retrieval_only',
    tag: 'Chế độ nhanh',
    title: 'Chấm nhanh Retrieval & So sánh A/B',
    desc: 'Đi thẳng vào Golden Dataset (40 testcase), chạy batch /api/v1/retrieval top-10, chấm Relevancy và đối chiếu bảng đa cấu hình / Top 5 Bug Report.',
    stepsLabel: 'Golden & Retrieval → So sánh đa Run & Bug Report',
  },
];

interface Props {
  activeRun: RunItem | null;
  onStartWorkflow: (mode: WorkflowModeId) => void;
}

const pct = (v?: number) => `${((v || 0) * 100).toFixed(0)}%`;

let hasPlayedHomepageEntrance = false;

export const OverviewPage: React.FC<Props> = ({ activeRun, onStartWorkflow }) => {
  const [overview, setOverview] = useState<any>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const exitingRef = useRef(false);

  const handleSelectMode = (mode: WorkflowModeId) => {
    if (exitingRef.current) return;
    if (!pageRef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onStartWorkflow(mode);
      return;
    }
    exitingRef.current = true;
    const targets = pageRef.current.querySelectorAll('.gsap-exit');
    gsap.to(targets, {
      x: 72,
      opacity: 0,
      duration: 0.36,
      stagger: 0.045,
      ease: 'power3.in',
    });
    // Start loading curtain slightly before exit finishes so there is zero white/empty gap
    window.setTimeout(() => {
      onStartWorkflow(mode);
    }, 240);
  };

  useEffect(() => {
    if (!activeRun) {
      setOverview(null);
      return;
    }
    api.getOverview(activeRun.id).then(setOverview).catch(() => {});
  }, [activeRun?.id]);

  // Play staggered entrance ONLY on initial page load; skip when navigating back to Homepage
  useEffect(() => {
    if (hasPlayedHomepageEntrance || !pageRef.current) return;
    hasPlayedHomepageEntrance = true;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        '.gsap-reveal',
        { opacity: 0, y: 12 },
        { opacity: 1, y: 0, duration: 0.42, stagger: 0.06, ease: 'power3.out', delay: 0.12 }
      );
      gsap.fromTo(
        '.gsap-card',
        { opacity: 0, y: 14 },
        { opacity: 1, y: 0, duration: 0.4, stagger: 0.08, ease: 'power3.out', delay: 0.28 }
      );
    }, pageRef);
    return () => ctx.revert();
  }, []);

  const p = overview?.parsing || {};
  const c = overview?.chunking || {};
  const r = overview?.retrieval || null;

  const modeArt = (id: WorkflowModeId) => {
    if (id === 'full_pipeline') {
      return (
        <svg viewBox="0 0 112 64" className="w-[104px] h-[60px] shrink-0" fill="none" strokeWidth="1.25">
          {/* Node 1: Doc */}
          <rect x="4" y="14" width="24" height="32" rx="2" stroke="#141414" fill="#fefefe" />
          <line x1="9" y1="23" x2="23" y2="23" stroke="#94a3b8" />
          <line x1="9" y1="29" x2="20" y2="29" stroke="#94a3b8" />
          <rect x="9" y="34" width="14" height="7" rx="1" stroke="#027a42" fill="#03aa5c" fillOpacity="0.18" />
          {/* Arrow 1 -> 2 */}
          <path d="M31 30 L41 30" stroke="#027a42" strokeDasharray="2.5 2" />
          <path d="M38 27 L41 30 L38 33" stroke="#027a42" />
          {/* Node 2: Cube */}
          <polygon points="56 15 69 22.5 69 37.5 56 45 43 37.5 43 22.5 56 15" stroke="#141414" fill="#03aa5c" fillOpacity="0.12" />
          <line x1="56" y1="45" x2="56" y2="30" stroke="#141414" />
          <line x1="69" y1="22.5" x2="56" y2="30" stroke="#141414" />
          <line x1="43" y1="22.5" x2="56" y2="30" stroke="#141414" />
          {/* Arrow 2 -> 3 */}
          <path d="M72 30 L82 30" stroke="#027a42" strokeDasharray="2.5 2" />
          <path d="M79 27 L82 30 L79 33" stroke="#027a42" />
          {/* Node 3: Ranked results */}
          <rect x="85" y="16" width="23" height="7" rx="1.5" stroke="#027a42" fill="#03aa5c" fillOpacity="0.2" />
          <rect x="85" y="27" width="18" height="7" rx="1.5" stroke="#141414" />
          <rect x="85" y="38" width="13" height="7" rx="1.5" stroke="#94a3b8" />
        </svg>
      );
    }
    return (
      <svg viewBox="0 0 96 64" className="w-[88px] h-[60px] shrink-0" fill="none" strokeWidth="1.25">
        <rect x="6" y="10" width="52" height="11" rx="2" stroke="#027a42" fill="#03aa5c" fillOpacity="0.15" />
        <rect x="6" y="26" width="42" height="11" rx="2" stroke="#141414" fill="#fefefe" />
        <rect x="6" y="42" width="30" height="11" rx="2" stroke="#94a3b8" />
        <circle cx="74" cy="24" r="10" stroke="#141414" fill="#fefefe" />
        <circle cx="74" cy="24" r="4" stroke="#027a42" />
        <line x1="81" y1="31" x2="89" y2="39" stroke="#141414" strokeWidth="1.6" />
      </svg>
    );
  };

  return (
    <div className="relative min-h-full w-full bg-[#fefefe] overflow-hidden">
      {/* Full-bleed subtle architectural illustration backdrop matched to #FEFEFE */}
      <div
        aria-hidden="true"
        className="pointer-events-none select-none absolute inset-0 bg-no-repeat bg-bottom bg-cover opacity-[0.26]"
        style={{
          backgroundImage: 'url(/homepage-bg.png?v=2)',
          maskImage: 'linear-gradient(to top, rgba(0,0,0,1) 45%, rgba(0,0,0,0.45) 80%, rgba(0,0,0,0) 100%)',
          WebkitMaskImage: 'linear-gradient(to top, rgba(0,0,0,1) 45%, rgba(0,0,0,0.45) 80%, rgba(0,0,0,0) 100%)',
        }}
      />
      {/* Subtle gray veil (7%) so crisp white sections pop cleanly off the architectural backdrop */}
      <div
        aria-hidden="true"
        className="pointer-events-none select-none absolute inset-0 bg-[#0f172a]/[0.07]"
      />
      <div ref={pageRef} className="relative z-10 max-w-5xl mx-auto px-8 py-10 space-y-10">
      {/* Editorial Hero */}
      <div className="space-y-4">
        <span className="ts-eyebrow gsap-reveal gsap-exit inline-block">
          RAGFLOW QC · {activeRun ? activeRun.name.toUpperCase() : 'WORKSPACE'}
        </span>

        <h1 className="gsap-reveal gsap-exit text-[32px] leading-[1.15] font-semibold tracking-[-0.02em] text-[#161616]">
          Kiểm thử chất lượng hệ thống RAG theo luồng chuẩn hóa.
        </h1>

        <p className="gsap-reveal gsap-exit text-[14px] text-[#3d3d3d] max-w-2xl leading-relaxed">
          Chọn chế độ kiểm thử bên dưới để bắt đầu. Các bước mở tự do sau khi đồng bộ chunks, giúp bạn linh hoạt
          chấm mẫu Parsing, chấm Chunking, chạy 40 testcase Retrieval và xuất báo cáo Excel / Bug Report.
        </p>

        {/* Refined Architectural Glass Pipeline Schematic (Monochrome + Sky Blue) */}
        <div className="gsap-reveal gsap-exit bg-[#fefefe]/78 backdrop-blur-[4px] border border-[#e2e8f0] hover:border-[#03aa5c]/70 rounded-lg transition-colors px-5 py-3.5 overflow-hidden select-none shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <svg
            viewBox="0 0 820 106"
            className="w-full h-[88px] md:h-[100px] block"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Subtle architectural registration hairlines */}
            <path d="M2 10 L2 2 L10 2" stroke="#cbd5e1" strokeWidth="1.2" />
            <path d="M810 2 L818 2 L818 10" stroke="#cbd5e1" strokeWidth="1.2" />
            <path d="M2 96 L2 104 L10 104" stroke="#cbd5e1" strokeWidth="1.2" />
            <path d="M810 104 L818 104 L818 96" stroke="#cbd5e1" strokeWidth="1.2" />

            {/* Stage 01: DOCS */}
            <g transform="translate(18, 15)">
              <rect x="0" y="0" width="150" height="76" rx="5" fill="#ffffff" fillOpacity="0.92" stroke="#cbd5e1" strokeWidth="1.1" />
              <circle cx="137" cy="11" r="2.5" fill="#03aa5c" className="ts-anim-pulse" />
              {/* Stacked pages */}
              <rect x="20" y="19" width="24" height="34" rx="1.5" fill="#ffffff" stroke="#cbd5e1" strokeWidth="1" strokeDasharray="2 2" />
              <rect x="15" y="23" width="24" height="34" rx="1.5" fill="#f8fafc" stroke="#141414" strokeWidth="1.2" />
              <line x1="20" y1="32" x2="34" y2="32" stroke="#64748b" strokeWidth="1.1" />
              <line x1="20" y1="39" x2="31" y2="39" stroke="#64748b" strokeWidth="1.1" />
              <line x1="20" y1="46" x2="33" y2="46" stroke="#64748b" strokeWidth="1.1" />
              {/* Sky-blue optical scan beam */}
              <g className="ts-anim-scan">
                <rect x="14" y="25" width="26" height="6" fill="#03aa5c" fillOpacity="0.22" />
                <line x1="12" y1="28" x2="42" y2="28" stroke="#027a42" strokeWidth="1.5" />
              </g>
              <text x="53" y="38" fill="#141414" fontSize="12" fontWeight="700" fontFamily="monospace" letterSpacing="0.06em">DOCS</text>
              <text x="53" y="53" fill="#64748b" fontSize="9.5" fontFamily="monospace">PDF · DOCX · HTML</text>
            </g>

            {/* Connector 1 -> 2 */}
            <line x1="172" y1="53" x2="226" y2="53" stroke="#cbd5e1" strokeWidth="1.2" strokeDasharray="3 3" />
            <circle cy="53" r="2.5" fill="#03aa5c">
              <animate attributeName="cx" values="174;224" dur="1.8s" repeatCount="indefinite" />
            </circle>
            <path d="M222 49 L227 53 L222 57" stroke="#027a42" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />

            {/* Stage 02: PARSE */}
            <g transform="translate(232, 15)">
              <rect x="0" y="0" width="154" height="76" rx="5" fill="#ffffff" fillOpacity="0.92" stroke="#cbd5e1" strokeWidth="1.1" />
              <rect x="15" y="19" width="28" height="38" rx="1.5" fill="#f8fafc" stroke="#141414" strokeWidth="1.2" />
              <rect x="20" y="25" width="18" height="5.5" rx="1" fill="#03aa5c" className="ts-anim-ocr-1" />
              <rect x="20" y="34" width="18" height="5.5" rx="1" fill="#027a42" fillOpacity="0.65" className="ts-anim-ocr-2" />
              <rect x="20" y="43" width="12" height="5.5" rx="1" fill="#334155" className="ts-anim-ocr-3" />
              <text x="54" y="38" fill="#141414" fontSize="12" fontWeight="700" fontFamily="monospace" letterSpacing="0.06em">PARSE</text>
              <text x="54" y="53" fill="#027a42" fontSize="9.5" fontWeight="600" fontFamily="monospace">OCR · TABLE · IMG</text>
            </g>

            {/* Connector 2 -> 3 */}
            <line x1="390" y1="53" x2="444" y2="53" stroke="#cbd5e1" strokeWidth="1.2" strokeDasharray="3 3" />
            <circle cy="53" r="2.5" fill="#03aa5c">
              <animate attributeName="cx" values="392;442" dur="1.8s" begin="0.5s" repeatCount="indefinite" />
            </circle>
            <path d="M440 49 L445 53 L440 57" stroke="#027a42" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />

            {/* Stage 03: CHUNKS */}
            <g transform="translate(450, 15)">
              <rect x="0" y="0" width="154" height="76" rx="5" fill="#ffffff" fillOpacity="0.92" stroke="#cbd5e1" strokeWidth="1.1" />
              {/* Clean isometric wireframe cube */}
              <polygon
                points="17 36 31 44 45 36 45 51 31 59 17 51"
                fill="#f8fafc"
                stroke="#141414"
                strokeWidth="1.2"
              />
              <line x1="31" y1="59" x2="31" y2="44" stroke="#141414" strokeWidth="1.1" />
              <g className="ts-anim-cube-top">
                <polygon
                  points="31 24 45 32 31 40 17 32"
                  fill="#03aa5c"
                  fillOpacity="0.28"
                  stroke="#027a42"
                  strokeWidth="1.2"
                />
              </g>
              <text x="56" y="38" fill="#141414" fontSize="12" fontWeight="700" fontFamily="monospace" letterSpacing="0.06em">CHUNKS</text>
              <text x="56" y="53" fill="#64748b" fontSize="9.5" fontFamily="monospace">5-METRIC · LLM QC</text>
            </g>

            {/* Connector 3 -> 4 */}
            <line x1="608" y1="53" x2="660" y2="53" stroke="#cbd5e1" strokeWidth="1.2" strokeDasharray="3 3" />
            <circle cy="53" r="2.5" fill="#03aa5c">
              <animate attributeName="cx" values="610;658" dur="1.8s" begin="1.0s" repeatCount="indefinite" />
            </circle>
            <path d="M656 49 L661 53 L656 57" stroke="#027a42" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />

            {/* Stage 04: TOP-K / A-B — Sleek charcoal accent card */}
            <g transform="translate(666, 15)">
              <rect x="0" y="0" width="136" height="76" rx="5" fill="#141414" stroke="#141414" strokeWidth="1.1" />
              <rect x="13" y="15" width="96" height="7.5" rx="1.5" fill="#03aa5c" className="ts-anim-bar-1" />
              <rect x="13" y="28" width="74" height="7.5" rx="1.5" fill="#e2e8f0" className="ts-anim-bar-2" />
              <rect x="13" y="41" width="52" height="7.5" rx="1.5" fill="#64748b" className="ts-anim-bar-3" />
              <text x="13" y="64" fill="#03aa5c" fontSize="9.5" fontWeight="700" fontFamily="monospace" letterSpacing="0.05em">
                &gt; TOP-K / A-B
              </text>
              <rect x="102" y="56" width="5" height="9" rx="0.5" fill="#03aa5c" className="ts-anim-blink" />
            </g>
          </svg>
        </div>
      </div>

      {/* Workflow Mode Selector Grid */}
      <div className="space-y-3 gsap-exit">
        <span className="ts-eyebrow">CHỌN CHẾ ĐỘ KIỂM THỬ</span>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-[#dedede] border border-[#dedede] rounded-[3px] overflow-hidden">
          {WORKFLOW_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => handleSelectMode(m.id)}
              className="gsap-card group p-6 text-left bg-[#fefefe]/90 backdrop-blur-[2px] hover:bg-[#f7f7f6]/95 transition-colors flex flex-col justify-between min-h-[196px]"
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
        <div className="space-y-3 gsap-reveal gsap-exit">
          <div className="ts-eyebrow">CHỈ SỐ HIỆN TẠI CỦA PHIÊN "{activeRun.name}"</div>
          <div className="grid grid-cols-2 md:grid-cols-4 border border-[#dedede] rounded-[3px] divide-x divide-[#dedede] bg-[#fefefe]/90 backdrop-blur-[2px]">
            <div className="p-4 space-y-1">
              <div className="font-mono text-[11px] text-[#71717a] flex items-center gap-1.5">
                <FileSearch className="size-3.5" /> PARSING
              </div>
              <div className="font-mono text-xl font-semibold tabular-nums text-[#161616]">
                <AnimatedNumber value={(p.text_completeness || 0) * 100} suffix="%" />
              </div>
              <div className="text-[11px] text-[#71717a]">Đọc đủ chữ · Đã chấm {p.rated ?? 0}</div>
            </div>

            <div className="p-4 space-y-1">
              <div className="font-mono text-[11px] text-[#71717a] flex items-center gap-1.5">
                <Layers className="size-3.5" /> CHUNKING
              </div>
              <div className="font-mono text-xl font-semibold tabular-nums text-[#161616]">
                <AnimatedNumber value={(c.chunk_integrity || 0) * 100} suffix="%" />
              </div>
              <div className="text-[11px] text-[#71717a]">Toàn vẹn · Mẫu {c.sampled ?? 0}</div>
            </div>

            <div className="p-4 space-y-1">
              <div className="font-mono text-[11px] text-[#71717a] flex items-center gap-1.5">
                <Search className="size-3.5" /> RETRIEVAL
              </div>
              <div className="font-mono text-xl font-semibold tabular-nums text-[#161616]">
                {r ? <AnimatedNumber value={(r.avg_contextual_precision || 0) * 100} suffix="%" /> : '—'}
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
                <AnimatedNumber value={overview?.chunk_count ?? activeRun.chunk_count ?? 0} />
              </div>
              <div className="text-[11px] text-[#71717a]">
                Chunks trong {overview?.doc_count ?? activeRun.doc_count ?? 0} tài liệu
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};
