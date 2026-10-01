import ProviderWorkspaceEndpointHint from './ProviderWorkspaceEndpointHint';
import ProviderModelBindingEditor from './ProviderModelBindingEditor';
import CustomProviderModelBindings from './CustomProviderModelBindings';
import CandidateModelGroupsEditor from './CandidateModelGroupsEditor';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon from '../../components/icons/AppIcon';
import PageSectionHeader from '../../components/page/PageSectionHeader';
import StatusBadge from '../../components/page/StatusBadge';
import { activeDesktopApi } from '../../runtime/desktop-api';
import { createLogger } from '../../runtime/logger';
import type { ProviderDraft, ProviderModelCapabilityRegistryEntry, CandidateModelGroupId } from '../../schema/config';
import type { ProviderModelRuntime } from '../../schema/provider-runtime';
import type { ProviderTemplate } from '../../schema/provider-template';

const providerStudioLogger = createLogger('runtime');

/** Maps providerId (from provider templates) to the API Key acquisition page URL. */
const PROVIDER_API_KEY_URL: Record<string, string> = {
  'provider-openai': 'https://platform.openai.com/api-keys',
  'provider-dashscope': 'https://bailian.console.aliyun.com/',
  'provider-openrouter': 'https://openrouter.ai/keys',
  'provider-deepseek': 'https://platform.deepseek.com/api_keys',
  'provider-nvidia': 'https://build.nvidia.com/explore/discover',
  'provider-gemini': 'https://aistudio.google.com/apikey',
  'provider-zhipu': 'https://open.bigmodel.cn/',
  'provider-tencent': 'https://console.cloud.tencent.com/cam/capi',
  'provider-azure-openai': 'https://portal.azure.com/',
};

type Props = {
  activeProvider: ProviderDraft;
  activeTemplate: ProviderTemplate;
  busyAction: 'secret' | 'secret-reveal' | 'verify' | null;
  providerRuntimeBlocked: boolean;
  providerRuntimeStatusMessage: string | null;
  storagePollError: string | null;
  onStorageRetry: () => void;
  hasVerificationDetail: boolean;
  secretDraft: string;
  secretStored: boolean;
  secretVisible: boolean;
  secretStatusMessage: string | null;
  modelCatalogEndpoint: string | null;
  modelLookup: Map<string, ProviderModelRuntime>;
  localModelCapabilityRegistry: ProviderModelCapabilityRegistryEntry[];
  setSecretDraft: Dispatch<SetStateAction<string>>;
  updateActiveProviderDraft: (patch: Partial<ProviderDraft>) => void;
  onDelete: () => void;
  onVerify: () => Promise<void>;
  onVerificationDetails: () => void;
  onOpenModelCatalog: (group?: CandidateModelGroupId) => void;
  onOpenAdvancedSettings: () => void;
  onSecretVisibilityToggle: () => Promise<void>;
  onSecretSave: () => Promise<void>;
};

