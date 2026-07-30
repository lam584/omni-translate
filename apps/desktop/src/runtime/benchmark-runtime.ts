// Event subscription stays on the direct Tauri channel: the desktopApiV2
// capability surface covers native commands only, not event listeners.
import { listen } from '@tauri-apps/api/event';
import i18n from '../i18n/config';
import type { ProviderDraft, RealtimeAudioMode } from '../schema/config';
import type { ProviderInteractionCapability } from '../schema/provider-contract';
import { activeDesktopApi } from './desktop-api';
import { invokeWithTimeoutCore } from './invoke-with-timeout';

export type BenchmarkOutputDelta = {
  elapsedMs: number;
  eventType: string;
  stash: string;
  committedText: string;
  rawText: string;
};

export type BenchmarkAsrDelta = {
  elapsedMs: number;
  stash: string;
  text: string;
};

export type BenchmarkRunResult = {
  runIndex: number;
  model: string;
  connectMs: number;
  sessionReadyMs: number;
  audioSendMs: number;
  audioChunksSent: number;
  audioDurationSecs: number;
  firstAsrMs: number | null;
  asrDeltas: BenchmarkAsrDelta[];
  asrFinal: string;
  firstOutputMs: number | null;
  firstCommittedMs: number | null;
  outputDeltas: BenchmarkOutputDelta[];
  translationFinal: string;
  responseCreatedMs: number | null;
  responseDoneMs: number | null;
  responseDoneAudioChunksSent: number | null;
  responseDoneAudioSentSecs: number | null;
  responseCount: number;
  speechStartedMs: number | null;
  speechStoppedMs: number | null;
  timeToFirstTokenMs: number | null;
  timeToFirstCommittedMs: number | null;
  totalOutputDurationMs: number | null;
  outputDeltaCount: number;
};

export type BenchmarkSummary = {
  runCount: number;
  successfulRuns: number;
  avgConnectMs: number;
  avgSessionReadyMs: number;
  avgTimeToFirstTokenMs: number | null;
  avgTimeToFirstCommittedMs: number | null;
  avgOutputDeltaIntervalMs: number | null;
  avgOutputDeltasPerRun: number;
  avgTotalOutputDurationMs: number | null;
  p50DeltaIntervalMs: number | null;
  p90DeltaIntervalMs: number | null;
  p99DeltaIntervalMs: number | null;
  minDeltaIntervalMs: number | null;
  maxDeltaIntervalMs: number | null;
};

export type BenchmarkReport = {
  model: string;
  realtimeAudioMode?: RealtimeAudioMode;
  interactionCapabilities?: ProviderInteractionCapability[];
  audioFile: string;
  audioDurationSecs: number;
  runs: BenchmarkRunResult[];
  summary: BenchmarkSummary;
};

export type BenchmarkProgressEvent = {
  runId: string;
  status: 'running' | 'completed' | 'error';
  phase: string;
  message: string;
  report: BenchmarkReport;
  error?: string | null;
  audioChunksSent: number;
  totalAudioChunks: number;
};

export type BenchmarkRunOptions = {
  runId?: string;
  realtimeAudioMode?: RealtimeAudioMode;
  interactionCapabilities?: ProviderInteractionCapability[];
  providerKind?: string;
  baseUrl?: string;
  authHeaderName?: string;
  authScheme?: string;
  provider?: ProviderDraft;
  onProgress?: (event: BenchmarkProgressEvent) => void;
};

export const BENCHMARK_PROGRESS_EVENT = 'benchmark://progress';

const BENCHMARK_INVOKE_TIMEOUT_MS = 180_000;

export async function runModelBenchmark(
  model: string,
  apiKey: string,
  mp3Path: string,
  options: BenchmarkRunOptions = {},
): Promise<BenchmarkReport> {
  // Capability gate (not an environment probe): the progress-event listener
  // below must not be registered when no native shell can emit the events.
  if (!activeDesktopApi().capabilities.hasNativeShell) {
    throw new Error(i18n.t('runtime.benchmark.desktopOnly'));
  }

  const runId = options.runId ?? `benchmark-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const unlisten = await listen<BenchmarkProgressEvent>(BENCHMARK_PROGRESS_EVENT, (event) => {
    if (event.payload.runId === runId) {
      options.onProgress?.(event.payload);
    }
  });

  return invokeWithTimeoutCore(
    async () => {
      const jsonString = await activeDesktopApi().benchmark.runModelBenchmark({
        model,
        apiKey,
        mp3Path,
        runId,
        realtimeAudioMode: options.realtimeAudioMode,
        interactionCapabilities: options.interactionCapabilities,
        providerKind: options.providerKind,
        baseUrl: options.baseUrl,
        authHeaderName: options.authHeaderName,
        authScheme: options.authScheme,
        provider: options.provider,
      });
      try {
        return JSON.parse(jsonString) as BenchmarkReport;
      } catch (parseError) {
        throw new Error(
          i18n.t('runtime.benchmark.parseFailed', { error: parseError instanceof Error ? parseError.message : String(parseError) }),
          { cause: parseError },
        );
      }
    },
    BENCHMARK_INVOKE_TIMEOUT_MS,
    () => new Error(i18n.t('runtime.benchmark.timeout', { seconds: BENCHMARK_INVOKE_TIMEOUT_MS / 1000 })),
    // Same lifetime as the former `.finally(() => unlisten())`: the progress
    // listener is released when the native command settles (either outcome),
    // even if the caller already saw the timeout rejection.
    { onSettle: () => unlisten() },
  );
}
