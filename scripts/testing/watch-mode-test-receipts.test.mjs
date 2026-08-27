import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTestReceipt, verifyTestReceipt } from './watch-mode-test-receipts.mjs';

function fixture(root) {
  const logPath = path.join(root, 'command.log');
  fs.writeFileSync(logPath, 'passed\n', 'utf8');
  const provenance = {
    schemaVersion: 1,
    captureStatus: 'captured',
    source: 'git',
    headCommit: 'a'.repeat(40),
    worktreeClean: true,
    dirtyEntryCount: 0,
  };
  const runtimeAuthority = {
    authorityDigest: 'b'.repeat(64),
    implementationHashes: [{ path: 'runner.mjs', bytes: 10, sha256: 'c'.repeat(64) }],
    runtimeBinaryHashes: [{ path: 'desktop.exe', bytes: 20, sha256: 'd'.repeat(64) }],
  };
  const receipt = createTestReceipt({
    name: 'test-desktop-shell',
    command: 'npm run test:desktop-shell',
    logPath,
    startedAt: new Date('2026-08-28T00:00:00.000Z'),
    completedAt: new Date('2026-08-28T00:01:00.000Z'),
    provenance,
    runtimeAuthority,
  });
  return { logPath, provenance, runtimeAuthority, receipt };
}

test('test receipt binds command, exact implementation inventory, runtime and log bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-test-receipt-'));
  const value = fixture(root);
  assert.equal(verifyTestReceipt(value.receipt, {
    name: 'test-desktop-shell',
    command: 'npm run test:desktop-shell',
    receiptDirectory: root,
    provenance: value.provenance,
    runtimeAuthority: value.runtimeAuthority,
  }), true);
  const changed = structuredClone(value.runtimeAuthority);
  changed.implementationHashes[0].sha256 = 'e'.repeat(64);
  assert.equal(verifyTestReceipt(value.receipt, {
    name: 'test-desktop-shell',
    command: 'npm run test:desktop-shell',
    receiptDirectory: root,
    provenance: value.provenance,
    runtimeAuthority: changed,
  }), false);
  fs.writeFileSync(value.logPath, 'changed\n', 'utf8');
  assert.equal(verifyTestReceipt(value.receipt, {
    name: 'test-desktop-shell',
    command: 'npm run test:desktop-shell',
    receiptDirectory: root,
    provenance: value.provenance,
    runtimeAuthority: value.runtimeAuthority,
  }), false);
});