export default function ProviderStudio(props: Props) {
  const { t } = useTranslation();
  return (
    <section className="provider-studio">
      <header className="provider-studio-header content-card page-card compact-card provider-studio-header-compact">
        <PageSectionHeader
          actions={<button className="provider-header-icon provider-header-icon-danger" onClick={props.onDelete} title={t('providers.actions.deleteCurrentProvider')} type="button"><AppIcon name="trash" size={13} /></button>}
          actionsClassName="provider-studio-header-actions provider-studio-header-actions-compact"
          className="provider-studio-heading-row provider-studio-heading-row-compact"
          copyClassName="provider-studio-heading-copy"
          title={props.activeTemplate.displayName}
          titleLevel="h2"
        />
        <div className="provider-studio-toolbar provider-studio-toolbar-compact">
          <div className="provider-action-row provider-action-row-compact">
            <button className="icon-button provider-primary-action" disabled={props.busyAction !== null || props.providerRuntimeBlocked} onClick={() => void props.onVerify()} type="button"><AppIcon name="activity" size={14} />{props.busyAction === 'verify' ? t('providers.actions.verifying') : t('providers.actions.verifyProvider')}</button>
            {props.hasVerificationDetail ? <button className="icon-button" onClick={props.onVerificationDetails} type="button"><AppIcon name="diagnostics" size={14} />{t('providers.actions.verificationDetails')}</button> : null}
            <button className="icon-button" onClick={() => props.onOpenModelCatalog()} type="button"><AppIcon name="layers" size={14} />{t('providers.actions.modelList')}</button>
            <button className="icon-button" onClick={props.onOpenAdvancedSettings} type="button"><AppIcon name="sliders" size={14} />{t('providers.actions.advancedSettings')}</button>
          </div>
        </div>
        {props.secretStatusMessage ? <div className={`provider-inline-alert${props.secretStatusMessage === t('providers.messages.secretPlainLoaded') ? ' provider-inline-alert-plain' : ''}`}>{props.secretStatusMessage}</div> : null}
        {props.providerRuntimeStatusMessage && props.secretStatusMessage !== props.providerRuntimeStatusMessage ? <div className="provider-inline-alert provider-inline-alert-warning">{props.providerRuntimeStatusMessage}</div> : null}
        {props.storagePollError ? (
          <div className="provider-inline-alert provider-inline-alert-warning" role="alert">
            <span>{t('providers.messages.storageRecoveryFailed', { error: props.storagePollError })}</span>
            <button className="icon-button" onClick={props.onStorageRetry} type="button"><AppIcon name="refresh" size={13} />{t('common.retry')}</button>
          </div>
        ) : null}
      </header>

      <div className="provider-studio-grid provider-studio-grid-compact provider-studio-grid-single">
        <div className="provider-studio-main">
          <article className="content-card page-card compact-card provider-panel-card provider-panel-card-compact">
            <div className="provider-panel-heading provider-panel-heading-compact"><div><h3>{t('providers.auth.title')}</h3></div><StatusBadge label={props.secretStored ? t('providers.auth.saved') : t('providers.auth.notSaved')} tone={props.secretStored ? 'ready' : 'draft'} /></div>
            <div className="provider-setting-block provider-setting-block-compact">
              <div className="provider-setting-header provider-setting-header-compact"><div><strong>{t('providers.auth.credentialsHeader')}</strong></div></div>
              <label className="field-stack provider-auth-entry-field"><span>{t('providers.auth.apiUrl')}</span><div className="secret-input-inline provider-secret-input-inline"><input className="text-input" onChange={(event) => props.updateActiveProviderDraft({ baseUrl: event.target.value, status: 'draft' })} value={props.activeProvider.baseUrl} /><button className="icon-button secret-visibility-button" onClick={() => props.updateActiveProviderDraft({ baseUrl: props.activeTemplate.defaultDraft.baseUrl, status: 'draft' })} title={t('providers.auth.resetApiUrl')} type="button"><AppIcon name="refresh" size={14} /></button></div></label>
              <label className="field-stack provider-auth-entry-field"><div className="provider-auth-label-row"><span>{t('providers.auth.apiKey')}</span>{PROVIDER_API_KEY_URL[props.activeTemplate.defaultDraft.providerId] ? <a className="provider-auth-help-link" href={PROVIDER_API_KEY_URL[props.activeTemplate.defaultDraft.providerId]} onClick={(event) => { event.preventDefault(); void activeDesktopApi().diagnostics.openExternalUrl(PROVIDER_API_KEY_URL[props.activeTemplate.defaultDraft.providerId]).catch((error) => providerStudioLogger.warn('provider API key URL could not be opened', String(error))); }} rel="noopener noreferrer" target="_blank">{t('providers.auth.getApiKey')}</a> : null}</div><div className="provider-secret-row"><div className="secret-input-inline provider-secret-input-inline"><input className="text-input" onChange={(event) => props.setSecretDraft(event.target.value)} placeholder={t('providers.auth.secretPlaceholder')} type={props.secretVisible ? 'text' : 'password'} value={props.secretStored && !props.secretDraft ? '***********************************' : props.secretDraft} /><button aria-label={props.secretVisible ? t('providers.auth.hideSecret') : t('providers.auth.showSecret')} className="icon-button secret-visibility-button" disabled={props.busyAction !== null || props.providerRuntimeBlocked} onClick={() => void props.onSecretVisibilityToggle()} title={props.secretVisible ? t('providers.auth.hideSecret') : t('providers.auth.showSecret')} type="button"><AppIcon name={props.secretVisible ? 'eye-off' : 'eye'} size={14} /></button></div></div></label>
              <ProviderWorkspaceEndpointHint provider={props.activeProvider} />

              <div className="provider-auth-entry-actions"><button className="action-button" disabled={props.busyAction !== null || (!props.secretDraft.trim() && !props.activeProvider.baseUrl.trim()) || props.providerRuntimeBlocked} onClick={() => void props.onSecretSave()} type="button"><AppIcon name="key" size={14} />{props.busyAction === 'secret' ? t('providers.actions.saving') : t('providers.actions.saveSecret')}</button></div>
              <div className="provider-footnote-row">{props.modelCatalogEndpoint ? <p className="provider-setting-footnote">{t('providers.modelCatalog.endpoint', { endpoint: props.modelCatalogEndpoint })}</p> : null}</div>
            </div>
          </article>

          {props.activeTemplate.source === 'custom' ? <CustomProviderModelBindings key={props.activeProvider.providerId} provider={props.activeProvider} capabilitiesRegistry={props.localModelCapabilityRegistry} onChange={props.updateActiveProviderDraft} /> : props.activeProvider.kind === 'dashscope' ? null : <ProviderModelBindingEditor key={props.activeProvider.providerId} provider={props.activeProvider} />}
          <CandidateModelGroupsEditor provider={props.activeProvider} modelLookup={props.modelLookup} localModelCapabilityRegistry={props.localModelCapabilityRegistry} onChange={props.updateActiveProviderDraft} onOpenModelCatalog={props.onOpenModelCatalog} />
        </div>
      </div>
    </section>
  );
}
