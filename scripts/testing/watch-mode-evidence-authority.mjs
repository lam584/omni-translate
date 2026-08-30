import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from '../lib/testing-common.mjs';

export const STRICT_MATRIX_SCHEMA_VERSION = 5;
export const STRICT_MATRIX_ARTIFACT_KIND = 'watch-mode-strict-matrix-authority';
export const CELL_AUTHORITY_SCHEMA_VERSION = 3;
export const CELL_AUTHORITY_ARTIFACT_KIND = 'watch-mode-live-cell-authority';
export const CELL_AUTHORITY_FILE = 'matrix-cell-authority.json';
export const MATRIX_RUNNER_ID = 'scripts/testing/run-watch-mode-live-production-coordinator.mjs';
export const LEGACY_MATRIX_RUNNER_ID = 'scripts/testing/run-watch-mode-live-matrix.mjs';
export const LIVE_RUN_COLLECTOR_ID = 'scripts/testing/run-watch-mode-live.ps1';

export const AUTHORITY_IMPLEMENTATION_FILES = Object.freeze([
  MATRIX_RUNNER_ID,
  LEGACY_MATRIX_RUNNER_ID,
  LIVE_RUN_COLLECTOR_ID,
  'scripts/testing/lib/powershell/Omni.Testing.IO.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.Process.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.StateMachine.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.Step.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.Windows.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.Windows.Audio.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.Windows.Elevation.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.AudioAnalysis.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.AudioCapture.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.AudioPlayback.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.Bridge.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.Config.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.Configuration.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.DesktopLifecycle.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.Evidence.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.EvidenceCollection.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.ExecutionContext.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.FixtureRunner.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.Metrics.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.PhysicalCapture.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.PlatformOperations.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.PreDesktopPhase.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.Preflight.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.Provider.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.RawContent.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.Readiness.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.Report.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.RunLifecycle.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.Runner.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.Stt.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.VirtualDriverCapture.psm1',
  'scripts/testing/watch-mode-report.mjs',
  'scripts/testing/verify-watch-mode-evidence.mjs',
  'scripts/testing/watch-mode-evidence-authority.mjs',
  'scripts/testing/watch-mode-balanced-release-plan.mjs',
  'scripts/testing/watch-mode-local-isolation.mjs',
  'scripts/testing/watch-mode-strict-runtime-authority.mjs',
  'scripts/testing/collect-watch-mode-system-metrics.ps1',
  'scripts/development/build-desktop-release.mjs',
  'scripts/release/new-local-release-certificate.ps1',
  'scripts/installer/build-sysvad-driver.ps1',
  'scripts/installer/install-development-driver.ps1',
  'scripts/installer/probe-development-driver.ps1',
  'scripts/installer/invoke-elevated-driver-operation.ps1',
  'scripts/installer/request-elevated-driver-operation.ps1',
  'scripts/installer/test-development-driver.ps1',
  'scripts/installer/virtual-speaker-device.ps1',
  'scripts/testing/fixtures/watch-mode-en-original.wav',
  'scripts/testing/fixtures/watch-mode-en-original.sha256',
  'scripts/testing/fixtures/watch-mode-en-original.txt',
  'scripts/testing/fixtures/watch-mode-en-original.zh-CN.txt',
]);

// Paid-only inputs remain separate so the zero-Provider authority describes
// exactly the implementation it exercised. Neither inventory may be reused
// across a commit or runtime authority digest.
export const PAID_AUTHORITY_IMPLEMENTATION_FILES = Object.freeze([
  'scripts/testing/watch-mode-external-provider-budget.mjs',
  'scripts/testing/watch-mode-canonical-source-authority.mjs',
  'scripts/testing/watch-mode-translated-pcm-loopback.mjs',
  'scripts/testing/release-manual-collector.mjs',
  'scripts/testing/watch-mode-provider-preflight-authority.mjs',
  'scripts/testing/watch-mode-provider-preflight-process.mjs',
  'scripts/testing/watch-mode-provider-network-health.mjs',
  'scripts/testing/fixtures/watch-mode-audio-fixtures.json',
]);

export const AUTHORITY_RUNTIME_BINARY_FILES = Object.freeze([
  'target/release/omni-desktop-shell.exe',
  'target/release/omni-bridge-service.exe',
  'target/release/omni-physical-output-probe.exe',
  'target/release/omni-watch-media-injector.exe',
  'target/release/omni-tone-render-probe.exe',
  'target/release/omni-driver-audio-probe.exe',
  'target/release/omni-virtual-mic-target-capture.exe',
  'target/debug/omni-realtime-diagnostic.exe',
  'target/release/omni-benchmark.exe',
  'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
  'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat',
  'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf',
  'drivers/windows-virtual-mic/package/driver-package.json',
  'drivers/windows-virtual-mic/package/omni-translate-development-driver.cer',
]);

