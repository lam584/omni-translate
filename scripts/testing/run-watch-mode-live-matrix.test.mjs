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
  buildRunnerRequest,
  buildStrictRuntimeAuthority,
  buildVerifyArgv,
  lastNonEmptyLine,
  lastRunDirectoryLine,
  parseMatrixCliArgs,
  publishSuccessfulStrictMatrixManifest,
  renameWithTransientRetrySync,
  resolveDeviceProfiles,
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
import { STRICT_PAID_MATRIX_MAX_INPUT_SAMPLES } from './watch-mode-external-provider-budget.mjs';
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

const SAMPLE_MODEL = 'qwen3.5-livetranslate-flash-realtime';
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

test('atomic evidence rename retries only transient filesystem lock failures', () => {
  const waits = [];
  let attempts = 0;
  const result = renameWithTransientRetrySync('staging', 'final', {
    renameSync: () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('transient filesystem lock');
        error.code = attempts === 1 ? 'EPERM' : 'EBUSY';
        throw error;
      }
    },
    sleepSync: (delayMs) => waits.push(delayMs),
    maxAttempts: 4,
    initialDelayMs: 10,
  });
  assert.deepEqual(result, { attempts: 3 });
  assert.deepEqual(waits, [10, 20]);

  let permanentAttempts = 0;
  assert.throws(
    () => renameWithTransientRetrySync('staging', 'final', {
      renameSync: () => {
        permanentAttempts += 1;
        const error = new Error('destination already exists');
        error.code = 'EEXIST';
        throw error;
      },
      sleepSync: () => assert.fail('permanent failures must not sleep'),
    }),
    /destination already exists/,
  );
  assert.equal(permanentAttempts, 1);
});

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
    matrixInputSampleCeiling: STRICT_PAID_MATRIX_MAX_INPUT_SAMPLES,
    reservedInputSamples: STRICT_PAID_MATRIX_MAX_INPUT_SAMPLES,
    auxiliaryExternalAudioSeconds: 0,
    ledgerPath: authority.path,
    ledgerBytes: authority.bytes,
    ledgerSha256: authority.sha256,
  };
}

