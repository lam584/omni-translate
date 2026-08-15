import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LOCAL_ISOLATION_CELLS } from './watch-mode-balanced-release-plan.mjs';
import { SHARD_ORCHESTRATION_IMPLEMENTATION_FILES } from './watch-mode-shard-authority.mjs';
import {
  buildLocalIsolationRuntime,
  createLocalIsolationMatrixDirectory,
  localIsolationRuntimeInventory,
  LOCAL_ISOLATION_REUSE_ALLOWED_PATHS,
  LOCAL_ISOLATION_REUSE_GITATTRIBUTES_LINES,
  LOCAL_ISOLATION_REUSE_MODE,
  LOCAL_ISOLATION_REUSABLE_LEGACY_PLAN_IDS,
  LOCAL_ISOLATION_RUNTIME_BINARY_PATHS,
  paidOnlyCargoLockReuseFailure,
  runLocalIsolationProbeIteration,
  reusableLocalIsolationAuthorityFailure,
  runLocalIsolationCell,
  signedOrchestrationGitAttributesReuseFailure,
} from './watch-mode-local-isolation.mjs';

const hashes = [];
const provenance = {
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: 'a'.repeat(40),
  worktreeClean: true,
  dirtyEntryCount: 0,
};

test('only known plans with identical zero-provider cells may reuse local authority', () => {
  assert.deepEqual(LOCAL_ISOLATION_REUSABLE_LEGACY_PLAN_IDS, [
    'watch-mode-balanced-v2',
    'watch-mode-balanced-v4',
    'watch-mode-balanced-v5',
  ]);
});

test('provider-only credential decoding is explicitly outside the zero-provider isolation layer', () => {
  assert.equal(
    LOCAL_ISOLATION_REUSE_ALLOWED_PATHS.includes(
      'apps/desktop/src-tauri/src/storage/credential.rs',
    ),
    true,
  );
  assert.equal(LOCAL_ISOLATION_CELLS.every((cell) => cell.providerMode === 'disabled'), true);
});

test('Desktop product reuse scope is exactly the explicitly audited paid-only paths', () => {
  assert.deepEqual(
    LOCAL_ISOLATION_REUSE_ALLOWED_PATHS.filter((entryPath) => (
      entryPath.startsWith('apps/desktop/src-tauri/src/')
    )).sort(),
    [
      'apps/desktop/src-tauri/src/audio/engine/bridge_source_io.rs',
      'apps/desktop/src-tauri/src/audio/engine/mod.rs',
      'apps/desktop/src-tauri/src/audio/engine/workers.rs',
      'apps/desktop/src-tauri/src/audio/omni/audio_pump.rs',
      'apps/desktop/src-tauri/src/audio/omni/connection_coordinator.rs',
      'apps/desktop/src-tauri/src/audio/omni/mod.rs',
      'apps/desktop/src-tauri/src/audio/omni/protocol.rs',
      'apps/desktop/src-tauri/src/audio/omni/provider_input_budget.rs',
      'apps/desktop/src-tauri/src/audio/omni/replay_tests.rs',
      'apps/desktop/src-tauri/src/audio/omni/session_worker.rs',
      'apps/desktop/src-tauri/src/audio/omni/session_worker/reconnect.rs',
      'apps/desktop/src-tauri/src/audio/omni/socket_event_processor.rs',
      'apps/desktop/src-tauri/src/audio/omni/translated_pcm_authority.rs',
      'apps/desktop/src-tauri/src/diagnostics/events.rs',
      'apps/desktop/src-tauri/src/provider/contracts.rs',
      'apps/desktop/src-tauri/src/provider/events.rs',
      'apps/desktop/src-tauri/src/provider/gateway_parts/probe.rs',
      'apps/desktop/src-tauri/src/provider/gateway_parts/transport.rs',
      'apps/desktop/src-tauri/src/provider/state.rs',
      'apps/desktop/src-tauri/src/release_evidence_diagnostic.rs',
      'apps/desktop/src-tauri/src/release_evidence_diagnostic/artifacts.rs',
      'apps/desktop/src-tauri/src/release_evidence_diagnostic/provider_preflight_authority.rs',
      'apps/desktop/src-tauri/src/release_evidence_diagnostic/provider_selection.rs',
      'apps/desktop/src-tauri/src/storage/credential.rs',
      'apps/desktop/src-tauri/src/watch_mode_diagnostic/config.rs',
      'apps/desktop/src-tauri/src/watch_mode_diagnostic/tests.rs',
    ],
  );
});

