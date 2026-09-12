import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyWatchHistory, planWatchTypedHistory,
  runWatchTypedHistory as actualRunWatchTypedHistory, probeWatchHistoryQuiescence,
  auditCapturedWatchHistory, parseWatchTypedHistoryArgs } from './watch-mode-typed-history.mjs';

const quiescent = () => ({ observedAt: new Date().toISOString(), passed: true, matchingProcesses: [] });
const runWatchTypedHistory = (options, operations = {}) => actualRunWatchTypedHistory(options, { probeQuiescence: quiescent, ...operations });

const script = fileURLToPath(new URL('./watch-mode-typed-history.mjs', import.meta.url));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonical(value[name])])) : value;
const json = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8'); };
const roomy = () => ({ bavail: 10n * 1024n ** 3n, bsize: 1n });
const date = (i) => new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString();

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-typed-history-'));
  const root = path.join(base, 'guest'); const references = path.join(base, 'coordinator');
  fs.mkdirSync(root); fs.mkdirSync(references);
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const options = { roots: [{ workerId: 'vm167', kind: 'mixed', path: root }], referenceRoots: [references],
    receiptPath: path.join(base, 'prune.json'), requiredVolumePaths: [base], statfs: roomy,
    now: () => new Date('2026-09-12T06:00:00Z') };
  const add = (i, { workerId = 'vm167', targetRoot = root, name = `watch-prod-test-${String(i).padStart(3, '0')}`,
    verdict = 'passed', collected = true, cleanupPassed = true } = {}) => {
    const execution = path.join(targetRoot, name);
    const shard = path.join(execution, workerId);
    const copyBase = path.join(references, name);
    const copy = path.join(copyBase, 'collected-shards', workerId);
    const cell = { workerId, cellId: 'test::cell', cellIndex: 0, leaseId: 'lease-test' };
    const identity = { workerId, executionId: name, cellId: cell.cellId, leaseId: cell.leaseId, planDigest: 'a'.repeat(64) };
    const time = date(i);
    const interactivePath = path.join(shard, 'interactive/lease-test/terminal.json');
    json(interactivePath, { ...identity, schemaVersion: 2, artifactKind: 'watch-mode-interactive-task-terminal',
      executionReceiptObserved: true, completedAt: time });
    json(path.join(shard, 'interactive/lease-test/task-terminal.json'), { ...identity, schemaVersion: 2,
      artifactKind: 'watch-mode-interactive-scheduled-task-terminal', completedAt: time,
      terminalSha256: sha(fs.readFileSync(interactivePath)) });
    json(path.join(shard, 'interactive/lease-test/cleanup.scheduler.json'), { ...identity, schemaVersion: 1,
      artifactKind: 'watch-mode-interactive-scheduler-cleanup', passed: cleanupPassed, status: 'completed',
      taskCleanupPassed: cleanupPassed, processCleanup: { passed: cleanupPassed, status: 'completed' } });
    json(path.join(shard, 'lease-terminals/lease-test.json'), { ...identity, schemaVersion: 1,
      artifactKind: 'watch-mode-paid-shard-lease-terminal', terminalAt: time, status: verdict });
    json(path.join(shard, 'strict-shard-execution-plan.json'), { schemaVersion: 3, artifactKind: 'watch-mode-paid-shard-execution-plan',
      executionId: name, planDigest: identity.planDigest, cells: [cell] });
    const raw = Buffer.from(`signed raw PCM ${i}`);
    fs.mkdirSync(path.join(shard, 'runs/c01'), { recursive: true });
    fs.writeFileSync(path.join(shard, 'runs/c01/raw.pcm'), raw);
    fs.writeFileSync(path.join(shard, 'runs/c01/report.md'), 'lightweight report');
    const resultPath = path.join(shard, 'runs/c01/shard-cell-result.json');
    json(resultPath, { ...identity, schemaVersion: 3, artifactKind: 'watch-mode-paid-shard-cell-result',
      artifacts: [{ path: 'raw.pcm', bytes: raw.length, sha256: sha(raw) }] });
    const manifest = { schemaVersion: 3, artifactKind: 'watch-mode-paid-shard-manifest', executionId: name, workerId,
      verdict, planDigest: identity.planDigest, generatedAt: time, assignedCellCount: 1,
      // Captured schema 3 manifests used cellIndex + leaseId, without cellId.
      results: [{ cellIndex: 0, leaseId: cell.leaseId, runDirectory: 'runs/c01',
        result: { path: 'runs/c01/shard-cell-result.json', bytes: fs.statSync(resultPath).size, sha256: sha(fs.readFileSync(resultPath)) } }] };
    manifest.manifestDigest = sha(JSON.stringify(canonical(manifest)));
    json(path.join(shard, 'shard-manifest.json'), manifest);
    fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.cpSync(shard, copy, { recursive: true });
    if (collected) json(path.join(copyBase, 'worker-collection-results.json'), {
      schemaVersion: 1, artifactKind: 'watch-mode-worker-collection-results', executionId: name,
      generatedAt: time, allWorkersSettled: true, workers: [{ workerId, status: 'collected' }],
    });
    return { name, execution, shard, copy, copyBase, raw };
  };
  return { base, root, references, options, add };
}

test('mixed root typing matches captured runtime/isolation/control/report layouts', () => {
  for (const [name, type] of [['runtime-abc', 'runtime'], ['local-isolation-' + 'a'.repeat(64), 'isolation'],
    ['watch-prod-r71-example', 'execution'], ['.provider-preflight', 'container'], ['li', 'container'],
    ['artifacts', 'container'], ['watch-source-sync', 'container'], ['readiness-old', 'unknown']]) {
    assert.equal(classifyWatchHistory(name), type);
  }
  assert.equal(classifyWatchHistory('anything', 'reports'), 'reports');
});

test('FIFO is newest 30 globally per worker across roots, by terminal time not mutable directory mtime', (t) => {
  const f = fixture(t); const other = path.join(f.base, 'other'); fs.mkdirSync(other);
  f.options.roots.push({ workerId: 'vm167', kind: 'executions', path: other });
  for (let i = 0; i < 34; i += 1) {
    const run = f.add(i, { targetRoot: i % 2 ? other : f.root });
    fs.utimesSync(run.execution, new Date('2030-01-01'), new Date(2030, 0, 1, 0, 34 - i));
  }
  const plan = planWatchTypedHistory(f.options);
  assert.deepEqual(plan.entries.filter((e) => e.action === 'delete').map((e) => e.name).sort(),
    ['000', '001', '002', '003'].map((i) => `watch-prod-test-${i}`));
  assert.equal(plan.entries.filter((e) => e.reason === 'newest-terminal-history').length, 30);
});

