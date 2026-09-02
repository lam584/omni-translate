import fs from 'node:fs';
import path from 'node:path';

import { readWatchModeRunCollection } from '../watch-mode-run-collection.mjs';
import {
  parseSpeechSegmentation,
  parseTranslationRoute,
  textAfterLocalTimestamp,
  textAfterMarker,
} from './log-parser.mjs';

function readText(filePath) {
  return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function readJson(filePath, label) {
  if (!filePath) return null;
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) throw new Error(`${label} artifact is missing or empty: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function resolveArtifacts(runDirectory, inventory) {
  const root = path.resolve(runDirectory);
  const prefix = `${root}${path.sep}`;
  return Object.fromEntries(Object.entries(inventory).map(([name, relativePath]) => {
    if (relativePath === null) return [name, null];
    const resolved = path.resolve(root, relativePath);
    if (!resolved.startsWith(prefix)) throw new Error(`artifact escapes run directory: ${relativePath}`);
    if (!fs.existsSync(resolved)) throw new Error(`indexed artifact is missing: ${relativePath}`);
    return [name, resolved];
  }));
}

function normalizeBridgeProbe(probe) {
  if (!probe) return {};
  if (probe.state && (probe.sourceFrame || probe.state.sourceCaptureMode === 'process-exclusion')) {
    return {
      probePassed: probe.passed !== false,
      ...probe.state,
      sourceFramePayloadBytes: probe.sourceFrame?.payloadBytes ?? 0,
      pipeName: probe.pipeName,
      sourcePipeName: probe.sourcePipeName,
    };
  }
  return { probePassed: false, ...probe };
}

function validateRuntimeStatus(status, metadata) {
  if (status === null) return null;
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new Error('runtimeStatus artifact must be an object');
  }
  if (status.schemaVersion !== 'watch-mode-readiness/v2') {
    throw new Error('runtimeStatus schemaVersion must be watch-mode-readiness/v2');
  }
  if (
    typeof metadata.runMarker === 'string'
    && metadata.runMarker !== ''
    && status.runMarker !== metadata.runMarker
  ) {
    throw new Error('runtimeStatus runMarker does not match runMetadata');
  }
  if (!Number.isSafeInteger(Number(status.processId)) || Number(status.processId) <= 0) {
    throw new Error('runtimeStatus processId must be a positive integer');
  }
  if (typeof status.state !== 'string' || status.state === '') {
    throw new Error('runtimeStatus state must be a non-empty string');
  }
  for (const component of ['frontendIpc', 'provider', 'bridge', 'route']) {
    const value = status[component];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`runtimeStatus ${component} must be an object`);
    }
    if (!['pending', 'ready', 'failed'].includes(value.status)) {
      throw new Error(`runtimeStatus ${component}.status is invalid`);
    }
    if (value.status === 'failed') {
      if (
        !value.error
        || typeof value.error.code !== 'string'
        || value.error.code === ''
        || typeof value.error.message !== 'string'
        || value.error.message === ''
      ) {
        throw new Error(`runtimeStatus ${component} failure is incomplete`);
      }
      if (!Number.isSafeInteger(Number(value.atMs)) || Number(value.atMs) <= 0) {
        throw new Error(`runtimeStatus ${component}.atMs must identify the failure time`);
      }
    }
  }
  if (status.state === 'failed') {
    if (
      !status.failure
      || typeof status.failure.code !== 'string'
      || status.failure.code === ''
      || typeof status.failure.message !== 'string'
      || status.failure.message === ''
    ) {
      throw new Error('failed runtimeStatus must contain a failure identity');
    }
    const matchingComponent = ['frontendIpc', 'provider', 'bridge', 'route'].find((component) => (
      status[component].status === 'failed'
      && status[component].error?.code === status.failure.code
      && status[component].error?.message === status.failure.message
    ));
    if (!matchingComponent) {
      throw new Error('runtimeStatus failure does not match a failed component');
    }
  } else if (status.failure !== null && status.failure !== undefined) {
    throw new Error('non-failed runtimeStatus must not contain a failure');
  }
  return status;
}

export function loadWatchModeArtifacts(runDirectory) {
  const { collection, collectionPath } = readWatchModeRunCollection(runDirectory);
  const paths = resolveArtifacts(runDirectory, collection.artifacts);
  const metadata = readJson(paths.runMetadata, 'runMetadata') ?? {};
  const rawAppLogText = readText(paths.appLog);
  const rawBridgeLogText = readText(paths.bridgeLog);
  const appLogText = textAfterMarker(rawAppLogText, metadata.runMarker)
    || textAfterLocalTimestamp(rawAppLogText, metadata.startedAtLocal);
  const bridgeLogText = textAfterMarker(rawBridgeLogText, metadata.runMarker)
    || textAfterLocalTimestamp(rawBridgeLogText, metadata.startedAtLocal);
  const runtimeStatus = validateRuntimeStatus(
    readJson(paths.runtimeStatus, 'runtimeStatus'),
    metadata,
  );
  const fixtureEvidence = readJson(paths.fixtureEvidence, 'fixtureEvidence');
  const snapshots = fixtureEvidence ?? {
    runMarker: metadata.runMarker ?? null,
    startedAtLocal: metadata.startedAtLocal ?? null,
    modelId: metadata.modelId ?? collection.request.model?.id ?? null,
    feedbackLoopPrevention: metadata.feedbackMode ?? collection.request.feedbackMode ?? null,
    deviceEvidence: readJson(paths.physicalPlaybackDevice, 'physicalPlaybackDevice'),
    translationRoute: parseTranslationRoute(appLogText),
    driver: readJson(paths.driverProbe, 'driverProbe'),
    bridge: normalizeBridgeProbe(readJson(paths.bridgeSourceProbe, 'bridgeSourceProbe')),
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null, speechDispatchState: null, subtitleQueue: null },
    provider: null,
    physicalOutput: readJson(paths.physicalOutputProbe, 'physicalOutputProbe'),
    physicalOutputContentRaw: readJson(paths.physicalOutputContentRaw, 'physicalOutputContentRaw'),
    speechSegmentation: parseSpeechSegmentation(appLogText),
    watchSessionReport: readJson(paths.watchSessionReport, 'watchSessionReport'),
    playback: readJson(paths.playback, 'playback'),
    systemMetrics: readJson(paths.systemMetrics, 'systemMetrics'),
    diagnosticsBundle: null,
  };
  snapshots.runtimeStatus = runtimeStatus;
  snapshots.wasapi ??= snapshots.driver;
  return { collection, collectionPath, paths, metadata, snapshots, appLogText, bridgeLogText };
}
