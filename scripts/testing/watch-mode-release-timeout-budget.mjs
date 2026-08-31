import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
import {
  PROVIDER_NETWORK_HEALTH_SAMPLE_COUNT,
  PROVIDER_NETWORK_HEALTH_TIMEOUT_MS,
} from './watch-mode-provider-network-health.mjs';
import {
  PROVIDER_PREFLIGHT_CLEANUP_TIMEOUT_MS,
  PROVIDER_PREFLIGHT_CLOSE_GRACE_MS,
  PROVIDER_PREFLIGHT_EMITTER_TIMEOUT_MS,
  PROVIDER_PREFLIGHT_EXIT_GRACE_MS,
} from './watch-mode-provider-preflight-process.mjs';
import {
  AUTHORITY_IMPLEMENTATION_FILES,
  AUTHORITY_RUNTIME_BINARY_FILES,
} from './watch-mode-evidence-authority.mjs';

export const WATCH_RELEASE_CELL_COUNT = LIVE_LLM_CELLS.length;

// Formal paid requests continue to allow the Desktop readiness phase to wait
// for 90 seconds. Keep the seconds value beside its outer-budget projection so
// the request and its watchdog cannot silently diverge.
export const WATCH_RUNNER_READINESS_TIMEOUT_SECONDS = 90;
export const WATCH_RUNNER_READINESS_TIMEOUT_MS = WATCH_RUNNER_READINESS_TIMEOUT_SECONDS * 1_000;
export const WATCH_REPORT_RECEIPT_GRACE_MS = 30_000;
export const WATCH_RUNNER_SCHEDULING_ENVELOPE_MS = 20_000;

// Historical formal artifacts observed at most 15.32 seconds before Desktop
// launch and 75.07 seconds after report receipt. These fail-closed envelopes
// retain roughly 15 seconds beyond each observed tail without becoming normal
// lifecycle waits.
export const WATCH_SHARD_PRE_DESKTOP_ENVELOPE_MS = 30_000;
export const WATCH_SHARD_POST_REPORT_ENVELOPE_MS = 90_000;
export const WATCH_SHARD_PROCESS_TERMINATION_GRACE_MS = 8_000;

// The interactive launcher publishes two independent authorities before the
// shard may start executeCell. Process identity inspection is another bounded
// synchronous phase, and taskkill runs only after the executeCell watchdog has
// expired. Keep all four outer phases in the shared derivation used by the
// launcher instead of hiding them in an unrelated scheduling envelope.
export const WATCH_SHARD_AUTHORITY_FILE_WAIT_TIMEOUT_MS = 15_000;
export const WATCH_SHARD_AUTHORITY_FILE_COUNT = 2;
export const WATCH_SHARD_PROCESS_IDENTITY_TIMEOUT_MS = 15_000;
export const WATCH_SHARD_PROCESS_KILL_TIMEOUT_MS = 5_000;

// The interactive task remains outside the shard watchdog, and the SSH/local
// command remains outside the interactive task. Their sum preserves the prior
// 42-second remote dispatch/receipt allowance while making both boundaries
// explicit and independently ordered.
export const WATCH_REMOTE_INTERACTIVE_LAUNCH_ENVELOPE_MS = 12_000;
export const WATCH_REMOTE_COMMAND_COMPLETION_GRACE_MS = 30_000;
export const WATCH_REMOTE_DISPATCH_AND_RECEIPT_ENVELOPE_MS = (
  WATCH_REMOTE_INTERACTIVE_LAUNCH_ENVELOPE_MS
  + WATCH_REMOTE_COMMAND_COMPLETION_GRACE_MS
);

// Lease upload is a separately timed lower-layer call and therefore must be
// present in the coordinator sum instead of being hidden inside a remote-cell
// timeout that starts only after the upload finishes.
export const WATCH_PRODUCTION_CELL_LEASE_UPLOAD_TIMEOUT_MS = 60_000;
export const WATCH_PRODUCTION_CELL_DOWNLOAD_TIMEOUT_MS = 300_000;
export const WATCH_PRODUCTION_ZERO_PROVIDER_READINESS_TIMEOUT_MS = 10 * 60_000;
export const WATCH_PRODUCTION_WORKER_QUERY_TIMEOUT_MS = 45_000;
export const WATCH_PRODUCTION_REMOTE_COMMAND_TIMEOUT_MS = 60_000;
export const WATCH_PRODUCTION_INITIAL_IMPLEMENTATION_UPLOAD_COUNT =
  AUTHORITY_IMPLEMENTATION_FILES.length;
