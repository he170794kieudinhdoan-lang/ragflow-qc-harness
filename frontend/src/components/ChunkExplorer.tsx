import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileImage,
  FileText,
  Loader2,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { ChunkContentView } from './ChunkContentView';

interface ChunkExplorerItem {
  id: number;
  document_id: number;
  doc_code: string;
  filename: string;
  format_group: string;
  has_local_file: boolean;
  ragflow_chunk_id: string;
  chunk_index: number;
  content: string;
  char_count: number;
  token_est: number;
  page_num: number;
  important_keywords: string[];
  rule_flags: string[];
  is_sampled: boolean;
  prev_tail: string;
  next_head: string;
}

interface DocOption {
  id: number;
  doc_code: string;
  filename: string;
  format_group: string;
  chunk_count: number;
}

interface ExplorerResponse {
  total: number;
  total_all: number;
  limit: number;
  offset: number;
  stats: {
    avg_tokens: number;
    min_tokens: number;
    max_tokens: number;
    flagged_count: number;
  };
  documents: DocOption[];
  flag_counts: Record<string, number>;
  items: ChunkExplorerItem[];
}

interface Props {
  runId: number;
  flagLabels: Record<string, string>;
}

const PAGE_SIZE = 50;

function highlightText(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(re);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? (
      <mark key={i} className="bg-[#fef08a] text-[#18181b] px-0.5 rounded-[2px]">
        {part}
      </mark>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    )
  );
}

