import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectFixtureSemantics,
  validateModelCapabilityMetadata,
  validateDocumentationUsage,
  validateEnabledProfileFixtureCoverage,
  validateProfileContractCompleteness,
  validateProfileFixtureCoverage,
} from './verify-provider-manifests.mjs';

const profile = {
  id: 'fixture.chat',
  version: 1,
  authProfileIds: ['fixture.auth'],
  audioProfileId: undefined,
};
const lifecycle = {
  clientEvents: ['chat.request'],
  serverEvents: ['chat.chunk', 'data.done'],
};
const authProfiles = new Map([['fixture.auth', {
  id: 'fixture.auth',
  parameters: [{ location: 'header', name: 'Authorization', required: true }],
}]]);

test('scenario prose cannot satisfy structured fixture coverage', () => {
  const fixtures = [{
    scenario: 'endpoint auth request audio response complete done',
    data: { description: 'connection header terminal audio' },
  }];

  const semantics = collectFixtureSemantics(fixtures);
  assert.equal(semantics.endpoints.length, 0);
  assert.equal(semantics.authContracts.length, 0);
  assert.equal(semantics.hasClientPayload, false);
  assert.equal(semantics.hasServerPayload, false);
  assert.throws(
    () => validateEnabledProfileFixtureCoverage(
      profile,
      lifecycle,
      authProfiles,
      fixtures,
      'fixture.chat@1',
    ),
    /lacks a structured secure endpoint URL/,
  );
});

test('profile-aware coverage accepts exact auth and lifecycle evidence', () => {
  const fixtures = [{
    scenario: 'structured stream',
    data: {
      request: {
        event: 'chat.request',
        method: 'POST',
        url: 'https://example.test/v1/chat',
        body: { stream: true },
      },
      authContract: {
        profileId: 'fixture.auth',
        parameters: [
          { location: 'header', name: 'Authorization', value: 'Bearer <redacted>' },
        ],
      },
      response: {
        status: 200,
        frames: [
          { event: 'chat.chunk', data: { delta: 'text' } },
          { data: '[DONE]' },
        ],
      },
    },
  }];

  assert.doesNotThrow(() => validateEnabledProfileFixtureCoverage(
    profile,
    lifecycle,
    authProfiles,
    fixtures,
    'fixture.chat@1',
  ));
});

test('authContract must cover every required parameter of the selected profile', () => {
  const fixtures = [{
    scenario: 'missing auth parameter',
    data: {
      request: { event: 'chat.request', url: 'https://example.test/v1/chat', body: { stream: true } },
      authContract: { profileId: 'fixture.auth', parameters: [] },
      response: { frames: [{ event: 'chat.chunk' }, { data: '[DONE]' }] },
    },
  }];

  assert.throws(
    () => validateEnabledProfileFixtureCoverage(
      profile,
      lifecycle,
      authProfiles,
      fixtures,
      'fixture.chat@1',
    ),
    /does not cover every required parameter/,
  );
});

test('official documentation must be referenced by a provider-owned contract', () => {
  const documentation = new Map([
    ['docs.used', { id: 'docs.used' }],
    ['docs.orphan', { id: 'docs.orphan' }],
  ]);
  const manifest = {
    apiFamilies: [{ id: 'family', documentationIds: ['docs.used'] }],
    protocolProfiles: [],
    models: [],
    fixtures: [],
    authProfiles: [],
  };

  assert.throws(
    () => validateDocumentationUsage(documentation, manifest, 'fixture.manifest'),
    /unreferenced source\(s\): docs\.orphan/,
  );
  manifest.apiFamilies[0].documentationIds.push('docs.orphan');
  assert.doesNotThrow(() => validateDocumentationUsage(documentation, manifest, 'fixture.manifest'));
});

test('disabled audio profiles cannot omit wire fixtures or audio contracts', () => {
  const profile = {
    operations: ['realtime-transcription'],
    fixtureIds: [],
  };
  assert.throws(
    () => validateProfileContractCompleteness(profile, 'fixture.profile'),
    /at least one protocol fixture/,
  );
  profile.fixtureIds.push('fixture.wire');
  assert.throws(
    () => validateProfileContractCompleteness(profile, 'fixture.profile'),
    /requires an explicit audioProfileId/,
  );
  profile.audioProfileId = 'fixture.audio';
  assert.doesNotThrow(() => validateProfileContractCompleteness(profile, 'fixture.profile'));
});

