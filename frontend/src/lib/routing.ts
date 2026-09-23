// Client-side twin of backend/studio/alerting/router.py (Alertmanager semantics), so the policy
// page can preview routing against the current, possibly unsaved, tree. Pure functions only.
import type { Matcher, NotificationPolicy, PolicyRoute } from './types';

/** Key used for the default (root) policy in every map below. */
export const ROOT_ID = '#root';

const TIMINGS = ['group_wait', 'group_interval', 'repeat_interval'] as const;
export type TimingKey = (typeof TIMINGS)[number];

/** A node's settings after inheritance; `receiver` may be "" only if the root has none. */
export interface Effective {
  receiver: string;
  group_by: string[];
  group_wait: string;
  group_interval: string;
  repeat_interval: string;
}

export interface Delivery extends Effective {
  routeId: string;   // ROOT_ID when no nested policy matched
  path: string[];    // route ids from the first level down to routeId
}

/** delivers: handles the alert; matched: passed through to a child; nomatch: evaluated, failed; skipped: never evaluated. */
export type NodeState = 'delivers' | 'matched' | 'nomatch' | 'skipped';

export interface Simulation {
  deliveries: Delivery[];
  states: Map<string, NodeState>;
}

/** Anchored like Alertmanager (Python re.fullmatch); a bad pattern never matches, for =~ and !~ alike. */
export function matcherOk(m: Matcher, labels: Record<string, string>): boolean {
  const got = labels[m.label] ?? '';        // a missing label matches as ""
  const want = m.value ?? '';
  if (m.op === '=') return got === want;
  if (m.op === '!=') return got !== want;
  let hit: boolean;
  try { hit = new RegExp(`^(?:${want})$`).test(got); } catch { return false; }
  return m.op === '=~' ? hit : !hit;
}

export const routeMatches = (r: PolicyRoute, labels: Record<string, string>): boolean =>
  r.matchers.every((m) => matcherOk(m, labels));

export function rootEffective(p: NotificationPolicy): Effective {
  return {
    receiver: p.receiver, group_by: [...p.group_by],
    group_wait: p.group_wait, group_interval: p.group_interval, repeat_interval: p.repeat_interval,
  };
}

/** Unset (empty) fields fall back to the parent's effective value. */
export function inherit(r: PolicyRoute, parent: Effective): Effective {
  const out: Effective = {
    receiver: r.receiver || parent.receiver,
    group_by: r.group_by != null ? [...r.group_by] : [...parent.group_by],
    group_wait: parent.group_wait, group_interval: parent.group_interval, repeat_interval: parent.repeat_interval,
  };
  for (const k of TIMINGS) if (r[k]) out[k] = r[k] as string;
  return out;
}

/** Every route's own and parent effective settings, keyed by route id (root under ROOT_ID). */
export function resolveTree(p: NotificationPolicy): Map<string, { own: Effective; parent: Effective | null }> {
  const root = rootEffective(p);
  const out = new Map<string, { own: Effective; parent: Effective | null }>([[ROOT_ID, { own: root, parent: null }]]);
  const walk = (routes: PolicyRoute[], parent: Effective) => routes.forEach((r) => {
    const own = inherit(r, parent);
    out.set(r.id, { own, parent });
    walk(r.routes, own);
  });
  walk(p.routes, root);
  return out;
}

/** Depth-first; the first matching child wins unless it sets `continue`; no matching child means the node delivers. */
export function simulate(p: NotificationPolicy, labels: Record<string, string>): Simulation {
  const states = new Map<string, NodeState>();
  const skip = (routes: PolicyRoute[]) => routes.forEach((r) => { states.set(r.id, 'skipped'); skip(r.routes); });

  const walk = (id: string, routes: PolicyRoute[], here: Effective, path: string[]): Delivery[] => {
    const out: Delivery[] = [];
    let stopped = false;
    for (const child of routes) {
      if (stopped) { states.set(child.id, 'skipped'); skip(child.routes); continue; }
      if (!routeMatches(child, labels)) { states.set(child.id, 'nomatch'); skip(child.routes); continue; }
      out.push(...walk(child.id, child.routes, inherit(child, here), [...path, child.id]));
      if (!child.continue) stopped = true;
    }
    if (out.length) { states.set(id, 'matched'); return out; }
    states.set(id, 'delivers');
    return [{ ...here, routeId: id, path }];
  };

  return { deliveries: walk(ROOT_ID, p.routes, rootEffective(p), []), states };
}

/** How many policies (default included) name each contact point explicitly. */
export function receiverUsage(p: NotificationPolicy): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (id: string) => { if (id) out.set(id, (out.get(id) ?? 0) + 1); };
  bump(p.receiver);
  const walk = (routes: PolicyRoute[]) => routes.forEach((r) => { bump(r.receiver); walk(r.routes); });
  walk(p.routes);
  return out;
}
