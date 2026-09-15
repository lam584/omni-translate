import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { revalidateFrozenVirtualMicAuthority } from './frozen-virtual-mic-release-authority.mjs';

import { readJson, repoRoot } from '../lib/testing-common.mjs';
import { exactGitProvenanceFailure, gitProvenanceShapeFailure } from './git-provenance.mjs';

export const VIRTUAL_MIC_RELEASE_SCENARIO_ID = 'E2E-VIRTUAL-MIC-CAPTURE';
export const VIRTUAL_MIC_RELEASE_EMITTER_ID = 'omni-virtual-mic-release-evidence';
export const VIRTUAL_MIC_RELEASE_EMITTER_VERSION = '0.1.0';
export const VIRTUAL_MIC_RELEASE_RUNNER = 'scripts/testing/run-virtual-mic-release-evidence.mjs';
export const VIRTUAL_MIC_RELEASE_ARTIFACTS = Object.freeze([
  Object.freeze({ role: 'virtual-mic-emitter-result', path: 'emitter-result.json' }),
  Object.freeze({ role: 'virtual-mic-capture-wav', path: 'virtual-mic-capture.wav' }),
  Object.freeze({ role: 'virtual-mic-capture-probe', path: 'virtual-mic-capture-probe.json' }),
  Object.freeze({ role: 'virtual-mic-runtime-snapshot', path: 'runtime-snapshot.json' }),
]);
export const VIRTUAL_MIC_RELEASE_TIMELINE = Object.freeze([
  'build-started',
  'build-completed',
  'binaries-verified',
  'collector-started',
  'collector-completed',
  'raw-evidence-verified',
  'invocation-completed',
]);
export const VIRTUAL_MIC_FROZEN_RELEASE_TIMELINE = Object.freeze([
  'frozen-runtime-verification-started',
  'frozen-runtime-verified',
  ...VIRTUAL_MIC_RELEASE_TIMELINE.slice(2),
]);

export const sha256File = (candidate) => crypto
  .createHash('sha256')
  .update(fs.readFileSync(candidate))
  .digest('hex');

export const fileReceipt = (candidate, relativePath) => ({
  path: relativePath,
  sha256: sha256File(candidate),
  fileCount: 1,
  byteCount: fs.statSync(candidate).size,
});

const positiveInteger = (value) => Number.isInteger(Number(value)) && Number(value) > 0;
const validTimestamp = (value, now, maxAgeMs) => {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) && parsed <= now + 5 * 60_000 && now - parsed <= maxAgeMs;
};

const canonicalBinaries = (workspaceRoot) => ({
  collector: path.join(
    path.resolve(workspaceRoot),
    'target',
    'release',
    'omni-virtual-mic-target-capture.exe',
  ),
  bridge: path.join(
    path.resolve(workspaceRoot),
    'target',
    'release',
    'omni-bridge-service.exe',
  ),
});

