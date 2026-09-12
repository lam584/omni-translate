import fs from 'node:fs';
import path from 'node:path';

export const MODEL_PROTOCOL_REGISTRY_PATH = path.join('contracts', 'model-protocol-profiles.v1.json');
export const MODEL_PROTOCOL_SCHEMA_PATH = path.join('contracts', 'model-protocol-profiles.schema.json');
export const MODEL_PROTOCOL_EVENT_CATALOG_PATH = path.join(
  'contracts',
  'model-protocol-official-event-catalog.v1.json',
);
export const MODEL_PROTOCOL_AUTHORIZATION_VECTORS_PATH = path.join(
  'contracts',
  'model-protocol-authorization-v1.vectors.json',
);

const EXPECTED_SCHEMA_VERSION = 'model-protocol-profiles/v1';
const EXPECTED_REGISTRY_VERSION = 'bailian-model-protocol-registry/v1';
const EXPECTED_CHECKED_AT = '2026-08-30';
const OFFICIAL_SOURCE_PREFIX = 'https://help.aliyun.com/zh/model-studio/';
const APPROVED_ENABLED_ADAPTERS = new Map([
  [
    'desktop-livetranslate-session-v1',
    {
      profileId: 'bailian.livetranslate.realtime.ws',
      dialectId: 'bailian-livetranslate-session-ws-v1',
      terminalLifecycle: 'session.finish->session.finished',
    },
  ],
]);

const AUTHORIZATION_ERRORS = Object.freeze({
  registryVersionMismatch: 'model_protocol.registry_version_mismatch',
  modelNotRegistered: 'model_protocol.model_not_registered',
  profileAmbiguous: 'model_protocol.profile_ambiguous',
  profileIdMismatch: 'model_protocol.profile_id_mismatch',
  profileVersionMismatch: 'model_protocol.profile_version_mismatch',
  operationNotSupported: 'model_protocol.operation_not_supported',
  dialectNotRegistered: 'model_protocol.dialect_not_registered',
  transportMismatch: 'model_protocol.transport_mismatch',
  endpointFamilyMismatch: 'model_protocol.endpoint_family_mismatch',
  wireDialectMismatch: 'model_protocol.wire_dialect_mismatch',
  terminalLifecycleMismatch: 'model_protocol.terminal_lifecycle_mismatch',
  regionNotSupported: 'model_protocol.region_not_supported',
  endpointHostRequired: 'model_protocol.endpoint_host_required',
  endpointHostRegionMismatch: 'model_protocol.endpoint_host_region_mismatch',
  audioInputCodecNotSupported: 'model_protocol.audio_input_codec_not_supported',
  audioInputSampleRateNotSupported: 'model_protocol.audio_input_sample_rate_not_supported',
  audioInputChannelsNotSupported: 'model_protocol.audio_input_channels_not_supported',
  audioOutputCodecNotSupported: 'model_protocol.audio_output_codec_not_supported',
  audioOutputSampleRateNotSupported: 'model_protocol.audio_output_sample_rate_not_supported',
  audioOutputChannelsNotSupported: 'model_protocol.audio_output_channels_not_supported',
  adapterUnavailable: 'model_protocol.adapter_unavailable',
});

function readJson(workspaceRoot, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8'));
}

function rejected(errorCode) {
  return { ok: false, errorCode };
}

function arrayHasDuplicates(values) {
  return new Set(values).size !== values.length;
}

function indexOfEvent(sequence, direction, eventType) {
  return sequence.findIndex((entry) => entry.direction === direction && entry.eventType === eventType);
}

function indexOfLayeredEvent(sequence, direction, outerEventType, innerEventType = null) {
  return sequence.findIndex((entry) =>
    entry.direction === direction
    && entry.eventType === outerEventType
    && (innerEventType === null || entry.innerEventType === innerEventType));
}

function hostMatchesPattern(host, pattern) {
  if (!pattern.startsWith('*.')) return host === pattern;
  const suffix = pattern.slice(1);
  if (!host.endsWith(suffix)) return false;
  const prefix = host.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix);
}

function resolveEndpointHostFamily(registry, region, endpointHost) {
  const normalized = String(endpointHost ?? '').trim().toLowerCase();
  if (!normalized || !/^[a-z0-9.-]+$/.test(normalized)) return null;
  const policy = registry.endpointHostPolicies?.find((candidate) => candidate.region === region);
  const rule = policy?.allowedHostFamilies?.find((candidate) =>
    hostMatchesPattern(normalized, candidate.hostPattern));
  return rule ? { endpointHost: normalized, endpointHostFamilyId: rule.hostFamilyId } : null;
}

function materializeAudioConstraint(profileConstraint, dialectDirection) {
  if (profileConstraint) return structuredClone(profileConstraint);
  if (!dialectDirection.required && dialectDirection.sampleRatesHz.length === 0) {
    return {
      required: false,
      codecs: [...dialectDirection.codecs],
      sampleRateConstraint: { kind: 'not-applicable' },
      channels: [...dialectDirection.channels],
    };
  }
  return {
    required: dialectDirection.required,
    codecs: [...dialectDirection.codecs],
    sampleRateConstraint: {
      kind: 'allow-list',
      valuesHz: [...dialectDirection.sampleRatesHz],
    },
    channels: [...dialectDirection.channels],
  };
}

function validateRequestedAudio(requested, constraint, direction) {
  if (requested === undefined) return null;
  const prefix = direction === 'input' ? 'audioInput' : 'audioOutput';
  if (!constraint.codecs.includes(requested.codec)) {
    return AUTHORIZATION_ERRORS[`${prefix}CodecNotSupported`];
  }
  const rateConstraint = constraint.sampleRateConstraint;
  if (
    !Number.isInteger(requested.sampleRateHz)
    || requested.sampleRateHz <= 0
    || rateConstraint.kind === 'not-applicable'
    || (
      rateConstraint.kind === 'allow-list'
      && !rateConstraint.valuesHz.includes(requested.sampleRateHz)
    )
  ) {
    return AUTHORIZATION_ERRORS[`${prefix}SampleRateNotSupported`];
  }
  if (!constraint.channels.includes(requested.channels)) {
    return AUTHORIZATION_ERRORS[`${prefix}ChannelsNotSupported`];
  }
  return null;
}

