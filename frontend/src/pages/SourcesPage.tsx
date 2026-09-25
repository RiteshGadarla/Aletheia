// Sources: connect log systems in a dialog, watch raw lines land, approve, reject or retry the mapping.
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Confidence, EmptyState, ErrorState, PageHead, Panel, Spinner } from '../components/Bits';
import {
  IconCaret, IconCloud, IconExternal, IconLink, IconPlus, IconSearch, IconSend, IconServer, IconSources,
} from '../components/Icons';
import { Kpi, bytesFmt } from '../components/Insights';
import { Modal } from '../components/Modal';
import { api, errMessage } from '../lib/api';
import { reloadWithToast, useNotify } from '../lib/notify';
import { useAsync, usePoll } from '../lib/useAsync';
import '../styles/sources.css';
import type { BadgeKind } from '../components/Bits';
import type { MappingRow, SourceCluster, SourceInfo, SourceProposal, SourceState } from '../lib/types';

const SEV_COLOR: Record<string, string> = {
  info: 'var(--sev-info)', notice: 'var(--sev-notice)', warn: 'var(--sev-warn)', risk: 'var(--sev-risk)',
};
const MIN_LINES = 100;
const TYPE_LABEL: Record<string, string> = {
  tcp: 'TCP stream', udp_listen: 'UDP listener', http_stream: 'HTTP stream', websocket: 'WebSocket',
  loki_pull: 'Loki pull', rest_cursor: 'REST API', push: 'Pushed to Aletheia',
};
const TYPE_HELP: Record<string, string> = {
  tcp: 'Read lines from a TCP socket', udp_listen: 'Receive syslog-style datagrams',
  http_stream: 'Follow an NDJSON HTTP stream', websocket: 'Subscribe to a WebSocket feed',
  loki_pull: 'Query an existing Loki', rest_cursor: 'Poll a paginated REST endpoint',
  push: 'Your shipper sends lines here',
};
const TYPE_ICON: Record<string, typeof IconServer> = {
  tcp: IconServer, udp_listen: IconServer, http_stream: IconLink, websocket: IconLink,
  loki_pull: IconCloud, rest_cursor: IconExternal, push: IconSend,
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

export function SeverityBar({ by, fill }: { by: Record<string, number>; fill?: boolean }) {
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  if (!total) return <span className="hint">no data</span>;
  return (
    <div style={{ display: 'flex', height: 8, width: fill ? '100%' : 120, borderRadius: 4, overflow: 'hidden', background: 'var(--surface-hover)' }}
      title={Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' · ')}>
      {['info', 'notice', 'warn', 'risk'].map((k) => by[k]
        ? <i key={k} style={{ width: `${(by[k] / total) * 100}%`, background: SEV_COLOR[k] }} /> : null)}
    </div>
  );
}

