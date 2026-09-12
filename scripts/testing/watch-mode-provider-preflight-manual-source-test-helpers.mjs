import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as common from '../lib/testing-common.mjs';
import * as provenanceModule from './git-provenance.mjs';
import * as runtime from './watch-mode-strict-runtime-authority.mjs';
import * as evidence from './watch-mode-evidence-authority.mjs';
import * as shard from './watch-mode-shard-authority.mjs';
import * as coordinator from './run-watch-mode-live-coordinator.mjs';
import * as matrix from './run-watch-mode-live-matrix.mjs';
import * as strict from './verify-watch-mode-evidence.mjs';
import * as manual from './release-manual-collector.mjs';
import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';


/**
 * Installs test-only module doubles and returns a published synthetic fixture.
 * Call BEFORE importing the consumer under test. Does not register tests.
 * Requires node --experimental-test-module-mocks and the node:test mock object.
 * Runtime inventories, keypair validation, signatures, aggregate and publication
 * receipt checks are real. Paid plan/authorization/raw schemas are adapter doubles;
 * this is NOT a fixture certified by the complete production raw validator.
 * fixture() resets bytes/state; verify(options) exercises the public source API.
 * A collector integration must additionally supply valid production raw artifacts
 * before claiming an unmocked positive E2E result. No repository clone, app launch,
 * Git commit, build, Provider invocation or production claim is performed here.
 */
