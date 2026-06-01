/**
 * i18next bootstrap for the Omni Translate desktop shell.
 *
 * This module is side-effectful: importing it initializes i18next and wires
 * up persistent language storage, RTL toggling and fallback behavior.
 *
 * Resource bundles are statically imported so Vite can pre-bundle them for
 * offline desktop use (no runtime fetch required).
 */

import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import ar from './locales/ar.json';
import bn from './locales/bn.json';
import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fil from './locales/fil.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import id from './locales/id.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import mr from './locales/mr.json';
import pt from './locales/pt.json';
import ru from './locales/ru.json';
import ta from './locales/ta.json';
import te from './locales/te.json';
import th from './locales/th.json';
import tr from './locales/tr.json';
import vi from './locales/vi.json';
import zhCN from './locales/zh-CN.json';
import { defaultLanguage, isSupportedLanguage, rtlLanguages } from './languages';

export const LANGUAGE_STORAGE_KEY = 'omni-translate.uiLanguage';
export const WELCOME_DONE_STORAGE_KEY = 'omni-translate.welcomeCompleted';

function withEnglishFallback(locale: Record<string, unknown>) {
  return {
    ...en,
    ...locale,
    welcome: { ...en.welcome, ...(locale.welcome as Record<string, unknown> | undefined) },
  };
}

const resources = {
  'zh-CN': { translation: withEnglishFallback(zhCN) },
  en: { translation: en },
  es: { translation: withEnglishFallback(es) },
  ar: { translation: withEnglishFallback(ar) },
  pt: { translation: withEnglishFallback(pt) },
  ru: { translation: withEnglishFallback(ru) },
  hi: { translation: withEnglishFallback(hi) },
  bn: { translation: withEnglishFallback(bn) },
  de: { translation: withEnglishFallback(de) },
  id: { translation: withEnglishFallback(id) },
  ko: { translation: withEnglishFallback(ko) },
  fr: { translation: withEnglishFallback(fr) },
  vi: { translation: withEnglishFallback(vi) },
  ja: { translation: withEnglishFallback(ja) },
  te: { translation: withEnglishFallback(te) },
  ta: { translation: withEnglishFallback(ta) },
  mr: { translation: withEnglishFallback(mr) },
  th: { translation: withEnglishFallback(th) },
  fil: { translation: withEnglishFallback(fil) },
  tr: { translation: withEnglishFallback(tr) },
} as const;

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

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    lng: initialLanguage,
    fallbackLng: defaultLanguage,
    supportedLngs: Object.keys(resources),
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    returnNull: false,
  });

applyDocumentDirection(initialLanguage);

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