export function validateVirtualMicReleaseEmitter(
  root,
  {
    workspaceRoot = repoRoot,
    implementationRoot = repoRoot,
    currentProvenance,
    now = Date.now(),
    maxAgeMs = 14 * 24 * 60 * 60 * 1000,
  } = {},
) {
  const result = readJson(path.join(root, 'emitter-result.json'));
  const probe = readJson(path.join(root, 'virtual-mic-capture-probe.json'));
  const issues = [];
  if (fs.existsSync(path.join(root, 'release-failure.json'))) {
    issues.push('virtual microphone invocation has retained failure evidence');
  }
  if (
    result?.schemaVersion !== 1
    || result?.artifactKind !== 'virtual-mic-release-evidence-emitter-result'
    || result?.collectorId !== VIRTUAL_MIC_RELEASE_EMITTER_ID
    || result?.collectorVersion !== VIRTUAL_MIC_RELEASE_EMITTER_VERSION
    || result?.scenarioId !== VIRTUAL_MIC_RELEASE_SCENARIO_ID
    || result?.status !== 'completed'
    || result?.error != null
  ) issues.push('virtual microphone emitter result identity/status is invalid');
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(result?.invocationId ?? ''))) {
    issues.push('virtual microphone emitter invocationId must be a UUID');
  }
  const provenanceShape = gitProvenanceShapeFailure(result?.provenance, 'virtual microphone emitter provenance');
  if (provenanceShape) issues.push(provenanceShape);
  if (currentProvenance) {
    const mismatch = exactGitProvenanceFailure(result?.provenance, currentProvenance, {
      recordedSubject: 'virtual microphone emitter provenance',
      currentSubject: 'current checkout provenance',
    });
    if (mismatch) issues.push(mismatch);
  }
  if (
    String(result?.sourceHeadCommit ?? '').toLowerCase()
      !== String(currentProvenance?.headCommit ?? '').toLowerCase()
    || String(result?.sourceHeadCommit ?? '').toLowerCase()
      !== String(result?.provenance?.headCommit ?? '').toLowerCase()
  ) issues.push('virtual microphone emitter sourceHeadCommit must match the current exact clean HEAD');
  for (const [value, subject] of [
    [result?.startedAt, 'startedAt'],
    [result?.completedAt, 'completedAt'],
  ]) {
    if (!validTimestamp(value, Number(now), Number(maxAgeMs))) {
      issues.push(`virtual microphone emitter ${subject} is invalid or stale`);
    }
  }
  const startedAt = Date.parse(String(result?.startedAt ?? ''));
  const completedAt = Date.parse(String(result?.completedAt ?? ''));
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    issues.push('virtual microphone emitter timestamps are out of order');
  }
  const canonical = canonicalBinaries(workspaceRoot);
  for (const [role, expectedPath] of Object.entries(canonical)) {
    const binary = result?.binaries?.[role];
    if (path.resolve(String(binary?.path ?? '')) !== path.resolve(expectedPath)) {
      issues.push(`virtual microphone ${role} executable must use the canonical target/release path`);
      continue;
    }
    if (!fs.existsSync(expectedPath) || !fs.statSync(expectedPath).isFile()) {
      issues.push(`virtual microphone canonical ${role} executable is missing`);
      continue;
    }
    if (binary?.sha256 !== sha256File(expectedPath)) {
      issues.push(`virtual microphone ${role} executable SHA-256 does not match current bytes`);
    }
    if (String(binary?.buildCommit ?? '').toLowerCase() !== String(result?.sourceHeadCommit ?? '').toLowerCase()) {
      issues.push(`virtual microphone ${role} build commit does not match sourceHeadCommit`);
    }
    if (!positiveInteger(binary?.processId)) {
      issues.push(`virtual microphone ${role} processId must be positive`);
    }
  }
  if (
    Number(result?.binaries?.collector?.processId) !== Number(probe?.parentCollectorProcessId)
    || Number(result?.binaries?.bridge?.processId) !== Number(probe?.bridgeProcessId)
  ) issues.push('virtual microphone emitter binary PIDs do not match raw collector/Bridge authority');
  for (const field of [
    'captureChildProcessId',
    'bridgeInstanceId',
    'bridgeSessionId',
    'captureEndpointId',
    'captureEndpointName',
    'cueId',
  ]) {
    if (JSON.stringify(result?.rawAuthority?.[field]) !== JSON.stringify(probe?.[field])) {
      issues.push(`virtual microphone emitter rawAuthority.${field} does not match the native probe`);
    }
  }
  const expectedArtifacts = VIRTUAL_MIC_RELEASE_ARTIFACTS
    .filter((artifact) => artifact.path !== 'emitter-result.json')
    .map((artifact) => fileReceipt(path.join(root, artifact.path), artifact.path));
  if (JSON.stringify(result?.rawArtifacts) !== JSON.stringify(expectedArtifacts)) {
    issues.push('virtual microphone emitter raw artifact hashes/sizes do not match the fixed native payload');
  }
  const runnerPath = path.resolve(implementationRoot, ...VIRTUAL_MIC_RELEASE_RUNNER.split('/'));
  if (
    result?.runner?.path !== VIRTUAL_MIC_RELEASE_RUNNER
    || !fs.existsSync(runnerPath)
    || result?.runner?.sha256 !== sha256File(runnerPath)
  ) issues.push('virtual microphone emitter runner path/hash is not the current official runner');
  if (
    result?.collectorInvocation?.exitCode !== 0
    || result?.collectorInvocation?.passed !== true
    || result?.collectorInvocation?.cueId !== probe?.cueId
    || result?.collectorInvocation?.captureEndpointId !== probe?.captureEndpointId
  ) issues.push('virtual microphone native collector invocation is not bound to the raw result');
  const timeline = Array.isArray(result?.timeline) ? result.timeline : [];
  const frozen = result?.runtimeMode === 'frozen';
  if (result?.runtimeMode !== undefined && !frozen) {
    issues.push('virtual microphone runtimeMode is unsupported');
  }
  if (frozen || result?.frozenVirtualMicRuntime !== undefined) {
    if (!frozen || result?.frozenVirtualMicRuntime === undefined) {
      issues.push('virtual microphone frozen mode and authority binding must occur together');
    }
    try {
      const binding = revalidateFrozenVirtualMicAuthority(result?.frozenVirtualMicRuntime, {
        workspaceRoot, provenance: currentProvenance,
      });
      if (binding.headCommit !== result?.sourceHeadCommit) {
        issues.push('virtual microphone frozen authority HEAD does not match emitter');
      }
      for (const role of ['collector', 'bridge']) {
        if (binding.binaries[role].sha256 !== result?.binaries?.[role]?.sha256) {
          issues.push('virtual microphone frozen ' + role + ' hash does not match emitter');
        }
      }
    } catch (error) {
      issues.push('virtual microphone frozen authority invalid: ' + error.message);
    }
  }
  const expectedTimeline = frozen ? VIRTUAL_MIC_FROZEN_RELEASE_TIMELINE : VIRTUAL_MIC_RELEASE_TIMELINE;
  let previous = -Infinity;
  if (timeline.length !== expectedTimeline.length) {
    issues.push('virtual microphone emitter timeline length is invalid');
  } else {
    for (const [index, expectedEvent] of expectedTimeline.entries()) {
      const event = timeline[index];
      const observedAt = Date.parse(String(event?.observedAt ?? ''));
      if (
        event?.event !== expectedEvent
        || event?.invocationId !== result?.invocationId
        || Number(event?.sequence) !== index + 1
        || !Number.isFinite(observedAt)
        || observedAt < previous
      ) {
        issues.push('virtual microphone emitter timeline is not exact, bound, and ordered');
        break;
      }
      previous = observedAt;
    }
  }
  return {
    issues: [...new Set(issues)],
    result,
    evidenceTimes: [result?.startedAt, result?.completedAt],
  };
}
