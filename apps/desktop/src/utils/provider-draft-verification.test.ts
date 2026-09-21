import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import type { ProviderDraft } from '../schema/config';
import { hasCredentialBoundVerification, invalidateChangedProvider, providerVerificationIdentity, reconcilePersistedProviderVerification } from './provider-draft-verification';

function provider(): ProviderDraft {
  const result = structuredClone(appConfigDraftMock.providers[0]);
  result.modelProtocolBindings = [{ modelId: result.model, operation: 'native_translate',
    profileOwnerProviderId: 'bailian', manifestVersion: 1,
    profileId: 'bailian.livetranslate.realtime.ws', profileVersion: 1 }];
  result.probe.checkedAt = '2026-09-18T12:00:00Z';
  return result;
}

describe('provider verification is configuration scoped', () => {
  it.each([
    ['model', (p: ProviderDraft) => { p.model = 'custom-deployment'; }],
    ['protocol', (p: ProviderDraft) => { p.modelProtocolBindings![0].profileId = 'bailian.livetranslate.3_8.realtime.ws'; }],
    ['profile version', (p: ProviderDraft) => { p.modelProtocolBindings![0].profileVersion = 2; }],
    ['manifest version', (p: ProviderDraft) => { p.modelProtocolBindings![0].manifestVersion = 2; }],
    ['endpoint', (p: ProviderDraft) => { p.baseUrl = 'https://other.example.test'; }],
    ['region', (p: ProviderDraft) => { p.region = 'ap-southeast-1'; }],
    ['credentials reference', (p: ProviderDraft) => { p.authRef.reference = 'other-secret-reference'; }],
    ['transport', (p: ProviderDraft) => { p.transport = 'http'; }],
    ['instance identity', (p: ProviderDraft) => { p.providerId = 'other-instance'; }],
  ] as const)('invalidates results when %s changes', (_, change) => {
    const previous = provider();
    const next = structuredClone(previous);
    change(next);
    const invalidated = invalidateChangedProvider(previous, next);
    expect(invalidated.status).toBe('draft');
    expect(invalidated.probe.checkedAt).toBe('pending-probe');
    expect(previous.probe.checkedAt).toBe('2026-09-18T12:00:00Z');
    expect(invalidated.modelProtocolBindings).toEqual(next.modelProtocolBindings);
    expect(providerVerificationIdentity(previous)).not.toBe(providerVerificationIdentity(next));
  });

  it('accepting a result or refreshing discovery does not invalidate its own result', () => {
    const previous = provider();
    const next = structuredClone(previous);
    next.probe.checkedAt = '2026-09-20T12:00:00Z';
    next.status = 'draft';
    next.modelCatalogCache.models = [];
    next.modelCatalogCache.fetchedAt = '2026-09-20T12:00:00Z';
    expect(providerVerificationIdentity(next)).toBe(providerVerificationIdentity(previous));
    expect(invalidateChangedProvider(previous, next)).toBe(next);
    expect(next.probe.checkedAt).toBe('2026-09-20T12:00:00Z');
  });

  it('equivalent cloned configuration retains the result without mutating either draft', () => {
    const previous = provider();
    const next = structuredClone(previous);
    expect(invalidateChangedProvider(previous, next)).toBe(next);
    expect(next).toEqual(previous);
  });
});

describe('persisted validation fingerprint', () => {
  it('keeps legacy unsigned evidence without promoting it to custom-model evidence', () => {
    const draft = provider();
    expect(reconcilePersistedProviderVerification(draft)).toBe(draft);
    expect(draft.probe.configurationSignature).toBeUndefined();
  });
  it('keeps a matching signed result and rejects an imported changed model', () => {
    const draft = provider();
    draft.probe.configurationSignature = providerVerificationIdentity(draft);
    expect(reconcilePersistedProviderVerification(draft)).toBe(draft);
    const changed = structuredClone(draft);
    changed.model = 'different-model';
    const reconciled = reconcilePersistedProviderVerification(changed);
    expect(reconciled.status).toBe('draft');
    expect(reconciled.probe.checkedAt).toBe('pending-probe');
    expect(draft.probe.checkedAt).toBe('2026-09-18T12:00:00Z');
  });
});

it('survives equivalent persisted JSON object-key ordering, including nested configuration', () => {
  const original = { ...provider(), futureConfiguration: { nullable: null, enabled: true } };
  original.probe.configurationSignature = providerVerificationIdentity(original);
  const reordered = Object.fromEntries(Object.entries(original).reverse()) as typeof original;
  reordered.authRef = Object.fromEntries(Object.entries(original.authRef).reverse()) as typeof original.authRef;
  reordered.futureConfiguration = { enabled: true, nullable: null };
  expect(providerVerificationIdentity(reordered)).toBe(original.probe.configurationSignature);
  expect(reconcilePersistedProviderVerification(reordered)).toBe(reordered);
});

 it('requires backend credential evidence before presenting a custom model as verified', () => {
   const draft = provider();
   draft.status = 'ready';
   draft.probe.verdict = 'available';
   draft.probe.configurationSignature = providerVerificationIdentity(draft);
   expect(hasCredentialBoundVerification(draft)).toBe(false);
   draft.probe.profileId = 'credential-proof:test-receipt';
   expect(hasCredentialBoundVerification(draft)).toBe(true);
   draft.probe.checkedAt = 'pending-probe';
   expect(hasCredentialBoundVerification(draft)).toBe(false);
 });

it.each([
  ['configuration changed', (draft: ProviderDraft) => { draft.baseUrl = 'https://changed.invalid'; }],
  ['probe unavailable', (draft: ProviderDraft) => { draft.probe.verdict = 'unavailable'; }],
  ['provider not ready', (draft: ProviderDraft) => { draft.status = 'draft'; }],
] as const)('does not present a credential receipt as verified when %s', (_, change) => {
  const draft = provider();
  draft.status = 'ready';
  draft.probe.verdict = 'available';
  draft.probe.profileId = 'credential-proof:test-receipt';
  draft.probe.configurationSignature = providerVerificationIdentity(draft);
  expect(hasCredentialBoundVerification(draft)).toBe(true);
  change(draft);
  expect(hasCredentialBoundVerification(draft)).toBe(false);
});
