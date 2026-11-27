import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  FileSearch,
  FlaskConical,
  Layers,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import type { WorkflowModeId } from './OverviewPage';

interface Props {
  onBack: () => void;
  onOpenSettings: () => void;
  onStartWorkflow: (mode: WorkflowModeId) => void;
}

const TOC_ITEMS = [
  { id: 'sec-arch', num: '01', label: 'Kiến trúc & Nguyên lý' },
  { id: 'sec-steps', num: '02', label: 'Quy trình 5 bước' },
  { id: 'sec-params', num: '03', label: 'Thông số RAGFlow' },
  { id: 'sec-sampling', num: '04', label: 'Lấy mẫu & Smart Cache' },
  { id: 'sec-metrics', num: '05', label: 'Chỉ số & Ngưỡng đạt' },
  { id: 'sec-playbook', num: '06', label: 'Lỗi → Cách sửa' },
  { id: 'sec-ab', num: '07', label: 'So sánh A/B & Excel' },
  { id: 'sec-faq', num: '08', label: 'Câu hỏi thường gặp' },
];

const STEP_GUIDES = [
  {
    id: 'b1',
    step: 'Bước 1',
    title: 'Dataset & Gợi ý Baseline',
    icon: Database,
    goal: 'Chuẩn bị bộ tài liệu gốc và chốt cấu hình Parse/Chunk khởi đầu hợp lý trước khi chạy Parse trên RAGFlow.',
    actions: [
      'Chọn Dataset hiện có ở dropdown góc trên phải (hoặc bấm "+ Tạo Dataset mới" ngay trong dropdown để tạo Dataset mới trực tiếp trên RAGFlow).',
      'Bấm "Thêm file" để tải tài liệu gốc (PDF, DOCX, XLSX, PPTX, HTML, MD). File mới chỉ lưu local chờ sẵn, chưa tự động Parse.',
      'Bấm "Gợi ý Baseline": hệ thống quét cấu trúc toàn bộ tài liệu trong Dataset (phát hiện trang scan, mật độ bảng biểu, độ dài đoạn, văn bản điều khoản) rồi đề xuất cấu hình tối ưu.',
      'Bấm "Áp dụng cấu hình" → xác nhận các thay đổi sẽ đồng bộ thẳng vào Pipeline của Dataset trên RAGFlow. Có thể bấm "Cấu hình Baseline" để xem/chỉnh đủ 6 nhóm thông số.',
      'Bấm "Đẩy & Parse" để đẩy file mới lên RAGFlow và bắt đầu Parse, hoặc bấm "Đồng bộ RAGFlow" để kéo toàn bộ chunks mới nhất về (tự dọn các file đã bị xóa trên RAGFlow).',
    ],
    tips: [
      'Nút ▷ ở từng dòng cho phép Parse lại riêng 1 file sau khi bạn đổi cấu hình để kiểm tra nhanh.',
      'Nút 🗑 xóa tài liệu trên cả RAGFlow lẫn DB local — tránh tình trạng xóa local rồi đồng bộ lại bị hiện lại.',
    ],
  },
  {
    id: 'b2',
    step: 'Bước 2',
    title: 'Kiểm định đọc tài liệu (Parsing QC)',
    icon: FileSearch,
    goal: 'Kiểm tra xem RAGFlow có đọc đúng chữ, giữ nguyên cấu trúc bảng biểu và nhận dạng tốt trang ảnh scan so với tài liệu gốc hay không.',
    actions: [
      'Mở tab Parsing: hệ thống tự tách các đoạn mẫu đại diện từ tài liệu gốc (mặc định tối đa 25 đoạn/file) và ghép khớp với chunks RAGFlow trích xuất được.',
      'Quan sát bản đồ ô màu theo từng tài liệu (Xanh = khớp tốt, Đỏ = nghi ngờ lỗi đọc/mất chữ, Xám = chưa chấm).',
      'Bấm "Chấm LLM" hoặc "Chấm lại bằng LLM" để AI tự động đối chiếu ngữ nghĩa giữa đoạn gốc và chunk RAGFlow. Nếu còn trang ảnh/scan chưa OCR, hệ thống tự chạy RapidOCR nội bộ trước khi chấm.',
      'Bấm vào từng ô đỏ để xem đối chiếu song song Gốc ↔ Đọc, xác nhận hoặc chỉnh mã lỗi (P1–P10) và ghi chú.',
      'Dùng nút "Duyệt nhanh" hoặc chuyển sang dạng bảng để rà soát toàn bộ kết quả theo từng tài liệu.',
    ],
    tips: [
      'Có thể đổi số "đoạn/file" rồi bấm "Tách lại" khi cần kiểm tra dày hơn trên các tài liệu rất dài.',
      'Mọi kết quả chấm ở Bước 2 chỉ lưu tại SQLite local, không làm thay đổi dữ liệu trên RAGFlow.',
    ],
  },
  {
    id: 'b3',
    step: 'Bước 3',
    title: 'Kiểm định cắt đoạn (Chunking QC)',
    icon: Layers,
    goal: 'Đánh giá chất lượng chia đoạn (chunking): đoạn có đủ ngữ cảnh không, có bị quá ngắn/quá dài, cắt vỡ bảng biểu hoặc lặp nội dung hay không.',
    actions: [
      'Mở tab Chunking: xem ngay tổng số chunk, phân bổ độ dài và danh sách cờ cảnh báo tự động (quá ngắn, quá dài, nghi ngờ vỡ bảng, trùng lặp).',
      'Hệ thống tự tính cỡ mẫu đại diện theo phương pháp thống kê (Bankier/Cochran) để bạn không phải đọc thủ công hàng nghìn chunk.',
      'Lọc theo từng tài liệu hoặc theo loại cờ lỗi để tập trung vào các chunk có vấn đề.',
      'Chấm tự động bằng AI Judge (hoặc rà soát thủ công ở chế độ bảng / chế độ chấm chi tiết) và gắn mã lỗi C1–C8.',
    ],
    tips: [
      'Chunk quá nhỏ (< 100 ký tự) thường gây nhiễu tìm kiếm; chunk cắt đôi giữa bảng khiến câu hỏi tra số liệu bị sai.',
      'Kết hợp tỷ lệ lỗi ở Bước 3 với Bước 2 để quyết định có cần tăng Recommended chunk size, Overlapped percent hay Table context window.',
    ],
  },
  {
    id: 'b4',
    step: 'Bước 4',
    title: 'Golden Dataset, Retrieval & Auto-Tune',
    icon: Search,
    goal: 'Đo độ chính xác truy xuất Top-K trên bộ câu hỏi chuẩn và tự động tìm bộ tham số tìm kiếm tốt nhất.',
    actions: [
      'Ở tab "Bộ câu hỏi Golden": bấm "Sinh tự động" để tạo bộ câu hỏi từ chính tài liệu gốc (gồm 3 loại: Local, Global, Multi-hop) theo phong cách hỏi thực tế, hoặc nhập từ file Excel có sẵn.',
      'Bấm "Chạy Baseline" để chạy Retrieval trên RAGFlow với cấu hình tìm kiếm hiện tại (Top-N, Ngưỡng lọc, Tỷ trọng Vector, Rerank) và chấm Relevancy bằng LLM hoặc Rule.',
      'Xem chi tiết từng câu hỏi ở tab "Kết quả Retrieval": có thể sửa tay nhãn Đúng/Sai cho từng chunk — nhãn sửa tay được lưu ngay vào Smart Cache cho các lần chạy sau.',
      'Mở tab "Auto-Tune": chọn dải tham số cần thử (Vector Weight, Threshold, Top-K, Rerank) để hệ thống tự động quét, xếp hạng tổ hợp thắng cuộc theo Precision, Coverage, MRR.',
    ],
    tips: [
      'Smart Cache luôn bật mặc định: nếu 2 lần chạy trả về cùng cặp (Câu hỏi, Chunk), hệ thống kế thừa nhãn cũ giúp chạy nhanh hơn, tiết kiệm API và so sánh A/B công bằng.',
      'Không nên đổi bộ câu hỏi Golden giữa chừng khi đang so sánh các lần chạy trên cùng một Dataset.',
    ],
  },
  {
    id: 'b5',
    step: 'Bước 5',
    title: 'So sánh A/B 2 Datasets & Báo cáo Excel',
    icon: FlaskConical,
    goal: 'Kiểm chứng định lượng xem bộ cấu hình mới [B] có thực sự cải thiện chất lượng 3 tầng so với Baseline [A] hay không.',
    actions: [
      'Vào chế độ "So sánh 2 Datasets" (Experiment Studio) từ Trang chủ hoặc thanh điều hướng.',
      'Chọn Dataset gốc làm Baseline [A], sau đó bấm "Nhân bản cấu hình này sang [B]".',
      'Trong bảng cấu hình 6 nhóm, chỉ điều chỉnh 1–2 thông số mục tiêu (ví dụ: tăng Recommended chunk size 512 → 1.024 và Table context window 0 → 128) — các ô vừa đổi sẽ được đánh dấu nổi bật kèm giá trị gốc.',
      'Bấm "Khởi chạy toàn quy trình": hệ thống tự tạo Dataset [B] trên RAGFlow, đẩy file, chạy Parse, đồng bộ và chấm tự động 3 tầng.',
      'Đối chiếu trực diện bảng so sánh A → B (tỷ lệ đạt Parsing, Chunking, Retrieval Precision/Coverage, danh sách câu Pass↔Fail) và xuất báo cáo Excel tổng hợp.',
    ],
    tips: [
      'Nguyên tắc thí nghiệm tốt: mỗi nhánh [B] chỉ nên thay đổi 1 nhóm giả thuyết để biết chắc thông số nào mang lại cải thiện.',
    ],
  },
];

