import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/testing-common.mjs';
import { checkWatchDiskSpace, verifiedWatchPath, writeWatchDiskReceipt } from './watch-mode-disk-lifecycle.mjs';
import { requiredCellArtifactPaths } from './watch-mode-evidence-authority.mjs';
import { probeWatchHistoryQuiescence } from './watch-mode-history-quiescence.mjs';
export { probeWatchHistoryQuiescence };

export const WATCH_HISTORY_KEEP = 30;
const ID = /^[a-z0-9][a-z0-9._-]{0,199}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const KINDS = new Set(['mixed', 'executions', 'runtimes', 'isolation', 'reports']);
const MAX_ENTRIES = 50000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_PROOF_BYTES = 8 * 1024 ** 3;
// Input-only tuple, verified byte-for-byte against repository HEAD 040d5a5 on
// 2026-09-12. Trust is outside the retired tree: re-sealing candidate metadata
// cannot authorize another waveform or transcript. New versions need review.
const CANONICAL_ISOLATION_FIXTURE = Object.freeze([
  ['watch-mode-en-original.wav', 6039180, 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f'],
  ['watch-mode-en-original.sha256', 93, '86d107fe0352d0acd30557669d512bbe5e1ba37c2df16af046c32bcdb76a7482'],
  ['watch-mode-audio-fixtures.json', 1991, 'c859960caeda705f5731d3ea0238535be1bd929221dcf89150bb6fc24b222809'],
  ['watch-mode-en-original.txt', 1787, 'fa5ffb6fd4471ee2eafc95b9bed7abfc78e8dc2b7e2ce77f4c3f8db5de1b4383'],
  ['watch-mode-en-original.zh-CN.txt', 1574, '254f5525c602a77a249c4be3cee78576ac7ee9ad957d6bdcb2cfa4f93fc10d56'],
].map(([name, bytes, sha256]) => Object.freeze({ path: `scripts/testing/fixtures/${name}`, bytes, sha256 })));
// Observations written by EvidenceCollection/PreDesktopPhase/DesktopLifecycle,
// not inputs that choose a runtime. This is a REFERENCE-SCAN classification,
// never permission to alter raw evidence or forgive it in release validation.
const CELL_OBSERVATIONS = new Set([
  // Reuse the evidence contract, including nested translated-PCM observations.
  // run-collection embeds its launch request and MUST remain a dependency input.
  ...requiredCellArtifactPaths('process-exclusion').filter((file) => file !== 'run-collection.json'),
  'run-metadata.json', 'watch-runtime-status.json', 'watch-incremental-cues.jsonl',
  'physical-output-stt.raw.json', 'audio-analysis.json', 'shard-cell-result.json',
]);
const key = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonical(value[name])])) : value;
const requireProof = (condition, message) => { if (!condition) throw new Error(message); };
const contained = (root, target) => key(root) === key(target) || key(target).startsWith(`${key(root)}${path.sep}`);
const timestamp = (value) => {
  const result = typeof value === 'string' ? Date.parse(value) : NaN;
  requireProof(Number.isFinite(result) && /T.*(?:Z|[+-]\d\d:\d\d)$/u.test(value), 'missing/unparseable terminal time');
  return result;
};

function directChild(root, target) {
  requireProof(path.isAbsolute(target) && key(path.dirname(target)) === key(root)
    && key(root) !== key(target), `not an explicit direct child: ${target}`);
  return verifiedWatchPath(target);
}

function readJson(file) {
  verifiedWatchPath(file, { directory: false });
  requireProof(fs.statSync(file).size <= MAX_JSON_BYTES, 'JSON inspection bound exceeded');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
}

function relativeFile(root, relative) {
  requireProof(typeof relative === 'string' && relative.length > 0
    && !path.win32.isAbsolute(relative) && !path.posix.isAbsolute(relative)
    && !relative.includes('\\') && !relative.includes(':')
    && relative.split('/').every((part) => part && part !== '.' && part !== '..'), 'unsafe evidence relative path');
  const file = path.join(root, ...relative.split('/'));
  requireProof(contained(root, file), 'evidence escaped its root');
  return verifiedWatchPath(file, { directory: false });
}

