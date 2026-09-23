// Alert rules: state tiles, rules grouped by Grafana rule group with inline details, a live
// notification feed, and create/edit with a server-side preview.
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, CopyButton, EmptyState, ErrorState, Panel, Spinner } from '../components/Bits';
import type { BadgeKind } from '../components/Bits';
import {
  IconAlert, IconBell, IconCaret, IconCheck, IconExternal, IconInbox, IconPlus, IconSearch, IconTrash,
} from '../components/Icons';
import { Modal } from '../components/Modal';
import { useAlertingVersion } from './AlertingPage';
import { api, errMessage } from '../lib/api';
import {
  ago, conditionSentence, conditionText, fmtValue, grafanaLogsUrl, grafanaRuleUrl, IconBolt, IconEdit, IconFolder,
  IconPause, IconPlay, isDuration, OP_SYMBOL, refreshAlertingStatus, TemplateText, useAlertingStatus,
} from '../lib/alerting';
import { useNotify } from '../lib/notify';
import { usePoll } from '../lib/useAsync';
import type {
  AlertDatasource, AlertingStatus, AlertNoData, AlertOp, AlertPreview, AlertReducer, AlertRule, AlertRuleInput, AlertSeverity,
  AlertState, Sync,
} from '../lib/types';

export const STATE_META: Record<AlertState, { label: string; kind: BadgeKind; help: string }> = {
  firing: { label: 'Firing', kind: 'bad', help: 'The condition has held for the whole pending period; notifications are sent.' },
  pending: { label: 'Pending', kind: 'warn', help: 'The condition is met but the pending period ("for") has not elapsed yet.' },
  normal: { label: 'Normal', kind: 'ok', help: 'The condition is not met.' },
  nodata: { label: 'No data', kind: 'info', help: 'The query returned no series.' },
  error: { label: 'Error', kind: 'bad', help: 'The query failed to evaluate.' },
  paused: { label: 'Paused', kind: 'plain', help: 'Evaluation is paused for this rule.' },
};
const STATE_ORDER: AlertState[] = ['firing', 'pending', 'error', 'nodata', 'normal', 'paused'];

