import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const modulesRoot = path.join(repositoryRoot, 'provider-modules');

const FIRST_BATCH_PROVIDER_IDS = new Set([
  'openai',
  'google-gemini',
  'zhipu-glm',
  'tencent-cloud',
  'azure-openai',
  'volcengine-doubao',
]);

function fail(message) {
  throw new Error(`provider-manifest: ${message}`);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function idMap(items, label) {
  const result = new Map();
  for (const item of array(items, label)) {
    const id = requiredString(item?.id, `${label}[].id`);
    if (result.has(id)) fail(`${label} contains duplicate id '${id}'`);
    result.set(id, item);
  }
  return result;
}

function versionedIdMap(items, label) {
  const result = new Map();
  for (const item of array(items, label)) {
    const id = requiredString(item?.id, `${label}[].id`);
    if (!Number.isInteger(item?.version) || item.version < 1) {
      fail(`${label}.${id}.version must be a positive integer`);
    }
    const key = `${id}@${item.version}`;
    if (result.has(key)) fail(`${label} contains duplicate profile '${key}'`);
    result.set(key, item);
  }
  return result;
}

function requireReference(index, id, label) {
  requiredString(id, label);
  if (!index.has(id)) fail(`${label} references missing id '${id}'`);
}

function requireReferences(index, ids, label) {
  for (const id of array(ids, label)) requireReference(index, id, `${label}[]`);
}

export function validateDocumentationUsage(documentation, manifest, label) {
  const referenced = new Set();
  const collect = (ids, sourceLabel) => {
    for (const id of array(ids ?? [], sourceLabel)) {
      requireReference(documentation, id, `${sourceLabel}[]`);
      referenced.add(id);
    }
  };

  for (const collectionName of ['apiFamilies', 'protocolProfiles', 'models']) {
    for (const item of array(manifest?.[collectionName] ?? [], `${label}.${collectionName}`)) {
      collect(item.documentationIds, `${label}.${collectionName}.${item.id}.documentationIds`);
    }
  }
  for (const fixture of array(manifest?.fixtures ?? [], `${label}.fixtures`)) {
    collect(fixture.sourceDocumentationIds, `${label}.fixtures.${fixture.id}.sourceDocumentationIds`);
  }
  for (const auth of array(manifest?.authProfiles ?? [], `${label}.authProfiles`)) {
    if (auth.credentialBootstrap) {
      collect(
        auth.credentialBootstrap.documentationIds,
        `${label}.authProfiles.${auth.id}.credentialBootstrap.documentationIds`,
      );
    }
  }

  const unused = [...documentation.keys()].filter((id) => !referenced.has(id));
  if (unused.length > 0) {
    fail(`${label}.documentation contains unreferenced source(s): ${unused.join(', ')}`);
  }
}

function requireProfileReference(index, id, version, label) {
  requiredString(id, `${label}.id`);
  if (!Number.isInteger(version) || version < 1) fail(`${label}.version must be a positive integer`);
  const key = `${id}@${version}`;
  if (!index.has(key)) fail(`${label} references missing profile '${key}'`);
  return index.get(key);
}

const AUDIO_OPERATIONS = new Set([
  'asr',
  'tts',
  'realtime-conversation',
  'realtime-translation',
  'realtime-transcription',
  'speech-translation',
]);

export function validateProfileContractCompleteness(profile, label) {
  const operations = array(profile?.operations, `${label}.operations`);
  const fixtureIds = array(profile?.fixtureIds, `${label}.fixtureIds`);
  if (fixtureIds.length === 0) fail(`${label} must declare at least one protocol fixture`);
  if (operations.some((operation) => AUDIO_OPERATIONS.has(operation)) && !profile.audioProfileId) {
    fail(`${label} audio operation requires an explicit audioProfileId`);
  }
}

function readJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`cannot read ${path.relative(repositoryRoot, filePath)}: ${error.message}`);
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(`invalid JSON in ${path.relative(repositoryRoot, filePath)}: ${error.message}`);
  }
}

