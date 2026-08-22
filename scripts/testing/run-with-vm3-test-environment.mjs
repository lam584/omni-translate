import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isMain, repoRoot } from '../lib/testing-common.mjs';

const TEMP_ROOT = path.join(repoRoot, 'artifacts', 'testing', 'temp');
const CARGO_HOME = path.join(repoRoot, 'artifacts', 'testing', 'cargo-home');
const CARGO_TARGET_DIR = path.join(repoRoot, 'target');

function usage() {
  throw new Error('Usage: run-with-vm3-test-environment.mjs -- <command> [arguments...]');
}

export function createVm3TestEnvironment({ baseEnvironment = process.env, temporaryRoot }) {
  return {
    ...baseEnvironment,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
    NPM_CONFIG_CACHE: path.join(TEMP_ROOT, 'npm-cache'),
    CARGO_HOME,
    CARGO_TARGET_DIR,
  };
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

if (isMain(import.meta.url)) {
  const separator = process.argv.indexOf('--');
  if (separator < 0 || separator === process.argv.length - 1) usage();
  const [command, ...argumentsToRun] = process.argv.slice(separator + 1);
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  fs.mkdirSync(CARGO_HOME, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(TEMP_ROOT, 'watch-mode-test-'));
  const result = spawnSync(command, argumentsToRun, {
    cwd: repoRoot,
    env: createVm3TestEnvironment({ temporaryRoot }),
    stdio: 'inherit',
    windowsHide: true,
  });
  const cleanupRecord = cleanVm3TemporaryRoot(temporaryRoot);
  if (cleanupRecord) console.warn(`VM3 test temporary cleanup is pending: ${cleanupRecord}`);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
