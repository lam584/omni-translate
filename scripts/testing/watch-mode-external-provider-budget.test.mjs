import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';

import {
  STRICT_PAID_MATRIX_MAX_INPUT_SAMPLES,
  PROVIDER_INPUT_PREFILTER_FILE,
  PROVIDER_INPUT_PREFILTER_MAGIC,
  PROVIDER_SEND_BOUNDARY_JOURNAL_FILE,
  actualProviderInputSamplesFromLog,
  assertCellExternalProviderBudget,
  assertMatrixExternalProviderBudget,
  buildCellExternalProviderBudget,
  buildMatrixExternalProviderBudget,
  isAbsoluteEvidencePathForFixedFile,
  reserveStrictPaidCellInputSamples,
  replayProviderInputPrefilter,
  writePreProviderTerminalAuthority,
  writeCellExternalProviderBudget,
} from './watch-mode-external-provider-budget.mjs';
import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
import {
  buildPhysicalSourceWaveformAuthority,
  loadCanonicalFixtureAuthority,
} from './watch-mode-canonical-source-authority.mjs';

const MARKER = 'watch_mode_diagnostic.run_id=0123456789abcdef0123456789abcdef';
const MODEL = 'qwen3.5-livetranslate-flash-realtime';
const CELL_ID = LIVE_LLM_CELLS[0].cellId;
const MODEL_PROTOCOL_PROFILE_IDENTITY = LIVE_LLM_CELLS[0].modelProtocolProfileIdentity;
const fileSha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const inputCeilingSamplesForMode = (feedbackLoopPrevention) => LIVE_LLM_CELLS.find(
  (cell) => cell.feedbackLoopPrevention === feedbackLoopPrevention,
)?.maxExternalAudioSamples;

function preProviderReceiptFixture(t, { existing = true } = {}) {
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-terminal-receipt-'));
  t.after(() => {
    assert.ok(path.resolve(runDirectory).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(runDirectory, { recursive: true, force: true });
  });
  const options = { runDirectory, runMarker: MARKER, cellId: CELL_ID, leaseId: 'coordinator-lease', modelId: MODEL,
    inputCeilingSamples: inputCeilingSamplesForMode('echo-cancel'), occurredAtMs: 7 };
  const receipt = { schemaVersion: 2, artifactKind: 'watch-mode-provider-input-budget-lease', nonAuthoritative: false,
    cellId: CELL_ID, leaseId: options.leaseId, runMarker: MARKER, maxSamples: options.inputCeilingSamples,
    modelProtocolProfileIdentity: structuredClone(MODEL_PROTOCOL_PROFILE_IDENTITY) };
  const leasePath = path.join(runDirectory, 'provider-input-budget-lease.json');
  fs.writeFileSync(path.join(runDirectory, 'app.log'), `${MARKER}\n`, 'utf8');
  if (existing) fs.writeFileSync(leasePath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { runDirectory, options, receipt, leasePath };
}

test('pre-provider terminal accepts existing strict receipt with explicit nonAuthoritative false unchanged', (t) => {
  const f = preProviderReceiptFixture(t);
  const before = fs.readFileSync(f.leasePath);
  writePreProviderTerminalAuthority(f.options);
  assert.deepEqual(fs.readFileSync(f.leasePath), before);
  const budget = buildCellExternalProviderBudget(buildOptions(f.runDirectory));
  assert.equal(budget.passed, true, budget.violations.join('; '));
  assert.equal(budget.calls.mainRealtime, 0);
  assert.equal(budget.actualProviderInputSamples, 0);
});

test('pre-provider terminal creates the same explicit authoritative receipt when absent', (t) => {
  const f = preProviderReceiptFixture(t, { existing: false });
  writePreProviderTerminalAuthority(f.options);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.leasePath)), f.receipt);
});

for (const [label, mutate] of [
  ['non-authoritative', (r) => { r.nonAuthoritative = true; }],
  ['missing authority flag', (r) => { delete r.nonAuthoritative; }],
  ['string authority flag', (r) => { r.nonAuthoritative = 'false'; }],
  ['unknown field', (r) => { r.unrecognized = false; }],
  ['lease id', (r) => { r.leaseId = 'different'; }],
  ['run marker', (r) => { r.runMarker = 'different'; }],
  ['cell id', (r) => { r.cellId = 'different'; }],
  ['ceiling', (r) => { r.maxSamples++; }],
  ['schema', (r) => { r.schemaVersion++; }],
  ['kind', (r) => { r.artifactKind = 'different'; }],
  ['model identity', (r) => { r.modelProtocolProfileIdentity.exactModelId = 'different'; }],
  ['unknown nested field', (r) => { r.modelProtocolProfileIdentity.unrecognized = false; }],
]) test(`pre-provider terminal rejects ${label} without replacing evidence`, (t) => {
  const f = preProviderReceiptFixture(t); mutate(f.receipt);
  const bytes = JSON.stringify(f.receipt); fs.writeFileSync(f.leasePath, bytes, 'utf8');
  assert.throws(() => writePreProviderTerminalAuthority(f.options), /receipt does not match/);
  assert.equal(fs.readFileSync(f.leasePath, 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(f.runDirectory, 'provider-input-budget-ledger.json')), false);
  assert.equal(fs.existsSync(path.join(f.runDirectory, PROVIDER_SEND_BOUNDARY_JOURNAL_FILE)), false);
});

