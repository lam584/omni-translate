import { describe, expect, it, vi } from 'vitest';

import { appConfigDraftMock } from '../mocks/app-config';
import committedFixtureRaw from '../../src-tauri/fixtures/desktop-api-v2-commands.json?raw';
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
    await api.diagnostics.watchSessionReport();
    await api.diagnostics.clearWatchSessionReport();
    await api.diagnostics.snapshot();
    await api.diagnostics.appendLogs([], 2);
    await api.diagnostics.setLogLevel('warning');
    await api.diagnostics.openExportDirectory('C:/exports/report.json');
    await api.diagnostics.openExternalUrl('https://platform.openai.com/api-keys');
    await api.diagnostics.writeExportArtifact('report.json', '{}');
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
    expect(calls).toContainEqual(['diagnostics_v2', { command: { action: 'watchSessionReport' } }]);
    expect(calls).toContainEqual(['diagnostics_v2', { command: { action: 'clearWatchSessionReport' } }]);
    expect(calls).toContainEqual(['append_frontend_diagnostics_logs', { entries: [], droppedCount: 2 }]);
    expect(calls).toContainEqual(['set_diagnostics_log_level', { level: 'warning' }]);
    expect(calls).toContainEqual(['diagnostics_v2', {
      command: { action: 'openExportDirectory', outputPath: 'C:/exports/report.json' },
    }]);
    expect(calls).toContainEqual(['diagnostics_v2', {
      command: { action: 'writeExportArtifact', filename: 'report.json', content: '{}' },
    }]);
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
    expect(calls).toHaveLength(54);
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

// Wire-level pin for the renderer→shell command direction. The literal JSON
// this class emits for every v2 envelope is committed as a fixture that
// `cargo test renderer_command_payloads_deserialize_into_the_v2_enums`
// deserializes into the real Rust command enums — so a TS-side rename (action
// or payload field) fails the Rust round-trip even when tsc cannot see it.
//
// Regenerate deliberately with:
//   OMNI_UPDATE_API_V2_FIXTURE=1 npx vitest run src/runtime/desktop-api-v2.test.ts
// then re-run `npm run test:desktop-shell` to prove the new payloads still
// deserialize.

type FixtureEntry = {
  label: string;
  command: string;
  payload: Record<string, unknown>;
};

async function collectEmittedCommands(): Promise<FixtureEntry[]> {
  const entries: FixtureEntry[] = [];
  let currentLabel = '';
  const recordingInvoke: InvokeFn = <T,>(command: string, args?: Record<string, unknown>) => {
    // Mirror the IPC boundary: JSON round-trip drops `undefined` members the
    // same way the real serializer does.
    entries.push({
      label: currentLabel,
      command,
      payload: JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>,
    });
    return Promise.resolve({ data: undefined, warnings: [] } as T);
  };
  const api = new DesktopApiV2(recordingInvoke);
  const config = structuredClone(appConfigDraftMock);
  const provider = structuredClone(appConfigDraftMock.providers[0]);

  const calls: Array<[string, () => Promise<unknown>]> = [
    ['provider.resolveRealtimeProfile', () => api.provider.resolveRealtimeProfile(config, config.devices.inboundVoiceModelId)],
    ['provider.fetchModels', () => api.provider.fetchModels(provider)],
    ['provider.probe', () => api.provider.probe(provider)],
    ['provider.smoke', () => api.provider.smoke(provider, 'hello', 'en', 'zh-CN')],
    ['benchmark.runModelBenchmark', () => api.benchmark.runModelBenchmark({
      model: 'qwen3.5-omni-plus-realtime',
      apiKey: 'fixture-api-key',
      mp3Path: 'C:/fixtures/sample.mp3',
      runId: 'fixture-run-1',
      realtimeAudioMode: 'server_vad',
      interactionCapabilities: ['auto_vad', 'streaming'],
      providerKind: 'dashscope',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      authHeaderName: 'Authorization',
      authScheme: 'bearer',
    })],
    ['session.snapshot', () => api.session.snapshot()],
    ['session.refreshDevices', () => api.session.refreshDevices()],
    ['session.preconnect', () => api.session.preconnect(config)],
    ['session.cancelPreconnect', () => api.session.cancelPreconnect()],
    ['session.prewarmRoutes', () => api.session.prewarmRoutes(config)],
    ['session.startRoute', () => api.session.startRoute('inbound', config)],
    ['session.stopRoute', () => api.session.stopRoute('inbound')],
    ['session.clearCues', () => api.session.clearCues()],
    ['session.startSpeech', () => api.session.startSpeech(config)],
    ['session.stopSpeech', () => api.session.stopSpeech()],
    ['session.startTranslation', () => api.session.startTranslation(config)],
    ['session.stopTranslation', () => api.session.stopTranslation()],
    ['session.syncOverlayRegion', () => api.session.syncOverlayRegion(true)],
    ['session.syncOverlayWindowState', () => api.session.syncOverlayWindowState(true, true, false)],
    ['runtime.bootstrapAudio', () => api.runtime.bootstrapAudio()],
    ['bridge.snapshot', () => api.bridge.snapshot()],
    ['bridge.refresh', () => api.bridge.refresh()],
    ['bridge.start', () => api.bridge.start(config)],
    ['bridge.stop', () => api.bridge.stop()],
    ['bridge.install', () => api.bridge.install(config)],
    ['bridge.uninstall', () => api.bridge.uninstall()],
    ['bridge.repair', () => api.bridge.repair('restart-bridge', config)],
    ['diagnostics.selfCheck', () => api.diagnostics.selfCheck()],
    ['diagnostics.overlaySelfCheck', () => api.diagnostics.overlaySelfCheck()],
    ['diagnostics.export', () => api.diagnostics.export('full')],
    ['diagnostics.watchSessionReport', () => api.diagnostics.watchSessionReport()],
    ['diagnostics.clearWatchSessionReport', () => api.diagnostics.clearWatchSessionReport()],
    ['diagnostics.snapshot', () => api.diagnostics.snapshot()],
    ['diagnostics.openExternalUrl', () => api.diagnostics.openExternalUrl('https://platform.openai.com/api-keys')],
    ['configuration.load', () => api.configuration.load()],
    ['configuration.save', () => api.configuration.save(config)],
    ['configuration.reset', () => api.configuration.reset()],
    ['configuration.export', () => api.configuration.export()],
    ['configuration.import', () => api.configuration.import('C:/fixtures/config.json')],
    ['configuration.createSnapshot', () => api.configuration.createSnapshot('fixture snapshot')],
    ['configuration.rollback', () => api.configuration.rollback('snapshot-1')],
    ['configuration.runtimeSnapshot', () => api.configuration.runtimeSnapshot()],
    ['configuration.bootstrapRuntime', () => api.configuration.bootstrapRuntime()],
    ['credentials.status', () => api.credentials.status('credential://provider/dashscope/default')],
    ['credentials.read', () => api.credentials.read('credential://provider/dashscope/default')],
    ['credentials.save', () => api.credentials.save('credential://provider/dashscope/default', 'fixture-secret')],
  ];

  for (const [label, run] of calls) {
    currentLabel = label;
    await run();
  }
  return entries;
}

