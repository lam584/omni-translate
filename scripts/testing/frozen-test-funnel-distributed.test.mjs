import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  FROZEN_FUNNEL_RUNNER, FROZEN_FUNNEL_STEPS, createFrozenFunnelPlan, verifyFrozenFunnelPlan,
  runFrozenFunnelPipelines, collectFrozenFunnelWorkers, createFrozenFunnelAuthority,
  verifyFrozenFunnelAuthority, verifyFrozenFunnelWorkerResult, frozenFunnelFileEntry,
  runFrozenFunnelWorker, runFrozenFunnelStep, createFrozenFunnelTransport,
} from './frozen-test-funnel-distributed.mjs';
import { generateCoordinatorSigningKeyPair, signCoordinatorAuthority } from './watch-mode-shard-authority.mjs';
import { createTestReceipt, verifyTestReceipt } from './watch-mode-test-receipts.mjs';
import { repoRoot } from '../lib/testing-common.mjs';

const EXPECTED_STEPS = Object.freeze({
  contracts: 'npm run test:contracts',
  'powershell-tooling': 'npm run test:powershell-tooling',
  'audit-powershell-boundaries': 'npm run audit:powershell-boundaries:strict',
  'audit-architecture': 'npm run audit:architecture',
  'watch-mode-coordinator-tooling': 'npm run test:watch-mode-coordinator-tooling',
  'integration-bridge-contract': 'npm run test:integration:bridge-contract',
  'check-bridge-service-native': 'npm run check:bridge-service-native',
  'test-bridge-service-native': 'npm run test:bridge-service-native',
  'check-desktop-shell': 'npm run check:desktop-shell',
  'test-desktop-shell': 'npm run test:desktop-shell',
  'verify-desktop': 'npm run verify:desktop',
  'watch-mode-tooling': 'npm run test:watch-mode-report',
  'benchmark-core-tests': 'npm run test:benchmark-core',
  'diagnostics-benchmark-tests': 'npm run test:diagnostics-benchmark',
});

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-distributed-funnel-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(t) {
  const root = temporaryRoot(t);
  const keys = generateCoordinatorSigningKeyPair();
  const provenance = { schemaVersion: 1, captureStatus: 'captured', source: 'git', headCommit: 'a'.repeat(40), worktreeClean: true, dirtyEntryCount: 0 };
  const runtimeAuthority = {
    authorityDigest: 'b'.repeat(64),
    implementationHashes: [{ path: FROZEN_FUNNEL_RUNNER, bytes: 10, sha256: 'c'.repeat(64) }],
    runtimeBinaryHashes: [{ path: 'target/release/desktop.exe', bytes: 20, sha256: 'd'.repeat(64) }],
  };
  const workers = [0, 1, 2].map((index) => ({
    workerId: `vm${index + 1}`, user: 'VMUser', workspaceRoot: `E:\\fixture${index}`,
    vmIdentity: { uuidBios: `${index + 1}0000000-0000-0000-0000-000000000000` },
    transport: index === 0 ? { kind: 'local' } : {
      kind: 'ssh', hostKeyAlias: `vm${index + 1}`, hostKeyAlgorithm: 'ssh-ed25519', hostKeySha256: `SHA256:${String(index).repeat(43)}`,
    },
  }));
  const plan = createFrozenFunnelPlan({ workers, provenance, runtimeAuthority, ...keys, executionId: 'fixture-funnel' });
  return { root, keys, provenance, runtimeAuthority, workers, plan };
}

function resign(value, keys) {
  const { digest, signature, ...core } = structuredClone(value);
  void digest; void signature;
  return signCoordinatorAuthority(core, keys.privateKeyPem, keys.publicKeyPem);
}

function workerResults(value) {
  return value.plan.workers.map((worker) => {
    const root = path.join(value.root, 'workers', worker.workerId);
    fs.mkdirSync(root, { recursive: true });
    const observation = { uuidBios: worker.uuidBios, provenance: value.provenance };
    const result = {
      schemaVersion: 1, artifactKind: 'frozen-test-funnel-worker-result', executionId: value.plan.executionId,
      planDigest: value.plan.digest, workerId: worker.workerId, providerCalls: 0, before: observation, after: observation,
      results: value.plan.steps.filter((step) => step.workerId === worker.workerId).map((step, index) => {
        fs.writeFileSync(path.join(root, `${step.name}.log`), `${step.name} passed\n`, 'utf8');
        return { ...step, startedAt: new Date(Date.UTC(2026, 8, 4, 0, 0, index)).toISOString(), completedAt: new Date(Date.UTC(2026, 8, 4, 0, 0, index + 1)).toISOString(),
          exitCode: 0, signal: null, verdict: 'passed', log: frozenFunnelFileEntry(root, `${step.name}.log`) };
      }), verdict: 'passed',
    };
    fs.writeFileSync(path.join(root, 'worker-result.json'), JSON.stringify(result), 'utf8');
    return result;
  });
}

