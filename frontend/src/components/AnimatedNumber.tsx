import React, { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';

interface Props {
  value: number;
  decimals?: number;
  suffix?: string;
  className?: string;
}

export const AnimatedNumber: React.FC<Props> = ({
  value,
  decimals = 0,
  suffix = '',
  className = '',
}) => {
  const [display, setDisplay] = useState(value);
  const objRef = useRef({ v: 0 });

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setDisplay(value);
      objRef.current.v = value;
      return;
    }
    const tween = gsap.to(objRef.current, {
      v: value,
      duration: 0.45,
      ease: 'power2.out',
      onUpdate: () => setDisplay(objRef.current.v),
    });
    return () => {
      tween.kill();
    };
  }, [value]);

  return (
    <span className={className}>
      {display.toFixed(decimals)}
      {suffix}
    </span>
  );
};
