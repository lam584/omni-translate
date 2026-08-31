import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  MODEL_PROTOCOL_AUTHORIZATION_VECTORS_PATH,
  MODEL_PROTOCOL_EVENT_CATALOG_PATH,
  MODEL_PROTOCOL_SCHEMA_PATH,
  authorizeModelProtocolInvocation,
  loadModelProtocolRegistry,
  validateModelProtocolRegistry,
} from './model-protocol-profile-contract.mjs';

const workspaceRoot = path.resolve('.');

function clonedRegistry() {
  return structuredClone(loadModelProtocolRegistry(workspaceRoot));
}

function failureText(registry, fixtureOverrides = new Map()) {
  return validateModelProtocolRegistry({ workspaceRoot, registry, fixtureOverrides }).join('\n');
}

function dialectById(registry, dialectId) {
  return registry.dialects.find((dialect) => dialect.dialectId === dialectId);
}

function profileById(registry, profileId) {
  return registry.profiles.find((profile) => profile.profileId === profileId);
}

function fixtureForDialect(registry, dialectId) {
  const dialect = dialectById(registry, dialectId);
  return JSON.parse(fs.readFileSync(path.join(workspaceRoot, dialect.wireFixture), 'utf8'));
}

test('model protocol manifest and every sanitized wire fixture satisfy the v1 contract', () => {
  assert.deepEqual(validateModelProtocolRegistry({ workspaceRoot }), []);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(workspaceRoot, MODEL_PROTOCOL_SCHEMA_PATH), 'utf8')));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(
    path.join(workspaceRoot, MODEL_PROTOCOL_EVENT_CATALOG_PATH),
    'utf8',
  )));
});

test('official event-page headings seal every allowlist without cross-dialect extras', () => {
  const missing = clonedRegistry();
  missing.dialects[0].serverEventTypes = missing.dialects[0].serverEventTypes
    .filter((eventType) => eventType !== 'response.created');
  assert.match(
    failureText(missing),
    /official server event is missing from allowlist: response\.created/,
  );

  const invented = clonedRegistry();
  invented.dialects[0].serverEventTypes.push('response.text.delta');
  assert.match(
    failureText(invented),
    /server allowlist event lacks official catalog authority: response\.text\.delta/,
  );
});

test('text streaming semantics are keyed by event, not inferred from a delta suffix', () => {
  const registry = clonedRegistry();
  const omni = registry.dialects.find((dialect) =>
    dialect.dialectId === 'bailian-omni-realtime-ws-v1');
  assert.equal(
    omni.textEventSemantics.find((semantic) =>
      semantic.eventType === 'conversation.item.input_audio_transcription.delta').updateMode,
    'replaceable-snapshot',
  );
  assert.equal(
    omni.textEventSemantics.find((semantic) =>
      semantic.eventType === 'response.text.delta').updateMode,
    'append-delta',
  );

  omni.textEventSemantics = omni.textEventSemantics.filter((semantic) =>
    semantic.eventType !== 'response.text.delta');
  omni.textEventSemantics[0].updateMode = 'append-delta';
  assert.match(failureText(registry), /mixed preview semantics must contain multiple update modes/);
});

test('shared authorization vectors reject unknown and incompatible combinations before any connection', () => {
  const registry = loadModelProtocolRegistry(workspaceRoot);
  const vectors = JSON.parse(fs.readFileSync(
    path.join(workspaceRoot, MODEL_PROTOCOL_AUTHORIZATION_VECTORS_PATH),
    'utf8',
  ));
  for (const vector of vectors.vectors) {
    const result = authorizeModelProtocolInvocation(vector.request, registry);
    assert.equal(result.ok, vector.expect.ok, vector.id);
    if (vector.expect.ok) {
      assert.deepEqual(
        {
          profileId: result.authorization.profileId,
          profileVersion: result.authorization.profileVersion,
          wireDialect: result.authorization.wireDialect,
          endpointHostFamilyId: result.authorization.endpointHostFamilyId,
          endpointFamily: result.authorization.endpointFamily,
          terminalLifecycle: result.authorization.terminalLifecycle,
        },
        {
          profileId: vector.expect.profileId,
          profileVersion: vector.expect.profileVersion,
          wireDialect: vector.expect.wireDialect,
          endpointHostFamilyId: vector.expect.endpointHostFamilyId,
          endpointFamily: vector.expect.endpointFamily,
          terminalLifecycle: vector.expect.terminalLifecycle,
        },
        vector.id,
      );
    } else {
      assert.equal(result.errorCode, vector.expect.errorCode, vector.id);
    }
  }
});

