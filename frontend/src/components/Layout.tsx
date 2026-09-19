import { NavLink, Outlet } from 'react-router-dom';
import { USE_MOCKS } from '../lib/api';
import { useSettings } from '../lib/settings';
import { isCloudProvider } from '../lib/types';

const NAV = [
  { to: '/events', label: 'Events' },
  { to: '/lineage', label: 'Lineage' },
  { to: '/studio', label: 'Studio' },
  { to: '/settings', label: 'Settings' },
  { to: '/demo', label: 'Demo console' },
];

export function Layout() {
  const { settings } = useSettings();
  const cloudActive = !!settings && isCloudProvider(settings.provider) && !settings.airgap;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">[A]</span>
          <span>Aletheia</span>
          <span className="tag">lossless log pre-processing &middot; SIH 26156</span>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>

      {/* Persistent while a cloud provider is active (spec 8.12.6). */}
      {cloudActive && (
        <div className="banner cloud">
          <strong>Cloud AI enabled:</strong>
          <span>
            masked samples are sent to {settings!.provider}
            {settings!.model ? ` (${settings!.model})` : ''}. Masking mode: {settings!.send_samples}.
          </span>
          <a href="/settings">Change</a>
        </div>
      )}
      {settings?.airgap && (
        <div className="banner airgap">
          <strong>Air-gap mode:</strong>
          <span>cloud AI providers are refused. Only none, ollama or a private openai_compatible endpoint are allowed.</span>
        </div>
      )}
      {USE_MOCKS && (
        <div className="banner mock">
          <strong>Fixture mode</strong>
          <span>
            VITE_USE_MOCKS=1: every page is served from bundled fixtures derived from the spec examples.
            No backend and no network are involved.
          </span>
        </div>
      )}

      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
