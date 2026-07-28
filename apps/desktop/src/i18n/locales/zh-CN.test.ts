import { describe, expect, it } from 'vitest';
import ar from './ar.json';
import bn from './bn.json';
import de from './de.json';
import en from './en.json';
import es from './es.json';
import fil from './fil.json';
import fr from './fr.json';
import hi from './hi.json';
import id from './id.json';
import ja from './ja.json';
import ko from './ko.json';
import mr from './mr.json';
import pt from './pt.json';
import ru from './ru.json';
import ta from './ta.json';
import te from './te.json';
import th from './th.json';
import tr from './tr.json';
import vi from './vi.json';
import zhCN from './zh-CN.json';

const locales = {
  ar,
  bn,
  de,
  en,
  es,
  fil,
  fr,
  hi,
  id,
  ja,
  ko,
  mr,
  pt,
  ru,
  ta,
  te,
  th,
  tr,
  vi,
  'zh-CN': zhCN,
};

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function readPath(value: typeof en, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (current, key) => (current as Record<string, unknown>)[key],
    value,
  );
}

describe('zh-CN locale', () => {
  it('keeps all locale files on the same key set', () => {
    const expected = flattenKeys(zhCN).sort();

    for (const [code, locale] of Object.entries(locales)) {
      expect(flattenKeys(locale).sort(), code).toEqual(expected);
    }
  });

  it('explains both virtual-driver fallback choices and the AEC risk', () => {
    const semanticMarkers: Record<string, RegExp[]> = {
      ja: [/OK/, /キャンセル/, /字幕/, /AEC/, /危険/],
      ko: [/확인/, /취소/, /자막/, /AEC/, /위험/],
      th: [/ตกลง/, /ยกเลิก/, /คำบรรยาย/, /AEC/, /ความเสี่ยง/],
    };
    for (const [code, markers] of Object.entries(semanticMarkers)) {
      const message = (locales[code as keyof typeof locales] as typeof en).session.virtualDriverFallbackConfirm;
      for (const marker of markers) expect(message, `${code}: ${marker}`).toMatch(marker);
    }
  });

  it('keeps settings and welcome copy present and written in Chinese', () => {
    // Key existence + "actually Chinese" semantic check instead of exact copy
    // equality: wording is allowed to evolve, missing/untranslated keys are not.
    const requiredChinesePaths = [
      'settings.languageLabel',
      'settings.sectionLanguage',
      'settings.resetProvidersAction',
      'settings.resetProvidersDone',
      'settings.resetWelcome',
      'welcome.confirm',
      'welcome.stepProviderTitle',
      'audioRouting.outputDevice',
      'overlay.hideAction',
    ];
    for (const path of requiredChinesePaths) {
      const value = readPath(zhCN as unknown as typeof en, path);
      expect(typeof value, path).toBe('string');
      expect(value as string, path).toMatch(/\p{Script=Han}/u);
      expect(value, path).not.toBe(readPath(en, path));
    }
  });

  it('localizes user-facing runtime failures and glossary conflict consequences', () => {
    const nonEnglishLocales = Object.entries(locales).filter(([code]) => code !== 'en');
    const requiredPaths = [
      'runtime.desktop.rustCoreFailed',
      'runtime.bridge.timeoutError',
      'runtime.provider.timeoutError',
      'sceneReadiness.runtimeErrorBlocker',
      'session.stopStepFailed',
      'session.watchFallbackFailed',
      'session.attribution.commandRejectedReason',
      'glossary.conflictResolution.overwriteHint',
      'glossary.conflictResolution.skipHint',
      'glossary.conflictResolution.keep-allHint',
    ];

    for (const [code, locale] of nonEnglishLocales) {
      for (const path of requiredPaths) {
        expect(readPath(locale as typeof en, path), `${code}: ${path}`).not.toBe(readPath(en, path));
      }
    }
  });

  it('does not lock in mojibake or replacement characters', () => {
    const serialized = JSON.stringify(locales);
    expect(serialized).not.toContain('\uFFFD');
    expect(serialized).not.toMatch(/[锛歿鍦烘妯瀷楠鎼]/u);
  });

  it('uses unified peer/microphone terminology in the audio routing page', () => {
    const audioRouting = zhCN.audioRouting as unknown as Record<string, string>;
    // Terminology contract, not copy freeze: the chain labels must speak of
    // “对方” and the secondary card must say “二次”, but exact wording may evolve.
    expect(audioRouting.chainSystemAudio).toContain('对方');
    expect(audioRouting.chainReturnToPeer).toContain('对方');
    expect(audioRouting.scenarioInboundSecondaryTitle).toContain('二次');
    expect(audioRouting.translationAudioSecondary).toContain('二次字幕译音');
    expect(audioRouting.translationAudioSecondary).not.toContain('副 TTS');
    const serialized = JSON.stringify(zhCN.audioRouting);
    expect(serialized).not.toContain('对端');
  });
});
