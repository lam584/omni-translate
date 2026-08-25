import type { StatusTone } from '../../components/page/StatusBadge';
import i18n from '../../i18n/config';
import type { BenchmarkReport } from '../../runtime/benchmark-runtime';
import { resolveRuntimeBridgeStatus } from '../../runtime/runtime-status';
import type { AppConfigDraft, RealtimeAudioMode } from '../../schema/config';
import type { AudioRuntimeSnapshot } from '../../schema/audio-runtime';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import type { ProviderInteractionCapability } from '../../schema/provider-contract';
import { isProcessLoopbackReady, resolveProcessLoopbackCapability } from '../../utils/process-loopback-capability';
import { isOverlayVisible } from '../../utils/scene-readiness';

export type RuntimeEnvironmentSummary = {
  mode: 'browser-preview' | 'runtime-error' | 'live-action-needed' | 'live-ready';
  tone: StatusTone; label: string; summary: string; details: string[];
};
export type OverviewIssue = { id: string; title: string; detail: string; tone: StatusTone; route?: string };

export function createEmptyBenchmarkReport(
  model: string,
  audioFile: string,
  interactionCapabilities: ProviderInteractionCapability[] = [],
  realtimeAudioMode: RealtimeAudioMode = 'server_vad',
): BenchmarkReport {
  return {
    model,
    realtimeAudioMode,
    interactionCapabilities,
    audioFile,
    audioDurationSecs: 0,
    runs: [],
    summary: {
      runCount: 0,
      successfulRuns: 0,
      avgConnectMs: 0,
      avgSessionReadyMs: 0,
      avgTimeToFirstTokenMs: null,
      avgTimeToFirstCommittedMs: null,
      avgOutputDeltaIntervalMs: null,
      avgOutputDeltasPerRun: 0,
      avgTotalOutputDurationMs: null,
      p50DeltaIntervalMs: null,
      p90DeltaIntervalMs: null,
      p99DeltaIntervalMs: null,
      minDeltaIntervalMs: null,
      maxDeltaIntervalMs: null,
    },
  };
}

export function hasSameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function resolveStatusTone(status: string): StatusTone {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'warning':
      return 'warning';
    case 'stable':
      return 'stable';
    case 'experimental':
      return 'experimental';
    case 'unsupported':
      return 'unsupported';
    case 'draft':
    case 'preview':
      return 'draft';
    default:
      return 'unknown';
  }
}

export function formatStatusLabel(status: string) {
  if (status === 'ready') {
    return i18n.t('diagnostics.status.ready');
  }

  if (status === 'warning') {
    return i18n.t('diagnostics.status.warning');
  }

  if (status === 'stable') {
    return i18n.t('diagnostics.status.stable');
  }

  if (status === 'experimental') {
    return i18n.t('diagnostics.status.experimental');
  }

  if (status === 'unsupported') {
    return i18n.t('diagnostics.status.unsupported');
  }

  if (status === 'draft' || status === 'preview') {
    return i18n.t('diagnostics.status.draft');
  }

  return i18n.t('diagnostics.status.unknown');
}

export function formatBridgeStateLabel(state: string) {
  if (state === 'running') {
    return i18n.t('diagnostics.status.running');
  }

  if (state === 'starting') {
    return i18n.t('diagnostics.status.starting');
  }

  if (state === 'degraded') {
    return i18n.t('diagnostics.status.degraded');
  }

  return i18n.t('diagnostics.status.stopped');
}

export function formatCaptureStateLabel(state: string) {
  if (state === 'capturing') {
    return i18n.t('diagnostics.status.capturing');
  }

  if (state === 'buffering') {
    return i18n.t('diagnostics.status.buffering');
  }

  if (state === 'armed') {
    return i18n.t('diagnostics.status.armed');
  }

  if (state === 'muted') {
    return i18n.t('diagnostics.status.muted');
  }

  return i18n.t('diagnostics.status.idle');
}

