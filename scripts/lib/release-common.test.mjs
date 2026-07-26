import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RELEASE_DOCS,
  bundleName,
  collectFiles,
  compressArchive,
  readCargoVersion,
  readJson,
  readText,
  releasePaths,
  repoRoot,
  sha256,
} from './release-common.mjs';

const makeTempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('repoRoot is the repository root regardless of process.cwd()', () => {
  assert.equal(path.isAbsolute(repoRoot), true);
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts', 'lib', 'release-common.mjs')), true);
  assert.equal(fs.existsSync(path.join(repoRoot, 'package.json')), true);
  assert.equal(readJson('package.json').name, 'omni-translate');
});

test('readText resolves relative paths against an explicit root directory', () => {
  const tempDir = makeTempDir('release-common-read-text-');
  fs.writeFileSync(path.join(tempDir, 'note.txt'), 'hello release', 'utf8');

  assert.equal(readText('note.txt', tempDir), 'hello release');
});

test('readJson parses a JSON file relative to the given root directory', () => {
  const tempDir = makeTempDir('release-common-read-json-');
  fs.writeFileSync(path.join(tempDir, 'sample.json'), '{"version":"1.2.3","ok":true}', 'utf8');

  assert.deepEqual(readJson('sample.json', tempDir), { version: '1.2.3', ok: true });
});

test('readCargoVersion extracts the first package version from a Cargo manifest', () => {
  const tempDir = makeTempDir('release-common-cargo-');
  fs.writeFileSync(
    path.join(tempDir, 'Cargo.toml'),
    ['[package]', 'name = "demo"', 'version = "0.9.7"', '', '[dependencies]', 'serde = { version = "1.0" }'].join('\n'),
    'utf8',
  );

  assert.equal(readCargoVersion('Cargo.toml', tempDir), '0.9.7');
});

test('readCargoVersion throws a descriptive error when no version is present', () => {
  const tempDir = makeTempDir('release-common-cargo-missing-');
  fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), '[package]\nname = "demo"\n', 'utf8');

  assert.throws(
    () => readCargoVersion('Cargo.toml', tempDir),
    /Unable to read Cargo package version from Cargo\.toml/,
  );
});

test('sha256 returns the hex digest of the file contents', () => {
  const tempDir = makeTempDir('release-common-sha256-');
  const filePath = path.join(tempDir, 'payload.bin');
  fs.writeFileSync(filePath, 'abc', 'utf8');

  // Known SHA-256 of the ASCII string "abc".
  assert.equal(sha256(filePath), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('collectFiles walks nested directories and returns files only', () => {
  const tempDir = makeTempDir('release-common-collect-');
  fs.mkdirSync(path.join(tempDir, 'nested', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'a.txt'), 'a', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'nested', 'b.txt'), 'b', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'nested', 'deeper', 'c.txt'), 'c', 'utf8');

  const files = collectFiles(tempDir).map((filePath) => path.relative(tempDir, filePath)).sort();

  assert.deepEqual(files, ['a.txt', path.join('nested', 'b.txt'), path.join('nested', 'deeper', 'c.txt')].sort());
});

test('bundleName renders the portable package base name for a version', () => {
  assert.equal(bundleName('1.2.3'), 'OmniTranslate-1.2.3-windows-x64-portable');
});

test('releasePaths derives release and installer directories from repoRoot', () => {
  const paths = releasePaths('1.2.3');

  assert.equal(paths.releaseDir, path.join(repoRoot, 'artifacts', 'release', '1.2.3'));
  assert.equal(paths.packageRoot, path.join(paths.releaseDir, 'packages'));
  assert.equal(paths.unsignedDir, path.join(paths.packageRoot, 'unsigned'));
  assert.equal(paths.signedDir, path.join(paths.packageRoot, 'signed'));
  assert.equal(paths.signingDir, path.join(paths.releaseDir, 'signing'));
  assert.equal(paths.installerLayoutDir, path.join(repoRoot, 'artifacts', 'installer', '1.2.3'));
});

test('compressArchive zips a directory into a non-empty archive', () => {
  const tempDir = makeTempDir('release-common-compress-');
  const sourceDir = path.join(tempDir, 'payload');
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, 'hello.txt'), 'hello archive', 'utf8');
  const zipPath = path.join(tempDir, 'payload.zip');

  compressArchive(sourceDir, zipPath);

  assert.equal(fs.existsSync(zipPath), true);
  assert.equal(fs.statSync(zipPath).size > 0, true);
});

test('RELEASE_DOCS lists the four project docs shipped with a release', () => {
  assert.equal(RELEASE_DOCS.length, 4);
  for (const relativeDoc of RELEASE_DOCS) {
    assert.equal(relativeDoc.startsWith(path.join('docs', '项目')), true);
    assert.equal(fs.existsSync(path.join(repoRoot, relativeDoc)), true);
  }
});
