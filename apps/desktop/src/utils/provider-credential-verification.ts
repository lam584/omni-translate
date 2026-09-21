import { useAppStore } from '../stores/app-store';
import { PENDING_PROBE_CHECKED_AT } from '../schema/provider-probe';

// Session-local concurrency tokens only: never derived from credentials or persisted.
const writes = new Map<string, { revision: number; pending: number }>();
const listeners = new Set<() => void>();
export const subscribeCredentialVerification = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const credentialVerificationRevision = (reference: string) => writes.get(reference)?.revision ?? 0;
export const credentialVerificationPending = (reference: string) => (writes.get(reference)?.pending ?? 0) > 0;

export function beginCredentialVerificationChange(reference: string): () => void {
  const change = (delta: number) => {
    const previous = writes.get(reference) ?? { revision: 0, pending: 0 };
    writes.set(reference, { revision: previous.revision + 1, pending: previous.pending + delta });
    const state = useAppStore.getState();
    state.updateProviders(state.configDraft.providers.map((provider) => provider.authRef.reference !== reference ? provider : {
      ...provider,
      status: 'draft',
      probe: { ...provider.probe, checkedAt: PENDING_PROBE_CHECKED_AT, configurationSignature: undefined },
    }));
    for (const listener of listeners) listener();
  };
  change(1);
  return () => { change(-1); };
}
