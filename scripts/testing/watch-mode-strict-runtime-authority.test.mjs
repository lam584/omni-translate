import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { strictRuntimeBuildResources } from './watch-mode-strict-runtime-authority.mjs';

const source = fs.readFileSync(new URL('./watch-mode-strict-runtime-authority.mjs', import.meta.url), 'utf8');

test('strict runtime Cargo jobs follow the fixed CPU and available-memory cap', () => {
  const jobs = (logicalProcessors, memoryGiB) => strictRuntimeBuildResources({
    logicalProcessors, availableMemoryBytes: memoryGiB * 1024 ** 3,
  }).cargoBuildJobs;
  assert.equal(jobs(32, 64), 12);
  assert.equal(jobs(8, 64), 8);
  assert.equal(jobs(32, 7), 4);
  assert.equal(jobs(1, 1), 2);
  assert.throws(() => jobs(0, 16), /resources/);
  assert.throws(() => jobs(4, 0), /resources/);
  assert.match(source, /environment\.CARGO_BUILD_JOBS = String\(buildResources\.cargoBuildJobs\)/);
});

test('strict runtime preparation creates one certificate before gates and builds', () => {
  const certificate = source.indexOf("new-local-release-certificate.ps1");
  const aec3 = source.indexOf("'test:aec3-msvc'");
  const desktop = source.indexOf("npm('run', 'build:desktop-shell')");
  const driver = source.indexOf("'build-sysvad-driver.ps1'");
  assert.ok(certificate > 0 && certificate < aec3);
  assert.ok(aec3 < desktop && desktop < driver);
  assert.equal(source.match(/new-local-release-certificate\.ps1/gu)?.length, 1);
});

test('strict runtime authority is explicitly local TESTSIGNING evidence, not public trust', () => {
  assert.match(source, /signingMode/);
  assert.match(source, /local-self-signed/);
  assert.match(source, /RSA/);
  assert.match(source, /3072/);
  assert.match(source, /SHA256/);
});

test('strict runtime freezes one coordinator signing key before Desktop compilation', () => {
  const keyGeneration = source.indexOf('generateCoordinatorSigningKeyPair()');
  const keyEnvironment = source.indexOf('OMNI_PROVIDER_PREFLIGHT_COORDINATOR_KEY_ID');
  const desktop = source.indexOf("npm('run', 'build:desktop-shell')");
  assert.ok(keyGeneration > 0 && keyGeneration < keyEnvironment && keyEnvironment < desktop);
  assert.match(source, /coordinator-signing-public\.pem/u);
  assert.match(source, /coordinator-signing-private\.pem/u);
  assert.match(source, /strict runtime coordinator signing key pair mismatch/u);
});
