import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { verifiedWatchPath } from './watch-mode-disk-lifecycle.mjs';

export const WATCH_HISTORY_REPORT_MAX_BYTES = 1024 * 1024;
export const WATCH_HISTORY_REPORTS_PER_WORKER = 30;
const OWNER = 'omni-translate/watch-mode-history-reports';
const HISTORY_MARKER = '.watch-history-root.json';
const AUDIT_MARKER = '.watch-history-audit.json';
const LOCK = '.watch-history.lock';
const FILES = ['manifest.json', 'report.json'];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const key = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
const stamp = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const base = (kind) => ({ schemaVersion: 1, kind, owner: OWNER, evidenceClass: 'not-release-evidence', releaseEvidence: false });

function requireThat(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: 'watch.history.unsafe' });
}

function errorInfo(error) {
  return { code: String(error.code ?? 'watch.history.unknown'), message: String(error.message ?? error).slice(0, 600) };
}

function statIfPresent(target) {
  try { return fs.lstatSync(target, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function directoryStamp(target, expected) {
  verifiedWatchPath(target);
  const current = stamp(fs.lstatSync(target, { bigint: true }));
  requireThat(expected === undefined || current === expected, `directory identity changed: ${target}`);
  return current;
}

// No unbounded readFileSync on disk input, and no paths taken from report JSON.
function readJson(target, limit = WATCH_HISTORY_REPORT_MAX_BYTES) {
  verifiedWatchPath(target, { directory: false });
  const before = fs.lstatSync(target, { bigint: true });
  requireThat(before.nlink === 1n && before.size <= BigInt(limit), `linked or oversized JSON: ${target}`);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    requireThat(opened.isFile() && stamp(opened) === stamp(before), `file identity changed: ${target}`);
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    requireThat(length === Number(before.size) && after.size === before.size && after.mtimeNs === before.mtimeNs
      && after.nlink === 1n, `JSON changed during bounded read: ${target}`);
    bytes = buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
  verifiedWatchPath(target, { directory: false });
  requireThat(stamp(fs.lstatSync(target, { bigint: true })) === stamp(before), `file replaced: ${target}`);
  return { value: JSON.parse(bytes.toString('utf8')), bytes, digest: sha256(bytes), stamp: stamp(before) };
}

function jsonBytes(value) {
  // Reject accessors, toJSON/class instances, cycles, non-finite values and excessive
  // depth/nodes before serialization; do not silently truncate a caller's summary.
  let budget = 0;
  let nodes = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    requireThat(depth <= 32 && ++nodes <= 20000, 'JSON depth/node bound exceeded');
    if (item === null || typeof item === 'boolean') { budget += 5; }
    else if (typeof item === 'number') { requireThat(Number.isFinite(item), 'non-finite JSON number'); budget += 24; }
    else if (typeof item === 'string') { budget += Buffer.byteLength(item); }
    else {
      requireThat(typeof item === 'object' && !ancestors.has(item), 'report must be acyclic JSON data');
      const array = Array.isArray(item);
      requireThat(Object.getPrototypeOf(item) === (array ? Array.prototype : Object.prototype)
        || (!array && Object.getPrototypeOf(item) === null), 'report must contain plain JSON data');
      requireThat(Object.getOwnPropertySymbols(item).length === 0, 'symbol JSON keys are forbidden');
      ancestors.add(item);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (array) requireThat(Object.keys(descriptors).length === item.length + 1, 'sparse/extended JSON array');
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (array && name === 'length') continue;
        requireThat(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'JSON accessors/hidden properties are forbidden');
        budget += Buffer.byteLength(name) + 3;
        visit(descriptor.value, depth + 1);
      }
      ancestors.delete(item);
    }
    requireThat(budget <= WATCH_HISTORY_REPORT_MAX_BYTES, 'JSON exceeds 1 MiB');
  }
  visit(value, 0);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  requireThat(bytes.length <= WATCH_HISTORY_REPORT_MAX_BYTES, 'JSON exceeds 1 MiB');
  return bytes;
}

function syncDirectory(target) {
  // Node/Windows cannot portably open+fsync directory handles. File contents are
  // always fsynced; return this weaker namespace durability explicitly to callers.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Publish complete JSON via an exclusive hard link, never overwrite via rename.
// A crash leaves a non-admissible partial file/dir, not an apparently valid report.
function atomicJson(target, value, guard) {
  const bytes = jsonBytes(value);
  guard();
  const parent = path.dirname(target);
  const parentStamp = directoryStamp(parent);
  const temporary = path.join(parent, `.partial-${path.basename(target)}-${randomUUID()}`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  let fileStamp;
  try {
    fileStamp = stamp(fs.fstatSync(fd, { bigint: true }));
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  guard();
  directoryStamp(parent, parentStamp);
  verifiedWatchPath(temporary, { directory: false });
  requireThat(stamp(fs.lstatSync(temporary, { bigint: true })) === fileStamp, 'temporary JSON replaced');
  fs.linkSync(temporary, target);
  guard();
  directoryStamp(parent, parentStamp);
  for (const file of [temporary, target]) {
    verifiedWatchPath(file, { directory: false });
    const stat = fs.lstatSync(file, { bigint: true });
    requireThat(stamp(stat) === fileStamp && stat.nlink === 2n, 'published JSON identity/link count changed');
  }
  fs.unlinkSync(temporary);
  syncDirectory(parent);
  guard();
  requireThat(readJson(target).digest === sha256(bytes), 'published JSON digest changed');
  return sha256(bytes);
}

function location(value) {
  requireThat(typeof value === 'string' && path.isAbsolute(value), 'roots must be explicit absolute local paths');
  requireThat(!value.split(/[\\/]/u).some((part) => part === '..' || part === '.'), 'dot traversal in root');
  const absolute = path.resolve(value);
  requireThat(absolute !== path.parse(absolute).root, 'a volume root cannot be owned history/audit storage');
  let ancestor = absolute;
  while (!statIfPresent(ancestor)) {
    const parent = path.dirname(ancestor);
    requireThat(parent !== ancestor, 'missing/unavailable volume root');
    ancestor = parent;
  }
  verifiedWatchPath(ancestor);
  return absolute;
}

function ensureDirectory(target) {
  const missing = [];
  let ancestor = target;
  while (!statIfPresent(ancestor)) {
    missing.unshift(ancestor);
    const parent = path.dirname(ancestor);
    requireThat(parent !== ancestor, 'missing/unavailable volume root');
    ancestor = parent;
  }
  verifiedWatchPath(ancestor);
  for (const directory of missing) {
    // Never recursive mkdir through an unchecked/missing ancestor.
    verifiedWatchPath(path.dirname(directory));
    try { fs.mkdirSync(directory); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    verifiedWatchPath(directory);
    syncDirectory(path.dirname(directory));
  }
  return directoryStamp(target);
}

function rootsOverlap(left, right) {
  const relative = path.relative(key(left), key(right));
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function prepareRoots(historyRoot, auditRoot) {
  historyRoot = location(historyRoot);
  auditRoot = location(auditRoot);
  requireThat(!rootsOverlap(historyRoot, auditRoot) && !rootsOverlap(auditRoot, historyRoot), 'history/audit roots must be disjoint');
  const specs = [[historyRoot, HISTORY_MARKER], [auditRoot, AUDIT_MARKER]];
  const existing = specs.map(([root, marker]) => {
    if (!statIfPresent(root)) return null;
    if (statIfPresent(path.join(root, marker))) return readJson(path.join(root, marker), 8192);
    requireThat(fs.readdirSync(root).length === 0, `refusing to adopt nonempty unowned root: ${root}`);
    return null;
  });
  requireThat(!existing[0] || existing[1], 'missing fixed audit ownership; manual recovery required');
  const hostId = os.hostname();
  const auditId = existing[1]?.value.auditId ?? randomUUID();
  const rootId = existing[0]?.value.rootId ?? randomUUID();
  requireThat(typeof auditId === 'string' && UUID.test(auditId) && typeof rootId === 'string' && UUID.test(rootId), 'invalid root ownership identity');
  if (existing[1]) {
    requireThat(existing[1].value.hostId === hostId && key(existing[1].value.auditRoot ?? '') === key(auditRoot),
      'audit root ownership/path mismatch');
    auditRoot = existing[1].value.auditRoot;
  }
  if (existing[0]) {
    const stored = existing[0].value;
    requireThat(stored.hostId === hostId && stored.auditId === auditId && key(stored.historyRoot ?? '') === key(historyRoot)
      && key(stored.auditRoot ?? '') === key(auditRoot), 'history root ownership or fixed audit binding mismatch');
    historyRoot = stored.historyRoot;
  }
  // A shared audit marker has no mutable list of roots. Each history marker binds
  // to its immutable auditId, and archive receipt names also include history rootId.
  const values = [
    { ...base('watch-history-root'), rootId, hostId, historyRoot, auditRoot, auditId, role: 'history' },
    { ...base('watch-history-audit-root'), hostId, auditRoot, auditId, role: 'audit' },
  ];
  for (let i = 0; i < specs.length; i += 1) {
    if (existing[i]) requireThat(existing[i].bytes.equals(jsonBytes(values[i])), 'invalid root ownership manifest');
  }
  const directories = specs.map(([root]) => ({ root, stamp: ensureDirectory(root) }));
  const guardDirectories = () => { for (const item of directories) directoryStamp(item.root, item.stamp); };
  for (const i of [1, 0]) {
    if (!existing[i]) {
      guardDirectories();
      requireThat(fs.readdirSync(specs[i][0]).length === 0, 'unowned root changed during initialization');
      atomicJson(path.join(...specs[i]), values[i], guardDirectories);
    }
  }
  const markers = specs.map(([root, marker], i) => {
    const target = path.join(root, marker);
    const stored = readJson(target, 8192);
    requireThat(stored.bytes.equals(jsonBytes(values[i])), 'invalid root ownership manifest');
    return { target, digest: stored.digest, stamp: stored.stamp };
  });
  return { historyRoot, auditRoot, rootId, hostId,
    guard() {
      guardDirectories();
      for (const item of markers) {
        const live = readJson(item.target, 8192);
        requireThat(live.digest === item.digest && live.stamp === item.stamp, 'root ownership changed during operation');
      }
    } };
}

function identity(value) {
  requireThat(typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value), 'invalid worker/execution/protected identity');
  return value;
}

function terminalTime(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value), 'completedAt must be a UTC ISO terminal timestamp');
  const normalized = value.includes('.') ? value : value.replace('Z', '.000Z');
  requireThat(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === normalized, 'invalid terminal timestamp');
  return normalized;
}

function checkedReport(report) {
  const bytes = jsonBytes(report);
  const data = JSON.parse(bytes.toString('utf8'));
  requireThat(data && !Array.isArray(data) && Object.keys(data).sort().join(',') === 'originalRefs,summary',
    'report must be { originalRefs: [{ ref, sha256 }], summary: JSON }');
  requireThat(Array.isArray(data.originalRefs) && data.originalRefs.length <= 128, 'invalid originalRefs');
  for (const ref of data.originalRefs) {
    requireThat(ref && Object.keys(ref).sort().join(',') === 'ref,sha256' && typeof ref.ref === 'string'
      && ref.ref.length > 0 && Buffer.byteLength(ref.ref) <= 4096 && typeof ref.sha256 === 'string' && DIGEST.test(ref.sha256), 'invalid opaque original ref/hash');
  }
  return data;
}

function entryPayload(context, input) {
  const workerId = identity(input.workerId);
  const executionId = identity(input.executionId);
  const completedAt = terminalTime(input.completedAt);
  requireThat(input.outcome === 'success' || input.outcome === 'fail', 'only success/fail terminal outcomes can be archived');
  const report = checkedReport(input.report);
  const entryId = `history-${sha256(JSON.stringify([workerId, executionId]))}`;
  const common = { rootId: context.rootId, entryId, hostId: context.hostId, workerId, executionId, completedAt, outcome: input.outcome };
  const envelope = { ...base('watch-history-report'), ...common,
    originalRefsVerification: 'caller-supplied-unverified', originalRefs: report.originalRefs, summary: report.summary };
  const reportSha256 = sha256(jsonBytes(envelope));
  const manifest = { ...base('watch-history-ownership'), ...common, allowedFiles: FILES, reportSha256 };
  return { ...common, envelope, manifest, reportSha256, manifestSha256: sha256(jsonBytes(manifest)) };
}

function child(context, entryId) {
  requireThat(/^history-[0-9a-f]{64}$/u.test(entryId), 'unknown history entry name');
  const target = path.join(context.historyRoot, entryId);
  requireThat(key(path.dirname(target)) === key(context.historyRoot), 'entry is not a direct child');
  return target;
}

const archivePath = (context, entryId) => path.join(context.auditRoot, `archive-${entryId}-${context.rootId}.json`);

function inspectEntry(context, entryId) {
  context.guard();
  const dir = child(context, entryId);
  const dirStamp = directoryStamp(dir);
  requireThat(fs.readdirSync(dir).sort().join(',') === FILES.join(','), 'unknown/partial entry or extra raw files');
  const manifest = readJson(path.join(dir, 'manifest.json'), 8192);
  const report = readJson(path.join(dir, 'report.json'));
  const data = report.value;
  const expected = entryPayload(context, { ...data, report: { originalRefs: data.originalRefs, summary: data.summary } });
  requireThat(expected.entryId === entryId && report.bytes.equals(jsonBytes(expected.envelope))
    && manifest.bytes.equals(jsonBytes(expected.manifest)), 'invalid ownership/envelope or report digest');
  const seal = readJson(archivePath(context, entryId), 8192);
  requireThat(typeof seal.value.operationId === 'string' && UUID.test(seal.value.operationId), 'invalid immutable archive receipt identity');
  terminalTime(seal.value.recordedAt);
  const expectedSeal = archiveReceipt(expected, seal.value.operationId, seal.value.recordedAt);
  requireThat(seal.bytes.equals(jsonBytes(expectedSeal)), 'immutable archive digest mismatch');
  directoryStamp(dir, dirStamp);
  // Keep only verified fingerprints in the FIFO snapshot, not N copies of up to
  // 1 MiB summaries. Full report bytes never leak into a cleanup plan or receipt.
  const fingerprint = (file) => ({ digest: file.digest, stamp: file.stamp });
  return { ...entryRef(expected), reportSha256: expected.reportSha256, manifestSha256: expected.manifestSha256,
    dir, dirStamp, files: { 'manifest.json': fingerprint(manifest), 'report.json': fingerprint(report) }, seal: fingerprint(seal) };
}

function archiveReceipt(entry, operationId, recordedAt) {
  return { ...base('watch-history-archive'), operationId, recordedAt, status: 'archived', rootId: entry.rootId,
    entryId: entry.entryId, hostId: entry.hostId, workerId: entry.workerId, executionId: entry.executionId,
    completedAt: entry.completedAt, outcome: entry.outcome, reportSha256: entry.reportSha256, manifestSha256: entry.manifestSha256 };
}

function scan(context, protectedIds) {
  context.guard();
  const names = fs.readdirSync(context.historyRoot).filter((name) => name !== HISTORY_MARKER && name !== LOCK).sort();
  requireThat(names.length <= 1024, 'history scan bound exceeded; manual inspection required');
  const valid = [];
  const pinned = [];
  for (const entryId of names) {
    try {
      const entry = inspectEntry(context, entryId);
      valid.push(entry);
      if (protectedIds.has(entryId) || protectedIds.has(entry.executionId)) {
        pinned.push({ entryId, workerId: entry.workerId, executionId: entry.executionId, reason: 'protected', status: 'retained' });
      }
    } catch (error) {
      pinned.push({ entryId, reason: 'unknown-or-partial', status: 'unknown', requested: protectedIds.has(entryId), error: errorInfo(error) });
    }
  }
  return { valid, pinned };
}

function entryRef(entry) {
  return { entryId: entry.entryId, workerId: entry.workerId, executionId: entry.executionId, completedAt: entry.completedAt };
}

function assertRemaining(context, entry, remaining) {
  context.guard();
  const dir = child(context, entry.entryId);
  directoryStamp(dir, entry.dirStamp);
  requireThat(fs.readdirSync(dir).sort().join(',') === [...remaining].sort().join(','), 'entry changed before deletion; extra/partial files pinned');
  const seal = readJson(archivePath(context, entry.entryId), 8192);
  requireThat(seal.digest === entry.seal.digest && seal.stamp === entry.seal.stamp, 'archive receipt changed before deletion');
  for (const file of remaining) {
    const current = readJson(path.join(dir, file), file === 'manifest.json' ? 8192 : WATCH_HISTORY_REPORT_MAX_BYTES);
    requireThat(current.digest === entry.files[file].digest && current.stamp === entry.files[file].stamp, 'entry file changed before deletion');
  }
}

function cleanup(context, protectedIds, result) {
  let snapshot = scan(context, protectedIds);
  const groups = new Map();
  for (const entry of snapshot.valid) {
    if (!groups.has(entry.workerId)) groups.set(entry.workerId, []);
    groups.get(entry.workerId).push(entry);
  }
  const candidates = [];
  for (const group of groups.values()) {
    group.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt)
      || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
    candidates.push(...group.slice(WATCH_HISTORY_REPORTS_PER_WORKER)
      .filter((entry) => !protectedIds.has(entry.entryId) && !protectedIds.has(entry.executionId)));
  }
  candidates.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt) || a.entryId.localeCompare(b.entryId, 'en'));
  for (const entry of candidates) {
    const ref = entryRef(entry);
    const prefix = path.join(context.auditRoot, `${result.operationId}-cleanup-${entry.entryId}`);
    const receipts = { entryId: entry.entryId, intent: null, outcome: null };
    result.receipts.cleanup.push(receipts);
    const deletedFiles = [];
    let removed = false;
    let failure;
    try {
      assertRemaining(context, entry, FILES);
      atomicJson(`${prefix}-intent.json`, { ...base('watch-history-cleanup-intent'), operationId: result.operationId,
        rootId: context.rootId, ...ref, path: entry.dir, reportSha256: entry.reportSha256, manifestSha256: entry.manifestSha256,
        files: FILES, recordedAt: new Date().toISOString() }, context.guard);
      receipts.intent = `${prefix}-intent.json`;
      const remaining = [...FILES];
      // Never recursive rm: even a newly added PCM/subdirectory cannot be erased.
      for (const file of ['report.json', 'manifest.json']) {
        assertRemaining(context, entry, remaining);
        fs.unlinkSync(path.join(entry.dir, file));
        deletedFiles.push(file);
        remaining.splice(remaining.indexOf(file), 1);
        syncDirectory(entry.dir);
      }
      assertRemaining(context, entry, []);
      fs.rmdirSync(entry.dir);
      syncDirectory(context.historyRoot);
      context.guard();
      requireThat(!statIfPresent(entry.dir), 'directory still present after cleanup');
      removed = true;
    } catch (error) { failure = errorInfo(error); }
    let status = failure ? (receipts.intent ? 'unknown' : 'failed') : 'deleted';
    try {
      atomicJson(`${prefix}-outcome.json`, { ...base('watch-history-cleanup-outcome'), operationId: result.operationId,
        rootId: context.rootId, ...ref, status, removed, deletedFiles, error: failure ?? null,
        intent: receipts.intent, recordedAt: new Date().toISOString() }, context.guard);
      receipts.outcome = `${prefix}-outcome.json`;
    } catch (error) { failure = errorInfo(error); status = 'unknown'; }
    if (status === 'deleted') result.cleanup.deleted.push({ ...ref, status, ...receipts });
    else result.cleanup.failures.push({ ...ref, status, removed, deletedFiles, error: failure, ...receipts });
  }
  if (candidates.length) snapshot = scan(context, protectedIds);
  result.cleanup.retained = snapshot.valid.map(entryRef);
  result.cleanup.pinned = snapshot.pinned;
  for (const failure of result.cleanup.failures) {
    if (!result.cleanup.pinned.some((item) => item.entryId === failure.entryId)) {
      result.cleanup.pinned.push({ ...entryRef(failure), reason: 'cleanup-failure', status: failure.status, error: failure.error });
    }
  }
  const counts = new Map();
  for (const entry of snapshot.valid) counts.set(entry.workerId, (counts.get(entry.workerId) ?? 0) + 1);
  result.cleanup.overLimitByWorker = Object.fromEntries([...counts].map(([id, count]) => [id, Math.max(0, count - WATCH_HISTORY_REPORTS_PER_WORKER)]));
  result.cleanup.unclassifiedCount = snapshot.pinned.filter((item) => item.status === 'unknown').length;
  result.cleanup.status = result.cleanup.failures.length || result.cleanup.unclassifiedCount ? 'partial' : 'success';
  result.reportRetained = snapshot.valid.some((entry) => entry.entryId === result.entryId) ? true
    : snapshot.pinned.some((entry) => entry.entryId === result.entryId) ? null : false;
}

