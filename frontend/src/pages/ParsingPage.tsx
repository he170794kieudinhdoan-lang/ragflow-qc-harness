import React, { useEffect, useRef, useState } from 'react';
import { diffChars, diffWordsWithSpace } from 'diff';
import { AlertCircle, ArrowRight, BarChart3, CheckCheck, ChevronLeft, ChevronRight, FileText, GripHorizontal, Image as ImageIcon, Layers, LayoutGrid, List, ListOrdered, Loader2, Lock, Maximize2, Minimize2, Plus, Sparkles, Table2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { ParsingTableView } from '../components/ParsingTableView';
import { DocumentItem, ErrorCodeDef, ParsingUnit, RunItem } from '../types';

interface Props {
  activeRun: RunItem | null;
  errorCatalog: ErrorCodeDef[];
  isActive?: boolean;
  onNextStep?: () => void;
  onProgressChange?: (rated: number, total: number) => void;
}

type ColorFilter = 'ALL' | 'PASS' | 'FAIL';

export const ParsingPage: React.FC<Props> = ({ activeRun, errorCatalog, isActive = true, onNextStep, onProgressChange }) => {
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<number | undefined>(undefined);
  const [units, setUnits] = useState<ParsingUnit[]>([]);
  const [selectedUnit, setSelectedUnit] = useState<ParsingUnit | null>(null);
  const [hoveredUnit, setHoveredUnit] = useState<ParsingUnit | null>(null);
  const [colorFilter, setColorFilter] = useState<ColorFilter>('ALL');
  const [sidebarViewMode, setSidebarViewMode] = useState<'grid' | 'list'>('grid');
  const [pageViewMode, setPageViewMode] = useState<'overview' | 'table'>('overview');
  const [metrics, setMetrics] = useState<any>(null);
  const [showAdd, setShowAdd] = useState(false);

  const [newType, setNewType] = useState('text');
  const [newPage, setNewPage] = useState(1);
  const [newTitle, setNewTitle] = useState('');
  const [newText, setNewText] = useState('');

  const [errCodes, setErrCodes] = useState<string[]>([]);
  const [autoSuggested, setAutoSuggested] = useState(false);
  const [charErr, setCharErr] = useState(false);
  const [fidErr, setFidErr] = useState(false);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [showDiff, setShowDiff] = useState(true);
  const [checkFormat, setCheckFormat] = useState(false);
  const [charLevel, setCharLevel] = useState(false);
  const [showFullChunk, setShowFullChunk] = useState(false);
  const [showCharts, setShowCharts] = useState(false);
  const [showErrPopover, setShowErrPopover] = useState(false);
  const [bulkApproving, setBulkApproving] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [batchOcrRunning, setBatchOcrRunning] = useState(false);
  const [samplePerDoc, setSamplePerDoc] = useState<number>(25);
  const [reExtracting, setReExtracting] = useState(false);

  const handleReExtract = async () => {
    if (!activeRun || reExtracting) return;
    setReExtracting(true);
    try {
      const res = await api.reExtractRunUnits(activeRun.id, samplePerDoc);
      await load();
      toast.success(`Đã tách lại ${res.extracted_units} đoạn (${samplePerDoc} đoạn/file).`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setReExtracting(false);
    }
  };

  const handleVisionOcr = async () => {
    if (!selectedUnit || ocrRunning) return;
    setOcrRunning(true);
    try {
      await api.visionOcrUnit(selectedUnit.id);
      await load();
      toast.success(`Đã OCR bản chuẩn cho ${selectedUnit.doc_code} trang ${selectedUnit.page_num}.`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setOcrRunning(false);
    }
  };

  const pendingOcrCount = units.filter(
    (u) => u.source_text.startsWith('[Trang ') || u.source_text.startsWith('[Hình ảnh / Sơ đồ')
  ).length;

  const handleBatchVisionOcr = async () => {
    if (!activeRun || batchOcrRunning || pendingOcrCount === 0) return;
    setBatchOcrRunning(true);
    try {
      const res = await api.batchVisionOcr(activeRun.id);
      await load();
      toast.success(`Vision OCR hoàn tất: ${res.done}/${res.total} trang/ảnh${res.failed ? ` (${res.failed} lỗi)` : ''}.`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBatchOcrRunning(false);
    }
  };

  const [llmJudging, setLlmJudging] = useState(false);
  const [docOcrRunningId, setDocOcrRunningId] = useState<number | null>(null);

  const handleDocVisionEnhance = async (documentId: number, docCode: string) => {
    if (!activeRun || docOcrRunningId !== null) return;
    setDocOcrRunningId(documentId);
    try {
      const res = await api.visionOcrDocument(activeRun.id, documentId);
      await load();
      if (res.done > 0) {
        toast.success(
          `Vision Enhancement (${res.vision_model}) xong ${docCode}: ${res.done}/${res.total} trang · LLM đã chấm lại ${res.llm_judged} đoạn.`
        );
      } else {
        toast.error(`Vision Enhancement thất bại cho ${docCode}: ${res.last_error || 'Không đọc được ảnh'}`);
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setDocOcrRunningId(null);
    }
  };

  const handleLlmJudgeParsing = async (onlyUnrated = true) => {
    if (!activeRun || llmJudging) return;
    setLlmJudging(true);
    try {
      const res = await api.llmJudgeParsing(activeRun.id, onlyUnrated);
      await load();
      toast.success(
        `LLM (${res.model || 'AI'}) đã chấm ${res.judged} đoạn Parsing: ${res.pass_count} Đạt · ${res.fail_count} Không đạt.`
      );
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLlmJudging(false);
    }
  };

  // Draggable floating score popup position (bottom-right default)
  const [popupPos, setPopupPos] = useState<{ x: number; y: number }>(() => ({
    x: typeof window !== 'undefined' ? Math.max(24, window.innerWidth - 292) : 900,
    y: typeof window !== 'undefined' ? Math.max(80, window.innerHeight - 280) : 420,
  }));
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Resizable split between top heatmap matrix and side-by-side detail panel
  const [matrixHeight, setMatrixHeight] = useState<number>(130);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [matrixMinimized, setMatrixMinimized] = useState<boolean>(false);
  const [matrixPopupPos, setMatrixPopupPos] = useState<{ x: number; y: number }>({ x: 24, y: 64 });
  const matrixDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const onMatrixDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    matrixDragRef.current = { startX: e.clientX, startY: e.clientY, origX: matrixPopupPos.x, origY: matrixPopupPos.y };
    const onMove = (ev: MouseEvent) => {
      if (!matrixDragRef.current) return;
      const nextX = Math.max(8, Math.min(window.innerWidth - 308, matrixDragRef.current.origX + (ev.clientX - matrixDragRef.current.startX)));
      const nextY = Math.max(8, Math.min(window.innerHeight - 100, matrixDragRef.current.origY + (ev.clientY - matrixDragRef.current.startY)));
      setMatrixPopupPos({ x: nextX, y: nextY });
    };
    const onUp = () => {
      matrixDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const origH = matrixHeight;
    const onMove = (ev: MouseEvent) => {
      const nextH = Math.max(48, Math.min(window.innerHeight - 240, origH + (ev.clientY - startY)));
      setMatrixHeight(nextH);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: popupPos.x, origY: popupPos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      const nextX = Math.max(8, Math.min(window.innerWidth - 268, dragRef.current.origX + dx));
      const nextY = Math.max(56, Math.min(window.innerHeight - 120, dragRef.current.origY + dy));
      setPopupPos({ x: nextX, y: nextY });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const getUnitEffectiveState = (u: ParsingUnit): 'PASS' | 'FAIL' => {
    if (u.verdict === 'PASS') return 'PASS';
    if (u.verdict === 'FAIL' || u.verdict === 'PARTIAL') return 'FAIL';
    if (!u.matched_chunks || u.matched_chunks.length === 0) return 'FAIL';
    return u.matched_chunks[0]?.alignment?.suggested_verdict === 'PASS' ? 'PASS' : 'FAIL';
  };

  const filteredUnits = units.filter((u) => {
    if (selectedDocId && u.document_id !== selectedDocId) return false;
    if (colorFilter === 'ALL') return true;
    return getUnitEffectiveState(u) === colorFilter;
  });

  const normalizeParsingCodes = (raw: string[], unitType: string): string[] => {
    const map: Record<string, string> = {
      P1: 'TEXT', P4: 'TEXT', P5: 'TEXT', P6: 'TEXT',
      P2: 'LAYOUT', P7: 'LAYOUT', P8: 'LAYOUT',
      P3: 'ORDER',
      P9: 'TABLE', P10: 'TABLE',
      TEXT: 'TEXT', TABLE: 'TABLE', ORDER: 'ORDER', LAYOUT: 'LAYOUT',
    };
    const out = Array.from(new Set(raw.map((c) => map[c]).filter(Boolean)));
    if (out.length === 0) {
      return [unitType === 'table' ? 'TABLE' : unitType === 'image' || unitType === 'diagram' ? 'LAYOUT' : 'TEXT'];
    }
    return out;
  };

  const selectUnit = (u: ParsingUnit) => {
    setSelectedUnit(u);
    if (u.verdict === 'UNRATED') {
      const rawSuggested =
        u.matched_chunks && u.matched_chunks.length > 0
          ? u.matched_chunks[0]?.alignment?.suggested_error_codes || []
          : [u.unit_type === 'image' || u.unit_type === 'diagram' ? 'LAYOUT' : 'TEXT'];
      const suggested = rawSuggested.length > 0 ? normalizeParsingCodes(rawSuggested, u.unit_type) : [];
      setErrCodes(suggested);
      setAutoSuggested(suggested.length > 0);
      setCharErr(rawSuggested.some((c) => c === 'P4' || c === 'P5' || c === 'P6'));
      setFidErr(rawSuggested.some((c) => c === 'P10' || c === 'FIDELITY'));
    } else {
      setErrCodes(u.error_codes || []);
      setAutoSuggested(false);
      setCharErr(Boolean(u.char_error));
      setFidErr(Boolean(u.fidelity_error));
    }
    setNotes(u.notes || '');
  };

  const load = async (advanceFromId?: number, silent = false) => {
    if (!activeRun) return;
    if (!silent) setLoading(true);
    try {
      const [dRes, uRes, mRes] = await Promise.all([
        api.listDocuments(activeRun.id),
        api.listParsingUnits(activeRun.id),
        api.getParsingMetrics(activeRun.id),
      ]);
      setDocs(dRes);
      setUnits(uRes);
      setMetrics(mRes);
      onProgressChange?.(mRes?.rated_units || 0, mRes?.total_units || uRes.length);
      if (uRes.length > 0) {
        if (advanceFromId) {
          const idx = uRes.findIndex((u: ParsingUnit) => u.id === advanceFromId);
          const nextUnit = idx >= 0 && idx + 1 < uRes.length ? uRes[idx + 1] : null;
          if (nextUnit) selectUnit(nextUnit);
          else setSelectedUnit(null);
        } else if (selectedUnit) {
          const keep = uRes.find((u: ParsingUnit) => u.id === selectedUnit.id);
          if (keep) selectUnit(keep);
          else setSelectedUnit(null);
        }
      } else {
        setSelectedUnit(null);
      }
    } catch (e: any) {
      if (!silent) toast.error(`Không tải được dữ liệu Parsing: ${e?.message || e}`);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedDocId(undefined);
    setSelectedUnit(null);
    setHoveredUnit(null);
    load();
  }, [activeRun?.id]);

  // Auto-poll every 2.5s while background unit extraction from Step 1 sync is still running
  const bgSyncing = Boolean(metrics?.unit_sync_status?.running);
  const bgSyncDone = Number(metrics?.unit_sync_status?.done || 0);
  const bgSyncTotal = Number(metrics?.unit_sync_status?.total || 0);

  useEffect(() => {
    if (!activeRun?.id || !bgSyncing) return;
    const timer = window.setInterval(() => {
      load(undefined, true);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activeRun?.id, bgSyncing]);

  const handleScore = async (verdict: 'PASS' | 'PARTIAL' | 'FAIL') => {
    if (!selectedUnit || scoring) return;
    setScoring(true);
    setShowErrPopover(false);
    const savedCodes = verdict === 'PASS' ? [] : errCodes;
    const savedCharErr = verdict === 'PASS' ? false : charErr || savedCodes.some((c) => c === 'P4' || c === 'P5' || c === 'P6');
    const savedFidErr = verdict === 'PASS' ? false : fidErr || savedCodes.some((c) => c === 'FIDELITY' || c === 'P10');
    const savedSeverity = verdict === 'FAIL' ? 'Nghiêm trọng' : verdict === 'PARTIAL' ? 'Trung bình' : '';
    const scoredId = selectedUnit.id;
    const prevUnits = units;

    // 1. Optimistic UI: đổi màu ô ngay lập tức và nhảy tới ô chưa chấm kế tiếp
    const updatedUnits = units.map((u) =>
      u.id === scoredId
        ? {
            ...u,
            verdict,
            error_codes: savedCodes,
            char_error: savedCharErr ? 1 : 0,
            fidelity_error: savedFidErr ? 1 : 0,
            severity: savedSeverity,
            notes,
          }
        : u
    );
    setUnits(updatedUnits);
    const ratedNow = updatedUnits.filter((u) => u.verdict !== 'UNRATED').length;
    onProgressChange?.(ratedNow, updatedUnits.length);

    const curIdx = filteredUnits.findIndex((u) => u.id === scoredId);
    const remainingAfter = filteredUnits
      .slice(curIdx + 1)
      .map((f) => updatedUnits.find((u) => u.id === f.id) || f);
    const remainingBefore = filteredUnits
      .slice(0, Math.max(0, curIdx))
      .map((f) => updatedUnits.find((u) => u.id === f.id) || f);
    const nextUnrated =
      remainingAfter.find((u) => u.verdict === 'UNRATED') ||
      remainingBefore.find((u) => u.verdict === 'UNRATED') ||
      remainingAfter[0] ||
      null;

    if (nextUnrated) {
      selectUnit(nextUnrated);
    } else {
      setSelectedUnit(null);
    }

    // 2. Gọi API lưu nền (trong lúc chờ thì disable 3 nút chấm để tránh bấm đúp)
    try {
      await api.scoreParsingUnit(scoredId, {
        verdict,
        error_codes: savedCodes,
        char_error: savedCharErr,
        fidelity_error: savedFidErr,
        severity: savedSeverity,
        notes,
      });
      if (activeRun) {
        api.getParsingMetrics(activeRun.id).then(setMetrics).catch(() => {});
      }
    } catch (e: any) {
      setUnits(prevUnits);
      onProgressChange?.(prevUnits.filter((u) => u.verdict !== 'UNRATED').length, prevUnits.length);
      toast.error(`Lưu thất bại: ${e.message}`);
    } finally {
      setScoring(false);
    }
  };

  const unratedGreenIds = units
    .filter((u) => u.verdict === 'UNRATED' && getUnitEffectiveState(u) === 'PASS')
    .map((u) => u.id);

  const unratedRedUnits = units.filter(
    (u) => u.verdict === 'UNRATED' && getUnitEffectiveState(u) === 'FAIL'
  );

  const handleBulkApproveRed = async () => {
    if (!activeRun || bulkApproving || unratedRedUnits.length === 0) return;
    setBulkApproving(true);
    const prevUnits = units;
    const payloadItems = unratedRedUnits.map((u) => {
      const rawSuggested =
        u.matched_chunks && u.matched_chunks.length > 0
          ? u.matched_chunks[0]?.alignment?.suggested_error_codes || []
          : [u.unit_type === 'image' || u.unit_type === 'diagram' ? 'LAYOUT' : 'TEXT'];
      const codes = normalizeParsingCodes(rawSuggested, u.unit_type);
      const hasChar = rawSuggested.some((c) => c === 'P4' || c === 'P5' || c === 'P6');
      const sev = codes.some((c) => ['TEXT', 'TABLE', 'LAYOUT'].includes(c))
        ? 'Nghiêm trọng'
        : 'Trung bình';
      return {
        unit_id: u.id,
        error_codes: codes,
        char_error: hasChar,
        severity: sev,
        notes: u.notes || '',
      };
    });
    const mapById = new Map(payloadItems.map((it) => [it.unit_id, it]));
    const updatedUnits = units.map((u) => {
      const it = mapById.get(u.id);
      return it
        ? {
            ...u,
            verdict: 'FAIL' as const,
            error_codes: it.error_codes,
            char_error: it.char_error ? 1 : 0,
            severity: it.severity,
          }
        : u;
    });
    setUnits(updatedUnits);
    onProgressChange?.(updatedUnits.filter((u) => u.verdict !== 'UNRATED').length, updatedUnits.length);
    try {
      await api.bulkApproveFailParsingUnits(activeRun.id, payloadItems);
      api.getParsingMetrics(activeRun.id).then(setMetrics).catch(() => {});
      toast.success(`Đã chốt nhanh ${payloadItems.length} ô đỏ kèm mã lỗi gợi ý.`);
    } catch (e: any) {
      setUnits(prevUnits);
      onProgressChange?.(prevUnits.filter((u) => u.verdict !== 'UNRATED').length, prevUnits.length);
      toast.error(e.message);
    } finally {
      setBulkApproving(false);
    }
  };

  const handleBulkApproveGreen = async () => {
    if (!activeRun || bulkApproving || unratedGreenIds.length === 0) return;
    setBulkApproving(true);
    const prevUnits = units;
    const idSet = new Set(unratedGreenIds);
    const updatedUnits = units.map((u) =>
      idSet.has(u.id) ? { ...u, verdict: 'PASS' as const, error_codes: [], char_error: 0, severity: '' } : u
    );
    setUnits(updatedUnits);
    onProgressChange?.(updatedUnits.filter((u) => u.verdict !== 'UNRATED').length, updatedUnits.length);
    try {
      await api.bulkApproveParsingUnits(activeRun.id, unratedGreenIds);
      api.getParsingMetrics(activeRun.id).then(setMetrics).catch(() => {});
      toast.success(`Đã duyệt nhanh ${unratedGreenIds.length} ô xanh.`);
    } catch (e: any) {
      setUnits(prevUnits);
      onProgressChange?.(prevUnits.filter((u) => u.verdict !== 'UNRATED').length, prevUnits.length);
      toast.error(e.message);
    } finally {
      setBulkApproving(false);
    }
  };

  const stepUnit = (delta: -1 | 1) => {
    if (!selectedUnit || filteredUnits.length === 0) return;
    const idx = filteredUnits.findIndex((u) => u.id === selectedUnit.id);
    if (idx < 0) return;
    const target = filteredUnits[idx + delta];
    if (target) selectUnit(target);
  };

  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        setSelectedUnit(null);
      } else if (selectedUnit && !scoring) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          stepUnit(-1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          stepUnit(1);
        } else if (e.key === '1') {
          handleScore('PASS');
        } else if (e.key === '2') {
          if (showErrPopover) handleScore('FAIL');
          else setShowErrPopover(true);
        } else if (e.key === 'Enter' && showErrPopover) {
          e.preventDefault();
          handleScore('FAIL');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive, selectedUnit, filteredUnits, errCodes, charErr, notes, scoring, showErrPopover]);

  if (!activeRun) {
    return <div className="p-8 text-sm text-[#71717a]">Hãy chọn hoặc tạo một phiên kiểm thử trước.</div>;
  }

  const handleAddUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    const docId = selectedDocId || docs[0]?.id;
    if (!docId || !newText.trim()) return;
    try {
      await api.createParsingUnit(activeRun.id, {
        document_id: docId,
        unit_type: newType,
        page_num: newPage,
        title: newTitle,
        source_text: newText,
      });
      setNewTitle('');
      setNewText('');
      setShowAdd(false);
      await load();
      toast.success('Đã thêm đoạn đối chiếu.');
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const toggleCode = (code: string) => {
    setAutoSuggested(false);
    setErrCodes((prev) => {
      const next = prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code];
      if (['P4', 'P5', 'P6'].includes(code) && next.includes(code)) {
        setCharErr(true);
      }
      return next;
    });
  };

  const badge = (v: string) => {
    if (v === 'PASS') return { text: 'Đạt', cls: 'bg-[#f0fdf4] text-[#15803d] border-[#bbf7d0]' };
    if (v === 'FAIL' || v === 'PARTIAL') return { text: 'Không đạt', cls: 'bg-[#fef2f2] text-[#b91c1c] border-[#fecaca]' };
    return { text: 'Chưa chấm', cls: 'bg-[#f4f4f2] text-[#71717a] border-[#e6e6e3]' };
  };

  // Muted 2-level tones: pale pastel when unrated, calm medium saturation once confirmed
  const getTileClass = (u: ParsingUnit, isSelected: boolean) => {
    const sel = isSelected
      ? 'outline outline-2 outline-[#161616] outline-offset-1 z-10'
      : 'hover:opacity-85';
    if (u.verdict === 'PASS') return `bg-[#4ea874] ${sel}`;
    if (u.verdict === 'FAIL' || u.verdict === 'PARTIAL') return `bg-[#d6656c] ${sel}`;
    const auto = getUnitEffectiveState(u);
    if (auto === 'PASS') return `bg-[#4ea874]/30 ${sel}`;
    return `bg-[#d6656c]/30 ${sel}`;
  };

  const counts = units.reduce(
    (acc, u) => {
      const st = getUnitEffectiveState(u);
      acc[st] += 1;
      if (u.verdict === 'UNRATED') acc.UNRATED += 1;
      return acc;
    },
    { PASS: 0, FAIL: 0, UNRATED: 0 }
  );

  const groupedUnits = filteredUnits.reduce<
    Record<string, { doc_code: string; document_id: number; filename: string; isOcr: boolean; items: ParsingUnit[] }>
  >((acc, u) => {
    if (!acc[u.doc_code]) {
      const docMeta = docs.find((d) => d.id === u.document_id);
      const isOcr =
        docMeta?.format_group === 'PDF scan / ảnh' ||
        (u.filename || '').toLowerCase().includes('scan');
      acc[u.doc_code] = {
        doc_code: u.doc_code,
        document_id: u.document_id,
        filename: u.filename,
        isOcr,
        items: [],
      };
    }
    if (u.source_text.startsWith('[Trang scan') || u.source_text.startsWith('[Hình ảnh')) {
      acc[u.doc_code].isOcr = true;
    }
    acc[u.doc_code].items.push(u);
    return acc;
  }, {});

  const renderPipeTable = (rawText: string) => {
    let cleaned = rawText || '';
    if (/<t[dh]\b/i.test(cleaned)) {
      cleaned = cleaned
        .replace(/<\/t[dh]\s*>\s*<t[dh][^>]*>/gi, ' | ')
        .replace(/<\/tr\s*>/gi, '\n')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
    }
    const lines = cleaned
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^[\|\-\s:]+$/.test(l));
    const pipeLines = lines.filter((l) => l.includes('|'));
    if (pipeLines.length < 2) {
      return <div className="whitespace-pre-wrap text-pretty">{rawText}</div>;
    }
    const rows = pipeLines.map((ln) =>
      ln
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
    );
    const maxCols = Math.max(...rows.map((r) => r.length));
    return (
      <div className="max-h-[360px] overflow-auto border border-[#dedede] bg-white">
        <table className="w-full text-left border-collapse text-[12px]">
          <thead>
            <tr className="bg-[#f7f7f6] border-b border-[#dedede]">
              {Array.from({ length: maxCols }).map((_, ci) => (
                <th
                  key={ci}
                  className="px-2.5 py-1.5 font-semibold text-[#161616] border-r border-[#ededeb] last:border-r-0 align-top"
                >
                  {rows[0][ci] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#ededeb]">
            {rows.slice(1).map((r, ri) => (
              <tr key={ri} className="hover:bg-[#fafaf9]">
                {Array.from({ length: maxCols }).map((_, ci) => (
                  <td
                    key={ci}
                    className="px-2.5 py-1.5 text-[#18181b] border-r border-[#ededeb] last:border-r-0 align-top"
                  >
                    {r[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderDiffText = (sourceText: string, targetText: string) => {
    const src = checkFormat
      ? sourceText.normalize('NFC').trim()
      : sourceText.normalize('NFC').replace(/\s+/g, ' ').trim();
    const tgt = checkFormat
      ? targetText.normalize('NFC').trim()
      : targetText.normalize('NFC').replace(/\s+/g, ' ').trim();
    const parts = charLevel ? diffChars(src, tgt) : diffWordsWithSpace(src, tgt);
    return (
      <span>
        {parts.map((part, i) => {
          if (part.removed) {
            return (
              <span
                key={i}
                className="bg-rose-100 text-rose-800 line-through px-0.5"
                title="Có trong bản gốc nhưng RAGFlow đọc thiếu / khác"
              >
                {part.value}
              </span>
            );
          }
          if (part.added) {
            return (
              <span
                key={i}
                className="bg-emerald-100 text-emerald-900 underline decoration-emerald-600 px-0.5"
                title="RAGFlow đọc thêm / đọc khác so với bản gốc"
              >
                {part.value}
              </span>
            );
          }
          return <React.Fragment key={i}>{part.value}</React.Fragment>;
        })}
      </span>
    );
  };

  const selectedIdx = selectedUnit ? filteredUnits.findIndex((u) => u.id === selectedUnit.id) : -1;
  const previewUnit = hoveredUnit || selectedUnit;
  const previewSim = previewUnit?.matched_chunks?.[0]?.alignment?.text_similarity;
  const previewFlags = previewUnit?.matched_chunks?.[0]?.alignment?.risk_flags || [];

  // Visual analytics data: always blends manual verdicts (for rated units) with auto-alignment (for unrated units)
  // so metrics never jump to a misleading 100% after rating just 1-2 units.
  const isAutoPreview = (metrics?.rated_units || 0) < units.length && units.length > 0;
  const effectiveMetrics = (() => {
    const textU = units.filter((u) => u.unit_type !== 'table' && u.unit_type !== 'image' && u.unit_type !== 'diagram');
    const tableU = units.filter((u) => u.unit_type === 'table');
    const getCodes = (u: ParsingUnit) =>
      u.verdict !== 'UNRATED'
        ? u.error_codes || []
        : u.matched_chunks?.[0]?.alignment?.suggested_error_codes || [];
    const charErrCnt = units.filter((u) =>
      u.char_error === 1 || getCodes(u).some((c) => c === 'P4' || c === 'P5' || c === 'P6')
    ).length;
    const orderOkCnt = units.filter((u) => !getCodes(u).some((c) => c === 'P3' || c === 'ORDER')).length;
    const fidelityOkCnt = units.filter((u) => {
      const codes = getCodes(u);
      return u.fidelity_error !== 1 && !codes.some((c) => c === 'P10' || c === 'FIDELITY');
    }).length;

    const textCompleteness = textU.length ? (textU.filter((u) => getUnitEffectiveState(u) === 'PASS').length / textU.length) * 100 : null;
    const tableAccuracy = tableU.length ? (tableU.filter((u) => getUnitEffectiveState(u) === 'PASS').length / tableU.length) * 100 : null;
    const charErrorRate = units.length ? (charErrCnt / units.length) * 100 : 0;
    // Unified Layout & Structure metric matching backend compute_parsing_metrics:
    // penalizes LAYOUT / P2 (unread diagram/image) / P7 (heading merged) / P8 (list merged) and any non-PASS image/diagram unit.
    const layoutOkCnt = units.filter((u) => {
      const codes = getCodes(u);
      const hasLayoutErr = codes.some((c) => c === 'LAYOUT' || c === 'P2' || c === 'P7' || c === 'P8');
      const failedImg = (u.unit_type === 'image' || u.unit_type === 'diagram') && getUnitEffectiveState(u) !== 'PASS';
      return !hasLayoutErr && !failedImg;
    }).length;
    const layoutAccuracy = units.length ? (layoutOkCnt / units.length) * 100 : null;
    const readingOrder = units.length ? (orderOkCnt / units.length) * 100 : null;
    const contentFidelity = units.length ? (fidelityOkCnt / units.length) * 100 : null;

    const weightedTerms: [number, number | null][] = [
      [0.25, textCompleteness],
      [0.20, contentFidelity],
      [0.20, tableAccuracy],
      [0.15, units.length ? 100 - charErrorRate : null],
      [0.10, layoutAccuracy],
      [0.10, readingOrder],
    ];
    const availTerms = weightedTerms.filter(([, v]) => v !== null) as [number, number][];
    const wSum = availTerms.reduce((acc, [w]) => acc + w, 0);
    const parsingScore = wSum > 0 ? availTerms.reduce((acc, [w, v]) => acc + w * v, 0) / wSum : 0;

    return {
      textCompleteness,
      tableAccuracy,
      charErrorRate,
      contentFidelity,
      layoutAccuracy,
      readingOrder,
      parsingScore,
    };
  })();

  const errorCodeBreakdown = (() => {
    const map: Record<string, number> = {};
    for (const u of units) {
      const codes =
        u.verdict !== 'UNRATED'
          ? u.error_codes || []
          : u.matched_chunks && u.matched_chunks.length > 0
          ? u.matched_chunks[0]?.alignment?.suggested_error_codes || []
          : [u.unit_type === 'image' || u.unit_type === 'diagram' ? 'P2' : 'P1'];
      for (const c of codes) {
        map[c] = (map[c] || 0) + 1;
      }
    }
    return Object.entries(map)
      .map(([code, count]) => ({
        code,
        count,
        name: errorCatalog.find((e) => e.code === code)?.name || code,
        severity: errorCatalog.find((e) => e.code === code)?.severity || '',
      }))
      .sort((a, b) => b.count - a.count);
  })();
  const maxErrCount = Math.max(1, ...errorCodeBreakdown.map((e) => e.count));

  const docBreakdown = Object.values(
    units.reduce<
      Record<string, { doc_code: string; filename: string; pass: number; partial: number; fail: number; total: number }>
    >((acc, u) => {
      if (!acc[u.doc_code]) {
        acc[u.doc_code] = { doc_code: u.doc_code, filename: u.filename, pass: 0, partial: 0, fail: 0, total: 0 };
      }
      const st = getUnitEffectiveState(u);
      if (st === 'PASS') acc[u.doc_code].pass += 1;
      else acc[u.doc_code].fail += 1;
      acc[u.doc_code].total += 1;
      return acc;
    }, {})
  );

  return (
    <div className="h-[calc(100dvh-48px)] flex flex-col bg-white">
      {/* Sub-header Toolbar */}
      <div className="px-5 py-1.5 border-b border-[#e8e8e6] bg-[#fafaf9] flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            className="ts-input py-1 px-2 text-xs rounded-md bg-white max-w-[200px]"
            value={selectedDocId ?? ''}
            onChange={(e) => setSelectedDocId(e.target.value ? Number(e.target.value) : undefined)}
            disabled={loading}
          >
            <option value="">Tất cả tài liệu ({docs.length})</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.doc_code} — {d.filename.slice(0, 32)}
              </option>
            ))}
          </select>

          <div className="inline-flex items-center border border-[#e4e4e2] bg-white rounded-md overflow-hidden">
            <input
              type="number"
              min={1}
              max={500}
              className="w-14 py-1 px-2 text-xs font-mono text-right bg-white text-[#18181b] focus:outline-none"
              value={samplePerDoc}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                setSamplePerDoc(Number.isFinite(v) ? Math.max(1, Math.min(500, v)) : 25);
              }}
              disabled={loading || reExtracting}
              title="Nhập số đoạn mẫu tối đa muốn tách cho mỗi tài liệu (1–500)"
            />
            <span className="pr-2 text-[11px] text-[#71717a] select-none">đoạn/file</span>
            <button
              type="button"
              onClick={handleReExtract}
              disabled={loading || reExtracting}
              className="px-2 py-1 text-xs font-medium bg-[#f7f7f6] hover:bg-[#ededeb] text-[#18181b] border-l border-[#e4e4e2] disabled:opacity-45 transition-colors"
              title="Tách lại toàn bộ đoạn đối chiếu theo số mẫu đã nhập"
            >
              {reExtracting ? 'Đang tách...' : 'Tách lại'}
            </button>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            disabled={loading}
            className="ts-btn-ghost py-1 px-2 text-xs rounded-md disabled:opacity-45"
          >
            <Plus className="size-3.5" />
            Thêm đoạn
          </button>
          {loading && <Loader2 className="size-3.5 animate-spin text-[#71717a]" />}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-[#52525b]">
          <div className="inline-flex items-center p-0.5 rounded-md bg-[#f4f4f2] border border-[#e4e4e2] mr-1">
            <button
              type="button"
              onClick={() => setPageViewMode('overview')}
              className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${
                pageViewMode === 'overview'
                  ? 'bg-white text-[#18181b] font-medium shadow-xs'
                  : 'text-[#71717a] hover:text-[#18181b]'
              }`}
              title="Xem ma trận ô màu & biểu đồ Radar"
            >
              <LayoutGrid className="size-3" />
              Tổng quan
            </button>
            <button
              type="button"
              onClick={() => setPageViewMode('table')}
              className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${
                pageViewMode === 'table'
                  ? 'bg-white text-[#18181b] font-medium shadow-xs'
                  : 'text-[#71717a] hover:text-[#18181b]'
              }`}
              title="Xem bảng tổng hợp điểm & chi tiết từng đoạn (Excel View)"
            >
              <Table2 className="size-3" />
              Bảng chi tiết
            </button>
          </div>

          <button
            type="button"
            disabled={loading || filteredUnits.length === 0}
            onClick={() => {
              const firstUnrated = filteredUnits.find((u) => u.verdict === 'UNRATED') || filteredUnits[0];
              if (firstUnrated) {
                selectUnit(firstUnrated);
                setIsFullscreen(true);
              }
            }}
            className="py-1 px-2.5 text-xs font-medium rounded-md inline-flex items-center gap-1.5 bg-[#18181b] text-white hover:bg-[#27272a] disabled:opacity-45 transition-colors"
            title="Mở chế độ chấm toàn màn hình"
          >
            <Maximize2 className="size-3" />
            Chế độ chấm
          </button>
          {onNextStep && (
            <button
              onClick={onNextStep}
              title="Sang Bước 3: Chấm cắt đoạn"
              className="ts-btn-secondary py-1 px-2.5 text-xs rounded-md"
            >
              Bước 3
              <ArrowRight className="size-3" />
            </button>
          )}
        </div>
      </div>

      {pageViewMode === 'table' ? (
        <ParsingTableView
          runId={activeRun?.id}
          units={units}
          docs={docs}
          getUnitEffectiveState={getUnitEffectiveState}
          onSelectUnit={(u) => {
            selectUnit(u);
            setIsFullscreen(true);
          }}
        />
      ) : (
      /* 2-Column Overview: Left = Matrix (DOC01..DOC20), Right = Thống kê lỗi */
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0 overflow-hidden bg-white">
        {/* Left: Matrix Overview */}
        <div className="lg:col-span-7 overflow-y-auto px-6 py-4 border-b lg:border-b-0 lg:border-r border-[#e8e8e6] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono text-[11px] font-semibold text-[#18181b] mr-2">
              {metrics?.rated_units || 0}/{units.length}
            </span>
            {(
              [
                { id: 'ALL', label: `Tất cả (${units.length})`, dot: 'bg-[#161616]' },
                { id: 'PASS', label: `Đạt (${counts.PASS})`, dot: 'bg-[#4ea874]' },
                { id: 'FAIL', label: `Không đạt (${counts.FAIL})`, dot: 'bg-[#d6656c]' },
              ] as { id: ColorFilter; label: string; dot: string }[]
            ).map((f) => (
              <button
                key={f.id}
                onClick={() => setColorFilter(f.id)}
                className={`inline-flex items-center gap-1.5 px-2 py-1 text-[11px] transition-colors ${
                  colorFilter === f.id
                    ? 'bg-[#18181b] text-white font-medium'
                    : 'bg-[#f4f4f2] text-[#52525b] hover:bg-[#e8e8e5]'
                }`}
              >
                <span className={`size-2 inline-block ${f.dot}`} />
                <span className="font-mono tabular-nums">{f.label}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => handleLlmJudgeParsing(counts.UNRATED > 0)}
              disabled={llmJudging || units.length === 0}
              className="ml-1 inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium bg-[#161616] text-white border border-[#161616] hover:bg-[#03aa5c] hover:border-[#03aa5c] transition-colors disabled:opacity-45"
              title="Dùng LLM-as-a-Judge đối chiếu ngữ nghĩa đoạn gốc với chunk RAGFlow (bỏ qua lỗi giả như thiếu số đề mục)"
            >
              {llmJudging ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              {llmJudging
                ? 'LLM đang đối chiếu...'
                : counts.UNRATED > 0
                ? `Chấm LLM (${counts.UNRATED} ô chưa chấm)`
                : 'Chấm lại bằng LLM'}
            </button>
            {unratedGreenIds.length > 0 && (
              <button
                type="button"
                onClick={handleBulkApproveGreen}
                disabled={bulkApproving}
                className="ml-1 inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium bg-[#03aa5c]/15 text-[#027a42] border border-[#03aa5c]/35 hover:bg-[#03aa5c] hover:text-white transition-colors disabled:opacity-45"
                title="Chốt nhanh toàn bộ các ô xanh khớp cao thành Đọc đúng"
              >
                <CheckCheck className="size-3.5" />
                {bulkApproving ? 'Đang duyệt...' : `Duyệt nhanh ô xanh (${unratedGreenIds.length})`}
              </button>
            )}
            {unratedRedUnits.length > 0 && (
              <button
                type="button"
                onClick={handleBulkApproveRed}
                disabled={bulkApproving}
                className="ml-1 inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium bg-[#fef2f2] text-[#b91c1c] border border-[#f5d0d3] hover:bg-[#b91c1c] hover:text-white transition-colors disabled:opacity-45"
                title="Chốt nhanh toàn bộ các ô đỏ thành Không đạt kèm mã lỗi P1..P10 gợi ý"
              >
                <AlertCircle className="size-3.5" />
                {bulkApproving ? 'Đang duyệt...' : `Duyệt nhanh ô đỏ (${unratedRedUnits.length})`}
              </button>
            )}
            {pendingOcrCount > 0 && (
              <button
                type="button"
                onClick={handleBatchVisionOcr}
                disabled={batchOcrRunning}
                className="ml-1 inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium bg-[#f2fbf6] text-[#027a42] border border-[#03aa5c]/35 hover:bg-[#03aa5c] hover:text-white transition-colors disabled:opacity-45"
                title="Dùng Vision LLM đọc toàn bộ trang scan / ảnh chưa có bản chuẩn"
              >
                {batchOcrRunning ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                {batchOcrRunning ? 'Đang Vision OCR...' : `Vision OCR ảnh/scan (${pendingOcrCount})`}
              </button>
            )}
          </div>
        </div>

        {bgSyncing && (
          <div className="mb-3 flex items-center justify-between gap-3 px-3.5 py-2.5 bg-[#eff6ff] border border-[#bfdbfe] text-[#1d4ed8] text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <Loader2 className="size-4 animate-spin shrink-0" />
              <span className="font-medium truncate">
                Đang tách đoạn &amp; đối chiếu dữ liệu nền từ RAGFlow ({bgSyncDone}/{bgSyncTotal || '?'} tài liệu)... Trang sẽ tự cập nhật.
              </span>
            </div>
            {bgSyncTotal > 0 && (
              <div className="w-28 h-1.5 bg-[#dbeafe] overflow-hidden shrink-0">
                <div
                  className="h-full bg-[#2563eb] transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.round((bgSyncDone / bgSyncTotal) * 100))}%` }}
                />
              </div>
            )}
          </div>
        )}

        {(loading || bgSyncing || reExtracting) && units.length === 0 ? (
          <div className="space-y-2.5 py-0.5">
            {[25, 25, 25, 25, 25, 25, 3, 25, 10, 13, 1, 9, 25, 25].map((cnt, rowIdx) => (
              <div
                key={rowIdx}
                className="flex items-start gap-3"
                style={{ opacity: Math.max(0.25, 1 - rowIdx * 0.055) }}
              >
                <div className="w-20 shrink-0 pt-0.5">
                  <div
                    className="h-3.5 w-11 rounded-[2px] ts-shimmer"
                    style={{ animationDelay: `${rowIdx * 60}ms` }}
                  />
                </div>
                <div className="flex flex-wrap gap-[4px] flex-1">
                  {Array.from({ length: cnt }).map((__, colIdx) => (
                    <div
                      key={colIdx}
                      className="size-[22px] ts-shimmer"
                      style={{ animationDelay: `${(rowIdx * 40 + colIdx * 20) % 800}ms` }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : units.length === 0 ? (
          <div className="py-12 text-center text-xs text-[#71717a] bg-[#fafaf9]">
            Chưa có đoạn đối chiếu nào. Hãy vào <strong>Bước 1</strong> bấm <strong>Đồng bộ RAGFlow</strong> để tự động tách đoạn.
          </div>
        ) : (
          <div
            style={selectedUnit ? { height: `${matrixHeight}px` } : undefined}
            className={`space-y-2.5 ${selectedUnit ? 'overflow-y-auto pr-1' : ''}`}
          >
            {Object.values(groupedUnits).map((grp) => (
              <div key={grp.doc_code} className="flex items-start gap-3">
                <div
                  className="w-24 shrink-0 pt-0.5 flex items-center gap-1.5"
                  title={grp.filename}
                >
                  <span className="font-mono text-[11px] font-medium text-[#52525b] shrink-0">
                    {grp.doc_code}
                  </span>
                  {grp.isOcr && (
                    <span
                      className="font-mono text-[9px] font-bold px-1 py-0.5 bg-amber-50 text-amber-800 border border-amber-300 leading-none shrink-0"
                      title="Tài liệu scan / tự động OCR khi chấm"
                    >
                      OCR
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-[3px]">
                  {grp.items.map((u) => {
                    const isSel = selectedUnit?.id === u.id;
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => (isSel ? setSelectedUnit(null) : selectUnit(u))}
                        aria-label={`${u.doc_code} #${u.unit_index}`}
                        className={`relative size-[22px] rounded-none border-0 transition-opacity cursor-pointer ${getTileClass(
                          u,
                          isSel
                        )}`}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        </div>

        {/* Right: Chill Editorial Thống kê lỗi Panel */}
        <div
          className="lg:col-span-5 overflow-y-auto px-5 py-4 space-y-4"
          style={{
            backgroundColor: '#f8f7f4',
            backgroundImage: 'radial-gradient(#e4e2dc 0.8px, transparent 0.8px)',
            backgroundSize: '18px 18px',
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#27272a]">
              <span className="size-6 rounded-full bg-white border border-[#e6e4de] shadow-2xs flex items-center justify-center">
                <BarChart3 className="size-3.5 text-[#52a478]" />
              </span>
              <span>Thống kê chất lượng & lỗi</span>
            </div>
            {isAutoPreview && (
              <span className="text-[11px] text-[#8a6d3b] bg-[#fdf8ed] border border-[#efe2c4] px-2.5 py-0.5 rounded-full">
                Ước tính tự động
              </span>
            )}
          </div>

          {loading && units.length === 0 ? (
            <div className="space-y-4 animate-pulse">
              <div className="bg-white border border-[#e6e4de] rounded-xl p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1.5">
                    <div className="h-3.5 w-32 bg-[#eceae4] rounded" />
                    <div className="h-2.5 w-24 bg-[#f1efe9] rounded" />
                  </div>
                  <div className="flex gap-1.5">
                    <div className="h-5 w-14 bg-[#f1efe9] rounded-full" />
                    <div className="h-5 w-12 bg-[#f1efe9] rounded-full" />
                  </div>
                </div>
                <div className="flex justify-center py-3">
                  <div className="size-36 rounded-full bg-[#f4f3ef] border border-[#eceae4]" />
                </div>
                <div className="pt-2.5 border-t border-[#efede8] flex gap-1.5">
                  <div className="h-5 w-16 bg-[#f1efe9] rounded-md" />
                  <div className="h-5 w-16 bg-[#f1efe9] rounded-md" />
                  <div className="h-5 w-16 bg-[#f1efe9] rounded-md" />
                </div>
              </div>
              <div className="bg-white border border-[#e6e4de] rounded-xl p-4 space-y-2.5">
                <div className="h-3.5 w-36 bg-[#eceae4] rounded" />
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-12 w-full bg-[#f4f3ef] rounded-lg" />
                ))}
              </div>
            </div>
          ) : units.length === 0 ? (
            <div className="text-xs text-[#71717a] py-8 text-center">Chưa có dữ liệu thống kê.</div>
          ) : (
            <>
              {/* 1. 5-Axis SVG Radar Chart Card + CER & Parsing Score */}
              {(() => {
                const total = Math.max(units.length, 1);
                const passPct = Math.round((counts.PASS / total) * 100);
                const vText = Math.max(0, Math.min(100, effectiveMetrics.textCompleteness ?? 0));
                const vFidelity = Math.max(0, Math.min(100, effectiveMetrics.contentFidelity ?? 0));
                const vTable = Math.max(0, Math.min(100, effectiveMetrics.tableAccuracy ?? 0));
                const vOrder = Math.max(0, Math.min(100, effectiveMetrics.readingOrder ?? 0));
                const vLayout = Math.max(0, Math.min(100, effectiveMetrics.layoutAccuracy ?? 0));
                const vCer = Math.max(0, Math.min(100, effectiveMetrics.charErrorRate ?? 0));
                const vScore = Math.max(0, Math.min(100, effectiveMetrics.parsingScore ?? 0));

                const cx = 160;
                const cy = 104;
                const maxR = 58;
                const angles = [-90, -18, 54, 126, 198];
                const pt = (angleDeg: number, pct: number) => {
                  const rad = (angleDeg * Math.PI) / 180;
                  const r = (pct / 100) * maxR;
                  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
                };
                const pts = [
                  pt(angles[0], vText),
                  pt(angles[1], vFidelity),
                  pt(angles[2], vTable),
                  pt(angles[3], vOrder),
                  pt(angles[4], vLayout),
                ];
                const polyPoints = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

                return (
                  <div className="bg-white border border-[#e6e4de] rounded-xl shadow-xs p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold text-[#18181b]">6 Metric Parsing · Radar 5 trục</div>
                        <div className="text-[11px] text-[#78716c]">
                          Đạt <span className="font-mono font-semibold text-[#027a42]">{passPct}%</span> ({counts.PASS}/{units.length} đoạn)
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="px-2 py-0.5 rounded-full bg-[#f2f7f4] text-[#027a42] border border-[#d6eadf]">
                          {counts.PASS} đạt
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-[#fef2f2] text-[#b91c1c] border border-[#f5d0d3]">
                          {counts.FAIL} lỗi
                        </span>
                      </div>
                    </div>

                    <div className="flex justify-center">
                      <svg viewBox="0 0 320 210" className="w-full max-w-[330px] h-auto select-none">
                        {/* Concentric pentagon grid rings */}
                        {[25, 50, 75, 100].map((lvl) => {
                          const ring = angles
                            .map((a) => pt(a, lvl))
                            .map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`)
                            .join(' ');
                          return (
                            <polygon
                              key={lvl}
                              points={ring}
                              fill="none"
                              stroke={lvl === 100 ? '#d8d5ce' : '#eceae4'}
                              strokeWidth={lvl === 100 ? 1.2 : 1}
                              strokeDasharray={lvl === 100 ? undefined : '2 2'}
                            />
                          );
                        })}
                        {/* Axis lines */}
                        {angles.map((a, idx) => {
                          const end = pt(a, 100);
                          return (
                            <line
                              key={idx}
                              x1={cx}
                              y1={cy}
                              x2={end[0].toFixed(1)}
                              y2={end[1].toFixed(1)}
                              stroke="#e6e4de"
                              strokeWidth="1"
                            />
                          );
                        })}

                        {/* Data polygon */}
                        <polygon
                          points={polyPoints}
                          fill="rgba(82, 164, 120, 0.16)"
                          stroke="#52a478"
                          strokeWidth="2"
                          strokeLinejoin="round"
                          className="transition-all duration-500 ease-out"
                        />

                        {/* Vertex dots */}
                        {pts.map((p, idx) => (
                          <circle
                            key={idx}
                            cx={p[0]}
                            cy={p[1]}
                            r="3.5"
                            fill="#ffffff"
                            stroke="#52a478"
                            strokeWidth="2"
                            className="transition-all duration-500 ease-out"
                          />
                        ))}

                        {/* Axis Labels (5 Higher-is-Better Parsing Metrics) */}
                        <text x={cx} y={16} textAnchor="middle" className="fill-[#52525b] text-[10px] font-medium">
                          Text Completeness
                        </text>
                        <text x={cx} y={28} textAnchor="middle" className="fill-[#18181b] text-[10px] font-mono font-semibold">
                          {effectiveMetrics.textCompleteness !== null ? `${vText.toFixed(0)}%` : '—'}
                        </text>

                        <text x={226} y={79} textAnchor="start" className="fill-[#52525b] text-[10px] font-medium">
                          Content Fidelity
                        </text>
                        <text x={226} y={91} textAnchor="start" className="fill-[#18181b] text-[10px] font-mono font-semibold">
                          {effectiveMetrics.contentFidelity !== null ? `${vFidelity.toFixed(0)}%` : '—'}
                        </text>

                        <text x={208} y={170} textAnchor="start" className="fill-[#52525b] text-[10px] font-medium">
                          Table Accuracy
                        </text>
                        <text x={208} y={182} textAnchor="start" className="fill-[#18181b] text-[10px] font-mono font-semibold">
                          {effectiveMetrics.tableAccuracy !== null ? `${vTable.toFixed(0)}%` : '—'}
                        </text>

                        <text x={112} y={170} textAnchor="end" className="fill-[#52525b] text-[10px] font-medium">
                          Reading Order
                        </text>
                        <text x={112} y={182} textAnchor="end" className="fill-[#18181b] text-[10px] font-mono font-semibold">
                          {effectiveMetrics.readingOrder !== null ? `${vOrder.toFixed(0)}%` : '—'}
                        </text>

                        <text x={94} y={79} textAnchor="end" className="fill-[#52525b] text-[10px] font-medium">
                          Layout &amp; Struct
                        </text>
                        <text x={94} y={91} textAnchor="end" className="fill-[#18181b] text-[10px] font-mono font-semibold">
                          {effectiveMetrics.layoutAccuracy !== null ? `${vLayout.toFixed(0)}%` : '—'}
                        </text>
                      </svg>
                    </div>

                    {/* 6th metric (Character Error Rate - lower is better) + Weighted Parsing Score */}
                    <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#efede8]">
                      <div className="px-2.5 py-2 rounded-lg bg-[#faf9f7] border border-[#eceae4] flex items-center justify-between">
                        <div>
                          <div className="text-[10px] font-medium text-[#78716c]">Character Error Rate</div>
                          <div className="text-[9.5px] text-[#a1a1aa]">Phụ lục A · càng thấp càng tốt</div>
                        </div>
                        <span
                          className={`font-mono text-xs font-semibold ${
                            vCer <= 5 ? 'text-[#027a42]' : vCer <= 15 ? 'text-[#b45309]' : 'text-[#b91c1c]'
                          }`}
                        >
                          {vCer.toFixed(1)}%
                        </span>
                      </div>
                      <div className="px-2.5 py-2 rounded-lg bg-[#f2f7f4] border border-[#d6eadf] flex items-center justify-between">
                        <div>
                          <div className="text-[10px] font-medium text-[#027a42]">Parsing Score</div>
                          <div className="text-[9.5px] text-[#52796f]">Tổng hợp 6 metric</div>
                        </div>
                        <span className="font-mono text-xs font-bold text-[#027a42]">
                          {vScore.toFixed(1)}%
                        </span>
                      </div>
                    </div>

                    {/* Compact Error Group Pills */}
                    {errorCodeBreakdown.length > 0 && (
                      <div className="pt-2.5 border-t border-[#efede8] flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-[#78716c] mr-1">Nhóm lỗi:</span>
                        {errorCodeBreakdown.map((item) => (
                          <span
                            key={item.code}
                            title={`${item.code} — ${item.name}`}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[#faf9f6] border border-[#e6e4de] text-[11px] cursor-help"
                          >
                            <span className="font-mono font-semibold text-[#18181b]">{item.code}</span>
                            <span className="font-mono text-[#b91c1c] font-medium">{item.count}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* 2. Hotspots: Top 5 Files Needing Attention (clickable to jump straight to scoring) */}
              {(() => {
                const hotspots = [...docBreakdown]
                  .filter((d) => d.fail + d.partial > 0)
                  .sort((a, b) => b.fail + b.partial - (a.fail + a.partial))
                  .slice(0, 5);
                return (
                  <div className="bg-white border border-[#e6e4de] rounded-xl shadow-xs p-4 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#18181b] inline-flex items-center gap-1.5">
                        <AlertCircle className="size-3.5 text-[#df7a80]" />
                        Điểm nóng cần chú ý
                      </span>
                      <span className="text-[11px] text-[#78716c]">Top {hotspots.length} file lỗi nhiều</span>
                    </div>

                    {hotspots.length === 0 ? (
                      <div className="text-xs text-[#027a42] bg-[#f2f7f4] rounded-lg px-3 py-2.5">
                        Tuyệt vời! Chưa phát hiện file nào có lỗi nổi bật.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {hotspots.map((d, idx) => {
                          const errCnt = d.fail + d.partial;
                          const errRate = Math.round((errCnt / Math.max(d.total, 1)) * 100);
                          const cleanName = (d.filename || '').replace(new RegExp(`^${d.doc_code}[_\\-\\s]*`, 'i'), '');
                          return (
                            <button
                              key={d.doc_code}
                              type="button"
                              onClick={() => {
                                const docUnits = units.filter((u) => u.doc_code === d.doc_code);
                                const target =
                                  docUnits.find((u) => getUnitEffectiveState(u) !== 'PASS') || docUnits[0];
                                if (target) {
                                  selectUnit(target);
                                  setIsFullscreen(true);
                                }
                              }}
                              className="w-full text-left group p-2.5 rounded-lg border border-[#efede8] bg-[#fcfcfa] hover:bg-white hover:border-[#d4d4d8] transition-all flex items-center justify-between gap-3"
                            >
                              <div className="min-w-0 flex items-center gap-2.5">
                                <span className="size-5 rounded-full bg-[#fef2f2] text-[#b91c1c] font-mono text-[10px] font-bold flex items-center justify-center shrink-0">
                                  {idx + 1}
                                </span>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-mono text-xs font-semibold text-[#18181b]">
                                      {d.doc_code}
                                    </span>
                                    <span className="text-[11px] text-[#78716c] truncate">{cleanName}</span>
                                  </div>
                                  <div className="text-[10px] text-[#78716c] mt-0.5">
                                    Lỗi <strong className="font-mono text-[#b91c1c]">{errCnt}/{d.total}</strong> đoạn ({errRate}%)
                                  </div>
                                </div>
                              </div>
                              <span className="text-[11px] font-medium text-[#78716c] group-hover:text-[#18181b] inline-flex items-center gap-0.5 shrink-0 transition-colors">
                                Chấm <ArrowRight className="size-3" />
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </>
          )}
        </div>
      </div>
      )}

      {/* Fullscreen Scoring Mode — opened via "Chế độ chấm" button or clicking a square */}
      {selectedUnit && (
        <div className="fixed inset-0 z-30 flex flex-col bg-[#fefefe]">
          <div className="px-5 py-2 border-b border-[#ededeb] bg-[#fafaf9] flex items-center justify-between text-xs shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="inline-flex items-center border border-[#e4e4e2] bg-white">
                <button
                  onClick={() => stepUnit(-1)}
                  disabled={selectedIdx <= 0}
                  className="p-1 text-[#52525b] hover:bg-[#f4f4f2] disabled:opacity-30"
                  title="Đoạn trước (←)"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
                <span className="px-2 font-mono text-[11px] text-[#18181b] border-x border-[#e4e4e2]">
                  {selectedIdx + 1}/{filteredUnits.length}
                </span>
                <button
                  onClick={() => stepUnit(1)}
                  disabled={selectedIdx < 0 || selectedIdx >= filteredUnits.length - 1}
                  className="p-1 text-[#52525b] hover:bg-[#f4f4f2] disabled:opacity-30"
                  title="Đoạn sau (→)"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </div>
              <span className="font-mono font-semibold text-[#18181b]">
                {selectedUnit.doc_code} · #{selectedUnit.unit_index}
              </span>
              <span className="ts-tag-neutral">Trang {selectedUnit.page_num}</span>
              <span className="ts-tag-neutral">
                {selectedUnit.unit_type === 'table'
                  ? 'Bảng biểu'
                  : selectedUnit.unit_type === 'image'
                  ? 'Sơ đồ / Ảnh'
                  : 'Văn bản'}
              </span>
              <span className={`text-[11px] font-medium px-2 py-0.5 border ${badge(selectedUnit.verdict).cls}`}>
                {badge(selectedUnit.verdict).text}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setIsFullscreen(false);
                  setSelectedUnit(null);
                }}
                className="inline-flex items-center gap-1 text-xs text-[#52525b] hover:text-[#18181b] px-2.5 py-1 rounded-md border border-[#e4e4e2] bg-white hover:bg-[#f4f4f2]"
                title="Đóng (Esc)"
              >
                <X className="size-3.5" /> Đóng
              </button>
            </div>
          </div>

          <div className="flex-1 flex min-h-0 overflow-hidden">
          <div className="flex-1 grid grid-cols-2 min-h-0 divide-x divide-[#e8e8e6] overflow-hidden">
            {/* Original */}
            <div className="p-5 overflow-y-auto space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="ts-eyebrow">ĐOẠN TRÍCH GỐC</div>
                {selectedUnit.has_local_file && /\.(pdf|png|jpe?g|webp|bmp)$/i.test(selectedUnit.filename) && (
                  <button
                    type="button"
                    onClick={handleVisionOcr}
                    disabled={ocrRunning}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium bg-[#f2fbf6] text-[#027a42] border border-[#03aa5c]/35 hover:bg-[#03aa5c] hover:text-white transition-colors disabled:opacity-45"
                    title="Dùng Vision LLM (trong Cài đặt) để đọc chữ từ ảnh trang PDF làm bản chuẩn"
                  >
                    {ocrRunning ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                    {ocrRunning ? 'Đang OCR...' : 'OCR bản chuẩn (Vision LLM)'}
                  </button>
                )}
              </div>
              <div className="bg-[#fafaf9] border border-[#ededeb] p-4 text-[13.5px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty">
                {selectedUnit.unit_type === 'table'
                  ? renderPipeTable(selectedUnit.source_text)
                  : selectedUnit.source_text}
              </div>
              {selectedUnit.has_local_file && selectedUnit.filename.toLowerCase().endsWith('.pdf') && (
                <img
                  src={`/api/parsing/documents/${selectedUnit.document_id}/page/${selectedUnit.page_num}`}
                  alt="Trang PDF gốc"
                  className="w-full border border-[#ededeb]"
                />
              )}
            </div>

            {/* Parsed */}
            <div className="p-5 overflow-y-auto space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="ts-eyebrow">ĐOẠN SO SÁNH & KẾT QUẢ</span>
              </div>

              {(selectedUnit.verdict !== 'UNRATED' || selectedUnit.notes) && (
                <div
                  className={`p-3 border text-xs space-y-1.5 ${
                    selectedUnit.verdict === 'PASS'
                      ? 'bg-[#f2fbf6] border-[#03aa5c]/35 text-[#027a42]'
                      : 'bg-[#fef2f2] border-[#f5d0d3] text-[#991b1b]'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[10px] font-bold uppercase px-1.5 py-0.5 bg-white border border-current/20">
                      {selectedUnit.verdict === 'PASS' ? 'ĐẠT' : 'KHÔNG ĐẠT'}
                    </span>
                    {(selectedUnit.error_codes || []).map((code) => (
                      <span
                        key={code}
                        className="font-mono text-[10px] font-semibold px-1.5 py-0.5 bg-[#161616] text-white"
                      >
                        {code}
                      </span>
                    ))}
                    {selectedUnit.char_error === 1 && (
                      <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 bg-amber-100 text-amber-800 border border-amber-300">
                        LỖI KÝ TỰ
                      </span>
                    )}
                    {selectedUnit.fidelity_error === 1 && (
                      <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 bg-rose-100 text-rose-800 border border-rose-300">
                        SAI NGHĨA / SỐ LIỆU
                      </span>
                    )}
                  </div>
                  {selectedUnit.notes && (
                    <div className="text-[13px] leading-relaxed text-[#161616] font-normal">
                      {selectedUnit.notes}
                    </div>
                  )}
                </div>
              )}

              {selectedUnit.matched_chunks.map((ch) => {
                const aln = ch.alignment;
                const sim = aln ? aln.text_similarity : 0;
                const simCls =
                  sim >= 98
                    ? 'text-[#15803d] bg-[#f0fdf4] border-[#bbf7d0]'
                    : sim >= 75
                    ? 'text-[#b45309] bg-[#fffbeb] border-[#fde68a]'
                    : 'text-[#b91c1c] bg-[#fef2f2] border-[#fecaca]';
                const targetText = showFullChunk || !aln?.matched_excerpt ? ch.content : aln.matched_excerpt;

                return (
                  <div key={ch.ragflow_chunk_id} className="bg-[#fafaf9] border border-[#ededeb] p-4 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[#78716c]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>
                          Chunk #{ch.chunk_index}
                          {aln?.stitched_with_chunk_index ? ` + #${aln.stitched_with_chunk_index}` : ''}
                        </span>
                        {aln?.stitched_with_chunk_index && (
                          <span className="px-1.5 py-0.5 bg-[#f4f4f2] text-[#3f3f46] border border-[#e4e4e2] font-sans">
                            Nối 2 chunk
                          </span>
                        )}
                        {aln && (
                          <span className={`px-1.5 py-0.5 border font-sans font-medium ${simCls}`}>
                            {sim.toFixed(1)}%
                          </span>
                        )}
                      </div>
                      <span>{ch.char_count} ký tự</span>
                    </div>
                    {aln?.risk_flags && aln.risk_flags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {aln.risk_flags.map((rf, idx) => (
                          <span
                            key={idx}
                            className={`text-[11px] px-2 py-0.5 border ${
                              rf.severity === 'Nghiêm trọng'
                                ? 'bg-[#fef2f2] text-[#b91c1c] border-[#fecaca]'
                                : 'bg-[#fffbeb] text-[#b45309] border-[#fde68a]'
                            }`}
                          >
                            {rf.label}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="text-[13.5px] text-[#18181b] leading-relaxed whitespace-pre-wrap text-pretty">
                      {showDiff && !showFullChunk
                        ? renderDiffText(selectedUnit.source_text, targetText)
                        : selectedUnit.unit_type === 'table'
                        ? renderPipeTable(targetText)
                        : targetText}
                    </div>
                  </div>
                );
              })}
              {selectedUnit.matched_chunks.length === 0 && (
                <div className="bg-[#fef2f2] border border-[#fecaca] p-4 text-[13px] text-[#991b1b]">
                  Không tìm thấy đoạn nào khớp sau khi đọc file (có thể bị mất đoạn hoặc ảnh không OCR được).
                </div>
              )}
            </div>
          </div>

          {/* Dedicated Right Sidebar: Navigation List (fills height) + Display Options + Pinned Scoring */}
          <aside className="w-[300px] shrink-0 border-l border-[#e4e4e2] bg-[#fafaf9] flex flex-col min-h-0 overflow-hidden divide-y divide-[#e8e8e6]">
            {/* 1. Document Selector & Scrollable Unit List */}
            {(() => {
              const groupsList = Object.values(groupedUnits);
              const activeDocCode = selectedUnit?.doc_code || groupsList[0]?.doc_code || '';
              const activeGroup = groupsList.find((g) => g.doc_code === activeDocCode) || groupsList[0];
              return (
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                  <div className="p-3.5 pb-2.5 space-y-2 shrink-0">
                    <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-[#52525b]">
                      <span>
                        Danh sách{' '}
                        <span className="font-mono font-normal text-[#71717a]">
                          ({units.filter((u) => u.verdict !== 'UNRATED').length}/{units.length})
                        </span>
                      </span>
                      <div className="inline-flex items-center rounded-[2px] border border-[#e4e4e2] bg-white p-0.5">
                        <button
                          type="button"
                          onClick={() => setSidebarViewMode('grid')}
                          title="Hiển thị dạng ô vuông"
                          className={`p-1 rounded-[2px] transition-colors ${
                            sidebarViewMode === 'grid'
                              ? 'bg-[#18181b] text-white'
                              : 'text-[#71717a] hover:text-[#18181b]'
                          }`}
                        >
                          <LayoutGrid className="size-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setSidebarViewMode('list')}
                          title="Hiển thị dạng danh sách"
                          className={`p-1 rounded-[2px] transition-colors ${
                            sidebarViewMode === 'list'
                              ? 'bg-[#18181b] text-white'
                              : 'text-[#71717a] hover:text-[#18181b]'
                          }`}
                        >
                          <List className="size-3" />
                        </button>
                      </div>
                    </div>
                    <select
                      className="w-full py-1.5 px-2 text-[11px] font-medium bg-white border border-[#e4e4e2] rounded-[3px] text-[#18181b] focus:outline-none focus:border-[#18181b]"
                      value={activeGroup?.doc_code || ''}
                      title={activeGroup?.filename || ''}
                      onChange={(e) => {
                        const target = groupsList.find((g) => g.doc_code === e.target.value);
                        if (target && target.items.length > 0) {
                          selectUnit(target.items[0]);
                        }
                      }}
                    >
                      {groupsList.map((grp) => {
                        const doneCnt = grp.items.filter((u) => u.verdict !== 'UNRATED').length;
                        const cleanName = (grp.filename || '').replace(new RegExp(`^${grp.doc_code}[_\\-\\s]*`, 'i'), '');
                        return (
                          <option key={grp.doc_code} value={grp.doc_code}>
                            {grp.doc_code} ({doneCnt}/{grp.items.length}) · {cleanName}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  {activeGroup && sidebarViewMode === 'grid' && (
                    <div className="flex-1 overflow-y-auto px-3.5 pb-3.5">
                      <div className="flex flex-wrap gap-[4px]">
                        {activeGroup.items.map((u) => {
                          const isSel = selectedUnit?.id === u.id;
                          return (
                            <button
                              key={u.id}
                              type="button"
                              onClick={() => selectUnit(u)}
                              aria-label={`${u.doc_code} #${u.unit_index}`}
                              title={`${u.doc_code} #${u.unit_index} · Trang ${u.page_num}`}
                              className={`size-[20px] rounded-none border-0 transition-opacity cursor-pointer ${getTileClass(
                                u,
                                isSel
                              )}`}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {activeGroup && sidebarViewMode === 'list' && (
                    <div className="flex-1 overflow-y-auto px-2.5 pb-2.5 space-y-1">
                      {activeGroup.items.map((u) => {
                        const isSel = selectedUnit?.id === u.id;
                        const eff = getUnitEffectiveState(u);
                        const dotCls =
                          eff === 'PASS'
                            ? 'bg-[#4ea874]'
                            : eff === 'FAIL'
                            ? 'bg-[#df7a80]'
                            : 'bg-[#d4d4d8]';
                        const sim = u.matched_chunks?.[0]?.alignment?.text_similarity;
                        const preview = (u.title || u.source_text || '').replace(/\s+/g, ' ').trim();
                        return (
                          <button
                            key={u.id}
                            type="button"
                            onClick={() => selectUnit(u)}
                            className={`w-full text-left px-2.5 py-2 rounded-md border transition-colors flex items-start gap-2 ${
                              isSel
                                ? 'bg-white border-[#18181b] shadow-2xs'
                                : 'bg-transparent border-transparent hover:bg-white/80 hover:border-[#e4e4e2]'
                            }`}
                          >
                            <span className={`size-2 rounded-full mt-1.5 shrink-0 ${dotCls}`} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-1.5">
                                <span className="font-mono text-[11px] font-semibold text-[#18181b]">
                                  #{u.unit_index}{' '}
                                  <span className="font-normal text-[#71717a]">· tr.{u.page_num}</span>
                                </span>
                                {sim !== undefined && (
                                  <span className="font-mono text-[10px] text-[#71717a] tabular-nums">
                                    {sim.toFixed(0)}%
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-[#52525b] truncate mt-0.5">
                                {preview || '(Không có văn bản)'}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* 2. Display Options */}
            <div className="p-3.5 space-y-2 shrink-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[#52525b]">
                Tùy chọn hiển thị
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-[#3f3f46]">
                <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-white border border-[#e4e4e2] cursor-pointer select-none hover:border-[#d4d4d8]">
                  <input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} />
                  <span>So sánh Diff</span>
                </label>
                <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-white border border-[#e4e4e2] cursor-pointer select-none hover:border-[#d4d4d8]">
                  <input type="checkbox" checked={showFullChunk} onChange={(e) => setShowFullChunk(e.target.checked)} />
                  <span>Xem cả chunk</span>
                </label>
              </div>
            </div>

            {/* 3. Pinned Scoring Controls */}
            <div className="p-3.5 space-y-2.5 shrink-0 bg-white">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#52525b]">
                  Chấm điểm
                </span>
                {scoring && <Loader2 className="size-3.5 animate-spin text-[#4ea874]" />}
              </div>

              <div className="space-y-2">
                <button
                  onClick={() => handleScore('PASS')}
                  disabled={scoring}
                  className={`w-full flex items-center justify-between px-3.5 py-2 rounded-md text-xs font-medium border disabled:opacity-45 disabled:cursor-not-allowed transition-colors ${
                    selectedUnit.verdict === 'PASS'
                      ? 'bg-[#ecfdf5] border-[#4ea874] text-[#027a42]'
                      : 'bg-white hover:bg-[#f0fdf4] text-[#18181b] border-[#d4d4d8]'
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    <span className="size-2 rounded-full bg-[#4ea874] inline-block" />
                    Đạt
                  </span>
                  <span className="font-mono text-[10px] text-[#71717a]">1</span>
                </button>
                <button
                  onClick={() => {
                    if (showErrPopover) handleScore('FAIL');
                    else setShowErrPopover(true);
                  }}
                  disabled={scoring}
                  className={`w-full flex items-center justify-between px-3.5 py-2 rounded-md text-xs font-medium border disabled:opacity-45 disabled:cursor-not-allowed transition-colors ${
                    showErrPopover || selectedUnit.verdict === 'FAIL' || selectedUnit.verdict === 'PARTIAL'
                      ? 'bg-[#fef2f2] border-[#df7a80] text-[#b91c1c]'
                      : 'bg-white hover:bg-[#fef2f2] text-[#18181b] border-[#d4d4d8]'
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    <span className="size-2 rounded-full bg-[#df7a80] inline-block" />
                    {showErrPopover ? 'Xác nhận Không đạt' : 'Không đạt'}
                  </span>
                  <span className="font-mono text-[10px] text-[#71717a]">{showErrPopover ? 'Enter' : '2'}</span>
                </button>
              </div>

              {showErrPopover && (
                <div className="pt-3 border-t border-[#e8e8e6] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#3f3f46]">
                      Chọn mã lỗi ({errCodes.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowErrPopover(false)}
                      className="text-xs text-[#71717a] hover:text-[#18181b]"
                    >
                      Đóng
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { code: 'TEXT', name: 'Thiếu chữ / sai số liệu / lỗi OCR' },
                      { code: 'TABLE', name: 'Vỡ bảng / lệch hàng cột' },
                      { code: 'ORDER', name: 'Sai thứ tự đọc / đảo cột' },
                      { code: 'LAYOUT', name: 'Mất heading / danh sách / ảnh' },
                    ].map((ec) => {
                      const active = errCodes.includes(ec.code);
                      return (
                        <button
                          key={ec.code}
                          type="button"
                          disabled={scoring}
                          onClick={() => toggleCode(ec.code)}
                          title={`${ec.code} · ${ec.name}`}
                          className={`font-mono text-[11px] px-2.5 py-1 rounded-md border transition-colors disabled:opacity-45 ${
                            active
                              ? 'bg-[#18181b] text-white border-[#18181b] font-semibold'
                              : 'bg-white text-[#52525b] border-[#e4e4e2] hover:border-[#18181b]'
                          }`}
                        >
                          {ec.code}
                        </button>
                      );
                    })}
                  </div>
                  <input
                    className="ts-input w-full py-1.5 text-xs rounded-md bg-white"
                    placeholder="Ghi chú ngắn..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs text-[#52525b] cursor-pointer select-none">
                      <input type="checkbox" checked={charErr} onChange={(e) => setCharErr(e.target.checked)} />
                      Lỗi ký tự
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-[#52525b] cursor-pointer select-none">
                      <input type="checkbox" checked={fidErr} onChange={(e) => setFidErr(e.target.checked)} />
                      Sai nghĩa / số liệu
                    </label>
                  </div>
                </div>
              )}
            </div>
          </aside>
          </div>
        </div>
      )}

      {/* Modal: Add Unit */}
      {showAdd && (
        <div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4">
          <form onSubmit={handleAddUnit} className="bg-white border border-[#e4e4e2] w-full max-w-lg p-6 space-y-4 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#18181b]">Thêm đoạn gốc để đối chiếu</h2>
              <button type="button" onClick={() => setShowAdd(false)} aria-label="Đóng">
                <X className="size-4 text-[#71717a]" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[#52525b] mb-1">Loại nội dung</label>
                <select className="ts-input w-full" value={newType} onChange={(e) => setNewType(e.target.value)}>
                  <option value="text">Đoạn văn bản</option>
                  <option value="table">Bảng biểu</option>
                  <option value="image">Sơ đồ / Ảnh (Layout)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#52525b] mb-1">Số trang</label>
                <input type="number" className="ts-input w-full font-mono" value={newPage} onChange={(e) => setNewPage(Number(e.target.value))} />
              </div>
            </div>
            <div>
              <label className="block text-xs text-[#52525b] mb-1">Tiêu đề ngắn</label>
              <input className="ts-input w-full" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-[#52525b] mb-1">Nội dung chuẩn trích từ tài liệu gốc</label>
              <textarea rows={4} className="ts-input w-full" value={newText} onChange={(e) => setNewText(e.target.value)} required />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#ededeb]">
              <button type="button" onClick={() => setShowAdd(false)} className="ts-btn-secondary">Hủy</button>
              <button type="submit" className="ts-btn-primary">Lưu & Tìm đoạn khớp</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
