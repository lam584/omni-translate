import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { isTauri } from '@tauri-apps/api/core';
import AppIcon from '../components/icons/AppIcon';
import StatusBadge from '../components/page/StatusBadge';
import type { StatusTone } from '../components/page/StatusBadge';
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
import { resolveRuntimeBridgeStatus } from '../runtime/runtime-status';
import { isTauriRuntime, hasInvokeBridge } from '../runtime/tauri-runtime';
import type { AppConfigDraft, DiagnosticsExportScope } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import { useAppStore } from '../stores/app-store';
import { resolveRecommendedDriverAction } from '../utils/driver-management';

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
    return '已就绪';
  }

  if (status === 'warning') {
    return '需关注';
  }

  if (status === 'stable') {
    return '稳定';
  }

  if (status === 'experimental') {
    return '实验性';
  }

  if (status === 'unsupported') {
    return '不支持';
  }

  if (status === 'draft' || status === 'preview') {
    return '未完成';
  }

  return '未知';
}

function formatBridgeStateLabel(state: string) {
  if (state === 'running') {
    return '运行中';
  }

  if (state === 'starting') {
    return '启动中';
  }

  if (state === 'degraded') {
    return '降级';
  }

  return '已停止';
}

function formatCaptureStateLabel(state: string) {
  if (state === 'capturing') {
    return '采集中';
  }

  if (state === 'buffering') {
    return '缓冲中';
  }

  if (state === 'armed') {
    return '待命';
  }

  if (state === 'muted') {
    return '静音';
  }

  return '空闲';
}