export const WATCH_PRODUCTION_INITIAL_RUNTIME_UPLOAD_COUNT =
  AUTHORITY_RUNTIME_BINARY_FILES.length;
export const WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_TIMEOUT_MS = 5 * 60_000;
export const WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_ATTEMPTS = 3;
export const WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_RETRY_DELAY_MS = 1_000;
export const WATCH_PRODUCTION_ENDPOINT_READINESS_TASK_TIMEOUT_MS = 5 * 60_000;
export const WATCH_PRODUCTION_ENDPOINT_READINESS_REMOTE_TIMEOUT_MS = 330_000;
export const WATCH_PRODUCTION_REMOTE_READINESS_FINALIZATION_TIMEOUT_MS = 5 * 60_000;
export const WATCH_PRODUCTION_PRESERVED_READINESS_TIMEOUT_MS = 60_000;

// The coordinator verifies the frozen runtime twice (entry and the build seam),
// captures provenance twice around that seam, and captures two implementation
// inventories. These outer stage watchdogs also govern injected implementations
// used by deterministic tooling tests.
export const WATCH_PRODUCTION_RUNTIME_AUTHORITY_VERIFICATION_TIMEOUT_MS = 60_000;
export const WATCH_PRODUCTION_PROVENANCE_CAPTURE_TIMEOUT_MS = 60_000;
export const WATCH_PRODUCTION_AUTHORITY_INVENTORY_CAPTURE_TIMEOUT_MS = 60_000;
export const WATCH_PRODUCTION_LOCAL_ISOLATION_VERIFICATION_TIMEOUT_MS = 5_000;
export const WATCH_PRODUCTION_PROVIDER_NETWORK_DNS_TIMEOUT_MS =
  PROVIDER_NETWORK_HEALTH_TIMEOUT_MS;
export const WATCH_PRODUCTION_PROVIDER_CONNECTION_INVENTORY_TIMEOUT_MS = 10_000;
export const WATCH_PRODUCTION_PROVIDER_PREFLIGHT_AUTHORITY_TIMEOUT_MS = 5_000;
export const WATCH_PRODUCTION_COORDINATOR_STAGE_SETTLEMENT_ENVELOPE_MS = 5_000;
export const WATCH_PRODUCTION_COORDINATOR_PUBLICATION_ENVELOPE_MS = 30_000;

// Guest manifest finalization is a remote child command. Full-tree collection
// follows it, then local evidence verification/publication uses the remainder
// of the historical 15-minute post-cell allowance.
export const WATCH_PRODUCTION_GUEST_FINALIZER_TIMEOUT_MS = 60_000;
export const WATCH_PRODUCTION_SHARD_COLLECTION_TIMEOUT_MS = 10 * 60_000;
export const WATCH_PRODUCTION_FINAL_RUNTIME_AUTHORITY_VERIFICATION_COUNT = 2;
export const WATCH_PRODUCTION_FINAL_EVIDENCE_ENVELOPE_MS = 4 * 60_000;
export function deriveWatchProductionFinalEvidenceBudgetMs() {
  return (
    WATCH_PRODUCTION_FINAL_RUNTIME_AUTHORITY_VERIFICATION_COUNT
      * WATCH_PRODUCTION_RUNTIME_AUTHORITY_VERIFICATION_TIMEOUT_MS
    + WATCH_PRODUCTION_FINAL_EVIDENCE_ENVELOPE_MS
  );
}
export const WATCH_PRODUCTION_POST_PREFLIGHT_EVIDENCE_MARGIN_MS = (
  WATCH_PRODUCTION_WORKER_QUERY_TIMEOUT_MS
  + WATCH_PRODUCTION_GUEST_FINALIZER_TIMEOUT_MS
  + WATCH_PRODUCTION_SHARD_COLLECTION_TIMEOUT_MS
  + deriveWatchProductionFinalEvidenceBudgetMs()
);

function cellHardWatchdogMs(cell) {
  const seconds = Number(cell?.cellHardWatchdogSeconds);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error('formal Watch timeout derivation requires a positive cellHardWatchdogSeconds');
  }
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error('formal Watch cell hard watchdog exceeds the safe millisecond range');
  }
  return milliseconds;
}

function formalCells(cells, label) {
  if (!Array.isArray(cells) || cells.length <= 0) {
    throw new Error(`${label} requires a non-empty cells array`);
  }
  return cells;
}

export function deriveWatchRunnerInternalDeadlineMs(cell) {
  return (
    Math.max(WATCH_RUNNER_READINESS_TIMEOUT_MS, cellHardWatchdogMs(cell))
    + WATCH_REPORT_RECEIPT_GRACE_MS
    + WATCH_RUNNER_SCHEDULING_ENVELOPE_MS
  );
}

