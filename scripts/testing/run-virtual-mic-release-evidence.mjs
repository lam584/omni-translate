import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  compactTimestamp,
  ensureDir,
  isMain,
  parseCliArgs,
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
  VIRTUAL_MIC_RELEASE_EMITTER_ID,
  VIRTUAL_MIC_RELEASE_EMITTER_VERSION,
  VIRTUAL_MIC_RELEASE_RUNNER,
  VIRTUAL_MIC_RELEASE_SCENARIO_ID,
  VIRTUAL_MIC_RELEASE_TIMELINE,
  fileReceipt,
  sha256File,
} from './virtual-mic-release-evidence.mjs';

const DEFAULT_OUTPUT_ROOT = 'artifacts/testing/virtual-mic-release-evidence';
const DEFAULT_COLLECTOR_OUTPUT_ROOT = 'artifacts/testing/release-manual-collector';
const DEFAULT_TIMEOUT_MS = 120_000;
const BRIDGE_BINARY = 'omni-bridge-service.exe';
const COLLECTOR_BINARY = 'omni-virtual-mic-target-capture.exe';

const assertCleanProvenance = (provenance, subject = 'virtual microphone source provenance') => {
  const issue = gitProvenanceShapeFailure(provenance, subject);
  if (issue) throw new Error(issue);
};

const assertSameCleanProvenance = (recorded, current) => {
  const issue = exactGitProvenanceFailure(recorded, current, {
    recordedSubject: 'virtual microphone build provenance',
    currentSubject: 'post-operation checkout provenance',
  });
  if (issue) throw new Error(issue);
};

const allowedTestingRoot = (workspaceRoot, candidate, subject) => {
  const allowed = path.resolve(workspaceRoot, 'artifacts', 'testing');
  const resolved = path.resolve(workspaceRoot, candidate);
  const comparableAllowed = process.platform === 'win32' ? allowed.toLowerCase() : allowed;
  const comparable = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (comparable !== comparableAllowed && !comparable.startsWith(`${comparableAllowed}${path.sep}`)) {
    throw new Error(`${subject} must stay under artifacts/testing`);
  }
  return resolved;
};

export function parseVirtualMicReleaseArgs(argv) {
  return parseCliArgs(argv, {
    defaults: {
      outputRoot: DEFAULT_OUTPUT_ROOT,
      collectorOutputRoot: DEFAULT_COLLECTOR_OUTPUT_ROOT,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  });
}

export function buildVirtualMicReleasePlan({
  workspaceRoot = repoRoot,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  collectorOutputRoot = DEFAULT_COLLECTOR_OUTPUT_ROOT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  now = new Date(),
  invocationId = crypto.randomUUID(),
  suffix = crypto.randomUUID().slice(0, 8),
  source,
  collectorExecutable,
  bridgeExecutable,
  cargoTargetDir,
  dryRun,
  skip,
  simulated,
} = {}) {
  if ([
    source,
    collectorExecutable,
    bridgeExecutable,
    cargoTargetDir,
    dryRun,
    skip,
    simulated,
  ].some((value) => value !== undefined)) {
    throw new Error(
      'virtual microphone production emitter does not accept source/binary/target/dry-run/skip/simulated overrides',
    );
  }
  assertCleanProvenance(provenance);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(invocationId))) {
    throw new Error('virtual microphone invocationId must be a UUID');
  }
  const parsedTimeout = Number(timeoutMs);
  if (!Number.isInteger(parsedTimeout) || parsedTimeout < 30_000 || parsedTimeout > 600_000) {
    throw new Error('--timeout-ms must be an integer between 30000 and 600000');
  }
  const absoluteWorkspace = path.resolve(workspaceRoot);
  const outputBase = allowedTestingRoot(absoluteWorkspace, outputRoot, 'virtual microphone output root');
  const collectorOutputBase = allowedTestingRoot(
    absoluteWorkspace,
    collectorOutputRoot,
    'virtual microphone collector output root',
  );
  const targetDirectory = path.join(absoluteWorkspace, 'target');
  const releaseDirectory = path.join(targetDirectory, 'release');
  return {
    scenarioId: VIRTUAL_MIC_RELEASE_SCENARIO_ID,
    workspaceRoot: absoluteWorkspace,
    collectorOutputRoot: collectorOutputBase,
    provenance,
    invocationId,
    timeoutMs: parsedTimeout,
    targetDirectory,
    manifestPath: path.join(absoluteWorkspace, 'apps', 'bridge-service-native', 'Cargo.toml'),
    collectorExecutable: path.join(releaseDirectory, COLLECTOR_BINARY),
    bridgeExecutable: path.join(releaseDirectory, BRIDGE_BINARY),
    runnerPath: path.join(absoluteWorkspace, ...VIRTUAL_MIC_RELEASE_RUNNER.split('/')),
    runDirectory: path.join(
      outputBase,
      provenance.headCommit.slice(0, 12),
      `${compactTimestamp(now)}-virtual-mic-${suffix}`,
    ),
  };
}

