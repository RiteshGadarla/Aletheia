// SpotlightCard — card lit by a soft radial spotlight that follows the cursor. Ported from React
// Bits (TS + CSS); styles live in 09-landing.css (.card-spotlight) and take their colours from tokens.
import { useRef } from 'react';
import type { MouseEvent, ReactNode } from 'react';

interface SpotlightCardProps {
  children?: ReactNode;
  className?: string;
  /** Any CSS colour; defaults to the accent at low alpha. */
  spotlightColor?: string;
}

export function SpotlightCard({ children, className = '', spotlightColor }: SpotlightCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mouse-x', `${e.clientX - r.left}px`);
    el.style.setProperty('--mouse-y', `${e.clientY - r.top}px`);
    if (spotlightColor) el.style.setProperty('--spotlight-color', spotlightColor);
  };

  return (
    <div ref={ref} onMouseMove={onMove} className={['card-spotlight', className].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}