const RAGFLOW_PARAMS = [
  {
    group: 'Dataset',
    name: 'Chunk method',
    ragflowKey: 'parser_id',
    desc: 'Bộ khuôn đọc tài liệu chính của Dataset (General, Laws, Table, Presentation, Paper, Q&A).',
    when: 'Dùng General cho kho hỗn hợp; tách riêng Presentation cho Slide, Laws cho văn bản Chương/Điều/Khoản, Table cho Excel tra cứu.',
  },
  {
    group: 'Parser',
    name: 'Parser (PDF & Spreadsheet)',
    ragflowKey: 'Parser → parse_method',
    desc: 'Động cơ đọc PDF và bảng tính: DeepDOC (nhận diện bố cục, bảng & OCR) hoặc Plain Text (chỉ trích chữ thuần).',
    when: 'Bắt buộc dùng DeepDOC nếu có PDF scan, nhiều bảng biểu hoặc bố cục nhiều cột; dùng Plain Text khi toàn bộ là văn bản thuần nhẹ.',
  },
  {
    group: 'General Chunker',
    name: 'Recommended chunk size',
    ragflowKey: 'chunk_token_size',
    desc: 'Độ dài mục tiêu của mỗi đoạn kiến thức tính theo token (1 token ≈ 0,75 từ tiếng Việt).',
    when: 'Đoạn ngắn, hỏi đáp trực tiếp: 384–512. Tài liệu nhiều bảng lớn hoặc mục dài: 768–1.024 để hạn chế cắt đôi bảng.',
  },
  {
    group: 'General Chunker',
    name: 'Overlapped percent (%)',
    ragflowKey: 'overlapped_percent',
    desc: 'Tỷ lệ phần trăm nội dung gối đầu giữa hai đoạn liên tiếp (0% – 30%).',
    when: 'Đặt 5–10% khi nội dung liên mạch hoặc nhiều điều khoản/tiêu đề dễ bị cắt ở ranh giới đoạn; để 0% nếu mỗi mục đã hoàn toàn độc lập.',
  },
  {
    group: 'General Chunker',
    name: 'Table context window',
    ragflowKey: 'table_context_size',
    desc: 'Số token ngữ cảnh (tiêu đề bảng, chú thích trước/sau bảng) được giữ kèm khi cắt bảng biểu.',
    when: 'Đặt 64–128 khi kho có nhiều bảng biểu để AI hiểu bảng đó đang nói về chỉ tiêu/giai đoạn nào.',
  },
  {
    group: 'Retrieval',
    name: 'Vector weight & Threshold',
    ragflowKey: 'vector_similarity_weight / similarity_threshold',
    desc: 'Cân bằng giữa tìm theo ngữ nghĩa (Vector) và tìm khớp từ khóa (Keyword), cùng ngưỡng lọc tối thiểu.',
    when: 'Tài liệu nhiều mã số, tên thuốc, điều luật: giữ Vector thấp (0.2–0.35). Câu hỏi diễn đạt tự do/đồng nghĩa: tăng Vector (0.4–0.6) hoặc bật Rerank.',
  },
];

