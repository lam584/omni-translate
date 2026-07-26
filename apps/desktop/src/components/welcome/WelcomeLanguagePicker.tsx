import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon from '../icons/AppIcon';
import DriverManagementCard from '../driver/DriverManagementCard';
import { supportedLanguages } from '../../i18n/languages';
import { markWelcomeCompleted, setUiLanguage } from '../../i18n/config';
import { defaultProviderTemplate, providerTemplates } from '../../defaults/provider-templates';
import { readProviderSecret, runProviderProbe, saveProviderSecret } from '../../runtime/provider-runtime';
import { resolveRuntimeBridgeStatus } from '../../runtime/runtime-status';
import { useDesktopCapabilities } from '../../runtime/desktop-api-context';
import { refreshBridgeRuntime } from '../../runtime/bridge-runtime';
import { useAppStore } from '../../stores/app-store';
import {
  buildProviderDraftPatchFromTemplate,
  buildProviderVerificationPatch,
} from '../../utils/provider-draft';

type WelcomeLanguagePickerProps = {
  initialLanguage: string;
  onDone: () => void;
};

type WizardStep = 'language' | 'provider' | 'driver';

function formatProviderSetupError(error: unknown, translate: (key: string) => string) {
  const code =
    typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  const operation =
    typeof error === 'object' && error && 'operation' in error ? String((error as { operation?: unknown }).operation ?? '') : '';

  if (code === 'timeout') {
    return operation === 'credential-save' ? translate('welcome.apiKeySaveInvokeTimeout') : translate('welcome.apiKeyProbeTimeout');
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error) {
    return error;
  }

  return translate('welcome.apiKeyProbeFailed');
}

/**
 * First-run quick setup wizard: guides users through interface language
 * selection and a minimal provider/API key setup before entering the app.
 * i18next is live-switched as the user picks a language, so the whole
 * wizard chrome reflects the choice immediately.
 */
