import assert from 'node:assert/strict';
import test from 'node:test';

import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
import * as budget from './watch-mode-release-timeout-budget.mjs';

const LEGACY_UNIFIED_SHARD_TIMEOUT_MS = 578_000;
const LEGACY_UNIFIED_REMOTE_TIMEOUT_MS = 620_000;

function requirePerCellDerivers() {
  assert.equal(
    typeof budget.deriveWatchRunnerInternalDeadlineMs,
    'function',
    `legacy uniform timeout budget is still active: shard=${budget.WATCH_SHARD_WORKER_TIMEOUT_MS} remote=${budget.WATCH_PRODUCTION_REMOTE_CELL_TIMEOUT_MS}`,
  );
  assert.equal(typeof budget.deriveWatchShardWorkerTimeoutMs, 'function');
  assert.equal(typeof budget.deriveWatchProductionInteractiveCellTimeoutMs, 'function');
  assert.equal(typeof budget.deriveWatchProductionRemoteCellTimeoutMs, 'function');
}

test('runner watchdog treats readiness and input-complete as parallel launch-clock phases', () => {
  for (const fakeCell of [
    { cellHardWatchdogSeconds: 40 },
    { cellHardWatchdogSeconds: 120 },
  ]) {
    const hardMs = fakeCell.cellHardWatchdogSeconds * 1_000;
    assert.equal(
      budget.deriveWatchRunnerInternalDeadlineMs(fakeCell),
      Math.max(budget.WATCH_RUNNER_READINESS_TIMEOUT_MS, hardMs)
        + budget.WATCH_REPORT_RECEIPT_GRACE_MS
        + budget.WATCH_RUNNER_SCHEDULING_ENVELOPE_MS,
    );
  }
});

test('formal LiveTranslate watchdogs derive from each cell hard watchdog instead of one maximum', () => {
  requirePerCellDerivers();
  const derived = LIVE_LLM_CELLS.map((cell) => ({
    mode: cell.feedbackLoopPrevention,
    hardMs: cell.cellHardWatchdogSeconds * 1_000,
    runnerMs: budget.deriveWatchRunnerInternalDeadlineMs(cell),
    shardMs: budget.deriveWatchShardWorkerTimeoutMs(cell),
    interactiveMs: budget.deriveWatchProductionInteractiveCellTimeoutMs(cell),
    remoteMs: budget.deriveWatchProductionRemoteCellTimeoutMs(cell),
  }));

  assert.deepEqual(
    derived.map(({ mode, runnerMs, shardMs, interactiveMs, remoteMs }) => ({
      mode, runnerMs, shardMs, interactiveMs, remoteMs,
    })),
    [
      { mode: 'process-exclusion', runnerMs: 420_000, shardMs: 548_000, interactiveMs: 610_000, remoteMs: 640_000 },
      { mode: 'virtual-driver', runnerMs: 375_000, shardMs: 503_000, interactiveMs: 565_000, remoteMs: 595_000 },
      { mode: 'echo-cancel', runnerMs: 375_000, shardMs: 503_000, interactiveMs: 565_000, remoteMs: 595_000 },
      { mode: 'process-exclusion', runnerMs: 420_000, shardMs: 548_000, interactiveMs: 610_000, remoteMs: 640_000 },
    ],
  );

  for (const cell of derived) {
    const runnerStageSumMs = Math.max(
      budget.WATCH_RUNNER_READINESS_TIMEOUT_MS,
      cell.hardMs,
    )
      + budget.WATCH_REPORT_RECEIPT_GRACE_MS;
    assert.ok(cell.runnerMs > runnerStageSumMs);
    assert.ok(cell.shardMs > (
      budget.WATCH_SHARD_PRE_DESKTOP_ENVELOPE_MS
      + cell.runnerMs
      + budget.WATCH_SHARD_POST_REPORT_ENVELOPE_MS
    ));
    assert.ok(cell.interactiveMs > cell.shardMs);
    assert.ok(cell.remoteMs > cell.interactiveMs);
  }

  const process = derived.find((entry) => entry.mode === 'process-exclusion');
  const ordinary = derived.find((entry) => entry.mode === 'virtual-driver');
  assert.ok(process.shardMs > ordinary.shardMs);
  assert.ok(process.remoteMs > ordinary.remoteMs);
  assert.ok(process.shardMs < LEGACY_UNIFIED_SHARD_TIMEOUT_MS);
  assert.ok(ordinary.remoteMs < LEGACY_UNIFIED_REMOTE_TIMEOUT_MS);
  assert.ok(process.remoteMs > LEGACY_UNIFIED_REMOTE_TIMEOUT_MS);
  assert.equal(budget.WATCH_SHARD_WORKER_TIMEOUT_MS, undefined);
  assert.equal(budget.WATCH_PRODUCTION_REMOTE_CELL_TIMEOUT_MS, undefined);
});

