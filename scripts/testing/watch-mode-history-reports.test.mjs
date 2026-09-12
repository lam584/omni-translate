import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { recordWatchHistoryReport, WATCH_HISTORY_REPORT_MAX_BYTES } from './watch-mode-history-reports.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const completed = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-history-reports-'));
  t.after(() => {
    const resolved = fs.realpathSync.native(base);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^watch-history-reports-/u);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const roots = { historyRoot: path.join(base, 'history'), auditRoot: path.join(base, 'audit') };
  const record = (n, options = {}) => {
    const summary = recordWatchHistoryReport({
      ...roots, workerId: 'host-a', executionId: `run-${n}`, completedAt: completed(n),
      outcome: n % 2 ? 'success' : 'fail',
      report: { originalRefs: [{ ref: 'opaque://signed-report', sha256: hash('untouched evidence') }],
        summary: { message: 'lightweight summary', attempt: n } },
      ...options,
    });
    assert.equal(typeof summary.then, 'undefined', 'public API must stay synchronous');
    assert.equal(Object.hasOwn(summary, 'cleanup'), false, 'no plan in transport summary');
    assert.equal(Object.hasOwn(summary, 'report'), false, 'no report content in transport summary');
    const detail = summary.auditOutcomePath ? json(summary.auditOutcomePath) : {};
    return { ...detail, ...summary, summary };
  };
  return { base, ...roots, record };
}

function entries(root) {
  return fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory())
    .map((item) => ({ id: item.name, dir: path.join(root, item.name),
      report: json(path.join(root, item.name, 'report.json')) }));
}

test('four worker identities each retain the newest 30 success/fail terminal reports at 31 and 32', (t) => {
  const hosts = [];
  for (const workerId of ['host-a', 'host-b', 'host-c', 'host-d']) {
    const f = fixture(t);
    hosts.push(f);
    for (let n = 1; n <= 32; n += 1) {
      const result = f.record(n, { workerId });
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(result.archived, true);
      assert.equal(result.releaseEvidence, false);
      if (n >= 31) {
        const kept = entries(f.historyRoot).filter((item) => item.report.workerId === workerId);
        assert.equal(kept.length, 30);
        assert.equal(result.cleanup.deleted.length, 1);
        assert.deepEqual(kept.map((item) => item.report.executionId).sort(),
          Array.from({ length: 30 }, (_, i) => `run-${n - 29 + i}`).sort());
        assert.deepEqual(new Set(kept.map((item) => item.report.outcome)), new Set(['success', 'fail']));
      }
    }
  }
  assert.equal(hosts.reduce((total, f) => total + entries(f.historyRoot).length, 0), 120);
});

test('envelope and independent immutable archive receipt bind identity, refs and both file digests', (t) => {
  const f = fixture(t);
  const result = f.record(1);
  assert.equal(result.ok, true);
  const envelope = json(result.reportPath);
  const manifestPath = path.join(path.dirname(result.reportPath), 'manifest.json');
  const seal = json(result.receipts.archive);
  assert.equal(envelope.evidenceClass, 'not-release-evidence');
  assert.equal(envelope.releaseEvidence, false);
  assert.equal(envelope.originalRefsVerification, 'caller-supplied-unverified');
  assert.equal(envelope.originalRefs[0].ref, 'opaque://signed-report');
  assert.equal(envelope.completedAt, completed(1));
  assert.equal(envelope.hostId, os.hostname());
  assert.equal(seal.reportSha256, hash(fs.readFileSync(result.reportPath)));
  assert.equal(seal.manifestSha256, hash(fs.readFileSync(manifestPath)));
  assert.deepEqual(fs.readdirSync(path.dirname(result.reportPath)).sort(), ['manifest.json', 'report.json']);
  assert.equal(path.dirname(result.receipts.intent), f.auditRoot);
  assert.equal(path.dirname(result.receipts.outcome), f.auditRoot);
  const before = fs.readFileSync(result.receipts.archive);
  const again = f.record(1);
  assert.equal(again.ok, true);
  assert.equal(again.archiveState, 'already-recorded');
  assert.deepEqual(fs.readFileSync(result.receipts.archive), before);
  assert.notEqual(again.receipts.outcome, result.receipts.outcome);
  assert.equal(f.record(1, { outcome: 'fail' }).ok, false);
  assert.deepEqual(fs.readFileSync(result.receipts.archive), before);
});

