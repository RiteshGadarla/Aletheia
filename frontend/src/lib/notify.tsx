// In-app notifications: toasts, plus a watcher that announces sources that are ready to approve.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import type { AlertNotification, SourceInfo } from './types';
import { notifSupported, refreshAlertingStatus } from './alerting';

export interface ToastIn {
  kind?: 'ok' | 'info' | 'bad'; title: string; body?: string;
  action?: { label: string; to: string }; sticky?: boolean;
  /** Source ids this toast is about; it closes once none of them is still in review. */
  review?: string[];
}
interface Toast extends ToastIn { id: number }
interface Ctx { toast: (t: ToastIn) => void; pending: SourceInfo[] }

const NotifyCtx = createContext<Ctx>({ toast: () => {}, pending: [] });
export const useNotify = () => useContext(NotifyCtx);

const SEEN_KEY = 'aletheia.review.notified';
const loadSeen = (): Set<string> => {
  try { return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]') as string[]); } catch { return new Set(); }
};
const saveSeen = (s: Set<string>) => { try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s])); } catch { /* private mode */ } };

let nextId = 0;

// A toast that survives a full page reload, shown once by the next NotifyProvider mount.
const FLASH_KEY = 'aletheia.flash';

/** Reload the app at `to` (fresh state, no stale pollers) and show `t` once it is back. */
export function reloadWithToast(t: ToastIn, to: string = window.location.pathname): void {
  try { sessionStorage.setItem(FLASH_KEY, JSON.stringify(t)); } catch { /* private mode: reload anyway */ }
  window.location.replace(to);
}

// Alert deliveries to the Browser contact point (CONTRACTS 13.3). The last seen id survives reloads
// in this tab, so old alerts are never replayed.
const ALERT_KEY = 'aletheia.alerting.lastId';
const ALERTS_PAGE = '/dashboard/alerting/rules';
const loadAlertId = (): number | null => {
  try { const v = sessionStorage.getItem(ALERT_KEY); return v === null ? null : Number(v); } catch { return null; }
};
const saveAlertId = (id: number) => { try { sessionStorage.setItem(ALERT_KEY, String(id)); } catch { /* private mode */ } };

const alertTitle = (n: AlertNotification): string =>
  n.source === 'test' ? `Test: ${n.contact_point_name}`
    : n.status === 'resolved' ? `Resolved: ${n.rule_name}` : `Firing: ${n.rule_name}`;
const alertBody = (n: AlertNotification): string =>
  n.summary || n.description || (n.value !== null ? `value ${n.value}` : n.severity);

