import type { ModelPreset, ProviderTemplate } from '../schema/provider-template';

type OpenAICompatibleTemplateInput = {
  id: string;
  source: ProviderTemplate['source'];
  displayName: string;
  description: string;
  notes: string;
  providerId: string;
  model: string;
  baseUrl: string;
  credentialRef: string;
  authHeaderName?: string;
  authScheme?: ProviderTemplate['defaultDraft']['auth']['scheme'];
  presetModels: ModelPreset[];
};

function makeOpenAICompatibleTemplate(input: OpenAICompatibleTemplateInput): ProviderTemplate {
  const slug = input.id.replace(/^template-/, '');
  const authHeaderName = input.authHeaderName ?? 'Authorization';
  const authScheme = input.authScheme ?? 'bearer';

  return {
    id: input.id,
    source: input.source,
    version: '2026.05.28',
    displayName: input.displayName,
    description: input.description,
    protocolLabel: 'OpenAI Compatible / Streaming HTTP',
    notes: input.notes,
    supportedTransports: ['http', 'streaming-http'],
    defaultDraft: {
      providerId: input.providerId,
      kind: 'openai-compatible',
      displayName: input.displayName,
      model: input.model,
      baseUrl: input.baseUrl,
      transport: 'streaming-http',
      auth: {
        headerName: authHeaderName,
        reference: input.credentialRef,
        scheme: authScheme,
      },
      streamEnabled: true,
      timeoutMs: 15000,
      systemPromptTemplate: 'video-realtime-cn',
    },
    fieldGroups: [
      {
        id: `${slug}-required-connection`,
        label: 'Connection',
        description: 'Required fields for this provider.',
        tier: 'required',
        fields: [
          {
            id: `${slug}-model`,
            key: 'model',
            label: 'Model',
            description: 'Model id sent to the provider.',
          },
          {
            id: `${slug}-base-url`,
            key: 'baseUrl',
            label: 'Base URL',
            description: 'OpenAI-compatible API base URL.',
          },
          {
            id: `${slug}-auth-reference`,
            key: 'authRef.reference',
            label: 'Credential reference',
            description: 'Saved credential slot used by this provider.',
          },
        ],
      },
      {
        id: `${slug}-recommended-routing`,
        label: 'Routing',
        description: 'Recommended request defaults.',
        tier: 'recommended',
        fields: [
          {
            id: `${slug}-transport`,
            key: 'transport',
            label: 'Transport',
            description: 'Streaming HTTP is the default for compatible chat APIs.',
          },
          {
            id: `${slug}-timeout`,
            key: 'timeoutMs',
            label: 'Timeout',
            description: 'Provider request timeout.',
          },
        ],
      },
      {
        id: `${slug}-advanced-prompts`,
        label: 'Prompts',
        description: 'Advanced prompt and streaming options.',
        tier: 'advanced',
        fields: [
          {
            id: `${slug}-prompt-template`,
            key: 'systemPromptTemplate',
            label: 'System prompt template',
            description: 'Prompt template used by scenes.',
          },
          {
            id: `${slug}-stream-enabled`,
            key: 'streamEnabled',
            label: 'Streaming',
            description: 'Controls whether streaming responses are requested.',
          },
        ],
      },
    ],
    contractMappings: [
      {
        templateFieldKey: 'model',
        contractFieldPath: 'request.model',
        note: 'Template default maps directly to the provider request model.',
      },
      {
        templateFieldKey: 'baseUrl',
        contractFieldPath: 'metadata.baseUrl',
        note: 'Template provides a default OpenAI-compatible endpoint.',
      },
      {
        templateFieldKey: 'authRef.reference',
        contractFieldPath: 'auth.reference',
        note: 'Credentials are injected by reference.',
      },
      {
        templateFieldKey: 'transport',
        contractFieldPath: 'request.transport',
        note: 'Template recommends the transport but keeps the contract enum unchanged.',
      },
    ],
    presetModels: input.presetModels,
  };
}

