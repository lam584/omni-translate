import { useEffect, useState } from 'react';
import i18n from '../../i18n/config';
import { runModelBenchmark, type BenchmarkProgressEvent, type BenchmarkReport } from '../../runtime/benchmark-runtime';
import { readProviderSecret } from '../../runtime/provider-runtime';
import type { RealtimeAudioMode } from '../../schema/config';
import type { ProviderInteractionCapability } from '../../schema/provider-contract';
import { createEmptyBenchmarkReport } from './diagnosticsOverview';

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
};

type BenchmarkProgressView = Pick<BenchmarkProgressEvent, 'status' | 'phase' | 'message' | 'audioChunksSent' | 'totalAudioChunks' | 'error'>;

export function useBenchmarkController(voiceModelOptions: BenchmarkVoiceModel[]) {
  const [modelId, setModelId] = useState('');
  const [mp3Path, setMp3Path] = useState('scripts/testing/fixtures/watch-mode-en-original.wav');
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [progress, setProgress] = useState<BenchmarkProgressView | null>(null);

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
    try {
      const secretPayload = await readProviderSecret(selected.authReference);
      if (!secretPayload.secret) throw new Error(i18n.t('diagnostics.benchmark.missingApiKey', { model: selected.displayName }));
      setReport(createEmptyBenchmarkReport(selected.apiModelId, mp3Path, selected.interactionCapabilities));
      setModalOpen(true);
      const nextReport = await runModelBenchmark(selected.apiModelId, secretPayload.secret, mp3Path, {
        realtimeAudioMode: selected.realtimeAudioMode,
        interactionCapabilities: selected.interactionCapabilities,
        providerKind: selected.providerKind,
        baseUrl: selected.baseUrl,
        authHeaderName: selected.authHeaderName,
        authScheme: selected.authScheme,
        onProgress: (event) => {
          setReport(event.report);
          setProgress({ status: event.status, phase: event.phase, message: event.message, audioChunksSent: event.audioChunksSent, totalAudioChunks: event.totalAudioChunks, error: event.error });
        },
      });
      setReport(nextReport);
      setProgress((current) => ({ status: 'completed', phase: 'completed', message: current!.message || i18n.t('diagnostics.benchmark.completed'), audioChunksSent: current!.audioChunksSent, totalAudioChunks: current!.totalAudioChunks, error: null }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setProgress((current) => ({ status: 'error', phase: current!.phase, message, audioChunksSent: current!.audioChunksSent, totalAudioChunks: current!.totalAudioChunks, error: message }));
    } finally {
      setRunning(false);
    }
  };

  return { modelId, setModelId, mp3Path, setMp3Path, running, report, error, modalOpen, setModalOpen, progress, run };
}