test('unresolved endpoint profiles require explicit fail-closed evidence', () => {
  const unresolved = {
    id: 'fixture.unresolved',
    authProfileIds: ['fixture.auth'],
  };
  const auth = new Map([['fixture.auth', {
    id: 'fixture.auth',
    parameters: [{ location: 'header', name: 'Authorization', required: true }],
  }]]);
  const fixture = {
    data: {
      endpointStatus: 'unresolved',
      networkAuthorized: false,
      authContract: {
        profileId: 'fixture.auth',
        parameters: [{ location: 'header', name: 'Authorization', value: 'Bearer <redacted>' }],
      },
    },
  };
  assert.doesNotThrow(() => validateProfileFixtureCoverage(
    unresolved,
    { endpointStatus: 'unresolved' },
    { clientEvents: [], serverEvents: [] },
    auth,
    [fixture],
    'fixture.unresolved',
  ));
  fixture.data.networkAuthorized = true;
  assert.throws(
    () => validateProfileFixtureCoverage(
      unresolved,
      { endpointStatus: 'unresolved' },
      { clientEvents: [], serverEvents: [] },
      auth,
      [fixture],
      'fixture.unresolved',
    ),
    /must deny network authorization/,
  );
});
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectBailianModule } from '../../provider-modules/bailian/build-manifest.mjs';
import { buildBailianCompatibilityRegistry, buildProviderManifestBundle, verifyProviderManifestBundle } from './build-provider-manifest-bundle.mjs';
import Ajv2020 from 'ajv/dist/2020.js';

const bailianRoot = fileURLToPath(new URL('../../', import.meta.url));
const bailianJson = (p) => JSON.parse(fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));

test('Bailian lossless migration preserves the complete pre-3.8 registry, including 3.5 identities', () => {
  const current = buildBailianCompatibilityRegistry();
  const old = { ...current, dialects: current.dialects.slice(0, 12), profiles: current.profiles.slice(0, 21) };
  assert.equal(createHash('sha256').update(JSON.stringify(old)).digest('hex'), '4d544b4003b3a3cb675c5840e619bafb5d0982d191e599c0042aa3d806dd1204');
});

test('Bailian module, bundle, fixtures and compatibility registry are deterministic generated projections', () => {
  verifyProviderManifestBundle();
  const projection = projectBailianModule(bailianRoot);
  assert.deepEqual(projection.manifest, bailianJson('provider-modules/bailian/manifest.json'));
  assert.deepEqual(buildBailianCompatibilityRegistry(), bailianJson('contracts/model-protocol-profiles.v1.json'));
  assert.equal(projection.manifest.provider.kind, 'dashscope');
  assert.equal(projection.manifest.provider.templateId, 'template-dashscope-realtime');
  assert.equal(projection.manifest.models.length, 60);
  assert.equal(projection.manifest.protocolProfiles.length, 35);
  for (const p of projection.manifest.protocolProfiles) {
    if (p.adapter.verification === 'not-implemented') assert.equal(p.adapter.status, 'disabled');
  }
});

test('only the 3.8 profile requires workspace endpoints, projected without changing legacy defaults', () => {
  const registry = buildBailianCompatibilityRegistry();
  assert.deepEqual(registry.profiles.filter(p => p.endpointRequirements).map(p => p.profileId), ['bailian.livetranslate.3_8.realtime.ws']);
  const profile = registry.profiles.find(p => p.profileId === 'bailian.livetranslate.3_8.realtime.ws');
  assert.deepEqual(profile.endpointRequirements, { workspaceScoped: true });
  assert.deepEqual(profile.regions, ['cn-beijing', 'ap-southeast-1']);
  const manifest = projectBailianModule(bailianRoot).manifest;
  const family = manifest.apiFamilies.find(f => f.id === 'bailian.api.' + profile.dialectId);
  assert.equal(family.baseUrlTemplate, 'wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com');
  assert.equal(family.endpointTemplate, '/api-ws/v1/realtime');
  assert.equal(manifest.apiFamilies.find(f => f.id === manifest.provider.defaultApiFamilyId).baseUrlTemplate, 'wss://dashscope.aliyuncs.com');
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  const validate = ajv.compile(bailianJson('contracts/model-protocol-profiles.schema.json'));
  for (const requirements of [{}, { workspaceScoped: false }, { workspaceScoped: true, ignored: true }]) {
    const altered = structuredClone(registry);
    altered.profiles.find(p => p.profileId === profile.profileId).endpointRequirements = requirements;
    assert.equal(validate(altered), false);
  }
});