export const buildCurrentVirtualMicBinaries = (plan, { run = spawnSync } = {}) => {
  for (const candidate of [plan.collectorExecutable, plan.bridgeExecutable]) {
    fs.rmSync(candidate, { force: true });
  }
  const environment = { ...process.env };
  environment.CARGO_TARGET_DIR = plan.targetDirectory;
  environment.OMNI_BUILD_COMMIT = plan.provenance.headCommit;
  delete environment.CARGO_BUILD_TARGET;
  return run('cargo', [
    'build',
    '--locked',
    '--release',
    '--manifest-path',
    plan.manifestPath,
    '--bin',
    'omni-bridge-service',
    '--bin',
    'omni-virtual-mic-target-capture',
  ], {
    cwd: plan.workspaceRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
    timeout: plan.timeoutMs,
  });
};

const defaultBuildCommit = (candidate, timeoutMs) => spawnSync(candidate, ['--build-commit'], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: timeoutMs,
});

const defaultCollectorRun = (plan, runtimeRoot) => spawnSync(plan.collectorExecutable, [
  '--output-directory', plan.runDirectory,
  '--bridge-exe', plan.bridgeExecutable,
  '--runtime-root', runtimeRoot,
], {
  cwd: plan.workspaceRoot,
  encoding: 'utf8',
  windowsHide: true,
  timeout: plan.timeoutMs,
});

