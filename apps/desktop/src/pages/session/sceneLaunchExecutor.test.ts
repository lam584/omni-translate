import { describe, expect, it, vi } from 'vitest';
import type { SceneLaunchPlan, SceneLaunchStage } from './sceneLaunchPlan';
import { executeSceneLaunchPlan, SceneLaunchError } from './sceneLaunchExecutor';
import { sceneLaunchTimeoutMs } from './sceneLaunchTimeout';

const plan = (stages: SceneLaunchStage[], parallelOmniPreconnect = false): SceneLaunchPlan => ({
  mode: 'watch', config: {} as SceneLaunchPlan['config'], stages, parallelOmniPreconnect,
});

function dependencies(calls: string[]) {
  return {
    ensureBridgeReady: async () => { calls.push('bridge'); },
    preconnectOmni: async () => { calls.push('preconnect'); },
    cancelPreconnectOmni: async () => { calls.push('cancel-preconnect'); },
    executeStage: async (stage: Exclude<SceneLaunchStage, 'bridge-ready' | 'omni-preconnect'>) => { calls.push(stage); },
    compensateStage: async (stage: Exclude<SceneLaunchStage, 'bridge-ready' | 'omni-preconnect'>) => { calls.push(`stop-${stage}`); },
    onPreconnectWarning: vi.fn(), onStageStart: vi.fn(),
  };
}

describe('executeSceneLaunchPlan', () => {
  it('limits scene startup to less than one second', () => {
    expect(sceneLaunchTimeoutMs('watch')).toBe(900);
    expect(sceneLaunchTimeoutMs('voice-room')).toBe(900);
    expect(sceneLaunchTimeoutMs('game')).toBe(900);
    expect(sceneLaunchTimeoutMs('watch', 'process-exclusion')).toBe(8000);
  });

  it('returns fully-started after a sequential launch', async () => {
    const calls: string[] = [];
    const result = await executeSceneLaunchPlan(plan(['bridge-ready', 'inbound-route', 'translate-worker']), dependencies(calls));
    expect(result.status).toBe('fully-started');
    expect(calls).toEqual(['bridge', 'inbound-route', 'translate-worker']);
  });

  it('does not execute bridge startup when the Watch plan omits bridge-ready', async () => {
    const calls: string[] = [];
    const result = await executeSceneLaunchPlan(plan(['inbound-route']), dependencies(calls));

    expect(result.status).toBe('fully-started');
    expect(calls).toEqual(['inbound-route']);
  });

  it('rolls completed stages back in reverse order', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    deps.executeStage = async (stage) => { calls.push(stage); if (stage === 'speech-dispatch') throw new Error('speech'); };
    const error = await executeSceneLaunchPlan(plan(['bridge-ready', 'inbound-route', 'translate-worker', 'speech-dispatch']), deps)
      .catch((reason) => reason as SceneLaunchError);
    if (!(error instanceof SceneLaunchError)) throw new Error('expected launch failure');
    expect(error.outcome.status).toBe('rolled-back');
    expect(calls).toEqual(['bridge', 'inbound-route', 'translate-worker', 'speech-dispatch', 'stop-translate-worker', 'stop-inbound-route']);
  });

  it('reports rollback-failed while continuing remaining compensations', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    deps.executeStage = async (stage) => { calls.push(stage); if (stage === 'speech-dispatch') throw new Error('speech'); };
    deps.compensateStage = async (stage) => { calls.push(`stop-${stage}`); if (stage === 'translate-worker') throw new Error('stop'); };
    const error = await executeSceneLaunchPlan(plan(['bridge-ready', 'inbound-route', 'translate-worker', 'speech-dispatch']), deps)
      .catch((reason) => reason as SceneLaunchError);
    if (!(error instanceof SceneLaunchError)) throw new Error('expected launch failure');
    expect(error.outcome.status).toBe('rollback-failed');
    expect(error.outcome.rollbackFailures).toHaveLength(1);
    expect(calls).toContain('stop-inbound-route');
  });

  it('cancels and settles preconnect when bridge fails', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    deps.ensureBridgeReady = async () => { calls.push('bridge'); throw new Error('bridge'); };
    deps.preconnectOmni = async () => { calls.push('preconnect'); throw new Error('provider'); };
    await expect(executeSceneLaunchPlan(plan(['bridge-ready', 'omni-preconnect'], true), deps)).rejects.toThrow('bridge');
    expect(calls).toEqual(['bridge', 'preconnect', 'cancel-preconnect']);
  });

  it('does not start another stage after the launch is aborted', async () => {
    const calls: string[] = [];
    const abortController = new AbortController();
    const deps = dependencies(calls);
    deps.ensureBridgeReady = async () => {
      calls.push('bridge');
      abortController.abort(new Error('launch timeout'));
    };

    await expect(executeSceneLaunchPlan(plan(['bridge-ready', 'inbound-route']), {
      ...deps,
      abortSignal: abortController.signal,
    }))
      .rejects.toThrow('launch timeout');
    expect(calls).toEqual(['bridge']);
  });

  it('normalizes a non-Error abort reason', async () => {
    const abortController = new AbortController();
    abortController.abort('cancelled');

    await expect(executeSceneLaunchPlan(plan(['inbound-route']), {
      ...dependencies([]),
      abortSignal: abortController.signal,
    })).rejects.toThrow('Scene launch aborted');
  });

  it('continues after a parallel preconnect warning when Bridge succeeds', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    deps.preconnectOmni = async () => { calls.push('preconnect'); throw new Error('provider unavailable'); };

    const result = await executeSceneLaunchPlan(plan(['bridge-ready', 'omni-preconnect', 'inbound-route'], true), deps);

    expect(result.status).toBe('fully-started');
    expect(deps.onPreconnectWarning).toHaveBeenCalledWith(expect.any(Error));
    expect(calls).toEqual(['bridge', 'preconnect', 'inbound-route']);
  });

  it('ignores cancellation failure while preserving a parallel Bridge error', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    deps.ensureBridgeReady = async () => { throw new Error('bridge failed'); };
    deps.cancelPreconnectOmni = async () => { throw new Error('cancel failed'); };

    await expect(executeSceneLaunchPlan(plan(['bridge-ready', 'omni-preconnect'], true), deps)).rejects.toThrow('bridge failed');
  });

  it('rolls back a completed parallel preconnect and a completed subtitle overlay', async () => {
    // Regression: rollback used to skip 'subtitle-overlay' entirely, leaving
    // the native overlay window visible after every failed launch that had
    // already opened it.
    const calls: string[] = [];
    const deps = dependencies(calls);
    deps.executeStage = async (stage) => {
      calls.push(stage);
      if (stage === 'inbound-route') throw 'native rejection';
    };

    const error = await executeSceneLaunchPlan(
      plan(['bridge-ready', 'omni-preconnect', 'subtitle-overlay', 'inbound-route'], true),
      deps,
    ).catch((reason) => reason as SceneLaunchError);

    expect(error).toBeInstanceOf(SceneLaunchError);
    if (!(error instanceof SceneLaunchError)) throw new Error('expected launch failure');
    expect(error.message).toBe('native rejection');
    expect(calls).toContain('cancel-preconnect');
    expect(calls).toContain('stop-subtitle-overlay');
    expect(calls).not.toContain('stop-bridge-ready');
  });
});
