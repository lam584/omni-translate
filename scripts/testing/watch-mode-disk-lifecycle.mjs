import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/testing-common.mjs';

export const WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME = 3 * 1024 * 1024 * 1024;
export const WATCH_DISK_MAX_DIRECTORIES_PER_ROOT = 30;
export const WATCH_DISK_LOCAL_HISTORY_NAMES = Object.freeze([
  'watch-mode-live-coordinator', 'watch-mode-local-isolation', 'watch-runtime-distributions',
  'watch-mode-live', 'test-receipts', 'frozen-funnel-workers', 'watch-release-prepare',
  'watch-mode-strict-runtime',
]);

const compareOldestFirst = (left, right) => (
  left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name)
);
const compareNewestFirst = (left, right) => compareOldestFirst(right, left);

function canonicalRoot(rootPath) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) throw new Error('historical root must be an explicit non-empty path');
  const absolute = path.resolve(rootPath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`historical root must be a real directory: ${absolute}`);
  return fs.realpathSync.native(absolute);
}

function assertDirectChild(root, target) {
  const absolute = path.resolve(target);
  if (path.dirname(absolute) !== root || absolute === root) {
    throw new Error(`disk lifecycle target is not a direct child of its root: ${absolute}`);
  }
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error(`disk lifecycle target escaped its root: ${absolute}`);
  }
  return absolute;
}

function directoryBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) {
        total += stat.size;
      } else if (stat.isDirectory()) {
        stack.push(child);
      } else {
        total += stat.size;
      }
    }
  }
  return total;
}

function volumeKey(root) {
  return path.parse(root).root.toLowerCase();
}

function freeBytes(root, statfs = fs.statfsSync) {
  const value = statfs(root);
  return Number(BigInt(value.bavail) * BigInt(value.bsize));
}

function inventoryRoot(rootPath, protectedIds) {
  const root = canonicalRoot(rootPath);
  const directories = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = assertDirectChild(root, path.join(root, entry.name));
    const stat = fs.lstatSync(target);
    if (!entry.isDirectory() || stat.isSymbolicLink()) continue;
    const realTarget = fs.realpathSync.native(target);
    assertDirectChild(root, realTarget);
    directories.push({
      root,
      path: realTarget,
      name: entry.name,
      executionId: entry.name,
      mtimeMs: stat.mtimeMs,
      bytes: directoryBytes(realTarget),
      protected: protectedIds.has(entry.name),
    });
  }
  directories.sort(compareNewestFirst);
  return { root, directories };
}

function selectDeletions(inventories, beforeByVolume) {
  const selected = new Set();
  for (const inventory of inventories) {
    for (const entry of inventory.directories.slice(WATCH_DISK_MAX_DIRECTORIES_PER_ROOT)) {
      if (!entry.protected) selected.add(entry.path);
    }
  }
  const byVolume = new Map();
  for (const inventory of inventories) {
    const key = volumeKey(inventory.root);
    const entries = byVolume.get(key) ?? [];
    entries.push(...inventory.directories.filter((entry) => !entry.protected));
    byVolume.set(key, entries);
  }
  for (const [key, entries] of byVolume) {
    let projected = beforeByVolume.get(key).freeBytes
      + entries.filter((entry) => selected.has(entry.path)).reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries.sort(compareOldestFirst)) {
      if (projected >= WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME) break;
      if (selected.has(entry.path)) continue;
      selected.add(entry.path);
      projected += entry.bytes;
    }
  }
  return selected;
}

