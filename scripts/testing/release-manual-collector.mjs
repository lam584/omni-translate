import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  compactTimestamp,
  ensureDir,
  readJson,
  repoRoot,
  writeJson,
} from '../lib/testing-common.mjs';
import {
  currentGitProvenance,
  exactGitProvenanceFailure,
  gitProvenanceShapeFailure,
} from './git-provenance.mjs';
import {
  REAL_DEVICE_AUDIO_EMITTER_ID,
  REAL_DEVICE_AUDIO_EMITTER_VERSION,
  REAL_DEVICE_AUDIO_PROFILE,
  REAL_DEVICE_AUDIO_RUNNER,
  validateRealDeviceAudioEvidence,
} from './real-device-audio-release-evidence.mjs';
import {
  INSTALL_RELEASE_ARTIFACTS_BY_SCENARIO,
  INSTALL_RELEASE_COLLECTOR_ID,
  INSTALL_RELEASE_COLLECTOR_VERSION,
  INSTALL_RELEASE_SCENARIOS,
  validateInstallReleaseRunDirectory,
} from './install-release-evidence.mjs';
import {
  OVERLAY_CLICK_THROUGH_ARTIFACTS,
  OVERLAY_CLICK_THROUGH_COLLECTOR_ID,
  OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION,
  OVERLAY_CLICK_THROUGH_RUNNER,
  validateOverlayClickThroughEvidence,
} from './overlay-click-through-release-evidence.mjs';
import {
  VIRTUAL_MIC_RELEASE_ARTIFACTS,
  VIRTUAL_MIC_RELEASE_EMITTER_ID,
  VIRTUAL_MIC_RELEASE_EMITTER_VERSION,
  VIRTUAL_MIC_RELEASE_RUNNER,
  validateVirtualMicReleaseEmitter,
} from './virtual-mic-release-evidence.mjs';
import { validateVirtualMicFingerprintAuthority } from './virtual-mic-fingerprint-authority.mjs';
import { validateProviderPreflightRawAuthority } from './watch-mode-provider-preflight-authority.mjs';

export const RELEASE_MANUAL_COLLECTOR_SCHEMA_VERSION = 1;
export const RELEASE_MANUAL_COLLECTOR_SCRIPT = 'scripts/testing/collect-release-manual-evidence.mjs';
export const RELEASE_MANUAL_COLLECTOR_MAX_AGE_DAYS = 14;

const VMIC_PROTOCOL_V7 = '2026-08-13-audio-routing-v7';
const VMIC_COLLECTOR_ID = 'omni-virtual-mic-target-capture';
const VMIC_COLLECTOR_VERSION = '0.1.0';
const DESKTOP_EMITTER_AUTHORITY = Symbol('desktop-release-evidence-authority');
const REAL_DEVICE_AUDIO_EMITTER_AUTHORITY = Symbol('real-device-audio-release-evidence-authority');
const INSTALL_RELEASE_EMITTER_AUTHORITY = Symbol('install-release-evidence-authority');
const OVERLAY_EMITTER_AUTHORITY = Symbol('overlay-click-through-release-evidence-authority');
const VIRTUAL_MIC_EMITTER_AUTHORITY = Symbol('virtual-mic-release-evidence-authority');
const REAL_DEVICE_AUDIO_RUNNER_PATH = REAL_DEVICE_AUDIO_RUNNER;
const INSTALL_RELEASE_RUNNER_PATH = 'scripts/testing/run-install-release-evidence.mjs';

const profile = (collectorId, evidenceArtifactKind, artifacts) => Object.freeze({
  collectorId,
  collectorVersion: 1,
  evidenceArtifactKind,
  artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze(artifact))),
});

export const RELEASE_MANUAL_COLLECTOR_PROFILES = Object.freeze({
  'E2E-PROVIDER-CONFIG': profile(
    'omni.release.provider-config',
    'provider-config-release-evidence',
    [
      { role: 'desktop-emitter-result', path: 'emitter-result.json', kind: 'file' },
      { role: 'provider-config-snapshot', path: 'provider-config-snapshot.json', kind: 'file' },
      { role: 'diagnostics-bundle', path: 'diagnostics-bundle', kind: 'directory' },
    ],
  ),
  'E2E-PROVIDER-PROBE': profile(
    'omni.release.provider-probe',
    'provider-probe-release-evidence',
    [
      { role: 'desktop-emitter-result', path: 'emitter-result.json', kind: 'file' },
      { role: 'provider-probe-result', path: 'provider-probe-result.json', kind: 'file' },
      { role: 'diagnostics-bundle', path: 'diagnostics-bundle', kind: 'directory' },
    ],
  ),
  'E2E-REAL-DEVICE-AUDIO': REAL_DEVICE_AUDIO_PROFILE,
  'E2E-OVERLAY-CLICK-THROUGH': profile(
    'omni.release.overlay-click-through',
    'overlay-click-through-release-evidence',
    OVERLAY_CLICK_THROUGH_ARTIFACTS.map((artifact) => ({ ...artifact, kind: 'file' })),
  ),
  'E2E-DIAGNOSTICS-EXPORT': profile(
    'omni.release.diagnostics-export',
    'diagnostics-export-release-evidence',
    [
      { role: 'desktop-emitter-result', path: 'emitter-result.json', kind: 'file' },
      { role: 'diagnostics-export-receipt', path: 'diagnostics-export-receipt.json', kind: 'file' },
      { role: 'diagnostics-bundle', path: 'diagnostics-bundle', kind: 'directory' },
    ],
  ),
  'E2E-VIRTUAL-MIC-CAPTURE': profile(
    'omni.release.virtual-mic-v6',
    'virtual-mic-v6-release-evidence',
    VIRTUAL_MIC_RELEASE_ARTIFACTS.map((artifact) => ({ ...artifact, kind: 'file' })),
  ),
  'INSTALL-FRESH': profile(
    'omni.release.install-fresh',
    'install-fresh-release-evidence',
    INSTALL_RELEASE_ARTIFACTS_BY_SCENARIO['INSTALL-FRESH'],
  ),
  'INSTALL-REPAIR': profile(
    'omni.release.install-repair',
    'install-repair-release-evidence',
    INSTALL_RELEASE_ARTIFACTS_BY_SCENARIO['INSTALL-REPAIR'],
  ),
  'INSTALL-UNINSTALL': profile(
    'omni.release.install-uninstall',
    'install-uninstall-release-evidence',
    INSTALL_RELEASE_ARTIFACTS_BY_SCENARIO['INSTALL-UNINSTALL'],
  ),
  'INSTALL-UPGRADE': profile(
    'omni.release.install-upgrade',
    'install-upgrade-release-evidence',
    INSTALL_RELEASE_ARTIFACTS_BY_SCENARIO['INSTALL-UPGRADE'],
  ),
  'INSTALL-RELEASE-LAYOUT': profile(
    'omni.release.installer-layout',
    'installer-layout-release-evidence',
    INSTALL_RELEASE_ARTIFACTS_BY_SCENARIO['INSTALL-RELEASE-LAYOUT'],
  ),
});

// Only these scenarios currently have repository-owned production emitters.
// A schema-shaped caller-provided JSON file is not an emitter. Profiles not
// listed here deliberately remain release-pending until a real authority
// runner is implemented.
export const RELEASE_MANUAL_PRODUCTION_EMITTERS = Object.freeze({
  'E2E-PROVIDER-CONFIG': Object.freeze({
    emitterId: 'omni-desktop-provider-config-release-evidence',
    emitterVersion: '0.1.0',
    runner: 'scripts/testing/run-desktop-release-evidence.mjs',
  }),
  'E2E-PROVIDER-PROBE': Object.freeze({
    emitterId: 'omni-desktop-provider-probe-release-evidence',
    emitterVersion: '0.1.0',
    runner: 'scripts/testing/run-desktop-release-evidence.mjs',
  }),
  'E2E-REAL-DEVICE-AUDIO': Object.freeze({
    emitterId: REAL_DEVICE_AUDIO_EMITTER_ID,
    emitterVersion: REAL_DEVICE_AUDIO_EMITTER_VERSION,
    runner: REAL_DEVICE_AUDIO_RUNNER,
  }),
  'E2E-OVERLAY-CLICK-THROUGH': Object.freeze({
    emitterId: OVERLAY_CLICK_THROUGH_COLLECTOR_ID,
    emitterVersion: OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION,
    runner: OVERLAY_CLICK_THROUGH_RUNNER,
  }),
  'E2E-DIAGNOSTICS-EXPORT': Object.freeze({
    emitterId: 'omni-desktop-diagnostics-export-release-evidence',
    emitterVersion: '0.1.0',
    runner: 'scripts/testing/run-desktop-release-evidence.mjs',
  }),
  'E2E-VIRTUAL-MIC-CAPTURE': Object.freeze({
    emitterId: VIRTUAL_MIC_RELEASE_EMITTER_ID,
    emitterVersion: VIRTUAL_MIC_RELEASE_EMITTER_VERSION,
    runner: VIRTUAL_MIC_RELEASE_RUNNER,
  }),
  ...Object.fromEntries(INSTALL_RELEASE_SCENARIOS.map((scenarioId) => [scenarioId, Object.freeze({
    emitterId: INSTALL_RELEASE_COLLECTOR_ID,
    emitterVersion: INSTALL_RELEASE_COLLECTOR_VERSION,
    runner: 'scripts/testing/run-install-release-evidence.mjs',
  })])),
});

const DESKTOP_RELEASE_EMITTER_SCENARIOS = Object.freeze({
  'E2E-PROVIDER-CONFIG': Object.freeze({
    payloadPaths: Object.freeze(['provider-config-snapshot.json', 'diagnostics-bundle']),
    timeline: Object.freeze([
      'invocation-started',
      'configuration-loaded',
      'configuration-saved-and-reloaded',
      'credential-status-read',
      'diagnostics-export-requested',
      'diagnostics-export-packaged',
      'invocation-completed',
    ]),
  }),
  'E2E-PROVIDER-PROBE': Object.freeze({
    payloadPaths: Object.freeze(['provider-probe-result.json', 'diagnostics-bundle']),
    timeline: Object.freeze([
      'invocation-started',
      'provider-loaded-and-credential-checked',
      'provider-probe-completed',
      'diagnostics-export-requested',
      'diagnostics-export-packaged',
      'invocation-completed',
    ]),
  }),
  'E2E-DIAGNOSTICS-EXPORT': Object.freeze({
    payloadPaths: Object.freeze(['diagnostics-export-receipt.json', 'diagnostics-bundle']),
    timeline: Object.freeze([
      'invocation-started',
      'diagnostics-export-requested',
      'diagnostics-export-packaged',
      'invocation-completed',
    ]),
  }),
});

const asForwardSlash = (value) => value.split(path.sep).join('/');
const sha256Bytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const comparableResolvedPath = (value) => {
  const resolved = path.resolve(String(value ?? ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const sha256File = (candidate) => sha256Bytes(fs.readFileSync(candidate));

const walkFiles = (root, current = root) => {
  const files = [];
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`collector evidence may not contain symbolic links: ${fullPath}`);
    if (entry.isDirectory()) files.push(...walkFiles(root, fullPath));
    else if (entry.isFile()) files.push({
      fullPath,
      relativePath: asForwardSlash(path.relative(root, fullPath)),
    });
  }
  return files;
};

export function hashCollectorArtifact(candidate) {
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) throw new Error(`collector artifact does not exist: ${resolved}`);
  const stats = fs.lstatSync(resolved);
  if (stats.isSymbolicLink()) throw new Error(`collector artifact may not be a symbolic link: ${resolved}`);
  if (stats.isFile()) {
    const bytes = fs.readFileSync(resolved);
    return { kind: 'file', sha256: sha256Bytes(bytes), fileCount: 1, byteCount: bytes.length };
  }
  if (!stats.isDirectory()) throw new Error(`collector artifact must be a file or directory: ${resolved}`);
  const digest = crypto.createHash('sha256');
  const files = walkFiles(resolved);
  let byteCount = 0;
  for (const file of files) {
    const bytes = fs.readFileSync(file.fullPath);
    byteCount += bytes.length;
    digest.update('file\0');
    digest.update(file.relativePath);
    digest.update('\0');
    digest.update(String(bytes.length));
    digest.update('\0');
    digest.update(bytes);
    digest.update('\0');
  }
  return {
    kind: 'directory',
    sha256: digest.digest('hex'),
    fileCount: files.length,
    byteCount,
  };
}

const parseEvidenceTimestamp = (value) => {
  const text = String(value ?? '').trim();
  if (/^unix-ms:\d+$/.test(text)) return Number(text.slice('unix-ms:'.length));
  if (/^unix:\d+$/.test(text)) return Number(text.slice('unix:'.length)) * 1000;
  return Date.parse(text);
};

const timestampIssue = (value, subject, { now, maxAgeDays }) => {
  const parsed = parseEvidenceTimestamp(value);
  if (!Number.isFinite(parsed)) return `${subject} is missing or invalid`;
  if (parsed > now + 5 * 60 * 1000) return `${subject} is more than five minutes in the future`;
  const ageDays = (now - parsed) / 86_400_000;
  if (ageDays > maxAgeDays) return `${subject} is stale (${ageDays.toFixed(1)}d > ${maxAgeDays}d)`;
  return null;
};

const requireString = (issues, value, subject) => {
  if (typeof value !== 'string' || !value.trim()) issues.push(`${subject} is missing`);
};

const requirePositiveInteger = (issues, value, subject) => {
  if (!Number.isInteger(Number(value)) || Number(value) <= 0) issues.push(`${subject} must be a positive integer`);
};

const requireSha256 = (issues, value, subject) => {
  if (!/^[a-f0-9]{64}$/.test(String(value ?? ''))) issues.push(`${subject} must be lowercase SHA-256`);
};

const requireJsonIdentity = (issues, value, artifactKind) => {
  if (value?.schemaVersion !== 1) issues.push(`${artifactKind} schemaVersion must be 1`);
  if (value?.artifactKind !== artifactKind) issues.push(`artifactKind must be ${artifactKind}`);
};

