import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMain, isWindows, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import {
  currentGitProvenance,
  exactGitProvenanceFailure,
  gitProvenanceShapeFailure,
} from './git-provenance.mjs';
import {
  CELL_AUTHORITY_FILE,
  LIVE_RUN_COLLECTOR_ID,
  MATRIX_RUNNER_ID,
  STRICT_MATRIX_ARTIFACT_KIND,
  STRICT_MATRIX_SCHEMA_VERSION,
  currentAuthorityImplementationHashes,
  currentAuthorityRuntimeBinaryHashes,
  fileAuthorityEntry,
  resolveAuthorityPath,
  sameAuthorityInventory,
  validateFileAuthorityEntry,
  writeCellAuthorityReceipt,
} from './watch-mode-evidence-authority.mjs';
import {
  findWatchModeEvidence,
  strictMatrixVerificationReceiptPath,
  validateStrictMatrixVerificationReceipt,
  verifyStrictMatrixAuthority,
} from './verify-watch-mode-evidence.mjs';
import {
  BALANCED_RELEASE_PLAN,
  LIVE_LLM_CELLS,
  RELEASE_DEVICE_CLASSES,
  RELEASE_FEEDBACK_MODES,
  RELEASE_MODELS,
  balancedReleasePlanFailure,
} from './watch-mode-balanced-release-plan.mjs';
import {
  runLocalIsolationMatrix,
  verifyLocalIsolationManifest,
} from './watch-mode-local-isolation.mjs';

export const DEFAULT_MODELS = RELEASE_MODELS;
export const WATCH_MODEL_PROTOCOLS = Object.freeze({
  'qwen3.5-omni-plus-realtime': 'dashscope-omni',
  'qwen3.5-omni-flash-realtime': 'dashscope-omni',
  'qwen3.5-livetranslate-flash-realtime': 'dashscope-livetranslate',
});
export const DEFAULT_FEEDBACK_MODES = RELEASE_FEEDBACK_MODES;
export const SUPPORTED_FEEDBACK_MODES = RELEASE_FEEDBACK_MODES;
export const SUPPORTED_DEVICE_CLASSES = RELEASE_DEVICE_CLASSES;
export const MIN_WATCH_AUTO_STOP_AFTER_SECONDS = 180;
export const MAX_WATCH_AUTO_STOP_AFTER_SECONDS = 7_200;
export const CANONICAL_STRICT_MATRIX_MANIFEST = 'latest-successful-watch-mode-strict-matrix.json';
export const STRICT_RUNTIME_BUILD_COMMANDS = Object.freeze([
  Object.freeze(['run', 'build:tauri', '--workspace', '@omni/desktop']),
  Object.freeze(['run', 'build:bridge-service-native']),
  Object.freeze(['run', 'driver:build-sysvad']),
]);
export const STRICT_RUNTIME_DIAGNOSTIC_BUILD = Object.freeze([
  'build', '--manifest-path', 'scripts/diagnostics/omni-realtime/Cargo.toml',
]);

export const MATRIX_DEFAULTS = {
  outputRoot: 'artifacts/testing/watch-mode-live',
  mediaPath: 'scripts/testing/fixtures/watch-mode-en-original.wav',
  warmupSeconds: 12,
  playbackSeconds: 0,
  postPlaybackWaitSeconds: 120,
  sessionReadyTimeoutSeconds: 90,
  watchAutoStopAfterSeconds: MIN_WATCH_AUTO_STOP_AFTER_SECONDS,
  physicalPlaybackDeviceId: 'default',
  physicalPlaybackDeviceClass: 'default-speaker',
  physicalPlaybackDeviceProfileId: 'default-speaker',
  expectedPhysicalPlaybackDeviceName: '',
  providerId: 'provider-dashscope',
};

const RUNNER_SCRIPT = path.join(repoRoot, 'scripts', 'testing', 'run-watch-mode-live.ps1');
// The PowerShell runner starts the auto-stop clock inside the desktop process,
// so readiness can consume its complete budget before the planned live session.
// Allow the report its own atomic-write grace, then leave the matrix enough time
// to finish recorder/STT/report post-processing before killing the process tree.
export const WATCH_REPORT_COMPLETION_GRACE_SECONDS = 120;
export const LIVE_RUNNER_POST_REPORT_GRACE_SECONDS = 180;
export const LIVE_RUNNER_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_MEDIA_BUDGET_SECONDS = 180;
const PHYSICAL_OUTPUT_RECORDING_TAIL_SECONDS = 8;

export const resolveLiveRunnerTimeoutMs = ({
  playbackSeconds = MATRIX_DEFAULTS.playbackSeconds,
  postPlaybackWaitSeconds = MATRIX_DEFAULTS.postPlaybackWaitSeconds,
  sessionReadyTimeoutSeconds = MATRIX_DEFAULTS.sessionReadyTimeoutSeconds,
  watchAutoStopAfterSeconds = MATRIX_DEFAULTS.watchAutoStopAfterSeconds,
} = {}) => {
  const mediaBudgetSeconds = playbackSeconds > 0 ? playbackSeconds : DEFAULT_MEDIA_BUDGET_SECONDS;
  const reportBudgetSeconds = watchAutoStopAfterSeconds + WATCH_REPORT_COMPLETION_GRACE_SECONDS;
  const recorderBudgetSeconds = mediaBudgetSeconds
    + postPlaybackWaitSeconds
    + PHYSICAL_OUTPUT_RECORDING_TAIL_SECONDS;
  return (
    sessionReadyTimeoutSeconds
    + Math.max(reportBudgetSeconds, recorderBudgetSeconds)
    + LIVE_RUNNER_POST_REPORT_GRACE_SECONDS
  ) * 1_000;
};

const INTEGER_OPTION_FLAGS = {
  warmupSeconds: 'warmup-seconds',
  playbackSeconds: 'playback-seconds',
  postPlaybackWaitSeconds: 'post-playback-wait-seconds',
  sessionReadyTimeoutSeconds: 'session-ready-timeout-seconds',
  watchAutoStopAfterSeconds: 'watch-auto-stop-after-seconds',
};

const BOOLEAN_FLAGS = [
  'diagnostic-single-device',
  'skip-desktop-launch',
  'skip-driver-repair',
  'allow-driver-repair',
  'use-default-endpoint-playback',
  'stop-desktop-after-playback',
  'allow-elevated-desktop-launch',
  'skip-physical-output-content-stt',
];

