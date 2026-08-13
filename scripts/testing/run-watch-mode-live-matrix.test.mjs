import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repoRoot } from '../lib/testing-common.mjs';
import {
  CANONICAL_STRICT_MATRIX_MANIFEST,
  DEFAULT_FEEDBACK_MODES,
  DEFAULT_MODELS,
  LIVE_RUNNER_POST_REPORT_GRACE_SECONDS,
  LIVE_RUNNER_TERMINATION_GRACE_MS,
  MAX_WATCH_AUTO_STOP_AFTER_SECONDS,
  MATRIX_DEFAULTS,
  MIN_WATCH_AUTO_STOP_AFTER_SECONDS,
  SUPPORTED_DEVICE_CLASSES,
  WATCH_REPORT_COMPLETION_GRACE_SECONDS,
  STRICT_RUNTIME_BUILD_COMMANDS,
  assertLiveMatrixRunnerArgs,
  assertStrictLiveReportPassed,
  assertStrictMatrixProvenance,
  assertStrictEvidenceOptions,
  assertStrictReleaseMatrixLists,
  buildRunnerArgv,
  buildStrictRuntimeAuthority,
  buildVerifyArgv,
  lastNonEmptyLine,
  lastRunDirectoryLine,
  parseMatrixCliArgs,
  publishSuccessfulStrictMatrixManifest,
  resolveDeviceProfiles,
  resolveReusableLocalIsolationManifest,
  resolveLiveRunnerTimeoutMs,
  resolveMatrixLists,
  resolveWatchRealtimeProtocol,
  runMatrix,
  runStrictProviderPreflight,
  runnerArgsRequestDryRun,
  splitRunnerArgs,
  stageShardMatrixIntegration,
  strictRuntimeEnvironment,
  writeMatrixRunManifest,
} from './run-watch-mode-live-matrix.mjs';
import { fileAuthorityEntry, requiredCellArtifactPaths } from './watch-mode-evidence-authority.mjs';
import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
import {
  SHARD_CELL_RESULT_FILE,
  SHARD_EXECUTION_PLAN_FILE,
  SHARD_MANIFEST_FILE,
  createWorkerReadinessRequest,
  generateCoordinatorSigningKeyPair,
} from './watch-mode-shard-authority.mjs';
import {
  PROVIDER_PREFLIGHT_COMPLETION_FILE,
  PROVIDER_PREFLIGHT_GRANT_FILE,
  PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
  createProviderPreflightCompletion,
  createProviderPreflightGrant,
  createProviderPreflightLeaseReservations,
  providerPreflightAuthorizationConsumption,
  providerPreflightReservationFileName,
} from './watch-mode-provider-preflight-authorization.mjs';

const SAMPLE_MODEL = 'qwen3.5-omni-flash-realtime';
const SAMPLE_FEEDBACK_MODE = 'echo-cancel';
const CLEAN_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: 'fixture-current-head',
  worktreeClean: true,
  dirtyEntryCount: 0,
});
const TEST_RUNTIME_BINARY_HASHES = Object.freeze([]);

