import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { compactTimestamp, isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance, exactGitProvenanceFailure } from './git-provenance.mjs';
import {
  currentAuthorityImplementationHashes,
  currentAuthorityRuntimeBinaryHashes,
  fileAuthorityEntry,
  sameAuthorityInventory,
} from './watch-mode-evidence-authority.mjs';
import {
  BALANCED_RELEASE_PLAN_ID,
  LOCAL_ISOLATION_CELLS,
  RELEASE_DEVICE_CLASSES,
} from './watch-mode-balanced-release-plan.mjs';

export const LOCAL_ISOLATION_SCHEMA_VERSION = 1;
export const LOCAL_ISOLATION_ARTIFACT_KIND = 'watch-mode-local-isolation-authority';
export const LOCAL_ISOLATION_CELL_ARTIFACT_KIND = 'watch-mode-local-isolation-cell';
export const LOCAL_ISOLATION_RUNNER_ID = 'scripts/testing/watch-mode-local-isolation.mjs';
export const LOCAL_ISOLATION_CANONICAL_MANIFEST = 'latest-successful-watch-mode-local-isolation.json';
export const LOCAL_ISOLATION_REUSE_MODE = 'orchestration-only';
// The v2 and v3 release plans have the exact same six zero-Provider cells.
// Only the paid tiers changed their drain/stability allocation. A v2 local
// authority can therefore be reused only through the separately audited
// orchestration-only path below; ordinary verification still requires v3.
export const LOCAL_ISOLATION_REUSABLE_LEGACY_PLAN_IDS = Object.freeze([
  'watch-mode-balanced-v2',
]);
export const LOCAL_ISOLATION_REUSE_ALLOWED_PATHS = Object.freeze([
  '.gitattributes',
  'package.json',
  'docs/项目/Watch Mode 真实链路自动化测试.md',
  'apps/bridge-service-native/src/bin/omni-watch-media-injector.rs',
  'scripts/installer/build-sysvad-driver.ps1',
  'scripts/testing/README.md',
  'scripts/testing/run-watch-mode-live-matrix.mjs',
  'scripts/testing/run-watch-mode-live-matrix.test.mjs',
  'scripts/testing/run-watch-mode-live.ps1',
  'scripts/testing/run-watch-mode-live.test.mjs',
  'scripts/testing/watch-mode-balanced-release-plan.mjs',
  'scripts/testing/watch-mode-balanced-release-plan.test.mjs',
  'scripts/testing/watch-mode-report-content.test.mjs',
  'scripts/testing/watch-mode-report.mjs',
  'scripts/testing/verify-watch-mode-evidence.mjs',
  'scripts/testing/watch-mode-local-isolation.mjs',
  'scripts/testing/watch-mode-local-isolation.test.mjs',
]);

// The zero-LLM layer invokes only these probe/runtime artifacts.  The paid
// Watch layer has additional binaries (notably the media injector) whose
// changes must invalidate paid-cell receipts, but cannot invalidate a local
// isolation receipt that never launches them.  Keep this scope explicit so a
// rebuilt paid binary is not silently treated as part of the local evidence.
export const LOCAL_ISOLATION_RUNTIME_BINARY_PATHS = Object.freeze([
  'target/release/omni-bridge-service.exe',
  'target/release/omni-physical-output-probe.exe',
  'target/release/omni-tone-render-probe.exe',
  'target/release/omni-driver-audio-probe.exe',
  'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
  'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat',
  'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf',
  'drivers/windows-virtual-mic/package/driver-package.json',
]);

const DEFAULT_OUTPUT_ROOT = 'artifacts/testing/watch-mode-local-isolation';
const BRIDGE_EXE = 'target/release/omni-bridge-service.exe';
const PHYSICAL_PROBE_EXE = 'target/release/omni-physical-output-probe.exe';
const DRIVER_PROBE_EXE = 'target/release/omni-driver-audio-probe.exe';
const TONE_PROBE_EXE = 'target/release/omni-tone-render-probe.exe';
const TRANSIENT_ENDPOINT_CREATE_FAILED = '0x8889000f';
const TRANSIENT_ENDPOINT_CREATE_MAX_ATTEMPTS = 3;
const TRANSIENT_ENDPOINT_CREATE_RETRY_DELAY_MS = 750;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const portable = (value) => value.split(path.sep).join('/');

