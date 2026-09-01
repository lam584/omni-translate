import i18n from '../i18n/config';
import {
  customProviderBinding,
  customProviderProfileOptionForLegacyProtocol,
  customProviderProfileKeyFromBinding,
  resolveCustomProviderProtocolProfileOption,
} from '../provider-manifest/custom-profile-options';
import type { ProviderAuthScheme, ProviderKind, ProviderTransport } from '../schema/provider-contract';
import type { ProviderTemplate } from '../schema/provider-template';

const CUSTOM_PROVIDER_TEMPLATES_STORAGE_KEY = 'omni.customProviderTemplates';

export type CustomProviderTemplateDraft = {
  displayName: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  transport: ProviderTransport;
  authReference: string;
  authHeaderName: string;
  authScheme: ProviderAuthScheme;
  region: string;
  streamEnabled: boolean;
  timeoutMs: number;
  systemPromptTemplate: string;
  /** Exact versioned profile selected by the user; never inferred. */
  protocolProfileKey: string;
};

function resolveCustomProviderAuthReference(displayName: string, currentReference: string) {
  const normalizedReference = currentReference.trim();

  if (normalizedReference && normalizedReference !== 'credential://provider/custom/default') {
    return normalizedReference;
  }

  return `credential://provider/custom/${makeSlug(displayName)}`;
}

function makeProtocolLabel(transport: ProviderTransport) {
  if (transport === 'websocket') {
    return i18n.t('customProvider.protocolWebsocket');
  }

  if (transport === 'streaming-http') {
    return i18n.t('customProvider.protocolStreamingHttp');
  }

  return i18n.t('customProvider.protocolHttp');
}

function storageAvailable() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function makeSlug(value: string) {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'custom-provider';
}