export const ChunkExplorer: React.FC<Props> = ({ runId, flagLabels }) => {
  const [queryInput, setQueryInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [docId, setDocId] = useState<string>('');
  const [flagFilter, setFlagFilter] = useState<string>('');
  const [minTokens, setMinTokens] = useState<string>('');
  const [maxTokens, setMaxTokens] = useState<string>('');
  const [sort, setSort] = useState<string>('doc_chunk');
  const [page, setPage] = useState(0);

  const [data, setData] = useState<ExplorerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ChunkExplorerItem | null>(null);
  const [showPdfPreview, setShowPdfPreview] = useState(false);

  const reqSeq = useRef(0);

  // Reset per-run filters when switching Dataset/Run so Run A's docId doesn't yield 0 results in Run B
  useEffect(() => {
    setDocId('');
    setFlagFilter('');
    setPage(0);
    setShowPdfPreview(false);
    setSelected(null);
  }, [runId]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQuery(queryInput);
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [queryInput]);

  useEffect(() => {
    let active = true;
    const seq = ++reqSeq.current;
    setLoading(true);
    api
      .listAllChunks(runId, {
        q: debouncedQuery || undefined,
        document_id: docId ? Number(docId) : undefined,
        flag: flagFilter || undefined,
        min_tokens: minTokens !== '' ? Number(minTokens) : undefined,
        max_tokens: maxTokens !== '' ? Number(maxTokens) : undefined,
        sort,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      })
      .then((res: ExplorerResponse) => {
        if (!active || seq !== reqSeq.current) return;
        setData(res);
        setSelected((prev) => {
          if (prev && res.items.some((i) => i.id === prev.id)) {
            return res.items.find((i) => i.id === prev.id) || null;
          }
          return res.items[0] || null;
        });
      })
      .catch((e: any) => {
        if (active) toast.error(e.message || 'Không tải được danh sách chunk');
      })
      .finally(() => {
        if (active && seq === reqSeq.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [runId, debouncedQuery, docId, flagFilter, minTokens, maxTokens, sort, page]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const items = data?.items || [];
  const selectedIdx = selected ? items.findIndex((i) => i.id === selected.id) : -1;

  const hasActiveFilters = Boolean(queryInput || docId || flagFilter || minTokens || maxTokens);

  const resetFilters = () => {
    setQueryInput('');
    setDebouncedQuery('');
    setDocId('');
    setFlagFilter('');
    setMinTokens('');
    setMaxTokens('');
    setSort('doc_chunk');
    setPage(0);
  };

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success(`Đã sao chép ${label}`));
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-white">
      {/* Filter & Search Bar */}
      <div className="px-5 py-2.5 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center gap-2 shrink-0">
        <div className="relative flex-1 min-w-[220px] max-w-[360px] flex items-center rounded-md border border-[#dcdcd8] bg-white px-2.5 focus-within:border-[#03aa5c] transition-colors">
          <Search className="size-3.5 text-[#71717a] shrink-0 mr-2 pointer-events-none" />
          <input
            type="text"
            className="w-full py-1.5 text-xs bg-transparent text-[#18181b] placeholder:text-[#a1a1aa] focus:outline-none"
            placeholder="Tìm theo Chunk ID, #số chunk, nội dung, keyword, tên file..."
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
          />
          {queryInput && (
            <button
              type="button"
              onClick={() => setQueryInput('')}
              className="ml-1.5 text-[#71717a] hover:text-[#18181b] shrink-0"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <select
          className="ts-input py-1.5 px-2.5 text-xs rounded-md bg-white max-w-[220px]"
          value={docId}
          onChange={(e) => {
            setDocId(e.target.value);
            setPage(0);
          }}
        >
          <option value="">Tất cả tài liệu ({data?.documents.length ?? 0})</option>
          {(data?.documents || []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.doc_code} ({d.chunk_count}) — {d.filename.slice(0, 28)}
            </option>
          ))}
        </select>

        <select
          className="ts-input py-1.5 px-2.5 text-xs rounded-md bg-white max-w-[210px]"
          value={flagFilter}
          onChange={(e) => {
            setFlagFilter(e.target.value);
            setPage(0);
          }}
        >
          <option value="">Tất cả trạng thái cờ</option>
          <option value="ANY">Có cảnh báo ({data?.stats.flagged_count ?? 0})</option>
          <option value="NONE">Không có cảnh báo</option>
          {Object.entries(data?.flag_counts || {})
            .sort((a, b) => b[1] - a[1])
            .map(([code, cnt]) => (
              <option key={code} value={code}>
                {code} ({cnt})
              </option>
            ))}
        </select>

        <select
          className="ts-input py-1.5 px-2.5 text-xs rounded-md bg-white"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setPage(0);
          }}
        >
          <option value="doc_chunk">Sắp xếp: Tài liệu → Thứ tự</option>
          <option value="tokens_desc">Token giảm dần</option>
          <option value="tokens_asc">Token tăng dần</option>
          <option value="chars_desc">Ký tự giảm dần</option>
          <option value="flags_desc">Nhiều cảnh báo nhất</option>
        </select>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={resetFilters}
            className="text-xs text-[#71717a] hover:text-[#18181b] px-2 py-1 rounded border border-[#e4e4e2] bg-white"
          >
            Xóa lọc
          </button>
        )}
      </div>

      {/* Stats Strip */}
      <div className="px-5 py-1.5 border-b border-[#ededeb] bg-white flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#71717a] shrink-0">
        <div className="flex flex-wrap items-center gap-4">
          <span>
            Khớp: <strong className="text-[#18181b] font-mono">{data?.total ?? 0}</strong> /{' '}
            <span className="font-mono">{data?.total_all ?? 0}</span> chunks
          </span>
          <span>
            Token TB: <strong className="text-[#18181b] font-mono">{data?.stats.avg_tokens ?? 0}</strong>
          </span>
          <span>
            Min–Max:{' '}
            <strong className="text-[#18181b] font-mono">
              {data?.stats.min_tokens ?? 0}–{data?.stats.max_tokens ?? 0}
            </strong>{' '}
            tok
          </span>
          <span>
            Có cảnh báo:{' '}
            <strong className="text-[#b45309] font-mono">{data?.stats.flagged_count ?? 0}</strong>
          </span>
        </div>

        <div className="flex items-center gap-2">
          {loading && <Loader2 className="size-3.5 animate-spin text-[#71717a]" />}
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="p-1 rounded border border-[#e4e4e2] bg-white hover:bg-[#f4f4f2] disabled:opacity-40"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="font-mono text-[#18181b]">
            Trang {page + 1}/{totalPages}
          </span>
          <button
            type="button"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="p-1 rounded border border-[#e4e4e2] bg-white hover:bg-[#f4f4f2] disabled:opacity-40"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Main Split View */}
      <div className="flex-1 flex min-h-0 overflow-hidden divide-x divide-[#e8e8e6]">
        {/* Left: Chunk List */}
        <div className="w-[42%] min-w-[320px] max-w-[540px] overflow-y-auto divide-y divide-[#ededeb]">
          {items.length === 0 ? (
            <div className="p-8 text-center text-xs text-[#71717a]">
              {loading ? 'Đang tải danh sách chunk...' : 'Không tìm thấy chunk nào khớp bộ lọc.'}
            </div>
          ) : (
            items.map((c) => {
              const isSel = selected?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelected(c)}
                  className={`w-full text-left px-4 py-3 transition-colors ${
                    isSel ? 'bg-[#f4f4f2] border-l-2 border-l-[#18181b]' : 'hover:bg-[#fafaf9]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-xs font-semibold text-[#18181b]">{c.doc_code}</span>
                      <span className="font-mono text-[11px] text-[#71717a]">#{c.chunk_index}</span>
                      <span className="text-[11px] text-[#a1a1aa]">p.{c.page_num}</span>
                      {c.ragflow_chunk_id && (
                        <span
                          className="font-mono text-[10px] text-[#8a8a8e] truncate max-w-[84px]"
                          title={`Chunk ID: ${c.ragflow_chunk_id}`}
                        >
                          {c.ragflow_chunk_id.slice(0, 8)}…
                        </span>
                      )}
                      {c.is_sampled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#eff6ff] text-[#1d4ed8] border border-[#bfdbfe]">
                          Mẫu QC
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[11px] text-[#52525b] shrink-0">
                      {c.token_est} tok · {c.char_count} ch
                    </span>
                  </div>
                  <p className="text-xs text-[#3f3f46] line-clamp-2 leading-relaxed">
                    {highlightText(c.content, debouncedQuery)}
                  </p>
                  {c.rule_flags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {c.rule_flags.map((f) => (
                        <span
                          key={f}
                          className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#fef3c7] text-[#92400e] border border-[#fde68a]"
                        >
                          <AlertTriangle className="size-2.5" />
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Right: Chunk Detail Inspector */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-white">
          {!selected ? (
            <div className="h-full flex flex-col items-center justify-center text-xs text-[#71717a] gap-2">
              <FileText className="size-6 text-[#d4d4d8]" />
              <span>Chọn một chunk bên trái để xem chi tiết</span>
            </div>
          ) : (
            <>
              {/* Detail Header */}
              <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-[#ededeb]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-[#18181b]">
                      {selected.doc_code} · Chunk #{selected.chunk_index}
                    </span>
                    <span className="text-xs text-[#71717a]">Trang {selected.page_num}</span>
                    {selected.format_group && (
                      <span className="text-[11px] px-2 py-0.5 rounded bg-[#f4f4f2] text-[#52525b]">
                        {selected.format_group}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-[#71717a] mt-0.5 truncate" title={selected.filename}>
                    {selected.filename}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => copyText(selected.content, 'nội dung chunk')}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-[#e4e4e2] bg-white hover:bg-[#f4f4f2] text-[#52525b]"
                  >
                    <Copy className="size-3" /> Copy text
                  </button>
                  {selected.has_local_file && selected.filename.toLowerCase().endsWith('.pdf') && (
                    <button
                      type="button"
                      onClick={() => setShowPdfPreview((v) => !v)}
                      className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded border transition-colors ${
                        showPdfPreview
                          ? 'bg-[#18181b] text-white border-[#18181b]'
                          : 'bg-white text-[#52525b] border-[#e4e4e2] hover:bg-[#f4f4f2]'
                      }`}
                    >
                      <FileImage className="size-3" />
                      {showPdfPreview ? 'Ẩn trang PDF' : 'Xem trang PDF'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={selectedIdx <= 0}
                    onClick={() => selectedIdx > 0 && setSelected(items[selectedIdx - 1])}
                    className="p-1 rounded border border-[#e4e4e2] bg-white hover:bg-[#f4f4f2] disabled:opacity-40"
                    title="Chunk trước"
                  >
                    <ChevronLeft className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={selectedIdx < 0 || selectedIdx >= items.length - 1}
                    onClick={() => selectedIdx < items.length - 1 && setSelected(items[selectedIdx + 1])}
                    className="p-1 rounded border border-[#e4e4e2] bg-white hover:bg-[#f4f4f2] disabled:opacity-40"
                    title="Chunk sau"
                  >
                    <ChevronRight className="size-3.5" />
                  </button>
                </div>
              </div>

              {/* Metadata Pills */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded bg-[#fafaf9] border border-[#e4e4e2] font-mono text-[#18181b]">
                  {selected.token_est} tokens
                </span>
                <span className="px-2 py-0.5 rounded bg-[#fafaf9] border border-[#e4e4e2] font-mono text-[#52525b]">
                  {selected.char_count} ký tự
                </span>
                {selected.ragflow_chunk_id && (
                  <button
                    type="button"
                    onClick={() => copyText(selected.ragflow_chunk_id, 'Chunk ID')}
                    className="px-2 py-0.5 rounded bg-[#fafaf9] border border-[#e4e4e2] font-mono text-[11px] text-[#71717a] hover:text-[#18181b]"
                    title="Click để copy RAGFlow Chunk ID"
                  >
                    ID: {selected.ragflow_chunk_id.slice(0, 14)}…
                  </button>
                )}
              </div>

              {/* Rule Flags */}
              {selected.rule_flags.length > 0 && (
                <div className="p-3 rounded-md bg-[#fffbeb] border border-[#fde68a] space-y-1">
                  <div className="text-[11px] font-semibold text-[#92400e] uppercase tracking-wider">
                    Cảnh báo tự động (Rule Engine)
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {selected.rule_flags.map((f) => (
                      <span
                        key={f}
                        className="text-xs px-2 py-0.5 rounded bg-white border border-[#fcd34d] text-[#92400e]"
                      >
                        <strong className="font-mono">{f}</strong>
                        {flagLabels[f] ? ` — ${flagLabels[f]}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Important Keywords */}
              {selected.important_keywords.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-[#71717a] mr-1">Keywords:</span>
                  {selected.important_keywords.map((kw, i) => (
                    <span
                      key={i}
                      className="text-[11px] px-2 py-0.5 rounded bg-[#f4f4f2] text-[#3f3f46]"
                    >
                      {kw}
                    </span>
                  ))}
                </div>
              )}

              {/* Prev Context */}
              {selected.prev_tail && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
                    Đuôi chunk liền trước (#{selected.chunk_index - 1})
                  </div>
                  <div className="p-3 rounded bg-[#fafaf9] border border-dashed border-[#e4e4e2] text-xs text-[#71717a] whitespace-pre-wrap leading-relaxed">
                    …{selected.prev_tail}
                  </div>
                </div>
              )}

              {/* Main Content */}
              <div className="space-y-1">
                <div className="ts-eyebrow">NỘI DUNG CHUNK</div>
                <ChunkContentView
                  content={selected.content}
                  renderText={(txt) => highlightText(txt, debouncedQuery)}
                />
              </div>

              {/* Next Context */}
              {selected.next_head && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#a1a1aa]">
                    Đầu chunk liền sau (#{selected.chunk_index + 1})
                  </div>
                  <div className="p-3 rounded bg-[#fafaf9] border border-dashed border-[#e4e4e2] text-xs text-[#71717a] whitespace-pre-wrap leading-relaxed">
                    {selected.next_head}…
                  </div>
                </div>
              )}

              {/* Optional PDF Page Image */}
              {showPdfPreview && selected.has_local_file && selected.filename.toLowerCase().endsWith('.pdf') && (
                <div className="space-y-1.5 pt-2 border-t border-[#ededeb]">
                  <div className="ts-eyebrow">ẢNH TRANG PDF GỐC (TRANG {selected.page_num})</div>
                  <img
                    src={`/api/parsing/documents/${selected.document_id}/page/${selected.page_num}`}
                    alt={`Trang ${selected.page_num}`}
                    className="w-full border border-[#ededeb] rounded"
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