const METRICS_GUIDE = [
  {
    layer: 'Parsing',
    metric: 'Tỷ lệ Đạt (Pass Rate)',
    meaning: 'Phần trăm đoạn mẫu được RAGFlow trích xuất đầy đủ nội dung, không mất chữ quan trọng hay vỡ cấu trúc bảng so với tài liệu gốc.',
    good: '≥ 90%',
    warn: '75% – 89%',
    bad: '< 75%',
  },
  {
    layer: 'Parsing',
    metric: 'Lỗi ký tự (Char Error)',
    meaning: 'Tỷ lệ đoạn bị lỗi font tiếng Việt, dính chữ, ký tự rác hoặc sai OCR trên trang scan.',
    good: '≤ 3%',
    warn: '3% – 10%',
    bad: '> 10%',
  },
  {
    layer: 'Chunking',
    metric: 'Tỷ lệ Chunk đạt chuẩn',
    meaning: 'Phần trăm đoạn cắt có độ dài hợp lý, giữ trọn ý nghĩa và không bị cắt ngang bảng biểu hoặc trùng lặp vô ích.',
    good: '≥ 88%',
    warn: '75% – 87%',
    bad: '< 75%',
  },
  {
    layer: 'Retrieval',
    metric: 'Contextual Precision',
    meaning: 'Đo xem các đoạn liên quan thực sự có được xếp ở những vị trí đầu tiên (Top-1, Top-2, Top-3) hay bị đẩy xuống dưới.',
    good: '≥ 75%',
    warn: '55% – 74%',
    bad: '< 55%',
  },
  {
    layer: 'Retrieval',
    metric: 'Context Coverage',
    meaning: 'Mức độ bao phủ thông tin cần thiết để trả lời trọn vẹn câu hỏi (đặc biệt quan trọng với câu hỏi Global & Multi-hop).',
    good: '≥ 80%',
    warn: '60% – 79%',
    bad: '< 60%',
  },
  {
    layer: 'Retrieval',
    metric: 'MRR & Hit@K',
    meaning: 'Hit@K: tỷ lệ câu hỏi tìm thấy ít nhất 1 đoạn đúng trong Top-K. MRR: điểm thưởng cao hơn khi đoạn đúng đứng ngay hạng 1.',
    good: 'Hit ≥ 85%',
    warn: '70% – 84%',
    bad: '< 70%',
  },
];

const TROUBLESHOOT_PLAYBOOK = [
  {
    symptom: 'File PDF scan bị trống hoặc mất toàn bộ chữ sau khi Parse',
    layer: 'Parsing',
    cause: 'Đang để PDF Parser là Plain Text (không có OCR) hoặc chất lượng scan quá mờ.',
    action: 'Đổi Parser (PDF) sang DeepDOC, lưu cấu hình rồi bấm nút ▷ Parse lại riêng file đó.',
  },
  {
    symptom: 'Bảng biểu bị cắt đôi, mất tiêu đề cột hoặc lẫn dữ liệu giữa các dòng',
    layer: 'Parsing / Chunking',
    cause: 'Recommended chunk size quá nhỏ so với bảng hoặc Table context window đang bằng 0.',
    action: 'Tăng Recommended chunk size lên 768–1.024 và đặt Table context window = 128.',
  },
  {
    symptom: 'Nhiều đoạn bị cắt cụt đầu/đuôi, câu trả lời thiếu nửa ý nằm ở đoạn kế tiếp',
    layer: 'Chunking',
    cause: 'Overlapped percent (%) đang bằng 0% khiến ranh giới giữa hai đoạn bị đứt gãy.',
    action: 'Tăng Overlapped percent (%) lên 10% (hoặc 15% với văn bản quy chế dài).',
  },
  {
    symptom: 'Truy vấn tên mã, điều khoản, số liệu cụ thể bị trượt Top-K',
    layer: 'Retrieval',
    cause: 'Tỷ trọng Vector quá cao làm lấn át tìm kiếm khớp từ khóa chính xác (Keyword).',
    action: 'Giảm Vector weight xuống 0.2 – 0.35 và chạy Auto-Tune để tìm điểm cân bằng.',
  },
  {
    symptom: 'Câu hỏi diễn đạt khác từ ngữ trong tài liệu không tìm ra đoạn đúng',
    layer: 'Retrieval',
    cause: 'Tìm kiếm phụ thuộc quá nhiều vào từ khóa cứng hoặc ngưỡng lọc (Threshold) quá cao.',
    action: 'Tăng Vector weight lên 0.45 – 0.6, hạ Similarity threshold xuống 0.15 – 0.2 và bật Rerank.',
  },
  {
    symptom: 'Slide PowerPoint hoặc văn bản Chương/Điều/Khoản bị trộn lẫn nội dung',
    layer: 'Dataset',
    cause: 'Gộp chung các loại tài liệu đặc thù vào cùng Dataset dùng Chunk method = General.',
    action: 'Tách riêng nhóm PPTX sang Dataset dùng Presentation và văn bản quy phạm sang Laws (xem mục Gợi ý tách nhóm trong Gợi ý Baseline).',
  },
];

