// Demo: start realistic sample log servers, then press Connect to add them on the Sources page.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, ErrorState, PageHead, Panel } from '../components/Bits';
import { api, errMessage } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { SampleServer } from '../lib/types';
import { SeverityBar } from './SourcesPage';

/** Sources page URL that pre-fills the connect form for this sample. */
const connectUrl = (s: SampleServer) => {
  const q = new URLSearchParams({ connect: '1', id: s.preset.id, type: s.preset.type, ...s.preset.config });
  return `/dashboard/sources?${q.toString()}`;
};

function SampleCard({ s, busy, onStart, onStop, onAttack, onConnect }: {
  s: SampleServer; busy: boolean; onStart: () => void; onStop: () => void; onAttack: () => void; onConnect: () => void;
}) {
  const st = s.stats;
  const attacking = !!st && st.risk > 0.6;
  return (
    <Panel
      title={s.title}
      subtitle={`${s.format} · ${s.transport} · :${s.port}`}
      right={<Badge kind={s.running ? 'ok' : 'plain'}>{s.running ? (s.managed ? 'running' : 'running (external)') : 'stopped'}</Badge>}
    >
      <div className="stack-sm">
        {st ? (
          <>
            <div className="row-tight">
              <span className="mono">{st.avg_eps}/s</span><span className="hint">avg</span>
              <span className="mono">{st.total.toLocaleString()}</span><span className="hint">lines</span>
              <Badge kind={st.mood === 'attack' ? 'bad' : st.mood === 'elevated' ? 'warn' : 'ok'}>{st.mood}</Badge>
            </div>
            <SeverityBar by={st.by_severity} />
          </>
        ) : <p className="hint">Not running. Start it, then connect Aletheia to port {s.port}.</p>}
        <div className="btn-row">
          {s.running
            ? <button onClick={onStop} disabled={busy || !s.managed} title={s.managed ? '' : 'Started outside Studio'}>Stop</button>
            : <button className="primary" onClick={onStart} disabled={busy}>{busy ? 'Starting…' : 'Start'}</button>}
          <button className={s.running ? 'primary' : ''} onClick={onConnect} disabled={!s.running}>Connect</button>
          <button className="ghost" onClick={onAttack} disabled={!s.running}>{attacking ? 'Calm down' : 'Simulate attack'}</button>
        </div>
      </div>
    </Panel>
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

  return (
    <div className="stack-sm">
      <div className="row-tight" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'var(--fs-lg, 18px)' }}>Sample log servers</h2>
          <p className="hint" style={{ margin: 0 }}>Start a server, press Connect, and Aletheia opens Sources with the form filled in.</p>
        </div>
        <div className="btn-row">
          <button className="primary" disabled={busy !== null || !q.data?.available} onClick={() => void all(true)}>Start all</button>
          <button disabled={busy !== null} onClick={() => void all(false)}>Stop all</button>
        </div>
      </div>
      {err && <ErrorState error={err} what="that sample server" />}
      {q.error && <ErrorState error={q.error} what="the sample servers" />}
      {q.data && !q.data.available && <p className="hint err">The generator servers are not part of this build.</p>}
      <div className="demo-grid">
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
        Start realistic log servers, press Connect, and watch them appear on Sources and the Overview.
      </PageHead>
      <SampleServers />
    </div>
  );
}