function makeVersionStamp() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}.${month}.${day}`;
}

function makeFieldGroups(kind: ProviderKind): ProviderTemplate['fieldGroups'] {
  const groups: ProviderTemplate['fieldGroups'] = [
    {
      id: `${kind}-custom-required`,
      label: i18n.t('customProvider.groupRequired'),
      description: i18n.t('customProvider.groupRequiredDesc'),
      tier: 'required',
      fields: [
        {
          id: `${kind}-custom-model`,
          key: 'model',
          label: i18n.t('customProvider.fieldModel'),
          description: i18n.t('customProvider.fieldModelDesc'),
        },
        {
          id: `${kind}-custom-base-url`,
          key: 'baseUrl',
          label: i18n.t('customProvider.fieldBaseUrl'),
          description: i18n.t('customProvider.fieldBaseUrlDesc'),
        },
        {
          id: `${kind}-custom-auth-reference`,
          key: 'authRef.reference',
          label: i18n.t('customProvider.fieldAuthRef'),
          description: i18n.t('customProvider.fieldAuthRefDesc'),
        },
      ],
    },
    {
      id: `${kind}-custom-routing`,
      label: i18n.t('customProvider.groupRouting'),
      description: i18n.t('customProvider.groupRoutingDesc'),
      tier: 'recommended',
      fields: [
        {
          id: `${kind}-custom-transport`,
          key: 'transport',
          label: i18n.t('customProvider.fieldTransport'),
          description: i18n.t('customProvider.fieldTransportDesc'),
        },
        {
          id: `${kind}-custom-timeout`,
          key: 'timeoutMs',
          label: i18n.t('customProvider.fieldTimeout'),
          description: i18n.t('customProvider.fieldTimeoutDesc'),
        },
      ],
    },
  ];

  if (kind === 'dashscope') {
    groups[1]?.fields.splice(1, 0, {
      id: `${kind}-custom-region`,
      key: 'region',
      label: i18n.t('customProvider.fieldRegion'),
      description: i18n.t('customProvider.fieldRegionDesc'),
    });
  }

  groups.push({
    id: `${kind}-custom-advanced`,
    label: i18n.t('customProvider.groupAdvanced'),
    description: i18n.t('customProvider.groupAdvancedDesc'),
    tier: 'advanced',
    fields: [
      {
        id: `${kind}-custom-prompt-template`,
        key: 'systemPromptTemplate',
        label: i18n.t('customProvider.fieldPromptTemplate'),
        description: i18n.t('customProvider.fieldPromptTemplateDesc'),
      },
      {
        id: `${kind}-custom-stream`,
        key: 'streamEnabled',
        label: i18n.t('customProvider.fieldStream'),
        description: i18n.t('customProvider.fieldStreamDesc'),
      },
    ],
  });

  return groups;
}

// Shared body for create/update: everything a custom template derives from its
// draft, minus the identity fields (`id`/`source`) and `presetModels`.
function makeCustomProviderTemplatePatch(
  draft: CustomProviderTemplateDraft,
  providerId: string,
): Omit<ProviderTemplate, 'id' | 'source' | 'presetModels'> {
  const authReference = resolveCustomProviderAuthReference(draft.displayName, draft.authReference);
  const protocol = resolveCustomProviderProtocolProfileOption(draft.kind, draft.protocolProfileKey);
  const binding = customProviderBinding(draft.kind, draft.protocolProfileKey, draft.model);
  if (!protocol || !binding) {
    throw new Error('custom_provider.protocol_profile_required');
  }

  return {
    version: makeVersionStamp(),
    displayName: draft.displayName.trim(),
    description: i18n.t('customProvider.description', { platform: draft.kind === 'dashscope' ? 'DashScope' : 'OpenAI Compatible' }),
    protocolLabel: makeProtocolLabel(protocol.transport),
    notes: i18n.t('customProvider.notes'),
    supportedTransports: [protocol.transport],
    defaultDraft: {
      providerId,
      kind: draft.kind,
      displayName: draft.displayName.trim(),
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
      transport: protocol.transport,
      auth: {
        headerName: protocol.authHeaderName,
        reference: authReference,
        scheme: protocol.authScheme,
      },
      region: draft.region.trim() || undefined,
      streamEnabled: draft.streamEnabled,
      timeoutMs: draft.timeoutMs,
      systemPromptTemplate: draft.systemPromptTemplate.trim(),
      modelProtocolBindings: [binding],
    },
    fieldGroups: makeFieldGroups(draft.kind),
    contractMappings: [
      {
        templateFieldKey: 'model',
        contractFieldPath: 'request.model',
        note: i18n.t('customProvider.mappingModel'),
      },
      {
        templateFieldKey: 'baseUrl',
        contractFieldPath: 'metadata.baseUrl',
        note: i18n.t('customProvider.mappingBaseUrl'),
      },
      {
        templateFieldKey: 'authRef.reference',
        contractFieldPath: 'auth.reference',
        note: i18n.t('customProvider.mappingAuth'),
      },
      {
        templateFieldKey: 'transport',
        contractFieldPath: 'request.transport',
        note: i18n.t('customProvider.mappingTransport'),
      },
    ],
  };
}

export function createCustomProviderTemplate(draft: CustomProviderTemplateDraft): ProviderTemplate {
  const slug = makeSlug(draft.displayName);

  return {
    id: `template-custom-${slug}-${Date.now()}`,
    source: 'custom',
    ...makeCustomProviderTemplatePatch(draft, `provider-custom-${slug}`),
    presetModels: [],
  };
}

export function customProviderTemplateToDraft(template: ProviderTemplate): CustomProviderTemplateDraft {
  return {
    displayName: template.displayName,
    kind: template.defaultDraft.kind,
    baseUrl: template.defaultDraft.baseUrl,
    model: template.defaultDraft.model,
    transport: template.defaultDraft.transport,
    authReference: template.defaultDraft.auth.reference,
    authHeaderName: template.defaultDraft.auth.headerName,
    authScheme: template.defaultDraft.auth.scheme,
    region: template.defaultDraft.region ?? '',
    streamEnabled: template.defaultDraft.streamEnabled,
    timeoutMs: template.defaultDraft.timeoutMs,
    systemPromptTemplate: template.defaultDraft.systemPromptTemplate,
    protocolProfileKey: customProviderProfileKeyFromBinding(template.defaultDraft.modelProtocolBindings?.[0]),
  };
}

export function updateCustomProviderTemplate(template: ProviderTemplate, draft: CustomProviderTemplateDraft): ProviderTemplate {
  const slug = makeSlug(draft.displayName);

  return {
    ...template,
    ...makeCustomProviderTemplatePatch(draft, template.defaultDraft.providerId || `provider-custom-${slug}`),
  };
}

export function readCustomProviderTemplatesResult(): { templates: ProviderTemplate[]; error: string | null } {
  if (!storageAvailable()) {
    return { templates: [], error: null };
  }

  try {
    const raw = window.localStorage.getItem(CUSTOM_PROVIDER_TEMPLATES_STORAGE_KEY);
    if (!raw) {
      return { templates: [], error: null };
    }

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { templates: [], error: 'Stored custom provider data is not an array' };
    }
    const templates: ProviderTemplate[] = [];
    let migratedCount = 0;
    let unresolvedCount = 0;
    for (const value of parsed) {
      if (isValidStoredCustomProviderTemplate(value)) {
        templates.push(value);
        continue;
      }
      const migrated = migrateLegacyStoredCustomProviderTemplate(value);
      if (migrated && isValidStoredCustomProviderTemplate(migrated)) {
        templates.push(migrated);
        migratedCount += 1;
        continue;
      }
      if (isPreservableLegacyCustomProviderTemplate(value)) {
        // Preserve the user's configuration for repair in the UI. With no
        // exact binding it remains fail-closed at runtime.
        templates.push(value);
        unresolvedCount += 1;
      } else {
        unresolvedCount += 1;
      }
    }
    if (migratedCount > 0 && unresolvedCount === 0) {
      window.localStorage.setItem(CUSTOM_PROVIDER_TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
    }
    const details = [
      migratedCount > 0 ? `${migratedCount} legacy template(s) migrated` : null,
      unresolvedCount > 0 ? `${unresolvedCount} template(s) require an explicit Protocol Profile` : null,
    ].filter(Boolean).join('; ');
    return { templates, error: details || null };
  } catch (error) {
    return { templates: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function isPreservableLegacyCustomProviderTemplate(value: unknown): value is ProviderTemplate {
  if (!value || typeof value !== 'object') return false;
  const template = value as Partial<ProviderTemplate>;
  const draft = template.defaultDraft as Partial<ProviderTemplate['defaultDraft']> | undefined;
  return template.source === 'custom'
    && typeof template.id === 'string'
    && template.id.startsWith('template-custom-')
    && template.manifestProviderId === undefined
    && Boolean(draft)
    && draft?.manifestProviderId === undefined
    && typeof draft?.providerId === 'string'
    && typeof draft?.kind === 'string'
    && typeof draft?.model === 'string'
    && typeof draft?.baseUrl === 'string'
    && typeof draft?.auth === 'object';
}

function migrateLegacyStoredCustomProviderTemplate(value: unknown): ProviderTemplate | null {
  if (!isPreservableLegacyCustomProviderTemplate(value)) return null;
  const legacyProtocolId = value.realtimeProtocol;
  if (!legacyProtocolId) return null;
  const option = customProviderProfileOptionForLegacyProtocol(value.defaultDraft.kind, legacyProtocolId);
  const binding = option
    ? customProviderBinding(value.defaultDraft.kind, option.key, value.defaultDraft.model)
    : null;
  if (!option || !binding) return null;
  return {
    ...value,
    protocolLabel: makeProtocolLabel(option.transport),
    supportedTransports: [option.transport],
    defaultDraft: {
      ...value.defaultDraft,
      transport: option.transport,
      auth: {
        ...value.defaultDraft.auth,
        headerName: option.authHeaderName,
        scheme: option.authScheme,
      },
      modelProtocolBindings: [binding],
    },
  };
}

export function readCustomProviderTemplates(): ProviderTemplate[] {
  return readCustomProviderTemplatesResult().templates;
}

export function writeCustomProviderTemplates(templates: ProviderTemplate[]) {
  if (!storageAvailable()) {
    return { ok: false as const, error: 'Browser storage is unavailable' };
  }

  try {
    if (!templates.every(isValidStoredCustomProviderTemplate)) {
      return { ok: false as const, error: 'Custom provider template protocol profile is invalid or unauthorized' };
    }
    window.localStorage.setItem(CUSTOM_PROVIDER_TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
    return { ok: true as const, error: null };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

function isValidStoredCustomProviderTemplate(value: unknown): value is ProviderTemplate {
  if (!value || typeof value !== 'object') return false;
  const template = value as Partial<ProviderTemplate>;
  if (
    template.source !== 'custom'
    || typeof template.id !== 'string'
    || !template.id.startsWith('template-custom-')
    || template.manifestProviderId !== undefined
    || !template.defaultDraft
    || template.defaultDraft.manifestProviderId !== undefined
  ) return false;
  const bindings = template.defaultDraft.modelProtocolBindings;
  if (!Array.isArray(bindings) || bindings.length !== 1) return false;
  const binding = bindings[0];
  if (!binding || binding.modelId !== template.defaultDraft.model) return false;
  const key = customProviderProfileKeyFromBinding(binding);
  const option = resolveCustomProviderProtocolProfileOption(template.defaultDraft.kind, key);
  return Boolean(
    option
    && option.transport === template.defaultDraft.transport
    && option.authProfileId === binding.authProfileId
    && option.authHeaderName.toLowerCase() === template.defaultDraft.auth.headerName.toLowerCase()
    && option.authScheme === template.defaultDraft.auth.scheme
  );
}