const terminalJson = (output) => {
  const lines = String(output ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('native virtual microphone collector emitted no JSON result');
  return JSON.parse(lines.at(-1));
};

export async function runVirtualMicReleaseEvidence({
  plan,
  build = buildCurrentVirtualMicBinaries,
  probeBuildCommit = defaultBuildCommit,
  runCollector = defaultCollectorRun,
  provenanceReader = () => currentGitProvenance({ cwd: plan.workspaceRoot }),
  clock = () => new Date(),
  collect,
} = {}) {
  if (!plan) throw new Error('virtual microphone release evidence plan is required');
  if (fs.existsSync(plan.runDirectory)) {
    throw new Error(`virtual microphone evidence run directory already exists: ${plan.runDirectory}`);
  }
  ensureDir(plan.runDirectory);
  const runtimeRoot = path.join(os.tmpdir(), `omni-vmic-release-${plan.invocationId}`);
  if (fs.existsSync(runtimeRoot)) {
    throw new Error(`virtual microphone runtime root already exists: ${runtimeRoot}`);
  }
  const timeline = [];
  const push = (event, detail = null) => timeline.push({
    event,
    invocationId: plan.invocationId,
    observedAt: clock().toISOString(),
    sequence: timeline.length + 1,
    detail,
  });
  const startedAt = clock().toISOString();
  try {
    push('build-started', {
      manifestPath: plan.manifestPath,
      cargoTargetDirectory: plan.targetDirectory,
      cargoBuildTargetCleared: true,
    });
    const built = await build(plan);
    if (Number(built?.status) !== 0) {
      throw new Error(`current-HEAD virtual microphone release build failed: ${built?.stderr ?? ''}`);
    }
    push('build-completed');
    assertSameCleanProvenance(plan.provenance, provenanceReader());
    const binaries = {};
    for (const [role, candidate] of [
      ['collector', plan.collectorExecutable],
      ['bridge', plan.bridgeExecutable],
    ]) {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        throw new Error(`current-HEAD build did not produce canonical ${role} executable: ${candidate}`);
      }
      const commit = await probeBuildCommit(candidate, plan.timeoutMs);
      const buildCommit = String(commit?.stdout ?? '').trim().toLowerCase();
      if (Number(commit?.status) !== 0 || buildCommit !== plan.provenance.headCommit.toLowerCase()) {
        throw new Error(`${role} --build-commit does not match current exact clean HEAD`);
      }
      binaries[role] = {
        path: candidate,
        sha256: sha256File(candidate),
        buildCommit,
        processId: 0,
      };
    }
    push('binaries-verified', {
      collectorSha256: binaries.collector.sha256,
      bridgeSha256: binaries.bridge.sha256,
      buildCommit: plan.provenance.headCommit,
    });
    ensureDir(runtimeRoot);
    push('collector-started');
    const executed = await runCollector(plan, runtimeRoot);
    if (!Number.isInteger(Number(executed?.pid)) || Number(executed.pid) <= 0) {
      throw new Error('native virtual microphone collector processId is unavailable');
    }
    binaries.collector.processId = Number(executed.pid);
    if (Number(executed?.status) !== 0) {
      throw new Error(`native virtual microphone collector failed: ${executed?.stderr ?? executed?.stdout ?? ''}`);
    }
    const nativeResult = terminalJson(executed.stdout);
    if (nativeResult?.passed !== true) {
      throw new Error('native virtual microphone collector did not report passed=true');
    }
    const probe = readJson(path.join(plan.runDirectory, 'virtual-mic-capture-probe.json'));
    const snapshot = readJson(path.join(plan.runDirectory, 'runtime-snapshot.json'));
    if (Number(probe?.parentCollectorProcessId) !== Number(executed.pid)) {
      throw new Error('native probe parentCollectorProcessId does not match the process launched by the runner');
    }
    binaries.bridge.processId = Number(probe?.bridgeProcessId);
    push('collector-completed', {
      collectorProcessId: binaries.collector.processId,
      bridgeProcessId: binaries.bridge.processId,
      exitCode: Number(executed.status),
    });
    for (const name of [
      'virtual-mic-capture.wav',
      'virtual-mic-capture-probe.json',
      'runtime-snapshot.json',
    ]) {
      if (!fs.existsSync(path.join(plan.runDirectory, name))) {
        throw new Error(`native virtual microphone collector did not produce ${name}`);
      }
    }
    if (
      JSON.stringify(probe?.rawCountersBefore) !== JSON.stringify(snapshot?.rawCountersBefore)
      || JSON.stringify(probe?.rawCountersAfter) !== JSON.stringify(snapshot?.rawCountersAfter)
      || probe?.cueId !== snapshot?.cueId
      || probe?.bridgeSessionId !== snapshot?.bridgeSessionId
    ) throw new Error('native virtual microphone raw authority diverges before packaging');
    push('raw-evidence-verified');
    assertSameCleanProvenance(plan.provenance, provenanceReader());
    push('invocation-completed');
    const rawArtifacts = [
      'virtual-mic-capture.wav',
      'virtual-mic-capture-probe.json',
      'runtime-snapshot.json',
    ].map((relativePath) => fileReceipt(path.join(plan.runDirectory, relativePath), relativePath));
    writeJson(path.join(plan.runDirectory, 'emitter-result.json'), {
      schemaVersion: 1,
      artifactKind: 'virtual-mic-release-evidence-emitter-result',
      collectorId: VIRTUAL_MIC_RELEASE_EMITTER_ID,
      collectorVersion: VIRTUAL_MIC_RELEASE_EMITTER_VERSION,
      scenarioId: VIRTUAL_MIC_RELEASE_SCENARIO_ID,
      invocationId: plan.invocationId,
      status: 'completed',
      startedAt,
      completedAt: clock().toISOString(),
      sourceHeadCommit: plan.provenance.headCommit,
      provenance: plan.provenance,
      runner: {
        path: VIRTUAL_MIC_RELEASE_RUNNER,
        sha256: sha256File(plan.runnerPath),
      },
      binaries,
      collectorInvocation: {
        exitCode: Number(executed.status),
        passed: nativeResult.passed,
        cueId: nativeResult.cueId,
        captureEndpointId: nativeResult.captureEndpointId,
        stdoutSha256: crypto.createHash('sha256').update(String(executed.stdout ?? '')).digest('hex'),
      },
      rawAuthority: {
        captureChildProcessId: probe.captureChildProcessId,
        bridgeInstanceId: probe.bridgeInstanceId,
        bridgeSessionId: probe.bridgeSessionId,
        captureEndpointId: probe.captureEndpointId,
        captureEndpointName: probe.captureEndpointName,
        cueId: probe.cueId,
      },
      rawArtifacts,
      timeline,
      error: null,
    });
    if (typeof collect !== 'function') {
      throw new Error('virtual microphone raw packaging is private; invoke the production release collector entrypoint');
    }
    const collected = await collect({
      source: plan.runDirectory,
      scenarioId: VIRTUAL_MIC_RELEASE_SCENARIO_ID,
      outputRoot: plan.collectorOutputRoot,
      workspaceRoot: plan.workspaceRoot,
      provenance: plan.provenance,
    });
    return {
      scenarioId: VIRTUAL_MIC_RELEASE_SCENARIO_ID,
      invocationId: plan.invocationId,
      rawDirectory: plan.runDirectory,
      packageDirectory: collected.packageDirectory,
      manifestPath: collected.manifestPath,
    };
  } catch (error) {
    fs.rmSync(plan.runDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  setImmediate(async () => {
    try {
      if (process.platform !== 'win32' || process.arch !== 'x64') {
        throw new Error('virtual microphone release evidence requires Windows x64');
      }
      const args = parseVirtualMicReleaseArgs(process.argv.slice(2));
      const { collectVirtualMicReleaseManualEvidence } = await import('./release-manual-collector.mjs');
      console.log(JSON.stringify(await collectVirtualMicReleaseManualEvidence({
        scenarioId: VIRTUAL_MIC_RELEASE_SCENARIO_ID,
        ...args,
      }), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  });
}