test('worker FIFOs are separate on all four hosts', (t) => {
  const f = fixture(t);
  for (const workerId of ['vm171', 'vm169', 'vm131']) {
    const root = path.join(f.base, workerId); fs.mkdirSync(root);
    f.options.roots.push({ workerId, kind: 'mixed', path: root });
  }
  for (const root of f.options.roots) for (let i = 0; i < 31; i += 1) {
    f.add(i, { workerId: root.workerId, targetRoot: root.path, name: `watch-prod-${root.workerId}-${i}` });
  }
  const plan = planWatchTypedHistory(f.options);
  assert.equal(plan.entries.filter((e) => e.action === 'delete').length, 4);
  for (const root of f.options.roots) assert.equal(plan.entries.filter((e) => e.workerId === root.workerId && e.action === 'retain').length, 30);
});

test('caller pins current/previous runtime and old failed baseline independently of age/count', (t) => {
  const f = fixture(t);
  f.options.protectedIds = ['watch-prod-current', 'watch-prod-previous', 'runtime-current', 'watch-prod-baseline'];
  for (const name of f.options.protectedIds) f.add(0, { name, verdict: 'failed' });
  for (let i = 1; i <= 31; i += 1) f.add(i);
  const plan = planWatchTypedHistory(f.options);
  assert.equal(plan.entries.filter((e) => e.reason === 'explicit-protection').length, 4);
  assert.equal(plan.entries.filter((e) => e.action === 'delete').length, 1);
  assert.equal(plan.summary.totalMayExceed30, true);
});

test('missing collected history, unknown receipts, active/incomplete executions and dependency trees are protected', (t) => {
  const f = fixture(t);
  const missing = f.add(0, { collected: false });
  const active = f.add(1, { cleanupPassed: false });
  const explicit = f.add(2, { verdict: 'failed' }); f.options.activeIds = [explicit.name];
  for (const name of ['test-receipts', 'artifacts', '.provider-preflight', 'li', 'runtime-old', 'local-isolation-old', 'unexpected']) fs.mkdirSync(path.join(f.root, name));
  const plan = planWatchTypedHistory(f.options);
  assert.equal(plan.entries.some((entry) => entry.action === 'delete'), false);
  assert.match(plan.entries.find((entry) => entry.name === missing.name).reason, /collected coordinator reference/u);
  assert.match(plan.entries.find((entry) => entry.name === active.name).reason, /cleanup/u);
  assert.equal(plan.entries.find((entry) => entry.name === 'runtime-old').reason, 'cache-retirement-not-enabled');
  assert.equal(plan.warnings.length, plan.entries.length);
});

test('dry-run writes immutable intent and does not delete or strip raw PCM in retained signed evidence', (t) => {
  const f = fixture(t); const runs = Array.from({ length: 32 }, (_, i) => f.add(i));
  const result = runWatchTypedHistory(f.options);
  assert.equal(result.verdict, 'dry-run'); assert.equal(result.deleted.length, 0);
  assert.equal(result.plan.summary.deletionCandidates, 2);
  for (const run of runs) {
    assert.deepEqual(fs.readFileSync(path.join(run.shard, 'runs/c01/raw.pcm')), run.raw);
    assert.deepEqual(fs.readFileSync(path.join(run.copy, 'runs/c01/raw.pcm')), run.raw);
  }
  assert.equal(fs.existsSync(`${f.options.receiptPath}.outcome.json`), false);
  assert.throws(() => runWatchTypedHistory(f.options), /EEXIST/u);
});

test('apply writes intent and in-progress receipt before any delete; collected reports/evidence survive', (t) => {
  const f = fixture(t); const runs = Array.from({ length: 32 }, (_, i) => f.add(i));
  const result = runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true }, { beforeDelete: (entry) => {
    assert.ok(JSON.parse(fs.readFileSync(f.options.receiptPath, 'utf8')).entries.find((e) => e.path === entry.path && e.action === 'delete'));
    assert.equal(JSON.parse(fs.readFileSync(`${f.options.receiptPath}.outcome.json`, 'utf8')).verdict, 'in-progress');
  } });
  assert.equal(result.deleted.length, 2); assert.equal(result.verdict, 'passed');
  assert.equal(fs.existsSync(runs[0].execution), false);
  for (const run of runs) {
    assert.equal(fs.readFileSync(path.join(run.copy, 'runs/c01/report.md'), 'utf8'), 'lightweight report');
    assert.deepEqual(fs.readFileSync(path.join(run.copy, 'runs/c01/raw.pcm')), run.raw);
  }
  assert.deepEqual(fs.readFileSync(path.join(runs[31].shard, 'runs/c01/raw.pcm')), runs[31].raw);
});

test('per-entry removal errors continue other entries but fail the outcome', (t) => {
  const f = fixture(t); const runs = Array.from({ length: 33 }, (_, i) => f.add(i)); let calls = 0;
  assert.throws(() => runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true }, {
    removeDirectory: (target, entry) => {
      calls += 1;
      assert.equal(path.dirname(target), f.root);
      if (entry.path === runs[0].execution) throw new Error('injected access denied');
      fs.rmSync(target, { recursive: true, force: false });
    },
  }), /apply failed/u);
  assert.equal(calls, 3); assert.equal(fs.existsSync(runs[0].execution), true);
  const outcome = JSON.parse(fs.readFileSync(`${f.options.receiptPath}.outcome.json`, 'utf8'));
  assert.equal(outcome.verdict, 'failed'); assert.equal(outcome.deleted.length, 2); assert.equal(outcome.errors.length, 1);
});

