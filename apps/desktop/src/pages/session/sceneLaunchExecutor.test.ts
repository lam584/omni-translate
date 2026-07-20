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
    expect(sceneLaunchTimeoutMs('watch', true)).toBe(900);
    expect(sceneLaunchTimeoutMs('voice-room', true)).toBe(900);
    expect(sceneLaunchTimeoutMs('watch', false)).toBe(900);
  });

  it('returns fully-started after a sequential launch', async () => {
    const calls: string[] = [];
    const result = await executeSceneLaunchPlan(plan(['bridge-ready', 'inbound-route', 'translate-worker']), dependencies(calls));
    expect(result.status).toBe('fully-started');
    expect(calls).toEqual(['bridge', 'inbound-route', 'translate-worker']);
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
});
