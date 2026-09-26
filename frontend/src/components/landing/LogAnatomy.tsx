// One real Cisco ASA line (golden sample asa_302013/outbound_https) taken apart three ways.
// Slots and OCSF paths come from backend/packs/cisco_asa.yaml; the hashes are computed live.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useInView } from 'motion/react';
import { sha256 } from '../../lib/sha256';
import { DecryptedText } from '../DecryptedText';

type SlotType = 'num' | 'ts' | 'host' | 'enum' | 'ip' | 'word';
interface Seg { t: string; slot?: string; type?: SlotType; ocsf?: string }

const RAW = '<166>Sep 19 14:31:02 fw01 %ASA-6-302013: Built outbound TCP connection 1234 for outside:203.0.113.5/443 (203.0.113.5/443) to inside:10.0.0.5/52144 (198.51.100.7/52144)';

const SEGS: Seg[] = [
  { t: '<' }, { t: '166', slot: 'pri', type: 'num', ocsf: 'envelope: syslog priority' }, { t: '>' },
  { t: 'Sep 19 14:31:02', slot: 'ts', type: 'ts', ocsf: 'metadata.original_time' }, { t: ' ' },
  { t: 'fw01', slot: 'host', type: 'host', ocsf: 'metadata.log_name' },
  { t: ' %ASA-6-302013: Built ' },
  { t: 'outbound', slot: 'direction', type: 'enum', ocsf: 'connection_info.direction_id' },
  { t: ' TCP connection ' },
  { t: '1234', slot: 'conn_id', type: 'num', ocsf: 'connection_info.uid' },
  { t: ' for ' },
  { t: 'outside', slot: 'if_a', type: 'word', ocsf: 'dst_endpoint.interface_name' }, { t: ':' },
  { t: '203.0.113.5', slot: 'ip_a', type: 'ip', ocsf: 'dst_endpoint.ip' }, { t: '/' },
  { t: '443', slot: 'port_a', type: 'num', ocsf: 'dst_endpoint.port' }, { t: ' (' },
  { t: '203.0.113.5', slot: 'mip_a', type: 'ip', ocsf: 'unmapped.mip_a' }, { t: '/' },
  { t: '443', slot: 'mport_a', type: 'num', ocsf: 'unmapped.mport_a' }, { t: ') to ' },
  { t: 'inside', slot: 'if_b', type: 'word', ocsf: 'src_endpoint.interface_name' }, { t: ':' },
  { t: '10.0.0.5', slot: 'ip_b', type: 'ip', ocsf: 'src_endpoint.ip' }, { t: '/' },
  { t: '52144', slot: 'port_b', type: 'num', ocsf: 'src_endpoint.port' }, { t: ' (' },
  { t: '198.51.100.7', slot: 'mip_b', type: 'ip', ocsf: 'unmapped.mip_b' }, { t: '/' },
  { t: '52144', slot: 'mport_b', type: 'num', ocsf: 'unmapped.mport_b' }, { t: ')' },
];

const LENSES = [
  { id: 'normalize', label: 'Normalize', note: 'Every slot has a meaning, so it lands in a typed OCSF field.' },
  { id: 'compress', label: 'Compress', note: 'The literal text is the template, stored once. Only the variables repeat per event.' },
  { id: 'reconstruct', label: 'Reconstruct', note: 'Literals + variables rebuild the line, and the hash proves it byte for byte.' },
] as const;
type Lens = (typeof LENSES)[number]['id'];

const bytes = (s: string) => new TextEncoder().encode(s).length;

