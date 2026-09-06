import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepareWatchRelease, preflightWatchRelease, parsePrepareWatchReleaseArgs } from './prepare-watch-release.mjs';

function fixture(t, fail) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-watch-release-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const calls = [];
  const head = 'a'.repeat(40);
  const authorityPath = path.join(root, 'completed.json');
  const frozen = Buffer.from('same signed bytes, key identity and frozen runtime');
  fs.writeFileSync(authorityPath, frozen);
  const step = (name, value) => async (...args) => {
    calls.push({ name, args });
    await new Promise((resolve) => setImmediate(resolve));
    if (fail === name) throw new Error(`${name} failure`);
    return value;
  };
  const operations = {
    provenance: step('clean', { captureStatus: 'captured', headCommit: head, worktreeClean: true, dirtyEntryCount: 0 }),
    preflight: step('preflight', { schemaVersion: 1, verified: true, workers: [{ workerId: 'one', verified: true, headCommit: head }] }),
    prepareStrictRuntimeAuthority: step('build', { authorityPath }),
    verifyStrictRuntimeAuthority: step('verify', { authorityPath }),
    distributeWatchRuntime: step('distribute', { schemaVersion: 1, artifactKind: 'watch-runtime-distribution', status: 'success', workers: [{ workerId: 'one' }] }),
    provider: () => assert.fail('Provider must not run'),
  };
  return { root, calls, operations, authorityPath, frozen,
    run: (extra = {}) => prepareWatchRelease({ workspaceRoot: root, workersConfig: 'pins.json', releaseId: 'test-release', operations, ...extra }) };
}

test('awaits clean/preflight/build/distribute; passes exact paths and preserves frozen bytes', async (t) => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.ready, true);
  assert.deepEqual(f.calls.map((c) => c.name), ['clean', 'preflight', 'build', 'distribute']);
  assert.deepEqual(f.calls.at(-1).args[0], { runtimeAuthorityPath: f.authorityPath, workersConfig: 'pins.json', workspaceRoot: f.root });
  assert.deepEqual(fs.readFileSync(f.authorityPath), f.frozen);
  const record = JSON.parse(fs.readFileSync(result.recordPath));
  assert.equal(record.outcome, 'ready'); assert.equal(record.providerInvocations, 0);
  assert.equal(record.cargoBuildJobs, 2);
  for (const entry of [record, ...record.stages]) {
    assert.ok(entry.started); assert.ok(entry.completed); assert.ok(entry.durationMs >= 0);
  }
});

for (const [failure, order] of [
  ['clean', ['clean']], ['preflight', ['clean', 'preflight']],
  ['build', ['clean', 'preflight', 'build']], ['distribute', ['clean', 'preflight', 'build', 'distribute']],
]) test(`${failure} fails overall, retains records and never retries`, async (t) => {
  const f = fixture(t, failure);
  await assert.rejects(f.run(), (error) => {
    const record = JSON.parse(fs.readFileSync(error.recordPath));
    assert.equal(record.outcome, 'failed'); assert.equal(record.failures.length, 1);
    assert.equal(record.failures[0].rootCause, 'undetermined');
    assert.equal(record.stages.at(-1).outcome, 'failed');
    return true;
  });
  assert.deepEqual(f.calls.map((c) => c.name), order);
});

test('resume verifies explicit completed authority, zero builds, fresh execution per invocation', async (t) => {
  const f = fixture(t);
  const first = await f.run({ runtimeAuthorityPath: f.authorityPath });
  const second = await f.run({ runtimeAuthorityPath: f.authorityPath });
  assert.notEqual(first.executionId, second.executionId);
  assert.deepEqual(f.calls.map((c) => c.name), ['clean', 'preflight', 'verify', 'distribute', 'clean', 'preflight', 'verify', 'distribute']);
  assert.equal(f.calls[2].args[0], f.authorityPath);
  assert.deepEqual(fs.readFileSync(f.authorityPath), f.frozen);
});

test('invalid resumed authority cannot build or distribute', async (t) => {
  const f = fixture(t, 'verify');
  await assert.rejects(f.run({ runtimeAuthorityPath: f.authorityPath }), /verify failure/);
  assert.deepEqual(f.calls.map((c) => c.name), ['clean', 'preflight', 'verify']);
});

