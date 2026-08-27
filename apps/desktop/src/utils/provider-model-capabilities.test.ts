import { describe, expect, it } from 'vitest';
import {
  capabilityForScenario,
  createDefaultLocalModelCapabilityRegistry,
  createProviderModelCapabilityRegistryEntry,
  formatProviderCapabilityLabel,
  formatProviderCapabilityShortLabel,
  formatProviderInteractionCapabilityLabel,
  formatProviderInteractionCapabilityShortLabel,
  formatRealtimeAudioModeLabel,
  formatRealtimeAudioModeShortLabel,
  inferProviderCapabilitiesFromModelName,
  inferInteractionCapabilitiesFromModelName,
  inferRealtimeAudioModeFromModelName,
  isProviderInteractionCapability,
  isRealtimeAudioMode,
  mapUpstreamCapabilitiesToScenarios,
  normalizeProviderCapabilityList,
  normalizeProviderInteractionCapabilityList,
  providerInteractionCapabilityGroupLabelKey,
  providerInteractionCapabilityGroups,
  providerInteractionCapabilityOrder,
  realtimeAudioModeHelpKey,
  resolveInteractionCapabilities,
  resolveRealtimeAudioMode,
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

  it('normalizes interactions and formats labels for all public labels', () => {
    expect(normalizeProviderInteractionCapabilityList(['push_to_talk', 'auto_vad', 'push_to_talk'])).toEqual(['auto_vad', 'push_to_talk']);
    expect(isRealtimeAudioMode('semantic_vad')).toBe(true);
    expect(isRealtimeAudioMode('unknown')).toBe(false);
    expect(isProviderInteractionCapability('manual_commit')).toBe(true);
    expect(isProviderInteractionCapability('unknown')).toBe(false);

    expect(['manual', 'server_vad', 'semantic_vad', 'gemini_auto_activity', 'gemini_manual_activity'].map((mode) =>
      formatRealtimeAudioModeLabel(mode as Parameters<typeof formatRealtimeAudioModeLabel>[0]),
    )).toEqual(['Manual commit', 'Server VAD', 'Semantic VAD', 'Gemini auto activity', 'Gemini manual activity']);
    expect(['manual', 'server_vad', 'semantic_vad', 'gemini_auto_activity', 'gemini_manual_activity'].map((mode) =>
      formatRealtimeAudioModeShortLabel(mode as Parameters<typeof formatRealtimeAudioModeShortLabel>[0]),
    )).toEqual(['Manual', 'VAD', 'Semantic', 'G-Auto', 'G-Manual']);

    expect(['speech-to-text', 'text-to-speech', 'speech-to-speech', 'text-generation'].map((capability) =>
      formatProviderCapabilityLabel(capability as Parameters<typeof formatProviderCapabilityLabel>[0]),
    )).toEqual(['Speech to text', 'Text to speech', 'Speech to speech', 'Text generation']);
    expect(['speech-to-text', 'text-to-speech', 'speech-to-speech', 'text-generation'].map((capability) =>
      formatProviderCapabilityShortLabel(capability as Parameters<typeof formatProviderCapabilityShortLabel>[0]),
    )).toEqual(['STT', 'TTS', 'S2S', 'Text']);

    expect(formatProviderInteractionCapabilityLabel('pipeline_asr_mt_tts')).toBe('ASR->MT->TTS pipeline');
    expect(formatProviderInteractionCapabilityShortLabel('server_commit_tts')).toBe('Srv TTS');
  });

  it('maps every realtime audio mode to its audioModeHelp i18n key', () => {
    expect(['manual', 'server_vad', 'semantic_vad', 'gemini_auto_activity', 'gemini_manual_activity'].map((mode) =>
      realtimeAudioModeHelpKey(mode as Parameters<typeof realtimeAudioModeHelpKey>[0]),
    )).toEqual([
      'providers.audioModeHelp.manualFullAudio',
      'providers.audioModeHelp.serverVad',
      'providers.audioModeHelp.semanticVad',
      'providers.audioModeHelp.geminiAuto',
      'providers.audioModeHelp.geminiManual',
    ]);
  });

  it('partitions all interaction capabilities into the four display groups without gaps or overlaps', () => {
    const grouped = providerInteractionCapabilityGroups.flatMap((group) => group.capabilities);
    expect([...grouped].sort()).toEqual([...providerInteractionCapabilityOrder].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(providerInteractionCapabilityGroups.map((group) => group.id)).toEqual(['segmentation', 'transport', 'tts', 'backend']);
    expect(providerInteractionCapabilityGroupLabelKey('segmentation')).toBe('providers.interactionGroups.segmentation');
  });

  it('maps upstream aliases and infers common audio and text model families', () => {
    expect(mapUpstreamCapabilitiesToScenarios(['realtime-translation', 'translation', 'text-to-text', 'unknown'])).toEqual([
      'speech-to-speech',
      'text-generation',
    ]);
    expect(mapUpstreamCapabilitiesToScenarios(['transcription', 'transcribe', 'stt', 'tts', 'speech', 'audio', 'input_audio'])).toEqual([
      'speech-to-text',
      'text-to-speech',
      'speech-to-speech',
    ]);
    expect(inferProviderCapabilitiesFromModelName('fun-asr-realtime')).toEqual(['speech-to-text']);
    expect(inferProviderCapabilitiesFromModelName('qwen-livetranslate-flash')).toEqual(['speech-to-text', 'speech-to-speech']);
    expect(inferProviderCapabilitiesFromModelName('qwen-omni-realtime')).toEqual([
      'speech-to-text',
      'text-to-speech',
      'speech-to-speech',
    ]);
    expect(inferProviderCapabilitiesFromModelName('gpt-realtime')).toEqual([
      'speech-to-text',
      'text-to-speech',
      'speech-to-speech',
    ]);
    expect(inferProviderCapabilitiesFromModelName('gemini-native-audio')).toEqual([
      'speech-to-text',
      'text-to-speech',
      'speech-to-speech',
    ]);
    expect(inferProviderCapabilitiesFromModelName('openai/gpt-audio-mini')).toEqual(['text-to-speech', 'speech-to-speech']);
    expect(inferProviderCapabilitiesFromModelName('custom-realtime')).toEqual([]);
    expect(inferProviderCapabilitiesFromModelName('custom', 'DeepSeek Chat')).toEqual(['text-generation']);
    expect(inferProviderCapabilitiesFromModelName('unclassified')).toEqual([]);
  });

  it('infers interaction capabilities for realtime, HTTP audio, pipeline, and text-only backends', () => {
    expect(inferInteractionCapabilitiesFromModelName('gpt-realtime')).toEqual([
      'auto_vad',
      'manual_commit',
      'streaming',
      'push_to_talk',
    ]);
    expect(inferInteractionCapabilitiesFromModelName('gemini-3.1-flash-live-preview')).toEqual([
      'auto_vad',
      'client_activity',
      'streaming',
      'push_to_talk',
    ]);
    expect(inferInteractionCapabilitiesFromModelName('qwen-tts-realtime-2025-07-15')).toEqual([
      'streaming',
      'server_commit_tts',
      'commit_tts',
    ]);
    expect(inferInteractionCapabilitiesFromModelName('openai/gpt-audio')).toEqual(['streaming', 'chunked_http_audio']);
    expect(inferInteractionCapabilitiesFromModelName('openrouter/openai/gpt-audio')).toEqual(['streaming', 'chunked_http_audio']);
    expect(inferInteractionCapabilitiesFromModelName('qwen-livetranslate-flash')).toEqual(['auto_vad', 'streaming']);
    expect(inferInteractionCapabilitiesFromModelName('custom-semantic_vad')).toEqual(['auto_vad']);
    expect(inferInteractionCapabilitiesFromModelName('gemini-native-audio-preview')).toEqual(['auto_vad', 'client_activity', 'streaming', 'chunked_http_audio', 'push_to_talk']);
    expect(inferInteractionCapabilitiesFromModelName('gemini-realtime')).toEqual(['auto_vad', 'client_activity', 'streaming', 'push_to_talk']);
    expect(inferInteractionCapabilitiesFromModelName('custom', undefined, 'manual')).toEqual(['manual_commit', 'push_to_talk']);
    expect(inferInteractionCapabilitiesFromModelName('custom', undefined, 'gemini_auto_activity')).toEqual(['auto_vad', 'client_activity']);
    expect(inferInteractionCapabilitiesFromModelName('custom', undefined, 'gemini_manual_activity')).toEqual(['client_activity', 'push_to_talk']);
    expect(inferInteractionCapabilitiesFromModelName('nvidia/parakeet-tdt-0.6b-v3')).toEqual(['pipeline_asr_mt_tts']);
    expect(inferInteractionCapabilitiesFromModelName('ollama-local-text')).toEqual(['text_only_backend']);
    expect(inferInteractionCapabilitiesFromModelName('lmstudio-local-text')).toEqual(['text_only_backend']);
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

  it('resolves realtime audio modes from registry and known provider families', () => {
    expect(inferRealtimeAudioModeFromModelName('qwen3.5-livetranslate-flash-realtime')).toBe('server_vad');
    expect(inferRealtimeAudioModeFromModelName('qwen3.5-omni-plus-realtime')).toBe('manual');
    expect(inferRealtimeAudioModeFromModelName('gpt-4o-realtime-preview')).toBe('server_vad');
    expect(inferRealtimeAudioModeFromModelName('gemini-2.5-flash-live')).toBe('gemini_auto_activity');
    expect(inferRealtimeAudioModeFromModelName('qwen-asr-realtime')).toBe('server_vad');

    expect(
      resolveRealtimeAudioMode('custom-realtime', [
        {
          id: 'registry-1',
          modelId: ' custom-realtime ',
          capabilities: ['speech-to-speech'],
          realtimeAudioMode: 'semantic_vad',
        },
      ]),
    ).toBe('semantic_vad');

    expect(
      resolveInteractionCapabilities('openai/gpt-audio', [
        {
          id: 'registry-2',
          modelId: ' openai/gpt-audio ',
          capabilities: ['text-to-speech'],
          interactionCapabilities: ['chunked_http_audio'],
        },
      ]),
    ).toEqual(['chunked_http_audio']);

    expect(
      resolveInteractionCapabilities('custom-realtime', [
        {
          id: 'registry-3',
          modelId: 'custom-realtime',
          capabilities: ['speech-to-speech'],
          realtimeAudioMode: 'manual',
        },
      ]),
    ).toEqual(['manual_commit', 'streaming', 'push_to_talk']);

    expect(
      resolveRealtimeAudioMode('custom-client', [
        {
          id: 'registry-4',
          modelId: 'custom-client',
          capabilities: ['speech-to-speech'],
          interactionCapabilities: ['client_activity'],
        },
      ]),
    ).toBe('gemini_auto_activity');
    expect(
      resolveRealtimeAudioMode('custom-manual', [
        {
          id: 'registry-5',
          modelId: 'custom-manual',
          capabilities: ['speech-to-speech'],
          interactionCapabilities: ['manual_commit'],
        },
      ]),
    ).toBe('manual');
    expect(
      resolveRealtimeAudioMode('custom-vad', [
        {
          id: 'registry-6',
          modelId: 'custom-vad',
          capabilities: ['speech-to-speech'],
          interactionCapabilities: ['auto_vad'],
        },
      ]),
    ).toBe('server_vad');
  });

  it('creates default and manual registry entries with inferred fields', () => {
    const entry = createProviderModelCapabilityRegistryEntry('gemini-native-audio-preview', ['speech-to-speech']);
    expect(entry.capabilities).toEqual(['speech-to-speech']);
    expect(entry.realtimeAudioMode).toBe('gemini_auto_activity');
    expect(entry.interactionCapabilities).toContain('client_activity');
    expect(entry.source).toBe('manual');

    const seeded = createDefaultLocalModelCapabilityRegistry();
    expect(seeded.some((item) => item.modelId === 'gpt-realtime' && item.interactionCapabilities?.includes('manual_commit'))).toBe(true);
    expect(seeded.find((item) => item.modelId === 'gpt-realtime-2.1')?.capabilities).toEqual(['speech-to-text', 'speech-to-speech']);
    expect(seeded.find((item) => item.modelId === 'gpt-realtime-2.1-mini')?.realtimeAudioMode).toBe('server_vad');
    expect(seeded.find((item) => item.modelId === 'gpt-realtime-translate')?.interactionCapabilities).toEqual(['streaming', 'pipeline_asr_mt_tts']);
    expect(seeded.find((item) => item.modelId === 'gpt-realtime-whisper')?.realtimeAudioMode).toBe('manual');
    expect(seeded.find((item) => item.modelId === 'gpt-4o-transcribe')?.realtimeAudioMode).toBe('server_vad');
    expect(seeded.find((item) => item.modelId === 'glm-realtime-flash')?.capabilities).toEqual(['speech-to-text', 'speech-to-speech']);
    expect(seeded.find((item) => item.modelId === 'glm-realtime-flash')?.realtimeAudioMode).toBe('server_vad');
    expect(seeded.find((item) => item.modelId === 'glm-realtime-air')?.interactionCapabilities).toEqual(['auto_vad', 'manual_commit', 'streaming']);
    expect(seeded.find((item) => item.modelId === 'hunyuan-translation-lite')?.interactionCapabilities).toEqual(['streaming', 'pipeline_asr_mt_tts']);
    expect(seeded.find((item) => item.modelId === 'hunyuan-translation')?.realtimeAudioMode).toBe('server_vad');
    expect(seeded.find((item) => item.modelId === 'gemini-3.1-flash-live-preview')?.realtimeAudioMode).toBe('gemini_auto_activity');
    expect(seeded.find((item) => item.modelId === 'qwen3.5-livetranslate-flash-realtime')?.realtimeAudioMode).toBe('server_vad');
    expect(seeded.find((item) => item.modelId === 'qwen3.5-omni-flash-realtime')?.realtimeAudioMode).toBe('semantic_vad');
    expect(seeded.every((item) => item.capabilities.length > 0)).toBe(true);
  });
});