function expectedFrameKind(dialect, direction, eventType) {
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

function validateTerminalFixture(dialect, sequence, failures) {
  const order = (clientEvent, serverEvent) => {
    const clientIndex = indexOfEvent(sequence, 'client', clientEvent);
    const serverIndex = indexOfEvent(sequence, 'server', serverEvent);
    if (clientIndex < 0 || serverIndex < 0 || clientIndex >= serverIndex) {
      failures.push(
        `${dialect.dialectId}: fixture must preserve ${clientEvent} < ${serverEvent}`,
      );
    }
  };
  switch (dialect.terminalLifecycle) {
    case 'session.finish->session.finished':
      order('session.finish', 'session.finished');
      break;
    case 'finish-task->task-finished':
      order('finish-task', 'task-finished');
      break;
    case 'task-finished-after-one-shot':
      order('run-task', 'task-finished');
      break;
    case 'Stop->Stopped':
      {
        const stopIndex = indexOfLayeredEvent(sequence, 'client', 'finish-task', 'Stop');
        const stoppedIndex = indexOfLayeredEvent(
          sequence,
          'server',
          'result-generated',
          'Stopped',
        );
        if (stopIndex < 0 || stoppedIndex < 0 || stopIndex >= stoppedIndex) {
          failures.push(
            `${dialect.dialectId}: fixture must preserve finish-task/Stop < result-generated/Stopped`,
          );
        }
      }
      break;
    case 'owner-close-after-response-drain':
      if (indexOfEvent(sequence, 'server', 'response.done') < 0) {
        failures.push(`${dialect.dialectId}: owner-close fixture must cover response.done drain`);
      }
      if (indexOfEvent(sequence, 'server', 'session.finished') >= 0) {
        failures.push(`${dialect.dialectId}: owner-close fixture must not invent session.finished`);
      }
      break;
    default:
      failures.push(`${dialect.dialectId}: unsupported terminal lifecycle in v1 fixture gate`);
  }
}

function valueAtPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], value);
}

function fixtureTaskId(event) {
  return event.wire?.header?.task_id ?? event.activeTaskId ?? null;
}

function validateSequentialTaskReuseFixture(dialect, fixture, failures) {
  const sequence = fixture.sequence;
  const runIndexes = sequence
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.direction === 'client' && event.eventType === 'run-task');
  if (runIndexes.length < 2) {
    failures.push(`${dialect.dialectId}: reusable task fixture must contain two sequential tasks`);
    return;
  }
  const firstTaskId = fixtureTaskId(runIndexes[0].event);
  const secondTaskId = fixtureTaskId(runIndexes[1].event);
  if (!firstTaskId || !secondTaskId || firstTaskId === secondTaskId) {
    failures.push(`${dialect.dialectId}: reused connection must use a fresh task_id`);
  }
  const firstFinishedIndex = sequence.findIndex((event, index) =>
    index > runIndexes[0].index
    && index < runIndexes[1].index
    && event.direction === 'server'
    && event.eventType === 'task-finished'
    && fixtureTaskId(event) === firstTaskId);
  if (firstFinishedIndex < 0) {
    failures.push(
      `${dialect.dialectId}: second run-task must follow the first task-finished on the same connection`,
    );
  }
  const secondFinishedIndex = sequence.findIndex((event, index) =>
    index > runIndexes[1].index
    && event.direction === 'server'
    && event.eventType === 'task-finished'
    && fixtureTaskId(event) === secondTaskId);
  if (secondFinishedIndex < 0) {
    failures.push(`${dialect.dialectId}: second task must reach its own task-finished`);
  }
  if (fixture.expect?.failureInvalidatesConnection !== true) {
    failures.push(`${dialect.dialectId}: fixture must assert task-failed invalidates the connection`);
  }
}

function validateMultimodalFixture(dialect, fixture, failures) {
  const sequence = fixture.sequence;
  const startIndex = indexOfLayeredEvent(sequence, 'client', 'run-task', 'Start');
  const startedIndex = indexOfLayeredEvent(sequence, 'server', 'result-generated', 'Started');
  const listeningIndex = sequence.findIndex((event) =>
    event.direction === 'server'
    && event.eventType === 'result-generated'
    && event.innerEventType === 'DialogStateChanged'
    && valueAtPath(event.wire, 'payload.output.state') === 'Listening');
  const firstClientAudioIndex = indexOfEvent(sequence, 'client', 'binary.audio');
  if (
    startIndex < 0
    || startedIndex <= startIndex
    || listeningIndex <= startedIndex
    || firstClientAudioIndex <= listeningIndex
  ) {
    failures.push(
      `${dialect.dialectId}: fixture must preserve Start < Started < Listening < binary audio`,
    );
  }
  const start = sequence[startIndex]?.wire;
  if (
    start?.header?.action !== 'run-task'
    || start?.payload?.input?.directive !== 'Start'
    || typeof start?.payload?.input?.workspace_id !== 'string'
    || typeof start?.payload?.input?.app_id !== 'string'
  ) {
    failures.push(`${dialect.dialectId}: Start fixture must carry outer run-task plus workspace_id/app_id`);
  }
  if (fixture.expect?.startedIsAudioReady !== false) {
    failures.push(`${dialect.dialectId}: fixture must prove Started alone is not media-ready`);
  }
}