export const localIsolationRuntimeInventory = (entries) => {
  const inventory = authorityInventoryByPath(entries);
  return LOCAL_ISOLATION_RUNTIME_BINARY_PATHS.map((entryPath) => inventory.get(entryPath)).filter(Boolean);
};

function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

const assertCleanCurrentHead = (provenance) => {
  if (
    !/^[a-f0-9]{40}$/i.test(String(provenance?.headCommit ?? ''))
    || provenance?.worktreeClean !== true
    || Number(provenance?.dirtyEntryCount) !== 0
  ) throw new Error('local isolation authority requires the current exact clean HEAD');
};

export function buildLocalIsolationRuntime({
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  run = spawnSync,
  provenanceReader = () => currentGitProvenance({ cwd: workspaceRoot }),
  runtimeHashesReader = () => currentAuthorityRuntimeBinaryHashes({ workspaceRoot }),
} = {}) {
  assertCleanCurrentHead(provenance);
  const environment = { ...process.env };
  environment.CARGO_TARGET_DIR = path.join(workspaceRoot, 'target');
  environment.OMNI_BUILD_COMMIT = provenance.headCommit;
  delete environment.CARGO_BUILD_TARGET;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  for (const args of [
    ['run', 'build:bridge-service-native'],
    ['run', 'driver:build-sysvad'],
  ]) {
    const result = run(npm, args, {
      cwd: workspaceRoot,
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
      // Windows exposes npm as a .cmd shim. Node cannot spawn that shim
      // directly from some non-interactive/SSH hosts unless shell dispatch
      // is enabled; keep the command/arguments fixed and only opt into the
      // platform command resolver here.
      shell: process.platform === 'win32',
    });
    if (result.error || Number(result.status) !== 0) {
      throw new Error(`local isolation runtime build failed: npm ${args.join(' ')}`);
    }
  }
  const after = provenanceReader();
  const failure = exactGitProvenanceFailure(provenance, after, {
    recordedSubject: 'local isolation pre-build provenance',
    currentSubject: 'local isolation post-build provenance',
  });
  if (failure) throw new Error(failure);
  return runtimeHashesReader();
}

export function parseLocalIsolationDeviceProfiles(value, { workspaceRoot = repoRoot } = {}) {
  if (!value) throw new Error('--device-profiles is required');
  const text = String(value).trim();
  const parsed = JSON.parse(
    (text.startsWith('[') || text.startsWith('{')
      ? text
      : fs.readFileSync(path.resolve(workspaceRoot, text), 'utf8')).replace(/^\uFEFF/, ''),
  );
  const profiles = Array.isArray(parsed) ? parsed : parsed?.deviceProfiles;
  if (!Array.isArray(profiles)) throw new Error('--device-profiles must contain a JSON array');
  const normalized = profiles.map((profile) => ({
    profileId: String(profile?.profileId ?? '').trim(),
    deviceClass: String(profile?.deviceClass ?? '').trim(),
    physicalPlaybackDeviceId: String(profile?.physicalPlaybackDeviceId ?? '').trim(),
    expectedPhysicalPlaybackDeviceName: String(profile?.expectedPhysicalPlaybackDeviceName ?? '').trim(),
  }));
  const classes = normalized.map(({ deviceClass }) => deviceClass);
  if (
    normalized.length !== RELEASE_DEVICE_CLASSES.length
    || !RELEASE_DEVICE_CLASSES.every((deviceClass) => classes.filter((entry) => entry === deviceClass).length === 1)
  ) throw new Error(`local isolation requires exactly one profile for ${RELEASE_DEVICE_CLASSES.join(', ')}`);
  for (const profile of normalized) {
    if (!profile.profileId || !profile.physicalPlaybackDeviceId) {
      throw new Error(`local isolation device profile ${profile.deviceClass || '-'} is incomplete`);
    }
    if (profile.deviceClass !== 'default-speaker' && !profile.expectedPhysicalPlaybackDeviceName) {
      throw new Error(`local isolation device profile ${profile.profileId} requires an expected endpoint name`);
    }
  }
  return normalized;
}

