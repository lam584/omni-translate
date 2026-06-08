import type { ProviderScenario, ProviderModelCapabilityRegistryEntry, RealtimeAudioMode } from '../schema/config';
import type { ProviderCapability, ProviderInteractionCapability } from '../schema/provider-contract';
import type { ProviderModelRuntime } from '../schema/provider-runtime';

export const providerCapabilityOrder: ProviderCapability[] = ['speech-to-text', 'text-to-speech', 'speech-to-speech', 'text-generation'];

export const realtimeAudioModeOrder: RealtimeAudioMode[] = [
  'manual',
  'server_vad',
  'semantic_vad',
  'gemini_auto_activity',
  'gemini_manual_activity',
];

export const providerInteractionCapabilityOrder: ProviderInteractionCapability[] = [
  'auto_vad',
  'manual_commit',
  'client_activity',
  'streaming',
  'chunked_http_audio',
  'push_to_talk',
  'server_commit_tts',
  'commit_tts',
  'text_only_backend',
  'pipeline_asr_mt_tts',
];

type SeedRegistryEntry = ProviderModelCapabilityRegistryEntry & {
  id: string;
  modelId: string;
  capabilities: ProviderCapability[];
};

const seedRegistryEntries: SeedRegistryEntry[] = [
  {
    id: 'seed-openai-gpt-realtime',
    modelId: 'gpt-realtime',
    capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'],
    realtimeAudioMode: 'server_vad',
    interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'],
    apiModes: ['websocket', 'webrtc', 'sip'],
    releasedAt: '2025-08-28',
    source: 'official',
  },
  {
    id: 'seed-openai-gpt-realtime-2',
    modelId: 'gpt-realtime-2',
    capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'],
    realtimeAudioMode: 'server_vad',
    interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'],
    apiModes: ['websocket', 'webrtc', 'sip'],
    releasedAt: '2026-05-07',
    source: 'official',
  },
  {
    id: 'seed-openai-gpt-realtime-translate',
    modelId: 'gpt-realtime-translate',
    capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'],
    realtimeAudioMode: 'server_vad',
    interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'],
    apiModes: ['websocket', 'webrtc', 'sip'],
    releasedAt: '2026-05-07',
    source: 'official',
  },
  {
    id: 'seed-openai-gpt-realtime-whisper',
    modelId: 'gpt-realtime-whisper',
    capabilities: ['speech-to-text'],
    realtimeAudioMode: 'server_vad',
    interactionCapabilities: ['streaming', 'chunked_http_audio'],
    apiModes: ['realtime', 'audio'],
    releasedAt: '2026-05-07',
    source: 'official',
  },
  {
    id: 'seed-openai-gpt-audio',
    modelId: 'gpt-audio',
    capabilities: ['text-to-speech', 'speech-to-speech'],
    interactionCapabilities: ['streaming', 'chunked_http_audio'],
    apiModes: ['chat-audio', 'http-audio'],
    releasedAt: 'unknown',
    source: 'official',
  },
  {
    id: 'seed-openai-gpt-audio-mini',
    modelId: 'gpt-audio-mini',
    capabilities: ['text-to-speech', 'speech-to-speech'],
    interactionCapabilities: ['streaming', 'chunked_http_audio'],
    apiModes: ['chat-audio', 'http-audio'],
    releasedAt: 'unknown',
    source: 'official',
  },
  {
    id: 'seed-openai-gpt-4o-transcribe',
    modelId: 'gpt-4o-transcribe',
    capabilities: ['speech-to-text'],
    interactionCapabilities: ['chunked_http_audio'],
    apiModes: ['audio-transcriptions'],
    releasedAt: 'unknown',
    source: 'official',
  },
  {
    id: 'seed-openai-gpt-4o-mini-transcribe',
    modelId: 'gpt-4o-mini-transcribe',
    capabilities: ['speech-to-text'],
    interactionCapabilities: ['chunked_http_audio'],
    apiModes: ['audio-transcriptions'],
    releasedAt: 'unknown',
    source: 'official',
  },
  {
    id: 'seed-openai-whisper-1',
    modelId: 'whisper-1',
    capabilities: ['speech-to-text'],
    interactionCapabilities: ['chunked_http_audio'],
    apiModes: ['audio-transcriptions'],
    releasedAt: 'unknown',
    source: 'official',
  },
  {
    id: 'seed-gemini-2.5-flash-native-audio-preview-09-2025',
    modelId: 'gemini-2.5-flash-native-audio-preview-09-2025',
    capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'],
    realtimeAudioMode: 'gemini_auto_activity',
    interactionCapabilities: ['auto_vad', 'client_activity', 'streaming', 'push_to_talk'],
    apiModes: ['live-websocket'],
    releasedAt: '2025-09-23',
    source: 'official',
  },
  {
    id: 'seed-gemini-2.5-flash-native-audio-preview-12-2025',
    modelId: 'gemini-2.5-flash-native-audio-preview-12-2025',
    capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'],
    realtimeAudioMode: 'gemini_auto_activity',
    interactionCapabilities: ['auto_vad', 'client_activity', 'streaming', 'push_to_talk'],
    apiModes: ['live-websocket'],
    releasedAt: '2025-12-12',
    source: 'official',
  },
  {
    id: 'seed-gemini-3.1-flash-live-preview',
    modelId: 'gemini-3.1-flash-live-preview',
    capabilities: ['speech-to-text', 'speech-to-speech'],
    realtimeAudioMode: 'gemini_auto_activity',
    interactionCapabilities: ['auto_vad', 'client_activity', 'streaming', 'push_to_talk'],
    apiModes: ['live-websocket'],
    releasedAt: 'unknown',
    source: 'official',
  },
  {
    id: 'seed-gemini-3.1-flash-tts-preview',
    modelId: 'gemini-3.1-flash-tts-preview',
    capabilities: ['text-to-speech'],
    interactionCapabilities: ['chunked_http_audio'],
    apiModes: ['generate-content', 'batch'],
    releasedAt: '2026-04-28',
    source: 'official',
  },
  {
    id: 'seed-qwen3-asr-flash-realtime',
    modelId: 'qwen3-asr-flash-realtime',
    capabilities: ['speech-to-text'],
    realtimeAudioMode: 'server_vad',
    interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'],
    apiModes: ['websocket'],
    releasedAt: '2025-09-07',
    source: 'official',
  },
  {
    id: 'seed-qwen3-asr-flash-filetrans',
    modelId: 'qwen3-asr-flash-filetrans',
    capabilities: ['speech-to-text'],
    interactionCapabilities: ['chunked_http_audio'],
    apiModes: ['filetrans', 'async-batch'],
    releasedAt: 'unknown',
    source: 'official',
  },
  { id: 'seed-qwen3-asr-flash', modelId: 'qwen3-asr-flash', capabilities: ['speech-to-text'], interactionCapabilities: ['chunked_http_audio'], source: 'official' },
  { id: 'seed-fun-asr-realtime', modelId: 'fun-asr-realtime', capabilities: ['speech-to-text'], realtimeAudioMode: 'server_vad', interactionCapabilities: ['auto_vad', 'streaming'], source: 'official' },
  { id: 'seed-fun-asr', modelId: 'fun-asr', capabilities: ['speech-to-text'], interactionCapabilities: ['chunked_http_audio'], source: 'official' },
  {
    id: 'seed-qwen-tts',
    modelId: 'qwen-tts',
    capabilities: ['text-to-speech'],
    interactionCapabilities: ['chunked_http_audio'],
    apiModes: ['http-audio'],
    releasedAt: '2025-06-27',
    source: 'official',
  },
  {
    id: 'seed-qwen-tts-realtime-2025-07-15',
    modelId: 'qwen-tts-realtime-2025-07-15',
    capabilities: ['text-to-speech'],
    interactionCapabilities: ['server_commit_tts', 'commit_tts', 'streaming'],
    apiModes: ['websocket'],
    releasedAt: '2025-07-15',
    source: 'official',
  },
  {
    id: 'seed-qwen3-tts-vd-realtime-2025-12-16',
    modelId: 'qwen3-tts-vd-realtime-2025-12-16',
    capabilities: ['text-to-speech'],
    interactionCapabilities: ['server_commit_tts', 'commit_tts', 'streaming'],
    apiModes: ['websocket'],
    releasedAt: '2025-12-16',
    source: 'official',
  },
  {
    id: 'seed-qwen3-tts-instruct-flash-realtime-2026-01-22',
    modelId: 'qwen3-tts-instruct-flash-realtime-2026-01-22',
    capabilities: ['text-to-speech'],
    interactionCapabilities: ['server_commit_tts', 'commit_tts', 'streaming'],
    apiModes: ['websocket'],
    releasedAt: '2026-01-22',
    source: 'official',
  },
  { id: 'seed-qwen3-tts-flash', modelId: 'qwen3-tts-flash', capabilities: ['text-to-speech'], interactionCapabilities: ['chunked_http_audio'], source: 'official' },
  { id: 'seed-cosyvoice-v3.5-plus', modelId: 'cosyvoice-v3.5-plus', capabilities: ['text-to-speech'], interactionCapabilities: ['chunked_http_audio'], source: 'official' },
  { id: 'seed-minimax-speech-2.8-hd', modelId: 'MiniMax/speech-2.8-hd', capabilities: ['text-to-speech'], interactionCapabilities: ['chunked_http_audio'], source: 'preset' },
  {
    id: 'seed-qwen3.5-livetranslate-flash-realtime',
    modelId: 'qwen3.5-livetranslate-flash-realtime',
    capabilities: ['speech-to-text', 'speech-to-speech'],
    realtimeAudioMode: 'server_vad',
    interactionCapabilities: ['auto_vad', 'streaming'],
    apiModes: ['websocket'],
    releasedAt: '2026-05-19',
    source: 'official',
  },
  {
    id: 'seed-qwen3-livetranslate-flash-realtime',
    modelId: 'qwen3-livetranslate-flash-realtime',
    capabilities: ['speech-to-text', 'speech-to-speech'],
    realtimeAudioMode: 'server_vad',
    interactionCapabilities: ['auto_vad', 'streaming'],
    apiModes: ['websocket'],
    releasedAt: '2025-09-22',
    source: 'official',
  },
  { id: 'seed-qwen3-livetranslate-flash-realtime-2025-09-22', modelId: 'qwen3-livetranslate-flash-realtime-2025-09-22', capabilities: ['speech-to-text', 'speech-to-speech'], realtimeAudioMode: 'server_vad', interactionCapabilities: ['auto_vad', 'streaming'], releasedAt: '2025-09-22', source: 'official' },
  { id: 'seed-qwen3-livetranslate-flash', modelId: 'qwen3-livetranslate-flash', capabilities: ['speech-to-text', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], source: 'official' },
  { id: 'seed-qwen3-livetranslate-flash-2025-12-01', modelId: 'qwen3-livetranslate-flash-2025-12-01', capabilities: ['speech-to-text', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], releasedAt: '2025-12-01', source: 'official' },
  { id: 'seed-qwen3.5-omni-plus-realtime', modelId: 'qwen3.5-omni-plus-realtime', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], realtimeAudioMode: 'manual', interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'], releasedAt: '2026-03-29', source: 'official' },
  { id: 'seed-qwen3.5-omni-plus-realtime-2026-03-15', modelId: 'qwen3.5-omni-plus-realtime-2026-03-15', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], realtimeAudioMode: 'manual', interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'], releasedAt: '2026-03-15', source: 'official' },
  { id: 'seed-qwen3.5-omni-plus', modelId: 'qwen3.5-omni-plus', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], releasedAt: '2026-03-15', source: 'official' },
  { id: 'seed-qwen3.5-omni-plus-2026-03-15', modelId: 'qwen3.5-omni-plus-2026-03-15', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], releasedAt: '2026-03-15', source: 'official' },
  { id: 'seed-qwen3.5-omni-flash-realtime', modelId: 'qwen3.5-omni-flash-realtime', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], realtimeAudioMode: 'manual', interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'], releasedAt: '2026-03-29', source: 'official' },
  { id: 'seed-qwen3.5-omni-flash-realtime-2026-03-15', modelId: 'qwen3.5-omni-flash-realtime-2026-03-15', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], realtimeAudioMode: 'manual', interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'], releasedAt: '2026-03-15', source: 'official' },
  { id: 'seed-qwen3.5-omni-flash', modelId: 'qwen3.5-omni-flash', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], releasedAt: '2026-03-15', source: 'official' },
  { id: 'seed-qwen3.5-omni-flash-2026-03-15', modelId: 'qwen3.5-omni-flash-2026-03-15', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], releasedAt: '2026-03-15', source: 'official' },
  { id: 'seed-qwen3-omni-flash-realtime', modelId: 'qwen3-omni-flash-realtime', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], realtimeAudioMode: 'manual', interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'], releasedAt: '2025-12-01', source: 'official' },
  { id: 'seed-qwen3-omni-flash-realtime-2025-12-01', modelId: 'qwen3-omni-flash-realtime-2025-12-01', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], realtimeAudioMode: 'manual', interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'], releasedAt: '2025-12-01', source: 'official' },
  { id: 'seed-qwen3-omni-flash-realtime-2025-09-15', modelId: 'qwen3-omni-flash-realtime-2025-09-15', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], realtimeAudioMode: 'manual', interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'], releasedAt: '2025-09-15', source: 'official' },
  { id: 'seed-qwen3-omni-flash', modelId: 'qwen3-omni-flash', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], source: 'official' },
  { id: 'seed-qwen3-omni-flash-2025-12-01', modelId: 'qwen3-omni-flash-2025-12-01', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], releasedAt: '2025-12-01', source: 'official' },
  { id: 'seed-qwen3-omni-flash-2025-09-15', modelId: 'qwen3-omni-flash-2025-09-15', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], releasedAt: '2025-09-15', source: 'official' },
  { id: 'seed-qwen2.5-omni-7b', modelId: 'qwen2.5-omni-7b', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], source: 'official' },
  { id: 'seed-qwen-omni-turbo-realtime', modelId: 'qwen-omni-turbo-realtime', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], realtimeAudioMode: 'manual', interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'], releasedAt: '2025-05-08', source: 'official' },
  { id: 'seed-qwen-omni-turbo-realtime-latest', modelId: 'qwen-omni-turbo-realtime-latest', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], realtimeAudioMode: 'manual', interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'], releasedAt: '2025-05-08', source: 'official' },
  { id: 'seed-qwen-omni-turbo-realtime-2025-05-08', modelId: 'qwen-omni-turbo-realtime-2025-05-08', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], realtimeAudioMode: 'manual', interactionCapabilities: ['auto_vad', 'manual_commit', 'streaming', 'push_to_talk'], releasedAt: '2025-05-08', source: 'official' },
  { id: 'seed-qwen-omni-turbo', modelId: 'qwen-omni-turbo', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], source: 'official' },
  { id: 'seed-qwen-omni-turbo-latest', modelId: 'qwen-omni-turbo-latest', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], source: 'official' },
  { id: 'seed-qwen-omni-turbo-2025-03-26', modelId: 'qwen-omni-turbo-2025-03-26', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio'], releasedAt: '2025-03-26', source: 'official' },
  { id: 'seed-openrouter-gpt-audio', modelId: 'openai/gpt-audio', capabilities: ['text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio', 'streaming'], apiModes: ['openrouter-audio'], source: 'runtime', releasedAt: 'unknown' },
  { id: 'seed-openrouter-gpt-audio-mini', modelId: 'openai/gpt-audio-mini', capabilities: ['text-to-speech', 'speech-to-speech'], interactionCapabilities: ['chunked_http_audio', 'streaming'], apiModes: ['openrouter-audio'], source: 'runtime', releasedAt: 'unknown' },
  { id: 'seed-openrouter-qwen3-asr-flash-2026-02-10', modelId: 'qwen/qwen3-asr-flash-2026-02-10', capabilities: ['speech-to-text'], interactionCapabilities: ['chunked_http_audio'], apiModes: ['openrouter-transcription'], source: 'runtime', releasedAt: '2026-02-10' },
  { id: 'seed-openrouter-nvidia-parakeet-tdt-0.6b-v3', modelId: 'nvidia/parakeet-tdt-0.6b-v3', capabilities: ['speech-to-text'], interactionCapabilities: ['chunked_http_audio'], apiModes: ['openrouter-transcription'], source: 'runtime', releasedAt: 'unknown' },
  { id: 'seed-nvidia-parakeet-tdt-0.6b-v3', modelId: 'nvidia/parakeet-tdt-0.6b-v3', capabilities: ['speech-to-text'], interactionCapabilities: ['streaming', 'auto_vad', 'pipeline_asr_mt_tts'], apiModes: ['nim-asr', 'riva-asr'], source: 'official', releasedAt: 'unknown' },
  { id: 'seed-nvidia-magpie-tts-multilingual', modelId: 'nvidia/magpie-tts-multilingual', capabilities: ['text-to-speech'], interactionCapabilities: ['streaming', 'pipeline_asr_mt_tts'], apiModes: ['nim-tts', 'riva-tts'], source: 'official', releasedAt: 'unknown' },
  { id: 'seed-nvidia-magpie-tts-zeroshot', modelId: 'nvidia/magpie-tts-zeroshot', capabilities: ['text-to-speech'], interactionCapabilities: ['streaming', 'pipeline_asr_mt_tts'], apiModes: ['nim-tts', 'riva-tts'], source: 'official', releasedAt: 'unknown' },
  { id: 'seed-nvidia-magpie-tts-flow', modelId: 'nvidia/magpie-tts-flow', capabilities: ['text-to-speech'], interactionCapabilities: ['pipeline_asr_mt_tts'], apiModes: ['nim-tts-offline'], source: 'official', releasedAt: 'unknown' },
  { id: 'seed-ollama-text-only', modelId: 'ollama-local-text', capabilities: ['text-generation'], interactionCapabilities: ['text_only_backend'], apiModes: ['local-openai-compatible'], source: 'preset' },
  { id: 'seed-lmstudio-text-only', modelId: 'lmstudio-local-text', capabilities: ['text-generation'], interactionCapabilities: ['text_only_backend'], apiModes: ['local-openai-compatible'], source: 'preset' },
  { id: 'seed-qwen-plus', modelId: 'qwen-plus', capabilities: ['text-generation'], interactionCapabilities: ['text_only_backend'], source: 'official' },
  { id: 'seed-qwen-turbo', modelId: 'qwen-turbo', capabilities: ['text-generation'], interactionCapabilities: ['text_only_backend'], source: 'official' },
  { id: 'seed-qwen-max', modelId: 'qwen-max', capabilities: ['text-generation'], interactionCapabilities: ['text_only_backend'], source: 'official' },
  { id: 'seed-gpt-4o-mini', modelId: 'gpt-4o-mini', capabilities: ['text-generation'], interactionCapabilities: ['text_only_backend'], source: 'official' },
  { id: 'seed-gpt-4o', modelId: 'gpt-4o', capabilities: ['text-generation'], interactionCapabilities: ['text_only_backend'], source: 'official' },
  { id: 'seed-deepseek-chat', modelId: 'deepseek-chat', capabilities: ['text-generation'], interactionCapabilities: ['text_only_backend'], source: 'preset' },
];

