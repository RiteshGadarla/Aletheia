// Demo Console (spec 21). Each card leads with an action button and plain language about what it
// does and proves. The CLI equivalent stays available but tucked behind a disclosure.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge, CliDisclosure, EmptyState, ErrorState, PageHead, Panel, Spinner,
} from '../components/Bits';
import { IconDemo } from '../components/Icons';
import { api, errMessage } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { DemoRunResult, DemoScenario } from '../lib/types';

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
      right={s.requirements.map((r) => (
        <Badge key={r} kind="info" title={REQ_TITLE[r] ?? 'requirement'}>{r}</Badge>
      ))}
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
        {s.link && (s.link.external
          ? <a className="btn-link" href={s.link.href} target="_blank" rel="noreferrer">{s.link.label}</a>
          : <Link className="btn-link" to={s.link.href}>{s.link.label}</Link>)}
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

export function DemoPage() {
  const { data: scenarios, loading, error } = useAsync(() => api.listScenarios(), []);
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
        title="Demo Console"
        right={
          <button onClick={reset} disabled={resetting || loading}>
            {resetting ? 'Resetting…' : 'Reset demo'}
          </button>
        }
      >
        Run these in order. Generators use a fixed seed, so every run produces the same data and the
        same results.
      </PageHead>

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

      {!!scenarios?.length && (
        <div className="demo-grid">
          {scenarios.map((s) => (
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
