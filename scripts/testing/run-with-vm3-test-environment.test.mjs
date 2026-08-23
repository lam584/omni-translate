import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { repoRoot } from '../lib/testing-common.mjs';
import {
  createVm3TestEnvironment,
  isInitializedRustupHome,
  resolveVm3TestCommand,
} from './run-with-vm3-test-environment.mjs';

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

test('Windows npm command shims execute through the current npm CLI without a shell', () => {
  const invocation = resolveVm3TestCommand({
    command: 'npm.cmd',
    argumentsToRun: ['run', 'check:desktop-shell'],
    environment: { npm_execpath: 'E:\\node\\npm-cli.js' },
    platform: 'win32',
    nodeExecutable: 'E:\\node\\node.exe',
  });

  assert.deepEqual(invocation, {
    command: 'E:\\node\\node.exe',
    argumentsToRun: ['E:\\node\\npm-cli.js', 'run', 'check:desktop-shell'],
    shell: false,
  });
});

test('CI keeps its default rustup home when the repository rustup home is uninitialized', (t) => {
  const testRoot = path.join(repoRoot, 'artifacts', 'testing', 'temp');
  fs.mkdirSync(testRoot, { recursive: true });
  const rustupHome = fs.mkdtempSync(path.join(testRoot, 'rustup-home-uninitialized-'));
  t.after(() => fs.rmSync(rustupHome, { recursive: true, force: true }));

  const environment = createVm3TestEnvironment({
    baseEnvironment: { RUSTUP_HOME: 'C:\\hostedtoolcache\\rustup' },
    temporaryRoot: path.join(testRoot, 'unit-test-ci'),
    rustupHome,
  });

  assert.equal(isInitializedRustupHome(rustupHome), false);
  assert.equal(environment.RUSTUP_HOME, 'C:\\hostedtoolcache\\rustup');

  const environmentWithoutRustupOverride = createVm3TestEnvironment({
    baseEnvironment: { CI: 'true' },
    temporaryRoot: path.join(testRoot, 'unit-test-ci-default'),
    rustupHome,
  });
  assert.equal(Object.hasOwn(environmentWithoutRustupOverride, 'RUSTUP_HOME'), false);
});

test('initialized repository rustup home remains authoritative for VM3', (t) => {
  const testRoot = path.join(repoRoot, 'artifacts', 'testing', 'temp');
  fs.mkdirSync(testRoot, { recursive: true });
  const rustupHome = fs.mkdtempSync(path.join(testRoot, 'rustup-home-initialized-'));
  t.after(() => fs.rmSync(rustupHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(rustupHome, 'settings.toml'), 'default_toolchain = "stable"\n', 'utf8');
  const binaryRoot = path.join(rustupHome, 'toolchains', 'stable-x86_64-pc-windows-msvc', 'bin');
  fs.mkdirSync(binaryRoot, {
    recursive: true,
  });
  fs.writeFileSync(path.join(binaryRoot, 'rustc.exe'), 'test compiler', 'utf8');
  fs.writeFileSync(path.join(binaryRoot, 'cargo.exe'), 'test cargo', 'utf8');

  const environment = createVm3TestEnvironment({
    baseEnvironment: { RUSTUP_HOME: 'C:\\hostedtoolcache\\rustup' },
    temporaryRoot: path.join(testRoot, 'unit-test-vm3'),
    rustupHome,
  });

  assert.equal(isInitializedRustupHome(rustupHome), true);
  assert.equal(environment.RUSTUP_HOME, rustupHome);
});

test('settings with an empty or partial toolchain keep the base rustup home', (t) => {
  const testRoot = path.join(repoRoot, 'artifacts', 'testing', 'temp');
  fs.mkdirSync(testRoot, { recursive: true });
  const rustupHome = fs.mkdtempSync(path.join(testRoot, 'rustup-home-partial-'));
  t.after(() => fs.rmSync(rustupHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(rustupHome, 'settings.toml'), 'default_toolchain = "stable"\n', 'utf8');
  const binaryRoot = path.join(rustupHome, 'toolchains', 'stable-x86_64-pc-windows-msvc', 'bin');
  fs.mkdirSync(binaryRoot, { recursive: true });

  assert.equal(isInitializedRustupHome(rustupHome), false);
  fs.writeFileSync(path.join(binaryRoot, 'rustc.exe'), 'partial compiler', 'utf8');
  assert.equal(isInitializedRustupHome(rustupHome), false);

  const environment = createVm3TestEnvironment({
    baseEnvironment: { RUSTUP_HOME: 'C:\\hostedtoolcache\\rustup' },
    temporaryRoot: path.join(testRoot, 'unit-test-partial'),
    rustupHome,
  });
  assert.equal(environment.RUSTUP_HOME, 'C:\\hostedtoolcache\\rustup');
});

test('explicit VM3 rustup opt-in selects the repository home before initialization', (t) => {
  const testRoot = path.join(repoRoot, 'artifacts', 'testing', 'temp');
  fs.mkdirSync(testRoot, { recursive: true });
  const rustupHome = fs.mkdtempSync(path.join(testRoot, 'rustup-home-opt-in-'));
  t.after(() => fs.rmSync(rustupHome, { recursive: true, force: true }));

  const environment = createVm3TestEnvironment({
    baseEnvironment: {
      OMNI_VM3_USE_REPO_RUSTUP_HOME: '1',
      RUSTUP_HOME: 'C:\\hostedtoolcache\\rustup',
    },
    temporaryRoot: path.join(testRoot, 'unit-test-opt-in'),
    rustupHome,
  });

  assert.equal(environment.RUSTUP_HOME, rustupHome);
});