function WelcomeLanguagePicker({ initialLanguage, onDone }: WelcomeLanguagePickerProps) {
  const { hasNativeShell } = useDesktopCapabilities();
  const { t } = useTranslation();
  const configDraft = useAppStore((state) => state.configDraft);
  const runtimeSnapshot = useAppStore((state) => state.runtimeSnapshot);
  const runtimeNotifications = useAppStore((state) => state.runtimeNotifications);
  const updateActiveProviderDraft = useAppStore((state) => state.updateActiveProviderDraft);
  const updateDiagnosticsDraft = useAppStore((state) => state.updateDiagnosticsDraft);
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  const [step, setStep] = useState<WizardStep>('language');
  const [selected, setSelected] = useState<string>(initialLanguage);

  const languages = useMemo(() => supportedLanguages, []);
  const templates = useMemo(() => providerTemplates, []);

  const [templateId, setTemplateId] = useState<string>(defaultProviderTemplate.id);
  const [apiBaseUrl, setApiBaseUrl] = useState<string>(defaultProviderTemplate.defaultDraft.baseUrl);
  const [apiKey, setApiKey] = useState<string>('');
  const [apiKeyVisible, setApiKeyVisible] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [revealing, setRevealing] = useState<boolean>(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const selectedLanguageRef = useRef<HTMLButtonElement>(null);
  const providerSelectRef = useRef<HTMLSelectElement>(null);
  const driverHeadingRef = useRef<HTMLHeadingElement>(null);
  const effectiveBridgeStatus = resolveRuntimeBridgeStatus(runtimeSnapshot);

  const currentTemplate = templates.find((item) => item.id === templateId) ?? defaultProviderTemplate;
  const isLanguageStep = step === 'language';
  const isDriverStep = step === 'driver';
  const providerRuntimePreparing =
    hasNativeShell && (effectiveBridgeStatus !== 'tauri-shell' || runtimeSnapshot.storage.status !== 'ready');
  const providerSaveDisabled = saving || revealing || providerRuntimePreparing;
  const latestRuntimeError = runtimeNotifications.find((item) => item.level === 'error');
  const providerRuntimeStatusMessage =
    effectiveBridgeStatus === 'runtime-error'
      ? latestRuntimeError?.message ??
        t('welcome.desktopRuntimeUnavailable')
      : providerRuntimePreparing
        ? t('welcome.desktopRuntimePreparing')
        : null;

  useEffect(() => {
    const target = isLanguageStep
      ? selectedLanguageRef.current
      : isDriverStep
        ? driverHeadingRef.current
        : providerSelectRef.current;
    target?.focus();
  }, [isDriverStep, isLanguageStep, step]);

  useEffect(() => {
    queueMicrotask(() => setApiBaseUrl(currentTemplate.defaultDraft.baseUrl));
  }, [currentTemplate]);

  useEffect(() => {
    if (!isDriverStep) {
      return;
    }

    let active = true;

    void refreshBridgeRuntime()
      .then((snapshot) => {
        if (active) {
          setRuntimeSnapshot(snapshot);
        }
      })
      .catch((err) => {
        if (active) {
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      active = false;
    };
  }, [isDriverStep, setRuntimeSnapshot]);

  const handleSelect = async (code: string) => {
    setSelected(code);
    await setUiLanguage(code);
  };

  const finishWizard = () => {
    markWelcomeCompleted();
    onDone();
  };

  const handleNext = () => {
    setErrorMessage(null);
    setSavedMessage(null);
    setStep('provider');
  };

  const handleBack = () => {
    setErrorMessage(null);
    setSavedMessage(null);

    if (isDriverStep) {
      setStep('provider');
      return;
    }

    setStep('language');
  };

  const handleApiKeyVisibilityToggle = async () => {
    if (apiKeyVisible) {
      setApiKeyVisible(false);
      return;
    }

    if (apiKey) {
      setApiKeyVisible(true);
      return;
    }

    setRevealing(true);
    setSavedMessage(null);
    setErrorMessage(null);

    try {
      const payload = await readProviderSecret(currentTemplate.defaultDraft.auth.reference);

      if (!payload.secret) {
        setErrorMessage(t('welcome.apiKeyRevealEmpty'));
        return;
      }

      setApiKey(payload.secret);
      setApiKeyVisible(true);
      setSavedMessage(t('welcome.apiKeyRevealSuccess'));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRevealing(false);
    }
  };

  const handleSaveAndContinue = async () => {
    const trimmedApiKey = apiKey.trim();
    const trimmedBaseUrl = apiBaseUrl.trim() || currentTemplate.defaultDraft.baseUrl;
    if (!trimmedApiKey) {
      // Empty API key skips only provider setup. Driver readiness is still a
      // required first-run check and must remain visible to new users.
      setStep('driver');
      return;
    }

    setSaving(true);
    setErrorMessage(null);
    setSavedMessage(null);
    try {
      const activeProvider = configDraft.providers.find((p) => p.templateId === configDraft.activeProviderTemplateId) ?? configDraft.providers[0];
      if (!activeProvider) return;
      const providerPatch = buildProviderDraftPatchFromTemplate(activeProvider, currentTemplate);
      const nextProvider = {
        ...activeProvider,
        ...providerPatch,
        baseUrl: trimmedBaseUrl,
      };

      await saveProviderSecret(nextProvider.authRef.reference, trimmedApiKey);

      updateActiveProviderDraft({ ...providerPatch, baseUrl: trimmedBaseUrl, model: currentTemplate.defaultDraft.model });
      updateDiagnosticsDraft({ providerStatus: 'draft' });

      if (nextProvider.kind === 'dashscope' && nextProvider.transport === 'websocket') {
        setSavedMessage(t('welcome.apiKeySavedDeferred'));
        setStep('driver');
        return;
      }

      setSavedMessage(t('welcome.apiKeySaved'));
      setStep('driver');

      void runProviderProbe(nextProvider)
        .then((probeResult) => {
          const verificationPatch = buildProviderVerificationPatch(probeResult);
          updateActiveProviderDraft(verificationPatch);
          updateDiagnosticsDraft({ providerStatus: verificationPatch.status });

          if (probeResult.verdict === 'unavailable') {
            const detail = probeResult.error?.message?.trim();
            setErrorMessage(detail ? `${t('welcome.apiKeyProbeFailed')} ${detail}` : t('welcome.apiKeyProbeFailed'));
          }
        })
        .catch((err) => {
          updateActiveProviderDraft({ status: 'warning' });
          updateDiagnosticsDraft({ providerStatus: 'warning' });
          setErrorMessage(formatProviderSetupError(err, (key) => t(key)));
        });

      return;
    } catch (err) {
      setErrorMessage(formatProviderSetupError(err, (key) => t(key)));
    } finally {
      setSaving(false);
    }
  };

  const handleSkipProvider = () => {
    setStep('driver');
  };

  return (
    <div className="welcome-language-overlay" role="dialog" aria-modal="true" aria-labelledby="welcome-language-title">
      <div className="welcome-language-card">
        <header className="welcome-language-head">
          <p className="welcome-language-kicker">{t('common.appName')}</p>
          <h1 id="welcome-language-title">{t('welcome.title')}</h1>
          <p className="welcome-language-sub">{t('welcome.subtitle')}</p>
          <div className="welcome-step-indicator" aria-hidden="true">
            <span className={isLanguageStep ? 'welcome-step-dot welcome-step-dot-active' : 'welcome-step-dot'} />
            <span>{t('welcome.stepLanguageTitle')}</span>
            <span>›</span>
            <span className={step === 'provider' ? 'welcome-step-dot welcome-step-dot-active' : 'welcome-step-dot'} />
            <span>{t('welcome.stepProviderTitle')}</span>
            <span>›</span>
            <span className={isDriverStep ? 'welcome-step-dot welcome-step-dot-active' : 'welcome-step-dot'} />
            <span>{t('welcome.stepDriverTitle')}</span>
          </div>
        </header>

        <div className="welcome-language-body">
          {isLanguageStep ? (
            <ul className="welcome-language-list" role="listbox" aria-label={t('common.language')}>
              {languages.map((item) => {
                const isActive = item.code === selected;
                return (
                  <li key={item.code}>
                    <button
                      ref={isActive ? selectedLanguageRef : undefined}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={isActive ? 'welcome-language-item welcome-language-item-active' : 'welcome-language-item'}
                      onClick={() => {
                        void handleSelect(item.code);
                      }}
                    >
                      <span className="welcome-language-native">{item.nativeName}</span>
                      <span className="welcome-language-english">{item.englishName}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : step === 'provider' ? (
            <div className="welcome-provider-form">
              <h2 className="welcome-step-title">{t('welcome.stepProviderTitle')}</h2>
              <p className="welcome-step-description">{t('welcome.stepProviderDescription')}</p>

              <label className="welcome-provider-field">
                <span>{t('welcome.providerLabel')}</span>
                <select
                  ref={providerSelectRef}
                  value={templateId}
                  onChange={(event) => {
                    setTemplateId(event.target.value);
                    setApiKey('');
                    setApiKeyVisible(false);
                    setSavedMessage(null);
                    setErrorMessage(null);
                  }}
                >
                  {templates.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
                </select>
              </label>

              <label className="welcome-provider-field">
                <span>{t('welcome.apiBaseUrlLabel')}</span>
                <input
                  type="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={currentTemplate.defaultDraft.baseUrl}
                  value={apiBaseUrl}
                  onChange={(event) => {
                    setApiBaseUrl(event.target.value);
                    setSavedMessage(null);
                    setErrorMessage(null);
                  }}
                />
              </label>

              <label className="welcome-provider-field">
                <span>{t('welcome.apiKeyLabel')}</span>
                <div className="welcome-secret-inline">
                  <input
                    type={apiKeyVisible ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('welcome.apiKeyPlaceholder')}
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setSavedMessage(null);
                      setErrorMessage(null);
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button welcome-secret-toggle"
                    aria-label={apiKeyVisible ? t('welcome.hideApiKey') : t('welcome.showApiKey')}
                    title={apiKeyVisible ? t('welcome.hideApiKey') : t('welcome.showApiKey')}
                    onClick={() => {
                      void handleApiKeyVisibilityToggle();
                    }}
                    disabled={saving || revealing}
                  >
                    <AppIcon name={apiKeyVisible ? 'eye-off' : 'eye'} size={14} />
                  </button>
                </div>
              </label>

              {savedMessage ? <p className="welcome-provider-feedback" role="status">{savedMessage}</p> : null}
              {errorMessage ? <p className="welcome-provider-error" role="alert">{errorMessage}</p> : null}
              {providerRuntimeStatusMessage ? <p className="welcome-step-description" role="status">{providerRuntimeStatusMessage}</p> : null}
              <p className="welcome-step-description">{t('welcome.providerHint')}</p>
            </div>
          ) : (
            <div className="welcome-provider-form">
              <h2 className="welcome-step-title" ref={driverHeadingRef} tabIndex={-1}>{t('welcome.stepDriverTitle')}</h2>
              <p className="welcome-step-description">
                {t('welcome.stepDriverDescription')}
              </p>

              <DriverManagementCard variant="onboarding" />

              {savedMessage ? <p className="welcome-provider-feedback" role="status">{savedMessage}</p> : null}
              {errorMessage ? <p className="welcome-provider-error" role="alert">{errorMessage}</p> : null}
            </div>
          )}
        </div>

        <footer className="welcome-language-foot">
          <p className="welcome-language-hint">
            {isLanguageStep
              ? t('welcome.hint')
              : isDriverStep
                ? t('welcome.driverFootHint')
                : t('welcome.providerFootHint')}
          </p>
          <div className="welcome-language-foot-actions">
            {isLanguageStep ? (
              <button type="button" className="welcome-language-confirm" onClick={handleNext}>
                {t('common.next')}
              </button>
            ) : isDriverStep ? (
              <>
                <button type="button" className="welcome-language-secondary" onClick={handleBack} disabled={saving || revealing}>
                  {t('common.back')}
                </button>
                <button type="button" className="welcome-language-secondary" onClick={finishWizard} disabled={saving || revealing}>
                  {t('welcome.skip')}
                </button>
                <button type="button" className="welcome-language-confirm" onClick={finishWizard} disabled={saving || revealing}>
                  {t('common.finish')}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="welcome-language-secondary" onClick={handleBack} disabled={saving || revealing}>
                  {t('common.back')}
                </button>
                <button type="button" className="welcome-language-secondary" onClick={handleSkipProvider} disabled={saving || revealing}>
                  {t('welcome.skip')}
                </button>
                <button
                  type="button"
                  className="welcome-language-confirm"
                  onClick={() => {
                    void handleSaveAndContinue();
                  }}
                  disabled={providerSaveDisabled}
                >
                  {saving ? t('common.loading') : t('common.next')}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

export const welcomeLanguagePickerHelpers = {
  formatProviderSetupError,
};

export default WelcomeLanguagePicker;