const USAGE = `Usage: node scripts/testing/run-watch-mode-live-matrix.mjs [options] [-- <runner args>]

Options:
  --models <a,b>                                   diagnostic override; strict release matrix is fixed to
                                                   the two default Watch Mode model ids
                                                   (default: ${DEFAULT_MODELS.join(',')})
  --alias-model <id>                               optional keyword-free deployed alias to append
  --alias-protocol <dialect>                       explicit protocol for --alias-model
  --feedback-loop-prevention-modes <a,b>           diagnostic override among: ${SUPPORTED_FEEDBACK_MODES.join(', ')}
                                                   strict release matrix is fixed to all three modes
                                                   (default: ${DEFAULT_FEEDBACK_MODES.join(',')})
  --output-root <dir>                              default: ${MATRIX_DEFAULTS.outputRoot}
  --media-path <file>                              default: ${MATRIX_DEFAULTS.mediaPath}
  --warmup-seconds <n>                             default: ${MATRIX_DEFAULTS.warmupSeconds}
  --playback-seconds <n>                           default: ${MATRIX_DEFAULTS.playbackSeconds}
  --post-playback-wait-seconds <n>                 default: ${MATRIX_DEFAULTS.postPlaybackWaitSeconds}
  --session-ready-timeout-seconds <n>              default: ${MATRIX_DEFAULTS.sessionReadyTimeoutSeconds}
  --watch-auto-stop-after-seconds <n>              hard Watch capture limit, ${MIN_WATCH_AUTO_STOP_AFTER_SECONDS}-${MAX_WATCH_AUTO_STOP_AFTER_SECONDS}
                                                   (default: ${MATRIX_DEFAULTS.watchAutoStopAfterSeconds})
  --physical-playback-device-id <id>               default: ${MATRIX_DEFAULTS.physicalPlaybackDeviceId}
  --physical-playback-device-class <class>         diagnostic single-device class: ${SUPPORTED_DEVICE_CLASSES.join(', ')}
  --physical-playback-device-profile-id <id>       diagnostic single-device profile id
  --expected-physical-playback-device-name <name>  default: empty
  --provider-id <id>                               strict paid-cell preflight provider
                                                   (default: ${MATRIX_DEFAULTS.providerId})
  --device-profiles <json-or-file>                  required for strict matrix; must contain exactly one
                                                   default-speaker, usb, and bluetooth profile
  --diagnostic-single-device                       explicit non-strict single-device diagnostic; never
                                                   produces release matrix evidence
  --skip-desktop-launch
  --skip-driver-repair
  --allow-driver-repair
  --use-default-endpoint-playback
  --stop-desktop-after-playback
  --allow-elevated-desktop-launch
  --skip-physical-output-content-stt

Everything after a literal "--" separator is appended verbatim to the
powershell.exe -File scripts/testing/run-watch-mode-live.ps1 invocation as
extra single-dash runner parameters. -DryRun is rejected here because fixture
output is non-live and cannot satisfy the strict matrix; use the dedicated
test:watch-mode-live:dry-run command for runner self-tests.
The runner also honors the OMNI_WATCH_MODE_LIVE_* environment overrides,
which this matrix forwards untouched.`;

