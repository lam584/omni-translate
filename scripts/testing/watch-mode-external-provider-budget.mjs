import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { LIVE_LLM_CELLS, RELEASE_MODELS } from './watch-mode-balanced-release-plan.mjs';
import {
  assertWatchModelProtocolIdentity,
  deriveWatchModelProtocolIdentity,
} from './watch-mode-model-protocol-authority.mjs';

export const EXTERNAL_PROVIDER_BUDGET_SCHEMA_VERSION = 2;
export const CELL_EXTERNAL_PROVIDER_BUDGET_KIND = 'watch-mode-paid-cell-external-provider-budget';
export const MATRIX_EXTERNAL_PROVIDER_BUDGET_KIND = 'watch-mode-paid-matrix-external-provider-budget';
export const CELL_EXTERNAL_PROVIDER_BUDGET_FILE = 'external-provider-budget.json';
export const MATRIX_EXTERNAL_PROVIDER_BUDGET_FILE = 'external-provider-budget-matrix.json';
export const PROVIDER_SEND_BOUNDARY_LEDGER_FILE = 'provider-input-budget-ledger.json';
export const PROVIDER_SEND_BOUNDARY_JOURNAL_FILE = `${PROVIDER_SEND_BOUNDARY_LEDGER_FILE}.journal.jsonl`;
export const PROVIDER_BUDGET_LEASE_FILE = 'provider-input-budget-lease.json';
export const PROVIDER_INPUT_PREFILTER_FILE = 'provider-input-prefilter-48k-stereo.f32le.frames';
export const PROVIDER_INPUT_PREFILTER_MAGIC = Buffer.from('OMNIPR01', 'ascii');
export const PHYSICAL_OUTPUT_RECORDING_PCM_FILE = 'physical-output-recording-16k-mono.pcm';
export const PHYSICAL_OUTPUT_SOURCE_WINDOW_PCM_FILE =
  'physical-output-recording-source-window-16k-mono.pcm';
export const EXTERNAL_PROVIDER_INPUT_SAMPLE_RATE_HZ = 16_000;
export const EXTERNAL_PROVIDER_INPUT_BYTES_PER_SAMPLE = 2;
export const STRICT_PAID_CELL_MAX_INPUT_SAMPLES = 2_877_045;
export const STRICT_PAID_MATRIX_MAX_INPUT_SAMPLES = 10_100_180;
export const STRICT_PAID_MODEL_PROTOCOLS = Object.freeze({
  'qwen3.5-livetranslate-flash-realtime': 'dashscope-livetranslate',
});
export const INCIDENT_REPLAY_PLUS_MODEL = 'qwen3.5-omni-plus-realtime';
export const INCIDENT_REPLAY_PLUS_ID = 'watch-mode-loss-incident-plus-v1';
export const INCIDENT_REPLAY_PLUS_MODEL_PROTOCOLS = Object.freeze({
  [INCIDENT_REPLAY_PLUS_MODEL]: 'dashscope-omni',
});
export const STRICT_PAID_PROVIDER_IDENTITY = Object.freeze({
  strictPaidAuthority: true,
  providerId: 'provider-dashscope',
  templateId: 'template-dashscope-realtime',
  providerKind: 'dashscope',
  endpointHost: 'dashscope.aliyuncs.com',
  credentialReference: 'credential://provider/dashscope/default',
  authHeaderName: 'Authorization',
  authScheme: 'bearer',
  customHeaderCount: 0,
});
export const INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY = Object.freeze({
  ...STRICT_PAID_PROVIDER_IDENTITY,
  strictPaidAuthority: false,
  incidentReplayAuthority: true,
  incidentId: INCIDENT_REPLAY_PLUS_ID,
});

export const PRE_PROVIDER_TERMINAL_REASON = 'runner-failed-before-provider-session';

export const FORBIDDEN_REMOTE_AUXILIARY_ARTIFACTS = Object.freeze([
  'source-media-stt.stdout.log',
  'source-media-stt.stderr.log',
  'physical-output-stt.stdout.log',
  'physical-output-stt.stderr.log',
]);

const sha256Buffer = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = (filePath) => sha256Buffer(fs.readFileSync(filePath));
const roundedSeconds = (samples) => Number((samples / EXTERNAL_PROVIDER_INPUT_SAMPLE_RATE_HZ).toFixed(6));
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

function rustF32(value) {
  return Math.fround(value);
}

function rustF32ToI16(value) {
  if (Number.isNaN(value)) return 0;
  if (value >= 32_767) return 32_767;
  if (value <= -32_768) return -32_768;
  return Math.trunc(value);
}

function resample48kStereoF32leChunkTo16kMonoI16(rawChunk) {
  const frameCount = Math.floor(rawChunk.length / 8);
  const outputSamples = Math.floor(frameCount / 3);
  const output = Buffer.allocUnsafe(outputSamples * 2);
  for (let outputIndex = 0; outputIndex < outputSamples; outputIndex += 1) {
    let sum = rustF32(0);
    for (let offset = 0; offset < 3; offset += 1) {
      const frameOffset = (outputIndex * 3 + offset) * 8;
      const left = rawChunk.readFloatLE(frameOffset);
      const right = rawChunk.readFloatLE(frameOffset + 4);
      const mono = rustF32(rustF32(left + right) * rustF32(0.5));
      sum = rustF32(sum + mono);
    }
    const averaged = rustF32(sum / rustF32(3));
    const clamped = Math.min(1, Math.max(-1, averaged));
    const sample = rustF32ToI16(rustF32(clamped * rustF32(32_767)));
    output.writeInt16LE(sample, outputIndex * 2);
  }
  return output;
}

function pcm16ChunkRmsLikeRust(pcm) {
  const samples = pcm.length / 2;
  if (samples === 0) return rustF32(0);
  let sumSquares = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const normalized = pcm.readInt16LE(offset) / 32_768;
    sumSquares += normalized * normalized;
  }
  return rustF32(Math.sqrt(sumSquares / samples));
}

export function readProviderInputPrefilterFrames(filePath) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < PROVIDER_INPUT_PREFILTER_MAGIC.length) {
    throw new Error(`provider prefilter authority must be a regular framed file: ${filePath}`);
  }
  const bytes = fs.readFileSync(filePath);
  if (!bytes.subarray(0, PROVIDER_INPUT_PREFILTER_MAGIC.length).equals(PROVIDER_INPUT_PREFILTER_MAGIC)) {
    throw new Error(`provider prefilter authority has an invalid magic/version: ${filePath}`);
  }
  const frames = [];
  let offset = PROVIDER_INPUT_PREFILTER_MAGIC.length;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) {
      throw new Error(`provider prefilter authority has a truncated frame header at byte ${offset}`);
    }
    const byteLength = bytes.readUInt32LE(offset);
    offset += 4;
    if (offset + byteLength > bytes.length) {
      throw new Error(`provider prefilter authority frame ${frames.length + 1} exceeds the file boundary`);
    }
    frames.push(bytes.subarray(offset, offset + byteLength));
    offset += byteLength;
  }
  return { bytes, frames };
}