test('formal envelopes cover measured stage tails and coordinator sums four concrete cells', () => {
  requirePerCellDerivers();
  assert.ok(budget.WATCH_SHARD_PRE_DESKTOP_ENVELOPE_MS > 15_320);
  assert.ok(budget.WATCH_SHARD_POST_REPORT_ENVELOPE_MS > 75_070);

  const perCellExecutionMs = LIVE_LLM_CELLS.map((cell) => (
    budget.WATCH_PRODUCTION_CELL_LEASE_UPLOAD_TIMEOUT_MS
    + budget.deriveWatchProductionRemoteCellTimeoutMs(cell)
    + budget.WATCH_PRODUCTION_CELL_DOWNLOAD_TIMEOUT_MS
  ));
  const expectedPostReadinessMs = budget.deriveWatchProductionPreservedWorkerReadinessBudgetMs()
    + perCellExecutionMs.reduce((sum, value) => sum + value, 0)
    + budget.WATCH_PRODUCTION_POST_PREFLIGHT_EVIDENCE_MARGIN_MS;
  const expectedCoordinatorMs = budget.deriveWatchProductionPrepaidCoordinatorBudgetMs()
    + expectedPostReadinessMs;

  assert.deepEqual(perCellExecutionMs, [1_000_000, 955_000, 955_000, 1_000_000]);
  assert.equal(
    budget.deriveWatchPostReadinessExecutionBudgetMs({ cells: LIVE_LLM_CELLS }),
    expectedPostReadinessMs,
  );
  assert.equal(
    budget.deriveWatchProductionCoordinatorTimeoutMs({ cells: LIVE_LLM_CELLS }),
    expectedCoordinatorMs,
  );
  assert.equal(
    budget.deriveWatchProductionFinalEvidenceBudgetMs(),
    2 * budget.WATCH_PRODUCTION_RUNTIME_AUTHORITY_VERIFICATION_TIMEOUT_MS
      + budget.WATCH_PRODUCTION_FINAL_EVIDENCE_ENVELOPE_MS,
    'final evidence must reserve pre-verifier authority, verifier, and post-verifier authority',
  );
  assert.equal(expectedPostReadinessMs, 6_152_000);
  // All 60 signed implementation files include the release preparation and
  // distribution entrypoints. Reserve one 60s upload envelope per file, even
  // when the runtime delta fast path avoids unchanged binary uploads.
  assert.equal(expectedCoordinatorMs, 13_822_000);

  const uniformMaximumCounterfactualMs = budget.deriveWatchProductionPrepaidCoordinatorBudgetMs()
    + budget.deriveWatchProductionPreservedWorkerReadinessBudgetMs()
    + LIVE_LLM_CELLS.length * Math.max(...perCellExecutionMs)
    + budget.WATCH_PRODUCTION_POST_PREFLIGHT_EVIDENCE_MARGIN_MS;
  assert.notEqual(expectedCoordinatorMs, uniformMaximumCounterfactualMs);
});

test('interactive watchdog covers authority acquisition and process kill outside executeCell', () => {
  assert.equal(
    budget.deriveWatchShardPreExecutionBudgetMs(),
    budget.WATCH_SHARD_AUTHORITY_FILE_COUNT
      * budget.WATCH_SHARD_AUTHORITY_FILE_WAIT_TIMEOUT_MS
      + budget.WATCH_SHARD_PROCESS_IDENTITY_TIMEOUT_MS,
  );
  for (const cell of LIVE_LLM_CELLS) {
    assert.equal(
      budget.deriveWatchProductionInteractiveCellTimeoutMs(cell),
      budget.deriveWatchShardPreExecutionBudgetMs()
        + budget.deriveWatchShardExecutionSettlementBudgetMs(cell)
        + budget.WATCH_REMOTE_INTERACTIVE_LAUNCH_ENVELOPE_MS,
    );
  }
});