test('Bailian 3.8 isolates all three append-delta streams and session.finished terminal', () => {
  const r = buildBailianCompatibilityRegistry();
  const p = r.profiles.find(p => p.profileId === 'bailian.livetranslate.3_8.realtime.ws');
  assert.equal(p.profileVersion, 1);
  assert.deepEqual(p.exactModelIds, ['qwen3.8-livetranslate-flash-realtime']);
  assert.equal(p.adapter.adapterId, 'desktop-livetranslate-session-v2');
  const d = r.dialects.find(d => d.dialectId === p.dialectId);
  assert.equal(d.dialectVersion, 2);
  assert.equal(d.terminalLifecycle, 'session.finish->session.finished');
  assert.equal(d.previewSemantics, 'append-delta');
  assert.deepEqual(d.textEventSemantics.map(e => e.eventType), ['conversation.item.input_audio_transcription.delta', 'response.text.delta', 'response.audio_transcript.delta']);
  for (const e of d.textEventSemantics) {
    assert.equal(e.updateMode, 'append-delta');
    assert.deepEqual(e.previewFields, ['delta']);
    assert.ok(d.serverEventTypes.includes(e.eventType));
    assert.ok(!d.forbiddenServerEventTypes.includes(e.eventType));
  }
  assert.ok(d.serverEventTypes.includes('session.finished'));
  assert.ok(!d.forbiddenServerEventTypes.includes('session.finished'));
  assert.ok(d.sources.every(s => s.checkedAt === '2026-09-20'));
});

test('Bailian lossless extension rejects unknown fields, malformed identities and foreign provider ownership', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  ajv.addSchema(bailianJson('contracts/model-protocol-profiles.schema.json'));
  const validate = ajv.compile(bailianJson('contracts/provider-manifest.schema.json'));
  const m = projectBailianModule(bailianRoot).manifest;
  assert.ok(validate(m), ajv.errorsText(validate.errors));
  for (const mutate of [
    m => { m.bailianModelProtocolRegistry.unrecognized = true; },
    m => { m.bailianModelProtocolRegistry.dialects[0].unrecognized = true; },
    m => { m.bailianModelProtocolRegistry.profiles[0].profileVersion = 0; },
    m => { m.provider.id = 'openai'; },
    m => { m.models = []; },
  ]) {
    const invalid = structuredClone(m);
    mutate(invalid);
    assert.equal(validate(invalid), false);
  }
});

test('Bailian newly catalogued Qwen Audio 3.1 and Qwen-MT products remain fail-closed with exact sources and regions', () => {
  const { manifest } = projectBailianModule(bailianRoot);
  for (const id of ['qwen-audio-3.1-realtime-plus', 'qwen-mt-plus', 'qwen-mt-flash', 'qwen-mt-lite', 'qwen-mt-turbo']) {
    const model = manifest.models.find(m => m.id === id);
    assert.ok(model, id);
    assert.ok(model.availability.includes('cn-beijing'));
    assert.ok(model.availability.includes('ap-southeast-1'));
    for (const binding of model.protocolBindings) {
      const profile = manifest.protocolProfiles.find(p => p.id === binding.protocolProfileId);
      assert.equal(profile.adapter.status, 'disabled');
      assert.equal(profile.adapter.verification, 'not-implemented');
      assert.equal(profile.customProviderPolicy, 'forbidden');
    }
    for (const documentId of model.documentationIds) {
      const document = manifest.documentation.find(d => d.id === documentId);
      assert.equal(document.checkedAt, '2026-09-20');
      assert.ok(document.url.startsWith('https://help.aliyun.com/zh/model-studio/'));
    }
  }
  const catalog = bailianJson('provider-modules/bailian/translation-catalog.json');
  assert.equal(catalog.models.find(m => m.id === 'qwen-mt-turbo').regions.includes('us-east-1'), false);
  assert.equal(catalog.models.find(m => m.id === 'qwen-mt-plus').streamingSemantics, 'replaceable-snapshot');
  assert.equal(catalog.models.find(m => m.id === 'qwen-mt-flash').streamingSemantics, 'append-delta');
});

