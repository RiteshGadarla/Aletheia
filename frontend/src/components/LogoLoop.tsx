// LogoLoop (React Bits, TS port): infinitely scrolling logo row. Styles in 09-landing.css.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Key, ReactNode, RefObject } from 'react';

const SMOOTH_TAU = 0.25;
const MIN_COPIES = 2;
const COPY_HEADROOM = 2;

export type LogoItem =
  | { node: ReactNode; title?: string; href?: string; ariaLabel?: string }
  | { src: string; alt?: string; title?: string; href?: string; srcSet?: string; sizes?: string; width?: number; height?: number };

export interface LogoLoopProps {
  logos: LogoItem[];
  speed?: number;
  direction?: 'left' | 'right' | 'up' | 'down';
  width?: number | string;
  logoHeight?: number;
  gap?: number;
  pauseOnHover?: boolean;
  hoverSpeed?: number;
  fadeOut?: boolean;
  fadeOutColor?: string;
  scaleOnHover?: boolean;
  renderItem?: (item: LogoItem, key: Key) => ReactNode;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

const toCssLength = (v?: number | string) => (typeof v === 'number' ? `${v}px` : v);
const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

function useResizeObserver(callback: () => void, elements: RefObject<Element>[], deps: unknown[]) {
  useEffect(() => {
    if (!window.ResizeObserver) {
      window.addEventListener('resize', callback);
      callback();
      return () => window.removeEventListener('resize', callback);
    }
    const observers = elements.map((ref) => {
      if (!ref.current) return null;
      const o = new ResizeObserver(callback);
      o.observe(ref.current);
      return o;
    });
    callback();
    return () => observers.forEach((o) => o?.disconnect());
    // deps spread in: upstream passed the array itself, a new identity each render, so it re-ran every render
  }, [callback, elements, ...deps]);
}

function useImageLoader(seqRef: RefObject<HTMLUListElement>, onLoad: () => void, deps: unknown[]) {
  useEffect(() => {
    const images = seqRef.current?.querySelectorAll('img') ?? [];
    if (images.length === 0) {
      onLoad();
      return;
    }
    let remaining = images.length;
    const done = () => {
      remaining -= 1;
      if (remaining === 0) onLoad();
    };
    images.forEach((img) => {
      if (img.complete) done();
      else {
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      }
    });
    return () => images.forEach((img) => {
      img.removeEventListener('load', done);
      img.removeEventListener('error', done);
    });
  }, [onLoad, seqRef, ...deps]);
}

function useAnimationLoop(
  trackRef: RefObject<HTMLDivElement>, targetVelocity: number, seqWidth: number, seqHeight: number,
  isHovered: boolean, hoverSpeed: number | undefined, isVertical: boolean,
) {
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number | null>(null);
  const offsetRef = useRef(0);
  const velocityRef = useRef(0);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const place = () => {
      track.style.transform = isVertical
        ? `translate3d(0, ${-offsetRef.current}px, 0)`
        : `translate3d(${-offsetRef.current}px, 0, 0)`;
    };
    const seqSize = isVertical ? seqHeight : seqWidth;
    if (seqSize > 0) {
      offsetRef.current = ((offsetRef.current % seqSize) + seqSize) % seqSize;
      place();
    }

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      track.style.transform = 'translate3d(0, 0, 0)';
      return () => { lastRef.current = null; };
    }

    const animate = (ts: number) => {
      if (lastRef.current === null) lastRef.current = ts;
      const dt = Math.max(0, ts - lastRef.current) / 1000;
      lastRef.current = ts;

      const target = isHovered && hoverSpeed !== undefined ? hoverSpeed : targetVelocity;
      velocityRef.current += (target - velocityRef.current) * (1 - Math.exp(-dt / SMOOTH_TAU));

      if (seqSize > 0) {
        const next = offsetRef.current + velocityRef.current * dt;
        offsetRef.current = ((next % seqSize) + seqSize) % seqSize;
        place();
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastRef.current = null;
    };
  }, [targetVelocity, seqWidth, seqHeight, isHovered, hoverSpeed, isVertical, trackRef]);
}

