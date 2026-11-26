import React, { useEffect, useState } from 'react';
import { BookOpen, Search, X } from 'lucide-react';

type CatId = 'all' | 'retrieval_rc' | 'retrieval_metric' | 'parsing' | 'chunking' | 'system';

interface GlossaryItem {
  code: string;
  cat: Exclude<CatId, 'all'>;
  title: string;
  desc: string;
  fix?: string;
  tone?: 'danger' | 'warn' | 'ok' | 'neutral';
}

const CATEGORIES: { id: CatId; label: string }[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'retrieval_rc', label: 'Nguyên nhân Retrieval' },
  { id: 'retrieval_metric', label: 'Chỉ số & Nhãn Retrieval' },
  { id: 'parsing', label: 'Mã lỗi Parsing (P1–P10)' },
  { id: 'chunking', label: 'Mã lỗi Chunking' },
  { id: 'system', label: 'Đồng bộ & RAGFlow' },
];

const ITEMS: GlossaryItem[] = [
  // 1. Retrieval Root Cause
  {
    code: 'THRESHOLD',
    cat: 'retrieval_rc',
    title: 'R4 · Lỗi ngưỡng lọc / Top-K',
    desc: 'Đáp án có đầy đủ trong kho chunk (Trọn 1 chunk / FULL), nhưng điểm tương đồng thấp hơn Similarity Threshold hoặc nằm ngoài Top-N nên không lọt vào kết quả trả về.',
    fix: 'Hạ Similarity Threshold (VD: 0.20 → 0.15), tăng Top-N trả về, hoặc bật Rerank để kéo chunk đúng lên đầu.',
    tone: 'danger',
  },
  {
    code: 'KEYWORD',
    cat: 'retrieval_rc',
    title: 'R1 · Miss nhánh Keyword (BM25)',
    desc: 'Câu hỏi thuộc dạng tra từ khóa/mã hiệu/tên riêng nhưng nhánh tìm kiếm toàn văn (Full-Text BM25) không khớp hoặc trọng số Keyword quá thấp.',
    fix: 'Giảm Vector Weight (tăng tỷ trọng Keyword) hoặc bật Keyword Expansion.',
    tone: 'danger',
  },
  {
    code: 'VECTOR',
    cat: 'retrieval_rc',
    title: 'R2 · Miss nhánh Vector (Ngữ nghĩa)',
    desc: 'Câu hỏi diễn đạt theo nghĩa bóng/từ đồng nghĩa, mô hình Embedding chưa kéo được chunk đúng vào tập ứng viên.',
    fix: 'Tăng Vector Similarity Weight (VD: 0.3 → 0.5–0.7), bật Rerank, hoặc thử Embedding model tốt hơn cho tiếng Việt.',
    tone: 'danger',
  },
  {
    code: 'RERANK',
    cat: 'retrieval_rc',
    title: 'R3 · Lỗi xếp hạng Rerank',
    desc: 'Chunk đúng có lọt vào tập ứng viên (Candidates) nhưng sau khi chấm lại bằng Rerank bị đẩy xuống dưới hạng cao.',
    fix: 'Đổi mô hình Rerank phù hợp tiếng Việt hoặc điều chỉnh số lượng Candidates (16–64).',
    tone: 'warn',
  },
  {
    code: 'SIMILAR_DOC',
    cat: 'retrieval_rc',
    title: 'R5 · Nhiễu tài liệu tương tự',
    desc: 'Tài liệu khác cùng chủ đề (không phải nguồn chuẩn của câu hỏi) chen lên trước hạng #1, làm tụt điểm Precision.',
    fix: 'Bật Rerank, tinh chỉnh Filename Weight / PageRank hoặc bổ sung ngữ cảnh đầu đề cho chunk.',
    tone: 'warn',
  },
  {
    code: 'PARSING',
    cat: 'retrieval_rc',
    title: 'Lỗi bắt nguồn từ tầng Parsing',
    desc: 'Tài liệu gốc chứa đáp án đang bị lỗi Parsing nặng (mất chữ, vỡ bảng, OCR sai) khiến kho chunk không có thông tin đúng để truy xuất.',
    fix: 'Đổi PDF Engine sang DeepDOC / MinerU, bật Vision Enhancement hoặc tăng Table Context Size rồi Parse lại.',
    tone: 'danger',
  },
  {
    code: 'CHUNKING',
    cat: 'retrieval_rc',
    title: 'Lỗi bắt nguồn từ tầng Chunking',
    desc: 'Đáp án bị cắt rời qua nhiều đoạn (SPLIT) hoặc chunk mất ngữ cảnh/vỡ bảng nên Retrieval không ghép đủ ý.',
    fix: 'Tăng Chunk Token Size (512 → 768/1024), tăng Overlapped Percent (10–15%) hoặc bật Parent-Child Chunking.',
    tone: 'warn',
  },
  {
    code: 'NONE',
    cat: 'retrieval_rc',
    title: 'Không có lỗi gốc',
    desc: 'Câu hỏi truy xuất đạt chuẩn, chunk đúng nằm ở vị trí tốt.',
    tone: 'ok',
  },

  // 2. Retrieval Metrics & Labels
  {
    code: 'Precision %',
    cat: 'retrieval_metric',
    title: 'Contextual Precision (Độ chính xác xếp hạng)',
    desc: 'Đo mức độ ưu tiên xếp hạng các chunk đúng lên đầu danh sách Top-K (chunk đúng ở #1 được điểm tối đa, càng tụt xuống dưới điểm càng giảm). Ngưỡng Pass mặc định ≥ 50% và có ít nhất 1 hit đúng.',
    tone: 'ok',
  },
  {
    code: 'Coverage %',
    cat: 'retrieval_metric',
    title: 'Context Coverage (Độ phủ ngữ cảnh)',
    desc: 'Tỷ lệ nội dung căn cứ chuẩn (Reference Context) được phủ bởi các chunk đúng trong Top-K trả về.',
    tone: 'ok',
  },
  {
    code: 'FULL',
    cat: 'retrieval_metric',
    title: 'Answer Containment · Trọn 1 chunk',
    desc: 'Toàn bộ thông tin đáp án nằm trọn vẹn trong ít nhất 1 chunk của kho dữ liệu (không bị cắt đôi).',
    tone: 'ok',
  },
  {
    code: 'SPLIT',
    cat: 'retrieval_metric',
    title: 'Answer Containment · Bị cắt nhiều chunk',
    desc: 'Thông tin đáp án có trong kho nhưng bị cắt rời rạc qua 2+ chunk khác nhau.',
    tone: 'warn',
  },
  {
    code: 'MISSING',
    cat: 'retrieval_metric',
    title: 'Answer Containment · Thiếu trong kho',
    desc: 'Không tìm thấy nội dung đáp án trong toàn bộ kho chunk đã đồng bộ (thường do lỗi Parsing/OCR hoặc thiếu tài liệu).',
    tone: 'danger',
  },
  {
    code: 'Local / Global / Multi-hop',
    cat: 'retrieval_metric',
    title: '3 phân loại câu hỏi Golden Dataset',
    desc: 'Local: đáp án nằm gọn trong 1 đoạn; Global: cần tổng hợp nhiều đoạn/khía cạnh; Multi-hop: cần kết hợp suy luận từ 2 đoạn khác nhau.',
    tone: 'neutral',
  },
  {
    code: 'Top-1 Sim',
    cat: 'retrieval_metric',
    title: 'Độ tương đồng của kết quả hạng #1',
    desc: 'Điểm similarity tổng hợp (Hybrid Vector + Keyword hoặc Rerank score) của chunk đứng đầu tiên.',
    tone: 'neutral',
  },
  {
    code: 'LLM_DRAFT / CACHED / MANUAL / RULE',
    cat: 'retrieval_metric',
    title: 'Nguồn chấm điểm Relevancy',
    desc: 'LLM_DRAFT: AI chấm mới; CACHED: tái sử dụng kết quả đã chấm cho cùng cặp (câu hỏi, chunk); MANUAL: người dùng chấm tay; RULE: so khớp tự động không dùng AI.',
    tone: 'neutral',
  },

  // 3. Parsing Error Codes
  {
    code: 'PASS / PARTIAL / FAIL / UNRATED',
    cat: 'parsing',
    title: 'Kết luận chấm từng đoạn Parsing',
    desc: 'PASS: đọc đầy đủ & chính xác; PARTIAL: đọc được phần lớn nhưng thiếu nhẹ hoặc sai định dạng nhỏ; FAIL: mất chữ nặng, vỡ bảng hoặc sai số liệu; UNRATED: chưa chấm.',
    tone: 'neutral',
  },
  {
    code: 'TEXT',
    cat: 'parsing',
    title: 'Nhóm lỗi Thiếu chữ / OCR',
    desc: 'Đoạn văn bản bị sót chữ, sai số liệu hoặc lỗi dấu tiếng Việt / nhận diện OCR.',
    tone: 'danger',
  },
  {
    code: 'TABLE',
    cat: 'parsing',
    title: 'Nhóm lỗi Vỡ bảng',
    desc: 'Cấu trúc bảng bị mất hàng/cột, lệch ô hoặc sai số liệu trong bảng.',
    tone: 'danger',
  },
  {
    code: 'ORDER',
    cat: 'parsing',
    title: 'Nhóm lỗi Sai thứ tự đọc',
    desc: 'PDF nhiều cột bị đọc trộn dòng ngang hoặc đảo thứ tự các đoạn.',
    tone: 'warn',
  },
  {
    code: 'LAYOUT',
    cat: 'parsing',
    title: 'Nhóm lỗi Hình / Bố cục',
    desc: 'Mất nội dung biểu đồ/sơ đồ nhúng hoặc gộp sai heading/danh sách.',
    tone: 'warn',
  },
  {
    code: 'P1',
    cat: 'parsing',
    title: 'Mất đoạn văn bản (Missing text)',
    desc: 'Một phần câu hoặc cả đoạn chữ trong file gốc bị biến mất sau khi parse.',
    tone: 'danger',
  },
  {
    code: 'P2',
    cat: 'parsing',
    title: 'Không đọc được ảnh / sơ đồ',
    desc: 'Nội dung trong trang scan, hình ảnh hoặc sơ đồ không được OCR trích xuất.',
    tone: 'danger',
  },
  {
    code: 'P3',
    cat: 'parsing',
    title: 'Sai nội dung / Đảo thứ tự / Đảo nghĩa phủ định',
    desc: 'Nội dung bị đảo cột, trộn dòng hoặc lệch từ khóa phủ định/đối lập làm sai nghĩa.',
    tone: 'danger',
  },
  {
    code: 'P4',
    cat: 'parsing',
    title: 'Mất dấu / Lỗi dấu tiếng Việt',
    desc: 'Ký tự tiếng Việt bị mất dấu hoặc sai mã hóa Unicode.',
    tone: 'warn',
  },
  {
    code: 'P5',
    cat: 'parsing',
    title: 'Ký tự rác / Lỗi font mã hóa',
    desc: 'Xuất hiện ký tự lạ, ô vuông hoặc chuỗi vô nghĩa do lỗi font PDF.',
    tone: 'warn',
  },
  {
    code: 'P6',
    cat: 'parsing',
    title: 'Lỗi OCR trên tài liệu scan',
    desc: 'Nhận diện sai chữ trên trang PDF scan / ảnh chụp mờ.',
    tone: 'warn',
  },
  {
    code: 'P7 / P8',
    cat: 'parsing',
    title: 'Gộp tiêu đề (P7) · Gộp danh sách (P8)',
    desc: 'P7: tiêu đề mục bị dính liền vào đoạn văn; P8: danh sách gạch đầu dòng/đánh số bị dồn thành 1 dòng dài.',
    tone: 'neutral',
  },
  {
    code: 'P9 / P10',
    cat: 'parsing',
    title: 'Vỡ cấu trúc bảng (P9) · Sai số liệu bảng (P10)',
    desc: 'P9: bảng bị thiếu ô/lệch cột; P10: con số/tỷ lệ bên trong bảng bị mất hoặc đọc sai.',
    tone: 'danger',
  },
  {
    code: 'CER',
    cat: 'parsing',
    title: 'Character Error Rate (Tỷ lệ lỗi ký tự)',
    desc: 'Tỷ lệ % ký tự sai khác giữa văn bản RAGFlow parse ra so với văn bản chuẩn từ file gốc (càng thấp càng tốt).',
    tone: 'neutral',
  },

  // 4. Chunking Codes
  {
    code: 'INTEGRITY',
    cat: 'chunking',
    title: 'Lỗi Toàn vẹn đoạn (Chunk Integrity)',
    desc: 'Chunk bị cắt ngang giữa câu, cắt đứt danh sách hoặc xé đôi bảng biểu.',
    fix: 'Tăng Chunk Token Size, tăng Overlap (%) hoặc chỉnh lại Delimiters.',
    tone: 'danger',
  },
  {
    code: 'CONTEXT',
    cat: 'chunking',
    title: 'Thiếu ngữ cảnh độc lập (Context Sufficiency)',
    desc: 'Đọc riêng chunk đó không rõ đang nói về đối tượng/chủ thể/mục nào vì thiếu tiêu đề hoặc câu dẫn.',
    fix: 'Bật Parent-Child Chunking hoặc tăng Table/Image Context Size.',
    tone: 'warn',
  },
  {
    code: 'NOISE',
    cat: 'chunking',
    title: 'Dính nhiễu / Rác (Noise Rate)',
    desc: 'Chunk chứa header/footer lặp lại, số trang, menu website, nút bấm hoặc ký tự OCR rác.',
    tone: 'warn',
  },
  {
    code: 'DUPLICATE',
    cat: 'chunking',
    title: 'Trùng lặp nội dung (Duplicate Rate)',
    desc: 'Hai chunk trùng lặp nội dung ≥ 85% hoặc phần chồng lấn giữa 2 chunk liền kề quá lớn.',
    tone: 'warn',
  },
  {
    code: 'SIZE',
    cat: 'chunking',
    title: 'Sai kích thước chuẩn (TOO_SHORT / TOO_LONG)',
    desc: 'Chunk quá ngắn (< 50 ký tự, ít thông tin) hoặc quá dài (> 2600 ký tự, dễ loãng vector; trừ bảng nguyên vẹn).',
    tone: 'neutral',
  },
  {
    code: 'Cochran √n',
    cat: 'chunking',
    title: 'Lấy mẫu phân tầng thích ứng (Bankier √n)',
    desc: 'Thuật toán tự tính số chunk cần lấy mẫu đại diện theo căn bậc hai tổng số chunk của từng tài liệu (tối thiểu 5, tối đa 20 chunk/file), ưu tiên giữ đoạn đầu/giữa/cuối và đoạn chứa bảng.',
    tone: 'neutral',
  },

  // 5. System / RAGFlow
  {
    code: 'DONE / RUNNING / FAIL / UNSTART',
    cat: 'system',
    title: 'Trạng thái Parse tài liệu trên RAGFlow',
    desc: 'DONE: đã parse và tạo chunk xong; RUNNING: đang parse; FAIL: parse lỗi; UNSTART: mới tải lên chưa bấm Parse.',
    tone: 'neutral',
  },
  {
    code: 'SLOW_PARSE / ZERO_CHUNK',
    cat: 'system',
    title: 'Cờ bất thường khi đồng bộ (Anomaly Flags)',
    desc: 'SLOW_PARSE: thời gian parse vượt ngưỡng cảnh báo (mặc định 180s); ZERO_CHUNK: parse báo xong nhưng tạo ra 0 chunk.',
    tone: 'warn',
  },
  {
    code: 'DeepDOC / Plain Text / MinerU',
    cat: 'system',
    title: '3 bộ PDF Parser Engine trên RAGFlow',
    desc: 'DeepDOC: mặc định, nhận diện layout & bảng tốt (chạy nặng CPU); Plain Text: trích chữ thuần siêu nhanh, không OCR; MinerU: chuyên PDF scan/bố cục phức tạp.',
    tone: 'neutral',
  },
  {
    code: 'Vec / KW & Candidates',
    cat: 'system',
    title: 'Tham số Hybrid Search & Rerank',
    desc: 'Vec / KW: tỷ lệ điểm ngữ nghĩa Vector so với từ khóa Keyword (BM25); Candidates: số chunk ứng viên lấy ra trước khi đưa qua Rerank chọn lại Top-N.',
    tone: 'neutral',
  },
  {
    code: 'Baseline [A] / Clone [B]',
    cat: 'system',
    title: '2 nhánh đối chiếu trong Experiment Studio',
    desc: 'Baseline [A] là phiên chuẩn hiện tại; Clone [B] là Dataset mới nhân bản từ [A] với cấu hình Parse/Chunk/Retrieval riêng để chạy tự động và so sánh 3 tầng.',
    tone: 'ok',
  },
];

