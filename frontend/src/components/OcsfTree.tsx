import { Fragment } from 'react';

interface Props {
  value: unknown;
  /** OCSF dotted path -> slot name, for the fields that came from raw bytes. */
  fieldMap: Record<string, string>;
  active: string | null;
  onActive: (slot: string | null) => void;
  onPick: (slot: string | null) => void;
  prefix?: string;
}

function valueClass(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'boolean') return 'bool';
  return 'str';
}

const render = (v: unknown): string =>
  typeof v === 'string' ? JSON.stringify(v) : v === null ? 'null' : String(v);

/** OCSF object as a tree; leaves that came from raw bytes link back to their slot. */
export function OcsfTree({ value, fieldMap, active, onActive, onPick, prefix = '' }: Props) {
  if (value === null || typeof value !== 'object') return null;
  const entries = Object.entries(value as Record<string, unknown>);

  return (
    <div className={prefix ? 'node' : 'tree'}>
      {entries.map(([k, v]) => {
        const path = prefix ? `${prefix}.${k}` : k;
        const isObj = v !== null && typeof v === 'object' && !Array.isArray(v);
        if (isObj) {
          return (
            <Fragment key={path}>
              <div className="leaf"><span className="key group">{k}</span></div>
              <OcsfTree
                value={v}
                fieldMap={fieldMap}
                active={active}
                onActive={onActive}
                onPick={onPick}
                prefix={path}
              />
            </Fragment>
          );
        }
        const slot = fieldMap[path];
        const hit = !!slot && slot === active;
        return (
          <div
            key={path}
            className={`leaf ${slot ? 'linked' : ''} ${hit ? 'hit' : ''}`}
            title={slot ? `${path} came from slot ${slot}` : path}
            onMouseEnter={() => slot && onActive(slot)}
            onMouseLeave={() => slot && onActive(null)}
            onClick={() => slot && onPick(slot)}
          >
            <span className={`key ${slot ? 'linked' : ''}`}>{k}:</span>
            <span className={`val ${valueClass(v)}`}>{Array.isArray(v) ? JSON.stringify(v) : render(v)}</span>
            {slot && <span className="slotref">&larr; {slot}</span>}
          </div>
        );
      })}
    </div>
  );
}
