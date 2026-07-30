import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isMain, repoRoot } from '../lib/testing-common.mjs';

const baselinePath = path.join(repoRoot, 'scripts', 'testing', 'rust-warning-baseline.json');
const manifests = {
  'desktop-shell': 'apps/desktop/src-tauri/Cargo.toml',
  'bridge-service-native': 'apps/bridge-service-native/Cargo.toml',
};

export function countWarnings(manifestPath) {
  const result = spawnSync(
    'cargo',
    ['check', '--manifest-path', manifestPath, '--message-format=json'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    throw new Error(`cargo check failed for ${manifestPath}`);
  }
  return String(result.stdout)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((message) => message?.reason === 'compiler-message' && message.message?.level === 'warning')
    .length;
}

export function auditRustWarnings({ updateBaseline = false } = {}) {
  const current = Object.fromEntries(
    Object.entries(manifests).map(([name, manifest]) => [name, countWarnings(manifest)]),
  );
  if (updateBaseline) {
    fs.writeFileSync(
      baselinePath,
      `${JSON.stringify({ comment: 'Warning-count ratchet. Counts may only stay equal or decrease.', warnings: current }, null, 2)}\n`,
      'utf8',
    );
    console.log(`Rust warning baseline updated: ${JSON.stringify(current)}`);
    return current;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).warnings;
  const increases = Object.entries(current).filter(([name, count]) => count > baseline[name]);
  for (const [name, count] of Object.entries(current)) {
    console.log(`${name}: ${count} warning(s), baseline ${baseline[name]}`);
  }
  if (increases.length > 0) {
    throw new Error(`Rust warnings increased: ${increases.map(([name, count]) => `${name}=${count} > ${baseline[name]}`).join(', ')}`);
  }
  return current;
}

if (isMain(import.meta.url)) {
  try {
    auditRustWarnings({ updateBaseline: process.argv.includes('--update-baseline') });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