const COMMON_CELL_ARTIFACTS = Object.freeze([
  'app.log',
  'bridge-service.log',
  'bridge-source-probe.json',
  'virtual-driver-media-source-preflight.json',
  'driver.json',
  'external-provider-budget.json',
  'evidence-driven-terminal.json',
  'input-complete.json',
  'physical-output-probe.json',
  'physical-playback-device.json',
  'playback.json',
  'provider-input-16k-mono.pcm',
  'provider-input-budget-lease.json',
  'provider-input-budget-ledger.json',
  'provider-input-budget-ledger.json.journal.jsonl',
  'report.json',
  'report.md',
  'run-collection.json',
  'source-media-reference-16k-mono.pcm',
  'system-metrics.json',
  'watch-session-report.json',
]);

const PHYSICAL_CONTENT_ARTIFACTS = Object.freeze([
  'physical-output-content.json',
  'physical-output-content.raw.json',
  'physical-output-recording-16k-mono.pcm',
  'physical-output-recording-source-window-16k-mono.pcm',
  'physical-output-recording.json',
  'physical-output-recording.wav',
  'source-media-transcript.json',
  'translated-cue-pcm/translated-cue-pcm-authority.jsonl',
  'translated-cue-pcm/translated-cue-pcm-summary.json',
  'translated-pcm-loopback.stdout.json',
]);

const PROCESS_EXCLUSION_ARTIFACTS = Object.freeze([
  'physical-output-probe-runtime/process-exclusion-physical-output.wav',
  'physical-output-probe-runtime/process-exclusion-source-pipe.wav',
]);

const portable = (value) => value.split(path.sep).join('/');

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function requiredCellArtifactPaths(feedbackLoopPrevention) {
  const mode = String(feedbackLoopPrevention ?? '').trim();
  const paths = [...COMMON_CELL_ARTIFACTS];
  if (['echo-cancel', 'virtual-driver', 'process-exclusion'].includes(mode)) {
    paths.push(...PHYSICAL_CONTENT_ARTIFACTS);
  }
  if (mode === 'process-exclusion') paths.push(...PROCESS_EXCLUSION_ARTIFACTS);
  return paths.sort();
}

export function forbiddenCellArtifactPaths(feedbackLoopPrevention) {
  void feedbackLoopPrevention;
  return [];
}

function assertRegularEvidenceFile(filePath, label) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    throw new Error(`${label} is missing: ${filePath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${filePath}`);
  }
  if (stats.size <= 0) {
    throw new Error(`${label} is empty: ${filePath}`);
  }
  return stats;
}

export function fileAuthorityEntry(filePath, relativePath) {
  const stats = assertRegularEvidenceFile(filePath, `authority artifact ${relativePath}`);
  return {
    path: portable(relativePath),
    bytes: stats.size,
    sha256: sha256File(filePath),
  };
}

export function currentAuthorityImplementationHashes({ workspaceRoot = repoRoot } = {}) {
  return AUTHORITY_IMPLEMENTATION_FILES.map((relativePath) => fileAuthorityEntry(
    path.resolve(workspaceRoot, relativePath),
    relativePath,
  ));
}

export function currentPaidAuthorityImplementationHashes({ workspaceRoot = repoRoot } = {}) {
  return PAID_AUTHORITY_IMPLEMENTATION_FILES.map((relativePath) => fileAuthorityEntry(
    path.resolve(workspaceRoot, relativePath),
    relativePath,
  ));
}

export function currentAuthorityRuntimeBinaryHashes({ workspaceRoot = repoRoot } = {}) {
  return AUTHORITY_RUNTIME_BINARY_FILES.map((relativePath) => fileAuthorityEntry(
    path.resolve(workspaceRoot, relativePath),
    relativePath,
  ));
}