export function LogAnatomy() {
  const [lens, setLens] = useState<Lens>('normalize');
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });

  // Cycle the lenses while on screen until the visitor picks one.
  useEffect(() => {
    if (!inView || pinned || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = window.setInterval(() => {
      setLens((l) => LENSES[(LENSES.findIndex((x) => x.id === l) + 1) % LENSES.length].id);
    }, 5200);
    return () => window.clearInterval(t);
  }, [inView, pinned]);

  const facts = useMemo(() => {
    const rebuilt = SEGS.map((s) => s.t).join('');
    const literal = SEGS.filter((s) => !s.slot).map((s) => s.t).join('');
    const vars = SEGS.filter((s) => s.slot).map((s) => s.t);
    return {
      rawHash: sha256(RAW),
      rebuiltHash: sha256(rebuilt),
      rawBytes: bytes(RAW),
      literalBytes: bytes(literal),
      varBytes: vars.reduce((n, v) => n + bytes(v), 0),
      vars,
    };
  }, []);
  const same = facts.rawHash === facts.rebuiltHash;

  const pick = (l: Lens) => { setLens(l); setPinned(true); };

  return (
    <div className={`anat anat-${lens}`} ref={ref}>
      <div className="anat-tabs" role="tablist" aria-label="Ways to read one log line">
        {LENSES.map((l, i) => (
          <button
            key={l.id}
            type="button"
            role="tab"
            aria-selected={lens === l.id}
            className={`anat-tab${lens === l.id ? ' on' : ''}`}
            onClick={() => pick(l.id)}
          >
            <span className="anat-tab-num">0{i + 1}</span>
            {l.label}
            {lens === l.id && !pinned && <span className="anat-tab-timer" aria-hidden="true" />}
          </button>
        ))}
      </div>

      <p className="anat-note">{LENSES.find((l) => l.id === lens)?.note}</p>

      <div className="anat-line" aria-label={RAW}>
        {SEGS.map((s, i) => s.slot ? (
          <span
            key={i}
            className={`anat-slot t-${s.type}${hover === s.slot ? ' hot' : ''}`}
            onMouseEnter={() => setHover(s.slot ?? null)}
            onMouseLeave={() => setHover(null)}
            aria-hidden="true"
          >
            {s.t}
            <span className="anat-slot-name">{s.slot}</span>
          </span>
        ) : (
          <span key={i} className="anat-lit" aria-hidden="true">{s.t}</span>
        ))}
      </div>

      <div className="anat-panel" key={lens}>
        {lens === 'normalize' && (
          <ul className="anat-map">
            {SEGS.filter((s) => s.slot).map((s) => (
              <li
                key={s.slot}
                className={hover === s.slot ? 'hot' : undefined}
                onMouseEnter={() => setHover(s.slot ?? null)}
                onMouseLeave={() => setHover(null)}
              >
                <code className={`t-${s.type}`}>{s.t}</code>
                <span className="anat-arrow" aria-hidden="true">→</span>
                <code className="anat-path">{s.ocsf}</code>
              </li>
            ))}
          </ul>
        )}

        {lens === 'compress' && (
          <div className="anat-split">
            <div>
              <span className="anat-k">template asa_302013</span>
              <strong>{facts.literalBytes} bytes</strong>
              <span>of literal text, stored once for every event of this type</span>
            </div>
            <div>
              <span className="anat-k">variables</span>
              <strong>{facts.varBytes} bytes</strong>
              <span>stored per event, as typed values</span>
            </div>
            <code className="anat-vars">[{facts.vars.map((v) => `"${v}"`).join(', ')}]</code>
          </div>
        )}

        {lens === 'reconstruct' && (
          <div className="anat-hashes">
            <div>
              <span className="anat-k">sha256(raw, on arrival)</span>
              <DecryptedText text={facts.rawHash} animateOn="view" sequential speed={12} characters="0123456789abcdef" parentClassName="anat-hash" encryptedClassName="anat-hash-enc" />
            </div>
            <div>
              <span className="anat-k">sha256(literals + variables)</span>
              <DecryptedText text={facts.rebuiltHash} animateOn="view" sequential speed={12} characters="0123456789abcdef" parentClassName="anat-hash" encryptedClassName="anat-hash-enc" />
            </div>
            <p className={same ? 'anat-verdict ok' : 'anat-verdict bad'}>
              {same
                ? `Identical. All ${facts.rawBytes} bytes rebuilt exactly, so this event is provably lossless.`
                : 'Different. The raw line would be kept exactly as received instead.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
