import i18n from '../../i18n/config';
import type { AudioRuntimeSnapshot } from '../../schema/audio-runtime';
import type { DiagnosticLogEntryRuntime } from '../../schema/runtime-core';
import type { SceneLaunchStage } from './sceneLaunchPlan';

/**
 * Three terminal outcomes of a watch launch attempt. The names describe *why*
 * capture never became usable so the message can offer a specific next step,
 * instead of collapsing every failure into "启动超时".
 */
export type SceneLaunchOutcome =
  // The native start_audio_route command was never acknowledged.
  | 'command-rejected'
  // The command was acknowledged, but capture never reached a usable state
  // before the launch deadline (no native error was reported).
  | 'capture-not-ready'
  // The command was acknowledged and native capture reported an error.
  | 'capture-error';

export type SceneLaunchAttributionInput = {
  stage: SceneLaunchStage | null;
  error: unknown;
  /** Latest native snapshot, or null when it could not be read at failure time. */
  snapshot: AudioRuntimeSnapshot | null;
  /** Recent native diagnostics log entries used to recover route markers. */
  recentLogs: DiagnosticLogEntryRuntime[];
  /** Whether start_audio_route resolved (acknowledged) before the failure. */
  commandAccepted: boolean;
};

export type SceneLaunchAttribution = {
  outcome: SceneLaunchOutcome;
  message: string;
};

// Native diagnostics summaries emitted by the route orchestrator. The renderer
// only owns keyword recovery; the authoritative markers live in the Rust log.
const ROUTE_ACK_MARKERS = ['route_start_acknowledged'] as const;
const ROUTE_READY_MARKERS = ['route_ready'] as const;
const ROUTE_ERROR_MARKERS = ['route_error', 'route_command_timeout'] as const;
const ALL_ROUTE_MARKERS = [
  ...ROUTE_ERROR_MARKERS,
  ...ROUTE_READY_MARKERS,
  ...ROUTE_ACK_MARKERS,
] as const;

// Stage label i18n keys, resolved through i18n.t at call time: non zh-CN/en
// locale bundles are attached asynchronously after startup, so labels frozen
// at module load would ignore the language active when the failure occurs.
const STAGE_LABEL_KEYS: Record<SceneLaunchStage, string> = {
  'bridge-ready': 'session.attribution.stageBridgeReady',
  'omni-preconnect': 'session.attribution.stageOmniPreconnect',
  'inbound-route': 'session.attribution.stageInboundRoute',
  'outbound-route': 'session.attribution.stageOutboundRoute',
  'translate-worker': 'session.attribution.stageTranslateWorker',
  'speech-dispatch': 'session.attribution.stageSpeechDispatch',
  'subtitle-overlay': 'session.attribution.stageSubtitleOverlay',
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  if (error == null) return '';
  if (typeof error === 'object') {
    const candidate = error as { message?: unknown };
    if (typeof candidate.message === 'string') return candidate.message.trim();
  }
  return String(error).trim();
}

function hasMarker(recentLogs: DiagnosticLogEntryRuntime[], markers: readonly string[]): boolean {
  return recentLogs.some((entry) => markers.some((marker) => entry.summary.includes(marker)));
}

/** Most recent route marker keyword found in the native diagnostics log. */
function latestRouteMarker(recentLogs: DiagnosticLogEntryRuntime[]): string | null {
  // recentLogs are ordered oldest-first by the native snapshot; walk backwards
  // so the newest acknowledgement/ready/error keyword wins.
  for (let index = recentLogs.length - 1; index >= 0; index -= 1) {
    const summary = recentLogs[index].summary;
    const marker = ALL_ROUTE_MARKERS.find((candidate) => summary.includes(candidate));
    if (marker) return marker;
  }
  return null;
}

function classify(input: SceneLaunchAttributionInput): SceneLaunchOutcome {
  const lastError = input.snapshot?.inbound.lastError?.trim();
  const errorMarker = hasMarker(input.recentLogs, ROUTE_ERROR_MARKERS);
  if (lastError || errorMarker) return 'capture-error';
  const acknowledged =
    input.commandAccepted
    || hasMarker(input.recentLogs, ROUTE_ACK_MARKERS)
    || hasMarker(input.recentLogs, ROUTE_READY_MARKERS);
  if (!acknowledged) return 'command-rejected';
  return 'capture-not-ready';
}

function captureStateFragment(snapshot: AudioRuntimeSnapshot | null): string {
  if (!snapshot) return i18n.t('session.attribution.captureStateUnknown');
  const { captureState, preBufferState, streamBound } = snapshot.inbound;
  return i18n.t('session.attribution.captureStateFormat', { captureState, preBufferState, bound: streamBound ? i18n.t('session.attribution.boundYes') : i18n.t('session.attribution.boundNo') });
}

function nativeMarkerFragment(recentLogs: DiagnosticLogEntryRuntime[]): string {
  const marker = latestRouteMarker(recentLogs);
  return i18n.t('session.attribution.nativeMarker', { marker: marker ?? i18n.t('session.attribution.noMarker') });
}

/**
 * Builds an attributable failure message for a watch launch. The three outcomes
 * each produce a distinct reason plus an actionable hint, so the user learns
 * why capture failed rather than only that it was slow.
 */
export function describeSceneLaunchAttribution(input: SceneLaunchAttributionInput): SceneLaunchAttribution {
  const outcome = classify(input);
  const stageLabel = input.stage ? i18n.t(STAGE_LABEL_KEYS[input.stage]) : i18n.t('session.attribution.stageLaunch');
  const context = `${captureStateFragment(input.snapshot)}；${nativeMarkerFragment(input.recentLogs)}`;
  const detail = errorText(input.error);

  if (outcome === 'command-rejected') {
    const reason = i18n.t('session.attribution.commandRejectedReason', { stage: stageLabel, context, detail: detail ? `；${detail}` : '' });
    const hint = i18n.t('session.attribution.commandRejectedHint');
    return { outcome, message: `${reason}。${hint}` };
  }

  if (outcome === 'capture-error') {
    const nativeError = input.snapshot?.inbound.lastError?.trim() || detail;
    const reason = i18n.t('session.attribution.captureErrorReason', { stage: stageLabel, nativeError: nativeError || i18n.t('session.attribution.captureErrorDefault'), context });
    const hint = i18n.t('session.attribution.captureErrorHint');
    return { outcome, message: `${reason}。${hint}` };
  }

  const reason = i18n.t('session.attribution.captureNotReadyReason', { stage: stageLabel, context });
  const hint = i18n.t('session.attribution.captureNotReadyHint');
  return { outcome, message: `${reason}。${hint}` };
}
