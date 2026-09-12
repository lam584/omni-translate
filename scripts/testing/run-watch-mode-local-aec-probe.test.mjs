import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repoRoot } from '../lib/testing-common.mjs';
import { AUTHORITY_RUNTIME_BINARY_FILES } from './watch-mode-evidence-authority.mjs';
import { LOCAL_ISOLATION_DISTRIBUTION_KIND } from './watch-mode-local-isolation-distributed.mjs';
import { AEC_TAP_FILES, verifyAecTapEvidence } from './watch-mode-aec-tap-evidence.mjs';
import { AEC_PROBE_CAPABILITY_ID, AEC_PROBE_JOB_HELPER, localAecProbePowerShell, parseLocalAecProbeArgs, runLocalAecProbe, verifyLocalAecProbeRuntime } from './run-watch-mode-local-aec-probe.mjs';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;
const json = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
const endpoint = '{0.0.0.00000000}.{ff6138b0-3914-409e-90cd-04f03dbba46e}';
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-aec-test-'));
  t.after(() => {
    // Delete only the exact directory created by this test, never a computed
    // runtime/output ancestor or a followed junction.
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^local-aec-test-/u);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function runtimeFixture(root, desktopBytes = Buffer.from(`fixture-not-executable:${AEC_PROBE_CAPABILITY_ID}`)) {
  const files = AUTHORITY_RUNTIME_BINARY_FILES.map((name, index) => {
    const bytes = index === 0 ? desktopBytes : Buffer.from(`fixture-${index}`);
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return { path: name, bytes: bytes.length, sha256: hash(bytes) };
  });
  const helperBytes = fs.readFileSync(path.join(repoRoot, AEC_PROBE_JOB_HELPER));
  fs.mkdirSync(path.dirname(path.join(root, AEC_PROBE_JOB_HELPER)), { recursive: true });
  fs.writeFileSync(path.join(root, AEC_PROBE_JOB_HELPER), helperBytes);
  files.push({ path: AEC_PROBE_JOB_HELPER, bytes: helperBytes.length, sha256: hash(helperBytes) });
  const core = { schemaVersion: 1, artifactKind: LOCAL_ISOLATION_DISTRIBUTION_KIND, files };
  return sealRuntime(root, core);
}
function sealRuntime(root, manifest) {
  const core = { ...manifest };
  delete core.distributionDigest;
  const result = { ...core, distributionDigest: hash(JSON.stringify(canonicalize(core))) };
  json(path.join(root, 'runtime-distribution.json'), result);
  return result;
}
function eventsFixture() {
  return [
    { schemaVersion: 2, kind: 'render-reference', sequence: 0, resetGeneration: 0, continuityId: 1,
      qpc100ns: 10000, renderSessionId: 1, submittedFrames: 1, endpointPaddingFrames: 0,
      sampleRateHz: 48000, channelCount: 2, sampleOffset: 0, sampleCount: 2 },
    { schemaVersion: 2, kind: 'capture', sequence: 1, resetGeneration: 0, continuityId: 1,
      packetDeviceFrameIndex: 5, packetQpc100ns: 10100, rawPacketDeviceFrameIndex: 5, rawPacketQpc100ns: 10100,
      queueHeadDeviceFrameIndex: 5, queueHeadQpc100ns: 10100, timestampError: false,
      dataDiscontinuity: false, queueHeadClockValid: true, observedQpc100ns: 10200, delaySamples: 0,
      sampleRateHz: 48000, channelCount: 2, preSampleOffset: 0, preSampleCount: 2, postSampleOffset: 0, postSampleCount: 2 },
    { schemaVersion: 2, kind: 'reset', sequence: 2, resetGeneration: 1, continuityId: 2,
      qpc100ns: 10300, reason: 'diagnostic-fixture' },
  ];
}
function sealTap(root, events = eventsFixture(), sampleCounts = { render: 2, pre: 2, post: 2 }) {
  const files = Object.fromEntries(Object.entries(AEC_TAP_FILES).map(([lane, name]) => {
    const bytes = lane === 'metadata' ? Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n') : Buffer.alloc(sampleCounts[lane] * 4);
    if (lane !== 'metadata') { bytes.writeFloatLE(0.1, 0); bytes.writeFloatLE(-0.1, 4); }
    fs.writeFileSync(path.join(root, name), bytes);
    return [lane, { name, byteLength: bytes.length, sha256: hash(bytes), flushed: true, synced: true, unwrittenBufferedBytes: 0 }];
  }));
  const terminal = { schemaVersion: 2, kind: 'terminal', status: 'complete', complete: true, countsFinal: true,
    attemptedEvents: 3, acceptedEvents: 3, writtenEvents: 3, droppedEvents: 0,
    eventCounts: { render: 1, capture: 1, reset: 1 }, sampleCounts,
    invalidClockEvents: events.filter((e) => e.kind === 'capture' && (e.timestampError || !e.queueHeadClockValid)).length,
    lastWrittenSequence: 2, lastAttemptedSequence: 2, resetGeneration: 1,
    files, errors: [], hashAlgorithm: 'sha256', terminalFile: 'aec-terminal.json' };
  json(path.join(root, 'aec-terminal.json'), terminal);
  return terminal;
}
function resealMetadata(root, terminal, bytes) {
  fs.writeFileSync(path.join(root, AEC_TAP_FILES.metadata), bytes);
  terminal.files.metadata.byteLength = bytes.length;
  terminal.files.metadata.sha256 = hash(bytes);
  json(path.join(root, 'aec-terminal.json'), terminal);
}

test('runtime is explicit, digest-bound, complete and byte-verified', (t) => {
  const root = temporary(t);
  const manifest = runtimeFixture(root);
  assert.equal(verifyLocalAecProbeRuntime(root, manifest.distributionDigest).root, fs.realpathSync.native(root));
  assert.throws(() => verifyLocalAecProbeRuntime(root, null), /digest is required/u);
  assert.throws(() => verifyLocalAecProbeRuntime(root, '0'.repeat(64)), /explicitly selected/u);
  fs.appendFileSync(path.join(root, manifest.files[1].path), 'tampered');
  assert.throws(() => verifyLocalAecProbeRuntime(root, manifest.distributionDigest), /changed/u);
});
for (const [label, change, expected] of [
  ['forged digest', (m) => { m.files[0].sha256 = '0'.repeat(64); }, /digest mismatch/u],
  ['wrong artifact kind', (m) => { m.artifactKind = 'invented'; }, /manifest is invalid/u],
  ['missing binary', (m) => { m.files.splice(1, 1); }, /incomplete 15-file/u],
  ['missing custody helper', (m) => { m.files.pop(); }, /does not freeze/u],
  ['duplicate path', (m) => { m.files.push({ ...m.files[0] }); }, /duplicate/u],
  ['traversal', (m) => { m.files[0].path = '../outside'; }, /unsafe/u],
  ['absolute path', (m) => { m.files[0].path = 'C:/outside'; }, /unsafe/u],
]) {
  test(`runtime rejects ${label}`, (t) => {
    const root = temporary(t);
    let manifest = runtimeFixture(root);
    change(manifest);
    if (label !== 'forged digest') manifest = sealRuntime(root, manifest);
    else json(path.join(root, 'runtime-distribution.json'), manifest);
    assert.throws(() => verifyLocalAecProbeRuntime(root, manifest.distributionDigest), expected);
  });
}

test('tap verifies all four streams without claiming audio health or release', (t) => {
  const root = temporary(t);
  const terminal = sealTap(root);
  const receipt = verifyAecTapEvidence(root, terminal);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.releaseEligible, false);
  assert.equal(receipt.audioHealth, 'not-evaluated');
});
test('invalid clocks and recoverable discontinuity remain evidence, not a false completion failure', (t) => {
  const root = temporary(t);
  const events = eventsFixture();
  Object.assign(events[1], { timestampError: true, queueHeadClockValid: false, dataDiscontinuity: true,
    packetDeviceFrameIndex: null, packetQpc100ns: null, queueHeadDeviceFrameIndex: null, queueHeadQpc100ns: null });
  const terminal = sealTap(root, events);
  assert.equal(verifyAecTapEvidence(root, terminal).invalidClockEvents, 1);
});
for (const [label, change] of [
  ['not final', (t) => { t.countsFinal = false; }],
  ['dropped tail', (t) => { t.droppedEvents = 1; t.attemptedEvents += 1; }],
  ['unwritten tail', (t) => { t.acceptedEvents += 1; }],
  ['flush error', (t) => { t.files.post.flushed = false; }],
  ['sync error', (t) => { t.files.pre.synced = false; }],
  ['buffered tail', (t) => { t.files.render.unwrittenBufferedBytes = 4; }],
  ['writer error', (t) => { t.errors.push('write failed'); }],
  ['fake name', (t) => { t.files.render.name = '../outside'; }],
  ['fake hash', (t) => { t.files.post.sha256 = 'a'.repeat(64); }],
  ['false sample count', (t) => { t.sampleCounts.pre += 2; }],
  ['false event count', (t) => { t.eventCounts.capture += 1; }],
  ['false final sequence', (t) => { t.lastWrittenSequence += 1; }],
  ['false attempted sequence', (t) => { t.lastAttemptedSequence = 888; }],
  ['missing attempted sequence', (t) => { delete t.lastAttemptedSequence; }],
  ['false terminal generation', (t) => { t.resetGeneration = 999; }],
  ['missing terminal generation', (t) => { delete t.resetGeneration; }],
]) {
  test(`tap rejects ${label}`, (context) => {
    const root = temporary(context);
    const terminal = sealTap(root);
    change(terminal);
    json(path.join(root, 'aec-terminal.json'), terminal);
    assert.throws(() => verifyAecTapEvidence(root, terminal), /AEC tap evidence invalid/u);
  });
}
for (const [label, change] of [
  ['duplicate delivery', (e) => { e[1].sequence = 0; }],
  ['out of order', (e) => { [e[0], e[1]] = [e[1], e[0]]; }],
  ['uncovered PCM span', (e) => { e[1].preSampleOffset = 2; }],
  ['half stereo frame', (e) => { e[0].sampleCount = 1; }],
  ['clock promoted despite timestamp error', (e) => { e[1].timestampError = true; }],
  ['clock raw value mismatch', (e) => { e[1].rawPacketQpc100ns += 1; }],
  ['reset generation jump', (e) => { e[1].resetGeneration = 123; }],
  ['reset generation regression', (e) => { e[2].resetGeneration = 0; }],
]) {
  test(`metadata rejects ${label} even with consistent file hashes`, (t) => {
    const root = temporary(t);
    const events = eventsFixture(); change(events);
    const terminal = sealTap(root, events);
    assert.throws(() => verifyAecTapEvidence(root, terminal), /AEC tap evidence invalid/u);
  });
}
test('half UTF8, a truncated last line, uncommitted terminal, and a swapped receipt cannot complete', (t) => {
  const root = temporary(t);
  let terminal = sealTap(root);
  resealMetadata(root, terminal, Buffer.from([0xe4, 0xb8, 0x0a]));
  assert.throws(() => verifyAecTapEvidence(root, terminal), /encoded data/u);
  terminal = sealTap(root);
  const metadata = fs.readFileSync(path.join(root, AEC_TAP_FILES.metadata));
  resealMetadata(root, terminal, metadata.subarray(0, -1));
  assert.throws(() => verifyAecTapEvidence(root, terminal), /truncated metadata/u);
  terminal = sealTap(root);
  fs.writeFileSync(path.join(root, 'aec-terminal.json.partial'), 'uncommitted');
  assert.throws(() => verifyAecTapEvidence(root, terminal), /uncommitted/u);
  fs.unlinkSync(path.join(root, 'aec-terminal.json.partial'));
  assert.throws(() => verifyAecTapEvidence(root, { ...terminal, status: 'failed' }), /differs/u);
});

