// Measured results as a readout column plus a terminal that replays them when scrolled into view.
// Every figure is from docs/benchmarks.md (i7-1360P); the terminal output is condensed from it.
import { useEffect, useRef, useState } from 'react';
import { useInView } from 'motion/react';
import { CountUp } from '../CountUp';

const READOUTS: { to?: number; text?: string; unit: string; label: string }[] = [
  { to: 19329, unit: 'events/s', label: 'one worker, in-memory engine path (46,040 on eight)' },
  { text: '0', unit: 'mismatches', label: 'across 2.04 M events rebuilt and hash-checked' },
  { text: '0', unit: 'dropped', label: 'of 120,000 generated: stored count equals sent count' },
  { to: 0.27, unit: 's', label: 'to find one tampered byte, naming the exact batch and event' },
];

type Line = { kind: 'cmd' | 'out' | 'ok' | 'bad' | 'dim'; text: string };
const SCRIPT: Line[] = [
  { kind: 'cmd', text: 'aletheia bench --workers 1,2,4,8 --duration 15s' },
  { kind: 'dim', text: 'workers        eps     verified   mismatches' },
  { kind: 'out', text: '      1     19,329      290,048            0' },
  { kind: 'out', text: '      2     32,947      494,592            0' },
  { kind: 'out', text: '      4     37,712      566,272            0' },
  { kind: 'out', text: '      8     46,040      691,712            0' },
  { kind: 'cmd', text: 'aletheia verify --source asa   # after flipping one stored byte' },
  { kind: 'bad', text: 'FAIL batch asa/p0/2026-09-20T07:17Z  leaf count differs' },
  { kind: 'bad', text: 'FAIL event 01M2YTV0RH6T5GETAM758Y6KHM  stored ce35f333…  recomputed 922fda40…' },
  { kind: 'ok', text: 'detected in 0.27 s over 593 events, exit 1' },
];

function Terminal() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [line, setLine] = useState(reduce ? SCRIPT.length : 0);
  const [chars, setChars] = useState(0);

  // Commands type out character by character; output lines land whole.
  useEffect(() => {
    if (!inView || line >= SCRIPT.length) return;
    const cur = SCRIPT[line];
    if (cur.kind === 'cmd' && chars < cur.text.length) {
      const t = window.setTimeout(() => setChars((c) => c + 1), 22);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => { setLine((l) => l + 1); setChars(0); }, cur.kind === 'cmd' ? 380 : 140);
    return () => window.clearTimeout(t);
  }, [inView, line, chars]);

  return (
    <div className="term" ref={ref}>
      <div className="term-head">
        <span>aletheia</span>
        <span className="term-src">condensed from docs/benchmarks.md</span>
      </div>
      <pre className="term-body" aria-label="Benchmark and tamper-detection output">
        {SCRIPT.map((l, i) => {
          // Finished lines print whole; the current command is mid-typing; later lines wait.
          const typing = i === line;
          if (i > line || (typing && l.kind !== 'cmd')) return null;
          return (
            <span key={i} className={`term-${l.kind}`}>
              {l.kind === 'cmd' && <span className="term-prompt">$ </span>}
              {typing ? l.text.slice(0, chars) : l.text}
              {typing && <span className="term-caret" aria-hidden="true" />}
              {'\n'}
            </span>
          );
        })}
        {line >= SCRIPT.length && <span className="term-cmd"><span className="term-prompt">$ </span><span className="term-caret" aria-hidden="true" /></span>}
      </pre>
    </div>
  );
}

export function ProofTerminal() {
  return (
    <div className="lp-proof">
      <dl className="lp-proof-readouts">
        {READOUTS.map((r) => (
          <div key={r.unit} className="lp-proof-readout">
            <dt>
              {r.to !== undefined ? <CountUp to={r.to} separator="," duration={1.6} /> : r.text}
              <span className="lp-proof-unit">{r.unit}</span>
            </dt>
            <dd>{r.label}</dd>
          </div>
        ))}
      </dl>
      <Terminal />
    </div>
  );
}
