import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyAecTerminalEvidence, AEC_TERMINAL_COMPLETION_POLICY } from './watch-mode-aec-terminal-evidence.mjs';
const reference = fs.readFileSync(new URL('./fixtures/watch-mode-en-original.txt', import.meta.url), 'utf8').trim().split(/\r?\n\s*\r?\n/u);
const mediaSha256 = 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const base = 1790880000000;
  const identity = { runMarker: 'run', cellId: 'cell', leaseId: 'lease' };
  const expectedIdentity = { runMarker: 'run', leaseId: 'lease', sourceHeadCommit: 'a'.repeat(40), runtimeBundleDigest: 'b'.repeat(64),
    launchId: '123e4567-e89b-42d3-a456-426614174000', producerProcessId: 123,
    producerStartTimeUtcTicks: String(621355968000000000n + BigInt(base) * 10000n), producerExecutableSha256: 'c'.repeat(64) };
  const plannedCell = { cellId: 'cell', feedbackLoopPrevention: 'echo-cancel', completionPolicy: AEC_TERMINAL_COMPLETION_POLICY,
    authoritativeTransformedReferenceFrames: 2013045, boundedCaptureGraceFrames: 866955, maxExternalAudioSamples: 2880000,
    localPlaybackDrainTimeoutSeconds: 120 };
  const media = { artifactKind: 'watch-mode-media-complete', schemaVersion: 2, ...identity, mediaSha256,
    playbackProcessId: 321, playbackEndpointId: 'speaker', mediaPlaybackStartedAtUnixMs: base + 10,
    mediaPlaybackCompletedAtUnixMs: base + 500, authoritativeTransformedReferenceFrames: 2013045,
    boundedCaptureGraceFrames: 866955, maxExternalAudioSamples: 2880000, expectedSourceSegments: reference };
  const input = { artifactKind: 'watch-mode-input-complete', schemaVersion: 1, ...identity, disposition: 'completed',
    completedAtUnixMs: base + 2701, signaledAtUnixMs: base + 2701, authoritativeTransformedReferenceFrames: 2013045,
    boundedCaptureGraceFrames: 866955, maxExternalAudioSamples: 2880000, mediaPlaybackCompletedAtUnixMs: base + 500 };
  const point = (sourceSequence, activityGeneration, at, ownerId) => ({ sourceSequence, activityGeneration, observedAtUnixMs: base + at, ownerId });
  const output = point(4, 2, 100, 'response');
  const complete = point(8, 8, 300, 'cue');
  const start = { sourceSequence: 11, observedAtUnixMs: base + 600, appendIndex: 20, samples: 480, acceptedSamplesTotal: 10000 };
  const end = { sourceSequence: 12, observedAtUnixMs: base + 2600, appendIndex: 80, samples: 480, acceptedSamplesTotal: 42000 };
  const append = { sourceSequence: 15, appendIndex: 81, samples: 480, acceptedSamplesTotal: 42480, authority: 'desktop-provider-socket-send-owner' };
  const events = [];
  const push = (stage, at, detail) => events.push({ stage, observedAtUnixMs: base + at, detail: { ...detail, ...identity } });
  push('sessionUpdatedReceived', 0, { authority: 'desktop-livetranslate-typed-session-owner', sourceSequence: 1,
    sessionIdentitySha256: 'd'.repeat(64), sentSessionConfigSha256: 'e'.repeat(64), echoedSessionConfigSha256: 'e'.repeat(64) });
  push('lastOutput', 100, { authority: 'response', sourceSequence: 4, activityGeneration: 2, ownerId: 'response' });
  push('responseDone', 200, { sourceSequence: 7, responseId: 'response', authority: 'desktop-provider-socket-event-owner' });
  push('lastPhysicalCompleted', 300, { authority: 'cue', sourceSequence: 8, activityGeneration: 8, ownerId: 'cue' });
  push('finalRendererAck', 300, { authority: 'desktop-renderer-receipt-owner', sourceSequence: 9, cueId: 'cue', responseId: 'response',
    cueSequence: 1, lastCueSequence: 1, coversLastCue: true, receiptAuthority: 'speaker-render-completed', receiptId: 'receipt' });
  push('mediaPlaybackCompleted', 500, { authority: 'runner-immutable-media-complete-marker', disposition: 'completed' });
  push('mediaComplete', 500, { authority: 'runner-immutable-media-complete-marker', schemaVersion: 2, sourceSequence: 10, activityGeneration: 8,
    mediaSha256, playbackProcessId: 321, playbackEndpointId: 'speaker', mediaPlaybackStartedAtUnixMs: base + 10,
    mediaPlaybackCompletedAtUnixMs: base + 500, authoritativeTransformedReferenceFrames: 2013045, maxExternalAudioSamples: 2880000,
    expectedSourceSegments: reference, inputOpen: true, providerInputOpen: true });
  push('outputQuiescent', 2700, { authority: 'desktop-open-input-drain-owner', sourceSequence: 13, activityGeneration: 8,
    inputCompletionWatchdogMs: 180000, openInputDrainStartedAtUnixMs: base,
    stableForMs: 2000, inputOpen: true, providerInputOpen: true, sourceSegmentsCovered: 6, expectedSourceSegments: 6,
    pendingSpeech: 0, pendingInputSegments: 0, pendingResponses: 0, pendingRendererAcks: 0, pendingNativeAudio: false, queuedCommands: 0,
    activeCommands: 0, pendingBridgeAcks: 0, activeBridgeCues: 0, pendingAudioFrames: 0, pendingPlaybackSubmissions: 0, restartBarrier: false,
    lastInputSpeech: null, lastOutput: output, lastPhysicalStarted: point(5, 3, 100, 'cue'),
    lastPhysicalFrame: point(6, 4, 200, 'cue'), lastPhysicalCompleted: complete,
    sendWindowStart: start, sendWindowEnd: end, sendWindowSampleRateHz: 16000, sendWindowSamples: 32000 });
  push('inputCompleteSignaled', 2701, { authority: 'desktop-open-input-quiescent-marker-owner', markerCompletedAtUnixMs: base + 2701 });
  push('captureClosed', 2800, { authority: 'capture-input-fence-owner', sourceSequence: 14, activityGeneration: 8, ownerId: 'capture-input-fence-owner' });
  push('inputCompleteObserved', 2800, { authority: 'desktop-input-complete-watcher-and-capture-owner', sourceSequence: 14,
    markerSignaledAtUnixMs: base + 2701, markerCompletedAtUnixMs: base + 2701, acceptedExactlyOnce: true,
    captureProducerFenced: true, providerInputSenderReleased: true, statusConsumerRetained: true, paddedTailBytes: 0 });
  push('lastProviderAppend', 2801, append);
  push('lastAppend', 2801, { ...append, activityGeneration: 8 });
  push('sessionFinishSent', 2850, { authority: 'desktop-livetranslate-socket-owner', sourceSequence: 16, finishCount: 1,
    lastProviderAppendSourceSequence: 15, providerInputClosedSourceSequence: 14, providerWritesAfterFinish: 0 });
  push('sessionFinishedReceived', 2900, { authority: 'desktop-livetranslate-socket-owner', sourceSequence: 17, finishCount: 1, providerWritesAfterFinish: 0 });
  push('localPlaybackQuiescent', 3650, { completionAuthority: 'all-local-playback-owners-quiescent', speakerPlaybackActive: false,
    stableForMs: 750, waitedMs: 750, playbackWatchdogMs: 120000, finalPendingNativeAudio: false, finalQueuedCommands: 0,
    finalActiveCommands: 0, finalPendingAudioFrames: 0, finalPendingPlaybackSubmissions: 0, finalPendingBridgeAcks: 0,
    finalActiveBridgeCues: 0, finalRestartBarrier: false });
  push('finishOutputChecked', 4000, { authority: 'desktop-strict-terminal-ledger', sourceSequence: 17, activityGeneration: 8,
    sealedActivityGeneration: 8, phase: 'finished', inputOpen: false, providerInputOpen: false,
    pendingSpeech: 0, pendingInputSegments: 0, pendingResponses: 0, pendingRendererAcks: 0, providerWritesAfterFinish: 0,
    lastOutput: output, lastPhysicalCompleted: complete });
  push('reportWritten', 4010, { reportPath: 'watch-session-report.json' });
  events.sort((a, b) => a.observedAtUnixMs - b.observedAtUnixMs); events.forEach((e, i) => { e.sequence = i + 1; });
  const terminal = { artifactKind: 'watch-mode-evidence-driven-terminal', schemaVersion: 4, completionPolicy: AEC_TERMINAL_COMPLETION_POLICY,
    ...identity, ...expectedIdentity, producerStartedAtUnixMs: base, status: 'completed', startedAtUnixMs: base, completedAtUnixMs: base + 4020, events };
  const playback = { mediaSha256, injectorProcessId: 321, endpointId: 'speaker', startedAtMs: base + 10, finishedAtMs: base + 500 };
  const report = { status: 'completed', sessionId: 'session', cues: reference.map((text, i) => ({ cueId: `source-${i}`, routeDirection: 'inbound',
    sourceText: text, renderedText: text, comparisonStatus: 'exact', llmFirstAtMs: 1, publishedFirstAtMs: 2, renderedFirstAtMs: 3, issues: [] })) };
  const objects = { 'media-complete.json': media, 'input-complete.json': input, 'evidence-driven-terminal.json': terminal,
    'playback.json': playback, 'watch-session-report.json': report };
  const bytes = () => {
    const reportBytes = Buffer.from(JSON.stringify(report));
    Object.assign(events.find(e => e.stage === 'reportWritten').detail, { byteLength: reportBytes.length, sha256: hash(reportBytes) });
    return Object.fromEntries(Object.entries(objects).map(([name, object]) => [name, Buffer.from(JSON.stringify(object))]));
  };
  return { objects, expectedIdentity, plannedCell, bytes, event: stage => events.find(e => e.stage === stage),
    verify: () => verifyAecTerminalEvidence('.', { plannedCell, expectedIdentity, artifactBytes: bytes() }) };
}

