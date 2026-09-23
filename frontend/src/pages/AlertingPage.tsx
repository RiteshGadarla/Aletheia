// Alerting shell: compact header, tab bar with counts, and a one-line Grafana/local connection strip
// (CONTRACTS section 13). Sub-pages render in the Outlet.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useOutletContext } from 'react-router-dom';
import { ErrorState } from '../components/Bits';
import { IconAlert, IconBell, IconExternal, IconRefresh } from '../components/Icons';
import { api, errMessage } from '../lib/api';
import {
  ago, countRoutes, grafanaAlertingUrl, IconRoute, IconSend, refreshAlertingStatus, setAlertingStatus, useAlertingStatus,
} from '../lib/alerting';
import { useNotify } from '../lib/notify';
import type { AlertingStatus } from '../lib/types';
import '../styles/alerting-rules.css';

type TabKey = 'rules' | 'contact-points' | 'policies';

const TABS: { to: TabKey; label: string; short: string; desc: string; icon: ReactNode }[] = [
  { to: 'rules', label: 'Alert rules', short: 'Rules', icon: <IconBell size={15} />,
    desc: 'Define the condition that must be met before an alert rule fires' },
  { to: 'contact-points', label: 'Contact points', short: 'Contacts', icon: <IconSend size={15} />,
    desc: 'Configure who receives notifications and how they are sent' },
  { to: 'policies', label: 'Notification policies', short: 'Policies', icon: <IconRoute size={15} />,
    desc: 'Configure how firing alert instances are routed to contact points' },
];

interface AlertingCtx { version: number }

/** Bumped after "Sync now", so sub-pages reload their sync badges. */
export const useAlertingVersion = (): number => useOutletContext<AlertingCtx | undefined>()?.version ?? 0;

type Dep = { url: string | null; reachable: boolean; error?: string; version?: string };

function Reach({ label, dep }: { label: string; dep: Dep }) {
  const tone = !dep.url ? 'off' : dep.reachable ? 'ok' : 'bad';
  const text = !dep.url ? 'off' : dep.reachable ? (dep.version ? `v${dep.version}` : 'up') : 'down';
  const state = !dep.url ? 'not configured' : dep.reachable ? 'reachable' : 'unreachable';
  return (
    <span className="alg-dep" title={`${label} ${state}${dep.error ? `: ${dep.error}` : dep.url ? ` (${dep.url})` : ''}`}>
      <i className={`al-dot ${tone}`} aria-hidden="true" />
      <span className="alg-dep-k">{label}</span>
      <span className="alg-dep-v">{text}</span>
      <span className="sr-only">{state}</span>
    </span>
  );
}

