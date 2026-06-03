import { describe, expect, it } from 'vitest';
import zhCN from './zh-CN.json';

describe('zh-CN locale', () => {
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

  it('uses unified peer/microphone terminology in the audio routing page', () => {
    const audioRouting = zhCN.audioRouting as Record<string, string>;
    expect(audioRouting.chainSystemAudio).toBe('系统/对方声音');
    expect(audioRouting.chainReturnToPeer).toBe('返回对方');
    expect(audioRouting.scenarioInboundSecondaryTitle).toBe('听对方 · 副翻译音频');
    expect(audioRouting.translationAudioSecondary).toContain('副翻译音频');
    expect(audioRouting.translationAudioSecondary).not.toContain('副 TTS');
    const serialized = JSON.stringify(audioRouting);
    expect(serialized).not.toContain('对端');
  });
});
