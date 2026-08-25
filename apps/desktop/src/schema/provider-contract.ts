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
