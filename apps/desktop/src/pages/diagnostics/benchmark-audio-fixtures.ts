/**
 * Preset benchmark audio fixtures derived from
 * `scripts/testing/fixtures/multilingual/manifest.json`.
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
const MULTILINGUAL_BASE = `${FIXTURES_BASE}/multilingual`;

/** English source recordings shipped in the root fixtures directory. */
export const ENGLISH_AUDIO_PRESETS: BenchmarkAudioPreset[] = [
  { path: `${FIXTURES_BASE}/watch-mode-en-original.wav`, label: 'English (original)', languageCode: 'en' },
  { path: `${FIXTURES_BASE}/watch-mode-en-conversation.wav`, label: 'English (conversation)', languageCode: 'en' },
  { path: `${FIXTURES_BASE}/watch-mode-en-technical.wav`, label: 'English (technical)', languageCode: 'en' },
];

/** Multilingual TTS recordings generated from the same source text. */
export const MULTILINGUAL_AUDIO_PRESETS: BenchmarkAudioPreset[] = [
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.zh-CN.wav`, label: '简体中文', languageCode: 'zh-CN', durationSeconds: 120.51 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.es.wav`, label: 'Español', languageCode: 'es', durationSeconds: 127.55 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.ar.wav`, label: 'العربية', languageCode: 'ar', durationSeconds: 120.56 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.pt.wav`, label: 'Português', languageCode: 'pt', durationSeconds: 120.47 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.ru.wav`, label: 'Русский', languageCode: 'ru', durationSeconds: 124.27 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.hi.wav`, label: 'हिन्दी', languageCode: 'hi', durationSeconds: 126.15 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.bn.wav`, label: 'বাংলা', languageCode: 'bn', durationSeconds: 115.04 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.de.wav`, label: 'Deutsch', languageCode: 'de', durationSeconds: 123.43 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.id.wav`, label: 'Bahasa Indonesia', languageCode: 'id', durationSeconds: 122.84 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.ko.wav`, label: '한국어', languageCode: 'ko', durationSeconds: 124.89 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.fr.wav`, label: 'Français', languageCode: 'fr', durationSeconds: 128.45 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.vi.wav`, label: 'Tiếng Việt', languageCode: 'vi', durationSeconds: 124.69 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.ja.wav`, label: '日本語', languageCode: 'ja', durationSeconds: 128.73 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.te.wav`, label: 'తెలుగు', languageCode: 'te', durationSeconds: 145.04 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.ta.wav`, label: 'தமிழ்', languageCode: 'ta', durationSeconds: 118.37 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.mr.wav`, label: 'मराठी', languageCode: 'mr', durationSeconds: 113.01 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.th.wav`, label: 'ไทย', languageCode: 'th', durationSeconds: 120.81 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.fil.wav`, label: 'Filipino', languageCode: 'fil', durationSeconds: 123.12 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.tr.wav`, label: 'Türkçe', languageCode: 'tr', durationSeconds: 119.0 },
];

/** All presets combined (English first, then multilingual). */
export const ALL_BENCHMARK_AUDIO_PRESETS: BenchmarkAudioPreset[] = [
  ...ENGLISH_AUDIO_PRESETS,
  ...MULTILINGUAL_AUDIO_PRESETS,
];

/** Sentinel value for the "custom path" option in the audio source select. */
export const CUSTOM_AUDIO_VALUE = '__custom__';

/** Default preset path used on first render. */
export const DEFAULT_BENCHMARK_AUDIO_PATH = ENGLISH_AUDIO_PRESETS[0]!.path;