for (const mutation of ['raw', 'terminal', 'reference', 'protect']) test(`revalidates ${mutation} immediately before deletion`, (t) => {
  const f = fixture(t); const runs = Array.from({ length: 31 }, (_, i) => f.add(i));
  const options = { ...f.options, apply: true, confirmQuiescent: true, activeIds: [] };
  let deleted = false;
  assert.throws(() => runWatchTypedHistory(options, {
    beforeDelete: () => {
      if (mutation === 'raw') fs.appendFileSync(path.join(runs[0].shard, 'runs/c01/raw.pcm'), 'changed');
      else if (mutation === 'terminal') json(path.join(runs[0].copy, 'lease-terminals/lease-test.json'), { status: 'running' });
      else if (mutation === 'reference') json(path.join(runs[0].copyBase, 'worker-collection-results.json'), { allWorkersSettled: false });
      else options.activeIds.push(runs[0].name);
    },
    removeDirectory: () => { deleted = true; },
  }), /apply failed/u);
  assert.equal(deleted, false); assert.equal(fs.existsSync(runs[0].execution), true);
});

test('rejects relative, overlapping, volume-root and junction-ancestor roots', (t) => {
  const f = fixture(t);
  const planWith = (roots) => planWatchTypedHistory({ ...f.options, roots });
  assert.throws(() => planWith([{ workerId: 'vm167', kind: 'mixed', path: 'relative' }]), /absolute/u);
  assert.throws(() => planWith([...f.options.roots, ...f.options.roots]), /duplicate or overlapping/u);
  assert.throws(() => planWith([{ workerId: 'vm167', kind: 'mixed', path: path.parse(f.root).root }]), /volume root/u);
  fs.symlinkSync(f.root, path.join(f.base, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => planWith([{ workerId: 'vm167', kind: 'mixed', path: path.join(f.base, 'alias') }]), /symlink\/reparse/u);
});

test('nested and direct-child junctions never escape, including a junction swapped in after planning', (t) => {
  const f = fixture(t); const runs = Array.from({ length: 31 }, (_, i) => f.add(i));
  const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'valuable'), 'keep');
  fs.symlinkSync(outside, path.join(f.root, 'watch-prod-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const nested = path.join(runs[0].shard, 'escape');
  fs.symlinkSync(outside, nested, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(planWatchTypedHistory(f.options).entries.some((entry) => entry.action === 'delete'), false);
  fs.unlinkSync(nested);
  assert.throws(() => runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true }, {
    beforeDelete: () => fs.symlinkSync(outside, nested, process.platform === 'win32' ? 'junction' : 'dir'),
    removeDirectory: () => assert.fail('must not remove'),
  }), /apply failed/u);
  assert.equal(fs.readFileSync(path.join(outside, 'valuable'), 'utf8'), 'keep');
});

test('missing or changed collected raw PCM is never accepted as collection proof', (t) => {
  const f = fixture(t); const runs = Array.from({ length: 31 }, (_, i) => f.add(i));
  fs.writeFileSync(path.join(runs[0].copy, 'runs/c01/raw.pcm'), 'corrupted');
  const plan = planWatchTypedHistory(f.options);
  assert.equal(plan.summary.deletionCandidates, 0);
  assert.match(plan.entries.find((entry) => entry.name === runs[0].name).reason, /mismatch/u);
});

test('reference roots inside a deletion target, stale collection identities and future times retain evidence', (t) => {
  const f = fixture(t); const runs = Array.from({ length: 31 }, (_, i) => f.add(i));
  const file = path.join(runs[0].copyBase, 'worker-collection-results.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const override of [{ executionId: 'other' }, { workers: [{ workerId: 'vm169', status: 'collected' }] },
    { generatedAt: '2030-01-01T00:00:00Z' }]) {
    json(file, { ...original, ...override });
    assert.equal(planWatchTypedHistory(f.options).summary.deletionCandidates, 0);
  }
  json(file, original);
  assert.equal(planWatchTypedHistory({ ...f.options, protectedPaths: [runs[0].execution] }).summary.deletionCandidates, 0);
});

test('occupied intent/outcome receipt and low-space checks prevent all deletion without sacrificing newest 30', (t) => {
  const f = fixture(t); for (let i = 0; i < 31; i += 1) f.add(i);
  const options = { ...f.options, apply: true, confirmQuiescent: true };
  assert.throws(() => runWatchTypedHistory({ ...options, statfs: () => ({ bavail: 0n, bsize: 1n }), warn: () => {} }), /free-space floor/u);
  assert.equal(fs.existsSync(options.receiptPath), false);
  fs.writeFileSync(`${options.receiptPath}.outcome.json`, 'occupied');
  assert.throws(() => runWatchTypedHistory(options, { removeDirectory: () => assert.fail('must not delete') }), /EEXIST/u);
  assert.equal(fs.readdirSync(f.root).length, 31);
  assert.throws(() => runWatchTypedHistory({ ...options, receiptPath: path.join(f.root, 'unsafe.json') }), /outside all history roots/u);
});

test('captured inventory is offline review only, uses creation time and cannot authorize apply', (t) => {
  const f = fixture(t); const file = path.join(f.base, 'vm167.json');
  json(file, { at: '2026-09-12T05:55:00Z', root: 'E:\\omni-shards-run3', directories: [
    { name: 'watch-prod-current', path: 'E:\\omni-shards-run3\\watch-prod-current', created: date(1), modified: date(99) },
    { name: 'runtime-old', path: 'E:\\omni-shards-run3\\runtime-old', created: date(0) },
  ] });
  const report = auditCapturedWatchHistory({ inventories: [{ workerId: 'vm167', file }] });
  assert.equal(report[0].liveAuthority, false);
  assert.equal(report[0].entries[0].createdAt, date(1));
  assert.ok(report[0].entries.every((entry) => entry.action === 'retain'));
  assert.throws(() => parseWatchTypedHistoryArgs(['--apply', '--inventory', `vm167=${file}`, '--receipt', f.options.receiptPath]), /offline dry-run only/u);
});

test('CLI dry-run and explicit quiescent apply execute offline with absolute roots/receipts', (t) => {
  const f = fixture(t); f.add(0);
  const args = ['--root', `vm167=mixed=${f.root}`, '--reference-root', f.references, '--protect', 'current', '--volume', f.base];
  const dry = spawnSync(process.execPath, [script, '--dry-run', ...args, '--receipt', f.options.receiptPath], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).verdict, 'dry-run');
  const applyPath = path.join(f.base, 'apply.json');
  const applied = spawnSync(process.execPath, [script, '--apply', '--confirm-quiescent', ...args, '--receipt', applyPath], { encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).deleted.length, 0);
  assert.throws(() => parseWatchTypedHistoryArgs(['--root', 'vm=mixed=relative', '--receipt', applyPath]), /explicit --dry-run/u);
  assert.throws(() => parseWatchTypedHistoryArgs(['--apply', '--receipt', applyPath]), /confirm-quiescent/u);
});