test('distributed funnel fixes all fourteen commands exactly once and distributes three test layers', (t) => {
  const value = fixture(t);
  assert.equal(FROZEN_FUNNEL_STEPS.length, 14);
  assert.deepEqual(Object.fromEntries(value.plan.steps.map(({ name, command }) => [name, command])), EXPECTED_STEPS);
  assert.equal(new Set(value.plan.steps.map((step) => step.name)).size, 14);
  assert.equal(new Set(value.plan.steps.map((step) => step.workerId)).size, 3);
  assert.equal(value.plan.steps.find((step) => step.name === 'test-bridge-service-native').workerId, 'vm2');
  assert.equal(value.plan.steps.find((step) => step.name === 'test-desktop-shell').workerId, 'vm3');
});

test('even validly signed plans reject missing, duplicated, changed and reassigned steps', (t) => {
  const value = fixture(t);
  for (const mutate of [
    (plan) => plan.steps.pop(),
    (plan) => { plan.steps[1] = plan.steps[0]; },
    (plan) => { plan.steps[0].command = 'npm run arbitrary'; },
    (plan) => { plan.steps[0].workerId = 'vm2'; },
  ]) {
    const plan = structuredClone(value.plan); mutate(plan);
    assert.throws(() => verifyFrozenFunnelPlan(resign(plan, value.keys), { ...value, ...value.keys }));
  }
});

test('plan rejects signature, HEAD, runtime inventory and duplicate worker identity substitutions', (t) => {
  const value = fixture(t);
  const invalidSignature = structuredClone(value.plan); invalidSignature.providerCalls = 1;
  assert.throws(() => verifyFrozenFunnelPlan(invalidSignature, { ...value, ...value.keys }));
  assert.throws(() => verifyFrozenFunnelPlan(value.plan, { ...value, ...generateCoordinatorSigningKeyPair() }));
  assert.throws(() => verifyFrozenFunnelPlan(value.plan, { ...value, ...value.keys, provenance: { ...value.provenance, headCommit: 'f'.repeat(40) } }));
  assert.throws(() => verifyFrozenFunnelPlan(value.plan, { ...value, ...value.keys, runtimeAuthority: { ...value.runtimeAuthority, runtimeBinaryHashes: [] } }));
  for (const mutate of [
    (plan) => { plan.workers[1].uuidBios = plan.workers[0].uuidBios; },
    (plan) => { plan.workers[2].transportAuthority.hostKeySha256 = plan.workers[1].transportAuthority.hostKeySha256; },
    (plan) => { plan.workers[1].workerId = plan.workers[0].workerId; },
  ]) {
    const plan = structuredClone(value.plan); mutate(plan);
    assert.throws(() => verifyFrozenFunnelPlan(resign(plan, value.keys), { ...value, ...value.keys }));
  }
});

test('three worker pipelines overlap while each worker remains serial, collecting failures without retry', async (t) => {
  const { plan } = fixture(t);
  const active = new Set(); const calls = []; let maximum = 0;
  const results = await runFrozenFunnelPipelines({ plan, executeStep: async ({ worker, step }) => {
    assert.equal(active.has(worker.workerId), false);
    active.add(worker.workerId); maximum = Math.max(maximum, active.size); calls.push(step.name);
    await new Promise((resolve) => setImmediate(resolve));
    active.delete(worker.workerId);
    if (step.name === 'contracts') throw new Error('private diagnostic must not leak');
    return { ...step, verdict: 'passed' };
  } });
  assert.equal(maximum, 3);
  assert.equal(calls.length, 14); assert.equal(new Set(calls).size, 14);
  assert.equal(results.flatMap((worker) => worker.results).length, 14);
  assert.equal(results[0].results[0].errorCode, 'funnel.step.failed');
  assert.doesNotMatch(JSON.stringify(results), /private diagnostic/);
});

