import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmptyBenchmarkReport } from './diagnosticsOverview';
import { useBenchmarkController, type BenchmarkVoiceModel } from './useBenchmarkController';

const runtime = vi.hoisted(() => ({
  readProviderSecret: vi.fn(),
  runModelBenchmark: vi.fn(),
}));

vi.mock('../../runtime/provider-runtime', () => ({ readProviderSecret: runtime.readProviderSecret }));
vi.mock('../../runtime/benchmark-runtime', () => ({ runModelBenchmark: runtime.runModelBenchmark }));

const option: BenchmarkVoiceModel = {
  modelId: 'voice-1', apiModelId: 'voice-api', displayName: 'Voice', authReference: 'secret://voice',
  realtimeAudioMode: 'manual', interactionCapabilities: ['streaming'],
  providerKind: 'openai-compatible', baseUrl: 'https://example.test', authHeaderName: 'Authorization', authScheme: 'Bearer',
};

describe('useBenchmarkController', () => {
  let root: Root;
  let container: HTMLDivElement;
  let controller: ReturnType<typeof useBenchmarkController>;
  let options: BenchmarkVoiceModel[];

  function Harness() {
    controller = useBenchmarkController(options);
    return null;
  }

  async function mount() {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    runtime.readProviderSecret.mockReset();
    runtime.runModelBenchmark.mockReset();
    options = [option];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('rejects a missing model and an empty input path', async () => {
    options = [];
    await mount();
    await act(async () => controller.run());
    expect(controller.error).toBeTruthy();

    options = [option];
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await act(async () => controller.setModelId(option.modelId));
    await act(async () => controller.setMp3Path('   '));
    await act(async () => controller.run());
    expect(controller.error).toBeTruthy();
  });

  it('uses report fallbacks when the runtime completes without progress', async () => {
    runtime.readProviderSecret.mockResolvedValue({ secret: 'key' });
    const report = createEmptyBenchmarkReport(option.apiModelId, 'sample.wav', option.interactionCapabilities);
    report.runs = [];
    runtime.runModelBenchmark.mockResolvedValue(report);
    await mount();
    await act(async () => controller.setMp3Path('sample.wav'));
    await act(async () => controller.run());

    expect(controller.progress).toMatchObject({ status: 'completed', phase: 'completed', audioChunksSent: 0, totalAudioChunks: 0 });
    expect(controller.modalOpen).toBe(true);
    await act(async () => controller.setModalOpen(false));
    expect(controller.modalOpen).toBe(false);
  });

  it('preserves progress values and its message on completion', async () => {
    runtime.readProviderSecret.mockResolvedValue({ secret: 'key' });
    const report = createEmptyBenchmarkReport(option.apiModelId, 'sample.wav', option.interactionCapabilities);
    runtime.runModelBenchmark.mockImplementation(async (_model: string, _secret: string, _path: string, config: { onProgress: (event: object) => void }) => {
      config.onProgress({ status: 'running', phase: 'streaming', message: 'halfway', audioChunksSent: 4, totalAudioChunks: 8, error: null, report });
      return report;
    });
    await mount();
    await act(async () => controller.run());
    expect(controller.progress).toMatchObject({ message: 'halfway', audioChunksSent: 4, totalAudioChunks: 8 });

    runtime.runModelBenchmark.mockImplementation(async (_model: string, _secret: string, _path: string, config: { onProgress: (event: object) => void }) => {
      config.onProgress({ status: 'running', phase: 'streaming', message: '', audioChunksSent: 8, totalAudioChunks: 8, error: null, report });
      return report;
    });
    await act(async () => controller.run());
    expect(controller.progress?.message).toBeTruthy();
  });

  it('reports missing credentials and non-Error runtime failures', async () => {
    runtime.readProviderSecret.mockResolvedValueOnce({ secret: '' });
    await mount();
    await act(async () => controller.run());
    expect(controller.error).toBeTruthy();

    runtime.readProviderSecret.mockRejectedValueOnce('offline');
    await act(async () => controller.run());
    expect(controller.error).toBe('offline');
    expect(controller.progress).toMatchObject({ status: 'error', error: 'offline' });
  });

  it('renders the message and code from a ServiceErrorV2 rejection', async () => {
    runtime.readProviderSecret.mockResolvedValue({ secret: 'key' });
    runtime.runModelBenchmark.mockRejectedValue({ code: 'provider.failed', message: 'network failed', retriable: true });
    await mount();
    await act(async () => controller.run());
    expect(controller.error).toBe('network failed (provider.failed)');
    expect(controller.progress?.error).toBe('network failed (provider.failed)');
  });
});
