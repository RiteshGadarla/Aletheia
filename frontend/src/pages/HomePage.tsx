// Aletheia product landing page — standalone, no sidebar.
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useTheme } from '../lib/theme';
import {
  IconEvents, IconSources, IconLineage, IconDemo, IconSettings,
  IconShield, IconCheck, IconAlert, IconSpinner, IconMoon, IconSun,
} from '../components/Icons';
import type { ReactNode } from 'react';

/* ---------------------------------------------------------------- helpers */

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="lp-stat">
      <span className="lp-stat-val">{typeof value === 'number' ? value.toLocaleString() : value}</span>
      <span className="lp-stat-label">{label}</span>
      {sub && <span className="lp-stat-sub">{sub}</span>}
    </div>
  );
}

function FeatureCard({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="lp-feature">
      <span className="lp-feature-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{desc}</p>
    </div>
  );
}

function NavCard({ to, icon, title, desc }: { to: string; icon: ReactNode; title: string; desc: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="lp-nav-card" onClick={() => navigate(to)}>
      <span className="lp-nav-icon">{icon}</span>
      <span className="lp-nav-body">
        <strong>{title}</strong>
        <span>{desc}</span>
      </span>
      <span className="lp-nav-arrow" aria-hidden="true">→</span>
    </button>
  );
}

/* ---------------------------------------------------------------- data */

const PILLARS = [
  { icon: '🔒', title: 'Lossless Preservation', desc: 'Every byte of the original log is preserved and recoverable. SHA-256 verified reconstruction ensures forensic-grade integrity.' },
  { icon: '🧬', title: 'Template Engine', desc: 'One parse yields normalization, compression and exact reconstruction simultaneously. Literals stored once, variables per event.' },
  { icon: '🔗', title: 'Byte-Level Lineage', desc: 'Trace any normalized OCSF field back to the exact byte offsets in the original raw log line.' },
  { icon: '🛡️', title: 'Tamper Evidence', desc: 'Per-minute Merkle roots chained over time with Ed25519 signed daily anchors. Alteration breaks every later link.' },
  { icon: '⚡', title: 'Deterministic Pipeline', desc: 'No ML on the hot path. Compiled RE2 with linear-time matching. Every result is reproducible.' },
  { icon: '🌐', title: 'Air-Gap Ready', desc: 'Ships as OCI containers. No cloud dependencies, no telemetry, no internet access required at install or runtime.' },
];

const SOURCES = [
  'Cisco ASA', 'FortiGate', 'pfSense / OPNsense', 'Suricata IDS',
  'OpenVPN', 'Squid Proxy', 'CEF (Generic)', 'LEEF (Generic)',
];

const TECH = [
  { name: 'Go Engine', desc: 'Stateless workers, horizontally scaled' },
  { name: 'Redpanda', desc: 'Kafka-compatible durable ingest bus' },
  { name: 'ClickHouse', desc: 'Columnar system of record, billions of rows' },
  { name: 'PostgreSQL', desc: 'Metadata, packs, Merkle roots, audit log' },
  { name: 'Python Studio', desc: 'Drain3 clustering, FastAPI onboarding' },
  { name: 'Vector', desc: 'Fan-out to Loki, Splunk HEC, CEF syslog' },
  { name: 'MinIO', desc: 'S3-compatible Parquet data lake exports' },
  { name: 'Grafana + Loki', desc: 'Live operational dashboards' },
];

const REQS: { id: string; title: string; desc: string }[] = [
  { id: 'a', title: 'Preserve raw without loss', desc: 'Raw bytes committed to bus and hashed before any parsing' },
  { id: 'b', title: 'Extract source attributes', desc: 'Templates capture every variable; unmapped kept in unmapped{}' },
  { id: 'c', title: 'Normalize to taxonomy', desc: 'OCSF classes and fields, pinned version across all sources' },
  { id: 'd', title: 'Traceability', desc: 'event_uid, raw_sha256, byte-level lineage, pack versioning' },
  { id: 'e', title: 'Plug-and-play onboarding', desc: 'YAML parser packs, Sources UI, hot reload — no restarts' },
  { id: 'f', title: 'Unified visibility', desc: 'One schema across sources in ClickHouse, Grafana and Loki' },
  { id: 'g', title: 'SIEM / Data Lake integration', desc: 'Kafka, Splunk HEC, CEF re-emit, Loki, Parquet on MinIO' },
  { id: 'h', title: 'AI/ML ready', desc: 'Typed columns, Parquet exports partitioned by class and date' },
  { id: 'i', title: 'Reduced parser effort', desc: 'Automatic template derivation, slot typing, mapping proposals' },
  { id: 'j', title: 'Air-gapped deployment', desc: 'docker save/load, nothing downloaded at runtime, telemetry off' },
  { id: 'k', title: 'Containerized', desc: 'Per-component images with Compose or Helm, amd64 and arm64' },
];

