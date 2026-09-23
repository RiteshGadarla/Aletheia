// Overview: live ingest, threat signals, normalization, traffic, storage and governance in one consistent grid.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, ErrorState, PageHead, Panel, Spinner } from '../components/Bits';
import { api } from '../lib/api';
import { usePoll } from '../lib/useAsync';
import type { Overview } from '../lib/types';
import { IconExport, IconExternal } from '../components/Icons';
import { GrafanaLogo, grafanaOverviewUrl, useAlertingStatus } from '../lib/alerting';
import {
  Donut, Finding, Gauge, Heatmap, Kpi, RankBars, Section, Timeline, actionName, bytesFmt, className, dur, findings, ocsfSevName,
} from '../components/Insights';

const SEVS = ['info', 'notice', 'warn', 'risk'] as const;
const SEV_VAR: Record<string, string> = {
  info: 'var(--sev-info)', notice: 'var(--sev-notice)', warn: 'var(--sev-warn)', risk: 'var(--sev-risk)',
};
const int = (n: number) => n.toLocaleString();
const ago = (t: number) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const niceMax = (v: number) => {
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
};

/** Single-series area/line chart with crosshair + tooltip; the title names the series. */
function RateChart({ series, bucketS }: { series: number[]; bucketS: number }) {
  const W = 720; const H = 200; const L = 36; const B = 22; const T = 8;
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...series, 0.001));
  const x = (i: number) => L + (i / (series.length - 1)) * (W - L - 4);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const line = series.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(series.length - 1)},${H - B} L${x(0)},${H - B} Z`;
  const secAgo = (i: number) => (series.length - 1 - i) * bucketS;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Lines per second over the last five minutes"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.min(series.length - 1, Math.max(0, Math.round(((px - L) / (W - L - 4)) * (series.length - 1)))));
        }}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}><line className="grid" x1={L} x2={W - 4} y1={y(max * f)} y2={y(max * f)} />
            <text className="axis-t" x={L - 6} y={y(max * f) + 4} textAnchor="end">{+(max * f).toFixed(1)}</text></g>
        ))}
        <text className="axis-t" x={L} y={H - 4}>-5 min</text>
        <text className="axis-t" x={W - 4} y={H - 4} textAnchor="end">now</text>
        <path d={area} fill="var(--sev-info)" opacity=".14" />
        <path d={line} fill="none" stroke="var(--sev-info)" strokeWidth="2" strokeLinejoin="round" />
        {hover !== null && (
          <g>
            <line className="grid" x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} />
            <circle cx={x(hover)} cy={y(series[hover])} r="4" fill="var(--sev-info)" stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="tip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(series[hover]) / H) * 100}%` }}>
          <b>{series[hover].toFixed(1)}</b> lines/s · {secAgo(hover) ? `${secAgo(hover)}s ago` : 'now'}
        </div>
      )}
    </div>
  );
}