function formatDriverHealthLabel(health: string) {
  if (health === 'running') {
    return '运行正常';
  }

  if (health === 'version-mismatch') {
    return '版本不匹配';
  }

  if (health === 'damaged') {
    return '已损坏';
  }

  return '未安装';
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
      label: '浏览器预览态',
      summary: '当前页面仍在浏览器预览模式，桥接、采集和字幕浮窗状态都不能当成真实桌面运行结果。',
      details: [
        '请改用桌面壳启动命令进入真实运行态。',
        '在这个模式下看到的桥接和采集 blocker 只可作为占位提示，不能直接判定故障。',
      ],
    };
  }

  if (runtimeStatus === 'runtime-error') {
    return {
      mode: 'runtime-error',
      tone: 'warning',
      label: '桌面运行时未接通',
      summary: '前端已经进入桌面壳，但 invoke 或 event 通道没有稳定接通，当前不能确认桥接、采集和字幕浮窗的真实状态。',
      details: [
        '优先查看 runtime 日志和一键诊断结果，确认 IPC 是否超时或 Rust Core 是否启动异常。',
        '在修复 runtime 之前，具体 blocker 可能混入 fallback 快照。',
      ],
    };
  }

  const actualIssues: string[] = [];

  if (runtimeSnapshot.bridge.driverHealth === 'damaged') {
    actualIssues.push('虚拟麦驱动状态损坏，需要重新安装。');
  }

  if (runtimeSnapshot.bridge.driverHealth === 'version-mismatch') {
    actualIssues.push('桥接驱动版本不匹配，需要按推荐动作修复。');
  }

  if (runtimeSnapshot.bridge.lifecycleState === 'error' && runtimeSnapshot.bridge.lastErrorCode) {
    actualIssues.push(`Bridge Service 返回错误：${runtimeSnapshot.bridge.lastErrorCode}`);
  }

  if (audioRuntimeSnapshot.inbound.lastError) {
    actualIssues.push(`系统音频采集异常：${audioRuntimeSnapshot.inbound.lastError}`);
  }

  if (audioRuntimeSnapshot.outbound.lastError) {
    actualIssues.push(`麦克风采集异常：${audioRuntimeSnapshot.outbound.lastError}`);
  }

  if (audioRuntimeSnapshot.speech.lastError) {
    actualIssues.push(`语音播报异常：${audioRuntimeSnapshot.speech.lastError}`);
  }

  if (actualIssues.length === 0) {
    return {
      mode: 'live-ready',
      tone: 'ready',
      label: '桌面运行态已接通',
      summary: '',
      details: [
        '会话页负责按需启动场景，诊断页只关注底层服务是否异常。',
      ],
    };
  }

  return {
    mode: 'live-action-needed',
    tone: 'warning',
    label: '桌面底层链路存在异常',
    summary: '当前已进入真实桌面壳，但底层桥接或采集链路返回了真实异常，需要处理。',
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
      title: '桥接链路异常',
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
        ? `${audioRuntimeSnapshot.inbound.lastError}${audioRuntimeSnapshot.inbound.recommendedAction ? ` [建议: ${audioRuntimeSnapshot.inbound.recommendedAction}]` : ''}`
        : null,
      audioRuntimeSnapshot.outbound.lastError
        ? `${audioRuntimeSnapshot.outbound.lastError}${audioRuntimeSnapshot.outbound.recommendedAction ? ` [建议: ${audioRuntimeSnapshot.outbound.recommendedAction}]` : ''}`
        : null,
      audioRuntimeSnapshot.speech.lastError,
    ].filter((item): item is string => Boolean(item));

    addIssue({
      id: 'audio-runtime',
      title: '音频链路异常',
      detail: audioDetails.join(' · '),
      tone: 'warning',
      route: '/diagnostics',
    });
  }

  for (const entry of recentErrors) {
    addIssue({
      id: entry.id,
      title: entry.summary,
      detail: entry.detail ? `错误详情：${entry.detail}` : `错误分类：${entry.category}`,
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
      label: '运行环境',
      value: runtimeEnvironmentSummary.label,
      meta: effectiveBridgeStatus,
      tone: runtimeEnvironmentSummary.tone,
    },
    {
      label: '桥接',
      value: formatBridgeStateLabel(runtimeSnapshot.bridge.bridgeState),
      meta: formatDriverHealthLabel(runtimeSnapshot.bridge.driverHealth),
      tone: runtimeSnapshot.bridge.bridgeState === 'running' ? 'ready' : 'warning',
    },
    {
      label: '采集',
      value: `${formatCaptureStateLabel(audioRuntimeSnapshot.inbound.captureState)} / ${formatCaptureStateLabel(audioRuntimeSnapshot.outbound.captureState)}`,
      meta: formatStatusLabel(runtimeSnapshot.diagnostics.deviceStatus),
      tone: resolveStatusTone(runtimeSnapshot.diagnostics.deviceStatus),
    },
    {
      label: '错误摘要',
      value: recentErrorCount > 0 ? `${Math.min(recentErrorCount, 3)} 条需关注` : '最近无新错误',
      meta: recentErrorCount > 0 ? '需排查' : '状态平稳',
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
      label: '桌面运行时',
      summary: runtimeEnvironmentSummary.summary,
      badge: runtimeEnvironmentSummary.label,
      tone: runtimeEnvironmentSummary.tone,
    },
    {
      label: '桥接服务',
      summary: formatDriverHealthLabel(runtimeSnapshot.bridge.driverHealth),
      badge: formatBridgeStateLabel(runtimeSnapshot.bridge.bridgeState),
      tone: hasBridgeRuntimeIssue ? 'warning' : runtimeSnapshot.bridge.bridgeState === 'running' ? 'ready' : 'pending',
    },
    {
      label: '系统音频采集',
      summary: formatCaptureStateLabel(audioRuntimeSnapshot.inbound.captureState),
      badge: audioRuntimeSnapshot.inbound.streamBound ? '运行中' : '未启动',
      tone: audioRuntimeSnapshot.inbound.lastError ? 'warning' : audioRuntimeSnapshot.inbound.streamBound ? 'ready' : 'pending',
    },
    {
      label: '麦克风采集',
      summary: formatCaptureStateLabel(audioRuntimeSnapshot.outbound.captureState),
      badge: audioRuntimeSnapshot.outbound.streamBound ? '运行中' : '未启动',
      tone: audioRuntimeSnapshot.outbound.lastError ? 'warning' : audioRuntimeSnapshot.outbound.streamBound ? 'ready' : 'pending',
    },
    {
      label: '播报与浮窗',
      summary: `${audioRuntimeSnapshot.speech.dispatchState}${overlayVisible ? ' · 浮窗显示中' : ' · 浮窗未显示'}`,
      badge: audioRuntimeSnapshot.speech.lastError ? '异常' : configDraft.speech.enabled ? '已启用' : '空闲',
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
  const recentErrors = diagnostics.recentErrors.slice(0, 6);
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
  const overviewLabel = overviewIssues.length === 0 ? '当前无关键阻塞' : `${overviewIssues.length} 个关键问题`;
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
        label: '重试运行时连接',
        summary: '重新刷新 Rust runtime 快照，优先恢复 invoke 和 event 通道。',
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
        label: '执行桥接推荐修复',
        summary: '按当前桥接状态执行推荐的驱动或 Bridge Service 修复动作。',
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
  const healthSummaryLabel = overviewIssues.length === 0 ? '运行状态正常' : `发现 ${overviewIssues.length} 个运行问题`;
  const healthSummaryDetail =
    overviewIssues.length === 0
      ? `${stableServiceCount} 项运行检查平稳，最近错误摘要未发现阻塞。`
      : primaryIssue
        ? `${primaryIssue.title}。${primaryIssue.detail}`
        : '存在需要排查的运行问题，建议重新诊断或导出诊断包。';

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
            message: `自动修复失败：${option.label}${error instanceof Error ? ` - ${error.message}` : ` - ${String(error)}`}`,
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
          message: `已执行 ${selectedOptions.length} 项自动修复。`,
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

  return (
    <div className="control-dashboard diagnostics-dashboard">
      <section className="diagnostics-command-panel">
        <div className="diagnostics-health-summary">
          <div>
            <span className="diagnostics-kicker">诊断结论</span>
            <h2>{healthSummaryLabel}</h2>
            <p>{healthSummaryDetail}</p>
          </div>
          <StatusBadge label={overviewLabel} tone={overviewTone} />
        </div>

        <div className="diagnostics-action-strip" aria-label="诊断与导出操作">
          <button className="icon-button diagnostics-primary-action" disabled={busyAction !== null} onClick={() => void runBusyAction('self-check', runDiagnosticsSelfCheckRuntime)} type="button">
              <AppIcon name="search" size={14} />
              {busyAction === 'self-check' ? '诊断中...' : '重新诊断'}
            </button>
          <button className="icon-button" disabled={busyAction !== null} onClick={() => void runBusyAction('overlay-self-check', runSubtitleOverlaySelfCheckRuntime)} type="button">
              <AppIcon name="subtitles" size={14} />
              {busyAction === 'overlay-self-check' ? '测试中...' : '测试字幕浮窗'}
            </button>
          <button className="icon-button" disabled={busyAction !== null} onClick={() => void runExportAction(exportScope)} type="button">
              <AppIcon name="layers" size={14} />
              {busyAction === 'export' ? '导出中...' : '导出诊断包'}
            </button>
          <button className="icon-button" disabled={busyAction !== null} onClick={() => void runBusyAction('bridge-refresh', refreshBridgeRuntime)} type="button">
              <AppIcon name="refresh" size={14} />
              {busyAction === 'bridge-refresh' ? '刷新中...' : '刷新运行态'}
            </button>
        </div>

        {primaryIssue ? (
          <div className={`diagnostics-primary-issue diagnostics-primary-issue-${primaryIssue.tone}`}>
            <div>
              <span>当前问题</span>
              <strong>{primaryIssue.title}</strong>
              <p>{primaryIssue.detail}</p>
            </div>
            <StatusBadge label={primaryIssue.route ? '需处理' : '关注'} tone={primaryIssue.tone} />
          </div>
        ) : (
          <div className="diagnostics-primary-issue diagnostics-primary-issue-ready">
            <div>
              <span>当前问题</span>
              <strong>未发现关键阻塞</strong>
              <p>{runtimeEnvironmentSummary.summary}</p>
            </div>
            <StatusBadge label="平稳" tone="ready" />
          </div>
        )}

        <details className="diagnostics-raw-signals">
          <summary>详细环境信号</summary>
          <ul>
              <li>isTauri: {String(envDiagnostic.tauriFlag)}</li>
              <li>IPC Bridge: {String(envDiagnostic.hasBridge)}</li>
              <li>window.ipc: {String(envDiagnostic.hasIpcObject)}</li>
              <li>isTauriRuntime: {String(envDiagnostic.isRuntime)}</li>
              <li>运行环境: {envDiagnostic.isRuntime ? 'Tauri WebView' : '浏览器 (Node.js / Vite)'}</li>
              <li>存储状态: {envDiagnostic.storageStatus}</li>
              <li>凭证后端: {envDiagnostic.credentialBackend}</li>
              <li>Schema 版本: {envDiagnostic.schemaVersion}</li>
              <li>桥接状态: {envDiagnostic.bridgeStatus}</li>
              <li>归一化环境态: {effectiveBridgeStatus}</li>
              <li>Omni 语音输出开关: {String(envDiagnostic.omniSpeechEnabled)}</li>
              <li>扬声器播放: {String(envDiagnostic.speechLocalPlayback)}</li>
              <li>虚拟麦克风: {String(envDiagnostic.speechVirtualMic)}</li>
              <li>扬声器已写帧: {audioRuntimeSnapshot.speech.speakerFramesWritten.toLocaleString()}</li>
            </ul>
          </details>
      </section>

      <section className="content-card page-card compact-card diagnostics-main-panel">
        <article className="diagnostics-overview-panel">
          <div className="diagnostics-section-title">
            <div>
              <span className="diagnostics-kicker">状态证据</span>
              <h3>运行状态</h3>
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
                {busyAction === 'auto-repair' ? '自动修复中...' : '自动修复已选项'}
              </button>
            ) : null}
          </div>
        </article>

        <div className="diagnostics-detail-grid">
            <div className="diagnostics-detail-panel scene-readiness-panel">
              <div className="diagnostics-section-title diagnostics-section-title-compact">
                <h3>底层运行态监控</h3>
                <StatusBadge
                  label={`${stableServiceCount}/${serviceMonitorItems.length} 平稳`}
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
                <h3>自动修复任务</h3>
                <StatusBadge label={repairOptions.length > 0 ? `${repairOptions.length} 项` : '无需修复'} tone={repairOptions.length > 0 ? overviewTone : 'ready'} />
              </div>
              {repairOptions.length > 0 ? (
                <div className="repair-task-list">
                  <div className="compact-info-head">
                    <strong>自动修复清单</strong>
                    <label className="repair-task-toggle">
                      <input
                        checked={allRepairSelected}
                        onChange={() => setSelectedRepairIds(allRepairSelected ? [] : repairOptions.map((option) => option.id))}
                        type="checkbox"
                      />
                      全选
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
                      <StatusBadge label="自动修复" tone={option.tone} />
                    </label>
                  ))}
                </div>
              ) : (
                <div className="compact-alert-item compact-alert-item-ready">
                  <div className="compact-info-head">
                    <strong>当前没有可执行的自动修复项</strong>
                    <StatusBadge label="可继续" tone="ready" />
                  </div>
                  <p>{keyIssues.length > 0 ? '剩余问题需要按下方关键事件继续排查。' : '当前没有真实底层异常，后续只需继续观察运行态。'}</p>
                  <div className="diagnostics-empty-actions">
                    <button className="icon-button" disabled={busyAction !== null} onClick={() => void runBusyAction('self-check', runDiagnosticsSelfCheckRuntime)} type="button">
                      <AppIcon name="search" size={14} />
                      重新诊断
                    </button>
                  </div>
                </div>
              )}

              {keyIssues.length > 0 ? (
                <div className="scene-manual-issues" style={{ marginTop: 12 }}>
                  <div className="compact-info-head scene-manual-issues-head">
                    <strong>关键事件</strong>
                    <StatusBadge label={`${keyIssues.length} 项`} tone={overviewTone} />
                  </div>
                  <div className="compact-alert-list">
                    {keyIssues.map((issue) => {
                      const content = (
                        <>
                          <div className="compact-info-head">
                            <strong>{issue.title}</strong>
                            <StatusBadge label={issue.route ? '需处理' : '关注'} tone={issue.tone} />
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
    </div>
  );
}

export default DiagnosticsPage;
