import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  WATCH_DISK_MAX_DIRECTORIES_PER_ROOT,
  WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME,
  runWatchDiskLifecycle,
} from './watch-mode-disk-lifecycle.mjs';

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-disk-lifecycle-'));
  const root = path.join(parent, 'history');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root };
}

function addRun(root, name, order, bytes = 16) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ executionId: name }));
  fs.writeFileSync(path.join(directory, 'evidence.bin'), Buffer.alloc(bytes, order));
  const timestamp = new Date(1_700_000_000_000 + order * 1000);
  fs.utimesSync(directory, timestamp, timestamp);
  return directory;
}

const roomyDisk = () => ({ bavail: BigInt(WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME + 1), bsize: 1n });

test('retains only the newest 30 direct execution directories and deletes whole directories', (t) => {
  const { root } = fixture(t);
  for (let index = 0; index < 35; index += 1) addRun(root, `run-${String(index).padStart(2, '0')}`, index);
  const receipt = runWatchDiskLifecycle({ historicalRoots: [root], statfs: roomyDisk });
  assert.equal(receipt.deletedDirectories.length, 5);
  assert.deepEqual(receipt.deletedDirectories.map((entry) => entry.executionId), ['run-00', 'run-01', 'run-02', 'run-03', 'run-04']);
  assert.equal(receipt.retainedDirectories.length, WATCH_DISK_MAX_DIRECTORIES_PER_ROOT);
  assert.equal(fs.existsSync(path.join(root, 'run-00')), false);
  assert.equal(fs.existsSync(path.join(root, 'run-34', 'manifest.json')), true);
});

test('active and protected execution IDs are never deleted even when old or above retention', (t) => {
  const { root } = fixture(t);
  for (let index = 0; index < 33; index += 1) addRun(root, `run-${String(index).padStart(2, '0')}`, index);
  const receipt = runWatchDiskLifecycle({ historicalRoots: [root], activeExecutionIds: ['run-00'], protectedExecutionIds: ['run-01'], statfs: roomyDisk });
  assert.ok(receipt.retainedDirectories.find((entry) => entry.executionId === 'run-00')?.protected);
  assert.ok(receipt.retainedDirectories.find((entry) => entry.executionId === 'run-01')?.protected);
  assert.equal(fs.existsSync(path.join(root, 'run-00', 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'run-01', 'manifest.json')), true);
});

test('protected directories inside the newest 30 do not expand the ordinary retention allowance', (t) => {
  const { root } = fixture(t);
  for (let index = 0; index < 33; index += 1) addRun(root, 'run-' + String(index).padStart(2, '0'), index);
  const receipt = runWatchDiskLifecycle({ historicalRoots: [root], protectedExecutionIds: ['run-32'], statfs: roomyDisk });
  assert.deepEqual(receipt.deletedDirectories.map((entry) => entry.executionId), ['run-00', 'run-01', 'run-02']);
  assert.equal(receipt.retainedDirectories.length, WATCH_DISK_MAX_DIRECTORIES_PER_ROOT);
});
test('low free space removes oldest unprotected directories until the 3 GiB floor is projected', (t) => {
  const { root } = fixture(t);
  addRun(root, 'old', 1, 80);
  addRun(root, 'new', 2, 80);
  let calls = 0;
  const statfs = () => ({ bavail: BigInt(calls++ === 0 ? WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME - 100 : WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME + 60), bsize: 1n });
  const receipt = runWatchDiskLifecycle({ historicalRoots: [root], statfs });
  assert.deepEqual(receipt.deletedDirectories.map((entry) => entry.executionId), ['old']);
  assert.equal(receipt.volumes[0].beforeFreeBytes, WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME - 100);
  assert.equal(receipt.volumes[0].afterFreeBytes, WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME + 60);
  assert.equal(receipt.volumes[0].releasedBytes, 160);
});

test('dry-run preserves directories and writes an exclusive JSON receipt', (t) => {
  const { parent, root } = fixture(t);
  for (let index = 0; index < 32; index += 1) addRun(root, `run-${index}`, index);
  const receiptPath = path.join(parent, 'receipt.json');
  const receipt = runWatchDiskLifecycle({ historicalRoots: [root], dryRun: true, receiptPath, statfs: roomyDisk, now: () => new Date('2026-09-12T00:00:00Z') });
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.verdict, 'dry-run');
  assert.equal(receipt.minimumFloorSatisfied, true);
  assert.equal(receipt.deletedDirectories.length, 2);
  assert.equal(fs.readdirSync(root).length, 32);
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptPath, 'utf8')), receipt);
  assert.throws(() => runWatchDiskLifecycle({ historicalRoots: [root], dryRun: true, receiptPath, statfs: roomyDisk }), /EEXIST/);
});

test('insufficient space persists an explicit failed receipt before throwing', (t) => {
  const { parent, root } = fixture(t);
  const receiptPath = path.join(parent, 'failed-receipt.json');
  const statfs = () => ({ bavail: BigInt(WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME - 1), bsize: 1n });
  assert.throws(
    () => runWatchDiskLifecycle({ historicalRoots: [root], receiptPath, statfs }),
    (error) => error?.code === 'watch.disk-space.insufficient',
  );
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.verdict, 'failed');
  assert.equal(receipt.minimumFloorSatisfied, false);
  assert.equal(receipt.failureCode, 'watch.disk-space.insufficient');
  assert.equal(receipt.violations.length, 1);
});

test('ignores files and preserves retained evidence manifests without single-file mutation', (t) => {
  const { root } = fixture(t);
  const retained = addRun(root, 'retained', 2);
  const manifestBefore = fs.readFileSync(path.join(retained, 'manifest.json'));
  fs.writeFileSync(path.join(root, 'loose.pcm'), Buffer.from('do-not-touch'));
  const receipt = runWatchDiskLifecycle({ historicalRoots: [root], statfs: roomyDisk });
  assert.equal(receipt.deletedDirectories.length, 0);
  assert.deepEqual(fs.readFileSync(path.join(retained, 'manifest.json')), manifestBefore);
  assert.equal(fs.readFileSync(path.join(root, 'loose.pcm'), 'utf8'), 'do-not-touch');
});

test('rejects duplicate resolved roots and never traverses symlinked direct children', (t) => {
  const { parent, root } = fixture(t);
  assert.throws(() => runWatchDiskLifecycle({ historicalRoots: [root, path.join(root, '.')], statfs: roomyDisk }), /distinct/);
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(outside);
  addRun(outside, 'external-run', 1);
  const link = path.join(root, 'linked-run');
  try { fs.symlinkSync(outside, link, 'junction'); } catch { return; }
  const receipt = runWatchDiskLifecycle({ historicalRoots: [root], statfs: roomyDisk });
  assert.equal(receipt.deletedDirectories.length, 0);
  assert.equal(fs.existsSync(path.join(outside, 'external-run', 'manifest.json')), true);
});

