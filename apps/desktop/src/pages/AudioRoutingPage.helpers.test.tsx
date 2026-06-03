import { describe, expect, it } from 'vitest';
import { audioRoutingPageHelpers } from './AudioRoutingPage';
import type { ModelPreset } from '../schema/provider-template';

const { isVoiceModel, resolveSelectedModel } = audioRoutingPageHelpers;

type RoutingModelOption = ModelPreset & { providerTemplateId: string; rawModelId: string };

function model(overrides: Partial<ModelPreset> = {}): RoutingModelOption {
  return {
    id: 'provider::model',
    model: 'provider::model',
    displayName: 'Model',
    description: 'desc',
    capabilities: ['text-generation'],
    providerTemplateId: 'template-a',
    rawModelId: 'model',
    ...overrides,
  } as RoutingModelOption;
}

describe('audioRoutingPageHelpers', () => {
  it('isVoiceModel returns true only for voice capabilities', () => {
    expect(isVoiceModel(model({ capabilities: ['text-generation'] }))).toBe(false);
    expect(isVoiceModel(model({ capabilities: ['speech-to-text'] }))).toBe(true);
    expect(isVoiceModel(model({ capabilities: ['text-to-speech'] }))).toBe(true);
    expect(isVoiceModel(model({ capabilities: ['speech-to-speech'] }))).toBe(true);
    expect(isVoiceModel(model({ capabilities: ['text-generation', 'speech-to-text'] }))).toBe(true);
  });

  it('resolveSelectedModel returns the matching model or undefined', () => {
    const alpha = model({ model: 'provider::alpha', id: 'provider::alpha' });
    const beta = model({ model: 'provider::beta', id: 'provider::beta' });
    expect(resolveSelectedModel([alpha, beta], 'provider::alpha')).toBe(alpha);
    expect(resolveSelectedModel([alpha, beta], 'missing')).toBeUndefined();
    expect(resolveSelectedModel([], 'anything')).toBeUndefined();
  });
});
