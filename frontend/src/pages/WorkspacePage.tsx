import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  CloudDownload,
  Download,
  Eye,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { DocumentItem, RunDocumentItem, RunItem } from '../types';
import { RagflowParserConfigModal } from '../components/RagflowParserConfigModal';
import { DatasetFlowModal } from '../components/DatasetFlowModal';

interface Props {
  activeRun: RunItem | null;
  runs: RunItem[];
  refreshKey?: number;
  onReloadRuns: (preferredRunId?: number) => void;
  onSelectRun: (run: RunItem) => void;
  onOpenSettings: () => void;
  onNextStep: () => void;
}

const FORMAT_GROUPS = [
  'PDF văn bản',
  'PDF scan / ảnh',
  'DOCX có bảng',
  'Trang web (HTML / MD)',
  'Slide / Excel',
];

const CHUNK_METHODS = [
  { id: 'naive', label: 'General (naive)' },
  { id: 'laws', label: 'Laws (văn bản luật)' },
  { id: 'manual', label: 'Manual (sổ tay)' },
  { id: 'paper', label: 'Paper (bài báo)' },
  { id: 'book', label: 'Book (sách)' },
  { id: 'table', label: 'Table (bảng biểu)' },
  { id: 'qa', label: 'Q&A (hỏi đáp)' },
  { id: 'presentation', label: 'Presentation (slide)' },
];

