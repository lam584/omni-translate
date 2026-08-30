import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
  currentPaidAuthorityImplementationHashes,
  currentAuthorityRuntimeBinaryHashes,
  fileAuthorityEntry,
  relativeChildPath,
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
import { runLocalIsolationMatrix, verifyLocalIsolationManifest } from './watch-mode-local-isolation.mjs';
import {
  STRICT_PAID_MATRIX_MAX_INPUT_SAMPLES,
  assertCellExternalProviderBudget,
  assertMatrixExternalProviderBudget,
  reserveStrictPaidCellInputSamples,
  writeMatrixExternalProviderBudget,
} from './watch-mode-external-provider-budget.mjs';
import {
  SHARD_CELL_RESULT_FILE,
  SHARD_EXECUTION_PLAN_FILE,
  SHARD_MANIFEST_FILE,
} from './watch-mode-shard-authority.mjs';
import {
  COORDINATOR_AGGREGATE_FILE,
  COORDINATOR_PROVIDER_PREFLIGHT_FILE,
} from './run-watch-mode-live-coordinator.mjs';
import {
  PROVIDER_PREFLIGHT_COMPLETION_FILE,
  PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
  PROVIDER_PREFLIGHT_GRANT_FILE,
  PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
  validateProviderPreflightAuthorizationAuthorities,
  verifyProviderPreflightCompletion,
} from './watch-mode-provider-preflight-authorization.mjs';

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
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const renameRetryWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export function renameWithTransientRetrySync(
  sourcePath,
  destinationPath,
  {
    renameSync = fs.renameSync,
    sleepSync = (delayMs) => Atomics.wait(renameRetryWaitBuffer, 0, 0, delayMs),
    maxAttempts = 8,
    initialDelayMs = 20,
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      renameSync(sourcePath, destinationPath);
      return { attempts: attempt };
    } catch (error) {
      if (
        !TRANSIENT_RENAME_ERROR_CODES.has(error?.code)
        || attempt === maxAttempts
      ) throw error;
      sleepSync(Math.min(initialDelayMs * (2 ** (attempt - 1)), 200));
    }
  }
  throw new Error('atomic rename retry loop ended unexpectedly');
}

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
const RUNNER_ENTRY = path.join(repoRoot, 'scripts', 'testing', 'run-watch-mode-live.mjs');
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
                                                   the exact Watch Mode release model id
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
                                                    ${SUPPORTED_DEVICE_CLASSES.join(', ')} profile
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

