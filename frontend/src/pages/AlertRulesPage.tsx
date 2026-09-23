// Alert rules: list with live state, create/edit with a server-side preview, pause and delete.
import { useMemo, useState } from 'react';
import { Badge, EmptyState, ErrorState, Panel, Spinner } from '../components/Bits';
import type { BadgeKind } from '../components/Bits';
import { IconBell, IconPlus, IconSearch, IconTrash } from '../components/Icons';
import { Modal } from '../components/Modal';
import { useAlertingVersion } from './AlertingPage';
import { api, errMessage } from '../lib/api';
import { ago, conditionText, fmtValue, isDuration, OP_SYMBOL, refreshAlertingStatus } from '../lib/alerting';
import { useNotify } from '../lib/notify';
import { usePoll } from '../lib/useAsync';
import type {
  AlertDatasource, AlertNoData, AlertOp, AlertPreview, AlertReducer, AlertRule, AlertRuleInput, AlertSeverity,
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

// ------------------------------------------------------------------ page
export function AlertRulesPage() {
  const version = useAlertingVersion();
  const list = usePoll(() => api.listAlertRules(), 10000, [version]);
  const { toast } = useNotify();
  const [q, setQ] = useState('');
  const [stateF, setStateF] = useState<AlertState | ''>('');
  const [editing, setEditing] = useState<AlertRule | 'new' | null>(null);
  const [removing, setRemoving] = useState<AlertRule | null>(null);
  const [rmErr, setRmErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rules = list.data?.rules ?? [];
  const counts = useMemo(() => {
    const c: Partial<Record<AlertState, number>> = {};
    for (const r of rules) c[r.state] = (c[r.state] ?? 0) + 1;
    return c;
  }, [rules]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rules
      .filter((r) => !stateF || r.state === stateF)
      .filter((r) => !needle || [r.name, r.group, r.query, r.summary, r.severity, r.datasource, ...Object.entries(r.labels).flat()]
        .some((s) => s.toLowerCase().includes(needle)))
      .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.name.localeCompare(b.name));
  }, [rules, q, stateF]);

  const changed = () => { list.reload(); void refreshAlertingStatus(); };

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

  return (
    <>
      <Panel flush title="Alert rules" subtitle={list.data ? `${rules.length} rule${rules.length === 1 ? '' : 's'}` : undefined}
        right={<button type="button" className="primary btn-sm" onClick={() => setEditing('new')}><IconPlus size={13} />New alert rule</button>}>
        <div className="panel-pad stack-sm">
          <label className="lineage-search-box al-search">
            <IconSearch size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, query, label…" aria-label="Search alert rules" />
          </label>
          <div className="row-tight" role="group" aria-label="Filter by state">
            <button type="button" className={`btn-sm ${stateF === '' ? 'primary' : 'ghost'}`} aria-pressed={stateF === ''} onClick={() => setStateF('')}>All {rules.length}</button>
            {STATE_ORDER.map((s) => (
              <button key={s} type="button" className={`btn-sm ${stateF === s ? 'primary' : 'ghost'}`} aria-pressed={stateF === s}
                onClick={() => setStateF(stateF === s ? '' : s)}>{STATE_META[s].label} {counts[s] ?? 0}</button>
            ))}
          </div>
        </div>

        {list.error && <div className="panel-pad"><ErrorState error={list.error} what="alert rules" /></div>}
        {list.loading && !list.data && <div className="panel-pad"><Spinner label="Loading rules" /></div>}
        {list.data && rules.length === 0 && (
          <EmptyState title="No alert rules yet" icon={<IconBell size={22} />}
            action={<button type="button" className="primary" onClick={() => setEditing('new')}>Create the first rule</button>}>
            A rule runs a Loki, Prometheus or ClickHouse query on an interval and fires when the result crosses a threshold.
          </EmptyState>
        )}
        {list.data && rules.length > 0 && shown.length === 0 && (
          <EmptyState title="No rules match" action={<button type="button" onClick={() => { setQ(''); setStateF(''); }}>Clear filters</button>} />
        )}
        {shown.length > 0 && (
          <div className="table-scroll"><table className="data">
            <thead><tr>
              <th>State</th><th>Rule</th><th>Severity</th><th>Source</th><th>Condition</th><th>Last value</th><th>Sync</th><th><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setEditing(r)}>
                  <td className="nowrap"><StatePill state={r.state} title={r.last_error} /></td>
                  <td className="wrap">
                    <b>{r.name}</b>
                    <div className="hint clamp2" title={r.summary}>{r.group}{r.summary ? ` · ${r.summary}` : ''}</div>
                    {r.last_error && <div className="hint err">{r.last_error}</div>}
                  </td>
                  <td><Badge kind={SEV_KIND[r.severity] ?? 'plain'}>{r.severity}</Badge></td>
                  <td className="nowrap">{r.datasource}</td>
                  <td className="mono nowrap" title={r.query}>{conditionText(r)}</td>
                  <td className="nowrap">
                    <span className="mono">{fmtValue(r.last_value)}</span>
                    <div className="hint" title={r.last_eval ?? undefined}>{r.enabled ? ago(r.last_eval) : 'paused'}</div>
                  </td>
                  <td><SyncBadge sync={r.sync} /></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="row-tight row-nowrap">
                      <button type="button" className="ghost" onClick={() => setEditing(r)}>Edit</button>
                      <button type="button" className="ghost" disabled={busyId === r.id} onClick={() => void togglePause(r)}>{r.enabled ? 'Pause' : 'Resume'}</button>
                      <button type="button" className="ghost" onClick={() => { setRmErr(null); setRemoving(r); }}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Panel>

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
    </>
  );
}
