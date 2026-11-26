import { useEffect, useRef } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Database,
  FileSearch,
  FlaskConical,
  Layers,
  Search,
  Settings,
} from 'lucide-react';
import type { WorkflowModeId } from './OverviewPage';

const stages = [
  {
    title: 'Dataset & Đồng bộ',
    icon: Database,
    purpose: 'Chuẩn bị dữ liệu để kiểm thử.',
    instructions: 'Tạo hoặc chọn phiên kiểm thử gắn với một Dataset trên RAGFlow. Nếu có tài liệu mới, tải lên và chạy parse. Khi xử lý xong, chọn “Đồng bộ RAGFlow” để lấy các đoạn văn bản (chunks).',
  },
  {
    title: 'Parsing',
    icon: FileSearch,
    purpose: 'Kiểm tra RAGFlow đọc tài liệu có đúng không.',
    instructions: 'Đối chiếu tài liệu gốc với nội dung trích xuất. Chấm theo mẫu và ghi lỗi như mất chữ, sai ký tự hoặc sai cấu trúc bảng.',
  },
  {
    title: 'Chunking',
    icon: Layers,
    purpose: 'Kiểm tra cách nội dung được chia thành các đoạn.',
    instructions: 'Xem các chunk mẫu và các cảnh báo về độ dài hoặc trùng lặp. Kiểm tra mỗi đoạn có đủ ngữ cảnh và có bị cắt giữa ý hay không.',
  },
  {
    title: 'Retrieval & So sánh',
    icon: Search,
    purpose: 'Đo khả năng tìm đúng đoạn cho từng câu hỏi.',
    instructions: 'Chuẩn bị bộ câu hỏi có căn cứ trong tài liệu gốc (Golden Dataset). Chạy cấu hình gốc (Baseline), xem và chấm các kết quả rồi chạy cấu hình khác trên cùng bộ câu hỏi để so sánh.',
  },
];

interface Props {
  onBack: () => void;
  onOpenSettings: () => void;
  onStartWorkflow: (mode: WorkflowModeId) => void;
}

export function PlatformGuidePage({ onBack, onOpenSettings, onStartWorkflow }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-9 px-4 py-6 sm:px-8 sm:py-8">
      <button type="button" onClick={onBack} className="ts-btn-ghost -ml-2.5">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Quay lại
      </button>

      <section className="grid overflow-hidden rounded-lg border border-[#dedede] lg:grid-cols-[1fr_19rem]">
        <div className="p-5 sm:p-8">
          <p className="ts-eyebrow mb-3 text-[#027a42]">RAGFlow QC</p>
          <h1 ref={titleRef} tabIndex={-1} className="text-3xl font-semibold leading-tight sm:text-4xl">
            Tổng quan và hướng dẫn
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[#52525b]">
            RAGFlow QC giúp bạn kiểm tra chất lượng dữ liệu mà hệ thống RAG dùng để trả lời câu hỏi.
            Bạn có thể lần theo lỗi từ kết quả tìm kiếm về cách chia đoạn và cách đọc tài liệu gốc,
            rồi so sánh các cấu hình để xem thay đổi nào cải thiện kết quả.
          </p>
          <button
            type="button"
            onClick={() => onStartWorkflow('full_pipeline')}
            className="ts-btn-primary mt-5 min-h-9"
          >
            Bắt đầu kiểm thử
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="ts-editorial-banner border-t border-[#dedede] p-5 sm:p-8 lg:border-l lg:border-t-0">
          <h2 className="text-base font-semibold">Thiết lập lần đầu</h2>
          <p className="mt-2 text-sm leading-relaxed text-[#3d3d3d]">
            Nhập URL và API key của RAGFlow trong Cài đặt, sau đó kiểm tra kết nối.
            Cấu hình LLM Judge nếu bạn muốn chấm tự động hoặc sinh câu hỏi Golden từ tài liệu gốc.
          </p>
          <button type="button" onClick={onOpenSettings} className="ts-btn-secondary mt-4 min-h-9">
            <Settings className="size-4" aria-hidden="true" />
            Mở Cài đặt
          </button>
        </div>
      </section>

      <section aria-labelledby="guide-workflow">
        <h2 id="guide-workflow" className="mb-4 text-xl font-semibold">Quy trình kiểm thử</h2>
        <ol className="grid gap-px overflow-hidden rounded-lg border border-[#dedede] bg-[#dedede] sm:grid-cols-2 lg:grid-cols-4">
          {stages.map(({ title, icon: Icon, purpose, instructions }, index) => (
            <li key={title} className="bg-white p-5">
              <div className="mb-4 flex items-center justify-between">
                <span className="grid size-9 place-items-center rounded-md bg-[#f2fbf6] text-[#027a42]">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="font-mono text-xs text-[#52525b]">Bước {index + 1}</span>
              </div>
              <h3 className="text-sm font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed">{purpose}</p>
              <p className="mt-2 text-sm leading-relaxed text-[#52525b]">{instructions}</p>
            </li>
          ))}
        </ol>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="guide-results" className="rounded-lg border border-[#dedede] p-5 sm:p-6">
          <h2 id="guide-results" className="text-lg font-semibold">Đọc kết quả so sánh</h2>
          <dl className="mt-3 space-y-3 text-sm leading-relaxed text-[#52525b]">
            <div>
              <dt className="font-medium text-[#161616]">Contextual Precision</dt>
              <dd>Cho biết các đoạn phù hợp có được xếp hạng cao trong kết quả tìm kiếm hay không.</dd>
            </div>
            <div>
              <dt className="font-medium text-[#161616]">Context Coverage</dt>
              <dd>Cho biết các đoạn tìm được bao phủ được bao nhiêu thông tin cần để trả lời câu hỏi.</dd>
            </div>
            <div>
              <dt className="font-medium text-[#161616]">Thay đổi Pass/Fail</dt>
              <dd>Mở từng câu chuyển từ đạt sang không đạt hoặc ngược lại để xem cấu hình mới ảnh hưởng đến câu nào.</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="guide-studio" className="rounded-lg border border-[#dedede] bg-[#f7f7f6] p-5 sm:p-6">
          <h2 id="guide-studio" className="text-lg font-semibold">Experiment Studio</h2>
          <p className="mt-3 text-sm leading-relaxed text-[#52525b]">
            Dùng Studio khi bạn muốn thay đổi cách RAGFlow đọc hoặc chia tài liệu và xem tác động lên cả ba tầng.
          </p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-[#52525b]">
            <li>Chọn Dataset làm Baseline (A) và xem đề xuất điều chỉnh cấu hình từ AI.</li>
            <li>Nhân bản sang Dataset mới (B), chỉnh cấu hình và chạy lại pipeline.</li>
            <li>Đối chiếu A/B ở cả ba tầng Parsing, Chunking và Retrieval.</li>
          </ol>
          <button
            type="button"
            onClick={() => onStartWorkflow('studio')}
            className="ts-btn-secondary mt-4 min-h-9"
          >
            <FlaskConical className="size-4" aria-hidden="true" />
            Mở Experiment Studio
          </button>
        </section>
      </div>
    </div>
  );
}
