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
  { path: `${FIXTURES_BASE}/watch-mode-en-original.mp3`, label: 'English (original)', languageCode: 'en', durationSeconds: 125.82 },
  { path: `${FIXTURES_BASE}/watch-mode-en-conversation.mp3`, label: 'English (conversation)', languageCode: 'en', durationSeconds: 144.46 },
  { path: `${FIXTURES_BASE}/watch-mode-en-technical.mp3`, label: 'English (technical)', languageCode: 'en', durationSeconds: 149.14 },
];

/** Multilingual TTS recordings generated from the same source text. */
export const MULTILINGUAL_AUDIO_PRESETS: BenchmarkAudioPreset[] = [
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.zh-CN.mp3`, label: '简体中文', languageCode: 'zh-CN', durationSeconds: 120.51 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.es.mp3`, label: 'Español', languageCode: 'es', durationSeconds: 127.55 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.ar.mp3`, label: 'العربية', languageCode: 'ar', durationSeconds: 120.56 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.pt.mp3`, label: 'Português', languageCode: 'pt', durationSeconds: 120.47 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.ru.mp3`, label: 'Русский', languageCode: 'ru', durationSeconds: 124.27 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.hi.mp3`, label: 'हिन्दी', languageCode: 'hi', durationSeconds: 126.15 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.bn.mp3`, label: 'বাংলা', languageCode: 'bn', durationSeconds: 115.04 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.de.mp3`, label: 'Deutsch', languageCode: 'de', durationSeconds: 123.43 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.id.mp3`, label: 'Bahasa Indonesia', languageCode: 'id', durationSeconds: 122.84 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.ko.mp3`, label: '한국어', languageCode: 'ko', durationSeconds: 124.89 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.fr.mp3`, label: 'Français', languageCode: 'fr', durationSeconds: 128.45 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.vi.mp3`, label: 'Tiếng Việt', languageCode: 'vi', durationSeconds: 124.69 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.ja.mp3`, label: '日本語', languageCode: 'ja', durationSeconds: 128.73 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.te.mp3`, label: 'తెలుగు', languageCode: 'te', durationSeconds: 145.04 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.ta.mp3`, label: 'தமிழ்', languageCode: 'ta', durationSeconds: 118.37 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.mr.mp3`, label: 'मराठी', languageCode: 'mr', durationSeconds: 113.01 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.th.mp3`, label: 'ไทย', languageCode: 'th', durationSeconds: 120.81 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.fil.mp3`, label: 'Filipino', languageCode: 'fil', durationSeconds: 123.12 },
  { path: `${MULTILINGUAL_BASE}/watch-mode-general.tr.mp3`, label: 'Türkçe', languageCode: 'tr', durationSeconds: 119.0 },
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
