import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../lib/testing-common.mjs';
import { AUTHORITY_RUNTIME_BINARY_FILES } from './watch-mode-evidence-authority.mjs';
import { LOCAL_ISOLATION_DISTRIBUTION_KIND } from './watch-mode-local-isolation-distributed.mjs';
import { AEC_TAP_FILES, verifyAecTapEvidence } from './watch-mode-aec-tap-evidence.mjs';
import { AEC_PROBE_CAPABILITY_ID, AEC_PROBE_INTERACTIVE_FILES, AEC_PROBE_JOB_HELPER, createLocalAecProbeRequest, isProviderCredentialEnvironmentName, localAecProbeDesktopPowerShell, localAecProbePowerShell, parseLocalAecProbeArgs, runLocalAecProbe, verifyLocalAecProbeRuntime } from './run-watch-mode-local-aec-probe.mjs';

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
  for (const name of AEC_PROBE_INTERACTIVE_FILES) {
    const bytes = fs.readFileSync(path.join(repoRoot, name));
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), bytes);
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
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
function fixtureExecute(_script, { outputDirectory, request, requestPath, runtime }) {
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
  const authorityRoot = path.join(outputDirectory, 'interactive', request.executionId);
  fs.mkdirSync(authorityRoot, { recursive: true });
  const commandPath = path.join(authorityRoot, 'command.json');
  const launchPath = path.join(authorityRoot, 'launch.json');
  const processAuthorityPath = path.join(authorityRoot, 'process-authority.json');
  const terminalPath = path.join(authorityRoot, 'terminal.json');
  const taskTerminalPath = path.join(authorityRoot, 'task-terminal.json');
  const requestDigest = hash(fs.readFileSync(requestPath));
  const desktop = 'WinSta0\\ProbeDesktop'; const ownerSid = 'S-1-5-21-1';
  const nodeProcess = { pid: 42, parentPid: 7, startedAt: '2026-09-12T00:00:00.000Z', imagePath: process.execPath, imageSha256: hash(fs.readFileSync(process.execPath)) };
  const nodeDesktopAuthorityPath = path.join(outputDirectory, 'node-desktop-identity.json');
  json(nodeDesktopAuthorityPath, { schemaVersion: 1, artifactKind: 'watch-mode-process-desktop-identity',
    executionId: request.executionId, planDigest: runtime.distributionDigest, leaseId: request.executionId, leaseDigest: requestDigest,
    cellId: 'local-aec-probe', workerId: 'vmfixture', vmIdentityDigest: runtime.distributionDigest, desktop, sessionId: 1,
    ownerSid, reporterParentPid: nodeProcess.pid, parentProcess: { pid: nodeProcess.pid, startedAt: nodeProcess.startedAt,
      imagePath: nodeProcess.imagePath, imageSha256: nodeProcess.imageSha256 } });
  json(path.join(outputDirectory, 'desktop-environment-audit.json'), { schemaVersion: 1,
    artifactKind: 'watch-mode-local-aec-desktop-environment-audit', credentialLikeCount: 0,
    retainedNames: ['SystemRoot','OMNI_WATCH_MODE_LOCAL_AEC_PROBE_REQUEST','OMNI_WATCH_MODE_AEC_DIAGNOSTIC_TAP_DIRECTORY'],
    injectedNames: ['OMNI_WATCH_MODE_LOCAL_AEC_PROBE_REQUEST','OMNI_WATCH_MODE_AEC_DIAGNOSTIC_TAP_DIRECTORY'] });
  const binding = { executionId: request.executionId, planDigest: runtime.distributionDigest, leaseId: request.executionId,
    leaseDigest: requestDigest, cellId: 'local-aec-probe', workerId: 'vmfixture', vmIdentityDigest: runtime.distributionDigest };
  json(commandPath, binding);
  json(launchPath, { schemaVersion: 2, artifactKind: 'watch-mode-interactive-shard-launch-authority', ...binding,
    sessionId: 1, desktop, nodeDesktop: desktop, nodeDesktopAuthorityPath,
    nodeDesktopAuthoritySha256: hash(fs.readFileSync(nodeDesktopAuthorityPath)), ownerSid, taskProcess: { pid: 7 }, nodeProcess });
  json(processAuthorityPath, { schemaVersion: 2, artifactKind: 'watch-mode-interactive-process-authority', ...binding, passed: true,
    errors: [], executionExitCode: 0, expectedSessionId: 1, expectedOwnerSid: ownerSid, rootProcessId: 42, processCount: 1,
    processes: [{ ...nodeProcess, role: 'shard-node', sessionId: 1, ownerSid }] });
  const terminal = { schemaVersion: 2, artifactKind: 'watch-mode-interactive-task-terminal', ...binding, mode: 'local-aec-probe',
    exitCode: 0, processAuthorityExitCode: 0, workerId: binding.workerId, vmIdentityDigest: binding.vmIdentityDigest };
  const taskTerminal = { schemaVersion: 2, artifactKind: 'watch-mode-interactive-scheduled-task-terminal', ...binding,
    lastTaskResult: 0, logonType: 'InteractiveToken' };
  json(terminalPath, terminal); json(taskTerminalPath, taskTerminal);
  json(path.join(authorityRoot, 'cleanup.scheduler.json'), { passed: true, taskCleanupPassed: true, processCleanup: { passed: true } });
  return { commandPath, launchPath, processAuthorityPath, terminalPath, taskTerminalPath, terminal, taskTerminal };
}
test('CLI producer request exactly matches the deny-unknown Rust consumer contract', () => {
  const request = createLocalAecProbeRequest({ executionId: 'local-aec-contract', outputDirectory: 'E:\\probe',
    renderPcmPath: 'E:\\source.pcm', renderPcmSha256: 'a'.repeat(64), physicalDeviceId: endpoint });
  assert.deepEqual(Object.keys(request).sort(), [
    'executionId', 'outputDirectory', 'physicalDeviceId', 'renderPcmPath', 'renderPcmSha256', 'schemaVersion',
  ]);
  assert.equal(Object.hasOwn(request, 'deadlineUtc'), false);
});

