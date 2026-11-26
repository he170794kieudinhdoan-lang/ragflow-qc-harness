import React, { useCallback, useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { api, runWithProgressTask } from '../api/client';

export interface ProgressOverlayState {
  active: boolean;
  title: string;
  subtitle?: string;
  percent: number;
  current: number;
  total: number;
  hasRealProgress: boolean;
  elapsedSec: number;
  completed?: boolean;
}

export interface TrackedOperationOptions {
  title: string;
  subtitle?: string;
  estimatedMs?: number;
}

const INITIAL_STATE: ProgressOverlayState = {
  active: false,
  title: '',
  subtitle: '',
  percent: 0,
  current: 0,
  total: 0,
  hasRealProgress: false,
  elapsedSec: 0,
  completed: false,
};

/**
 * Hybrid progress hook:
 * - Attaches `X-Progress-Task-Id` to the wrapped API call
 * - Polls GET /api/progress/{task_id} for exact backend current/total %
 * - Smoothly estimates progress (0 -> 92%) for fast endpoints without loop counters
 */
export function useProgressTask() {
  const [state, setState] = useState<ProgressOverlayState>(INITIAL_STATE);
  const activeIdRef = useRef<string | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const tickTimerRef = useRef<number | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (tickTimerRef.current !== null) {
      window.clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      activeIdRef.current = null;
      clearTimers();
    };
  }, [clearTimers]);

  const runTracked = useCallback(
    async <T,>(opts: TrackedOperationOptions, fn: () => Promise<T>): Promise<T> => {
      clearTimers();

      const taskId = `pt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      activeIdRef.current = taskId;
      const startedAt = Date.now();
      const estMs = Math.max(2500, opts.estimatedMs ?? 14000);

      setState({
        active: true,
        title: opts.title,
        subtitle: opts.subtitle || '',
        percent: 4,
        current: 0,
        total: 0,
        hasRealProgress: false,
        elapsedSec: 0,
        completed: false,
      });

      let stopped = false;
      let pollBusy = false;

      tickTimerRef.current = window.setInterval(() => {
        if (stopped || activeIdRef.current !== taskId) return;
        const elapsedMs = Date.now() - startedAt;
        const elapsedSec = Math.floor(elapsedMs / 1000);
        setState((prev) => {
          if (!prev.active || prev.completed) return prev;
          if (prev.hasRealProgress) {
            return prev.elapsedSec === elapsedSec ? prev : { ...prev, elapsedSec };
          }
          const ratio = 1 - Math.exp(-elapsedMs / (estMs * 0.65));
          const smartPct = Math.min(92, Math.max(prev.percent, Math.round(4 + ratio * 88)));
          if (smartPct === prev.percent && elapsedSec === prev.elapsedSec) return prev;
          return { ...prev, percent: smartPct, elapsedSec };
        });
      }, 220);

      pollTimerRef.current = window.setInterval(async () => {
        if (stopped || pollBusy || activeIdRef.current !== taskId) return;
        pollBusy = true;
        try {
          const p = await api.getTaskProgress(taskId);
          if (stopped || activeIdRef.current !== taskId || !p?.found) return;
          setState((prev) => {
            if (!prev.active || prev.completed) return prev;
            const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
            if (p.has_real_progress && p.total > 0) {
              return {
                ...prev,
                title: p.stage || prev.title,
                current: p.current,
                total: p.total,
                percent: Math.min(99, Math.max(2, p.percent)),
                hasRealProgress: true,
                elapsedSec,
              };
            }
            if (p.stage) {
              return { ...prev, title: p.stage, elapsedSec };
            }
            return prev;
          });
        } catch {
          // Ignore transient poll errors
        } finally {
          pollBusy = false;
        }
      }, 420);

      try {
        const result = await runWithProgressTask(taskId, fn);
        stopped = true;
        clearTimers();
        if (activeIdRef.current === taskId) {
          setState((prev) => ({
            ...prev,
            percent: 100,
            current: prev.total > 0 ? prev.total : prev.current,
            completed: true,
            elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
          }));
          closeTimerRef.current = window.setTimeout(() => {
            if (activeIdRef.current === taskId) {
              activeIdRef.current = null;
              setState(INITIAL_STATE);
            }
          }, 260);
        }
        return result;
      } catch (err) {
        stopped = true;
        clearTimers();
        if (activeIdRef.current === taskId) {
          activeIdRef.current = null;
          setState(INITIAL_STATE);
        }
        throw err;
      }
    },
    [clearTimers]
  );

  return { progress: state, runTracked };
}

interface FloatingProgressOverlayProps {
  state: ProgressOverlayState;
  fallback?: { title: string; subtitle?: string } | null;
  moduleLabel?: string;
}

export const FloatingProgressOverlay: React.FC<FloatingProgressOverlayProps> = ({
  state,
  fallback = null,
}) => {
  const [fbPct, setFbPct] = useState(6);
  const [displayPct, setDisplayPct] = useState(0);

  const backdropRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const barFillRef = useRef<SVGRectElement>(null);
  const pctTweenObj = useRef({ val: 0 });

  const showFallback = !state.active && Boolean(fallback);
  const visible = state.active || showFallback;

  useEffect(() => {
    if (!showFallback) {
      setFbPct(6);
      return;
    }
    const t0 = Date.now();
    const id = window.setInterval(() => {
      const ms = Date.now() - t0;
      const ratio = 1 - Math.exp(-ms / 3200);
      setFbPct(Math.min(90, Math.round(6 + ratio * 84)));
    }, 180);
    return () => window.clearInterval(id);
  }, [showFallback, fallback?.title]);

  const targetPercent = state.active ? state.percent : fbPct;
  const isDone = state.active && Boolean(state.completed);

  // GSAP entrance + continuous refined SVG mark scan motion
  useEffect(() => {
    if (!visible) {
      pctTweenObj.current.val = 0;
      setDisplayPct(0);
      return;
    }
    const ctx = gsap.context(() => {
      if (backdropRef.current) {
        gsap.fromTo(backdropRef.current, { opacity: 0 }, { opacity: 1, duration: 0.2, ease: 'power2.out' });
      }
      if (cardRef.current) {
        gsap.fromTo(
          cardRef.current,
          { opacity: 0, y: 8, scale: 0.97 },
          { opacity: 1, y: 0, scale: 1, duration: 0.28, ease: 'power3.out' }
        );
      }
      if (svgRef.current) {
        const bars = svgRef.current.querySelectorAll('.fp-bar');
        gsap.fromTo(
          bars,
          { scaleX: 0.35, opacity: 0.45, transformOrigin: 'left center' },
          {
            scaleX: 1,
            opacity: 1,
            duration: 0.55,
            stagger: { each: 0.14, repeat: -1, yoyo: true },
            ease: 'sine.inOut',
          }
        );
        const dot = svgRef.current.querySelector('.fp-dot');
        if (dot) {
          gsap.to(dot, {
            scale: 1.35,
            opacity: 0.55,
            transformOrigin: 'center center',
            duration: 0.7,
            repeat: -1,
            yoyo: true,
            ease: 'sine.inOut',
          });
        }
      }
    });
    return () => ctx.revert();
  }, [visible]);

  // GSAP smooth percentage counter + SVG progress hairline bar (killed cleanly on update/unmount)
  useEffect(() => {
    if (!visible) return;
    const t1 = gsap.to(pctTweenObj.current, {
      val: targetPercent,
      duration: 0.35,
      ease: 'power2.out',
      onUpdate: () => {
        setDisplayPct(Math.round(pctTweenObj.current.val));
      },
    });
    const t2 = barFillRef.current
      ? gsap.to(barFillRef.current, {
          attr: { width: Math.max(0, Math.min(100, targetPercent)) },
          duration: 0.38,
          ease: 'power2.out',
        })
      : null;
    return () => {
      t1.kill();
      t2?.kill();
    };
  }, [visible, targetPercent]);

  if (!visible) return null;

  const title = state.active ? state.title : fallback!.title;
  const hasReal = state.active && state.hasRealProgress && state.total > 0;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[75] flex items-center justify-center p-4 bg-white/45 backdrop-blur-[2px]"
      role="status"
      aria-live="polite"
    >
      <div
        ref={cardRef}
        className="w-[296px] rounded-lg bg-white/95 border border-[#e4e4e7] shadow-[0_12px_32px_-8px_rgba(20,20,20,0.10)] px-4 py-3.5"
      >
        {/* Single compact row: animated brand SVG + concise title + tabular % */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <svg
              ref={svgRef}
              viewBox="0 0 32 32"
              className="size-6 shrink-0"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4.5 11V5.5C4.5 4.95 4.95 4.5 5.5 4.5H11"
                stroke="#141414"
                strokeWidth="2.2"
                strokeLinecap="square"
              />
              <path
                d="M27.5 21V26.5C27.5 27.05 27.05 27.5 26.5 27.5H21"
                stroke="#141414"
                strokeWidth="2.2"
                strokeLinecap="square"
              />
              <rect className="fp-bar" x="8" y="9" width="11.5" height="2.6" rx="0.6" fill="#141414" />
              <rect className="fp-bar" x="8" y="14.7" width="16" height="2.8" rx="0.6" fill="#03aa5c" />
              <rect className="fp-bar" x="12.5" y="20.4" width="11.5" height="2.6" rx="0.6" fill="#141414" />
              <circle className="fp-dot" cx="9.3" cy="21.7" r="1.5" fill="#03aa5c" />
            </svg>

            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-[#141414] truncate leading-tight">
                {isDone ? 'Hoàn tất' : title}
              </div>
              {hasReal && (
                <div className="text-[11px] font-mono text-[#71717a] tabular-nums mt-0.5 leading-none">
                  {state.current}/{state.total}
                </div>
              )}
            </div>
          </div>

          <span className="shrink-0 font-mono text-[13px] font-semibold text-[#141414] tabular-nums">
            {displayPct}%
          </span>
        </div>

        {/* Crisp 2px SVG progress hairline */}
        <svg
          viewBox="0 0 100 2"
          preserveAspectRatio="none"
          className="w-full h-[2.5px] mt-3 rounded-full overflow-hidden block"
          aria-hidden="true"
        >
          <rect x="0" y="0" width="100" height="2" fill="#ededeb" />
          <rect ref={barFillRef} x="0" y="0" width="0" height="2" fill="#03aa5c" />
        </svg>
      </div>
    </div>
  );
};
