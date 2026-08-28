import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runManagedProviderPreflight } from './watch-mode-provider-preflight-process.mjs';

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function publishEmitter(outputDirectory, value) {
  const staging = `${outputDirectory}.staging`;
  fs.mkdirSync(staging, { recursive: false });
  fs.writeFileSync(path.join(staging, 'emitter-result.json'), JSON.stringify(value));
  fs.renameSync(staging, outputDirectory);
}

test('terminal emitter failure remains primary when graceful cleanup fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-process-'));
  const executablePath = path.join(root, 'desktop.exe');
  fs.writeFileSync(executablePath, 'test-executable');
  const outputDirectory = path.join(root, 'evidence');
  const child = fakeChild();
  setTimeout(() => publishEmitter(
    outputDirectory,
    { status: 'failed', error: 'latency 1218ms exceeds 1200ms' },
  ), 5);
  await assert.rejects(
    runManagedProviderPreflight({
      executablePath,
      outputDirectory,
      environment: {},
      executionId: 'watch-test-execution',
      providerId: 'dashscope',
      spawnProcess: () => child,
      querySnapshot: () => ({ exists: true, pid: child.pid, parentPid: 1, imagePath: executablePath, startedAt: '2026-08-28T00:00:00.000Z' }),
      closeOwnedProcess: () => { throw new Error('close failed'); },
      forceOwnedProcess: () => { child.emit('exit', 1); return { status: 'forced', forced: true }; },
      exitGraceMs: 1,
      closeGraceMs: 1,
      emitterTimeoutMs: 1000,
    }),
    (error) => {
      assert.match(error.message, /latency 1218ms exceeds 1200ms/);
      assert.deepEqual(error.failure.cleanupErrors, ['close failed']);
      assert.equal(error.failure.termination.forced, true);
      assert.ok(fs.existsSync(error.failurePath));
      return true;
    },
  );
});

test('completed emitter settles after the owned process exits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-process-'));
  const executablePath = path.join(root, 'desktop.exe');
  fs.writeFileSync(executablePath, 'test-executable');
  const outputDirectory = path.join(root, 'evidence');
  const child = fakeChild(4343);
  setTimeout(() => {
    publishEmitter(outputDirectory, { status: 'completed' });
    child.emit('exit', 0);
  }, 5);
  const result = await runManagedProviderPreflight({
    executablePath,
    outputDirectory,
    environment: {},
    executionId: 'watch-test-success',
    providerId: 'dashscope',
    spawnProcess: () => child,
    querySnapshot: () => ({ exists: true, pid: child.pid, parentPid: 1, imagePath: executablePath, startedAt: '2026-08-28T00:00:00.000Z' }),
    emitterTimeoutMs: 1000,
    exitGraceMs: 1,
  });
  assert.equal(result.emitter.status, 'completed');
  assert.equal(result.termination.exited, true);
});

test('completed emitter with an uncleanable owned process writes a terminal failure artifact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-cleanup-'));
  const executablePath = path.join(root, 'desktop.exe');
  fs.writeFileSync(executablePath, 'test-executable');
  const outputDirectory = path.join(root, 'evidence');
  const child = fakeChild(4444);
  setTimeout(() => publishEmitter(outputDirectory, { status: 'completed' }), 5);
  await assert.rejects(runManagedProviderPreflight({
    executablePath,
    outputDirectory,
    environment: {},
    executionId: 'watch-test-cleanup-failure',
    providerId: 'dashscope',
    spawnProcess: () => child,
    querySnapshot: () => ({ exists: true, pid: child.pid, parentPid: 1, imagePath: executablePath, startedAt: '2026-08-28T00:00:00.000Z' }),
    closeOwnedProcess: () => { throw new Error('close denied'); },
    forceOwnedProcess: () => { throw new Error('identity changed'); },
    emitterTimeoutMs: 1000,
    exitGraceMs: 1,
    closeGraceMs: 1,
    cleanupTimeoutMs: 1,
  }), (error) => {
    assert.equal(error.failure.stableErrorCode, 'provider.preflight.cleanup-failed');
    assert.equal(error.failure.primaryError.code, 'provider.preflight.cleanup-failed');
    assert.deepEqual(error.failure.cleanupErrors, ['close denied', 'identity changed']);
    assert.ok(fs.existsSync(error.failurePath));
    return true;
  });
});

test('runner reserves only the parent and rejects a pre-existing final evidence directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-existing-'));
  const executablePath = path.join(root, 'desktop.exe');
  fs.writeFileSync(executablePath, 'test-executable');
  const outputDirectory = path.join(root, 'evidence');
  fs.mkdirSync(outputDirectory);
  await assert.rejects(
    runManagedProviderPreflight({ executablePath, outputDirectory }),
    /output directory already exists/,
  );
});
