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
    await api.session.startAudioRoute('inbound', config);
    await api.bridge.snapshot();
    await api.bridge.refresh();
    await api.bridge.start(config);
    await api.bridge.stop();
    await api.bridge.install(config);
    await api.bridge.uninstall();
    await api.bridge.repair('restart-bridge', config);
    await api.legacyBridge.start(config);
    await api.diagnostics.selfCheck();
    await api.diagnostics.overlaySelfCheck();
    await api.diagnostics.export('summary');
    await api.diagnostics.liveSessionEvents();
    await api.diagnostics.snapshot();
    await api.configuration.load();
    await api.configuration.save(config);
    await api.configuration.reset();
    await api.configuration.import('C:/config.json');
    await api.configuration.createSnapshot('test');
    await api.configuration.rollback('snapshot-1');
    await api.configuration.bootstrapStorage();
    await api.configuration.runtimeSnapshot();
    await api.configuration.bootstrapRuntime();
    await api.runtime.debugIpcPing();
    await api.runtime.bootstrapAudio();
    await api.overlay.sync(true, false, true);
    await api.overlay.unlock();
    await api.overlay.toggle();
    await api.overlay.show();
    const benchmarkPayload = {
      model: 'model-test',
      apiKey: 'api-key-test',
      mp3Path: 'C:/audio/sample.mp3',
      runId: 'benchmark-run-1',
    };
    await api.benchmark.runModelBenchmark(benchmarkPayload);
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
      'configuration_v2',
      { command: { action: 'secretUpsert', reference: 'secret-ref', secret: 'secret-value' } },
    ]);
    expect(calls).toContainEqual(['start_audio_route', { direction: 'inbound', config }]);
    expect(calls).toContainEqual(['start_bridge_service', { config }]);
    expect(calls).toContainEqual(['diagnostics_v2', { command: { action: 'snapshot' } }]);
    expect(calls).toContainEqual(['diagnostics_v2', { command: { action: 'liveSessionEvents' } }]);
    expect(calls).toContainEqual(['debug_ipc_ping', undefined]);
    expect(calls).toContainEqual(['session_v2', { command: { action: 'bootstrap' } }]);
    expect(calls).toContainEqual(['configuration_v2', { command: { action: 'runtimeSnapshot' } }]);
    expect(calls).toContainEqual(['configuration_v2', { command: { action: 'bootstrapRuntime' } }]);
    expect(calls).toContainEqual(['bootstrap_storage', undefined]);
    expect(calls).toContainEqual([
      'sync_subtitle_overlay_window_state',
      { locked: true, rounded: false, hotspotInteractive: true },
    ]);
    expect(calls).toContainEqual(['unlock_subtitle_overlay', undefined]);
    expect(calls).toContainEqual(['toggle_subtitle_overlay', undefined]);
    expect(calls).toContainEqual(['show_subtitle_overlay', undefined]);
    expect(calls).toContainEqual([
      'provider_v2',
      { command: { action: 'runModelBenchmark', ...benchmarkPayload } },
    ]);
    expect(calls).toHaveLength(48);
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

  it('does not fail a completed popup action when native menu cleanup rejects', async () => {
    windowMocks.close.mockRejectedValueOnce(new Error('already closed'));
    const api = new DesktopApiV2(vi.fn());

    await expect(api.window.popupMenu([], { x: 0, y: 0 })).resolves.toBeUndefined();
  });

  it('isolates 300 concurrent IPC requests under mixed success and failure pressure', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: number[] = [];
    const invoke: InvokeFn = async <T>(_command: string, args?: Record<string, unknown>) => {
      const requestId = Number(String(args?.reference ?? calls.length).replace('stress-', ''));
      calls.push(requestId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      if (requestId % 17 === 0) throw new Error(`ipc-${requestId}`);
      return { data: { requestId }, warnings: [] } as T;
    };
    const api = new DesktopApiV2(invoke);

    const results = await Promise.allSettled(Array.from({ length: 300 }, (_, requestId) =>
      api.credentials.read(`stress-${requestId}`) as unknown as Promise<{ requestId: number }>));

    expect(maxInFlight).toBe(300);
    expect(calls).toHaveLength(300);
    expect(new Set(calls).size).toBe(300);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(282);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(18);
    expect(results[17]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'ipc-17' }) });
    expect(results[299]).toMatchObject({ status: 'fulfilled', value: { requestId: 299 } });
  });
});
