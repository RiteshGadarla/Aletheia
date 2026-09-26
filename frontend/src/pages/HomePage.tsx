// Aletheia product landing page — standalone, no sidebar. Copy tracks README.md and docs/.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../lib/theme';
import {
  IconEvents, IconSources, IconLineage, IconDemo, IconSettings, IconHome, IconLyra, IconExport,
  IconBell, IconShield, IconMoon, IconSun, IconLock, IconNested, IconLink, IconHash, IconCpu,
  IconOff, IconServer,
} from '../components/Icons';
import {
  SiGo, SiClickhouse, SiPostgresql, SiPython, SiFastapi, SiGrafana, SiPrometheus, SiNginx,
  SiDocker, SiMinio, SiApacheparquet, SiReact, SiTypescript,
} from 'react-icons/si';
import { GhostFibers } from '../components/GhostFibers';
import { SpecularButton } from '../components/SpecularButton';
import { BorderGlow } from '../components/BorderGlow';
import { LogoLoop } from '../components/LogoLoop';
import { ParticleText } from '../components/ParticleText';
import type { LogoItem } from '../components/LogoLoop';
import type { SpecularButtonProps } from '../components/SpecularButton';
import type { BorderGlowProps } from '../components/BorderGlow';
import type { ReactNode } from 'react';

/* ---------------------------------------------------------------- theme-bound colours */

// The shaders take hex, not CSS variables. backdrop mirrors --bg in tokens.css so the fibers
// fade into the page with no seam; keep the two in step if the palette changes.
const FIBERS = {
  dark: { lineColor: '#12306e', glowColor: '#2c5fd6', backdrop: '#0c1014', lightMode: false, ink: 0.3 },
  light: { lineColor: '#123f9e', glowColor: '#6aa5ff', backdrop: '#f4f6f9', lightMode: true, ink: 0.6 },
} as const;

type Spec = Pick<SpecularButtonProps, 'tint' | 'tintOpacity' | 'textColor' | 'lineColor' | 'baseColor'>;
const CTA: Record<'dark' | 'light', Spec> = {
  dark: { tint: '#2c5fd6', tintOpacity: 0.92, textColor: '#ffffff', lineColor: '#dbe8ff', baseColor: '#6aa5ff' },
  light: { tint: '#1c58c9', tintOpacity: 1, textColor: '#ffffff', lineColor: '#ffffff', baseColor: '#1749a8' },
};

// "Prove it." particles, in the accent: blue easing toward a lighter blue (dark) or violet (light).
const PROVE: Record<'dark' | 'light', { color: string; highlightColor: string }> = {
  dark: { color: '#6aa5ff', highlightColor: '#b9d0f4' },
  light: { color: '#1c58c9', highlightColor: '#4a3aa7' },
};

// Mesh colours are the categorical blue, teal and violet from tokens.css.
const GLOW: Record<'dark' | 'light', BorderGlowProps> = {
  dark: { glowColor: '217 90 70', colors: ['#6aa5ff', '#4fc9b6', '#9085e9'], lightSurface: false },
  light: { glowColor: '217 75 45', colors: ['#1c58c9', '#0a6f62', '#4a3aa7'], lightSurface: true },
};

/* ---------------------------------------------------------------- helpers */

