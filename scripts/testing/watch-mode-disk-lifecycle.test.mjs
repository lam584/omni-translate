import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkWatchDiskSpace, WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME as floor,
  runWatchDiskLifecycle, runDefaultLocalWatchDiskLifecycle, parseWatchDiskLifecycleArgs,
  verifiedWatchPath } from './watch-mode-disk-lifecycle.mjs';

const roomy = () => ({ bavail: BigInt(floor), bsize: 1n });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-disk-check-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('3 GiB is an inclusive measured floor and both C and E are independently checked', () => {
  const paths = process.platform === 'win32' ? ['C:\\', 'E:\\'] : ['/c', '/e'];
  const calls = [];
  const result = checkWatchDiskSpace({ requiredVolumePaths: paths, statfs: (root) => { calls.push(root); return roomy(); } });
  assert.deepEqual(calls, paths);
  assert.equal(result.minimumFloorSatisfied, true);
  assert.equal(result.deletedDirectories.length, 0);
});

for (const failure of ['low', 'missing', 'invalid', 'overflow']) test(`${failure} volume warns, saves failed receipt and fails closed`, (t) => {
  const root = fixture(t);
  const warnings = [];
  const receiptPath = path.join(root, 'failure.json');
  assert.throws(() => checkWatchDiskSpace({ requiredVolumePaths: [root], receiptPath, warn: (value) => warnings.push(value),
    statfs: () => {
      if (failure === 'missing') throw new Error('E: is unavailable');
      return { bavail: failure === 'invalid' ? -1n : failure === 'overflow' ? 10n ** 30n : BigInt(floor - 1), bsize: 1n };
    } }), (error) => error.code === 'watch.disk-space.insufficient');
  assert.match(warnings[0], /WARNING.*3 GiB/u);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.verdict, 'failed');
  assert.equal(receipt.releasedBytes, 0);
});

test('legacy generic roots never prune mixed, unknown, incomplete or signed evidence even above 30', (t) => {
  const root = fixture(t);
  for (const name of ['runtime-current', '.provider-preflight', 'artifacts', 'li', ...Array.from({ length: 40 }, (_, i) => `watch-prod-${i}`)]) {
    fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'raw.pcm'), 'signed bytes');
  }
  const before = fs.readdirSync(root);
  const receipt = runWatchDiskLifecycle({ historicalRoots: [root], statfs: roomy });
  assert.equal(receipt.mode, 'check-only');
  assert.deepEqual(receipt.deletedDirectories, []);
  assert.deepEqual(fs.readdirSync(root), before);
  for (const name of before) assert.equal(fs.readFileSync(path.join(root, name, 'raw.pcm'), 'utf8'), 'signed bytes');
});

test('local default checks C and E even if workspace/history is on another volume or absent', (t) => {
  const root = fixture(t);
  const calls = [];
  runDefaultLocalWatchDiskLifecycle({ workspaceRoot: root, statfs: (value) => { calls.push(value); return roomy(); } });
  assert.deepEqual(calls, process.platform === 'win32' ? ['C:\\', 'E:\\'] : [root]);
});

test('receipts are exclusive, absolute and never follow an ancestor junction', (t) => {
  const root = fixture(t);
  const receiptPath = path.join(root, 'receipt.json');
  checkWatchDiskSpace({ receiptPath, statfs: roomy });
  assert.throws(() => checkWatchDiskSpace({ receiptPath, statfs: roomy }), /EEXIST/u);
  assert.throws(() => checkWatchDiskSpace({ receiptPath: 'relative.json', statfs: roomy }), /absolute/u);
  fs.mkdirSync(path.join(root, 'actual'));
  fs.symlinkSync(path.join(root, 'actual'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifiedWatchPath(path.join(root, 'alias')), /symlink\/reparse/u);
  assert.throws(() => checkWatchDiskSpace({ receiptPath: path.join(root, 'alias', 'unsafe.json'), statfs: roomy }), /symlink\/reparse/u);
});

test('relative roots, duplicate roots and generic apply are rejected', (t) => {
  const root = fixture(t);
  assert.throws(() => runWatchDiskLifecycle({ historicalRoots: ['relative'], statfs: roomy }), /absolute/u);
  assert.throws(() => runWatchDiskLifecycle({ historicalRoots: [root, path.join(root, '.')], statfs: roomy }), /distinct/u);
  assert.throws(() => parseWatchDiskLifecycleArgs(['--apply']), /generic FIFO apply is forbidden/u);
  assert.deepEqual(parseWatchDiskLifecycleArgs(['--check-only', '--volume', root]).requiredVolumePaths, [root]);
  assert.throws(() => parseWatchDiskLifecycleArgs(['--receipt']), /missing value/u);
});
