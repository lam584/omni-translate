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

describe('zh-CN locale', () => {
  it('keeps all locale files on the same key set', () => {
    const expected = flattenKeys(zhCN).sort();

    for (const [code, locale] of Object.entries(locales)) {
      expect(flattenKeys(locale).sort(), code).toEqual(expected);
    }
  });

  it('keeps settings and welcome copy localized', () => {
    expect(zhCN.settings.languageLabel).toBe('显示语言');
    expect(zhCN.settings.sectionLanguage).toBe('界面语言');
    expect(zhCN.settings.resetProvidersAction).toBe('重置所有模型提供商');
    expect(zhCN.settings.resetProvidersDone).toBe('已恢复模型提供商预设。');
    expect(zhCN.settings.resetWelcome).toBe('重置欢迎向导');
    expect(zhCN.welcome.confirm).toBe('使用此语言');
    expect(zhCN.welcome.stepProviderTitle).toBe('模型提供商');
    expect(zhCN.audioRouting.outputDevice).toBe('输出设备');
    expect(zhCN.overlay.hideAction).toBe('隐藏字幕悬浮窗');
  });

  it('does not lock in mojibake or replacement characters', () => {
    const serialized = JSON.stringify(locales);
    expect(serialized).not.toContain('\uFFFD');
    expect(serialized).not.toMatch(/[锛歿鍦烘妯瀷楠鎼]/u);
  });

  it('uses unified peer/microphone terminology in the audio routing page', () => {
    const audioRouting = zhCN.audioRouting as unknown as Record<string, string>;
    expect(audioRouting.chainSystemAudio).toBe('系统/对方声音');
    expect(audioRouting.chainReturnToPeer).toBe('返回对方');
    expect(audioRouting.scenarioInboundSecondaryTitle).toBe('听对方 · 二次字幕译音');
    expect(audioRouting.translationAudioSecondary).toContain('二次字幕译音');
    expect(audioRouting.translationAudioSecondary).not.toContain('副 TTS');
    const serialized = JSON.stringify(zhCN.audioRouting);
    expect(serialized).not.toContain('对端');
  });
});