for (const file of ['provider-input-budget-ledger.json', PROVIDER_SEND_BOUNDARY_JOURNAL_FILE,
  'provider-input-16k-mono.pcm', PROVIDER_INPUT_PREFILTER_FILE]) {
  test(`pre-provider terminal preserves partial or existing ${file} and emits no replacement`, (t) => {
    const f = preProviderReceiptFixture(t);
    const artifact = path.join(f.runDirectory, file); const bytes = Buffer.from('partial-or-real-provider-evidence');
    fs.writeFileSync(artifact, bytes);
    const before = fs.readdirSync(f.runDirectory).sort();
    assert.throws(() => writePreProviderTerminalAuthority(f.options), /refusing to replace/);
    assert.deepEqual(fs.readdirSync(f.runDirectory).sort(), before);
    assert.deepEqual(fs.readFileSync(artifact), bytes);
  });
}

test('pre-provider terminal rejects malformed existing receipt without output', (t) => {
  const f = preProviderReceiptFixture(t); fs.writeFileSync(f.leasePath, '{', 'utf8');
  assert.throws(() => writePreProviderTerminalAuthority(f.options));
  assert.equal(fs.readFileSync(f.leasePath, 'utf8'), '{');
  assert.equal(fs.existsSync(path.join(f.runDirectory, 'provider-input-budget-ledger.json')), false);
});

test('interrupted terminal journal write remains failed evidence and cannot be resumed as zero-call success', (t) => {
  const f = preProviderReceiptFixture(t);
  const writeFileSync = fs.writeFileSync;
  const journalPath = path.join(f.runDirectory, PROVIDER_SEND_BOUNDARY_JOURNAL_FILE);
  const mock = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file === journalPath) throw new Error('injected journal write failure');
    return writeFileSync(file, ...args);
  });
  try { assert.throws(() => writePreProviderTerminalAuthority(f.options), /injected journal write failure/); }
  finally { mock.mock.restore(); }
  const ledgerPath = path.join(f.runDirectory, 'provider-input-budget-ledger.json');
  const before = fs.readFileSync(ledgerPath);
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(buildCellExternalProviderBudget(buildOptions(f.runDirectory)).passed, false);
  assert.throws(() => writePreProviderTerminalAuthority(f.options), /refusing to replace/);
  assert.deepEqual(fs.readFileSync(ledgerPath), before);
  assert.equal(fs.existsSync(journalPath), false);
});

