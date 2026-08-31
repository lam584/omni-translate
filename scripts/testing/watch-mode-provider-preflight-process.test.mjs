import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runManagedProviderPreflight } from './watch-mode-provider-preflight-process.mjs';

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function publishEmitter(outputDirectory, value) {
  const staging = `${outputDirectory}.staging`;
  fs.mkdirSync(staging, { recursive: false });
  fs.writeFileSync(path.join(staging, 'emitter-result.json'), JSON.stringify(value));
  fs.renameSync(staging, outputDirectory);
}

const DASH_SCOPE_MODEL = 'qwen3.5-livetranslate-flash-realtime';
const REALTIME_LATENCY_BUDGET_MS = 1_200;
const SOCKET_EVENT_TIMEOUT_MS = 12_000;
const RAW_TRACE_RELATIVE_PATH = 'raw/provider-websocket-trace.jsonl';
const TIMEOUT_PHASES = new Set([
  'connect',
  'websocket-upgrade',
  'read-first-event',
  'response-completion',
]);
const LIVETRANSLATE_LIFECYCLE = [
  { direction: 'transport', type: 'websocket.upgrade' },
  { direction: 'server-to-client', type: 'session.created' },
  { direction: 'client-to-server', type: 'session.update' },
  { direction: 'server-to-client', type: 'session.updated' },
  { direction: 'client-to-server', type: 'session.finish' },
  { direction: 'server-to-client', type: 'session.finished' },
];
const SESSION_IDENTITY_SHA256 = sha256('session-identity-fixture');
const OFFICIAL_SESSION_UPDATE = {
  event_id: 'evt_update_001',
  type: 'session.update',
  session: {
    modalities: ['text'],
    sample_rate: 16_000,
    input_audio_format: 'pcm',
    input_audio_transcription: {
      language: 'zh',
      model: 'qwen3-asr-flash-realtime',
    },
    translation: { language: 'en' },
    turn_detection: {
      type: 'server_vad',
      threshold: 0.0,
      silence_duration_ms: 400,
    },
  },
};
const OFFICIAL_SESSION_FINISH = {
  event_id: 'evt_finish_001',
  type: 'session.finish',
};
const OFFICIAL_UPGRADE_REQUEST_AUTHORITY = {
  scheme: 'wss',
  host: 'dashscope.aliyuncs.com',
  path: '/api-ws/v1/realtime',
  query: { model: DASH_SCOPE_MODEL },
  requestHeaderNames: ['authorization'],
};
const OFFICIAL_SESSION_UPDATE_RAW = JSON.stringify(OFFICIAL_SESSION_UPDATE);
const OFFICIAL_SESSION_FINISH_RAW = JSON.stringify(OFFICIAL_SESSION_FINISH);
const OFFICIAL_UPGRADE_REQUEST_AUTHORITY_RAW = JSON.stringify(OFFICIAL_UPGRADE_REQUEST_AUTHORITY);
const OFFICIAL_SESSION_ECHO_CANONICAL = '{"input_audio_format":"pcm",'
  + '"input_audio_transcription":{"language":"zh","model":"qwen3-asr-flash-realtime"},'
  + '"modalities":["text"],"sample_rate":16000,"translation":{"language":"en"},'
  + '"turn_detection":{"silence_duration_ms":400,"threshold":0.0,"type":"server_vad"}}';
const OFFICIAL_SESSION_ECHO_SHA256 = sha256(OFFICIAL_SESSION_ECHO_CANONICAL);
const OFFICIAL_SESSION_CREATED = {
  event_id: 'evt_server_created_001',
  type: 'session.created',
  session: {
    id: SESSION_IDENTITY_SHA256,
    model: DASH_SCOPE_MODEL,
  },
};
const OFFICIAL_SESSION_UPDATED = {
  event_id: 'evt_server_updated_001',
  type: 'session.updated',
  session: {
    id: SESSION_IDENTITY_SHA256,
    model: DASH_SCOPE_MODEL,
    ...OFFICIAL_SESSION_UPDATE.session,
    turn_detection: {
      ...OFFICIAL_SESSION_UPDATE.session.turn_detection,
      create_response: true,
      interrupt_response: true,
    },
  },
};
const OFFICIAL_SESSION_FINISHED = {
  event_id: 'evt_server_finished_001',
  type: 'session.finished',
};
const OFFICIAL_SESSION_CREATED_RAW = JSON.stringify(OFFICIAL_SESSION_CREATED);
const OFFICIAL_SESSION_UPDATED_RAW = JSON.stringify(OFFICIAL_SESSION_UPDATED);
const OFFICIAL_SESSION_FINISHED_RAW = JSON.stringify(OFFICIAL_SESSION_FINISHED);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function rawTraceAuthority(trace) {
  const bytes = Buffer.from(trace, 'utf8');
  return {
    path: RAW_TRACE_RELATIVE_PATH,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    eventCount: trace.split(/\r?\n/u).filter(Boolean).length,
  };
}

function publishProbeEvidence(outputDirectory, {
  emitter = { status: 'completed' },
  rawProbeResult,
  trace,
}) {
  const staging = `${outputDirectory}.staging`;
  const rawDirectory = path.join(staging, 'raw');
  fs.mkdirSync(rawDirectory, { recursive: true });
  const authority = rawTraceAuthority(trace);
  fs.writeFileSync(path.join(staging, authority.path), trace, 'utf8');
  fs.writeFileSync(path.join(staging, 'provider-probe-result.json'), JSON.stringify({
    schemaVersion: 1,
    artifactKind: 'provider-production-probe-result',
    model: DASH_SCOPE_MODEL,
    verdict: emitter.status === 'completed' ? 'available' : 'unavailable',
    rawProbeResult: {
      modelId: DASH_SCOPE_MODEL,
      latencyBudgetMs: REALTIME_LATENCY_BUDGET_MS,
      ...rawProbeResult,
      rawTrace: authority,
    },
  }));
  fs.writeFileSync(path.join(staging, 'emitter-result.json'), JSON.stringify(emitter));
  fs.renameSync(staging, outputDirectory);
  return authority;
}

function parseRawTrace(trace) {
  try {
    return trace.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return null;
  }
}

