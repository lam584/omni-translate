import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';
import * as shard from './watch-mode-shard-authority.mjs';
import * as coordinator from './run-watch-mode-live-coordinator.mjs';
import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';

import { createProviderPreflightManualSourceTestFixture } from './watch-mode-provider-preflight-manual-source-test-helpers.mjs';

const f = await createProviderPreflightManualSourceTestFixture(mock);
const clean = f.clean;
const keys = f.keys;

// A full real signed plan (no schema/signature mock) exercises archive expiry.
test('real signed plan: archive bypasses only present-day expiry, not original lease window', () => {
  const sha = 'a'.repeat(64);
  const inventory = [{ path: 'fixture/authority.bin', bytes: 17, sha256: sha }];
  const now = new Date();
  const generatedAt = new Date(now.getTime() - 7200000);
  const expiresAt = new Date(now.getTime() - 3600000);
  const workers = [{ workerId: 'vm1', vmIdentity: { provider: 'vmware', uuidBios: 'fixture-vm-1' },
    deviceProfileInstances: [{ instanceId: 'vm1-default', profileId: 'vmware-hda-default',
      deviceClass: 'default-speaker', physicalPlaybackDeviceId: 'default', expectedPhysicalPlaybackDeviceName: '' }] }];
  const realPlan = shard.createSignedExecutionPlan({ executionId: 'archive-fixture-0001',
    generatedAt, expiresAt, provenance: clean, authorityImplementationHashes: inventory,
    runtimeBinaryHashes: inventory, shardOrchestrationImplementationHashes: inventory,
    localIsolationAuthority: { path: 'local.json', bytes: 17, sha256: sha, providerCalls: 0 },
    providerPreflightAuthority: { path: 'provider-preflight-receipt.json', bytes: 17, sha256: sha,
      status: 'completed', operation: 'livetranslate-session-lifecycle-preflight', inputMode: 'none',
      providerInputMode: 'none', responseMode: 'text-only', terminalEvent: 'session.finished',
      invocationCount: 1, externalAudioSamples: 0,
      modelProtocolProfileIdentity: LIVE_LLM_CELLS[0].modelProtocolProfileIdentity,
      lifecycleBudget: { firstServerEventLatencyMs: 1200, socketEventTimeoutMs: 12000 },
      evidenceOutcome: 'livetranslate-session-finished', firstServerEvent: { type: 'session.created', monotonicMs: 500 },
      sessionAuthority: { sessionIdentitySha256: sha }, rawTrace: { path: 'trace.jsonl', bytes: 17, sha256: sha }, audioSeconds: null },
    workers, assignments: coordinator.defaultSingleWorkerAssignments(workers), ...keys });
  assert.throws(() => shard.verifySignedExecutionPlan(realPlan, { now }), /expired/u);
  assert.doesNotThrow(() => shard.verifySignedExecutionPlan(realPlan, { now, checkExpiry: false, currentProvenance: clean }));
  assert.throws(() => shard.verifySignedExecutionPlan(realPlan, { now, checkExpiry: false,
    currentProvenance: { ...clean, headCommit: 'f'.repeat(40) } }), /HEAD|provenance/u);
  const leases = shard.issueCellLeases(realPlan, keys.privateKeyPem, { issuedAt: generatedAt });
  // This is the same captured-time replay used by the matrix archive verifier.
  assert.doesNotThrow(() => shard.verifyCellLease(leases[0], realPlan, { now: new Date(generatedAt.getTime() + 1000) }));
  assert.doesNotThrow(() => shard.verifyCellLease(leases[0], realPlan, { now, checkExpiry: false }));
  const { signature, leaseDigest, ...core } = leases[0];
  core.issuedAt = new Date(expiresAt.getTime() + 1).toISOString();
  const signed = { ...core, leaseDigest: shard.sha256Canonical(core) };
  const forged = { ...signed, signature: { algorithm: 'Ed25519', keyId: realPlan.coordinator.keyId,
    valueBase64: crypto.sign(null, Buffer.from(shard.canonicalJson(signed)), keys.privateKeyPem).toString('base64') } };
  assert.throws(() => shard.verifyCellLease(forged, realPlan, { now, checkExpiry: false }), /issuance time.*outside/u);
});
test('read-only provider preflight manual source adapter', async (t) => {
  t.after(f.cleanup);
  await t.test('expired completed fixture returns hashes/authorization without new work; repeat is read-only', () => {
    f.fixture();
    const result = f.verify(f.options);
    assert.equal(result.sourceRoot, f.rawRoot);
    assert.equal(result.sourceBinding.executionId, f.plan.executionId);
    assert.ok(result.sourceBinding.authorityFiles.some((file) => file.path === 'claim.json'));
    assert.ok(result.sourceBinding.authorityFiles.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256)));
    assert.deepEqual(f.calls, ['runtime', 'plan', 'authorization', 'raw', 'manual', 'runtime']);
    assert.deepEqual(f.verify(f.options), result);
  });
  for (const [name, mutate, pattern] of [
    ['wrong HEAD', () => { f.current.headCommit = 'd'.repeat(40); }, /schema|HEAD/u],
    ['dirty checkout', () => { f.current.worktreeClean = false; f.current.dirtyEntryCount = 1; }, /clean HEAD/u],
    ['wrong frozen key', () => { f.plan.coordinator.publicKeyPem = shard.generateCoordinatorSigningKeyPair().publicKeyPem; f.publish(); }, /frozen coordinator public key/u],
    ['tampered signature', () => { f.plan.signature.valueBase64 = 'bad'; f.publish(); }, /signature|digest/u],
    ['different frozen batch with identical runtime and key', () => {
      const file = f.options.runtimeAuthorityPath;
      const { authorityDigest, ...core } = f.json(file);
      core.releaseId = 'different-frozen-release';
      f.put(file, { ...core, authorityDigest: shard.sha256Canonical(core) });
    }, /local isolation frozen runtime digest/u],
    ['recorded execution outside window', () => { f.manifest.generatedAt = new Date().toISOString(); f.publish(); }, /original authorization window/u],
    ['claim outside original grant window', () => {
      const claim = f.json(path.join(f.executionRoot, 'claim.json'));
      f.setGrantExpiry(new Date(Date.parse(claim.claimedAt) - 1).toISOString());
    }, /preflight claim.*original authorization window/u],
    ['terminal outside original grant window', () => {
      const receipt = f.json(path.join(f.executionRoot, 'provider-preflight-receipt.json'));
      f.setGrantExpiry(new Date(Date.parse(receipt.generatedAt) - 1).toISOString());
    }, /preflight receipt.*original authorization window/u],
    ['claim changed', () => f.put(path.join(f.executionRoot, 'claim.json'), { executionId: 'other' }), /binding/u],
    ['raw hash changed', () => f.put(f.rawFile, { tampered: true }), /binding/u],
    ['inventory changed', () => f.put(path.join(f.executionRoot, 'provider-preflight-evidence/inventory.json'), {}), /binding/u],
    ['receipt changed', () => f.put(path.join(f.executionRoot, 'provider-preflight-receipt.json'), {}), /binding/u],
    ['publication changed', () => { const p = f.json(f.publicationPath); p.verification = 'failed'; f.put(f.publicationPath, p); }, /not verified/u],
    ['source escape', () => { const p = f.json(f.publicationPath); p.sourceManifest = '../source.json'; f.put(f.publicationPath, p); }, /sibling/u],
    ['execution escape', () => { f.manifest.shardExecution.executionRoot = '../execution'; f.publish(); }, /execution root/u],
    ['manual validator rejects', () => { f.manualIssue = true; }, /fixture raw rejection/u],
    ['change during validation', () => { f.duringManual = () => f.put(f.rawFile, { raced: true }); }, /changed during validation/u],
  ]) await t.test(name, () => { f.fixture(); mutate(); assert.throws(() => f.verify(f.options), pattern); });
  await t.test('no override or arbitrary source parameters', () => {
    for (const key of ['sourceRoot', 'validateEvidence', 'currentProvenance', 'workspaceRoot', 'skip', 'now']) {
      assert.throws(() => f.verify({ ...f.options, [key]: true }), /accepts only/u);
    }
    assert.throws(() => f.verify({ ...f.options, executionRoot: f.executionRoot + '/../execution' }), /traversal/u);
  });
  await t.test('junction/ancestor escape rejected before validators', () => {
    f.fixture();
    const link = path.join(f.evidenceRoot, 'linked');
    fs.symlinkSync(f.executionRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    try { assert.throws(() => f.verify({ ...f.options, executionRoot: link }), /reparse/u); }
    finally { fs.unlinkSync(link); }
    assert.deepEqual(f.calls, []);
  });
});