function fileHash(file, budget) {
  verifiedWatchPath(file, { directory: false });
  const before = fs.statSync(file);
  budget.bytes += before.size;
  requireProof(budget.bytes <= MAX_PROOF_BYTES, 'evidence byte inspection bound exceeded');
  const fd = fs.openSync(file, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    const after = fs.fstatSync(fd);
    requireProof(before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs
      && before.ctimeMs === after.ctimeMs, 'evidence changed while hashing');
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function treeSnapshot(root) {
  verifiedWatchPath(root);
  const entries = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    verifiedWatchPath(current, { directory: stat.isDirectory() });
    requireProof(stat.isDirectory() || stat.isFile(), 'special files are protected');
    entries.push({ relative: path.relative(root, current), directory: stat.isDirectory(),
      bytes: stat.size, ino: stat.ino, birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
    requireProof(entries.length <= MAX_ENTRIES, 'tree inspection bound exceeded');
    if (stat.isDirectory()) for (const child of fs.readdirSync(current).sort().reverse()) stack.push(path.join(current, child));
  }
  return entries;
}

// Renaming only changes the generation root's directory timestamps. Preserve
// inode/birthtime and every descendant attribute in the retirement binding.
const retirementSnapshot = (items) => items.map((item) => item.relative === ''
  ? { ...item, mtimeMs: null, ctimeMs: null } : item);

export function classifyWatchHistory(name, rootKind = 'mixed') {
  if (rootKind === 'reports') return 'reports';
  if (['artifacts', '.provider-preflight', 'li', 'source-sync', 'watch-source-sync', 'watch-source-bundles'].includes(name)
    || name.includes('.preflight-authorization')) return 'container';
  if (/^runtime-[a-z0-9-]+$/iu.test(name)) return 'runtime';
  if (/^local-isolation-/iu.test(name)) return 'isolation';
  if (/^(?:watch-prod-|watch-shard-)/iu.test(name) || (rootKind === 'executions' && ID.test(name))) return 'execution';
  return 'unknown';
}

function protection(entry, options) {
  if ([...(options.protectedIds ?? []), ...(options.activeIds ?? [])]
    .some((id) => key(id) === key(entry.name))) return 'explicit-protection';
  if ([...(options.protectedPaths ?? []), ...(options.referenceRoots ?? [])]
    .some((root) => contained(entry.path, root) || contained(root, entry.path))) return 'protected-reference-path';
  if ((entry.type === 'runtime' || entry.type === 'isolation') && !options.retireCaches) return 'cache-retirement-not-enabled';
  if (entry.type === 'runtime' || entry.type === 'isolation') return null;
  if (entry.type !== 'execution') return 'unknown-or-report-container';
  return null;
}

// Collection results are the coordinator's successful-collection authority.
// A directory name, mtime, stale process inventory or verdict alone is not proof.
function terminalProof(entry, referenceRoots, nowMs) {
  const matches = [];
  for (const referenceRoot of referenceRoots) {
    const base = path.join(referenceRoot, entry.name);
    if (fs.existsSync(path.join(base, 'worker-collection-results.json'))) matches.push(base);
  }
  requireProof(matches.length === 1, 'requires exactly one collected coordinator reference root');
  const collectedRoot = verifiedWatchPath(matches[0]);
  requireProof(!contained(entry.path, collectedRoot), 'collection must survive outside execution target');
  const collection = readJson(path.join(collectedRoot, 'worker-collection-results.json'));
  requireProof(collection.schemaVersion === 1 && collection.artifactKind === 'watch-mode-worker-collection-results'
    && collection.executionId === entry.name && collection.allWorkersSettled === true
    && Array.isArray(collection.workers) && collection.workers.length > 0 && collection.workers.length <= 4
    && new Set(collection.workers.map((w) => w.workerId)).size === collection.workers.length
    && collection.workers.filter((w) => w.workerId === entry.workerId && w.status === 'collected').length === 1,
  'successful worker collection receipt is missing');
  const shard = verifiedWatchPath(path.join(collectedRoot, 'collected-shards', entry.workerId));
  const manifest = readJson(path.join(shard, 'shard-manifest.json'));
  const plan = readJson(path.join(shard, 'strict-shard-execution-plan.json'));
  requireProof(manifest.schemaVersion === 3 && manifest.artifactKind === 'watch-mode-paid-shard-manifest'
    && manifest.executionId === entry.name && manifest.workerId === entry.workerId
    && ['passed', 'failed'].includes(manifest.verdict) && HASH.test(manifest.manifestDigest)
    && HASH.test(manifest.planDigest) && plan.schemaVersion === 3 && plan.artifactKind === 'watch-mode-paid-shard-execution-plan'
    && plan.executionId === entry.name && plan.planDigest === manifest.planDigest
    && Array.isArray(plan.cells) && Array.isArray(manifest.results), 'collected shard identity/schema mismatch');
  const { manifestDigest, ...manifestCore } = manifest;
  requireProof(manifestDigest === digest(JSON.stringify(canonical(manifestCore))), 'collected manifest digest mismatch');
  const cells = plan.cells.filter((cell) => cell.workerId === entry.workerId);
  requireProof(cells.length > 0 && cells.length === manifest.assignedCellCount
    && manifest.results.length === cells.length
    && new Set(manifest.results.map((result) => result.leaseId)).size === cells.length, 'incomplete terminal result set');
  const terminalTimes = [];
  for (const cell of cells) {
    requireProof(ID.test(cell.leaseId), 'unsafe lease id');
    // Older schema-v3 captures omit cellId in this binding; the signed plan,
    // cellIndex, lease and terminal identities must still all agree.
    const result = manifest.results.find((value) => value.leaseId === cell.leaseId && value.cellIndex === cell.cellIndex
      && (value.cellId === undefined || value.cellId === cell.cellId));
    requireProof(result && HASH.test(result.result?.sha256) && Number.isSafeInteger(result.result.bytes), 'missing hashed result');
    const terminal = readJson(path.join(shard, 'lease-terminals', `${cell.leaseId}.json`));
    const cleanup = readJson(path.join(shard, 'interactive', cell.leaseId, 'cleanup.scheduler.json'));
    const taskTerminal = readJson(path.join(shard, 'interactive', cell.leaseId, 'task-terminal.json'));
    const interactive = readJson(path.join(shard, 'interactive', cell.leaseId, 'terminal.json'));
    for (const receipt of [terminal, cleanup, taskTerminal, interactive]) {
      requireProof(receipt.executionId === entry.name && receipt.workerId === entry.workerId
        && receipt.leaseId === cell.leaseId && receipt.cellId === cell.cellId, 'terminal/cleanup identity mismatch');
    }
    requireProof(terminal.schemaVersion === 1 && terminal.artifactKind === 'watch-mode-paid-shard-lease-terminal'
      && terminal.planDigest === manifest.planDigest && ['passed', 'failed'].includes(terminal.status), 'missing lease terminal');
    requireProof(cleanup.artifactKind === 'watch-mode-interactive-scheduler-cleanup'
      && cleanup.passed === true && cleanup.status === 'completed' && cleanup.taskCleanupPassed === true
      && cleanup.processCleanup?.passed === true && cleanup.processCleanup.status === 'completed', 'active or unconfirmed process/task cleanup');
    requireProof(taskTerminal.artifactKind === 'watch-mode-interactive-scheduled-task-terminal'
      && taskTerminal.planDigest === manifest.planDigest && HASH.test(taskTerminal.terminalSha256)
      && interactive.artifactKind === 'watch-mode-interactive-task-terminal'
      && interactive.executionReceiptObserved === true && interactive.planDigest === manifest.planDigest,
    'interactive task terminal is missing');
    requireProof(digest(fs.readFileSync(path.join(shard, 'interactive', cell.leaseId, 'terminal.json')))
      === taskTerminal.terminalSha256, 'interactive terminal hash mismatch');
    terminalTimes.push(timestamp(terminal.terminalAt), timestamp(taskTerminal.completedAt), timestamp(interactive.completedAt));
  }
  const terminalMs = Math.max(...terminalTimes, timestamp(manifest.generatedAt), timestamp(collection.generatedAt));
  requireProof(terminalMs <= nowMs && timestamp(manifest.generatedAt) <= timestamp(collection.generatedAt)
    && terminalTimes.every((time) => time <= timestamp(collection.generatedAt)), 'nonterminal/future collection timestamp');
  return { shard, collectedRoot, collection, manifest, plan, terminalMs };
}

function proveCollectedBytes(entry, proof) {
  directChild(entry.root, entry.path);
  const children = fs.readdirSync(entry.path);
  requireProof(children.length === 1 && children[0] === entry.workerId, 'execution contains unknown siblings/other workers');
  const workerRoot = verifiedWatchPath(path.join(entry.path, entry.workerId));
  const before = treeSnapshot(entry.path);
  const budget = { bytes: 0 };
  const hashes = [];
  for (const file of treeSnapshot(workerRoot).filter((value) => !value.directory)) {
    const relative = file.relative.split(path.sep).join('/');
    const source = relativeFile(workerRoot, relative);
    const copy = relativeFile(proof.shard, relative);
    requireProof(fs.statSync(copy).size === file.bytes, `collected evidence size mismatch: ${relative}`);
    const hash = fileHash(source, budget);
    requireProof(hash === fileHash(copy, budget), `collected evidence hash mismatch: ${relative}`);
    hashes.push({ relative, bytes: file.bytes, sha256: hash });
  }
  for (const result of proof.manifest.results) {
    const matched = hashes.find((file) => file.relative === result.result.path);
    requireProof(matched?.sha256 === result.result.sha256 && matched.bytes === result.result.bytes, 'result authority differs from collected bytes');
    const body = readJson(relativeFile(workerRoot, result.result.path));
    requireProof(body.executionId === entry.name && body.leaseId === result.leaseId
      && body.planDigest === proof.manifest.planDigest && Array.isArray(body.artifacts), 'result identity mismatch');
    for (const artifact of body.artifacts) {
      relativeFile(workerRoot, `${result.runDirectory}/${artifact.path}`);
      const file = hashes.find((value) => value.relative === `${result.runDirectory}/${artifact.path}`);
      requireProof(file && file.sha256 === artifact.sha256 && file.bytes === artifact.bytes, 'raw/signed artifact copy is incomplete');
    }
  }
  requireProof(JSON.stringify(before) === JSON.stringify(treeSnapshot(entry.path)), 'execution changed during evidence verification');
  return { fingerprint: digest(JSON.stringify({ before, hashes, collection: proof.collection })),
    treeFingerprint: digest(JSON.stringify(before)),
    retirementFingerprint: digest(JSON.stringify({ before: retirementSnapshot(before), hashes, collection: proof.collection })),
    bytes: hashes.reduce((sum, file) => sum + file.bytes, 0), manifestDigest: proof.manifest.manifestDigest,
    collectionRoot: proof.collectedRoot, terminalMs: proof.terminalMs };
}

function validateRoots(options) {
  requireProof(Array.isArray(options.roots) && options.roots.length > 0 && options.roots.length <= 16, 'one to sixteen explicit typed roots required');
  requireProof(new Set(options.roots.map((root) => root.workerId)).size <= 4, 'at most four workers are supported');
  const roots = options.roots.map((root) => {
    requireProof(ID.test(root.workerId) && KINDS.has(root.kind), 'invalid worker/root kind');
    const absolute = verifiedWatchPath(root.path);
    requireProof(absolute !== path.parse(absolute).root, 'a volume root cannot be history');
    return { ...root, path: absolute };
  });
  for (let i = 0; i < roots.length; i += 1) for (let j = i + 1; j < roots.length; j += 1) {
    requireProof(!contained(roots[i].path, roots[j].path) && !contained(roots[j].path, roots[i].path), 'duplicate or overlapping history roots');
  }
  return roots;
}

function requireCanonicalFixtureSeal(files) {
  for (const trusted of CANONICAL_ISOLATION_FIXTURE) {
    const sealed = files.find((file) => file.path === trusted.path);
    requireProof(sealed?.bytes === trusted.bytes && sealed.sha256 === trusted.sha256,
      `untrusted canonical fixture tuple: ${trusted.path}`);
  }
}

function cacheSeal(entry, receiptRoots, { payloadPath = entry.path } = {}) {
  let seal; let authorityPath; let files;
  if (entry.type === 'isolation') {
    authorityPath = path.join(payloadPath, 'runtime-distribution.json');
    seal = readJson(authorityPath);
    const { distributionDigest, ...core } = seal;
    requireProof(seal.schemaVersion === 1 && seal.artifactKind === 'watch-mode-local-isolation-runtime-distribution'
      && HASH.test(distributionDigest) && entry.name === `local-isolation-${distributionDigest}`
      && distributionDigest === digest(JSON.stringify(canonical(core))), 'isolation cache is not digest-sealed');
    files = seal.files;
  } else {
    const authorities = receiptRoots.map((root) => path.join(root, entry.name, 'success.json')).filter((file) => fs.existsSync(file));
    requireProof(authorities.length === 1, 'runtime cache requires one lightweight successful distribution receipt');
    authorityPath = authorities[0];
    seal = readJson(authorityPath);
    requireProof(seal.schemaVersion === 1 && seal.artifactKind === 'watch-runtime-distribution' && seal.status === 'success'
      && seal.executionId === entry.name && HASH.test(seal.authorityDigest)
      && Array.isArray(seal.workers) && seal.workers.filter((worker) => worker.workerId === entry.workerId).length === 1,
    'runtime cache distribution is not sealed');
    const worker = seal.workers.find((value) => value.workerId === entry.workerId);
    requireProof(worker.schemaVersion === 1 && worker.artifactKind === 'watch-runtime-worker-distribution'
      && key(worker.executionRoot) === key(path.join(entry.path, entry.workerId))
      && key(worker.runtimeRoot) === key(path.join(entry.path, entry.workerId, 'runtime'))
      && worker.identity?.clean === true, 'runtime distribution worker/path mismatch');
    files = worker.entries?.map((file) => ({ ...file, path: `${entry.workerId}/runtime/${file.path}` }));
    // Transfer scratch is cache data only when its own recorded hashes prove it.
    if (fs.existsSync(path.join(payloadPath, entry.workerId, 'delta'))) {
      files.push(...worker.entries.filter((file) => file.status === 'copied')
        .map((file) => ({ ...file, path: `${entry.workerId}/delta/${file.path}` })));
    }
    if (fs.existsSync(path.join(payloadPath, entry.workerId, 'delta.tar'))) {
      requireProof(HASH.test(worker.archive?.sha256), 'unsealed runtime transfer archive');
      files.push({ ...worker.archive, path: `${entry.workerId}/delta.tar` });
    }
  }
  requireProof(Array.isArray(files) && files.length > 0 && files.length < MAX_ENTRIES, 'empty/unbounded cache seal');
  requireProof(new Set(files.map((file) => key(file.path))).size === files.length, 'duplicate cache paths');
  for (const file of files) {
    requireProof(HASH.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0, 'invalid cache file authority');
    // These cache layouts contain code/binaries/contracts and the pinned source
    // fixture below, never run evidence or arbitrary files in a fixtures folder.
    const relative = entry.type === 'runtime' ? file.path.split('/').slice(2).join('/') : file.path;
    requireProof(/^(?:scripts|contracts|target|drivers)\//u.test(relative)
      || (entry.type === 'runtime' && file.path === `${entry.workerId}/delta.tar`), 'unknown cache payload layout');
    if (entry.type === 'isolation' && file.path === CANONICAL_ISOLATION_FIXTURE[0].path) {
      requireCanonicalFixtureSeal(files);
      // This identity check is not byte proof. proveCacheBytes must still hash
      // the entire tuple before deletion eligibility and again after quarantine.
    } else requireProof(!/\.(?:pcm|wav|mp3|flac)$/iu.test(file.path), 'raw audio is never cache payload');
    relativeFile(payloadPath, file.path);
  }
  const authorityBytes = fs.readFileSync(authorityPath);
  if (entry.type === 'isolation') files = [...files, { path: 'runtime-distribution.json', bytes: authorityBytes.length, sha256: digest(authorityBytes) }];
  const createdMs = fs.statSync(payloadPath).birthtimeMs;
  requireProof(Number.isFinite(createdMs) && createdMs > 0, 'cache creation time is unavailable');
  return { authorityPath, authoritySha256: digest(authorityBytes), seal, files,
    createdAt: new Date(createdMs).toISOString() };
}

function proveCacheBytes(entry, seal, { hashFiles = true } = {}) {
  directChild(entry.root, entry.path);
  const snapshot = treeSnapshot(entry.path);
  const directories = new Set(['']);
  const files = new Map(seal.files.map((file) => [key(file.path), file]));
  for (const file of seal.files) {
    const parts = file.path.split('/'); parts.pop();
    while (parts.length) { directories.add(key(parts.join('/'))); parts.pop(); }
  }
  const budget = { bytes: 0 };
  for (const item of snapshot) {
    const relative = item.relative.split(path.sep).join('/');
    if (item.directory) { requireProof(directories.has(key(relative)), 'cache has an unsealed directory'); continue; }
    const file = files.get(key(relative));
    requireProof(file && file.bytes === item.bytes, `cache has an unsealed/changed file: ${relative}`);
    if (hashFiles) requireProof(fileHash(relativeFile(entry.path, relative), budget) === file.sha256, `immutable cache hash mismatch: ${relative}`);
  }
  requireProof(snapshot.filter((item) => !item.directory).length === files.size, 'cache file inventory is incomplete');
  requireProof(JSON.stringify(snapshot) === JSON.stringify(treeSnapshot(entry.path)), 'cache changed during verification');
  return { fingerprint: digest(JSON.stringify({ snapshot, seal })), authorityPath: seal.authorityPath,
    retirementFingerprint: digest(JSON.stringify({ snapshot: retirementSnapshot(snapshot), files: seal.files,
      authoritySha256: seal.authoritySha256, seal: seal.seal, createdAt: seal.createdAt })),
    treeFingerprint: digest(JSON.stringify(snapshot)),
    authoritySha256: seal.authoritySha256, createdAt: seal.createdAt, bytes: budget.bytes,
    // Preserve lightweight authority/history before removing cache payloads.
    retainedSeal: seal.seal };
}

function cacheReferences(roots, referenceRoots, caches, fingerprintExclusions = [], quarantinedPaths = []) {
  const pinned = new Set(); const inspected = []; const visited = new Set();
  const cachesByPath = new Map(caches.map((entry) => [key(entry.path), entry]));
  const cacheOwnership = new Map(caches.filter((entry) => entry.cacheOwnershipPath)
    .map((entry) => [key(entry.cacheOwnershipPath), entry.cacheAuthoritySha256]));
  const stack = [...roots.map((root) => root.path), ...referenceRoots];
  let metadataCount = 0; let directoryCount = 0; let skippedSealedCacheTrees = 0; let bytes = 0;
  const metadataName = /\.(?:json|jsonl|ps1|mjs|cmd|bat|toml|ini|yaml|yml)$/iu;
  const dependencyName = (file) => metadataName.test(path.basename(file));
  const observationPlans = new Map();
  const isCellObservation = (file) => {
    const execution = /^(?:watch-prod-|watch-shard-|watch-release-)[a-z0-9._-]+$/iu;
    let context = null;
    for (const root of roots) {
      if (!contained(root.path, file)) continue;
      const parts = path.relative(root.path, file).split(path.sep);
      if (parts.length >= 5 && execution.test(parts[0]) && parts[1] === root.workerId
        && parts[2] === 'runs' && /^c\d+$/u.test(parts[3])) context = {
        shard: path.join(root.path, parts[0], parts[1]), executionId: parts[0], workerId: parts[1], cell: parts[3],
        output: parts.slice(4).join('/') };
    }
    for (const root of referenceRoots) {
      if (!contained(root, file)) continue;
      const parts = path.relative(root, file).split(path.sep);
      if (parts.length >= 6 && execution.test(parts[0]) && ['collected-shards', 'validation-shards'].includes(parts[1])
        && ID.test(parts[2]) && parts[3] === 'runs' && /^c\d+$/u.test(parts[4])) context = {
        shard: path.join(root, ...parts.slice(0, 3)), planPath: path.join(root, parts[0], 'strict-shard-execution-plan.json'),
        executionId: parts[0], workerId: parts[2], cell: parts[4], output: parts.slice(5).join('/') };
    }
    if (!context || !CELL_OBSERVATIONS.has(context.output)) return false;
    const planPath = context.planPath ?? path.join(context.shard, 'strict-shard-execution-plan.json');
    if (!observationPlans.has(planPath)) {
      let plan = null;
      try {
        const value = readJson(planPath); const { signature, planDigest, ...core } = value;
        if (value.schemaVersion === 3 && value.artifactKind === 'watch-mode-paid-shard-execution-plan'
          && value.executionId === context.executionId && Array.isArray(value.cells) && HASH.test(planDigest)
          && planDigest === digest(JSON.stringify(canonical(core)))) plan = value;
      } catch { /* An unproved layout stays in the strict reference scan. */ }
      observationPlans.set(planPath, plan);
    }
    return observationPlans.get(planPath)?.cells.some((cell) => cell.workerId === context.workerId
      && Number.isInteger(cell.cellIndex) && `c${String(cell.cellIndex + 1).padStart(2, '0')}` === context.cell) === true;
  };
  const opaqueObservations = [];
  while (stack.length) {
    const current = stack.pop();
    // Caller has just re-proved these private generations after atomic detach.
    // They are not reusable launch paths. All other trees, including a newly
    // recreated original path, remain in the strict reference inspection.
    if (quarantinedPaths.some((root) => contained(root, current))) continue;
    if (visited.has(key(current))) continue;
    visited.add(key(current));
    const stat = fs.lstatSync(current);
    verifiedWatchPath(current, { directory: stat.isDirectory() });
    if (stat.isDirectory()) {
      requireProof(++directoryCount <= MAX_ENTRIES, `reference directory bound exceeded at ${current}`);
      const cache = cachesByPath.get(key(current));
      if (cache?.cacheTreeFingerprint && cache.cacheTreeFingerprint === digest(JSON.stringify(treeSnapshot(current)))) {
        // Exact manifest membership, sizes and regular-local-file topology were
        // validated. Only JSON/config metadata can be a dependency authority;
        // do not descend the listed scripts/target/drivers/contracts closures.
        skippedSealedCacheTrees += 1;
        stack.push(...cache.cacheDependencyFiles.filter(dependencyName));
        continue;
      }
      for (const child of fs.readdirSync(current, { withFileTypes: true })) {
        requireProof(!child.isSymbolicLink(), `reference symlink/reparse path is forbidden: ${path.join(current, child.name)}`);
        // Binary/audio/report-log leaves are not requests or configuration.
        // They do not consume the metadata budget and are never opened here.
        if (child.isDirectory()
          || (!child.isDirectory() && dependencyName(path.join(current, child.name)))) stack.push(path.join(current, child.name));
      }
      continue;
    }
    // Only the matching-generation fast path above may skip sealed source.
    // Changed/recreated trees cannot inherit planned .mjs/.ps1 path exemptions:
    // those files may now be launch/reference inputs and must be inspected.
    // Actual execution/isolation/preflight layouts store requests, authorities
    // and runtimeRoot/distributionDigest references in JSON. Text launch/config
    // files are scanned too. Never read historic PCM to retire immutable caches.
    if (!metadataName.test(current)) continue;
    if (isCellObservation(current)) {
      // This digest-bound per-cell output is not a launch/config input. Large
      // journals must not exhaust the dependency budget, and corrupt historic
      // observations must not be rewritten. All owner plans/requests are still
      // inspected, including those in copied validation trees.
      opaqueObservations.push({ path: current, bytes: stat.size });
      continue;
    }
    requireProof(++metadataCount <= MAX_ENTRIES, `reference metadata entry bound exceeded at ${current}`);
    requireProof(stat.size <= MAX_JSON_BYTES && (bytes += stat.size) <= 256 * 1024 * 1024,
      `reference metadata byte bound exceeded at ${current} (${metadataCount} files, ${bytes} bytes)`);
    const content = fs.readFileSync(current, 'utf8').replace(/^\uFEFF/u, '');
    let text = content;
    if (/\.json$/iu.test(current)) {
      let document;
      try { document = JSON.parse(content); }
      catch { throw new Error(`reference metadata is not valid JSON: ${current}`); }
      // Ownership receipts describe the cache itself, not a live dependency.
      if (cacheOwnership.has(key(current))) {
        requireProof(digest(fs.readFileSync(current)) === cacheOwnership.get(key(current)), 'cache ownership receipt changed');
        continue;
      }
      if (document !== undefined) text = JSON.stringify(document);
    }
    const after = fs.statSync(current);
    requireProof(after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, 'reference changed while reading');
    // Candidate cache metadata is still inspected for references (including
    // unknown/unsealed caches), but its eventual removal cannot invalidate the
    // fingerprint of the retained dependency graph.
    if (!fingerprintExclusions.some((root) => contained(root, current))) inspected.push({ path: current, sha256: digest(content) });
    const lower = text.toLowerCase();
    for (const cache of caches) {
      if (lower.includes(cache.name.toLowerCase()) || (cache.type === 'isolation'
        && lower.includes(cache.name.slice('local-isolation-'.length).toLowerCase()))) pinned.add(cache.name);
    }
  }
  inspected.sort((a, b) => a.path.localeCompare(b.path));
  return { pinned: [...pinned].sort(), fingerprint: digest(JSON.stringify(inspected)), inspectedMetadataFiles: inspected.length,
    visitedDirectories: directoryCount, metadataBytes: bytes, skippedSealedCacheTrees, opaqueObservations };
}

export function planWatchTypedHistory(options) {
  const roots = validateRoots(options);
  const referenceRoots = (options.referenceRoots ?? []).map((root) => verifiedWatchPath(root));
  const cacheReceiptRoots = (options.cacheReceiptRoots ?? []).map((root) => verifiedWatchPath(root));
  const protectedPaths = (options.protectedPaths ?? []).map((root) => verifiedWatchPath(root));
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const entries = [];
  for (const root of roots) {
    for (const name of fs.readdirSync(root.path).sort()) {
      requireProof(entries.length < MAX_ENTRIES, 'history entry bound exceeded');
      const target = path.join(root.path, name);
      const entry = { workerId: root.workerId, root: root.path, path: target, name,
        type: classifyWatchHistory(name, root.kind), action: 'retain', reason: null };
      entries.push(entry);
      try {
        directChild(root.path, target);
        entry.reason = protection(entry, { ...options, referenceRoots, protectedPaths });
        if (options.retireCaches && ['runtime', 'isolation'].includes(entry.type)) {
          const seal = cacheSeal(entry, cacheReceiptRoots);
          const layout = proveCacheBytes(entry, seal, { hashFiles: false });
          entry.cacheCreatedAt = seal.createdAt;
          entry.cacheAuthoritySha256 = seal.authoritySha256;
          entry.cacheOwnershipPath = seal.authorityPath;
          entry.cacheTreeFingerprint = layout.treeFingerprint;
          entry.cacheDependencyFiles = seal.files.filter((file) => /\.(?:json|jsonl|toml|ini|yaml|yml)$/iu.test(file.path))
            .map((file) => path.join(entry.path, ...file.path.split('/')));
          // Retained for audit compatibility, never a fallback-scan exemption.
          entry.cacheSourceFiles = seal.files.filter((file) => /\.(?:mjs|ps1)$/iu.test(file.path))
            .map((file) => path.join(entry.path, ...file.path.split('/')));
          entry.reason ??= 'newest-immutable-cache-generation';
          continue;
        }
        if (entry.reason) continue;
        const proof = terminalProof(entry, referenceRoots, nowMs);
        entry.terminalAt = new Date(proof.terminalMs).toISOString();
        entry.reason = 'newest-terminal-history';
      } catch (error) { entry.reason = `protected: ${error.message}`; }
    }
  }
  // Eligible histories across ALL roots of a worker share one FIFO, ordered by
  // validated terminal time. A touch/copy of a directory must not rejuvenate it.
  for (const workerId of new Set(roots.map((root) => root.workerId))) {
    const eligible = entries.filter((entry) => entry.workerId === workerId && entry.terminalAt)
      .sort((a, b) => b.terminalAt.localeCompare(a.terminalAt) || key(a.path).localeCompare(key(b.path)));
    for (const entry of eligible.slice(WATCH_HISTORY_KEEP)) {
      try {
        const proof = terminalProof(entry, referenceRoots, nowMs);
        entry.proof = proveCollectedBytes(entry, proof);
        entry.action = 'delete';
        entry.reason = 'collected-terminal-history-outside-newest-30';
      } catch (error) { entry.reason = `protected: ${error.message}`; }
    }
  }
  let references = null;
  let cacheReferenceError = null;
  const caches = entries.filter((entry) => ['runtime', 'isolation'].includes(entry.type));
  if (options.retireCaches) {
    try {
      requireProof(options.referencesComplete === true, 'cache retirement requires --references-complete plus all external reference roots/current pins');
      references = cacheReferences(roots, referenceRoots, caches);
    } catch (error) {
      cacheReferenceError = error.message;
      for (const entry of caches.filter((value) => value.reason === 'newest-immutable-cache-generation')) {
        entry.reason = `protected: cache reference inspection incomplete: ${error.message}`;
      }
    }
    if (references) for (const workerId of new Set(roots.map((root) => root.workerId))) {
      const generations = caches.filter((entry) => entry.workerId === workerId && entry.cacheCreatedAt)
        .sort((a, b) => b.cacheCreatedAt.localeCompare(a.cacheCreatedAt) || key(a.path).localeCompare(key(b.path)));
      for (const entry of generations) if (references.pinned.includes(entry.name)) entry.reason = 'referenced-by-retained-metadata';
      for (const entry of generations.slice(WATCH_HISTORY_KEEP)) {
        if (entry.reason !== 'newest-immutable-cache-generation') continue;
        try {
          entry.proof = proveCacheBytes(entry, cacheSeal(entry, cacheReceiptRoots));
          entry.action = 'delete'; entry.reason = 'sealed-unreferenced-cache-outside-newest-30';
        } catch (error) { entry.reason = `protected: ${error.message}`; }
      }
    }
    if (references) {
      try {
        const candidates = caches.filter((entry) => entry.action === 'delete');
        references = cacheReferences(roots, referenceRoots, caches, candidates.map((entry) => entry.path));
        for (const entry of candidates) {
          requireProof(!references.pinned.includes(entry.name), 'cache reference changed during planning');
          entry.proof.referenceFingerprint = references.fingerprint;
        }
      } catch (error) {
        cacheReferenceError = error.message;
        for (const entry of caches.filter((value) => value.action === 'delete')) {
          entry.action = 'retain'; entry.reason = `protected: cache reference inspection incomplete: ${error.message}`;
        }
      }
    }
  }
  return { schemaVersion: 1, artifactKind: 'watch-mode-typed-history-plan', generatedAt: new Date(nowMs).toISOString(),
    policy: { newestEligibleTerminalHistoriesPerWorker: WATCH_HISTORY_KEEP, lowSpaceEvictsRetainedHistory: false,
      newestSealedCacheGenerationsPerWorker: WATCH_HISTORY_KEEP, cacheFifoScope: 'runtime-and-isolation-combined-across-roots',
      runtimeAndIsolationRetirement: options.retireCaches ? 'opt-in-sealed-unreferenced-only' : 'disabled',
      referencesComplete: options.referencesComplete === true,
      evidenceMutation: 'whole-execution-only-after-byte-identical-collection' },
    roots, referenceRoots, cacheReceiptRoots, references,
    cacheReferenceInspection: options.retireCaches ? { passed: cacheReferenceError === null, error: cacheReferenceError } : null,
    protectedPaths, protectedIds: [...(options.protectedIds ?? []), ...(options.activeIds ?? [])],
    warnings: entries.filter((entry) => entry.action === 'retain' && !['newest-terminal-history', 'newest-immutable-cache-generation'].includes(entry.reason))
      .map((entry) => ({ workerId: entry.workerId, path: entry.path, reason: entry.reason })),
    summary: { totalEntries: entries.length, deletionCandidates: entries.filter((entry) => entry.action === 'delete').length,
      retainedEntries: entries.filter((entry) => entry.action === 'retain').length,
      totalMayExceed30: true }, entries };
}

/** Deliberately opt-in. Startup/finally hooks use non-destructive checks, not this API. */
export function runWatchTypedHistory(options, { removeDirectory = (target) => fs.rmSync(target, { recursive: true, force: false }),
  beforeDelete = () => {}, afterQuarantine = () => {}, probeQuiescence = probeWatchHistoryQuiescence } = {}) {
  requireProof(options.apply !== true || options.confirmQuiescent === true, 'apply requires --confirm-quiescent after stopping all producers');
  requireProof(!options.apply || !options.retireCaches || options.referencesComplete === true, 'cache apply requires --references-complete');
  requireProof(options.receiptPath && path.isAbsolute(options.receiptPath), 'an explicit absolute receipt path is required');
  const roots = validateRoots(options);
  const receiptPath = path.resolve(options.receiptPath);
  requireProof(roots.every((root) => !contained(root.path, receiptPath)), 'receipt must be outside all history roots');
  requireProof([...(options.referenceRoots ?? []), ...(options.cacheReceiptRoots ?? [])]
    .every((root) => !contained(path.resolve(root), receiptPath)), 'receipt must be outside all reference/authority roots');
  checkWatchDiskSpace({ ...(options.requiredVolumePaths?.length ? { requiredVolumePaths: options.requiredVolumePaths } : {}),
    ...(options.statfs ? { statfs: options.statfs } : {}), ...(options.warn ? { warn: options.warn } : {}) });
  const plan = planWatchTypedHistory(options);
  // Immutable, flushed intent BEFORE the first removal. A crash leaves intent,
  // never an apparently successful receipt. Outcome is a separate exclusive file.
  const intent = { ...plan, mode: options.apply ? 'apply' : 'dry-run',
    verdict: plan.cacheReferenceInspection?.passed === false ? 'incomplete' : options.apply ? 'planned' : 'dry-run',
    confirmQuiescent: options.confirmQuiescent === true };
  writeWatchDiskReceipt(receiptPath, intent);
  const result = { schemaVersion: 1, artifactKind: 'watch-mode-typed-history-outcome', receiptPath,
    mode: intent.mode, verdict: options.apply ? 'passed' : 'dry-run', deleted: [], retirements: [], errors: [] };
  if (plan.cacheReferenceInspection?.passed === false) {
    result.errors.push({ phase: 'cache-reference-inspection', message: plan.cacheReferenceInspection.error });
    if (!options.apply) {
      const error = new Error(`typed history dry-run incomplete: ${plan.cacheReferenceInspection.error}; inspect ${receiptPath}`);
      error.receipt = { ...result, verdict: 'failed', plan }; throw error;
    }
  }
  if (!options.apply) return { ...result, plan };
  // Reserve the outcome file before deletion too: an occupied report path must
  // never allow a destructive operation whose result cannot be persisted.
  const outcomePath = `${receiptPath}.outcome.json`;
  const fd = fs.openSync(outcomePath, 'wx');
  const save = () => {
    const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
    fs.writeSync(fd, bytes, 0, bytes.length, 0); fs.ftruncateSync(fd, bytes.length); fs.fsyncSync(fd);
  };
  try {
    result.verdict = 'in-progress'; save();
    for (const entry of (result.errors.length ? [] : plan.entries.filter((value) => value.action === 'delete')).sort((a, b) => {
      // Cache references must remain stable; retire caches before any collected executions.
      return Number(a.type === 'execution') - Number(b.type === 'execution')
        || (a.cacheCreatedAt ?? a.terminalAt).localeCompare(b.cacheCreatedAt ?? b.terminalAt);
    })) {
      try {
        beforeDelete(entry);
        directChild(entry.root, entry.path);
        requireProof(!protection(entry, options), 'entry became protected');
        if (entry.type === 'execution') {
          const fresh = terminalProof(entry, plan.referenceRoots, (options.now?.() ?? new Date()).getTime());
          requireProof(JSON.stringify(proveCollectedBytes(entry, fresh)) === JSON.stringify(entry.proof), 'entry/reference changed since planning');
        } else {
          const fresh = proveCacheBytes(entry, cacheSeal(entry, plan.cacheReceiptRoots));
          const references = cacheReferences(plan.roots, plan.referenceRoots,
            plan.entries.filter((value) => ['runtime', 'isolation'].includes(value.type)),
            plan.entries.filter((value) => value.type !== 'execution' && value.action === 'delete').map((value) => value.path));
          requireProof(!references.pinned.includes(entry.name), 'cache became referenced');
          requireProof(JSON.stringify({ ...fresh, referenceFingerprint: references.fingerprint }) === JSON.stringify(entry.proof), 'cache/reference changed since planning');
          // Losing newer generations concurrently must not consume the FIFO floor.
          const newer = plan.entries.filter((value) => value.workerId === entry.workerId && value.cacheCreatedAt
            && value.action === 'retain');
          requireProof(newer.length >= WATCH_HISTORY_KEEP && newer.every((value) => fs.existsSync(value.path)), 'cache retention floor changed');
        }
        let observation;
        try { observation = probeQuiescence({ roots: plan.roots }); }
        catch (cause) {
          const error = new Error(`live quiescence observation failed: ${cause.message}`);
          error.code = 'watch.disk-active'; throw error;
        }
        result.lastQuiescence = observation;
        if (observation?.passed !== true || !Array.isArray(observation.matchingProcesses) || observation.matchingProcesses.length
          || Math.abs(Date.now() - timestamp(observation.observedAt)) > 30000) {
          const error = new Error('live quiescence is unproved; stopped cache/worker producers are required');
          error.code = 'watch.disk-active'; throw error;
        }
        directChild(entry.root, entry.path);
        // Atomically detach the verified generation from its reusable public
        // name. A concurrent producer recreating that name must never have its
        // new tree deleted. An interrupted retirement remains an untyped,
        // protected quarantine with an already-durable exact-path intent.
        const snapshot = treeSnapshot(entry.path);
        requireProof(digest(JSON.stringify(snapshot)) === entry.proof.treeFingerprint, 'generation changed after quiescence');
        const quarantinePath = path.join(entry.root, `.retired-watch-history-${crypto.randomUUID()}`);
        requireProof(path.isAbsolute(quarantinePath) && key(path.dirname(quarantinePath)) === key(entry.root), 'unsafe quarantine path');
        verifiedWatchPath(entry.root);
        requireProof(!fs.existsSync(quarantinePath), 'quarantine path already exists');
        const retirement = { path: entry.path, quarantinePath, workerId: entry.workerId, status: 'intent' };
        result.retirements.push(retirement); save();
        fs.renameSync(entry.path, quarantinePath);
        retirement.status = 'quarantined'; save();
        const unchanged = () => {
          directChild(entry.root, quarantinePath);
          return JSON.stringify(retirementSnapshot(treeSnapshot(quarantinePath))) === JSON.stringify(retirementSnapshot(snapshot));
        };
        try {
          afterQuarantine(entry, quarantinePath);
          requireProof(unchanged(), 'quarantined generation changed');
          const recheck = probeQuiescence({ roots: plan.roots });
          requireProof(recheck?.passed === true && Array.isArray(recheck.matchingProcesses) && !recheck.matchingProcesses.length
            && Math.abs(Date.now() - timestamp(recheck.observedAt)) <= 30000, 'producer appeared after quarantine');
          result.lastQuiescence = recheck;
          const movedEntry = { ...entry, path: quarantinePath };
          if (entry.type === 'execution') {
            const terminal = terminalProof(entry, plan.referenceRoots, (options.now?.() ?? new Date()).getTime());
            requireProof(proveCollectedBytes(movedEntry, terminal).retirementFingerprint === entry.proof.retirementFingerprint,
              'retained collection changed after quarantine');
          } else {
            const seal = cacheSeal(entry, plan.cacheReceiptRoots, { payloadPath: quarantinePath });
            requireProof(proveCacheBytes(movedEntry, seal).retirementFingerprint === entry.proof.retirementFingerprint,
              'cache authority changed after quarantine');
            const references = cacheReferences(plan.roots, plan.referenceRoots,
              plan.entries.filter((value) => ['runtime', 'isolation'].includes(value.type)),
              plan.entries.filter((value) => value.type !== 'execution' && value.action === 'delete').map((value) => value.path),
              [quarantinePath]);
            requireProof(!references.pinned.includes(entry.name) && references.fingerprint === entry.proof.referenceFingerprint,
              'retained cache references changed after quarantine');
          }
          requireProof(Math.abs(Date.now() - timestamp(recheck.observedAt)) <= 30000, 'quiescence expired during retirement proof');
          requireProof(unchanged(), 'quarantined generation changed during quiescence check');
          directChild(entry.root, quarantinePath);
          removeDirectory(quarantinePath, entry);
          retirement.status = 'deleted';
          result.deleted.push({ path: entry.path, quarantinePath, workerId: entry.workerId, bytes: entry.proof.bytes });
        } catch (error) {
          retirement.status = 'retained-quarantine';
          try {
            // Restore only a wholly unchanged tree, and never overwrite even a
            // broken link or a new generation at the original public path.
            let originalExists = true;
            try { fs.lstatSync(entry.path); } catch (cause) { if (cause.code === 'ENOENT') originalExists = false; else throw cause; }
            if (!originalExists && unchanged()) {
              verifiedWatchPath(entry.root); directChild(entry.root, quarantinePath);
              fs.renameSync(quarantinePath, entry.path); retirement.status = 'restored';
            }
          } catch (restoreError) { retirement.restoreError = restoreError.message; }
          throw error;
        }
      } catch (error) {
        result.errors.push({ path: entry.path, message: error.message });
        if (error.code === 'watch.disk-active') break;
      }
      save();
    }
    try { checkWatchDiskSpace({ ...(options.requiredVolumePaths?.length ? { requiredVolumePaths: options.requiredVolumePaths } : {}),
      ...(options.statfs ? { statfs: options.statfs } : {}), ...(options.warn ? { warn: options.warn } : {}) }); }
    catch (error) { result.errors.push({ phase: 'post-apply-space-check', message: error.message }); }
    result.verdict = result.errors.length ? 'failed' : 'passed'; save();
  } finally { fs.closeSync(fd); }
  if (result.errors.length) {
    const error = new AggregateError(result.errors.map((value) => new Error(value.message)), 'typed history apply failed; inspect outcome receipt');
    error.receipt = result; throw error;
  }
  return { ...result, plan };
}

// Captured inventories contain neither terminal receipts nor collected bytes.
// They are useful for offline type review, NEVER as apply authority.
export function auditCapturedWatchHistory({ inventories, protectedIds = [] }) {
  requireProof(inventories.length > 0 && inventories.length <= 4, 'one to four captured inventories required');
  return inventories.map(({ workerId, file }) => {
    const inventory = readJson(file);
    requireProof(ID.test(workerId) && /^[a-z]:\\/iu.test(inventory.root)
      && Array.isArray(inventory.directories) && inventory.directories.length <= MAX_ENTRIES, 'invalid captured inventory');
    const root = path.win32.resolve(inventory.root);
    return { workerId, root, capturedAt: inventory.at, liveAuthority: false,
      entries: inventory.directories.map((item) => {
        requireProof(path.win32.isAbsolute(item.path) && path.win32.dirname(item.path).toLowerCase() === root.toLowerCase()
          && path.win32.basename(item.path) === item.name, 'captured entry is not a direct child');
        const pinned = protectedIds.includes(item.name);
        return { name: item.name, path: item.path, type: classifyWatchHistory(item.name), createdAt: item.created,
          action: 'retain', reason: pinned ? 'explicit-protection' : 'captured-inventory-is-not-terminal-or-collection-proof' };
      }) };
  });
}

export function parseWatchTypedHistoryArgs(argv) {
  const options = { roots: [], referenceRoots: [], cacheReceiptRoots: [], protectedPaths: [], protectedIds: [], activeIds: [], inventories: [], requiredVolumePaths: [] };
  let mode;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run' || flag === '--apply') {
      requireProof(!mode, 'choose exactly one mode'); mode = flag; options.apply = flag === '--apply'; continue;
    }
    if (flag === '--confirm-quiescent') { options.confirmQuiescent = true; continue; }
    if (flag === '--retire-caches') { options.retireCaches = true; continue; }
    if (flag === '--references-complete') { options.referencesComplete = true; continue; }
    const value = argv[++index];
    requireProof(value && !value.startsWith('--'), `missing value for ${flag}`);
    if (flag === '--root') {
      const match = /^([^=]+)=([^=]+)=(.+)$/u.exec(value);
      requireProof(match, '--root is workerId=kind=absolutePath');
      options.roots.push({ workerId: match[1], kind: match[2], path: match[3] });
    } else if (flag === '--inventory') {
      const match = /^([^=]+)=(.+)$/u.exec(value);
      requireProof(match, '--inventory is workerId=absoluteJsonPath');
      options.inventories.push({ workerId: match[1], file: match[2] });
    } else if (flag === '--reference-root') options.referenceRoots.push(value);
    else if (flag === '--cache-receipt-root') options.cacheReceiptRoots.push(value);
    else if (flag === '--protect-path') options.protectedPaths.push(value);
    else if (flag === '--protect') { requireProof(ID.test(value), 'invalid protected id'); options.protectedIds.push(value); }
    else if (flag === '--active') { requireProof(ID.test(value), 'invalid active id'); options.activeIds.push(value); }
    else if (flag === '--volume') options.requiredVolumePaths.push(value);
    else if (flag === '--receipt' && !options.receiptPath) options.receiptPath = value;
    else throw new Error(`unknown/repeated argument: ${flag}`);
  }
  requireProof(mode && options.receiptPath, 'explicit --dry-run or --apply and --receipt are required');
  requireProof(!options.inventories.length || (!options.apply && !options.roots.length), 'captured inventories are offline dry-run only');
  requireProof(!options.apply || options.confirmQuiescent, 'apply requires --confirm-quiescent');
  return options;
}

if (isMain(import.meta.url)) {
  try {
    const options = parseWatchTypedHistoryArgs(process.argv.slice(2));
    if (options.inventories.length) {
      const report = { schemaVersion: 1, artifactKind: 'watch-mode-captured-history-review', mode: 'dry-run', workers: auditCapturedWatchHistory(options) };
      writeWatchDiskReceipt(options.receiptPath, report); console.log(JSON.stringify(report));
    } else {
      const result = runWatchTypedHistory(options);
      if (result.plan.warnings.length) console.warn(`WARNING: ${result.plan.warnings.length} protected/unproven entries retained; this is not a total-directory cap. See ${options.receiptPath}`);
      console.log(JSON.stringify(result));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