test('official text-generation and 3.1 TTS discovery never grants executable protocol authority', () => {
  const { manifest, files } = projectBailianModule(bailianRoot);
  const registry = buildBailianCompatibilityRegistry();
  const catalog = bailianJson('provider-modules/bailian/translation-catalog.json');
  const exactIds = ['qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-max-2026-09-02', 'qwen3.8-flash', 'qwen-audio-3.1-tts-flash'];
  assert.deepEqual(catalog.discoveryModels.map(m => m.id), [...exactIds, 'qwen-plus', 'qwen-max', 'qwen-turbo']);
  for (const id of exactIds) {
    const entry = catalog.discoveryModels.find(m => m.id === id);
    assert.equal(entry.verification, 'official-catalog-only');
    assert.ok(entry.unknowns.includes('executableProtocol'));
    assert.ok(!registry.profiles.some(p => p.exactModelIds.includes(id)), 'discovery must not enter legacy executable authority');
    const model = manifest.models.find(m => m.id === id);
    assert.deepEqual(model.capabilities, id === 'qwen-audio-3.1-tts-flash' ? ['text-to-speech'] : ['text-generation', 'text-translation']);
    for (const binding of model.protocolBindings) {
      const profile = manifest.protocolProfiles.find(p => p.id === binding.protocolProfileId);
      assert.equal(profile.adapter.status, 'disabled');
      assert.equal(profile.adapter.verification, 'not-implemented');
      assert.equal(profile.customProviderPolicy, 'forbidden');
      const family = manifest.apiFamilies.find(f => f.id === profile.apiFamilyId);
      assert.equal(family.endpointStatus, 'unresolved');
      assert.equal(family.endpointTemplate, null);
      const fixture = files.get(manifest.fixtures.find(f => f.id === profile.fixtureIds[0]).path);
      assert.equal(fixture.data.networkAuthorized, false);
      assert.equal(fixture.data.response, undefined);
      assert.equal(fixture.provenance.capturedFromLive, false);
    }
  }
  assert.deepEqual(catalog.discoveryModels.find(m => m.id === 'qwen-audio-3.1-tts-flash').regions, ['cn-beijing']);
  assert.ok(manifest.models.find(m => m.id === 'qwen3.8-max-0902').availability.startsWith('unknown'));
  assert.ok(manifest.models.find(m => m.id === 'qwen3.8-max-2026-09-02').availability.startsWith('unknown'));
});


test('legacy DashScope text presets remain present with exactly text-generation capability', () => {
  const { manifest } = projectBailianModule(bailianRoot);
  for (const id of ['qwen-plus', 'qwen-max', 'qwen-turbo']) {
    const model = manifest.models.find(m => m.id === id);
    assert.ok(model, id);
    assert.deepEqual(model.capabilities, ['text-generation']);
    assert.equal(model.protocolBindings.length, 1);
    const profile = manifest.protocolProfiles.find(p => p.id === model.protocolBindings[0].protocolProfileId);
    assert.deepEqual(profile.capabilities, ['text-generation']);
    assert.deepEqual(profile.operations, ['text']);
    assert.equal(profile.adapter.status, 'disabled');
    assert.equal(profile.customProviderPolicy, 'forbidden');
  }
});