/**
 * Synchronous, standalone local-host history (NOT a release gate).
 * Use stable workerIds for the four hosts. Each worker retains its newest 30 by
 * completedAt (UTC ISO, ties: ascending entryId); older protected IDs are EXTRA.
 * report = { originalRefs: [{ ref: opaqueString, sha256: hex }], summary: JSON }.
 * Empty refs are allowed for early failures; supplied refs/hashes are NOT verified.
 * Neither refs nor summary are interpreted as paths. Entire envelope <= 1 MiB.
 * protectedIds is an array of executionIds or returned entryIds, for THIS call.
 * Carry pins on every call. Unknown/partial/changed entries are always pinned.
 * Roots must be disjoint local paths. Missing ancestors are created one at a time
 * after validation. Only absent or empty leaf roots can be initialized. Multiple
 * worker history roots may share one audit root. History ownership permanently
 * binds its path, audit path/auditId and hostname; moved roots, stale locks and
 * inconsistent ownership fail closed.
 * Receipts are write-once, exclusive, retained outside FIFO; never prune audit.
 * Returns a compact summary, never the cleanup plan or report content:
 * verdict = success | partial | failed (operation ONLY; not the terminal outcome),
 * ok, releaseEvidence=false, archived, archiveState, reportRetained, cleanupStatus,
 * entryId, workerId, executionId, reportPath, manifestPath, reportSha256,
 * counts={retained,deleted,pinned,failed,unknown,overLimit}, auditOutcomePath,
 * auditArchivePath, errorCodes and durability. Counts concern this history root:
 * retained/overLimit count digest-verified entries, pins can be EXTRA, failed counts
 * unsuccessful cleanup attempts, unknown counts distinct unsafe/unconfirmed IDs.
 * Unmeasured counts are null (never an invented zero). Detailed per-entry decisions,
 * intent/outcome paths, errors and counts per worker live in auditOutcomePath only.
 * archived records a durable archive, NOT continued retention or release approval.
 * An identical retry is read-only for report/seal; a conflict or retired ID fails.
 * Only cooperative writers are serialized. Portable Node path APIs cannot close
 * every hostile rename/reparse TOCTOU window; restrict both roots' ACLs. No native
 * Windows directory fsync/WORM or cryptographic source attestation is claimed.
 */