const FAQ_ITEMS = [
  {
    q: 'Bấm "Áp dụng cấu hình" trong Gợi ý Baseline có tự động chạy Parse lại toàn bộ tài liệu không?',
    a: 'Không. Thao tác này chỉ đồng bộ bộ thông số vào Cấu hình Pipeline của Dataset trên RAGFlow và lưu vào DB local. Nếu tài liệu đã Parse trước đó, chunks cũ vẫn giữ nguyên cho đến khi bạn chủ động bấm "Đẩy & Parse" hoặc bấm nút ▷ Parse lại từng file.',
  },
  {
    q: 'Tại sao ô tách đoạn Parsing đặt "25 đoạn/file" nhưng một số file chỉ hiển thị 6–8 ô?',
    a: '25 là mức trần tối đa cho mỗi file. Với tài liệu ngắn có tổng số mục tự nhiên ít hơn 25, hệ thống lấy toàn bộ 100% các mục hiện có. Với tài liệu dài hơn 25 mục, hệ thống dùng lấy mẫu phân tầng đều (ưu tiên bảng biểu tối đa 50% chỉ tiêu, phần còn lại rải đều từ đầu → giữa → cuối file).',
  },
  {
    q: 'Khi bấm "Chấm lại bằng LLM" ở Bước 2, hệ thống có tự chạy OCR cho các file PDF scan không?',
    a: 'Có. Trước khi chạy LLM chấm đối chiếu, backend tự động chạy OCR (mặc định dùng Local RapidOCR miễn phí, hoặc Vision LLM nếu bạn đã cấu hình) cho toàn bộ các đoạn ảnh/scan chưa có văn bản chuẩn, sau đó mới chấm đồng loạt.',
  },
  {
    q: 'Xóa tài liệu bằng nút thùng rác ở Bước 1 có xóa thật trên RAGFlow không?',
    a: 'Có. Nút xóa sẽ gọi trực tiếp DELETE API lên Dataset tương ứng trên RAGFlow, đồng thời dọn sạch bản ghi, chunks và kết quả chấm liên quan tại SQLite local. Ngược lại, nếu bạn xóa file trực tiếp bên RAGFlow Web rồi bấm "Đồng bộ RAGFlow", Harness cũng tự động gỡ file đó khỏi danh sách.',
  },
  {
    q: 'Smart Cache ở Bước 4 (Retrieval) hoạt động như thế nào?',
    a: 'Mỗi khi một cặp (Câu hỏi Golden, Chunk) đã được LLM chấm hoặc bạn sửa tay, kết quả sẽ được lưu vào Smart Cache. Ở các lần chạy thử tham số mới (hoặc chạy Auto-Tune), nếu RAGFlow trả về lại đúng cặp đó, hệ thống kế thừa ngay nhãn cũ — giúp chạy nhanh hơn, tiết kiệm chi phí LLM và giữ so sánh A/B hoàn toàn nhất quán.',
  },
  {
    q: 'Tại sao Dataset chỉ có 1 file gốc lại ít hoặc không có câu hỏi Multi-hop?',
    a: 'Câu hỏi Multi-hop đòi hỏi kết hợp suy luận giữa nhiều đoạn có liên hệ chéo (tốt nhất là giữa 2 tài liệu khác nhau hoặc 2 mục xa nhau có chung thuật ngữ chuyên ngành). Khi bộ dữ liệu có nhiều tài liệu cùng chủ đề, tỷ lệ câu hỏi sẽ tự phân bổ đẹp quanh ~50% Local, ~35% Global và ~15% Multi-hop.',
  },
];

