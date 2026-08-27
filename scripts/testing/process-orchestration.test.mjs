import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { evaluateIpcInvocation, IPC_TESTS } from '../diagnostics/ipc-test.mjs';
import { fileLength, readUtf8Delta } from './lib/process-runner.mjs';

test('UTF-8 log deltas preserve multibyte text at a byte offset', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-process-runner-'));
  const logPath = path.join(directory, 'app.log');
  fs.writeFileSync(logPath, '旧日志\n', 'utf8');
  const offset = fileLength(logPath);
  fs.appendFileSync(logPath, '启动完成\n', 'utf8');
  assert.equal(readUtf8Delta(logPath, offset), '启动完成\n');
});

test('IPC diagnostic verdict requires both exit zero and the command marker', () => {
  assert.equal(evaluateIpcInvocation(IPC_TESTS[0], { status: 0, stdout: 'pong', stderr: '' }).passed, true);
  assert.equal(evaluateIpcInvocation(IPC_TESTS[0], { status: 1, stdout: 'pong', stderr: '' }).passed, false);
  assert.equal(evaluateIpcInvocation(IPC_TESTS[0], { status: 0, stdout: 'unknown', stderr: '' }).passed, false);
});

test('PowerShell compatibility wrappers contain no process-name termination', () => {
  for (const relativePath of [
    'scripts/testing/run-startup-ipc-stress.ps1',
    'scripts/testing/run-overlay-driver-smoke.ps1',
    'scripts/diagnostics/ipc_test.ps1',
  ]) {
    const source = fs.readFileSync(relativePath, 'utf8');
    assert.doesNotMatch(source, /Stop-Process|Get-Process\s+-Name|taskkill/i, relativePath);
  }
});
