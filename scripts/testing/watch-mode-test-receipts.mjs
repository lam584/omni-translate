import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance, exactGitProvenanceFailure } from './git-provenance.mjs';
import { fileAuthorityEntry } from './watch-mode-evidence-authority.mjs';
import { verifyStrictRuntimeAuthority } from './watch-mode-strict-runtime-authority.mjs';

export const TEST_RECEIPT_SCHEMA_VERSION = 1;
export const TEST_RECEIPT_KIND = 'clean-head-test-receipt';
export const TEST_RECEIPT_CANONICAL_INDEX = 'artifacts/testing/test-receipts/latest.json';
export const REUSABLE_QUALITY_GATE_STEPS = new Set([
  'verify-desktop',
  'benchmark-core-tests',
  'diagnostics-benchmark-tests',
  'watch-mode-tooling',
  'test-desktop-shell',
  'test-bridge-service-native',
]);

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex');

export function implementationDigest(provenance, runtimeAuthority) {
  return digest({
    headCommit: provenance.headCommit,
    implementationHashes: runtimeAuthority.implementationHashes,
  });
}

export function createTestReceipt({ name, command, logPath, startedAt, completedAt, provenance, runtimeAuthority }) {
  if (provenance?.worktreeClean !== true || Number(provenance?.dirtyEntryCount) !== 0) {
    throw new Error('test receipts require an exact clean HEAD');
  }
  const unsigned = {
    schemaVersion: TEST_RECEIPT_SCHEMA_VERSION,
    artifactKind: TEST_RECEIPT_KIND,
    name,
    command,
    headCommit: provenance.headCommit,
    worktreeClean: true,
    implementationDigest: implementationDigest(provenance, runtimeAuthority),
    runtimeAuthorityDigest: runtimeAuthority.authorityDigest,
    runtimeBinaryHashes: runtimeAuthority.runtimeBinaryHashes,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    verdict: 'passed',
    log: fileAuthorityEntry(logPath, path.basename(logPath)),
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function verifyTestReceipt(receipt, { name, command, receiptDirectory, provenance, runtimeAuthority }) {
  const { receiptDigest, ...unsigned } = receipt ?? {};
  if (
    receipt?.schemaVersion !== TEST_RECEIPT_SCHEMA_VERSION
    || receipt?.artifactKind !== TEST_RECEIPT_KIND
    || receipt?.name !== name
    || receipt?.command !== command
    || receipt?.verdict !== 'passed'
    || receipt?.worktreeClean !== true
    || receipt?.headCommit !== provenance.headCommit
    || receipt?.implementationDigest !== implementationDigest(provenance, runtimeAuthority)
    || receipt?.runtimeAuthorityDigest !== runtimeAuthority.authorityDigest
    || canonical(receipt?.runtimeBinaryHashes) !== canonical(runtimeAuthority.runtimeBinaryHashes)
    || receiptDigest !== digest(unsigned)
  ) return false;
  const provenanceFailure = exactGitProvenanceFailure({
    ...provenance,
    headCommit: receipt.headCommit,
    worktreeClean: receipt.worktreeClean,
    dirtyEntryCount: 0,
  }, provenance);
  if (provenanceFailure) return false;
  try {
    const actual = fileAuthorityEntry(path.join(receiptDirectory, receipt.log.path), receipt.log.path);
    return actual.bytes === receipt.log.bytes && actual.sha256 === receipt.log.sha256;
  } catch { return false; }
}

export function loadReusableTestReceipt(step, {
  workspaceRoot = repoRoot,
  indexPath = path.resolve(workspaceRoot, TEST_RECEIPT_CANONICAL_INDEX),
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
} = {}) {
  if (!REUSABLE_QUALITY_GATE_STEPS.has(step.name) || !fs.existsSync(indexPath)) return null;
  let index;
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { return null; }
  const entry = index.receipts?.find((candidate) => candidate.name === step.name);
  if (!entry) return null;
  let runtimeAuthority;
  try {
    runtimeAuthority = verifyStrictRuntimeAuthority(
      path.resolve(path.dirname(indexPath), index.runtimeAuthority.path),
      { workspaceRoot, provenance },
    ).authority;
  } catch { return null; }
  const receiptPath = path.resolve(path.dirname(indexPath), entry.path);
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch { return null; }
  return verifyTestReceipt(receipt, {
    name: step.name,
    command: step.command,
    receiptDirectory: path.dirname(receiptPath),
    provenance,
    runtimeAuthority,
  }) ? { receipt, receiptPath } : null;
}