test('collection waits for all workers after synchronous failure and never publishes successful authority', async (t) => {
  const value = fixture(t); const finished = [];
  await assert.rejects(collectFrozenFunnelWorkers({ plan: value.plan, outputRoot: value.root, executeWorker: (worker) => {
    if (worker.workerId === 'vm1') throw new Error('secret transport details');
    return new Promise((resolve) => setImmediate(() => { finished.push(worker.workerId); resolve({ workerId: worker.workerId }); }));
  } }), /all independent workers have settled/);
  assert.deepEqual(finished.sort(), ['vm2', 'vm3']);
  const collected = JSON.parse(fs.readFileSync(path.join(value.root, 'worker-collection.json'), 'utf8'));
  assert.deepEqual(collected.map((entry) => entry.workerId), ['vm1', 'vm2', 'vm3']);
  assert.doesNotMatch(JSON.stringify(collected), /secret transport/);
  assert.deepEqual(fs.readdirSync(value.root), ['worker-collection.json']);
  assert.throws(() => createFrozenFunnelAuthority({ ...value, ...value.keys, outputRoot: value.root }));
});

test('complete authority verifies all fourteen logs and rejects aggregate signature and worker omission', (t) => {
  const value = fixture(t); workerResults(value);
  const authority = createFrozenFunnelAuthority({ ...value, ...value.keys, outputRoot: value.root });
  const options = { ...value, ...value.keys, artifactRoot: value.root };
  assert.equal(verifyFrozenFunnelAuthority(authority, options).flatMap((worker) => worker.results).length, 14);
  const tampered = structuredClone(authority); tampered.providerCalls = 1;
  assert.throws(() => verifyFrozenFunnelAuthority(tampered, options));
  const omitted = structuredClone(authority); omitted.workers.pop();
  assert.throws(() => verifyFrozenFunnelAuthority(resign(omitted, value.keys), options));
  fs.appendFileSync(path.join(value.root, 'workers/vm2/integration-bridge-contract.log'), 'tampered', 'utf8');
  assert.throws(() => verifyFrozenFunnelAuthority(authority, options), /log changed/);
});

test('worker results reject identity, HEAD, log path, exit status and exact coverage tampering', (t) => {
  const value = fixture(t); const [result] = workerResults(value);
  const options = { plan: value.plan, workerId: 'vm1', artifactRoot: path.join(value.root, 'workers/vm1') };
  assert.equal(verifyFrozenFunnelWorkerResult(result, options), result);
  for (const mutate of [
    (item) => { item.workerId = 'vm2'; },
    (item) => { item.before.uuidBios = value.plan.workers[1].uuidBios; },
    (item) => { item.after.provenance.headCommit = 'f'.repeat(40); },
    (item) => { item.results[0].log.path = '../contracts.log'; },
    (item) => { item.results[0].exitCode = 1; },
    (item) => { item.results[0].log.sha256 = 'f'.repeat(64); },
    (item) => { item.results.pop(); },
    (item) => { item.results[1] = item.results[0]; },
    (item) => { item.results[1].startedAt = item.results[0].startedAt; },
  ]) {
    const invalid = structuredClone(result); mutate(invalid);
    assert.throws(() => verifyFrozenFunnelWorkerResult(invalid, options));
  }
});

test('worker result requires a valid finite completed timestamp', (t) => {
  const value = fixture(t); const [result] = workerResults(value);
  result.results[0].completedAt = 'invalid-date';
  assert.throws(() => verifyFrozenFunnelWorkerResult(result, { plan: value.plan, workerId: 'vm1', artifactRoot: path.join(value.root, 'workers/vm1') }));
});

function executableFixture(t) {
  const value = fixture(t);
  const workspaceRoot = path.join(value.root, 'workspace');
  fs.mkdirSync(path.join(workspaceRoot, 'scripts/testing'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'target/release'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, FROZEN_FUNNEL_RUNNER), 'fixture runner', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'target/release/desktop.exe'), 'fixture binary', 'utf8');
  const workers = [{ ...value.workers[0], workspaceRoot }];
  const runtimeAuthority = { ...value.runtimeAuthority,
    implementationHashes: [frozenFunnelFileEntry(workspaceRoot, FROZEN_FUNNEL_RUNNER)],
    runtimeBinaryHashes: [frozenFunnelFileEntry(workspaceRoot, 'target/release/desktop.exe')],
  };
  const plan = createFrozenFunnelPlan({ ...value, workers, runtimeAuthority, ...value.keys });
  const observation = { uuidBios: plan.workers[0].uuidBios, provenance: value.provenance };
  return { ...value, workspaceRoot, plan, runtimeAuthority, observation,
    outputRoot: path.join(workspaceRoot, 'artifacts/testing/frozen-funnel-workers', plan.executionId, 'vm1') };
}

