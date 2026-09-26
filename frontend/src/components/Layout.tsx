import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { USE_MOCKS, api } from '../lib/api';
import { useSettings } from '../lib/settings';
import { useTheme } from '../lib/theme';
import { ErrorBoundary } from './ErrorBoundary';
import { Tour, restartTour } from './Tour';
import { NotifyProvider, useNotify } from '../lib/notify';
import { useAlertingStatus } from '../lib/alerting';
import {
  IconBell, IconClose, IconDemo, IconEvents, IconExport, IconHome, IconInfo, IconLock, IconMenu, IconMoon,
  IconLyra, IconSettings, IconSources, IconSparkles, IconSun,
} from './Icons';


const NAV = [
  { to: '/dashboard', label: 'Overview', desc: 'Live stats', Icon: IconHome, end: true },
  { to: '/dashboard/events', label: 'Events', desc: 'One OCSF table', Icon: IconEvents, end: false },
  { to: '/dashboard/lyra', label: 'Lyra', desc: 'Ask your data', Icon: IconLyra, end: false },
  { to: '/dashboard/sources', label: 'Sources', desc: 'Connect and approve', Icon: IconSources, end: false },
  { to: '/dashboard/alerting', label: 'Alerting', desc: 'Rules, contacts, routing', Icon: IconBell, end: false },
  { to: '/dashboard/export', label: 'Export & Supply', desc: 'Reports, logs & stream', Icon: IconExport, end: false },
  { to: '/dashboard/demo', label: 'Demo', desc: 'Sample servers', Icon: IconDemo, end: false },
  { to: '/dashboard/settings', label: 'Setting', desc: 'LLM & air-gap', Icon: IconSettings, end: false },
];


/** Pack self-check: enough to tell at a glance that the engine stack is alive. */
function Health() {
  const [state, setState] = useState<'pending' | 'up' | 'down'>('pending');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // The pack self-check spawns a full reconstruction run, so it runs once; after that a cheap ping.
  useEffect(() => {
    let alive = true;
    let t: number | undefined;
    let packsOk = true;
    const set = (s: 'up' | 'down', msg: string | null) => { if (alive) { setState(s); setErrorMsg(msg); } };
    const ping = async () => {
      if (!document.hidden) {
        try {
          await api.health();
          set(packsOk ? 'up' : 'down', packsOk ? null : 'Pack verification failed');
        } catch (err: any) { set('down', err?.message ?? 'API unreachable'); }
      }
      if (alive) t = window.setTimeout(() => void ping(), 10000);
    };
    api.verifyPacks().then((p) => { packsOk = p.ok; }, () => {}).finally(() => { if (alive) void ping(); });
    return () => { alive = false; window.clearTimeout(t); };
  }, []);

  // Stays hidden while checking or healthy; only surfaces when something is actually wrong.
  if (state !== 'down') return null;

  const label = errorMsg === 'Pack verification failed' ? 'Pack check failed' : 'API unreachable';

  return (
    <div className="health down" title={errorMsg ?? 'API unreachable'}>
      <span className="dot" />
      <span className="label truncate">{label}</span>
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      className="theme-box-toggle"
      onClick={toggle}
      aria-pressed={isDark}
      title={`Switch to ${isDark ? 'light' : 'dark'} theme`}
    >
      {isDark ? <IconMoon size={15} /> : <IconSun size={15} />}
    </button>
  );
}

export function Layout() {
  return <NotifyProvider><LayoutInner /></NotifyProvider>;
}

function LayoutInner() {
  const { pending } = useNotify();
  const firing = useAlertingStatus().status?.counts.firing ?? 0;
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  const location = useLocation();

  // Navigating on a phone should close the drawer, not leave it covering the page.
  useEffect(() => { setOpen(false); }, [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="shell">
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="sidebar-brand">
          <Link to="/" className="sidebar-brand-link">
            <span className="mark" aria-hidden="true">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
                <path d="M12 8.2l3.4 7.6H8.6z" />
              </svg>
            </span>
            <span className="grow">
              <span className="name">Aletheia</span>
              <span className="tag">Lossless log pipeline</span>
            </span>
          </Link>
          <ThemeToggle />
          <button type="button" className="ghost icon sidebar-close" onClick={() => setOpen(false)} aria-label="Close navigation">
            <IconClose size={16} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Main">
          <div className="nav-section">Console</div>
          {NAV.map(({ to, label, desc, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <Icon size={16} />
              <span className="grow">
                {label}
                <span className="desc">{desc}</span>
              </span>
              {to === '/dashboard/sources' && pending.length > 0 && (
                <span className="nav-badge" title={`${pending.length} ready for approval`}>{pending.length}</span>
              )}
              {to === '/dashboard/alerting' && firing > 0 && (
                <span className="nav-badge bad" title={`${firing} alert rule${firing === 1 ? '' : 's'} firing`}>{firing}</span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot stack-sm" style={{ gap: 6 }}>
          {settings?.airgap && (
            <div className="sidebar-airgap-pill" title="Strict Offline Mode Active: External cloud API calls are refused. Zero data egress.">
              <IconLock size={13} />
              <span className="truncate">Strict Offline Active</span>
            </div>
          )}
          <button type="button" className="ghost tour-replay" onClick={restartTour}>
            <IconSparkles size={13} /> Take the tour
          </button>
          <Health />
        </div>
      </aside>




      {open && <button type="button" className="scrim" aria-label="Close navigation" onClick={() => setOpen(false)} />}

      <div className="content">
        <div className="mobile-bar">
          <button type="button" className="ghost icon" onClick={() => setOpen(true)} aria-label="Open navigation">
            <IconMenu size={18} />
          </button>
          <span className="name">Aletheia</span>
        </div>

        <div className="banner-strip">
          {settings?.airgap && (
            <div className="banner info">
              <IconLock size={15} />
              <span>
                <strong>Strict Offline Mode (Zero Data Egress).</strong> Cloud providers (Gemini) are refused. Only local self-hosted models or None are allowed.
              </span>
            </div>
          )}
          {USE_MOCKS && (
            <div className="banner">
              <IconInfo size={15} />
              <span>
                <strong>Fixture mode.</strong> VITE_USE_MOCKS=1 — every page is served from bundled
                fixtures. No backend and no network are involved.
              </span>
            </div>
          )}
        </div>

        <main className="page">
          {/* One page crashing must not take the navigation down with it. */}
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      <Tour />
    </div>
  );
}
