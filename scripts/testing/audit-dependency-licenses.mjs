import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APPROVED_LICENSES = new Set([
  '0bsd',
  'apache-2.0',
  'blueoak-1.0.0',
  'bsd-2-clause',
  'bsd-3-clause',
  'bsl-1.0',
  'cc-by-4.0',
  'cc0-1.0',
  'cdla-permissive-2.0',
  'isc',
  'mit',
  'mit-0',
  'mpl-2.0',
  'unicode-3.0',
  'unlicense',
  'zlib',
  'zlib-acknowledgement',
]);
const APPROVED_EXCEPTIONS = new Set(['llvm-exception']);

function tokenize(expression) {
  const normalized = expression
    .replaceAll('/', ' OR ')
    .replace(/\b(and|or|with)\b/gi, (operator) => operator.toUpperCase());
  const tokens = normalized.match(/\(|\)|AND|OR|WITH|[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [];
  if (tokens.join('').toLowerCase() !== normalized.replace(/\s+/g, '').toLowerCase()) {
    throw new Error(`Unsupported SPDX syntax: ${expression}`);
  }
  return tokens;
}

export function expressionIsAllowed(expression) {
  if (typeof expression !== 'string' || !expression.trim()) return false;
  let tokens;
  try {
    tokens = tokenize(expression.trim());
  } catch {
    return false;
  }
  let cursor = 0;
  const parseAtom = () => {
    if (tokens[cursor] === '(') {
      cursor += 1;
      const value = parseOr();
      if (tokens[cursor] !== ')') throw new Error('Unclosed license expression.');
      cursor += 1;
      return value;
    }
    const license = tokens[cursor];
    if (!license || ['AND', 'OR', 'WITH', ')'].includes(license)) throw new Error('Expected a license identifier.');
    cursor += 1;
    let allowed = APPROVED_LICENSES.has(license.toLowerCase());
    if (tokens[cursor] === 'WITH') {
      cursor += 1;
      const exception = tokens[cursor];
      if (!exception) throw new Error('Expected a license exception.');
      cursor += 1;
      allowed &&= APPROVED_EXCEPTIONS.has(exception.toLowerCase());
    }
    return allowed;
  };
  const parseAnd = () => {
    let value = parseAtom();
    while (tokens[cursor] === 'AND') {
      cursor += 1;
      value = parseAtom() && value;
    }
    return value;
  };
  const parseOr = () => {
    let value = parseAnd();
    while (tokens[cursor] === 'OR') {
      cursor += 1;
      value = parseAnd() || value;
    }
    return value;
  };
  try {
    const allowed = parseOr();
    return cursor === tokens.length && allowed;
  } catch {
    return false;
  }
}

export function classifyLicenseText(text) {
  const normalized = String(text).toLowerCase();
  if (normalized.includes('gnu affero general public license')) return null;
  if (normalized.includes('gnu general public license')) return null;
  if (normalized.includes('gnu lesser general public license')) return null;
  if (normalized.includes('apache license') && normalized.includes('version 2.0')) return 'Apache-2.0';
  if (normalized.includes('permission is hereby granted, free of charge')) return 'MIT';
  if (normalized.includes('redistribution and use in source and binary forms')) return 'BSD-3-Clause';
  return null;
}

function npmPackageName(lockPath) {
  return lockPath.split('node_modules/').at(-1);
}

export function collectNpmLicenses(packageLock) {
  return Object.entries(packageLock.packages ?? {})
    .filter(([lockPath, metadata]) => lockPath.includes('node_modules/') && !metadata.link)
    .map(([lockPath, metadata]) => ({
      ecosystem: 'npm',
      name: npmPackageName(lockPath),
      version: metadata.version ?? 'unknown',
      license: metadata.license ?? null,
      licenseFile: null,
    }));
}

function collectCargoLicenses(workspaceRoot) {
  const result = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed:\n${result.stderr || result.stdout}`);
  }
  const metadata = JSON.parse(result.stdout);
  const workspaceMembers = new Set(metadata.workspace_members);
  return metadata.packages
    .filter((pkg) => !workspaceMembers.has(pkg.id))
    .map((pkg) => ({
      ecosystem: 'cargo',
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      licenseFile: pkg.license_file,
    }));
}

function effectiveLicense(record) {
  if (record.license) return record.license;
  if (!record.licenseFile) return null;
  try {
    return classifyLicenseText(fs.readFileSync(record.licenseFile, 'utf8'));
  } catch {
    return null;
  }
}

function reportMarkdown(records, violations) {
  const counts = new Map();
  for (const record of records) {
    const license = effectiveLicense(record) ?? '<missing-or-unrecognized>';
    const key = `${record.ecosystem}\t${license}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => {
      const [ecosystem, license] = key.split('\t');
      return `| ${ecosystem} | \`${license}\` | ${count} |`;
    });
  return [
    '# Dependency license audit',
    '',
    'Generated deterministically from `package-lock.json` and `cargo metadata --locked`.',
    'This file is a CI artifact, not a checked-in point-in-time report.',
    '',
    '| Ecosystem | Declared/effective license | Packages |',
    '| --- | --- | ---: |',
    ...rows,
    '',
    `Result: **${violations.length === 0 ? 'PASS' : 'FAIL'}**`,
    '',
    ...(violations.length === 0
      ? ['No unapproved, missing, or unrecognized dependency license was found.']
      : ['## Violations', '', ...violations.map((item) => `- ${item}`)]),
    '',
    'Policy: permissive SPDX identifiers plus MPL-2.0, CC-BY-4.0, Unicode-3.0,',
    'and CDLA-Permissive-2.0 are approved. Every branch of `AND` expressions',
    'must be approved; at least one branch of `OR` expressions must be approved.',
    'GPL, AGPL, LGPL-only, unknown identifiers, and missing license metadata fail.',
    '',
  ].join('\n');
}

export function auditRecords(records) {
  return records.flatMap((record) => {
    const license = effectiveLicense(record);
    if (license && expressionIsAllowed(license)) return [];
    return [`${record.ecosystem}:${record.name}@${record.version} declares ${license ?? 'no recognized license'}`];
  });
}

function parseOutputPath(argv) {
  const index = argv.indexOf('--output');
  if (index === -1) return null;
  if (!argv[index + 1]) throw new Error('--output requires a path.');
  return path.resolve(argv[index + 1]);
}

function main() {
  const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const packageLock = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package-lock.json'), 'utf8'));
  const records = [...collectNpmLicenses(packageLock), ...collectCargoLicenses(workspaceRoot)];
  const violations = auditRecords(records);
  const report = reportMarkdown(records, violations);
  const outputPath = parseOutputPath(process.argv.slice(2));
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, report, 'utf8');
  }
  process.stdout.write(`${report}\n`);
  if (violations.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
