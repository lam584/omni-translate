import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import path from 'node:path';

// Only the lossless registry is editable. Manifest arrays and standard fixtures are projections.
export function projectBailianModule(root) {
  const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
  const registry = read('provider-modules/bailian/model-protocol-registry.json');
  const m = {
    $schema: '../../contracts/provider-manifest.schema.json', schemaVersion: 'provider-manifest/v1', manifestVersion: 1, checkedAt: '2026-09-20',
    provider: { id: 'bailian', displayName: 'Alibaba Cloud Bailian', templateId: 'template-dashscope-realtime', kind: 'dashscope', source: 'official', description: 'Generated projection of the lossless Bailian protocol registry.', defaultModelId: 'qwen3.5-livetranslate-flash-realtime', defaultApiFamilyId: 'bailian.api.bailian-livetranslate-session-ws-v1', defaultCredentialId: 'bailian.credential.api-key', defaultRegion: 'cn-beijing' },
    documentation: [], credentials: [{ id: 'bailian.credential.api-key', reference: 'credential://provider/bailian/default', fields: [{ id: 'api-key', label: 'DashScope API key', secret: true, required: true, format: 'DashScope API key' }] }],
    authProfiles: [{ id: 'bailian.auth.bearer', type: 'bearer', credentialId: 'bailian.credential.api-key', parameters: [{ location: 'header', name: 'Authorization', source: 'credential', credentialFieldId: 'api-key', scheme: 'Bearer', required: true }] }],
    transports: [], audioProfiles: [], lifecycleProfiles: [], apiFamilies: [], protocolProfiles: [], models: [], probes: [], smokes: [], fixtures: [], bailianModelProtocolRegistry: registry,
  };
  const documentation = new Map();
  function docs(sources) {
    return sources.map((source) => {
      const key = `${source.url}@${source.checkedAt}`;
      if (!documentation.has(key)) {
        const id = `bailian.docs.${documentation.size + 1}`;
        documentation.set(key, id);
        m.documentation.push({ id, title: source.url.split('/').filter(Boolean).at(-1), ...source });
      }
      return documentation.get(key);
    });
  }
  const framing = (value) => ({ 'json-events': 'json', 'json-events-and-binary': 'json-and-binary' }[value] ?? value);
  const envelope = { kind: 'none', byteOrder: 'not-applicable' };
  for (const d of registry.dialects) {
    const id = d.dialectId;
    const profiles = registry.profiles.filter((profile) => profile.dialectId === id);
    const workspaceOnly = profiles.length > 0 && profiles.every((profile) => profile.endpointRequirements?.workspaceScoped === true);
    const workspaceHost = registry.endpointHostPolicies.find((policy) => policy.region === m.provider.defaultRegion)
      ?.allowedHostFamilies.find((family) => family.workspaceScoped)?.hostPattern.replace('*', '{WorkspaceId}');
    if (workspaceOnly && !workspaceHost) throw new Error(`Missing workspace host for ${id}`);
    const baseUrlTemplate = workspaceOnly ? `wss://${workspaceHost}` : 'wss://dashscope.aliyuncs.com';
    m.transports.push({ id: `bailian.transport.${id}`, kind: d.transport, requestFraming: framing(d.inputFraming), responseFraming: framing(d.outputFraming), requestEnvelope: envelope, responseEnvelope: envelope });
    const direction = (audio) => ({ required: audio.required, formats: audio.codecs, sampleRatesHz: audio.sampleRatesHz, channels: audio.channels });
    m.audioProfiles.push({ id: `bailian.audio.${id}`, input: direction(d.audioInput), output: direction(d.audioOutput) });
    m.lifecycleProfiles.push({ id: `bailian.lifecycle.${id}`, handshake: d.handshake, clientEvents: d.clientEventTypes, serverEvents: d.serverEventTypes, vadModes: [], terminal: d.terminalLifecycle, reuse: ({ 'multi-turn-session': 'multi-turn', 'sequential-tasks-after-terminal': 'sequential-tasks', 'single-task': 'single-session' })[d.reusePolicy] ?? d.reusePolicy, textDeltaSemantics: ({ 'mixed-by-event': 'mixed', 'none': 'not-applicable', 'sentence-identity-replacement': 'replaceable-snapshot' })[d.previewSemantics] ?? d.previewSemantics });
    m.apiFamilies.push({ id: `bailian.api.${id}`, displayName: id, baseUrlTemplate, endpointTemplate: d.endpointPath, endpointStatus: 'verified', modelAddressing: 'model-id', transportId: `bailian.transport.${id}`, authProfileIds: ['bailian.auth.bearer'], defaultAuthProfileId: 'bailian.auth.bearer', maturity: 'unspecified', documentationIds: docs(d.sources) });
  }
  const operationMap = { native_translate: 'realtime-translation', dialogue: 'realtime-conversation', asr: 'asr', tts: 'tts' };
  const capabilityMap = { native_translate: ['speech-translation', 'speech-to-speech'], dialogue: ['speech-to-speech'], asr: ['speech-to-text'], tts: ['text-to-speech'] };
  const files = new Map();
  const models = new Map();
  for (const p of registry.profiles) {
    const d = registry.dialects.find((d) => d.dialectId === p.dialectId);
    const enabled = p.adapter.status === 'enabled';
    const documentationIds = docs(p.sources);
    const fixtureId = `${p.profileId}.fixture.v${p.profileVersion}`;
    const fixturePath = `provider-modules/bailian/fixtures/${p.profileId}.v${p.profileVersion}.json`;
    const capabilities = [...new Set(p.operations.flatMap((op) => capabilityMap[op]))];
    m.protocolProfiles.push({ id: p.profileId, version: p.profileVersion, apiFamilyId: `bailian.api.${d.dialectId}`, transportId: `bailian.transport.${d.dialectId}`, authProfileIds: ['bailian.auth.bearer'], defaultAuthProfileId: 'bailian.auth.bearer', audioProfileId: `bailian.audio.${d.dialectId}`, lifecycleProfileId: `bailian.lifecycle.${d.dialectId}`, operations: p.operations.map((op) => operationMap[op]), capabilities, maturity: p.legacy ? 'deprecated' : 'unspecified', adapter: { id: p.adapter.adapterId ?? `bailian.unimplemented.${p.profileId}`, status: enabled ? 'enabled' : 'disabled', verification: enabled ? 'fixture-only' : 'not-implemented', reason: p.adapter.reason }, documentationIds, fixtureIds: [fixtureId], customProviderPolicy: 'forbidden', notes: `Exact regional authorization remains in bailianModelProtocolRegistry. Regions: ${p.regions.join(', ')}.` });
    for (const id of p.exactModelIds) {
      if (!models.has(id)) models.set(id, { id, displayName: id, capabilities: [], maturity: p.legacy ? 'deprecated' : 'unspecified', protocolBindings: [], documentationIds: [], availability: p.regions.join(', ') });
      const model = models.get(id);
      model.capabilities = [...new Set([...model.capabilities, ...capabilities])];
      model.documentationIds = [...new Set([...model.documentationIds, ...documentationIds])];
      for (const operation of p.operations) model.protocolBindings.push({ operation: operationMap[operation], protocolProfileId: p.profileId, protocolProfileVersion: p.profileVersion });
    }
    const wire = read(d.wireFixture);
    const events = wire.sequence.map((e) => ({ ...e, type: e.eventType, ...(e.frameKind === 'binary' ? { frameType: 'binary', payloadOmitted: true } : {}) }));
    const terminal = [...events].reverse().find((e) => e.direction === 'server');
    if (terminal) terminal.terminal = true;
    const audio = events.find((e) => d.clientJsonBase64EventTypes.includes(e.eventType));
    if (audio) audio.audio = '<redacted>';
    const fixture = { $schema: '../../../contracts/provider-wire-fixture.schema.json', schemaVersion: 'provider-wire-fixture/v1', id: fixtureId, providerId: 'bailian', protocolProfileId: p.profileId, protocolProfileVersion: p.profileVersion, kind: 'wire', provenance: { sourceDocumentationIds: documentationIds, capturedFromLive: false, sanitized: true, notes: `Generated documentation fixture projection from ${d.wireFixture}; never authorizes paid calls.` }, scenario: `Exact ${p.profileId} protocol replay`, data: { endpointStatus: 'verified', networkAuthorized: false, connectionUrl: `wss://dashscope.aliyuncs.com${d.endpointPath}`, authContract: { profileId: 'bailian.auth.bearer', parameters: [{ location: 'header', name: 'Authorization', value: 'Bearer <redacted>' }] }, audioContract: { input: d.audioInput, output: d.audioOutput }, events } };
    // Output-only audio protocols have no client media frame.
    if (!audio && !events.some((e) => e.direction === 'client' && e.frameType === 'binary')) fixture.data.audio = '<redacted>';
    m.fixtures.push({ id: fixtureId, path: fixturePath, kind: 'wire', sourceDocumentationIds: documentationIds });
    files.set(fixturePath, fixture);
  }

  // Text MT is catalog-only: its translation_options contract has no implemented adapter.
  // Separate source data owns text products; none duplicate the realtime authority registry.
  const catalog = read('provider-modules/bailian/translation-catalog.json');
  const validateCatalog = new Ajv2020({ strict: true, allErrors: true }).compile(read('provider-modules/bailian/translation-catalog.schema.json'));
  if (!validateCatalog(catalog)) throw new Error('Invalid Bailian translation catalog: ' + JSON.stringify(validateCatalog.errors));
  const textTransport = 'bailian.transport.qwen-mt-http';
  m.transports.push({ id: textTransport, kind: 'http', requestFraming: 'json', responseFraming: 'json', requestEnvelope: envelope, responseEnvelope: envelope });
  for (const entry of catalog.models) {
    const id = 'bailian.' + entry.id + '.http';
    const documentationIds = docs(entry.sources);
    const fixtureId = id + '.fixture.v1';
    const fixturePath = 'provider-modules/bailian/fixtures/' + id + '.v1.json';
    m.apiFamilies.push({ id: id + '.api', displayName: entry.id + ' translation_options API', baseUrlTemplate: 'https://dashscope.aliyuncs.com/compatible-mode/v1', endpointTemplate: '/chat/completions', endpointStatus: 'verified', modelAddressing: 'model-id', transportId: textTransport, authProfileIds: ['bailian.auth.bearer'], defaultAuthProfileId: 'bailian.auth.bearer', maturity: entry.id === 'qwen-mt-turbo' ? 'deprecated' : 'ga', documentationIds });
    m.lifecycleProfiles.push({ id: id + '.lifecycle', handshake: ['http.request', 'http.response'], clientEvents: ['http.request'], serverEvents: ['http.response'], vadModes: ['none'], terminal: 'http-response-complete', reuse: 'single-request', textDeltaSemantics: 'not-applicable' });
    m.protocolProfiles.push({ id, version: 1, apiFamilyId: id + '.api', transportId: textTransport, authProfileIds: ['bailian.auth.bearer'], defaultAuthProfileId: 'bailian.auth.bearer', lifecycleProfileId: id + '.lifecycle', operations: ['text-translation'], capabilities: ['text-translation'], maturity: entry.id === 'qwen-mt-turbo' ? 'deprecated' : 'ga', adapter: { id: 'bailian.qwen-mt.unimplemented', status: 'disabled', verification: 'not-implemented', reason: 'Dedicated single-user-message and translation_options adapter is not implemented; do not route through generic chat.' }, documentationIds, fixtureIds: [fixtureId], customProviderPolicy: 'forbidden', notes: 'Catalog only. Documented streaming semantics: ' + entry.streamingSemantics + '. Exact regions: ' + entry.regions.join(', ') });
    models.set(entry.id, { id: entry.id, displayName: entry.id, capabilities: ['text-translation'], maturity: entry.id === 'qwen-mt-turbo' ? 'deprecated' : 'ga', protocolBindings: [{ operation: 'text-translation', protocolProfileId: id, protocolProfileVersion: 1 }], documentationIds, availability: entry.regions.join(', ') });
    m.fixtures.push({ id: fixtureId, path: fixturePath, kind: 'wire', sourceDocumentationIds: documentationIds });
    files.set(fixturePath, { $schema: '../../../contracts/provider-wire-fixture.schema.json', schemaVersion: 'provider-wire-fixture/v1', id: fixtureId, providerId: 'bailian', protocolProfileId: id, protocolProfileVersion: 1, kind: 'wire', provenance: { sourceDocumentationIds: documentationIds, capturedFromLive: false, sanitized: true, notes: 'Documentation-derived non-streaming request/response shape; not a live result.' }, scenario: 'Qwen-MT dedicated translation_options request, disabled before network I/O', data: { endpointStatus: 'verified', networkAuthorized: false, authContract: { profileId: 'bailian.auth.bearer', parameters: [{ location: 'header', name: 'Authorization', value: 'Bearer <redacted>' }] }, request: { type: 'http.request', method: 'POST', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', body: { model: entry.id, messages: [{ role: 'user', content: 'Hello' }], stream: false, translation_options: { source_lang: 'English', target_lang: 'Chinese' } } }, response: { type: 'http.response', terminal: true, body: { choices: [{ message: { role: 'assistant', content: '你好' } }] } } } });
  }

  // Discovery is not protocol authority: unresolved endpoints and no server replay.
  // The required HTTP envelope is a disabled placeholder, not a verified transport.
  for (const entry of catalog.discoveryModels) {
    if (models.has(entry.id)) throw new Error('Duplicate Bailian catalog model: ' + entry.id);
    const id = 'bailian.catalog.' + entry.id;
    const documentationIds = docs(entry.sources);
    const fixtureId = id + '.fixture.v1';
    const fixturePath = 'provider-modules/bailian/fixtures/' + id + '.v1.json';
    const audio = entry.capability === 'text-to-speech';
    const operations = audio ? ['tts'] : entry.legacyPreset ? ['text'] : ['text', 'text-translation'];
    const capabilities = audio ? ['text-to-speech'] : entry.legacyPreset ? ['text-generation'] : ['text-generation', 'text-translation'];
    const notes = 'Official catalog only; no protocol authorization. Unknown: ' + entry.unknowns.join(', ') + '. Regions: ' + (entry.regions.join(', ') || 'unknown (snapshot-specific availability not verified)');
    m.apiFamilies.push({ id: id + '.api', displayName: entry.id + ' (catalog only)', baseUrlTemplate: 'https://dashscope.aliyuncs.com', endpointTemplate: null, endpointStatus: 'unresolved', modelAddressing: 'model-id', transportId: textTransport, authProfileIds: ['bailian.auth.bearer'], defaultAuthProfileId: 'bailian.auth.bearer', maturity: 'unspecified', documentationIds });
    m.lifecycleProfiles.push({ id: id + '.lifecycle', handshake: [], clientEvents: [], serverEvents: [], vadModes: ['none'], terminal: 'Unknown; no network authorization', reuse: 'single-request', textDeltaSemantics: 'not-applicable' });
    if (audio) m.audioProfiles.push({ id: id + '.audio', input: { required: false, formats: [], sampleRatesHz: [], channels: [] }, output: { required: true, formats: [], sampleRatesHz: [], channels: [] } });
    m.protocolProfiles.push({ id, version: 1, apiFamilyId: id + '.api', transportId: textTransport, authProfileIds: ['bailian.auth.bearer'], defaultAuthProfileId: 'bailian.auth.bearer', ...(audio ? { audioProfileId: id + '.audio' } : {}), lifecycleProfileId: id + '.lifecycle', operations, capabilities, maturity: 'unspecified', adapter: { id: 'bailian.catalog.unimplemented', status: 'disabled', verification: 'not-implemented', reason: notes }, documentationIds, fixtureIds: [fixtureId], customProviderPolicy: 'forbidden', notes });
    models.set(entry.id, { id: entry.id, displayName: entry.id, capabilities, maturity: 'unspecified', protocolBindings: operations.map(operation => ({ operation, protocolProfileId: id, protocolProfileVersion: 1 })), documentationIds, availability: entry.regions.join(', ') || 'unknown (snapshot-specific availability not verified)' });
    m.fixtures.push({ id: fixtureId, path: fixturePath, kind: 'error', sourceDocumentationIds: documentationIds });
    files.set(fixturePath, { $schema: '../../../contracts/provider-wire-fixture.schema.json', schemaVersion: 'provider-wire-fixture/v1', id: fixtureId, providerId: 'bailian', protocolProfileId: id, protocolProfileVersion: 1, kind: 'error', provenance: { sourceDocumentationIds: documentationIds, capturedFromLive: false, sanitized: true, notes: 'Catalog admission denial, not an invented protocol replay.' }, scenario: 'Catalog discovery cannot authorize network I/O', data: { endpointStatus: 'unresolved', networkAuthorized: false, unknowns: entry.unknowns, authContract: { profileId: 'bailian.auth.bearer', parameters: [{ location: 'header', name: 'Authorization', value: 'Bearer <redacted>' }] } } });
  }
  m.models = [...models.values()];
  files.set('provider-modules/bailian/manifest.json', m);
  return { manifest: m, files };
}
