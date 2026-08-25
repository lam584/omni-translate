import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import AppIcon from '../components/icons/AppIcon';
import ModalDialog from '../components/ModalDialog';
import StatusBadge from '../components/page/StatusBadge';
import type { StatusTone } from '../components/page/StatusBadge';
import i18n from '../i18n/config';
import { installDriverRuntime, repairDriverRuntime, startBridgeServiceRuntime } from '../runtime/bridge-runtime';
import { useDesktopApiV2 } from '../runtime/desktop-api-context';
import type { BenchmarkReport } from '../runtime/benchmark-runtime';
import { readProviderSecret } from '../runtime/provider-runtime';
import { createLogger } from '../runtime/logger';
import { resolveRuntimeBridgeStatus } from '../runtime/runtime-status';
import { hasInvokeBridge } from '../runtime/tauri-runtime';
import type { DiagnosticsExportScope } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import { useAppStore } from '../stores/app-store';
import { useRuntimeSessionStoreSlices } from '../stores/app-store-slices';
import { describeUnknownError } from '../utils/describe-unknown-error';
import { resolveRecommendedDriverAction } from '../utils/driver-management';
import { resolveInteractionCapabilities, resolveRealtimeAudioMode } from '../utils/provider-model-capabilities';
import { collectProviderModelOptions } from '../utils/provider-model-options';
import { isOverlayVisible } from '../utils/scene-readiness';
import { LogLevelControl } from './diagnostics/LogLevelControl';
import { BenchmarkHistoryPanel } from './diagnostics/BenchmarkHistoryPanel';
import { useDiagnosticsWorkbenchController } from './diagnostics/useDiagnosticsActions';
import { CUSTOM_AUDIO_VALUE } from './diagnostics/benchmark-audio-fixtures';
import { useBenchmarkController, type BenchmarkVoiceModel } from './diagnostics/useBenchmarkController';
import { formatSemanticJudgeError, runBenchmarkSemanticJudge, type BenchmarkJudgeModel, type BenchmarkSemanticJudgeResult } from './diagnostics/benchmarkSemanticJudge';
import { scoreBenchmarkReport, type BenchmarkJudgeState, type BenchmarkRunState, type BenchmarkScoreV1 } from './diagnostics/benchmarkReportScore';
import { resolveBenchmarkReferenceTranslation, resolveBenchmarkSourceText } from './diagnostics/benchmarkReferenceText';
import { benchmarkScoreFromHistory, historyScoreStatus, type BenchmarkHistoryRecord } from './diagnostics/benchmarkHistory';
import { formatHistoryTime } from './diagnostics/benchmarkHistoryFormat';
import { useBenchmarkHistory } from './diagnostics/useBenchmarkHistory';
import {
  BenchmarkProgressBanner, BenchmarkReportDetail, DiagnosticsReportExporter, ExportButton,
  LiveSessionEventDetail, buildOutputSegments, fmtMs, formatBenchmarkTxt,
  formatLiveEventsTxt, isBinaryAudioOutputEvent, isTextOutputEvent,
  shouldUseCandidate, textLength,
} from './diagnostics/DiagnosticsDetails';
import {
  buildOverviewIssues, buildOverviewSignals, buildServiceMonitorItems,
  createEmptyBenchmarkReport, formatBridgeStateLabel, formatCaptureBackendLabel, formatCaptureStateLabel,
  formatDriverHealthLabel, formatStatusLabel, getIssueToneRank,
  formatProcessLoopbackStatusLabel, getRuntimeEnvironmentSummary, hasSameIds, resolveStatusTone,
} from './diagnostics/diagnosticsOverview';
import WatchSessionReportPanel from './watch-report/WatchSessionReportPanel';
import type { ExportArtifactReceipt } from '../runtime/export-artifact-runtime';

const diagnosticsLogger = createLogger('runtime');

function recordBenchmarkJudgeCredentialFailure(error: unknown): void {
  diagnosticsLogger.warn('benchmark judge credential could not be read', describeUnknownError(error));
}

type RepairOption = {
  id: string;
  label: string;
  summary: string;
  tone: StatusTone;
  issueIds: string[];
  run: () => Promise<void>;
};

export const diagnosticsPageHelpers = {
  hasSameIds, resolveStatusTone, formatStatusLabel, formatBridgeStateLabel, formatCaptureStateLabel,
  formatDriverHealthLabel, formatCaptureBackendLabel, formatProcessLoopbackStatusLabel,
  getIssueToneRank, isOverlayVisible, getRuntimeEnvironmentSummary,
  buildOverviewIssues, buildOverviewSignals, buildServiceMonitorItems, createEmptyBenchmarkReport,
  isBinaryAudioOutputEvent, isTextOutputEvent, textLength,
  shouldUseCandidate, buildOutputSegments, fmtMs, formatLiveEventsTxt, formatBenchmarkTxt,
  BenchmarkProgressBanner, BenchmarkReportDetail, LiveSessionEventDetail,
};

function getRuntimeErrorOriginal(snapshot: RuntimeSnapshot): string | null {
  if (resolveRuntimeBridgeStatus(snapshot) !== 'runtime-error') return null;

  const errorNotification = [...snapshot.notifications]
    .reverse()
    .find((notification) => notification.level === 'error');

  return errorNotification?.message ?? null;
}

