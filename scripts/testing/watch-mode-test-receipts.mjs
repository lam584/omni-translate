import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance, exactGitProvenanceFailure } from './git-provenance.mjs';
import { fileAuthorityEntry } from './watch-mode-evidence-authority.mjs';
import { verifyStrictRuntimeAuthority } from './watch-mode-strict-runtime-authority.mjs';
import {
  FROZEN_FUNNEL_STEPS, frozenFunnelFile, frozenFunnelFileEntry, verifyFrozenFunnelAuthority,
} from './frozen-test-funnel-distributed.mjs';

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

export function createTestReceipt({ name, command, logPath, startedAt, completedAt, provenance, runtimeAuthority, distributedAuthority }) {
  if (provenance?.worktreeClean !== true || Number(provenance?.dirtyEntryCount) !== 0) {
    throw new Error('test receipts require an exact clean HEAD');
  }
  const unsigned = {
    schemaVersion: distributedAuthority ? 2 : TEST_RECEIPT_SCHEMA_VERSION,
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
    ...(distributedAuthority ? { distributedAuthority } : {}),
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function verifyTestReceipt(receipt, { name, command, receiptDirectory, provenance, runtimeAuthority, runtimePublicKeyPem }) {
  const { receiptDigest, ...unsigned } = receipt ?? {};
  if (
    ![TEST_RECEIPT_SCHEMA_VERSION, 2].includes(receipt?.schemaVersion)
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
    const actual = frozenFunnelFileEntry(receiptDirectory, receipt.log.path);
    if (actual.bytes !== receipt.log.bytes || actual.sha256 !== receipt.log.sha256) return false;
    if (receipt.schemaVersion === 1) return !receipt.distributedAuthority;
    const binding = receipt.distributedAuthority;
    if (!binding || binding.path !== 'funnel-authority.json' || !runtimePublicKeyPem) return false;
    const authorityEntry = frozenFunnelFileEntry(receiptDirectory, binding.path);
    if (authorityEntry.bytes !== binding.bytes || authorityEntry.sha256 !== binding.sha256) return false;
    const authority = JSON.parse(fs.readFileSync(frozenFunnelFile(receiptDirectory, binding.path), 'utf8'));
    const results = verifyFrozenFunnelAuthority(authority, {
      publicKeyPem: runtimePublicKeyPem, provenance, runtimeAuthority, artifactRoot: receiptDirectory,
    });
    if (authority.plan.digest !== binding.planDigest) return false;
    const worker = results.find((entry) => entry.workerId === binding.workerId);
    const step = worker?.results.find((entry) => entry.name === name && entry.command === command);
    return Boolean(step && step.startedAt === receipt.startedAt && step.completedAt === receipt.completedAt
      && step.log.bytes === receipt.log.bytes && step.log.sha256 === receipt.log.sha256);
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
  let runtimeAuthority; let runtimePublicKeyPem;
  try {
    const verified = verifyStrictRuntimeAuthority(
      path.resolve(path.dirname(indexPath), index.runtimeAuthority.path),
      { workspaceRoot, provenance },
    );
    runtimeAuthority = verified.authority;
    runtimePublicKeyPem = fs.readFileSync(frozenFunnelFile(
      path.dirname(verified.authorityPath), runtimeAuthority.coordinatorSigning.publicKeyAuthority.path,
    ), 'utf8');
  } catch { return null; }
  if (index.schemaVersion === 2) {
    const expected = FROZEN_FUNNEL_STEPS.map(({ name, command }) => ({ name, command })).sort((a, b) => a.name.localeCompare(b.name));
    const actual = index.receipts?.map(({ name, command }) => ({ name, command })).sort((a, b) => a.name.localeCompare(b.name));
    if (canonical(actual) !== canonical(expected) || !index.distributedAuthority) return null;
  } else if (index.schemaVersion !== 1 || index.distributedAuthority) return null;
  let receiptPath;
  try { receiptPath = frozenFunnelFile(path.dirname(indexPath), entry.path); } catch { return null; }
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch { return null; }
  if (index.schemaVersion === 2 && (receipt.schemaVersion !== 2
      || receipt.distributedAuthority?.sha256 !== index.distributedAuthority.sha256
      || receipt.distributedAuthority?.planDigest !== index.distributedAuthority.planDigest)) return null;
  return verifyTestReceipt(receipt, {
    name: step.name,
    command: step.command,
    receiptDirectory: path.dirname(receiptPath),
    provenance,
    runtimeAuthority,
    runtimePublicKeyPem,
  }) ? { receipt, receiptPath } : null;
}