function serializeRawTrace(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function mutatePayloadTrace(type, mutatePayload, { recomputeDigest = true } = {}) {
  const entries = parseRawTrace(successfulLivetranslateTrace());
  const entry = entries.find((candidate) => candidate.type === type);
  const payload = JSON.parse(entry.rawRedactedPayload);
  mutatePayload(payload, entry);
  entry.rawRedactedPayload = JSON.stringify(payload);
  if (recomputeDigest) entry.sha256 = sha256(entry.rawRedactedPayload);
  return serializeRawTrace(entries);
}

function parseJsonObject(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonValueEquals(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValueEquals(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && jsonValueEquals(left[key], right[key]));
}

function hasExactKeys(value, expectedKeys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && jsonValueEquals(Object.keys(value).sort(), [...expectedKeys].sort());
}

function isControlledEventId(value) {
  return typeof value === 'string'
    && /^evt_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

function traceContainsForbiddenInput(entries) {
  return entries.some((entry) => {
    if (['input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create'].includes(entry.type)) {
      return true;
    }
    if (entry.type !== 'conversation.item.create') return false;
    return entry.contentType === 'input_text'
      || /"type"\s*:\s*"input_text"/u.test(String(entry.rawRedactedPayload ?? ''));
  });
}

function validateLivetranslateLifecycle(raw, trace) {
  const entries = parseRawTrace(trace);
  if (!entries) return { valid: false, reason: 'raw-trace-unparseable' };
  if (traceContainsForbiddenInput(entries)
    || raw?.externalAudioSamples !== 0
    || raw?.inputAudioBufferCommitCount !== 0
    || raw?.conversationItemCreateInputTextCount !== 0
    || raw?.responseCreateCount !== 0) {
    return { valid: false, reason: 'forbidden-livetranslate-input' };
  }
  if (entries.length < LIVETRANSLATE_LIFECYCLE.length) {
    return { valid: false, reason: 'incomplete-livetranslate-lifecycle' };
  }
  if (entries.length > LIVETRANSLATE_LIFECYCLE.length) {
    return { valid: false, reason: 'unexpected-livetranslate-trace-event' };
  }
  const lifecycleTypes = new Set(LIVETRANSLATE_LIFECYCLE.map((entry) => entry.type));
  const lifecycle = entries.filter((entry) => lifecycleTypes.has(entry.type));
  if (lifecycle.length !== LIVETRANSLATE_LIFECYCLE.length) {
    return { valid: false, reason: 'incomplete-livetranslate-lifecycle' };
  }
  for (let index = 0; index < LIVETRANSLATE_LIFECYCLE.length; index += 1) {
    const expected = LIVETRANSLATE_LIFECYCLE[index];
    const observed = lifecycle[index];
    if (observed.type !== expected.type || observed.direction !== expected.direction) {
      return { valid: false, reason: 'invalid-livetranslate-order' };
    }
    if (!Number.isInteger(observed.monotonicMs) || observed.monotonicMs < 0) {
      return { valid: false, reason: 'invalid-livetranslate-monotonic-time' };
    }
    if (index > 0 && observed.monotonicMs <= lifecycle[index - 1].monotonicMs) {
      return { valid: false, reason: 'invalid-livetranslate-order' };
    }
  }

  const upgrade = entries.find((entry) => entry.type === 'websocket.upgrade');
  const upgradeAuthority = parseJsonObject(upgrade.rawRedactedPayload);
  if (!upgradeAuthority
    || upgrade.status !== 101
    || upgrade.sha256 !== sha256(upgrade.rawRedactedPayload)
    || !hasExactKeys(upgradeAuthority, [
      'scheme',
      'host',
      'path',
      'query',
      'requestHeaderNames',
    ])
    || !jsonValueEquals(upgradeAuthority, OFFICIAL_UPGRADE_REQUEST_AUTHORITY)
    || /Bearer\s|api[-_]?key|headerValues|authorization\s*[":=]\s*["']?[^"'\],}]+/iu
      .test(upgrade.rawRedactedPayload)) {
    return { valid: false, reason: 'upgrade-request-authority-invalid' };
  }

  const firstTraceServerEvent = entries.find((entry) => entry.direction === 'server-to-client');
  if (firstTraceServerEvent?.type !== raw?.firstServerEvent?.type
    || firstTraceServerEvent?.monotonicMs !== raw?.firstServerEvent?.monotonicMs) {
    return { valid: false, reason: 'first-server-event-trace-mismatch' };
  }
  const created = entries.find((entry) => entry.type === 'session.created');
  const updated = entries.find((entry) => entry.type === 'session.updated');
  const createdPayload = parseJsonObject(created.rawRedactedPayload);
  const updatedPayload = parseJsonObject(updated.rawRedactedPayload);
  if (!createdPayload
    || !updatedPayload
    || created.sha256 !== sha256(created.rawRedactedPayload)
    || updated.sha256 !== sha256(updated.rawRedactedPayload)
    || createdPayload.type !== 'session.created'
    || updatedPayload.type !== 'session.updated') {
    return { valid: false, reason: 'server-event-payload-invalid' };
  }
  const sessionAuthority = raw?.sessionAuthority;
  if (createdPayload.session?.id !== SESSION_IDENTITY_SHA256
    || updatedPayload.session?.id !== SESSION_IDENTITY_SHA256
    || createdPayload.session.id !== updatedPayload.session.id
    || sessionAuthority?.sessionIdentitySha256 !== createdPayload.session.id) {
    return { valid: false, reason: 'session-identity-mismatch' };
  }
  if (createdPayload.session?.model !== DASH_SCOPE_MODEL
    || updatedPayload.session?.model !== DASH_SCOPE_MODEL
    || sessionAuthority?.serverModel !== DASH_SCOPE_MODEL) {
    return { valid: false, reason: 'server-model-mismatch' };
  }
  const {
    id: _sessionId,
    model: _serverModel,
    turn_detection: echoedTurnDetection,
    ...echoedSessionConfigWithoutTurnDetection
  } = updatedPayload.session;
  const {
    create_response: createResponse,
    interrupt_response: interruptResponse,
    ...echoedRequestedTurnDetection
  } = echoedTurnDetection ?? {};
  const echoedSessionConfig = {
    ...echoedSessionConfigWithoutTurnDetection,
    turn_detection: echoedRequestedTurnDetection,
  };
  if (!jsonValueEquals(echoedSessionConfig, OFFICIAL_SESSION_UPDATE.session)
    || createResponse !== true
    || interruptResponse !== true
    || sessionAuthority?.echoedSessionConfigSha256 !== OFFICIAL_SESSION_ECHO_SHA256) {
    return { valid: false, reason: 'session-update-echo-mismatch' };
  }
  const update = entries.find((entry) => entry.type === 'session.update');
  const parsedUpdate = parseJsonObject(update.rawRedactedPayload);
  if (!parsedUpdate
    || update.sha256 !== sha256(update.rawRedactedPayload)
    || !hasExactKeys(parsedUpdate, ['event_id', 'type', 'session'])
    || parsedUpdate.type !== 'session.update'
    || !isControlledEventId(parsedUpdate.event_id)
    || !jsonValueEquals(parsedUpdate.session, OFFICIAL_SESSION_UPDATE.session)) {
    return { valid: false, reason: 'session-update-payload-invalid' };
  }
  const finish = entries.find((entry) => entry.type === 'session.finish');
  const parsedFinish = parseJsonObject(finish.rawRedactedPayload);
  if (!parsedFinish
    || finish.sha256 !== sha256(finish.rawRedactedPayload)
    || !hasExactKeys(parsedFinish, ['event_id', 'type'])
    || parsedFinish.type !== 'session.finish'
    || !isControlledEventId(parsedFinish.event_id)
    || parsedFinish.event_id === parsedUpdate.event_id) {
    return { valid: false, reason: 'session-finish-payload-invalid' };
  }
  const finished = entries.find((entry) => entry.type === 'session.finished');
  const parsedFinished = parseJsonObject(finished.rawRedactedPayload);
  if (!parsedFinished
    || finished.sha256 !== sha256(finished.rawRedactedPayload)
    || !hasExactKeys(parsedFinished, ['event_id', 'type'])
    || parsedFinished.type !== 'session.finished'
    || typeof parsedFinished.event_id !== 'string'
    || parsedFinished.event_id.length === 0) {
    return { valid: false, reason: 'session-finished-payload-invalid' };
  }
  if (raw?.providerInputMode !== 'none'
    || raw?.responseMode !== 'text-only'
    || raw?.providerInvocationCount !== 1
    || raw?.connectionCount !== 1) {
    return { valid: false, reason: 'invalid-livetranslate-call-authority' };
  }
  return { valid: true, reason: null };
}

// This oracle deliberately does not import the production report/parser. It
// decides only from wire evidence which mutually-exclusive terminal state was
// observed. A missing or malformed raw state is always fail-closed, never pass.
function classifyWireEvidence(raw, trace = '') {
  const traceEntries = parseRawTrace(trace);
  const first = raw?.firstServerEvent;
  const firstIsValid = typeof first?.type === 'string'
    && first.type.length > 0
    && Number.isInteger(first.monotonicMs)
    && first.monotonicMs >= 0;
  const errorFrame = raw?.providerErrorFrame;
  const errorPayload = errorFrame?.rawRedactedPayload;
  const errorIsValid = typeof errorPayload === 'string'
    && errorPayload.length > 0
    && errorFrame.sha256 === sha256(errorPayload)
    && !/Bearer\s+[^\s"']+/iu.test(errorPayload);
  const close = raw?.websocketClose;
  const closeIsValid = Number.isInteger(close?.code)
    && close.code >= 1_000
    && close.code <= 4_999
    && typeof close.reason === 'string'
    && typeof close.normal === 'boolean'
    && close.normal === [1_000, 1_001].includes(close.code);
  const timeoutIsValid = TIMEOUT_PHASES.has(raw?.timeoutPhase);

  if (errorIsValid) {
    const traceMatch = traceEntries?.some((entry) => entry.type === 'error'
      && entry.monotonicMs === errorFrame.monotonicMs
      && entry.rawRedactedPayload === errorFrame.rawRedactedPayload);
    return {
      kind: traceMatch ? 'provider-error-frame' : 'terminal-trace-mismatch',
      passed: false,
    };
  }
  if (closeIsValid) {
    const traceMatch = traceEntries?.some((entry) => entry.type === 'websocket.close'
      && entry.monotonicMs === close.monotonicMs
      && entry.code === close.code
      && entry.reason === close.reason
      && entry.normal === close.normal);
    return {
      kind: traceMatch
        ? close.normal ? 'websocket-close-normal' : 'websocket-close-abnormal'
        : 'terminal-trace-mismatch',
      passed: false,
    };
  }
  if (timeoutIsValid) {
    const expectedType = {
      connect: 'connect.timeout',
      'websocket-upgrade': 'websocket.upgrade.timeout',
      'read-first-event': 'read.timeout',
      'response-completion': 'read.timeout',
    }[raw.timeoutPhase];
    const expectedStartedMonotonicMs = raw.timeoutPhase === 'response-completion'
      ? traceEntries?.find((entry) => entry.direction === 'client-to-server'
        && entry.type === 'session.update')?.monotonicMs
      : 0;
    const traceMatch = Number.isSafeInteger(raw.timeoutBudgetMs)
      && raw.timeoutBudgetMs === SOCKET_EVENT_TIMEOUT_MS
      && traceEntries?.some((entry) => entry.type === expectedType
        && entry.timeoutPhase === raw.timeoutPhase
        && Number.isSafeInteger(entry.startedMonotonicMs)
        && Number.isSafeInteger(entry.deadlineMonotonicMs)
        && Number.isSafeInteger(entry.monotonicMs)
        && entry.startedMonotonicMs === expectedStartedMonotonicMs
        && entry.deadlineMonotonicMs - entry.startedMonotonicMs === SOCKET_EVENT_TIMEOUT_MS
        && entry.monotonicMs >= entry.deadlineMonotonicMs);
    return {
      kind: traceMatch ? `timeout:${raw.timeoutPhase}` : 'terminal-trace-mismatch',
      passed: false,
    };
  }
  const unreportedTerminal = traceEntries?.some((entry) => [
    'error',
    'websocket.close',
    'connect.timeout',
    'websocket.upgrade.timeout',
    'read.timeout',
  ].includes(entry.type));
  if (unreportedTerminal) return { kind: 'unreported-terminal-trace', passed: false };
  if (!firstIsValid || first.type !== 'session.created') {
    return { kind: 'unknown', passed: false };
  }
  const lifecycleBudget = raw?.lifecycleBudget;
  if (!Number.isSafeInteger(lifecycleBudget?.firstServerEventLatencyMs)
    || lifecycleBudget.firstServerEventLatencyMs !== REALTIME_LATENCY_BUDGET_MS
    || !Number.isSafeInteger(lifecycleBudget?.socketEventTimeoutMs)
    || lifecycleBudget.socketEventTimeoutMs !== SOCKET_EVENT_TIMEOUT_MS
    || !Number.isSafeInteger(raw?.latencyBudgetMs)
    || raw.latencyBudgetMs !== REALTIME_LATENCY_BUDGET_MS) {
    return { kind: 'invalid-lifecycle-budget', passed: false };
  }
  if (!Number.isSafeInteger(raw?.firstServerEventLatencyMs)
    || !Number.isSafeInteger(raw?.measuredLatencyMs)
    || raw.firstServerEventLatencyMs !== first.monotonicMs
    || raw.measuredLatencyMs !== first.monotonicMs) {
    return { kind: 'invalid-latency-evidence', passed: false };
  }
  if (first.monotonicMs > SOCKET_EVENT_TIMEOUT_MS) {
    return { kind: 'first-server-event-timeout', passed: false };
  }
  const lifecycle = validateLivetranslateLifecycle(raw, trace);
  if (!lifecycle.valid) return { kind: lifecycle.reason, passed: false };
  if (raw.productionMode !== true) {
    return { kind: 'non-production-lifecycle', passed: false };
  }
  if (first.monotonicMs > REALTIME_LATENCY_BUDGET_MS) {
    return { kind: 'latency-budget-exceeded', passed: false };
  }
  return { kind: 'livetranslate-session-finished', passed: true };
}

function successfulLivetranslateTrace() {
  return [
    {
      monotonicMs: 0,
      direction: 'transport',
      type: 'websocket.upgrade',
      status: 101,
      rawRedactedPayload: OFFICIAL_UPGRADE_REQUEST_AUTHORITY_RAW,
      sha256: sha256(OFFICIAL_UPGRADE_REQUEST_AUTHORITY_RAW),
    },
    {
      monotonicMs: 606,
      direction: 'server-to-client',
      type: 'session.created',
      rawRedactedPayload: OFFICIAL_SESSION_CREATED_RAW,
      sha256: sha256(OFFICIAL_SESSION_CREATED_RAW),
    },
    {
      monotonicMs: 607,
      direction: 'client-to-server',
      type: 'session.update',
      rawRedactedPayload: OFFICIAL_SESSION_UPDATE_RAW,
      sha256: sha256(OFFICIAL_SESSION_UPDATE_RAW),
    },
    {
      monotonicMs: 620,
      direction: 'server-to-client',
      type: 'session.updated',
      rawRedactedPayload: OFFICIAL_SESSION_UPDATED_RAW,
      sha256: sha256(OFFICIAL_SESSION_UPDATED_RAW),
    },
    {
      monotonicMs: 621,
      direction: 'client-to-server',
      type: 'session.finish',
      rawRedactedPayload: OFFICIAL_SESSION_FINISH_RAW,
      sha256: sha256(OFFICIAL_SESSION_FINISH_RAW),
    },
    {
      monotonicMs: 650,
      direction: 'server-to-client',
      type: 'session.finished',
      rawRedactedPayload: OFFICIAL_SESSION_FINISHED_RAW,
      sha256: sha256(OFFICIAL_SESSION_FINISHED_RAW),
    },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

function successfulLivetranslateRaw() {
  return {
    firstServerEvent: { type: 'session.created', monotonicMs: 606 },
    firstServerEventLatencyMs: 606,
    measuredLatencyMs: 606,
    latencyBudgetMs: REALTIME_LATENCY_BUDGET_MS,
    lifecycleBudget: {
      firstServerEventLatencyMs: REALTIME_LATENCY_BUDGET_MS,
      socketEventTimeoutMs: SOCKET_EVENT_TIMEOUT_MS,
    },
    evidenceOutcome: 'livetranslate-session-finished',
    productionMode: true,
    providerInputMode: 'none',
    responseMode: 'text-only',
    sessionAuthority: {
      sessionIdentitySha256: SESSION_IDENTITY_SHA256,
      serverModel: DASH_SCOPE_MODEL,
      echoedSessionConfigSha256: OFFICIAL_SESSION_ECHO_SHA256,
    },
    providerInvocationCount: 1,
    connectionCount: 1,
    externalAudioSamples: 0,
    inputAudioBufferCommitCount: 0,
    conversationItemCreateInputTextCount: 0,
    responseCreateCount: 0,
  };
}

function terminalTraceEntry(raw) {
  if (raw.providerErrorFrame) {
    return {
      monotonicMs: raw.providerErrorFrame.monotonicMs,
      direction: 'server-to-client',
      type: 'error',
      rawRedactedPayload: raw.providerErrorFrame.rawRedactedPayload,
    };
  }
  if (raw.websocketClose) {
    return {
      monotonicMs: raw.websocketClose.monotonicMs,
      direction: 'server-to-client',
      type: 'websocket.close',
      code: raw.websocketClose.code,
      reason: raw.websocketClose.reason,
      normal: raw.websocketClose.normal,
    };
  }
  if (raw.timeoutPhase) {
    const startedMonotonicMs = raw.timeoutPhase === 'response-completion' ? 607 : 0;
    const deadlineMonotonicMs = startedMonotonicMs + raw.timeoutBudgetMs;
    return {
      monotonicMs: deadlineMonotonicMs,
      direction: 'local',
      type: {
        connect: 'connect.timeout',
        'websocket-upgrade': 'websocket.upgrade.timeout',
        'read-first-event': 'read.timeout',
        'response-completion': 'read.timeout',
      }[raw.timeoutPhase],
      timeoutPhase: raw.timeoutPhase,
      startedMonotonicMs,
      deadlineMonotonicMs,
    };
  }
  throw new Error('test terminal evidence is missing');
}

function verifyRawTrace(outputDirectory, authority) {
  assert.equal(authority?.path, RAW_TRACE_RELATIVE_PATH);
  const root = path.resolve(outputDirectory);
  const tracePath = path.resolve(root, authority.path);
  assert.equal(path.dirname(path.dirname(tracePath)), root);
  const stat = fs.lstatSync(tracePath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  const bytes = fs.readFileSync(tracePath);
  assert.equal(authority.bytes, bytes.byteLength);
  assert.equal(authority.sha256, sha256(bytes));
  assert.equal(
    authority.eventCount,
    bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).length,
  );
}

function managedScenario({
  rawProbeResult,
  emitter = { status: 'completed' },
  trace,
  childPid = 4545,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-wire-evidence-'));
  const executablePath = path.join(root, 'desktop.exe');
  fs.writeFileSync(executablePath, 'test-executable');
  const outputDirectory = path.join(root, 'evidence');
  const child = fakeChild(childPid);
  let authority;
  setTimeout(() => {
    authority = publishProbeEvidence(outputDirectory, { emitter, rawProbeResult, trace });
    child.emit('exit', 0);
  }, 5);
  return {
    child,
    outputDirectory,
    get authority() { return authority; },
    promise: runManagedProviderPreflight({
      executablePath,
      outputDirectory,
      environment: {},
      executionId: 'watch-wire-evidence-test',
      providerId: 'provider-dashscope',
      spawnProcess: () => child,
      querySnapshot: () => ({
        exists: true,
        pid: child.pid,
        parentPid: 1,
        imagePath: executablePath,
        startedAt: '2026-08-30T00:00:00.000Z',
      }),
      emitterTimeoutMs: 1_000,
      exitGraceMs: 1,
    }),
  };
}

test('terminal emitter failure remains primary when graceful cleanup fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-process-'));
  const executablePath = path.join(root, 'desktop.exe');
  fs.writeFileSync(executablePath, 'test-executable');
  const outputDirectory = path.join(root, 'evidence');
  const child = fakeChild();
  setTimeout(() => publishEmitter(
    outputDirectory,
    { status: 'failed', error: 'latency 1218ms exceeds 1200ms' },
  ), 5);
  await assert.rejects(
    runManagedProviderPreflight({
      executablePath,
      outputDirectory,
      environment: {},
      executionId: 'watch-test-execution',
      providerId: 'dashscope',
      spawnProcess: () => child,
      querySnapshot: () => ({ exists: true, pid: child.pid, parentPid: 1, imagePath: executablePath, startedAt: '2026-08-28T00:00:00.000Z' }),
      closeOwnedProcess: () => { throw new Error('close failed'); },
      forceOwnedProcess: () => { child.emit('exit', 1); return { status: 'forced', forced: true }; },
      exitGraceMs: 1,
      closeGraceMs: 1,
      emitterTimeoutMs: 1000,
    }),
    (error) => {
      assert.match(error.message, /latency 1218ms exceeds 1200ms/);
      assert.deepEqual(error.failure.cleanupErrors, ['close failed']);
      assert.equal(error.failure.termination.forced, true);
      assert.ok(fs.existsSync(error.failurePath));
      return true;
    },
  );
});

test('completed emitter settles after the owned process exits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-process-'));
  const executablePath = path.join(root, 'desktop.exe');
  fs.writeFileSync(executablePath, 'test-executable');
  const outputDirectory = path.join(root, 'evidence');
  const child = fakeChild(4343);
  setTimeout(() => {
    publishEmitter(outputDirectory, { status: 'completed' });
    child.emit('exit', 0);
  }, 5);
  const result = await runManagedProviderPreflight({
    executablePath,
    outputDirectory,
    environment: {},
    executionId: 'watch-test-success',
    providerId: 'dashscope',
    spawnProcess: () => child,
    querySnapshot: () => ({ exists: true, pid: child.pid, parentPid: 1, imagePath: executablePath, startedAt: '2026-08-28T00:00:00.000Z' }),
    emitterTimeoutMs: 1000,
    exitGraceMs: 1,
  });
  assert.equal(result.emitter.status, 'completed');
  assert.equal(result.termination.exited, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test('completed emitter with an uncleanable owned process writes a terminal failure artifact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-cleanup-'));
  const executablePath = path.join(root, 'desktop.exe');
  fs.writeFileSync(executablePath, 'test-executable');
  const outputDirectory = path.join(root, 'evidence');
  const child = fakeChild(4444);
  setTimeout(() => publishEmitter(outputDirectory, { status: 'completed' }), 5);
  await assert.rejects(runManagedProviderPreflight({
    executablePath,
    outputDirectory,
    environment: {},
    executionId: 'watch-test-cleanup-failure',
    providerId: 'dashscope',
    spawnProcess: () => child,
    querySnapshot: () => ({ exists: true, pid: child.pid, parentPid: 1, imagePath: executablePath, startedAt: '2026-08-28T00:00:00.000Z' }),
    closeOwnedProcess: () => { throw new Error('close denied'); },
    forceOwnedProcess: () => { throw new Error('identity changed'); },
    emitterTimeoutMs: 1000,
    exitGraceMs: 1,
    closeGraceMs: 1,
    cleanupTimeoutMs: 1,
  }), (error) => {
    assert.equal(error.failure.stableErrorCode, 'provider.preflight.cleanup-failed');
    assert.equal(error.failure.primaryError.code, 'provider.preflight.cleanup-failed');
    assert.deepEqual(error.failure.cleanupErrors, ['close denied', 'identity changed']);
    assert.ok(fs.existsSync(error.failurePath));
    return true;
  });
});

