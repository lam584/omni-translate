import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { distributeWatchRuntime, RUNTIME_CONTROL_PS } from './distribute-watch-runtime.mjs';
import { AUTHORITY_RUNTIME_BINARY_FILES } from './watch-mode-evidence-authority.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-distribution-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const entries = AUTHORITY_RUNTIME_BINARY_FILES.map((file, i) => {
    const bytes = Buffer.from(`runtime fixture ${i}`);
    const dest = path.join(root, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    return { path: file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  const authority = { authorityDigest: 'a'.repeat(64), provenance: { headCommit: 'b'.repeat(40) }, runtimeBinaryHashes: entries };
  const workers = (options.workerIds ?? ['one', 'two']).map((workerId) => ({ workerId, workspaceRoot: 'E:\\source', guestExecutionRoot: 'E:\\runs', vmIdentity: { uuidBios: workerId }, transport: { kind: 'ssh' } }));
  const calls = [], uploads = [], tarCalls = [];
  let verifies = 0;
  const operations = {
    verifyStrictRuntimeAuthority: () => {
      verifies++;
      if (options.initialFailure && verifies === 1) throw new Error('dirty HEAD');
      return { authority: structuredClone(verifies === 2 && options.authorityChanged ? { ...authority, authorityDigest: 'c'.repeat(64) } : authority) };
    },
    readProductionWorkerConfig: () => {
      if (options.invalidPins) throw new Error('invalid pins');
      return { workers };
    },
    runTar: (exe, args, settings) => {
      tarCalls.push(args);
      if (options.tarFail) return { status: 1, stderr: 'tar failure' };
      return spawnSync(exe, args, { ...settings, timeout: 10_000 });
    },
    transport: {
      uploadFile: async (worker, file, remote) => {
        uploads.push({ workerId: worker.workerId, file, remote });
        if (options.uploadFail && worker.workerId === 'one') throw new Error('partial upload');
      },
      executeRemote: async (worker, body, payload) => {
        calls.push({ workerId: worker.workerId, phase: payload.phase, payload });
        assert.equal(body, RUNTIME_CONTROL_PS);
        await new Promise((resolve) => setImmediate(resolve));
        const proof = structuredClone(entries);
        if (payload.phase === 'inspect' && options.changed) proof[0].sha256 = '0'.repeat(64);
        if (payload.phase === 'stage' && options.hashMismatch && worker.workerId === 'one') proof[1].bytes++;
        const identity = { head: authority.provenance.headCommit, bios: worker.vmIdentity.uuidBios, clean: true, cleanCheck: 'git-diff-no-masked-index-flags' };
        if (options.dirty && worker.workerId === 'one') identity.clean = false;
        if (options.wrongHead && worker.workerId === 'one') identity.head = 'd'.repeat(40);
        return { exitCode: 0, stdout: JSON.stringify({ entries: proof, identity }) };
      },
    },
  };
  return { root, entries, operations, calls, uploads, tarCalls, verifies: () => verifies,
    run: () => distributeWatchRuntime({ runtimeAuthorityPath: 'authority.json', workersConfig: 'workers.json', workspaceRoot: root, operations }) };
}

async function failure(f) {
  let error;
  await assert.rejects(f.run(), (e) => { error = e; return true; });
  assert.ok(error instanceof AggregateError);
  assert.ok(fs.existsSync(path.join(error.evidenceRoot, 'failure.json')));
  assert.equal(fs.existsSync(path.join(error.evidenceRoot, 'success.json')), false);
  assert.equal(f.verifies(), 2);
  return error;
}

test('runtime distribution automatically visits all three remote workers', async (t) => {
  const f = fixture(t, { workerIds: ['vm167', 'vm169', 'vm131'] });
  const result = await f.run();
  assert.deepEqual(result.workers.map((entry) => entry.workerId), ['vm167', 'vm169', 'vm131']);
  assert.deepEqual(f.calls.filter((call) => call.phase === 'inspect').map((call) => call.workerId), ['vm167', 'vm169', 'vm131']);
});

test('unchanged: zero runtime uploads, full fourteen-entry reused proofs, parallel workers', async (t) => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(f.uploads.length, 0);
  assert.equal(f.tarCalls.length, 0);
  assert.equal(f.verifies(), 2);
  assert.deepEqual(f.calls.slice(0, 2).map((c) => c.phase), ['inspect', 'inspect']);
  assert.equal(result.status, 'success');
  for (const worker of result.workers) {
    assert.equal(worker.entries.length, 14);
    assert.ok(worker.entries.every((e) => e.status === 'reused'));
    assert.equal(worker.uploadedBytes, 0);
    assert.ok(worker.timings.totalMs >= 0);
  }
  const second = await f.run();
  assert.notEqual(second.evidenceRoot, result.evidenceRoot);
});

