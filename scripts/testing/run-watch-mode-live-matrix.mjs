import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMain, isWindows, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';

export const DEFAULT_MODELS = [
  'qwen3.5-omni-flash-realtime',
  'qwen3.5-livetranslate-flash-realtime',
];
export const DEFAULT_FEEDBACK_MODES = ['virtual-driver', 'echo-cancel'];
export const SUPPORTED_FEEDBACK_MODES = ['virtual-driver', 'echo-cancel'];

export const MATRIX_DEFAULTS = {
  outputRoot: 'artifacts/testing/watch-mode-live',
  mediaPath: 'scripts/testing/fixtures/watch-mode-en-original.wav',
  warmupSeconds: 12,
  playbackSeconds: 0,
  postPlaybackWaitSeconds: 120,
  sessionReadyTimeoutSeconds: 90,
  physicalPlaybackDeviceId: 'default',
  expectedPhysicalPlaybackDeviceName: '',
};

const RUNNER_SCRIPT = path.join(repoRoot, 'scripts', 'testing', 'run-watch-mode-live.ps1');

const INTEGER_OPTION_FLAGS = {
  warmupSeconds: 'warmup-seconds',
  playbackSeconds: 'playback-seconds',
  postPlaybackWaitSeconds: 'post-playback-wait-seconds',
  sessionReadyTimeoutSeconds: 'session-ready-timeout-seconds',
};

const BOOLEAN_FLAGS = [
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
  --models <a,b>                                   comma-separated Watch Mode model ids
                                                   (default: ${DEFAULT_MODELS.join(',')})
  --alias-model <id>                               optional keyword-free deployed alias to append
  --alias-protocol <dialect>                       explicit protocol for --alias-model
  --feedback-loop-prevention-modes <a,b>           comma-separated modes among: ${SUPPORTED_FEEDBACK_MODES.join(', ')}
                                                   (default: ${DEFAULT_FEEDBACK_MODES.join(',')})
  --output-root <dir>                              default: ${MATRIX_DEFAULTS.outputRoot}
  --media-path <file>                              default: ${MATRIX_DEFAULTS.mediaPath}
  --warmup-seconds <n>                             default: ${MATRIX_DEFAULTS.warmupSeconds}
  --playback-seconds <n>                           default: ${MATRIX_DEFAULTS.playbackSeconds}
  --post-playback-wait-seconds <n>                 default: ${MATRIX_DEFAULTS.postPlaybackWaitSeconds}
  --session-ready-timeout-seconds <n>              default: ${MATRIX_DEFAULTS.sessionReadyTimeoutSeconds}
  --physical-playback-device-id <id>               default: ${MATRIX_DEFAULTS.physicalPlaybackDeviceId}
  --expected-physical-playback-device-name <name>  default: empty
  --skip-desktop-launch
  --skip-driver-repair
  --allow-driver-repair
  --use-default-endpoint-playback
  --stop-desktop-after-playback
  --allow-elevated-desktop-launch
  --skip-physical-output-content-stt

Everything after a literal "--" separator is appended verbatim to the
powershell.exe -File scripts/testing/run-watch-mode-live.ps1 invocation as
extra single-dash runner parameters (for example: -- -DryRun -Fixture pass).
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
      ...MATRIX_DEFAULTS,
    },
  });
  const knownKeys = new Set([
    'models',
    'aliasModel',
    'aliasProtocol',
    'feedbackLoopPreventionModes',
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
  physicalPlaybackDeviceId = MATRIX_DEFAULTS.physicalPlaybackDeviceId,
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
    '-PhysicalPlaybackDeviceId', physicalPlaybackDeviceId,
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

export const buildVerifyArgv = (outputRoot, modelList, feedbackModeList) => [
  './scripts/testing/verify-watch-mode-evidence.mjs',
  '--root', outputRoot,
  '--strict',
  '--models', modelList.join(','),
  '--feedback-modes', feedbackModeList.join(','),
];

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
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
};

const runLiveRunner = (runnerArgv) => new Promise((resolve, reject) => {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RUNNER_SCRIPT, ...runnerArgv],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    process.stderr.write(chunk);
  });
  child.once('error', reject);
  child.once('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout }));
});

export const runMatrix = async (options) => {
  const { modelList: configuredModels, feedbackModeList } = resolveMatrixLists(options);
  const modelList = [...configuredModels];
  const aliasModel = String(options.aliasModel ?? '').trim();
  const aliasProtocol = String(options.aliasProtocol ?? '').trim();
  if (aliasModel && !modelList.includes(aliasModel)) modelList.push(aliasModel);
  if (aliasModel && !['dashscope-omni', 'dashscope-livetranslate', 'dashscope-asr', 'openai-conversation', 'openai-translation', 'openai-transcription', 'openai-flat', 'gemini-live'].includes(aliasProtocol)) {
    throw new Error(`Unsupported alias realtime protocol: ${aliasProtocol}`);
  }
  const runDirectories = [];
  for (const model of modelList) {
    for (const feedbackMode of feedbackModeList) {
      console.error(`==> Running Watch Mode live strict matrix model: ${model} feedbackLoopPrevention: ${feedbackMode}`);
      const watchRealtimeProtocol = model === aliasModel ? aliasProtocol : '';
      const { exitCode, stdout } = await runLiveRunner(buildRunnerArgv({ ...options, model, feedbackMode, watchRealtimeProtocol }));
      if (exitCode !== 0) {
        throw new Error(`Watch Mode live run failed for model ${model} feedbackLoopPrevention ${feedbackMode} with exit code ${exitCode}`);
      }
      const runDirectory = lastRunDirectoryLine(stdout);
      if (runDirectory !== undefined) {
        runDirectories.push(runDirectory);
      }
    }
  }
  console.error('==> Verifying strict Watch Mode evidence matrix');
  const outputRoot = options.outputRoot ?? MATRIX_DEFAULTS.outputRoot;
  const verifyResult = spawnSync(
    process.execPath,
    buildVerifyArgv(outputRoot, modelList, feedbackModeList),
    { cwd: repoRoot, stdio: ['ignore', 2, 'inherit'] },
  );
  const verifyExitCode = verifyResult.status ?? 1;
  if (verifyExitCode !== 0) {
    throw new Error(`strict Watch Mode evidence matrix failed with exit code ${verifyExitCode}`);
  }
  return {
    models: modelList,
    feedbackLoopPreventionModes: feedbackModeList,
    runDirectories,
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
