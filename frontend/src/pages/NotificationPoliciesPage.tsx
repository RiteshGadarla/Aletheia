// Notification policies: the default policy plus a nested route tree, edited locally and saved
// as one PUT (CONTRACTS 13.3). Route ids are generated here and stay stable within the tree.
import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Badge, Callout, EmptyState, ErrorState, Panel, Spinner } from '../components/Bits';
import { IconPlus, IconTrash } from '../components/Icons';
import { Modal } from '../components/Modal';
import { SyncBadge } from './AlertRulesPage';
import { useAlertingVersion } from './AlertingPage';
import { api, errMessage } from '../lib/api';
import { isDuration, newId, refreshAlertingStatus } from '../lib/alerting';
import { useNotify } from '../lib/notify';
import { useAsync } from '../lib/useAsync';
import type { ContactPoint, Matcher, MatcherOp, NotificationPolicy, PolicyRoute, Sync } from '../lib/types';

const MATCH_OPS: MatcherOp[] = ['=', '!=', '=~', '!~'];
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/* ---------------------------------------------------------------- tree helpers */

/** Applies fn to the sibling list that holds `id`, at any depth; returns a new tree. */
function withSiblings(list: PolicyRoute[], id: string, fn: (l: PolicyRoute[], i: number) => PolicyRoute[]): PolicyRoute[] {
  const i = list.findIndex((r) => r.id === id);
  if (i >= 0) return fn(list, i);
  return list.map((r) => ({ ...r, routes: withSiblings(r.routes, id, fn) }));
}

const replaceRoute = (t: PolicyRoute[], next: PolicyRoute) =>
  withSiblings(t, next.id, (l, i) => l.map((r, k) => (k === i ? { ...next, routes: r.routes } : r)));
const removeRoute = (t: PolicyRoute[], id: string) => withSiblings(t, id, (l, i) => l.filter((_, k) => k !== i));
const addChild = (t: PolicyRoute[], parent: string, child: PolicyRoute) =>
  withSiblings(t, parent, (l, i) => l.map((r, k) => (k === i ? { ...r, routes: [...r.routes, child] } : r)));
const moveRoute = (t: PolicyRoute[], id: string, by: -1 | 1) => withSiblings(t, id, (l, i) => {
  const j = i + by;
  if (j < 0 || j >= l.length) return l;
  const out = [...l];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
});

/** Everything that would make the PUT fail, found before sending it. */
function problemsOf(p: NotificationPolicy, known: Set<string>): string[] {
  const out: string[] = [];
  if (!known.has(p.receiver)) out.push('The default policy needs a contact point.');
  for (const [k, v] of [['group wait', p.group_wait], ['group interval', p.group_interval], ['repeat interval', p.repeat_interval]]) {
    if (!isDuration(v)) out.push(`Default ${k} "${v}" is not a duration like 30s or 5m.`);
  }
  const walk = (routes: PolicyRoute[], depth: string) => routes.forEach((r, i) => {
    const where = `Route ${depth}${i + 1}`;
    if (!known.has(r.receiver)) out.push(`${where} sends to a contact point that no longer exists.`);
    if (r.matchers.some((m) => !m.label.trim())) out.push(`${where} has a matcher without a label.`);
    for (const v of [r.group_wait, r.group_interval, r.repeat_interval]) if (v && !isDuration(v)) out.push(`${where}: "${v}" is not a duration.`);
    walk(r.routes, `${depth}${i + 1}.`);
  });
  walk(p.routes, '');
  return out;
}

/* ---------------------------------------------------------------- small editors */

function ChipsInput({ label, values, onChange, placeholder, help }: {
  label: string; values: string[]; onChange: (v: string[]) => void; placeholder: string; help?: string;
}) {
  const [text, setText] = useState('');
  const add = () => {
    const v = text.trim().replace(/,$/, '');
    if (v && !values.includes(v)) onChange([...values, v]);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
    else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
  };
  return (
    <div className="field"><span className="lbl">{label}</span>
      <div className="al-chips-input">
        {values.map((v) => (
          <span key={v} className="al-chip">{v}
            <button type="button" className="ghost icon" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
          </span>
        ))}
        <input aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={add} placeholder={values.length ? '' : placeholder} />
      </div>
      {help && <span className="help">{help}</span>}
    </div>
  );
}

