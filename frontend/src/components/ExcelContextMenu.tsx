import React, { useEffect } from 'react';
import { Copy, ExternalLink, Rows3, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

export interface ExcelMenuState {
  x: number;
  y: number;
  cellRef: string;
  cellText: string;
  rowTsv: string;
  onOpen?: () => void;
  openLabel?: string;
  onDelete?: () => void;
}

export interface SelectedCellInfo {
  cellRef: string;
  text: string;
}

/**
 * Extracts exact Excel coordinate (e.g. "D4"), full cell text (via data-copy or innerText),
 * and full tab-separated row text (ready to paste directly into real Excel/Sheets).
 */
export function extractExcelCellInfo(
  target: HTMLElement,
  colLetters: string[]
): { cellRef: string; cellText: string; rowTsv: string } | null {
  const td = target.closest('td');
  const tr = target.closest('tr');
  if (!td || !tr) return null;

  const cells = Array.from(tr.querySelectorAll('td'));
  const tdIdx = cells.indexOf(td);
  if (tdIdx < 0) return null;

  const rowNumText = (cells[0]?.innerText || '').trim();
  const colLetter = tdIdx === 0 ? '#' : colLetters[tdIdx - 1] || `C${tdIdx}`;
  const cellRef = rowNumText ? `${colLetter}${rowNumText}` : colLetter;

  const cellText = (td.getAttribute('data-copy') ?? td.innerText ?? '').trim();
  const rowTsv = cells
    .slice(1)
    .map((c) => (c.getAttribute('data-copy') ?? c.innerText ?? '').replace(/\s+/g, ' ').trim())
    .join('\t');

  return { cellRef, cellText, rowTsv };
}

export function copyToClipboard(text: string, label = 'Đã copy') {
  if (!text || text === '—') {
    toast.info('Ô này đang trống.');
    return;
  }
  navigator.clipboard?.writeText(text).then(() => {
    const preview = text.length > 48 ? `${text.slice(0, 48)}…` : text;
    toast.success(`${label}: "${preview}"`, { duration: 1600 });
  });
}

export const ExcelContextMenu: React.FC<{
  menu: ExcelMenuState | null;
  onClose: () => void;
}> = ({ menu, onClose }) => {
  useEffect(() => {
    if (!menu) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const left = typeof window !== 'undefined' ? Math.min(menu.x, window.innerWidth - 235) : menu.x;
  const top = typeof window !== 'undefined' ? Math.min(menu.y, window.innerHeight - 190) : menu.y;

  return (
    <div
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 w-[225px] rounded-md border border-[#dcdcd8] bg-white shadow-xl py-1 text-xs text-[#18181b] select-none"
    >
      <div className="px-3 py-1 border-b border-[#f0f0ee] flex items-center justify-between text-[10.5px] text-[#71717a] font-mono">
        <span>Ô {menu.cellRef}</span>
        <span className="truncate max-w-[130px]">{menu.cellText ? `${menu.cellText.length} ký tự` : 'Trống'}</span>
      </div>

      <button
        type="button"
        onClick={() => {
          copyToClipboard(menu.cellText, `Đã copy ô ${menu.cellRef}`);
          onClose();
        }}
        className="w-full text-left px-3 py-1.5 hover:bg-[#f2fbf6] hover:text-[#027a42] flex items-center gap-2 transition-colors"
      >
        <Copy className="size-3.5 shrink-0" />
        <span>Copy nội dung ô này</span>
      </button>

      <button
        type="button"
        onClick={() => {
          copyToClipboard(menu.rowTsv, 'Đã copy cả dòng (TSV)');
          onClose();
        }}
        className="w-full text-left px-3 py-1.5 hover:bg-[#f2fbf6] hover:text-[#027a42] flex items-center gap-2 transition-colors"
      >
        <Rows3 className="size-3.5 shrink-0" />
        <span>Copy cả dòng (dán Excel)</span>
      </button>

      {menu.onOpen && (
        <>
          <div className="my-1 border-t border-[#f0f0ee]" />
          <button
            type="button"
            onClick={() => {
              menu.onOpen?.();
              onClose();
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-[#f4f4f2] font-medium flex items-center gap-2 transition-colors"
          >
            <ExternalLink className="size-3.5 shrink-0 text-[#027a42]" />
            <span>{menu.openLabel || 'Mở chi tiết dòng này'}</span>
          </button>
        </>
      )}

      {menu.onDelete && (
        <button
          type="button"
          onClick={() => {
            menu.onDelete?.();
            onClose();
          }}
          className="w-full text-left px-3 py-1.5 hover:bg-[#fef2f2] text-[#b91c1c] flex items-center gap-2 transition-colors"
        >
          <Trash2 className="size-3.5 shrink-0" />
          <span>Xóa dòng này</span>
        </button>
      )}
    </div>
  );
};