test('strict matrix refuses a failed cell report before another paid cell starts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-strict-report-'));
  try {
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({
      verdict: 'failed',
      failureReason: 'strict content is incomplete',
    }));
    assert.throws(
      () => assertStrictLiveReportPassed(root),
      /failed before another paid cell can start.*strict content is incomplete/,
    );
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ verdict: 'passed' }));
    assert.equal(assertStrictLiveReportPassed(root).verdict, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Guard order matches the runner switch forwarding the retired matrix .ps1 used.
const RUNNER_SWITCHES = [
  'SkipDesktopLaunch',
  'SkipDriverRepair',
  'AllowDriverRepair',
  'UseDefaultEndpointPlayback',
  'StopDesktopAfterPlayback',
  'AllowElevatedDesktopLaunch',
  'SkipPhysicalOutputContentStt',
  'StrictPaidAuthority',
];

function writeAuthorityPlaceholderArtifacts(runDirectory, feedbackMode) {
  for (const relativePath of requiredCellArtifactPaths(feedbackMode)) {
    const filePath = path.join(runDirectory, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, relativePath.endsWith('.json') ? '{}\n' : 'fixture\n', 'utf8');
  }
}

function writeMatrixBudgetPlaceholder(outputRoot) {
  const ledgerPath = path.join(outputRoot, 'external-provider-budget-matrix.json');
  fs.writeFileSync(ledgerPath, '{"passed":true}\n', 'utf8');
  const authority = fileAuthorityEntry(ledgerPath, path.basename(ledgerPath));
  return {
    passed: true,
    matrixCeilingSeconds: 1_440,
    reservedSessionSeconds: 1_440,
    auxiliaryExternalAudioSeconds: 0,
    ledgerPath: authority.path,
    ledgerBytes: authority.bytes,
    ledgerSha256: authority.sha256,
  };
}

test('matrix defaults freeze the strict-evidence contract', () => {
  assert.deepEqual(DEFAULT_MODELS, ['qwen3.5-omni-flash-realtime', 'qwen3.5-livetranslate-flash-realtime']);
  assert.deepEqual(DEFAULT_FEEDBACK_MODES, ['process-exclusion', 'virtual-driver', 'echo-cancel']);
  assert.deepEqual(MATRIX_DEFAULTS, {
    outputRoot: 'artifacts/testing/watch-mode-live',
    mediaPath: 'scripts/testing/fixtures/watch-mode-en-original.wav',
    warmupSeconds: 12,
    playbackSeconds: 0,
    postPlaybackWaitSeconds: 120,
    sessionReadyTimeoutSeconds: 90,
    watchAutoStopAfterSeconds: 180,
    physicalPlaybackDeviceId: 'default',
    physicalPlaybackDeviceClass: 'default-speaker',
    physicalPlaybackDeviceProfileId: 'default-speaker',
    expectedPhysicalPlaybackDeviceName: '',
    providerId: 'provider-dashscope',
  });
  assert.deepEqual(SUPPORTED_DEVICE_CLASSES, ['default-speaker', 'usb']);
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.match(
    packageJson.scripts['test:watch-mode-evidence:strict'],
    /--feedback-modes process-exclusion,virtual-driver,echo-cancel(?:\s|$)/,
    'the release evidence gate must require the same three feedback modes as the live matrix',
  );
  assert.match(
    packageJson.scripts['test:watch-mode-evidence:strict'],
    /--run-manifest artifacts\/testing\/watch-mode-live\/latest-successful-watch-mode-strict-matrix\.json/,
    'the release evidence gate must verify only the canonical successful strict manifest',
  );
});

test('live runner supports the three-minute pairwise floor and derives its timeout from configured budgets', () => {
  assert.equal(MIN_WATCH_AUTO_STOP_AFTER_SECONDS, 180);
  assert.equal(MAX_WATCH_AUTO_STOP_AFTER_SECONDS, 7_200);
  assert.equal(MATRIX_DEFAULTS.watchAutoStopAfterSeconds, MIN_WATCH_AUTO_STOP_AFTER_SECONDS);
  assert.equal(WATCH_REPORT_COMPLETION_GRACE_SECONDS, 120);
  assert.equal(LIVE_RUNNER_POST_REPORT_GRACE_SECONDS, 180);
  assert.equal(LIVE_RUNNER_TERMINATION_GRACE_MS, 5_000);
  assert.equal(resolveLiveRunnerTimeoutMs(), 578_000);
  assert.equal(
    resolveLiveRunnerTimeoutMs({ watchAutoStopAfterSeconds: 3_600 }),
    3_990_000,
  );
  assert.equal(
    resolveLiveRunnerTimeoutMs({
      playbackSeconds: 5_000,
      postPlaybackWaitSeconds: 120,
      sessionReadyTimeoutSeconds: 90,
      watchAutoStopAfterSeconds: 1_800,
    }),
    5_398_000,
    'long explicit playback plus recorder tail must extend the process timeout',
  );
});

test('sample pair argv binds every always-forwarded runner parameter', () => {
  const argv = buildRunnerArgv({ model: SAMPLE_MODEL, feedbackMode: SAMPLE_FEEDBACK_MODE });

  assert.deepEqual(argv, [
    '-OutputRoot', 'artifacts/testing/watch-mode-live',
    '-MediaPath', 'scripts/testing/fixtures/watch-mode-en-original.wav',
    '-WarmupSeconds', '12',
    '-WatchModelId', 'qwen3.5-omni-flash-realtime',
    '-SubtitleTranslationMode', 'native',
    '-PlaybackSeconds', '0',
    '-PostPlaybackWaitSeconds', '120',
    '-SessionReadyTimeoutSeconds', '90',
    '-WatchAutoStopAfterSeconds', '180',
    '-PhysicalPlaybackDeviceId', 'default',
    '-PhysicalPlaybackDeviceClass', 'default-speaker',
    '-PhysicalPlaybackDeviceProfileId', 'default-speaker',
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
    strictPaidAuthority: true,
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
    strictPaidAuthority: true,
  });
  assert.deepEqual(allOn.slice(28), RUNNER_SWITCHES.map((name) => `-${name}`));

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
  assert.equal(defaults.deviceProfiles, '');
  assert.equal(defaults.reuseLocalIsolation, '');
  assert.equal(defaults.warmupSeconds, 12);
  assert.equal(defaults.watchAutoStopAfterSeconds, 180);
  assert.deepEqual(defaults.runnerArgs, []);

  const parsed = parseMatrixCliArgs([
    '--models', 'model-a,model-b',
    '--feedback-loop-prevention-modes', 'virtual-driver',
    '--warmup-seconds', '30',
    '--watch-auto-stop-after-seconds', '1800',
    '--diagnostic-single-device',
    '--skip-driver-repair',
    '--allow-elevated-desktop-launch',
    '--expected-physical-playback-device-name', 'Speakers',
    '--reuse-local-isolation', 'artifacts/testing/watch-mode-local-isolation/example/local-isolation-manifest.json',
    '--', '-DryRun', '-Fixture', 'pass',
  ]);
  assert.equal(parsed.models, 'model-a,model-b');
  assert.equal(parsed.feedbackLoopPreventionModes, 'virtual-driver');
  assert.equal(parsed.warmupSeconds, 30);
  assert.equal(parsed.watchAutoStopAfterSeconds, 1_800);
  assert.equal(parsed.diagnosticSingleDevice, true);
  assert.equal(parsed.skipDriverRepair, true);
  assert.equal(parsed.allowElevatedDesktopLaunch, true);
  assert.equal(parsed.expectedPhysicalPlaybackDeviceName, 'Speakers');
  assert.equal(parsed.reuseLocalIsolation, 'artifacts/testing/watch-mode-local-isolation/example/local-isolation-manifest.json');
  assert.deepEqual(parsed.runnerArgs, ['-DryRun', '-Fixture', 'pass']);

  assert.throws(() => parseMatrixCliArgs(['--warmup-seconds', 'soon']), /--warmup-seconds must be an integer/);
  assert.throws(
    () => parseMatrixCliArgs(['--watch-auto-stop-after-seconds', '179']),
    /must be between 180 and 7200/,
  );
  assert.throws(
    () => parseMatrixCliArgs(['--watch-auto-stop-after-seconds', '7201']),
    /must be between 180 and 7200/,
  );
  assert.throws(() => parseMatrixCliArgs(['--unknown-flag', 'x']), /Unknown flag --unknown-flag/);
});

test('strict paid matrix cannot override a release model protocol through an alias', async () => {
  await assert.rejects(
    () => runMatrix({
      models: DEFAULT_MODELS.join(','),
      feedbackLoopPreventionModes: DEFAULT_FEEDBACK_MODES.join(','),
      deviceProfiles: JSON.stringify(SUPPORTED_DEVICE_CLASSES.map((deviceClass) => ({
        profileId: deviceClass,
        deviceClass,
        physicalPlaybackDeviceId: `endpoint-${deviceClass}`,
        expectedPhysicalPlaybackDeviceName: deviceClass,
      }))),
      aliasModel: DEFAULT_MODELS[0],
      aliasProtocol: 'dashscope-livetranslate',
      runnerArgs: [],
    }),
    /forbids model aliases and alias protocols/,
  );
});

test('legacy strict matrix fails before build, preflight, or any paid cell launch', async () => {
  await assert.rejects(
    () => runMatrix({
      models: DEFAULT_MODELS.join(','),
      feedbackLoopPreventionModes: DEFAULT_FEEDBACK_MODES.join(','),
      mediaPath: MATRIX_DEFAULTS.mediaPath,
      playbackSeconds: 0,
      watchAutoStopAfterSeconds: 180,
      subtitleTranslationMode: 'native',
      deviceProfiles: JSON.stringify(SUPPORTED_DEVICE_CLASSES.map((deviceClass) => ({
        profileId: deviceClass,
        deviceClass,
        physicalPlaybackDeviceId: `endpoint-${deviceClass}`,
        expectedPhysicalPlaybackDeviceName: deviceClass,
      }))),
      runnerArgs: [],
    }),
    /legacy strict matrix entry is disabled before build\/preflight\/provider launch/,
  );
});

test('strict paid argv binds the fail-closed local authority contract', () => {
  const argv = buildRunnerArgv({
    model: SAMPLE_MODEL,
    feedbackMode: SAMPLE_FEEDBACK_MODE,
    strictPaidAuthority: true,
    cellId: 'pairwise-live::qwen3.5-omni-flash-realtime::echo-cancel::default-speaker',
  });
  assert.ok(argv.includes('-StrictPaidAuthority'));
  assert.equal(
    argv[argv.indexOf('-MatrixCellId') + 1],
    'pairwise-live::qwen3.5-omni-flash-realtime::echo-cancel::default-speaker',
  );
  assert.equal(argv[argv.indexOf('-SubtitleTranslationMode') + 1], 'native');
  assert.equal(argv[argv.indexOf('-WatchAutoStopAfterSeconds') + 1], '180');
});

test('reusable local isolation authority is restricted to a repo-local manifest', () => {
  const workspace = path.join(repoRoot, 'fixture-workspace');
  assert.equal(
    resolveReusableLocalIsolationManifest(
      'artifacts/testing/watch-mode-local-isolation/run/local-isolation-manifest.json',
      { workspaceRoot: workspace },
    ),
    path.resolve(workspace, 'artifacts/testing/watch-mode-local-isolation/run/local-isolation-manifest.json'),
  );
  assert.throws(
    () => resolveReusableLocalIsolationManifest('artifacts/testing/watch-mode-live/run/local-isolation-manifest.json'),
    /must point inside artifacts\/testing\/watch-mode-local-isolation/,
  );
  assert.throws(
    () => resolveReusableLocalIsolationManifest('artifacts/testing/watch-mode-local-isolation/run/report.json'),
    /must point to local-isolation-manifest\.json/,
  );
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
  assert.doesNotThrow(() => assertStrictReleaseMatrixLists({
    modelList: DEFAULT_MODELS,
    feedbackModeList: DEFAULT_FEEDBACK_MODES,
  }));
  assert.throws(
    () => assertStrictReleaseMatrixLists({
      modelList: DEFAULT_MODELS,
      feedbackModeList: ['echo-cancel'],
    }),
    /strict release matrix must use exactly/,
  );
});

test('resolveDeviceProfiles fails closed for strict runs and accepts single-device only as an explicit diagnostic', () => {
  assert.throws(
    () => resolveDeviceProfiles({}),
    /--device-profiles is required for the strict matrix/,
  );
  assert.deepEqual(resolveDeviceProfiles({ diagnosticSingleDevice: true }), [{
    profileId: 'default-speaker',
    deviceClass: 'default-speaker',
    physicalPlaybackDeviceId: 'default',
    expectedPhysicalPlaybackDeviceName: '',
  }]);

  const profiles = [
    {
      profileId: 'speakers',
      deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: 'default',
      expectedPhysicalPlaybackDeviceName: 'Speakers',
    },
    {
      profileId: 'usb-dac',
      deviceClass: 'usb',
      physicalPlaybackDeviceId: 'usb-endpoint-id',
      expectedPhysicalPlaybackDeviceName: 'USB Audio',
    },
  ];
  assert.deepEqual(resolveDeviceProfiles({ deviceProfiles: JSON.stringify(profiles) }), profiles);

  assert.throws(
    () => resolveDeviceProfiles({ deviceProfiles: JSON.stringify([profiles[0]]) }),
    /must contain exactly one profile for each device class/,
  );
  assert.throws(
    () => resolveDeviceProfiles({
      diagnosticSingleDevice: true,
      deviceProfiles: JSON.stringify(profiles),
    }),
    /requires exactly one device profile/,
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-device-profiles-'));
  const configPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(configPath, `${JSON.stringify({ deviceProfiles: profiles })}\n`, 'utf8');
  assert.deepEqual(resolveDeviceProfiles({ deviceProfiles: configPath }), profiles);

  assert.throws(
    () => resolveDeviceProfiles({
      deviceProfiles: JSON.stringify([{
        profileId: 'usb',
        deviceClass: 'usb',
        physicalPlaybackDeviceId: 'default',
        expectedPhysicalPlaybackDeviceName: 'USB',
      }]),
    }),
    /explicit endpoint id/,
  );
  assert.throws(
    () => resolveDeviceProfiles({
      deviceProfiles: JSON.stringify([
        profiles[0],
        { ...profiles[0], profileId: 'other-speakers' },
      ]),
    }),
    /duplicate deviceClass/,
  );
});

test('verify invocation targets the strict evidence checker', () => {
  assert.deepEqual(
    buildVerifyArgv(
      'artifacts/testing/watch-mode-live',
      ['model-a', 'model-b'],
      ['virtual-driver', 'echo-cancel'],
      ['default-speaker', 'usb'],
      'E:\\artifacts\\watch-mode-live-matrix.json',
    ),
    [
      './scripts/testing/verify-watch-mode-evidence.mjs',
      '--root', 'artifacts/testing/watch-mode-live',
      '--strict',
      '--models', 'model-a,model-b',
      '--feedback-modes', 'virtual-driver,echo-cancel',
      '--device-classes', 'default-speaker,usb',
      '--run-manifest', 'E:\\artifacts\\watch-mode-live-matrix.json',
    ],
  );
});

test('strict matrix rejects DryRun passthrough before any fixture can be treated as live evidence', () => {
  assert.equal(runnerArgsRequestDryRun(['-Fixture', 'pass']), false);
  assert.equal(runnerArgsRequestDryRun(['-dryrun']), true);
  assert.equal(runnerArgsRequestDryRun(['/DryRun']), true);
  assert.throws(
    () => assertLiveMatrixRunnerArgs(['-DryRun', '-Fixture', 'pass']),
    /fixture reports are mode=dry-run and are not release evidence/,
  );
});

test('strict matrix rejects switches that bypass canonical media or raw physical-content evidence', () => {
  for (const options of [
    { skipDesktopLaunch: true },
    { useDefaultEndpointPlayback: true },
    { skipPhysicalOutputContentStt: true },
    { playbackSeconds: 120 },
    { runnerArgs: ['-SkipPhysicalOutputContentStt'] },
    { subtitleTranslationMode: 'secondary' },
    { watchAutoStopAfterSeconds: 181 },
    { runnerArgs: ['-SubtitleTranslationMode', 'secondary'] },
  ]) {
    assert.throws(() => assertStrictEvidenceOptions(options), /evidence-weakening options/);
  }
  assert.doesNotThrow(() => assertStrictEvidenceOptions({
    playbackSeconds: 0,
    runnerArgs: ['-SkipDriverRepair'],
  }));
});

test('strict matrix requires one exact clean git source state', () => {
  assert.equal(assertStrictMatrixProvenance(CLEAN_PROVENANCE), CLEAN_PROVENANCE);
  assert.throws(
    () => assertStrictMatrixProvenance({
      ...CLEAN_PROVENANCE,
      worktreeClean: false,
      dirtyEntryCount: 1,
    }),
    /dirty worktree or untracked source state/,
  );
  assert.throws(
    () => assertStrictMatrixProvenance(CLEAN_PROVENANCE, 'fixture-ancestor-head'),
    /does not exactly match completion HEAD/,
  );
});

test('strict matrix rebuilds every executed release binary before collecting evidence', () => {
  const calls = [];
  assert.throws(
    () => buildStrictRuntimeAuthority({
      run(executable, args, options) {
        calls.push({ executable, args, options });
        return { status: calls.length === STRICT_RUNTIME_BUILD_COMMANDS.length ? 1 : 0 };
      },
    }),
    /strict runtime build failed with exit code 1/,
  );
  assert.deepEqual(
    calls.map((entry) => (
      process.platform === 'win32' ? entry.args.slice(4) : entry.args
    )),
    STRICT_RUNTIME_BUILD_COMMANDS,
  );
  if (process.platform === 'win32') {
    assert.ok(calls.every((entry) => entry.executable === (process.env.ComSpec || 'cmd.exe')));
    assert.ok(calls.every((entry) => (
      JSON.stringify(entry.args.slice(0, 4)) === JSON.stringify(['/d', '/s', '/c', 'npm.cmd'])
    )));
  }
  assert.deepEqual(STRICT_RUNTIME_BUILD_COMMANDS, [
    ['run', 'build:tauri', '--workspace', '@omni/desktop'],
    ['run', 'build:bridge-service-native'],
    ['run', 'driver:build-sysvad'],
  ]);
});

test('strict runtime build and live runner ignore external Cargo target-directory overrides', () => {
  const environment = strictRuntimeEnvironment({
    CARGO_TARGET_DIR: 'C:\\stale-target',
    CARGO_BUILD_TARGET: 'aarch64-pc-windows-msvc',
    CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER: 'stale-runner.exe',
    KEEP_ME: 'yes',
  });

  assert.equal(environment.CARGO_TARGET_DIR, path.join(repoRoot, 'target'));
  assert.equal(environment.CARGO_BUILD_TARGET, undefined);
  assert.equal(environment.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER, undefined);
  assert.equal(environment.KEEP_ME, 'yes');
});

test('matrix manifest contains only the current invocation run directories', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-matrix-manifest-'));
  const currentRuns = [
    path.join(outputRoot, 'current-default'),
    path.join(outputRoot, 'current-usb'),
  ];
  for (const runDirectory of currentRuns) {
    writeAuthorityPlaceholderArtifacts(runDirectory, 'process-exclusion');
  }
  const { manifestPath, manifest } = writeMatrixRunManifest({
    outputRoot,
    modelList: ['model-a'],
    feedbackModeList: ['process-exclusion'],
    deviceProfiles: [
      { profileId: 'default', deviceClass: 'default-speaker' },
      { profileId: 'usb', deviceClass: 'usb' },
    ],
    runDirectories: currentRuns,
    strict: true,
    now: new Date('2026-08-10T00:00:00.000Z'),
    provenance: CLEAN_PROVENANCE,
    authorityRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    externalProviderBudget: writeMatrixBudgetPlaceholder(outputRoot),
    releaseCells: currentRuns.map((_, index) => ({
      cellId: `test::model-a::process-exclusion::${SUPPORTED_DEVICE_CLASSES[index]}`,
      tier: 'pairwise-live',
      providerMode: 'live-dashscope',
      durationSeconds: 180,
      modelId: 'model-a',
      feedbackLoopPrevention: 'process-exclusion',
      deviceClass: SUPPORTED_DEVICE_CLASSES[index],
    })),
  });
  assert.equal(fs.existsSync(manifestPath), true);
  assert.deepEqual(manifest.runDirectories, currentRuns.map((directory) => path.basename(directory)));
  assert.equal(manifest.schemaVersion, 4);
  assert.equal(manifest.cells.length, 2);
  assert.equal(manifest.strict, true);
  assert.equal(manifest.evidenceMode, 'live');
  assert.deepEqual(manifest.provenance, CLEAN_PROVENANCE);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), manifest);
});

