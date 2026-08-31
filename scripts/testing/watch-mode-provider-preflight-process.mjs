import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { fileAuthorityEntry } from './watch-mode-evidence-authority.mjs';

export const PROVIDER_PREFLIGHT_EMITTER_TIMEOUT_MS = 300_000;
export const PROVIDER_PREFLIGHT_EXIT_GRACE_MS = 5_000;
export const PROVIDER_PREFLIGHT_CLOSE_GRACE_MS = 3_000;
export const PROVIDER_PREFLIGHT_CLEANUP_TIMEOUT_MS = 10_000;
export const PROVIDER_PREFLIGHT_FAILURE_FILE = 'provider-preflight-failure.json';

const PROVIDER_PREFLIGHT_FIRST_SERVER_EVENT_BUDGET_MS = 12_000;
const PROVIDER_PREFLIGHT_RAW_TRACE_PATH = 'raw/provider-websocket-trace.jsonl';
const PROVIDER_PREFLIGHT_TIMEOUT_PHASES = new Set([
  'connect',
  'websocket-upgrade',
  'read-first-event',
  'response-completion',
]);
const PROVIDER_PREFLIGHT_LIFECYCLE = Object.freeze([
  Object.freeze({ direction: 'transport', type: 'websocket.upgrade' }),
  Object.freeze({ direction: 'server-to-client', type: 'session.created' }),
  Object.freeze({ direction: 'client-to-server', type: 'session.update' }),
  Object.freeze({ direction: 'server-to-client', type: 'session.updated' }),
  Object.freeze({ direction: 'client-to-server', type: 'session.finish' }),
  Object.freeze({ direction: 'server-to-client', type: 'session.finished' }),
]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Value(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function queryProcessSnapshot(pid) {
  const source = String.raw`
$process = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue
if (-not $process) { [pscustomobject]@{ exists = $false } | ConvertTo-Json -Compress; exit 0 }
$managed = Get-Process -Id ${Number(pid)} -ErrorAction Stop
[pscustomobject]@{
  exists = $true
  pid = [int]$process.ProcessId
  parentPid = [int]$process.ParentProcessId
  imagePath = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
  startedAt = $managed.StartTime.ToUniversalTime().ToString('o')
} | ConvertTo-Json -Compress
`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', source,
  ], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  if (result.error || Number(result.status) !== 0) return null;
  try { return JSON.parse(String(result.stdout).trim()); } catch { return null; }
}

function sameProcess(authority, actual) {
  if (!authority?.pid || !actual?.exists || Number(actual.pid) !== Number(authority.pid)) return false;
  const normalize = (value) => path.win32.resolve(String(value ?? '')).toLowerCase();
  return normalize(actual.imagePath) === normalize(authority.imagePath)
    && String(actual.startedAt) === String(authority.startedAt);
}

function requestClose(authority) {
  const payload = Buffer.from(JSON.stringify(authority), 'utf8').toString('base64');
  const source = String.raw`
$authority = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$authority.pid)" -ErrorAction SilentlyContinue
if (-not $process) { [pscustomobject]@{ status = 'already-exited' } | ConvertTo-Json -Compress; exit 0 }
$managed = Get-Process -Id ([int]$authority.pid) -ErrorAction Stop
$actualPath = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
$actualStart = $managed.StartTime.ToUniversalTime().ToString('o')
if ($actualPath -cne [IO.Path]::GetFullPath([string]$authority.imagePath) -or $actualStart -cne [string]$authority.startedAt) { throw 'preflight process identity changed' }
$requested = $managed.CloseMainWindow()
[pscustomobject]@{ status = 'close-requested'; closeMainWindow = [bool]$requested } | ConvertTo-Json -Compress
`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', source,
  ], { encoding: 'utf8', windowsHide: true, timeout: PROVIDER_PREFLIGHT_CLEANUP_TIMEOUT_MS });
  if (result.error || Number(result.status) !== 0) throw new Error(String(result.stderr || result.stdout || result.error?.message).trim());
  return JSON.parse(String(result.stdout).trim());
}

function forceOwnedProcessTree(authority) {
  const actual = queryProcessSnapshot(authority.pid);
  if (!actual?.exists) return { status: 'already-exited', forced: false };
  if (!sameProcess(authority, actual)) throw new Error('refusing to terminate a preflight PID whose identity changed');
  const result = spawnSync('taskkill.exe', ['/PID', String(authority.pid), '/F', '/T'], {
    encoding: 'utf8', windowsHide: true, timeout: PROVIDER_PREFLIGHT_CLEANUP_TIMEOUT_MS,
  });
  if (result.error || ![0, 128].includes(Number(result.status))) {
    throw new Error(String(result.stderr || result.stdout || result.error?.message).trim());
  }
  return { status: 'forced', forced: true, exitCode: Number(result.status) };
}

