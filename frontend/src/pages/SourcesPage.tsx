// Sources: connect any log system, watch raw lines land, then approve, reject or retry the mapping.
import { useCallback, useEffect, useState } from 'react';
import { Badge, Confidence, EmptyState, ErrorState, PageHead, Panel, Spinner } from '../components/Bits';
import { api, errMessage } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { BadgeKind } from '../components/Bits';
import type { SourceCluster, SourceInfo, SourceProposal, SourceState } from '../lib/types';

const SEV_COLOR: Record<string, string> = {
  info: 'var(--sev-info)', notice: 'var(--sev-notice)', warn: 'var(--sev-warn)', risk: 'var(--sev-risk)',
};
const STATE_KIND: Record<SourceState, BadgeKind> = { collecting: 'plain', review: 'warn', approved: 'ok', rejected: 'bad' };
const TYPE_FIELDS: Record<string, { k: string; label: string; ph: string }[]> = {
  tcp: [{ k: 'host', label: 'Host', ph: '127.0.0.1' }, { k: 'port', label: 'Port', ph: '9101' }],
  udp_listen: [{ k: 'port', label: 'Listen port', ph: '5514' }],
  http_stream: [{ k: 'url', label: 'NDJSON stream URL', ph: 'http://host:9102/stream' }],
  websocket: [{ k: 'url', label: 'WebSocket URL', ph: 'ws://host:9104/ws' }],
  loki_pull: [{ k: 'url', label: 'Loki base URL', ph: 'http://host:3100' }, { k: 'query', label: 'LogQL selector', ph: '{job="web"}' }],
  rest_cursor: [{ k: 'url', label: 'REST URL', ph: 'http://host:9106/logs' }],
  push: [],
};

function SeverityBar({ by }: { by: Record<string, number> }) {
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  if (!total) return <span className="hint">no data</span>;
  return (
    <div style={{ display: 'flex', height: 8, width: 120, borderRadius: 4, overflow: 'hidden', background: 'var(--surface-hover)' }}
      title={Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' · ')}>
      {['info', 'notice', 'warn', 'risk'].map((k) => by[k]
        ? <i key={k} style={{ width: `${(by[k] / total) * 100}%`, background: SEV_COLOR[k] }} /> : null)}
    </div>
  );
}

function AddSource({ types, onDone }: { types: string[]; onDone: () => void }) {
  const [id, setId] = useState('');
  const [type, setType] = useState('tcp');
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setErr(null);
    try {
      await api.createSource({ id, type, config: cfg });
      setId(''); setCfg({}); onDone();
    } catch (e) { setErr(errMessage(e)); }
  };
  return (
    <Panel title="Connect a source" subtitle="Pull from an external system, or point a shipper at Aletheia">
      <div className="stack-sm">
        <div className="btn-row">
          <label className="field"><span className="lbl">Name</span>
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder="edge-firewall" /></label>
          <label className="field"><span className="lbl">Type</span>
            <select value={type} onChange={(e) => { setType(e.target.value); setCfg({}); }}>
              {types.map((t) => <option key={t}>{t}</option>)}</select></label>
          {(TYPE_FIELDS[type] ?? []).map((f) => (
            <label className="field" key={f.k}><span className="lbl">{f.label}</span>
              <input value={cfg[f.k] ?? ''} placeholder={f.ph} onChange={(e) => setCfg({ ...cfg, [f.k]: e.target.value })} /></label>
          ))}
          <button className="primary" disabled={!id} onClick={() => void submit()}>Connect</button>
        </div>
        {type === 'push' && (
          <p className="hint">Shippers push to <code>POST /api/v1/ingest/loki/push</code> (Loki JSON: Vector, Fluent Bit,
            Logstash) or <code>POST /api/v1/ingest/&lt;name&gt;</code> with one line per row. Unknown names register themselves as pending.</p>
        )}
        {err && <p className="hint err">{err}</p>}
      </div>
    </Panel>
  );
}

