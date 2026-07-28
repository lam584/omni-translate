import { describe, expect, it } from 'vitest';

import { appConfigDraftMock } from '../mocks/app-config';
import committedFixtureRaw from '../../src-tauri/fixtures/desktop-api-v2-commands.json?raw';
import { DesktopApiV2, type InvokeFn } from './desktop-api-v2';

// Wire-level pin for the renderer→shell command direction. The literal JSON
// this class emits for every v2 envelope is committed as a fixture that
// `cargo test renderer_command_payloads_deserialize_into_the_v2_enums`
// deserializes into the real Rust command enums — so a TS-side rename (action
// or payload field) fails the Rust round-trip even when tsc cannot see it.
//
// Regenerate deliberately with:
//   OMNI_UPDATE_API_V2_FIXTURE=1 npx vitest run src/runtime/desktop-api-v2.fixture.test.ts
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
    ['diagnostics.liveSessionEvents', () => api.diagnostics.liveSessionEvents()],
    ['diagnostics.snapshot', () => api.diagnostics.snapshot()],
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
      'diagnostics_v2:export',
      'diagnostics_v2:liveSessionEvents',
      'diagnostics_v2:overlaySelfCheck',
      'diagnostics_v2:selfCheck',
      'diagnostics_v2:snapshot',
      'provider_v2:fetchModels',
      'provider_v2:probe',
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