function parseRawTrace(bytes) {
  try {
    return bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return null;
  }
}

function verifyRawTraceAuthority(outputDirectory, authority) {
  if (
    authority?.path !== PROVIDER_PREFLIGHT_RAW_TRACE_PATH
    || !Number.isSafeInteger(authority?.bytes)
    || authority.bytes < 1
    || !/^[a-f0-9]{64}$/u.test(String(authority?.sha256 ?? ''))
    || !Number.isSafeInteger(authority?.eventCount)
    || authority.eventCount < 1
  ) {
    return { error: 'raw WebSocket trace authority path/bytes/sha256/eventCount is invalid' };
  }
  const root = path.resolve(outputDirectory);
  const tracePath = path.resolve(root, ...PROVIDER_PREFLIGHT_RAW_TRACE_PATH.split('/'));
  if (path.dirname(path.dirname(tracePath)) !== root) {
    return { error: 'raw WebSocket trace path escapes the immutable evidence root' };
  }
  const rawDirectory = path.dirname(tracePath);
  const comparablePath = (value) => (
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  );
  for (const candidate of [root, rawDirectory]) {
    let candidateStats;
    try { candidateStats = fs.lstatSync(candidate); } catch { candidateStats = null; }
    if (!candidateStats?.isDirectory() || candidateStats.isSymbolicLink()) {
      return { error: 'raw WebSocket trace root/intermediate directory is not a real directory' };
    }
    let realCandidate;
    try { realCandidate = fs.realpathSync.native(candidate); } catch { realCandidate = null; }
    if (!realCandidate || comparablePath(realCandidate) !== comparablePath(candidate)) {
      return { error: 'raw WebSocket trace root/intermediate directory contains a reparse redirect' };
    }
  }
  let stats;
  try { stats = fs.lstatSync(tracePath); } catch { stats = null; }
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    return { error: 'raw WebSocket trace must be a regular non-symlink file' };
  }
  const bytes = fs.readFileSync(tracePath);
  if (bytes.byteLength !== authority.bytes) {
    return { error: 'raw WebSocket trace bytes do not match its authority' };
  }
  if (sha256Value(bytes) !== authority.sha256) {
    return { error: 'raw WebSocket trace sha256 digest does not match its authority' };
  }
  const entries = parseRawTrace(bytes);
  if (!entries || entries.length !== authority.eventCount) {
    return { error: 'raw WebSocket trace eventCount or JSONL content is invalid' };
  }
  return { entries, authority };
}

function traceContainsForbiddenInput(entries) {
  return entries.some((entry) => {
    if (
      entry?.type === 'input_audio_buffer.append'
      || entry?.type === 'input_audio_buffer.commit'
      || entry?.type === 'response.create'
    ) return true;
    if (entry?.type !== 'conversation.item.create') return false;
    return entry?.contentType === 'input_text'
      || /"type"\s*:\s*"input_text"/u.test(String(entry?.rawRedactedPayload ?? ''));
  });
}

function exactObjectKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

const sameJson = (left, right) => (
  JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right))
);

