import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance, exactGitProvenanceFailure } from './git-provenance.mjs';
import { currentAuthorityRuntimeBinaryHashes } from './watch-mode-evidence-authority.mjs';

function assertCleanCurrentHead(provenance) {
  if (provenance?.worktreeClean !== true || Number(provenance?.dirtyEntryCount) !== 0) {
    throw new Error('development smoke runtime build requires the exact clean HEAD');
  }
}

export function buildDevelopmentSmokeRuntime({
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  run = spawnSync,
  recordAecGate = () => {},
  removeRuntimeAuthorityExecutable = (executablePath) => fs.rmSync(executablePath, {
    force: true,
  }),
  runtimeArtifactExists = fs.existsSync,
  provenanceReader = () => currentGitProvenance({ cwd: workspaceRoot }),
  runtimeHashesReader = () => currentAuthorityRuntimeBinaryHashes({ workspaceRoot }),
} = {}) {
  assertCleanCurrentHead(provenance);
  const environment = { ...process.env };
  environment.CARGO_TARGET_DIR = path.join(workspaceRoot, 'target');
  environment.OMNI_BUILD_COMMIT = provenance.headCommit;
  delete environment.CARGO_BUILD_TARGET;
  // Runtime authority must be rebuilt from this exact HEAD. Remove the
  // authority executable (not the complete Cargo release graph): Cargo must
  // relink it from the current source while its dependency graph remains on
  // E: for a fingerprint-compatible VM3 preflight. Cargo still validates all
  // retained dependency inputs before linking.
  const desktopExecutable = path.join(
    workspaceRoot,
    'target',
    'release',
    'omni-desktop-shell.exe',
  );
  removeRuntimeAuthorityExecutable(desktopExecutable);
  const npm = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  for (const args of [
    // The release Desktop enables AEC3. Install and verify the pinned native
    // dependency before asking Tauri to link the authority executable.
    ['run', 'test:aec3-msvc'],
    ['run', 'build:desktop-shell'],
    ['run', 'build:bridge-service-native'],
    ['run', 'driver:build-sysvad'],
  ]) {
    const commandEnvironment = { ...environment };
    const isAecGate = args[1] === 'test:aec3-msvc';
    const aecCargoTarget = path.join(workspaceRoot, 'target', 'local-isolation-aec-gate');
    if (isAecGate) commandEnvironment.CARGO_TARGET_DIR = aecCargoTarget;
    const commandArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm.cmd', ...args]
      : args;
    let result;
    try {
      result = run(npm, commandArgs, {
        cwd: workspaceRoot,
        env: commandEnvironment,
        stdio: 'inherit',
        windowsHide: true,
      });
      if (result.error || Number(result.status) !== 0) {
        throw new Error(`local isolation runtime build failed: npm ${args.join(' ')}`);
      }
      // Tauri can return a successful wrapper exit code even when its Cargo
      // child was interrupted.  Fail immediately instead of spending time on
      // Bridge, driver, and diagnostic builds before the authority inventory
      // notices that the Desktop executable was never produced.
      if (args[1] === 'build:desktop-shell') {
        if (!runtimeArtifactExists(desktopExecutable)) {
          throw new Error(`local isolation runtime build failed: authority artifact target/release/omni-desktop-shell.exe is missing: ${desktopExecutable}`);
        }
      }
      if (isAecGate) recordAecGate(result);
    } finally {
      if (isAecGate) {
        // The gate's stdout/stderr is the evidence. Its multi-gigabyte Cargo
        // graph is not runtime authority and must be reclaimed on both pass
        // and failure before the release runtime is built.
        fs.rmSync(aecCargoTarget, { recursive: true, force: true });
      }
    }
  }
  const realtimeDiagnostic = run('cargo', [
    'build',
    '--manifest-path',
    'scripts/diagnostics/omni-realtime/Cargo.toml',
  ], {
    cwd: workspaceRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (realtimeDiagnostic.error || Number(realtimeDiagnostic.status) !== 0) {
    throw new Error('local isolation runtime build failed: omni-realtime-diagnostic');
  }
  const benchmarkDiagnostic = run('cargo', [
    'build', '--locked', '--release',
    '--manifest-path', 'scripts/diagnostics/omni-benchmark/Cargo.toml',
  ], {
    cwd: workspaceRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (benchmarkDiagnostic.error || Number(benchmarkDiagnostic.status) !== 0) {
    throw new Error('development smoke runtime build failed: omni-benchmark');
  }
  const after = provenanceReader();
  const failure = exactGitProvenanceFailure(provenance, after, {
    recordedSubject: 'local isolation pre-build provenance',
    currentSubject: 'local isolation post-build provenance',
  });
  if (failure) throw new Error(failure);
  return runtimeHashesReader();
}

