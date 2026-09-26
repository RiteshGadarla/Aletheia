// ParticleText (React Bits, TS port): text formed from particles that shy from the cursor.
// Adds multi-line + per-line colours, font-driven height, and pauses while off-screen.
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';

type RGB = { r: number; g: number; b: number };

const hexToRgb = (hex: string): RGB | null => {
  const clean = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return { r: parseInt(clean.slice(0, 2), 16), g: parseInt(clean.slice(2, 4), 16), b: parseInt(clean.slice(4, 6), 16) };
};
const mixRgb = (a: RGB, b: RGB, t: number): RGB => ({
  r: Math.round(a.r + (b.r - a.r) * t),
  g: Math.round(a.g + (b.g - a.g) * t),
  b: Math.round(a.b + (b.b - a.b) * t),
});
const rgbToCss = (c: RGB) => `rgb(${c.r}, ${c.g}, ${c.b})`;
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

const resolveFontSize = (value: number | string, container: HTMLElement, weight: number | string, family: string) => {
  if (typeof value === 'number') return value;
  const probe = document.createElement('span');
  probe.textContent = 'M';
  Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', fontSize: value, fontWeight: String(weight), fontFamily: family });
  container.appendChild(probe);
  const size = parseFloat(window.getComputedStyle(probe).fontSize) || 96;
  probe.remove();
  return size;
};

const waitForFonts = async (font: string) => {
  if (!('fonts' in document)) return;
  try { await document.fonts.load(font); } catch { /* fall back to whatever is loaded */ }
  await document.fonts.ready;
};

interface Particle {
  x: number; y: number; startX: number; startY: number; targetX: number; targetY: number;
  size: number; color: string; seed: number; depth: number; delay: number;
}

export interface ParticleTextProps {
  /** Lines are split on \n. */
  text?: string;
  particleSize?: number;
  density?: number;
  color?: string;
  highlightColor?: string;
  /** Per-line override of color / highlightColor, by line index. */
  lineColors?: ({ color: string; highlightColor: string } | undefined)[];
  scatter?: number;
  gatherDuration?: number;
  stagger?: number;
  pointerRepel?: number;
  repelRadius?: number;
  idleDrift?: number;
  trigger?: 'mount' | 'hover' | 'click';
  fontSize?: number | string;
  fontWeight?: number | string;
  fontFamily?: string;
  lineHeight?: number;
  letterSpacing?: string;
  glow?: boolean;
  /** Cap on particle count. Upstream derives it from canvas area, which starves a short wide line. */
  maxParticles?: number;
  className?: string;
  style?: CSSProperties;
}

