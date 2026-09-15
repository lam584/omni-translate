import registryDocument from '../../../../contracts/model-protocol-profiles.v1.json';

export type ModelProtocolOperation =
  | 'native_translate'
  | 'dialogue'
  | 'asr'
  | 'tts'
  | 'file_translate'
  | 'voice_clone';

export type ModelProtocolTransport = 'websocket' | 'webrtc' | 'aoq' | 'http' | 'sse';
export type ModelProtocolRegion = 'cn-beijing' | 'ap-southeast-1';

export type ModelProtocolAuthorizationErrorCode =
  | 'model_protocol.registry_version_mismatch'
  | 'model_protocol.model_not_registered'
  | 'model_protocol.profile_ambiguous'
  | 'model_protocol.profile_id_mismatch'
  | 'model_protocol.profile_version_mismatch'
  | 'model_protocol.operation_not_supported'
  | 'model_protocol.dialect_not_registered'
  | 'model_protocol.transport_mismatch'
  | 'model_protocol.endpoint_family_mismatch'
  | 'model_protocol.wire_dialect_mismatch'
  | 'model_protocol.terminal_lifecycle_mismatch'
  | 'model_protocol.region_not_supported'
  | 'model_protocol.endpoint_host_required'
  | 'model_protocol.endpoint_host_region_mismatch'
  | 'model_protocol.audio_input_codec_not_supported'
  | 'model_protocol.audio_input_sample_rate_not_supported'
  | 'model_protocol.audio_input_channels_not_supported'
  | 'model_protocol.audio_output_codec_not_supported'
  | 'model_protocol.audio_output_sample_rate_not_supported'
  | 'model_protocol.audio_output_channels_not_supported'
  | 'model_protocol.adapter_unavailable'
  | 'model_protocol.authorization_identity_mismatch'
  | 'model_protocol.event_not_allowed'
  | 'model_protocol.frame_kind_mismatch';

export interface ModelProtocolSource {
  url: string;
  checkedAt: string;
}

export interface ModelProtocolDialect {
  dialectId: string;
  dialectVersion: number;
  transport: ModelProtocolTransport;
  endpointFamily: string;
  endpointPath: string;
  modelPlacement: 'query' | 'payload' | 'path' | 'none';
  inputFraming: 'json-base64' | 'json-events' | 'binary' | 'json-events-and-binary' | 'http-body' | 'none';
  outputFraming: 'json-base64' | 'json-events' | 'binary' | 'json-events-and-binary' | 'http-body' | 'sse' | 'none';
  handshake: string[];
  turnControl: string;
  previewSemantics:
    | 'replaceable-snapshot'
    | 'append-delta'
    | 'mixed-by-event'
    | 'sentence-identity-replacement'
    | 'none';
  textEventSemantics: ModelProtocolTextEventSemantic[];
  commitSemantics: string;
  responseTrigger: string;
  terminalLifecycle:
    | 'session.finish->session.finished'
    | 'owner-close-after-response-drain'
    | 'finish-task->task-finished'
    | 'task-finished-after-one-shot'
    | 'Stop->Stopped'
    | 'http-response-complete'
    | 'sse-[DONE]';
  reusePolicy: 'single-session' | 'multi-turn-session' | 'sequential-tasks-after-terminal' | 'single-task' | 'single-request';
  regionPolicy: 'region-key-endpoint-model-must-match';
  audioInput: ModelProtocolAudioDirection;
  audioOutput: ModelProtocolAudioDirection;
  clientEventTypes: string[];
  serverEventTypes: string[];
  clientJsonBase64EventTypes: string[];
  clientBinaryEventTypes: string[];
  serverJsonBase64EventTypes: string[];
  serverBinaryEventTypes: string[];
  forbiddenClientEventTypes: string[];
  forbiddenServerEventTypes: string[];
  wireFixture: string;
  sources: ModelProtocolSource[];
}

export interface ModelProtocolTextEventSemantic {
  eventType: string;
  updateMode: 'replaceable-snapshot' | 'append-delta' | 'sentence-identity-replacement';
  identityKeys: string[];
  previewFields: string[];
  finalEventType: string;
}

export interface ModelProtocolAudioDirection {
  required: boolean;
  codecs: string[];
  sampleRatesHz: number[];
  channels: number[];
}

export type ModelProtocolSampleRateConstraint =
  | { kind: 'allow-list'; valuesHz: number[] }
  | { kind: 'any-positive-integer' }
  | { kind: 'not-applicable' };

