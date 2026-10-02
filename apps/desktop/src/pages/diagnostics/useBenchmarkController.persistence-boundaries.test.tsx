import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n/config';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import { createEmptyBenchmarkReport } from './diagnosticsOverview';
import { classifyBenchmarkError, useBenchmarkController, type BenchmarkVoiceModel, type BenchmarkRunLifecycle } from './useBenchmarkController';

const runtime = vi.hoisted(() => ({ secret: vi.fn(), run: vi.fn(), warn: vi.fn() }));
vi.mock('../../runtime/provider-runtime', () => ({ readProviderSecret: runtime.secret }));
vi.mock('../../runtime/benchmark-runtime', () => ({ runModelBenchmark: runtime.run }));
vi.mock('../../runtime/logger', () => ({ createLogger: () => ({ warn: runtime.warn }) }));
const option: BenchmarkVoiceModel = { modelId: 'voice', apiModelId: 'exact-voice', displayName: 'Voice', authReference: 'secret://voice', realtimeAudioMode: 'manual', interactionCapabilities: ['streaming'], providerKind: 'openai-compatible', baseUrl: 'https://example.test', authHeaderName: 'Authorization', authScheme: 'Bearer' };

describe('benchmark failure isolation from durable-history callbacks', () => {
  let controller: ReturnType<typeof useBenchmarkController>;
  let lifecycle: BenchmarkRunLifecycle;
  function Harness() { controller = useBenchmarkController([option], lifecycle); return null; }
  const view = registerDomHarness({ setup: () => {
    runtime.secret.mockReset().mockResolvedValue({ secret: 'test-key' });
    runtime.run.mockReset(); runtime.warn.mockReset(); lifecycle = {};
  } });

  it('keeps the completed result exportable when start and completion persistence both fail', async () => {
    const report = createEmptyBenchmarkReport('exact-voice', 'file.wav');
    runtime.run.mockResolvedValue(report);
    lifecycle = { onStarted: vi.fn().mockRejectedValue('start-storage-offline'), onCompleted: vi.fn().mockRejectedValue(new Error('complete-storage-offline')), onFailed: vi.fn() };
    await view.render(<Harness />);
    await act(async () => controller.run());
    expect(controller.running).toBe(false);
    expect(controller.error).toBeNull();
    expect(controller.report).toBe(report);
    expect(controller.progress?.status).toBe('completed');
    expect(controller.modalOpen).toBe(true);
    expect(runtime.warn).toHaveBeenCalledTimes(2);
    expect(runtime.warn.mock.calls.map((call) => call[1])).toEqual(['stage=started error=start-storage-offline', 'stage=completed error=complete-storage-offline']);
    expect(lifecycle.onFailed).not.toHaveBeenCalled();
    expect(lifecycle.onStarted).toHaveBeenCalledWith(expect.objectContaining({ runId: expect.any(String) }));
    expect(lifecycle.onCompleted).toHaveBeenCalledWith(expect.objectContaining({ report }));
  });

  it('keeps the original provider error and run identity when failure persistence also fails', async () => {
    runtime.run.mockRejectedValue(new Error('socket timeout'));
    const started = vi.fn(); const failed = vi.fn().mockRejectedValue('history write lost');
    lifecycle = { onStarted: started, onFailed: failed };
    await view.render(<Harness />);
    await act(async () => controller.run());
    expect(controller.error).toContain('socket timeout');
    expect(controller.error).not.toContain('history write lost');
    expect(controller.running).toBe(false);
    expect(controller.progress?.status).toBe('error');
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ runId: started.mock.calls[0][0].runId, report: controller.report, error: controller.error }));
    expect(runtime.warn).toHaveBeenCalledExactlyOnceWith('benchmark history lifecycle persistence failed', 'stage=failed error=history write lost');
  });

  it('gives English guidance for each error domain while retaining the technical cause', async () => {
    const language = i18n.language;
    try {
      await i18n.changeLanguage('en');
      for (const [cause, guidance] of [['401 Unauthorized', 'authentication failed'], ['ENOENT', 'audio file does not exist'], ['network timeout', 'connection failed'], ['unsupported', 'does not support'], ['unexpected', 'benchmark failed']]) {
        expect(classifyBenchmarkError(cause)).toContain(guidance);
        expect(classifyBenchmarkError(cause)).toContain('Technical details：' + cause);
      }
    } finally { await i18n.changeLanguage(language); }
  });
});
