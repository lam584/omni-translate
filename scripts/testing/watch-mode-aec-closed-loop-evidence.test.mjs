import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { AEC_CLOSED_LOOP_PROFILE, AEC_CLOSED_LOOP_THRESHOLDS, buildAecClosedLoopEvidence,
  verifyAecClosedLoopEvidence, createAecClosedLoopManifest, canonicalAecFreezePayload, AEC_CLOSED_LOOP_REQUIRED_ARTIFACTS, AEC_CLOSED_LOOP_METADATA_MAX_BYTES,
  validateCaptureQueueLedger, verifyCaptureQueueLedgerEvidence, AEC_CAPTURE_QUEUE_WITNESS_POLICY } from './watch-mode-aec-closed-loop-evidence.mjs';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const f32 = (samples) => { const b = Buffer.alloc(samples.length * 4); samples.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; };
const names = { render: 'aec-render-reference-48k-stereo.f32le', pre: 'aec-pre-capture-48k-stereo.f32le', post: 'aec-post-output-48k-stereo.f32le', metadata: 'aec-frame-metadata.jsonl' };
const sideNames = { physical: 'aec-physical-output-48k-stereo.f32le', provider: 'aec-provider-input.s16le', metadata: 'aec-closed-loop-metadata.jsonl' };
function fixture(t, responses = 1, { sourceFrames } = {}) {
  const fixtureBase = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../artifacts/testing/aec-iteration/capture-pump-consumer-closed-loop-tests');
  fs.mkdirSync(fixtureBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureBase, 'fixture-')); t.after(() => { assert.equal(path.dirname(root), fixtureBase); fs.rmSync(root, { recursive: true, force: true }); });
  const identity = { runMarker: 'run', cellId: 'c03', leaseId: 'lease' };
  let seed = 5; const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.fround((seed / 2 ** 32 - 0.5) * 0.3); };
  const render = []; const physical = []; const pre = []; const post = []; const source = []; const base = []; const side = []; const provider = [];
  const stages = []; let frame = 0; let renderOffset = 0; let physicalOffset = 0; const origin = 10_000_000;
  const clock = (n) => origin + n * 10_000_000 / 48_000;
  const plans = [['double-talk', 0, 'none'], ['dynamic-delay', 80, 'none'], ['nonlinear', 160, 'soft-clip']];
  let currentSession = 1; let sessionStartFrame = 0;
  const physicalMeta = (start, sampleOffset) => ({ schemaVersion: 1, sequence: side.length, kind: 'physical-output',
    sampleRateHz: 48000, channelCount: 2, sampleOffset, sampleCount: 960, qpc100ns: clock(start),
    renderSessionId: currentSession, ownerGeneration: 1, continuityId: 0, resetGeneration: 0, referenceStartFrame: start - sessionStartFrame,
    referenceEndFrame: start - sessionStartFrame + 480, submittedFrames: start - sessionStartFrame + 480, playedFrames: start - sessionStartFrame, endpointPaddingFrames: 480, physicalPrefixOffsetFrames: 0 });
  for (let response = 0; response < responses; response += 1) { currentSession = response + 1; sessionStartFrame = frame;
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const [stage, delayMs, nonlinearity] = plans[ordinal - 1]; const delay = delayMs * 48;
    const length = 24000 + delay; const start = frame;
    stages.push({ stage, ordinal, delayMs, nonlinearity, physicalStartFrame: start - sessionStartFrame, physicalEndFrame: start - sessionStartFrame + length,
      startQpc100ns: clock(start), endQpc100ns: clock(start + length), renderSessionId: currentSession, ownerGeneration: 1, continuityId: 0, resetGeneration: 0 });
    for (let n = 0; n < length; n += 1) {
      const sample = rand(); const s = sourceFrames == null || frame + n < sourceFrames ? sample : 0;
      if (sourceFrames == null || frame + n < sourceFrames) source.push(s); let e = 0;
      if (n >= delay) {
        const original = rand(); render.push(original, original);
        const driven = Math.fround(original * 2.4);
        e = nonlinearity === 'soft-clip' ? Math.fround(Math.fround(driven / Math.fround(1 + Math.abs(driven))) * 1.35) : original;
      }
      physical.push(e, e); const p = Math.fround(s + Math.fround(e * 0.5)); const q = Math.fround(s + Math.fround(e * 0.001)); pre.push(p, p); post.push(q, q);
    }
    for (let n = 0; n < length; n += 480) {
      side.push(physicalMeta(start + n, physicalOffset)); physicalOffset += 960;
      if (n >= delay) {
        const e = { ...physicalMeta(start + n, renderOffset), schemaVersion: 3, sequence: base.length, kind: 'render-reference', physicalPrefixOffsetFrames: delay };
        renderOffset += 960; base.push(e);
      }
    }
    frame += length;
  }}
  for (let n = 0; n < frame; n += 480) {
    base.push({ schemaVersion: 3, kind: 'capture', sequence: base.length, continuityId: 0, resetGeneration: 0,
      sampleRateHz: 48000, channelCount: 2, preSampleOffset: n * 2, postSampleOffset: n * 2, preSampleCount: 960, postSampleCount: 960,
      timestampError: false, dataDiscontinuity: false, queueHeadClockValid: true,
      queueHeadQpc100ns: clock(n), queueHeadDeviceFrameIndex: n, packetQpc100ns: clock(n), rawPacketQpc100ns: clock(n),
      packetDeviceFrameIndex: n, rawPacketDeviceFrameIndex: n, observedQpc100ns: clock(n), delaySamples: 0 });
    const chunk = Buffer.alloc(320);
    for (let j = 0; j < 160; j += 1) {
      let sum = 0; for (let k = 0; k < 3; k += 1) sum = Math.fround(sum + post[(n + j * 3 + k) * 2]);
      chunk.writeInt16LE(Math.trunc(Math.fround(Math.fround(sum / 3) * 32767)), j * 2);
    }
    side.push({ schemaVersion: 1, sequence: side.length, kind: 'provider-input', providerSessionId: 'provider-1', sampleRateHz: 16000, channelCount: 1,
      mappingProfile: 'capture-downmix-box-decimate/v1', postSampleOffset: n * 2, postSampleCount: 960,
      sampleOffset: provider.length / 2, sampleCount: 160, sha256: sha(chunk), qpc100ns: clock(n), sentQpc100ns: clock(n) + 1000,
      resetGeneration: 0, continuityId: 0 }); provider.push(...chunk);
  }
  const physEvents=side.filter((e)=>e.kind==='physical-output'); const providerEvents=side.filter((e)=>e.kind==='provider-input');
  side.length=0;
  side.push({kind:'provider-lifecycle',status:'paid-call-start',qpc100ns:9700000,providerSessionId:'provider-1'});
  const life=(status,qpc,session)=>({kind:'render-lifecycle',status,qpc100ns:qpc,renderSessionId:session,ownerGeneration:1,continuityId:0,resetGeneration:0,valid:true});
  for (const e of physEvents) {
    if(e.referenceStartFrame===0)side.push(life('session-started',e.qpc100ns-10000,e.renderSessionId));
    side.push(e);
    if(e.referenceStartFrame===0)side.push(life('stream-started',e.qpc100ns,e.renderSessionId));
    const stage=stages.find((s)=>s.renderSessionId===e.renderSessionId && s.physicalEndFrame===e.referenceEndFrame);
    if(stage) {
      side.push({...stage,kind:'stage-lifecycle',status:'completed',physicalFrames:stage.physicalEndFrame-stage.physicalStartFrame,qpc100ns:stage.endQpc100ns});
      if(stage.ordinal===3)side.push({...life('session-ended',stage.endQpc100ns,e.renderSessionId),normallyDrained:true,streamStarted:true});
    }
  }
  side.push(...providerEvents);
  side.forEach((e,i)=>{e.schemaVersion=1;e.sequence=i;});
  const terminal = { schemaVersion: 2, kind: 'terminal', status: 'complete', complete: true, countsFinal: true,
    errors: [], droppedEvents: 0, attemptedEvents: base.length, acceptedEvents: base.length, writtenEvents: base.length,
    lastWrittenSequence: base.length - 1, lastAttemptedSequence: base.length - 1, resetGeneration: 0,
    hashAlgorithm: 'sha256', terminalFile: 'aec-terminal.json', invalidClockEvents: 0,
    sampleCounts: { render: render.length, pre: pre.length, post: post.length },
    eventCounts: { render: base.filter((e) => e.kind === 'render-reference').length, capture: frame / 480, reset: 0 } };
  const seal = { schemaVersion: 1, kind: 'aec-closed-loop-terminal', identity, complete: true, countsFinal: true, errors: [], droppedEvents: 0,
    attemptedEvents: side.length, acceptedEvents: side.length, writtenEvents: side.length,
    physicalSamples: physical.length, providerSamples: provider.length / 2, physicalEvents: frame / 480, providerEvents: frame / 480, lifecycleEvents: 1 + responses * 6 };
  const writeSet = (mapping, lanes, output) => { output.files = {}; for (const [lane, name] of Object.entries(mapping)) {
    const b = lanes[lane]; fs.writeFileSync(path.join(root, name), b); output.files[lane] = { name, byteLength: b.length, sha256: sha(b), flushed: true, synced: true, unwrittenBufferedBytes: 0 };
  } };
  writeSet(names, { render: f32(render), pre: f32(pre), post: f32(post), metadata: Buffer.from(base.map((e) => JSON.stringify(e)).join('\n') + '\n') }, terminal);
  writeSet(sideNames, { physical: f32(physical), provider: Buffer.from(provider), metadata: Buffer.from(side.map((e) => JSON.stringify(e)).join('\n') + '\n') }, seal);
  fs.writeFileSync(path.join(root, 'aec-terminal.json'), JSON.stringify(terminal)); fs.writeFileSync(path.join(root, 'aec-closed-loop-terminal.json'), JSON.stringify(seal));
  const sourceBytes = f32(source); const sourceName = 'aec-source-reference-48k-mono.f32le'; fs.writeFileSync(path.join(root, sourceName), sourceBytes);
  const manifest = { schemaVersion: 1, profile: AEC_CLOSED_LOOP_PROFILE, identity, thresholds: AEC_CLOSED_LOOP_THRESHOLDS, thresholdsFrozenQpc100ns: 9_500_000,
    source: { file: sourceName, byteLength: sourceBytes.length, sha256: sha(sourceBytes), sampleRateHz: 48000, channelCount: 1, playbackStartQpc100ns: origin }, stages };
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
  const payload={schemaVersion:1,kind:'aec-threshold-freeze',identity,profile:AEC_CLOSED_LOOP_PROFILE,thresholds:AEC_CLOSED_LOOP_THRESHOLDS};
  const freezeBytes=Buffer.from(JSON.stringify({payload,signatureBase64:crypto.sign(null,canonicalAecFreezePayload(payload),privateKey).toString('base64')}));
  fs.writeFileSync(path.join(root,'aec-threshold-freeze.json'),freezeBytes);
  manifest.freeze={file:'aec-threshold-freeze.json',sha256:sha(freezeBytes),payloadSha256:sha(canonicalAecFreezePayload(payload))};
  seal.startupQpc100ns=9500000;seal.thresholdFreezeSha256=sha(freezeBytes);
  fs.writeFileSync(path.join(root,'aec-closed-loop-terminal.json'),JSON.stringify(seal));
  const sourceClocks=[{clockPosition:0,submittedFrames:480,paddingFrames:480},{clockPosition:480,submittedFrames:960,paddingFrames:480},{clockPosition:source.length,submittedFrames:source.length,paddingFrames:0}]
    .map((e,i)=>({...e,schemaVersion:1,artifactKind:'aec-source-playback-clock',sequence:i,processId:42,endpointId:'endpoint',sampleRateHz:48000,clockFrequency:48000,qpc100ns:clock(e.clockPosition),playbackStartQpc100ns:origin}));
  const clockBytes=Buffer.from(sourceClocks.map(e=>JSON.stringify(e)).join('\n')+'\n');fs.writeFileSync(path.join(root,'aec-source-playback-clock.jsonl'),clockBytes);
  const playbackBytes=Buffer.from(JSON.stringify({injectorResult:{sourcePlaybackStartQpc100ns:origin,sourceClockFrequency:48000,sourcePcm48kMonoPath:path.join(root,sourceName),sourceClockMetadataPath:path.join(root,'aec-source-playback-clock.jsonl')}}));
  fs.writeFileSync(path.join(root,'playback.json'),playbackBytes);
  fs.writeFileSync(path.join(root, 'aec-closed-loop-evidence.json'), JSON.stringify(manifest));
  const authority = { aecClosedLoop: { identity, source: structuredClone(manifest.source), stages: structuredClone(stages), thresholdsFrozenQpc100ns: 9_500_000,
    firstPaidProviderCallQpc100ns: 9_700_000, providerSessionIds: ['provider-1'],freeze:manifest.freeze,sourceClockSha256:sha(clockBytes),sourcePlaybackReceiptSha256:sha(playbackBytes) } };
  return { root, manifest, terminal, seal, base, side, authority, identity,
    publicKey,sourceClocks,
    saveSourceClocks() {
      const bytes = Buffer.from(sourceClocks.map(e => JSON.stringify(e)).join("\n") + "\n");
      fs.writeFileSync(path.join(root, "aec-source-playback-clock.jsonl"), bytes);
      authority.aecClosedLoop.sourceClockSha256 = sha(bytes);
    },
    pinQueuePolicy(policy = AEC_CAPTURE_QUEUE_WITNESS_POLICY) {
      const previous = JSON.parse(fs.readFileSync(path.join(root, 'aec-threshold-freeze.json'), 'utf8')).payload;
      const newPayload = { ...previous, captureQueueWitnessPolicy: policy };
      const bytes = Buffer.from(JSON.stringify({ payload: newPayload,
        signatureBase64: crypto.sign(null, canonicalAecFreezePayload(newPayload), privateKey).toString('base64') }));
      fs.writeFileSync(path.join(root, 'aec-threshold-freeze.json'), bytes);
      manifest.freeze = { file: 'aec-threshold-freeze.json', sha256: sha(bytes), payloadSha256: sha(canonicalAecFreezePayload(newPayload)) };
      authority.aecClosedLoop.freeze = manifest.freeze; seal.thresholdFreezeSha256 = sha(bytes);
      fs.writeFileSync(path.join(root, 'aec-closed-loop-evidence.json'), JSON.stringify(manifest));
      fs.writeFileSync(path.join(root, 'aec-closed-loop-terminal.json'), JSON.stringify(seal));
    },
    pinAnalyzer(executable) {
      const bytes=fs.readFileSync(executable);const inventory=[{path:'target/release/omni-benchmark.exe',sha256:sha(bytes)}];
      fs.mkdirSync(path.join(root,'target/release'),{recursive:true});fs.writeFileSync(path.join(root,'target/release/omni-benchmark.exe'),bytes);
      const newPayload={...payload,runtimeBinaryHashes:inventory};
      const signedBytes=Buffer.from(JSON.stringify({payload:newPayload,signatureBase64:crypto.sign(null,canonicalAecFreezePayload(newPayload),privateKey).toString('base64')}));
      fs.writeFileSync(path.join(root,'aec-threshold-freeze.json'),signedBytes);
      manifest.freeze={file:'aec-threshold-freeze.json',sha256:sha(signedBytes),payloadSha256:sha(canonicalAecFreezePayload(newPayload))};
      authority.aecClosedLoop.freeze=manifest.freeze;seal.thresholdFreezeSha256=sha(signedBytes);
      fs.writeFileSync(path.join(root,'aec-closed-loop-evidence.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(root,'aec-closed-loop-terminal.json'),JSON.stringify(seal));
      return {workspaceRoot:root,releaseExecutablePath:path.join(root,'target/release/omni-benchmark.exe'),releaseExecutableSha256:sha(bytes),noBuild:true};
    },
    options: { runtimeAuthority: authority, cell: identity, freezePublicKey:publicKey },
    saveManifest() { fs.writeFileSync(path.join(root, 'aec-closed-loop-evidence.json'), JSON.stringify(manifest)); },
    saveEvents(which) { const entries = which === 'base' ? base : side; const target = which === 'base' ? terminal : seal; const name = which === 'base' ? names.metadata : sideNames.metadata;
      const b = Buffer.from(entries.map((e) => JSON.stringify(e)).join('\n') + '\n'); fs.writeFileSync(path.join(root, name), b);
      target.files.metadata.byteLength = b.length; target.files.metadata.sha256 = sha(b);
      fs.writeFileSync(path.join(root, which === 'base' ? 'aec-terminal.json' : 'aec-closed-loop-terminal.json'), JSON.stringify(target)); },
  };
}
function fails(f, pattern) { const r = buildAecClosedLoopEvidence(f.root, f.options); assert.equal(r.passed, false); assert.match(r.violations.join(';'), pattern); }
test('three real transformed stages have hash/clock/provider complete aligned inputs, never a builder release pass', (t) => {
  const f = fixture(t); const r = buildAecClosedLoopEvidence(f.root, f.options);
  assert.equal(r.passed, true, r.violations.join(';')); assert.equal(r.releaseEligible, false); assert.equal(r.stages.length, 3);
  assert.equal(r.stages[2].alignedPhysical.length, 31680); assert.equal(r.physicalRenders[0].acousticOnsetAuthority, false);
  for (const file of AEC_CLOSED_LOOP_REQUIRED_ARTIFACTS) assert.ok(fs.existsSync(path.join(f.root, file)), file);
});
test('invalid capture clock cannot pass even with re-sealed files', (t) => { const f = fixture(t); f.base.find((e) => e.kind === 'capture').queueHeadClockValid = false; f.saveEvents('base'); fails(f, /clock|provenance/); });
test('reset crossing capture provenance cannot pass', (t) => { const f = fixture(t); f.side.find((e) => e.kind === 'provider-input').resetGeneration = 1; f.saveEvents('side'); fails(f, /reset|ownership/); });
test('wrong provider input mapping, session and QPC fail independently', async (t) => {
  for (const field of ['postSampleOffset', 'providerSessionId', 'qpc100ns']) await t.test(field, (t) => {
    const f = fixture(t); const e = f.side.find((e) => e.kind === 'provider-input'); e[field] = field === 'providerSessionId' ? 'wrong-session' : e[field] + (field === 'qpc100ns' ? 1000 : 6); f.saveEvents('side'); fails(f, /provider|mapping/);
  });
});
test('actual provider bytes cannot be substituted for pre or zero input', (t) => {
  const f = fixture(t); const name = path.join(f.root, sideNames.provider); const bytes = fs.readFileSync(name); bytes.fill(0, 0, 320); fs.writeFileSync(name, bytes);
  f.seal.files.provider.sha256 = sha(bytes); f.side.find((e) => e.kind === 'provider-input').sha256 = sha(bytes.subarray(0, 320)); f.saveEvents('side'); fails(f, /not mapped post-AEC/);
});
test('cropped nonlinear tail cannot pass a runtime-authority-compatible claim', (t) => { const f = fixture(t); f.manifest.stages[2].physicalEndFrame -= 480; f.manifest.stages[2].endQpc100ns -= 100000; f.authority.aecClosedLoop.stages = structuredClone(f.manifest.stages); f.saveManifest(); fails(f, /cropped physical|tail/); });
test('source wrong reference, lag and tampered hash fail', async (t) => {
  for (const mutation of ['hash', 'lag', 'authority']) await t.test(mutation, (t) => {
    const f = fixture(t);
    if (mutation === 'hash') f.manifest.source.sha256 = '0'.repeat(64);
    else if (mutation === 'lag') { f.manifest.source.playbackStartQpc100ns += 1600000; f.authority.aecClosedLoop.source = structuredClone(f.manifest.source); }
    else f.authority.aecClosedLoop.source.sha256 = '1'.repeat(64);
    f.saveManifest(); fails(f, /source/);
  });
});
test('physical reference is mechanically rebuilt nonlinear waveform, not weak correlation', (t) => {
  const f = fixture(t); const name = path.join(f.root, sideNames.physical); const bytes = fs.readFileSync(name); bytes.writeFloatLE(0.42, bytes.length - 4); fs.writeFileSync(name, bytes);
  f.seal.files.physical.sha256 = sha(bytes); fs.writeFileSync(path.join(f.root, 'aec-closed-loop-terminal.json'), JSON.stringify(f.seal)); fails(f, /physical reference/);
});
test('frozen thresholds cannot be relaxed or established after a paid call', async (t) => {
  await t.test('relaxed', (t) => { const f = fixture(t); f.manifest.thresholds = { ...AEC_CLOSED_LOOP_THRESHOLDS, echoAttenuationDb: 5 }; f.saveManifest(); fails(f, /thresholds/); });
  await t.test('postpaid', (t) => { const f = fixture(t); f.authority.aecClosedLoop.firstPaidProviderCallQpc100ns = 9_400_000; fails(f, /paid provider/); });
});
test('NaN/infinite f32 cannot pass even with a valid hash', (t) => { const f = fixture(t); const name = path.join(f.root, names.post); const bytes = fs.readFileSync(name); bytes.writeFloatLE(NaN, 0); fs.writeFileSync(name, bytes); f.terminal.files.post.sha256 = sha(bytes); fs.writeFileSync(path.join(f.root, 'aec-terminal.json'), JSON.stringify(f.terminal)); fails(f, /invalid f32/); });
test('top-level quality gate returns fail-closed before mechanical analysis on missing authority', (t) => { const f = fixture(t); const r = verifyAecClosedLoopEvidence(f.root); assert.equal(r.passed, false); assert.equal(r.releaseEligible, false); assert.match(r.violations.join(';'), /authority/); });
test('production manifest reconstructs typed stages/source clocks and verifies coordinator freeze signature', (t) => {
  const f = fixture(t); fs.unlinkSync(path.join(f.root, 'aec-closed-loop-evidence.json'));
  const r = createAecClosedLoopManifest(f.root, { cell: f.identity, freezePublicKey: f.publicKey });
  assert.equal(r.passed, true, r.violations.join(';')); assert.equal(r.runtimeAuthority.aecClosedLoop.stages.length, 3);
  assert.equal(r.runtimeAuthority.aecClosedLoop.sourceClockSha256, f.authority.aecClosedLoop.sourceClockSha256);
  assert.equal(r.runtimeAuthority.aecClosedLoop.firstPaidProviderCallQpc100ns, 9700000);
});
test('production manifest and builder aggregate every phase across two actual render responses, including final tail', (t) => {
  const f = fixture(t, 2); fs.unlinkSync(path.join(f.root, 'aec-closed-loop-evidence.json'));
  const r = createAecClosedLoopManifest(f.root, { cell: f.identity, freezePublicKey: f.publicKey });
  assert.equal(r.passed, true, r.violations.join(';')); assert.equal(r.runtimeAuthority.aecClosedLoop.stages.length, 6);
  const b = buildAecClosedLoopEvidence(f.root, { runtimeAuthority: r.runtimeAuthority, cell: f.identity, freezePublicKey: f.publicKey });
  assert.equal(b.passed, true, b.violations.join(';')); assert.equal(b.physicalRenders.length, 2);
  assert.equal(b.stages.at(-1).endQpc100ns, f.manifest.stages.at(-1).endQpc100ns);
});
test('omitting a later response/session or its final phase cannot pass', (t) => {
  const f = fixture(t, 2); f.manifest.stages = f.manifest.stages.slice(0, 3); f.authority.aecClosedLoop.stages = structuredClone(f.manifest.stages); f.saveManifest();
  fails(f, /render session omitted/);
});
test('production manifest refuses caller policy scores and an untrusted freeze key', (t) => {
  const f = fixture(t); const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const r = createAecClosedLoopManifest(f.root, { cell: f.identity, freezePublicKey: publicKey, passed: true });
  assert.equal(r.passed, false); assert.match(r.violations.join(';'), /signature rejected/);
});
test('production source clocks reject drift, missing nonzero clocks and undrained tail', async (t) => {
  for (const mutation of ['drift', 'zeros', 'tail']) await t.test(mutation, (t) => {
    const f = fixture(t);
    if (mutation === 'drift') f.sourceClocks[1].qpc100ns += 20000;
    if (mutation === 'zeros') f.sourceClocks.forEach((e) => { e.clockPosition = 0; });
    if (mutation === 'tail') f.sourceClocks.at(-1).paddingFrames = 480;
    fs.writeFileSync(path.join(f.root, 'aec-source-playback-clock.jsonl'), f.sourceClocks.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = createAecClosedLoopManifest(f.root, { cell: f.identity, freezePublicKey: f.publicKey });
    assert.equal(r.passed, false); assert.match(r.violations.join(';'), /source clock|source complete tail/);
  });
});
test('quality gate cannot rebuild/fallback without signed frozen analyzer inventory', (t) => {
  const f = fixture(t); const r = verifyAecClosedLoopEvidence(f.root, { ...f.options, strictRebuild: true });
  assert.equal(r.passed, false); assert.equal(r.releaseEligible, false); assert.match(r.violations.join(';'), /frozen signed release analyzer/);
});
test('pinned binary hash missing from signed freeze cannot pass even when local hash is correct', (t) => {
  const f = fixture(t); const r = verifyAecClosedLoopEvidence(f.root, { ...f.options,
    workspaceRoot: f.root, releaseExecutablePath: path.join(f.root, 'target/release/omni-benchmark.exe'), releaseExecutableSha256: '0'.repeat(64), noBuild: true });
  assert.equal(r.passed, false); assert.match(r.violations.join(';'), /not bound to signed freeze/);
});
test('frozen signed real Rust analyzer runs every response without a build and keeps strict release status', {skip: !process.env.OMNI_AEC_TEST_ANALYZER}, (t) => {
  const f = fixture(t, 2); const analyzer = f.pinAnalyzer(process.env.OMNI_AEC_TEST_ANALYZER);
  const r = verifyAecClosedLoopEvidence(f.root, { ...f.options, analyzer });
  assert.equal(r.passed, true, r.violations.join(';')); assert.equal(r.releaseEligible, true);
  assert.equal(r.stages.length, 6); assert.equal(r.mechanicalRebuild, false); assert.equal(r.frozenRuntimeAuthority, true);
  fs.appendFileSync(analyzer.releaseExecutablePath, 'replacement');
  const changed = verifyAecClosedLoopEvidence(f.root, { ...f.options, analyzer });
  assert.equal(changed.passed, false); assert.match(changed.violations.join(';'), /SHA256 changed/);
});
test('production manifest reconstructs typed streaming phase writes even without duplicated stage telemetry', (t) => {
  const f = fixture(t, 2);
  for (const e of f.side.filter((e) => e.kind === 'physical-output')) {
    const stage = f.manifest.stages.find((s) => s.renderSessionId === e.renderSessionId && e.referenceStartFrame >= s.physicalStartFrame && e.referenceEndFrame <= s.physicalEndFrame);
    e.stage = stage.stage; e.stageOrdinal = stage.ordinal; e.delayMs = stage.delayMs; e.nonlinearity = stage.nonlinearity;
  }
  const retained = f.side.filter((e) => e.kind !== 'stage-lifecycle'); f.side.length = 0; f.side.push(...retained);
  f.side.forEach((e, i) => { e.sequence = i; }); f.seal.lifecycleEvents -= 6;
  f.seal.attemptedEvents = f.side.length; f.seal.acceptedEvents = f.side.length; f.seal.writtenEvents = f.side.length; f.saveEvents('side');
  fs.unlinkSync(path.join(f.root, 'aec-closed-loop-evidence.json'));
  const r = createAecClosedLoopManifest(f.root, { cell: f.identity, freezePublicKey: f.publicKey });
  assert.equal(r.passed, true, r.violations.join(';')); assert.equal(r.runtimeAuthority.aecClosedLoop.stages.length, 6);
});

// A WinPS receipt is parsed as JSON after BOM removal, but custody hashes raw bytes.
test('WinPS BOM receipt is accepted only with its original-byte hash', (t) => {
  const f = fixture(t); const receipt = path.join(f.root, 'playback.json');
  const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(receipt)]);
  fs.writeFileSync(receipt, bomBytes);
  fails(f, /source clock.hash authority mismatch/);
  f.authority.aecClosedLoop.sourcePlaybackReceiptSha256 = sha(bomBytes);
  const built = buildAecClosedLoopEvidence(f.root, f.options);
  assert.equal(built.passed, true, built.violations.join(';'));
  fs.unlinkSync(path.join(f.root, 'aec-closed-loop-evidence.json'));
  const created = createAecClosedLoopManifest(f.root, {cell: f.identity, freezePublicKey: f.publicKey});
  assert.equal(created.passed, true, created.violations.join(';'));
  assert.equal(created.runtimeAuthority.aecClosedLoop.sourcePlaybackReceiptSha256, sha(bomBytes));
  fs.appendFileSync(receipt, '\n');
  assert.equal(buildAecClosedLoopEvidence(f.root, { ...f.options, runtimeAuthority: created.runtimeAuthority }).passed, false);
});
test('completed English source becomes natural zero through the complete translated drain', (t) => {
  const sourceFrames = 24000 + 27840 + 9600; const f = fixture(t, 1, {sourceFrames});
  const built = buildAecClosedLoopEvidence(f.root, f.options);
  assert.equal(built.passed, true, built.violations.join(';'));
  const last = built.stages.at(-1);
  assert.equal(last.alignedSource.length, 31680); assert.equal(last.alignedPhysical.length, 31680);
  assert.equal(last.sourceEndedSampleCount, 31680 - 9600);
  assert.equal(last.sourceReferenceState, 'recording-then-ended');
  assert.ok(last.alignedSource.slice(0, 9600).some(v => v !== 0));
  assert.ok(last.alignedSource.slice(9600).every(v => v === 0));
  assert.ok(last.alignedPhysical.slice(9600).some(v => v !== 0), 'Chinese output must not become the English reference');
  fs.unlinkSync(path.join(f.root, 'aec-closed-loop-evidence.json'));
  const created = createAecClosedLoopManifest(f.root, {cell: f.identity, freezePublicKey: f.publicKey});
  assert.equal(created.passed, true, created.violations.join(';'));
});
test('an entirely ended-source phase retains its physical PCM without inventing English coverage', (t) => {
  const f = fixture(t, 1, {sourceFrames: 24000 + 27840});
  const built = buildAecClosedLoopEvidence(f.root, f.options);
  assert.equal(built.passed, true, built.violations.join(';'));
  const last = built.stages.at(-1);
  assert.equal(last.sourceReferenceState, 'ended-only'); assert.equal(last.sourceEndedSampleCount, 31680);
  assert.ok(last.alignedSource.every(v => v === 0)); assert.equal(last.alignedPhysical.length, 31680);
});
test('unknown onset or an incompletely observed source end cannot be padded as natural silence', async (t) => {
  for (const mutation of ['before-start', 'before-start-subframe', 'not-played', 'padding', 'truncated-source']) await t.test(mutation, t => {
    const f = fixture(t, 1, {sourceFrames: 24000 + 27840 + 9600});
    if (mutation === 'before-start') {
      const shift = 100000;
      f.manifest.source.playbackStartQpc100ns += shift;
      f.authority.aecClosedLoop.source.playbackStartQpc100ns += shift; f.saveManifest();
      const receipt = path.join(f.root, 'playback.json'); const value = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      value.injectorResult.sourcePlaybackStartQpc100ns += shift;
      const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(receipt, bytes);
      f.authority.aecClosedLoop.sourcePlaybackReceiptSha256 = sha(bytes);
      f.sourceClocks.forEach(e => {e.qpc100ns += shift; e.playbackStartQpc100ns += shift;}); f.saveSourceClocks();
      fails(f, /source timeline.*before/);
    } else if (mutation === 'not-played') {
      f.sourceClocks.at(-1).clockPosition -= 24; f.sourceClocks.at(-1).qpc100ns -= 5000; f.saveSourceClocks();
      fails(f, /source end.*confirmed/);
    } else if (mutation === 'padding') {
      f.sourceClocks.at(-1).paddingFrames = 480; f.saveSourceClocks(); fails(f, /source complete tail/);
    } else {
      const file = path.join(f.root, f.manifest.source.file); const bytes = fs.readFileSync(file).subarray(0, -480 * 4);
      fs.writeFileSync(file, bytes); f.manifest.source.byteLength = bytes.length; f.manifest.source.sha256 = sha(bytes);
      f.authority.aecClosedLoop.source = structuredClone(f.manifest.source); f.saveManifest();
      fails(f, /source clock identity.*frame coverage/);
    }
  });
});
test('an ongoing English reference remains distinct from the translated output tail', (t) => {
  const f = fixture(t); const built = buildAecClosedLoopEvidence(f.root, f.options);
  assert.equal(built.passed, true, built.violations.join(';'));
  const last = built.stages.at(-1);
  assert.equal(last.sourceEndedSampleCount, 0); assert.equal(last.sourceReferenceState, 'recording');
  assert.ok(last.alignedSource.slice(-4800).some(v => v !== 0));
  const chinese = fs.readFileSync(path.join(f.root, sideNames.physical));
  fs.writeFileSync(path.join(f.root, f.manifest.source.file), chinese.subarray(0, f.manifest.source.byteLength));
  fails(f, /source clock.hash authority mismatch|source hash.identity mismatch/);
});