test('contract rejects wildcard model selectors and duplicate exact ownership', () => {
  const wildcard = clonedRegistry();
  wildcard.profiles[0].exactModelIds[0] = 'qwen3.5-livetranslate-*';
  assert.match(failureText(wildcard), /not an exact model id/);

  const duplicate = clonedRegistry();
  duplicate.profiles[1].exactModelIds.push(duplicate.profiles[0].exactModelIds[0]);
  assert.match(failureText(duplicate), /owned by both/);
});

test('contract rejects endpoint and event/framing drift', () => {
  const endpoint = clonedRegistry();
  endpoint.dialects[0].endpointPath = '/api-ws/v1/inference';
  assert.match(failureText(endpoint), /realtime endpoint family must use/);

  const eventSet = clonedRegistry();
  eventSet.dialects[0].serverEventTypes = eventSet.dialects[0].serverEventTypes
    .filter((eventType) => eventType !== 'session.finished');
  assert.match(failureText(eventSet), /outside the server allowlist: session\.finished/);

  const framing = clonedRegistry();
  framing.dialects[0].clientJsonBase64EventTypes = [];
  assert.match(failureText(framing), /fixture frame mismatch for input_audio_buffer\.append/);
});

test('contract rejects missing terminal ordering and unapproved adapter enablement', () => {
  const terminal = clonedRegistry();
  terminal.dialects[0].terminalLifecycle = 'owner-close-after-response-drain';
  assert.match(failureText(terminal), /enabled adapter is not in the v1 audited enablement set/);

  const adapter = clonedRegistry();
  adapter.profiles[2].adapter = {
    status: 'enabled',
    adapterId: 'desktop-unreviewed-omni-v1',
    reason: 'mutation fixture',
  };
  assert.match(failureText(adapter), /enabled adapter is not in the v1 audited enablement set/);
});

test('contract pins official sources and immutable checkedAt identity', () => {
  const registry = clonedRegistry();
  registry.dialects[0].sources[0].url = 'https://example.invalid/copied-protocol';
  registry.profiles[0].sources[0].checkedAt = '2026-08-31';
  const failures = failureText(registry);
  assert.match(failures, /source must be official/);
  assert.match(failures, /checkedAt=2026-08-30/);
});

test('official source inventory records every audited family and its fail-closed disposition', () => {
  const architecture = fs.readFileSync(
    path.join(workspaceRoot, 'docs', 'architecture', 'bailian-model-protocol-registry-v1.md'),
    'utf8',
  );
  const requiredSources = [
    'realtime-api-overview',
    'omni/',
    'asr-model',
    'tts-model',
    'realtime-api-aoq-sdk-desc/',
    'regions',
    'qwen3-5-livetranslate-flash-realtime',
    'live-translator-client-events',
    'live-translator-server-events',
    'qwen3-livetranslate-flash',
    'qwen3-livetranslate-flash-api',
    'realtime',
    'client-events',
    'server-events',
    'qwen-audio-realtime-user-guides',
    'fun-audiochat-realtime-websocket-api',
    'fun-audiochat-client-events',
    'qwen-audio-realtime-server-events',
    'qwen-asr-realtime-interaction-process',
    'qwen-asr-realtime-client-events',
    'qwen-asr-realtime-server-events',
    'fun-asr-realtime-websocket-api',
    'fun-asr-client-events',
    'fun-asr-server-events',
    'qwen-audio-3-0-asr-flash-streaming',
    'websocket-for-paraformer-real-time-service',
    'paraformer-client-events',
    'paraformer-server-events',
    'real-time-websocket-api-1',
    'real-time-speech-translation/',
    'realtime-tts-user-guide',
    'cosyvoice-websocket-api',
    'cosyvoice-client-events',
    'cosyvoice-server-events',
    'non-realtime-tts-user-guide',
    'interactive-process-of-qwen-tts-realtime-synthesis',
    'qwen-tts-realtime-client-events',
    'qwen-tts-realtime-server-events/',
    'multimodal-interaction-protocol',
    'non-realtime-speech-recognition-user-guide',
    'qwen-asr-api-reference',
    'voice-cloning-user-guide',
    'qwen-omni-voice-cloning',
  ].map((slug) => `https://help.aliyun.com/zh/model-studio/${slug}`);

  for (const source of requiredSources) {
    assert.ok(architecture.includes(source), `missing audited official source: ${source}`);
  }
  assert.match(architecture, /已审计但 v1 未登记/);
  assert.match(architecture, /model_protocol\.model_not_registered/);
});

