import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import AppIcon from '../components/icons/AppIcon';
import PageSectionHeader from '../components/page/PageSectionHeader';
import { toggleSubtitleOverlayWindow } from '../runtime/audio-runtime';
import type { SubtitleDraft, SubtitleOverlayTextStyle } from '../schema/config';
import { useAppStore } from '../stores/app-store';
import {
  buildSubtitleOverlayCssVariables,
  DEFAULT_SOURCE_TEXT_STYLE,
  DEFAULT_TRANSLATION_TEXT_STYLE,
  overlayTextEffectPresets,
  type OverlayTextEffectPresetId,
} from './overlay/overlayTypography';
import {
  MAX_OVERLAY_FONT_SIZE,
  MAX_OVERLAY_HEIGHT,
  MIN_OVERLAY_FONT_SIZE,
  MIN_OVERLAY_HEIGHT,
} from './overlay/overlayDomain';

const fontOptions = [
  { value: '"Segoe UI", "Microsoft YaHei UI", sans-serif', label: 'Segoe UI / Microsoft YaHei UI' },
  { value: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif', label: 'Microsoft YaHei' },
  { value: '"MiSans", "HarmonyOS Sans SC", "Microsoft YaHei UI", sans-serif', label: 'MiSans / HarmonyOS Sans SC' },
  { value: '"Source Han Sans SC", "Noto Sans SC", sans-serif', label: 'Source Han Sans SC / Noto Sans SC' },
  { value: '"PingFang SC", "Microsoft YaHei UI", sans-serif', label: 'PingFang SC' },
  { value: '"Alibaba PuHuiTi 3.0", "Microsoft YaHei UI", sans-serif', label: 'Alibaba PuHuiTi 3.0' },
  { value: '"LXGW WenKai", "KaiTi", serif', label: 'LXGW WenKai / KaiTi' },
  { value: '"Noto Serif SC", "Songti SC", serif', label: 'Noto Serif SC / Songti SC' },
  { value: '"SimSun", "Songti SC", serif', label: 'SimSun / Songti SC' },
  { value: '"Sarasa Gothic SC", "Microsoft YaHei UI", sans-serif', label: 'Sarasa Gothic SC' },
  { value: '"Cascadia Code", "Sarasa Mono SC", monospace', label: 'Cascadia Code / Sarasa Mono SC' },
];

const DEFAULT_OVERLAY_SETTINGS: Partial<SubtitleDraft> = {
  overlayBackgroundColor: '#111827',
  overlayBackgroundOpacity: 0.84,
  overlayFontFamily: '"Segoe UI", "Microsoft YaHei UI", sans-serif',
  overlayFontSize: 24,
  overlayHeight: 220,
  overlayLocked: false,
  overlayOpacity: 0.88,
  overlaySourceTextStyle: DEFAULT_SOURCE_TEXT_STYLE,
  overlayTextAlign: 'center',
  overlayTextColor: '#fff8ef',
  overlayTextOpacity: 1,
  overlayTranslationTextStyle: DEFAULT_TRANSLATION_TEXT_STYLE,
  overlayWidth: 960,
  overlayX: 50,
  overlayY: 78,
};

const appearancePresets = [
  { id: 'classic', background: '#111827', backgroundOpacity: 0.84, opacity: 0.88, color: '#fff8ef', effect: 'crisp' },
  { id: 'glass', background: '#0f172a', backgroundOpacity: 0.46, opacity: 0.82, color: '#f8fafc', effect: 'soft' },
  { id: 'contrast', background: '#020617', backgroundOpacity: 0.96, opacity: 1, color: '#fef3c7', effect: 'contrast' },
  { id: 'lyrics', background: '#111827', backgroundOpacity: 0, opacity: 1, color: '#ffffff', effect: 'contrast' },
] as const;

const effectPresetIds: OverlayTextEffectPresetId[] = ['none', 'soft', 'crisp', 'contrast', 'glow'];
const effectStyleKeys = [
  'outlineEnabled', 'outlineColor', 'outlineWidth', 'shadowEnabled', 'shadowColor',
  'shadowOpacity', 'shadowOffsetX', 'shadowOffsetY', 'shadowBlur',
] as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function matchesEffectPreset(style: SubtitleOverlayTextStyle, presetId: OverlayTextEffectPresetId) {
  const preset = overlayTextEffectPresets[presetId];
  return effectStyleKeys.every((key) => style[key] === preset[key]);
}

function SubtitleOverlaySettingsPage() {
  const { t } = useTranslation();
  const subtitles = useAppStore((state) => state.configDraft.subtitles);
  const runtimeSnapshot = useAppStore((state) => state.runtimeSnapshot);
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  const updateSubtitleDraft = useAppStore((state) => state.updateSubtitleDraft);
  const [overlayTogglePending, setOverlayTogglePending] = useState(false);
  const [activeTextRole, setActiveTextRole] = useState<'source' | 'translation'>('translation');
  const [previewScene, setPreviewScene] = useState<'dark' | 'light' | 'scene'>('scene');
  const overlayFontSize = clamp(
    Math.round(subtitles.overlayFontSize || 24),
    MIN_OVERLAY_FONT_SIZE,
    MAX_OVERLAY_FONT_SIZE,
  );
  const overlayHeight = clamp(
    Math.round(subtitles.overlayHeight || 220),
    MIN_OVERLAY_HEIGHT,
    MAX_OVERLAY_HEIGHT,
  );
  const overlayWindow = runtimeSnapshot.windows.find((item) => item.label === 'subtitle-overlay');
  const activeStyle = activeTextRole === 'source' ? subtitles.overlaySourceTextStyle : subtitles.overlayTranslationTextStyle;
  const activeStyleKey = activeTextRole === 'source' ? 'overlaySourceTextStyle' : 'overlayTranslationTextStyle';
  const previewStyle = {
    ...buildSubtitleOverlayCssVariables(subtitles),
    fontFamily: 'var(--subtitle-overlay-font-family)',
    fontSize: `${overlayFontSize}px`,
  };

  const updateActiveTextStyle = (patch: Partial<SubtitleOverlayTextStyle>) => {
    const nextStyle = { ...activeStyle, ...patch };
    updateSubtitleDraft({
      [activeStyleKey]: nextStyle,
      ...(activeTextRole === 'translation' && patch.color ? { overlayTextColor: patch.color } : {}),
    });
  };

  const applyEffectPreset = (presetId: OverlayTextEffectPresetId) => {
    updateActiveTextStyle(overlayTextEffectPresets[presetId]);
  };

  const applyAppearancePreset = (preset: typeof appearancePresets[number]) => {
    const effect = overlayTextEffectPresets[preset.effect];
    updateSubtitleDraft({
      overlayBackgroundColor: preset.background,
      overlayBackgroundOpacity: preset.backgroundOpacity,
      overlayOpacity: preset.opacity,
      overlayTextColor: preset.color,
      overlaySourceTextStyle: { ...subtitles.overlaySourceTextStyle, ...effect, color: preset.color },
      overlayTranslationTextStyle: { ...subtitles.overlayTranslationTextStyle, ...effect, color: preset.color },
    });
  };

  const copyActiveStyleToBoth = () => {
    updateSubtitleDraft({
      overlayTextColor: activeStyle.color,
      overlaySourceTextStyle: { ...activeStyle },
      overlayTranslationTextStyle: { ...activeStyle },
    });
  };

  const handleToggleOverlay = async () => {
    setOverlayTogglePending(true);
    try {
      setRuntimeSnapshot(await toggleSubtitleOverlayWindow());
    } finally {
      setOverlayTogglePending(false);
    }
  };

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    suffix: string,
    onChange: (value: number) => void,
  ) => (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      <div className="settings-slider-row">
        <input max={max} min={min} step={step} type="range" value={value}
          onChange={(event) => onChange(Number(event.target.value))} />
        <span className="settings-slider-value">{value}{suffix}</span>
      </div>
    </label>
  );

  return (
    <section className="settings-workspace overlay-settings-workspace">
      <PageSectionHeader
        actions={(
          <div className="settings-page-action-group">
            <button className="settings-action settings-action-secondary"
              onClick={() => updateSubtitleDraft(DEFAULT_OVERLAY_SETTINGS)} type="button">
              <AppIcon name="refresh" size={14} />
              <span style={{ marginInlineStart: 6 }}>{t('audioRouting.restoreDefaults')}</span>
            </button>
            <button className="settings-action settings-action-secondary"
              onClick={() => updateSubtitleDraft({ overlayLocked: !subtitles.overlayLocked })} type="button">
              <AppIcon name="lock" size={14} />
              <span style={{ marginInlineStart: 6 }}>
                {subtitles.overlayLocked ? t('settings.overlayLockedState') : t('settings.overlayUnlockedState')}
              </span>
            </button>
            <button className="settings-action settings-action-secondary" disabled={overlayTogglePending}
              onClick={() => void handleToggleOverlay()} type="button">
              <AppIcon name="subtitles" size={14} />
              <span style={{ marginInlineStart: 6 }}>
                {overlayTogglePending ? t('settings.overlayTogglePending') : overlayWindow?.visible
                  ? t('settings.overlayHideSubtitlesAction') : t('settings.overlayShowSubtitlesAction')}
              </span>
            </button>
            <Link className="settings-action settings-action-secondary" to="/settings">
              <AppIcon name="wrench" size={14} />
              <span style={{ marginInlineStart: 6 }}>{t('settings.backToSettings')}</span>
            </Link>
          </div>
        )}
        className="settings-page-head settings-page-head-actions"
      />

      <div className="overlay-settings-main">
        <div className="overlay-settings-controls">
          <div className="settings-card">
            <div className="settings-card-head">
              <h3>{t('settings.overlayPresetTitle')}</h3>
              <p>{t('settings.overlayPresetHint')}</p>
            </div>
            <div className="settings-card-body overlay-preset-grid">
              {appearancePresets.map((preset) => (
                <button aria-pressed={subtitles.overlayBackgroundColor.toLowerCase() === preset.background
                  && subtitles.overlayBackgroundOpacity === preset.backgroundOpacity
                  && subtitles.overlayOpacity === preset.opacity
                  && subtitles.overlaySourceTextStyle.color.toLowerCase() === preset.color
                  && subtitles.overlayTranslationTextStyle.color.toLowerCase() === preset.color
                  && matchesEffectPreset(subtitles.overlaySourceTextStyle, preset.effect)
                  && matchesEffectPreset(subtitles.overlayTranslationTextStyle, preset.effect)}
                  className="overlay-choice-button" key={preset.id}
                  onClick={() => applyAppearancePreset(preset)} type="button">
                  <span className={`overlay-choice-swatch overlay-choice-swatch-${preset.id}`} />
                  {t(`settings.overlayPreset.${preset.id}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-card">
            <div className="settings-card-head">
              <h3>{t('settings.overlayTypographyTitle')}</h3>
              <p>{t('settings.overlayTypographyHint')}</p>
            </div>
            <div className="settings-card-body">
              <label className="settings-field">
                <span className="settings-field-label">{t('settings.overlayFontLabel')}</span>
                <select className="settings-field-control" value={subtitles.overlayFontFamily}
                  onChange={(event) => updateSubtitleDraft({ overlayFontFamily: event.target.value })}>
                  {fontOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              {slider(t('settings.overlayFontSizeLabel'), overlayFontSize, MIN_OVERLAY_FONT_SIZE,
                MAX_OVERLAY_FONT_SIZE, 1, 'px', (value) => updateSubtitleDraft({ overlayFontSize: value }))}
              {slider(t('settings.overlayHeightLabel', { defaultValue: '悬浮窗高度' }), overlayHeight,
                MIN_OVERLAY_HEIGHT, MAX_OVERLAY_HEIGHT, 4, 'px',
                (value) => updateSubtitleDraft({ overlayHeight: value }))}
              {slider(t('settings.overlayTextOpacityLabel'), Math.round(subtitles.overlayTextOpacity * 100),
                0, 100, 1, '%', (value) => updateSubtitleDraft({ overlayTextOpacity: value / 100 }))}
              <div className="settings-field">
                <span className="settings-field-label">{t('settings.overlayAlignLabel')}</span>
                <div className="overlay-segmented-control">
                  {(['left', 'center', 'right'] as const).map((align) => (
                    <button aria-pressed={subtitles.overlayTextAlign === align} key={align}
                      onClick={() => updateSubtitleDraft({ overlayTextAlign: align })} type="button">
                      {t(`settings.overlayAlign.${align}`)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="settings-card">
            <div className="settings-card-head overlay-card-head-actions">
              <div>
                <h3>{t('settings.overlayTextEffectsTitle')}</h3>
                <p>{t('settings.overlayTextEffectsHint')}</p>
              </div>
              <button className="settings-action settings-action-secondary" onClick={copyActiveStyleToBoth} type="button">
                {t('settings.overlayApplyBoth')}
              </button>
            </div>
            <div className="settings-card-body">
              <div className="overlay-text-role-tabs" role="tablist">
                <span className="sr-only">{t('settings.overlayTextEffectsTitle')}</span>
                {(['source', 'translation'] as const).map((role) => (
                  <button aria-selected={activeTextRole === role} key={role}
                    onClick={() => setActiveTextRole(role)} role="tab" type="button">
                    {t(`settings.overlayTextRole.${role}`)}
                  </button>
                ))}
              </div>
              <div className="overlay-effect-preset-grid">
                {effectPresetIds.map((presetId) => (
                  <button aria-pressed={matchesEffectPreset(activeStyle, presetId)} key={presetId}
                    onClick={() => applyEffectPreset(presetId)} type="button">
                    <span className={`overlay-effect-sample overlay-effect-sample-${presetId}`}>Aa</span>
                    {t(`settings.overlayEffectPreset.${presetId}`)}
                  </button>
                ))}
              </div>
              <div className="settings-grid-two">
                <label className="settings-field">
                  <span className="settings-field-label">{t('settings.overlayTextColorLabel')}</span>
                  <div className="settings-color-field">
                    <input className="settings-color-picker" type="color" value={activeStyle.color}
                      onChange={(event) => updateActiveTextStyle({ color: event.target.value })} />
                    <span className="settings-color-value">{activeStyle.color.toUpperCase()}</span>
                  </div>
                </label>
                <label className="settings-field">
                  <span className="settings-field-label">{t('settings.overlayFontWeightLabel')}</span>
                  <select className="settings-field-control" value={activeStyle.fontWeight}
                    onChange={(event) => updateActiveTextStyle({ fontWeight: Number(event.target.value) as SubtitleOverlayTextStyle['fontWeight'] })}>
                    {[400, 500, 600, 700].map((weight) => <option key={weight} value={weight}>{t(`settings.overlayFontWeight.${weight}`)}</option>)}
                  </select>
                </label>
              </div>

              <div className="overlay-effect-section">
                <label className="overlay-switch-row">
                  <span>{t('settings.overlayOutlineTitle')}</span>
                  <input checked={activeStyle.outlineEnabled} type="checkbox"
                    onChange={(event) => updateActiveTextStyle({ outlineEnabled: event.target.checked })} />
                </label>
                <div className="settings-grid-two">
                  <label className="settings-field">
                    <span className="settings-field-label">{t('settings.overlayEffectColorLabel')}</span>
                    <div className="settings-color-field">
                      <input className="settings-color-picker" type="color" value={activeStyle.outlineColor}
                        onChange={(event) => updateActiveTextStyle({ outlineColor: event.target.value })} />
                      <span className="settings-color-value">{activeStyle.outlineColor.toUpperCase()}</span>
                    </div>
                  </label>
                  {slider(t('settings.overlayOutlineWidthLabel'), activeStyle.outlineWidth, 0.5, 4, 0.5, 'px',
                    (value) => updateActiveTextStyle({ outlineWidth: value }))}
                </div>
              </div>

              <div className="overlay-effect-section">
                <label className="overlay-switch-row">
                  <span>{t('settings.overlayShadowTitle')}</span>
                  <input checked={activeStyle.shadowEnabled} type="checkbox"
                    onChange={(event) => updateActiveTextStyle({ shadowEnabled: event.target.checked })} />
                </label>
                <div className="settings-grid-two">
                  <label className="settings-field">
                    <span className="settings-field-label">{t('settings.overlayEffectColorLabel')}</span>
                    <div className="settings-color-field">
                      <input className="settings-color-picker" type="color" value={activeStyle.shadowColor}
                        onChange={(event) => updateActiveTextStyle({ shadowColor: event.target.value })} />
                      <span className="settings-color-value">{activeStyle.shadowColor.toUpperCase()}</span>
                    </div>
                  </label>
                  {slider(t('settings.overlayShadowOpacityLabel'), Math.round(activeStyle.shadowOpacity * 100),
                    0, 100, 5, '%', (value) => updateActiveTextStyle({ shadowOpacity: value / 100 }))}
                  {slider(t('settings.overlayShadowXLabel'), activeStyle.shadowOffsetX, -10, 10, 1, 'px',
                    (value) => updateActiveTextStyle({ shadowOffsetX: value }))}
                  {slider(t('settings.overlayShadowYLabel'), activeStyle.shadowOffsetY, -10, 10, 1, 'px',
                    (value) => updateActiveTextStyle({ shadowOffsetY: value }))}
                  {slider(t('settings.overlayShadowBlurLabel'), activeStyle.shadowBlur, 0, 24, 1, 'px',
                    (value) => updateActiveTextStyle({ shadowBlur: value }))}
                </div>
              </div>
            </div>
          </div>

          <div className="settings-card">
            <div className="settings-card-head">
              <h3>{t('settings.overlayBackgroundTitle')}</h3>
              <p>{t('settings.overlayAppearanceHint')}</p>
            </div>
            <div className="settings-card-body">
              {slider(t('settings.overlayOpacityLabel'), Math.round(subtitles.overlayOpacity * 100), 0, 100, 1, '%',
                (value) => updateSubtitleDraft({ overlayOpacity: value / 100 }))}
              {slider(t('settings.overlayBackgroundOpacityLabel'), Math.round(subtitles.overlayBackgroundOpacity * 100),
                0, 100, 1, '%', (value) => updateSubtitleDraft({ overlayBackgroundOpacity: value / 100 }))}
              <label className="settings-field">
                <span className="settings-field-label">{t('settings.overlayBackgroundColorLabel')}</span>
                <div className="settings-color-field">
                  <input className="settings-color-picker" type="color" value={subtitles.overlayBackgroundColor}
                    onChange={(event) => updateSubtitleDraft({ overlayBackgroundColor: event.target.value })} />
                  <span className="settings-color-value">{subtitles.overlayBackgroundColor.toUpperCase()}</span>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div className="settings-card overlay-preview-card">
          <div className="settings-card-head">
            <h3>{t('settings.overlayPreviewTitle')}</h3>
            <p>{t('settings.overlayPreviewHint')}</p>
            <div className="overlay-preview-scene-tabs">
              {(['dark', 'light', 'scene'] as const).map((scene) => (
                <button aria-pressed={previewScene === scene} key={scene}
                  onClick={() => setPreviewScene(scene)} type="button">
                  {t(`settings.overlayPreviewScene.${scene}`)}
                </button>
              ))}
            </div>
          </div>
          <div className={`overlay-preview-stage overlay-preview-stage-${previewScene}`}>
            <div className="overlay-preview-window subtitle-overlay-lyrics" style={previewStyle}>
              <p className="overlay-preview-source subtitle-overlay-source">{t('settings.overlayPreviewSource')}</p>
              <p className="overlay-preview-translation subtitle-overlay-translation">{t('settings.overlayPreviewTranslation')}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default SubtitleOverlaySettingsPage;