export function replayProviderInputPrefilter({ filePath, maxSamples }) {
  const ceiling = Number(maxSamples);
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) {
    throw new Error('provider prefilter replay requires a positive safe-integer sample ceiling');
  }
  const { bytes, frames } = readProviderInputPrefilterFrames(filePath);
  const accepted = [];
  let totalAttemptedSamples = 0;
  let audibleChunks = 0;
  let silenceGraceChunks = 0;
  let skippedSilenceChunks = 0;
  let emptyResampleChunks = 0;
  let budgetRejectedChunks = 0;
  let hasSentAudibleAudio = false;
  let silenceGraceChunksSent = 0;
  for (const rawChunk of frames) {
    const pcm = resample48kStereoF32leChunkTo16kMonoI16(rawChunk);
    if (pcm.length === 0) {
      emptyResampleChunks += 1;
      continue;
    }
    const rms = pcm16ChunkRmsLikeRust(pcm);
    if (rms < 0.002) {
      if (hasSentAudibleAudio && silenceGraceChunksSent < 40) {
        silenceGraceChunksSent += 1;
        silenceGraceChunks += 1;
      } else {
        skippedSilenceChunks += 1;
        continue;
      }
    } else {
      hasSentAudibleAudio = true;
      silenceGraceChunksSent = 0;
      audibleChunks += 1;
    }
    const samples = pcm.length / 2;
    if (totalAttemptedSamples + samples > ceiling) {
      budgetRejectedChunks += 1;
      continue;
    }
    totalAttemptedSamples += samples;
    accepted.push(pcm);
  }
  const expectedProviderPcm = Buffer.concat(accepted);
  return {
    expectedProviderPcm,
    authority: {
      schemaVersion: 1,
      artifactKind: 'watch-mode-provider-input-prefilter-replay',
      rawInput: {
        path: PROVIDER_INPUT_PREFILTER_FILE,
        bytes: bytes.length,
        sha256: sha256Buffer(bytes),
        chunkCount: frames.length,
      },
      policy: {
        sourceFormat: 'f32le-48000-stereo',
        providerFormat: 'pcm-s16le-16000-mono',
        resample: 'three-frame-f32-average-v1',
        minimumChunkRms: 0.002,
        silenceGraceChunks: 40,
        maxSamples: ceiling,
      },
      decisions: {
        audibleChunks,
        silenceGraceChunks,
        skippedSilenceChunks,
        emptyResampleChunks,
        budgetRejectedChunks,
        acceptedChunks: accepted.length,
        acceptedSamples: totalAttemptedSamples,
      },
      expectedProviderPcm: {
        bytes: expectedProviderPcm.length,
        samples: expectedProviderPcm.length / 2,
        sha256: sha256Buffer(expectedProviderPcm),
      },
    },
  };
}

// Raw guest receipts retain their original VM absolute paths after the guest
// shard tree is byte-for-byte staged under the coordinator execution root.
// Bind the immutable receipt to the fixed artifact role, then always read and
// hash the corresponding file from the current staged run directory.
export function isAbsoluteEvidencePathForFixedFile(value, expectedBasename) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false;
  const windowsDriveAbsolute = /^[A-Za-z]:[\\/]/.test(value);
  const windowsUncAbsolute = /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value);
  const posixAbsolute = value.startsWith('/') && !value.startsWith('//');
  if (!windowsDriveAbsolute && !windowsUncAbsolute && !posixAbsolute) return false;
  return value.split(/[\\/]/).at(-1) === expectedBasename;
}

function readJson(filePath, label) {
  let value;
  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
      throw new Error('must be a non-empty regular non-symlink file');
    }
    value = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${filePath} (${error.message})`);
  }
  return value;
}

function readJsonLines(filePath, label) {
  let lines;
  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
      throw new Error('must be a non-empty regular non-symlink file');
    }
    lines = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  } catch (error) {
    throw new Error(`${label} is not readable: ${filePath} (${error.message})`);
  }
  if (lines.length === 0) throw new Error(`${label} is empty: ${filePath}`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is not JSON: ${error.message}`);
    }
  });
}

