import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repoRoot } from '../lib/testing-common.mjs';
import {
  DEFAULT_FEEDBACK_MODES,
  DEFAULT_MODELS,
  LIVE_RUNNER_TERMINATION_GRACE_MS,
  LIVE_RUNNER_TIMEOUT_MS,
  MATRIX_DEFAULTS,
  buildRunnerArgv,
  buildVerifyArgv,
  lastNonEmptyLine,
  lastRunDirectoryLine,
  parseMatrixCliArgs,
  resolveMatrixLists,
  resolveWatchRealtimeProtocol,
  splitRunnerArgs,
} from './run-watch-mode-live-matrix.mjs';

const SAMPLE_MODEL = 'qwen3.5-omni-flash-realtime';
const SAMPLE_FEEDBACK_MODE = 'echo-cancel';

// Guard order matches the runner switch forwarding the retired matrix .ps1 used.
const RUNNER_SWITCHES = [
  'SkipDesktopLaunch',
  'SkipDriverRepair',
  'AllowDriverRepair',
  'UseDefaultEndpointPlayback',
  'StopDesktopAfterPlayback',
  'AllowElevatedDesktopLaunch',
  'SkipPhysicalOutputContentStt',
];

test('matrix defaults freeze the strict-evidence contract', () => {
  assert.deepEqual(DEFAULT_MODELS, ['qwen3.5-omni-flash-realtime', 'qwen3.5-livetranslate-flash-realtime']);
  assert.deepEqual(DEFAULT_FEEDBACK_MODES, ['virtual-driver', 'echo-cancel']);
  assert.deepEqual(MATRIX_DEFAULTS, {
    outputRoot: 'artifacts/testing/watch-mode-live',
    mediaPath: 'scripts/testing/fixtures/watch-mode-en-original.wav',
    warmupSeconds: 12,
    playbackSeconds: 0,
    postPlaybackWaitSeconds: 120,
    sessionReadyTimeoutSeconds: 90,
    watchAutoStopAfterSeconds: 60,
    physicalPlaybackDeviceId: 'default',
    expectedPhysicalPlaybackDeviceName: '',
  });
});

test('each live runner has an absolute budget below two minutes', () => {
  assert.equal(LIVE_RUNNER_TIMEOUT_MS, 110_000);
  assert.equal(LIVE_RUNNER_TERMINATION_GRACE_MS, 5_000);
  assert.ok(
    LIVE_RUNNER_TIMEOUT_MS + LIVE_RUNNER_TERMINATION_GRACE_MS < 120_000,
    'runner timeout plus forced-termination grace must remain below two minutes',
  );
  assert.ok(MATRIX_DEFAULTS.watchAutoStopAfterSeconds <= 60);
});

test('sample pair argv binds every always-forwarded runner parameter', () => {
  const argv = buildRunnerArgv({ model: SAMPLE_MODEL, feedbackMode: SAMPLE_FEEDBACK_MODE });

  assert.deepEqual(argv, [
    '-OutputRoot', 'artifacts/testing/watch-mode-live',
    '-MediaPath', 'scripts/testing/fixtures/watch-mode-en-original.wav',
    '-WarmupSeconds', '12',
    '-WatchModelId', 'qwen3.5-omni-flash-realtime',
    '-PlaybackSeconds', '0',
    '-PostPlaybackWaitSeconds', '120',
    '-SessionReadyTimeoutSeconds', '90',
    '-WatchAutoStopAfterSeconds', '60',
    '-PhysicalPlaybackDeviceId', 'default',
    '-FeedbackLoopPrevention', 'echo-cancel',
    '-ExpectedPhysicalPlaybackDeviceName', '',
  ]);
});