function addCache(f, i, { type = 'isolation', root = f.root, workerId = 'vm167' } = {}) {
  const payload = Buffer.from(`immutable runtime binary ${i}`);
  const file = { path: 'target/release/omni-fixture.exe', bytes: payload.length, sha256: sha(payload) };
  let name; let seal;
  if (type === 'isolation') {
    seal = { schemaVersion: 1, artifactKind: 'watch-mode-local-isolation-runtime-distribution', files: [file] };
    seal.distributionDigest = sha(JSON.stringify(canonical(seal)));
    name = `local-isolation-${seal.distributionDigest}`;
  } else name = `runtime-fixture-${i}`;
  const target = path.join(root, name);
  const relative = type === 'isolation' ? file.path : `${workerId}/runtime/${file.path}`;
  const binary = path.join(target, relative); fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, payload);
  if (type === 'isolation') json(path.join(target, 'runtime-distribution.json'), seal);
  else {
    const worker = { schemaVersion: 1, artifactKind: 'watch-runtime-worker-distribution', workerId,
      executionRoot: path.join(target, workerId), runtimeRoot: path.join(target, workerId, 'runtime'),
      identity: { clean: true }, entries: [{ ...file, status: 'reused' }] };
    seal = { schemaVersion: 1, artifactKind: 'watch-runtime-distribution', executionId: name,
      authorityDigest: 'b'.repeat(64), status: 'success', workers: [worker] };
    json(path.join(f.cacheReceipts, name, 'success.json'), seal);
  }
  return { name, target, binary, payload, seal };
}

function cacheFixture(t) {
  const f = fixture(t); f.cacheReceipts = path.join(f.base, 'distribution-receipts'); fs.mkdirSync(f.cacheReceipts);
  f.options = { ...f.options, retireCaches: true, referencesComplete: true, cacheReceiptRoots: [f.cacheReceipts] };
  return f;
}

const canonicalFixtureNames = ['watch-mode-en-original.wav', 'watch-mode-en-original.sha256',
  'watch-mode-audio-fixtures.json', 'watch-mode-en-original.txt', 'watch-mode-en-original.zh-CN.txt'];
const fixtureRelative = (name) => `scripts/testing/fixtures/${name}`;

function addCanonicalInputCache(f, mutate = () => {}) {
  const payloads = new Map(canonicalFixtureNames.map((name) => [fixtureRelative(name),
    fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url))]));
  payloads.set('target/release/omni-fixture.exe', Buffer.from('immutable canonical input runtime'));
  mutate(payloads);
  const files = [...payloads].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha(bytes) }));
  const core = { schemaVersion: 1, artifactKind: 'watch-mode-local-isolation-runtime-distribution', files };
  const seal = { ...core, distributionDigest: sha(JSON.stringify(canonical(core))) };
  const target = path.join(f.root, `local-isolation-${seal.distributionDigest}`);
  for (const [name, bytes] of payloads) {
    const file = path.join(target, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  json(path.join(target, 'runtime-distribution.json'), seal);
  return { target, seal };
}

async function canonicalRetirementFixture(t) {
  const f = cacheFixture(t); const cache = addCanonicalInputCache(f);
  // Establish a newer lightweight floor, then select the real planned candidate;
  // never infer FIFO identity from caches[0] when creation timestamps tie.
  await new Promise((resolve) => setTimeout(resolve, 25));
  for (let i = 0; i < 30; i += 1) addCache(f, i);
  const candidates = planWatchTypedHistory(f.options).entries.filter((entry) => entry.action === 'delete');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].path, cache.target, 'the trusted fixture must be an eligible FIFO candidate');
  return { f, cache, candidate: candidates[0] };
}

test('canonical isolation fixture: trusted input tuple passes full proof and quarantine re-proof', async (t) => {
  const { f, candidate } = await canonicalRetirementFixture(t);
  const media = candidate.proof.retainedSeal.files.find((file) => file.path === fixtureRelative(canonicalFixtureNames[0]));
  assert.equal(media.bytes, 6039180);
  assert.equal(media.sha256, 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f');
  let probes = 0;
  const result = runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true }, {
    probeQuiescence: () => { probes += 1; return quiescent(); },
  });
  assert.equal(probes, 2);
  assert.equal(result.deleted.length, 1);
  assert.equal(result.deleted[0].path, candidate.path);
  assert.equal(result.verdict, 'passed');
  assert.equal(fs.readdirSync(f.root).length, 30);
});

test('canonical isolation fixture: self-consistent replacement WAV and re-sealed companions stay protected', (t) => {
  const f = cacheFixture(t);
  const cache = addCanonicalInputCache(f, (payloads) => {
    const media = payloads.get(fixtureRelative(canonicalFixtureNames[0]));
    media[media.length - 1] ^= 1; // Still a valid WAV, but not the trusted source input.
    const replacementHash = sha(media);
    payloads.set(fixtureRelative(canonicalFixtureNames[1]), Buffer.from(`${replacementHash}  watch-mode-en-original.wav\n`));
    const metadata = JSON.parse(payloads.get(fixtureRelative(canonicalFixtureNames[2])));
    metadata.fixtures.find((value) => value.id === 'general').sha256 = replacementHash;
    payloads.set(fixtureRelative(canonicalFixtureNames[2]), Buffer.from(JSON.stringify(metadata)));
  });
  const entry = planWatchTypedHistory(f.options).entries.find((value) => value.path === cache.target);
  assert.equal(entry.action, 'retain'); assert.match(entry.reason, /protected:/u);
  assert.equal(entry.cacheCreatedAt, undefined, 'a self-seal must not create trusted fixture identity');
});

