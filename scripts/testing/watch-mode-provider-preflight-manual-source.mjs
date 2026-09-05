import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance, exactGitProvenanceFailure } from './git-provenance.mjs';
import { verifyStrictRuntimeAuthority } from './watch-mode-strict-runtime-authority.mjs';
import {
  currentPaidAuthorityImplementationHashes, STRICT_MATRIX_ARTIFACT_KIND, STRICT_MATRIX_SCHEMA_VERSION,
} from './watch-mode-evidence-authority.mjs';
import {
  canonicalJson, coordinatorKeyIdForPublicKey, currentShardOrchestrationImplementationHashes,
  fileAuthorityEntry, resolveAuthorityChild, validateFileAuthorityEntry,
  verifySignedExecutionPlan, SHARD_EXECUTION_PLAN_FILE,
} from './watch-mode-shard-authority.mjs';
import {
  COORDINATOR_AGGREGATE_FILE, COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT,
  validateCoordinatorAggregate,
} from './run-watch-mode-live-coordinator.mjs';
import { CANONICAL_STRICT_MATRIX_MANIFEST } from './run-watch-mode-live-matrix.mjs';
import {
  validateStrictMatrixVerificationReceipt, verifyStrictShardProviderPreflightAuthorization,
  verifyStrictShardProviderPreflightAuthority,
} from './verify-watch-mode-evidence.mjs';
import { validateRawReleaseManualEvidence } from './release-manual-collector.mjs';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const same = (a, b, label) => {
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error(label + ' mismatch');
};

// Check all ancestors: lstat catches Windows junctions and realpath catches aliases.
function canonicalPath(input, kind) {
  if (typeof input !== 'string' || !input || input.includes('\0')
      || input.split(/[\\/]/u).some((part) => part === '..' || part === '.')
      || input.startsWith('\\\\') || input.startsWith('//')
      || input.replace(/^[a-z]:/iu, '').includes(':')) {
    throw new Error('source path must be canonical without traversal or device paths');
  }
  const resolved = path.resolve(repoRoot, input);
  let cursor = path.parse(resolved).root;
  for (const component of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('source reparse path rejected: ' + cursor);
    if (fs.realpathSync.native(cursor) !== cursor) throw new Error('source path is not canonical: ' + cursor);
  }
  const stats = fs.lstatSync(resolved);
  if (!(kind === 'directory' ? stats.isDirectory() : stats.isFile())) throw new Error('source must be a ' + kind);
  return resolved;
}
function child(root, relative, kind = 'file') {
  return canonicalPath(resolveAuthorityChild(root, relative, 'manual preflight source'), kind);
}
function boundFile(root, entry, expected = entry?.path) {
  child(root, expected);
  return validateFileAuthorityEntry(root, entry, expected, 'manual preflight source binding');
}
function treeFiles(root, relative = '') {
  return fs.readdirSync(path.join(root, relative)).sort().flatMap((name) => {
    const portable = relative ? relative + '/' + name : name;
    const candidate = resolveAuthorityChild(root, portable);
    const stats = fs.lstatSync(candidate);
    if (stats.isSymbolicLink()) throw new Error('source reparse entry rejected: ' + portable);
    if (!stats.isDirectory()) return [child(root, portable)];
    child(root, portable, 'directory');
    return treeFiles(root, portable);
  }).sort();
}

/**
 * Read-only adapter for an already published STAGED coordinator execution.
 * No provenance, clock, source-root or validator overrides are accepted.
 * Existing aggregate/publication artifacts are hash-bound, NOT signed; the
 * frozen public key anchors the signed plan and preflight authorization.
 * Manifest validation must reinvoke this function and compare sourceBinding.
 */
