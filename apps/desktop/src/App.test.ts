import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, { buildWatchModeDiagnosticAutostartConfig, isWatchModeDiagnosticAutostartAllowed } from './App';
import { startAudioRouteRuntime } from './runtime/audio-runtime';
import { startBridgeServiceRuntime } from './runtime/bridge-runtime';
import { appendFrontendDiagnosticsLog } from './runtime/diagnostics-runtime';
import type { AppConfigDraft } from './schema/config';
import type { BootstrapStepId, OnBootstrapStep } from './runtime/desktop-runtime';

const appMocks = vi.hoisted(() => ({
  bootstrapCleanup: vi.fn(),
  bootstrapDesktopRuntimeBridge: vi.fn(),
  scheduleBridgeAutostartAfterStartup: vi.fn().mockReturnValue({ cleanup: vi.fn(), promise: Promise.resolve() }),
  hasCompletedWelcome: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  RouterProvider: () => null,
}));

vi.mock('./router', () => ({
  router: {},
}));

vi.mock('./i18n/config', () => ({
  default: {
    t: (key: string) => key,
  },
  getCurrentLanguage: () => 'zh-CN',
  hasCompletedWelcome: () => appMocks.hasCompletedWelcome(),
}));

vi.mock('./runtime/desktop-runtime', () => ({
  bootstrapDesktopRuntimeBridge: (...args: Parameters<typeof appMocks.bootstrapDesktopRuntimeBridge>) =>
    appMocks.bootstrapDesktopRuntimeBridge(...args),
  scheduleBridgeAutostartAfterStartup: (...args: Parameters<typeof appMocks.scheduleBridgeAutostartAfterStartup>) =>
    appMocks.scheduleBridgeAutostartAfterStartup(...args),
  scheduleCapturePrewarmAfterStartup: vi.fn().mockReturnValue({ cleanup: vi.fn(), promise: Promise.resolve() }),
}));

vi.mock('./runtime/audio-runtime', () => ({
  startAudioRouteRuntime: vi.fn(),
}));

vi.mock('./runtime/bridge-runtime', () => ({
  startBridgeServiceRuntime: vi.fn(),
}));

vi.mock('./runtime/diagnostics-runtime', () => ({
  appendFrontendDiagnosticsLog: vi.fn(),
}));

vi.mock('./components/welcome/WelcomeLanguagePicker', () => ({
  default: () => null,
}));

describe('watch mode diagnostic autostart gate', () => {
  const nowMs = 1780596000000;

  it('requires an explicit unexpired diagnostic marker', () => {
    expect(
      isWatchModeDiagnosticAutostartAllowed(
        {
          VITE_OMNI_WATCH_MODE_AUTOSTART: '1',
          VITE_OMNI_WATCH_MODE_RUN_MARKER: 'watch_mode_diagnostic.run_id=abc',
          VITE_OMNI_WATCH_MODE_EXPIRES_AT_MS: String(nowMs + 1000),
        },
        nowMs,
      ),
    ).toBe(true);

    expect(isWatchModeDiagnosticAutostartAllowed({ VITE_OMNI_WATCH_MODE_AUTOSTART: '1' }, nowMs)).toBe(false);
    expect(
      isWatchModeDiagnosticAutostartAllowed(
        {
          VITE_OMNI_WATCH_MODE_AUTOSTART: '1',
          VITE_OMNI_WATCH_MODE_RUN_MARKER: 'watch_mode_diagnostic.run_id=abc',
          VITE_OMNI_WATCH_MODE_EXPIRES_AT_MS: String(nowMs - 1),
        },
        nowMs,
      ),
    ).toBe(false);
  });
});

