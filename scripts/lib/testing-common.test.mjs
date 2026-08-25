import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  asPositiveInteger,
  compactTimestamp,
  echoLogTail,
  ensureDir,
  isMain,
  parseCliArgs,
  readJson,
  repoRoot,
  runLoggedStep,
  sortableTimestamp,
  writeJson,
  writeText,
} from './testing-common.mjs';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'testing-common-'));

test('repoRoot points at the repository root', () => {
  assert.ok(fs.existsSync(path.join(repoRoot, 'package.json')));
  assert.ok(fs.existsSync(path.join(repoRoot, 'scripts', 'lib')));
});

test('compactTimestamp and sortableTimestamp format a fixed date', () => {
  const date = new Date(2026, 6, 27, 1, 5, 9);
  assert.equal(compactTimestamp(date), '20260727-010509');
  assert.equal(sortableTimestamp(date), '2026-07-27T01:05:09');
});

test('asPositiveInteger accepts positive integers and otherwise preserves the caller fallback', () => {
  assert.equal(asPositiveInteger(3, null), 3);
  assert.equal(asPositiveInteger('12', null), 12);
  assert.equal(asPositiveInteger(0, 250), 250);
  assert.equal(asPositiveInteger(-1, 250), 250);
  assert.equal(asPositiveInteger(1.5, 250), 250);
  assert.equal(asPositiveInteger('invalid', 0), 0);
});

test('writeText appends a trailing newline and writes without a BOM', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'nested', 'note.txt');
  writeText(filePath, 'hello');
  const bytes = fs.readFileSync(filePath);
  assert.equal(bytes[0], 0x68); // 'h', no BOM
  assert.equal(bytes.toString('utf8'), 'hello\n');
});

test('writeJson/readJson round-trip, and readJson tolerates a BOM', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'value.json');
  writeJson(filePath, { verdict: 'PASS', steps: [1, 2] });
  assert.deepEqual(readJson(filePath), { verdict: 'PASS', steps: [1, 2] });

  const bomPath = path.join(dir, 'bom.json');
  fs.writeFileSync(bomPath, '﻿{"ok":true}', 'utf8');
  assert.deepEqual(readJson(bomPath), { ok: true });
});

test('runLoggedStep tees output to the log and reports exit codes', () => {
  const dir = makeTempDir();
  const okLog = path.join(dir, 'ok.log');
  const okStatus = runLoggedStep('node -e "console.log(\'out\'); console.error(\'err\')"', okLog);
  assert.equal(okStatus, 0);
  const logged = fs.readFileSync(okLog, 'utf8');
  assert.match(logged, /out/);
  assert.match(logged, /err/);

  const failLog = path.join(dir, 'fail.log');
  const failStatus = runLoggedStep('node -e "process.exit(3)"', failLog);
  assert.equal(failStatus, 3);
});

test('echoLogTail ignores missing files', () => {
  echoLogTail(path.join(makeTempDir(), 'missing.log'));
});

test('parseCliArgs handles values, booleans, defaults, and rejects unknown shapes', () => {
  const args = parseCliArgs(
    ['--output-root', 'artifacts/x', '--skip-desktop-shell', '--dry-run'],
    { booleans: ['skip-desktop-shell', 'dry-run'], defaults: { outputRoot: 'default' } },
  );
  assert.equal(args.outputRoot, 'artifacts/x');
  assert.equal(args.skipDesktopShell, true);
  assert.equal(args.dryRun, true);

  const defaults = parseCliArgs([], { defaults: { outputRoot: 'default' } });
  assert.equal(defaults.outputRoot, 'default');

  assert.throws(() => parseCliArgs(['positional']), /Unexpected argument/);
  assert.throws(() => parseCliArgs(['--output-root'], { defaults: { outputRoot: 'x' } }), /Missing value/);
});

test('parseCliArgs rejects unknown flags and flag-shaped values', () => {
  assert.throws(
    () => parseCliArgs(['--skip-desktopshell', '--skip-bridge-service'], { booleans: ['skip-desktop-shell', 'skip-bridge-service'] }),
    /Unknown flag --skip-desktopshell/,
  );
  assert.throws(
    () => parseCliArgs(['--output-root', '--skip-desktop-shell'], {
      booleans: ['skip-desktop-shell'],
      defaults: { outputRoot: 'x' },
    }),
    /Missing value for --output-root/,
  );
  const digits = parseCliArgs(['--manual-e2e-report', 'r.md'], { defaults: { manualE2eReport: '' } });
  assert.equal(digits.manualE2eReport, 'r.md');
});

test('ensureDir returns the created path', () => {
  const dir = path.join(makeTempDir(), 'a', 'b');
  assert.equal(ensureDir(dir), dir);
  assert.ok(fs.existsSync(dir));
});

test('isMain is false for an imported module', () => {
  assert.equal(isMain(new URL('./testing-common.mjs', import.meta.url).href), false);
});