const commandResult = (command, args, { cwd, environment, timeoutMs }) => {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
  });
  return {
    command: portable(path.relative(cwd, command) || command),
    args,
    exitCode: result.status ?? 1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    error: result.error?.message ?? null,
  };
};

const waitForTransientEndpointRetry = (delayMs) => {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, delayMs);
};

const isTransientEndpointCreateFailure = (result) => [
  result?.stdout,
  result?.stderr,
  result?.error,
].filter(Boolean).join('\n').toLowerCase().includes(TRANSIENT_ENDPOINT_CREATE_FAILED);

const parseProbeJson = (result, label) => {
  if (result.exitCode !== 0 || result.error) {
    throw new Error(`${label} failed: exit=${result.exitCode} error=${result.error ?? '-'} stderr=${result.stderr}`);
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let parsed;
  try {
    parsed = JSON.parse(lines.at(-1) ?? '');
  } catch {
    throw new Error(`${label} did not emit a terminal JSON object`);
  }
  if (parsed?.passed !== true) throw new Error(`${label} did not pass: ${parsed?.detail ?? 'unknown'}`);
  return parsed;
};

export function runLocalIsolationProbeIteration({
  cell,
  profile,
  cellDirectory,
  iteration,
  workspaceRoot = repoRoot,
  environment = process.env,
  run = commandResult,
  waitForRetry = waitForTransientEndpointRetry,
}) {
  const iterationDirectory = path.join(cellDirectory, 'iterations', String(iteration).padStart(4, '0'));
  fs.mkdirSync(iterationDirectory, { recursive: true });
  const execute = (relativeCommand, args, label, timeoutMs = 90_000) => {
    let result;
    let attempts = 0;
    do {
      attempts += 1;
      result = run(path.resolve(workspaceRoot, relativeCommand), args, {
        cwd: workspaceRoot,
        environment,
        timeoutMs,
      });
      const retryable = isTransientEndpointCreateFailure(result);
      if (retryable && attempts < TRANSIENT_ENDPOINT_CREATE_MAX_ATTEMPTS) {
        // AUDCLNT_E_ENDPOINT_CREATE_FAILED (0x8889000F) can be returned by a
        // just-released shared endpoint after many short WASAPI probe streams.
        // Preserve each failed attempt, then retry only this documented
        // transient condition; every other failure remains fail-closed.
        fs.writeFileSync(path.join(iterationDirectory, `${label}.attempt-${attempts}.stdout.log`), result.stdout || '\n', 'utf8');
        fs.writeFileSync(path.join(iterationDirectory, `${label}.attempt-${attempts}.stderr.log`), result.stderr || '\n', 'utf8');
        waitForRetry(TRANSIENT_ENDPOINT_CREATE_RETRY_DELAY_MS);
        continue;
      }
      break;
    } while (true);
    fs.writeFileSync(path.join(iterationDirectory, `${label}.stdout.log`), result.stdout || '\n', 'utf8');
    fs.writeFileSync(path.join(iterationDirectory, `${label}.stderr.log`), result.stderr || '\n', 'utf8');
    return { result, attempts, parsed: parseProbeJson(result, label) };
  };
  const runtimeRoot = path.join(iterationDirectory, 'runtime');
  const physicalArgs = [
    '--bridge-exe', path.resolve(workspaceRoot, BRIDGE_EXE),
    '--runtime-root', runtimeRoot,
    '--physical-playback-device-id', profile.physicalPlaybackDeviceId,
  ];
  const probes = [];
  if (cell.feedbackLoopPrevention === 'process-exclusion') {
    const outcome = execute(PHYSICAL_PROBE_EXE, [
      ...physicalArgs,
      '--process-exclusion-fingerprint',
      '--tone-player-exe', path.resolve(workspaceRoot, TONE_PROBE_EXE),
    ], 'process-exclusion');
    probes.push({ kind: 'process-exclusion-fingerprint', attempts: outcome.attempts, data: outcome.parsed });
  } else {
    if (cell.feedbackLoopPrevention === 'virtual-driver') {
      const driver = execute(DRIVER_PROBE_EXE, [], 'virtual-driver');
      probes.push({ kind: 'virtual-driver-roundtrip', attempts: driver.attempts, data: driver.parsed });
    }
    const physical = execute(PHYSICAL_PROBE_EXE, physicalArgs, 'physical-output');
    probes.push({ kind: 'physical-output', attempts: physical.attempts, data: physical.parsed });
  }
  const resolvedNames = probes.map(({ data }) => (
    data.resolvedPhysicalPlaybackDeviceName ?? data.endpointName ?? ''
  )).filter(Boolean);
  if (
    profile.expectedPhysicalPlaybackDeviceName
    && resolvedNames.length > 0
    && !resolvedNames.some((name) => name.includes(profile.expectedPhysicalPlaybackDeviceName))
  ) {
    throw new Error(`local isolation ${cell.cellId} resolved the wrong endpoint: ${resolvedNames.join(', ')}`);
  }
  const result = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-local-isolation-iteration',
    cellId: cell.cellId,
    iteration,
    providerCalls: 0,
    probes,
  };
  atomicWriteJson(path.join(iterationDirectory, 'result.json'), result);
  return result;
}