export async function runRecommendedBridgeAction(snapshot: RuntimeSnapshot, configDraft: ReturnType<typeof useAppStore.getState>['configDraft']) {
  const { bridge } = snapshot;
  switch (resolveRecommendedDriverAction(bridge)) {
    case 'install': return installDriverRuntime(configDraft);
    case 'reinstall': return repairDriverRuntime('reinstall-driver', configDraft);
    case 'start-bridge': return startBridgeServiceRuntime(configDraft);
    default: return repairDriverRuntime('restart-bridge', configDraft);
  }
}

function buildBenchmarkScore(
  report: BenchmarkReport,
  benchmarkState: BenchmarkRunState,
  semanticJudge: BenchmarkSemanticJudgeResult | null = null,
  judgeState: BenchmarkJudgeState = 'idle',
  judgeError: string | null = null,
  judgeContext: {
    missingEvidence?: readonly string[];
    model?: string | null;
    rubricVersion?: string | null;
  } = {},
): BenchmarkScoreV1 {
  return scoreBenchmarkReport(report, {
    benchmarkState,
    judgeError,
    judgeMissingEvidence: judgeContext.missingEvidence,
    judgeModel: judgeContext.model,
    judgeRubricVersion: judgeContext.rubricVersion,
    judgeState,
    semanticJudge,
    sourceText: resolveBenchmarkSourceText(report.audioFile),
    referenceTranslation: resolveBenchmarkReferenceTranslation(report.audioFile),
  });
}