export function PlatformGuidePage({ onBack, onOpenSettings, onStartWorkflow }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [activeStepIdx, setActiveStepIdx] = useState(0);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  const currentStep = STEP_GUIDES[activeStepIdx];
  const StepIcon = currentStep.icon;

  return (
    <div className="mx-auto max-w-[1220px] px-4 py-6 sm:px-8 sm:py-8">
      {/* Top back bar */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="ts-btn-ghost -ml-2.5">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Quay lại
        </button>
        <div className="hidden sm:flex items-center gap-2 font-mono text-[11px] text-[#71717a]">
          <BookOpen className="size-3.5 text-[#03aa5c]" />
          <span>Sổ tay vận hành · RAGFlow QC Harness</span>
        </div>
      </div>

      {/* Hero Banner */}
      <section className="mb-8 grid overflow-hidden rounded-lg border border-[#e0e0dc] bg-white lg:grid-cols-[1fr_21rem]">
        <div className="p-6 sm:p-8">
          <p className="ts-eyebrow mb-2.5 text-[#027a42]">RAGFLOW QC · DOCUMENTATION</p>
          <h1
            ref={titleRef}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight text-[#141414] sm:text-[32px] leading-tight"
          >
            Sổ tay vận hành &amp; Kiểm định RAGFlow
          </h1>
          <p className="mt-3 max-w-2xl text-[13.5px] leading-relaxed text-[#52525b]">
            Hướng dẫn đầy đủ từ thiết lập cấu hình khởi đầu (<strong>Pre-flight Baseline</strong>),
            kiểm định chất lượng dữ liệu qua 3 tầng (<strong>Parsing → Chunking → Retrieval</strong>),
            tối ưu tham số tự động (<strong>Auto-Tune</strong>) đến thử nghiệm đối chiếu{' '}
            <strong>A/B 2 Datasets</strong> bằng số liệu định lượng.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => onStartWorkflow('full_pipeline')}
              className="ts-btn-primary min-h-9 text-xs"
            >
              Bắt đầu quy trình 4 bước
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onStartWorkflow('studio')}
              className="ts-btn-secondary min-h-9 text-xs"
            >
              <FlaskConical className="size-3.5 text-[#03aa5c]" aria-hidden="true" />
              Mở So sánh 2 Datasets
            </button>
          </div>
        </div>

        {/* First-time Setup Checklist */}
        <div className="ts-editorial-banner border-t border-[#e0e0dc] p-6 sm:p-7 lg:border-l lg:border-t-0 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[#141414]">Thiết lập lần đầu</h2>
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#027a42]">3 mục</span>
            </div>
            <ul className="space-y-2 text-[12.5px] leading-snug text-[#3f3f46]">
              <li className="flex items-start gap-2">
                <CheckCircle2 className="size-3.5 text-[#03aa5c] shrink-0 mt-0.5" />
                <span>
                  <strong>Kết nối RAGFlow:</strong> nhập Base URL &amp; API Key, bấm kiểm tra kết nối.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="size-3.5 text-[#03aa5c] shrink-0 mt-0.5" />
                <span>
                  <strong>LLM Judge:</strong> cấu hình model (DeepSeek / OpenAI...) để tư vấn Baseline, sinh Golden &amp; chấm tự động.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="size-3.5 text-[#03aa5c] shrink-0 mt-0.5" />
                <span>
                  <strong>OCR trang scan:</strong> mặc định dùng <span className="font-mono text-[11px]">local-rapidocr</span> miễn phí 0đ.
                </span>
              </li>
            </ul>
          </div>
          <button type="button" onClick={onOpenSettings} className="ts-btn-secondary min-h-9 w-full justify-center text-xs">
            <Settings className="size-3.5" aria-hidden="true" />
            Mở Cài đặt hệ thống
          </button>
        </div>
      </section>

      {/* Main Layout: Sticky Left TOC + Detailed Right Content */}
      <div className="grid gap-8 lg:grid-cols-[210px_1fr] items-start">
        {/* Sticky Sidebar TOC */}
        <aside className="hidden lg:block sticky top-20 space-y-1">
          <div className="px-2.5 pb-2 font-mono text-[10.5px] uppercase tracking-wider text-[#8a8a8e]">
            Mục lục tài liệu
          </div>
          <nav aria-label="Mục lục hướng dẫn" className="space-y-0.5 border-l border-[#e6e6e2]">
            {TOC_ITEMS.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="group flex items-baseline gap-2 pl-3 pr-2 py-1.5 text-[12.5px] text-[#52525b] hover:text-[#141414] border-l-2 border-transparent hover:border-[#03aa5c] -ml-px transition-colors"
              >
                <span className="font-mono text-[10.5px] text-[#a1a1aa] group-hover:text-[#03aa5c]">
                  {item.num}
                </span>
                <span className="truncate">{item.label}</span>
              </a>
            ))}
          </nav>
        </aside>

        {/* Detailed Sections */}
        <div className="space-y-10 min-w-0">
          {/* 01. Architecture & 3-Layer Principle */}
          <section id="sec-arch" className="scroll-mt-20 space-y-4">
            <div className="flex items-baseline gap-2.5 border-b border-[#e8e8e4] pb-2.5">
              <span className="font-mono text-xs font-semibold text-[#03aa5c]">01</span>
              <h2 className="text-lg font-semibold text-[#141414]">Kiến trúc &amp; Nguyên lý kiểm định 3 tầng</h2>
            </div>

            <p className="text-[13.5px] leading-relaxed text-[#3f3f46]">
              Khi một câu hỏi RAG trả lời sai, nguyên nhân hiếm khi chỉ nằm ở bước tìm kiếm cuối cùng — lỗi thường dây chuyền từ{' '}
              <strong>đọc sai file gốc (Parsing)</strong> → <strong>cắt hỏng ngữ cảnh (Chunking)</strong> →{' '}
              <strong>xếp hạng sai đoạn (Retrieval)</strong>. RAGFlow QC tách bạch rõ 3 tầng này để bạn lần ngược đúng nguyên nhân gốc.
            </p>

            {/* Clean Architectural SVG Flow */}
            <div className="rounded-lg border border-[#e2e2de] bg-white p-4 sm:p-5 overflow-x-auto">
              <svg viewBox="0 0 880 176" className="w-full min-w-[660px] h-auto block" role="img" aria-label="Sơ đồ luồng dữ liệu 4 tầng RAGFlow QC">
                {/* Connectors */}
                <line x1="196" y1="88" x2="232" y2="88" stroke="#141414" strokeWidth="1.5" />
                <polygon points="232,88 224,84 224,92" fill="#141414" />

                <line x1="422" y1="78" x2="458" y2="78" stroke="#03aa5c" strokeWidth="1.6" />
                <polygon points="458,78 450,74 450,82" fill="#03aa5c" />
                <line x1="458" y1="98" x2="422" y2="98" stroke="#71717a" strokeWidth="1.4" />
                <polygon points="422,98 430,94 430,102" fill="#71717a" />

                <line x1="658" y1="78" x2="694" y2="78" stroke="#03aa5c" strokeWidth="1.6" />
                <polygon points="694,78 686,74 686,82" fill="#03aa5c" />
                <line x1="694" y1="98" x2="658" y2="98" stroke="#71717a" strokeWidth="1.4" />
                <polygon points="658,98 666,94 666,102" fill="#71717a" />

                {/* Box 1 */}
                <rect x="6" y="18" width="190" height="140" rx="8" fill="#fafaf8" stroke="#dcdcd8" strokeWidth="1.2" />
                <text x="22" y="42" fontSize="10" fontFamily="monospace" fill="#71717a">01 · TESTER / QA</text>
                <text x="22" y="64" fontSize="13.5" fontWeight="600" fill="#141414">Tài liệu &amp; Golden</text>
                <text x="22" y="88" fontSize="11.5" fill="#52525b">• PDF, DOCX, XLSX,</text>
                <text x="22" y="106" fontSize="11.5" fill="#52525b">  PPTX, HTML, MD</text>
                <text x="22" y="128" fontSize="11.5" fill="#52525b">• Bộ câu hỏi kiểm thử</text>
                <text x="22" y="144" fontSize="11.5" fill="#52525b">• Nhận báo cáo Excel</text>

                {/* Box 2 */}
                <rect x="234" y="18" width="188" height="140" rx="8" fill="#ffffff" stroke="#dcdcd8" strokeWidth="1.2" />
                <text x="250" y="42" fontSize="10" fontFamily="monospace" fill="#71717a">02 · FRONTEND</text>
                <text x="250" y="64" fontSize="13.5" fontWeight="600" fill="#141414">Giao diện Web QC</text>
                <text x="250" y="88" fontSize="11.5" fill="#52525b">• B1: Gợi ý &amp; Cấu hình</text>
                <text x="250" y="106" fontSize="11.5" fill="#52525b">• B2–B3: Parse &amp; Chunk</text>
                <text x="250" y="124" fontSize="11.5" fill="#52525b">• B4: Retrieval &amp; Tune</text>
                <text x="250" y="142" fontSize="11.5" fill="#52525b">• B5: So sánh A → B</text>

                {/* Box 3 (Core) */}
                <rect x="460" y="12" width="198" height="152" rx="8" fill="#ffffff" stroke="#141414" strokeWidth="1.6" />
                <text x="476" y="36" fontSize="10" fontFamily="monospace" fontWeight="600" fill="#03aa5c">03 · BACKEND ENGINE</text>
                <text x="476" y="58" fontSize="13.5" fontWeight="700" fill="#141414">FastAPI + SQLite</text>
                <text x="476" y="80" fontSize="11.5" fill="#3f3f46">• Quét file &amp; Baseline</text>
                <text x="476" y="98" fontSize="11.5" fill="#3f3f46">• Đối chiếu &amp; Chấm 3 tầng</text>
                <rect x="474" y="114" width="170" height="38" rx="5" fill="#141414" />
                <text x="484" y="131" fontSize="10.5" fontFamily="monospace" fill="#34d399">SQLite Local DB</text>
                <text x="484" y="145" fontSize="10.5" fill="#e4e4e7">Điểm QC · Golden · Cache</text>

                {/* Box 4 */}
                <rect x="696" y="18" width="178" height="68" rx="8" fill="#f5fbf8" stroke="#cdebd9" strokeWidth="1.2" />
                <text x="710" y="38" fontSize="10" fontFamily="monospace" fontWeight="600" fill="#027a42">RAGFLOW (DOCKER)</text>
                <text x="710" y="57" fontSize="11.5" fill="#141414">DeepDOC · Chunker</text>
                <text x="710" y="73" fontSize="11" fill="#52525b">Vector · Keyword · Rerank</text>

                <rect x="696" y="94" width="178" height="64" rx="8" fill="#fafaf8" stroke="#dcdcd8" strokeWidth="1.2" />
                <text x="710" y="114" fontSize="10" fontFamily="monospace" fill="#71717a">AI &amp; OCR HỖ TRỢ</text>
                <text x="710" y="133" fontSize="11.5" fill="#141414">LLM API · RapidOCR</text>
                <text x="710" y="149" fontSize="11" fill="#52525b">Chấm ngữ nghĩa &amp; OCR 0đ</text>
              </svg>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 text-[12.5px]">
              <div className="rounded-md border border-[#d7efe3] bg-[#f7fdf9] px-4 py-3">
                <div className="font-semibold text-[#141414] mb-1">Những thao tác GHI trực tiếp lên RAGFlow</div>
                <p className="text-[#3f3f46] leading-relaxed">
                  Tạo Dataset mới, Áp dụng/Lưu Cấu hình Baseline, Đẩy &amp; Parse tài liệu, Xóa tài liệu (nút 🗑), và Nhân bản Dataset nhánh [B].
                </p>
              </div>
              <div className="rounded-md border border-[#e6e6e2] bg-[#fafaf8] px-4 py-3">
                <div className="font-semibold text-[#141414] mb-1">Những thao tác CHỈ LƯU tại SQLite local</div>
                <p className="text-[#52525b] leading-relaxed">
                  Chấm điểm Parsing/Chunking, sinh &amp; sửa bộ câu hỏi Golden, điểm Retrieval, Smart Cache, báo cáo Gợi ý Baseline &amp; Auto-Tune.
                </p>
              </div>
            </div>
          </section>

          {/* 02. Interactive 5-Step Operational Guide */}
          <section id="sec-steps" className="scroll-mt-20 space-y-4">
            <div className="flex items-baseline gap-2.5 border-b border-[#e8e8e4] pb-2.5">
              <span className="font-mono text-xs font-semibold text-[#03aa5c]">02</span>
              <h2 className="text-lg font-semibold text-[#141414]">Chi tiết quy trình 5 bước vận hành</h2>
            </div>

            {/* Step Tabs */}
            <div className="flex flex-wrap gap-1.5 border-b border-[#ecece9] pb-3">
              {STEP_GUIDES.map((s, idx) => {
                const Icon = s.icon;
                const active = idx === activeStepIdx;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setActiveStepIdx(idx)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      active
                        ? 'bg-[#141414] text-white'
                        : 'bg-[#f4f4f1] text-[#52525b] hover:text-[#141414] hover:bg-[#eaeae6]'
                    }`}
                  >
                    <Icon className={`size-3.5 ${active ? 'text-[#34d399]' : 'text-[#71717a]'}`} />
                    <span>{s.step}</span>
                  </button>
                );
              })}
            </div>

            {/* Active Step Detail Card */}
            <div className="rounded-lg border border-[#e2e2de] bg-white p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="grid size-8 place-items-center rounded-md bg-[#f2fbf6] text-[#027a42] border border-[#d7efe3]">
                    <StepIcon className="size-4" />
                  </span>
                  <div>
                    <div className="font-mono text-[10.5px] uppercase text-[#027a42] font-semibold">
                      {currentStep.step}
                    </div>
                    <h3 className="text-base font-semibold text-[#141414]">{currentStep.title}</h3>
                  </div>
                </div>
                <span className="font-mono text-[11px] text-[#8a8a8e]">
                  {activeStepIdx + 1} / {STEP_GUIDES.length}
                </span>
              </div>

              <p className="text-[13px] text-[#3f3f46] leading-relaxed bg-[#fafaf8] border border-[#efefec] rounded-md px-3.5 py-2.5">
                <strong className="text-[#141414]">Mục tiêu:</strong> {currentStep.goal}
              </p>

              <div className="space-y-2">
                <div className="text-[11.5px] font-semibold uppercase tracking-wider text-[#71717a]">
                  Trình tự thao tác chuẩn
                </div>
                <ol className="space-y-2 text-[13px] text-[#27272a] leading-relaxed">
                  {currentStep.actions.map((act, i) => (
                    <li key={i} className="flex items-start gap-2.5">
                      <span className="font-mono text-[11px] font-semibold text-[#027a42] bg-[#f2fbf6] border border-[#d7efe3] rounded px-1.5 py-0.5 mt-0.5 shrink-0">
                        {i + 1}
                      </span>
                      <span>{act}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="pt-3 border-t border-[#f0f0ed] space-y-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                  Lưu ý thực chiến
                </div>
                <ul className="space-y-1 text-[12.5px] text-[#52525b]">
                  {currentStep.tips.map((tip, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="size-1.5 rounded-full bg-[#03aa5c] mt-2 shrink-0" />
                      <span>{tip}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          {/* 03. RAGFlow Parameters Reference */}
          <section id="sec-params" className="scroll-mt-20 space-y-4">
            <div className="flex items-baseline gap-2.5 border-b border-[#e8e8e4] pb-2.5">
              <span className="font-mono text-xs font-semibold text-[#03aa5c]">03</span>
              <h2 className="text-lg font-semibold text-[#141414]">Từ điển thông số chuẩn trên RAGFlow</h2>
            </div>
            <p className="text-[13px] text-[#52525b] leading-relaxed">
              Các tên gọi dưới đây khớp trực tiếp 1-1 với giao diện <strong>Configuration</strong> trên RAGFlow và bảng{' '}
              <strong>Cấu hình Baseline</strong> / <strong>Gợi ý Baseline</strong> trong Harness.
            </p>

            <div className="overflow-x-auto rounded-lg border border-[#e2e2de] bg-white">
              <table className="w-full text-left border-collapse text-[12.5px]">
                <thead className="bg-[#fafaf8] border-b border-[#e8e8e4] text-[11px] font-mono uppercase text-[#71717a]">
                  <tr>
                    <th className="py-2.5 px-4 font-medium w-[24%]">Thông số RAGFlow</th>
                    <th className="py-2.5 px-4 font-medium w-[34%]">Ý nghĩa</th>
                    <th className="py-2.5 px-4 font-medium w-[42%]">Khi nào nên điều chỉnh</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#f0f0ed]">
                  {RAGFLOW_PARAMS.map((p) => (
                    <tr key={p.name} className="hover:bg-[#fcfcfa]">
                      <td className="py-3 px-4 align-top">
                        <div className="font-semibold text-[#141414]">{p.name}</div>
                        <div className="font-mono text-[10.5px] text-[#8a8a8e] mt-0.5">{p.ragflowKey}</div>
                      </td>
                      <td className="py-3 px-4 align-top text-[#3f3f46] leading-relaxed">{p.desc}</td>
                      <td className="py-3 px-4 align-top text-[#52525b] leading-relaxed">{p.when}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 04. Sampling & Smart Cache Mechanics */}
          <section id="sec-sampling" className="scroll-mt-20 space-y-4">
            <div className="flex items-baseline gap-2.5 border-b border-[#e8e8e4] pb-2.5">
              <span className="font-mono text-xs font-semibold text-[#03aa5c]">04</span>
              <h2 className="text-lg font-semibold text-[#141414]">Cơ chế lấy mẫu, OCR &amp; Smart Cache</h2>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-lg border border-[#e2e2de] bg-white p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#141414]">
                  <Sparkles className="size-3.5 text-[#03aa5c]" />
                  <span>Lấy mẫu phân tầng Parsing</span>
                </div>
                <p className="text-[12.5px] text-[#52525b] leading-relaxed">
                  Mặc định tối đa <strong className="text-[#141414]">25 đoạn/file</strong>. File ngắn hơn lấy đủ 100%; file dài ưu tiên tối đa{' '}
                  <strong className="text-[#141414]">50% cho bảng biểu</strong>, phần còn lại rải đều từ đầu → giữa → cuối tài liệu.
                </p>
              </div>

              <div className="rounded-lg border border-[#e2e2de] bg-white p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#141414]">
                  <SlidersHorizontal className="size-3.5 text-[#03aa5c]" />
                  <span>Cỡ mẫu Chunking (Bankier/Cochran)</span>
                </div>
                <p className="text-[12.5px] text-[#52525b] leading-relaxed">
                  Tự động phân bổ số lượng chunk cần kiểm tra theo độ lớn từng tài liệu, giúp kết quả ước lượng tỷ lệ lỗi đủ tin cậy mà không phải đọc toàn bộ kho.
                </p>
              </div>

              <div className="rounded-lg border border-[#e2e2de] bg-white p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#141414]">
                  <Database className="size-3.5 text-[#03aa5c]" />
                  <span>Smart Cache (Retrieval)</span>
                </div>
                <p className="text-[12.5px] text-[#52525b] leading-relaxed">
                  Tự động kế thừa điểm Relevancy cho các cặp <span className="font-mono text-[11px]">(Câu hỏi, Chunk)</span> đã chấm trước đó. Giúp chạy Auto-Tune nhanh, tiết kiệm API và chấm A/B nhất quán.
                </p>
              </div>
            </div>
          </section>

          {/* 05. Metrics & Thresholds */}
          <section id="sec-metrics" className="scroll-mt-20 space-y-4">
            <div className="flex items-baseline gap-2.5 border-b border-[#e8e8e4] pb-2.5">
              <span className="font-mono text-xs font-semibold text-[#03aa5c]">05</span>
              <h2 className="text-lg font-semibold text-[#141414]">Bộ chỉ số đo lường &amp; Ngưỡng tham chiếu</h2>
            </div>

            <div className="overflow-x-auto rounded-lg border border-[#e2e2de] bg-white">
              <table className="w-full text-left border-collapse text-[12.5px]">
                <thead className="bg-[#fafaf8] border-b border-[#e8e8e4] text-[11px] font-mono uppercase text-[#71717a]">
                  <tr>
                    <th className="py-2.5 px-4 font-medium w-[12%]">Tầng</th>
                    <th className="py-2.5 px-4 font-medium w-[22%]">Chỉ số</th>
                    <th className="py-2.5 px-4 font-medium w-[38%]">Ý nghĩa thực tế</th>
                    <th className="py-2.5 px-3 font-medium text-right w-[9%]">Tốt</th>
                    <th className="py-2.5 px-3 font-medium text-right w-[10%]">Cần xem</th>
                    <th className="py-2.5 px-3 font-medium text-right w-[9%]">Yếu</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#f0f0ed]">
                  {METRICS_GUIDE.map((m) => (
                    <tr key={m.metric} className="hover:bg-[#fcfcfa]">
                      <td className="py-2.5 px-4 font-mono text-[11px] text-[#71717a]">{m.layer}</td>
                      <td className="py-2.5 px-4 font-semibold text-[#141414]">{m.metric}</td>
                      <td className="py-2.5 px-4 text-[#52525b] leading-relaxed">{m.meaning}</td>
                      <td className="py-2.5 px-3 text-right font-mono text-[11.5px] font-semibold text-[#027a42] whitespace-nowrap">
                        {m.good}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-[11.5px] text-[#52525b] whitespace-nowrap">
                        {m.warn}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-[11.5px] text-[#b91c1c] whitespace-nowrap">
                        {m.bad}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 06. Diagnostic Playbook */}
          <section id="sec-playbook" className="scroll-mt-20 space-y-4">
            <div className="flex items-baseline gap-2.5 border-b border-[#e8e8e4] pb-2.5">
              <span className="font-mono text-xs font-semibold text-[#03aa5c]">06</span>
              <h2 className="text-lg font-semibold text-[#141414]">Bảng chẩn đoán nhanh: Thấy lỗi gì → Sửa thông số nào?</h2>
            </div>

            <div className="divide-y divide-[#ecece8] rounded-lg border border-[#e2e2de] bg-white">
              {TROUBLESHOOT_PLAYBOOK.map((item, idx) => (
                <div key={idx} className="p-4 sm:px-5 grid gap-2 sm:grid-cols-[1.1fr_1fr_1.1fr] sm:gap-4 text-[12.5px]">
                  <div>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-[#71717a]">
                      {item.layer}
                    </span>
                    <div className="font-semibold text-[#141414] mt-0.5 leading-snug">{item.symptom}</div>
                  </div>
                  <div className="text-[#52525b] leading-relaxed">
                    <span className="font-medium text-[#27272a]">Nguyên nhân: </span>
                    {item.cause}
                  </div>
                  <div className="text-[#27272a] leading-relaxed">
                    <span className="font-semibold text-[#027a42]">Cách xử lý: </span>
                    {item.action}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 07. A/B Comparison & Excel Export */}
          <section id="sec-ab" className="scroll-mt-20 space-y-4">
            <div className="flex items-baseline gap-2.5 border-b border-[#e8e8e4] pb-2.5">
              <span className="font-mono text-xs font-semibold text-[#03aa5c]">07</span>
              <h2 className="text-lg font-semibold text-[#141414]">So sánh A/B 2 Datasets &amp; Báo cáo Excel</h2>
            </div>

            <div className="rounded-lg border border-[#e2e2de] bg-[#fafaf8] p-5 sm:p-6 space-y-4">
              <p className="text-[13px] text-[#3f3f46] leading-relaxed">
                Khi cần thay đổi các thông số cấp độ Index (như <span className="font-mono text-[12px]">Chunk method</span>,{' '}
                <span className="font-mono text-[12px]">Parser</span>,{' '}
                <span className="font-mono text-[12px]">Recommended chunk size</span>,{' '}
                <span className="font-mono text-[12px]">Overlapped percent</span>), hãy dùng{' '}
                <strong>So sánh 2 Datasets (Experiment Studio)</strong> thay vì ghi đè trực tiếp lên Dataset đang chạy — nhờ đó bạn giữ nguyên mốc Baseline [A] để đối chứng công bằng.
              </p>

              <div className="grid gap-3 sm:grid-cols-3 text-[12.5px]">
                <div className="rounded-md bg-white border border-[#e6e6e2] p-3.5">
                  <div className="font-mono text-[11px] font-semibold text-[#027a42] mb-1">1. Nhân bản có kiểm soát</div>
                  <p className="text-[#52525b] leading-relaxed">
                    Sao chép sang Dataset [B] mới, chỉ đổi 1–2 biến giả thuyết và để hệ thống tự chạy Parse + chấm 3 tầng.
                  </p>
                </div>
                <div className="rounded-md bg-white border border-[#e6e6e2] p-3.5">
                  <div className="font-mono text-[11px] font-semibold text-[#027a42] mb-1">2. Soi câu Pass ↔ Fail</div>
                  <p className="text-[#52525b] leading-relaxed">
                    Xem chính xác bao nhiêu câu được cứu từ Fail → Pass và bao nhiêu câu bị thoái lui từ Pass → Fail.
                  </p>
                </div>
                <div className="rounded-md bg-white border border-[#e6e6e2] p-3.5">
                  <div className="font-mono text-[11px] font-semibold text-[#027a42] mb-1">3. Xuất Excel tổng hợp</div>
                  <p className="text-[#52525b] leading-relaxed">
                    Xuất file báo cáo chứa đầy đủ sheet Tổng hợp, Parsing, Chunking và Retrieval để lưu trữ hoặc trình bày.
                  </p>
                </div>
              </div>

              <div>
                <button
                  type="button"
                  onClick={() => onStartWorkflow('studio')}
                  className="ts-btn-secondary min-h-9 text-xs bg-white"
                >
                  <FlaskConical className="size-3.5 text-[#03aa5c]" aria-hidden="true" />
                  Mở Experiment Studio (So sánh A/B)
                </button>
              </div>
            </div>
          </section>

          {/* 08. Practical FAQ */}
          <section id="sec-faq" className="scroll-mt-20 space-y-4 pb-6">
            <div className="flex items-baseline gap-2.5 border-b border-[#e8e8e4] pb-2.5">
              <span className="font-mono text-xs font-semibold text-[#03aa5c]">08</span>
              <h2 className="text-lg font-semibold text-[#141414]">Câu hỏi thường gặp (FAQ)</h2>
            </div>

            <div className="divide-y divide-[#ecece8] rounded-lg border border-[#e2e2de] bg-white">
              {FAQ_ITEMS.map((item, idx) => {
                const isOpen = openFaq === idx;
                return (
                  <div key={idx}>
                    <button
                      type="button"
                      onClick={() => setOpenFaq(isOpen ? null : idx)}
                      className="w-full px-5 py-3.5 text-left flex items-center justify-between gap-4 hover:bg-[#fafaf8] transition-colors"
                    >
                      <span className="text-[13px] font-medium text-[#141414]">{item.q}</span>
                      {isOpen ? (
                        <ChevronUp className="size-4 text-[#71717a] shrink-0" />
                      ) : (
                        <ChevronDown className="size-4 text-[#71717a] shrink-0" />
                      )}
                    </button>
                    {isOpen && (
                      <div className="px-5 pb-4 text-[12.5px] leading-relaxed text-[#52525b]">
                        {item.a}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
