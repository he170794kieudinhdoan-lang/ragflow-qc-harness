# RAGFlow QC Harness (`Ragflow_for_qc`)

Web console & backend harness giúp QC tự động hóa và chuẩn hóa quy trình kiểm thử hệ thống RAG trên **RAGFlow** qua cả 3 tầng **Parsing → Chunking → Retrieval** và **So sánh cấu hình A/B**.

## Kiến trúc
- **Backend:** Python, FastAPI, SQLite, `httpx`, `PyMuPDF`, `python-docx`, `openpyxl` (`backend/`)
- **Frontend:** React, Vite, TypeScript, Tailwind CSS (`frontend/`)

## Tính năng chính
1. **Bước 1 — Tài liệu & Đồng bộ RAGFlow:** Lưu cấu hình RAGFlow API 1 lần, quản lý kho tài liệu gốc, đẩy file lên parse và kéo snapshot toàn bộ chunks về SQLite local kèm tự động bắt cờ bất thường.
2. **Bước 2 — Chấm đọc file (Parsing):** Đối chiếu Side-by-Side tài liệu gốc (kèm render trang PDF) với chunks RAGFlow trích xuất, tự động tính `Text Completeness`, `Table Accuracy`, `Character Error`.
3. **Bước 3 — Chấm cắt đoạn (Chunking):** Chọn mẫu phân tầng đầu–giữa–cuối, tự quét lỗi định lượng (chunk vụn, quá dài, số trang, trùng lặp), chấm 5 tiêu chí.
4. **Bước 4 — Chấm tìm kiếm (Retrieval):** Quản lý Golden Dataset, chạy batch `/api/v1/retrieval`, tích hợp **Smart Relevancy Cache** tự kế thừa nhãn đã chấm giữa các lần chạy A/B.
5. **So sánh 2 cấu hình (A/B Lab) & Xuất Excel phụ:** So sánh delta `Contextual Precision` / `Context Coverage`, lọc câu `Fail → Pass` / `Pass → Fail`, hỗ trợ xuất file `.xlsx`.

## Cách chạy local

### 1. Backend (port 8000)
```bash
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

### 2. Frontend (port 5173)
```bash
cd frontend
npm install
npm run dev
```

Truy cập `http://localhost:5173`.
