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
  snapshots.wasapi ??= snapshots.driver;
  return { collection, collectionPath, paths, metadata, snapshots, appLogText, bridgeLogText };
}
