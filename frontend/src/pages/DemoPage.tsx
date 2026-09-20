// Demo: start realistic sample log servers, then press Connect to add them on the Sources page.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, ErrorState, PageHead } from '../components/Bits';
import { api, errMessage } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { SampleServer } from '../lib/types';
import { SeverityBar } from './SourcesPage';

/** Sources page URL that pre-fills the connect form for this sample. */
const connectUrl = (s: SampleServer) => {
  const q = new URLSearchParams({ connect: '1', id: s.preset.id, type: s.preset.type, ...s.preset.config });
  return `/dashboard/sources?${q.toString()}`;
};

const CAT_CLASS: Record<string, string> = { 'Network security': 'net', 'Web and apps': 'web', Access: 'access', Critical: 'crit' };

/** One line-art icon per sample server (24px grid, currentColor). */
function SampleIcon({ id }: { id: string }) {
  const paths: Record<string, JSX.Element> = {
    asa: <path d="M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6z" />,
    fortigate: <><path d="M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6z" /><path d="M8.5 12l2.4 2.4 4.6-4.8" /></>,
    web: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18" /></>,
    vpn: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3M14 9l2 2" /></>,
    cef: <><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18h.01" /></>,
    app: <path d="M8 8l-5 4 5 4M16 8l5 4-5 4M14 5l-4 14" />,
    shop: <><path d="M3 4h2l2.5 11h10l2-8H6.5" /><circle cx="9" cy="20" r="1.3" /><circle cx="17" cy="20" r="1.3" /></>,
    defense: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 1v5M12 18v5M1 12h5M18 12h5" /></>,
  };
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[id] ?? paths.app}
    </svg>
  );
}

function SampleCard({ s, busy, onStart, onStop, onAttack, onConnect }: {
  s: SampleServer; busy: boolean; onStart: () => void; onStop: () => void; onAttack: () => void; onConnect: () => void;
}) {
  const st = s.stats;
  const attacking = !!st && st.risk > 0.6;
  return (
    <article className={`sample-card ${CAT_CLASS[s.category] ?? 'net'}${s.running ? '' : ' off'}`}>
      <div className="sc-head">
        <span className="sc-icon"><SampleIcon id={s.id} /></span>
        <div className="grow">
          <div className="sc-cat">{s.category}</div>
          <div className="sc-title">{s.title}</div>
        </div>
        <Badge kind={s.running ? 'ok' : 'plain'}>{s.running ? (s.managed ? 'running' : 'running (external)') : 'stopped'}</Badge>
      </div>
      <p className="sc-purpose">{s.purpose}</p>
      <div className="sc-chips"><span>{s.format}</span><span>{s.transport}</span><span>port {s.port}</span></div>
      {st ? (
        <div className="sc-stats">
          <span className="eps">{st.avg_eps}<small className="hint"> /s</small></span>
          <span className="hint">{st.total.toLocaleString()} lines</span>
          <Badge kind={st.mood === 'attack' ? 'bad' : st.mood === 'elevated' ? 'warn' : 'ok'}>{st.mood}</Badge>
          <SeverityBar by={st.by_severity} />
        </div>
      ) : <div className="sc-off">Not running. Start it, then press Connect.</div>}
      <div className="btn-row">
        {s.running
          ? <button onClick={onStop} disabled={busy || !s.managed} title={s.managed ? '' : 'Started outside Studio'}>Stop</button>
          : <button className="primary" onClick={onStart} disabled={busy}>{busy ? 'Starting…' : 'Start'}</button>}
        <button className={s.running ? 'primary' : ''} onClick={onConnect} disabled={!s.running}>Connect</button>
        <button className="ghost" onClick={onAttack} disabled={!s.running}>{attacking ? 'Calm down' : 'Simulate attack'}</button>
      </div>
    </article>
  );
}

function SampleServers() {
  const nav = useNavigate();
  const q = useAsync(() => api.listSamples(), []);
  const { reload } = q;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(reload, 3000); return () => clearInterval(t); }, [reload]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setErr(null);
    try { await fn(); reload(); } catch (e) { setErr(errMessage(e)); } finally { setBusy(null); }
  };
  const all = async (start: boolean) => {
    setBusy('*'); setErr(null);
    try {
      for (const s of q.data?.samples ?? []) {
        if (start && !s.running) await api.startSample(s.id);
        if (!start && s.running && s.managed) await api.stopSample(s.id);
      }
      reload();
    } catch (e) { setErr(errMessage(e)); } finally { setBusy(null); }
  };
  const samples = q.data?.samples ?? [];
  const running = samples.filter((x) => x.running);
  const eps = running.reduce((a, x) => a + (x.stats?.avg_eps ?? 0), 0);
  const lines = running.reduce((a, x) => a + (x.stats?.total ?? 0), 0);

  return (
    <div className="stack">
      <div className="demo-summary">
        <div><div className="big">{running.length}<span className="hint"> / {samples.length}</span></div><div className="lbl">servers running</div></div>
        <div><div className="big">{Math.round(eps)}</div><div className="lbl">lines per second</div></div>
        <div><div className="big">{lines.toLocaleString()}</div><div className="lbl">lines generated</div></div>
        <div className="grow" />
        <div className="btn-row">
          <button className="primary" disabled={busy !== null || !q.data?.available} onClick={() => void all(true)}>Start all</button>
          <button disabled={busy !== null} onClick={() => void all(false)}>Stop all</button>
        </div>
      </div>
      {err && <ErrorState error={err} what="that sample server" />}
      {q.error && <ErrorState error={q.error} what="the sample servers" />}
      {q.data && !q.data.available && <p className="hint err">The generator servers are not part of this build.</p>}
      <div className="sample-grid">
        {samples.map((s) => (
          <SampleCard key={s.id} s={s} busy={busy === s.id || busy === '*'}
            onStart={() => void act(s.id, () => api.startSample(s.id))}
            onStop={() => void act(s.id, () => api.stopSample(s.id))}
            onAttack={() => void act(s.id, () => api.controlSample(s.id, (s.stats?.risk ?? 0) > 0.6 ? { clear_risk: true, rate: undefined } : { risk: 0.9 }))}
            onConnect={() => nav(connectUrl(s))} />
        ))}
      </div>
    </div>
  );
}

export function DemoPage() {
  return (
    <div className="stack">
      <PageHead title="Demo">
        Eight fictional log servers, from firewalls to an online store to a military network. Start one, press Connect, and watch it flow through Aletheia.
      </PageHead>
      <SampleServers />
    </div>
  );
}