test('malformed preflight or distribution receipt cannot claim ready', async (t) => {
  const f = fixture(t);
  f.operations.preflight = async () => ({ verified: true });
  await assert.rejects(f.run(), /schema-v1/);
  assert.equal(f.calls.some((c) => c.name === 'build'), false);
  const g = fixture(t);
  g.operations.distributeWatchRuntime = async () => ({ status: 'failed' });
  await assert.rejects(g.run(), /distribution reported failure/);
});

test('real config validation rejects invalid schema before process invocation', async (t) => {
  const f = fixture(t);
  await assert.rejects(preflightWatchRelease({ workersConfig: { schemaVersion: 999 }, workspaceRoot: f.root,
    provenance: {}, operationRoot: f.root, run: () => assert.fail('no network') }));
});

test('CLI requires config and accepts only the three supported flags', () => {
  assert.throws(() => parsePrepareWatchReleaseArgs([]), /required/);
  assert.throws(() => parsePrepareWatchReleaseArgs(['--workers-config']), /invalid/);
  assert.throws(() => parsePrepareWatchReleaseArgs(['--provider', 'x']), /invalid/);
  assert.deepEqual(parsePrepareWatchReleaseArgs(['--workers-config', 'a', '--runtime-authority', 'b', '--release-id', 'c']),
    { workersConfig: 'a', runtimeAuthorityPath: 'b', releaseId: 'c' });
});

test('schema2 local native copy plus two parallel pinned SSH probes; failures retained per worker', async (t) => {
  const f = fixture(t);
  const config = { schemaVersion: 2, artifactKind: 'watch-mode-production-shard-workers', workers: ['vm171', 'vm167', 'vm169'].map((workerId, index) => {
    fs.writeFileSync(path.join(f.root, `${workerId}.key`), 'fixture');
    fs.writeFileSync(path.join(f.root, `${workerId}.hosts`), `${workerId} ssh-ed25519 ${Buffer.from(`key-${index}`).toString('base64')}\n`);
    return { workerId, user: 'VMUser', workspaceRoot: f.root, guestExecutionRoot: path.join(f.root, workerId),
      transport: index === 0 ? { kind: 'local' } : { kind: 'ssh', host: `192.0.2.${index}`, port: 22,
        identityFile: `${workerId}.key`, knownHostsFile: `${workerId}.hosts`, hostKeyAlias: workerId },
      vmIdentity: { provider: 'vmware', uuidBios: `564d0000-0000-0000-0000-00000000000${index}` },
      deviceProfileInstances: [{ instanceId: `${workerId}-default`, profileId: `${workerId}-speaker`, deviceClass: 'default-speaker',
        physicalPlaybackDeviceId: `{${workerId}}`, expectedPhysicalPlaybackDeviceName: `Speaker ${workerId}` }] };
  }) };
  let remoteStarted = 0; let release;
  const barrier = new Promise((r) => { release = r; });
  const commands = [];
  const run = async (exe, args, options) => {
    assert.ok(options.env.PSModulePath.includes('WindowsPowerShell'));
    commands.push({ exe, args });
    if (exe === 'scp.exe') {
      assert.ok(!args.at(-1).includes('\\')); assert.ok(!args.at(-2).includes('\\'));
      const localPath = (operand) => operand.replace(/^VMUser@[^:]+:/u, '');
      fs.copyFileSync(localPath(args.at(-2)), localPath(args.at(-1)));
      return { stdout: '' };
    }
    const body = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    if (exe === 'ssh.exe') {
      assert.ok(args.includes('StrictHostKeyChecking=yes'));
      assert.ok(args.some((v) => v.startsWith('UserKnownHostsFile=')));
    } else assert.equal(exe, 'powershell.exe');
    if (body.includes('rev-parse --verify HEAD')) {
      assert.ok(body.includes(f.root));
      assert.ok(body.includes('git.exe ls-files -v'));
      assert.ok(body.includes('masked source content cannot be verified'));
      assert.ok(body.includes('status --porcelain=v1 --untracked-files=all'));
      assert.ok(body.includes('diff --no-ext-diff --quiet HEAD --'));
      assert.equal((body.match(/& git\.exe\b/gu) ?? []).length, 4);
      assert.doesNotMatch(body, /hash-object|foreach\s*\(/iu);
      if (exe === 'ssh.exe') { remoteStarted++; if (remoteStarted === 2) release(); await barrier; }
      const destination = /New-Item -ItemType Directory -Path '([^']+)'/u.exec(body)[1];
      fs.mkdirSync(destination, { recursive: true });
      return { stdout: '' };
    }
    const file = /\$p='([^']+)'/u.exec(body)[1];
    return { stdout: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  };
  const result = await preflightWatchRelease({ workersConfig: config, workspaceRoot: f.root,
    provenance: { headCommit: 'a'.repeat(40) }, operationRoot: f.root, run });
  assert.equal(result.workers.length, 3); assert.equal(remoteStarted, 2);
  assert.equal(commands.filter((c) => c.exe === 'powershell.exe').length, 2);
  assert.equal(commands.filter((c) => c.exe === 'scp.exe').length, 4);
  const failedRoot = path.join(f.root, 'failed'); fs.mkdirSync(failedRoot);
  await assert.rejects(preflightWatchRelease({ workersConfig: config, workspaceRoot: f.root,
    provenance: { headCommit: 'a'.repeat(40) }, operationRoot: failedRoot,
    run: async () => { throw new Error('HEAD mismatch: source sync prerequisite'); } }), /source sync/);
  for (let i = 0; i < 3; i++) {
    const record = JSON.parse(fs.readFileSync(path.join(failedRoot, `worker-${i}.json`)));
    assert.equal(record.verified, false); assert.equal(record.failure.rootCause, 'undetermined');
  }
});