test('all non-Desktop paid orchestration and metadata reuse paths are explicitly audited', () => {
  for (const entryPath of [
    'AGENTS.md',
    'apps/desktop/src-tauri/Cargo.toml',
    'apps/desktop/src-tauri/build.rs',
    'apps/desktop/src/pages/providers/ProviderCatalogComponents.test.tsx',
    'apps/desktop/src/runtime/preview-desktop-api.ts',
    'apps/desktop/src/schema/generated/provider-runtime.ts',
    'apps/desktop/src/utils/provider-probe.test.ts',
    'docs/项目/Watch Mode 短 CJK 回声拦截与 AEC 迭代方案.md',
    'docs/项目/测试与质量门禁.md',
    'scripts/development/build-desktop-release.mjs',
    'scripts/testing/collect-watch-mode-interactive-process-authority.ps1',
    'scripts/testing/invoke-watch-mode-interactive-task.ps1',
    'scripts/testing/real-device-audio-release-evidence-test-helpers.mjs',
    'scripts/testing/real-device-audio-release-evidence.test.mjs',
    'scripts/testing/run-quality-gate.test.mjs',
    'scripts/testing/run-watch-mode-interactive-task.ps1',
    'scripts/testing/run-watch-mode-incident-plus.mjs',
    'scripts/testing/watch-mode-canonical-source-authority.mjs',
    'scripts/testing/watch-mode-canonical-source-authority.test.mjs',
    'scripts/testing/watch-mode-incident-plus-authority.test.mjs',
    'scripts/testing/watch-mode-provider-preflight-authorization.mjs',
  ]) {
    assert.equal(LOCAL_ISOLATION_REUSE_ALLOWED_PATHS.includes(entryPath), true, entryPath);
  }
});

test('Cargo.lock reuse allows only the paid Desktop ring dependency edge', () => {
  const source = `version = 4

[[package]]
name = "omni-bridge-service"
version = "0.1.0"
checksum = "${'a'.repeat(64)}"
dependencies = [
 "serde",
]

[[package]]
name = "omni-desktop-shell"
version = "0.1.0"
dependencies = [
 "reqwest",
 "rodio",
]
`;
  const current = source.replace(' "rodio",', ' "reqwest",\n "ring",\n "rodio",')
    .replace(' "reqwest",\n "reqwest",', ' "reqwest",');
  assert.equal(paidOnlyCargoLockReuseFailure({ sourceText: source, currentText: current }), null);
  assert.match(
    paidOnlyCargoLockReuseFailure({
      sourceText: source,
      currentText: current.replace(' "serde",', ' "serde",\n "sha2",'),
    }),
    /changed outside/,
  );
  assert.match(
    paidOnlyCargoLockReuseFailure({
      sourceText: source,
      currentText: source.replace(' "serde",', ' "serde",\n "ring",'),
    }),
    /newly added omni-desktop-shell ring dependency/,
  );
  assert.match(
    paidOnlyCargoLockReuseFailure({
      sourceText: source,
      currentText: current.replace(`checksum = "${'a'.repeat(64)}"`, `checksum = "${'b'.repeat(64)}"`),
    }),
    /changed outside/,
  );
  assert.equal(LOCAL_ISOLATION_REUSE_ALLOWED_PATHS.includes('Cargo.lock'), false);
});

