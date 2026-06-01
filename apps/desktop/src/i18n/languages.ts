/**
 * Supported UI languages for Omni Translate desktop shell.
 *
 * The order here drives the "first-run language picker" list (and the
 * settings page combobox). The list matches the top-20 most spoken languages
 * per the product brief, with Simplified Chinese as the default fallback.
 */
export type SupportedLanguage = {
  /** IETF BCP-47 tag used as i18next resource key. */
  code: string;
  /** Localized name as shown in that language (autonym). */
  nativeName: string;
  /** English name, used as a secondary hint in the picker. */
  englishName: string;
};

export const supportedLanguages: SupportedLanguage[] = [
  { code: 'zh-CN', nativeName: '简体中文', englishName: 'Chinese (Simplified)' },
  { code: 'en', nativeName: 'English', englishName: 'English' },
  { code: 'es', nativeName: 'Español', englishName: 'Spanish' },
  { code: 'ar', nativeName: 'العربية', englishName: 'Arabic' },
  { code: 'pt', nativeName: 'Português', englishName: 'Portuguese' },
  { code: 'ru', nativeName: 'Русский', englishName: 'Russian' },
  { code: 'hi', nativeName: 'हिन्दी', englishName: 'Hindi' },
  { code: 'bn', nativeName: 'বাংলা', englishName: 'Bengali' },
  { code: 'de', nativeName: 'Deutsch', englishName: 'German' },
  { code: 'id', nativeName: 'Bahasa Indonesia', englishName: 'Indonesian' },
  { code: 'ko', nativeName: '한국어', englishName: 'Korean' },
  { code: 'fr', nativeName: 'Français', englishName: 'French' },
  { code: 'vi', nativeName: 'Tiếng Việt', englishName: 'Vietnamese' },
  { code: 'ja', nativeName: '日本語', englishName: 'Japanese' },
  { code: 'te', nativeName: 'తెలుగు', englishName: 'Telugu' },
  { code: 'ta', nativeName: 'தமிழ்', englishName: 'Tamil' },
  { code: 'mr', nativeName: 'मराठी', englishName: 'Marathi' },
  { code: 'th', nativeName: 'ไทย', englishName: 'Thai' },
  { code: 'fil', nativeName: 'Filipino', englishName: 'Filipino' },
  { code: 'tr', nativeName: 'Türkçe', englishName: 'Turkish' },
];

export const defaultLanguage = 'zh-CN';

/** Languages considered right-to-left for document-direction toggling. */
export const rtlLanguages = new Set(['ar']);

export const supportedLanguageCodes = supportedLanguages.map((item) => item.code);

export function isSupportedLanguage(code: string | null | undefined): code is string {
  return typeof code === 'string' && supportedLanguageCodes.includes(code);
}
