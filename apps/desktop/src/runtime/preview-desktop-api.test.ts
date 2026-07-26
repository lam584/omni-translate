import { describe, expect, it } from 'vitest';

import { appConfigDraftMock } from '../defaults/app-config';
import { audioRuntimeSnapshotMock } from '../defaults/audio-runtime';
import { defaultProviderProbeProfile } from '../defaults/provider-probes';
import type { AppConfigDraft, ProviderDraft } from '../schema/config';
import { PreviewDesktopApi, previewRoutingForVerdict } from './preview-desktop-api';

function draft(): AppConfigDraft {
  return structuredClone(appConfigDraftMock);
}

function providerDraft(): ProviderDraft {
  return structuredClone(appConfigDraftMock.providers[0]);
}

describe('PreviewDesktopApi', () => {
  it('advertises the browser-preview capability set', () => {
    expect(new PreviewDesktopApi().capabilities.hasNativeShell).toBe(false);
  });

  it('derives preview routing decisions for both probe verdicts', () => {
    expect(previewRoutingForVerdict('available')).toMatchObject({
      subtitlePriority: 'balanced',
      speechDisposition: 'ready',
    });
    expect(previewRoutingForVerdict('unavailable')).toMatchObject({
      subtitlePriority: 'subtitle-first',
      speechDisposition: 'deferred',
    });
  });

  it('binds and releases capture routes like the native session', async () => {
    const api = new PreviewDesktopApi();

    const started = await api.session.startRoute('inbound', draft());
    expect(started.inbound.captureState).toBe('capturing');
    expect(started.inbound.streamBound).toBe(true);
    expect(started.inbound.framesCaptured).toBeGreaterThan(audioRuntimeSnapshotMock.inbound.framesCaptured);

    // The watch-route readiness poll reads the bound stream from a later snapshot.
    const observed = await api.session.snapshot();
    expect(observed.inbound.streamBound).toBe(true);

    const stopped = await api.session.stopRoute('inbound');
    expect(stopped.inbound.captureState).toBe('buffering');
    expect(stopped.inbound.streamBound).toBe(false);

    const outbound = await api.session.startAudioRoute('outbound', draft());
    expect(outbound.outbound.captureState).toBe('capturing');
    const outboundStopped = await api.session.stopRoute('outbound');
    expect(outboundStopped.outbound.captureState).toBe('armed');
  });

  it('clears cues and drives the speech dispatch state machine', async () => {
    const api = new PreviewDesktopApi();

    const config = draft();
    const speaking = await api.session.startSpeech(config);
    expect(speaking.speech.dispatchState).toBe('playing');
    expect(speaking.speech.outputTarget).toBe(config.speech.outputTarget);

    const idle = await api.session.stopSpeech();
    expect(idle.speech.dispatchState).toBe('idle');
    expect(idle.speech.currentCueId).toBeNull();

    const cleared = await api.session.clearCues();
    expect(cleared.subtitleOverlay.recentCues).toEqual([]);
    expect(cleared.subtitleOverlay.activeCue).toBeNull();
    expect(cleared.speech.queueDepth).toBe(0);

    const translating = await api.session.startTranslation(config);
    expect(translating.sessionStartedAt).not.toBeNull();
    const stopped = await api.session.stopTranslation();
    expect(stopped.sessionStartedAt).toBeNull();
  });

  it('walks the bridge lifecycle through running, stopped and uninstalled states', async () => {
    const api = new PreviewDesktopApi();

    const running = await api.bridge.start(draft());
    expect(running.bridge.processStatus).toBe('running');
    expect(running.bridge.sessionId).toBe('browser-preview-session');
    expect(running.bridge.expectedDriverVersion).toBe(draft().driver.expectedDriverVersion);

    const stopped = await api.bridge.stop();
    expect(stopped.bridge.processStatus).toBe('stopped');
    expect(stopped.bridge.sessionId).toBeNull();

    const installed = await api.bridge.install(draft());
    expect(installed.bridge.driverHealth).toBe('running');
    expect(installed.bridge.driverVersion).toBe(draft().driver.expectedDriverVersion);

    const uninstalled = await api.bridge.uninstall();
    expect(uninstalled.bridge.driverHealth).toBe('not-installed');
    expect(uninstalled.bridge.lastErrorCode).toBe('driver.not-installed');

    const repairedStart = await api.bridge.repair('restart-bridge', draft());
    expect(repairedStart.bridge.processStatus).toBe('running');

    const legacyStarted = await api.legacyBridge.start(draft());
    expect(legacyStarted.bridge.processStatus).toBe('running');

    const snapshot = await api.bridge.snapshot();
    expect(snapshot.processStatus).toBe('running');
  });

  it('records diagnostics self-checks and exports into the runtime snapshot', async () => {
    const api = new PreviewDesktopApi();

    const checked = await api.diagnostics.selfCheck();
    expect(checked.diagnostics.status).toBe('ready');
    expect(checked.diagnostics.driverStatus).toBe('warning');
    expect(checked.diagnostics.lastSelfCheckAt).not.toBeNull();

    const artifact = await api.diagnostics.export('summary');
    expect(artifact.outputPath).toBe('browser-preview/diagnostics-summary.zip');
    expect(artifact.fileCount).toBe(3);
    const full = await api.diagnostics.export('full');
    expect(full.fileCount).toBe(6);

    const snapshot = await api.configuration.runtimeSnapshot();
    expect(snapshot.diagnostics.lastExportScope).toBe('full');
    expect(snapshot.diagnostics.lastExportPath).toBe('browser-preview/diagnostics-full.zip');

    expect(await api.diagnostics.snapshot()).toEqual({ recentLogs: [] });
    expect(await api.diagnostics.liveSessionEvents()).toEqual({});
    await expect(api.diagnostics.appendLogs([], 0)).resolves.toBeUndefined();
    await expect(api.diagnostics.setLogLevel('info')).resolves.toBeUndefined();
  });

  it('round-trips the config draft and rejects operations without preview meaning', async () => {
    const api = new PreviewDesktopApi();

    const loaded = await api.configuration.load();
    expect(loaded).toEqual(appConfigDraftMock);

    const next = draft();
    next.subtitles.overlayFontSize = 44;
    await api.configuration.save(next);
    expect((await api.configuration.load()).subtitles.overlayFontSize).toBe(44);

    const reset = await api.configuration.reset();
    expect(reset).toEqual(appConfigDraftMock);

    await expect(api.configuration.export()).rejects.toThrow('browser-preview');
    await expect(api.configuration.import('C:/x.json')).rejects.toThrow('browser-preview');
    await expect(api.configuration.createSnapshot()).rejects.toThrow('browser-preview');
    await expect(api.configuration.rollback('snap')).rejects.toThrow('browser-preview');
    await expect(api.runtime.debugIpcPing()).rejects.toThrow('browser-preview');
    await expect(api.benchmark.runModelBenchmark({ model: 'm', apiKey: 'k', mp3Path: 'p', runId: 'r' })).rejects.toThrow();
  });

  it('serves browser-preview credentials without storing secrets', async () => {
    const api = new PreviewDesktopApi();

    expect(await api.credentials.status('ref')).toEqual({ reference: 'ref', backend: 'browser-preview', hasSecret: false });
    expect(await api.credentials.save('ref', 'secret')).toEqual({ reference: 'ref', backend: 'browser-preview', hasSecret: true });
    expect(await api.credentials.save('ref', '')).toEqual({ reference: 'ref', backend: 'browser-preview', hasSecret: false });
    // Deliberately stateless: a later status probe still reports no secret.
    expect(await api.credentials.status('ref')).toEqual({ reference: 'ref', backend: 'browser-preview', hasSecret: false });
    expect(await api.credentials.read('ref')).toEqual({ reference: 'ref', backend: 'browser-preview', secret: null });
  });

  it('answers provider catalog, probe and smoke calls with preview profiles', async () => {
    const api = new PreviewDesktopApi();
    const provider = providerDraft();

    const catalog = await api.provider.fetchModels(provider, [
      { model: 'preview-model', displayName: 'Preview', capabilities: [] } as never,
    ]);
    expect(catalog.providerId).toBe(provider.providerId);
    expect(catalog.endpoint).toBe(`${provider.baseUrl.replace(/\/$/, '')}/models`);
    expect(catalog.models[0]).toMatchObject({ id: 'preview-model', ownedBy: 'preset' });

    const probe = await api.provider.probe(provider);
    expect(probe.id).toBe(defaultProviderProbeProfile.id);
    expect(probe.transportRequested).toBe(provider.transport);
    expect(probe.error).toBeNull();

    const smoke = await api.provider.smoke(provider, 'hello', 'en', 'zh-CN');
    expect(smoke.requestId).toBe('browser-preview-smoke');
    expect(smoke.sourceLanguage).toBe('en');
    expect(smoke.targetLanguage).toBe('zh-CN');
    expect(smoke.status).toBe('completed');
  });

  it('toggles and shows the subtitle overlay window in the runtime snapshot', async () => {
    const api = new PreviewDesktopApi();

    const shown = await api.overlay.show();
    expect(shown.windows.find((item) => item.label === 'subtitle-overlay')?.visible).toBe(true);

    const toggled = await api.overlay.toggle();
    expect(toggled.windows.find((item) => item.label === 'subtitle-overlay')?.visible).toBe(false);

    await expect(api.overlay.sync(true, true, false)).resolves.toBeUndefined();
    await expect(api.overlay.unlock()).resolves.toBeUndefined();
  });

  it('keeps native window geometry out of the preview surface', async () => {
    const api = new PreviewDesktopApi();

    expect(await api.window.currentMonitor()).toBeNull();
    await expect(api.window.cursorPosition()).rejects.toThrow('browser-preview');
    await expect(api.window.setPosition({ x: 0, y: 0 })).resolves.toBeUndefined();
    await expect(api.window.popupMenu([], { x: 0, y: 0 })).resolves.toBeUndefined();
    expect(await api.runtime.bootstrapAudio()).toEqual(audioRuntimeSnapshotMock);
  });
});