function probeOptions(root, manifest) {
  const pcm = path.join(root, 'stimulus.pcm');
  fs.writeFileSync(pcm, Buffer.from([1, 0, 255, 255]));
  return { runtimeRoot: root, distributionDigest: manifest.distributionDigest, outputParent: root,
    renderPcmPath: pcm, physicalDeviceId: endpoint, workspaceRoot: repoRoot, timeoutSeconds: 30 };
}
function fixtureExecute(_script, { outputDirectory, request }) {
  const sourcePcmFrames = fs.statSync(request.renderPcmPath).size / 2;
  const renderedFrames = (sourcePcmFrames + 16_000) * 3;
  const events = eventsFixture();
  Object.assign(events[0], { sampleCount: renderedFrames * 2, submittedFrames: renderedFrames });
  Object.assign(events[1], { preSampleCount: 1920, postSampleCount: 1920 });
  const tap = sealTap(outputDirectory, events, { render: renderedFrames * 2, pre: 1920, post: 1920 });
  json(path.join(outputDirectory, 'local-aec-probe-result.json'), { schemaVersion: 1,
    artifactKind: 'watch-mode-local-aec-probe', executionId: request.executionId, status: 'completed',
    probeCapabilityId: AEC_PROBE_CAPABILITY_ID,
    sourcePcmFrames, stimulusPreambleFrames: 16_000, stimulusSampleRateHz: 16_000,
    stimulusChannelCount: 1, stimulusFrames: sourcePcmFrames + 16_000,
    requestedConfig: { providers: [], devices: { feedbackLoopPrevention: 'echo-cancel', aecEnabled: true,
      outputDeviceId: request.physicalDeviceId,
      inboundRoute: { routeId: 'audio-route-inbound-watch', input: { deviceId: request.physicalDeviceId } } } },
    render: { renderedFrames, sampleRateHz: 48_000, channelCount: 2, deviceId: request.physicalDeviceId,
      requestedDeviceId: request.physicalDeviceId, effectiveDeviceId: request.physicalDeviceId,
      sourcePcmFrames, stimulusFrames: sourcePcmFrames + 16_000, stimulusPreambleFrames: 16_000,
      stimulusSampleRateHz: 16_000, stimulusChannelCount: 1,
      rendererInstanceId: 'fixture-owned-renderer', ownerGeneration: 1 },
    capture: { direction: 'inbound', requestedDeviceId: request.physicalDeviceId, effectiveDeviceId: request.physicalDeviceId,
      routeId: 'audio-route-inbound-watch', countsFinal: true, sampleRateHz: 48_000, channelCount: 2,
      framesCaptured: 960, captureState: 'idle', streamBound: false, lastError: null, lastErrorCode: null },
    providerCalls: 0, releaseEligible: false, recognitionSenderAttached: false,
    sourcePcmSha256: request.renderPcmSha256, tap });
  return { exitCode: 0, ownedJobExited: true };
}
test('runner binds stimulus, fresh execution, process custody and complete tap without authorizing release', async (t) => {
  const root = temporary(t);
  const options = probeOptions(root, runtimeFixture(root));
  const first = await runLocalAecProbe(options, { execute: fixtureExecute });
  const second = await runLocalAecProbe(options, { execute: fixtureExecute });
  assert.notEqual(first.executionId, second.executionId);
  assert.equal(first.tapIntegrity.complete, true);
  assert.equal(first.providerCalls, 0);
  assert.equal(first.releaseEligible, false);
});
test('runner always preserves failure JSON, including unknown custody, missing tap and invalid endpoints', async (t) => {
  const root = temporary(t);
  const options = probeOptions(root, runtimeFixture(root));
  for (const [execute, expectedCalls, expectedAccounting, expectedCustody] of [
    [() => { throw new Error('launcher failed'); }, null, 'unknown', false],
    [() => ({ exitCode: 0, ownedJobExited: false }), null, 'unknown', false],
    [(s, c) => { fixtureExecute(s, c); fs.appendFileSync(path.join(c.outputDirectory, AEC_TAP_FILES.post), 'tail'); return { exitCode: 0, ownedJobExited: true }; },
      0, 'unverified-producer-report', true],
  ]) {
    await assert.rejects(runLocalAecProbe(options, { execute }), (error) => {
      const result = JSON.parse(fs.readFileSync(path.join(error.outputDirectory, 'result.json'), 'utf8'));
      assert.equal(result.status, 'failed'); assert.equal(result.releaseEligible, false);
      assert.equal(result.providerCalls, expectedCalls);
      assert.equal(result.providerAccounting, expectedAccounting);
      assert.equal(result.ownedJobExited, expectedCustody);
      assert.ok(result.failure); return true;
    });
  }
  await assert.rejects(runLocalAecProbe({ ...options, physicalDeviceId: 'default' }), /exact physical/u);
});
test('launcher scrubs normal/paid diagnostics and uses an owned bounded job, never a PID cleanup', () => {
  const script = localAecProbePowerShell({ runtime: { executable: 'E:\\runtime\\shell.exe', executableSha256: 'a'.repeat(64), root: 'E:\\runtime' },
    outputDirectory: 'E:\\probe', requestPath: "E:\\probe's\\request.json", deadlineUtc: '2026-09-12T00:00:30Z', workspaceRoot: repoRoot });
  assert.match(script, /SetEnvironmentVariable\(\$variable.Name,\$null,'Process'\)/u);
  assert.match(script, /OMNI_WATCH_MODE_LOCAL_AEC_PROBE_REQUEST='E:\\probe''s/u);
  assert.match(script, /OmniInteractiveFinalizerJob\]::Run/u);
  assert.doesNotMatch(script, /taskkill|Stop-Process|Start-Process/u);
});
test('zero-Provider native job integration cannot turn clean process exit into fabricated AEC evidence', { skip: process.platform !== 'win32', timeout: 45_000 }, async (t) => {
  const root = temporary(t);
  // Node (stdin=NUL), not Desktop: exercise the real suspended launch, native
  // job, output drain and PowerShell sanitizer without audio or Provider I/O.
  // The overlay is synthetic test capability evidence for a Node stand-in,
  // never a signed runtime or an authorization for real Desktop/Provider I/O.
  const options = probeOptions(root, runtimeFixture(root, Buffer.concat([fs.readFileSync(process.execPath), Buffer.from(AEC_PROBE_CAPABILITY_ID)])));
  await assert.rejects(runLocalAecProbe(options), (error) => {
    const receipt = JSON.parse(fs.readFileSync(path.join(error.outputDirectory, 'result.json'), 'utf8'));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.ownedJobExited, true, receipt.failure);
    assert.equal(receipt.providerCalls, null);
    assert.equal(receipt.providerAccounting, 'unknown');
    assert.match(receipt.failure, /local-aec-probe-result.json/u);
    return true;
  });
});
test('unsupported but hash-valid runtime is rejected before any normal launch', async (t) => {
  const root = temporary(t);
  const options = probeOptions(root, runtimeFixture(root, Buffer.from('old-desktop-with-no-opt-in-support')));
  let launches = 0;
  await assert.rejects(runLocalAecProbe(options, { execute: () => { launches += 1; } }), (error) => {
    assert.match(error.message, /lacks the compiled zero-Provider/u);
    const receipt = JSON.parse(fs.readFileSync(path.join(error.outputDirectory, 'result.json'), 'utf8'));
    assert.equal(receipt.providerCalls, 0);
    assert.equal(receipt.providerAccounting, 'not-launched');
    return true;
  });
  assert.equal(launches, 0);
});
for (const [label, bytes] of [
  ['obsolete capability', Buffer.from(AEC_PROBE_CAPABILITY_ID.replace('/v1/', '/v0/'))],
  ['truncated capability', Buffer.from(AEC_PROBE_CAPABILITY_ID.slice(0, -1))],
]) {
  test(`runtime rejects ${label} without interrogating its executable`, async (t) => {
    const root = temporary(t);
    const options = probeOptions(root, runtimeFixture(root, bytes));
    await assert.rejects(runLocalAecProbe(options, {
      execute: () => assert.fail('unsupported capability must fail before executable launch'),
    }), (error) => {
      assert.match(error.message, /lacks the compiled zero-Provider/u);
      const result = JSON.parse(fs.readFileSync(path.join(error.outputDirectory, 'result.json'), 'utf8'));
      assert.equal(result.providerCalls, 0);
      assert.equal(result.providerAccounting, 'not-launched');
      assert.equal(result.ownedJobExited, false);
      return true;
    });
  });
}
test('disk floor failure happens before any probe launch and remains a recorded not-launched failure', async (t) => {
  const root = temporary(t);
  const options = probeOptions(root, runtimeFixture(root));
  let launches = 0;
  await assert.rejects(runLocalAecProbe(options, { checkDiskSpace: () => { throw new Error('C: below 3 GiB'); },
    execute: () => { launches += 1; } }), (error) => {
    const receipt = JSON.parse(fs.readFileSync(path.join(error.outputDirectory, 'result.json'), 'utf8'));
    assert.match(receipt.failure, /below 3 GiB/u);
    assert.equal(receipt.providerAccounting, 'not-launched');
    assert.equal(receipt.providerCalls, 0);
    return true;
  });
  assert.equal(launches, 0);
});
test('failure preserves contradictory producer accounting instead of silently resetting it to zero', async (t) => {
  const root = temporary(t);
  const options = probeOptions(root, runtimeFixture(root));
  await assert.rejects(runLocalAecProbe(options, { execute: (script, context) => {
    const result = fixtureExecute(script, context);
    const file = path.join(context.outputDirectory, 'local-aec-probe-result.json');
    const producer = JSON.parse(fs.readFileSync(file, 'utf8'));
    producer.providerCalls = 2; json(file, producer);
    return result;
  } }), (error) => {
    const receipt = JSON.parse(fs.readFileSync(path.join(error.outputDirectory, 'result.json'), 'utf8'));
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.providerCalls, 2);
    assert.equal(receipt.providerAccounting, 'unverified-producer-report');
    return true;
  });
});
for (const [label, change, expectedCalls, expectedObserved] of [
  ['nonzero report before launcher failure', (p) => { p.providerCalls = 3; }, 3, 3],
  ['missing reported count', (p) => { delete p.providerCalls; }, null, null],
  ['negative reported count', (p) => { p.providerCalls = -1; }, null, -1],
  ['fractional reported count', (p) => { p.providerCalls = 0.5; }, null, 0.5],
  ['string reported count', (p) => { p.providerCalls = '0'; }, null, '0'],
  ['unsafe reported count', (p) => { p.providerCalls = Number.MAX_SAFE_INTEGER + 1; }, null, Number.MAX_SAFE_INTEGER + 1],
  ['foreign execution report', (p) => { p.executionId = 'local-aec-foreign'; p.providerCalls = 7; }, null, 7],
]) {
  test(`runner preserves unknown or nonzero accounting for ${label}`, async (t) => {
    const root = temporary(t);
    const options = probeOptions(root, runtimeFixture(root));
    await assert.rejects(runLocalAecProbe(options, { execute: (script, context) => {
      fixtureExecute(script, context);
      const file = path.join(context.outputDirectory, 'local-aec-probe-result.json');
      const producer = JSON.parse(fs.readFileSync(file, 'utf8'));
      change(producer); json(file, producer);
      throw new Error('native launcher failure after producer commit');
    } }), (error) => {
      const result = JSON.parse(fs.readFileSync(path.join(error.outputDirectory, 'result.json'), 'utf8'));
      assert.equal(result.status, 'failed');
      assert.equal(result.providerCalls, expectedCalls);
      assert.equal(result.providerAccounting, expectedCalls === null ? 'unknown' : 'unverified-producer-report');
      assert.equal(result.observedProducerAccounting.providerCalls, expectedObserved);
      assert.equal(result.ownedJobExited, false);
      assert.equal(result.releaseEligible, false);
      return true;
    });
  });
}
for (const [label, change] of [
  ['missing producer capability', (p) => { delete p.probeCapabilityId; }],
  ['wrong producer capability', (p) => { p.probeCapabilityId = 'obsolete'; }],
  ['different source hash', (p) => { p.sourcePcmSha256 = '0'.repeat(64); }],
]) {
  test(`runner rejects ${label} despite otherwise consistent sealed evidence`, async (t) => {
    const root = temporary(t);
    const options = probeOptions(root, runtimeFixture(root));
    await assert.rejects(runLocalAecProbe(options, { execute: (script, context) => {
      const result = fixtureExecute(script, context);
      const file = path.join(context.outputDirectory, 'local-aec-probe-result.json');
      const producer = JSON.parse(fs.readFileSync(file, 'utf8'));
      change(producer); json(file, producer); return result;
    } }), /evidence is missing, incomplete, or mismatched/u);
  });
}
for (const [label, change] of [
  ['missing render', (p) => { delete p.render; }],
  ['missing capture', (p) => { delete p.capture; }],
  ['wrong render endpoint', (p) => { p.render.deviceId = 'wrong'; }],
  ['wrong capture endpoint', (p) => { p.capture.effectiveDeviceId = 'wrong'; }],
  ['wrong requested render endpoint', (p) => { p.render.requestedDeviceId = 'wrong'; }],
  ['wrong effective render endpoint', (p) => { p.render.effectiveDeviceId = 'wrong'; }],
  ['wrong requested capture endpoint', (p) => { p.capture.requestedDeviceId = 'wrong'; }],
  ['capture error', (p) => { p.capture.lastError = 'capture never started'; }],
  ['empty render', (p) => { p.render.renderedFrames = 0; }],
  ['empty capture', (p) => { p.capture.framesCaptured = 0; }],
  ['unfinished capture', (p) => { p.capture.captureState = 'capturing'; }],
  ['recognition bound', (p) => { p.capture.streamBound = true; }],
  ['unmatched capture count', (p) => { p.capture.framesCaptured += 1; }],
  ['unmatched source count', (p) => { p.sourcePcmFrames += 1; }],
  ['prefinal capture counts', (p) => { p.capture.countsFinal = false; }],
  ['wrong capture format', (p) => { p.capture.sampleRateHz = 16_000; }],
  ['missing render owner', (p) => { delete p.render.ownerGeneration; }],
  ['wrong stimulus preamble', (p) => { p.render.stimulusPreambleFrames = 0; }],
  ['mismatched capture route', (p) => { p.capture.routeId = 'another-route'; }],
  ['wrong route config', (p) => { p.requestedConfig.devices.feedbackLoopPrevention = 'process-exclusion'; }],
  ['loaded Provider configuration', (p) => { p.requestedConfig.providers = [{ id: 'unexpected' }]; }],
]) {
  test(`runner rejects ${label} despite sealed tap evidence`, async (t) => {
    const root = temporary(t);
    const options = probeOptions(root, runtimeFixture(root));
    await assert.rejects(runLocalAecProbe(options, { execute: (script, context) => {
      const result = fixtureExecute(script, context);
      const file = path.join(context.outputDirectory, 'local-aec-probe-result.json');
      const producer = JSON.parse(fs.readFileSync(file, 'utf8')); change(producer); json(file, producer);
      return result;
    } }), /operation receipt contradicts/u);
  });
}
test('CLI rejects missing, duplicated and unknown arguments rather than inferring authority', () => {
  assert.throws(() => parseLocalAecProbeArgs([]), /runtimeRoot is required/u);
  assert.throws(() => parseLocalAecProbeArgs(['--runtime-root', 'a', '--runtime-root', 'b']), /duplicate/u);
  assert.throws(() => parseLocalAecProbeArgs(['--provider', 'qwen']), /invalid/u);
});