function resolveInside(root, declaredPath, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(repositoryRoot, requiredString(declaredPath, label));
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} escapes its provider module: ${declaredPath}`);
  }
  return resolved;
}

function assertNoSecretLikeMaterial(document, label) {
  const serialized = JSON.stringify(document);
  const secretPatterns = [
    /sk-[A-Za-z0-9_-]{16,}/,
    /AKID[A-Za-z0-9]{12,}/,
    /AKLT[A-Za-z0-9]{12,}/,
    /AIza[A-Za-z0-9_-]{20,}/,
    /(?:SecretId|SecretKey|api[_-]?key|access[_-]?key|client[_-]?secret)["'\\s:=]+(?!<redacted>|\$\{|fixture-|AKIDEXAMPLE)[A-Za-z0-9/+_.=-]{12,}/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    /Bearer\s+(?!<redacted>|\$\{)[A-Za-z0-9._-]{16,}/i,
    /Token\s+(?!<redacted>|\$\{)[A-Za-z0-9._-]{16,}/i,
  ];
  if (secretPatterns.some((pattern) => pattern.test(serialized))) {
    fail(`${label} contains secret-like credential material; use an explicit <redacted> placeholder`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function walkStructured(value, visit, pathSegments = []) {
  visit(value, pathSegments);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStructured(item, visit, [...pathSegments, String(index)]));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      walkStructured(child, visit, [...pathSegments, key]);
    }
  }
}

function collectEventNames(value) {
  const names = new Set();
  walkStructured(value, (node, segments) => {
    if (!isRecord(node)) return;
    for (const field of ['type', 'event', 'object']) {
      if (typeof node[field] === 'string' && node[field].trim() !== '') names.add(node[field]);
    }
    const semanticKeys = segments.filter((segment) => !/^\d+$/.test(segment));
    for (let index = 0; index < semanticKeys.length; index += 1) {
      names.add(semanticKeys.slice(index).join('.'));
    }
    for (const key of Object.keys(node)) {
      if (['type', 'event', 'object'].includes(key)) continue;
      const keyedPath = [...semanticKeys, key];
      for (let index = 0; index < keyedPath.length; index += 1) {
        names.add(keyedPath.slice(index).join('.'));
      }
    }
    if (node.direction === 'client' && node.frameType === 'binary') names.add('audio.binary');
    if (node.direction === 'client' && node.frameType === 'text' && node.json?.type === 'end') {
      names.add('end.text-json');
    }
    if (node.direction === 'server' && node.frameType === 'text' && isRecord(node.json?.result)) {
      names.add('result.text-json');
    }
    if (node.direction === 'server' && node.frameType === 'text' && node.json?.final !== undefined) {
      names.add('final.text-json');
    }
    if (typeof node.data === 'string' && node.data.replaceAll(' ', '') === '[DONE]') names.add('data.done');
  });
  return names;
}

function hasStructuredPayload(value) {
  if (Array.isArray(value)) return value.length > 0 && value.some(hasStructuredPayload);
  if (!isRecord(value)) return value !== null && value !== undefined && value !== '';
  return Object.keys(value).length > 0 && Object.values(value).some(hasStructuredPayload);
}

export function collectFixtureSemantics(fixtureDocuments) {
  const result = {
    endpoints: [],
    authContracts: [],
    clientEvents: new Set(),
    serverEvents: new Set(),
    terminalEvents: new Set(),
    hasClientPayload: false,
    hasServerPayload: false,
    hasAudioContract: false,
    hasAudioPayload: false,
    endpointStatuses: new Set(),
    networkAuthorizationDenied: false,
  };

  const clientFields = new Set(['request', 'clientEvents', 'clientMessages', 'clientMessage', 'clientApplicationFrames']);
  const serverFields = new Set([
    'response', 'responses', 'responseEvents', 'responseFrames', 'serverEvents', 'serverMessages',
    'serverFrames', 'serverTextFrame', 'terminalEvent', 'failureVariant',
  ]);
  for (const fixture of fixtureDocuments) {
    const data = fixture.data;
    walkStructured(data, (node, segments) => {
      const field = segments.at(-1);
      if (typeof node === 'string' && ['url', 'connectionUrl', 'endpoint'].includes(field)) {
        try {
          const endpoint = new URL(node);
          if (endpoint.protocol === 'https:' || endpoint.protocol === 'wss:') result.endpoints.push(endpoint);
        } catch {
          // Non-URL endpoint descriptions are not endpoint evidence.
        }
      }
      if (field === 'authContract' && isRecord(node)) result.authContracts.push(node);
      if (field === 'audioContract' && isRecord(node)) result.hasAudioContract = true;
      if (field === 'audio' && (typeof node === 'string' || isRecord(node))) result.hasAudioPayload = true;
      if (field === 'endpointStatus' && typeof node === 'string') result.endpointStatuses.add(node);
      if (field === 'networkAuthorized' && node === false) result.networkAuthorizationDenied = true;
      if (isRecord(node) && node.direction === 'client' && node.frameType === 'binary'
        && (node.payloadOmitted === true || Number.isInteger(node.byteLength))) {
        result.hasAudioPayload = true;
      }
    });

    for (const [field, value] of Object.entries(data)) {
      if (clientFields.has(field)) {
        result.hasClientPayload ||= hasStructuredPayload(value);
        for (const event of collectEventNames(value)) result.clientEvents.add(event);
      }
      if (serverFields.has(field)) {
        result.hasServerPayload ||= hasStructuredPayload(value);
        for (const event of collectEventNames(value)) result.serverEvents.add(event);
      }
      if (field === 'events' && Array.isArray(value)) {
        const client = value.filter((event) => event?.direction === 'client');
        const server = value.filter((event) => event?.direction === 'server' || event?.direction === undefined);
        result.hasClientPayload ||= client.some(hasStructuredPayload);
        result.hasServerPayload ||= server.some(hasStructuredPayload);
        for (const event of collectEventNames(client)) result.clientEvents.add(event);
        for (const event of collectEventNames(server)) result.serverEvents.add(event);
      }
    }

    const allEvents = collectEventNames(data);
    for (const event of allEvents) {
      if (event === 'data.done' || event.endsWith('.done') || event.endsWith('.completed')
        || event.endsWith('.failed') || event.endsWith('.turnComplete') || event === 'final.text-json') {
        result.terminalEvents.add(event);
      }
    }
    walkStructured(data, (node) => {
      if (!isRecord(node)) return;
      if (node.terminal === true && typeof node.type === 'string') result.terminalEvents.add(node.type);
      if (node.json?.final !== undefined) result.terminalEvents.add('final.text-json');
      if (typeof node.data === 'string' && node.data.replaceAll(' ', '') === '[DONE]') {
        result.terminalEvents.add('data.done');
      }
    });
  }
  return result;
}

function validateAuthCoverage(profile, authProfiles, semantics, label) {
  const contracts = semantics.authContracts.filter((contract) => profile.authProfileIds.includes(contract.profileId));
  if (contracts.length === 0) fail(`${label} lacks an authContract for one of its allowed auth profiles`);
  const matched = contracts.some((contract) => {
    const auth = authProfiles.get(contract.profileId);
    if (!auth || !Array.isArray(contract.parameters)) return false;
    return auth.parameters.filter((parameter) => parameter.required).every((expected) => (
      contract.parameters.some((actual) => actual?.location === expected.location
        && actual?.name === expected.name
        && typeof actual?.value === 'string'
        && actual.value.trim() !== '')
    ));
  });
  if (!matched) fail(`${label} authContract does not cover every required parameter of an allowed auth profile`);
}

function intersects(declared, observed) {
  const normalize = (event) => event.replaceAll(' ', '').replace('data:[DONE]', 'data.done');
  const normalizedObserved = new Set([...observed].map(normalize));
  return declared.some((event) => normalizedObserved.has(normalize(event)));
}

export function validateEnabledProfileFixtureCoverage(profile, lifecycle, authProfiles, fixtureDocuments, label) {
  const semantics = collectFixtureSemantics(fixtureDocuments);
  if (semantics.endpoints.length === 0) fail(`${label} lacks a structured secure endpoint URL`);
  validateAuthCoverage(profile, authProfiles, semantics, label);
  if (!semantics.hasClientPayload) fail(`${label} lacks a structured client request/event payload`);
  if (!semantics.hasServerPayload) fail(`${label} lacks a structured server response/event payload`);

  if (lifecycle.clientEvents.length > 0 && !intersects(lifecycle.clientEvents, semantics.clientEvents)) {
    fail(`${label} client fixture events do not match its lifecycle profile`);
  }
  if (lifecycle.serverEvents.length > 0 && !intersects(lifecycle.serverEvents, semantics.serverEvents)) {
    fail(`${label} server fixture events do not match its lifecycle profile`);
  }
  if (!intersects(lifecycle.serverEvents, semantics.terminalEvents)) {
    fail(`${label} lacks a machine-readable terminal server event declared by its lifecycle profile`);
  }
  if (profile.audioProfileId !== undefined) {
    if (!semantics.hasAudioContract) fail(`${label} lacks a structured audioContract`);
    if (!semantics.hasAudioPayload) fail(`${label} lacks a structured audio payload/frame example`);
  }
}

export function validateProfileFixtureCoverage(
  profile,
  family,
  lifecycle,
  authProfiles,
  fixtureDocuments,
  label,
) {
  if (family.endpointStatus === 'verified') {
    validateEnabledProfileFixtureCoverage(profile, lifecycle, authProfiles, fixtureDocuments, label);
    return;
  }

  const semantics = collectFixtureSemantics(fixtureDocuments);
  validateAuthCoverage(profile, authProfiles, semantics, label);
  if (!semantics.endpointStatuses.has(family.endpointStatus)) {
    fail(`${label} lacks structured '${family.endpointStatus}' endpoint evidence`);
  }
  if (!semantics.networkAuthorizationDenied) {
    fail(`${label} unresolved endpoint fixture must deny network authorization`);
  }
  if (semantics.hasServerPayload) {
    fail(`${label} unresolved endpoint fixture must not invent a server response`);
  }
}

function validateManifest(manifest, manifestPath) {
  const relativePath = path.relative(repositoryRoot, manifestPath).replaceAll('\\', '/');
  if (manifest?.$schema !== '../../contracts/provider-manifest.schema.json') {
    fail(`${relativePath} must reference ../../contracts/provider-manifest.schema.json`);
  }
  if (manifest?.schemaVersion !== 'provider-manifest/v1') {
    fail(`${relativePath} has unsupported schemaVersion '${manifest?.schemaVersion ?? ''}'`);
  }
  if (!Number.isInteger(manifest?.manifestVersion) || manifest.manifestVersion < 1) {
    fail(`${relativePath}.manifestVersion must be a positive integer`);
  }
  requiredString(manifest?.checkedAt, `${relativePath}.checkedAt`);

  const provider = manifest?.provider;
  const providerId = requiredString(provider?.id, `${relativePath}.provider.id`);
  const documentation = idMap(manifest.documentation, `${relativePath}.documentation`);
  const credentials = idMap(manifest.credentials, `${relativePath}.credentials`);
  const authProfiles = idMap(manifest.authProfiles, `${relativePath}.authProfiles`);
  const transports = idMap(manifest.transports, `${relativePath}.transports`);
  const audioProfiles = idMap(manifest.audioProfiles, `${relativePath}.audioProfiles`);
  const lifecycleProfiles = idMap(manifest.lifecycleProfiles, `${relativePath}.lifecycleProfiles`);
  const apiFamilies = idMap(manifest.apiFamilies, `${relativePath}.apiFamilies`);
  const protocolProfiles = versionedIdMap(manifest.protocolProfiles, `${relativePath}.protocolProfiles`);
  const models = idMap(manifest.models, `${relativePath}.models`);
  const probes = idMap(manifest.probes, `${relativePath}.probes`);
  const smokes = idMap(manifest.smokes, `${relativePath}.smokes`);
  const fixtures = idMap(manifest.fixtures, `${relativePath}.fixtures`);

  requireReference(credentials, provider.defaultCredentialId, `${relativePath}.provider.defaultCredentialId`);
  requireReference(apiFamilies, provider.defaultApiFamilyId, `${relativePath}.provider.defaultApiFamilyId`);
  requireReference(models, provider.defaultModelId, `${relativePath}.provider.defaultModelId`);

  for (const [id, document] of documentation) {
    const url = requiredString(document.url, `${relativePath}.documentation.${id}.url`);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      fail(`${relativePath}.documentation.${id}.url is invalid`);
    }
    if (parsed.protocol !== 'https:') fail(`${relativePath}.documentation.${id}.url must use HTTPS`);
    requiredString(document.checkedAt, `${relativePath}.documentation.${id}.checkedAt`);
  }

  for (const [id, credential] of credentials) {
    requiredString(credential.reference, `${relativePath}.credentials.${id}.reference`);
    if (array(credential.fields, `${relativePath}.credentials.${id}.fields`).length === 0) {
      fail(`${relativePath}.credentials.${id}.fields must not be empty`);
    }
  }

  for (const [id, auth] of authProfiles) {
    requireReference(credentials, auth.credentialId, `${relativePath}.authProfiles.${id}.credentialId`);
    const credential = credentials.get(auth.credentialId);
    const credentialFieldIds = new Set(array(credential.fields, `${relativePath}.credentials.${auth.credentialId}.fields`)
      .map((field) => requiredString(field.id, `${relativePath}.credentials.${auth.credentialId}.fields[].id`)));
    for (const parameter of array(auth.parameters, `${relativePath}.authProfiles.${id}.parameters`)) {
      requiredString(parameter.name, `${relativePath}.authProfiles.${id}.parameters[].name`);
      if (parameter.source === 'credential') {
        const fieldId = requiredString(
          parameter.credentialFieldId,
          `${relativePath}.authProfiles.${id}.parameters[].credentialFieldId`,
        );
        if (!credentialFieldIds.has(fieldId)) {
          fail(`${relativePath}.authProfiles.${id} references missing credential field '${fieldId}'`);
        }
      } else if (parameter.source === 'static') {
        requiredString(parameter.staticValue, `${relativePath}.authProfiles.${id}.parameters[].staticValue`);
      } else if (parameter.source === 'derived') {
        requiredString(parameter.derivation, `${relativePath}.authProfiles.${id}.parameters[].derivation`);
      } else {
        fail(`${relativePath}.authProfiles.${id}.parameters[].source is unsupported`);
      }
    }
    if (auth.type.includes('hmac') && !auth.signing) {
      fail(`${relativePath}.authProfiles.${id} HMAC auth requires signing metadata`);
    }
    if (auth.credentialBootstrap) {
      requireReferences(
        documentation,
        auth.credentialBootstrap.documentationIds,
        `${relativePath}.authProfiles.${id}.credentialBootstrap.documentationIds`,
      );
      requiredString(
        auth.credentialBootstrap.description,
        `${relativePath}.authProfiles.${id}.credentialBootstrap.description`,
      );
    }
  }

  for (const [id, transport] of transports) {
    if (!transport.requestEnvelope || !transport.responseEnvelope) {
      fail(`${relativePath}.transports.${id} must declare request and response envelopes`);
    }
    if (transport.requestFraming === 'protobuf' && transport.requestEnvelope.kind === 'typed-header') {
      requiredString(transport.requestEnvelope.id, `${relativePath}.transports.${id}.requestEnvelope.id`);
    }
    if (transport.responseFraming === 'protobuf' && transport.responseEnvelope.kind === 'typed-header') {
      requiredString(transport.responseEnvelope.id, `${relativePath}.transports.${id}.responseEnvelope.id`);
    }
  }

  for (const [id, family] of apiFamilies) {
    requireReference(transports, family.transportId, `${relativePath}.apiFamilies.${id}.transportId`);
    requireReferences(authProfiles, family.authProfileIds, `${relativePath}.apiFamilies.${id}.authProfileIds`);
    requireReference(authProfiles, family.defaultAuthProfileId, `${relativePath}.apiFamilies.${id}.defaultAuthProfileId`);
    if (!family.authProfileIds.includes(family.defaultAuthProfileId)) {
      fail(`${relativePath}.apiFamilies.${id}.defaultAuthProfileId must be present in authProfileIds`);
    }
    requireReferences(documentation, family.documentationIds, `${relativePath}.apiFamilies.${id}.documentationIds`);
    requiredString(family.baseUrlTemplate, `${relativePath}.apiFamilies.${id}.baseUrlTemplate`);
    if (family.endpointStatus === 'verified') {
      requiredString(family.endpointTemplate, `${relativePath}.apiFamilies.${id}.endpointTemplate`);
    } else if (family.endpointTemplate !== null && family.endpointTemplate !== undefined) {
      requiredString(family.endpointTemplate, `${relativePath}.apiFamilies.${id}.endpointTemplate`);
    }
  }

  for (const [profileKey, profile] of protocolProfiles) {
    const id = profile.id;
    if (!id.startsWith(`${providerId}.`)) {
      fail(`${relativePath}.protocolProfiles.${profileKey}.id must be namespaced by provider id '${providerId}.'`);
    }
    requireReference(apiFamilies, profile.apiFamilyId, `${relativePath}.protocolProfiles.${id}.apiFamilyId`);
    requireReference(transports, profile.transportId, `${relativePath}.protocolProfiles.${id}.transportId`);
    requireReferences(authProfiles, profile.authProfileIds, `${relativePath}.protocolProfiles.${id}.authProfileIds`);
    requireReference(authProfiles, profile.defaultAuthProfileId, `${relativePath}.protocolProfiles.${id}.defaultAuthProfileId`);
    if (!profile.authProfileIds.includes(profile.defaultAuthProfileId)) {
      fail(`${relativePath}.protocolProfiles.${id}.defaultAuthProfileId must be present in authProfileIds`);
    }
    const family = apiFamilies.get(profile.apiFamilyId);
    if (profile.transportId !== family.transportId) {
      fail(`${relativePath}.protocolProfiles.${id}.transportId must match API family '${family.id}'`);
    }
    for (const authProfileId of profile.authProfileIds) {
      if (!family.authProfileIds.includes(authProfileId)) {
        fail(`${relativePath}.protocolProfiles.${id} auth '${authProfileId}' is not allowed by API family '${family.id}'`);
      }
    }
    requireReference(lifecycleProfiles, profile.lifecycleProfileId, `${relativePath}.protocolProfiles.${id}.lifecycleProfileId`);
    if (profile.audioProfileId !== undefined) {
      requireReference(audioProfiles, profile.audioProfileId, `${relativePath}.protocolProfiles.${id}.audioProfileId`);
    }
    requireReferences(documentation, profile.documentationIds, `${relativePath}.protocolProfiles.${id}.documentationIds`);
    requireReferences(fixtures, profile.fixtureIds, `${relativePath}.protocolProfiles.${id}.fixtureIds`);
    validateProfileContractCompleteness(profile, `${relativePath}.protocolProfiles.${id}`);
    const operations = new Set(array(profile.operations, `${relativePath}.protocolProfiles.${id}.operations`));
    if (operations.size === 0) fail(`${relativePath}.protocolProfiles.${id}.operations must not be empty`);
    if (profile.adapter?.verification === 'live-verified' && profile.adapter?.status !== 'enabled') {
      fail(`${relativePath}.protocolProfiles.${id} cannot be live-verified with a disabled adapter`);
    }
    if (profile.adapter?.verification === 'not-implemented' && profile.adapter?.status !== 'disabled') {
      fail(`${relativePath}.protocolProfiles.${id} must disable a not-implemented adapter`);
    }
    if (profile.adapter?.verification === 'fixture-only' && profile.fixtureIds.length === 0) {
      fail(`${relativePath}.protocolProfiles.${id} fixture-only adapter requires a fixture`);
    }
  }

  for (const [id, model] of models) {
    requireReferences(documentation, model.documentationIds, `${relativePath}.models.${id}.documentationIds`);
    const boundOperations = new Set();
    for (const binding of array(model.protocolBindings, `${relativePath}.models.${id}.protocolBindings`)) {
      const operation = requiredString(binding.operation, `${relativePath}.models.${id}.protocolBindings[].operation`);
      if (boundOperations.has(operation)) {
        fail(`${relativePath}.models.${id} has more than one profile for operation '${operation}'`);
      }
      boundOperations.add(operation);
      const profile = requireProfileReference(
        protocolProfiles,
        binding.protocolProfileId,
        binding.protocolProfileVersion,
        `${relativePath}.models.${id}.protocolBindings[]`,
      );
      if (!profile.operations.includes(operation)) {
        fail(`${relativePath}.models.${id} binds '${operation}' to profile '${profile.id}@${profile.version}' that does not allow it`);
      }
    }
  }

  const defaultModel = models.get(provider.defaultModelId);
  const defaultModelUsesDefaultFamily = defaultModel.protocolBindings.some((binding) => (
    protocolProfiles.get(`${binding.protocolProfileId}@${binding.protocolProfileVersion}`)?.apiFamilyId
      === provider.defaultApiFamilyId
  ));
  if (!defaultModelUsesDefaultFamily) {
    fail(`${relativePath}.provider defaults do not resolve to a single model binding/API family pair`);
  }

  const fixtureDocuments = new Map();
  for (const [id, fixture] of fixtures) {
    requireReferences(documentation, fixture.sourceDocumentationIds, `${relativePath}.fixtures.${id}.sourceDocumentationIds`);
    const providerModuleRoot = path.dirname(manifestPath);
    const fixturePath = resolveInside(
      providerModuleRoot,
      fixture.path,
      `${relativePath}.fixtures.${id}.path`,
    );
    if (!fs.existsSync(fixturePath)) fail(`${relativePath}.fixtures.${id}.path does not exist: ${fixture.path}`);
    const fixtureDocument = readJson(fixturePath);
    const fixtureLabel = path.relative(repositoryRoot, fixturePath).replaceAll('\\', '/');
    assertNoSecretLikeMaterial(fixtureDocument, fixtureLabel);
    if (fixtureDocument?.$schema !== '../../../contracts/provider-wire-fixture.schema.json') {
      fail(`${fixtureLabel} must reference ../../../contracts/provider-wire-fixture.schema.json`);
    }
    if (fixtureDocument?.schemaVersion !== 'provider-wire-fixture/v1') {
      fail(`${fixtureLabel} has unsupported schemaVersion '${fixtureDocument?.schemaVersion ?? ''}'`);
    }
    if (fixtureDocument?.id !== id) fail(`${fixtureLabel}.id must equal manifest fixture id '${id}'`);
    if (fixtureDocument?.providerId !== providerId) {
      fail(`${fixtureLabel}.providerId must equal '${providerId}'`);
    }
    if (fixtureDocument?.kind !== fixture.kind) {
      fail(`${fixtureLabel}.kind must equal manifest kind '${fixture.kind}'`);
    }
    if (fixtureDocument?.provenance?.sanitized !== true) {
      fail(`${fixtureLabel}.provenance.sanitized must be true`);
    }
    if (typeof fixtureDocument?.provenance?.capturedFromLive !== 'boolean') {
      fail(`${fixtureLabel}.provenance.capturedFromLive must be a boolean`);
    }
    requireReferences(
      documentation,
      fixtureDocument?.provenance?.sourceDocumentationIds,
      `${fixtureLabel}.provenance.sourceDocumentationIds`,
    );
    const fixtureProfile = requireProfileReference(
      protocolProfiles,
      fixtureDocument?.protocolProfileId,
      fixtureDocument?.protocolProfileVersion,
      `${fixtureLabel}.protocolProfile`,
    );
    if (!fixtureProfile.fixtureIds.includes(id)) {
      fail(`${fixtureLabel} points to profile '${fixtureProfile.id}@${fixtureProfile.version}' that does not list fixture '${id}'`);
    }
    if (fixtureDocument.provenance.capturedFromLive) {
      const evidencePath = path.join(
        repositoryRoot,
        requiredString(fixtureDocument.provenance.evidencePath, `${fixtureLabel}.provenance.evidencePath`),
      );
      if (!fs.existsSync(evidencePath)) fail(`${fixtureLabel} live evidence path does not exist`);
      if (fixtureProfile.adapter.verification !== 'live-verified') {
        fail(`${fixtureLabel} is marked capturedFromLive but its profile is not live-verified`);
      }
    }
    requiredString(fixtureDocument?.scenario, `${fixtureLabel}.scenario`);
    if (!fixtureDocument?.data || typeof fixtureDocument.data !== 'object' || Array.isArray(fixtureDocument.data)) {
      fail(`${fixtureLabel}.data must be an object`);
    }
    fixtureDocuments.set(id, fixtureDocument);
  }

  for (const [, profile] of protocolProfiles) {
    for (const fixtureId of profile.fixtureIds) {
      const fixtureDocument = fixtureDocuments.get(fixtureId);
      if (
        fixtureDocument.protocolProfileId !== profile.id
        || fixtureDocument.protocolProfileVersion !== profile.version
      ) {
        fail(
          `${relativePath}.protocolProfiles.${profile.id}@${profile.version} lists fixture '${fixtureId}' owned by '${fixtureDocument.protocolProfileId}@${fixtureDocument.protocolProfileVersion}'`,
        );
      }
    }
    validateProfileFixtureCoverage(
      profile,
      apiFamilies.get(profile.apiFamilyId),
      lifecycleProfiles.get(profile.lifecycleProfileId),
      authProfiles,
      profile.fixtureIds.map((fixtureId) => fixtureDocuments.get(fixtureId)),
      `${relativePath}.protocolProfiles.${profile.id}@${profile.version}`,
    );
  }

  for (const [collectionName, checks] of [['probes', probes], ['smokes', smokes]]) {
    for (const [id, check] of checks) {
      requireProfileReference(
        protocolProfiles,
        check.protocolProfileId,
        check.protocolProfileVersion,
        `${relativePath}.${collectionName}.${id}`,
      );
      if (check.fixtureId !== undefined) {
        requireReference(fixtures, check.fixtureId, `${relativePath}.${collectionName}.${id}.fixtureId`);
        const fixtureDocument = fixtureDocuments.get(check.fixtureId);
        if (
          fixtureDocument.protocolProfileId !== check.protocolProfileId
          || fixtureDocument.protocolProfileVersion !== check.protocolProfileVersion
        ) {
          fail(
            `${relativePath}.${collectionName}.${id} uses fixture '${check.fixtureId}' from a different profile version`,
          );
        }
      }
    }
  }

  validateDocumentationUsage(documentation, manifest, relativePath);

  return { providerId, relativePath };
}

export function loadProviderManifests() {
  if (!fs.existsSync(modulesRoot)) fail('provider-modules directory is missing');
  const manifestPaths = fs.readdirSync(modulesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(modulesRoot, entry.name, 'manifest.json'))
    .filter((manifestPath) => fs.existsSync(manifestPath))
    .sort();

  const providers = new Map();
  const manifests = [];
  for (const manifestPath of manifestPaths) {
    const manifest = readJson(manifestPath);
    assertNoSecretLikeMaterial(manifest, path.relative(repositoryRoot, manifestPath));
    const result = validateManifest(manifest, manifestPath);
    if (providers.has(result.providerId)) {
      fail(`provider id '${result.providerId}' is declared by both ${providers.get(result.providerId)} and ${result.relativePath}`);
    }
    providers.set(result.providerId, result.relativePath);
    manifests.push({ manifest, manifestPath, ...result });
  }

  return { manifests, providers };
}

export function verifyProviderManifests() {
  const { manifests, providers } = loadProviderManifests();

  const missing = [...FIRST_BATCH_PROVIDER_IDS].filter((id) => !providers.has(id));
  if (missing.length > 0) fail(`first-batch provider modules missing: ${missing.join(', ')}`);
  return { providerCount: manifests.length, providers: [...providers.keys()].sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyProviderManifests();
    console.log(`provider manifests verified: ${result.providerCount} (${result.providers.join(', ')})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
