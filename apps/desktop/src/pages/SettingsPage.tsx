import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import AppIcon from '../components/icons/AppIcon';
import DriverManagementCard from '../components/driver/DriverManagementCard';
import { getCurrentLanguage, resetWelcomeFlag, setUiLanguage } from '../i18n/config';
import { supportedLanguages } from '../i18n/languages';
import { defaultProviderTemplate } from '../defaults/provider-templates';
import { appConfigDraftMock } from '../defaults/app-config';
import type { ProviderDraft } from '../schema/config';
import { useAppStore } from '../stores/app-store';
import { writeCustomProviderTemplates } from '../utils/custom-provider-templates';
import { buildProviderDraftPatchFromTemplate } from '../utils/provider-draft';
import { writeProviderTemplateCatalogPreferences } from '../utils/provider-template-catalog';

const TRANSLATION_CUSTOM_VALUE = '__custom__';
const OUTBOUND_LANGUAGE_AUTO_VALUE = '__auto__';

function SettingsPage() {
  const { t, i18n } = useTranslation();
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [providerResetMessage, setProviderResetMessage] = useState<string | null>(null);
  const [languageError, setLanguageError] = useState<string | null>(null);

  const configDraft = useAppStore((state) => state.configDraft);
  const updateDiagnosticsDraft = useAppStore((state) => state.updateDiagnosticsDraft);
  const updateProviders = useAppStore((state) => state.updateProviders);
  const updateActiveProviderTemplateId = useAppStore((state) => state.updateActiveProviderTemplateId);
  const updateSubtitleDraft = useAppStore((state) => state.updateSubtitleDraft);

  const languages = useMemo(() => supportedLanguages, []);
  const current = i18n.resolvedLanguage ?? getCurrentLanguage();
  const currentMeta = languages.find((item) => item.code === current) ?? languages[0];

  // Shared <option> list for the three language selects below.
  const languageOptions = languages.map((item) => (
    <option key={item.code} value={item.code}>
      {item.nativeName} · {item.englishName}
    </option>
  ));

  const translationPreference = configDraft.subtitles.translationLanguagePreference || current;
  const isCustomPreference = !supportedLanguages.some((item) => item.code === translationPreference);

  const [customInput, setCustomInput] = useState(isCustomPreference ? translationPreference : '');
  const [customPreferenceSelected, setCustomPreferenceSelected] = useState(isCustomPreference);
  const showCustomPreference = customPreferenceSelected || isCustomPreference;

  const handleLanguageChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    const previous = current;
    setLanguageError(null);
    try {
      await setUiLanguage(next);
    } catch (error) {
      try { await setUiLanguage(previous); } catch { /* The previous bundle remains active. */ }
      setLanguageError(t('settings.languageLoadFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const handleTranslationPreferenceChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    if (value === TRANSLATION_CUSTOM_VALUE) {
      setCustomPreferenceSelected(true);
      setCustomInput('');
      updateSubtitleDraft({ translationLanguagePreference: '' });
    } else {
      setCustomPreferenceSelected(false);
      setCustomInput('');
      updateSubtitleDraft({ translationLanguagePreference: value });
    }
  };

  const handleCustomInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setCustomInput(value);
    updateSubtitleDraft({ translationLanguagePreference: value });
  };

  const handleCustomInputBlur = () => {
    if (!customInput.trim()) {
      setCustomPreferenceSelected(false);
      updateSubtitleDraft({ translationLanguagePreference: current });
    }
  };

  const handleOutboundLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    updateSubtitleDraft({ outboundTargetLanguage: value === OUTBOUND_LANGUAGE_AUTO_VALUE ? '' : value });
  };

  const resolveTranslationPreferenceName = (): string => {
    const matched = languages.find((item) => item.code === translationPreference);
    if (matched) {
      return `${matched.nativeName} (${matched.englishName})`;
    }
    return translationPreference;
  };

  const handleResetWelcome = () => {
    resetWelcomeFlag();
    setResetMessage(t('settings.resetWelcomeDone'));
    window.setTimeout(() => setResetMessage(null), 3200);
  };

  const handleResetProviders = () => {
    writeCustomProviderTemplates([]);
    writeProviderTemplateCatalogPreferences([]);
    updateActiveProviderTemplateId(defaultProviderTemplate.id);
    updateProviders([{
      ...buildProviderDraftPatchFromTemplate(appConfigDraftMock.providers[0], defaultProviderTemplate),
      status: 'draft',
    } as ProviderDraft]);
    updateDiagnosticsDraft({ providerStatus: 'draft' });
    setProviderResetMessage(t('settings.resetProvidersDone'));
    window.setTimeout(() => setProviderResetMessage(null), 3200);
  };

  return (
    <section className="settings-workspace">
      <div className="settings-card">
        <div className="settings-card-head">
          <h3>{t('settings.sectionLanguage')}</h3>
          <p>{t('settings.languageHint')}</p>
        </div>

        <div className="settings-card-body">
          <label className="settings-field">
            <span className="settings-field-label">{t('settings.languageLabel')}</span>
            <select className="settings-field-control" value={current} onChange={(event) => void handleLanguageChange(event)}>
              {languageOptions}
            </select>
          </label>

          <p className="settings-field-meta">
            {t('settings.currentLanguage', { name: `${currentMeta.nativeName} (${currentMeta.englishName})` })}
          </p>
          {languageError ? <p className="settings-feedback settings-feedback-error" role="alert">{languageError}</p> : null}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-head">
          <h3>{t('settings.sectionTranslationPreference')}</h3>
          <p>{t('settings.translationPreferenceHint')}</p>
        </div>

        <div className="settings-card-body">
          <label className="settings-field">
            <span className="settings-field-label">{t('settings.translationPreferenceLabel')}</span>
            <select
              className="settings-field-control"
              value={showCustomPreference ? TRANSLATION_CUSTOM_VALUE : translationPreference}
              onChange={handleTranslationPreferenceChange}
            >
              {languageOptions}
              <option value={TRANSLATION_CUSTOM_VALUE}>{t('settings.translationPreferenceCustom')}</option>
            </select>
          </label>

          {showCustomPreference ? (
            <label className="settings-field" style={{ marginTop: 10 }}>
              <input
                className="settings-field-control"
                type="text"
                value={customInput}
                onChange={handleCustomInputChange}
                onBlur={handleCustomInputBlur}
                placeholder={t('settings.translationPreferenceCustomPlaceholder')}
              />
            </label>
          ) : null}

          <p className="settings-field-meta">
            {t('settings.currentTranslationPreference', { name: resolveTranslationPreferenceName() })}
          </p>

          <label className="settings-field" style={{ marginTop: 10 }}>
            <span className="settings-field-label">{t('settings.outboundLanguageLabel')}</span>
            <select
              className="settings-field-control"
              value={configDraft.subtitles.outboundTargetLanguage || OUTBOUND_LANGUAGE_AUTO_VALUE}
              onChange={handleOutboundLanguageChange}
            >
              <option value={OUTBOUND_LANGUAGE_AUTO_VALUE}>{t('settings.outboundLanguageAuto')}</option>
              {languageOptions}
            </select>
          </label>

          <p className="settings-field-meta">{t('settings.outboundLanguageHint')}</p>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-head">
          <h3>{t('settings.sectionOverlay')}</h3>
          <p>{t('settings.overlayHint')}</p>
        </div>

        <div className="settings-card-body settings-card-body-row">
          <Link className="settings-action" to="/settings/overlay-style">
            <AppIcon name="subtitles" size={14} />
            <span style={{ marginInlineStart: 6 }}>{t('settings.overlayAction')}</span>
          </Link>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-head">
          <h3>{t('settings.sectionProviders')}</h3>
          <p>{t('settings.providersHint')}</p>
        </div>

        <div className="settings-card-body settings-card-body-row">
          <Link className="settings-action" to="/settings/providers">
            <AppIcon name="cloud" size={14} />
            <span style={{ marginInlineStart: 6 }}>{t('settings.providersAction')}</span>
          </Link>
          <button type="button" className="settings-action" onClick={handleResetProviders}>
            <AppIcon name="refresh" size={14} />
            <span style={{ marginInlineStart: 6 }}>{t('settings.resetProvidersAction')}</span>
          </button>
          {providerResetMessage ? <span className="settings-inline-feedback">{providerResetMessage}</span> : null}
        </div>
      </div>

      <div className="settings-card settings-card-driver">
        <div className="settings-card-head">
          <h3>{t('settings.sectionDriverManagement')}</h3>
          <p>{t('settings.driverManagementHint')}</p>
        </div>
        <div className="settings-card-body"><DriverManagementCard /></div>
      </div>

      <div className="settings-card settings-card-maintenance">
        <div className="settings-card-head">
          <h3>{t('settings.resetWelcome')}</h3>
          <p>{t('settings.resetWelcomeHint')}</p>
        </div>

        <div className="settings-card-body settings-card-body-row">
          <button type="button" className="settings-action" onClick={handleResetWelcome}>
            {t('settings.resetWelcomeAction')}
          </button>
          {resetMessage ? <span className="settings-inline-feedback">{resetMessage}</span> : null}
        </div>
      </div>
    </section>
  );
}

export default SettingsPage;
