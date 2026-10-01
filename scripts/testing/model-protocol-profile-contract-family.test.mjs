import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { projectBailianModule } from '../../provider-modules/bailian/build-manifest.mjs';
import { authorizeModelProtocolInvocation, loadModelProtocolRegistry, validateFamilyPayloadFixture, validateModelProtocolRegistry } from './model-protocol-profile-contract.mjs';

const root = path.resolve('.');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const registry = loadModelProtocolRegistry(root);
const families = read('contracts/model-protocol-families.v1.json');
const exactEnabledIds = [
  'qwen3.5-livetranslate-flash-realtime', 'qwen3.8-livetranslate-flash-realtime',
  'qwen3.8-omni-flash-realtime', 'qwen-audio-3.0-realtime-plus', 'qwen-audio-3.0-realtime-flash',
  'qwen-audio-3.1-realtime-plus', 'qwen-audio-3.0-asr-flash-streaming',
  'qwen-audio-3.1-asr-flash-streaming', 'qwen-audio-3.0-tts-plus', 'qwen-audio-3.0-tts-flash',
].sort();

function request(profile, model = profile.exactModelIds[0], region = 'cn-beijing') {
  return { exactModelId: model, operation: profile.operations[0], transport: 'websocket', region,
    endpointHost: `fixture-workspace.${region}.maas.aliyuncs.com` };
}

test('family source/generated schema and owner-version bindings authorize exactly ten stable IDs', () => {
  assert.deepEqual(families, read('provider-modules/bailian/protocol-families.json'));
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(read('contracts/model-protocol-families.schema.json'));
  assert.equal(validate(families), true, JSON.stringify(validate.errors));
  assert.equal(new Set(families.enabledBindings.map((b) => b.profileId)).size, families.enabledBindings.length);
  assert.deepEqual(families.enabledBindings.flatMap((b) => b.exactModelIds).sort(), exactEnabledIds);
  assert.deepEqual(registry.profiles.filter((p) => p.adapter.status === 'enabled').flatMap((p) => p.exactModelIds).sort(), exactEnabledIds);
  for (const b of families.enabledBindings) {
    const p = registry.profiles.find((p) => p.profileId === b.profileId);
    const d = registry.dialects.find((d) => d.dialectId === b.dialectId);
    assert.equal(b.owner, 'bailian');
    assert.equal(p.profileVersion, b.profileVersion);
    assert.equal(d.dialectVersion, b.dialectVersion);
    assert.equal(p.adapter.adapterId, b.adapterId);
    assert.deepEqual(p.operations, b.operations);
    assert.deepEqual(p.exactModelIds, b.exactModelIds);
    for (const model of b.exactModelIds) for (const region of p.regions) {
      const result = authorizeModelProtocolInvocation(request(p, model, region), registry);
      assert.equal(result.ok, true, model + ': ' + JSON.stringify(result));
      assert.equal(result.authorization.profileId, b.profileId);
      assert.equal(result.authorization.profileVersion, b.profileVersion);
      assert.equal(result.authorization.wireDialectVersion, b.dialectVersion);
    }
  }
});

test('binding validation rejects version drift, sibling operation grants, and snapshot inheritance', () => {
  for (const mutation of [
    (p) => { p.profileVersion += 1; },
    (p) => { p.operations.push('native_translate'); },
    (p) => { p.exactModelIds.push(p.exactModelIds[0] + '-2099-12-31'); },
    (p, r) => { r.dialects.find((d) => d.dialectId === p.dialectId).dialectVersion += 1; },
    (p) => { p.adapter.adapterId = 'desktop-livetranslate-session-v2'; },
  ]) {
    const r = structuredClone(registry);
    const p = r.profiles.find((p) => p.profileId === 'bailian.omni.3_8.realtime.ws');
    mutation(p, r);
    assert.match(validateModelProtocolRegistry({ workspaceRoot: root, registry: r }).join('\n'), /audited enablement set/);
  }
  for (const p of registry.profiles.filter((p) => p.adapter.status === 'manifest-only')) {
    assert.equal(authorizeModelProtocolInvocation(request(p), registry).ok, false, p.profileId);
  }
});

