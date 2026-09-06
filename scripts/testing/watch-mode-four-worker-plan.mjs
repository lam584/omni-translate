import { LIVE_LLM_CELLS, LOCAL_ISOLATION_CELLS } from './watch-mode-balanced-release-plan.mjs';

// Canonical paid cell order is distinct from dispatch order.
export const FOUR_WORKER_CELL_IDS = Object.freeze(['vm171', 'vm169', 'vm131', 'vm167']);
export const FOUR_WORKER_DISPATCH_SCHEDULE = Object.freeze(
  [0, 3, 1, 2].map((cellIndex, index) => Object.freeze({
    cellId: LIVE_LLM_CELLS[cellIndex].cellId,
    workerId: FOUR_WORKER_CELL_IDS[cellIndex],
    startOffsetMs: index * 3_000,
  })),
);

export function fixedFourWorkerAssignments(workers) {
  if (!Array.isArray(workers)) throw new Error('fixed four-worker placement requires an array');
  const byId = new Map(workers.map((worker) => [worker.workerId, worker]));
  if (workers.length !== 4 || byId.size !== 4
      || FOUR_WORKER_CELL_IDS.some((id) => !byId.has(id))) {
    throw new Error('fixed four-worker placement requires vm171, vm167, vm169 and vm131 exactly once');
  }
  return LIVE_LLM_CELLS.map((cell, index) => {
    const workerId = FOUR_WORKER_CELL_IDS[index];
    const profiles = byId.get(workerId).deviceProfileInstances?.filter((profile) => profile.deviceClass === cell.deviceClass) ?? [];
    if (profiles.length !== 1) throw new Error('worker ' + workerId + ' must have exactly one ' + cell.deviceClass + ' profile');
    return { cellId: cell.cellId, workerId, waveIndex: 0, deviceProfileInstanceId: profiles[0].instanceId };
  });
}

// Each paid placement needs zero-Provider evidence on that VM and route.
// c04 is process-exclusion stability, so vm167 must not reuse echo evidence.
export const FOUR_WORKER_ISOLATION_CELLS = Object.freeze(LIVE_LLM_CELLS.map((paid, index) => {
  const route = LOCAL_ISOLATION_CELLS.find((cell) => cell.feedbackLoopPrevention === paid.feedbackLoopPrevention
    && cell.deviceClass === paid.deviceClass);
  const repeatedRoute = LIVE_LLM_CELLS.slice(0, index).some((cell) => (
    cell.feedbackLoopPrevention === paid.feedbackLoopPrevention && cell.deviceClass === paid.deviceClass
  ));
  // Local execution and SCP collection share phase roots. Give a repeated
  // route its own directory identity without altering any paid cell ID.
  return repeatedRoute ? Object.freeze({ ...route, cellId: route.cellId + '::' + FOUR_WORKER_CELL_IDS[index] }) : route;
}));

export const DEFAULT_PAID_ISOLATION_POLICY = 'default-paid-workers-v1';

export function defaultPaidIsolationPlacements(workerIds) {
  if (!Array.isArray(workerIds) || workerIds.length < 1 || workerIds.length > 4
      || new Set(workerIds).size !== workerIds.length) throw new Error('invalid default isolation worker identities');
  if (workerIds.length >= 3) {
    const required = workerIds.length === 4 ? FOUR_WORKER_CELL_IDS : ['vm171', 'vm169', 'vm167'];
    if (required.some((id) => !workerIds.includes(id))) throw new Error('default isolation requires canonical worker identities');
    const placement = workerIds.length === 4 ? FOUR_WORKER_CELL_IDS : ['vm171', 'vm169', 'vm169', 'vm167'];
    return FOUR_WORKER_ISOLATION_CELLS.map((cell, index) => ({ cell, workerId: placement[index] }));
  }
  return LOCAL_ISOLATION_CELLS.map((cell, index) => ({
    cell, workerId: workerIds[workerIds.length === 1 || index === 0 ? 0 : 1],
  }));
}