function Box({ children, className }: { children: ReactNode; className?: string }) {
  const { theme } = useTheme();
  return (
    <BorderGlow
      {...GLOW[theme]}
      className={className}
      backgroundColor="var(--surface-2)"
      borderRadius={12}
      glowRadius={28}
      edgeSensitivity={28}
      glowIntensity={theme === 'dark' ? 1 : 0.6}
    >
      {children}
    </BorderGlow>
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

const RESULTS = [
  { title: 'Normalization', desc: 'Every variable slot has a meaning, so it maps to an OCSF field: IP_B becomes src_endpoint.ip.' },
  { title: 'Compression', desc: 'The literal text is stored once per template, not once per event. Only the variables repeat.' },
  { title: 'Reconstruction', desc: 'Literals + variables rebuild the original line byte for byte, checked against the SHA-256 taken on arrival.' },
];

const PILLARS: { icon: ReactNode; title: string; desc: string }[] = [
  { icon: <IconHash size={18} />, title: 'Hash before parse', desc: 'Raw bytes are hashed and written to the bus before anything is parsed. Nothing is ever dropped: a line that fails to match is stored verbatim.' },
  { icon: <IconNested size={18} />, title: 'Template engine', desc: 'One parse yields normalization, compression and exact reconstruction. Literals stored once, variables per event.' },
  { icon: <IconLink size={18} />, title: 'Byte-level lineage', desc: 'Trace any normalized OCSF field back to the exact byte offsets it came from in the original line.' },
  { icon: <IconShield size={18} />, title: 'Tamper evidence', desc: 'Per-minute Merkle roots chained over time, with Ed25519-signed daily anchors held off-system.' },
  { icon: <IconCpu size={18} />, title: 'Deterministic hot path', desc: 'Compiled RE2 with linear-time matching. No model ever touches a live event; AI only proposes mappings behind a gate.' },
  { icon: <IconOff size={18} />, title: 'Air-gap ready', desc: 'One image, nothing fetched at run time, telemetry off. A packet capture showed no outbound connections and no DNS lookups.' },
];

// docs/benchmarks.md — measured on an i7-1360P; every figure is reproducible with the bench harness.
const METRICS = [
  { value: '19,329', unit: 'events/s', label: 'on one worker', note: '46,040 on eight · in-memory engine path' },
  { value: '0', unit: 'mismatches', label: 'across 2.04 M reconstructed events', note: 'every event rebuilt and hash-checked' },
  { value: '0', unit: 'dropped', label: 'of 120,000 generated events', note: 'generated count equals stored count' },
  { value: '0.27', unit: 's', label: 'to find one tampered byte', note: 'names the exact Merkle batch and event' },
];

const LIMITS = [
  'Reconstruction proves no loss, not correct meaning. Golden tests, replay diff and human review cover mappings.',
  'The per-event SHA-256 costs storage: 1.52× a plain baseline. The template form itself is 10.7% smaller than the text it rebuilds.',
  'The Merkle chain proves stored data has not changed since sealing, not that a device logged the truth.',
];

const STAGES = [
  'Collectors (Vector)', 'Ingest bus (Redpanda)', 'Evidence stamp', 'Envelope decoder',
  'Template matcher', 'Reconstruct + verify', 'OCSF normalizer', 'Sinks',
];

// Brand marks are bundled SVG (react-icons), so nothing is fetched. Redpanda, Vector and Loki have
// no mark in the set and get a neutral glyph rather than a look-alike.
const TECH: { icon: ReactNode; name: string; role: string }[] = [
  { icon: <SiGo />, name: 'Go', role: 'Engine workers and the Merkle sealer' },
  { icon: <IconServer size={20} />, name: 'Redpanda', role: 'Kafka-compatible bus, raw replicated first' },
  { icon: <SiClickhouse />, name: 'ClickHouse', role: 'Columnar system of record' },
  { icon: <SiPostgresql />, name: 'PostgreSQL', role: 'Parser registry, Merkle roots, settings' },
  { icon: <SiPython />, name: 'Python', role: 'Onboarding Studio, Drain3 clustering' },
  { icon: <SiFastapi />, name: 'FastAPI', role: 'Studio API, gate, Lyra' },
  { icon: <IconServer size={20} />, name: 'Vector', role: 'Collectors and fan-out to Loki' },
  { icon: <SiGrafana />, name: 'Grafana', role: 'Dashboards and unified alerting' },
  { icon: <IconServer size={20} />, name: 'Loki', role: 'Raw-line store and log search' },
  { icon: <SiPrometheus />, name: 'Prometheus', role: 'Pipeline metrics' },
  { icon: <SiMinio />, name: 'MinIO', role: 'Parquet exports and daily anchors' },
  { icon: <SiApacheparquet />, name: 'Parquet', role: 'Data-lake export format' },
  { icon: <SiNginx />, name: 'nginx', role: 'One port for UI, API and Grafana' },
  { icon: <SiDocker />, name: 'Docker', role: 'All-in-one multi-arch image' },
  { icon: <SiReact />, name: 'React', role: 'Landing page and dashboard' },
  { icon: <SiTypescript />, name: 'TypeScript', role: 'Frontend' },
];

const TECH_LOGOS: LogoItem[] = TECH.map((t) => ({
  title: `${t.name}: ${t.role}`,
  node: (
    <span className="lp-stack-item" title={`${t.name}: ${t.role}`}>
      {t.icon}
      <span>{t.name}</span>
    </span>
  ),
}));


const SOURCES = [
  'Cisco ASA', 'FortiGate', 'pfSense filterlog', 'Suricata EVE',
  'OpenVPN', 'Squid access', 'CEF (generic)', 'LEEF (generic)',
];

const PORTS = [
  { port: '6156', proto: 'TCP', use: 'UI, Studio API (/api/) and Grafana (/grafana/)' },
  { port: '26514', proto: 'UDP + TCP', use: 'Syslog input for your own logs' },
];

const REQS: { id: string; title: string; desc: string }[] = [
  { id: 'a', title: 'Preserve raw data without loss', desc: 'Hashed and committed to the bus before parsing; stored verified or verbatim; never dropped' },
  { id: 'b', title: 'Extract source attributes', desc: 'Templates capture every variable; unmapped slots kept in unmapped' },
  { id: 'c', title: 'Normalize to a taxonomy', desc: 'OCSF, pinned version, typed columns' },
  { id: 'd', title: 'Traceability', desc: 'event_uid, raw_sha256, pack version, byte-level lineage' },
  { id: 'e', title: 'Plug-and-play onboarding', desc: 'Parser packs, Onboarding Studio, hot reload with no restart' },
  { id: 'f', title: 'Unified visibility', desc: 'One schema across all sources in ClickHouse, Grafana and Loki' },
  { id: 'g', title: 'SIEM / data-lake integration', desc: 'Kafka topic normalized, Splunk HEC, CEF re-emit, Loki, Parquet' },
  { id: 'h', title: 'AI/ML ready', desc: 'Typed OCSF columns in ClickHouse, queryable with SQL or from Grafana' },
  { id: 'i', title: 'Reduced parser effort', desc: 'Automatic template derivation, slot typing, mapping proposals' },
  { id: 'j', title: 'Air-gapped', desc: 'docker save / load, nothing fetched at run time, telemetry off, AI optional' },
  { id: 'k', title: 'Containerized', desc: 'All-in-one multi-arch image; per-component images with Docker Compose' },
];

const DOCKER_RUN = `docker pull ritesh2006/aletheia
docker run -d --name aletheia -p 6156:6156 \\
  -p 26514:5514/udp -p 26514:5514/tcp -v aletheia-data:/data \\
  --add-host=host.docker.internal:host-gateway ritesh2006/aletheia`;

/* ================================================================ page */

export function HomePage() {
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const [scrolled, setScrolled] = useState(false);

  // The bar sits clear over the hero and only frosts once content scrolls under it.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="lp">
      {/* ---- top bar ---- */}
      <header className={`lp-topbar${scrolled ? ' scrolled' : ''}`}>
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
            <a href="#proof">Proof</a>
            <a href="#architecture">Architecture</a>
            <a href="#quickstart">Quick start</a>
            <a href="#requirements">Requirements</a>
            <button type="button" className="lp-theme-btn" onClick={toggle} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              {theme === 'dark' ? <IconMoon size={15} /> : <IconSun size={15} />}
            </button>
            <SpecularButton size="sm" radius={10} {...CTA[theme]} onClick={() => navigate('/dashboard')}>
              Open Dashboard <span aria-hidden="true">→</span>
            </SpecularButton>
          </nav>
        </div>
      </header>

      {/* ---- hero ---- */}
      <section className="lp-hero">
        <div className="lp-hero-bg" aria-hidden="true" />
        <GhostFibers
          className="lp-hero-fibers"
          {...FIBERS[theme]}
          speed={0.18}
          scale={2.2}
          layers={5}
          glowIntensity={theme === 'dark' ? 1.3 : 1.6}
          brightness={theme === 'dark' ? 1.8 : 2}
          vignette={0.85}
          grain={theme === 'dark' ? 0.05 : 0.03}
        />
        <div className="lp-hero-scrim" aria-hidden="true" />

        <div className="lp-hero-inner">
          <h1>
            Normalize everything.<br />
            Lose nothing.<br />
            <span className="sr-only">Prove it.</span>
          </h1>
          <ParticleText
            className="lp-hero-title"
            text="Prove it."
            {...PROVE[theme]}
            fontSize="clamp(40px, 7.2vw, 80px)"
            fontWeight={800}
            letterSpacing="-0.035em"
            lineHeight={1.02}
            density={2}
            particleSize={2}
            scatter={200}
            gatherDuration={1500}
            stagger={500}
            pointerRepel={28}
            repelRadius={90}
            idleDrift={0.5}
            maxParticles={7000}
            glow={false}
          />
          <p className="lp-hero-sub">
            <strong>Aletheia</strong> turns any perimeter-device log, from any vendor, format or firmware,
            into a standard <strong>OCSF</strong> event <strong>without losing a single byte of the
            original</strong>, and proves it for every event.
          </p>
          <div className="lp-hero-actions">
            <SpecularButton size="lg" radius={14} {...CTA[theme]} onClick={() => navigate('/dashboard')}>
              Open Dashboard <span aria-hidden="true">→</span>
            </SpecularButton>
          </div>
        </div>
      </section>

      {/* ---- the core insight ---- */}
      <section className="lp-section" id="features">
        <div className="lp-section-inner">
          <h2>The Core Insight</h2>
          <p className="lp-section-sub">
            A log line is literal text that repeats on every event of its type, plus variable values that
            change. Separate the two and one representation does three jobs.
          </p>
          <div className="lp-results-grid">
            {RESULTS.map((r, i) => (
              <Box key={r.title}>
                <div className="lp-result">
                  <span className="lp-result-num">0{i + 1}</span>
                  <h3>{r.title}</h3>
                  <p>{r.desc}</p>
                </div>
              </Box>
            ))}
          </div>
          <div className="lp-code-block">
            <div className="lp-code-label">Cisco ASA log line → template + variables</div>
            <pre><code>{`raw:   <166>Sep 19 14:31:02 fw01 %ASA-6-302013: Built outbound TCP connection 1234
       for outside:203.0.113.5/443 to inside:10.0.0.5/52144

template (stored once):
       "<" PRI ">" TS " " HOST " %ASA-6-302013: Built " DIR " TCP connection "
       CONN_ID " for " IF_A ":" IP_A "/" PORT_A " to " IF_B ":" IP_B "/" PORT_B

vars (stored per event):
       ["166", "Sep 19 14:31:02", "fw01", "outbound", "1234", "outside",
        "203.0.113.5", "443", "inside", "10.0.0.5", "52144"]

sha256(literals + vars) == sha256(raw)   →   provably lossless
                        !=               →   raw stored verbatim, nothing lost`}</code></pre>
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
              <Box key={p.title}>
                <div className="lp-feature">
                  <span className="lp-feature-icon">{p.icon}</span>
                  <h3>{p.title}</h3>
                  <p>{p.desc}</p>
                </div>
              </Box>
            ))}
          </div>
        </div>
      </section>

      {/* ---- measured proof ---- */}
      <section className="lp-section" id="proof">
        <div className="lp-section-inner">
          <h2>Measured, Not Estimated</h2>
          <p className="lp-section-sub">
            Every figure comes from the benchmark harness in the repository, recorded with the machine it ran on.
          </p>
          <div className="lp-metrics-grid">
            {METRICS.map((m) => (
              <Box key={m.label}>
                <div className="lp-metric">
                  <span className="lp-metric-val">
                    {m.value}<span className="lp-metric-unit">{m.unit}</span>
                  </span>
                  <strong>{m.label}</strong>
                  <span className="lp-metric-note">{m.note}</span>
                </div>
              </Box>
            ))}
          </div>
          <div className="lp-limits">
            <h3>Stated plainly</h3>
            <ul>
              {LIMITS.map((l) => <li key={l}>{l}</li>)}
            </ul>
          </div>
        </div>
      </section>

      {/* ---- architecture ---- */}
      <section className="lp-section" id="architecture">
        <div className="lp-section-inner">
          <h2>Architecture &amp; Technology Stack</h2>
          <p className="lp-section-sub">Eight stages from raw syslog to a normalized, verified, queryable event.</p>
          <div className="lp-pipeline">
            {STAGES.map((s, i) => (
              <div key={s} className="lp-pipeline-step">
                <span className="lp-pipeline-num">{i + 1}</span>
                <span className="lp-pipeline-name">{s}</span>
              </div>
            ))}
          </div>
          <LogoLoop
            className="lp-stack"
            logos={TECH_LOGOS}
            speed={40}
            logoHeight={22}
            gap={48}
            hoverSpeed={0}
            fadeOut
            fadeOutColor="var(--bg)"
            ariaLabel="Technology stack"
          />
        </div>
      </section>

      {/* ---- supported sources ---- */}
      <section className="lp-section" id="sources">
        <div className="lp-section-inner">
          <h2>Supported Sources</h2>
          <p className="lp-section-sub">
            Eight parser packs ship today. Any other format is onboarded through the Studio: never dropped,
            stored verbatim until a template passes the byte-exact gate.
          </p>
          <div className="lp-sources-grid">
            {SOURCES.map((s) => (
              <div key={s} className="lp-source-chip">{s}</div>
            ))}
          </div>
          <div className="lp-byol">
            <span>Bring your own log</span>
            <code>logger --server localhost --port 26514 --udp "&lt;your log line&gt;"</code>
          </div>
        </div>
      </section>

      {/* ---- quick start ---- */}
      <section className="lp-section" id="quickstart">
        <div className="lp-section-inner">
          <h2>Run It in One Command</h2>
          <p className="lp-section-sub">
            Docker with 4+ cores, 8 GB RAM and 10 GB disk. The container reports healthy after one to two minutes.
          </p>
          <Box className="lp-quickstart">
            <div className="lp-quickstart-body">
              <pre className="lp-quickstart-cmd"><code>{DOCKER_RUN}</code></pre>
              <div className="lp-quickstart-side">
                <h3>Free these host ports</h3>
                <table className="lp-ports">
                  <tbody>
                    {PORTS.map((p) => (
                      <tr key={p.port}>
                        <td><code>{p.port}</code></td>
                        <td>{p.proto}</td>
                        <td>{p.use}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p>
                  Then open <code>localhost:6156</code>. Grafana is at <code>/grafana/</code> (admin / aletheia).
                  No AI key and no internet access are needed.
                </p>
              </div>
            </div>
          </Box>
        </div>
      </section>

      {/* ---- requirements traceability ---- */}
      <section className="lp-section" id="requirements">
        <div className="lp-section-inner">
          <h2>Requirement Traceability (a – k)</h2>
          <p className="lp-section-sub">Every requirement of PS 26156 is addressed and verifiable.</p>
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
          <p className="lp-section-sub">Every part of the pipeline has its own page.</p>
          <div className="lp-nav-grid">
            <NavCard to="/dashboard" icon={<IconHome size={20} />} title="Overview" desc="Live ingest, posture score and auto-generated findings." />
            <NavCard to="/dashboard/events" icon={<IconEvents size={20} />} title="Events Explorer" desc="One OCSF table across every source: filter, search, paginate." />
            <NavCard to="/dashboard/lineage" icon={<IconLineage size={20} />} title="Lineage" desc="Click a field and the exact source bytes highlight." />
            <NavCard to="/dashboard/lyra" icon={<IconLyra size={20} />} title="Lyra" desc="Ask questions of your data through guarded, read-only SQL." />
            <NavCard to="/dashboard/sources" icon={<IconSources size={20} />} title="Sources" desc="Connect log systems; approve the derived template and mapping." />
            <NavCard to="/dashboard/export" icon={<IconExport size={20} />} title="Export & Supply" desc="Download logs and reports, or stream to a SIEM over TCP." />
            <NavCard to="/dashboard/alerting" icon={<IconBell size={20} />} title="Alerting" desc="Rules, contact points and policies, evaluated by Grafana." />
            <NavCard to="/dashboard/demo" icon={<IconDemo size={20} />} title="Demo Console" desc="The guided evaluation scenarios, each with its CLI equivalent." />
            <NavCard to="/dashboard/settings" icon={<IconSettings size={20} />} title="Settings" desc="AI provider (optional), air-gap mode, connection test." />
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
            <span>Team ORCA#26 · SIH 2026 · PS 26156</span>
            <span className="lp-dot">·</span>
            <span>OCSF 1.3</span>
            <span className="lp-dot">·</span>
            <span><IconLock size={12} /> Byte-exact · Merkle-sealed</span>
            <span className="lp-dot">·</span>
            <span>MIT License</span>
          </div>
          <div className="lp-footer-tagline">ἀλήθεια — Greek for "truth", literally "un-concealment": nothing hidden, nothing lost.</div>
        </div>
      </footer>
    </div>
  );
}