export function deriveWatchShardWorkerTimeoutMs(cell) {
  return (
    WATCH_SHARD_PRE_DESKTOP_ENVELOPE_MS
    + deriveWatchRunnerInternalDeadlineMs(cell)
    + WATCH_SHARD_POST_REPORT_ENVELOPE_MS
    + WATCH_SHARD_PROCESS_TERMINATION_GRACE_MS
  );
}

export function deriveWatchShardPreExecutionBudgetMs() {
  return (
    WATCH_SHARD_AUTHORITY_FILE_COUNT * WATCH_SHARD_AUTHORITY_FILE_WAIT_TIMEOUT_MS
    + WATCH_SHARD_PROCESS_IDENTITY_TIMEOUT_MS
  );
}

export function deriveWatchShardExecutionSettlementBudgetMs(cell) {
  return deriveWatchShardWorkerTimeoutMs(cell) + WATCH_SHARD_PROCESS_KILL_TIMEOUT_MS;
}

export function deriveWatchProductionInteractiveCellTimeoutMs(cell) {
  return (
    deriveWatchShardPreExecutionBudgetMs()
    + deriveWatchShardExecutionSettlementBudgetMs(cell)
    + WATCH_REMOTE_INTERACTIVE_LAUNCH_ENVELOPE_MS
  );
}

export function deriveWatchProductionRemoteCellTimeoutMs(cell) {
  return (
    deriveWatchProductionInteractiveCellTimeoutMs(cell)
    + WATCH_REMOTE_COMMAND_COMPLETION_GRACE_MS
  );
}

export function deriveWatchProductionCellExecutionBudgetMs(cell) {
  return (
    WATCH_PRODUCTION_CELL_LEASE_UPLOAD_TIMEOUT_MS
    + deriveWatchProductionRemoteCellTimeoutMs(cell)
    + WATCH_PRODUCTION_CELL_DOWNLOAD_TIMEOUT_MS
  );
}

export function deriveWatchProductionRuntimeVerificationRetryBudgetMs() {
  return (
    WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_ATTEMPTS
      * WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_TIMEOUT_MS
    + (WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_ATTEMPTS - 1)
      * WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_RETRY_DELAY_MS
  );
}

function workerReadinessUploadBudgetMs({
  implementationUploadCount,
  runtimeUploadCount,
  uploadTimeoutMs,
}) {
  for (const [label, value] of [
    ['implementation upload count', implementationUploadCount],
    ['runtime upload count', runtimeUploadCount],
    ['upload timeout', uploadTimeoutMs],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`worker readiness ${label} must be a non-negative safe integer`);
    }
  }
  // prepareWorker always uploads its plan. A fresh worker then uploads every
  // signed implementation/runtime entry serially before runtime verification.
  return (1 + implementationUploadCount + runtimeUploadCount) * uploadTimeoutMs;
}

export function deriveWatchProductionInitialWorkerReadinessBudgetMs({
  implementationUploadCount = WATCH_PRODUCTION_INITIAL_IMPLEMENTATION_UPLOAD_COUNT,
  runtimeUploadCount = WATCH_PRODUCTION_INITIAL_RUNTIME_UPLOAD_COUNT,
  uploadTimeoutMs = WATCH_PRODUCTION_REMOTE_COMMAND_TIMEOUT_MS,
} = {}) {
  return (
    2 * WATCH_PRODUCTION_WORKER_QUERY_TIMEOUT_MS
    + 2 * WATCH_PRODUCTION_REMOTE_COMMAND_TIMEOUT_MS
    + workerReadinessUploadBudgetMs({
      implementationUploadCount,
      runtimeUploadCount,
      uploadTimeoutMs,
    })
    + deriveWatchProductionRuntimeVerificationRetryBudgetMs()
    + WATCH_PRODUCTION_ZERO_PROVIDER_READINESS_TIMEOUT_MS
    + WATCH_PRODUCTION_ENDPOINT_READINESS_REMOTE_TIMEOUT_MS
    + WATCH_PRODUCTION_REMOTE_READINESS_FINALIZATION_TIMEOUT_MS
    + WATCH_PRODUCTION_COORDINATOR_STAGE_SETTLEMENT_ENVELOPE_MS
  );
}

