import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { router } from './router';

vi.mock('./components/layout/AppLayout', () => ({ default: () => React.createElement('div') }));
vi.mock('./pages/AudioRoutingPage', () => ({ default: () => React.createElement('div') }));
vi.mock('./pages/DiagnosticsPage', () => ({ default: () => React.createElement('div') }));
vi.mock('./pages/GlossaryPage', () => ({ default: () => React.createElement('div') }));
vi.mock('./pages/ProvidersPage', () => ({ default: () => React.createElement('div') }));
vi.mock('./pages/RealTimeSessionPage', () => ({ default: () => React.createElement('div') }));
vi.mock('./pages/SettingsPage', () => ({ default: () => React.createElement('div') }));
vi.mock('./pages/SubtitleOverlaySettingsPage', () => ({ default: () => React.createElement('div') }));

describe('router', () => {
  it('keeps the primary routes and compatibility redirects registered', () => {
    const rootRoute = router.routes.find((route) => route.path === '/');
    expect(rootRoute?.path).toBe('/');

    const routeKeys = rootRoute?.children?.map((route) => (route.index ? 'index' : route.path)) ?? [];
    expect(routeKeys).toEqual([
      'index',
      'session',
      'audio-routing',
      'devices',
      'glossary',
      'diagnostics',
      'settings',
      'quick-setup',
      'providers',
      '*',
    ]);

    const settingsRoute = rootRoute?.children?.find((route) => route.path === 'settings');
    expect(settingsRoute?.children?.map((route) => (route.index ? 'index' : route.path))).toEqual([
      'index',
      'overlay-style',
      'providers',
    ]);
  });

  it('loads every lazy route and runs session startup composition', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(RouterProvider, { router }));
    });

    for (const route of [
      '/session',
      '/audio-routing',
      '/glossary',
      '/diagnostics',
      '/settings',
      '/settings/overlay-style',
      '/settings/providers',
    ]) {
      await act(async () => {
        await router.navigate(route);
        await Promise.resolve();
      });
    }

    await act(async () => root.unmount());
  });
});
