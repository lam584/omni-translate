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
        speech: {
          ...state.configDraft.speech,
          enabled: true,
        },
      },
    }));
    host = bootstrap();
  });

  afterEach(() => {
    host.cleanup();
  });

  it('renders the v9 workspace with top-grid and models-grid in order', async () => {
    await act(async () => {
      host.root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const workspace = host.container.querySelector('.routing-workspace-v9');
    expect(workspace).toBeTruthy();
    const orderedSections = Array.from(workspace?.querySelectorAll(':scope > section, :scope > article, :scope > div') ?? []).map((node) => node.className.split(' ').filter(Boolean)).flat();
    expect(orderedSections).toEqual(expect.arrayContaining(['routing-top-grid', 'routing-models-grid']));
    expect(orderedSections.indexOf('routing-top-grid')).toBeLessThan(orderedSections.indexOf('routing-models-grid'));
  });

  it('exposes feature toggles inside their owning scenario cards', async () => {
    await act(async () => {
      host.root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const toggleLabels = Array.from(host.container.querySelectorAll('.scenario-card-head .scenario-card-toggle'));
    expect(toggleLabels.map((node) => node.textContent?.trim())).toEqual(expect.arrayContaining([
      '启用字幕翻译',
      '用二次字幕生成译音',
      '将翻译语音发送到虚拟麦克风',
      '文字转语音',
    ]));

    const switches = toggleLabels.map((label) => label.querySelector('input[type="checkbox"]'));
    expect(switches).toHaveLength(4);
    for (const node of switches) {
      expect(node?.getAttribute('role')).toBe('switch');
      expect(node?.getAttribute('aria-checked')).toBe('true');
    }
  });

  it('does not render the auto-save indicator', async () => {
    await act(async () => {
      host.root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    expect(host.container.querySelector('.routing-saved-indicator')).toBeNull();
  });

  it('has 2 panels in the top grid and 2 panels in the models grid', async () => {
    await act(async () => {
      host.root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    expect(host.container.querySelectorAll('.routing-top-grid > .routing-panel')).toHaveLength(2);
    expect(host.container.querySelectorAll('.routing-models-grid > .routing-panel')).toHaveLength(2);
  });

  it('groups secondary translation cards under card-level switches', async () => {
    await act(async () => {
      host.root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const secondaryGroup = host.container.querySelector('.routing-secondary-group') as HTMLElement | null;
    expect(secondaryGroup).toBeTruthy();
    expect(secondaryGroup?.textContent).toContain('字幕翻译');
    expect(secondaryGroup?.textContent).toContain('听对方 · 二次字幕译音');
    const switches = secondaryGroup?.querySelectorAll('input[role="switch"]') ?? [];
    expect(switches).toHaveLength(2);
    for (const node of Array.from(switches) as HTMLInputElement[]) {
      expect(node.checked).toBe(true);
    }
  });
});

