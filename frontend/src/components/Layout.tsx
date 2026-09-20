import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { USE_MOCKS, api } from '../lib/api';
import { useSettings } from '../lib/settings';
import { useTheme } from '../lib/theme';
import { useAsync } from '../lib/useAsync';
import { isCloudProvider } from '../lib/types';
import { ErrorBoundary } from './ErrorBoundary';
import {
  IconClose, IconCloud, IconDemo, IconEvents, IconInfo, IconLineage, IconMenu, IconMoon,
  IconSettings, IconShieldAlert, IconStudio, IconSun,
} from './Icons';

const NAV = [
  { to: '/events', label: 'Events', desc: 'One OCSF table', Icon: IconEvents },
  { to: '/lineage', label: 'Lineage', desc: 'Byte provenance', Icon: IconLineage },
  { to: '/studio', label: 'Studio', desc: 'Onboard new formats', Icon: IconStudio },
  { to: '/demo', label: 'Demo', desc: 'Run the scenarios', Icon: IconDemo },
  { to: '/settings', label: 'Settings', desc: 'LLM & air-gap', Icon: IconSettings },
];

/** Pack self-check plus event count: enough to tell at a glance that the stack is alive. */
function Health() {
  const packs = useAsync(() => api.verifyPacks(), []);
  const events = useAsync(() => api.listEvents({ limit: 1 }), []);

  const state = packs.loading || events.loading ? 'pending'
    : packs.error || events.error ? 'down'
      : packs.data?.ok ? 'up' : 'down';

  const label = state === 'pending' ? 'Checking…'
    : state === 'down' ? 'API unreachable'
      : 'Engine healthy';

  const meta = state === 'up' && events.data
    ? `${events.data.total.toLocaleString()} ev`
    : state === 'up' ? '' : '';

  return (
    <div
      className={`health ${state}`}
      title={state === 'up'
        ? `packs verify: ${packs.data?.reconstructed}/${packs.data?.samples} reconstructed, ${packs.data?.failures} failures`
        : (packs.error ?? events.error ?? 'checking the Studio API')}
    >
      <span className="dot" />
      <span className="label truncate">{label}</span>
      {meta && <span className="meta">{meta}</span>}
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-pressed={theme === 'dark'}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? <IconMoon size={14} /> : <IconSun size={14} />}
      <span>{theme === 'dark' ? 'Dark' : 'Light'} theme</span>
      <span className="switch" aria-hidden="true" />
    </button>
  );
}

export function Layout() {
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

  const cloudActive = !!settings && isCloudProvider(settings.provider) && !settings.airgap;

  return (
    <div className="shell">
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="sidebar-brand">
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
          <button type="button" className="ghost icon sidebar-close" onClick={() => setOpen(false)} aria-label="Close navigation">
            <IconClose size={16} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Main">
          <div className="nav-section">Console</div>
          {NAV.map(({ to, label, desc, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <Icon size={16} />
              <span className="grow">
                {label}
                <span className="desc">{desc}</span>
              </span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <Health />
          <ThemeToggle />
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
          {/* Persistent while a cloud provider is active (spec 8.12.6). */}
          {cloudActive && (
            <div className="banner warn">
              <IconCloud size={15} />
              <span>
                <strong>Cloud AI enabled.</strong>{' '}
                {settings!.send_samples === 'none' ? 'No samples' : `${settings!.send_samples} samples`} are sent to{' '}
                {settings!.provider}{settings!.model ? ` (${settings!.model})` : ''} — one request per cluster during
                onboarding, never on the hot path.
              </span>
              <Link to="/settings">Change</Link>
            </div>
          )}
          {settings?.airgap && (
            <div className="banner info">
              <IconShieldAlert size={15} />
              <span>
                <strong>Air-gap mode.</strong> Cloud providers are refused. Only <code>none</code> or a
                self-hosted <code>local</code> endpoint is allowed.
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
    </div>
  );
}