export interface ModelProtocolProfileAudioDirection {
  required: boolean;
  codecs: string[];
  sampleRateConstraint: ModelProtocolSampleRateConstraint;
  channels: number[];
}

export interface ModelProtocolRequestedAudio {
  codec: string;
  sampleRateHz: number;
  channels: number;
}

export interface ModelProtocolProfile {
  profileId: string;
  profileVersion: number;
  product: string;
  exactModelIds: string[];
  operations: ModelProtocolOperation[];
  dialectId: string;
  regions: ModelProtocolRegion[];
  modelAudio?: {
    input: ModelProtocolProfileAudioDirection;
    output: ModelProtocolProfileAudioDirection;
  };
  adapter: {
    status: 'enabled' | 'manifest-only';
    adapterId: string | null;
    reason: string;
  };
  legacy: boolean;
  sources: ModelProtocolSource[];
}

export interface ModelProtocolRegistry {
  schemaVersion: 'model-protocol-profiles/v1';
  registryVersion: string;
  checkedAt: string;
  endpointHostPolicies: Array<{
    region: ModelProtocolRegion;
    allowedHostFamilies: Array<{
      hostFamilyId: string;
      hostPattern: string;
      workspaceScoped: boolean;
    }>;
    sources: ModelProtocolSource[];
  }>;
  dialects: ModelProtocolDialect[];
  profiles: ModelProtocolProfile[];
}

export interface ModelProtocolAuthorizationRequest {
  exactModelId: string;
  operation: ModelProtocolOperation;
  transport: ModelProtocolTransport;
  region: ModelProtocolRegion;
  endpointHost: string;
  audioInput?: ModelProtocolRequestedAudio;
  audioOutput?: ModelProtocolRequestedAudio;
  declaredRegistryVersion?: string;
  declaredProfileId?: string;
  declaredProfileVersion?: number;
  declaredWireDialect?: string;
  declaredEndpointFamily?: string;
  declaredTerminalLifecycle?: string;
}

export interface AuthorizedModelProtocolProfile {
  registryVersion: string;
  registryCheckedAt: string;
  providerFamily: 'bailian';
  exactModelId: string;
  profileId: string;
  profileVersion: number;
  product: string;
  operation: ModelProtocolOperation;
  transport: ModelProtocolTransport;
  region: ModelProtocolRegion;
  endpointHost: string;
  endpointHostFamilyId: string;
  endpointFamily: string;
  endpointPath: string;
  modelPlacement: ModelProtocolDialect['modelPlacement'];
  wireDialect: string;
  wireDialectVersion: number;
  inputFraming: ModelProtocolDialect['inputFraming'];
  outputFraming: ModelProtocolDialect['outputFraming'];
  turnControl: string;
  previewSemantics: ModelProtocolDialect['previewSemantics'];
  textEventSemantics: ModelProtocolTextEventSemantic[];
  commitSemantics: string;
  responseTrigger: string;
  terminalLifecycle: ModelProtocolDialect['terminalLifecycle'];
  reusePolicy: ModelProtocolDialect['reusePolicy'];
  regionPolicy: ModelProtocolDialect['regionPolicy'];
  audioInput: ModelProtocolAudioDirection;
  audioOutput: ModelProtocolAudioDirection;
  audioInputConstraint: ModelProtocolProfileAudioDirection;
  audioOutputConstraint: ModelProtocolProfileAudioDirection;
  clientEventTypes: string[];
  serverEventTypes: string[];
  clientJsonBase64EventTypes: string[];
  clientBinaryEventTypes: string[];
  serverJsonBase64EventTypes: string[];
  serverBinaryEventTypes: string[];
  adapterId: string;
  wireFixture: string;
}

export type ModelProtocolAuthorizationResult =
  | { ok: true; authorization: AuthorizedModelProtocolProfile }
  | { ok: false; errorCode: ModelProtocolAuthorizationErrorCode };

export type ModelProtocolEventDirection = 'client' | 'server';
export type ModelProtocolFrameKind = 'json' | 'json-base64' | 'binary' | 'http-body' | 'sse';

export interface ModelProtocolEventAdmissionRequest {
  direction: ModelProtocolEventDirection;
  eventType: string;
  frameKind: ModelProtocolFrameKind;
}

export type ModelProtocolEventAdmissionResult =
  | {
      ok: true;
      admission: {
        profileId: string;
        profileVersion: number;
        wireDialect: string;
        direction: ModelProtocolEventDirection;
        eventType: string;
        frameKind: ModelProtocolFrameKind;
      };
    }
  | { ok: false; errorCode: ModelProtocolAuthorizationErrorCode };