test('region authority admits only the audited generic or one-label workspace host family', () => {
  const registry = loadModelProtocolRegistry(workspaceRoot);
  const common = {
    exactModelId: 'qwen3.5-livetranslate-flash-realtime',
    operation: 'native_translate',
    transport: 'websocket',
  };

  const generic = authorizeModelProtocolInvocation({
    ...common,
    region: 'cn-beijing',
    endpointHost: 'dashscope.aliyuncs.com',
  }, registry);
  assert.equal(generic.ok, true);
  assert.equal(generic.authorization.endpointHostFamilyId, 'dashscope-cn-beijing-generic');

  const workspace = authorizeModelProtocolInvocation({
    ...common,
    region: 'cn-beijing',
    endpointHost: 'llm-sanitized.cn-beijing.maas.aliyuncs.com',
  }, registry);
  assert.equal(workspace.ok, true);
  assert.equal(workspace.authorization.endpointHostFamilyId, 'maas-cn-beijing-workspace');

  const crossRegion = authorizeModelProtocolInvocation({
    ...common,
    region: 'cn-beijing',
    endpointHost: 'dashscope-intl.aliyuncs.com',
  }, registry);
  assert.deepEqual(crossRegion, {
    ok: false,
    errorCode: 'model_protocol.endpoint_host_region_mismatch',
  });

  const nestedWorkspace = authorizeModelProtocolInvocation({
    ...common,
    region: 'cn-beijing',
    endpointHost: 'nested.llm-sanitized.cn-beijing.maas.aliyuncs.com',
  }, registry);
  assert.deepEqual(nestedWorkspace, {
    ok: false,
    errorCode: 'model_protocol.endpoint_host_region_mismatch',
  });
});

test('task reuse is terminal-bounded, task-identity isolated, and failure-invalidating', () => {
  const registry = clonedRegistry();
  const reusable = registry.dialects.filter((dialect) =>
    dialect.reusePolicy === 'sequential-tasks-after-terminal');
  assert.ok(reusable.length >= 5);
  for (const dialect of reusable) {
    assert.equal(dialect.connectionReuse.successBoundaryEvent, 'task-finished');
    assert.equal(dialect.connectionReuse.nextStartEvent, 'run-task');
    assert.deepEqual(dialect.connectionReuse.freshIdentityKeys, ['task_id']);
    assert.equal(dialect.connectionReuse.failureBehavior, 'connection-closes-no-reuse');
  }

  const dialectId = 'bailian-fun-asr-task-ws-v1';
  const sameTaskId = fixtureForDialect(registry, dialectId);
  const runTasks = sameTaskId.sequence.filter((event) =>
    event.direction === 'client' && event.eventType === 'run-task');
  runTasks[1].wire.header.task_id = runTasks[0].wire.header.task_id;
  assert.match(
    failureText(registry, new Map([[dialectId, sameTaskId]])),
    /reused connection must use a fresh task_id/,
  );

  const missingFailureRule = fixtureForDialect(registry, dialectId);
  missingFailureRule.expect.failureInvalidatesConnection = false;
  assert.match(
    failureText(registry, new Map([[dialectId, missingFailureRule]])),
    /task-failed invalidates the connection/,
  );
});

