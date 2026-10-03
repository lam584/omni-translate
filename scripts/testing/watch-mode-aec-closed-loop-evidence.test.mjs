import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AEC_CLOSED_LOOP_PROFILE, AEC_CLOSED_LOOP_THRESHOLDS, buildAecClosedLoopEvidence,
  verifyAecClosedLoopEvidence, createAecClosedLoopManifest, canonicalAecFreezePayload, AEC_CLOSED_LOOP_REQUIRED_ARTIFACTS } from './watch-mode-aec-closed-loop-evidence.mjs';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const f32 = (samples) => { const b = Buffer.alloc(samples.length * 4); samples.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; };
const names = { render: 'aec-render-reference-48k-stereo.f32le', pre: 'aec-pre-capture-48k-stereo.f32le', post: 'aec-post-output-48k-stereo.f32le', metadata: 'aec-frame-metadata.jsonl' };
const sideNames = { physical: 'aec-physical-output-48k-stereo.f32le', provider: 'aec-provider-input.s16le', metadata: 'aec-closed-loop-metadata.jsonl' };
function fixture(t, responses = 1, { sourceFrames } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-closed-loop-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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