const readPcmWav = (wavPath, expected = {}) => {
  const bytes = fs.readFileSync(wavPath);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path.basename(wavPath)} is not RIFF/WAVE`);
  }
  let format = null;
  let pcmBytes = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) throw new Error(`${path.basename(wavPath)} contains a truncated ${id} chunk`);
    if (id === 'fmt ' && size >= 16) {
      format = {
        audioFormat: bytes.readUInt16LE(start),
        channelCount: bytes.readUInt16LE(start + 2),
        sampleRateHz: bytes.readUInt32LE(start + 4),
        blockAlign: bytes.readUInt16LE(start + 12),
        bitsPerSample: bytes.readUInt16LE(start + 14),
      };
    }
    if (id === 'data') pcmBytes = bytes.subarray(start, end);
    offset = end + (size % 2);
  }
  if (!format || !pcmBytes || format.audioFormat !== 1 || pcmBytes.length === 0) {
    throw new Error(`${path.basename(wavPath)} must contain non-empty PCM data`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (format[key] !== expectedValue) throw new Error(`${path.basename(wavPath)} ${key} must be ${expectedValue}`);
  }
  if (pcmBytes.length % format.blockAlign !== 0) throw new Error(`${path.basename(wavPath)} PCM data is not frame-aligned`);
  let squareSum = 0;
  let sampleCount = 0;
  if (format.bitsPerSample === 16) {
    for (let offset = 0; offset + 1 < pcmBytes.length; offset += 2) {
      const sample = pcmBytes.readInt16LE(offset) / 32768;
      squareSum += sample * sample;
      sampleCount += 1;
    }
  }
  return {
    bytes,
    pcmBytes,
    format,
    frames: pcmBytes.length / format.blockAlign,
    rms: sampleCount > 0 ? Math.sqrt(squareSum / sampleCount) : 0,
  };
};

const orderedTimeline = (issues, timeline, expected, subject) => {
  if (!Array.isArray(timeline) || timeline.length !== expected.length) {
    issues.push(`${subject} must contain exactly ${expected.join(' -> ')}`);
    return;
  }
  let previousTimestamp = -Infinity;
  let previousMonotonic = -Infinity;
  for (const [index, expectedStatus] of expected.entries()) {
    const event = timeline[index];
    const status = event?.playbackStatus ?? event?.status ?? event?.event;
    if (status !== expectedStatus) issues.push(`${subject} status ${index} must be ${expectedStatus}`);
    const rawTimestamp = event?.observedAt ?? event?.timestamp ?? event?.timestampMs;
    const observedAt = typeof rawTimestamp === 'number'
      ? rawTimestamp
      : parseEvidenceTimestamp(rawTimestamp);
    const monotonic = Number(event?.collectorReceivedAtMonotonicNs);
    const sequence = Number(event?.sequence);
    const hasMonotonic = Number.isFinite(monotonic);
    const hasSequence = Number.isInteger(sequence) && sequence > 0;
    if (hasSequence && sequence !== index + 1) {
      issues.push(`${subject} sequence ${index} must be ${index + 1}`);
    }
    if (
      !Number.isFinite(observedAt)
      || observedAt < previousTimestamp
      || (hasMonotonic && monotonic <= previousMonotonic)
      || (!hasMonotonic && !hasSequence && observedAt <= previousTimestamp)
    ) {
      issues.push(`${subject} timestamps must be monotonic and ordered`);
      break;
    }
    previousTimestamp = observedAt;
    if (hasMonotonic) previousMonotonic = monotonic;
  }
};

const desktopEmitterArtifactRecords = (root, payloadPaths) => payloadPaths.map((relativePath) => ({
  path: relativePath,
  ...hashCollectorArtifact(path.join(root, relativePath)),
}));

const bundleContainsInvocation = (bundleRoot, invocationId) => walkFiles(bundleRoot)
  .filter((entry) => entry.relativePath.startsWith('logs/'))
  .some((entry) => fs.readFileSync(entry.fullPath, 'utf8').includes(invocationId));

const FULL_DIAGNOSTICS_REQUIRED_PATHS = Object.freeze([
  'diagnostics-summary.json',
  'environment.json',
  'log-summary.json',
  'diagnostics-report.txt',
  'snapshots/diagnostics.json',
  'snapshots/runtime.json',
  'snapshots/audio.json',
  'snapshots/bridge.json',
  'snapshots/storage.json',
  'snapshots/config.json',
]);

const FULL_DIAGNOSTICS_PAYLOAD_KINDS = Object.freeze({
  'diagnostics-summary.json': 'core-summary',
  'environment.json': 'environment',
  'log-summary.json': 'log-summary',
  'diagnostics-report.txt': 'human-readable-report',
  'snapshots/diagnostics.json': 'snapshot',
  'snapshots/runtime.json': 'snapshot',
  'snapshots/audio.json': 'snapshot',
  'snapshots/bridge.json': 'snapshot',
  'snapshots/storage.json': 'snapshot',
  'snapshots/config.json': 'snapshot',
});

const jsonPointer = (value, pointer) => pointer
  .split('/')
  .slice(1)
  .reduce((current, segment) => (
    current != null && Object.prototype.hasOwnProperty.call(current, segment)
      ? current[segment]
      : null
  ), value);

const arrayLengthAt = (value, pointer) => {
  const items = jsonPointer(value, pointer);
  return Array.isArray(items) ? items.length : null;
};

const routeDiagnosticsSummary = (audio, pointer) => ({
  captureState: jsonPointer(audio, `${pointer}/captureState`),
  preBufferState: jsonPointer(audio, `${pointer}/preBufferState`),
  vadState: jsonPointer(audio, `${pointer}/vadState`),
  bufferAheadMs: jsonPointer(audio, `${pointer}/bufferAheadMs`),
  framesCaptured: jsonPointer(audio, `${pointer}/framesCaptured`),
  segmentCount: jsonPointer(audio, `${pointer}/segmentCount`),
  streamBound: jsonPointer(audio, `${pointer}/streamBound`),
  lastEnergyDb: jsonPointer(audio, `${pointer}/lastEnergyDb`),
  lastFrameAt: jsonPointer(audio, `${pointer}/lastFrameAt`),
  lastErrorCode: jsonPointer(audio, `${pointer}/lastErrorCode`),
  recommendedAction: jsonPointer(audio, `${pointer}/recommendedAction`),
});

const recomputeDiagnosticsCoreSummary = ({ generatedAt, diagnostics, runtime, audio, bridge, storage }) => ({
  schemaVersion: 2,
  generatedAt,
  scope: 'full',
  diagnostics: {
    status: jsonPointer(diagnostics, '/status'),
    supportTier: jsonPointer(diagnostics, '/supportTier'),
    installStatus: jsonPointer(diagnostics, '/installStatus'),
    providerStatus: jsonPointer(diagnostics, '/providerStatus'),
    driverStatus: jsonPointer(diagnostics, '/driverStatus'),
    deviceStatus: jsonPointer(diagnostics, '/deviceStatus'),
    lastSelfCheckAt: jsonPointer(diagnostics, '/lastSelfCheckAt'),
    logDroppedCount: jsonPointer(diagnostics, '/logDroppedCount'),
    logWriteErrorCount: jsonPointer(diagnostics, '/logWriteErrorCount'),
    recentErrorCount: arrayLengthAt(diagnostics, '/recentErrors'),
  },
  runtime: {
    available: true,
    coreState: jsonPointer(runtime, '/coreState'),
    bridgeStatus: jsonPointer(runtime, '/bridgeStatus'),
    activeProfileId: jsonPointer(runtime, '/activeProfileId'),
    trayReady: jsonPointer(runtime, '/trayReady'),
    lastSyncAt: jsonPointer(runtime, '/lastSyncAt'),
    sessionId: jsonPointer(runtime, '/sessionId'),
    windowCount: arrayLengthAt(runtime, '/windows'),
    notificationCount: arrayLengthAt(runtime, '/notifications'),
  },
  audio: {
    status: jsonPointer(audio, '/status'),
    host: jsonPointer(audio, '/host'),
    renderDeviceCount: arrayLengthAt(audio, '/renderDevices'),
    captureDeviceCount: arrayLengthAt(audio, '/captureDevices'),
    sessionStartedAt: jsonPointer(audio, '/sessionStartedAt'),
    sttConnected: jsonPointer(audio, '/sttConnected'),
    sttBufferSize: jsonPointer(audio, '/sttBufferSize'),
    sttConnection: jsonPointer(audio, '/sttConnection'),
    inbound: routeDiagnosticsSummary(audio, '/inbound'),
    outbound: routeDiagnosticsSummary(audio, '/outbound'),
    subtitle: {
      queueDepth: jsonPointer(audio, '/subtitleOverlay/queueDepth'),
      droppedCueCount: jsonPointer(audio, '/subtitleOverlay/droppedCueCount'),
      firstTranslationAverageMs: jsonPointer(audio, '/subtitleOverlay/firstTranslationAverageMs'),
      firstTranslationLastMs: jsonPointer(audio, '/subtitleOverlay/firstTranslationLastMs'),
      firstTranslationSampleCount: jsonPointer(audio, '/subtitleOverlay/firstTranslationSampleCount'),
    },
    echoCaptureDiagnostics: {
      processedChunks: jsonPointer(audio, '/echoCaptureDiagnostics/processedChunks'),
      playbackActiveChunks: jsonPointer(audio, '/echoCaptureDiagnostics/playbackActiveChunks'),
      forwardedToAsrChunks: jsonPointer(audio, '/echoCaptureDiagnostics/forwardedToAsrChunks'),
      droppedChunks: jsonPointer(audio, '/echoCaptureDiagnostics/droppedChunks'),
    },
    speech: {
      status: jsonPointer(audio, '/speech/status'),
      dispatchState: jsonPointer(audio, '/speech/dispatchState'),
      queueDepth: jsonPointer(audio, '/speech/queueDepth'),
      policy: jsonPointer(audio, '/speech/policy'),
      outputTarget: jsonPointer(audio, '/speech/outputTarget'),
      lastError: jsonPointer(audio, '/speech/lastError'),
      speakerFramesWritten: jsonPointer(audio, '/speech/speakerFramesWritten'),
      virtualMicFramesWritten: jsonPointer(audio, '/speech/virtualMicFramesWritten'),
    },
  },
  bridge: {
    status: jsonPointer(bridge, '/status'),
    processStatus: jsonPointer(bridge, '/processStatus'),
    bridgeState: jsonPointer(bridge, '/bridgeState'),
    lifecycleState: jsonPointer(bridge, '/lifecycleState'),
    installChannel: jsonPointer(bridge, '/installChannel'),
    installPhase: jsonPointer(bridge, '/installPhase'),
    driverHealth: jsonPointer(bridge, '/driverHealth'),
    driverVersion: jsonPointer(bridge, '/driverVersion'),
    bridgeVersion: jsonPointer(bridge, '/bridgeVersion'),
    captureBackend: jsonPointer(bridge, '/captureBackend'),
    captureRestartCount: jsonPointer(bridge, '/captureRestartCount'),
    underrunCount: jsonPointer(bridge, '/underrunCount'),
    droppedFrameCount: jsonPointer(bridge, '/droppedFrameCount'),
    lastErrorCode: jsonPointer(bridge, '/lastErrorCode'),
    recommendedAction: jsonPointer(bridge, '/recommendedAction'),
    driverProbeState: jsonPointer(bridge, '/driverProbeState'),
    testSigningEnabled: jsonPointer(bridge, '/testSigningEnabled'),
    memoryIntegrityEnabled: jsonPointer(bridge, '/memoryIntegrityEnabled'),
    secureBootEnabled: jsonPointer(bridge, '/secureBootEnabled'),
    ioctlAvailable: jsonPointer(bridge, '/ioctlAvailable'),
  },
  storage: {
    status: jsonPointer(storage, '/status'),
    schemaVersion: jsonPointer(storage, '/schemaVersion'),
    credentialBackend: jsonPointer(storage, '/credentialBackend'),
    hasPersistedConfig: jsonPointer(storage, '/hasPersistedConfig'),
    snapshotCount: jsonPointer(storage, '/snapshotCount'),
    lastSavedAt: jsonPointer(storage, '/lastSavedAt'),
  },
});

const hasOwnFields = (value, fields) => value != null
  && typeof value === 'object'
  && !Array.isArray(value)
  && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));

const validateDiagnosticsSnapshotShapes = (issues, snapshots) => {
  const { diagnostics, runtime, audio, bridge, storage, config } = snapshots;
  if (!hasOwnFields(diagnostics, [
    'status', 'supportTier', 'installStatus', 'providerStatus', 'driverStatus', 'deviceStatus',
    'categories', 'supportMatrix', 'modelTraceSummary', 'recentLogs', 'recentErrors',
    'logDroppedCount', 'logWriteErrorCount',
  ]) || !Array.isArray(diagnostics.categories) || !Array.isArray(diagnostics.supportMatrix)
    || !Array.isArray(diagnostics.recentLogs) || !Array.isArray(diagnostics.recentErrors)) {
    issues.push('diagnostics snapshot does not match DiagnosticsRuntimeSnapshot');
  }
  if (!hasOwnFields(runtime, [
    'coreState', 'bridgeStatus', 'activeProfileId', 'trayReady', 'lastSyncAt', 'sessionId',
    'bridge', 'diagnostics', 'storage', 'windows', 'notifications',
  ]) || typeof runtime.trayReady !== 'boolean' || !Array.isArray(runtime.windows)
    || !Array.isArray(runtime.notifications)) {
    issues.push('runtime snapshot does not match RuntimeSnapshot');
  }
  if (!hasOwnFields(audio, [
    'snapshotSeq', 'status', 'host', 'renderDevices', 'captureDevices', 'inbound', 'outbound',
    'subtitleOverlay', 'speech', 'echoCaptureDiagnostics', 'aecBackend', 'aecStatus',
    'sttConnected', 'sttBufferSize', 'sttConnection',
  ]) || !Array.isArray(audio.renderDevices) || !Array.isArray(audio.captureDevices)
    || typeof audio.sttConnected !== 'boolean') {
    issues.push('audio snapshot does not match AudioRuntimeSnapshot');
  }
  if (!hasOwnFields(bridge, [
    'processStatus', 'installChannel', 'installPhase', 'bridgeState', 'lifecycleState',
    'driverHealth', 'bridgeVersion', 'captureBackend', 'captureRestartCount', 'underrunCount',
    'droppedFrameCount', 'driverProbeState', 'testSigningEnabled', 'memoryIntegrityEnabled',
    'ioctlAvailable', 'status',
  ])) issues.push('bridge snapshot does not match BridgeRuntimeSnapshot');
  if (!hasOwnFields(storage, [
    'status', 'schemaVersion', 'databasePath', 'credentialBackend', 'hasPersistedConfig',
    'snapshotCount', 'lastSavedAt', 'lastExportPath', 'lastImportPath',
  ]) || !Number.isInteger(Number(storage?.schemaVersion))) {
    issues.push('storage snapshot does not match StorageRuntimeSnapshot');
  }
  if (!hasOwnFields(config, ['activeProviderTemplateId', 'providers'])
    || !Array.isArray(config.providers) || config.providers.length === 0) {
    issues.push('config snapshot does not match the persisted application configuration contract');
  }
  if (!isDeepStrictEqual(runtime?.diagnostics, diagnostics)) {
    issues.push('runtime snapshot embedded diagnostics does not match its standalone snapshot');
  }
  for (const [embedded, standalone, subject, fields] of [
    [runtime?.bridge, bridge, 'bridge', [
      'bridgeProcessId', 'bridgeInstanceId', 'installChannel', 'targetDeviceId',
      'expectedDriverVersion', 'expectedBridgeVersion', 'driverVersion', 'bridgeVersion',
      'sourceCaptureMode', 'captureBackend', 'excludedProcessId', 'sessionId',
      'endpointName', 'captureEndpointName',
    ]],
    [runtime?.storage, storage, 'storage', [
      'status', 'schemaVersion', 'databasePath', 'credentialBackend', 'hasPersistedConfig',
    ]],
  ]) {
    if (!hasOwnFields(embedded, fields)
      || fields.some((field) => JSON.stringify(embedded[field]) !== JSON.stringify(standalone?.[field]))) {
      issues.push(`runtime snapshot embedded ${subject} identity does not match its standalone snapshot`);
    }
  }
};

const validateFullDiagnosticsBundle = (bundleRoot, options) => {
  const issues = [];
  const manifest = readJson(path.join(bundleRoot, 'bundle-manifest.json'));
  if (manifest?.schemaVersion !== 2 || manifest?.scope !== 'full') {
    issues.push('diagnostics bundle manifest must be schemaVersion 2 with full scope');
  }
  const timeIssue = timestampIssue(manifest?.generatedAt, 'diagnostics bundle generatedAt', options);
  if (timeIssue) issues.push(timeIssue);
  if (manifest?.redactionPolicy !== 'credential-patterns-v2') {
    issues.push('diagnostics bundle redactionPolicy is invalid');
  }
  const payloadFiles = Array.isArray(manifest?.payloadFiles) ? manifest.payloadFiles : [];
  const declared = new Set();
  let declaredPayloadBytes = 0;
  for (const entry of payloadFiles) {
    const relative = String(entry?.path ?? '').replaceAll('\\', '/');
    const resolved = path.resolve(bundleRoot, relative);
    if (!relative || resolved === bundleRoot || !resolved.startsWith(`${path.resolve(bundleRoot)}${path.sep}`)) {
      issues.push(`diagnostics bundle contains invalid payload path ${relative || '(missing)'}`);
      continue;
    }
    if (declared.has(relative)) issues.push(`diagnostics bundle repeats payload path ${relative}`);
    declared.add(relative);
    requireString(issues, entry?.kind, `diagnostics bundle payload kind for ${relative}`);
    if (
      Object.prototype.hasOwnProperty.call(FULL_DIAGNOSTICS_PAYLOAD_KINDS, relative)
      && entry?.kind !== FULL_DIAGNOSTICS_PAYLOAD_KINDS[relative]
    ) issues.push(`diagnostics bundle payload kind for ${relative} must be ${FULL_DIAGNOSTICS_PAYLOAD_KINDS[relative]}`);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      issues.push(`diagnostics bundle payload is missing: ${relative}`);
      continue;
    }
    const bytes = fs.statSync(resolved).size;
    if (Number(entry?.bytes) !== bytes) {
      issues.push(`diagnostics bundle payload byte count mismatch: ${relative}`);
    }
    declaredPayloadBytes += bytes;
  }
  for (const required of FULL_DIAGNOSTICS_REQUIRED_PATHS) {
    if (!declared.has(required)) issues.push(`diagnostics bundle manifest is missing ${required}`);
  }
  if (![...declared].some((relative) => relative.startsWith('logs/'))) {
    issues.push('diagnostics bundle manifest must include production log payloads');
  }
  const diskFiles = walkFiles(bundleRoot).map((entry) => entry.relativePath);
  const expectedFiles = new Set(['bundle-manifest.json', ...declared]);
  for (const diskFile of diskFiles) {
    if (!expectedFiles.has(diskFile)) issues.push(`diagnostics bundle contains undeclared file ${diskFile}`);
  }
  if (
    Number(manifest?.totals?.payloadFileCount) !== payloadFiles.length
    || Number(manifest?.totals?.fileCount) !== diskFiles.length
    || Number(manifest?.totals?.payloadBytes) !== declaredPayloadBytes
    || Number(manifest?.totals?.bundleBytes) !== hashCollectorArtifact(bundleRoot).byteCount
  ) issues.push('diagnostics bundle totals do not match the files on disk');
  if (FULL_DIAGNOSTICS_REQUIRED_PATHS.some((required) => (
    !fs.existsSync(path.join(bundleRoot, ...required.split('/')))
  ))) return { issues, manifest, environment: null, payloadFiles };
  const environment = readJson(path.join(bundleRoot, 'environment.json'));
  if (
    environment?.schemaVersion !== 2
    || environment?.scope !== 'full'
    || environment?.generatedAt !== manifest?.generatedAt
    || !/omni.*desktop/i.test(String(environment?.executableName ?? ''))
  ) {
    issues.push('diagnostics environment must identify the production Omni desktop process');
  }
  requirePositiveInteger(issues, environment?.processId, 'diagnostics environment processId');

  const snapshots = {
    diagnostics: readJson(path.join(bundleRoot, 'snapshots', 'diagnostics.json')),
    runtime: readJson(path.join(bundleRoot, 'snapshots', 'runtime.json')),
    audio: readJson(path.join(bundleRoot, 'snapshots', 'audio.json')),
    bridge: readJson(path.join(bundleRoot, 'snapshots', 'bridge.json')),
    storage: readJson(path.join(bundleRoot, 'snapshots', 'storage.json')),
    config: readJson(path.join(bundleRoot, 'snapshots', 'config.json')),
  };
  validateDiagnosticsSnapshotShapes(issues, snapshots);
  const summary = readJson(path.join(bundleRoot, 'diagnostics-summary.json'));
  const recomputedSummary = recomputeDiagnosticsCoreSummary({
    generatedAt: manifest?.generatedAt,
    ...snapshots,
  });
  if (!isDeepStrictEqual(summary, recomputedSummary)) {
    issues.push('diagnostics summary does not match the independently recomputed production snapshots');
  }

  const logSummary = readJson(path.join(bundleRoot, 'log-summary.json'));
  const logs = Array.isArray(logSummary?.files) ? logSummary.files : [];
  if (
    logSummary?.schemaVersion !== 2
    || logSummary?.scope !== 'full'
    || logSummary?.redactionPolicy !== 'credential-patterns-v2'
    || logs.length === 0
    || !hasOwnFields(logSummary?.totals, [
      'fileCount', 'truncatedFileCount', 'redactionCount', 'originalBytes', 'exportedBytes',
      'originalLineCount', 'exportedLineCount', 'levelStats', 'categoryStats',
    ])
  ) issues.push('diagnostics log summary does not match the production full-export schema');
  let exportedLogBytes = 0;
  let exportedLogLines = 0;
  for (const log of logs) {
    const relative = String(log?.outputPath ?? '').replaceAll('\\', '/');
    const declaredEntry = payloadFiles.find((entry) => String(entry?.path ?? '').replaceAll('\\', '/') === relative);
    const candidate = path.resolve(bundleRoot, relative);
    if (
      !relative.startsWith('logs/')
      || declaredEntry?.kind !== 'redacted-log'
      || !fs.existsSync(candidate)
      || !fs.statSync(candidate).isFile()
      || Number(log?.exportedBytes) !== fs.statSync(candidate).size
      || typeof log?.truncated !== 'boolean'
      || !hasOwnFields(log, [
        'source', 'name', 'outputPath', 'originalBytes', 'exportedBytes', 'originalLineCount',
        'exportedLineCount', 'redactionCount', 'truncated', 'levelStats', 'categoryStats',
      ])
    ) issues.push(`diagnostics log receipt is invalid for ${relative || '(missing outputPath)'}`);
    exportedLogBytes += Number(log?.exportedBytes ?? 0);
    exportedLogLines += Number(log?.exportedLineCount ?? 0);
  }
  if (
    Number(logSummary?.totals?.fileCount) !== logs.length
    || Number(logSummary?.totals?.exportedBytes) !== exportedLogBytes
    || Number(logSummary?.totals?.exportedLineCount) !== exportedLogLines
    || Number(manifest?.totals?.logFileCount) !== logs.length
    || Number(manifest?.totals?.exportedLogBytes) !== exportedLogBytes
    || Number(manifest?.totals?.exportedLogLines) !== exportedLogLines
  ) issues.push('diagnostics log totals do not match the raw exported logs');

  const report = fs.readFileSync(path.join(bundleRoot, 'diagnostics-report.txt'), 'utf8');
  if (
    !report.startsWith('Omni Translate Diagnostics Report\n')
    || !report.includes(`Generated: ${manifest?.generatedAt}\n`)
    || !report.includes('Scope: full\n')
    || !report.includes('Core status\n')
    || !report.includes('Logs\n')
    || !report.includes('Warnings\n')
  ) issues.push('diagnostics human-readable report does not match the production report contract');
  return { issues, manifest, environment, payloadFiles, snapshots, summary, logSummary };
};

const validateDesktopEmitter = (root, scenarioId, options) => {
  const spec = DESKTOP_RELEASE_EMITTER_SCENARIOS[scenarioId];
  const registered = RELEASE_MANUAL_PRODUCTION_EMITTERS[scenarioId];
  const result = readJson(path.join(root, 'emitter-result.json'));
  const bundleRoot = path.join(root, 'diagnostics-bundle');
  const issues = [];
  requireJsonIdentity(issues, result, 'desktop-release-evidence-emitter-result');
  if (
    result?.collectorId !== registered?.emitterId
    || result?.collectorVersion !== registered?.emitterVersion
  ) issues.push(`desktop emitter must be ${registered?.emitterId} ${registered?.emitterVersion}`);
  if (result?.scenarioId !== scenarioId || result?.status !== 'completed' || result?.error != null) {
    issues.push(`desktop emitter result must be a completed ${scenarioId} invocation`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(result?.invocationId ?? ''))) {
    issues.push('desktop emitter invocationId must be a UUID');
  }
  requirePositiveInteger(issues, result?.desktopProcessId, 'desktop emitter processId');
  requireString(issues, result?.desktopExecutable, 'desktop emitter executable path');
  requireSha256(issues, result?.desktopExecutableSha256, 'desktop emitter executable hash');
  if (!/^[a-f0-9]{40}$/i.test(String(result?.sourceHeadCommit ?? ''))) {
    issues.push('desktop emitter sourceHeadCommit must be an exact Git commit');
  }
  for (const [value, subject] of [
    [result?.startedAt, 'desktop emitter startedAt'],
    [result?.completedAt, 'desktop emitter completedAt'],
  ]) {
    const issue = timestampIssue(value, subject, options);
    if (issue) issues.push(issue);
  }
  const startedAt = parseEvidenceTimestamp(result?.startedAt);
  const completedAt = parseEvidenceTimestamp(result?.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    issues.push('desktop emitter startedAt/completedAt ordering is invalid');
  }
  orderedTimeline(issues, result?.timeline, spec.timeline, 'desktop emitter timeline');
  if (
    !Array.isArray(result?.timeline)
    || result.timeline.some((event, index) => (
      event?.invocationId !== result.invocationId || Number(event?.sequence) !== index + 1
    ))
  ) issues.push('desktop emitter timeline must bind every ordered event to its invocationId');

  const expectedArtifacts = desktopEmitterArtifactRecords(root, spec.payloadPaths);
  if (JSON.stringify(result?.artifacts) !== JSON.stringify(expectedArtifacts)) {
    issues.push('desktop emitter raw artifact hashes/sizes do not match the fixed payload');
  }
  const diagnostics = result?.diagnosticsExport;
  const bundleHash = hashCollectorArtifact(bundleRoot);
  const fullBundle = validateFullDiagnosticsBundle(bundleRoot, options);
  issues.push(...fullBundle.issues);
  if (
    diagnostics?.scope !== 'full'
    || !path.isAbsolute(String(diagnostics?.canonicalOutputPath ?? ''))
    || diagnostics?.canonicalBundleSha256 !== bundleHash.sha256
    || diagnostics?.packagedBundleSha256 !== bundleHash.sha256
    || Number(diagnostics?.fileCount) !== bundleHash.fileCount
    || diagnostics?.bundleManifestSha256 !== sha256File(path.join(bundleRoot, 'bundle-manifest.json'))
  ) issues.push('desktop emitter diagnostics authority does not match the packaged full bundle');
  if (!bundleContainsInvocation(bundleRoot, String(result?.invocationId ?? ''))) {
    issues.push('packaged diagnostics logs do not contain the desktop emitter invocationId');
  }
  const environment = fullBundle.environment;
  if (Number(environment?.processId) !== Number(result?.desktopProcessId)) {
    issues.push('diagnostics environment processId must match the desktop emitter processId');
  }
  if (
    environment?.buildProfile !== 'release'
    || environment?.debugAssertions !== false
    || String(environment?.buildCommit ?? '').toLowerCase()
      !== String(result?.sourceHeadCommit ?? '').toLowerCase()
    || environment?.executableName !== path.basename(String(result?.desktopExecutable ?? ''))
  ) {
    issues.push('diagnostics environment must bind the emitter release executable and source commit');
  }
  if (
    String(result?.sourceHeadCommit ?? '').toLowerCase()
      !== String(options?.currentProvenance?.headCommit ?? '').toLowerCase()
  ) {
    issues.push('desktop emitter sourceHeadCommit must match the current exact clean HEAD');
  }
  return {
    issues,
    result,
    diagnostics,
    fullBundle,
    evidenceTimes: [
      result?.startedAt,
      result?.completedAt,
      diagnostics?.generatedAt,
      fullBundle.manifest?.generatedAt,
    ],
  };
};

const selectDiagnosticsProvider = (root, issues, providerId, templateId) => {
  const configPath = path.join(root, 'diagnostics-bundle', 'snapshots', 'config.json');
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
    issues.push('diagnostics config snapshot is missing');
    return { config: null, provider: null };
  }
  const config = readJson(configPath);
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const matches = providers.filter((provider) => (
    provider?.providerId === providerId
    && (!templateId || provider?.templateId === templateId)
  ));
  if (matches.length !== 1) {
    issues.push('diagnostics config snapshot must contain exactly one matching production provider');
    return { config, provider: null };
  }
  return { config, provider: matches[0] };
};

const matchingProviderFields = (issues, observed, expected, fields, subject) => {
  for (const field of fields) {
    if (JSON.stringify(observed?.[field]) !== JSON.stringify(expected?.[field])) {
      issues.push(`${subject} ${field} does not match the full diagnostics config snapshot`);
    }
  }
};

const validateProviderConfig = (root, options) => {
  const value = readJson(path.join(root, 'provider-config-snapshot.json'));
  const emitter = validateDesktopEmitter(root, 'E2E-PROVIDER-CONFIG', options);
  const issues = [...emitter.issues];
  requireJsonIdentity(issues, value, 'provider-config-production-snapshot');
  if (value?.source !== 'desktop-api-v2' || value?.productionMode !== true) {
    issues.push('provider config must come from the production desktop-api-v2 runtime');
  }
  const timeIssue = timestampIssue(value?.capturedAt, 'provider config capturedAt', options);
  if (timeIssue) issues.push(timeIssue);
  requirePositiveInteger(issues, value?.desktopProcessId, 'provider config desktopProcessId');
  for (const [field, subject] of [
    [value?.provider?.templateId, 'provider templateId'],
    [value?.provider?.providerId, 'providerId'],
    [value?.provider?.kind, 'provider kind'],
    [value?.provider?.model, 'provider model'],
    [value?.provider?.baseUrl, 'provider baseUrl'],
    [value?.provider?.transport, 'provider transport'],
  ]) requireString(issues, field, subject);
  if (value?.provider?.configPersisted !== true) issues.push('provider configPersisted must be true');
  if (value?.provider?.authRef?.kind !== 'credential-ref' || !String(value?.provider?.authRef?.reference ?? '').startsWith('credential://')) {
    issues.push('provider authRef must be a credential:// credential-ref');
  }
  if (value?.provider?.secretValuePresent !== false) issues.push('provider evidence must prove no secret value is present');
  if (
    value?.credentialStatus?.backend !== 'windows-credential-manager'
    || value?.credentialStatus?.exists !== true
    || value?.credentialStatus?.reference !== value?.provider?.authRef?.reference
  ) issues.push('credential status must prove the matching Windows Credential Manager reference exists');
  const checkedIssue = timestampIssue(value?.credentialStatus?.checkedAt, 'credential status checkedAt', options);
  if (checkedIssue) issues.push(checkedIssue);
  const diagnosticsProvider = selectDiagnosticsProvider(
    root,
    issues,
    value?.provider?.providerId,
    value?.provider?.templateId,
  );
  matchingProviderFields(
    issues,
    value?.provider,
    diagnosticsProvider.provider,
    ['templateId', 'providerId', 'kind', 'model', 'baseUrl', 'transport', 'authRef'],
    'provider config snapshot',
  );
  if (
    value?.collectorId !== emitter.result?.collectorId
    || value?.collectorVersion !== emitter.result?.collectorVersion
    || value?.invocationId !== emitter.result?.invocationId
    || Number(value?.desktopProcessId) !== Number(emitter.result?.desktopProcessId)
    || String(value?.sourceHeadCommit ?? '').toLowerCase()
      !== String(emitter.result?.sourceHeadCommit ?? '').toLowerCase()
    || !isDeepStrictEqual(value?.diagnosticsExport, emitter.diagnostics)
  ) issues.push('provider config snapshot is not bound to the desktop emitter and diagnostics invocation');
  return {
    issues,
    evidenceTimes: [...emitter.evidenceTimes, value?.capturedAt, value?.credentialStatus?.checkedAt],
    summary: {
      providerId: value?.provider?.providerId ?? null,
      model: value?.provider?.model ?? null,
      transport: value?.provider?.transport ?? null,
      credentialReference: value?.provider?.authRef?.reference ?? null,
      desktopProcessId: Number(value?.desktopProcessId ?? 0),
    },
  };
};

const validateProviderProbe = (root, options) => {
  const value = readJson(path.join(root, 'provider-probe-result.json'));
  const emitter = validateDesktopEmitter(root, 'E2E-PROVIDER-PROBE', options);
  const issues = [...emitter.issues];
  requireJsonIdentity(issues, value, 'provider-production-probe-result');
  if (value?.source !== 'desktop-api-v2' || value?.productionMode !== true) {
    issues.push('provider probe must come from the production desktop-api-v2 runtime');
  }
  if (
    value?.operation !== 'text-translation-preflight'
    || value?.inputMode !== 'text-only'
    || Number(value?.externalAudioSamples) !== 0
    || Number(value?.providerInvocationCount) !== 1
  ) {
    issues.push('provider probe must bind one text-only invocation with zero external audio samples');
  }
  const timeIssue = timestampIssue(value?.checkedAt, 'provider probe checkedAt', options);
  if (timeIssue) issues.push(timeIssue);
  requirePositiveInteger(issues, value?.desktopProcessId, 'provider probe desktopProcessId');
  for (const [field, subject] of [
    [value?.templateId, 'provider templateId'],
    [value?.providerId, 'providerId'],
    [value?.model, 'provider model'],
    [value?.transportRequested, 'requested transport'],
    [value?.effectiveTransport, 'effective transport'],
    [value?.endpointHost, 'endpoint host'],
  ]) requireString(issues, field, subject);
  if (value?.verdict !== 'available' || value?.rawProbeResult?.verdict !== 'available') {
    issues.push('provider probe verdict must be the production available verdict');
  }
  if (
    !Number.isFinite(Number(value?.latencyMs))
    || Number(value.latencyMs) < 0
    || Number(value.latencyMs) > 1200
    || Number(value?.latencyBudgetMs) !== 1200
  ) {
    issues.push('available provider probe latency must be within the production 1200 ms budget');
  }
  if (
    value?.streamObserved !== true
    || value?.responseShapeStable !== true
    || value?.errorShapeStable !== true
  ) {
    issues.push('available provider probe must observe streaming with stable response/error shapes');
  }
  const raw = value?.rawProbeResult;
  for (const [field, subject] of [
    [raw?.id, 'raw provider probe id'],
    [raw?.templateId, 'raw provider probe templateId'],
    [raw?.providerId, 'raw provider probe providerId'],
    [raw?.transportRequested, 'raw provider probe requested transport'],
    [raw?.transportEffective, 'raw provider probe effective transport'],
  ]) requireString(issues, field, subject);
  if (
    raw?.providerId !== value?.providerId
    || raw?.templateId !== value?.templateId
    || raw?.verdict !== value?.verdict
    || raw?.checkedAt !== value?.checkedAt
    || Number(raw?.measuredLatencyMs) !== Number(value?.latencyMs)
    || Number(raw?.latencyBudgetMs) !== 1200
    || Number(raw?.latencyBudgetMs) !== Number(value?.latencyBudgetMs)
    || raw?.streamSupported !== true
    || raw?.streamSupported !== value?.streamObserved
    || raw?.transportRequested !== value?.transportRequested
    || raw?.transportEffective !== value?.effectiveTransport
    || raw?.responseShapeStable !== value?.responseShapeStable
    || raw?.errorShapeStable !== value?.errorShapeStable
    || raw?.error != null
  ) issues.push('raw production Provider probe does not match its top-level result');
  const expectedChecks = Object.freeze({
    streaming: Object.freeze({
      label: '流式能力',
      summary: `已观察到增量事件，实际传输模式为 ${raw?.transportEffective}。`,
    }),
    latency: Object.freeze({
      label: '实时适用性',
      summary: `首个有效事件耗时 ${raw?.measuredLatencyMs} ms，预算 1200 ms。`,
    }),
    'error-shape': Object.freeze({
      label: '错误结构',
      summary: '本次请求未触发上游错误，当前归一化链路可用。',
    }),
    'response-shape': Object.freeze({
      label: '响应格式稳定性',
      summary: '已完整得到 translation.completed 与 response.completed。',
    }),
  });
  const checks = Array.isArray(raw?.checks) ? raw.checks : [];
  if (
    checks.length !== Object.keys(expectedChecks).length
    || JSON.stringify(checks.map((check) => check?.key)) !== JSON.stringify(Object.keys(expectedChecks))
    || checks.some((check) => (
      !Object.prototype.hasOwnProperty.call(expectedChecks, check?.key)
      || !String(check?.id ?? '').endsWith(`-${check?.key}`)
      || check?.status !== 'pass'
      || check?.label !== expectedChecks[check?.key]?.label
      || check?.summary !== expectedChecks[check?.key]?.summary
    ))
    || new Set(checks.map((check) => check.key)).size !== Object.keys(expectedChecks).length
  ) issues.push('available provider probe checks must be the four production pass checks');
  const expectedRationale = raw?.fallbackApplied
    ? '已做传输回退，但当前延迟和结构稳定性仍满足实时要求。'
    : `当前延迟 ${raw?.measuredLatencyMs} ms，允许字幕与译音并行。`;
  const expectedGuidance = [
    expectedRationale,
    ...(raw?.fallbackApplied
      ? ['本次探测已发生 transport fallback，请检查模板默认传输模式是否与上游一致。']
      : []),
    '可直接用于真实 Provider 连通性测试与后续字幕/译音主链路。',
  ];
  if (
    raw?.routingDecision?.subtitlePriority !== 'balanced'
    || raw?.routingDecision?.speechDisposition !== 'ready'
    || raw?.routingDecision?.rationale !== expectedRationale
    || JSON.stringify(raw?.guidance) !== JSON.stringify(expectedGuidance)
    || typeof raw?.fallbackApplied !== 'boolean'
  ) issues.push('available provider probe routingDecision/guidance is not the production available route');
  const diagnosticsProvider = selectDiagnosticsProvider(
    root,
    issues,
    value?.providerId,
    raw?.templateId,
  );
  matchingProviderFields(
    issues,
    {
      templateId: value?.templateId,
      providerId: value?.providerId,
      model: value?.preflightAuthorization ? value?.configuredModel : value?.model,
      transport: value?.transportRequested,
      streamEnabled: true,
      authRef: { reference: value?.credentialStatus?.reference },
    },
    {
      templateId: diagnosticsProvider.provider?.templateId,
      providerId: diagnosticsProvider.provider?.providerId,
      model: diagnosticsProvider.provider?.model,
      transport: diagnosticsProvider.provider?.transport,
      streamEnabled: diagnosticsProvider.provider?.streamEnabled,
      authRef: { reference: diagnosticsProvider.provider?.authRef?.reference },
    },
    ['templateId', 'providerId', 'model', 'transport', 'streamEnabled', 'authRef'],
    'provider probe result',
  );
  try {
    const configuredUrl = new URL(String(diagnosticsProvider.provider?.baseUrl ?? ''));
    if (
      configuredUrl.protocol !== 'https:'
      || configuredUrl.username
      || configuredUrl.password
      || configuredUrl.port
      || configuredUrl.hostname !== value?.endpointHost
    ) {
      issues.push('provider probe endpointHost does not match the diagnostics config baseUrl');
    }
  } catch {
    issues.push('diagnostics config provider baseUrl is invalid');
  }
  if (
    value?.collectorId !== emitter.result?.collectorId
    || value?.collectorVersion !== emitter.result?.collectorVersion
    || value?.invocationId !== emitter.result?.invocationId
    || Number(value?.desktopProcessId) !== Number(emitter.result?.desktopProcessId)
    || String(value?.sourceHeadCommit ?? '').toLowerCase()
      !== String(emitter.result?.sourceHeadCommit ?? '').toLowerCase()
    || !isDeepStrictEqual(value?.diagnosticsExport, emitter.diagnostics)
    || value?.credentialStatus?.backend !== 'windows-credential-manager'
    || value?.credentialStatus?.exists !== true
    || value?.transportRequested !== 'websocket'
    || value?.effectiveTransport !== 'websocket'
    || value?.rawProbeResult?.fallbackApplied !== false
  ) issues.push('provider probe is not bound to the desktop emitter, credential status, and diagnostics invocation');
  return {
    issues,
    evidenceTimes: [...emitter.evidenceTimes, value?.checkedAt],
    summary: {
      providerId: value?.providerId ?? null,
      model: value?.model ?? null,
      operation: value?.operation ?? null,
      inputMode: value?.inputMode ?? null,
      externalAudioSamples: Number(value?.externalAudioSamples ?? -1),
      providerInvocationCount: Number(value?.providerInvocationCount ?? 0),
      effectiveTransport: value?.effectiveTransport ?? null,
      latencyMs: Number(value?.latencyMs ?? 0),
      desktopProcessId: Number(value?.desktopProcessId ?? 0),
    },
  };
};

const validateOverlay = (root, options) => {
  const checked = validateOverlayClickThroughEvidence(root, {
    workspaceRoot: options.workspaceRoot,
    currentProvenance: options.currentProvenance,
    now: options.now,
    maxAgeMs: Number(options.maxAgeDays) * 24 * 60 * 60 * 1000,
  });
  return {
    ...checked,
    evidenceTimes: [
      checked.result?.startedAt,
      checked.ready?.capturedAt,
      checked.click?.receivedAt,
      checked.probe?.capturedAt,
      checked.probe?.operatorObservation?.observedAt,
      checked.transcript?.completedAt,
      checked.result?.completedAt,
    ].filter(Boolean),
  };
};

const validateDiagnosticsBundle = (root, options) => {
  const emitter = validateDesktopEmitter(root, 'E2E-DIAGNOSTICS-EXPORT', options);
  const receipt = readJson(path.join(root, 'diagnostics-export-receipt.json'));
  const bundleRoot = path.join(root, 'diagnostics-bundle');
  const { manifest, environment, payloadFiles } = emitter.fullBundle;
  const issues = [...emitter.issues];
  requireJsonIdentity(issues, receipt, 'diagnostics-full-export-production-receipt');
  if (
    receipt?.collectorId !== emitter.result?.collectorId
    || receipt?.collectorVersion !== emitter.result?.collectorVersion
    || receipt?.invocationId !== emitter.result?.invocationId
    || Number(receipt?.desktopProcessId) !== Number(emitter.result?.desktopProcessId)
    || String(receipt?.sourceHeadCommit ?? '').toLowerCase()
      !== String(emitter.result?.sourceHeadCommit ?? '').toLowerCase()
    || receipt?.productionHandler !== 'diagnostics_events::export_diagnostics_bundle'
    || !isDeepStrictEqual(receipt?.diagnosticsExport, emitter.diagnostics)
  ) issues.push('diagnostics export receipt is not bound to its production emitter invocation');
  const receiptTimeIssue = timestampIssue(receipt?.capturedAt, 'diagnostics receipt capturedAt', options);
  if (receiptTimeIssue) issues.push(receiptTimeIssue);
  return {
    issues,
    evidenceTimes: [...emitter.evidenceTimes, receipt?.capturedAt, manifest?.generatedAt],
    summary: {
      scope: manifest?.scope ?? null,
      generatedAt: manifest?.generatedAt ?? null,
      invocationId: emitter.result?.invocationId ?? null,
      desktopProcessId: Number(environment?.processId ?? 0),
      payloadFileCount: payloadFiles.length,
      bundleSha256: hashCollectorArtifact(bundleRoot).sha256,
    },
  };
};

const vmicAuthorityFields = [
  'collectorId',
  'collectorVersion',
  'parentCollectorProcessId',
  'captureChildProcessId',
  'bridgeProtocolVersion',
  'bridgeProcessId',
  'bridgeInstanceId',
  'bridgeSessionId',
  'captureEndpointId',
  'captureEndpointName',
  'rawCountersBefore',
  'rawCountersAfter',
  'recomputedCounterDelta',
  'cueId',
  'cueStatusTimeline',
  'cueLifecycle',
];

const vmicAuthority = (value) => Object.fromEntries(vmicAuthorityFields.map((field) => [field, value?.[field]]));

const validateVirtualMic = (root, options) => {
  const emitter = validateVirtualMicReleaseEmitter(root, {
    workspaceRoot: options.workspaceRoot,
    implementationRoot: options.implementationRoot,
    currentProvenance: options.currentProvenance,
    now: options.now,
    maxAgeMs: Number(options.maxAgeDays) * 24 * 60 * 60 * 1000,
  });
  const probe = readJson(path.join(root, 'virtual-mic-capture-probe.json'));
  const snapshot = readJson(path.join(root, 'runtime-snapshot.json'));
  const wav = readPcmWav(path.join(root, 'virtual-mic-capture.wav'), {
    sampleRateHz: 48_000,
    channelCount: 1,
    bitsPerSample: 16,
    blockAlign: 2,
  });
  const issues = [...emitter.issues];
  requireJsonIdentity(issues, probe, 'virtual-mic-real-capture-probe');
  requireJsonIdentity(issues, snapshot, 'virtual-mic-runtime-snapshot');
  for (const [value, subject] of [
    [probe?.capturedAt, 'virtual microphone probe capturedAt'],
    [snapshot?.capturedAt, 'virtual microphone snapshot capturedAt'],
  ]) {
    const issue = timestampIssue(value, subject, options);
    if (issue) issues.push(issue);
  }
  if (probe?.capturedAt !== snapshot?.capturedAt) {
    issues.push('virtual microphone probe and runtime snapshot capturedAt must match exactly');
  }
  if (JSON.stringify(vmicAuthority(probe)) !== JSON.stringify(vmicAuthority(snapshot))) {
    issues.push('virtual microphone probe and snapshot collector authority must match exactly');
  }
  if (probe?.collectorId !== VMIC_COLLECTOR_ID || probe?.collectorVersion !== VMIC_COLLECTOR_VERSION) {
    issues.push(`virtual microphone collector must be ${VMIC_COLLECTOR_ID} ${VMIC_COLLECTOR_VERSION}`);
  }
  const pids = [probe?.parentCollectorProcessId, probe?.captureChildProcessId, probe?.bridgeProcessId].map(Number);
  if (!pids.every((pid) => Number.isInteger(pid) && pid > 0) || new Set(pids).size !== 3) {
    issues.push('virtual microphone parent collector, capture child, and Bridge PIDs must be distinct and positive');
  }
  if (
    probe?.targetCaptureApplication?.name !== 'Omni Translate Virtual Microphone Target Capture'
    || probe?.targetCaptureApplication?.classification !== 'real-target'
    || probe?.targetCaptureApplication?.openedEndpoint !== true
    || Number(probe?.targetCaptureApplication?.processId) !== Number(probe?.captureChildProcessId)
  ) issues.push('virtual microphone target capture must be the official collector child process');
  if (probe?.bridgeProtocolVersion !== VMIC_PROTOCOL_V7) issues.push(`virtual microphone Bridge protocol must be ${VMIC_PROTOCOL_V7}`);
  for (const [value, subject] of [
    [probe?.bridgeInstanceId, 'Bridge instance ID'],
    [probe?.bridgeSessionId, 'Bridge session ID'],
    [probe?.captureEndpointId, 'capture endpoint ID'],
    [probe?.captureEndpointName, 'capture endpoint name'],
    [probe?.cueId, 'cue ID'],
  ]) requireString(issues, value, subject);
  if (
    probe?.targetCaptureApplication?.endpointId !== probe?.captureEndpointId
    || probe?.targetCaptureApplication?.endpointName !== probe?.captureEndpointName
    || snapshot?.captureEndpointId !== probe?.captureEndpointId
    || snapshot?.captureEndpointName !== probe?.captureEndpointName
  ) issues.push('virtual microphone endpoint ID/name fields must match across raw artifacts');
  if (
    probe?.format?.sampleRateHz !== 48_000
    || probe?.format?.channelCount !== 1
    || probe?.format?.bitsPerSample !== 16
    || probe?.format?.encoding !== 'pcm16'
    || snapshot?.virtualMicFormat !== '48000Hz/mono/pcm16'
  ) issues.push('virtual microphone format must be 48000 Hz mono PCM16 throughout');
  const beforeVirtual = Number(probe?.rawCountersBefore?.virtualMicFramesWritten);
  const afterVirtual = Number(probe?.rawCountersAfter?.virtualMicFramesWritten);
  const beforePhysical = Number(probe?.rawCountersBefore?.playbackFramesWritten);
  const afterPhysical = Number(probe?.rawCountersAfter?.playbackFramesWritten);
  const deltaVirtual = Number(probe?.recomputedCounterDelta?.virtualMicFramesWritten);
  const deltaPhysical = Number(probe?.recomputedCounterDelta?.playbackFramesWritten);
  if (
    ![beforeVirtual, afterVirtual, beforePhysical, afterPhysical, deltaVirtual, deltaPhysical].every(Number.isInteger)
    || afterVirtual <= beforeVirtual
    || deltaVirtual !== afterVirtual - beforeVirtual
    || deltaPhysical !== afterPhysical - beforePhysical
    || deltaPhysical !== 0
  ) issues.push('virtual microphone raw before/after counters and recomputed deltas are inconsistent');
  const lifecycle = probe?.cueLifecycle ?? {};
  const rawTimeline = Array.isArray(probe?.cueStatusTimeline) ? probe.cueStatusTimeline : [];
  const uniqueTimeline = [];
  const statusById = new Map();
  let previousReceiptNs = -Infinity;
  for (const event of rawTimeline) {
    const receiptNs = Number(event?.collectorReceivedAtMonotonicNs);
    if (!Number.isFinite(receiptNs) || receiptNs <= previousReceiptNs) {
      issues.push('virtual microphone raw cue receipt timestamps must be strictly increasing');
      break;
    }
    previousReceiptNs = receiptNs;
    const rawEvent = { ...event };
    delete rawEvent.collectorReceivedAtMonotonicNs;
    const serialized = JSON.stringify(rawEvent);
    if (statusById.has(event?.statusId)) {
      if (statusById.get(event.statusId) !== serialized) {
        issues.push('virtual microphone Bridge reused one statusId for different raw events');
        break;
      }
    } else {
      statusById.set(event?.statusId, serialized);
      uniqueTimeline.push(event);
    }
  }
  orderedTimeline(issues, uniqueTimeline, ['queued', 'started', 'completed'], 'virtual microphone raw cue timeline');
  if (
    lifecycle?.cueId !== probe?.cueId
    || lifecycle?.queuedCount !== 1
    || lifecycle?.startedCount !== 1
    || lifecycle?.completedCount !== 1
    || lifecycle?.staleDroppedCount !== 0
    || lifecycle?.routeFailedCount !== 0
    || lifecycle?.terminalEventCount !== 1
    || lifecycle?.terminalStatus !== 'completed'
  ) issues.push('virtual microphone cue lifecycle must be exactly-once queued/started/completed');
  for (const event of rawTimeline) {
    if (
      event?.type !== 'bridge.translation.status'
      || event?.cueId !== probe?.cueId
      || event?.sessionId !== probe?.bridgeSessionId
      || typeof event?.statusId !== 'string'
      || !event.statusId.trim()
      || typeof event?.requestId !== 'string'
      || !event.requestId.trim()
      || !Number.isFinite(Number(event?.timestampMs))
      || typeof event?.reason !== 'string'
      || !event.reason.trim()
    ) {
      issues.push('virtual microphone raw cue timeline is not bound to the Bridge session/cue');
      break;
    }
  }
  if (
    snapshot?.virtualMicOutputSupported !== true
    || snapshot?.virtualMicOutputStatus !== 'ready'
    || snapshot?.virtualMicFramesWritten !== afterVirtual
    || snapshot?.virtualMicFramesWrittenBefore !== beforeVirtual
    || snapshot?.virtualMicFramesWrittenAfter !== afterVirtual
    || snapshot?.virtualMicFramesWrittenForCue !== deltaVirtual
    || snapshot?.physicalPlaybackFramesWrittenBefore !== beforePhysical
    || snapshot?.physicalPlaybackFramesWrittenAfter !== afterPhysical
    || snapshot?.physicalPlaybackFramesWrittenForCue !== deltaPhysical
  ) issues.push('virtual microphone runtime snapshot does not match raw counters/capability');
  if (
    probe?.captureWav !== 'virtual-mic-capture.wav'
    || probe?.captureWavSha256 !== sha256Bytes(wav.bytes)
    || Number(probe?.capturedFrames) !== wav.frames
  ) issues.push('virtual microphone WAV hash/frame count does not match the raw capture');
  const fingerprint = probe?.fingerprint ?? {};
  const fingerprintAuthority = validateVirtualMicFingerprintAuthority({
    wavPath: path.join(root, 'virtual-mic-capture.wav'),
    fingerprint,
  });
  issues.push(...fingerprintAuthority.issues);
  if (
    snapshot?.captureWav !== probe?.captureWav
    || snapshot?.captureWavSha256 !== probe?.captureWavSha256
    || snapshot?.capturedFrames !== probe?.capturedFrames
    || JSON.stringify(snapshot?.fingerprint) !== JSON.stringify(probe?.fingerprint)
  ) issues.push('virtual microphone runtime WAV/fingerprint fields must match the capture probe exactly');
  return {
    issues,
    evidenceTimes: [...emitter.evidenceTimes, probe?.capturedAt, snapshot?.capturedAt],
    summary: {
      invocationId: emitter.result?.invocationId ?? null,
      sourceHeadCommit: emitter.result?.sourceHeadCommit ?? null,
      collectorId: probe?.collectorId ?? null,
      collectorVersion: probe?.collectorVersion ?? null,
      parentCollectorProcessId: Number(probe?.parentCollectorProcessId ?? 0),
      captureChildProcessId: Number(probe?.captureChildProcessId ?? 0),
      bridgeProcessId: Number(probe?.bridgeProcessId ?? 0),
      bridgeProtocolVersion: probe?.bridgeProtocolVersion ?? null,
      bridgeInstanceId: probe?.bridgeInstanceId ?? null,
      bridgeSessionId: probe?.bridgeSessionId ?? null,
      captureEndpointId: probe?.captureEndpointId ?? null,
      captureEndpointName: probe?.captureEndpointName ?? null,
      cueId: probe?.cueId ?? null,
      capturedFrames: wav.frames,
      virtualMicFramesWritten: deltaVirtual,
      physicalPlaybackFramesWritten: deltaPhysical,
      cueCompletedCount: Number(lifecycle?.completedCount ?? 0),
      captureWavSha256: sha256Bytes(wav.bytes),
    },
  };
};

const validateDriverProbeReady = (issues, probe, subject) => {
  if (
    probe?.schemaVersion !== 1
    || probe?.driverHealth !== 'running'
    || probe?.errorCode != null
    || probe?.rootDeviceCount !== 1
    || !Array.isArray(probe?.rootInstanceIds)
    || probe.rootInstanceIds.length !== 1
    || !String(probe.rootInstanceIds[0]).startsWith('ROOT\\')
    || typeof probe?.endpointName !== 'string'
    || typeof probe?.captureEndpointName !== 'string'
    || probe?.virtualMicOutputSupported !== true
    || probe?.virtualMicOutputStatus !== 'ready'
    || probe?.virtualMicFormat !== '48000Hz/mono/pcm16'
    || probe?.abiVersion !== '0X20260810'
    || probe?.ioctlAvailable !== true
    || probe?.packageSigningMode !== 'release-injected'
  ) issues.push(`${subject} must prove one healthy release-signed ROOT device and both ready endpoints`);
};

const validateInstallOperation = (issues, operation, artifactKind, options) => {
  requireJsonIdentity(issues, operation, artifactKind);
  const issue = timestampIssue(operation?.completedAt, `${artifactKind} completedAt`, options);
  if (issue) issues.push(issue);
  if (
    operation?.collectorId !== 'omni-release-install-collector'
    || operation?.elevated !== true
    || operation?.exitCode !== 0
    || operation?.signer?.status !== 'valid'
    || operation?.signer?.signingMode !== 'release-injected'
  ) issues.push(`${artifactKind} must be a successful elevated release-signed operation`);
  requireString(issues, operation?.command, `${artifactKind} command`);
  requireString(issues, operation?.packageVersion, `${artifactKind} packageVersion`);
  requireSha256(issues, operation?.packageSha256, `${artifactKind} packageSha256`);
};

const validateInstallFresh = (root, options) => {
  const operation = readJson(path.join(root, 'fresh-install-evidence.json'));
  const state = readJson(path.join(root, 'driver-install-state.json'));
  const probe = readJson(path.join(root, 'driver-probe.json'));
  const pnp = readJson(path.join(root, 'pnp-endpoints.json'));
  const tone = readJson(path.join(root, 'wasapi-tone-probe.json'));
  const issues = [];
  validateInstallOperation(issues, operation, 'install-fresh-operation', options);
  validateDriverProbeReady(issues, probe, 'fresh-install driver probe');
  if (
    state?.protocolVersion !== VMIC_PROTOCOL_V7
    || state?.installChannel !== 'stable'
    || state?.driverHealth !== 'running'
    || state?.driverVersion !== operation?.packageVersion
    || !String(state?.pnpInstanceId ?? '').startsWith('ROOT\\')
    || !String(state?.endpointInstanceId ?? '').startsWith('SWD\\MMDEVAPI\\')
    || !String(state?.captureEndpointInstanceId ?? '').startsWith('SWD\\MMDEVAPI\\')
  ) issues.push('fresh-install driver state does not match the stable package and v6 endpoints');
  requireJsonIdentity(issues, pnp, 'pnp-endpoint-inventory');
  if (
    pnp?.rootDeviceCount !== 1
    || pnp?.renderEndpointCount !== 1
    || pnp?.captureEndpointCount !== 1
    || pnp?.rootInstanceId !== state?.pnpInstanceId
    || pnp?.renderEndpointId !== state?.endpointInstanceId
    || pnp?.captureEndpointId !== state?.captureEndpointInstanceId
  ) issues.push('fresh-install PnP inventory must match the runtime install state exactly');
  requireJsonIdentity(issues, tone, 'wasapi-tone-production-probe');
  if (
    tone?.passed !== true
    || tone?.endpointId !== state?.endpointInstanceId
    || Number(tone?.toneFrames) <= 0
    || Number(tone?.toneRms) <= 0.01
    || Number(tone?.invalidSamples) !== 0
  ) issues.push('fresh-install WASAPI tone probe must pass on the installed render endpoint');
  return {
    issues,
    evidenceTimes: [operation?.completedAt, state?.installedAt, pnp?.capturedAt, tone?.capturedAt],
    summary: {
      packageVersion: operation?.packageVersion ?? null,
      rootInstanceId: state?.pnpInstanceId ?? null,
      renderEndpointId: state?.endpointInstanceId ?? null,
      captureEndpointId: state?.captureEndpointInstanceId ?? null,
      toneFrames: Number(tone?.toneFrames ?? 0),
    },
  };
};

const validateRepair = (root, options) => {
  const operation = readJson(path.join(root, 'repair-evidence.json'));
  const probe = readJson(path.join(root, 'driver-probe.json'));
  const handshake = readJson(path.join(root, 'bridge-handshake.json'));
  const issues = [];
  validateInstallOperation(issues, operation, 'install-repair-operation', options);
  validateDriverProbeReady(issues, probe, 'repair driver probe');
  requireJsonIdentity(issues, handshake, 'bridge-production-handshake');
  if (
    handshake?.passed !== true
    || handshake?.protocolVersion !== VMIC_PROTOCOL_V7
    || Number(handshake?.bridgeProcessId) <= 0
    || handshake?.rootInstanceId !== probe?.rootInstanceIds?.[0]
    || handshake?.captureEndpointName !== probe?.captureEndpointName
  ) issues.push('repair must finish with a matching production Bridge v6 handshake');
  if (operation?.rootDeviceCountBefore !== 1 || operation?.rootDeviceCountAfter !== 1) {
    issues.push('repair must preserve exactly one ROOT device');
  }
  return {
    issues,
    evidenceTimes: [operation?.completedAt, handshake?.connectedAt],
    summary: {
      packageVersion: operation?.packageVersion ?? null,
      rootInstanceId: probe?.rootInstanceIds?.[0] ?? null,
      bridgeProcessId: Number(handshake?.bridgeProcessId ?? 0),
      captureEndpointName: handshake?.captureEndpointName ?? null,
    },
  };
};

const validateUninstall = (root, options) => {
  const operation = readJson(path.join(root, 'uninstall-evidence.json'));
  const probe = readJson(path.join(root, 'driver-probe.json'));
  const absence = readJson(path.join(root, 'pnp-absence.json'));
  const issues = [];
  validateInstallOperation(issues, operation, 'install-uninstall-operation', options);
  if (
    probe?.schemaVersion !== 1
    || probe?.driverHealth !== 'not-installed'
    || probe?.rootDeviceCount !== 0
    || probe?.runtimeStatePresent !== false
    || probe?.endpointName != null
    || probe?.captureEndpointName != null
    || probe?.ioctlAvailable !== false
  ) issues.push('uninstall driver probe must prove the driver, endpoints, IOCTL, and runtime state are absent');
  requireJsonIdentity(issues, absence, 'pnp-driver-absence');
  if (
    absence?.rootDeviceCount !== 0
    || absence?.renderEndpointCount !== 0
    || absence?.captureEndpointCount !== 0
    || absence?.matchingDriverPackageCount !== 0
  ) issues.push('uninstall PnP absence must prove no matching device, endpoint, or package remains');
  return {
    issues,
    evidenceTimes: [operation?.completedAt, absence?.capturedAt],
    summary: {
      packageVersion: operation?.packageVersion ?? null,
      rootDeviceCount: Number(absence?.rootDeviceCount ?? -1),
      renderEndpointCount: Number(absence?.renderEndpointCount ?? -1),
      captureEndpointCount: Number(absence?.captureEndpointCount ?? -1),
      matchingDriverPackageCount: Number(absence?.matchingDriverPackageCount ?? -1),
    },
  };
};

const validateUpgrade = (root, options) => {
  const operation = readJson(path.join(root, 'upgrade-evidence.json'));
  const probe = readJson(path.join(root, 'driver-probe.json'));
  const handshake = readJson(path.join(root, 'bridge-handshake.json'));
  const issues = [];
  validateInstallOperation(issues, operation, 'install-upgrade-operation', options);
  validateDriverProbeReady(issues, probe, 'upgrade driver probe');
  requireString(issues, operation?.previousVersion, 'upgrade previousVersion');
  if (
    operation?.previousVersion === operation?.packageVersion
    || operation?.rootDeviceCountBefore !== 1
    || operation?.rootDeviceCountAfter !== 1
    || !Number.isInteger(Number(operation?.retainedBackupCount))
    || Number(operation.retainedBackupCount) < 0
    || Number(operation.retainedBackupCount) > 2
    || probe?.installedDriverVersion !== operation?.packageVersion
  ) issues.push('upgrade must change version, retain one ROOT device, and keep at most two backups');
  requireJsonIdentity(issues, handshake, 'bridge-production-handshake');
  if (
    handshake?.passed !== true
    || handshake?.protocolVersion !== VMIC_PROTOCOL_V7
    || Number(handshake?.bridgeProcessId) <= 0
    || handshake?.captureEndpointName !== probe?.captureEndpointName
  ) issues.push('upgrade must finish with a matching production Bridge v6 handshake');
  return {
    issues,
    evidenceTimes: [operation?.completedAt, handshake?.connectedAt],
    summary: {
      previousVersion: operation?.previousVersion ?? null,
      packageVersion: operation?.packageVersion ?? null,
      retainedBackupCount: Number(operation?.retainedBackupCount ?? -1),
      bridgeProcessId: Number(handshake?.bridgeProcessId ?? 0),
    },
  };
};

const validateLayout = (root, options) => {
  const layoutRoot = path.join(root, 'installer-layout');
  const layout = readJson(path.join(layoutRoot, 'installer-layout.json'));
  const release = readJson(path.join(root, 'release-manifest.json'));
  const issues = [];
  const timeIssue = timestampIssue(layout?.generatedAt, 'installer layout generatedAt', options);
  if (timeIssue) issues.push(timeIssue);
  const releaseTimeIssue = timestampIssue(release?.generatedAt, 'release manifest generatedAt', options);
  if (releaseTimeIssue) issues.push(releaseTimeIssue);
  if (
    layout?.naming?.channel !== 'stable'
    || layout?.naming?.platform !== 'windows-x64'
    || !layout?.version
    || release?.releaseChannel !== 'stable'
    || release?.version !== layout?.version
    || release?.packages?.root?.version !== layout?.version
  ) issues.push('installer layout and release manifest must identify the same stable Windows x64 version');
  const required = [
    'installer-layout.json',
    'bridge-service-native/omni-bridge-service.exe',
    'bridge-service-native/omni-driver-audio-probe.exe',
    'bridge-service-native/omni-virtual-mic-target-capture.exe',
    'desktop/omni-desktop-shell.exe',
    'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf',
    'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
    'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat',
    'drivers/windows-virtual-mic/package/driver-package.json',
  ];
  for (const relative of required) {
    const candidate = path.join(layoutRoot, relative);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile() || fs.statSync(candidate).size === 0) {
      issues.push(`installer layout is missing non-empty ${relative}`);
    }
  }
  const driverPackage = readJson(path.join(layoutRoot, 'drivers/windows-virtual-mic/package/driver-package.json'));
  if (driverPackage?.signingMode !== 'release-injected' || driverPackage?.configuration !== 'Release') {
    issues.push('installer driver package must be Release with release-injected signing');
  }
  if (
    release?.installer?.nativeBridgeExecutable !== 'bridge-service-native/omni-bridge-service.exe'
    || release?.installer?.audioProbeExecutable !== 'bridge-service-native/omni-driver-audio-probe.exe'
    || release?.installer?.virtualMicTargetCaptureExecutable !== 'bridge-service-native/omni-virtual-mic-target-capture.exe'
  ) issues.push('release manifest executable paths do not match the required installer layout');
  const inventory = walkFiles(layoutRoot).map((entry) => ({
    path: entry.relativePath,
    sha256: sha256File(entry.fullPath),
    bytes: fs.statSync(entry.fullPath).size,
  }));
  return {
    issues,
    evidenceTimes: [layout?.generatedAt, release?.generatedAt],
    summary: {
      version: layout?.version ?? null,
      platform: layout?.naming?.platform ?? null,
      fileCount: inventory.length,
      layoutSha256: hashCollectorArtifact(layoutRoot).sha256,
      inventory,
    },
  };
};

const validateInstallReleaseAuthority = (root, options, expectedScenarioId) => {
  const checked = validateInstallReleaseRunDirectory({
    runDirectory: root,
    workspaceRoot: options.workspaceRoot,
    currentProvenance: options.currentProvenance,
    now: new Date(options.now),
  });
  const issues = [...checked.issues];
  if (checked.scenarioId !== expectedScenarioId) {
    issues.push(`install release authority scenarioId must be ${expectedScenarioId}`);
  }
  const operation = checked.authority?.operation;
  const evidenceTimes = [
    checked.authority?.generatedAt,
    checked.signatureInventory?.capturedAt,
    checked.previousSignatureInventory?.capturedAt,
    checked.beforeState?.capturedAt,
    checked.operationResult?.startedAt,
    checked.operationResult?.finishedAt,
    checked.afterState?.capturedAt,
    checked.healthProbe?.capturedAt,
  ].filter(Boolean);
  return {
    issues,
    evidenceTimes,
    summary: {
      authoritySchemaVersion: checked.authority?.schemaVersion ?? null,
      authorityArtifactKind: checked.authority?.artifactKind ?? null,
      authorityCollectorId: checked.authority?.collectorId ?? null,
      authorityCollectorVersion: checked.authority?.collectorVersion ?? null,
      scenarioId: checked.scenarioId ?? null,
      sourceCommit: checked.authority?.provenance?.headCommit ?? null,
      packageVersion: checked.packageAuthority?.version ?? null,
      driverVersion: checked.packageAuthority?.driverVersion ?? null,
      bridgeVersion: checked.packageAuthority?.bridgeVersion ?? null,
      protocolVersion: checked.packageAuthority?.protocolVersion ?? null,
      packageInventorySha256: checked.packageAuthority?.inventorySha256 ?? null,
      packageZipSha256: checked.packageAuthority?.packageZip?.sha256 ?? null,
      previousPackageVersion: checked.previousPackageAuthority?.version ?? null,
      previousSourceCommit: checked.previousPackageAuthority?.sourceCommit ?? null,
      operation: operation ? {
        action: operation.action,
        operationId: operation.operationId,
        elevatedProductionRequest: operation.elevatedProductionRequest,
        installChannel: operation.installChannel,
        resultSha256: operation.resultSha256,
        operationLogSha256: operation.operationLogSha256,
        beforeStateSha256: operation.beforeStateSha256,
        afterStateSha256: operation.afterStateSha256,
        healthProbeSha256: operation.healthProbeSha256,
      } : null,
    },
  };
};

const RAW_VALIDATORS = Object.freeze({
  'E2E-PROVIDER-CONFIG': validateProviderConfig,
  'E2E-PROVIDER-PROBE': (root, options) => {
    const probe = readJson(path.join(root, 'provider-probe-result.json'));
    const observedAuthorization = probe?.preflightAuthorization;
    const selfBoundExpectedAuthorization = observedAuthorization
      && typeof observedAuthorization === 'object'
      && !Array.isArray(observedAuthorization)
      ? Object.fromEntries(Object.entries(observedAuthorization).filter(([key]) => (
          key !== 'authorizationObservedAt'
        )))
      : null;
    const shared = validateProviderPreflightRawAuthority(root, {
      ...options,
      expectedAuthorization: options?.expectedAuthorization ?? selfBoundExpectedAuthorization,
    });
    const detailed = validateProviderProbe(root, options);
    return {
      ...detailed,
      issues: [...new Set([...shared.issues, ...detailed.issues])],
      summary: shared.summary ?? detailed.summary,
    };
  },
  'E2E-REAL-DEVICE-AUDIO': validateRealDeviceAudioEvidence,
  'E2E-OVERLAY-CLICK-THROUGH': validateOverlay,
  'E2E-DIAGNOSTICS-EXPORT': validateDiagnosticsBundle,
  'E2E-VIRTUAL-MIC-CAPTURE': validateVirtualMic,
  'INSTALL-FRESH': (root, options) => validateInstallReleaseAuthority(root, options, 'INSTALL-FRESH'),
  'INSTALL-REPAIR': (root, options) => validateInstallReleaseAuthority(root, options, 'INSTALL-REPAIR'),
  'INSTALL-UNINSTALL': (root, options) => validateInstallReleaseAuthority(root, options, 'INSTALL-UNINSTALL'),
  'INSTALL-UPGRADE': (root, options) => validateInstallReleaseAuthority(root, options, 'INSTALL-UPGRADE'),
  'INSTALL-RELEASE-LAYOUT': (root, options) => (
    validateInstallReleaseAuthority(root, options, 'INSTALL-RELEASE-LAYOUT')
  ),
});

const expectedRootEntries = (profileValue) => profileValue.artifacts
  .map((artifact) => artifact.path.split('/')[0])
  .filter((value, index, values) => values.indexOf(value) === index)
  .sort();

const exactSourceEntries = (sourceRoot, profileValue) => {
  const actual = fs.readdirSync(sourceRoot).sort();
  const expected = expectedRootEntries(profileValue);
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? null
    : `source artifact set must be exactly: ${expected.join(', ')}; received: ${actual.join(', ') || '(empty)'}`;
};

export function validateRawReleaseManualEvidence(
  sourceRoot,
  scenarioId,
  {
    now = Date.now(),
    maxAgeDays = RELEASE_MANUAL_COLLECTOR_MAX_AGE_DAYS,
    workspaceRoot = repoRoot,
    implementationRoot = repoRoot,
    currentProvenance = currentGitProvenance({ cwd: workspaceRoot }),
    testOnlyRealDeviceAuthorityResolver,
    expectedAuthorization,
  } = {},
) {
  const profileValue = RELEASE_MANUAL_COLLECTOR_PROFILES[scenarioId];
  if (!profileValue) return { issues: [`no official collector profile exists for ${scenarioId}`], summary: null };
  const root = path.resolve(sourceRoot);
  const issues = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { issues: ['release manual collector source must be a directory'], summary: null };
  }
  const entryIssue = exactSourceEntries(root, profileValue);
  if (entryIssue) issues.push(entryIssue);
  for (const artifact of profileValue.artifacts) {
    const candidate = path.join(root, artifact.path);
    if (!fs.existsSync(candidate)) {
      issues.push(`required ${artifact.role} artifact is missing: ${artifact.path}`);
      continue;
    }
    const actualKind = fs.statSync(candidate).isDirectory() ? 'directory' : 'file';
    if (actualKind !== artifact.kind) issues.push(`${artifact.path} must be a ${artifact.kind}`);
  }
  if (issues.length > 0) return { issues, summary: null };
  try {
    const result = RAW_VALIDATORS[scenarioId](root, {
      now,
      maxAgeDays,
      workspaceRoot,
      implementationRoot,
      currentProvenance,
      expectedAuthorization,
      ...(scenarioId === 'E2E-REAL-DEVICE-AUDIO' && testOnlyRealDeviceAuthorityResolver
        ? { authorityResolver: testOnlyRealDeviceAuthorityResolver }
        : {}),
    });
    return { ...result, issues: [...new Set([...issues, ...result.issues])] };
  } catch (error) {
    return { issues: [error.message], summary: null, evidenceTimes: [] };
  }
}

const collectorScriptHash = (implementationRoot = repoRoot) => {
  const scriptPath = path.resolve(implementationRoot, RELEASE_MANUAL_COLLECTOR_SCRIPT);
  if (!fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
    throw new Error(`official collector script is missing: ${scriptPath}`);
  }
  return sha256File(scriptPath);
};

const productionAuthority = (emitter, implementationRoot = repoRoot) => ({
  kind: 'production-emitter',
  ...emitter,
  ...(emitter?.runner ? {
    runnerSha256: sha256File(path.resolve(implementationRoot, emitter.runner)),
  } : {}),
});

const cleanProvenanceIssue = (provenance) => {
  const shapeIssue = gitProvenanceShapeFailure(provenance, 'collector provenance');
  if (shapeIssue) return shapeIssue;
  if (provenance.worktreeClean !== true || provenance.dirtyEntryCount !== 0) {
    return 'collector provenance requires an exact clean HEAD';
  }
  return null;
};

const currentWindowsNodeProcessAuthority = () => {
  if (process.platform !== 'win32') {
    throw new Error('production release evidence runner authority requires Windows');
  }
  const command = [
    "$ErrorActionPreference='Stop'",
    `$processRecord=Get-CimInstance Win32_Process -Filter \"ProcessId = ${process.pid}\"`,
    "if ($null -eq $processRecord) { throw 'current process is unavailable' }",
    '[pscustomobject]@{ processId=[int]$processRecord.ProcessId; executablePath=[string]$processRecord.ExecutablePath; commandLine=[string]$processRecord.CommandLine } | ConvertTo-Json -Compress',
  ].join('; ');
  const observed = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (Number(observed?.status) !== 0 || observed?.error) {
    throw new Error(`Win32_Process authority query failed: ${observed?.error?.message ?? observed?.stderr ?? ''}`);
  }
  return JSON.parse(String(observed.stdout ?? '').replace(/^\uFEFF/, ''));
};

