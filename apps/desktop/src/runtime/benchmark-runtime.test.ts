import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mocks.listen(...args),
}));

vi.mock('./tauri-runtime', () => ({
  isTauriRuntime: () => mocks.isTauriRuntime(),
}));

import { BENCHMARK_PROGRESS_EVENT, runModelBenchmark, type BenchmarkProgressEvent, type BenchmarkReport } from './benchmark-runtime';

function makeReport(): BenchmarkReport {
  return {
    model: 'qwen-omni',
    audioFile: 'sample.mp3',
    audioDurationSecs: 1,
    runs: [],
    summary: {
      runCount: 1,
      successfulRuns: 1,
      avgConnectMs: 1,
      avgSessionReadyMs: 2,
      avgTimeToFirstTokenMs: 3,
      avgTimeToFirstCommittedMs: 4,
      avgOutputDeltaIntervalMs: 5,
      avgOutputDeltasPerRun: 6,
      avgTotalOutputDurationMs: 7,
      p50DeltaIntervalMs: 8,
      p90DeltaIntervalMs: 9,
      p99DeltaIntervalMs: 10,
      minDeltaIntervalMs: 1,
      maxDeltaIntervalMs: 10,
    },
  };
}

describe('benchmark runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invoke.mockReset();
    mocks.listen.mockReset().mockResolvedValue(vi.fn());
    mocks.isTauriRuntime.mockReset().mockReturnValue(true);
  });

  it('rejects when the desktop runtime is unavailable', async () => {
    mocks.isTauriRuntime.mockReturnValue(false);

    await expect(runModelBenchmark('model', 'key', 'audio.mp3')).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('forwards progress for the active run and resolves parsed reports', async () => {
    const report = makeReport();
    const unlisten = vi.fn();
    let progressHandler: ((event: { payload: BenchmarkProgressEvent }) => void) | undefined;
    mocks.listen.mockImplementation(async (_eventName: string, handler: (event: { payload: BenchmarkProgressEvent }) => void) => {
      progressHandler = handler;
      return unlisten;
    });
    mocks.invoke.mockResolvedValue({ data: JSON.stringify(report), warnings: [] });
    const onProgress = vi.fn();

    const resultPromise = runModelBenchmark('model', 'key', 'audio.mp3', {
      runId: 'run-1',
      realtimeAudioMode: 'server_vad',
      interactionCapabilities: ['streaming'],
      providerKind: 'openai',
      baseUrl: 'https://example.test',
      authHeaderName: 'Authorization',
      authScheme: 'Bearer',
      onProgress,
    });

    progressHandler?.({
      payload: {
        runId: 'other-run',
        status: 'running',
        phase: 'connect',
        message: 'ignored',
        report,
        audioChunksSent: 0,
        totalAudioChunks: 1,
      },
    });
    progressHandler?.({
      payload: {
        runId: 'run-1',
        status: 'completed',
        phase: 'done',
        message: 'complete',
        report,
        audioChunksSent: 1,
        totalAudioChunks: 1,
      },
    });

    await expect(resultPromise).resolves.toEqual(report);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(mocks.listen).toHaveBeenCalledWith(BENCHMARK_PROGRESS_EVENT, expect.any(Function));
    expect(mocks.invoke).toHaveBeenCalledWith('provider_v2', {
      command: {
        action: 'runModelBenchmark',
        model: 'model',
        apiKey: 'key',
        mp3Path: 'audio.mp3',
        runId: 'run-1',
        realtimeAudioMode: 'server_vad',
        interactionCapabilities: ['streaming'],
        providerKind: 'openai',
        baseUrl: 'https://example.test',
        authHeaderName: 'Authorization',
        authScheme: 'Bearer',
      },
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('generates a benchmark run id when none is provided', async () => {
    const report = makeReport();
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    mocks.invoke.mockResolvedValue({ data: JSON.stringify(report), warnings: [] });

    await expect(runModelBenchmark('model', 'key', 'audio.mp3')).resolves.toEqual(report);

    expect(mocks.invoke).toHaveBeenCalledWith('provider_v2', {
      command: expect.objectContaining({
        action: 'runModelBenchmark',
        runId: 'benchmark-1234-i',
      }),
    });
  });

  it('rejects invalid JSON and native invoke errors', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: '{bad json', warnings: [] });
    await expect(runModelBenchmark('model', 'key', 'audio.mp3', { runId: 'parse-fail' })).rejects.toThrow();

    mocks.invoke.mockRejectedValueOnce(new Error('native failed'));
    await expect(runModelBenchmark('model', 'key', 'audio.mp3', { runId: 'native-fail' })).rejects.toThrow('native failed');
  });

  it('formats non-Error JSON parse failures', async () => {
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw 'string parse failure';
    });
    mocks.invoke.mockResolvedValueOnce({ data: '{}', warnings: [] });

    await expect(runModelBenchmark('model', 'key', 'audio.mp3', { runId: 'parse-string-fail' })).rejects.toThrow('string parse failure');
    parseSpy.mockRestore();
  });

  it('times out slow benchmark runs and removes the listener', async () => {
    mocks.invoke.mockImplementation(() => new Promise(() => undefined));

    const result = runModelBenchmark('model', 'key', 'audio.mp3', { runId: 'slow-run' }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(180_000);

    await expect(result).resolves.toBeInstanceOf(Error);
  });
});
