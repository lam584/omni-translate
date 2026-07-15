import type { ModelPreset } from '../../schema/provider-template';

export type ScenarioId = 'inbound' | 'inboundSecondary' | 'subtitle' | 'outbound' | 'tts';
export type ScenarioCapability = 'stt' | 'translation' | 'subtitle' | 'speech' | 'tts';

export type RoutingModelOption = ModelPreset & {
  providerTemplateId: string;
  rawModelId: string;
};

export function optionDomId(modelId: string): string {
  return modelId.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function isVoiceModel(model: Pick<ModelPreset, 'capabilities'>) {
  return model.capabilities.some((capability) => (
    capability === 'speech-to-text'
    || capability === 'text-to-speech'
    || capability === 'speech-to-speech'
  ));
}

export function resolveSelectedModel(options: RoutingModelOption[], modelId: string) {
  return options.find((model) => model.model === modelId);
}

export function detectScenarioCapabilities(
  model: ModelPreset | undefined,
  scenario: ScenarioId,
): ScenarioCapability[] {
  if (!model) return [];
  const caps = new Set(model.capabilities);
  const tags: ScenarioCapability[] = [];

  switch (scenario) {
    case 'inbound':
      if (caps.has('speech-to-text')) tags.push('stt');
      if (caps.has('speech-to-text') || caps.has('speech-to-speech')) tags.push('translation', 'subtitle');
      return tags;
    case 'inboundSecondary':
      return caps.has('speech-to-text') ? ['stt'] : [];
    case 'subtitle':
      return caps.has('text-generation') || caps.has('speech-to-text') || caps.has('speech-to-speech')
        ? ['translation']
        : [];
    case 'outbound':
      if (caps.has('speech-to-text')) tags.push('stt');
      if (caps.has('speech-to-text') || caps.has('speech-to-speech')) tags.push('translation');
      if (caps.has('speech-to-speech') || caps.has('text-to-speech')) tags.push('speech');
      return tags;
    case 'tts':
      return caps.has('text-to-speech') || caps.has('speech-to-speech') ? ['tts'] : [];
    default:
      return [];
  }
}
