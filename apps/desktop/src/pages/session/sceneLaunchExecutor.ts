import type { SceneLaunchPlan, SceneLaunchStage } from './sceneLaunchPlan';

type ExecutableStage = Exclude<SceneLaunchStage, 'bridge-ready' | 'omni-preconnect'>;
export type SceneLaunchStatus = 'fully-started' | 'partially-started' | 'rolled-back' | 'rollback-failed';
export type SceneLaunchOutcome = {
  status: SceneLaunchStatus;
  completedStages: SceneLaunchStage[];
  rolledBackStages: SceneLaunchStage[];
  rollbackFailures: Array<{ stage: SceneLaunchStage; error: unknown }>;
};

export class SceneLaunchError extends Error {
  constructor(public readonly cause: unknown, public readonly outcome: SceneLaunchOutcome) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'SceneLaunchError';
  }
}

type Dependencies = {
  abortSignal?: AbortSignal;
  ensureBridgeReady: () => Promise<void>;
  preconnectOmni: () => Promise<void>;
  cancelPreconnectOmni: () => Promise<void>;
  executeStage: (stage: ExecutableStage) => Promise<void>;
  compensateStage: (stage: ExecutableStage) => Promise<void>;
  onPreconnectWarning: (error: unknown) => void;
  onStageStart: (stage: SceneLaunchStage) => void;
};

function throwIfLaunchAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Scene launch aborted');
}

async function rollback(completedStages: SceneLaunchStage[], dependencies: Dependencies): Promise<SceneLaunchOutcome> {
  const rolledBackStages: SceneLaunchStage[] = [];
  const rollbackFailures: SceneLaunchOutcome['rollbackFailures'] = [];
  for (const stage of [...completedStages].reverse()) {
    try {
      if (stage === 'omni-preconnect') await dependencies.cancelPreconnectOmni();
      else if (stage !== 'bridge-ready' && stage !== 'subtitle-overlay') await dependencies.compensateStage(stage);
      else continue;
      rolledBackStages.push(stage);
    } catch (error) {
      rollbackFailures.push({ stage, error });
    }
  }
  return {
    status: rollbackFailures.length > 0 ? 'rollback-failed' : 'rolled-back',
    completedStages,
    rolledBackStages,
    rollbackFailures,
  };
}

export async function executeSceneLaunchPlan(plan: SceneLaunchPlan, dependencies: Dependencies): Promise<SceneLaunchOutcome> {
  const completedStages: SceneLaunchStage[] = [];
  try {
    throwIfLaunchAborted(dependencies.abortSignal);
    if (plan.parallelOmniPreconnect) {
      dependencies.onStageStart('bridge-ready');
      const bridgePromise = dependencies.ensureBridgeReady().catch(async (error) => {
        await dependencies.cancelPreconnectOmni().catch(() => undefined);
        throw error;
      });
      dependencies.onStageStart('omni-preconnect');
      const preconnectPromise = dependencies.preconnectOmni();
      const [bridgeResult, preconnectResult] = await Promise.allSettled([bridgePromise, preconnectPromise]);
      throwIfLaunchAborted(dependencies.abortSignal);
      if (bridgeResult.status === 'rejected') {
        throw bridgeResult.reason;
      }
      completedStages.push('bridge-ready');
      if (preconnectResult.status === 'fulfilled') completedStages.push('omni-preconnect');
      else dependencies.onPreconnectWarning(preconnectResult.reason);
    } else if (plan.stages.includes('bridge-ready')) {
      dependencies.onStageStart('bridge-ready');
      await dependencies.ensureBridgeReady();
      throwIfLaunchAborted(dependencies.abortSignal);
      completedStages.push('bridge-ready');
    }

    const executableStages = plan.stages.filter((stage): stage is ExecutableStage =>
      stage !== 'bridge-ready' && stage !== 'omni-preconnect');
    for (const stage of executableStages) {
      throwIfLaunchAborted(dependencies.abortSignal);
      dependencies.onStageStart(stage);
      await dependencies.executeStage(stage);
      throwIfLaunchAborted(dependencies.abortSignal);
      completedStages.push(stage);
    }
    return { status: 'fully-started', completedStages, rolledBackStages: [], rollbackFailures: [] };
  } catch (error) {
    const outcome = completedStages.some((stage) => stage !== 'bridge-ready')
      ? await rollback(completedStages, dependencies)
      : { status: 'partially-started' as const, completedStages, rolledBackStages: [], rollbackFailures: [] };
    throw new SceneLaunchError(error, outcome);
  }
}