test('native capture packet sidecar record is accepted and strictly validated without granting formal authority', (t) => {
  const f = fixture(t);
  const validPacket = {
    schemaVersion: 1,
    sequence: f.side.length,
    kind: 'native-capture-packet',
    diagnosticOnly: true,
    qualityAcceptance: false,
    aecQualityAcceptance: false,
    releaseEligible: false,
    formalCaptureClockAcceptance: false,
    rawFrameCount: 480,
    rawByteCount: 3840,
    blockAlignBytes: 8,
    rawPacketDeviceFrameIndex: 0,
    rawPacketQpc100ns: 10_000_000,
    dataDiscontinuity: false,
    silent: false,
    timestampError: false,
    queuedBytesBeforeRead: 0,
    queuedBytesAfterRead: 3840,
    qpc100ns: 10_000_000,
    observedQpc100ns: 10_000_000,
    direction: 'capture',
    requestedEndpointId: '{default-mic}',
    endpointId: null,
    captureOwnerId: null,
    captureAecResetGeneration: null,
    resetGeneration: 0,
    resetGenerationDomain: 'aec-diagnostic-tap',
  };
  f.side.push(validPacket);
  f.seal.attemptedEvents += 1;
  f.seal.acceptedEvents += 1;
  f.seal.writtenEvents += 1;
  f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
  f.saveEvents('side');

  const manifestResult = createAecClosedLoopManifest(f.root, {
    cell: f.identity,
    signedFreezeFile: 'aec-threshold-freeze.json',
    freezePublicKey: f.publicKey,
    playbackReceiptFile: 'playback.json',
  });
  assert.equal(manifestResult.passed, true, manifestResult.violations.join('; '));

  const built = buildAecClosedLoopEvidence(f.root, f.options);
  assert.equal(built.passed, true, built.violations.join('; '));
});

