/**
 * Benchmark audio fixtures bundled in the repository.
 *
 * Paths are relative to the repository root (the Tauri working directory).
 */

export type BenchmarkAudioPreset = {
  /** Repository-relative path passed to the Rust benchmark runner. */
  path: string;
  /** Short display label, e.g. "English (original)". */
  label: string;
  /** ISO language code, e.g. "en", "zh-CN". */
  languageCode: string;
  /** Approximate duration in seconds (from manifest metadata). */
  durationSeconds?: number;
};

const FIXTURES_BASE = 'scripts/testing/fixtures';
/** The canonical source recording shipped in the root fixtures directory. */
export const ENGLISH_AUDIO_PRESETS: BenchmarkAudioPreset[] = [
  { path: `${FIXTURES_BASE}/watch-mode-en-original.wav`, label: 'English (original)', languageCode: 'en' },
];

/** Optional generated fixtures remain available through the custom-path input. */
export const ALL_BENCHMARK_AUDIO_PRESETS: BenchmarkAudioPreset[] = ENGLISH_AUDIO_PRESETS;

/** Sentinel value for the "custom path" option in the audio source select. */
export const CUSTOM_AUDIO_VALUE = '__custom__';

/** Default preset path used on first render. */
export const DEFAULT_BENCHMARK_AUDIO_PATH = ENGLISH_AUDIO_PRESETS[0]!.path;