export const MODEL_PROTOCOL_REGISTRY = registryDocument as unknown as ModelProtocolRegistry;

function rejected(errorCode: ModelProtocolAuthorizationErrorCode): {
  ok: false;
  errorCode: ModelProtocolAuthorizationErrorCode;
} {
  return { ok: false, errorCode };
}

/**
 * Exact registry lookup for display and migration diagnostics. The result is
 * not connection authority; callers must use authorizeModelProtocolInvocation.
 */
export function lookupModelProtocolProfiles(
  exactModelId: string,
  registry: ModelProtocolRegistry = MODEL_PROTOCOL_REGISTRY,
): readonly ModelProtocolProfile[] {
  if (!exactModelId || exactModelId !== exactModelId.trim()) return [];
  return registry.profiles.filter((profile) => profile.exactModelIds.includes(exactModelId));
}

function hostMatchesPattern(host: string, pattern: string): boolean {
  if (!pattern.startsWith('*.')) return host === pattern;
  const suffix = pattern.slice(1);
  if (!host.endsWith(suffix)) return false;
  const prefix = host.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix);
}

function resolveEndpointHostFamily(
  registry: ModelProtocolRegistry,
  region: ModelProtocolRegion,
  endpointHost: string,
): { endpointHost: string; endpointHostFamilyId: string } | null {
  const normalizedHost = endpointHost.trim().toLowerCase();
  if (!normalizedHost || !/^[a-z0-9.-]+$/.test(normalizedHost)) return null;
  const policy = registry.endpointHostPolicies.find((candidate) => candidate.region === region);
  const rule = policy?.allowedHostFamilies.find((candidate) => (
    hostMatchesPattern(normalizedHost, candidate.hostPattern)
  ));
  return rule
    ? { endpointHost: normalizedHost, endpointHostFamilyId: rule.hostFamilyId }
    : null;
}

function materializeAudioConstraint(
  profileConstraint: ModelProtocolProfileAudioDirection | undefined,
  dialectDirection: ModelProtocolAudioDirection,
): ModelProtocolProfileAudioDirection {
  if (profileConstraint) {
    return {
      ...profileConstraint,
      codecs: [...profileConstraint.codecs],
      sampleRateConstraint: profileConstraint.sampleRateConstraint.kind === 'allow-list'
        ? {
            kind: 'allow-list',
            valuesHz: [...profileConstraint.sampleRateConstraint.valuesHz],
          }
        : { ...profileConstraint.sampleRateConstraint },
      channels: [...profileConstraint.channels],
    };
  }
  return {
    required: dialectDirection.required,
    codecs: [...dialectDirection.codecs],
    sampleRateConstraint: !dialectDirection.required && dialectDirection.sampleRatesHz.length === 0
      ? { kind: 'not-applicable' }
      : { kind: 'allow-list', valuesHz: [...dialectDirection.sampleRatesHz] },
    channels: [...dialectDirection.channels],
  };
}

function requestedAudioFailure(
  requested: ModelProtocolRequestedAudio | undefined,
  constraint: ModelProtocolProfileAudioDirection,
  direction: 'input' | 'output',
): ModelProtocolAuthorizationErrorCode | null {
  if (!requested) return null;
  if (!constraint.codecs.includes(requested.codec)) {
    return `model_protocol.audio_${direction}_codec_not_supported`;
  }
  const sampleRateAllowed = constraint.sampleRateConstraint.kind === 'allow-list'
    ? constraint.sampleRateConstraint.valuesHz.includes(requested.sampleRateHz)
    : constraint.sampleRateConstraint.kind === 'any-positive-integer'
      ? Number.isInteger(requested.sampleRateHz) && requested.sampleRateHz > 0
      : false;
  if (!sampleRateAllowed) return `model_protocol.audio_${direction}_sample_rate_not_supported`;
  if (!constraint.channels.includes(requested.channels)) {
    return `model_protocol.audio_${direction}_channels_not_supported`;
  }
  return null;
}

/**
 * Produces the complete invocation authority or a stable fail-closed error.
 * Model names are matched byte-for-byte; no family, substring, template, or
 * capability fallback is consulted.
 */