export const LogoLoop = memo(function LogoLoop({
  logos,
  speed = 120,
  direction = 'left',
  width = '100%',
  logoHeight = 28,
  gap = 32,
  pauseOnHover,
  hoverSpeed,
  fadeOut = false,
  fadeOutColor,
  scaleOnHover = false,
  renderItem,
  ariaLabel = 'Partner logos',
  className,
  style,
}: LogoLoopProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef<HTMLUListElement>(null);

  const [seqWidth, setSeqWidth] = useState(0);
  const [seqHeight, setSeqHeight] = useState(0);
  const [copyCount, setCopyCount] = useState(MIN_COPIES);
  const [isHovered, setIsHovered] = useState(false);

  const effectiveHoverSpeed = useMemo(() => {
    if (hoverSpeed !== undefined) return hoverSpeed;
    if (pauseOnHover === false) return undefined;
    return 0;
  }, [hoverSpeed, pauseOnHover]);

  const isVertical = direction === 'up' || direction === 'down';

  const targetVelocity = useMemo(() => {
    const dir = isVertical ? (direction === 'up' ? 1 : -1) : (direction === 'left' ? 1 : -1);
    return Math.abs(speed) * dir * (speed < 0 ? -1 : 1);
  }, [speed, direction, isVertical]);

  const updateDimensions = useCallback(() => {
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    const rect = seqRef.current?.getBoundingClientRect();
    const sw = rect?.width ?? 0;
    const sh = rect?.height ?? 0;
    if (isVertical) {
      const parentHeight = containerRef.current?.parentElement?.clientHeight ?? 0;
      if (containerRef.current && parentHeight > 0) {
        const h = `${Math.ceil(parentHeight)}px`;
        if (containerRef.current.style.height !== h) containerRef.current.style.height = h;
      }
      if (sh > 0) {
        setSeqHeight(Math.ceil(sh));
        const viewport = containerRef.current?.clientHeight ?? parentHeight;
        setCopyCount(Math.max(MIN_COPIES, Math.ceil(viewport / sh) + COPY_HEADROOM));
      }
    } else if (sw > 0) {
      setSeqWidth(Math.ceil(sw));
      setCopyCount(Math.max(MIN_COPIES, Math.ceil(containerWidth / sw) + COPY_HEADROOM));
    }
  }, [isVertical]);

  const observed = useMemo(() => [containerRef, seqRef] as RefObject<Element>[], []);
  useResizeObserver(updateDimensions, observed, [logos, gap, logoHeight, isVertical]);
  useImageLoader(seqRef, updateDimensions, [logos, gap, logoHeight, isVertical]);
  useAnimationLoop(trackRef, targetVelocity, seqWidth, seqHeight, isHovered, effectiveHoverSpeed, isVertical);

  const onEnter = useCallback(() => { if (effectiveHoverSpeed !== undefined) setIsHovered(true); }, [effectiveHoverSpeed]);
  const onLeave = useCallback(() => { if (effectiveHoverSpeed !== undefined) setIsHovered(false); }, [effectiveHoverSpeed]);

  const itemClass = cx('logoloop-item', isVertical && 'vertical', scaleOnHover && 'scalable');

  const renderLogoItem = useCallback((item: LogoItem, key: Key) => {
    if (renderItem) {
      return <li className={itemClass} key={key} role="listitem">{renderItem(item, key)}</li>;
    }
    const isNode = 'node' in item;
    const content = isNode ? (
      <span className="logoloop-node" aria-hidden={!!item.href && !item.ariaLabel}>{item.node}</span>
    ) : (
      <img
        className="logoloop-img"
        src={item.src}
        srcSet={item.srcSet}
        sizes={item.sizes}
        width={item.width}
        height={item.height}
        alt={item.alt ?? ''}
        title={item.title}
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    );
    const label = isNode ? (item.ariaLabel ?? item.title) : (item.alt ?? item.title);
    return (
      <li className={itemClass} key={key} role="listitem">
        {item.href ? (
          <a className="logoloop-link" href={item.href} aria-label={label || 'logo link'} target="_blank" rel="noreferrer noopener">
            {content}
          </a>
        ) : content}
      </li>
    );
  }, [renderItem, itemClass]);

  const lists = useMemo(() => Array.from({ length: copyCount }, (_, copy) => (
    <ul
      className={cx('logoloop-list', isVertical && 'vertical')}
      key={`copy-${copy}`}
      role="list"
      aria-hidden={copy > 0}
      ref={copy === 0 ? seqRef : undefined}
    >
      {logos.map((item, i) => renderLogoItem(item, `${copy}-${i}`))}
    </ul>
  )), [copyCount, logos, renderLogoItem, isVertical]);

  const containerStyle = useMemo(() => ({
    width: isVertical ? (toCssLength(width) === '100%' ? undefined : toCssLength(width)) : (toCssLength(width) ?? '100%'),
    '--logoloop-gap': `${gap}px`,
    '--logoloop-logoHeight': `${logoHeight}px`,
    ...(fadeOutColor ? { '--logoloop-fadeColor': fadeOutColor } : {}),
    ...style,
  }) as CSSProperties, [width, gap, logoHeight, fadeOutColor, style, isVertical]);

  return (
    <div
      ref={containerRef}
      className={cx('logoloop', isVertical ? 'vertical' : 'horizontal', scaleOnHover && 'scalable', className)}
      style={containerStyle}
      role="region"
      aria-label={ariaLabel}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {fadeOut && (
        <>
          <div aria-hidden className={cx('logoloop-fade', isVertical ? 'top' : 'left')} />
          <div aria-hidden className={cx('logoloop-fade', isVertical ? 'bottom' : 'right')} />
        </>
      )}
      <div className={cx('logoloop-track', isVertical && 'vertical')} ref={trackRef}>
        {lists}
      </div>
    </div>
  );
});