export function runWatchDiskLifecycle({
  historicalRoots,
  requiredVolumePaths = historicalRoots,
  activeExecutionIds = [],
  protectedExecutionIds = [],
  dryRun = false,
  receiptPath = null,
  now = () => new Date(),
  statfs = fs.statfsSync,
} = {}) {
  if (!Array.isArray(historicalRoots) || historicalRoots.length === 0) throw new Error('at least one explicit historical root is required');
  const protectedIds = new Set([...activeExecutionIds, ...protectedExecutionIds].map(String));
  const inventories = historicalRoots.map((root) => inventoryRoot(root, protectedIds));
  if (new Set(inventories.map((entry) => entry.root.toLowerCase())).size !== inventories.length) {
    throw new Error('historical roots must resolve to distinct directories');
  }
  const beforeByVolume = new Map();
  if (!Array.isArray(requiredVolumePaths) || requiredVolumePaths.length === 0) {
    throw new Error('at least one required volume path is required');
  }
  for (const volumePath of requiredVolumePaths) {
    const absolute = path.resolve(volumePath);
    const key = volumeKey(absolute);
    if (!beforeByVolume.has(key)) beforeByVolume.set(key, { volume: key, samplePath: absolute, freeBytes: freeBytes(absolute, statfs) });
  }
  for (const inventory of inventories) {
    const key = volumeKey(inventory.root);
    if (!beforeByVolume.has(key)) beforeByVolume.set(key, { volume: key, samplePath: inventory.root, freeBytes: freeBytes(inventory.root, statfs) });
  }
  const selected = selectDeletions(inventories, beforeByVolume);
  const deletedDirectories = [];
  for (const entry of inventories.flatMap((inventory) => inventory.directories).filter((item) => selected.has(item.path)).sort(compareOldestFirst)) {
    if (entry.protected) throw new Error(`refusing to delete protected execution: ${entry.executionId}`);
    assertDirectChild(entry.root, entry.path);
    const actual = fs.realpathSync.native(entry.path);
    assertDirectChild(entry.root, actual);
    if (!dryRun) fs.rmSync(actual, { recursive: true, force: false });
    deletedDirectories.push({ root: entry.root, path: actual, executionId: entry.executionId, bytes: entry.bytes });
  }
  const afterVolumes = [...beforeByVolume.values()].map((before) => {
    const measured = dryRun ? before.freeBytes : freeBytes(before.samplePath, statfs);
    const projectedReleased = deletedDirectories.filter((entry) => volumeKey(entry.root) === before.volume)
      .reduce((sum, entry) => sum + entry.bytes, 0);
    return {
      volume: before.volume,
      beforeFreeBytes: before.freeBytes,
      afterFreeBytes: measured,
      releasedBytes: dryRun ? projectedReleased : Math.max(0, measured - before.freeBytes),
      projectedReleasedBytes: projectedReleased,
      minimumFreeBytes: WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME,
    };
  });
  const retainedDirectories = inventories.flatMap((inventory) => inventory.directories)
    .filter((entry) => !selected.has(entry.path))
    .map((entry) => ({ root: entry.root, path: entry.path, executionId: entry.executionId, protected: entry.protected }));
  const insufficient = afterVolumes.filter((entry) => (
    (dryRun ? entry.afterFreeBytes + entry.projectedReleasedBytes : entry.afterFreeBytes)
      < WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME
  ));
  const receipt = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-disk-lifecycle-receipt',
    generatedAt: now().toISOString(),
    dryRun: Boolean(dryRun),
    verdict: dryRun ? 'dry-run' : insufficient.length === 0 ? 'passed' : 'failed',
    minimumFloorSatisfied: insufficient.length === 0,
    failureCode: insufficient.length === 0 ? null : 'watch.disk-space.insufficient',
    violations: insufficient.map((entry) => ({
      volume: entry.volume,
      observedFreeBytes: entry.afterFreeBytes,
      projectedFreeBytes: entry.afterFreeBytes + (dryRun ? entry.projectedReleasedBytes : 0),
      minimumFreeBytes: WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME,
    })),
    policy: {
      minimumFreeBytesPerVolume: WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME,
      maximumDirectoriesPerRoot: WATCH_DISK_MAX_DIRECTORIES_PER_ROOT,
    },
    roots: inventories.map((entry) => entry.root),
    protectedExecutionIds: [...protectedIds].sort(),
    deletedDirectories,
    retainedDirectories,
    volumes: afterVolumes,
    releasedBytes: afterVolumes.reduce((sum, entry) => sum + entry.releasedBytes, 0),
  };
  if (receiptPath) {
    const absoluteReceipt = path.resolve(receiptPath);
    fs.mkdirSync(path.dirname(absoluteReceipt), { recursive: true });
    fs.writeFileSync(absoluteReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  if (insufficient.length > 0) {
    const error = new Error(`watch disk free-space floor is not met: ${insufficient.map((entry) => `${entry.volume}=${entry.afterFreeBytes}`).join(', ')}`);
    error.code = 'watch.disk-space.insufficient';
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

export function runDefaultLocalWatchDiskLifecycle({ workspaceRoot, receiptPath, activeExecutionIds = [], protectedExecutionIds = [] } = {}) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) throw new Error('workspaceRoot is required');
  const testingRoot = path.resolve(workspaceRoot, 'artifacts', 'testing');
  const roots = WATCH_DISK_LOCAL_HISTORY_NAMES.map((name) => path.join(testingRoot, name))
    .filter((candidate) => fs.existsSync(candidate));
  if (roots.length === 0) throw new Error('no watch history roots exist');
  return runWatchDiskLifecycle({
    historicalRoots: roots,
    requiredVolumePaths: process.platform === 'win32' ? ['C:\\', workspaceRoot] : [workspaceRoot],
    activeExecutionIds,
    protectedExecutionIds,
    receiptPath,
  });
}

export function parseWatchDiskLifecycleArgs(argv) {
  const options = { historicalRoots: [], requiredVolumePaths: [], protectedExecutionIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--dry-run') { options.dryRun = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`);
    if (name === '--root') options.historicalRoots.push(value);
    else if (name === '--volume') options.requiredVolumePaths.push(value);
    else if (name === '--protect') options.protectedExecutionIds.push(value);
    else if (name === '--receipt') options.receiptPath = value;
    else throw new Error(`unknown argument: ${name}`);
  }
  if (options.requiredVolumePaths.length === 0) options.requiredVolumePaths = [...options.historicalRoots];
  return options;
}

if (isMain(import.meta.url)) {
  try {
    const receipt = runWatchDiskLifecycle(parseWatchDiskLifecycleArgs(process.argv.slice(2)));
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

