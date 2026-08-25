import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStartupReadinessReport, STARTUP_COLLECTION_SCHEMA } from './startup-readiness-report.mjs';

function collection(overrides = {}) {
  return {
    schemaVersion: STARTUP_COLLECTION_SCHEMA,
    runId: 'startup-test',
    dryRun: false,
    preflightFailure: null,
    command: 'tauri dev',
    launchStartedAt: '2026-08-24T00:00:00.000Z',
    timeoutSeconds: 120,
    thresholds: {
      maxWindowToReadyMs: 10000,
      maxWindowToFrontendMountMs: 1000,
      maxFrontendBootstrapMs: 8500,
      maxReadySignalToNativeLogMs: 500,
    },
    devServer: { mode: 'existing', port: 4173, listeners: [] },
    poll: { windowPollMs: 100, logPollMs: 250 },
    window: { detected: true, detectedElapsedMs: 500 },
    readiness: {
      detected: true,
      detectedElapsedMs: 2000,
      frontend: {
        appMountedAtEpochMs: Date.parse('2026-08-24T00:00:00.700Z'),
        readySignalAtEpochMs: Date.parse('2026-08-24T00:00:01.900Z'),
        readyAfterAppMountMs: 1200,
        steps: { 'detect-runtime': { activeAtMs: 0, doneAtMs: 50 } },
      },
    },
    fullReadinessRaw: null,
    process: { exitedBeforeReady: false },
    artifacts: {},
    ...overrides,
  };
}

test('Node is the startup verdict authority and derives timing from raw collection', () => {
  const report = buildStartupReadinessReport(collection());
  assert.equal(report.verdict, 'passed');
  assert.equal(report.readiness.windowToReadyMs, 1400);
  assert.equal(report.phases.windowToFrontendMountMs, 200);
  assert.equal(report.phases.frontendMountToReadySignalMs, 1200);
  assert.equal(report.phases.readySignalToNativeLogMs, 100);
});

test('Node rejects threshold and preflight failures without a PowerShell verdict field', () => {
  const slow = buildStartupReadinessReport(collection({
    readiness: { detected: true, detectedElapsedMs: 12000, frontend: null },
  }));
  assert.equal(slow.verdict, 'readiness-threshold-failed');

  const preflight = buildStartupReadinessReport(collection({
    preflightFailure: { code: 'dev-port-in-use', message: 'port occupied' },
    window: { detected: false, detectedElapsedMs: null },
    readiness: { detected: false, detectedElapsedMs: null, frontend: null },
  }));
  assert.equal(preflight.verdict, 'dev-port-in-use');
  assert.equal(preflight.failure.summary, 'port occupied');
});

test('old startup report objects are not accepted as collections', () => {
  assert.throws(() => buildStartupReadinessReport({ schemaVersion: 1, verdict: 'passed' }), /unsupported startup collection schema/);
});