describe('desktop-api-v2 command fixture (renderer→shell wire pin)', () => {
  it('emits exactly the committed v2 command payloads', async () => {
    const emitted = await collectEmittedCommands();
    const serialized = `${JSON.stringify(emitted, null, 2)}\n`;

    if (typeof process !== 'undefined' && process?.env.OMNI_UPDATE_API_V2_FIXTURE === '1') {
      const { writeFileSync } = await import('node:fs');
      // Relative to the vitest working directory (apps/desktop) — run the
      // regeneration from there, as the header instructs.
      writeFileSync('src-tauri/fixtures/desktop-api-v2-commands.json', serialized);
      return;
    }

    expect(
      serialized.replace(/\r\n/g, '\n'),
      'desktop-api-v2 emits different command payloads than the committed fixture; '
        + 'if the change is intentional, regenerate with OMNI_UPDATE_API_V2_FIXTURE=1 '
        + 'and re-run cargo test to prove the Rust enums still deserialize them',
    ).toBe(committedFixtureRaw.replace(/\r\n/g, '\n'));
  });

  it('covers every v2 envelope action exactly once per service', async () => {
    const emitted = await collectEmittedCommands();
    const v2Entries = emitted.filter((entry) => entry.command.endsWith('_v2'));
    const seen = new Set<string>();
    for (const entry of v2Entries) {
      const action = (entry.payload.command as { action?: string } | undefined)?.action;
      expect(action, `entry ${entry.label} must carry an action`).toMatch(/\S/);
      const key = `${entry.command}:${action}`;
      expect(seen.has(key), `duplicate fixture entry for ${key}`).toBe(false);
      seen.add(key);
    }
    // Every action variant of the five Rust enums must appear (the cargo
    // round-trip only proves what the fixture contains). Adding a variant on
    // either side must extend this ledger together with the fixture.
    expect([...seen].sort()).toEqual([
      'bridge_v2:install',
      'bridge_v2:refresh',
      'bridge_v2:repair',
      'bridge_v2:snapshot',
      'bridge_v2:start',
      'bridge_v2:stop',
      'bridge_v2:uninstall',
      'configuration_v2:bootstrapRuntime',
      'configuration_v2:createSnapshot',
      'configuration_v2:export',
      'configuration_v2:import',
      'configuration_v2:load',
      'configuration_v2:reset',
      'configuration_v2:rollback',
      'configuration_v2:runtimeSnapshot',
      'configuration_v2:save',
      'configuration_v2:secretRead',
      'configuration_v2:secretStatus',
      'configuration_v2:secretUpsert',
      'diagnostics_v2:clearWatchSessionReport',
      'diagnostics_v2:export',
      'diagnostics_v2:openExternalUrl',
      'diagnostics_v2:overlaySelfCheck',
      'diagnostics_v2:selfCheck',
      'diagnostics_v2:snapshot',
      'diagnostics_v2:watchSessionReport',
      'provider_v2:fetchModels',
      'provider_v2:probe',
      'provider_v2:resolveRealtimeProfile',
      'provider_v2:runModelBenchmark',
      'provider_v2:smoke',
      'session_v2:bootstrap',
      'session_v2:cancelPreconnect',
      'session_v2:clearCues',
      'session_v2:preconnect',
      'session_v2:prewarmRoutes',
      'session_v2:refreshDevices',
      'session_v2:snapshot',
      'session_v2:startRoute',
      'session_v2:startSpeech',
      'session_v2:startTranslation',
      'session_v2:stopRoute',
      'session_v2:stopSpeech',
      'session_v2:stopTranslation',
      'session_v2:syncOverlayRegion',
      'session_v2:syncOverlayWindowState',
    ]);
  });
});
