import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';

interface Props {
  runId: number;
  runName: string;
  onClose: () => void;
  onImported: () => Promise<void>;
}

const FIELD_META: { key: string; label: string; required?: boolean }[] = [
  { key: 'input_question', label: 'Câu hỏi kiểm thử *', required: true },
  { key: 'expected_outcome', label: 'Đáp án kỳ vọng' },
  { key: 'reference_context', label: 'Căn cứ gốc (Context)' },
  { key: 'source_file', label: 'Tài liệu nguồn' },
  { key: 'tc_code', label: 'Mã TC (tự sinh nếu trống)' },
  { key: 'question_class', label: 'Phân loại (Local/Global...)' },
  { key: 'intent_type', label: 'Nhóm ý định' },
  { key: 'notes', label: 'Ghi chú' },
];

export const ImportGoldenModal: React.FC<Props> = ({
  runId,
  runName,
  onClose,
  onImported,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [sheetName, setSheetName] = useState('');
  const [headerRowIdx, setHeaderRowIdx] = useState<number>(-1);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [aiMapping, setAiMapping] = useState(false);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runPreview = async (
    targetFile: File,
    opts?: { sheet?: string; hIdx?: number; customMapping?: Record<string, number | null> | null; useAi?: boolean }
  ) => {
    const fd = new FormData();
    fd.append('file', targetFile);
    if (opts?.sheet) fd.append('sheet_name', opts.sheet);
    if (opts?.hIdx !== undefined && opts.hIdx >= 0) fd.append('header_row_idx', String(opts.hIdx));
    if (opts?.customMapping) fd.append('mapping_json', JSON.stringify(opts.customMapping));
    if (opts?.useAi) fd.append('use_ai', 'true');

    if (opts?.useAi) setAiMapping(true);
    else setLoadingPreview(true);
    try {
      const res = await api.previewImportGolden(fd);
      setPreview(res);
      setSheetName(res.active_sheet || '');
      setHeaderRowIdx(res.header_row_idx ?? 0);
      setMapping(res.mapping || {});
      if (res.ai_note) toast.warning(res.ai_note);
      else if (opts?.useAi && res.used_ai) toast.success('AI đã tự động ghép cột từ 5 dòng mẫu!');
    } catch (e: any) {
      toast.error(e.message || 'Không đọc được file Excel/CSV');
    } finally {
      setLoadingPreview(false);
      setAiMapping(false);
    }
  };

  const handleFilePick = (picked: File | null) => {
    if (!picked) return;
    setFile(picked);
    setPreview(null);
    runPreview(picked);
  };

  const handleMappingChange = (field: string, rawVal: string) => {
    if (!file) return;
    const nextMap = { ...mapping, [field]: rawVal === '' ? null : Number(rawVal) };
    setMapping(nextMap);
    runPreview(file, { sheet: sheetName, hIdx: headerRowIdx, customMapping: nextMap });
  };

  const handleCommit = async () => {
    if (!file || !preview || preview.valid_count === 0) return;
    setCommitting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('run_id', String(runId));
      fd.append('mode', mode);
      if (sheetName) fd.append('sheet_name', sheetName);
      if (headerRowIdx >= 0) fd.append('header_row_idx', String(headerRowIdx));
      fd.append('mapping_json', JSON.stringify(mapping));
      const res = await api.commitImportGolden(fd);
      toast.success(
        `Đã nhập ${res.imported_count} câu hỏi Golden vào "${runName}"${
          res.skipped_count ? ` (bỏ qua ${res.skipped_count} dòng lỗi)` : ''
        }.`
      );
      await onImported();
      onClose();
    } catch (e: any) {
      toast.error(e.message || 'Nhập Golden Dataset thất bại');
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-3 sm:p-5"
      onClick={onClose}
    >
      <div
        className="w-[93vw] max-w-[1160px] h-[88vh] bg-[#f7f7f5] border border-[#d8d8d4] rounded-[8px] shadow-xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 bg-white border-b border-[#e4e4e0] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileSpreadsheet className="size-4 text-[#03aa5c] shrink-0" />
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-[#161616] truncate">
                Nhập Golden Dataset từ Excel / CSV · {runName}
              </h2>
              <p className="text-[11px] text-[#71717a]">
                Hỗ trợ mọi format bảng cột bất kỳ — tự nhận diện cột, dùng AI ghép cột hoặc chỉnh tay trước khi lưu.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={api.goldenTemplateXlsxUrl()}
              download="golden_dataset_template.xlsx"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-[#dedede] rounded-[4px] bg-white hover:border-[#161616] text-[#161616]"
            >
              <Download className="size-3.5 text-[#027a42]" /> Tải file mẫu (.xlsx)
            </a>
            <button onClick={onClose} className="p-1.5 rounded hover:bg-[#ededeb] text-[#71717a]">
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Upload Dropzone */}
          {!preview ? (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) handleFilePick(f);
              }}
              onClick={() => fileInputRef.current?.click()}
              className="cursor-pointer rounded-[8px] border-2 border-dashed border-[#cbd5e1] hover:border-[#03aa5c] bg-white p-12 flex flex-col items-center justify-center text-center gap-3 transition-colors"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xlsm,.csv"
                className="hidden"
                onChange={(e) => handleFilePick(e.target.files?.[0] || null)}
              />
              {loadingPreview ? (
                <>
                  <Loader2 className="size-7 animate-spin text-[#03aa5c]" />
                  <div className="text-sm font-medium text-[#161616]">Đang đọc và phân tích cấu trúc bảng...</div>
                </>
              ) : (
                <>
                  <div className="size-12 rounded-lg bg-[#ecfdf5] text-[#027a42] flex items-center justify-center">
                    <Upload className="size-5" />
                  </div>
                  <div>
                    <div className="text-[14px] font-semibold text-[#161616]">
                      Kéo thả file Excel (.xlsx) hoặc CSV vào đây, hoặc bấm để chọn
                    </div>
                    <div className="text-[12px] text-[#71717a] mt-1">
                      Không cần đúng tên cột mẫu — hệ thống tự tìm dòng tiêu đề và ghép cột tự động.
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              {/* File Info + Sheet + Header Row + AI Map */}
              <div className="p-3.5 rounded-[6px] border border-[#e4e4e0] bg-white flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="font-mono font-semibold text-[#161616]">{preview.filename}</span>
                  {preview.sheet_names?.length > 1 && (
                    <label className="inline-flex items-center gap-1.5 text-[#52525b]">
                      <span>Sheet:</span>
                      <select
                        value={sheetName}
                        onChange={(e) => {
                          setSheetName(e.target.value);
                          if (file) runPreview(file, { sheet: e.target.value });
                        }}
                        className="h-7 px-2 border border-[#dedede] rounded bg-white text-xs"
                      >
                        {preview.sheet_names.map((sn: string) => (
                          <option key={sn} value={sn}>
                            {sn}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="inline-flex items-center gap-1.5 text-[#52525b]">
                    <span>Dòng tiêu đề:</span>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={headerRowIdx + 1}
                      onChange={(e) => {
                        const idx = Math.max(0, Number(e.target.value) - 1);
                        setHeaderRowIdx(idx);
                        if (file) runPreview(file, { sheet: sheetName, hIdx: idx });
                      }}
                      className="w-14 h-7 px-2 font-mono border border-[#dedede] rounded bg-white text-xs"
                    />
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={aiMapping || !file}
                    onClick={() => file && runPreview(file, { sheet: sheetName, hIdx: headerRowIdx, useAi: true })}
                    className="inline-flex items-center gap-1.5 px-2.5 h-7 text-xs font-medium rounded border border-[#03aa5c]/40 bg-[#ecfdf5] text-[#027a42] hover:bg-[#03aa5c] hover:text-white transition-colors disabled:opacity-50"
                  >
                    {aiMapping ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    AI tự ghép cột (5 dòng mẫu)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFile(null);
                      setPreview(null);
                    }}
                    className="px-2.5 h-7 text-xs border border-[#dedede] rounded bg-white text-[#52525b] hover:text-[#161616]"
                  >
                    Đổi file khác
                  </button>
                </div>
              </div>

              {/* Interactive Column Mapper */}
              <div className="p-4 rounded-[6px] border border-[#e4e4e0] bg-white space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-[#52525b]">
                    ÁNH XẠ CỘT (CHỈNH TAY NẾU CẦN)
                  </span>
                  <span className="font-mono text-[10.5px] text-[#027a42]">
                    {preview.used_ai ? 'Đã ghép bằng AI' : `Nhận diện tự động (${Math.round((preview.confidence || 0) * 100)}%)`}
                  </span>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
                  {FIELD_META.map((f) => {
                    const val = mapping[f.key];
                    const missingReq = f.required && (val === null || val === undefined);
                    return (
                      <div
                        key={f.key}
                        className={`p-2 rounded-[4px] border space-y-1 ${
                          missingReq ? 'border-rose-300 bg-rose-50/60' : 'border-[#ececea] bg-[#fafaf9]'
                        }`}
                      >
                        <label className="block text-[11px] font-medium text-[#161616] truncate">{f.label}</label>
                        <select
                          value={val === null || val === undefined ? '' : String(val)}
                          onChange={(e) => handleMappingChange(f.key, e.target.value)}
                          className="w-full h-7 px-1.5 text-[11.5px] border border-[#dcdcd8] rounded bg-white"
                        >
                          <option value="">— Không ghép —</option>
                          {(preview.columns || []).map((c: any) => (
                            <option key={c.index} value={String(c.index)}>
                              [{c.index + 1}] {c.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Stats Strip + Preview Table */}
              <div className="rounded-[6px] border border-[#e4e4e0] bg-white overflow-hidden">
                <div className="px-4 py-2.5 bg-[#fafaf9] border-b border-[#ececea] flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-3 font-mono">
                    <span className="inline-flex items-center gap-1 text-[#027a42] font-semibold">
                      <CheckCircle2 className="size-3.5" /> {preview.valid_count} hợp lệ
                    </span>
                    {preview.warning_count > 0 && (
                      <span className="inline-flex items-center gap-1 text-[#b45309]">
                        <AlertTriangle className="size-3.5" /> {preview.warning_count} cảnh báo nhẹ
                      </span>
                    )}
                    {preview.error_count > 0 && (
                      <span className="text-rose-600">{preview.error_count} dòng lỗi (bỏ qua)</span>
                    )}
                  </div>
                  <div className="inline-flex rounded border border-[#dedede] overflow-hidden text-[11px]">
                    <button
                      type="button"
                      onClick={() => setMode('append')}
                      className={`px-2.5 py-1 font-medium ${
                        mode === 'append' ? 'bg-[#161616] text-white' : 'bg-white text-[#52525b]'
                      }`}
                    >
                      Thêm nối tiếp
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode('replace')}
                      className={`px-2.5 py-1 font-medium border-l border-[#dedede] ${
                        mode === 'replace' ? 'bg-rose-600 text-white' : 'bg-white text-[#52525b]'
                      }`}
                    >
                      Thay thế bộ hiện tại
                    </button>
                  </div>
                </div>

                <div className="max-h-[260px] overflow-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead className="sticky top-0 bg-[#f4f4f2] text-[10.5px] font-mono text-[#52525b] border-b border-[#e4e4e0]">
                      <tr>
                        <th className="py-2 px-3 w-16">Mã</th>
                        <th className="py-2 px-3 w-20">Loại</th>
                        <th className="py-2 px-3">Câu hỏi kiểm thử</th>
                        <th className="py-2 px-3">Đáp án / Căn cứ</th>
                        <th className="py-2 px-3 w-36">Nguồn</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#f1f1ef]">
                      {(preview.preview_items || []).map((it: any, idx: number) => (
                        <tr key={idx} className="hover:bg-[#fafaf9]">
                          <td className="py-2 px-3 font-mono text-[11px] text-[#52525b]">
                            {it.tc_code || `TC${String(idx + 1).padStart(2, '0')}`}
                          </td>
                          <td className="py-2 px-3 font-mono text-[11px] text-[#027a42]">{it.question_class}</td>
                          <td className="py-2 px-3 text-[#161616] max-w-[300px] truncate" title={it.input_question}>
                            {it.input_question}
                          </td>
                          <td
                            className="py-2 px-3 text-[#52525b] max-w-[300px] truncate"
                            title={it.reference_context || it.expected_outcome}
                          >
                            {it.warning && (
                              <span className="inline-block mr-1.5 text-[10px] px-1 rounded bg-amber-50 text-amber-800 border border-amber-200">
                                !
                              </span>
                            )}
                            {it.expected_outcome || it.reference_context}
                          </td>
                          <td className="py-2 px-3 font-mono text-[10.5px] text-[#71717a] truncate max-w-[140px]">
                            {it.source_file || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-white border-t border-[#e4e4e0] flex items-center justify-between gap-3 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-[#52525b] border border-[#dedede] rounded-[4px] bg-white"
          >
            Hủy
          </button>
          <button
            onClick={handleCommit}
            disabled={!preview || preview.valid_count === 0 || committing}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-[#03aa5c] hover:bg-[#028a4b] rounded-[4px] disabled:opacity-50"
          >
            {committing ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            Xác nhận nhập {preview?.valid_count || 0} câu vào Dataset
          </button>
        </div>
      </div>
    </div>
  );
};
