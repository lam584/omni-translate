import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTHORITY_IMPLEMENTATION_FILES, AUTHORITY_RUNTIME_BINARY_FILES, currentAuthorityImplementationHashes, currentAuthorityRuntimeBinaryHashes, fileAuthorityEntry } from './watch-mode-evidence-authority.mjs';
import { generateCoordinatorSigningKeyPair, coordinatorKeyIdForPublicKey } from './watch-mode-shard-authority.mjs';
import { buildVirtualMicReleasePlan, runVirtualMicReleaseEvidence, buildCurrentVirtualMicBinaries } from './run-virtual-mic-release-evidence.mjs';
import { validateVirtualMicReleaseEmitter, VIRTUAL_MIC_RELEASE_TIMELINE } from './virtual-mic-release-evidence.mjs';
import { revalidateFrozenVirtualMicAuthority } from './frozen-virtual-mic-release-authority.mjs';
import { parseVirtualMicReleaseArgs } from './run-virtual-mic-release-evidence.mjs';
test('explicit frozen authority CLI seam', () => {
  assert.equal(parseVirtualMicReleaseArgs(['--runtime-authority', 'a.json']).runtimeAuthority, 'a.json');
  assert.equal(parseVirtualMicReleaseArgs([]).runtimeAuthority, undefined);
});

// Real full inventory/digest/keypair verification. Synthetic Git, certificate,
// AEC and capture bytes are NOT production capture or certification evidence.
const provenance = { schemaVersion: 1, source: 'git', captureStatus: 'captured', headCommit: 'a'.repeat(40), worktreeClean: true, dirtyEntryCount: 0 };
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmic-frozen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => {
    const target = path.resolve(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    return target;
  };
  for (const name of [...AUTHORITY_IMPLEMENTATION_FILES, ...AUTHORITY_RUNTIME_BINARY_FILES]) put(name, 'fixture:' + name);
  for (const name of ['run-virtual-mic-release-evidence.mjs', 'virtual-mic-release-evidence.mjs', 'frozen-virtual-mic-release-authority.mjs']) {
    put('scripts/testing/' + name, fs.readFileSync(new URL(name, import.meta.url)));
  }
  const base = 'artifacts/testing/watch-mode-strict-runtime/fixture/';
  const keys = generateCoordinatorSigningKeyPair();
  const entry = (name, value) => fileAuthorityEntry(put(base + name, value), name);
  const authority = {
    schemaVersion: 1, artifactKind: 'watch-mode-strict-runtime-authority', releaseId: 'fixture', provenance,
    implementationHashes: currentAuthorityImplementationHashes({ workspaceRoot: root }),
    runtimeBinaryHashes: currentAuthorityRuntimeBinaryHashes({ workspaceRoot: root }),
    certificate: { keyAlgorithm: 'RSA', keyLength: 3072, hashAlgorithm: 'SHA256', enhancedKeyUsage: 'Code Signing', signingMode: 'local-self-signed', trustScope: 'vmware-testsigning-only', publicProductionTrust: false,
      certificateAuthority: entry('cert.cer', fs.readFileSync(path.join(root, 'drivers/windows-virtual-mic/package/omni-translate-development-driver.cer'))) },
    coordinatorSigning: { algorithm: 'Ed25519', keyId: coordinatorKeyIdForPublicKey(keys.publicKeyPem), publicKeyAuthority: entry('public.pem', keys.publicKeyPem), privateKeyAuthority: entry('private.pem', keys.privateKeyPem) },
    aec3Gate: { verdict: 'passed', authority: entry('aec.log', 'synthetic gate') },
  };
  authority.authorityDigest = crypto.createHash('sha256').update(JSON.stringify(canonical(authority))).digest('hex');
  const runtimeAuthority = put(base + 'strict-runtime-authority.json', authority);
  const plan = () => buildVirtualMicReleasePlan({ workspaceRoot: root, provenance, runtimeAuthority });
  let builds = 0, captures = 0, packages = 0;
  const run = (p, { atProbe = () => {}, atReturn = () => {}, atPackage = () => {}, readProvenance = () => provenance, allowBuild = false } = {}) => runVirtualMicReleaseEvidence({
    plan: p, provenanceReader: readProvenance,
    build: () => { builds++; if (!allowBuild) throw new Error('forbidden build'); return { status: 0 }; },
    probeBuildCommit: () => { atProbe(); return { status: 0, stdout: provenance.headCommit }; },
    runCollector: () => {
      captures++;
      const probe = { parentCollectorProcessId: 101, bridgeProcessId: 102, captureChildProcessId: 103, bridgeInstanceId: 'instance', bridgeSessionId: 'session', captureEndpointId: 'endpoint', captureEndpointName: 'fixture', cueId: 'cue', rawCountersBefore: {}, rawCountersAfter: {} };
      for (const name of ['virtual-mic-capture-probe.json', 'runtime-snapshot.json']) put(path.join(p.runDirectory, name), probe);
      put(path.join(p.runDirectory, 'virtual-mic-capture.wav'), 'synthetic wav');
      atReturn();
      return { pid: 101, status: 0, stdout: JSON.stringify({ passed: true, cueId: 'cue', captureEndpointId: 'endpoint' }) };
    },
    collect: (options) => { packages++; atPackage(options); return { packageDirectory: 'fixture-package', manifestPath: 'fixture-manifest' }; },
  });
  const validate = (p) => validateVirtualMicReleaseEmitter(p.runDirectory, { workspaceRoot: root, implementationRoot: root, currentProvenance: provenance });
  return { root, put, authority, runtimeAuthority, plan, run, validate, counts: () => ({ builds, captures, packages }) };
}

