import { describe, expect, it } from 'vitest';

import dispatchRs from '../../src-tauri/src/audio/speech/dispatch.rs?raw';
import speechRs from '../../src-tauri/src/audio/speech.rs?raw';
import fakeBridgeSource from '../mocks/fake-bridge.ts?raw';
import previewDefaultsSource from '../defaults/audio-runtime.ts?raw';
import { SPEECH_EVENT_KINDS } from './speech-event-kinds';

// Cross-language pin for the speech dispatch event vocabulary. The mock world
// once invented `speech.tts-requested`, a kind with zero matches in src-tauri,
// and tests asserted on it — pinning both directions keeps the fake bridge and
// the preview defaults speaking the native dialect.

const rustSpeechSources = `${dispatchRs}\n${speechRs}`;

function collectRustSpeechKinds(source: string): Set<string> {
  const kinds = new Set<string>();
  for (const match of source.matchAll(/"(speech\.[a-z-]+)"/g)) {
    kinds.add(match[1]);
  }
  return kinds;
}

describe('speech event kind vocabulary (TS ↔ Rust)', () => {
  it('every pinned kind exists verbatim in the Rust speech dispatch sources', () => {
    for (const kind of SPEECH_EVENT_KINDS) {
      expect(rustSpeechSources, `kind ${kind} must appear in src-tauri speech sources`).toContain(`"${kind}"`);
    }
  });

  it('every speech.* event kind emitted by Rust is part of the pinned vocabulary', () => {
    const rustKinds = collectRustSpeechKinds(rustSpeechSources);
    for (const kind of rustKinds) {
      expect(
        SPEECH_EVENT_KINDS,
        `Rust emits ${kind}; add it to SPEECH_EVENT_KINDS to keep the vocabulary pinned`,
      ).toContain(kind);
    }
    expect(rustKinds.size).toBeGreaterThanOrEqual(SPEECH_EVENT_KINDS.length);
  });

  it('mock and preview speech events only use pinned kinds (no phantom kinds)', () => {
    const mockSources = `${fakeBridgeSource}\n${previewDefaultsSource}`;
    for (const match of mockSources.matchAll(/kind: '(speech\.[a-z-]+)'/g)) {
      expect(
        SPEECH_EVENT_KINDS,
        `mock uses ${match[1]}, which the native side never emits`,
      ).toContain(match[1]);
    }
  });
});
