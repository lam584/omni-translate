import i18n, { LANGUAGE_STORAGE_KEY } from './i18n/config';

// The product default is Chinese while jsdom inherits the host browser's
// language. Stabilise it before importing suites so text assertions and
// accessibility labels exercise the shipped default locale.
window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'zh-CN');
await i18n.changeLanguage('zh-CN');
