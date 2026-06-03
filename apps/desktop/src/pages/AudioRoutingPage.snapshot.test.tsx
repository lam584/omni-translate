import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../stores/app-store';
import AudioRoutingPage from './AudioRoutingPage';

function bootstrap() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root, cleanup: () => { root.unmount(); container.remove(); } };
}

function enableAllScenarioSwitches(container: HTMLElement) {
  const switches = Array.from(container.querySelectorAll('input[role="switch"]')) as HTMLInputElement[];
  for (const node of switches) {
    if (!node.checked) {
      node.click();
    }
  }
}

describe('AudioRoutingPage v9 layout snapshot', () => {
  let host: { container: HTMLElement; root: Root; cleanup: () => void };

  beforeEach(() => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: {
          ...state.configDraft.devices,
          outputSubtitlesEnabled: true,
          outputSpeechEnabled: true,
          virtualMicOutputEnabled: true,
          subtitleTranslationMode: 'secondary',
        },
      },
    }));
    host = bootstrap();
  });

  afterEach(() => {
    host.cleanup();
  });

  it('renders the v9 workspace with top-grid, models-grid, and unified channel section in order', async () => {
    await act(async () => {
      host.root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const workspace = host.container.querySelector('.routing-workspace-v9');
    expect(workspace).toBeTruthy();
    const orderedSections = Array.from(workspace?.querySelectorAll(':scope > section, :scope > article') ?? []).map((node) => node.className.split(' ').filter(Boolean)).flat();
    expect(orderedSections).toEqual(expect.arrayContaining(['routing-top-grid', 'routing-models-grid', 'routing-channel-section-unified']));
    const topGridIndex = orderedSections.indexOf('routing-top-grid');
    const modelsGridIndex = orderedSections.indexOf('routing-models-grid');
    const unifiedIndex = orderedSections.indexOf('routing-channel-section-unified');
    expect(topGridIndex).toBeLessThan(modelsGridIndex);
    expect(modelsGridIndex).toBeLessThan(unifiedIndex);
  });

  it('exposes exactly 3 output channel toggles in the unified section with switch semantics', async () => {
    await act(async () => {
      host.root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const unified = host.container.querySelector('.routing-channel-section-unified');
    expect(unified).toBeTruthy();
    const grid = unified?.querySelector('.routing-channel-section-grid');
    expect(grid).toBeTruthy();
    const checkboxes = Array.from(grid?.querySelectorAll('input[type="checkbox"]') ?? []);
    expect(checkboxes).toHaveLength(3);
    for (const node of checkboxes) {
      expect(node.getAttribute('role')).toBe('switch');
      expect(node.getAttribute('aria-checked')).toBe('true');
    }
    const labels = Array.from(grid?.querySelectorAll('.routing-channel-text') ?? []).map((node) => node.textContent?.trim());
    expect(labels).toEqual([
      'Enable secondary audio',
      'Output translated speech',
      'Send translated voice to virtual microphone',
    ]);
  });

  it('places saved indicator and section header inside the unified section', async () => {
    await act(async () => {
      host.root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const unified = host.container.querySelector('.routing-channel-section-unified');
    expect(unified?.querySelector('.routing-channel-section-head h3')?.textContent).toBe('Output channels');
    expect(unified?.querySelector('.routing-channel-section-head .routing-panel-kicker')?.textContent).toBe('Speak');
    expect(unified?.querySelector('.routing-saved-indicator')?.textContent?.trim()).toBeTruthy();
  });

  it('has 2 panels in the top grid (capture + output) and 2 panels in the models grid (inbound + outbound)', async () => {
    await act(async () => {
      host.root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const topPanels = host.container.querySelectorAll('.routing-top-grid > .routing-panel');
    expect(topPanels).toHaveLength(2);
    const modelPanels = host.container.querySelectorAll('.routing-models-grid > .routing-panel');
    expect(modelPanels).toHaveLength(2);
  });

  it('moves the secondary-audio scenario card out of the channel-toggle pattern', async () => {
    await act(async () => {
      host.root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const secondaryCard = Array.from(host.container.querySelectorAll('.scenario-card')).find((card) => card.textContent?.includes('Listen to them · secondary audio')) as HTMLElement | undefined;
    expect(secondaryCard).toBeTruthy();
    expect(secondaryCard?.querySelector('input[role="switch"]')).toBeNull();
  });
});
