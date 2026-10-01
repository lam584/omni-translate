import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { supportedLanguages } from './languages';

const localeCss = readFileSync('src/styles/global/language-fonts.css', 'utf8');
const faceCss = readFileSync('src/assets/fonts/fonts.css', 'utf8');

const leadingFace: Record<string, string> = {
  'zh-CN': 'Noto Sans SC', en: 'Noto Sans', es: 'Noto Sans', ar: 'Noto Sans Arabic',
  pt: 'Noto Sans', ru: 'Noto Sans', hi: 'Noto Sans Devanagari', bn: 'Noto Sans Bengali',
  de: 'Noto Sans', id: 'Noto Sans', ko: 'Noto Sans KR', fr: 'Noto Sans',
  vi: 'Noto Sans', ja: 'Noto Sans JP', te: 'Noto Sans Telugu', ta: 'Noto Sans Tamil',
  mr: 'Noto Sans Devanagari', th: 'Noto Sans Thai', fil: 'Noto Sans', tr: 'Noto Sans',
};

describe('offline language fonts', () => {
  it('selects a bundled leading face for every supported display language', () => {
    expect(Object.keys(leadingFace).sort()).toEqual(supportedLanguages.map(({ code }) => code).sort());
    for (const { code } of supportedLanguages) {
      expect(localeCss).toContain(`[lang="${code}"]`);
      expect(faceCss).toContain(`font-family: '${leadingFace[code]}';`);
    }
    for (const match of faceCss.matchAll(/url\('\.\/(.+?\.ttf)'\)/g)) {
      expect(readFileSync(`src/assets/fonts/${match[1]}`, 'utf8').length).toBeGreaterThan(0);
    }
  });

  it('keeps dense-script text legible across compact directories, tags, and reports', () => {
    const css = readFileSync('src/styles/global/text-legibility.css', 'utf8');
    const deferred = readFileSync('src/styles/deferred.css', 'utf8');
    expect(deferred.trimEnd().endsWith("@import './global/text-legibility.css';")).toBe(true);
    for (const selector of [
      '.provider-directory-item-compact .provider-directory-item-copy strong',
      '.provider-directory-item-state', '.scenario-card-tag', '.chain-flow-direction',
      '.routing-workspace-v9 .routing-panel-kicker', '.diagnostics-kicker',
      '.diagnostics-export-scope', '.diagnostics-primary-issue span',
      '.audio-mode-help-tag', '.audio-level-meter-vad', '.status-badge',
      '.realtime-session-page .audio-route-status-group h4', '.glossary-table th',
    ]) {
      expect(css).toContain(selector);
    }
    expect(css).toContain('font-size: max(.96rem, 15px)');
    expect(css).toContain('font-weight: 500');
  });});