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

const STAGE_LABELS: Record<SceneLaunchStage, string> = {
  'bridge-ready': 'Bridge/驱动准备',
  'omni-preconnect': 'Omni 预连接',
  'inbound-route': '系统音频采集',
  'outbound-route': '麦克风采集',
  'translate-worker': '翻译引擎',
  'speech-dispatch': '语音播报',
  'subtitle-overlay': '字幕浮窗',
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
    const summary = recentLogs[index]?.summary ?? '';
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
  if (!snapshot) return '采集状态未知';
  const { captureState, preBufferState, streamBound } = snapshot.inbound;
  return `采集状态 ${captureState}/${preBufferState}，已绑定 ${streamBound ? '是' : '否'}`;
}

function nativeMarkerFragment(recentLogs: DiagnosticLogEntryRuntime[]): string {
  const marker = latestRouteMarker(recentLogs);
  return `原生诊断 ${marker ?? '无相关记录'}`;
}

/**
 * Builds an attributable failure message for a watch launch. The three outcomes
 * each produce a distinct reason plus an actionable hint, so the user learns
 * why capture failed rather than only that it was slow.
 */
export function describeSceneLaunchAttribution(input: SceneLaunchAttributionInput): SceneLaunchAttribution {
  const outcome = classify(input);
  const stageLabel = input.stage ? STAGE_LABELS[input.stage] : '启动';
  const context = `${captureStateFragment(input.snapshot)}；${nativeMarkerFragment(input.recentLogs)}`;
  const detail = errorText(input.error);

  if (outcome === 'command-rejected') {
    const reason = `${stageLabel}命令未被接受（${context}${detail ? `；${detail}` : ''}）`;
    const hint = '请确认桌面壳与音频服务正在运行，稍后重试；若反复出现，请重启应用后再启动看片。';
    return { outcome, message: `${reason}。${hint}` };
  }

  if (outcome === 'capture-error') {
    const nativeError = input.snapshot?.inbound.lastError?.trim() || detail;
    const reason = `${stageLabel}报错：${nativeError || '原生采集返回错误'}（${context}）`;
    const hint = '请在“音频路由”中重新选择系统播放设备，或确认该设备未被其他程序独占后重试。';
    return { outcome, message: `${reason}。${hint}` };
  }

  const reason = `${stageLabel}已接受命令但未在期限内就绪（${context}）`;
  const hint = '通常是采集设备启动较慢或当前无音频输出，请确认正在播放声音后重试；若持续未就绪，请在“诊断”页查看采集日志。';
  return { outcome, message: `${reason}。${hint}` };
}
