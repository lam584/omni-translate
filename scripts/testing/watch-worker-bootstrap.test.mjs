import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { acceptRediscoveredWorker, buildStrictSshArgs, provisionCredential, validateWorkerPins, verifyPinnedKnownHost } from './watch-worker-bootstrap.mjs';

const worker = (id, suffix) => ({ workerId: id, user: 'VMUser', vmIdentity: { uuidBios: `uuid-${suffix}` }, transport: { kind: 'ssh', host: `192.168.40.${suffix}`, port: 22, identityFile: 'E:\\id_rsa', knownHostsFile: 'C:\\run\\known_hosts', hostKeyAlias: `omni-${id}`, hostKeyAlgorithm: 'ssh-ed25519', hostKeySha256: `SHA256:${(id === 'vm1' ? 'A' : 'B').repeat(43)}` } });

test('worker pins reject duplicate host keys and BIOS UUIDs', () => {
  const a = worker('vm1', '171'); const b = worker('vm2', '167');
  b.transport.hostKeySha256 = a.transport.hostKeySha256;
  assert.throws(() => validateWorkerPins([a, b]), /duplicate SSH host key/);
  b.transport.hostKeySha256 = `SHA256:${'B'.repeat(43)}`; b.vmIdentity.uuidBios = a.vmIdentity.uuidBios;
  assert.throws(() => validateWorkerPins([a, b]), /duplicate BIOS UUID/);
});

test('subnet rediscovery requires both pinned host key and BIOS UUID', () => {
  const expected = worker('vm2', '167');
  const observed = structuredClone(expected); observed.transport.host = '192.168.40.205';
  assert.deepEqual(acceptRediscoveredWorker({ expected, observed }), { workerId: 'vm2', host: '192.168.40.205', identityMatched: true });
  const badKey = structuredClone(observed); badKey.transport.hostKeySha256 = `SHA256:${'Z'.repeat(43)}`;
  assert.throws(() => acceptRediscoveredWorker({ expected, observed: badKey }), /host key/);
  const badBios = structuredClone(observed); badBios.vmIdentity.uuidBios = 'attacker';
  assert.throws(() => acceptRediscoveredWorker({ expected, observed: badBios }), /BIOS UUID/);
});

test('SSH arguments enforce pinned known_hosts and cannot be overridden', () => {
  const target = worker('vm2', '167');
  const args = buildStrictSshArgs({ worker: target });
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('UserKnownHostsFile=C:\\run\\known_hosts'));
  assert.ok(args.includes('HostKeyAlias=omni-vm2'));
  assert.ok(args.includes('ConnectTimeout=15'));
  assert.deepEqual(args.slice(2, 4), ['-p', '22']);
  assert.ok(args.includes('IdentitiesOnly=yes'));
  assert.throws(() => buildStrictSshArgs({ worker: target, extra: ['-o', 'StrictHostKeyChecking=no'] }), /cannot be overridden/);
  const key = Buffer.from('synthetic-ed25519-key');
  target.transport.hostKeySha256 = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
  assert.equal(verifyPinnedKnownHost(target, () => `omni-vm2 ssh-ed25519 ${key.toString('base64')}\n`), target.transport.hostKeySha256);
  target.transport.hostKeySha256 = `SHA256:${'Z'.repeat(43)}`;
  assert.throws(() => verifyPinnedKnownHost(target, () => `omni-vm2 ssh-ed25519 ${key.toString('base64')}\n`), /key material/);
  assert.throws(() => verifyPinnedKnownHost(target, () => 'omni-vm2 ssh-ed25519 !!!\n'), /canonical base64/);
});

test('native helper has a fixed target and no secret argv or environment input', () => {
  const source = fs.readFileSync(new URL('../diagnostics/watch-worker-credential/src/main.rs', import.meta.url), 'utf8');
  assert.match(source, /OmniTranslate:credential___provider_dashscope_default/);
  assert.doesNotMatch(source, /--secret|std::env::var|--target/);
  assert.match(source, /read_bounded_stdin/);
  assert.match(source, /MAX_SECRET_BYTES: usize = 2560/);
  assert.match(source, /Zeroizing::new/);
});

