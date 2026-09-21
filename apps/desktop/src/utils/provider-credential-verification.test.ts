import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { useAppStore } from '../stores/app-store';
import { beginCredentialVerificationChange, credentialVerificationPending, credentialVerificationRevision } from './provider-credential-verification';

describe('credential verification write lifecycle', () => {
  it('keeps overlapping writes pending until both settle without persisting concurrency tokens', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    useAppStore.setState({ configDraft });
    const reference = configDraft.providers[0].authRef.reference;
    const before = credentialVerificationRevision(reference);
    const finishFirst = beginCredentialVerificationChange(reference);
    const finishSecond = beginCredentialVerificationChange(reference);
    expect(credentialVerificationRevision(reference)).toBe(before + 2);
    finishFirst();
    expect(credentialVerificationPending(reference)).toBe(true);
    finishSecond();
    expect(credentialVerificationPending(reference)).toBe(false);
    expect(credentialVerificationRevision(reference)).toBe(before + 4);
    expect(useAppStore.getState().configDraft.providers[0]).toEqual({
      ...configDraft.providers[0], status: 'draft',
      probe: { ...configDraft.providers[0].probe, checkedAt: 'pending-probe', configurationSignature: undefined },
    });
  });
});

it('does not block verification for a credential reference never written in this session', () => {
  const reference = 'verification-test:no-writes';
  const before = useAppStore.getState().configDraft;
  expect(credentialVerificationRevision(reference)).toBe(0);
  expect(credentialVerificationPending(reference)).toBe(false);
  expect(useAppStore.getState().configDraft).toBe(before);
});
