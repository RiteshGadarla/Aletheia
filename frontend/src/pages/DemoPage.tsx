// Demo Console (spec 21). Each card leads with an action button and plain language about what it
// does and proves. The CLI equivalent stays available but tucked behind a disclosure.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Badge, CliDisclosure, EmptyState, ErrorState, PageHead, Panel, Spinner,
} from '../components/Bits';
import { IconDemo } from '../components/Icons';
import { SeverityBar } from './SourcesPage';
import { api, errMessage } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { DemoRunResult, DemoScenario, SampleServer } from '../lib/types';

/** Requirement letters from the problem statement, spelled out on hover. */
const REQ_TITLE: Record<string, string> = {
  a: 'Preserve raw event data without loss',
  b: 'Extract source-specific attributes',
  c: 'Normalize into a common taxonomy',
  d: 'Maintain traceability to the original',
  e: 'Plug-and-play onboarding of new sources',
  f: 'Unified visibility across the enterprise',
  g: 'SIEM and data lake integration',
  h: 'AI/ML-ready analytics',
  i: 'Reduced parser development effort',
  j: 'Deployable in an air-gapped network',
  k: 'Packaged in a container',
};

function ScenarioCard({ s, result, busy, onRun }: {
  s: DemoScenario;
  result?: DemoRunResult;
  busy: boolean;
  onRun: () => void;
}) {
  const state = result ? (result.ok ? ' done' : ' failed') : '';
  return (
    <Panel
      className={`scenario${state}`}
      title={<><span className="num">{s.number}</span>{s.title}</>}
      right={s.requirements?.length
        ? s.requirements.map((r) => (
          <Badge key={r} kind="info" title={REQ_TITLE[r] ?? 'requirement'}>{r}</Badge>
        ))
        : undefined}
    >
      <div className="explain">
        <div className="blk">
          <span className="lbl">What it proves</span>
          <span className="txt">{s.proves}</span>
        </div>
        <div className="blk">
          <span className="lbl">What you should see</span>
          <span className="txt expect">{s.expected}</span>
        </div>
      </div>

      <div className="actions">
        {s.runnable ? (
          <button className="primary" onClick={onRun} disabled={busy}>
            {busy ? 'Running…' : s.action_label}
          </button>
        ) : (
          <Badge kind="plain">performed outside the UI</Badge>
        )}
        {s.link && s.link.href.startsWith('/') && !s.link.external && (
          <Link className="btn-link" to={s.link.href}>{s.link.label}</Link>
        )}
      </div>

      {result && (
        <div className={`run-result ${result.ok ? 'ok' : 'bad'}`}>
          <div className="rr-head">
            {result.ok ? 'passed' : 'failed'}
            <span className="t">{result.duration_ms} ms</span>
          </div>
          {result.output && <pre className="out">{result.output}</pre>}
        </div>
      )}

      {s.cli && <CliDisclosure cmd={s.cli} />}
    </Panel>
  );
}

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
  const { data: scenarios, loading, error } = useAsync(() => api.listScenarios(), []);
  // "Run these in order" is the instruction on the page, but the catalogue arrives unordered.
  const ordered = useMemo(
    () => [...(scenarios ?? [])].sort((a, b) => a.number - b.number),
    [scenarios],
  );
  const [results, setResults] = useState<Record<string, DemoRunResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const run = async (id: string) => {
    setBusy(id); setFailure(null);
    try {
      const res = await api.runScenario(id);
      setResults((r) => ({ ...r, [id]: res }));
    } catch (e) { setFailure(errMessage(e)); } finally { setBusy(null); }
  };

  const reset = async () => {
    setResetting(true); setFailure(null);
    try { await api.resetDemo(); setResults({}); }
    catch (e) { setFailure(errMessage(e)); } finally { setResetting(false); }
  };

  return (
    <div className="stack">
      <PageHead
        title="Demo"
        right={
          <button onClick={reset} disabled={resetting || loading}>
            {resetting ? 'Resetting…' : 'Reset demo'}
          </button>
        }
      >
        Spin up realistic log servers and connect them, or run the guided scenarios below.
      </PageHead>

      <SampleServers />
      <h2 style={{ margin: 'var(--s4) 0 0', fontSize: 'var(--fs-lg, 18px)' }}>Guided scenarios</h2>
      <p className="hint" style={{ margin: 0 }}>
        Run these in order. Generators use a fixed seed, so every run produces the same data and results.
      </p>

      {failure && <ErrorState error={failure} what="that scenario" />}
      {loading && <Spinner label="Loading scenarios" />}
      {error && <ErrorState error={error} what="the demo scenarios" />}

      {!loading && !error && !scenarios?.length && (
        <Panel flush>
          <EmptyState title="No scenarios registered" icon={<IconDemo size={22} />}>
            The Studio API returned an empty catalogue.
          </EmptyState>
        </Panel>
      )}

      {!!ordered.length && (
        <div className="demo-grid">
          {ordered.map((s) => (
            <ScenarioCard
              key={s.id}
              s={s}
              result={results[s.id]}
              busy={busy === s.id}
              onRun={() => void run(s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
