import {
  RELEASE_MAX_CELL_HARD_WATCHDOG_SECONDS,
} from './watch-mode-balanced-release-plan.mjs';

export const WATCH_RELEASE_CELL_COUNT = 4;

export const WATCH_RUNNER_READINESS_TIMEOUT_MS = 90_000;
export const WATCH_CELL_HARD_WATCHDOG_MS = RELEASE_MAX_CELL_HARD_WATCHDOG_SECONDS * 1_000;
export const WATCH_REPORT_RECEIPT_GRACE_MS = 30_000;
export const WATCH_RUNNER_SCHEDULING_ENVELOPE_MS = 20_000;
export const WATCH_RUNNER_INTERNAL_DEADLINE_MS = (
  WATCH_RUNNER_READINESS_TIMEOUT_MS
  + WATCH_CELL_HARD_WATCHDOG_MS
  + WATCH_REPORT_RECEIPT_GRACE_MS
  + WATCH_RUNNER_SCHEDULING_ENVELOPE_MS
);

// The PowerShell runner performs device/driver/Bridge preflight before the
// Desktop launch timestamp that owns WATCH_RUNNER_INTERNAL_DEADLINE_MS, then
// saves content evidence and tears down owned processes after report receipt.
export const WATCH_SHARD_PRE_DESKTOP_ENVELOPE_MS = 90_000;
export const WATCH_SHARD_POST_REPORT_ENVELOPE_MS = 60_000;
export const WATCH_SHARD_PROCESS_TERMINATION_GRACE_MS = 8_000;
export const WATCH_SHARD_WORKER_TIMEOUT_MS = (
  WATCH_SHARD_PRE_DESKTOP_ENVELOPE_MS
  + WATCH_RUNNER_INTERNAL_DEADLINE_MS
  + WATCH_SHARD_POST_REPORT_ENVELOPE_MS
  + WATCH_SHARD_PROCESS_TERMINATION_GRACE_MS
);

export const WATCH_REMOTE_DISPATCH_AND_RECEIPT_ENVELOPE_MS = 42_000;
export const WATCH_PRODUCTION_REMOTE_CELL_TIMEOUT_MS = (
  WATCH_SHARD_WORKER_TIMEOUT_MS
  + WATCH_REMOTE_DISPATCH_AND_RECEIPT_ENVELOPE_MS
);

export const WATCH_PRODUCTION_CELL_DOWNLOAD_TIMEOUT_MS = 300_000;
export const WATCH_PRODUCTION_ZERO_PROVIDER_READINESS_TIMEOUT_MS = 10 * 60_000;
export const WATCH_PRODUCTION_POST_PREFLIGHT_EVIDENCE_MARGIN_MS = 15 * 60_000;

export function deriveWatchProductionCoordinatorTimeoutMs({
  cellCount = WATCH_RELEASE_CELL_COUNT,
} = {}) {
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0) {
    throw new Error('production coordinator timeout requires a positive cellCount');
  }
  return (
    WATCH_PRODUCTION_ZERO_PROVIDER_READINESS_TIMEOUT_MS
    + cellCount * (
      WATCH_PRODUCTION_REMOTE_CELL_TIMEOUT_MS
      + WATCH_PRODUCTION_CELL_DOWNLOAD_TIMEOUT_MS
    )
    + WATCH_PRODUCTION_POST_PREFLIGHT_EVIDENCE_MARGIN_MS
  );
}

export function deriveWatchPostReadinessExecutionBudgetMs({
  cellCount = WATCH_RELEASE_CELL_COUNT,
} = {}) {
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0) {
    throw new Error('post-readiness execution budget requires a positive cellCount');
  }
  return (
    cellCount * (
      WATCH_PRODUCTION_REMOTE_CELL_TIMEOUT_MS
      + WATCH_PRODUCTION_CELL_DOWNLOAD_TIMEOUT_MS
    )
    + WATCH_PRODUCTION_POST_PREFLIGHT_EVIDENCE_MARGIN_MS
  );
}
