// The design pillars as a hash chain: each seal is SHA-256 over the previous seal and the row's
// text, like Aletheia's Merkle chain. "Tamper" edits one word and every later seal breaks.
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { sha256 } from '../../lib/sha256';

export interface Pillar { icon: ReactNode; title: string; desc: string }

const GENESIS = '0'.repeat(64);
// The single edit the demo makes: row 0, one word.
const TAMPER = { row: 0, from: 'Nothing is ever dropped', to: 'Almost nothing is dropped' };

const chain = (rows: { title: string; desc: string }[]) => {
  let prev = GENESIS;
  return rows.map((r) => (prev = sha256(`${prev}\n${r.title}\n${r.desc}`)));
};
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

export function SealedLedger({ pillars }: { pillars: Pillar[] }) {
  const [tampered, setTampered] = useState(false);
  const sealed = useMemo(() => chain(pillars), [pillars]);
  const rows = useMemo(() => pillars.map((p, i) => (
    tampered && i === TAMPER.row ? { ...p, desc: p.desc.replace(TAMPER.from, TAMPER.to) } : p
  )), [pillars, tampered]);
  const current = useMemo(() => chain(rows), [rows]);
  const broken = current.findIndex((h, i) => h !== sealed[i]);

  return (
    <div className={`ledger${tampered ? ' is-tampered' : ''}`}>
      <div className="ledger-bar">
        <span className="ledger-status">
          <span className={`ledger-dot${broken >= 0 ? ' bad' : ''}`} aria-hidden="true" />
          {broken >= 0
            ? `Chain broken at §0${broken + 1}: ${pillars.length - broken} seals no longer match`
            : `${pillars.length} rows sealed, chain intact`}
        </span>
        <button type="button" className="ledger-btn" onClick={() => setTampered((t) => !t)}>
          {tampered ? 'Restore the original' : 'Tamper with one word'}
        </button>
      </div>

      <ol className="ledger-rows">
        {rows.map((r, i) => {
          const bad = broken >= 0 && i >= broken;
          return (
            <motion.li
              key={r.title}
              className={`ledger-row${bad ? ' bad' : ''}`}
              initial={{ opacity: 0, x: -18 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: 0.55, delay: i * 0.06, ease: [0.16, 1, 0.3, 1] }}
            >
              <span className="ledger-idx">§0{i + 1}</span>
              <span className="ledger-icon" aria-hidden="true">{r.icon}</span>
              <div className="ledger-text">
                <h3>{r.title}</h3>
                <p>
                  {tampered && i === TAMPER.row
                    ? <>{r.desc.split(TAMPER.to)[0]}<mark>{TAMPER.to}</mark>{r.desc.split(TAMPER.to)[1]}</>
                    : r.desc}
                </p>
              </div>
              <div className="ledger-seal" title={current[i]}>
                <span className="ledger-seal-k">{bad ? 'recomputed' : 'seal'}</span>
                <code>{short(current[i])}</code>
                {bad && <code className="ledger-seal-was">sealed {short(sealed[i])}</code>}
              </div>
            </motion.li>
          );
        })}
      </ol>
    </div>
  );
}