const collectFiles = (directory) => {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name !== 'cell-authority.json') files.push(candidate);
    }
  };
  visit(directory);
  return files.sort().map((filePath) => {
    const bytes = fs.readFileSync(filePath);
    return {
      path: portable(path.relative(directory, filePath)),
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
};

export async function runLocalIsolationCell({
  cell,
  profile,
  outputRoot,
  provenance,
  implementationHashes,
  runtimeBinaryHashes,
  workspaceRoot = repoRoot,
  now = () => Date.now(),
  runIteration = runLocalIsolationProbeIteration,
}) {
  const startedAtMs = now();
  const cellDirectory = path.join(outputRoot, cell.cellId.replaceAll('::', '--'));
  fs.mkdirSync(cellDirectory, { recursive: false });
  const targetDurationMs = cell.durationSeconds * 1_000;
  let iteration = 0;
  do {
    iteration += 1;
    await runIteration({ cell, profile, cellDirectory, iteration, workspaceRoot });
  } while (now() - startedAtMs < targetDurationMs);
  const finishedAtMs = now();
  if (finishedAtMs - startedAtMs < targetDurationMs) {
    throw new Error(`local isolation ${cell.cellId} did not span ${targetDurationMs}ms`);
  }
  const summary = {
    schemaVersion: 1,
    artifactKind: LOCAL_ISOLATION_CELL_ARTIFACT_KIND,
    cellId: cell.cellId,
    tier: cell.tier,
    providerMode: cell.providerMode,
    providerCalls: 0,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceClass: cell.deviceClass,
    deviceProfileId: profile.profileId,
    requestedDeviceId: profile.physicalPlaybackDeviceId,
    expectedDeviceName: profile.expectedPhysicalPlaybackDeviceName,
    targetDurationMs,
    durationMs: finishedAtMs - startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    iterationCount: iteration,
    verdict: 'passed',
  };
  atomicWriteJson(path.join(cellDirectory, 'local-isolation-result.json'), summary);
  const artifacts = collectFiles(cellDirectory);
  const receipt = {
    ...summary,
    provenance,
    implementationHashes,
    runtimeBinaryHashes,
    artifacts,
  };
  const receiptPath = path.join(cellDirectory, 'cell-authority.json');
  atomicWriteJson(receiptPath, receipt);
  return {
    ...summary,
    runDirectory: portable(path.relative(outputRoot, cellDirectory)),
    receipt: fileAuthorityEntry(receiptPath, portable(path.relative(outputRoot, receiptPath))),
  };
}

export function verifyLocalIsolationManifest({
  manifestPath,
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  implementationHashes = currentAuthorityImplementationHashes({ workspaceRoot }),
  runtimeBinaryHashes = currentAuthorityRuntimeBinaryHashes({ workspaceRoot }),
  reuseAuthority = null,
}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  const planIdAccepted = manifest.planId === BALANCED_RELEASE_PLAN_ID
    || (
      reuseAuthority?.mode === LOCAL_ISOLATION_REUSE_MODE
      && LOCAL_ISOLATION_REUSABLE_LEGACY_PLAN_IDS.includes(manifest.planId)
    );
  if (
    manifest.schemaVersion !== LOCAL_ISOLATION_SCHEMA_VERSION
    || manifest.artifactKind !== LOCAL_ISOLATION_ARTIFACT_KIND
    || !planIdAccepted
    || manifest.verdict !== 'passed'
  ) throw new Error('local isolation manifest is not a passed balanced release authority');
  if (reuseAuthority) {
    const reuseFailure = reusableLocalIsolationAuthorityFailure({
      manifest,
      provenance,
      implementationHashes,
      runtimeBinaryHashes,
      reuseAuthority,
      workspaceRoot,
    });
    if (reuseFailure) throw new Error(reuseFailure);
  } else {
    const provenanceFailure = exactGitProvenanceFailure(manifest.provenance, provenance, {
      recordedSubject: 'local isolation manifest provenance',
      currentSubject: 'current checkout provenance',
    });
    if (provenanceFailure) throw new Error(provenanceFailure);
    if (
      !sameAuthorityInventory(manifest.implementationHashes, implementationHashes)
      || !sameAuthorityInventory(manifest.runtimeBinaryHashes, runtimeBinaryHashes)
    ) throw new Error('local isolation implementation/runtime authority mismatch');
  }
  const manifestRoot = path.dirname(path.resolve(manifestPath));
  const aecLogAuthority = fileAuthorityEntry(
    path.resolve(manifestRoot, manifest.aec3Gate?.path ?? ''),
    manifest.aec3Gate?.path ?? '',
  );
  if (
    manifest.aec3Gate?.command !== 'npm run test:aec3-msvc'
    || manifest.aec3Gate?.verdict !== 'passed'
    || aecLogAuthority.bytes !== manifest.aec3Gate?.bytes
    || aecLogAuthority.sha256 !== manifest.aec3Gate?.sha256
  ) throw new Error('local isolation manifest does not bind a passed AEC3 MSVC gate');
  if (!Array.isArray(manifest.cells) || manifest.cells.length !== LOCAL_ISOLATION_CELLS.length) {
    throw new Error(`local isolation manifest must contain ${LOCAL_ISOLATION_CELLS.length} cells`);
  }
  const root = manifestRoot;
  for (let index = 0; index < LOCAL_ISOLATION_CELLS.length; index += 1) {
    const expected = LOCAL_ISOLATION_CELLS[index];
    const cell = manifest.cells[index];
    if (
      cell?.cellId !== expected.cellId
      || cell?.providerMode !== 'disabled'
      || Number(cell?.providerCalls) !== 0
      || Number(cell?.durationMs) < expected.durationSeconds * 1_000
      || Number(cell?.iterationCount) < 1
      || cell?.verdict !== 'passed'
    ) throw new Error(`local isolation cell ${expected.cellId} is incomplete or used a Provider`);
    const receiptPath = path.resolve(root, cell.receipt.path);
    const authority = fileAuthorityEntry(receiptPath, cell.receipt.path);
    if (authority.bytes !== cell.receipt.bytes || authority.sha256 !== cell.receipt.sha256) {
      throw new Error(`local isolation cell ${expected.cellId} receipt hash mismatch`);
    }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.cellId !== expected.cellId || receipt.providerCalls !== 0) {
      throw new Error(`local isolation cell ${expected.cellId} receipt identity mismatch`);
    }
    for (const artifact of receipt.artifacts ?? []) {
      const artifactPath = path.resolve(path.dirname(receiptPath), artifact.path);
      const current = fileAuthorityEntry(artifactPath, artifact.path);
      if (current.bytes !== artifact.bytes || current.sha256 !== artifact.sha256) {
        throw new Error(`local isolation cell ${expected.cellId} artifact changed: ${artifact.path}`);
      }
    }
  }
  return manifest;
}

const authorityInventoryByPath = (entries) => new Map(
  (Array.isArray(entries) ? entries : []).map((entry) => [entry?.path, entry]),
);

const gitText = (workspaceRoot, args) => {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return String(result.stdout ?? '').trim();
};

const reusableSourceChangedPaths = (workspaceRoot, sourceCommit, currentCommit) => {
  // Git's default quotePath mode escapes a Chinese documentation path on some
  // Windows installations, which makes a valid allow-listed path look like an
  // unknown source change. Request the literal UTF-8 pathname before applying
  // the exact allow-list comparison.
  const output = gitText(workspaceRoot, ['-c', 'core.quotePath=false', 'diff', '--name-only', `${sourceCommit}..${currentCommit}`, '--']);
  if (output === null) return null;
  return output ? output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).sort() : [];
};