function DiagnosticsPage() {
  const desktopApi = useDesktopApiV2();
  const { configDraft, runtimeSnapshot, audioRuntimeSnapshot, setRuntimeSnapshot } = useRuntimeSessionStoreSlices();
  const diagnostics = runtimeSnapshot.diagnostics;
  const [exportScopeOverride, setExportScopeOverride] = useState<DiagnosticsExportScope | null>(null);
  const exportScope = exportScopeOverride ?? diagnostics.lastExportScope ?? configDraft.diagnostics.lastExportScope;
  const voiceModelOptions = useMemo(
    () => collectProviderModelOptions(configDraft.providers, {
      scenarios: ['watch', 'game', 'voice-room'],
      dedupeKey: 'provider-model',
      project: ({ templateId, modelId, provider }): BenchmarkVoiceModel => {
        const apiModelId = modelId.includes('::') ? modelId.split('::')[1] || modelId : modelId;
        return {
          modelId: `${templateId}::${modelId}`,
          apiModelId,
          displayName: `${provider.displayName ?? templateId}: ${modelId}`,
          authReference: provider.authRef?.reference ?? '',
          realtimeAudioMode: resolveRealtimeAudioMode(apiModelId, provider.localModelCapabilityRegistry ?? [], apiModelId),
          interactionCapabilities: resolveInteractionCapabilities(apiModelId, provider.localModelCapabilityRegistry ?? [], apiModelId),
          providerKind: provider.kind,
          baseUrl: provider.baseUrl,
          authHeaderName: provider.authRef?.headerName ?? 'Authorization',
          authScheme: provider.authRef?.scheme ?? 'bearer',
          provider,
        };
      },
    }),
    [configDraft.providers],
  );
  const semanticJudgeModels = useMemo(
    () => collectProviderModelOptions(configDraft.providers, {
      scenarios: ['subtitle-translate'],
      dedupeKey: 'provider-model',
      project: ({ templateId, modelId, provider }): BenchmarkJudgeModel => {
        const apiModelId = modelId.includes('::') ? modelId.split('::')[1] || modelId : modelId;
        return {
          modelId: `${templateId}::${modelId}`,
          displayName: `${provider.displayName ?? templateId}: ${modelId}`,
          authReference: provider.authRef?.reference ?? '',
          provider: { ...provider, model: apiModelId },
        };
      },
    }),
    [configDraft.providers],
  );

  const [historyExpanded, setHistoryExpanded] = useState(false);
  const {
    clear: clearStoredBenchmarkHistory,
    error: benchmarkHistoryError,
    get: getStoredBenchmarkHistory,
    loadMore: loadMoreBenchmarkHistory,
    loading: benchmarkHistoryLoading,
    page: benchmarkHistoryPage,
    refresh: refreshBenchmarkHistory,
    remove: removeStoredBenchmarkHistory,
    save: saveBenchmarkHistoryRecord,
  } = useBenchmarkHistory(historyExpanded);
  const historyRecordId = useRef<string | null>(null);
  const historyRunId = useRef<string | null>(null);
  const [historyDetail, setHistoryDetail] = useState<BenchmarkHistoryRecord | null>(null);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyMutationError, setHistoryMutationError] = useState<string | null>(null);
  const hasNativeShell = desktopApi.capabilities.hasNativeShell;
  const persistBenchmarkHistory = useCallback(async ({
    error = null,
    report,
    runStatus,
    score,
  }: {
    error?: string | null;
    report: BenchmarkReport;
    runStatus: 'running' | 'completed' | 'failed';
    score: BenchmarkScoreV1;
  }) => {
    if (!hasNativeShell) return;
    const runId = historyRunId.current;
    if (!runId) return;
    try {
      const persisted = await saveBenchmarkHistoryRecord({
        recordId: historyRecordId.current ?? undefined,
        runId,
        model: report.model,
        runStatus,
        scoreStatus: historyScoreStatus(score),
        scoreVersion: score.version,
        totalScore: score.total,
        grade: score.grade,
        report,
        score,
        error,
      });
      historyRecordId.current = persisted.recordId;
      setHistoryMutationError(null);
    } catch (caught) {
      setHistoryMutationError(describeUnknownError(caught));
    }
  }, [hasNativeShell, saveBenchmarkHistoryRecord]);

  const {
    modelId: benchmarkModelId,
    setModelId: setBenchmarkModelId,
    audioSource: benchmarkAudioSource,
    setAudioSource: setBenchmarkAudioSource,
    customPath: benchmarkCustomPath,
    setCustomPath: setBenchmarkCustomPath,
    audioPresets: benchmarkAudioPresets,
    running: benchmarkRunning,
    report: benchmarkReport,
    error: benchmarkError,
    modalOpen: benchmarkModalOpen,
    setModalOpen: setBenchmarkModalOpen,
    progress: benchmarkProgress,
    run: runBenchmarkTest,
  } = useBenchmarkController(voiceModelOptions, {
    onStarted: async ({ report, runId }) => {
      historyRecordId.current = null;
      historyRunId.current = runId;
      await persistBenchmarkHistory({
        report,
        runStatus: 'running',
        score: buildBenchmarkScore(report, 'running'),
      });
    },
    onCompleted: async ({ report }) => {
      await persistBenchmarkHistory({
        report,
        runStatus: 'completed',
        score: buildBenchmarkScore(report, 'completed'),
      });
    },
    onFailed: async ({ error, report }) => {
      await persistBenchmarkHistory({
        error: error ?? null,
        report,
        runStatus: 'failed',
        score: buildBenchmarkScore(report, 'failed'),
      });
    },
  });
  const [semanticJudgeModelId, setSemanticJudgeModelId] = useState('');
  const [semanticJudgeRunning, setSemanticJudgeRunning] = useState(false);
  const [semanticJudgeError, setSemanticJudgeError] = useState<string | null>(null);
  const [semanticJudgeResult, setSemanticJudgeResult] = useState<BenchmarkSemanticJudgeResult | null>(null);
  const [semanticJudgeEvidenceMissing, setSemanticJudgeEvidenceMissing] = useState<readonly string[]>([]);
  const automaticJudgeKey = useRef<string | null>(null);
  const effectiveSemanticJudgeModelId = semanticJudgeModels.some((model) => model.modelId === semanticJudgeModelId)
    ? semanticJudgeModelId
    : semanticJudgeModels[0]?.modelId ?? '';
  const selectedSemanticJudgeModel = semanticJudgeModels.find((model) => model.modelId === effectiveSemanticJudgeModelId) ?? null;
  const judgeScoreContext = useMemo(() => ({
    missingEvidence: selectedSemanticJudgeModel
      ? semanticJudgeEvidenceMissing
      : ['judge-model-unavailable'],
    model: selectedSemanticJudgeModel?.displayName ?? null,
    rubricVersion: 'benchmark-semantic-judge/v1',
  }), [selectedSemanticJudgeModel, semanticJudgeEvidenceMissing]);
  const runSemanticJudge = useCallback(async () => {
    if (!benchmarkReport) return;
    if (!selectedSemanticJudgeModel) {
      setSemanticJudgeEvidenceMissing(['judge-model-unavailable']);
      setSemanticJudgeError(null);
      setSemanticJudgeResult(null);
      await persistBenchmarkHistory({
        report: benchmarkReport,
        runStatus: 'completed',
        score: buildBenchmarkScore(benchmarkReport, 'completed', null, 'idle', null, {
          missingEvidence: ['judge-model-unavailable'],
          rubricVersion: 'benchmark-semantic-judge/v1',
        }),
      });
      return;
    }
    const sourceText = resolveBenchmarkSourceText(benchmarkReport.audioFile);
    const referenceTranslation = resolveBenchmarkReferenceTranslation(benchmarkReport.audioFile);
    if (!sourceText || !referenceTranslation) {
      // Missing fixture text is an evidence state, not a failed judge call.
      setSemanticJudgeEvidenceMissing([]);
      setSemanticJudgeError(null);
      setSemanticJudgeResult(null);
      await persistBenchmarkHistory({
        report: benchmarkReport,
        runStatus: 'completed',
        score: buildBenchmarkScore(benchmarkReport, 'completed', null, 'idle', null, {
          model: selectedSemanticJudgeModel.displayName,
          rubricVersion: 'benchmark-semantic-judge/v1',
        }),
      });
      return;
    }
    let credential: string | null = null;
    try {
      credential = (await readProviderSecret(selectedSemanticJudgeModel.authReference)).secret;
    } catch (caught) {
      // The judge endpoint is deliberately not called when credential
      // evidence cannot be read from the configured credential store.
      recordBenchmarkJudgeCredentialFailure(caught);
    }
    if (!credential) {
      const missingEvidence = ['judge-credential-unavailable'];
      setSemanticJudgeEvidenceMissing(missingEvidence);
      setSemanticJudgeError(null);
      setSemanticJudgeResult(null);
      await persistBenchmarkHistory({
        report: benchmarkReport,
        runStatus: 'completed',
        score: buildBenchmarkScore(benchmarkReport, 'completed', null, 'idle', null, {
          missingEvidence,
          model: selectedSemanticJudgeModel.displayName,
          rubricVersion: 'benchmark-semantic-judge/v1',
        }),
      });
      return;
    }
    setSemanticJudgeRunning(true);
    setSemanticJudgeError(null);
    setSemanticJudgeResult(null);
    setSemanticJudgeEvidenceMissing([]);
    await persistBenchmarkHistory({
      report: benchmarkReport,
      runStatus: 'completed',
      score: buildBenchmarkScore(benchmarkReport, 'completed', null, 'running', null, {
        model: selectedSemanticJudgeModel.displayName,
        rubricVersion: 'benchmark-semantic-judge/v1',
      }),
    });
    try {
      const result = await runBenchmarkSemanticJudge(benchmarkReport, selectedSemanticJudgeModel, credential);
      setSemanticJudgeResult(result);
      await persistBenchmarkHistory({
        report: benchmarkReport,
        runStatus: 'completed',
        score: buildBenchmarkScore(benchmarkReport, 'completed', result, 'completed'),
      });
    } catch (caught) {
      const error = formatSemanticJudgeError(caught);
      setSemanticJudgeError(error);
      await persistBenchmarkHistory({
        error,
        report: benchmarkReport,
        runStatus: 'completed',
        score: buildBenchmarkScore(benchmarkReport, 'completed', null, 'failed', error, {
          model: selectedSemanticJudgeModel.displayName,
          rubricVersion: 'benchmark-semantic-judge/v1',
        }),
      });
    } finally {
      setSemanticJudgeRunning(false);
    }
  }, [benchmarkReport, persistBenchmarkHistory, selectedSemanticJudgeModel]);
  const benchmarkState = benchmarkError ? 'failed' : benchmarkRunning ? 'running' : 'completed';
  const benchmarkScore = useMemo(() => benchmarkReport ? buildBenchmarkScore(
    benchmarkReport,
    benchmarkState,
    semanticJudgeResult,
    semanticJudgeRunning ? 'running' : semanticJudgeError ? 'failed' : semanticJudgeResult ? 'completed' : 'idle',
    semanticJudgeError,
    judgeScoreContext,
  ) : null, [benchmarkReport, benchmarkState, judgeScoreContext, semanticJudgeError, semanticJudgeResult, semanticJudgeRunning]);
  const benchmarkJudgeKey = benchmarkReport
    ? `${benchmarkReport.model}|${benchmarkReport.audioFile}|${benchmarkReport.runs.map((run) => `${run.runIndex}:${run.responseDoneMs ?? ''}:${run.translationFinal}`).join('|')}|${effectiveSemanticJudgeModelId || 'judge-model-unavailable'}`
    : null;
  useEffect(() => {
    if (
      !benchmarkJudgeKey
      || !benchmarkReport
      || benchmarkState !== 'completed'
      || semanticJudgeRunning
      || semanticJudgeResult
      || semanticJudgeError
      || automaticJudgeKey.current === benchmarkJudgeKey
    ) return;
    automaticJudgeKey.current = benchmarkJudgeKey;
    void runSemanticJudge().catch((caught) => {
      automaticJudgeKey.current = null;
      setSemanticJudgeRunning(false);
      setSemanticJudgeError(formatSemanticJudgeError(caught));
    });
  }, [benchmarkJudgeKey, benchmarkReport, benchmarkState, runSemanticJudge, semanticJudgeError, semanticJudgeResult, semanticJudgeRunning]);
  const startBenchmark = () => {
    automaticJudgeKey.current = null;
    setSemanticJudgeResult(null);
    setSemanticJudgeError(null);
    setSemanticJudgeEvidenceMissing([]);
    setHistoryMutationError(null);
    void runBenchmarkTest();
  };
  const openBenchmarkHistory = useCallback(async (recordId: string) => {
    try {
      const record = await getStoredBenchmarkHistory(recordId);
      setHistoryDetail(record);
      setHistoryModalOpen(true);
      setHistoryMutationError(null);
    } catch (caught) {
      setHistoryMutationError(describeUnknownError(caught));
    }
  }, [getStoredBenchmarkHistory]);
  const deleteBenchmarkHistory = useCallback(async (recordId: string) => {
    if (!window.confirm(i18n.t('diagnostics.benchmark.deleteHistoryConfirm'))) return;
    try {
      await removeStoredBenchmarkHistory(recordId);
      if (historyRecordId.current === recordId) historyRecordId.current = null;
      if (historyDetail?.recordId === recordId) {
        setHistoryDetail(null);
        setHistoryModalOpen(false);
      }
      setHistoryMutationError(null);
    } catch (caught) {
      setHistoryMutationError(describeUnknownError(caught));
    }
  }, [historyDetail, removeStoredBenchmarkHistory]);
  const clearBenchmarkHistory = useCallback(async () => {
    if (!window.confirm(i18n.t('diagnostics.benchmark.clearHistoryConfirm'))) return;
    try {
      await clearStoredBenchmarkHistory();
      historyRecordId.current = null;
      setHistoryDetail(null);
      setHistoryModalOpen(false);
      setHistoryMutationError(null);
    } catch (caught) {
      setHistoryMutationError(describeUnknownError(caught));
    }
  }, [clearStoredBenchmarkHistory]);
  const handleBenchmarkHistoryActionFailure = useCallback((caught: unknown) => {
    setHistoryMutationError(describeUnknownError(caught));
  }, []);
  const runtimeEnvironmentSummary = useMemo(
    () => getRuntimeEnvironmentSummary(runtimeSnapshot, audioRuntimeSnapshot, configDraft),
    [runtimeSnapshot, audioRuntimeSnapshot, configDraft],
  );
  const effectiveBridgeStatus = resolveRuntimeBridgeStatus(runtimeSnapshot);
  const overviewIssues = useMemo(
    () => buildOverviewIssues(runtimeSnapshot, audioRuntimeSnapshot, runtimeEnvironmentSummary, configDraft),
    [audioRuntimeSnapshot, configDraft, runtimeEnvironmentSummary, runtimeSnapshot],
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
          await desktopApi.configuration.bootstrapRuntime();
          await desktopApi.configuration.bootstrapStorage();
          setRuntimeSnapshot(await desktopApi.configuration.runtimeSnapshot());
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
  }, [desktopApi, overviewIssues, setRuntimeSnapshot]);
  const repairableIssueIds = useMemo(() => new Set(repairOptions.flatMap((option) => option.issueIds)), [repairOptions]);
  const keyIssues = useMemo(() => overviewIssues.filter((issue) => !repairableIssueIds.has(issue.id)), [overviewIssues, repairableIssueIds]);
  const primaryIssue = keyIssues[0] ?? overviewIssues[0] ?? null;
  const runtimeErrorOriginal = useMemo(() => getRuntimeErrorOriginal(runtimeSnapshot), [runtimeSnapshot]);
  const [selectedRepairIds, setSelectedRepairIds] = useState<string[]>([]);
  const [repairSelectionInitialized, setRepairSelectionInitialized] = useState(false);
  const [reportExportFeedback, setReportExportFeedback] = useState<{ tone: 'ready' | 'error'; message: string; outputPath?: string } | null>(null);
  const [exportDirectoryError, setExportDirectoryError] = useState<string | null>(null);
  const [watchReportExport, setWatchReportExport] = useState<{
    sessionId: string;
    receipt: ExportArtifactReceipt;
  } | null>(null);

  const runReportExport = async (filename: string, exporter: () => Promise<{ outputPath: string; fileCount: number }>) => {
    try {
      const artifact = await exporter();
      setReportExportFeedback({ tone: 'ready', message: `${i18n.t('diagnostics.status.completed')}：${artifact.outputPath} · ${artifact.fileCount}`, outputPath: artifact.outputPath });
    } catch (error) {
      setReportExportFeedback({
        tone: 'error',
        message: `${i18n.t('diagnostics.status.failed')}：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  // Shared by the benchmark/live-events modals: timestamped filename plus the
  // export invocation with the error feedback fallback.
  const exportReportWithFeedback = (
    prefix: string,
    format: string,
    exporter: (base: string) => Promise<{ outputPath: string; fileCount: number }>,
  ) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${prefix}-${ts}`;
    const filename = `${base}.${format}`;
    void runReportExport(filename, () => exporter(base)).catch((error) => setReportExportFeedback({ tone: 'error', message: String(error) }));
  };

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
  const {
    actionFeedback,
    busyAction,
    clearActionFeedback,
    clearWatchReport,
    closeWatchReportModal,
    watchReport,
    watchReportError,
    watchReportLoading,
    watchReportModalOpen,
    openWatchReportModal,
    openExportDirectory,
    refreshWatchReport,
    runAutomaticRepair,
    runBridgeRefresh,
    runExportAction,
    runOverlaySelfCheck,
    runSelfCheck,
  } = useDiagnosticsWorkbenchController(repairOptions, selectedRepairIds);

  const openDiagnosticsExportDirectory = async (outputPath: string) => {
    setExportDirectoryError(null);
    try {
      await openExportDirectory(outputPath);
    } catch (error) {
      setExportDirectoryError(describeUnknownError(error));
    }
  };

  const reportExportFeedbackBanner = reportExportFeedback ? (
    <div className={`diagnostics-action-feedback diagnostics-action-feedback-${reportExportFeedback.tone}`} role={reportExportFeedback.tone === 'error' ? 'alert' : 'status'}>
      <span>{reportExportFeedback.message}</span>
      {reportExportFeedback.outputPath ? <button className="text-button" onClick={() => void openExportDirectory(reportExportFeedback.outputPath!).catch((error) => setReportExportFeedback({ tone: 'error', message: String(error) }))} type="button">{i18n.t('diagnostics.actions.openExportDirectory')}</button> : null}
    </div>
  ) : null;

  const allRepairSelected = repairOptions.length > 0 && repairOptions.every((option) => selectedRepairIds.includes(option.id));
  const stableServiceCount = serviceMonitorItems.filter((item) => item.tone !== 'warning').length;
  const healthSummaryLabel = overviewIssues.length === 0 ? i18n.t('diagnostics.health.normal') : i18n.t('diagnostics.health.issueCount', { count: overviewIssues.length });
  const healthSummaryDetail =
    overviewIssues.length === 0
      ? i18n.t('diagnostics.health.stableDetail', { count: stableServiceCount })
      : i18n.t('diagnostics.health.needsInvestigationDetail');

  const envDiagnostic = useMemo(() => {
    // One capability read feeds both legacy display fields; hasInvokeBridge
    // stays a raw probe on purpose — this panel reports the real environment.
    const shell = desktopApi.capabilities.hasNativeShell;
    const bridge = hasInvokeBridge();
    const ipcObject = !!(window as unknown as Record<string, unknown>).ipc;
    const speechEnabled = Boolean(configDraft.speech?.enabled || configDraft.devices?.outputSpeechEnabled);

    return {
      tauriFlag: shell,
      hasBridge: bridge,
      isRuntime: shell,
      hasIpcObject: ipcObject,
      storageStatus: runtimeSnapshot.storage.status,
      bridgeStatus: runtimeSnapshot.bridgeStatus,
      credentialBackend: runtimeSnapshot.storage.credentialBackend,
      schemaVersion: runtimeSnapshot.storage.schemaVersion,
      omniSpeechEnabled: speechEnabled,
      speechLocalPlayback: Boolean(configDraft.speech?.localPlaybackEnabled ?? true),
      speechVirtualMic: Boolean(configDraft.speech?.virtualMicOutputEnabled ?? false),
    };
  }, [desktopApi, runtimeSnapshot, configDraft]);

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
          <button className="icon-button diagnostics-primary-action" disabled={busyAction !== null} onClick={() => void runSelfCheck()} type="button">
              <AppIcon name="search" size={14} />
              {busyAction === 'self-check' ? i18n.t('diagnostics.actions.diagnosing') : i18n.t('diagnostics.actions.rerunDiagnostics')}
            </button>
          <button className="icon-button" disabled={busyAction !== null} onClick={() => void runOverlaySelfCheck()} type="button">
              <AppIcon name="subtitles" size={14} />
              {busyAction === 'overlay-self-check' ? i18n.t('diagnostics.actions.testing') : i18n.t('diagnostics.actions.testOverlay')}
            </button>
          <label className="diagnostics-export-scope">
            <span>{i18n.t('diagnostics.export.title')}</span>
            <select
              aria-label={i18n.t('diagnostics.export.title')}
              disabled={busyAction !== null}
              onChange={(event) => setExportScopeOverride(event.target.value as DiagnosticsExportScope)}
              value={exportScope}
            >
              <option value="summary">SUMMARY</option>
              <option value="quick">QUICK</option>
              <option value="full">FULL</option>
            </select>
          </label>
          <button className="icon-button" disabled={busyAction !== null} onClick={() => {
            setExportDirectoryError(null);
            void runExportAction(exportScope);
          }} type="button">
              <AppIcon name="download" size={14} />
              {busyAction === 'export' ? i18n.t('diagnostics.actions.exporting') : i18n.t('diagnostics.actions.exportBundle')}
            </button>
          <button className="icon-button" disabled={busyAction !== null} onClick={() => void runBridgeRefresh()} type="button">
              <AppIcon name="refresh" size={14} />
              {busyAction === 'bridge-refresh' ? i18n.t('diagnostics.actions.refreshing') : i18n.t('diagnostics.actions.refreshRuntime')}
            </button>
        </div>

        {actionFeedback ? (
          <div className={`diagnostics-action-feedback diagnostics-action-feedback-${actionFeedback.tone}`} role={actionFeedback.tone === 'error' ? 'alert' : 'status'}>
            <div>
              <strong>{actionFeedback.title}</strong>
              {actionFeedback.detail ? <p>{actionFeedback.detail}</p> : null}
              {actionFeedback.outputPath ? <button className="text-button" onClick={() => void openDiagnosticsExportDirectory(actionFeedback.outputPath!).catch(() => undefined)} type="button">{i18n.t('diagnostics.actions.openExportDirectory')}</button> : null}
            </div>
            <button aria-label={i18n.t('common.close')} className="icon-button" onClick={() => {
              clearActionFeedback();
              setExportDirectoryError(null);
            }} type="button">
              <AppIcon name="close" size={14} />
            </button>
          </div>
        ) : null}

        {exportDirectoryError ? (
          <div className="diagnostics-action-feedback diagnostics-action-feedback-error" role="alert">
            <div>
              <strong>{i18n.t('diagnostics.actions.openExportDirectory')} · {i18n.t('diagnostics.status.failed')}</strong>
              <p>{exportDirectoryError}</p>
            </div>
            <button aria-label={i18n.t('common.close')} className="icon-button" onClick={() => setExportDirectoryError(null)} type="button">
              <AppIcon name="close" size={14} />
            </button>
          </div>
        ) : null}

        <div className="diagnostics-live-events-strip">
          <button className="icon-button diagnostics-live-events-button" onClick={() => void openWatchReportModal().catch(() => undefined)} type="button">
            <AppIcon name="activity" size={14} />
            {i18n.t('watchReport.latestTitle')}
          </button>
        </div>

        {primaryIssue ? (
          <div className={`diagnostics-primary-issue diagnostics-primary-issue-${primaryIssue.tone}`}>
            <div>
              <span>{i18n.t('diagnostics.labels.currentIssue')}</span>
              <strong>{primaryIssue.title}</strong>
              <p>{runtimeErrorOriginal ?? primaryIssue.detail}</p>
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
            <label className="diagnostics-benchmark-label">{i18n.t('diagnostics.benchmark.audioSource')}</label>
            <select
              className="diagnostics-benchmark-select"
              disabled={benchmarkRunning}
              onChange={(event) => setBenchmarkAudioSource(event.target.value)}
              value={benchmarkAudioSource}
            >
              <optgroup label={i18n.t('diagnostics.benchmark.presetEnglish')}>
                {benchmarkAudioPresets.filter((p) => p.languageCode === 'en').map((preset) => (
                  <option key={preset.path} value={preset.path}>{preset.label}</option>
                ))}
              </optgroup>
              <optgroup label={i18n.t('diagnostics.benchmark.presetMultilingual')}>
                {benchmarkAudioPresets.filter((p) => p.languageCode !== 'en').map((preset) => (
                  <option key={preset.path} value={preset.path}>
                    {preset.label}{preset.durationSeconds ? ` (~${Math.round(preset.durationSeconds)}s)` : ''}
                  </option>
                ))}
              </optgroup>
              <option value={CUSTOM_AUDIO_VALUE}>{i18n.t('diagnostics.benchmark.customAudio')}</option>
            </select>
          </div>
          {benchmarkAudioSource === CUSTOM_AUDIO_VALUE ? (
            <div className="diagnostics-benchmark-row">
              <label className="diagnostics-benchmark-label">{i18n.t('diagnostics.benchmark.mp3Path')}</label>
              <input
                className="diagnostics-benchmark-input"
                disabled={benchmarkRunning}
                onChange={(event) => setBenchmarkCustomPath(event.target.value)}
                placeholder="E:\\path\\sample.mp3"
                type="text"
                value={benchmarkCustomPath}
              />
            </div>
          ) : null}
          <div className="diagnostics-benchmark-row">
            <button className="icon-button diagnostics-primary-action" disabled={benchmarkRunning || semanticJudgeRunning || voiceModelOptions.length === 0} onClick={startBenchmark} type="button">
              <AppIcon name="activity" size={14} />
              {benchmarkRunning ? i18n.t('diagnostics.actions.testing') : i18n.t('diagnostics.benchmark.start')}
            </button>
            {benchmarkReport ? (
              <button className="icon-button" onClick={() => setBenchmarkModalOpen(true)} type="button">
                <AppIcon name="eye" size={14} />
                {i18n.t('diagnostics.benchmark.viewResults')}
              </button>
            ) : null}
            {hasNativeShell ? (
              <button aria-expanded={historyExpanded} className="icon-button" onClick={() => setHistoryExpanded((expanded) => !expanded)} type="button">
                <AppIcon name="clock" size={14} />
                {i18n.t('diagnostics.benchmark.openHistory')}
              </button>
            ) : null}
          </div>
          {benchmarkError ? <div className="diagnostics-benchmark-error">{benchmarkError}</div> : null}
          {benchmarkRunning ? <div className="diagnostics-benchmark-progress">{i18n.t('diagnostics.benchmark.streamingProgress')}</div> : null}
          <LogLevelControl />
          {hasNativeShell && historyExpanded ? (
            <BenchmarkHistoryPanel
              error={historyMutationError ?? benchmarkHistoryError}
              hasMore={benchmarkHistoryPage.records.length < benchmarkHistoryPage.totalCount}
              loading={benchmarkHistoryLoading || benchmarkRunning || semanticJudgeRunning}
              onClear={() => void clearBenchmarkHistory().catch(handleBenchmarkHistoryActionFailure)}
              onDelete={(recordId) => void deleteBenchmarkHistory(recordId).catch(handleBenchmarkHistoryActionFailure)}
              onLoadMore={() => void loadMoreBenchmarkHistory().catch(handleBenchmarkHistoryActionFailure)}
              onOpen={(recordId) => void openBenchmarkHistory(recordId).catch(handleBenchmarkHistoryActionFailure)}
              onRefresh={() => void refreshBenchmarkHistory().catch(handleBenchmarkHistoryActionFailure)}
              records={benchmarkHistoryPage.records}
              totalCount={benchmarkHistoryPage.totalCount}
            />
          ) : null}
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
                <AppIcon name="wrench" size={14} />
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
                    <button className="icon-button" disabled={busyAction !== null} onClick={() => void runSelfCheck()} type="button">
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
        <ModalDialog aria-label={i18n.t('diagnostics.benchmark.results')} className="benchmark-modal" onClose={() => setBenchmarkModalOpen(false)} variant="benchmark">
            <div className="benchmark-modal-head">
              <div>
                <span className="diagnostics-kicker">{i18n.t('diagnostics.benchmark.results')}</span>
                <h3>{benchmarkReport.model}</h3>
                <p>{i18n.t('diagnostics.benchmark.resultSummary', { duration: (benchmarkReport.audioDurationSecs ?? 0).toFixed(1), count: benchmarkReport.runs[0]?.outputDeltas.filter((delta) => isTextOutputEvent(delta.eventType)).length ?? 0 })}</p>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <ExportButton onExport={(format) => {
                  exportReportWithFeedback(`benchmark-${benchmarkReport.model}`, format, (base) => DiagnosticsReportExporter.exportBenchmark(benchmarkReport, base, format, benchmarkScore ?? undefined));
                }} />
                <button className="icon-button" onClick={() => setBenchmarkModalOpen(false)} type="button">
                  <AppIcon name="close" size={16} />
                </button>
              </div>
            </div>
            {reportExportFeedbackBanner}
            <BenchmarkProgressBanner error={benchmarkError} progress={benchmarkProgress} />
            <BenchmarkReportDetail
              benchmarkState={benchmarkState}
              onRunSemanticJudge={() => void runSemanticJudge().catch(() => undefined)}
              onSemanticJudgeModelChange={(modelId) => {
                setSemanticJudgeModelId(modelId);
                setSemanticJudgeResult(null);
                setSemanticJudgeError(null);
                setSemanticJudgeEvidenceMissing([]);
              }}
              report={benchmarkReport}
              semanticJudgeError={semanticJudgeError}
              semanticJudgeModelId={effectiveSemanticJudgeModelId}
              semanticJudgeModels={semanticJudgeModels}
              semanticJudgeResult={semanticJudgeResult}
              semanticJudgeRunning={semanticJudgeRunning}
              score={benchmarkScore ?? undefined}
            />
        </ModalDialog>
      ) : null}

      {historyModalOpen && historyDetail ? (
        <ModalDialog aria-label={i18n.t('diagnostics.benchmark.historyDetail')} className="benchmark-modal" onClose={() => setHistoryModalOpen(false)} variant="benchmark">
          <div className="benchmark-modal-head">
            <div>
              <span className="diagnostics-kicker">{i18n.t('diagnostics.benchmark.historyTitle')}</span>
              <h3>{historyDetail.model}</h3>
              <p>{formatHistoryTime(historyDetail.createdAt)}</p>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {historyDetail.report ? (
                <ExportButton onExport={(format) => {
                  exportReportWithFeedback(`benchmark-history-${historyDetail.model}`, format, (base) => DiagnosticsReportExporter.exportBenchmark(
                    historyDetail.report!,
                    base,
                    format,
                    benchmarkScoreFromHistory(historyDetail.score) ?? undefined,
                  ));
                }} />
              ) : null}
              <button className="icon-button" onClick={() => setHistoryModalOpen(false)} type="button">
                <AppIcon name="close" size={16} />
              </button>
            </div>
          </div>
          {reportExportFeedbackBanner}
          {historyDetail.report ? (
            <BenchmarkReportDetail
              benchmarkState={historyDetail.runStatus === 'completed' ? 'completed' : 'failed'}
              report={historyDetail.report}
              score={benchmarkScoreFromHistory(historyDetail.score) ?? undefined}
            />
          ) : <p className="benchmark-empty">{i18n.t('diagnostics.benchmark.historyReportUnavailable')}</p>}
        </ModalDialog>
      ) : null}

      {watchReportModalOpen ? (
        <ModalDialog aria-label={i18n.t('watchReport.latestTitle')} className="benchmark-modal watch-report-modal" closeOnEscape onClose={closeWatchReportModal} variant="benchmark">
            <div className="benchmark-modal-head watch-report-modal-head">
              <div>
                <span className="diagnostics-kicker">Watch Mode</span>
                <h3>{i18n.t('watchReport.latestTitle')}</h3>
                <p>{i18n.t('watchReport.description')}</p>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button className="icon-button" onClick={() => void refreshWatchReport().catch(() => undefined)} disabled={watchReportLoading} type="button" title={i18n.t('watchReport.refresh')}>
                  <AppIcon name="refresh" size={14} />
                </button>
                <button className="icon-button" onClick={closeWatchReportModal} type="button">
                  <AppIcon name="close" size={16} />
                </button>
              </div>
            </div>
            {reportExportFeedbackBanner}
            <WatchSessionReportPanel
              error={watchReportError}
              lastExportReceipt={watchReportExport && watchReport && watchReportExport.sessionId === watchReport.sessionId
                ? watchReportExport.receipt
                : null}
              loading={watchReportLoading}
              onClear={async () => {
                await clearWatchReport();
                setWatchReportExport(null);
              }}
              onExported={(artifact) => {
                if (watchReport) {
                  setWatchReportExport({ sessionId: watchReport.sessionId, receipt: artifact });
                }
                setReportExportFeedback({
                  tone: 'ready',
                  message: `${i18n.t('diagnostics.status.completed')}：${artifact.outputPath}`,
                  outputPath: artifact.outputPath,
                });
              }}
              onRefresh={refreshWatchReport}
              report={watchReport}
            />
        </ModalDialog>
      ) : null}
    </div>
  );
}

export default DiagnosticsPage;
