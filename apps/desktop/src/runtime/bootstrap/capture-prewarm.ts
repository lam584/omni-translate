import type { AppConfigDraft } from '../../schema/config';
import { useAppStore } from '../../stores/app-store';
import { prewarmCaptureRoutesRuntime, preconnectOmniRealtimeRuntime } from '../audio-runtime';
import { scheduleStartupTask } from './schedule';
import { shouldSuppressGenericStartupAutostart } from './watch-mode';

// Capture-device pre-warming runs on the same idle window as bridge autostart:
// pre-open WASAPI devices so a later watch/conversation click only pays
// `start_stream`, not the full device open. Best-effort and non-blocking.
export const CAPTURE_PREWARM_AFTER_READY_DELAY_MS = 0;

type RuntimeCleanup = () => void;

// Fields that determine which physical capture device the warmer opens. When any
// of these change we re-warm so the parked device tracks the user's selection.
export function captureWarmSignature(config: AppConfigDraft): string {
  const devices = (config as { devices?: Record<string, unknown> }).devices ?? {};
  const nested = (path: string[]): unknown =>
    path.reduce<unknown>(
      (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
      devices,
    );
  return JSON.stringify({
    fb: devices['feedbackLoopPrevention'] ?? null,
    inbound: nested(['inboundRoute', 'input', 'deviceId']) ?? null,
    outbound: nested(['outboundRoute', 'input', 'deviceId']) ?? null,
    virtualRender: devices['virtualRenderDeviceId'] ?? null,
    output: devices['outputDeviceId'] ?? null,
  });
}

export function scheduleCapturePrewarmAfterStartup(
  config: AppConfigDraft = useAppStore.getState().configDraft,
  delayMs = CAPTURE_PREWARM_AFTER_READY_DELAY_MS,
): { cleanup: RuntimeCleanup; promise: Promise<void> } {
  return scheduleStartupTask(() => {
    const prewarm = prewarmCaptureRoutesRuntime(config);
    // Same idle window: pre-open the Omni realtime websocket so a later watch /
    // conversation click reuses a ready session instead of paying the connect +
    // session.ready handshake on the sub-second critical path (the dominant
    // native cost measured before this change). Best-effort and idempotent: the
    // native command no-ops for non-Omni voice models and never blocks startup;
    // a config/model mismatch at click time simply falls back to connect-on-
    // demand, so there is no regression when the preconnect does not apply.
    if (!shouldSuppressGenericStartupAutostart(import.meta.env)) {
      void preconnectOmniRealtimeRuntime(config).catch(() => undefined);
    }
    return prewarm;
  }, delayMs);
}