describe('App bootstrap shell', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    delete (import.meta.env as Record<string, string | undefined>).VITE_OMNI_WATCH_MODE_AUTOSTART;
    delete (import.meta.env as Record<string, string | undefined>).VITE_OMNI_WATCH_MODE_RUN_MARKER;
    delete (import.meta.env as Record<string, string | undefined>).VITE_OMNI_WATCH_MODE_EXPIRES_AT_MS;
    appMocks.bootstrapCleanup.mockReset();
    appMocks.scheduleBridgeAutostartAfterStartup.mockReset().mockReturnValue({ cleanup: () => {}, promise: Promise.resolve() });
    appMocks.hasCompletedWelcome.mockReset().mockReturnValue(true);
    appMocks.bootstrapDesktopRuntimeBridge.mockReset().mockImplementation(async (onStep?: OnBootstrapStep) => {
      const stepIds: BootstrapStepId[] = ['detect-runtime', 'check-ipc', 'init-runtime', 'init-audio', 'load-config'];
      for (const stepId of stepIds) {
        onStep?.(stepId, 'done');
      }
      return appMocks.bootstrapCleanup;
    });
    vi.mocked(startAudioRouteRuntime).mockReset();
    vi.mocked(startBridgeServiceRuntime).mockReset();
    vi.mocked(appendFrontendDiagnosticsLog).mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = null;
    }
    container.remove();
    vi.useRealTimers();
  });

  it('boots the desktop runtime and cleans up the subscription on unmount', async () => {
    await act(async () => {
      root?.render(React.createElement(App));
    });

    expect(appMocks.bootstrapDesktopRuntimeBridge).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.bootstrap-overlay')).not.toBeNull();

    await act(async () => {
      vi.runOnlyPendingTimers();
    });

    expect(container.querySelector('.bootstrap-overlay')).toBeNull();

    await act(async () => root?.unmount());
    root = null;
    expect(appMocks.bootstrapCleanup).toHaveBeenCalledTimes(1);
  });

  it('closes the overlay when bootstrap settles without delivering every step', async () => {
    // 模拟晚订阅者只收到部分步骤、无法自行算出 allDone 的场景。
    appMocks.bootstrapDesktopRuntimeBridge.mockReset().mockImplementation(async (onStep?: OnBootstrapStep) => {
      onStep?.('detect-runtime', 'done');
      return appMocks.bootstrapCleanup;
    });

    await act(async () => {
      root?.render(React.createElement(App));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // 整体承诺已 settle，弹窗应被兜底关闭。
    expect(container.querySelector('.bootstrap-overlay')).toBeNull();
  });

  it('closes the overlay and logs the stuck step when bootstrap rejects', async () => {
    appMocks.bootstrapDesktopRuntimeBridge.mockReset().mockImplementation(async (onStep?: OnBootstrapStep) => {
      onStep?.('detect-runtime', 'done');
      onStep?.('check-ipc', 'active');
      throw new Error('bootstrap boom');
    });

    await act(async () => {
      root?.render(React.createElement(App));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.bootstrap-overlay')).toBeNull();
    expect(appendFrontendDiagnosticsLog).toHaveBeenCalledWith(
      'runtime',
      'warning',
      'startup.bootstrap_settled_forced_overlay_close',
      expect.stringContaining('stuckStep=check-ipc'),
    );
  });

  it('does not duplicate backend watch autostart from the frontend', async () => {
    const runMarker = 'watch_mode_diagnostic.run_id=app-test-autostart-skip';
    Object.assign(import.meta.env, {
      VITE_OMNI_WATCH_MODE_AUTOSTART: '1',
      VITE_OMNI_WATCH_MODE_RUN_MARKER: runMarker,
      VITE_OMNI_WATCH_MODE_EXPIRES_AT_MS: String(Date.now() + 60_000),
    });

    await act(async () => {
      root?.render(React.createElement(App));
      await Promise.resolve();
    });

    expect(startBridgeServiceRuntime).not.toHaveBeenCalled();
    expect(startAudioRouteRuntime).not.toHaveBeenCalled();
    expect(appendFrontendDiagnosticsLog).toHaveBeenCalledWith(
      'runtime',
      'info',
      'watch_mode.diagnostic_frontend_autostart_skipped',
      expect.stringContaining('backendAutostartAuthoritative=true'),
    );
  });

  it('dedupes the same watch autostart marker', async () => {
    const runMarker = 'watch_mode_diagnostic.run_id=app-test-autostart-dedupe';
    Object.assign(import.meta.env, {
      VITE_OMNI_WATCH_MODE_AUTOSTART: '1',
      VITE_OMNI_WATCH_MODE_RUN_MARKER: runMarker,
      VITE_OMNI_WATCH_MODE_EXPIRES_AT_MS: String(Date.now() + 60_000),
    });

    await act(async () => {
      root?.render(React.createElement(App));
      await Promise.resolve();
    });
    await act(async () => root?.unmount());
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(App));
      await Promise.resolve();
    });

    expect(startBridgeServiceRuntime).not.toHaveBeenCalled();
    expect(startAudioRouteRuntime).not.toHaveBeenCalled();
    expect(appendFrontendDiagnosticsLog).toHaveBeenCalledWith(
      'runtime',
      'info',
      'watch_mode.diagnostic_autostart_already_started',
      `runMarker=${runMarker}`,
    );
  });
});

