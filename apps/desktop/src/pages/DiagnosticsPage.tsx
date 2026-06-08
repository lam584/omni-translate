import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { isTauri } from '@tauri-apps/api/core';
import AppIcon from '../components/icons/AppIcon';
import StatusBadge from '../components/page/StatusBadge';
import type { StatusTone } from '../components/page/StatusBadge';
import i18n from '../i18n/config';
import {
  installDriverRuntime,
  refreshBridgeRuntime,
  repairDriverRuntime,
  startBridgeServiceRuntime,
} from '../runtime/bridge-runtime';
import {
  exportDiagnosticsBundleRuntime,
  runDiagnosticsSelfCheckRuntime,
  runSubtitleOverlaySelfCheckRuntime,
} from '../runtime/diagnostics-runtime';
import {
  runModelBenchmark,
  type BenchmarkProgressEvent,
  type BenchmarkReport,
} from '../runtime/benchmark-runtime';
import {
  getLiveSessionEventsRuntime,
  type LiveSessionEvents,
} from '../runtime/live-session-events-runtime';
import { readProviderSecret } from '../runtime/provider-runtime';
import { resolveRuntimeBridgeStatus } from '../runtime/runtime-status';
import { isTauriRuntime, hasInvokeBridge } from '../runtime/tauri-runtime';
import type { AppConfigDraft, DiagnosticsExportScope } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import { useAppStore } from '../stores/app-store';
import { resolveRecommendedDriverAction } from '../utils/driver-management';
import {
  resolveInteractionCapabilities,
  resolveRealtimeAudioMode,
} from '../utils/provider-model-capabilities';
import type { RealtimeAudioMode } from '../schema/config';
import type { ProviderInteractionCapability } from '../schema/provider-contract';

type RuntimeEnvironmentSummary = {
  mode: 'browser-preview' | 'runtime-error' | 'live-action-needed' | 'live-ready';
  tone: StatusTone;
  label: string;
  summary: string;
  details: string[];
};

type OverviewIssue = {
  id: string;
  title: string;
  detail: string;
  tone: StatusTone;
  route?: string;
};

type RepairOption = {
  id: string;
  label: string;
  summary: string;
  tone: StatusTone;
  issueIds: string[];
  run: () => Promise<void>;
};

type BenchmarkProgressView = Pick<BenchmarkProgressEvent, 'status' | 'phase' | 'message' | 'audioChunksSent' | 'totalAudioChunks' | 'error'>;

