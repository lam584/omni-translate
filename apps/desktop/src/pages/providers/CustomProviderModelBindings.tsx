import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { customProviderBinding, customProviderProtocolProfileOptions } from '../../provider-manifest/custom-profile-options';
import { authorizedCustomDashScopeRealtime } from '../../utils/custom-dashscope-authority';
import type { ProviderDraft, ProviderModelCapabilityRegistryEntry } from '../../schema/config';

/** Bind an exact operation/profile to a candidate model; never infer a wire dialect from its name. */
export default function CustomProviderModelBindings({ provider, capabilitiesRegistry, onChange }: {
  provider: ProviderDraft;
  capabilitiesRegistry: ProviderModelCapabilityRegistryEntry[];
  onChange: (patch: Partial<ProviderDraft>) => void;
}) {
  const { t } = useTranslation();
  const models = [...new Set((provider.candidateModelGroups ?? []).flatMap((group) => group.modelIds))];
  const [selectedModel, setSelectedModel] = useState('');
  const modelId = models.includes(selectedModel) ? selectedModel : models[0] ?? '';
  const bindings = (provider.modelProtocolBindings ?? []).filter((binding) => binding.modelId === modelId);
  const capabilities = capabilitiesRegistry.find((entry) => entry.modelId === modelId)?.capabilities ?? [];
  const nativeAuthority = authorizedCustomDashScopeRealtime(provider, modelId);
  const supportsOperation = (operation: string) => operation === 'text-translation'
    ? capabilities.includes('text-generation')
    : capabilities.includes('speech-to-speech');
  const options = customProviderProtocolProfileOptions(provider.kind).filter((option) =>
    supportsOperation(option.operation)
    && (option.transport === provider.transport
      || (provider.transport === 'websocket' && option.transport === 'streaming-http' && provider.streamEnabled))
    && option.authHeaderName.toLowerCase() === provider.authRef.headerName.toLowerCase()
    && option.authScheme === provider.authRef.scheme
  );
  const add = (key: string) => {
    const option = options.find((candidate) => candidate.key === key);
    const binding = option && customProviderBinding(provider.kind, key, modelId);
    if (!binding || !option) return;
    onChange({
      modelRegistryVersion: 2,
      modelProtocolBindings: [
        ...(provider.modelProtocolBindings ?? []).filter((existing) => existing.modelId !== modelId || existing.operation !== binding.operation),
        binding,
      ],
      status: 'draft',
    });
  };
  return <article className="content-card page-card compact-card provider-panel-card">
    <h3>{t('providers.customDialog.protocolProfile', { defaultValue: '模型协议绑定' })}</h3>
    {!modelId ? <p className="provider-setting-footnote">请先在下方候选模型中添加模型，再配置该模型所需操作的协议。</p> : <>
      <label className="field-stack">模型 ID
        <select className="select-input" onChange={(event) => setSelectedModel(event.target.value)} value={modelId}>
          {models.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
      {bindings.map((binding) => <div className="provider-scene-model-item" key={`${binding.modelId}:${binding.operation}`}>
        <span>{binding.operation}: {binding.profileId}@{binding.profileVersion}</span>
        <button aria-label={`移除 ${binding.operation} 协议绑定`} className="icon-button" onClick={() => onChange({ modelProtocolBindings: (provider.modelProtocolBindings ?? []).filter((entry) => entry !== binding), status: 'draft' })} type="button">×</button>
      </div>)}
      {provider.kind === 'dashscope' ? <p className="provider-setting-footnote">{nativeAuthority
        ? `阿里云官方地址与精确模型的原生操作已授权：${nativeAuthority.profileId}@${nativeAuthority.profileVersion}（操作：${nativeAuthority.operation}；区域：${nativeAuthority.region}）`
        : '此模型尚未匹配已实现的阿里云原生操作协议（对话、ASR、TTS 或实时翻译）；请检查精确模型 ID、对应的 realtime/inference 官方接口、Workspace 要求、区域及 Bearer 认证。'}</p> : null}
      {options.length ? <label className="field-stack">为模型绑定操作协议
        <select className="select-input" onChange={(event) => { add(event.target.value); event.target.value = ''; }} value="">
          <option value="">选择精确协议（不会自动推断）</option>
          {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select>
      </label> : provider.kind === 'dashscope' ? null : <p className="provider-setting-footnote">请先在模型能力注册表登记相应能力，并确认平台连接设置；没有匹配的已实现协议时不会自动套用其他平台协议。</p>}
    </>}
  </article>;
}