test('real worker loop runs remaining independent steps after a failed test but cannot mint success', async (t) => {
  const value = executableFixture(t); const calls = [];
  const result = await runFrozenFunnelWorker({ ...value, ...value.keys, workerId: 'vm1', observe: () => value.observation,
    runStep: async (step, logPath) => {
      calls.push(step.name); fs.writeFileSync(logPath, 'test output', 'utf8');
      return { ...step, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        verdict: step.name === 'contracts' ? 'failed' : 'passed', exitCode: step.name === 'contracts' ? 1 : 0, signal: null };
    },
  });
  assert.equal(calls.length, 14); assert.equal(new Set(calls).size, 14);
  assert.equal(result.verdict, 'failed');
  assert.equal(verifyFrozenFunnelWorkerResult(result, {
    ...value, workerId: 'vm1', artifactRoot: value.outputRoot, allowFailed: true,
  }), result);
  assert.throws(() => verifyFrozenFunnelWorkerResult(result, { ...value, workerId: 'vm1', artifactRoot: value.outputRoot }));
  await assert.rejects(runFrozenFunnelWorker({ ...value, ...value.keys, workerId: 'vm1', observe: () => value.observation,
    runStep: () => assert.fail('execution claim must prevent replay'),
  }), /EEXIST/);
});

test('worker refuses incorrect BIOS or mutated frozen bytes before any test executes', async (t) => {
  const value = executableFixture(t);
  const options = { ...value, ...value.keys, workerId: 'vm1', runStep: () => assert.fail('preflight must fail before tests') };
  await assert.rejects(runFrozenFunnelWorker({ ...options, observe: () => ({ ...value.observation, uuidBios: value.plan.workers[0].uuidBios.replace(/^1/u, '2') }) }), /BIOS/);
  fs.appendFileSync(path.join(value.workspaceRoot, FROZEN_FUNNEL_RUNNER), 'changed', 'utf8');
  await assert.rejects(runFrozenFunnelWorker({ ...options, observe: () => value.observation }), /hash mismatch/);
  assert.equal(fs.existsSync(value.outputRoot), false);
});

test('worker stops starting more tests when timeout cleanup is unconfirmed', async (t) => {
  const value = executableFixture(t); let calls = 0;
  const result = await runFrozenFunnelWorker({ ...value, ...value.keys, workerId: 'vm1', observe: () => value.observation,
    runStep: async (step, logPath) => {
      calls += 1; fs.writeFileSync(logPath, 'timed out', 'utf8');
      return { ...step, verdict: 'failed', cleanupComplete: false, errorCode: 'funnel.step.timeout' };
    },
  });
  assert.equal(calls, 1); assert.equal(result.results.length, 14); assert.equal(result.verdict, 'failed');
});

test('worker API rejects noncanonical execution output before observing or invoking tests', async (t) => {
  const value = executableFixture(t);
  await assert.rejects(runFrozenFunnelWorker({ ...value, ...value.keys, workerId: 'vm1', outputRoot: path.join(value.root, 'wrong-output'),
    observe: () => assert.fail('invalid output must fail before observation'),
    runStep: () => assert.fail('invalid output must fail before execution'),
  }), /not canonical/);
});

test('step timeout settles without child close when inherited pipes remain open', { timeout: 3000 }, async (t) => {
  const root = temporaryRoot(t); const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let kills = 0; let unrefs = 0;
  child.kill = () => { kills += 1; return true; };
  child.unref = () => { unrefs += 1; };
  const started = Date.now();
  const result = await runFrozenFunnelStep({ ...FROZEN_FUNNEL_STEPS[0], workerId: 'vm1' }, path.join(root, 'timeout.log'), {
    workspaceRoot: root, timeoutMs: 15, spawnCommand: () => child,
  });
  assert.ok(Date.now() - started < 1500, 'timeout cannot await a close event that never arrives');
  assert.equal(result.verdict, 'failed'); assert.equal(result.cleanupComplete, false);
  assert.equal(result.errorCode, 'funnel.step.timeout');
  assert.equal(kills, 1); assert.equal(unrefs, 1);
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  child.emit('close', 0, null);
  assert.equal(result.verdict, 'failed', 'late successful close cannot overwrite timeout');
  await new Promise((resolve) => setImmediate(resolve));
});

