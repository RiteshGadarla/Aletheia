import { typeClass } from '../lib/lineage';
import type { Token } from '../lib/types';

const LEGEND: { label: string; cls: string }[] = [
  { label: 'ip', cls: 'ip' },
  { label: 'int / port', cls: 'num' },
  { label: 'timestamp', cls: 'ts' },
  { label: 'enum', cls: 'enum' },
  { label: 'hostname / mac', cls: 'host' },
  { label: 'text / quoted', cls: 'text' },
  { label: 'word', cls: 'word' },
  { label: 'whitespace', cls: 'ws' },
];

export function SlotLegend() {
  return (
    <div className="legend">
      {LEGEND.map((l) => (
        <span key={l.cls}>
          <i style={{ background: `var(--t-${l.cls})` }} />
          {l.label}
        </span>
      ))}
    </div>
  );
}

/** Token list with slots coloured by type (spec 6.14, Studio screens). */
export function TemplateView({
  tokens, active, onActive,
}: { tokens: Token[]; active?: string | null; onActive?: (slot: string | null) => void }) {
  return (
    <div className="stack-sm">
      <div className="tokens">
        {tokens.map((t, i) =>
          t.slot ? (
            <span
              key={i}
              className={`slot slot-${typeClass(t.type)}${active === t.slot ? ' hit' : ''}`}
              title={t.values ? `values: ${t.values.join(' | ')}` : t.pattern ? `pattern: ${t.pattern}` : t.type}
              onMouseEnter={() => onActive?.(t.slot!)}
              onMouseLeave={() => onActive?.(null)}
            >
              {t.slot}<span className="ty">:{t.type}</span>
            </span>
          ) : (
            <span key={i} className="lit">{t.lit}</span>
          ),
        )}
      </div>
      <SlotLegend />
    </div>
  );
}