interface Props {
  onClose: () => void;
}

export const GlossaryModal: React.FC<Props> = ({ onClose }) => {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<CatId>('all');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const filtered = ITEMS.filter((item) => {
    if (cat !== 'all' && item.cat !== cat) return false;
    if (!q) return true;
    return (
      item.code.toLowerCase().includes(q) ||
      item.title.toLowerCase().includes(q) ||
      item.desc.toLowerCase().includes(q) ||
      (item.fix || '').toLowerCase().includes(q)
    );
  });

  const badgeTone = (tone?: GlossaryItem['tone']) => {
    if (tone === 'danger') return 'bg-rose-50 text-rose-700 border-rose-200';
    if (tone === 'warn') return 'bg-amber-50 text-amber-800 border-amber-200';
    if (tone === 'ok') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    return 'bg-[#f4f4f2] text-[#161616] border-[#dedede]';
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-3 sm:p-5"
      onClick={onClose}
    >
      <div
        className="w-[92vw] max-w-[1040px] h-[86vh] bg-[#f7f7f5] border border-[#d8d8d4] rounded-[8px] shadow-xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 bg-white border-b border-[#e4e4e0] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <BookOpen className="size-4 text-[#03aa5c]" />
            <div>
              <h2 className="text-[15px] font-semibold text-[#161616]">
                Từ điển Ký hiệu, Mã lỗi & Chỉ số hệ thống
              </h2>
              <p className="text-[11px] text-[#71717a]">
                Tổng hợp toàn bộ mã chuẩn từ mã nguồn: Parsing (P1–P10), Chunking, Retrieval (R1–R5), RAGFlow
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-[#ededeb] text-[#71717a] hover:text-[#161616]"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Search + Category Filter Bar */}
        <div className="px-5 py-3 bg-[#fafaf9] border-b border-[#e4e4e0] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="relative flex-1 min-w-[220px] max-w-[340px]">
            <Search className="size-3.5 text-[#71717a] absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm mã ký hiệu (VD: THRESHOLD, P9, SPLIT, CER...)"
              className="w-full h-8 pl-8 pr-3 text-xs border border-[#dedede] rounded-[4px] bg-white focus:outline-none focus:border-[#03aa5c]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCat(c.id)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-[4px] border transition-colors ${
                  cat === c.id
                    ? 'bg-[#161616] text-white border-[#161616]'
                    : 'bg-white text-[#52525b] border-[#e4e4e2] hover:border-[#161616] hover:text-[#161616]'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* List Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {filtered.length === 0 ? (
            <div className="py-16 text-center text-xs text-[#71717a]">
              Không tìm thấy ký hiệu nào khớp với &ldquo;{query}&rdquo;.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filtered.map((item) => (
                <div
                  key={`${item.cat}-${item.code}`}
                  className="p-3.5 rounded-[6px] border border-[#e4e4e0] bg-white space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`font-mono text-[11px] font-bold px-2 py-0.5 rounded-[3px] border ${badgeTone(
                        item.tone
                      )}`}
                    >
                      {item.code}
                    </span>
                    <span className="text-[11px] font-medium text-[#161616] truncate">{item.title}</span>
                  </div>
                  <p className="text-[12px] text-[#52525b] leading-relaxed">{item.desc}</p>
                  {item.fix && (
                    <div className="text-[11px] text-[#027a42] bg-[#f2fbf6] border border-[#d1fae5] rounded px-2 py-1">
                      <strong>Cách xử lý:</strong> {item.fix}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2.5 bg-white border-t border-[#e4e4e0] flex items-center justify-between text-[11px] text-[#71717a] shrink-0">
          <span className="font-mono">
            Hiển thị {filtered.length}/{ITEMS.length} ký hiệu
          </span>
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs font-medium text-[#161616] border border-[#dedede] rounded-[4px] bg-white hover:bg-[#fafaf9]"
          >
            Đóng (Esc)
          </button>
        </div>
      </div>
    </div>
  );
};