export const WorkspacePage: React.FC<Props> = ({
  activeRun,
  refreshKey = 0,
  onReloadRuns,
  onSelectRun,
  onOpenSettings,
  onNextStep,
}) => {
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [runDocs, setRunDocs] = useState<RunDocumentItem[]>([]);
  const [remoteDatasets, setRemoteDatasets] = useState<any[]>([]);
  const [busy, setBusy] = useState('');
  const [polling, setPolling] = useState(false);
  const [parseErrors, setParseErrors] = useState<Record<number, string>>({});
  const pollBusyRef = useRef(false);
  const pollingRef = useRef(false);
  const updatePolling = (v: boolean) => {
    pollingRef.current = v;
    setPolling(v);
  };

  const [showNewRun, setShowNewRun] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    description: string;
    confirmLabel?: string;
    onConfirm: () => Promise<void>;
  } | null>(null);

  const [runName, setRunName] = useState('');
  const [runDatasetId, setRunDatasetId] = useState('');
  const [runIsBase, setRunIsBase] = useState(true);
  const [runCreateRemote, setRunCreateRemote] = useState(false);

  // Parser config state (shared by New Run modal & Edit Parser Config modal)
  const [showParserCfg, setShowParserCfg] = useState(false);
  const [cfgMethod, setCfgMethod] = useState('naive');
  const [cfgTokenNum, setCfgTokenNum] = useState(512);
  const [cfgDelimiter, setCfgDelimiter] = useState('\\n!?;。；！？');
  const [cfgLayout, setCfgLayout] = useState('DeepDOC');
  const [cfgHtml4Excel, setCfgHtml4Excel] = useState(false);

  const openParserConfigModal = () => {
    const pc = (activeRun?.parser_config || {}) as Record<string, any>;
    setCfgMethod(String(pc.chunk_method || 'naive'));
    setCfgTokenNum(Number(pc.chunk_token_num || 512));
    setCfgDelimiter(String(pc.delimiter || '\\n!?;。；！？'));
    setCfgLayout(String(pc.layout_recognize || 'DeepDOC'));
    setCfgHtml4Excel(Boolean(pc.html4excel));
    setShowParserCfg(true);
  };

  const handleSaveParserConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRun) return;
    setBusy('parser_cfg');
    try {
      const res = await api.updateRunParserConfig(activeRun.id, {
        chunk_method: cfgMethod,
        parser_config: {
          chunk_token_num: Number(cfgTokenNum) || 512,
          delimiter: cfgDelimiter,
          layout_recognize: cfgLayout,
          html4excel: cfgHtml4Excel,
        },
        sync_remote: true,
      });
      setShowParserCfg(false);
      onReloadRuns(activeRun.id);
      if (res.remote_synced) {
        toast.success('Đã lưu và đồng bộ cấu hình Parse lên RAGFlow.');
      } else if (res.remote_warning) {
        toast.warning(`Đã lưu cấu hình local (chưa đồng bộ lên RAGFlow: ${res.remote_warning}).`);
      } else {
        toast.success('Đã lưu cấu hình Parse.');
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy('');
    }
  };

  const [upCode, setUpCode] = useState('DOC01');
  const [upGroup, setUpGroup] = useState('AUTO');
  const [upUrl, setUpUrl] = useState('');
  const [upFiles, setUpFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadAll = async () => {
    const dRes = await api.listDocuments(activeRun?.id);
    setDocs(dRes);
    setUpCode(`DOC${String(dRes.length + 1).padStart(2, '0')}`);
    if (activeRun) {
      const rd = await api.getRunDocuments(activeRun.id);
      setRunDocs(rd);
      if (rd.some((item: RunDocumentItem) => item.parse_status === 'RUNNING')) {
        updatePolling(true);
      } else {
        updatePolling(false);
      }
    } else {
      setRunDocs([]);
      setPolling(false);
    }
  };

  useEffect(() => {
    setPolling(false);
    setParseErrors({});
    loadAll();
  }, [activeRun?.id, refreshKey]);

  const checkParseStatus = async (notifyWhenDone: boolean) => {
    if (!activeRun || pollBusyRef.current) return;
    pollBusyRef.current = true;
    try {
      const res = await api.getRunParseStatus(activeRun.id);
      setRunDocs(res.documents || []);
      setParseErrors(res.errors || {});

      const anyRunning = Boolean(res.is_parsing) || (res.documents || []).some((d: RunDocumentItem) => d.parse_status === 'RUNNING');
      if (anyRunning) {
        updatePolling(true);
      } else {
        const wasPolling = pollingRef.current;
        updatePolling(false);
        if (notifyWhenDone && wasPolling) {
          const doneCount = res.counts?.done ?? 0;
          const failCount = res.counts?.failed ?? 0;
          if (doneCount > 0) {
            const failSuffix = failCount > 0 ? ` (${failCount} file lỗi)` : '';
            const msg = `Parse hoàn tất (${doneCount} file xong${failSuffix}). Bấm "Đồng bộ RAGFlow" để kéo chunks.`;
            if (failCount === 0) toast.success(msg);
            else toast.warning(msg);
          } else if (failCount > 0) {
            toast.error(`Parse thất bại (${failCount} file lỗi). Xem chi tiết lỗi ở cột Trạng thái.`);
          }
        }
      }
    } catch (err: any) {
      updatePolling(false);
      toast.error(err.message);
    } finally {
      pollBusyRef.current = false;
    }
  };

  useEffect(() => {
    if (!polling || !activeRun) return;
    const timer = window.setInterval(() => {
      if (!pollingRef.current) return;
      checkParseStatus(true);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [polling, activeRun?.id]);

  const openNewRunModal = async () => {
    setShowNewRun(true);
    try {
      const res = await api.testRagflow();
      setRemoteDatasets(res.datasets || []);
    } catch {
      setRemoteDatasets([]);
    }
  };

  const handleCreateRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!runName.trim()) return;
    setBusy('create');
    try {
      const created = await api.createRun({
        name: runName.trim(),
        is_baseline: runIsBase,
        ragflow_dataset_id: runDatasetId.trim(),
        ragflow_dataset_name: runName.trim(),
        create_remote_dataset: runCreateRemote,
        chunk_method: cfgMethod,
        parser_config: {
          chunk_method: cfgMethod,
          chunk_token_num: Number(cfgTokenNum) || 512,
          delimiter: cfgDelimiter,
          layout_recognize: cfgLayout,
          html4excel: cfgHtml4Excel,
        },
      });
      setShowNewRun(false);
      setRunName('');
      onSelectRun(created);
      onReloadRuns(created.id);
      toast.success(`Đã tạo phiên "${created.name}".`);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy('');
    }
  };

  const addPickedFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const incoming = Array.from(fileList);
    setUpFiles((prev) => {
      const existingKeys = new Set(prev.map((f) => `${f.name}_${f.size}`));
      return [...prev, ...incoming.filter((f) => !existingKeys.has(`${f.name}_${f.size}`))];
    });
  };

  const handleUploadDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (upFiles.length === 0) return;
    setBusy('upload');
    try {
      if (upFiles.length === 1) {
        const fd = new FormData();
        fd.append('file', upFiles[0]);
        fd.append('doc_code', upCode);
        fd.append('format_group', upGroup === 'AUTO' ? FORMAT_GROUPS[0] : upGroup);
        fd.append('source_url', upUrl);
        await api.uploadDocument(fd);
        toast.success(`Đã thêm tài liệu "${upFiles[0].name}" vào kho.`);
      } else {
        const fd = new FormData();
        upFiles.forEach((f) => fd.append('files', f));
        fd.append('format_group', upGroup);
        const res = await api.uploadDocumentsBatch(fd);
        toast.success(`Đã tải lên ${res.uploaded_count} tài liệu gốc vào kho.`);
      }
      setUpFiles([]);
      setUpUrl('');
      setShowUpload(false);
      await loadAll();
      // Automatically push & parse on RAGFlow if an active run with dataset_id is selected
      if (activeRun?.ragflow_dataset_id) {
        try {
          const pushRes = await api.uploadAndParseRun(activeRun.id);
          await loadAll();
          if (pushRes.uploaded_and_triggered > 0) {
            setPolling(true);
            toast.info(`Đã tự động đẩy ${pushRes.uploaded_and_triggered} file lên RAGFlow và bắt đầu parse...`);
          }
        } catch (pushErr: any) {
          toast.warning(`Đã lưu local nhưng chưa đẩy được lên RAGFlow: ${pushErr.message}`);
        }
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy('');
    }
  };

  const handleSync = async () => {
    if (!activeRun) return;
    setBusy('sync');
    try {
      const res = await api.syncRunFromRagflow(activeRun.id);
      await loadAll();
      onReloadRuns();
      const extra = res.auto_extracted_units
        ? ` · tự tách ${res.auto_extracted_units} đoạn đối chiếu`
        : '';
      toast.success(
        `Đã đồng bộ ${res.synced_documents} tài liệu, ${res.synced_chunks} đoạn cắt${extra}.`
      );
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy('');
    }
  };

  const handleUploadAndParse = async () => {
    if (!activeRun) return;
    setBusy('push');
    setParseErrors({});
    try {
      const res = await api.uploadAndParseRun(activeRun.id);
      await loadAll();
      if (res.uploaded_and_triggered > 0) {
        setPolling(true);
        toast.info(
          `Đã đẩy ${res.uploaded_and_triggered} tài liệu lên RAGFlow. Đang tự động theo dõi tiến độ parse (mỗi 3 giây)...`
        );
      } else {
        toast.warning('Chưa có file gốc nào trong kho để đẩy lên RAGFlow. Hãy bấm "Thêm file gốc" trước.');
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy('');
    }
  };

  const handleCheckStatusManual = async () => {
    if (!activeRun) return;
    setBusy('status');
    try {
      await checkParseStatus(true);
    } finally {
      setBusy('');
    }
  };

  const hasPendingUpload = docs.some((d) => {
    const rd = runDocs.find((x) => x.document_id === d.id);
    return !rd || !rd.ragflow_doc_id || rd.parse_status === 'FAIL';
  });
  const isLocked = !!busy || polling;

  return (
    <div className="min-h-[calc(100dvh-48px)] bg-[#fefefe]">
    <div className="max-w-5xl mx-auto px-8 py-7 space-y-5">
      {/* Clean Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[#ededeb]">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold text-[#18181b] tracking-tight">Tài liệu & Parse</h1>
            {activeRun && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium bg-[#f4f4f2] text-[#3f3f46] rounded-[3px]">
                {activeRun.name}
                {activeRun.is_baseline ? ' · Chuẩn' : ''}
              </span>
            )}
          </div>
          {activeRun ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-[#78716c] mt-1">
              <span className="font-mono tabular-nums">
                {activeRun.doc_count ?? 0} file · {activeRun.chunk_count ?? 0} chunk
              </span>
              <span>·</span>
              <button
                type="button"
                onClick={() => {
                  if (activeRun.ragflow_dataset_id) {
                    navigator.clipboard?.writeText(activeRun.ragflow_dataset_id);
                    toast.success('Đã copy RAGFlow Dataset ID.');
                  }
                }}
                title={activeRun.ragflow_dataset_id ? `Copy ID: ${activeRun.ragflow_dataset_id}` : 'Chưa gắn Dataset ID'}
                className="font-mono text-[11px] text-[#71717a] hover:text-[#18181b] transition-colors"
              >
                Dataset:{' '}
                {activeRun.ragflow_dataset_id
                  ? `${activeRun.ragflow_dataset_id.slice(0, 8)}…${activeRun.ragflow_dataset_id.slice(-4)}`
                  : 'Chưa gắn'}
              </button>
            </div>
          ) : (
            <p className="text-xs text-[#78716c] mt-1">Tạo phiên mới để gắn với Dataset trên RAGFlow.</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {activeRun && (
            <button
              disabled={isLocked}
              onClick={() =>
                setConfirmDialog({
                  title: `Xóa phiên "${activeRun.name}"?`,
                  description: 'Toàn bộ dữ liệu chunks và kết quả chấm thuộc phiên này sẽ bị xóa khỏi local.',
                  confirmLabel: 'Xóa phiên',
                  onConfirm: async () => {
                    await api.deleteRun(activeRun.id);
                    await onReloadRuns();
                    await loadAll();
                    toast.success(`Đã xóa phiên "${activeRun.name}".`);
                  },
                })
              }
              title={`Xóa phiên "${activeRun.name}"`}
              className="ts-btn-ghost text-xs text-[#71717a] hover:text-rose-600 hover:bg-rose-50 px-2 disabled:opacity-40 disabled:pointer-events-none"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
          {activeRun && (
            <button
              onClick={openParserConfigModal}
              disabled={isLocked}
              className="ts-btn-secondary text-xs disabled:opacity-45"
              title="Chỉnh cấu hình Parsing / Chunking của phiên này"
            >
              <SlidersHorizontal className="size-3.5" />
              Cấu hình Parse
            </button>
          )}
          <button onClick={openNewRunModal} className="ts-btn-primary text-xs">
            <Plus className="size-3.5" />
            Tạo phiên mới
          </button>
        </div>
      </div>

      {/* Unified Documents Workbench Card */}
      <div className="border border-[#e6e4de] rounded-xl overflow-hidden bg-white shadow-xs">
        {/* Compact KPI Summary Strip */}
        {docs.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 border-b border-[#ededeb] divide-y sm:divide-y-0 sm:divide-x divide-[#ededeb] bg-white">
            <div className="px-4 py-2.5">
              <div className="text-[11px] text-[#71717a]">Tổng tài liệu</div>
              <div className="text-base font-semibold font-mono tabular-nums text-[#18181b] mt-0.5">{docs.length}</div>
            </div>
            <div className="px-4 py-2.5">
              <div className="text-[11px] text-[#71717a]">Đã parse xong</div>
              <div className="text-base font-semibold font-mono tabular-nums text-emerald-700 mt-0.5">
                {runDocs.filter((rd) => rd.parse_status === 'DONE').length}/{docs.length}
              </div>
            </div>
            <div className="px-4 py-2.5">
              <div className="text-[11px] text-[#71717a]">Tổng đoạn cắt (chunks)</div>
              <div className="text-base font-semibold font-mono tabular-nums text-[#18181b] mt-0.5">
                {runDocs.reduce((sum, rd) => sum + (rd.chunk_count || 0), 0)}
              </div>
            </div>
            <div className="px-4 py-2.5">
              <div className="text-[11px] text-[#71717a]">Có cảnh báo</div>
              <div className="text-base font-semibold font-mono tabular-nums text-amber-600 mt-0.5">
                {runDocs.filter((rd) => (rd.anomaly_flags?.length || 0) > 0 || rd.parse_status === 'FAIL').length}
              </div>
            </div>
          </div>
        )}

        {/* Single Crisp Action Toolbar */}
        <div className="px-4 py-3 border-b border-[#e6e6e3] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-semibold text-[#18181b]">
              Danh sách tài liệu
            </span>
            <span className="font-mono text-[11px] px-1.5 py-0.5 bg-[#ededeb] text-[#52525b] rounded-md tabular-nums">
              {docs.length}
            </span>
            {busy === 'sync' && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-[#3f3f46] font-medium">
                <Loader2 className="size-3 animate-spin" /> Đang đồng bộ...
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1.5 bg-white border border-[#e4e4e2] focus-within:border-[#18181b] rounded-md px-2.5 py-1.5 w-48 transition-colors">
              <Search className="size-3.5 text-[#a1a1aa] shrink-0" />
              <input
                className="w-full text-xs text-[#161616] placeholder:text-[#a1a1aa] focus:outline-none bg-transparent"
                placeholder="Tìm file..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <button
              onClick={() => setShowUpload(true)}
              disabled={isLocked}
              className="ts-btn-secondary py-1.5 text-xs disabled:opacity-45 disabled:pointer-events-none"
            >
              <Upload className="size-3.5" />
              Thêm file
            </button>

            {activeRun && (
              <>
                <button
                  onClick={handleUploadAndParse}
                  disabled={isLocked || docs.length === 0 || !hasPendingUpload}
                  className="ts-btn-secondary py-1.5 text-xs disabled:opacity-45 disabled:pointer-events-none"
                  title={
                    polling
                      ? 'Đang parse tài liệu trên RAGFlow...'
                      : !hasPendingUpload && docs.length > 0
                      ? 'Tất cả file đã được đẩy lên RAGFlow'
                      : 'Đẩy các file mới lên RAGFlow và kích hoạt parse'
                  }
                >
                  {busy === 'push' ? (
                    <Loader2 className="size-3.5 animate-spin text-[#03aa5c]" />
                  ) : (
                    <Play className="size-3.5 text-[#03aa5c]" />
                  )}
                  {busy === 'push' ? 'Đang gửi...' : 'Đẩy & Parse'}
                </button>

                <button
                  onClick={handleSync}
                  disabled={!!busy}
                  className="ts-btn-primary py-1.5 text-xs disabled:opacity-45 disabled:pointer-events-none"
                  title="Kéo danh sách tài liệu, chunks và tự tách đoạn đối chiếu từ RAGFlow"
                >
                  {busy === 'sync' ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <CloudDownload className="size-3.5" />
                  )}
                  {busy === 'sync' ? 'Đang đồng bộ...' : 'Đồng bộ RAGFlow'}
                </button>

                <button
                  onClick={handleCheckStatusManual}
                  disabled={!!busy}
                  className="ts-btn-secondary p-1.5 text-[#52525b] disabled:opacity-45 disabled:pointer-events-none"
                  title="Kiểm tra tiến độ parse hiện tại trên RAGFlow"
                  aria-label="Kiểm tra tiến độ"
                >
                  <RefreshCw className={`size-3.5 ${busy === 'status' ? 'animate-spin text-[#03aa5c]' : ''}`} />
                </button>
              </>
            )}

            {docs.length > 0 && (
              <button
                disabled={isLocked}
                onClick={() =>
                  setConfirmDialog({
                    title: 'Xóa toàn bộ tài liệu trong danh sách?',
                    description: 'Tất cả tài liệu hiện tại sẽ bị gỡ khỏi danh sách local (không ảnh hưởng đến file trên RAGFlow).',
                    confirmLabel: 'Xóa tất cả',
                    onConfirm: async () => {
                      await api.clearDocuments(false);
                      await loadAll();
                      toast.success('Đã xóa toàn bộ tài liệu cũ.');
                    },
                  })
                }
                className="ts-btn-ghost p-1.5 text-[#71717a] hover:text-rose-600 hover:bg-rose-50 disabled:opacity-40 disabled:pointer-events-none"
                title="Xóa tất cả tài liệu"
                aria-label="Xóa tất cả"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {docs.length === 0 ? (
          <div className="py-14 px-6 text-center space-y-3">
            <div className="size-10 mx-auto rounded-[4px] bg-[#f4f4f2] border border-[#e6e6e3] flex items-center justify-center text-[#71717a]">
              <Upload className="size-4" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-[#18181b]">Chưa có tài liệu nào trong phiên này</p>
              <p className="text-xs text-[#78716c]">
                Tải lên một hoặc nhiều file gốc từ máy tính, hoặc đồng bộ trực tiếp từ Dataset trên RAGFlow.
              </p>
            </div>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button onClick={() => setShowUpload(true)} className="ts-btn-secondary text-xs">
                <Upload className="size-3.5" />
                Thêm file gốc
              </button>
              {activeRun && (
                <button onClick={handleSync} disabled={!!busy} className="ts-btn-primary text-xs">
                  <CloudDownload className="size-3.5" />
                  Đồng bộ từ RAGFlow
                </button>
              )}
            </div>
          </div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-[#ededeb] text-[11px] font-mono text-[#78716c] bg-white">
                <th className="py-2.5 px-4 font-medium w-16">MÃ</th>
                <th className="py-2.5 px-3 font-medium">TÊN TÀI LIỆU</th>
                <th className="py-2.5 px-3 font-medium w-32">NGÀY TẢI</th>
                <th className="py-2.5 px-3 font-medium w-20 text-right">CHUNKS</th>
                <th className="py-2.5 px-3 font-medium w-44">PARSE</th>
                <th className="py-2.5 px-4 font-medium text-right w-28">ACTION</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0f0ee]">
              {docs
                .filter((d) => {
                  const q = searchQuery.trim().toLowerCase();
                  if (!q) return true;
                  return d.filename.toLowerCase().includes(q) || d.doc_code.toLowerCase().includes(q);
                })
                .map((d) => {
                const rd = runDocs.find((x) => x.document_id === d.id);
                const status = rd?.parse_status || 'UNSTART';
                const uploadDate = d.created_at ? d.created_at.replace('T', ' ').slice(0, 16) : '—';
                return (
                  <tr key={d.id} className="hover:bg-[#fafaf9] group">
                    <td className="py-2.5 px-4 font-mono text-xs text-[#52525b]">{d.doc_code}</td>
                    <td className="py-2.5 px-3 font-medium text-[#18181b] max-w-xs truncate" title={d.filename}>
                      {d.file_path ? (
                        <a
                          href={`/api/workspace/documents/${d.id}/file`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-[#03aa5c] hover:underline transition-colors"
                          title={`Mở tài liệu: ${d.filename}`}
                        >
                          {d.filename}
                        </a>
                      ) : (
                        d.filename
                      )}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-[#71717a] tabular-nums">
                      {uploadDate}
                    </td>
                    <td className="py-2.5 px-3 font-mono tabular-nums text-right text-[#18181b]">
                      {rd?.chunk_count ?? 0}
                    </td>
                    <td className="py-2.5 px-3 text-xs">
                      <div className="flex items-center gap-2">
                        {status === 'DONE' ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                            <CheckCircle2 className="size-3.5" /> Đã parse xong
                          </span>
                        ) : status === 'RUNNING' ? (
                          <div className="space-y-1">
                            <span className="inline-flex items-center gap-1.5 text-amber-700 font-medium">
                              <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
                              Đang parse {Math.round((rd?.progress || 0) * 100)}%
                            </span>
                            <div className="w-24 h-1.5 bg-[#ededeb] overflow-hidden">
                              <div
                                className="h-full bg-amber-500 transition-all duration-300"
                                style={{ width: `${Math.max(8, Math.round((rd?.progress || 0) * 100))}%` }}
                              />
                            </div>
                          </div>
                        ) : status === 'FAIL' ? (
                          <div className="space-y-0.5 max-w-[180px]">
                            <span className="inline-flex items-center gap-1 text-rose-600 font-medium">
                              <AlertCircle className="size-3.5 shrink-0" /> Lỗi parse
                            </span>
                            {parseErrors[d.id] && (
                              <div className="text-[11px] text-rose-500 truncate" title={parseErrors[d.id]}>
                                {parseErrors[d.id]}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-[#a1a1aa]">Chưa parse</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="inline-flex items-center gap-1">
                        {activeRun && (
                          <button
                            disabled={isLocked || status === 'RUNNING'}
                            onClick={async () => {
                              try {
                                await api.parseSingleDocument(activeRun.id, d.id);
                                updatePolling(true);
                                await checkParseStatus(false);
                                toast.info(`Đang parse "${d.filename}" trên RAGFlow...`);
                              } catch (err: any) {
                                toast.error(err.message);
                              }
                            }}
                            title="Chạy / chạy lại Parse cho file này"
                            aria-label="Parse file này"
                            className="p-1 text-[#71717a] hover:text-[#03aa5c] rounded-[3px] transition-colors disabled:opacity-25 disabled:pointer-events-none"
                          >
                            <Play className="size-3.5" />
                          </button>
                        )}
                        {d.file_path && (
                          <>
                            <a
                              href={`/api/workspace/documents/${d.id}/file`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Xem trước file gốc"
                              className="p-1 text-[#71717a] hover:text-[#161616] rounded-[3px] transition-colors"
                            >
                              <Eye className="size-3.5" />
                            </a>
                            <a
                              href={`/api/workspace/documents/${d.id}/file`}
                              download={d.filename}
                              title="Tải xuống file gốc"
                              className="p-1 text-[#71717a] hover:text-[#161616] rounded-[3px] transition-colors"
                            >
                              <Download className="size-3.5" />
                            </a>
                          </>
                        )}
                        <button
                          disabled={isLocked}
                          onClick={() =>
                            setConfirmDialog({
                              title: `Xóa tài liệu ${d.doc_code}?`,
                              description: `Tài liệu "${d.filename}" sẽ bị xóa khỏi danh sách kiểm thử local.`,
                              confirmLabel: 'Xóa tài liệu',
                              onConfirm: async () => {
                                await api.deleteDocument(d.id);
                                await loadAll();
                                toast.success(`Đã xóa tài liệu ${d.doc_code}.`);
                              },
                            })
                          }
                          aria-label="Xóa tài liệu"
                          title="Xóa tài liệu"
                          className="p-1 text-[#a1a1aa] hover:text-rose-600 rounded-[3px] transition-colors disabled:opacity-25 disabled:pointer-events-none"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {activeRun && (activeRun.chunk_count ?? 0) > 0 && (
        <div className="flex justify-end">
          <button onClick={onNextStep} className="ts-btn-primary text-xs">
            Sang Bước 2: Chấm đọc file
            <ArrowRight className="size-3.5" />
          </button>
        </div>
      )}

      {/* Modal: 2-Step Dataset Picker & RAGFlow Create */}
      {showNewRun && (
        <DatasetFlowModal
          onClose={() => setShowNewRun(false)}
          onCreated={(created) => {
            onSelectRun(created);
            onReloadRuns(created.id);
          }}
        />
      )}

      {/* Modal: Full RAGFlow Dataset Configuration */}
      {showParserCfg && activeRun && (
        <RagflowParserConfigModal
          run={activeRun}
          onClose={() => setShowParserCfg(false)}
          onSaved={() => onReloadRuns(activeRun.id)}
        />
      )}

      {/* Modal: Upload Document (Single & Batch) */}
      {showUpload && (
        <div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4">
          <form onSubmit={handleUploadDoc} className="bg-white border border-[#e4e4e2] rounded-[6px] w-full max-w-lg p-6 space-y-4 shadow-lg">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-[#18181b]">Thêm tài liệu gốc</h2>
                <p className="text-[11px] text-[#78716c] mt-0.5">Hỗ trợ chọn hoặc kéo thả nhiều file cùng lúc (PDF, DOCX, HTML, MD, PPTX...)</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowUpload(false);
                  setUpFiles([]);
                }}
                aria-label="Đóng"
              >
                <X className="size-4 text-[#71717a]" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Drag & Drop + Multi-file Picker */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  addPickedFiles(e.dataTransfer.files);
                }}
                className={`border border-dashed rounded-[4px] p-4 text-center transition-colors ${
                  dragOver ? 'border-[#18181b] bg-[#f4f4f2]' : 'border-[#d4d4d0] bg-[#fafaf9]'
                }`}
              >
                <Upload className="size-5 mx-auto text-[#71717a] mb-1.5" />
                <div className="text-xs text-[#3f3f46]">
                  Kéo thả nhiều file vào đây hoặc{' '}
                  <label className="text-[#18181b] font-semibold underline cursor-pointer">
                    chọn từ máy tính
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        addPickedFiles(e.target.files);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              </div>

              {/* Selected files list */}
              {upFiles.length > 0 && (
                <div className="border border-[#e6e6e3] rounded-[4px] divide-y divide-[#f0f0ee] max-h-40 overflow-y-auto">
                  {upFiles.map((f, idx) => (
                    <div key={`${f.name}_${idx}`} className="px-3 py-1.5 flex items-center justify-between gap-2 text-xs bg-white">
                      <span className="truncate font-medium text-[#18181b]" title={f.name}>
                        {f.name}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono text-[11px] text-[#78716c]">
                          {f.size >= 1024 * 1024
                            ? `${(f.size / (1024 * 1024)).toFixed(1)} MB`
                            : `${Math.max(1, Math.round(f.size / 1024))} KB`}
                        </span>
                        <button
                          type="button"
                          onClick={() => setUpFiles((prev) => prev.filter((_, i) => i !== idx))}
                          className="text-[#a1a1aa] hover:text-rose-600"
                          aria-label="Gỡ file"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                {upFiles.length <= 1 ? (
                  <div>
                    <label className="block text-xs font-medium text-[#3f3f46] mb-1">Mã tài liệu</label>
                    <input className="ts-input w-full font-mono" value={upCode} onChange={(e) => setUpCode(e.target.value)} required />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-[#3f3f46] mb-1">Mã tài liệu</label>
                    <div className="ts-input w-full font-mono text-xs text-[#78716c] bg-[#fafaf9]">
                      Tự động đánh số ({upFiles.length} file)
                    </div>
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-[#3f3f46] mb-1">Nhóm định dạng</label>
                  <select className="ts-input w-full" value={upGroup} onChange={(e) => setUpGroup(e.target.value)}>
                    <option value="AUTO">Tự nhận diện theo đuôi file</option>
                    {FORMAT_GROUPS.map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                </div>
              </div>

              {upFiles.length <= 1 && (
                <div>
                  <label className="block text-xs font-medium text-[#3f3f46] mb-1">Link nguồn (không bắt buộc)</label>
                  <input className="ts-input w-full" placeholder="https://..." value={upUrl} onChange={(e) => setUpUrl(e.target.value)} />
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-[#ededeb]">
              <button
                type="button"
                onClick={() => {
                  setShowUpload(false);
                  setUpFiles([]);
                }}
                className="ts-btn-secondary"
              >
                Hủy
              </button>
              <button type="submit" disabled={upFiles.length === 0 || !!busy} className="ts-btn-primary">
                {busy === 'upload'
                  ? 'Đang tải lên...'
                  : upFiles.length > 1
                  ? `Tải lên ${upFiles.length} file`
                  : 'Lưu tài liệu'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Custom Confirm Dialog (replaces native browser confirm) */}
      {confirmDialog && (
        <div
          className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[1px] flex items-center justify-center p-4"
          onClick={() => setConfirmDialog(null)}
        >
          <div
            className="bg-white border border-[#e4e4e2] rounded-[4px] w-full max-w-sm p-5 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-[#18181b]">{confirmDialog.title}</h3>
                <p className="text-xs text-[#52525b] leading-relaxed">{confirmDialog.description}</p>
              </div>
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                aria-label="Đóng"
                className="p-1 text-[#71717a] hover:text-[#18181b]"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#ededeb]">
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                className="ts-btn-secondary py-1.5 text-xs"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={async () => {
                  const fn = confirmDialog.onConfirm;
                  setConfirmDialog(null);
                  try {
                    await fn();
                  } catch (err: any) {
                    toast.error(err.message);
                  }
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[4px] text-xs font-medium bg-rose-600 hover:bg-rose-700 text-white"
              >
                {confirmDialog.confirmLabel || 'Xác nhận xóa'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
};
