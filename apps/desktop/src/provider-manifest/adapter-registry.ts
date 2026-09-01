import type { AuthorizedProviderProtocol } from './types';

export type ProviderAdapterRegistration = {
  id: string;
  supportedProfiles: Array<{
    profileId: string;
    profileVersion: number;
  }>;
};

export type ProviderConnectionPlan = {
  authority: AuthorizedProviderProtocol;
  adapter: ProviderAdapterRegistration;
  endpoint: {
    baseUrlTemplate: string;
    endpointTemplate: string;
    modelId: string;
    deploymentId: string | null;
  };
};

export type ProviderAdapterRegistryErrorCode =
  | 'adapter-not-registered'
  | 'adapter-profile-version-unsupported';

export class ProviderAdapterRegistryError extends Error {
  constructor(public readonly code: ProviderAdapterRegistryErrorCode, message: string) {
    super(message);
    this.name = 'ProviderAdapterRegistryError';
  }
}

export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapterRegistration>();

  constructor(registrations: ProviderAdapterRegistration[]) {
    for (const registration of registrations) {
      if (this.adapters.has(registration.id)) {
        throw new Error(`Provider adapter '${registration.id}' is registered more than once.`);
      }
      this.adapters.set(registration.id, registration);
    }
  }

  buildConnectionPlan(authority: AuthorizedProviderProtocol): ProviderConnectionPlan {
    const adapterId = authority.protocolProfile.adapter.id;
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new ProviderAdapterRegistryError(
        'adapter-not-registered',
        `Provider adapter '${adapterId}' is not registered in this runtime.`,
      );
    }
    const supported = adapter.supportedProfiles.some((candidate) => (
      candidate.profileId === authority.protocolProfile.id
      && candidate.profileVersion === authority.protocolProfile.version
    ));
    if (!supported) {
      throw new ProviderAdapterRegistryError(
        'adapter-profile-version-unsupported',
        `Provider adapter '${adapterId}' does not support '${authority.protocolProfile.id}' version ${authority.protocolProfile.version}.`,
      );
    }
    const endpointTemplate = authority.apiFamily.endpointTemplate;
    if (endpointTemplate === null) {
      throw new Error(`Authorized API family '${authority.apiFamily.id}' has no endpoint template.`);
    }
    return {
      authority,
      adapter,
      endpoint: {
        baseUrlTemplate: authority.apiFamily.baseUrlTemplate,
        endpointTemplate,
        modelId: authority.modelId,
        deploymentId: authority.deploymentId,
      },
    };
  }
}