export async function createProviderPreflightManualSourceTestFixture(mock) {
  const moduleMocks = [];
  const installMock = (specifier, options) => {
    moduleMocks.push(mock.module(specifier, options));
  };
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-manual-source-')));

  const clean = { schemaVersion: 1, source: 'git', captureStatus: 'captured',
    headCommit: 'a'.repeat(40), worktreeClean: true, dirtyEntryCount: 0 };
  let current = structuredClone(clean);
  let calls = [];
  let manualIssue = false;
  let duringManual = () => {};
  const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  };
  const entry = (base, name) => shard.fileAuthorityEntry(path.join(base, name), name);
  const keys = shard.generateCoordinatorSigningKeyPair();
  const sign = (value) => shard.signCoordinatorAuthority(value, keys.privateKeyPem, keys.publicKeyPem);
  const checked = (base, binding) => json(shard.validateFileAuthorityEntry(base, binding, binding.path, 'fixture binding'));

  installMock('../lib/testing-common.mjs', { namedExports: { ...common, repoRoot: root } });
  installMock('./git-provenance.mjs', { namedExports: { ...provenanceModule,
    currentGitProvenance: () => structuredClone(current) } });
  installMock('./watch-mode-strict-runtime-authority.mjs', { namedExports: { ...runtime,
    verifyStrictRuntimeAuthority: (file, options) => {
      calls.push('runtime');
      return runtime.verifyStrictRuntimeAuthority(file, { ...options, provenance: current });
    } } });
  installMock('./watch-mode-shard-authority.mjs', { namedExports: { ...shard,
    verifySignedExecutionPlan: (plan, options) => {
      calls.push('plan');
      assert.equal(options.checkExpiry, false);
      assert.ok(Math.abs(options.now.getTime() - Date.now()) < 1000, 'must not forge wallclock');
      shard.verifyCoordinatorAuthority(plan, plan.coordinator.publicKeyPem, 'fixture signed plan');
      const failure = provenanceModule.exactGitProvenanceFailure(plan.provenance, options.currentProvenance);
      if (failure) throw new Error(failure);
      assert.deepEqual(plan.authority.implementationHashes, options.currentAuthorityImplementationHashes);
      assert.deepEqual(plan.authority.runtimeBinaryHashes, options.currentRuntimeBinaryHashes);
      assert.deepEqual(plan.authority.shardOrchestrationImplementationHashes, options.currentShardImplementationHashes);
    } } });
  installMock('./verify-watch-mode-evidence.mjs', { namedExports: { ...strict,
    verifyStrictShardProviderPreflightAuthorization: (context) => {
      calls.push('authorization');
      assert.equal(context.validateEvidence, undefined);
      const { plan, executionRoot } = context;
      const grant = checked(executionRoot, plan.providerPreflightGrant);
      shard.verifyCoordinatorAuthority(grant, plan.coordinator.publicKeyPem);
      const completion = checked(executionRoot, plan.providerPreflightCompletion);
      shard.verifyCoordinatorAuthority(completion, plan.coordinator.publicKeyPem);
      const claim = checked(executionRoot, plan.providerPreflightAuthorization.consumptionClaim);
      assert.deepEqual(claim, completion.claim);
      assert.deepEqual(claim, grant.claim);
      return { grant, completion, consumption: grant.consumption,
        claimProjection: { ...claim, ...plan.providerPreflightAuthorization.consumptionClaim } };
    },
    verifyStrictShardProviderPreflightAuthority: (context) => {
      calls.push('raw');
      assert.equal(context.validateEvidence, undefined, 'production raw validator cannot be bypassed');
      assert.ok(context.authorization.completion);
      const receipt = checked(context.executionRoot, context.plan.providerPreflightAuthority);
      const inventory = checked(context.executionRoot, receipt.evidenceAuthority);
      const rawRoot = path.join(context.executionRoot, coordinator.COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT);
      for (const binding of inventory.files) checked(rawRoot, binding);
      return { rawRoot, receipt, raw: { evidenceTimes: [receipt.generatedAt] } };
    } } });
  installMock('./release-manual-collector.mjs', { namedExports: { ...manual,
    validateRawReleaseManualEvidence: (source, scenario, options) => {
      calls.push('manual');
      assert.equal(scenario, 'E2E-PROVIDER-PROBE');
      assert.equal(source, path.join(root, 'evidence', 'execution', coordinator.COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT));
      assert.equal(options.expectedAuthorization.executionId, 'fixture-execution');
      assert.equal(options.expectedAuthorization.consumptionClaim.executionId, 'fixture-execution');
      assert.deepEqual(options.currentProvenance, current);
      duringManual();
      return { summary: {}, issues: manualIssue ? ['fixture raw rejection'] : [] };
    } } });
  const { verifyProviderPreflightManualSource: verify } = await import('./watch-mode-provider-preflight-manual-source.mjs?fixture=' + encodeURIComponent(root));
  const runtimeRoot = path.join(root, runtime.STRICT_RUNTIME_ROOT, 'fixture-release');
  const runtimePath = path.join(runtimeRoot, runtime.STRICT_RUNTIME_AUTHORITY_FILE);
  const executionRoot = path.join(root, 'evidence', 'execution');
  const evidenceRoot = path.dirname(executionRoot);
  const rawRoot = path.join(executionRoot, coordinator.COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT);
  const manifestPath = path.join(evidenceRoot, 'source.json');
  const publicationPath = path.join(evidenceRoot, matrix.CANONICAL_STRICT_MATRIX_MANIFEST);
  const options = { runtimeAuthorityPath: runtimePath, executionRoot };
  let plan;
  let aggregate;
  let manifest;
  let rawFile;

  function publish() {
    put(path.join(executionRoot, shard.SHARD_EXECUTION_PLAN_FILE), plan);
    put(path.join(executionRoot, coordinator.COORDINATOR_AGGREGATE_FILE), aggregate);
    manifest.shardExecution.plan = entry(evidenceRoot, 'execution/' + shard.SHARD_EXECUTION_PLAN_FILE);
    manifest.shardExecution.coordinatorAggregate = entry(evidenceRoot, 'execution/' + coordinator.COORDINATOR_AGGREGATE_FILE);
    put(manifestPath, manifest);
    const receiptPath = strict.strictMatrixVerificationReceiptPath(manifestPath);
    // The production writer is exclusive. Remove only this known fixture file.
    if (fs.existsSync(receiptPath)) fs.unlinkSync(receiptPath);
    const verified = strict.writeStrictMatrixVerificationReceipt({ manifestPath, manifest,
      authority: { implementationHashes: evidence.currentAuthorityImplementationHashes({ workspaceRoot: root }),
        paidImplementationHashes: evidence.currentPaidAuthorityImplementationHashes({ workspaceRoot: root }),
        runtimeBinaryHashes: evidence.currentAuthorityRuntimeBinaryHashes({ workspaceRoot: root }) },
      currentProvenance: clean, now: new Date(Date.now() - 1000) });
    const source = entry(evidenceRoot, path.basename(manifestPath));
    const receipt = entry(evidenceRoot, path.basename(verified.receiptPath));
    put(publicationPath, { ...manifest, verification: 'passed', verifiedAt: verified.receipt.verifiedAt,
      verificationProvenance: clean, sourceManifest: source.path, sourceManifestBytes: source.bytes,
      sourceManifestSha256: source.sha256, verificationReceiptPath: receipt.path,
      verificationReceiptBytes: receipt.bytes, verificationReceiptSha256: receipt.sha256 });
  }
  function fixture() {
    current = structuredClone(clean); calls = []; manualIssue = false; duringManual = () => {};
    for (const file of new Set([...evidence.AUTHORITY_IMPLEMENTATION_FILES,
      ...evidence.PAID_AUTHORITY_IMPLEMENTATION_FILES, ...evidence.AUTHORITY_RUNTIME_BINARY_FILES,
      ...shard.SHARD_ORCHESTRATION_IMPLEMENTATION_FILES])) put(path.join(root, file), 'synthetic fixture\n');
    put(path.join(runtimeRoot, 'public.pem'), keys.publicKeyPem);
    put(path.join(runtimeRoot, 'private.pem'), keys.privateKeyPem);
    put(path.join(runtimeRoot, 'certificate.cer'), 'synthetic fixture\n');
    put(path.join(runtimeRoot, 'aec.json'), { verdict: 'passed' });
    const runtimeCore = { schemaVersion: 1, artifactKind: runtime.STRICT_RUNTIME_AUTHORITY_KIND,
      provenance: clean, certificate: { keyAlgorithm: 'RSA', keyLength: 3072, hashAlgorithm: 'SHA256',
        enhancedKeyUsage: 'Code Signing', signingMode: 'local-self-signed', trustScope: 'vmware-testsigning-only',
        publicProductionTrust: false, certificateAuthority: entry(runtimeRoot, 'certificate.cer') },
      coordinatorSigning: { algorithm: 'Ed25519', keyId: shard.coordinatorKeyIdForPublicKey(keys.publicKeyPem),
        publicKeyAuthority: entry(runtimeRoot, 'public.pem'), privateKeyAuthority: entry(runtimeRoot, 'private.pem') },
      aec3Gate: { verdict: 'passed', authority: entry(runtimeRoot, 'aec.json') },
      implementationHashes: evidence.currentAuthorityImplementationHashes({ workspaceRoot: root }),
      runtimeBinaryHashes: evidence.currentAuthorityRuntimeBinaryHashes({ workspaceRoot: root }) };
    put(runtimePath, { ...runtimeCore, authorityDigest: shard.sha256Canonical(runtimeCore) });
    const at = (offset) => new Date(Date.now() + offset).toISOString();
    const claim = { executionId: 'fixture-execution', authorizationDigest: 'b'.repeat(64), claimedAt: at(-8000) };
    put(path.join(executionRoot, 'claim.json'), claim);
    put(path.join(executionRoot, 'grant.json'), sign({ coordinator: { publicKeyPem: keys.publicKeyPem }, claim,
      generatedAt: at(-10000), expiresAt: at(-5000),
      consumption: { executionId: claim.executionId, authorizationDigest: claim.authorizationDigest } }));
    put(path.join(executionRoot, 'completion.json'), sign({ claim, generatedAt: at(-6000) }));
    rawFile = path.join(rawRoot, 'provider-probe-result.json');
    put(rawFile, { fixture: true });
    put(path.join(executionRoot, 'provider-preflight-evidence/inventory.json'), { files: [entry(rawRoot, path.basename(rawFile))] });
    put(path.join(executionRoot, 'provider-preflight-receipt.json'), {
      generatedAt: at(-7000),
      evidenceAuthority: entry(executionRoot, 'provider-preflight-evidence/inventory.json') });
    plan = sign({ executionId: claim.executionId, planDigest: 'c'.repeat(64), provenance: clean,
      generatedAt: at(-4000), expiresAt: at(-500),
      coordinator: { publicKeyPem: keys.publicKeyPem, keyId: runtimeCore.coordinatorSigning.keyId },
      authority: { implementationHashes: runtimeCore.implementationHashes, runtimeBinaryHashes: runtimeCore.runtimeBinaryHashes,
        shardOrchestrationImplementationHashes: shard.currentShardOrchestrationImplementationHashes({ workspaceRoot: root }) },
      providerPreflightGrant: entry(executionRoot, 'grant.json'),
      providerPreflightCompletion: entry(executionRoot, 'completion.json'),
      providerPreflightAuthorization: { consumptionClaim: entry(executionRoot, 'claim.json') },
      providerPreflightAuthority: entry(executionRoot, 'provider-preflight-receipt.json'),
      localIsolationAuthority: { runtimeAuthorityDigest: json(runtimePath).authorityDigest } });
    const aggregateCore = { schemaVersion: shard.SHARD_AUTHORITY_SCHEMA_VERSION,
      artifactKind: coordinator.COORDINATOR_AGGREGATE_KIND, generatedAt: new Date(Date.now() - 2000).toISOString(),
      verdict: 'passed', executionId: plan.executionId, planDigest: plan.planDigest, provenance: plan.provenance,
      authority: plan.authority, providerPreflightAuthority: plan.providerPreflightAuthority,
      localIsolationAuthority: plan.localIsolationAuthority,
      budget: { reservedExternalAudioSamples: shard.SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
        actualExternalAudioSamples: 100, preflightExternalAudioSamples: 0 },
      cells: LIVE_LLM_CELLS.map((cell, i) => ({ cellId: cell.cellId, leaseId: 'lease-' + i, verdict: 'passed' })) };
    aggregate = { ...aggregateCore, aggregateDigest: shard.sha256Canonical(aggregateCore) };
    manifest = { schemaVersion: evidence.STRICT_MATRIX_SCHEMA_VERSION, artifactKind: evidence.STRICT_MATRIX_ARTIFACT_KIND,
      generatedAt: at(-1500),
      strict: true, evidenceMode: 'live', provenance: clean, cells: structuredClone(LIVE_LLM_CELLS),
      shardExecution: { executionRoot: 'execution' }, matrixIntegration: { coordinatorAggregateDigest: aggregate.aggregateDigest } };
    publish();
  }


  const setGrantExpiry = (value) => {
    const { signature, digest, ...grant } = json(path.join(executionRoot, 'grant.json'));
    put(path.join(executionRoot, 'grant.json'), sign({ ...grant, expiresAt: value }));
    const { signature: planSignature, digest: planHash, ...planCore } = plan;
    plan = sign({ ...planCore, providerPreflightGrant: entry(executionRoot, 'grant.json') });
    publish();
  };
  const cleanup = () => {
    for (const handle of [...moduleMocks].reverse()) handle.restore();
    assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('preflight-manual-source-'));
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, options, runtimePath, runtimeRoot, executionRoot, evidenceRoot, rawRoot,
    manifestPath, publicationPath, clean, keys, verify, fixture, publish, cleanup, put, json, setGrantExpiry,
    get plan() { return plan; }, get aggregate() { return aggregate; }, get manifest() { return manifest; },
    get current() { return current; }, get calls() { return calls; }, get rawFile() { return rawFile; },
    set manualIssue(value) { manualIssue = value; }, set duringManual(value) { duringManual = value; },
  };
}
