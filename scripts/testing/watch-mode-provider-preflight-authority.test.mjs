import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STRICT_EN_ZH_CORPUS, STRICT_V2_EN_ZH_CORPUS, validateLiveTranslateWireEvidence, validateProviderPreflightRawAuthority } from './watch-mode-provider-preflight-authority.mjs';
import { deriveWatchModelProtocolIdentity } from './watch-mode-model-protocol-authority.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const selection = { modelId: 'qwen3.8-livetranslate-flash-realtime', endpointHost: 'registered-workspace.cn-beijing.maas.aliyuncs.com', region: 'cn-beijing' };
const authorization = () => ({ releaseSelection: structuredClone(selection), model: selection.modelId, protocol: 'dashscope-livetranslate', modelProtocolProfileIdentity: deriveWatchModelProtocolIdentity(selection.modelId, selection) });

// Match the Rust zero-input probe plan and serde_json sorted-key digest, not an arbitrary v2 session.
function fixture(v2 = true) {
  const model = v2 ? selection.modelId : 'qwen3.5-livetranslate-flash-realtime';
  const session = v2 ? {
    output_modalities: ['text'], translation: { language: 'zh', corpus: { phrases: STRICT_V2_EN_ZH_CORPUS } },
    audio: { input: { turn_detection: { type: 'server_vad' } } },
  } : {
    modalities: ['text'], input_audio_format: 'pcm', sample_rate: 16000,
    input_audio_transcription: { language: 'en', model: 'qwen3-asr-flash-realtime' },
    translation: { language: 'zh', corpus: { phrases: STRICT_EN_ZH_CORPUS } },
    turn_detection: { type: 'server_vad', silence_duration_ms: 400, threshold: 0 },
  };
  const sessionId = hash('synthetic-session');
  const echo = structuredClone(session);
  if (v2) {
    echo.turn_detection = { create_response: true, interrupt_response: true, type: 'server_vad' };
  } else {
    Object.assign(echo.turn_detection, { create_response: true, interrupt_response: true });
  }
  const payloads = [
    { host: v2 ? selection.endpointHost : 'dashscope.aliyuncs.com', path: '/api-ws/v1/realtime', query: { model }, requestHeaderNames: ['authorization'], scheme: 'wss' },
    { type: 'session.created', event_id: 'created', session: { id: sessionId, model } },
    { type: 'session.update', event_id: 'evt_update', session },
    { type: 'session.updated', event_id: 'updated', session: { id: sessionId, model, ...echo } },
    { type: 'session.finish', event_id: 'evt_finish' },
    { type: 'session.finished', event_id: 'finished' },
  ];
  const digestInput = JSON.stringify(canonical(session));
  const raw = {
    evidenceOutcome: 'livetranslate-session-finished', firstServerEvent: { type: 'session.created', monotonicMs: 100 },
    providerInputMode: 'none', responseMode: 'text-only', productionMode: true, latencyBudgetMs: 1200,
    measuredLatencyMs: 100, firstServerEventLatencyMs: 100,
    lifecycleBudget: { firstServerEventLatencyMs: 1200, socketEventTimeoutMs: 12000 },
    providerInvocationCount: 1, connectionCount: 1, externalAudioSamples: 0,
    inputAudioBufferCommitCount: 0, conversationItemCreateInputTextCount: 0, responseCreateCount: 0,
    sessionAuthority: { sessionIdentitySha256: sessionId, serverModel: model,
      echoedSessionConfigSha256: hash(v2 ? digestInput : digestInput.replace('"threshold":0,', '"threshold":0.0,')) },
  };
  return { payloads, raw, expected: v2 ? authorization() : null };
}

function check(t, value, mutateEntries = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-authority-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'raw'));
  const directions = ['transport', 'server-to-client', 'client-to-server', 'server-to-client', 'client-to-server', 'server-to-client'];
  const entries = value.payloads.map((payload, index) => {
    const rawRedactedPayload = JSON.stringify(payload);
    return { direction: directions[index], type: index === 0 ? 'websocket.upgrade' : payload.type,
      monotonicMs: index * 100, ...(index === 0 ? { status: 101 } : {}), rawRedactedPayload, sha256: hash(rawRedactedPayload) };
  });
  mutateEntries(entries);
  const bytes = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'raw/provider-websocket-trace.jsonl'), bytes);
  value.raw.rawTrace = { path: 'raw/provider-websocket-trace.jsonl', bytes: Buffer.byteLength(bytes), sha256: hash(bytes), eventCount: entries.length };
  const probe = { rawTrace: value.raw.rawTrace, evidenceOutcome: value.raw.evidenceOutcome, firstServerEvent: value.raw.firstServerEvent };
  const issues = [];
  validateLiveTranslateWireEvidence(root, probe, value.raw, issues, value.expected);
  return issues;
}

for (const v2 of [false, true]) test('exact zero-audio trace is accepted: ' + (v2 ? 'signed 3.8 workspace v2' : 'historical 3.5 v1'), t => {
  assert.deepEqual(check(t, fixture(v2)), []);
});

