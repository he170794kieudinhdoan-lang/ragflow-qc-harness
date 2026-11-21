import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Database, Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { RunItem } from '../types';

interface Props {
  onClose: () => void;
  onCreated: (run: RunItem) => void;
}

const PARSER_IDS = [
  { id: 'general', label: 'General (mặc định)' },
  { id: 'laws', label: 'Laws (văn bản luật)' },
  { id: 'manual', label: 'Manual (sổ tay)' },
  { id: 'paper', label: 'Paper (bài báo)' },
  { id: 'book', label: 'Book (sách)' },
  { id: 'table', label: 'Table (bảng biểu)' },
  { id: 'qa', label: 'Q&A (hỏi đáp)' },
  { id: 'presentation', label: 'Presentation (slide)' },
  { id: 'one', label: 'One (gộp 1 chunk)' },
];

export const DatasetFlowModal: React.FC<Props> = ({ onClose, onCreated }) => {
  const [step, setStep] = useState<'pick' | 'create'>('pick');
  const [loadingList, setLoadingList] = useState(true);
  const [remoteDatasets, setRemoteDatasets] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  // Create new dataset form (RAGFlow style)
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isBaseline, setIsBaseline] = useState(true);
  const [parserId, setParserId] = useState('general');
  const [pdfParser, setPdfParser] = useState('DeepDOC');
  const [chunkTokenSize, setChunkTokenSize] = useState(512);
  const [overlappedPercent, setOverlappedPercent] = useState(0);
  const [delimitersText, setDelimitersText] = useState('\\n ! ? ; 。 ； ！ ？');
  const [visionEnhance, setVisionEnhance] = useState(false);
  const [autoKeywords, setAutoKeywords] = useState(0);
  const [autoQuestions, setAutoQuestions] = useState(0);

  useEffect(() => {
    setLoadingList(true);
    api
      .testRagflow()
      .then((res) => setRemoteDatasets(res.datasets || []))
      .catch(() => setRemoteDatasets([]))
      .finally(() => setLoadingList(false));
  }, []);

  const handleAttachExisting = async (ds: any) => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await api.createRun({
        name: ds.name || `Dataset_${String(ds.id).slice(0, 6)}`,
        description: ds.description || '',
        is_baseline: true,
        ragflow_dataset_id: ds.id,
        ragflow_dataset_name: ds.name,
        create_remote_dataset: false,
        chunk_method: ds.parser_id || ds.chunk_method || 'general',
        parser_config: ds.parser_config || {},
      });
      toast.success(`Đã kết nối Dataset "${ds.name}".`);
      onCreated(created);
      onClose();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateNew = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const delims = delimitersText
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => (t === '\\n' ? '\n' : t));
      const created = await api.createRun({
        name: name.trim(),
        description: description.trim(),
        is_baseline: isBaseline,
        ragflow_dataset_id: '',
        ragflow_dataset_name: name.trim(),
        create_remote_dataset: true,
        chunk_method: parserId,
        parser_config: {
          chunk_token_num: Number(chunkTokenSize) || 512,
          overlapped_percent: Number(overlappedPercent) || 0,
          layout_recognize: pdfParser,
          delimiter: delims.join(''),
          enable_vision_enhancement: visionEnhance,
          auto_keywords: Number(autoKeywords) || 0,
          auto_questions: Number(autoQuestions) || 0,
        },
      });
      toast.success(`Đã tạo Dataset mới "${created.name}" trên RAGFlow.`);
      onCreated(created);
      onClose();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
      <div className="bg-[#fefefe] border-2 border-[#161616] shadow-[6px_6px_0_#161616] w-full max-w-xl max-h-[86dvh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[#dedede] bg-[#f7f7f6] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {step === 'create' && (
              <button
                type="button"
                onClick={() => setStep('pick')}
                className="p-1 text-[#52525b] hover:text-[#161616]"
                title="Quay lại danh sách Dataset có sẵn"
              >
                <ArrowLeft className="size-4" />
              </button>
            )}
            <div>
              <h2 className="text-sm font-semibold text-[#161616]">
                {step === 'pick' ? 'Chọn Dataset có sẵn trên RAGFlow' : 'Tạo Dataset mới & Cấu hình mặc định'}
              </h2>
              <p className="text-[11px] text-[#71717a] mt-0.5">
                {step === 'pick'
                  ? 'Chọn 1 Dataset hiện có hoặc tạo Dataset mới trên RAGFlow'
                  : 'Thiết lập thông số Parsing / Chunking mặc định giống RAGFlow'}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-[#71717a] hover:text-[#161616]" aria-label="Đóng">
            <X className="size-4" />
          </button>
        </div>

        {/* Step 1: Pick Existing Dataset */}
        {step === 'pick' && (
          <>
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {loadingList ? (
                <div className="py-12 flex items-center justify-center gap-2 text-xs text-[#71717a]">
                  <Loader2 className="size-4 animate-spin text-[#03aa5c]" /> Đang tải danh sách Dataset từ RAGFlow...
                </div>
              ) : remoteDatasets.length === 0 ? (
                <div className="py-12 px-4 text-center border border-dashed border-[#dedede] bg-[#fafaf9] space-y-2">
                  <Database className="size-6 mx-auto text-[#a1a1aa]" />
                  <div className="text-xs font-medium text-[#161616]">
                    Hiện chưa có Dataset nào trên tài khoản RAGFlow này
                  </div>
                  <div className="text-[11px] text-[#71717a]">
                    Bấm nút bên dưới để tạo Dataset mới kèm cấu hình Parsing mặc định.
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {remoteDatasets.map((ds: any) => (
                    <button
                      key={ds.id}
                      type="button"
                      disabled={busy}
                      onClick={() => handleAttachExisting(ds)}
                      className="w-full p-3.5 text-left border border-[#dedede] bg-white hover:border-[#161616] hover:bg-[#f2fbf6]/50 transition-colors flex items-center justify-between gap-3 group disabled:opacity-45"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-[#161616] truncate">{ds.name}</span>
                          <span className="ts-tag-neutral text-[10px]">{ds.parser_id || ds.chunk_method || 'general'}</span>
                        </div>
                        <div className="font-mono text-[10px] text-[#71717a] flex flex-wrap items-center gap-2">
                          <span>{ds.document_count ?? 0} file</span>
                          <span>·</span>
                          <span>{ds.chunk_count ?? 0} chunks</span>
                          {ds.embedding_model && (
                            <>
                              <span>·</span>
                              <span className="truncate max-w-[240px]">{ds.embedding_model}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <ArrowRight className="size-4 text-[#a1a1aa] group-hover:text-[#03aa5c] shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="px-5 py-3.5 border-t border-[#dedede] bg-[#f7f7f6] flex items-center justify-between gap-3">
              <button type="button" onClick={onClose} className="ts-btn-secondary text-xs">
                Đóng
              </button>
              <button
                type="button"
                onClick={() => setStep('create')}
                className="ts-btn-primary text-xs"
              >
                <Plus className="size-3.5" />
                Tạo Dataset mới trên RAGFlow
              </button>
            </div>
          </>
        )}

        {/* Step 2: Create New Dataset with RAGFlow Default Config */}
        {step === 'create' && (
          <form onSubmit={handleCreateNew} className="flex-1 flex flex-col min-h-0">
            <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-[#161616] mb-1">Tên Dataset *</label>
                  <input
                    className="ts-input w-full text-xs"
                    placeholder="VD: Baseline_HIV_512"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="block font-medium text-[#161616] mb-1">Chunk Method (parser_id)</label>
                  <select className="ts-input w-full text-xs" value={parserId} onChange={(e) => setParserId(e.target.value)}>
                    {PARSER_IDS.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-medium text-[#161616] mb-1">Mô tả (tùy chọn)</label>
                <input
                  className="ts-input w-full text-xs"
                  placeholder="Ghi chú mục đích thử nghiệm..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div className="pt-2 border-t border-[#ededeb] space-y-3">
                <div className="ts-eyebrow">CẤU HÌNH PARSING & CHUNKING (RAGFLOW)</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium text-[#161616] mb-1">PDF Parser</label>
                    <select className="ts-input w-full text-xs" value={pdfParser} onChange={(e) => setPdfParser(e.target.value)}>
                      <option value="DeepDOC">DeepDOC (OCR + Layout + Bảng)</option>
                      <option value="Plain Text">Plain Text</option>
                      <option value="MinerU">MinerU</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-[#161616] mb-1">Delimiters</label>
                    <input
                      className="ts-input w-full font-mono text-xs"
                      value={delimitersText}
                      onChange={(e) => setDelimitersText(e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="flex justify-between mb-1">
                      <label className="font-medium text-[#161616]">Chunk Token Size</label>
                      <span className="font-mono text-[#027a42] font-semibold">{chunkTokenSize}</span>
                    </div>
                    <input
                      type="range"
                      min={64}
                      max={2048}
                      step={32}
                      value={chunkTokenSize}
                      onChange={(e) => setChunkTokenSize(Number(e.target.value))}
                      className="w-full accent-[#03aa5c]"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <label className="font-medium text-[#161616]">Overlapped (%)</label>
                      <span className="font-mono text-[#027a42] font-semibold">{overlappedPercent}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={50}
                      value={overlappedPercent}
                      onChange={(e) => setOverlappedPercent(Number(e.target.value))}
                      className="w-full accent-[#03aa5c]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="flex justify-between mb-1">
                      <label className="font-medium text-[#161616]">Auto-Keywords</label>
                      <span className="font-mono">{autoKeywords}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={30}
                      value={autoKeywords}
                      onChange={(e) => setAutoKeywords(Number(e.target.value))}
                      className="w-full accent-[#03aa5c]"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <label className="font-medium text-[#161616]">Auto-Questions</label>
                      <span className="font-mono">{autoQuestions}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={10}
                      value={autoQuestions}
                      onChange={(e) => setAutoQuestions(Number(e.target.value))}
                      className="w-full accent-[#03aa5c]"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-1">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={visionEnhance}
                      onChange={(e) => setVisionEnhance(e.target.checked)}
                      className="accent-[#03aa5c]"
                    />
                    Enable Vision Enhancement
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isBaseline}
                      onChange={(e) => setIsBaseline(e.target.checked)}
                      className="accent-[#03aa5c]"
                    />
                    Đặt làm bản chuẩn (Baseline)
                  </label>
                </div>
              </div>
            </div>

            <div className="px-5 py-3.5 border-t border-[#dedede] bg-[#f7f7f6] flex items-center justify-between gap-2">
              <button type="button" onClick={() => setStep('pick')} className="ts-btn-secondary text-xs">
                ← Quay lại
              </button>
              <button type="submit" disabled={busy || !name.trim()} className="ts-btn-primary text-xs">
                {busy ? 'Đang tạo trên RAGFlow...' : 'Tạo Dataset & Mở phiên'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