/* ================================================================ page */

export function HomePage() {
  const navigate = useNavigate();
  const events = useAsync(() => api.listEvents({ limit: 1 }), []);
  const packs = useAsync(() => api.verifyPacks(), []);
  const { theme, toggle } = useTheme();

  const loading = events.loading || packs.loading;
  const totalEvents = events.data?.total ?? 0;
  const sourceCount = events.data?.sources?.length ?? 0;
  const classCount = events.data?.classes?.length ?? 0;
  const packsOk = packs.data?.ok ?? false;
  const samplesVerified = packs.data?.reconstructed ?? 0;
  const samplesTotal = packs.data?.samples ?? 0;

  return (
    <div className="lp">
      {/* ---- top bar ---- */}
      <header className="lp-topbar">
        <div className="lp-topbar-inner">
          <div className="lp-brand">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
              <path d="M12 8.2l3.4 7.6H8.6z" />
            </svg>
            <span>Aletheia</span>
          </div>
          <nav className="lp-topnav">
            <a href="#features">Features</a>
            <a href="#architecture">Architecture</a>
            <a href="#sources">Sources</a>
            <a href="#requirements">Requirements</a>
            <button type="button" className="lp-theme-btn" onClick={toggle} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              {theme === 'dark' ? <IconMoon size={15} /> : <IconSun size={15} />}
            </button>
            <button type="button" className="lp-cta-btn" onClick={() => navigate('/dashboard')}>
              Open Dashboard →
            </button>
          </nav>
        </div>
      </header>

      {/* ---- hero ---- */}
      <section className="lp-hero">
        <div className="lp-hero-bg" aria-hidden="true" />
        <div className="lp-hero-inner">
          <div className="lp-hero-badge">SIH 2026 · Problem Statement 26156</div>
          <h1>Universal Lossless Log<br />Pre-processing Framework</h1>
          <p className="lp-hero-tag">Normalize everything. Lose nothing. Prove it.</p>
          <p className="lp-hero-sub">
            Aletheia learns a template for each log format, stores every event as that template plus its
            variable values, and uses this single representation for <strong>normalization</strong>,{' '}
            <strong>compression</strong> and <strong>exact reconstruction</strong> of the original — all
            verified by SHA-256 hashes sealed into tamper-evident Merkle chains.
          </p>
          <div className="lp-hero-actions">
            <button type="button" className="lp-btn primary" onClick={() => navigate('/dashboard')}>
              Open Dashboard
            </button>
            <button type="button" className="lp-btn secondary" onClick={() => navigate('/dashboard/demo')}>
              Run Demo Scenarios
            </button>
          </div>
        </div>
      </section>

      {/* ---- live stats ---- */}
      <section className="lp-section">
        <div className="lp-section-inner">
          <div className="lp-stats-bar">
            <div className="lp-stats-status">
              {loading ? <IconSpinner size={14} /> : packsOk ? <IconCheck size={14} /> : <IconAlert size={14} />}
              <span>{loading ? 'Checking…' : packsOk ? 'Engine Healthy' : 'Degraded'}</span>
            </div>
            <div className="lp-stats-grid">
              <Stat label="Events Ingested" value={totalEvents} />
              <Stat label="Active Sources" value={sourceCount} />
              <Stat label="OCSF Classes" value={classCount} />
              <Stat label="Packs Verified" value={`${samplesVerified}/${samplesTotal}`} sub="byte-exact" />
            </div>
          </div>
        </div>
      </section>

      {/* ---- the core insight ---- */}
      <section className="lp-section lp-insight" id="features">
        <div className="lp-section-inner">
          <h2>The Core Insight</h2>
          <p className="lp-section-sub">One parse. Three results. Zero loss.</p>
          <div className="lp-code-block">
            <div className="lp-code-label">Cisco ASA log line → Template + Variables</div>
            <pre><code>{`Raw:    <166>Sep 19 14:31:02 fw01 %ASA-6-302013: Built outbound TCP connection 1234
        for outside:203.0.113.5/443 to inside:10.0.0.5/52144

Template (stored once):
        "<" PRI ">" TS " " HOST " %ASA-6-302013: Built " DIR " TCP connection "
        CONN_ID " for " IF_A ":" IP_A "/" PORT_A " to " IF_B ":" IP_B "/" PORT_B

Variables (stored per event):
        ["166", "Sep 19 14:31:02", "fw01", "outbound", "1234", "outside",
         "203.0.113.5", "443", "inside", "10.0.0.5", "52144"]

→  Normalization:  IP_A maps to dst_endpoint.ip, IP_B maps to src_endpoint.ip
→  Compression:    Long literals stored once; only short variables per event
→  Reconstruction: Template literals + variables = exact original bytes ✓`}</code></pre>
          </div>
        </div>
      </section>

      {/* ---- design pillars ---- */}
      <section className="lp-section">
        <div className="lp-section-inner">
          <h2>Design Pillars</h2>
          <p className="lp-section-sub">Six guarantees that define the architecture.</p>
          <div className="lp-features-grid">
            {PILLARS.map((p) => (
              <FeatureCard key={p.title} icon={p.icon} title={p.title} desc={p.desc} />
            ))}
          </div>
        </div>
      </section>

      {/* ---- architecture ---- */}
      <section className="lp-section lp-arch" id="architecture">
        <div className="lp-section-inner">
          <h2>Architecture &amp; Technology Stack</h2>
          <p className="lp-section-sub">Eight-stage pipeline from raw syslog to normalized, verified, queryable events.</p>
          <div className="lp-pipeline">
            {['Collectors (Vector)', 'Ingest Bus (Redpanda)', 'Evidence Stamp', 'Envelope Decoder',
              'Template Matcher', 'Extract · Reconstruct · Verify', 'OCSF Normalizer', 'Storage & Sinks'].map((s, i) => (
              <div key={s} className="lp-pipeline-step">
                <span className="lp-pipeline-num">{i + 1}</span>
                <span className="lp-pipeline-name">{s}</span>
              </div>
            ))}
          </div>
          <div className="lp-tech-grid">
            {TECH.map((t) => (
              <div key={t.name} className="lp-tech">
                <strong>{t.name}</strong>
                <span>{t.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- supported sources ---- */}
      <section className="lp-section" id="sources">
        <div className="lp-section-inner">
          <h2>Supported Sources (Prototype)</h2>
          <p className="lp-section-sub">Perimeter network devices — extensible to any log format via parser packs.</p>
          <div className="lp-sources-grid">
            {SOURCES.map((s) => (
              <div key={s} className="lp-source-chip">{s}</div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- requirements traceability ---- */}
      <section className="lp-section lp-reqs" id="requirements">
        <div className="lp-section-inner">
          <h2>Requirement Traceability (a – k)</h2>
          <p className="lp-section-sub">Every requirement from PS 26156 is addressed and verifiable.</p>
          <div className="lp-reqs-grid">
            {REQS.map((r) => (
              <div key={r.id} className="lp-req">
                <span className="lp-req-id">{r.id}</span>
                <div>
                  <strong>{r.title}</strong>
                  <span>{r.desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- console nav cards ---- */}
      <section className="lp-section">
        <div className="lp-section-inner">
          <h2>Explore the Console</h2>
          <p className="lp-section-sub">Every section of the pipeline has a dedicated interface.</p>
          <div className="lp-nav-grid">
            <NavCard to="/dashboard/events" icon={<IconEvents size={20} />} title="Events Explorer" desc="Unified OCSF table — filter, search and paginate all sources." />
            <NavCard to="/dashboard/sources" icon={<IconSources size={20} />} title="Sources" desc="Connect log systems, then approve, reject or retry the mapping." />
            <NavCard to="/dashboard/lineage" icon={<IconLineage size={20} />} title="Lineage Viewer" desc="Byte provenance for every normalized field." />
            <NavCard to="/dashboard/demo" icon={<IconDemo size={20} />} title="Demo Console" desc="Run the nine demonstration scenarios." />
            <NavCard to="/dashboard/settings" icon={<IconSettings size={20} />} title="Settings" desc="LLM provider, air-gap mode, connection test." />
          </div>
        </div>
      </section>

      {/* ---- footer ---- */}
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
              <path d="M12 8.2l3.4 7.6H8.6z" />
            </svg>
            <span>Aletheia</span>
          </div>
          <div className="lp-footer-meta">
            <span>Smart India Hackathon · PS 26156</span>
            <span className="lp-dot">·</span>
            <span>OCSF v1.3</span>
            <span className="lp-dot">·</span>
            <span><IconShield size={12} /> Byte-exact · Merkle-sealed</span>
          </div>
          <div className="lp-footer-tagline">ἀλήθεια — Greek for "truth", literally "un-concealment": nothing hidden, nothing lost.</div>
        </div>
      </footer>
    </div>
  );
}
