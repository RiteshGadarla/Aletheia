// ClickSpark (React Bits, TS port): sparks burst from each press. Draws only while sparks live, and
// listens on pointerdown so children that stop click propagation still spark.
import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent, ReactNode } from 'react';

interface ClickSparkProps {
  sparkColor?: string;
  sparkSize?: number;
  sparkRadius?: number;
  sparkCount?: number;
  duration?: number;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  extraScale?: number;
  className?: string;
  children?: ReactNode;
}

interface Spark { x: number; y: number; angle: number; startTime: number }

// Canvas overhang past the wrapper, so sparks around a small button are not clipped.
const PAD = 32;

export function ClickSpark({
  sparkColor = '#fff',
  sparkSize = 10,
  sparkRadius = 15,
  sparkCount = 8,
  duration = 400,
  easing = 'ease-out',
  extraScale = 1.0,
  className = '',
  children,
}: ClickSparkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sparksRef = useRef<Spark[]>([]);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const fit = () => {
      const { width, height } = parent.getBoundingClientRect();
      canvas.width = width + PAD * 2;
      canvas.height = height + PAD * 2;
    };
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    fit();
    return () => { ro.disconnect(); cancelAnimationFrame(rafRef.current); };
  }, []);

  const ease = useCallback((t: number) => {
    switch (easing) {
      case 'linear': return t;
      case 'ease-in': return t * t;
      case 'ease-in-out': return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      default: return t * (2 - t);
    }
  }, [easing]);

  const draw = useCallback((now: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    sparksRef.current = sparksRef.current.filter((s) => {
      const elapsed = now - s.startTime;
      if (elapsed >= duration) return false;
      const e = ease(elapsed / duration);
      const dist = e * sparkRadius * extraScale;
      const len = sparkSize * (1 - e);
      ctx.strokeStyle = sparkColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x + dist * Math.cos(s.angle), s.y + dist * Math.sin(s.angle));
      ctx.lineTo(s.x + (dist + len) * Math.cos(s.angle), s.y + (dist + len) * Math.sin(s.angle));
      ctx.stroke();
      return true;
    });
    rafRef.current = sparksRef.current.length ? requestAnimationFrame(draw) : 0;
  }, [duration, ease, sparkRadius, extraScale, sparkSize, sparkColor]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const r = canvas.getBoundingClientRect();
    const now = performance.now();
    for (let i = 0; i < sparkCount; i++) {
      sparksRef.current.push({ x: e.clientX - r.left, y: e.clientY - r.top, angle: (2 * Math.PI * i) / sparkCount, startTime: now });
    }
    if (!rafRef.current) rafRef.current = requestAnimationFrame(draw);
  };

  return (
    <div className={['click-spark', className].filter(Boolean).join(' ')} onPointerDown={onPointerDown}>
      <canvas ref={canvasRef} className="click-spark-canvas" aria-hidden="true" />
      {children}
    </div>
  );
}
