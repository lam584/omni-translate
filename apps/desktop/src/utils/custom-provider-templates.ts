import i18n from '../i18n/config';
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

function supportedTransportsForKind(kind: ProviderKind): ProviderTransport[] {
  return kind === 'dashscope' ? ['http', 'websocket'] : ['http', 'streaming-http'];
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

export function createCustomProviderTemplate(draft: CustomProviderTemplateDraft): ProviderTemplate {
  const slug = makeSlug(draft.displayName);
  const templateId = `template-custom-${slug}-${Date.now()}`;
  const version = makeVersionStamp();
  const authReference = resolveCustomProviderAuthReference(draft.displayName, draft.authReference);

  return {
    id: templateId,
    source: 'custom',
    version,
    displayName: draft.displayName.trim(),
    description: i18n.t('customProvider.description', { platform: draft.kind === 'dashscope' ? 'DashScope' : 'OpenAI Compatible' }),
    protocolLabel: makeProtocolLabel(draft.transport),
    notes: i18n.t('customProvider.notes'),
    supportedTransports: supportedTransportsForKind(draft.kind),
    defaultDraft: {
      providerId: `provider-custom-${slug}`,
      kind: draft.kind,
      displayName: draft.displayName.trim(),
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
      transport: draft.transport,
      auth: {
        headerName: draft.authHeaderName.trim(),
        reference: authReference,
        scheme: draft.authScheme,
      },
      region: draft.region.trim() || undefined,
      streamEnabled: draft.streamEnabled,
      timeoutMs: draft.timeoutMs,
      systemPromptTemplate: draft.systemPromptTemplate.trim(),
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
  };
}

export function updateCustomProviderTemplate(template: ProviderTemplate, draft: CustomProviderTemplateDraft): ProviderTemplate {
  const slug = makeSlug(draft.displayName);
  const authReference = resolveCustomProviderAuthReference(draft.displayName, draft.authReference);

  return {
    ...template,
    version: makeVersionStamp(),
    displayName: draft.displayName.trim(),
    description: i18n.t('customProvider.description', { platform: draft.kind === 'dashscope' ? 'DashScope' : 'OpenAI Compatible' }),
    protocolLabel: makeProtocolLabel(draft.transport),
    notes: i18n.t('customProvider.notes'),
    supportedTransports: supportedTransportsForKind(draft.kind),
    defaultDraft: {
      providerId: template.defaultDraft.providerId || `provider-custom-${slug}`,
      kind: draft.kind,
      displayName: draft.displayName.trim(),
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
      transport: draft.transport,
      auth: {
        headerName: draft.authHeaderName.trim(),
        reference: authReference,
        scheme: draft.authScheme,
      },
      region: draft.region.trim() || undefined,
      streamEnabled: draft.streamEnabled,
      timeoutMs: draft.timeoutMs,
      systemPromptTemplate: draft.systemPromptTemplate.trim(),
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

export function readCustomProviderTemplates(): ProviderTemplate[] {
  if (!storageAvailable()) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(CUSTOM_PROVIDER_TEMPLATES_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProviderTemplate[]) : [];
  } catch {
    return [];
  }
}

export function writeCustomProviderTemplates(templates: ProviderTemplate[]) {
  if (!storageAvailable()) {
    return;
  }

  window.localStorage.setItem(CUSTOM_PROVIDER_TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
}
