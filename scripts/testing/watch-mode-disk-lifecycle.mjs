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


const volumeKey = (value) => String(value).replaceAll('/', '\\').toLowerCase();

export function verifyWatchDiskSpaceReceipt(receipt, { requiredVolumePaths = ['C:\\', 'E:\\'] } = {}) {
  if (!receipt || receipt.mode !== 'check-only' || receipt.verdict !== 'passed'
      || receipt.minimumFloorSatisfied !== true || !Array.isArray(receipt.volumes)) {
    throw new Error('host did not return a passing check-only disk receipt');
  }
  for (const samplePath of requiredVolumePaths) {
    const expected = volumeKey(samplePath);
    const matches = receipt.volumes.filter((entry) => volumeKey(entry.samplePath) === expected);
    if (matches.length !== 1 || matches[0].passed !== true
        || !Number.isFinite(matches[0].observedFreeBytes)
        || matches[0].observedFreeBytes < WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME) {
      throw new Error(`host did not prove the ${samplePath} 3 GiB floor`);
    }
  }
  return receipt;
}

// Check every component, not just the final directory. A junction in an ancestor
// must not turn an apparently explicit root into another tree.
export function verifiedWatchPath(value, { directory = true } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value)
      || (process.platform === 'win32' && !/^[a-z]:[\\/]/iu.test(value))) {
    throw new Error('watch disk path must be an explicit absolute local path');
  }
  const absolute = path.resolve(value);
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !same(fs.realpathSync.native(current), current)) {
      throw new Error(`watch disk symlink/reparse path is forbidden: ${current}`);
    }
  }
  const stat = fs.lstatSync(absolute);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`unexpected watch disk path type: ${absolute}`);
  return absolute;
}

export function writeWatchDiskReceipt(receiptPath, receipt) {
  if (!receiptPath) return;
  if (!path.isAbsolute(receiptPath)) throw new Error('receipt must be an explicit absolute path');
  const target = path.resolve(receiptPath);
  // Callers create their owned report directory; never mkdir through unchecked
  // ancestors or overwrite an existing receipt (including a link).
  verifiedWatchPath(path.dirname(target));
  const fd = fs.openSync(target, 'wx');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/** No pruning, projections, or retries: paid work requires measured free space. */
export function checkWatchDiskSpace({
  requiredVolumePaths = process.platform === 'win32' ? ['C:\\', 'E:\\'] : ['/'],
  receiptPath = null, statfs = fs.statfsSync, now = () => new Date(),
  warn = (message) => console.warn(message),
} = {}) {
  if (!Array.isArray(requiredVolumePaths) || requiredVolumePaths.length === 0) throw new Error('required volumes are empty');
  const volumes = [];
  for (const samplePath of [...new Set(requiredVolumePaths)]) {
    let observedFreeBytes = null;
    let error = null;
    try {
      if (!path.isAbsolute(samplePath)) throw new Error('volume path is not absolute');
      const value = statfs(samplePath, { bigint: true });
      const bytes = BigInt(value.bavail) * BigInt(value.bsize);
      if (BigInt(value.bavail) < 0n || BigInt(value.bsize) <= 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('invalid free-space measurement');
      }
      observedFreeBytes = Number(bytes);
    } catch (cause) { error = cause.message; }
    volumes.push({ samplePath, observedFreeBytes, minimumFreeBytes: WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME,
      passed: error === null && observedFreeBytes >= WATCH_DISK_MIN_FREE_BYTES_PER_VOLUME, error });
  }
  const passed = volumes.every((volume) => volume.passed);
  const receipt = { schemaVersion: 2, artifactKind: 'watch-mode-disk-lifecycle-receipt',
    generatedAt: now().toISOString(), mode: 'check-only', verdict: passed ? 'passed' : 'failed',
    minimumFloorSatisfied: passed, failureCode: passed ? null : 'watch.disk-space.insufficient',
    volumes, deletedDirectories: [], releasedBytes: 0 };
  if (!passed) warn(`WARNING: watch disk floor is not met or cannot be measured (C:/E: require >=3 GiB): ${volumes.filter((v) => !v.passed).map((v) => `${v.samplePath}=${v.observedFreeBytes ?? 'unknown'}`).join(', ')}`);
  writeWatchDiskReceipt(receiptPath, receipt);
  if (!passed) {
    const error = new Error('watch disk free-space floor is not met; no start/distribution/provider work is allowed');
    error.code = receipt.failureCode;
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

/** Legacy roots are untyped, so they are NEVER deletion authority. */
export function runWatchDiskLifecycle({ historicalRoots = [], requiredVolumePaths,
  activeExecutionIds = [], protectedExecutionIds = [], dryRun = false, ...options } = {}) {
  const roots = historicalRoots.map((root) => verifiedWatchPath(root));
  if (new Set(roots.map((root) => process.platform === 'win32' ? root.toLowerCase() : root)).size !== roots.length) {
    throw new Error('historical roots must resolve to distinct directories');
  }
  // Compatibility for frozen-funnel callers. The old generic FIFO could delete
  // unknown/incomplete/signed evidence and is intentionally gone.
  return checkWatchDiskSpace({ ...options, ...(requiredVolumePaths?.length ? { requiredVolumePaths } : {}) });
}

export function runDefaultLocalWatchDiskLifecycle({ workspaceRoot, ...options } = {}) {
  verifiedWatchPath(workspaceRoot);
  return checkWatchDiskSpace({ ...options,
    requiredVolumePaths: process.platform === 'win32' ? ['C:\\', 'E:\\'] : [workspaceRoot] });
}

export function parseWatchDiskLifecycleArgs(argv) {
  const options = { historicalRoots: [], requiredVolumePaths: [], protectedExecutionIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--check-only') continue;
    if (name === '--dry-run') { options.dryRun = true; continue; }
    if (name === '--apply') throw new Error('generic FIFO apply is forbidden; use watch-mode-typed-history.mjs');
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`);
    if (name === '--root') options.historicalRoots.push(value);
    else if (name === '--volume') options.requiredVolumePaths.push(value);
    else if (name === '--protect') options.protectedExecutionIds.push(value);
    else if (name === '--receipt' && !options.receiptPath) options.receiptPath = value;
    else throw new Error(`unknown or repeated argument: ${name}`);
  }
  return options;
}

if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(runWatchDiskLifecycle(parseWatchDiskLifecycleArgs(process.argv.slice(2))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
