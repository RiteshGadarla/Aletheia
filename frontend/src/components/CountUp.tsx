// CountUp (React Bits, TS port): counts to `to` once in view. A fixed-duration ease-out tween
// replaces upstream's overdamped spring, which crept toward the target for many seconds.
import { animate, useInView, useMotionValue } from 'motion/react';
import { useCallback, useEffect, useRef } from 'react';

interface CountUpProps {
  to: number;
  from?: number;
  direction?: 'up' | 'down';
  delay?: number;
  duration?: number;
  className?: string;
  startWhen?: boolean;
  separator?: string;
  onStart?: () => void;
  onEnd?: () => void;
}

const decimals = (n: number) => {
  const part = n.toString().split('.')[1];
  return part && parseInt(part) !== 0 ? part.length : 0;
};

export function CountUp({
  to,
  from = 0,
  direction = 'up',
  delay = 0,
  duration = 2,
  className = '',
  startWhen = true,
  separator = '',
  onStart,
  onEnd,
}: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const motionValue = useMotionValue(direction === 'down' ? to : from);
  const isInView = useInView(ref, { once: true, margin: '0px' });
  const places = Math.max(decimals(from), decimals(to));

  const format = useCallback((v: number) => {
    const s = Intl.NumberFormat('en-US', {
      useGrouping: !!separator,
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    }).format(v);
    return separator ? s.replace(/,/g, separator) : s;
  }, [places, separator]);

  useEffect(() => {
    if (ref.current) ref.current.textContent = format(direction === 'down' ? to : from);
  }, [from, to, direction, format]);

  useEffect(() => {
    if (!isInView || !startWhen) return;
    onStart?.();
    const controls = animate(motionValue, direction === 'down' ? from : to, {
      duration, delay, ease: [0.16, 1, 0.3, 1], onComplete: onEnd,
    });
    return () => controls.stop();
  }, [isInView, startWhen, motionValue, direction, from, to, delay, onStart, onEnd, duration]);

  useEffect(() => motionValue.on('change', (v: number) => {
    if (ref.current) ref.current.textContent = format(v);
  }), [motionValue, format]);

  return <span className={className} ref={ref} aria-label={format(direction === 'down' ? from : to)} />;
}
