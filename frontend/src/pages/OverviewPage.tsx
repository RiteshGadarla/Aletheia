// Overview: live ingest stats. Polls the Studio API; every chart has a table fallback and legend.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, ErrorState, PageHead, Panel, Spinner } from '../components/Bits';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { Overview } from '../lib/types';
import { IconExport } from '../components/Icons';


const SEVS = ['info', 'notice', 'warn', 'risk'] as const;
const SEV_VAR: Record<string, string> = {
  info: 'var(--sev-info)', notice: 'var(--sev-notice)', warn: 'var(--sev-warn)', risk: 'var(--sev-risk)',
};
const int = (n: number) => n.toLocaleString();
const bytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
};
const ago = (t: number) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="kpi"><div className="k-label">{label}</div><div className="k-value">{value}</div>{sub && <div className="k-sub">{sub}</div>}</div>;
}

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

function SeverityLegend() {
  return <div className="legend" aria-label="Severity legend">{SEVS.map((s) => <span key={s}><i style={{ background: SEV_VAR[s] }} />{s}</span>)}</div>;
}

function SeverityBars({ rows }: { rows: Overview['sources'] }) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const max = Math.max(...rows.map((r) => r.lines), 1);
  return (
    <div className="chart" onMouseLeave={() => setTip(null)}>
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

export function OverviewPage() {
  const q = useAsync(() => api.overview(), []);
  const { reload } = q;
  useEffect(() => { const t = setInterval(reload, 3000); return () => clearInterval(t); }, [reload]);
  const d = q.data;
  const k = d?.kpis;
  const total = d ? Object.values(d.by_severity).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="stack">
      <PageHead
        title="Overview"
        right={
          <Link
            to="/dashboard/export?tab=report"
            className="btn secondary sm flex align-center"
            style={{ gap: 4 }}
          >
            <IconExport size={14} /> Export Report & Logs
          </Link>
        }
      >
        Live ingest across every connected source. Updates every 3 seconds.
      </PageHead>


      {q.error && <ErrorState error={q.error} what="stats" />}
      {q.loading && !d && <Spinner label="Loading stats" />}
      {d && k && (
        <>
          <div className="kpis">
            <Kpi label="Lines stored" value={int(k.lines)} sub={bytes(k.bytes)} />
            <Kpi label="Ingest rate" value={`${k.eps}/s`} sub={`${int(k.buffered)} buffered`} />
            <Kpi label="Sources online" value={`${k.connected}/${k.sources}`} sub={`${k.errors} connection error${k.errors === 1 ? '' : 's'}`} />
            <Kpi label="Awaiting approval" value={int(k.in_review)} sub={`${k.approved} approved · ${k.rejected} rejected`} />
            <Kpi label="Risk share" value={`${k.risk_pct}%`} sub={`${int(d.by_severity.risk ?? 0)} risk lines`} />
            <Kpi label="Packs approved" value={int(k.packs)} sub={`${int(k.forwarded)} lines sent to bus`} />
          </div>

          {d.sources.length === 0 ? (
            <EmptyState title="Nothing ingesting yet">
              Start a sample server on the <Link to="/dashboard/demo">Demo</Link> page, or add a source on <Link to="/dashboard/sources">Sources</Link>.
            </EmptyState>
          ) : (
            <div className="viz-grid">
              <Panel title="Lines per second" subtitle="all sources, last 5 minutes">
                <RateChart series={d.series} bucketS={d.bucket_s} />
              </Panel>
              <Panel title="Severity by source" subtitle={`${int(total)} lines`}>
                <div style={{ marginBottom: 'var(--s3)' }}><SeverityLegend /></div>
                <SeverityBars rows={d.sources} />
              </Panel>
            </div>
          )}

          <div className="viz-grid">
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
            <div className="stack">
              <Panel title="Normalized events" subtitle="ClickHouse">
                {d.normalized.available ? (
                  <div className="kpis">
                    <Kpi label="Events" value={int(d.normalized.total ?? 0)} />
                    <Kpi label="Normalized" value={`${d.normalized.normalized_pct}%`} sub={`${int(d.normalized.raw_only ?? 0)} raw only`} />
                    <Kpi label="Templates" value={int(d.normalized.templates ?? 0)} />
                  </div>
                ) : <p className="hint">The event database is not reachable. Raw lines are still being stored.</p>}
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
          </div>

          <details>
            <summary className="hint">Show chart data as a table</summary>
            <div className="table-scroll"><table className="data">
              <thead><tr><th>Source</th>{SEVS.map((s) => <th key={s}>{s}</th>)}<th>Total</th></tr></thead>
              <tbody>{d.sources.map((r) => (
                <tr key={r.id}><td>{r.id}</td>{SEVS.map((s) => <td key={s} className="mono">{int(r.by_severity[s] ?? 0)}</td>)}<td className="mono">{int(r.lines)}</td></tr>
              ))}</tbody>
            </table></div>
          </details>
        </>
      )}
    </div>
  );
}