test('frozen positive: real authority verifier, exact timeline, public binding, zero build', async (t) => {
  const f = fixture(t), p = f.plan();
  const before = fs.readFileSync(p.bridgeExecutable);
  await f.run(p, { atPackage(options) { assert.deepEqual(options.frozenVirtualMicRuntime, p.frozenVirtualMicRuntime); } });
  assert.deepEqual(f.counts(), { builds: 0, captures: 1, packages: 1 });
  assert.deepEqual(fs.readFileSync(p.bridgeExecutable), before);
  assert.deepEqual(f.validate(p).issues, []);
  const result = f.validate(p).result;
  assert.equal(result.runtimeMode, 'frozen');
  assert.deepEqual(result.frozenVirtualMicRuntime, p.frozenVirtualMicRuntime);
  assert.equal(result.timeline.some((e) => e.event.startsWith('build-')), false);
  f.put('target/release/omni-bridge-service.exe', 'same commit, changed bytes');
  assert.match(f.validate(p).issues.join(' '), /frozen.*inventory/i);
});

test('explicit invalid authority and full inventory/clean HEAD failures are closed', (t) => {
  const f = fixture(t);
  for (const runtimeAuthority of ['', null, false, 'missing.json']) {
    assert.throws(() => buildVirtualMicReleasePlan({ workspaceRoot: f.root, provenance, runtimeAuthority }));
  }
  for (const changed of [{ ...provenance, worktreeClean: false, dirtyEntryCount: 1 }, { ...provenance, headCommit: 'b'.repeat(40) }]) {
    assert.throws(() => buildVirtualMicReleasePlan({ workspaceRoot: f.root, provenance: changed, runtimeAuthority: f.runtimeAuthority }));
  }
  f.put(AUTHORITY_IMPLEMENTATION_FILES[0], 'changed implementation');
  assert.throws(f.plan, /implementation inventory/);
  assert.deepEqual(f.counts(), { builds: 0, captures: 0, packages: 0 });
});

for (const stage of ['launch', 'probe', 'return', 'package']) test('drift at ' + stage + ' fails closed', async (t) => {
  const f = fixture(t), p = f.plan();
  const drift = () => f.put('target/release/omni-virtual-mic-target-capture.exe', 'changed');
  if (stage === 'launch') drift();
  await assert.rejects(f.run(p, { atProbe: stage === 'probe' ? drift : undefined, atReturn: stage === 'return' ? drift : undefined, atPackage: stage === 'package' ? drift : undefined }), /inventory|binding/);
  assert.equal(f.counts().builds, 0);
  assert.equal(f.counts().captures, ['launch', 'probe'].includes(stage) ? 0 : 1);
  assert.equal(f.counts().packages, stage === 'package' ? 1 : 0);
  assert.equal(fs.existsSync(p.runDirectory), true);
  const failure = JSON.parse(fs.readFileSync(path.join(p.runDirectory, 'release-failure.json'), 'utf8'));
  assert.equal(failure.verdict, 'failed');
  assert.equal(failure.invocationId, p.invocationId);
  const expectedRuntimeRoot = path.resolve(os.tmpdir(), 'omni-vmic-release-' + p.invocationId);
  assert.equal(path.resolve(failure.runtimeRoot), expectedRuntimeRoot);
  assert.ok(expectedRuntimeRoot.startsWith(path.resolve(os.tmpdir()) + path.sep));
  if (['return', 'package'].includes(stage)) assert.equal(fs.existsSync(expectedRuntimeRoot), true);
  t.after(() => fs.rmSync(expectedRuntimeRoot, { recursive: true, force: true }));
  if (stage === 'package') assert.match(f.validate(p).issues.join(' '), /retained failure evidence/);
});