test('Qwen Audio streaming ASR and Fun ASR keep independent product profiles and fixtures', () => {
  const registry = clonedRegistry();
  const qwenModel = 'qwen-audio-3.0-asr-flash-streaming';
  const funModel = 'fun-asr-realtime';
  const qwenProfiles = registry.profiles.filter((profile) =>
    profile.exactModelIds.includes(qwenModel));
  const funProfiles = registry.profiles.filter((profile) =>
    profile.exactModelIds.includes(funModel));

  assert.equal(qwenProfiles.length, 1);
  assert.equal(funProfiles.length, 1);
  assert.notEqual(qwenProfiles[0].profileId, funProfiles[0].profileId);
  assert.notEqual(qwenProfiles[0].product, funProfiles[0].product);
  assert.notEqual(qwenProfiles[0].dialectId, funProfiles[0].dialectId);

  const qwenFixture = fixtureForDialect(registry, qwenProfiles[0].dialectId);
  const funFixture = fixtureForDialect(registry, funProfiles[0].dialectId);
  assert.notEqual(qwenFixture.dialectId, funFixture.dialectId);
  assert.equal(
    qwenFixture.sequence.find((event) => event.eventType === 'run-task')
      .wire.payload.model,
    qwenModel,
  );
  assert.equal(
    funFixture.sequence.find((event) => event.eventType === 'run-task')
      .wire.payload.model,
    funModel,
  );

  const wrongFraming = structuredClone(qwenFixture);
  wrongFraming.sequence.find((event) => event.eventType === 'binary.audio').frameKind = 'json-base64';
  assert.match(
    failureText(registry, new Map([[qwenProfiles[0].dialectId, wrongFraming]])),
    /fixture frame mismatch for binary\.audio: expected=binary actual=json-base64/,
  );
});

test('Qwen Audio dialogue is not Omni and Qwen3.5 Omni media authority is generation-local', () => {
  const registry = clonedRegistry();
  const qwenAudio = profileById(registry, 'bailian.qwen-audio-chat.realtime.ws');
  assert.deepEqual(qwenAudio.operations, ['dialogue']);
  assert.equal(qwenAudio.dialectId, 'bailian-qwen-audio-chat-realtime-ws-v1');

  const qwen35Omni = profileById(registry, 'bailian.omni.realtime.ws');
  const legacyOmni = profileById(registry, 'bailian.omni.legacy-realtime.ws');
  assert.deepEqual(qwen35Omni.modelAudio.input, {
    required: true,
    codecs: ['pcm', 'wav'],
    sampleRateConstraint: { kind: 'allow-list', valuesHz: [8000, 16000, 24000, 48000] },
    channels: [1],
  });
  assert.deepEqual(qwen35Omni.modelAudio.output, {
    required: false,
    codecs: ['pcm', 'wav'],
    sampleRateConstraint: { kind: 'allow-list', valuesHz: [8000, 16000, 24000, 48000] },
    channels: [1],
  });
  assert.ok(qwen35Omni.exactModelIds.includes('qwen3.5-omni-flash-realtime-2026-03-15'));
  assert.ok(!legacyOmni.exactModelIds.some((modelId) => modelId.startsWith('qwen3.5-')));
  assert.equal(legacyOmni.modelAudio, undefined);
  assert.equal(qwen35Omni.adapter.status, 'manifest-only');
  assert.equal(legacyOmni.adapter.status, 'manifest-only');
});