export function NotifyProvider({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<SourceInfo[]>([]);
  const seen = useRef<Set<string>>(loadSeen());
  // navigate's identity can change per route; the poller must not restart because of it.
  const navRef = useRef(nav);
  navRef.current = nav;

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((t: ToastIn) => {
    const id = ++nextId;
    setToasts((x) => [...x, { ...t, id }].slice(-3));
    if (!t.sticky) setTimeout(() => dismiss(id), 6000);
  }, [dismiss]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(FLASH_KEY);
      if (!raw) return;
      sessionStorage.removeItem(FLASH_KEY);
      toast(JSON.parse(raw) as ToastIn);
    } catch { /* unreadable flash: skip it */ }
  }, [toast]);

  useEffect(() => {
    let alive = true;
    let t: number | undefined;
    let alertId = loadAlertId();
    let alertsOff = false;
    let ticks = 0;
    let alertBusy = false;

    // Runs even while the tab is hidden: that is exactly when an OS notification matters. Tags dedupe across tabs.
    const pollAlerts = async () => {
      if (alertsOff) return;
      try {
        if (alertId === null || !Number.isFinite(alertId)) {
          const base = await api.alertNotifications(undefined, 1);
          alertId = base.last_id; saveAlertId(alertId);
          return;
        }
        const d = await api.alertNotifications(alertId, 50);
        if (!alive) return;
        // Ids went backwards: the server's store was reset. Re-baseline instead of going silent.
        if (d.last_id < alertId) { alertId = d.last_id; saveAlertId(alertId); return; }
        if (!d.items.length) return;
        alertId = Math.max(d.last_id, ...d.items.map((n) => n.id)); saveAlertId(alertId);
        // The stack holds three toasts; leave room for the summary when there are more.
        const shown = d.items.slice(d.items.length > 3 ? -2 : -3);
        for (const n of shown) {
          const critical = n.status === 'firing' && n.severity === 'critical' && n.source !== 'test';
          toast({
            kind: n.status === 'resolved' ? 'ok' : critical ? 'bad' : 'info', sticky: critical,
            title: alertTitle(n), body: alertBody(n), action: { label: 'Open alert rules', to: ALERTS_PAGE },
          });
          if (notifSupported() && Notification.permission === 'granted') {
            try {
              const os = new Notification(alertTitle(n), { body: alertBody(n), tag: String(n.id) });
              os.onclick = () => { window.focus(); navRef.current(ALERTS_PAGE); os.close(); };
            } catch { /* some mobile browsers only allow notifications from a service worker */ }
          }
        }
        if (d.items.length > shown.length) {
          toast({ kind: 'info', title: `${d.items.length - shown.length} more alert notifications`, action: { label: 'Open alert rules', to: ALERTS_PAGE } });
        }
        void refreshAlertingStatus();
      } catch (e) {
        // An older backend without alerting: stop asking. Anything else: try again next tick.
        if ((e as { status?: number })?.status === 404) alertsOff = true;
      }
    };

    const tick = async () => {
      // Not awaited: a slow alerting endpoint must not delay the source-review watcher.
      if (!alertBusy) { alertBusy = true; void pollAlerts().finally(() => { alertBusy = false; }); }
      // Keeps the sidebar's firing badge current without a poller of its own.
      if (!alertsOff && !document.hidden && ++ticks % 6 === 0) void refreshAlertingStatus();
      if (document.hidden) { t = window.setTimeout(() => void tick(), 4000); return; }
      try {
        const d = await api.listSources();
        if (!alive) return;
        const ready = d.sources.filter((s) => s.state === 'review');
        setPending(ready);
        const readyIds = new Set(ready.map((s) => s.id));
        setToasts((x) => x.filter((m) => !m.review || m.review.some((id) => readyIds.has(id))));
        const fresh = ready.filter((s) => {
          const key = `${s.id}@${s.attempts}`;
          if (seen.current.has(key)) return false;
          seen.current.add(key);
          return true;
        });
        if (fresh.length) {
          saveSeen(seen.current);
          const one = fresh.length === 1 ? fresh[0] : null;
          toast({
            kind: 'info', sticky: true, review: fresh.map((s) => s.id),
            title: one ? `${one.id} is ready for approval` : `${fresh.length} sources are ready for approval`,
            body: one ? 'A mapping proposal is waiting for your decision.' : fresh.map((s) => s.id).join(', '),
            action: { label: one ? 'Review' : 'Open Sources', to: one ? `/dashboard/sources?review=${encodeURIComponent(one.id)}` : '/dashboard/sources' },
          });
        }
      } catch { /* API down: the pages show their own errors */ }
      if (alive) t = window.setTimeout(() => void tick(), 4000);
    };
    void tick();
    return () => { alive = false; window.clearTimeout(t); };
  }, [toast]);

  useEffect(() => {
    document.title = pending.length ? `(${pending.length}) Aletheia` : 'Aletheia';
  }, [pending.length]);

  const value = useMemo(() => ({ toast, pending }), [toast, pending]);
  return (
    <NotifyCtx.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind ?? 'info'}`} role="status">
            <div className="grow">
              <div className="t-title">{t.title}</div>
              {t.body && <div className="t-body">{t.body}</div>}
              {t.action && (
                <button type="button" className="primary" onClick={() => { nav(t.action!.to); dismiss(t.id); }}>{t.action.label}</button>
              )}
            </div>
            <button type="button" className="ghost icon" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </NotifyCtx.Provider>
  );
}