test('credential provision uses pipes and persists metadata only', async () => {
  const calls = [];
  const challenge = Buffer.alloc(32, 3);
  const spawnImpl = (file, args) => {
    calls.push({ file, args });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.at(-1) === 'export') child.stdout.end(Buffer.from('test-only-secret'));
      else if (args.at(-1) === 'import') child.stdout.end(Buffer.from('{"schemaVersion":"watch-worker-credential-import/v1","exists":true,"blobBytes":16}'));
      else child.stdout.end(Buffer.alloc(32, 7));
      child.emit('close', 0);
    });
    return child;
  };
  const receipt = await provisionCredential({
    localHelper: 'local-helper.exe', remoteHelper: 'C:\\Omni\\worker-helper.exe',
    sshArgs: ['-o', 'StrictHostKeyChecking=yes', 'VMUser@192.168.40.167'], spawnImpl,
    randomBytesImpl: () => challenge,
  });
  assert.deepEqual(receipt, { schemaVersion: 'watch-worker-credential-provision/v1', exists: true, blobBytes: 16, matches: true });
  assert.equal(JSON.stringify(calls).includes('test-only-secret'), false);
  assert.deepEqual(calls[0].args, ['export']);
  assert.ok(calls.every((call) => call.args.every((arg) => !/secret|api.?key/i.test(arg))));
  assert.deepEqual(challenge, Buffer.alloc(32), 'challenge must be wiped after proof comparison');
  const source = fs.readFileSync(new URL('./watch-worker-bootstrap.mjs', import.meta.url), 'utf8');
  assert.match(source, /timingSafeEqual\(local, remote\)/);
  assert.match(source, /local\?\.fill\(0\)/);
  assert.match(source, /remote\?\.fill\(0\)/);
});

test('PowerShell bootstrap is recoverable and never enables autologon', () => {
  const source = fs.readFileSync(new URL('./bootstrap-watch-worker.ps1', import.meta.url), 'utf8');
  assert.match(source, /Copy-Item -LiteralPath \$key -Destination \$backup/);
  assert.match(source, /backup was restored/);
  assert.match(source, /backup was restored, but sshd restart also failed/);
  assert.match(source, /failed to secure the new OpenSSH private host key ACL/);
  assert.match(source, /ServiceControllerStatus\]::Running/);
  assert.match(source, /S-1-5-18:\(F\)/);
  assert.match(source, /S-1-5-32-544:\(F\)/);
  assert.match(source, /S-1-5-11/);
  assert.match(source, /Unregister-ScheduledTask/);
  assert.doesNotMatch(source, /AutoAdminLogon|DefaultPassword|Winlogon/);
  assert.match(source, /-Action WriteBootReadiness/);
  assert.doesNotMatch(source, /-Command &/);
  const elevation = fs.readFileSync(new URL('./request-watch-worker-bootstrap-elevated.ps1', import.meta.url), 'utf8');
  assert.match(elevation, /-Verb RunAs/);
  assert.match(elevation, /-WindowStyle Hidden/);
});

test('PowerShell host-key rotation preserves ssh-keygen empty passphrase on Windows PowerShell 5', () => {
  const source = fs.readFileSync(new URL('./bootstrap-watch-worker.ps1', import.meta.url), 'utf8');
  assert.match(source, /ssh-keygen\.exe -q -t ed25519 -N '\"\"' -f \$key/);
  assert.doesNotMatch(source, /ssh-keygen\.exe -q -t ed25519 -N '' -f \$key/);
});

test('PowerShell host-key rotation applies owner and ACL operations separately', () => {
  const source = fs.readFileSync(new URL('./bootstrap-watch-worker.ps1', import.meta.url), 'utf8');
  assert.match(source, /icacls\.exe \$key '\/setowner' '\*S-1-5-32-544' \| Out-Null/);
  assert.match(source, /icacls\.exe \$key '\/inheritance:r'/);
  assert.doesNotMatch(source, /'\/setowner' '\*S-1-5-32-544' '\/inheritance:r'/);
});
