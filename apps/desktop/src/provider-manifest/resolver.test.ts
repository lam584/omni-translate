import { describe, expect, it } from 'vitest';

import { migrateLegacyProviderProtocolBinding } from './legacy-migration';
import { ProviderProtocolResolutionError, resolveProviderProtocol } from './resolver';
import type { ProviderManifest } from './types';

const manifest: ProviderManifest = {
  $schema: '../../contracts/provider-manifest.schema.json',
  schemaVersion: 'provider-manifest/v1',
  manifestVersion: 1,
  checkedAt: '2026-08-31',
  provider: {
    id: 'fixture-provider',
    displayName: 'Fixture Provider',
    templateId: 'template-fixture-provider',
    kind: 'fixture',
    source: 'official',
    description: 'Resolver test fixture.',
    defaultModelId: 'voice-model',
    defaultApiFamilyId: 'fixture.realtime',
    defaultCredentialId: 'fixture-key',
  },
  documentation: [{ id: 'fixture-doc', title: 'Fixture', url: 'https://example.com', checkedAt: '2026-08-31' }],
  credentials: [{
    id: 'fixture-key',
    reference: 'credential://provider/fixture/default',
    fields: [{ id: 'api-key', label: 'API key', secret: true, required: true }],
  }],
  authProfiles: [{
    id: 'fixture.bearer',
    type: 'bearer',
    credentialId: 'fixture-key',
    parameters: [{
      location: 'header', name: 'Authorization', source: 'credential', credentialFieldId: 'api-key', scheme: 'Bearer', required: true,
    }],
  }],
  transports: [{
    id: 'fixture.ws',
    kind: 'websocket',
    requestFraming: 'json-base64',
    responseFraming: 'json-base64',
    requestEnvelope: { kind: 'none' },
    responseEnvelope: { kind: 'none' },
  }],
  audioProfiles: [{
    id: 'fixture.pcm',
    input: { required: true, formats: ['pcm16'], sampleRatesHz: [16_000], channels: [1] },
    output: { required: true, formats: ['pcm16'], sampleRatesHz: [24_000], channels: [1] },
  }],
  lifecycleProfiles: [{
    id: 'fixture.session', handshake: ['session.created'], clientEvents: ['audio.append'], serverEvents: ['response.done'],
    vadModes: ['server-vad'], terminal: 'response.done then close', reuse: 'single-session', textDeltaSemantics: 'append-delta',
  }],
  apiFamilies: [{
    id: 'fixture.realtime', displayName: 'Fixture realtime', baseUrlTemplate: 'https://example.com', endpointTemplate: '/realtime',
    endpointStatus: 'verified', modelAddressing: 'model-id', transportId: 'fixture.ws',
    authProfileIds: ['fixture.bearer'], defaultAuthProfileId: 'fixture.bearer', maturity: 'ga', documentationIds: ['fixture-doc'],
  }],
  protocolProfiles: [{
    id: 'fixture.realtime.ws', version: 3, apiFamilyId: 'fixture.realtime', transportId: 'fixture.ws',
    authProfileIds: ['fixture.bearer'], defaultAuthProfileId: 'fixture.bearer',
    audioProfileId: 'fixture.pcm', lifecycleProfileId: 'fixture.session',
    operations: ['realtime-conversation'], capabilities: ['speech-to-speech'], maturity: 'ga',
    adapter: { id: 'fixture-adapter', status: 'enabled', verification: 'fixture-only' },
    documentationIds: ['fixture-doc'], fixtureIds: ['fixture-wire'],
    legacyProtocolIds: ['legacy-fixture-realtime'],
    customProviderPolicy: 'explicit-profile',
    customEndpointPolicy: 'absolute-secure-url-no-userinfo',
  }],
  models: [{
    id: 'voice-model', displayName: 'Voice model', capabilities: ['speech-to-speech'], maturity: 'ga',
    protocolBindings: [{
      operation: 'realtime-conversation', protocolProfileId: 'fixture.realtime.ws', protocolProfileVersion: 3,
    }],
    documentationIds: ['fixture-doc'],
  }],
  probes: [],
  smokes: [],
  fixtures: [{ id: 'fixture-wire', path: 'provider-modules/fixture/fixtures/wire.json', kind: 'wire', sourceDocumentationIds: ['fixture-doc'] }],
};

