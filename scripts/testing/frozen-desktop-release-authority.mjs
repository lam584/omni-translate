import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import { verifyStrictRuntimeAuthority } from './watch-mode-strict-runtime-authority.mjs';
import { fileAuthorityEntry } from './watch-mode-evidence-authority.mjs';

export const FROZEN_DESKTOP_SCENARIOS = Object.freeze([
  'E2E-PROVIDER-CONFIG',
  'E2E-DIAGNOSTICS-EXPORT',
  'E2E-OVERLAY-CLICK-THROUGH',
]);
const DESKTOP_PATH = 'target/release/omni-desktop-shell.exe';
const VERIFIER_PATH = 'scripts/testing/frozen-desktop-release-authority.mjs';

// A binding is public evidence, never a replacement for verifying the authority.
// Keep keys out of the manual package; verify their frozen hashes at the source.
export function resolveFrozenDesktopAuthority({
  runtimeAuthority,
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
}) {
  if (typeof runtimeAuthority !== 'string' || !runtimeAuthority.trim()) {
    throw new Error('--runtime-authority must name a strict runtime authority file');
  }
  const verified = verifyStrictRuntimeAuthority(runtimeAuthority, { workspaceRoot, provenance });
  const desktop = verified.authority.runtimeBinaryHashes.find((entry) => entry.path === DESKTOP_PATH);
  if (!desktop) throw new Error('frozen runtime is missing the canonical Desktop authority');
  return {
    schemaVersion: 1,
    authorityPath: path.relative(workspaceRoot, verified.authorityPath).replaceAll('\\', '/'),
    authorityDigest: verified.authority.authorityDigest,
    headCommit: verified.authority.provenance.headCommit,
    desktop: { ...desktop },
    verifier: fileAuthorityEntry(path.join(workspaceRoot, VERIFIER_PATH), VERIFIER_PATH),
  };
}

export function revalidateFrozenDesktopAuthority(binding, {
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  scenarioId,
} = {}) {
  if (!FROZEN_DESKTOP_SCENARIOS.includes(scenarioId)) {
    throw new Error('frozen Desktop collection supports CONFIG, DIAGNOSTICS and OVERLAY only');
  }
  const current = resolveFrozenDesktopAuthority({
    runtimeAuthority: binding?.authorityPath, workspaceRoot, provenance,
  });
  if (!isDeepStrictEqual(binding, current)) {
    throw new Error('frozen Desktop release authority binding changed');
  }
  return current;
}
