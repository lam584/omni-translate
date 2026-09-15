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


test('strict request requires request-bound media-end authority and identities', () => {
  const base = request({
    authorityMode: 'strict-paid',
    physicalContentMode: 'local-canonical',
    model: {
      id: 'qwen3.5-livetranslate-flash-realtime',
      protocol: 'dashscope-livetranslate',
      subtitleTranslationMode: 'native',
    },
    media: {
      path: 'fixture.wav', playbackSeconds: 0, sha256: 'a'.repeat(64),
      authoritativeTransformedReferenceFrames: 2013045, inputSampleRateHz: 16000,
    },
    paths: {
      ...request().paths, inputComplete: 'out/input-complete.json',
      terminalAuthority: 'out/evidence-driven-terminal.json',
    },
    matrix: { cellId: 'c03', leaseId: 'lease-3', runMarker: 'watch_mode_diagnostic.run_id=abc' },
  });
  validateWatchModeRunRequest(base);
  for (const mutate of [
    (value) => { delete value.media.sha256; },
    (value) => { delete value.media.authoritativeTransformedReferenceFrames; },
    (value) => { delete value.media.inputSampleRateHz; },
    (value) => { delete value.matrix.runMarker; },
    (value) => { delete value.matrix.cellId; },
    (value) => { delete value.matrix.leaseId; },
  ]) {
    const candidate = structuredClone(base);
    mutate(candidate);
    assert.throws(() => validateWatchModeRunRequest(candidate), /strict-paid requires exact LiveTranslate identity/);
  }
});