const toCamelCase = (flag) => flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const toKebabCase = (key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export const splitRunnerArgs = (argv) => {
  const separatorIndex = argv.indexOf('--');
  if (separatorIndex === -1) {
    return { matrixArgv: argv, runnerArgs: [] };
  }
  return {
    matrixArgv: argv.slice(0, separatorIndex),
    runnerArgs: argv.slice(separatorIndex + 1),
  };
};

export const parseMatrixCliArgs = (argv) => {
  const { matrixArgv, runnerArgs } = splitRunnerArgs(argv);
  const options = parseCliArgs(matrixArgv, {
    booleans: BOOLEAN_FLAGS,
    defaults: {
      models: DEFAULT_MODELS.join(','),
      aliasModel: process.env.OMNI_WATCH_MODE_LIVE_ALIAS_MODEL_ID ?? '',
      aliasProtocol: process.env.OMNI_WATCH_MODE_LIVE_ALIAS_PROTOCOL ?? 'dashscope-omni',
      feedbackLoopPreventionModes: DEFAULT_FEEDBACK_MODES.join(','),
      deviceProfiles: process.env.OMNI_WATCH_MODE_LIVE_DEVICE_PROFILES ?? '',
      ...MATRIX_DEFAULTS,
    },
  });
  const knownKeys = new Set([
    'models',
    'aliasModel',
    'aliasProtocol',
    'feedbackLoopPreventionModes',
    'deviceProfiles',
    ...Object.keys(MATRIX_DEFAULTS),
    ...BOOLEAN_FLAGS.map(toCamelCase),
  ]);
  for (const key of Object.keys(options)) {
    if (!knownKeys.has(key)) {
      throw new Error(`Unknown flag --${toKebabCase(key)}`);
    }
  }
  for (const [key, flag] of Object.entries(INTEGER_OPTION_FLAGS)) {
    const value = Number(options[key]);
    if (!Number.isInteger(value)) {
      throw new Error(`--${flag} must be an integer; got '${options[key]}'`);
    }
    options[key] = value;
  }
  if (
    options.watchAutoStopAfterSeconds < MIN_WATCH_AUTO_STOP_AFTER_SECONDS
    || options.watchAutoStopAfterSeconds > MAX_WATCH_AUTO_STOP_AFTER_SECONDS
  ) {
    throw new Error(
      `--watch-auto-stop-after-seconds must be between ${MIN_WATCH_AUTO_STOP_AFTER_SECONDS} and ${MAX_WATCH_AUTO_STOP_AFTER_SECONDS}`,
    );
  }
  return { ...options, runnerArgs };
};

const parseListOption = (value) => {
  const entries = Array.isArray(value) ? value : String(value).split(',');
  return entries.filter((entry) => entry.trim().length > 0);
};

export const resolveMatrixLists = ({ models, feedbackLoopPreventionModes }) => {
  const modelList = parseListOption(models);
  if (modelList.length === 0) {
    throw new Error('At least one Watch Mode model must be provided.');
  }
  const feedbackModeList = parseListOption(feedbackLoopPreventionModes);
  if (feedbackModeList.length === 0) {
    throw new Error('At least one feedback loop prevention mode must be provided.');
  }
  for (const mode of feedbackModeList) {
    if (!SUPPORTED_FEEDBACK_MODES.includes(mode)) {
      throw new Error(`Unsupported feedback loop prevention mode: ${mode}`);
    }
  }
  return { modelList, feedbackModeList };
};

export const assertStrictReleaseMatrixLists = ({ modelList, feedbackModeList }) => {
  if (
    JSON.stringify(modelList) !== JSON.stringify(DEFAULT_MODELS)
    || JSON.stringify(feedbackModeList) !== JSON.stringify(DEFAULT_FEEDBACK_MODES)
  ) {
    throw new Error(
      `strict release matrix must use exactly models=${DEFAULT_MODELS.join(',')} and feedback modes=${DEFAULT_FEEDBACK_MODES.join(',')}; use --diagnostic-single-device for a non-release diagnostic`,
    );
  }
};

export const resolveDeviceProfiles = (
  options = {},
  { strict = !Boolean(options.diagnosticSingleDevice) } = {},
) => {
  const configured = String(options.deviceProfiles ?? '').trim();
  let rawProfiles;
  if (configured) {
    const jsonText = configured.startsWith('[') || configured.startsWith('{')
      ? configured
      : fs.readFileSync(path.resolve(repoRoot, configured), 'utf8');
    const parsed = JSON.parse(jsonText.replace(/^\uFEFF/, ''));
    rawProfiles = Array.isArray(parsed) ? parsed : parsed.deviceProfiles;
    if (!Array.isArray(rawProfiles)) {
      throw new Error('--device-profiles must resolve to a JSON array or {"deviceProfiles": [...]}');
    }
  } else if (!strict && options.diagnosticSingleDevice) {
    rawProfiles = [{
      profileId: options.physicalPlaybackDeviceProfileId
        ?? MATRIX_DEFAULTS.physicalPlaybackDeviceProfileId,
      deviceClass: options.physicalPlaybackDeviceClass
        ?? MATRIX_DEFAULTS.physicalPlaybackDeviceClass,
      physicalPlaybackDeviceId: options.physicalPlaybackDeviceId
        ?? MATRIX_DEFAULTS.physicalPlaybackDeviceId,
      expectedPhysicalPlaybackDeviceName: options.expectedPhysicalPlaybackDeviceName
        ?? MATRIX_DEFAULTS.expectedPhysicalPlaybackDeviceName,
    }];
  } else {
    throw new Error(
      `--device-profiles is required for the strict matrix and must explicitly contain exactly: ${SUPPORTED_DEVICE_CLASSES.join(', ')}. Use --diagnostic-single-device only for a non-strict one-device diagnostic.`,
    );
  }
  if (rawProfiles.length === 0) {
    throw new Error('At least one physical playback device profile must be provided.');
  }

  const profileIds = new Set();
  const deviceClasses = new Set();
  const profiles = rawProfiles.map((profile, index) => {
    const profileId = String(profile?.profileId ?? '').trim();
    const deviceClass = String(profile?.deviceClass ?? '').trim();
    const physicalPlaybackDeviceId = String(profile?.physicalPlaybackDeviceId ?? '').trim();
    const expectedPhysicalPlaybackDeviceName = String(
      profile?.expectedPhysicalPlaybackDeviceName ?? '',
    ).trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(profileId)) {
      throw new Error(`device profile ${index} has an invalid profileId '${profileId}'`);
    }
    if (!SUPPORTED_DEVICE_CLASSES.includes(deviceClass)) {
      throw new Error(`device profile ${profileId} has unsupported deviceClass '${deviceClass}'`);
    }
    if (!physicalPlaybackDeviceId) {
      throw new Error(`device profile ${profileId} is missing physicalPlaybackDeviceId`);
    }
    if (deviceClass !== 'default-speaker' && physicalPlaybackDeviceId === 'default') {
      throw new Error(`device profile ${profileId} must use an explicit endpoint id for ${deviceClass}`);
    }
    if (deviceClass !== 'default-speaker' && !expectedPhysicalPlaybackDeviceName) {
      throw new Error(`device profile ${profileId} must include expectedPhysicalPlaybackDeviceName for ${deviceClass}`);
    }
    if (profileIds.has(profileId)) {
      throw new Error(`duplicate device profileId '${profileId}'`);
    }
    if (deviceClasses.has(deviceClass)) {
      throw new Error(`duplicate deviceClass '${deviceClass}' in --device-profiles`);
    }
    profileIds.add(profileId);
    deviceClasses.add(deviceClass);
    return {
      profileId,
      deviceClass,
      physicalPlaybackDeviceId,
      expectedPhysicalPlaybackDeviceName,
    };
  });
  if (strict) {
    const missingClasses = SUPPORTED_DEVICE_CLASSES.filter(
      (deviceClass) => !deviceClasses.has(deviceClass),
    );
    if (profiles.length !== SUPPORTED_DEVICE_CLASSES.length || missingClasses.length > 0) {
      throw new Error(
        `strict --device-profiles must contain exactly one profile for each device class: ${SUPPORTED_DEVICE_CLASSES.join(', ')}; missing=${missingClasses.join(',') || '-'} count=${profiles.length}`,
      );
    }
  } else if (options.diagnosticSingleDevice && profiles.length !== 1) {
    throw new Error('--diagnostic-single-device requires exactly one device profile.');
  }
  return profiles;
};

export const resolveWatchRealtimeProtocol = (model, aliasModel = '', aliasProtocol = '') => {
  if (model === aliasModel && aliasModel) return aliasProtocol;
  return WATCH_MODEL_PROTOCOLS[model] ?? '';
};

