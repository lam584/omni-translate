import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildTranslatedPcmLoopbackAuthority,
} from './watch-mode-translated-pcm-loopback.mjs';

const RUN_MARKER = 'watch_mode_diagnostic.run_id=translated-pcm-test';
const CELL_ID = 'pairwise-live::qwen3.5-livetranslate-flash-realtime::process-exclusion::default-speaker';
const LEASE_ID = 'translated-pcm-test-lease';
const MODEL_ID = 'qwen3.5-livetranslate-flash-realtime';
const PROTOCOL = 'dashscope-livetranslate';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function renderBridgeReferenceToLoopback(samples, sourceRateHz) {
  const bridgeRateHz = 48_000;
  const bridge = new Float32Array(Math.max(1, Math.floor(samples.length * bridgeRateHz / sourceRateHz)));
  for (let index = 0; index < bridge.length; index += 1) {
    bridge[index] = samples[Math.min(samples.length - 1, Math.floor(index * sourceRateHz / bridgeRateHz))];
  }
  const output = new Float32Array(Math.max(1, Math.floor(bridge.length * 16_000 / bridgeRateHz)));
  for (let index = 0; index < output.length; index += 1) {
    const source = index * bridgeRateHz / 16_000;
    const left = Math.min(bridge.length - 1, Math.floor(source));
    const right = Math.min(bridge.length - 1, left + 1);
    output[index] = bridge[left] + (bridge[right] - bridge[left]) * (source - left);
  }
  return output;
}

function pcmBuffer(samples) {
  const bytes = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[index] * 32767))), index * 2);
  }
  return bytes;
}

function deterministicCue(seed, {
  sampleRateHz = 24_000,
  seconds = 2.6,
  waveformSeed = seed,
  toneSeed = seed,
  noiseScale = 0.38,
  toneScale = 0.32,
} = {}) {
  const output = new Float32Array(Math.round(sampleRateHz * seconds));
  let state = waveformSeed >>> 0;
  for (let index = 0; index < output.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const noise = (state / 0xffffffff) * 2 - 1;
    const envelope = Math.sin(Math.PI * index / output.length) ** 0.5;
    const tone = Math.sin(2 * Math.PI * (180 + toneSeed * 7 + index / sampleRateHz * 90) * index / sampleRateHz);
    output[index] = envelope * (noiseScale * noise + toneScale * tone);
  }
  return output;
}

// This is deliberately not silence or a fixed test tone. It represents the
// source-language programme that reaches the physical output while no
// translated cue is rendered: voiced fundamental, changing formants, and
// non-periodic amplitude modulation. A source-only negative must therefore
// prove rejection in the presence of real source media PCM.
function sourceMediaPcm(sampleRateHz = 16_000, seconds = 16) {
  const output = new Float32Array(Math.round(sampleRateHz * seconds));
  for (let index = 0; index < output.length; index += 1) {
    const time = index / sampleRateHz;
    const voiced = Math.sin(2 * Math.PI * (121 + 7 * Math.sin(time * 0.71)) * time);
    const formant = Math.sin(2 * Math.PI * (487 + 19 * Math.sin(time * 0.37)) * time);
    const consonant = Math.sin(2 * Math.PI * 1_931 * time) * Math.sin(2 * Math.PI * 3.7 * time);
    const envelope = 0.42 + 0.36 * Math.sin(2 * Math.PI * 0.63 * time) ** 2;
    output[index] = 0.075 * envelope * (0.58 * voiced + 0.29 * formant + 0.13 * consonant);
  }
  return output;
}

