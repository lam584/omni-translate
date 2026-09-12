import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import { verifyStrictRuntimeAuthority } from './watch-mode-strict-runtime-authority.mjs';
import { fileAuthorityEntry } from './watch-mode-evidence-authority.mjs';

const VERIFIER_PATH = 'scripts/testing/frozen-virtual-mic-release-authority.mjs';
const BINARY_PATHS = Object.freeze({
  collector: 'target/release/omni-virtual-mic-target-capture.exe',
  bridge: 'target/release/omni-bridge-service.exe',
});

// Public binding only: never copy private signing keys into the manual package.
// This is not a substitute for rechecking the complete strict authority.
export function resolveFrozenVirtualMicAuthority({
  runtimeAuthority,
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
} = {}) {
  if (typeof runtimeAuthority !== 'string' || !runtimeAuthority.trim()) {
    throw new Error('--runtime-authority must name a strict runtime authority file');
  }
  const verified = verifyStrictRuntimeAuthority(runtimeAuthority, { workspaceRoot, provenance });
  const binaries = {};
  for (const [role, relativePath] of Object.entries(BINARY_PATHS)) {
    const entry = verified.authority.runtimeBinaryHashes.find((item) => item.path === relativePath);
    if (!entry) throw new Error('frozen virtual microphone runtime is missing canonical ' + role);
    binaries[role] = { ...entry };
  }
  return {
    schemaVersion: 1,
    authorityPath: path.relative(workspaceRoot, verified.authorityPath).replaceAll('\\', '/'),
    authorityDigest: verified.authority.authorityDigest,
    headCommit: verified.authority.provenance.headCommit,
    binaries,
    verifier: fileAuthorityEntry(path.join(workspaceRoot, VERIFIER_PATH), VERIFIER_PATH),
  };
}

export function revalidateFrozenVirtualMicAuthority(binding, {
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
} = {}) {
  const current = resolveFrozenVirtualMicAuthority({
    runtimeAuthority: binding?.authorityPath, workspaceRoot, provenance,
  });
  if (!isDeepStrictEqual(binding, current)) {
    throw new Error('frozen virtual microphone release authority binding changed');
  }
  return current;
}
