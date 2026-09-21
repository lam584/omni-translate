import assert from 'node:assert/strict';
import test from 'node:test';
import { SHARD_ALLOWED_WORKER_COUNTS } from './watch-mode-shard-authority.mjs';
import { fourWorkerDispatchSchedule, fixedFourWorkerAssignments, FOUR_WORKER_DISPATCH_SCHEDULE, FOUR_WORKER_ISOLATION_CELLS } from './watch-mode-four-worker-plan.mjs';
import { createBalancedReleasePlan, LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
test('four-worker authority schema accepts four identity-bound workers', () => {
  assert.deepEqual(SHARD_ALLOWED_WORKER_COUNTS, [1, 2, 3, 4]);
});

test('four-worker mapping is permutation-independent and schedules c01/c04/c02/c03 at 0/3/6/9 seconds', () => {
  const workers = ['vm131', 'vm169', 'vm167', 'vm171'].map((workerId) => ({
    workerId, deviceProfileInstances: [{ instanceId: workerId + '-speaker', deviceClass: 'default-speaker' }],
  }));
  assert.deepEqual(fixedFourWorkerAssignments(workers).map((cell) => cell.workerId), ['vm171', 'vm169', 'vm131', 'vm167']);
  assert.deepEqual(FOUR_WORKER_DISPATCH_SCHEDULE.map((entry) => [LIVE_LLM_CELLS.findIndex((cell) => cell.cellId === entry.cellId) + 1, entry.workerId, entry.startOffsetMs]), [
    [1, 'vm171', 0], [4, 'vm167', 3000], [2, 'vm169', 6000], [3, 'vm131', 9000],
  ]);
  assert.deepEqual(FOUR_WORKER_ISOLATION_CELLS.map((cell) => cell.feedbackLoopPrevention), LIVE_LLM_CELLS.map((cell) => cell.feedbackLoopPrevention));
  assert.equal(new Set(FOUR_WORKER_ISOLATION_CELLS.map((cell) => cell.cellId)).size, 4);
  assert.equal(FOUR_WORKER_ISOLATION_CELLS[3].cellId, FOUR_WORKER_ISOLATION_CELLS[0].cellId + '::vm167');
  assert.ok(!LIVE_LLM_CELLS.some((cell) => cell.cellId.includes('vm167')));
  assert.ok(FOUR_WORKER_ISOLATION_CELLS.every((cell) => cell.providerMode === 'disabled' && cell.maxExternalAudioSamples === 0));
  assert.throws(() => fixedFourWorkerAssignments([...workers.slice(0, 3), workers[0]]), /exactly once/);
  const absent = structuredClone(workers);
  absent[0].deviceProfileInstances = [];
  assert.throws(() => fixedFourWorkerAssignments(absent), /exactly one/);
});

test('3.8 runs exactly four cells on the same four pinned workers without changing default placement', () => {
  const workers = ['vm171','vm169','vm131','vm167'].map(workerId => ({workerId,
    deviceProfileInstances:[{instanceId:workerId+'-speaker',deviceClass:'default-speaker'}]}));
  const plan = createBalancedReleasePlan({modelId:'qwen3.8-livetranslate-flash-realtime',
    endpointHost:'workspace-test.cn-beijing.maas.aliyuncs.com'});
  const assignments = fixedFourWorkerAssignments(workers, plan);
  assert.deepEqual(assignments.map(c=>c.workerId), ['vm171','vm169','vm131','vm167']);
  assert.ok(assignments.every(c=>c.cellId.includes('qwen3.8-livetranslate-flash-realtime')));
  assert.deepEqual(fourWorkerDispatchSchedule(plan).map(c=>c.startOffsetMs), [0,3000,6000,9000]);
  assert.ok(fixedFourWorkerAssignments(workers).every(c=>c.cellId.includes('qwen3.5-livetranslate-flash-realtime')));
  assert.deepEqual(fourWorkerDispatchSchedule(), FOUR_WORKER_DISPATCH_SCHEDULE);
});