test('local runner discovers commands in native Windows PowerShell under inherited PowerShell module pollution', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const f = fixture(t);
  const originalModules = process.env.PSModulePath;
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
  const originalPath = process.env[pathKey];
  const gitUsr = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin');
  const hasGitSsh = ['ssh.exe', 'scp.exe'].every((file) => fs.existsSync(path.join(gitUsr, file)));
  if (hasGitSsh) {
    // Force the supported Git-usr fallback, without opening a connection or changing installed tools.
    process.env[pathKey] = originalPath.split(';').filter((entry) => !/[\\/]OpenSSH[\\/]?$|[\\/]git[\\/]usr[\\/]bin[\\/]?$/iu.test(entry)).join(';');
  }
  // Model a PS7 host: its module directories must not shadow Windows PowerShell modules.
  process.env.PSModulePath = `${process.env.ProgramFiles}\\PowerShell\\7\\Modules;${originalModules ?? ''}`;
  t.after(() => {
    process.env[pathKey] = originalPath;
    if (originalModules === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = originalModules;
  });
  const workerId = 'vm171';
  const config = { schemaVersion: 2, artifactKind: 'watch-mode-production-shard-workers', workers: [{
    workerId, user: 'VMUser', workspaceRoot: f.root, guestExecutionRoot: path.join(f.root, 'guest'),
    transport: { kind: 'local' }, vmIdentity: { provider: 'vmware', uuidBios: '564d0000-0000-0000-0000-000000000000' },
    deviceProfileInstances: [{ instanceId: `${workerId}-default`, profileId: `${workerId}-speaker`, deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: `{${workerId}}`, expectedPhysicalPlaybackDeviceName: `Speaker ${workerId}` }],
  }] };
  let nativeCalls = 0;
  const run = async (exe, args, options) => {
    assert.equal(exe, 'powershell.exe');
    const original = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const discovery = "$ErrorActionPreference='Stop'; Get-Command Get-FileHash,Get-CimInstance,New-Item,Get-Item,git.exe,ssh.exe,scp.exe -ErrorAction Stop | Out-Null; "
      + (hasGitSsh ? "foreach($name in @('ssh.exe','scp.exe')){if((Get-Command $name -ErrorAction Stop).Source -notmatch '\\\\git\\\\usr\\\\bin\\\\'){throw 'SSH/SCP did not resolve through Git usr PATH'}}; " : '');
    // Do not query BIOS or the real checkout. Exercise native module discovery, directory creation and hashing.
    const body = original.includes('rev-parse --verify HEAD')
      ? discovery + original.slice(original.indexOf('New-Item -ItemType Directory'))
      : discovery + original;
    const result = spawnSync(exe, [...args.slice(0, -1), Buffer.from(body, 'utf16le').toString('base64')], {
      ...options, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    nativeCalls++;
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return { stdout: result.stdout };
  };
  const result = await preflightWatchRelease({ workersConfig: config, workspaceRoot: f.root,
    provenance: { headCommit: 'a'.repeat(40) }, operationRoot: f.root, run });
  assert.equal(result.verified, true);
  assert.equal(nativeCalls, 2);
});
