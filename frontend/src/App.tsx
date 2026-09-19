import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { DemoPage } from './pages/DemoPage';
import { EventsPage } from './pages/EventsPage';
import { LineagePage } from './pages/LineagePage';
import { SettingsPage } from './pages/SettingsPage';
import { StudioPage } from './pages/StudioPage';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/events" replace />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/lineage" element={<LineagePage />} />
        <Route path="/lineage/:eventUid" element={<LineagePage />} />
        <Route path="/studio" element={<StudioPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/demo" element={<DemoPage />} />
        <Route path="*" element={<Navigate to="/events" replace />} />
      </Route>
    </Routes>
  );
}
