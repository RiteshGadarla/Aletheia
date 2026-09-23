// Alerting helpers shared by the alerting pages, the sidebar badge and the Grafana deep links
// (CONTRACTS section 13). One cached /alerting/status snapshot feeds every consumer.
import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode, SVGProps } from 'react';
import { IconExternal } from '../components/Icons';
import grafanaIcon from '../assets/grafana-icon.webp';
import { api, errMessage } from './api';
import type { AlertingStatus, AlertOp, AlertRule, NotificationPolicy, PolicyRoute } from './types';

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

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Receive time in epoch ms from an event_uid: its first 10 chars are the ULID's 48-bit timestamp. */
export function ulidMs(uid: string): number | null {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(uid)) return null;
  let ms = 0;
  for (const c of uid.slice(0, 10).toUpperCase()) ms = ms * 32 + CROCKFORD.indexOf(c);
  return ms;
}

/** What the event dashboard needs beyond the uid; without it the raw line panel stays empty. */
export type GrafanaEventRef = { source_id?: string; raw_sha256?: string };

const EVENT_WINDOW_MS = 2 * 60_000;

/** CONTRACTS 13.5: the single-event dashboard, over two minutes either side of receipt. Null when Grafana is not configured. */
export function grafanaEventUrl(s: AlertingStatus | null, eventUid: string, ref?: GrafanaEventRef): string | null {
  if (!s?.grafana.url || !s.grafana.public_url) return null;
  const q = new URLSearchParams({ 'var-event_uid': eventUid });
  if (ref?.source_id) q.set('var-source_id', ref.source_id);
  if (ref?.raw_sha256) q.set('var-raw_sha256', ref.raw_sha256.toLowerCase());
  const t = ulidMs(eventUid);
  if (t !== null) { q.set('from', String(t - EVENT_WINDOW_MS)); q.set('to', String(t + EVENT_WINDOW_MS)); }
  return `${trimSlash(s.grafana.public_url)}/d/aletheia-event/aletheia-event?${q}`;
}

export const grafanaAlertingUrl = (s: AlertingStatus): string => `${trimSlash(s.grafana.public_url)}/alerting/list`;

/** The rule's page in Grafana; null when Grafana is not configured. */
export const grafanaRuleUrl = (s: AlertingStatus | null, id: string): string | null =>
  s?.grafana.url ? `${trimSlash(s.grafana.public_url)}/alerting/grafana/${encodeURIComponent(id)}/view` : null;

/** The Loki logs dashboard (CONTRACTS 13.5), for exploring what a Loki rule counts. */
export const grafanaLogsUrl = (s: AlertingStatus | null): string | null =>
  s?.grafana.url ? `${trimSlash(s.grafana.public_url)}/d/aletheia-logs/aletheia-logs` : null;

/** The Overview page's Grafana twin, from Loki and Prometheus; null when Grafana is not configured. */
export const grafanaOverviewUrl = (s: AlertingStatus | null): string | null =>
  s?.grafana.url ? `${trimSlash(s.grafana.public_url)}/d/aletheia-overview/aletheia-overview` : null;

/** Grafana's mark, bundled so it loads offline; decorative, the link text names Grafana. */
export function GrafanaLogo({ size = 16 }: { size?: number }) {
  return <img className="grafana-logo" src={grafanaIcon} width={size} height={size} alt="" aria-hidden="true" />;
}

/** Small "Open in Grafana" link for one event; renders nothing when status is unavailable.
 *  `plain` drops the Grafana mark for a bare redirect icon, for dense rows where the brand mark is noise. */
export function GrafanaEventLink({ eventUid, event, label = 'Grafana', className = 'btn ghost sm', plain = false }: {
  eventUid: string; event?: GrafanaEventRef; label?: string; className?: string; plain?: boolean;
}) {
  const { status } = useAlertingStatus();
  const href = grafanaEventUrl(status, eventUid, event);
  if (!href) return null;
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer"
      title="Open this event in Grafana: its fields, raw line and what its source sent around it" onClick={(e) => e.stopPropagation()}>
      {plain ? <IconExternal size={13} /> : <GrafanaLogo size={14} />}{label}
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

const OP_WORDS: Record<AlertOp, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', ne: '≠' };

/** "Fires when last() of the query is > 100 for 5m, checked every 1m." as rich text. */
export function conditionSentence(r: Pick<AlertRule, 'reducer' | 'condition' | 'for' | 'interval'>): ReactNode {
  const pend = r.for && !/^0+[a-z]*$/i.test(r.for);
  return (
    <>
      Fires {pend ? 'when' : 'as soon as'} <b>{r.reducer}()</b> of the query is{' '}
      <b>{OP_WORDS[r.condition.op]} {fmtValue(r.condition.threshold)}</b>
      {pend && <> for <b>{r.for}</b></>}, checked every <b>{r.interval || '1m'}</b>.
    </>
  );
}

const TPL = /\{\{-?\s*([^}]*?)\s*-?\}\}/g;

/** Friendly name for one Grafana template expression: `$values.B` -> value, `$labels.source` -> source. */
function tplName(expr: string): string {
  const m = /\$labels\.([\w]+)/.exec(expr);
  if (m) return m[1];
  if (/\$values?\b/.test(expr)) return 'value';
  const last = /([\w]+)\s*$/.exec(expr);
  return last ? last[1] : '…';
}

/** Summary text with `{{ ... }}` rendered as quiet inline tokens (the raw template is in the title). */
export function TemplateText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(TPL)) {
    const i = m.index ?? 0;
    if (i > at) out.push(<Fragment key={`t${at}`}>{text.slice(at, i)}</Fragment>);
    out.push(
      <span key={`v${i}`} className="al-tpl" title={`${m[0]}: filled in when the alert fires`}>‹{tplName(m[1])}›</span>,
    );
    at = i + m[0].length;
  }
  if (at < text.length) out.push(<Fragment key={`t${at}`}>{text.slice(at)}</Fragment>);
  return <>{out}</>;
}

/** Number of routes in the policy tree, nested ones included (the root is not counted). */
export function countRoutes(p: NotificationPolicy | PolicyRoute): number {
  return p.routes.reduce((n, r) => n + 1 + countRoutes(r), 0);
}

/* ---------------------------------------------------------------- icons local to alerting */

type IP = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IP) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const IconEdit = (p: IP) => <Svg {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></Svg>;
export const IconPause = (p: IP) => <Svg {...p}><path d="M9 5v14M15 5v14" /></Svg>;
export const IconPlay = (p: IP) => <Svg {...p}><path d="M7 5l12 7-12 7z" /></Svg>;
export const IconSend = (p: IP) => <Svg {...p}><path d="M21 3L10 14" /><path d="M21 3l-7 18-4-7-7-4z" /></Svg>;
export const IconRoute = (p: IP) => (
  <Svg {...p}><circle cx="6" cy="5" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M6 12h10" /></Svg>
);
export const IconFolder = (p: IP) => <Svg {...p}><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></Svg>;
export const IconBolt = (p: IP) => <Svg {...p}><path d="M13 3L5 13h6l-1 8 8-10h-6z" /></Svg>;
