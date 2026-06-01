import { Navigate, createHashRouter } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import AudioRoutingPage from './pages/AudioRoutingPage';
import DiagnosticsPage from './pages/DiagnosticsPage';
import GlossaryPage from './pages/GlossaryPage';
import ProvidersPage from './pages/ProvidersPage';
import RealTimeSessionPage from './pages/RealTimeSessionPage';
import SettingsPage from './pages/SettingsPage';
import SubtitleOverlaySettingsPage from './pages/SubtitleOverlaySettingsPage';

export const router = createHashRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      {
        index: true,
        element: <Navigate replace to="/session" />,
      },
      {
        path: 'session',
        element: <RealTimeSessionPage />,
      },
      {
        path: 'audio-routing',
        element: <AudioRoutingPage />,
      },
      {
        path: 'devices',
        element: <Navigate replace to="/audio-routing" />,
      },
      {
        path: 'glossary',
        element: <GlossaryPage />,
      },
      {
        path: 'diagnostics',
        element: <DiagnosticsPage />,
      },
      {
        path: 'settings',
        children: [
          { index: true, element: <SettingsPage /> },
          { path: 'overlay-style', element: <SubtitleOverlaySettingsPage /> },
          { path: 'providers', element: <ProvidersPage /> },
        ],
      },
      // Backward-compatible redirects for the removed top-level pages.
      {
        path: 'quick-setup',
        element: <Navigate replace to="/session" />,
      },
      {
        path: 'providers',
        element: <Navigate replace to="/settings/providers" />,
      },
      {
        path: '*',
        element: <Navigate replace to="/session" />,
      },
    ],
  },
]);