function createEmptyBenchmarkReport(
  model: string,
  audioFile: string,
  interactionCapabilities: ProviderInteractionCapability[] = [],
): BenchmarkReport {
  return {
    model,
    realtimeAudioMode: shouldUseManualBenchmarkMode(model) ? 'manual' : 'server_vad',
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

function hasSameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function resolveStatusTone(status: string): StatusTone {
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

function formatStatusLabel(status: string) {
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

function formatBridgeStateLabel(state: string) {
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

function formatCaptureStateLabel(state: string) {
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

function formatDriverHealthLabel(health: string) {
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

function getIssueToneRank(tone: StatusTone) {
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

function isOverlayVisible(runtimeSnapshot: RuntimeSnapshot) {
  return runtimeSnapshot.windows.find((item) => item.label === 'subtitle-overlay')?.visible === true;
}

function getRuntimeEnvironmentSummary(
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
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

  if (runtimeSnapshot.bridge.driverHealth === 'damaged') {
    actualIssues.push(i18n.t('diagnostics.issues.driverDamaged'));
  }

  if (runtimeSnapshot.bridge.driverHealth === 'version-mismatch') {
    actualIssues.push(i18n.t('diagnostics.issues.driverVersionMismatch'));
  }

  if (runtimeSnapshot.bridge.lifecycleState === 'error' && runtimeSnapshot.bridge.lastErrorCode) {
    actualIssues.push(i18n.t('diagnostics.issues.bridgeError', { code: runtimeSnapshot.bridge.lastErrorCode }));
  }

  if (runtimeSnapshot.bridge.lastErrorCode === 'monitor.virtual-playback-loop') {
    actualIssues.push(i18n.t('diagnostics.issues.virtualPlaybackLoop'));
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

function buildOverviewIssues(
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
  runtimeEnvironmentSummary: RuntimeEnvironmentSummary,
): OverviewIssue[] {
  const issues = new Map<string, OverviewIssue>();
  const recentErrors = runtimeSnapshot.diagnostics.recentErrors.slice(0, 2);
  const hasBridgeRuntimeIssue =
    runtimeSnapshot.bridge.driverHealth === 'damaged' ||
    runtimeSnapshot.bridge.driverHealth === 'version-mismatch' ||
    runtimeSnapshot.bridge.lifecycleState === 'error';
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
    addIssue({
      id: 'bridge-runtime',
      title: i18n.t('diagnostics.issues.bridgeRuntimeTitle'),
      detail: [formatDriverHealthLabel(runtimeSnapshot.bridge.driverHealth), runtimeSnapshot.bridge.lastErrorCode]
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

function buildOverviewSignals(
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
  runtimeEnvironmentSummary: RuntimeEnvironmentSummary,
  effectiveBridgeStatus: string,
) {
  const recentErrorCount = runtimeSnapshot.diagnostics.recentErrors.slice(0, 6).length;
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
      meta: formatDriverHealthLabel(runtimeSnapshot.bridge.driverHealth),
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

function buildServiceMonitorItems(
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
  configDraft: AppConfigDraft,
  runtimeEnvironmentSummary: RuntimeEnvironmentSummary,
) {
  const hasBridgeRuntimeIssue =
    runtimeSnapshot.bridge.driverHealth === 'damaged' ||
    runtimeSnapshot.bridge.driverHealth === 'version-mismatch' ||
    runtimeSnapshot.bridge.lifecycleState === 'error';
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
      summary: formatDriverHealthLabel(runtimeSnapshot.bridge.driverHealth),
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

export const diagnosticsPageHelpers = {
  hasSameIds,
  resolveStatusTone,
  formatStatusLabel,
  formatBridgeStateLabel,
  formatCaptureStateLabel,
  formatDriverHealthLabel,
  getIssueToneRank,
  isOverlayVisible,
  getRuntimeEnvironmentSummary,
  buildOverviewIssues,
  buildOverviewSignals,
  buildServiceMonitorItems,
  createEmptyBenchmarkReport,
  isBinaryAudioOutputEvent,
  isTextOutputEvent,
  shouldUseManualBenchmarkMode,
  textLength,
  shouldUseCandidate,
  buildOutputSegments,
  BenchmarkProgressBanner,
  BenchmarkReportDetail,
  LiveSessionEventDetail,
};

export async function runRecommendedBridgeAction(snapshot: RuntimeSnapshot, configDraft: ReturnType<typeof useAppStore.getState>['configDraft']) {
  const { bridge } = snapshot;
  switch (resolveRecommendedDriverAction(bridge)) {
    case 'install': return installDriverRuntime(configDraft);
    case 'reinstall': return repairDriverRuntime('reinstall-driver', configDraft);
    case 'start-bridge': return startBridgeServiceRuntime(configDraft);
    default: return repairDriverRuntime('restart-bridge', configDraft);
  }
}

function DiagnosticsPage() {
  const configDraft = useAppStore((state) => state.configDraft);
  const runtimeSnapshot = useAppStore((state) => state.runtimeSnapshot);
  const audioRuntimeSnapshot = useAppStore((state) => state.audioRuntimeSnapshot);
  const updateDiagnosticsDraft = useAppStore((state) => state.updateDiagnosticsDraft);
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  const pushRuntimeNotification = useAppStore((state) => state.pushRuntimeNotification);
  const diagnostics = runtimeSnapshot.diagnostics;
  const exportScope = diagnostics.lastExportScope ?? configDraft.diagnostics.lastExportScope;
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [benchmarkModelId, setBenchmarkModelId] = useState<string>('');
  const [benchmarkMp3Path, setBenchmarkMp3Path] = useState<string>('E:\\omni-translate\\scripts\\testing\\Test.mp3');
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkReport, setBenchmarkReport] = useState<BenchmarkReport | null>(null);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);
  const [benchmarkModalOpen, setBenchmarkModalOpen] = useState(false);
  const [benchmarkProgress, setBenchmarkProgress] = useState<BenchmarkProgressView | null>(null);
  const [liveEventsModalOpen, setLiveEventsModalOpen] = useState(false);
  const [liveEvents, setLiveEvents] = useState<LiveSessionEvents | null>(null);
  const [liveEventsLoading, setLiveEventsLoading] = useState(false);
  const voiceModelOptions = useMemo(() => {
    const modelMap = new Map<string, {
      modelId: string;
      apiModelId: string;
      displayName: string;
      authReference: string;
      realtimeAudioMode: RealtimeAudioMode;
      interactionCapabilities: ProviderInteractionCapability[];
      providerKind: string;
      baseUrl: string;
      authHeaderName: string;
      authScheme: string;
    }>();
    for (const provider of configDraft.providers) {
      for (const assignment of provider.sceneModelAssignments ?? []) {
        if (!['watch', 'game', 'voice-room'].includes(assignment.scenario)) {
          continue;
        }
        for (const modelId of assignment.modelIds) {
          if (!modelMap.has(modelId)) {
            const apiModelId = modelId.includes('::') ? modelId.split('::')[1] || modelId : modelId;
            modelMap.set(modelId, {
              modelId,
              apiModelId,
              displayName: modelId,
              authReference: provider.authRef?.reference ?? '',
              realtimeAudioMode: resolveRealtimeAudioMode(apiModelId, provider.localModelCapabilityRegistry ?? [], apiModelId),
              interactionCapabilities: resolveInteractionCapabilities(apiModelId, provider.localModelCapabilityRegistry ?? [], apiModelId),
              providerKind: provider.kind,
              baseUrl: provider.baseUrl,
              authHeaderName: provider.authRef?.headerName ?? 'Authorization',
              authScheme: provider.authRef?.scheme ?? 'bearer',
            });
          }
        }
      }
    }
    return [...modelMap.values()];
  }, [configDraft.providers]);

  useEffect(() => {
    if (!benchmarkModelId && voiceModelOptions.length > 0) {
      queueMicrotask(() => setBenchmarkModelId(voiceModelOptions[0]!.modelId));
    }
  }, [benchmarkModelId, voiceModelOptions]);
  const runtimeEnvironmentSummary = useMemo(
    () => getRuntimeEnvironmentSummary(runtimeSnapshot, audioRuntimeSnapshot),
    [runtimeSnapshot, audioRuntimeSnapshot],
  );
  const effectiveBridgeStatus = resolveRuntimeBridgeStatus(runtimeSnapshot);
  const overviewIssues = useMemo(
    () => buildOverviewIssues(runtimeSnapshot, audioRuntimeSnapshot, runtimeEnvironmentSummary),
    [audioRuntimeSnapshot, runtimeEnvironmentSummary, runtimeSnapshot],
  );
  const overviewTone = overviewIssues.length === 0 ? 'ready' : runtimeEnvironmentSummary.tone === 'draft' ? 'draft' : 'warning';
  const overviewLabel = overviewIssues.length === 0 ? i18n.t('diagnostics.overview.noCriticalBlockers') : i18n.t('diagnostics.overview.criticalIssueCount', { count: overviewIssues.length });
  const overviewSignals = useMemo(
    () => buildOverviewSignals(runtimeSnapshot, audioRuntimeSnapshot, runtimeEnvironmentSummary, effectiveBridgeStatus),
    [audioRuntimeSnapshot, effectiveBridgeStatus, runtimeEnvironmentSummary, runtimeSnapshot],
  );
  const serviceMonitorItems = useMemo(
    () => buildServiceMonitorItems(runtimeSnapshot, audioRuntimeSnapshot, configDraft, runtimeEnvironmentSummary),
    [audioRuntimeSnapshot, configDraft, runtimeEnvironmentSummary, runtimeSnapshot],
  );
  const repairOptions = useMemo<RepairOption[]>(() => {
    const options: RepairOption[] = [];
    const selectedIssueIds = overviewIssues.map((issue) => issue.id);

    if (selectedIssueIds.includes('runtime-runtime-error')) {
      options.push({
        id: 'runtime-refresh',
        label: i18n.t('diagnostics.repairs.retryRuntime'),
        summary: i18n.t('diagnostics.repairs.retryRuntimeSummary'),
        tone: 'warning',
        issueIds: ['runtime-runtime-error'],
        run: async () => {
          const snapshot = await refreshBridgeRuntime();
          setRuntimeSnapshot(snapshot);
        },
      });
    }

    if (selectedIssueIds.includes('bridge-runtime')) {
      options.push({
        id: 'bridge-chain',
        label: i18n.t('diagnostics.repairs.bridgeRecommended'),
        summary: i18n.t('diagnostics.repairs.bridgeRecommendedSummary'),
        tone: 'warning',
        issueIds: ['bridge-runtime'],
        run: async () => {
          const snapshot = await runRecommendedBridgeAction(useAppStore.getState().runtimeSnapshot, useAppStore.getState().configDraft);
          useAppStore.getState().setRuntimeSnapshot(snapshot);
        },
      });
    }

    return options;
  }, [overviewIssues]);
  const repairableIssueIds = useMemo(() => new Set(repairOptions.flatMap((option) => option.issueIds)), [repairOptions]);
  const keyIssues = useMemo(() => overviewIssues.filter((issue) => !repairableIssueIds.has(issue.id)), [overviewIssues, repairableIssueIds]);
  const primaryIssue = keyIssues[0] ?? overviewIssues[0] ?? null;
  const [selectedRepairIds, setSelectedRepairIds] = useState<string[]>([]);
  const [repairSelectionInitialized, setRepairSelectionInitialized] = useState(false);

  useEffect(() => {
    const availableIds = new Set(repairOptions.map((option) => option.id));
    const defaultIds = repairOptions.map((option) => option.id);

    queueMicrotask(() => {
      setSelectedRepairIds((current) => {
        const filtered = current.filter((id) => availableIds.has(id));
        const nextIds = !repairSelectionInitialized ? defaultIds : filtered;

        if (hasSameIds(current, nextIds)) {
          return current;
        }

        return nextIds;
      });

      if (!repairSelectionInitialized) {
        setRepairSelectionInitialized(true);
      }
    });
  }, [repairOptions, repairSelectionInitialized]);
  const allRepairSelected = repairOptions.length > 0 && repairOptions.every((option) => selectedRepairIds.includes(option.id));
  const stableServiceCount = serviceMonitorItems.filter((item) => item.tone !== 'warning').length;
  const healthSummaryLabel = overviewIssues.length === 0 ? i18n.t('diagnostics.health.normal') : i18n.t('diagnostics.health.issueCount', { count: overviewIssues.length });
  const healthSummaryDetail =
    overviewIssues.length === 0
      ? i18n.t('diagnostics.health.stableDetail', { count: stableServiceCount })
      : primaryIssue
        ? `${primaryIssue.title}。${primaryIssue.detail}`
        : i18n.t('diagnostics.health.needsInvestigationDetail');

  const envDiagnostic = useMemo(() => {
    const tauriFlag = isTauri();
    const bridge = hasInvokeBridge();
    const runtime = isTauriRuntime();
    const ipcObject = typeof window !== 'undefined' ? !!(window as unknown as Record<string, unknown>).ipc : false;
    const speechEnabled = Boolean(configDraft.speech?.enabled || configDraft.devices?.outputSpeechEnabled);

    return {
      tauriFlag,
      hasBridge: bridge,
      isRuntime: runtime,
      hasIpcObject: ipcObject,
      storageStatus: runtimeSnapshot.storage.status,
      bridgeStatus: runtimeSnapshot.bridgeStatus,
      credentialBackend: runtimeSnapshot.storage.credentialBackend,
      schemaVersion: runtimeSnapshot.storage.schemaVersion,
      omniSpeechEnabled: speechEnabled,
      speechLocalPlayback: Boolean(configDraft.speech?.localPlaybackEnabled ?? true),
      speechVirtualMic: Boolean(configDraft.speech?.virtualMicOutputEnabled ?? false),
    };
  }, [runtimeSnapshot, configDraft]);

  const runBusyAction = async (actionId: string, runner: () => Promise<RuntimeSnapshot>) => {
    setBusyAction(actionId);
    try {
      const snapshot = await runner();
      setRuntimeSnapshot(snapshot);
    } finally {
      setBusyAction(null);
    }
  };

  const runAutomaticRepair = async () => {
    const selectedOptions = repairOptions.filter((option) => selectedRepairIds.includes(option.id));
    if (selectedOptions.length === 0) {
      return;
    }

    setBusyAction('auto-repair');
    try {
      const failures: string[] = [];

      for (const option of selectedOptions) {
        try {
          await option.run();
        } catch (error) {
          failures.push(option.label);
          pushRuntimeNotification({
            id: `auto-repair-${option.id}-${Date.now()}`,
            level: 'error',
            source: 'diagnostics',
            message: i18n.t('diagnostics.notifications.autoRepairFailed', { label: option.label, error: error instanceof Error ? error.message : String(error) }),
            emittedAt: new Date().toISOString(),
          });
        }
      }

      if (isTauriRuntime()) {
        const snapshot = await refreshBridgeRuntime();
        setRuntimeSnapshot(snapshot);
      }

      if (failures.length === 0) {
        pushRuntimeNotification({
          id: `auto-repair-success-${Date.now()}`,
          level: 'info',
          source: 'diagnostics',
          message: i18n.t('diagnostics.notifications.autoRepairSuccess', { count: selectedOptions.length }),
          emittedAt: new Date().toISOString(),
        });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const runExportAction = async (scope: DiagnosticsExportScope) => {
    setBusyAction('export');
    try {
      const result = await exportDiagnosticsBundleRuntime(scope);
      setRuntimeSnapshot(result.snapshot);
      updateDiagnosticsDraft({ lastExportScope: scope });
    } finally {
      setBusyAction(null);
    }
  };

  const sessionActive = audioRuntimeSnapshot.sessionStartedAt !== null && audioRuntimeSnapshot.inbound.streamBound;

  const fetchLiveEvents = async () => {
    setLiveEventsLoading(true);
    try {
      const events = await getLiveSessionEventsRuntime();
      setLiveEvents(events);
    } finally {
      setLiveEventsLoading(false);
    }
  };

  const openLiveEventsModal = async () => {
    setLiveEventsModalOpen(true);
    await fetchLiveEvents();
  };

  const runBenchmarkTest = async () => {
    const selectedModel = voiceModelOptions.find((item) => item.modelId === benchmarkModelId);
    if (!selectedModel) {
      setBenchmarkError(i18n.t('diagnostics.benchmark.selectVoiceModelFirst'));
      return;
    }
    if (!benchmarkMp3Path.trim()) {
      setBenchmarkError(i18n.t('diagnostics.benchmark.enterMp3Path'));
      return;
    }

    setBenchmarkRunning(true);
    setBenchmarkError(null);
    setBenchmarkProgress({
      status: 'running',
      phase: 'starting',
      message: i18n.t('diagnostics.benchmark.preparing'),
      audioChunksSent: 0,
      totalAudioChunks: 0,
      error: null,
    });

    try {
      const secretPayload = await readProviderSecret(selectedModel.authReference);
      if (!secretPayload.secret) {
        throw new Error(i18n.t('diagnostics.benchmark.missingApiKey', { model: selectedModel.displayName }));
      }

      setBenchmarkReport(createEmptyBenchmarkReport(selectedModel.apiModelId, benchmarkMp3Path, selectedModel.interactionCapabilities));
      setBenchmarkModalOpen(true);
      const report = await runModelBenchmark(selectedModel.apiModelId, secretPayload.secret, benchmarkMp3Path, {
        realtimeAudioMode: selectedModel.realtimeAudioMode,
        interactionCapabilities: selectedModel.interactionCapabilities,
        providerKind: selectedModel.providerKind,
        baseUrl: selectedModel.baseUrl,
        authHeaderName: selectedModel.authHeaderName,
        authScheme: selectedModel.authScheme,
        onProgress: (event) => {
          setBenchmarkReport(event.report);
          setBenchmarkProgress({
            status: event.status,
            phase: event.phase,
            message: event.message,
            audioChunksSent: event.audioChunksSent,
            totalAudioChunks: event.totalAudioChunks,
            error: event.error,
          });
        },
      });
      setBenchmarkReport(report);
      setBenchmarkProgress((current) => ({
        status: 'completed',
        phase: 'completed',
        message: current?.message || i18n.t('diagnostics.benchmark.completed'),
        audioChunksSent: current?.audioChunksSent ?? report.runs[0]?.audioChunksSent ?? 0,
        totalAudioChunks: current?.totalAudioChunks ?? report.runs[0]?.audioChunksSent ?? 0,
        error: null,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBenchmarkError(message);
      setBenchmarkProgress((current) => ({
        status: 'error',
        phase: current?.phase || 'failed',
        message,
        audioChunksSent: current?.audioChunksSent ?? 0,
        totalAudioChunks: current?.totalAudioChunks ?? 0,
        error: message,
      }));
    } finally {
      setBenchmarkRunning(false);
    }
  };

  return (
    <div className="control-dashboard diagnostics-dashboard">
      <section className="diagnostics-command-panel">
        <div className="diagnostics-health-summary">
          <div>
            <span className="diagnostics-kicker">{i18n.t('diagnostics.sections.conclusion')}</span>
            <h2>{healthSummaryLabel}</h2>
            <p>{healthSummaryDetail}</p>
          </div>
          <StatusBadge label={overviewLabel} tone={overviewTone} />
        </div>

        <div className="diagnostics-action-strip" aria-label={i18n.t('diagnostics.actionsStripAria')}>
          <button className="icon-button diagnostics-primary-action" disabled={busyAction !== null} onClick={() => void runBusyAction('self-check', runDiagnosticsSelfCheckRuntime)} type="button">
              <AppIcon name="search" size={14} />
              {busyAction === 'self-check' ? i18n.t('diagnostics.actions.diagnosing') : i18n.t('diagnostics.actions.rerunDiagnostics')}
            </button>
          <button className="icon-button" disabled={busyAction !== null} onClick={() => void runBusyAction('overlay-self-check', runSubtitleOverlaySelfCheckRuntime)} type="button">
              <AppIcon name="subtitles" size={14} />
              {busyAction === 'overlay-self-check' ? i18n.t('diagnostics.actions.testing') : i18n.t('diagnostics.actions.testOverlay')}
            </button>
          <button className="icon-button" disabled={busyAction !== null} onClick={() => void runExportAction(exportScope)} type="button">
              <AppIcon name="layers" size={14} />
              {busyAction === 'export' ? i18n.t('diagnostics.actions.exporting') : i18n.t('diagnostics.actions.exportBundle')}
            </button>
          <button className="icon-button" disabled={busyAction !== null} onClick={() => void runBusyAction('bridge-refresh', refreshBridgeRuntime)} type="button">
              <AppIcon name="refresh" size={14} />
              {busyAction === 'bridge-refresh' ? i18n.t('diagnostics.actions.refreshing') : i18n.t('diagnostics.actions.refreshRuntime')}
            </button>
        </div>

        {sessionActive ? (
          <div className="diagnostics-live-events-strip">
            <button className="icon-button diagnostics-live-events-button" onClick={() => void openLiveEventsModal()} type="button">
              <AppIcon name="activity" size={14} />
              {i18n.t('diagnostics.liveEvents.button')}
            </button>
          </div>
        ) : null}

        {primaryIssue ? (
          <div className={`diagnostics-primary-issue diagnostics-primary-issue-${primaryIssue.tone}`}>
            <div>
              <span>{i18n.t('diagnostics.labels.currentIssue')}</span>
              <strong>{primaryIssue.title}</strong>
              <p>{primaryIssue.detail}</p>
            </div>
            <StatusBadge label={primaryIssue.route ? i18n.t('diagnostics.labels.needsAction') : i18n.t('diagnostics.labels.watch')} tone={primaryIssue.tone} />
          </div>
        ) : (
          <div className="diagnostics-primary-issue diagnostics-primary-issue-ready">
            <div>
              <span>{i18n.t('diagnostics.labels.currentIssue')}</span>
              <strong>{i18n.t('diagnostics.overview.noCriticalBlockers')}</strong>
              <p>{runtimeEnvironmentSummary.summary}</p>
            </div>
            <StatusBadge label={i18n.t('diagnostics.signals.stable')} tone="ready" />
          </div>
        )}

        <details className="diagnostics-raw-signals">
          <summary>{i18n.t('diagnostics.environmentSignals.title')}</summary>
          <ul>
              <li>isTauri: {String(envDiagnostic.tauriFlag)}</li>
              <li>IPC Bridge: {String(envDiagnostic.hasBridge)}</li>
              <li>window.ipc: {String(envDiagnostic.hasIpcObject)}</li>
              <li>isTauriRuntime: {String(envDiagnostic.isRuntime)}</li>
              <li>{i18n.t('diagnostics.environmentSignals.runtimeEnvironment')}: {envDiagnostic.isRuntime ? 'Tauri WebView' : i18n.t('diagnostics.environmentSignals.browserPreviewRuntime')}</li>
              <li>{i18n.t('diagnostics.environmentSignals.storageStatus')}: {envDiagnostic.storageStatus}</li>
              <li>{i18n.t('diagnostics.environmentSignals.credentialBackend')}: {envDiagnostic.credentialBackend}</li>
              <li>{i18n.t('diagnostics.environmentSignals.schemaVersion')}: {envDiagnostic.schemaVersion}</li>
              <li>{i18n.t('diagnostics.environmentSignals.bridgeStatus')}: {envDiagnostic.bridgeStatus}</li>
              <li>{i18n.t('diagnostics.environmentSignals.normalizedStatus')}: {effectiveBridgeStatus}</li>
              <li>{i18n.t('diagnostics.environmentSignals.omniSpeechEnabled')}: {String(envDiagnostic.omniSpeechEnabled)}</li>
              <li>{i18n.t('diagnostics.environmentSignals.speakerPlayback')}: {String(envDiagnostic.speechLocalPlayback)}</li>
              <li>{i18n.t('diagnostics.environmentSignals.virtualMic')}: {String(envDiagnostic.speechVirtualMic)}</li>
              <li>{i18n.t('diagnostics.environmentSignals.speakerFramesWritten')}: {audioRuntimeSnapshot.speech.speakerFramesWritten.toLocaleString()}</li>
              <li>{i18n.t('diagnostics.environmentSignals.monitorOutput')}: {runtimeSnapshot.bridge.resolvedPhysicalPlaybackDeviceId || i18n.t('diagnostics.status.unresolved')}</li>
              <li>{i18n.t('diagnostics.environmentSignals.capturePeak')}: {runtimeSnapshot.bridge.capturePeak.toFixed(6)}</li>
              <li>{i18n.t('diagnostics.environmentSignals.captureRms')}: {runtimeSnapshot.bridge.captureRms.toFixed(6)}</li>
              <li>{i18n.t('diagnostics.environmentSignals.silentPackets')}: {runtimeSnapshot.bridge.captureSilentPacketCount.toLocaleString()}</li>
              <li>{i18n.t('diagnostics.environmentSignals.invalidSamples')}: {runtimeSnapshot.bridge.captureInvalidSampleCount.toLocaleString()}</li>
            </ul>
          </details>
      </section>

      <section className="diagnostics-benchmark-panel">
        <div className="diagnostics-section-title">
          <div>
            <span className="diagnostics-kicker">{i18n.t('diagnostics.sections.modelDiagnostics')}</span>
            <h3>{i18n.t('diagnostics.benchmark.title')}</h3>
          </div>
          <StatusBadge label={benchmarkRunning ? i18n.t('diagnostics.status.running') : i18n.t('diagnostics.benchmark.pending')} tone={benchmarkRunning ? 'pending' : 'draft'} />
        </div>

        <div className="diagnostics-benchmark-controls">
          <div className="diagnostics-benchmark-row">
            <label className="diagnostics-benchmark-label">{i18n.t('diagnostics.benchmark.voiceModel')}</label>
            <select
              className="diagnostics-benchmark-select"
              disabled={benchmarkRunning || voiceModelOptions.length === 0}
              onChange={(event) => setBenchmarkModelId(event.target.value)}
              value={benchmarkModelId}
            >
              {voiceModelOptions.length > 0 ? (
                voiceModelOptions.map((model) => (
                  <option key={model.modelId} value={model.modelId}>{model.displayName}</option>
                ))
              ) : (
                <option value="">{i18n.t('diagnostics.benchmark.noVoiceModels')}</option>
              )}
            </select>
          </div>
          <div className="diagnostics-benchmark-row">
            <label className="diagnostics-benchmark-label">{i18n.t('diagnostics.benchmark.mp3Path')}</label>
            <input
              className="diagnostics-benchmark-input"
              disabled={benchmarkRunning}
              onChange={(event) => setBenchmarkMp3Path(event.target.value)}
              placeholder="E:\\path\\sample.mp3"
              type="text"
              value={benchmarkMp3Path}
            />
          </div>
          <div className="diagnostics-benchmark-row">
            <button className="icon-button diagnostics-primary-action" disabled={benchmarkRunning || voiceModelOptions.length === 0} onClick={() => void runBenchmarkTest()} type="button">
              <AppIcon name="activity" size={14} />
              {benchmarkRunning ? i18n.t('diagnostics.actions.testing') : i18n.t('diagnostics.benchmark.start')}
            </button>
            {benchmarkReport ? (
              <button className="icon-button" onClick={() => setBenchmarkModalOpen(true)} type="button">
                <AppIcon name="layers" size={14} />
                {i18n.t('diagnostics.benchmark.viewResults')}
              </button>
            ) : null}
          </div>
          {benchmarkError ? <div className="diagnostics-benchmark-error">{benchmarkError}</div> : null}
          {benchmarkRunning ? <div className="diagnostics-benchmark-progress">{i18n.t('diagnostics.benchmark.streamingProgress')}</div> : null}
        </div>
      </section>

      <section className="content-card page-card compact-card diagnostics-main-panel">
        <article className="diagnostics-overview-panel">
          <div className="diagnostics-section-title">
            <div>
              <span className="diagnostics-kicker">{i18n.t('diagnostics.sections.evidence')}</span>
              <h3>{i18n.t('diagnostics.sections.runtimeStatus')}</h3>
            </div>
            <StatusBadge label={overviewLabel} tone={overviewTone} />
          </div>
          <div className="diagnostics-overview-grid">
            {overviewSignals.map((signal) => (
              <div className="diagnostics-overview-item" key={signal.label}>
                <span>{signal.label}</span>
                <strong>{signal.value}</strong>
                <StatusBadge label={signal.meta} tone={signal.tone} />
              </div>
            ))}
          </div>
          <div className="control-toolbar" style={{ marginTop: 12 }}>
            {repairOptions.length > 0 ? (
              <button className="icon-button" disabled={busyAction !== null || selectedRepairIds.length === 0} onClick={() => void runAutomaticRepair()} type="button">
                <AppIcon name="spark" size={14} />
                {busyAction === 'auto-repair' ? i18n.t('diagnostics.repairs.running') : i18n.t('diagnostics.repairs.runSelected')}
              </button>
            ) : null}
          </div>
        </article>

        <div className="diagnostics-detail-grid">
            <div className="diagnostics-detail-panel scene-readiness-panel">
              <div className="diagnostics-section-title diagnostics-section-title-compact">
                <h3>{i18n.t('diagnostics.services.title')}</h3>
                <StatusBadge
                  label={i18n.t('diagnostics.services.stableCount', { stable: stableServiceCount, total: serviceMonitorItems.length })}
                  tone={serviceMonitorItems.some((item) => item.tone === 'warning') ? 'warning' : 'ready'}
                />
              </div>
              <div className="scene-readiness-list">
                {serviceMonitorItems.map((item) => {
                  return (
                    <div className={`scene-readiness-row scene-readiness-row-${item.tone}`} key={item.label}>
                      <strong className="scene-readiness-label">{item.label}</strong>
                      <small className="scene-readiness-summary" title={item.summary}>{item.summary}</small>
                      <div className="scene-readiness-meta">
                        <StatusBadge label={item.badge} tone={item.tone} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="diagnostics-detail-panel">
              <div className="diagnostics-section-title diagnostics-section-title-compact">
                <h3>{i18n.t('diagnostics.repairs.title')}</h3>
                <StatusBadge label={repairOptions.length > 0 ? i18n.t('diagnostics.labels.itemCount', { count: repairOptions.length }) : i18n.t('diagnostics.repairs.noneNeeded')} tone={repairOptions.length > 0 ? overviewTone : 'ready'} />
              </div>
              {repairOptions.length > 0 ? (
                <div className="repair-task-list">
                  <div className="compact-info-head">
                    <strong>{i18n.t('diagnostics.repairs.checklist')}</strong>
                    <label className="repair-task-toggle">
                      <input
                        checked={allRepairSelected}
                        onChange={() => setSelectedRepairIds(allRepairSelected ? [] : repairOptions.map((option) => option.id))}
                        type="checkbox"
                      />
                      {i18n.t('diagnostics.actions.selectAll')}
                    </label>
                  </div>
                  {repairOptions.map((option) => (
                    <label className="repair-task-row" key={option.id}>
                      <input
                        checked={selectedRepairIds.includes(option.id)}
                        onChange={() =>
                          setSelectedRepairIds((current) =>
                            current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id],
                          )
                        }
                        type="checkbox"
                      />
                      <div className="repair-task-copy">
                        <strong>{option.label}</strong>
                        <small>{option.summary}</small>
                      </div>
                      <StatusBadge label={i18n.t('diagnostics.repairs.autoRepair')} tone={option.tone} />
                    </label>
                  ))}
                </div>
              ) : (
                <div className="compact-alert-item compact-alert-item-ready">
                  <div className="compact-info-head">
                    <strong>{i18n.t('diagnostics.repairs.emptyTitle')}</strong>
                    <StatusBadge label={i18n.t('diagnostics.repairs.canContinue')} tone="ready" />
                  </div>
                  <p>{keyIssues.length > 0 ? i18n.t('diagnostics.repairs.remainingIssues') : i18n.t('diagnostics.repairs.noRuntimeIssues')}</p>
                  <div className="diagnostics-empty-actions">
                    <button className="icon-button" disabled={busyAction !== null} onClick={() => void runBusyAction('self-check', runDiagnosticsSelfCheckRuntime)} type="button">
                      <AppIcon name="search" size={14} />
                      {i18n.t('diagnostics.actions.rerunDiagnostics')}
                    </button>
                  </div>
                </div>
              )}

              {keyIssues.length > 0 ? (
                <div className="scene-manual-issues" style={{ marginTop: 12 }}>
                  <div className="compact-info-head scene-manual-issues-head">
                    <strong>{i18n.t('diagnostics.issues.keyEvents')}</strong>
                    <StatusBadge label={i18n.t('diagnostics.labels.itemCount', { count: keyIssues.length })} tone={overviewTone} />
                  </div>
                  <div className="compact-alert-list">
                    {keyIssues.map((issue) => {
                      const content = (
                        <>
                          <div className="compact-info-head">
                            <strong>{issue.title}</strong>
                            <StatusBadge label={issue.route ? i18n.t('diagnostics.labels.needsAction') : i18n.t('diagnostics.labels.watch')} tone={issue.tone} />
                          </div>
                          <p>{issue.detail}</p>
                        </>
                      );

                      if (issue.route) {
                        return (
                          <Link className={`compact-alert-item compact-alert-item-${issue.tone}`} key={issue.id} to={issue.route}>
                            {content}
                          </Link>
                        );
                      }

                      return (
                        <div className={`compact-alert-item compact-alert-item-${issue.tone}`} key={issue.id}>
                          {content}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
        </div>
      </section>

      {benchmarkModalOpen && benchmarkReport ? (
        <div className="benchmark-modal-backdrop" onClick={() => setBenchmarkModalOpen(false)}>
          <div className="benchmark-modal" onClick={(event) => event.stopPropagation()}>
            <div className="benchmark-modal-head">
              <div>
                <span className="diagnostics-kicker">{i18n.t('diagnostics.benchmark.results')}</span>
                <h3>{benchmarkReport.model}</h3>
                <p>{i18n.t('diagnostics.benchmark.resultSummary', { duration: (benchmarkReport.audioDurationSecs ?? 0).toFixed(1), count: benchmarkReport.runs[0]?.outputDeltas.filter((delta) => isTextOutputEvent(delta.eventType)).length ?? 0 })}</p>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <ExportButton onExport={(format) => {
                  if (!benchmarkReport) return;
                  const ts = new Date().toISOString().replace(/[:.]/g, '-');
                  const base = `benchmark-${benchmarkReport.model}-${ts}`;
                  if (format === 'json') {
                    exportJson(benchmarkReport, `${base}.json`);
                  } else {
                    exportFile(formatBenchmarkTxt(benchmarkReport), `${base}.txt`, 'text/plain');
                  }
                }} />
                <button className="icon-button" onClick={() => setBenchmarkModalOpen(false)} type="button">
                  <AppIcon name="close" size={16} />
                </button>
              </div>
            </div>
            <BenchmarkProgressBanner error={benchmarkError} progress={benchmarkProgress} />
            <BenchmarkReportDetail report={benchmarkReport} />
          </div>
        </div>
      ) : null}

      {liveEventsModalOpen ? (
        <div className="benchmark-modal-backdrop" onClick={() => setLiveEventsModalOpen(false)}>
          <div className="benchmark-modal" onClick={(event) => event.stopPropagation()}>
            <div className="benchmark-modal-head">
              <div>
                <span className="diagnostics-kicker">{i18n.t('diagnostics.liveEvents.title')}</span>
                <h3>{liveEvents?.model || '—'}</h3>
                <p>{i18n.t('diagnostics.liveEvents.summary', {
                  asrCount: liveEvents?.asrDeltas.length ?? 0,
                  outputCount: liveEvents?.outputDeltas.length ?? 0,
                  duration: liveEvents ? (liveEvents.elapsedMs / 1000).toFixed(1) : '0.0',
                })}</p>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <ExportButton onExport={(format) => {
                  if (!liveEvents) return;
                  const ts = new Date().toISOString().replace(/[:.]/g, '-');
                  const base = `live-events-${liveEvents.model || 'unknown'}-${ts}`;
                  if (format === 'json') {
                    exportJson(liveEvents, `${base}.json`);
                  } else {
                    exportFile(formatLiveEventsTxt(liveEvents), `${base}.txt`, 'text/plain');
                  }
                }} />
                <button className="icon-button" onClick={() => void fetchLiveEvents()} disabled={liveEventsLoading} type="button" title={i18n.t('diagnostics.liveEvents.refresh')}>
                  <AppIcon name="refresh" size={14} />
                </button>
                <button className="icon-button" onClick={() => setLiveEventsModalOpen(false)} type="button">
                  <AppIcon name="close" size={16} />
                </button>
              </div>
            </div>
            <LiveSessionEventDetail events={liveEvents} loading={liveEventsLoading} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BenchmarkProgressBanner({
  error,
  progress,
}: {
  error: string | null;
  progress: BenchmarkProgressView | null;
}) {
  if (!progress && !error) {
    return null;
  }

  const total = progress?.totalAudioChunks ?? 0;
  const sent = progress?.audioChunksSent ?? 0;
  const percent = total > 0 ? Math.min(100, Math.max(0, (sent / total) * 100)) : 0;
  const status = error ? 'error' : progress?.status ?? 'running';

  return (
    <div className={`benchmark-progress-card benchmark-progress-${status}`}>
      <div className="benchmark-progress-head">
        <span>{status === 'completed' ? i18n.t('diagnostics.status.completed') : status === 'error' ? i18n.t('diagnostics.status.failed') : i18n.t('diagnostics.status.running')}</span>
        <strong>{progress?.phase ?? 'starting'}</strong>
      </div>
      <p>{error || progress?.message || i18n.t('diagnostics.benchmark.waitingProgress')}</p>
      <div className="benchmark-progress-track" aria-label="benchmark progress">
        <div className="benchmark-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <small>{total > 0 ? `${sent} / ${total} chunks` : i18n.t('diagnostics.benchmark.waitingAudioChunks')}</small>
    </div>
  );
}

function isBinaryAudioOutputEvent(eventType: string) {
  return ['response.audio.delta', 'response.output_audio.delta', 'response.audio.done', 'response.output_audio.done'].includes(eventType);
}

function isTextOutputEvent(eventType: string) {
  return !isBinaryAudioOutputEvent(eventType);
}

function shouldUseManualBenchmarkMode(model: string) {
  return !model.toLowerCase().includes('livetranslate');
}

function textLength(value: string) {
  return [...value].length;
}

function shouldUseCandidate(current: string, candidate: string) {
  return !!candidate && textLength(candidate) >= textLength(current);
}

function buildOutputSegments(deltas: BenchmarkReport['runs'][number]['outputDeltas']) {
  const segments: string[] = [];
  let current = '';

  for (const delta of deltas) {
    const candidate = delta.rawText || delta.stash || delta.committedText;
    if (delta.eventType.endsWith('.delta')) {
      current += candidate;
      continue;
    }
    if (delta.eventType === 'response.audio_transcript.text') {
      if (shouldUseCandidate(current, candidate)) {
        current = candidate;
      }
      continue;
    }
    if (delta.eventType.endsWith('.done') || delta.eventType === 'response.done') {
      const finalText = shouldUseCandidate(current, candidate) ? candidate : current;
      if (finalText) {
        segments.push(finalText);
      }
      current = '';
      continue;
    }
    if (shouldUseCandidate(current, candidate)) {
      current = candidate;
    }
  }

  if (current) {
    segments.push(current);
  }

  return segments;
}

function BenchmarkReportDetail({ report }: { report: BenchmarkReport }) {
  const run = report.runs[0];
  if (!run) {
    return <div className="benchmark-empty">{i18n.t('diagnostics.benchmark.waitingFirstData')}</div>;
  }

  const fmt = (value: number | null | undefined, unit = 'ms') => (value == null ? 'N/A' : `${value.toFixed(1)}${unit}`);
  const textOutputDeltas = run.outputDeltas.filter((delta) => isTextOutputEvent(delta.eventType));
  const outputSegments = buildOutputSegments(textOutputDeltas);
  const segmentedOutput = outputSegments.join('');
  const asrFinal = run.asrFinal;
  const asrEventCount = run.asrDeltas.length;
  const fullTranslation = run.translationFinal || segmentedOutput || textOutputDeltas.map((delta) => delta.committedText || delta.stash || delta.rawText).join('');
  const isManualMode = (report.realtimeAudioMode ?? (shouldUseManualBenchmarkMode(run.model) ? 'manual' : 'server_vad')) === 'manual';
  const vadModeLabel = isManualMode ? i18n.t('diagnostics.benchmark.manualFullAudioMode') : i18n.t('diagnostics.benchmark.serverVadMode');
  const timeRangeEnd = Math.max(run.audioSendMs, run.responseDoneMs ?? 0, run.firstOutputMs ?? 0, run.responseCreatedMs ?? 0, 1);
  const pct = (value: number | null | undefined) => (value == null ? null : Math.max(0, Math.min(100, (value / timeRangeEnd) * 100)));
  const summary = report.summary;
  const translationChars = [...fullTranslation].length;
  const outputDuration = run.totalOutputDurationMs ?? (
    run.responseDoneMs != null && run.firstOutputMs != null
      ? run.responseDoneMs - run.firstOutputMs
      : run.responseDoneMs != null && run.responseCreatedMs != null ? run.responseDoneMs - run.responseCreatedMs : null
  );
  const modelTTFT = run.firstOutputMs != null && run.responseCreatedMs != null ? run.firstOutputMs - run.responseCreatedMs : null;
  const responseToFirst = modelTTFT;
  const translationThroughput = outputDuration && outputDuration > 0 && translationChars > 0
    ? translationChars / (outputDuration / 1000)
    : null;
  const intervalValues = textOutputDeltas.slice(1).map((delta, index) => delta.elapsedMs - textOutputDeltas[index]!.elapsedMs).filter((gap) => gap >= 0);
  const avgInterval = intervalValues.length > 0 ? intervalValues.reduce((sum, gap) => sum + gap, 0) / intervalValues.length : null;
  const hasTranscriptOnly = textOutputDeltas.length === 0 && !fullTranslation && !!asrFinal;
  const isSparse = textOutputDeltas.length > 0 && textOutputDeltas.length <= 3 && run.audioDurationSecs > 5;
  const responseDoneAudioChunksSent = run.responseDoneAudioChunksSent ?? null;
  const responseDoneAudioSentSecs = run.responseDoneAudioSentSecs ?? null;
  const responseDoneAudioPct = responseDoneAudioSentSecs == null || run.audioDurationSecs <= 0
    ? null
    : Math.min(100, Math.max(0, (responseDoneAudioSentSecs / run.audioDurationSecs) * 100));
  const responseDoneEarlyThresholdSecs = Math.max(1.5, run.audioDurationSecs * 0.1);
  const responseDoneBeforeFullAudio = responseDoneAudioSentSecs != null
    && responseDoneAudioSentSecs + responseDoneEarlyThresholdSecs < run.audioDurationSecs;
  const latestOutputDeltas = textOutputDeltas
    .map((delta, index) => ({ delta, index }))
    .reverse();
  const latestAsrDeltas = run.asrDeltas
    .map((delta, index) => ({ delta, index }))
    .reverse();

  return (
    <div className="benchmark-detail">
      {(isSparse || responseDoneBeforeFullAudio) ? (
        <div className="benchmark-warning">
          <strong>{i18n.t('diagnostics.benchmark.outputDiagnosticHint')}</strong>
          {isSparse ? <span>{i18n.t('diagnostics.benchmark.sparseOutputHint', { count: textOutputDeltas.length })}</span> : null}
          {responseDoneBeforeFullAudio ? <span>{i18n.t('diagnostics.benchmark.responseDoneBeforeFullAudio', { seconds: responseDoneAudioSentSecs?.toFixed(1), percent: responseDoneAudioPct?.toFixed(1) })}</span> : null}
        </div>
      ) : null}
      {hasTranscriptOnly ? (
        <div className="benchmark-warning">
          <strong>{i18n.t('diagnostics.benchmark.modelEventHint')}</strong>
          <span>{i18n.t('diagnostics.benchmark.transcriptOnlyHint')}</span>
        </div>
      ) : null}

      <div className="benchmark-section">
        <h4>{i18n.t('diagnostics.benchmark.timeline')}</h4>
        <div className="benchmark-timeline-track">
          <div className="benchmark-timeline-audio" style={{ width: `${pct(run.audioSendMs) ?? 0}%` }} title={i18n.t('diagnostics.benchmark.audioSendWithTime', { time: fmt(run.audioSendMs) })} />
          {pct(run.responseCreatedMs) != null ? <span className="benchmark-timeline-marker benchmark-timeline-response" style={{ left: `${pct(run.responseCreatedMs)}%` }} title={`Response Created ${fmt(run.responseCreatedMs)}`} /> : null}
          {pct(run.firstOutputMs) != null ? <span className="benchmark-timeline-marker benchmark-timeline-first" style={{ left: `${pct(run.firstOutputMs)}%` }} title={i18n.t('diagnostics.benchmark.firstTokenWithTime', { time: fmt(run.firstOutputMs) })} /> : null}
          {pct(run.responseDoneMs) != null ? <span className="benchmark-timeline-marker benchmark-timeline-done" style={{ left: `${pct(run.responseDoneMs)}%` }} title={`Response Done ${fmt(run.responseDoneMs)}`} /> : null}
        </div>
        <div className="benchmark-timeline-legend">
          <span><i className="benchmark-legend-audio" />{i18n.t('diagnostics.benchmark.audioSend')}</span>
          <span><i className="benchmark-legend-response" />Response</span>
          <span><i className="benchmark-legend-first" />{i18n.t('diagnostics.benchmark.firstToken')}</span>
        </div>
      </div>

      <div className="benchmark-section">
        <h4>{i18n.t('diagnostics.benchmark.stageDurations')}</h4>
        <div className="benchmark-metrics-grid">
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.websocketConnect')}</span>
            <strong>{fmt(run.connectMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>Session Ready</span>
            <strong>{fmt(run.sessionReadyMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.audioSend')}</span>
            <strong>{fmt(run.audioSendMs)}</strong>
            <small>{i18n.t('diagnostics.benchmark.audioChunksDuration', { chunks: run.audioChunksSent, seconds: run.audioDurationSecs.toFixed(1) })}</small>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.firstAsr')}</span>
            <strong>{fmt(run.firstAsrMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.firstToken')}</span>
            <strong>{fmt(run.firstOutputMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>Response Done</span>
            <strong>{fmt(run.responseDoneMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.audioSentAtDone')}</span>
            <strong>{responseDoneAudioSentSecs == null ? 'N/A' : `${responseDoneAudioSentSecs.toFixed(1)}s`}</strong>
            <small>{responseDoneAudioChunksSent == null ? i18n.t('diagnostics.benchmark.noChunkRecorded') : `${responseDoneAudioChunksSent} chunks · ${responseDoneAudioPct?.toFixed(1) ?? 'N/A'}%`}</small>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.firstTokenAfterResponse')}</span>
            <strong>{modelTTFT == null ? 'N/A' : modelTTFT < 0 ? i18n.t('diagnostics.benchmark.beforeResponse') : fmt(modelTTFT)}</strong>
          </div>
        </div>
      </div>

      <div className="benchmark-section">
        <h4>{i18n.t('diagnostics.benchmark.vadAndAsr')}</h4>
        <div className="benchmark-metrics-grid">
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.vadMode')}</span>
            <strong>{vadModeLabel}</strong>
            <small>{isManualMode ? i18n.t('diagnostics.benchmark.manualModeNoServerVad') : i18n.t('diagnostics.benchmark.serverDecidesSpeechBoundaries')}</small>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.vadSpeechStart')}</span>
            <strong>{isManualMode ? i18n.t('diagnostics.benchmark.notApplicable') : fmt(run.speechStartedMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.vadSpeechEnd')}</span>
            <strong>{isManualMode ? i18n.t('diagnostics.benchmark.notApplicable') : fmt(run.speechStoppedMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.streamingAsrEvents')}</span>
            <strong>{asrEventCount}</strong>
          </div>
          <div className="benchmark-metric benchmark-metric-wide">
            <span>{i18n.t('diagnostics.benchmark.asrFinalText')}</span>
            <small className="benchmark-text-preview">{asrFinal || i18n.t('diagnostics.benchmark.none')}</small>
          </div>
        </div>
      </div>
      <div className="benchmark-section">
        <h4>{i18n.t('diagnostics.benchmark.outputTimingStats')}</h4>
        <div className="benchmark-metrics-grid">
          <div className="benchmark-metric">
            <span>Response Created</span>
            <strong>{fmt(run.responseCreatedMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.firstToken')}</span>
            <strong>{fmt(run.firstOutputMs)}</strong>
            <small>{responseToFirst == null ? 'N/A' : responseToFirst < 0 ? i18n.t('diagnostics.benchmark.beforeResponseWithTime', { time: fmt(Math.abs(responseToFirst)) }) : i18n.t('diagnostics.benchmark.afterResponseWithTime', { time: fmt(responseToFirst) })}</small>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.firstCommit')}</span>
            <strong>{fmt(run.firstCommittedMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.totalOutputDuration')}</span>
            <strong>{fmt(outputDuration)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.outputEventCount')}</span>
            <strong>{textOutputDeltas.length}</strong>
            <small>{i18n.t('diagnostics.benchmark.responseDoneCount', { count: run.responseCount })}</small>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.responseSegments')}</span>
            <strong>{Math.max(run.responseCount, outputSegments.length)}</strong>
            <small>{isManualMode ? i18n.t('diagnostics.benchmark.manualUsuallyOneSegment') : i18n.t('diagnostics.benchmark.serverVadMultiSegment')}</small>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.outputCharacters')}</span>
            <strong>{translationChars}</strong>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.throughput')}</span>
            <strong>{translationThroughput == null ? 'N/A' : i18n.t('diagnostics.benchmark.charactersPerSecond', { value: translationThroughput.toFixed(1) })}</strong>
          </div>
        </div>
      </div>

      <div className="benchmark-section">
        <h4>{i18n.t('diagnostics.benchmark.deltaIntervalStats')}</h4>
        <div className="benchmark-metrics-grid">
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.averageInterval')}</span>
            <strong>{fmt(summary.avgOutputDeltaIntervalMs ?? avgInterval)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>P50</span>
            <strong>{fmt(summary.p50DeltaIntervalMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>P90</span>
            <strong>{fmt(summary.p90DeltaIntervalMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>P99</span>
            <strong>{fmt(summary.p99DeltaIntervalMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.minInterval')}</span>
            <strong>{fmt(summary.minDeltaIntervalMs)}</strong>
          </div>
          <div className="benchmark-metric">
            <span>{i18n.t('diagnostics.benchmark.maxInterval')}</span>
            <strong>{fmt(summary.maxDeltaIntervalMs)}</strong>
          </div>
        </div>
      </div>

      <div className="benchmark-section">
        <h4>{i18n.t('diagnostics.benchmark.liveAndFinalOutput', { count: translationChars })}</h4>
        <div className="benchmark-translation">{fullTranslation || i18n.t('diagnostics.benchmark.waitingOutput')}</div>
      </div>
      {outputSegments.length > 0 ? (
        <div className="benchmark-section">
          <h4>{i18n.t('diagnostics.benchmark.segmentedOutput', { count: outputSegments.length })}</h4>
          <div className="benchmark-translation">{segmentedOutput || i18n.t('diagnostics.benchmark.waitingOutput')}</div>
        </div>
      ) : null}

      {textOutputDeltas.length > 0 ? (
        <div className="benchmark-section">
          <h4>{i18n.t('diagnostics.benchmark.outputEventDetails', { count: textOutputDeltas.length })}</h4>
          <div className="benchmark-delta-table-wrap">
            <table className="benchmark-delta-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{i18n.t('diagnostics.benchmark.timeMs')}</th>
                  <th>{i18n.t('diagnostics.benchmark.event')}</th>
                  <th>Stash / Delta</th>
                  <th>{i18n.t('diagnostics.benchmark.committedText')}</th>
                </tr>
              </thead>
              <tbody>
                {latestOutputDeltas.map(({ delta, index }) => (
                  <tr key={`${delta.elapsedMs}-${index}`}>
                    <td className="benchmark-delta-idx">{index + 1}</td>
                    <td className="benchmark-delta-time">{delta.elapsedMs.toFixed(1)}</td>
                    <td className="benchmark-delta-type">{delta.eventType.replace('response.', '')}</td>
                    <td className="benchmark-delta-stash">{delta.stash || (!delta.committedText ? delta.rawText : '') || '—'}</td>
                    <td className="benchmark-delta-committed">{delta.committedText || (!delta.stash ? delta.rawText : '') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {run.asrDeltas.length > 0 ? (
        <div className="benchmark-section">
          <h4>{i18n.t('diagnostics.benchmark.asrEventDetails', { count: run.asrDeltas.length })}</h4>
          <div className="benchmark-delta-table-wrap">
            <table className="benchmark-delta-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{i18n.t('diagnostics.benchmark.timeMs')}</th>
                  <th>Stash</th>
                  <th>{i18n.t('diagnostics.benchmark.text')}</th>
                </tr>
              </thead>
              <tbody>
                {latestAsrDeltas.map(({ delta, index }) => (
                  <tr key={`${delta.elapsedMs}-${index}`}>
                    <td className="benchmark-delta-idx">{index + 1}</td>
                    <td className="benchmark-delta-time">{delta.elapsedMs.toFixed(1)}</td>
                    <td className="benchmark-delta-stash">{delta.stash || '—'}</td>
                    <td className="benchmark-delta-committed">{delta.text || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function fmtMs(value: number | null | undefined): string {
  if (value == null) return 'N/A';
  return `${value.toFixed(0)}ms`;
}

function exportFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportJson(data: unknown, filename: string) {
  exportFile(JSON.stringify(data, null, 2), filename, 'application/json');
}

function formatLiveEventsTxt(events: LiveSessionEvents): string {
  const lines: string[] = [];
  lines.push(`=== Live Session Events ===`);
  lines.push(`Model: ${events.model}`);
  lines.push(`Session Started: ${events.sessionStartedAt}`);
  lines.push(`Elapsed: ${events.elapsedMs}ms`);
  lines.push('');
  lines.push('--- Pipeline Milestones ---');
  const m = events.pipelineMilestones;
  lines.push(`  Preconnect:        ${fmtMs(m.preconnectStartedMs)}`);
  lines.push(`  Session Ready:     ${fmtMs(m.sessionReadyMs)}`);
  lines.push(`  Route Started:     ${fmtMs(m.routeStartedMs)}`);
  lines.push(`  First Audio Sent:  ${fmtMs(m.firstAudioSentMs)}`);
  lines.push(`  First Speech:      ${fmtMs(m.firstSpeechStartedMs)}`);
  lines.push(`  Queued Chunks:     ${m.queuedAudioChunks ?? 'N/A'}`);
  lines.push(`  Dropped Before Ready: ${m.droppedBeforeReady ?? 'N/A'}`);
  lines.push('');
  lines.push('--- Audio Diagnostics ---');
  lines.push(`  First Audible Chunk:       ${fmtMs(m.firstAudibleChunkMs)}`);
  lines.push(`  Silence Skipped (pre-audible): ${m.silenceSkippedBeforeAudible ?? 'N/A'}`);
  lines.push(`  Total Input Chunks (at speech): ${m.totalInputChunksAtSpeech ?? 'N/A'}`);
  // Computed timing analysis
  if (m.firstAudioSentMs != null && m.firstAudibleChunkMs != null) {
    lines.push(`  Audio Sent -> Audible:     ${m.firstAudibleChunkMs - m.firstAudioSentMs}ms`);
  }
  if (m.firstAudioSentMs != null && m.firstSpeechStartedMs != null) {
    lines.push(`  Audio Sent -> VAD Speech:  ${m.firstSpeechStartedMs - m.firstAudioSentMs}ms`);
  }
  if (m.firstAudibleChunkMs != null && m.firstSpeechStartedMs != null) {
    lines.push(`  Audible -> VAD Speech:     ${m.firstSpeechStartedMs - m.firstAudibleChunkMs}ms`);
  }
  if (m.totalInputChunksAtSpeech != null && m.firstSpeechStartedMs != null) {
    lines.push(`  Chunks sent to server (at speech): ~${m.totalInputChunksAtSpeech} input chunks`);
  }
  lines.push('');
  if (events.asrDeltas.length > 0) {
    lines.push(`--- ASR Events (${events.asrDeltas.length}) ---`);
    lines.push(`  #\tTime\tEventType\tStash\tText`);
    events.asrDeltas.forEach((d, i) => {
      lines.push(`  ${i + 1}\t${d.elapsedMs.toFixed(1)}ms\t${d.eventType}\t${d.stash || '-'}\t${d.text || '-'}`);
    });
    if (events.asrFinal) lines.push(`  Final: ${events.asrFinal}`);
    lines.push('');
  }
  if (events.outputDeltas.length > 0) {
    lines.push(`--- Output Events (${events.outputDeltas.length}) ---`);
    lines.push(`  #\tTime\tEventType\tStash\tCommitted`);
    events.outputDeltas.forEach((d, i) => {
      lines.push(`  ${i + 1}\t${d.elapsedMs.toFixed(1)}ms\t${d.eventType}\t${d.stash || '-'}\t${d.committedText || '-'}`);
    });
    if (events.translationFinal) lines.push(`  Final: ${events.translationFinal}`);
    lines.push('');
  }
  return lines.join('\n');
}

function formatBenchmarkTxt(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`=== Benchmark Report ===`);
  lines.push(`Model: ${report.model}`);
  lines.push(`Audio File: ${report.audioFile}`);
  lines.push(`Audio Duration: ${report.audioDurationSecs.toFixed(1)}s`);
  lines.push('');
  const s = report.summary;
  lines.push('--- Summary ---');
  lines.push(`  Runs: ${s.runCount}, Successful: ${s.successfulRuns}`);
  lines.push(`  Avg Connect: ${s.avgConnectMs.toFixed(0)}ms`);
  lines.push(`  Avg Session Ready: ${s.avgSessionReadyMs.toFixed(0)}ms`);
  lines.push(`  Avg TTFT: ${s.avgTimeToFirstTokenMs?.toFixed(0) ?? 'N/A'}ms`);
  lines.push(`  Avg TTFC: ${s.avgTimeToFirstCommittedMs?.toFixed(0) ?? 'N/A'}ms`);
  lines.push(`  Avg Delta Interval: ${s.avgOutputDeltaIntervalMs?.toFixed(1) ?? 'N/A'}ms`);
  lines.push(`  P50/P90/P99 Delta: ${s.p50DeltaIntervalMs?.toFixed(1) ?? 'N/A'} / ${s.p90DeltaIntervalMs?.toFixed(1) ?? 'N/A'} / ${s.p99DeltaIntervalMs?.toFixed(1) ?? 'N/A'}ms`);
  lines.push(`  Min/Max Delta: ${s.minDeltaIntervalMs?.toFixed(1) ?? 'N/A'} / ${s.maxDeltaIntervalMs?.toFixed(1) ?? 'N/A'}ms`);
  lines.push('');
  report.runs.forEach((run) => {
    lines.push(`--- Run #${run.runIndex} ---`);
    lines.push(`  Connect: ${run.connectMs}ms | Session Ready: ${run.sessionReadyMs}ms | Audio Send: ${run.audioSendMs}ms`);
    lines.push(`  Audio Chunks: ${run.audioChunksSent} (${run.audioDurationSecs.toFixed(1)}s)`);
    lines.push(`  First ASR: ${run.firstAsrMs?.toFixed(0) ?? 'N/A'}ms | First Output: ${run.firstOutputMs?.toFixed(0) ?? 'N/A'}ms`);
    lines.push(`  Response Done: ${run.responseDoneMs?.toFixed(0) ?? 'N/A'}ms`);
    lines.push(`  Speech Started: ${run.speechStartedMs?.toFixed(0) ?? 'N/A'}ms | Speech Stopped: ${run.speechStoppedMs?.toFixed(0) ?? 'N/A'}ms`);
    if (run.asrFinal) lines.push(`  ASR Final: ${run.asrFinal}`);
    if (run.translationFinal) lines.push(`  Translation Final: ${run.translationFinal}`);
    if (run.outputDeltas.length > 0) {
      lines.push(`  Output Deltas (${run.outputDeltas.length}):`);
      lines.push(`    #\tTime\tEventType\tStash\tCommitted`);
      run.outputDeltas.forEach((d, i) => {
        lines.push(`    ${i + 1}\t${d.elapsedMs.toFixed(1)}ms\t${d.eventType}\t${d.stash || '-'}\t${d.committedText || '-'}`);
      });
    }
    lines.push('');
  });
  return lines.join('\n');
}

function ExportButton({ onExport }: { onExport: (format: 'json' | 'txt') => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button className="icon-button" onClick={() => setOpen((v) => !v)} type="button" title={i18n.t('diagnostics.export.title')}>
        <AppIcon name="download" size={14} />
      </button>
      {open ? (
        <div style={{
          position: 'absolute', right: 0, top: '100%', marginTop: 4,
          background: 'var(--surface-bg, #fff)', border: '1px solid var(--border, #ccc)',
          borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 10,
          minWidth: 80, padding: '4px 0',
        }}>
          <button type="button" onClick={() => { onExport('json'); setOpen(false); }}
            style={{ display: 'block', width: '100%', padding: '6px 12px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 13 }}>
            JSON
          </button>
          <button type="button" onClick={() => { onExport('txt'); setOpen(false); }}
            style={{ display: 'block', width: '100%', padding: '6px 12px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 13 }}>
            TXT
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PipelineMilestonesGrid({ milestones }: { milestones: LiveSessionEvents['pipelineMilestones'] }) {
  return (
    <div className="benchmark-section">
      <h4>{i18n.t('diagnostics.liveEvents.pipelineTitle')}</h4>
      <div className="benchmark-metrics-grid">
        <div className="benchmark-metric">
          <span>{i18n.t('diagnostics.liveEvents.preconnect')}</span>
          <strong>{fmtMs(milestones.preconnectStartedMs)}</strong>
        </div>
        <div className="benchmark-metric">
          <span>{i18n.t('diagnostics.liveEvents.sessionReady')}</span>
          <strong>{fmtMs(milestones.sessionReadyMs)}</strong>
        </div>
        <div className="benchmark-metric">
          <span>{i18n.t('diagnostics.liveEvents.routeStarted')}</span>
          <strong>{fmtMs(milestones.routeStartedMs)}</strong>
        </div>
        <div className="benchmark-metric">
          <span>{i18n.t('diagnostics.liveEvents.firstAudioSent')}</span>
          <strong>{fmtMs(milestones.firstAudioSentMs)}</strong>
        </div>
        <div className="benchmark-metric">
          <span>{i18n.t('diagnostics.liveEvents.firstSpeechStarted')}</span>
          <strong>{fmtMs(milestones.firstSpeechStartedMs)}</strong>
        </div>
        <div className="benchmark-metric">
          <span>{i18n.t('diagnostics.liveEvents.queuedChunks')}</span>
          <strong>{milestones.queuedAudioChunks ?? 'N/A'}</strong>
        </div>
        <div className="benchmark-metric">
          <span>{i18n.t('diagnostics.liveEvents.droppedBeforeReady')}</span>
          <strong>{milestones.droppedBeforeReady ?? 'N/A'}</strong>
        </div>
        <div className="benchmark-metric">
          <span>First Audible Chunk</span>
          <strong>{fmtMs(milestones.firstAudibleChunkMs)}</strong>
        </div>
        <div className="benchmark-metric">
          <span>Silence Skipped (before audible)</span>
          <strong>{milestones.silenceSkippedBeforeAudible ?? 'N/A'}</strong>
        </div>
        <div className="benchmark-metric">
          <span>Total Input Chunks (at speech)</span>
          <strong>{milestones.totalInputChunksAtSpeech ?? 'N/A'}</strong>
        </div>
      </div>
    </div>
  );
}

function LiveSessionEventDetail({ events, loading }: { events: LiveSessionEvents | null; loading: boolean }) {
  if (loading && !events) {
    return <div className="benchmark-empty">{i18n.t('diagnostics.liveEvents.loading')}</div>;
  }

  if (!events) {
    return <div className="benchmark-empty">{i18n.t('diagnostics.liveEvents.empty')}</div>;
  }

  const asrDeltas = [...events.asrDeltas].reverse();
  const outputDeltas = [...events.outputDeltas].reverse();
  const hasEvents = asrDeltas.length > 0 || outputDeltas.length > 0;

  if (!hasEvents) {
    return <div className="benchmark-empty">{i18n.t('diagnostics.liveEvents.empty')}</div>;
  }

  return (
    <div className="benchmark-report">
      <PipelineMilestonesGrid milestones={events.pipelineMilestones} />

      {asrDeltas.length > 0 ? (
        <div className="benchmark-section">
          <h4>{i18n.t('diagnostics.liveEvents.asrTable')} ({events.asrDeltas.length})</h4>
          {events.asrFinal ? <p className="benchmark-translation">{events.asrFinal}</p> : null}
          <div className="benchmark-delta-table-wrap">
            <table className="benchmark-delta-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{i18n.t('diagnostics.liveEvents.time')}</th>
                  <th>{i18n.t('diagnostics.liveEvents.eventType')}</th>
                  <th>{i18n.t('diagnostics.liveEvents.stash')}</th>
                  <th>{i18n.t('diagnostics.liveEvents.text')}</th>
                </tr>
              </thead>
              <tbody>
                {asrDeltas.map((delta, index) => (
                  <tr key={`asr-${index}`}>
                    <td className="benchmark-delta-idx">{events.asrDeltas.length - index}</td>
                    <td className="benchmark-delta-time">{delta.elapsedMs.toFixed(1)}ms</td>
                    <td className="benchmark-delta-event">{delta.eventType}</td>
                    <td className="benchmark-delta-stash">{delta.stash || '—'}</td>
                    <td className="benchmark-delta-committed">{delta.text || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {outputDeltas.length > 0 ? (
        <div className="benchmark-section">
          <h4>{i18n.t('diagnostics.liveEvents.outputTable')} ({events.outputDeltas.length})</h4>
          {events.translationFinal ? <p className="benchmark-translation">{events.translationFinal}</p> : null}
          <div className="benchmark-delta-table-wrap">
            <table className="benchmark-delta-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{i18n.t('diagnostics.liveEvents.time')}</th>
                  <th>{i18n.t('diagnostics.liveEvents.eventType')}</th>
                  <th>{i18n.t('diagnostics.liveEvents.stash')}</th>
                  <th>{i18n.t('diagnostics.liveEvents.committedText')}</th>
                </tr>
              </thead>
              <tbody>
                {outputDeltas.map((delta, index) => (
                  <tr key={`out-${index}`}>
                    <td className="benchmark-delta-idx">{events.outputDeltas.length - index}</td>
                    <td className="benchmark-delta-time">{delta.elapsedMs.toFixed(1)}ms</td>
                    <td className="benchmark-delta-event">{delta.eventType}</td>
                    <td className="benchmark-delta-stash">{delta.stash || '—'}</td>
                    <td className="benchmark-delta-committed">{delta.committedText || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default DiagnosticsPage;