for (const name of canonicalFixtureNames.slice(1)) {
  test(`canonical isolation fixture: missing companion ${name} stays protected`, (t) => {
    const f = cacheFixture(t); const cache = addCanonicalInputCache(f, (payloads) => payloads.delete(fixtureRelative(name)));
    const entry = planWatchTypedHistory(f.options).entries.find((value) => value.path === cache.target);
    assert.equal(entry.action, 'retain'); assert.match(entry.reason, /protected:/u);
    assert.equal(entry.cacheCreatedAt, undefined);
  });
  test(`canonical isolation fixture: re-sealed companion ${name} cannot replace the trusted tuple`, (t) => {
    const f = cacheFixture(t);
    const cache = addCanonicalInputCache(f, (payloads) => {
      payloads.set(fixtureRelative(name), Buffer.concat([payloads.get(fixtureRelative(name)), Buffer.from(' ')]));
    });
    const entry = planWatchTypedHistory(f.options).entries.find((value) => value.path === cache.target);
    assert.equal(entry.action, 'retain'); assert.match(entry.reason, /protected:/u);
    assert.equal(entry.cacheCreatedAt, undefined);
  });
}

test('canonical isolation fixture: unchanged trusted seal cannot hide same-size WAV tampering in the planned candidate', async (t) => {
  const { f, candidate } = await canonicalRetirementFixture(t);
  const file = path.join(candidate.path, fixtureRelative(canonicalFixtureNames[0]));
  const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  const entry = planWatchTypedHistory(f.options).entries.find((value) => value.path === candidate.path);
  assert.equal(entry.action, 'retain'); assert.match(entry.reason, /immutable cache hash mismatch/u);
  assert.equal(fs.existsSync(file), true);
});

for (const relative of ['scripts/testing/fixtures/physical-output-recording.wav',
  'scripts/testing/fixtures/nested/watch-mode-en-original.wav', 'scripts/testing/fixtures/watch-mode-en-original.pcm',
  'scripts/testing/fixtures/run-output.mp3', 'scripts/testing/fixtures/run-output.flac', 'runs/c01/physical-output-recording.wav']) {
  test(`canonical isolation fixture: audio outside the exact input path stays protected (${relative})`, (t) => {
    const f = cacheFixture(t);
    const cache = addCanonicalInputCache(f, (payloads) => {
      // Even a byte-identical copy of the canonical WAV is not a fixture at an output/unknown path.
      payloads.set(relative, payloads.get(fixtureRelative(canonicalFixtureNames[0])));
    });
    const entry = planWatchTypedHistory(f.options).entries.find((value) => value.path === cache.target);
    assert.equal(entry.action, 'retain'); assert.match(entry.reason, /raw audio|unknown cache payload layout/u);
    assert.equal(entry.cacheCreatedAt, undefined);
  });
}

test('canonical isolation fixture: the exception never expands to runtime distributions', (t) => {
  const f = cacheFixture(t); const cache = addCache(f, 0, { type: 'runtime' });
  const relative = fixtureRelative(canonicalFixtureNames[0]);
  const bytes = fs.readFileSync(new URL(`./fixtures/${canonicalFixtureNames[0]}`, import.meta.url));
  const file = path.join(cache.target, 'vm167/runtime', relative); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  cache.seal.workers[0].entries.push({ path: relative, bytes: bytes.length, sha256: sha(bytes), status: 'reused' });
  json(path.join(f.cacheReceipts, cache.name, 'success.json'), cache.seal);
  const entry = planWatchTypedHistory(f.options).entries.find((value) => value.path === cache.target);
  assert.equal(entry.action, 'retain'); assert.match(entry.reason, /raw audio/u);
  assert.equal(entry.cacheCreatedAt, undefined);
});

test('sealed runtime/isolation caches share per-worker FIFO30 without any collected PCM mirror', (t) => {
  const f = cacheFixture(t);
  const caches = Array.from({ length: 34 }, (_, i) => addCache(f, i, { type: i % 2 ? 'runtime' : 'isolation' }));
  const plan = planWatchTypedHistory(f.options);
  assert.equal(plan.summary.deletionCandidates, 4);
  assert.equal(plan.entries.filter((entry) => entry.action === 'retain').length, 30);
  assert.ok(plan.entries.filter((entry) => entry.action === 'delete').every((entry) => entry.proof.retainedSeal));
  // Mutating directory mtime cannot change cache FIFO order.
  for (const cache of caches) fs.utimesSync(cache.target, new Date('2040-01-01'), new Date('2040-01-01'));
  assert.deepEqual(planWatchTypedHistory(f.options).entries.filter((entry) => entry.action === 'delete').map((entry) => entry.path),
    plan.entries.filter((entry) => entry.action === 'delete').map((entry) => entry.path));
  const result = runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true });
  assert.equal(result.deleted.length, 4); assert.equal(result.verdict, 'passed');
  assert.equal(fs.readdirSync(f.root).length, 30);
  for (const cache of caches.filter((value) => value.name.startsWith('runtime-'))) {
    assert.ok(fs.existsSync(path.join(f.cacheReceipts, cache.name, 'success.json')));
  }
});

test('cache FIFO is global across roots but independent per worker; current/pinned caches are exceptions', (t) => {
  const f = cacheFixture(t); const other = path.join(f.base, 'other'); fs.mkdirSync(other);
  f.options.roots.push({ workerId: 'vm167', kind: 'isolation', path: other });
  const second = path.join(f.base, 'vm169'); fs.mkdirSync(second);
  f.options.roots.push({ workerId: 'vm169', kind: 'mixed', path: second });
  const caches = Array.from({ length: 33 }, (_, i) => addCache(f, i, { root: i % 2 ? other : f.root }));
  for (let i = 50; i < 81; i += 1) addCache(f, i, { root: second, workerId: 'vm169' });
  const pinned = planWatchTypedHistory(f.options).entries.find((entry) => entry.workerId === 'vm167' && entry.action === 'delete').name;
  f.options.protectedIds = [pinned];
  const plan = planWatchTypedHistory(f.options);
  assert.equal(plan.entries.filter((entry) => entry.workerId === 'vm167' && entry.action === 'delete').length, 2);
  assert.equal(plan.entries.filter((entry) => entry.workerId === 'vm169' && entry.action === 'delete').length, 1);
  assert.equal(plan.entries.find((entry) => entry.name === pinned).reason, 'explicit-protection');
});