function SeverityBars({ rows }: { rows: Overview['sources'] }) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const max = Math.max(...rows.map((r) => r.lines), 1);
  return (
    <div className="chart" onMouseLeave={() => setTip(null)}>
      <div className="legend" aria-label="Severity legend" style={{ marginBottom: 'var(--s3)' }}>
        {SEVS.map((s) => <span key={s}><i style={{ background: SEV_VAR[s] }} />{s}</span>)}
      </div>
      {rows.map((r) => (
        <div className="sbar-row" key={r.id}>
          <span className="truncate" title={r.id}>{r.id}</span>
          <div className="sbar" style={{ width: `${Math.max((r.lines / max) * 100, 2)}%` }}>
            {SEVS.map((s) => (r.by_severity[s] ? (
              <i key={s} style={{ flex: r.by_severity[s], background: SEV_VAR[s] }}
                onMouseMove={(e) => {
                  const b = e.currentTarget.closest('.chart')!.getBoundingClientRect();
                  setTip({ x: e.clientX - b.left, y: e.clientY - b.top, text: `${r.id} · ${s}: ${int(r.by_severity[s])}` });
                }} />
            ) : null))}
          </div>
          <span className="n">{int(r.lines)}</span>
        </div>
      ))}
      {tip && <div className="tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}

function Spark({ v }: { v: number[] }) {
  const max = Math.max(...v, 0.001);
  const d = v.map((n, i) => `${i ? 'L' : 'M'}${(i / (v.length - 1)) * 100},${22 - (n / max) * 20}`).join(' ');
  return <svg viewBox="0 0 100 24" width="100" height="24" aria-hidden="true"><path d={d} fill="none" stroke="var(--sev-info)" strokeWidth="1.5" /></svg>;
}

type Tone = 'ok' | 'warn' | 'bad' | 'plain';

function StatusCell({ label, value, tone, live, title }: { label: string; value: string; tone: Tone; live?: boolean; title?: string }) {
  return (
    <div className={`ov-cell t-${tone}`} title={title}>
      <span className="ov-cell-k">{label}</span>
      <span className="ov-cell-v"><i className={live ? 'live' : undefined} aria-hidden="true" />{value}</span>
    </div>
  );
}

/** Magnitude of a clock offset in ms, as "5h 30m". */
const offsetText = (ms: number) => {
  const m = Math.round(Math.abs(ms) / 60000);
  const h = Math.floor(m / 60);
  return `${h ? `${h}h ` : ''}${m % 60 ? `${m % 60}m` : ''}`.trim() || '<1m';
};

export function OverviewPage() {
  const q = usePoll(() => api.overview(), 3000, []);
  const d = q.data;
  const grafana = grafanaOverviewUrl(useAlertingStatus().status);

  return (
    <div className="stack">
      <PageHead
        title="Overview"
        right={
          <div className="row-tight">
            {grafana && (
              <a href={grafana} target="_blank" rel="noopener noreferrer" className="btn btn-grafana"
                title="The same overview in Grafana, over any time range, from Loki and Prometheus">
                <GrafanaLogo size={18} />View in Grafana<IconExternal size={13} className="bg-ext" />
              </a>
            )}
            <Link to="/dashboard/export?tab=report" className="btn secondary sm flex align-center" style={{ gap: 4 }}>
              <IconExport size={14} /> Export Report & Logs
            </Link>
          </div>
        }
      >
        Live ingest across every connected source. Updates every 3 seconds.
      </PageHead>

      {q.error && !d && <ErrorState error={q.error} what="stats" />}
      {q.loading && !d && <Spinner label="Loading stats" />}
      {d && <Body d={d} stale={!!q.error} />}
    </div>
  );
}

function Body({ d, stale }: { d: Overview; stale: boolean }) {
  const k = d.kpis; const ins = d.insights; const ch = ins.ch;
  const disk = ch.disk?.events; const base = ch.disk?.baseline_events; const u = ch.unique; const lag = ch.lag;
  // Raw size of the events actually in the DB. `k.bytes` only covers lines this Studio process has
  // seen since it started, so dividing it by the all-time DB size understates the reduction.
  const rawDb = disk && disk.rows > 0 && ins.bytes_per_line > 0 ? Math.round(disk.rows * ins.bytes_per_line) : null;
  const reduction = rawDb && disk && disk.compressed > 0 ? +(rawDb / disk.compressed).toFixed(1) : null;
  const vsBase = disk && base && base.compressed > 0 && disk.compressed > 0 ? Math.round((1 - disk.compressed / base.compressed) * 100) : null;
  const total = Object.values(d.by_severity).reduce((a, b) => a + b, 0);
  const fnd = findings(d);
  const nm = d.normalized;
  const hasData = d.sources.length > 0;
  const denied = lag?.denied ?? 0;
  const perEvent = disk && disk.rows > 0 ? Math.round(disk.compressed / disk.rows) : null;
  const skewMs = lag?.skew_ms ?? 0;
  const fresh = ins.freshness_s;
  const allOnline = k.sources > 0 && k.connected === k.sources;

  return (
    <>
      {stale && <p className="hint err" role="status">Can't reach the Studio API right now. Showing the last numbers received; retrying.</p>}
      <div className="ov-status" role="group" aria-label="System status">
        <StatusCell label="Sources" value={k.sources ? `${k.connected} of ${k.sources} online` : 'None yet'}
          tone={!k.sources ? 'plain' : allOnline && !k.errors ? 'ok' : 'warn'}
          title={k.errors ? `${k.errors} connection errors` : undefined} />
        <StatusCell label="Ingest" value={`${k.eps}/s`} tone={ins.spike ? 'warn' : k.eps > 0 ? 'ok' : 'plain'}
          title={ins.spike ? 'Traffic is well above the 5-minute mean' : '2-bucket average, all sources'} />
        <StatusCell label="Last line" value={fresh === null ? 'Never' : fresh < 2 ? 'Just now' : `${dur(fresh)} ago`}
          tone={fresh === null ? 'plain' : fresh > 60 ? 'warn' : 'ok'} live={fresh !== null && fresh <= 10} />
        <StatusCell label="Event DB" value={ch.available ? 'Reachable' : 'Down'} tone={ch.available ? 'ok' : 'bad'} />
        <StatusCell label="Bus" value={d.bus ? 'Forwarding' : 'Off'} tone={d.bus ? 'ok' : 'warn'}
          title={d.bus ? `${int(k.forwarded)} lines sent` : 'Approved logs are not sent for processing'} />
        <StatusCell label="Raw store" value={d.store === 'memory' ? 'In memory' : d.store} tone={d.store === 'memory' ? 'warn' : 'ok'}
          title={d.store === 'memory' ? 'Raw lines are lost when Studio restarts' : undefined} />
      </div>

      <Section id="glance" title="At a glance" desc="One score, and the findings behind it, written from the live numbers.">
        <div className="hero">
          <Panel title="Posture score" subtitle="onboarding · health · risk">
            <Gauge value={ins.posture} label={ins.posture >= 80 ? 'healthy' : ins.posture >= 55 ? 'attention' : 'at risk'} />
            <div className="hint" style={{ textAlign: 'center' }}>{ins.onboarded_pct}% onboarded · {ins.health_pct}% connected</div>
          </Panel>
          <Panel title="Key findings" subtitle="auto-generated">
            <ul className="findings">
              {fnd.map((f: Finding) => <li key={f.title} className={`f-${f.tone}`}><b>{f.title}</b><span>{f.body}</span></li>)}
              {fnd.length === 0 && <li className="f-info"><b>Waiting for data</b><span>Start a sample server on the Demo page to see findings.</span></li>}
            </ul>
          </Panel>
        </div>
      </Section>

      {!hasData ? (
        <EmptyState title="Nothing ingesting yet">
          Start a sample server on the <Link to="/dashboard/demo">Demo</Link> page, or add a source on <Link to="/dashboard/sources">Sources</Link>.
        </EmptyState>
      ) : (
        <>
          <Section id="ingest" title="Ingest" desc="How much is arriving, how fast, and which sources are driving it.">
            <div className="kpis">
              <Kpi label="Lines stored" value={int(k.lines)} sub={bytesFmt(k.bytes)} />
              <Kpi label="Ingest rate" value={`${k.eps}/s`} sub={`1-min avg ${ins.eps_min}/s`} trend={ins.trend_pct} />
              <Kpi label="Peak rate" value={`${ins.peak_eps}/s`} sub={`5-min mean ${ins.mean_eps}/s`} />
              <Kpi label="Burst score" value={`${ins.z >= 0 ? '+' : ''}${ins.z}σ`} sub={ins.spike ? 'spike in progress' : 'traffic steady'} tone={ins.spike ? 'warn' : undefined} />
              <Kpi label="Projected per day" value={int(ins.proj_day_lines)} sub={`${bytesFmt(ins.proj_day_bytes)} raw at this rate`} />
              <Kpi label="Avg line size" value={`${ins.bytes_per_line} B`} sub={`${int(k.buffered)} buffered`} />
            </div>
            <div className="cards c2">
              <Panel title="Lines per second" subtitle="all sources, last 5 minutes"><RateChart series={d.series} bucketS={d.bucket_s} /></Panel>
              <Panel title="Source activity" subtitle="per-source heatmap, last 5 minutes"><Heatmap rows={d.sources} /></Panel>
            </div>
            <div className="cards c2">
              <Panel title="Severity by source" subtitle={`${int(total)} lines`}><SeverityBars rows={d.sources} /></Panel>
              <Panel title="Share of volume" subtitle="top sources"><Donut rows={ins.share.map((r) => ({ label: String(r.k), n: r.n }))} /></Panel>
            </div>
          </Section>

          <Section id="threat" title="Threat signals" desc="Risk-severity lines, denied traffic and behaviours that look like reconnaissance.">
            <div className="kpis">
              <Kpi label="Risk share" value={`${k.risk_pct}%`} sub={`${int(d.by_severity.risk ?? 0)} risk lines`} tone={k.risk_pct >= 20 ? 'bad' : k.risk_pct >= 5 ? 'warn' : 'ok'} />
              <Kpi label="Warn + risk" value={`${ins.warn_pct}%`} sub="of all lines" />
              <Kpi label="Denied traffic" value={ch.available ? int(denied) : '—'} sub={ch.available && nm.total ? `${Math.round((denied / nm.total) * 100)}% of events` : 'needs event DB'} />
              <Kpi label="Port-scan suspects" value={ch.available ? int(ch.scanners?.length ?? 0) : '—'} sub="≥5 distinct ports from one IP" tone={(ch.scanners?.length ?? 0) > 0 ? 'warn' : undefined} />
              <Kpi label="Fan-out sources" value={ch.available ? int(ch.fanout?.length ?? 0) : '—'} sub="≥3 distinct destinations" />
              <Kpi label="Pipeline errors" value={int(k.errors)} sub={`${ins.error_rate}% of lines`} tone={k.errors ? 'bad' : 'ok'} />
            </div>
            <div className="cards c3">
              <Panel title="Severity mix"><Donut rows={SEVS.map((s) => ({ label: s, n: d.by_severity[s] ?? 0 }))} center={`${k.risk_pct}%`} /></Panel>
              <Panel title="Risk leaderboard" subtitle="% risk lines per source">
                <RankBars rows={ins.risk_rank.map((r) => ({ k: r.id, n: r.pct }))} color="var(--sev-risk)" empty="No risk-severity lines" />
              </Panel>
              <Panel title="Most blocked sources" subtitle="denied events"><RankBars rows={ch.top_denied ?? []} color="var(--sev-warn)" empty={ch.available ? 'No denied traffic' : 'Needs the event DB'} /></Panel>
            </div>
            <div className="cards c2">
              <Panel title="Port-scan suspects" subtitle="distinct destination ports per source IP"><RankBars rows={ch.scanners ?? []} color="var(--sev-risk)" empty="No scanning behaviour detected" /></Panel>
              <Panel title="Widest fan-out" subtitle="distinct destination IPs per source IP"><RankBars rows={ch.fanout ?? []} color="var(--sev-notice)" empty="No fan-out detected" /></Panel>
            </div>
          </Section>

          <Section id="normalize" title="Normalization & integrity" desc="How much of the stream is understood as OCSF, and proof that it has not been altered.">
            <div className="kpis">
              <Kpi label="Events normalized" value={ch.available ? `${nm.normalized_pct ?? 0}%` : '—'} sub={`${int(nm.raw_only ?? 0)} raw only`} tone={(nm.normalized_pct ?? 100) < 90 ? 'warn' : 'ok'} />
              <Kpi label="Templates" value={int(nm.templates ?? 0)} sub={nm.total && nm.templates ? `${int(Math.round(nm.total / nm.templates))} events / template` : undefined} />
              <Kpi label="Avg fields / event" value={lag ? String(lag.avg_vars) : '—'} sub="variables extracted" />
              <Kpi label="Tamper-evident" value={u && u.n ? `${Math.round((u.hashed / u.n) * 100)}%` : '—'} sub="events with SHA-256" />
              <Kpi label="Merkle batches" value={u ? int(u.mb) : '—'} sub="sealed batches" />
              <Kpi label="Ingest lag" value={lag && lag.good ? `${lag.avg_ms} ms` : '—'}
                sub={lag ? (lag.good ? `p95 ${lag.p95_ms} ms · ${int(lag.good)} events` : 'no usable timestamps') : undefined} />
              <Kpi label="Clock-skewed events" value={lag ? int(lag.skewed) : '—'}
                sub={lag && lag.skewed && skewMs ? `log clock ${skewMs < 0 ? 'ahead' : 'behind'} by ${offsetText(skewMs)}${Math.abs(skewMs) >= 15 * 60000 ? ': check source timezone' : ''}` : 'log time ≠ arrival time'}
                tone={lag && lag.skewed ? 'warn' : undefined} />
              <Kpi label="No timestamp" value={lag?.no_ts !== undefined ? int(lag.no_ts) : '—'} sub="arrival time used instead" />
            </div>
            <div className="cards c3">
              <Panel title="Parse quality"><Donut center={`${nm.normalized_pct ?? 0}%`} rows={[
                { label: 'Full', n: nm.full ?? 0 }, { label: 'Partial', n: nm.partial ?? 0 }, { label: 'Raw only', n: nm.raw_only ?? 0 }]} /></Panel>
              <Panel title="OCSF classes"><RankBars rows={ch.classes ?? []} fmt={(x) => className(Number(x))} color="var(--ok)" /></Panel>
              <Panel title="Busiest templates"><RankBars rows={ch.top_templates ?? []} color="var(--sev-info)" /></Panel>
            </div>
          </Section>

          <Section id="traffic" title="Traffic" desc="Who is talking to whom, on what, and what the firewall did about it.">
            <div className="kpis">
              <Kpi label="Unique source IPs" value={u ? int(u.si) : '—'} />
              <Kpi label="Unique destinations" value={u ? int(u.di) : '—'} />
              <Kpi label="Users seen" value={u ? int(u.us) : '—'} />
              <Kpi label="Events (DB)" value={ch.available ? int(nm.total ?? 0) : '—'} sub={ch.available && lag ? `since ${new Date(lag.first * 1000).toLocaleTimeString()}` : undefined} />
            </div>
            <div className="cards c3">
              <Panel title="Top source IPs"><RankBars rows={ch.top_src ?? []} /></Panel>
              <Panel title="Top destination IPs"><RankBars rows={ch.top_dst ?? []} color="var(--sev-notice)" /></Panel>
              <Panel title="Top destination ports"><RankBars rows={ch.top_ports ?? []} color="var(--sev-warn)" /></Panel>
            </div>
            <div className="cards c2">
              <Panel title="Firewall action"><Donut rows={(ch.actions ?? []).map((a) => ({ label: actionName(Number(a.k)), n: a.n }))} /></Panel>
              <Panel title="Protocols"><Donut rows={(ch.protocols ?? []).map((a) => ({ label: String(a.k), n: a.n }))} /></Panel>
            </div>
            <div className="cards c2">
              <Panel title="Top users"><RankBars rows={ch.top_users ?? []} empty="No user fields in these logs" /></Panel>
              <Panel title="OCSF severity"><Donut rows={(ch.ocsf_sev ?? []).map((a) => ({ label: ocsfSevName(Number(a.k)), n: a.n }))} /></Panel>
            </div>
            <div className="cards c2">
              <Panel title="Event volume" subtitle="per minute, last hour · red = high/critical"><Timeline rows={ch.timeline ?? []} /></Panel>
              <Panel title="Event volume" subtitle="per hour, last 24 hours · red = high/critical"><Timeline rows={ch.hours ?? []} left="-24 h" unit="hour" /></Panel>
            </div>
          </Section>

          <Section id="storage" title="Storage efficiency" desc="What it costs to keep every event, compared with a conventional raw + JSON store.">
            <div className="kpis">
              <Kpi label="Reduction vs raw" value={reduction ? `${reduction}×` : '—'} sub={disk ? `${bytesFmt(disk.compressed)} on disk` : undefined} tone={reduction && reduction > 1 ? 'ok' : undefined} />
              <Kpi label="Smaller than baseline" value={vsBase !== null ? `${vsBase}%` : '—'} sub="raw + JSON store" tone={vsBase !== null && vsBase > 0 ? 'ok' : undefined} />
              <Kpi label="Bytes per event" value={perEvent !== null ? `${perEvent} B` : '—'} sub="on disk, compressed" />
              <Kpi label="Space saved" value={disk && rawDb && rawDb > disk.compressed ? bytesFmt(rawDb - disk.compressed) : '—'} sub="versus raw lines" />
              <Kpi label="Storage mode" value={ch.modes ? `${Math.round(100 * (ch.modes.template ?? 0) / Math.max(1, (ch.modes.template ?? 0) + (ch.modes.verbatim ?? 0)))}%` : '—'} sub="stored as template + vars" />
            </div>
            <div className="cards c1">
              <Panel title="On-disk size" subtitle="smaller is better">
                {disk ? (
                  <>
                    <RankBars color="var(--ok)" val={bytesFmt} rows={[
                      ...(rawDb ? [{ k: 'Raw log lines', n: rawDb }] : []),
                      ...(base ? [{ k: 'Baseline (raw + JSON)', n: base.compressed }] : []),
                      { k: 'Aletheia events', n: disk.compressed }]} />
                    <p className="hint">
                      {rawDb ? `${bytesFmt(rawDb)} raw` : 'Raw size unknown'}{base ? ` · ${bytesFmt(base.compressed)} baseline` : ''} · {bytesFmt(disk.compressed)} Aletheia,
                      for {int(disk.rows)} stored events. Raw size is estimated from the average line ({ins.bytes_per_line} B).
                    </p>
                  </>
                ) : <p className="hint">The event database is not reachable.</p>}
              </Panel>
            </div>
          </Section>

          <Section id="sources" title="Sources & governance" desc="Connection health, onboarding state and who approved what.">
            <div className="kpis">
              <Kpi label="Sources online" value={`${k.connected}/${k.sources}`} sub={`${ins.stale} quiet`} tone={ins.stale ? 'warn' : 'ok'} />
              <Kpi label="Awaiting approval" value={int(k.in_review)} tone={k.in_review ? 'warn' : undefined} />
              <Kpi label="Approved" value={int(k.approved)} sub={`${k.rejected} rejected`} />
              <Kpi label="Packs approved" value={int(k.packs)} sub={`${int(k.forwarded)} lines sent to bus`} />
              <Kpi label="Mean time to approve" value={dur(ins.mean_approval_s)} sub="source created → approved" />
              <Kpi label="Freshness" value={ins.freshness_s === null ? '—' : dur(ins.freshness_s)} sub="since the last line" />
            </div>
            <div className="cards c2">
              <Panel title="Source health" flush>
                <div className="table-scroll"><table className="data">
                  <thead><tr><th>Source</th><th>Connection</th><th>Onboarding</th><th>/s</th><th>Last 5 min</th><th>Last seen</th></tr></thead>
                  <tbody>
                    {d.sources.map((s) => (
                      <tr key={s.id}>
                        <td><Link to="/dashboard/sources">{s.id}</Link></td>
                        <td><Badge kind={s.status === 'connected' ? 'ok' : s.status === 'passive' ? 'plain' : 'warn'} title={s.error}>{s.enabled ? s.status : 'paused'}</Badge></td>
                        <td><Badge kind={s.state === 'approved' ? 'ok' : s.state === 'review' ? 'warn' : s.state === 'rejected' ? 'bad' : 'plain'}>{s.state}</Badge></td>
                        <td className="mono">{s.eps}</td><td><Spark v={s.spark} /></td>
                        <td className="hint">{s.last_seen ? ago(s.last_seen) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              </Panel>
              <Panel title="Recent decisions">
                {d.history.length === 0 ? <p className="hint">No approvals yet. Open a source in review on <Link to="/dashboard/sources">Sources</Link>.</p> : (
                  <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {d.history.map((h) => (
                      <li key={`${h.source}-${h.at}`} className="row-tight">
                        <Badge kind={h.action === 'approved' ? 'ok' : h.action === 'rejected' ? 'bad' : 'plain'}>{h.action}</Badge>
                        <span>{h.source}</span><span className="hint">by {h.actor} · {ago(h.at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          </Section>
        </>
      )}
    </>
  );
}
