import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isMain, repoRoot } from '../lib/testing-common.mjs';

const TEMP_ROOT = path.join(repoRoot, 'artifacts', 'testing', 'temp');
const CARGO_HOME = path.join(repoRoot, 'artifacts', 'testing', 'cargo-home');
const CARGO_TARGET_DIR = path.join(repoRoot, 'target');
const RUSTUP_HOME = path.join(repoRoot, 'artifacts', 'testing', 'rustup-home');
const VM3_RUSTUP_OPT_IN = 'OMNI_VM3_USE_REPO_RUSTUP_HOME';

export const RECLAIMABLE_TEMP_PREFIXES = Object.freeze([
  'frozen-funnel-',
  'watch-mode-test-',
]);

export const DEFAULT_ORPHAN_QUIESCENCE_MS = 60 * 60 * 1000; // 1 hour

function usage() {
  throw new Error('Usage: run-with-vm3-test-environment.mjs -- <command> [arguments...]');
}

export function isPidActive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function isInitializedRustupHome(rustupHome) {
  try {
    const settings = fs.statSync(path.join(rustupHome, 'settings.toml'));
    const toolchains = fs.readdirSync(path.join(rustupHome, 'toolchains'), { withFileTypes: true });
    if (!settings.isFile()) return false;
    return toolchains.some((entry) => {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
      const binaryRoot = path.join(rustupHome, 'toolchains', entry.name, 'bin');
      const hasCompiler = ['rustc', 'rustc.exe'].some((name) => {
        try {
          return fs.statSync(path.join(binaryRoot, name)).isFile();
        } catch {
          return false;
        }
      });
      const hasCargo = ['cargo', 'cargo.exe'].some((name) => {
        try {
          return fs.statSync(path.join(binaryRoot, name)).isFile();
        } catch {
          return false;
        }
      });
      return hasCompiler && hasCargo;
    });
  } catch {
    return false;
  }
}

export function createVm3TestEnvironment({
  baseEnvironment = process.env,
  temporaryRoot,
  rustupHome = RUSTUP_HOME,
}) {
  const environment = {
    ...baseEnvironment,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
    NPM_CONFIG_CACHE: path.join(TEMP_ROOT, 'npm-cache'),
    CARGO_HOME,
    CARGO_TARGET_DIR,
  };
  if (baseEnvironment[VM3_RUSTUP_OPT_IN] === '1' || isInitializedRustupHome(rustupHome)) {
    environment.RUSTUP_HOME = rustupHome;
  }
  return environment;
}

export function cleanVm3TemporaryRoot(temporaryRoot) {
  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    return null;
  } catch (error) {
    const cleanupRecord = `${temporaryRoot}.cleanup-pending.json`;
    fs.writeFileSync(cleanupRecord, `${JSON.stringify({
      temporaryRoot,
      createdAt: new Date().toISOString(),
      cleanupError: String(error?.message ?? error),
    }, null, 2)}\n`, 'utf8');
    return cleanupRecord;
  }
}

export function readLeaseFile(directoryPath) {
  const leasePath = path.join(directoryPath, '.test-lease.json');
  try {
    const raw = fs.readFileSync(leasePath, 'utf8').replace(/^\uFEFF/u, '');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
  } catch {}
  return null;
}

