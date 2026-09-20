import { useMemo } from 'react';
import { segmentRaw, typeClass } from '../lib/lineage';
import type { Span, Token } from '../lib/types';

interface Props {
  raw: string;
  spans: Record<string, Span>;
  tokens: Token[];
  /** Slot currently highlighted, from any of the three linked views. */
  active: string | null;
  onActive: (slot: string | null) => void;
  onPick: (slot: string | null) => void;
  /** Slot pinned by a click; it stays lit while the pointer moves elsewhere. */
  pinned?: string | null;
}

/** Reconstructed raw line with every slot's exact bytes individually highlightable. */
export function RawLine({ raw, spans, tokens, active, onActive, onPick, pinned }: Props) {
  const typeOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of tokens) if (t.slot) m[t.slot] = t.type ?? 'word';
    return m;
  }, [tokens]);

  const segments = useMemo(() => segmentRaw(raw, spans), [raw, spans]);

  if (segments.length === 0) return <div className="raw plain">{raw}</div>;

  return (
    <div className="raw" onMouseLeave={() => onActive(pinned ?? null)}>
      {segments.map((seg, i) => {
        if (!seg.slot) return <span className="lit" key={i}>{seg.text}</span>;
        const hit = active === seg.slot;
        const cls = `slot slot-${typeClass(typeOf[seg.slot])}${hit ? ' hit' : active ? ' dim' : ''}`;
        return (
          <span
            key={i}
            className={cls}
            role="button"
            tabIndex={0}
            title={`${seg.slot} · ${typeOf[seg.slot] ?? 'word'} · bytes [${seg.start}, ${seg.end})`}
            onMouseEnter={() => onActive(seg.slot)}
            onFocus={() => onActive(seg.slot)}
            onClick={() => onPick(seg.slot)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(seg.slot); } }}
          >
            {seg.text}
          </span>
        );
      })}
    </div>
  );
}