test('retained/incomplete execution, preflight and unsealed cache metadata protect referenced caches', (t) => {
  const f = cacheFixture(t);
  const caches = Array.from({ length: 34 }, (_, i) => addCache(f, i));
  // NTFS creation timestamps may tie; select the deterministic FIFO's actual
  // candidates rather than assuming fixture creation order resolves a tie.
  const candidates = planWatchTypedHistory(f.options).entries.filter((entry) => entry.action === 'delete')
    .map((entry) => caches.find((cache) => cache.name === entry.name));
  assert.equal(candidates.length, 4);
  json(path.join(f.root, 'watch-prod-incomplete', 'vm167', 'request.json'), { runtimeRoot: candidates[0].target });
  json(path.join(f.root, '.provider-preflight', 'pending', 'request.json'), { distributionDigest: candidates[1].seal.distributionDigest });
  json(path.join(f.root, 'runtime-unsealed', 'request.json'), { runtimeRoot: candidates[2].target });
  json(path.join(f.references, 'retained-plan.json'), { runtimeRoot: candidates[3].target });
  const plan = planWatchTypedHistory(f.options);
  assert.equal(plan.summary.deletionCandidates, 0);
  assert.equal(plan.entries.filter((entry) => entry.reason === 'referenced-by-retained-metadata').length, 4);
});

for (const damage of ['extra', 'hash', 'seal', 'missing-receipt', 'opaque-reference']) test(`cache ${damage} is retained rather than inferred disposable`, (t) => {
  const f = cacheFixture(t);
  const caches = Array.from({ length: 31 }, (_, i) => addCache(f, i, { type: 'runtime' }));
  // NTFS birth times can tie: corrupt the actual FIFO candidate, not array order.
  const candidates = planWatchTypedHistory(f.options).entries.filter((entry) => entry.action === 'delete');
  assert.equal(candidates.length, 1);
  const candidate = caches.find((cache) => cache.name === candidates[0].name);
  if (damage === 'extra') fs.writeFileSync(path.join(candidate.target, 'failed-evidence.pcm'), 'never trim');
  if (damage === 'hash') fs.writeFileSync(candidate.binary, Buffer.alloc(candidate.payload.length));
  if (damage === 'seal') json(path.join(f.cacheReceipts, candidate.name, 'success.json'), { status: 'running' });
  if (damage === 'missing-receipt') fs.unlinkSync(path.join(f.cacheReceipts, candidate.name, 'success.json'));
  if (damage === 'opaque-reference') fs.writeFileSync(path.join(f.references, 'broken.json'), '{not complete');
  const plan = planWatchTypedHistory(f.options);
  assert.equal(plan.summary.deletionCandidates, 0);
  assert.ok(plan.warnings.length > 0);
  assert.equal(plan.entries.find((entry) => entry.name === candidate.name).action, 'retain');
});

for (const change of ['new-reference', 'active-process', 'stale-process-proof', 'cache-bytes', 'newest-cache-missing']) {
  test(`cache apply fails closed on near-deletion ${change}`, (t) => {
    const f = cacheFixture(t); const caches = Array.from({ length: 31 }, (_, i) => addCache(f, i));
    let removed = false;
    assert.throws(() => runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true }, {
      beforeDelete: () => {
        if (change === 'new-reference') json(path.join(f.root, 'watch-prod-pending/request.json'), { runtimeRoot: caches[0].target });
        if (change === 'cache-bytes') fs.appendFileSync(caches[0].binary, 'changed');
        if (change === 'newest-cache-missing') {
          assert.equal(path.dirname(caches.at(-1).target), f.root);
          fs.rmSync(caches.at(-1).target, { recursive: true, force: false });
        }
      },
      probeQuiescence: change === 'active-process' ? () => ({ ...quiescent(), passed: false, matchingProcesses: [{ pid: 123, name: 'omni-desktop-shell.exe' }] })
        : change === 'stale-process-proof' ? () => ({ ...quiescent(), observedAt: '2026-01-01T00:00:00Z' }) : quiescent,
      removeDirectory: () => { removed = true; },
    }), /apply failed/u);
    assert.equal(removed, false); assert.ok(fs.existsSync(caches[0].binary));
  });
}

test('cache retirement requires explicit reference scope; missing scope warns without proposing deletion', (t) => {
  const f = cacheFixture(t); for (let i = 0; i < 31; i += 1) addCache(f, i);
  f.options.referencesComplete = false;
  const plan = planWatchTypedHistory(f.options);
  assert.equal(plan.summary.deletionCandidates, 0);
  assert.match(plan.warnings[0].reason, /references-complete/u);
  assert.throws(() => runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true }), /references-complete/u);
});

test('reference discrimination skips archived payloads but an unknown malformed request fails incomplete with its path', (t) => {
  const f = cacheFixture(t); for (let i = 0; i < 31; i += 1) addCache(f, i);
  fs.mkdirSync(path.join(f.references, 'raw'));
  json(path.join(f.references, 'raw', 'report.json'), { note: 'archived report payload' });
  json(path.join(f.references, 'report.json'), { note: 'archived report payload' });
  let result = runWatchTypedHistory(f.options);
  assert.equal(result.plan.summary.deletionCandidates, 1);
  assert.equal(result.plan.references.skippedSealedCacheTrees, 31);
  assert.ok(result.plan.references.inspectedMetadataFiles < 10);
  const broken = path.join(f.references, 'pending-request.json'); fs.writeFileSync(broken, 'import { not JSON');
  const options = { ...f.options, receiptPath: path.join(f.base, 'incomplete.json') };
  assert.throws(() => runWatchTypedHistory(options), (error) => {
    assert.match(error.message, /dry-run incomplete/u); assert.ok(error.message.includes(broken)); return true;
  });
  assert.equal(JSON.parse(fs.readFileSync(options.receiptPath, 'utf8')).verdict, 'incomplete');
  assert.throws(() => runWatchTypedHistory({ ...options, receiptPath: path.join(f.base, 'blocked-apply.json'), apply: true, confirmQuiescent: true }, {
    removeDirectory: () => assert.fail('an incomplete reference scope must prohibit ALL removals'),
  }), /apply failed/u);
});