test('native capture packet rejects fraudulent authority or acceptance booleans', async (t) => {
  for (const [key, value] of [
    ['diagnosticOnly', false],
    ['qualityAcceptance', true],
    ['aecQualityAcceptance', true],
    ['releaseEligible', true],
    ['formalCaptureClockAcceptance', true],
  ]) {
    await t.test(key, (t) => {
      const f = fixture(t);
      const packet = {
        schemaVersion: 1,
        sequence: f.side.length,
        kind: 'native-capture-packet',
        diagnosticOnly: true,
        qualityAcceptance: false,
        aecQualityAcceptance: false,
        releaseEligible: false,
        formalCaptureClockAcceptance: false,
        rawFrameCount: 480,
        rawByteCount: 3840,
        blockAlignBytes: 8,
        rawPacketDeviceFrameIndex: 0,
        rawPacketQpc100ns: 10_000_000,
        dataDiscontinuity: false,
        silent: false,
        timestampError: false,
        queuedBytesBeforeRead: 0,
        queuedBytesAfterRead: 3840,
        qpc100ns: 10_000_000,
        observedQpc100ns: 10_000_000,
        direction: 'capture',
        requestedEndpointId: '{default-mic}',
        endpointId: null,
        captureOwnerId: null,
        captureAecResetGeneration: null,
        resetGenerationDomain: 'aec-diagnostic-tap',
        [key]: value,
      };
      f.side.push(packet);
      f.seal.attemptedEvents += 1;
      f.seal.acceptedEvents += 1;
      f.seal.writtenEvents += 1;
      f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
      f.saveEvents('side');
      fails(f, /formal quality or clock authority/);
    });
  }
});

test('native capture packet rejects frame, byte and queue inconsistencies', async (t) => {
  const basePacket = {
    schemaVersion: 1,
    kind: 'native-capture-packet',
    diagnosticOnly: true,
    qualityAcceptance: false,
    aecQualityAcceptance: false,
    releaseEligible: false,
    formalCaptureClockAcceptance: false,
    rawFrameCount: 480,
    rawByteCount: 3840,
    blockAlignBytes: 8,
    rawPacketDeviceFrameIndex: 0,
    rawPacketQpc100ns: 10_000_000,
    dataDiscontinuity: false,
    silent: false,
    timestampError: false,
    queuedBytesBeforeRead: 0,
    queuedBytesAfterRead: 3840,
    qpc100ns: 10_000_000,
    observedQpc100ns: 10_000_000,
    direction: 'capture',
    requestedEndpointId: '{default-mic}',
    endpointId: null,
    captureOwnerId: null,
    captureAecResetGeneration: null,
    resetGeneration: 0,
    resetGenerationDomain: 'aec-diagnostic-tap',
  };

  await t.test('zero frames', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, rawFrameCount: 0 });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /raw frame count/);
  });

  await t.test('null underflow rawByteCount', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, rawByteCount: null, queuedBytesBeforeRead: 5000, queuedBytesAfterRead: 3840 });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /frame\/byte\/queue inconsistency/);
  });

  await t.test('rawByteCount delta mismatch', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, rawByteCount: 3840, queuedBytesBeforeRead: 0, queuedBytesAfterRead: 4000 });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /frame\/byte\/queue inconsistency/);
  });

  await t.test('block align frame mismatch', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, rawFrameCount: 480, rawByteCount: 3840, blockAlignBytes: 4 });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /frame\/byte\/queue inconsistency/);
  });
  await t.test('unaligned queuedBytesBeforeRead intra-frame offset', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, queuedBytesBeforeRead: 3, queuedBytesAfterRead: 3843 });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /queued bytes not aligned to frame block align/);
  });

  await t.test('unaligned queuedBytesAfterRead intra-frame offset', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, queuedBytesBeforeRead: 0, queuedBytesAfterRead: 3841, rawByteCount: 3841 });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /queued bytes not aligned to frame block align/);
  });

  await t.test('missing resetGeneration field entirely', (t) => {
    const f = fixture(t);
    const p = { ...basePacket, sequence: f.side.length };
    delete p.resetGeneration;
    f.side.push(p);
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /reset generation/);
  });

  await t.test('invalid negative or non-integer resetGeneration', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, resetGeneration: -1 });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /reset generation/);
  });
});

test('native capture packet rejects unsafe integers, missing fields and unknown kind', async (t) => {
  const basePacket = {
    schemaVersion: 1,
    kind: 'native-capture-packet',
    diagnosticOnly: true,
    qualityAcceptance: false,
    aecQualityAcceptance: false,
    releaseEligible: false,
    formalCaptureClockAcceptance: false,
    rawFrameCount: 480,
    rawByteCount: 3840,
    blockAlignBytes: 8,
    rawPacketDeviceFrameIndex: 0,
    rawPacketQpc100ns: 10_000_000,
    dataDiscontinuity: false,
    silent: false,
    timestampError: false,
    queuedBytesBeforeRead: 0,
    queuedBytesAfterRead: 3840,
    qpc100ns: 10_000_000,
    observedQpc100ns: 10_000_000,
    direction: 'capture',
    requestedEndpointId: '{default-mic}',
    endpointId: null,
    captureOwnerId: null,
    captureAecResetGeneration: null,
    resetGeneration: 0,
    resetGenerationDomain: 'aec-diagnostic-tap',
  };

  await t.test('unsafe integer QPC', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, rawPacketQpc100ns: Number.MAX_SAFE_INTEGER + 10 });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /packet frame index or QPC/);
  });

  await t.test('negative integer queued bytes', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, queuedBytesBeforeRead: -1 });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /queued byte accounting/);
  });

  await t.test('missing requestedEndpointId', (t) => {
    const f = fixture(t);
    const p = { ...basePacket, sequence: f.side.length };
    delete p.requestedEndpointId;
    f.side.push(p);
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /requested endpoint ID/);
  });

  await t.test('wrong reset generation domain', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, resetGenerationDomain: 'hardware-clock' });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /reset generation domain/);
  });

  await t.test('unknown kind', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, kind: 'unknown-sidecar-packet' });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /sidecar metadata sequence\/schema mismatch/);
  });

  await t.test('missing endpointId field entirely', (t) => {
    const f = fixture(t);
    const p = { ...basePacket, sequence: f.side.length };
    delete p.endpointId;
    f.side.push(p);
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /endpoint ID/);
  });

  await t.test('missing captureOwnerId field entirely', (t) => {
    const f = fixture(t);
    const p = { ...basePacket, sequence: f.side.length };
    delete p.captureOwnerId;
    f.side.push(p);
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /capture owner ID/);
  });

  await t.test('missing captureAecResetGeneration field entirely', (t) => {
    const f = fixture(t);
    const p = { ...basePacket, sequence: f.side.length };
    delete p.captureAecResetGeneration;
    f.side.push(p);
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /capture AEC reset generation/);
  });

  await t.test('observedQpc mismatch with qpc100ns', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, qpc100ns: 10_000_000, observedQpc100ns: 10_000_001 });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    fails(f, /observed QPC mismatch/);
  });

  await t.test('inbound direction with explicit null observedQpc is accepted if consistent', (t) => {
    const f = fixture(t);
    f.side.push({ ...basePacket, sequence: f.side.length, direction: 'inbound', qpc100ns: null, observedQpc100ns: null });
    f.seal.attemptedEvents += 1; f.seal.acceptedEvents += 1; f.seal.writtenEvents += 1;
    f.seal.lifecycleEvents = (f.seal.lifecycleEvents ?? 0) + 1;
    f.saveEvents('side');
    const built = buildAecClosedLoopEvidence(f.root, f.options);
    assert.equal(built.passed, true, built.violations.join('; '));
  });
});

