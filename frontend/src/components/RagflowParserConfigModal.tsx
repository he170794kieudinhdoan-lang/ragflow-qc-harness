import React, { useEffect, useState } from 'react';
import { Code2, Cpu, FileText, Layers, Loader2, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { RunItem } from '../types';

interface Props {
  run: RunItem;
  onClose: () => void;
  onSaved: () => void;
}

const PARSER_IDS = [
  { id: 'general', label: 'General (mặc định)' },
  { id: 'laws', label: 'Laws (văn bản luật)' },
  { id: 'manual', label: 'Manual (sổ tay kỹ thuật)' },
  { id: 'paper', label: 'Paper (bài báo khoa học)' },
  { id: 'book', label: 'Book (sách)' },
  { id: 'table', label: 'Table (bảng biểu)' },
  { id: 'qa', label: 'Q&A (hỏi đáp)' },
  { id: 'presentation', label: 'Presentation (slide)' },
  { id: 'one', label: 'One (gộp 1 chunk)' },
];

type SectionId = 'parser' | 'chunker' | 'extractor' | 'tokenizer' | 'json';

function findNodeKey(pc: Record<string, any>, prefix: string): string | null {
  return Object.keys(pc).find((k) => k.startsWith(prefix)) || null;
}

export const RagflowParserConfigModal: React.FC<Props> = ({ run, onClose, onSaved }) => {
  const [section, setSection] = useState<SectionId>('parser');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [source, setSource] = useState<'ragflow' | 'local'>('local');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [rawPc, setRawPc] = useState<Record<string, any>>({});

  // Top-level dataset fields
  const [parserId, setParserId] = useState('general');
  const [pagerank, setPagerank] = useState(0);

  // Parser node fields
  const [pdfParseMethod, setPdfParseMethod] = useState('DeepDOC');
  const [sheetParseMethod, setSheetParseMethod] = useState('DeepDOC');
  const [visionEnhance, setVisionEnhance] = useState(false);
  const [pdfFlattenMedia, setPdfFlattenMedia] = useState(false);
  const [docxFlattenMedia, setDocxFlattenMedia] = useState(false);

  // Chunker node fields
  const [chunkTokenSize, setChunkTokenSize] = useState(512);
  const [overlappedPercent, setOverlappedPercent] = useState(0);
  const [delimitersText, setDelimitersText] = useState('\\n ! ? ; 。 ； ！ ？');
  const [tableContextSize, setTableContextSize] = useState(0);
  const [imageContextSize, setImageContextSize] = useState(0);
  const [useParentChild, setUseParentChild] = useState(false);
  const [childrenDelimiter, setChildrenDelimiter] = useState('\\n');

  // Extractor node fields
  const [keywordsTopN, setKeywordsTopN] = useState(0);
  const [questionsTopN, setQuestionsTopN] = useState(0);
  const [summaryEnabled, setSummaryEnabled] = useState(false);
  const [metadataEnabled, setMetadataEnabled] = useState(false);

  // Tokenizer node fields
  const [filenameWeight, setFilenameWeight] = useState(0.1);
  const [searchEmbedding, setSearchEmbedding] = useState(true);
  const [searchFullText, setSearchFullText] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .getRunParserConfig(run.id)
      .then((res) => {
        setSource(res.source === 'ragflow' ? 'ragflow' : 'local');
        setEmbeddingModel(res.embedding_model || '');
        setParserId(res.parser_id || 'general');
        setPagerank(Number(res.pagerank || 0));
        const pc = (res.parser_config || {}) as Record<string, any>;
        setRawPc(pc);

        const pKey = findNodeKey(pc, 'Parser:');
        const cKey = findNodeKey(pc, 'GeneralChunker:');
        const eKey = findNodeKey(pc, 'Extractor:');
        const tKey = findNodeKey(pc, 'Tokenizer:');

        if (pKey && pc[pKey]) {
          const p = pc[pKey];
          setPdfParseMethod(p.pdf?.parse_method || 'DeepDOC');
          setSheetParseMethod(p.spreadsheet?.parse_method || 'DeepDOC');
          setVisionEnhance(Boolean(p.enable_vision_enhancement));
          setPdfFlattenMedia(Boolean(p.pdf?.flatten_media_to_text));
          setDocxFlattenMedia(Boolean(p.docx?.flatten_media_to_text));
        } else {
          setPdfParseMethod(pc.layout_recognize || 'DeepDOC');
        }

        if (cKey && pc[cKey]) {
          const c = pc[cKey];
          setChunkTokenSize(Number(c.chunk_token_size ?? 512));
          setOverlappedPercent(Number(c.overlapped_percent ?? 0));
          const delims: string[] = Array.isArray(c.delimiters) ? c.delimiters : ['\n', '!', '?', ';'];
          setDelimitersText(delims.map((d) => (d === '\n' ? '\\n' : d)).join(' '));
          setTableContextSize(Number(c.table_context_size ?? 0));
          setImageContextSize(Number(c.image_context_size ?? 0));
          setUseParentChild(Boolean(c.parent_child?.use_parent_child));
          setChildrenDelimiter(
            c.parent_child?.children_delimiter === '\n'
              ? '\\n'
              : c.parent_child?.children_delimiter || '\\n'
          );
        } else if (pc.chunk_token_num) {
          setChunkTokenSize(Number(pc.chunk_token_num));
        }

        if (eKey && pc[eKey]) {
          const e = pc[eKey];
          setKeywordsTopN(Number(e.keywords?.top_n ?? 0));
          setQuestionsTopN(Number(e.questions?.top_n ?? 0));
          setSummaryEnabled(Boolean(e.summary?.enabled));
          setMetadataEnabled(Boolean(e.metadata?.enabled));
        }

        if (tKey && pc[tKey]) {
          const t = pc[tKey];
          setFilenameWeight(Number(t.filename_embd_weight ?? 0.1));
          const sm: string[] = Array.isArray(t.search_method) ? t.search_method : ['embedding', 'full_text'];
          setSearchEmbedding(sm.includes('embedding'));
          setSearchFullText(sm.includes('full_text'));
        }
      })
      .catch((err: any) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [run.id]);

  const buildUpdatedParserConfig = (): Record<string, any> => {
    const next = JSON.parse(JSON.stringify(rawPc || {}));
    const pKey = findNodeKey(next, 'Parser:');
    const cKey = findNodeKey(next, 'GeneralChunker:');
    const eKey = findNodeKey(next, 'Extractor:');
    const tKey = findNodeKey(next, 'Tokenizer:');

    const parsedDelims = delimitersText
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => (t === '\\n' ? '\n' : t));
    const realChildDelim = childrenDelimiter === '\\n' ? '\n' : childrenDelimiter;

    if (pKey || cKey || eKey || tKey) {
      // RAGFlow v1.0 Pipeline schema — preserve every existing node key & field
      if (pKey && next[pKey]) {
        next[pKey].enable_vision_enhancement = visionEnhance;
        if (next[pKey].pdf) {
          next[pKey].pdf.parse_method = pdfParseMethod;
          next[pKey].pdf.flatten_media_to_text = pdfFlattenMedia;
        }
        if (next[pKey].spreadsheet) {
          next[pKey].spreadsheet.parse_method = sheetParseMethod;
        }
        if (next[pKey].docx) {
          next[pKey].docx.flatten_media_to_text = docxFlattenMedia;
        }
      }
      if (cKey && next[cKey]) {
        next[cKey].chunk_token_size = Number(chunkTokenSize) || 512;
        next[cKey].overlapped_percent = Number(overlappedPercent) || 0;
        next[cKey].delimiters = parsedDelims.length > 0 ? parsedDelims : ['\n'];
        next[cKey].table_context_size = Number(tableContextSize) || 0;
        next[cKey].image_context_size = Number(imageContextSize) || 0;
        next[cKey].parent_child = {
          ...(next[cKey].parent_child || {}),
          use_parent_child: useParentChild,
          children_delimiter: realChildDelim,
        };
      }
      if (eKey && next[eKey]) {
        next[eKey].keywords = { ...(next[eKey].keywords || {}), top_n: Number(keywordsTopN) || 0 };
        next[eKey].questions = { ...(next[eKey].questions || {}), top_n: Number(questionsTopN) || 0 };
        next[eKey].summary = { ...(next[eKey].summary || {}), enabled: summaryEnabled };
        next[eKey].metadata = { ...(next[eKey].metadata || {}), enabled: metadataEnabled };
      }
      if (tKey && next[tKey]) {
        next[tKey].filename_embd_weight = Number(filenameWeight);
        const sm: string[] = [];
        if (searchEmbedding) sm.push('embedding');
        if (searchFullText) sm.push('full_text');
        next[tKey].search_method = sm.length > 0 ? sm : ['embedding'];
      }
      return next;
    }

    // Legacy flat RAGFlow parser_config fallback
    return {
      ...next,
      chunk_token_num: Number(chunkTokenSize) || 512,
      layout_recognize: pdfParseMethod,
      delimiter: parsedDelims.join(''),
      auto_keywords: Number(keywordsTopN) || 0,
      auto_questions: Number(questionsTopN) || 0,
    };
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updatedPc = buildUpdatedParserConfig();
      const res = await api.updateRunParserConfig(run.id, {
        chunk_method: parserId,
        pagerank,
        parser_config: updatedPc,
        sync_remote: true,
      });
      if (res.remote_synced) {
        toast.success('Đã lưu và đồng bộ cấu hình Dataset lên RAGFlow.');
      } else if (res.remote_warning) {
        toast.warning(`Đã lưu local (RAGFlow báo: ${res.remote_warning}).`);
      } else {
        toast.success('Đã lưu cấu hình Parse.');
      }
      onSaved();
      onClose();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const NAV_SECTIONS: { id: SectionId; label: string; icon: any }[] = [
    { id: 'parser', label: 'Parser & OCR', icon: FileText },
    { id: 'chunker', label: 'Chunker (Cắt đoạn)', icon: Layers },
    { id: 'extractor', label: 'Auto-Extractor', icon: Cpu },
    { id: 'tokenizer', label: 'Tokenizer & Search', icon: Search },
    { id: 'json', label: 'Raw JSON', icon: Code2 },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
      <div className="bg-[#fefefe] border-2 border-[#161616] shadow-[6px_6px_0_#161616] w-full max-w-3xl h-[560px] max-h-[88dvh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[#dedede] bg-[#f7f7f6] flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[#161616]">RAGFlow Dataset Configuration</h2>
              <span className="ts-tag-teal">
                {source === 'ragflow' ? 'Live từ RAGFlow' : 'Local'}
              </span>
            </div>
            <div className="font-mono text-[11px] text-[#71717a] mt-0.5 truncate">
              {run.name} {embeddingModel ? `· ${embeddingModel}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-[#71717a] hover:text-[#161616]"
            aria-label="Đóng"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body: Left Section Nav + Right Form */}
        {loading ? (
          <div className="py-20 flex items-center justify-center gap-2 text-xs text-[#71717a]">
            <Loader2 className="size-4 animate-spin text-[#03aa5c]" /> Đang tải cấu hình thực tế từ RAGFlow...
          </div>
        ) : (
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {/* Left Sidebar Tabs */}
            <aside className="w-48 shrink-0 border-r border-[#dedede] bg-[#f7f7f6] p-2 space-y-1">
              {NAV_SECTIONS.map((s) => {
                const Icon = s.icon;
                const active = section === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSection(s.id)}
                    className={`w-full flex items-center gap-2 px-2.5 py-2 text-xs text-left transition-colors rounded-[2px] ${
                      active
                        ? 'bg-[#161616] text-white font-medium'
                        : 'text-[#52525b] hover:bg-[#ededeb] hover:text-[#161616]'
                    }`}
                  >
                    <Icon className={`size-3.5 shrink-0 ${active ? 'text-[#03aa5c]' : ''}`} />
                    <span className="truncate">{s.label}</span>
                  </button>
                );
              })}
            </aside>

            {/* Right Config Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
              {section === 'parser' && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block font-medium text-[#161616] mb-1">Chunk Method (parser_id)</label>
                      <select
                        className="ts-input w-full text-xs"
                        value={parserId}
                        onChange={(e) => setParserId(e.target.value)}
                      >
                        {PARSER_IDS.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-[#161616] mb-1">PDF Parser</label>
                      <select
                        className="ts-input w-full text-xs"
                        value={pdfParseMethod}
                        onChange={(e) => setPdfParseMethod(e.target.value)}
                      >
                        <option value="DeepDOC">DeepDOC (OCR + Layout + Bảng)</option>
                        <option value="Plain Text">Plain Text (Đọc text thuần)</option>
                        <option value="MinerU">MinerU</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block font-medium text-[#161616] mb-1">Spreadsheet Parser (Excel/CSV)</label>
                      <select
                        className="ts-input w-full text-xs"
                        value={sheetParseMethod}
                        onChange={(e) => setSheetParseMethod(e.target.value)}
                      >
                        <option value="DeepDOC">DeepDOC</option>
                        <option value="Plain Text">Plain Text</option>
                      </select>
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="font-medium text-[#161616]">Page Rank</label>
                        <span className="font-mono text-[#027a42] font-semibold">{pagerank}</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={pagerank}
                        onChange={(e) => setPagerank(Number(e.target.value))}
                        className="w-full accent-[#03aa5c]"
                      />
                    </div>
                  </div>

                  <div className="pt-2 border-t border-[#ededeb] space-y-2.5">
                    <label className="flex items-center justify-between p-2.5 border border-[#dedede] bg-[#fafaf9] cursor-pointer">
                      <div>
                        <div className="font-medium text-[#161616]">Enable Vision Enhancement</div>
                        <div className="text-[11px] text-[#71717a]">Dùng VLM tăng cường đọc ảnh/sơ đồ phức tạp</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={visionEnhance}
                        onChange={(e) => setVisionEnhance(e.target.checked)}
                        className="size-4 accent-[#03aa5c]"
                      />
                    </label>
                    <label className="flex items-center justify-between p-2.5 border border-[#dedede] bg-[#fafaf9] cursor-pointer">
                      <div>
                        <div className="font-medium text-[#161616]">Flatten Media to Text (PDF)</div>
                        <div className="text-[11px] text-[#71717a]">Chuyển nội dung ảnh/media trong PDF thành text phẳng</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={pdfFlattenMedia}
                        onChange={(e) => setPdfFlattenMedia(e.target.checked)}
                        className="size-4 accent-[#03aa5c]"
                      />
                    </label>
                    <label className="flex items-center justify-between p-2.5 border border-[#dedede] bg-[#fafaf9] cursor-pointer">
                      <div>
                        <div className="font-medium text-[#161616]">Flatten Media to Text (DOCX)</div>
                        <div className="text-[11px] text-[#71717a]">Chuyển nội dung ảnh/media trong DOCX thành text phẳng</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={docxFlattenMedia}
                        onChange={(e) => setDocxFlattenMedia(e.target.checked)}
                        className="size-4 accent-[#03aa5c]"
                      />
                    </label>
                  </div>
                </>
              )}

              {section === 'chunker' && (
                <>
                  <div className="space-y-3">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="font-medium text-[#161616]">Chunk Token Size</label>
                        <input
                          type="number"
                          min={64}
                          max={2048}
                          value={chunkTokenSize}
                          onChange={(e) => setChunkTokenSize(Number(e.target.value))}
                          className="ts-input w-20 py-0.5 text-right font-mono text-xs"
                        />
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
                      <div className="flex items-center justify-between mb-1">
                        <label className="font-medium text-[#161616]">Overlapped Percent (%)</label>
                        <span className="font-mono text-[#027a42] font-semibold">{overlappedPercent}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={50}
                        step={1}
                        value={overlappedPercent}
                        onChange={(e) => setOverlappedPercent(Number(e.target.value))}
                        className="w-full accent-[#03aa5c]"
                      />
                    </div>

                    <div>
                      <label className="block font-medium text-[#161616] mb-1">
                        Delimiters (cách nhau bằng dấu cách)
                      </label>
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={delimitersText}
                        onChange={(e) => setDelimitersText(e.target.value)}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4 pt-1">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="font-medium text-[#161616]">Table Context Size</label>
                          <span className="font-mono">{tableContextSize}</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1024}
                          step={32}
                          value={tableContextSize}
                          onChange={(e) => setTableContextSize(Number(e.target.value))}
                          className="w-full accent-[#03aa5c]"
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="font-medium text-[#161616]">Image Context Size</label>
                          <span className="font-mono">{imageContextSize}</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1024}
                          step={32}
                          value={imageContextSize}
                          onChange={(e) => setImageContextSize(Number(e.target.value))}
                          className="w-full accent-[#03aa5c]"
                        />
                      </div>
                    </div>

                    <div className="pt-2 border-t border-[#ededeb] space-y-2.5">
                      <label className="flex items-center justify-between p-2.5 border border-[#dedede] bg-[#fafaf9] cursor-pointer">
                        <div>
                          <div className="font-medium text-[#161616]">Parent-Child Chunking</div>
                          <div className="text-[11px] text-[#71717a]">Tách chunk con để tìm kiếm chính xác, trả về chunk cha đầy đủ ngữ cảnh</div>
                        </div>
                        <input
                          type="checkbox"
                          checked={useParentChild}
                          onChange={(e) => setUseParentChild(e.target.checked)}
                          className="size-4 accent-[#03aa5c]"
                        />
                      </label>
                      {useParentChild && (
                        <div>
                          <label className="block font-medium text-[#161616] mb-1">Children Delimiter</label>
                          <input
                            className="ts-input w-full font-mono text-xs"
                            value={childrenDelimiter}
                            onChange={(e) => setChildrenDelimiter(e.target.value)}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}

              {section === 'extractor' && (
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="font-medium text-[#161616]">Auto-Keywords (top_n)</label>
                      <span className="font-mono text-[#027a42] font-semibold">{keywordsTopN}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={30}
                      value={keywordsTopN}
                      onChange={(e) => setKeywordsTopN(Number(e.target.value))}
                      className="w-full accent-[#03aa5c]"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="font-medium text-[#161616]">Auto-Questions (top_n)</label>
                      <span className="font-mono text-[#027a42] font-semibold">{questionsTopN}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={10}
                      value={questionsTopN}
                      onChange={(e) => setQuestionsTopN(Number(e.target.value))}
                      className="w-full accent-[#03aa5c]"
                    />
                  </div>
                  <label className="flex items-center justify-between p-2.5 border border-[#dedede] bg-[#fafaf9] cursor-pointer">
                    <div>
                      <div className="font-medium text-[#161616]">Auto Summary</div>
                      <div className="text-[11px] text-[#71717a]">Tự động tóm tắt tài liệu khi parse</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={summaryEnabled}
                      onChange={(e) => setSummaryEnabled(e.target.checked)}
                      className="size-4 accent-[#03aa5c]"
                    />
                  </label>
                  <label className="flex items-center justify-between p-2.5 border border-[#dedede] bg-[#fafaf9] cursor-pointer">
                    <div>
                      <div className="font-medium text-[#161616]">Auto Metadata</div>
                      <div className="text-[11px] text-[#71717a]">Tự động trích xuất metadata cho từng chunk</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={metadataEnabled}
                      onChange={(e) => setMetadataEnabled(e.target.checked)}
                      className="size-4 accent-[#03aa5c]"
                    />
                  </label>
                </div>
              )}

              {section === 'tokenizer' && (
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="font-medium text-[#161616]">Filename Embedding Weight</label>
                      <span className="font-mono text-[#027a42] font-semibold">{filenameWeight.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={filenameWeight}
                      onChange={(e) => setFilenameWeight(Number(e.target.value))}
                      className="w-full accent-[#03aa5c]"
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="font-medium text-[#161616]">Search Method</div>
                    <label className="flex items-center gap-2 p-2.5 border border-[#dedede] bg-[#fafaf9] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={searchEmbedding}
                        onChange={(e) => setSearchEmbedding(e.target.checked)}
                        className="size-4 accent-[#03aa5c]"
                      />
                      <span>Vector Embedding (`embedding`)</span>
                    </label>
                    <label className="flex items-center gap-2 p-2.5 border border-[#dedede] bg-[#fafaf9] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={searchFullText}
                        onChange={(e) => setSearchFullText(e.target.checked)}
                        className="size-4 accent-[#03aa5c]"
                      />
                      <span>Full-Text Keyword (`full_text`)</span>
                    </label>
                  </div>
                </div>
              )}

              {section === 'json' && (
                <pre className="p-3 bg-[#161616] text-[#f2fbf6] font-mono text-[11px] overflow-x-auto leading-relaxed">
                  {JSON.stringify(buildUpdatedParserConfig(), null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#dedede] bg-[#f7f7f6] flex items-center justify-between gap-3">
          <span className="text-[11px] text-[#71717a]">
            Lưu sẽ cập nhật trực tiếp lên Dataset trên RAGFlow.
          </span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="ts-btn-secondary text-xs">
              Hủy
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={loading || saving}
              className="ts-btn-primary text-xs"
            >
              {saving ? 'Đang đồng bộ...' : 'Lưu & Đồng bộ RAGFlow'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