export function reusableLocalIsolationAuthorityFailure({
  manifest,
  provenance,
  implementationHashes,
  runtimeBinaryHashes,
  reuseAuthority,
  workspaceRoot = repoRoot,
}) {
  if (reuseAuthority?.mode !== LOCAL_ISOLATION_REUSE_MODE) {
    return `local isolation reuse mode must be ${LOCAL_ISOLATION_REUSE_MODE}`;
  }
  const sourceCommit = String(manifest.provenance?.headCommit ?? '').toLowerCase();
  const currentCommit = String(provenance?.headCommit ?? '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !/^[a-f0-9]{40}$/.test(currentCommit)) {
    return 'local isolation reuse requires full source and current git commits';
  }
  if (manifest.provenance?.worktreeClean !== true || Number(manifest.provenance?.dirtyEntryCount) !== 0) {
    return 'local isolation reuse source authority must have been captured from a clean worktree';
  }
  if (provenance?.worktreeClean !== true || Number(provenance?.dirtyEntryCount) !== 0) {
    return 'local isolation reuse requires the current worktree to be clean';
  }
  const exactHeadReuse = sourceCommit === currentCommit;
  const changedPaths = exactHeadReuse
    ? []
    : reusableSourceChangedPaths(workspaceRoot, sourceCommit, currentCommit);
  if (!changedPaths) return 'local isolation reuse could not inspect the source-to-current diff';
  if (
    (!exactHeadReuse && changedPaths.length === 0)
    || changedPaths.some((entry) => !LOCAL_ISOLATION_REUSE_ALLOWED_PATHS.includes(entry))
  ) {
    return `local isolation reuse permits only orchestration files to change; changed=${changedPaths.join(',')}`;
  }
  if (!exactHeadReuse) {
    const ancestor = gitText(workspaceRoot, ['merge-base', '--is-ancestor', sourceCommit, currentCommit]);
    if (ancestor === null) {
      return `local isolation reuse source commit ${sourceCommit} is not an ancestor of current commit ${currentCommit}`;
    }
  }
  if (JSON.stringify(reuseAuthority.changedPaths ?? []) !== JSON.stringify(changedPaths)) {
    return 'local isolation reuse changed-path declaration does not match the git diff';
  }
  if (reuseAuthority.sourceCommit !== sourceCommit || reuseAuthority.verifiedCommit !== currentCommit) {
    return 'local isolation reuse source/current commit declaration does not match the checkout';
  }
  const recordedImplementation = authorityInventoryByPath(manifest.implementationHashes);
  const currentImplementation = authorityInventoryByPath(implementationHashes);
  if (exactHeadReuse && !sameAuthorityInventory(manifest.implementationHashes, implementationHashes)) {
    return 'local isolation exact-HEAD reuse requires identical implementation authority';
  }
  for (const [entryPath, entry] of recordedImplementation) {
    if (LOCAL_ISOLATION_REUSE_ALLOWED_PATHS.includes(entryPath)) continue;
    const current = currentImplementation.get(entryPath);
    if (!current || current.bytes !== entry.bytes || current.sha256 !== entry.sha256) {
      return `local isolation reuse implementation changed outside the orchestration file: ${entryPath}`;
    }
  }
  for (const entryPath of currentImplementation.keys()) {
    if (!recordedImplementation.has(entryPath)) {
      return `local isolation reuse introduced an unrecorded implementation file: ${entryPath}`;
    }
  }
  const recordedLocalRuntime = localIsolationRuntimeInventory(manifest.runtimeBinaryHashes);
  const sourceLocalRuntime = localIsolationRuntimeInventory(reuseAuthority.sourceRuntimeBinaryHashes);
  const currentLocalRuntime = localIsolationRuntimeInventory(runtimeBinaryHashes);
  if (
    recordedLocalRuntime.length !== LOCAL_ISOLATION_RUNTIME_BINARY_PATHS.length
    || sourceLocalRuntime.length !== LOCAL_ISOLATION_RUNTIME_BINARY_PATHS.length
    || !sameAuthorityInventory(recordedLocalRuntime, sourceLocalRuntime)
  ) {
    return 'local isolation reuse source runtime authority is not bound to the recorded manifest';
  }
  const rebuiltLocalRuntime = localIsolationRuntimeInventory(reuseAuthority.currentRuntimeBinaryHashes);
  if (
    currentLocalRuntime.length !== LOCAL_ISOLATION_RUNTIME_BINARY_PATHS.length
    || rebuiltLocalRuntime.length !== LOCAL_ISOLATION_RUNTIME_BINARY_PATHS.length
    || !sameAuthorityInventory(currentLocalRuntime, rebuiltLocalRuntime)
  ) {
    return 'local isolation reuse current runtime authority is not bound to the rebuilt matrix binaries';
  }
  return null;
}

