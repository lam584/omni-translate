import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PROVIDER_PREFLIGHT_SCENARIO_ID = 'E2E-PROVIDER-PROBE';
export const PROVIDER_PREFLIGHT_OPERATION = 'text-translation-preflight';
export const PROVIDER_PREFLIGHT_INPUT_MODE = 'text-only';
export const PROVIDER_PREFLIGHT_INVOCATION_COUNT = 1;
export const PROVIDER_PREFLIGHT_EXTERNAL_AUDIO_SAMPLES = 0;

const ROOT_ENTRIES = Object.freeze([
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
  const exactFields = [
    'schemaVersion', 'artifactKind', 'executionId', 'grantDigest',
    'leaseReservationDigests', 'authorizationDigest', 'providerId', 'model',
    'protocol', 'operation', 'inputMode', 'invocationCount',
    'externalAudioSamples', 'leaseReservations', 'grantGeneratedAt',
    'reservationIssuedAts', 'consumptionClaim', 'tokenBudget',
  ];
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
  const rootEntries = fs.readdirSync(root).sort();
  if (JSON.stringify(rootEntries) !== JSON.stringify([...ROOT_ENTRIES].sort())) {
    issues.push(`provider preflight root entries must be exactly ${ROOT_ENTRIES.join(', ')}`);
  }
  try { walkFiles(root); } catch (error) { issues.push(error.message); }
  const emitter = readJson(path.join(root, 'emitter-result.json'), issues, 'provider preflight emitter result');
  const probe = readJson(path.join(root, 'provider-probe-result.json'), issues, 'provider preflight probe result');
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
  const expectedArtifacts = ['provider-probe-result.json', 'diagnostics-bundle'].map((relativePath) => ({
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
    || probe?.operation !== PROVIDER_PREFLIGHT_OPERATION
    || probe?.inputMode !== PROVIDER_PREFLIGHT_INPUT_MODE
    || Number(probe?.externalAudioSamples) !== PROVIDER_PREFLIGHT_EXTERNAL_AUDIO_SAMPLES
    || Number(probe?.providerInvocationCount) !== PROVIDER_PREFLIGHT_INVOCATION_COUNT
  ) issues.push('provider preflight probe is not one text-only zero-audio invocation');
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
  const signedTokenBudget = probeAuthorization?.tokenBudget
    ?? expectedAuthorization?.tokenBudget
    ?? {
      maxInputTokens: STRICT_MAX_INPUT_TOKENS,
      maxOutputTokens: STRICT_MAX_OUTPUT_TOKENS,
    };
  if (
    signedTokenBudget?.maxInputTokens !== STRICT_MAX_INPUT_TOKENS
    || signedTokenBudget?.maxOutputTokens !== STRICT_MAX_OUTPUT_TOKENS
  ) issues.push('provider preflight signed token budget is not the fixed text-only budget');
  const probeUsage = validateTextOnlyTokenUsage(
    probe,
    signedTokenBudget,
    'provider preflight probe',
    issues,
  );
  const emitterUsage = validateTextOnlyTokenUsage(
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
  ) issues.push('provider preflight raw provider result does not match the top-level probe');
  const rawAuthorization = expectedAuthorization
    ? validateObservedAuthorization(
        raw?.preflightAuthorization,
        expectedAuthorization,
        'provider preflight raw result authorization',
        issues,
      )
    : null;
  const rawUsage = validateTextOnlyTokenUsage(
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
  const diagnosticsUsage = validateTextOnlyTokenUsage(
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
      externalAudioSamples: Number(probe?.externalAudioSamples ?? -1),
      providerInvocationCount: Number(probe?.providerInvocationCount ?? 0),
      protocol: probe?.protocol ?? null,
      executionId: probeAuthorization?.executionId ?? null,
      grantDigest: probeAuthorization?.grantDigest ?? null,
      leaseReservationDigests: probeAuthorization?.leaseReservationDigests ?? null,
      authorizationDigest: probeAuthorization?.authorizationDigest ?? null,
      consumptionClaim: probeAuthorization?.consumptionClaim ?? null,
      tokenBudget: probeAuthorization?.tokenBudget ?? null,
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