test('runner reserves only the parent and rejects a pre-existing final evidence directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-existing-'));
  const executablePath = path.join(root, 'desktop.exe');
  fs.writeFileSync(executablePath, 'test-executable');
  const outputDirectory = path.join(root, 'evidence');
  fs.mkdirSync(outputDirectory);
  await assert.rejects(
    runManagedProviderPreflight({ executablePath, outputDirectory }),
    /output directory already exists/,
  );
});

test('formal preflight request identity matches the Beijing minimal-probe control', () => {
  const authoritySource = fs.readFileSync(
    path.join(import.meta.dirname, '../../apps/desktop/src-tauri/src/release_evidence_diagnostic/provider_preflight_authority.rs'),
    'utf8',
  );
  const transportSource = fs.readFileSync(
    path.join(import.meta.dirname, '../../apps/desktop/src-tauri/src/provider/gateway_parts/transport.rs'),
    'utf8',
  );
  const authSource = fs.readFileSync(
    path.join(import.meta.dirname, '../../apps/desktop/src-tauri/src/provider/gateway_parts/auth.rs'),
    'utf8',
  );
  assert.match(authoritySource, /PROVIDER_ENDPOINT_HOST:\s*&str\s*=\s*"dashscope\.aliyuncs\.com"/u);
  assert.match(authoritySource, /PREFLIGHT_MODEL:\s*&str\s*=\s*"qwen3\.5-livetranslate-flash-realtime"/u);
  assert.match(authoritySource, /provider\.timeout_ms\s*!=\s*12_000/u);
  assert.match(transportSource, /url\.set_path\(&profile\.endpoint_path\)/u);
  assert.match(transportSource, /match profile\.model_placement\.as_str\(\)/u);
  assert.match(transportSource, /"query"\s*=>[\s\S]*query\.append_pair\("model",\s*model\)/u);
  assert.match(authSource, /"bearer"\s*=>\s*format!\("Bearer \{secret\}"\)/u);
  assert.doesNotMatch(
    `${authoritySource}\n${transportSource}\n${authSource}`,
    /workspace[-_ ]?id|x-dashscope-workspace/iu,
    'the supported endpoint must not acquire an unproven WorkspaceId requirement',
  );

  const control = new URL('https://dashscope.aliyuncs.com/api/v1');
  control.protocol = 'wss:';
  control.pathname = '/api-ws/v1/realtime';
  control.search = new URLSearchParams({ model: DASH_SCOPE_MODEL }).toString();
  assert.equal(
    control.href,
    'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime',
  );
});

