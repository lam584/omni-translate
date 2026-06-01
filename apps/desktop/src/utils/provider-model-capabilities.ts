import type { ProviderScenario, ProviderModelCapabilityRegistryEntry } from '../schema/config';
import type { ProviderCapability } from '../schema/provider-contract';
import type { ProviderModelRuntime } from '../schema/provider-runtime';

export const providerCapabilityOrder: ProviderCapability[] = ['speech-to-text', 'text-to-speech', 'speech-to-speech', 'text-generation'];

type SeedRegistryEntry = {
  id: string;
  modelId: string;
  capabilities: ProviderCapability[];
};

const seedRegistryEntries: SeedRegistryEntry[] = [
  { id: 'seed-qwen3-asr-flash-realtime', modelId: 'qwen3-asr-flash-realtime', capabilities: ['speech-to-text'] },
  { id: 'seed-qwen3-asr-flash', modelId: 'qwen3-asr-flash', capabilities: ['speech-to-text'] },
  { id: 'seed-fun-asr-realtime', modelId: 'fun-asr-realtime', capabilities: ['speech-to-text'] },
  { id: 'seed-fun-asr', modelId: 'fun-asr', capabilities: ['speech-to-text'] },
  { id: 'seed-qwen3-tts-flash', modelId: 'qwen3-tts-flash', capabilities: ['text-to-speech'] },
  { id: 'seed-cosyvoice-v3.5-plus', modelId: 'cosyvoice-v3.5-plus', capabilities: ['text-to-speech'] },
  { id: 'seed-minimax-speech-2.8-hd', modelId: 'MiniMax/speech-2.8-hd', capabilities: ['text-to-speech'] },
  { id: 'seed-qwen3-livetranslate-flash-realtime', modelId: 'qwen3-livetranslate-flash-realtime', capabilities: ['speech-to-text', 'speech-to-speech'] },
  { id: 'seed-qwen3-livetranslate-flash-realtime-2025-09-22', modelId: 'qwen3-livetranslate-flash-realtime-2025-09-22', capabilities: ['speech-to-text', 'speech-to-speech'] },
  { id: 'seed-qwen3-livetranslate-flash', modelId: 'qwen3-livetranslate-flash', capabilities: ['speech-to-text', 'speech-to-speech'] },
  { id: 'seed-qwen3-livetranslate-flash-2025-12-01', modelId: 'qwen3-livetranslate-flash-2025-12-01', capabilities: ['speech-to-text', 'speech-to-speech'] },
  { id: 'seed-qwen3.5-omni-plus-realtime', modelId: 'qwen3.5-omni-plus-realtime', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3.5-omni-plus-realtime-2026-03-15', modelId: 'qwen3.5-omni-plus-realtime-2026-03-15', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3.5-omni-plus', modelId: 'qwen3.5-omni-plus', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3.5-omni-plus-2026-03-15', modelId: 'qwen3.5-omni-plus-2026-03-15', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3.5-omni-flash-realtime', modelId: 'qwen3.5-omni-flash-realtime', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3.5-omni-flash-realtime-2026-03-15', modelId: 'qwen3.5-omni-flash-realtime-2026-03-15', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3.5-omni-flash', modelId: 'qwen3.5-omni-flash', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3.5-omni-flash-2026-03-15', modelId: 'qwen3.5-omni-flash-2026-03-15', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3-omni-flash-realtime', modelId: 'qwen3-omni-flash-realtime', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3-omni-flash-realtime-2025-12-01', modelId: 'qwen3-omni-flash-realtime-2025-12-01', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3-omni-flash-realtime-2025-09-15', modelId: 'qwen3-omni-flash-realtime-2025-09-15', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3-omni-flash', modelId: 'qwen3-omni-flash', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3-omni-flash-2025-12-01', modelId: 'qwen3-omni-flash-2025-12-01', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen3-omni-flash-2025-09-15', modelId: 'qwen3-omni-flash-2025-09-15', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen2.5-omni-7b', modelId: 'qwen2.5-omni-7b', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen-omni-turbo-realtime', modelId: 'qwen-omni-turbo-realtime', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen-omni-turbo-realtime-latest', modelId: 'qwen-omni-turbo-realtime-latest', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen-omni-turbo-realtime-2025-05-08', modelId: 'qwen-omni-turbo-realtime-2025-05-08', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen-omni-turbo', modelId: 'qwen-omni-turbo', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen-omni-turbo-latest', modelId: 'qwen-omni-turbo-latest', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen-omni-turbo-2025-03-26', modelId: 'qwen-omni-turbo-2025-03-26', capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'] },
  { id: 'seed-qwen-plus', modelId: 'qwen-plus', capabilities: ['text-generation'] },
  { id: 'seed-qwen-turbo', modelId: 'qwen-turbo', capabilities: ['text-generation'] },
  { id: 'seed-qwen-max', modelId: 'qwen-max', capabilities: ['text-generation'] },
  { id: 'seed-gpt-4o-mini', modelId: 'gpt-4o-mini', capabilities: ['text-generation'] },
  { id: 'seed-gpt-4o', modelId: 'gpt-4o', capabilities: ['text-generation'] },
  { id: 'seed-deepseek-chat', modelId: 'deepseek-chat', capabilities: ['text-generation'] },
];

function normalizeModelKey(value: string) {
  return value.trim().toLowerCase();
}

export function normalizeProviderCapabilityList(capabilities: Iterable<ProviderCapability>) {
  const capabilityList = Array.from(capabilities);
  const seen = new Set<ProviderCapability>();
  const normalized: ProviderCapability[] = [];

  for (const capability of providerCapabilityOrder) {
    for (const current of capabilityList) {
      if (current === capability && !seen.has(current)) {
        seen.add(current);
        normalized.push(current);
      }
    }
  }

  return normalized;
}

export function createProviderModelCapabilityRegistryEntry(
  modelId = '',
  capabilities: ProviderCapability[] = [],
): ProviderModelCapabilityRegistryEntry {
  return {
    id: `registry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    modelId,
    capabilities: normalizeProviderCapabilityList(capabilities),
  };
}

export function createDefaultLocalModelCapabilityRegistry(): ProviderModelCapabilityRegistryEntry[] {
  return seedRegistryEntries.map((entry) => ({
    id: entry.id,
    modelId: entry.modelId,
    capabilities: [...entry.capabilities],
  }));
}

export function formatProviderCapabilityLabel(capability: ProviderCapability) {
  if (capability === 'speech-to-text') {
    return '语音转文字';
  }

  if (capability === 'text-to-speech') {
    return '文字转语音';
  }

  if (capability === 'speech-to-speech') {
    return '语音转语音（语音翻译）';
  }

  return '文本生成';
}

export function capabilityForScenario(scenario: ProviderScenario): ProviderCapability {
  if (scenario === 'watch') {
    return 'speech-to-text';
  }

  if (scenario === 'game') {
    return 'text-to-speech';
  }

  if (scenario === 'voice-room') {
    return 'speech-to-speech';
  }

  return 'text-generation';
}

export function mapUpstreamCapabilitiesToScenarios(capabilities: Array<string | ProviderCapability>) {
  const normalized: ProviderCapability[] = [];

  for (const capability of capabilities) {
    if (capability === 'speech-to-text' || capability === 'text-to-speech' || capability === 'speech-to-speech' || capability === 'text-generation') {
      normalized.push(capability);
      continue;
    }

    if (capability === 'realtime-translation') {
      normalized.push('speech-to-speech');
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

  if (/((^|[-_/])asr([-_/]|$))|fun-asr|sensevoice|paraformer|gummy/.test(haystack)) {
    normalized.push('speech-to-text');
  }

  if (/((^|[-_/])tts([-_/]|$))|cosyvoice|sambert|speech-\d/.test(haystack)) {
    normalized.push('text-to-speech');
  }

  if (haystack.includes('livetranslate')) {
    normalized.push('speech-to-text', 'speech-to-speech');
  }

  if (haystack.includes('omni')) {
    normalized.push('speech-to-text', 'text-to-speech', 'speech-to-speech');
  }

  if (haystack.includes('realtime') && normalized.length === 0) {
    normalized.push('speech-to-speech');
  }

  if (/((^|[-_/])(qwen|gpt|deepseek|claude|gemini|glm|llama|mistral|yi)([-_/]|$))|chat|completions/.test(haystack) && normalized.length === 0) {
    normalized.push('text-generation');
  }

  return normalizeProviderCapabilityList(normalized);
}

export function resolveLocalRegistryCapabilities(
  modelId: string,
  registry: ProviderModelCapabilityRegistryEntry[],
): ProviderCapability[] | null {
  const normalizedModelId = normalizeModelKey(modelId);
  const match = registry.find((entry) => normalizeModelKey(entry.modelId) === normalizedModelId);

  return match ? normalizeProviderCapabilityList(match.capabilities) : null;
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