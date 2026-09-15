import {
  authorizeModelProtocolInvocation,
  loadModelProtocolRegistry,
} from './model-protocol-profile-contract.mjs';

export const WATCH_MODEL_PROTOCOL_REGION = 'cn-beijing';
export const WATCH_MODEL_PROTOCOL_OPERATION = 'native_translate';
export const WATCH_MODEL_PROTOCOL_TRANSPORT = 'websocket';
export const WATCH_MODEL_PROTOCOL_ENDPOINT_HOST = 'dashscope.aliyuncs.com';
export const WATCH_MODEL_PROTOCOL_IDENTITY_FIELDS = Object.freeze([
  'registryVersion',
  'profileId',
  'profileVersion',
  'operation',
  'transport',
  'region',
  'endpointFamily',
  'endpointPath',
  'wireDialect',
  'wireDialectVersion',
  'inputFraming',
  'outputFraming',
  'terminalLifecycle',
  'adapterId',
  'exactModelId',
]);

const freezeIdentity = (identity) => Object.freeze(Object.fromEntries(
  WATCH_MODEL_PROTOCOL_IDENTITY_FIELDS.map((field) => [field, identity[field]]),
));

export function authorizeWatchModelProtocolIdentity({
  exactModelId,
  region = WATCH_MODEL_PROTOCOL_REGION,
  endpointHost = WATCH_MODEL_PROTOCOL_ENDPOINT_HOST,
  registry = loadModelProtocolRegistry(),
} = {}) {
  const result = authorizeModelProtocolInvocation({
    exactModelId: String(exactModelId ?? '').trim(),
    operation: WATCH_MODEL_PROTOCOL_OPERATION,
    transport: WATCH_MODEL_PROTOCOL_TRANSPORT,
    region: String(region ?? '').trim(),
    endpointHost: String(endpointHost ?? '').trim().toLowerCase(),
    declaredRegistryVersion: registry.registryVersion,
  }, registry);
  if (!result.ok) return result;
  return {
    ok: true,
    identity: freezeIdentity(result.authorization),
  };
}

export function deriveWatchModelProtocolIdentity(exactModelId, options = {}) {
  const result = authorizeWatchModelProtocolIdentity({ exactModelId, ...options });
  if (!result.ok) {
    throw new Error(
      `Watch model protocol identity authorization failed for ${exactModelId || '(missing)'}: ${result.errorCode}`,
    );
  }
  return result.identity;
}

export function watchModelProtocolIdentityFailure(actual, expected, label = 'model protocol profile identity') {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    return `${label} is missing`;
  }
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return `${label} expected registry authority is missing`;
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = [...WATCH_MODEL_PROTOCOL_IDENTITY_FIELDS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    return `${label} fields do not match the exact registry-derived identity`;
  }
  for (const field of WATCH_MODEL_PROTOCOL_IDENTITY_FIELDS) {
    if (actual[field] !== expected[field]) return `${label} ${field} mismatch`;
  }
  return null;
}

export function assertWatchModelProtocolIdentity(actual, expected, label) {
  const failure = watchModelProtocolIdentityFailure(actual, expected, label);
  if (failure) throw new Error(failure);
  return actual;
}
