// Overview analytics widgets: posture gauge, donut, ranked bars, timeline, auto-written findings.
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Insights, KN, Overview } from '../lib/types';

const int = (n: number) => n.toLocaleString();
export const bytesFmt = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
};
const OCSF_SEV: Record<number, string> = { 0: 'unknown', 1: 'informational', 2: 'low', 3: 'medium', 4: 'high', 5: 'critical' };
const ACTION: Record<number, string> = { 0: 'unknown', 1: 'allowed', 2: 'denied', 3: 'observed', 4: 'modified' };
const CLASS: Record<number, string> = {
  1001: 'File activity', 1007: 'Process activity', 2004: 'Detection finding', 3001: 'Account change', 3002: 'Authentication',
  4001: 'Network activity', 4002: 'HTTP activity', 4003: 'DNS activity', 4007: 'SSH activity', 6003: 'API activity',
};
export const className = (k: number) => CLASS[k] ?? `class ${k}`;
export const actionName = (k: number) => ACTION[k] ?? `action ${k}`;
export const ocsfSevName = (k: number) => OCSF_SEV[k] ?? `sev ${k}`;
const PALETTE = ['var(--accent)', 'var(--sev-notice)', 'var(--ok)', 'var(--sev-warn)', 'var(--sev-risk)', 'var(--sev-info)', 'var(--text-muted)'];

export function Gauge({ value, label }: { value: number; label: string }) {
  const R = 54; const C = 2 * Math.PI * R * 0.75;
  const tone = value >= 80 ? 'var(--ok)' : value >= 55 ? 'var(--sev-warn)' : 'var(--sev-risk)';
  return (
    <div className="gauge" role="img" aria-label={`${label} ${value} out of 100`}>
      <svg viewBox="0 0 140 130">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--border)" strokeWidth="12" strokeLinecap="round"
          strokeDasharray={`${C} 999`} transform="rotate(135 70 70)" />
        <circle cx="70" cy="70" r={R} fill="none" stroke={tone} strokeWidth="12" strokeLinecap="round"
          strokeDasharray={`${(C * value) / 100} 999`} transform="rotate(135 70 70)" style={{ transition: 'stroke-dasharray .6s' }} />
        <text x="70" y="74" textAnchor="middle" className="g-num">{value}</text>
        <text x="70" y="94" textAnchor="middle" className="axis-t">{label}</text>
      </svg>
    </div>
  );
}

export function Donut({ rows, center }: { rows: { label: string; n: number }[]; center?: string }) {
  const total = rows.reduce((a, r) => a + r.n, 0) || 1;
  const R = 44; const C = 2 * Math.PI * R;
  let off = 0;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 120 120" className="donut" role="img" aria-label="Distribution">
        <circle cx="60" cy="60" r={R} fill="none" stroke="var(--border)" strokeWidth="16" />
        {rows.map((r, i) => {
          const len = (r.n / total) * C;
          const el = <circle key={r.label} cx="60" cy="60" r={R} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="16"
            strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} transform="rotate(-90 60 60)"><title>{`${r.label}: ${int(r.n)}`}</title></circle>;
          off += len;
          return el;
        })}
        {center && <text x="60" y="65" textAnchor="middle" className="g-num sm">{center}</text>}
      </svg>
      <ul className="legend col">
        {rows.map((r, i) => (
          <li key={r.label}><i style={{ background: PALETTE[i % PALETTE.length] }} />{r.label}
            <b>{Math.round((r.n / total) * 100)}%</b></li>
        ))}
      </ul>
    </div>
  );
}

export function RankBars({ rows, fmt = (k: string | number) => String(k), val = int, color = 'var(--accent)', empty = 'No data yet' }: {
  rows: KN[]; fmt?: (k: string | number) => string; val?: (n: number) => string; color?: string; empty?: string;
}) {
  if (!rows.length) return <p className="hint">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.n), 1);
  return (
    <div className="rank">
      {rows.map((r) => (
        <div className="rank-row" key={String(r.k)} title={`${fmt(r.k)}: ${val(r.n)}`}>
          <span className="truncate mono">{fmt(r.k)}</span>
          <div className="rank-track"><div style={{ width: `${Math.max((r.n / max) * 100, 2)}%`, background: color }} /></div>
          <span className="n">{val(r.n)}</span>
        </div>
      ))}
    </div>
  );
}

