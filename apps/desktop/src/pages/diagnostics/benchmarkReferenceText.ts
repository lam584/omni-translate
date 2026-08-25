import generalText from '../../../../../scripts/testing/fixtures/watch-mode-en-original.txt?raw';
import conversationText from '../../../../../scripts/testing/fixtures/watch-mode-en-conversation.txt?raw';
import technicalText from '../../../../../scripts/testing/fixtures/watch-mode-en-technical.txt?raw';
import generalReferenceText from '../../../../../scripts/testing/fixtures/watch-mode-en-original.zh-CN.txt?raw';
import conversationReferenceText from '../../../../../scripts/testing/fixtures/watch-mode-en-conversation.zh-CN.txt?raw';
import technicalReferenceText from '../../../../../scripts/testing/fixtures/watch-mode-en-technical.zh-CN.txt?raw';

type BenchmarkFixtureText = {
  source: string;
  referenceTranslation: string;
};

const ENGLISH_FIXTURES: Array<{ marker: string; text: BenchmarkFixtureText }> = [
  { marker: 'watch-mode-en-conversation', text: { source: conversationText, referenceTranslation: conversationReferenceText } },
  { marker: 'watch-mode-en-technical', text: { source: technicalText, referenceTranslation: technicalReferenceText } },
  { marker: 'watch-mode-en-original', text: { source: generalText, referenceTranslation: generalReferenceText } },
];

function resolveEnglishFixture(audioFile: string): BenchmarkFixtureText | null {
  const normalized = audioFile.replace(/\\/g, '/').toLowerCase();
  return ENGLISH_FIXTURES.find(({ marker }) => normalized.includes(marker))?.text ?? null;
}

/** The expected spoken text for a shipped English benchmark audio fixture. */
export function resolveBenchmarkSourceText(audioFile: string): string | null {
  return resolveEnglishFixture(audioFile)?.source.trim() ?? null;
}

/** The expected Chinese translation used by the deterministic semantic proxy. */
export function resolveBenchmarkReferenceTranslation(audioFile: string): string | null {
  return resolveEnglishFixture(audioFile)?.referenceTranslation.trim() ?? null;
}
