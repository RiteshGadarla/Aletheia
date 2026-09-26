// Reveal: fades, rises and un-blurs its children the first time they scroll into view.
// Same idea as React Bits' AnimatedContent, on motion (already bundled) instead of gsap.
import { motion } from 'motion/react';
import type { ReactNode } from 'react';

interface RevealProps {
  children?: ReactNode;
  delay?: number;
  y?: number;
  /** Share of the element that must be visible before it plays. */
  amount?: number;
  className?: string;
}

export function Reveal({ children, delay = 0, y = 28, amount = 0.25, className }: RevealProps) {
  return (
    <motion.div
      className={['reveal', className].filter(Boolean).join(' ')}
      initial={{ opacity: 0, y, filter: 'blur(8px)' }}
      // filter is dropped afterwards: a lingering blur(0px) keeps an extra compositing layer alive
      whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
      viewport={{ once: true, amount }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay }}
    >
      {children}
    </motion.div>
  );
}