test('session.created within 12 seconds is preserved but cannot alone complete LiveTranslate preflight', async () => {
  const rawProbeResult = {
    ...successfulLivetranslateRaw(),
    evidenceOutcome: 'incomplete-livetranslate-lifecycle',
  };
  const trace = parseRawTrace(successfulLivetranslateTrace())
    .slice(0, 2)
    .map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
    kind: 'incomplete-livetranslate-lifecycle',
    passed: false,
  });
  const scenario = managedScenario({ rawProbeResult, trace });

  await assert.rejects(scenario.promise, (error) => {
    assert.equal(error.failure.stableErrorCode, 'provider.preflight.protocol-incomplete');
    assert.equal(error.failure.evidenceOutcome, 'incomplete-livetranslate-lifecycle');
    assert.deepEqual(error.failure.firstServerEvent, rawProbeResult.firstServerEvent);
    assert.deepEqual(error.failure.rawTrace, scenario.authority);
    verifyRawTrace(scenario.outputDirectory, error.failure.rawTrace);
    return true;
  });
});

test('formal LiveTranslate success proves the complete ordered text-only lifecycle', async () => {
  const rawProbeResult = successfulLivetranslateRaw();
  const trace = successfulLivetranslateTrace();
  const entries = parseRawTrace(trace);
  assert.equal(entries.length, 6);
  assert.equal(entries.every((entry) => !Object.hasOwn(entry, 'summary')), true);
  assert.equal(Object.hasOwn(rawProbeResult, 'inputMode'), false);
  assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
    kind: 'livetranslate-session-finished',
    passed: true,
  });
  const scenario = managedScenario({ rawProbeResult, trace });
  const result = await scenario.promise;

  assert.equal(result.fields.evidenceOutcome, 'livetranslate-session-finished');
  assert.deepEqual(result.fields.firstServerEvent, rawProbeResult.firstServerEvent);
  assert.equal(result.fields.providerInputMode, 'none');
  assert.equal(result.fields.responseMode, 'text-only');
  assert.equal(result.fields.productionMode, true);
  assert.deepEqual(result.fields.lifecycleBudget, {
    firstServerEventLatencyMs: REALTIME_LATENCY_BUDGET_MS,
    socketEventTimeoutMs: SOCKET_EVENT_TIMEOUT_MS,
  });
  assert.equal(result.fields.measuredLatencyMs, 606);
  assert.equal(result.fields.latencyBudgetMs, REALTIME_LATENCY_BUDGET_MS);
  assert.equal(result.fields.providerInvocationCount, 1);
  assert.equal(result.fields.connectionCount, 1);
  assert.equal(result.fields.externalAudioSamples, 0);
  assert.equal(result.fields.inputAudioBufferCommitCount, 0);
  assert.equal(result.fields.conversationItemCreateInputTextCount, 0);
  assert.equal(result.fields.responseCreateCount, 0);
  assert.deepEqual(result.fields.rawTrace, scenario.authority);
  verifyRawTrace(scenario.outputDirectory, result.fields.rawTrace);
});