export function formatDriverHealthLabel(health: string) {
  if (health === 'running') {
    return i18n.t('diagnostics.status.driverRunning');
  }

  if (health === 'version-mismatch') {
    return i18n.t('diagnostics.status.versionMismatch');
  }

  if (health === 'damaged') {
    return i18n.t('diagnostics.status.damaged');
  }

  return i18n.t('diagnostics.status.notInstalled');
}

export function formatCaptureBackendLabel(backend: string) {
  if (backend === 'wasapi-process-exclusion') {
    return i18n.t('diagnostics.status.captureBackendProcessExclusion');
  }
  if (backend === 'driver-virtual-speaker') {
    return i18n.t('diagnostics.status.captureBackendVirtualDriver');
  }
  if (backend === 'wasapi-endpoint-loopback') {
    return i18n.t('diagnostics.status.captureBackendEndpointLoopback');
  }
  if (!backend || backend === 'none') {
    return i18n.t('diagnostics.status.captureBackendNone');
  }
  return backend;
}

export function formatProcessLoopbackStatusLabel(status: string) {
  if (status === 'ready') return i18n.t('diagnostics.status.processLoopbackReady');
  if (status === 'probing') return i18n.t('diagnostics.status.processLoopbackProbing');
  if (status === 'unsupported') return i18n.t('diagnostics.status.processLoopbackUnsupported');
  if (status === 'failed') return i18n.t('diagnostics.status.processLoopbackFailed');
  return i18n.t('diagnostics.status.unknown');
}

export function getIssueToneRank(tone: StatusTone) {
  switch (tone) {
    case 'risk':
      return 5;
    case 'unsupported':
      return 4;
    case 'warning':
      return 3;
    case 'pending':
    case 'draft':
      return 2;
    case 'unknown':
      return 1;
    default:
      return 0;
  }
}

export function getRuntimeEnvironmentSummary(
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
  configDraft?: AppConfigDraft,
): RuntimeEnvironmentSummary {
  const runtimeStatus = resolveRuntimeBridgeStatus(runtimeSnapshot);

  if (runtimeStatus === 'browser-preview') {
    return {
      mode: 'browser-preview',
      tone: 'draft',
      label: i18n.t('diagnostics.environment.browserPreview.label'),
      summary: i18n.t('diagnostics.environment.browserPreview.summary'),
      details: [
        i18n.t('diagnostics.environment.browserPreview.detailLaunchDesktop'),
        i18n.t('diagnostics.environment.browserPreview.detailPreviewOnly'),
      ],
    };
  }

  if (runtimeStatus === 'runtime-error') {
    return {
      mode: 'runtime-error',
      tone: 'warning',
      label: i18n.t('diagnostics.environment.runtimeError.label'),
      summary: i18n.t('diagnostics.environment.runtimeError.summary'),
      details: [
        i18n.t('diagnostics.environment.runtimeError.detailLogs'),
        i18n.t('diagnostics.environment.runtimeError.detailFallback'),
      ],
    };
  }

  const actualIssues: string[] = [];

  const feedbackMode = configDraft?.devices.feedbackLoopPrevention;
  const watchRoute = configDraft?.devices.routeMode === 'watch';
  const bridgeRequired = !configDraft || (watchRoute && ['virtual-driver', 'process-exclusion'].includes(feedbackMode ?? ''));
  const driverRequired = !configDraft || (watchRoute && feedbackMode === 'virtual-driver');
  const processLoopbackRequired = Boolean(configDraft && watchRoute && feedbackMode === 'process-exclusion');
  const processLoopback = resolveProcessLoopbackCapability(runtimeSnapshot.bridge);

  if (driverRequired && runtimeSnapshot.bridge.driverHealth === 'damaged') {
    actualIssues.push(i18n.t('diagnostics.issues.driverDamaged'));
  }

  if (driverRequired && runtimeSnapshot.bridge.driverHealth === 'version-mismatch') {
    actualIssues.push(i18n.t('diagnostics.issues.driverVersionMismatch'));
  }

  if (bridgeRequired && runtimeSnapshot.bridge.lifecycleState === 'error' && runtimeSnapshot.bridge.lastErrorCode) {
    actualIssues.push(i18n.t('diagnostics.issues.bridgeError', { code: runtimeSnapshot.bridge.lastErrorCode }));
  }

  if (driverRequired && runtimeSnapshot.bridge.lastErrorCode === 'monitor.virtual-playback-loop') {
    actualIssues.push(i18n.t('diagnostics.issues.virtualPlaybackLoop'));
  }

  if (processLoopbackRequired && !isProcessLoopbackReady(processLoopback)) {
    actualIssues.push(i18n.t('diagnostics.issues.processLoopbackUnavailable', {
      status: formatProcessLoopbackStatusLabel(processLoopback.status),
      detail: processLoopback.failureDetail ?? `${processLoopback.windowsBuildNumber ?? 'unknown'} / ${processLoopback.minimumWindowsBuild}`,
    }));
  }

  if (audioRuntimeSnapshot.inbound.lastError) {
    actualIssues.push(i18n.t('diagnostics.issues.inboundError', { error: audioRuntimeSnapshot.inbound.lastError }));
  }

  if (audioRuntimeSnapshot.outbound.lastError) {
    actualIssues.push(i18n.t('diagnostics.issues.outboundError', { error: audioRuntimeSnapshot.outbound.lastError }));
  }

  if (audioRuntimeSnapshot.speech.lastError) {
    actualIssues.push(i18n.t('diagnostics.issues.speechError', { error: audioRuntimeSnapshot.speech.lastError }));
  }

  if (actualIssues.length === 0) {
    return {
      mode: 'live-ready',
      tone: 'ready',
      label: i18n.t('diagnostics.environment.liveReady.label'),
      summary: '',
      details: [
        i18n.t('diagnostics.environment.liveReady.detail'),
      ],
    };
  }

  return {
    mode: 'live-action-needed',
    tone: 'warning',
    label: i18n.t('diagnostics.environment.liveActionNeeded.label'),
    summary: i18n.t('diagnostics.environment.liveActionNeeded.summary'),
    details: actualIssues,
  };
}

