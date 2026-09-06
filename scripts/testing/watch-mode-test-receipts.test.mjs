import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createTestReceipt, verifyTestReceipt, loadReusableTestReceipt } from './watch-mode-test-receipts.mjs';
import { FROZEN_FUNNEL_STEPS, createFrozenFunnelPlan, createFrozenFunnelAuthority, frozenFunnelFileEntry } from './frozen-test-funnel-distributed.mjs';
import { generateCoordinatorSigningKeyPair } from './watch-mode-shard-authority.mjs';
import { AUTHORITY_IMPLEMENTATION_FILES } from './watch-mode-evidence-authority.mjs';
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


// Adapted from the private fixture/workerResults helpers in the distributed funnel tests.
// Only runtime preparation is injected; plan signatures and artifact checks remain real.
function loaderFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-loader-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { provenance, runtimeAuthority } = fixture(root);
  const keys = generateCoordinatorSigningKeyPair();
  runtimeAuthority.implementationHashes = AUTHORITY_IMPLEMENTATION_FILES.map((path) => ({ path, bytes: 10, sha256: 'c'.repeat(64) }));
  runtimeAuthority.coordinatorSigning = { publicKeyAuthority: { path: 'public.pem' } };
  fs.writeFileSync(path.join(root, 'public.pem'), keys.publicKeyPem, 'utf8');
  const workers = [{ workerId: 'vm1', user: 'VMUser', workspaceRoot: 'E:\\fixture',
    vmIdentity: { uuidBios: '10000000-0000-0000-0000-000000000000' }, transport: { kind: 'local' } }];
  const plan = createFrozenFunnelPlan({ workers, provenance, runtimeAuthority, ...keys, executionId: 'loader-fixture' });
  const worker = plan.workers[0];
  const workerRoot = path.join(root, 'workers', worker.workerId);
  fs.mkdirSync(workerRoot, { recursive: true });
  const observation = { uuidBios: worker.uuidBios, provenance };
  const results = plan.steps.map((step, index) => {
    fs.writeFileSync(path.join(workerRoot, step.name + '.log'), step.name + ' passed\n', 'utf8');
    return { ...step, startedAt: new Date(Date.UTC(2026, 8, 4, 0, 0, index)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 8, 4, 0, 0, index + 1)).toISOString(),
      exitCode: 0, signal: null, verdict: 'passed', log: frozenFunnelFileEntry(workerRoot, step.name + '.log') };
  });
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value), 'utf8');
  write('workers/vm1/worker-result.json', {
    schemaVersion: 1, artifactKind: 'frozen-test-funnel-worker-result', executionId: plan.executionId,
    planDigest: plan.digest, workerId: worker.workerId, providerCalls: 0, before: observation, after: observation,
    results, verdict: 'passed',
  });
  const authority = createFrozenFunnelAuthority({ plan, provenance, runtimeAuthority, ...keys, outputRoot: root });
  write('funnel-authority.json', authority);
  const distributedAuthority = { ...frozenFunnelFileEntry(root, 'funnel-authority.json'), planDigest: plan.digest };
  const inputs = results.map((step) => {
    const logPath = path.join(root, step.log.path);
    fs.copyFileSync(path.join(workerRoot, step.log.path), logPath);
    return { ...step, logPath, provenance, runtimeAuthority,
      startedAt: new Date(step.startedAt), completedAt: new Date(step.completedAt),
      distributedAuthority: { ...distributedAuthority, workerId: worker.workerId } };
  });
  const receipts = inputs.map((input) => {
    write(input.name + '.receipt.json', createTestReceipt(input));
    return { name: input.name, command: input.command, path: input.name + '.receipt.json' };
  });
  const index = { schemaVersion: 2, receipts, distributedAuthority, runtimeAuthority: { path: 'runtime.json' } };
  write('latest.json', index);
  const options = { workspaceRoot: root, indexPath: path.join(root, 'latest.json'), provenance,
    operations: { verifyStrictRuntimeAuthority: () => ({ authority: runtimeAuthority, authorityPath: path.join(root, 'runtime.json') }) } };
  const step = FROZEN_FUNNEL_STEPS.find(({ name }) => name === 'verify-desktop');
  return { root, runtimeAuthority, provenance, index, inputs, options, step, write, authority };
}

test('loader reuses signed v2 for all thirteen allowed exact commands, not strict PS', (t) => {
  const value = loaderFixture(t);
  for (const step of FROZEN_FUNNEL_STEPS) {
    const result = loadReusableTestReceipt(step, value.options);
    if (step.name === 'audit-powershell-boundaries') {
      assert.equal(result, null);
      assert.equal(loadReusableTestReceipt({ ...step, command: 'npm run audit:powershell-boundaries' }, value.options), null);
    } else {
      assert.equal(result?.receipt.name, step.name);
    }
  }
});

