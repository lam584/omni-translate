import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAecRealtimeEvidence, aecFeedbackCueViolations } from './watch-mode-aec-realtime-evidence.mjs';
function fixture() {
  const identity={runMarker:'run',cellId:'c03',leaseId:'lease'};
  const timeline={cueId:'cue1',responseId:'response1',firstAudioDeltaAtMs:1400,audioDoneAtMs:4000,renderCompleteAtMs:4600,rendererAckAtMs:4601,
    rendererAckReceiptId:'attempt1',continuousStreamId:'session1',rendererInstanceId:'instance1',rendererOwnerGeneration:1,
    physicalPlaybackDeviceId:'speaker',streamStartCount:1,acceptedSourceFrames:48000,sourceSampleRateHz:24000,aborted:false};
  const match={cueId:'cue1',responseId:'response1',passed:true,renderAttemptId:'attempt1',rendererInstanceId:'instance1',rendererOwnerGeneration:1,
    physicalPlaybackDeviceId:'speaker',anchorMatches:[{anchor:'head',passed:true,captureAuthorityPassed:true,matchedStartSample:16000},
      {anchor:'tail',passed:true,captureAuthorityPassed:true,matchedEndSample:56000}]};
  const pcm=Buffer.alloc(320*2);for(let i=0;i<320;i++)pcm.writeInt16LE(2000,i*2);
  return {identity,media:{...identity,schemaVersion:2,artifactKind:'watch-mode-media-complete',mediaPlaybackStartedAtUnixMs:900,mediaPlaybackCompletedAtUnixMs:10000},
    loopback:{...identity,passed:true,recordingStartedAtEpochMs:1000,recording:{samples:100000},requiredCompleteCueIds:['cue1'],matches:[match],unauditableCues:[]},
    timelines:[{...identity,schemaVersion:1,artifactKind:'aec-desktop-playback-timeline',milestone:'renderer-ack',timeline}],
    providerJournal:[{...identity,event:'append_attempt',occurredAtMs:1000,attemptedSamples:320}],providerPcm:pcm,watchReport:{cues:[]}};
}
test('frozen realtime gate accepts actual acoustic playback concurrent with source and before audio.done',()=>{
  const result=evaluateAecRealtimeEvidence(fixture());assert.equal(result.passed,true,result.violations.join('; '));
  assert.equal(result.firstAudibleInputToAcousticSeconds,1);assert.equal(result.firstPlayableDeltaToAcousticSeconds,.6);
});
test('media-end buffering, audio.done buffering, 35s delay and fake log playback cannot pass',()=>{
  for(const mutate of [
    f=>{f.media.mediaPlaybackCompletedAtUnixMs=1999;},
    f=>{f.timelines[0].timeline.audioDoneAtMs=1999;},
    f=>{f.loopback.matches[0].anchorMatches[0].matchedStartSample=560000;f.loopback.matches[0].anchorMatches[1].matchedEndSample=600000;f.loopback.recording.samples=1000000;f.media.mediaPlaybackCompletedAtUnixMs=60000;},
    f=>{f.loopback.passed=false;},
    f=>{f.timelines[0].timeline.firstAudioDeltaAtMs=400;},
    f=>{f.timelines[0].timeline.streamStartCount=2;},
  ]) {const f=fixture();mutate(f);const result=evaluateAecRealtimeEvidence(f);assert.equal(result.passed,false);assert.ok(result.violations.length);}
});
test('all cues including final tail must be acoustically complete, uniquely acknowledged and bound to raw input',()=>{
  for(const mutate of [
    f=>{f.loopback.unauditableCues.push({cueId:'cue1'});},
    f=>{f.loopback.recording.samples=55000;},
    f=>{f.loopback.matches[0].anchorMatches[1].passed=false;},
    f=>{f.timelines.push(f.timelines[0]);},
    f=>{f.timelines[0].leaseId='foreign';},
    f=>{f.providerPcm=Buffer.alloc(640);},
    f=>{f.providerPcm=f.providerPcm.subarray(0,638);},
    f=>{f.media.schemaVersion=1;},
  ]) {const f=fixture();mutate(f);assert.equal(evaluateAecRealtimeEvidence(f).passed,false);}
});
test('own translated source cue and duplicate active response chain fail while superseded revisions remain diagnostic',()=>{
  const cn='这是应用自身刚刚播放出来的中文译音';
  assert.ok(aecFeedbackCueViolations({cues:[{cueId:'a',sourceText:cn,renderedText:cn}]}).length);
  const text='source phrase '.repeat(12);assert.ok(aecFeedbackCueViolations({cues:[{cueId:'a',sourceText:text},{cueId:'b',sourceText:text}]}).length);
  assert.equal(aecFeedbackCueViolations({cues:[{cueId:'a',sourceText:text,comparisonStatus:'superseded'},{cueId:'b',sourceText:text}]}).length,0);
});

