import React from 'react';
import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, createHashRouter } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import { preloadDefaultRoute, onRouteReady } from './router-startup';

const AudioRoutingPage = lazy(() => import('./pages/AudioRoutingPage'));
const DiagnosticsPage = lazy(() => import('./pages/DiagnosticsPage'));
const GlossaryPage = lazy(() => import('./pages/GlossaryPage'));
const ProvidersPage = lazy(() => import('./pages/ProvidersPage'));
const RealTimeSessionPage = lazy(() => import('./pages/RealTimeSessionPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SubtitleOverlaySettingsPage = lazy(() => import('./pages/SubtitleOverlaySettingsPage'));

function lazyPage(element: ReactNode) {
  return (
    <Suspense fallback={<div className="route-loading-surface" aria-busy="true" />}>
      {element}
    </Suspense>
  );
}

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
        element: lazyPage(<SessionPageWithStartup />),
      },
      {
        path: 'audio-routing',
        element: lazyPage(<AudioRoutingPage />),
      },
      {
        path: 'devices',
        element: <Navigate replace to="/audio-routing" />,
      },
      {
        path: 'glossary',
        element: lazyPage(<GlossaryPage />),
      },
      {
        path: 'diagnostics',
        element: lazyPage(<DiagnosticsPage />),
      },
      {
        path: 'settings',
        children: [
          { index: true, element: lazyPage(<SettingsPage />) },
          { path: 'overlay-style', element: lazyPage(<SubtitleOverlaySettingsPage />) },
          { path: 'providers', element: lazyPage(<ProvidersPage />) },
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