test('one changed file: one system tar batch per worker, only that entry uploaded', async (t) => {
  const f = fixture(t, { changed: true });
  const result = await f.run();
  assert.equal(f.uploads.length, 2);
  for (const args of f.tarCalls) assert.deepEqual(args.slice(4), [f.entries[0].path]);
  for (const worker of result.workers) {
    assert.equal(worker.uploadedFiles, 1);
    assert.equal(worker.entries.filter((e) => e.status === 'copied').length, 1);
    assert.ok(worker.archive.bytes > 0);
    assert.match(worker.archive.sha256, /^[a-f0-9]{64}$/);
  }
});

test('final hash mismatch retains all workers and does not publish success', async (t) => {
  const f = fixture(t, { hashMismatch: true });
  const error = await failure(f);
  assert.ok(fs.existsSync(path.join(error.evidenceRoot, 'two/verified.json')));
  assert.ok(fs.existsSync(path.join(error.evidenceRoot, 'one/failure.json')));
  assert.equal(f.calls.filter((c) => c.phase === 'stage').length, 2);
});

test('partial upload failure collects other worker without retry', async (t) => {
  const f = fixture(t, { changed: true, uploadFail: true });
  const error = await failure(f);
  assert.equal(f.uploads.length, 2);
  assert.ok(fs.existsSync(path.join(error.evidenceRoot, 'two/verified.json')));
  assert.ok(fs.existsSync(path.join(error.evidenceRoot, 'one/delta.tar')));
});

for (const condition of ['dirty', 'wrongHead']) {
  test(`${condition}: refuse before runtime upload, collect other worker`, async (t) => {
    const f = fixture(t, { [condition]: true });
    await failure(f);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.calls.filter((c) => c.workerId === 'one').length, 1);
    assert.equal(f.calls.filter((c) => c.workerId === 'two').length, 2);
  });
}

test('final authority changed refuses aggregate even after worker verification', async (t) => {
  const f = fixture(t, { authorityChanged: true });
  const error = await failure(f);
  assert.match(error.errors[0].message, /authority changed/);
});

test('nonzero tar is checked and every failure is retained', async (t) => {
  const f = fixture(t, { changed: true, tarFail: true });
  const error = await failure(f);
  assert.equal(error.errors.length, 2);
  assert.equal(f.uploads.length, 0);
});

for (const condition of ['initialFailure', 'invalidPins']) {
  test(`${condition}: fail closed before control-plane calls`, async (t) => {
    const f = fixture(t, { [condition]: true });
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 0);
  });
}

test('manifest refuses private keys and traversal even through injected authority seam', async (t) => {
  for (const forbidden of ['id_rsa', '../escape', 'coordinator-signing-private.pem']) {
    const f = fixture(t);
    const verify = f.operations.verifyStrictRuntimeAuthority;
    f.operations.verifyStrictRuntimeAuthority = () => {
      const result = verify();
      result.authority.runtimeBinaryHashes[0].path = forbidden;
      return result;
    };
    await assert.rejects(f.run(), /invalid runtime manifest/);
    assert.equal(f.calls.length, 0);
  }
});

test('control script parses in PowerShell and retains required safety checks', { skip: process.platform !== 'win32' }, () => {
  const encoded = Buffer.from(RUNTIME_CONTROL_PS).toString('base64');
  const command = `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }`;
  const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  assert.equal(parsed.status, 0, parsed.stdout + parsed.stderr);
  assert.match(RUNTIME_CONTROL_PS, /ReparsePoint/);
  assert.doesNotMatch(RUNTIME_CONTROL_PS, /hash-object|trackedContentVerified/);
  assert.match(RUNTIME_CONTROL_PS, /masked or non-regular index flags/);
  assert.match(RUNTIME_CONTROL_PS, /--cached/);
  assert.match(RUNTIME_CONTROL_PS, /--others/);
  assert.doesNotMatch(RUNTIME_CONTROL_PS, /update-index|reset --hard|prepareWorker|id_rsa|private\.pem/);
});

