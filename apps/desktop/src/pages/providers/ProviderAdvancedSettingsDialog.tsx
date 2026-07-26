import { useTranslation } from 'react-i18next';
import AppIcon from '../../components/icons/AppIcon';
import ModalDialog from '../../components/ModalDialog';
import type { ProviderCustomHeaderDraft, ProviderDraft, ProviderResponseModality } from '../../schema/config';
import type { ProviderAuthScheme, ProviderKind, ProviderTransport } from '../../schema/provider-contract';
import { providersPageHelpers } from './providersPageHelpers';

type Props = {
  provider: ProviderDraft;
  sampleText: string;
  onClose: () => void;
  onProviderChange: (patch: Partial<ProviderDraft>) => void;
  onKindChange: (kind: ProviderKind) => void;
  onSampleTextChange: (value: string) => void;
  onResponseModalityToggle: (modality: ProviderResponseModality) => void;
  onHeaderAdd: () => void;
  onHeaderChange: (id: string, patch: Partial<ProviderCustomHeaderDraft>) => void;
  onHeaderRemove: (id: string) => void;
};

export default function ProviderAdvancedSettingsDialog(props: Props) {
  const { t } = useTranslation();
  const draft = (patch: Partial<ProviderDraft>) => props.onProviderChange({ ...patch, status: 'draft' });
  return <ModalDialog aria-label={t('providers.actions.advancedSettings')} className="provider-modal provider-advanced-modal content-card page-card compact-card" onClose={props.onClose} variant="provider">
      <div className="provider-panel-heading provider-panel-heading-compact"><div><h3>{t('providers.actions.advancedSettings')}</h3></div><button className="provider-header-icon" onClick={props.onClose} title={t('providers.advanced.closeTitle')} type="button"><AppIcon name="close" size={13} /></button></div>
      <div className="field-grid provider-field-grid provider-modal-grid">
        <label className="field-stack"><span>{t('providers.advanced.displayName')}</span><input className="text-input" onChange={(event) => draft({ displayName: event.target.value })} value={props.provider.displayName} /></label>
        <label className="field-stack"><span>{t('providers.advanced.apiFormat')}</span><select className="select-input" onChange={(event) => props.onKindChange(event.target.value as ProviderKind)} value={props.provider.kind}>{['openai-compatible', 'dashscope', 'openrouter', 'nvidia', 'ollama', 'lmstudio'].map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
        <label className="field-stack field-span-full"><span>{t('providers.advanced.endpointUrl')}</span><input className="text-input" onChange={(event) => draft({ baseUrl: event.target.value })} value={props.provider.baseUrl} /></label>
        <label className="field-stack"><span>{t('providers.advanced.transport')}</span><select className="select-input" onChange={(event) => draft({ transport: event.target.value as ProviderTransport })} value={props.provider.transport}>{providersPageHelpers.supportedTransportsForKind(props.provider.kind).map((transport) => <option key={transport} value={transport}>{providersPageHelpers.formatTransportLabel(transport)}</option>)}</select></label>
        <label className="field-stack"><span>{t('providers.advanced.timeout')}</span><input className="text-input" min={1000} onChange={(event) => draft({ timeoutMs: Number(event.target.value) || 0 })} step={500} type="number" value={props.provider.timeoutMs} /></label>
        <label className="field-stack"><span>{t('providers.advanced.authScheme')}</span><select className="select-input" onChange={(event) => draft({ authRef: { ...props.provider.authRef, scheme: event.target.value as ProviderAuthScheme } })} value={props.provider.authRef.scheme}><option value="bearer">Bearer</option><option value="api-key">API Key</option><option value="none">{t('providers.common.none')}</option></select></label>
        <label className="field-stack"><span>{t('providers.advanced.authHeader')}</span><input className="text-input" onChange={(event) => draft({ authRef: { ...props.provider.authRef, headerName: event.target.value } })} value={props.provider.authRef.headerName} /></label>
        <label className="field-stack"><span>{t('providers.advanced.streaming')}</span><select className="select-input" onChange={(event) => draft({ streamEnabled: event.target.value === 'true' })} value={String(props.provider.streamEnabled)}><option value="true">{t('providers.common.enabled')}</option><option value="false">{t('providers.common.disabled')}</option></select></label>
        <label className="field-stack"><span>{t('providers.advanced.temperature')}</span><input className="text-input" max={2} min={0} onChange={(event) => draft({ temperature: Number(event.target.value) || 0 })} step={0.1} type="number" value={props.provider.temperature} /></label>
        <label className="field-stack"><span>{t('providers.advanced.maxOutputTokens')}</span><input className="text-input" min={1} onChange={(event) => draft({ maxOutputTokens: Number(event.target.value) || 1 })} step={1} type="number" value={props.provider.maxOutputTokens} /></label>
        {typeof props.provider.region === 'string' ? <label className="field-stack"><span>{t('providers.advanced.region')}</span><input className="text-input" onChange={(event) => draft({ region: event.target.value })} value={props.provider.region} /></label> : null}
        <label className="field-stack field-span-full"><span>{t('providers.advanced.sampleText')}</span><textarea className="text-area provider-compact-textarea" onChange={(event) => props.onSampleTextChange(event.target.value)} rows={3} value={props.sampleText} /></label>
        <div className="field-stack field-span-full"><span>{t('providers.advanced.responseModalities')}</span><div className="provider-scenario-switcher">{(['text', 'audio'] as ProviderResponseModality[]).map((modality) => <button className={props.provider.responseModalities.includes(modality) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'} key={modality} onClick={() => props.onResponseModalityToggle(modality)} type="button">{modality === 'text' ? t('providers.common.text') : t('providers.common.audio')}</button>)}</div></div>
      </div>
      <section className="provider-setting-block provider-setting-block-compact">
        <div className="provider-setting-header provider-setting-header-compact"><div><strong>{t('providers.customHeaders.title')}</strong></div><button className="icon-button" onClick={props.onHeaderAdd} type="button"><AppIcon name="cloud" size={14} />{t('providers.customHeaders.addHeader')}</button></div>
        <div className="provider-custom-header-list">{props.provider.customHeaders.length ? props.provider.customHeaders.map((header) => <div className="provider-custom-header-item" key={header.id}><input className="text-input" onChange={(event) => props.onHeaderChange(header.id, { name: event.target.value })} placeholder={t('providers.customHeaders.namePlaceholder')} value={header.name} /><input className="text-input" onChange={(event) => props.onHeaderChange(header.id, { value: event.target.value })} placeholder={t('providers.customHeaders.valuePlaceholder')} value={header.value} /><select className="select-input" onChange={(event) => props.onHeaderChange(header.id, { enabled: event.target.value === 'true' })} value={String(header.enabled)}><option value="true">{t('providers.common.enabled')}</option><option value="false">{t('providers.common.disabled')}</option></select><button className="provider-header-icon provider-header-icon-danger" onClick={() => props.onHeaderRemove(header.id)} title={t('providers.customHeaders.deleteHeader')} type="button"><AppIcon name="close" size={13} /></button></div>) : <div className="provider-directory-empty provider-scene-empty"><strong>{t('providers.customHeaders.emptyTitle')}</strong><p>{t('providers.customHeaders.emptyDescription')}</p></div>}</div>
      </section>
  </ModalDialog>;
}