test('successful child close cannot hang forever when final log flush never calls back', { timeout: 3000 }, async (t) => {
  const root = temporaryRoot(t); const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => true; child.unref = () => {};
  const output = new PassThrough();
  output.end = () => output;
  const promise = runFrozenFunnelStep({ ...FROZEN_FUNNEL_STEPS[0], workerId: 'vm1' }, path.join(root, 'never-flushed.log'), {
    workspaceRoot: root, timeoutMs: 20, spawnCommand: () => child, createOutputStream: () => output,
  });
  child.emit('close', 0, null);
  const result = await promise;
  assert.equal(result.verdict, 'failed');
  assert.equal(result.errorCode, 'funnel.step.timeout');
  assert.equal(result.cleanupComplete, false);
});

test('successful child close becomes a bounded failure when final log flush errors', { timeout: 3000 }, async (t) => {
  const root = temporaryRoot(t); const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = 0;
  child.kill = () => { killed += 1; return true; }; child.unref = () => {};
  const output = new PassThrough();
  output.end = (callback) => {
    queueMicrotask(() => { output.emit('error', new Error('disk failed')); callback?.(new Error('disk failed')); });
    return output;
  };
  const promise = runFrozenFunnelStep({ ...FROZEN_FUNNEL_STEPS[0], workerId: 'vm1' }, path.join(root, 'flush-error.log'), {
    workspaceRoot: root, timeoutMs: 500, spawnCommand: () => child, createOutputStream: () => output,
  });
  child.emit('close', 0, null);
  const result = await promise;
  assert.equal(result.verdict, 'failed');
  assert.equal(result.errorCode, 'funnel.step.log-failed');
  assert.equal(result.cleanupComplete, false);
  assert.equal(killed, 1);
});

function remoteTransportFixture(t) {
  const value = fixture(t);
  const keyBytes = Buffer.from('frozen-funnel-test-host-key');
  const keyBase64 = keyBytes.toString('base64');
  const hostKeySha256 = `SHA256:${createHash('sha256').update(keyBytes).digest('base64').replace(/=+$/u, '')}`;
  const knownHostsFile = path.join(value.root, 'known_hosts');
  fs.writeFileSync(knownHostsFile, `vm2 ssh-ed25519 ${keyBase64}\n`, 'utf8');
  const worker = {
    ...value.workers[1], workspaceRoot: 'E:\\remote-worker',
    transport: {
      kind: 'ssh', host: '192.0.2.2', port: 22, identityFile: path.join(value.root, 'id_rsa'),
      knownHostsFile, hostKeyAlias: 'vm2', hostKeyAlgorithm: 'ssh-ed25519', hostKeySha256,
    },
  };
  const implementationHashes = [
    frozenFunnelFileEntry(repoRoot, FROZEN_FUNNEL_RUNNER),
    frozenFunnelFileEntry(repoRoot, 'scripts/testing/run-with-vm3-test-environment.mjs'),
  ];
  const runtimeBinaryHashes = [frozenFunnelFileEntry(repoRoot, 'package.json')];
  const runtimeAuthority = { ...value.runtimeAuthority, implementationHashes, runtimeBinaryHashes };
  const plan = createFrozenFunnelPlan({ ...value, workers: [worker], runtimeAuthority, ...value.keys, executionId: 'transport-funnel' });
  const planPath = path.join(value.root, 'plan.json');
  const publicKeyPath = path.join(value.root, 'public.pem');
  fs.writeFileSync(planPath, JSON.stringify(plan), 'utf8');
  fs.writeFileSync(publicKeyPath, value.keys.publicKeyPem, 'utf8');
  return {
    ...value, worker, plan, planPath, publicKeyPath, outputRoot: path.join(value.root, 'receipts'),
    config: { workers: [worker], sshExecutable: 'ssh-fixture', scpExecutable: 'scp-fixture' },
  };
}

function decodedPowerShell(args) {
  const encoded = args.at(-1);
  return args.includes('-EncodedCommand') ? Buffer.from(encoded, 'base64').toString('utf16le') : '';
}