test('live quiescence parser is bounded and rejects workers, hidden commands and failed observations', { skip: process.platform !== 'win32' }, () => {
  const root = path.parse(script).root;
  const probe = (processes) => probeWatchHistoryQuiescence({ roots: [], run: (exe, args, settings) => {
    assert.equal(exe, 'powershell.exe'); assert.ok(settings.timeout <= 20000); assert.equal(settings.windowsHide, true);
    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, processInventoryComplete: true,
      taskInventoryComplete: true, processes, tasks: [] }) };
  } });
  assert.equal(probe([{ ProcessId: 1, Name: 'system' }]).passed, true);
  assert.equal(probe([{ ProcessId: 123, Name: 'omni-worker.exe' }]).passed, false);
  assert.equal(probe([{ ProcessId: 123, Name: 'node.exe', CommandLine: 'node run-watch-mode-live-production-coordinator.mjs' }]).passed, false);
  assert.equal(probe([{ ProcessId: 123, Name: 'node.exe', CommandLine: null }]).passed, false);
  assert.equal(probeWatchHistoryQuiescence({ roots: [{ path: root }], run: () => ({ status: 1, stdout: '' }) }).passed, false);
});

test('malformed per-cell readiness output is preserved, not interpreted as a cache request', (t) => {
  const f = cacheFixture(t); for (let i = 0; i < 31; i += 1) addCache(f, i);
  const observed = path.join(f.root, 'watch-release-legacy', 'vm167', 'runs', 'c01', 'watch-runtime-status.json');
  fs.mkdirSync(path.dirname(observed), { recursive: true });
  const core = { schemaVersion: 3, artifactKind: 'watch-mode-paid-shard-execution-plan', executionId: 'watch-release-legacy',
    cells: [{ workerId: 'vm167', cellIndex: 0 }] };
  json(path.join(f.root, 'watch-release-legacy', 'vm167', 'strict-shard-execution-plan.json'),
    { ...core, planDigest: sha(JSON.stringify(canonical(core))) });
  const bytes = 'import { historicalCorruptOutput } from "./not-a-request.mjs";';
  fs.writeFileSync(observed, bytes);
  const result = runWatchTypedHistory(f.options);
  assert.equal(result.plan.summary.deletionCandidates, 1);
  assert.equal(fs.readFileSync(observed, 'utf8'), bytes);
  assert.deepEqual(result.plan.references.opaqueObservations.map((entry) => entry.path), [observed]);
  // The output exception is layout-specific, never a basename-wide escape.
  const unknown = path.join(f.references, 'watch-runtime-status.json');
  fs.writeFileSync(unknown, bytes);
  assert.throws(() => runWatchTypedHistory({ ...f.options, receiptPath: path.join(f.base, 'unknown-status.json') }),
    (error) => error.message.includes(unknown) && error.message.includes('not valid JSON'));
});

for (const directory of ['raw', 'diagnostics-bundle', 'validation-shards', '.transport']) {
  test(`unknown ${directory} directory cannot hide a live cache request`, (t) => {
    const f = cacheFixture(t); for (let i = 0; i < 31; i += 1) addCache(f, i);
    const oldest = planWatchTypedHistory(f.options).entries.find((entry) => entry.action === 'delete');
    json(path.join(f.root, 'unknown-owner', directory, 'request.json'), { runtimeRoot: oldest.path });
    const result = planWatchTypedHistory(f.options);
    assert.equal(result.cacheReferenceInspection.passed, true);
    assert.equal(result.summary.deletionCandidates, 0);
    assert.equal(result.entries.find((entry) => entry.path === oldest.path).reason, 'referenced-by-retained-metadata');
  });
}

for (const name of ['report.json', 'provider-input-budget-lease.json', 'watch-runtime-status.json']) {
  test(`unknown ${name} leaf cannot hide a cache reference or malformed input`, (t) => {
    const f = cacheFixture(t); for (let i = 0; i < 31; i += 1) addCache(f, i);
    const oldest = planWatchTypedHistory(f.options).entries.find((entry) => entry.action === 'delete');
    const file = path.join(f.root, 'unknown-owner', 'runs', 'c01', name);
    json(file, { runtimeRoot: oldest.path });
    assert.equal(planWatchTypedHistory(f.options).summary.deletionCandidates, 0);
    fs.writeFileSync(file, 'import { brokenInput }');
    assert.equal(planWatchTypedHistory(f.options).cacheReferenceInspection.passed, false);
  });
}

test('validation-copy observations use the coordinator owner plan, never a basename-only skip', (t) => {
  const f = cacheFixture(t); for (let i = 0; i < 31; i += 1) addCache(f, i);
  const execution = 'watch-prod-validation-fixture';
  const owner = path.join(f.references, execution);
  const core = { schemaVersion: 3, artifactKind: 'watch-mode-paid-shard-execution-plan', executionId: execution,
    cells: [{ workerId: 'vm131', cellIndex: 2 }] };
  const planFile = path.join(owner, 'strict-shard-execution-plan.json');
  json(planFile, { ...core, planDigest: sha(JSON.stringify(canonical(core))) });
  const journal = path.join(owner, 'validation-shards', 'vm131', 'runs', 'c03', 'provider-input-budget-ledger.json.journal.jsonl');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.writeFileSync(journal, Buffer.alloc(17 * 1024 * 1024, 32));
  let plan = planWatchTypedHistory(f.options);
  assert.equal(plan.cacheReferenceInspection.passed, true);
  assert.equal(plan.summary.deletionCandidates, 1);
  assert.deepEqual(plan.references.opaqueObservations.map((entry) => entry.path), [journal]);
  // A tampered/missing identity cannot launder arbitrary large metadata.
  json(planFile, { ...core, executionId: 'wrong-owner', planDigest: '0'.repeat(64) });
  plan = planWatchTypedHistory(f.options);
  assert.equal(plan.cacheReferenceInspection.passed, false);
  assert.equal(plan.summary.deletionCandidates, 0);
});

test('an ownership-looking JSON outside its verified cache seal cannot conceal a live reference', (t) => {
  const f = cacheFixture(t); for (let i = 0; i < 31; i += 1) addCache(f, i);
  const oldest = planWatchTypedHistory(f.options).entries.find((entry) => entry.action === 'delete');
  json(path.join(f.root, 'unknown-owner', 'manifest.json'), {
    artifactKind: 'watch-mode-local-isolation-runtime-distribution', runtimeRoot: oldest.path,
  });
  const plan = planWatchTypedHistory(f.options);
  assert.equal(plan.cacheReferenceInspection.passed, true);
  assert.equal(plan.summary.deletionCandidates, 0);
});