test('validator rejects forged mode, build timeline and either binary binding', async (t) => {
  const f = fixture(t), p = f.plan();
  await f.run(p);
  const original = f.validate(p).result;
  for (const mutate of [
    (r) => { delete r.frozenVirtualMicRuntime; },
    (r) => { delete r.runtimeMode; },
    (r) => { r.timeline.forEach((e, i) => { e.event = VIRTUAL_MIC_RELEASE_TIMELINE[i]; }); },
    (r) => { r.binaries.bridge.sha256 = '0'.repeat(64); },
    (r) => { r.binaries.collector.sha256 = '0'.repeat(64); },
    (r) => { r.frozenVirtualMicRuntime.authorityDigest = '0'.repeat(64); },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    f.put(path.join(p.runDirectory, 'emitter-result.json'), changed);
    assert.ok(f.validate(p).issues.length > 0);
  }
});

test('helper rejects digest/key material drift and live dirty provenance', (t) => {
  const f = fixture(t), p = f.plan();
  assert.throws(() => revalidateFrozenVirtualMicAuthority(p.frozenVirtualMicRuntime, { workspaceRoot: f.root, provenance: { ...provenance, worktreeClean: false, dirtyEntryCount: 1 } }));
  f.put(path.join(path.dirname(f.runtimeAuthority), 'private.pem'), 'changed key');
  assert.throws(f.plan, /artifact changed/);
  f.put(f.runtimeAuthority, { ...f.authority, authorityDigest: '0'.repeat(64) });
  assert.throws(f.plan, /digest mismatch/);
});

test('legacy builder still removes stale canonical files and requests release build', (t) => {
  const f = fixture(t);
  const p = buildVirtualMicReleasePlan({ workspaceRoot: f.root, provenance });
  assert.equal(p.frozenVirtualMicRuntime, undefined);
  const result = buildCurrentVirtualMicBinaries(p, { run(command, args) {
    assert.equal(command, 'cargo');
    assert.deepEqual(args.slice(0, 3), ['build', '--locked', '--release']);
    assert.equal(fs.existsSync(p.bridgeExecutable), false);
    assert.equal(fs.existsSync(p.collectorExecutable), false);
    return { status: 0 };
  } });
  assert.equal(result.status, 0);
  for (const flag of ['--skip', '--source', '--bridge-executable', '--cargo-target-dir']) {
    assert.throws(() => parseVirtualMicReleaseArgs([flag, 'x']), /Unknown flag/);
  }
});

test('legacy runner keeps build timeline and omits frozen bindings', async (t) => {
  const f = fixture(t);
  const p = buildVirtualMicReleasePlan({ workspaceRoot: f.root, provenance });
  await f.run(p, { allowBuild: true, atPackage(options) {
    assert.equal(Object.hasOwn(options, 'frozenVirtualMicRuntime'), false);
  } });
  const checked = f.validate(p);
  assert.deepEqual(checked.issues, []);
  assert.deepEqual(checked.result.timeline.map((e) => e.event), VIRTUAL_MIC_RELEASE_TIMELINE);
  assert.equal(Object.hasOwn(checked.result, 'frozenVirtualMicRuntime'), false);
  assert.equal(Object.hasOwn(checked.result, 'runtimeMode'), false);
  assert.deepEqual(f.counts(), { builds: 1, captures: 1, packages: 1 });
});

test('clean HEAD rechecked after collector returns, before packaging', async (t) => {
  const f = fixture(t), p = f.plan();
  let current = provenance;
  await assert.rejects(f.run(p, {
    readProvenance: () => current,
    atReturn: () => { current = { ...provenance, worktreeClean: false, dirtyEntryCount: 1 }; },
  }), /clean|provenance/i);
  assert.deepEqual(f.counts(), { builds: 0, captures: 1, packages: 0 });
});