test('accepts reconstructed v4 open-input send window and existing six-segment oracle', () => {
  const result = fixture().verify(); assert.equal(result.sourceCoverage.acceptedSegmentCount, 6);
});

for (const [name, mutate] of [
  ['watchdog used as success', f => { f.event('outputQuiescent').detail.inputCompletionWatchdogMs = 2000; }],
  ['old terminal schema', f => { f.objects['evidence-driven-terminal.json'].schemaVersion = 3; }],
  ['old media schema', f => { f.objects['media-complete.json'].schemaVersion = 1; }],
  ['foreign lease', f => { f.objects['media-complete.json'].leaseId = 'foreign'; }],
  ['foreign typed event identity', f => { f.event('lastOutput').detail.runMarker = 'foreign'; }],
  ['foreign playback identity', f => { f.objects['playback.json'].injectorProcessId = 999; }],
  ['input marker before quiet', f => { f.objects['input-complete.json'].signaledAtUnixMs -= 1000; }],
  ['tap-only zero actual sends', f => { f.event('outputQuiescent').detail.sendWindowEnd.acceptedSamplesTotal = 10000; }],
  ['short send-window', f => { f.event('outputQuiescent').detail.sendWindowStart.observedAtUnixMs += 1; }],
  ['new output resets quiet', f => { f.event('outputQuiescent').detail.lastOutput.observedAtUnixMs += 1000; }],
  ['stopped input still awaits a response', f => { f.event('outputQuiescent').detail.pendingInputSegments = 1; }],
  ['old ownership report lacks pending-input authority', f => { delete f.event('outputQuiescent').detail.pendingInputSegments; }],
  ['finished input still awaits a response', f => { f.event('finishOutputChecked').detail.pendingInputSegments = 1; }],
  ['stalled response even passed true', f => { Object.assign(f.event('outputQuiescent').detail, { pendingResponses: 1, passed: true }); }],
  ['capture closed before quiescence', f => { f.event('captureClosed').detail.sourceSequence = 12; }],
  ['after-finish fresh output', f => { f.event('finishOutputChecked').detail.activityGeneration += 1; }],
  ['after-finish fresh physical completion', f => { f.event('finishOutputChecked').detail.lastPhysicalCompleted.ownerId = 'late'; }],
  ['failed terminal', f => { f.objects['evidence-driven-terminal.json'].status = 'failed'; }],
  ['premature successful failure marker', f => { f.objects['input-complete.json'].schemaVersion = 2; f.objects['input-complete.json'].disposition = 'failed-incomplete'; }],
  ['missing stage', f => { f.objects['evidence-driven-terminal.json'].events.pop(); }],
  ['no accepted source even claimed six', f => { f.objects['watch-session-report.json'].cues.forEach(cue => { cue.comparisonStatus = 'pending'; }); }],
]) test(`rejects ${name}`, () => { const f = fixture(); mutate(f); assert.throws(f.verify); });

