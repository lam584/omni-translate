import { useEffect, useMemo, useState } from 'react';
import i18n from '../../i18n/config';
import { runModelBenchmark, type BenchmarkProgressEvent, type BenchmarkReport } from '../../runtime/benchmark-runtime';
import { readProviderSecret } from '../../runtime/provider-runtime';
import { createLogger } from '../../runtime/logger';
import type { ProviderDraft, RealtimeAudioMode } from '../../schema/config';
import type { ProviderInteractionCapability } from '../../schema/provider-contract';
import { describeUnknownError } from '../../utils/describe-unknown-error';
import { ALL_BENCHMARK_AUDIO_PRESETS, CUSTOM_AUDIO_VALUE, DEFAULT_BENCHMARK_AUDIO_PATH } from './benchmark-audio-fixtures';
import { createEmptyBenchmarkReport } from './diagnosticsOverview';

const benchmarkLogger = createLogger('runtime');

function recordLifecyclePersistenceFailure(stage: string, error: unknown): void {
  benchmarkLogger.warn(
    'benchmark history lifecycle persistence failed',
    `stage=${stage} error=${describeUnknownError(error)}`,
  );
}

export type BenchmarkVoiceModel = {
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
  provider?: ProviderDraft;
};

type BenchmarkProgressView = Pick<BenchmarkProgressEvent, 'status' | 'phase' | 'message' | 'audioChunksSent' | 'totalAudioChunks' | 'error'>;

export type BenchmarkRunLifecycleEvent = {
  runId: string;
  report: BenchmarkReport;
  error?: string | null;
};

export type BenchmarkRunLifecycle = {
  onStarted?: (event: BenchmarkRunLifecycleEvent) => Promise<void> | void;
  onCompleted?: (event: BenchmarkRunLifecycleEvent) => Promise<void> | void;
  onFailed?: (event: BenchmarkRunLifecycleEvent) => Promise<void> | void;
};

export function classifyBenchmarkError(error: unknown) {
  const detail = describeUnknownError(error);
  const normalized = detail.toLowerCase();
  const chinese = i18n.language.toLowerCase().startsWith('zh');
  let guidance: string;
  if (/401|403|unauthori[sz]ed|invalid.*key|credential|鉴权|密钥/.test(normalized)) {
    guidance = chinese ? '模型鉴权失败，请检查该提供商的 API Key 后重试。' : 'Model authentication failed. Check the provider API key and retry.';
  } else if (/no such file|not found|enoent|找不到.*文件|文件.*不存在/.test(normalized)) {
    guidance = chinese ? '音频文件不存在，请填写可访问的绝对路径后重试。' : 'The audio file does not exist. Enter an accessible absolute path and retry.';
  } else if (/timeout|timed out|websocket|network|connect|超时|网络|连接/.test(normalized)) {
    guidance = chinese ? '模型连接失败或超时，请检查网络、接口地址和服务状态后重试。' : 'The model connection failed or timed out. Check the network, endpoint, and service status, then retry.';
  } else if (/unsupported|not support|不支持/.test(normalized)) {
    guidance = chinese ? '当前模型不支持该实时音频测试，请选择具备实时语音能力的模型。' : 'This model does not support the realtime audio benchmark. Choose a realtime-capable voice model.';
  } else {
    guidance = chinese ? '模型基准测试失败，请检查配置后重试。' : 'The model benchmark failed. Check the configuration and retry.';
  }
  return `${guidance}\n${chinese ? '技术详情' : 'Technical details'}：${detail}`;
}