function verifiedTracePayload(entry) {
  const payload = entry?.rawRedactedPayload;
  if (
    typeof payload !== 'string'
    || payload.length < 2
    || entry?.sha256 !== sha256Value(payload)
    || /Bearer\s+[^\s"']+/iu.test(payload)
    || /(?:api[_-]?key|credential)\s*[:=]\s*["']?(?!\[REDACTED\])/iu.test(payload)
  ) return null;
  try { return JSON.parse(payload); } catch { return null; }
}

function validateUpgradeAuthority(entry) {
  if (entry?.direction !== 'transport' || entry?.type !== 'websocket.upgrade' || entry?.status !== 101) {
    return false;
  }
  // The strict artifact authority validates the request authority itself. Keep
  // legacy process-only fixtures readable, but when the trace carries the new
  // request payload it must be internally complete and digest-bound.
  if (entry?.rawRedactedPayload == null && entry?.sha256 == null) return true;
  const payload = verifiedTracePayload(entry);
  if (!exactObjectKeys(payload, ['host', 'path', 'query', 'requestHeaderNames', 'scheme'])) return false;
  if (
    payload.scheme !== 'wss'
    || payload.host !== 'dashscope.aliyuncs.com'
    || payload.path !== '/api-ws/v1/realtime'
    || !exactObjectKeys(payload.query, ['model'])
    || payload.query.model !== 'qwen3.5-livetranslate-flash-realtime'
    || typeof payload.host !== 'string'
    || !payload.host
    || !Array.isArray(payload.requestHeaderNames)
    || payload.requestHeaderNames.some((name) => typeof name !== 'string' || name !== name.toLowerCase())
    || JSON.stringify(payload.requestHeaderNames) !== '["authorization"]'
  ) return false;
  return true;
}

function validateSessionUpdatePayload(entry) {
  if (entry?.direction !== 'client-to-server' || entry?.type !== 'session.update') return null;
  const payload = verifiedTracePayload(entry);
  if (
    !exactObjectKeys(payload, ['event_id', 'session', 'type'])
    || payload.type !== 'session.update'
    || !/^evt_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(String(payload.event_id ?? ''))
    || !exactObjectKeys(payload.session, [
      'input_audio_format',
      'input_audio_transcription',
      'modalities',
      'sample_rate',
      'translation',
    ])
    || JSON.stringify(payload.session.modalities) !== '["text"]'
    || payload.session.sample_rate !== 16_000
    || payload.session.input_audio_format !== 'pcm'
    || !exactObjectKeys(payload.session.input_audio_transcription, ['language'])
    || payload.session.input_audio_transcription.language !== 'zh'
    || !exactObjectKeys(payload.session.translation, ['language'])
    || payload.session.translation.language !== 'en'
  ) return null;
  return payload;
}

function validateSessionFinishPayload(entry, sessionUpdate) {
  if (entry?.direction !== 'client-to-server' || entry?.type !== 'session.finish') return false;
  const payload = verifiedTracePayload(entry);
  return exactObjectKeys(payload, ['event_id', 'type'])
    && payload.type === 'session.finish'
    && /^evt_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(String(payload.event_id ?? ''))
    && payload.event_id !== sessionUpdate?.event_id;
}

function validateSessionAuthority(raw, createdEntry, updatedEntry, sessionUpdate) {
  const created = verifiedTracePayload(createdEntry);
  const updated = verifiedTracePayload(updatedEntry);
  const authority = raw?.sessionAuthority;
  const requestedConfigSha256 = sha256Value(JSON.stringify(sessionUpdate.session));
  const createdSession = created?.session;
  const updatedSession = updated?.session;
  const updatedConfig = updatedSession && {
    input_audio_format: updatedSession.input_audio_format,
    input_audio_transcription: updatedSession.input_audio_transcription,
    modalities: updatedSession.modalities,
    sample_rate: updatedSession.sample_rate,
    translation: updatedSession.translation,
  };
  if (created?.type !== 'session.created' || updated?.type !== 'session.updated') {
    return 'server-event-payload-invalid';
  }
  if (
    !/^[a-f0-9]{64}$/u.test(String(createdSession?.id ?? ''))
    || createdSession.id !== updatedSession?.id
    || authority?.sessionIdentitySha256 !== createdSession.id
  ) return 'session-identity-mismatch';
  if (
    createdSession.model !== 'qwen3.5-livetranslate-flash-realtime'
    || updatedSession?.model !== createdSession.model
    || authority?.serverModel !== createdSession.model
  ) return 'server-model-mismatch';
  if (
    !sameJson(updatedConfig, sessionUpdate.session)
    || authority?.echoedSessionConfigSha256 !== requestedConfigSha256
  ) return 'session-update-echo-mismatch';
  return null;
}

function traceTerminalClassification(raw, traceEntries) {
  const terminals = traceEntries.filter((entry) => (
    (entry?.direction === 'server-to-client' && ['error', 'websocket.close', 'websocket.binary'].includes(entry?.type))
    || (entry?.direction === 'local' && entry?.type === 'read.timeout')
    || (entry?.direction === 'local' && [
      'connect.timeout',
      'websocket.upgrade.timeout',
      'connect.error',
      'websocket.upgrade.error',
    ].includes(entry?.type))
  ));
  if (terminals.length === 0) return null;
  if (terminals.length !== 1 || terminals[0] !== traceEntries.at(-1)) {
    return { kind: 'terminal-trace-mismatch', passed: false };
  }
  const terminal = terminals[0];
  if (terminal.type === 'error') {
    const derived = raw?.providerErrorFrame;
    if (derived == null) return { kind: 'unreported-terminal-trace', passed: false };
    const payload = terminal?.rawRedactedPayload;
    if (
      typeof payload !== 'string'
      || derived?.sha256 !== sha256Value(payload)
      || derived?.type !== 'error'
      || derived?.monotonicMs !== terminal.monotonicMs
      || derived?.rawRedactedPayload !== terminal.rawRedactedPayload
      || (terminal?.sha256 != null && terminal.sha256 !== derived.sha256)
    ) return { kind: 'terminal-trace-mismatch', passed: false };
    return { kind: 'provider-error-frame', passed: false };
  }
  if (terminal.type === 'websocket.close') {
    const normal = [1_000, 1_001].includes(terminal?.code);
    if (
      !Number.isSafeInteger(terminal?.code)
      || terminal.code < 1_000
      || terminal.code > 4_999
      || typeof terminal?.reason !== 'string'
      || terminal?.normal !== normal
    ) return { kind: 'terminal-trace-mismatch', passed: false };
    const derived = raw?.websocketClose;
    if (derived == null) return { kind: 'unreported-terminal-trace', passed: false };
    if (
      derived?.monotonicMs !== terminal.monotonicMs
      || derived?.code !== terminal.code
      || derived?.reason !== terminal.reason
      || derived?.normal !== terminal.normal
    ) return { kind: 'terminal-trace-mismatch', passed: false };
    return {
      kind: normal ? 'websocket-close-normal' : 'websocket-close-abnormal',
      passed: false,
    };
  }
  if (terminal.type === 'websocket.binary') {
    return { kind: 'invalid-livetranslate-binary-frame', passed: false };
  }
  if (terminal.type === 'read.timeout') {
    if (raw?.timeoutPhase == null) {
      return { kind: 'unreported-terminal-trace', passed: false };
    }
    const expectedStarted = terminal.timeoutPhase === 'response-completion'
      ? traceEntries.find((entry) => (
        entry?.direction === 'client-to-server' && entry?.type === 'session.update'
      ))?.monotonicMs
      : 0;
    if (
      !PROVIDER_PREFLIGHT_TIMEOUT_PHASES.has(terminal?.timeoutPhase)
      || raw?.timeoutPhase !== terminal.timeoutPhase
      || raw?.timeoutBudgetMs !== PROVIDER_PREFLIGHT_FIRST_SERVER_EVENT_BUDGET_MS
      || !Number.isSafeInteger(terminal?.startedMonotonicMs)
      || !Number.isSafeInteger(terminal?.deadlineMonotonicMs)
      || terminal.startedMonotonicMs !== expectedStarted
      || terminal.deadlineMonotonicMs - terminal.startedMonotonicMs
        !== raw.timeoutBudgetMs
      || terminal.monotonicMs < terminal.deadlineMonotonicMs
    ) return { kind: 'terminal-trace-mismatch', passed: false };
    return { kind: `timeout:${terminal.timeoutPhase}`, passed: false };
  }
  if (terminal.type.endsWith('.timeout')) {
    const expectedPhase = terminal.type === 'connect.timeout' ? 'connect' : 'websocket-upgrade';
    const payloadAuthorityValid = terminal?.rawRedactedPayload == null && terminal?.sha256 == null
      ? true
      : Boolean(verifiedTracePayload(terminal));
    if (
      !payloadAuthorityValid
      || raw?.timeoutPhase !== expectedPhase
      || terminal?.timeoutPhase !== expectedPhase
      || raw?.timeoutBudgetMs !== PROVIDER_PREFLIGHT_FIRST_SERVER_EVENT_BUDGET_MS
      || !Number.isSafeInteger(terminal?.startedMonotonicMs)
      || !Number.isSafeInteger(terminal?.deadlineMonotonicMs)
      || terminal.startedMonotonicMs !== 0
      || terminal.deadlineMonotonicMs - terminal.startedMonotonicMs
        !== raw.timeoutBudgetMs
      || terminal.monotonicMs < terminal.deadlineMonotonicMs
    ) return { kind: 'terminal-trace-mismatch', passed: false };
    return { kind: `timeout:${expectedPhase}`, passed: false };
  }
  if (!verifiedTracePayload(terminal)) {
    return { kind: 'terminal-trace-mismatch', passed: false };
  }
  const expectedOutcome = terminal.type === 'connect.error'
    ? 'transport-connect-error'
    : 'transport-upgrade-error';
  if (raw?.evidenceOutcome !== expectedOutcome) {
    return { kind: 'terminal-trace-mismatch', passed: false };
  }
  return { kind: expectedOutcome, passed: false };
}

function classifyProviderWireEvidence(raw, traceEntries) {
  if (traceContainsForbiddenInput(traceEntries)) {
    return { kind: 'forbidden-livetranslate-input', passed: false };
  }
  const traceHasInvalidMonotonicTime = traceEntries.some((entry, index) => (
    !Number.isSafeInteger(entry?.monotonicMs)
    || entry.monotonicMs < 0
    || (index > 0 && entry.monotonicMs <= traceEntries[index - 1]?.monotonicMs)
  ));
  if (traceHasInvalidMonotonicTime) {
    return { kind: 'invalid-livetranslate-monotonic-time', passed: false };
  }
  const terminal = traceTerminalClassification(raw, traceEntries);
  if (terminal) return terminal;

  const first = raw?.firstServerEvent;

  if (
    typeof first?.type !== 'string'
    || first.type !== 'session.created'
    || !Number.isSafeInteger(first?.monotonicMs)
    || first.monotonicMs < 0
  ) return { kind: 'unknown', passed: false };
  if (
    raw?.externalAudioSamples !== 0
    || raw?.inputAudioBufferCommitCount !== 0
    || raw?.conversationItemCreateInputTextCount !== 0
    || raw?.responseCreateCount !== 0
  ) return { kind: 'forbidden-livetranslate-input', passed: false };
  if (
    !Number.isSafeInteger(raw?.lifecycleBudget?.firstServerEventLatencyMs)
    || raw.lifecycleBudget.firstServerEventLatencyMs !== 1_200
    || !Number.isSafeInteger(raw?.lifecycleBudget?.socketEventTimeoutMs)
    || raw.lifecycleBudget.socketEventTimeoutMs !== 12_000
    || !Number.isSafeInteger(raw?.latencyBudgetMs)
    || raw.latencyBudgetMs !== 1_200
  ) return { kind: 'invalid-lifecycle-budget', passed: false };
  if (
    !Number.isSafeInteger(raw?.firstServerEventLatencyMs)
    || !Number.isSafeInteger(raw?.measuredLatencyMs)
    || raw.firstServerEventLatencyMs !== first.monotonicMs
    || raw.measuredLatencyMs !== first.monotonicMs
  ) return { kind: 'invalid-latency-evidence', passed: false };
  if (first.monotonicMs > PROVIDER_PREFLIGHT_FIRST_SERVER_EVENT_BUDGET_MS) {
    return { kind: 'first-server-event-timeout', passed: false };
  }

  if (traceEntries.length < PROVIDER_PREFLIGHT_LIFECYCLE.length) {
    return { kind: 'incomplete-livetranslate-lifecycle', passed: false };
  }
  if (traceEntries.length > PROVIDER_PREFLIGHT_LIFECYCLE.length) {
    return { kind: 'unexpected-livetranslate-trace-event', passed: false };
  }
  for (let index = 0; index < PROVIDER_PREFLIGHT_LIFECYCLE.length; index += 1) {
    const expected = PROVIDER_PREFLIGHT_LIFECYCLE[index];
    const observed = traceEntries[index];
    if (
      observed?.direction !== expected.direction
      || observed?.type !== expected.type
      || !Number.isSafeInteger(observed?.monotonicMs)
      || observed.monotonicMs < 0
      || (index > 0 && observed.monotonicMs <= traceEntries[index - 1]?.monotonicMs)
    ) return { kind: 'invalid-livetranslate-order', passed: false };
  }
  const firstTraceServerEvent = traceEntries.find((entry) => entry?.direction === 'server-to-client');
  if (
    firstTraceServerEvent?.type !== first.type
    || firstTraceServerEvent?.monotonicMs !== first.monotonicMs
  ) return { kind: 'first-server-event-trace-mismatch', passed: false };
  const update = validateSessionUpdatePayload(traceEntries[2]);
  if (!validateUpgradeAuthority(traceEntries[0])) {
    return { kind: 'upgrade-request-authority-invalid', passed: false };
  }
  if (!update) return { kind: 'session-update-payload-invalid', passed: false };
  if (!validateSessionFinishPayload(traceEntries[4], update)) {
    return { kind: 'session-finish-payload-invalid', passed: false };
  }
  const serverAuthorityFailure = validateSessionAuthority(
    raw,
    traceEntries[1],
    traceEntries[3],
    update,
  );
  if (serverAuthorityFailure) return { kind: serverAuthorityFailure, passed: false };
  if (
    raw?.providerInputMode !== 'none'
    || raw?.responseMode !== 'text-only'
    || raw?.providerInvocationCount !== 1
    || raw?.connectionCount !== 1
  ) return { kind: 'invalid-livetranslate-call-authority', passed: false };
  if (raw?.productionMode !== true) {
    return { kind: 'non-production-lifecycle', passed: false };
  }
  if (first.monotonicMs > 1_200) {
    return { kind: 'latency-budget-exceeded', passed: false };
  }
  return { kind: 'livetranslate-session-finished', passed: true };
}

function probeEvidence(outputDirectory, emitter, providerId) {
  const probe = readJson(path.join(outputDirectory, 'provider-probe-result.json'));
  const raw = probe?.value?.rawProbeResult ?? probe?.rawProbeResult ?? probe?.value ?? probe;
  const isLiveTranslate = [raw?.modelId, raw?.model, probe?.model]
    .some((value) => value === 'qwen3.5-livetranslate-flash-realtime');
  const fields = {
    modelId: raw?.modelId ?? probe?.modelId ?? null,
    verdict: raw?.verdict ?? probe?.value?.verdict ?? probe?.verdict
      ?? (emitter?.status === 'failed' ? 'infrastructure-failure' : null),
    measuredLatencyMs: Number.isSafeInteger(raw?.measuredLatencyMs) ? raw.measuredLatencyMs : null,
    latencyBudgetMs: Number.isSafeInteger(raw?.latencyBudgetMs) ? raw.latencyBudgetMs : null,
    connectionAttempts: Number.isFinite(Number(raw?.connectionAttempts)) ? Number(raw.connectionAttempts) : null,
    connectionCount: Number.isFinite(Number(raw?.connectionCount)) ? Number(raw.connectionCount) : null,
    connectionOpened: raw?.connectionOpened === true,
    connectionClosed: raw?.connectionClosed === true,
    connectionGeneration: Number.isFinite(Number(raw?.connectionGeneration))
      ? Number(raw.connectionGeneration)
      : null,
    streamingObserved: raw?.streamingObserved ?? null,
    responseShapeValid: raw?.responseShapeValid ?? null,
    connectionOwner: raw?.connectionOwner ?? null,
    evidenceOutcome: raw?.evidenceOutcome ?? null,
    firstServerEvent: raw?.firstServerEvent ?? null,
    firstServerEventLatencyMs: Number.isSafeInteger(raw?.firstServerEventLatencyMs)
      ? raw.firstServerEventLatencyMs
      : null,
    productionMode: raw?.productionMode === true,
    lifecycleBudget: raw?.lifecycleBudget ?? null,
    providerInputMode: raw?.providerInputMode ?? null,
    responseMode: raw?.responseMode ?? null,
    providerInvocationCount: Number.isSafeInteger(raw?.providerInvocationCount)
      ? raw.providerInvocationCount
      : null,
    externalAudioSamples: Number.isSafeInteger(raw?.externalAudioSamples)
      ? raw.externalAudioSamples
      : null,
    inputAudioBufferCommitCount: Number.isSafeInteger(raw?.inputAudioBufferCommitCount)
      ? raw.inputAudioBufferCommitCount
      : null,
    conversationItemCreateInputTextCount:
      Number.isSafeInteger(raw?.conversationItemCreateInputTextCount)
        ? raw.conversationItemCreateInputTextCount
        : null,
    responseCreateCount: Number.isSafeInteger(raw?.responseCreateCount)
      ? raw.responseCreateCount
      : null,
    sessionAuthority: raw?.sessionAuthority ?? null,
    providerErrorFrame: raw?.providerErrorFrame ?? null,
    websocketClose: raw?.websocketClose ?? null,
    timeoutPhase: raw?.timeoutPhase ?? null,
    timeoutBudgetMs: Number.isSafeInteger(raw?.timeoutBudgetMs)
      ? raw.timeoutBudgetMs
      : null,
    rawTrace: raw?.rawTrace ?? null,
  };
  if (!probe) {
    return providerId === 'provider-dashscope'
      ? {
        present: true,
        fields,
        classification: { kind: 'unknown', passed: false },
        traceError: null,
      }
      : { present: false, fields, classification: null, traceError: null };
  }
  if (!isLiveTranslate) {
    return { present: false, fields, classification: null, traceError: null };
  }
  const checkedTrace = verifyRawTraceAuthority(outputDirectory, raw?.rawTrace);
  if (checkedTrace.error) {
    return { present: true, fields, classification: null, traceError: checkedTrace.error };
  }
  const classification = classifyProviderWireEvidence(raw, checkedTrace.entries);
  if (classification.kind !== raw?.evidenceOutcome) {
    return {
      present: true,
      fields,
      classification: { kind: 'evidence-outcome-mismatch', passed: false },
      traceError: null,
    };
  }
  if (
    providerId === 'provider-dashscope'
    && probe?.productionMode === true
    && (
      raw?.latencyBudgetMs !== 1_200
      || !Number.isSafeInteger(raw?.measuredLatencyMs)
      || raw.measuredLatencyMs < 0
      || raw.measuredLatencyMs > 1_200
      || raw?.verdict !== 'available'
    )
  ) {
    return {
      present: true,
      fields,
      classification: { kind: 'latency-budget-exceeded', passed: false },
      traceError: null,
    };
  }
  return { present: true, fields, classification, traceError: null };
}

function stableEvidenceErrorCode(kind) {
  switch (kind) {
    case 'incomplete-livetranslate-lifecycle': return 'provider.preflight.protocol-incomplete';
    case 'invalid-livetranslate-order':
    case 'invalid-livetranslate-monotonic-time':
    case 'first-server-event-trace-mismatch':
      return 'provider.preflight.protocol-order-invalid';
    case 'forbidden-livetranslate-input': return 'provider.preflight.forbidden-client-event';
    case 'session-update-payload-invalid':
    case 'session-finish-payload-invalid':
      return 'provider.preflight.client-payload-invalid';
    case 'server-event-payload-invalid':
    case 'session-identity-mismatch':
    case 'server-model-mismatch':
    case 'session-update-echo-mismatch':
      return 'provider.preflight.server-authority-invalid';
    case 'upgrade-request-authority-invalid':
      return 'provider.preflight.request-authority-invalid';
    case 'invalid-livetranslate-binary-frame':
      return 'provider.preflight.protocol-binary-frame';
    case 'first-server-event-timeout':
    case 'timeout:read-first-event':
      return 'provider.preflight.first-event-timeout';
    case 'timeout:response-completion': return 'provider.preflight.response-completion-timeout';
    case 'provider-error-frame': return 'provider.preflight.provider-error-frame';
    case 'latency-budget-exceeded': return 'provider.preflight.latency-budget-exceeded';
    case 'websocket-close-normal': return 'provider.preflight.websocket-close-normal';
    case 'websocket-close-abnormal': return 'provider.preflight.websocket-close-abnormal';
    case 'timeout:connect': return 'provider.preflight.connect-timeout';
    case 'timeout:websocket-upgrade': return 'provider.preflight.websocket-upgrade-timeout';
    case 'transport-connect-error': return 'provider.preflight.connect-failed';
    case 'transport-upgrade-error': return 'provider.preflight.upgrade-failed';
    case 'terminal-trace-mismatch':
    case 'evidence-outcome-mismatch':
      return 'provider.preflight.raw-trace-invalid';
    case 'invalid-lifecycle-budget': return 'provider.preflight.invalid-lifecycle-budget';
    case 'invalid-latency-evidence': return 'provider.preflight.invalid-latency-evidence';
    case 'unreported-terminal-trace': return 'provider.preflight.unreported-terminal-trace';
    case 'unexpected-livetranslate-trace-event': return 'provider.preflight.unexpected-trace-event';
    case 'invalid-livetranslate-call-authority':
    case 'non-production-lifecycle':
      return 'provider.preflight.invalid-call-authority';
    case 'unknown':
    default:
      return 'provider.preflight.unknown-terminal-evidence';
  }
}

export async function runManagedProviderPreflight({
  executablePath,
  outputDirectory,
  environment,
  executionId,
  providerId,
  signal,
  spawnProcess = spawn,
  emitterTimeoutMs = PROVIDER_PREFLIGHT_EMITTER_TIMEOUT_MS,
  exitGraceMs = PROVIDER_PREFLIGHT_EXIT_GRACE_MS,
  closeGraceMs = PROVIDER_PREFLIGHT_CLOSE_GRACE_MS,
  cleanupTimeoutMs = PROVIDER_PREFLIGHT_CLEANUP_TIMEOUT_MS,
  now = () => new Date(),
  querySnapshot = queryProcessSnapshot,
  closeOwnedProcess = requestClose,
  forceOwnedProcess = forceOwnedProcessTree,
} = {}) {
  fs.mkdirSync(path.dirname(outputDirectory), { recursive: true });
  if (fs.existsSync(outputDirectory)) {
    throw new Error(`provider preflight output directory already exists: ${outputDirectory}`);
  }
  const startedAt = now();
  const child = spawnProcess(executablePath, [], {
    cwd: path.dirname(executablePath), env: environment, windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  let stdout = '';
  let stderr = '';
  let exited = false;
  let exitCode = null;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  child.once('exit', (code) => { exited = true; exitCode = code; });
  const authorityDeadline = Date.now() + 5_000;
  let snapshot = null;
  while (!snapshot?.exists && Date.now() < authorityDeadline) {
    snapshot = querySnapshot(child.pid);
    if (!snapshot?.exists) await delay(50);
  }
  const processAuthority = {
    pid: child.pid,
    parentPid: snapshot?.parentPid ?? process.pid,
    imagePath: snapshot?.imagePath ?? path.resolve(executablePath),
    imageSha256: sha256(executablePath),
    startedAt: snapshot?.startedAt ?? startedAt.toISOString(),
  };
  const emitterPath = path.join(outputDirectory, 'emitter-result.json');
  const deadline = Date.now() + emitterTimeoutMs;
  let emitter = null;
  let primaryError = null;
  while (!emitter && !exited && Date.now() < deadline && !signal?.aborted) {
    const candidate = readJson(emitterPath);
    if (['completed', 'failed'].includes(candidate?.status)) emitter = candidate;
    else await delay(100);
  }
  // Process exit and the final emitter receipt can become observable in either
  // order. Give the immutable receipt a short visibility grace period before
  // classifying a clean exit as an emitter failure.
  if (!emitter && exited && !signal?.aborted) {
    const visibilityDeadline = Math.min(deadline, Date.now() + 500);
    while (!emitter && Date.now() < visibilityDeadline) {
      const candidate = readJson(emitterPath);
      if (['completed', 'failed'].includes(candidate?.status)) emitter = candidate;
      else await delay(25);
    }
  }
  if (signal?.aborted) primaryError = new Error(`provider preflight aborted: ${signal.reason?.message ?? signal.reason ?? 'signal'}`);
  else if (!emitter && Date.now() >= deadline) primaryError = new Error(`provider preflight emitter timed out after ${emitterTimeoutMs}ms`);
  else if (!emitter && exited) primaryError = new Error(`provider preflight exited before terminal emitter result: exit=${exitCode ?? 'unknown'}`);
  else if (emitter?.status === 'failed') primaryError = new Error(String(emitter.error ?? 'provider preflight emitter failed'));

  const cleanupErrors = [];
  const termination = { terminalEmitterObserved: Boolean(emitter), closeRequest: null, forced: false };
  const waitForExit = async (milliseconds) => {
    const end = Date.now() + milliseconds;
    while (!exited && Date.now() < end) await delay(50);
    return exited;
  };
  await waitForExit(exitGraceMs);
  if (!exited) {
    try { termination.closeRequest = closeOwnedProcess(processAuthority); } catch (error) { cleanupErrors.push(error.message); }
    await waitForExit(closeGraceMs);
  }
  if (!exited) {
    try { Object.assign(termination, forceOwnedProcess(processAuthority)); } catch (error) { cleanupErrors.push(error.message); }
    await waitForExit(cleanupTimeoutMs);
  }
  termination.exited = exited;
  termination.exitCode = exitCode;
  const observedProbe = probeEvidence(outputDirectory, emitter, providerId);
  const fields = observedProbe.fields;
  if (observedProbe.present && observedProbe.traceError) {
    primaryError = new Error(observedProbe.traceError);
  } else if (observedProbe.present && observedProbe.classification?.passed !== true) {
    primaryError ??= new Error(
      `provider preflight wire evidence ended as ${observedProbe.classification?.kind ?? 'unknown'}`,
    );
  }
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy?.();
  if (exited) {
    child.removeAllListeners?.();
    child.unref?.();
  }
  if (!primaryError && (exitCode ?? 0) !== 0) primaryError = new Error(`provider preflight process failed with exit ${exitCode}`);
  if (!primaryError && (cleanupErrors.length > 0 || !exited)) {
    primaryError = new Error(`provider preflight cleanup failed: ${cleanupErrors.join('; ') || 'owned process did not exit'}`);
  }
  if (primaryError) {
    const evidenceStableErrorCode = observedProbe.traceError
      ? 'provider.preflight.raw-trace-invalid'
      : observedProbe.classification?.passed === false
        ? stableEvidenceErrorCode(observedProbe.classification.kind)
        : null;
    const stableErrorCode = signal?.aborted
      ? 'provider.preflight.interrupted'
      : !emitter && exited
        ? 'provider.preflight.child-exit'
        : evidenceStableErrorCode
          ?? (!emitter
        ? 'provider.preflight.emitter-timeout'
        : cleanupErrors.length > 0 || !exited
          ? 'provider.preflight.cleanup-failed'
          : fields.verdict === 'realtime-risk'
            ? 'provider.preflight.latency-budget-exceeded'
            : 'provider.preflight.failed');
    const processTerminal = signal?.aborted
      ? {
        kind: 'cancelled',
        reason: signal.reason?.message ?? String(signal.reason ?? 'signal'),
        childExitCode: exitCode,
      }
      : !emitter && exited
        ? { kind: 'child-exit', childExitCode: exitCode }
        : {
          kind: 'emitter-terminal',
          status: emitter?.status ?? 'missing',
          childExitCode: exitCode,
        };
    const failure = {
      schemaVersion: 1,
      artifactKind: 'watch-mode-provider-preflight-failure',
      generatedAt: now().toISOString(),
      executionId,
      providerId,
      stableErrorCode,
      ...fields,
      process: processAuthority,
      processTerminal,
      termination,
      primaryError: { code: stableErrorCode, message: primaryError.message },
      cleanupErrors,
      stdoutTail: stdout.slice(-8_192),
      stderrTail: stderr.slice(-8_192),
    };
    // The Desktop owns successful publication of outputDirectory by atomically
    // renaming its sibling staging directory. Only a failed execution that did
    // not publish evidence transfers directory ownership back to the runner.
    if (!fs.existsSync(outputDirectory)) fs.mkdirSync(outputDirectory, { recursive: false });
    const failurePath = path.join(outputDirectory, PROVIDER_PREFLIGHT_FAILURE_FILE);
    atomicWriteJson(failurePath, failure);
    const error = new Error(primaryError.message);
    error.failurePath = failurePath;
    error.failure = failure;
    throw error;
  }
  return {
    emitter,
    emitterPath,
    outputDirectory,
    processAuthority,
    termination,
    fields,
    emitterAuthority: fileAuthorityEntry(emitterPath, 'emitter-result.json'),
  };
}