test('exact Paraformer profiles prevent one family-wide sample-rate assumption', () => {
  const registry = clonedRegistry();
  assert.deepEqual(
    profileById(registry, 'bailian.task-asr.paraformer.realtime-v2.ws')
      .modelAudio.input.sampleRateConstraint,
    { kind: 'any-positive-integer' },
  );
  assert.deepEqual(
    profileById(registry, 'bailian.task-asr.paraformer.realtime-v1.ws')
      .modelAudio.input.sampleRateConstraint,
    { kind: 'allow-list', valuesHz: [16000] },
  );
  assert.deepEqual(
    profileById(registry, 'bailian.task-asr.paraformer.realtime-8k-v2.ws')
      .modelAudio.input.sampleRateConstraint,
    { kind: 'allow-list', valuesHz: [8000] },
  );

  profileById(registry, 'bailian.task-asr.paraformer.realtime-v1.ws')
    .modelAudio.input.sampleRateConstraint.valuesHz = [8000, 16000];
  assert.match(
    failureText(registry),
    /paraformer-realtime-v1: exact input sample-rate authority mismatch/,
  );
});

test('CosyVoice and Qwen TTS model generations retain exact region and media authority', () => {
  const registry = clonedRegistry();
  assert.deepEqual(
    profileById(registry, 'bailian.task-tts.cosyvoice-v3.5.ws').regions,
    ['cn-beijing'],
  );
  assert.deepEqual(
    profileById(registry, 'bailian.task-tts.cosyvoice-v3.ws').regions,
    ['cn-beijing', 'ap-southeast-1'],
  );

  const qwen3 = profileById(registry, 'bailian.qwen3-tts.realtime.ws');
  const legacy = profileById(registry, 'bailian.qwen-tts.legacy-realtime.ws');
  assert.deepEqual(qwen3.modelAudio.output.codecs, ['pcm', 'wav', 'mp3', 'opus']);
  assert.deepEqual(
    qwen3.modelAudio.output.sampleRateConstraint,
    { kind: 'allow-list', valuesHz: [8000, 16000, 24000, 48000] },
  );
  assert.deepEqual(legacy.modelAudio.output.codecs, ['pcm']);
  assert.deepEqual(
    legacy.modelAudio.output.sampleRateConstraint,
    { kind: 'allow-list', valuesHz: [24000] },
  );
  assert.deepEqual(legacy.regions, ['cn-beijing']);

  legacy.modelAudio.output.codecs.push('opus');
  assert.match(failureText(registry), /legacy Qwen-TTS exact codec\/rate\/region authority mismatch/);
});

test('multimodal dialog requires its layered envelope and Listening media gate', () => {
  const registry = clonedRegistry();
  const dialectId = 'bailian-multimodal-dialog-task-ws-v1';
  const fixture = fixtureForDialect(registry, dialectId);
  const started = fixture.sequence.find((event) => event.innerEventType === 'Started');
  const listening = fixture.sequence.find((event) =>
    event.innerEventType === 'DialogStateChanged'
    && event.wire.payload.output.state === 'Listening');
  const firstAudio = fixture.sequence.findIndex((event) =>
    event.direction === 'client' && event.eventType === 'binary.audio');
  assert.equal(started.eventType, 'result-generated');
  assert.equal(listening.eventType, 'result-generated');
  assert.ok(fixture.sequence.indexOf(listening) < firstAudio);

  const bareStart = structuredClone(fixture);
  const start = bareStart.sequence.find((event) => event.innerEventType === 'Start');
  start.eventType = 'Start';
  start.wire.header.action = 'Start';
  assert.match(
    failureText(registry, new Map([[dialectId, bareStart]])),
    /fixture event is outside the client allowlist: Start/,
  );

  const noListening = structuredClone(fixture);
  const gate = noListening.sequence.find((event) =>
    event.innerEventType === 'DialogStateChanged'
    && event.wire.payload.output.state === 'Listening');
  gate.wire.payload.output.state = 'Thinking';
  assert.match(
    failureText(registry, new Map([[dialectId, noListening]])),
    /Start < Started < Listening < binary audio/,
  );
});

test('Omni terminal ambiguity remains fail-closed and never invents session.finished', () => {
  const registry = clonedRegistry();
  const omni = dialectById(registry, 'bailian-omni-realtime-ws-v1');
  assert.equal(omni.terminalLifecycle, 'owner-close-after-response-drain');
  assert.ok(omni.forbiddenServerEventTypes.includes('session.finished'));
  assert.ok(!omni.serverEventTypes.includes('session.finished'));
});
