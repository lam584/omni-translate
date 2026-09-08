import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalJson, sha256Canonical } from './watch-mode-shard-authority.mjs';
import {
  PROVIDER_PREFLIGHT_LIFECYCLE_BUDGET,
  claimProviderPreflightDispatchAuthorization,
} from './watch-mode-provider-preflight-authorization.mjs';
import { runManagedProviderPreflight } from './watch-mode-provider-preflight-process.mjs';

export const REMOTE_PROVIDER_PREFLIGHT_REQUEST_KIND = 'watch-mode-remote-provider-preflight-request';
export const REMOTE_PROVIDER_PREFLIGHT_REQUEST_SCHEMA_VERSION = 1;
export const REMOTE_PROVIDER_PREFLIGHT_RETRY_POLICY = 'new-execution-required';

const SHA256 = /^[a-f0-9]{64}$/u;
const EXACT_REQUEST_KEYS = Object.freeze([
  'artifactKind', 'authorizationDigest', 'executablePath', 'executionId', 'executor',
  'grantPath', 'leaseReservationDirectory', 'outputDirectory', 'schemaVersion',
]);

const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
};

export function validateRemotePreflightRequest(value, observed) {
  exactKeys(value, EXACT_REQUEST_KEYS, 'remote provider preflight request');
  exactKeys(value.executor, [
    'interactiveUser', 'readinessAuthority', 'runtimeBundleDigest', 'transportAuthority', 'vmIdentity',
    'vmIdentityDigest', 'workerId',
  ], 'remote provider preflight executor');
  const executor = value.executor;
  if (value.schemaVersion !== REMOTE_PROVIDER_PREFLIGHT_REQUEST_SCHEMA_VERSION
    || value.artifactKind !== REMOTE_PROVIDER_PREFLIGHT_REQUEST_KIND
    || !String(executor.workerId ?? '').trim()
    || executor.transportAuthority?.kind !== 'ssh'
    || !String(executor.transportAuthority?.hostKeyAlias ?? '').trim()
    || !String(executor.transportAuthority?.hostKeyAlgorithm ?? '').trim()
    || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(String(executor.transportAuthority?.hostKeySha256 ?? ''))
    || executor.interactiveUser !== 'VMUser'
    || executor.vmIdentity?.provider !== 'vmware'
    || executor.vmIdentityDigest !== sha256Canonical(executor.vmIdentity)
    || !SHA256.test(String(executor.runtimeBundleDigest ?? ''))
    || !SHA256.test(String(value.authorizationDigest ?? ''))
    || executor.readinessAuthority?.workerId !== executor.workerId
    || executor.readinessAuthority?.providerCalls !== 0
    || executor.readinessAuthority?.path !== `worker-readiness/${executor.workerId}.json`
    || !SHA256.test(String(executor.readinessAuthority?.sha256 ?? ''))) {
    throw new Error('remote provider preflight request is not bound to its signed configured executor authority');
  }
  if (observed) {
    if (observed.observedWorkerId !== executor.workerId
      || observed.observedInteractiveUser !== executor.interactiveUser
      || canonicalJson(observed.observedVmIdentity) !== canonicalJson(executor.vmIdentity)
      || observed.observedRuntimeBundleDigest !== executor.runtimeBundleDigest
      || canonicalJson(observed.observedReadinessAuthority) !== canonicalJson(executor.readinessAuthority)) {
      throw new Error('remote provider preflight executor identity/hash/readiness mismatch');
    }
  }
  return {
    ...structuredClone(value),
    lifecycleBudget: structuredClone(PROVIDER_PREFLIGHT_LIFECYCLE_BUDGET),
    retryPolicy: REMOTE_PROVIDER_PREFLIGHT_RETRY_POLICY,
  };
}

export function createRemoteProviderPreflightDispatch({
  inspectExecutor,
  claimAuthorization,
  runProviderPreflight,
  collectEvidence,
}) {
  for (const [name, operation] of Object.entries({ inspectExecutor, claimAuthorization, runProviderPreflight, collectEvidence })) {
    if (typeof operation !== 'function') throw new Error(`remote preflight requires ${name}`);
  }
  let used = false;
  return async (rawRequest) => {
    if (used) throw new Error('remote provider preflight dispatch is single-use');
    used = true;
    const observed = await inspectExecutor(rawRequest);
    const request = validateRemotePreflightRequest(rawRequest, observed);
    const claim = await claimAuthorization(request);
    if (claim?.claimed !== true) throw new Error('provider preflight authorization was already consumed');
    const result = await runProviderPreflight(request);
    return collectEvidence(result, request);
  };
}

async function readStdinJson() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('remote preflight request exceeds 1 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function runRemoteProviderPreflightWorker(rawRequest, { runPreflight = runManagedProviderPreflight } = {}) {
  const request = validateRemotePreflightRequest(rawRequest);
  const claim = claimProviderPreflightDispatchAuthorization({
    grantPath: request.grantPath,
    reservationDirectory: request.leaseReservationDirectory,
    expectedAuthorizationDigest: request.authorizationDigest,
  });
  const headCommit = claim.authorization?.provenance?.headCommit;
  if (!/^[a-f0-9]{40}$/u.test(String(headCommit ?? ''))
    || claim.authorization?.provenance?.worktreeClean !== true
    || claim.authorization?.provenance?.dirtyEntryCount !== 0) {
    throw new Error('remote provider preflight authorization requires clean signed Git provenance');
  }
  const result = await runPreflight({
    executablePath: request.executablePath,
    outputDirectory: request.outputDirectory,
    executionId: request.executionId,
    providerId: 'provider-dashscope',
    environment: {
      OMNI_RELEASE_EVIDENCE_SCENARIO: 'E2E-PROVIDER-PROBE',
      OMNI_RELEASE_EVIDENCE_OUTPUT_DIRECTORY: request.outputDirectory,
      OMNI_RELEASE_EVIDENCE_HEAD_COMMIT: headCommit,
      OMNI_RELEASE_EVIDENCE_PROVIDER_ID: 'provider-dashscope',
      OMNI_PROVIDER_PREFLIGHT_EXECUTION_ID: request.executionId,
      OMNI_RELEASE_EVIDENCE_PREFLIGHT_GRANT_PATH: request.grantPath,
      OMNI_RELEASE_EVIDENCE_PREFLIGHT_RESERVATION_DIRECTORY: request.leaseReservationDirectory,
      OMNI_RELEASE_EVIDENCE_PREFLIGHT_AUTHORIZATION_DIGEST: request.authorizationDigest,
      OMNI_LOG_LEVEL: 'debug',
    },
  });
  return { status: 'completed', outputDirectory: result.outputDirectory, fields: result.fields };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runRemoteProviderPreflightWorker(await readStdinJson());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`remote-provider-preflight: ${error.message}`);
    process.exitCode = 1;
  }
}
