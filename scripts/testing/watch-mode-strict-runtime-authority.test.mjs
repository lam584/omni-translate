import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./watch-mode-strict-runtime-authority.mjs', import.meta.url), 'utf8');

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