test('strict shard writer projects guest authority into the manifest and every downstream cell receipt', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-shard-projection-'));
  const currentRuns = [path.join(outputRoot, 'guest-one'), path.join(outputRoot, 'guest-two')];
  const releaseCells = currentRuns.map((_, index) => ({
    cellId: `test-shard-cell-${index}`,
    tier: 'pairwise-live',
    providerMode: 'live-dashscope',
    durationSeconds: 180,
    modelId: SAMPLE_MODEL,
    feedbackLoopPrevention: 'echo-cancel',
    deviceClass: SUPPORTED_DEVICE_CLASSES[index],
  }));
  for (const runDirectory of currentRuns) writeAuthorityPlaceholderArtifacts(runDirectory, 'echo-cancel');
  const integrationCells = releaseCells.map((cell, index) => ({
    origin: 'guest-shard-result',
    executionId: 'execution-1',
    planDigest: 'a'.repeat(64),
    cellIndex: index,
    cellId: cell.cellId,
    workerId: `worker-${index}`,
    vmIdentityDigest: `${index + 1}`.repeat(64),
    waveIndex: 0,
    leaseId: `lease-${index}`,
    leaseDigest: 'b'.repeat(64),
    shardRoot: `execution/shards/worker-${index}`,
    shardManifest: { path: `execution/shards/worker-${index}/shard-manifest.json`, bytes: 1, sha256: 'c'.repeat(64), manifestDigest: 'd'.repeat(64) },
    result: { path: `${path.basename(currentRuns[index])}/shard-cell-result.json`, bytes: 1, sha256: 'e'.repeat(64), resultDigest: 'f'.repeat(64) },
    guestRunDirectory: `cells/${index}`,
    runDirectory: path.basename(currentRuns[index]),
    runtimeBinaryHashes: [],
    usageAuthority: { leaseId: `lease-${index}` },
    deviceAuthority: { deviceClass: cell.deviceClass },
  }));
  const shardExecution = { executionRoot: 'execution' };
  const matrixIntegration = { cells: integrationCells };
  try {
    const { manifest } = writeMatrixRunManifest({
      outputRoot,
      modelList: [SAMPLE_MODEL],
      feedbackModeList: ['echo-cancel'],
      deviceProfiles: SUPPORTED_DEVICE_CLASSES.map((deviceClass) => ({ profileId: deviceClass, deviceClass })),
      runDirectories: currentRuns,
      strict: true,
      provenance: CLEAN_PROVENANCE,
      authorityRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
      releaseCells,
      externalProviderBudget: writeMatrixBudgetPlaceholder(outputRoot),
      shardExecution,
      matrixIntegration,
    });
    assert.deepEqual(manifest.shardExecution, shardExecution);
    assert.deepEqual(manifest.matrixIntegration, matrixIntegration);
    assert.deepEqual(manifest.cells.map((cell) => cell.shardAuthority), integrationCells);
    for (let index = 0; index < currentRuns.length; index += 1) {
      const receipt = JSON.parse(fs.readFileSync(path.join(currentRuns[index], 'matrix-cell-authority.json'), 'utf8'));
      assert.deepEqual(receipt.shardAuthority, integrationCells[index]);
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('shard staging copies three guest roots and emits only evidence-root-relative eight-cell projections', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-shard-stage-'));
  const coordinatorRoot = path.join(root, 'coordinator');
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(coordinatorRoot, { recursive: true });
  const workerIds = ['vm-1', 'vm-2', 'vm-3'];
  const fixtureProvenance = {
    schemaVersion: 1,
    source: 'git',
    captureStatus: 'captured',
    headCommit: '3'.repeat(40),
    worktreeClean: true,
    dirtyEntryCount: 0,
  };
  const fixtureInventory = [{ path: 'fixture/artifact.bin', bytes: 1, sha256: '4'.repeat(64) }];
  const fixtureWorkers = workerIds.map((workerId, index) => ({
    workerId,
    interactiveUser: 'VMUser',
    vmIdentity: { provider: 'vmware', uuidBios: `fixture-vm-${index + 1}` },
    deviceProfileInstances: [
      {
        instanceId: `${workerId}-default`,
        profileId: 'vmware-hda-default',
        deviceClass: 'default-speaker',
        physicalPlaybackDeviceId: 'default',
        expectedPhysicalPlaybackDeviceName: '',
      },
      ...(workerId === 'vm-2' ? [{
        instanceId: `${workerId}-usb`,
        profileId: 'realtek-usb-spdif',
        deviceClass: 'usb',
        physicalPlaybackDeviceId: 'fixture-usb-endpoint',
        expectedPhysicalPlaybackDeviceName: 'Fixture USB',
      }] : []),
    ],
  }));
  const plan = {
    executionId: 'fixture-execution',
    planDigest: 'a'.repeat(64),
    provenance: fixtureProvenance,
    authority: {
      implementationHashes: fixtureInventory,
      runtimeBinaryHashes: fixtureInventory,
      shardOrchestrationImplementationHashes: fixtureInventory,
    },
    workers: fixtureWorkers,
    cells: LIVE_LLM_CELLS.map((cell, index) => ({
      cellIndex: index,
      cellId: cell.cellId,
      workerId: workerIds[index % workerIds.length],
      vmIdentityDigest: String((index % workerIds.length) + 1).repeat(64),
      waveIndex: Math.floor(index / workerIds.length),
      leaseId: `lease-${index}`,
      deviceProfileInstanceId: cell.deviceClass === 'usb' ? 'vm-2-usb' : `${workerIds[index % workerIds.length]}-default`,
    })),
  };
  const preflightRawRoot = path.join(coordinatorRoot, 'provider-preflight-evidence', 'raw');
  fs.mkdirSync(preflightRawRoot, { recursive: true });
  const preflightRawPath = path.join(preflightRawRoot, 'emitter-result.json');
  fs.writeFileSync(preflightRawPath, '{"status":"completed"}\n', 'utf8');
  const preflightInventoryPath = path.join(coordinatorRoot, 'provider-preflight-evidence', 'inventory.json');
  fs.writeFileSync(preflightInventoryPath, JSON.stringify({
    rawEvidenceRoot: 'provider-preflight-evidence/raw',
    entries: [fileAuthorityEntry(preflightRawPath, 'emitter-result.json')],
  }), 'utf8');
  const preflightReceiptPath = path.join(coordinatorRoot, 'provider-preflight-receipt.json');
  fs.writeFileSync(preflightReceiptPath, JSON.stringify({
    evidenceAuthority: fileAuthorityEntry(preflightInventoryPath, 'provider-preflight-evidence/inventory.json'),
    rawEvidenceRoot: 'provider-preflight-evidence/raw',
  }), 'utf8');
  plan.providerPreflightAuthority = fileAuthorityEntry(
    preflightReceiptPath,
    'provider-preflight-receipt.json',
  );
  const readinessRequest = createWorkerReadinessRequest({
    executionId: plan.executionId,
    generatedAt: new Date('2026-08-10T00:00:00.000Z'),
    provenance: fixtureProvenance,
    runtimeBinaryHashes: fixtureInventory,
    workers: fixtureWorkers,
    assignments: plan.cells,
  });
  const readinessRequestPath = path.join(coordinatorRoot, 'worker-readiness-request.json');
  fs.writeFileSync(readinessRequestPath, JSON.stringify(readinessRequest), 'utf8');
  const readinessAuthorities = fixtureWorkers.map((worker) => {
    const receiptPath = path.join(coordinatorRoot, 'worker-readiness', `${worker.workerId}.json`);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, JSON.stringify({ workerId: worker.workerId, providerCalls: 0 }), 'utf8');
    return {
      workerId: worker.workerId,
      providerCalls: 0,
      ...fileAuthorityEntry(receiptPath, `worker-readiness/${worker.workerId}.json`),
    };
  });
  const signingKeys = generateCoordinatorSigningKeyPair();
  const grant = createProviderPreflightGrant({
    executionId: plan.executionId,
    generatedAt: new Date('2026-08-10T00:00:01.000Z'),
    expiresAt: new Date('2026-08-10T01:00:00.000Z'),
    provenance: fixtureProvenance,
    authorityImplementationHashes: fixtureInventory,
    runtimeBinaryHashes: fixtureInventory,
    shardOrchestrationImplementationHashes: fixtureInventory,
    localIsolationAuthority: { path: 'local.json', bytes: 1, sha256: '5'.repeat(64), providerCalls: 0 },
    workerReadinessRequest: readinessRequest,
    workerReadinessRequestAuthority: fileAuthorityEntry(
      readinessRequestPath,
      'worker-readiness-request.json',
    ),
    workerReadinessAuthorities: readinessAuthorities,
    workers: fixtureWorkers,
    assignments: plan.cells,
    signingKeys,
  });
  const grantPath = path.join(coordinatorRoot, PROVIDER_PREFLIGHT_GRANT_FILE);
  fs.writeFileSync(grantPath, JSON.stringify(grant), 'utf8');
  const reservations = createProviderPreflightLeaseReservations({
    grant,
    issuedAt: new Date('2026-08-10T00:00:02.000Z'),
    signingKeys,
  });
  const reservationRoot = path.join(coordinatorRoot, PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY);
  fs.mkdirSync(reservationRoot);
  const reservationAuthorities = reservations.map((reservation, index) => {
    const fileName = providerPreflightReservationFileName(reservation, index);
    const filePath = path.join(reservationRoot, fileName);
    fs.writeFileSync(filePath, JSON.stringify(reservation), 'utf8');
    return {
      cellId: reservation.cellId,
      leaseId: reservation.leaseId,
      digest: reservation.digest,
      ...fileAuthorityEntry(
        filePath,
        `${PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY}/${fileName}`,
      ),
    };
  });
  const authorization = providerPreflightAuthorizationConsumption({
    grant,
    leaseReservations: reservations,
  });
  const consumptionClaimPath = path.join(coordinatorRoot, 'provider-preflight-consumption-claim.json');
  const consumptionClaim = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-provider-preflight-consumption-claim',
    executionId: plan.executionId,
    grantDigest: grant.digest,
    authorizationDigest: authorization.authorizationDigest,
    coordinatorKeyId: grant.signature.keyId,
    claimedAt: '2026-08-10T00:00:02.500Z',
    desktopProcessId: 4242,
    desktopExecutablePath: path.join(root, 'target', 'release', 'omni-desktop-shell.exe'),
    desktopExecutableRelativePath: 'target/release/omni-desktop-shell.exe',
    desktopExecutableBytes: 1,
    desktopExecutableSha256: '7'.repeat(64),
    retryPolicy: 'new-execution-required',
  };
  fs.writeFileSync(consumptionClaimPath, `${JSON.stringify(consumptionClaim)}\n`, 'utf8');
  const consumptionClaimAuthority = {
    ...consumptionClaim,
    ...fileAuthorityEntry(consumptionClaimPath, 'provider-preflight-consumption-claim.json'),
  };
  fs.writeFileSync(preflightReceiptPath, JSON.stringify({
    evidenceAuthority: fileAuthorityEntry(preflightInventoryPath, 'provider-preflight-evidence/inventory.json'),
    rawEvidenceRoot: 'provider-preflight-evidence/raw',
    generatedAt: '2026-08-10T00:00:03.000Z',
    ...authorization,
    consumptionClaim: consumptionClaimAuthority,
    tokenBudget: authorization.tokenBudget,
    inputTokens: 64,
    outputTokens: 12,
    audioSeconds: null,
    status: 'completed',
  }), 'utf8');
  plan.providerPreflightAuthority = {
    ...fileAuthorityEntry(preflightReceiptPath, 'provider-preflight-receipt.json'),
    generatedAt: '2026-08-10T00:00:03.000Z',
    ...authorization,
    consumptionClaim: consumptionClaimAuthority,
    tokenBudget: authorization.tokenBudget,
    inputTokens: 64,
    outputTokens: 12,
    audioSeconds: null,
    status: 'completed',
  };
  const completion = createProviderPreflightCompletion({
    grant,
    leaseReservations: reservations,
    preflightAuthority: plan.providerPreflightAuthority,
    generatedAt: new Date('2026-08-10T00:00:04.000Z'),
    signingKeys,
  });
  const completionPath = path.join(coordinatorRoot, PROVIDER_PREFLIGHT_COMPLETION_FILE);
  fs.writeFileSync(completionPath, JSON.stringify(completion), 'utf8');
  plan.providerPreflightGrant = {
    ...fileAuthorityEntry(grantPath, PROVIDER_PREFLIGHT_GRANT_FILE),
    digest: grant.digest,
  };
  plan.providerPreflightLeaseReservations = reservationAuthorities;
  plan.providerPreflightAuthorization = {
    grantDigest: grant.digest,
    leaseReservationDigests: reservations.map((reservation) => reservation.digest),
    authorizationDigest: authorization.authorizationDigest,
    tokenBudget: authorization.tokenBudget,
    consumptionClaim: consumptionClaimAuthority,
  };
  plan.providerPreflightCompletion = {
    ...fileAuthorityEntry(completionPath, PROVIDER_PREFLIGHT_COMPLETION_FILE),
    digest: completion.digest,
    grantDigest: grant.digest,
    authorizationDigest: authorization.authorizationDigest,
    tokenBudget: authorization.tokenBudget,
    inputTokens: 64,
    outputTokens: 12,
    audioSeconds: null,
    consumptionClaim: consumptionClaimAuthority,
  };
  const planPath = path.join(coordinatorRoot, SHARD_EXECUTION_PLAN_FILE);
  fs.writeFileSync(planPath, JSON.stringify(plan), 'utf8');
  const leasePaths = plan.cells.map((cell, index) => {
    const leasePath = path.join(coordinatorRoot, 'leases', `${index}.json`);
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, JSON.stringify({ cellId: cell.cellId, leaseId: cell.leaseId }), 'utf8');
    return leasePath;
  });
  const aggregatePath = path.join(coordinatorRoot, 'coordinator-aggregate.json');
  fs.writeFileSync(aggregatePath, JSON.stringify({
    aggregateDigest: 'b'.repeat(64),
    budget: { actualExternalAudioSamples: 16_000 * 120 * LIVE_LLM_CELLS.length },
  }), 'utf8');
  const shards = [];
  const collectedCells = [];
  for (const workerId of workerIds) {
    const shardRoot = path.join(root, 'guests', workerId);
    fs.mkdirSync(shardRoot, { recursive: true });
    const manifestPath = path.join(shardRoot, SHARD_MANIFEST_FILE);
    fs.writeFileSync(manifestPath, JSON.stringify({ manifestDigest: `${workerId.at(-1)}`.repeat(64) }), 'utf8');
    shards.push({ workerId, shardRoot, manifestPath });
  }
  for (const cell of plan.cells) {
    const shardRoot = shards.find((shard) => shard.workerId === cell.workerId).shardRoot;
    const runDirectoryRelative = `runs/cell-${cell.cellIndex}`;
    const runDirectory = path.join(shardRoot, ...runDirectoryRelative.split('/'));
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, SHARD_CELL_RESULT_FILE), JSON.stringify({
      leaseDigest: `c${cell.cellIndex}`.padEnd(64, 'c'),
      resultDigest: `d${cell.cellIndex}`.padEnd(64, 'd'),
      runDirectory: runDirectoryRelative,
      authority: { runtimeBinaryHashes: [] },
      usageAuthority: { leaseId: cell.leaseId },
      deviceAuthority: { deviceClass: LIVE_LLM_CELLS[cell.cellIndex].deviceClass },
    }), 'utf8');
    collectedCells.push({ cellId: cell.cellId, sourceRunDirectory: runDirectory });
  }
  try {
    const staged = stageShardMatrixIntegration({
      evidenceRoot,
      executionRootName: 'staged-execution',
      planPath,
      leasePaths,
      coordinatorAggregatePath: aggregatePath,
      shards,
      collectedMatrixIntegration: {
        provenance: CLEAN_PROVENANCE,
        authorityImplementationHashes: [],
        authorityRuntimeBinaryHashes: [],
        shardOrchestrationImplementationHashes: [],
        localIsolationAuthority: { passed: true },
        providerPreflightAuthority: { status: 'completed' },
        releaseCells: LIVE_LLM_CELLS,
        cells: collectedCells,
      },
    });
    assert.equal(staged.runDirectories.length, LIVE_LLM_CELLS.length);
    assert.deepEqual(staged.matrixIntegration.cells.map((cell) => cell.cellId), LIVE_LLM_CELLS.map((cell) => cell.cellId));
    assert.equal(staged.shardExecution.leases.length, LIVE_LLM_CELLS.length);
    assert.equal(staged.shardExecution.shards.length, 3);
    assert.ok(staged.runDirectories.every((directory) => path.relative(evidenceRoot, directory) && !path.relative(evidenceRoot, directory).startsWith('..')));
    assert.ok(staged.matrixIntegration.cells.every((cell) => (
      !Object.hasOwn(cell, 'sourceRunDirectory')
      && !path.isAbsolute(cell.runDirectory)
      && fs.existsSync(path.join(evidenceRoot, ...cell.runDirectory.split('/')))
    )));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical strict manifest requires raw re-verification after the verifier receipt', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-matrix-canonical-'));
  const profiles = SUPPORTED_DEVICE_CLASSES.map((deviceClass) => ({
    profileId: deviceClass,
    deviceClass,
    physicalPlaybackDeviceId: deviceClass === 'default-speaker' ? 'default' : `${deviceClass}-id`,
    expectedPhysicalPlaybackDeviceName: deviceClass,
  }));
  const runDirectories = [];
  for (const cell of LIVE_LLM_CELLS) {
    const runDirectory = path.join(outputRoot, cell.cellId.replaceAll('::', '-'));
    writeAuthorityPlaceholderArtifacts(runDirectory, cell.feedbackLoopPrevention);
    runDirectories.push(runDirectory);
  }
  const { manifestPath, manifest } = writeMatrixRunManifest({
    outputRoot,
    modelList: DEFAULT_MODELS,
    feedbackModeList: DEFAULT_FEEDBACK_MODES,
    deviceProfiles: profiles,
    runDirectories,
    strict: true,
    now: new Date('2026-08-10T00:00:00.000Z'),
    provenance: CLEAN_PROVENANCE,
    authorityRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    externalProviderBudget: writeMatrixBudgetPlaceholder(outputRoot),
    releaseCells: LIVE_LLM_CELLS,
  });
  assert.throws(
    () => publishSuccessfulStrictMatrixManifest({
      outputRoot,
      manifestPath,
      currentProvenance: CLEAN_PROVENANCE,
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /balanced release plan|local isolation/,
    'canonical publish must require the zero-LLM local isolation authority',
  );
  const canonicalPath = path.join(outputRoot, CANONICAL_STRICT_MATRIX_MANIFEST);
  assert.equal(fs.existsSync(canonicalPath), false);

  assert.throws(
    () => publishSuccessfulStrictMatrixManifest({
      outputRoot,
      manifestPath,
      currentProvenance: {
        ...CLEAN_PROVENANCE,
        headCommit: 'fixture-newer-head',
      },
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /does not exactly match current HEAD.*ancestor commits are not accepted/,
  );

  assert.throws(
    () => writeMatrixRunManifest({
      outputRoot,
      modelList: DEFAULT_MODELS,
      feedbackModeList: DEFAULT_FEEDBACK_MODES,
      deviceProfiles: profiles,
      runDirectories: runDirectories.slice(0, -1),
      strict: true,
      now: new Date('2026-08-10T09:45:00.000Z'),
      provenance: CLEAN_PROVENANCE,
      authorityRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
      externalProviderBudget: writeMatrixBudgetPlaceholder(outputRoot),
      releaseCells: LIVE_LLM_CELLS,
    }),
    /expected 8/,
  );

  const diagnostic = writeMatrixRunManifest({
    outputRoot,
    modelList: ['diagnostic-model'],
    feedbackModeList: ['echo-cancel'],
    deviceProfiles: [profiles[0]],
    runDirectories: [path.join(outputRoot, 'diagnostic-run')],
    strict: false,
    now: new Date('2026-08-10T10:00:00.000Z'),
    provenance: CLEAN_PROVENANCE,
  });
  fs.writeFileSync(canonicalPath, 'last verified matrix\n', 'utf8');
  const canonicalBeforeRejectedPublish = fs.readFileSync(canonicalPath, 'utf8');
  assert.throws(
    () => publishSuccessfulStrictMatrixManifest({
      outputRoot,
      manifestPath: diagnostic.manifestPath,
      currentProvenance: CLEAN_PROVENANCE,
    }),
    /balanced release plan/,
  );
  assert.equal(
    fs.readFileSync(canonicalPath, 'utf8'),
    canonicalBeforeRejectedPublish,
    'a diagnostic or failed shape must not overwrite the last successful strict manifest',
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
    undefined,
  );
  assert.equal(lastRunDirectoryLine(''), undefined);
});

test('strict provider preflight fails before local and paid cells when DashScope is unavailable', () => {
  const run = () => ({ status: 1, stderr: '' });
  assert.throws(() => runStrictProviderPreflight({
    providerId: 'provider-dashscope',
    provenance: CLEAN_PROVENANCE,
    exists: () => true,
    run,
    readEmitter: () => ({
      status: 'failed',
      error: 'DashScope Realtime WebSocket completed without translation text.',
    }),
  }), /no local or paid matrix cells were started.*without translation text/);
});

test('strict provider preflight accepts only a completed production emitter', () => {
  const result = runStrictProviderPreflight({
    providerId: 'provider-dashscope',
    provenance: CLEAN_PROVENANCE,
    exists: () => true,
    run: () => ({ status: 0 }),
    readEmitter: () => ({ status: 'completed' }),
    validateEvidence: () => ({
      issues: [],
      summary: {
        providerId: 'provider-dashscope',
        model: SAMPLE_MODEL,
        operation: 'text-translation-preflight',
        inputMode: 'text-only',
        externalAudioSamples: 0,
        providerInvocationCount: 1,
      },
    }),
    now: new Date('2026-08-11T03:00:00.000Z'),
  });
  assert.equal(result.providerId, 'provider-dashscope');
  assert.match(result.emitterPath, /emitter-result\.json$/);
});