export function relativeChildPath(parentDirectory, childPath, label = 'path') {
  const parent = path.resolve(parentDirectory);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of ${parent}: ${child}`);
  }
  return portable(relative);
}

export function resolveAuthorityPath(parentDirectory, relativePath, label = 'authority path') {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = relativePath.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || normalized.split('/').some((part) => part === '..')) {
    throw new Error(`${label} must not be absolute or contain '..': ${relativePath}`);
  }
  const resolved = path.resolve(parentDirectory, ...normalized.split('/'));
  relativeChildPath(parentDirectory, resolved, label);
  return resolved;
}

function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

export function writeCellAuthorityReceipt({
  outputRoot,
  runDirectory,
  matrixCell,
  provenance,
  implementationHashes = currentAuthorityImplementationHashes(),
  paidImplementationHashes = currentPaidAuthorityImplementationHashes(),
  shardAuthority = null,
  runtimeBinaryHashes = currentAuthorityRuntimeBinaryHashes(),
  now = new Date(),
}) {
  const resolvedOutputRoot = path.resolve(outputRoot);
  const resolvedRunDirectory = path.resolve(runDirectory);
  const runDirectoryRelative = relativeChildPath(
    resolvedOutputRoot,
    resolvedRunDirectory,
    'Watch Mode run directory',
  );
  const expectedArtifacts = requiredCellArtifactPaths(matrixCell.feedbackLoopPrevention);
  const artifacts = expectedArtifacts.map((relativePath) => fileAuthorityEntry(
    resolveAuthorityPath(resolvedRunDirectory, relativePath, 'cell artifact'),
    relativePath,
  ));
  const receipt = {
    schemaVersion: CELL_AUTHORITY_SCHEMA_VERSION,
    artifactKind: CELL_AUTHORITY_ARTIFACT_KIND,
    generatedAt: now.toISOString(),
    runner: MATRIX_RUNNER_ID,
    collector: LIVE_RUN_COLLECTOR_ID,
    provenance,
    runDirectory: runDirectoryRelative,
    matrixCell: {
      cellId: matrixCell.cellId,
      tier: matrixCell.tier,
      providerMode: matrixCell.providerMode,
      inputCompletionWatchdogSeconds: matrixCell.inputCompletionWatchdogSeconds,
      processExclusionRestartAfterSeconds: matrixCell.processExclusionRestartAfterSeconds,
      processExclusionRestartQuietSeconds: matrixCell.processExclusionRestartQuietSeconds,
      providerFinishTimeoutSeconds: matrixCell.providerFinishTimeoutSeconds,
      localPlaybackDrainTimeoutSeconds: matrixCell.localPlaybackDrainTimeoutSeconds,
      reportWriteTimeoutSeconds: matrixCell.reportWriteTimeoutSeconds,
      cellHardWatchdogSeconds: matrixCell.cellHardWatchdogSeconds,
      authoritativeTransformedReferenceFrames: matrixCell.authoritativeTransformedReferenceFrames,
      boundedCaptureGraceFrames: matrixCell.boundedCaptureGraceFrames,
      maxExternalAudioSamples: matrixCell.maxExternalAudioSamples,
      auxiliaryExternalAudioSeconds: matrixCell.auxiliaryExternalAudioSeconds,
      subtitleTranslationMode: matrixCell.subtitleTranslationMode,
      modelId: matrixCell.modelId,
      feedbackLoopPrevention: matrixCell.feedbackLoopPrevention,
      deviceClass: matrixCell.deviceClass,
      deviceProfileId: matrixCell.deviceProfileId,
    },
    implementationHashes,
    paidImplementationHashes,
    ...(shardAuthority ? { shardAuthority } : {}),
    runtimeBinaryHashes,
    artifacts,
  };
  const receiptPath = path.join(resolvedRunDirectory, CELL_AUTHORITY_FILE);
  atomicWriteJson(receiptPath, receipt);
  const receiptAuthority = fileAuthorityEntry(
    receiptPath,
    `${runDirectoryRelative}/${CELL_AUTHORITY_FILE}`,
  );
  return {
    ...receipt.matrixCell,
    runDirectory: runDirectoryRelative,
    receiptPath: receiptAuthority.path,
    receiptBytes: receiptAuthority.bytes,
    receiptSha256: receiptAuthority.sha256,
    ...(shardAuthority ? { shardAuthority } : {}),
  };
}

export function sameAuthorityInventory(recorded, current) {
  if (!Array.isArray(recorded) || recorded.length !== current.length) return false;
  return recorded.every((entry, index) => (
    entry?.path === current[index].path
    && entry?.bytes === current[index].bytes
    && entry?.sha256 === current[index].sha256
  ));
}

export function validateFileAuthorityEntry(parentDirectory, entry, expectedRelativePath, label) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`${label} authority entry is missing`);
  }
  const expectedPortablePath = portable(expectedRelativePath);
  if (entry.path !== expectedPortablePath) {
    throw new Error(`${label} path mismatch: expected ${expectedPortablePath}; got ${entry.path ?? 'missing'}`);
  }
  const filePath = resolveAuthorityPath(parentDirectory, expectedPortablePath, label);
  const current = fileAuthorityEntry(filePath, expectedPortablePath);
  if (entry.bytes !== current.bytes || entry.sha256 !== current.sha256) {
    throw new Error(
      `${label} hash/size mismatch for ${expectedPortablePath}: recorded sha256=${entry.sha256 ?? 'missing'} bytes=${entry.bytes ?? 'missing'} current sha256=${current.sha256} bytes=${current.bytes}`,
    );
  }
  return filePath;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => (
    entry === undefined ? 'null' : canonicalJson(entry)
  )).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