const mutations = {
  'generic endpoint': f => { f.payloads[0].host = 'dashscope.aliyuncs.com'; },
  'other workspace': f => { f.payloads[0].host = 'other.cn-beijing.maas.aliyuncs.com'; },
  'query model': f => { f.payloads[0].query.model = 'qwen3.5-livetranslate-flash-realtime'; },
  'created model': f => { f.payloads[1].session.model = 'qwen3.5-livetranslate-flash-realtime'; },
  'updated model': f => { f.payloads[3].session.model = 'qwen3.5-livetranslate-flash-realtime'; },
  'updated session id': f => { f.payloads[3].session.id = 'b'.repeat(64); },
  'v1 client session': f => { f.payloads[2].session = fixture(false).payloads[2].session; },
  'v1 echo session': f => { f.payloads[3].session = fixture(false).payloads[3].session; },
  'legacy field mixed into echo': f => { f.payloads[3].session.modalities = ['text']; },
  'audio response requested': f => { f.payloads[2].session.output_modalities.push('audio'); },
  'arbitrary valid v2 threshold': f => { f.payloads[2].session.audio.input.turn_detection.threshold = 0.5; },
  'missing corpus': f => { delete f.payloads[2].session.translation.corpus; },
  'echo translation changed': f => { f.payloads[3].session.translation.language = 'en'; },
  'echo audio mode changed': f => { f.payloads[3].session.audio.input.turn_detection.type = 'semantic_vad'; },
  'echo top-level turn detection changed': f => { f.payloads[3].session.turn_detection.type = 'semantic_vad'; },
  'digest changed': f => { f.raw.sessionAuthority.echoedSessionConfigSha256 = 'f'.repeat(64); },
  'audio input': f => { f.raw.externalAudioSamples = 1; },
  'missing signed selection': f => { delete f.expected.releaseSelection; },
  'generic signed selection': f => { f.expected.releaseSelection.endpointHost = 'dashscope.aliyuncs.com'; },
  'noncanonical selection': f => { delete f.expected.releaseSelection.region; },
  'unknown signed model': f => { f.expected.releaseSelection.modelId += '-latest'; },
  'signed model mismatch': f => { f.expected.model = 'qwen3.5-livetranslate-flash-realtime'; },
  'missing registered identity': f => { delete f.expected.modelProtocolProfileIdentity; },
  'v1 registered identity': f => { f.expected.modelProtocolProfileIdentity = deriveWatchModelProtocolIdentity('qwen3.5-livetranslate-flash-realtime'); },
  'tampered v2 identity': f => { f.expected.modelProtocolProfileIdentity = { ...f.expected.modelProtocolProfileIdentity, wireDialectVersion: 1 }; },
};
for (const [name, mutate] of Object.entries(mutations)) test('rejects 3.8 ' + name + ' even with recomputed trace hashes', t => {
  const value = fixture(); mutate(value); assert.notDeepEqual(check(t, value), []);
});
test('default 3.5 authorization cannot consume a v2 session', t => {
  const value = fixture(false); value.payloads[2].session = fixture().payloads[2].session;
  assert.notDeepEqual(check(t, value), []);
});
test('signed 3.8 cannot consume an otherwise valid 3.5 lifecycle', t => {
  const value = fixture(false); value.expected = authorization(); assert.notDeepEqual(check(t, value), []);
});
test('payload digest and ordering remain mandatory for 3.8', t => {
  assert.notDeepEqual(check(t, fixture(), entries => { entries[2].sha256 = '0'.repeat(64); }), []);
  assert.notDeepEqual(check(t, fixture(), entries => { entries[3].monotonicMs = 100; }), []);
});


// Deliberately partial outer artifacts isolate selection propagation across evidence layers.
// These do not assert that the partial bundle is release-eligible.
for (const layer of ['probe', 'emitter', 'raw', 'diagnostics']) {
  test('signed release selection is exact in the ' + layer + ' consumption layer', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-consumption-'));
    t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
    fs.mkdirSync(path.join(root, 'raw'));
    fs.mkdirSync(path.join(root, 'diagnostics-bundle/snapshots/extra'), { recursive: true });
    const expected = authorization();
    const observed = { ...structuredClone(expected), authorizationObservedAt: '2026-09-21T00:00:00Z' };
    const layers = Object.fromEntries(['probe', 'emitter', 'raw', 'diagnostics'].map(key => [key, { preflightAuthorization: structuredClone(observed) }]));
    Object.assign(layers.probe, { protocol: expected.protocol, providerId: 'provider-dashscope', templateId: 'template-dashscope-realtime',
      model: selection.modelId, configuredModel: 'qwen3.5-omni-plus-realtime', endpointHost: selection.endpointHost,
      credentialStatus: { backend: 'windows-credential-manager', exists: true, reference: 'credential://provider/dashscope/default' },
      transportRequested: 'websocket', effectiveTransport: 'websocket' });
    layers.raw.fallbackApplied = false;
    const write = () => {
      layers.probe.rawProbeResult = layers.raw;
      fs.writeFileSync(path.join(root, 'provider-probe-result.json'), JSON.stringify(layers.probe));
      fs.writeFileSync(path.join(root, 'emitter-result.json'), JSON.stringify(layers.emitter));
      fs.writeFileSync(path.join(root, 'diagnostics-bundle/snapshots/extra/provider-probe-summary.json'), JSON.stringify(layers.diagnostics));
      fs.writeFileSync(path.join(root, 'diagnostics-bundle/snapshots/config.json'), JSON.stringify({ providers: [{ providerId: 'provider-dashscope', templateId: 'template-dashscope-realtime', baseUrl: 'https://dashscope.aliyuncs.com/api/v1' }] }));
      return validateProviderPreflightRawAuthority(root, { expectedAuthorization: expected }).issues.join('\n');
    };
    const before = write();
    assert.doesNotMatch(before, /releaseSelection does not match|modelProtocolProfileIdentity does not match|endpoint host does not match|fixed DashScope provider.credential identity is invalid/);
    layers[layer].preflightAuthorization.releaseSelection.endpointHost = 'other.cn-beijing.maas.aliyuncs.com';
    assert.match(write(), /releaseSelection does not match the signed authorization/);
    layers[layer].preflightAuthorization = structuredClone(observed);
    layers[layer].preflightAuthorization.modelProtocolProfileIdentity.wireDialectVersion = 1;
    assert.match(write(), /modelProtocolProfileIdentity does not match the signed authorization/);
  });
}
