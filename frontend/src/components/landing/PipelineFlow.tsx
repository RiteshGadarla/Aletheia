// The eight-stage data path from docs/architecture.md as a rail with packets flowing through it.
// Stages 3 to 7 run inside the stateless Go worker; 5 and 6 are where an event can fall back to raw.
import { motion } from 'motion/react';

const STAGES = [
  { name: 'Collectors', tech: 'Vector', note: 'exact bytes in, metadata in headers' },
  { name: 'Ingest bus', tech: 'Redpanda', note: 'on disk before any parsing' },
  { name: 'Evidence stamp', tech: 'worker', note: 'ULID, SHA-256, Merkle leaf' },
  { name: 'Envelope decoder', tech: 'worker', note: 'RFC 3164 / 5424, CEF, LEEF' },
  { name: 'Template matcher', tech: 'worker', note: 'index lookup + anchored RE2', exit: 'no match: kept raw, sent to onboarding' },
  { name: 'Reconstruct + verify', tech: 'worker', note: 'rebuild, compare hashes', exit: 'mismatch: kept raw, flagged' },
  { name: 'OCSF normalizer', tech: 'worker', note: 'typed values, class, mapping' },
  { name: 'Sinks', tech: 'ClickHouse · Loki · Kafka', note: 'plus Splunk HEC, CEF, Parquet' },
];

export function PipelineFlow() {
  return (
    <div className="flow">
      <div className="flow-worker" aria-hidden="true"><span>Go worker · stateless, scaled by replicas</span></div>
      <div className="flow-rail" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => <span key={i} className="flow-packet" style={{ animationDelay: `${i * -1.3}s` }} />)}
      </div>
      <ol className="flow-stages">
        {STAGES.map((s, i) => (
          <motion.li
            key={s.name}
            className={`flow-stage${s.exit ? ' has-exit' : ''}`}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.5 }}
            transition={{ duration: 0.5, delay: i * 0.07, ease: [0.16, 1, 0.3, 1] }}
          >
            <span className="flow-node" aria-hidden="true">{i + 1}</span>
            <strong>{s.name}</strong>
            <span className="flow-tech">{s.tech}</span>
            <span className="flow-note">{s.note}</span>
            {s.exit && <span className="flow-exit">↳ {s.exit}</span>}
          </motion.li>
        ))}
      </ol>
    </div>
  );
}