const DS_LABEL: Record<AlertDatasource, string> = { loki: 'Loki (LogQL)', prometheus: 'Prometheus (PromQL)', clickhouse: 'ClickHouse (SQL)' };
const DS_EXAMPLE: Record<AlertDatasource, string> = {
  loki: 'sum(count_over_time({parse_status="raw_only"}[5m]))',
  prometheus: 'sum(increase(aletheia_reconstruct_mismatch_total[5m]))',
  clickhouse: "SELECT count() FROM aletheia.events\nWHERE parse_status = 'raw_only' AND event_time > now() - INTERVAL 5 MINUTE",
};
const DS_HELP: Record<AlertDatasource, string> = {
  loki: 'A LogQL metric query (count_over_time, rate, sum by …), not a plain log selector.',
  prometheus: 'A PromQL expression. Multiple series are each evaluated.',
  clickhouse: 'SQL returning one number in the first column of the first row.',
};
const REDUCERS: AlertReducer[] = ['last', 'mean', 'max', 'min', 'sum', 'count'];
const OPS: AlertOp[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'];
const SEV_KIND: Record<AlertSeverity, BadgeKind> = { critical: 'bad', warning: 'warn', info: 'info' };

export function StatePill({ state, title }: { state: AlertState; title?: string }) {
  const m = STATE_META[state] ?? STATE_META.normal;
  return <Badge kind={m.kind} title={title ?? m.help}><span className="dot" />{m.label}</Badge>;
}

/** Whether Studio's copy reached Grafana; "local" means Studio evaluates it itself. */
export function SyncBadge({ sync }: { sync: Sync }) {
  const kind: BadgeKind = sync.state === 'synced' ? 'ok' : sync.state === 'error' ? 'bad' : sync.state === 'pending' ? 'warn' : 'plain';
  const title = sync.error ?? (sync.at ? `${sync.state} ${ago(sync.at)}` : sync.state === 'local' ? 'Evaluated by Studio (Grafana not in use)' : undefined);
  return <Badge kind={kind} title={title}>{sync.state}</Badge>;
}

/** Only the fields a client may send (CONTRACTS 13.2); server-owned ones are dropped. */
const toInput = (r: AlertRule): AlertRuleInput => ({
  name: r.name, group: r.group, datasource: r.datasource, query: r.query, reducer: r.reducer,
  condition: { ...r.condition }, for: r.for, interval: r.interval, severity: r.severity, labels: { ...r.labels },
  summary: r.summary, description: r.description, enabled: r.enabled, no_data_state: r.no_data_state,
});

// ------------------------------------------------------------------ rule dialog
interface Draft {
  name: string; group: string; datasource: AlertDatasource; query: string; reducer: AlertReducer;
  op: AlertOp; threshold: string; for: string; interval: string; severity: AlertSeverity;
  labels: { k: string; v: string }[]; summary: string; description: string; no_data_state: AlertNoData; enabled: boolean;
}

const blankDraft = (): Draft => ({
  name: '', group: 'aletheia', datasource: 'loki', query: '', reducer: 'last', op: 'gt', threshold: '0',
  for: '5m', interval: '1m', severity: 'warning', labels: [], summary: '', description: '', no_data_state: 'OK', enabled: true,
});

const draftOf = (r: AlertRule): Draft => ({
  ...toInput(r), op: r.condition.op, threshold: String(r.condition.threshold),
  labels: Object.entries(r.labels).map(([k, v]) => ({ k, v })),
});

function RuleDialog({ rule, onClose, onSaved }: { rule: AlertRule | null; onClose: () => void; onSaved: (r: AlertRule) => void }) {
  const [d, setD] = useState<Draft>(() => (rule ? draftOf(rule) : blankDraft()));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<AlertPreview | 'busy' | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const threshold = Number(d.threshold);
  const problems = [
    !d.name.trim() && 'a name',
    !d.query.trim() && 'a query',
    (d.threshold.trim() === '' || !Number.isFinite(threshold)) && 'a numeric threshold',
    !isDuration(d.for) && 'a pending period like 0s or 5m',
    !isDuration(d.interval) && 'an interval like 1m',
    d.labels.some((l) => !l.k.trim() && l.v.trim()) && 'a key for every label',
  ].filter(Boolean) as string[];

  const body = (): AlertRuleInput => ({
    name: d.name.trim(), group: d.group.trim() || 'aletheia', datasource: d.datasource, query: d.query.trim(),
    reducer: d.reducer, condition: { op: d.op, threshold }, for: d.for.trim(), interval: d.interval.trim(),
    severity: d.severity, summary: d.summary, description: d.description, enabled: d.enabled, no_data_state: d.no_data_state,
    labels: Object.fromEntries(d.labels.filter((l) => l.k.trim()).map((l) => [l.k.trim(), l.v])),
  });

  const save = async () => {
    if (problems.length) { setErr(`Needs ${problems.join(', ')}.`); return; }
    setBusy(true); setErr(null);
    try { onSaved(rule ? await api.updateAlertRule(rule.id, body()) : await api.createAlertRule(body())); }
    catch (e) { setErr(errMessage(e)); setBusy(false); }
  };

  const runPreview = async () => {
    setPreview('busy');
    try {
      setPreview(await api.previewAlertRule({
        datasource: d.datasource, query: d.query.trim(), reducer: d.reducer,
        condition: { op: d.op, threshold: Number.isFinite(threshold) ? threshold : 0 },
      }));
    } catch (e) { setPreview({ value: null, firing: false, error: errMessage(e), series: 0 }); }
  };

  const sevLabel = d.labels.find((l) => l.k.trim() === 'severity');

  return (
    <Modal wide onClose={onClose} title={rule ? `Edit ${rule.name}` : 'New alert rule'}
      subtitle="Evaluated every interval; fires once the condition has held for the pending period."
      footer={<>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : rule ? 'Save rule' : 'Create rule'}</button>
      </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="form-grid">
          <label className="field"><span className="lbl">Name</span>
            <input autoFocus={!rule} value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="Raw-only lines spike" required /></label>
          <label className="field"><span className="lbl">Group</span>
            <input value={d.group} onChange={(e) => set('group', e.target.value)} placeholder="aletheia" />
            <span className="help">Grafana rule group in the "Aletheia" folder.</span></label>
        </div>

        <section className="al-section stack-sm">
          <h4 className="wk-h"><span className="wk-step">1</span> Query</h4>
          <label className="field"><span className="lbl">Data source</span>
            <select value={d.datasource} onChange={(e) => { set('datasource', e.target.value as AlertDatasource); setPreview(null); }}>
              {(Object.keys(DS_LABEL) as AlertDatasource[]).map((k) => <option key={k} value={k}>{DS_LABEL[k]}</option>)}
            </select></label>
          <label className="field code"><span className="lbl">Query</span>
            <textarea rows={4} spellCheck={false} value={d.query} placeholder={DS_EXAMPLE[d.datasource]}
              onChange={(e) => set('query', e.target.value)} />
            <span className="help">{DS_HELP[d.datasource]}{' '}
              {!d.query && <button type="button" className="ghost" onClick={() => set('query', DS_EXAMPLE[d.datasource])}>Use example</button>}
            </span></label>
        </section>

        <section className="al-section stack-sm">
          <h4 className="wk-h"><span className="wk-step">2</span> Condition</h4>
          <div className="al-cond">
            <label className="field"><span className="lbl">Reduce with</span>
              <select value={d.reducer} onChange={(e) => set('reducer', e.target.value as AlertReducer)}>
                {REDUCERS.map((r) => <option key={r} value={r}>{r}()</option>)}</select></label>
            <label className="field"><span className="lbl">Is</span>
              <select value={d.op} onChange={(e) => set('op', e.target.value as AlertOp)} aria-label="Comparison">
                {OPS.map((o) => <option key={o} value={o}>{OP_SYMBOL[o]}</option>)}</select></label>
            <label className="field"><span className="lbl">Threshold</span>
              <input type="number" step="any" value={d.threshold} onChange={(e) => set('threshold', e.target.value)} /></label>
            <label className="field"><span className="lbl">For</span>
              <input value={d.for} onChange={(e) => set('for', e.target.value)} placeholder="5m" aria-invalid={!isDuration(d.for)} /></label>
            <label className="field"><span className="lbl">Every</span>
              <input value={d.interval} onChange={(e) => set('interval', e.target.value)} placeholder="1m" aria-invalid={!isDuration(d.interval)} /></label>
          </div>
          <div className="btn-row">
            <code className="al-cond-text">{Number.isFinite(threshold) ? conditionText({ reducer: d.reducer, condition: { op: d.op, threshold }, for: d.for }) : '…'}</code>
            <button type="button" className="btn-sm" disabled={!d.query.trim() || preview === 'busy'} onClick={() => void runPreview()}>
              {preview === 'busy' ? 'Evaluating…' : 'Preview'}
            </button>
          </div>
          {Number.isFinite(threshold) && d.threshold.trim() !== '' && (
            <p className="alr-sentence">{conditionSentence({ reducer: d.reducer, condition: { op: d.op, threshold }, for: d.for, interval: d.interval })}</p>
          )}
          {preview && preview !== 'busy' && (
            <div className={`al-preview ${preview.error ? 'bad' : preview.firing ? 'warn' : 'ok'}`} role="status">
              {preview.error ? <><b>Query failed.</b> <span className="mono">{preview.error}</span></> : (
                <>
                  <span>Value <b className="mono">{fmtValue(preview.value)}</b></span>
                  <span>{preview.series} series</span>
                  <b>{preview.firing ? 'Condition met: this would fire after the pending period' : 'Condition not met: stays normal'}</b>
                </>
              )}
            </div>
          )}
          <label className="field"><span className="lbl">When the query returns no data</span>
            <select value={d.no_data_state} onChange={(e) => set('no_data_state', e.target.value as AlertNoData)}>
              <option value="OK">Treat as normal (OK)</option>
              <option value="NoData">Show "No data" state</option>
              <option value="Alerting">Fire (Alerting)</option>
            </select></label>
        </section>

        <section className="al-section stack-sm">
          <h4 className="wk-h"><span className="wk-step">3</span> Notification details</h4>
          <div className="form-grid">
            <label className="field"><span className="lbl">Severity</span>
              <select value={d.severity} onChange={(e) => set('severity', e.target.value as AlertSeverity)}>
                <option value="critical">critical</option><option value="warning">warning</option><option value="info">info</option>
              </select>
              <span className="help">Also sent as the <code>severity</code> label, which notification policies route on.</span></label>
            <label className="field"><span className="lbl">Summary</span>
              <input value={d.summary} onChange={(e) => set('summary', e.target.value)} placeholder="{{ $values }} raw-only lines in 5m" /></label>
          </div>
          <label className="field"><span className="lbl">Description</span>
            <textarea rows={2} value={d.description} onChange={(e) => set('description', e.target.value)} placeholder="What it means and what to do next" /></label>
          <div className="field">
            <span className="lbl">Labels</span>
            {d.labels.map((l, i) => (
              <div className="al-kv" key={i}>
                <input aria-label={`Label ${i + 1} key`} value={l.k} placeholder="team"
                  onChange={(e) => set('labels', d.labels.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
                <input aria-label={`Label ${i + 1} value`} value={l.v} placeholder="secops"
                  onChange={(e) => set('labels', d.labels.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
                <button type="button" className="ghost icon" aria-label={`Remove label ${l.k || i + 1}`}
                  onClick={() => set('labels', d.labels.filter((_, j) => j !== i))}><IconTrash size={13} /></button>
              </div>
            ))}
            <div className="btn-row">
              <button type="button" className="btn-sm" onClick={() => set('labels', [...d.labels, { k: '', v: '' }])}><IconPlus size={13} />Add label</button>
              {sevLabel && <span className="hint err">The severity field above overrides a "severity" label.</span>}
            </div>
          </div>
          <label className="checkbox-label">
            <input type="checkbox" checked={d.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            Enabled (uncheck to create it paused)
          </label>
        </section>
        {err && <p className="hint err" role="alert">{err}</p>}
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ list pieces
type Bucket = 'firing' | 'pending' | 'normal' | 'problem' | 'paused';

const BUCKETS: { key: Bucket; label: string; sub: string; states: AlertState[] }[] = [
  { key: 'firing', label: 'Firing', sub: 'sending notifications', states: ['firing'] },
  { key: 'pending', label: 'Pending', sub: 'inside the pending period', states: ['pending'] },
  { key: 'normal', label: 'Normal', sub: 'condition not met', states: ['normal'] },
  { key: 'problem', label: 'Error / No data', sub: 'query failed or empty', states: ['error', 'nodata'] },
  { key: 'paused', label: 'Paused', sub: 'not evaluated', states: ['paused'] },
];
const bucketOf = (s: AlertState): Bucket => BUCKETS.find((b) => b.states.includes(s))?.key ?? 'normal';

const DS_SHORT: Record<AlertDatasource, string> = { loki: 'Loki · LogQL', prometheus: 'Prometheus · PromQL', clickhouse: 'ClickHouse · SQL' };
const NODATA_TEXT: Record<AlertNoData, string> = {
  OK: 'No data counts as normal.', NoData: 'No data shows the "No data" state.', Alerting: 'No data fires the alert.',
};

function StatTiles({ counts, value, onPick }: {
  counts: Record<Bucket, number>; value: Bucket | ''; onPick: (b: Bucket | '') => void;
}) {
  return (
    <div className="alr-tiles" role="group" aria-label="Filter rules by state">
      {BUCKETS.map((b) => (
        <button key={b.key} type="button" className={`alr-tile t-${b.key}${counts[b.key] > 0 ? ' hot' : ''}`}
          aria-pressed={value === b.key} onClick={() => onPick(value === b.key ? '' : b.key)}
          title={value === b.key ? 'Show all rules' : `Show only ${b.label.toLowerCase()} rules`}>
          <span className="alr-tile-l"><i aria-hidden="true" />{b.label}</span>
          <span className="alr-tile-n">{counts[b.key]}</span>
          <span className="alr-tile-d">{b.sub}</span>
        </button>
      ))}
    </div>
  );
}

function RuleDetail({ r, id, status, onEdit }: { r: AlertRule; id: string; status: AlertingStatus | null; onEdit: () => void }) {
  const view = grafanaRuleUrl(status, r.id);
  const logs = r.datasource === 'loki' ? grafanaLogsUrl(status) : null;
  const labels = { severity: r.severity, ...r.labels };
  return (
    <div className="alr-detail" id={id}>
      <div className="alr-detail-main">
        {r.last_error && (
          <div className="alr-err" role="note">
            <IconAlert size={15} />
            <div><b>Last evaluation failed</b><code>{r.last_error}</code></div>
          </div>
        )}
        <div className="alr-q-head">
          <span className="alr-k">Query</span>
          <span className="alr-ds">{DS_SHORT[r.datasource]}</span>
          <CopyButton text={r.query} label="Copy query" />
        </div>
        <pre className="alr-code">{r.query}</pre>
        <p className="alr-sentence">{conditionSentence(r)} {NODATA_TEXT[r.no_data_state]}</p>
        {(r.summary || r.description) && (
          <div className="alr-text">
            {r.summary && <p><span className="alr-k">Summary</span><TemplateText text={r.summary} /></p>}
            {r.description && <p><span className="alr-k">Description</span>{r.description}</p>}
          </div>
        )}
      </div>
      <div className="alr-detail-side">
        <dl className="alr-facts">
          <div><dt>Last value</dt><dd className="mono">{fmtValue(r.last_value)}</dd></div>
          <div><dt>Evaluated</dt><dd title={r.last_eval ?? undefined}>{r.enabled ? ago(r.last_eval) : 'paused'}</dd></div>
          <div><dt>Sync</dt><dd><SyncBadge sync={r.sync} />{r.sync.error && <span className="alr-sync-err">{r.sync.error}</span>}</dd></div>
          <div><dt>Updated</dt><dd title={r.updated_at}>{ago(r.updated_at)}</dd></div>
        </dl>
        <div className="alr-labels" aria-label="Labels">
          {Object.entries(labels).map(([k, v]) => <span key={k} className="alr-label"><span>{k}</span>={v}</span>)}
        </div>
        <div className="alr-links">
          <button type="button" className="btn-sm" onClick={onEdit}><IconEdit size={13} />Edit rule</button>
          {view && <a className="btn btn-sm" href={view} target="_blank" rel="noopener noreferrer"><IconExternal size={13} />View in Grafana</a>}
          {logs && <a className="btn btn-sm" href={logs} target="_blank" rel="noopener noreferrer"><IconExternal size={13} />Explore logs</a>}
        </div>
      </div>
    </div>
  );
}

function RuleRow({ r, open, flash, busy, status, onToggle, onEdit, onPause, onDelete }: {
  r: AlertRule; open: boolean; flash: boolean; busy: boolean; status: AlertingStatus | null;
  onToggle: () => void; onEdit: () => void; onPause: () => void; onDelete: () => void;
}) {
  const detailId = `alr-d-${r.id}`;
  const syncWarn = r.sync.state === 'error' || r.sync.state === 'pending';
  return (
    <li id={`alr-rule-${r.id}`} className={`alr-rule s-${r.state}${open ? ' open' : ''}${flash ? ' flash' : ''}`}>
      {/* The whole row toggles for mouse users; the main button carries the keyboard and ARIA state. */}
      <div className="alr-row" onClick={onToggle}>
        <button type="button" className="alr-main" aria-expanded={open} aria-controls={detailId}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}>
          <IconCaret size={14} className="alr-caret" />
          <span className="alr-name-wrap">
            <span className="alr-name">
              <span className="alr-name-t">{r.name}</span>
              <Badge kind={SEV_KIND[r.severity] ?? 'plain'}>{r.severity}</Badge>
              {syncWarn && <Badge kind={r.sync.state === 'error' ? 'bad' : 'warn'} title={r.sync.error}>sync {r.sync.state}</Badge>}
            </span>
            {r.summary && <span className="alr-summary"><TemplateText text={r.summary} /></span>}
          </span>
        </button>
        <span className="alr-state"><StatePill state={r.state} title={r.last_error} /></span>
        <span className="alr-cond" title={r.query}>
          <code>{conditionText(r)}</code>
          <span className="alr-sub">{r.datasource} · every {r.interval}</span>
        </span>
        <span className="alr-val">
          <span className="mono">{fmtValue(r.last_value)}</span>
          <span className="alr-sub" title={r.last_eval ?? undefined}>{r.enabled ? ago(r.last_eval) : 'paused'}</span>
        </span>
        <span className="alr-acts" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="ghost icon" aria-label={`Edit ${r.name}`} title="Edit" onClick={onEdit}><IconEdit size={15} /></button>
          <button type="button" className="ghost icon" disabled={busy} aria-label={`${r.enabled ? 'Pause' : 'Resume'} ${r.name}`}
            title={r.enabled ? 'Pause evaluation' : 'Resume evaluation'} onClick={onPause}>
            {r.enabled ? <IconPause size={15} /> : <IconPlay size={15} />}
          </button>
          <button type="button" className="ghost icon alr-del" aria-label={`Delete ${r.name}`} title="Delete" onClick={onDelete}><IconTrash size={15} /></button>
        </span>
      </div>
      {open && <RuleDetail r={r} id={detailId} status={status} onEdit={onEdit} />}
    </li>
  );
}

const NOTE_META: Record<'firing' | 'resolved' | 'test', { label: string; icon: ReactNode }> = {
  firing: { label: 'Firing', icon: <IconBell size={14} /> },
  resolved: { label: 'Resolved', icon: <IconCheck size={14} /> },
  test: { label: 'Test', icon: <IconBolt size={14} /> },
};

function RecentNotifications({ version, known, onJump }: { version: number; known: Set<string>; onJump: (id: string) => void }) {
  const feed = usePoll(() => api.alertNotifications(undefined, 20), 10000, [version]);
  const items = useMemo(() => [...(feed.data?.items ?? [])].reverse(), [feed.data]);
  return (
    <Panel flush className="alr-feed-panel" title="Recent notifications"
      subtitle={feed.data ? `${items.length ? `last ${items.length}` : 'none yet'} · live` : undefined}>
      {feed.error && !feed.data && <div className="panel-pad"><ErrorState error={feed.error} what="notifications" /></div>}
      {feed.loading && !feed.data && <div className="panel-pad"><Spinner label="Loading" /></div>}
      {feed.data && items.length === 0 && (
        <div className="alr-feed-empty">
          <IconInbox size={20} />
          <p>No notifications yet. Alerts routed to a browser contact point show up here.</p>
          <Link to="../contact-points">Send a test from Contact points</Link>
        </div>
      )}
      {items.length > 0 && (
        <ol className="alr-feed">
          {items.map((n) => {
            const kind = n.source === 'test' ? 'test' : n.status;
            const m = NOTE_META[kind];
            const jump = n.rule_id && known.has(n.rule_id) ? n.rule_id : null;
            const body = (
              <>
                <span className="alr-note-ico" aria-hidden="true">{m.icon}</span>
                <span className="alr-note-body">
                  <span className="alr-note-top">
                    <span className="alr-note-name">{n.rule_name}</span>
                    {n.severity && <Badge kind={SEV_KIND[n.severity as AlertSeverity] ?? 'plain'}>{n.severity}</Badge>}
                  </span>
                  {n.summary && <span className="alr-note-sum"><TemplateText text={n.summary} /></span>}
                  <span className="alr-note-meta">
                    <span className="alr-note-st">{m.label}</span>
                    <span>to {n.contact_point_name}</span>
                    <time dateTime={n.received_at} title={n.received_at}>{ago(n.received_at)}</time>
                  </span>
                </span>
              </>
            );
            return (
              <li key={n.id} className={`alr-note n-${kind}`}>
                {jump
                  ? <button type="button" className="alr-note-in" onClick={() => onJump(jump)} title="Show this rule">{body}</button>
                  : <div className="alr-note-in">{body}</div>}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ page
export function AlertRulesPage() {
  const version = useAlertingVersion();
  const list = usePoll(() => api.listAlertRules(), 10000, [version]);
  const { status } = useAlertingStatus();
  const { toast } = useNotify();
  const [q, setQ] = useState('');
  const [bucket, setBucket] = useState<Bucket | ''>('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [shut, setShut] = useState<Set<string>>(() => new Set());
  const [flash, setFlash] = useState<string | null>(null);
  const [editing, setEditing] = useState<AlertRule | 'new' | null>(null);
  const [removing, setRemoving] = useState<AlertRule | null>(null);
  const [rmErr, setRmErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rules = list.data?.rules ?? [];
  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { firing: 0, pending: 0, normal: 0, problem: 0, paused: 0 };
    for (const r of rules) c[bucketOf(r.state)] += 1;
    return c;
  }, [rules]);
  const known = useMemo(() => new Set(rules.map((r) => r.id)), [rules]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (r: AlertRule) => (!bucket || bucketOf(r.state) === bucket)
      && (!needle || [r.name, r.group, r.query, r.summary, r.severity, r.datasource, ...Object.entries(r.labels).flat()]
        .some((s) => s.toLowerCase().includes(needle)));
    const by = new Map<string, AlertRule[]>();
    for (const r of rules) by.set(r.group || 'aletheia', [...(by.get(r.group || 'aletheia') ?? []), r]);
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, all]) => ({
      name, total: all.length,
      firing: all.filter((r) => r.state === 'firing').length,
      pending: all.filter((r) => r.state === 'pending').length,
      intervals: [...new Set(all.map((r) => r.interval))],
      shown: all.filter(match)
        .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.name.localeCompare(b.name)),
    })).filter((g) => g.shown.length > 0);
  }, [rules, q, bucket]);
  const shownCount = groups.reduce((n, g) => n + g.shown.length, 0);

  const flip = (set: Set<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };
  const changed = () => { list.reload(); void refreshAlertingStatus(); };
  const clear = () => { setQ(''); setBucket(''); };

  // From the notification feed: reveal the rule wherever filters or a collapsed group hid it.
  const jumpTo = (id: string) => {
    const r = rules.find((x) => x.id === id);
    if (!r) return;
    if (bucket && bucketOf(r.state) !== bucket) setBucket('');
    if (q) setQ('');
    setShut((s) => { const n = new Set(s); n.delete(r.group || 'aletheia'); return n; });
    setOpen((s) => new Set(s).add(id));
    setFlash(id);
  };
  useEffect(() => {
    if (!flash) return;
    const el = document.getElementById(`alr-rule-${flash}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.querySelector<HTMLButtonElement>('.alr-main')?.focus({ preventScroll: true });
    const t = window.setTimeout(() => setFlash(null), 1800);
    return () => window.clearTimeout(t);
  }, [flash]);

  const togglePause = async (r: AlertRule) => {
    setBusyId(r.id);
    try {
      await api.updateAlertRule(r.id, { ...toInput(r), enabled: !r.enabled });
      toast({ kind: 'ok', title: r.enabled ? `${r.name} paused` : `${r.name} resumed` });
      changed();
    } catch (e) { toast({ kind: 'bad', title: `Could not ${r.enabled ? 'pause' : 'resume'} ${r.name}`, body: errMessage(e) }); }
    finally { setBusyId(null); }
  };

  const remove = async () => {
    if (!removing) return;
    setRmErr(null);
    try {
      await api.deleteAlertRule(removing.id);
      toast({ title: `${removing.name} deleted` });
      setRemoving(null); changed();
    } catch (e) { setRmErr(errMessage(e)); }
  };

  const activeBucket = BUCKETS.find((b) => b.key === bucket);

  return (
    <div className="alr">
      {list.data && rules.length > 0 && <StatTiles counts={counts} value={bucket} onPick={setBucket} />}

      <div className="alr-layout">
        <Panel flush className="alr-panel" title="Alert rules"
          subtitle={list.data ? `${rules.length} rule${rules.length === 1 ? '' : 's'}` : undefined}
          right={<button type="button" className="primary btn-sm" onClick={() => setEditing('new')}><IconPlus size={13} />New alert rule</button>}>
          {rules.length > 0 && (
            <div className="alr-toolbar">
              <label className="lineage-search-box al-search alr-search">
                <IconSearch size={14} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, query, label…" aria-label="Search alert rules" />
              </label>
              {(bucket || q) && (
                <span className="alr-filter-note">
                  {shownCount} of {rules.length} shown{activeBucket ? ` · ${activeBucket.label}` : ''}
                  <button type="button" className="ghost" onClick={clear}>Clear</button>
                </span>
              )}
            </div>
          )}

          {list.error && <div className="panel-pad"><ErrorState error={list.error} what="alert rules" /></div>}
          {list.loading && !list.data && <div className="panel-pad"><Spinner label="Loading rules" /></div>}
          {list.data && rules.length === 0 && (
            <EmptyState title="No alert rules yet" icon={<IconBell size={22} />}
              action={<button type="button" className="primary" onClick={() => setEditing('new')}><IconPlus size={14} />Create your first rule</button>}>
              A rule runs a Loki, Prometheus or ClickHouse query every interval and fires when the result crosses a threshold.
              Firing alerts are routed to contact points by the notification policies.
            </EmptyState>
          )}
          {list.data && rules.length > 0 && shownCount === 0 && (
            <EmptyState title="No rules match" icon={<IconSearch size={20} />}
              action={<div className="btn-row"><button type="button" onClick={clear}>Clear filters</button>
                <button type="button" className="primary" onClick={() => setEditing('new')}><IconPlus size={14} />New alert rule</button></div>}>
              {activeBucket ? `No ${activeBucket.label.toLowerCase()} rules` : 'Nothing'}{q.trim() ? ` matching “${q.trim()}”` : ''}.
            </EmptyState>
          )}

          {groups.map((g) => {
            const collapsed = shut.has(g.name);
            const gid = `alr-g-${g.name.replace(/\W+/g, '-')}`;
            return (
              <section key={g.name} className="alr-group" aria-label={`Rule group ${g.name}`}>
                <h3 className="alr-group-h">
                  <button type="button" className="alr-group-btn" aria-expanded={!collapsed} aria-controls={gid}
                    onClick={() => setShut((s) => flip(s, g.name))}>
                    <IconCaret size={13} className="alr-caret" />
                    <IconFolder size={14} className="alr-folder-ico" />
                    <span className="alr-path"><span className="alr-folder">Aletheia /</span> {g.name}</span>
                    <span className="alr-gmeta">
                      every {g.intervals.join(', ')} · {g.shown.length === g.total ? g.total : `${g.shown.length} of ${g.total}`} rule{g.total === 1 ? '' : 's'}
                    </span>
                    <span className="alr-gcounts">
                      {g.firing > 0 && <Badge kind="bad">{g.firing} firing</Badge>}
                      {g.pending > 0 && <Badge kind="warn">{g.pending} pending</Badge>}
                    </span>
                  </button>
                </h3>
                {!collapsed && (
                  <ul className="alr-rules" id={gid}>
                    {g.shown.map((r) => (
                      <RuleRow key={r.id} r={r} status={status} open={open.has(r.id)} flash={flash === r.id} busy={busyId === r.id}
                        onToggle={() => setOpen((s) => flip(s, r.id))} onEdit={() => setEditing(r)}
                        onPause={() => void togglePause(r)} onDelete={() => { setRmErr(null); setRemoving(r); }} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </Panel>

        <RecentNotifications version={version} known={known} onJump={jumpTo} />
      </div>

      {editing && (
        <RuleDialog key={editing === 'new' ? 'new' : editing.id} rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(r) => { toast({ kind: 'ok', title: editing === 'new' ? `${r.name} created` : `${r.name} saved` }); setEditing(null); changed(); }} />
      )}
      {removing && (
        <Modal title={`Delete ${removing.name}?`} onClose={() => setRemoving(null)}
          footer={<><button type="button" onClick={() => setRemoving(null)}>Cancel</button><button type="button" className="danger" onClick={() => void remove()}>Delete rule</button></>}>
          <p>The rule stops being evaluated and is removed from Grafana on the next sync. This cannot be undone.</p>
          {rmErr && <p className="hint err" role="alert">{rmErr}</p>}
        </Modal>
      )}
    </div>
  );
}
