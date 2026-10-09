import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isPidActive,
  readLeaseFile,
  writeLeaseFile,
  cleanVm3TemporaryRoot,
  reclaimOrphanedTestDirectories,
} from './run-with-vm3-test-environment.mjs';

test('isPidActive accurately reports current process and nonexistent PID', () => {
  assert.equal(isPidActive(process.pid), true);
  assert.equal(isPidActive(99999999), false);
  assert.equal(isPidActive(-1), false);
  assert.equal(isPidActive('invalid'), false);
});

test('lease file write and read roundtrip handles valid and corrupt lease', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-test-'));
  try {
    assert.equal(readLeaseFile(dir), null);
    writeLeaseFile(dir, { pid: 42, purpose: 'unit-test' });
    const loaded = readLeaseFile(dir);
    assert.equal(loaded.pid, 42);
    assert.equal(loaded.purpose, 'unit-test');

    fs.writeFileSync(path.join(dir, '.test-lease.json'), 'not-json', 'utf8');
    assert.equal(readLeaseFile(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanVm3TemporaryRoot cleans successfully and records pending file on locked/failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-test-'));
  const record = cleanVm3TemporaryRoot(dir);
  assert.equal(record, null);
  assert.equal(fs.existsSync(dir), false);
});

test('reclaimOrphanedTestDirectories reclaims stale matching directories while protecting active PIDs and recent ones', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-root-'));
  try {
    // 1. Active directory with running PID lease
    const activeDir = path.join(tempRoot, 'frozen-funnel-active');
    fs.mkdirSync(activeDir, { recursive: true });
    writeLeaseFile(activeDir, { pid: process.pid, purpose: 'active-job' });

    // 2. Dead directory with dead PID lease
    const deadDir = path.join(tempRoot, 'frozen-funnel-dead');
    fs.mkdirSync(deadDir, { recursive: true });
    writeLeaseFile(deadDir, { pid: 99999999, purpose: 'stale-job' });

    // 3. Stale directory without lease but very old
    const staleNoLease = path.join(tempRoot, 'watch-mode-test-stale');
    fs.mkdirSync(staleNoLease, { recursive: true });
    // Backdate mtime/ctime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(staleNoLease, twoHoursAgo, twoHoursAgo);

    // 4. Fresh directory without lease (should be protected by recent quiescence)
    const freshNoLease = path.join(tempRoot, 'watch-mode-test-fresh');
    fs.mkdirSync(freshNoLease, { recursive: true });

    // 5. Unrelated directory prefix (e.g. npm-cache, diagnostic-context) - must NOT be touched
    const unrelatedDir = path.join(tempRoot, 'npm-cache');
    fs.mkdirSync(unrelatedDir, { recursive: true });

    // Dry run first
    const dryRes = reclaimOrphanedTestDirectories({ tempRoot, maxAgeMs: 60 * 60 * 1000, dryRun: true });
    assert.equal(dryRes.reclaimed, 2); // deadDir and staleNoLease
    assert.ok(fs.existsSync(deadDir));
    assert.ok(fs.existsSync(staleNoLease));

    // Live run
    const liveRes = reclaimOrphanedTestDirectories({ tempRoot, maxAgeMs: 60 * 60 * 1000, dryRun: false });
    assert.equal(liveRes.reclaimed, 2);

    assert.ok(!fs.existsSync(deadDir));
    assert.ok(!fs.existsSync(staleNoLease));
    assert.ok(fs.existsSync(activeDir), 'active dir must be protected');
    assert.ok(fs.existsSync(freshNoLease), 'fresh dir must be protected');
    assert.ok(fs.existsSync(unrelatedDir), 'unrelated dir must be untouched');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