export function useBenchmarkController(
  voiceModelOptions: BenchmarkVoiceModel[],
  lifecycle: BenchmarkRunLifecycle = {},
) {
  const [modelId, setModelId] = useState('');
  const [audioSource, setAudioSource] = useState<string>(DEFAULT_BENCHMARK_AUDIO_PATH);
  const [customPath, setCustomPath] = useState('');
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [progress, setProgress] = useState<BenchmarkProgressView | null>(null);

  const audioPresets = useMemo(() => ALL_BENCHMARK_AUDIO_PRESETS, []);

  /** Resolved audio path: preset path or custom input depending on selection. */
  const mp3Path = audioSource === CUSTOM_AUDIO_VALUE ? customPath : audioSource;
  const setMp3Path = (value: string) => {
    const preset = audioPresets.find((p) => p.path === value);
    if (preset) {
      setAudioSource(preset.path);
    } else {
      setAudioSource(CUSTOM_AUDIO_VALUE);
      setCustomPath(value);
    }
  };

  useEffect(() => {
    if (!modelId && voiceModelOptions.length) queueMicrotask(() => setModelId(voiceModelOptions[0]!.modelId));
  }, [modelId, voiceModelOptions]);

  const run = async () => {
    const selected = voiceModelOptions.find((item) => item.modelId === modelId);
    if (!selected) return setError(i18n.t('diagnostics.benchmark.selectVoiceModelFirst'));
    if (!mp3Path.trim()) return setError(i18n.t('diagnostics.benchmark.enterMp3Path'));
    setRunning(true);
    setError(null);
    setProgress({ status: 'running', phase: 'starting', message: i18n.t('diagnostics.benchmark.preparing'), audioChunksSent: 0, totalAudioChunks: 0, error: null });
    const runId = `benchmark-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Establish the durable run identity before reading credentials or opening
    // a provider connection. A missing key or another preflight failure is a
    // real benchmark attempt and must remain visible in history.
    const initialReport = createEmptyBenchmarkReport(
      selected.apiModelId,
      mp3Path,
      selected.interactionCapabilities,
      selected.realtimeAudioMode,
    );
    let latestReport: BenchmarkReport | null = initialReport;
    setReport(initialReport);
    setModalOpen(true);
    try {
      // History persistence must never prevent a live benchmark from running.
      // Await the initial write so terminal updates can target the same record.
      try {
        await lifecycle.onStarted?.({ runId, report: initialReport });
      } catch (persistenceError) {
        // The result still remains exportable from the in-memory modal.
        recordLifecyclePersistenceFailure('started', persistenceError);
      }
      const secretPayload = await readProviderSecret(selected.authReference);
      if (!secretPayload.secret) throw new Error(i18n.t('diagnostics.benchmark.missingApiKey', { model: selected.displayName }));
      const nextReport = await runModelBenchmark(selected.apiModelId, secretPayload.secret, mp3Path, {
        runId,
        realtimeAudioMode: selected.realtimeAudioMode,
        interactionCapabilities: selected.interactionCapabilities,
        providerKind: selected.providerKind,
        baseUrl: selected.baseUrl,
        authHeaderName: selected.authHeaderName,
        authScheme: selected.authScheme,
        provider: selected.provider,
        onProgress: (event) => {
          latestReport = event.report;
          setReport(event.report);
          setProgress({ status: event.status, phase: event.phase, message: event.message, audioChunksSent: event.audioChunksSent, totalAudioChunks: event.totalAudioChunks, error: event.error });
        },
      });
      latestReport = nextReport;
      setReport(nextReport);
      setProgress((current) => ({ status: 'completed', phase: 'completed', message: current!.message || i18n.t('diagnostics.benchmark.completed'), audioChunksSent: current!.audioChunksSent, totalAudioChunks: current!.totalAudioChunks, error: null }));
      try {
        await lifecycle.onCompleted?.({ runId, report: nextReport });
      } catch (persistenceError) {
        // A persistence failure is not a benchmark failure.
        recordLifecyclePersistenceFailure('completed', persistenceError);
      }
    } catch (caught) {
      const message = classifyBenchmarkError(caught);
      setError(message);
      setProgress((current) => ({ status: 'error', phase: current!.phase, message, audioChunksSent: current!.audioChunksSent, totalAudioChunks: current!.totalAudioChunks, error: message }));
      if (latestReport) {
        try {
          await lifecycle.onFailed?.({ runId, report: latestReport, error: message });
        } catch (persistenceError) {
          // Preserve the original benchmark error rather than replacing it
          // with a secondary history persistence failure.
          recordLifecyclePersistenceFailure('failed', persistenceError);
        }
      }
    } finally {
      setRunning(false);
    }
  };

  return { modelId, setModelId, audioSource, setAudioSource, customPath, setCustomPath, mp3Path, setMp3Path, audioPresets, running, report, error, modalOpen, setModalOpen, progress, run };
}
