export type ProviderKind = 'openai-compatible' | 'dashscope' | 'openrouter' | 'ollama' | 'lmstudio' | 'nvidia';

export type ProviderTransport = 'http' | 'streaming-http' | 'websocket';

export type ProviderCapability = 'speech-to-text' | 'text-to-speech' | 'speech-to-speech' | 'text-generation';

export type ProviderInteractionCapability =
  | 'auto_vad'
  | 'manual_commit'
  | 'client_activity'
  | 'streaming'
  | 'chunked_http_audio'
  | 'push_to_talk'
  | 'server_commit_tts'
  | 'commit_tts'
  | 'text_only_backend'
  | 'pipeline_asr_mt_tts';

export type ProviderAuthRefKind = 'credential-ref' | 'env-ref';

export type ProviderAuthScheme = 'bearer' | 'api-key' | 'none';

export type ProviderAuthRef = {
  kind: ProviderAuthRefKind;
  reference: string;
  headerName: string;
  scheme: ProviderAuthScheme;
};

export type ProviderMetadataContract = {
  providerId: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl: string;
  transport: ProviderTransport;
  region?: string;
  model: string;
  capabilities: ProviderCapability[];
};

export type ProviderMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type ProviderInputPart =
  | {
      kind: 'text';
      text: string;
    }
  | {
      kind: 'audio-reference';
      audioRef: string;
      mimeType: 'audio/pcm' | 'audio/wav' | 'audio/mp3';
      sampleRateHz: number;
      channelCount: number;
    };

export type ProviderMessage = {
  role: ProviderMessageRole;
  parts: ProviderInputPart[];
};

export type ProviderRequestContract = {
  requestId: string;
  sessionId: string;
  model: string;
  transport: ProviderTransport;
  sourceLanguage: string;
  targetLanguage: string;
  stream: boolean;
  responseModalities: Array<'text' | 'audio'>;
  glossaryPackageIds: string[];
  promptTemplateId?: string;
  timeoutMs: number;
  maxOutputTokens?: number;
  temperature?: number;
  messages: ProviderMessage[];
};

export type ProviderStreamEvent =
  | {
      type: 'session.started';
      requestId: string;
      providerMessageId: string;
      createdAt: string;
    }
  | {
      type: 'translation.delta';
      requestId: string;
      segmentId: string;
      textDelta: string;
    }
  | {
      type: 'translation.completed';
      requestId: string;
      segmentId: string;
      text: string;
      finishReason: 'stop' | 'max-tokens' | 'provider-ended';
    }
  | {
      type: 'audio.delta';
      requestId: string;
      segmentId: string;
      audioChunkRef: string;
      mimeType: 'audio/pcm' | 'audio/mp3';
    }
  | {
      type: 'usage.updated';
      requestId: string;
      inputTokens?: number;
      outputTokens?: number;
      audioSeconds?: number;
    }
  | {
      type: 'response.completed';
      requestId: string;
      completedAt: string;
    };

export type ProviderErrorCode =
  | 'auth.invalid'
  | 'request.invalid'
  | 'rate-limited'
  | 'model.unsupported'
  | 'transport.unavailable'
  | 'response.unparseable'
  | 'timeout'
  | 'upstream.internal';

export type ProviderErrorContract = {
  code: ProviderErrorCode;
  message: string;
  retriable: boolean;
  httpStatus?: number;
  providerCode?: string;
  suggestion?: string;
};

export type ProviderFieldOwner = 'contract' | 'template' | 'probe';

export type ProviderFieldOwnershipRule = {
  fieldPath: string;
  owner: ProviderFieldOwner;
  note: string;
};

export const providerFieldOwnershipRules: ProviderFieldOwnershipRule[] = [
  {
    fieldPath: 'metadata.providerId',
    owner: 'contract',
    note: 'Provider 唯一标识由 Contract 冻结，模板和探测只能引用。',
  },
  {
    fieldPath: 'metadata.baseUrl',
    owner: 'contract',
    note: '请求入口地址属于 Contract 基础字段，后续模板不能重命名。',
  },
  {
    fieldPath: 'auth.reference',
    owner: 'contract',
    note: '认证字段采用引用方式，不允许模板直接写入明文密钥。',
  },
  {
    fieldPath: 'request.promptTemplateId',
    owner: 'template',
    note: '模板负责推荐提示模板与默认值，但不重定义基础请求字段。',
  },
  {
    fieldPath: 'metadata.region',
    owner: 'template',
    note: '区域与部署侧差异可由模板给默认值或可选值。',
  },
  {
    fieldPath: 'probe.streamSupport',
    owner: 'probe',
    note: '流式能力与实时适用性属于探测输出，不属于模板或 Contract 输入字段。',
  },
  {
    fieldPath: 'probe.errorShapeStable',
    owner: 'probe',
    note: '错误结构稳定性由探测系统写入，供前端提示和策略决策复用。',
  },
];
