// Alerting helpers shared by the alerting pages, the sidebar badge and the Grafana deep links
// (CONTRACTS section 13). One cached /alerting/status snapshot feeds every consumer.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { IconExternal } from '../components/Icons';
import { api, errMessage } from './api';
import type { AlertingStatus, AlertOp, AlertRule } from './types';

/* ---------------------------------------------------------------- status store */

interface StatusSnap { status: AlertingStatus | null; error: string | null; loaded: boolean }

let snap: StatusSnap = { status: null, error: null, loaded: false };
let inflight: Promise<AlertingStatus | null> | null = null;
const subs = new Set<() => void>();

const publish = (next: StatusSnap) => { snap = next; subs.forEach((f) => f()); };

/** Re-fetch the status; concurrent callers share one request. A failure keeps the last good value. */
export function refreshAlertingStatus(): Promise<AlertingStatus | null> {
  inflight ??= api.alertingStatus().then(
    (s) => { publish({ status: s, error: null, loaded: true }); return s; },
    (e) => { publish({ status: snap.status, error: errMessage(e), loaded: true }); return null; },
  ).finally(() => { inflight = null; });
  return inflight;
}

/** For callers that already hold a fresh status, e.g. the response of POST /alerting/sync. */
export function setAlertingStatus(s: AlertingStatus): void { publish({ status: s, error: null, loaded: true }); }

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const getSnap = () => snap;

/** Cached alerting status; fetched once on first use, refreshed by whoever calls refreshAlertingStatus. */
export function useAlertingStatus(): StatusSnap {
  const s = useSyncExternalStore(subscribe, getSnap);
  useEffect(() => { if (!snap.loaded) void refreshAlertingStatus(); }, []);
  return s;
}

/* ---------------------------------------------------------------- Grafana deep links */

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** CONTRACTS 13.5. Null when Grafana is not configured, so no dead links are shown. */
export function grafanaEventUrl(s: AlertingStatus | null, eventUid: string): string | null {
  if (!s?.grafana.url || !s.grafana.public_url) return null;
  return `${trimSlash(s.grafana.public_url)}/d/aletheia-logs/aletheia-logs?var-event_uid=${encodeURIComponent(eventUid)}`;
}

export const grafanaAlertingUrl = (s: AlertingStatus): string => `${trimSlash(s.grafana.public_url)}/alerting/list`;

/** Small "Open in Grafana" link for one event; renders nothing when status is unavailable. */
export function GrafanaEventLink({ eventUid, label = 'Grafana', className = 'btn ghost sm' }: {
  eventUid: string; label?: string; className?: string;
}) {
  const { status } = useAlertingStatus();
  const href = grafanaEventUrl(status, eventUid);
  if (!href) return null;
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer"
      title="Open this event's raw log in the Grafana Loki dashboard" onClick={(e) => e.stopPropagation()}>
      <IconExternal size={13} />{label}
    </a>
  );
}

/* ---------------------------------------------------------------- browser notifications */

export type NotifPermission = NotificationPermission | 'unsupported';

export const notifSupported = (): boolean => typeof window !== 'undefined' && 'Notification' in window;
export const notifPermission = (): NotifPermission => (notifSupported() ? Notification.permission : 'unsupported');

/** Current permission plus a request function; call `request` only from a click (user gesture). */
export function useNotificationPermission(): { perm: NotifPermission; request: () => Promise<void> } {
  const [perm, setPerm] = useState<NotifPermission>(notifPermission);
  // The user can change it in site settings at any time; re-read when the tab regains focus.
  useEffect(() => {
    const sync = () => setPerm(notifPermission());
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);
  const request = useCallback(async () => {
    if (!notifSupported()) return;
    try { setPerm(await Notification.requestPermission()); } catch { setPerm(notifPermission()); }
  }, []);
  return { perm, request };
}

/* ---------------------------------------------------------------- formatting */

export const OP_SYMBOL: Record<AlertOp, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '==', ne: '!=' };

/** `last() > 100 for 5m`: the rule's condition in one line. */
export function conditionText(r: Pick<AlertRule, 'reducer' | 'condition' | 'for'>): string {
  const pend = r.for && !/^0+[a-z]*$/i.test(r.for) ? ` for ${r.for}` : '';
  return `${r.reducer}() ${OP_SYMBOL[r.condition.op]} ${r.condition.threshold}${pend}`;
}

/** "12s ago", "5m ago"; the full timestamp belongs in a title attribute. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Go duration as Grafana accepts it: "30s", "5m", "1h30m". */
export const isDuration = (v: string): boolean => /^(\d+(ms|s|m|h|d|w|y))+$/.test(v.trim());

/** Client-side id for policy routes (CONTRACTS 13.2: stable within the tree). */
export function newId(): string {
  try { if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID(); } catch { /* insecure origin */ }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const fmtValue = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : Number.isInteger(v) ? v.toLocaleString() : v.toPrecision(4).replace(/\.?0+$/, '');
