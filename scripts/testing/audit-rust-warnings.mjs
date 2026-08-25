import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isMain, repoRoot } from '../lib/testing-common.mjs';

const baselinePath = path.join(repoRoot, 'scripts', 'testing', 'rust-warning-baseline.json');
function packageName(packageId) {
  return String(packageId ?? '').split('#').at(-1)?.split('@')[0] ?? 'unknown';
}

function isFirstPartyPackage(packageId) {
  return String(packageId ?? '').startsWith('path+file://');
}

function normalizedSpan(span) {
  if (!span) return { file: 'unknown', line: 0, column: 0 };
  const absolute = path.resolve(repoRoot, span.file_name);
  const file = path.relative(repoRoot, absolute).replaceAll('\\', '/');
  return { file, line: span.line_start, column: span.column_start };
}

export function parseCompilerWarnings(stdout) {
  const unique = new Map();
  for (const line of String(stdout).split(/\r?\n/u).filter(Boolean)) {
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      continue;
    }
    const diagnostic = envelope?.reason === 'compiler-message' ? envelope.message : null;
    const packageNameValue = packageName(envelope?.package_id);
    if (diagnostic?.level !== 'warning' || !isFirstPartyPackage(envelope?.package_id)) continue;
    const span = diagnostic.spans?.find((candidate) => candidate.is_primary) ?? diagnostic.spans?.[0];
    const location = normalizedSpan(span);
    const lint = diagnostic.code?.code ?? 'uncoded';
    const warning = {
      package: packageNameValue,
      lint,
      ...location,
      message: diagnostic.message,
    };
    const key = [warning.package, warning.lint, warning.file, warning.line, warning.column, warning.message].join('\0');
    unique.set(key, warning);
  }
  return [...unique.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function parseProcMacroDiagnostics(stderr) {
  const lines = String(stderr).split(/\r?\n/u);
  const unique = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== 'warning: failed to parse serde attribute') continue;
    const detail = lines.slice(index + 1, index + 6)
      .map((line) => line.trim())
      .find((line) => line.includes('#[serde(')) ?? 'unknown serde attribute';
    unique.add(`ts-rs: ${detail.replace(/^\|\s*/u, '')}`);
  }
  return [...unique].sort();
}

export function summarizeWarnings(compilerWarnings, procMacroDiagnostics) {
  const packages = {};
  const lints = {};
  for (const warning of compilerWarnings) {
    packages[warning.package] = (packages[warning.package] ?? 0) + 1;
    lints[warning.lint] = (lints[warning.lint] ?? 0) + 1;
  }
  return { packages, lints, procMacroDiagnostics: procMacroDiagnostics.length };
}

export function collectWorkspaceWarnings({ runner = spawnSync, environment = process.env } = {}) {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-rust-warning-audit-'));
  try {
    const result = runner(
      'cargo',
      ['check', '--workspace', '--all-targets', '--message-format=json'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        env: {
          ...environment,
          CARGO_BUILD_JOBS: environment.CARGO_BUILD_JOBS ?? '1',
          CARGO_TARGET_DIR: targetDir,
        },
      },
    );
    if (result.status !== 0) {
      process.stderr.write(result.stderr ?? '');
      throw new Error('cargo check --workspace --all-targets failed');
    }
    const compilerWarnings = parseCompilerWarnings(result.stdout);
    const procMacroDiagnostics = parseProcMacroDiagnostics(result.stderr);
    return {
      compilerWarnings,
      procMacroDiagnostics,
      summary: summarizeWarnings(compilerWarnings, procMacroDiagnostics),
    };
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
}

export function auditRustWarnings({ updateBaseline = false, runner = spawnSync } = {}) {
  const current = collectWorkspaceWarnings({ runner });
  if (updateBaseline) {
    fs.writeFileSync(
      baselinePath,
      `${JSON.stringify({ comment: 'Deterministic workspace/all-target warning gate. Counts may only decrease.', warnings: current.summary }, null, 2)}\n`,
      'utf8',
    );
    console.log(`Rust warning baseline updated: ${JSON.stringify(current.summary)}`);
    return current;
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).warnings;
  if (!baseline.packages) {
    throw new Error(`Rust warning baseline uses the legacy cache-sensitive format; current deterministic summary: ${JSON.stringify(current.summary)}`);
  }
  console.log(`Rust warnings: ${JSON.stringify(current.summary)}`);
  const increases = [];
  for (const [name, count] of Object.entries(current.summary.packages)) {
    if (count > (baseline.packages[name] ?? 0)) increases.push(`${name}=${count}`);
  }
  for (const [lint, count] of Object.entries(current.summary.lints)) {
    if (count > (baseline.lints[lint] ?? 0)) increases.push(`${lint}=${count}`);
  }
  if (current.summary.procMacroDiagnostics > (baseline.procMacroDiagnostics ?? 0)) {
    increases.push(`proc-macro=${current.summary.procMacroDiagnostics}`);
  }
  if (increases.length > 0) throw new Error(`Rust warnings exceed baseline: ${increases.join(', ')}`);
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