test('attributes and signed authority files have exact LF rules without a path-only reuse exception', () => {
  const shardRules = ['.gitattributes text eol=lf', ...SHARD_ORCHESTRATION_IMPLEMENTATION_FILES.map(
    (entryPath) => `${entryPath} text eol=lf`,
  )];
  const expected = LOCAL_ISOLATION_REUSE_GITATTRIBUTES_LINES;
  assert.deepEqual(expected.slice(0, shardRules.length), shardRules);
  assert.equal(expected.length, 20);
  assert.equal(LOCAL_ISOLATION_REUSE_ALLOWED_PATHS.includes('.gitattributes'), false);
  const attributes = fs.readFileSync(path.join(process.cwd(), '.gitattributes'), 'utf8');
  const lines = attributes.split('\n').filter(Boolean);
  for (const rule of expected) {
    assert.equal(lines.filter((line) => line === rule).length, 1, rule);
  }
});

test('.gitattributes reuse allows only appending the fixed LF rules', () => {
  const source = [
    'drivers/windows-virtual-mic/sysvad/** linguist-vendored',
    'drivers/windows-virtual-mic/package/driver-package.json text eol=lf',
    '',
  ].join('\n');
  const additions = `${LOCAL_ISOLATION_REUSE_GITATTRIBUTES_LINES.join('\n')}\n`;
  const current = source + additions;
  assert.equal(
    signedOrchestrationGitAttributesReuseFailure({ sourceText: source, currentText: current }),
    null,
  );
  assert.match(
    signedOrchestrationGitAttributesReuseFailure({
      sourceText: source,
      currentText: current.replace(
        LOCAL_ISOLATION_REUSE_GITATTRIBUTES_LINES[0],
        `${LOCAL_ISOLATION_REUSE_GITATTRIBUTES_LINES[0]} linguist-generated`,
      ),
    }),
    /only the exact fixed/,
  );
  assert.match(
    signedOrchestrationGitAttributesReuseFailure({
      sourceText: source,
      currentText: `${current}docs/** text eol=lf\n`,
    }),
    /only the exact fixed/,
  );
  assert.match(
    signedOrchestrationGitAttributesReuseFailure({
      sourceText: source,
      currentText: current.replace(`${LOCAL_ISOLATION_REUSE_GITATTRIBUTES_LINES[1]}\n`, ''),
    }),
    /only the exact fixed/,
  );
  assert.match(
    signedOrchestrationGitAttributesReuseFailure({
      sourceText: source,
      currentText: current.replace(
        LOCAL_ISOLATION_REUSE_GITATTRIBUTES_LINES[2],
        LOCAL_ISOLATION_REUSE_GITATTRIBUTES_LINES[2].replace('eol=lf', 'eol=crlf'),
      ),
    }),
    /only the exact fixed/,
  );
  assert.match(
    signedOrchestrationGitAttributesReuseFailure({
      sourceText: source,
      currentText: current.replace(`${source.split('\n')[0]}\n`, ''),
    }),
    /only the exact fixed/,
  );
  assert.match(
    signedOrchestrationGitAttributesReuseFailure({
      sourceText: source + `${LOCAL_ISOLATION_REUSE_GITATTRIBUTES_LINES[0]}\n`,
      currentText: current,
    }),
    /contain none of the new LF rules/,
  );
});

test('verifier regression tests are explicit orchestration-only reuse changes', () => {
  assert.equal(
    LOCAL_ISOLATION_REUSE_ALLOWED_PATHS.includes(
      'scripts/testing/verify-watch-mode-evidence.test.mjs',
    ),
    true,
  );
});