export function authorizeModelProtocolInvocation(
  request: ModelProtocolAuthorizationRequest,
  registry: ModelProtocolRegistry = MODEL_PROTOCOL_REGISTRY,
): ModelProtocolAuthorizationResult {
  if (
    request.declaredRegistryVersion !== undefined
    && request.declaredRegistryVersion !== registry.registryVersion
  ) {
    return rejected('model_protocol.registry_version_mismatch');
  }

  const candidates = lookupModelProtocolProfiles(request.exactModelId, registry);
  if (candidates.length === 0) return rejected('model_protocol.model_not_registered');

  let profile: ModelProtocolProfile | undefined;
  if (request.declaredProfileId !== undefined) {
    profile = candidates.find((candidate) => candidate.profileId === request.declaredProfileId);
    if (!profile) return rejected('model_protocol.profile_id_mismatch');
  } else if (candidates.length === 1) {
    [profile] = candidates;
  } else {
    return rejected('model_protocol.profile_ambiguous');
  }

  if (
    request.declaredProfileVersion !== undefined
    && request.declaredProfileVersion !== profile.profileVersion
  ) {
    return rejected('model_protocol.profile_version_mismatch');
  }
  if (!profile.operations.includes(request.operation)) {
    return rejected('model_protocol.operation_not_supported');
  }

  const dialect = registry.dialects.find((candidate) => candidate.dialectId === profile.dialectId);
  if (!dialect) return rejected('model_protocol.dialect_not_registered');
  if (dialect.transport !== request.transport) return rejected('model_protocol.transport_mismatch');
  if (
    request.declaredEndpointFamily !== undefined
    && request.declaredEndpointFamily !== dialect.endpointFamily
  ) {
    return rejected('model_protocol.endpoint_family_mismatch');
  }
  if (
    request.declaredWireDialect !== undefined
    && request.declaredWireDialect !== dialect.dialectId
  ) {
    return rejected('model_protocol.wire_dialect_mismatch');
  }
  if (
    request.declaredTerminalLifecycle !== undefined
    && request.declaredTerminalLifecycle !== dialect.terminalLifecycle
  ) {
    return rejected('model_protocol.terminal_lifecycle_mismatch');
  }
  if (!profile.regions.includes(request.region)) return rejected('model_protocol.region_not_supported');
  if (!request.endpointHost) return rejected('model_protocol.endpoint_host_required');
  const endpointAuthority = resolveEndpointHostFamily(registry, request.region, request.endpointHost);
  if (!endpointAuthority) return rejected('model_protocol.endpoint_host_region_mismatch');
  const audioInputConstraint = materializeAudioConstraint(
    profile.modelAudio?.input,
    dialect.audioInput,
  );
  const audioOutputConstraint = materializeAudioConstraint(
    profile.modelAudio?.output,
    dialect.audioOutput,
  );
  const inputAudioFailure = requestedAudioFailure(
    request.audioInput,
    audioInputConstraint,
    'input',
  );
  if (inputAudioFailure) return rejected(inputAudioFailure);
  const outputAudioFailure = requestedAudioFailure(
    request.audioOutput,
    audioOutputConstraint,
    'output',
  );
  if (outputAudioFailure) return rejected(outputAudioFailure);
  if (profile.adapter.status !== 'enabled' || !profile.adapter.adapterId) {
    return rejected('model_protocol.adapter_unavailable');
  }

  return {
    ok: true,
    authorization: {
      registryVersion: registry.registryVersion,
      registryCheckedAt: registry.checkedAt,
      providerFamily: 'bailian',
      exactModelId: request.exactModelId,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      product: profile.product,
      operation: request.operation,
      transport: dialect.transport,
      region: request.region,
      endpointHost: endpointAuthority.endpointHost,
      endpointHostFamilyId: endpointAuthority.endpointHostFamilyId,
      endpointFamily: dialect.endpointFamily,
      endpointPath: dialect.endpointPath,
      modelPlacement: dialect.modelPlacement,
      wireDialect: dialect.dialectId,
      wireDialectVersion: dialect.dialectVersion,
      inputFraming: dialect.inputFraming,
      outputFraming: dialect.outputFraming,
      turnControl: dialect.turnControl,
      previewSemantics: dialect.previewSemantics,
      textEventSemantics: dialect.textEventSemantics.map((semantic) => ({
        ...semantic,
        identityKeys: [...semantic.identityKeys],
        previewFields: [...semantic.previewFields],
      })),
      commitSemantics: dialect.commitSemantics,
      responseTrigger: dialect.responseTrigger,
      terminalLifecycle: dialect.terminalLifecycle,
      reusePolicy: dialect.reusePolicy,
      regionPolicy: dialect.regionPolicy,
      audioInput: {
        ...dialect.audioInput,
        codecs: [...dialect.audioInput.codecs],
        sampleRatesHz: [...dialect.audioInput.sampleRatesHz],
        channels: [...dialect.audioInput.channels],
      },
      audioOutput: {
        ...dialect.audioOutput,
        codecs: [...dialect.audioOutput.codecs],
        sampleRatesHz: [...dialect.audioOutput.sampleRatesHz],
        channels: [...dialect.audioOutput.channels],
      },
      audioInputConstraint,
      audioOutputConstraint,
      clientEventTypes: [...dialect.clientEventTypes],
      serverEventTypes: [...dialect.serverEventTypes],
      clientJsonBase64EventTypes: [...dialect.clientJsonBase64EventTypes],
      clientBinaryEventTypes: [...dialect.clientBinaryEventTypes],
      serverJsonBase64EventTypes: [...dialect.serverJsonBase64EventTypes],
      serverBinaryEventTypes: [...dialect.serverBinaryEventTypes],
      adapterId: profile.adapter.adapterId,
      wireFixture: dialect.wireFixture,
    },
  };
}

