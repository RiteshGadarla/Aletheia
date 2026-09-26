// Aletheia product landing page: standalone, no sidebar. Copy and figures track README.md and docs/.
import { useEffect, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../lib/theme';
import {
  IconEvents, IconSources, IconLineage, IconDemo, IconSettings, IconHome, IconLyra, IconExport,
  IconBell, IconShield, IconMoon, IconSun, IconLock, IconNested, IconLink, IconHash, IconCpu,
  IconOff, IconServer, IconSparkles,
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
import { BlurText } from '../components/BlurText';
import { ClickSpark } from '../components/ClickSpark';
import { CopyButton } from '../components/Bits';
import { Reveal } from '../components/Reveal';
import { restartTour } from '../components/Tour';
import { LogAnatomy } from '../components/landing/LogAnatomy';
import { SealedLedger } from '../components/landing/SealedLedger';
import { ProofTerminal } from '../components/landing/ProofTerminal';
import { PipelineFlow } from '../components/landing/PipelineFlow';
import { TraceMatrix } from '../components/landing/TraceMatrix';
import { ConsoleIndex } from '../components/landing/ConsoleIndex';
import type { LogoItem } from '../components/LogoLoop';
import type { SpecularButtonProps } from '../components/SpecularButton';
import type { Pillar } from '../components/landing/SealedLedger';
import type { Req } from '../components/landing/TraceMatrix';
import type { ConsolePage } from '../components/landing/ConsoleIndex';
import type { ReactNode } from 'react';

/* ---------------------------------------------------------------- theme-bound colours */

// The shaders take hex, not CSS variables. backdrop mirrors --bg in tokens.css so the fibers
// fade into the page with no seam; keep the two in step if the palette changes.
const FIBERS = {
  dark: { lineColor: '#12306e', glowColor: '#2c5fd6', backdrop: '#0c1014', lightMode: false, ink: 0.3 },
  light: { lineColor: '#123f9e', glowColor: '#6aa5ff', backdrop: '#f4f6f9', lightMode: true, ink: 0.6 },
} as const;

type Spec = Pick<SpecularButtonProps, 'tint' | 'tintOpacity' | 'blur' | 'textColor' | 'lineColor' | 'baseColor'>;
const CTA: Record<'dark' | 'light', Spec> = {
  dark: { tint: '#ffffff', tintOpacity: 1, textColor: '#0c1014', lineColor: '#eaf2ff', baseColor: '#9fc4ff' },
  light: { tint: '#0c1014', tintOpacity: 1, textColor: '#ffffff', lineColor: '#9fb8e8', baseColor: '#2c5fd6' },
};

// Secondary hero action: smoked glass, so it reads as the quieter of the two next to the solid CTA.
const TOUR: Record<'dark' | 'light', Spec> = {
  dark: { tint: '#ffffff', tintOpacity: 0.07, blur: 10, textColor: '#e8eefb', lineColor: '#cfe0ff', baseColor: '#6aa5ff' },
  light: { tint: '#0c1014', tintOpacity: 0.05, blur: 10, textColor: '#10203f', lineColor: '#2c5fd6', baseColor: '#1c58c9' },
};

// "Prove it." particles, in the accent: blue easing toward a lighter blue (dark) or violet (light).
const PROVE: Record<'dark' | 'light', { color: string; highlightColor: string }> = {
  dark: { color: '#6aa5ff', highlightColor: '#b9d0f4' },
  light: { color: '#1c58c9', highlightColor: '#4a3aa7' },
};

// Mesh colours for the one glowing object (the run command): categorical blue, teal, violet.
const GLOW = {
  dark: { glowColor: '217 90 70', colors: ['#6aa5ff', '#4fc9b6', '#9085e9'], lightSurface: false },
  light: { glowColor: '217 75 45', colors: ['#1c58c9', '#0a6f62', '#4a3aa7'], lightSurface: true },
};

/* ---------------------------------------------------------------- helpers */

/** Editorial section head: numbered eyebrow and title on the left, the lede on the right. */
function SectionHead({ index, eyebrow, title, children }: { index: string; eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <header className="lp-head">
      <div>
        <span className="lp-eyebrow">{index} / {eyebrow}</span>
        <BlurText as="h2" text={title} className="lp-head-title" delay={60} direction="bottom" />
      </div>
      {children && <Reveal delay={0.15} y={16}><p className="lp-head-sub">{children}</p></Reveal>}
    </header>
  );
}

/* ---------------------------------------------------------------- data */

const PILLARS: Pillar[] = [
  { icon: <IconHash size={18} />, title: 'Hash before parse', desc: 'Raw bytes are hashed and written to the bus before anything is parsed. Nothing is ever dropped: a line that fails to match is kept exactly as received.' },
  { icon: <IconNested size={18} />, title: 'Template engine', desc: 'One parse yields normalization, compression and exact reconstruction. Literals stored once, variables per event.' },
  { icon: <IconLink size={18} />, title: 'Byte-level lineage', desc: 'Any normalized OCSF field traces back to the exact byte offsets it came from in the original line.' },
  { icon: <IconShield size={18} />, title: 'Tamper evidence', desc: 'Per-minute Merkle roots chained over time, with Ed25519-signed daily anchors held off-system.' },
  { icon: <IconCpu size={18} />, title: 'Deterministic hot path', desc: 'Compiled RE2 with linear-time matching. No model ever touches a live event; AI only proposes mappings behind a gate.' },
  { icon: <IconOff size={18} />, title: 'Air-gap ready', desc: 'One image, nothing fetched at run time, telemetry off. A packet capture showed no outbound connections and no DNS lookups.' },
];

const LIMITS = [
  'Reconstruction proves no loss, not correct meaning. Golden tests, replay diff and human review cover mappings.',
  'The per-event SHA-256 costs storage: 1.52× a plain baseline. The template form itself is 10.7% smaller than the text it rebuilds.',
  'The Merkle chain proves stored data has not changed since sealing, not that a device logged the truth.',
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

// One real line per shipped parser pack, from backend/packs/tests.
const SAMPLES: { vendor: string; line: string }[] = [
  { vendor: 'Cisco ASA', line: '<166>Sep 19 14:31:02 fw01 %ASA-6-302013: Built outbound TCP connection 1234 for outside:203.0.113.5/443' },
  { vendor: 'FortiGate', line: '<189>date=2026-09-19 time=14:31:05 devname="FGT-EDGE" type="traffic" subtype="forward" srcip=10.0.0.5 dstip=8.8.8.8 dstport=53' },
  { vendor: 'pfSense', line: '<134>Sep 19 14:31:02 filterlog[1234]: 5,,,1000000103,em0,match,block,in,4,0x0,,64,0,0,DF,6,tcp,60,198.51.100.9,10.0.0.5' },
  { vendor: 'Suricata EVE', line: '{"timestamp":"2026-09-19T14:31:02.123456+0530","event_type":"alert","src_ip":"198.51.100.9","dest_port":22,"alert":{"signature_id":2001219}}' },
  { vendor: 'OpenVPN', line: "<29>Sep 19 14:32:11 vpn01 openvpn[812]: 198.51.100.20:50118 TLS: Username/Password authentication failed for username 'analyst1'" },
  { vendor: 'Squid', line: '1789828262.123    245 10.0.0.5 TCP_TUNNEL/200 5120 CONNECT example.com:443 - HIER_DIRECT/93.184.216.34 -' },
  { vendor: 'CEF', line: 'CEF:0|VendorX|NGFW|4.2|1002|Connection denied|6|rt=1758359462000 src=198.51.100.9 spt=51514 dst=10.0.0.5 dpt=22 act=deny' },
  { vendor: 'LEEF', line: 'LEEF:1.0|VendorZ|FWALL|1.4|ACCEPT|cat=traffic  src=10.0.0.5  srcPort=52144  dst=203.0.113.5  dstPort=443  action=accept' },
];

const sampleItems = (list: typeof SAMPLES): LogoItem[] => list.map((s) => ({
  title: s.vendor,
  node: (
    <span className="lp-logline">
      <span className="lp-logline-vendor">{s.vendor}</span>
      <code>{s.line}</code>
    </span>
  ),
}));
const SAMPLE_ROW_A = sampleItems(SAMPLES.slice(0, 4).concat(SAMPLES.slice(4)));
const SAMPLE_ROW_B = sampleItems(SAMPLES.slice(4).concat(SAMPLES.slice(0, 4)));

const PORTS = [
  { port: '6156', proto: 'TCP', use: 'UI, Studio API (/api/) and Grafana (/grafana/)' },
  { port: '26514', proto: 'UDP + TCP', use: 'Syslog input for your own logs' },
];

const REQS: Req[] = [
  { id: 'a', title: 'Preserve raw data without loss', desc: 'Hashed and committed to the bus before parsing; stored verified or exactly as received; never dropped' },
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

const CONSOLE: ConsolePage[] = [
  { to: '/dashboard', icon: <IconHome size={18} />, title: 'Overview', desc: 'Live ingest, posture score and auto-generated findings.' },
  { to: '/dashboard/events', icon: <IconEvents size={18} />, title: 'Events Explorer', desc: 'One OCSF table across every source: filter, search, paginate.' },
  { to: '/dashboard/lineage', icon: <IconLineage size={18} />, title: 'Lineage', desc: 'Click a field and the exact source bytes highlight.' },
  { to: '/dashboard/lyra', icon: <IconLyra size={18} />, title: 'Lyra', desc: 'Ask questions of your data through guarded, read-only SQL.' },
  { to: '/dashboard/sources', icon: <IconSources size={18} />, title: 'Sources', desc: 'Connect log systems; approve the derived template and mapping.' },
  { to: '/dashboard/export', icon: <IconExport size={18} />, title: 'Export & Supply', desc: 'Download logs and reports, or stream to a SIEM over TCP.' },
  { to: '/dashboard/alerting', icon: <IconBell size={18} />, title: 'Alerting', desc: 'Rules, contact points and policies, evaluated by Grafana.' },
  { to: '/dashboard/demo', icon: <IconDemo size={18} />, title: 'Demo Console', desc: 'The guided evaluation scenarios, each with its CLI equivalent.' },
  { to: '/dashboard/settings', icon: <IconSettings size={18} />, title: 'Settings', desc: 'AI provider (optional), air-gap mode, connection test.' },
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

  // Rewind the saved tour state, then land on the dashboard where Tour mounts and opens at step one.
  const startTour = () => { restartTour(); navigate('/dashboard'); };

  return (
    <MotionConfig reducedMotion="user">
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
              idleDrift={0.3}
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
              <SpecularButton size="lg" radius={14} {...TOUR[theme]} onClick={startTour}>
                <IconSparkles size={17} /> Take a tour
              </SpecularButton>
            </div>
          </div>
        </section>

        {/* ---- 01 the core insight: one real line, three readings ---- */}
        <section className="lp-section" id="features">
          <div className="lp-section-inner">
            <SectionHead index="01" eyebrow="The core insight" title="One parse. Three results.">
              A log line is literal text that repeats on every event of its type, plus variable values that
              change. Separate the two and one representation normalizes, compresses and rebuilds. Hover a
              value to trace it.
            </SectionHead>
            <Reveal amount={0.15}>
              <LogAnatomy />
            </Reveal>
          </div>
        </section>

        {/* ---- 02 design pillars as a sealed ledger ---- */}
        <section className="lp-section">
          <div className="lp-section-inner">
            <SectionHead index="02" eyebrow="Design pillars" title="Six guarantees, sealed.">
              Each guarantee below is sealed with SHA-256 over its own text and the seal before it, the way
              Aletheia chains its Merkle roots. Change one word and watch what happens.
            </SectionHead>
            <SealedLedger pillars={PILLARS} />
          </div>
        </section>

        {/* ---- 03 measured proof ---- */}
        <section className="lp-section" id="proof">
          <div className="lp-section-inner">
            <SectionHead index="03" eyebrow="Proof" title="Measured, not estimated.">
              Every figure comes from the benchmark harness in the repository, recorded with the machine it
              ran on (i7-1360P).
            </SectionHead>
            <Reveal amount={0.15}>
              <ProofTerminal />
            </Reveal>
            <Reveal>
              <ol className="lp-limits">
                {LIMITS.map((l) => <li key={l}>{l}</li>)}
              </ol>
            </Reveal>
          </div>
        </section>

        {/* ---- 04 architecture ---- */}
        <section className="lp-section" id="architecture">
          <div className="lp-section-inner">
            <SectionHead index="04" eyebrow="Architecture" title="Eight stages, raw first.">
              The raw bytes are on disk and hashed before any parsing starts. Nothing past that point can
              lose them: a line that fails to match or to rebuild is kept exactly as received.
            </SectionHead>
            <PipelineFlow />
            <Reveal delay={0.2}>
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
            </Reveal>
          </div>
        </section>

        {/* ---- 05 supported sources: real lines scrolling past ---- */}
        <section className="lp-section lp-section-bleed" id="sources">
          <div className="lp-section-inner">
            <SectionHead index="05" eyebrow="Sources" title="Eight formats today. Any tomorrow.">
              These are real lines from the shipped parser packs. An unknown format is never dropped: it is
              kept exactly as received and onboarded through the Studio once a template passes the
              byte-exact gate.
            </SectionHead>
          </div>
          <Reveal amount={0.1}>
            <div className="lp-loglines">
              <LogoLoop logos={SAMPLE_ROW_A} speed={32} logoHeight={13} gap={40} hoverSpeed={0} fadeOut fadeOutColor="var(--bg)" ariaLabel="Sample log lines" />
              <LogoLoop logos={SAMPLE_ROW_B} speed={32} direction="right" logoHeight={13} gap={40} hoverSpeed={0} fadeOut fadeOutColor="var(--bg)" ariaLabel="More sample log lines" />
            </div>
          </Reveal>
          <div className="lp-section-inner">
            <Reveal delay={0.1} y={16}>
              <div className="lp-byol">
                <span>Bring your own log</span>
                <code>logger --server localhost --port 26514 --udp "&lt;your log line&gt;"</code>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---- 06 quick start ---- */}
        <section className="lp-section" id="quickstart">
          <div className="lp-section-inner">
            <SectionHead index="06" eyebrow="Quick start" title="Run it in one command.">
              Docker with 4+ cores, 8 GB RAM and 10 GB disk. The container reports healthy after one to two
              minutes. No AI key and no internet access are needed.
            </SectionHead>
            <Reveal amount={0.15}>
              <BorderGlow
                {...GLOW[theme]}
                className="lp-quickstart"
                backgroundColor="var(--surface-inset)"
                borderRadius={12}
                glowRadius={28}
                edgeSensitivity={28}
                glowIntensity={theme === 'dark' ? 1 : 0.6}
              >
                <div className="lp-quickstart-cmd">
                  <pre><code>{DOCKER_RUN}</code></pre>
                  <ClickSpark className="lp-copy" sparkColor={theme === 'dark' ? '#6aa5ff' : '#1c58c9'} sparkRadius={18} sparkCount={10}>
                    <CopyButton text={DOCKER_RUN} label="Copy command" />
                  </ClickSpark>
                </div>
                <div className="lp-quickstart-foot">
                  {PORTS.map((p) => (
                    <span key={p.port}><code>{p.port}</code> {p.proto}: {p.use}</span>
                  ))}
                  <span>Then open <code>localhost:6156</code>; Grafana is at <code>/grafana/</code> (admin / aletheia).</span>
                </div>
              </BorderGlow>
            </Reveal>
          </div>
        </section>

        {/* ---- 07 requirements traceability ---- */}
        <section className="lp-section" id="requirements">
          <div className="lp-section-inner">
            <SectionHead index="07" eyebrow="Traceability" title="Requirements (a) to (k), met.">
              Every requirement of SIH Problem Statement 26156 and where Aletheia answers it.
            </SectionHead>
            <TraceMatrix reqs={REQS} />
          </div>
        </section>

        {/* ---- 08 console index ---- */}
        <section className="lp-section">
          <div className="lp-section-inner">
            <SectionHead index="08" eyebrow="The console" title="Every stage has a page." />
            <ConsoleIndex pages={CONSOLE} />
          </div>
        </section>

        {/* ---- footer ---- */}
        <footer className="lp-footer">
          <Reveal y={16} amount={0.4}>
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
            </div>
            <div className="lp-footer-tagline">ἀλήθεια: Greek for "truth", literally "un-concealment": nothing hidden, nothing lost.</div>
          </div>
          </Reveal>
        </footer>
      </div>
    </MotionConfig>
  );
}