test('native capture packet is not counted as formal output or provider input', (t) => {
  const f = fixture(t);
  const packet = {
    schemaVersion: 1,
    sequence: f.side.length,
    kind: 'native-capture-packet',
    diagnosticOnly: true,
    qualityAcceptance: false,
    aecQualityAcceptance: false,
    releaseEligible: false,
    formalCaptureClockAcceptance: false,
    rawFrameCount: 480,
    rawByteCount: 3840,
    blockAlignBytes: 8,
    rawPacketDeviceFrameIndex: 0,
    rawPacketQpc100ns: 10_000_000,
    dataDiscontinuity: false,
    silent: false,
    timestampError: false,
    queuedBytesBeforeRead: 0,
    queuedBytesAfterRead: 3840,
    qpc100ns: 10_000_000,
    observedQpc100ns: 10_000_000,
    direction: 'capture',
    requestedEndpointId: '{default-mic}',
    endpointId: null,
    captureOwnerId: null,
    captureAecResetGeneration: null,
    resetGeneration: 0,
    resetGenerationDomain: 'aec-diagnostic-tap',
  };
  f.side.push(packet);
  // Do not increase lifecycleEvents count; fraudulently try to count it as physicalEvents
  f.seal.physicalEvents += 1;
  f.seal.attemptedEvents += 1;
  f.seal.acceptedEvents += 1;
  f.seal.writtenEvents += 1;
  f.saveEvents('side');
  fails(f, /sidecar final count mismatch/);
});
// Synthetic sealed journals exercise receipts, not a live queue/quality claim.
function queueFixture(t) {
  const f = fixture(t); const captures = f.base.filter(e => e.kind === 'capture');
  let head = 0, tail = 0, generation = 0, packetId = 0, dequeueId = 0; let spans = [];
  const additions = [];
  const common = (kind, extra = {}) => ({ schemaVersion: 1, kind, diagnosticOnly: true,
    qualityAcceptance: false, aecQualityAcceptance: false, formalCaptureClockAcceptance: false, releaseEligible: false,
    direction: 'inbound', endpointId: 'initialized-native-endpoint', captureOwnerId: 41, queueOwnerId: 41,
    captureAecResetGeneration: 0, nativeResetGenerationDomain: 'native-capture-owner',
    queueGenerationDomain: 'capture-queue-ledger', resetGenerationDomain: 'aec-diagnostic-tap', resetGeneration: 0,
    queueGeneration: generation, qpc100ns: 10000000, ledgerError: null,
    ledgerLastKnownHeadByte: head, ledgerLastKnownTailByte: tail, ...extra });
  const intersections = (start, end) => spans.flatMap(p => {
    const left = Math.max(start, p.startByte), right = Math.min(end, p.endByte);
    return left < right ? [{ packetId: p.packetId, startByte: left, endByte: right,
      packetOffsetStartByte: left - p.startByte, packetOffsetEndByte: right - p.startByte }] : [];
  });
  for (let index = 0; index < captures.length;) {
    // An eager batch contains multiple chunks; the final chunk is a real tail.
    const count = Math.min(2, captures.length - index - 1) || 1;
    const group = captures.slice(index, index + count);
    for (const c of group) {
      const bytes = c.preSampleCount * 4;
      const sizes = packetId === 0 ? [768, bytes - 768] : [bytes];
      for (const size of sizes) {
        const before = tail - head, start = tail, genBefore = generation;
        tail += size; generation += 1; packetId += 1;
        spans.push({ packetId, startByte: start, endByte: tail });
        additions.push(common('native-capture-packet', { requestedEndpointId: 'requested-native-endpoint',
          packetId, rawFrameCount: size / 8, rawByteCount: size, blockAlignBytes: 8,
          rawPacketDeviceFrameIndex: start / 8, rawPacketQpc100ns: Math.round(10000000 + start / 8 * 10000000 / 48000),
          observedQpc100ns: 10000000, dataDiscontinuity: false, silent: false, timestampError: false,
          queuedBytesBeforeRead: before, queuedBytesAfterRead: tail - head,
          appendStartByte: start, appendEndByte: tail, queueGenerationBefore: genBefore, queueGenerationAfter: generation }));
        additions.push(common('native-capture-queue-clock', { packetId, invalidPrefixBytes: 0,
          invalidPrefixStartByte: head, invalidPrefixEndByte: head, invalidPrefixPacketRanges: [],
          packetClockValid: true, queueHeadClockValidForNextChunk: true }));
      }
    }
    const start = head, bytes = group.reduce((n, c) => n + c.preSampleCount * 4, 0), genBefore = generation;
    const packetRanges = intersections(start, start + bytes);
    head += bytes; generation += 1; dequeueId += 1;
    const isTail = index + count === captures.length;
    additions.push(common('native-capture-queue-dequeue', { dequeueKind: isTail ? 'partial-tail' : 'full-chunk-batch',
      dequeueId, dequeueStartByte: start, dequeueEndByte: head, dequeuedBytes: bytes,
      queuedBytesBefore: tail - start, queuedBytesAfter: tail - head,
      chunkByteLength: isTail ? null : group[0].preSampleCount * 4, chunkCount: count,
      queueGenerationBefore: genBefore, queueGenerationAfter: generation, packetRanges }));
    let offset = start;
    for (const [chunkIndex, c] of group.entries()) {
      const size = c.preSampleCount * 4;
      additions.push(common('native-capture-queue-input', { dequeueId, chunkIndex,
        inputStartByte: offset, inputEndByte: offset + size, inputByteCount: size,
        packetRanges: intersections(offset, offset + size), captureIdentityAvailable: true, dequeueMappingAvailable: true,
        mainCaptureSequence: c.sequence, mainCaptureResetGeneration: c.resetGeneration,
        mainCapturePostSampleOffset: c.postSampleOffset, timestampError: c.timestampError,
        dataDiscontinuity: c.dataDiscontinuity, queueHeadClockValid: c.queueHeadClockValid }));
      offset += size;
    }
    spans = spans.filter(p => p.endByte > head); index += count;
  }
  f.base.push({ schemaVersion: 3, kind: 'reset', sequence: f.base.length, resetGeneration: 1,
    continuityId: 0, qpc100ns: 30000000, reason: 'diagnostic-final-reset' });
  Object.assign(f.terminal, { attemptedEvents: f.base.length, acceptedEvents: f.base.length, writtenEvents: f.base.length,
    lastAttemptedSequence: f.base.length - 1, lastWrittenSequence: f.base.length - 1, resetGeneration: 1 });
  f.terminal.eventCounts.reset = 1; f.saveEvents('base');
  additions.push(common('native-capture-queue-reset', { reason: 'diagnostic-final-reset', succeeded: true, error: null,
    captureAecResetGeneration: 1, captureAecResetGenerationBefore: 0, captureAecResetGenerationAfter: 1,
    resetGeneration: 1, queueGenerationBefore: generation, queueGenerationAfter: generation,
    queuedBytes: 0, retainedPacketRanges: [] }));
  f.side.push(...additions);
  f.saveQueue = () => {
    f.side.forEach((e, i) => { e.sequence = i; });
    Object.assign(f.seal, { attemptedEvents: f.side.length, acceptedEvents: f.side.length, writtenEvents: f.side.length,
      lifecycleEvents: f.side.filter(e => !['physical-output', 'provider-input'].includes(e.kind)).length });
    f.saveEvents('side');
  };
  f.saveQueue(); return f;
}

test('sealed queue ledger binds short appends, eager batch chunks and tail to actual main captures', (t) => {
  const f = queueFixture(t); const result = buildAecClosedLoopEvidence(f.root, f.options);
  assert.equal(result.passed, true, result.violations.join('; '));
  assert.equal(result.releaseEligible, false); assert.equal(result.captureQueueLedger.resolved, true);
  assert.equal(result.captureQueueLedger.inputs, f.base.filter(e => e.kind === 'capture').length);
  assert.equal(result.captureQueueLedger.qualityAcceptance, false);
  assert.equal(result.captureQueueLedger.formalCaptureClockAcceptance, false);
  assert.equal(result.captureQueueLedger.reviewSatisfied, true);
  assert(f.side.some(e => e.kind === 'native-capture-queue-dequeue' && e.chunkCount > 1));
  assert(f.side.some(e => e.kind === 'native-capture-queue-dequeue' && e.dequeueKind === 'partial-tail'));
  assert(f.side.some(e => e.kind === 'native-capture-packet' && e.rawFrameCount === 96));
  const manifest = createAecClosedLoopManifest(f.root, { cell: f.identity, freezePublicKey: f.publicKey });
  assert.equal(manifest.passed, true, manifest.violations.join('; '));
});

test('queue kinds reject authority/domain/identity failures independently', async (t) => {
  const mutations = [
    ['diagnostic authority', e => { e.qualityAcceptance = true; }],
    ['native domain', e => { e.nativeResetGenerationDomain = 'aec-diagnostic-tap'; }],
    ['queue domain', e => { e.queueGenerationDomain = 'tail-admission'; }],
    ['tap domain', e => { e.resetGenerationDomain = 'native-capture-owner'; }],
    ['owner unavailable', e => { e.captureOwnerId = null; }],
    ['queue owner substitution', e => { e.queueOwnerId += 1; }],
    ['endpoint unavailable', e => { e.endpointId = null; }],
    ['endpoint substitution', e => { e.endpointId = 'other-endpoint'; }],
    ['sticky ledger error', e => { e.ledgerError = 'packet-span-retention-bound'; }],
    ['missing ledger error field', e => { delete e.ledgerError; }],
    ['unsafe byte integer', e => { e.ledgerLastKnownTailByte = Number.MAX_SAFE_INTEGER + 1; }],
    ['unreceipted native reset', e => { e.captureAecResetGeneration += 1; }],
  ];
  for (const kind of ['native-capture-queue-dequeue', 'native-capture-queue-clock', 'native-capture-queue-reset', 'native-capture-queue-input']) {
    for (const [name, mutate] of mutations) await t.test(kind + ' / ' + name, (t) => {
      const f = queueFixture(t); mutate(f.side.find(e => e.kind === kind)); f.saveQueue(); fails(f, /queue/);
    });
  }
});

test('queue append/dequeue/old-prefix evidence rejects invented or omitted ranges', async (t) => {
  const checks = [
    ['append range', f => { f.side.find(e => e.kind === 'native-capture-packet').appendStartByte += 8; }],
    ['append packet replay', f => { f.side.filter(e => e.kind === 'native-capture-packet')[1].packetId = 1; }],
    ['append generation', f => { f.side.find(e => e.kind === 'native-capture-packet').queueGenerationAfter += 1; }],
    ['append owner unknown', f => { f.side.find(e => e.kind === 'native-capture-packet').captureOwnerId = null; }],
    ['dequeue missing', f => { const i = f.side.findIndex(e => e.kind === 'native-capture-queue-dequeue'); f.side.splice(i, 1); }],
    ['dequeue wrong range', f => { f.side.find(e => e.kind === 'native-capture-queue-dequeue').dequeueStartByte += 8; }],
    ['dequeue byte count', f => { f.side.find(e => e.kind === 'native-capture-queue-dequeue').dequeuedBytes += 8; }],
    ['dequeue generation', f => { f.side.find(e => e.kind === 'native-capture-queue-dequeue').queueGenerationBefore += 1; }],
    ['dequeue packet substitution', f => { f.side.find(e => e.kind === 'native-capture-queue-dequeue').packetRanges[0].packetId += 1; }],
    ['dequeue packet offset', f => { f.side.find(e => e.kind === 'native-capture-queue-dequeue').packetRanges[0].packetOffsetEndByte += 8; }],
    ['dequeue packet omission', f => { f.side.find(e => e.kind === 'native-capture-queue-dequeue').packetRanges.shift(); }],
    ['dequeue chunk count', f => { f.side.find(e => e.kind === 'native-capture-queue-dequeue').chunkCount += 1; }],
    ['missing clock receipt', f => { for (let i = f.side.length - 1; i >= 0; i -= 1) if (f.side[i].kind === 'native-capture-queue-clock') f.side.splice(i, 1); }],
    ['old-prefix invented packet', f => { f.side.find(e => e.kind === 'native-capture-queue-clock').invalidPrefixPacketRanges = [{ packetId: 1, startByte: 0, endByte: 8, packetOffsetStartByte: 0, packetOffsetEndByte: 8 }]; }],
    ['old-prefix wrong head', f => { const e = f.side.find(e => e.kind === 'native-capture-queue-clock'); e.invalidPrefixStartByte = 8; e.invalidPrefixEndByte = 8; }],
    ['old-prefix validity lie', f => { f.side.find(e => e.kind === 'native-capture-queue-clock').queueHeadClockValidForNextChunk = false; }],
    ['tail not actually dequeued', f => { const i = f.side.findIndex(e => e.kind === 'native-capture-queue-dequeue' && e.dequeueKind === 'partial-tail'); f.side.splice(i); }],
    ['retention beyond bound', f => { const e = f.side.find(e => e.kind === 'native-capture-queue-dequeue'); e.packetRanges = Array(2049).fill(e.packetRanges[0]); }],
  ];
  for (const [name, mutate] of checks) await t.test(name, (t) => {
    const f = queueFixture(t); mutate(f); f.saveQueue(); fails(f, /queue/);
  });
});

test('queue input must use exact sealed capture identity and byte/dequeue mapping, never latest flags', async (t) => {
  const checks = [
    ['missing capture sequence', e => { delete e.mainCaptureSequence; }],
    ['null capture sequence', e => { e.mainCaptureSequence = null; }],
    ['identity availability false', e => { e.captureIdentityAvailable = false; }],
    ['dequeue availability false', e => { e.dequeueMappingAvailable = false; }],
    ['noncapture sequence', e => { e.mainCaptureSequence = 0; }],
    ['nonexistent sealed capture', e => { e.mainCaptureSequence = 100000; }],
    ['unsafe sealed capture sequence', e => { e.mainCaptureSequence = Number.MAX_SAFE_INTEGER + 1; }],
    ['null main reset identity', e => { e.mainCaptureResetGeneration = null; }],
    ['null main sample offset', e => { e.mainCapturePostSampleOffset = null; }],
    ['wrong main reset generation', e => { e.mainCaptureResetGeneration += 1; }],
    ['wrong main sample offset', e => { e.mainCapturePostSampleOffset += 2; }],
    ['wrong dequeue', e => { e.dequeueId += 1; }],
    ['wrong chunk index', e => { e.chunkIndex += 1; }],
    ['wrong input length', e => { e.inputByteCount -= 8; e.inputEndByte -= 8; }],
    ['packet offset substitution', e => { e.packetRanges[0].packetOffsetStartByte += 8; e.packetRanges[0].packetOffsetEndByte += 8; }],
    ['actual flags mismatch', e => { e.timestampError = true; }],
  ];
  for (const [name, mutate] of checks) await t.test(name, (t) => {
    const f = queueFixture(t); mutate(f.side.find(e => e.kind === 'native-capture-queue-input')); f.saveQueue();
    fails(f, /queue/);
    const manifest = createAecClosedLoopManifest(f.root, { cell: f.identity, freezePublicKey: f.publicKey });
    assert.equal(manifest.passed, false); assert.match(manifest.violations.join('; '), /queue/);
  });
  await t.test('capture replay across distinct dequeues', (t) => {
    const f = queueFixture(t); const inputs = f.side.filter(e => e.kind === 'native-capture-queue-input');
    inputs[1].mainCaptureSequence = inputs[0].mainCaptureSequence;
    inputs[1].mainCapturePostSampleOffset = inputs[0].mainCapturePostSampleOffset;
    f.saveQueue(); fails(f, /queue/);
  });
  await t.test('duplicate dequeue input', (t) => {
    const f = queueFixture(t); const i = f.side.findIndex(e => e.kind === 'native-capture-queue-input');
    f.side.splice(i + 1, 0, structuredClone(f.side[i])); f.saveQueue(); fails(f, /queue/);
  });
  await t.test('missing final capture receipt', (t) => {
    const f = queueFixture(t); const i = f.side.findLastIndex(e => e.kind === 'native-capture-queue-input');
    f.side.splice(i, 1); f.saveQueue(); fails(f, /queue/);
  });
});