function StatusStrip({ s, onSynced }: { s: AlertingStatus; onSynced: () => void }) {
  const { toast } = useNotify();
  const [busy, setBusy] = useState(false);
  const grafana = s.mode === 'grafana';
  const down = [s.grafana, s.loki, s.prometheus].filter((d) => d.url && !d.reachable && d.error);

  const sync = async () => {
    setBusy(true);
    try {
      const next = await api.alertingSync();
      setAlertingStatus(next);
      if (next.last_sync_error) toast({ kind: 'bad', title: 'Sync to Grafana failed', body: next.last_sync_error });
      else toast({ kind: 'ok', title: 'Pushed to Grafana', body: 'Rules, contact points and policies are in sync.' });
      onSynced();
    } catch (e) {
      toast({ kind: 'bad', title: 'Sync failed', body: errMessage(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="alg-conn" role="status">
      <div className="alg-conn-row">
        <span className={`alg-mode ${grafana ? 'on' : ''}`} title={grafana
          ? 'Grafana unified alerting evaluates the rules; Studio pushes them to it.'
          : 'Grafana is not configured or unreachable, so Studio evaluates the same rules itself.'}>
          {grafana ? 'Grafana mode' : 'Local evaluator'}
        </span>
        <span className="alg-deps">
          <Reach label="Grafana" dep={s.grafana} />
          <Reach label="Loki" dep={s.loki} />
          <Reach label="Prometheus" dep={s.prometheus} />
        </span>
        <span className={`alg-sync ${s.last_sync_error ? 'bad' : ''}`} title={s.last_sync_at ?? undefined}>
          {s.last_sync_error ? 'Last sync failed' : `Synced ${ago(s.last_sync_at)}`}
        </span>
        <span className="alg-conn-actions">
          <button type="button" className="ghost alg-conn-btn" disabled={busy || !s.grafana.url} onClick={() => void sync()}
            title={s.grafana.url ? 'Push every rule, contact point and the policy tree to Grafana now' : 'Set ALETHEIA_GRAFANA_URL to sync to Grafana'}>
            <IconRefresh size={13} className={busy ? 'spin' : undefined} />{busy ? 'Syncing…' : 'Sync now'}
          </button>
          {grafana && (
            <a className="btn ghost alg-conn-btn" href={grafanaAlertingUrl(s)} target="_blank" rel="noopener noreferrer">
              <IconExternal size={13} />Open Grafana alerting
            </a>
          )}
        </span>
      </div>
      {s.last_sync_error && (
        <p className="alg-conn-err"><IconAlert size={14} /><span><b>Last sync to Grafana failed.</b> {s.last_sync_error}</span></p>
      )}
      {down.map((d) => (
        <p key={d.url} className="alg-conn-err warn"><IconAlert size={14} /><span><b>{d.url} is unreachable.</b> {d.error}</span></p>
      ))}
    </div>
  );
}

export function AlertingShell() {
  const { status, error, loaded } = useAlertingStatus();
  const [version, setVersion] = useState(0);
  const [routes, setRoutes] = useState<number | null>(null);
  const { pathname } = useLocation();
  const active = TABS.find((t) => pathname.includes(`/alerting/${t.to}`)) ?? TABS[0];

  // Fresh on entry, then every 15s while the tab is visible.
  useEffect(() => {
    void refreshAlertingStatus();
    const t = window.setInterval(() => { if (!document.hidden) void refreshAlertingStatus(); }, 15000);
    return () => window.clearInterval(t);
  }, []);

  // Route count for the policies tab; re-read on tab change so edits there show up.
  useEffect(() => {
    let alive = true;
    api.getPolicies().then((p) => { if (alive) setRoutes(countRoutes(p.policy)); }, () => { if (alive) setRoutes(null); });
    return () => { alive = false; };
  }, [pathname, version]);

  const counts: Record<TabKey, number | null> = {
    rules: status?.counts.rules ?? null,
    'contact-points': status?.counts.contact_points ?? null,
    policies: routes,
  };

  return (
    <div className="stack alg">
      <div className="alg-head">
        <h1>Alerting</h1>
        <p className="alg-sub">Alert on logs and metrics. Studio keeps the rules and pushes them to Grafana, or evaluates them itself.</p>
      </div>

      {status && <StatusStrip s={status} onSynced={() => setVersion((v) => v + 1)} />}
      {!status && loaded && error && (
        <ErrorState error={error} what="alerting status"
          fix="Check that the Studio API is running and includes alerting (/api/v1/alerting/status)." />
      )}

      <div className="alg-nav">
        <nav className="alg-tabs" aria-label="Alerting sections">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} className={({ isActive }) => `alg-tab${isActive ? ' active' : ''}`}>
              {t.icon}
              <span className="alg-tab-l">{t.label}</span>
              <span className="alg-tab-s" aria-hidden="true">{t.short}</span>
              {counts[t.to] !== null && <span className="alg-count">{counts[t.to]}</span>}
            </NavLink>
          ))}
        </nav>
        <p className="alg-desc">{active.desc}</p>
      </div>

      <Outlet context={{ version } satisfies AlertingCtx} />
    </div>
  );
}
