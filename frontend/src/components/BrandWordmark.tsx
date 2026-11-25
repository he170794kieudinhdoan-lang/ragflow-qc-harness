import React, { useEffect, useId, useRef } from 'react';
import gsap from 'gsap';

interface Props {
  className?: string;
  /** If true, animates automatically on mount & on replayKey changes */
  autoAnimate?: boolean;
  /** Increment to replay animation (e.g. on hover) */
  replayKey?: number;
}

const CHARS: { ch: string; x: number; isQc?: boolean }[] = [
  { ch: 'R', x: 1 },
  { ch: 'A', x: 13.4 },
  { ch: 'G', x: 26.2 },
  { ch: 'F', x: 39.8 },
  { ch: 'l', x: 50.2 },
  { ch: 'o', x: 55.2 },
  { ch: 'w', x: 66.4 },
  { ch: 'Q', x: 86.5, isQc: true },
  { ch: 'C', x: 101.2, isQc: true },
];

/**
 * Refined SVG wordmark for "RAGFlow QC" using Space Grotesk display typography inside an SVG
 * clip-mask so GSAP can animate per-letter editorial rise + emerald QC accent bar.
 */
export const BrandWordmark: React.FC<Props> = ({
  className = 'h-[19px] w-auto',
  autoAnimate = false,
  replayKey = 0,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId();

  useEffect(() => {
    if (!autoAnimate || !svgRef.current) return;
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = gsap.context(() => {
      gsap.fromTo(
        '.brand-char',
        { y: 12, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 0.36,
          stagger: 0.028,
          ease: 'power3.out',
        }
      );
    }, svgRef);

    return () => ctx.revert();
  }, [autoAnimate, replayKey]);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 118 24"
      fill="none"
      className={className}
      aria-label="RAGFlow QC"
      role="img"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width="118" height="24" />
        </clipPath>
      </defs>

      <g clipPath={`url(#${clipId})`}>
        {CHARS.map((item, idx) => (
          <text
            key={idx}
            x={item.x}
            y={18}
            fill={item.isQc ? '#027a42' : '#141414'}
            className="brand-char"
            style={{
              fontFamily: "'Space Grotesk', 'Be Vietnam Pro', system-ui, sans-serif",
              fontSize: '17.5px',
              fontWeight: 700,
              letterSpacing: '-0.03em',
            }}
          >
            {item.ch}
          </text>
        ))}
      </g>
    </svg>
  );
};