function expectCode(callback: () => unknown, code: ProviderProtocolResolutionError['code']) {
  expect(callback).toThrowError(ProviderProtocolResolutionError);
  try {
    callback();
  } catch (error) {
    expect((error as ProviderProtocolResolutionError).code).toBe(code);
  }
}

describe('resolveProviderProtocol', () => {
  it('authorizes the exact model, operation, profile and version', () => {
    const authority = resolveProviderProtocol([manifest], {
      providerId: 'fixture-provider',
      modelId: 'voice-model',
      operation: 'realtime-conversation',
      declaredProfileId: 'fixture.realtime.ws',
      declaredProfileVersion: 3,
    });
    expect(authority.protocolProfile.id).toBe('fixture.realtime.ws');
    expect(authority.lifecycleProfile.terminal).toBe('response.done then close');
  });

  it('does not infer a protocol from an unknown realtime-looking model name', () => {
    expectCode(() => resolveProviderProtocol([manifest], {
      providerId: 'fixture-provider',
      modelId: 'voice-model-realtime-next',
      operation: 'realtime-conversation',
    }), 'model-not-found');
  });

  it('matches runtime model identity byte-for-byte', () => {
    expectCode(() => resolveProviderProtocol([manifest], {
      providerId: 'fixture-provider',
      modelId: 'VOICE-MODEL',
      operation: 'realtime-conversation',
    }), 'model-not-found');
  });

  it('rejects a declared profile that differs from the exact model binding', () => {
    expectCode(() => resolveProviderProtocol([manifest], {
      providerId: 'fixture-provider',
      modelId: 'voice-model',
      operation: 'realtime-conversation',
      declaredProfileId: 'some-other-profile',
    }), 'protocol-profile-model-mismatch');
  });

  it('rejects a declared version that differs from the exact model binding', () => {
    expectCode(() => resolveProviderProtocol([manifest], {
      providerId: 'fixture-provider',
      modelId: 'voice-model',
      operation: 'realtime-conversation',
      declaredProfileId: 'fixture.realtime.ws',
      declaredProfileVersion: 2,
    }), 'protocol-profile-version-mismatch');
  });

  it('requires a deployment id when the API family addresses Azure-style deployments', () => {
    const deploymentManifest = structuredClone(manifest);
    deploymentManifest.apiFamilies[0]!.modelAddressing = 'deployment-id';
    expectCode(() => resolveProviderProtocol([deploymentManifest], {
      providerId: 'fixture-provider',
      modelId: 'voice-model',
      operation: 'realtime-conversation',
    }), 'deployment-id-required');

    expect(resolveProviderProtocol([deploymentManifest], {
      providerId: 'fixture-provider',
      modelId: 'voice-model',
      deploymentId: 'production-blue',
      operation: 'realtime-conversation',
    }).deploymentId).toBe('production-blue');
  });

  it('fails before connection when the official endpoint is unresolved', () => {
    const unresolvedManifest = structuredClone(manifest);
    unresolvedManifest.apiFamilies[0]!.endpointStatus = 'unresolved';
    unresolvedManifest.apiFamilies[0]!.endpointTemplate = null;
    expectCode(() => resolveProviderProtocol([unresolvedManifest], {
      providerId: 'fixture-provider',
      modelId: 'voice-model',
      operation: 'realtime-conversation',
    }), 'api-family-unresolved');
  });

  it('fails before connection when an endpoint is retained only for migration', () => {
    const deprecatedManifest = structuredClone(manifest);
    deprecatedManifest.apiFamilies[0]!.endpointStatus = 'deprecated';
    expectCode(() => resolveProviderProtocol([deprecatedManifest], {
      providerId: 'fixture-provider',
      modelId: 'voice-model',
      operation: 'realtime-conversation',
    }), 'api-family-unresolved');
  });

  it('rejects an auth profile that the exact protocol profile does not allow', () => {
    expectCode(() => resolveProviderProtocol([manifest], {
      providerId: 'fixture-provider',
      modelId: 'voice-model',
      operation: 'realtime-conversation',
      declaredAuthProfileId: 'fixture.query-key',
    }), 'auth-profile-not-allowed');
  });

  it('requires custom providers to select an explicit profile and version', () => {
    expectCode(() => resolveProviderProtocol([manifest], {
      providerId: 'custom-provider',
      modelId: 'voice-model',
      operation: 'realtime-conversation',
      customProvider: true,
    }), 'protocol-profile-required');
  });

  it('allows a custom provider to opt into an exact registered profile version', () => {
    const authority = resolveProviderProtocol([manifest], {
      providerId: 'custom-provider',
      modelId: 'custom-model',
      operation: 'realtime-conversation',
      customProvider: true,
      declaredManifestVersion: 1,
      declaredProfileId: 'fixture.realtime.ws',
      declaredProfileVersion: 3,
      baseUrl: 'https://custom.example.test/v1',
      transport: 'websocket',
      authHeaderName: 'Authorization',
      authScheme: 'bearer',
    });
    expect(authority.modelId).toBe('custom-model');
    expect(authority.providerId).toBe('custom-provider');
    expect(authority.profileOwnerProviderId).toBe('fixture-provider');
    expect(authority.protocolProfile.id).toBe('fixture.realtime.ws');
  });

  it('rejects custom reuse unless the profile explicitly permits it', () => {
    const privateManifest = structuredClone(manifest);
    privateManifest.protocolProfiles[0]!.customProviderPolicy = 'forbidden';
    expectCode(() => resolveProviderProtocol([privateManifest], {
      providerId: 'custom-provider',
      modelId: 'custom-model',
      operation: 'realtime-conversation',
      customProvider: true,
      declaredManifestVersion: 1,
      declaredProfileId: 'fixture.realtime.ws',
      declaredProfileVersion: 3,
    }), 'custom-provider-profile-forbidden');
  });

  it('does not let a custom instance bypass policy by naming a built-in template', () => {
    const privateManifest = structuredClone(manifest);
    privateManifest.protocolProfiles[0]!.customProviderPolicy = 'forbidden';
    expectCode(() => resolveProviderProtocol([privateManifest], {
      providerId: 'custom-provider',
      templateId: 'template-fixture-provider',
      modelId: 'custom-model',
      operation: 'realtime-conversation',
      customProvider: true,
      declaredManifestVersion: 1,
      declaredProfileId: 'fixture.realtime.ws',
      declaredProfileVersion: 3,
    }), 'custom-provider-profile-forbidden');
  });

  it('separates runtime provider identity from manifest ownership', () => {
    const authority = resolveProviderProtocol([manifest], {
      providerId: 'provider-instance-7',
      templateId: 'template-fixture-provider',
      modelId: 'voice-model',
      operation: 'realtime-conversation',
    });
    expect(authority.providerId).toBe('provider-instance-7');
    expect(authority.profileOwnerProviderId).toBe('fixture-provider');
  });

  it('rejects substituting another built-in provider owner', () => {
    const other = structuredClone(manifest);
    other.provider.id = 'other-provider';
    other.provider.templateId = 'template-other-provider';
    expectCode(() => resolveProviderProtocol([manifest, other], {
      providerId: 'other-provider',
      templateId: 'template-fixture-provider',
      modelId: 'voice-model',
      operation: 'realtime-conversation',
    }), 'provider-owner-mismatch');
  });

  it('keeps legacy protocol interpretation inside the migration boundary', () => {
    expect(migrateLegacyProviderProtocolBinding([manifest], {
      providerId: 'old-custom-provider',
      modelId: 'unregistered-model',
      legacyProtocolId: 'legacy-fixture-realtime',
    }, 'realtime-conversation')).toEqual({
      profileId: 'fixture.realtime.ws',
      profileVersion: 3,
      source: 'legacy-protocol-id',
    });
  });
});