const parseWindowsCommandLine = (commandLine) => {
  const source = String(commandLine ?? '');
  const argv = [];
  let offset = 0;
  while (offset < source.length) {
    while (/\s/.test(source[offset] ?? '')) offset += 1;
    if (offset >= source.length) break;
    let argument = '';
    let quoted = false;
    while (offset < source.length) {
      if (!quoted && /\s/.test(source[offset])) break;
      let backslashes = 0;
      while (source[offset] === '\\') {
        backslashes += 1;
        offset += 1;
      }
      if (source[offset] === '"') {
        argument += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 0) quoted = !quoted;
        else argument += '"';
        offset += 1;
        continue;
      }
      argument += '\\'.repeat(backslashes);
      if (offset < source.length) {
        argument += source[offset];
        offset += 1;
      }
    }
    if (quoted) throw new Error('Win32_Process CommandLine contains an unterminated quote');
    argv.push(argument);
    while (/\s/.test(source[offset] ?? '')) offset += 1;
  }
  return argv;
};

const currentNodeInvocationAuthority = () => ({
  argv: [...process.argv],
  argv0: process.argv0,
  execArgv: [...process.execArgv],
  execPath: process.execPath,
  nodeOptions: process.env.NODE_OPTIONS ?? '',
});

const validateReleaseRunnerProcessAuthority = ({
  runner,
  workspaceRoot = repoRoot,
  resolver = currentWindowsNodeProcessAuthority,
  invocation = currentNodeInvocationAuthority(),
}) => {
  const expectedRunner = path.resolve(workspaceRoot, ...runner.split('/'));
  if (!Array.isArray(invocation?.execArgv) || invocation.execArgv.length !== 0) {
    throw new Error(`${runner} production authority forbids Node execArgv, eval, print, preload, and input-type modes`);
  }
  if (String(invocation?.nodeOptions ?? '').trim()) {
    throw new Error(`${runner} production authority forbids NODE_OPTIONS`);
  }
  if (
    comparableResolvedPath(invocation?.execPath) !== comparableResolvedPath(process.execPath)
    || comparableResolvedPath(invocation?.argv0) !== comparableResolvedPath(process.execPath)
  ) throw new Error('production authority Node executable identity is inconsistent');
  const invokedRunner = path.resolve(String(invocation?.argv?.[1] ?? ''));
  if (comparableResolvedPath(invokedRunner) !== comparableResolvedPath(expectedRunner)) {
    throw new Error(`${runner} may package production raw evidence only from its canonical Node entrypoint`);
  }
  if (!fs.existsSync(expectedRunner) || !fs.statSync(expectedRunner).isFile()) {
    throw new Error(`canonical production authority runner is missing: ${expectedRunner}`);
  }
  const observed = resolver();
  if (
    Number(observed?.processId) !== process.pid
    || comparableResolvedPath(observed?.executablePath) !== comparableResolvedPath(process.execPath)
  ) throw new Error('Win32_Process does not bind the current PID to the running Node executable');
  const commandArgv = parseWindowsCommandLine(observed?.commandLine);
  if (
    commandArgv.length < 2
    || comparableResolvedPath(commandArgv[0]) !== comparableResolvedPath(process.execPath)
    || comparableResolvedPath(path.resolve(workspaceRoot, commandArgv[1]))
      !== comparableResolvedPath(expectedRunner)
  ) {
    throw new Error('Win32_Process CommandLine must launch node.exe with the canonical runner as its direct entrypoint');
  }
  return {
    runner: asForwardSlash(path.relative(workspaceRoot, expectedRunner)),
    runnerSha256: sha256File(expectedRunner),
    processId: process.pid,
    executablePath: path.resolve(process.execPath),
    commandLine: observed.commandLine,
    directEntrypoint: true,
    execArgv: [],
    nodeOptionsPresent: false,
  };
};