const advisoryFields = ['capabilities', 'interactionCapabilities', 'realtimeAudioMode', 'apiModes', 'releasedAt'];
const nonBailianAuthorityBaselines = {
  'azure-openai': '379e6803120fd64d7097f95d52375cafdc815baf1d9219534806ac1b5af56bff',
  'google-gemini': '49f1fa28c5424bf4a17e7ec8cfd0e912eccab92d4e031436093b3ea3115c3897',
  openai: '9de05380e0f9df930d3b0138b7f3d0eaee6ad5554e88df10e84c5ecc48b54aae',
  'tencent-cloud': '4109c986edbdc9207f6a7b3123b0c868f30390f222d6dc7aa3130802d23ec900',
  'volcengine-doubao': '4b13c0ee8dd4777b499e5edee17bcefb1abaa9d13362271fd08c665d0540d972',
  'zhipu-glm': 'ca293bc9cd09561795416e5a93d40a6d7c3967c2abf883b1267d21623dcd18e1',
};

test('non-Bailian module advisory metadata exactly preserves every matching legacy seed, including shared IDs', () => {
  const seed = bailianJson('apps/desktop/src/schema/model-registry-v1-seed.json');
  const compiled = buildProviderManifestBundle();
  assert.deepEqual(compiled, bailianJson('contracts/provider-manifests.compiled.v1.json'));
  let copied = 0;
  for (const provider of Object.keys(nonBailianAuthorityBaselines)) {
    const manifest = bailianJson(`provider-modules/${provider}/manifest.json`);
    const bundled = compiled.manifests.find(m => m.provider.id === provider);
    for (const model of manifest.models) {
      const entries = seed.filter(s => s.modelId === model.id);
      if (!entries.length) {
        assert.equal(Object.hasOwn(model, 'capabilityMetadata'), false);
        continue;
      }
      for (const entry of entries) {
        const expected = Object.fromEntries(advisoryFields.filter(k => Object.hasOwn(entry, k)).map(k => [k, entry[k]]));
        assert.deepEqual(model.capabilityMetadata, expected, `${provider}/${model.id}`);
        assert.deepEqual(bundled.models.find(m => m.id === model.id).capabilityMetadata, expected);
      }
      copied += 1;
    }
    const withoutMetadata = structuredClone(manifest);
    for (const model of withoutMetadata.models) delete model.capabilityMetadata;
    assert.equal(createHash('sha256').update(JSON.stringify(withoutMetadata)).digest('hex'), nonBailianAuthorityBaselines[provider], `${provider}: no non-advisory value may change`);
  }
  assert.equal(copied, 20);
  const openai = compiled.manifests.find(m => m.provider.id === 'openai');
  assert.deepEqual(openai.models.find(m => m.id === 'gpt-realtime').capabilityMetadata.interactionCapabilities, ['auto_vad', 'manual_commit', 'streaming']);
  assert.equal(Object.hasOwn(openai.models.find(m => m.id === 'gpt-4o').capabilityMetadata, 'apiModes'), false);
  assert.equal(Object.hasOwn(openai.models.find(m => m.id === 'gpt-4o').capabilityMetadata, 'releasedAt'), false);
  const tencent = compiled.manifests.find(m => m.provider.id === 'tencent-cloud');
  assert.deepEqual(tencent.models.find(m => m.id === 'hunyuan-translation').capabilityMetadata.interactionCapabilities, ['streaming', 'pipeline_asr_mt_tts']);
});

test('advisory metadata compiler validation is strict, optional-field preserving and non-authorizing', () => {
  for (const valid of [{}, { capabilities: [], interactionCapabilities: [], apiModes: [] }, { releasedAt: 'unknown' }, { releasedAt: '2024-02-29' }, { realtimeAudioMode: 'manual' }]) {
    assert.doesNotThrow(() => validateModelCapabilityMetadata(valid, 'test model'));
  }
  for (const invalid of [null, [], { capabilities: ['invented'] }, { interactionCapabilities: ['invented'] }, { realtimeAudioMode: 'invented' }, { apiModes: [''] }, { releasedAt: '2025-02-29' }, { releasedAt: '2026-13-01' }, { adapter: { status: 'enabled' } }, { protocolBindings: [] }, { capabilities: ['text-generation', 'text-generation'] }]) {
    assert.throws(() => validateModelCapabilityMetadata(invalid, 'test model'), /invalid advisory capabilityMetadata/);
  }
});