function ReceiverSelect({ value, points, onChange, label = 'Contact point' }: {
  value: string; points: ContactPoint[]; onChange: (v: string) => void; label?: string;
}) {
  const unknown = value && !points.some((p) => p.id === value);
  return (
    <label className="field"><span className="lbl">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {!value && <option value="">Choose…</option>}
        {unknown && <option value={value}>Missing contact point ({value})</option>}
        {points.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
      </select></label>
  );
}

const MatcherChip = ({ m }: { m: Matcher }) => (
  <span className="al-chip mono">{m.label} {m.op} {m.value || '""'}</span>
);

/* ---------------------------------------------------------------- route dialog */

type RouteEdit = { route: PolicyRoute; parent: string | null; isNew: boolean };

function RouteDialog({ edit, points, onClose, onApply }: {
  edit: RouteEdit; points: ContactPoint[]; onClose: () => void; onApply: (r: PolicyRoute) => void;
}) {
  const [r, setR] = useState<PolicyRoute>(() => clone(edit.route));
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof PolicyRoute>(k: K, v: PolicyRoute[K]) => setR((x) => ({ ...x, [k]: v }));
  const setM = (i: number, m: Partial<Matcher>) => set('matchers', r.matchers.map((x, j) => (j === i ? { ...x, ...m } : x)));
  const timing = (k: 'group_wait' | 'group_interval' | 'repeat_interval', label: string, ph: string) => (
    <label className="field"><span className="lbl">{label}</span>
      <input value={r[k] ?? ''} placeholder={`inherit (${ph})`} aria-invalid={!!r[k] && !isDuration(r[k] ?? '')}
        onChange={(e) => set(k, e.target.value.trim() ? e.target.value : undefined)} /></label>
  );

  const apply = () => {
    if (!points.some((p) => p.id === r.receiver)) { setErr('Choose a contact point.'); return; }
    if (r.matchers.some((m) => !m.label.trim())) { setErr('Every matcher needs a label.'); return; }
    const badRe = r.matchers.find((m) => m.op.includes('~') && (() => { try { new RegExp(m.value); return false; } catch { return true; } })());
    if (badRe) { setErr(`"${badRe.value}" is not a valid regular expression.`); return; }
    const bad = [r.group_wait, r.group_interval, r.repeat_interval].find((v) => v && !isDuration(v));
    if (bad) { setErr(`"${bad}" is not a duration like 30s, 5m or 4h.`); return; }
    onApply({ ...r, matchers: r.matchers.map((m) => ({ ...m, label: m.label.trim() })) });
  };

  return (
    <Modal onClose={onClose} title={edit.isNew ? (edit.parent ? 'New nested policy' : 'New policy') : 'Edit policy'}
      subtitle="Alerts whose labels match every matcher are sent to this contact point. Changes are saved with the tree."
      footer={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" onClick={apply}>{edit.isNew ? 'Add policy' : 'Apply'}</button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <div className="field">
          <span className="lbl">Matching labels</span>
          {r.matchers.map((m, i) => (
            <div className="al-matcher" key={i}>
              <input aria-label={`Matcher ${i + 1} label`} value={m.label} placeholder="severity" onChange={(e) => setM(i, { label: e.target.value })} />
              <select aria-label={`Matcher ${i + 1} operator`} value={m.op} onChange={(e) => setM(i, { op: e.target.value as MatcherOp })}>
                {MATCH_OPS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
              <input aria-label={`Matcher ${i + 1} value`} value={m.value} placeholder={m.op.includes('~') ? 'critical|warning' : 'critical'} onChange={(e) => setM(i, { value: e.target.value })} />
              <button type="button" className="ghost icon" aria-label={`Remove matcher ${i + 1}`} onClick={() => set('matchers', r.matchers.filter((_, j) => j !== i))}><IconTrash size={13} /></button>
            </div>
          ))}
          <div className="btn-row">
            <button type="button" className="btn-sm" onClick={() => set('matchers', [...r.matchers, { label: '', op: '=', value: '' }])}><IconPlus size={13} />Add matcher</button>
            {r.matchers.length === 0 && <span className="hint">No matchers: this policy catches every alert that reaches it.</span>}
          </div>
          <span className="help"><code>=~</code> and <code>!~</code> take a regular expression that must match the whole value.</span>
        </div>

        <ReceiverSelect value={r.receiver} points={points} onChange={(v) => set('receiver', v)} />

        <label className="checkbox-label">
          <input type="checkbox" checked={r.continue} onChange={(e) => set('continue', e.target.checked)} />
          Continue matching sibling policies after this one
        </label>

        <details className="disclosure" open={!!(r.group_by || r.group_wait || r.group_interval || r.repeat_interval)}>
          <summary>Override grouping and timing</summary>
          <div className="stack-sm">
            <label className="checkbox-label">
              <input type="checkbox" checked={!!r.group_by} onChange={(e) => set('group_by', e.target.checked ? ['alertname'] : undefined)} />
              Override group by
            </label>
            {r.group_by && <ChipsInput label="Group by" values={r.group_by} onChange={(v) => set('group_by', v)} placeholder="alertname" />}
            <div className="form-grid">
              {timing('group_wait', 'Group wait', '30s')}
              {timing('group_interval', 'Group interval', '5m')}
              {timing('repeat_interval', 'Repeat interval', '4h')}
            </div>
          </div>
        </details>
        {err && <p className="hint err" role="alert">{err}</p>}
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------- tree view */

function RouteNode({ r, index, count, depth, names, onEdit, onAdd, onDelete, onMove }: {
  r: PolicyRoute; index: number; count: number; depth: number; names: Map<string, string>;
  onEdit: (r: PolicyRoute) => void; onAdd: (parent: string) => void; onDelete: (id: string) => void; onMove: (id: string, by: -1 | 1) => void;
}) {
  const overrides = [
    r.group_by && `group by ${r.group_by.join(', ') || '(nothing)'}`,
    r.group_wait && `wait ${r.group_wait}`,
    r.group_interval && `interval ${r.group_interval}`,
    r.repeat_interval && `repeat ${r.repeat_interval}`,
  ].filter(Boolean).join(' · ');
  const name = names.get(r.receiver);
  return (
    <li>
      <div className="al-route-card">
        <div className="al-route-main">
          <div className="row-tight">
            {r.matchers.length ? r.matchers.map((m, i) => <MatcherChip key={i} m={m} />) : <span className="hint">matches all alerts</span>}
          </div>
          <div className="row-tight">
            <span className="hint">→</span>
            {name ? <b>{name}</b> : <Badge kind="bad">missing contact point</Badge>}
            {r.continue && <Badge kind="info" title="Sibling policies are also evaluated after this one matches">continue</Badge>}
            {overrides && <span className="hint">{overrides}</span>}
          </div>
        </div>
        <div className="row-tight row-nowrap al-route-actions">
          <button type="button" className="ghost icon" disabled={index === 0} aria-label="Move up" title="Move up" onClick={() => onMove(r.id, -1)}>↑</button>
          <button type="button" className="ghost icon" disabled={index === count - 1} aria-label="Move down" title="Move down" onClick={() => onMove(r.id, 1)}>↓</button>
          <button type="button" className="ghost" onClick={() => onEdit(r)}>Edit</button>
          <button type="button" className="ghost" onClick={() => onAdd(r.id)}>Add nested</button>
          <button type="button" className="ghost icon" aria-label="Delete policy" title={r.routes.length ? 'Delete, with its nested policies' : 'Delete'}
            onClick={() => onDelete(r.id)}><IconTrash size={13} /></button>
        </div>
      </div>
      {r.routes.length > 0 && (
        <ul className="al-route-kids" aria-label="Nested policies">
          {r.routes.map((c, i) => (
            <RouteNode key={c.id} r={c} index={i} count={r.routes.length} depth={depth + 1} names={names}
              onEdit={onEdit} onAdd={onAdd} onDelete={onDelete} onMove={onMove} />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------- page */

export function NotificationPoliciesPage() {
  const version = useAlertingVersion();
  const pol = useAsync(() => api.getPolicies(), [version]);
  const cps = useAsync(() => api.listContactPoints(), [version]);
  const { toast } = useNotify();
  const [base, setBase] = useState<NotificationPolicy | null>(null);
  const [draft, setDraft] = useState<NotificationPolicy | null>(null);
  const [sync, setSync] = useState<Sync | null>(null);
  const [edit, setEdit] = useState<RouteEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dirty = !!draft && !!base && JSON.stringify(draft) !== JSON.stringify(base);

  // A reload (e.g. after Sync now) must not throw away unsaved edits.
  useEffect(() => {
    if (!pol.data) return;
    setSync(pol.data.sync);
    if (!dirty) { setBase(clone(pol.data.policy)); setDraft(clone(pol.data.policy)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pol.data]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const points = cps.data?.contact_points ?? [];
  const names = useMemo(() => new Map(points.map((p) => [p.id, p.name])), [points]);
  const known = useMemo(() => new Set(points.map((p) => p.id)), [points]);

  const setRoot = <K extends keyof NotificationPolicy>(k: K, v: NotificationPolicy[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setRoutes = (fn: (t: PolicyRoute[]) => PolicyRoute[]) => setDraft((d) => (d ? { ...d, routes: fn(d.routes) } : d));

  const startAdd = (parent: string | null) => setEdit({
    parent, isNew: true,
    route: { id: newId(), receiver: draft?.receiver ?? points[0]?.id ?? '', matchers: [{ label: 'severity', op: '=', value: 'critical' }], continue: false, routes: [] },
  });

  const applyEdit = (r: PolicyRoute) => {
    if (!edit) return;
    if (!edit.isNew) setRoutes((t) => replaceRoute(t, r));
    else if (edit.parent) setRoutes((t) => addChild(t, edit.parent!, r));
    else setRoutes((t) => [...t, r]);
    setEdit(null);
  };

  const save = async () => {
    if (!draft) return;
    const probs = problemsOf(draft, known);
    if (probs.length) { setErr(probs.join(' ')); return; }
    setBusy(true); setErr(null);
    try {
      const res = await api.putPolicies(draft);
      setBase(clone(res.policy)); setDraft(clone(res.policy)); setSync(res.sync);
      toast({ kind: res.sync.state === 'error' ? 'bad' : 'ok', title: 'Notification policies saved', body: res.sync.state === 'error' ? `Saved in Studio, but Grafana sync failed: ${res.sync.error ?? ''}` : undefined });
      void refreshAlertingStatus();
    } catch (e) { setErr(errMessage(e)); }
    finally { setBusy(false); }
  };

  const error = pol.error ?? cps.error;
  if (error) return <ErrorState error={error} what="notification policies" />;
  if (!draft || !cps.data) return <Spinner label="Loading notification policies" />;

  return (
    <>
      <div className={`al-savebar${dirty ? ' dirty' : ''}`} role="status">
        <span className="grow">
          {dirty ? <b>Unsaved changes to the policy tree.</b> : <span className="hint">All changes saved.</span>}
          {sync && <> <SyncBadge sync={sync} /></>}
        </span>
        <button type="button" className="btn-sm" disabled={!dirty || busy} onClick={() => { setDraft(clone(base)); setErr(null); }}>Discard</button>
        <button type="button" className="primary btn-sm" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save policies'}</button>
      </div>
      {err && <Callout kind="bad">{err}</Callout>}

      <Panel title="Default policy" subtitle="Every alert starts here; it is used when no nested policy below matches.">
        <div className="form-grid">
          <ReceiverSelect label="Default contact point" value={draft.receiver} points={points} onChange={(v) => setRoot('receiver', v)} />
          <ChipsInput label="Group by" values={draft.group_by} onChange={(v) => setRoot('group_by', v)} placeholder="alertname"
            help="Alerts sharing these label values are sent together. Enter or comma adds one." />
        </div>
        <div className="form-grid al-gap">
          {([['group_wait', 'Group wait', 'Wait before the first notification of a new group'],
            ['group_interval', 'Group interval', 'Wait before notifying about new alerts in a group'],
            ['repeat_interval', 'Repeat interval', 'Wait before re-sending a still-firing alert']] as const).map(([k, label, help]) => (
            <label className="field" key={k}><span className="lbl">{label}</span>
              <input value={draft[k]} onChange={(e) => setRoot(k, e.target.value)} aria-invalid={!isDuration(draft[k])} />
              <span className="help">{help}</span></label>
          ))}
        </div>
      </Panel>

      <Panel title="Nested policies" subtitle="Evaluated top to bottom; the first match wins unless it has continue."
        right={<button type="button" className="primary btn-sm" onClick={() => startAdd(null)}><IconPlus size={13} />New policy</button>}>
        {draft.routes.length === 0 ? (
          <EmptyState title="No nested policies">Every alert goes to the default contact point. Add a policy to route, say, <code>severity = critical</code> elsewhere.</EmptyState>
        ) : (
          <ul className="al-routes">
            {draft.routes.map((r, i) => (
              <RouteNode key={r.id} r={r} index={i} count={draft.routes.length} depth={0} names={names}
                onEdit={(route) => setEdit({ route, parent: null, isNew: false })}
                onAdd={(parent) => startAdd(parent)}
                onDelete={(id) => setRoutes((t) => removeRoute(t, id))}
                onMove={(id, by) => setRoutes((t) => moveRoute(t, id, by))} />
            ))}
          </ul>
        )}
      </Panel>

      {edit && <RouteDialog key={edit.route.id} edit={edit} points={points} onClose={() => setEdit(null)} onApply={applyEdit} />}
    </>
  );
}