function StatusCell({ s }: { s: SourceInfo }) {
  const kind: Record<SourceState, BadgeKind> = { collecting: 'plain', review: 'info', approved: 'ok', rejected: 'bad' };
  if (s.state === 'review') return <Badge kind="info">Ready to approve</Badge>;
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

function TypeOption({ t }: { t: string }) {
  const Icon = TYPE_ICON[t] ?? IconSources;
  return (
    <>
      <span className="tt-icon"><Icon size={16} /></span>
      <span className="grow"><span className="tt-label">{TYPE_LABEL[t] ?? t}</span>
        {TYPE_HELP[t] && <span className="tt-help">{TYPE_HELP[t]}</span>}</span>
    </>
  );
}

/** Dropdown for the connection type. The list floats over the form and scrolls; the dialog keeps one size. */
function TypePicker({ types, value, onChange }: { types: string[]; value: string; onChange: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLButtonElement>('[aria-selected="true"] button')?.focus();
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const move = (e: ReactKeyboardEvent) => {
    // Escape closes the list, not the whole dialog; arrows walk the options.
    if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); return; }
    if (!open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const opts = [...(box.current?.querySelectorAll<HTMLButtonElement>('.type-dd-menu button') ?? [])];
    const at = opts.indexOf(document.activeElement as HTMLButtonElement);
    opts[(at + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length]?.focus();
  };
  return (
    <div className={`type-dd${open ? ' open' : ''}`} ref={box} onKeyDown={move}>
      <button type="button" className="type-dd-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <TypeOption t={value} />
        <IconCaret size={14} className="type-dd-caret" />
      </button>
      {open && (
        <ul className="type-dd-menu" role="listbox" aria-label="How to connect">
          {types.map((t) => (
            <li key={t} role="option" aria-selected={t === value}>
              <button type="button" className={t === value ? 'on' : ''} onClick={() => { onChange(t); setOpen(false); }}>
                <TypeOption t={t} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
    <Modal title="Connect a source" onClose={onClose} className="src-connect"
      subtitle={prefill ? 'Filled in from the demo. Check it and press Connect.' : 'Pull from an external system, or point a shipper at Aletheia.'}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!id.trim() || busy} onClick={() => void submit()}>{busy ? 'Connecting…' : 'Connect'}</button>
      </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="field"><span className="lbl">Name</span>
          <input autoFocus value={id} onChange={(e) => setId(e.target.value)} placeholder="edge-firewall" />
          <span className="help">Letters, digits and - _ . : only. This is how the source appears everywhere.</span></label>
        <div className="field"><span className="lbl">How to connect</span>
          <TypePicker types={types} value={type} onChange={(t) => { if (t !== type) { setType(t); setCfg({}); } }} /></div>
        {(TYPE_FIELDS[type] ?? []).length > 0 && (
          <div className="cfg-grid">
            {(TYPE_FIELDS[type] ?? []).map((f) => (
              <label className="field" key={f.k}><span className="lbl">{f.label}</span>
                <input value={cfg[f.k] ?? ''} placeholder={f.ph} onChange={(e) => setCfg({ ...cfg, [f.k]: e.target.value })} /></label>
            ))}
          </div>
        )}
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
const HUES = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16'];

/** Splits a raw line into plain text and highlighted field values, in order of appearance. */
function segment(line: string, rows: MappingRow[]) {
  const hits: { at: number; end: number; i: number }[] = [];
  const taken = new Array<boolean>(line.length).fill(false);
  rows.forEach((r, i) => {
    if (!r.sample) return;
    let at = line.indexOf(r.sample);
    while (at >= 0 && taken.slice(at, at + r.sample.length).some(Boolean)) at = line.indexOf(r.sample, at + 1);
    if (at < 0) return;
    for (let k = at; k < at + r.sample.length; k++) taken[k] = true;
    hits.push({ at, end: at + r.sample.length, i });
  });
  hits.sort((x, y) => x.at - y.at);
  const out: { text: string; i: number | null }[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.at > pos) out.push({ text: line.slice(pos, h.at), i: null });
    out.push({ text: line.slice(h.at, h.end), i: h.i }); pos = h.end;
  }
  if (pos < line.length) out.push({ text: line.slice(pos), i: null });
  return out;
}

/** Builds the nested OCSF event that this pattern would produce from the sample line. */
function buildEvent(c: SourceCluster) {
  const ev: Record<string, unknown> = { class_name: c.mapping.class_name, class_uid: c.mapping.class_uid, activity_id: c.mapping.activity_id };
  const extra: Record<string, string> = {};
  for (const r of c.mapping.rows) {
    if (!r.path) { extra[r.slot] = r.sample; continue; }
    const keys = r.path.split('.');
    let cur = ev;
    keys.slice(0, -1).forEach((k) => { if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}; cur = cur[k] as Record<string, unknown>; });
    cur[keys[keys.length - 1]] = r.sample;
  }
  if (Object.keys(extra).length) ev.unmapped = extra;
  return JSON.stringify(ev, null, 2);
}

function PatternWalk({ clusters }: { clusters: SourceCluster[] }) {
  const [n, setN] = useState(0);
  const [hot, setHot] = useState<number | null>(null);
  const [sampleIx, setSampleIx] = useState(0);
  const c = clusters[n];
  const go = (d: number) => { setN((n + d + clusters.length) % clusters.length); setHot(null); setSampleIx(0); };
  const jump = (v: string) => {
    const k = Math.min(clusters.length, Math.max(1, parseInt(v, 10) || n + 1)) - 1;
    if (k !== n) { setN(k); setHot(null); setSampleIx(0); }
  };
  const g = c.gate;
  const line = c.samples[sampleIx] ?? c.samples[0] ?? '';
  // Sample values only line up with the first sample line.
  const parts = segment(c.samples[0] ?? '', c.mapping.rows);
  const showParts = sampleIx === 0;
  return (
    <div className="panel">
      <header>
        <div className="panel-title">
          Pattern {n + 1} of {clusters.length}: {c.mapping.class_name}
          <span className="panel-sub">{c.size} lines · {(c.share * 100).toFixed(0)}% of sample</span>
        </div>
        <div className="panel-right row-tight">
          <Badge kind={g === null ? 'plain' : g.ok ? 'ok' : 'bad'}>{g === null ? 'check not run' : g.ok ? 'rebuilds byte-for-byte' : 'check failed'}</Badge>
          {c.mapping.origin.startsWith('ai:')
            ? <Badge kind="info" title="Mapped by the LLM from this format's samples; rules filled any gaps">AI · {c.mapping.origin.slice(3)}</Badge>
            : <Badge kind="plain" title={c.mapping.ai_note ?? undefined}>Rules{c.mapping.ai_note ? ' (AI not used)' : ''}</Badge>}
          <Confidence value={c.mapping.confidence} />
        </div>
      </header>
      {c.mapping.ai_note && (
        <p className="hint panel-pad">Mapped by rules: {c.mapping.ai_note}. Retry after fixing the AI settings to get an LLM mapping.</p>
      )}
      <div className="panel-body wk-body">
        <div className="wk-nav">
          <button onClick={() => go(-1)} disabled={clusters.length < 2}>← Previous</button>
          <label className="row-tight hint" style={{ gap: 6 }}>Go to pattern
            <input type="number" min={1} max={clusters.length} key={n} defaultValue={n + 1} style={{ width: 64 }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); jump((e.target as HTMLInputElement).value); } }}
              onBlur={(e) => jump(e.target.value)} />
            of {clusters.length}
          </label>
          <button onClick={() => go(1)} disabled={clusters.length < 2}>Next →</button>
        </div>

        <section className="wk-card">
          <h4 className="wk-h"><span className="wk-step">1</span> The raw line Aletheia stored</h4>
          <pre className="wk-line">
            {showParts ? parts.map((p, i) => p.i === null ? <span key={i}>{p.text}</span> : (
              <mark key={i} className={hot === p.i ? 'hot' : ''} style={{ ['--h' as string]: HUES[p.i % HUES.length] }}
                onMouseEnter={() => setHot(p.i)} onMouseLeave={() => setHot(null)}>{p.text}</mark>
            )) : line}
          </pre>
          {c.samples.length > 1 && (
            <div className="row-tight" style={{ marginTop: 6 }}>
              <span className="hint">Example line:</span>
              {c.samples.slice(0, 5).map((_, i) => (
                <button key={i} className={i === sampleIx ? 'primary btn-sm' : 'ghost btn-sm'} onClick={() => setSampleIx(i)}>{i + 1}</button>
              ))}
              {!showParts && <span className="hint">Highlights are shown on example 1.</span>}
            </div>
          )}
        </section>

        <section className="wk-card">
          <h4 className="wk-h"><span className="wk-step">2</span> How each part is picked out and where it goes</h4>
          <div className="table-scroll" style={{ maxHeight: 340 }}>
            <table className="data">
              <thead><tr><th>Field</th><th>Value taken</th><th>Goes to (OCSF)</th><th>Rule</th><th>Confidence</th></tr></thead>
              <tbody>
                {c.mapping.rows.map((r, i) => (
                  <tr key={r.slot} className={hot === i ? 'wk-hot' : ''} onMouseEnter={() => setHot(i)} onMouseLeave={() => setHot(null)}>
                    <td className="mono"><i className="wk-dot" style={{ background: HUES[i % HUES.length] }} />{r.slot} <span className="hint">{r.type}</span></td>
                    <td className="mono truncate" style={{ maxWidth: 220 }}>{r.sample}</td>
                    <td>{r.path ? <code>{r.path}</code> : <span className="hint">kept as extra data</span>}</td>
                    <td className="hint">{r.transform ?? (r.path ? 'copied as is' : '—')}{r.evidence?.length ? ` · ${r.evidence[0]}` : ''}</td>
                    <td>{r.path ? <Confidence value={r.confidence} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="wk-card">
          <h4 className="wk-h"><span className="wk-step">3</span> The normalized event you get</h4>
          <pre className="wk-json">{buildEvent(c)}</pre>
        </section>
        {(c.warnings.length > 0 || (g && !g.ok)) && (
          <p className="hint err">{[...c.warnings, g && !g.ok ? g.error ?? 'Rebuild check failed.' : ''].filter(Boolean).join(' · ')}</p>
        )}
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
  const [ask, setAsk] = useState<'approve' | 'retry' | 'reject' | null>(null);
  const proposal = prop ?? rev.data?.proposal ?? null;
  const decidable = !!proposal && src.state !== 'approved' && src.state !== 'rejected';

  const act = async (action: 'approve' | 'reject' | 'retry' | 'propose') => {
    setBusy(true); setErr(null);
    try {
      if (action === 'propose') { setProp(await api.sourcePropose(src.id)); }
      else {
        // Remembered in this browser only, so the next approval autofills it.
        const name = approver.trim();
        try { localStorage.setItem('aletheia.approver', name); } catch { /* ignore */ }
        const r = await api.sourceDecide(src.id, { action, approver: name, reason: note.trim(), feedback: note.trim() });
        if (r.proposal) setProp(r.proposal);
        if (action === 'approve') {
          // Integration changes every page's data; a clean reload beats patching stale state.
          reloadWithToast(r.bus === false
            ? { kind: 'bad', sticky: true, title: `${src.id} approved, but no events yet`, body: 'The event pipeline is not connected, so Events and Lineage stay empty until it is. See the notice on Sources.' }
            : { kind: 'ok', title: `${src.id} approved`, body: `${r.packs?.length ?? 0} parser pack(s) published${r.backfilled ? `, ${r.backfilled} stored lines sent for processing` : ''}. Events will appear in a few seconds.` },
          '/dashboard/sources');
          return;
        } else if (action === 'reject') {
          toast({ kind: 'bad', title: `${src.id} rejected`, body: 'Raw logs keep being stored. Nothing is normalized.' });
          onClose();
        } else toast({ kind: 'info', title: 'New proposal generated', body: 'Re-clustered with your feedback.' });
      }
      setAsk(null); onChanged(); rev.reload();
    } catch (e) { setErr(errMessage(e)); } finally { setBusy(false); }
  };

  if (src.state === 'approved' || src.state === 'rejected') {
    return (
      <div className="stack-sm">
        {rev.loading && !proposal && <Spinner label="Loading mapping" />}
        {proposal ? <PatternWalk key={proposal.attempt} clusters={proposal.clusters} />
          : !rev.loading && <p className="hint">The mapping is no longer in memory (the server was restarted since approval). The approved parser is still active.</p>}
      </div>
    );
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
          <div className="btn-row">
            <button className="primary" disabled={busy || !decidable} onClick={() => setAsk('approve')}>Approve</button>
            <button disabled={busy || !decidable} onClick={() => setAsk('retry')} title="Regroup with different settings">Retry</button>
            <button disabled={busy || !decidable} onClick={() => setAsk('reject')}>Reject</button>
            <button className="ghost" disabled={busy} onClick={() => void act('propose')}>Regenerate</button>
          </div>
          {err && !ask && <p className="hint err">{err}</p>}
          <PatternWalk key={proposal.attempt} clusters={proposal.clusters} />
        </>
      )}
      {ask && (
        <Modal title={{ approve: 'Approve this mapping', retry: 'Retry with feedback', reject: 'Reject this source' }[ask]}
          subtitle="Your name is recorded in the audit history." onClose={() => { setAsk(null); setErr(null); }}
          footer={<>
            <button onClick={() => { setAsk(null); setErr(null); }}>Cancel</button>
            <button className="primary" disabled={busy || !approver.trim()} onClick={() => void act(ask)}>
              {busy ? 'Working…' : { approve: 'Approve', retry: 'Retry', reject: 'Reject' }[ask]}</button>
          </>}>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (approver.trim() && !busy) void act(ask); }}>
            <label className="field"><span className="lbl">Your name (required)</span>
              <input autoFocus required name="approver" autoComplete="name" value={approver}
                onChange={(e) => setApprover(e.target.value)} placeholder="Ashok Kumar" /></label>
            <label className="field"><span className="lbl">{ask === 'retry' ? 'Feedback for the next attempt' : 'Comment (optional)'}</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. these are authentication events" /></label>
            {err && <p className="hint err">{err}</p>}
          </form>
        </Modal>
      )}
    </div>
  );
}

const SEVS = ['info', 'notice', 'warn', 'risk'] as const;

function RawTab({ id }: { id: string }) {
  const [sev, setSev] = useState('');
  const [q, setQ] = useState('');
  const [text, setText] = useState('');
  const raw = usePoll(() => api.sourceRaw(id, text, sev), 3000, [id, text, sev]);
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
  const stat = (label: string, value: string, sub?: string) => (
    <div className="dt-stat"><span className="dt-k">{label}</span><b>{value}</b>{sub && <span className="hint">{sub}</span>}</div>
  );
  return (
    <div className="dt-wrap">
      <div className="dt-stats">
        {stat('Lines stored', s.lines.toLocaleString(), `${(s.bytes / 1024).toFixed(0)} KB`)}
        {stat('Rate', `${s.eps}/s`, 'lines per second')}
        {stat('Errors', String(s.errors), s.errors ? 'check the connection' : 'none')}
        {stat('Created', new Date(s.created_at * 1000).toLocaleDateString(), new Date(s.created_at * 1000).toLocaleTimeString())}
      </div>
      <div className="dt-cols">
        <section className="wk-card">
          <h4 className="wk-h">Connection</h4>
          <dl className="kv">
            <dt>Type</dt><dd>{TYPE_LABEL[s.type] ?? s.type}</dd>
            <dt>Status</dt><dd>{s.enabled ? s.status : 'paused'}{s.error ? ` · ${s.error}` : ''}</dd>
            {Object.entries(s.config).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="mono">{String(v)}</dd></Fragment>)}
          </dl>
          <h4 className="wk-h" style={{ marginTop: 'var(--s4)' }}>Severity mix</h4>
          <SeverityBar by={s.by_severity} />
          <div className="row-tight" style={{ marginTop: 8, gap: 12, flexWrap: 'wrap' }}>
            {SEVS.map((k) => <span key={k} className="hint"><i className="wk-dot" style={{ background: SEV_COLOR[k] }} />{k} {(s.by_severity[k] ?? 0).toLocaleString()}</span>)}
          </div>
        </section>
        <section className="wk-card">
          <h4 className="wk-h">History</h4>
          {s.history.length === 0 ? <p className="hint">Nothing yet.</p> : (
            <ul className="dt-hist">
              {[...s.history].reverse().map((h) => (
                <li key={h.at}>
                  <Badge kind={h.action === 'approved' ? 'ok' : h.action === 'rejected' ? 'bad' : 'plain'}>{h.action}</Badge>
                  <div><b>{h.actor}</b> <span className="hint">{when(h.at)}</span>
                    {(h.reason || h.feedback) && <div className="hint">{[h.reason, h.feedback].filter(Boolean).join(' · ')}</div>}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function SourceDialog({ src, onClose, onChanged }: { src: SourceInfo; onClose: () => void; onChanged: () => void }) {
  const decided = [...src.history].reverse().find((h) => h.action === src.state);
  const [tab, setTab] = useState<'review' | 'raw' | 'details'>(src.state === 'review' || src.state === 'collecting' ? 'review' : 'raw');
  return (
    <Modal wide onClose={onClose} title={src.name || src.id}
      subtitle={<>
        <Badge kind={src.status === 'connected' ? 'ok' : 'plain'}>{src.enabled ? src.status : 'paused'}</Badge>
        <span>{TYPE_LABEL[src.type] ?? src.type} · {src.lines.toLocaleString()} lines · {src.eps}/s</span>
        {(src.state === 'approved' || src.state === 'rejected') && (
          <span>· <b>{src.state === 'approved' ? 'Approved' : 'Rejected'}</b>{decided ? ` by ${decided.actor}` : ''}
            {src.state === 'approved' ? ', logs normalized with this mapping' : ', raw logs kept but not normalized'}</span>
        )}
      </>}>
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
type View = 'grid' | 'list';
type Filter = 'all' | SourceState;
const FILTERS: [Filter, string][] = [
  ['all', 'All'], ['review', 'Ready'], ['collecting', 'Collecting'], ['approved', 'Approved'], ['rejected', 'Rejected'],
];
const VIEW_KEY = 'aletheia.sources.view';
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function ago(t: number | null) {
  if (!t) return 'No lines yet';
  const d = Math.max(0, Date.now() / 1000 - t);
  if (d < 60) return `Last line ${Math.round(d)}s ago`;
  if (d < 3600) return `Last line ${Math.round(d / 60)}m ago`;
  if (d < 86400) return `Last line ${Math.round(d / 3600)}h ago`;
  return `Last line ${Math.round(d / 86400)}d ago`;
}

/** Transport health, separate from the approval state: a paused or erroring source still keeps its mapping. */
function ConnStatus({ s }: { s: SourceInfo }) {
  const tone = !s.enabled || s.status === 'passive' ? 'idle' : s.status === 'connected' ? 'ok' : 'warn';
  return <span className={`conn ${tone}`} title={s.error || undefined}><i />{s.enabled ? s.status : 'paused'}</span>;
}

function StateBadge({ s }: { s: SourceInfo }) {
  if (s.state === 'review') return <Badge kind="info">Ready to approve</Badge>;
  if (s.state === 'collecting') return <Badge kind="plain">Collecting</Badge>;
  return <Badge kind={s.state === 'approved' ? 'ok' : 'bad'}>{s.state === 'approved' ? 'Approved' : 'Rejected'}</Badge>;
}

function SourceCard({ s, onOpen, onToggle, onRemove }: {
  s: SourceInfo; onOpen: () => void; onToggle: () => void; onRemove: () => void;
}) {
  const Icon = TYPE_ICON[s.type] ?? IconSources;
  const ready = s.state === 'review';
  return (
    <article className={`src-card${ready ? ' ready' : ''}${s.enabled ? '' : ' paused'}`} onClick={onOpen}>
      <header className="sn-head">
        <span className="sn-icon"><Icon size={18} /></span>
        <div className="grow">
          <div className="sn-name truncate" title={s.id}>{s.name || s.id}</div>
          <div className="sn-meta">{TYPE_LABEL[s.type] ?? s.type}<span aria-hidden="true">·</span><ConnStatus s={s} /></div>
        </div>
        <StateBadge s={s} />
      </header>

      <dl className="sn-metrics">
        <div><dt>Lines</dt><dd title={s.lines.toLocaleString()}>{compact.format(s.lines)}</dd></div>
        <div><dt>Rate</dt><dd>{s.eps}<small>/s</small></dd></div>
        <div><dt>Errors</dt><dd className={s.errors ? 'bad' : ''}>{s.errors}</dd></div>
      </dl>

      {s.state === 'collecting' ? (
        <div className="sn-block">
          <div className="sn-block-h"><span>Collecting a sample</span><span className="mono">{Math.min(s.lines, MIN_LINES)} / {MIN_LINES}</span></div>
          <div className="progress"><i style={{ width: `${Math.min(100, (s.lines / MIN_LINES) * 100)}%` }} /></div>
        </div>
      ) : (
        <div className="sn-block">
          <div className="sn-block-h"><span>Severity mix</span></div>
          <SeverityBar by={s.by_severity} fill />
          <div className="sn-legend">
            {SEVS.map((k) => (
              <span key={k}><i style={{ background: SEV_COLOR[k] }} />{k}<b>{compact.format(s.by_severity[k] ?? 0)}</b></span>
            ))}
          </div>
        </div>
      )}

      <footer className="sn-foot" onClick={(e) => e.stopPropagation()}>
        <span className="hint">{ago(s.last_seen)}</span>
        <div className="row-tight row-nowrap">
          <button className="ghost btn-sm" onClick={onToggle}>{s.enabled ? 'Pause' : 'Resume'}</button>
          <button className="ghost btn-sm" onClick={onRemove}>Remove</button>
          <button className={`btn-sm${ready ? ' primary' : ''}`} onClick={onOpen}>{ready ? 'Review mapping' : 'Open'}</button>
        </div>
      </footer>
    </article>
  );
}

const isReady = (s: SourceInfo) => s.state === 'review';

function SourceTable({ rows, onOpen, onToggle, onRemove }: {
  rows: SourceInfo[]; onOpen: (s: SourceInfo) => void; onToggle: (s: SourceInfo) => void; onRemove: (s: SourceInfo) => void;
}) {
  return (
    <div className="table-scroll"><table className="data">
      <thead><tr><th>Source</th><th>Connection</th><th>Status</th><th className="num">Lines</th><th className="num">Rate</th><th>Severity mix</th><th /></tr></thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.id} className={`src-row${isReady(s) ? ' ready' : ''}`} onClick={() => onOpen(s)}>
            <td><b>{s.name || s.id}</b><div className="hint">{TYPE_LABEL[s.type] ?? s.type}</div></td>
            <td><ConnStatus s={s} /></td>
            <td><StatusCell s={s} /></td>
            <td className="num mono" title={s.lines.toLocaleString()}>{compact.format(s.lines)}</td>
            <td className="num mono">{s.eps}/s</td>
            <td><SeverityBar by={s.by_severity} /></td>
            <td onClick={(e) => e.stopPropagation()}>
              <div className="row-tight row-nowrap src-actions">
                <button className="ghost btn-sm" onClick={() => onToggle(s)}>{s.enabled ? 'Pause' : 'Resume'}</button>
                <button className="ghost btn-sm" onClick={() => onRemove(s)}>Remove</button>
                <button className={`btn-sm${isReady(s) ? ' primary' : ''}`} onClick={() => onOpen(s)}>{isReady(s) ? 'Review' : 'Open'}</button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

export function SourcesPage() {
  const list = usePoll(() => api.listSources(), 3000, []);
  const [params, setParams] = useSearchParams();
  const { toast } = useNotify();
  const [adding, setAdding] = useState<Prefill | 'blank' | null>(() => prefillFrom(params));
  const [sel, setSel] = useState<string | null>(params.get('review'));
  const [removing, setRemoving] = useState<SourceInfo | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>(() => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } });
  const { reload } = list;

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
  const count = (f: Filter) => (f === 'all' ? sources.length : sources.filter((s) => s.state === f).length);
  const needle = q.trim().toLowerCase();
  const shown = sources.filter((s) => (filter === 'all' || s.state === filter)
    && (!needle || `${s.name} ${s.id} ${TYPE_LABEL[s.type] ?? s.type}`.toLowerCase().includes(needle)));

  const totals = sources.reduce((a, s) => ({
    lines: a.lines + s.lines, bytes: a.bytes + s.bytes, eps: a.eps + s.eps, errors: a.errors + s.errors,
    live: a.live + (s.enabled && s.status === 'connected' ? 1 : 0), paused: a.paused + (s.enabled ? 0 : 1),
  }), { lines: 0, bytes: 0, eps: 0, errors: 0, live: 0, paused: 0 });

  const pickView = (v: View) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
  const toggle = async (s: SourceInfo) => { await api.patchSource(s.id, { enabled: !s.enabled }); reload(); };
  const remove = async () => {
    if (!removing) return;
    await api.deleteSource(removing.id);
    toast({ title: `${removing.id} removed`, body: 'Stored raw logs stay in the raw store.' });
    setRemoving(null); reload();
  };

  return (
    <div className="stack">
      <PageHead title="Sources" right={
        <button className="primary" onClick={() => setAdding('blank')}><IconPlus size={16} />Add source</button>
      }>
        Connect any log system. Lines are stored raw first; you approve the mapping before anything is normalized.
      </PageHead>
      {list.error && <ErrorState error={list.error} what="sources" />}

      {list.data && (!list.data.bus || !list.data.worker) && (
        <div className="ready-banner pipe-down" role="alert">
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

      {ready.length > 0 && (
        <div className="ready-banner">
          <div className="grow">
            <b>{ready.length === 1 ? '1 source is ready for approval.' : `${ready.length} sources are ready for approval.`}</b>{' '}
            <span className="hint">Check the proposed mapping before its logs are normalized.</span>
          </div>
          <div className="row-tight">
            {ready.map((s) => (
              <button key={s.id} className="primary btn-sm" onClick={() => setSel(s.id)}>Review {s.name || s.id}</button>
            ))}
          </div>
        </div>
      )}

      {sources.length > 0 && (
        <div className="kpis src-kpis">
          <Kpi label="Sources" value={String(sources.length)}
            sub={`${totals.live} connected${totals.paused ? ` · ${totals.paused} paused` : ''}`} />
          <Kpi label="Lines stored" value={compact.format(totals.lines)} sub={bytesFmt(totals.bytes)} />
          <Kpi label="Ingest rate" value={`${Math.round(totals.eps * 10) / 10}/s`} sub="across all sources" />
          <Kpi label="Awaiting approval" value={String(ready.length)} tone={ready.length ? 'warn' : undefined}
            sub={`${count('collecting')} collecting · ${totals.errors} error${totals.errors === 1 ? '' : 's'}`} />
        </div>
      )}

      {list.loading && !list.data && <Panel><Spinner label="Loading sources" /></Panel>}
      {list.data && sources.length === 0 && (
        <Panel>
          <EmptyState title="No sources yet" icon={<IconSources size={22} />}
            action={<button className="primary" onClick={() => setAdding('blank')}><IconPlus size={16} />Add your first source</button>}>
            Pull from a server, stream, API or Loki, or point a shipper at Aletheia. You can also start a sample
            log server on the Demo page and press Connect.
          </EmptyState>
        </Panel>
      )}

      {sources.length > 0 && (
        <>
          <div className="src-toolbar">
            <label className="src-search">
              <IconSearch size={15} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or type" aria-label="Filter sources" />
            </label>
            <div className="seg" role="tablist" aria-label="Filter by state">
              {FILTERS.filter(([f]) => f === 'all' || count(f) > 0).map(([f, label]) => (
                <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                  {label}<span className="seg-n">{count(f)}</span>
                </button>
              ))}
            </div>
            <div className="seg src-view" role="tablist" aria-label="Layout">
              {(['grid', 'list'] as const).map((v) => (
                <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => pickView(v)}>
                  {v === 'grid' ? 'Grid' : 'List'}
                </button>
              ))}
            </div>
          </div>

          {shown.length === 0 ? (
            <Panel><EmptyState title="No sources match" icon={<IconSearch size={20} />}
              action={<button onClick={() => { setQ(''); setFilter('all'); }}>Clear filters</button>} /></Panel>
          ) : view === 'grid' ? (
            <div className="src-grid">
              {shown.map((s) => (
                <SourceCard key={s.id} s={s} onOpen={() => setSel(s.id)} onToggle={() => void toggle(s)} onRemove={() => setRemoving(s)} />
              ))}
              {filter === 'all' && !needle && (
                <button type="button" className="src-add" onClick={() => setAdding('blank')}>
                  <span className="sa-plus"><IconPlus size={18} /></span>
                  <span className="sa-title">Connect another source</span>
                  <span className="hint">TCP, UDP, HTTP, WebSocket, Loki, REST or push</span>
                </button>
              )}
            </div>
          ) : (
            <Panel flush>
              <SourceTable rows={shown} onOpen={(s) => setSel(s.id)} onToggle={(s) => void toggle(s)} onRemove={setRemoving} />
            </Panel>
          )}
        </>
      )}

      {adding && (
        <AddDialog types={list.data?.types ?? Object.keys(TYPE_FIELDS)} prefill={adding === 'blank' ? null : adding}
          onClose={closeAll}
          onDone={(id) => reloadWithToast({ kind: 'ok', title: `${id} connected`, body: 'Collecting raw logs. You will be told when it is ready to approve.' }, '/dashboard/sources')} />
      )}
      {current && <SourceDialog key={current.id} src={current} onClose={closeAll} onChanged={reload} />}
      {removing && (
        <Modal title={`Remove ${removing.id}?`} onClose={() => setRemoving(null)}
          footer={<><button onClick={() => setRemoving(null)}>Cancel</button><button className="danger" onClick={() => void remove()}>Remove source</button></>}>
          <p>This stops collecting from the source. Lines already stored stay in the raw store.</p>
        </Modal>
      )}
    </div>
  );
}
