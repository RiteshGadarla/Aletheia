import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AlertingShell } from './pages/AlertingPage';
import { AlertRulesPage } from './pages/AlertRulesPage';
import { ContactPointsPage } from './pages/ContactPointsPage';
import { NotificationPoliciesPage } from './pages/NotificationPoliciesPage';
import { DemoPage } from './pages/DemoPage';
import { EventsPage } from './pages/EventsPage';
import { ExportPage } from './pages/ExportPage';
import { HomePage } from './pages/HomePage';
import { LyraPage } from './pages/LyraPage';
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
        <Route path="lyra" element={<LyraPage />} />
        <Route path="sources" element={<SourcesPage />} />
        <Route path="export" element={<ExportPage />} />
        <Route path="alerting" element={<AlertingShell />}>
          <Route index element={<Navigate to="/dashboard/alerting/rules" replace />} />
          <Route path="rules" element={<AlertRulesPage />} />
          <Route path="contact-points" element={<ContactPointsPage />} />
          <Route path="policies" element={<NotificationPoliciesPage />} />
          <Route path="*" element={<Navigate to="/dashboard/alerting/rules" replace />} />
        </Route>
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
