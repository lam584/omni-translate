import { describe, expect, it } from 'vitest';
import type { ModelPreset } from '../schema/provider-template';
import { audioRoutingPageHelpers } from './AudioRoutingPage';

const {
  detectScenarioCapabilities,
  isVoiceModel,
  resolveSelectedModel,
  supportsRoutingScenario,
} = audioRoutingPageHelpers;

function model(capabilities: ModelPreset['capabilities']): ModelPreset {
  return {
    id: `preset-${capabilities.join('-') || 'none'}`,
    model: `model-${capabilities.join('-') || 'none'}`,
    displayName: 'Model',
    description: '',
    capabilities,
  };
}

const stt = model(['speech-to-text']);
const tts = model(['text-to-speech']);
const s2s = model(['speech-to-speech']);
const text = model(['text-generation']);
const all = model(['speech-to-text', 'text-to-speech', 'speech-to-speech', 'text-generation']);

describe('AudioRoutingPage helpers', () => {
  it('detects voice models and selected options', () => {
    expect([stt, tts, s2s, text].map(isVoiceModel)).toEqual([true, true, true, false]);
    expect(resolveSelectedModel([
      { ...stt, providerTemplateId: 'template-a', rawModelId: 'stt' },
      { ...text, providerTemplateId: 'template-a', rawModelId: 'text' },
    ], text.model)?.rawModelId).toBe('text');
    expect(resolveSelectedModel([], 'missing')).toBeUndefined();
  });

  it('maps scenario capabilities for empty and single-purpose models', () => {
    expect(detectScenarioCapabilities(undefined, 'inbound')).toEqual([]);
    expect(detectScenarioCapabilities(stt, 'inbound')).toEqual(['stt', 'translation', 'subtitle']);
    expect(detectScenarioCapabilities(tts, 'inbound')).toEqual([]);
    expect(detectScenarioCapabilities(stt, 'inboundSecondary')).toEqual(['stt']);
    expect(detectScenarioCapabilities(tts, 'inboundSecondary')).toEqual([]);
    expect(detectScenarioCapabilities(text, 'subtitle')).toEqual(['translation']);
    expect(detectScenarioCapabilities(tts, 'subtitle')).toEqual([]);
    expect(detectScenarioCapabilities(tts, 'tts')).toEqual(['tts']);
    expect(detectScenarioCapabilities(stt, 'tts')).toEqual([]);
  });

  it('maps scenario capabilities for speech-to-speech and default branches', () => {
    expect(detectScenarioCapabilities(s2s, 'inbound')).toEqual(['translation', 'subtitle']);
    expect(detectScenarioCapabilities(s2s, 'subtitle')).toEqual(['translation']);
    expect(detectScenarioCapabilities(s2s, 'outbound')).toEqual(['translation', 'speech']);
    expect(detectScenarioCapabilities(tts, 'outbound')).toEqual(['speech']);
    expect(detectScenarioCapabilities(all, 'outbound')).toEqual(['stt', 'translation', 'speech']);
    expect(detectScenarioCapabilities(s2s, 'tts')).toEqual(['tts']);
    expect(detectScenarioCapabilities(all, 'unknown' as never)).toEqual([]);
  });

  it('filters routing candidates by the capability each card actually requires', () => {
    expect([stt, tts, s2s].map((candidate) => supportsRoutingScenario(candidate, 'inbound'))).toEqual([true, false, true]);
    expect([stt, tts, s2s].map((candidate) => supportsRoutingScenario(candidate, 'outbound'))).toEqual([false, false, true]);
    expect([stt, tts, s2s].map((candidate) => supportsRoutingScenario(candidate, 'inboundSecondary'))).toEqual([true, false, false]);
    expect([stt, tts, s2s].map((candidate) => supportsRoutingScenario(candidate, 'tts'))).toEqual([false, true, true]);
    expect([text, stt].map((candidate) => supportsRoutingScenario(candidate, 'subtitle'))).toEqual([true, false]);
  });
});
