// Alerting shell: tabs for rules, contact points and routing, plus the Grafana/local status strip
// (CONTRACTS section 13). Sub-pages render in the Outlet.
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import { Badge, Callout, ErrorState, PageHead } from '../components/Bits';
import { IconExternal, IconRefresh } from '../components/Icons';
import { api, errMessage } from '../lib/api';
import { ago, grafanaAlertingUrl, refreshAlertingStatus, setAlertingStatus, useAlertingStatus } from '../lib/alerting';
import { useNotify } from '../lib/notify';
import type { AlertingStatus } from '../lib/types';

const TABS = [
  { to: 'rules', label: 'Alert rules', desc: 'Define the condition that must be met before an alert rule fires' },
  { to: 'contact-points', label: 'Contact points', desc: 'Configure who receives notifications and how they are sent' },
  { to: 'policies', label: 'Notification policies', desc: 'Configure how firing alert instances are routed to contact points' },
];

interface AlertingCtx { version: number }

/** Bumped after "Sync now", so sub-pages reload their sync badges. */
export const useAlertingVersion = (): number => useOutletContext<AlertingCtx | undefined>()?.version ?? 0;

function Reach({ label, dep }: { label: string; dep: { url: string | null; reachable: boolean; error?: string; version?: string } }) {
  const tone = !dep.url ? 'off' : dep.reachable ? 'ok' : 'bad';
  const text = !dep.url ? 'not configured' : dep.reachable ? (dep.version ? `v${dep.version}` : 'reachable') : 'unreachable';
  return (
    <div className="al-strip-item" title={dep.error ?? dep.url ?? `${label} URL is not set`}>
      <span className="k">{label}</span>
      <span className="v"><i className={`al-dot ${tone}`} aria-hidden="true" />{text}</span>
    </div>
  );
}

function StatusStrip({ s, onSynced }: { s: AlertingStatus; onSynced: () => void }) {
  const { toast } = useNotify();
  const [busy, setBusy] = useState(false);
  const grafana = s.mode === 'grafana';

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
    <div className="stack-sm">
      <div className="al-strip" role="status">
        <div className="al-strip-item" title={grafana
          ? 'Grafana unified alerting evaluates the rules; Studio pushes them to it.'
          : 'Grafana is not configured or unreachable, so Studio evaluates the same rules itself.'}>
          <span className="k">Mode</span>
          <span className="v"><Badge kind={grafana ? 'info' : 'plain'}>{grafana ? 'Grafana' : 'Local evaluator'}</Badge></span>
        </div>
        <Reach label="Grafana" dep={s.grafana} />
        <Reach label="Loki" dep={s.loki} />
        <Reach label="Prometheus" dep={s.prometheus} />
        <div className="al-strip-item" title={s.last_sync_at ?? undefined}>
          <span className="k">Last sync</span>
          <span className="v">{s.last_sync_error ? <Badge kind="bad">failed</Badge> : ago(s.last_sync_at)}</span>
        </div>
        <div className="al-strip-item">
          <span className="k">Rules</span>
          <span className="v">
            {s.counts.rules}
            {s.counts.firing > 0 && <Badge kind="bad">{s.counts.firing} firing</Badge>}
            {s.counts.pending > 0 && <Badge kind="warn">{s.counts.pending} pending</Badge>}
          </span>
        </div>
        <div className="al-strip-actions">
          <button type="button" className="btn-sm" disabled={busy || !s.grafana.url} onClick={() => void sync()}
            title={s.grafana.url ? 'Push every rule, contact point and the policy tree to Grafana now' : 'Set ALETHEIA_GRAFANA_URL to sync to Grafana'}>
            <IconRefresh size={13} />{busy ? 'Syncing…' : 'Sync now'}
          </button>
          {grafana && (
            <a className="btn btn-sm" href={grafanaAlertingUrl(s)} target="_blank" rel="noopener noreferrer">
              <IconExternal size={13} />Open Grafana alerting
            </a>
          )}
        </div>
      </div>
      {s.last_sync_error && (
        <Callout kind="bad"><b>Last sync to Grafana failed.</b> {s.last_sync_error}</Callout>
      )}
    </div>
  );
}

export function AlertingShell() {
  const { status, error, loaded } = useAlertingStatus();
  const [version, setVersion] = useState(0);

  // Fresh on entry, then every 15s while the tab is visible.
  useEffect(() => {
    void refreshAlertingStatus();
    const t = window.setInterval(() => { if (!document.hidden) void refreshAlertingStatus(); }, 15000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="stack">
      <PageHead title="Alerting">
        Alert on your logs and metrics. Studio keeps the rules and pushes them to Grafana; without Grafana it evaluates them itself.
      </PageHead>

      <nav className="al-tabs" aria-label="Alerting sections">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => `al-tab${isActive ? ' active' : ''}`}>
            <span className="al-tab-t">{t.label}</span>
            <span className="al-tab-d">{t.desc}</span>
          </NavLink>
        ))}
      </nav>

      {status && <StatusStrip s={status} onSynced={() => setVersion((v) => v + 1)} />}
      {!status && loaded && error && (
        <ErrorState error={error} what="alerting status"
          fix="Check that the Studio API is running and includes alerting (/api/v1/alerting/status)." />
      )}

      <Outlet context={{ version } satisfies AlertingCtx} />
    </div>
  );
}
