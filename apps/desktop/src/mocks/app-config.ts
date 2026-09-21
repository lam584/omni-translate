// Explicit pre-v2 test fixture. Production defaults deliberately persist no
// module projections; legacy compatibility tests still need a copied registry.
import type { AppConfigDraft } from '../schema/config';
import { appConfigDraftMock as defaults } from '../defaults/app-config';
import { createDefaultLocalModelCapabilityRegistry } from '../utils/provider-model-capabilities';
export const appConfigDraftMock: AppConfigDraft = {
  ...defaults,
  providers: defaults.providers.map((provider) => ({
    ...provider,
    modelRegistryVersion: undefined,
    modelCapabilityOverrides: undefined,
    localModelCapabilityRegistry: createDefaultLocalModelCapabilityRegistry(),
  })),
};
