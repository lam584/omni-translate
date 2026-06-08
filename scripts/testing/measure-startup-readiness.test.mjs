import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectStartupReadinessIssues,
  DEFAULT_MAX_WINDOW_TO_READY_MS,
  DEFAULT_STARTUP_PHASE_THRESHOLDS,
} from './verify-startup-readiness.mjs';

function basePassingReport(overrides = {}) {
  return {
    thresholds: {
      ...DEFAULT_STARTUP_PHASE_THRESHOLDS,
    },
    window: {
      detected: true,
    },
    readiness: {
      detected: true,
      windowToReadyMs: 9700,
      frontend: {
        steps: {
          'detect-runtime': { activeAtMs: 0, doneAtMs: 50 },
          'check-ipc': { activeAtMs: 50, doneAtMs: 250 },
          'init-runtime': { activeAtMs: 250, doneAtMs: 650 },
          'init-audio': { activeAtMs: 650, doneAtMs: 1900 },
          'load-config': { activeAtMs: 1900, doneAtMs: 7900 },
        },
      },
    },
    phases: {
      windowToFrontendMountMs: 800,
      frontendMountToReadySignalMs: 8400,
      readySignalToNativeLogMs: 500,
    },
    frontendStepDurationsMs: {
      'detect-runtime': 50,
      'check-ipc': 200,
      'init-runtime': 400,
      'init-audio': 1250,
      'load-config': 2400,
      'bootstrap-overlay-delay': 0,
    },
    devCommandMetrics: {
      viteReadyMs: 1200,
      cargoBuildMs: null,
      commandToWindowMs: 800,
      commandToReadyMs: 9700,
      commandToFullReadyMs: 3200,
      windowToFullReadyMs: 2400,
      routeLoadMs: 900,
      stylesLoadMs: 1100,
      bridgeConvergeMs: 2400,
    },
    fullReadiness: {
      routeReady: { detected: true, elapsedMs: 900 },
      stylesReady: { detected: true, elapsedMs: 1100 },
      bridgeConverged: { detected: true, elapsedMs: 2400, convergence: '' },
      fullReady: { detected: true, elapsedMs: 3200 },
    },
    devServer: {
      mode: 'managed-critical-warmup',
      warmup: { requestCount: 7, elapsedMs: 350, mode: 'critical', timeoutMs: 1200 },
    },
    ...overrides,
  };
}

test('startup readiness threshold is capped at 10 seconds and split across phases', () => {
  assert.equal(DEFAULT_MAX_WINDOW_TO_READY_MS, 10000);
  assert.equal(DEFAULT_STARTUP_PHASE_THRESHOLDS.maxWindowToFrontendMountMs, 1000);
  assert.equal(DEFAULT_STARTUP_PHASE_THRESHOLDS.maxFrontendBootstrapMs, 8500);
  assert.equal(DEFAULT_STARTUP_PHASE_THRESHOLDS.maxReadySignalToNativeLogMs, 500);
  assert.equal(
    DEFAULT_STARTUP_PHASE_THRESHOLDS.maxWindowToFrontendMountMs
    + DEFAULT_STARTUP_PHASE_THRESHOLDS.maxFrontendBootstrapMs
    + DEFAULT_STARTUP_PHASE_THRESHOLDS.maxReadySignalToNativeLogMs,
    DEFAULT_MAX_WINDOW_TO_READY_MS,
  );
  assert.deepEqual(collectStartupReadinessIssues(basePassingReport()), []);
});

test('startup readiness fails when window-to-ready exceeds 10 seconds', () => {
  const report = basePassingReport({
    readiness: {
      detected: true,
      windowToReadyMs: 10001,
      frontend: { steps: {} },
    },
  });

  assert.match(
    collectStartupReadinessIssues(report).join('\n'),
    /exceeds 10000ms/,
  );
});

test('startup readiness fails when a split phase exceeds its budget', () => {
  const report = basePassingReport({
    phases: {
      windowToFrontendMountMs: 1200,
      frontendMountToReadySignalMs: 8400,
      readySignalToNativeLogMs: 100,
    },
  });

  assert.match(
    collectStartupReadinessIssues(report).join('\n'),
    /windowToFrontendMountMs 1200ms exceeds 1000ms/,
  );
});

test('startup readiness fails when a frontend step exceeds its budget', () => {
  const report = basePassingReport({
    frontendStepDurationsMs: {
      'detect-runtime': 50,
      'check-ipc': 1200,
      'init-runtime': 400,
      'init-audio': 1250,
      'load-config': 2400,
      'bootstrap-overlay-delay': 0,
    },
  });

  assert.match(
    collectStartupReadinessIssues(report).join('\n'),
    /check-ipc.*1200ms exceeds 1000ms/,
  );
});

