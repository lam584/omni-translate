import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon from '../../components/icons/AppIcon';
import PageSectionHeader from '../../components/page/PageSectionHeader';
import StatusBadge from '../../components/page/StatusBadge';
import { activeDesktopApi } from '../../runtime/desktop-api';
import type { ProviderDraft, ProviderModelCapabilityRegistryEntry, ProviderScenario } from '../../schema/config';
import type { ProviderModelRuntime } from '../../schema/provider-runtime';
import type { ProviderTemplate } from '../../schema/provider-template';
import { providerCapabilityLabelKey } from '../../utils/provider-model-capabilities';
import { providersPageHelpers } from './providersPageHelpers';

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
  sceneAssignments: ProviderDraft['sceneModelAssignments'];
  modelLookup: Map<string, ProviderModelRuntime>;
  localModelCapabilityRegistry: ProviderModelCapabilityRegistryEntry[];
  setSecretDraft: Dispatch<SetStateAction<string>>;
  setDraggingSceneModel: Dispatch<SetStateAction<{ scenario: ProviderScenario; modelId: string } | null>>;
  updateActiveProviderDraft: (patch: Partial<ProviderDraft>) => void;
  onDelete: () => void;
  onVerify: () => Promise<void>;
  onVerificationDetails: () => void;
  onOpenModelCatalog: (scenario?: ProviderScenario) => void;
  onOpenAdvancedSettings: () => void;
  onSecretVisibilityToggle: () => Promise<void>;
  onSecretSave: () => Promise<void>;
  onSceneModelReorder: (scenario: ProviderScenario, targetModelId: string) => void;
  onSceneModelRemove: (scenario: ProviderScenario, modelId: string) => void;
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
            {props.hasVerificationDetail ? <button className="icon-button" onClick={props.onVerificationDetails} type="button"><AppIcon name="book" size={14} />{t('providers.actions.verificationDetails')}</button> : null}
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
              <label className="field-stack provider-auth-entry-field"><div className="provider-auth-label-row"><span>{t('providers.auth.apiKey')}</span>{PROVIDER_API_KEY_URL[props.activeTemplate.defaultDraft.providerId] ? <a className="provider-auth-help-link" href={PROVIDER_API_KEY_URL[props.activeTemplate.defaultDraft.providerId]} onClick={(event) => { event.preventDefault(); void activeDesktopApi().diagnostics.openExternalUrl(PROVIDER_API_KEY_URL[props.activeTemplate.defaultDraft.providerId]); }} rel="noopener noreferrer" target="_blank">{t('providers.auth.getApiKey')}</a> : null}</div><div className="provider-secret-row"><div className="secret-input-inline provider-secret-input-inline"><input className="text-input" onChange={(event) => props.setSecretDraft(event.target.value)} placeholder={t('providers.auth.secretPlaceholder')} type={props.secretVisible ? 'text' : 'password'} value={props.secretStored && !props.secretDraft ? '***********************************' : props.secretDraft} /><button aria-label={props.secretVisible ? t('providers.auth.hideSecret') : t('providers.auth.showSecret')} className="icon-button secret-visibility-button" disabled={props.busyAction !== null || props.providerRuntimeBlocked} onClick={() => void props.onSecretVisibilityToggle()} title={props.secretVisible ? t('providers.auth.hideSecret') : t('providers.auth.showSecret')} type="button"><AppIcon name={props.secretVisible ? 'eye-off' : 'eye'} size={14} /></button></div></div></label>
              <div className="provider-auth-entry-actions"><button className="action-button" disabled={props.busyAction !== null || (!props.secretDraft.trim() && !props.activeProvider.baseUrl.trim()) || props.providerRuntimeBlocked} onClick={() => void props.onSecretSave()} type="button"><AppIcon name="key" size={14} />{props.busyAction === 'secret' ? t('providers.actions.saving') : t('providers.actions.saveSecret')}</button></div>
              <div className="provider-footnote-row">{props.modelCatalogEndpoint ? <p className="provider-setting-footnote">{t('providers.modelCatalog.endpoint', { endpoint: props.modelCatalogEndpoint })}</p> : null}</div>
            </div>
          </article>

          <article className="content-card page-card compact-card provider-panel-card provider-panel-card-compact">
            <div className="provider-panel-heading provider-panel-heading-compact"><div><h3>{t('providers.sceneModels.title')}</h3></div><div className="provider-panel-tools"><StatusBadge label={t('providers.sceneModels.addedCount', { count: props.sceneAssignments.reduce((count, item) => count + item.modelIds.length, 0) })} tone="pending" /></div></div>
            <div className="provider-scene-grid">
              {props.sceneAssignments.map((assignment) => {
                const models = assignment.modelIds.map((modelId) => props.modelLookup.get(modelId) ?? providersPageHelpers.createDerivedRuntimeModel(modelId, props.localModelCapabilityRegistry));
                return <article className="provider-scene-card" key={assignment.scenario}>
                  <div className="provider-scene-card-header"><div><strong>{providersPageHelpers.formatScenarioLabel(assignment.scenario)}</strong><p>{models.length ? t('providers.sceneModels.addedCount', { count: models.length }) : t('providers.sceneModels.noneAdded')}</p></div><button className="icon-button" onClick={() => props.onOpenModelCatalog(assignment.scenario)} type="button"><AppIcon name="cloud" size={14} />{t('providers.actions.addModel')}</button></div>
                  {models.length ? <div className="provider-scene-model-list">{models.map((model) => <div className="provider-scene-model-item" draggable key={`${assignment.scenario}-${model.id}`} onDragEnd={() => props.setDraggingSceneModel(null)} onDragOver={(event) => event.preventDefault()} onDragStart={() => props.setDraggingSceneModel({ scenario: assignment.scenario, modelId: model.id })} onDrop={() => props.onSceneModelReorder(assignment.scenario, model.id)}><div className="provider-scene-model-copy"><strong>{model.displayName}</strong>{model.displayName.trim() !== model.id.trim() ? <span>{model.id}</span> : null}</div><div className="provider-scene-model-actions">{model.capabilities.length ? <div className="provider-chip-row provider-chip-row-compact provider-chip-row-tight">{model.capabilities.map((capability) => <span className={`provider-meta-chip provider-capability-chip provider-capability-chip-${capability}`} key={`${model.id}-${capability}`}><AppIcon name={providersPageHelpers.resolveCapabilityIconName(capability)} size={12} />{t(providerCapabilityLabelKey(capability))}</span>)}</div> : <span className="provider-setting-footnote">???</span>}<button className="provider-header-icon provider-header-icon-danger" onClick={() => props.onSceneModelRemove(assignment.scenario, model.id)} title={t('providers.actions.removeAddedModel')} type="button"><AppIcon name="close" size={13} /></button></div></div>)}</div> : <div className="provider-directory-empty provider-scene-empty"><strong>{t('providers.sceneModels.noneAdded')}</strong><p>{t('providers.sceneModels.emptyDescription')}</p></div>}
                </article>;
              })}
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
