// Notification policies: the default policy plus a nested route tree, edited locally and saved
// as one PUT (CONTRACTS 13.3). Route ids are generated here and stay stable within the tree.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Badge, ErrorState, Panel, Spinner } from '../components/Bits';
import {
  IconAlert, IconArrowDown, IconArrowRight, IconArrowUp, IconCheck, IconNested, IconPencil, IconPlus, IconRoute, IconTrash,
} from '../components/Icons';
import { Modal } from '../components/Modal';
import { SyncBadge } from './AlertRulesPage';
import { useAlertingVersion } from './AlertingPage';
import { INTEGRATION, IntegrationIcon } from './ContactPointsPage';
import { api, errMessage } from '../lib/api';
import { isDuration, newId, refreshAlertingStatus } from '../lib/alerting';
import { useNotify } from '../lib/notify';
import { ROOT_ID, matcherOk, resolveTree, simulate } from '../lib/routing';
import type { Effective, NodeState, Simulation } from '../lib/routing';
import { useAsync } from '../lib/useAsync';
import type { ContactPoint, Matcher, MatcherOp, NotificationPolicy, PolicyRoute, Sync } from '../lib/types';
import '../styles/alerting-routing.css';

const MATCH_OPS: MatcherOp[] = ['=', '!=', '=~', '!~'];
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const DEFAULT_SELECT_ID = 'alr-default-receiver';

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

function indexRoutes(routes: PolicyRoute[], out = new Map<string, PolicyRoute>()): Map<string, PolicyRoute> {
  for (const r of routes) { out.set(r.id, r); indexRoutes(r.routes, out); }
  return out;
}

/** Everything that would make the PUT fail, found before sending it. An empty route receiver inherits. */
function problemsOf(p: NotificationPolicy, known: Set<string>): string[] {
  const out: string[] = [];
  if (!known.has(p.receiver)) out.push('The default policy needs a contact point.');
  for (const [k, v] of [['group wait', p.group_wait], ['group interval', p.group_interval], ['repeat interval', p.repeat_interval]]) {
    if (!isDuration(v)) out.push(`Default ${k} "${v}" is not a duration like 30s or 5m.`);
  }
  const walk = (routes: PolicyRoute[], depth: string) => routes.forEach((r, i) => {
    const where = `Route ${depth}${i + 1}`;
    if (r.receiver && !known.has(r.receiver)) out.push(`${where} sends to a contact point that no longer exists.`);
    if (r.matchers.some((m) => !m.label.trim())) out.push(`${where} has a matcher without a label.`);
    for (const v of [r.group_wait, r.group_interval, r.repeat_interval]) if (v && !isDuration(v)) out.push(`${where}: "${v}" is not a duration.`);
    walk(r.routes, `${depth}${i + 1}.`);
  });
  walk(p.routes, '');
  return out;
}

const matcherText = (m: Matcher) => `${m.label} ${m.op} ${m.value || '""'}`;

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

/** `inheritId` set (the parent's effective receiver): the route may leave the receiver empty and inherit it. */
function ReceiverSelect({ value, points, onChange, label = 'Contact point', inheritId, id }: {
  value: string; points: ContactPoint[]; onChange: (v: string) => void; label?: string; inheritId?: string; id?: string;
}) {
  const unknown = value && !points.some((p) => p.id === value);
  const inherited = inheritId !== undefined ? points.find((p) => p.id === inheritId) : undefined;
  const type = value ? points.find((p) => p.id === value)?.type : inherited?.type;
  return (
    <label className="field"><span className="lbl">{label}</span>
      <span className="alr-select-ic">
        <IntegrationIcon type={type} size={13} />
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {inheritId !== undefined ? <option value="">Inherit from parent ({inherited?.name ?? 'none'})</option>
            : !value && <option value="">Choose…</option>}
          {unknown && <option value={value}>Missing contact point ({value})</option>}
          {points.map((p) => {
            const kind = INTEGRATION[p.type]?.label ?? p.type;
            return <option key={p.id} value={p.id}>{p.name === kind ? p.name : `${p.name} (${kind})`}</option>;
          })}
        </select>
      </span>
    </label>
  );
}

