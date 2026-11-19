import React, { useEffect, useState } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { RunItem } from '../types';

interface Props {
  activeRun: RunItem | null;
  onNavigate: (tab: string) => void;
  onReloadRuns: () => void;
}

const pct = (v?: number) => `${((v || 0) * 100).toFixed(0)}%`;

export const OverviewPage: React.FC<Props> = ({ activeRun, onNavigate, onReloadRuns }) => {
  const [overview, setOverview] = useState<any>(null);
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    if (!activeRun) return;
    api.getOverview(activeRun.id).then(setOverview);
  }, [activeRun?.id]);

  const handleSeedDemo = async () => {
    setSeeding(true);
    try {
      await api.seedDemo();
      onReloadRuns();
    } finally {
      setSeeding(false);
    }
  };

  const p = overview?.parsing || {};
  const c = overview?.chunking || {};
  const r = overview?.retrieval || null;

  return (
    <div className="max-w-5xl mx-auto px-8 py-9 space-y-8">
      {/* Editorial Hero Header (TypeSafe AI style) */}
      <div className="space-y-3">
        <div className="ts-eyebrow">
          RAGFLOW QC HARNESS · {activeRun ? activeRun.name.toUpperCase() : 'WORKSPACE'}
        </div>
        <h1 className="text-3xl font-semibold text-[#18181b] text-balance">
          Kiểm thử chất lượng hệ thống RAG
        </h1>

        {/* Signature Soft Mauve Editorial Banner */}
        <div className="ts-editorial-banner border border-[#ead8e4] rounded-[4px] px-5 py-4 space-y-1.5">
          <div className="text-[13px] font-semibold text-[#18181b]">
            {activeRun
              ? `Đang làm việc trên phiên "${activeRun.name}" (${overview?.doc_count ?? 0} tài liệu · ${overview?.chunk_count ?? 0} đoạn cắt)`
              : 'Chưa có phiên kiểm thử nào được khởi tạo'}
          </div>
          <p className="text-[13px] text-[#3f3f46] text-pretty">
            {activeRun
              ? 'Toàn bộ kết quả đọc file, cắt đoạn và tìm kiếm được lưu trực tiếp trong cơ sở dữ liệu local — tự động tính điểm và giữ lại nhãn chấm khi bạn thử nghiệm cấu hình mới.'
              : 'Bạn có thể kết nối trực tiếp tới RAGFlow API hoặc nạp nhanh bộ dữ liệu mẫu HIV/AIDS để trải nghiệm đủ 4 bước kiểm thử.'}
          </p>
          <div className="pt-1 flex flex-wrap items-center gap-4">
            {!activeRun ? (
              <button
                onClick={handleSeedDemo}
                disabled={seeding}
                className="text-[13px] font-medium text-[#2563eb] hover:underline inline-flex items-center gap-1"
              >
                <Sparkles className="size-3.5" />
                {seeding ? 'Đang tạo dữ liệu mẫu...' : 'Nạp ngay dữ liệu mẫu (HIV/AIDS Baseline + Exp1)'}
              </button>
            ) : (
              <button
                onClick={() => onNavigate('workspace')}
                className="text-[13px] font-medium text-[#2563eb] hover:underline"
              >
                Đồng bộ thêm tài liệu từ RAGFlow →
              </button>
            )}
            <button
              onClick={() => onNavigate('compare')}
              className="text-[13px] font-medium text-[#6d2e58] hover:underline"
            >
              Mở phòng so sánh cấu hình A/B
            </button>
          </div>
        </div>
      </div>

      {/* Capabilities / 4-Step Grid with bespoke thin-line SVG illustrations (like TypeSafe's Image Model Capabilities) */}
      <div className="space-y-3">
        <div className="ts-eyebrow">QUY TRÌNH 3 TẦNG KIỂM THỬ</div>
        <div className="grid grid-cols-1 md:grid-cols-2 border border-[#e6e6e3] rounded-[4px] divide-y md:divide-y-0 md:divide-x divide-[#e6e6e3] bg-[#fafaf9]">
          {/* Tile 1: Parsing */}
          <button
            onClick={() => onNavigate('parsing')}
            className="p-6 text-left hover:bg-white transition-colors relative flex flex-col justify-between min-h-[210px] border-b border-[#e6e6e3]"
          >
            <div className="flex items-start justify-between">
              {/* Bespoke line-art document scan illustration */}
              <svg viewBox="0 0 80 64" className="w-20 h-16 text-[#9e8ca0]" fill="none" stroke="currentColor" strokeWidth="1.4">
                <rect x="10" y="8" width="38" height="48" rx="3" />
                <line x1="17" y1="18" x2="41" y2="18" />
                <line x1="17" y1="26" x2="36" y2="26" />
                <rect x="17" y="33" width="24" height="14" rx="1.5" />
                <path d="M54 18 L66 18 L66 46 L54 46" strokeDasharray="3 3" />
                <circle cx="58" cy="32" r="5" />
                <line x1="61.5" y1="35.5" x2="67" y2="41" />
              </svg>
              <span className="ts-tag-mauve">Tầng 1 · Parsing</span>
            </div>

            <div className="pt-5 space-y-1">
              <div className="flex items-baseline justify-between">
                <span className="text-[15px] font-semibold text-[#18181b]">Chấm đọc file & OCR</span>
                <span className="font-mono text-sm font-semibold tabular-nums text-[#18181b]">
                  {activeRun ? pct(p.text_completeness) : '—'}
                </span>
              </div>
              <p className="text-[13px] text-[#71717a] text-pretty">
                Đối chiếu song song tài liệu gốc với kết quả RAGFlow trích xuất.
              </p>
              <div className="text-xs text-[#78716c] italic pt-1">
                Đọc đúng bảng: {activeRun ? pct(p.table_accuracy) : '—'} · Lỗi dấu/OCR: {activeRun ? pct(p.character_error_rate) : '—'}
              </div>
            </div>
          </button>

          {/* Tile 2: Chunking */}
          <button
            onClick={() => onNavigate('chunking')}
            className="p-6 text-left hover:bg-white transition-colors relative flex flex-col justify-between min-h-[210px] border-b border-[#e6e6e3]"
          >
            <div className="flex items-start justify-between">
              {/* Bespoke line-art segmented blocks / wireframe cube illustration */}
              <svg viewBox="0 0 80 64" className="w-20 h-16 text-[#9e8ca0]" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M12 16 L12 10 L18 10" />
                <path d="M62 10 L68 10 L68 16" />
                <path d="M12 48 L12 54 L18 54" />
                <path d="M62 54 L68 54 L68 48" />
                <polygon points="40 16 56 25 56 43 40 52 24 43 24 25 40 16" />
                <line x1="40" y1="52" x2="40" y2="34" />
                <line x1="56" y1="25" x2="40" y2="34" />
                <line x1="24" y1="25" x2="40" y2="34" />
              </svg>
              <span className="ts-tag-mauve">Tầng 2 · Chunking</span>
            </div>

            <div className="pt-5 space-y-1">
              <div className="flex items-baseline justify-between">
                <span className="text-[15px] font-semibold text-[#18181b]">Chấm chất lượng cắt đoạn</span>
                <span className="font-mono text-sm font-semibold tabular-nums text-[#18181b]">
                  {activeRun ? pct(c.chunk_integrity) : '—'}
                </span>
              </div>
              <p className="text-[13px] text-[#71717a] text-pretty">
                Chọn mẫu đầu–giữa–cuối, tự bắt lỗi đoạn vụn, số trang và trùng lặp.
              </p>
              <div className="text-xs text-[#78716c] italic pt-1">
                Tự đủ nghĩa: {activeRun ? pct(c.context_sufficiency) : '—'} · Dính rác: {activeRun ? pct(c.noise_rate) : '—'}
              </div>
            </div>
          </button>

          {/* Tile 3: Retrieval */}
          <button
            onClick={() => onNavigate('retrieval')}
            className="p-6 text-left hover:bg-white transition-colors relative flex flex-col justify-between min-h-[210px]"
          >
            <div className="flex items-start justify-between">
              {/* Bespoke line-art ranked retrieval illustration */}
              <svg viewBox="0 0 80 64" className="w-20 h-16 text-[#9e8ca0]" fill="none" stroke="currentColor" strokeWidth="1.4">
                <rect x="10" y="10" width="48" height="11" rx="2" />
                <rect x="10" y="26" width="38" height="11" rx="2" />
                <rect x="10" y="42" width="28" height="11" rx="2" />
                <circle cx="64" cy="15.5" r="3" />
                <path d="M56 32 L64 32 M60 28 L64 32 L60 36" />
              </svg>
              <span className="ts-tag-mauve">Tầng 3 · Retrieval</span>
            </div>

            <div className="pt-5 space-y-1">
              <div className="flex items-baseline justify-between">
                <span className="text-[15px] font-semibold text-[#18181b]">Chấm tìm kiếm & xếp hạng</span>
                <span className="font-mono text-sm font-semibold tabular-nums text-[#18181b]">
                  {r ? pct(r.avg_contextual_precision) : '—'}
                </span>
              </div>
              <p className="text-[13px] text-[#71717a] text-pretty">
                Chạy hàng loạt câu hỏi Golden Dataset, tự lưu cache nhãn chấm giữa các lần thử.
              </p>
              <div className="text-xs text-[#78716c] italic pt-1">
                {r ? `${r.total_testcases} câu hỏi · Độ phủ: ${pct(r.avg_context_coverage)}` : 'Chưa chạy bộ câu hỏi test'}
              </div>
            </div>
          </button>

          {/* Tile 4: Compare Lab */}
          <button
            onClick={() => onNavigate('compare')}
            className="p-6 text-left hover:bg-white transition-colors relative flex flex-col justify-between min-h-[210px]"
          >
            <div className="flex items-start justify-between">
              {/* Bespoke line-art A/B diff illustration */}
              <svg viewBox="0 0 80 64" className="w-20 h-16 text-[#9e8ca0]" fill="none" stroke="currentColor" strokeWidth="1.4">
                <rect x="10" y="14" width="24" height="36" rx="2" />
                <rect x="46" y="14" width="24" height="36" rx="2" />
                <path d="M34 26 L46 26 M42 22 L46 26 L42 30" />
                <path d="M46 38 L34 38 M38 34 L34 38 L38 42" />
              </svg>
              <span className="ts-tag-mauve">A/B Lab</span>
            </div>

            <div className="pt-5 space-y-1">
              <div className="flex items-baseline justify-between">
                <span className="text-[15px] font-semibold text-[#18181b]">So sánh cấu hình & tìm lỗi gốc</span>
                <ArrowRight className="size-4 text-[#71717a]" />
              </div>
              <p className="text-[13px] text-[#71717a] text-pretty">
                Đối chiếu Baseline với thử nghiệm mới, lọc ngay câu Pass → Fail và tầng gây lỗi.
              </p>
              <div className="text-xs text-[#78716c] italic pt-1">
                Đổi chunk size, overlap, tỷ trọng vector/keyword, bật/tắt rerank
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* Bottom Quick Action List (like TypeSafe's MORE EXAMPLES) */}
      <div className="space-y-2.5">
        <div className="ts-eyebrow">THAO TÁC NHANH</div>
        <div className="divide-y divide-[#ededeb] border-t border-b border-[#ededeb]">
          <QuickRow
            title="Quản lý bộ tài liệu gốc"
            desc="Tải file PDF, DOCX, HTML, Excel lên kho local và đẩy sang RAGFlow"
            onClick={() => onNavigate('workspace')}
          />
          <QuickRow
            title="Chấm đọc file (Parsing)"
            desc="Mở màn hình chia đôi tài liệu gốc ↔ đoạn RAGFlow trích xuất"
            onClick={() => onNavigate('parsing')}
          />
          <QuickRow
            title="Chạy kiểm thử tìm kiếm (Retrieval)"
            desc="Đánh giá bộ câu hỏi Local / Global / Multi-hop và tự tính điểm"
            onClick={() => onNavigate('retrieval')}
          />
        </div>
      </div>
    </div>
  );
};

const QuickRow: React.FC<{ title: string; desc: string; onClick: () => void }> = ({
  title,
  desc,
  onClick,
}) => (
  <button
    onClick={onClick}
    className="w-full py-3 px-1 flex items-center justify-between gap-4 hover:bg-[#fafaf9] text-left transition-colors"
  >
    <div className="flex flex-wrap items-baseline gap-2.5">
      <span className="text-[13px] font-medium text-[#18181b]">{title}</span>
      <span className="text-[13px] text-[#71717a]">{desc}</span>
    </div>
    <ArrowRight className="size-3.5 text-[#a1a1aa] shrink-0" />
  </button>
);