test('accepts original source recall with imperfect ASR instead of full substring', () => {
  const f = fixture(); for (const cue of f.objects['watch-session-report.json'].cues) cue.sourceText = cue.sourceText.replace('Maya', 'Maria').replace('everyday', 'ordinary');
  assert.equal(f.verify().sourceCoverage.acceptedSegmentCount, 6);
});

test('PS Report verifier calls the same v4 reconstruction, and rejects a changed typed generation', () => {
  if (process.platform !== 'win32') return;
  const tempParent = path.resolve('artifacts/testing');
  fs.mkdirSync(tempParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempParent, 'aec-terminal-'));
  const f = fixture();
  try {
    for (const [name, bytes] of Object.entries(f.bytes())) fs.writeFileSync(path.join(root, name), bytes);
    const module = path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Report.psm1').replaceAll("'", "''");
    const command = `Import-Module '${module}' -Force; $lease=@{pid=123;startTimeUtcTicks='${f.expectedIdentity.producerStartTimeUtcTicks}';launchId='${f.expectedIdentity.launchId}';executableSha256='${f.expectedIdentity.producerExecutableSha256}'}; Assert-WatchTerminalAuthorityFile -Path '${path.join(root, 'evidence-driven-terminal.json')}' -ReportPath '${path.join(root, 'watch-session-report.json')}' -ProcessLease $lease -RunMarker run -CellId cell -LeaseId lease -SourceHeadCommit '${f.expectedIdentity.sourceHeadCommit}' -RuntimeBundleDigest '${f.expectedIdentity.runtimeBundleDigest}' | Out-Null`;
    const first = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference='Stop'; ${command}`], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    f.event('finishOutputChecked').detail.activityGeneration += 1;
    for (const [name, bytes] of Object.entries(f.bytes())) fs.writeFileSync(path.join(root, name), bytes);
    const second = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference='Stop'; ${command}`], { encoding: 'utf8' });
    assert.notEqual(second.status, 0, second.stdout + second.stderr);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), tempParent, 'cleanup must stay in the intended workspace directory');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