export function buildOverviewIssues(
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
  runtimeEnvironmentSummary: RuntimeEnvironmentSummary,
  configDraft?: AppConfigDraft,
): OverviewIssue[] {
  const issues = new Map<string, OverviewIssue>();
  const recentErrors = runtimeSnapshot.diagnostics.recentErrors.slice(0, 2);
  const feedbackMode = configDraft?.devices.feedbackLoopPrevention;
  const watchRoute = configDraft?.devices.routeMode === 'watch';
  const bridgeRequired = !configDraft || (watchRoute && ['virtual-driver', 'process-exclusion'].includes(feedbackMode ?? ''));
  const driverRequired = !configDraft || (watchRoute && feedbackMode === 'virtual-driver');
  const processLoopbackRequired = Boolean(configDraft && watchRoute && feedbackMode === 'process-exclusion');
  const processLoopback = resolveProcessLoopbackCapability(runtimeSnapshot.bridge);
  const hasBridgeRuntimeIssue = bridgeRequired && (
    runtimeSnapshot.bridge.lifecycleState === 'error' ||
    (driverRequired && ['damaged', 'version-mismatch'].includes(runtimeSnapshot.bridge.driverHealth)) ||
    (processLoopbackRequired && !isProcessLoopbackReady(processLoopback))
  );
  const hasAudioRuntimeIssue =
    Boolean(audioRuntimeSnapshot.inbound.lastError) ||
    Boolean(audioRuntimeSnapshot.outbound.lastError) ||
    Boolean(audioRuntimeSnapshot.speech.lastError);

  const addIssue = (issue: OverviewIssue) => {
    const existing = issues.get(issue.title);
    if (!existing) {
      issues.set(issue.title, issue);
      return;
    }

    if (getIssueToneRank(issue.tone) > getIssueToneRank(existing.tone)) {
      existing.tone = issue.tone;
    }
  };

  if (runtimeEnvironmentSummary.mode !== 'live-ready') {
    addIssue({
      id: `runtime-${runtimeEnvironmentSummary.mode}`,
      title: runtimeEnvironmentSummary.label,
      detail: runtimeEnvironmentSummary.summary,
      tone: runtimeEnvironmentSummary.tone,
      route: '/diagnostics',
    });
  }

  if (hasBridgeRuntimeIssue) {
    const bridgeDetail = processLoopbackRequired
      ? [
        formatCaptureBackendLabel(processLoopback.captureBackend),
        formatProcessLoopbackStatusLabel(processLoopback.status),
        processLoopback.failureDetail,
      ]
      : [formatDriverHealthLabel(runtimeSnapshot.bridge.driverHealth), runtimeSnapshot.bridge.lastErrorCode];
    addIssue({
      id: 'bridge-runtime',
      title: i18n.t('diagnostics.issues.bridgeRuntimeTitle'),
      detail: bridgeDetail
        .filter((item): item is string => Boolean(item))
        .join(' · '),
      tone: 'warning',
      route: '/diagnostics',
    });
  }

  if (hasAudioRuntimeIssue) {
    const audioDetails = [
      audioRuntimeSnapshot.inbound.lastError
        ? `${audioRuntimeSnapshot.inbound.lastError}${audioRuntimeSnapshot.inbound.recommendedAction ? ` [${i18n.t('diagnostics.labels.suggestion')}: ${audioRuntimeSnapshot.inbound.recommendedAction}]` : ''}`
        : null,
      audioRuntimeSnapshot.outbound.lastError
        ? `${audioRuntimeSnapshot.outbound.lastError}${audioRuntimeSnapshot.outbound.recommendedAction ? ` [${i18n.t('diagnostics.labels.suggestion')}: ${audioRuntimeSnapshot.outbound.recommendedAction}]` : ''}`
        : null,
      audioRuntimeSnapshot.speech.lastError,
    ].filter((item): item is string => Boolean(item));

    addIssue({
      id: 'audio-runtime',
      title: i18n.t('diagnostics.issues.audioRuntimeTitle'),
      detail: audioDetails.join(' · '),
      tone: 'warning',
      route: '/diagnostics',
    });
  }

  for (const entry of recentErrors) {
    addIssue({
      id: entry.id,
      title: entry.summary,
      detail: entry.detail ? i18n.t('diagnostics.issues.errorDetail', { detail: entry.detail }) : i18n.t('diagnostics.issues.errorCategory', { category: entry.category }),
      tone: 'warning',
    });
  }

  return Array.from(issues.values());
}

