import fs from 'node:fs';
import path from 'node:path';
import { isPidActive } from './run-with-vm3-test-environment.mjs';
import { checkWatchDiskSpace } from './watch-mode-disk-lifecycle.mjs';

export const DEFAULT_CACHE_BUDGET_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB
export const DEFAULT_DISK_WARNING_BYTES = 4 * 1024 * 1024 * 1024;  // 4 GiB (warn before 3 GiB floor)
export const DEFAULT_ORPHAN_QUIESCENCE_MS = 60 * 60 * 1000;         // 1 hour

export function readIsolatedTargetMetadata(metadataFile) {
  try {
    const raw = fs.readFileSync(metadataFile, 'utf8').replace(/^\uFEFF/u, '');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

export function writeIsolatedTargetMetadata(metadataFile, metadata) {
  fs.mkdirSync(path.dirname(metadataFile), { recursive: true });
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

export function checkCacheBudgetAndDiskWarning({
  targetDirectories = [],
  budgetBytes = DEFAULT_CACHE_BUDGET_BYTES,
  warningBytes = DEFAULT_DISK_WARNING_BYTES,
  volumePaths = process.platform === 'win32' ? ['C:\\', 'E:\\'] : ['/'],
  statfs = fs.statfsSync,
  warn = (msg) => console.warn(msg),
} = {}) {
  let totalTargetBytes = 0;
  const inspectedDirectories = [];

  for (const dir of targetDirectories) {
    if (!fs.existsSync(dir)) continue;
    let dirBytes = 0;
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory()) {
        const stack = [dir];
        while (stack.length > 0) {
          const current = stack.pop();
          const entries = fs.readdirSync(current, { withFileTypes: true });
          for (const entry of entries) {
            const entryPath = path.join(current, entry.name);
            try {
              const entryStat = fs.lstatSync(entryPath);
              if (entryStat.isDirectory()) {
                if (!entryStat.isSymbolicLink()) stack.push(entryPath);
              } else if (entryStat.isFile()) {
                dirBytes += entryStat.size;
              }
            } catch {}
          }
        }
      }
    } catch {}
    totalTargetBytes += dirBytes;
    inspectedDirectories.push({ path: dir, bytes: dirBytes });
  }

  const budgetExceeded = totalTargetBytes > budgetBytes;
  if (budgetExceeded) {
    warn(`WARNING: Build cache budget exceeded! Observed ${(totalTargetBytes / 1024 / 1024).toFixed(1)} MiB > budget ${(budgetBytes / 1024 / 1024).toFixed(1)} MiB`);
  }

  const volumeWarnings = [];
  for (const volumePath of volumePaths) {
    try {
      const stats = statfs(volumePath, { bigint: true });
      const freeBytes = Number(BigInt(stats.bavail) * BigInt(stats.bsize));
      if (freeBytes < warningBytes) {
        const msg = `WARNING: Volume ${volumePath} free space ${(freeBytes / 1024 / 1024 / 1024).toFixed(2)} GiB is approaching the 3 GiB floor (< ${(warningBytes / 1024 / 1024 / 1024).toFixed(2)} GiB)`;
        warn(msg);
        volumeWarnings.push({ volumePath, freeBytes, warning: msg });
      }
    } catch {}
  }

  return {
    totalTargetBytes,
    budgetBytes,
    budgetExceeded,
    inspectedDirectories,
    volumeWarnings,
  };
}

export function sweepReusableIsolatedCaches({
  isolatedTargetsRoot,
  activePid = process.pid,
  dryRun = false,
  now = () => Date.now(),
} = {}) {
  if (!fs.existsSync(isolatedTargetsRoot)) {
    return { scanned: 0, reclaimed: 0, protected: 0, reclaimedBytes: 0, details: [] };
  }

  const entries = fs.readdirSync(isolatedTargetsRoot, { withFileTypes: true });
  let scanned = 0;
  let reclaimed = 0;
  let protectedCount = 0;
  let reclaimedBytes = 0;
  const details = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    scanned++;
    const targetDir = path.join(isolatedTargetsRoot, entry.name);
    const metaFile = path.join(targetDir, '.cache-metadata.json');
    const meta = readIsolatedTargetMetadata(metaFile);

    if (!meta) {
      protectedCount++;
      details.push({ path: targetDir, status: 'protected', reason: 'missing-or-invalid-metadata' });
      continue;
    }

    if (meta.ownerPid && isPidActive(meta.ownerPid)) {
      protectedCount++;
      details.push({ path: targetDir, status: 'protected', reason: 'owner-process-active', pid: meta.ownerPid });
      continue;
    }

    if (meta.reusable === false || meta.reclaimable === false) {
      protectedCount++;
      details.push({ path: targetDir, status: 'protected', reason: 'marked-non-reclaimable' });
      continue;
    }

    let dirBytes = 0;
    try {
      const stack = [targetDir];
      while (stack.length > 0) {
        const current = stack.pop();
        const items = fs.readdirSync(current, { withFileTypes: true });
        for (const item of items) {
          const itemPath = path.join(current, item.name);
          try {
            const itemStat = fs.lstatSync(itemPath);
            if (itemStat.isDirectory()) {
              if (!itemStat.isSymbolicLink()) stack.push(itemPath);
            } else if (itemStat.isFile()) {
              dirBytes += itemStat.size;
            }
          } catch {}
        }
      }
    } catch {}

    if (!dryRun) {
      try {
        fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        reclaimed++;
        reclaimedBytes += dirBytes;
        details.push({ path: targetDir, status: 'reclaimed', bytes: dirBytes });
      } catch (err) {
        protectedCount++;
        details.push({ path: targetDir, status: 'failed', error: err.message });
      }
    } else {
      reclaimed++;
      reclaimedBytes += dirBytes;
      details.push({ path: targetDir, status: 'would-reclaim', bytes: dirBytes });
    }
  }

  return { scanned, reclaimed, protected: protectedCount, reclaimedBytes, details };
}