/** Per-minute event volume for the last hour with high-severity overlay. */
export function Timeline({ rows, left = '-60 min', unit = 'minute' }: { rows: { t: number; n: number; hi: number }[]; left?: string; unit?: 'minute' | 'hour' }) {
  const [hover, setHover] = useState<number | null>(null);
  if (rows.length < 2) return <p className="hint">Collecting data — this chart needs at least two {unit}s of events.</p>;
  const W = 720; const H = 170; const B = 20;
  const max = Math.max(...rows.map((r) => r.n), 1);
  const bw = (W - 8) / rows.length;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Events per ${unit}`} onMouseLeave={() => setHover(null)}>
        <line className="grid" x1="0" x2={W} y1={H - B} y2={H - B} />
        {rows.map((r, i) => {
          const h = (r.n / max) * (H - B - 6); const hh = (r.hi / max) * (H - B - 6);
          return (
            <g key={r.t} onMouseEnter={() => setHover(i)}>
              <rect x={4 + i * bw} y={0} width={bw} height={H - B} fill="transparent" />
              <rect x={4 + i * bw + 1} y={H - B - h} width={Math.max(bw - 2, 1)} height={h} rx="2" fill="var(--sev-info)" opacity={hover === i ? 1 : 0.7} />
              {hh > 0 && <rect x={4 + i * bw + 1} y={H - B - hh} width={Math.max(bw - 2, 1)} height={hh} rx="2" fill="var(--sev-risk)" />}
            </g>
          );
        })}
        <text className="axis-t" x="4" y={H - 4}>{left}</text>
        <text className="axis-t" x={W - 4} y={H - 4} textAnchor="end">now</text>
      </svg>
      {hover !== null && (
        <div className="tip" style={{ left: `${((4 + hover * bw + bw / 2) / W) * 100}%`, top: 8 }}>
          <b>{int(rows[hover].n)}</b> events · <b>{int(rows[hover].hi)}</b> high/critical · {new Date(rows[hover].t * 1000).toLocaleString([], unit === 'hour' ? { weekday: 'short', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
}

export type Finding = { tone: 'ok' | 'warn' | 'bad' | 'info'; title: string; body: string };

/** Turn the numbers into plain-language findings a reviewer can read in ten seconds. */
export function findings(d: Overview): Finding[] {
  const i: Insights = d.insights; const k = d.kpis; const out: Finding[] = [];
  const disk = i.ch.disk?.events; const base = i.ch.disk?.baseline_events;
  if (disk && base && base.compressed > 0 && disk.compressed > 0) {
    const pct = Math.round((1 - disk.compressed / base.compressed) * 100);
    out.push({ tone: pct > 0 ? 'ok' : 'info', title: `${pct > 0 ? pct + '% smaller' : 'Comparable'} than a conventional raw + JSON store`,
      body: `${bytesFmt(disk.compressed)} on disk vs ${bytesFmt(base.compressed)} for the baseline table, while keeping a SHA-256 on every event.` });
  }
  if (disk && k.bytes > 0 && disk.compressed > 0) {
    out.push({ tone: 'ok', title: `${(k.bytes / disk.compressed).toFixed(1)}× reduction from raw log bytes`,
      body: `${bytesFmt(k.bytes)} of raw lines ingested → ${bytesFmt(disk.compressed)} of normalized, queryable events.` });
  }
  if (i.spike) out.push({ tone: 'warn', title: 'Ingest spike detected', body: `Current rate is ${i.z}σ above the 5-minute mean (peak ${i.peak_eps}/s)${i.noisiest ? `; ${i.noisiest} is the loudest source` : ''}.` });
  const top = i.risk_rank[0];
  if (top && top.risk > 0) out.push({ tone: top.pct >= 20 ? 'bad' : 'warn', title: `${top.id} is the risk hotspot`, body: `${top.pct}% of its ${int(top.lines)} lines are risk-severity (${int(top.risk)} lines).` });
  else if (k.lines > 0) out.push({ tone: 'ok', title: 'No risk-severity lines observed', body: 'Every ingested line is info, notice or warn.' });
  const sc = i.ch.scanners?.[0];
  if (sc) out.push({ tone: sc.n >= 15 ? 'bad' : 'warn', title: `Possible port scan from ${sc.k}`, body: `Touched ${sc.n} distinct destination ports; ${i.ch.scanners!.length} suspect source${i.ch.scanners!.length === 1 ? '' : 's'} in total.` });
  const lag = i.ch.lag;
  if (lag && lag.denied > 0 && d.normalized.total) out.push({ tone: 'info', title: `${Math.round((lag.denied / d.normalized.total) * 100)}% of traffic was denied`, body: `${int(lag.denied)} denied connections${i.ch.top_denied?.[0] ? `; ${i.ch.top_denied[0].k} is the most blocked source` : ''}.` });
  if (i.stale > 0) out.push({ tone: 'warn', title: `${i.stale} source${i.stale === 1 ? ' has' : 's have'} gone quiet`, body: 'No lines for over a minute on an enabled source. Check the connection.' });
  if (k.in_review > 0) out.push({ tone: 'warn', title: `${k.in_review} source${k.in_review === 1 ? '' : 's'} waiting for approval`, body: 'Events are stored raw until a pack is approved; approve to start normalizing.' });
  if (k.errors > 0) out.push({ tone: 'bad', title: `${int(k.errors)} pipeline error${k.errors === 1 ? '' : 's'}`, body: `Error rate ${i.error_rate}% of lines. Check Source health below.` });
  if (d.normalized.available && (d.normalized.total ?? 0) > 0)
    out.push({ tone: (d.normalized.normalized_pct ?? 0) >= 90 ? 'ok' : 'warn', title: `${d.normalized.normalized_pct}% of events parsed into OCSF`, body: `${int(d.normalized.raw_only ?? 0)} raw-only events remain; ${int(d.normalized.templates ?? 0)} templates cover the rest.` });
  const u = i.ch.unique;
  if (u && u.n > 0) out.push({ tone: 'info', title: `${int(u.hashed)} of ${int(u.n)} events carry a tamper-evident hash`, body: `Sealed in ${int(u.mb)} Merkle batch${u.mb === 1 ? '' : 'es'}; ${int(u.si)} distinct source IPs and ${int(u.di)} destinations seen.` });
  if (d.bus) out.push({ tone: 'info', title: 'Forwarding to the event bus', body: `${int(k.forwarded)} lines forwarded from ${k.packs} approved pack${k.packs === 1 ? '' : 's'}.` });
  return out;
}

/* ---------------------------------------------------------------- layout primitives */

/** Every Overview block sits in a Section: same heading, same one-line purpose, same spacing. */
export function Section({ id, title, desc, children }: { id: string; title: string; desc: string; children: ReactNode }) {
  return (
    <section className="ov-section" id={id} aria-labelledby={`${id}-h`}>
      <div className="ov-head"><h2 id={`${id}-h`}>{title}</h2><p>{desc}</p></div>
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, tone, trend }: {
  label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'bad'; trend?: number;
}) {
  return (
    <div className={`kpi${tone ? ` t-${tone}` : ''}`}>
      <div className="k-label">{label}</div>
      <div className="k-value">{value}
        {trend !== undefined && trend !== 0 && <span className={`k-trend ${trend > 0 ? 'up' : 'down'}`} title="vs previous minute">{trend > 0 ? '▲' : '▼'}{Math.abs(trend)}%</span>}
      </div>
      {sub && <div className="k-sub">{sub}</div>}
    </div>
  );
}

/** Sources x last five minutes; darker = more lines per second, scaled per row so quiet sources stay visible. */
export function Heatmap({ rows }: { rows: { id: string; spark: number[] }[] }) {
  if (!rows.length) return <p className="hint">No sources yet.</p>;
  return (
    <div className="heat" role="img" aria-label="Per-source activity over the last five minutes">
      {rows.map((r) => {
        const m = Math.max(...r.spark, 0.001);
        return (
          <div className="heat-row" key={r.id}>
            <span className="truncate" title={r.id}>{r.id}</span>
            <div className="heat-cells">{r.spark.map((v, i) => <i key={i} title={`${r.id}: ${v.toFixed(1)}/s`} style={{ opacity: v ? 0.12 + 0.88 * (v / m) : 0.06 }} />)}</div>
          </div>
        );
      })}
      <div className="heat-row"><span /><div className="heat-axis"><span>-5 min</span><span>now</span></div></div>
    </div>
  );
}

export const dur = (s: number | null) => (s === null ? '—' : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
