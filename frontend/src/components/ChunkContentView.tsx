import React, { useMemo, useState } from 'react';
import { Code2, Table2 } from 'lucide-react';

interface Props {
  content: string;
  renderText?: (text: string) => React.ReactNode;
}

interface ParsedCell {
  isHeader: boolean;
  text: string;
  colSpan: number;
  rowSpan: number;
}

interface ParsedTable {
  caption: string;
  rows: ParsedCell[][];
  colCount: number;
}

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'table'; table: ParsedTable };

function parseHtmlTable(tableHtml: string): ParsedTable {
  const doc = new DOMParser().parseFromString(tableHtml, 'text/html');
  const tbl = doc.querySelector('table');
  const caption = tbl?.querySelector('caption')?.textContent?.trim() || '';
  const trEls = Array.from(tbl ? tbl.querySelectorAll('tr') : doc.querySelectorAll('tr'));
  const rows: ParsedCell[][] = [];
  let maxCols = 0;

  for (const tr of trEls) {
    const cellEls = Array.from(tr.children).filter(
      (el) => el.tagName === 'TH' || el.tagName === 'TD'
    );
    if (cellEls.length === 0) continue;
    const row: ParsedCell[] = [];
    let colSum = 0;
    for (const el of cellEls) {
      const colSpan = Math.max(1, parseInt(el.getAttribute('colspan') || '1', 10) || 1);
      const rowSpan = Math.max(1, parseInt(el.getAttribute('rowspan') || '1', 10) || 1);
      colSum += colSpan;
      row.push({
        isHeader: el.tagName === 'TH',
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        colSpan,
        rowSpan,
      });
    }
    if (colSum > maxCols) maxCols = colSum;
    rows.push(row);
  }
  return { caption, rows, colCount: maxCols };
}

function parseMarkdownTableBlock(lines: string[]): ParsedTable | null {
  const cleaned = lines.map((l) => l.trim()).filter(Boolean);
  if (cleaned.length < 2) return null;
  const rows: ParsedCell[][] = [];
  let maxCols = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const ln = cleaned[i];
    if (/^\|?[\s:-]+(?:\|[\s:-]+)+\|?$/.test(ln)) continue;
    const rawCells = ln.replace(/^\|/, '').replace(/\|$/, '').split('|');
    const isHeader = i === 0;
    const row: ParsedCell[] = rawCells.map((c) => ({
      isHeader,
      text: c.trim(),
      colSpan: 1,
      rowSpan: 1,
    }));
    if (row.length > maxCols) maxCols = row.length;
    rows.push(row);
  }
  if (rows.length < 2 || maxCols < 2) return null;
  return { caption: '', rows, colCount: maxCols };
}

function splitContentToSegments(content: string): { hasTable: boolean; segments: Segment[] } {
  const raw = content || '';
  const hasHtmlTable = /<table\b/i.test(raw) || /<tr\b/i.test(raw);

  if (hasHtmlTable) {
    const segments: Segment[] = [];
    const tableRe = /<table\b[\s\S]*?(?:<\/table>|$)/gi;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    let foundAny = false;

    while ((match = tableRe.exec(raw)) !== null) {
      const before = raw.slice(lastIdx, match.index).trim();
      if (before) segments.push({ kind: 'text', text: before });
      const parsed = parseHtmlTable(match[0]);
      if (parsed.rows.length > 0) {
        segments.push({ kind: 'table', table: parsed });
        foundAny = true;
      } else {
        segments.push({ kind: 'text', text: match[0] });
      }
      lastIdx = match.index + match[0].length;
    }

    if (!foundAny && /<tr\b/i.test(raw)) {
      const parsed = parseHtmlTable(`<table>${raw}</table>`);
      if (parsed.rows.length > 0) {
        return { hasTable: true, segments: [{ kind: 'table', table: parsed }] };
      }
    }

    const tail = raw.slice(lastIdx).trim();
    if (tail) segments.push({ kind: 'text', text: tail });
    return { hasTable: foundAny, segments };
  }

  // Fallback: detect Markdown pipe tables
  const lines = raw.split(/\r?\n/);
  const segments: Segment[] = [];
  let textBuf: string[] = [];
  let pipeBuf: string[] = [];
  let foundAny = false;

  const flushText = () => {
    const joined = textBuf.join('\n').trim();
    if (joined) segments.push({ kind: 'text', text: joined });
    textBuf = [];
  };
  const flushPipe = () => {
    if (pipeBuf.length === 0) return;
    const parsed = parseMarkdownTableBlock(pipeBuf);
    if (parsed) {
      segments.push({ kind: 'table', table: parsed });
      foundAny = true;
    } else {
      textBuf.push(...pipeBuf);
    }
    pipeBuf = [];
  };

  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushText();
      pipeBuf.push(line);
    } else {
      flushPipe();
      textBuf.push(line);
    }
  }
  flushPipe();
  flushText();

  return { hasTable: foundAny, segments };
}

