import React from 'react';
import { Navigate, createHashRouter } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import AudioRoutingPage from './pages/AudioRoutingPage';
import DiagnosticsPage from './pages/DiagnosticsPage';
import GlossaryPage from './pages/GlossaryPage';
import ProvidersPage from './pages/ProvidersPage';
import RealTimeSessionPage from './pages/RealTimeSessionPage';
import SettingsPage from './pages/SettingsPage';
import SubtitleOverlaySettingsPage from './pages/SubtitleOverlaySettingsPage';
import { preloadDefaultRoute, onRouteReady } from './router-startup';

function SessionPageWithStartup() {
  React.useEffect(() => {
    onRouteReady();
  }, []);
  return <RealTimeSessionPage />;
}

preloadDefaultRoute();

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
        element: <SessionPageWithStartup />,
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
