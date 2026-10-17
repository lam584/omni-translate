import { describeRuntimeError } from "../../utils/runtime-error-text";
import i18n from "../../i18n/config";
import type { AudioRuntimeSnapshot } from "../../schema/audio-runtime";
import type { DiagnosticLogEntryRuntime } from "../../schema/runtime-core";
import type { SceneLaunchStage } from "./sceneLaunchPlan";
import {
  extractSessionErrorCode,
  formatModelErrorSummary,
  sessionErrorPresentation,
} from "../../utils/session-error-presentation";

/**
 * Terminal outcomes of a watch launch attempt. The names describe *why*
 * capture never became usable so the message can offer a specific next step,
 * instead of collapsing every failure into "启动超时".
 */
export type SceneLaunchOutcome =
  // Provider/model failures are not audio endpoint failures.
  | "session-error"
  // The native start_audio_route command was never acknowledged.
  | "command-rejected"
  // The command was acknowledged, but capture never reached a usable state
  // before the launch deadline (no native error was reported).
  | "capture-not-ready"
  // The command was acknowledged and native capture reported an error.
  | "capture-error";

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
const ROUTE_ACK_MARKERS = ["route_start_acknowledged"] as const;
const ROUTE_READY_MARKERS = ["route_ready"] as const;
const ROUTE_ERROR_MARKERS = ["route_error", "route_command_timeout"] as const;
const ALL_ROUTE_MARKERS = [
  ...ROUTE_ERROR_MARKERS,
  ...ROUTE_READY_MARKERS,
  ...ROUTE_ACK_MARKERS,
] as const;

// Stage label i18n keys, resolved through i18n.t at call time: non zh-CN/en
// locale bundles are attached asynchronously after startup, so labels frozen
// at module load would ignore the language active when the failure occurs.
const STAGE_LABEL_KEYS: Record<SceneLaunchStage, string> = {
  "bridge-ready": "session.attribution.stageBridgeReady",
  "omni-preconnect": "session.attribution.stageOmniPreconnect",
  "inbound-route": "session.attribution.stageInboundRoute",
  "outbound-route": "session.attribution.stageOutboundRoute",
  "translate-worker": "session.attribution.stageTranslateWorker",
  "speech-dispatch": "session.attribution.stageSpeechDispatch",
  "subtitle-overlay": "session.attribution.stageSubtitleOverlay",
};

function errorText(error: unknown): string {
  if (error == null) return "";
  return describeRuntimeError(error).trim();
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

function sessionFailure(input: SceneLaunchAttributionInput) {
  const detail = errorText(input.error);
  const nativeError = input.snapshot?.inbound.lastError?.trim() ?? "";
  // Prefer the thrown failure over a potentially stale native snapshot.
  const thrownCode = extractSessionErrorCode(detail);
  const nativeCode = input.stage === "inbound-route"
    ? extractSessionErrorCode(nativeError) ?? input.snapshot?.inbound.lastErrorCode
    : null;
  const code = thrownCode ?? nativeCode;
  const presentation = sessionErrorPresentation(code);
  return presentation && presentation.action !== "check-audio-device"
    ? { detail: thrownCode ? detail : nativeError || detail, code, presentation }
    : null;
}

function classify(input: SceneLaunchAttributionInput): SceneLaunchOutcome {
  if (sessionFailure(input)) return "session-error";
  const lastError = input.snapshot?.inbound.lastError?.trim();
  const errorMarker = hasMarker(input.recentLogs, ROUTE_ERROR_MARKERS);
  if (lastError || errorMarker) return "capture-error";
  const acknowledged =
    input.commandAccepted
    || hasMarker(input.recentLogs, ROUTE_ACK_MARKERS)
    || hasMarker(input.recentLogs, ROUTE_READY_MARKERS);
  if (!acknowledged) return "command-rejected";
  return "capture-not-ready";
}

function captureStateFragment(snapshot: AudioRuntimeSnapshot | null): string {
  if (!snapshot) return i18n.t("session.attribution.captureStateUnknown");
  const { captureState, preBufferState, streamBound } = snapshot.inbound;
  return i18n.t("session.attribution.captureStateFormat", {
    captureState,
    preBufferState,
    bound: streamBound ? i18n.t("session.attribution.boundYes") : i18n.t("session.attribution.boundNo"),
  });
}

function nativeMarkerFragment(recentLogs: DiagnosticLogEntryRuntime[]): string {
  const marker = latestRouteMarker(recentLogs);
  return i18n.t("session.attribution.nativeMarker", {
    marker: marker ?? i18n.t("session.attribution.noMarker"),
  });
}

/**
 * Builds an attributable failure message for a watch launch. The outcomes
 * each produce a distinct reason plus an actionable hint, so the user learns
 * why capture failed rather than only that it was slow.
 */
export function describeSceneLaunchAttribution(input: SceneLaunchAttributionInput): SceneLaunchAttribution {
  const outcome = classify(input);
  const stageLabel = input.stage ? i18n.t(STAGE_LABEL_KEYS[input.stage]) : i18n.t("session.attribution.stageLaunch");
  const context = captureStateFragment(input.snapshot) + "；" + nativeMarkerFragment(input.recentLogs);
  const detail = errorText(input.error);

  if (outcome === "command-rejected") {
    const reason = i18n.t("session.attribution.commandRejectedReason", { stage: stageLabel, context, detail: detail ? "；" + detail : "" });
    const hint = i18n.t("session.attribution.commandRejectedHint");
    return { outcome, message: reason + "。" + hint };
  }

  if (outcome === "session-error") {
    const failure = sessionFailure(input)!;
    let reason = failure.presentation.useRawMessage
      ? failure.detail
      : [i18n.t(failure.presentation.messageKey), failure.code, failure.detail].join("; ");

    if (
      failure.code === "session.model-reference-invalid" ||
      failure.detail.includes("modelContext:") ||
      failure.detail.includes("model_protocol.") ||
      failure.detail.includes("provider_manifest.")
    ) {
      const formatted = formatModelErrorSummary(input.error, failure.detail, (key) => i18n.t(key));
      const diagnosticPart = failure.detail.includes("modelContext:")
        ? ""
        : "; " + failure.detail;
      reason = formatted + " [" + failure.code + "]" + diagnosticPart;
    }

    const hint = failure.presentation.actionKey
      ? i18n.t(failure.presentation.actionKey)
      : i18n.t("session.restartSessionHint");
    return { outcome, message: [reason, hint].join("; ") };
  }

  if (outcome === "capture-error") {
    const nativeError = input.snapshot?.inbound.lastError?.trim() || detail;
    const reason = i18n.t("session.attribution.captureErrorReason", { stage: stageLabel, nativeError: nativeError || i18n.t("session.attribution.captureErrorDefault"), context });
    const hint = i18n.t("session.attribution.captureErrorHint");
    return { outcome, message: reason + "。" + hint };
  }

  const reason = i18n.t("session.attribution.captureNotReadyReason", { stage: stageLabel, context });
  const hint = i18n.t("session.attribution.captureNotReadyHint");
  return { outcome, message: reason + "。" + hint };
}
