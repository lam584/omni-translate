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

const DEFAULT_OUTPUT_ROOT = 'artifacts/testing/watch-mode-local-isolation';
const BRIDGE_EXE = 'target/release/omni-bridge-service.exe';
const PHYSICAL_PROBE_EXE = 'target/release/omni-physical-output-probe.exe';
const DRIVER_PROBE_EXE = 'target/release/omni-driver-audio-probe.exe';
const TONE_PROBE_EXE = 'target/release/omni-tone-render-probe.exe';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const portable = (value) => value.split(path.sep).join('/');

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
}) {
  const iterationDirectory = path.join(cellDirectory, 'iterations', String(iteration).padStart(4, '0'));
  fs.mkdirSync(iterationDirectory, { recursive: true });
  const execute = (relativeCommand, args, label, timeoutMs = 90_000) => {
    const result = run(path.resolve(workspaceRoot, relativeCommand), args, {
      cwd: workspaceRoot,
      environment,
      timeoutMs,
    });
    fs.writeFileSync(path.join(iterationDirectory, `${label}.stdout.log`), result.stdout || '\n', 'utf8');
    fs.writeFileSync(path.join(iterationDirectory, `${label}.stderr.log`), result.stderr || '\n', 'utf8');
    return { result, parsed: parseProbeJson(result, label) };
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
    probes.push({ kind: 'process-exclusion-fingerprint', data: outcome.parsed });
  } else {
    if (cell.feedbackLoopPrevention === 'virtual-driver') {
      const driver = execute(DRIVER_PROBE_EXE, [], 'virtual-driver');
      probes.push({ kind: 'virtual-driver-roundtrip', data: driver.parsed });
    }
    const physical = execute(PHYSICAL_PROBE_EXE, physicalArgs, 'physical-output');
    probes.push({ kind: 'physical-output', data: physical.parsed });
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
}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (
    manifest.schemaVersion !== LOCAL_ISOLATION_SCHEMA_VERSION
    || manifest.artifactKind !== LOCAL_ISOLATION_ARTIFACT_KIND
    || manifest.planId !== BALANCED_RELEASE_PLAN_ID
    || manifest.verdict !== 'passed'
  ) throw new Error('local isolation manifest is not a passed balanced release authority');
  const provenanceFailure = exactGitProvenanceFailure(manifest.provenance, provenance, {
    recordedSubject: 'local isolation manifest provenance',
    currentSubject: 'current checkout provenance',
  });
  if (provenanceFailure) throw new Error(provenanceFailure);
  if (
    !sameAuthorityInventory(manifest.implementationHashes, implementationHashes)
    || !sameAuthorityInventory(manifest.runtimeBinaryHashes, runtimeBinaryHashes)
  ) throw new Error('local isolation implementation/runtime authority mismatch');
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