test('formal LiveTranslate rejects a session.finished envelope with a mismatched payload', async () => {
  const trace = mutatePayloadTrace('session.finished', (payload) => {
    payload.type = 'session.updated';
  });
  const rawProbeResult = {
    ...successfulLivetranslateRaw(),
    evidenceOutcome: 'session-finished-payload-invalid',
  };
  assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
    kind: 'session-finished-payload-invalid',
    passed: false,
  });
  const scenario = managedScenario({ rawProbeResult, trace });
  await assert.rejects(scenario.promise, (error) => {
    assert.equal(error.failure.stableErrorCode, 'provider.preflight.server-authority-invalid');
    assert.equal(error.failure.evidenceOutcome, 'session-finished-payload-invalid');
    return true;
  });
});

for (const invalidUpgrade of [
  {
    name: 'non-Beijing authority',
    trace() {
      return mutatePayloadTrace('websocket.upgrade', (payload) => {
        payload.host = 'dashscope-intl.aliyuncs.com';
      });
    },
  },
  {
    name: 'wrong realtime path or model query',
    trace() {
      return mutatePayloadTrace('websocket.upgrade', (payload) => {
        payload.path = '/api-ws/v1/inference';
        payload.query.model = 'qwen-wrong-model';
      });
    },
  },
  {
    name: 'request header value or secret',
    trace() {
      return mutatePayloadTrace('websocket.upgrade', (payload) => {
        payload.requestHeaders = { authorization: 'Bearer secret-must-not-be-recorded' };
      });
    },
  },
  {
    name: 'raw byte digest mismatch',
    trace() {
      const entries = parseRawTrace(successfulLivetranslateTrace());
      entries.find((entry) => entry.type === 'websocket.upgrade').sha256 = 'a'.repeat(64);
      return serializeRawTrace(entries);
    },
  },
]) {
  test(`websocket.upgrade request authority rejects ${invalidUpgrade.name}`, async () => {
    const trace = invalidUpgrade.trace();
    const rawProbeResult = {
      ...successfulLivetranslateRaw(),
      evidenceOutcome: 'upgrade-request-authority-invalid',
    };
    assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
      kind: 'upgrade-request-authority-invalid',
      passed: false,
    });
    const scenario = managedScenario({ rawProbeResult, trace });

    await assert.rejects(scenario.promise, (error) => {
      assert.equal(error.failure.stableErrorCode, 'provider.preflight.request-authority-invalid');
      assert.equal(error.failure.evidenceOutcome, 'upgrade-request-authority-invalid');
      return true;
    });
  });
}

for (const invalidAuthority of [
  {
    name: 'providerInputMode text-only',
    mutate(raw) { raw.providerInputMode = 'text-only'; },
  },
  {
    name: 'legacy raw inputMode standing in for providerInputMode',
    mutate(raw) {
      delete raw.providerInputMode;
      raw.inputMode = 'text-only';
    },
  },
  {
    name: 'responseMode none',
    mutate(raw) { raw.responseMode = 'none'; },
  },
]) {
  test(`formal preflight rejects ${invalidAuthority.name}`, async () => {
    const rawProbeResult = successfulLivetranslateRaw();
    invalidAuthority.mutate(rawProbeResult);
    rawProbeResult.evidenceOutcome = 'invalid-livetranslate-call-authority';
    const trace = successfulLivetranslateTrace();
    assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
      kind: 'invalid-livetranslate-call-authority',
      passed: false,
    });
    const scenario = managedScenario({ rawProbeResult, trace });

    await assert.rejects(scenario.promise, (error) => {
      assert.equal(error.failure.stableErrorCode, 'provider.preflight.invalid-call-authority');
      assert.equal(error.failure.evidenceOutcome, 'invalid-livetranslate-call-authority');
      return true;
    });
  });
}

for (const invalidBudget of [
  { name: 'string first-event budget', field: 'firstServerEventLatencyMs', value: '1200' },
  { name: 'fractional first-event budget', field: 'firstServerEventLatencyMs', value: 1_200.5 },
  { name: 'relaxed first-event budget', field: 'firstServerEventLatencyMs', value: 1_201 },
  { name: 'string socket-event budget', field: 'socketEventTimeoutMs', value: '12000' },
  { name: 'relaxed socket-event budget', field: 'socketEventTimeoutMs', value: 12_001 },
]) {
  test(`formal preflight rejects ${invalidBudget.name}`, async () => {
    const rawProbeResult = successfulLivetranslateRaw();
    rawProbeResult.lifecycleBudget[invalidBudget.field] = invalidBudget.value;
    rawProbeResult.evidenceOutcome = 'invalid-lifecycle-budget';
    const trace = successfulLivetranslateTrace();
    assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
      kind: 'invalid-lifecycle-budget',
      passed: false,
    });
    const scenario = managedScenario({ rawProbeResult, trace });

    await assert.rejects(scenario.promise, (error) => {
      assert.equal(error.failure.stableErrorCode, 'provider.preflight.invalid-lifecycle-budget');
      assert.equal(error.failure.evidenceOutcome, 'invalid-lifecycle-budget');
      return true;
    });
  });
}

test('a production LiveTranslate lifecycle at 1201ms is latency-budget-exceeded, not available', async () => {
  const entries = parseRawTrace(successfulLivetranslateTrace());
  for (let index = 1; index < entries.length; index += 1) {
    entries[index].monotonicMs = REALTIME_LATENCY_BUDGET_MS + index;
  }
  const trace = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  const rawProbeResult = {
    ...successfulLivetranslateRaw(),
    firstServerEvent: { type: 'session.created', monotonicMs: 1_201 },
    firstServerEventLatencyMs: 1_201,
    measuredLatencyMs: 1_201,
    evidenceOutcome: 'latency-budget-exceeded',
  };
  assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
    kind: 'latency-budget-exceeded',
    passed: false,
  });
  const scenario = managedScenario({ rawProbeResult, trace });

  await assert.rejects(scenario.promise, (error) => {
    assert.equal(error.failure.stableErrorCode, 'provider.preflight.latency-budget-exceeded');
    assert.equal(error.failure.evidenceOutcome, 'latency-budget-exceeded');
    assert.equal(error.failure.firstServerEvent.monotonicMs, 1_201);
    assert.equal(error.failure.measuredLatencyMs, 1_201);
    return true;
  });
});

