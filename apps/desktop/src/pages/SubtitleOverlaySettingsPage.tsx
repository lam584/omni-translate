import { type CSSProperties, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppIcon from '../components/icons/AppIcon';
import PageSectionHeader from '../components/page/PageSectionHeader';
import { toggleSubtitleOverlayWindow } from '../runtime/audio-runtime';
import { useAppStore } from '../stores/app-store';
import { mixOpacity, withAlpha } from '../utils/color-alpha';

const fontOptions = [
  {
    value: '"Segoe UI", "Microsoft YaHei UI", sans-serif',
    label: 'Segoe UI / Microsoft YaHei UI',
  },
  {
    value: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    label: 'Microsoft YaHei',
  },
  {
    value: '"MiSans", "HarmonyOS Sans SC", "Microsoft YaHei UI", sans-serif',
    label: 'MiSans / HarmonyOS Sans SC',
  },
  {
    value: '"Source Han Sans SC", "Noto Sans SC", sans-serif',
    label: 'Source Han Sans SC / Noto Sans SC',
  },
  {
    value: '"PingFang SC", "Microsoft YaHei UI", sans-serif',
    label: 'PingFang SC',
  },
  {
    value: '"Alibaba PuHuiTi 3.0", "Microsoft YaHei UI", sans-serif',
    label: 'Alibaba PuHuiTi 3.0',
  },
  {
    value: '"LXGW WenKai", "KaiTi", serif',
    label: 'LXGW WenKai / KaiTi',
  },
  {
    value: '"Noto Serif SC", "Songti SC", serif',
    label: 'Noto Serif SC / Songti SC',
  },
  {
    value: '"SimSun", "Songti SC", serif',
    label: 'SimSun / Songti SC',
  },
  {
    value: '"Sarasa Gothic SC", "Microsoft YaHei UI", sans-serif',
    label: 'Sarasa Gothic SC',
  },
  {
    value: '"Cascadia Code", "Sarasa Mono SC", monospace',
    label: 'Cascadia Code / Sarasa Mono SC',
  },
];

const OVERLAY_FONT_SIZE_MIN = 16;
const OVERLAY_FONT_SIZE_MAX = 48;
const DEFAULT_OVERLAY_SETTINGS = {
  overlayBackgroundColor: '#111827',
  overlayBackgroundOpacity: 0.84,
  overlayFontFamily: '"Segoe UI", "Microsoft YaHei UI", sans-serif',
  overlayFontSize: 24,
  overlayHeight: 220,
  overlayLocked: false,
  overlayOpacity: 0.88,
  overlayTextColor: '#fff8ef',
  overlayTextOpacity: 1,
  overlayWidth: 960,
  overlayX: 50,
  overlayY: 78,
} as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function SubtitleOverlaySettingsPage() {
  const { t } = useTranslation();
  const subtitles = useAppStore((state) => state.configDraft.subtitles);
  const runtimeSnapshot = useAppStore((state) => state.runtimeSnapshot);
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  const updateSubtitleDraft = useAppStore((state) => state.updateSubtitleDraft);
  const [overlayTogglePending, setOverlayTogglePending] = useState(false);
  const overlayFontSize = clamp(Math.round(subtitles.overlayFontSize || 24), OVERLAY_FONT_SIZE_MIN, OVERLAY_FONT_SIZE_MAX);
  const overlayWindow = runtimeSnapshot.windows.find((item) => item.label === 'subtitle-overlay');
  const previewBackgroundAlpha = mixOpacity(subtitles.overlayOpacity, subtitles.overlayBackgroundOpacity);
  const previewTextAlpha = mixOpacity(subtitles.overlayOpacity, subtitles.overlayTextOpacity);
  const previewStyle = {
    '--subtitle-overlay-background': withAlpha(subtitles.overlayBackgroundColor, previewBackgroundAlpha),
    '--subtitle-overlay-border': withAlpha('#ffffff', 0.12 * previewBackgroundAlpha),
    '--subtitle-overlay-font-family': subtitles.overlayFontFamily,
    '--subtitle-overlay-shadow': withAlpha('#000000', 0.28 * previewBackgroundAlpha),
    '--subtitle-overlay-source-shadow': withAlpha('#000000', 0.48 * subtitles.overlayOpacity),
    '--subtitle-overlay-text': withAlpha(subtitles.overlayTextColor, previewTextAlpha),
    '--subtitle-overlay-translation-opacity': `${Math.max(0.4, previewTextAlpha * 0.92)}`,
    color: withAlpha(subtitles.overlayTextColor, previewTextAlpha),
    fontFamily: 'var(--subtitle-overlay-font-family)',
    fontSize: `${overlayFontSize}px`,
  } as CSSProperties;

  const handleToggleOverlay = async () => {
    setOverlayTogglePending(true);

    try {
      const snapshot = await toggleSubtitleOverlayWindow();
      setRuntimeSnapshot(snapshot);
    } finally {
      setOverlayTogglePending(false);
    }
  };

  return (
    <section className="settings-workspace overlay-settings-workspace">
      <PageSectionHeader
        actions={(
          <div className="settings-page-action-group">
            <button
              className="settings-action settings-action-secondary"
              onClick={() => updateSubtitleDraft(DEFAULT_OVERLAY_SETTINGS)}
              type="button"
            >
              <AppIcon name="refresh" size={14} />
              <span style={{ marginInlineStart: 6 }}>{t('audioRouting.restoreDefaults')}</span>
            </button>
            <button
              className="settings-action settings-action-secondary"
              onClick={() => updateSubtitleDraft({ overlayLocked: !subtitles.overlayLocked })}
              type="button"
            >
              <AppIcon name="lock" size={14} />
              <span style={{ marginInlineStart: 6 }}>
                {subtitles.overlayLocked ? t('settings.overlayLockedState') : t('settings.overlayUnlockedState')}
              </span>
            </button>
            <button
              className="settings-action settings-action-secondary"
              disabled={overlayTogglePending}
              onClick={() => void handleToggleOverlay()}
              type="button"
            >
              <AppIcon name="subtitles" size={14} />
              <span style={{ marginInlineStart: 6 }}>
                {overlayTogglePending
                  ? t('settings.overlayTogglePending')
                  : overlayWindow?.visible
                    ? t('settings.overlayHideSubtitlesAction')
                    : t('settings.overlayShowSubtitlesAction')}
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

      <div className="settings-card">
        <div className="settings-card-head">
          <h3>{t('settings.overlayAppearanceTitle')}</h3>
          <p>{t('settings.overlayAppearanceHint')}</p>
        </div>

        <div className="settings-card-body">
          <label className="settings-field">
            <span className="settings-field-label">{t('settings.overlayOpacityLabel')}</span>
            <div className="settings-slider-row">
              <input
                max="1"
                min="0"
                step="0.05"
                type="range"
                value={subtitles.overlayOpacity}
                onChange={(event) => updateSubtitleDraft({ overlayOpacity: Number(event.target.value) })}
              />
              <span className="settings-slider-value">{Math.round(subtitles.overlayOpacity * 100)}%</span>
            </div>
          </label>

          <label className="settings-field">
            <span className="settings-field-label">{t('settings.overlayFontSizeLabel')}</span>
            <div className="settings-slider-row">
              <input
                max={OVERLAY_FONT_SIZE_MAX}
                min={OVERLAY_FONT_SIZE_MIN}
                step="1"
                type="range"
                value={overlayFontSize}
                onChange={(event) => updateSubtitleDraft({ overlayFontSize: Number(event.target.value) })}
              />
              <span className="settings-slider-value">{overlayFontSize}px</span>
            </div>
          </label>

          <div className="settings-grid-two">
            <label className="settings-field">
              <span className="settings-field-label">{t('settings.overlayTextOpacityLabel')}</span>
              <div className="settings-slider-row">
                <input
                  max="1"
                  min="0"
                  step="0.05"
                  type="range"
                  value={subtitles.overlayTextOpacity}
                  onChange={(event) => updateSubtitleDraft({ overlayTextOpacity: Number(event.target.value) })}
                />
                <span className="settings-slider-value">{Math.round(subtitles.overlayTextOpacity * 100)}%</span>
              </div>
            </label>

            <label className="settings-field">
              <span className="settings-field-label">{t('settings.overlayBackgroundOpacityLabel')}</span>
              <div className="settings-slider-row">
                <input
                  max="1"
                  min="0"
                  step="0.05"
                  type="range"
                  value={subtitles.overlayBackgroundOpacity}
                  onChange={(event) => updateSubtitleDraft({ overlayBackgroundOpacity: Number(event.target.value) })}
                />
                <span className="settings-slider-value">{Math.round(subtitles.overlayBackgroundOpacity * 100)}%</span>
              </div>
            </label>
          </div>

          <div className="settings-grid-two">
            <label className="settings-field">
              <span className="settings-field-label">{t('settings.overlayTextColorLabel')}</span>
              <div className="settings-color-field">
                <input
                  className="settings-color-picker"
                  type="color"
                  value={subtitles.overlayTextColor}
                  onChange={(event) => updateSubtitleDraft({ overlayTextColor: event.target.value })}
                />
                <span className="settings-color-value">{subtitles.overlayTextColor.toUpperCase()}</span>
              </div>
            </label>

            <label className="settings-field">
              <span className="settings-field-label">{t('settings.overlayBackgroundColorLabel')}</span>
              <div className="settings-color-field">
                <input
                  className="settings-color-picker"
                  type="color"
                  value={subtitles.overlayBackgroundColor}
                  onChange={(event) => updateSubtitleDraft({ overlayBackgroundColor: event.target.value })}
                />
                <span className="settings-color-value">{subtitles.overlayBackgroundColor.toUpperCase()}</span>
              </div>
            </label>
          </div>

          <label className="settings-field">
            <span className="settings-field-label">{t('settings.overlayFontLabel')}</span>
            <select
              className="settings-field-control"
              value={subtitles.overlayFontFamily}
              onChange={(event) => updateSubtitleDraft({ overlayFontFamily: event.target.value })}
            >
              {fontOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="settings-card overlay-preview-card">
        <div className="settings-card-head">
          <h3>{t('settings.overlayPreviewTitle')}</h3>
          <p>{t('settings.overlayPreviewHint')}</p>
        </div>

        <div className="overlay-preview-stage">
          <div className="overlay-preview-window subtitle-overlay-lyrics" style={previewStyle}>
            <p className="overlay-preview-source subtitle-overlay-source">{t('settings.overlayPreviewSource')}</p>
            <p className="overlay-preview-translation subtitle-overlay-translation">
              {t('settings.overlayPreviewTranslation')}
            </p>
          </div>
        </div>
      </div>

    </section>
  );
}

export default SubtitleOverlaySettingsPage;
