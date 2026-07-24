import { describe, expect, it } from 'vitest';

import { detectScenarioCapabilities, supportsRoutingScenario, type ScenarioId } from './routingModelCatalog';

describe('routing model catalog exhaustiveness', () => {
  it('returns safe defaults for a future scenario id', () => {
    const model = { capabilities: ['speech-to-text'] } as never;
    expect(supportsRoutingScenario(model, 'future' as ScenarioId)).toBe(false);
    expect(detectScenarioCapabilities(model as never, 'future' as ScenarioId)).toEqual([]);
  });

  it('keeps outbound speech capability absent for STT-only models', () => {
    expect(detectScenarioCapabilities({ capabilities: ['speech-to-text'] } as never, 'outbound')).toEqual([
      'stt',
      'translation',
    ]);
  });
});
