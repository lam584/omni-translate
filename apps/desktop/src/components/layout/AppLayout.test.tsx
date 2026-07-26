import { act } from 'react';
import { type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeSnapshotMock } from '../../mocks/runtime-shell';
import { useAppStore } from '../../stores/app-store';
import { mountTestRoot, type TestRootHandle } from '../../test-utils';

const content = vi.hoisted(() => ({
  brandContent: { eyebrow: '', copy: '' },
  navItems: [
    { id: 'session', path: '/', label: 'session fallback', hint: 'session fallback hint' },
    { id: 'audio-routing', path: '/audio-routing', label: 'audio fallback', hint: 'audio fallback hint' },
    { id: 'glossary', path: '/glossary', label: 'glossary fallback', hint: 'glossary fallback hint' },
    { id: 'diagnostics', path: '/diagnostics', label: 'diagnostics fallback', hint: 'diagnostics fallback hint' },
    { id: 'custom-short', path: '/custom', label: 'custom short', hint: '' },
    { id: 'custom-long', path: '/custom/long', label: 'custom long', hint: 'custom hint' },
  ],
  presets: [{ id: 'preset-watch-mode' }],
}));

vi.mock('../../defaults/app-content', () => content);
vi.mock('react-i18next', async () => (await import('../../test-utils/i18n-stub')).reactI18nextStub());

import AppLayout, { appLayoutTestHelpers } from './AppLayout';

function renderLayout(root: Root, path: string) {
  return act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]} key={path}>
        <Routes>
          <Route element={<AppLayout />} path="/">
            <Route element={<div>child route</div>} index />
            <Route element={<div>child route</div>} path="*" />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  });
}

describe('AppLayout', () => {
  let view: TestRootHandle;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    content.brandContent.eyebrow = '';
    content.brandContent.copy = '';
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    runtimeSnapshot.bridge.bridgeState = 'stopped';
    runtimeSnapshot.bridgeStatus = 'browser-preview';
    useAppStore.setState((state) => ({ ...state, runtimeNotifications: [], runtimeSnapshot }));
    view = mountTestRoot();
    ({ container, root } = view);
  });

  afterEach(async () => {
    await view.cleanup();
  });

  it('maps runtime tones explicitly', () => {
    expect(appLayoutTestHelpers.getRuntimeTone('running', 'browser-preview')).toBe('ready');
    expect(appLayoutTestHelpers.getRuntimeTone('stopped', 'tauri-shell')).toBe('ready');
    expect(appLayoutTestHelpers.getRuntimeTone('stopped', 'runtime-error')).toBe('warning');
    expect(appLayoutTestHelpers.getRuntimeTone('stopped', 'browser-preview')).toBe('pending');
  });

  it('renders fallback branding, unknown navigation metadata and browser status', async () => {
    await renderLayout(root, '/custom/long/nested');
    expect(container.textContent).toContain('brand.kicker');
    expect(container.textContent).toContain('custom long');
    expect(container.textContent).toContain('bridgeStatus.browserPreview');
    expect(container.textContent).toContain('child route');
    expect(container.querySelector('.console-page-heading h1')?.textContent).toBe('custom long');
  });

  it('renders nested settings headings, notification badge and native status', async () => {
    content.brandContent.eyebrow = 'Omni';
    content.brandContent.copy = 'Translate';
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    runtimeSnapshot.bridge.bridgeState = 'running';
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    useAppStore.setState((state) => ({
      ...state,
      runtimeSnapshot,
      runtimeNotifications: [
        { id: 'info', level: 'info', source: 'test', message: 'info', emittedAt: 'now' },
        { id: 'warning', level: 'warning', source: 'test', message: 'warning', emittedAt: 'now' },
      ],
    }));

    await renderLayout(root, '/settings/providers');
    expect(container.textContent).toContain('Omni');
    expect(container.textContent).toContain('Translate');
    expect(container.textContent).toContain('nav.providers');
    expect(container.textContent).toContain('bridgeStatus.tauriShell');
    expect(container.querySelector('.console-nav-badge')?.textContent).toBe('1');

    await renderLayout(root, '/settings/overlay-style');
    expect(container.textContent).toContain('settings.sectionOverlay');
  });

  it('renders runtime errors and falls back to the first navigation item for unknown paths', async () => {
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    runtimeSnapshot.bridgeStatus = 'runtime-error';
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot }));
    await renderLayout(root, '/unmatched');
    expect(container.textContent).toContain('bridgeStatus.runtimeError');
    expect(container.querySelector('.console-page-heading h1')?.textContent).toBe('nav.session');
  });

  it('omits the top-bar hint for navigation items without one', async () => {
    await renderLayout(root, '/custom');
    expect(container.querySelector('.console-page-heading h1')?.textContent).toBe('custom short');
    expect(container.querySelector('.console-page-heading p')).toBeNull();
  });
});
