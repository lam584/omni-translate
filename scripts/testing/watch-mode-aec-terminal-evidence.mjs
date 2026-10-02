import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classifyWatchModeRun } from './watch-mode-report.mjs';

export const AEC_TERMINAL_COMPLETION_POLICY = 'aec-output-quiescent-v2';
const MEDIA_SHA = 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f';
const SOURCE_SEGMENTS = fs.readFileSync(new URL('./fixtures/watch-mode-en-original.txt', import.meta.url), 'utf8')
  .trim().split(/\r?\n\s*\r?\n/u).map(s => s.trim());
const STAGES = ['mediaPlaybackCompleted', 'inputCompleteSignaled', 'inputCompleteObserved', 'sessionUpdatedReceived',
  'lastProviderAppend', 'sessionFinishSent', 'sessionFinishedReceived', 'localPlaybackQuiescent', 'finalRendererAck',
  'reportWritten', 'mediaComplete', 'outputQuiescent', 'captureClosed', 'lastOutput', 'lastPhysicalCompleted',
  'lastAppend', 'finishOutputChecked'];
const HASH = /^[a-f0-9]{64}$/u;
const check = (condition, error) => { if (!condition) throw new Error(`AEC terminal: ${error}`); };
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readArtifact(directory, name, artifactBytes) {
  const supplied = artifactBytes instanceof Map ? artifactBytes.get(name) : artifactBytes?.[name];
  let bytes;
  if (supplied != null) {
    bytes = supplied?.bytes ?? supplied;
    check(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, `${name} custody requires raw bytes`);
    bytes = Buffer.from(bytes);
  } else {
    const target = path.join(path.resolve(directory), name);
    const stat = fs.lstatSync(target);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, `${name} must be a nonempty regular nonsymlink file`);
    bytes = fs.readFileSync(target);
  }
  check(bytes.length > 0, `${name} empty`);
  return { bytes, json: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')), sha256: hash(bytes) };
}