test('generated projection is atomic, fixture-only and uses exact family payloads rather than CosyVoice/Omni aliases', () => {
  const { manifest, files } = projectBailianModule(root);
  assert.deepEqual(manifest, read('provider-modules/bailian/manifest.json'));
  for (const [file, projected] of files) assert.deepEqual(projected, read(file), file);
  for (const b of families.enabledBindings) {
    const p = manifest.protocolProfiles.find((p) => p.id === b.profileId);
    assert.equal(p.adapter.verification, 'fixture-only');
    const fixture = files.get(manifest.fixtures.find((f) => f.id === p.fixtureIds[0]).path);
    assert.equal(fixture.provenance.capturedFromLive, false);
    assert.equal(fixture.data.networkAuthorized, false);
    const d = registry.dialects.find((d) => d.dialectId === b.dialectId);
    if (!b.profileId.includes('livetranslate')) assert.deepEqual(validateFamilyPayloadFixture(d, { sequence: fixture.data.events }), [], b.profileId);
    if (b.adapterId.includes('task-')) {
      for (const event of fixture.data.events.filter((e) => e.eventType === 'run-task')) assert.ok(b.exactModelIds.includes(event.wire.payload.model));
    }
    if (b.profileId === 'bailian.qwen-audio.3_1.realtime.ws') assert.equal(fixture.data.events.find((e) => e.eventType === 'session.update').wire.session.voice, 'longanqian_v3.1');
    if (b.profileId === 'bailian.qwen-audio-chat.realtime.ws') assert.equal(fixture.data.events.find((e) => e.eventType === 'session.update').wire.session.voice, 'longanqian');
    if (b.profileId === 'bailian.omni.3_8.realtime.ws') assert.match(fixture.data.connectionUrl, /^wss:\/\/\{WorkspaceId\}\.cn-beijing\.maas\.aliyuncs\.com\/api-ws\/v1\/realtime\?model=qwen3\.8-omni-flash-realtime$/);
  }
});

test('normal payload fixtures preserve nested Omni, flat Audio, snapshot previews, and ambient isolation', () => {
  for (const id of ['bailian-omni-realtime-ws-v2', 'bailian-qwen-audio-chat-realtime-ws-v1']) {
    const d = registry.dialects.find((d) => d.dialectId === id);
    const f = read(d.wireFixture);
    assert.deepEqual(validateFamilyPayloadFixture(d, f), []);
    const snapshots = f.sequence.filter((e) => e.eventType === 'conversation.item.input_audio_transcription.delta');
    assert.deepEqual(snapshots.map((e) => e.wire.text), ['hello', 'hello world']);
    assert.equal(f.expect.sourcePreviewUpdateMode, 'replaceable-snapshot');
    assert.equal(f.expect.ambientSnapshotIsConversationInput, false);
    assert.equal(f.expect.responseDoneIsSessionTerminal, false);
    if (id.includes('qwen-audio')) {
      const ambient = f.sequence.filter((e) => e.eventType.includes('ambient_audio_transcription'));
      assert.ok(ambient.every((e) => e.wire.item_id !== snapshots[0].wire.item_id));
      assert.equal(f.sequence.find((e) => e.wire?.reason === 'turn_invalid').eventType, 'input_audio_buffer.speech_stopped');
    }
  }
});

test('illegal event/payload fixtures deny LT/Omni/task mixing and unimplemented smart_turn control', () => {
  const fixtures = read('provider-modules/bailian/fixtures/family-illegal-events.json');
  for (const c of fixtures.cases) {
    const d = registry.dialects.find((d) => d.dialectId === c.dialectId);
    const failures = validateFamilyPayloadFixture(d, { sequence: [c.event] });
    assert.ok(failures.some((failure) => failure.includes(c.expectedFailure)), c.id + ': ' + failures.join('\n'));
  }
  const d = registry.dialects.find((d) => d.dialectId === 'bailian-qwen-audio-asr-task-ws-v1');
  const f = read(d.wireFixture);
  const audio = f.sequence.find((e) => e.eventType === 'binary.audio');
  audio.activeTaskId = '99999999-9999-4999-8999-999999999999';
  assert.match(validateModelProtocolRegistry({ workspaceRoot: root, registry, fixtureOverrides: new Map([[d.dialectId, f]]) }).join('\n'), /active task/);
});


test('Qwen-Audio server VAD payload does not manually commit or response.create', () => {
  const d = registry.dialects.find((d) => d.dialectId === 'bailian-qwen-audio-chat-realtime-ws-v1');
  const f = read('provider-modules/bailian/fixtures/qwen-audio-server-vad-session.json');
  assert.deepEqual(validateFamilyPayloadFixture(d, f), []);
  assert.equal(f.sequence.find((e) => e.eventType === 'session.update').wire.session.turn_detection.type, 'server_vad');
  assert.ok(!f.sequence.some((e) => e.direction === 'client' && ['input_audio_buffer.commit', 'response.create'].includes(e.eventType)));
  const manual = read(d.wireFixture);
  assert.equal(manual.sequence.find((e) => e.eventType === 'session.update').wire.session.turn_detection, null);
  assert.ok(manual.sequence.some((e) => e.direction === 'client' && e.eventType === 'input_audio_buffer.commit'));
  assert.ok(manual.sequence.some((e) => e.direction === 'client' && e.eventType === 'response.create'));
});
