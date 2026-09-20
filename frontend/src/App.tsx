import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { DemoPage } from './pages/DemoPage';
import { EventsPage } from './pages/EventsPage';
import { HomePage } from './pages/HomePage';
import { LineagePage } from './pages/LineagePage';
import { SettingsPage } from './pages/SettingsPage';
import { OverviewPage } from './pages/OverviewPage';
import { SourcesPage } from './pages/SourcesPage';

export default function App() {
  return (
    <Routes>
      {/* Product landing — standalone, no sidebar */}
      <Route path="/" element={<HomePage />} />

      {/* Dashboard — sidebar layout wraps all app pages */}
      <Route path="/dashboard" element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="lineage" element={<LineagePage />} />
        <Route path="lineage/:eventUid" element={<LineagePage />} />
        <Route path="sources" element={<SourcesPage />} />
        <Route path="studio" element={<Navigate to="/dashboard/sources" replace />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="demo" element={<DemoPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>

      {/* Legacy redirects */}
      <Route path="/events" element={<Navigate to="/dashboard/events" replace />} />
      <Route path="/lineage/*" element={<Navigate to="/dashboard/lineage" replace />} />
      <Route path="/studio" element={<Navigate to="/dashboard/sources" replace />} />
      <Route path="/settings" element={<Navigate to="/dashboard/settings" replace />} />
      <Route path="/demo" element={<Navigate to="/dashboard/demo" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