test('terminal time, not creation order or mtime, determines FIFO (including immediate retirement)', (t) => {
  const f = fixture(t);
  for (let n = 2; n <= 31; n += 1) assert.equal(f.record(n).ok, true);
  for (const entry of entries(f.historyRoot)) fs.utimesSync(entry.dir, new Date(0), new Date(0));
  const late = f.record(1);
  assert.equal(late.ok, true);
  assert.equal(late.archived, true);
  assert.equal(late.reportRetained, false);
  assert.equal(fs.existsSync(late.receipts.archive), true);
  const newest = f.record(32);
  assert.equal(newest.ok, true);
  assert.deepEqual(entries(f.historyRoot).map((item) => item.report.executionId).sort(),
    Array.from({ length: 30 }, (_, i) => `run-${i + 3}`).sort());
});

test('bounded JSON is rejected rather than trimmed and refs are never read as paths', (t) => {
  const f = fixture(t);
  const outside = path.join(f.base, 'signed.pcm');
  fs.writeFileSync(outside, 'original signed raw');
  const open = fs.openSync;
  const reader = t.mock.method(fs, 'openSync', (target, ...args) => {
    assert.notEqual(target, outside, 'original reference must never be opened');
    return open(target, ...args);
  });
  const good = f.record(1, { report: { originalRefs: [
    { ref: outside, sha256: hash('original signed raw') },
    { ref: path.join(f.base, 'does-not-exist'), sha256: '0'.repeat(64) },
  ], summary: { verdict: 'pass', releaseEvidence: true } } });
  assert.equal(good.ok, true);
  assert.equal(json(good.reportPath).releaseEvidence, false);
  reader.mock.restore();
  assert.equal(fs.readFileSync(outside, 'utf8'), 'original signed raw');
  const before = fs.readdirSync(f.historyRoot).sort();
  const bad = f.record(2, { report: { originalRefs: [], summary: 'x'.repeat(WATCH_HISTORY_REPORT_MAX_BYTES) } });
  assert.equal(bad.ok, false);
  assert.equal(bad.archived, false);
  assert.deepEqual(fs.readdirSync(f.historyRoot).sort(), before);
  assert.equal(f.record(3, { outcome: 'unknown' }).ok, false);
});

function seed(f, count = 31) {
  const protectedIds = Array.from({ length: count }, (_, i) => `run-${i + 1}`);
  let last;
  for (let n = 1; n <= count; n += 1) {
    last = f.record(n, { protectedIds });
    assert.equal(last.ok, true, JSON.stringify(last));
  }
  return last;
}

function findExecution(f, n) {
  return entries(f.historyRoot).find((entry) => entry.report.executionId === `run-${n}`);
}

function replaceDirectoryWithJunction(f, target, destination, savedName) {
  const saved = path.join(f.base, savedName);
  for (const location of [target, destination, saved]) {
    const relative = path.relative(fs.realpathSync.native(f.base), path.resolve(location));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  }
  fs.renameSync(target, saved);
  fs.symlinkSync(destination, target, process.platform === 'win32' ? 'junction' : 'dir');
  return saved;
}

test('explicit pins are extra to the newest 30 and unpinning reclaims every eligible old record', (t) => {
  const f = fixture(t);
  const pinned = seed(f, 32);
  assert.equal(pinned.cleanup.overLimitByWorker['host-a'], 2);
  assert.equal(pinned.cleanup.deleted.length, 0);
  const old = findExecution(f, 1);
  const next = f.record(33, { protectedIds: [old.id, 'run-2'] });
  assert.equal(next.ok, true);
  assert.equal(next.cleanup.overLimitByWorker['host-a'], 2);
  assert.deepEqual(next.cleanup.deleted.map((entry) => entry.executionId), ['run-3']);
  assert.deepEqual(new Set(next.cleanup.pinned.map((entry) => entry.executionId)), new Set(['run-1', 'run-2']));
  const unpinned = f.record(34);
  assert.equal(unpinned.ok, true);
  assert.deepEqual(unpinned.cleanup.deleted.map((entry) => entry.executionId), ['run-1', 'run-2', 'run-4']);
  assert.equal(entries(f.historyRoot).length, 30);
});

