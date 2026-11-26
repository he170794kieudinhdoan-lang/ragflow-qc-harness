import React, { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import {
  Cpu,
  Database,
  FileSearch,
  Layers,
  Loader2,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Tag,
  Terminal,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { PipelineJob, RunItem } from '../types';

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

function findNodeKey(pc: Record<string, any>, prefix: string): string | null {
  return Object.keys(pc).find((k) => k.startsWith(prefix)) || null;
}

interface Props {
  mode: 'baseline' | 'clone';
  baselineRun: RunItem;
  aiPatch?: Record<string, any> | null;
  onClose: () => void;
  onStarted?: (job: PipelineJob) => void;
  onCloneFromBaseline?: () => void;
}

export const CloneConfigWorkbench: React.FC<Props> = ({
  mode,
  baselineRun,
  aiPatch,
  onClose,
  onStarted,
  onCloneFromBaseline,
}) => {
  const isReadOnly = mode === 'baseline';
  const modalRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);

  const [embModels, setEmbModels] = useState<any[]>([]);
  const [rerankModels, setRerankModels] = useState<any[]>([]);
  const [rawPc, setRawPc] = useState<Record<string, any>>({});
  const [baseSnap, setBaseSnap] = useState<Record<string, any>>({});

  // Section 1: General
  const [name, setName] = useState(
    isReadOnly ? baselineRun.name : `${baselineRun.name} · Thí nghiệm mới`
  );
  const [parserId, setParserId] = useState('general');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [pagerank, setPagerank] = useState(0);

  // Section 2: Parser & OCR
  const [pdfParseMethod, setPdfParseMethod] = useState('DeepDOC');
  const [sheetParseMethod, setSheetParseMethod] = useState('DeepDOC');
  const [pdfOutputFormat, setPdfOutputFormat] = useState('json');
  const [visionEnhance, setVisionEnhance] = useState(false);
  const [vlmLlmId, setVlmLlmId] = useState('');
  const [pdfFlattenMedia, setPdfFlattenMedia] = useState(false);
  const [docxFlattenMedia, setDocxFlattenMedia] = useState(false);
  const [mdFlattenMedia, setMdFlattenMedia] = useState(false);
  const [sheetFlattenMedia, setSheetFlattenMedia] = useState(false);

  // Section 3: Chunking
  const [chunkTokenSize, setChunkTokenSize] = useState(512);
  const [overlappedPercent, setOverlappedPercent] = useState(0);
  const [delimitersText, setDelimitersText] = useState('\\n ! ? ; 。 ； ！ ？');
  const [tableContextSize, setTableContextSize] = useState(0);
  const [imageContextSize, setImageContextSize] = useState(0);
  const [useParentChild, setUseParentChild] = useState(false);
  const [childrenDelimiter, setChildrenDelimiter] = useState('\\n');

  // Section 4: Auto-Extractor
  const [extractorLlmId, setExtractorLlmId] = useState('');
  const [keywordsTopN, setKeywordsTopN] = useState(0);
  const [questionsTopN, setQuestionsTopN] = useState(0);
  const [tagsTopN, setTagsTopN] = useState(0);
  const [summaryEnabled, setSummaryEnabled] = useState(false);
  const [metadataEnabled, setMetadataEnabled] = useState(false);

  // Section 5: Tokenizer & Indexing
  const [filenameWeight, setFilenameWeight] = useState(0.1);
  const [searchEmbedding, setSearchEmbedding] = useState(true);
  const [searchFullText, setSearchFullText] = useState(true);
  const [tokenizerFields, setTokenizerFields] = useState('text');

  // Section 6: Retrieval & Auto-QC
  const [topK, setTopK] = useState(10);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.2);
  const [vectorWeight, setVectorWeight] = useState(0.3);
  const [useRerank, setUseRerank] = useState(false);
  const [rerankId, setRerankId] = useState('');
  const [rerankTopK, setRerankTopK] = useState(32);
  const [keywordEnabled, setKeywordEnabled] = useState(false);
  const [parsingMode, setParsingMode] = useState<'deep' | 'heuristic'>('deep');

  useEffect(() => {
    if (!modalRef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const tween = gsap.fromTo(
      modalRef.current,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.2, ease: 'power2.out', clearProps: 'transform' }
    );
    return () => {
      tween.kill();
    };
  }, []);

  const applySnapToState = (snap: Record<string, any>, patch: Record<string, any> | null, rModels: any[]) => {
    const p = !isReadOnly && patch ? patch : {};
    setParserId(p.parser_id || snap.parserId);
    setPagerank(snap.pagerank);
    setEmbeddingModel(snap.embeddingModel);

    setPdfParseMethod(p.pdf_parse_method || snap.pdfParseMethod);
    setSheetParseMethod(snap.sheetParseMethod);
    setPdfOutputFormat(snap.pdfOutputFormat);
    setVisionEnhance(typeof p.vision_enhance === 'boolean' ? p.vision_enhance : snap.visionEnhance);
    setVlmLlmId(snap.vlmLlmId);
    setPdfFlattenMedia(snap.pdfFlattenMedia);
    setDocxFlattenMedia(snap.docxFlattenMedia);
    setMdFlattenMedia(snap.mdFlattenMedia);
    setSheetFlattenMedia(snap.sheetFlattenMedia);

    setChunkTokenSize(typeof p.chunk_token_size === 'number' ? p.chunk_token_size : snap.chunkTokenSize);
    setOverlappedPercent(typeof p.overlapped_percent === 'number' ? p.overlapped_percent : snap.overlappedPercent);
    setDelimitersText(snap.delimitersText);
    setTableContextSize(typeof p.table_context_size === 'number' ? p.table_context_size : snap.tableContextSize);
    setImageContextSize(snap.imageContextSize);
    setUseParentChild(typeof p.use_parent_child === 'boolean' ? p.use_parent_child : snap.useParentChild);
    setChildrenDelimiter(snap.childrenDelimiter);

    setExtractorLlmId(snap.extractorLlmId);
    setKeywordsTopN(snap.keywordsTopN);
    setQuestionsTopN(snap.questionsTopN);
    setTagsTopN(snap.tagsTopN);
    setSummaryEnabled(snap.summaryEnabled);
    setMetadataEnabled(snap.metadataEnabled);

    setFilenameWeight(snap.filenameWeight);
    setSearchEmbedding(snap.searchEmbedding);
    setSearchFullText(snap.searchFullText);
    setTokenizerFields(snap.tokenizerFields);

    setTopK(typeof p.top_k === 'number' ? p.top_k : snap.topK);
    setSimilarityThreshold(
      typeof p.similarity_threshold === 'number' ? p.similarity_threshold : snap.similarityThreshold
    );
    setVectorWeight(
      typeof p.vector_similarity_weight === 'number' ? p.vector_similarity_weight : snap.vectorWeight
    );
    const wantRerank = typeof p.enable_rerank === 'boolean' ? p.enable_rerank : snap.useRerank;
    setUseRerank(wantRerank);
    if (snap.rerankId) {
      setRerankId(snap.rerankId);
    } else if (wantRerank && rModels.length > 0) {
      setRerankId(rModels[0].id);
    } else {
      setRerankId('');
    }
    setKeywordEnabled(snap.keywordEnabled);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      api.getRunParserConfig(baselineRun.id).catch(() => null),
      api.listRetrievalRuns(baselineRun.id).catch(() => []),
      api.listRagflowModels().catch(() => ({ embedding_models: [], rerank_models: [] })),
    ]).then(([pcRes, rrs, models]) => {
      if (!active) return;
      const eModels = models?.embedding_models || [];
      const rModels = models?.rerank_models || [];
      setEmbModels(eModels);
      setRerankModels(rModels);

      const pc = (pcRes?.parser_config || {}) as Record<string, any>;
      setRawPc(pc);

      const pKey = findNodeKey(pc, 'Parser:');
      const cKey = findNodeKey(pc, 'GeneralChunker:');
      const eKey = findNodeKey(pc, 'Extractor:');
      const tKey = findNodeKey(pc, 'Tokenizer:');

      const pNode = pKey ? pc[pKey] || {} : {};
      const cNode = cKey ? pc[cKey] || {} : {};
      const eNode = eKey ? pc[eKey] || {} : {};
      const tNode = tKey ? pc[tKey] || {} : {};

      const bDelims: string[] = Array.isArray(cNode.delimiters) ? cNode.delimiters : ['\n', '!', '?', ';'];
      const searchMethods: string[] = Array.isArray(tNode.search_method)
        ? tNode.search_method
        : ['embedding', 'full_text'];

      const baseRr = (rrs || []).find((r: any) => Number(r.is_baseline_rr) === 1) || (rrs || [])[0];

      const snap = {
        parserId: pcRes?.parser_id || 'general',
        pagerank: Number(pcRes?.pagerank || 0),
        embeddingModel: pcRes?.embedding_model || '',
        pdfParseMethod: pNode.pdf?.parse_method || pc.layout_recognize || 'DeepDOC',
        sheetParseMethod: pNode.spreadsheet?.parse_method || 'DeepDOC',
        pdfOutputFormat: pNode.pdf?.output_format || 'json',
        visionEnhance: Boolean(pNode.enable_vision_enhancement),
        vlmLlmId: pNode.vlm?.llm_id || '',
        pdfFlattenMedia: Boolean(pNode.pdf?.flatten_media_to_text),
        docxFlattenMedia: Boolean(pNode.docx?.flatten_media_to_text),
        mdFlattenMedia: Boolean(pNode.markdown?.flatten_media_to_text),
        sheetFlattenMedia: Boolean(pNode.spreadsheet?.flatten_media_to_text),
        chunkTokenSize: Number(cNode.chunk_token_size ?? pc.chunk_token_num ?? 512),
        overlappedPercent: Number(cNode.overlapped_percent ?? 0),
        delimitersText: bDelims.map((d) => (d === '\n' ? '\\n' : d)).join(' '),
        tableContextSize: Number(cNode.table_context_size ?? 0),
        imageContextSize: Number(cNode.image_context_size ?? 0),
        useParentChild: Boolean(cNode.parent_child?.use_parent_child),
        childrenDelimiter:
          cNode.parent_child?.children_delimiter === '\n'
            ? '\\n'
            : cNode.parent_child?.children_delimiter || '\\n',
        extractorLlmId: eNode.llm_id || '',
        keywordsTopN: Number(eNode.keywords?.top_n ?? 0),
        questionsTopN: Number(eNode.questions?.top_n ?? 0),
        tagsTopN: Number(eNode.tags?.top_n ?? 0),
        summaryEnabled: Boolean(eNode.summary?.enabled),
        metadataEnabled: Boolean(eNode.metadata?.enabled),
        filenameWeight: Number(tNode.filename_embd_weight ?? 0.1),
        searchEmbedding: searchMethods.includes('embedding'),
        searchFullText: searchMethods.includes('full_text'),
        tokenizerFields: String(tNode.fields || 'text'),
        topK: baseRr ? Number(baseRr.top_k || 10) : 10,
        similarityThreshold: baseRr ? Number(baseRr.similarity_threshold ?? 0.2) : 0.2,
        vectorWeight: baseRr ? Number(baseRr.vector_similarity_weight ?? 0.3) : 0.3,
        useRerank: Boolean(baseRr?.rerank_id),
        rerankId: baseRr?.rerank_id || '',
        keywordEnabled: Boolean(baseRr?.keyword_enabled),
      };
      setBaseSnap(snap);
      applySnapToState(snap, aiPatch || null, rModels);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [baselineRun.id, mode]);

  const currentValues: Record<string, any> = {
    parserId,
    pagerank,
    embeddingModel,
    pdfParseMethod,
    sheetParseMethod,
    pdfOutputFormat,
    visionEnhance,
    vlmLlmId,
    pdfFlattenMedia,
    docxFlattenMedia,
    mdFlattenMedia,
    sheetFlattenMedia,
    chunkTokenSize,
    overlappedPercent,
    delimitersText,
    tableContextSize,
    imageContextSize,
    useParentChild,
    childrenDelimiter,
    extractorLlmId,
    keywordsTopN,
    questionsTopN,
    tagsTopN,
    summaryEnabled,
    metadataEnabled,
    filenameWeight,
    searchEmbedding,
    searchFullText,
    tokenizerFields,
    topK,
    similarityThreshold,
    vectorWeight,
    useRerank,
    rerankId,
    keywordEnabled,
  };

  const isChanged = (key: string) =>
    !isReadOnly && baseSnap[key] !== undefined && baseSnap[key] !== currentValues[key];

  const totalChanged = Object.keys(currentValues).filter((k) => isChanged(k)).length;

  const fmtVal = (v: any) => {
    if (typeof v === 'boolean') return v ? 'Bật' : 'Tắt';
    if (v === '' || v === null || v === undefined) return 'Mặc định';
    return String(v);
  };

  const fieldBox = (key: string, label: string, children: React.ReactNode, className = '') => {
    const changed = isChanged(key);
    return (
      <div
        className={`px-2 py-1.5 rounded-[4px] border space-y-1 ${
          changed
            ? 'border-[#d97706] bg-[#fffbeb] ring-1 ring-[#f59e0b]/30'
            : 'border-[#ececea] bg-[#fcfcfb]'
        } ${className}`}
      >
        <div className="flex items-center justify-between gap-1.5">
          <label className="text-[10.5px] font-medium text-[#3f3f46] truncate">{label}</label>
          {changed && (
            <span className="font-mono text-[9px] px-1 rounded bg-[#fef3c7] text-[#92400e] truncate max-w-[110px]">
              Gốc: {fmtVal(baseSnap[key])}
            </span>
          )}
        </div>
        {children}
      </div>
    );
  };

  const buildParserConfig = (): Record<string, any> => {
    const nextPc: Record<string, any> = JSON.parse(JSON.stringify(rawPc || {}));
    const pKey = findNodeKey(nextPc, 'Parser:') || 'Parser:default';
    const cKey = findNodeKey(nextPc, 'GeneralChunker:') || 'GeneralChunker:default';
    const eKey = findNodeKey(nextPc, 'Extractor:') || 'Extractor:default';
    const tKey = findNodeKey(nextPc, 'Tokenizer:') || 'Tokenizer:default';

    nextPc[pKey] = {
      ...(nextPc[pKey] || {}),
      enable_vision_enhancement: visionEnhance,
      vlm: { ...(nextPc[pKey]?.vlm || {}), llm_id: vlmLlmId },
      pdf: {
        ...(nextPc[pKey]?.pdf || {}),
        parse_method: pdfParseMethod,
        output_format: pdfOutputFormat,
        flatten_media_to_text: pdfFlattenMedia,
      },
      spreadsheet: {
        ...(nextPc[pKey]?.spreadsheet || {}),
        parse_method: sheetParseMethod,
        flatten_media_to_text: sheetFlattenMedia,
      },
      docx: { ...(nextPc[pKey]?.docx || {}), flatten_media_to_text: docxFlattenMedia },
      markdown: { ...(nextPc[pKey]?.markdown || {}), flatten_media_to_text: mdFlattenMedia },
    };

    const delims = delimitersText
      .split(/\s+/)
      .filter(Boolean)
      .map((d) => (d === '\\n' ? '\n' : d));

    nextPc[cKey] = {
      ...(nextPc[cKey] || {}),
      chunk_token_size: Number(chunkTokenSize),
      overlapped_percent: Number(overlappedPercent),
      delimiters: delims.length ? delims : ['\n', '!', '?', ';'],
      table_context_size: Number(tableContextSize),
      image_context_size: Number(imageContextSize),
      parent_child: {
        ...(nextPc[cKey]?.parent_child || {}),
        use_parent_child: useParentChild,
        children_delimiter: childrenDelimiter === '\\n' ? '\n' : childrenDelimiter,
      },
    };

    nextPc[eKey] = {
      ...(nextPc[eKey] || {}),
      llm_id: extractorLlmId,
      keywords: { ...(nextPc[eKey]?.keywords || {}), top_n: Number(keywordsTopN) },
      questions: { ...(nextPc[eKey]?.questions || {}), top_n: Number(questionsTopN) },
      tags: { ...(nextPc[eKey]?.tags || {}), top_n: Number(tagsTopN) },
      summary: { ...(nextPc[eKey]?.summary || {}), enabled: summaryEnabled },
      metadata: { ...(nextPc[eKey]?.metadata || {}), enabled: metadataEnabled },
    };

    const sm: string[] = [];
    if (searchEmbedding) sm.push('embedding');
    if (searchFullText) sm.push('full_text');

    nextPc[tKey] = {
      ...(nextPc[tKey] || {}),
      fields: tokenizerFields || 'text',
      filename_embd_weight: Number(filenameWeight),
      search_method: sm.length ? sm : ['embedding', 'full_text'],
    };

    nextPc.chunk_token_num = Number(chunkTokenSize);
    nextPc.layout_recognize = pdfParseMethod;
    return nextPc;
  };

  const handleLaunch = async () => {
    if (!name.trim()) {
      toast.error('Vui lòng nhập tên cho nhánh thí nghiệm [B]');
      return;
    }
    setLaunching(true);
    try {
      const job = await api.startCloneAndRun({
        source_run_id: baselineRun.id,
        name: name.trim(),
        parser_id: parserId,
        embedding_model: embeddingModel || undefined,
        pagerank: Number(pagerank),
        parser_config: buildParserConfig(),
        top_k: Number(topK),
        similarity_threshold: Number(similarityThreshold),
        vector_similarity_weight: Number(vectorWeight),
        rerank_id: useRerank ? rerankId : '',
        rerank_top_k: Number(rerankTopK),
        keyword_enabled: keywordEnabled,
        parsing_mode: parsingMode,
        retrieval_judge_engine: 'llm',
      });
      toast.success(`Đã khởi chạy nhánh "${name.trim()}" (Job #${job.id})`);
      onStarted?.(job);
    } catch (e: any) {
      toast.error(e.message || 'Không khởi chạy được pipeline');
    } finally {
      setLaunching(false);
    }
  };

  const inp =
    'w-full h-7 px-2 text-[11.5px] border border-[#dcdcd8] rounded-[3px] bg-white disabled:bg-[#f5f5f3] disabled:text-[#3f3f46] disabled:cursor-default focus:outline-none focus:border-[#03aa5c]';

  const secCard = 'rounded-[6px] border border-[#e4e4e0] bg-white p-3 flex flex-col gap-2';
  const secHead = 'flex items-center gap-1.5 pb-1.5 border-b border-[#f0f0ee] text-[11.5px] font-semibold text-[#161616]';

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-2.5 sm:p-4">
      <div
        ref={modalRef}
        className="w-[95vw] h-[93vh] max-w-[1520px] bg-[#f7f7f5] border border-[#d8d8d4] rounded-[8px] shadow-xl flex flex-col overflow-hidden"
      >
        {/* Ultra-slim Single-Line Top Bar */}
        <div className="h-11 px-4 border-b border-[#e4e4e0] bg-white flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {isReadOnly ? (
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-[3px] bg-[#161616] text-white shrink-0">
                BASELINE [A] · RUN #{baselineRun.id}
              </span>
            ) : (
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-[3px] bg-[#03aa5c] text-white shrink-0">
                THÍ NGHIỆM [B] · DATASET MỚI
              </span>
            )}

            <input
              value={name}
              disabled={isReadOnly}
              onChange={(e) => setName(e.target.value)}
              className="h-7 px-2.5 text-[12px] font-semibold text-[#161616] border border-[#e4e4e0] rounded-[4px] bg-[#fafaf9] disabled:bg-transparent disabled:border-transparent w-[260px] sm:w-[320px] truncate focus:outline-none focus:border-[#03aa5c]"
              placeholder="Tên nhánh thí nghiệm [B]"
            />

            {!isReadOnly && aiPatch && (
              <span className="hidden md:inline-flex items-center gap-1 font-mono text-[10px] px-2 py-0.5 rounded bg-[#fef3c7] text-[#92400e] border border-[#fde68a] shrink-0">
                <Sparkles className="size-3" /> Đã nạp đề xuất AI
              </span>
            )}
            {!isReadOnly && totalChanged > 0 && (
              <span className="font-mono text-[10.5px] font-semibold text-[#b45309] shrink-0">
                · {totalChanged} thay đổi
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {!isReadOnly && totalChanged > 0 && (
              <button
                type="button"
                onClick={() => applySnapToState(baseSnap, null, rerankModels)}
                className="inline-flex items-center gap-1 px-2.5 h-7 text-[11px] font-medium text-[#52525b] hover:text-[#161616] border border-[#dedede] rounded-[4px] bg-white"
              >
                <RotateCcw className="size-3" /> Khôi phục gốc
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-[#ededeb] text-[#71717a] hover:text-[#161616]"
              title="Đóng"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Single-Page Compact 3x2 Cockpit Grid (ALL 6 RAGFlow Sections Visible Together) */}
        <div
          style={{ contain: 'layout style' }}
          className="flex-1 overflow-y-auto p-3"
        >
          {loading ? (
            <div className="h-full flex items-center justify-center gap-2 text-[12px] text-[#71717a]">
              <Loader2 className="size-4 animate-spin text-[#03aa5c]" /> Đang nạp toàn bộ cấu hình RAGFlow...
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-2.5 h-full">
              {/* 1. DATASET & CHUNG */}
              <section className={secCard}>
                <div className={secHead}>
                  <Database className="size-3.5 text-[#03aa5c]" />
                  <span>1. Dataset & Chung</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {fieldBox(
                    'parserId',
                    'Chunk Method / Template',
                    <select
                      value={parserId}
                      disabled={isReadOnly}
                      onChange={(e) => setParserId(e.target.value)}
                      className={inp}
                    >
                      {PARSER_IDS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {fieldBox(
                    'pagerank',
                    'PageRank (0–100)',
                    <input
                      type="number"
                      min={0}
                      max={100}
                      disabled={isReadOnly}
                      value={pagerank}
                      onChange={(e) => setPagerank(Number(e.target.value))}
                      className={`${inp} font-mono`}
                    />
                  )}
                  {fieldBox(
                    'embeddingModel',
                    'Embedding Model (RAGFlow)',
                    embModels.length > 0 ? (
                      <select
                        value={embeddingModel}
                        disabled={isReadOnly}
                        onChange={(e) => setEmbeddingModel(e.target.value)}
                        className={`${inp} font-mono text-[11px]`}
                      >
                        <option value="">Mặc định RAGFlow</option>
                        {embeddingModel && !embModels.some((m) => (m.full_name || m.name) === embeddingModel) && (
                          <option value={embeddingModel}>{embeddingModel}</option>
                        )}
                        {embModels.map((m) => (
                          <option key={m.id} value={m.full_name || m.name}>
                            {m.full_name || m.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={embeddingModel}
                        disabled={isReadOnly}
                        onChange={(e) => setEmbeddingModel(e.target.value)}
                        className={`${inp} font-mono text-[11px]`}
                      />
                    ),
                    'col-span-2'
                  )}
                </div>
                <div className="mt-auto pt-1.5 border-t border-[#f4f4f2] flex items-center justify-between text-[10px] font-mono text-[#71717a]">
                  <span>DATASET ID</span>
                  <span className="truncate max-w-[240px]">{baselineRun.ragflow_dataset_id || 'Chưa gắn'}</span>
                </div>
              </section>

              {/* 2. PARSER & OCR */}
              <section className={secCard}>
                <div className={secHead}>
                  <FileSearch className="size-3.5 text-[#03aa5c]" />
                  <span>2. Parser & OCR</span>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {fieldBox(
                    'pdfParseMethod',
                    'PDF Engine',
                    <select
                      value={pdfParseMethod}
                      disabled={isReadOnly}
                      onChange={(e) => setPdfParseMethod(e.target.value)}
                      className={inp}
                    >
                      <option value="DeepDOC">DeepDOC</option>
                      <option value="Plain Text">Plain Text</option>
                      <option value="MinerU">MinerU</option>
                    </select>
                  )}
                  {fieldBox(
                    'sheetParseMethod',
                    'Excel / CSV',
                    <select
                      value={sheetParseMethod}
                      disabled={isReadOnly}
                      onChange={(e) => setSheetParseMethod(e.target.value)}
                      className={inp}
                    >
                      <option value="DeepDOC">DeepDOC</option>
                      <option value="Plain Text">Plain Text</option>
                    </select>
                  )}
                  {fieldBox(
                    'pdfOutputFormat',
                    'Output Format',
                    <select
                      value={pdfOutputFormat}
                      disabled={isReadOnly}
                      onChange={(e) => setPdfOutputFormat(e.target.value)}
                      className={`${inp} font-mono`}
                    >
                      <option value="json">json</option>
                      <option value="markdown">markdown</option>
                      <option value="html">html</option>
                    </select>
                  )}
                  {fieldBox(
                    'visionEnhance',
                    'Vision Enhance',
                    <label className="flex items-center gap-1.5 h-7 cursor-pointer text-[11px] text-[#3f3f46]">
                      <input
                        type="checkbox"
                        disabled={isReadOnly}
                        checked={visionEnhance}
                        onChange={(e) => setVisionEnhance(e.target.checked)}
                        className="accent-[#03aa5c]"
                      />
                      <span>{visionEnhance ? 'Bật' : 'Tắt'}</span>
                    </label>
                  )}
                  {fieldBox(
                    'vlmLlmId',
                    'VLM Model ID',
                    <input
                      value={vlmLlmId}
                      disabled={isReadOnly}
                      onChange={(e) => setVlmLlmId(e.target.value)}
                      placeholder="Mặc định"
                      className={`${inp} font-mono text-[11px]`}
                    />,
                    'col-span-2'
                  )}
                  <div className="col-span-3 px-2 py-1.5 rounded-[4px] border border-[#ececea] bg-[#fcfcfb] space-y-1">
                    <div className="text-[10.5px] font-medium text-[#3f3f46]">Flatten Media to Text</div>
                    <div className="grid grid-cols-4 gap-1.5 text-[11px]">
                      {[
                        ['pdfFlattenMedia', 'PDF', pdfFlattenMedia, setPdfFlattenMedia],
                        ['docxFlattenMedia', 'DOCX', docxFlattenMedia, setDocxFlattenMedia],
                        ['mdFlattenMedia', 'MD', mdFlattenMedia, setMdFlattenMedia],
                        ['sheetFlattenMedia', 'Excel', sheetFlattenMedia, setSheetFlattenMedia],
                      ].map(([k, lbl, val, setter]: any) => (
                        <label
                          key={k}
                          className={`flex items-center justify-center gap-1 h-6 rounded border cursor-pointer ${
                            isChanged(k)
                              ? 'border-[#d97706] bg-[#fffbeb] text-[#92400e]'
                              : 'border-[#e5e5e5] bg-white text-[#3f3f46]'
                          }`}
                        >
                          <input
                            type="checkbox"
                            disabled={isReadOnly}
                            checked={val}
                            onChange={(e) => setter(e.target.checked)}
                            className="accent-[#03aa5c]"
                          />
                          <span>{lbl}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              {/* 3. CHUNKING */}
              <section className={secCard}>
                <div className={secHead}>
                  <Layers className="size-3.5 text-[#03aa5c]" />
                  <span>3. Chunking & Parent-Child</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {fieldBox(
                    'chunkTokenSize',
                    `Token Size (${chunkTokenSize})`,
                    <input
                      type="range"
                      min={128}
                      max={2048}
                      step={64}
                      disabled={isReadOnly}
                      value={chunkTokenSize}
                      onChange={(e) => setChunkTokenSize(Number(e.target.value))}
                      className="w-full h-5 accent-[#03aa5c]"
                    />
                  )}
                  {fieldBox(
                    'overlappedPercent',
                    `Overlap (${overlappedPercent}%)`,
                    <input
                      type="range"
                      min={0}
                      max={30}
                      step={1}
                      disabled={isReadOnly}
                      value={overlappedPercent}
                      onChange={(e) => setOverlappedPercent(Number(e.target.value))}
                      className="w-full h-5 accent-[#03aa5c]"
                    />
                  )}
                  {fieldBox(
                    'tableContextSize',
                    'Table Context (tok)',
                    <input
                      type="number"
                      min={0}
                      max={1024}
                      step={32}
                      disabled={isReadOnly}
                      value={tableContextSize}
                      onChange={(e) => setTableContextSize(Number(e.target.value))}
                      className={`${inp} font-mono`}
                    />
                  )}
                  {fieldBox(
                    'imageContextSize',
                    'Image Context (tok)',
                    <input
                      type="number"
                      min={0}
                      max={1024}
                      step={32}
                      disabled={isReadOnly}
                      value={imageContextSize}
                      onChange={(e) => setImageContextSize(Number(e.target.value))}
                      className={`${inp} font-mono`}
                    />
                  )}
                  {fieldBox(
                    'delimitersText',
                    'Delimiters',
                    <input
                      value={delimitersText}
                      disabled={isReadOnly}
                      onChange={(e) => setDelimitersText(e.target.value)}
                      className={`${inp} font-mono text-[11px]`}
                    />
                  )}
                  {fieldBox(
                    'useParentChild',
                    'Parent-Child',
                    <div className="flex items-center gap-1.5 h-7">
                      <label className="flex items-center gap-1 text-[11px] text-[#3f3f46] shrink-0 cursor-pointer">
                        <input
                          type="checkbox"
                          disabled={isReadOnly}
                          checked={useParentChild}
                          onChange={(e) => setUseParentChild(e.target.checked)}
                          className="accent-[#03aa5c]"
                        />
                        <span>{useParentChild ? 'Bật' : 'Tắt'}</span>
                      </label>
                      {useParentChild && (
                        <input
                          value={childrenDelimiter}
                          disabled={isReadOnly}
                          onChange={(e) => setChildrenDelimiter(e.target.value)}
                          placeholder="\\n"
                          className="w-14 h-6 px-1.5 text-[11px] font-mono border border-[#dcdcd8] rounded bg-white"
                        />
                      )}
                    </div>
                  )}
                </div>
              </section>

              {/* 4. AUTO-EXTRACTOR */}
              <section className={secCard}>
                <div className={secHead}>
                  <Tag className="size-3.5 text-[#03aa5c]" />
                  <span>4. Auto-Extractor (LLM)</span>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {fieldBox(
                    'keywordsTopN',
                    'Keywords Top N',
                    <input
                      type="number"
                      min={0}
                      max={20}
                      disabled={isReadOnly}
                      value={keywordsTopN}
                      onChange={(e) => setKeywordsTopN(Number(e.target.value))}
                      className={`${inp} font-mono`}
                    />
                  )}
                  {fieldBox(
                    'questionsTopN',
                    'Questions Top N',
                    <input
                      type="number"
                      min={0}
                      max={10}
                      disabled={isReadOnly}
                      value={questionsTopN}
                      onChange={(e) => setQuestionsTopN(Number(e.target.value))}
                      className={`${inp} font-mono`}
                    />
                  )}
                  {fieldBox(
                    'tagsTopN',
                    'Tags Top N',
                    <input
                      type="number"
                      min={0}
                      max={20}
                      disabled={isReadOnly}
                      value={tagsTopN}
                      onChange={(e) => setTagsTopN(Number(e.target.value))}
                      className={`${inp} font-mono`}
                    />
                  )}
                  {fieldBox(
                    'summaryEnabled',
                    'Auto Summary',
                    <label className="flex items-center gap-1.5 h-7 cursor-pointer text-[11px] text-[#3f3f46]">
                      <input
                        type="checkbox"
                        disabled={isReadOnly}
                        checked={summaryEnabled}
                        onChange={(e) => setSummaryEnabled(e.target.checked)}
                        className="accent-[#03aa5c]"
                      />
                      <span>{summaryEnabled ? 'Bật' : 'Tắt'}</span>
                    </label>
                  )}
                  {fieldBox(
                    'metadataEnabled',
                    'Auto Metadata',
                    <label className="flex items-center gap-1.5 h-7 cursor-pointer text-[11px] text-[#3f3f46]">
                      <input
                        type="checkbox"
                        disabled={isReadOnly}
                        checked={metadataEnabled}
                        onChange={(e) => setMetadataEnabled(e.target.checked)}
                        className="accent-[#03aa5c]"
                      />
                      <span>{metadataEnabled ? 'Bật' : 'Tắt'}</span>
                    </label>
                  )}
                  {fieldBox(
                    'extractorLlmId',
                    'Extractor LLM',
                    <input
                      value={extractorLlmId}
                      disabled={isReadOnly}
                      onChange={(e) => setExtractorLlmId(e.target.value)}
                      placeholder="Mặc định"
                      className={`${inp} font-mono text-[10.5px]`}
                    />
                  )}
                </div>
              </section>

              {/* 5. TOKENIZER & INDEXING */}
              <section className={secCard}>
                <div className={secHead}>
                  <Terminal className="size-3.5 text-[#03aa5c]" />
                  <span>5. Tokenizer & Chỉ mục</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {fieldBox(
                    'filenameWeight',
                    'Filename Weight',
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      disabled={isReadOnly}
                      value={filenameWeight}
                      onChange={(e) => setFilenameWeight(Number(e.target.value))}
                      className={`${inp} font-mono`}
                    />
                  )}
                  {fieldBox(
                    'tokenizerFields',
                    'Indexed Fields',
                    <input
                      value={tokenizerFields}
                      disabled={isReadOnly}
                      onChange={(e) => setTokenizerFields(e.target.value)}
                      className={`${inp} font-mono`}
                    />
                  )}
                  {fieldBox(
                    'searchEmbedding',
                    'Vector Embedding',
                    <label className="flex items-center gap-1.5 h-7 cursor-pointer text-[11px] text-[#3f3f46]">
                      <input
                        type="checkbox"
                        disabled={isReadOnly}
                        checked={searchEmbedding}
                        onChange={(e) => setSearchEmbedding(e.target.checked)}
                        className="accent-[#03aa5c]"
                      />
                      <span>{searchEmbedding ? 'Bật' : 'Tắt'}</span>
                    </label>
                  )}
                  {fieldBox(
                    'searchFullText',
                    'Full-Text (BM25)',
                    <label className="flex items-center gap-1.5 h-7 cursor-pointer text-[11px] text-[#3f3f46]">
                      <input
                        type="checkbox"
                        disabled={isReadOnly}
                        checked={searchFullText}
                        onChange={(e) => setSearchFullText(e.target.checked)}
                        className="accent-[#03aa5c]"
                      />
                      <span>{searchFullText ? 'Bật' : 'Tắt'}</span>
                    </label>
                  )}
                </div>
              </section>

              {/* 6. RETRIEVAL & AUTO-QC */}
              <section className={secCard}>
                <div className={secHead}>
                  <Search className="size-3.5 text-[#03aa5c]" />
                  <span>6. Retrieval & Chấm tự động</span>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {fieldBox(
                    'topK',
                    'Top-N trả về',
                    <input
                      type="number"
                      min={3}
                      max={30}
                      disabled={isReadOnly}
                      value={topK}
                      onChange={(e) => setTopK(Number(e.target.value))}
                      className={`${inp} font-mono`}
                    />
                  )}
                  {fieldBox(
                    'similarityThreshold',
                    `Ngưỡng (${similarityThreshold.toFixed(2)})`,
                    <input
                      type="range"
                      min={0}
                      max={0.8}
                      step={0.05}
                      disabled={isReadOnly}
                      value={similarityThreshold}
                      onChange={(e) => setSimilarityThreshold(Number(e.target.value))}
                      className="w-full h-5 accent-[#03aa5c]"
                    />
                  )}
                  {fieldBox(
                    'vectorWeight',
                    `Vec ${Math.round(vectorWeight * 100)}% / KW ${Math.round((1 - vectorWeight) * 100)}%`,
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      disabled={isReadOnly}
                      value={vectorWeight}
                      onChange={(e) => setVectorWeight(Number(e.target.value))}
                      className="w-full h-5 accent-[#03aa5c]"
                    />
                  )}

                  {fieldBox(
                    'useRerank',
                    'Rerank Model (RAGFlow)',
                    <div className="flex items-center gap-1.5">
                      <label className="flex items-center gap-1 text-[11px] text-[#3f3f46] shrink-0 cursor-pointer">
                        <input
                          type="checkbox"
                          disabled={isReadOnly}
                          checked={useRerank}
                          onChange={(e) => {
                            setUseRerank(e.target.checked);
                            if (e.target.checked && !rerankId && rerankModels.length > 0) {
                              setRerankId(rerankModels[0].id);
                            }
                          }}
                          className="accent-[#03aa5c]"
                        />
                        <span>{useRerank ? 'Bật' : 'Tắt'}</span>
                      </label>
                      {useRerank && (
                        <>
                          <select
                            value={rerankId}
                            disabled={isReadOnly}
                            onChange={(e) => setRerankId(e.target.value)}
                            className="flex-1 min-w-0 h-7 px-1.5 text-[10.5px] font-mono border border-[#dcdcd8] rounded bg-white"
                          >
                            {rerankModels.length === 0 && <option value="">Không có model</option>}
                            {rerankModels.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.full_name || m.name}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            min={10}
                            max={128}
                            disabled={isReadOnly}
                            value={rerankTopK}
                            onChange={(e) => setRerankTopK(Number(e.target.value))}
                            title="Rerank Candidates"
                            className="w-14 h-7 px-1.5 text-[11px] font-mono border border-[#dcdcd8] rounded bg-white shrink-0"
                          />
                        </>
                      )}
                    </div>,
                    'col-span-3'
                  )}

                  {!isReadOnly && (
                    <div className="col-span-3 flex items-center justify-between gap-2 px-2 py-1 rounded-[4px] border border-[#ececea] bg-[#fafaf9]">
                      <span className="text-[10.5px] font-medium text-[#3f3f46]">Chấm Parsing tự động:</span>
                      <div className="inline-flex rounded border border-[#dcdcd8] overflow-hidden text-[10.5px]">
                        <button
                          type="button"
                          onClick={() => setParsingMode('deep')}
                          className={`px-2 py-0.5 font-medium ${
                            parsingMode === 'deep' ? 'bg-[#03aa5c] text-white' : 'bg-white text-[#52525b]'
                          }`}
                        >
                          Sâu · Heuristic + AI
                        </button>
                        <button
                          type="button"
                          onClick={() => setParsingMode('heuristic')}
                          className={`px-2 py-0.5 font-medium border-l border-[#dcdcd8] ${
                            parsingMode === 'heuristic' ? 'bg-[#03aa5c] text-white' : 'bg-white text-[#52525b]'
                          }`}
                        >
                          Nhanh · Heuristic
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>

        {/* Compact Bottom Footer */}
        <div className="h-12 px-4 border-t border-[#e4e4e0] bg-white flex items-center justify-between gap-4 shrink-0">
          <div className="text-[11px] text-[#52525b] font-mono truncate flex items-center gap-1.5">
            <Cpu className="size-3.5 text-[#03aa5c] shrink-0" />
            {isReadOnly
              ? 'Toàn bộ cấu hình Baseline [A] đồng bộ trực tiếp từ RAGFlow'
              : 'Tự động: Tạo Dataset → Đẩy file → RAGFlow Parse → Chấm Parse → Chấm Chunk → Chấm Golden'}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onClose}
              className="px-3.5 h-8 text-[12px] font-medium text-[#52525b] hover:text-[#161616] rounded-[4px] border border-[#dedede] bg-white"
            >
              {isReadOnly ? 'Đóng' : 'Hủy'}
            </button>
            {isReadOnly ? (
              onCloneFromBaseline && (
                <button
                  onClick={() => {
                    onClose();
                    onCloneFromBaseline();
                  }}
                  className="inline-flex items-center gap-1.5 px-4 h-8 text-[12px] font-semibold text-white bg-[#03aa5c] hover:bg-[#028a4b] rounded-[4px]"
                >
                  Nhân bản cấu hình này sang [B]
                </button>
              )
            ) : (
              <button
                onClick={handleLaunch}
                disabled={loading || launching}
                className="inline-flex items-center gap-1.5 px-4 h-8 text-[12px] font-semibold text-white bg-[#161616] hover:bg-black rounded-[4px] disabled:opacity-50"
              >
                {launching ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />}
                Khởi chạy toàn quy trình
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
