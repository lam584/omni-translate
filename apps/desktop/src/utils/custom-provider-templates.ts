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
    return '自定义长连接';
  }

  if (transport === 'streaming-http') {
    return '自定义流式HTTP';
  }

  return '自定义HTTP';
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
      label: '基础连接字段',
      description: '自定义平台至少需要确认这些字段。',
      tier: 'required',
      fields: [
        {
          id: `${kind}-custom-model`,
          key: 'model',
          label: '模型名',
          description: '默认调用的模型。',
        },
        {
          id: `${kind}-custom-base-url`,
          key: 'baseUrl',
          label: '接口地址',
          description: '用于能力检测、模型目录和请求入口。',
        },
        {
          id: `${kind}-custom-auth-reference`,
          key: 'authRef.reference',
          label: '认证引用',
          description: '用于写入系统凭据管理器。',
        },
      ],
    },
    {
      id: `${kind}-custom-routing`,
      label: '请求行为',
      description: '决定请求协议与超时行为。',
      tier: 'recommended',
      fields: [
        {
          id: `${kind}-custom-transport`,
          key: 'transport',
          label: '传输方式',
          description: '按上游能力选择 HTTP、流式或长连接。',
        },
        {
          id: `${kind}-custom-timeout`,
          key: 'timeoutMs',
          label: '超时阈值',
          description: '用于模型探测、模型目录和烟雾测试。',
        },
      ],
    },
  ];

  if (kind === 'dashscope') {
    groups[1]?.fields.splice(1, 0, {
      id: `${kind}-custom-region`,
      key: 'region',
      label: '区域',
      description: '当服务区分地域时用于记录默认区域。',
    });
  }

  groups.push({
    id: `${kind}-custom-advanced`,
    label: '高级字段',
    description: '按需控制系统提示模板和流式能力。',
    tier: 'advanced',
    fields: [
      {
        id: `${kind}-custom-prompt-template`,
        key: 'systemPromptTemplate',
        label: '系统提示模板',
        description: '沿用当前 Provider Draft 的提示模板结构。',
      },
      {
        id: `${kind}-custom-stream`,
        key: 'streamEnabled',
        label: '流式开关',
        description: '允许 UI 在模板模式里直接控制是否启用实时返回。',
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
    description: `自定义 ${draft.kind === 'dashscope' ? 'DashScope' : 'OpenAI Compatible'} 平台接入。`,
    protocolLabel: makeProtocolLabel(draft.transport),
    notes: '该模板由本地页面创建并保存在浏览器存储中，可继续使用系统凭据管理器保存 API Key。',
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
        note: '自定义模板把默认模型名映射到请求层。',
      },
      {
        templateFieldKey: 'baseUrl',
        contractFieldPath: 'metadata.baseUrl',
        note: '自定义模板保留独立入口地址。',
      },
      {
        templateFieldKey: 'authRef.reference',
        contractFieldPath: 'auth.reference',
        note: '认证信息继续通过引用方式注入。',
      },
      {
        templateFieldKey: 'transport',
        contractFieldPath: 'request.transport',
        note: '传输方式由自定义模板提供默认值。',
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
    description: `自定义 ${draft.kind === 'dashscope' ? 'DashScope' : 'OpenAI Compatible'} 平台接入。`,
    protocolLabel: makeProtocolLabel(draft.transport),
    notes: '该模板由本地页面创建并保存在浏览器存储中，可继续使用系统凭据管理器保存 API Key。',
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
        note: '自定义模板把默认模型名映射到请求层。',
      },
      {
        templateFieldKey: 'baseUrl',
        contractFieldPath: 'metadata.baseUrl',
        note: '自定义模板保留独立入口地址。',
      },
      {
        templateFieldKey: 'authRef.reference',
        contractFieldPath: 'auth.reference',
        note: '认证信息继续通过引用方式注入。',
      },
      {
        templateFieldKey: 'transport',
        contractFieldPath: 'request.transport',
        note: '传输方式由自定义模板提供默认值。',
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
