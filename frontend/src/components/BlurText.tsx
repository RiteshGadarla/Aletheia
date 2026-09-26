// BlurText — words (or letters) blur and drop into place when scrolled into view. Ported from
// React Bits (TS + CSS); adds `as` so it can render a real heading instead of a <p>.
import { motion } from 'motion/react';
import type { Transition } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ElementType } from 'react';

type Frame = Record<string, string | number>;

interface BlurTextProps {
  text?: string;
  as?: ElementType;
  delay?: number;
  className?: string;
  animateBy?: 'words' | 'letters';
  direction?: 'top' | 'bottom';
  threshold?: number;
  rootMargin?: string;
  animationFrom?: Frame;
  animationTo?: Frame[];
  easing?: (t: number) => number;
  onAnimationComplete?: () => void;
  stepDuration?: number;
}

const buildKeyframes = (from: Frame, steps: Frame[]) => {
  const keys = new Set([...Object.keys(from), ...steps.flatMap((s) => Object.keys(s))]);
  const out: Record<string, (string | number)[]> = {};
  keys.forEach((k) => { out[k] = [from[k], ...steps.map((s) => s[k])]; });
  return out;
};

export function BlurText({
  text = '',
  as: Tag = 'p',
  delay = 200,
  className = '',
  animateBy = 'words',
  direction = 'top',
  threshold = 0.1,
  rootMargin = '0px',
  animationFrom,
  animationTo,
  easing = (t: number) => t,
  onAnimationComplete,
  stepDuration = 0.35,
}: BlurTextProps) {
  const elements = animateBy === 'words' ? text.split(' ') : text.split('');
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setInView(true);
        observer.disconnect();
      }
    }, { threshold, rootMargin });
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold, rootMargin]);

  const from = useMemo<Frame>(() => animationFrom
    ?? { filter: 'blur(10px)', opacity: 0, y: direction === 'top' ? -50 : 50 }, [animationFrom, direction]);
  const to = useMemo<Frame[]>(() => animationTo ?? [
    { filter: 'blur(5px)', opacity: 0.5, y: direction === 'top' ? 5 : -5 },
    { filter: 'blur(0px)', opacity: 1, y: 0 },
  ], [animationTo, direction]);

  const keyframes = useMemo(() => buildKeyframes(from, to), [from, to]);
  const stepCount = to.length + 1;
  const times = Array.from({ length: stepCount }, (_, i) => (stepCount === 1 ? 0 : i / (stepCount - 1)));

  return (
    <Tag ref={ref} className={['blur-text', className].filter(Boolean).join(' ')} aria-label={text}>
      {elements.map((segment, i) => {
        const transition: Transition = { duration: stepDuration * (stepCount - 1), times, delay: (i * delay) / 1000, ease: easing };
        return (
          <motion.span
            key={i}
            className="blur-text-seg"
            aria-hidden="true"
            initial={from}
            animate={inView ? keyframes : from}
            transition={transition}
            onAnimationComplete={i === elements.length - 1 ? onAnimationComplete : undefined}
          >
            {segment === ' ' ? ' ' : segment}
            {animateBy === 'words' && i < elements.length - 1 && ' '}
          </motion.span>
        );
      })}
    </Tag>
  );
}
