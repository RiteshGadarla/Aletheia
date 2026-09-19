// Demo Console (spec 21). Every card states what it proves, what success looks like, and shows
// the equivalent CLI command, so nothing is hidden behind the UI.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Cli, Empty, ErrorBox, Loading, Panel } from '../components/Bits';
import { api, errMessage } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { DemoRunResult } from '../lib/types';

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

  if (loading) return <Loading what="scenarios" />;
  if (error) return <ErrorBox error={error} />;
  if (!scenarios?.length) return <Empty>No scenarios registered.</Empty>;

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h1>Demo Console</h1>
          <p className="muted">
            Run these in order. Generators use a fixed seed, so every run produces the same data and
            the same results.
          </p>
        </div>
        <button onClick={reset} disabled={resetting}>
          {resetting ? 'Resetting…' : 'Reset demo'}
        </button>
      </div>

      {failure && <ErrorBox error={failure} />}

      {scenarios.map((s) => {
        const res = results[s.id];
        return (
          <Panel
            key={s.id}
            title={<span><span className="muted">{s.number}</span>&nbsp; {s.title}</span>}
            right={
              <div className="row gap">
                {s.requirements.map((r) => <Badge key={r} kind="info" title="requirement proved">{r}</Badge>)}
                {res && <Badge kind={res.ok ? 'ok' : 'bad'}>{res.ok ? 'passed' : 'failed'}</Badge>}
              </div>
            }
          >
            <dl className="kv">
              <dt>Proves</dt><dd>{s.proves}</dd>
              <dt>Expected</dt><dd>{s.expected}</dd>
            </dl>

            <Cli cmd={s.cli} />

            <div className="row gap">
              {s.runnable ? (
                <button onClick={() => void run(s.id)} disabled={busy !== null}>
                  {busy === s.id ? 'Running…' : s.action_label}
                </button>
              ) : (
                <Badge kind="plain">run this outside the UI — see the command above</Badge>
              )}
              {s.link && (s.link.external
                ? <a className="btn-link" href={s.link.href} target="_blank" rel="noreferrer">{s.link.label}</a>
                : <Link className="btn-link" to={s.link.href}>{s.link.label}</Link>)}
            </div>

            {res && (
              <div className={`result ${res.ok ? 'result-ok' : 'result-bad'}`}>
                <p className="muted">finished in {res.duration_ms} ms</p>
                {res.output && <pre className="output">{res.output}</pre>}
              </div>
            )}
          </Panel>
        );
      })}
    </div>
  );
}