function normalizeModelKey(value: string) {
  return value.trim().toLowerCase();
}

function uniqueOrdered<T extends string>(values: Iterable<T>, order: readonly T[]) {
  const valueSet = new Set(values);
  return order.filter((item) => valueSet.has(item));
}

export function normalizeProviderCapabilityList(capabilities: Iterable<ProviderCapability>) {
  return uniqueOrdered(capabilities, providerCapabilityOrder);
}

export function normalizeProviderInteractionCapabilityList(capabilities: Iterable<ProviderInteractionCapability>) {
  return uniqueOrdered(capabilities, providerInteractionCapabilityOrder);
}

export function createProviderModelCapabilityRegistryEntry(
  modelId = '',
  capabilities: ProviderCapability[] = [],
  realtimeAudioMode?: RealtimeAudioMode,
  interactionCapabilities?: ProviderInteractionCapability[],
): ProviderModelCapabilityRegistryEntry {
  return {
    id: `registry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    modelId,
    capabilities: normalizeProviderCapabilityList(capabilities),
    realtimeAudioMode: realtimeAudioMode ?? inferRealtimeAudioModeFromModelName(modelId),
    interactionCapabilities: normalizeProviderInteractionCapabilityList(
      interactionCapabilities ?? inferInteractionCapabilitiesFromModelName(modelId, undefined, realtimeAudioMode),
    ),
    source: 'manual',
  };
}

export function createDefaultLocalModelCapabilityRegistry(): ProviderModelCapabilityRegistryEntry[] {
  return seedRegistryEntries.map((entry) => ({
    ...entry,
    capabilities: normalizeProviderCapabilityList(entry.capabilities),
    realtimeAudioMode: entry.realtimeAudioMode ?? inferRealtimeAudioModeFromModelName(entry.modelId),
    interactionCapabilities: normalizeProviderInteractionCapabilityList(
      entry.interactionCapabilities ?? inferInteractionCapabilitiesFromModelName(entry.modelId, undefined, entry.realtimeAudioMode),
    ),
  }));
}

export function isRealtimeAudioMode(value: string): value is RealtimeAudioMode {
  return realtimeAudioModeOrder.includes(value as RealtimeAudioMode);
}

export function isProviderInteractionCapability(value: string): value is ProviderInteractionCapability {
  return providerInteractionCapabilityOrder.includes(value as ProviderInteractionCapability);
}

export function formatRealtimeAudioModeLabel(mode: RealtimeAudioMode) {
  if (mode === 'manual') return 'Manual commit';
  if (mode === 'server_vad') return 'Server VAD';
  if (mode === 'semantic_vad') return 'Semantic VAD';
  if (mode === 'gemini_auto_activity') return 'Gemini auto activity';
  return 'Gemini manual activity';
}

export function formatRealtimeAudioModeShortLabel(mode: RealtimeAudioMode) {
  if (mode === 'manual') return 'Manual';
  if (mode === 'server_vad') return 'VAD';
  if (mode === 'semantic_vad') return 'Semantic';
  if (mode === 'gemini_auto_activity') return 'G-Auto';
  return 'G-Manual';
}

export function formatProviderInteractionCapabilityLabel(capability: ProviderInteractionCapability) {
  const labels: Record<ProviderInteractionCapability, string> = {
    auto_vad: 'Auto VAD',
    manual_commit: 'Manual commit',
    client_activity: 'Client activity',
    streaming: 'Streaming',
    chunked_http_audio: 'Chunked HTTP audio',
    push_to_talk: 'Push-to-talk',
    server_commit_tts: 'TTS server_commit',
    commit_tts: 'TTS commit',
    text_only_backend: 'Text-only backend',
    pipeline_asr_mt_tts: 'ASR->MT->TTS pipeline',
  };
  return labels[capability];
}

export function formatProviderInteractionCapabilityShortLabel(capability: ProviderInteractionCapability) {
  const labels: Record<ProviderInteractionCapability, string> = {
    auto_vad: 'VAD',
    manual_commit: 'Commit',
    client_activity: 'Activity',
    streaming: 'Stream',
    chunked_http_audio: 'HTTP audio',
    push_to_talk: 'PTT',
    server_commit_tts: 'Srv TTS',
    commit_tts: 'TTS commit',
    text_only_backend: 'Text',
    pipeline_asr_mt_tts: 'Pipeline',
  };
  return labels[capability];
}

export function inferRealtimeAudioModeFromModelName(modelId: string, displayName?: string): RealtimeAudioMode {
  const haystack = `${modelId} ${displayName ?? ''}`.toLowerCase();

  if (haystack.includes('gemini') && (haystack.includes('live') || haystack.includes('native-audio') || haystack.includes('realtime'))) {
    return 'gemini_auto_activity';
  }

  if (haystack.includes('livetranslate')) return 'server_vad';
  if (haystack.includes('omni') && haystack.includes('realtime')) return 'manual';
  if ((haystack.includes('gpt') || haystack.includes('openai')) && haystack.includes('realtime')) return 'server_vad';
  if (haystack.includes('asr') && haystack.includes('realtime')) return 'server_vad';

  return 'server_vad';
}

export function inferInteractionCapabilitiesFromModelName(
  modelId: string,
  displayName?: string,
  realtimeAudioMode?: RealtimeAudioMode,
): ProviderInteractionCapability[] {
  const haystack = `${modelId} ${displayName ?? ''}`.toLowerCase();
  const capabilities: ProviderInteractionCapability[] = [];
  const add = (...items: ProviderInteractionCapability[]) => {
    capabilities.push(...items);
  };

  if (haystack.includes('ollama') || haystack.includes('lmstudio') || haystack.includes('lm studio')) add('text_only_backend');
  if (haystack.includes('openrouter/')) add('chunked_http_audio');
  if (haystack.includes('nvidia/') || haystack.includes('parakeet') || haystack.includes('magpie')) add('pipeline_asr_mt_tts');
  if (haystack.includes('realtime') || haystack.includes('live') || haystack.includes('native-audio') || haystack.includes('gpt-audio')) add('streaming');
  if (haystack.includes('livetranslate')) add('auto_vad');
  if ((haystack.includes('omni') || haystack.includes('gpt-realtime') || haystack.includes('asr')) && haystack.includes('realtime')) {
    add('auto_vad', 'manual_commit', 'push_to_talk');
  }
  if (haystack.includes('semantic_vad')) add('auto_vad');
  if (haystack.includes('gemini') && (haystack.includes('live') || haystack.includes('native-audio') || haystack.includes('realtime'))) {
    add('auto_vad', 'client_activity', 'push_to_talk');
  }
  if (haystack.includes('tts') && haystack.includes('realtime')) add('server_commit_tts', 'commit_tts');
  if (
    haystack.includes('filetrans') ||
    haystack.includes('transcribe') ||
    haystack.includes('whisper') ||
    haystack.includes('audio') ||
    (haystack.includes('tts') && !haystack.includes('realtime'))
  ) {
    add('chunked_http_audio');
  }
  if (realtimeAudioMode === 'manual') add('manual_commit', 'push_to_talk');
  if (realtimeAudioMode === 'server_vad' || realtimeAudioMode === 'semantic_vad') add('auto_vad');
  if (realtimeAudioMode === 'gemini_auto_activity') add('auto_vad', 'client_activity');
  if (realtimeAudioMode === 'gemini_manual_activity') add('client_activity', 'push_to_talk');

  return normalizeProviderInteractionCapabilityList(capabilities);
}

export function formatProviderCapabilityLabel(capability: ProviderCapability) {
  if (capability === 'speech-to-text') return 'Speech to text';
  if (capability === 'text-to-speech') return 'Text to speech';
  if (capability === 'speech-to-speech') return 'Speech to speech';
  return 'Text generation';
}

export function formatProviderCapabilityShortLabel(capability: ProviderCapability) {
  if (capability === 'speech-to-text') return 'STT';
  if (capability === 'text-to-speech') return 'TTS';
  if (capability === 'speech-to-speech') return 'S2S';
  return 'Text';
}

export function capabilityForScenario(scenario: ProviderScenario): ProviderCapability {
  if (scenario === 'watch') return 'speech-to-text';
  if (scenario === 'game') return 'text-to-speech';
  if (scenario === 'voice-room') return 'speech-to-speech';
  return 'text-generation';
}

export function mapUpstreamCapabilitiesToScenarios(capabilities: Array<string | ProviderCapability>) {
  const normalized: ProviderCapability[] = [];

  for (const capability of capabilities) {
    if (capability === 'speech-to-text' || capability === 'text-to-speech' || capability === 'speech-to-speech' || capability === 'text-generation') {
      normalized.push(capability);
      continue;
    }

    if (capability === 'realtime-translation' || capability === 'audio' || capability === 'input_audio') {
      normalized.push('speech-to-speech');
      continue;
    }

    if (capability === 'transcription' || capability === 'transcribe' || capability === 'stt') {
      normalized.push('speech-to-text');
      continue;
    }

    if (capability === 'tts' || capability === 'speech') {
      normalized.push('text-to-speech');
      continue;
    }

    if (capability === 'translation' || capability === 'text-to-text') {
      normalized.push('text-generation');
    }
  }

  return normalizeProviderCapabilityList(normalized);
}

export function inferProviderCapabilitiesFromModelName(modelId: string, displayName?: string) {
  const haystack = `${modelId} ${displayName ?? ''}`.toLowerCase();
  const normalized: ProviderCapability[] = [];

  if (/((^|[-_/])asr([-_/]|$))|fun-asr|sensevoice|paraformer|gummy|transcribe|whisper|parakeet|chirp|voxtral/.test(haystack)) {
    normalized.push('speech-to-text');
  }

  if (/((^|[-_/])tts([-_/]|$))|cosyvoice|sambert|speech-\d|gpt-audio|magpie/.test(haystack)) {
    normalized.push('text-to-speech');
  }

  if (haystack.includes('livetranslate')) {
    normalized.push('speech-to-text', 'speech-to-speech');
  }

  if (haystack.includes('omni')) {
    normalized.push('speech-to-text', 'text-to-speech', 'speech-to-speech');
  }

  if (haystack.includes('gpt-realtime') || (haystack.includes('gemini') && (haystack.includes('live') || haystack.includes('native-audio')))) {
    normalized.push('speech-to-text', 'text-to-speech', 'speech-to-speech');
  }

  if (haystack.includes('gpt-audio')) {
    normalized.push('speech-to-speech');
  }

  if (/((^|[-_/])(qwen|gpt|deepseek|claude|gemini|glm|llama|mistral|yi|nemotron)([-_/]|$))|chat|completions|local-model|ollama|lmstudio/.test(haystack) && normalized.length === 0) {
    normalized.push('text-generation');
  }

  return normalizeProviderCapabilityList(normalized);
}

export function resolveLocalRegistryEntry(
  modelId: string,
  registry: ProviderModelCapabilityRegistryEntry[],
): ProviderModelCapabilityRegistryEntry | null {
  const normalizedModelId = normalizeModelKey(modelId);
  return registry.find((entry) => normalizeModelKey(entry.modelId) === normalizedModelId) ?? null;
}

export function resolveLocalRegistryCapabilities(
  modelId: string,
  registry: ProviderModelCapabilityRegistryEntry[],
): ProviderCapability[] | null {
  const match = resolveLocalRegistryEntry(modelId, registry);
  return match ? normalizeProviderCapabilityList(match.capabilities) : null;
}

export function resolveInteractionCapabilities(
  modelId: string,
  registry: ProviderModelCapabilityRegistryEntry[],
  displayName?: string,
): ProviderInteractionCapability[] {
  const match = resolveLocalRegistryEntry(modelId, registry);
  if (match?.interactionCapabilities && match.interactionCapabilities.length > 0) {
    return normalizeProviderInteractionCapabilityList(match.interactionCapabilities);
  }
  return inferInteractionCapabilitiesFromModelName(modelId, displayName, match?.realtimeAudioMode);
}

export function resolveRealtimeAudioMode(
  modelId: string,
  registry: ProviderModelCapabilityRegistryEntry[],
  displayName?: string,
): RealtimeAudioMode {
  const match = resolveLocalRegistryEntry(modelId, registry);

  if (match?.realtimeAudioMode) {
    return match.realtimeAudioMode;
  }

  const interactions = match?.interactionCapabilities ?? inferInteractionCapabilitiesFromModelName(modelId, displayName);
  if (interactions.includes('client_activity')) return 'gemini_auto_activity';
  if (interactions.includes('manual_commit')) return 'manual';
  if (interactions.includes('auto_vad')) return 'server_vad';

  return inferRealtimeAudioModeFromModelName(modelId, displayName);
}

export function resolveProviderModelCapabilities(
  model: Pick<ProviderModelRuntime, 'id' | 'displayName' | 'capabilities'>,
  registry: ProviderModelCapabilityRegistryEntry[],
) {
  const local = resolveLocalRegistryCapabilities(model.id, registry);

  if (local && local.length > 0) {
    return local;
  }

  const inferred = inferProviderCapabilitiesFromModelName(model.id, model.displayName);

  if (inferred.length > 0) {
    return inferred;
  }

  return mapUpstreamCapabilitiesToScenarios(model.capabilities);
}

export function normalizeProviderModel(
  model: ProviderModelRuntime,
  registry: ProviderModelCapabilityRegistryEntry[],
): ProviderModelRuntime {
  return {
    ...model,
    capabilities: resolveProviderModelCapabilities(model, registry),
  };
}

export function normalizeProviderModels(
  models: ProviderModelRuntime[],
  registry: ProviderModelCapabilityRegistryEntry[],
): ProviderModelRuntime[] {
  return models.map((model) => normalizeProviderModel(model, registry));
}
