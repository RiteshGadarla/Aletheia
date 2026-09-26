// GlareHover — a diagonal glare sweeps across the element on hover. Ported from React Bits
// (TS + CSS); styles live in 09-landing.css (.glare-hover). Width and height default to the
// content rather than upstream's fixed 500px, and the glare never takes pointer events.
import type { CSSProperties, ReactNode } from 'react';

interface GlareHoverProps {
  width?: string;
  height?: string;
  background?: string;
  borderRadius?: string;
  borderColor?: string;
  children?: ReactNode;
  glareColor?: string;
  glareOpacity?: number;
  glareAngle?: number;
  glareSize?: number;
  transitionDuration?: number;
  playOnce?: boolean;
  className?: string;
  style?: CSSProperties;
}

const toRgba = (color: string, opacity: number) => {
  const hex = color.replace('#', '');
  const full = /^[0-9A-Fa-f]{3}$/.test(hex) ? hex.split('').map((c) => c + c).join('') : hex;
  if (!/^[0-9A-Fa-f]{6}$/.test(full)) return color;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${opacity})`;
};

export function GlareHover({
  width = 'auto',
  height = 'auto',
  background = 'transparent',
  borderRadius = 'var(--r-md)',
  borderColor = 'transparent',
  children,
  glareColor = '#ffffff',
  glareOpacity = 0.5,
  glareAngle = -45,
  glareSize = 250,
  transitionDuration = 650,
  playOnce = false,
  className = '',
  style,
}: GlareHoverProps) {
  const vars = {
    '--gh-width': width,
    '--gh-height': height,
    '--gh-bg': background,
    '--gh-br': borderRadius,
    '--gh-angle': `${glareAngle}deg`,
    '--gh-duration': `${transitionDuration}ms`,
    '--gh-size': `${glareSize}%`,
    '--gh-rgba': toRgba(glareColor, glareOpacity),
    '--gh-border': borderColor,
  } as CSSProperties;

  return (
    <div
      className={['glare-hover', playOnce && 'glare-hover--play-once', className].filter(Boolean).join(' ')}
      style={{ ...vars, ...style }}
    >
      {children}
    </div>
  );
}
