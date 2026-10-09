import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CACHE_BUDGET_BYTES,
  DEFAULT_DISK_WARNING_BYTES,
  readIsolatedTargetMetadata,
  writeIsolatedTargetMetadata,
  checkCacheBudgetAndDiskWarning,
  sweepReusableIsolatedCaches,
} from './build-cache-lifecycle.mjs';

test('metadata read/write roundtrip and handles invalid files safely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-meta-'));
  try {
    const metaFile = path.join(dir, '.cache-metadata.json');
    assert.equal(readIsolatedTargetMetadata(metaFile), null);

    const data = { ownerPid: 12345, purpose: 'isolated-cargo-target', reusable: true, reclaimable: true };
    writeIsolatedTargetMetadata(metaFile, data);

    const loaded = readIsolatedTargetMetadata(metaFile);
    assert.deepEqual(loaded, data);

    fs.writeFileSync(metaFile, 'invalid json', 'utf8');
    assert.equal(readIsolatedTargetMetadata(metaFile), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkCacheBudgetAndDiskWarning calculates size and detects warnings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-budget-'));
  try {
    const targetA = path.join(dir, 'target-a');
    fs.mkdirSync(path.join(targetA, 'debug'), { recursive: true });
    fs.writeFileSync(path.join(targetA, 'debug', 'file.bin'), Buffer.alloc(1024 * 1024)); // 1 MiB

    let warnings = [];
    const res = checkCacheBudgetAndDiskWarning({
      targetDirectories: [targetA],
      budgetBytes: 512 * 1024, // 0.5 MiB budget -> will exceed
      warningBytes: 10 * 1024 * 1024 * 1024, // 10 GiB -> will warn for mock volume
      volumePaths: ['MOCK:\\'],
      statfs: () => ({ bavail: 1000n, bsize: 4096n }), // ~4MB free
      warn: (msg) => warnings.push(msg),
    });

    assert.equal(res.budgetExceeded, true);
    assert.equal(res.totalTargetBytes, 1024 * 1024);
    assert.equal(res.volumeWarnings.length, 1);
    assert.ok(warnings.some((w) => w.includes('Build cache budget exceeded')));
    assert.ok(warnings.some((w) => w.includes('approaching the 3 GiB floor')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepReusableIsolatedCaches reclaims dead-pid reusable targets and protects active ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-sweep-'));
  try {
    const activeDir = path.join(root, 'target-active');
    fs.mkdirSync(activeDir, { recursive: true });
    writeIsolatedTargetMetadata(path.join(activeDir, '.cache-metadata.json'), {
      ownerPid: process.pid,
      reusable: true,
      reclaimable: true,
    });
    fs.writeFileSync(path.join(activeDir, 'artifact.bin'), 'keep');

    const deadDir = path.join(root, 'target-dead');
    fs.mkdirSync(deadDir, { recursive: true });
    writeIsolatedTargetMetadata(path.join(deadDir, '.cache-metadata.json'), {
      ownerPid: 99999999, // guaranteed non-existent
      reusable: true,
      reclaimable: true,
    });
    fs.writeFileSync(path.join(deadDir, 'artifact.bin'), 'remove');

    const nonReclaimableDir = path.join(root, 'target-pinned');
    fs.mkdirSync(nonReclaimableDir, { recursive: true });
    writeIsolatedTargetMetadata(path.join(nonReclaimableDir, '.cache-metadata.json'), {
      ownerPid: 99999999,
      reusable: true,
      reclaimable: false,
    });

    const unknownDir = path.join(root, 'target-unknown');
    fs.mkdirSync(unknownDir, { recursive: true });

    // Dry run first
    const dryResult = sweepReusableIsolatedCaches({ isolatedTargetsRoot: root, dryRun: true });
    assert.equal(dryResult.reclaimed, 1);
    assert.equal(dryResult.protected, 3);
    assert.ok(fs.existsSync(deadDir));

    // Real sweep
    const sweepResult = sweepReusableIsolatedCaches({ isolatedTargetsRoot: root, dryRun: false });
    assert.equal(sweepResult.reclaimed, 1);
    assert.equal(sweepResult.protected, 3);
    assert.ok(!fs.existsSync(deadDir));
    assert.ok(fs.existsSync(activeDir));
    assert.ok(fs.existsSync(nonReclaimableDir));
    assert.ok(fs.existsSync(unknownDir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