function ClusterCard({ c }: { c: SourceCluster }) {
  const g = c.gate;
  return (
    <div className="panel" style={{ marginBottom: 'var(--s4)' }}>
      <header>
        <div className="panel-title">
          {c.mapping.class_name} <span className="panel-sub">{c.size} lines · {(c.share * 100).toFixed(0)}% of sample · {c.format}</span>
        </div>
        <div className="panel-right row-tight">
          <Badge kind={g === null ? 'plain' : g.ok ? 'ok' : 'bad'}>
            {g === null ? 'gate not run' : g.ok ? 'reconstruction verified' : 'gate failed'}
          </Badge>
          <Confidence value={c.mapping.confidence} />
        </div>
      </header>
      <div className="panel-body flush">
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>Slot</th><th>Type</th><th>Sample value</th><th>OCSF field</th><th>Confidence</th></tr></thead>
            <tbody>
              {c.mapping.rows.map((r) => (
                <tr key={r.slot}>
                  <td className="mono">{r.slot}</td><td>{r.type}</td>
                  <td className="mono truncate" style={{ maxWidth: 220 }}>{r.sample}</td>
                  <td>{r.path ? <code>{r.path}</code> : <span className="hint">kept in unmapped</span>}</td>
                  <td>{r.path ? <Confidence value={r.confidence} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <pre className="mono hint" style={{ margin: 'var(--s3)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{c.samples[0]}</pre>
      </div>
    </div>
  );
}

function Review({ src, onChanged }: { src: SourceInfo; onChanged: () => void }) {
  const rev = useAsync(() => api.sourceReview(src.id), [src.id, src.state, src.attempts]);
  const raw = useAsync(() => api.sourceRaw(src.id), [src.id]);
  const [approver, setApprover] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [prop, setProp] = useState<SourceProposal | null>(null);
  const proposal = prop ?? rev.data?.proposal ?? null;

  const act = async (action: 'approve' | 'reject' | 'retry' | 'propose') => {
    setBusy(true); setMsg(null);
    try {
      if (action === 'propose') setProp(await api.sourcePropose(src.id));
      else {
        const r = await api.sourceDecide(src.id, { action, approver, reason: note, feedback: note });
        if (r.proposal) setProp(r.proposal);
        setMsg(action === 'approve' ? `Approved. ${r.packs?.length ?? 0} pack(s) published, ${r.backfilled ?? 0} lines backfilled${r.backfilled ? '' : ' (no bus configured)'}.`
          : action === 'reject' ? 'Rejected. Raw logs keep being stored; nothing is normalized.' : 'Retried with a new clustering.');
      }
      onChanged(); rev.reload();
    } catch (e) { setMsg(errMessage(e)); } finally { setBusy(false); }
  };
  const decidable = src.state === 'review' && !!proposal;

  return (
    <div className="stack">
      <Panel title={`Review: ${src.id}`} subtitle={`attempt ${src.attempts + 1} · ${proposal ? `${proposal.covered}/${proposal.lines_examined} lines clustered at sim ${proposal.sim_th}` : 'no proposal yet'}`}
        right={<button onClick={() => void act('propose')} disabled={busy || src.state === 'approved'}>
          {proposal ? 'Regenerate' : 'Generate proposal'}</button>}>
        {rev.loading && !proposal && <Spinner label="Loading proposal" />}
        {rev.error && <ErrorState error={rev.error} what="the proposal" />}
        {!proposal && !rev.loading && <p className="hint">Needs about 100 raw lines. Collected so far: {src.lines}.</p>}
        {proposal?.clusters.map((c) => <ClusterCard key={c.cluster_id} c={c} />)}
        {proposal && (
          <div className="stack-sm">
            <div className="btn-row">
              <label className="field"><span className="lbl">Approver (required)</span>
                <input value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="your name" /></label>
              <label className="field" style={{ flex: 1 }}><span className="lbl">Reason / feedback for retry</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. these are authentication events" /></label>
            </div>
            <div className="btn-row">
              <button className="primary" disabled={busy || !decidable || !approver} onClick={() => void act('approve')}>Approve</button>
              <button disabled={busy || !decidable || !approver} onClick={() => void act('retry')}>Retry</button>
              <button disabled={busy || !decidable || !approver} onClick={() => void act('reject')}>Reject</button>
            </div>
            {msg && <p className={`hint${/fail|error|required|nothing/i.test(msg) ? ' err' : ''}`}>{msg}</p>}
          </div>
        )}
      </Panel>
      <Panel title="Raw tail" subtitle="Stored verbatim, exactly as received" right={<button className="ghost" onClick={raw.reload}>Refresh</button>}>
        <div className="table-scroll"><table className="data"><tbody>
          {(raw.data?.lines ?? []).slice(0, 15).map((l) => (
            <tr key={l.ts_ns}><td style={{ width: 70 }}><span className="badge" style={{ color: SEV_COLOR[l.severity] }}>{l.severity}</span></td>
              <td className="mono" style={{ wordBreak: 'break-all' }}>{l.line}</td></tr>
          ))}
        </tbody></table></div>
      </Panel>
    </div>
  );
}

export function SourcesPage() {
  const list = useAsync(() => api.listSources(), []);
  const [sel, setSel] = useState<string | null>(null);
  const { reload } = list;
  useEffect(() => { const t = setInterval(reload, 3000); return () => clearInterval(t); }, [reload]);
  const toggle = useCallback(async (s: SourceInfo) => { await api.patchSource(s.id, { enabled: !s.enabled }); reload(); }, [reload]);
  const remove = useCallback(async (s: SourceInfo) => {
    if (!window.confirm(`Remove ${s.id}? Stored raw logs stay in the raw store.`)) return;
    await api.deleteSource(s.id); if (sel === s.id) setSel(null); reload();
  }, [reload, sel]);
  const current = list.data?.sources.find((s) => s.id === sel) ?? null;

  return (
    <div className="stack">
      <PageHead title="Sources" right={list.data && <Badge kind="info">raw store: {list.data.store}</Badge>}>
        Connect any log system. Lines are stored raw first; you approve the mapping before anything is normalized.
      </PageHead>
      {list.error && <ErrorState error={list.error} what="sources" />}
      <Panel title="Connected systems" flush>
        {list.loading && !list.data && <Spinner label="Loading" />}
        {list.data && list.data.sources.length === 0 && (
          <EmptyState title="No sources yet">Connect one below, or run <code>make gens</code> for six demo log servers.</EmptyState>
        )}
        {list.data && list.data.sources.length > 0 && (
          <div className="table-scroll"><table className="data">
            <thead><tr><th>Source</th><th>Type</th><th>Connection</th><th>Onboarding</th><th>Lines</th><th>/s</th><th>Severity mix</th><th /></tr></thead>
            <tbody>
              {list.data.sources.map((s) => (
                <tr key={s.id} className={sel === s.id ? 'on' : undefined}>
                  <td><button className="btn-link" onClick={() => setSel(s.id)}>{s.id}</button></td>
                  <td>{s.type}</td>
                  <td><Badge kind={s.status === 'connected' ? 'ok' : s.status === 'passive' ? 'plain' : 'warn'} title={s.error}>{s.enabled ? s.status : 'paused'}</Badge></td>
                  <td><Badge kind={STATE_KIND[s.state]}>{s.state === 'collecting' && s.has_proposal ? 'review' : s.state}</Badge></td>
                  <td className="mono">{s.lines.toLocaleString()}</td><td className="mono">{s.eps}</td>
                  <td><SeverityBar by={s.by_severity} /></td>
                  <td className="row-tight row-nowrap">
                    <button onClick={() => setSel(s.id)}>{s.state === 'review' ? 'Review' : 'Open'}</button>
                    <button className="ghost" onClick={() => void toggle(s)}>{s.enabled ? 'Pause' : 'Resume'}</button>
                    <button className="ghost" onClick={() => void remove(s)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Panel>
      {current && <Review key={current.id} src={current} onChanged={reload} />}
      <AddSource types={list.data?.types ?? Object.keys(TYPE_FIELDS)} onDone={reload} />
    </div>
  );
}