test('matrix defaults freeze the strict-evidence contract', () => {
  assert.deepEqual(DEFAULT_MODELS, ['qwen3.5-livetranslate-flash-realtime']);
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
  assert.deepEqual(SUPPORTED_DEVICE_CLASSES, ['default-speaker']);
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

test('explicit non-strict diagnostic runner keeps its legacy duration options and derives an outer timeout', () => {
  assert.equal(MIN_WATCH_AUTO_STOP_AFTER_SECONDS, 180);
  assert.equal(MAX_WATCH_AUTO_STOP_AFTER_SECONDS, 7_200);
  assert.equal(MATRIX_DEFAULTS.watchAutoStopAfterSeconds, MIN_WATCH_AUTO_STOP_AFTER_SECONDS);
  assert.equal(WATCH_REPORT_COMPLETION_GRACE_SECONDS, 120);
  assert.equal(LIVE_RUNNER_POST_REPORT_GRACE_SECONDS, 180);
  assert.equal(LIVE_RUNNER_TERMINATION_GRACE_MS, 5_000);
  assert.ok(Number.isSafeInteger(resolveLiveRunnerTimeoutMs()));
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

test('matrix emits one finite run request and PowerShell accepts only its path', () => {
  const request = buildRunnerRequest({
    model: SAMPLE_MODEL,
    feedbackMode: SAMPLE_FEEDBACK_MODE,
    modelProtocolProfileIdentity: LIVE_LLM_CELLS[0].modelProtocolProfileIdentity,
  });
  assert.equal(request.schemaVersion, 'watch-mode-run-request/v1');
  assert.equal(request.model.id, SAMPLE_MODEL);
  assert.deepEqual(
    request.model.protocolProfileIdentity,
    LIVE_LLM_CELLS[0].modelProtocolProfileIdentity,
  );
  assert.equal(request.feedbackMode, SAMPLE_FEEDBACK_MODE);
  assert.equal(request.desktop.launchMode, 'managed');
  const runnerSource = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'testing', 'run-watch-mode-live.ps1'),
    'utf8',
  );
  assert.ok(runnerSource.startsWith('param('), 'runner must open with its param block');
  const paramBlock = runnerSource.slice(0, runnerSource.search(/^\)/m));
  assert.match(paramBlock, /\$RequestPath\b/);
  assert.doesNotMatch(paramBlock, /\$DryRun\b|\$SkipDriverRepair\b|\$WatchModelId\b/);
});

test('keyword-free live aliases carry an explicit protocol into config preparation', () => {
  const request = buildRunnerRequest({
    model: 'deployment-blue',
    feedbackMode: SAMPLE_FEEDBACK_MODE,
    watchRealtimeProtocol: 'dashscope-omni',
  });
  assert.equal(request.model.protocol, 'dashscope-omni');
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
  const request = buildRunnerRequest({
    model: SAMPLE_MODEL,
    feedbackMode: SAMPLE_FEEDBACK_MODE,
    strictPaidAuthority: true,
    cellId: 'pairwise-live::qwen3.5-livetranslate-flash-realtime::echo-cancel::default-speaker',
  });
  assert.equal(request.authorityMode, 'strict-paid');
  assert.equal(request.matrix.cellId, 'pairwise-live::qwen3.5-livetranslate-flash-realtime::echo-cancel::default-speaker');
  assert.equal(request.model.subtitleTranslationMode, 'native');
  assert.equal(request.timeouts.sessionSeconds, 180);
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

  const profiles = [{
      profileId: 'speakers',
      deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: 'default',
      expectedPhysicalPlaybackDeviceName: 'Speakers',
    }];
  assert.deepEqual(resolveDeviceProfiles({ deviceProfiles: JSON.stringify(profiles) }), profiles);

  assert.throws(
    () => resolveDeviceProfiles({ deviceProfiles: JSON.stringify([]) }),
    /At least one physical playback device profile|must contain exactly one profile for each device class/,
  );
  assert.deepEqual(resolveDeviceProfiles({
    diagnosticSingleDevice: true,
    deviceProfiles: JSON.stringify(profiles),
  }), profiles);

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
    /unsupported deviceClass|explicit endpoint id/,
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
    { runnerArgs: ['-SubtitleTranslationMode', 'secondary'] },
  ]) {
    assert.throws(() => assertStrictEvidenceOptions(options), /evidence-weakening options/);
  }
  assert.doesNotThrow(() => assertStrictEvidenceOptions({
    playbackSeconds: 0,
    runnerArgs: ['-SkipDriverRepair'],
  }));
});

test('legacy strict option guard does not recreate a uniform 180-second paid budget', () => {
  assert.doesNotThrow(() => assertStrictEvidenceOptions({
    feedbackMode: 'process-exclusion',
    playbackSeconds: 0,
    watchAutoStopAfterSeconds: 225,
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
  const currentRuns = [path.join(outputRoot, 'current-default')];
  for (const runDirectory of currentRuns) {
    writeAuthorityPlaceholderArtifacts(runDirectory, 'process-exclusion');
  }
  const { manifestPath, manifest } = writeMatrixRunManifest({
    outputRoot,
    modelList: ['model-a'],
    feedbackModeList: ['process-exclusion'],
    deviceProfiles: [
      { profileId: 'default', deviceClass: 'default-speaker' },
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
      inputCompletionWatchdogSeconds: 225,
      processExclusionRestartAfterSeconds: 90,
      processExclusionRestartQuietSeconds: 45,
      providerFinishTimeoutSeconds: 15,
      localPlaybackDrainTimeoutSeconds: 30,
      reportWriteTimeoutSeconds: 10,
      cellHardWatchdogSeconds: 280,
      authoritativeTransformedReferenceFrames: 2_733_045,
      boundedCaptureGraceFrames: 144_000,
      maxExternalAudioSamples: 2_877_045,
      auxiliaryExternalAudioSeconds: 0,
      subtitleTranslationMode: 'native',
      modelId: 'model-a',
      feedbackLoopPrevention: 'process-exclusion',
      deviceClass: SUPPORTED_DEVICE_CLASSES[index],
    })),
  });
  assert.equal(fs.existsSync(manifestPath), true);
  assert.deepEqual(manifest.runDirectories, currentRuns.map((directory) => path.basename(directory)));
  assert.equal(manifest.schemaVersion, 6);
  assert.equal(manifest.cells.length, 1);
  assert.equal(manifest.strict, true);
  assert.equal(manifest.evidenceMode, 'live');
  assert.deepEqual(manifest.provenance, CLEAN_PROVENANCE);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), manifest);
});