test('an out-of-order LiveTranslate lifecycle is rejected even when all six events exist', async () => {
  const entries = parseRawTrace(successfulLivetranslateTrace());
  [entries[1], entries[2]] = [entries[2], entries[1]];
  entries[1].monotonicMs = 605;
  entries[2].monotonicMs = 606;
  const trace = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  const rawProbeResult = {
    ...successfulLivetranslateRaw(),
    evidenceOutcome: 'invalid-livetranslate-order',
  };
  assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
    kind: 'invalid-livetranslate-order',
    passed: false,
  });
  const scenario = managedScenario({ rawProbeResult, trace });

  await assert.rejects(scenario.promise, (error) => {
    assert.equal(error.failure.stableErrorCode, 'provider.preflight.protocol-order-invalid');
    assert.equal(error.failure.evidenceOutcome, 'invalid-livetranslate-order');
    return true;
  });
});

for (const invalidUpdate of [
  {
    name: 'locale-shaped source language zh-CN',
    mutate(payload) { payload.session.input_audio_transcription.language = 'zh-CN'; },
  },
  {
    name: 'wrong ASR model',
    mutate(payload) { payload.session.input_audio_transcription.model = 'qwen3-asr-wrong'; },
  },
  {
    name: 'missing ASR model',
    mutate(payload) { delete payload.session.input_audio_transcription.model; },
  },
  {
    name: 'missing turn detection',
    mutate(payload) { delete payload.session.turn_detection; },
  },
  {
    name: 'locale-shaped target language en-US',
    mutate(payload) { payload.session.translation.language = 'en-US'; },
  },
  {
    name: 'instructions field',
    mutate(payload) { payload.session.instructions = 'probe'; },
  },
  {
    name: 'output_audio_format field',
    mutate(payload) { payload.session.output_audio_format = 'pcm'; },
  },
  {
    name: 'missing sample_rate',
    mutate(payload) { delete payload.session.sample_rate; },
  },
]) {
  test(`session.update raw payload rejects ${invalidUpdate.name}`, async () => {
    const trace = mutatePayloadTrace('session.update', invalidUpdate.mutate);
    const rawProbeResult = {
      ...successfulLivetranslateRaw(),
      evidenceOutcome: 'session-update-payload-invalid',
    };
    assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
      kind: 'session-update-payload-invalid',
      passed: false,
    });
    const scenario = managedScenario({ rawProbeResult, trace });

    await assert.rejects(scenario.promise, (error) => {
      assert.equal(error.failure.stableErrorCode, 'provider.preflight.client-payload-invalid');
      assert.equal(error.failure.evidenceOutcome, 'session-update-payload-invalid');
      return true;
    });
  });
}

test('session.update digest is computed from the exact raw payload bytes', async () => {
  const entries = parseRawTrace(successfulLivetranslateTrace());
  const update = entries.find((entry) => entry.type === 'session.update');
  update.sha256 = '0'.repeat(64);
  const trace = serializeRawTrace(entries);
  const rawProbeResult = {
    ...successfulLivetranslateRaw(),
    evidenceOutcome: 'session-update-payload-invalid',
  };
  assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
    kind: 'session-update-payload-invalid',
    passed: false,
  });
  const scenario = managedScenario({ rawProbeResult, trace });

  await assert.rejects(scenario.promise, (error) => {
    assert.equal(error.failure.stableErrorCode, 'provider.preflight.client-payload-invalid');
    return true;
  });
});

for (const invalidFinish of [
  {
    name: 'extra finish field',
    trace() {
      return mutatePayloadTrace('session.finish', (payload) => { payload.session = {}; });
    },
  },
  {
    name: 'reused update event_id',
    trace() {
      return mutatePayloadTrace('session.finish', (payload) => {
        payload.event_id = OFFICIAL_SESSION_UPDATE.event_id;
      });
    },
  },
  {
    name: 'non-evt event_id',
    trace() {
      return mutatePayloadTrace('session.finish', (payload) => { payload.event_id = 'finish-001'; });
    },
  },
  {
    name: 'raw byte digest mismatch',
    trace() {
      const entries = parseRawTrace(successfulLivetranslateTrace());
      entries.find((entry) => entry.type === 'session.finish').sha256 = 'f'.repeat(64);
      return serializeRawTrace(entries);
    },
  },
]) {
  test(`session.finish raw payload rejects ${invalidFinish.name}`, async () => {
    const trace = invalidFinish.trace();
    const rawProbeResult = {
      ...successfulLivetranslateRaw(),
      evidenceOutcome: 'session-finish-payload-invalid',
    };
    assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
      kind: 'session-finish-payload-invalid',
      passed: false,
    });
    const scenario = managedScenario({ rawProbeResult, trace });

    await assert.rejects(scenario.promise, (error) => {
      assert.equal(error.failure.stableErrorCode, 'provider.preflight.client-payload-invalid');
      assert.equal(error.failure.evidenceOutcome, 'session-finish-payload-invalid');
      return true;
    });
  });
}

for (const invalidServerAuthority of [
  {
    name: 'changed session identity in session.updated',
    outcome: 'session-identity-mismatch',
    build() {
      return {
        trace: mutatePayloadTrace('session.updated', (payload) => {
          payload.session.id = sha256('different-session');
        }),
      };
    },
  },
  {
    name: 'wrong server model in session.created',
    outcome: 'server-model-mismatch',
    build() {
      return {
        trace: mutatePayloadTrace('session.created', (payload) => {
          payload.session.model = 'qwen-wrong-model';
        }),
      };
    },
  },
  {
    name: 'non-echoed session configuration',
    outcome: 'session-update-echo-mismatch',
    build() {
      return {
        trace: mutatePayloadTrace('session.updated', (payload) => {
          payload.session.translation.language = 'en-US';
        }),
      };
    },
  },
  {
    name: 'mismatched top-level session authority digest',
    outcome: 'session-identity-mismatch',
    build() {
      return {
        trace: successfulLivetranslateTrace(),
        rawPatch: {
          sessionAuthority: {
            ...successfulLivetranslateRaw().sessionAuthority,
            sessionIdentitySha256: sha256('different-session'),
          },
        },
      };
    },
  },
]) {
  test(`server event authority rejects ${invalidServerAuthority.name}`, async () => {
    const invalid = invalidServerAuthority.build();
    const rawProbeResult = {
      ...successfulLivetranslateRaw(),
      ...invalid.rawPatch,
      evidenceOutcome: invalidServerAuthority.outcome,
    };
    assert.deepEqual(classifyWireEvidence(rawProbeResult, invalid.trace), {
      kind: invalidServerAuthority.outcome,
      passed: false,
    });
    const scenario = managedScenario({ rawProbeResult, trace: invalid.trace });

    await assert.rejects(scenario.promise, (error) => {
      assert.equal(error.failure.stableErrorCode, 'provider.preflight.server-authority-invalid');
      assert.equal(error.failure.evidenceOutcome, invalidServerAuthority.outcome);
      return true;
    });
  });
}

for (const forbidden of [
  {
    name: 'input_audio_buffer.append',
    traceEntry: { type: 'input_audio_buffer.append', audioSamples: 320 },
    rawPatch: { externalAudioSamples: 320 },
  },
  {
    name: 'input_audio_buffer.commit',
    traceEntry: { type: 'input_audio_buffer.commit' },
    rawPatch: { inputAudioBufferCommitCount: 1 },
  },
  {
    name: 'conversation.item.create/input_text',
    traceEntry: { type: 'conversation.item.create', contentType: 'input_text' },
    rawPatch: { conversationItemCreateInputTextCount: 1 },
  },
  {
    name: 'response.create',
    traceEntry: { type: 'response.create' },
    rawPatch: { responseCreateCount: 1 },
  },
]) {
  test(`LiveTranslate text preflight rejects forbidden client event ${forbidden.name}`, async () => {
    const entries = parseRawTrace(successfulLivetranslateTrace());
    entries.splice(4, 0, {
      monotonicMs: 620,
      direction: 'client-to-server',
      ...forbidden.traceEntry,
    });
    const trace = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    const rawProbeResult = {
      ...successfulLivetranslateRaw(),
      ...forbidden.rawPatch,
      evidenceOutcome: 'forbidden-livetranslate-input',
    };
    assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
      kind: 'forbidden-livetranslate-input',
      passed: false,
    });
    const scenario = managedScenario({ rawProbeResult, trace });

    await assert.rejects(scenario.promise, (error) => {
      assert.equal(error.failure.stableErrorCode, 'provider.preflight.forbidden-client-event');
      assert.equal(error.failure.evidenceOutcome, 'forbidden-livetranslate-input');
      return true;
    });
  });
}

