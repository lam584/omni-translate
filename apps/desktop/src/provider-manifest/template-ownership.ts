import type { ProviderManifest } from './types';

/** Workspace is a connection variant of the Bailian template, not a new protocol owner. */
export function findProviderManifestByTemplateId(
  manifests: readonly ProviderManifest[],
  templateId: string,
): ProviderManifest | null {
  const direct = manifests.find((manifest) => manifest.provider.templateId === templateId);
  if (direct) return direct;
  if (templateId !== 'template-dashscope-workspace') return null;
  return manifests.find((manifest) => manifest.provider.templateId === 'template-dashscope-realtime'
    && manifest.provider.id === 'bailian') ?? null;
}
