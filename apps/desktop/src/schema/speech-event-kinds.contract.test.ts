import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SPEECH_EVENT_KINDS } from './speech-event-kinds';

// Cross-language pin for the speech dispatch event vocabulary. The mock world
// once invented `speech.tts-requested`, a kind with zero matches in src-tauri,
// and tests asserted on it — pinning both directions keeps the fake bridge and
// the preview defaults speaking the native dialect.

const here = dirname(fileURLToPath(import.meta.url));
const srcTauri = join(here, '..', '..', 'src-tauri', 'src');

function readRustSpeechSources(): string {
  return [
    readFileSync(join(srcTauri, 'audio', 'speech', 'dispatch.rs'), 'utf8'),
    readFileSync(join(srcTauri, 'audio', 'speech.rs'), 'utf8'),
  ].join('\n');
}

function collectRustSpeechKinds(source: string): Set<string> {
  const kinds = new Set<string>();
  for (const match of source.matchAll(/"(speech\.[a-z-]+)"/g)) {
    kinds.add(match[1]);
  }
  return kinds;
}

describe('speech event kind vocabulary (TS ↔ Rust)', () => {
  it('every pinned kind exists verbatim in the Rust speech dispatch sources', () => {
    const rust = readRustSpeechSources();
    for (const kind of SPEECH_EVENT_KINDS) {
      expect(rust, `kind ${kind} must appear in src-tauri speech sources`).toContain(`"${kind}"`);
    }
  });

  it('every speech.* event kind emitted by Rust is part of the pinned vocabulary', () => {
    const rustKinds = collectRustSpeechKinds(readRustSpeechSources());
    for (const kind of rustKinds) {
      expect(
        SPEECH_EVENT_KINDS,
        `Rust emits ${kind}; add it to SPEECH_EVENT_KINDS to keep the vocabulary pinned`,
      ).toContain(kind);
    }
    expect(rustKinds.size).toBeGreaterThanOrEqual(SPEECH_EVENT_KINDS.length);
  });

  it('mock and preview speech events only use pinned kinds (no phantom kinds)', () => {
    const mockSources = [
      readFileSync(join(here, '..', 'mocks', 'fake-bridge.ts'), 'utf8'),
      readFileSync(join(here, '..', 'defaults', 'audio-runtime.ts'), 'utf8'),
    ].join('\n');
    for (const match of mockSources.matchAll(/kind: '(speech\.[a-z-]+)'/g)) {
      expect(
        SPEECH_EVENT_KINDS,
        `mock uses ${match[1]}, which the native side never emits`,
      ).toContain(match[1]);
    }
  });
});