for (const terminal of [
  {
    name: 'provider error frame',
    outcome: 'provider-error-frame',
    rawPatch: (() => {
      const rawRedactedPayload = '{"type":"error","error":{"code":"ServerError","message":"[REDACTED]"}}';
      return {
        providerErrorFrame: {
          type: 'error',
          providerCode: 'ServerError',
          rawRedactedPayload,
          sha256: sha256(rawRedactedPayload),
          monotonicMs: 651,
        },
      };
    })(),
  },
  {
    name: 'normal close',
    outcome: 'websocket-close-normal',
    rawPatch: {
      websocketClose: { code: 1_000, reason: 'normal shutdown', normal: true, monotonicMs: 651 },
    },
  },
  {
    name: 'abnormal close',
    outcome: 'websocket-close-abnormal',
    rawPatch: {
      websocketClose: { code: 1_011, reason: 'server error', normal: false, monotonicMs: 651 },
    },
  },
  {
    name: 'response completion timeout',
    outcome: 'timeout:response-completion',
    rawPatch: {
      timeoutPhase: 'response-completion',
      timeoutBudgetMs: SOCKET_EVENT_TIMEOUT_MS,
    },
  },
]) {
  test(`raw ${terminal.name} fails closed even beside an otherwise complete lifecycle`, async () => {
    const rawProbeResult = {
      ...successfulLivetranslateRaw(),
      ...terminal.rawPatch,
      evidenceOutcome: terminal.outcome,
    };
    const entries = parseRawTrace(successfulLivetranslateTrace());
    const terminalEntry = terminalTraceEntry(rawProbeResult);
    assert.equal(Object.hasOwn(terminalEntry, 'summary'), false);
    entries.push(terminalEntry);
    const trace = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
      kind: terminal.outcome,
      passed: false,
    });
    const scenario = managedScenario({ rawProbeResult, trace });

    await assert.rejects(scenario.promise, (error) => {
      assert.equal(error.failure.evidenceOutcome, terminal.outcome);
      return true;
    });
  });
}

for (const unreported of [
  {
    name: 'error frame',
    outcome: 'unreported-terminal-trace',
    stableErrorCode: 'provider.preflight.unreported-terminal-trace',
    entry: {
      monotonicMs: 651,
      direction: 'server-to-client',
      type: 'error',
      rawRedactedPayload: '{"type":"error","error":{"code":"ServerError"}}',
    },
  },
  {
    name: 'WebSocket close',
    outcome: 'unreported-terminal-trace',
    stableErrorCode: 'provider.preflight.unreported-terminal-trace',
    entry: {
      monotonicMs: 651,
      direction: 'server-to-client',
      type: 'websocket.close',
      code: 1_011,
      reason: 'upstream error',
      normal: false,
    },
  },
  {
    name: 'read timeout',
    outcome: 'unreported-terminal-trace',
    stableErrorCode: 'provider.preflight.unreported-terminal-trace',
    entry: {
      monotonicMs: 12_607,
      direction: 'local',
      type: 'read.timeout',
      timeoutPhase: 'response-completion',
      startedMonotonicMs: 607,
      deadlineMonotonicMs: 12_607,
    },
  },
  {
    name: 'unknown server event',
    outcome: 'unexpected-livetranslate-trace-event',
    stableErrorCode: 'provider.preflight.unexpected-trace-event',
    entry: {
      monotonicMs: 651,
      direction: 'server-to-client',
      type: 'mystery.server.event',
    },
  },
]) {
  test(`complete lifecycle fails closed for an extra ${unreported.name} without a summary`, async () => {
    assert.equal(Object.hasOwn(unreported.entry, 'summary'), false);
    const entries = parseRawTrace(successfulLivetranslateTrace());
    entries.push(unreported.entry);
    const trace = serializeRawTrace(entries);
    const rawProbeResult = {
      ...successfulLivetranslateRaw(),
      evidenceOutcome: unreported.outcome,
    };
    assert.equal(Object.hasOwn(rawProbeResult, 'providerErrorFrame'), false);
    assert.equal(Object.hasOwn(rawProbeResult, 'websocketClose'), false);
    assert.equal(Object.hasOwn(rawProbeResult, 'timeoutPhase'), false);
    assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
      kind: unreported.outcome,
      passed: false,
    });
    const scenario = managedScenario({ rawProbeResult, trace });

    await assert.rejects(scenario.promise, (error) => {
      assert.equal(error.failure.stableErrorCode, unreported.stableErrorCode);
      assert.equal(error.failure.evidenceOutcome, unreported.outcome);
      return true;
    });
  });
}

test('a provider error frame keeps its redacted raw payload and digest', async () => {
  const rawRedactedPayload = '{"type":"error","error":{"code":"InvalidApiKey","message":"[REDACTED]"}}';
  const rawProbeResult = {
    providerErrorFrame: {
      type: 'error',
      providerCode: 'InvalidApiKey',
      rawRedactedPayload,
      sha256: sha256(rawRedactedPayload),
      monotonicMs: 41,
    },
    evidenceOutcome: 'provider-error-frame',
  };
  const trace = `${JSON.stringify({
    monotonicMs: 41,
    direction: 'server-to-client',
    type: 'error',
    rawRedactedPayload,
  })}\n`;
  assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
    kind: 'provider-error-frame',
    passed: false,
  });
  const scenario = managedScenario({
    rawProbeResult,
    emitter: { status: 'failed', error: 'provider error frame code=InvalidApiKey' },
    trace,
  });

  await assert.rejects(scenario.promise, (error) => {
    assert.equal(error.failure.evidenceOutcome, 'provider-error-frame');
    assert.deepEqual(error.failure.providerErrorFrame, rawProbeResult.providerErrorFrame);
    assert.deepEqual(error.failure.rawTrace, scenario.authority);
    verifyRawTrace(scenario.outputDirectory, error.failure.rawTrace);
    return true;
  });
});

for (const close of [
  { code: 1_000, reason: 'normal shutdown', normal: true },
  { code: 1_011, reason: 'upstream internal error', normal: false },
]) {
  test(`WebSocket close code ${close.code} remains a concrete ${close.normal ? 'normal' : 'abnormal'} terminal`, async () => {
    const rawProbeResult = {
      websocketClose: { ...close, monotonicMs: 73 },
      evidenceOutcome: close.normal ? 'websocket-close-normal' : 'websocket-close-abnormal',
    };
    const trace = `${JSON.stringify({
      monotonicMs: 73,
      direction: 'server-to-client',
      type: 'websocket.close',
      ...close,
    })}\n`;
    assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
      kind: rawProbeResult.evidenceOutcome,
      passed: false,
    });
    const scenario = managedScenario({
      rawProbeResult,
      emitter: { status: 'failed', error: `websocket close code=${close.code} reason=${close.reason}` },
      trace,
    });

    await assert.rejects(scenario.promise, (error) => {
      assert.equal(error.failure.evidenceOutcome, rawProbeResult.evidenceOutcome);
      assert.deepEqual(error.failure.websocketClose, rawProbeResult.websocketClose);
      assert.match(error.failure.primaryError.message, new RegExp(`code=${close.code}`, 'u'));
      return true;
    });
  });
}

for (const timeout of [
  {
    phase: 'connect',
    stableErrorCode: 'provider.preflight.connect-timeout',
  },
  {
    phase: 'websocket-upgrade',
    stableErrorCode: 'provider.preflight.websocket-upgrade-timeout',
  },
]) {
  test(`${timeout.phase} timeout preserves its absolute 12-second window`, async () => {
    const rawProbeResult = {
      timeoutPhase: timeout.phase,
      timeoutBudgetMs: SOCKET_EVENT_TIMEOUT_MS,
      evidenceOutcome: `timeout:${timeout.phase}`,
    };
    const entry = terminalTraceEntry(rawProbeResult);
    assert.equal(entry.startedMonotonicMs, 0);
    assert.equal(entry.deadlineMonotonicMs, SOCKET_EVENT_TIMEOUT_MS);
    assert.equal(entry.monotonicMs >= entry.deadlineMonotonicMs, true);
    assert.equal(Object.hasOwn(entry, 'summary'), false);
    const trace = serializeRawTrace([entry]);
    assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
      kind: `timeout:${timeout.phase}`,
      passed: false,
    });
    const scenario = managedScenario({ rawProbeResult, trace });

    await assert.rejects(scenario.promise, (error) => {
      assert.equal(error.failure.stableErrorCode, timeout.stableErrorCode);
      assert.equal(error.failure.evidenceOutcome, `timeout:${timeout.phase}`);
      assert.equal(error.failure.timeoutPhase, timeout.phase);
      assert.equal(error.failure.timeoutBudgetMs, SOCKET_EVENT_TIMEOUT_MS);
      return true;
    });
  });
}