test('same-root workers do not spend each other\'s retention quota; equal terminal times use stable IDs', (t) => {
  const f = fixture(t);
  for (let n = 1; n <= 31; n += 1) assert.equal(f.record(n, { completedAt: completed(1) }).ok, true);
  const expected = Array.from({ length: 31 }, (_, i) => `history-${hash(JSON.stringify(['host-a', `run-${i + 1}`]))}`)
    .sort().slice(0, 30);
  assert.deepEqual(entries(f.historyRoot).map((entry) => entry.id).sort(), expected);
  const other = f.record(1, { workerId: 'host-b' });
  assert.equal(other.ok, true);
  assert.equal(entries(f.historyRoot).length, 31);
  assert.equal(other.cleanup.deleted.length, 0);
});

test('unknown, partial, rehashed tampering and extra PCM are pinned, not admitted or silently successful', (t) => {
  const f = fixture(t);
  seed(f, 32);
  const raw = findExecution(f, 1);
  fs.writeFileSync(path.join(raw.dir, 'signed.pcm'), 'untouched raw bytes');
  const tampered = findExecution(f, 2);
  const reportPath = path.join(tampered.dir, 'report.json');
  const manifestPath = path.join(tampered.dir, 'manifest.json');
  const report = json(reportPath);
  report.summary.message = 'rewritten summary';
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`, 'utf8');
  const manifest = json(manifestPath);
  manifest.reportSha256 = hash(fs.readFileSync(reportPath));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
  const partial = findExecution(f, 3);
  fs.unlinkSync(path.join(partial.dir, 'manifest.json'));
  const unknown = path.join(f.historyRoot, 'legacy-unknown');
  fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(unknown, 'report.json'), '{"verdict":"pass"}', 'utf8');
  fs.writeFileSync(path.join(unknown, 'raw.pcm'), 'legacy signed evidence');
  fs.writeFileSync(path.join(f.historyRoot, 'unexpected.json'), '{}', 'utf8');
  const before = fs.readFileSync(reportPath);
  const result = f.record(34, { protectedIds: ['legacy-unknown', partial.id] });
  assert.equal(result.archived, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'partial');
  assert.equal(result.cleanup.unclassifiedCount, 5);
  assert.equal(result.cleanup.deleted.length, 0);
  const next = f.record(35);
  assert.deepEqual(next.cleanup.deleted.map((entry) => entry.executionId), ['run-4']);
  for (const id of [raw.id, tampered.id, partial.id, 'legacy-unknown', 'unexpected.json']) {
    assert.equal(next.cleanup.pinned.find((entry) => entry.entryId === id)?.status, 'unknown');
  }
  assert.match(next.cleanup.pinned.find((entry) => entry.entryId === tampered.id).error.message, /immutable archive digest/u);
  assert.equal(fs.readFileSync(path.join(raw.dir, 'signed.pcm'), 'utf8'), 'untouched raw bytes');
  assert.equal(fs.readFileSync(path.join(unknown, 'raw.pcm'), 'utf8'), 'legacy signed evidence');
  assert.deepEqual(fs.readFileSync(reportPath), before);
});

test('a valid-looking two-file directory without an independent seal is partial and never recycled', (t) => {
  const f = fixture(t);
  const first = f.record(1);
  fs.unlinkSync(first.receipts.archive);
  const result = f.record(2);
  assert.equal(result.ok, false);
  assert.equal(result.cleanup.pinned[0].entryId, first.entryId);
  assert.equal(result.cleanup.pinned[0].status, 'unknown');
  assert.equal(fs.existsSync(first.reportPath), true);
  const retry = f.record(1);
  assert.equal(retry.archived, false);
  assert.equal(retry.cleanup.status, 'not-run');
});

test('hard-linked JSON is not owned disposable storage', (t) => {
  const f = fixture(t);
  const first = f.record(1);
  const outside = path.join(f.base, 'hardlink.json');
  fs.linkSync(first.reportPath, outside);
  const result = f.record(2);
  assert.equal(result.ok, false);
  assert.match(result.cleanup.pinned[0].error.message, /linked/u);
  assert.deepEqual(fs.readFileSync(first.reportPath), fs.readFileSync(outside));
});

test('cleanup failures continue per entry, never report partial removal as deleted, and preserve receipts', (t) => {
  const f = fixture(t);
  seed(f, 33);
  const one = findExecution(f, 1);
  const two = findExecution(f, 2);
  const unlink = fs.unlinkSync;
  const rmdir = fs.rmdirSync;
  t.mock.method(fs, 'unlinkSync', (target) => {
    if (target === path.join(one.dir, 'report.json')) throw Object.assign(new Error('injected sharing violation'), { code: 'EACCES' });
    return unlink(target);
  });
  t.mock.method(fs, 'rmdirSync', (target) => {
    if (target === two.dir) throw Object.assign(new Error('injected directory removal failure'), { code: 'EPERM' });
    return rmdir(target);
  });
  const result = f.record(34);
  assert.equal(result.archived, true);
  assert.equal(result.ok, false);
  assert.deepEqual(result.cleanup.failures.map((entry) => entry.executionId), ['run-1', 'run-2']);
  assert.ok(result.cleanup.failures.every((entry) => entry.status === 'unknown'));
  assert.deepEqual(result.cleanup.deleted.map((entry) => entry.executionId), ['run-3', 'run-4']);
  assert.equal(fs.existsSync(path.join(one.dir, 'report.json')), true);
  assert.deepEqual(fs.readdirSync(two.dir), []);
  for (const receipt of result.receipts.cleanup) {
    assert.equal(path.dirname(receipt.intent), f.auditRoot);
    assert.equal(path.dirname(receipt.outcome), f.auditRoot);
    assert.equal(json(receipt.intent).kind, 'watch-history-cleanup-intent');
    assert.equal(json(receipt.outcome).status, ['run-1', 'run-2'].includes(json(receipt.outcome).executionId) ? 'unknown' : 'deleted');
  }
  assert.equal(json(result.receipts.outcome).ok, false);
});

for (const alteration of ['junction', 'extra-raw', 'replacement-json']) {
  test(`${alteration} introduced after cleanup intent is detected before deletion; later entries still clean`, (t) => {
    const f = fixture(t);
    seed(f);
    const one = findExecution(f, 1);
    const original = fs.readFileSync(path.join(one.dir, 'report.json'));
    const outside = path.join(f.base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'report.json'), 'external report');
    fs.writeFileSync(path.join(outside, 'manifest.json'), 'external manifest');
    fs.writeFileSync(path.join(outside, 'raw.pcm'), 'external PCM');
    let saved;
    let altered = false;
    const link = fs.linkSync;
    t.mock.method(fs, 'linkSync', (source, target) => {
      link(source, target);
      if (!altered && path.basename(target).endsWith(`cleanup-${one.id}-intent.json`)) {
        altered = true;
        if (alteration === 'junction') saved = replaceDirectoryWithJunction(f, one.dir, outside, 'original-one');
        else if (alteration === 'extra-raw') fs.writeFileSync(path.join(one.dir, 'raw.pcm'), 'arrived after planning');
        else fs.writeFileSync(path.join(one.dir, 'report.json'), '{"changed":true}', 'utf8');
      }
    });
    const result = f.record(32);
    assert.equal(altered, true);
    assert.equal(result.ok, false);
    assert.deepEqual(result.cleanup.deleted.map((entry) => entry.executionId), ['run-2']);
    assert.equal(result.cleanup.failures[0].status, 'unknown');
    assert.deepEqual(result.cleanup.failures[0].deletedFiles, []);
    assert.equal(fs.readFileSync(path.join(outside, 'raw.pcm'), 'utf8'), 'external PCM');
    assert.equal(fs.readFileSync(path.join(outside, 'report.json'), 'utf8'), 'external report');
    if (saved) assert.deepEqual(fs.readFileSync(path.join(saved, 'report.json')), original);
    if (alteration === 'extra-raw') assert.equal(fs.readFileSync(path.join(one.dir, 'raw.pcm'), 'utf8'), 'arrived after planning');
  });
}

for (const rootName of ['historyRoot', 'auditRoot']) {
  test(`${rootName} reparse replacement mid-operation fails closed without following the new tree`, (t) => {
    const f = fixture(t);
    seed(f);
    const one = findExecution(f, 1);
    const outside = path.join(f.base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'raw.pcm'), 'untouched external bytes');
    let saved;
    const link = fs.linkSync;
    t.mock.method(fs, 'linkSync', (source, target) => {
      link(source, target);
      if (!saved && path.basename(target).endsWith(`cleanup-${one.id}-intent.json`)) {
        saved = replaceDirectoryWithJunction(f, f[rootName], outside, 'saved-root');
      }
    });
    const result = f.record(32);
    assert.ok(saved);
    assert.equal(result.ok, false);
    assert.notEqual(result.cleanupStatus, 'success');
    assert.equal(result.counts.deleted, 0);
    assert.deepEqual(fs.readdirSync(outside), ['raw.pcm']);
    const history = rootName === 'historyRoot' ? saved : f.historyRoot;
    assert.equal(fs.existsSync(path.join(history, one.id, 'report.json')), true);
    assert.equal(result.auditOutcomePath, null);
  });
}

for (const phase of ['report-write', 'report-fsync', 'archive-seal', 'archive-intent']) {
  test(`${phase} failure cannot start FIFO or delete any existing report`, (t) => {
    const f = fixture(t);
    seed(f);
    const before = new Map(entries(f.historyRoot).map((entry) => [entry.dir, fs.readFileSync(path.join(entry.dir, 'report.json'))]));
    const open = fs.openSync;
    const sync = fs.fsyncSync;
    const write = fs.writeFileSync;
    const link = fs.linkSync;
    let reportFd;
    let injected = false;
    t.mock.method(fs, 'openSync', (target, ...args) => {
      const fd = open(target, ...args);
      if (String(target).includes('.partial-report.json-')) reportFd = fd;
      return fd;
    });
    t.mock.method(fs, 'writeFileSync', (target, ...args) => {
      if (!injected && phase === 'report-write' && target === reportFd) {
        injected = true;
        throw Object.assign(new Error('injected report write failure'), { code: 'ENOSPC' });
      }
      return write(target, ...args);
    });
    t.mock.method(fs, 'fsyncSync', (fd) => {
      if (!injected && phase === 'report-fsync' && fd === reportFd) {
        injected = true;
        throw Object.assign(new Error('injected fsync failure'), { code: 'EIO' });
      }
      return sync(fd);
    });
    t.mock.method(fs, 'linkSync', (source, target) => {
      const name = path.basename(target);
      if (!injected && ((phase === 'archive-seal' && name.startsWith('archive-history-'))
        || (phase === 'archive-intent' && name.endsWith('-intent.json')))) {
        injected = true;
        throw Object.assign(new Error('injected exclusive publication failure'), { code: 'ENOSPC' });
      }
      return link(source, target);
    });
    const result = f.record(32);
    assert.equal(injected, true);
    assert.equal(result.ok, false);
    assert.equal(result.archived, false);
    assert.equal(result.cleanup.status, 'not-run');
    assert.deepEqual(result.cleanup.deleted, []);
    assert.deepEqual(result.receipts.cleanup, []);
    for (const [dir, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(dir, 'report.json')), bytes);
    assert.equal(json(result.receipts.outcome).archived, false);
  });
}

test('cleanup intent publication failure skips that deletion but continues to the next entry', (t) => {
  const f = fixture(t);
  seed(f);
  const one = findExecution(f, 1);
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (source, target) => {
    if (path.basename(target).endsWith(`cleanup-${one.id}-intent.json`)) throw Object.assign(new Error('audit disk error'), { code: 'EIO' });
    return link(source, target);
  });
  const result = f.record(32);
  assert.equal(result.ok, false);
  assert.equal(result.cleanup.failures[0].status, 'failed');
  assert.deepEqual(result.cleanup.failures[0].deletedFiles, []);
  assert.deepEqual(result.cleanup.deleted.map((entry) => entry.executionId), ['run-2']);
  assert.equal(fs.existsSync(path.join(one.dir, 'report.json')), true);
});

test('a cleanup outcome collision stays immutable and an unreceipted removal is unknown, not success', (t) => {
  const f = fixture(t);
  seed(f);
  const one = findExecution(f, 1);
  const link = fs.linkSync;
  let collision;
  t.mock.method(fs, 'linkSync', (source, target) => {
    if (path.basename(target).endsWith(`cleanup-${one.id}-outcome.json`)) {
      collision = target;
      fs.writeFileSync(target, 'existing immutable receipt', { encoding: 'utf8', flag: 'wx' });
    }
    return link(source, target);
  });
  const result = f.record(32);
  assert.equal(result.ok, false);
  assert.deepEqual(result.cleanup.deleted.map((entry) => entry.executionId), ['run-2']);
  assert.equal(result.cleanup.failures[0].status, 'unknown');
  assert.equal(result.cleanup.failures[0].removed, true);
  assert.equal(result.cleanup.failures[0].outcome, null);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'existing immutable receipt');
  assert.equal(fs.existsSync(one.dir), false);
});

test('roots must be explicit, local, disjoint and exclusively owned; audit binding cannot be redirected', (t) => {
  const f = fixture(t);
  const legacy = path.join(f.base, 'legacy-history');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'raw.pcm'), 'real history stand-in');
  for (const historyRoot of ['relative', path.parse(f.base).root, legacy, path.join(legacy, 'raw.pcm', 'history')]) {
    assert.equal(f.record(1, { historyRoot }).ok, false);
  }
  assert.equal(fs.readFileSync(path.join(legacy, 'raw.pcm'), 'utf8'), 'real history stand-in');
  assert.equal(f.record(1, { auditRoot: f.historyRoot }).ok, false);
  fs.mkdirSync(f.historyRoot);
  assert.equal(f.record(1, { auditRoot: path.join(f.historyRoot, 'audit') }).ok, false);
  const first = f.record(1);
  assert.equal(first.ok, true);
  const redirected = path.join(f.base, 'different-audit');
  assert.equal(f.record(2, { auditRoot: redirected }).ok, false);
  assert.equal(fs.existsSync(redirected), false);
  const alias = path.join(f.base, 'alias');
  fs.symlinkSync(f.historyRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.record(2, { historyRoot: alias }).ok, false);
  assert.equal(f.record(2, { auditRoot: path.join(alias, 'audit') }).ok, false);
  assert.equal(fs.existsSync(first.reportPath), true);
});

test('exclusive lock refuses another writer or a stale lock without stealing or changing it', (t) => {
  const f = fixture(t);
  const first = f.record(1);
  const lock = path.join(f.historyRoot, '.watch-history.lock');
  fs.writeFileSync(lock, 'owned by another process', { encoding: 'utf8', flag: 'wx' });
  const result = f.record(2);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].phase, 'lock');
  assert.equal(result.errors[0].code, 'EEXIST');
  assert.equal(result.cleanup.status, 'not-run');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'owned by another process');
  assert.equal(fs.existsSync(first.reportPath), true);
});

test('junction replacement between individual unlinks never reaches the external manifest/raw', (t) => {
  const f = fixture(t);
  seed(f);
  const one = findExecution(f, 1);
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'manifest.json'), 'external manifest');
  fs.writeFileSync(path.join(outside, 'raw.pcm'), 'external raw');
  const unlink = fs.unlinkSync;
  let changed = false;
  t.mock.method(fs, 'unlinkSync', (target) => {
    unlink(target);
    if (target === path.join(one.dir, 'report.json')) {
      replaceDirectoryWithJunction(f, one.dir, outside, 'partially-removed-one');
      changed = true;
    }
  });
  const result = f.record(32);
  assert.equal(changed, true);
  assert.equal(result.verdict, 'partial');
  assert.equal(result.cleanup.failures[0].status, 'unknown');
  assert.deepEqual(result.cleanup.failures[0].deletedFiles, ['report.json']);
  assert.deepEqual(result.cleanup.deleted.map((entry) => entry.executionId), ['run-2']);
  assert.equal(fs.readFileSync(path.join(outside, 'manifest.json'), 'utf8'), 'external manifest');
  assert.equal(fs.readFileSync(path.join(outside, 'raw.pcm'), 'utf8'), 'external raw');
});

test('non-JSON, invalid UTC times/identities and UTF-8 byte overflow fail before root creation', (t) => {
  const f = fixture(t);
  const cyclic = {};
  cyclic.self = cyclic;
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get() { throw new Error('getter must not run'); } });
  for (const summary of [cyclic, accessor, new Date(), NaN, 1n, Buffer.from('raw'), undefined, '界'.repeat(400000)]) {
    assert.equal(f.record(1, { report: { originalRefs: [], summary } }).ok, false);
    assert.equal(fs.existsSync(f.historyRoot), false);
  }
  for (const override of [
    { completedAt: '2026-02-30T00:00:00Z' }, { completedAt: 'yesterday' }, { workerId: '../host' },
    { executionId: '' }, { protectedIds: ['../outside'] }, { report: f.base },
    { report: { originalRefs: [{ ref: 'opaque', sha256: ['0'.repeat(64)] }], summary: {} } },
  ]) {
    assert.equal(f.record(1, override).ok, false);
    assert.equal(fs.existsSync(f.historyRoot), false);
  }
});

test('an unavailable volume terminates validation instead of walking its root forever', (t) => {
  const f = fixture(t);
  const volume = path.parse(f.base).root;
  const unavailable = path.join(volume, 'watch-history-unavailable-volume');
  const lstat = fs.lstatSync;
  let probes = 0;
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    if (target === volume || target === unavailable) {
      assert.ok(++probes <= 3, 'ancestor walk must terminate at an unavailable volume root');
      throw Object.assign(new Error('missing volume fixture'), { code: 'ENOENT' });
    }
    return lstat(target, ...args);
  });
  const result = f.record(1, { historyRoot: unavailable });
  assert.equal(result.verdict, 'failed');
  assert.equal(result.counts.retained, null);
  assert.equal(result.auditOutcomePath, null);
  assert.ok(probes <= 3);
  assert.equal(fs.existsSync(f.historyRoot), false);
});

test('fixed compact API supports nested per-worker roots sharing an immutable workspace audit root', (t) => {
  const f = fixture(t);
  const auditRoot = path.join(f.base, 'workspace', 'artifacts', 'testing', 'watch-history-audit');
  let auditMarker;
  const receipts = [];
  for (const workerId of ['host-a', 'host-b', 'host-c', 'host-d']) {
    const historyRoot = path.join(f.base, 'guest', 'artifacts', 'retained-reports', workerId);
    const result = f.record(1, { historyRoot, auditRoot, workerId });
    assert.equal(result.verdict, 'success');
    assert.equal(result.summary.manifestPath, path.join(path.dirname(result.reportPath), 'manifest.json'));
    assert.equal(path.dirname(result.auditOutcomePath), auditRoot);
    assert.deepEqual(result.counts, { retained: 1, deleted: 0, pinned: 0, failed: 0, unknown: 0, overLimit: 0 });
    assert.ok(Buffer.byteLength(JSON.stringify(result.summary)) < 2048);
    const bytes = fs.readFileSync(path.join(auditRoot, '.watch-history-audit.json'));
    if (auditMarker) assert.deepEqual(bytes, auditMarker);
    auditMarker = bytes;
    receipts.push(result.auditArchivePath);
  }
  assert.equal(new Set(receipts).size, 4);
  // Same logical execution in another explicitly owned history root cannot collide
  // with or overwrite the first root's immutable seal in the shared audit tree.
  const other = f.record(1, { historyRoot: path.join(f.base, 'second-guest', 'history'), auditRoot });
  assert.equal(other.verdict, 'success');
  assert.ok(!receipts.includes(other.auditArchivePath));
  assert.deepEqual(fs.readFileSync(path.join(auditRoot, '.watch-history-audit.json')), auditMarker);
});