test('coordinator global watchdog reserves every legal pre-paid readiness and preflight phase', () => {
  const currentPrepaidReserveMs = budget.deriveWatchProductionCoordinatorTimeoutMs({
    cells: LIVE_LLM_CELLS,
  }) - budget.deriveWatchPostReadinessExecutionBudgetMs({ cells: LIVE_LLM_CELLS });
  const knownLegalPrepaidLowerBoundMs = (
    45_000
    + 300_000
    + 45_000
    + 600_000
    + 330_000
    + 300_000
    + 300_000
    + 5_000
    + 3_000
    + 10_000
  );
  assert.ok(
    currentPrepaidReserveMs >= knownLegalPrepaidLowerBoundMs,
    `coordinator reserves ${currentPrepaidReserveMs}ms before paid waves, but legal bounded phases require at least ${knownLegalPrepaidLowerBoundMs}ms`,
  );
  assert.equal(
    budget.deriveWatchProductionRuntimeVerificationRetryBudgetMs(),
    budget.WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_ATTEMPTS
      * budget.WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_TIMEOUT_MS
      + (budget.WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_ATTEMPTS - 1)
        * budget.WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_RETRY_DELAY_MS,
  );
  assert.equal(budget.WATCH_PRODUCTION_INITIAL_IMPLEMENTATION_UPLOAD_COUNT, 60);
  assert.equal(budget.WATCH_PRODUCTION_INITIAL_RUNTIME_UPLOAD_COUNT, 14);
  assert.equal(budget.deriveWatchProductionInitialWorkerReadinessBudgetMs(), 6_847_000);
  assert.equal(budget.deriveWatchProductionPreservedWorkerReadinessBudgetMs(), 1_177_000);
  assert.equal(budget.deriveWatchProductionProviderPreflightBudgetMs(), 328_000);
  assert.equal(budget.deriveWatchProductionPrepaidCoordinatorBudgetMs(), 7_670_000);
  assert.equal(currentPrepaidReserveMs, budget.deriveWatchProductionPrepaidCoordinatorBudgetMs());
});

test('coordinator preparation reserves all three provenance captures', () => {
  const expectedPreparationMs = (
    budget.WATCH_PRODUCTION_RUNTIME_AUTHORITY_VERIFICATION_TIMEOUT_MS
    + 3 * budget.WATCH_PRODUCTION_PROVENANCE_CAPTURE_TIMEOUT_MS
    + 2 * budget.WATCH_PRODUCTION_AUTHORITY_INVENTORY_CAPTURE_TIMEOUT_MS
    + budget.deriveWatchProductionInitialWorkerReadinessBudgetMs()
    + budget.WATCH_PRODUCTION_LOCAL_ISOLATION_VERIFICATION_TIMEOUT_MS
    + budget.deriveWatchProductionNetworkHealthBudgetMs()
    + budget.deriveWatchProductionProviderPreflightBudgetMs()
    + budget.WATCH_PRODUCTION_COORDINATOR_PUBLICATION_ENVELOPE_MS
  );
  assert.equal(
    budget.deriveWatchProductionCoordinatorPreparationBudgetMs(),
    expectedPreparationMs,
  );
});

test('worker readiness budgets include every serial plan, implementation, and runtime upload', () => {
  const scaledUploadTimeoutMs = 7;
  const implementationUploadCount = 2;
  const runtimeUploadCount = 3;
  const initialWithoutUploadsMs = budget.deriveWatchProductionInitialWorkerReadinessBudgetMs({
    uploadTimeoutMs: 0,
    implementationUploadCount,
    runtimeUploadCount,
  });
  assert.equal(
    budget.deriveWatchProductionInitialWorkerReadinessBudgetMs({
      uploadTimeoutMs: scaledUploadTimeoutMs,
      implementationUploadCount,
      runtimeUploadCount,
    }),
    initialWithoutUploadsMs
      + (1 + implementationUploadCount + runtimeUploadCount) * scaledUploadTimeoutMs,
  );

  const preservedWithoutUploadMs = budget.deriveWatchProductionPreservedWorkerReadinessBudgetMs({
    uploadTimeoutMs: 0,
  });
  assert.equal(
    budget.deriveWatchProductionPreservedWorkerReadinessBudgetMs({
      uploadTimeoutMs: scaledUploadTimeoutMs,
    }),
    preservedWithoutUploadMs + scaledUploadTimeoutMs,
  );
});