describe('buildWatchModeDiagnosticAutostartConfig', () => {
  const baseConfig = {
    devices: {
      routeMode: 'video',
      inputDeviceId: 'default',
      outputDeviceId: '',
      virtualRenderDeviceId: '',
      playbackDeviceId: '',
      virtualMicState: 'pending' as const,
      inboundRoute: {
        routeId: '',
        direction: 'inbound' as const,
        input: { sourceId: '', kind: 'microphone' as const, deviceId: '', state: 'idle' as const, muted: false, bufferAheadMs: 0, preBufferState: 'primed' as const, processing: { inputLevel: 80, echoCancellationEnabled: false, noiseSuppressionEnabled: false, autoGainControlEnabled: false } },
        outputs: [],
        mixControl: { keepOriginalAudio: false, translatedAudioEnabled: false, translatedAudioGainDb: 0, translatedAudioAutoGainEnabled: true, originalAudioGainDb: 0, duckingEnabled: false, duckingDepthPercent: 0, monitorMode: 'original-only' as const },
        latencyControl: { captureBufferMs: 0, translationBufferMs: 0, playbackBufferMs: 0, compensationMs: 0 },
      },
      outboundRoute: {
        routeId: '',
        direction: 'outbound' as const,
        input: { sourceId: '', kind: 'microphone' as const, deviceId: '', state: 'idle' as const, muted: false, bufferAheadMs: 0, preBufferState: 'primed' as const, processing: { inputLevel: 80, echoCancellationEnabled: false, noiseSuppressionEnabled: false, autoGainControlEnabled: false } },
        outputs: [],
        mixControl: { keepOriginalAudio: false, translatedAudioEnabled: false, translatedAudioGainDb: 0, translatedAudioAutoGainEnabled: false, originalAudioGainDb: 0, duckingEnabled: false, duckingDepthPercent: 0, monitorMode: 'original-only' as const },
        latencyControl: { captureBufferMs: 0, translationBufferMs: 0, playbackBufferMs: 0, compensationMs: 0 },
        pushToTalk: { enabled: false, hotkey: '', state: 'idle' as const, releaseDelayMs: 0 },
      },
      supportProfileId: '',
      inboundVoiceModelId: '',
      outboundVoiceModelId: '',
      textToSpeechModelId: '',
      subtitleTranslationMode: 'native' as const,
      subtitleTranslationModelId: '',
      inboundSecondaryAudioModelId: '',
      inputLevel: 80,
      aecEnabled: false,
      ansEnabled: false,
      agcEnabled: false,
      outputLevel: 80,
      outputSpeechEnabled: false,
      outputSubtitlesEnabled: false,
      virtualMicOutputEnabled: false,
      feedbackLoopPrevention: 'none' as const,
      status: 'draft' as const,
    },
    speech: {
      enabled: false,
      targetLanguage: 'zh-CN',
      voicePresetId: '',
      textToSpeechModelId: '',
      voice: '',
      outputTarget: 'virtual-mic' as const,
      localPlaybackEnabled: false,
      virtualMicOutputEnabled: false,
      translationAudioSource: 'auto' as const,
      dispatchState: 'idle' as const,
      status: 'draft' as const,
    },
  } as const;

  it('sets secondary subtitle translation and TTS model defaults from env', () => {
    const env = {
      VITE_OMNI_WATCH_MODE_OUTPUT_DEVICE_ID: 'test-speaker',
      VITE_OMNI_WATCH_MODE_OUTPUT_LEVEL: '60',
    };
    const config = buildWatchModeDiagnosticAutostartConfig(baseConfig as unknown as AppConfigDraft, env);
    expect(config.devices.routeMode).toBe('watch');
    expect(config.devices.outputDeviceId).toBe('test-speaker');
    expect(config.devices.outputLevel).toBe(60);
    expect(config.devices.feedbackLoopPrevention).toBe('virtual-driver');
    expect(config.devices.subtitleTranslationMode).toBe('secondary');
    expect(config.devices.subtitleTranslationModelId).toBe(
      'template-dashscope-realtime::qwen3.6-flash-2026-04-16',
    );
    expect(config.devices.inboundSecondaryAudioModelId).toBe('template-dashscope-realtime::qwen3.5-omni-plus-realtime');
    expect(config.devices.textToSpeechModelId).toBe('template-dashscope-realtime::qwen3.5-omni-plus-realtime');
    expect(config.devices.inboundRoute.mixControl.keepOriginalAudio).toBe(true);
    expect(config.devices.inboundRoute.mixControl.translatedAudioEnabled).toBe(true);
    expect(config.devices.inboundRoute.mixControl.originalAudioGainDb).toBe(-4);
    expect(config.devices.inboundRoute.mixControl.translatedAudioGainDb).toBe(0);
    expect(config.devices.inboundRoute.mixControl.translatedAudioAutoGainEnabled).toBe(true);
    expect(config.devices.inboundRoute.mixControl.duckingEnabled).toBe(true);
    expect(config.devices.inboundRoute.mixControl.monitorMode).toBe('original-and-translated');
    expect(config.speech.textToSpeechModelId).toBe('template-dashscope-realtime::qwen3.5-omni-plus-realtime');
    expect(config.speech.outputTarget).toBe('speaker');
    expect(config.speech.localPlaybackEnabled).toBe(true);
    expect(config.speech.virtualMicOutputEnabled).toBe(false);
    expect(config.speech.translationAudioSource).toBe('subtitle-tts');
    expect(config.devices.outputSpeechEnabled).toBe(true);
    expect(config.speech.enabled).toBe(true);
  });

  it('accepts explicit env overrides for subtitle and secondary models', () => {
    const env = {
      VITE_OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID: 'template-deepseek::deepseek-chat',
      VITE_OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID: 'template-dashscope-realtime::qwen3.5-omni-flash-realtime',
    };
    const config = buildWatchModeDiagnosticAutostartConfig(baseConfig as unknown as AppConfigDraft, env);
    expect(config.devices.subtitleTranslationModelId).toBe('template-deepseek::deepseek-chat');
    expect(config.devices.inboundSecondaryAudioModelId).toBe('template-dashscope-realtime::qwen3.5-omni-flash-realtime');
  });

  it('applies the echo-cancel feedback variant only for an explicit env opt-in', () => {
    const echoCancel = buildWatchModeDiagnosticAutostartConfig(baseConfig as unknown as AppConfigDraft, {
      VITE_OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION: 'echo-cancel',
    });
    expect(echoCancel.devices.feedbackLoopPrevention).toBe('echo-cancel');

    const invalidValue = buildWatchModeDiagnosticAutostartConfig(baseConfig as unknown as AppConfigDraft, {
      VITE_OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION: 'none',
    });
    expect(invalidValue.devices.feedbackLoopPrevention).toBe('virtual-driver');
  });

  it('applies watch model override when env provides VITE_OMNI_WATCH_MODE_MODEL_ID', () => {
    const env = { VITE_OMNI_WATCH_MODE_MODEL_ID: 'qwen3.5-omni-flash-realtime' };
    const config = buildWatchModeDiagnosticAutostartConfig(baseConfig as unknown as AppConfigDraft, env);
    expect(config.devices.inboundVoiceModelId).toBe('qwen3.5-omni-flash-realtime');
    expect(config.devices.outboundVoiceModelId).toBe('qwen3.5-omni-flash-realtime');
  });
});