// Enabled switches are emitted bare because Windows PowerShell 5.1 -File
// rejects the '-Switch:$true' literal form with a SwitchParameter binding error.
export const buildRunnerArgv = ({
  model,
  watchRealtimeProtocol = '',
  feedbackMode,
  outputRoot = MATRIX_DEFAULTS.outputRoot,
  mediaPath = MATRIX_DEFAULTS.mediaPath,
  warmupSeconds = MATRIX_DEFAULTS.warmupSeconds,
  playbackSeconds = MATRIX_DEFAULTS.playbackSeconds,
  postPlaybackWaitSeconds = MATRIX_DEFAULTS.postPlaybackWaitSeconds,
  sessionReadyTimeoutSeconds = MATRIX_DEFAULTS.sessionReadyTimeoutSeconds,
  watchAutoStopAfterSeconds = MATRIX_DEFAULTS.watchAutoStopAfterSeconds,
  physicalPlaybackDeviceId = MATRIX_DEFAULTS.physicalPlaybackDeviceId,
  physicalPlaybackDeviceClass = MATRIX_DEFAULTS.physicalPlaybackDeviceClass,
  physicalPlaybackDeviceProfileId = MATRIX_DEFAULTS.physicalPlaybackDeviceProfileId,
  expectedPhysicalPlaybackDeviceName = MATRIX_DEFAULTS.expectedPhysicalPlaybackDeviceName,
  skipDesktopLaunch = false,
  skipDriverRepair = false,
  allowDriverRepair = false,
  useDefaultEndpointPlayback = false,
  stopDesktopAfterPlayback = false,
  allowElevatedDesktopLaunch = false,
  skipPhysicalOutputContentStt = false,
  runnerArgs = [],
}) => {
  const argv = [
    '-OutputRoot', outputRoot,
    '-MediaPath', mediaPath,
    '-WarmupSeconds', String(warmupSeconds),
    '-WatchModelId', model,
    '-PlaybackSeconds', String(playbackSeconds),
    '-PostPlaybackWaitSeconds', String(postPlaybackWaitSeconds),
    '-SessionReadyTimeoutSeconds', String(sessionReadyTimeoutSeconds),
    '-WatchAutoStopAfterSeconds', String(watchAutoStopAfterSeconds),
    '-PhysicalPlaybackDeviceId', physicalPlaybackDeviceId,
    '-PhysicalPlaybackDeviceClass', physicalPlaybackDeviceClass,
    '-PhysicalPlaybackDeviceProfileId', physicalPlaybackDeviceProfileId,
    '-FeedbackLoopPrevention', feedbackMode,
    '-ExpectedPhysicalPlaybackDeviceName', expectedPhysicalPlaybackDeviceName,
  ];
  if (watchRealtimeProtocol) argv.push('-WatchRealtimeProtocol', watchRealtimeProtocol);
  if (skipDesktopLaunch) argv.push('-SkipDesktopLaunch');
  if (skipDriverRepair) argv.push('-SkipDriverRepair');
  if (allowDriverRepair) argv.push('-AllowDriverRepair');
  if (useDefaultEndpointPlayback) argv.push('-UseDefaultEndpointPlayback');
  if (stopDesktopAfterPlayback) argv.push('-StopDesktopAfterPlayback');
  if (allowElevatedDesktopLaunch) argv.push('-AllowElevatedDesktopLaunch');
  if (skipPhysicalOutputContentStt) argv.push('-SkipPhysicalOutputContentStt');
  return [...argv, ...runnerArgs];
};

export const runnerArgsRequestDryRun = (runnerArgs = []) => runnerArgs.some(
  (argument) => /^[-/]dryrun(?::.*)?$/i.test(String(argument).trim()),
);

export const assertLiveMatrixRunnerArgs = (runnerArgs = []) => {
  if (runnerArgsRequestDryRun(runnerArgs)) {
    throw new Error(
      'The Watch Mode matrix rejects -DryRun because fixture reports are mode=dry-run and are not release evidence. Use npm run test:watch-mode-live:dry-run for runner self-tests.',
    );
  }
};

export const assertStrictEvidenceOptions = (options = {}) => {
  const weakened = [];
  if (options.skipDesktopLaunch) weakened.push('--skip-desktop-launch');
  if (options.useDefaultEndpointPlayback) weakened.push('--use-default-endpoint-playback');
  if (options.skipPhysicalOutputContentStt) weakened.push('--skip-physical-output-content-stt');
  if (Number(options.playbackSeconds ?? MATRIX_DEFAULTS.playbackSeconds) !== 0) {
    weakened.push('--playback-seconds must remain 0 (complete canonical media)');
  }
  const forbiddenRunnerSwitches = new Set([
    'dryrun',
    'skipdesktoplaunch',
    'usedefaultendpointplayback',
    'skipphysicaloutputcontentstt',
  ]);
  for (const argument of options.runnerArgs ?? []) {
    const normalized = String(argument).trim().replace(/^[-/]+/, '').split(':', 1)[0].toLowerCase();
    if (forbiddenRunnerSwitches.has(normalized)) weakened.push(`runner switch ${argument}`);
  }
  if (weakened.length > 0) {
    throw new Error(`strict Watch Mode authority rejects evidence-weakening options: ${weakened.join(', ')}`);
  }
};

export const assertStrictMatrixProvenance = (provenance, expectedHeadCommit = null) => {
  const shapeFailure = gitProvenanceShapeFailure(provenance, 'strict matrix source provenance');
  if (shapeFailure) {
    throw new Error(`strict Watch Mode matrix requires an exact clean git checkout: ${shapeFailure}`);
  }
  if (expectedHeadCommit && provenance.headCommit !== expectedHeadCommit) {
    throw new Error(
      `strict Watch Mode matrix source changed during the run: start HEAD ${expectedHeadCommit} does not exactly match completion HEAD ${provenance.headCommit}`,
    );
  }
  return provenance;
};

export const assertStrictMediaPath = (mediaPath) => {
  const requested = path.resolve(repoRoot, mediaPath);
  const canonical = path.resolve(repoRoot, MATRIX_DEFAULTS.mediaPath);
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (normalize(requested) !== normalize(canonical)) {
    throw new Error(`strict Watch Mode matrix requires the canonical reference media ${MATRIX_DEFAULTS.mediaPath}; got ${mediaPath}`);
  }
  return canonical;
};

