import type { Span, Token } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Byte length, not UTF-16 code-unit length: spans from the engine are byte offsets. */
export const byteLen = (s: string): number => enc.encode(s).length;

/** CONTRACTS section 1: concatenate literals and vars in token order. */
export function reconstruct(tokens: Token[], vars: string[]): string {
  let vi = 0;
  let out = '';
  for (const t of tokens) out += t.slot ? (vars[vi++] ?? '') : (t.lit ?? '');
  return out;
}

/** Spec 8.4 lineage span computation. Byte offsets, [start, end). */
export function computeSpans(tokens: Token[], vars: string[]): Record<string, Span> {
  const spans: Record<string, Span> = {};
  let offset = 0;
  let vi = 0;
  for (const t of tokens) {
    if (!t.slot) {
      offset += byteLen(t.lit ?? '');
    } else {
      const v = vars[vi++] ?? '';
      const n = byteLen(v);
      spans[t.slot] = [offset, offset + n];
      offset += n;
    }
  }
  return spans;
}

export interface RawSegment {
  text: string;
  /** Slot this run of bytes came from, or null for template literal bytes. */
  slot: string | null;
  start: number;
  end: number;
}

/**
 * Split a raw line into segments aligned to slot byte spans, so the viewer can
 * highlight exactly the bytes a field came from.
 */
export function segmentRaw(raw: string, spans: Record<string, Span>): RawSegment[] {
  const bytes = enc.encode(raw);
  const ordered = Object.entries(spans).sort((a, b) => a[1][0] - b[1][0]);
  const segments: RawSegment[] = [];
  let cursor = 0;
  const push = (start: number, end: number, slot: string | null) => {
    if (end <= start) return;
    segments.push({ text: dec.decode(bytes.subarray(start, end)), slot, start, end });
  };
  for (const [slot, [start, end]] of ordered) {
    if (start < cursor) continue; // overlapping spans would be an engine bug; skip defensively
    push(cursor, start, null);
    push(start, end, slot);
    cursor = end;
  }
  push(cursor, bytes.length, null);
  return segments;
}

/** Exact bytes a span covers, decoded for display. */
export function sliceBytes(raw: string, span: Span): string {
  return dec.decode(enc.encode(raw).subarray(span[0], span[1]));
}

/** Slot type -> CSS class suffix used to colour slots consistently everywhere. */
export function typeClass(type: string | undefined): string {
  switch (type) {
    case 'ip': case 'ipv4': case 'ipv6': return 'ip';
    case 'port': case 'int': case 'epoch_ts': return 'num';
    case 'syslog3164_ts': case 'iso8601_ts': return 'ts';
    case 'enum': return 'enum';
    case 'hostname': case 'mac': return 'host';
    case 'quoted': case 'text': return 'text';
    case 'ws': return 'ws';
    default: return 'word';
  }
}

/** Value at a dotted OCSF path, for showing what a field currently holds. */
export function atPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  );
}