test('concurrent terminal writers elect one exclusive ledger owner and preserve receipt bytes', async (t) => {
  const f = preProviderReceiptFixture(t); const before = fs.readFileSync(f.leasePath);
  const moduleUrl = new URL('./watch-mode-external-provider-budget.mjs', import.meta.url).href;
  const workers = [7, 8].map((occurredAtMs) => new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    import(workerData.moduleUrl).then(({writePreProviderTerminalAuthority})=>{
      parentPort.once('message',()=>{try{writePreProviderTerminalAuthority(workerData.options);parentPort.postMessage({ok:true});}
        catch(error){parentPort.postMessage({ok:false,message:error.message});}});
      parentPort.postMessage({ready:true});
    }).catch(error=>{throw error;});`, { eval: true, workerData: { moduleUrl, options: { ...f.options, occurredAtMs } } }));
  t.after(async () => { await Promise.all(workers.map((w) => w.terminate())); });
  const finished = workers.map((worker) => new Promise((resolve, reject) => {
    worker.on('error', reject); worker.on('message', (message) => { if (!message.ready) resolve(message); });
  }));
  await Promise.all(workers.map((worker) => new Promise((resolve) => worker.once('message', resolve))));
  workers.forEach((worker) => worker.postMessage('go'));
  const results = await Promise.all(finished);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.deepEqual(fs.readFileSync(f.leasePath), before);
  const ledger = JSON.parse(fs.readFileSync(path.join(f.runDirectory, 'provider-input-budget-ledger.json')));
  const journal = fs.readFileSync(path.join(f.runDirectory, PROVIDER_SEND_BOUNDARY_JOURNAL_FILE), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(journal.length, 2);
  assert.ok(journal.every((entry) => entry.occurredAtMs === ledger.occurredAtMs));
  assert.equal(buildCellExternalProviderBudget(buildOptions(f.runDirectory)).passed, true);
});

function writePrefilterFixture(runDirectory, samples, amplitude = 0.25) {
  const raw = Buffer.alloc(samples * 3 * 8);
  for (let offset = 0; offset < raw.length; offset += 8) {
    raw.writeFloatLE(amplitude, offset);
    raw.writeFloatLE(amplitude, offset + 4);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(raw.length);
  fs.writeFileSync(
    path.join(runDirectory, PROVIDER_INPUT_PREFILTER_FILE),
    Buffer.concat([PROVIDER_INPUT_PREFILTER_MAGIC, header, raw]),
  );
  const replay = replayProviderInputPrefilter({
    filePath: path.join(runDirectory, PROVIDER_INPUT_PREFILTER_FILE),
    maxSamples: inputCeilingSamplesForMode('process-exclusion'),
  });
  fs.writeFileSync(
    path.join(runDirectory, 'provider-input-16k-mono.pcm'),
    replay.expectedProviderPcm,
  );
  return replay.expectedProviderPcm.length / 2;
}

function createRunDirectory({
  feedbackMode = 'echo-cancel',
  samples = 320,
  prefilterSamples = samples,
  extraLog = '',
  remoteArtifact = null,
} = {}) {
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-paid-budget-'));
  const diagnosticPcmSamples = samples;
  const inputCeilingSamples = inputCeilingSamplesForMode(feedbackMode);
  writePrefilterFixture(runDirectory, prefilterSamples);
  fs.writeFileSync(path.join(runDirectory, 'app.log'), [
    'historical unrelated provider log',
    MARKER,
    `2026-08-13 01:00:00 [NORMAL] [omni] - - [CONNECT] 已连接 Omni 服务, model=${MODEL}`,
    `2026-08-13 01:02:06 [DEBUG] [model-trace] - - omni ws.send.input_audio_buffer.append.summary | {"event":"ws.send.input_audio_buffer.append.summary","model":"${MODEL}","category":"omni","payload":{"resampledSamplesTotal":${samples}}}`,
    extraLog,
  ].join('\n'), 'utf8');
  const identity = {
    schemaVersion: 2,
    artifactKind: 'watch-mode-provider-input-budget-ledger',
    cellId: CELL_ID,
    leaseId: 'fixture-lease',
    runMarker: MARKER,
    sessionGeneration: 1,
    direction: 'inbound',
    strictPaidAuthority: true,
    providerId: 'provider-dashscope',
    templateId: 'template-dashscope-realtime',
    providerKind: 'dashscope',
    endpointHost: 'dashscope.aliyuncs.com',
    credentialReference: 'credential://provider/dashscope/default',
    authHeaderName: 'Authorization',
    authScheme: 'bearer',
    customHeaderCount: 0,
    model: MODEL,
    protocol: 'dashscope-livetranslate',
    modelProtocolProfileIdentity: structuredClone(MODEL_PROTOCOL_PROFILE_IDENTITY),
  };
  fs.writeFileSync(
    path.join(runDirectory, 'provider-input-budget-lease.json'),
    JSON.stringify({
      schemaVersion: 2,
      artifactKind: 'watch-mode-provider-input-budget-lease',
      cellId: CELL_ID,
      leaseId: identity.leaseId,
      runMarker: MARKER,
      maxSamples: inputCeilingSamples,
      modelProtocolProfileIdentity: structuredClone(MODEL_PROTOCOL_PROFILE_IDENTITY),
    }),
    'utf8',
  );
  const initial = {
    ...identity,
    event: 'initialized',
    sequence: 1,
    occurredAtMs: 1,
    attemptedSamples: null,
    totalAttemptedSamples: 0,
    maxSamples: inputCeilingSamples,
    appendAttempts: 0,
    sendFailures: 0,
    initialConnectAttempts: 0,
    reconnects: 0,
    budgetExceeded: false,
    finalized: false,
    terminalReason: null,
  };
  const initialConnect = {
    ...initial,
    event: 'initial_connect_attempt',
    sequence: 2,
    occurredAtMs: 2,
    initialConnectAttempts: 1,
  };
  const reserved = {
    ...initialConnect,
    event: 'reserved',
    sequence: 3,
    occurredAtMs: 3,
    attemptedSamples: samples,
    totalAttemptedSamples: samples,
    appendAttempts: 1,
  };
  const finalized = {
    ...reserved,
    event: 'finalized',
    sequence: 4,
    occurredAtMs: 4,
    attemptedSamples: null,
    finalized: true,
    terminalReason: 'worker-completed',
  };
  fs.writeFileSync(
    path.join(runDirectory, 'provider-input-budget-ledger.json'),
    `${JSON.stringify(finalized)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDirectory, 'provider-input-budget-ledger.json.journal.jsonl'),
    `${[initial, initialConnect, reserved, finalized].map(JSON.stringify).join('\n')}\n`,
    'utf8',
  );
  if (feedbackMode !== 'echo-cancel') {
    const canonical = loadCanonicalFixtureAuthority({ workspaceRoot: path.resolve('.') });
    const referencePcmPath = path.join(runDirectory, 'source-media-reference-16k-mono.pcm');
    fs.writeFileSync(referencePcmPath, canonical.referencePcm.buffer);
    const sourceWindowPath = path.join(runDirectory, 'physical-output-recording-source-window-16k-mono.pcm');
    const lagSamples = 320;
    const window = Buffer.alloc(canonical.referencePcm.bytes + (16_000 + lagSamples) * 2);
    for (let index = 0; index < canonical.referencePcm.samples; index += 1) {
      window.writeInt16LE(
        Math.trunc(canonical.referencePcm.buffer.readInt16LE(index * 2) * 0.72),
        (index + lagSamples) * 2,
      );
    }
    fs.writeFileSync(sourceWindowPath, window);
    const physicalRecordingPcmPath = path.join(
      runDirectory,
      'physical-output-recording-16k-mono.pcm',
    );
    fs.writeFileSync(physicalRecordingPcmPath, window);
    const sourceWaveform = buildPhysicalSourceWaveformAuthority({
      runDirectory,
      workspaceRoot: path.resolve('.'),
    });
    fs.writeFileSync(path.join(runDirectory, 'source-media-transcript.json'), JSON.stringify({
      schemaVersion: 2,
      passed: true,
      authorityMode: 'canonical-fixture-local-v2',
      remoteProviderCalls: 0,
      externalAudioSeconds: 0,
      fullMedia: true,
      playbackSeconds: null,
      mediaPath: 'scripts/testing/fixtures/watch-mode-en-original.wav',
      checksumPath: 'scripts/testing/fixtures/watch-mode-en-original.sha256',
      metadataPath: 'scripts/testing/fixtures/watch-mode-audio-fixtures.json',
      mediaSha256: canonical.media.sha256,
      mediaBytes: canonical.media.bytes,
      source: canonical.sourceText.text,
      translation: canonical.translationText.text,
      sourceText: {
        path: 'scripts/testing/fixtures/watch-mode-en-original.txt',
        bytes: canonical.sourceText.bytes,
        sha256: canonical.sourceText.sha256,
      },
      translationText: {
        path: 'scripts/testing/fixtures/watch-mode-en-original.zh-CN.txt',
        bytes: canonical.translationText.bytes,
        sha256: canonical.translationText.sha256,
      },
      referencePcm: {
        path: 'source-media-reference-16k-mono.pcm',
        sha256: canonical.referencePcm.sha256,
        bytes: canonical.referencePcm.bytes,
        samples: canonical.referencePcm.samples,
        sampleRateHz: 16_000,
        channels: 1,
        durationSeconds: Number(canonical.referencePcm.durationSeconds.toFixed(6)),
      },
      fixture: canonical.fixture,
    }), 'utf8');
    const rawPhysicalContent = {
      passed: true,
      authorityMode: 'local-pcm-cue-playback-v1',
      remoteProviderCalls: 0,
      externalAudioSeconds: 0,
      sttSourceWindow: {
        path: sourceWindowPath,
        sampleRateHz: 16_000,
        bytes: window.length,
      },
      originalPassthrough: {
        authority: 'canonical-source-signed-waveform-v1',
        sourceSimilarity: sourceWaveform,
      },
      contentConsistency: { structuredEvidence: { passed: true } },
      translatedSpeech: {
        playbackAuthority: { passed: true, invalidCues: [] },
        acousticAuthority: { passed: true },
      },
    };
    fs.writeFileSync(
      path.join(runDirectory, 'physical-output-content.raw.json'),
      JSON.stringify(rawPhysicalContent),
      'utf8',
    );
    fs.writeFileSync(
      path.join(runDirectory, 'physical-output-content.json'),
      JSON.stringify(rawPhysicalContent),
      'utf8',
    );
    // Supply the surrounding raw files so this negative fixture reaches the
    // translated-PCM check instead of failing earlier on an unrelated missing
    // recording/report. It deliberately omits the Rust cue PCM authority.
    fs.writeFileSync(path.join(runDirectory, 'physical-output-recording.json'), JSON.stringify({
      recordingStartedAtEpochMs: 1,
      transcriptionPcmPath: physicalRecordingPcmPath,
    }), 'utf8');
    fs.writeFileSync(path.join(runDirectory, 'watch-session-report.json'), JSON.stringify({
      cues: ['cue-1', 'cue-2'].map((cueId) => ({
        cueId,
        comparisonStatus: 'exact',
        llmText: cueId,
        publishedText: cueId,
        renderedText: cueId,
      })),
    }), 'utf8');
  }
  if (remoteArtifact) fs.writeFileSync(path.join(runDirectory, remoteArtifact), 'remote call\n', 'utf8');
  return runDirectory;
}

function buildOptions(runDirectory, overrides = {}) {
  return {
    runDirectory,
    runMarker: MARKER,
    cellId: CELL_ID,
    modelId: MODEL,
    feedbackLoopPrevention: 'echo-cancel',
    translationMode: 'native',
    inputCeilingSamples: inputCeilingSamplesForMode(
      overrides.feedbackLoopPrevention ?? 'echo-cancel',
    ),
    expectedModelProtocolProfileIdentity: MODEL_PROTOCOL_PROFILE_IDENTITY,
    generatedAt: new Date('2026-08-13T01:03:00.000Z'),
    ...overrides,
  };
}

test('actual provider input uses sent-sample trace summaries instead of the 90-second PCM prefix', () => {
  const log = [
    '{"event":"ws.send.input_audio_buffer.append.summary","payload":{"resampledSamplesTotal":1600000}}',
    '{"event":"ws.send.input_audio_buffer.append.summary","payload":{"resampledSamplesTotal":416000}}',
  ].join('\n');
  assert.deepEqual(actualProviderInputSamplesFromLog(log), {
    samples: 2_016_000,
    summaryCount: 2,
  });
});

test('prefilter replay reproduces f32 resampling, RMS gating, and exactly 40 silence-grace chunks', () => {
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-prefilter-replay-'));
  try {
    const chunks = [0, 0.25, ...Array(41).fill(0)].map((amplitude) => {
      const raw = Buffer.alloc(320 * 3 * 8);
      for (let offset = 0; offset < raw.length; offset += 8) {
        raw.writeFloatLE(amplitude, offset);
        raw.writeFloatLE(amplitude, offset + 4);
      }
      const length = Buffer.alloc(4);
      length.writeUInt32LE(raw.length);
      return Buffer.concat([length, raw]);
    });
    const filePath = path.join(runDirectory, PROVIDER_INPUT_PREFILTER_FILE);
    fs.writeFileSync(filePath, Buffer.concat([PROVIDER_INPUT_PREFILTER_MAGIC, ...chunks]));
    const replay = replayProviderInputPrefilter({ filePath, maxSamples: 100_000 });
    assert.equal(replay.authority.rawInput.chunkCount, 43);
    assert.deepEqual(replay.authority.decisions, {
      audibleChunks: 1,
      silenceGraceChunks: 40,
      skippedSilenceChunks: 2,
      emptyResampleChunks: 0,
      budgetRejectedChunks: 0,
      acceptedChunks: 41,
      acceptedSamples: 13_120,
    });
    assert.equal(replay.expectedProviderPcm.readInt16LE(0), 8191);
    assert.equal(replay.expectedProviderPcm.length, 13_120 * 2);
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
});

test('paid budget scopes from the standalone marker, not a later runMarker field', () => {
  const runDirectory = createRunDirectory({
    extraLog: `watch_mode.diagnostic_report_saved | runMarker=${MARKER}`,
  });
  try {
    const budget = buildCellExternalProviderBudget(buildOptions(runDirectory));
    assert.equal(budget.passed, true, budget.violations.join('; '));
    assert.equal(budget.actualProviderInputSamples, 320);
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
});

test('staged physical receipts retain guest absolute roots but bind fixed staged artifact basenames', () => {
  assert.equal(isAbsoluteEvidencePathForFixedFile(
    'E:\\omni-shards\\execution-a\\vm2\\run\\physical-output-recording-16k-mono.pcm',
    'physical-output-recording-16k-mono.pcm',
  ), true);
  assert.equal(isAbsoluteEvidencePathForFixedFile(
    'E:\\omni-shards\\execution-a\\vm2\\run\\physical-output-recording-source-window-16k-mono.pcm',
    'physical-output-recording-source-window-16k-mono.pcm',
  ), true);
  assert.equal(isAbsoluteEvidencePathForFixedFile(
    'physical-output-recording-16k-mono.pcm',
    'physical-output-recording-16k-mono.pcm',
  ), false);
  assert.equal(isAbsoluteEvidencePathForFixedFile(
    'E:\\omni-shards\\execution-a\\vm2\\run\\caller-authored.pcm',
    'physical-output-recording-16k-mono.pcm',
  ), false);
});

test('strict paid cell accepts only the main realtime session and reconstructs its ledger from raw artifacts', () => {
  const runDirectory = createRunDirectory();
  try {
    const { ledger } = writeCellExternalProviderBudget(buildOptions(runDirectory));
    assert.equal(ledger.passed, true);
    assert.equal(ledger.actualProviderInputSamples, 320);
    assert.equal(ledger.actualProviderInputSeconds, 0.02);
    assert.deepEqual(ledger.calls, {
      mainRealtime: 1,
      sourceTranscript: 0,
      physicalOutputStt: 0,
      secondaryTranslation: 0,
      secondaryTts: 0,
    });
    assert.equal(assertCellExternalProviderBudget(runDirectory).passed, true);
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
});

test('strict paid cell rejects either provider PCM or prefilter raw tampering', () => {
  for (const target of ['provider-input-16k-mono.pcm', PROVIDER_INPUT_PREFILTER_FILE]) {
    const runDirectory = createRunDirectory();
    try {
      const filePath = path.join(runDirectory, target);
      const bytes = fs.readFileSync(filePath);
      bytes[bytes.length - 1] ^= 0x40;
      fs.writeFileSync(filePath, bytes);
      const budget = buildCellExternalProviderBudget(buildOptions(runDirectory));
      assert.equal(budget.passed, false, target);
      assert.match(
        budget.violations.join('; '),
        /not byte-for-byte equal|do not match send-boundary total/,
      );
    } finally {
      fs.rmSync(runDirectory, { recursive: true, force: true });
    }
  }
});

test('strict paid cell accepts a proven reconnect rejection without accepting a reconnect', () => {
  const runDirectory = createRunDirectory();
  try {
    const ledgerPath = path.join(runDirectory, 'provider-input-budget-ledger.json');
    const journalPath = path.join(runDirectory, 'provider-input-budget-ledger.json.journal.jsonl');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const journal = fs.readFileSync(journalPath, 'utf8').trim().split(/\r?\n/u).map(JSON.parse);
    ledger.terminalReason = 'reconnect-forbidden-socket-close';
    const finalized = journal.pop();
    const reconnectRejected = {
      ...journal.at(-1),
      event: 'reconnect_rejected',
      sequence: journal.length + 1,
      occurredAtMs: 4,
      attemptedSamples: null,
      terminalReason: ledger.terminalReason,
    };
    finalized.sequence = journal.length + 2;
    finalized.occurredAtMs = 5;
    finalized.terminalReason = ledger.terminalReason;
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`, 'utf8');
    fs.writeFileSync(
      journalPath,
      `${[...journal, reconnectRejected, finalized].map(JSON.stringify).join('\n')}\n`,
      'utf8',
    );

    const budget = buildCellExternalProviderBudget(buildOptions(runDirectory));
    assert.equal(budget.passed, true);
    assert.equal(budget.providerSendBoundary.journal.eventCounts.reconnect_rejected, 1);
    assert.equal(budget.providerSendBoundary.reconnects, 0);
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
});

test('strict paid budget accepts a lease-bound zero-input terminal for collect-all reporting', () => {
  const runDirectory = createRunDirectory({ feedbackMode: 'echo-cancel' });
  try {
    const ledgerPath = path.join(runDirectory, 'provider-input-budget-ledger.json');
    const journalPath = path.join(runDirectory, 'provider-input-budget-ledger.json.journal.jsonl');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const journal = fs.readFileSync(journalPath, 'utf8').trim().split(/\r?\n/u).map(JSON.parse);
    ledger.totalAttemptedSamples = 0;
    ledger.appendAttempts = 0;
    ledger.terminalReason = 'livetranslate-session-finished-timeout';
    const terminal = {
      ...journal.at(-1),
      sequence: 3,
      totalAttemptedSamples: 0,
      appendAttempts: 0,
      terminalReason: ledger.terminalReason,
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger), 'utf8');
    fs.writeFileSync(
      journalPath,
      `${[journal[0], journal[1], terminal].map(JSON.stringify).join('\n')}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(runDirectory, 'provider-input-16k-mono.pcm'), Buffer.alloc(0));
    fs.writeFileSync(
      path.join(runDirectory, PROVIDER_INPUT_PREFILTER_FILE),
      PROVIDER_INPUT_PREFILTER_MAGIC,
    );
    const appLogPath = path.join(runDirectory, 'app.log');
    const appLog = fs.readFileSync(appLogPath, 'utf8')
      .split(/\r?\n/u)
      .filter((line) => !line.includes('input_audio_buffer.append.summary'))
      .join('\n');
    fs.writeFileSync(appLogPath, appLog, 'utf8');

    const budget = buildCellExternalProviderBudget(buildOptions(runDirectory, {
      feedbackLoopPrevention: 'echo-cancel',
    }));
    assert.equal(budget.passed, true);
    assert.equal(budget.actualProviderInputSamples, 0);
    assert.equal(budget.calls.mainRealtime, 1);
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
});

test('strict paid budget records an authentic zero-call terminal before Provider startup', () => {
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-pre-provider-budget-'));
  try {
    fs.writeFileSync(path.join(runDirectory, 'app.log'), `${MARKER}\n`, 'utf8');
    writePreProviderTerminalAuthority({
      runDirectory,
      runMarker: MARKER,
      cellId: CELL_ID,
      leaseId: 'coordinator-lease',
      modelId: MODEL,
      inputCeilingSamples: inputCeilingSamplesForMode('echo-cancel'),
      occurredAtMs: 7,
    });
    const budget = buildCellExternalProviderBudget(buildOptions(runDirectory));
    assert.equal(budget.passed, true, budget.violations.join('; '));
    assert.equal(budget.actualProviderInputSamples, 0);
    assert.equal(budget.calls.mainRealtime, 0);
    assert.equal(budget.providerSendBoundary.sessionGeneration, 0);
    assert.equal(budget.providerSendBoundary.initialConnectAttempts, 0);
    assert.equal(budget.providerSendBoundary.terminalReason, 'runner-failed-before-provider-session');
    assert.deepEqual(budget.providerSendBoundary.journal.eventCounts, { initialized: 1, finalized: 1 });
    assert.throws(() => writePreProviderTerminalAuthority({
      runDirectory,
      runMarker: MARKER,
      cellId: CELL_ID,
      leaseId: 'coordinator-lease',
      modelId: MODEL,
    }), /refusing to replace/);
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
});

test('strict paid cell rejects remote STT artifacts, secondary calls, reconnects, and input overrun', () => {
  const cases = [
    {
      options: { remoteArtifact: 'physical-output-stt.stdout.log' },
      expected: /remote auxiliary diagnostic artifacts are forbidden/,
    },
    {
      options: { extraLog: '[LLM_CALL] cue_id=x\nspeech.segment_tts_requested | cue=x' },
      expected: /secondary translation calls|secondary TTS calls/,
    },
    {
      options: { extraLog: 'watch_mode.omni_reconnect | attempt=1' },
      expected: /log reconnect count.*send-boundary authority/,
    },
    {
      options: { samples: 16_000 * 181, prefilterSamples: 320 },
      expected: /exceeded maxSamples|do not match send-boundary total/,
    },
  ];
  for (const { options, expected } of cases) {
    const runDirectory = createRunDirectory(options);
    try {
      const ledger = buildCellExternalProviderBudget(buildOptions(runDirectory));
      assert.equal(ledger.passed, false);
      assert.match(ledger.violations.join('; '), expected);
    } finally {
      fs.rmSync(runDirectory, { recursive: true, force: true });
    }
  }
});

test('strict paid cell rejects a send-boundary ledger for the wrong realtime protocol', () => {
  const runDirectory = createRunDirectory();
  try {
    const ledgerPath = path.join(runDirectory, 'provider-input-budget-ledger.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    ledger.protocol = 'dashscope-omni';
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger), 'utf8');
    const budget = buildCellExternalProviderBudget(buildOptions(runDirectory));
    assert.equal(budget.passed, false);
    assert.match(budget.violations.join('; '), /protocol mismatch/);
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
});

test('strict paid cell rejects forged provider identity and any missing or repeated initial connect event', () => {
  const mutations = [
    {
      mutate({ ledger }) { ledger.providerId = 'provider-attacker'; },
      expected: /providerId mismatch/,
    },
    {
      mutate({ ledger }) { ledger.authHeaderName = 'X-Api-Key'; },
      expected: /authHeaderName mismatch/,
    },
    {
      mutate({ journal }) { journal[2].authScheme = 'basic'; },
      expected: /authScheme mismatch/,
    },
    {
      mutate({ ledger }) { ledger.customHeaderCount = 1; },
      expected: /customHeaderCount mismatch/,
    },
    {
      mutate({ journal }) { journal.splice(1, 1); journal.forEach((entry, index) => { entry.sequence = index + 1; }); },
      expected: /exactly one initial_connect_attempt|non-monotonic/,
    },
    {
      mutate({ journal }) {
        journal.splice(2, 0, { ...journal[1], sequence: 3, occurredAtMs: 2 });
        journal.forEach((entry, index) => { entry.sequence = index + 1; });
      },
      expected: /exactly one initial_connect_attempt|immediately follow initialized/,
    },
  ];
  for (const { mutate, expected } of mutations) {
    const runDirectory = createRunDirectory();
    try {
      const ledgerPath = path.join(runDirectory, 'provider-input-budget-ledger.json');
      const journalPath = path.join(runDirectory, 'provider-input-budget-ledger.json.journal.jsonl');
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      const journal = fs.readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
      mutate({ ledger, journal });
      fs.writeFileSync(ledgerPath, JSON.stringify(ledger), 'utf8');
      fs.writeFileSync(journalPath, `${journal.map(JSON.stringify).join('\n')}\n`, 'utf8');
      const budget = buildCellExternalProviderBudget(buildOptions(runDirectory));
      assert.equal(budget.passed, false);
      assert.match(budget.violations.join('; '), expected);
    } finally {
      fs.rmSync(runDirectory, { recursive: true, force: true });
    }
  }
});

test('strict paid budget leaves canonical and physical verdicts to report and verifier', () => {
  const runDirectory = createRunDirectory({ feedbackMode: 'process-exclusion' });
  try {
    const sourcePath = path.join(runDirectory, 'source-media-transcript.json');
    const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    source.mediaSha256 = '0'.repeat(64);
    fs.writeFileSync(sourcePath, JSON.stringify(source), 'utf8');
    let budget = buildCellExternalProviderBudget(buildOptions(runDirectory, { feedbackLoopPrevention: 'process-exclusion' }));
    assert.equal(budget.passed, true);

    source.mediaSha256 = fileSha256(path.resolve('scripts/testing/fixtures/watch-mode-en-original.wav'));
    source.source = `${source.source} forged`;
    fs.writeFileSync(sourcePath, JSON.stringify(source), 'utf8');
    budget = buildCellExternalProviderBudget(buildOptions(runDirectory, { feedbackLoopPrevention: 'process-exclusion' }));
    assert.equal(budget.passed, true);

    const canonical = loadCanonicalFixtureAuthority({ workspaceRoot: path.resolve('.') });
    source.source = canonical.sourceText.text;
    fs.writeFileSync(sourcePath, JSON.stringify(source), 'utf8');
    const referencePath = path.join(runDirectory, 'source-media-reference-16k-mono.pcm');
    const forgedReference = fs.readFileSync(referencePath);
    forgedReference.writeInt16LE(forgedReference.readInt16LE(0) ^ 1, 0);
    fs.writeFileSync(referencePath, forgedReference);
    budget = buildCellExternalProviderBudget(buildOptions(runDirectory, { feedbackLoopPrevention: 'process-exclusion' }));
    assert.equal(budget.passed, true);

    fs.writeFileSync(referencePath, canonical.referencePcm.buffer);
    const physicalPath = path.join(runDirectory, 'physical-output-content.raw.json');
    const physical = JSON.parse(fs.readFileSync(physicalPath, 'utf8'));
    physical.translatedSpeech.acousticAuthority.passed = false;
    fs.writeFileSync(physicalPath, JSON.stringify(physical), 'utf8');
    budget = buildCellExternalProviderBudget(buildOptions(runDirectory, { feedbackLoopPrevention: 'process-exclusion' }));
    assert.equal(budget.passed, true);
    assert.equal(budget.physicalAuthority.translatedPcmLoopbackPassed, false);

    // A fail-closed local recorder artifact may not have reached the stage
    // that records an external-audio duration. Absence is not evidence of a
    // paid call; the report/verifier owns the local content failure.
    physical.passed = false;
    delete physical.externalAudioSeconds;
    fs.writeFileSync(physicalPath, JSON.stringify(physical), 'utf8');
    budget = buildCellExternalProviderBudget(buildOptions(runDirectory, { feedbackLoopPrevention: 'process-exclusion' }));
    assert.equal(budget.passed, true);

    physical.remoteProviderCalls = 1;
    fs.writeFileSync(physicalPath, JSON.stringify(physical), 'utf8');
    budget = buildCellExternalProviderBudget(buildOptions(runDirectory, { feedbackLoopPrevention: 'process-exclusion' }));
    assert.equal(budget.passed, false);
    assert.match(budget.violations.join('; '), /declares external Provider usage/);
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
});

test('strict paid budget leaves forged acoustic windows to report and verifier', () => {
  for (const mode of ['forged-prefix', 'unbound-receipt']) {
    const runDirectory = createRunDirectory({ feedbackMode: 'process-exclusion' });
    try {
      if (mode === 'forged-prefix') {
        const sourceWindowPath = path.join(
          runDirectory,
          'physical-output-recording-source-window-16k-mono.pcm',
        );
        const bytes = fs.readFileSync(sourceWindowPath);
        bytes[bytes.length - 1] ^= 0x5a;
        fs.writeFileSync(sourceWindowPath, bytes);
      } else {
        const physicalPath = path.join(runDirectory, 'physical-output-content.raw.json');
        const physical = JSON.parse(fs.readFileSync(physicalPath, 'utf8'));
        physical.sttSourceWindow.path = path.join(runDirectory, 'caller-authored-window.pcm');
        fs.writeFileSync(physicalPath, JSON.stringify(physical), 'utf8');
      }
      const budget = buildCellExternalProviderBudget(buildOptions(runDirectory, {
        feedbackLoopPrevention: 'process-exclusion',
      }));
      assert.equal(budget.passed, true, mode);
    } finally {
      fs.rmSync(runDirectory, { recursive: true, force: true });
    }
  }
});

test('strict paid reservation fails before any sample allocation beyond the four-cell matrix', () => {
  let reservedSamples = 0;
  for (const cell of LIVE_LLM_CELLS) {
    reservedSamples = reserveStrictPaidCellInputSamples({
      reservedSamples,
      nextCellSamples: cell.maxExternalAudioSamples,
    });
  }
  assert.equal(reservedSamples, STRICT_PAID_MATRIX_MAX_INPUT_SAMPLES);
  assert.throws(
    () => reserveStrictPaidCellInputSamples({ reservedSamples, nextCellSamples: 1 }),
    /would reserve .* input samples/,
  );
});

test('matrix ledger binds four cells, actual samples, and zero auxiliary calls', () => {
  const cells = LIVE_LLM_CELLS.map((plannedCell, index) => ({
    passed: true,
    cellId: plannedCell.cellId,
    modelId: plannedCell.modelId,
    modelProtocolProfileIdentity: structuredClone(plannedCell.modelProtocolProfileIdentity),
    feedbackLoopPrevention: plannedCell.feedbackLoopPrevention,
    providerInputSampleCeiling: plannedCell.maxExternalAudioSamples,
    actualProviderInputSamples: 16_000 * 126,
    actualProviderInputSeconds: 126,
    auxiliaryExternalAudioSeconds: 0,
    providerSendBoundary: { leaseId: `lease-${index}` },
    calls: {
      sourceTranscript: 0,
      physicalOutputStt: 0,
      secondaryTranslation: 0,
      secondaryTts: 0,
    },
  }));
  const ledger = buildMatrixExternalProviderBudget(cells, {
    generatedAt: new Date('2026-08-13T02:00:00.000Z'),
  });
  assert.equal(ledger.passed, true);
  assert.equal(ledger.reservedInputSamples, 10_100_180);
  assert.equal(ledger.actualProviderInputSeconds, 504);
  const matrixDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-paid-matrix-budget-'));
  try {
    const matrixPath = path.join(matrixDirectory, 'external-provider-budget-matrix.json');
    fs.writeFileSync(matrixPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    assert.equal(assertMatrixExternalProviderBudget(matrixPath, cells).passed, true);
    const forged = { ...ledger, actualProviderInputSamples: ledger.actualProviderInputSamples - 1 };
    fs.writeFileSync(matrixPath, `${JSON.stringify(forged, null, 2)}\n`, 'utf8');
    assert.throws(() => assertMatrixExternalProviderBudget(matrixPath, cells), /does not match rebuilt/);
  } finally {
    fs.rmSync(matrixDirectory, { recursive: true, force: true });
  }

  const forbidden = structuredClone(cells);
  forbidden[0].calls.physicalOutputStt = 1;
  const rejected = buildMatrixExternalProviderBudget(forbidden);
  assert.equal(rejected.passed, false);
  assert.match(rejected.violations.join('; '), /forbidden physicalOutputStt calls/);

  const duplicated = structuredClone(cells);
  duplicated[1].cellId = duplicated[0].cellId;
  const duplicateRejected = buildMatrixExternalProviderBudget(duplicated);
  assert.equal(duplicateRejected.passed, false);
  assert.match(duplicateRejected.violations.join('; '), /cell ids\/order|duplicate cellId/);

  const duplicateLease = structuredClone(cells);
  duplicateLease[1].providerSendBoundary.leaseId = duplicateLease[0].providerSendBoundary.leaseId;
  const duplicateLeaseRejected = buildMatrixExternalProviderBudget(duplicateLease);
  assert.equal(duplicateLeaseRejected.passed, false);
  assert.match(duplicateLeaseRejected.violations.join('; '), /duplicate provider leaseId/);
});
