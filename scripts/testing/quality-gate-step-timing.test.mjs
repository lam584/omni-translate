import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeQualityGateStep, runQualityGateAuto } from './run-quality-gate-auto.mjs';

const step = {name: 'contracts', command: 'npm run test:contracts'};
test('gate distinguishes receipt verification time from original execution time', () => {
  let ms = 1000;
  const result = executeQualityGateStep(step, { targetDir: 'unused', now: () => ms,
    receiptLoader: () => { ms += 7; return {receiptPath: 'evidence/receipt.json', receipt: {log: {path: 'contracts.log'}, startedAt: '2026-09-06T00:00:00Z', completedAt: '2026-09-06T00:00:20Z'}}; },
    execute: () => { throw new Error('verified receipt must not rerun command'); }, echo: () => {},
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.validationMode, 'signed-receipt');
  assert.equal(result.durationMs, 7);
  assert.equal(result.sourceExecutionDurationMs, 20000);
});
test('missing or rejected receipt executes exact command and records failed exit', () => {
  let ms = 1000;
  const result = executeQualityGateStep(step, {targetDir: 'logs', now: () => ms, receiptLoader: () => null,
    execute: (command) => { assert.equal(command, step.command); ms += 50; return 7; }, echo: () => {},
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.equal(result.validationMode, 'executed');
  assert.equal(result.durationMs, 50);
  assert.equal(result.reusedReceipt, undefined);
});
test('receipt-loader error cannot be reported as a passed gate step', () => {
  assert.throws(() => executeQualityGateStep(step, {targetDir: 'unused', receiptLoader: () => {throw new Error('invalid evidence');}}), /invalid evidence/);
});

for (const phase of ['receipt-verification', 'execution', 'log-tail']) {
  test('exception records failed step identity and elapsed time: ' + phase, () => {
    let ms = 1000;
    const original = new Error('injected ' + phase);
    const fail = () => { ms += 29; throw original; };
    assert.throws(() => executeQualityGateStep(step, {
      targetDir: 'logs', now: () => ms,
      receiptLoader: phase === 'receipt-verification' ? fail : () => null,
      execute: phase === 'execution' ? fail : () => 0,
      echo: phase === 'log-tail' ? fail : () => {},
    }), (error) => {
      assert.equal(error.cause, original);
      const result = error.qualityGateStepResult;
      assert.equal(result.status, 'failed');
      assert.equal(result.name, step.name);
      assert.equal(result.command, step.command);
      assert.equal(result.failure.phase, phase);
      assert.equal(result.durationMs, 29);
      assert.equal(result.validationMode, phase === 'receipt-verification' ? 'receipt-check' : 'executed');
      assert.equal(result.exitCode, phase === 'log-tail' ? 0 : undefined);
      assert.equal(result.reusedReceipt, undefined);
      return true;
    });
  });
}

test('auto gate writes failed summary with preceding results and throwing step timing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-gate-timing-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let ms = 1000;
  const calls = [];
  assert.throws(() => runQualityGateAuto({ outputRoot: root, operations: {
    steps: [{ name: 'first', command: 'first command' }, step, { name: 'never', command: 'never' }],
    executeStep: (selected, options) => executeQualityGateStep(selected, { ...options, now: () => ms,
      receiptLoader: () => null, echo: () => {}, execute: (command) => {
        calls.push(command); ms += 31;
        if (command === step.command) throw new Error('process creation failed');
        return 0;
      },
    }),
  } }), /process creation failed/);
  const directories = fs.readdirSync(root);
  assert.equal(directories.length, 1);
  const summary = JSON.parse(fs.readFileSync(path.join(root, directories[0], 'quality-gate-auto-summary.json'), 'utf8'));
  assert.equal(summary.status, 'failed');
  assert.equal(summary.failure.failedStep, step.name);
  assert.deepEqual(summary.automatedResults.map((result) => result.status), ['passed', 'failed']);
  assert.equal(summary.automatedResults[1].durationMs, 31);
  assert.equal(summary.automatedResults[1].failure.phase, 'execution');
  assert.equal(summary.executedSteps, 2);
  assert.equal(summary.reusedSteps, 0);
  assert.deepEqual(calls, ['first command', step.command]);
});
