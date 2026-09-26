// The dashboard pages as a typographic index: numbered rows, hairlines, no cards.
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';

export interface ConsolePage { to: string; icon: ReactNode; title: string; desc: string }

export function ConsoleIndex({ pages }: { pages: ConsolePage[] }) {
  const navigate = useNavigate();
  return (
    <ol className="cindex">
      {pages.map((p, i) => (
        <motion.li
          key={p.to}
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ duration: 0.5, delay: (i % 2) * 0.08, ease: [0.16, 1, 0.3, 1] }}
        >
          <button type="button" className="cindex-row" onClick={() => navigate(p.to)}>
            <span className="cindex-num">{String(i + 1).padStart(2, '0')}</span>
            <span className="cindex-icon" aria-hidden="true">{p.icon}</span>
            <span className="cindex-body">
              <span className="cindex-title">{p.title}</span>
              <span className="cindex-desc">{p.desc}</span>
            </span>
            <span className="cindex-arrow" aria-hidden="true">→</span>
          </button>
        </motion.li>
      ))}
    </ol>
  );
}