export function buildOverviewSignals(
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
  runtimeEnvironmentSummary: RuntimeEnvironmentSummary,
  effectiveBridgeStatus: string,
) {
  const recentErrorCount = runtimeSnapshot.diagnostics.recentErrors.slice(0, 6).length;
  const processLoopback = resolveProcessLoopbackCapability(runtimeSnapshot.bridge);
  const bridgeMeta = processLoopback.captureBackend !== 'none'
    ? formatCaptureBackendLabel(processLoopback.captureBackend)
    : formatDriverHealthLabel(runtimeSnapshot.bridge.driverHealth);
  return [
    {
      label: i18n.t('diagnostics.signals.environment'),
      value: runtimeEnvironmentSummary.label,
      meta: effectiveBridgeStatus,
      tone: runtimeEnvironmentSummary.tone,
    },
    {
      label: i18n.t('diagnostics.signals.bridge'),
      value: formatBridgeStateLabel(runtimeSnapshot.bridge.bridgeState),
      meta: bridgeMeta,
      tone: runtimeSnapshot.bridge.bridgeState === 'running' ? 'ready' : 'warning',
    },
    {
      label: i18n.t('diagnostics.signals.capture'),
      value: `${formatCaptureStateLabel(audioRuntimeSnapshot.inbound.captureState)} / ${formatCaptureStateLabel(audioRuntimeSnapshot.outbound.captureState)}`,
      meta: formatStatusLabel(runtimeSnapshot.diagnostics.deviceStatus),
      tone: resolveStatusTone(runtimeSnapshot.diagnostics.deviceStatus),
    },
    {
      label: i18n.t('diagnostics.signals.errorSummary'),
      value: recentErrorCount > 0 ? i18n.t('diagnostics.signals.errorCount', { count: Math.min(recentErrorCount, 3) }) : i18n.t('diagnostics.signals.noRecentErrors'),
      meta: recentErrorCount > 0 ? i18n.t('diagnostics.signals.needsInvestigation') : i18n.t('diagnostics.signals.stable'),
      tone: recentErrorCount > 0 ? 'warning' : 'ready',
    },
  ] satisfies Array<{ label: string; value: string; meta: string; tone: StatusTone }>;
}

