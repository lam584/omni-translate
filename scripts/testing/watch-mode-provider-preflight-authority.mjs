import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PROVIDER_PREFLIGHT_SCENARIO_ID = 'E2E-PROVIDER-PROBE';
export const PROVIDER_PREFLIGHT_OPERATION = 'livetranslate-session-lifecycle-preflight';
export const PROVIDER_PREFLIGHT_INPUT_MODE = 'none';
export const PROVIDER_PREFLIGHT_INVOCATION_COUNT = 1;
export const PROVIDER_PREFLIGHT_EXTERNAL_AUDIO_SAMPLES = 0;

const BASE_ROOT_ENTRIES = Object.freeze([
  'diagnostics-bundle',
  'emitter-result.json',
  'provider-probe-result.json',
]);
const TIMELINE = Object.freeze([
  'invocation-started',
  'provider-loaded-and-credential-checked',
  'provider-probe-completed',
  'diagnostics-export-requested',
  'diagnostics-export-packaged',
  'invocation-completed',
]);
const EMITTER_ID = 'omni-desktop-provider-probe-release-evidence';
const EMITTER_VERSION = '0.1.0';
const SHA256 = /^[a-f0-9]{64}$/;
const STRICT_PROVIDER_ID = 'provider-dashscope';
const STRICT_PROVIDER_TEMPLATE_ID = 'template-dashscope-realtime';
const STRICT_PROVIDER_KIND = 'dashscope';
const STRICT_PROVIDER_ENDPOINT_HOST = 'dashscope.aliyuncs.com';
const STRICT_PROVIDER_CREDENTIAL_REFERENCE = 'credential://provider/dashscope/default';
const STRICT_SYSTEM_PROMPT_TEMPLATE = 'game-live-translation-cn';
const STRICT_RESPONSE_MODALITIES = Object.freeze(['text']);
const STRICT_TIMEOUT_MS = 12_000;
const STRICT_TEMPERATURE = 0.2;
const STRICT_MAX_INPUT_TOKENS = 4_096;
const STRICT_MAX_OUTPUT_TOKENS = 256;

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const sameCanonical = (left, right) => (
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
);

const authorizationCommon = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
};

function validateObservedAuthorization(value, expected, label, issues) {
  const observed = authorizationCommon(value);
  if (!observed || !expected) {
    issues.push(`${label} is missing the signed preflight authorization consumption`);
    return null;
  }
  const livetranslate = expected?.protocol === 'dashscope-livetranslate';
  const exactFields = [
    'schemaVersion', 'artifactKind', 'executionId', 'grantDigest',
    'leaseReservationDigests', 'authorizationDigest', 'providerId', 'model',
    'protocol', 'operation', 'inputMode', 'invocationCount',
    'externalAudioSamples', 'leaseReservations', 'grantGeneratedAt',
    'reservationIssuedAts', 'consumptionClaim',
  ];
  if (livetranslate) {
    exactFields.push(
      'providerInputMode',
      'responseMode',
      'terminalEvent',
      'lifecycleBudget',
    );
  } else {
    exactFields.push('tokenBudget');
  }
  if (Object.hasOwn(expected, 'incidentId')) exactFields.push('incidentId');
  for (const field of exactFields) {
    if (!sameCanonical(observed[field], expected[field])) {
      issues.push(`${label} ${field} does not match the signed authorization`);
    }
  }
  if (!Number.isFinite(Date.parse(String(observed.authorizationObservedAt ?? '')))) {
    issues.push(`${label} authorizationObservedAt is missing or invalid`);
  }
  return observed;
}

function exactObjectKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function verifiedTracePayload(entry) {
  const payload = entry?.rawRedactedPayload;
  if (
    typeof payload !== 'string'
    || payload.length < 2
    || entry?.sha256 !== sha256Bytes(Buffer.from(payload, 'utf8'))
    || /Bearer\s+[^\s"']+/iu.test(payload)
  ) return null;
  try { return JSON.parse(payload); } catch { return null; }
}

function strictSessionUpdate(entry) {
  const payload = verifiedTracePayload(entry);
  if (
    entry?.direction !== 'client-to-server'
    || entry?.type !== 'session.update'
    || !exactObjectKeys(payload, ['event_id', 'session', 'type'])
    || payload.type !== 'session.update'
    || !/^evt_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(String(payload.event_id ?? ''))
    || !exactObjectKeys(payload.session, [
      'input_audio_format',
      'input_audio_transcription',
      'modalities',
      'sample_rate',
      'translation',
      'turn_detection',
    ])
    || !sameCanonical(payload.session.modalities, ['text'])
    || payload.session.sample_rate !== 16_000
    || payload.session.input_audio_format !== 'pcm'
    || !sameCanonical(payload.session.input_audio_transcription, {
      language: 'en',
      model: 'qwen3-asr-flash-realtime',
    })
    || !sameCanonical(payload.session.translation, {
      corpus: {
        phrases: {
          Mars: '火星',
          'artificial biosphere': '人工生物圈',
          'light bulb': '灯泡',
          'one billion': '十亿',
        },
      },
      language: 'zh',
    })
    || !sameCanonical(payload.session.turn_detection, {
      silence_duration_ms: 400,
      threshold: 0,
      type: 'server_vad',
    })
  ) return null;
  return payload;
}

function strictUpgrade(entry) {
  const payload = verifiedTracePayload(entry);
  if (
    entry?.direction !== 'transport'
    || entry?.type !== 'websocket.upgrade'
    || entry?.status !== 101
    || !exactObjectKeys(payload, ['host', 'path', 'query', 'requestHeaderNames', 'scheme'])
    || payload.scheme !== 'wss'
    || payload.host !== 'dashscope.aliyuncs.com'
    || payload.path !== '/api-ws/v1/realtime'
    || !exactObjectKeys(payload.query, ['model'])
    || payload.query.model !== 'qwen3.5-livetranslate-flash-realtime'
    || typeof payload.host !== 'string'
    || !payload.host
    || !Array.isArray(payload.requestHeaderNames)
    || !sameCanonical(payload.requestHeaderNames, ['authorization'])
  ) return false;
  return true;
}

function strictSessionAuthority(raw, createdEntry, updatedEntry, update) {
  const created = verifiedTracePayload(createdEntry);
  const updated = verifiedTracePayload(updatedEntry);
  const createdSession = created?.session;
  const updatedSession = updated?.session;
  const updatedTurnDetection = updatedSession?.turn_detection;
  const updatedConfig = updatedSession && {
    input_audio_format: updatedSession.input_audio_format,
    input_audio_transcription: updatedSession.input_audio_transcription,
    modalities: updatedSession.modalities,
    sample_rate: updatedSession.sample_rate,
    translation: updatedSession.translation,
    turn_detection: updatedTurnDetection && {
      silence_duration_ms: updatedTurnDetection.silence_duration_ms,
      threshold: updatedTurnDetection.threshold,
      type: updatedTurnDetection.type,
    },
  };
  const canonicalConfig = '{"input_audio_format":"pcm",'
    + '"input_audio_transcription":{"language":"en","model":"qwen3-asr-flash-realtime"},'
    + '"modalities":["text"],"sample_rate":16000,"translation":{"corpus":{"phrases":'
    + '{"Mars":"火星","artificial biosphere":"人工生物圈","light bulb":"灯泡","one billion":"十亿"}},'
    + '"language":"zh"},'
    + '"turn_detection":{"silence_duration_ms":400,"threshold":0.0,"type":"server_vad"}}';
  const configDigest = sha256Bytes(Buffer.from(canonicalConfig, 'utf8'));
  const authority = raw?.sessionAuthority;
  return created?.type === 'session.created'
    && updated?.type === 'session.updated'
    && SHA256.test(String(createdSession?.id ?? ''))
    && createdSession.id === updatedSession?.id
    && createdSession.model === 'qwen3.5-livetranslate-flash-realtime'
    && updatedSession?.model === createdSession.model
    && sameCanonical(updatedTurnDetection, {
      create_response: true,
      interrupt_response: true,
      silence_duration_ms: 400,
      threshold: 0,
      type: 'server_vad',
    })
    && sameCanonical(updatedConfig, update.session)
    && exactObjectKeys(authority, [
      'echoedSessionConfigSha256',
      'serverModel',
      'sessionIdentitySha256',
    ])
    && authority.sessionIdentitySha256 === createdSession.id
    && authority.serverModel === createdSession.model
    && authority.echoedSessionConfigSha256 === configDigest;
}

function validateLiveTranslateWireEvidence(root, probe, raw, issues) {
  const authority = raw?.rawTrace;
  if (
    authority?.path !== 'raw/provider-websocket-trace.jsonl'
    || !Number.isSafeInteger(authority?.bytes)
    || authority.bytes < 1
    || !SHA256.test(String(authority?.sha256 ?? ''))
    || !Number.isSafeInteger(authority?.eventCount)
    || authority.eventCount < 1
  ) {
    issues.push('provider preflight raw WebSocket trace authority is invalid');
    return null;
  }
  const rawDirectory = path.join(root, 'raw');
  const tracePath = path.join(rawDirectory, 'provider-websocket-trace.jsonl');
  for (const [candidate, label, directory] of [
    [root, 'evidence root', true],
    [rawDirectory, 'raw trace directory', true],
    [tracePath, 'raw trace file', false],
  ]) {
    let stats;
    try { stats = fs.lstatSync(candidate); } catch { stats = null; }
    if (
      !stats
      || (directory ? !stats.isDirectory() : !stats.isFile())
      || stats.isSymbolicLink()
    ) {
      issues.push(`provider preflight ${label} must be real and non-symlink`);
      return null;
    }
    let real;
    try { real = fs.realpathSync.native(candidate); } catch { real = null; }
    const normalize = (value) => (
      process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    );
    if (!real || normalize(real) !== normalize(candidate)) {
      issues.push(`provider preflight ${label} contains a reparse redirect`);
      return null;
    }
  }
  let bytes;
  try { bytes = fs.readFileSync(tracePath); } catch { bytes = null; }
  if (
    !bytes
    || bytes.byteLength !== authority.bytes
    || sha256Bytes(bytes) !== authority.sha256
  ) {
    issues.push('provider preflight raw WebSocket trace bytes/digest mismatch');
    return null;
  }
  let entries;
  try {
    entries = bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    entries = null;
  }
  if (!entries || entries.length !== authority.eventCount) {
    issues.push('provider preflight raw WebSocket trace JSONL/eventCount is invalid');
    return null;
  }
  const expected = [
    ['transport', 'websocket.upgrade'],
    ['server-to-client', 'session.created'],
    ['client-to-server', 'session.update'],
    ['server-to-client', 'session.updated'],
    ['client-to-server', 'session.finish'],
    ['server-to-client', 'session.finished'],
  ];
  if (
    entries.length !== expected.length
    || entries.some((entry, index) => (
      entry?.direction !== expected[index][0]
      || entry?.type !== expected[index][1]
      || !Number.isSafeInteger(entry?.monotonicMs)
      || entry.monotonicMs < 0
      || (index > 0 && entry.monotonicMs <= entries[index - 1]?.monotonicMs)
    ))
    || !strictUpgrade(entries[0])
  ) issues.push('provider preflight raw WebSocket trace is not the exact ordered LiveTranslate lifecycle');
  const sessionUpdate = strictSessionUpdate(entries[2]);
  const finishPayload = verifiedTracePayload(entries[4]);
  const finishedPayload = verifiedTracePayload(entries[5]);
  if (
    raw?.evidenceOutcome !== 'livetranslate-session-finished'
    || raw?.firstServerEvent?.type !== 'session.created'
    || !Number.isSafeInteger(raw?.firstServerEvent?.monotonicMs)
    || raw.firstServerEvent.monotonicMs < 0
    || raw.firstServerEvent.monotonicMs > 1_200
    || raw.firstServerEvent.monotonicMs !== entries[1]?.monotonicMs
    || raw?.providerInputMode !== 'none'
    || raw?.responseMode !== 'text-only'
    || raw?.productionMode !== true
    || raw?.latencyBudgetMs !== 1_200
    || raw?.measuredLatencyMs !== raw.firstServerEvent.monotonicMs
    || raw?.firstServerEventLatencyMs !== raw.firstServerEvent.monotonicMs
    || !sameCanonical(raw?.lifecycleBudget, {
      firstServerEventLatencyMs: 1_200,
      socketEventTimeoutMs: 12_000,
    })
    || raw?.providerInvocationCount !== 1
    || raw?.connectionCount !== 1
    || raw?.externalAudioSamples !== 0
    || raw?.inputAudioBufferCommitCount !== 0
    || raw?.conversationItemCreateInputTextCount !== 0
    || raw?.responseCreateCount !== 0
    || raw?.providerErrorFrame != null
    || raw?.websocketClose != null
    || raw?.timeoutPhase != null
    || raw?.timeoutBudgetMs != null
    || !sessionUpdate
    || !strictSessionAuthority(raw, entries[1], entries[3], sessionUpdate)
    || !exactObjectKeys(finishPayload, ['event_id', 'type'])
    || finishPayload?.type !== 'session.finish'
    || !/^evt_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(String(finishPayload?.event_id ?? ''))
    || finishPayload.event_id === sessionUpdate.event_id
    || !exactObjectKeys(finishedPayload, ['event_id', 'type'])
    || finishedPayload?.type !== 'session.finished'
    || typeof finishedPayload?.event_id !== 'string'
    || finishedPayload.event_id.length === 0
    || !sameCanonical(probe?.rawTrace, authority)
    || probe?.evidenceOutcome !== raw.evidenceOutcome
    || !sameCanonical(probe?.firstServerEvent, raw.firstServerEvent)
  ) issues.push('provider preflight raw result is not a zero-audio session.finished terminal');
  return {
    evidenceOutcome: raw?.evidenceOutcome ?? null,
    firstServerEvent: raw?.firstServerEvent ?? null,
    sessionAuthority: raw?.sessionAuthority ?? null,
    rawTrace: authority,
  };
}

function validateTextOnlyTokenUsage(value, tokenBudget, label, issues) {
  const inputTokens = value?.inputTokens;
  const outputTokens = value?.outputTokens;
  const audioSeconds = value?.audioSeconds == null ? null : value.audioSeconds;
  const maxInputTokens = Number(tokenBudget?.maxInputTokens);
  const maxOutputTokens = Number(tokenBudget?.maxOutputTokens);
  if (
    typeof inputTokens !== 'number'
    || typeof outputTokens !== 'number'
    || !Number.isSafeInteger(inputTokens)
    || inputTokens < 0
    || inputTokens > maxInputTokens
    || !Number.isSafeInteger(outputTokens)
    || outputTokens < 0
    || outputTokens > maxOutputTokens
    || (audioSeconds !== null && (typeof audioSeconds !== 'number' || audioSeconds !== 0))
  ) {
    issues.push(`${label} token/audio usage exceeds or omits the signed text-only budget`);
  }
  return { inputTokens, outputTokens, audioSeconds };
}

function validateZeroInputUsage(value, label, issues) {
  const inputTokens = value?.inputTokens ?? null;
  const outputTokens = value?.outputTokens ?? null;
  const audioSeconds = value?.audioSeconds ?? null;
  if (
    inputTokens !== null
    || outputTokens !== null
    || (audioSeconds !== null && audioSeconds !== 0)
  ) issues.push(`${label} must report zero audio and no synthetic token usage`);
  return { inputTokens, outputTokens, audioSeconds };
}

const sha256Bytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = (filePath, issues, label) => {
  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
      issues.push(`${label} must be a non-empty regular non-symlink file`);
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    issues.push(`${label} is missing or invalid JSON: ${error.message}`);
    return null;
  }
};

function walkFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const fullPath = path.join(current, entry.name);
    const stats = fs.lstatSync(fullPath);
    if (stats.isSymbolicLink()) throw new Error(`provider preflight raw authority contains a symlink: ${fullPath}`);
    if (stats.isDirectory()) files.push(...walkFiles(root, fullPath));
    else if (stats.isFile()) files.push({
      fullPath,
      relativePath: path.relative(root, fullPath).split(path.sep).join('/'),
      bytes: stats.size,
    });
    else throw new Error(`provider preflight raw authority contains an unsupported entry: ${fullPath}`);
  }
  return files;
}

export function hashProviderPreflightArtifact(candidate) {
  const resolved = path.resolve(candidate);
  const stats = fs.lstatSync(resolved);
  if (stats.isSymbolicLink()) throw new Error(`provider preflight artifact may not be a symlink: ${resolved}`);
  if (stats.isFile()) {
    const bytes = fs.readFileSync(resolved);
    return { kind: 'file', sha256: sha256Bytes(bytes), fileCount: 1, byteCount: bytes.length };
  }
  if (!stats.isDirectory()) throw new Error(`provider preflight artifact is not a file/directory: ${resolved}`);
  const digest = crypto.createHash('sha256');
  const files = walkFiles(resolved);
  let byteCount = 0;
  for (const file of files) {
    const bytes = fs.readFileSync(file.fullPath);
    byteCount += bytes.length;
    digest.update('file\0');
    digest.update(file.relativePath);
    digest.update('\0');
    digest.update(String(bytes.length));
    digest.update('\0');
    digest.update(bytes);
    digest.update('\0');
  }
  return { kind: 'directory', sha256: digest.digest('hex'), fileCount: files.length, byteCount };
}