test('interactive local AEC resolver carries a future control-plane deadline and rejects missing or expired values', (t) => {
  const root = temporary(t);
  const outputDirectory = path.join(root, 'output'); fs.mkdirSync(outputDirectory);
  const files = Object.fromEntries(['probeRequest','desktopExecutable','finalizerHelper','desktopIdentityReporter'].map((name) => {
    const file = path.join(root, name + '.bin'); fs.writeFileSync(file, name); return [name, { file, sha256: hash(fs.readFileSync(file)) }];
  }));
  const base = { executionId: 'local-aec-resolver', probeRequestPath: files.probeRequest.file, probeRequestSha256: files.probeRequest.sha256,
    outputDirectory, desktopExecutable: files.desktopExecutable.file, desktopExecutableSha256: files.desktopExecutable.sha256,
    finalizerHelperPath: files.finalizerHelper.file, finalizerHelperSha256: files.finalizerHelper.sha256,
    desktopIdentityReporterPath: files.desktopIdentityReporter.file, desktopIdentityReporterSha256: files.desktopIdentityReporter.sha256,
    nodeDesktopAuthorityPath: path.join(outputDirectory, 'node-desktop-identity.json') };
  const modulePath = path.join(repoRoot, 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveLocalAec.psm1');
  const invoke = (payload) => {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const command = `Import-Module '${modulePath.replaceAll("'", "''")}' -Force; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json; Resolve-OmniInteractiveLocalAecFields -Payload $p | ConvertTo-Json -Compress`;
    return spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command], { encoding: 'utf8', windowsHide: true });
  };
  const deadlineUtc = new Date(Date.now() + 60_000).toISOString();
  const accepted = invoke({ ...base, deadlineUtc });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).deadlineUtc, deadlineUtc);
  for (const payload of [{ ...base }, { ...base, deadlineUtc: 'invalid' }, { ...base, deadlineUtc: '2026-09-11T00:00:00Z' }]) {
    const rejected = invoke(payload); assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /deadlineUtc|deadline is invalid or expired/u);
  }
});
test('producer failure keeps complete interactive descendant and task cleanup evidence', async (t) => {
  const root = temporary(t);
  const options = probeOptions(root, runtimeFixture(root));
  await assert.rejects(runLocalAecProbe(options, { execute: (script, context) => {
    const result = fixtureExecute(script, context);
    const receiptPath = path.join(context.outputDirectory, 'local-aec-probe-result.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.status = 'failed'; receipt.failure = 'synthetic producer failure';
    json(receiptPath, receipt);
    return result;
  } }), (error) => {
    const result = JSON.parse(fs.readFileSync(path.join(error.outputDirectory, 'result.json'), 'utf8'));
    const cleanup = JSON.parse(fs.readFileSync(path.join(error.outputDirectory, 'interactive', result.executionId, 'cleanup.scheduler.json'), 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.ownedJobExited, true);
    assert.equal(cleanup.passed, true);
    assert.equal(cleanup.taskCleanupPassed, true);
    assert.equal(cleanup.processCleanup.passed, true);
    return true;
  });
});

test('runner binds stimulus, fresh execution, process custody and complete tap without authorizing release', async (t) => {
  const root = temporary(t);
  const options = probeOptions(root, runtimeFixture(root));
  const first = await runLocalAecProbe(options, { execute: fixtureExecute });
  const second = await runLocalAecProbe(options, { execute: fixtureExecute });
  const emittedRequest = JSON.parse(fs.readFileSync(path.join(first.outputDirectory, 'request.json'), 'utf8'));
  assert.deepEqual(Object.keys(emittedRequest).sort(), [
    'executionId', 'outputDirectory', 'physicalDeviceId', 'renderPcmPath', 'renderPcmSha256', 'schemaVersion',
  ]);
  assert.equal(Object.hasOwn(emittedRequest, 'deadlineUtc'), false);
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
    [(s, c) => { const result = fixtureExecute(s, c); fs.appendFileSync(path.join(c.outputDirectory, AEC_TAP_FILES.post), 'tail'); return result; },
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
test('controller uses the existing InteractiveToken request and scheduler contracts', (t) => {
  const root = temporary(t);
  const runtime = verifyLocalAecProbeRuntime(root, runtimeFixture(root).distributionDigest);
  const script = localAecProbePowerShell({ runtime, outputDirectory: 'E:\\probe', requestPath: "E:\\probe's\\request.json",
    deadlineUtc: new Date(Date.now() + 30_000).toISOString(), workspaceRoot: root, executionId: 'local-aec-fixture' });
  assert.match(script, /mode='local-aec-probe'/u);
  assert.match(script, /Resolve-OmniInteractiveTaskRequest/u);
  assert.match(script, /Invoke-OmniInteractiveScheduledTask/u);
  assert.match(script, /requireSeparateControlPlane=\$true/u);
  assert.match(script, /expectedVmUuidBios/u);
  assert.match(script, /deadlineUtc='[^']+'/u);
  const runnerSource = fs.readFileSync(path.join(root, 'scripts/testing/run-watch-mode-local-aec-probe.mjs'), 'utf8');
  assert.match(runnerSource, /deadlineUtc: command\.deadlineUtc/u);
  assert.doesNotMatch(runnerSource, /deadlineUtc: request\.deadlineUtc/u);
  const localAecModule = fs.readFileSync(path.join(root, 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveLocalAec.psm1'), 'utf8');
  assert.match(localAecModule, /'deadlineUtc'/u);
  assert.match(fs.readFileSync(path.join(root, 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveScheduler.psm1'), 'utf8'), /LogonType Interactive/u);
  assert.doesNotMatch(script, /OMNI_WATCH_MODE_LOCAL_AEC_PROBE_REQUEST/u);
});
test('interactive custody rejects failed collectors and every authority binding substitution', async (t) => {
  const mutations = [
    (r) => { r.terminal.processAuthorityExitCode = 1; },
    (r) => { const a = JSON.parse(fs.readFileSync(r.processAuthorityPath, 'utf8')); a.artifactKind = 'wrong'; json(r.processAuthorityPath, a); },
    (r) => { const a = JSON.parse(fs.readFileSync(r.processAuthorityPath, 'utf8')); a.leaseDigest = '0'.repeat(64); json(r.processAuthorityPath, a); },
    (r) => { const a = JSON.parse(fs.readFileSync(r.processAuthorityPath, 'utf8')); a.processes[0].imageSha256 = '0'.repeat(64); json(r.processAuthorityPath, a); },
    (r) => { const a = JSON.parse(fs.readFileSync(r.launchPath, 'utf8')); a.nodeDesktopAuthoritySha256 = '0'.repeat(64); json(r.launchPath, a); },
    (r) => { const a = JSON.parse(fs.readFileSync(JSON.parse(fs.readFileSync(r.launchPath, 'utf8')).nodeDesktopAuthorityPath, 'utf8')); a.desktop = 'Other\\Desktop'; json(JSON.parse(fs.readFileSync(r.launchPath, 'utf8')).nodeDesktopAuthorityPath, a); },
    (r) => { const file = path.join(path.dirname(path.dirname(path.dirname(r.commandPath))), 'desktop-environment-audit.json'); const a = JSON.parse(fs.readFileSync(file, 'utf8')); a.credentialLikeCount = 1; json(file, a); },
  ];
  for (const mutate of mutations) {
    const root = temporary(t); const options = probeOptions(root, runtimeFixture(root));
    await assert.rejects(runLocalAecProbe(options, { execute: (script, context) => { const result = fixtureExecute(script, context); mutate(result); return result; } }),
      /terminal is incomplete|identity, descendant authority, or cleanup is incomplete/u);
  }
});

test('interactive launcher derives task and Node desktop identities instead of hard-coding WinSta0 Default', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/testing/run-watch-mode-interactive-task.ps1'), 'utf8');
  assert.match(source, /Get-OmniCurrentDesktopIdentity/u);
  assert.doesNotMatch(source, /Get-OmniProcessDesktopIdentity|ForThread/u);
  assert.match(source, /nodeDesktopAuthorityPath/u);
  assert.match(source, /watch-mode-process-desktop-identity/u);
  assert.match(source, /nodeDesktop = \$nodeDesktop/u);
  assert.doesNotMatch(source, /desktop = 'WinSta0\\Default'/u);
});

test('Provider credential environment inventory is removed without matching benign runtime variables', () => {
  for (const name of ['DASHSCOPE_API_KEY','OMNI_TEST_DASHSCOPE_API_KEY','OPENAI_API_KEY','AZURE_OPENAI_ACCESS_TOKEN','GEMINI_API_KEY','GOOGLE_CREDENTIAL_TOKEN','TENCENT_SECRET_KEY','VOLCENGINE_ACCESS_KEY','ZHIPU_API_KEY']) {
    assert.equal(isProviderCredentialEnvironmentName(name), true, name);
  }
  for (const name of ['PATH','USERPROFILE','OMNI_WATCH_MODE_LOCAL_AEC_PROBE_REQUEST','TENCENT_READ_TIMEOUT_MS']) assert.equal(isProviderCredentialEnvironmentName(name), false, name);
});

test('local AEC interactive argv quotes runner and request paths containing spaces', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/testing/run-watch-mode-interactive-task.ps1'), 'utf8');
  assert.ok(source.includes(`('\"' + [string]$request.shardRunnerPath + '\"')`));
  assert.ok(source.includes(`('\"' + $resolvedRequestPath + '\"')`));
});

test('interactive Desktop executor keeps Provider isolation and native finalizer custody', () => {
  const script = localAecProbeDesktopPowerShell({ executable: 'E:\\runtime\\shell.exe', executableSha256: 'a'.repeat(64),
    runtimeRoot: 'E:\\runtime', outputDirectory: 'E:\\probe', requestPath: "E:\\probe's\\request.json",
    deadlineUtc: '2026-09-12T00:00:30Z', helperPath: 'E:\\runtime\\finalizer.psm1', helperSha256: 'b'.repeat(64) });
  assert.match(script, /SetEnvironmentVariable\(\$variable.Name,\$null,'Process'\)/u);
  assert.match(script, /OMNI_WATCH_MODE_LOCAL_AEC_PROBE_REQUEST='E:\\probe''s/u);
  assert.match(script, /OmniInteractiveFinalizerJob\]::Run/u);
  assert.match(script, /\$allowed=@\('SystemRoot'/u);
  assert.match(script, /credentialLikeCount=\$credentialNames.Count/u);
  assert.doesNotMatch(script, /DASHSCOPE|OPENAI|PRIVATE_GATEWAY|CUSTOM_PROVIDER/u);
  assert.doesNotMatch(script, /taskkill|Stop-Process|Start-Process/u);
});

test('desktop reporter runs as a real Node child and reports its inherited station and desktop', (t) => {
  const root = temporary(t); const output = path.join(root, 'identity with spaces.json');
  const reporter = path.join(repoRoot, 'scripts/testing/report-watch-mode-desktop-identity.ps1');
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',reporter,
    '-ExpectedParentProcessId',String(process.pid),'-OutputPath',output,'-ExecutionId','exec','-PlanDigest','a'.repeat(64),
    '-LeaseId','lease','-LeaseDigest','b'.repeat(64),'-CellId','cell','-WorkerId','worker','-VmIdentityDigest','c'.repeat(64)], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); const receipt = JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/u, ''));
  assert.equal(receipt.reporterParentPid, process.pid); assert.equal(receipt.parentProcess.pid, process.pid);
  assert.match(receipt.desktop, /^[^\\]+\\[^\\]+$/u); assert.equal(receipt.parentProcess.imageSha256, hash(fs.readFileSync(process.execPath)));
  const rejected = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',reporter,
    '-ExpectedParentProcessId','4','-OutputPath',path.join(root,'rejected.json'),'-ExecutionId','exec','-PlanDigest','a'.repeat(64),
    '-LeaseId','lease','-LeaseDigest','b'.repeat(64),'-CellId','cell','-WorkerId','worker','-VmIdentityDigest','c'.repeat(64)], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(rejected.status, 0);
});

test('minimal Desktop environment removes generic and provider credential names in a real child', () => {
  const allowed = ['SystemRoot','windir','SystemDrive','ComSpec','PATH','PATHEXT','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)','COMMONPROGRAMW6432','USERNAME','USERDOMAIN','COMPUTERNAME','SESSIONNAME','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'];
  const command = `$allowed=@(${allowed.map((x)=>`'${x}'`).join(',')}); foreach($v in @(Get-ChildItem Env:)){if($allowed -cnotcontains $v.Name){[Environment]::SetEnvironmentVariable($v.Name,$null,'Process')}}; Get-ChildItem Env: | ForEach-Object {$_.Name} | ConvertTo-Json -Compress`;
  const env = { ...process.env, API_KEY:'x', PRIVATE_GATEWAY_API_KEY:'x', CUSTOM_PROVIDER_API_KEY:'x', DASHSCOPE_API_KEY:'x', OMNI_TEST_DASHSCOPE_API_KEY:'x' };
  const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',env,windowsHide:true});
  assert.equal(result.status,0,result.stderr); const names = JSON.parse(result.stdout.trim());
  for (const name of ['API_KEY','PRIVATE_GATEWAY_API_KEY','CUSTOM_PROVIDER_API_KEY','DASHSCOPE_API_KEY','OMNI_TEST_DASHSCOPE_API_KEY']) assert.ok(!names.includes(name), name);
  assert.ok(names.some((name)=>name.toLowerCase()==='systemroot'));
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