export function buildServiceMonitorItems(
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
  configDraft: AppConfigDraft,
  runtimeEnvironmentSummary: RuntimeEnvironmentSummary,
) {
  const processLoopback = resolveProcessLoopbackCapability(runtimeSnapshot.bridge);
  const processLoopbackSelected = configDraft.devices.routeMode === 'watch'
    && configDraft.devices.feedbackLoopPrevention === 'process-exclusion';
  const hasBridgeRuntimeIssue = runtimeSnapshot.bridge.lifecycleState === 'error'
    || ['damaged', 'version-mismatch'].includes(runtimeSnapshot.bridge.driverHealth)
    || (processLoopbackSelected && !isProcessLoopbackReady(processLoopback));
  const overlayVisible = isOverlayVisible(runtimeSnapshot);

  return [
    {
      label: i18n.t('diagnostics.services.desktopRuntime'),
      summary: runtimeEnvironmentSummary.summary,
      badge: runtimeEnvironmentSummary.label,
      tone: runtimeEnvironmentSummary.tone,
    },
    {
      label: i18n.t('diagnostics.services.bridgeService'),
      summary: processLoopbackSelected
        ? `${formatCaptureBackendLabel(processLoopback.captureBackend)} · ${formatProcessLoopbackStatusLabel(processLoopback.status)}`
        : formatDriverHealthLabel(runtimeSnapshot.bridge.driverHealth),
      badge: formatBridgeStateLabel(runtimeSnapshot.bridge.bridgeState),
      tone: hasBridgeRuntimeIssue ? 'warning' : runtimeSnapshot.bridge.bridgeState === 'running' ? 'ready' : 'pending',
    },
    {
      label: i18n.t('diagnostics.services.systemAudioCapture'),
      summary: formatCaptureStateLabel(audioRuntimeSnapshot.inbound.captureState),
      badge: audioRuntimeSnapshot.inbound.streamBound ? i18n.t('diagnostics.status.running') : i18n.t('diagnostics.status.notStarted'),
      tone: audioRuntimeSnapshot.inbound.lastError ? 'warning' : audioRuntimeSnapshot.inbound.streamBound ? 'ready' : 'pending',
    },
    {
      label: i18n.t('diagnostics.services.microphoneCapture'),
      summary: formatCaptureStateLabel(audioRuntimeSnapshot.outbound.captureState),
      badge: audioRuntimeSnapshot.outbound.streamBound ? i18n.t('diagnostics.status.running') : i18n.t('diagnostics.status.notStarted'),
      tone: audioRuntimeSnapshot.outbound.lastError ? 'warning' : audioRuntimeSnapshot.outbound.streamBound ? 'ready' : 'pending',
    },
    {
      label: i18n.t('diagnostics.services.speechAndOverlay'),
      summary: `${audioRuntimeSnapshot.speech.dispatchState}${overlayVisible ? ` · ${i18n.t('diagnostics.status.overlayVisible')}` : ` · ${i18n.t('diagnostics.status.overlayHidden')}`}`,
      badge: audioRuntimeSnapshot.speech.lastError ? i18n.t('diagnostics.status.abnormal') : configDraft.speech.enabled ? i18n.t('diagnostics.status.enabled') : i18n.t('diagnostics.status.idle'),
      tone: audioRuntimeSnapshot.speech.lastError ? 'warning' : configDraft.speech.enabled || overlayVisible ? 'ready' : 'pending',
    },
  ] satisfies Array<{ label: string; summary: string; badge: string; tone: StatusTone }>;
}