export const buildStrictRuntimeAuthority = ({
  run = spawnSync,
  environment = strictRuntimeEnvironment(process.env),
} = {}) => {
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  for (const args of STRICT_RUNTIME_BUILD_COMMANDS) {
    const result = run(npmExecutable, [...args], {
      cwd: repoRoot,
      stdio: 'inherit',
      windowsHide: true,
      env: environment,
    });
    if (result.error) {
      throw new Error(`strict runtime build failed to start: npm ${args.join(' ')}: ${result.error.message}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`strict runtime build failed with exit code ${result.status ?? 1}: npm ${args.join(' ')}`);
    }
  }
  const diagnosticBuild = run('cargo.exe', [...STRICT_RUNTIME_DIAGNOSTIC_BUILD], {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: environment,
  });
  if (diagnosticBuild.error) {
    throw new Error(`strict runtime diagnostic build failed to start: ${diagnosticBuild.error.message}`);
  }
  if ((diagnosticBuild.status ?? 1) !== 0) {
    throw new Error(`strict runtime diagnostic build failed with exit code ${diagnosticBuild.status ?? 1}`);
  }
  return currentAuthorityRuntimeBinaryHashes();
};

export function strictRuntimeEnvironment(baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  environment.CARGO_TARGET_DIR = path.join(repoRoot, 'target');
  delete environment.CARGO_BUILD_TARGET;
  delete environment.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER;
  return environment;
}

export const runStrictProviderPreflight = ({
  providerId = MATRIX_DEFAULTS.providerId,
  provenance,
  environment = process.env,
  run = spawnSync,
  now = new Date(),
  exists = fs.existsSync,
  readEmitter = (candidate) => (fs.existsSync(candidate)
    ? JSON.parse(fs.readFileSync(candidate, 'utf8'))
    : null),
} = {}) => {
  const executablePath = path.join(repoRoot, 'target', 'release', 'omni-desktop-shell.exe');
  if (!exists(executablePath)) {
    throw new Error(`strict provider preflight Desktop executable is missing: ${executablePath}`);
  }
  const outputDirectory = path.join(
    repoRoot,
    'artifacts',
    'testing',
    'watch-mode-provider-preflight',
    now.toISOString().replace(/[-:.TZ]/g, ''),
  );
  const result = run(executablePath, [], {
    cwd: path.dirname(executablePath),
    env: {
      ...environment,
      OMNI_RELEASE_EVIDENCE_SCENARIO: 'E2E-PROVIDER-PROBE',
      OMNI_RELEASE_EVIDENCE_OUTPUT_DIRECTORY: outputDirectory,
      OMNI_RELEASE_EVIDENCE_HEAD_COMMIT: provenance.headCommit,
      OMNI_RELEASE_EVIDENCE_PROVIDER_ID: providerId,
      OMNI_LOG_LEVEL: 'debug',
    },
    encoding: 'utf8',
    windowsHide: false,
    timeout: 300_000,
  });
  const emitterPath = path.join(outputDirectory, 'emitter-result.json');
  const emitter = readEmitter(emitterPath);
  if ((result.status ?? 1) !== 0 || emitter?.status !== 'completed') {
    const detail = emitter?.error ?? result.error?.message ?? result.stderr ?? `exit=${result.status ?? 1}`;
    throw new Error(
      `strict paid-cell provider preflight failed for ${providerId}; no local or paid matrix cells were started: ${detail}`,
    );
  }
  return { providerId, outputDirectory, emitterPath };
};

function assertRuntimeBinaryContinuity(recorded, stage) {
  const current = currentAuthorityRuntimeBinaryHashes();
  if (!sameAuthorityInventory(recorded, current)) {
    throw new Error(`strict Watch Mode runtime binaries changed ${stage}; discard the partial matrix and rebuild from the exact clean HEAD`);
  }
}

export const writeMatrixRunManifest = ({
  outputRoot,
  modelList,
  feedbackModeList,
  deviceProfiles,
  runDirectories,
  strict,
  now = new Date(),
  provenance = currentGitProvenance({ cwd: repoRoot }),
  authorityRuntimeBinaryHashes,
  releaseCells = null,
  localIsolationAuthority = null,
}) => {
  if (strict) assertStrictMatrixProvenance(provenance);
  const resolvedOutputRoot = path.resolve(repoRoot, outputRoot);
  fs.mkdirSync(resolvedOutputRoot, { recursive: true });
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, '');
  const manifestPath = path.join(
    resolvedOutputRoot,
    `watch-mode-live-matrix-${timestamp}-${process.pid}.json`,
  );
  const plannedLiveCells = strict ? (releaseCells ?? LIVE_LLM_CELLS) : null;
  const expectedRunCount = strict
    ? plannedLiveCells.length
    : modelList.length * feedbackModeList.length * deviceProfiles.length;
  if (runDirectories.length !== expectedRunCount) {
    throw new Error(`matrix manifest has ${runDirectories.length} run directories; expected ${expectedRunCount}`);
  }
  const implementationHashes = strict ? currentAuthorityImplementationHashes() : null;
  const runtimeBinaryHashes = strict
    ? (authorityRuntimeBinaryHashes ?? currentAuthorityRuntimeBinaryHashes())
    : null;
  const cells = [];
  const deviceProfileByClass = new Map(deviceProfiles.map((profile) => [profile.deviceClass, profile]));
  const manifestCells = strict
    ? plannedLiveCells
    : modelList.flatMap((modelId) => feedbackModeList.flatMap((feedbackLoopPrevention) => (
      deviceProfiles.map((deviceProfile) => ({
        modelId,
        feedbackLoopPrevention,
        deviceClass: deviceProfile.deviceClass,
      }))
    )));
  for (let runIndex = 0; runIndex < manifestCells.length; runIndex += 1) {
    const plannedCell = manifestCells[runIndex];
    const deviceProfile = deviceProfileByClass.get(plannedCell.deviceClass);
    if (!deviceProfile) {
      throw new Error(`matrix cell ${plannedCell.cellId ?? runIndex} has no device profile for ${plannedCell.deviceClass}`);
    }
        if (strict) {
          cells.push(writeCellAuthorityReceipt({
            outputRoot: resolvedOutputRoot,
            runDirectory: runDirectories[runIndex],
            matrixCell: {
              cellId: plannedCell.cellId,
              tier: plannedCell.tier,
              providerMode: plannedCell.providerMode,
              durationSeconds: plannedCell.durationSeconds,
              modelId: plannedCell.modelId,
              feedbackLoopPrevention: plannedCell.feedbackLoopPrevention,
              deviceClass: deviceProfile.deviceClass,
              deviceProfileId: deviceProfile.profileId,
            },
            provenance,
            implementationHashes,
            runtimeBinaryHashes,
            now,
          }));
        }
  }
  const scopedRunDirectories = strict
    ? cells.map((cell) => cell.runDirectory)
    : runDirectories;
  const manifest = {
    schemaVersion: strict ? STRICT_MATRIX_SCHEMA_VERSION : 1,
    ...(strict ? { artifactKind: STRICT_MATRIX_ARTIFACT_KIND } : {}),
    generatedAt: now.toISOString(),
    evidenceMode: 'live',
    strict: Boolean(strict),
    provenance,
    models: modelList,
    feedbackLoopPreventionModes: feedbackModeList,
    deviceProfiles,
    runDirectories: scopedRunDirectories,
    ...(strict
      ? {
          validationPlan: BALANCED_RELEASE_PLAN,
          localIsolation: localIsolationAuthority,
          authority: {
            runner: MATRIX_RUNNER_ID,
            collector: LIVE_RUN_COLLECTOR_ID,
            implementationHashes,
            runtimeBinaryHashes,
          },
          cells,
        }
      : {}),
  };
  const temporaryPath = `${manifestPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, manifestPath);
  return { manifestPath, manifest };
};

export const publishSuccessfulStrictMatrixManifest = ({
  outputRoot,
  manifestPath,
  verifiedAt = new Date(),
  currentProvenance = currentGitProvenance({ cwd: repoRoot }),
  currentRuntimeBinaryHashes: providedRuntimeBinaryHashes,
}) => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  const provenanceFailure = exactGitProvenanceFailure(
    manifest.provenance,
    currentProvenance,
    {
      recordedSubject: 'verified matrix manifest provenance',
      currentSubject: 'canonical publish checkout provenance',
    },
  );
  if (provenanceFailure) {
    throw new Error(`refusing to publish canonical strict manifest: ${provenanceFailure}`);
  }
  const profileClasses = Array.isArray(manifest.deviceProfiles)
    ? manifest.deviceProfiles.map((profile) => profile.deviceClass)
    : [];
  const exactReleaseShape = manifest.strict === true
    && manifest.schemaVersion === STRICT_MATRIX_SCHEMA_VERSION
    && manifest.artifactKind === STRICT_MATRIX_ARTIFACT_KIND
    && manifest.evidenceMode === 'live'
    && balancedReleasePlanFailure(manifest.validationPlan) === null
    && manifest.localIsolation?.manifestPath
    && manifest.localIsolation?.sha256
    && Number(manifest.localIsolation?.bytes) > 0
    && JSON.stringify(manifest.models) === JSON.stringify(DEFAULT_MODELS)
    && JSON.stringify(manifest.feedbackLoopPreventionModes) === JSON.stringify(DEFAULT_FEEDBACK_MODES)
    && manifest.runDirectories?.length === LIVE_LLM_CELLS.length
    && manifest.cells?.length === manifest.runDirectories?.length
    && profileClasses.length === SUPPORTED_DEVICE_CLASSES.length
    && SUPPORTED_DEVICE_CLASSES.every((deviceClass) => (
      profileClasses.filter((value) => value === deviceClass).length === 1
    ));
  if (!exactReleaseShape) {
    throw new Error(
      'refusing to publish canonical strict manifest: verified matrix is not the exact budget-approved balanced release plan',
    );
  }
  const uniqueRunDirectories = new Set(
    manifest.runDirectories.map((directory) => (
      process.platform === 'win32' ? String(directory).toLowerCase() : String(directory)
    )),
  );
  if (uniqueRunDirectories.size !== manifest.runDirectories.length) {
    throw new Error('refusing to publish canonical strict manifest: runDirectories are not unique');
  }
  const resolvedOutputRoot = path.resolve(repoRoot, outputRoot);
  const currentImplementationHashes = currentAuthorityImplementationHashes();
  const currentRuntimeBinaryHashes = providedRuntimeBinaryHashes
    ?? currentAuthorityRuntimeBinaryHashes();
  if (
    manifest.authority?.runner !== MATRIX_RUNNER_ID
    || manifest.authority?.collector !== LIVE_RUN_COLLECTOR_ID
    || !sameAuthorityInventory(
      manifest.authority?.implementationHashes,
      currentImplementationHashes,
    )
  ) {
    throw new Error('refusing to publish canonical strict manifest: runner/collector implementation authority does not match the current checkout');
  }
  if (!sameAuthorityInventory(manifest.authority?.runtimeBinaryHashes, currentRuntimeBinaryHashes)) {
    throw new Error('refusing to publish canonical strict manifest: runtime binary authority does not match the current release build');
  }
  for (let index = 0; index < manifest.cells.length; index += 1) {
    const cell = manifest.cells[index];
    if (cell.runDirectory !== manifest.runDirectories[index]) {
      throw new Error(`refusing to publish canonical strict manifest: cell ${index} runDirectory does not match runDirectories`);
    }
    const expectedReceiptPath = `${cell.runDirectory}/${CELL_AUTHORITY_FILE}`;
    validateFileAuthorityEntry(
      resolvedOutputRoot,
      {
        path: cell.receiptPath,
        bytes: cell.receiptBytes,
        sha256: cell.receiptSha256,
      },
      expectedReceiptPath,
      `strict matrix cell ${index} receipt`,
    );
    const receiptPath = resolveAuthorityPath(resolvedOutputRoot, expectedReceiptPath);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!sameAuthorityInventory(receipt.implementationHashes, currentImplementationHashes)) {
      throw new Error(`refusing to publish canonical strict manifest: cell ${index} implementation hashes do not match the current checkout`);
    }
    if (!sameAuthorityInventory(receipt.runtimeBinaryHashes, currentRuntimeBinaryHashes)) {
      throw new Error(`refusing to publish canonical strict manifest: cell ${index} runtime binaries do not match the current release build`);
    }
  }
  const verificationReceiptPath = strictMatrixVerificationReceiptPath(manifestPath);
  const verification = validateStrictMatrixVerificationReceipt({
    receiptPath: verificationReceiptPath,
    manifestPath,
    manifest,
    currentProvenance,
    implementationHashes: currentImplementationHashes,
    runtimeBinaryHashes: currentRuntimeBinaryHashes,
  });
  const verifiedAuthority = verifyStrictMatrixAuthority({
    manifestPath,
    manifest,
    evidenceRoot: resolvedOutputRoot,
    currentProvenance,
    workspaceRoot: repoRoot,
    currentRuntimeBinaryHashes,
  });
  const evidence = findWatchModeEvidence({
    root: resolvedOutputRoot,
    strict: true,
    models: DEFAULT_MODELS,
    feedbackModes: DEFAULT_FEEDBACK_MODES,
    deviceClasses: SUPPORTED_DEVICE_CLASSES,
    releaseCells: LIVE_LLM_CELLS,
    runDirectories: verifiedAuthority.runDirectories,
    authorizedReports: verifiedAuthority.authorizedReports,
    currentProvenance,
    workspaceRoot: repoRoot,
  });
  if (!evidence.ok) {
    throw new Error(
      `refusing to publish canonical strict manifest: raw authority re-verification failed: ${evidence.reason ?? 'unknown strict matrix failure'}`,
    );
  }
  const canonicalPath = path.join(resolvedOutputRoot, CANONICAL_STRICT_MATRIX_MANIFEST);
  const sourceManifestAuthority = fileAuthorityEntry(
    path.resolve(manifestPath),
    path.basename(manifestPath),
  );
  const canonicalManifest = {
    ...manifest,
    verification: 'passed',
    verifiedAt: verification.receipt.verifiedAt,
    verificationProvenance: currentProvenance,
    sourceManifest: path.basename(manifestPath),
    sourceManifestSha256: sourceManifestAuthority.sha256,
    sourceManifestBytes: sourceManifestAuthority.bytes,
    verificationReceiptPath: path.basename(verificationReceiptPath),
    verificationReceiptSha256: fileAuthorityEntry(
      verificationReceiptPath,
      path.basename(verificationReceiptPath),
    ).sha256,
    verificationReceiptBytes: fs.statSync(verificationReceiptPath).size,
  };
  const temporaryPath = `${canonicalPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(canonicalManifest, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, canonicalPath);
  return { canonicalPath, manifest: canonicalManifest };
};

export const buildVerifyArgv = (
  outputRoot,
  modelList,
  feedbackModeList,
  deviceClassList,
  runManifest,
  { strict = true } = {},
) => {
  if (typeof runManifest !== 'string' || !runManifest.trim()) {
    throw new Error('evidence verifier requires the current matrix run manifest');
  }
  return [
    './scripts/testing/verify-watch-mode-evidence.mjs',
    '--root', outputRoot,
    ...(strict ? ['--strict'] : []),
    '--models', modelList.join(','),
    '--feedback-modes', feedbackModeList.join(','),
    ...(strict && deviceClassList.length > 0
      ? ['--device-classes', deviceClassList.join(',')]
      : []),
    '--run-manifest', runManifest,
  ];
};

export const lastNonEmptyLine = (text) => {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
};

// The runner's success stream can pick up trailing Write-Warning lines from
// spawned powershell cleanup, so prefer the last line that names a directory
// that actually exists over the raw last line.
export const lastRunDirectoryLine = (text, rootDir = repoRoot) => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = path.isAbsolute(lines[index]) ? lines[index] : path.join(rootDir, lines[index]);
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return lines[index];
      }
    } catch {
      /* not a path */
    }
  }
  return undefined;
};

const runLiveRunner = (runnerArgv, timeoutMs, environment = process.env) => new Promise((resolve, reject) => {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RUNNER_SCRIPT, ...runnerArgv],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'], env: environment },
  );
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    process.stderr.write(chunk);
  });
  const timeout = setTimeout(() => {
    if (isWindows && child.pid) {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/F', '/T'], {
        cwd: repoRoot,
        stdio: 'ignore',
        timeout: LIVE_RUNNER_TERMINATION_GRACE_MS,
      });
    } else {
      child.kill('SIGKILL');
    }
    child.stdout.destroy();
    resolve({ exitCode: 124, stdout });
  }, timeoutMs);
  child.once('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  // Resolve on the PowerShell process exit instead of `close`: a degraded
  // bridge descendant can inherit stdout and keep the pipe open after the
  // runner itself has already exited. Destroying our read side prevents that
  // unrelated process from hanging the matrix indefinitely.
  child.once('exit', (exitCode) => {
    clearTimeout(timeout);
    child.stdout.destroy();
    resolve({ exitCode: exitCode ?? 1, stdout });
  });
});

export const runMatrix = async (options) => {
  assertLiveMatrixRunnerArgs(options.runnerArgs);
  const strict = !Boolean(options.diagnosticSingleDevice);
  const { modelList: configuredModels, feedbackModeList } = resolveMatrixLists(options);
  const deviceProfiles = resolveDeviceProfiles(options, { strict });
  const modelList = [...configuredModels];
  const aliasModel = String(options.aliasModel ?? '').trim();
  const aliasProtocol = String(options.aliasProtocol ?? '').trim();
  if (aliasModel && !modelList.includes(aliasModel)) modelList.push(aliasModel);
  if (aliasModel && !['dashscope-omni', 'dashscope-livetranslate', 'dashscope-asr', 'openai-conversation', 'openai-translation', 'openai-transcription', 'openai-flat', 'gemini-live'].includes(aliasProtocol)) {
    throw new Error(`Unsupported alias realtime protocol: ${aliasProtocol}`);
  }
  if (strict) {
    assertStrictReleaseMatrixLists({ modelList, feedbackModeList });
    assertStrictMediaPath(options.mediaPath ?? MATRIX_DEFAULTS.mediaPath);
    assertStrictEvidenceOptions(options);
  }
  const startProvenance = strict
    ? assertStrictMatrixProvenance(currentGitProvenance({ cwd: repoRoot }))
    : null;
  const runtimeBinaryHashes = strict ? buildStrictRuntimeAuthority() : null;
  const liveRunnerEnvironment = strict ? strictRuntimeEnvironment(process.env) : process.env;
  if (strict) {
    const postBuildProvenance = assertStrictMatrixProvenance(
      currentGitProvenance({ cwd: repoRoot }),
      startProvenance.headCommit,
    );
    const postBuildFailure = exactGitProvenanceFailure(startProvenance, postBuildProvenance, {
      recordedSubject: 'strict matrix pre-build provenance',
      currentSubject: 'strict matrix post-build provenance',
    });
    if (postBuildFailure) {
      throw new Error(`strict Watch Mode release build changed source provenance: ${postBuildFailure}`);
    }
    console.error(`==> Preflighting paid-cell provider ${options.providerId}`);
    runStrictProviderPreflight({
      providerId: options.providerId,
      provenance: startProvenance,
      environment: liveRunnerEnvironment,
    });
  }
  let localIsolationAuthority = null;
  if (strict) {
    console.error('==> Running zero-LLM local isolation layer (3 routes x 3 device classes x 5 minutes)');
    const localIsolation = await runLocalIsolationMatrix({
      deviceProfiles,
      workspaceRoot: repoRoot,
      provenance: startProvenance,
    });
    verifyLocalIsolationManifest({
      manifestPath: localIsolation.manifestPath,
      workspaceRoot: repoRoot,
      provenance: startProvenance,
      runtimeBinaryHashes,
    });
    const manifestStats = fs.statSync(localIsolation.manifestPath);
    localIsolationAuthority = {
      manifestPath: path.relative(repoRoot, localIsolation.manifestPath).split(path.sep).join('/'),
      bytes: manifestStats.size,
      sha256: fileAuthorityEntry(
        localIsolation.manifestPath,
        path.basename(localIsolation.manifestPath),
      ).sha256,
    };
  }
  const runDirectories = [];
  const deviceProfileByClass = new Map(deviceProfiles.map((profile) => [profile.deviceClass, profile]));
  const executionCells = strict
    ? LIVE_LLM_CELLS
    : modelList.flatMap((model) => feedbackModeList.flatMap((feedbackMode) => (
      deviceProfiles.map((deviceProfile) => ({
        modelId: model,
        feedbackLoopPrevention: feedbackMode,
        deviceClass: deviceProfile.deviceClass,
        durationSeconds: options.watchAutoStopAfterSeconds,
      }))
    )));
  for (const plannedCell of executionCells) {
        const model = plannedCell.modelId;
        const feedbackMode = plannedCell.feedbackLoopPrevention;
        const deviceProfile = deviceProfileByClass.get(plannedCell.deviceClass);
        if (!deviceProfile) {
          throw new Error(`Watch Mode cell ${plannedCell.cellId ?? '-'} has no device profile for ${plannedCell.deviceClass}`);
        }
        console.error(`==> Running Watch Mode live ${strict ? 'strict matrix' : 'non-strict single-device diagnostic'} model: ${model} feedbackLoopPrevention: ${feedbackMode} device: ${deviceProfile.profileId}[${deviceProfile.deviceClass}]`);
        const watchRealtimeProtocol = resolveWatchRealtimeProtocol(model, aliasModel, aliasProtocol);
        const runnerOptions = {
          ...options,
          ...deviceProfile,
          model,
          feedbackMode,
          watchRealtimeProtocol,
          physicalPlaybackDeviceClass: deviceProfile.deviceClass,
          physicalPlaybackDeviceProfileId: deviceProfile.profileId,
          watchAutoStopAfterSeconds: plannedCell.durationSeconds,
        };
        const { exitCode, stdout } = await runLiveRunner(
          buildRunnerArgv(runnerOptions),
          resolveLiveRunnerTimeoutMs(runnerOptions),
          liveRunnerEnvironment,
        );
        if (exitCode !== 0) {
          throw new Error(`Watch Mode live run failed for model ${model} feedbackLoopPrevention ${feedbackMode} device ${deviceProfile.profileId}[${deviceProfile.deviceClass}] with exit code ${exitCode}`);
        }
        const runDirectory = lastRunDirectoryLine(stdout);
        if (runDirectory === undefined) {
          throw new Error(`Watch Mode live runner did not return an existing run directory for model ${model} feedbackLoopPrevention ${feedbackMode} device ${deviceProfile.profileId}[${deviceProfile.deviceClass}]`);
        }
        const resolvedRunDirectory = path.resolve(repoRoot, runDirectory);
        if (runDirectories.includes(resolvedRunDirectory)) {
          throw new Error(`Watch Mode live runner reused run directory ${resolvedRunDirectory}; every matrix cell requires its own artifact directory.`);
        }
        runDirectories.push(resolvedRunDirectory);
        if (strict) assertRuntimeBinaryContinuity(runtimeBinaryHashes, `during matrix cell ${model}/${feedbackMode}/${deviceProfile.profileId}`);
  }
  const outputRoot = options.outputRoot ?? MATRIX_DEFAULTS.outputRoot;
  const expectedRunCount = strict
    ? LIVE_LLM_CELLS.length
    : modelList.length * feedbackModeList.length * deviceProfiles.length;
  if (runDirectories.length !== expectedRunCount) {
    throw new Error(`Watch Mode matrix produced ${runDirectories.length} run directories; expected ${expectedRunCount}.`);
  }
  const completionProvenance = currentGitProvenance({ cwd: repoRoot });
  if (strict) {
    assertRuntimeBinaryContinuity(runtimeBinaryHashes, 'before authority manifest emission');
    assertStrictMatrixProvenance(completionProvenance, startProvenance.headCommit);
    const continuityFailure = exactGitProvenanceFailure(
      startProvenance,
      completionProvenance,
      {
        recordedSubject: 'strict matrix start provenance',
        currentSubject: 'strict matrix completion provenance',
      },
    );
    if (continuityFailure) {
      throw new Error(`strict Watch Mode matrix source provenance changed: ${continuityFailure}`);
    }
  }
  const { manifestPath } = writeMatrixRunManifest({
    outputRoot,
    modelList,
    feedbackModeList,
    deviceProfiles,
    runDirectories,
    strict,
    provenance: completionProvenance,
    authorityRuntimeBinaryHashes: runtimeBinaryHashes,
    releaseCells: strict ? LIVE_LLM_CELLS : null,
    localIsolationAuthority,
  });
  console.error(
    strict
      ? `==> Verifying strict Watch Mode evidence matrix from current-run manifest: ${manifestPath}`
      : `==> Verifying scoped non-strict single-device diagnostic: ${manifestPath}`,
  );
  const verifyResult = spawnSync(
    process.execPath,
    buildVerifyArgv(
      outputRoot,
      modelList,
      feedbackModeList,
      deviceProfiles.map((profile) => profile.deviceClass),
      manifestPath,
      { strict },
    ),
    { cwd: repoRoot, stdio: ['ignore', 2, 'inherit'] },
  );
  const verifyExitCode = verifyResult.status ?? 1;
  if (verifyExitCode !== 0) {
    throw new Error(`${strict ? 'strict Watch Mode evidence matrix' : 'non-strict Watch Mode single-device diagnostic'} failed with exit code ${verifyExitCode}`);
  }
  const canonicalManifest = strict
    ? publishSuccessfulStrictMatrixManifest({ outputRoot, manifestPath })
    : null;
  return {
    models: modelList,
    feedbackLoopPreventionModes: feedbackModeList,
    deviceProfiles,
    runDirectories,
    runManifest: manifestPath,
    canonicalRunManifest: canonicalManifest?.canonicalPath ?? null,
    strictEvidenceVerified: strict,
  };
};

if (isMain(import.meta.url)) {
  let options;
  try {
    options = parseMatrixCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(1);
  }
  if (!isWindows) {
    console.error('The Watch Mode live matrix requires Windows: run-watch-mode-live.ps1 P/Invokes CoreAudio/winmm and must run under powershell.exe.');
    process.exit(1);
  }
  try {
    const result = await runMatrix(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