function expectedEventFrameKind(
  dialect: ModelProtocolDialect,
  direction: ModelProtocolEventDirection,
  eventType: string,
): ModelProtocolFrameKind {
  const binaryEvents = direction === 'client'
    ? dialect.clientBinaryEventTypes
    : dialect.serverBinaryEventTypes;
  if (binaryEvents.includes(eventType)) return 'binary';
  const base64Events = direction === 'client'
    ? dialect.clientJsonBase64EventTypes
    : dialect.serverJsonBase64EventTypes;
  if (base64Events.includes(eventType)) return 'json-base64';
  return 'json';
}

/**
 * Sealed event admission for an already-authorized invocation. Socket event
 * processors call this before mutating cue, report, playback, or lifecycle
 * state; admission is driven by the profile allowlist and framing tables.
 */
export function admitModelProtocolEvent(
  authorization: AuthorizedModelProtocolProfile,
  request: ModelProtocolEventAdmissionRequest,
  registry: ModelProtocolRegistry = MODEL_PROTOCOL_REGISTRY,
): ModelProtocolEventAdmissionResult {
  const profile = registry.profiles.find((candidate) =>
    candidate.profileId === authorization.profileId
    && candidate.profileVersion === authorization.profileVersion
    && candidate.exactModelIds.includes(authorization.exactModelId));
  const dialect = registry.dialects.find((candidate) => candidate.dialectId === authorization.wireDialect);
  const endpointAuthority = resolveEndpointHostFamily(
    registry,
    authorization.region,
    authorization.endpointHost,
  );
  const expectedAudioInputConstraint = profile && dialect
    ? materializeAudioConstraint(profile.modelAudio?.input, dialect.audioInput)
    : null;
  const expectedAudioOutputConstraint = profile && dialect
    ? materializeAudioConstraint(profile.modelAudio?.output, dialect.audioOutput)
    : null;
  if (
    registry.registryVersion !== authorization.registryVersion
    || !profile
    || !dialect
    || profile.dialectId !== dialect.dialectId
    || dialect.dialectVersion !== authorization.wireDialectVersion
    || dialect.transport !== authorization.transport
    || dialect.endpointFamily !== authorization.endpointFamily
    || dialect.terminalLifecycle !== authorization.terminalLifecycle
    || !endpointAuthority
    || endpointAuthority.endpointHost !== authorization.endpointHost
    || endpointAuthority.endpointHostFamilyId !== authorization.endpointHostFamilyId
    || JSON.stringify(expectedAudioInputConstraint) !== JSON.stringify(authorization.audioInputConstraint)
    || JSON.stringify(expectedAudioOutputConstraint) !== JSON.stringify(authorization.audioOutputConstraint)
    || profile.adapter.status !== 'enabled'
    || profile.adapter.adapterId !== authorization.adapterId
  ) {
    return rejected('model_protocol.authorization_identity_mismatch');
  }

  const allowedEvents = request.direction === 'client'
    ? dialect.clientEventTypes
    : dialect.serverEventTypes;
  if (!allowedEvents.includes(request.eventType)) {
    return rejected('model_protocol.event_not_allowed');
  }
  if (expectedEventFrameKind(dialect, request.direction, request.eventType) !== request.frameKind) {
    return rejected('model_protocol.frame_kind_mismatch');
  }

  return {
    ok: true,
    admission: {
      profileId: authorization.profileId,
      profileVersion: authorization.profileVersion,
      wireDialect: authorization.wireDialect,
      direction: request.direction,
      eventType: request.eventType,
      frameKind: request.frameKind,
    },
  };
}