test('paid shard/coordinator implementations are explicit zero-provider reuse exclusions', () => {
  for (const entryPath of [
    'scripts/testing/run-watch-mode-live-coordinator.mjs',
    'scripts/testing/run-watch-mode-live-coordinator.test.mjs',
    'scripts/testing/run-watch-mode-live-production-coordinator.mjs',
    'scripts/testing/run-watch-mode-live-production-coordinator.test.mjs',
    'scripts/testing/release-manual-collector.mjs',
    'scripts/testing/watch-mode-provider-preflight-authority.mjs',
    'scripts/testing/run-watch-mode-live-shard.mjs',
    'scripts/testing/run-watch-mode-live-shard.test.mjs',
    'scripts/testing/watch-mode-shard-authority.mjs',
    'scripts/testing/watch-mode-shard-authority.test.mjs',
  ]) {
    assert.equal(LOCAL_ISOLATION_REUSE_ALLOWED_PATHS.includes(entryPath), true, entryPath);
  }
});

test('local isolation creates its output root on a first clean-machine run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-isolation-root-'));
  const matrixDirectory = path.join(root, 'missing-parent', 'matrix');
  createLocalIsolationMatrixDirectory(matrixDirectory);
  assert.equal(fs.statSync(matrixDirectory).isDirectory(), true);
  assert.throws(
    () => createLocalIsolationMatrixDirectory(matrixDirectory),
    /EEXIST/,
  );
});

test('standalone local isolation rebuilds Bridge and driver from the exact clean HEAD', () => {
  const calls = [];
  let recordedAecGate = null;
  let removedRelease = null;
  buildLocalIsolationRuntime({
    workspaceRoot: process.cwd(),
    provenance,
    provenanceReader: () => provenance,
    runtimeHashesReader: () => [],
    recordAecGate: (result) => {
      recordedAecGate = result;
    },
    removeRuntimeRelease: (releasePath) => {
      removedRelease = releasePath;
    },
    run: (command, args, options) => {
      calls.push({ command, args, target: options.env.CARGO_TARGET_DIR });
      return { status: 0 };
    },
  });
  const npmPrefix = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd'] : [];
  assert.deepEqual(calls.map(({ args }) => args), [
    [...npmPrefix, 'run', 'test:aec3-msvc'],
    [...npmPrefix, 'run', 'build:desktop-shell'],
    [...npmPrefix, 'run', 'build:bridge-service-native'],
    [...npmPrefix, 'run', 'driver:build-sysvad'],
    ['build', '--manifest-path', 'scripts/diagnostics/omni-realtime/Cargo.toml'],
  ]);
  assert.equal(
    calls[0].target,
    path.join(process.cwd(), 'target', 'local-isolation-aec-gate'),
  );
  assert.ok(calls.slice(1).every(({ target }) => target === path.join(process.cwd(), 'target')));
  assert.deepEqual(recordedAecGate, { status: 0 });
  assert.equal(removedRelease, path.join(process.cwd(), 'target', 'release'));
});

test('local isolation cell records five minutes and zero provider calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-isolation-'));
  let clock = Date.parse('2026-08-11T00:00:00.000Z');
  const cell = LOCAL_ISOLATION_CELLS[0];
  const result = await runLocalIsolationCell({
    cell,
    profile: {
      profileId: 'default-speaker',
      deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: 'default',
      expectedPhysicalPlaybackDeviceName: '',
    },
    outputRoot: root,
    provenance,
    implementationHashes: hashes,
    runtimeBinaryHashes: hashes,
    now: () => clock,
    runIteration: ({ cellDirectory, iteration }) => {
      const directory = path.join(cellDirectory, 'iterations', String(iteration).padStart(4, '0'));
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'result.json'), '{"passed":true}\n', 'utf8');
      clock += 60_000;
    },
  });
  assert.equal(result.providerCalls, 0);
  assert.equal(result.durationMs, 300_000);
  assert.equal(result.iterationCount, 5);
});

test('local isolation cell refuses a clock that does not reach its duration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-isolation-short-'));
  let calls = 0;
  await assert.rejects(
    runLocalIsolationCell({
      cell: { ...LOCAL_ISOLATION_CELLS[0], durationSeconds: 1 },
      profile: {
        profileId: 'default-speaker',
        deviceClass: 'default-speaker',
        physicalPlaybackDeviceId: 'default',
        expectedPhysicalPlaybackDeviceName: '',
      },
      outputRoot: root,
      provenance,
      implementationHashes: hashes,
      runtimeBinaryHashes: hashes,
      now: () => (calls === 0 ? 1_000 : 1_500),
      runIteration: () => { calls += 1; throw new Error('probe failed'); },
    }),
    /probe failed/,
  );
});