test('remote transport repairs a clean-HEAD CRLF implementation before runtime distribution and launch', async (t) => {
  const value = remoteTransportFixture(t); const events = []; let probes = 0;
  const launchError = new Error('original launch failure');
  const run = async (command, args) => {
    if (command === 'scp-fixture') {
      if (args.some((arg) => arg.endsWith?.('run-with-vm3-test-environment.mjs'))) events.push('implementation-scp');
      else if (args.some((arg) => arg.endsWith?.('package.json'))) events.push('runtime-scp');
      else events.push('control-scp');
      return '';
    }
    const body = decodedPowerShell(args);
    if (body.includes("$rows=@(")) {
      probes += 1; events.push(`implementation-probe-${probes}`);
      return probes === 1 ? '0|MATCH\n1|MISMATCH\n' : '0|MATCH\n1|MATCH\n';
    }
    if (body.includes('$stage=') && body.includes('funnel implementation transfer mismatch')) {
      events.push('implementation-install');
      assert.match(body, /ReparsePoint/u); assert.match(body, /Move-Item/u);
      return '';
    }
    if (body.includes("git.exe status --porcelain")) events.push('clean-head-check');
    if (body.includes("& node.exe") && body.includes('--worker-plan')) { events.push('launch'); throw launchError; }
    if (body.includes("[Console]::Write('EXISTS')")) return 'MISSING';
    if (body.includes('$stage=') && body.includes('funnel runtime transfer mismatch')) {
      events.push('runtime-install');
      assert.doesNotMatch(body, /Get-FileHash/u);
      assert.match(body, /Security\.Cryptography\.SHA256/u);
    }
    return '';
  };
  await assert.rejects(createFrozenFunnelTransport({ ...value, run })(value.plan.workers[0]), (error) => error === launchError);
  assert.ok(events.indexOf('implementation-scp') < events.indexOf('runtime-scp'));
  assert.ok(events.indexOf('implementation-probe-2') < events.indexOf('runtime-scp'));
  assert.ok(events.indexOf('runtime-scp') < events.indexOf('launch'));
  assert.ok(events.filter((event) => event === 'clean-head-check').length >= 2);
});

test('remote transport preserves the launch error when worker output does not exist', async (t) => {
  const value = remoteTransportFixture(t); const launchError = new Error('fixed launch failure'); let recoveryScp = 0;
  const run = async (command, args) => {
    if (command === 'scp-fixture') {
      if (args.includes('-r')) recoveryScp += 1;
      return '';
    }
    const body = decodedPowerShell(args);
    if (body.includes("$rows=@(")) return '0|MATCH\n1|MATCH\n';
    if (body.includes("& node.exe") && body.includes('--worker-plan')) throw launchError;
    if (body.includes("[Console]::Write('EXISTS')")) return 'MISSING';
    return '';
  };
  await assert.rejects(createFrozenFunnelTransport({ ...value, run })(value.plan.workers[0]), (error) => error === launchError);
  assert.equal(recoveryScp, 0);
});

test('receipt v2 verifies signed distributed authority and rejects re-digested worker or plan substitution', (t) => {
  const value = fixture(t); const [worker] = workerResults(value); const step = worker.results[0];
  const authority = createFrozenFunnelAuthority({ ...value, ...value.keys, outputRoot: value.root });
  fs.writeFileSync(path.join(value.root, 'funnel-authority.json'), JSON.stringify(authority), 'utf8');
  const logPath = path.join(value.root, step.log.path);
  fs.copyFileSync(path.join(value.root, 'workers/vm1', step.log.path), logPath);
  const input = { ...step, logPath, provenance: value.provenance, runtimeAuthority: value.runtimeAuthority,
    startedAt: new Date(step.startedAt), completedAt: new Date(step.completedAt),
    distributedAuthority: { ...frozenFunnelFileEntry(value.root, 'funnel-authority.json'), workerId: worker.workerId, planDigest: value.plan.digest },
  };
  const options = { ...step, receiptDirectory: value.root, provenance: value.provenance, runtimeAuthority: value.runtimeAuthority, runtimePublicKeyPem: value.keys.publicKeyPem };
  const receipt = createTestReceipt(input);
  assert.equal(receipt.schemaVersion, 2); assert.equal(verifyTestReceipt(receipt, options), true);
  for (const replacement of [{ workerId: 'vm2' }, { planDigest: 'f'.repeat(64) }, { sha256: 'f'.repeat(64) }, { path: '../funnel-authority.json' }]) {
    const invalid = createTestReceipt({ ...input, distributedAuthority: { ...input.distributedAuthority, ...replacement } });
    assert.equal(verifyTestReceipt(invalid, options), false);
  }
  assert.equal(verifyTestReceipt(receipt, { ...options, runtimePublicKeyPem: generateCoordinatorSigningKeyPair().publicKeyPem }), false);
  fs.appendFileSync(path.join(value.root, 'workers/vm3/test-desktop-shell.log'), 'changed', 'utf8');
  assert.equal(verifyTestReceipt(receipt, options), false, 'a reusable step requires all distributed worker logs, not only its own');
});