export const providerTemplates: ProviderTemplate[] = [
  {
    id: 'template-openai-compatible-realtime',
    source: 'official',
    version: '2026.05.10',
    displayName: 'OpenAI API',
    description: 'OpenAI 官方 API，支持翻译与实时翻译。',
    protocolLabel: '流式HTTP / 实时返回',
    notes: '支持 GPT-4o、GPT-4.1 等模型，只需填入 API Key 即可使用。',
    supportedTransports: ['http', 'streaming-http'],
    defaultDraft: {
      providerId: 'provider-openai',
      kind: 'openai-compatible',
      displayName: 'OpenAI API',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      transport: 'streaming-http',
      auth: {
        headerName: 'Authorization',
        reference: 'credential://provider/openai/default',
        scheme: 'bearer',
      },
      streamEnabled: true,
      timeoutMs: 15000,
      systemPromptTemplate: 'video-realtime-cn',
    },
    fieldGroups: [
      {
        id: 'openai-required-connection',
        label: '必填连接字段',
        description: '先填这几项。',
        tier: 'required',
        fields: [
          {
            id: 'openai-model',
            key: 'model',
            label: '模型名',
            description: '要调用的模型。',
          },
          {
            id: 'openai-base-url',
            key: 'baseUrl',
            label: '接口地址',
            description: '服务入口。',
          },
          {
            id: 'openai-auth-reference',
            key: 'authRef.reference',
            label: '认证引用',
            description: '只显示保存位置，不直接展示密钥。',
          },
        ],
      },
      {
        id: 'openai-recommended-routing',
        label: '推荐请求字段',
        description: '常用默认项。',
        tier: 'recommended',
        fields: [
          {
            id: 'openai-transport',
            key: 'transport',
            label: '传输模式',
            description: '默认使用实时返回。',
          },
          {
            id: 'openai-timeout',
            key: 'timeoutMs',
            label: '超时阈值',
            description: '请求超时上限。',
          },
        ],
      },
      {
        id: 'openai-advanced-prompts',
        label: '高级模式字段',
        description: '按需调整。',
        tier: 'advanced',
        fields: [
          {
            id: 'openai-prompt-template',
            key: 'systemPromptTemplate',
            label: '系统提示模板',
            description: '按场景切换提示词。',
          },
          {
            id: 'openai-stream-enabled',
            key: 'streamEnabled',
            label: '流式开关',
            description: '手动控制是否开启实时返回。',
          },
        ],
      },
    ],
    contractMappings: [
      {
        templateFieldKey: 'model',
        contractFieldPath: 'request.model',
        note: '模板默认模型直接映射到 Contract 请求字段。',
      },
      {
        templateFieldKey: 'baseUrl',
        contractFieldPath: 'metadata.baseUrl',
        note: '模板不能重命名入口字段，只能给默认值。',
      },
      {
        templateFieldKey: 'authRef.reference',
        contractFieldPath: 'auth.reference',
        note: '认证信息以引用方式注入 Contract。',
      },
      {
        templateFieldKey: 'transport',
        contractFieldPath: 'request.transport',
        note: '模板只推荐请求模式，不改变 Contract 枚举。',
      },
    ],
    presetModels: [
      {
        id: 'openai-gpt-realtime-translate',
        model: 'gpt-realtime-translate',
        displayName: 'GPT Realtime Translate',
        capabilities: ['speech-to-text', 'speech-to-speech'],
        description: '专用实时语音翻译（源语+译文双字幕），看片模式推荐。',
      },
      {
        id: 'openai-gpt-realtime-2.1',
        model: 'gpt-realtime-2.1',
        displayName: 'GPT Realtime 2.1',
        capabilities: ['speech-to-text', 'speech-to-speech'],
        description: 'OpenAI 旗舰实时语音模型，低延迟语音理解与输出。',
      },
      {
        id: 'openai-gpt-realtime-2.1-mini',
        model: 'gpt-realtime-2.1-mini',
        displayName: 'GPT Realtime 2.1 Mini',
        capabilities: ['speech-to-text', 'speech-to-speech'],
        description: '轻量实时语音模型，延迟更低，成本更省。',
      },
      {
        id: 'openai-gpt-realtime-whisper',
        model: 'gpt-realtime-whisper',
        displayName: 'GPT Realtime Whisper',
        capabilities: ['speech-to-text'],
        description: '实时流式转写，配合二次翻译模式使用。',
      },
      {
        id: 'openai-gpt-4o-mini-transcribe',
        model: 'gpt-4o-mini-transcribe',
        displayName: 'GPT-4o Mini Transcribe',
        capabilities: ['speech-to-text'],
        description: '轻量实时转写模型，适合低成本转写场景。',
      },
      {
        id: 'openai-gpt-4o',
        model: 'gpt-4o',
        displayName: 'GPT-4o',
        capabilities: ['text-generation'],
        description: '多模态旗舰模型，翻译质量最高，支持实时流式。',
      },
      {
        id: 'openai-gpt-4.1',
        model: 'gpt-4.1',
        displayName: 'GPT-4.1',
        capabilities: ['text-generation'],
        description: '最新高性能模型，翻译精准，适合离线批量翻译。',
      },
      {
        id: 'openai-gpt-4o-mini',
        model: 'gpt-4o-mini',
        displayName: 'GPT-4o Mini',
        capabilities: ['text-generation'],
        description: '轻量快速模型，翻译延迟低，适合实时场景。',
      },
      {
        id: 'openai-gpt-4-turbo',
        model: 'gpt-4-turbo',
        displayName: 'GPT-4 Turbo',
        capabilities: ['text-generation'],
        description: '高性能模型，支持长上下文翻译。',
      },
    ],
  },
  {
    id: 'template-dashscope-realtime',
    source: 'official',
    version: '2026.05.10',
    displayName: '阿里云百炼 API',
    description: '阿里云百炼官方 API，支持翻译、实时翻译与语音合成。',
    protocolLabel: 'HTTP / 实时长连接',
    notes: '支持 Qwen-Omni、Qwen-Plus 等模型，只需填入 API Key 即可使用。',
    supportedTransports: ['http', 'websocket'],
    defaultDraft: {
      providerId: 'provider-dashscope',
      kind: 'dashscope',
      displayName: '阿里云百炼 API',
      model: 'qwen3.5-omni-plus-realtime',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      transport: 'websocket',
      auth: {
        headerName: 'Authorization',
        reference: 'credential://provider/dashscope/default',
        scheme: 'bearer',
      },
      region: 'cn-beijing',
      streamEnabled: true,
      timeoutMs: 12000,
      systemPromptTemplate: 'game-live-translation-cn',
    },
    fieldGroups: [
      {
        id: 'dashscope-required-connection',
        label: '必填连接字段',
        description: '先填这几项。',
        tier: 'required',
        fields: [
          {
            id: 'dashscope-model',
            key: 'model',
            label: '模型名',
            description: '要调用的模型。',
          },
          {
            id: 'dashscope-base-url',
            key: 'baseUrl',
            label: '接口地址',
            description: '服务入口。',
          },
          {
            id: 'dashscope-auth-reference',
            key: 'authRef.reference',
            label: '认证引用',
            description: '只显示保存位置，不直接展示密钥。',
          },
        ],
      },
      {
        id: 'dashscope-recommended-routing',
        label: '推荐请求字段',
        description: '常用默认项。',
        tier: 'recommended',
        fields: [
          {
            id: 'dashscope-transport',
            key: 'transport',
            label: '传输模式',
            description: '默认使用长连接。',
          },
          {
            id: 'dashscope-region',
            key: 'region',
            label: '地域字段',
            description: '服务所在地域。',
          },
          {
            id: 'dashscope-timeout',
            key: 'timeoutMs',
            label: '超时阈值',
            description: '请求超时上限。',
          },
        ],
      },
      {
        id: 'dashscope-advanced-prompts',
        label: '高级模式字段',
        description: '按需调整。',
        tier: 'advanced',
        fields: [
          {
            id: 'dashscope-prompt-template',
            key: 'systemPromptTemplate',
            label: '系统提示模板',
            description: '按场景切换提示词。',
          },
          {
            id: 'dashscope-stream-enabled',
            key: 'streamEnabled',
            label: '流式开关',
            description: '手动控制是否开启实时返回。',
          },
        ],
      },
    ],
    contractMappings: [
      {
        templateFieldKey: 'model',
        contractFieldPath: 'request.model',
        note: '模板默认模型直接投影到请求层。',
      },
      {
        templateFieldKey: 'baseUrl',
        contractFieldPath: 'metadata.baseUrl',
        note: '阿里云百炼入口差异通过模板默认值表达。',
      },
      {
        templateFieldKey: 'region',
        contractFieldPath: 'metadata.region',
        note: '区域是模板层推荐值，不改变 Contract 主字段。',
      },
      {
        templateFieldKey: 'transport',
        contractFieldPath: 'request.transport',
        note: '模板可推荐 WebSocket，但仍受 Contract 枚举约束。',
      },
    ],
    presetModels: [
      {
        id: 'dashscope-qwen-omni-plus',
        model: 'qwen3.5-omni-plus-realtime',
        displayName: 'Qwen3.5-Omni-Plus-Realtime',
        capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'],
        description: '旗舰实时多模态模型，支持翻译+实时语音+语音合成。',
      },
      {
        id: 'dashscope-qwen-plus',
        model: 'qwen-plus',
        displayName: 'Qwen-Plus',
        capabilities: ['speech-to-text'],
        description: '高性能通用模型，翻译质量好，适合批量翻译。',
      },
      {
        id: 'dashscope-qwen-max',
        model: 'qwen-max',
        displayName: 'Qwen-Max',
        capabilities: ['speech-to-text'],
        description: '最强文本模型，翻译精度极高。',
      },
      {
        id: 'dashscope-qwen-turbo',
        model: 'qwen-turbo',
        displayName: 'Qwen-Turbo',
        capabilities: ['speech-to-text'],
        description: '快速经济模型，延迟低，适合高并发场景。',
      },
    ],
  },
  makeOpenAICompatibleTemplate({
    id: 'template-openrouter',
    source: 'community',
    displayName: 'OpenRouter',
    description: 'OpenRouter unified model gateway with OpenAI-compatible chat completions.',
    notes: 'Use an OpenRouter API key. Optional HTTP-Referer and X-Title headers can be added in custom headers.',
    providerId: 'provider-openrouter',
    model: 'openai/gpt-4o-mini',
    baseUrl: 'https://openrouter.ai/api/v1',
    credentialRef: 'credential://provider/openrouter/default',
    presetModels: [
      {
        id: 'openrouter-gpt-5.4-mini',
        model: 'openai/gpt-5.4-mini',
        displayName: 'GPT-5.4 Mini',
        capabilities: ['text-generation'],
        description: 'Default subtitle translation model routed through OpenRouter.',
      },
      {
        id: 'openrouter-gpt-4o-mini',
        model: 'openai/gpt-4o-mini',
        displayName: 'GPT-4o Mini',
        capabilities: ['text-generation'],
        description: 'Fast general-purpose model routed through OpenRouter.',
      },
      {
        id: 'openrouter-claude-sonnet',
        model: 'anthropic/claude-3.5-sonnet',
        displayName: 'Claude 3.5 Sonnet',
        capabilities: ['text-generation'],
        description: 'High quality text model available through OpenRouter.',
      },
      {
        id: 'openrouter-deepseek-chat',
        model: 'deepseek/deepseek-chat',
        displayName: 'DeepSeek Chat',
        capabilities: ['text-generation'],
        description: 'DeepSeek chat model routed through OpenRouter.',
      },
    ],
  }),
  makeOpenAICompatibleTemplate({
    id: 'template-deepseek',
    source: 'official',
    displayName: 'DeepSeek',
    description: 'DeepSeek official OpenAI-compatible API.',
    notes: 'Use a DeepSeek API key. The default endpoint is compatible with OpenAI chat completions.',
    providerId: 'provider-deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    credentialRef: 'credential://provider/deepseek/default',
    presetModels: [
      {
        id: 'deepseek-v4-flash',
        model: 'deepseek-v4-flash',
        displayName: 'DeepSeek V4 Flash',
        capabilities: ['text-generation'],
        description: 'Fast DeepSeek model for subtitle translation.',
      },
      {
        id: 'deepseek-chat',
        model: 'deepseek-chat',
        displayName: 'DeepSeek Chat',
        capabilities: ['text-generation'],
        description: 'General purpose DeepSeek chat model.',
      },
      {
        id: 'deepseek-reasoner',
        model: 'deepseek-reasoner',
        displayName: 'DeepSeek Reasoner',
        capabilities: ['text-generation'],
        description: 'Reasoning-focused DeepSeek model.',
      },
    ],
  }),
  makeOpenAICompatibleTemplate({
    id: 'template-nvidia',
    source: 'official',
    displayName: 'NVIDIA',
    description: 'NVIDIA NIM / build API with OpenAI-compatible endpoints.',
    notes: 'Use an NVIDIA API key for hosted NIM models or adjust the base URL for a self-hosted NIM service.',
    providerId: 'provider-nvidia',
    model: 'meta/llama-3.1-70b-instruct',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    credentialRef: 'credential://provider/nvidia/default',
    presetModels: [
      {
        id: 'nvidia-llama-3.1-70b',
        model: 'meta/llama-3.1-70b-instruct',
        displayName: 'Llama 3.1 70B Instruct',
        capabilities: ['text-generation'],
        description: 'Hosted instruction model through NVIDIA.',
      },
      {
        id: 'nvidia-nemotron',
        model: 'nvidia/llama-3.1-nemotron-70b-instruct',
        displayName: 'Nemotron 70B Instruct',
        capabilities: ['text-generation'],
        description: 'NVIDIA-tuned instruction model.',
      },
    ],
  }),
  makeOpenAICompatibleTemplate({
    id: 'template-gemini',
    source: 'official',
    displayName: 'Gemini',
    description: 'Google Gemini OpenAI-compatible API endpoint.',
    notes: 'Use a Gemini API key. This preset sends the key with the x-goog-api-key header.',
    providerId: 'provider-gemini',
    model: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    credentialRef: 'credential://provider/gemini/default',
    authHeaderName: 'x-goog-api-key',
    authScheme: 'api-key',
    presetModels: [
      {
        id: 'gemini-2.5-flash',
        model: 'gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        capabilities: ['text-generation'],
        description: 'Fast Gemini text model for translation and general generation.',
      },
      {
        id: 'gemini-2.5-pro',
        model: 'gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        capabilities: ['text-generation'],
        description: 'Higher quality Gemini text model.',
      },
    ],
  }),
  makeOpenAICompatibleTemplate({
    id: 'template-ollama',
    source: 'community',
    displayName: 'Ollama',
    description: 'Local Ollama OpenAI-compatible endpoint.',
    notes: 'Start Ollama locally and pull the model before probing. No API key is required by default.',
    providerId: 'provider-ollama',
    model: 'llama3.1',
    baseUrl: 'http://localhost:11434/v1',
    credentialRef: 'credential://provider/ollama/default',
    authHeaderName: '',
    authScheme: 'none',
    presetModels: [
      {
        id: 'ollama-llama3.1',
        model: 'llama3.1',
        displayName: 'Llama 3.1',
        capabilities: ['text-generation'],
        description: 'Common local Ollama model.',
      },
      {
        id: 'ollama-qwen2.5',
        model: 'qwen2.5',
        displayName: 'Qwen2.5',
        capabilities: ['text-generation'],
        description: 'Local Qwen model served by Ollama.',
      },
      {
        id: 'ollama-gemma2',
        model: 'gemma2',
        displayName: 'Gemma 2',
        capabilities: ['text-generation'],
        description: 'Local Gemma model served by Ollama.',
      },
    ],
  }),
  makeOpenAICompatibleTemplate({
    id: 'template-lmstudio',
    source: 'community',
    displayName: 'LM Studio',
    description: 'Local LM Studio OpenAI-compatible server.',
    notes: 'Start the LM Studio local server and load a model before probing. No API key is required by default.',
    providerId: 'provider-lmstudio',
    model: 'local-model',
    baseUrl: 'http://localhost:1234/v1',
    credentialRef: 'credential://provider/lmstudio/default',
    authHeaderName: '',
    authScheme: 'none',
    presetModels: [
      {
        id: 'lmstudio-local-model',
        model: 'local-model',
        displayName: 'Local Model',
        capabilities: ['text-generation'],
        description: 'Placeholder for the model currently loaded in LM Studio.',
      },
    ],
  }),
];

export const defaultProviderTemplate =
  providerTemplates.find((item) => item.id === 'template-dashscope-realtime') ?? providerTemplates[0];
