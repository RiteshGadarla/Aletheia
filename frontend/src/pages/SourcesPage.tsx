// Sources: connect log systems in a dialog, watch raw lines land, approve, reject or retry the mapping.
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Confidence, EmptyState, ErrorState, PageHead, Panel, Spinner } from '../components/Bits';
import { Modal } from '../components/Modal';
import { api, errMessage } from '../lib/api';
import { useNotify } from '../lib/notify';
import { useAsync } from '../lib/useAsync';
import type { BadgeKind } from '../components/Bits';
import type { SourceCluster, SourceInfo, SourceProposal, SourceState } from '../lib/types';

const SEV_COLOR: Record<string, string> = {
  info: 'var(--sev-info)', notice: 'var(--sev-notice)', warn: 'var(--sev-warn)', risk: 'var(--sev-risk)',
};
const MIN_LINES = 100;
const TYPE_LABEL: Record<string, string> = {
  tcp: 'TCP stream', udp_listen: 'UDP listener', http_stream: 'HTTP stream', websocket: 'WebSocket',
  loki_pull: 'Loki pull', rest_cursor: 'REST API', push: 'Pushed to Aletheia',
};
const TYPE_FIELDS: Record<string, { k: string; label: string; ph: string }[]> = {
  tcp: [{ k: 'host', label: 'Host', ph: '127.0.0.1' }, { k: 'port', label: 'Port', ph: '9101' }],
  udp_listen: [{ k: 'port', label: 'Listen port', ph: '5514' }],
  http_stream: [{ k: 'url', label: 'NDJSON stream URL', ph: 'http://host:9102/stream' }],
  websocket: [{ k: 'url', label: 'WebSocket URL', ph: 'ws://host:9104/ws' }],
  loki_pull: [{ k: 'url', label: 'Loki base URL', ph: 'http://host:3100' }, { k: 'query', label: 'LogQL selector', ph: '{job="web"}' }],
  rest_cursor: [{ k: 'url', label: 'REST URL', ph: 'http://host:9106/logs' }],
  push: [],
};