export function testOnlyValidateReleaseRunnerProcessAuthority(options = {}) {
  if (
    typeof options.testOnlyProcessAuthorityResolver !== 'function'
    && options.testOnlyUseProductionProcessAuthority !== true
  ) {
    throw new Error('testOnlyProcessAuthorityResolver or testOnlyUseProductionProcessAuthority=true is required');
  }
  return validateReleaseRunnerProcessAuthority({
    runner: options.runner,
    workspaceRoot: options.workspaceRoot,
    resolver: options.testOnlyProcessAuthorityResolver ?? currentWindowsNodeProcessAuthority,
    ...(options.testOnlyInvocationAuthority
      ? { invocation: options.testOnlyInvocationAuthority }
      : {}),
  });
}

const defaultExecutableCommitResolver = (candidate) => spawnSync(candidate, ['--build-commit'], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30_000,
});

const verifyExecutableCommit = (issues, {
  candidate,
  expectedPath,
  expectedSha256,
  expectedCommit,
  subject,
  resolver = defaultExecutableCommitResolver,
}) => {
  if (comparableResolvedPath(candidate) !== comparableResolvedPath(expectedPath)) {
    issues.push(`${subject} must use the current canonical release path`);
    return;
  }
  if (!fs.existsSync(expectedPath) || !fs.statSync(expectedPath).isFile()) {
    issues.push(`${subject} canonical executable is missing`);
    return;
  }
  if (sha256File(expectedPath) !== expectedSha256) {
    issues.push(`${subject} SHA-256 does not match the current canonical executable`);
  }
  let observed;
  try {
    observed = resolver(expectedPath);
  } catch (error) {
    issues.push(`${subject} --build-commit execution failed: ${error.message}`);
    return;
  }
  if (
    Number(observed?.status) !== 0
    || observed?.error
    || String(observed?.stdout ?? '').trim().toLowerCase() !== String(expectedCommit ?? '').toLowerCase()
  ) issues.push(`${subject} --build-commit does not match the current exact clean HEAD`);
};

