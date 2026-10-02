import { describe, expect, it } from 'vitest';
import type { ProviderModelCapabilityRegistryEntry, RealtimeAudioMode } from '../schema/config';
import { createProviderModelCapabilityRegistryEntry, resolveInteractionCapabilities } from './provider-model-capabilities';

function entry(realtimeAudioMode: RealtimeAudioMode): ProviderModelCapabilityRegistryEntry {
  return { id: 'legacy-mode', modelId: 'exact-legacy-model', source: 'manual', capabilities: ['speech-to-speech'], realtimeAudioMode };
}

describe('legacy interaction defaults and native translation exclusions', () => {
  it.each([
    ['manual', ['manual_commit', 'push_to_talk']],
    ['gemini_auto_activity', ['auto_vad', 'client_activity']],
    ['gemini_manual_activity', ['client_activity', 'push_to_talk']],
    ['server_vad', ['auto_vad']],
    ['semantic_vad', ['auto_vad']],
  ] as const)('uses explicit %s mode defaults only when interaction metadata is absent', (mode, expected) => {
    const registry = [entry(mode)];
    expect(resolveInteractionCapabilities('exact-legacy-model', registry)).toEqual([...expected]);
    registry[0].interactionCapabilities = [];
    expect(resolveInteractionCapabilities('exact-legacy-model', registry)).toEqual([]);
  });

  it('removes pipeline-only controls from livetranslate and restores required native streaming/VAD controls', () => {
    const registry: ProviderModelCapabilityRegistryEntry[] = [{ ...entry('manual'), modelId: 'exact-livetranslate', interactionCapabilities: ['pipeline_asr_mt_tts', 'server_commit_tts', 'commit_tts', 'text_only_backend'] }];
    const before = structuredClone(registry);
    expect(resolveInteractionCapabilities('exact-livetranslate', registry)).toEqual(['auto_vad', 'streaming']);
    expect(registry).toEqual(before);
  });

  it('creates manual-mode registry controls without incorrectly defaulting to automatic VAD', () => {
    expect(createProviderModelCapabilityRegistryEntry('manual-model', ['speech-to-speech'], 'manual')).toMatchObject({ modelId: 'manual-model', realtimeAudioMode: 'manual', interactionCapabilities: ['manual_commit', 'push_to_talk'], source: 'manual' });
  });
});
