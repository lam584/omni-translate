import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  generateWatchModeLiveFixture,
  WATCH_MODE_LIVE_FIXTURE_FILES,
} from './generate-watch-mode-live-fixtures.mjs';
import { writeReport } from './watch-mode-report.mjs';

function makeTempDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runDryRun({ outputRoot, feedbackLoopPrevention = 'virtual-driver' }) {
  const request = JSON.parse(fs.readFileSync('scripts/testing/fixtures/watch-mode-run-request-dry-run.json', 'utf8'));
  request.feedbackMode = feedbackLoopPrevention;
  request.driverPolicy = feedbackLoopPrevention === 'virtual-driver' ? 'probe-only' : 'not-applicable';
  request.paths.outputRoot = outputRoot;
  const requestPath = path.join(outputRoot, '..', `${feedbackLoopPrevention}-request.json`);
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  fs.writeFileSync(requestPath, JSON.stringify(request));
  return spawnSync(process.execPath, [
    './scripts/testing/run-watch-mode-live.mjs',
    '--request',
    requestPath,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function onlyRunDirectory(outputRoot) {
  const entries = fs.readdirSync(outputRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.equal(entries.length, 1, `expected one run directory under ${outputRoot}`);
  return path.join(outputRoot, entries[0].name);
}

test('generator creates a deterministic pass fixture accepted by the report classifier', () => {
  const root = makeTempDirectory('omni-watch-fixture-generator-');
  try {
    const fixtureDirectory = generateWatchModeLiveFixture({ root });
    for (const file of WATCH_MODE_LIVE_FIXTURE_FILES) {
      assert.equal(fs.existsSync(path.join(fixtureDirectory, file)), true, `${file} must be generated`);
    }
    const collection = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'run-collection.json'), 'utf8'));
    assert.equal(collection.schemaVersion, 'watch-mode-run-collection/v2');
    assert.equal(collection.steps.length, 2);

    const { report } = writeReport({ inputDir: fixtureDirectory, outputDir: fixtureDirectory, mode: 'dry-run' });
    assert.equal(report.verdict, 'passed');
    assert.equal(report.feedbackLoopPrevention, 'virtual-driver');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run auto-generates pass fixture and records all feedback variants', {
  skip: process.platform !== 'win32' ? 'PowerShell runner is Windows-only' : false,
}, () => {
  const fixtureRoot = makeTempDirectory('omni-watch-fixture-runner-');
  const outputParent = path.join(process.cwd(), '.tmp', `watch-mode-live-test-${process.pid}-${Date.now()}`);
  try {
    for (const feedbackLoopPrevention of ['process-exclusion', 'virtual-driver', 'echo-cancel']) {
      const outputRoot = path.join(outputParent, feedbackLoopPrevention);
      const result = runDryRun({ outputRoot, feedbackLoopPrevention });
      assert.equal(result.status, 0, `${feedbackLoopPrevention} dry-run failed:\n${result.stdout}\n${result.stderr}`);

      const runDirectory = onlyRunDirectory(outputRoot);
      const report = JSON.parse(fs.readFileSync(path.join(runDirectory, 'report.json'), 'utf8').replace(/^\uFEFF/, ''));
      const injection = JSON.parse(fs.readFileSync(path.join(runDirectory, 'config-injection.json'), 'utf8').replace(/^\uFEFF/, ''));
      assert.equal(report.verdict, 'passed');
      assert.equal(report.feedbackLoopPrevention, feedbackLoopPrevention);
      assert.equal(injection.selectedFeedbackLoopPrevention, feedbackLoopPrevention);
      assert.deepEqual(
        injection.variants.map((variant) => variant.injected),
        ['process-exclusion', 'virtual-driver', 'echo-cancel'],
      );
      if (feedbackLoopPrevention === 'process-exclusion') {
        const collection = JSON.parse(fs.readFileSync(path.join(runDirectory, 'run-collection.json'), 'utf8').replace(/^\uFEFF/, ''));
        const snapshots = JSON.parse(fs.readFileSync(path.join(runDirectory, collection.artifacts.fixtureEvidence), 'utf8').replace(/^\uFEFF/, ''));
        assert.equal(snapshots.driver, null);
        assert.equal(snapshots.wasapi, null);
        assert.equal(snapshots.physicalOutput.probeKind, 'process-exclusion-fingerprint');
        assert.equal(snapshots.physicalOutput.fixtureOnly, true);
        assert.equal(snapshots.physicalOutput.processExclusionFingerprint.bridgeProcessId, 4242);
        assert.equal(
          snapshots.physicalOutput.processExclusionFingerprint.bridgeChildParentProcessId,
          snapshots.physicalOutput.processExclusionFingerprint.bridgeProcessId,
        );
        assert.equal(snapshots.bridge.sourceCaptureMode, 'process-exclusion');
        assert.equal(snapshots.bridge.captureBackend, 'wasapi-process-exclusion');
        assert.equal(snapshots.bridge.processLoopbackSupported, true);
        assert.equal(snapshots.bridge.processLoopbackStatus, 'ready');
        assert.ok(snapshots.bridge.windowsBuildNumber >= snapshots.bridge.processLoopbackMinimumWindowsBuild);
        assert.ok(snapshots.bridge.excludedProcessId > 0);
        assert.equal(snapshots.bridge.sourceReadCalls, 0);
        assert.equal(snapshots.bridge.sourceFramePayloadBytes, 0);
        for (const layer of ['driver', 'wasapi', 'aec']) {
          assert.equal(report.layers[layer].status, 'skipped');
        }
        assert.equal(report.layers.physicalOutput.status, 'passed');
      }
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(outputParent, { recursive: true, force: true });
  }
});

test('fixture generator rejects unknown fixture identities', () => {
  const fixtureRoot = makeTempDirectory('omni-watch-fixture-custom-');
  try {
    assert.throws(
      () => generateWatchModeLiveFixture({ root: fixtureRoot, fixture: 'custom-local' }),
      /Only the built-in 'pass' fixture/,
    );
    assert.equal(fs.existsSync(path.join(fixtureRoot, 'custom-local')), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
