import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createTestReceipt, verifyTestReceipt } from './watch-mode-test-receipts.mjs';
import { runFrozenTestCommand } from './run-frozen-test-funnel.mjs';

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

test('frozen funnel command result mints a receipt with the executed command identity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-frozen-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { provenance, runtimeAuthority } = fixture(root);
  const step = { name: 'successful-command', command: 'node -p 1' };
  const result = await runFrozenTestCommand(step, path.join(root, 'executed.log'));
  const receipt = createTestReceipt({ ...result, provenance, runtimeAuthority });
  assert.equal(receipt.name, step.name);
  assert.equal(receipt.command, step.command);
  const options = { ...step, receiptDirectory: root, provenance, runtimeAuthority };
  assert.equal(verifyTestReceipt(receipt, options), true);
  assert.equal(verifyTestReceipt(receipt, { ...options, name: 'another-command' }), false);
  assert.equal(verifyTestReceipt(receipt, { ...options, command: 'npm run verify:desktop' }), false);
});

test('frozen funnel does not accept printed passed text from a failing command', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-frozen-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expression = 'console.log(String.fromCharCode(112,97,115,115,101,100)),process.exit(7)';
  const logPath = path.join(root, 'failed.log');
  await assert.rejects(runFrozenTestCommand({
    name: 'failing-command',
    command: `node -e ${process.platform === 'win32' ? expression : `"${expression}"`}`,
  }, logPath), /failing-command failed with exit 7/);
  assert.match(fs.readFileSync(logPath, 'utf8'), /passed/);
});

test('frozen funnel rejects signal termination and waits for close to drain logs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-frozen-signal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'signal.log');
  const spawnCommand = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.emit('exit', null, 'SIGTERM');
      child.stdout.end('last stdout after exit\n');
      child.stderr.end('last stderr after exit\n');
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
    });
    return child;
  };
  await assert.rejects(runFrozenTestCommand({ name: 'terminated-command', command: 'unused' }, logPath, {
    spawnCommand,
  }), /terminated-command failed with exit null \(signal SIGTERM\)/);
  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /last stdout after exit/);
  assert.match(log, /last stderr after exit/);
});