const validateCanonicalExecutableAuthority = (
  artifactRoot,
  scenarioId,
  { workspaceRoot, currentProvenance, resolver = defaultExecutableCommitResolver },
) => {
  const issues = [];
  const releaseRoot = path.join(path.resolve(workspaceRoot), 'target', 'release');
  if (DESKTOP_RELEASE_EMITTER_SCENARIOS[scenarioId]) {
    const result = readJson(path.join(artifactRoot, 'emitter-result.json'));
    verifyExecutableCommit(issues, {
      candidate: result?.desktopExecutable,
      expectedPath: path.join(releaseRoot, 'omni-desktop-shell.exe'),
      expectedSha256: result?.desktopExecutableSha256,
      expectedCommit: currentProvenance?.headCommit,
      subject: 'Desktop release evidence executable',
      resolver,
    });
  } else if (scenarioId === 'E2E-VIRTUAL-MIC-CAPTURE') {
    const result = readJson(path.join(artifactRoot, 'emitter-result.json'));
    for (const [role, executable] of [
      ['collector', 'omni-virtual-mic-target-capture.exe'],
      ['bridge', 'omni-bridge-service.exe'],
    ]) {
      verifyExecutableCommit(issues, {
        candidate: result?.binaries?.[role]?.path,
        expectedPath: path.join(releaseRoot, executable),
        expectedSha256: result?.binaries?.[role]?.sha256,
        expectedCommit: currentProvenance?.headCommit,
        subject: `virtual microphone ${role} executable`,
        resolver,
      });
    }
  }
  return issues;
};

