import type { ProviderDraft } from '../schema/config';
import { PENDING_PROBE_CHECKED_AT } from '../schema/provider-probe';

function canonicalConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalConfiguration);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalConfiguration(item)]));
  }
  return value;
}

export function providerVerificationIdentity(provider: ProviderDraft): string {
  // Exclude results/cache/UI status, so accepting a result does not invalidate itself.
  const configuration = Object.fromEntries(Object.entries(provider).filter(([key]) => !['probe', 'status', 'modelCatalogCache'].includes(key)));
  return JSON.stringify(canonicalConfiguration(configuration));
}

export function invalidateChangedProvider(previous: ProviderDraft, next: ProviderDraft): ProviderDraft {
  if (providerVerificationIdentity(previous) === providerVerificationIdentity(next)) return next;
  return { ...next, status: 'draft', probe: { ...next.probe, checkedAt: PENDING_PROBE_CHECKED_AT } };
}

/** Imported results are advisory only until their exact configuration matches. */
export function reconcilePersistedProviderVerification(provider: ProviderDraft): ProviderDraft {
  const signature = provider.probe.configurationSignature;
  if (signature === undefined || signature === providerVerificationIdentity(provider)) return provider;
  return { ...provider, status: 'draft', probe: { ...provider.probe, checkedAt: PENDING_PROBE_CHECKED_AT } };
}

/** The backend verifies this opaque receipt on save/load; a frontend signature alone is not evidence. */
export function hasCredentialBoundVerification(provider: ProviderDraft): boolean {
  return provider.probe.profileId.startsWith('credential-proof:')
    && provider.probe.configurationSignature === providerVerificationIdentity(provider)
    && provider.probe.checkedAt !== PENDING_PROBE_CHECKED_AT
    && provider.probe.verdict === 'available' && provider.status === 'ready';
}
