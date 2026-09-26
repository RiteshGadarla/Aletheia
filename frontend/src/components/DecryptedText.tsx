// DecryptedText (React Bits, TS port): glyphs scramble, then resolve to the real text.
// Trimmed to view/hover modes; screen readers get the real text, never the scramble.
import { useCallback, useEffect, useRef, useState } from 'react';

interface DecryptedTextProps {
  text: string;
  speed?: number;
  maxIterations?: number;
  sequential?: boolean;
  revealDirection?: 'start' | 'end' | 'center';
  characters?: string;
  className?: string;
  parentClassName?: string;
  encryptedClassName?: string;
  animateOn?: 'view' | 'hover' | 'inViewHover';
}

const centerOrder = (len: number) => {
  const mid = Math.floor(len / 2);
  const out: number[] = [];
  for (let off = 0; out.length < len; off++) {
    const i = off % 2 === 0 ? mid + off / 2 : mid - Math.ceil(off / 2);
    if (i >= 0 && i < len) out.push(i);
  }
  return out;
};

export function DecryptedText({
  text,
  speed = 50,
  maxIterations = 10,
  sequential = false,
  revealDirection = 'start',
  characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()_+',
  className = '',
  parentClassName = '',
  encryptedClassName = '',
  animateOn = 'hover',
}: DecryptedTextProps) {
  const [display, setDisplay] = useState(text);
  const [revealed, setRevealed] = useState<Set<number> | null>(null); // null = fully decrypted
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number>(0);
  const played = useRef(false);

  const scramble = useCallback((keep: Set<number>) => text.split('').map((c, i) => (
    c === ' ' || keep.has(i) ? c : characters[Math.floor(Math.random() * characters.length)]
  )).join(''), [text, characters]);

  const run = useCallback(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    window.clearInterval(timer.current);
    const order = revealDirection === 'center' ? centerOrder(text.length)
      : Array.from({ length: text.length }, (_, i) => (revealDirection === 'end' ? text.length - 1 - i : i));
    const keep = new Set<number>();
    let step = 0;
    setRevealed(keep);
    timer.current = window.setInterval(() => {
      if (sequential) keep.add(order[step]);
      step += 1;
      const done = sequential ? keep.size >= text.length : step >= maxIterations;
      if (done) {
        window.clearInterval(timer.current);
        setDisplay(text);
        setRevealed(null);
        return;
      }
      setDisplay(scramble(keep));
      setRevealed(new Set(keep));
    }, speed);
  }, [text, speed, maxIterations, sequential, revealDirection, scramble]);

  const reset = useCallback(() => {
    window.clearInterval(timer.current);
    setDisplay(text);
    setRevealed(null);
  }, [text]);

  useEffect(() => {
    reset();
    played.current = false;
  }, [reset]);

  useEffect(() => {
    if (animateOn === 'hover') return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !played.current) {
        played.current = true;
        run();
      }
    }, { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, [animateOn, run]);

  useEffect(() => () => window.clearInterval(timer.current), []);

  const hover = animateOn === 'hover' || animateOn === 'inViewHover';
  return (
    <span
      ref={ref}
      className={['decrypted-text', parentClassName].filter(Boolean).join(' ')}
      onMouseEnter={hover ? run : undefined}
      onMouseLeave={hover ? reset : undefined}
    >
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {display.split('').map((c, i) => (
          <span key={i} className={(revealed === null || revealed.has(i) ? className : encryptedClassName) || undefined}>{c}</span>
        ))}
      </span>
    </span>
  );
}