function validateSendBoundaryAuthority({
  runDirectory,
  cellId,
  runMarker,
  modelId,
  maxSamples,
  modelProtocols = STRICT_PAID_MODEL_PROTOCOLS,
  providerIdentity = STRICT_PAID_PROVIDER_IDENTITY,
  modelProtocolProfileIdentity = null,
}) {
  const ledgerPath = path.join(runDirectory, PROVIDER_SEND_BOUNDARY_LEDGER_FILE);
  const journalPath = path.join(runDirectory, PROVIDER_SEND_BOUNDARY_JOURNAL_FILE);
  const leasePath = path.join(runDirectory, PROVIDER_BUDGET_LEASE_FILE);
  const ledger = readJson(ledgerPath, 'provider send-boundary final ledger');
  const journal = readJsonLines(journalPath, 'provider send-boundary journal');
  const lease = readJson(leasePath, 'provider budget lease receipt');
  const violations = [];
  const expectedIdentity = {
    schemaVersion: EXTERNAL_PROVIDER_BUDGET_SCHEMA_VERSION,
    artifactKind: 'watch-mode-provider-input-budget-ledger',
    cellId,
    runMarker,
    direction: 'inbound',
    model: modelId,
    protocol: modelProtocols[modelId],
    ...(modelProtocolProfileIdentity ? { modelProtocolProfileIdentity } : {}),
    ...providerIdentity,
  };
  for (const [key, expected] of Object.entries(expectedIdentity)) {
    if (key === 'modelProtocolProfileIdentity') {
      try {
        assertWatchModelProtocolIdentity(
          ledger?.[key],
          expected,
          'send-boundary final ledger model protocol profile identity',
        );
      } catch (error) {
        violations.push(error.message);
      }
    } else if (ledger?.[key] !== expected) violations.push(`send-boundary final ledger ${key} mismatch`);
  }
  const expectedLeaseIdentity = {
    schemaVersion: EXTERNAL_PROVIDER_BUDGET_SCHEMA_VERSION,
    artifactKind: 'watch-mode-provider-input-budget-lease',
    cellId,
    runMarker,
    maxSamples,
    ...(modelProtocolProfileIdentity ? { modelProtocolProfileIdentity } : {}),
  };
  const preProviderTerminal = ledger.terminalReason === PRE_PROVIDER_TERMINAL_REASON;
  for (const [key, expected] of Object.entries(expectedLeaseIdentity)) {
    if (key === 'modelProtocolProfileIdentity') {
      try {
        assertWatchModelProtocolIdentity(
          lease?.[key],
          expected,
          'provider budget lease model protocol profile identity',
        );
      } catch (error) {
        violations.push(error.message);
      }
    } else if (lease?.[key] !== expected) violations.push(`provider budget lease ${key} mismatch`);
  }
  if (typeof ledger.leaseId !== 'string' || !ledger.leaseId.trim()) {
    violations.push('send-boundary final ledger leaseId is missing');
  }
  if (!Number.isInteger(Number(ledger.sessionGeneration)) || Number(ledger.sessionGeneration) < (preProviderTerminal ? 0 : 1)) {
    violations.push('send-boundary final ledger sessionGeneration is invalid');
  }
  if (lease.leaseId !== ledger.leaseId) violations.push('provider budget leaseId does not match send-boundary ledger');
  if (Number(ledger.maxSamples) !== maxSamples) violations.push('send-boundary final ledger maxSamples mismatch');
  if (!Number.isInteger(Number(ledger.totalAttemptedSamples)) || Number(ledger.totalAttemptedSamples) < 0) {
    violations.push('send-boundary final ledger has an invalid attempted input sample count');
  }
  if (Number(ledger.totalAttemptedSamples) > maxSamples) violations.push('send-boundary final ledger exceeded maxSamples');
  if (!Number.isInteger(Number(ledger.appendAttempts)) || Number(ledger.appendAttempts) < 0) {
    violations.push('send-boundary final ledger has an invalid append attempt count');
  }
  if (Number(ledger.sendFailures) !== 0) violations.push('send-boundary final ledger recorded send failures');
  const expectedInitialConnectAttempts = preProviderTerminal ? 0 : 1;
  if (preProviderTerminal && (
    Number(ledger.sessionGeneration) !== 0
    || Number(ledger.totalAttemptedSamples) !== 0
    || Number(ledger.appendAttempts) !== 0
  )) violations.push('pre-provider terminal must bind generation, samples, and append attempts to zero');
  if (Number(ledger.initialConnectAttempts) !== expectedInitialConnectAttempts) {
    violations.push(`send-boundary final ledger must record exactly ${expectedInitialConnectAttempts} initial connect attempt(s)`);
  }
  if (Number(ledger.reconnects) !== 0) violations.push('send-boundary final ledger recorded reconnects');
  if (ledger.budgetExceeded !== false) violations.push('send-boundary final ledger reports a budget overrun');
  if (ledger.finalized !== true) violations.push('send-boundary final ledger was not finalized');
  const reconnectRejectedTerminal = /^reconnect-forbidden-(?:socket-close|read-error|voice-fallback)$/u
    .test(String(ledger.terminalReason ?? ''));
  const nonBudgetFailureTerminal = reconnectRejectedTerminal
    || preProviderTerminal
    || ledger.terminalReason === 'livetranslate-session-finished-timeout';
  if (ledger.terminalReason !== 'worker-completed' && !nonBudgetFailureTerminal) {
    violations.push(`send-boundary final ledger terminalReason is not an accepted no-reconnect terminal; got ${ledger.terminalReason ?? 'missing'}`);
  }

  let reservedSamples = 0;
  let reservedEvents = 0;
  let previousOccurredAtMs = -1;
  const eventCounts = {};
  const allowedEvents = new Set([
    'initialized',
    'initial_connect_attempt',
    'reserved',
    'reserve_rejected',
    'send_failed',
    'reconnect_rejected',
    'reconnect',
    'finalized',
  ]);
  let observedInitialConnectAttempts = 0;
  for (let index = 0; index < journal.length; index += 1) {
    const entry = journal[index];
    if (Number(entry.sequence) !== index + 1) violations.push(`send-boundary journal sequence mismatch at ${index + 1}`);
    for (const [key, expected] of Object.entries(expectedIdentity)) {
      if (key === 'modelProtocolProfileIdentity') {
        try {
          assertWatchModelProtocolIdentity(
            entry?.[key],
            expected,
            `send-boundary journal sequence ${index + 1} model protocol profile identity`,
          );
        } catch (error) {
          violations.push(error.message);
        }
      } else if (entry?.[key] !== expected) violations.push(`send-boundary journal ${key} mismatch at sequence ${index + 1}`);
    }
    if (entry.leaseId !== ledger.leaseId || entry.sessionGeneration !== ledger.sessionGeneration) {
      violations.push(`send-boundary journal lease/session mismatch at sequence ${index + 1}`);
    }
    if (!allowedEvents.has(entry.event)) violations.push(`send-boundary journal has unknown event ${entry.event ?? '(missing)'}`);
    if (Number(entry.maxSamples) !== maxSamples) violations.push(`send-boundary journal maxSamples mismatch at sequence ${index + 1}`);
    const occurredAtMs = Number(entry.occurredAtMs);
    if (!Number.isFinite(occurredAtMs) || occurredAtMs < previousOccurredAtMs) {
      violations.push(`send-boundary journal occurredAtMs is invalid or non-monotonic at sequence ${index + 1}`);
    }
    previousOccurredAtMs = occurredAtMs;
    eventCounts[entry.event] = (eventCounts[entry.event] ?? 0) + 1;
    const initialConnectAttempts = Number(entry.initialConnectAttempts);
    if (!Number.isSafeInteger(initialConnectAttempts) || initialConnectAttempts < 0 || initialConnectAttempts > 1) {
      violations.push(`send-boundary journal initialConnectAttempts is invalid at sequence ${index + 1}`);
    }
    if (entry.event === 'initial_connect_attempt') {
      observedInitialConnectAttempts += 1;
      if (index !== 1 || initialConnectAttempts !== 1) {
        violations.push('send-boundary initial_connect_attempt must immediately follow initialized and set the count to one');
      }
    } else if (initialConnectAttempts !== observedInitialConnectAttempts) {
      violations.push(`send-boundary journal initialConnectAttempts is non-monotonic at sequence ${index + 1}`);
    }
    if (entry.event === 'reserved') {
      const attemptedSamples = Number(entry.attemptedSamples ?? 0);
      if (!Number.isInteger(attemptedSamples) || attemptedSamples <= 0) {
        violations.push(`send-boundary reserved event has invalid attemptedSamples at sequence ${index + 1}`);
      }
      reservedSamples += attemptedSamples;
      reservedEvents += 1;
    }
  }
  if (journal[0]?.event !== 'initialized') violations.push('send-boundary journal must start with initialized');
  if (journal.at(-1)?.event !== 'finalized' || journal.at(-1)?.finalized !== true) {
    violations.push('send-boundary journal must end with finalized');
  }
  if (Number(eventCounts.initialized ?? 0) !== 1) violations.push('send-boundary journal must contain exactly one initialized event');
  if (Number(eventCounts.initial_connect_attempt ?? 0) !== expectedInitialConnectAttempts) {
    violations.push(`send-boundary journal must contain exactly ${expectedInitialConnectAttempts} initial_connect_attempt event(s)`);
  }
  if (Number(eventCounts.finalized ?? 0) !== 1) violations.push('send-boundary journal must contain exactly one finalized event');
  if (Number(eventCounts.reconnect_rejected ?? 0) !== (reconnectRejectedTerminal ? 1 : 0)) {
    violations.push('send-boundary journal reconnect rejection does not match the final terminal reason');
  }
  for (const forbiddenEvent of ['reserve_rejected', 'send_failed', 'reconnect']) {
    if (Number(eventCounts[forbiddenEvent] ?? 0) !== 0) violations.push(`send-boundary journal contains ${forbiddenEvent}`);
  }
  if (reservedEvents !== Number(ledger.appendAttempts)) violations.push('send-boundary reserved event count does not match appendAttempts');
  if (reservedSamples !== Number(ledger.totalAttemptedSamples)) violations.push('send-boundary reserved samples do not match final totalAttemptedSamples');

  return {
    passed: violations.length === 0,
    ledger: {
      path: PROVIDER_SEND_BOUNDARY_LEDGER_FILE,
      bytes: fs.statSync(ledgerPath).size,
      sha256: sha256File(ledgerPath),
    },
    journal: {
      path: PROVIDER_SEND_BOUNDARY_JOURNAL_FILE,
      bytes: fs.statSync(journalPath).size,
      sha256: sha256File(journalPath),
      eventCount: journal.length,
      eventCounts,
    },
    lease: {
      path: PROVIDER_BUDGET_LEASE_FILE,
      bytes: fs.statSync(leasePath).size,
      sha256: sha256File(leasePath),
    },
    leaseId: ledger.leaseId ?? null,
    sessionGeneration: ledger.sessionGeneration ?? null,
    protocol: ledger.protocol ?? null,
    modelProtocolProfileIdentity: ledger.modelProtocolProfileIdentity ?? null,
    strictPaidAuthority: ledger.strictPaidAuthority,
    providerId: ledger.providerId ?? null,
    templateId: ledger.templateId ?? null,
    providerKind: ledger.providerKind ?? null,
    endpointHost: ledger.endpointHost ?? null,
    credentialReference: ledger.credentialReference ?? null,
    authHeaderName: ledger.authHeaderName ?? null,
    authScheme: ledger.authScheme ?? null,
    customHeaderCount: Number(ledger.customHeaderCount ?? -1),
    totalAttemptedSamples: Number(ledger.totalAttemptedSamples ?? 0),
    appendAttempts: Number(ledger.appendAttempts ?? 0),
    sendFailures: Number(ledger.sendFailures ?? 0),
    initialConnectAttempts: Number(ledger.initialConnectAttempts ?? 0),
    reconnects: Number(ledger.reconnects ?? 0),
    budgetExceeded: ledger.budgetExceeded,
    finalized: ledger.finalized,
    terminalReason: ledger.terminalReason ?? null,
    violations,
  };
}