export const buildRunnerRequest = (options) => {
  const feedbackMode = options.feedbackMode;
  return {
    schemaVersion: 'watch-mode-run-request/v1',
    runMode: 'live',
    authorityMode: options.strictPaidAuthority
      ? 'strict-paid'
      : options.localCanonicalContentAuthority ? 'local-canonical-smoke' : 'none',
    feedbackMode,
    desktop: {
      launchMode: 'managed',
      elevation: options.allowElevatedDesktopLaunch ? 'allow' : 'forbid',
    },
    driverPolicy: feedbackMode === 'virtual-driver'
      ? (options.allowDriverRepair ? 'repair-if-needed' : 'probe-only')
      : 'not-applicable',
    physicalContentMode: options.skipPhysicalOutputContentStt
      ? 'disabled'
      : (options.strictPaidAuthority || options.localCanonicalContentAuthority) ? 'local-canonical' : 'remote-stt',
    model: {
      id: options.model,
      protocol: options.watchRealtimeProtocol || '',
      subtitleTranslationMode: options.subtitleTranslationMode ?? 'native',
      subtitleModelId: options.subtitleTranslationModelId ?? null,
      secondaryAudioModelId: options.inboundSecondaryAudioModelId ?? null,
    },
    media: {
      path: options.mediaPath ?? MATRIX_DEFAULTS.mediaPath,
      playbackSeconds: Number(options.playbackSeconds ?? MATRIX_DEFAULTS.playbackSeconds),
    },
    physicalDevice: {
      id: options.physicalPlaybackDeviceId ?? MATRIX_DEFAULTS.physicalPlaybackDeviceId,
      class: options.physicalPlaybackDeviceClass ?? MATRIX_DEFAULTS.physicalPlaybackDeviceClass,
      profileId: options.physicalPlaybackDeviceProfileId ?? MATRIX_DEFAULTS.physicalPlaybackDeviceProfileId,
      expectedName: options.expectedPhysicalPlaybackDeviceName ?? MATRIX_DEFAULTS.expectedPhysicalPlaybackDeviceName,
    },
    timeouts: {
      warmupSeconds: Number(options.warmupSeconds ?? MATRIX_DEFAULTS.warmupSeconds),
      readinessSeconds: Number(options.sessionReadyTimeoutSeconds ?? MATRIX_DEFAULTS.sessionReadyTimeoutSeconds),
      sessionSeconds: Number(options.watchAutoStopAfterSeconds ?? MATRIX_DEFAULTS.watchAutoStopAfterSeconds),
      postPlaybackSeconds: Number(options.postPlaybackWaitSeconds ?? MATRIX_DEFAULTS.postPlaybackWaitSeconds),
    },
    paths: {
      outputRoot: options.outputRoot ?? MATRIX_DEFAULTS.outputRoot,
      runtimeRoot: options.runtimeRoot ?? path.join(process.env.LOCALAPPDATA ?? 'artifacts/diagnostics', 'OmniTranslate/diagnostics/logs'),
      workerReadinessReceipt: options.workerReadinessReceiptPath ?? null,
    },
    matrix: { cellId: options.cellId || null, leaseId: null },
  };
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
  if ((options.subtitleTranslationMode ?? 'native') !== 'native') {
    weakened.push('subtitle translation mode must remain native');
  }
  const forbiddenRunnerSwitches = new Set([
    'dryrun',
    'skipdesktoplaunch',
    'usedefaultendpointplayback',
    'skipphysicaloutputcontentstt',
    'subtitletranslationmode',
    'subtitletranslationmodelid',
    'inboundsecondaryaudiomodelid',
    'watchautostopafterseconds',
    'watchmodelid',
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
  const npmExecutable = process.platform === 'win32'
    ? (process.env.ComSpec || 'cmd.exe')
    : 'npm';
  for (const args of STRICT_RUNTIME_BUILD_COMMANDS) {
    // Node 24 rejects direct CreateProcess calls for .cmd shims with EINVAL.
    // Route the fixed npm command through cmd.exe without interpolating user
    // input so the strict Windows builder works on every supported Node line.
    const spawnArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm.cmd', ...args]
      : [...args];
    const result = run(npmExecutable, spawnArgs, {
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
  validateEvidence = null,
  expectedAuthorization = null,
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
  let raw = null;
  if (validateEvidence) {
    raw = validateEvidence(outputDirectory, 'E2E-PROVIDER-PROBE', {
      workspaceRoot: repoRoot,
      currentProvenance: provenance,
      now: now.getTime(),
      expectedAuthorization,
    });
    if (raw.issues.length > 0 || !raw.summary) {
      throw new Error(
        `strict provider preflight production authority failed before paid cells: ${raw.issues.join('; ')}`,
      );
    }
    if (
      expectedAuthorization
      && (
        raw.summary.executionId !== expectedAuthorization.executionId
        || raw.summary.grantDigest !== expectedAuthorization.grantDigest
        || raw.summary.authorizationDigest !== expectedAuthorization.authorizationDigest
        || JSON.stringify(raw.summary.leaseReservationDigests)
          !== JSON.stringify(expectedAuthorization.leaseReservationDigests)
      )
    ) throw new Error('strict provider preflight did not consume the signed authorization');
  }
  return { providerId, outputDirectory, emitterPath, raw };
};

function portablePath(value) {
  return value.split(path.sep).join('/');
}

function assertSafeStageName(value, label) {
  const name = String(value ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)) {
    throw new Error(`${label} must be a simple portable identifier`);
  }
  return name;
}

function copyRegularAuthorityTree(sourceDirectory, destinationDirectory) {
  const source = path.resolve(sourceDirectory);
  const sourceStats = fs.lstatSync(source);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new Error(`guest shard source must be a non-symlink directory: ${source}`);
  }
  fs.mkdirSync(destinationDirectory, { recursive: false });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    const stats = fs.lstatSync(sourcePath);
    if (stats.isSymbolicLink()) throw new Error(`guest shard authority may not contain symlinks: ${sourcePath}`);
    if (stats.isDirectory()) {
      copyRegularAuthorityTree(sourcePath, destinationPath);
    } else if (stats.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    } else {
      throw new Error(`guest shard authority contains an unsupported filesystem entry: ${sourcePath}`);
    }
  }
}

function copyRegularAuthorityFile(sourcePath, destinationPath, label) {
  const source = path.resolve(sourcePath);
  const stats = fs.lstatSync(source);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink file: ${source}`);
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(source, destinationPath, fs.constants.COPYFILE_EXCL);
}

/**
 * Stage immutable coordinator and guest artifacts beneath one evidence root,
 * then construct the exact projection consumed by writeMatrixRunManifest and
 * independently rebuilt by the strict verifier. Absolute VM paths never enter
 * the persisted authority.
 */
export function stageShardMatrixIntegration({
  evidenceRoot,
  executionRootName,
  planPath,
  leasePaths,
  coordinatorAggregatePath,
  shards,
  collectedMatrixIntegration,
}) {
  const resolvedEvidenceRoot = path.resolve(evidenceRoot);
  fs.mkdirSync(resolvedEvidenceRoot, { recursive: true });
  const stageName = assertSafeStageName(executionRootName, 'shard execution root name');
  const finalExecutionRoot = path.join(resolvedEvidenceRoot, stageName);
  if (fs.existsSync(finalExecutionRoot)) {
    throw new Error(`refusing to overwrite staged shard execution root: ${finalExecutionRoot}`);
  }
  if (!Array.isArray(leasePaths) || leasePaths.length !== LIVE_LLM_CELLS.length) {
    throw new Error(`shard staging requires exactly ${LIVE_LLM_CELLS.length} signed lease files`);
  }
  if (!Array.isArray(shards) || shards.length !== 1) {
    throw new Error('strict staging requires exactly one local shard root');
  }
  const temporaryRoot = `${finalExecutionRoot}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.staging`;
  fs.mkdirSync(temporaryRoot, { recursive: false });
  try {
    const sourceExecutionRoot = path.dirname(path.resolve(planPath));
    const sourcePlan = JSON.parse(fs.readFileSync(path.resolve(planPath), 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(sourcePlan.workers) || shards.length !== sourcePlan.workers.length) {
      throw new Error('shard staging guest root count must exactly match the signed plan worker count');
    }
    copyRegularAuthorityFile(planPath, path.join(temporaryRoot, SHARD_EXECUTION_PLAN_FILE), 'signed shard execution plan');
    const sourcePreflightAuthorization = validateProviderPreflightAuthorizationAuthorities({
      root: sourceExecutionRoot,
      grantAuthority: sourcePlan.providerPreflightGrant,
      leaseReservationAuthorities: sourcePlan.providerPreflightLeaseReservations,
      authorizationDigest: sourcePlan.providerPreflightAuthorization?.authorizationDigest,
      expected: {
        executionId: sourcePlan.executionId,
        provenance: sourcePlan.provenance,
        authorityImplementationHashes: sourcePlan.authority?.implementationHashes,
        runtimeBinaryHashes: sourcePlan.authority?.runtimeBinaryHashes,
        shardOrchestrationImplementationHashes:
          sourcePlan.authority?.shardOrchestrationImplementationHashes,
      },
    });
    if (
      sourcePlan.providerPreflightAuthorization?.grantDigest
        !== sourcePreflightAuthorization.grant.digest
      || JSON.stringify(sourcePlan.providerPreflightAuthorization?.leaseReservationDigests)
        !== JSON.stringify(sourcePreflightAuthorization.leaseReservations.map((entry) => entry.digest))
    ) throw new Error('signed plan provider preflight authorization projection mismatch');
    const grantReadinessRequestPath = validateFileAuthorityEntry(
      sourceExecutionRoot,
      sourcePreflightAuthorization.grant.workerReadinessRequestAuthority,
      'worker-readiness-request.json',
      'provider preflight grant worker readiness request',
    );
    copyRegularAuthorityFile(
      grantReadinessRequestPath,
      path.join(temporaryRoot, 'worker-readiness-request.json'),
      'provider preflight worker readiness request',
    );
    for (const readiness of sourcePreflightAuthorization.grant.workerReadinessAuthorities) {
      const expectedPath = `worker-readiness/${readiness.workerId}.json`;
      const readinessPath = validateFileAuthorityEntry(
        sourceExecutionRoot,
        readiness,
        expectedPath,
        `provider preflight worker ${readiness.workerId} readiness`,
      );
      copyRegularAuthorityFile(
        readinessPath,
        path.join(temporaryRoot, ...expectedPath.split('/')),
        `provider preflight worker ${readiness.workerId} readiness`,
      );
    }
    const sourcePreflightCompletionPath = validateFileAuthorityEntry(
      sourceExecutionRoot,
      sourcePlan.providerPreflightCompletion,
      PROVIDER_PREFLIGHT_COMPLETION_FILE,
      'signed-plan provider preflight completion',
    );
    const sourcePreflightCompletion = JSON.parse(
      fs.readFileSync(sourcePreflightCompletionPath, 'utf8').replace(/^\uFEFF/, ''),
    );
    verifyProviderPreflightCompletion(
      sourcePreflightCompletion,
      sourcePreflightAuthorization.grant,
      sourcePreflightAuthorization.leaseReservations,
    );
    copyRegularAuthorityFile(
      path.join(sourceExecutionRoot, PROVIDER_PREFLIGHT_GRANT_FILE),
      path.join(temporaryRoot, PROVIDER_PREFLIGHT_GRANT_FILE),
      'provider preflight grant',
    );
    const stagedPreflightReservationRoot = path.join(
      temporaryRoot,
      PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
    );
    fs.mkdirSync(stagedPreflightReservationRoot);
    for (const entry of sourcePlan.providerPreflightLeaseReservations) {
      copyRegularAuthorityFile(
        path.join(sourceExecutionRoot, ...entry.path.split('/')),
        path.join(temporaryRoot, ...entry.path.split('/')),
        'provider preflight lease reservation',
      );
    }
    copyRegularAuthorityFile(
      sourcePreflightCompletionPath,
      path.join(temporaryRoot, PROVIDER_PREFLIGHT_COMPLETION_FILE),
      'provider preflight completion',
    );
    const sourcePreflightConsumptionClaimPath = validateFileAuthorityEntry(
      sourceExecutionRoot,
      sourcePlan.providerPreflightAuthorization?.consumptionClaim,
      PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
      'signed-plan provider preflight consumption claim',
    );
    copyRegularAuthorityFile(
      sourcePreflightConsumptionClaimPath,
      path.join(temporaryRoot, PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE),
      'provider preflight consumption claim',
    );
    const sourcePreflightReceiptPath = validateFileAuthorityEntry(
      sourceExecutionRoot,
      sourcePlan.providerPreflightAuthority,
      COORDINATOR_PROVIDER_PREFLIGHT_FILE,
      'signed-plan provider preflight receipt',
    );
    const sourcePreflightReceipt = JSON.parse(
      fs.readFileSync(sourcePreflightReceiptPath, 'utf8').replace(/^\uFEFF/, ''),
    );
    const sourcePreflightEvidencePath = validateFileAuthorityEntry(
      sourceExecutionRoot,
      sourcePreflightReceipt.evidenceAuthority,
      sourcePreflightReceipt.evidenceAuthority?.path,
      'provider preflight raw evidence',
    );
    const sourcePreflightRawRoot = resolveAuthorityPath(
      sourceExecutionRoot,
      sourcePreflightReceipt.rawEvidenceRoot,
      'provider preflight raw evidence root',
    );
    const sourcePreflightRawStats = fs.lstatSync(sourcePreflightRawRoot);
    if (!sourcePreflightRawStats.isDirectory() || sourcePreflightRawStats.isSymbolicLink()) {
      throw new Error('provider preflight raw evidence root must be a real non-symlink directory');
    }
    copyRegularAuthorityFile(
      sourcePreflightReceiptPath,
      path.join(temporaryRoot, COORDINATOR_PROVIDER_PREFLIGHT_FILE),
      'provider preflight receipt',
    );
    copyRegularAuthorityFile(
      sourcePreflightEvidencePath,
      path.join(temporaryRoot, ...sourcePreflightReceipt.evidenceAuthority.path.replaceAll('\\', '/').split('/')),
      'provider preflight raw evidence',
    );
    copyRegularAuthorityTree(
      sourcePreflightRawRoot,
      path.join(temporaryRoot, ...sourcePreflightReceipt.rawEvidenceRoot.replaceAll('\\', '/').split('/')),
    );
    const leaseDirectory = path.join(temporaryRoot, 'leases');
    fs.mkdirSync(leaseDirectory);
    const stagedLeasePaths = leasePaths.map((leasePath) => {
      const destination = path.join(leaseDirectory, path.basename(leasePath));
      copyRegularAuthorityFile(leasePath, destination, 'signed shard cell lease');
      return destination;
    });
    copyRegularAuthorityFile(
      coordinatorAggregatePath,
      path.join(temporaryRoot, COORDINATOR_AGGREGATE_FILE),
      'shard coordinator aggregate',
    );
    const shardDirectory = path.join(temporaryRoot, 'shards');
    fs.mkdirSync(shardDirectory);
    const stagedByWorker = new Map();
    for (const shard of shards) {
      const workerId = assertSafeStageName(shard.workerId, 'shard workerId');
      if (stagedByWorker.has(workerId)) throw new Error(`duplicate guest shard worker ${workerId}`);
      const sourceRoot = path.resolve(shard.shardRoot);
      const destinationRoot = path.join(shardDirectory, workerId);
      copyRegularAuthorityTree(sourceRoot, destinationRoot);
      const sourceManifest = path.resolve(shard.manifestPath ?? path.join(sourceRoot, SHARD_MANIFEST_FILE));
      const manifestRelative = path.relative(sourceRoot, sourceManifest);
      if (!manifestRelative || manifestRelative.startsWith('..') || path.isAbsolute(manifestRelative)) {
        throw new Error(`guest shard manifest is outside shard root for ${workerId}`);
      }
      stagedByWorker.set(workerId, {
        sourceRoot,
        destinationRoot,
        manifestPath: path.join(destinationRoot, manifestRelative),
      });
    }
    renameWithTransientRetrySync(temporaryRoot, finalExecutionRoot);

    const stagedPlanPath = path.join(finalExecutionRoot, SHARD_EXECUTION_PLAN_FILE);
    const plan = JSON.parse(fs.readFileSync(stagedPlanPath, 'utf8').replace(/^\uFEFF/, ''));
    const stagedAggregatePath = path.join(finalExecutionRoot, COORDINATOR_AGGREGATE_FILE);
    const aggregate = JSON.parse(fs.readFileSync(stagedAggregatePath, 'utf8').replace(/^\uFEFF/, ''));
    const integrationByCell = new Map(
      (collectedMatrixIntegration?.cells ?? []).map((cell) => [cell.cellId, cell]),
    );
    const projections = [];
    const runDirectories = [];
    for (const [index, planCell] of plan.cells.entries()) {
      if (planCell.cellId !== LIVE_LLM_CELLS[index]?.cellId) {
        throw new Error(`staged shard plan cell ${index} is not in fixed release order`);
      }
      const collected = integrationByCell.get(planCell.cellId);
      const stagedShard = stagedByWorker.get(planCell.workerId);
      if (!collected || !stagedShard) throw new Error(`staged shard integration is missing ${planCell.cellId}`);
      const sourceRunDirectory = path.resolve(collected.sourceRunDirectory);
      const guestRunDirectory = path.relative(stagedShard.sourceRoot, sourceRunDirectory);
      if (!guestRunDirectory || guestRunDirectory.startsWith('..') || path.isAbsolute(guestRunDirectory)) {
        throw new Error(`guest cell ${planCell.cellId} run directory is outside its shard root`);
      }
      const finalRunDirectory = path.join(finalExecutionRoot, 'shards', planCell.workerId, guestRunDirectory);
      const resultPath = path.join(finalRunDirectory, SHARD_CELL_RESULT_FILE);
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, ''));
      const shardManifest = JSON.parse(fs.readFileSync(stagedShard.manifestPath.replace(temporaryRoot, finalExecutionRoot), 'utf8').replace(/^\uFEFF/, ''));
      const finalShardRoot = path.join(finalExecutionRoot, 'shards', planCell.workerId);
      const finalShardManifestPath = path.resolve(
        stagedShard.manifestPath.replace(temporaryRoot, finalExecutionRoot),
      );
      const runDirectoryRelative = relativeChildPath(resolvedEvidenceRoot, finalRunDirectory, 'staged guest run directory');
      const shardRootRelative = relativeChildPath(resolvedEvidenceRoot, finalShardRoot, 'staged guest shard root');
      const projection = {
        origin: 'guest-shard-result',
        executionId: plan.executionId,
        planDigest: plan.planDigest,
        cellIndex: planCell.cellIndex,
        cellId: planCell.cellId,
        workerId: planCell.workerId,
        vmIdentityDigest: planCell.vmIdentityDigest,
        waveIndex: planCell.waveIndex,
        leaseId: planCell.leaseId,
        leaseDigest: result.leaseDigest,
        shardRoot: shardRootRelative,
        shardManifest: {
          ...fileAuthorityEntry(
            finalShardManifestPath,
            relativeChildPath(resolvedEvidenceRoot, finalShardManifestPath, 'staged shard manifest'),
          ),
          manifestDigest: shardManifest.manifestDigest,
        },
        result: {
          ...fileAuthorityEntry(
            resultPath,
            relativeChildPath(resolvedEvidenceRoot, resultPath, 'staged shard cell result'),
          ),
          resultDigest: result.resultDigest,
        },
        guestRunDirectory: result.runDirectory,
        runDirectory: runDirectoryRelative,
        runtimeBinaryHashes: result.authority.runtimeBinaryHashes,
        workerReadinessAuthority: result.workerReadinessAuthority,
        interactiveSessionAuthority: result.interactiveSessionAuthority,
        usageAuthority: result.usageAuthority,
        deviceAuthority: result.deviceAuthority,
      };
      projections.push(projection);
      runDirectories.push(finalRunDirectory);
    }
    const executionRootRelative = relativeChildPath(resolvedEvidenceRoot, finalExecutionRoot, 'staged shard execution root');
    const stagedPreflightGrantPath = path.join(finalExecutionRoot, PROVIDER_PREFLIGHT_GRANT_FILE);
    const stagedPreflightCompletionPath = path.join(finalExecutionRoot, PROVIDER_PREFLIGHT_COMPLETION_FILE);
    const stagedPreflightConsumptionClaimPath = path.join(
      finalExecutionRoot,
      PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
    );
    const stagedPreflightGrantAuthority = {
      ...fileAuthorityEntry(
        stagedPreflightGrantPath,
        relativeChildPath(resolvedEvidenceRoot, stagedPreflightGrantPath, 'staged provider preflight grant'),
      ),
      digest: plan.providerPreflightGrant.digest,
    };
    const stagedPreflightLeaseReservations = plan.providerPreflightLeaseReservations.map((entry) => {
      const reservationPath = path.join(finalExecutionRoot, ...entry.path.split('/'));
      return {
        cellId: entry.cellId,
        leaseId: entry.leaseId,
        digest: entry.digest,
        ...fileAuthorityEntry(
          reservationPath,
          relativeChildPath(resolvedEvidenceRoot, reservationPath, 'staged provider preflight reservation'),
        ),
      };
    });
    const stagedPreflightCompletionAuthority = {
      ...fileAuthorityEntry(
        stagedPreflightCompletionPath,
        relativeChildPath(resolvedEvidenceRoot, stagedPreflightCompletionPath, 'staged provider preflight completion'),
      ),
      digest: plan.providerPreflightCompletion.digest,
      grantDigest: plan.providerPreflightCompletion.grantDigest,
      authorizationDigest: plan.providerPreflightCompletion.authorizationDigest,
      tokenBudget: structuredClone(plan.providerPreflightCompletion.tokenBudget),
      inputTokens: plan.providerPreflightCompletion.inputTokens,
      outputTokens: plan.providerPreflightCompletion.outputTokens,
      audioSeconds: plan.providerPreflightCompletion.audioSeconds,
      consumptionClaim: {
        ...plan.providerPreflightAuthorization.consumptionClaim,
        ...fileAuthorityEntry(
          stagedPreflightConsumptionClaimPath,
          relativeChildPath(
            resolvedEvidenceRoot,
            stagedPreflightConsumptionClaimPath,
            'staged provider preflight consumption claim',
          ),
        ),
      },
    };
    const stagedPreflightAuthorization = {
      ...structuredClone(plan.providerPreflightAuthorization),
      consumptionClaim: structuredClone(stagedPreflightCompletionAuthority.consumptionClaim),
    };
    const stagedWorkerReadinessRequestPath = path.join(finalExecutionRoot, 'worker-readiness-request.json');
    const stagedWorkerReadinessRequestAuthority = fileAuthorityEntry(
      stagedWorkerReadinessRequestPath,
      relativeChildPath(
        resolvedEvidenceRoot,
        stagedWorkerReadinessRequestPath,
        'staged worker readiness request',
      ),
    );
    const stagedWorkerReadinessAuthorities = plan.workers.map((worker) => {
      const readinessPath = path.join(finalExecutionRoot, 'worker-readiness', `${worker.workerId}.json`);
      const recorded = sourcePreflightAuthorization.grant.workerReadinessAuthorities
        .find((entry) => entry.workerId === worker.workerId);
      if (!recorded) throw new Error(`staged readiness authority is missing worker ${worker.workerId}`);
      return {
        ...recorded,
        ...fileAuthorityEntry(
          readinessPath,
          relativeChildPath(resolvedEvidenceRoot, readinessPath, 'staged worker readiness receipt'),
        ),
      };
    });
    const shardExecution = {
      executionRoot: executionRootRelative,
      plan: fileAuthorityEntry(stagedPlanPath, relativeChildPath(resolvedEvidenceRoot, stagedPlanPath, 'staged plan')),
      leases: stagedLeasePaths.map((temporaryLeasePath, index) => {
        const leasePath = temporaryLeasePath.replace(temporaryRoot, finalExecutionRoot);
        const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8').replace(/^\uFEFF/, ''));
        return {
          cellId: plan.cells[index].cellId,
          leaseId: lease.leaseId,
          ...fileAuthorityEntry(leasePath, relativeChildPath(resolvedEvidenceRoot, leasePath, 'staged lease')),
        };
      }),
      coordinatorAggregate: fileAuthorityEntry(
        stagedAggregatePath,
        relativeChildPath(resolvedEvidenceRoot, stagedAggregatePath, 'staged coordinator aggregate'),
      ),
      providerPreflightGrant: stagedPreflightGrantAuthority,
      providerPreflightLeaseReservations: stagedPreflightLeaseReservations,
      providerPreflightAuthorization: stagedPreflightAuthorization,
      providerPreflightCompletion: stagedPreflightCompletionAuthority,
      workerReadinessRequest: stagedWorkerReadinessRequestAuthority,
      workerReadiness: stagedWorkerReadinessAuthorities,
      shards: [...stagedByWorker.entries()].map(([workerId, staged]) => {
        const shardRoot = path.join(finalExecutionRoot, 'shards', workerId);
        const manifestPath = staged.manifestPath.replace(temporaryRoot, finalExecutionRoot);
        return {
          workerId,
          shardRoot: relativeChildPath(resolvedEvidenceRoot, shardRoot, 'staged shard root'),
          manifest: fileAuthorityEntry(
            manifestPath,
            relativeChildPath(resolvedEvidenceRoot, manifestPath, 'staged shard manifest'),
          ),
        };
      }).sort((left, right) => left.workerId.localeCompare(right.workerId)),
      shardOrchestrationImplementationHashes: collectedMatrixIntegration.shardOrchestrationImplementationHashes,
    };
    const matrixIntegration = {
      provenance: collectedMatrixIntegration.provenance,
      authorityImplementationHashes: collectedMatrixIntegration.authorityImplementationHashes,
      authorityRuntimeBinaryHashes: collectedMatrixIntegration.authorityRuntimeBinaryHashes,
      shardOrchestrationImplementationHashes: collectedMatrixIntegration.shardOrchestrationImplementationHashes,
      localIsolationAuthority: collectedMatrixIntegration.localIsolationAuthority,
      providerPreflightAuthority: collectedMatrixIntegration.providerPreflightAuthority,
      providerPreflightGrant: stagedPreflightGrantAuthority,
      providerPreflightLeaseReservations: stagedPreflightLeaseReservations,
      providerPreflightAuthorization: stagedPreflightAuthorization,
      providerPreflightCompletion: stagedPreflightCompletionAuthority,
      workerReadinessRequest: stagedWorkerReadinessRequestAuthority,
      workerReadiness: stagedWorkerReadinessAuthorities,
      releaseCells: collectedMatrixIntegration.releaseCells,
      coordinatorAggregateDigest: aggregate.aggregateDigest,
      cells: projections,
      externalProviderBudget: aggregate.budget,
    };
    return { runDirectories, shardExecution, matrixIntegration, finalExecutionRoot };
  } catch (error) {
    if (fs.existsSync(temporaryRoot)) fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

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
  externalProviderBudget = null,
  failureSummary = null,
  failureFingerprintAuthority = null,
  shardExecution = null,
  matrixIntegration = null,
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
  if (strict && externalProviderBudget?.passed !== true) {
    throw new Error('strict matrix manifest requires a passed external provider budget ledger');
  }
  if (strict && Boolean(shardExecution) !== Boolean(matrixIntegration)) {
    throw new Error('strict shard matrix manifest requires shardExecution and matrixIntegration together');
  }
  if (strict && matrixIntegration) {
    const integrationIds = matrixIntegration.cells?.map((cell) => cell.cellId);
    const expectedIds = plannedLiveCells.map((cell) => cell.cellId);
    if (JSON.stringify(integrationIds) !== JSON.stringify(expectedIds)) {
      throw new Error('strict shard matrixIntegration cells do not match the fixed release order');
    }
    if (matrixIntegration.cells.some((cell) => Object.hasOwn(cell, 'sourceRunDirectory'))) {
      throw new Error('strict shard matrixIntegration may not persist absolute sourceRunDirectory values');
    }
  }
  const expectedRunCount = strict
    ? plannedLiveCells.length
    : modelList.length * feedbackModeList.length * deviceProfiles.length;
  if (runDirectories.length !== expectedRunCount) {
    throw new Error(`matrix manifest has ${runDirectories.length} run directories; expected ${expectedRunCount}`);
  }
  const implementationHashes = strict ? currentAuthorityImplementationHashes() : null;
  const paidImplementationHashes = strict ? currentPaidAuthorityImplementationHashes() : null;
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
              inputCompletionWatchdogSeconds: plannedCell.inputCompletionWatchdogSeconds,
              processExclusionRestartAfterSeconds: plannedCell.processExclusionRestartAfterSeconds,
              processExclusionRestartQuietSeconds: plannedCell.processExclusionRestartQuietSeconds,
              providerFinishTimeoutSeconds: plannedCell.providerFinishTimeoutSeconds,
              localPlaybackDrainTimeoutSeconds: plannedCell.localPlaybackDrainTimeoutSeconds,
              reportWriteTimeoutSeconds: plannedCell.reportWriteTimeoutSeconds,
              cellHardWatchdogSeconds: plannedCell.cellHardWatchdogSeconds,
              authoritativeTransformedReferenceFrames: plannedCell.authoritativeTransformedReferenceFrames,
              boundedCaptureGraceFrames: plannedCell.boundedCaptureGraceFrames,
              maxExternalAudioSamples: plannedCell.maxExternalAudioSamples,
              auxiliaryExternalAudioSeconds: plannedCell.auxiliaryExternalAudioSeconds,
              subtitleTranslationMode: plannedCell.subtitleTranslationMode,
              modelId: plannedCell.modelId,
              feedbackLoopPrevention: plannedCell.feedbackLoopPrevention,
              deviceClass: deviceProfile.deviceClass,
              deviceProfileId: deviceProfile.profileId,
            },
            provenance,
            implementationHashes,
            paidImplementationHashes,
            shardAuthority: matrixIntegration?.cells?.[runIndex] ?? null,
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
          externalProviderBudget,
          ...(failureSummary ? {
            collectAll: {
              ...failureSummary,
              failureFingerprintAuthority,
              verdict: failureSummary.failed.length === 0 ? 'passed' : 'failed',
            },
          } : {}),
          ...(shardExecution ? { shardExecution, matrixIntegration } : {}),
          authority: {
            runner: MATRIX_RUNNER_ID,
            collector: LIVE_RUN_COLLECTOR_ID,
            implementationHashes,
            paidImplementationHashes,
            runtimeBinaryHashes,
          },
          cells,
        }
      : {}),
  };
  const temporaryPath = `${manifestPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameWithTransientRetrySync(temporaryPath, manifestPath);
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
    && manifest.externalProviderBudget?.passed === true
    && (!manifest.collectAll || (
      manifest.collectAll.verdict === 'passed'
      && Array.isArray(manifest.collectAll.failed)
      && manifest.collectAll.failed.length === 0
      && manifest.collectAll.completed?.length === LIVE_LLM_CELLS.length
    ))
    && Number(manifest.externalProviderBudget?.matrixInputSampleCeiling)
      === STRICT_PAID_MATRIX_MAX_INPUT_SAMPLES
    && Number(manifest.externalProviderBudget?.reservedInputSamples)
      === STRICT_PAID_MATRIX_MAX_INPUT_SAMPLES
    && Number(manifest.externalProviderBudget?.auxiliaryExternalAudioSeconds) === 0
    && manifest.externalProviderBudget?.ledgerPath
    && manifest.externalProviderBudget?.ledgerSha256
    && Number(manifest.externalProviderBudget?.ledgerBytes) > 0
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
  const resolvedOutputRoot = path.resolve(repoRoot, outputRoot);
  validateFileAuthorityEntry(
    resolvedOutputRoot,
    {
      path: manifest.externalProviderBudget.ledgerPath,
      bytes: manifest.externalProviderBudget.ledgerBytes,
      sha256: manifest.externalProviderBudget.ledgerSha256,
    },
    manifest.externalProviderBudget.ledgerPath,
    'strict matrix external provider budget ledger',
  );
  const rawCellBudgets = manifest.cells.map((cell, index) => (
    assertCellExternalProviderBudget(
      resolveAuthorityPath(resolvedOutputRoot, cell.runDirectory, `strict matrix cell ${index} run directory`),
      {
        cellId: LIVE_LLM_CELLS[index]?.cellId,
        modelId: LIVE_LLM_CELLS[index]?.modelId,
        feedbackLoopPrevention: LIVE_LLM_CELLS[index]?.feedbackLoopPrevention,
        inputCeilingSamples: LIVE_LLM_CELLS[index]?.maxExternalAudioSamples,
      },
    )
  ));
  const matrixBudgetPath = resolveAuthorityPath(
    resolvedOutputRoot,
    manifest.externalProviderBudget.ledgerPath,
    'strict matrix external provider budget ledger',
  );
  const rebuiltMatrixBudget = assertMatrixExternalProviderBudget(matrixBudgetPath, rawCellBudgets);
  const manifestBudget = { ...manifest.externalProviderBudget };
  delete manifestBudget.ledgerPath;
  delete manifestBudget.ledgerBytes;
  delete manifestBudget.ledgerSha256;
  if (JSON.stringify(rebuiltMatrixBudget) !== JSON.stringify(manifestBudget)) {
    throw new Error('refusing to publish canonical strict manifest: external provider budget does not match rebuilt raw ledgers');
  }
  const uniqueRunDirectories = new Set(
    manifest.runDirectories.map((directory) => (
      process.platform === 'win32' ? String(directory).toLowerCase() : String(directory)
    )),
  );
  if (uniqueRunDirectories.size !== manifest.runDirectories.length) {
    throw new Error('refusing to publish canonical strict manifest: runDirectories are not unique');
  }
  const currentImplementationHashes = currentAuthorityImplementationHashes();
  const currentPaidImplementationHashes = currentPaidAuthorityImplementationHashes();
  const currentRuntimeBinaryHashes = providedRuntimeBinaryHashes
    ?? currentAuthorityRuntimeBinaryHashes();
  if (
    manifest.authority?.runner !== MATRIX_RUNNER_ID
    || manifest.authority?.collector !== LIVE_RUN_COLLECTOR_ID
    || !sameAuthorityInventory(
      manifest.authority?.implementationHashes,
      currentImplementationHashes,
    )
    || !sameAuthorityInventory(
      manifest.authority?.paidImplementationHashes,
      currentPaidImplementationHashes,
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
    if (!sameAuthorityInventory(receipt.paidImplementationHashes, currentPaidImplementationHashes)) {
      throw new Error(`refusing to publish canonical strict manifest: cell ${index} paid implementation hashes do not match the current checkout`);
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
  renameWithTransientRetrySync(temporaryPath, canonicalPath);
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

// A runner can finish its process lifecycle successfully while its authoritative
// report rejects the live evidence. Stop here before another paid provider
// session begins, rather than discovering the failure only after all cells.
export const assertStrictLiveReportPassed = (runDirectory) => {
  const reportPath = path.join(runDirectory, 'report.json');
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`strict matrix cell has no readable authoritative report: ${reportPath} (${error.message})`);
  }
  if (report?.verdict !== 'passed') {
    const detail = String(report?.failureReason ?? report?.failureLayer ?? 'no failure detail');
    throw new Error(`strict matrix cell report failed before another paid cell can start: ${reportPath} (${detail})`);
  }
  return report;
};

const runLiveRunner = (request, timeoutMs, environment = process.env) => new Promise((resolve, reject) => {
  const requestDirectory = path.join(repoRoot, 'artifacts', 'testing', 'temp', 'watch-mode-requests');
  fs.mkdirSync(requestDirectory, { recursive: true });
  const requestPath = path.join(requestDirectory, `request-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  const child = spawn(
    process.execPath,
    [RUNNER_ENTRY, '--request', requestPath],
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
    fs.rmSync(requestPath, { force: true });
    reject(error);
  });
  // Resolve on the PowerShell process exit instead of `close`: a degraded
  // bridge descendant can inherit stdout and keep the pipe open after the
  // runner itself has already exited. Destroying our read side prevents that
  // unrelated process from hanging the matrix indefinitely.
  child.once('exit', (exitCode) => {
    clearTimeout(timeout);
    fs.rmSync(requestPath, { force: true });
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
    if (aliasModel || aliasProtocol) {
      throw new Error('strict paid matrix forbids model aliases and alias protocols; release model-to-protocol mapping is exact');
    }
    assertStrictReleaseMatrixLists({ modelList, feedbackModeList });
    assertStrictMediaPath(options.mediaPath ?? MATRIX_DEFAULTS.mediaPath);
    assertStrictEvidenceOptions(options);
    throw new Error(
      'the legacy strict matrix entry is disabled before build/preflight/provider launch; use run-watch-mode-live-production-coordinator.mjs with one local worker and frozen authorities',
    );
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
  const runDirectories = [];
  const cellExternalProviderBudgets = [];
  let reservedPaidInputSamples = 0;
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
          watchAutoStopAfterSeconds: plannedCell.inputCompletionWatchdogSeconds,
          strictPaidAuthority: strict,
          cellId: plannedCell.cellId,
        };
        if (strict) {
          // Reserve the exact mode-derived input samples before launching Desktop. A
          // malformed plan therefore fails before it can send any audio.
          reservedPaidInputSamples = reserveStrictPaidCellInputSamples({
            reservedSamples: reservedPaidInputSamples,
            nextCellSamples: plannedCell.maxExternalAudioSamples,
          });
        }
        const { exitCode, stdout } = await runLiveRunner(
          buildRunnerRequest(runnerOptions),
          resolveLiveRunnerTimeoutMs(runnerOptions),
          strict
            ? {
                ...liveRunnerEnvironment,
                OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID: crypto.randomUUID(),
              }
            : liveRunnerEnvironment,
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
        if (strict) {
          const budget = assertCellExternalProviderBudget(resolvedRunDirectory, {
            cellId: plannedCell.cellId,
            modelId: model,
            feedbackLoopPrevention: feedbackMode,
            inputCeilingSamples: plannedCell.maxExternalAudioSamples,
          });
          cellExternalProviderBudgets.push(budget);
          assertStrictLiveReportPassed(resolvedRunDirectory);
          assertRuntimeBinaryContinuity(runtimeBinaryHashes, `during matrix cell ${model}/${feedbackMode}/${deviceProfile.profileId}`);
        }
  }
  const outputRoot = options.outputRoot ?? MATRIX_DEFAULTS.outputRoot;
  const expectedRunCount = strict
    ? LIVE_LLM_CELLS.length
    : modelList.length * feedbackModeList.length * deviceProfiles.length;
  if (runDirectories.length !== expectedRunCount) {
    throw new Error(`Watch Mode matrix produced ${runDirectories.length} run directories; expected ${expectedRunCount}.`);
  }
  const completionProvenance = currentGitProvenance({ cwd: repoRoot });
  let externalProviderBudget = null;
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
    const budgetFileName = `watch-mode-external-provider-budget-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}.json`;
    const matrixBudget = writeMatrixExternalProviderBudget(
      path.resolve(repoRoot, outputRoot),
      cellExternalProviderBudgets,
      { fileName: budgetFileName },
    );
    const budgetAuthority = fileAuthorityEntry(matrixBudget.filePath, budgetFileName);
    externalProviderBudget = {
      ...matrixBudget.ledger,
      ledgerPath: budgetAuthority.path,
      ledgerBytes: budgetAuthority.bytes,
      ledgerSha256: budgetAuthority.sha256,
    };
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
    externalProviderBudget,
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