export function SeverityBar({ by }: { by: Record<string, number> }) {
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

function StatusCell({ s }: { s: SourceInfo }) {
  const kind: Record<SourceState, BadgeKind> = { collecting: 'plain', review: 'warn', approved: 'ok', rejected: 'bad' };
  if (s.state === 'review') return <Badge kind="warn">Ready to approve</Badge>;
  if (s.state === 'collecting') {
    return (
      <div className="stack-sm" style={{ gap: 4 }}>
        <Badge kind="plain">Collecting</Badge>
        <div className="progress" title={`${s.lines} of ${MIN_LINES} lines needed`}><i style={{ width: `${Math.min(100, (s.lines / MIN_LINES) * 100)}%` }} /></div>
      </div>
    );
  }
  return <Badge kind={kind[s.state]}>{s.state === 'approved' ? 'Approved' : 'Rejected'}</Badge>;
}

// ------------------------------------------------------------------ add dialog
interface Prefill { id: string; type: string; cfg: Record<string, string> }

/** `?connect=1&id=..&type=..&host=..&port=..` (from the Demo page) pre-fills the dialog. */
function prefillFrom(p: URLSearchParams): Prefill | null {
  if (!p.get('connect')) return null;
  const cfg: Record<string, string> = {};
  p.forEach((v, k) => { if (!['connect', 'id', 'type'].includes(k)) cfg[k] = v; });
  return { id: p.get('id') ?? '', type: p.get('type') ?? 'tcp', cfg };
}

function AddDialog({ types, prefill, onClose, onDone }: {
  types: string[]; prefill: Prefill | null; onClose: () => void; onDone: (id: string) => void;
}) {
  const [id, setId] = useState(prefill?.id ?? '');
  const [type, setType] = useState(prefill?.type ?? 'tcp');
  const [cfg, setCfg] = useState<Record<string, string>>(prefill?.cfg ?? {});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await api.createSource({ id: id.trim(), type, config: cfg }); onDone(id.trim()); }
    catch (e) { setErr(errMessage(e)); setBusy(false); }
  };
  return (
    <Modal title="Connect a source" onClose={onClose}
      subtitle={prefill ? 'Filled in from the demo. Check it and press Connect.' : 'Pull from an external system, or point a shipper at Aletheia.'}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!id.trim() || busy} onClick={() => void submit()}>{busy ? 'Connecting…' : 'Connect'}</button>
      </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="field"><span className="lbl">Name</span>
          <input autoFocus value={id} onChange={(e) => setId(e.target.value)} placeholder="edge-firewall" />
          <span className="help">Letters, digits and - _ . : only. This is how the source appears everywhere.</span></label>
        <label className="field"><span className="lbl">How to connect</span>
          <select value={type} onChange={(e) => { setType(e.target.value); setCfg({}); }}>
            {types.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>)}</select></label>
        {(TYPE_FIELDS[type] ?? []).map((f) => (
          <label className="field" key={f.k}><span className="lbl">{f.label}</span>
            <input value={cfg[f.k] ?? ''} placeholder={f.ph} onChange={(e) => setCfg({ ...cfg, [f.k]: e.target.value })} /></label>
        ))}
        {type === 'push' && (
          <p className="hint">Point your shipper (Vector, Fluent Bit, Logstash) at <code>/api/v1/ingest/loki/push</code>, or send lines to
            <code> /api/v1/ingest/{id.trim() || '<name>'}</code>. The source is created when the first line arrives.</p>
        )}
        {err && <p className="hint err">{err}</p>}
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ source dialog
function ClusterCard({ c }: { c: SourceCluster }) {
  const g = c.gate;
  return (
    <div className="panel" style={{ marginBottom: 'var(--s4)' }}>
      <header>
        <div className="panel-title">
          {c.mapping.class_name} <span className="panel-sub">{c.size} lines · {(c.share * 100).toFixed(0)}% of sample</span>
        </div>
        <div className="panel-right row-tight">
          <Badge kind={g === null ? 'plain' : g.ok ? 'ok' : 'bad'}>{g === null ? 'check not run' : g.ok ? 'rebuilds byte-for-byte' : 'check failed'}</Badge>
          <Confidence value={c.mapping.confidence} />
        </div>
      </header>
      <div className="panel-body flush">
        <div className="table-scroll" style={{ maxHeight: 260 }}>
          <table className="data">
            <thead><tr><th>Field in log</th><th>Sample value</th><th>Maps to (OCSF)</th><th>Confidence</th></tr></thead>
            <tbody>
              {c.mapping.rows.map((r) => (
                <tr key={r.slot}>
                  <td className="mono">{r.slot} <span className="hint">{r.type}</span></td>
                  <td className="mono truncate" style={{ maxWidth: 240 }}>{r.sample}</td>
                  <td>{r.path ? <code>{r.path}</code> : <span className="hint">kept as extra data</span>}</td>
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

function ReviewTab({ src, onChanged, onClose }: { src: SourceInfo; onChanged: () => void; onClose: () => void }) {
  const { toast } = useNotify();
  const rev = useAsync(() => api.sourceReview(src.id), [src.id, src.state, src.attempts]);
  const [approver, setApprover] = useState(() => { try { return localStorage.getItem('aletheia.approver') ?? ''; } catch { return ''; } });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [prop, setProp] = useState<SourceProposal | null>(null);
  const [showAll, setShowAll] = useState(false);
  const proposal = prop ?? rev.data?.proposal ?? null;
  const decidable = src.state === 'review' && !!proposal;

  const act = async (action: 'approve' | 'reject' | 'retry' | 'propose') => {
    setBusy(true); setErr(null);
    try {
      if (action === 'propose') { setProp(await api.sourcePropose(src.id)); }
      else {
        try { localStorage.setItem('aletheia.approver', approver); } catch { /* ignore */ }
        const r = await api.sourceDecide(src.id, { action, approver, reason: note, feedback: note });
        if (r.proposal) setProp(r.proposal);
        if (action === 'approve') {
          if (r.bus === false) {
            toast({ kind: 'bad', sticky: true, title: `${src.id} approved, but no events yet`, body: 'The event pipeline is not connected, so Events and Lineage stay empty until it is. See the notice on Sources.' });
          } else {
            toast({ kind: 'ok', title: `${src.id} approved`, body: `${r.packs?.length ?? 0} parser pack(s) published${r.backfilled ? `, ${r.backfilled} stored lines sent for processing` : ''}. Events will appear in a few seconds.` });
          }
          onClose();
        } else if (action === 'reject') {
          toast({ kind: 'bad', title: `${src.id} rejected`, body: 'Raw logs keep being stored. Nothing is normalized.' });
          onClose();
        } else toast({ kind: 'info', title: 'New proposal generated', body: 'Re-clustered with your feedback.' });
      }
      onChanged(); rev.reload();
    } catch (e) { setErr(errMessage(e)); } finally { setBusy(false); }
  };

  if (src.state === 'approved' || src.state === 'rejected') {
    const last = [...src.history].reverse().find((h) => h.action === src.state);
    return <p className="hint">This source was <b>{src.state}</b>{last ? ` by ${last.actor}` : ''}. {src.state === 'rejected' ? 'Raw logs are still stored, but nothing is normalized.' : 'Its logs are normalized with the approved parser.'}</p>;
  }
  return (
    <div className="stack-sm">
      {rev.loading && !proposal && <Spinner label="Loading proposal" />}
      {rev.error && <ErrorState error={rev.error} what="the proposal" />}
      {!proposal && !rev.loading && (
        <div className="btn-row">
          <p className="hint" style={{ margin: 0 }}>{src.lines < MIN_LINES ? `Collecting logs: ${src.lines} of about ${MIN_LINES} needed.` : 'Enough logs collected.'}</p>
          <button className="primary" disabled={busy || src.lines === 0} onClick={() => void act('propose')}>Generate proposal</button>
        </div>
      )}
      {proposal && (
        <>
          <p className="hint" style={{ margin: 0 }}>
            Aletheia grouped {proposal.covered} of {proposal.lines_examined} sampled lines into {proposal.clusters.length} pattern(s)
            (attempt {src.attempts + 1}). Check the mapping, then decide.
          </p>
          <div className="panel"><div className="panel-body stack-sm">
            <div className="btn-row">
              <label className="field"><span className="lbl">Your name (required to approve)</span>
                <input value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="e.g. ritesh" /></label>
              <label className="field" style={{ flex: 1, minWidth: 220 }}><span className="lbl">Reason or feedback</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. these are authentication events" /></label>
            </div>
            <div className="btn-row">
              <button className="primary" disabled={busy || !decidable || !approver.trim()} onClick={() => void act('approve')}>Approve</button>
              <button disabled={busy || !decidable || !approver.trim()} onClick={() => void act('retry')} title="Regroup with different settings">Retry</button>
              <button disabled={busy || !decidable || !approver.trim()} onClick={() => void act('reject')}>Reject</button>
              <button className="ghost" disabled={busy} onClick={() => void act('propose')}>Regenerate</button>
            </div>
            {err && <p className="hint err">{err}</p>}
          </div></div>
          <h3 style={{ margin: 'var(--s2) 0 0', fontSize: 14 }}>Patterns found ({proposal.clusters.length})</h3>
          {(showAll ? proposal.clusters : proposal.clusters.slice(0, 3)).map((c) => <ClusterCard key={c.cluster_id} c={c} />)}
          {proposal.clusters.length > 3 && (
            <button className="ghost" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer patterns' : `Show ${proposal.clusters.length - 3} more patterns`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

const SEVS = ['info', 'notice', 'warn', 'risk'] as const;

function RawTab({ id }: { id: string }) {
  const [sev, setSev] = useState('');
  const [q, setQ] = useState('');
  const [text, setText] = useState('');
  const raw = useAsync(() => api.sourceRaw(id, text, sev), [id, text, sev]);
  const { reload } = raw;
  useEffect(() => { const t = setInterval(reload, 3000); return () => clearInterval(t); }, [reload]);
  return (
    <div className="stack-sm">
      <form className="btn-row" onSubmit={(e) => { e.preventDefault(); setText(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search text in raw lines" style={{ flex: 1, minWidth: 200 }} />
        <button type="submit">Search</button>
        <div className="row-tight">
          {['', ...SEVS].map((s) => (
            <button key={s || 'all'} type="button" className={sev === s ? 'primary' : 'ghost'} onClick={() => setSev(s)}>{s || 'all'}</button>
          ))}
        </div>
      </form>
      {raw.error && <ErrorState error={raw.error} what="raw lines" />}
      <div className="table-scroll" style={{ maxHeight: 420 }}>
        <table className="data"><tbody>
          {(raw.data?.lines ?? []).map((l) => (
            <tr key={l.ts_ns}>
              <td style={{ width: 72 }}><span className="badge" style={{ color: SEV_COLOR[l.severity] }}>{l.severity}</span></td>
              <td className="mono" style={{ wordBreak: 'break-all' }}>{l.line}</td>
            </tr>
          ))}
          {raw.data && raw.data.lines.length === 0 && <tr><td className="hint">No lines match.</td></tr>}
        </tbody></table>
      </div>
      <p className="hint">Stored exactly as received. Newest first, refreshing every few seconds.</p>
    </div>
  );
}

function DetailsTab({ s }: { s: SourceInfo }) {
  const when = (t: number) => new Date(t * 1000).toLocaleString();
  return (
    <div className="stack">
      <dl className="kv">
        <dt>Connection</dt><dd>{TYPE_LABEL[s.type] ?? s.type} · {s.enabled ? s.status : 'paused'}{s.error ? ` · ${s.error}` : ''}</dd>
        {Object.entries(s.config).map(([k, v]) => <><dt key={`k${k}`}>{k}</dt><dd key={`v${k}`} className="mono">{String(v)}</dd></>)}
        <dt>Lines stored</dt><dd>{s.lines.toLocaleString()} ({(s.bytes / 1024).toFixed(0)} KB) · {s.eps}/s</dd>
        <dt>Severity mix</dt><dd><SeverityBar by={s.by_severity} /></dd>
        <dt>Errors</dt><dd>{s.errors}</dd>
        <dt>Created</dt><dd>{when(s.created_at)}</dd>
      </dl>
      <div>
        <h3 style={{ margin: '0 0 var(--s2)', fontSize: 14 }}>History</h3>
        {s.history.length === 0 ? <p className="hint">Nothing yet.</p> : (
          <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {[...s.history].reverse().map((h) => (
              <li key={h.at} className="row-tight">
                <Badge kind={h.action === 'approved' ? 'ok' : h.action === 'rejected' ? 'bad' : 'plain'}>{h.action}</Badge>
                <span>{h.actor}</span><span className="hint">{when(h.at)}{h.reason ? ` · ${h.reason}` : ''}{h.feedback ? ` · ${h.feedback}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SourceDialog({ src, onClose, onChanged }: { src: SourceInfo; onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<'review' | 'raw' | 'details'>(src.state === 'review' || src.state === 'collecting' ? 'review' : 'raw');
  return (
    <Modal wide onClose={onClose} title={src.name || src.id}
      subtitle={<span className="row-tight"><Badge kind={src.status === 'connected' ? 'ok' : 'plain'}>{src.enabled ? src.status : 'paused'}</Badge>
        {TYPE_LABEL[src.type] ?? src.type} · {src.lines.toLocaleString()} lines · {src.eps}/s</span>}>
      <div className="tabs" role="tablist">
        {([['review', src.state === 'review' ? 'Review mapping' : 'Mapping'], ['raw', 'Raw logs'], ['details', 'Details']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'review' && <ReviewTab src={src} onChanged={onChanged} onClose={onClose} />}
      {tab === 'raw' && <RawTab id={src.id} />}
      {tab === 'details' && <DetailsTab s={src} />}
    </Modal>
  );
}

// ------------------------------------------------------------------ page
export function SourcesPage() {
  const list = useAsync(() => api.listSources(), []);
  const [params, setParams] = useSearchParams();
  const { toast } = useNotify();
  const [adding, setAdding] = useState<Prefill | 'blank' | null>(() => prefillFrom(params));
  const [sel, setSel] = useState<string | null>(params.get('review'));
  const [removing, setRemoving] = useState<SourceInfo | null>(null);
  const { reload } = list;
  useEffect(() => { const t = setInterval(reload, 3000); return () => clearInterval(t); }, [reload]);

  // A toast's Review button lands here with ?review=<id>; the Demo page's Connect with ?connect=1.
  useEffect(() => {
    const r = params.get('review');
    if (r) setSel(r);
    const p = prefillFrom(params);
    if (p) setAdding(p);
  }, [params]);

  const closeAll = useCallback(() => { setSel(null); setAdding(null); setParams({}); }, [setParams]);
  const sources = list.data?.sources ?? [];
  const current = sources.find((s) => s.id === sel) ?? null;
  const ready = sources.filter((s) => s.state === 'review');
  const readyIds = new Set(ready.map((s) => s.id));

  const toggle = async (s: SourceInfo) => { await api.patchSource(s.id, { enabled: !s.enabled }); reload(); };
  const remove = async () => {
    if (!removing) return;
    await api.deleteSource(removing.id);
    toast({ title: `${removing.id} removed`, body: 'Stored raw logs stay in the raw store.' });
    setRemoving(null); reload();
  };

  return (
    <div className="stack">
      <PageHead title="Sources">
        Connect any log system. Lines are stored raw first; you approve the mapping before anything is normalized.
      </PageHead>
      {list.error && <ErrorState error={list.error} what="sources" />}

      {list.data && (!list.data.bus || !list.data.worker) && (
        <div className="ready-banner" role="alert" style={{ borderColor: 'var(--bad-border)', background: 'var(--bad-soft)' }}>
          <div className="grow stack-sm" style={{ gap: 4 }}>
            <div className="row-tight" style={{ gap: 8 }}>
              <b>The event pipeline is offline.</b>
              <Badge kind={list.data.bus ? 'ok' : 'bad'}>Bus: {list.data.bus ? 'connected' : 'offline'}</Badge>
              <Badge kind={list.data.worker ? 'ok' : 'bad'}>Worker: {list.data.worker ? 'online' : 'offline'}</Badge>
            </div>
            <div>
              {!list.data.bus
                ? 'Studio is not connected to the message bus, so approved logs are not sent for processing.'
                : 'The engine worker is not running on port 9108, so approved logs are not turned into events.'}{' '}
              Approving still saves the parser, but Events and Lineage stay empty until the pipeline is running.
              <div className="hint" style={{ marginTop: 4 }}>
                Run <code>make worker</code> or <code>make run</code> in your terminal to start the engine worker.
              </div>
            </div>
          </div>
          <button className="btn-sm" onClick={() => void reload()}>Re-check status</button>
        </div>
      )}

      <button type="button" className="add-hero" onClick={() => setAdding('blank')}>
        <span className="plus" aria-hidden="true">+</span>
        <span className="grow">
          <span className="ah-title">Add a log source</span>
          <span className="ah-sub">Pull from a server, stream, API or Loki, or point a shipper at Aletheia</span>
        </span>
        <span className="ah-cta">Add source</span>
      </button>

      {ready.length > 0 && (
        <div className="ready-banner" role="status">
          <b>{ready.length === 1 ? '1 source is' : `${ready.length} sources are`} ready for your approval</b>
          <span className="row-tight">{ready.map((s) => <button key={s.id} className="primary" onClick={() => setSel(s.id)}>Review {s.id}</button>)}</span>
        </div>
      )}

      <Panel title="Connected systems" flush>
        {list.loading && !list.data && <div className="panel-pad"><Spinner label="Loading" /></div>}
        {list.data && sources.length === 0 && (
          <EmptyState title="No sources yet">
            Use the button above, or start a sample log server on the Demo page and press Connect.
          </EmptyState>
        )}
        {sources.length > 0 && (
          <div className="table-scroll"><table className="data">
            <thead><tr><th>Source</th><th>Connection</th><th>Status</th><th>Lines</th><th>/s</th><th>Severity mix</th><th /></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className={`src-row${readyIds.has(s.id) ? ' ready' : ''}`} onClick={() => setSel(s.id)}>
                  <td><b>{s.name || s.id}</b><div className="hint">{TYPE_LABEL[s.type] ?? s.type}</div></td>
                  <td><Badge kind={!s.enabled ? 'plain' : s.status === 'connected' ? 'ok' : s.status === 'passive' ? 'plain' : 'warn'} title={s.error}>{s.enabled ? s.status : 'paused'}</Badge></td>
                  <td><StatusCell s={s} /></td>
                  <td className="mono">{s.lines.toLocaleString()}</td><td className="mono">{s.eps}</td>
                  <td><SeverityBar by={s.by_severity} /></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="row-tight row-nowrap">
                      <button className={readyIds.has(s.id) ? 'primary' : ''} onClick={() => setSel(s.id)}>{readyIds.has(s.id) ? 'Review' : 'View'}</button>
                      <button className="ghost" onClick={() => void toggle(s)}>{s.enabled ? 'Pause' : 'Resume'}</button>
                      <button className="ghost" onClick={() => setRemoving(s)}>Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Panel>

      {adding && (
        <AddDialog types={list.data?.types ?? Object.keys(TYPE_FIELDS)} prefill={adding === 'blank' ? null : adding}
          onClose={closeAll}
          onDone={(id) => { toast({ kind: 'ok', title: `${id} connected`, body: 'Collecting raw logs. You will be told when it is ready to approve.' }); closeAll(); reload(); }} />
      )}
      {current && <SourceDialog key={current.id} src={current} onClose={closeAll} onChanged={reload} />}
      {removing && (
        <Modal title={`Remove ${removing.id}?`} onClose={() => setRemoving(null)}
          footer={<><button onClick={() => setRemoving(null)}>Cancel</button><button className="primary" onClick={() => void remove()}>Remove</button></>}>
          <p>This stops collecting from the source. Lines already stored stay in the raw store.</p>
        </Modal>
      )}
    </div>
  );
}
