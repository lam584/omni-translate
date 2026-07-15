import { describe, expect, it, vi } from 'vitest';
import { DesktopApiV2, type InvokeFn } from './desktop-api-v2';

const windowMocks = vi.hoisted(() => ({
  currentMonitor: vi.fn(async () => ({ workArea: { position: { x: 1, y: 2 }, size: { width: 3, height: 4 } } })),
  cursorPosition: vi.fn(async () => ({ x: 5, y: 6 })),
  outerPosition: vi.fn(async () => ({ x: 7, y: 8 })),
  outerSize: vi.fn(async () => ({ width: 9, height: 10 })),
  scaleFactor: vi.fn(async () => 1.5),
  setPosition: vi.fn(async () => undefined),
  setSize: vi.fn(async () => undefined),
  popup: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  menuNew: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  currentMonitor: windowMocks.currentMonitor,
  cursorPosition: windowMocks.cursorPosition,
  getCurrentWindow: () => ({
    outerPosition: windowMocks.outerPosition,
    outerSize: windowMocks.outerSize,
    scaleFactor: windowMocks.scaleFactor,
    setPosition: windowMocks.setPosition,
    setSize: windowMocks.setSize,
  }),
  PhysicalPosition: class PhysicalPosition { constructor(public x: number, public y: number) {} },
}));

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: class LogicalPosition { constructor(public x: number, public y: number) {} },
  LogicalSize: class LogicalSize { constructor(public width: number, public height: number) {} },
}));

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: {
    new: windowMocks.menuNew.mockImplementation(async () => ({
      popup: windowMocks.popup,
      close: windowMocks.close,
    })),
  },
}));

describe('DesktopApiV2 configuration client', () => {
  it('uses the V2 envelope for configuration export and snapshots', async () => {
    const response = {
      data: {
        filePath: 'C:/exports/config.json',
        exportedAt: 'unix:1',
        configContractVersion: 2,
        snapshotCount: 3,
      },
      warnings: [],
    };
    const invokeSpy = vi.fn();
    const invoke: InvokeFn = async <T>(command: string, args?: Record<string, unknown>) => {
      invokeSpy(command, args);
      return response as T;
    };
    const api = new DesktopApiV2(invoke);

    const exported = await api.configuration.export();

    expect(exported.configContractVersion).toBe(2);
    expect(invokeSpy).toHaveBeenCalledWith('configuration_v2', {
      command: { action: 'export' },
    });
  });

  it('routes every service capability through its stable command boundary', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const invoke: InvokeFn = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      if (command === 'provider_v2' || command.endsWith('_v2')) {
        return { data: { ok: true }, warnings: [] } as T;
      }
      return { ok: true } as T;
    };
    const api = new DesktopApiV2(invoke);
    const provider = { providerId: 'provider-test' } as never;
    const config = { providers: [] } as never;

    await api.provider.fetchModels(provider);
    await api.provider.probe(provider);
    await api.provider.smoke(provider, 'hello', 'en', 'zh-CN');
    await api.session.snapshot();
    await api.session.refreshDevices();
    await api.session.preconnect(config);
    await api.session.startRoute('inbound', config);
    await api.session.stopRoute('inbound');
    await api.session.clearCues();
    await api.session.startSpeech(config);
    await api.session.stopSpeech();
    await api.session.startTranslation(config);
    await api.session.stopTranslation();
    await api.session.syncOverlayRegion();
    await api.session.syncOverlayWindowState(true, false, true);
    await api.bridge.snapshot();
    await api.bridge.refresh();
    await api.bridge.start(config);
    await api.bridge.stop();
    await api.bridge.install(config);
    await api.bridge.uninstall();
    await api.bridge.repair('restart-bridge', config);
    await api.diagnostics.selfCheck();
    await api.diagnostics.overlaySelfCheck();
    await api.diagnostics.export('summary');
    await api.diagnostics.liveSessionEvents();
    await api.configuration.load();
    await api.configuration.save(config);
    await api.configuration.reset();
    await api.configuration.import('C:/config.json');
    await api.configuration.createSnapshot('test');
    await api.configuration.rollback('snapshot-1');
    await api.configuration.bootstrapStorage();
    await api.configuration.runtimeSnapshot();
    await api.configuration.bootstrapRuntime();
    await api.persistence.saveDraft(config);
    await api.persistence.loadDraft();
    await api.persistence.deleteDraft();
    await api.persistence.availableCommands();
    await api.runtime.invoke('custom_command', { value: 1 });
    await api.credentials.status('secret-ref');
    await api.credentials.read('secret-ref');
    await api.credentials.save('secret-ref', 'secret-value');

    expect(calls).toContainEqual([
      'session_v2',
      { command: { action: 'syncOverlayRegion', rounded: true } },
    ]);
    expect(calls).toContainEqual([
      'diagnostics_v2',
      { command: { action: 'export', scope: 'summary' } },
    ]);
    expect(calls).toContainEqual([
      'upsert_secret_ref',
      { reference: 'secret-ref', secret: 'secret-value' },
    ]);
    expect(calls).toHaveLength(43);
  });

  it('adapts native window coordinates, sizing and popup menus', async () => {
    const api = new DesktopApiV2(vi.fn());
    const action = vi.fn();

    await expect(api.window.currentMonitor()).resolves.toMatchObject({ workArea: { position: { x: 1 } } });
    await expect(api.window.cursorPosition()).resolves.toEqual({ x: 5, y: 6 });
    await expect(api.window.outerPosition()).resolves.toEqual({ x: 7, y: 8 });
    await expect(api.window.outerSize()).resolves.toEqual({ width: 9, height: 10 });
    await expect(api.window.scaleFactor()).resolves.toBe(1.5);
    await api.window.setPosition({ x: 11, y: 12 });
    await api.window.setLogicalSize({ width: 13, height: 14 });
    await api.window.popupMenu([{ id: 'inspect', text: 'Inspect', action }], { x: 15, y: 16 });

    expect(windowMocks.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 11, y: 12 }));
    expect(windowMocks.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 13, height: 14 }));
    expect(windowMocks.menuNew).toHaveBeenCalledWith({
      items: [{ id: 'inspect', text: 'Inspect', action }],
    });
    expect(windowMocks.popup).toHaveBeenCalled();
    expect(windowMocks.close).toHaveBeenCalled();
  });
});
