import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFrozenDesktopFixture } from './frozen-desktop-release-authority-test-helpers.mjs';
import { revalidateFrozenDesktopAuthority } from './frozen-desktop-release-authority.mjs';
import {
  prepareDesktopReleaseRuntime, parseDesktopReleaseEvidenceArgs,
} from './run-desktop-release-evidence.mjs';
import {
  prepareFrozenOverlayReleaseBinaries, parseOverlayClickThroughReleaseArgs,
} from './run-overlay-click-through-release-evidence.mjs';
import { currentAuthorityRuntimeBinaryHashes } from './watch-mode-evidence-authority.mjs';

const scenarioId = 'E2E-PROVIDER-CONFIG';
const fixture = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-frozen-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createFrozenDesktopFixture(root);
};

test('frozen CLI distinguishes absent authority from explicit empty authority', () => {
  for (const parse of [parseDesktopReleaseEvidenceArgs, parseOverlayClickThroughReleaseArgs]) {
    assert.equal(parse([]).runtimeAuthority, undefined);
    assert.equal(parse(['--runtime-authority', '']).runtimeAuthority, '');
    assert.equal(parse(['--runtime-authority', 'authority.json']).runtimeAuthority, 'authority.json');
    assert.throws(() => parse(['--runtime-authority']), /Missing value/);
  }
});

test('frozen Desktop preparation never builds; absent authority preserves exactly one build', (t) => {
  const f = fixture(t);
  let builds = 0;
  const build = () => { builds += 1; };
  for (const id of ['E2E-PROVIDER-CONFIG', 'E2E-DIAGNOSTICS-EXPORT']) {
    assert.deepEqual(prepareDesktopReleaseRuntime({ ...f, scenarioId: id, build }), f.frozenRuntime);
  }
  assert.equal(builds, 0);
  assert.deepEqual(currentAuthorityRuntimeBinaryHashes(f), f.authority.runtimeBinaryHashes);
  assert.equal(prepareDesktopReleaseRuntime({ ...f, scenarioId, runtimeAuthority: undefined, build }), undefined);
  assert.equal(builds, 1);
});

test('frozen invalid or empty authority cannot fall back to building', (t) => {
  const f = fixture(t);
  for (const runtimeAuthority of ['', ' ', null, false, {}, 'missing.json']) {
    assert.throws(() => prepareDesktopReleaseRuntime({
      ...f, scenarioId, runtimeAuthority,
      build() { assert.fail('invalid authority reached build'); },
    }));
  }
  assert.throws(() => prepareDesktopReleaseRuntime({
    ...f, scenarioId: 'E2E-PROVIDER-PROBE',
    build() { assert.fail('Probe reached build'); },
  }), /Probe reuse is separate/);
  assert.throws(() => prepareFrozenOverlayReleaseBinaries({ ...f, runtimeAuthority: '' }), /runtime-authority/);
});

test('frozen authority rechecks the entire inventory, keys and source rather than Desktop alone', (t) => {
  const f = fixture(t);
  const verify = () => revalidateFrozenDesktopAuthority(f.frozenRuntime, { workspaceRoot: f.workspaceRoot, scenarioId });
  for (const relative of [
    ...f.authority.runtimeBinaryHashes.map((entry) => entry.path),
    'artifacts/testing/watch-mode-strict-runtime/frozen-fixture/private.pem',
    'artifacts/testing/watch-mode-strict-runtime/frozen-fixture/public.pem',
    'artifacts/testing/watch-mode-strict-runtime/frozen-fixture/strict-runtime-authority.json',
    f.authority.implementationHashes[0].path,
    'scripts/testing/frozen-desktop-release-authority.mjs',
    'tracked-fixture.txt',
  ]) {
    const candidate = path.join(f.workspaceRoot, relative);
    const before = fs.readFileSync(candidate);
    fs.appendFileSync(candidate, 'changed');
    assert.throws(verify, undefined, relative);
    fs.writeFileSync(candidate, before);
    assert.deepEqual(verify(), f.frozenRuntime);
  }
});

test('frozen authority rejects forged bindings and other clean HEADs', (t) => {
  const f = fixture(t);
  assert.throws(() => revalidateFrozenDesktopAuthority({ ...f.frozenRuntime, authorityDigest: '0'.repeat(64) }, {
    workspaceRoot: f.workspaceRoot, scenarioId,
  }), /binding changed/);
  assert.throws(() => revalidateFrozenDesktopAuthority(f.frozenRuntime, {
    workspaceRoot: f.workspaceRoot, scenarioId,
    provenance: { ...f.provenance, headCommit: '0'.repeat(40) },
  }), /schema/);
});

test('frozen overlay refuses missing canonical target even when a fallback target exists', (t) => {
  const f = fixture(t);
  f.write('apps/desktop/src-tauri/target/release/omni-overlay-click-target.exe', 'stale fallback');
  assert.throws(() => prepareFrozenOverlayReleaseBinaries(f), /prebuilt canonical overlay target/);
  f.write('target/release/omni-overlay-click-target.exe', 'not a PE');
  assert.throws(() => prepareFrozenOverlayReleaseBinaries(f), /Windows PE/);
  assert.deepEqual(currentAuthorityRuntimeBinaryHashes(f), f.authority.runtimeBinaryHashes);
});