for (const timeoutPhase of ['read-first-event', 'response-completion']) {
  test(`read timeout records the ${timeoutPhase} phase without changing the 12-second budget`, async () => {
    const firstServerEvent = timeoutPhase === 'response-completion'
      ? { type: 'session.created', monotonicMs: 606 }
      : undefined;
    const rawProbeResult = {
      ...(firstServerEvent ? { firstServerEvent } : {}),
      timeoutPhase,
      timeoutBudgetMs: SOCKET_EVENT_TIMEOUT_MS,
      evidenceOutcome: `timeout:${timeoutPhase}`,
    };
    const entries = timeoutPhase === 'response-completion'
      ? parseRawTrace(successfulLivetranslateTrace()).slice(0, 3)
      : [];
    const terminal = terminalTraceEntry(rawProbeResult);
    const expectedStart = timeoutPhase === 'response-completion' ? 607 : 0;
    assert.equal(Number.isSafeInteger(terminal.startedMonotonicMs), true);
    assert.equal(Number.isSafeInteger(terminal.deadlineMonotonicMs), true);
    assert.equal(Number.isSafeInteger(terminal.monotonicMs), true);
    assert.equal(terminal.startedMonotonicMs, expectedStart);
    assert.equal(
      terminal.deadlineMonotonicMs - terminal.startedMonotonicMs,
      SOCKET_EVENT_TIMEOUT_MS,
    );
    assert.equal(terminal.monotonicMs >= terminal.deadlineMonotonicMs, true);
    entries.push(terminal);
    const trace = serializeRawTrace(entries);
    assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
      kind: `timeout:${timeoutPhase}`,
      passed: false,
    });
    const scenario = managedScenario({
      rawProbeResult,
      emitter: { status: 'failed', error: `timeout phase=${timeoutPhase} after 12000ms` },
      trace,
    });

    await assert.rejects(scenario.promise, (error) => {
      assert.equal(error.failure.evidenceOutcome, `timeout:${timeoutPhase}`);
      assert.equal(error.failure.timeoutPhase, timeoutPhase);
      assert.equal(error.failure.timeoutBudgetMs, SOCKET_EVENT_TIMEOUT_MS);
      assert.deepEqual(error.failure.firstServerEvent, firstServerEvent ?? null);
      return true;
    });
  });
}

for (const invalidWindow of [
  {
    name: 'string start',
    mutate(entry) { entry.startedMonotonicMs = '0'; },
  },
  {
    name: 'short deadline',
    mutate(entry) { entry.deadlineMonotonicMs -= 1; },
  },
  {
    name: 'terminal before deadline',
    mutate(entry) { entry.monotonicMs = entry.deadlineMonotonicMs - 1; },
  },
]) {
  test(`timeout trace rejects ${invalidWindow.name}`, () => {
    const rawProbeResult = {
      timeoutPhase: 'read-first-event',
      timeoutBudgetMs: SOCKET_EVENT_TIMEOUT_MS,
      evidenceOutcome: 'terminal-trace-mismatch',
    };
    const entry = terminalTraceEntry(rawProbeResult);
    invalidWindow.mutate(entry);
    const trace = serializeRawTrace([entry]);
    assert.deepEqual(classifyWireEvidence(rawProbeResult, trace), {
      kind: 'terminal-trace-mismatch',
      passed: false,
    });
  });
}

test('a terminal emitter with no raw first event, error, close, or timeout is rejected as unknown', async () => {
  const rawProbeResult = { evidenceOutcome: 'unknown' };
  assert.deepEqual(classifyWireEvidence(rawProbeResult), { kind: 'unknown', passed: false });
  const scenario = managedScenario({
    rawProbeResult,
    trace: `${JSON.stringify({ monotonicMs: 0, direction: 'connect', type: 'websocket.open' })}\n`,
  });

  await assert.rejects(scenario.promise, (error) => {
    assert.equal(error.failure.stableErrorCode, 'provider.preflight.unknown-terminal-evidence');
    assert.equal(error.failure.evidenceOutcome, 'unknown');
    return true;
  });
});

test('raw WebSocket trace authority is verified before a completed preflight can pass', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-tampered-trace-'));
  const executablePath = path.join(root, 'desktop.exe');
  fs.writeFileSync(executablePath, 'test-executable');
  const outputDirectory = path.join(root, 'evidence');
  const child = fakeChild(4646);
  setTimeout(() => {
    publishProbeEvidence(outputDirectory, {
      rawProbeResult: {
        firstServerEvent: { type: 'session.created', monotonicMs: 606 },
        evidenceOutcome: 'first-server-event',
      },
      trace: `${JSON.stringify({ monotonicMs: 606, type: 'session.created' })}\n`,
    });
    fs.appendFileSync(
      path.join(outputDirectory, RAW_TRACE_RELATIVE_PATH),
      `${JSON.stringify({ monotonicMs: 607, type: 'tampered-after-publication' })}\n`,
      'utf8',
    );
    child.emit('exit', 0);
  }, 5);

  await assert.rejects(runManagedProviderPreflight({
    executablePath,
    outputDirectory,
    environment: {},
    executionId: 'watch-tampered-raw-trace',
    providerId: 'provider-dashscope',
    spawnProcess: () => child,
    querySnapshot: () => ({
      exists: true,
      pid: child.pid,
      parentPid: 1,
      imagePath: executablePath,
      startedAt: '2026-08-30T00:00:00.000Z',
    }),
    emitterTimeoutMs: 1_000,
    exitGraceMs: 1,
  }), /raw WebSocket trace.*(digest|sha256|bytes)/iu);
});

test('cancellation is a concrete process terminal and still owns child cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-cancel-'));
  const executablePath = path.join(root, 'desktop.exe');
  fs.writeFileSync(executablePath, 'test-executable');
  const outputDirectory = path.join(root, 'evidence');
  const child = fakeChild(4747);
  const controller = new AbortController();
  controller.abort(new Error('operator cancelled'));

  await assert.rejects(runManagedProviderPreflight({
    executablePath,
    outputDirectory,
    environment: {},
    executionId: 'watch-cancelled-preflight',
    providerId: 'provider-dashscope',
    signal: controller.signal,
    spawnProcess: () => child,
    querySnapshot: () => ({
      exists: true,
      pid: child.pid,
      parentPid: 1,
      imagePath: executablePath,
      startedAt: '2026-08-30T00:00:00.000Z',
    }),
    closeOwnedProcess: () => {
      child.emit('exit', 0);
      return { status: 'close-requested' };
    },
    exitGraceMs: 1,
    closeGraceMs: 1,
  }), (error) => {
    assert.equal(error.failure.stableErrorCode, 'provider.preflight.interrupted');
    assert.deepEqual(error.failure.processTerminal, {
      kind: 'cancelled',
      reason: 'operator cancelled',
      childExitCode: 0,
    });
    assert.equal(error.failure.termination.exited, true);
    return true;
  });
});

test('child exit before an emitter is not mislabeled as an emitter timeout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-child-exit-'));
  const executablePath = path.join(root, 'desktop.exe');
  fs.writeFileSync(executablePath, 'test-executable');
  const outputDirectory = path.join(root, 'evidence');
  const child = fakeChild(4848);
  setTimeout(() => child.emit('exit', 17), 5);

  await assert.rejects(runManagedProviderPreflight({
    executablePath,
    outputDirectory,
    environment: {},
    executionId: 'watch-child-exit-preflight',
    providerId: 'provider-dashscope',
    spawnProcess: () => child,
    querySnapshot: () => ({
      exists: true,
      pid: child.pid,
      parentPid: 1,
      imagePath: executablePath,
      startedAt: '2026-08-30T00:00:00.000Z',
    }),
    emitterTimeoutMs: 1_000,
    exitGraceMs: 1,
  }), (error) => {
    assert.equal(error.failure.stableErrorCode, 'provider.preflight.child-exit');
    assert.deepEqual(error.failure.processTerminal, {
      kind: 'child-exit',
      childExitCode: 17,
    });
    assert.equal(error.failure.termination.exitCode, 17);
    return true;
  });
});
