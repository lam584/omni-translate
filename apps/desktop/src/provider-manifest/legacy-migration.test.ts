import { describe, expect, it } from 'vitest';

import type { ProviderDraft } from '../schema/config';
import { hydrateLegacyProviderManifestAuthority } from './legacy-migration';

function legacyVolcDraft(model: string): ProviderDraft {
  return {
    templateId: 'template-volcengine-doubao',
    model,
  } as ProviderDraft;
}

describe('legacy provider manifest hydration', () => {
  it('canonicalizes one unique built-in alias only at migration time', () => {
    const hydrated = hydrateLegacyProviderManifestAuthority(
      legacyVolcDraft('doubao-seed-2-0-lite-260215'),
    );
    expect(hydrated.model).toBe('doubao-seed-2-0-lite-260428');
    expect(hydrated.manifestProviderId).toBe('volcengine-doubao');
    expect(hydrated.modelProtocolBindings?.length).toBeGreaterThan(0);
  });

  it('does not guess when a legacy alias maps to multiple exact models', () => {
    const hydrated = hydrateLegacyProviderManifestAuthority(legacyVolcDraft('bigmodel'));
    expect(hydrated.model).toBe('bigmodel');
  });
});