test('every forwarded parameter exists in the live runner param block', () => {
  const runnerSource = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'testing', 'run-watch-mode-live.ps1'),
    'utf8',
  );
  assert.ok(runnerSource.startsWith('param('), 'runner must open with its param block');
  const paramBlock = runnerSource.slice(0, runnerSource.search(/^\)/m));
  const argv = buildRunnerArgv({
    model: SAMPLE_MODEL,
    feedbackMode: SAMPLE_FEEDBACK_MODE,
    skipDesktopLaunch: true,
    skipDriverRepair: true,
    allowDriverRepair: true,
    useDefaultEndpointPlayback: true,
    stopDesktopAfterPlayback: true,
    allowElevatedDesktopLaunch: true,
    skipPhysicalOutputContentStt: true,
  });
  for (const entry of argv) {
    if (!entry.startsWith('-')) {
      continue;
    }
    assert.match(
      paramBlock,
      new RegExp(`\\$${entry.slice(1)}\\b`),
      `run-watch-mode-live.ps1 must declare the ${entry} parameter`,
    );
  }
});

test('switch parameters are appended bare, only when enabled, in guard order', () => {
  const allOn = buildRunnerArgv({
    model: SAMPLE_MODEL,
    feedbackMode: SAMPLE_FEEDBACK_MODE,
    skipDesktopLaunch: true,
    skipDriverRepair: true,
    allowDriverRepair: true,
    useDefaultEndpointPlayback: true,
    stopDesktopAfterPlayback: true,
    allowElevatedDesktopLaunch: true,
    skipPhysicalOutputContentStt: true,
  });
  assert.deepEqual(allOn.slice(22), RUNNER_SWITCHES.map((name) => `-${name}`));

  const allOff = buildRunnerArgv({ model: SAMPLE_MODEL, feedbackMode: SAMPLE_FEEDBACK_MODE });
  for (const name of RUNNER_SWITCHES) {
    assert.equal(allOff.includes(`-${name}`), false);
  }
});

test('runner passthrough args are appended verbatim after the splat', () => {
  const argv = buildRunnerArgv({
    model: SAMPLE_MODEL,
    feedbackMode: SAMPLE_FEEDBACK_MODE,
    allowElevatedDesktopLaunch: true,
    runnerArgs: ['-DryRun', '-Fixture', 'pass', 'value with spaces'],
  });
  assert.deepEqual(argv.slice(-5), ['-AllowElevatedDesktopLaunch', '-DryRun', '-Fixture', 'pass', 'value with spaces']);
});

test('keyword-free live aliases carry an explicit protocol into config preparation', () => {
  const argv = buildRunnerArgv({
    model: 'deployment-blue',
    feedbackMode: SAMPLE_FEEDBACK_MODE,
    watchRealtimeProtocol: 'dashscope-omni',
  });
  assert.deepEqual(argv.slice(-2), ['-WatchRealtimeProtocol', 'dashscope-omni']);
});

test('known Watch models always bind their provider protocol instead of relying on provider order', () => {
  assert.equal(resolveWatchRealtimeProtocol('qwen3.5-omni-plus-realtime'), 'dashscope-omni');
  assert.equal(resolveWatchRealtimeProtocol('qwen3.5-omni-flash-realtime'), 'dashscope-omni');
  assert.equal(
    resolveWatchRealtimeProtocol('qwen3.5-livetranslate-flash-realtime'),
    'dashscope-livetranslate',
  );
  assert.equal(resolveWatchRealtimeProtocol('deployment-blue', 'deployment-blue', 'gemini-live'), 'gemini-live');
  assert.equal(resolveWatchRealtimeProtocol('unknown-model'), '');
});

test('splitRunnerArgs forwards everything after the first literal -- separator', () => {
  assert.deepEqual(splitRunnerArgs(['--warmup-seconds', '30']), {
    matrixArgv: ['--warmup-seconds', '30'],
    runnerArgs: [],
  });
  assert.deepEqual(splitRunnerArgs(['--warmup-seconds', '30', '--', '-DryRun', '--', '-Extra']), {
    matrixArgv: ['--warmup-seconds', '30'],
    runnerArgs: ['-DryRun', '--', '-Extra'],
  });
});

