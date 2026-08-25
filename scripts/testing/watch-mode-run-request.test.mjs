import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPowerShellArguments } from './run-watch-mode-live.mjs';
import { validateWatchModeRunRequest } from './watch-mode-run-request.mjs';

function request(overrides = {}) {
  return {
    schemaVersion: 'watch-mode-run-request/v1',
    runMode: 'live',
    authorityMode: 'none',
    feedbackMode: 'echo-cancel',
    desktop: { launchMode: 'managed', elevation: 'forbid' },
    driverPolicy: 'not-applicable',
    physicalContentMode: 'remote-stt',
    model: { id: 'model', protocol: 'dashscope-omni', subtitleTranslationMode: 'native' },
    media: { path: 'fixture.wav', playbackSeconds: 180 },
    physicalDevice: { id: 'default', class: 'default-speaker', profileId: 'speaker' },
    timeouts: { warmupSeconds: 12, readinessSeconds: 90, sessionSeconds: 180, postPlaybackSeconds: 120 },
    paths: { outputRoot: 'artifacts/out', runtimeRoot: 'artifacts/logs' },
    ...overrides,
  };
}

test('run request rejects invalid cross-field combinations at one boundary', () => {
  assert.throws(
    () => validateWatchModeRunRequest(request({ historicalCompatibility: true })),
    /unknown fields: historicalCompatibility/,
  );
  assert.throws(
    () => validateWatchModeRunRequest(request({ feedbackMode: 'virtual-driver' })),
    /requires driverPolicy/,
  );
  assert.throws(
    () => validateWatchModeRunRequest(request({
      authorityMode: 'strict-paid',
      physicalContentMode: 'remote-stt',
    })),
    /live \+ managed \+ native \+ local-canonical/,
  );
  assert.throws(
    () => validateWatchModeRunRequest(request({
      runMode: 'content-recovery',
    })),
    /runMode must be one of/,
  );
  assert.throws(
    () => validateWatchModeRunRequest(request({
      paths: { ...request().paths, recoveryRunDirectory: 'historical-run' },
    })),
    /paths has unknown fields: recoveryRunDirectory/,
  );
});

test('validated request reaches the private PowerShell runner as one path only', () => {
  validateWatchModeRunRequest(request());
  const args = buildPowerShellArguments('request.json');
  assert.equal(args.at(-2), '-RequestPath');
  assert.match(args.at(-1), /request\.json$/);
  assert.equal(args.filter((value) => value.startsWith('-')).length, 4);
});
