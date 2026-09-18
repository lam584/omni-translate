import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createRemoteProviderPreflightDispatch,
  validateRemotePreflightRequest,
  writeAndExit,
} from './run-watch-mode-provider-preflight-worker.mjs';
import { sha256Canonical } from './watch-mode-shard-authority.mjs';

const SHA = 'a'.repeat(64);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const request = (workerId = 'vm131') => ({
  schemaVersion: 1,
  artifactKind: 'watch-mode-remote-provider-preflight-request',
  executionId: 'remote-preflight-fixture',
  executor: {
    workerId, interactiveUser: 'VMUser',
    workspaceRoot: 'E:\\watch-worker',
    transportAuthority: { kind: 'ssh', hostKeyAlias: workerId, hostKeyAlgorithm: 'ssh-ed25519', hostKeySha256: `SHA256:${'A'.repeat(43)}` },
    vmIdentity: { provider: 'vmware', uuidBios: '969f4d56-84f8-d592-ca8a-4536ae2cd4ec' },
    vmIdentityDigest: sha256Canonical({ provider: 'vmware', uuidBios: '969f4d56-84f8-d592-ca8a-4536ae2cd4ec' }), runtimeBundleDigest: SHA,
    readinessAuthority: { path: `worker-readiness/${workerId}.json`, bytes: 10, sha256: SHA, providerCalls: 0, workerId },
  },
  grantPath: 'E:\\remote\\provider-preflight-grant.json',
  leaseReservationDirectory: 'E:\\remote\\provider-preflight-lease-reservations',
  authorizationDigest: SHA,
  executablePath: 'E:\\watch-worker\\target\\release\\omni-desktop-shell.exe',
  outputDirectory: 'E:\\remote\\evidence',
});

const observation = () => ({
  observedWorkerId: 'vm131', observedInteractiveUser: 'VMUser',
  observedVmIdentity: request().executor.vmIdentity,
  observedRuntimeBundleDigest: SHA,
  observedReadinessAuthority: request().executor.readinessAuthority,
});

test('request binds one vm131 executor and fixed no-retry budget', () => {
  const value = validateRemotePreflightRequest(request(), observation());
  assert.equal(value.executor.workerId, 'vm131');
  assert.equal(value.lifecycleBudget.firstServerEventLatencyMs, 1_200);
  assert.equal(value.retryPolicy, 'new-execution-required');
});

test('request accepts a different explicitly signed SSH executor instead of a fixed worker name', () => {
  const signed = request('vm167');
  const observed = {
    ...observation(),
    observedWorkerId: 'vm167',
    observedVmIdentity: signed.executor.vmIdentity,
    observedReadinessAuthority: signed.executor.readinessAuthority,
  };
  const value = validateRemotePreflightRequest(signed, observed);
  assert.equal(value.executor.workerId, 'vm167');
  assert.equal(value.retryPolicy, 'new-execution-required');
});

test('identity, runtime hash, and readiness mismatch fail before Provider dispatch', async () => {
  for (const overrides of [
    { observedWorkerId: 'vm169' },
    { observedRuntimeBundleDigest: 'b'.repeat(64) },
    { observedReadinessAuthority: { ...request().executor.readinessAuthority, sha256: 'b'.repeat(64) } },
  ]) {
    let calls = 0;
    const dispatch = createRemoteProviderPreflightDispatch({
      inspectExecutor: async () => ({ ...observation(), ...overrides }),
      claimAuthorization: async () => ({ claimed: true }),
      runProviderPreflight: async () => { calls += 1; return { status: 'completed' }; },
      collectEvidence: async (result) => result,
    });
    await assert.rejects(dispatch(request()));
    assert.equal(calls, 0);
  }
});

test('existing claim is zero-call; SSH and collection failures never retry or fall back', async () => {
  let calls = 0;
  const base = {
    inspectExecutor: async () => observation(),
    runProviderPreflight: async () => { calls += 1; throw new Error('ssh failed'); },
    collectEvidence: async () => { throw new Error('collection failed'); },
  };
  await assert.rejects(createRemoteProviderPreflightDispatch({ ...base, claimAuthorization: async () => ({ claimed: false }) })(request()), /already consumed/);
  assert.equal(calls, 0);
  await assert.rejects(createRemoteProviderPreflightDispatch({ ...base, claimAuthorization: async () => ({ claimed: true }) })(request()), /ssh failed/);
  assert.equal(calls, 1);
  await assert.rejects(createRemoteProviderPreflightDispatch({
    ...base, claimAuthorization: async () => ({ claimed: true }),
    runProviderPreflight: async () => { calls += 1; return { status: 'completed' }; },
  })(request()), /collection failed/);
  assert.equal(calls, 2);
});

test('secret-shaped material is rejected from request JSON', () => {
  for (const [key, value] of [['apiKey', 'secret'], ['credential', 'secret'], ['environment', { TOKEN: 'secret' }], ['argv', ['secret']]]) {
    assert.throws(() => validateRemotePreflightRequest({ ...request(), [key]: value }, observation()), /unexpected|secret/i);
  }
  assert.doesNotMatch(JSON.stringify(request()), /api.?key|credential|secret/i);
});

test('CLI exits after publishing a completed result even when a dependency leaves an active handle', async () => {
  const moduleUrl = pathToFileURL(path.join(HERE, 'run-watch-mode-provider-preflight-worker.mjs')).href;
  const source = [
    `import { runRemoteProviderPreflightCli } from ${JSON.stringify(moduleUrl)};`,
    'setInterval(() => {}, 60_000);',
    "await runRemoteProviderPreflightCli({ readRequest: async () => ({}), runWorker: async () => ({ status: 'completed' }) });",
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const result = await Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => {
      child.kill();
      reject(new Error('remote Provider preflight CLI remained alive after publishing its result'));
    }, 2_000)),
  ]);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(stdout, '{"status":"completed"}\n');
  assert.equal(stderr, '');
});

test('CLI stream publication failures can never exit successfully', () => {
  for (const [stream, writeSync] of [
    [{}, () => {}],
    [{ fd: 1 }, () => { throw new Error('synchronous file-descriptor failure'); }],
  ]) {
    const exits = [];
    writeAndExit(stream, 'completed\n', 0, (code) => exits.push(code), writeSync);
    assert.deepEqual(exits, [1]);
  }
});

test('CLI publication synchronously commits the file descriptor before exiting', () => {
  const events = [];
  writeAndExit(
    { fd: 7 },
    'completed\n',
    0,
    (code) => events.push(['exit', code]),
    (fd, text, position, encoding) => events.push(['write', fd, text, position, encoding]),
  );
  assert.deepEqual(events, [
    ['write', 7, 'completed\n', null, 'utf8'],
    ['exit', 0],
  ]);
});