export function writePreProviderTerminalAuthority({
  runDirectory,
  runMarker,
  cellId,
  leaseId,
  modelId,
  inputCeilingSamples = STRICT_PAID_CELL_MAX_INPUT_SAMPLES,
  modelProtocols = STRICT_PAID_MODEL_PROTOCOLS,
  providerIdentity = STRICT_PAID_PROVIDER_IDENTITY,
  occurredAtMs = Date.now(),
}) {
  const resolvedRunDirectory = path.resolve(runDirectory);
  const protocol = modelProtocols[modelId];
  if (!protocol) throw new Error(`model ${modelId || '(missing)'} has no approved strict-paid realtime protocol`);
  const modelProtocolProfileIdentity = deriveWatchModelProtocolIdentity(modelId);
  for (const [label, value] of Object.entries({ runMarker, cellId, leaseId, modelId })) {
    if (!String(value ?? '').trim()) throw new Error(`pre-provider terminal ${label} is missing`);
  }
  const maxSamples = Number(inputCeilingSamples);
  if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0) throw new Error('pre-provider terminal sample ceiling is invalid');
  fs.mkdirSync(resolvedRunDirectory, { recursive: true });
  const ledgerPath = path.join(resolvedRunDirectory, PROVIDER_SEND_BOUNDARY_LEDGER_FILE);
  const journalPath = path.join(resolvedRunDirectory, PROVIDER_SEND_BOUNDARY_JOURNAL_FILE);
  if (fs.existsSync(ledgerPath) || fs.existsSync(journalPath)) {
    throw new Error('refusing to replace an existing Provider send-boundary authority with a runner terminal');
  }
  const identity = {
    schemaVersion: EXTERNAL_PROVIDER_BUDGET_SCHEMA_VERSION,
    artifactKind: 'watch-mode-provider-input-budget-ledger',
    cellId,
    leaseId,
    runMarker,
    sessionGeneration: 0,
    direction: 'inbound',
    ...providerIdentity,
    model: modelId,
    protocol,
    modelProtocolProfileIdentity: structuredClone(modelProtocolProfileIdentity),
  };
  const initialized = {
    ...identity,
    event: 'initialized',
    sequence: 1,
    occurredAtMs,
    attemptedSamples: null,
    totalAttemptedSamples: 0,
    maxSamples,
    appendAttempts: 0,
    sendFailures: 0,
    initialConnectAttempts: 0,
    reconnects: 0,
    budgetExceeded: false,
    finalized: false,
    terminalReason: null,
  };
  const finalized = {
    ...initialized,
    event: 'finalized',
    sequence: 2,
    finalized: true,
    terminalReason: PRE_PROVIDER_TERMINAL_REASON,
  };
  const leasePath = path.join(resolvedRunDirectory, PROVIDER_BUDGET_LEASE_FILE);
  const leaseReceipt = {
    schemaVersion: EXTERNAL_PROVIDER_BUDGET_SCHEMA_VERSION,
    artifactKind: 'watch-mode-provider-input-budget-lease',
    cellId,
    leaseId,
    runMarker,
    maxSamples,
    modelProtocolProfileIdentity: structuredClone(modelProtocolProfileIdentity),
  };
  if (fs.existsSync(leasePath)) {
    const existingLease = readJson(leasePath, 'existing provider budget lease receipt');
    if (canonicalJson(existingLease) !== canonicalJson(leaseReceipt)) {
      throw new Error('existing provider budget lease receipt does not match the pre-provider terminal');
    }
  } else {
    fs.writeFileSync(leasePath, `${JSON.stringify(leaseReceipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  fs.writeFileSync(ledgerPath, `${JSON.stringify(finalized, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(journalPath, `${JSON.stringify(initialized)}\n${JSON.stringify(finalized)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(path.join(resolvedRunDirectory, 'provider-input-16k-mono.pcm'), Buffer.alloc(0), { flag: 'wx' });
  fs.writeFileSync(
    path.join(resolvedRunDirectory, PROVIDER_INPUT_PREFILTER_FILE),
    PROVIDER_INPUT_PREFILTER_MAGIC,
    { flag: 'wx' },
  );
}

function scopedRunLog(appLogText, runMarker) {
  const marker = String(runMarker ?? '').trim();
  if (!marker) throw new Error('strict paid-cell budget requires a run marker');
  let markerIndex = -1;
  let offset = 0;
  for (const line of appLogText.split(/(?<=\n)/)) {
    if (line.replace(/\r?\n$/, '') === marker) markerIndex = offset;
    offset += line.length;
  }
  if (markerIndex < 0) {
    throw new Error(`strict paid-cell app.log does not contain standalone run marker ${marker}`);
  }
  return appLogText.slice(markerIndex);
}

function providerEvidenceLines(scopedLog) {
  return scopedLog.split(/\r?\n/).filter((line) => (
    /input_audio_buffer\.append\.summary|\[CONNECT\]|watch_mode\.omni_session_config|watch_mode\.omni_(?:reconnect|retry)|\[RECONNECT\]|\[LLM_CALL\]|speech\.segment_tts_requested|subtitle-translate/i.test(line)
  ));
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

export function actualProviderInputSamplesFromLog(scopedLog) {
  let samples = 0;
  let summaryCount = 0;
  for (const line of scopedLog.split(/\r?\n/)) {
    if (!/input_audio_buffer\.append\.summary/i.test(line)) continue;
    const match = line.match(/"resampledSamplesTotal"\s*:\s*(\d+)/i);
    if (!match) continue;
    samples += Number(match[1]);
    summaryCount += 1;
  }
  return { samples, summaryCount };
}

export function reserveStrictPaidCellInputSamples({
  reservedSamples,
  nextCellSamples,
  matrixCeilingSamples = STRICT_PAID_MATRIX_MAX_INPUT_SAMPLES,
  cellCeilingSamples = STRICT_PAID_CELL_MAX_INPUT_SAMPLES,
}) {
  const current = Number(reservedSamples);
  const next = Number(nextCellSamples);
  const ceiling = Number(matrixCeilingSamples);
  const cellCeiling = Number(cellCeilingSamples);
  if (![current, next, ceiling, cellCeiling].every(Number.isFinite)
    || current < 0 || next <= 0 || ceiling <= 0 || cellCeiling <= 0) {
    throw new Error('strict paid-cell reservation requires finite positive sample budget values');
  }
  if (![current, next, ceiling, cellCeiling].every(Number.isSafeInteger)) {
    throw new Error('strict paid-cell reservation sample budgets must be safe integers');
  }
  if (next > cellCeiling) {
    throw new Error(`strict paid cell requests ${next} samples; per-cell maximum is ${cellCeiling}`);
  }
  if (current + next > ceiling) {
    throw new Error(`strict paid matrix would reserve ${current + next} input samples; ceiling is ${ceiling}`);
  }
  return current + next;
}

export function buildCellExternalProviderBudget({
  runDirectory,
  appLogPath = path.join(runDirectory, 'app.log'),
  runMarker,
  cellId,
  modelId,
  feedbackLoopPrevention,
  translationMode = 'native',
  inputCeilingSamples = STRICT_PAID_CELL_MAX_INPUT_SAMPLES,
  generatedAt = new Date(),
  approvedModels = RELEASE_MODELS,
  modelProtocols = STRICT_PAID_MODEL_PROTOCOLS,
  providerIdentity = STRICT_PAID_PROVIDER_IDENTITY,
  expectedModelProtocolProfileIdentity = null,
  authorityMode = 'strict-paid',
}) {
  const resolvedRunDirectory = path.resolve(runDirectory);
  const violations = [];
  const normalizedModel = String(modelId ?? '').trim();
  const normalizedCellId = String(cellId ?? '').trim();
  const feedbackMode = String(feedbackLoopPrevention ?? '').trim();
  const resolvedInputCeilingSamples = Number(inputCeilingSamples);
  let modelProtocolProfileIdentity = null;
  if (authorityMode === 'strict-paid') {
    try {
      modelProtocolProfileIdentity = deriveWatchModelProtocolIdentity(normalizedModel);
      if (expectedModelProtocolProfileIdentity) {
        assertWatchModelProtocolIdentity(
          expectedModelProtocolProfileIdentity,
          modelProtocolProfileIdentity,
          'strict paid expected model protocol profile identity',
        );
      }
    } catch (error) {
      violations.push(error.message);
    }
  }

  if (!Array.isArray(approvedModels) || !approvedModels.includes(normalizedModel)) {
    violations.push(`model ${normalizedModel || '(missing)'} is not in the approved ${authorityMode} model set`);
  }
  if (!modelProtocols[normalizedModel]) {
    violations.push(`model ${normalizedModel || '(missing)'} has no approved ${authorityMode} realtime protocol`);
  }
  if (!normalizedCellId) violations.push('strict paid cellId is missing');
  if (translationMode !== 'native') {
    violations.push(`strict paid subtitle translation mode must be native; got ${translationMode}`);
  }
  if (!Number.isSafeInteger(resolvedInputCeilingSamples)
    || resolvedInputCeilingSamples <= 0
    || resolvedInputCeilingSamples > STRICT_PAID_CELL_MAX_INPUT_SAMPLES) {
    violations.push('strict paid input sample ceiling is invalid or exceeds the hard per-cell sample maximum');
  }

  const providerPcmPath = path.join(resolvedRunDirectory, 'provider-input-16k-mono.pcm');
  let providerPcm = null;
  let providerInputReplay = null;
  let providerPcmBytes = null;
  if (!fs.existsSync(providerPcmPath)) {
    violations.push('provider-input-16k-mono.pcm is missing');
  } else {
    const stats = fs.lstatSync(providerPcmPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 0 || stats.size % EXTERNAL_PROVIDER_INPUT_BYTES_PER_SAMPLE !== 0) {
      violations.push(`provider input PCM has invalid byte length ${stats.size}`);
    } else {
      const samples = stats.size / EXTERNAL_PROVIDER_INPUT_BYTES_PER_SAMPLE;
      providerPcm = {
        path: 'provider-input-16k-mono.pcm',
        bytes: stats.size,
        samples,
        durationSeconds: roundedSeconds(samples),
        sha256: sha256File(providerPcmPath),
        note: 'local PCM cross-check; provider sends are authoritative only at the Rust send-boundary ledger',
      };
      providerPcmBytes = fs.readFileSync(providerPcmPath);
    }
  }

  try {
    const replay = replayProviderInputPrefilter({
      filePath: path.join(resolvedRunDirectory, PROVIDER_INPUT_PREFILTER_FILE),
      maxSamples: resolvedInputCeilingSamples,
    });
    providerInputReplay = replay.authority;
    if (!providerPcmBytes?.equals(replay.expectedProviderPcm)) {
      violations.push('provider input PCM is not byte-for-byte equal to the production prefilter replay');
    }
  } catch (error) {
    violations.push(error.message);
  }

  let scopedLog = '';
  let evidenceLines = [];
  try {
    const appLogText = fs.readFileSync(appLogPath, 'utf8');
    scopedLog = scopedRunLog(appLogText, runMarker);
    evidenceLines = providerEvidenceLines(scopedLog);
  } catch (error) {
    violations.push(error.message);
  }
  const tracedInput = actualProviderInputSamplesFromLog(scopedLog);
  let sendBoundaryAuthority = null;
  try {
    sendBoundaryAuthority = validateSendBoundaryAuthority({
      runDirectory: resolvedRunDirectory,
      cellId: normalizedCellId,
      runMarker,
      modelId: normalizedModel,
      maxSamples: resolvedInputCeilingSamples,
      modelProtocols,
      providerIdentity,
      modelProtocolProfileIdentity,
    });
    violations.push(...sendBoundaryAuthority.violations);
  } catch (error) {
    violations.push(error.message);
  }
  const authoritativeInputSamples = Number(sendBoundaryAuthority?.totalAttemptedSamples ?? 0);
  if (tracedInput.samples !== authoritativeInputSamples) {
    violations.push(`model-trace input samples ${tracedInput.samples} do not match send-boundary total ${authoritativeInputSamples}`);
  }
  if (providerPcm && providerPcm.samples !== authoritativeInputSamples) {
    violations.push(`provider input PCM samples ${providerPcm.samples} do not match send-boundary total ${authoritativeInputSamples}`);
  }
  if (
    providerInputReplay
    && providerInputReplay.decisions.acceptedSamples !== authoritativeInputSamples
  ) {
    violations.push(
      `provider prefilter replay samples ${providerInputReplay.decisions.acceptedSamples} do not match send-boundary total ${authoritativeInputSamples}`,
    );
  }
  if (
    providerInputReplay
    && providerInputReplay.decisions.acceptedChunks !== Number(sendBoundaryAuthority?.appendAttempts ?? 0)
  ) {
    violations.push(
      `provider prefilter replay append count ${providerInputReplay.decisions.acceptedChunks} does not match send-boundary attempts ${sendBoundaryAuthority?.appendAttempts ?? 0}`,
    );
  }

  const logConnectionCount = countMatches(scopedLog, /\[CONNECT\][^\r\n]*(?:已连接|connected)[^\r\n]*Omni/giu);
  const logReconnectCount = countMatches(scopedLog, /watch_mode\.omni_(?:reconnect|retry)|\[RECONNECT\]/giu);
  if (logReconnectCount !== Number(sendBoundaryAuthority?.reconnects ?? 0)) {
    violations.push(`log reconnect count ${logReconnectCount} does not match send-boundary authority ${sendBoundaryAuthority?.reconnects ?? 0}`);
  }
  if (logConnectionCount !== Number(sendBoundaryAuthority?.initialConnectAttempts ?? 0)) {
    violations.push(`log connection count ${logConnectionCount} does not match send-boundary authority ${sendBoundaryAuthority?.initialConnectAttempts ?? 0}`);
  }

  const secondaryTranslationCalls = countMatches(scopedLog, /\[LLM_CALL\]|"category"\s*:\s*"subtitle-translate"/giu);
  const secondaryTtsCalls = countMatches(scopedLog, /speech\.segment_tts_requested/giu);
  if (secondaryTranslationCalls !== 0) {
    violations.push(`strict paid cell observed ${secondaryTranslationCalls} secondary translation calls`);
  }
  if (secondaryTtsCalls !== 0) {
    violations.push(`strict paid cell observed ${secondaryTtsCalls} secondary TTS calls`);
  }

  const forbiddenArtifacts = FORBIDDEN_REMOTE_AUXILIARY_ARTIFACTS.filter(
    (relativePath) => fs.existsSync(path.join(resolvedRunDirectory, relativePath)),
  );
  if (forbiddenArtifacts.length > 0) {
    violations.push(`remote auxiliary diagnostic artifacts are forbidden: ${forbiddenArtifacts.join(', ')}`);
  }

  const contentRequired = true;
  const sourceAuthorityPath = path.join(resolvedRunDirectory, 'source-media-transcript.json');
  const physicalAuthorityPath = path.join(resolvedRunDirectory, 'physical-output-content.raw.json');
  let sourceAuthority = null;
  let physicalAuthority = null;
  let canonicalSourceValidation = null;
  let physicalSourceWaveform = null;
  if (contentRequired) {
    try {
      sourceAuthority = readJson(sourceAuthorityPath, 'canonical source authority');
      if (Number(sourceAuthority.remoteProviderCalls) !== 0) {
        violations.push('canonical source authority declares external Provider usage');
      }
    } catch {}
    try {
      physicalAuthority = readJson(physicalAuthorityPath, 'physical output authority');
      const declaredRemoteProviderCalls = Number(physicalAuthority.remoteProviderCalls);
      const declaredExternalAudioSeconds = Number(physicalAuthority.externalAudioSeconds);
      if (
        (Number.isFinite(declaredRemoteProviderCalls) && declaredRemoteProviderCalls !== 0)
        || (Number.isFinite(declaredExternalAudioSeconds) && declaredExternalAudioSeconds !== 0)
      ) {
        violations.push('physical output authority declares external Provider usage');
      }
    } catch {}
  }

  const actualInputSeconds = roundedSeconds(authoritativeInputSamples);
  return {
    schemaVersion: EXTERNAL_PROVIDER_BUDGET_SCHEMA_VERSION,
    artifactKind: CELL_EXTERNAL_PROVIDER_BUDGET_KIND,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    passed: violations.length === 0,
    scope: authorityMode === 'strict-paid'
      ? 'strict-paid-provider-input-samples'
      : `${authorityMode}-provider-input-samples`,
    runMarker: String(runMarker ?? ''),
    cellId: normalizedCellId,
    modelId: normalizedModel,
    ...(modelProtocolProfileIdentity ? {
      modelProtocolProfileIdentity: structuredClone(modelProtocolProfileIdentity),
    } : {}),
    feedbackLoopPrevention: feedbackMode,
    translationMode,
    approvedModels: [...approvedModels],
    ...(authorityMode === 'strict-paid' ? {} : {
      incidentId: providerIdentity.incidentId,
    }),
    inputSampleRateHz: EXTERNAL_PROVIDER_INPUT_SAMPLE_RATE_HZ,
    providerInputSampleCeiling: resolvedInputCeilingSamples,
    actualProviderInputSamples: authoritativeInputSamples,
    actualProviderInputSeconds: actualInputSeconds,
    providerInputPcm: providerPcm,
    providerInputReplay,
    providerTrace: {
      audioAppendSummaryCount: tracedInput.summaryCount,
      evidenceLineCount: evidenceLines.length,
      evidenceSha256: sha256Buffer(Buffer.from(evidenceLines.join('\n'), 'utf8')),
      connectionLineCount: logConnectionCount,
      reconnectLineCount: logReconnectCount,
    },
    providerSendBoundary: sendBoundaryAuthority,
    calls: {
      mainRealtime: sendBoundaryAuthority?.passed
        ? Number(sendBoundaryAuthority.initialConnectAttempts)
        : 0,
      sourceTranscript: 0,
      physicalOutputStt: 0,
      secondaryTranslation: secondaryTranslationCalls,
      secondaryTts: secondaryTtsCalls,
    },
    auxiliaryExternalAudioSeconds: 0,
    sourceAuthority: sourceAuthority ? {
      authorityMode: sourceAuthority.authorityMode,
      remoteProviderCalls: sourceAuthority.remoteProviderCalls,
      mediaSha256: sourceAuthority.mediaSha256,
      referencePcmSha256: sourceAuthority.referencePcm?.sha256 ?? null,
      canonicalValidation: canonicalSourceValidation,
    } : null,
    physicalAuthority: physicalAuthority ? {
      authorityMode: physicalAuthority.authorityMode,
      remoteProviderCalls: physicalAuthority.remoteProviderCalls,
      sourceSimilarityPassed: physicalAuthority.originalPassthrough?.sourceSimilarity?.passed === true,
      sourceWaveformAuthority: physicalSourceWaveform,
      cuePlaybackPassed: physicalAuthority.translatedSpeech?.playbackAuthority?.passed === true,
      translatedPcmLoopbackPassed: physicalAuthority.translatedSpeech?.acousticAuthority?.passed === true,
    } : null,
    forbiddenArtifacts,
    violations,
  };
}

export function writeCellExternalProviderBudget(options) {
  const ledger = buildCellExternalProviderBudget(options);
  const filePath = path.join(path.resolve(options.runDirectory), CELL_EXTERNAL_PROVIDER_BUDGET_FILE);
  fs.writeFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  return { filePath, ledger };
}

export function assertCellExternalProviderBudget(runDirectory, expected = {}) {
  const filePath = path.join(path.resolve(runDirectory), CELL_EXTERNAL_PROVIDER_BUDGET_FILE);
  const recorded = readJson(filePath, 'strict paid-cell budget ledger');
  if (recorded.schemaVersion !== EXTERNAL_PROVIDER_BUDGET_SCHEMA_VERSION || recorded.artifactKind !== CELL_EXTERNAL_PROVIDER_BUDGET_KIND) {
    throw new Error(`strict paid-cell budget ledger has an unsupported schema/kind: ${filePath}`);
  }
  const rebuilt = buildCellExternalProviderBudget({
    runDirectory,
    runMarker: recorded.runMarker ?? expected.runMarker,
    cellId: expected.cellId ?? recorded.cellId,
    modelId: expected.modelId ?? recorded.modelId,
    feedbackLoopPrevention: expected.feedbackLoopPrevention ?? recorded.feedbackLoopPrevention,
    translationMode: recorded.translationMode,
    inputCeilingSamples:
      expected.inputCeilingSamples ?? recorded.providerInputSampleCeiling,
    generatedAt: recorded.generatedAt,
    approvedModels: expected.approvedModels ?? recorded.approvedModels ?? RELEASE_MODELS,
    modelProtocols: expected.modelProtocols ?? STRICT_PAID_MODEL_PROTOCOLS,
    providerIdentity: expected.providerIdentity ?? STRICT_PAID_PROVIDER_IDENTITY,
    expectedModelProtocolProfileIdentity: expected.modelProtocolProfileIdentity ?? null,
    authorityMode: expected.authorityMode ?? recorded.authorityMode ?? 'strict-paid',
  });
  // The marker prevents a copied ledger from selecting an unrelated
  // historical model trace from the same app.log.
  if (!recorded.runMarker) throw new Error(`strict paid-cell budget ledger is missing runMarker: ${filePath}`);
  const recordedComparable = { ...recorded };
  const rebuiltComparable = { ...rebuilt };
  if (JSON.stringify(recordedComparable) !== JSON.stringify(rebuiltComparable)) {
    throw new Error(`strict paid-cell budget ledger does not match current raw artifacts: ${filePath}`);
  }
  if (!recorded.passed) {
    throw new Error(`strict paid-cell provider budget failed before another paid cell can start: ${recorded.violations.join('; ')}`);
  }
  return recorded;
}

export function buildMatrixExternalProviderBudget(cellLedgers, {
  generatedAt = new Date(),
  matrixInputSampleCeiling = null,
  expectedCells = LIVE_LLM_CELLS,
} = {}) {
  const ledgers = Array.isArray(cellLedgers) ? cellLedgers : [];
  const violations = [];
  let reservedInputSamples = 0;
  let actualInputSamples = 0;
  const expectedCellIds = expectedCells.map((cell) => cell.cellId);
  const recordedCellIds = ledgers.map((ledger) => ledger?.cellId);
  const leaseIds = ledgers.map((ledger) => ledger?.providerSendBoundary?.leaseId);
  const cellMaxInputSamples = Math.max(
    0,
    ...expectedCells.map((cell) => Number(
      cell.maxExternalAudioSamples ?? cell.providerInputSampleCeiling ?? 0,
    )),
  );
  const resolvedMatrixInputSampleCeiling = Number(
    matrixInputSampleCeiling ?? expectedCells.reduce(
      (total, cell) => total + Number(
        cell.maxExternalAudioSamples ?? cell.providerInputSampleCeiling ?? 0,
      ),
      0,
    ),
  );
  if (JSON.stringify(recordedCellIds) !== JSON.stringify(expectedCellIds)) {
    violations.push(`strict paid matrix cell ids/order do not match the fixed ${expectedCells.length}-cell plan`);
  }
  if (new Set(recordedCellIds).size !== recordedCellIds.length) {
    violations.push('strict paid matrix contains duplicate cellId values');
  }
  if (leaseIds.some((leaseId) => typeof leaseId !== 'string' || !leaseId.trim())) {
    violations.push('strict paid matrix contains a missing provider leaseId');
  }
  if (new Set(leaseIds).size !== leaseIds.length) {
    violations.push('strict paid matrix contains duplicate provider leaseId values');
  }
  for (const [index, ledger] of ledgers.entries()) {
    if (ledger?.passed !== true) {
      const details = Array.isArray(ledger?.violations) && ledger.violations.length > 0
        ? `: ${ledger.violations.join('; ')}`
        : '';
      violations.push(`cell ${index} budget did not pass${details}`);
    }
    try {
      reservedInputSamples = reserveStrictPaidCellInputSamples({
        reservedSamples: reservedInputSamples,
        nextCellSamples: Number(ledger?.providerInputSampleCeiling),
        matrixCeilingSamples: resolvedMatrixInputSampleCeiling,
        cellCeilingSamples: cellMaxInputSamples,
      });
    } catch (error) {
      violations.push(`cell ${index}: ${error.message}`);
    }
    actualInputSamples += Number(ledger?.actualProviderInputSamples ?? 0);
    for (const key of ['sourceTranscript', 'physicalOutputStt', 'secondaryTranslation', 'secondaryTts']) {
      if (Number(ledger?.calls?.[key] ?? 0) !== 0) violations.push(`cell ${index} has forbidden ${key} calls`);
    }
    if (Number(ledger?.auxiliaryExternalAudioSeconds ?? 0) !== 0) {
      violations.push(`cell ${index} has non-zero auxiliary external audio`);
    }
    try {
      assertWatchModelProtocolIdentity(
        ledger?.modelProtocolProfileIdentity,
        expectedCells[index]?.modelProtocolProfileIdentity,
        `strict paid matrix cell ${index} model protocol profile identity`,
      );
    } catch (error) {
      violations.push(error.message);
    }
  }
  const actualInputSeconds = roundedSeconds(actualInputSamples);
  if (reservedInputSamples > resolvedMatrixInputSampleCeiling) {
    violations.push(`reserved provider input ${reservedInputSamples} samples exceeds ${resolvedMatrixInputSampleCeiling}`);
  }
  if (actualInputSamples > resolvedMatrixInputSampleCeiling) {
    violations.push(`actual provider input audio ${actualInputSamples} samples exceeds ${resolvedMatrixInputSampleCeiling}`);
  }
  return {
    schemaVersion: EXTERNAL_PROVIDER_BUDGET_SCHEMA_VERSION,
    artifactKind: MATRIX_EXTERNAL_PROVIDER_BUDGET_KIND,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    passed: violations.length === 0,
    scope: 'strict-paid-provider-input-samples',
    matrixInputSampleCeiling: resolvedMatrixInputSampleCeiling,
    cellMaxInputSamples,
    cellCount: ledgers.length,
    reservedInputSamples,
    actualProviderInputSamples: actualInputSamples,
    actualProviderInputSeconds: actualInputSeconds,
    auxiliaryExternalAudioSeconds: 0,
    calls: {
      sourceTranscript: 0,
      physicalOutputStt: 0,
      secondaryTranslation: 0,
      secondaryTts: 0,
    },
    cells: ledgers.map((ledger) => ({
      modelId: ledger.modelId,
      modelProtocolProfileIdentity: structuredClone(ledger.modelProtocolProfileIdentity),
      cellId: ledger.cellId,
      feedbackLoopPrevention: ledger.feedbackLoopPrevention,
      providerInputSampleCeiling: ledger.providerInputSampleCeiling,
      actualProviderInputSamples: ledger.actualProviderInputSamples,
      actualProviderInputSeconds: ledger.actualProviderInputSeconds,
      leaseId: ledger.providerSendBoundary?.leaseId ?? null,
    })),
    violations,
  };
}

export function assertMatrixExternalProviderBudget(filePath, cellLedgers, options = {}) {
  const recorded = readJson(filePath, 'strict paid-matrix budget ledger');
  if (recorded.schemaVersion !== EXTERNAL_PROVIDER_BUDGET_SCHEMA_VERSION || recorded.artifactKind !== MATRIX_EXTERNAL_PROVIDER_BUDGET_KIND) {
    throw new Error(`strict paid-matrix budget ledger has an unsupported schema/kind: ${filePath}`);
  }
  const rebuilt = buildMatrixExternalProviderBudget(cellLedgers, {
    matrixInputSampleCeiling: recorded.matrixInputSampleCeiling,
    generatedAt: recorded.generatedAt,
    expectedCells: options.expectedCells ?? LIVE_LLM_CELLS,
  });
  if (JSON.stringify(recorded) !== JSON.stringify(rebuilt)) {
    throw new Error(`strict paid-matrix budget ledger does not match rebuilt cell authorities: ${filePath}`);
  }
  if (!recorded.passed) {
    throw new Error(`strict paid-matrix provider budget failed: ${recorded.violations.join('; ')}`);
  }
  return recorded;
}

export function writeMatrixExternalProviderBudget(outputRoot, cellLedgers, options = {}) {
  const ledger = buildMatrixExternalProviderBudget(cellLedgers, options);
  const filePath = path.join(
    path.resolve(outputRoot),
    options.fileName ?? MATRIX_EXTERNAL_PROVIDER_BUDGET_FILE,
  );
  fs.writeFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  if (!ledger.passed) throw new Error(`strict paid matrix budget failed: ${ledger.violations.join('; ')}`);
  return { filePath, ledger };
}

if (isMain(import.meta.url)) {
  try {
    const options = parseCliArgs(process.argv.slice(2), {
      defaults: {
        runDirectory: '',
        appLog: '',
        runMarker: '',
        cellId: '',
        modelId: '',
        feedbackMode: '',
        translationMode: 'native',
        authorityMode: 'strict-paid',
        writePreProviderTerminal: 'false',
        leaseId: '',
        inputCeilingSamples: '',
      },
    });
    for (const [key, value] of Object.entries({
      runDirectory: options.runDirectory,
      appLog: options.appLog,
      runMarker: options.runMarker,
      cellId: options.cellId,
      modelId: options.modelId,
      feedbackMode: options.feedbackMode,
    })) {
      if (!String(value ?? '').trim()) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
    }
    const authorityMode = String(options.authorityMode ?? '').trim();
    const incidentReplay = authorityMode === 'incident-replay-plus';
    if (!['strict-paid', 'incident-replay-plus'].includes(authorityMode)) {
      throw new Error(`unsupported provider budget authority mode: ${authorityMode || '(missing)'}`);
    }
    if (String(options.writePreProviderTerminal).toLowerCase() === 'true') {
      if (authorityMode !== 'strict-paid') throw new Error('pre-provider terminal is only valid for strict-paid authority');
      writePreProviderTerminalAuthority({
        runDirectory: options.runDirectory,
        runMarker: options.runMarker,
        cellId: options.cellId,
        leaseId: options.leaseId,
        modelId: options.modelId,
        inputCeilingSamples: String(options.inputCeilingSamples ?? '').trim()
          ? Number(options.inputCeilingSamples)
          : STRICT_PAID_CELL_MAX_INPUT_SAMPLES,
      });
    }
    const { filePath, ledger } = writeCellExternalProviderBudget({
      runDirectory: options.runDirectory,
      appLogPath: options.appLog,
      runMarker: options.runMarker,
      cellId: options.cellId,
      modelId: options.modelId,
      feedbackLoopPrevention: options.feedbackMode,
      translationMode: options.translationMode,
      inputCeilingSamples: String(options.inputCeilingSamples ?? '').trim()
        ? Number(options.inputCeilingSamples)
        : STRICT_PAID_CELL_MAX_INPUT_SAMPLES,
      authorityMode,
      ...(incidentReplay ? {
        approvedModels: [INCIDENT_REPLAY_PLUS_MODEL],
        modelProtocols: INCIDENT_REPLAY_PLUS_MODEL_PROTOCOLS,
        providerIdentity: INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY,
      } : {}),
    });
    if (!ledger.passed) {
      console.error(`strict paid-cell provider budget failed: ${ledger.violations.join('; ')}`);
      process.exit(1);
    }
    console.log(filePath);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