export function deriveWatchProductionPreservedWorkerReadinessBudgetMs({
  uploadTimeoutMs = WATCH_PRODUCTION_REMOTE_COMMAND_TIMEOUT_MS,
} = {}) {
  return (
    2 * WATCH_PRODUCTION_WORKER_QUERY_TIMEOUT_MS
    + WATCH_PRODUCTION_REMOTE_COMMAND_TIMEOUT_MS
    + workerReadinessUploadBudgetMs({
      implementationUploadCount: 0,
      runtimeUploadCount: 0,
      uploadTimeoutMs,
    })
    + deriveWatchProductionRuntimeVerificationRetryBudgetMs()
    + WATCH_PRODUCTION_PRESERVED_READINESS_TIMEOUT_MS
    + WATCH_PRODUCTION_COORDINATOR_STAGE_SETTLEMENT_ENVELOPE_MS
  );
}

export function deriveWatchProductionNetworkHealthBudgetMs() {
  return (
    WATCH_PRODUCTION_PROVIDER_NETWORK_DNS_TIMEOUT_MS
    + PROVIDER_NETWORK_HEALTH_SAMPLE_COUNT * PROVIDER_NETWORK_HEALTH_TIMEOUT_MS
    + WATCH_PRODUCTION_PROVIDER_CONNECTION_INVENTORY_TIMEOUT_MS
    + PROVIDER_NETWORK_HEALTH_TIMEOUT_MS
    + WATCH_PRODUCTION_COORDINATOR_STAGE_SETTLEMENT_ENVELOPE_MS
  );
}

export function deriveWatchProductionProviderPreflightBudgetMs() {
  return (
    WATCH_PRODUCTION_PROVIDER_PREFLIGHT_AUTHORITY_TIMEOUT_MS
    + PROVIDER_PREFLIGHT_EMITTER_TIMEOUT_MS
    + PROVIDER_PREFLIGHT_EXIT_GRACE_MS
    + PROVIDER_PREFLIGHT_CLOSE_GRACE_MS
    + PROVIDER_PREFLIGHT_CLEANUP_TIMEOUT_MS
    + WATCH_PRODUCTION_COORDINATOR_STAGE_SETTLEMENT_ENVELOPE_MS
  );
}

export function deriveWatchProductionCoordinatorPreparationBudgetMs({
  workerCount = 1,
} = {}) {
  if (!Number.isSafeInteger(workerCount) || workerCount <= 0) {
    throw new Error('coordinator preparation budget requires a positive workerCount');
  }
  return (
    WATCH_PRODUCTION_RUNTIME_AUTHORITY_VERIFICATION_TIMEOUT_MS
    + 3 * WATCH_PRODUCTION_PROVENANCE_CAPTURE_TIMEOUT_MS
    + 2 * WATCH_PRODUCTION_AUTHORITY_INVENTORY_CAPTURE_TIMEOUT_MS
    + workerCount * deriveWatchProductionInitialWorkerReadinessBudgetMs()
    + WATCH_PRODUCTION_LOCAL_ISOLATION_VERIFICATION_TIMEOUT_MS
    + deriveWatchProductionNetworkHealthBudgetMs()
    + deriveWatchProductionProviderPreflightBudgetMs()
    + WATCH_PRODUCTION_COORDINATOR_PUBLICATION_ENVELOPE_MS
  );
}

export function deriveWatchProductionPrepaidCoordinatorBudgetMs({
  workerCount = 1,
} = {}) {
  return (
    WATCH_PRODUCTION_RUNTIME_AUTHORITY_VERIFICATION_TIMEOUT_MS
    + deriveWatchProductionCoordinatorPreparationBudgetMs({ workerCount })
  );
}

export function deriveWatchPostReadinessExecutionBudgetMs({
  cells = LIVE_LLM_CELLS,
  workerCount = 1,
} = {}) {
  if (!Number.isSafeInteger(workerCount) || workerCount <= 0) {
    throw new Error('post-readiness execution budget requires a positive workerCount');
  }
  return (
    workerCount * deriveWatchProductionPreservedWorkerReadinessBudgetMs()
    + formalCells(cells, 'post-readiness execution budget')
      .reduce((total, cell) => total + deriveWatchProductionCellExecutionBudgetMs(cell), 0)
    + WATCH_PRODUCTION_POST_PREFLIGHT_EVIDENCE_MARGIN_MS
  );
}

export function deriveWatchProductionCoordinatorTimeoutMs({
  cells = LIVE_LLM_CELLS,
  workerCount = 1,
} = {}) {
  return (
    deriveWatchProductionPrepaidCoordinatorBudgetMs({ workerCount })
    + deriveWatchPostReadinessExecutionBudgetMs({
      cells: formalCells(cells, 'production coordinator timeout'),
      workerCount,
    })
  );
}
