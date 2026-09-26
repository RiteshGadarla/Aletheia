// Requirements (a) to (k) of PS 26156 as a traceability matrix; each tick draws in on scroll.
import { motion } from 'motion/react';

export interface Req { id: string; title: string; desc: string }

export function TraceMatrix({ reqs }: { reqs: Req[] }) {
  return (
    <div className="trace" role="table" aria-label="Requirement traceability">
      <div className="trace-row trace-head" role="row">
        <span role="columnheader">Req</span>
        <span role="columnheader">Requirement</span>
        <span role="columnheader">How Aletheia meets it</span>
        <span role="columnheader" className="trace-met">Met</span>
      </div>
      {reqs.map((r, i) => (
        <motion.div
          key={r.id}
          className="trace-row"
          role="row"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, amount: 0.8 }}
          transition={{ duration: 0.4 }}
        >
          <span role="cell" className="trace-id">({r.id})</span>
          <strong role="cell">{r.title}</strong>
          <span role="cell" className="trace-how">{r.desc}</span>
          <span role="cell" className="trace-met">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-label="met">
              <motion.path
                d="M4 12.5l5 5L20 6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ pathLength: 0 }}
                whileInView={{ pathLength: 1 }}
                viewport={{ once: true, amount: 0.8 }}
                transition={{ duration: 0.45, delay: 0.15 + (i % 3) * 0.05, ease: 'easeOut' }}
              />
            </svg>
          </span>
        </motion.div>
      ))}
    </div>
  );
}
