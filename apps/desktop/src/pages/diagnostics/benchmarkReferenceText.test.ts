import { describe, expect, it } from 'vitest';
import { resolveBenchmarkReferenceTranslation, resolveBenchmarkSourceText } from './benchmarkReferenceText';

describe('benchmark fixture text resolution', () => {
  it('resolves source and reference text for a shipped English audio path', () => {
    const audioFile = 'scripts\\testing\\fixtures\\watch-mode-en-original.wav';

    expect(resolveBenchmarkSourceText(audioFile)).toContain('Good morning.');
    expect(resolveBenchmarkReferenceTranslation(audioFile)).toContain('早上好。');
  });

  it('does not score arbitrary custom audio against a fixture', () => {
    expect(resolveBenchmarkSourceText('C:/audio/custom.wav')).toBeNull();
    expect(resolveBenchmarkReferenceTranslation('C:/audio/custom.wav')).toBeNull();
  });
});