export function recordWatchHistoryReport(options = {}) {
  const result = { ...base('watch-history-result'), operationId: randomUUID(), ok: false, status: 'failed',
    archived: false, archiveState: 'not-started', entryId: null, reportPath: null, reportSha256: null, reportRetained: null,
    durability: process.platform === 'win32' ? 'file-fsync; directory-fsync-unavailable' : 'file-and-directory-fsync',
    receipts: { intent: null, archive: null, cleanup: [], outcome: null },
    cleanup: { status: 'not-run', retentionPerWorker: WATCH_HISTORY_REPORTS_PER_WORKER, deleted: [], retained: [],
      pinned: [], failures: [], overLimitByWorker: {}, unclassifiedCount: null }, errors: [] };
  let context;
  let lock;
  let phase = 'validate';
  let archiveTouched = false;
  try {
    // Validate JSON, timestamp and identities before even claiming empty roots.
    entryPayload({ rootId: '00000000-0000-0000-0000-000000000000', hostId: os.hostname() }, options);
    const pins = options.protectedIds ?? [];
    requireThat(Array.isArray(pins) && pins.length <= 1024, 'protectedIds must be a bounded array');
    const protectedIds = new Set(pins.map(identity));
    phase = 'roots';
    context = prepareRoots(options.historyRoot, options.auditRoot);
    result.historyRoot = context.historyRoot;
    result.auditRoot = context.auditRoot;
    const entry = entryPayload(context, options);
    result.entryId = entry.entryId;
    result.workerId = entry.workerId;
    result.executionId = entry.executionId;
    result.outcome = entry.outcome;
    result.reportSha256 = entry.reportSha256;
    result.reportPath = path.join(child(context, entry.entryId), 'report.json');
    phase = 'lock';
    context.guard();
    const lockPath = path.join(context.historyRoot, LOCK);
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try {
      lock = { path: lockPath, stamp: stamp(fs.fstatSync(fd, { bigint: true })) };
      fs.writeFileSync(fd, jsonBytes({ ...base('watch-history-lock'), operationId: result.operationId }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    phase = 'archive-intent';
    const intentPath = path.join(context.auditRoot, `${result.operationId}-intent.json`);
    atomicJson(intentPath, { ...base('watch-history-record-intent'), operationId: result.operationId,
      rootId: context.rootId, ...entryRef(entry), outcome: entry.outcome, reportSha256: entry.reportSha256,
      protectedIds: [...protectedIds], recordedAt: new Date().toISOString() }, context.guard);
    result.receipts.intent = intentPath;
    phase = 'archive';
    const dir = child(context, entry.entryId);
    if (statIfPresent(dir)) {
      const existing = inspectEntry(context, entry.entryId);
      requireThat(existing.reportSha256 === entry.reportSha256 && existing.manifestSha256 === entry.manifestSha256,
        'immutable execution conflict');
      result.archiveState = 'already-recorded';
    } else {
      requireThat(!statIfPresent(archivePath(context, entry.entryId)), 'execution already retired or partial; never reuse an immutable ID');
      context.guard();
      fs.mkdirSync(dir);
      archiveTouched = true;
      const ownedStamp = directoryStamp(dir);
      const guardEntry = () => { context.guard(); directoryStamp(dir, ownedStamp); };
      atomicJson(path.join(dir, 'report.json'), entry.envelope, guardEntry);
      atomicJson(path.join(dir, 'manifest.json'), entry.manifest, guardEntry);
      syncDirectory(context.historyRoot);
      // Independent immutable seal binds BOTH report and ownership manifest.
      atomicJson(archivePath(context, entry.entryId), archiveReceipt(entry, result.operationId, new Date().toISOString()), guardEntry);
      inspectEntry(context, entry.entryId);
      result.archiveState = 'archived';
    }
    result.archived = true;
    result.receipts.archive = archivePath(context, entry.entryId);
    result.reportRetained = true;
    // Absolutely no FIFO if publication, fsync, or the independent seal failed.
    phase = 'cleanup';
    cleanup(context, protectedIds, result);
  } catch (error) {
    result.errors.push({ phase, ...errorInfo(error) });
    if (!result.archived) result.archiveState = archiveTouched ? 'unknown' : 'failed';
    if (phase === 'cleanup') { result.cleanup.status = 'unknown'; result.reportRetained = null; }
  } finally {
    if (lock) {
      try {
        context.guard();
        verifiedWatchPath(lock.path, { directory: false });
        requireThat(stamp(fs.lstatSync(lock.path, { bigint: true })) === lock.stamp, 'lock replaced; manual recovery required');
        fs.unlinkSync(lock.path);
        syncDirectory(context.historyRoot);
      } catch (error) { result.errors.push({ phase: 'unlock', ...errorInfo(error) }); }
    }
  }
  result.ok = result.archived && result.cleanup.status === 'success' && result.errors.length === 0;
  result.status = result.ok ? 'success' : result.archived ? 'partial' : 'failed';
  if (context) {
    try {
      const target = path.join(context.auditRoot, `${result.operationId}-outcome.json`);
      result.receipts.outcome = target;
      atomicJson(target, result, context.guard);
    } catch (error) {
      result.receipts.outcome = null;
      result.errors.push({ phase: 'record-outcome', ...errorInfo(error) });
      result.ok = false;
      result.status = result.archived ? 'partial' : 'failed';
    }
  }
  return compactSummary(result);
}

function compactSummary(result) {
  const measured = result.cleanup.unclassifiedCount !== null && result.cleanup.status !== 'unknown';
  const unsafe = result.cleanup.pinned.filter((item) => item.status === 'unknown');
  const failures = result.cleanup.failures;
  const codes = [...result.errors, ...failures.map((item) => item.error), ...unsafe.map((item) => item.error)]
    .filter(Boolean).map((error) => String(error.code ?? 'watch.history.unknown').slice(0, 80));
  return {
    verdict: result.status, ok: result.ok, releaseEvidence: false,
    archived: result.archived, archiveState: result.archiveState, reportRetained: result.reportRetained,
    cleanupStatus: result.cleanup.status, entryId: result.entryId,
    workerId: result.workerId ?? null, executionId: result.executionId ?? null,
    reportPath: result.reportPath,
    manifestPath: result.reportPath ? path.join(path.dirname(result.reportPath), 'manifest.json') : null,
    reportSha256: result.reportSha256,
    counts: {
      retained: measured ? result.cleanup.retained.length : null, deleted: result.cleanup.deleted.length,
      pinned: measured ? result.cleanup.pinned.length : null, failed: failures.length,
      unknown: measured ? new Set([...unsafe, ...failures.filter((item) => item.status === 'unknown')].map((item) => item.entryId)).size : null,
      overLimit: measured ? Object.values(result.cleanup.overLimitByWorker).reduce((sum, count) => sum + count, 0) : null,
    },
    auditOutcomePath: result.receipts.outcome, auditArchivePath: result.receipts.archive,
    errorCodes: [...new Set(codes)].slice(0, 8), durability: result.durability,
  };
}