test('local isolation retries only transient WASAPI endpoint creation failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-local-isolation-retry-'));
  const cellDirectory = path.join(root, 'cell');
  const calls = [];
  const waits = [];
  const result = runLocalIsolationProbeIteration({
    cell: LOCAL_ISOLATION_CELLS[0],
    profile: {
      profileId: 'default-speaker',
      deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: 'default',
      expectedPhysicalPlaybackDeviceName: 'Speaker',
    },
    cellDirectory,
    iteration: 1,
    workspaceRoot: root,
    waitForRetry: (delayMs) => waits.push(delayMs),
    run: () => {
      calls.push('probe');
      if (calls.length === 1) {
        return {
          exitCode: 1,
          stdout: '{"passed":false,"detail":"Windows returned an error: 0x8889000F"}\n',
          stderr: '',
          error: null,
        };
      }
      return {
        exitCode: 0,
        stdout: '{"passed":true,"resolvedPhysicalPlaybackDeviceName":"Speaker"}\n',
        stderr: '',
        error: null,
      };
    },
  });
  assert.deepEqual(calls, ['probe', 'probe']);
  assert.deepEqual(waits, [750]);
  assert.equal(result.probes[0].attempts, 2);
  assert.equal(
    fs.existsSync(path.join(cellDirectory, 'iterations', '0001', 'process-exclusion.attempt-1.stdout.log')),
    true,
  );
});

test('local isolation reuse is explicit and cannot silently fall back to exact reuse', () => {
  const failure = reusableLocalIsolationAuthorityFailure({
    manifest: { provenance },
    provenance,
    implementationHashes: [],
    runtimeBinaryHashes: [],
    reuseAuthority: { mode: 'unexpected' },
    workspaceRoot: process.cwd(),
  });
  assert.match(failure, /reuse mode must be orchestration-only/);
});

test('local isolation reuse accepts the exact clean HEAD with identical implementation authority', () => {
  const runtimeBinaryHashes = LOCAL_ISOLATION_RUNTIME_BINARY_PATHS.map((entryPath, index) => ({
    path: entryPath,
    bytes: index + 1,
    sha256: String(index + 1).padStart(64, '0'),
  }));
  const implementationHashes = [{
    path: 'scripts/testing/watch-mode-local-isolation.mjs',
    bytes: 10,
    sha256: 'a'.repeat(64),
  }];
  const failure = reusableLocalIsolationAuthorityFailure({
    manifest: {
      provenance,
      implementationHashes,
      runtimeBinaryHashes,
    },
    provenance,
    implementationHashes,
    runtimeBinaryHashes,
    reuseAuthority: {
      mode: LOCAL_ISOLATION_REUSE_MODE,
      sourceCommit: provenance.headCommit,
      verifiedCommit: provenance.headCommit,
      changedPaths: [],
      sourceRuntimeBinaryHashes: runtimeBinaryHashes,
      currentRuntimeBinaryHashes: runtimeBinaryHashes,
    },
    workspaceRoot: process.cwd(),
  });
  assert.equal(failure, null);
});

test('local isolation runtime scope excludes Desktop and paid-only media injector binaries', () => {
  const local = [
    { path: 'target/release/omni-bridge-service.exe', bytes: 1, sha256: 'a' },
    { path: 'target/release/omni-physical-output-probe.exe', bytes: 2, sha256: 'b' },
  ];
  const scoped = localIsolationRuntimeInventory([
    ...local,
    { path: 'target/release/omni-watch-media-injector.exe', bytes: 3, sha256: 'c' },
    { path: 'target/release/omni-desktop-shell.exe', bytes: 4, sha256: 'd' },
  ]);
  assert.deepEqual(scoped, local);
});