export function loadModelProtocolRegistry(workspaceRoot = process.cwd()) {
  return readJson(workspaceRoot, MODEL_PROTOCOL_REGISTRY_PATH);
}

export function loadModelProtocolEventCatalog(workspaceRoot = process.cwd()) {
  return readJson(workspaceRoot, MODEL_PROTOCOL_EVENT_CATALOG_PATH);
}

/**
 * Pure pre-resource authorization used by offline tooling. Runtime TS and Rust
 * expose the same API and are checked against the shared vectors.
 */
export function authorizeModelProtocolInvocation(request, registry) {
  if (
    request.declaredRegistryVersion !== undefined
    && request.declaredRegistryVersion !== registry.registryVersion
  ) return rejected(AUTHORIZATION_ERRORS.registryVersionMismatch);

  const candidates = registry.profiles.filter((profile) =>
    profile.exactModelIds.includes(request.exactModelId));
  if (candidates.length === 0) return rejected(AUTHORIZATION_ERRORS.modelNotRegistered);

  let profile;
  if (request.declaredProfileId !== undefined) {
    profile = candidates.find((candidate) => candidate.profileId === request.declaredProfileId);
    if (!profile) return rejected(AUTHORIZATION_ERRORS.profileIdMismatch);
  } else if (candidates.length === 1) {
    [profile] = candidates;
  } else {
    return rejected(AUTHORIZATION_ERRORS.profileAmbiguous);
  }

  if (
    request.declaredProfileVersion !== undefined
    && request.declaredProfileVersion !== profile.profileVersion
  ) return rejected(AUTHORIZATION_ERRORS.profileVersionMismatch);
  if (!profile.operations.includes(request.operation)) {
    return rejected(AUTHORIZATION_ERRORS.operationNotSupported);
  }

  const dialect = registry.dialects.find((candidate) => candidate.dialectId === profile.dialectId);
  if (!dialect) return rejected(AUTHORIZATION_ERRORS.dialectNotRegistered);
  if (dialect.transport !== request.transport) return rejected(AUTHORIZATION_ERRORS.transportMismatch);
  if (
    request.declaredEndpointFamily !== undefined
    && request.declaredEndpointFamily !== dialect.endpointFamily
  ) return rejected(AUTHORIZATION_ERRORS.endpointFamilyMismatch);
  if (
    request.declaredWireDialect !== undefined
    && request.declaredWireDialect !== dialect.dialectId
  ) return rejected(AUTHORIZATION_ERRORS.wireDialectMismatch);
  if (
    request.declaredTerminalLifecycle !== undefined
    && request.declaredTerminalLifecycle !== dialect.terminalLifecycle
  ) return rejected(AUTHORIZATION_ERRORS.terminalLifecycleMismatch);
  if (!profile.regions.includes(request.region)) return rejected(AUTHORIZATION_ERRORS.regionNotSupported);

  if (!request.endpointHost) return rejected(AUTHORIZATION_ERRORS.endpointHostRequired);
  const endpointAuthority = resolveEndpointHostFamily(
    registry,
    request.region,
    request.endpointHost,
  );
  if (!endpointAuthority) return rejected(AUTHORIZATION_ERRORS.endpointHostRegionMismatch);

  const audioInputConstraint = materializeAudioConstraint(
    profile.modelAudio?.input,
    dialect.audioInput,
  );
  const audioOutputConstraint = materializeAudioConstraint(
    profile.modelAudio?.output,
    dialect.audioOutput,
  );
  const inputAudioFailure = validateRequestedAudio(
    request.audioInput,
    audioInputConstraint,
    'input',
  );
  if (inputAudioFailure) return rejected(inputAudioFailure);
  const outputAudioFailure = validateRequestedAudio(
    request.audioOutput,
    audioOutputConstraint,
    'output',
  );
  if (outputAudioFailure) return rejected(outputAudioFailure);

  if (profile.adapter.status !== 'enabled' || !profile.adapter.adapterId) {
    return rejected(AUTHORIZATION_ERRORS.adapterUnavailable);
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
      textEventSemantics: structuredClone(dialect.textEventSemantics),
      commitSemantics: dialect.commitSemantics,
      responseTrigger: dialect.responseTrigger,
      terminalLifecycle: dialect.terminalLifecycle,
      reusePolicy: dialect.reusePolicy,
      regionPolicy: dialect.regionPolicy,
      audioInput: structuredClone(dialect.audioInput),
      audioOutput: structuredClone(dialect.audioOutput),
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

export function validateModelProtocolRegistry({
  workspaceRoot = process.cwd(),
  registry = loadModelProtocolRegistry(workspaceRoot),
  eventCatalog = loadModelProtocolEventCatalog(workspaceRoot),
  fixtureOverrides = new Map(),
} = {}) {
  const failures = [];
  if (registry.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    failures.push(`schemaVersion must equal ${EXPECTED_SCHEMA_VERSION}`);
  }
  if (registry.registryVersion !== EXPECTED_REGISTRY_VERSION) {
    failures.push(`registryVersion must equal ${EXPECTED_REGISTRY_VERSION}`);
  }
  if (registry.checkedAt !== EXPECTED_CHECKED_AT) {
    failures.push(`registry checkedAt must equal ${EXPECTED_CHECKED_AT}`);
  }
  if (!Array.isArray(registry.dialects) || registry.dialects.length === 0) {
    failures.push('dialects must be a non-empty array');
    return failures;
  }
  if (!Array.isArray(registry.profiles) || registry.profiles.length === 0) {
    failures.push('profiles must be a non-empty array');
    return failures;
  }

  if (
    eventCatalog.schemaVersion !== 'model-protocol-official-event-catalog/v1'
    || eventCatalog.checkedAt !== EXPECTED_CHECKED_AT
    || !Array.isArray(eventCatalog.catalogs)
  ) {
    failures.push('official event catalog identity/check date/catalogs do not match v1');
    return failures;
  }

  if (!Array.isArray(registry.endpointHostPolicies) || registry.endpointHostPolicies.length === 0) {
    failures.push('endpointHostPolicies must be a non-empty region authority array');
  } else {
    const expectedEndpointHosts = new Map([
      ['cn-beijing', new Map([
        ['dashscope.aliyuncs.com', false],
        ['*.cn-beijing.maas.aliyuncs.com', true],
      ])],
      ['ap-southeast-1', new Map([
        ['dashscope-intl.aliyuncs.com', false],
        ['*.ap-southeast-1.maas.aliyuncs.com', true],
      ])],
    ]);
    const policyRegions = registry.endpointHostPolicies.map((policy) => policy.region);
    if (arrayHasDuplicates(policyRegions)) failures.push('endpoint host policy regions must be unique');
    for (const [region, expectedRules] of expectedEndpointHosts) {
      const policy = registry.endpointHostPolicies.find((candidate) => candidate.region === region);
      if (!policy) {
        failures.push(`${region}: endpoint host policy is missing`);
        continue;
      }
      const patterns = policy.allowedHostFamilies?.map((rule) => rule.hostPattern) ?? [];
      if (arrayHasDuplicates(patterns)) failures.push(`${region}: endpoint host patterns must be unique`);
      if (patterns.length !== expectedRules.size) {
        failures.push(`${region}: endpoint host policy must contain only the audited generic/workspace hosts`);
      }
      for (const [hostPattern, workspaceScoped] of expectedRules) {
        const rule = policy.allowedHostFamilies?.find((candidate) =>
          candidate.hostPattern === hostPattern);
        if (!rule || rule.workspaceScoped !== workspaceScoped) {
          failures.push(`${region}: endpoint host policy mismatch for ${hostPattern}`);
        }
      }
      for (const source of policy.sources ?? []) {
        if (!source.url?.startsWith(OFFICIAL_SOURCE_PREFIX) || source.checkedAt !== EXPECTED_CHECKED_AT) {
          failures.push(`${region}: endpoint host source must be official and checkedAt=${EXPECTED_CHECKED_AT}`);
        }
      }
    }
  }

  const dialectIds = registry.dialects.map((dialect) => dialect.dialectId);
  const profileIds = registry.profiles.map((profile) => profile.profileId);
  const eventCatalogDialectIds = eventCatalog.catalogs.map((catalog) => catalog.dialectId);
  if (arrayHasDuplicates(dialectIds)) failures.push('dialectId values must be unique');
  if (arrayHasDuplicates(profileIds)) failures.push('profileId values must be unique');
  if (arrayHasDuplicates(eventCatalogDialectIds)) {
    failures.push('official event catalog dialectId values must be unique');
  }
  for (const dialectId of dialectIds) {
    if (!eventCatalogDialectIds.includes(dialectId)) {
      failures.push(`${dialectId}: official event catalog is missing`);
    }
  }
  for (const dialectId of eventCatalogDialectIds) {
    if (!dialectIds.includes(dialectId)) {
      failures.push(`${dialectId}: official event catalog has no registered dialect`);
    }
  }

  const modelOwners = new Map();
  for (const profile of registry.profiles) {
    if (!Number.isInteger(profile.profileVersion) || profile.profileVersion < 1) {
      failures.push(`${profile.profileId}: profileVersion must be a positive integer`);
    }
    if (!Array.isArray(profile.exactModelIds) || profile.exactModelIds.length === 0) {
      failures.push(`${profile.profileId}: exactModelIds must be non-empty`);
    } else {
      for (const modelId of profile.exactModelIds) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(modelId) || /[*?()[\]{}|\\]/.test(modelId)) {
          failures.push(`${profile.profileId}: model selector is not an exact model id: ${modelId}`);
        }
        const previous = modelOwners.get(modelId);
        if (previous) failures.push(`exact model ${modelId} is owned by both ${previous} and ${profile.profileId}`);
        modelOwners.set(modelId, profile.profileId);
      }
    }
    if (!Array.isArray(profile.operations) || profile.operations.length === 0) {
      failures.push(`${profile.profileId}: operations must be non-empty`);
    }
    if (!dialectIds.includes(profile.dialectId)) {
      failures.push(`${profile.profileId}: dialect is not registered: ${profile.dialectId}`);
    }
    const requiresModelAudio = [
      'bailian-paraformer-task-ws-v1',
      'bailian-speech-synthesizer-duplex-task-ws-v1',
      'bailian-qwen-tts-session-ws-v1',
    ].includes(profile.dialectId);
    if (requiresModelAudio && !profile.modelAudio) {
      failures.push(`${profile.profileId}: exact model audio constraints are required`);
    }
    for (const [direction, constraint] of Object.entries(profile.modelAudio ?? {})) {
      const label = `${profile.profileId}: modelAudio.${direction}`;
      if (
        !constraint
        || typeof constraint.required !== 'boolean'
        || !Array.isArray(constraint.codecs)
        || arrayHasDuplicates(constraint.codecs)
        || !Array.isArray(constraint.channels)
        || arrayHasDuplicates(constraint.channels)
        || !constraint.sampleRateConstraint
      ) {
        failures.push(`${label} is invalid`);
        continue;
      }
      const rate = constraint.sampleRateConstraint;
      if (
        !['allow-list', 'any-positive-integer', 'not-applicable'].includes(rate.kind)
        || (
          rate.kind === 'allow-list'
          && (
            !Array.isArray(rate.valuesHz)
            || rate.valuesHz.length === 0
            || arrayHasDuplicates(rate.valuesHz)
            || rate.valuesHz.some((value) => !Number.isInteger(value) || value <= 0)
          )
        )
        || (rate.kind !== 'allow-list' && rate.valuesHz !== undefined)
      ) {
        failures.push(`${label} sample-rate constraint is invalid`);
      }
      if (
        constraint.required
        && (constraint.codecs.length === 0 || constraint.channels.length === 0 || rate.kind === 'not-applicable')
      ) {
        failures.push(`${label} required media must have codec/rate/channel authority`);
      }
      if (
        !constraint.required
        && constraint.codecs.length === 0
        && (constraint.channels.length !== 0 || rate.kind !== 'not-applicable')
      ) {
        failures.push(`${label} non-media direction must be explicitly not-applicable`);
      }
    }
    for (const source of profile.sources ?? []) {
      if (!source.url?.startsWith(OFFICIAL_SOURCE_PREFIX) || source.checkedAt !== EXPECTED_CHECKED_AT) {
        failures.push(`${profile.profileId}: source must be official and checkedAt=${EXPECTED_CHECKED_AT}`);
      }
    }
    if (profile.adapter?.status === 'enabled') {
      const approved = APPROVED_ENABLED_ADAPTERS.get(profile.adapter.adapterId);
      const dialect = registry.dialects.find((candidate) => candidate.dialectId === profile.dialectId);
      if (
        !approved
        || approved.profileId !== profile.profileId
        || approved.dialectId !== profile.dialectId
        || approved.terminalLifecycle !== dialect?.terminalLifecycle
      ) {
        failures.push(`${profile.profileId}: enabled adapter is not in the v1 audited enablement set`);
      }
    } else if (profile.adapter?.status !== 'manifest-only' || profile.adapter?.adapterId !== null) {
      failures.push(`${profile.profileId}: non-enabled adapters must be manifest-only with adapterId=null`);
    }
  }

  const exactProfile = (modelId) => registry.profiles.find((profile) =>
    profile.exactModelIds.includes(modelId));
  const assertModelRate = (modelId, expected) => {
    const constraint = exactProfile(modelId)?.modelAudio?.input?.sampleRateConstraint;
    if (JSON.stringify(constraint) !== JSON.stringify(expected)) {
      failures.push(`${modelId}: exact input sample-rate authority mismatch`);
    }
  };
  assertModelRate('paraformer-realtime-v2', { kind: 'any-positive-integer' });
  assertModelRate('paraformer-realtime-v1', { kind: 'allow-list', valuesHz: [16000] });
  assertModelRate('paraformer-realtime-8k-v2', { kind: 'allow-list', valuesHz: [8000] });
  assertModelRate('paraformer-realtime-8k-v1', { kind: 'allow-list', valuesHz: [8000] });

  for (const modelId of ['cosyvoice-v3.5-plus', 'cosyvoice-v3.5-flash', 'cosyvoice-v2']) {
    const regions = exactProfile(modelId)?.regions;
    if (JSON.stringify(regions) !== JSON.stringify(['cn-beijing'])) {
      failures.push(`${modelId}: must be restricted to cn-beijing`);
    }
  }
  for (const modelId of ['cosyvoice-v3-plus', 'cosyvoice-v3-flash']) {
    const regions = exactProfile(modelId)?.regions;
    if (JSON.stringify(regions) !== JSON.stringify(['cn-beijing', 'ap-southeast-1'])) {
      failures.push(`${modelId}: audited Beijing/Singapore regions mismatch`);
    }
  }
  const qwen3Tts = exactProfile('qwen3-tts-flash-realtime');
  const legacyQwenTts = exactProfile('qwen-tts-realtime');
  if (
    JSON.stringify(qwen3Tts?.modelAudio?.output?.codecs) !== JSON.stringify(['pcm', 'wav', 'mp3', 'opus'])
    || JSON.stringify(qwen3Tts?.modelAudio?.output?.sampleRateConstraint)
      !== JSON.stringify({ kind: 'allow-list', valuesHz: [8000, 16000, 24000, 48000] })
    || JSON.stringify(qwen3Tts?.regions) !== JSON.stringify(['cn-beijing', 'ap-southeast-1'])
  ) {
    failures.push('Qwen3-TTS exact codec/rate/region authority mismatch');
  }
  if (
    JSON.stringify(legacyQwenTts?.modelAudio?.output?.codecs) !== JSON.stringify(['pcm'])
    || JSON.stringify(legacyQwenTts?.modelAudio?.output?.sampleRateConstraint)
      !== JSON.stringify({ kind: 'allow-list', valuesHz: [24000] })
    || JSON.stringify(legacyQwenTts?.regions) !== JSON.stringify(['cn-beijing'])
    || legacyQwenTts?.legacy !== true
  ) {
    failures.push('legacy Qwen-TTS exact codec/rate/region authority mismatch');
  }

  const qwenAudioDialogue = exactProfile('qwen-audio-3.0-realtime-plus');
  if (
    qwenAudioDialogue?.profileId !== 'bailian.qwen-audio-chat.realtime.ws'
    || qwenAudioDialogue?.dialectId !== 'bailian-qwen-audio-chat-realtime-ws-v1'
    || JSON.stringify(qwenAudioDialogue?.operations) !== JSON.stringify(['dialogue'])
  ) {
    failures.push('Qwen-Audio dialogue must retain its product-specific profile and operation');
  }

  const qwen35Omni = exactProfile('qwen3.5-omni-flash-realtime');
  const qwen35OmniRates = { kind: 'allow-list', valuesHz: [8000, 16000, 24000, 48000] };
  if (
    qwen35Omni?.profileId !== 'bailian.omni.realtime.ws'
    || JSON.stringify(qwen35Omni?.modelAudio?.input?.codecs) !== JSON.stringify(['pcm', 'wav'])
    || JSON.stringify(qwen35Omni?.modelAudio?.input?.sampleRateConstraint)
      !== JSON.stringify(qwen35OmniRates)
    || JSON.stringify(qwen35Omni?.modelAudio?.output?.codecs) !== JSON.stringify(['pcm', 'wav'])
    || JSON.stringify(qwen35Omni?.modelAudio?.output?.sampleRateConstraint)
      !== JSON.stringify(qwen35OmniRates)
  ) {
    failures.push('Qwen3.5-Omni exact codec/rate authority mismatch');
  }
  for (const modelId of [
    'qwen3.5-omni-plus-realtime-2026-03-15',
    'qwen3.5-omni-flash-realtime-2026-03-15',
  ]) {
    if (exactProfile(modelId)?.profileId !== 'bailian.omni.realtime.ws') {
      failures.push(`${modelId}: documented snapshot must have exact Qwen3.5-Omni ownership`);
    }
  }
  const legacyOmni = exactProfile('qwen3-omni-flash-realtime');
  if (
    legacyOmni?.profileId !== 'bailian.omni.legacy-realtime.ws'
    || legacyOmni?.legacy !== true
    || legacyOmni?.modelAudio !== undefined
  ) {
    failures.push('legacy Omni models must not inherit Qwen3.5 media authority');
  }

  for (const dialect of registry.dialects) {
    if (!Number.isInteger(dialect.dialectVersion) || dialect.dialectVersion < 1) {
      failures.push(`${dialect.dialectId}: dialectVersion must be a positive integer`);
    }
    if (dialect.regionPolicy !== 'region-key-endpoint-model-must-match') {
      failures.push(`${dialect.dialectId}: region policy must fail closed across region/key/endpoint/model`);
    }
    if (dialect.reusePolicy === 'sequential-tasks-after-terminal') {
      if (
        dialect.connectionReuse?.successBoundaryEvent !== 'task-finished'
        || dialect.connectionReuse?.nextStartEvent !== 'run-task'
        || JSON.stringify(dialect.connectionReuse?.freshIdentityKeys) !== JSON.stringify(['task_id'])
        || dialect.connectionReuse?.failureBehavior !== 'connection-closes-no-reuse'
        || !dialect.serverEventTypes.includes('task-failed')
      ) {
        failures.push(
          `${dialect.dialectId}: sequential task reuse must be bounded by task-finished, fresh task_id, and failure close`,
        );
      }
      for (const semantic of dialect.textEventSemantics ?? []) {
        if (!semantic.identityKeys.includes('task_id')) {
          failures.push(`${dialect.dialectId}: reusable task text identity must include task_id`);
        }
      }
    } else if (dialect.connectionReuse !== undefined) {
      failures.push(`${dialect.dialectId}: connectionReuse is only valid for audited sequential task dialects`);
    }
    if (dialect.endpointFamily === 'dashscope-realtime-v1' && dialect.endpointPath !== '/api-ws/v1/realtime') {
      failures.push(`${dialect.dialectId}: realtime endpoint family must use /api-ws/v1/realtime`);
    }
    if (dialect.endpointFamily === 'dashscope-inference-v1' && dialect.endpointPath !== '/api-ws/v1/inference') {
      failures.push(`${dialect.dialectId}: inference endpoint family must use /api-ws/v1/inference`);
    }
    if (dialect.endpointFamily === 'dashscope-realtime-v1' && dialect.modelPlacement !== 'query') {
      failures.push(`${dialect.dialectId}: realtime model must be carried in the query`);
    }
    if (dialect.endpointFamily === 'dashscope-inference-v1' && dialect.modelPlacement !== 'payload') {
      failures.push(`${dialect.dialectId}: inference model must be carried in the task payload`);
    }
    if (dialect.dialectId === 'bailian-multimodal-dialog-task-ws-v1') {
      if (
        dialect.inputFraming !== 'json-events-and-binary'
        || dialect.outputFraming !== 'json-events-and-binary'
        || dialect.eventEnvelope?.client?.outerEventField !== 'header.action'
        || dialect.eventEnvelope?.client?.innerEventField !== 'payload.input.directive'
        || dialect.eventEnvelope?.server?.outerEventField !== 'header.event'
        || dialect.eventEnvelope?.server?.innerEventField !== 'payload.output.event'
        || dialect.mediaSendGate?.outerEventType !== 'result-generated'
        || dialect.mediaSendGate?.innerEventType !== 'DialogStateChanged'
        || dialect.mediaSendGate?.fieldPath !== 'payload.output.state'
        || dialect.mediaSendGate?.equals !== 'Listening'
        || dialect.terminalEnvelope?.client?.outerEventType !== 'finish-task'
        || dialect.terminalEnvelope?.client?.innerEventType !== 'Stop'
        || dialect.terminalEnvelope?.server?.outerEventType !== 'result-generated'
        || dialect.terminalEnvelope?.server?.innerEventType !== 'Stopped'
      ) {
        failures.push(
          `${dialect.dialectId}: layered task envelope, Listening gate, or terminal envelope mismatch`,
        );
      }
      for (const innerOnlyEvent of ['Start', 'Stop', 'Started', 'Stopped', 'DialogStateChanged']) {
        if (dialect.clientEventTypes.includes(innerOnlyEvent) || dialect.serverEventTypes.includes(innerOnlyEvent)) {
          failures.push(`${dialect.dialectId}: inner event cannot be admitted as a bare outer event: ${innerOnlyEvent}`);
        }
      }
    }

    const catalog = eventCatalog.catalogs.find((candidate) => candidate.dialectId === dialect.dialectId);
    if (catalog) {
      for (const direction of ['client', 'server']) {
        const documented = catalog[direction];
        const pseudoEvents = catalog.framingPseudoEventTypes?.[direction] ?? [];
        const allowlist = direction === 'client' ? dialect.clientEventTypes : dialect.serverEventTypes;
        if (
          !documented
          || !documented.sourceUrl?.startsWith(OFFICIAL_SOURCE_PREFIX)
          || ![
            'event-page-h2',
            'protocol-wire-tokens',
            'protocol-message-type-h4',
            'layered-task-envelope',
          ]
            .includes(documented.catalogKind)
          || !Array.isArray(documented.eventTypes)
          || arrayHasDuplicates(documented.eventTypes)
          || !Array.isArray(pseudoEvents)
          || arrayHasDuplicates(pseudoEvents)
        ) {
          failures.push(`${dialect.dialectId}: invalid official ${direction} event catalog`);
          continue;
        }
        if (!(dialect.sources ?? []).some((source) => source.url === documented.sourceUrl)) {
          failures.push(
            `${dialect.dialectId}: official ${direction} event catalog source is not pinned by dialect sources`,
          );
        }
        const expectedAllowlist = [...documented.eventTypes, ...pseudoEvents];
        for (const eventType of expectedAllowlist) {
          if (!allowlist.includes(eventType)) {
            failures.push(
              `${dialect.dialectId}: official ${direction} event is missing from allowlist: ${eventType}`,
            );
          }
        }
        for (const eventType of allowlist) {
          if (!expectedAllowlist.includes(eventType)) {
            failures.push(
              `${dialect.dialectId}: ${direction} allowlist event lacks official catalog authority: ${eventType}`,
            );
          }
        }

        const documentedInnerEvents = documented.innerEventTypes ?? [];
        const dialectInnerEvents = direction === 'client'
          ? (dialect.clientInnerEventTypes ?? [])
          : (dialect.serverInnerEventTypes ?? []);
        const dialectInnerEventField = direction === 'client'
          ? dialect.eventEnvelope?.client?.innerEventField
          : dialect.eventEnvelope?.server?.innerEventField;
        if (
          documented.catalogKind === 'layered-task-envelope'
          && documented.innerEventField !== dialectInnerEventField
        ) {
          failures.push(`${dialect.dialectId}: ${direction} inner event field disagrees with catalog`);
        }
        if (
          !Array.isArray(documentedInnerEvents)
          || arrayHasDuplicates(documentedInnerEvents)
          || !Array.isArray(dialectInnerEvents)
          || arrayHasDuplicates(dialectInnerEvents)
        ) {
          failures.push(`${dialect.dialectId}: invalid ${direction} inner event catalog`);
        } else {
          for (const eventType of documentedInnerEvents) {
            if (!dialectInnerEvents.includes(eventType)) {
              failures.push(
                `${dialect.dialectId}: official ${direction} inner event is missing: ${eventType}`,
              );
            }
          }
          for (const eventType of dialectInnerEvents) {
            if (!documentedInnerEvents.includes(eventType)) {
              failures.push(
                `${dialect.dialectId}: ${direction} inner event lacks official authority: ${eventType}`,
              );
            }
          }
        }
      }
    }

    const eventLists = [
      ['clientEventTypes', dialect.clientEventTypes],
      ['serverEventTypes', dialect.serverEventTypes],
      ['clientJsonBase64EventTypes', dialect.clientJsonBase64EventTypes],
      ['clientBinaryEventTypes', dialect.clientBinaryEventTypes],
      ['serverJsonBase64EventTypes', dialect.serverJsonBase64EventTypes],
      ['serverBinaryEventTypes', dialect.serverBinaryEventTypes],
      ['clientInnerEventTypes', dialect.clientInnerEventTypes ?? []],
      ['serverInnerEventTypes', dialect.serverInnerEventTypes ?? []],
      ['forbiddenClientEventTypes', dialect.forbiddenClientEventTypes],
      ['forbiddenServerEventTypes', dialect.forbiddenServerEventTypes],
    ];
    for (const [label, values] of eventLists) {
      if (!Array.isArray(values) || arrayHasDuplicates(values)) {
        failures.push(`${dialect.dialectId}: ${label} must be a unique array`);
      }
    }
    if (!Array.isArray(dialect.textEventSemantics)) {
      failures.push(`${dialect.dialectId}: textEventSemantics must be an array`);
    } else {
      const semanticEvents = dialect.textEventSemantics.map((semantic) => semantic.eventType);
      if (arrayHasDuplicates(semanticEvents)) {
        failures.push(`${dialect.dialectId}: textEventSemantics eventType values must be unique`);
      }
      for (const semantic of dialect.textEventSemantics) {
        if (!dialect.serverEventTypes.includes(semantic.eventType)) {
          failures.push(`${dialect.dialectId}: text semantic event is outside server allowlist: ${semantic.eventType}`);
        }
        if (!dialect.serverEventTypes.includes(semantic.finalEventType)) {
          failures.push(`${dialect.dialectId}: text semantic final event is outside server allowlist: ${semantic.finalEventType}`);
        }
        if (
          !['replaceable-snapshot', 'append-delta', 'sentence-identity-replacement']
            .includes(semantic.updateMode)
          || !Array.isArray(semantic.identityKeys)
          || !Array.isArray(semantic.previewFields)
          || semantic.previewFields.length === 0
        ) {
          failures.push(`${dialect.dialectId}: invalid text event semantic for ${semantic.eventType}`);
        }
      }
      const updateModes = new Set(dialect.textEventSemantics.map((semantic) => semantic.updateMode));
      if (dialect.previewSemantics === 'mixed-by-event' && updateModes.size < 2) {
        failures.push(`${dialect.dialectId}: mixed preview semantics must contain multiple update modes`);
      }
      if (dialect.previewSemantics === 'none' && dialect.textEventSemantics.length > 0) {
        failures.push(`${dialect.dialectId}: previewSemantics=none cannot declare text event semantics`);
      }
    }
    for (const eventType of [...dialect.clientJsonBase64EventTypes, ...dialect.clientBinaryEventTypes]) {
      if (!dialect.clientEventTypes.includes(eventType)) {
        failures.push(`${dialect.dialectId}: client framing event is not in the client allowlist: ${eventType}`);
      }
    }
    for (const eventType of [...dialect.serverJsonBase64EventTypes, ...dialect.serverBinaryEventTypes]) {
      if (!dialect.serverEventTypes.includes(eventType)) {
        failures.push(`${dialect.dialectId}: server framing event is not in the server allowlist: ${eventType}`);
      }
    }
    for (const eventType of dialect.forbiddenClientEventTypes) {
      if (dialect.clientEventTypes.includes(eventType)) {
        failures.push(`${dialect.dialectId}: client event is both allowed and forbidden: ${eventType}`);
      }
    }
    for (const eventType of dialect.forbiddenServerEventTypes) {
      if (dialect.serverEventTypes.includes(eventType)) {
        failures.push(`${dialect.dialectId}: server event is both allowed and forbidden: ${eventType}`);
      }
    }
    for (const source of dialect.sources ?? []) {
      if (!source.url?.startsWith(OFFICIAL_SOURCE_PREFIX) || source.checkedAt !== EXPECTED_CHECKED_AT) {
        failures.push(`${dialect.dialectId}: source must be official and checkedAt=${EXPECTED_CHECKED_AT}`);
      }
    }

    const fixturePath = path.join(workspaceRoot, dialect.wireFixture ?? '');
    const fixtureOverride = fixtureOverrides instanceof Map
      ? fixtureOverrides.get(dialect.dialectId)
      : fixtureOverrides?.[dialect.dialectId];
    if (fixtureOverride === undefined && !fs.existsSync(fixturePath)) {
      failures.push(`${dialect.dialectId}: wire fixture does not exist: ${dialect.wireFixture}`);
      continue;
    }
    let fixture;
    try {
      fixture = fixtureOverride === undefined
        ? JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
        : structuredClone(fixtureOverride);
    } catch (error) {
      failures.push(`${dialect.dialectId}: wire fixture is not valid JSON: ${error.message}`);
      continue;
    }
    if (
      fixture.schemaVersion !== 'model-protocol-wire-fixture/v1'
      || fixture.dialectId !== dialect.dialectId
      || fixture.checkedAt !== EXPECTED_CHECKED_AT
      || fixture.sanitized !== true
    ) {
      failures.push(`${dialect.dialectId}: fixture identity/check date/sanitization does not match`);
    }
    if (
      !Array.isArray(fixture.sources)
      || fixture.sources.length === 0
      || fixture.sources.some((source) =>
        typeof source !== 'object'
        || !source.url?.startsWith(OFFICIAL_SOURCE_PREFIX)
        || source.checkedAt !== EXPECTED_CHECKED_AT)
    ) {
      failures.push(`${dialect.dialectId}: fixture sources must pin official URL + checkedAt`);
    }
    if (!Array.isArray(fixture.sequence) || fixture.sequence.length === 0) {
      failures.push(`${dialect.dialectId}: fixture sequence must be non-empty`);
      continue;
    }
    for (const event of fixture.sequence) {
      const allowlist = event.direction === 'client'
        ? dialect.clientEventTypes
        : event.direction === 'server'
          ? dialect.serverEventTypes
          : null;
      if (!allowlist) {
        failures.push(`${dialect.dialectId}: fixture event has invalid direction`);
        continue;
      }
      if (!allowlist.includes(event.eventType)) {
        failures.push(`${dialect.dialectId}: fixture event is outside the ${event.direction} allowlist: ${event.eventType}`);
      }
      const innerAllowlist = event.direction === 'client'
        ? (dialect.clientInnerEventTypes ?? [])
        : (dialect.serverInnerEventTypes ?? []);
      if (event.innerEventType !== undefined && !innerAllowlist.includes(event.innerEventType)) {
        failures.push(
          `${dialect.dialectId}: fixture inner event is outside the ${event.direction} inner allowlist: ${event.innerEventType}`,
        );
      }
      const expectedKind = expectedFrameKind(dialect, event.direction, event.eventType);
      if (event.frameKind !== expectedKind) {
        failures.push(`${dialect.dialectId}: fixture frame mismatch for ${event.eventType}: expected=${expectedKind} actual=${event.frameKind}`);
      }
      if (event.frameKind === 'json' && dialect.eventEnvelope) {
        const envelope = event.direction === 'client'
          ? dialect.eventEnvelope.client
          : dialect.eventEnvelope.server;
        if (valueAtPath(event.wire, envelope.outerEventField) !== event.eventType) {
          failures.push(`${dialect.dialectId}: fixture outer envelope mismatch for ${event.eventType}`);
        }
        if (
          envelope.innerEventField
          && valueAtPath(event.wire, envelope.innerEventField) !== event.innerEventType
        ) {
          failures.push(`${dialect.dialectId}: fixture inner envelope mismatch for ${event.innerEventType}`);
        }
      }
      if (
        event.frameKind === 'json'
        && dialect.reusePolicy === 'sequential-tasks-after-terminal'
      ) {
        const expectedOuter = event.direction === 'client'
          ? event.wire?.header?.action
          : event.wire?.header?.event;
        if (expectedOuter !== event.eventType || !fixtureTaskId(event)) {
          failures.push(`${dialect.dialectId}: reusable task fixture must use real header event/task_id fields`);
        }
      }
    }
    validateTerminalFixture(dialect, fixture.sequence, failures);
    if (dialect.reusePolicy === 'sequential-tasks-after-terminal') {
      validateSequentialTaskReuseFixture(dialect, fixture, failures);
    }
    if (dialect.dialectId === 'bailian-multimodal-dialog-task-ws-v1') {
      validateMultimodalFixture(dialect, fixture, failures);
    }
  }

  return failures;
}
