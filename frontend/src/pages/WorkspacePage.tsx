import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  CloudDownload,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { DocumentItem, RunDocumentItem, RunItem } from '../types';

interface Props {
  activeRun: RunItem | null;
  runs: RunItem[];
  refreshKey?: number;
  onReloadRuns: () => void;
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
  const [notice, setNotice] = useState<{ ok?: boolean; text: string } | null>(null);
  const [polling, setPolling] = useState(false);
  const [parseErrors, setParseErrors] = useState<Record<number, string>>({});
  const pollBusyRef = useRef(false);

  const [showNewRun, setShowNewRun] = useState(false);
  const [showUpload, setShowUpload] = useState(false);

  const [runName, setRunName] = useState('');
  const [runDatasetId, setRunDatasetId] = useState('');
  const [runIsBase, setRunIsBase] = useState(true);
  const [runCreateRemote, setRunCreateRemote] = useState(false);

  const [upCode, setUpCode] = useState('DOC01');
  const [upGroup, setUpGroup] = useState(FORMAT_GROUPS[0]);
  const [upUrl, setUpUrl] = useState('');
  const [upFile, setUpFile] = useState<File | null>(null);

  const loadAll = async () => {
    const dRes = await api.listDocuments(activeRun?.id);
    setDocs(dRes);
    setUpCode(`DOC${String(dRes.length + 1).padStart(2, '0')}`);
    if (activeRun) {
      const rd = await api.getRunDocuments(activeRun.id);
      setRunDocs(rd);
      if (rd.some((item: RunDocumentItem) => item.parse_status === 'RUNNING')) {
        setPolling(true);
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

  const checkParseStatus = async (autoSyncWhenDone: boolean) => {
    if (!activeRun || pollBusyRef.current) return;
    pollBusyRef.current = true;
    try {
      const res = await api.getRunParseStatus(activeRun.id);
      setRunDocs(res.documents || []);
      setParseErrors(res.errors || {});
      const dRes = await api.listDocuments(activeRun.id);
      setDocs(dRes);

      if (res.is_parsing) {
        setPolling(true);
      } else {
        setPolling(false);
        if (autoSyncWhenDone) {
          const doneCount = res.counts?.done ?? 0;
          const failCount = res.counts?.failed ?? 0;
          if (doneCount > 0) {
            setBusy('sync');
            try {
              const syncRes = await api.syncRunFromRagflow(activeRun.id);
              await loadAll();
              onReloadRuns();
              const failSuffix = failCount > 0 ? ` (${failCount} file lỗi)` : '';
              setNotice({
                ok: failCount === 0,
                text: `Parse hoàn tất! Đã tự động đồng bộ ${syncRes.synced_documents} tài liệu và ${syncRes.synced_chunks} đoạn cắt${failSuffix}.`,
              });
            } finally {
              setBusy('');
            }
          } else if (failCount > 0) {
            setNotice({
              ok: false,
              text: `Parse thất bại (${failCount} file lỗi). Xem chi tiết lỗi ở cột Trạng thái.`,
            });
          }
        }
      }
    } catch (err: any) {
      setPolling(false);
      setNotice({ ok: false, text: err.message });
    } finally {
      pollBusyRef.current = false;
    }
  };

  useEffect(() => {
    if (!polling || !activeRun) return;
    const timer = window.setInterval(() => {
      checkParseStatus(true);
    }, 3000);
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
      });
      setShowNewRun(false);
      setRunName('');
      onReloadRuns();
      onSelectRun(created);
      setNotice({ ok: true, text: `Đã tạo phiên "${created.name}".` });
    } catch (err: any) {
      setNotice({ ok: false, text: err.message });
    } finally {
      setBusy('');
    }
  };

  const handleUploadDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!upFile) return;
    setBusy('upload');
    try {
      const fd = new FormData();
      fd.append('file', upFile);
      fd.append('doc_code', upCode);
      fd.append('format_group', upGroup);
      fd.append('source_url', upUrl);
      await api.uploadDocument(fd);
      setUpFile(null);
      setShowUpload(false);
      await loadAll();
      setNotice({ ok: true, text: 'Đã thêm tài liệu gốc vào kho.' });
    } catch (err: any) {
      setNotice({ ok: false, text: err.message });
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
      setNotice({
        ok: true,
        text: `Đã đồng bộ ${res.synced_documents} tài liệu và ${res.synced_chunks} đoạn cắt từ RAGFlow.`,
      });
    } catch (err: any) {
      setNotice({ ok: false, text: err.message });
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
        setNotice({
          ok: true,
          text: `Đã đẩy ${res.uploaded_and_triggered} tài liệu lên RAGFlow. Đang tự động theo dõi tiến độ parse (mỗi 3 giây)...`,
        });
      } else {
        setNotice({
          ok: false,
          text: 'Chưa có file gốc nào trong kho để đẩy lên RAGFlow. Hãy bấm "Thêm file gốc" trước.',
        });
      }
    } catch (err: any) {
      setNotice({ ok: false, text: err.message });
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

  return (
    <div className="max-w-5xl mx-auto px-8 py-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="ts-eyebrow">BƯỚC 1 · INGESTION & SYNC</div>
          <h1 className="text-2xl font-semibold text-[#18181b] mt-1">Tài liệu & Đồng bộ RAGFlow</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onOpenSettings} className="ts-btn-secondary">
            <Settings className="size-3.5" />
            Cài đặt API
          </button>
          <button onClick={openNewRunModal} className="ts-btn-primary">
            <Plus className="size-3.5" />
            Tạo phiên mới
          </button>
        </div>
      </div>

      {notice && (
        <div
          className={`text-[13px] px-4 py-2.5 rounded-[4px] border flex items-center justify-between ${
            notice.ok
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="Đóng">
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* Active Run Sync Strip */}
      {activeRun && (
        <div className="bg-[#fafaf9] border border-[#e6e6e3] rounded-[4px] px-5 py-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-xs text-[#78716c]">Phiên đang hoạt động</div>
            <div className="text-sm font-semibold text-[#18181b] mt-0.5 flex flex-wrap items-center gap-2">
              <span>{activeRun.name}</span>
              <span className="ts-tag-neutral">
                ID: {activeRun.ragflow_dataset_id || 'Chưa gắn'}
              </span>
              <span className="ts-tag-neutral">
                {activeRun.doc_count ?? 0} file · {activeRun.chunk_count ?? 0} đoạn
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={async () => {
                if (!confirm(`Xóa phiên "${activeRun.name}"?`)) return;
                await api.deleteRun(activeRun.id);
                await onReloadRuns();
                await loadAll();
              }}
              className="ts-btn-ghost text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50"
            >
              <Trash2 className="size-3.5" />
              Xóa phiên
            </button>
            <button onClick={handleUploadAndParse} disabled={!!busy} className="ts-btn-secondary">
              <Play className="size-3.5 text-emerald-600" />
              {busy === 'push' ? 'Đang gửi...' : 'Đẩy file lên & Parse'}
            </button>
            <button
              onClick={handleCheckStatusManual}
              disabled={!!busy}
              className="ts-btn-secondary"
              title="Kiểm tra tiến độ parse hiện tại trên RAGFlow"
            >
              <RefreshCw className={`size-3.5 ${polling || busy === 'status' ? 'animate-spin text-amber-600' : ''}`} />
              {polling ? 'Đang theo dõi...' : 'Kiểm tra tiến độ'}
            </button>
            <button onClick={handleSync} disabled={!!busy} className="ts-btn-primary">
              <CloudDownload className="size-3.5" />
              {busy === 'sync' ? 'Đang kéo...' : 'Kéo dữ liệu từ RAGFlow'}
            </button>
          </div>
        </div>
      )}

      {/* Documents Table */}
      <div className="border border-[#e6e6e3] rounded-[4px] overflow-hidden bg-white">
        <div className="px-4 py-3 border-b border-[#e6e6e3] bg-[#fafaf9] flex items-center justify-between">
          <div className="ts-eyebrow">DANH SÁCH TÀI LIỆU ({docs.length})</div>
          <div className="flex items-center gap-2">
            {docs.length > 0 && (
              <button
                onClick={async () => {
                  if (!confirm('Xóa toàn bộ tài liệu trong danh sách?')) return;
                  await api.clearDocuments(false);
                  await loadAll();
                  setNotice({ ok: true, text: 'Đã xóa toàn bộ tài liệu cũ.' });
                }}
                className="ts-btn-ghost py-1 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50"
              >
                <Trash2 className="size-3.5" />
                Xóa tất cả
              </button>
            )}
            <button onClick={() => setShowUpload(true)} className="ts-btn-secondary py-1 text-xs">
              <Upload className="size-3.5" />
              Thêm file gốc
            </button>
          </div>
        </div>

        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-[#ededeb] text-[11px] font-mono text-[#78716c] bg-white">
              <th className="py-2.5 px-4 font-medium">MÃ</th>
              <th className="py-2.5 px-3 font-medium">TÊN TÀI LIỆU</th>
              <th className="py-2.5 px-3 font-medium">NHÓM ĐỊNH DẠNG</th>
              <th className="py-2.5 px-3 font-medium">TRẠNG THÁI</th>
              <th className="py-2.5 px-3 font-medium text-right">SỐ ĐOẠN</th>
              <th className="py-2.5 px-4 font-medium text-right">XÓA</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#f0f0ee]">
            {docs.map((d) => {
              const rd = runDocs.find((x) => x.document_id === d.id);
              const status = rd?.parse_status || 'UNSTART';
              return (
                <tr key={d.id} className="hover:bg-[#fafaf9]">
                  <td className="py-2.5 px-4 font-mono text-xs text-[#52525b]">{d.doc_code}</td>
                  <td className="py-2.5 px-3 font-medium text-[#18181b] max-w-xs truncate" title={d.filename}>
                    {d.filename}
                  </td>
                  <td className="py-2.5 px-3">
                    <span className="ts-tag-neutral font-sans">{d.format_group}</span>
                  </td>
                  <td className="py-2.5 px-3 text-xs">
                    {status === 'DONE' ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                        <CheckCircle2 className="size-3.5" /> Đã đọc xong
                      </span>
                    ) : status === 'RUNNING' ? (
                      <div className="space-y-1">
                        <span className="inline-flex items-center gap-1.5 text-amber-700 font-medium">
                          <Loader2 className="size-3.5 animate-spin" />
                          Đang parse {Math.round((rd?.progress || 0) * 100)}%
                        </span>
                        <div className="w-28 h-1.5 bg-[#ededeb] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-amber-500 transition-all duration-300"
                            style={{ width: `${Math.max(8, Math.round((rd?.progress || 0) * 100))}%` }}
                          />
                        </div>
                      </div>
                    ) : status === 'FAIL' ? (
                      <div className="space-y-0.5 max-w-[240px]">
                        <span className="inline-flex items-center gap-1 text-rose-600 font-medium">
                          <AlertCircle className="size-3.5 shrink-0" /> Lỗi đọc file
                        </span>
                        {parseErrors[d.id] && (
                          <div
                            className="text-[11px] text-rose-500 truncate"
                            title={parseErrors[d.id]}
                          >
                            {parseErrors[d.id]}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-[#a1a1aa]">Chưa đồng bộ</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 font-mono tabular-nums text-right text-[#18181b]">
                    {rd?.chunk_count ?? 0}
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    <button
                      onClick={async () => {
                        if (!confirm(`Xóa tài liệu ${d.doc_code}?`)) return;
                        await api.deleteDocument(d.id);
                        loadAll();
                      }}
                      aria-label="Xóa tài liệu"
                      className="p-1 text-[#a1a1aa] hover:text-rose-600 rounded-[3px]"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {docs.length === 0 && (
              <tr>
                <td colSpan={6} className="py-10 text-center text-[13px] text-[#71717a]">
                  Chưa có tài liệu nào. Bấm <strong>Thêm file gốc</strong> hoặc <strong>Kéo dữ liệu từ RAGFlow</strong>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {activeRun && (activeRun.chunk_count ?? 0) > 0 && (
        <div className="flex justify-end">
          <button onClick={onNextStep} className="ts-btn-primary">
            Sang Bước 2: Chấm đọc file
            <ArrowRight className="size-3.5" />
          </button>
        </div>
      )}

      {/* Modal: New Run */}
      {showNewRun && (
        <div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4">
          <form onSubmit={handleCreateRun} className="bg-white border border-[#e4e4e2] rounded-[6px] w-full max-w-md p-6 space-y-4 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#18181b]">Tạo phiên kiểm thử mới</h2>
              <button type="button" onClick={() => setShowNewRun(false)} aria-label="Đóng">
                <X className="size-4 text-[#71717a]" />
              </button>
            </div>

            {remoteDatasets.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs text-[#71717a]">Dataset có sẵn trên RAGFlow (bấm để chọn):</div>
                <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                  {remoteDatasets.map((ds: any) => (
                    <button
                      type="button"
                      key={ds.id}
                      onClick={() => {
                        setRunDatasetId(ds.id);
                        setRunName(ds.name);
                        setRunCreateRemote(false);
                      }}
                      className="ts-tag-neutral hover:bg-[#eaeae7] cursor-pointer"
                    >
                      {ds.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[#3f3f46] mb-1">Tên phiên</label>
                <input
                  className="ts-input w-full"
                  placeholder="VD: Baseline_512"
                  value={runName}
                  onChange={(e) => setRunName(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#3f3f46] mb-1">RAGFlow Dataset ID</label>
                <input
                  className="ts-input w-full font-mono text-xs"
                  placeholder="Dán ID từ RAGFlow"
                  value={runDatasetId}
                  onChange={(e) => setRunDatasetId(e.target.value)}
                  disabled={runCreateRemote}
                />
              </div>
              <div className="flex items-center gap-4 text-xs text-[#3f3f46]">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={runIsBase} onChange={(e) => setRunIsBase(e.target.checked)} />
                  Đặt làm bản chuẩn
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={runCreateRemote} onChange={(e) => setRunCreateRemote(e.target.checked)} />
                  Tạo Dataset mới trên RAGFlow
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-[#ededeb]">
              <button type="button" onClick={() => setShowNewRun(false)} className="ts-btn-secondary">Hủy</button>
              <button type="submit" disabled={!!busy} className="ts-btn-primary">Tạo phiên</button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: Upload Document */}
      {showUpload && (
        <div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4">
          <form onSubmit={handleUploadDoc} className="bg-white border border-[#e4e4e2] rounded-[6px] w-full max-w-md p-6 space-y-4 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#18181b]">Thêm tài liệu gốc</h2>
              <button type="button" onClick={() => setShowUpload(false)} aria-label="Đóng">
                <X className="size-4 text-[#71717a]" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#3f3f46] mb-1">Mã tài liệu</label>
                  <input className="ts-input w-full font-mono" value={upCode} onChange={(e) => setUpCode(e.target.value)} required />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#3f3f46] mb-1">Nhóm định dạng</label>
                  <select className="ts-input w-full" value={upGroup} onChange={(e) => setUpGroup(e.target.value)}>
                    {FORMAT_GROUPS.map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#3f3f46] mb-1">Link nguồn (không bắt buộc)</label>
                <input className="ts-input w-full" placeholder="https://..." value={upUrl} onChange={(e) => setUpUrl(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#3f3f46] mb-1">Chọn file gốc</label>
                <input type="file" className="ts-input w-full text-xs" onChange={(e) => setUpFile(e.target.files?.[0] || null)} required />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-[#ededeb]">
              <button type="button" onClick={() => setShowUpload(false)} className="ts-btn-secondary">Hủy</button>
              <button type="submit" disabled={!upFile || !!busy} className="ts-btn-primary">Lưu tài liệu</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
