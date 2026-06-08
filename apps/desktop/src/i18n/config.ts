/**
 * i18next bootstrap for the Omni Translate desktop shell.
 *
 * This module is side-effectful: importing it initializes i18next and wires
 * up persistent language storage, RTL toggling and fallback behavior.
 *
 * Startup only imports the default and English resource bundles. Other
 * offline locale bundles are loaded on demand when the UI language changes.
 */

import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import { defaultLanguage, isSupportedLanguage, rtlLanguages, supportedLanguageCodes } from './languages';

export const LANGUAGE_STORAGE_KEY = 'omni-translate.uiLanguage';
export const WELCOME_DONE_STORAGE_KEY = 'omni-translate.welcomeCompleted';

function mergeLocaleFallback<T extends Record<string, unknown>>(fallback: T, locale: Record<string, unknown>): T {
  const merged: Record<string, unknown> = { ...fallback };

  for (const [key, value] of Object.entries(locale)) {
    const fallbackValue = fallback[key];
    if (
      value &&
      fallbackValue &&
      typeof value === 'object' &&
      typeof fallbackValue === 'object' &&
      !Array.isArray(value) &&
      !Array.isArray(fallbackValue)
    ) {
      merged[key] = mergeLocaleFallback(fallbackValue as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      merged[key] = value;
    }
  }

  return merged as T;
}

function withEnglishFallback(locale: Record<string, unknown>) {
  return mergeLocaleFallback(en, locale);
}

const resources = {
  'zh-CN': { translation: withEnglishFallback(zhCN) },
  en: { translation: en },
} as const;

const localeLoaders: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  ar: () => import('./locales/ar.json'),
  bn: () => import('./locales/bn.json'),
  de: () => import('./locales/de.json'),
  es: () => import('./locales/es.json'),
  fil: () => import('./locales/fil.json'),
  fr: () => import('./locales/fr.json'),
  hi: () => import('./locales/hi.json'),
  id: () => import('./locales/id.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  mr: () => import('./locales/mr.json'),
  pt: () => import('./locales/pt.json'),
  ru: () => import('./locales/ru.json'),
  ta: () => import('./locales/ta.json'),
  te: () => import('./locales/te.json'),
  th: () => import('./locales/th.json'),
  tr: () => import('./locales/tr.json'),
  vi: () => import('./locales/vi.json'),
};

async function ensureLocaleResource(code: string) {
  if (i18n.hasResourceBundle(code, 'translation')) {
    return;
  }

  const loadLocale = localeLoaders[code];
  if (!loadLocale) {
    return;
  }

  const locale = await loadLocale();
  i18n.addResourceBundle(code, 'translation', withEnglishFallback(locale.default), true, true);
}

function readStoredLanguage(): string | null {
  try {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(LANGUAGE_STORAGE_KEY) : null;
    return isSupportedLanguage(stored) ? stored : null;
  } catch {
    return null;
  }
}

function applyDocumentDirection(code: string) {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.setAttribute('lang', code);
  document.documentElement.setAttribute('dir', rtlLanguages.has(code) ? 'rtl' : 'ltr');
}

const initialLanguage = readStoredLanguage() ?? defaultLanguage;
const startupLanguage = initialLanguage in resources ? initialLanguage : defaultLanguage;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    lng: startupLanguage,
    fallbackLng: defaultLanguage,
    supportedLngs: supportedLanguageCodes,
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    returnNull: false,
  });

applyDocumentDirection(startupLanguage);

if (initialLanguage !== startupLanguage) {
  void ensureLocaleResource(initialLanguage).then(() => i18n.changeLanguage(initialLanguage));
}

i18n.on('languageChanged', (code) => {
  applyDocumentDirection(code);
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    /* ignore storage errors (private mode / disabled storage) */
  }
});

export async function setUiLanguage(code: string): Promise<void> {
  if (!isSupportedLanguage(code)) {
    return;
  }
  await ensureLocaleResource(code);
  await i18n.changeLanguage(code);
}

export function getCurrentLanguage(): string {
  const lng = i18n.resolvedLanguage ?? i18n.language ?? defaultLanguage;
  return isSupportedLanguage(lng) ? lng : defaultLanguage;
}

export function hasCompletedWelcome(): boolean {
  try {
    return window.localStorage.getItem(WELCOME_DONE_STORAGE_KEY) === '1';
  } catch {
    return true;
  }
}

export function markWelcomeCompleted(): void {
  try {
    window.localStorage.setItem(WELCOME_DONE_STORAGE_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function resetWelcomeFlag(): void {
  try {
    window.localStorage.removeItem(WELCOME_DONE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export default i18n;