test('a newly recreated public generation is never removed with its retired predecessor', (t) => {
  const f = fixture(t); const runs = Array.from({ length: 31 }, (_, i) => f.add(i));
  const result = runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true }, {
    afterQuarantine: (entry, quarantine) => {
      assert.equal(path.dirname(quarantine), f.root);
      const intent = JSON.parse(fs.readFileSync(`${f.options.receiptPath}.outcome.json`, 'utf8'));
      assert.equal(intent.retirements[0].quarantinePath, quarantine);
      fs.mkdirSync(entry.path); fs.writeFileSync(path.join(entry.path, 'new-generation.txt'), 'new producer');
    },
  });
  assert.equal(result.deleted.length, 1);
  assert.equal(fs.readFileSync(path.join(runs[0].execution, 'new-generation.txt'), 'utf8'), 'new producer');
  assert.equal(fs.existsSync(result.deleted[0].quarantinePath), false);
});

test('a producer entering during quarantine prevents deletion and restores the untouched generation', (t) => {
  const f = fixture(t); const runs = Array.from({ length: 31 }, (_, i) => f.add(i)); let probes = 0;
  assert.throws(() => runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true }, {
    probeQuiescence: () => ++probes === 1 ? quiescent() : { ...quiescent(), passed: false, matchingProcesses: [{ pid: 7 }] },
    removeDirectory: () => assert.fail('must not delete after producer reentry'),
  }), /apply failed/u);
  assert.equal(fs.existsSync(runs[0].execution), true);
  const receipt = JSON.parse(fs.readFileSync(`${f.options.receiptPath}.outcome.json`, 'utf8'));
  assert.equal(receipt.retirements[0].status, 'restored');
});

test('a different generation appearing during the first process probe never acquires deletion authority', (t) => {
  const f = fixture(t); const runs = Array.from({ length: 31 }, (_, i) => f.add(i));
  assert.throws(() => runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true }, {
    probeQuiescence: () => { fs.writeFileSync(path.join(runs[0].execution, 'new-raw.pcm'), 'unproved'); return quiescent(); },
    removeDirectory: () => assert.fail('the proved generation changed before rename'),
  }), /apply failed/u);
  assert.equal(fs.readFileSync(path.join(runs[0].execution, 'new-raw.pcm'), 'utf8'), 'unproved');
});

test('quarantine re-proves the external collected copy before retiring execution bytes', (t) => {
  const f = fixture(t); const runs = Array.from({ length: 31 }, (_, i) => f.add(i));
  assert.throws(() => runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true }, {
    afterQuarantine: () => fs.writeFileSync(path.join(runs[0].copy, 'runs/c01/raw.pcm'), 'collection changed'),
    removeDirectory: () => assert.fail('lost collection proof cannot authorize deletion'),
  }), /apply failed/u);
  assert.ok(fs.existsSync(runs[0].execution));
});

test('a new external cache reference after quarantine prevents deletion', (t) => {
  const f = cacheFixture(t); for (let i = 0; i < 31; i += 1) addCache(f, i);
  assert.throws(() => runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true }, {
    afterQuarantine: (entry) => json(path.join(f.references, 'late-request.json'), { runtimeRoot: entry.path }),
    removeDirectory: () => assert.fail('late reference must preserve the cache'),
  }), /apply failed/u);
  assert.equal(fs.readdirSync(f.root).filter((name) => name.startsWith('local-isolation-')).length, 31);
});

for (const relative of ['scripts/testing/watch-mode-local-isolation.mjs', 'scripts/installer/virtual-speaker-device.ps1']) {
  test(`quarantine reference scan rejects changed sealed source: ${relative}`, (t) => {
    const f = cacheFixture(t);
    for (let i = 0; i < 31; i += 1) {
      const bytes = Buffer.from(relative.endsWith('.mjs') ? `export const version = ${i};\n` : `$version = ${i}\n`);
      const core = { schemaVersion: 1, artifactKind: 'watch-mode-local-isolation-runtime-distribution',
        files: [{ path: relative, bytes: bytes.length, sha256: sha(bytes) }] };
      const seal = { ...core, distributionDigest: sha(JSON.stringify(canonical(core))) };
      const target = path.join(f.root, `local-isolation-${seal.distributionDigest}`);
      const source = path.join(target, relative); fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, bytes); json(path.join(target, 'runtime-distribution.json'), seal);
    }
    const initial = planWatchTypedHistory(f.options);
    const candidates = initial.entries.filter((entry) => entry.action === 'delete');
    assert.equal(candidates.length, 1);
    const candidate = candidates[0];
    const retained = initial.entries.find((entry) => entry.action === 'retain');
    const referencingScript = path.join(retained.path, relative);
    assert.ok(retained.cacheSourceFiles.includes(referencingScript));
    assert.equal(initial.references.skippedSealedCacheTrees, 31, 'unchanged sealed source keeps its bounded fast path');
    assert.equal(initial.references.inspectedMetadataFiles, 0);
    const attempts = []; let probes = 0; let failure;
    try {
      runWatchTypedHistory({ ...f.options, apply: true, confirmQuiescent: true }, {
        probeQuiescence: () => { probes += 1; return quiescent(); },
        afterQuarantine: (entry) => {
          assert.equal(entry.path, candidate.path);
          const reference = relative.endsWith('.mjs') ? `export const runtimeRoot = ${JSON.stringify(entry.path)};\n`
            : `$runtimeRoot = '${entry.path.replaceAll("'", "''")}'\n`;
          fs.writeFileSync(referencingScript, reference);
        },
        // A red result records the unsafe dispatch without deleting any tree.
        removeDirectory: (target, entry) => attempts.push({ target, originalPath: entry.path }),
      });
    } catch (error) { failure = error; }
    assert.equal(attempts.length, 0,
      `changed source ${referencingScript} must pin ${candidate.path}; unsafe dispatch: ${JSON.stringify(attempts)}`);
    assert.match(failure?.message ?? '', /apply failed/u);
    assert.equal(probes, 2, 'the new reference predates the final quiescence/re-scan');
    const outcome = JSON.parse(fs.readFileSync(`${f.options.receiptPath}.outcome.json`, 'utf8'));
    assert.ok(outcome.errors.some((error) => /retained cache references changed after quarantine/u.test(error.message)));
    assert.equal(outcome.retirements[0].status, 'restored');
    assert.equal(fs.existsSync(candidate.path), true);
    assert.ok(fs.readFileSync(referencingScript, 'utf8').includes(candidate.name));
  });
}
