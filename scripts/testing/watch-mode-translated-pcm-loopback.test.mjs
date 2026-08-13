import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildTranslatedPcmLoopbackAuthority,
  renderBridgeReferenceToLoopback,
} from './watch-mode-translated-pcm-loopback.mjs';

const RUN_MARKER = 'watch_mode_diagnostic.run_id=translated-pcm-test';
const CELL_ID = 'pairwise-live::qwen3.5-omni-flash-realtime::process-exclusion::default-speaker';
const LEASE_ID = 'translated-pcm-test-lease';
const MODEL_ID = 'qwen3.5-omni-flash-realtime';
const PROTOCOL = 'dashscope-omni';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

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
} = {}) {
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'translated-loopback-'));
  const authorityDirectory = path.join(runDirectory, 'translated-cue-pcm');
  const cueDirectory = path.join(authorityDirectory, 'cue-pcm');
  fs.mkdirSync(cueDirectory, { recursive: true });
  const recordingStartedAtEpochMs = new Date(2026, 7, 13, 12, 0, 0, 0).getTime();
  const cueIds = ['omni-cue-test-1', 'omni-cue-test-2'];
  const playbackOffsetsSeconds = providedOffsets;
  const recording = sourceMediaPcm();
  const acceptedCues = [];
  for (let index = 0; index < cueIds.length; index += 1) {
    const cueSeed = 11 + index * 19;
    const samples = deterministicCue(cueSeed);
    const bytes = pcmBuffer(samples);
    const relativePath = `cue-pcm/${index + 1}.pcm`;
    fs.writeFileSync(path.join(authorityDirectory, relativePath), bytes);
    const renderedSamples = recordingMode === 'same-frequency-same-envelope-different-waveform'
      ? deterministicCue(cueSeed, { waveformSeed: cueSeed + 10_000 })
      : recordingMode === 'tone-only'
        ? deterministicCue(cueSeed, { noiseScale: 0 })
        : samples;
    const loopback = renderBridgeReferenceToLoopback(renderedSamples, 24_000);
    const start = Math.round(renderedPlaybackOffsetsSeconds[index] * 16_000);
    for (let offset = 0; offset < loopback.length; offset += 1) {
      const rendered = recordingMode === 'source-only' ? 0 : loopback[offset] * 0.55;
      recording[start + offset] = Math.max(-0.99, Math.min(0.99, recording[start + offset] + rendered));
    }
    acceptedCues.push({
      sequence: index + 1,
      cueId: cueIds[index],
      requestIds: [`request-${index}`],
      sampleRateHz: 24_000,
      channelCount: 1,
      sampleCount: samples.length,
      frameCount: samples.length,
      bytes: bytes.length,
      sha256: sha256(bytes),
      relativePath,
      acceptedFrames: samples.length,
      chunkCount: 1,
      createdAtMs: recordingStartedAtEpochMs + playbackOffsetsSeconds[index] * 1_000 - 50,
      completedAtMs: recordingStartedAtEpochMs + (playbackOffsetsSeconds[index] + 2.6) * 1_000,
    });
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
    schemaVersion: 1,
    artifactKind: 'watch-mode-translated-cue-pcm-authority',
    cellId: CELL_ID,
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
      event: 'bridge_write_accepted',
      sequence: index + 2,
      occurredAtMs: cue.completedAtMs,
      detail: cue,
    })),
    { ...identity, event: 'finalized', sequence: acceptedCues.length + 2, occurredAtMs: recordingStartedAtEpochMs + 15_000 },
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
    lines.push(`${localTimestamp(startMs + 2_600)} [NORMAL] event=translation_playback_status | cueId=${cueIds[index]} status=completed`);
  }
  fs.writeFileSync(path.join(runDirectory, 'app.log'), `${lines.join('\n')}\n`, 'utf8');
  return {
    runDirectory,
    authorityDirectory,
    recordingStartedAtEpochMs,
    summary,
    sourceMediaPeak: recording.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0),
  };
}

function build(fixture) {
  return buildTranslatedPcmLoopbackAuthority({
    runDirectory: fixture.runDirectory,
    runMarker: RUN_MARKER,
    recordingStartedAtEpochMs: fixture.recordingStartedAtEpochMs,
    cellId: CELL_ID,
    leaseId: LEASE_ID,
    modelId: MODEL_ID,
    protocol: PROTOCOL,
  });
}

test('matches every hashed Bridge-accepted translated cue in ordered physical loopback windows', () => {
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

test('CLI accepts the complete strict runner argument contract', () => {
  const fixture = createFixture();
  try {
    const result = spawnSync(process.execPath, [
      path.resolve('scripts/testing/watch-mode-translated-pcm-loopback.mjs'),
      '--run-directory', fixture.runDirectory,
      '--app-log', path.join(fixture.runDirectory, 'app.log'),
      '--run-marker', RUN_MARKER,
      '--recording-started-at-ms', String(fixture.recordingStartedAtEpochMs),
      '--cell-id', CELL_ID,
      '--lease-id', LEASE_ID,
      '--model-id', MODEL_ID,
      '--protocol', PROTOCOL,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const authority = JSON.parse(result.stdout);
    assert.equal(authority.passed, true, authority.violations?.join('; '));
    assert.equal(authority.cellId, CELL_ID);
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
    assert.match(authority.violations.join('; '), /did not uniquely correlate/);
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
        /did not uniquely correlate/,
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
        /overlap or are not one-to-one|did not uniquely correlate/,
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
    assert.match(authority.violations.join('; '), /did not uniquely correlate/);

    fs.writeFileSync(summaryPath, JSON.stringify(fixture.summary), 'utf8');
    fs.writeFileSync(wrongPath, pcmBuffer(deterministicCue(30)));
    const logPath = path.join(fixture.runDirectory, 'app.log');
    fs.writeFileSync(logPath, fs.readFileSync(logPath, 'utf8').replace(/^.*omni-cue-test-2 status=completed.*\r?\n/m, ''), 'utf8');
    authority = build(fixture);
    assert.equal(authority.passed, false);
    assert.match(authority.violations.join('; '), /exactly one ordered timestamped/);
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