for (const mode of ['success', 'corrupt', 'tracked']) {
test(`local control-plane fixture: actual archive and entry verification (${mode})`, { skip: process.platform !== 'win32' }, async (t) => {
  const corrupt = mode === 'corrupt';
  const f = fixture(t);
  const remoteWorkspace = path.join(f.root, 'remote-workspace');
  fs.mkdirSync(remoteWorkspace);
  assert.equal(spawnSync('git', ['init', remoteWorkspace], { encoding: 'utf8', windowsHide: true }).status, 0);
  for (const entry of f.entries.slice(1)) {
    const dest = path.join(remoteWorkspace, entry.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(f.root, entry.path), dest);
  }
  if (mode === 'tracked') {
    assert.equal(spawnSync('git', ['-C', remoteWorkspace, 'add', '-f', '--', f.entries[1].path], { encoding: 'utf8', windowsHide: true }).status, 0);
  }
  let uploads = 0;
  let round = 0;
  const remoteRoot = (workerId) => path.join(f.root, 'remote-execution', String(round), workerId);
  f.operations.transport = {
    uploadFile: async (worker, archive) => {
      uploads++;
      fs.copyFileSync(archive, path.join(remoteRoot(worker.workerId), 'delta.tar'), fs.constants.COPYFILE_EXCL);
      if (corrupt && worker.workerId === 'one') {
        const file = path.join(remoteRoot(worker.workerId), 'delta.tar');
        const bytes = fs.readFileSync(file);
        bytes[0] ^= 1;
        fs.writeFileSync(file, bytes);
      }
    },
    executeRemote: async (worker, body, payload) => {
      const data = { ...payload, workspaceRoot: remoteWorkspace,
        executionRoot: remoteRoot(worker.workerId),
        testIdentity: { head: payload.head, bios: payload.bios, clean: true, cleanCheck: 'git-diff-no-masked-index-flags' } };
      // Only identity is stubbed: run the actual filesystem, system tar, and hash checks.
      const script = `$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(data)).toString('base64')}')) | ConvertFrom-Json\n${body.replaceAll('$identity = Identity', '$identity = $payload.testIdentity')}`;
      const command = `& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString('base64')}'))))`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
  if (mode === 'tracked') {
    const error = await failure(f);
    assert.equal(error.errors.length, 2);
    assert.ok(error.errors.every((e) => /refusing tracked runtime/.test(e.message)));
    assert.equal(uploads, 0);
    assert.equal(fs.existsSync(path.join(remoteWorkspace, f.entries[0].path)), false);
    return;
  }
  if (corrupt) {
    const error = await failure(f);
    assert.match(error.errors[0].message, /SHA256\/bytes mismatch/);
    assert.equal(fs.existsSync(path.join(remoteRoot('one'), 'runtime')), false);
    assert.ok(fs.existsSync(path.join(error.evidenceRoot, 'two/verified.json')));
    assert.equal(uploads, 2);
    return;
  }
  const result = await f.run();
  assert.equal(uploads, 2);
  assert.ok(result.workers.every((w) => w.entries.filter((e) => e.status === 'copied').length === 1));
  for (const worker of result.workers) {
    for (const entry of f.entries) {
      assert.deepEqual(fs.readFileSync(path.join(remoteRoot(worker.workerId), 'runtime', entry.path)), fs.readFileSync(path.join(f.root, entry.path)));
      assert.deepEqual(fs.readFileSync(path.join(remoteWorkspace, entry.path)), fs.readFileSync(path.join(f.root, entry.path)));
    }
  }
  round++;
  const second = await f.run();
  assert.equal(uploads, 2, 'second new execution must upload no runtime archive');
  assert.notEqual(second.executionId, result.executionId);
  assert.ok(second.workers.every((w) => w.uploadedBytes === 0 && w.entries.every((e) => e.status === 'reused')));
});
}

test('CLI accepts the documented flags and fails at authority verification, not parsing', () => {
  const result = spawnSync(process.execPath, ['scripts/testing/distribute-watch-runtime.mjs', '--runtime-authority', 'missing.json', '--workers-config', 'missing.json'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /Unknown flag/);
  assert.match(result.stderr, /authority path/);
});

test('Git usr first on PATH cannot replace local or control-plane Windows system tar', { skip: process.platform !== 'win32' }, (t) => {
  const gitUsr = path.join(process.env.ProgramFiles, 'Git', 'usr', 'bin');
  const gitTar = path.join(gitUsr, 'tar.exe');
  if (!fs.existsSync(gitTar)) { t.skip('Git GNU tar is not installed at the fixture path'); return; }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${gitUsr};${env[pathKey] ?? ''}`;
  const where = spawnSync(path.join(process.env.SystemRoot, 'System32', 'where.exe'), ['tar.exe'], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(where.status, 0, where.stderr);
  assert.equal(where.stdout.trim().split(/\r?\n/)[0].toLowerCase(), gitTar.toLowerCase());
  // Child selection excludes this test. Exercise actual local packing plus the
  // actual PowerShell listing/extraction/install and second-execution reuse.
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=one changed file:|local control-plane fixture:.*\\(success\\)',
    fileURLToPath(import.meta.url)], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /pass 2\b/);
});

test('default transport local worker uses only local PowerShell and proves all runtime files', async (t) => {
  const f = fixture(t);
  delete f.operations.transport;
  f.operations.readConfig = () => ({ workers: [{ workerId: 'local', user: 'VMUser', workspaceRoot: f.root,
    guestExecutionRoot: path.join(f.root, 'guest'), transport: { kind: 'local' }, vmIdentity: { uuidBios: 'local-bios' } }] });
  const executables = [];
  f.operations.runProcess = async (executable) => {
    executables.push(executable);
    return { exitCode: 0, stdout: JSON.stringify({ entries: f.entries, identity: {
      head: 'b'.repeat(40), bios: 'local-bios', clean: true, cleanCheck: 'git-diff-no-masked-index-flags',
    } }) };
  };
  const receipt = await f.run();
  assert.deepEqual(executables, ['powershell.exe', 'powershell.exe']);
  assert.equal(receipt.workers[0].entries.length, 14);
  assert.ok(receipt.workers[0].entries.every((e) => e.status === 'reused'));
  assert.equal(receipt.workers[0].uploadedBytes, 0);
  assert.equal(f.verifies(), 2);
});

test('bounded Identity rejects masked flags and dirty diff without per-file native processes', { skip: process.platform !== 'win32' }, (t) => {
  const f = fixture(t);
  const definitions = RUNTIME_CONTROL_PS.slice(0, RUNTIME_CONTROL_PS.indexOf('\n$identity = Identity'));
  const cases = [
    { count: 1, flag: 'H', expected: true },
    { count: 2000, flag: 'H', expected: true },
    { count: 1, flag: 'h', expected: false },
    { count: 1, flag: 'S', expected: false },
    { count: 1, flag: 'h', fsmonitor: true, expected: false },
    { count: 1, flag: 'H', dirty: true, expected: false },
  ];
  for (const scenario of cases) {
    const data = { ...scenario, workspaceRoot: f.root, head: 'b'.repeat(40), bios: 'test-bios' };
    const script = `$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(data)).toString('base64')}')) | ConvertFrom-Json\n${definitions}\n` + String.raw`
$script:calls = 0
function git.exe {
  $script:calls++
  $global:LASTEXITCODE = 0
  if ($args -contains 'rev-parse') { return $payload.head }
  if ($args -contains 'ls-files' -and ($args -contains '-v' -or $args -contains '-f')) {
    $tag = $payload.flag
    if ($payload.fsmonitor -and $args -contains '-v') { $tag = 'H' }
    for ($i=0; $i -lt $payload.count; $i++) { $tag + ' path with spaces/' + $i + '.txt' }
  }
  if ($args -contains '--quiet' -and $payload.dirty) { $global:LASTEXITCODE = 1 }
}
function Get-CimInstance { return @{UUID=$payload.bios} }
try {
  $identity = Identity
  @{passed=$true; calls=$script:calls; identity=$identity} | ConvertTo-Json -Compress
} catch {
  @{passed=$false; calls=$script:calls; error=$_.Exception.Message} | ConvertTo-Json -Compress
}
`;
    const command = `& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString('base64')}'))))`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const proof = JSON.parse(result.stdout.trim());
    assert.equal(proof.passed, scenario.expected, JSON.stringify(proof));
    assert.ok(proof.calls <= 7);
    if (scenario.expected) {
      assert.equal(proof.calls, 7);
      assert.equal(proof.identity.cleanCheck, 'git-diff-no-masked-index-flags');
      assert.equal(proof.identity.trackedContentVerified, undefined);
    }
  }
});
