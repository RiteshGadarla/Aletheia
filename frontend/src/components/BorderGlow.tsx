// BorderGlow (React Bits, TS port): card edge glows toward the cursor.
// Styles in 09-landing.css; resting border and shadow come from tokens.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';

function parseHSL(hslStr: string) {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
  if (!match) return { h: 40, s: 80, l: 80 };
  return { h: parseFloat(match[1]), s: parseFloat(match[2]), l: parseFloat(match[3]) };
}

function buildBoxShadow(glowColor: string, intensity: number) {
  const { h, s, l } = parseHSL(glowColor);
  const base = `${h}deg ${s}% ${l}%`;
  const layers: [number, number, number, number, number, boolean][] = [
    [0, 0, 0, 1, 100, true], [0, 0, 1, 0, 60, true], [0, 0, 3, 0, 50, true],
    [0, 0, 6, 0, 40, true], [0, 0, 15, 0, 30, true], [0, 0, 25, 2, 20, true],
    [0, 0, 50, 2, 10, true],
    [0, 0, 1, 0, 60, false], [0, 0, 3, 0, 50, false], [0, 0, 6, 0, 40, false],
    [0, 0, 15, 0, 30, false], [0, 0, 25, 2, 20, false], [0, 0, 50, 2, 10, false],
  ];
  return layers.map(([x, y, blur, spread, alpha, inset]) => {
    const a = Math.min(alpha * intensity, 100);
    return `${inset ? 'inset ' : ''}${x}px ${y}px ${blur}px ${spread}px hsl(${base} / ${a}%)`;
  }).join(', ');
}

const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInCubic = (x: number) => x * x * x;

interface Anim {
  start?: number;
  end?: number;
  duration?: number;
  delay?: number;
  ease?: (x: number) => number;
  onUpdate: (v: number) => void;
  onEnd?: () => void;
}

/** Returns a cancel function so an unmount mid-sweep does not set state on a dead component. */
function animateValue({ start = 0, end = 100, duration = 1000, delay = 0, ease = easeOutCubic, onUpdate, onEnd }: Anim) {
  let raf = 0;
  const t0 = performance.now() + delay;
  const tick = () => {
    const t = Math.min((performance.now() - t0) / duration, 1);
    onUpdate(start + (end - start) * ease(t));
    if (t < 1) raf = requestAnimationFrame(tick);
    else onEnd?.();
  };
  const timer = window.setTimeout(() => { raf = requestAnimationFrame(tick); }, delay);
  return () => { window.clearTimeout(timer); cancelAnimationFrame(raf); };
}

const GRADIENT_POSITIONS = ['80% 55%', '69% 34%', '8% 6%', '41% 38%', '86% 85%', '82% 18%', '51% 4%'];
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];

function buildMeshGradients(colors: string[]) {
  const gradients: string[] = [];
  for (let i = 0; i < 7; i++) {
    const c = colors[Math.min(COLOR_MAP[i], colors.length - 1)];
    gradients.push(`radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${c} 0px, transparent 50%)`);
  }
  gradients.push(`linear-gradient(${colors[0]} 0 100%)`);
  return gradients;
}

export interface BorderGlowProps {
  children?: ReactNode;
  className?: string;
  edgeSensitivity?: number;
  /** "H S L", e.g. "217 90 70". */
  glowColor?: string;
  /** Any CSS colour, including a token such as var(--surface). */
  backgroundColor?: string;
  /** Light surfaces use normal blending; the upstream plus-lighter / soft-light wash out on white. */
  lightSurface?: boolean;
  borderRadius?: number;
  glowRadius?: number;
  glowIntensity?: number;
  coneSpread?: number;
  animated?: boolean;
  colors?: string[];
  fillOpacity?: number;
}

