import fs from 'node:fs';
import path from 'node:path';

export const WATCH_MODE_RUN_REQUEST_SCHEMA = 'watch-mode-run-request/v1';

const enums = {
  runMode: new Set(['fixture', 'live']),
  authorityMode: new Set(['none', 'strict-paid', 'incident-replay-plus', 'local-canonical-smoke']),
  feedbackMode: new Set(['process-exclusion', 'virtual-driver', 'echo-cancel']),
  launchMode: new Set(['managed']),
  elevation: new Set(['forbid', 'allow']),
  driverPolicy: new Set(['not-applicable', 'probe-only', 'repair-if-needed']),
  physicalContentMode: new Set(['disabled', 'local-canonical', 'remote-stt']),
  subtitleTranslationMode: new Set(['native', 'secondary']),
  deviceClass: new Set(['default-speaker', 'usb', 'bluetooth']),
};
const requestFields = new Set([
  'schemaVersion', 'runMode', 'authorityMode', 'feedbackMode', 'desktop', 'driverPolicy',
  'physicalContentMode', 'model', 'media', 'physicalDevice', 'timeouts', 'paths', 'matrix',
]);
const pathFields = new Set([
  'outputRoot', 'runtimeRoot', 'workerReadinessReceipt', 'inputComplete', 'terminalAuthority',
]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function enumValue(value, set, label) {
  if (!set.has(value)) throw new Error(`${label} must be one of: ${[...set].join(', ')}`);
  return value;
}

function nonEmpty(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function integer(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

export function validateWatchModeRunRequest(input) {
  const request = structuredClone(object(input, 'request'));
  const unknownFields = Object.keys(request).filter((field) => !requestFields.has(field));
  if (unknownFields.length > 0) throw new Error(`request has unknown fields: ${unknownFields.join(', ')}`);
  if (request.schemaVersion !== WATCH_MODE_RUN_REQUEST_SCHEMA) {
    throw new Error(`schemaVersion must be ${WATCH_MODE_RUN_REQUEST_SCHEMA}`);
  }
  request.runMode = enumValue(request.runMode, enums.runMode, 'runMode');
  request.authorityMode = enumValue(request.authorityMode, enums.authorityMode, 'authorityMode');
  request.feedbackMode = enumValue(request.feedbackMode, enums.feedbackMode, 'feedbackMode');
  request.desktop = object(request.desktop, 'desktop');
  request.desktop.launchMode = enumValue(request.desktop.launchMode, enums.launchMode, 'desktop.launchMode');
  request.desktop.elevation = enumValue(request.desktop.elevation, enums.elevation, 'desktop.elevation');
  request.driverPolicy = enumValue(request.driverPolicy, enums.driverPolicy, 'driverPolicy');
  request.physicalContentMode = enumValue(request.physicalContentMode, enums.physicalContentMode, 'physicalContentMode');
  request.model = object(request.model, 'model');
  request.model.id = nonEmpty(request.model.id, 'model.id', { optional: request.runMode !== 'live' });
  request.model.protocol = nonEmpty(request.model.protocol, 'model.protocol', { optional: request.runMode !== 'live' });
  request.model.subtitleTranslationMode = enumValue(
    request.model.subtitleTranslationMode,
    enums.subtitleTranslationMode,
    'model.subtitleTranslationMode',
  );
  request.media = object(request.media, 'media');
  request.media.path = nonEmpty(request.media.path, 'media.path');
  request.media.playbackSeconds = integer(request.media.playbackSeconds, 'media.playbackSeconds', 0, 7200);
  request.physicalDevice = object(request.physicalDevice, 'physicalDevice');
  request.physicalDevice.id = nonEmpty(request.physicalDevice.id, 'physicalDevice.id');
  request.physicalDevice.class = enumValue(request.physicalDevice.class, enums.deviceClass, 'physicalDevice.class');
  request.physicalDevice.profileId = nonEmpty(request.physicalDevice.profileId, 'physicalDevice.profileId');
  request.timeouts = object(request.timeouts, 'timeouts');
  request.timeouts.warmupSeconds = integer(request.timeouts.warmupSeconds, 'timeouts.warmupSeconds', 0, 600);
  request.timeouts.readinessSeconds = integer(request.timeouts.readinessSeconds, 'timeouts.readinessSeconds', 1, 100);
  request.timeouts.sessionSeconds = integer(request.timeouts.sessionSeconds, 'timeouts.sessionSeconds', 30, 7200);
  request.timeouts.postPlaybackSeconds = integer(request.timeouts.postPlaybackSeconds, 'timeouts.postPlaybackSeconds', 0, 7200);
  request.timeouts.inputCompletionWatchdogSeconds = integer(
    request.timeouts.inputCompletionWatchdogSeconds ?? request.timeouts.sessionSeconds,
    'timeouts.inputCompletionWatchdogSeconds',
    30,
    7200,
  );
  request.timeouts.processExclusionRestartAfterSeconds = integer(
    request.timeouts.processExclusionRestartAfterSeconds
      ?? (request.feedbackMode === 'process-exclusion' ? 90 : 0),
    'timeouts.processExclusionRestartAfterSeconds',
    0,
    7200,
  );
  request.timeouts.processExclusionRestartQuietSeconds = integer(
    request.timeouts.processExclusionRestartQuietSeconds
      ?? (request.feedbackMode === 'process-exclusion' ? 45 : 0),
    'timeouts.processExclusionRestartQuietSeconds',
    0,
    7200,
  );
  request.timeouts.providerFinishTimeoutSeconds = integer(
    request.timeouts.providerFinishTimeoutSeconds ?? 15,
    'timeouts.providerFinishTimeoutSeconds',
    1,
    60,
  );
  request.timeouts.localPlaybackDrainTimeoutSeconds = integer(
    request.timeouts.localPlaybackDrainTimeoutSeconds ?? request.timeouts.postPlaybackSeconds,
    'timeouts.localPlaybackDrainTimeoutSeconds',
    0,
    300,
  );
  request.timeouts.reportWriteTimeoutSeconds = integer(
    request.timeouts.reportWriteTimeoutSeconds ?? 10,
    'timeouts.reportWriteTimeoutSeconds',
    1,
    60,
  );
  request.timeouts.cellHardWatchdogSeconds = integer(
    request.timeouts.cellHardWatchdogSeconds ?? (
      request.timeouts.inputCompletionWatchdogSeconds
      + request.timeouts.providerFinishTimeoutSeconds
      + request.timeouts.localPlaybackDrainTimeoutSeconds
      + request.timeouts.reportWriteTimeoutSeconds
    ),
    'timeouts.cellHardWatchdogSeconds',
    30,
    7200,
  );
  request.timeouts.physicalRecorderTailSeconds = integer(
    request.timeouts.physicalRecorderTailSeconds ?? 2,
    'timeouts.physicalRecorderTailSeconds',
    1,
    5,
  );
  request.paths = object(request.paths, 'paths');
  const unknownPathFields = Object.keys(request.paths).filter((field) => !pathFields.has(field));
  if (unknownPathFields.length > 0) throw new Error(`paths has unknown fields: ${unknownPathFields.join(', ')}`);
  request.paths.outputRoot = nonEmpty(request.paths.outputRoot, 'paths.outputRoot');
  request.paths.runtimeRoot = nonEmpty(request.paths.runtimeRoot, 'paths.runtimeRoot');
  request.paths.inputComplete = nonEmpty(request.paths.inputComplete, 'paths.inputComplete', { optional: true });
  request.paths.terminalAuthority = nonEmpty(request.paths.terminalAuthority, 'paths.terminalAuthority', { optional: true });

  if (request.feedbackMode === 'virtual-driver' && request.driverPolicy === 'not-applicable') {
    throw new Error('virtual-driver requires driverPolicy probe-only or repair-if-needed');
  }
  if (request.feedbackMode !== 'virtual-driver' && request.driverPolicy !== 'not-applicable') {
    throw new Error(`${request.feedbackMode} requires driverPolicy=not-applicable`);
  }
  if (request.authorityMode !== 'none') {
    if (
      request.runMode !== 'live'
      || request.desktop.launchMode !== 'managed'
      || request.model.subtitleTranslationMode !== 'native'
      || request.physicalContentMode !== 'local-canonical'
    ) {
      throw new Error(`${request.authorityMode} requires live + managed + native + local-canonical`);
    }
  }
  if (request.authorityMode === 'strict-paid') {
    const expectedRestartAfterSeconds = request.feedbackMode === 'process-exclusion' ? 90 : 0;
    const expectedRestartQuietSeconds = request.feedbackMode === 'process-exclusion' ? 45 : 0;
    if (
      request.model.id !== 'qwen3.5-livetranslate-flash-realtime'
      || request.model.protocol !== 'dashscope-livetranslate'
      || !request.paths.inputComplete
      || !request.paths.terminalAuthority
      || request.timeouts.processExclusionRestartAfterSeconds !== expectedRestartAfterSeconds
      || request.timeouts.processExclusionRestartQuietSeconds !== expectedRestartQuietSeconds
    ) {
      throw new Error('strict-paid requires exact LiveTranslate identity, explicit 90/45 process restart policy, and evidence-driven terminal paths');
    }
  }
  return request;
}

export function loadWatchModeRunRequest(requestPath) {
  const absolutePath = path.resolve(nonEmpty(requestPath, 'request path'));
  const request = JSON.parse(fs.readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/, ''));
  return { request: validateWatchModeRunRequest(request), requestPath: absolutePath };
}

export function buildLiveWatchModeRunRequest(options, {
  authorityMode = 'none',
  workerReadinessReceipt = null,
  runtimeRoot = path.join(process.env.LOCALAPPDATA ?? 'artifacts/diagnostics', 'OmniTranslate/diagnostics/logs'),
} = {}) {
  const feedbackMode = options.feedbackMode;
  const inputCompletionWatchdogSeconds = Number(
    options.inputCompletionWatchdogSeconds ?? options.watchAutoStopAfterSeconds,
  );
  const providerFinishTimeoutSeconds = Number(options.providerFinishTimeoutSeconds ?? 15);
  const localPlaybackDrainTimeoutSeconds = Number(
    options.localPlaybackDrainTimeoutSeconds ?? options.postPlaybackWaitSeconds,
  );
  const reportWriteTimeoutSeconds = Number(options.reportWriteTimeoutSeconds ?? 10);
  return validateWatchModeRunRequest({
    schemaVersion: WATCH_MODE_RUN_REQUEST_SCHEMA,
    runMode: 'live',
    authorityMode,
    feedbackMode,
    desktop: { launchMode: 'managed', elevation: options.allowElevatedDesktopLaunch ? 'allow' : 'forbid' },
    driverPolicy: feedbackMode === 'virtual-driver'
      ? (options.allowDriverRepair ? 'repair-if-needed' : 'probe-only')
      : 'not-applicable',
    physicalContentMode: authorityMode === 'none' ? 'remote-stt' : 'local-canonical',
    model: {
      id: options.model,
      protocol: options.watchRealtimeProtocol,
      subtitleTranslationMode: options.subtitleTranslationMode ?? 'native',
      subtitleModelId: options.subtitleTranslationModelId ?? null,
      secondaryAudioModelId: options.inboundSecondaryAudioModelId ?? null,
    },
    media: { path: options.mediaPath, playbackSeconds: Number(options.playbackSeconds) },
    physicalDevice: {
      id: options.physicalPlaybackDeviceId,
      class: options.physicalPlaybackDeviceClass,
      profileId: options.physicalPlaybackDeviceProfileId,
      expectedName: options.expectedPhysicalPlaybackDeviceName ?? null,
    },
    timeouts: {
      warmupSeconds: Number(options.warmupSeconds),
      readinessSeconds: Number(options.sessionReadyTimeoutSeconds),
      sessionSeconds: Number(options.watchAutoStopAfterSeconds),
      postPlaybackSeconds: Number(options.postPlaybackWaitSeconds),
      inputCompletionWatchdogSeconds,
      processExclusionRestartAfterSeconds: Number(
        options.processExclusionRestartAfterSeconds ?? (feedbackMode === 'process-exclusion' ? 90 : 0),
      ),
      processExclusionRestartQuietSeconds: Number(
        options.processExclusionRestartQuietSeconds ?? (feedbackMode === 'process-exclusion' ? 45 : 0),
      ),
      providerFinishTimeoutSeconds,
      localPlaybackDrainTimeoutSeconds,
      reportWriteTimeoutSeconds,
      cellHardWatchdogSeconds: Number(
        options.cellHardWatchdogSeconds ?? (
          inputCompletionWatchdogSeconds
          + providerFinishTimeoutSeconds
          + localPlaybackDrainTimeoutSeconds
          + reportWriteTimeoutSeconds
        ),
      ),
      physicalRecorderTailSeconds: Number(options.physicalRecorderTailSeconds ?? 2),
    },
    paths: {
      outputRoot: options.outputRoot,
      runtimeRoot,
      workerReadinessReceipt,
      inputComplete: options.inputCompletePath ?? null,
      terminalAuthority: options.terminalAuthorityPath ?? null,
    },
    matrix: { cellId: options.matrixCellId ?? options.cellId ?? null, leaseId: null },
  });
}