export const ChunkContentView: React.FC<Props> = ({ content, renderText }) => {
  const [viewRaw, setViewRaw] = useState(false);
  const { hasTable, segments } = useMemo(() => splitContentToSegments(content), [content]);

  if (!hasTable) {
    return (
      <div className="bg-[#fafaf9] border border-[#d4d4d0] p-4 text-[13.5px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty">
        {renderText ? renderText(content) : content}
      </div>
    );
  }

  return (
    <div className="bg-[#fafaf9] border border-[#d4d4d0] overflow-hidden">
      {/* Mini Header Bar with Table / Raw Toggle */}
      <div className="px-3.5 py-1.5 bg-[#f4f4f2] border-b border-[#e4e4e2] flex items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-1.5 text-[#52525b] font-medium">
          <Table2 className="size-3.5 text-[#027a42]" />
          <span>Bảng trực tiếp từ RAGFlow</span>
        </div>
        <div className="inline-flex items-center p-0.5 rounded bg-white border border-[#e4e4e2]">
          <button
            type="button"
            onClick={() => setViewRaw(false)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[2px] text-[10.5px] transition-colors ${
              !viewRaw ? 'bg-[#18181b] text-white font-medium' : 'text-[#71717a] hover:text-[#18181b]'
            }`}
          >
            <Table2 className="size-3" />
            Dạng bảng
          </button>
          <button
            type="button"
            onClick={() => setViewRaw(true)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[2px] text-[10.5px] transition-colors ${
              viewRaw ? 'bg-[#18181b] text-white font-medium' : 'text-[#71717a] hover:text-[#18181b]'
            }`}
          >
            <Code2 className="size-3" />
            Mã gốc
          </button>
        </div>
      </div>

      {viewRaw ? (
        <div className="p-4 text-[12.5px] font-mono text-[#18181b] leading-relaxed whitespace-pre-wrap break-words">
          {renderText ? renderText(content) : content}
        </div>
      ) : (
        <div className="p-3.5 space-y-3 bg-white">
          {segments.map((seg, idx) =>
            seg.kind === 'text' ? (
              <div
                key={idx}
                className="text-[13.5px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty"
              >
                {renderText ? renderText(seg.text) : seg.text}
              </div>
            ) : (
              <div key={idx} className="border border-[#dcdcd8] rounded-[4px] overflow-hidden bg-white">
                <div className="px-3 py-1.5 bg-[#fafaf9] border-b border-[#e8e8e4] flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-semibold text-[#18181b] truncate">
                    {seg.table.caption ? `Bảng: ${seg.table.caption}` : 'Dữ liệu bảng'}
                  </span>
                  <span className="font-mono text-[10.5px] text-[#71717a] shrink-0">
                    {seg.table.rows.length} hàng × {seg.table.colCount} cột · cuộn ngang →
                  </span>
                </div>
                <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
                  <table className="w-full border-collapse text-[12px] text-[#18181b]">
                    <tbody>
                      {seg.table.rows.map((row, rIdx) => (
                        <tr
                          key={rIdx}
                          className={
                            row.every((c) => c.isHeader)
                              ? 'bg-[#f4f4f2] sticky top-0 z-10'
                              : rIdx % 2 === 0
                              ? 'bg-white hover:bg-[#f8faf8]'
                              : 'bg-[#fcfcfb] hover:bg-[#f8faf8]'
                          }
                        >
                          {row.map((cell, cIdx) => {
                            const Tag = cell.isHeader ? 'th' : 'td';
                            const isFirstCol = cIdx === 0;
                            return (
                              <Tag
                                key={cIdx}
                                colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                                rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                                className={`border border-[#e4e4e0] px-2.5 py-1.5 text-left align-top leading-snug ${
                                  cell.isHeader
                                    ? 'font-semibold text-[#18181b] min-w-[120px] max-w-[240px] text-[11.5px] bg-[#f4f4f2]'
                                    : isFirstCol
                                    ? 'font-medium text-[#18181b] min-w-[130px] max-w-[260px] bg-[#fafaf9] sticky left-0 z-[5]'
                                    : 'font-mono text-[11.5px] text-[#27272a] min-w-[80px] max-w-[260px]'
                                }`}
                              >
                                {cell.text ? (renderText ? renderText(cell.text) : cell.text) : <span className="text-[#c4c4c0]">—</span>}
                              </Tag>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
};