test('loader rejects v1 index and v1 receipt while standalone verification stays compatible', (t) => {
  const value = loaderFixture(t);
  const input = value.inputs.find(({ name }) => name === value.step.name);
  assert.ok(loadReusableTestReceipt(value.step, value.options));
  const receipt = createTestReceipt({ ...input, distributedAuthority: undefined });
  assert.equal(verifyTestReceipt(receipt, { ...value.step, receiptDirectory: value.root,
    provenance: value.provenance, runtimeAuthority: value.runtimeAuthority }), true);
  value.write(value.step.name + '.receipt.json', receipt);
  assert.equal(loadReusableTestReceipt(value.step, value.options), null);
  value.write('latest.json', { ...value.index, schemaVersion: 1, distributedAuthority: undefined });
  assert.equal(loadReusableTestReceipt(value.step, value.options), null);
});

for (const [name, mutate] of Object.entries({
  'changed command': (v) => { v.step = { ...v.step, command: v.step.command + ' --changed' }; },
  'dirty HEAD': (v) => { v.options.provenance = { ...v.provenance, worktreeClean: false, dirtyEntryCount: 1 }; },
  'inconsistent dirty count': (v) => { v.options.provenance = { ...v.provenance, dirtyEntryCount: 1 }; },
  'foreign HEAD': (v) => { v.options.provenance = { ...v.provenance, headCommit: 'e'.repeat(40) }; },
  'foreign runtime': (v) => { v.runtimeAuthority.authorityDigest = 'e'.repeat(64); },
  'runtime hash': (v) => { v.runtimeAuthority.runtimeBinaryHashes[0].sha256 = 'e'.repeat(64); },
  'implementation hash': (v) => { v.runtimeAuthority.implementationHashes[0].sha256 = 'e'.repeat(64); },
  'receipt log': (v) => { fs.appendFileSync(path.join(v.root, v.step.name + '.log'), 'tampered'); },
  'other worker log': (v) => { fs.appendFileSync(path.join(v.root, 'workers/vm1/contracts.log'), 'tampered'); },
  'bad signature with updated outer hashes': (v) => {
    v.authority.signature.valueBase64 = Buffer.alloc(64).toString('base64');
    v.write('funnel-authority.json', v.authority);
    const binding = { ...v.index.distributedAuthority, ...frozenFunnelFileEntry(v.root, 'funnel-authority.json') };
    v.write('latest.json', { ...v.index, distributedAuthority: binding });
    const input = v.inputs.find(({ name }) => name === v.step.name);
    v.write(v.step.name + '.receipt.json', createTestReceipt({ ...input,
      distributedAuthority: { ...binding, workerId: 'vm1' } }));
  },
  'runtime verification error': (v) => { v.options.operations.verifyStrictRuntimeAuthority = () => { throw new Error('invalid runtime'); }; },
  'wrong public key': (v) => { fs.writeFileSync(path.join(v.root, 'public.pem'), generateCoordinatorSigningKeyPair().publicKeyPem, 'utf8'); },
  'missing index': (v) => { v.options.indexPath = path.join(v.root, 'missing.json'); },
  'incomplete index': (v) => { v.write('latest.json', { ...v.index, receipts: v.index.receipts.slice(1) }); },
  'changed index command': (v) => { v.index.receipts[0].command += ' --changed'; v.write('latest.json', v.index); },
  'null receipt': (v) => { v.write(v.step.name + '.receipt.json', null); },
  'receipt digest': (v) => {
    const receipt = createTestReceipt(v.inputs.find(({ name }) => name === v.step.name));
    v.write(v.step.name + '.receipt.json', { ...receipt, receiptDigest: 'e'.repeat(64) });
  },
  'escaping receipt path': (v) => {
    v.index.receipts.find(({ name }) => name === v.step.name).path = '../outside.json';
    v.write('latest.json', v.index);
  },
  'malformed index': (v) => { v.write('latest.json', { ...v.index, receipts: {} }); },
  'null index': (v) => { v.write('latest.json', null); },
  'null index entry': (v) => { v.write('latest.json', { ...v.index, receipts: [null] }); },
  'malformed JSON': (v) => { fs.writeFileSync(v.options.indexPath, 'broken', 'utf8'); },
  'missing receipt': (v) => { fs.renameSync(path.join(v.root, v.step.name + '.receipt.json'), path.join(v.root, 'removed.json')); },
})) {
  test('loader returns null without throwing: ' + name, (t) => {
    const value = loaderFixture(t);
    assert.ok(loadReusableTestReceipt(value.step, value.options), 'fixture must first pass real signed verification');
    mutate(value);
    assert.equal(loadReusableTestReceipt(value.step, value.options), null);
  });
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
