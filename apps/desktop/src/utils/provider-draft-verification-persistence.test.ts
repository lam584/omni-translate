import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../defaults/app-config';
import { hydrateLegacyProviderManifestAuthority } from '../provider-manifest/legacy-migration';
import { appStoreTestHelpers } from '../stores/app-store';
import { providerVerificationIdentity, reconcilePersistedProviderVerification } from './provider-draft-verification';

describe('binding-scoped persisted verification', () => {
  it('retains unsigned legacy records without claiming signed verification', () => {
    const provider = structuredClone(appConfigDraftMock.providers[0]);
    expect(reconcilePersistedProviderVerification(provider)).toBe(provider);
    expect(provider.probe.configurationSignature).toBeUndefined();
  });
  it('retains matching results but invalidates imported connection or profile edits', () => {
    const config = structuredClone(appConfigDraftMock);
    const provider = hydrateLegacyProviderManifestAuthority(config.providers[0]);
    provider.status = 'ready';
    provider.probe = {...provider.probe, checkedAt:'2026-09-20T10:00:00Z', verdict:'available'};
    provider.probe.configurationSignature = providerVerificationIdentity(provider);
    config.providers[0] = provider;
    expect(reconcilePersistedProviderVerification(provider)).toBe(provider);
    expect(appStoreTestHelpers.mergeConfigDraftWithDefaults(config).providers[0].probe.checkedAt).toBe(provider.probe.checkedAt);
    const edited = structuredClone(config);
    edited.providers[0].baseUrl = 'https://different.invalid';
    const loaded = appStoreTestHelpers.mergeConfigDraftWithDefaults(edited).providers[0];
    expect(loaded.probe.checkedAt).toBe('pending-probe');
    expect(loaded.status).toBe('draft');
    expect(loaded.probe.configurationSignature).toBe(provider.probe.configurationSignature);
  });
});