const parseEvidenceTimestamp = (value) => {
  const text = String(value ?? '').trim();
  if (/^unix-ms:\d+$/.test(text)) return Number(text.slice('unix-ms:'.length));
  if (/^unix:\d+$/.test(text)) return Number(text.slice('unix:'.length)) * 1_000;
  return Date.parse(text);
};

const evidenceTimestampInterval = (value) => {
  const text = String(value ?? '').trim();
  const timestamp = parseEvidenceTimestamp(text);
  if (!Number.isFinite(timestamp)) return null;
  return {
    start: timestamp,
    end: /^unix:\d+$/.test(text) ? timestamp + 999 : timestamp,
  };
};

const timeFailure = (value, label, { now, maxAgeDays }) => {
  const timestamp = parseEvidenceTimestamp(value);
  if (!Number.isFinite(timestamp)) return `${label} is missing or invalid`;
  if (timestamp > now + 300_000) return `${label} is more than five minutes in the future`;
  if (now - timestamp > maxAgeDays * 86_400_000) return `${label} is stale`;
  return null;
};

export function validateProviderPreflightRawAuthority(sourceRoot, {
  now = Date.now(),
  maxAgeDays = 14,
  currentProvenance,
  expectedAuthorization = null,
} = {}) {
  const root = path.resolve(sourceRoot);
  const issues = [];
  let rootStats;
  try { rootStats = fs.lstatSync(root); } catch { rootStats = null; }
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    return { issues: ['provider preflight raw authority must be a real directory'], summary: null };
  }
  try { walkFiles(root); } catch (error) { issues.push(error.message); }
  const emitter = readJson(path.join(root, 'emitter-result.json'), issues, 'provider preflight emitter result');
  const probe = readJson(path.join(root, 'provider-probe-result.json'), issues, 'provider preflight probe result');
  const strictLive = (expectedAuthorization?.protocol ?? probe?.protocol) === 'dashscope-livetranslate';
  const expectedRootEntries = [
    ...BASE_ROOT_ENTRIES,
    ...(strictLive ? ['raw'] : []),
  ].sort();
  const rootEntries = fs.readdirSync(root).sort();
  if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRootEntries)) {
    issues.push(`provider preflight root entries must be exactly ${expectedRootEntries.join(', ')}`);
  }
  const bundleRoot = path.join(root, 'diagnostics-bundle');
  let bundleHash = null;
  try { bundleHash = hashProviderPreflightArtifact(bundleRoot); } catch (error) { issues.push(error.message); }

  if (
    emitter?.schemaVersion !== 1
    || emitter?.artifactKind !== 'desktop-release-evidence-emitter-result'
    || emitter?.collectorId !== EMITTER_ID
    || emitter?.collectorVersion !== EMITTER_VERSION
    || emitter?.scenarioId !== PROVIDER_PREFLIGHT_SCENARIO_ID
    || emitter?.status !== 'completed'
    || emitter?.error != null
  ) issues.push('provider preflight emitter identity/status is invalid');
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(emitter?.invocationId ?? ''))) {
    issues.push('provider preflight emitter invocationId must be a UUID');
  }
  if (!Number.isInteger(Number(emitter?.desktopProcessId)) || Number(emitter?.desktopProcessId) <= 0) {
    issues.push('provider preflight desktopProcessId must be positive');
  }
  if (!path.isAbsolute(String(emitter?.desktopExecutable ?? '')) || !SHA256.test(String(emitter?.desktopExecutableSha256 ?? ''))) {
    issues.push('provider preflight emitter executable authority is invalid');
  }
  if (!/^[a-f0-9]{40}$/i.test(String(emitter?.sourceHeadCommit ?? ''))) {
    issues.push('provider preflight emitter source commit is invalid');
  }
  if (
    currentProvenance
    && (
      currentProvenance.source !== 'git'
      || currentProvenance.captureStatus !== 'captured'
      || currentProvenance.worktreeClean !== true
      || Number(currentProvenance.dirtyEntryCount) !== 0
      || String(emitter?.sourceHeadCommit ?? '').toLowerCase()
        !== String(currentProvenance.headCommit ?? '').toLowerCase()
    )
  ) issues.push('provider preflight emitter does not match the current exact clean HEAD');
  for (const [value, label] of [[emitter?.startedAt, 'emitter startedAt'], [emitter?.completedAt, 'emitter completedAt']]) {
    const failure = timeFailure(value, label, { now, maxAgeDays });
    if (failure) issues.push(failure);
  }
  if (Date.parse(emitter?.completedAt) < Date.parse(emitter?.startedAt)) issues.push('provider preflight emitter timestamps are inverted');
  if (
    !Array.isArray(emitter?.timeline)
    || JSON.stringify(emitter.timeline.map((event) => event?.event)) !== JSON.stringify(TIMELINE)
    || emitter.timeline.some((event, index) => (
      event?.invocationId !== emitter.invocationId || Number(event?.sequence) !== index + 1
    ))
  ) issues.push('provider preflight emitter timeline is not the fixed ordered lifecycle');
  const expectedArtifacts = [
    'provider-probe-result.json',
    'diagnostics-bundle',
    ...(strictLive ? ['raw'] : []),
  ].map((relativePath) => ({
    path: relativePath,
    ...hashProviderPreflightArtifact(path.join(root, relativePath)),
  }));
  if (JSON.stringify(emitter?.artifacts) !== JSON.stringify(expectedArtifacts)) {
    issues.push('provider preflight emitter artifact hashes/sizes do not match raw files');
  }
  const diagnostics = emitter?.diagnosticsExport;
  if (
    !bundleHash
    || diagnostics?.scope !== 'full'
    || diagnostics?.canonicalBundleSha256 !== bundleHash.sha256
    || diagnostics?.packagedBundleSha256 !== bundleHash.sha256
    || Number(diagnostics?.fileCount) !== bundleHash.fileCount
  ) issues.push('provider preflight diagnostics bundle authority is invalid');

  if (
    probe?.schemaVersion !== 1
    || probe?.artifactKind !== 'provider-production-probe-result'
    || probe?.source !== 'desktop-api-v2'
    || probe?.productionMode !== true
    || probe?.operation !== (strictLive
      ? PROVIDER_PREFLIGHT_OPERATION
      : 'text-translation-preflight')
    || probe?.inputMode !== (strictLive ? PROVIDER_PREFLIGHT_INPUT_MODE : 'text-only')
    || Number(probe?.externalAudioSamples) !== PROVIDER_PREFLIGHT_EXTERNAL_AUDIO_SAMPLES
    || Number(probe?.providerInvocationCount) !== PROVIDER_PREFLIGHT_INVOCATION_COUNT
  ) issues.push('provider preflight probe operation/input authority is invalid');
  if (
    probe?.providerId !== STRICT_PROVIDER_ID
    || probe?.templateId !== STRICT_PROVIDER_TEMPLATE_ID
    || probe?.endpointHost !== STRICT_PROVIDER_ENDPOINT_HOST
    || probe?.credentialStatus?.backend !== 'windows-credential-manager'
    || probe?.credentialStatus?.exists !== true
    || probe?.credentialStatus?.reference !== STRICT_PROVIDER_CREDENTIAL_REFERENCE
    || probe?.transportRequested !== 'websocket'
    || probe?.effectiveTransport !== 'websocket'
    || probe?.rawProbeResult?.fallbackApplied !== false
  ) issues.push('provider preflight fixed DashScope provider/credential identity is invalid');
  const probeAuthorization = expectedAuthorization
    ? validateObservedAuthorization(
        probe?.preflightAuthorization,
        expectedAuthorization,
        'provider preflight probe authorization',
        issues,
      )
    : null;
  const emitterAuthorization = expectedAuthorization
    ? validateObservedAuthorization(
        emitter?.preflightAuthorization,
        expectedAuthorization,
        'provider preflight emitter authorization',
        issues,
      )
    : null;
  const signedTokenBudget = strictLive
    ? null
    : probeAuthorization?.tokenBudget
      ?? expectedAuthorization?.tokenBudget
      ?? {
        maxInputTokens: STRICT_MAX_INPUT_TOKENS,
        maxOutputTokens: STRICT_MAX_OUTPUT_TOKENS,
      };
  if (!strictLive && (
    signedTokenBudget?.maxInputTokens !== STRICT_MAX_INPUT_TOKENS
    || signedTokenBudget?.maxOutputTokens !== STRICT_MAX_OUTPUT_TOKENS
  )) issues.push('provider preflight signed token budget is not the fixed text-only budget');
  if (strictLive && (
    !sameCanonical(
      probeAuthorization?.lifecycleBudget ?? expectedAuthorization?.lifecycleBudget,
      { firstServerEventLatencyMs: 1_200, socketEventTimeoutMs: 12_000 },
    )
    || probeAuthorization?.tokenBudget != null
  )) issues.push('provider preflight signed lifecycle budget is invalid');
  const probeUsage = strictLive
    ? validateZeroInputUsage(probe, 'provider preflight probe', issues)
    : validateTextOnlyTokenUsage(
      probe,
      signedTokenBudget,
      'provider preflight probe',
      issues,
    );
  const emitterUsage = strictLive
    ? validateZeroInputUsage(emitter, 'provider preflight emitter', issues)
    : validateTextOnlyTokenUsage(
      emitter,
      signedTokenBudget,
      'provider preflight emitter',
      issues,
    );
  if (expectedAuthorization && (
    probe?.providerId !== expectedAuthorization.providerId
    || probe?.model !== expectedAuthorization.model
    || probe?.protocol !== expectedAuthorization.protocol
    || probe?.operation !== expectedAuthorization.operation
    || probe?.inputMode !== expectedAuthorization.inputMode
    || (strictLive && probe?.providerInputMode !== expectedAuthorization.providerInputMode)
    || (strictLive && probe?.responseMode !== expectedAuthorization.responseMode)
    || (strictLive && probe?.terminalEvent !== expectedAuthorization.terminalEvent)
    || Number(probe?.providerInvocationCount) !== expectedAuthorization.invocationCount
    || Number(probe?.externalAudioSamples) !== expectedAuthorization.externalAudioSamples
  )) issues.push('provider preflight probe did not consume the exact signed authorization before connect');
  for (const field of ['templateId', 'providerId', 'model', 'transportRequested', 'effectiveTransport', 'endpointHost']) {
    if (!String(probe?.[field] ?? '').trim()) issues.push(`provider preflight probe ${field} is missing`);
  }
  if (
    probe?.verdict !== 'available'
    || Number(probe?.latencyBudgetMs) !== 1200
    || !Number.isFinite(Number(probe?.latencyMs))
    || Number(probe?.latencyMs) < 0
    || Number(probe?.latencyMs) > 1200
    || probe?.streamObserved !== true
    || probe?.responseShapeStable !== true
    || probe?.errorShapeStable !== true
    || Number(probe?.connectionAttempts) !== 1
    || Number(probe?.connectionCount) !== 1
    || probe?.connectionOpened !== true
    || probe?.connectionClosed !== true
    || !String(probe?.connectionOwner ?? '').includes(String(expectedAuthorization?.executionId ?? ''))
    || !Number.isSafeInteger(Number(probe?.connectionGeneration))
    || Number(probe?.connectionGeneration) < 1
  ) issues.push('provider preflight probe availability/latency/shape authority is invalid');
  const raw = probe?.rawProbeResult;
  if (
    raw?.providerId !== probe?.providerId
    || raw?.templateId !== probe?.templateId
    || raw?.verdict !== probe?.verdict
    || raw?.checkedAt !== probe?.checkedAt
    || Number(raw?.measuredLatencyMs) !== Number(probe?.latencyMs)
    || Number(raw?.latencyBudgetMs) !== 1200
    || raw?.streamSupported !== true
    || raw?.transportRequested !== probe?.transportRequested
    || raw?.transportEffective !== probe?.effectiveTransport
    || raw?.responseShapeStable !== true
    || raw?.errorShapeStable !== true
    || Number(raw?.connectionAttempts) !== 1
    || Number(raw?.connectionCount) !== 1
    || raw?.connectionOpened !== true
    || raw?.connectionClosed !== true
    || raw?.connectionOwner !== probe?.connectionOwner
    || Number(raw?.connectionGeneration) !== Number(probe?.connectionGeneration)
    || raw?.error != null
    || (strictLive && raw?.providerInputMode !== 'none')
    || (strictLive && raw?.responseMode !== 'text-only')
    || (strictLive && probe?.evidenceOutcome !== raw?.evidenceOutcome)
    || (strictLive && !sameCanonical(probe?.firstServerEvent, raw?.firstServerEvent))
  ) issues.push('provider preflight raw provider result does not match the top-level probe');
  const rawAuthorization = expectedAuthorization
    ? validateObservedAuthorization(
        raw?.preflightAuthorization,
        expectedAuthorization,
        'provider preflight raw result authorization',
        issues,
      )
    : null;
  const wireEvidence = strictLive
    ? validateLiveTranslateWireEvidence(root, probe, raw, issues)
    : null;
  const rawUsage = strictLive
    ? validateZeroInputUsage(raw, 'provider preflight raw result', issues)
    : validateTextOnlyTokenUsage(
      raw,
      signedTokenBudget,
      'provider preflight raw result',
      issues,
    );
  const checks = Array.isArray(raw?.checks) ? raw.checks : [];
  const expectedCheckKeys = ['streaming', 'latency', 'error-shape', 'response-shape'];
  if (
    JSON.stringify(checks.map((entry) => entry?.key)) !== JSON.stringify(expectedCheckKeys)
    || checks.some((entry) => (
      entry?.status !== 'pass'
      || !String(entry?.id ?? '').endsWith(`-${entry?.key}`)
    ))
  ) issues.push('provider preflight probe checks are not the four fixed pass checks');
  const config = readJson(path.join(bundleRoot, 'snapshots', 'config.json'), issues, 'provider preflight diagnostics config');
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const matches = providers.filter((provider) => (
    provider?.providerId === probe?.providerId && provider?.templateId === probe?.templateId
  ));
  if (matches.length !== 1) issues.push('provider preflight diagnostics must contain exactly one matching provider');
  const configured = matches[0];
  if (
    configured
    && (
      configured.kind !== STRICT_PROVIDER_KIND
      || configured.model !== probe?.configuredModel
      || configured.transport !== probe?.transportRequested
      || configured.streamEnabled !== true
      || configured.systemPromptTemplate !== STRICT_SYSTEM_PROMPT_TEMPLATE
      || !sameCanonical(configured.responseModalities, STRICT_RESPONSE_MODALITIES)
      || !sameCanonical(configured.customHeaders, [])
      || Number(configured.timeoutMs) !== STRICT_TIMEOUT_MS
      || Number(configured.temperature) !== STRICT_TEMPERATURE
      || Number(configured.maxOutputTokens) !== STRICT_MAX_OUTPUT_TOKENS
      || configured.authRef?.kind !== 'credential-ref'
      || configured.authRef?.headerName !== 'Authorization'
      || String(configured.authRef?.scheme ?? '').toLowerCase() !== 'bearer'
      || configured.authRef?.reference !== STRICT_PROVIDER_CREDENTIAL_REFERENCE
    )
  ) issues.push('provider preflight probe does not match diagnostics provider configuration');
  try {
    const configuredUrl = configured ? new URL(configured.baseUrl) : null;
    if (configuredUrl && (
      configuredUrl.protocol !== 'https:'
      || configuredUrl.username
      || configuredUrl.password
      || configuredUrl.port
      || configuredUrl.hostname !== STRICT_PROVIDER_ENDPOINT_HOST
      || configuredUrl.hostname !== probe?.endpointHost
    )) {
      issues.push('provider preflight endpoint host does not match configured base URL');
    }
  } catch { issues.push('provider preflight configured base URL is invalid'); }
  if (
    probe?.collectorId !== emitter?.collectorId
    || probe?.collectorVersion !== emitter?.collectorVersion
    || probe?.invocationId !== emitter?.invocationId
    || Number(probe?.desktopProcessId) !== Number(emitter?.desktopProcessId)
    || String(probe?.sourceHeadCommit ?? '').toLowerCase() !== String(emitter?.sourceHeadCommit ?? '').toLowerCase()
    || JSON.stringify(canonical(probe?.diagnosticsExport)) !== JSON.stringify(canonical(emitter?.diagnosticsExport))
    || probe?.credentialStatus?.backend !== 'windows-credential-manager'
    || probe?.credentialStatus?.exists !== true
  ) issues.push('provider preflight probe is not bound to emitter/credentials/diagnostics');
  const probeSummary = readJson(
    path.join(bundleRoot, 'snapshots', 'extra', 'provider-probe-summary.json'),
    issues,
    'provider preflight diagnostics provider-probe summary',
  );
  const diagnosticsAuthorization = expectedAuthorization
    ? validateObservedAuthorization(
        probeSummary?.preflightAuthorization,
        expectedAuthorization,
        'provider preflight diagnostics authorization',
        issues,
      )
    : null;
  const diagnosticsUsage = strictLive
    ? validateZeroInputUsage(probeSummary, 'provider preflight diagnostics summary', issues)
    : validateTextOnlyTokenUsage(
      probeSummary,
      signedTokenBudget,
      'provider preflight diagnostics summary',
      issues,
    );
  if (
    !String(probe?.configuredModel ?? '').trim()
    || probeSummary?.configuredModel !== probe?.configuredModel
    || probeSummary?.model !== probe?.model
    || probeSummary?.protocol !== probe?.protocol
    || raw?.configuredModel !== probe?.configuredModel
    || raw?.model !== probe?.model
    || raw?.protocol !== probe?.protocol
    || probeSummary?.providerConnectStartedAt !== probe?.providerConnectStartedAt
    || probeSummary?.providerConnectCompletedAt !== probe?.providerConnectCompletedAt
    || raw?.providerConnectStartedAt !== probe?.providerConnectStartedAt
    || raw?.providerConnectCompletedAt !== probe?.providerConnectCompletedAt
    || emitter?.providerConnectStartedAt !== probe?.providerConnectStartedAt
    || emitter?.providerConnectCompletedAt !== probe?.providerConnectCompletedAt
    || probeSummary?.transportEffective !== 'websocket'
  ) issues.push('provider preflight model/protocol/connect authority differs across raw three-layer evidence');
  if (
    !sameCanonical(probeUsage, emitterUsage)
    || !sameCanonical(probeUsage, rawUsage)
    || !sameCanonical(probeUsage, diagnosticsUsage)
  ) issues.push('provider preflight token/audio usage differs across raw three-layer evidence');
  if (expectedAuthorization && (
    !sameCanonical(probeAuthorization, emitterAuthorization)
    || !sameCanonical(probeAuthorization, rawAuthorization)
    || !sameCanonical(probeAuthorization, diagnosticsAuthorization)
  )) issues.push('provider preflight authorization consumption differs across raw three-layer evidence');
  const grantAt = Date.parse(String(expectedAuthorization?.grantGeneratedAt ?? ''));
  const reservationTimes = (expectedAuthorization?.reservationIssuedAts ?? [])
    .map((value) => Date.parse(String(value)));
  const observedAt = Date.parse(String(probeAuthorization?.authorizationObservedAt ?? ''));
  const claimAt = Date.parse(String(probeAuthorization?.consumptionClaim?.claimedAt ?? ''));
  const connectStartedAt = Date.parse(String(probe?.providerConnectStartedAt ?? ''));
  const checkedAt = evidenceTimestampInterval(probe?.checkedAt);
  const connectCompletedAt = Date.parse(String(probe?.providerConnectCompletedAt ?? ''));
  const emitterCompletedAt = Date.parse(String(emitter?.completedAt ?? ''));
  const expectedReservationCount = expectedAuthorization
    ? (expectedAuthorization.leaseReservationDigests?.length ?? 0)
    : 8;
  if (expectedAuthorization && (
    !Number.isFinite(grantAt)
    || reservationTimes.length !== expectedReservationCount
    || reservationTimes.some((value) => !Number.isFinite(value) || value <= grantAt)
    || !Number.isFinite(claimAt)
    || claimAt <= Math.max(...reservationTimes)
    || !Number.isFinite(observedAt)
    || observedAt <= Math.max(...reservationTimes)
    || observedAt >= claimAt
    || !Number.isFinite(connectStartedAt)
    || connectStartedAt <= observedAt
    || !checkedAt
    || checkedAt.end < connectStartedAt
    || !Number.isFinite(connectCompletedAt)
    || connectCompletedAt < checkedAt.start
    || !Number.isFinite(emitterCompletedAt)
    || emitterCompletedAt < connectCompletedAt
  )) issues.push('provider preflight signed authorization/connect timeline is invalid');
  if (expectedAuthorization && (
    probeAuthorization?.consumptionClaim?.desktopProcessId !== emitter?.desktopProcessId
    || probeAuthorization?.consumptionClaim?.desktopExecutablePath !== emitter?.desktopExecutable
    || probeAuthorization?.consumptionClaim?.desktopExecutableSha256 !== emitter?.desktopExecutableSha256
  )) issues.push('provider preflight consumption claim does not match the executing Desktop emitter');
  return {
    issues,
    summary: {
      providerId: probe?.providerId ?? null,
      model: probe?.model ?? null,
      configuredModel: probe?.configuredModel ?? null,
      operation: probe?.operation ?? null,
      inputMode: probe?.inputMode ?? null,
      providerInputMode: strictLive ? probe?.providerInputMode ?? null : null,
      responseMode: strictLive ? probe?.responseMode ?? null : null,
      terminalEvent: strictLive ? probe?.terminalEvent ?? null : null,
      externalAudioSamples: Number(probe?.externalAudioSamples ?? -1),
      providerInvocationCount: Number(probe?.providerInvocationCount ?? 0),
      protocol: probe?.protocol ?? null,
      executionId: probeAuthorization?.executionId ?? null,
      grantDigest: probeAuthorization?.grantDigest ?? null,
      leaseReservationDigests: probeAuthorization?.leaseReservationDigests ?? null,
      authorizationDigest: probeAuthorization?.authorizationDigest ?? null,
      consumptionClaim: probeAuthorization?.consumptionClaim ?? null,
      tokenBudget: strictLive ? null : probeAuthorization?.tokenBudget ?? null,
      lifecycleBudget: strictLive ? probeAuthorization?.lifecycleBudget ?? null : null,
      evidenceOutcome: wireEvidence?.evidenceOutcome ?? null,
      firstServerEvent: wireEvidence?.firstServerEvent ?? null,
      sessionAuthority: wireEvidence?.sessionAuthority ?? null,
      rawTrace: wireEvidence?.rawTrace ?? null,
      inputTokens: probeUsage.inputTokens,
      outputTokens: probeUsage.outputTokens,
      audioSeconds: probeUsage.audioSeconds,
      effectiveTransport: probe?.effectiveTransport ?? null,
      latencyMs: Number(probe?.latencyMs ?? 0),
      connectionAttempts: Number(probe?.connectionAttempts ?? 0),
      connectionCount: Number(probe?.connectionCount ?? 0),
      connectionOpened: probe?.connectionOpened === true,
      connectionClosed: probe?.connectionClosed === true,
      connectionOwner: probe?.connectionOwner ?? null,
      connectionGeneration: Number(probe?.connectionGeneration ?? 0),
      desktopProcessId: Number(probe?.desktopProcessId ?? 0),
    },
    evidenceTimes: [
      probeAuthorization?.authorizationObservedAt,
      probe?.providerConnectStartedAt,
      probe?.providerConnectCompletedAt,
      emitter?.completedAt,
    ].filter(Boolean),
  };
}
