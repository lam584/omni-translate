import { describe, expect, it } from 'vitest';
import {
  capabilityForScenario,
  inferProviderCapabilitiesFromModelName,
  mapUpstreamCapabilitiesToScenarios,
  normalizeProviderCapabilityList,
  resolveProviderModelCapabilities,
} from './provider-model-capabilities';

describe('provider model capabilities', () => {
  it('normalizes capability order and maps every scenario', () => {
    expect(normalizeProviderCapabilityList(['text-generation', 'speech-to-text', 'text-generation'])).toEqual([
      'speech-to-text',
      'text-generation',
    ]);
    expect(capabilityForScenario('watch')).toBe('speech-to-text');
    expect(capabilityForScenario('game')).toBe('text-to-speech');
    expect(capabilityForScenario('voice-room')).toBe('speech-to-speech');
    expect(capabilityForScenario('subtitle-translate')).toBe('text-generation');
  });

  it('maps upstream aliases and infers common audio and text model families', () => {
    expect(mapUpstreamCapabilitiesToScenarios(['realtime-translation', 'translation', 'text-to-text', 'unknown'])).toEqual([
      'speech-to-speech',
      'text-generation',
    ]);
    expect(inferProviderCapabilitiesFromModelName('fun-asr-realtime')).toEqual(['speech-to-text']);
    expect(inferProviderCapabilitiesFromModelName('qwen-livetranslate-flash')).toEqual(['speech-to-text', 'speech-to-speech']);
    expect(inferProviderCapabilitiesFromModelName('qwen-omni-realtime')).toEqual([
      'speech-to-text',
      'text-to-speech',
      'speech-to-speech',
    ]);
    expect(inferProviderCapabilitiesFromModelName('custom-realtime')).toEqual(['speech-to-speech']);
    expect(inferProviderCapabilitiesFromModelName('custom', 'DeepSeek Chat')).toEqual(['text-generation']);
    expect(inferProviderCapabilitiesFromModelName('unclassified')).toEqual([]);
  });

  it('prefers local registry entries, then name inference, then upstream capabilities', () => {
    const registry = [{ id: 'registry-1', modelId: ' Custom ', capabilities: ['text-to-speech'] as const }];
    expect(
      resolveProviderModelCapabilities(
        { id: 'custom', displayName: 'Custom', capabilities: ['text-generation'] },
        registry.map((entry) => ({ ...entry, capabilities: [...entry.capabilities] })),
      ),
    ).toEqual(['text-to-speech']);
    expect(resolveProviderModelCapabilities({ id: 'sensevoice', displayName: 'SenseVoice', capabilities: [] }, [])).toEqual([
      'speech-to-text',
    ]);
    expect(resolveProviderModelCapabilities({ id: 'unclassified', displayName: 'Unknown', capabilities: ['text-generation'] }, [])).toEqual([
      'text-generation',
    ]);
  });
});