function addCompleteCue(f, { index, deltaAtMs, acousticAtMs, audioDoneAtMs }) {
  const cueId = 'cue' + index, responseId = 'response' + index, receiptId = 'attempt' + index;
  const matchedStartSample = (acousticAtMs - f.loopback.recordingStartedAtEpochMs) * 16;
  const matchedEndSample = matchedStartSample + 40000;
  const renderCompleteAtMs = acousticAtMs + 2600;
  f.loopback.requiredCompleteCueIds.push(cueId);
  f.loopback.matches.push({ ...f.loopback.matches[0], cueId, responseId, renderAttemptId: receiptId,
    anchorMatches: [{ anchor: 'head', passed: true, captureAuthorityPassed: true, matchedStartSample },
      { anchor: 'tail', passed: true, captureAuthorityPassed: true, matchedEndSample }] });
  f.loopback.recording.samples = Math.max(f.loopback.recording.samples, matchedEndSample);
  f.timelines.push({ ...f.timelines[0], timeline: { ...f.timelines[0].timeline, cueId, responseId,
    firstAudioDeltaAtMs: deltaAtMs, audioDoneAtMs, renderCompleteAtMs, rendererAckAtMs: renderCompleteAtMs + 1,
    rendererAckReceiptId: receiptId, continuousStreamId: 'session' + index } });
}
function timelyMultipleCues() {
  const f = fixture();
  addCompleteCue(f, { index: 2, deltaAtMs: 3500, acousticAtMs: 5000, audioDoneAtMs: 7000 });
  addCompleteCue(f, { index: 3, deltaAtMs: 8750, acousticAtMs: 9000, audioDoneAtMs: 11000 });
  return f;
}
test('a timely first cue cannot hide a later complete cue with 16 seconds of physical startup latency', () => {
  const f = fixture();
  assert.equal(evaluateAecRealtimeEvidence(f).passed, true, 'the first cue remains timely');
  f.media.mediaPlaybackCompletedAtUnixMs = 60000;
  addCompleteCue(f, { index: 2, deltaAtMs: 5000, acousticAtMs: 21000, audioDoneAtMs: 22000 });
  // Enqueue/start claims are timely; only the independently matched acoustic head is late.
  f.timelines[1].timeline.renderStartAtMs = 5500;
  const result = evaluateAecRealtimeEvidence(f);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some(v => v.includes('cue cue2') && v.includes('1.5 seconds')), result.violations.join('; '));
});
test('every complete cue may pass with timely physical startup, including the exact 1.5 second boundary', () => {
  const result = evaluateAecRealtimeEvidence(timelyMultipleCues());
  assert.equal(result.passed, true, result.violations.join('; '));
  assert.deepEqual(result.cues.map(c => c.firstPlayableDeltaToAcousticSeconds), [.6, 1.5, .25]);
  assert.equal(result.thresholds.firstPlayableDeltaToAcousticSeconds, 1.5);
  assert.equal(result.firstAudibleInputToAcousticSeconds, 1);
  assert.equal(result.firstPlayableDeltaToAcousticSeconds, .6);
});
test('one physical recording sample beyond the later cue startup limit fails without widening the threshold', () => {
  const f = timelyMultipleCues();
  f.loopback.matches[1].anchorMatches[0].matchedStartSample += 1;
  const result = evaluateAecRealtimeEvidence(f);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some(v => v.includes('cue cue2') && v.includes('1.5 seconds')), result.violations.join('; '));
});
test('empty cue evidence and missing, nonnumeric or wrong-domain acoustic/delta clocks fail closed', () => {
  for (const [label, mutate] of [
    ['empty complete cue inventory', f => { f.loopback.requiredCompleteCueIds = []; }],
    ['empty receipt inventory', f => { f.timelines = []; }],
    ['empty acoustic inventory', f => { f.loopback.matches = []; }],
    ['missing later delta epoch clock', f => { delete f.timelines[1].timeline.firstAudioDeltaAtMs; f.timelines[1].timeline.firstAudioDeltaQpc100ns = 35000; }],
    ['null later delta clock', f => { f.timelines[1].timeline.firstAudioDeltaAtMs = null; }],
    ['NaN later delta clock', f => { f.timelines[1].timeline.firstAudioDeltaAtMs = NaN; }],
    ['infinite later delta clock', f => { f.timelines[1].timeline.firstAudioDeltaAtMs = Infinity; }],
    ['string later delta clock', f => { f.timelines[1].timeline.firstAudioDeltaAtMs = '3500'; }],
    ['delta seconds instead of epoch milliseconds', f => { f.timelines[1].timeline.firstAudioDeltaAtMs = 3; }],
    ['later acoustic output before its delta', f => { f.timelines[1].timeline.firstAudioDeltaAtMs = 5001; }],
    ['missing recording epoch clock', f => { delete f.loopback.recordingStartedAtEpochMs; }],
    ['null recording clock', f => { f.loopback.recordingStartedAtEpochMs = null; }],
    ['NaN recording clock', f => { f.loopback.recordingStartedAtEpochMs = NaN; }],
    ['string recording clock', f => { f.loopback.recordingStartedAtEpochMs = '1000'; }],
    ['recording seconds instead of epoch milliseconds', f => { f.loopback.recordingStartedAtEpochMs = 1; }],
    ['missing later acoustic head', f => { f.loopback.matches[1].anchorMatches.shift(); }],
    ['null later matched sample', f => { f.loopback.matches[1].anchorMatches[0].matchedStartSample = null; }],
    ['NaN later matched sample', f => { f.loopback.matches[1].anchorMatches[0].matchedStartSample = NaN; }],
    ['negative acoustic sample with otherwise plausible latency', f => {
      f.loopback.matches[0].anchorMatches[0].matchedStartSample = -1;
      f.timelines[0].timeline.firstAudioDeltaAtMs = 950;
      f.providerJournal[0].occurredAtMs = 900;
    }],
  ]) {
    const f = timelyMultipleCues(); mutate(f);
    const result = evaluateAecRealtimeEvidence(f);
    assert.equal(result.passed, false, label);
    assert.ok(result.violations.length > 0, label);
  }
});
test('timely per-cue playback does not relax the global eight second input-to-physical-output gate', () => {
  const f = fixture();
  for (const field of ['firstAudioDeltaAtMs', 'audioDoneAtMs', 'renderCompleteAtMs', 'rendererAckAtMs']) f.timelines[0].timeline[field] += 8000;
  f.loopback.matches[0].anchorMatches[0].matchedStartSample += 128000;
  f.loopback.matches[0].anchorMatches[1].matchedEndSample += 128000;
  f.loopback.recording.samples += 128000;
  f.media.mediaPlaybackCompletedAtUnixMs = 20000;
  const result = evaluateAecRealtimeEvidence(f);
  assert.equal(result.cues[0].firstPlayableDeltaToAcousticSeconds, .6);
  assert.equal(result.firstAudibleInputToAcousticSeconds, 9);
  assert.equal(result.passed, false);
  assert.ok(result.violations.includes('first audible input to physical Chinese output exceeded 8 seconds'));
});