/** `hit` undefined: no routing verdict to show for this matcher. */
const MatcherChip = ({ m, hit }: { m: Matcher; hit?: boolean }) => (
  <span className={`alr-mchip${hit === undefined ? '' : hit ? ' hit' : ' miss'}`}
    title={hit === undefined ? undefined : hit ? 'Matches the test labels' : 'Does not match the test labels'}>
    {hit !== undefined && <span className="sr-only">{hit ? 'matches: ' : 'does not match: '}</span>}
    <span className="k">{m.label}</span><span className="op">{m.op}</span><span className="v">{m.value || '""'}</span>
  </span>
);

/* ---------------------------------------------------------------- route dialog */

type RouteEdit = { route: PolicyRoute; parent: string | null; isNew: boolean; inherited: Effective };

function RouteDialog({ edit, points, onClose, onApply }: {
  edit: RouteEdit; points: ContactPoint[]; onClose: () => void; onApply: (r: PolicyRoute) => void;
}) {
  const [r, setR] = useState<PolicyRoute>(() => clone(edit.route));
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof PolicyRoute>(k: K, v: PolicyRoute[K]) => setR((x) => ({ ...x, [k]: v }));
  const setM = (i: number, m: Partial<Matcher>) => set('matchers', r.matchers.map((x, j) => (j === i ? { ...x, ...m } : x)));
  const timing = (k: 'group_wait' | 'group_interval' | 'repeat_interval', label: string) => (
    <label className="field"><span className="lbl">{label}</span>
      <input value={r[k] ?? ''} placeholder={`inherit (${edit.inherited[k]})`} aria-invalid={!!r[k] && !isDuration(r[k] ?? '')}
        onChange={(e) => set(k, e.target.value.trim() ? e.target.value : undefined)} /></label>
  );

  const apply = () => {
    if (!points.some((p) => p.id === (r.receiver || edit.inherited.receiver))) { setErr('Choose a contact point.'); return; }
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

        <ReceiverSelect value={r.receiver} points={points} onChange={(v) => set('receiver', v)} inheritId={edit.inherited.receiver} />

        <label className="checkbox-label">
          <input type="checkbox" checked={r.continue} onChange={(e) => set('continue', e.target.checked)} />
          Continue matching sibling policies after this one
        </label>

        <details className="disclosure" open={!!(r.group_by || r.group_wait || r.group_interval || r.repeat_interval)}>
          <summary>Override grouping and timing</summary>
          <div className="stack-sm">
            <label className="checkbox-label">
              <input type="checkbox" checked={!!r.group_by} onChange={(e) => set('group_by', e.target.checked ? [...edit.inherited.group_by] : undefined)} />
              Override group by <span className="faint">(inherits {edit.inherited.group_by.join(', ') || 'nothing'})</span>
            </label>
            {r.group_by && <ChipsInput label="Group by" values={r.group_by} onChange={(v) => set('group_by', v)} placeholder="alertname" />}
            <div className="form-grid">
              {timing('group_wait', 'Group wait')}
              {timing('group_interval', 'Group interval')}
              {timing('repeat_interval', 'Repeat interval')}
            </div>
          </div>
        </details>
        {err && <p className="hint err" role="alert">{err}</p>}
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------- tree view */

interface TreeCtx {
  points: Map<string, ContactPoint>;
  resolved: ReturnType<typeof resolveTree>;
  states: Map<string, NodeState> | null;     // null: routing highlight off
  labels: Record<string, string>;
  onEdit: (r: PolicyRoute) => void;
  onAdd: (parent: string | null) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, by: -1 | 1) => void;
  onEditRoot: () => void;
}

const STATE_BADGE: Partial<Record<NodeState, { cls: string; text: string; title: string }>> = {
  delivers: { cls: 'alr-state deliver', text: 'receives alert', title: 'The test alert is delivered from this policy' },
  matched: { cls: 'alr-state pass', text: 'matched', title: 'Matched; a nested policy handles the alert' },
  skipped: { cls: 'alr-state skip', text: 'not reached', title: 'An earlier sibling matched without continue, so this policy is not evaluated' },
};

function Timings({ own, eff, rootNode }: { own: Partial<PolicyRoute>; eff: Effective; rootNode: boolean }) {
  const items: [string, string, boolean, string][] = [
    ['group by', eff.group_by.join(', ') || 'nothing', rootNode || own.group_by != null, 'Alerts sharing these labels are batched'],
    ['wait', eff.group_wait, rootNode || !!own.group_wait, 'Group wait: before the first notification of a new group'],
    ['interval', eff.group_interval, rootNode || !!own.group_interval, 'Group interval: before notifying about new alerts in a group'],
    ['repeat', eff.repeat_interval, rootNode || !!own.repeat_interval, 'Repeat interval: before re-sending a still-firing alert'],
  ];
  return (
    <div className="alr-timings">
      {items.map(([k, v, set, help]) => (
        <span key={k} className={`alr-tm${set ? ' own' : ''}`} title={`${help}${set ? '' : ' (inherited)'}`}>
          <span className="k">{k}</span> <span className="v">{v}</span>
          {!set && <span className="sr-only"> (inherited)</span>}
        </span>
      ))}
    </div>
  );
}

function Destination({ receiver, eff, ctx }: { receiver: string; eff: Effective; ctx: TreeCtx }) {
  const target = ctx.points.get(eff.receiver);
  if (!target) return <div className="alr-dest"><IconArrowRight size={14} /><Badge kind="bad">missing contact point</Badge></div>;
  return (
    <div className={`alr-dest${receiver ? '' : ' inherited'}`}>
      <IconArrowRight size={14} />
      {!receiver && <span className="alr-dest-inh">inherits</span>}
      <IntegrationIcon type={target.type} size={13} />
      <span className="alr-dest-name">{target.name}</span>
    </div>
  );
}

function NodeCard({ r, index, count, ctx, parentState }: {
  r: PolicyRoute | null; index: number; count: number; ctx: TreeCtx; parentState?: NodeState;
}) {
  const id = r ? r.id : ROOT_ID;
  const eff = ctx.resolved.get(id)?.own;
  const state = ctx.states?.get(id);
  const evaluated = state === 'delivers' || state === 'matched' || state === 'nomatch';
  // "Not reached" only where a sibling stopped the walk, not under every non-matching branch.
  const badge = state && (state !== 'skipped' || parentState === 'matched') ? STATE_BADGE[state] : undefined;
  if (!eff) return null;
  return (
    <div id={`alr-node-${id}`} className={`alr-node${r ? '' : ' root'}${state ? ` is-${state}` : ''}`}>
      <div className="alr-node-head">
        <div className="alr-node-match">
          {r ? (
            r.matchers.length
              ? r.matchers.map((m, i) => <MatcherChip key={i} m={m} hit={ctx.states && evaluated ? matcherOk(m, ctx.labels) : undefined} />)
              : <span className="alr-all">every alert</span>
          ) : (
            <><span className="alr-node-title">Default policy</span><span className="alr-all">every alert starts here</span></>
          )}
          {r?.continue && <span className="alr-continue" title="Sibling policies below are also evaluated after this one matches">continue</span>}
          {badge && <span className={badge.cls} title={badge.title}>{state === 'delivers' && <IconCheck size={12} />}{badge.text}</span>}
        </div>
        <div className="alr-actions" role="group" aria-label={r ? `Policy ${index + 1} actions` : 'Default policy actions'}>
          {r ? (
            <>
              <button type="button" className="ghost icon" disabled={index === 0} aria-label="Move up" title="Move up" onClick={() => ctx.onMove(r.id, -1)}><IconArrowUp size={15} /></button>
              <button type="button" className="ghost icon" disabled={index === count - 1} aria-label="Move down" title="Move down" onClick={() => ctx.onMove(r.id, 1)}><IconArrowDown size={15} /></button>
              <button type="button" className="ghost icon" aria-label="Edit policy" title="Edit" onClick={() => ctx.onEdit(r)}><IconPencil size={15} /></button>
              <button type="button" className="ghost icon" aria-label="Add nested policy" title="Add nested policy" onClick={() => ctx.onAdd(r.id)}><IconNested size={15} /></button>
              <button type="button" className="ghost icon alr-danger" aria-label="Delete policy"
                title={r.routes.length ? 'Delete, with its nested policies' : 'Delete'} onClick={() => ctx.onDelete(r.id)}><IconTrash size={15} /></button>
            </>
          ) : (
            <>
              <button type="button" className="ghost icon" aria-label="Edit default policy" title="Edit default policy" onClick={ctx.onEditRoot}><IconPencil size={15} /></button>
              <button type="button" className="ghost icon" aria-label="Add policy" title="Add policy" onClick={() => ctx.onAdd(null)}><IconNested size={15} /></button>
            </>
          )}
        </div>
      </div>
      <Destination receiver={r ? r.receiver : eff.receiver} eff={eff} ctx={ctx} />
      <Timings own={r ?? {}} eff={eff} rootNode={!r} />
    </div>
  );
}

function Branch({ r, index, count, ctx, parentState }: {
  r: PolicyRoute; index: number; count: number; ctx: TreeCtx; parentState?: NodeState;
}) {
  const state = ctx.states?.get(r.id);
  const onPath = state === 'matched' || state === 'delivers';
  return (
    <li className={`alr-branch${onPath ? ' on-path' : ''}`}>
      <NodeCard r={r} index={index} count={count} ctx={ctx} parentState={parentState} />
      {r.routes.length > 0 && (
        <ul className="alr-kids" aria-label="Nested policies">
          {r.routes.map((c, i) => <Branch key={c.id} r={c} index={i} count={r.routes.length} ctx={ctx} parentState={state} />)}
        </ul>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------- routing preview */

type LabelRow = { k: string; v: string };

function RoutingPreview({ rows, setRows, sim, points, routes, highlight, setHighlight }: {
  rows: LabelRow[]; setRows: (r: LabelRow[]) => void; sim: Simulation; points: Map<string, ContactPoint>;
  routes: Map<string, PolicyRoute>; highlight: boolean; setHighlight: (v: boolean) => void;
}) {
  const version = useAlertingVersion();
  const rules = useAsync(() => api.listAlertRules(), [version]);
  const setRow = (i: number, p: Partial<LabelRow>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const fromRule = (id: string) => {
    const r = rules.data?.rules.find((x) => x.id === id);
    if (!r) return;
    const all: Record<string, string> = { alertname: r.name, severity: r.severity, ...r.labels };
    setRows(Object.entries(all).map(([k, v]) => ({ k, v })));
  };

  const hops = (path: string[]) => ['Default', ...path.map((id) => {
    const r = routes.get(id);
    return r ? (r.matchers.map(matcherText).join(', ') || 'every alert') : '?';
  })];

  return (
    <Panel className="alr-test" title={<><IconRoute size={16} />Test routing</>} subtitle="Uses the tree as edited, saved or not">
      <div className="field">
        <span className="lbl" id="alr-test-lbl">Alert labels</span>
        <div className="alr-labelrows" role="group" aria-labelledby="alr-test-lbl">
          {rows.map((l, i) => (
            <div className="alr-labelrow" key={i}>
              <input aria-label={`Label ${i + 1} name`} value={l.k} placeholder="label" onChange={(e) => setRow(i, { k: e.target.value })} />
              <span className="alr-eq" aria-hidden="true">=</span>
              <input aria-label={`Label ${i + 1} value`} value={l.v} placeholder="value" onChange={(e) => setRow(i, { v: e.target.value })} />
              <button type="button" className="ghost icon" aria-label={`Remove label ${i + 1}`} title="Remove"
                onClick={() => setRows(rows.filter((_, j) => j !== i))}><IconTrash size={13} /></button>
            </div>
          ))}
        </div>
        <div className="alr-test-tools">
          <button type="button" className="btn-sm" onClick={() => setRows([...rows, { k: '', v: '' }])}><IconPlus size={13} />Add label</button>
          {!!rules.data?.rules.length && (
            <select className="alr-fill" aria-label="Fill labels from an alert rule" value="" onChange={(e) => fromRule(e.target.value)}>
              <option value="">Fill from rule…</option>
              {rules.data.rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="alr-result" aria-live="polite">
        <div className="alr-result-h">
          Delivered to {sim.deliveries.length} contact point{sim.deliveries.length === 1 ? '' : 's'}
        </div>
        <ol className="alr-deliveries">
          {sim.deliveries.map((d, i) => {
            const cp = points.get(d.receiver);
            return (
              <li key={`${d.routeId}-${i}`} className="alr-delivery">
                <IntegrationIcon type={cp?.type} size={16} />
                <div className="alr-delivery-main">
                  <b>{cp?.name ?? 'Missing contact point'}</b>
                  <span className="alr-hops">{hops(d.path).map((h, j) => <span key={j} className="alr-hop">{h}</span>)}</span>
                  <span className="alr-delivery-t">
                    group by {d.group_by.join(', ') || 'nothing'} · wait {d.group_wait} · interval {d.group_interval} · repeat {d.repeat_interval}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
        {sim.deliveries[0]?.routeId === ROOT_ID && (
          <p className="hint">No nested policy matched, so the default policy handles it.</p>
        )}
      </div>
      <label className="checkbox-label">
        <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} />
        Highlight the route in the tree
      </label>
    </Panel>
  );
}

const labelsOf = (rows: LabelRow[]): Record<string, string> =>
  Object.fromEntries(rows.filter((l) => l.k.trim()).map((l) => [l.k.trim(), l.v]));

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
  const [rows, setRows] = useState<LabelRow[]>([{ k: 'severity', v: 'critical' }, { k: 'alertname', v: 'Example' }]);
  const [highlight, setHighlight] = useState(true);
  const defaultsRef = useRef<HTMLElement | null>(null);

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

  const points = useMemo(() => cps.data?.contact_points ?? [], [cps.data]);
  const pointMap = useMemo(() => new Map(points.map((p) => [p.id, p])), [points]);
  const known = useMemo(() => new Set(points.map((p) => p.id)), [points]);
  const resolved = useMemo(() => (draft ? resolveTree(draft) : null), [draft]);
  const routeMap = useMemo(() => indexRoutes(draft?.routes ?? []), [draft]);
  const labels = useMemo(() => labelsOf(rows), [rows]);
  const sim = useMemo(() => (draft ? simulate(draft, labels) : null), [draft, labels]);

  const setRoot = <K extends keyof NotificationPolicy>(k: K, v: NotificationPolicy[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setRoutes = (fn: (t: PolicyRoute[]) => PolicyRoute[]) => setDraft((d) => (d ? { ...d, routes: fn(d.routes) } : d));
  const effOf = (id: string) => resolved?.get(id)?.own ?? resolved?.get(ROOT_ID)?.own;

  const startAdd = (parent: string | null) => {
    const inherited = effOf(parent ?? ROOT_ID);
    if (!inherited) return;
    setEdit({ parent, isNew: true, inherited, route: { id: newId(), receiver: '', matchers: [{ label: 'severity', op: '=', value: 'critical' }], continue: false, routes: [] } });
  };
  const startEdit = (route: PolicyRoute) => {
    const inherited = resolved?.get(route.id)?.parent;
    if (inherited) setEdit({ route, parent: null, isNew: false, inherited });
  };
  const focusDefaults = () => {
    defaultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById(DEFAULT_SELECT_ID)?.focus({ preventScroll: true });
  };

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
  if (!draft || !cps.data || !resolved || !sim) return <Spinner label="Loading notification policies" />;

  const ctx: TreeCtx = {
    points: pointMap, resolved, states: highlight ? sim.states : null, labels,
    onEdit: startEdit, onAdd: startAdd, onEditRoot: focusDefaults,
    onDelete: (id) => setRoutes((t) => removeRoute(t, id)),
    onMove: (id, by) => setRoutes((t) => moveRoute(t, id, by)),
  };
  const timingFields = [
    ['group_wait', 'Group wait', 'Before the first notification of a new group'],
    ['group_interval', 'Group interval', 'Before notifying about new alerts in a group'],
    ['repeat_interval', 'Repeat interval', 'Before re-sending a still-firing alert'],
  ] as const;

  return (
    <>
      <section ref={defaultsRef} className="panel alr-defaults" aria-labelledby="alr-defaults-h">
        <header>
          <div className="panel-title"><span id="alr-defaults-h">Default policy</span>
            <span className="panel-sub">Used when no nested policy matches; nested policies inherit what they leave unset.</span></div>
        </header>
        <div className="panel-body">
          <div className="alr-defaults-a">
            <ReceiverSelect id={DEFAULT_SELECT_ID} label="Default contact point" value={draft.receiver} points={points} onChange={(v) => setRoot('receiver', v)} />
            <ChipsInput label="Group by" values={draft.group_by} onChange={(v) => setRoot('group_by', v)} placeholder="alertname"
              help="Alerts sharing these label values are sent together. Enter or comma adds one." />
          </div>
          <div className="alr-defaults-b">
            {timingFields.map(([k, label, help]) => (
              <label className="field" key={k}><span className="lbl">{label}</span>
                <input value={draft[k]} onChange={(e) => setRoot(k, e.target.value)} aria-invalid={!isDuration(draft[k])} />
                <span className="help">{help}</span></label>
            ))}
          </div>
        </div>
      </section>

      <div className="alr-layout">
        <Panel className="alr-tree-panel" title="Policy tree" subtitle="Top to bottom; the first match wins unless it has continue."
          right={<>{sync && <SyncBadge sync={sync} />}<button type="button" className="primary btn-sm" onClick={() => startAdd(null)}><IconPlus size={13} />New policy</button></>}>
          <div className="alr-tree">
            <NodeCard r={null} index={0} count={1} ctx={ctx} />
            {draft.routes.length > 0 ? (
              <ul className="alr-kids" aria-label="Nested policies">
                {draft.routes.map((r, i) => <Branch key={r.id} r={r} index={i} count={draft.routes.length} ctx={ctx} parentState={ctx.states?.get(ROOT_ID)} />)}
              </ul>
            ) : (
              <p className="hint alr-tree-empty">No nested policies: every alert goes to the default contact point. Add one to route, say, <code>severity = critical</code> elsewhere.</p>
            )}
          </div>
        </Panel>

        <RoutingPreview rows={rows} setRows={setRows} sim={sim} points={pointMap} routes={routeMap}
          highlight={highlight} setHighlight={setHighlight} />
      </div>

      <div className={dirty || err ? 'alr-savebar' : 'sr-only'} role="status">
        {dirty || err ? (
          <>
            <IconAlert size={16} />
            <div className="alr-savebar-text">
              {dirty ? <><b>Unsaved changes</b><span>The routing preview already uses them. Save to push the tree to Grafana.</span></>
                : <b>Not saved</b>}
              {err && <span className="alr-savebar-err" role="alert">{err}</span>}
            </div>
            <button type="button" className="btn-sm" disabled={!dirty || busy} onClick={() => { setDraft(clone(base)); setErr(null); }}>Discard</button>
            <button type="button" className="primary btn-sm" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save policies'}</button>
          </>
        ) : 'All changes saved.'}
      </div>

      {edit && <RouteDialog key={edit.route.id} edit={edit} points={points} onClose={() => setEdit(null)} onApply={applyEdit} />}
    </>
  );
}