export function writeLeaseFile(directoryPath, { pid = process.pid, purpose = 'test-environment' } = {}) {
  const leasePath = path.join(directoryPath, '.test-lease.json');
  try {
    fs.writeFileSync(leasePath, `${JSON.stringify({
      pid,
      purpose,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
  } catch {}
}

export function reclaimOrphanedTestDirectories({
  tempRoot = TEMP_ROOT,
  allowedPrefixes = RECLAIMABLE_TEMP_PREFIXES,
  maxAgeMs = DEFAULT_ORPHAN_QUIESCENCE_MS,
  now = () => Date.now(),
  dryRun = false,
} = {}) {
  if (!fs.existsSync(tempRoot)) {
    return { scanned: 0, reclaimed: 0, protected: 0, details: [] };
  }

  const entries = fs.readdirSync(tempRoot, { withFileTypes: true });
  let scanned = 0;
  let reclaimed = 0;
  let protectedCount = 0;
  const details = [];

  for (const entry of entries) {
    const name = entry.name;
    const isMatchingPrefix = allowedPrefixes.some((prefix) => name.startsWith(prefix));
    if (!isMatchingPrefix) continue;

    scanned++;
    const fullPath = path.join(tempRoot, name);

    // If it's a pending cleanup record JSON file
    if (entry.isFile() && name.endsWith('.cleanup-pending.json')) {
      const targetDir = fullPath.slice(0, -'.cleanup-pending.json'.length);
      if (!fs.existsSync(targetDir)) {
        if (!dryRun) {
          try { fs.rmSync(fullPath, { force: true }); } catch {}
        }
        reclaimed++;
        details.push({ path: fullPath, status: 'reclaimed-orphaned-pending-json' });
        continue;
      }
    }

    if (!entry.isDirectory()) continue;

    const lease = readLeaseFile(fullPath);
    if (lease && typeof lease.pid === 'number') {
      if (isPidActive(lease.pid)) {
        protectedCount++;
        details.push({ path: fullPath, status: 'protected', reason: 'active-pid', pid: lease.pid });
        continue;
      }
    }

    // Check age/quiescence
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      protectedCount++;
      details.push({ path: fullPath, status: 'protected', reason: 'stat-failed' });
      continue;
    }

    const ageMs = now() - stat.mtimeMs;
    // If has expired or no active pid lease and older than maxAgeMs
    if (ageMs < maxAgeMs && !lease) {
      protectedCount++;
      details.push({ path: fullPath, status: 'protected', reason: 'recent-unknown-status', ageMs });
      continue;
    }

    if (!dryRun) {
      try {
        fs.rmSync(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        const pendingRecord = `${fullPath}.cleanup-pending.json`;
        if (fs.existsSync(pendingRecord)) {
          try { fs.rmSync(pendingRecord, { force: true }); } catch {}
        }
        reclaimed++;
        details.push({ path: fullPath, status: 'reclaimed', ageMs });
      } catch (err) {
        protectedCount++;
        details.push({ path: fullPath, status: 'failed', error: err.message });
      }
    } else {
      reclaimed++;
      details.push({ path: fullPath, status: 'would-reclaim', ageMs });
    }
  }

  return { scanned, reclaimed, protected: protectedCount, details };
}

export function resolveVm3TestCommand({
  command,
  argumentsToRun,
  environment = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
}) {
  const windowsCommandShim = platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
  const npmCli = environment.npm_execpath;
  if (windowsCommandShim && /^npm\.cmd$/i.test(path.basename(command)) && npmCli) {
    return { command: nodeExecutable, argumentsToRun: [npmCli, ...argumentsToRun], shell: false };
  }
  return { command, argumentsToRun, shell: windowsCommandShim };
}

if (isMain(import.meta.url)) {
  const separator = process.argv.indexOf('--');
  if (separator < 0 || separator === process.argv.length - 1) usage();
  const [command, ...argumentsToRun] = process.argv.slice(separator + 1);
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  fs.mkdirSync(CARGO_HOME, { recursive: true });

  // Safe orphan recycling on startup
  try {
    reclaimOrphanedTestDirectories({ tempRoot: TEMP_ROOT });
  } catch (err) {
    console.warn(`VM3 orphan temp reclaim warning: ${err.message}`);
  }

  const temporaryRoot = fs.mkdtempSync(path.join(TEMP_ROOT, 'watch-mode-test-'));
  writeLeaseFile(temporaryRoot, { pid: process.pid, purpose: 'watch-mode-test' });

  const environment = createVm3TestEnvironment({ temporaryRoot });
  const invocation = resolveVm3TestCommand({ command, argumentsToRun, environment });
  const result = spawnSync(invocation.command, invocation.argumentsToRun, {
    cwd: repoRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
    // Windows cannot execute npm.cmd (or another command shim) directly via
    // CreateProcess. Route only those explicit shim files through ComSpec;
    // native executables continue to avoid an unnecessary shell layer.
    shell: invocation.shell,
  });
  const cleanupRecord = cleanVm3TemporaryRoot(temporaryRoot);
  if (cleanupRecord) console.warn(`VM3 test temporary cleanup is pending: ${cleanupRecord}`);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