function localTimestamp(epochMs) {
  const value = new Date(epochMs);
  const pad = (number, length = 2) => String(number).padStart(length, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`;
}

function createFixture({
  recordingMode = 'full',
  playbackOffsetsSeconds: providedOffsets = [3.2, 9.4],
  renderedPlaybackOffsetsSeconds = providedOffsets,
  streamChunkGapSeconds = 0,
  renderUsingAcceptedChunkSchedule = false,
  interfereWithStrongestMiddleAnchor = false,
  cueSeconds = [2.6, 2.6],
  playbackOwnerGenerations = [10, 20],
  feedbackLoopPrevention = 'process-exclusion',
} = {}) {
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'translated-loopback-'));
  const authorityDirectory = path.join(runDirectory, 'translated-cue-pcm');
  const cueDirectory = path.join(authorityDirectory, 'cue-pcm');
  fs.mkdirSync(cueDirectory, { recursive: true });
  const recordingStartedAtEpochMs = new Date(2026, 7, 13, 12, 0, 0, 0).getTime();
  const cellId = CELL_ID.replace('::process-exclusion::', `::${feedbackLoopPrevention}::`);
  const rendererKind = feedbackLoopPrevention === 'echo-cancel'
    ? 'desktop-speaker'
    : 'bridge-physical-playback';
  const cueIds = cueSeconds.map((_, index) => `omni-cue-test-${index + 1}`);
  const playbackOffsetsSeconds = providedOffsets;
  const requiredRecordingSeconds = Math.max(
    16,
    ...renderedPlaybackOffsetsSeconds.map((offset, index) => offset + cueSeconds[index] + 4),
  );
  const recording = sourceMediaPcm(
    16_000,
    renderUsingAcceptedChunkSchedule ? Math.max(32, requiredRecordingSeconds) : requiredRecordingSeconds,
  );
  const acceptedCues = [];
  for (let index = 0; index < cueIds.length; index += 1) {
    const cueSeed = 11 + index * 19;
    const samples = deterministicCue(cueSeed, { seconds: cueSeconds[index] });
    const bytes = pcmBuffer(samples);
    const relativePath = `cue-pcm/${index + 1}.pcm`;
    fs.writeFileSync(path.join(authorityDirectory, relativePath), bytes);
    const renderedSamples = recordingMode === 'same-frequency-same-envelope-different-waveform'
      ? deterministicCue(cueSeed, { waveformSeed: cueSeed + 10_000 })
      : recordingMode === 'tone-only'
        ? deterministicCue(cueSeed, { noiseScale: 0 })
        : samples;
    const chunkLength = streamChunkGapSeconds > 0 ? Math.ceil(samples.length / 3) : samples.length;
    const chunks = [];
    let priorRenderedChunkEndSeconds = renderedPlaybackOffsetsSeconds[index];
    for (let sampleOffset = 0, chunkIndex = 0; sampleOffset < samples.length; sampleOffset += chunkLength, chunkIndex += 1) {
      const sampleCount = Math.min(chunkLength, samples.length - sampleOffset);
      const acceptedAtSeconds = playbackOffsetsSeconds[index] - 0.8
        + chunkIndex * streamChunkGapSeconds;
      const chunkStartSeconds = renderUsingAcceptedChunkSchedule
        ? Math.max(priorRenderedChunkEndSeconds, acceptedAtSeconds)
        : renderedPlaybackOffsetsSeconds[index] + sampleOffset / 24_000;
      const loopback = renderBridgeReferenceToLoopback(
        renderedSamples.slice(sampleOffset, sampleOffset + sampleCount), 24_000,
      );
      const start = Math.round(chunkStartSeconds * 16_000);
      for (let offset = 0; offset < loopback.length; offset += 1) {
        const rendered = recordingMode === 'source-only' ? 0 : loopback[offset] * 0.55;
        recording[start + offset] = Math.max(-0.99, Math.min(0.99, recording[start + offset] + rendered));
      }
      chunks.push({
        chunkIndex,
        requestId: `request-${index}-${chunkIndex}`,
        sampleOffset,
        sampleCount,
        acceptedAtMs: Math.round(recordingStartedAtEpochMs + acceptedAtSeconds * 1_000),
      });
      priorRenderedChunkEndSeconds = chunkStartSeconds + sampleCount / 24_000;
    }
    acceptedCues.push({
      sequence: index + 1,
      cueId: cueIds[index],
      responseId: `response-${index + 1}`,
      rendererKind,
      requestIds: chunks.map((chunk) => chunk.requestId),
      sampleRateHz: 24_000,
      channelCount: 1,
      sampleCount: samples.length,
      frameCount: samples.length,
      bytes: bytes.length,
      sha256: sha256(bytes),
      relativePath,
      ...(rendererKind === 'bridge-physical-playback' ? {
        acceptedFrames: samples.length,
      } : {}),
      chunkCount: chunks.length,
      chunks,
      createdAtMs: recordingStartedAtEpochMs + playbackOffsetsSeconds[index] * 1_000 - 50,
      completedAtMs: recordingStartedAtEpochMs + (playbackOffsetsSeconds[index] + cueSeconds[index]) * 1_000,
      ...(rendererKind === 'bridge-physical-playback' ? {
        sessionId: index === 0 ? 'session-before-restart' : 'session-after-restart',
        bridgeInstanceId: index === 0 ? 'bridge-before-restart' : 'bridge-after-restart',
        sourceGeneration: index === 0 ? 1 : 2,
        sourceGenerationToken: index === 0
          ? 'bridge-before-restart:session-before-restart:1'
          : 'bridge-after-restart:session-after-restart:2',
        playbackOwnerGeneration: playbackOwnerGenerations[index]
          ?? playbackOwnerGenerations.at(-1),
      } : {
        rendererInstanceId: 'desktop-renderer-instance-1',
        rendererOwnerGeneration: 1,
        renderAttemptId: `desktop-render-attempt-${index + 1}`,
        playedFrames: samples.length * 2,
        playedSampleRateHz: 48_000,
        playedChannelCount: 2,
      }),
      physicalPlaybackDeviceId: '{hda-test-endpoint}',
    });
    if (interfereWithStrongestMiddleAnchor && index === 0) {
      const windowFrames = Math.ceil(24_000 * 0.4);
      const regionStart = Math.floor(samples.length / 3);
      const regionEnd = Math.floor(samples.length * 2 / 3);
      let strongest = { frameOffset: regionStart, rms: -1 };
      for (let frameOffset = regionStart; frameOffset + windowFrames <= regionEnd; frameOffset += 1_200) {
        let squareSum = 0;
        for (let offset = 0; offset < windowFrames; offset += 1) {
          squareSum += samples[frameOffset + offset] ** 2;
        }
        const rms = Math.sqrt(squareSum / windowFrames);
        if (rms > strongest.rms) strongest = { frameOffset, rms };
      }
      const interferenceStart = Math.round(
        (renderedPlaybackOffsetsSeconds[index] + strongest.frameOffset / 24_000) * 16_000,
      );
      for (let offset = 0; offset < Math.round(0.4 * 16_000); offset += 1) {
        const time = offset / 16_000;
        recording[interferenceStart + offset] = 0.75 * Math.sin(2 * Math.PI * 1_337 * time);
      }
    }
  }
  fs.writeFileSync(path.join(runDirectory, 'physical-output-recording-16k-mono.pcm'), pcmBuffer(recording));
  fs.writeFileSync(path.join(runDirectory, 'watch-session-report.json'), JSON.stringify({
    cues: cueIds.map((cueId) => ({
      cueId,
      comparisonStatus: 'exact',
      llmText: `translation ${cueId}`,
      publishedText: `translation ${cueId}`,
      renderedText: `translation ${cueId}`,
    })),
  }), 'utf8');
  const identity = {
    schemaVersion: 2,
    artifactKind: 'watch-mode-translated-cue-pcm-authority',
    cellId,
    leaseId: LEASE_ID,
    runMarker: RUN_MARKER,
    sessionGeneration: 1,
    direction: 'inbound',
    model: MODEL_ID,
    protocol: PROTOCOL,
  };
  const summary = {
    ...identity,
    maxProviderInputSamples: 2_880_000,
    pcmFormat: 's16le',
    cueCount: acceptedCues.length,
    totalSamples: acceptedCues.reduce((sum, cue) => sum + cue.sampleCount, 0),
    totalBytes: acceptedCues.reduce((sum, cue) => sum + cue.bytes, 0),
    abortedStreamCount: 0,
    activeStreamCount: 0,
    acceptedCues,
    finalized: true,
    terminalReason: 'worker-completed',
  };
  fs.writeFileSync(path.join(authorityDirectory, 'translated-cue-pcm-summary.json'), JSON.stringify(summary), 'utf8');
  const journal = [
    { ...identity, event: 'initialized', sequence: 1, occurredAtMs: recordingStartedAtEpochMs },
    ...acceptedCues.map((cue, index) => ({
      ...identity,
      event: cue.rendererKind === 'bridge-physical-playback'
        ? 'bridge_write_accepted'
        : 'desktop_speaker_played',
      sequence: index + 2,
      occurredAtMs: cue.completedAtMs,
      detail: cue,
    })),
    {
      ...identity,
      event: 'finalized',
      sequence: acceptedCues.length + 2,
      occurredAtMs: Math.max(...acceptedCues.map((cue) => cue.completedAtMs)) + 100,
    },
  ];
  fs.writeFileSync(
    path.join(authorityDirectory, 'translated-cue-pcm-authority.jsonl'),
    `${journal.map(JSON.stringify).join('\n')}\n`,
    'utf8',
  );
  const lines = [RUN_MARKER];
  for (let index = 0; index < cueIds.length; index += 1) {
    const startMs = recordingStartedAtEpochMs + playbackOffsetsSeconds[index] * 1_000;
    lines.push(`${localTimestamp(startMs - 20)} [NORMAL] event=translation_playback_status | cueId=${cueIds[index]} status=queued`);
    lines.push(`${localTimestamp(startMs)} [NORMAL] event=translation_playback_status | cueId=${cueIds[index]} status=started`);
    lines.push(`${localTimestamp(startMs + cueSeconds[index] * 1_000)} [NORMAL] event=translation_playback_status | cueId=${cueIds[index]} status=completed`);
    if (index === 0 && feedbackLoopPrevention === 'process-exclusion') {
      const restartAtMs = recordingStartedAtEpochMs + 7_000;
      lines.push(`${localTimestamp(restartAtMs)} [NORMAL] event=process_exclusion_restart_summary | status=passed runMarker=${RUN_MARKER} recoveredAtUnixMs=${restartAtMs} oldPlaybackOwnerGeneration=10 newPlaybackOwnerGeneration=20 oldPhysicalPlaybackDeviceId={hda-test-endpoint} newPhysicalPlaybackDeviceId={hda-test-endpoint} physicalPlaybackStatus=ready physicalPlaybackRebindDurationMs=250`);
    }
  }
  fs.writeFileSync(path.join(runDirectory, 'app.log'), `${lines.join('\n')}\n`, 'utf8');
  return {
    runDirectory,
    authorityDirectory,
    recordingStartedAtEpochMs,
    summary,
    cellId,
    feedbackLoopPrevention,
    sourceMediaPeak: recording.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0),
  };
}

function build(fixture) {
  return buildTranslatedPcmLoopbackAuthority({
    runDirectory: fixture.runDirectory,
    runMarker: RUN_MARKER,
    recordingStartedAtEpochMs: fixture.recordingStartedAtEpochMs,
    cellId: fixture.cellId,
    leaseId: LEASE_ID,
    modelId: MODEL_ID,
    protocol: PROTOCOL,
    feedbackLoopPrevention: fixture.feedbackLoopPrevention,
  });
}

test('matches every schema-v2 Bridge-rendered translated cue in ordered physical loopback windows', () => {
  const fixture = createFixture();
  try {
    const authority = build(fixture);
    assert.equal(authority.passed, true, authority.violations.join('; '));
    assert.equal(authority.requiredCompleteCueCount, 2);
    assert.equal(authority.matchedCueCount, 2);
    assert.ok(authority.matches.every((match) => match.identityMargin >= 0.08));
    assert.deepEqual(authority.matches.map((match) => match.cueId), fixture.summary.acceptedCues.map((cue) => cue.cueId));
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('accepts schema-v2 echo-cancel cues only from the Desktop speaker renderer', () => {
  const fixture = createFixture({ feedbackLoopPrevention: 'echo-cancel' });
  try {
    const authority = build(fixture);
    assert.equal(authority.passed, true, authority.violations.join('; '));
    assert.equal(authority.feedbackLoopPrevention, 'echo-cancel');
    assert.equal(authority.finalRequiredCueId, 'omni-cue-test-2');
    assert.ok(authority.matches.every((match) => (
      match.rendererKind === 'desktop-speaker'
      && match.renderAttemptId
      && match.bridgeInstanceId === null
      && match.playbackOwnerGeneration === null
    )));
    assert.equal(authority.matches.at(-1).passed, true);
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('rejects mixed renderer fields, wrong completion events, and aborted echo authority', () => {
  const fixture = createFixture({ feedbackLoopPrevention: 'echo-cancel' });
  try {
    const summaryPath = path.join(
      fixture.authorityDirectory,
      'translated-cue-pcm-summary.json',
    );
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    summary.acceptedCues[0].responseId = '';
    summary.acceptedCues[0].sessionId = 'forged-bridge-session';
    fs.writeFileSync(summaryPath, JSON.stringify(summary), 'utf8');

    const journalPath = path.join(
      fixture.authorityDirectory,
      'translated-cue-pcm-authority.jsonl',
    );
    const journal = fs.readFileSync(journalPath, 'utf8')
      .trim()
      .split(/\r?\n/u)
      .map(JSON.parse);
    journal[1].detail = structuredClone(summary.acceptedCues[0]);
    journal[2].event = 'bridge_write_accepted';
    const finalized = journal.pop();
    journal.push({
      ...journal[0],
      event: 'stream_aborted',
      sequence: journal.length + 1,
      occurredAtMs: finalized.occurredAtMs - 1,
      detail: { cueId: summary.acceptedCues[1].cueId, reason: 'fixture-cancelled' },
    });
    finalized.sequence = journal.length + 1;
    journal.push(finalized);
    fs.writeFileSync(
      journalPath,
      `${journal.map(JSON.stringify).join('\n')}\n`,
      'utf8',
    );

    const authority = build(fixture);
    const violations = authority.violations.join('; ');
    assert.equal(authority.passed, false);
    assert.match(violations, /response identity is missing/);
    assert.match(violations, /Desktop renderer contains forbidden Bridge fields/);
    assert.match(violations, /journal event does not bind its renderer completion/);
    assert.match(violations, /journal contains stream_aborted/);
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('uses the signed restart summary only for complete post-recovery playback on the new owner', () => {
  const fixture = createFixture({ playbackOwnerGenerations: [10, 20] });
  try {
    const authority = build(fixture);
    assert.equal(authority.passed, true, authority.violations.join('; '));
    assert.deepEqual(authority.restartPlaybackEvidence, {
      recoveredAtMs: fixture.recordingStartedAtEpochMs + 7_000,
      playbackOwnerGeneration: 20,
      physicalPlaybackDeviceId: '{hda-test-endpoint}',
      matchedCueIds: ['omni-cue-test-2'],
      passed: true,
    });
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('rejects new-owner labels when every complete cue finished before restart recovery', () => {
  const fixture = createFixture({
    playbackOffsetsSeconds: [1, 4],
    playbackOwnerGenerations: [20, 20],
  });
  try {
    const recoveredAtMs = fixture.recordingStartedAtEpochMs + 7_000;
    assert.ok(
      fixture.summary.acceptedCues.every((cue) => cue.completedAtMs < recoveredAtMs),
      'the counterexample must contain no complete cue after recoveredAt',
    );

    const authority = build(fixture);
    assert.equal(
      authority.passed,
      false,
      'a claimed new owner cannot turn pre-recovery acoustic playback into post-restart authority',
    );
    assert.equal(authority.restartPlaybackEvidence?.passed, false);
    assert.match(
      authority.violations.join('; '),
      /post-restart|recoveredAt|recovery/i,
    );
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('uses started playback time plus PCM offsets even when ACK timestamps arrive early', () => {
  const fixture = createFixture({ streamChunkGapSeconds: 0.08 });
  try {
    const authority = build(fixture);
    assert.equal(authority.passed, true, JSON.stringify(authority.matches));
    assert.ok(authority.matches.every((match) => match.requiredAnchorMatches === 3));
    assert.ok(authority.matches.every((match) => match.matchedAnchorCount === 3));
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('maps anchors through accepted chunk gaps after the physical stream drains', () => {
  const fixture = createFixture({
    streamChunkGapSeconds: 4,
    cueSeconds: [8, 8],
    playbackOffsetsSeconds: [3.2, 16],
    renderUsingAcceptedChunkSchedule: true,
  });
  try {
    const authority = build(fixture);
    assert.equal(authority.passed, true, JSON.stringify(authority.matches));
    assert.ok(authority.matches.every((match) => match.matchedAnchorCount === 3));
    assert.ok(authority.matches.every((match) => (
      match.anchorMatches.every((anchor) => Math.abs(anchor.timingErrorSeconds) <= 0.65)
    )));
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('uses another independent high-energy window when the strongest window is masked by source audio', () => {
  const fixture = createFixture({
    interfereWithStrongestMiddleAnchor: true,
    cueSeconds: [8, 8],
    playbackOffsetsSeconds: [2, 14],
  });
  try {
    const authority = build(fixture);
    assert.equal(authority.passed, true, JSON.stringify(authority.matches));
    assert.ok(authority.matches[0].anchorMatches.some((anchor) => anchor.candidateCount > 1));
    assert.equal(authority.matches[0].matchedAnchorCount, 3);
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('uses duration-adaptive anchors for medium and short complete cues', () => {
  for (const { seconds, requiredAnchorMatches } of [
    { seconds: 1.0, requiredAnchorMatches: 2 },
    { seconds: 0.6, requiredAnchorMatches: 1 },
  ]) {
    const fixture = createFixture({ cueSeconds: [seconds, seconds] });
    try {
      const authority = build(fixture);
      assert.equal(authority.passed, true, authority.violations.join('; '));
      assert.equal(authority.matchedCueCount, 2);
      assert.ok(authority.matches.every((match) => match.requiredAnchorMatches === requiredAnchorMatches));
      assert.deepEqual(authority.unauditableCues, []);
    } finally {
      fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
    }
  }
});

test('sub-400ms cues are explicit non-authority and cannot replace two acoustic proofs', () => {
  const fixture = createFixture({ cueSeconds: [0.3, 0.3] });
  try {
    const authority = build(fixture);
    assert.equal(authority.passed, false);
    assert.equal(authority.matches.length, 0);
    assert.equal(authority.unauditableCues.length, 2);
    assert.match(authority.violations.join('; '), /at least 2 acoustically auditable complete cues/);
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('rejects an unauditable final cue even when two earlier cues have complete acoustic proof', () => {
  const fixture = createFixture({
    cueSeconds: [2.6, 2.6, 0.3],
    playbackOffsetsSeconds: [1, 5, 10],
    playbackOwnerGenerations: [10, 20, 20],
  });
  try {
    const authority = build(fixture);
    assert.equal(authority.matchedCueCount, 2);
    assert.equal(authority.finalRequiredCueId, 'omni-cue-test-3');
    assert.equal(authority.passed, false);
    assert.match(
      authority.violations.join('; '),
      /final complete rendered cue omni-cue-test-3 must itself be acoustically auditable and passed/,
    );
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('keeps playback lifecycle events when later diagnostics repeat the run marker', () => {
  const fixture = createFixture();
  try {
    fs.appendFileSync(
      path.join(fixture.runDirectory, 'app.log'),
      `${localTimestamp(fixture.recordingStartedAtEpochMs + 15_000)} [NORMAL] diagnostic_report_saved | runMarker=${RUN_MARKER}\n`,
      'utf8',
    );
    const authority = build(fixture);
    assert.equal(authority.passed, true, authority.violations.join('; '));
    assert.equal(authority.matchedCueCount, fixture.summary.acceptedCues.length);
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('CLI accepts the complete strict runner argument contract', () => {
  const fixture = createFixture();
  try {
    const result = spawnSync(process.execPath, [
      path.resolve('scripts/testing/watch-mode-translated-pcm-loopback.mjs'),
      '--run-directory', fixture.runDirectory,
      '--app-log', path.join(fixture.runDirectory, 'app.log'),
      '--run-marker', RUN_MARKER,
      '--recording-started-at-ms', String(fixture.recordingStartedAtEpochMs),
      '--cell-id', fixture.cellId,
      '--lease-id', LEASE_ID,
      '--model-id', MODEL_ID,
      '--protocol', PROTOCOL,
      '--feedback-loop-prevention', fixture.feedbackLoopPrevention,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const authority = JSON.parse(result.stdout);
    assert.equal(authority.passed, true, authority.violations?.join('; '));
    assert.equal(authority.cellId, fixture.cellId);
    assert.equal(authority.leaseId, LEASE_ID);
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('explicit playback timestampMs overrides the local log-line prefix', () => {
  const fixture = createFixture();
  try {
    const logPath = path.join(fixture.runDirectory, 'app.log');
    let log = fs.readFileSync(logPath, 'utf8');
    for (const cue of fixture.summary.acceptedCues) {
      const startedAtMs = cue.createdAtMs + 50;
      const linePattern = new RegExp(`^.*cueId=${cue.cueId} status=started.*$`, 'm');
      log = log.replace(linePattern, (line) => (
        `${line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/, localTimestamp(startedAtMs + 30_000))} timestampMs=${startedAtMs}`
      ));
    }
    fs.writeFileSync(logPath, log, 'utf8');
    const authority = build(fixture);
    assert.equal(authority.passed, true, authority.violations.join('; '));
    assert.equal(authority.matchedCueCount, fixture.summary.acceptedCues.length);
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('rejects same-frequency same-envelope different waveform cues', () => {
  const fixture = createFixture({ recordingMode: 'same-frequency-same-envelope-different-waveform' });
  try {
    const authority = build(fixture);
    assert.equal(authority.passed, false);
    assert.equal(authority.matches.length, 2);
    assert.ok(authority.matches.every((match) => Number.isFinite(match.score) && Number.isFinite(match.identityMargin)));
    assert.match(authority.violations.join('; '), /did not correlate three ordered/);
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('rejects tone-only components and real source-only media PCM', () => {
  for (const options of [
    { recordingMode: 'tone-only' },
    { recordingMode: 'source-only' },
  ]) {
    const fixture = createFixture(options);
    try {
      const authority = build(fixture);
      assert.equal(authority.passed, false, JSON.stringify(options));
      assert.ok(fixture.sourceMediaPeak > 0.01, 'source-only fixture must contain actual non-silent source media');
      assert.equal(authority.matches.length, 2);
      assert.ok(authority.matches.every((match) => Number.isFinite(match.score) && Number.isFinite(match.identityMargin)));
      assert.match(
        authority.violations.join('; '),
        /did not correlate three ordered/,
      );
    } finally {
      fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
    }
  }
});

test('rejects cross-lifecycle overlap and reuse of the same physical window', () => {
  for (const options of [
    { playbackOffsetsSeconds: [3.2, 3.5] },
    { playbackOffsetsSeconds: [3.2, 3.2] },
  ]) {
    const fixture = createFixture(options);
    try {
      const authority = build(fixture);
      assert.equal(authority.passed, false, JSON.stringify(options));
      assert.equal(authority.matches.length, 2);
      assert.ok(authority.matches.every((match) => Number.isFinite(match.score) && Number.isFinite(match.identityMargin)));
      assert.match(
        authority.violations.join('; '),
        /overlap or are not one-to-one|did not correlate three ordered/,
      );
    } finally {
      fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
    }
  }
});

test('rejects a self-consistently rehashed wrong cue and a missing completed lifecycle', () => {
  const fixture = createFixture();
  try {
    const summaryPath = path.join(fixture.authorityDirectory, 'translated-cue-pcm-summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const wrong = pcmBuffer(deterministicCue(999));
    const wrongPath = path.join(fixture.authorityDirectory, summary.acceptedCues[1].relativePath);
    fs.writeFileSync(wrongPath, wrong);
    summary.acceptedCues[1].sha256 = sha256(wrong);
    fs.writeFileSync(summaryPath, JSON.stringify(summary), 'utf8');
    let authority = build(fixture);
    assert.equal(authority.passed, false);
    assert.match(authority.violations.join('; '), /did not correlate three ordered/);

    fs.writeFileSync(summaryPath, JSON.stringify(fixture.summary), 'utf8');
    fs.writeFileSync(wrongPath, pcmBuffer(deterministicCue(30)));
    const logPath = path.join(fixture.runDirectory, 'app.log');
    fs.writeFileSync(logPath, fs.readFileSync(logPath, 'utf8').replace(/^.*omni-cue-test-2 status=completed.*\r?\n/m, ''), 'utf8');
    authority = build(fixture);
    assert.equal(authority.passed, false);
    assert.match(authority.violations.join('; '), /exactly one ordered timestamped/);
    assert.equal(authority.matches.length, 1, 'a bad terminal cue must not hide diagnostics for valid earlier cues');
    assert.equal(authority.matches[0].cueId, 'omni-cue-test-1');
    assert.equal(authority.matches[0].passed, true);
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});

test('rejects PCM hash tampering and traversal outside the authority directory', () => {
  const fixture = createFixture();
  try {
    const summaryPath = path.join(fixture.authorityDirectory, 'translated-cue-pcm-summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    fs.appendFileSync(path.join(fixture.authorityDirectory, summary.acceptedCues[0].relativePath), Buffer.from([0, 0]));
    let authority = build(fixture);
    assert.equal(authority.passed, false);
    assert.match(authority.violations.join('; '), /file hash\/length mismatch/);

    summary.acceptedCues[0].relativePath = '../outside.pcm';
    fs.writeFileSync(summaryPath, JSON.stringify(summary), 'utf8');
    authority = build(fixture);
    assert.equal(authority.passed, false);
    assert.match(authority.violations.join('; '), /may not contain '\.\.'/);
  } finally {
    fs.rmSync(fixture.runDirectory, { recursive: true, force: true });
  }
});