export function testOnlyValidateCanonicalExecutableAuthority(
  artifactRoot,
  scenarioId,
  options,
) {
  if (typeof options?.testOnlyExecutableCommitResolver !== 'function') {
    throw new Error('testOnlyExecutableCommitResolver is required');
  }
  return validateCanonicalExecutableAuthority(artifactRoot, scenarioId, {
    ...options,
    resolver: options.testOnlyExecutableCommitResolver,
  });
}

const normalizedEvidenceWindow = (times) => {
  const parsed = (times ?? []).map(parseEvidenceTimestamp).filter(Number.isFinite);
  return {
    startedAt: new Date(Math.min(...parsed)).toISOString(),
    completedAt: new Date(Math.max(...parsed)).toISOString(),
  };
};

const manifestArtifacts = (artifactRoot, profileValue) => profileValue.artifacts.map((artifact) => {
  const candidate = path.join(artifactRoot, artifact.path);
  return {
    role: artifact.role,
    path: `artifacts/${artifact.path}`,
    ...hashCollectorArtifact(candidate),
  };
});

function collectRawReleaseManualEvidence({
  source,
  scenarioId,
  outputRoot = 'artifacts/testing/release-manual-collector',
  workspaceRoot = repoRoot,
  implementationRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  now = new Date(),
  suffix = crypto.randomUUID().slice(0, 8),
  testOnlyAllowSyntheticAuthority = false,
  desktopEmitterAuthority = null,
  realDeviceAudioEmitterAuthority = null,
  installReleaseEmitterAuthority = null,
  overlayEmitterAuthority = null,
  virtualMicEmitterAuthority = null,
  runnerProcessAuthority = null,
  testOnlyRealDeviceAuthorityResolver,
} = {}) {
  const profileValue = RELEASE_MANUAL_COLLECTOR_PROFILES[scenarioId];
  if (!profileValue) throw new Error(`no official collector profile exists for ${scenarioId}`);
  const productionEmitter = RELEASE_MANUAL_PRODUCTION_EMITTERS[scenarioId];
  if (!productionEmitter && !testOnlyAllowSyntheticAuthority) {
    throw new Error(
      `${scenarioId} has no registered production authority emitter; release evidence must remain pending`,
    );
  }
  if (testOnlyRealDeviceAuthorityResolver && !testOnlyAllowSyntheticAuthority) {
    throw new Error('real-device authorityResolver injection is test-only');
  }
  const runnerAuthorityAccepted = scenarioId === 'E2E-REAL-DEVICE-AUDIO'
    ? realDeviceAudioEmitterAuthority === REAL_DEVICE_AUDIO_EMITTER_AUTHORITY
    : scenarioId === 'E2E-OVERLAY-CLICK-THROUGH'
      ? overlayEmitterAuthority === OVERLAY_EMITTER_AUTHORITY
      : scenarioId === 'E2E-VIRTUAL-MIC-CAPTURE'
        ? virtualMicEmitterAuthority === VIRTUAL_MIC_EMITTER_AUTHORITY
        : INSTALL_RELEASE_SCENARIOS.includes(scenarioId)
          ? installReleaseEmitterAuthority === INSTALL_RELEASE_EMITTER_AUTHORITY
          : desktopEmitterAuthority === DESKTOP_EMITTER_AUTHORITY;
  if (productionEmitter?.runner && !testOnlyAllowSyntheticAuthority && !runnerAuthorityAccepted) {
    throw new Error(
      `${scenarioId} must be produced by ${productionEmitter.runner}; generic --source assembly is forbidden`,
    );
  }
  const provenanceIssue = cleanProvenanceIssue(provenance);
  if (provenanceIssue) throw new Error(provenanceIssue);
  const sourceRoot = path.resolve(workspaceRoot, String(source ?? ''));
  if (
    DESKTOP_RELEASE_EMITTER_SCENARIOS[scenarioId]
    || scenarioId === 'E2E-REAL-DEVICE-AUDIO'
    || scenarioId === 'E2E-OVERLAY-CLICK-THROUGH'
    || scenarioId === 'E2E-VIRTUAL-MIC-CAPTURE'
  ) {
    const emitterResult = readJson(path.join(sourceRoot, 'emitter-result.json'));
    if (
      String(emitterResult?.sourceHeadCommit ?? '').toLowerCase()
      !== String(provenance?.headCommit ?? '').toLowerCase()
    ) {
      throw new Error('production emitter sourceHeadCommit does not match collector exact clean HEAD provenance');
    }
  }
  const raw = validateRawReleaseManualEvidence(sourceRoot, scenarioId, {
    now: now.getTime(),
    workspaceRoot,
    implementationRoot,
    currentProvenance: provenance,
    testOnlyRealDeviceAuthorityResolver,
  });
  if (raw.issues.length > 0 || !raw.summary) {
    throw new Error(`official ${scenarioId} collector rejected the raw evidence:\n- ${raw.issues.join('\n- ')}`);
  }
  const targetRoot = path.resolve(workspaceRoot, outputRoot);
  if (targetRoot === sourceRoot || targetRoot.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error('collector output root may not be inside the raw source directory');
  }
  const runDirectory = path.join(
    targetRoot,
    provenance.headCommit.slice(0, 12),
    `${compactTimestamp(now)}-${scenarioId.toLowerCase()}-${suffix}`,
  );
  const artifactRoot = path.join(runDirectory, 'artifacts');
  ensureDir(artifactRoot);
  for (const artifact of profileValue.artifacts) {
    const from = path.join(sourceRoot, artifact.path);
    const to = path.join(artifactRoot, artifact.path);
    ensureDir(path.dirname(to));
    if (artifact.kind === 'directory') fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
    else fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  }
  const window = normalizedEvidenceWindow(raw.evidenceTimes);
  const manifest = {
    schemaVersion: RELEASE_MANUAL_COLLECTOR_SCHEMA_VERSION,
    artifactKind: 'release-manual-official-collector-manifest',
    scenarioId,
    evidenceArtifactKind: profileValue.evidenceArtifactKind,
    collectionId: crypto.randomUUID(),
    generatedAt: now.toISOString(),
    evidenceWindow: window,
    provenance,
    authority: testOnlyAllowSyntheticAuthority ? {
      kind: 'test-fixture',
      emitterId: 'scripts/testing/run-quality-gate.test.mjs',
      emitterVersion: 1,
    } : productionAuthority(productionEmitter, implementationRoot),
    collector: {
      collectorId: profileValue.collectorId,
      collectorVersion: profileValue.collectorVersion,
      script: RELEASE_MANUAL_COLLECTOR_SCRIPT,
      scriptSha256: collectorScriptHash(implementationRoot),
      processId: process.pid,
      parentProcessId: process.ppid,
      executableName: path.basename(process.execPath),
      platform: process.platform,
      architecture: process.arch,
      hostName: os.hostname(),
    },
    ...(runnerProcessAuthority ? {
      runnerProcessAuthority: {
        kind: 'win32-process-cim',
        runner: runnerProcessAuthority.runner,
        runnerSha256: runnerProcessAuthority.runnerSha256,
        processId: runnerProcessAuthority.processId,
        executablePath: runnerProcessAuthority.executablePath,
        executableSha256: sha256File(runnerProcessAuthority.executablePath),
        commandLineSha256: sha256Bytes(Buffer.from(String(runnerProcessAuthority.commandLine), 'utf8')),
        directEntrypoint: runnerProcessAuthority.directEntrypoint,
        execArgv: runnerProcessAuthority.execArgv,
        nodeOptionsPresent: runnerProcessAuthority.nodeOptionsPresent,
      },
    } : {}),
    artifacts: manifestArtifacts(artifactRoot, profileValue),
    summary: raw.summary,
  };
  const manifestPath = writeJson(path.join(runDirectory, 'collector-manifest.json'), manifest);
  const checked = validateReleaseManualCollectorPackage(runDirectory, scenarioId, {
    workspaceRoot,
    implementationRoot,
    currentProvenance: provenance,
    now: now.getTime(),
    testOnlyAllowSyntheticAuthority,
    testOnlyRealDeviceAuthorityResolver,
  });
  if (checked.issues.length > 0) {
    fs.rmSync(runDirectory, { recursive: true, force: true });
    throw new Error(`official collector package self-validation failed:\n- ${checked.issues.join('\n- ')}`);
  }
  return { packageDirectory: runDirectory, manifestPath, manifest };
}

