import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { repoRoot } from '../lib/testing-common.mjs';
import { createVm3TestEnvironment } from './run-with-vm3-test-environment.mjs';

test('VM3 Watch test environment keeps disposable paths on the workspace volume', () => {
  const temporaryRoot = path.join(repoRoot, 'artifacts', 'testing', 'temp', 'unit-test');
  const environment = createVm3TestEnvironment({
    baseEnvironment: { KEEP_ME: 'yes', TEMP: 'C:\\old-temp' },
    temporaryRoot,
  });

  assert.equal(environment.KEEP_ME, 'yes');
  assert.equal(environment.TEMP, temporaryRoot);
  assert.equal(environment.TMP, temporaryRoot);
  assert.equal(environment.TMPDIR, temporaryRoot);
  assert.equal(environment.NPM_CONFIG_CACHE, path.join(repoRoot, 'artifacts', 'testing', 'temp', 'npm-cache'));
  assert.equal(environment.CARGO_HOME, path.join(repoRoot, 'artifacts', 'testing', 'cargo-home'));
  assert.equal(environment.CARGO_TARGET_DIR, path.join(repoRoot, 'target'));
  for (const value of [environment.TEMP, environment.TMP, environment.TMPDIR, environment.NPM_CONFIG_CACHE, environment.CARGO_HOME, environment.CARGO_TARGET_DIR]) {
    assert.ok(value.startsWith(repoRoot), `${value} must be on the workspace volume`);
  }
});

test('elevated Watch and driver wrappers reset the VM3 temporary environment', () => {
  for (const relativePath of [
    'scripts/testing/run-elevated-watch-mode-live.ps1',
    'scripts/testing/run-elevated-driver.ps1',
  ]) {
    const script = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    for (const variableName of ['TEMP', 'TMP', 'TMPDIR', 'NPM_CONFIG_CACHE', 'CARGO_HOME', 'CARGO_TARGET_DIR']) {
      assert.match(script, new RegExp(`\\$env:${variableName}\\s*=`, 'u'), `${relativePath} must set ${variableName}`);
    }
    assert.match(script, /artifacts\\testing\\temp/u);
  }
});
