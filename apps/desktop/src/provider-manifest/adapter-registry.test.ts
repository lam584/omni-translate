import { describe, expect, it } from 'vitest';

import {
  ProviderAdapterRegistry,
  ProviderAdapterRegistryError,
} from './adapter-registry';
import type { AuthorizedProviderProtocol } from './types';

function authority(): AuthorizedProviderProtocol {
  return {
    manifestVersion: 1,
    providerId: 'fixture-provider',
    profileOwnerProviderId: 'fixture-provider',
    modelId: 'voice-model',
    deploymentId: null,
    operation: 'realtime-conversation',
    protocolProfile: {
      id: 'fixture-provider.realtime',
      version: 2,
      apiFamilyId: 'fixture.api',
      transportId: 'fixture.ws',
      authProfileIds: ['fixture.bearer'],
      defaultAuthProfileId: 'fixture.bearer',
      lifecycleProfileId: 'fixture.session',
      operations: ['realtime-conversation'],
      capabilities: ['speech-to-speech'],
      maturity: 'ga',
      adapter: { id: 'fixture-adapter', status: 'enabled', verification: 'fixture-only' },
      documentationIds: ['fixture-doc'],
      fixtureIds: ['fixture-wire'],
    },
    apiFamily: {
      id: 'fixture.api',
      displayName: 'Fixture API',
      baseUrlTemplate: 'https://example.com',
      endpointTemplate: '/realtime',
      endpointStatus: 'verified',
      modelAddressing: 'model-id',
      transportId: 'fixture.ws',
      authProfileIds: ['fixture.bearer'],
      defaultAuthProfileId: 'fixture.bearer',
      maturity: 'ga',
      documentationIds: ['fixture-doc'],
    },
    transport: {
      id: 'fixture.ws',
      kind: 'websocket',
      requestFraming: 'json-base64',
      responseFraming: 'json-base64',
      requestEnvelope: { kind: 'none' },
      responseEnvelope: { kind: 'none' },
    },
    authProfile: {
      id: 'fixture.bearer',
      type: 'bearer',
      credentialId: 'fixture-key',
      parameters: [{
        location: 'header',
        name: 'Authorization',
        source: 'credential',
        credentialFieldId: 'api-key',
        scheme: 'Bearer',
        required: true,
      }],
    },
    audioProfile: null,
    lifecycleProfile: {
      id: 'fixture.session',
      handshake: ['session.created'],
      clientEvents: ['audio.append'],
      serverEvents: ['response.done'],
      vadModes: ['server-vad'],
      terminal: 'response.done',
      reuse: 'multi-turn',
    },
  };
}

function expectCode(callback: () => unknown, code: ProviderAdapterRegistryError['code']) {
  expect(callback).toThrowError(ProviderAdapterRegistryError);
  try {
    callback();
  } catch (error) {
    expect((error as ProviderAdapterRegistryError).code).toBe(code);
  }
}

describe('ProviderAdapterRegistry', () => {
  it('builds a plan only for an exact registered profile version', () => {
    const registry = new ProviderAdapterRegistry([{
      id: 'fixture-adapter',
      supportedProfiles: [{ profileId: 'fixture-provider.realtime', profileVersion: 2 }],
    }]);
    expect(registry.buildConnectionPlan(authority()).endpoint).toEqual({
      baseUrlTemplate: 'https://example.com',
      endpointTemplate: '/realtime',
      modelId: 'voice-model',
      deploymentId: null,
    });
  });

  it('fails before connection when the manifest adapter is absent from the runtime', () => {
    expectCode(() => new ProviderAdapterRegistry([]).buildConnectionPlan(authority()), 'adapter-not-registered');
  });

  it('fails before connection when the runtime does not support the manifest version', () => {
    const registry = new ProviderAdapterRegistry([{
      id: 'fixture-adapter',
      supportedProfiles: [{ profileId: 'fixture-provider.realtime', profileVersion: 1 }],
    }]);
    expectCode(() => registry.buildConnectionPlan(authority()), 'adapter-profile-version-unsupported');
  });
});
