import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n/config';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import { createEmptyBenchmarkReport } from './diagnosticsOverview';
import { classifyBenchmarkError, useBenchmarkController, type BenchmarkVoiceModel } from './useBenchmarkController';

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
  let controller: ReturnType<typeof useBenchmarkController>;
  let options: BenchmarkVoiceModel[];

  function Harness() {
    controller = useBenchmarkController(options);
    return null;
  }

  const view = registerDomHarness({
    setup: () => {
      runtime.readProviderSecret.mockReset();
      runtime.runModelBenchmark.mockReset();
      options = [option];
    },
  });

  async function mount() {
    await act(async () => {
      view.root.render(<Harness />);
      await Promise.resolve();
    });
  }

  it('rejects a missing model and an empty input path', async () => {
    options = [];
    await mount();
    await act(async () => controller.run());
    expect(controller.error).toBe(i18n.t('diagnostics.benchmark.selectVoiceModelFirst'));

    options = [option];
    await mount();
    await act(async () => controller.setModelId(option.modelId));
    await act(async () => controller.setMp3Path('   '));
    await act(async () => controller.run());
    expect(controller.error).toBe(i18n.t('diagnostics.benchmark.enterMp3Path'));
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
    // An empty streamed message must fall back to the localized "completed"
    // wording instead of leaving the modal blank.
    expect(controller.progress?.message).toBe(i18n.t('diagnostics.benchmark.completed'));
    expect(controller.progress?.status).toBe('completed');
  });

  it('reports missing credentials and non-Error runtime failures', async () => {
    runtime.readProviderSecret.mockResolvedValueOnce({ secret: '' });
    await mount();
    await act(async () => controller.run());
    expect(controller.error).toContain(
      i18n.t('diagnostics.benchmark.missingApiKey', { model: option.displayName }),
    );

    runtime.readProviderSecret.mockRejectedValueOnce('offline');
    await act(async () => controller.run());
    expect(controller.error).toContain('offline');
    expect(controller.progress).toMatchObject({ status: 'error' });
    expect(controller.progress?.error).toContain('offline');
  });

  it('classifies common benchmark failures and preserves technical details', () => {
    expect(classifyBenchmarkError(new Error('401 Unauthorized'))).toContain('API Key');
    expect(classifyBenchmarkError(new Error('No such file or directory'))).toContain('绝对路径');
    expect(classifyBenchmarkError(new Error('websocket timed out'))).toContain('连接失败或超时');
    expect(classifyBenchmarkError(new Error('model unsupported'))).toContain('实时音频');
    expect(classifyBenchmarkError('unknown failure')).toContain('unknown failure');
  });

  it('renders the message and code from a ServiceErrorV2 rejection', async () => {
    runtime.readProviderSecret.mockResolvedValue({ secret: 'key' });
    runtime.runModelBenchmark.mockRejectedValue({ code: 'provider.failed', message: 'network failed', retriable: true });
    await mount();
    await act(async () => controller.run());
    expect(controller.error).toContain('模型连接失败或超时');
    expect(controller.error).toContain('network failed (provider.failed)');
    expect(controller.progress?.error).toBe(controller.error);
  });
});