test('startup readiness fails when bootstrap finishes through an error step', () => {
  const report = basePassingReport({
    readiness: {
      detected: true,
      windowToReadyMs: 8474,
      frontend: {
        steps: {
          'check-ipc': {
            errorAtMs: 8072,
            detail: 'IPC \u901a\u9053\u672a\u54cd\u5e94',
          },
        },
      },
    },
  });

  assert.match(
    collectStartupReadinessIssues(report).join('\n'),
    /check-ipc.*error/,
  );
});

test('fullReadiness passes when all markers are present and in correct order', () => {
  const report = basePassingReport();
  assert.deepEqual(collectStartupReadinessIssues(report), []);
});

test('fullReadiness is ignored for readiness verdict when fullReady not detected', () => {
  const report = basePassingReport({
    fullReadiness: {
      routeReady: { detected: true, elapsedMs: 900 },
      stylesReady: { detected: true, elapsedMs: 1100 },
      bridgeConverged: { detected: true, elapsedMs: 2400, convergence: '' },
      fullReady: { detected: false, elapsedMs: null },
    },
  });
  // Full-ready not detected should not cause the readiness verdict to fail by itself
  // (readiness already passed via regular marker)
  assert.match(
    collectStartupReadinessIssues(report).join('\n') || 'no issues',
    /no issues/,
  );
});

test('critical warmup respects the 1200ms cap', () => {
  const report = basePassingReport({
    devServer: {
      mode: 'managed-critical-warmup',
      warmup: { requestCount: 5, elapsedMs: 850, mode: 'critical', timeoutMs: 1200 },
    },
  });
  assert.deepEqual(collectStartupReadinessIssues(report), []);
});

test('critical warmup under cap with full coverage', () => {
  const report = basePassingReport({
    devServer: {
      mode: 'managed-critical-warmup',
      warmup: { requestCount: 7, elapsedMs: 1199, mode: 'critical', timeoutMs: 1200 },
    },
  });
  assert.deepEqual(collectStartupReadinessIssues(report), []);
});

test('commandToFullReadyMs is within 3500ms when binary fresh', () => {
  const report = basePassingReport({
    devCommandMetrics: {
      ...basePassingReport().devCommandMetrics,
      commandToFullReadyMs: 3200,
      cargoBuildMs: null,
    },
  });
  assert.deepEqual(collectStartupReadinessIssues(report), []);
});

test('windowToFullReadyMs is within 2500ms', () => {
  const report = basePassingReport({
    devCommandMetrics: {
      ...basePassingReport().devCommandMetrics,
      windowToFullReadyMs: 2400,
    },
  });
  assert.deepEqual(collectStartupReadinessIssues(report), []);
});

test('bridge convergence error is still recorded in fullReadiness', () => {
  const report = basePassingReport({
    fullReadiness: {
      routeReady: { detected: true, elapsedMs: 900 },
      stylesReady: { detected: true, elapsedMs: 1100 },
      bridgeConverged: { detected: true, elapsedMs: 3000, convergence: 'error' },
      fullReady: { detected: true, elapsedMs: 3500 },
    },
  });
  // Even with convergence=error, the marker was detected
  assert.deepEqual(collectStartupReadinessIssues(report), []);
});

test('full-ready marker fires after route/styles/bridge markers', () => {
  const report = basePassingReport({
    fullReadiness: {
      routeReady: { detected: true, elapsedMs: 900 },
      stylesReady: { detected: true, elapsedMs: 1100 },
      bridgeConverged: { detected: true, elapsedMs: 2400 },
      fullReady: { detected: true, elapsedMs: 2500 },
    },
    devCommandMetrics: {
      ...basePassingReport().devCommandMetrics,
      routeLoadMs: 900,
      stylesLoadMs: 1100,
      bridgeConvergeMs: 2400,
      commandToFullReadyMs: 2500,
    },
  });
  assert.deepEqual(collectStartupReadinessIssues(report), []);
});

test('direct debug exe path skips cargo build (cargoBuildMs is null)', () => {
  const report = basePassingReport({
    devCommandMetrics: {
      ...basePassingReport().devCommandMetrics,
      cargoBuildMs: null,
      commandToFullReadyMs: 3200,
    },
  });
  assert.deepEqual(collectStartupReadinessIssues(report), []);
});

test('post-cargo windowToFullReadyMs is within 2500ms when cargo is included', () => {
  const report = basePassingReport({
    devCommandMetrics: {
      ...basePassingReport().devCommandMetrics,
      cargoBuildMs: 45000,
      commandToFullReadyMs: 48300,
      commandToWindowMs: 42000,
      windowToFullReadyMs: 2400,
    },
  });
  assert.deepEqual(collectStartupReadinessIssues(report), []);
});