export function ParticleText({
  text = 'React Bits',
  particleSize = 2,
  density = 4,
  color = '#ffffff',
  highlightColor = '#8b5cf6',
  lineColors,
  scatter = 180,
  gatherDuration = 1600,
  stagger = 420,
  pointerRepel = 40,
  repelRadius = 120,
  idleDrift = 0.7,
  trigger = 'mount',
  fontSize = 'clamp(3rem, 12vw, 8rem)',
  fontWeight = 800,
  fontFamily = 'inherit',
  lineHeight = 1.05,
  letterSpacing = '0px',
  glow = true,
  maxParticles,
  className = '',
  style,
}: ParticleTextProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Serialised so a new array literal each render does not rebuild the particles.
  const lineColorsKey = JSON.stringify(lineColors ?? []);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const perLine = JSON.parse(lineColorsKey) as ParticleTextProps['lineColors'] ?? [];

    let particles: Particle[] = [];
    let frame: number | null = null;
    let resizeFrame: number | null = null;
    let buildId = 0;
    let gathering = false;
    let gatherStart = 0;
    let settled = false;
    let lastWidth = -1;
    let width = 0;
    let height = 0;
    let isVisible = true;
    let isPageVisible = !document.hidden;
    const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let reducedMotion = motionQuery?.matches ?? false;

    const pointer = { active: false, x: 0, y: 0, smoothX: 0, smoothY: 0 };

    const startGather = (fromScatter = true) => {
      if (!particles.length) return;
      const spread = reducedMotion ? 0 : scatter;
      particles.forEach((p) => {
        if (fromScatter) {
          const angle = p.seed * Math.PI * 2;
          const distance = spread * (0.35 + p.depth * 0.75);
          p.x = p.targetX + Math.cos(angle) * distance + (p.depth - 0.5) * spread * 0.55;
          p.y = p.targetY + Math.sin(angle) * distance + (p.seed - 0.5) * spread * 0.55;
        }
        p.startX = p.x;
        p.startY = p.y;
        p.delay = reducedMotion ? 0 : p.seed * stagger;
      });
      gatherStart = performance.now();
      gathering = true;
      settled = false;
      ensureLoop();
    };

    const drawParticle = (p: Particle) => {
      ctx.fillStyle = p.color;
      if (p.size <= 2.1) {
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        return;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
      ctx.fill();
    };

    const render = (now: number) => {
      frame = null;
      ctx.clearRect(0, 0, width, height);
      ctx.shadowBlur = glow && !reducedMotion ? particleSize * 3 : 0;
      ctx.shadowColor = highlightColor;

      pointer.smoothX += (pointer.x - pointer.smoothX) * 0.18;
      pointer.smoothY += (pointer.y - pointer.smoothY) * 0.18;

      let complete = true;
      for (const p of particles) {
        let baseX = p.targetX;
        let baseY = p.targetY;
        let progress = 1;

        if (gathering) {
          progress = clamp((now - gatherStart - p.delay) / Math.max(1, reducedMotion ? 1 : gatherDuration), 0, 1);
          const e = easeOutCubic(progress);
          baseX = p.startX + (p.targetX - p.startX) * e;
          baseY = p.startY + (p.targetY - p.startY) * e;
          if (progress < 1) complete = false;
        } else if (!reducedMotion && idleDrift > 0) {
          const t = now * 0.001;
          baseX += Math.sin(t * 0.9 + p.seed * 10) * idleDrift * p.depth;
          baseY += Math.cos(t * 0.75 + p.depth * 10) * idleDrift * p.depth;
        }

        if (pointer.active && !reducedMotion && pointerRepel > 0 && repelRadius > 0) {
          const dx = baseX - pointer.smoothX;
          const dy = baseY - pointer.smoothY;
          const d = Math.hypot(dx, dy);
          if (d > 0 && d < repelRadius) {
            const force = Math.pow(1 - d / repelRadius, 2) * pointerRepel;
            baseX += (dx / d) * force;
            baseY += (dy / d) * force;
          }
        }

        const follow = reducedMotion ? 1 : 0.22;
        p.x += (baseX - p.x) * follow;
        p.y += (baseY - p.y) * follow;
        ctx.globalAlpha = clamp(0.35 + progress * 0.65, 0, 1);
        drawParticle(p);
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      if (gathering && complete) gathering = false;

      // With reduced motion the formed text is static: one frame is enough.
      if (reducedMotion && !gathering) { settled = true; return; }
      if (isVisible && isPageVisible) frame = window.requestAnimationFrame(render);
    };

    function ensureLoop() {
      if (frame === null && isVisible && isPageVisible && !(settled && reducedMotion)) {
        frame = window.requestAnimationFrame(render);
      }
    }

    const sample = async () => {
      const build = ++buildId;
      width = Math.floor(container.getBoundingClientRect().width);
      if (width <= 0) return;
      lastWidth = width;

      const computed = window.getComputedStyle(container);
      const family = fontFamily === 'inherit' ? computed.fontFamily || 'sans-serif' : fontFamily;
      let size = resolveFontSize(fontSize, container, fontWeight, family);
      let font = `${fontWeight} ${size}px ${family}`;
      await waitForFonts(font);
      if (build !== buildId) return;

      const lines = String(text || ' ').split('\n');
      const off = document.createElement('canvas');
      const offCtx = off.getContext('2d', { willReadFrequently: true });
      if (!offCtx) return;
      const setFont = () => {
        offCtx.font = font;
        (offCtx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = letterSpacing;
      };
      setFont();
      const widest = Math.max(1, ...lines.map((l) => offCtx.measureText(l).width));
      const maxWidth = width * 0.96;
      if (widest > maxWidth) {
        size = Math.max(18, size * (maxWidth / widest));
        font = `${fontWeight} ${size}px ${family}`;
        await waitForFonts(font);
        if (build !== buildId) return;
      }

      // Height follows the text, so the block takes the room a normal heading would.
      const lineBox = Math.ceil(size * lineHeight);
      const padding = Math.ceil(size * 0.12);
      height = lineBox * lines.length + padding * 2;
      container.style.height = `${height}px`;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      off.width = width;
      off.height = height;
      setFont();
      offCtx.textAlign = 'center';
      offCtx.textBaseline = 'middle';
      offCtx.fillStyle = '#ffffff';
      lines.forEach((l, i) => offCtx.fillText(l, width / 2, padding + lineBox * (i + 0.5)));

      const img = offCtx.getImageData(0, 0, off.width, off.height).data;
      const step = Math.max(2, Math.floor(density));
      const targets: { x: number; y: number; alpha: number; line: number }[] = [];
      for (let y = 0; y < off.height; y += step) {
        const line = clamp(Math.floor((y - padding) / lineBox), 0, lines.length - 1);
        for (let x = 0; x < off.width; x += step) {
          const a = img[(y * off.width + x) * 4 + 3];
          if (a > 40) targets.push({ x, y, alpha: a / 255, line });
        }
      }

      const cap = maxParticles ?? Math.max(1200, Math.min(9000, Math.floor((width * height) / 60)));
      const stride = Math.max(1, Math.ceil(targets.length / cap));
      const palette = lines.map((_, i) => {
        const c = perLine[i];
        return { base: hexToRgb(c?.color ?? color), hi: hexToRgb(c?.highlightColor ?? highlightColor), raw: c?.color ?? color };
      });

      particles = targets.filter((_, i) => i % stride === 0).map((t, i) => {
        const seed = ((i * 9301 + 49297) % 233280) / 233280;
        const depth = 0.45 + (((i * 233 + 97) % 1000) / 1000) * 0.9;
        const { base, hi, raw } = palette[t.line];
        const blend = base && hi ? clamp(t.x / Math.max(1, width) + (seed - 0.5) * 0.35, 0, 1) : 0;
        const angle = seed * Math.PI * 2;
        const distance = (reducedMotion ? 0 : scatter) * (0.35 + depth * 0.75);
        const startX = t.x + Math.cos(angle) * distance + (seed - 0.5) * scatter * 0.45;
        const startY = t.y + Math.sin(angle) * distance + (depth - 0.9) * scatter * 0.45;
        return {
          x: reducedMotion ? t.x : startX,
          y: reducedMotion ? t.y : startY,
          startX, startY, targetX: t.x, targetY: t.y,
          size: Math.max(0.6, particleSize * (0.75 + t.alpha * 0.45)),
          color: base && hi ? rgbToCss(mixRgb(base, hi, blend)) : raw,
          seed, depth, delay: seed * stagger,
        };
      });

      pointer.x = pointer.smoothX = width / 2;
      pointer.y = pointer.smoothY = height / 2;

      if (reducedMotion) {
        particles.forEach((p) => { p.x = p.startX = p.targetX; p.y = p.startY = p.targetY; p.delay = 0; });
        gathering = false;
        settled = false;
        ensureLoop();
      } else {
        startGather(false);
      }
    };

    // Only width changes need a resample; the height is ours and would otherwise loop.
    const queueSample = () => {
      if (Math.floor(container.getBoundingClientRect().width) === lastWidth) return;
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => { resizeFrame = null; void sample(); });
    };

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      pointer.active = true;
    };
    const onLeave = () => { pointer.active = false; };
    const onEnter = (e: PointerEvent) => {
      onMove(e);
      if (trigger === 'hover') startGather(true);
    };
    const onClick = () => { if (trigger === 'click') startGather(true); };
    const onMotion = (e: MediaQueryListEvent) => { reducedMotion = e.matches; void sample(); };
    const onVisibility = () => {
      isPageVisible = !document.hidden;
      ensureLoop();
    };

    motionQuery?.addEventListener('change', onMotion);
    canvas.addEventListener('pointerenter', onEnter);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('click', onClick);
    document.addEventListener('visibilitychange', onVisibility);
    const io = new IntersectionObserver(([entry]) => { isVisible = entry.isIntersecting; ensureLoop(); });
    io.observe(container);
    const ro = new ResizeObserver(queueSample);
    ro.observe(container);
    void sample();

    return () => {
      buildId += 1;
      ro.disconnect();
      io.disconnect();
      motionQuery?.removeEventListener('change', onMotion);
      canvas.removeEventListener('pointerenter', onEnter);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      document.removeEventListener('visibilitychange', onVisibility);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
    };
  }, [
    text, particleSize, density, color, highlightColor, lineColorsKey, scatter, gatherDuration, stagger,
    pointerRepel, repelRadius, idleDrift, trigger, fontSize, fontWeight, fontFamily, lineHeight,
    letterSpacing, glow, maxParticles,
  ]);

  return (
    <div ref={containerRef} className={['particle-text', className].filter(Boolean).join(' ')} style={style}>
      <canvas ref={canvasRef} className="particle-text-canvas" aria-hidden="true" />
    </div>
  );
}