test('parseMatrixCliArgs maps kebab-case flags, coerces integers, and collects runner args', () => {
  const defaults = parseMatrixCliArgs([]);
  assert.equal(defaults.models, DEFAULT_MODELS.join(','));
  assert.equal(defaults.aliasProtocol, 'dashscope-omni');
  assert.equal(defaults.feedbackLoopPreventionModes, DEFAULT_FEEDBACK_MODES.join(','));
  assert.equal(defaults.outputRoot, MATRIX_DEFAULTS.outputRoot);
  assert.equal(defaults.warmupSeconds, 12);
  assert.equal(defaults.watchAutoStopAfterSeconds, 60);
  assert.deepEqual(defaults.runnerArgs, []);

  const parsed = parseMatrixCliArgs([
    '--models', 'model-a,model-b',
    '--feedback-loop-prevention-modes', 'virtual-driver',
    '--warmup-seconds', '30',
    '--skip-driver-repair',
    '--allow-elevated-desktop-launch',
    '--expected-physical-playback-device-name', 'Speakers',
    '--', '-DryRun', '-Fixture', 'pass',
  ]);
  assert.equal(parsed.models, 'model-a,model-b');
  assert.equal(parsed.feedbackLoopPreventionModes, 'virtual-driver');
  assert.equal(parsed.warmupSeconds, 30);
  assert.equal(parsed.skipDriverRepair, true);
  assert.equal(parsed.allowElevatedDesktopLaunch, true);
  assert.equal(parsed.expectedPhysicalPlaybackDeviceName, 'Speakers');
  assert.deepEqual(parsed.runnerArgs, ['-DryRun', '-Fixture', 'pass']);

  assert.throws(() => parseMatrixCliArgs(['--warmup-seconds', 'soon']), /--warmup-seconds must be an integer/);
  assert.throws(
    () => parseMatrixCliArgs(['--watch-auto-stop-after-seconds', '101']),
    /must be between 1 and 100/,
  );
  assert.throws(() => parseMatrixCliArgs(['--unknown-flag', 'x']), /Unknown flag --unknown-flag/);
});

test('resolveMatrixLists enforces the matrix validation errors', () => {
  assert.deepEqual(
    resolveMatrixLists({ models: DEFAULT_MODELS.join(','), feedbackLoopPreventionModes: 'virtual-driver,echo-cancel' }),
    { modelList: DEFAULT_MODELS, feedbackModeList: ['virtual-driver', 'echo-cancel'] },
  );
  assert.throws(
    () => resolveMatrixLists({ models: ' , ', feedbackLoopPreventionModes: 'virtual-driver' }),
    /At least one Watch Mode model must be provided\./,
  );
  assert.throws(
    () => resolveMatrixLists({ models: 'model-a', feedbackLoopPreventionModes: '' }),
    /At least one feedback loop prevention mode must be provided\./,
  );
  assert.throws(
    () => resolveMatrixLists({ models: 'model-a', feedbackLoopPreventionModes: 'virtual-driver,noise-gate' }),
    /Unsupported feedback loop prevention mode: noise-gate/,
  );
});

test('verify invocation targets the strict evidence checker', () => {
  assert.deepEqual(
    buildVerifyArgv('artifacts/testing/watch-mode-live', ['model-a', 'model-b'], ['virtual-driver', 'echo-cancel']),
    [
      './scripts/testing/verify-watch-mode-evidence.mjs',
      '--root', 'artifacts/testing/watch-mode-live',
      '--strict',
      '--models', 'model-a,model-b',
      '--feedback-modes', 'virtual-driver,echo-cancel',
    ],
  );
});

test('lastNonEmptyLine picks the trailing run directory from runner stdout', () => {
  assert.equal(lastNonEmptyLine('==> step one\r\n==> step two\r\nE:\\repo\\artifacts\\run-dir\r\n\r\n'), 'E:\\repo\\artifacts\\run-dir');
  assert.equal(lastNonEmptyLine('\r\n\n'), undefined);
  assert.equal(lastNonEmptyLine(''), undefined);
});

test('lastRunDirectoryLine survives trailing cleanup warnings on stdout', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-run-'));
  const stdout = `==> step\r\n${runDir}\r\nWARNING: failed to stop bridge service during cleanup\r\n`;
  assert.equal(lastRunDirectoryLine(stdout), runDir);
  assert.equal(
    lastRunDirectoryLine('==> only warnings\r\nWARNING: cleanup failed\r\n'),
    'WARNING: cleanup failed',
  );
  assert.equal(lastRunDirectoryLine(''), undefined);
});
