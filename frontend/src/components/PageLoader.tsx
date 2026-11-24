import React, { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';

interface Props {
  /** Increment to replay the loader as a page transition curtain */
  transitionKey?: number;
  /** Called while the loader curtain is fully opaque so the target page swaps cleanly underneath */
  onMidpoint?: () => void;
  /** Called when the transition finishes */
  onComplete?: () => void;
}

export const PageLoader: React.FC<Props> = ({ transitionKey = 0, onMidpoint, onComplete }) => {
  const isTransition = transitionKey > 0;
  const [visible, setVisible] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const onMidpointRef = useRef(onMidpoint);
  const onCompleteRef = useRef(onComplete);
  onMidpointRef.current = onMidpoint;
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (transitionKey > 0) {
      if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        onMidpointRef.current?.();
        onCompleteRef.current?.();
        return;
      }
      setVisible(true);
    }
  }, [transitionKey]);

  useEffect(() => {
    if (!visible || !rootRef.current) return;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        onComplete: () => {
          setVisible(false);
          onCompleteRef.current?.();
        },
      });

      if (isTransition) {
        // Transition mode: gradual smooth curtain fade-in (~0.48s), full logo scan (~2.3s total), swap page behind curtain, then lift out
        tl.fromTo(
          rootRef.current,
          { opacity: 0, y: 0 },
          { opacity: 1, duration: 0.48, ease: 'power2.inOut' }
        )
          .fromTo(
            '.loader-bracket',
            { opacity: 0, scale: 0.8, transformOrigin: 'center center' },
            { opacity: 1, scale: 1, duration: 0.42, ease: 'power3.out' },
            '-=0.12'
          )
          .fromTo(
            '.loader-bar',
            { scaleX: 0, transformOrigin: 'left center' },
            { scaleX: 1, duration: 0.36, stagger: 0.11, ease: 'power3.out' },
            '-=0.18'
          )
          .fromTo(
            '.loader-dot',
            { scale: 0, opacity: 0, transformOrigin: 'center center' },
            { scale: 1, opacity: 1, duration: 0.24, ease: 'back.out(2)' },
            '-=0.14'
          )
          .fromTo(
            '.loader-wordmark',
            { opacity: 0, y: 6 },
            { opacity: 1, y: 0, duration: 0.32, ease: 'power2.out' },
            '-=0.20'
          )
          .fromTo(
            '.loader-hairline',
            { scaleX: 0, transformOrigin: 'left center' },
            { scaleX: 1, duration: 0.65, ease: 'expo.inOut' },
            '-=0.22'
          )
          .call(() => {
            onMidpointRef.current?.();
          })
          .to(
            rootRef.current,
            { opacity: 0, y: -10, duration: 0.38, ease: 'power2.inOut' },
            '+=0.2'
          );
      } else {
        // Initial reload boot mode (~2.0s)
        tl.fromTo(
          '.loader-bracket',
          { opacity: 0, scale: 0.8, transformOrigin: 'center center' },
          { opacity: 1, scale: 1, duration: 0.45, ease: 'power3.out' }
        )
          .fromTo(
            '.loader-bar',
            { scaleX: 0, transformOrigin: 'left center' },
            { scaleX: 1, duration: 0.38, stagger: 0.12, ease: 'power3.out' },
            '-=0.18'
          )
          .fromTo(
            '.loader-dot',
            { scale: 0, opacity: 0, transformOrigin: 'center center' },
            { scale: 1, opacity: 1, duration: 0.25, ease: 'back.out(2)' },
            '-=0.15'
          )
          .fromTo(
            '.loader-wordmark',
            { opacity: 0, y: 6 },
            { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out' },
            '-=0.22'
          )
          .fromTo(
            '.loader-hairline',
            { scaleX: 0, transformOrigin: 'left center' },
            { scaleX: 1, duration: 0.65, ease: 'expo.inOut' },
            '-=0.25'
          )
          .to(
            rootRef.current,
            { opacity: 0, y: -10, duration: 0.35, ease: 'power2.inOut' },
            '+=0.2'
          );
      }
    }, rootRef);

    return () => ctx.revert();
  }, [visible, transitionKey, isTransition]);

  if (!visible) return null;

  return (
    <div
      ref={rootRef}
      style={{ opacity: isTransition ? 0 : 1 }}
      className="fixed inset-0 z-[100] bg-[#fefefe] flex flex-col items-center justify-center gap-3.5 select-none pointer-events-none overflow-hidden"
      aria-hidden="true"
    >
      {/* Architectural wallpaper backdrop seamlessly matching Homepage (richer opacity during load) */}
      <div
        className="absolute inset-0 bg-no-repeat bg-bottom bg-cover opacity-[0.65]"
        style={{
          backgroundImage: 'url(/homepage-bg.png?v=2)',
          maskImage: 'linear-gradient(to top, rgba(0,0,0,1) 60%, rgba(0,0,0,0.65) 90%, rgba(0,0,0,0.25) 100%)',
          WebkitMaskImage: 'linear-gradient(to top, rgba(0,0,0,1) 60%, rgba(0,0,0,0.65) 90%, rgba(0,0,0,0.25) 100%)',
        }}
      />
      {/* Soft radial halo so the hero logo pops crisply off the wallpaper */}
      <div
        className="relative z-10 flex flex-col items-center justify-center gap-4 px-16 py-12"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(254,254,254,0.96) 0%, rgba(254,254,254,0.82) 52%, rgba(254,254,254,0) 78%)',
        }}
      >
        <div className="flex items-center gap-4">
          <svg viewBox="0 0 32 32" className="size-14 shrink-0" fill="none">
            <path
              className="loader-bracket"
              d="M4.5 11V5.5C4.5 4.95 4.95 4.5 5.5 4.5H11"
              stroke="#141414"
              strokeWidth="2.2"
              strokeLinecap="square"
            />
            <path
              className="loader-bracket"
              d="M27.5 21V26.5C27.5 27.05 27.05 27.5 26.5 27.5H21"
              stroke="#141414"
              strokeWidth="2.2"
              strokeLinecap="square"
            />
            <rect className="loader-bar" x="8" y="9" width="11.5" height="2.6" rx="0.6" fill="#141414" />
            <rect className="loader-bar" x="21.5" y="9" width="2.5" height="2.6" rx="0.6" fill="#141414" opacity="0.35" />
            <rect className="loader-bar" x="8" y="14.7" width="16" height="2.8" rx="0.6" fill="#03aa5c" />
            <rect className="loader-bar" x="12.5" y="20.4" width="11.5" height="2.6" rx="0.6" fill="#141414" />
            <circle className="loader-dot" cx="9.3" cy="21.7" r="1.4" fill="#03aa5c" />
          </svg>
          <span className="loader-wordmark font-mono text-[22px] font-bold tracking-[0.2em] text-[#141414]">
            RAGFLOW<span className="text-[#027a42] ml-2 font-semibold">QC</span>
          </span>
        </div>
        <div className="w-56 h-[2px] bg-[#e5e7eb] overflow-hidden">
          <div className="loader-hairline w-full h-full bg-[#03aa5c]" />
        </div>
      </div>
    </div>
  );
};