export function createReusableLocalIsolationAuthority({
  manifestPath,
  provenance,
  implementationHashes,
  runtimeBinaryHashes,
  workspaceRoot = repoRoot,
}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  const sourceCommit = String(manifest.provenance?.headCommit ?? '').toLowerCase();
  const currentCommit = String(provenance?.headCommit ?? '').toLowerCase();
  const changedPaths = sourceCommit === currentCommit
    ? []
    : reusableSourceChangedPaths(workspaceRoot, sourceCommit, currentCommit);
  const reuseAuthority = {
    mode: LOCAL_ISOLATION_REUSE_MODE,
    sourceCommit,
    verifiedCommit: currentCommit,
    changedPaths: changedPaths ?? [],
    sourceRuntimeBinaryHashes: manifest.runtimeBinaryHashes,
    currentRuntimeBinaryHashes: runtimeBinaryHashes,
  };
  const failure = reusableLocalIsolationAuthorityFailure({
    manifest,
    provenance,
    implementationHashes,
    runtimeBinaryHashes,
    reuseAuthority,
    workspaceRoot,
  });
  if (failure) throw new Error(failure);
  return reuseAuthority;
}

export async function runLocalIsolationMatrix({
  deviceProfiles,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  now = () => Date.now(),
  runCell = runLocalIsolationCell,
  runAecGate = ({ workspaceRoot: root }) => {
    const executable = process.platform === 'win32'
      ? (process.env.ComSpec || 'cmd.exe')
      : 'npm';
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm.cmd', 'run', 'test:aec3-msvc']
      : ['run', 'test:aec3-msvc'];
    return spawnSync(executable, args, {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 900_000,
    });
  },
}) {
  assertCleanCurrentHead(provenance);
  const implementationHashes = currentAuthorityImplementationHashes({ workspaceRoot });
  const runtimeBinaryHashes = currentAuthorityRuntimeBinaryHashes({ workspaceRoot });
  const generatedAtMs = now();
  const matrixDirectory = path.resolve(
    workspaceRoot,
    outputRoot,
    `${compactTimestamp(new Date(generatedAtMs))}-${provenance.headCommit.slice(0, 12)}`,
  );
  createLocalIsolationMatrixDirectory(matrixDirectory);
  const aecGateResult = runAecGate({ workspaceRoot });
  const aecGateLogPath = path.join(matrixDirectory, 'aec3-msvc-gate.log');
  fs.writeFileSync(
    aecGateLogPath,
    `${String(aecGateResult.stdout ?? '')}\n${String(aecGateResult.stderr ?? '')}`,
    'utf8',
  );
  if (aecGateResult.error || Number(aecGateResult.status) !== 0) {
    throw new Error(`zero-LLM local isolation AEC3 gate failed: ${aecGateResult.error?.message ?? `exit ${aecGateResult.status ?? 1}`}`);
  }
  const profiles = new Map(deviceProfiles.map((profile) => [profile.deviceClass, profile]));
  const cells = [];
  for (const cell of LOCAL_ISOLATION_CELLS) {
    cells.push(await runCell({
      cell,
      profile: profiles.get(cell.deviceClass),
      outputRoot: matrixDirectory,
      provenance,
      implementationHashes,
      runtimeBinaryHashes,
      workspaceRoot,
      now,
    }));
  }
  const manifest = {
    schemaVersion: LOCAL_ISOLATION_SCHEMA_VERSION,
    artifactKind: LOCAL_ISOLATION_ARTIFACT_KIND,
    generatedAt: new Date(generatedAtMs).toISOString(),
    planId: BALANCED_RELEASE_PLAN_ID,
    provenance,
    implementationHashes,
    runtimeBinaryHashes,
    aec3Gate: {
      command: 'npm run test:aec3-msvc',
      ...fileAuthorityEntry(aecGateLogPath, path.basename(aecGateLogPath)),
      verdict: 'passed',
    },
    deviceProfiles,
    cells,
    providerCalls: 0,
    verdict: 'passed',
  };
  const manifestPath = path.join(matrixDirectory, 'local-isolation-manifest.json');
  atomicWriteJson(manifestPath, manifest);
  verifyLocalIsolationManifest({
    manifestPath,
    workspaceRoot,
    provenance,
    implementationHashes,
    runtimeBinaryHashes,
  });
  const canonicalPath = path.resolve(workspaceRoot, outputRoot, LOCAL_ISOLATION_CANONICAL_MANIFEST);
  atomicWriteJson(canonicalPath, {
    ...manifest,
    sourceManifest: fileAuthorityEntry(
      manifestPath,
      portable(path.relative(path.dirname(canonicalPath), manifestPath)),
    ),
  });
  return { manifestPath, canonicalPath, manifest };
}

export function createLocalIsolationMatrixDirectory(matrixDirectory) {
  fs.mkdirSync(path.dirname(matrixDirectory), { recursive: true });
  fs.mkdirSync(matrixDirectory, { recursive: false });
}

if (isMain(import.meta.url)) {
  try {
    if (process.platform !== 'win32') throw new Error('local isolation authority requires Windows');
    const args = parseCliArgs(process.argv.slice(2), {
      defaults: { outputRoot: DEFAULT_OUTPUT_ROOT, deviceProfiles: '' },
    });
    const deviceProfiles = parseLocalIsolationDeviceProfiles(args.deviceProfiles);
    buildLocalIsolationRuntime();
    const result = await runLocalIsolationMatrix({ deviceProfiles, outputRoot: args.outputRoot });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