const rejectProductionCollectorOverrides = (options, allowed, subject) => {
  const unexpected = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${subject} does not accept caller authority/raw overrides: ${unexpected.join(', ')}`);
  }
};

export function testOnlyCollectReleaseManualEvidence(options = {}) {
  if (options.testOnlyAllowSyntheticAuthority !== true) {
    throw new Error('raw release evidence assembly is test-only and requires testOnlyAllowSyntheticAuthority=true');
  }
  return collectRawReleaseManualEvidence(options);
}

export async function collectDesktopReleaseManualEvidence(options = {}) {
  rejectProductionCollectorOverrides(options, [
    'scenarioId', 'outputRoot', 'collectorOutputRoot', 'providerId', 'timeoutMs',
  ], 'Desktop production release collector');
  if (!DESKTOP_RELEASE_EMITTER_SCENARIOS[options.scenarioId]) {
    throw new Error('Desktop production release collector requires a provider-config, provider-probe, or diagnostics scenario');
  }
  const {
    buildCurrentDesktopRelease,
    buildDesktopReleaseEvidencePlan,
    runDesktopReleaseEvidence,
  } = await import('./run-desktop-release-evidence.mjs');
  const provenance = currentGitProvenance({ cwd: repoRoot });
  buildCurrentDesktopRelease({ workspaceRoot: repoRoot, provenance, timeoutMs: 600_000 });
  const plan = buildDesktopReleaseEvidencePlan({ ...options, workspaceRoot: repoRoot, provenance });
  return runDesktopReleaseEvidence({
    plan,
    collectEvidence: (rawOptions) => collectRawReleaseManualEvidence({
      ...rawOptions,
      desktopEmitterAuthority: DESKTOP_EMITTER_AUTHORITY,
    }),
  });
}

export async function collectRealDeviceAudioReleaseManualEvidence(options = {}) {
  rejectProductionCollectorOverrides(options, [
    'scenarioId', 'outputRoot', 'collectorOutputRoot', 'maxAgeDays',
  ], 'real-device production release collector');
  if (options.scenarioId !== 'E2E-REAL-DEVICE-AUDIO') {
    throw new Error('real-device production release collector requires E2E-REAL-DEVICE-AUDIO');
  }
  const runnerProcessAuthority = validateReleaseRunnerProcessAuthority({
    runner: REAL_DEVICE_AUDIO_RUNNER_PATH,
    workspaceRoot: repoRoot,
  });
  const {
    buildRealDeviceAudioReleasePlan,
    runRealDeviceAudioReleaseEvidence,
  } = await import('./run-real-device-audio-release-evidence.mjs');
  const { scenarioId: _scenarioId, ...runnerOptions } = options;
  const plan = buildRealDeviceAudioReleasePlan({
    ...runnerOptions,
    workspaceRoot: repoRoot,
  });
  return runRealDeviceAudioReleaseEvidence({
    plan,
    collectEvidence: (rawOptions) => collectRawReleaseManualEvidence({
      ...rawOptions,
      realDeviceAudioEmitterAuthority: REAL_DEVICE_AUDIO_EMITTER_AUTHORITY,
      runnerProcessAuthority,
    }),
  });
}

export async function collectOverlayReleaseManualEvidence(options = {}) {
  rejectProductionCollectorOverrides(options, [
    'scenarioId', 'outputRoot', 'collectorOutputRoot', 'operator', 'operatorNotes',
    'driverHost', 'driverPort', 'nativeDriverPort', 'timeoutMs',
  ], 'overlay production release collector');
  if (options.scenarioId !== 'E2E-OVERLAY-CLICK-THROUGH') {
    throw new Error('overlay release collector requires E2E-OVERLAY-CLICK-THROUGH');
  }
  const {
    buildOverlayClickThroughReleasePlan,
    buildOverlayReleaseBinaries,
    runOverlayClickThroughReleaseEvidenceFromProductionCollector,
    runningDesktopProcesses,
  } = await import('./run-overlay-click-through-release-evidence.mjs');
  const before = currentGitProvenance({ cwd: repoRoot });
  const provenanceIssue = cleanProvenanceIssue(before);
  if (provenanceIssue) throw new Error(provenanceIssue);
  if (runningDesktopProcesses().length > 0) {
    throw new Error('close every existing omni-desktop-shell.exe before building overlay evidence');
  }
  const built = buildOverlayReleaseBinaries({ workspaceRoot: repoRoot, provenance: before });
  const plan = buildOverlayClickThroughReleasePlan({
    ...options,
    workspaceRoot: repoRoot,
    provenance: built.provenance,
    preparedTooling: built.preparedTooling,
  });
  return runOverlayClickThroughReleaseEvidenceFromProductionCollector({
    plan,
    collectEvidence: (rawOptions) => collectRawReleaseManualEvidence({
      ...rawOptions,
      overlayEmitterAuthority: OVERLAY_EMITTER_AUTHORITY,
    }),
  });
}

export async function collectVirtualMicReleaseManualEvidence(options = {}) {
  rejectProductionCollectorOverrides(options, [
    'scenarioId', 'outputRoot', 'collectorOutputRoot', 'timeoutMs',
  ], 'virtual microphone production release collector');
  if (options.scenarioId !== 'E2E-VIRTUAL-MIC-CAPTURE') {
    throw new Error('virtual microphone release collector requires E2E-VIRTUAL-MIC-CAPTURE');
  }
  const { buildVirtualMicReleasePlan, runVirtualMicReleaseEvidence } = await import(
    './run-virtual-mic-release-evidence.mjs'
  );
  const plan = buildVirtualMicReleasePlan({ ...options, workspaceRoot: repoRoot });
  return runVirtualMicReleaseEvidence({
    plan,
    collect: (rawOptions) => collectRawReleaseManualEvidence({
      ...rawOptions,
      virtualMicEmitterAuthority: VIRTUAL_MIC_EMITTER_AUTHORITY,
    }),
  });
}

export async function collectInstallReleaseManualEvidence(options = {}) {
  rejectProductionCollectorOverrides(options, [
    'scenarioId', 'previousVersion', 'outputRoot', 'collectorOutputRoot', 'timeoutMs',
  ], 'install production release collector');
  if (!INSTALL_RELEASE_SCENARIOS.includes(options.scenarioId)) {
    throw new Error(`install release collector requires one of: ${INSTALL_RELEASE_SCENARIOS.join(', ')}`);
  }
  const runnerProcessAuthority = validateReleaseRunnerProcessAuthority({
    runner: INSTALL_RELEASE_RUNNER_PATH,
    workspaceRoot: repoRoot,
  });
  const {
    buildInstallReleaseEvidencePlan,
    isInstallReleaseAdministrator,
    runInstallReleaseEvidenceAndCollect,
  } = await import('./run-install-release-evidence.mjs');
  if (
    options.scenarioId !== 'INSTALL-RELEASE-LAYOUT'
    && !isInstallReleaseAdministrator()
  ) {
    throw new Error(
      'mutating install release evidence must be launched through '
      + 'scripts/testing/request-elevated-install-release-evidence.ps1',
    );
  }
  const plan = buildInstallReleaseEvidencePlan({
    ...options,
    workspaceRoot: repoRoot,
  });
  return runInstallReleaseEvidenceAndCollect({
    plan,
    collectEvidence: (rawOptions) => collectRawReleaseManualEvidence({
      ...rawOptions,
      installReleaseEmitterAuthority: INSTALL_RELEASE_EMITTER_AUTHORITY,
      runnerProcessAuthority,
    }),
  });
}

const exactPackageEntries = (root) => {
  const entries = fs.readdirSync(root).sort();
  return JSON.stringify(entries) === JSON.stringify(['artifacts', 'collector-manifest.json'])
    ? null
    : `collector package must contain exactly artifacts/ and collector-manifest.json; received: ${entries.join(', ')}`;
};

export function validateReleaseManualCollectorPackage(
  packageRoot,
  scenarioId,
  {
    workspaceRoot = repoRoot,
    implementationRoot = repoRoot,
    currentProvenance = currentGitProvenance({ cwd: workspaceRoot }),
    now = Date.now(),
    maxAgeDays = RELEASE_MANUAL_COLLECTOR_MAX_AGE_DAYS,
    testOnlyAllowSyntheticAuthority = false,
    testOnlyRealDeviceAuthorityResolver,
    testOnlyExecutableCommitResolver,
  } = {},
) {
  const root = path.resolve(packageRoot);
  const profileValue = RELEASE_MANUAL_COLLECTOR_PROFILES[scenarioId];
  const issues = [];
  if (!profileValue) return { issues: [`no official collector profile exists for ${scenarioId}`], manifest: null };
  const productionEmitter = RELEASE_MANUAL_PRODUCTION_EMITTERS[scenarioId];
  if (testOnlyRealDeviceAuthorityResolver && !testOnlyAllowSyntheticAuthority) {
    issues.push('real-device authorityResolver injection is test-only');
  }
  if (testOnlyExecutableCommitResolver && !testOnlyAllowSyntheticAuthority) {
    issues.push('executable build-commit resolver injection is test-only');
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { issues: ['official collector package must be a directory'], manifest: null };
  }
  const packageIssue = exactPackageEntries(root);
  if (packageIssue) issues.push(packageIssue);
  const manifestPath = path.join(root, 'collector-manifest.json');
  if (!fs.existsSync(manifestPath)) return { issues, manifest: null };
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    return { issues: [...issues, error.message], manifest: null };
  }
  if (manifest?.schemaVersion !== RELEASE_MANUAL_COLLECTOR_SCHEMA_VERSION) {
    issues.push(`collector manifest schemaVersion must be ${RELEASE_MANUAL_COLLECTOR_SCHEMA_VERSION}`);
  }
  if (manifest?.artifactKind !== 'release-manual-official-collector-manifest') {
    issues.push('collector manifest artifactKind is invalid');
  }
  if (manifest?.scenarioId !== scenarioId) issues.push(`collector manifest scenarioId must be ${scenarioId}`);
  if (manifest?.evidenceArtifactKind !== profileValue.evidenceArtifactKind) {
    issues.push(`collector manifest evidenceArtifactKind must be ${profileValue.evidenceArtifactKind}`);
  }
  const expectedAuthority = testOnlyAllowSyntheticAuthority ? {
    kind: 'test-fixture',
    emitterId: 'scripts/testing/run-quality-gate.test.mjs',
    emitterVersion: 1,
  } : productionEmitter ? productionAuthority(productionEmitter, implementationRoot) : null;
  if (!expectedAuthority) {
    issues.push(`${scenarioId} has no registered production authority emitter; release evidence must remain pending`);
  } else if (JSON.stringify(manifest?.authority) !== JSON.stringify(expectedAuthority)) {
    issues.push('collector package authority does not match the registered production emitter');
  }
  if (!testOnlyAllowSyntheticAuthority && (
    scenarioId === 'E2E-REAL-DEVICE-AUDIO' || INSTALL_RELEASE_SCENARIOS.includes(scenarioId)
  )) {
    const processAuthority = manifest?.runnerProcessAuthority;
    if (
      processAuthority?.kind !== 'win32-process-cim'
      || processAuthority?.runner !== productionEmitter?.runner
      || processAuthority?.runnerSha256 !== expectedAuthority?.runnerSha256
      || Number(processAuthority?.processId) !== Number(manifest?.collector?.processId)
      || comparableResolvedPath(processAuthority?.executablePath) !== comparableResolvedPath(process.execPath)
      || processAuthority?.executableSha256 !== sha256File(process.execPath)
      || !/^[a-f0-9]{64}$/i.test(String(processAuthority?.commandLineSha256 ?? ''))
      || processAuthority?.directEntrypoint !== true
      || !Array.isArray(processAuthority?.execArgv)
      || processAuthority.execArgv.length !== 0
      || processAuthority?.nodeOptionsPresent !== false
    ) issues.push('collector package does not bind the canonical runner to its real Win32 Node process authority');
  } else if (testOnlyAllowSyntheticAuthority && manifest?.runnerProcessAuthority) {
    issues.push('test fixture collector package must not claim production Win32 process authority');
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(manifest?.collectionId ?? ''))) issues.push('collector collectionId is invalid');
  const generatedIssue = timestampIssue(manifest?.generatedAt, 'collector generatedAt', { now, maxAgeDays });
  if (generatedIssue) issues.push(generatedIssue);
  for (const [value, subject] of [
    [manifest?.evidenceWindow?.startedAt, 'collector evidenceWindow.startedAt'],
    [manifest?.evidenceWindow?.completedAt, 'collector evidenceWindow.completedAt'],
  ]) {
    const issue = timestampIssue(value, subject, { now, maxAgeDays });
    if (issue) issues.push(issue);
  }
  const startedAt = parseEvidenceTimestamp(manifest?.evidenceWindow?.startedAt);
  const completedAt = parseEvidenceTimestamp(manifest?.evidenceWindow?.completedAt);
  const generatedAt = parseEvidenceTimestamp(manifest?.generatedAt);
  if (
    !Number.isFinite(startedAt)
    || !Number.isFinite(completedAt)
    || !Number.isFinite(generatedAt)
    || startedAt > completedAt
    || completedAt > generatedAt + 5 * 60 * 1000
  ) issues.push('collector evidence window is invalid or later than package generation');
  const provenanceIssue = exactGitProvenanceFailure(manifest?.provenance, currentProvenance, {
    recordedSubject: 'collector manifest provenance',
    currentSubject: 'current checkout provenance',
  });
  if (provenanceIssue) issues.push(provenanceIssue);
  if (
    manifest?.collector?.collectorId !== profileValue.collectorId
    || manifest?.collector?.collectorVersion !== profileValue.collectorVersion
  ) issues.push(`collector identity must be ${profileValue.collectorId} v${profileValue.collectorVersion}`);
  if (manifest?.collector?.script !== RELEASE_MANUAL_COLLECTOR_SCRIPT) issues.push('collector script path is invalid');
  try {
    if (manifest?.collector?.scriptSha256 !== collectorScriptHash(implementationRoot)) {
      issues.push('collector script SHA-256 does not match the current official collector');
    }
  } catch (error) {
    issues.push(error.message);
  }
  requirePositiveInteger(issues, manifest?.collector?.processId, 'collector processId');
  requirePositiveInteger(issues, manifest?.collector?.parentProcessId, 'collector parentProcessId');
  requireString(issues, manifest?.collector?.executableName, 'collector executableName');
  requireString(issues, manifest?.collector?.hostName, 'collector hostName');
  if (manifest?.collector?.platform !== 'win32' || manifest?.collector?.architecture !== 'x64') {
    issues.push('official release collector must run on Windows x64');
  }
  const expectedRecords = profileValue.artifacts.map((artifact) => {
    const candidate = path.join(root, 'artifacts', artifact.path);
    return {
      role: artifact.role,
      path: `artifacts/${artifact.path}`,
      ...(fs.existsSync(candidate) ? hashCollectorArtifact(candidate) : {}),
    };
  });
  if (JSON.stringify(manifest?.artifacts) !== JSON.stringify(expectedRecords)) {
    issues.push('collector manifest artifact roles, paths, hashes, or sizes do not match the fixed payload');
  }
  const artifactRoot = path.join(root, 'artifacts');
  if (fs.existsSync(artifactRoot) && fs.statSync(artifactRoot).isDirectory()) {
    const artifactEntryIssue = exactSourceEntries(artifactRoot, profileValue);
    if (artifactEntryIssue) issues.push(`collector artifacts: ${artifactEntryIssue}`);
    const raw = validateRawReleaseManualEvidence(artifactRoot, scenarioId, {
      now,
      maxAgeDays,
      workspaceRoot,
      implementationRoot,
      currentProvenance,
      ...(testOnlyAllowSyntheticAuthority ? { testOnlyRealDeviceAuthorityResolver } : {}),
    });
    for (const issue of raw.issues) issues.push(issue);
    if (!testOnlyAllowSyntheticAuthority) {
      issues.push(...validateCanonicalExecutableAuthority(artifactRoot, scenarioId, {
        workspaceRoot,
        currentProvenance,
      }));
    }
    if (raw.summary && JSON.stringify(manifest?.summary) !== JSON.stringify(raw.summary)) {
      issues.push('collector manifest summary does not match independently recomputed raw evidence');
    }
    if (raw.evidenceTimes?.length > 0) {
      const expectedWindow = normalizedEvidenceWindow(raw.evidenceTimes);
      if (JSON.stringify(manifest?.evidenceWindow) !== JSON.stringify(expectedWindow)) {
        issues.push('collector evidenceWindow does not match raw artifact timestamps');
      }
    }
  } else {
    issues.push('collector artifacts directory is missing');
  }
  return { issues: [...new Set(issues)], manifest };
}