test('strict failure manifest preserves shard evidence without requiring completed-only cell artifacts', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-failed-matrix-manifest-'));
  const runDirectory = path.join(outputRoot, 'failed-cell');
  const releaseCell = {
    cellId: 'failed-cell',
    tier: 'pairwise-live',
    providerMode: 'live-dashscope',
    inputCompletionWatchdogSeconds: 225,
    processExclusionRestartAfterSeconds: 90,
    processExclusionRestartQuietSeconds: 45,
    providerFinishTimeoutSeconds: 15,
    localPlaybackDrainTimeoutSeconds: 30,
    reportWriteTimeoutSeconds: 10,
    cellHardWatchdogSeconds: 280,
    authoritativeTransformedReferenceFrames: 2_733_045,
    boundedCaptureGraceFrames: 144_000,
    maxExternalAudioSamples: 2_877_045,
    auxiliaryExternalAudioSeconds: 0,
    subtitleTranslationMode: 'native',
    modelId: SAMPLE_MODEL,
    feedbackLoopPrevention: 'process-exclusion',
    deviceClass: 'default-speaker',
  };
  const shardAuthority = {
    origin: 'guest-shard-result',
    executionId: 'failed-execution',
    verdict: 'failed',
    failureLayer: 'provider',
    stableErrorCode: 'watch.provider.session-failed',
    lifecyclePhase: 'provider-session',
    failureContext: {
      endpointId: null,
      bridgeInstanceId: null,
      ownerGenerationTransition: { before: null, after: null },
      terminalStatus: 'failed',
    },
    cellId: releaseCell.cellId,
    runDirectory: path.basename(runDirectory),
    result: {
      path: `${path.basename(runDirectory)}/shard-cell-result.json`,
      bytes: 1,
      sha256: 'a'.repeat(64),
      resultDigest: 'b'.repeat(64),
    },
  };
  try {
    writeAuthorityPlaceholderArtifacts(runDirectory, releaseCell.feedbackLoopPrevention);
    fs.rmSync(path.join(runDirectory, 'watch-session-report.json'));
    const fingerprint = {
      authoritySource: 'validated-shard-result',
      failureLayer: shardAuthority.failureLayer,
      stableErrorCode: shardAuthority.stableErrorCode,
      feedbackMode: releaseCell.feedbackLoopPrevention,
      lifecyclePhase: shardAuthority.lifecyclePhase,
      endpointId: null,
      ownerGenerationTransition: { before: null, after: null },
      bridgeInstanceId: null,
    };
    const failureSummary = {
      attempted: [releaseCell.cellId],
      completed: [releaseCell.cellId],
      passed: [],
      failed: [releaseCell.cellId],
      failures: [{ cellId: releaseCell.cellId, error: 'provider session failed', fingerprint }],
      sharedRootCauses: [],
      cellSpecificFailures: [{
        fingerprint,
        cellIds: [releaseCell.cellId],
        errors: ['provider session failed'],
      }],
    };
    const fingerprintPath = path.join(outputRoot, 'failure-fingerprints.json');
    fs.writeFileSync(fingerprintPath, `${JSON.stringify({
      schemaVersion: 2,
      artifactKind: 'watch-mode-production-failure-fingerprints',
      executionId: shardAuthority.executionId,
      collectAllCompleted: true,
      ...failureSummary,
    })}\n`, 'utf8');
    const { manifestPath, manifest } = writeMatrixRunManifest({
      outputRoot,
      modelList: [SAMPLE_MODEL],
      feedbackModeList: ['process-exclusion'],
      deviceProfiles: [{ profileId: 'default', deviceClass: 'default-speaker' }],
      runDirectories: [runDirectory],
      strict: true,
      provenance: CLEAN_PROVENANCE,
      authorityRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
      releaseCells: [releaseCell],
      externalProviderBudget: writeMatrixBudgetPlaceholder(outputRoot),
      failureSummary,
      failureFingerprintAuthority: fileAuthorityEntry(
        fingerprintPath,
        path.basename(fingerprintPath),
      ),
      shardExecution: { executionRoot: 'execution' },
      matrixIntegration: { cells: [shardAuthority] },
    });
    assert.equal(fs.existsSync(manifestPath), true);
    assert.equal(manifest.collectAll.verdict, 'failed');
    assert.equal(manifest.cells[0].verdict, 'failed');
    assert.equal(manifest.cells[0].stableErrorCode, 'watch.provider.session-failed');
    assert.deepEqual(manifest.cells[0].shardAuthority, shardAuthority);
    assert.equal(Object.hasOwn(manifest.cells[0], 'receiptPath'), false);
    assert.equal(fs.existsSync(path.join(runDirectory, 'matrix-cell-authority.json')), false);

    const forgedSummary = {
      ...failureSummary,
      cellSpecificFailures: [],
    };
    const forgedFingerprintPath = path.join(outputRoot, 'forged-failure-fingerprints.json');
    fs.writeFileSync(forgedFingerprintPath, `${JSON.stringify({
      schemaVersion: 2,
      artifactKind: 'watch-mode-production-failure-fingerprints',
      executionId: shardAuthority.executionId,
      collectAllCompleted: true,
      ...forgedSummary,
    })}\n`, 'utf8');
    assert.throws(() => writeMatrixRunManifest({
      outputRoot,
      modelList: [SAMPLE_MODEL],
      feedbackModeList: ['process-exclusion'],
      deviceProfiles: [{ profileId: 'default', deviceClass: 'default-speaker' }],
      runDirectories: [runDirectory],
      strict: true,
      provenance: CLEAN_PROVENANCE,
      authorityRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
      releaseCells: [releaseCell],
      externalProviderBudget: writeMatrixBudgetPlaceholder(outputRoot),
      failureSummary: forgedSummary,
      failureFingerprintAuthority: fileAuthorityEntry(
        forgedFingerprintPath,
        path.basename(forgedFingerprintPath),
      ),
      shardExecution: { executionRoot: 'execution' },
      matrixIntegration: { cells: [shardAuthority] },
    }), /failure grouping does not match/u);

    assert.throws(() => writeMatrixRunManifest({
      outputRoot,
      modelList: [SAMPLE_MODEL],
      feedbackModeList: ['process-exclusion'],
      deviceProfiles: [{ profileId: 'default', deviceClass: 'default-speaker' }],
      runDirectories: [runDirectory],
      strict: true,
      provenance: CLEAN_PROVENANCE,
      authorityRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
      releaseCells: [releaseCell],
      externalProviderBudget: writeMatrixBudgetPlaceholder(outputRoot),
    }), /watch-session-report\.json/u, 'a passed cell must still provide the full completed inventory');
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('strict shard writer projects guest authority into the manifest and every downstream cell receipt', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-shard-projection-'));
  const currentRuns = [path.join(outputRoot, 'guest-one')];
  const releaseCells = currentRuns.map((_, index) => ({
    cellId: `test-shard-cell-${index}`,
    tier: 'pairwise-live',
    providerMode: 'live-dashscope',
    inputCompletionWatchdogSeconds: 180,
    processExclusionRestartAfterSeconds: 0,
    processExclusionRestartQuietSeconds: 0,
    providerFinishTimeoutSeconds: 15,
    localPlaybackDrainTimeoutSeconds: 30,
    reportWriteTimeoutSeconds: 10,
    cellHardWatchdogSeconds: 235,
    authoritativeTransformedReferenceFrames: 2_013_045,
    boundedCaptureGraceFrames: 160_000,
    maxExternalAudioSamples: 2_173_045,
    auxiliaryExternalAudioSeconds: 0,
    subtitleTranslationMode: 'native',
    modelId: SAMPLE_MODEL,
    feedbackLoopPrevention: 'echo-cancel',
    deviceClass: SUPPORTED_DEVICE_CLASSES[index],
  }));
  for (const runDirectory of currentRuns) writeAuthorityPlaceholderArtifacts(runDirectory, 'echo-cancel');
  const integrationCells = releaseCells.map((cell, index) => ({
    origin: 'guest-shard-result',
    verdict: 'passed',
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
    const failureSummary = {
      attempted: releaseCells.map((cell) => cell.cellId),
      completed: releaseCells.map((cell) => cell.cellId),
      passed: releaseCells.map((cell) => cell.cellId),
      failed: [],
      failures: [],
      sharedRootCauses: [],
      cellSpecificFailures: [],
    };
    const fingerprintPath = path.join(outputRoot, 'failure-fingerprints.json');
    fs.writeFileSync(fingerprintPath, `${JSON.stringify({
      schemaVersion: 2,
      artifactKind: 'watch-mode-production-failure-fingerprints',
      executionId: 'execution-1',
      collectAllCompleted: true,
      ...failureSummary,
    })}\n`, 'utf8');
    const failureFingerprintAuthority = fileAuthorityEntry(
      fingerprintPath,
      path.basename(fingerprintPath),
    );
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
      failureSummary,
      failureFingerprintAuthority,
    });
    assert.deepEqual(manifest.shardExecution, shardExecution);
    assert.deepEqual(manifest.matrixIntegration, matrixIntegration);
    assert.deepEqual(manifest.cells.map((cell) => cell.shardAuthority), integrationCells);
    for (let index = 0; index < currentRuns.length; index += 1) {
      const receipt = JSON.parse(fs.readFileSync(path.join(currentRuns[index], 'matrix-cell-authority.json'), 'utf8'));
      assert.deepEqual(receipt.shardAuthority, integrationCells[index]);
    }

    const passingAuthorityWithFailure = {
      ...integrationCells[0],
      failureLayer: 'provider',
    };
    assert.throws(() => writeMatrixRunManifest({
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
      matrixIntegration: { cells: [passingAuthorityWithFailure] },
      failureSummary,
      failureFingerprintAuthority,
    }), /passing matrix cell.*carries failure identity fields/u);

    const unlistedFailedAuthority = {
      ...integrationCells[0],
      verdict: 'failed',
      reportVerdict: 'failed',
      failureLayer: 'provider',
      stableErrorCode: 'watch.provider.session-failed',
      lifecyclePhase: 'provider-session',
      failureContext: {
        endpointId: null,
        bridgeInstanceId: null,
        ownerGenerationTransition: { before: null, after: null },
      },
    };
    assert.throws(() => writeMatrixRunManifest({
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
      matrixIntegration: { cells: [unlistedFailedAuthority] },
      failureSummary,
      failureFingerprintAuthority,
    }), /does not exactly partition the release cells/u);

    assert.throws(() => writeMatrixRunManifest({
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
    }), /complete collect-all failure summary/u);

    assert.throws(() => writeMatrixRunManifest({
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
      failureSummary: { ...failureSummary, failed: 'not-an-array' },
      failureFingerprintAuthority,
    }), /complete collect-all failure summary/u);

    fs.appendFileSync(fingerprintPath, 'tamper', 'utf8');
    assert.throws(() => writeMatrixRunManifest({
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
      failureSummary,
      failureFingerprintAuthority,
    }), /hash\/size mismatch/u);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('shard staging copies one local root and emits only evidence-root-relative four-cell projections', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-shard-stage-'));
  const coordinatorRoot = path.join(root, 'coordinator');
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(coordinatorRoot, { recursive: true });
  const workerIds = ['vm-1'];
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
      waveIndex: index,
      leaseId: `lease-${index}`,
      deviceProfileInstanceId: `${workerIds[index % workerIds.length]}-default`,
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
    schemaVersion: 3,
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
  const lifecycleEvidence = {
    evidenceOutcome: 'livetranslate-session-finished',
    firstServerEvent: { type: 'session.created', monotonicMs: 606 },
    sessionAuthority: {
      sessionIdentitySha256: '8'.repeat(64),
      serverModel: 'qwen3.5-livetranslate-flash-realtime',
      echoedSessionConfigSha256: '9'.repeat(64),
    },
    rawTrace: {
      path: 'raw/provider-websocket-trace.jsonl',
      bytes: 256,
      sha256: 'a'.repeat(64),
      eventCount: 6,
    },
  };
  fs.writeFileSync(preflightReceiptPath, JSON.stringify({
    evidenceAuthority: fileAuthorityEntry(preflightInventoryPath, 'provider-preflight-evidence/inventory.json'),
    rawEvidenceRoot: 'provider-preflight-evidence/raw',
    generatedAt: '2026-08-10T00:00:03.000Z',
    ...authorization,
    consumptionClaim: consumptionClaimAuthority,
    ...lifecycleEvidence,
    audioSeconds: null,
    status: 'completed',
  }), 'utf8');
  plan.providerPreflightAuthority = {
    ...fileAuthorityEntry(preflightReceiptPath, 'provider-preflight-receipt.json'),
    generatedAt: '2026-08-10T00:00:03.000Z',
    ...authorization,
    consumptionClaim: consumptionClaimAuthority,
    ...lifecycleEvidence,
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
    inputMode: authorization.inputMode,
    providerInputMode: authorization.providerInputMode,
    responseMode: authorization.responseMode,
    terminalEvent: authorization.terminalEvent,
    lifecycleBudget: authorization.lifecycleBudget,
    modelProtocolProfileIdentity: structuredClone(
      authorization.modelProtocolProfileIdentity,
    ),
    consumptionClaim: consumptionClaimAuthority,
  };
  plan.providerPreflightCompletion = {
    ...fileAuthorityEntry(completionPath, PROVIDER_PREFLIGHT_COMPLETION_FILE),
    digest: completion.digest,
    grantDigest: grant.digest,
    authorizationDigest: authorization.authorizationDigest,
    inputMode: authorization.inputMode,
    providerInputMode: authorization.providerInputMode,
    responseMode: authorization.responseMode,
    terminalEvent: authorization.terminalEvent,
    lifecycleBudget: authorization.lifecycleBudget,
    modelProtocolProfileIdentity: structuredClone(
      authorization.modelProtocolProfileIdentity,
    ),
    ...lifecycleEvidence,
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
      verdict: 'passed',
      reportVerdict: 'passed',
      cell: { cellId: cell.cellId },
      leaseDigest: `c${cell.cellIndex}`.padEnd(64, 'c'),
      resultDigest: `d${cell.cellIndex}`.padEnd(64, 'd'),
      runDirectory: runDirectoryRelative,
      authority: { runtimeBinaryHashes: [] },
      usageAuthority: { leaseId: cell.leaseId },
      deviceAuthority: { deviceClass: LIVE_LLM_CELLS[cell.cellIndex].deviceClass },
    }), 'utf8');
    collectedCells.push({
      cellId: cell.cellId,
      verdict: 'passed',
      resultDigest: `d${cell.cellIndex}`.padEnd(64, 'd'),
      shardManifestDigest: 'validated-shard-manifest-digest',
      runDirectory: runDirectoryRelative,
      sourceRunDirectory: runDirectory,
    });
  }
  try {
    let validationCount = 0;
    const collectedMatrixIntegration = {
      provenance: CLEAN_PROVENANCE,
      authorityImplementationHashes: [],
      authorityRuntimeBinaryHashes: [],
      shardOrchestrationImplementationHashes: [],
      localIsolationAuthority: { passed: true },
      providerPreflightAuthority: { status: 'completed' },
      releaseCells: LIVE_LLM_CELLS,
      cells: collectedCells,
    };
    const validateStagedShard = ({ shardRoot }) => {
      validationCount += 1;
      return {
        manifest: { manifestDigest: 'validated-shard-manifest-digest' },
        validatedResults: plan.cells.map((cell) => {
          const runDirectory = path.join(shardRoot, 'runs', `cell-${cell.cellIndex}`);
          return {
            runDirectory,
            result: JSON.parse(fs.readFileSync(
              path.join(runDirectory, SHARD_CELL_RESULT_FILE),
              'utf8',
            )),
          };
        }),
      };
    };
    const staged = stageShardMatrixIntegration({
      evidenceRoot,
      executionRootName: 'staged-execution',
      planPath,
      leasePaths,
      coordinatorAggregatePath: aggregatePath,
      shards,
      collectedMatrixIntegration,
      validateStagedShard,
    });
    assert.equal(validationCount, 1);
    assert.equal(staged.runDirectories.length, LIVE_LLM_CELLS.length);
    assert.deepEqual(staged.matrixIntegration.cells.map((cell) => cell.cellId), LIVE_LLM_CELLS.map((cell) => cell.cellId));
    assert.equal(staged.shardExecution.leases.length, LIVE_LLM_CELLS.length);
    assert.equal(staged.shardExecution.shards.length, 1);
    assert.ok(staged.runDirectories.every((directory) => path.relative(evidenceRoot, directory) && !path.relative(evidenceRoot, directory).startsWith('..')));
    assert.ok(staged.matrixIntegration.cells.every((cell) => (
      !Object.hasOwn(cell, 'sourceRunDirectory')
      && !path.isAbsolute(cell.runDirectory)
      && fs.existsSync(path.join(evidenceRoot, ...cell.runDirectory.split('/')))
    )));
    assert.throws(() => stageShardMatrixIntegration({
      evidenceRoot,
      executionRootName: 'staged-execution-digest-mismatch',
      planPath,
      leasePaths,
      coordinatorAggregatePath: aggregatePath,
      shards,
      collectedMatrixIntegration: {
        ...collectedMatrixIntegration,
        cells: collectedCells.map((cell, index) => (
          index === 0 ? { ...cell, shardManifestDigest: 'wrong-digest' } : cell
        )),
      },
      validateStagedShard,
    }), /does not match coordinator authority/u);
    assert.equal(fs.existsSync(path.join(evidenceRoot, 'staged-execution-digest-mismatch')), false);
    assert.throws(() => stageShardMatrixIntegration({
      evidenceRoot,
      executionRootName: 'invalid-validation-time',
      validationAt: new Date(Number.NaN),
    }), /valid trusted validation timestamp/u);
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
    /expected 4/,
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
        operation: 'livetranslate-session-lifecycle-preflight',
        inputMode: 'none',
        providerInputMode: 'none',
        responseMode: 'text-only',
        terminalEvent: 'session.finished',
        lifecycleBudget: {
          firstServerEventLatencyMs: 1_200,
          socketEventTimeoutMs: 12_000,
        },
        evidenceOutcome: 'livetranslate-session-finished',
        externalAudioSamples: 0,
        providerInvocationCount: 1,
      },
    }),
    now: new Date('2026-08-11T03:00:00.000Z'),
  });
  assert.equal(result.providerId, 'provider-dashscope');
  assert.match(result.emitterPath, /emitter-result\.json$/);
});