test('queue resets cannot clear bytes, forge owner increments or replace actual main resets', async (t) => {
  const mutations = [
    ['failed reset', e => { e.succeeded = false; e.error = 'actual reset failed'; }],
    ['fake native increment', e => { e.captureAecResetGenerationAfter = 2; e.captureAecResetGeneration = 2; }],
    ['fake queue clear generation', e => { e.queueGenerationAfter += 1; e.queueGeneration += 1; }],
    ['wrong before native owner generation', e => { e.captureAecResetGenerationBefore = 1; }],
    ['wrong retained bytes', e => { e.queuedBytes = 8; }],
    ['wrong actual main reset', e => { e.resetGeneration = 0; }],
    ['missing actual main reason', e => { e.reason = 'invented-reset'; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, (t) => {
    const f = queueFixture(t); mutate(f.side.find(e => e.kind === 'native-capture-queue-reset')); f.saveQueue(); fails(f, /queue/);
  });
});

test('route-start is an actual main reset with native 0-to-0, not a forged native/tap identity', (t) => {
  const f = queueFixture(t);
  // Insert a real sealed main reset, preserving contiguous journal generation
  // and every existing formal render/provider/source-clock authority.
  for (const e of f.base) { e.sequence += 1; e.resetGeneration += 1; }
  f.base.unshift({ schemaVersion: 3, kind: 'reset', sequence: 0, resetGeneration: 1,
    continuityId: 0, qpc100ns: 9600000, reason: 'route-start' });
  Object.assign(f.terminal, { attemptedEvents: f.base.length, acceptedEvents: f.base.length, writtenEvents: f.base.length,
    lastAttemptedSequence: f.base.length - 1, lastWrittenSequence: f.base.length - 1, resetGeneration: 2 });
  f.terminal.eventCounts.reset = 2; f.saveEvents('base');
  for (const e of f.side) {
    if (Number.isSafeInteger(e.resetGeneration)) e.resetGeneration += 1;
    if (e.kind === 'native-capture-queue-input') { e.mainCaptureSequence += 1; e.mainCaptureResetGeneration += 1; }
  }
  for (const e of f.manifest.stages) e.resetGeneration += 1;
  f.authority.aecClosedLoop.stages = structuredClone(f.manifest.stages); f.saveManifest();
  const routeStart = { ...f.side.find(e => e.kind === 'native-capture-queue-reset'), reason: 'route-start',
    qpc100ns: 9600000, resetGeneration: 1, captureAecResetGeneration: 0,
    captureAecResetGenerationBefore: 0, captureAecResetGenerationAfter: 0,
    queueGeneration: 0, queueGenerationBefore: 0, queueGenerationAfter: 0,
    ledgerLastKnownHeadByte: 0, ledgerLastKnownTailByte: 0 };
  f.side.unshift(routeStart); f.saveQueue();
  const r = buildAecClosedLoopEvidence(f.root, f.options);
  assert.equal(r.passed, true, r.violations.join('; ')); assert.equal(r.captureQueueLedger.resolved, true);
  routeStart.captureAecResetGenerationAfter = 1; routeStart.captureAecResetGeneration = 1;
  f.saveQueue(); fails(f, /queue.*reset/);
});

test('native-only partial upgraded ledger and duplicate real-reset receipts cannot claim completeness', async (t) => {
  await t.test('remove all queue kinds but keep upgraded packet ranges', (t) => {
    const f = queueFixture(t);
    for (let i = f.side.length - 1; i >= 0; i -= 1) if (f.side[i].kind.startsWith('native-capture-queue-')) f.side.splice(i, 1);
    f.saveQueue(); fails(f, /queue/);
  });
  await t.test('duplicate exact reset receipt', (t) => {
    const f = queueFixture(t); f.side.push(structuredClone(f.side.find(e => e.kind === 'native-capture-queue-reset')));
    f.saveQueue(); fails(f, /queue/);
  });
  await t.test('repeated initial clock cannot mask old prefix without consumption', (t) => {
    const f = queueFixture(t); const clocks = f.side.filter(e => e.kind === 'native-capture-queue-clock');
    clocks[0].invalidPrefixBytes = 768; clocks[0].invalidPrefixEndByte = 768;
    clocks[0].queueHeadClockValidForNextChunk = false;
    clocks[0].invalidPrefixPacketRanges = [{ packetId: 1, startByte: 0, endByte: 768, packetOffsetStartByte: 0, packetOffsetEndByte: 768 }];
    f.side.find(e => e.kind === 'native-capture-packet').timestampError = true;
    clocks[0].packetClockValid = false;
    // The first clock is justified by the real raw error; the next clean append
    // still must not erase its old prefix without actual input consumption.
    f.saveQueue(); fails(f, /queue clock.*native packet replay/);
  });
});

test('old no-ledger sealed evidence remains diagnostic-compatible but fails new ledger review', (t) => {
  const f = fixture(t); const r = buildAecClosedLoopEvidence(f.root, f.options);
  assert.equal(r.passed, true, r.violations.join('; '));
  assert.equal(r.captureQueueLedger.status, 'legacy-diagnostic-only');
  assert.equal(r.captureQueueLedger.resolved, false); assert.equal(r.captureQueueLedger.reviewSatisfied, false);
  assert.equal(r.captureQueueLedger.qualityAcceptance, false);
  assert.equal(r.captureQueueLedger.formalCaptureClockAcceptance, false);
});

test('metadata resource cap supports the bounded 180s ledger budget without dropping events', (t) => {
  assert.equal(AEC_CLOSED_LOOP_METADATA_MAX_BYTES, 128 * 1024 * 1024);
  const budget = 18000 * 1024 * 2 + 9000 * 1536 * 2 + 17 * 1024 * 1024;
  assert(budget > 64 * 1024 * 1024 && budget < AEC_CLOSED_LOOP_METADATA_MAX_BYTES);
  const f = queueFixture(t); const file = path.join(f.root, sideNames.metadata);
  const original = fs.readFileSync(file);
  // JSON whitespace exercises only the byte-resource bound. All real fixture
  // events and sealed sequence counts remain intact, with no event thinning.
  const bytes = Buffer.concat([original.subarray(0, -1), Buffer.alloc(65 * 1024 * 1024, 0x20), Buffer.from('\n')]);
  fs.writeFileSync(file, bytes); f.seal.files.metadata.byteLength = bytes.length;
  f.seal.files.metadata.sha256 = sha(bytes);
  fs.writeFileSync(path.join(f.root, 'aec-closed-loop-terminal.json'), JSON.stringify(f.seal));
  const r = buildAecClosedLoopEvidence(f.root, f.options);
  assert.equal(r.passed, true, r.violations.join('; ')); assert.equal(r.captureQueueLedger.reviewSatisfied, true);
  assert.equal(r.captureQueueLedger.inputs, f.base.filter(e => e.kind === 'capture').length);
});

test('metadata exceeding 128MiB fails before read/hash/parse, never silently truncates events', (t) => {
  const f = fixture(t); const file = path.join(f.root, sideNames.metadata);
  fs.truncateSync(file, AEC_CLOSED_LOOP_METADATA_MAX_BYTES + 1);
  fails(f, /invalid aec-closed-loop-metadata\.jsonl size\/type/);
});


test('exported local ledger validator requires real ledger only when explicitly requested', (t) => {
  const old = fixture(t);
  const diagnostic = validateCaptureQueueLedger(old.side, old.base);
  assert.equal(diagnostic.status, 'legacy-diagnostic-only');
  assert.equal(diagnostic.reviewSatisfied, false); assert.equal(diagnostic.required, false);
  assert.throws(() => validateCaptureQueueLedger(old.side, old.base, { required: true }), /complete capture queue.*required/);
  const f = queueFixture(t); const r = validateCaptureQueueLedger(f.side, f.base, { required: true });
  assert.equal(r.required, true); assert.equal(r.reviewSatisfied, true);
  assert.equal(r.inputs, f.base.filter(e => e.kind === 'capture').length);
  assert.equal(r.qualityAcceptance, false); assert.equal(r.formalCaptureClockAcceptance, false);
  assert.equal(AEC_CAPTURE_QUEUE_WITNESS_POLICY, 'owner-range-time-segments-v2');
});

test('exported validator refuses absent or forged main receipts and incomplete capture coverage', async (t) => {
  for (const field of ['mainCaptureSequence', 'mainCaptureResetGeneration', 'mainCapturePostSampleOffset']) {
    await t.test(field, (t) => {
      const f = queueFixture(t); f.side.find(e => e.kind === 'native-capture-queue-input')[field] = null;
      assert.throws(() => validateCaptureQueueLedger(f.side, f.base, { required: true }), /actual capture identity.*unavailable/);
    });
  }
  await t.test('extra sealed main capture has no input', (t) => {
    const f = queueFixture(t); const capture = structuredClone(f.base.find(e => e.kind === 'capture'));
    Object.assign(capture, { sequence: f.base.length, resetGeneration: f.base.at(-1).resetGeneration });
    f.base.push(capture);
    assert.throws(() => validateCaptureQueueLedger(f.side, f.base, { required: true }), /queue ledger incomplete/);
  });
  await t.test('duplicate main capture sequence cannot hide in map', (t) => {
    const f = queueFixture(t); const captures = f.base.filter(e => e.kind === 'capture');
    captures[1].sequence = captures[0].sequence;
    assert.throws(() => validateCaptureQueueLedger(f.side, f.base, { required: true }), /main journal sequence/);
  });
  await t.test('missing main journal is never a receipt', (t) => {
    const f = queueFixture(t);
    assert.throws(() => validateCaptureQueueLedger(f.side, undefined, { required: true }), /snapshots missing/);
  });
});

test('required option blocks builder, verifier and manifest creation for old reports before analyzer work', (t) => {
  const f = fixture(t); const options = { ...f.options, requireCaptureQueueLedger: true };
  for (const r of [buildAecClosedLoopEvidence(f.root, options), verifyAecClosedLoopEvidence(f.root, options),
    createAecClosedLoopManifest(f.root, { cell: f.identity, freezePublicKey: f.publicKey, requireCaptureQueueLedger: true })]) {
    assert.equal(r.passed, false); assert.match(r.violations.join('; '), /complete capture queue.*required/);
    assert.equal(r.captureQueueLedger.reviewSatisfied, false); assert.equal(r.captureQueueLedger.required, true);
  }
});

test('complete ledger satisfies explicit required builder and manifest structure without granting quality', (t) => {
  const f = queueFixture(t);
  const r = buildAecClosedLoopEvidence(f.root, { ...f.options, requireCaptureQueueLedger: true });
  assert.equal(r.passed, true, r.violations.join('; ')); assert.equal(r.releaseEligible, false);
  assert.equal(r.captureQueueLedger.required, true); assert.equal(r.captureQueueLedger.reviewSatisfied, true);
  const m = createAecClosedLoopManifest(f.root, { cell: f.identity, freezePublicKey: f.publicKey, requireCaptureQueueLedger: true });
  assert.equal(m.passed, true, m.violations.join('; ')); assert.equal(m.captureQueueLedger.required, true);
});

test('signed frozen queue policy enforces complete ledger despite caller false', async (t) => {
  await t.test('old report cannot downgrade frozen policy', (t) => {
    const f = fixture(t); f.pinQueuePolicy();
    for (const r of [buildAecClosedLoopEvidence(f.root, { ...f.options, requireCaptureQueueLedger: false }),
      verifyAecClosedLoopEvidence(f.root, { ...f.options, requireCaptureQueueLedger: false }),
      createAecClosedLoopManifest(f.root, { cell: f.identity, freezePublicKey: f.publicKey, requireCaptureQueueLedger: false })]) {
      assert.equal(r.passed, false); assert.match(r.violations.join('; '), /complete capture queue.*required/);
      assert.equal(r.captureQueueLedger.required, true);
    }
  });
  await t.test('complete frozen ledger passes structural review', (t) => {
    const f = queueFixture(t); upgradeTimeSegments(f); f.pinQueuePolicy();
    const r = buildAecClosedLoopEvidence(f.root, { ...f.options, requireCaptureQueueLedger: false });
    assert.equal(r.passed, true, r.violations.join('; ')); assert.equal(r.captureQueueLedger.required, true);
    const m = createAecClosedLoopManifest(f.root, { cell: f.identity, freezePublicKey: f.publicKey });
    assert.equal(m.passed, true, m.violations.join('; '));
  });
  await t.test('unknown signed policy is not legacy opt-out', (t) => {
    const f = queueFixture(t); f.pinQueuePolicy('owner-range-receipt-v999');
    const r = buildAecClosedLoopEvidence(f.root, f.options);
    assert.equal(r.passed, false); assert.match(r.violations.join('; '), /unknown capture queue witness policy/);
  });
});

test('diagnostic wrapper keeps required legacy projection and refuses malformed option/policy', (t) => {
  const f = fixture(t);
  const old = verifyCaptureQueueLedgerEvidence(f.side, f.base);
  assert.equal(old.passed, true); assert.equal(old.captureQueueLedger.reviewSatisfied, false);
  const required = verifyCaptureQueueLedgerEvidence(f.side, f.base, { requireCaptureQueueLedger: true });
  assert.equal(required.passed, false); assert.equal(required.captureQueueLedger.status, 'legacy-diagnostic-only');
  assert.equal(required.releaseEligible, false);
  const frozen = verifyCaptureQueueLedgerEvidence(f.side, f.base,
    { requireCaptureQueueLedger: false, captureQueueWitnessPolicy: AEC_CAPTURE_QUEUE_WITNESS_POLICY });
  assert.equal(frozen.passed, false); assert.equal(frozen.captureQueueLedger.required, true);
  for (const bad of [{ requireCaptureQueueLedger: 'true' }, { captureQueueWitnessPolicy: null }]) {
    assert.equal(verifyCaptureQueueLedgerEvidence(f.side, f.base, bad).passed, false);
  }
  assert.throws(() => validateCaptureQueueLedger(f.side, f.base, { required: 'true' }), /must be boolean/);
});


test('review regression: native packet observation cannot be replaced by a clean clock declaration', async (t) => {
  const cases = [
    ['timestamp-error packet', p => { p.timestampError = true; }],
    ['queue-head raw frame index underflow', p => { p.rawPacketDeviceFrameIndex = p.queuedBytesBeforeRead / 8 - 1; }],
    ['queue-head raw QPC underflow', p => { p.rawPacketQpc100ns = Math.floor(p.queuedBytesBeforeRead / 8 * 10000000 / 48000) - 1; }],
    ['discontinuity cannot erase the old prefix', p => { p.dataDiscontinuity = true; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, (t) => {
    const f = queueFixture(t);
    assert.equal(validateCaptureQueueLedger(f.side, f.base, { required: true }).resolved, true);
    const packet = f.side.filter(e => e.kind === 'native-capture-packet')[1];
    assert(packet.queuedBytesBeforeRead > 0);
    const clock = f.side.find(e => e.kind === 'native-capture-queue-clock' && e.packetId === packet.packetId);
    assert.equal(clock.invalidPrefixBytes, 0); assert.equal(clock.packetClockValid, true);
    mutate(packet); f.saveQueue();
    // Every seal/hash and all explicit clock fields remain otherwise valid.
    // Raw WASAPI observation must independently refute this forged clean clock.
    assert.throws(() => validateCaptureQueueLedger(f.side, f.base, { required: true }), /queue clock.*native packet replay/);
  });
});

test('review regression: FIFO inputs cannot swap complete main identity triples or batch order', async (t) => {
  for (const [name, second] of [['same batch', 1], ['across batches', 2]]) await t.test(name, (t) => {
    const f = queueFixture(t); const inputs = f.side.filter(e => e.kind === 'native-capture-queue-input');
    const first = inputs[0], other = inputs[second];
    assert.equal(first.inputByteCount, other.inputByteCount);
    for (const flag of ['timestampError', 'dataDiscontinuity', 'queueHeadClockValid']) assert.equal(first[flag], other[flag]);
    for (const key of ['mainCaptureSequence', 'mainCaptureResetGeneration', 'mainCapturePostSampleOffset']) {
      [first[key], other[key]] = [other[key], first[key]];
    }
    f.saveQueue();
    assert.throws(() => validateCaptureQueueLedger(f.side, f.base, { required: true }), /queue input.*FIFO/);
  });
  await t.test('batch chunk one cannot be consumed before chunk zero', (t) => {
    const f = queueFixture(t); const first = f.side.findIndex(e => e.kind === 'native-capture-queue-input');
    assert.equal(f.side[first].dequeueId, f.side[first + 1].dequeueId);
    assert.equal(f.side[first].chunkIndex, 0); assert.equal(f.side[first + 1].chunkIndex, 1);
    [f.side[first], f.side[first + 1]] = [f.side[first + 1], f.side[first]];
    f.saveQueue();
    assert.throws(() => validateCaptureQueueLedger(f.side, f.base, { required: true }), /queue input.*FIFO/);
  });
});


test('native replay permits a discontinuous or silent packet to anchor its own bytes', (t) => {
  const f = queueFixture(t); const packet = f.side.find(e => e.kind === 'native-capture-packet');
  assert.equal(packet.queuedBytesBeforeRead, 0); packet.dataDiscontinuity = true; packet.silent = true;
  // No old prefix exists; neither discontinuity nor silence invalidates this
  // packet's own anchor. A later clean packet supplies the actual input flags.
  f.saveQueue();
  const r = validateCaptureQueueLedger(f.side, f.base, { required: true });
  assert.equal(r.reviewSatisfied, true); assert.equal(r.formalCaptureClockAcceptance, false);
});

test('native replay preserves old prefixes then recovers after actual FIFO input consumption', async (t) => {
  for (const scenario of ['discontinuity-old-prefix', 'timestamp-error-old-prefix']) await t.test(scenario, (t) => {
    const f = queueFixture(t); const packets = f.side.filter(e => e.kind === 'native-capture-packet');
    const clocks = f.side.filter(e => e.kind === 'native-capture-queue-clock');
    if (scenario === 'discontinuity-old-prefix') packets[1].dataDiscontinuity = true;
    else packets[0].timestampError = true;
    const startClock = scenario === 'discontinuity-old-prefix' ? 1 : 0;
    for (let i = startClock; i <= 2; i += 1) {
      Object.assign(clocks[i], { invalidPrefixBytes: 768, invalidPrefixStartByte: 0,
        invalidPrefixEndByte: 768, queueHeadClockValidForNextChunk: false,
        packetClockValid: !(scenario === 'timestamp-error-old-prefix' && i === 0),
        invalidPrefixPacketRanges: [{ packetId: 1, startByte: 0, endByte: 768,
          packetOffsetStartByte: 0, packetOffsetEndByte: 768 }] });
    }
    const inputs = f.side.filter(e => e.kind === 'native-capture-queue-input');
    assert.equal(inputs[0].dequeueId, inputs[1].dequeueId);
    inputs[0].queueHeadClockValid = false;
    f.base.find(e => e.kind === 'capture').queueHeadClockValid = false;
    // The first real chunk consumes 768 invalid bytes (saturating subtraction),
    // the next chunk in the SAME eager batch is valid without another packet.
    assert.equal(inputs[1].queueHeadClockValid, true); assert.equal(clocks[3].invalidPrefixBytes, 0);
    f.saveQueue();
    const r = validateCaptureQueueLedger(f.side, f.base, { required: true });
    assert.equal(r.resolved, true); assert.equal(r.inputs, inputs.length);
  });
});

test('native replay accepts exact frame and floor-QPC anchor boundaries without QPC reanchoring', (t) => {
  const f = queueFixture(t); const p = f.side.filter(e => e.kind === 'native-capture-packet')[1];
  p.rawPacketDeviceFrameIndex = p.queuedBytesBeforeRead / 8;
  p.rawPacketQpc100ns = Number(BigInt(p.queuedBytesBeforeRead / 8) * 10000000n / 48000n);
  f.saveQueue(); assert.equal(validateCaptureQueueLedger(f.side, f.base, { required: true }).resolved, true);
});

test('time-segment strict evidence cannot upgrade a v1 owner/range ledger', (t) => {
  const f = queueFixture(t);
  assert.throws(() => validateCaptureQueueLedger(f.side, f.base, { required: true, requireTimeSegments: true }), /time.segment/);
});

function upgradeTimeSegments(f) {
  for (const c of f.base.filter(e=>e.kind==='capture')) {
    const frames=c.preSampleCount/2;
    c.aecProcessing={schemaVersion:1,inputFrames:frames,native10msFrames:Math.ceil(frames/480),
      mathPaddingFrames:Math.ceil(frames/480)*480-frames,allInputProcessed:true,resetBeforeResumeRequired:false,tailAdmission:null};
  }
  f.saveEvents('base');
  let previous = null;
  for (const e of f.side) {
    if (e.kind === 'native-capture-packet') {
      Object.assign(e, {captureTimeSegmentId:1,captureTimeBoundaryId:null,captureTimeBoundaryReason:null,
        captureTimePreviousEndDeviceFrameIndex:previous ? previous.rawPacketDeviceFrameIndex+previous.rawFrameCount : null,
        captureTimePreviousPacketTimestampError:previous ? previous.timestampError : null,
        captureTimeQueueGeneration:e.queueGenerationAfter}); previous=e;
    } else if (e.kind === 'native-capture-queue-clock') {
      e.captureClockPrefixBytesAtPrepare = previous.queuedBytesBeforeRead;
    }
  }
  f.saveQueue(); return f;
}

test('v2 no-boundary ledger validates segments without upgrading clock or quality', (t) => {
  const f = upgradeTimeSegments(queueFixture(t));
  const r = validateCaptureQueueLedger(f.side,f.base,{required:true,requireTimeSegments:true});
  assert.equal(r.schemaVersion,2);assert.equal(r.timeSegmentsValidated,true);
  assert.equal(r.qualityAcceptance,false);assert.equal(r.formalCaptureClockAcceptance,false);
  for (const mutate of [e=>{e.captureTimeSegmentId+=1;},e=>{e.captureTimeQueueGeneration+=1;},
    e=>{delete e.captureTimePreviousPacketTimestampError;},e=>{e.captureTimeBoundaryId=1;},
    e=>{e.captureTimeBoundaryReason='device-frame-gap';}]) {
    const rows=structuredClone(f.side); mutate(rows.find(e=>e.kind==='native-capture-packet'));
    assert.throws(()=>validateCaptureQueueLedger(rows,f.base,{requireTimeSegments:true}),/time-segment/);
  }
  const rows=structuredClone(f.side);rows.find(e=>e.kind==='native-capture-queue-clock').captureClockPrefixBytesAtPrepare=8;
  assert.throws(()=>validateCaptureQueueLedger(rows,f.base,{requireTimeSegments:true}),/prefixAtPrepare/);
});

function timeBoundaryFixture(t,frames=480) {
  const f=queueFixture(t); const bytes=frames*8; const nextBytes=960*8;
  const identity=f.side.find(e=>e.kind==='native-capture-packet');
  const capture=structuredClone(f.base.find(e=>e.kind==='capture'));
  const main=[{...capture,sequence:0,resetGeneration:0,preSampleCount:frames*2,postSampleCount:frames*2,
    postSampleOffset:0,timestampError:false,dataDiscontinuity:false,queueHeadClockValid:true,
    rawPacketDeviceFrameIndex:0,rawPacketQpc100ns:10000000,queueHeadDeviceFrameIndex:0,queueHeadQpc100ns:10000000,
    aecProcessing:{schemaVersion:2,inputFrames:frames,native10msFrames:Math.ceil(frames/480),
      mathPaddingFrames:Math.ceil(frames/480)*480-frames,allInputProcessed:true,resetBeforeResumeRequired:true,tailAdmission:null,
      boundaryAdmission:{schemaVersion:1,captureOwnerId:identity.captureOwnerId,queueGeneration:2,boundaryId:1,
        closedSegmentId:1,nextSegmentId:2,byteLen:bytes,realFrames:frames,boundaryReason:'device-frame-gap',
        oldSegmentStartDeviceFrameIndex:0,oldSegmentStartQpc100ns:10000000,oldSegmentEndDeviceFrameIndex:frames,
        nextPacketDeviceFrameIndex:1000,nextPacketQpc100ns:11000000,nextPacketDataDiscontinuity:false,nextPacketTimestampError:false,previousPacketTimestampError:false}}},
    {schemaVersion:3,kind:'reset',sequence:1,resetGeneration:1,reason:'capture-packet-time-boundary'},
    {...capture,sequence:2,resetGeneration:1,preSampleCount:1920,postSampleCount:1920,postSampleOffset:frames*2,
      timestampError:false,dataDiscontinuity:false,queueHeadClockValid:true,
      aecProcessing:{schemaVersion:1,inputFrames:960,native10msFrames:2,mathPaddingFrames:0,allInputProcessed:true,
        resetBeforeResumeRequired:false,tailAdmission:null}}];
  let generation=0,head=0,tail=0,nativeGeneration=0,resetGeneration=0;const side=[];
  const add=(kind,extra)=>side.push({...identity,kind,sequence:side.length,queueGeneration:generation,
    captureAecResetGeneration:nativeGeneration,resetGeneration,ledgerLastKnownHeadByte:head,ledgerLastKnownTailByte:tail,...extra});
  const append=(packetId,start,frame,qpc,size,segment,boundary)=>{
    const before=tail-head;const gen=generation;tail+=size;generation++;
    add('native-capture-packet',{packetId,rawFrameCount:size/8,rawByteCount:size,rawPacketDeviceFrameIndex:frame,
      rawPacketQpc100ns:qpc,timestampError:false,dataDiscontinuity:false,queuedBytesBeforeRead:before,
      queuedBytesAfterRead:tail-head,appendStartByte:start,appendEndByte:tail,queueGenerationBefore:gen,queueGenerationAfter:generation,
      captureTimeSegmentId:segment,captureTimeBoundaryId:boundary,captureTimeBoundaryReason:boundary?'device-frame-gap':null,
      captureTimePreviousEndDeviceFrameIndex:packetId===1?null:frames,
      captureTimePreviousPacketTimestampError:packetId===1?null:false,captureTimeQueueGeneration:generation});
  };
  const clock=packetId=>add('native-capture-queue-clock',{packetId,invalidPrefixBytes:0,invalidPrefixStartByte:head,
    invalidPrefixEndByte:head,invalidPrefixPacketRanges:[],packetClockValid:true,queueHeadClockValidForNextChunk:true,
    captureClockPrefixBytesAtPrepare:0});
  const consume=(packetId,dequeueId,start,end,kind,c)=>{
    const gen=generation;const before=tail-head;head=end;generation++;
    const packetRanges=[{packetId,startByte:start,endByte:end,packetOffsetStartByte:0,packetOffsetEndByte:end-start}];
    add('native-capture-queue-dequeue',{dequeueKind:kind,dequeueId,dequeueStartByte:start,dequeueEndByte:end,
      dequeuedBytes:end-start,queuedBytesBefore:before,queuedBytesAfter:tail-head,chunkByteLength:kind==='packet-boundary'?null:end-start,
      chunkCount:1,queueGenerationBefore:gen,queueGenerationAfter:generation,packetRanges});
    add('native-capture-queue-input',{dequeueId,chunkIndex:0,inputStartByte:start,inputEndByte:end,inputByteCount:end-start,
      packetRanges,captureIdentityAvailable:true,dequeueMappingAvailable:true,mainCaptureSequence:c.sequence,
      mainCaptureResetGeneration:c.resetGeneration,mainCapturePostSampleOffset:c.postSampleOffset,
      timestampError:false,dataDiscontinuity:false,queueHeadClockValid:true});
  };
  append(1,0,0,10000000,bytes,1,null);clock(1);
  append(2,bytes,1000,11000000,nextBytes,2,1);consume(1,1,0,bytes,'packet-boundary',main[0]);
  nativeGeneration=1;resetGeneration=1;
  add('native-capture-queue-reset',{reason:'capture-packet-time-boundary',succeeded:true,error:null,
    captureAecResetGenerationBefore:0,captureAecResetGenerationAfter:1,queueGenerationBefore:generation,
    queueGenerationAfter:generation,queuedBytes:nextBytes,retainedPacketRanges:[{packetId:2,startByte:bytes,endByte:tail,
      packetOffsetStartByte:0,packetOffsetEndByte:nextBytes}]});
  clock(2);consume(2,2,bytes,tail,'full-chunk-batch',main[2]);
  return {side,main};
}

test('v2 actual voiced old-prefix boundary dequeue/input/reset is causal even at exactly 480 frames', (t) => {
  for(const frames of [96,480,700]) {
    const f=timeBoundaryFixture(t,frames);
    assert.equal(validateCaptureQueueLedger(f.side,f.main,{requireTimeSegments:true}).reviewSatisfied,true);
  }
});

test('v2 boundary counterexamples fail closed without changing v1 diagnostic semantics', async(t)=>{
  const cases=[
    ['forged boundary reason',f=>{f.side.find(e=>e.kind==='native-capture-packet'&&e.packetId===2).captureTimeBoundaryReason='data-discontinuity';}],
    ['forged predecessor flag',f=>{f.main[0].aecProcessing.boundaryAdmission.previousPacketTimestampError=true;}],
    ['missing predecessor flag',f=>{delete f.main[0].aecProcessing.boundaryAdmission.previousPacketTimestampError;}],
    ['swapped boundary',f=>{f.main[0].aecProcessing.boundaryAdmission.boundaryId=2;}],
    ['new packet input bytes',f=>{const e=f.side.find(e=>e.kind==='native-capture-queue-input');e.packetRanges[0].packetId=2;}],
    ['normal dequeue before clock',f=>{const e=f.side.find(e=>e.kind==='native-capture-queue-dequeue');e.dequeueKind='full-chunk-batch';e.chunkByteLength=e.dequeuedBytes;}],
    ['fake retained old metadata',f=>{f.main[0].queueHeadQpc100ns++;}],
    ['fake cleared old flags',f=>{f.side[0].dataDiscontinuity=true;}],
    ['fake old boundary time',f=>{f.main[0].aecProcessing.boundaryAdmission.oldSegmentStartQpc100ns++;}],
    ['boundary quiet-tail laundering',f=>{f.main[0].aecProcessing.schemaVersion=1;}],
    ['missing reset requirement without padding',f=>{f.main[0].aecProcessing.resetBeforeResumeRequired=false;}],
    ['unrelated reset cannot ack boundary',f=>{f.main[1].reason='render-discontinuity';f.side.find(e=>e.kind==='native-capture-queue-reset').reason='render-discontinuity';}],
    ['missing reset',f=>{f.side=f.side.filter(e=>e.kind!=='native-capture-queue-reset');f.side.forEach((e,i)=>e.sequence=i);} ],
    ['eager new clock covers old prefix',f=>{const i=f.side.findIndex(e=>e.kind==='native-capture-queue-clock'&&e.packetId===2);const [clock]=f.side.splice(i,1);f.side.splice(3,0,clock);f.side.forEach((e,i)=>e.sequence=i);} ],
    ['fake segment',f=>{f.side.find(e=>e.kind==='native-capture-packet'&&e.packetId===2).captureTimeSegmentId=1;}],
    ['fake prefix prepare',f=>{f.side.find(e=>e.kind==='native-capture-queue-clock'&&e.packetId===2).captureClockPrefixBytesAtPrepare=480*8;}],
    ['boundary grants invalid clock',f=>{const e=f.side.find(e=>e.kind==='native-capture-queue-clock');e.packetClockValid=false;e.queueHeadClockValidForNextChunk=false;}],
  ];
  for(const [name,mutate]of cases)await t.test(name,t=>{const f=timeBoundaryFixture(t);mutate(f);
    assert.throws(()=>validateCaptureQueueLedger(f.side,f.main,{requireTimeSegments:true}));});
});

test('v2 producer reason priority uses actual flags and preserves invalid old/new clocks',async t=>{
 for(const [reason,oldError,newError,disc] of [
   ['timestamp-error',true,true,true],['timestamp-error',false,true,false],
   ['untrusted-predecessor',true,false,true],['data-discontinuity',false,false,true]]) {
  await t.test(reason+' old='+oldError,t=>{
   const f=timeBoundaryFixture(t);const p1=f.side[0],p2=f.side[2];p1.timestampError=oldError;
   p2.timestampError=newError;p2.dataDiscontinuity=disc;p2.captureTimePreviousPacketTimestampError=oldError;
   p2.captureTimeBoundaryReason=reason;
   const b=f.main[0].aecProcessing.boundaryAdmission;b.boundaryReason=reason;
   b.nextPacketTimestampError=newError;b.nextPacketDataDiscontinuity=disc;b.previousPacketTimestampError=oldError;
   for(const [index,error]of [[1,oldError],[6,newError]]) {
    const e=f.side[index];e.packetClockValid=!error;e.queueHeadClockValidForNextChunk=!error;
    e.invalidPrefixBytes=error?(index===1?480*8:960*8):0;
    e.invalidPrefixEndByte=e.invalidPrefixStartByte+e.invalidPrefixBytes;
    e.invalidPrefixPacketRanges=error?[{packetId:index===1?1:2,startByte:e.invalidPrefixStartByte,endByte:e.invalidPrefixEndByte,
      packetOffsetStartByte:0,packetOffsetEndByte:e.invalidPrefixBytes}]:[];
   }
   for(const [inputIndex,captureIndex,error,discontinuity]of [[4,0,oldError,false],[8,2,newError,disc]]) {
    Object.assign(f.side[inputIndex],{timestampError:error,dataDiscontinuity:discontinuity,queueHeadClockValid:!error});
    Object.assign(f.main[captureIndex],{timestampError:error,dataDiscontinuity:discontinuity,queueHeadClockValid:!error});
   }
   const r=validateCaptureQueueLedger(f.side,f.main,{requireTimeSegments:true});
   assert.equal(r.reviewSatisfied,true);assert.equal(r.formalCaptureClockAcceptance,false);
   p2.captureTimeBoundaryReason='device-frame-gap';
   assert.throws(()=>validateCaptureQueueLedger(f.side,f.main,{requireTimeSegments:true}),/boundary reason/);
  });
 }
});

test('v2 empty-prefix boundary still requires an actual reset ack; first DISC is not a segment transition',t=>{
 const f=timeBoundaryFixture(t);const [p1,c1,p2,d1,i1,r,c2,d2,i2]=f.side;
 Object.assign(d1,{dequeueKind:'full-chunk-batch',chunkByteLength:480*8,queueGenerationBefore:1,queueGenerationAfter:2,
   queueGeneration:2,queuedBytesBefore:480*8,queuedBytesAfter:0,ledgerLastKnownTailByte:480*8});
 Object.assign(i1,{queueGeneration:2,ledgerLastKnownTailByte:480*8});
 Object.assign(p2,{queueGenerationBefore:2,queueGenerationAfter:3,queueGeneration:3,captureTimeQueueGeneration:3,
   queuedBytesBeforeRead:0,queuedBytesAfterRead:960*8,ledgerLastKnownHeadByte:480*8});
 f.main[0].aecProcessing={schemaVersion:1,inputFrames:480,native10msFrames:1,mathPaddingFrames:0,
   allInputProcessed:true,resetBeforeResumeRequired:false,tailAdmission:null};
 p1.dataDiscontinuity=true;i1.dataDiscontinuity=true;f.main[0].dataDiscontinuity=true;
 f.side=[p1,c1,d1,i1,p2,r,c2,d2,i2];f.side.forEach((e,i)=>e.sequence=i);
 assert.equal(validateCaptureQueueLedger(f.side,f.main,{requireTimeSegments:true}).reviewSatisfied,true);
 f.side.splice(5,1);f.side.forEach((e,i)=>e.sequence=i);
 assert.throws(()=>validateCaptureQueueLedger(f.side,f.main,{requireTimeSegments:true}));
});

test('v2 prepare permits first DISC/startup and non-time render resets without inventing a segment',async t=>{
 for(const disc of [true,false])await t.test(disc?'first DISC':'render reset',t=>{
  const f=timeBoundaryFixture(t);const firstResetReason=disc?'wasapi-capture-data-discontinuity':'wasapi-render-session-discontinuity';
  const boundaryReset=f.side[5];const startup={...boundaryReset,reason:firstResetReason,queueGeneration:1,
    queueGenerationBefore:1,queueGenerationAfter:1,captureAecResetGenerationBefore:0,captureAecResetGenerationAfter:1,
    captureAecResetGeneration:1,resetGeneration:1,queuedBytes:480*8,ledgerLastKnownHeadByte:0,ledgerLastKnownTailByte:480*8,
    retainedPacketRanges:[{packetId:1,startByte:0,endByte:480*8,packetOffsetStartByte:0,packetOffsetEndByte:480*8}]};
  f.side[0].dataDiscontinuity=disc;
  f.side[4].dataDiscontinuity=disc;f.main[0].dataDiscontinuity=disc;
  for(const e of f.side.slice(1)) {e.captureAecResetGeneration++;e.resetGeneration++;
    if(e.kind==='native-capture-queue-input'){e.mainCaptureSequence++;e.mainCaptureResetGeneration++;}}
  boundaryReset.captureAecResetGenerationBefore=1;boundaryReset.captureAecResetGenerationAfter=2;
  f.side.splice(1,0,startup);f.side.forEach((e,i)=>e.sequence=i);
  f.main.forEach(e=>{e.sequence++;e.resetGeneration++;});
  f.main.unshift({schemaVersion:3,kind:'reset',sequence:0,resetGeneration:1,reason:firstResetReason});
  assert.equal(validateCaptureQueueLedger(f.side,f.main,{requireTimeSegments:true}).reviewSatisfied,true);
 });
});

test('v2 multi-packet old prefix preserves last prepared clock rather than first packet anchor',t=>{
 const f=timeBoundaryFixture(t);const [p1,c1,p3,d,i,r,c3,d3,i3]=f.side;
 const p2={...p1,packetId:2,rawFrameCount:384,rawByteCount:384*8,rawPacketDeviceFrameIndex:96,
   rawPacketQpc100ns:10020001,queuedBytesBeforeRead:96*8,queuedBytesAfterRead:480*8,
   appendStartByte:96*8,appendEndByte:480*8,queueGenerationBefore:1,queueGenerationAfter:2,queueGeneration:2,
   captureTimeQueueGeneration:2,captureTimePreviousEndDeviceFrameIndex:96,captureTimePreviousPacketTimestampError:false,
   ledgerLastKnownTailByte:480*8};
 Object.assign(p1,{rawFrameCount:96,rawByteCount:96*8,queuedBytesAfterRead:96*8,appendEndByte:96*8,ledgerLastKnownTailByte:96*8});
 c1.ledgerLastKnownTailByte=96*8;
 const c2={...c1,packetId:2,queueGeneration:2,captureClockPrefixBytesAtPrepare:96*8,ledgerLastKnownTailByte:480*8};
 Object.assign(p3,{packetId:3,queueGenerationBefore:2,queueGenerationAfter:3,queueGeneration:3,captureTimeQueueGeneration:3});
 const oldRanges=[{packetId:1,startByte:0,endByte:96*8,packetOffsetStartByte:0,packetOffsetEndByte:96*8},
   {packetId:2,startByte:96*8,endByte:480*8,packetOffsetStartByte:0,packetOffsetEndByte:384*8}];
 d.packetRanges=oldRanges;i.packetRanges=structuredClone(oldRanges);d.queueGenerationBefore++;d.queueGenerationAfter++;
 for(const e of [d,i,r,c3,d3,i3])e.queueGeneration++;
 r.queueGenerationBefore++;r.queueGenerationAfter++;r.retainedPacketRanges[0].packetId=3;
 c3.packetId=3;d3.queueGenerationBefore++;d3.queueGenerationAfter++;d3.packetRanges[0].packetId=3;i3.packetRanges[0].packetId=3;
 Object.assign(f.main[0],{rawPacketDeviceFrameIndex:96,rawPacketQpc100ns:10020001,queueHeadQpc100ns:10000001});
 const b=f.main[0].aecProcessing.boundaryAdmission;b.queueGeneration=3;b.oldSegmentStartQpc100ns=10000001;
 f.side=[p1,c1,p2,c2,p3,d,i,r,c3,d3,i3];f.side.forEach((e,i)=>e.sequence=i);
 assert.equal(validateCaptureQueueLedger(f.side,f.main,{requireTimeSegments:true}).reviewSatisfied,true);
 b.oldSegmentStartQpc100ns=10000000;
 assert.throws(()=>validateCaptureQueueLedger(f.side,f.main,{requireTimeSegments:true}),/boundaryAdmission/);
});


function installCapturePump(f, mutate = () => {}) {
  const value = { schemaVersion: 1, artifactKind: 'capture-pump-timing-diagnostic',
    captureOwnerId: 1, threadId: 171, processId: 42, endpointId: 'endpoint',
    nativeStopSucceeded: true, diagnosticIncomplete: false,
    diagnosticOnly: true, qualityAcceptance: false, aecQualityAcceptance: false,
    formalCaptureClockAcceptance: false, releaseEligible: false, retainedSpans: [] };
  const descriptor = { schemaVersion: 1, sequence: f.side.length, kind: 'native-capture-pump-timing-seal',
    captureOwnerId: 1, threadId: 171, processId: 42, endpointId: 'endpoint',
    file: 'aec-capture-pump-owner-1.json', flushed: true, synced: true,
    captureStoppedBeforePersistence: true, diagnosticIncomplete: false,
    diagnosticOnly: true, qualityAcceptance: false, aecQualityAcceptance: false,
    formalCaptureClockAcceptance: false, releaseEligible: false };
  mutate(value, descriptor);
  const bytes = Buffer.from(JSON.stringify(value)+'\n');
  // Unsafe descriptor names still write only the fixed safe fixture basename.
  fs.writeFileSync(path.join(f.root, 'aec-capture-pump-owner-1.json'), bytes);
  descriptor.bytes ??= bytes.length; descriptor.sha256 ??= sha(bytes);
  f.side.push(descriptor);
  f.seal.lifecycleEvents += 1;
  for (const key of ['attemptedEvents','acceptedEvents','writtenEvents']) f.seal[key] += 1;
  f.saveEvents('side');
  return { value, descriptor, path: path.join(f.root, 'aec-capture-pump-owner-1.json') };
}

test('capture pump consumer real fixture build roundtrip', t => {
  const f = fixture(t); installCapturePump(f);
  const result = buildAecClosedLoopEvidence(f.root, f.options);
  assert.equal(result.passed, true, result.violations.join(';'));
});


test('capture pump consumer descriptor rejects malformed identities paths commits and authority', async t => {
  const cases = [
    ['schema', (v,e) => { e.schemaVersion=2; }],
    ...['captureOwnerId','threadId','processId'].flatMap(key => [
      [key+' zero', (v,e) => { e[key]=0; }],
      [key+' unsafe', (v,e) => { e[key]=Number.MAX_SAFE_INTEGER+1; }],
      [key+' fraction', (v,e) => { e[key]=1.5; }],
    ]),
    ['endpoint', (v,e) => { e.endpointId=' '; }],
    ...['../aec-capture-pump-owner-1.json','sub/aec-capture-pump-owner-1.json',
      'C:\\outside.json','aec-capture-pump-owner-2.json'].map(name =>
      [name, (v,e) => { e.file=name; }]),
    ...[0,64*1024*1024+1,1.5].map(bytes => ['bytes '+bytes, (v,e) => { e.bytes=bytes; }]),
    ['hash shape', (v,e) => { e.sha256='bad'; }],
    ['hash mismatch', (v,e) => { e.sha256='0'.repeat(64); }],
    ['flush', (v,e) => { e.flushed=false; }], ['sync', (v,e) => { e.synced=false; }],
    ['stop missing', (v,e) => { delete e.captureStoppedBeforePersistence; }],
    ['stop not bool', (v,e) => { e.captureStoppedBeforePersistence=1; }],
    ['incomplete missing', (v,e) => { delete e.diagnosticIncomplete; }],
    ['incomplete not bool', (v,e) => { e.diagnosticIncomplete=0; }],
    ...['qualityAcceptance','formalCaptureClockAcceptance','releaseEligible','aecQualityAcceptance']
      .map(key => [key, (v,e) => { e[key]=true; }]),
    ['not diagnostic', (v,e) => { e.diagnosticOnly=false; }],
    ['authority omitted', (v,e) => { delete e.qualityAcceptance; }],
  ];
  for (const [name,change] of cases) await t.test(name, t => {
    const f=fixture(t); installCapturePump(f,change); fails(f,/capture pump/);
  });
});

test('capture pump consumer authenticates actual file not descriptor claims', async t => {
  const cases = [
    ['render timing substitute', (v) => { v.artifactKind='local-aec-pump-timing-diagnostic'; }],
    ['old native kind', (v) => { v.artifactKind='native-capture-pump-timing-diagnostic'; }],
    ['file schema', (v) => { v.schemaVersion=2; }],
    ...['captureOwnerId','threadId','processId','endpointId'].map(key =>
      ['file '+key, v => { v[key]=key==='endpointId'?'other-endpoint':77; }]),
    ['file stop', v => { v.nativeStopSucceeded=false; }],
    ['file incomplete', v => { v.diagnosticIncomplete=true; }],
    ...['qualityAcceptance','formalCaptureClockAcceptance','releaseEligible','aecQualityAcceptance']
      .map(key => ['file '+key, v => { v[key]=true; }]),
    ['file missing boundary', v => { delete v.formalCaptureClockAcceptance; }],
    ['file not diagnostic', v => { v.diagnosticOnly=false; }],
  ];
  for (const [name,change] of cases) await t.test(name,t=>{
    const f=fixture(t); installCapturePump(f,change); fails(f,/capture pump/);
  });
  for (const mode of ['missing','tampered','same-size-tampered','oversized','invalid-json','invalid-utf8','directory']) {
    await t.test(mode,t=>{
      const f=fixture(t);const p=installCapturePump(f);
      if(mode==='missing') fs.unlinkSync(p.path);
      else if(mode==='tampered') fs.appendFileSync(p.path,' ');
      else if(mode==='same-size-tampered') {const bytes=fs.readFileSync(p.path);bytes[0]=0x5b;fs.writeFileSync(p.path,bytes);}
      else if(mode==='oversized') fs.truncateSync(p.path,64*1024*1024+1);
      else if(mode==='directory') {fs.unlinkSync(p.path);fs.mkdirSync(p.path);}
      else {
        const bytes=mode==='invalid-json'?Buffer.from('{'):Buffer.from([0xff]);
        fs.writeFileSync(p.path,bytes);p.descriptor.bytes=bytes.length;p.descriptor.sha256=sha(bytes);f.saveEvents('side');
      }
      fails(f,/capture pump|ENOENT|invalid .*size\/type/);
    });
  }
});

test('capture pump consumer duplicate descriptors fail all root and memory readers',t=>{
  const f=fixture(t);const p=installCapturePump(f);
  f.side.push({...p.descriptor,sequence:f.side.length});f.seal.lifecycleEvents+=1;
  for(const key of ['attemptedEvents','acceptedEvents','writtenEvents'])f.seal[key]+=1;
  f.saveEvents('side');
  fails(f,/duplicate capture pump/);
  const manifest=createAecClosedLoopManifest(f.root,{cell:f.identity,freezePublicKey:f.publicKey});
  assert.equal(manifest.passed,false);assert.match(manifest.violations.join(';'),/duplicate capture pump/);
  assert.throws(()=>validateCaptureQueueLedger(f.side,f.base),/duplicate capture pump/);
});

test('capture pump consumer manifest authenticates files and memory projection has no custody',t=>{
  const f=fixture(t);const p=installCapturePump(f);
  const manifest=createAecClosedLoopManifest(f.root,{cell:f.identity,freezePublicKey:f.publicKey});
  assert.equal(manifest.passed,true,manifest.violations.join(';'));
  fs.unlinkSync(p.path);
  // In-memory projection checks type only; it cannot authenticate a file/root.
  const projection=validateCaptureQueueLedger(f.side,f.base);
  assert.equal(projection.qualityAcceptance,false);
  assert.equal(projection.fileSealsVerified,undefined);
  const missing=createAecClosedLoopManifest(f.root,{cell:f.identity,freezePublicKey:f.publicKey});
  assert.equal(missing.passed,false);assert.match(missing.violations.join(';'),/ENOENT/);
  assert.equal(verifyAecClosedLoopEvidence(f.root,f.options).passed,false);
});


function captureMmcssReceipt(ownerThreadId) {
  return {schemaVersion:1,taskName:'Audio',ownerThreadId,registrationAttempted:true,registrationSucceeded:true,
    taskIndex:0,registrationErrorCode:null,cleanupAttempted:true,revertAttempted:true,revertSucceeded:true,
    revertThreadId:ownerThreadId,revertErrorCode:null,restoreFailureKind:null,cleanupPath:'explicit',state:'restored'};
}

test('capture MMCSS final receipt is bound to sealed native owner without granting quality', t => {
  const f=fixture(t); installCapturePump(f,v=>{v.mmcssAudio=captureMmcssReceipt(v.threadId);});
  const result=buildAecClosedLoopEvidence(f.root,f.options);
  assert.equal(result.passed,true,result.violations.join(';'));assert.equal(result.releaseEligible,false);
  const manifest=createAecClosedLoopManifest(f.root,{cell:f.identity,freezePublicKey:f.publicKey});
  assert.equal(manifest.passed,true,manifest.violations.join(';'));
});

test('capture MMCSS valid failures remain incomplete diagnostic evidence', async t => {
  for(const kind of ['nativeError','ownerThreadMismatch','unwound-before-thread','unwound-native']) await t.test(kind,t=>{
    const f=fixture(t);installCapturePump(f,(v,e)=>{
      v.diagnosticIncomplete=e.diagnosticIncomplete=true;
      const r=v.mmcssAudio=captureMmcssReceipt(v.threadId);r.state='restoreFailed';r.revertSucceeded=false;
      if(kind==='nativeError'){r.restoreFailureKind='nativeError';r.revertErrorCode=1550;}
      else if(kind==='ownerThreadMismatch'){r.restoreFailureKind='ownerThreadMismatch';r.revertThreadId+=1;r.revertAttempted=false;}
      else {r.restoreFailureKind='unwound';if(kind==='unwound-before-thread'){r.revertThreadId=null;r.revertAttempted=false;}}
    });
    const result=buildAecClosedLoopEvidence(f.root,f.options);assert.equal(result.passed,true,result.violations.join(';'));
    assert.equal(result.releaseEligible,false); // Valid custody is not an AEC pass or successful cleanup.
  });
});

test('capture MMCSS forged or unfinished final receipts are rejected after resealing', async t => {
  const cases=[
    ['null',v=>{v.mmcssAudio=null;}],['array',v=>{v.mmcssAudio=[];}],['missing-state',v=>{delete v.mmcssAudio.state;}],
    ['active',v=>{v.mmcssAudio.state='active';}],['registration-failed',v=>{v.mmcssAudio.state='registrationFailed';}],
    ['owner',v=>{v.mmcssAudio.ownerThreadId+=1;}],['wrong-revert-owner',v=>{v.mmcssAudio.revertThreadId+=1;}],
    ['schema',v=>{v.mmcssAudio.schemaVersion=2;}],['task',v=>{v.mmcssAudio.taskName='Pro Audio';}],
    ['registration',v=>{v.mmcssAudio.registrationSucceeded=false;}],['task-index',v=>{v.mmcssAudio.taskIndex=-1;}],
    ['revert-success',v=>{v.mmcssAudio.revertSucceeded=false;}],['revert-attempt',v=>{v.mmcssAudio.revertAttempted=false;}],
    ['cleanup',v=>{v.mmcssAudio.cleanupAttempted=false;}],['drop-fallback',v=>{v.mmcssAudio.cleanupPath='dropFallback';}],
    ['revert-error',v=>{v.mmcssAudio.revertErrorCode=5;}],['failure-kind',v=>{v.mmcssAudio.restoreFailureKind='nativeError';}],
    ['failed-claimed-complete',v=>{Object.assign(v.mmcssAudio,{state:'restoreFailed',revertSucceeded:false,restoreFailureKind:'nativeError',revertErrorCode:5});}],
    ['native-error-foreign-thread',(v,e)=>{v.diagnosticIncomplete=e.diagnosticIncomplete=true;Object.assign(v.mmcssAudio,{state:'restoreFailed',revertSucceeded:false,restoreFailureKind:'nativeError',revertErrorCode:5,revertThreadId:v.threadId+1});}],
    ['unknown-failure',(v,e)=>{v.diagnosticIncomplete=e.diagnosticIncomplete=true;Object.assign(v.mmcssAudio,{state:'restoreFailed',revertSucceeded:false,restoreFailureKind:'unknown'});}],
    ['failed-native-stop-claimed-complete',(v,e)=>{v.nativeStopSucceeded=e.captureStoppedBeforePersistence=false;}],
  ];
  for(const [name,mutate] of cases) await t.test(name,t=>{const f=fixture(t);installCapturePump(f,(v,e)=>{v.mmcssAudio=captureMmcssReceipt(v.threadId);mutate(v,e);});fails(f,/capture pump/);});
});

function captureTailObservationClockReceipt(ownerId) {
  return { schemaVersion: 1, clockDomain: 'std-instant-native-observation',
    captureOwnerId: ownerId, observationCount: 10, clockUnchangedPacketCount: 2,
    clockUnchangedQueryCount: 3, nonadvancingTimeNeverCreditsQuiet: true,
    diagnosticOnly: true, qualityAcceptance: false };
}

test('capture tail observation clock receipt validates when present without granting quality', t => {
  const f = fixture(t);
  installCapturePump(f, (v) => {
    v.tailObservationClock = captureTailObservationClockReceipt(v.captureOwnerId);
  });
  const result = buildAecClosedLoopEvidence(f.root, f.options);
  assert.equal(result.passed, true, result.violations.join(';'));
  assert.equal(result.releaseEligible, false);
  const manifest = createAecClosedLoopManifest(f.root, { cell: f.identity, freezePublicKey: f.publicKey });
  assert.equal(manifest.passed, true, manifest.violations.join(';'));
});

test('capture tail observation clock resealed negative tests reject corrupted shapes and authority claims', async t => {
  const cases = [
    ['null', (v) => { v.tailObservationClock = null; }],
    ['foreign owner', (v) => { v.tailObservationClock.captureOwnerId += 1; }],
    ['wrong domain', (v) => { v.tailObservationClock.clockDomain = 'qpc-domain'; }],
    ['wrong schema', (v) => { v.tailObservationClock.schemaVersion = 2; }],
    ['negative count', (v) => { v.tailObservationClock.observationCount = -1; }],
    ['fraction count', (v) => { v.tailObservationClock.observationCount = 1.5; }],
    ['string count', (v) => { v.tailObservationClock.observationCount = "10"; }],
    ['unsafe count', (v) => { v.tailObservationClock.observationCount = Number.MAX_SAFE_INTEGER + 1; }],
    ['count totals exceed observations', (v) => { v.tailObservationClock.clockUnchangedPacketCount = 8; v.tailObservationClock.clockUnchangedQueryCount = 3; }],
    ['fake quiet credit flag false', (v) => { v.tailObservationClock.nonadvancingTimeNeverCreditsQuiet = false; }],
    ['authority true', (v) => { v.tailObservationClock.diagnosticOnly = false; }],
    ['authority qualityAcceptance true', (v) => { v.tailObservationClock.qualityAcceptance = true; }],
    ['unknown extra field', (v) => { v.tailObservationClock.extraField = true; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, (t) => {
      const f = fixture(t);
      installCapturePump(f, (v) => {
        v.tailObservationClock = captureTailObservationClockReceipt(v.captureOwnerId);
        mutate(v);
      });
      fails(f, /capture pump tail observation clock/);
    });
  }
});