export function verifyProviderPreflightManualSource(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).sort().join(',') !== 'executionRoot,runtimeAuthorityPath') {
    throw new Error('manual preflight source accepts only runtimeAuthorityPath and executionRoot');
  }
  const runtimeAuthorityPath = canonicalPath(options.runtimeAuthorityPath, 'file');
  const executionRoot = canonicalPath(options.executionRoot, 'directory');
  const evidenceRoot = path.dirname(executionRoot);
  const executionRootRelative = path.basename(executionRoot);
  const runtimeDocument = readJson(runtimeAuthorityPath);
  const runtimeArtifacts = [runtimeDocument.certificate?.certificateAuthority,
    runtimeDocument.coordinatorSigning?.publicKeyAuthority,
    runtimeDocument.coordinatorSigning?.privateKeyAuthority, runtimeDocument.aec3Gate?.authority,
  ].map((entry) => boundFile(path.dirname(runtimeAuthorityPath), entry));
  const publicationPath = child(evidenceRoot, CANONICAL_STRICT_MATRIX_MANIFEST);
  const publication = readJson(publicationPath);
  const sibling = (value) => {
    if (typeof value !== 'string' || !value || /[\\/]/u.test(value)) throw new Error('publication source must be a sibling file');
    return value;
  };
  const manifestPath = boundFile(evidenceRoot, { path: sibling(publication.sourceManifest),
    sha256: publication.sourceManifestSha256, bytes: publication.sourceManifestBytes });
  const verificationPath = boundFile(evidenceRoot, { path: sibling(publication.verificationReceiptPath),
    sha256: publication.verificationReceiptSha256, bytes: publication.verificationReceiptBytes });
  const executionFiles = treeFiles(executionRoot);
  const trackedPaths = [...new Set([runtimeAuthorityPath, ...runtimeArtifacts,
    publicationPath, manifestPath, verificationPath, ...executionFiles])].sort();
  const snapshot = () => trackedPaths.map((file) => {
    canonicalPath(file, 'file');
    return { ...fileAuthorityEntry(file, path.basename(file), { allowEmpty: true }), absolutePath: file };
  });
  const before = snapshot();
  const currentProvenance = currentGitProvenance({ cwd: repoRoot });
  const frozen = verifyStrictRuntimeAuthority(runtimeAuthorityPath, { workspaceRoot: repoRoot, provenance: currentProvenance });
  same(frozen.authority, runtimeDocument, 'runtime authority snapshot');
  const publicKeyPem = fs.readFileSync(runtimeArtifacts[1], 'utf8');
  const manifest = readJson(manifestPath);
  if (manifest.strict !== true || manifest.evidenceMode !== 'live'
      || manifest.schemaVersion !== STRICT_MATRIX_SCHEMA_VERSION
      || manifest.artifactKind !== STRICT_MATRIX_ARTIFACT_KIND
      || manifest.cells?.length !== 4) throw new Error('publication is not a formal strict coordinator manifest');
  const publicationKeys = ['verification', 'verifiedAt', 'verificationProvenance', 'sourceManifest',
    'sourceManifestSha256', 'sourceManifestBytes', 'verificationReceiptPath',
    'verificationReceiptSha256', 'verificationReceiptBytes'];
  const publishedManifest = Object.fromEntries(Object.entries(publication).filter(([key]) => !publicationKeys.includes(key)));
  same(publishedManifest, manifest, 'canonical publication/source manifest');
  if (publication.verification !== 'passed' || !Number.isFinite(Date.parse(publication.verifiedAt))
      || Date.parse(publication.verifiedAt) > Date.now()) throw new Error('canonical publication is not verified');
  const failure = exactGitProvenanceFailure(publication.verificationProvenance, currentProvenance);
  if (failure) throw new Error(failure);
  same(manifest.shardExecution?.executionRoot, executionRootRelative, 'published execution root');
  const plan = readJson(boundFile(evidenceRoot, manifest.shardExecution.plan,
    executionRootRelative + '/' + SHARD_EXECUTION_PLAN_FILE));
  same(plan.coordinator?.publicKeyPem, publicKeyPem, 'frozen coordinator public key');
  same(plan.coordinator?.keyId, coordinatorKeyIdForPublicKey(publicKeyPem), 'frozen coordinator key ID');
  const currentImplementationHashes = frozen.authority.implementationHashes;
  const currentRuntimeBinaryHashes = frozen.authority.runtimeBinaryHashes;
  const currentShardImplementationHashes = currentShardOrchestrationImplementationHashes({ workspaceRoot: repoRoot });
  const validationAt = new Date();
  // Archive verification, not permission to start work. Keep real wallclock for
  // freshness; verify the recorded execution window separately below. The main
  // matrix verifier similarly replays at manifest.generatedAt (not today's lease).
  verifySignedExecutionPlan(plan, { now: validationAt, checkExpiry: false, currentProvenance,
    currentAuthorityImplementationHashes: currentImplementationHashes,
    currentRuntimeBinaryHashes, currentShardImplementationHashes });
  // The signed prerequisite binds the exact freeze, not just equal binaries/key.
  same(plan.localIsolationAuthority?.runtimeAuthorityDigest,
    frozen.authority.authorityDigest, 'local isolation frozen runtime digest');
  const within = (value, start, end, label) => {
    const values = [value, start, end].map((item) => Date.parse(String(item)));
    if (values.some((item) => !Number.isFinite(item)) || values[1] > values[0]
        || values[0] > values[2] || values[0] > validationAt.getTime()) {
      throw new Error(label + ' is outside its original authorization window');
    }
  };
  within(manifest.generatedAt, plan.generatedAt, plan.expiresAt, 'published execution');
  const verification = validateStrictMatrixVerificationReceipt({ receiptPath: verificationPath,
    manifestPath, manifest, currentProvenance, implementationHashes: currentImplementationHashes,
    paidImplementationHashes: currentPaidAuthorityImplementationHashes({ workspaceRoot: repoRoot }),
    runtimeBinaryHashes: currentRuntimeBinaryHashes });
  same(publication.verifiedAt, verification.receipt.verifiedAt, 'publication verified timestamp');
  const aggregate = validateCoordinatorAggregate(readJson(boundFile(evidenceRoot,
    manifest.shardExecution.coordinatorAggregate, executionRootRelative + '/' + COORDINATOR_AGGREGATE_FILE)));
  within(aggregate.generatedAt, plan.generatedAt, manifest.generatedAt, 'coordinator aggregate');
  for (const key of ['executionId', 'planDigest', 'provenance', 'authority', 'providerPreflightAuthority', 'localIsolationAuthority']) {
    same(aggregate[key], plan[key], 'coordinator aggregate ' + key);
  }
  same(aggregate.aggregateDigest, manifest.matrixIntegration?.coordinatorAggregateDigest, 'published aggregate digest');
  if (aggregate.verdict !== 'passed' || !Number.isFinite(Date.parse(aggregate.generatedAt))
      || Date.parse(aggregate.generatedAt) > Date.parse(publication.verifiedAt)) throw new Error('aggregate is not a published success');
  const context = { plan, executionRoot, executionRootRelative, evidenceRoot, workspaceRoot: repoRoot,
    shardExecution: manifest.shardExecution, matrixIntegration: manifest.matrixIntegration,
    currentImplementationHashes, currentRuntimeBinaryHashes, currentShardImplementationHashes,
    currentProvenance, validationAt };
  const authorization = verifyStrictShardProviderPreflightAuthorization(context);
  same(authorization.grant.coordinator.publicKeyPem, publicKeyPem, 'frozen preflight grant key');
  const preflight = verifyStrictShardProviderPreflightAuthority({ ...context, authorization });
  for (const [label, value] of [
    ['preflight claim', authorization.claimProjection.claimedAt],
    ['preflight receipt', preflight.receipt.generatedAt],
    ['preflight completion', authorization.completion.generatedAt],
    ...(preflight.raw.evidenceTimes ?? []).map((value) => ['preflight raw terminal', value]),
  ]) within(value, authorization.grant.generatedAt, authorization.grant.expiresAt, label);
  const sourceRoot = child(executionRoot, COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT, 'directory');
  same(preflight.rawRoot, sourceRoot, 'fixed preflight raw source');
  const expectedAuthorization = { ...authorization.consumption, consumptionClaim: authorization.claimProjection };
  const raw = validateRawReleaseManualEvidence(sourceRoot, 'E2E-PROVIDER-PROBE', {
    now: validationAt.getTime(), workspaceRoot: repoRoot, implementationRoot: repoRoot,
    currentProvenance, expectedAuthorization });
  if (!raw.summary || !Array.isArray(raw.issues) || raw.issues.length) {
    throw new Error('manual provider preflight raw validation failed: ' + (raw.issues?.join('; ') ?? 'missing summary'));
  }
  same(before, snapshot(), 'source authority changed during validation');
  same(executionFiles, treeFiles(executionRoot), 'execution inventory changed during validation');
  verifyStrictRuntimeAuthority(runtimeAuthorityPath, { workspaceRoot: repoRoot });
  return { sourceRoot, expectedAuthorization: structuredClone(expectedAuthorization), sourceBinding: {
    schemaVersion: 1, artifactKind: 'watch-mode-provider-preflight-manual-source', runtimeAuthorityPath,
    executionRoot, executionId: plan.executionId, planDigest: plan.planDigest,
    coordinatorKeyId: plan.coordinator.keyId, publicationPath, authorityFiles: before,
  } };
}