export function verifyAecTerminalEvidence(runDirectory, { plannedCell, expectedIdentity, artifactBytes } = {}) {
  check(plannedCell?.feedbackLoopPrevention === 'echo-cancel'
    && plannedCell?.completionPolicy === AEC_TERMINAL_COMPLETION_POLICY, 'planned cell policy mismatch');
  check(expectedIdentity && typeof expectedIdentity === 'object', 'expected producer identity required');
  const media = readArtifact(runDirectory, 'media-complete.json', artifactBytes).json;
  const input = readArtifact(runDirectory, 'input-complete.json', artifactBytes).json;
  const terminal = readArtifact(runDirectory, 'evidence-driven-terminal.json', artifactBytes).json;
  const playback = readArtifact(runDirectory, 'playback.json', artifactBytes).json;
  const reportArtifact = readArtifact(runDirectory, 'watch-session-report.json', artifactBytes);
  const report = reportArtifact.json;
  check(media.artifactKind === 'watch-mode-media-complete' && media.schemaVersion === 2, 'media marker version/kind mismatch');
  check(input.artifactKind === 'watch-mode-input-complete' && input.schemaVersion === 1
    && input.disposition === 'completed' && input.failureReason == null, 'successful runtime input marker required');
  check(terminal.artifactKind === 'watch-mode-evidence-driven-terminal' && terminal.schemaVersion === 4
    && terminal.completionPolicy === AEC_TERMINAL_COMPLETION_POLICY && terminal.status === 'completed'
    && terminal.errorCode == null && terminal.error == null, 'terminal version/kind/policy/status mismatch');
  const identity = { runMarker: expectedIdentity.runMarker, cellId: plannedCell.cellId, leaseId: expectedIdentity.leaseId };
  for (const [key, value] of Object.entries(identity)) {
    check(typeof value === 'string' && value.trim(), `${key} expected identity missing`);
    for (const artifact of [media, input, terminal]) check(artifact[key] === value, `${key} identity mismatch`);
  }
  const ticks = String(expectedIdentity.producerStartTimeUtcTicks ?? '');
  check(/^\d{18}$/u.test(ticks) && BigInt(ticks) > 621355968000000000n, 'OS process-start identity invalid');
  const processStarted = Number((BigInt(ticks) - 621355968000000000n) / 10000n);
  const producerFields = ['sourceHeadCommit', 'runtimeBundleDigest', 'launchId', 'producerProcessId', 'producerExecutableSha256'];
  for (const key of producerFields) check(terminal[key] === expectedIdentity[key], `producer ${key} identity mismatch`);
  check(/^[a-f0-9]{40}$/u.test(terminal.sourceHeadCommit) && HASH.test(terminal.runtimeBundleDigest)
    && HASH.test(terminal.producerExecutableSha256) && integer(terminal.producerProcessId, 1)
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(terminal.launchId)
    && terminal.producerStartTimeUtcTicks === ticks && terminal.producerStartedAtUnixMs === processStarted, 'producer authority incomplete');
  check(integer(terminal.startedAtUnixMs, processStarted) && integer(terminal.completedAtUnixMs, terminal.startedAtUnixMs), 'terminal time boundary invalid');
  check(media.mediaSha256 === MEDIA_SHA && HASH.test(media.mediaSha256) && media.mediaSha256 === playback.mediaSha256
    && integer(media.playbackProcessId, 1) && media.playbackProcessId === playback.injectorProcessId
    && typeof media.playbackEndpointId === 'string' && media.playbackEndpointId.trim()
    && media.playbackEndpointId === playback.endpointId, 'media/playback identity mismatch');
  check(media.mediaPlaybackStartedAtUnixMs === playback.startedAtMs
    && media.mediaPlaybackCompletedAtUnixMs === playback.finishedAtMs, 'media/playback timestamp mismatch');
  check(integer(media.mediaPlaybackStartedAtUnixMs, processStarted)
    && integer(media.mediaPlaybackCompletedAtUnixMs, media.mediaPlaybackStartedAtUnixMs)
    && same(media.expectedSourceSegments, SOURCE_SEGMENTS), 'media timestamps/source references mismatch');
  for (const key of ['authoritativeTransformedReferenceFrames', 'maxExternalAudioSamples']) {
    check(integer(media[key], 1) && media[key] === plannedCell[key] && input[key] === media[key], `${key} budget mismatch`);
  }
  check(media.maxExternalAudioSamples === 2880000 && media.authoritativeTransformedReferenceFrames === 2013045,
    'AEC sample ceiling invalid');
  if (media.boundedCaptureGraceFrames != null) check(integer(media.boundedCaptureGraceFrames)
    && media.boundedCaptureGraceFrames === plannedCell.boundedCaptureGraceFrames
    && input.boundedCaptureGraceFrames === media.boundedCaptureGraceFrames
    && media.boundedCaptureGraceFrames + media.authoritativeTransformedReferenceFrames === media.maxExternalAudioSamples, 'capture grace identity mismatch');
  check(input.mediaPlaybackCompletedAtUnixMs === media.mediaPlaybackCompletedAtUnixMs
    && integer(input.signaledAtUnixMs, media.mediaPlaybackCompletedAtUnixMs)
    && integer(input.completedAtUnixMs, input.signaledAtUnixMs), 'input marker time boundary invalid');
  const events = terminal.events;
  check(Array.isArray(events) && events.length === 18, 'requires exactly eighteen versioned owner stages');
  const stages = new Map(); let previous = terminal.startedAtUnixMs;
  for (const [index, event] of events.entries()) {
    check(event.sequence === index + 1 && integer(event.observedAtUnixMs, previous)
      && event.observedAtUnixMs <= terminal.completedAtUnixMs, 'event order/boundary invalid');
    check(!stages.has(event.stage), 'duplicate stage'); stages.set(event.stage, event); previous = event.observedAtUnixMs;
    for (const [key, value] of Object.entries(identity)) check(event.detail?.[key] === value, `${event.stage} ${key} identity mismatch`);
  }
  for (const stage of STAGES) check(stages.has(stage), `missing stage ${stage}`);
  const responses = ['responseDone', 'lastResponseAudioDone'].filter(stage => stages.has(stage));
  check(responses.length === 1 && stages.size === STAGES.length + 1, 'response stage/unknown inventory invalid');
  check(events.at(-1).stage === 'reportWritten', 'reportWritten must be final');
  const event = stage => stages.get(stage);
  const detail = stage => event(stage).detail;
  const seq = stage => { check(integer(detail(stage).sourceSequence, 1), `${stage} sourceSequence invalid`); return detail(stage).sourceSequence; };
  const point = (value, label) => {
    check(value && integer(value.sourceSequence, 1) && integer(value.activityGeneration, 1)
      && integer(value.observedAtUnixMs, terminal.startedAtUnixMs)
      && value.observedAtUnixMs <= terminal.completedAtUnixMs && typeof value.ownerId === 'string' && value.ownerId.trim(), `${label} activity authority invalid`);
  };
  const q = detail('outputQuiescent'), m = detail('mediaComplete'), c = detail('captureClosed'), f = detail('sessionFinishSent');
  const finished = detail('sessionFinishedReceived'), checked = detail('finishOutputChecked');
  check(m.authority === 'runner-immutable-media-complete-marker' && m.schemaVersion === 2
    && event('mediaComplete').observedAtUnixMs === media.mediaPlaybackCompletedAtUnixMs
    && m.mediaPlaybackStartedAtUnixMs === media.mediaPlaybackStartedAtUnixMs
    && m.mediaPlaybackCompletedAtUnixMs === media.mediaPlaybackCompletedAtUnixMs
    && m.mediaSha256 === media.mediaSha256 && m.playbackProcessId === media.playbackProcessId
    && m.playbackEndpointId === media.playbackEndpointId && same(m.expectedSourceSegments, SOURCE_SEGMENTS)
    && m.authoritativeTransformedReferenceFrames === media.authoritativeTransformedReferenceFrames
    && m.maxExternalAudioSamples === media.maxExternalAudioSamples && m.inputOpen === true && m.providerInputOpen === true, 'media event does not bind open-input marker');
  check(event('mediaPlaybackCompleted').observedAtUnixMs === media.mediaPlaybackCompletedAtUnixMs
    && detail('mediaPlaybackCompleted').authority === 'runner-immutable-media-complete-marker'
    && detail('mediaPlaybackCompleted').disposition === 'completed', 'media completion stage was not from independent media marker');
  check(q.inputCompletionWatchdogMs === 180000 && integer(q.openInputDrainStartedAtUnixMs, terminal.startedAtUnixMs)
    && event('outputQuiescent').observedAtUnixMs >= q.openInputDrainStartedAtUnixMs
    && event('outputQuiescent').observedAtUnixMs - q.openInputDrainStartedAtUnixMs < 180000, '180s watchdog cannot be a successful completion');
  check(q.authority === 'desktop-open-input-drain-owner' && q.stableForMs === 2000 && q.inputOpen === true && q.providerInputOpen === true
    && integer(q.activityGeneration, 1) && q.sourceSegmentsCovered === 6 && q.expectedSourceSegments === 6, 'output quiescence policy invalid');
  for (const key of ['pendingSpeech', 'pendingInputSegments', 'pendingResponses', 'pendingRendererAcks', 'queuedCommands', 'activeCommands', 'pendingBridgeAcks', 'activeBridgeCues', 'pendingPlaybackSubmissions'])
    check(q[key] === 0, `quiescence ${key} not zero`);
  check(q.pendingNativeAudio === false && q.restartBarrier === false && [null, 0].includes(q.pendingAudioFrames), 'quiescence native/physical backlog');
  for (const key of ['lastInputSpeech', 'lastOutput', 'lastPhysicalStarted', 'lastPhysicalFrame', 'lastPhysicalCompleted']) {
    if (q[key] == null && ['lastInputSpeech', 'lastPhysicalStarted', 'lastPhysicalFrame'].includes(key)) continue;
    point(q[key], key);
    check(q[key].activityGeneration <= q.activityGeneration && q[key].sourceSequence < seq('outputQuiescent')
      && event('outputQuiescent').observedAtUnixMs - q[key].observedAtUnixMs >= 2000, `${key} violates continuous quiet`);
  }
  const start = q.sendWindowStart, end = q.sendWindowEnd;
  for (const [label, append] of [['start', start], ['end', end]]) check(append
    && integer(append.sourceSequence, 1) && integer(append.observedAtUnixMs, terminal.startedAtUnixMs)
    && integer(append.appendIndex, 1) && integer(append.samples, 1)
    && integer(append.acceptedSamplesTotal, append.samples) && append.acceptedSamplesTotal <= media.maxExternalAudioSamples, `send window ${label} append invalid`);
  check(end.sourceSequence > start.sourceSequence && end.sourceSequence < seq('outputQuiescent')
    && end.appendIndex > start.appendIndex && end.observedAtUnixMs - start.observedAtUnixMs >= 2000
    && end.observedAtUnixMs <= event('outputQuiescent').observedAtUnixMs
    && end.acceptedSamplesTotal - start.acceptedSamplesTotal >= 32000 && q.sendWindowSampleRateHz === 16000
    && q.sendWindowSamples === end.acceptedSamplesTotal - start.acceptedSamplesTotal, 'two-second actual open-input send window missing');
  for (const key of ['lastInputSpeech', 'lastOutput', 'lastPhysicalStarted', 'lastPhysicalFrame', 'lastPhysicalCompleted'])
    if (q[key]) check(start.observedAtUnixMs >= q[key].observedAtUnixMs, 'send window predates latest activity');
  check(seq('mediaComplete') < seq('outputQuiescent') && seq('outputQuiescent') < seq('captureClosed')
    && event('outputQuiescent').observedAtUnixMs >= media.mediaPlaybackCompletedAtUnixMs + 2000
    && input.signaledAtUnixMs >= event('outputQuiescent').observedAtUnixMs
    && event('captureClosed').observedAtUnixMs >= input.signaledAtUnixMs, 'media/quiet/close order invalid');
  check(c.authority === 'capture-input-fence-owner' && c.activityGeneration === q.activityGeneration, 'capture fence activity changed');
  const observed = detail('inputCompleteObserved');
  check(observed.sourceSequence === seq('captureClosed') && observed.markerSignaledAtUnixMs === input.signaledAtUnixMs
    && observed.markerCompletedAtUnixMs === input.completedAtUnixMs && observed.acceptedExactlyOnce === true
    && observed.captureProducerFenced === true && observed.providerInputSenderReleased === true
    && observed.statusConsumerRetained === true && integer(observed.paddedTailBytes), 'typed capture fence authority invalid');
  check(detail('inputCompleteSignaled').authority === 'desktop-open-input-quiescent-marker-owner'
    && event('inputCompleteSignaled').observedAtUnixMs === input.signaledAtUnixMs
    && detail('inputCompleteSignaled').markerCompletedAtUnixMs === input.completedAtUnixMs, 'runtime input marker ownership invalid');
  const primarySources = ['sessionUpdatedReceived', 'lastProviderAppend', 'sessionFinishSent', 'sessionFinishedReceived',
    responses[0], 'finalRendererAck', 'mediaComplete', 'outputQuiescent', 'captureClosed', 'lastOutput', 'lastPhysicalCompleted'].map(seq);
  check(new Set(primarySources).size === primarySources.length, 'distinct owner events reuse sourceSequence');
  check(detail('lastProviderAppend').authority === 'desktop-provider-socket-send-owner'
    && f.authority === 'desktop-livetranslate-socket-owner'
    && finished.authority === 'desktop-livetranslate-socket-owner'
    && detail(responses[0]).authority === 'desktop-provider-socket-event-owner'
    && detail('finalRendererAck').authority === 'desktop-renderer-receipt-owner', 'typed terminal producer owner mismatch');
  const updated = detail('sessionUpdatedReceived');
  check(updated.authority === 'desktop-livetranslate-typed-session-owner' && HASH.test(updated.sessionIdentitySha256)
    && HASH.test(updated.sentSessionConfigSha256) && updated.sentSessionConfigSha256 === updated.echoedSessionConfigSha256, 'session.updated typed echo invalid');
  const append = detail('lastProviderAppend'), alias = detail('lastAppend');
  check(alias.authority === 'desktop-provider-socket-send-owner' && alias.sourceSequence === append.sourceSequence
    && alias.appendIndex === append.appendIndex && alias.samples === append.samples && alias.acceptedSamplesTotal === append.acceptedSamplesTotal
    && integer(append.appendIndex, end.appendIndex) && integer(append.samples, 1)
    && integer(append.acceptedSamplesTotal, end.acceptedSamplesTotal) && append.acceptedSamplesTotal <= media.maxExternalAudioSamples, 'last append/socket sample ledger invalid');
  check(seq('sessionUpdatedReceived') < start.sourceSequence && seq('lastProviderAppend') < seq('sessionFinishSent')
    && seq('captureClosed') < seq('sessionFinishSent') && f.lastProviderAppendSourceSequence === seq('lastProviderAppend')
    && f.providerInputClosedSourceSequence === seq('captureClosed') && f.finishCount === 1 && f.providerWritesAfterFinish === 0,
  'finish not exactly once after capture and last legal append');
  check(seq('sessionFinishSent') < seq('sessionFinishedReceived') && seq(responses[0]) < seq('outputQuiescent')
    && finished.finishCount === 1 && finished.providerWritesAfterFinish === 0
    && event('sessionFinishedReceived').observedAtUnixMs >= event('sessionFinishSent').observedAtUnixMs
    && event('sessionFinishedReceived').observedAtUnixMs - event('sessionFinishSent').observedAtUnixMs <= 15000, 'finished protocol terminal invalid');
  const response = detail(responses[0]), ack = detail('finalRendererAck');
  check(typeof response.responseId === 'string' && response.responseId.trim() && ack.responseId === response.responseId
    && integer(ack.cueSequence, 1) && ack.cueSequence === ack.lastCueSequence && ack.coversLastCue === true
    && typeof ack.cueId === 'string' && ack.cueId.trim() && typeof ack.receiptId === 'string' && ack.receiptId.trim()
    && typeof ack.receiptAuthority === 'string' && ack.receiptAuthority.trim()
    && seq('lastPhysicalCompleted') < seq('finalRendererAck')
    && detail('lastOutput').ownerId === response.responseId && detail('lastPhysicalCompleted').ownerId === ack.cueId
    && seq('finalRendererAck') < seq('outputQuiescent'), 'last physical response/ACK lineage invalid');
  for (const [stage, pointKey] of [['lastOutput', 'lastOutput'], ['lastPhysicalCompleted', 'lastPhysicalCompleted']]) {
    const p = q[pointKey], raw = detail(stage);
    check(raw.sourceSequence === p.sourceSequence && raw.activityGeneration === p.activityGeneration
      && raw.ownerId === p.ownerId && event(stage).observedAtUnixMs === p.observedAtUnixMs
      && same(checked[pointKey], p), `${stage} raw authority changed after finish`);
  }
  check(checked.authority === 'desktop-strict-terminal-ledger' && checked.phase === 'finished'
    && checked.inputOpen === false && checked.providerInputOpen === false && checked.providerWritesAfterFinish === 0
    && checked.activityGeneration === q.activityGeneration && checked.sealedActivityGeneration === q.activityGeneration
    && checked.pendingSpeech === 0 && checked.pendingInputSegments === 0 && checked.pendingResponses === 0 && checked.pendingRendererAcks === 0
    && seq('finishOutputChecked') >= seq('sessionFinishedReceived')
    && event('finishOutputChecked').observedAtUnixMs >= event('sessionFinishedReceived').observedAtUnixMs, 'finish released new output or changed sealed generation');
  const drain = detail('localPlaybackQuiescent');
  check(drain.completionAuthority === 'all-local-playback-owners-quiescent' && drain.speakerPlaybackActive === false
    && drain.finalPendingNativeAudio === false && drain.finalRestartBarrier === false && [null, 0].includes(drain.finalPendingAudioFrames)
    && integer(drain.stableForMs, 500) && drain.stableForMs <= 1000
    && integer(drain.waitedMs, drain.stableForMs) && drain.waitedMs <= drain.playbackWatchdogMs
    && drain.playbackWatchdogMs === plannedCell.localPlaybackDrainTimeoutSeconds * 1000, 'post-finish physical drain invalid');
  for (const key of ['finalQueuedCommands', 'finalActiveCommands', 'finalPendingPlaybackSubmissions', 'finalPendingBridgeAcks', 'finalActiveBridgeCues']) check(drain[key] === 0, `post-finish ${key}`);
  check(event('localPlaybackQuiescent').observedAtUnixMs >= event('sessionFinishedReceived').observedAtUnixMs, 'post-finish drain order invalid');
  const receipt = detail('reportWritten');
  check(receipt.reportPath === 'watch-session-report.json' && receipt.byteLength === reportArtifact.bytes.length
    && receipt.sha256 === reportArtifact.sha256 && report.status === 'completed', 'durable report binding invalid');
  // Invoke the existing oracle, not a claimed acceptance count/passed flag.
  const oracle = classifyWatchModeRun({ feedbackLoopPrevention: 'echo-cancel', playback, watchSessionReport: report,
    physicalOutputContent: { skipped: true }, provenance: { headCommit: terminal.sourceHeadCommit },
  }).layers.aec.data.liveScenario.expectedSubtitles;
  check(oracle.expectedSegmentCount === 6 && oracle.acceptedSegmentCount === 6 && oracle.minimumTokenRecall === 0.65,
    'original accepted-cue ordered/clause/translated source oracle incomplete');
  return { terminal, mediaComplete: media, inputComplete: input, sourceCoverage: oracle };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const rawOptions = process.argv[3] ?? '{}';
    const options = JSON.parse(rawOptions.startsWith('base64:') ? Buffer.from(rawOptions.slice(7), 'base64').toString('utf8') : rawOptions);
    verifyAecTerminalEvidence(process.argv[2], options);
    process.stdout.write('AEC terminal typed evidence verified\n');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