export function BorderGlow({
  children,
  className = '',
  edgeSensitivity = 30,
  glowColor = '40 80 80',
  backgroundColor = 'var(--surface)',
  lightSurface = false,
  borderRadius = 28,
  glowRadius = 40,
  glowIntensity = 1.0,
  coneSpread = 25,
  animated = false,
  colors = ['#c084fc', '#f472b6', '#38bdf8'],
  fillOpacity = 0.5,
}: BorderGlowProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [cursorAngle, setCursorAngle] = useState(45);
  const [edgeProximity, setEdgeProximity] = useState(0);
  const [sweepActive, setSweepActive] = useState(false);

  const handlePointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = e.clientX - rect.left - cx;
    const dy = e.clientY - rect.top - cy;

    const kx = dx !== 0 ? cx / Math.abs(dx) : Infinity;
    const ky = dy !== 0 ? cy / Math.abs(dy) : Infinity;
    setEdgeProximity(Math.min(Math.max(1 / Math.min(kx, ky), 0), 1));

    if (dx === 0 && dy === 0) {
      setCursorAngle(0);
    } else {
      let degrees = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
      if (degrees < 0) degrees += 360;
      setCursorAngle(degrees);
    }
  }, []);

  useEffect(() => {
    if (!animated) return;
    const angleStart = 110;
    const angleEnd = 465;
    const span = angleEnd - angleStart;
    setSweepActive(true);
    setCursorAngle(angleStart);

    const cancels = [
      animateValue({ duration: 500, onUpdate: (v) => setEdgeProximity(v / 100) }),
      animateValue({ ease: easeInCubic, duration: 1500, end: 50, onUpdate: (v) => setCursorAngle(span * (v / 100) + angleStart) }),
      animateValue({ ease: easeOutCubic, delay: 1500, duration: 2250, start: 50, end: 100, onUpdate: (v) => setCursorAngle(span * (v / 100) + angleStart) }),
      animateValue({
        ease: easeInCubic, delay: 2500, duration: 1500, start: 100, end: 0,
        onUpdate: (v) => setEdgeProximity(v / 100),
        onEnd: () => setSweepActive(false),
      }),
    ];
    return () => cancels.forEach((c) => c());
  }, [animated]);

  const colorSensitivity = edgeSensitivity + 20;
  const isVisible = isHovered || sweepActive;
  const borderOpacity = isVisible
    ? Math.max(0, (edgeProximity * 100 - colorSensitivity) / (100 - colorSensitivity))
    : 0;
  const glowOpacity = isVisible
    ? Math.max(0, (edgeProximity * 100 - edgeSensitivity) / (100 - edgeSensitivity))
    : 0;

  const meshGradients = buildMeshGradients(colors);
  const angleDeg = `${cursorAngle.toFixed(3)}deg`;
  const transition = isVisible ? 'opacity 0.25s ease-out' : 'opacity 0.75s ease-in-out';

  const edgeMask = `conic-gradient(from ${angleDeg} at center, black ${coneSpread}%, transparent ${coneSpread + 15}%, transparent ${100 - coneSpread - 15}%, black ${100 - coneSpread}%)`;
  const fillMask = [
    'linear-gradient(to bottom, black, black)',
    'radial-gradient(ellipse at 50% 50%, black 40%, transparent 65%)',
    'radial-gradient(ellipse at 66% 66%, black 5%, transparent 40%)',
    'radial-gradient(ellipse at 33% 33%, black 5%, transparent 40%)',
    'radial-gradient(ellipse at 66% 33%, black 5%, transparent 40%)',
    'radial-gradient(ellipse at 33% 66%, black 5%, transparent 40%)',
    `conic-gradient(from ${angleDeg} at center, transparent 5%, black 15%, black 85%, transparent 95%)`,
  ].join(', ');
  const glowMask = `conic-gradient(from ${angleDeg} at center, black 2.5%, transparent 10%, transparent 90%, black 97.5%)`;

  const edgeStyle: CSSProperties = {
    background: [
      `linear-gradient(${backgroundColor} 0 100%) padding-box`,
      'linear-gradient(transparent 0% 100%) border-box',
      ...meshGradients.map((g) => `${g} border-box`),
    ].join(', '),
    opacity: borderOpacity,
    maskImage: edgeMask,
    WebkitMaskImage: edgeMask,
    transition,
  };
  const fillStyle = {
    background: meshGradients.map((g) => `${g} padding-box`).join(', '),
    maskImage: fillMask,
    WebkitMaskImage: fillMask,
    maskComposite: 'subtract, add, add, add, add, add',
    WebkitMaskComposite: 'source-out, source-over, source-over, source-over, source-over, source-over',
    opacity: borderOpacity * fillOpacity,
    mixBlendMode: lightSurface ? 'normal' : 'soft-light',
    transition,
  } as CSSProperties;
  const glowStyle: CSSProperties = {
    inset: `${-glowRadius}px`,
    maskImage: glowMask,
    WebkitMaskImage: glowMask,
    opacity: glowOpacity,
    mixBlendMode: lightSurface ? 'normal' : 'plus-lighter',
    transition,
  };

  return (
    <div
      ref={cardRef}
      onPointerMove={handlePointerMove}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      className={['border-glow', className].filter(Boolean).join(' ')}
      style={{ background: backgroundColor, borderRadius: `${borderRadius}px` }}
    >
      <div className="border-glow-layer" style={edgeStyle} />
      <div className="border-glow-layer" style={fillStyle} />
      <span className="border-glow-outer" style={glowStyle}>
        <span
          className="border-glow-outer-ring"
          style={{ inset: `${glowRadius}px`, boxShadow: buildBoxShadow(glowColor, glowIntensity) }}
        />
      </span>
      <div className="border-glow-body">{children}</div>
    </div>
  );
}
