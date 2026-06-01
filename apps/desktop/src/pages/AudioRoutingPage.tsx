import { useEffect, useMemo, useState } from 'react';
import AppIcon from '../components/icons/AppIcon';
import StatusBadge from '../components/page/StatusBadge';
import { providerTemplates } from '../mocks/provider-templates';
import type { AudioInputProcessingContract } from '../schema/audio-contract';
import type { DeviceDraft, FeedbackLoopPrevention, ProviderDraft, ProviderScenario, SpeechDraft } from '../schema/config';
import type { ProviderCapability } from '../schema/provider-contract';
import type { ModelPreset } from '../schema/provider-template';
import { useAppStore } from '../stores/app-store';
import { readCustomProviderTemplates } from '../utils/custom-provider-templates';
import { formatProviderCapabilityLabel, resolveProviderModelCapabilities } from '../utils/provider-model-capabilities';
import { PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT, buildProviderTemplateCatalogEntries, readProviderTemplateCatalogPreferences } from '../utils/provider-template-catalog';

type RoutingModelTarget = 'inbound' | 'outbound' | 'speech';

type RoutingModelOption = ModelPreset & {
  providerTemplateId: string;
  rawModelId: string;
  scenarios: ProviderScenario[];
};

type RoutingModelSelectOption = RoutingModelOption & {
  mismatchMessages: string[];
  preferred: boolean;
};

type PendingModelSelection = {
  target: RoutingModelTarget;
  modelId: string;
  title: string;
  messages: string[];
};

const labels = {
  inputDevice: '输入设备',
  outputDevice: '输出设备',
  voiceModels: '语音模型',
  subtitleTranslationMode: '字幕翻译模式',
  runtimeStatus: '运行状态',
  inboundModel: '翻译对方声音的模型',
  outboundModel: '翻译我的麦克风的模型',
  ttsModel: '将文字转换为语音的模型',
  noModels: '当前服务商没有可用模型',
  keepSelection: '仍然选择',
  cancelSelection: '取消选择',
  unsupportedInboundTitle: '模型可能不支持对方声音翻译输出',
  unsupportedOutboundTitle: '模型可能不支持麦克风译音输出',
  unsupportedSpeech: '不支持输出翻译语音',
  unsupportedSubtitles: '不支持输出翻译字幕',
  unsupportedVirtualMic: '不支持发送到虚拟麦克风',
  outputSpeech: '输出翻译语音',
  outputSubtitles: '输出翻译字幕',
  sendVoiceToVirtualMic: '将翻译后的语音发送到虚拟麦克风',
  aec: 'AEC 回声消除',
  ans: 'ANS 噪声抑制',
  agc: 'AGC 自动增益',
  feedback: '音频反馈循环抑制',
  echoCancel: '回声消除',
  echoCancelDesc: '实时从采集信号中减去已播放音频',
  virtualDriver: '虚拟音频驱动',
  virtualDriverDesc: '将翻译语音路由到独立音频端点',
  virtualDriverDisabled: '虚拟音频驱动未运行，请先在诊断页安装或启动驱动',
  speaker: '扬声器',
  microphone: '麦克风',
  outputVolume: '输出音量',
  inputLevel: '输入电平',
  testSpeaker: '测试扬声器',
  testMic: '测试麦克风',
  testing: '测试中...',
  nativeMode: '原生模式',
  nativeModeDescription: '使用语音模型的原生字幕翻译。',
  secondaryTranslation: '二次翻译',
  secondaryTranslationDescription: '先显示原文，再用文本模型逐句翻译。',
  textTranslationModel: '文本翻译模型',
  notSelected: '未选择',
  current: '当前',
  ready: '就绪',
  needsSetup: '需要配置',
};

function formatCapabilityLabel(capability: ProviderCapability) {
  return formatProviderCapabilityLabel(capability);
}

function buildInputProcessing(devices: DeviceDraft, patch: Partial<AudioInputProcessingContract>): AudioInputProcessingContract {
  return {
    inputLevel: devices.outboundRoute.input.processing?.inputLevel ?? devices.inputLevel,
    echoCancellationEnabled: devices.outboundRoute.input.processing?.echoCancellationEnabled ?? devices.aecEnabled,
    noiseSuppressionEnabled: devices.outboundRoute.input.processing?.noiseSuppressionEnabled ?? devices.ansEnabled,
    autoGainControlEnabled: devices.outboundRoute.input.processing?.autoGainControlEnabled ?? devices.agcEnabled,
    ...patch,
  };
}

function updateOutputTargetEnabled(devices: DeviceDraft, kind: 'subtitle-engine', enabled: boolean) {
  return devices.inboundRoute.outputs.map((target) => (target.kind === kind ? { ...target, enabled } : target));
}

function updateOutboundTargetEnabled(devices: DeviceDraft, kind: 'virtual-mic', enabled: boolean) {
  return devices.outboundRoute.outputs.map((target) => (target.kind === kind ? { ...target, enabled } : target));
}

function hasCapability(model: Pick<ModelPreset, 'capabilities'> | undefined, capability: ProviderCapability) {
  return model?.capabilities.includes(capability) ?? false;
}

function isVoiceModel(model: Pick<ModelPreset, 'capabilities'>) {
  return model.capabilities.some((capability) => capability === 'speech-to-text' || capability === 'text-to-speech' || capability === 'speech-to-speech');
}

function resolveSelectedModel(options: RoutingModelOption[], modelId: string) {
  return options.find((model) => model.model === modelId) ?? options.find((model) => model.rawModelId === modelId);
}

function sortRoutingModelOptions(options: RoutingModelSelectOption[]) {
  return [...options].sort((left, right) => {
    if (left.preferred !== right.preferred) return left.preferred ? -1 : 1;
    if (left.mismatchMessages.length !== right.mismatchMessages.length) return left.mismatchMessages.length - right.mismatchMessages.length;
    return left.displayName.localeCompare(right.displayName);
  });
}

function RoutingModelSelect({
  label,
  value,
  options,
  emptyText,
  placeholder,
  allowEmpty,
  onSelect,
}: {
  label: string;
  value: string;
  options: RoutingModelSelectOption[];
  emptyText: string;
  placeholder?: string;
  allowEmpty?: boolean;
  onSelect: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedOption = resolveSelectedModel(options, value);
  const buttonLabel = selectedOption?.displayName ?? (value || placeholder || emptyText);

  return (
    <div className="routing-model-select field-span-full">
      <span className="routing-model-select-label">{label}</span>
      {options.length === 0 ? (
        <div className="routing-empty">{emptyText}</div>
      ) : (
        <>
          <button aria-expanded={open} className="routing-model-select-button" onClick={() => setOpen((current) => !current)} type="button">
            <span>{buttonLabel}</span>
            <AppIcon name="sliders" size={15} />
          </button>
          {open ? (
            <div className="routing-model-select-list" role="listbox">
              {allowEmpty ? (
                <button
                  className={[
                    'routing-model-select-option',
                    value === '' ? 'routing-model-select-option-active' : '',
                    'routing-model-select-option-compact',
                  ].filter(Boolean).join(' ')}
                  data-value=""
                  onClick={() => {
                    onSelect('');
                    setOpen(false);
                  }}
                  role="option"
                  type="button"
                >
                  {value === '' ? <AppIcon className="routing-model-select-check" name="check" size={16} /> : null}
                  <span>
                    <strong>{placeholder || emptyText}</strong>
                  </span>
                </button>
              ) : null}
              {options.map((option) => (
                <button
                  className={[
                    'routing-model-select-option',
                    option.model === selectedOption?.model ? 'routing-model-select-option-active' : '',
                    option.mismatchMessages.length > 0 ? 'routing-model-select-option-mismatch' : '',
                  ].filter(Boolean).join(' ')}
                  data-value={option.model}
                  key={option.model}
                  onClick={() => {
                    onSelect(option.model);
                    setOpen(false);
                  }}
                  role="option"
                  type="button"
                >
                  {option.model === selectedOption?.model ? <AppIcon className="routing-model-select-check" name="check" size={16} /> : null}
                  <span>
                    <strong>{option.displayName}</strong>
                    <small>{option.capabilities.map(formatCapabilityLabel).join(' / ')}</small>
                  </span>
                  {option.mismatchMessages.length > 0 ? <em>{option.mismatchMessages.join(' / ')}</em> : null}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function AudioRoutingPage() {
  const configDraft = useAppStore((state) => state.configDraft);
  const runtimeSnapshot = useAppStore((state) => state.runtimeSnapshot);
  const audioRuntimeSnapshot = useAppStore((state) => state.audioRuntimeSnapshot);
  const updateDeviceDraft = useAppStore((state) => state.updateDeviceDraft);
  const updateSpeechDraft = useAppStore((state) => state.updateSpeechDraft);
  const [customTemplates] = useState(() => readCustomProviderTemplates());
  const [catalogPreferences, setCatalogPreferences] = useState(() => readProviderTemplateCatalogPreferences());
  const [micTesting, setMicTesting] = useState(false);
  const [micTestResult, setMicTestResult] = useState<string | null>(null);
  const [speakerTesting, setSpeakerTesting] = useState(false);
  const [speakerTestResult, setSpeakerTestResult] = useState<string | null>(null);
  const [pendingModelSelection, setPendingModelSelection] = useState<PendingModelSelection | null>(null);

  useEffect(() => {
    const refreshCatalogPreferences = () => setCatalogPreferences(readProviderTemplateCatalogPreferences());
    window.addEventListener(PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT, refreshCatalogPreferences);
    window.addEventListener('storage', refreshCatalogPreferences);
    return () => {
      window.removeEventListener(PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT, refreshCatalogPreferences);
      window.removeEventListener('storage', refreshCatalogPreferences);
    };
  }, []);

  const templateCatalogEntries = useMemo(
    () => buildProviderTemplateCatalogEntries([...providerTemplates, ...customTemplates], catalogPreferences),
    [catalogPreferences, customTemplates],
  );

  const enabledProviderTemplateIds = useMemo(
    () => new Set(templateCatalogEntries.filter((item) => item.enabled && !item.hidden).map((item) => item.template.id)),
    [templateCatalogEntries],
  );

  const allModelOptions = useMemo<RoutingModelOption[]>(() => {
    const modelMap = new Map<string, RoutingModelOption>();
    const addModelsFromProvider = (
      sceneAssignments: ProviderDraft['sceneModelAssignments'],
      modelCacheModels: ProviderDraft['modelCatalogCache']['models'],
      localRegistry: ProviderDraft['localModelCapabilityRegistry'],
      providerName: string,
      providerTemplateId: string,
    ) => {
      if (!enabledProviderTemplateIds.has(providerTemplateId)) return;
      for (const assignment of sceneAssignments) {
        for (const modelId of assignment.modelIds) {
          const key = `${providerTemplateId}::${modelId}`;
          const existing = modelMap.get(key);
          if (existing) {
            if (!existing.scenarios.includes(assignment.scenario)) existing.scenarios.push(assignment.scenario);
            continue;
          }
          const cachedModel = modelCacheModels.find((model) => model.id === modelId);
          const baseModel = {
            id: modelId,
            displayName: cachedModel?.displayName ?? modelId,
            capabilities: cachedModel?.capabilities ?? [],
          };
          modelMap.set(key, {
            id: key,
            model: key,
            displayName: `${providerName}: ${baseModel.displayName}`,
            capabilities: resolveProviderModelCapabilities(baseModel, localRegistry ?? []),
            description: cachedModel?.ownedBy ?? providerName,
            providerTemplateId,
            rawModelId: modelId,
            scenarios: [assignment.scenario],
          });
        }
      }
    };

    for (const provider of configDraft.providers) {
      addModelsFromProvider(
        provider.sceneModelAssignments ?? [],
        provider.modelCatalogCache?.models ?? [],
        provider.localModelCapabilityRegistry ?? [],
        provider.displayName,
        provider.templateId,
      );
    }

    return [...modelMap.values()];
  }, [configDraft, enabledProviderTemplateIds]);

  const voiceModelOptions = useMemo(() => allModelOptions.filter(isVoiceModel), [allModelOptions]);
  const inboundVoiceModelId = configDraft.devices.inboundVoiceModelId;
  const outboundVoiceModelId = configDraft.devices.outboundVoiceModelId;
  const speechModelId = configDraft.devices.textToSpeechModelId || configDraft.speech.textToSpeechModelId || outboundVoiceModelId;
  const virtualDriverReady = runtimeSnapshot.bridge.driverHealth === 'running';

  const inboundModelOptions = useMemo(
    () => sortRoutingModelOptions(voiceModelOptions.map((model) => ({
      ...model,
      mismatchMessages: [
        configDraft.devices.outputSubtitlesEnabled && !hasCapability(model, 'speech-to-text') ? labels.unsupportedSubtitles : null,
        configDraft.devices.outputSpeechEnabled && !hasCapability(model, 'speech-to-speech') ? labels.unsupportedSpeech : null,
      ].filter((item): item is string => Boolean(item)),
      preferred: hasCapability(model, 'speech-to-text') || hasCapability(model, 'speech-to-speech'),
    }))),
    [configDraft.devices.outputSpeechEnabled, configDraft.devices.outputSubtitlesEnabled, voiceModelOptions],
  );

  const outboundModelOptions = useMemo(
    () => sortRoutingModelOptions(voiceModelOptions.map((model) => ({
      ...model,
      mismatchMessages: configDraft.devices.virtualMicOutputEnabled && !hasCapability(model, 'speech-to-speech') ? [labels.unsupportedVirtualMic] : [],
      preferred: hasCapability(model, 'speech-to-speech'),
    }))),
    [configDraft.devices.virtualMicOutputEnabled, voiceModelOptions],
  );

  const speechModelOptions = useMemo(
    () => sortRoutingModelOptions(voiceModelOptions.map((model) => ({
      ...model,
      mismatchMessages: !hasCapability(model, 'speech-to-speech') ? [labels.unsupportedSpeech] : [],
      preferred: hasCapability(model, 'speech-to-speech'),
    }))),
    [voiceModelOptions],
  );

  const subtitleTranslationModelOptions = useMemo(
    () => allModelOptions
      .filter((model) => model.scenarios.includes('subtitle-translate') && !isVoiceModel(model))
      .map((model) => ({
        ...model,
        mismatchMessages: [],
        preferred: true,
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [allModelOptions],
  );

  const captureDevices = audioRuntimeSnapshot.captureDevices;
  const renderDevices = audioRuntimeSnapshot.renderDevices;
  const selectedInputDevice = captureDevices.find((device) => device.deviceId === configDraft.devices.inputDeviceId) ?? captureDevices.find((device) => device.isDefault);
  const selectedOutputDevice = renderDevices.find((device) => device.deviceId === configDraft.devices.outputDeviceId) ?? renderDevices.find((device) => device.isDefault);
  const inboundModelLabel = resolveSelectedModel(allModelOptions, inboundVoiceModelId)?.displayName ?? inboundVoiceModelId;
  const outboundModelLabel = resolveSelectedModel(allModelOptions, outboundVoiceModelId)?.displayName ?? outboundVoiceModelId;

  const patchDeviceConfig = (patch: Partial<DeviceDraft>) => {
    updateDeviceDraft({ ...patch, status: 'ready' });
  };

  const commitModelSelection = (target: RoutingModelTarget, modelId: string) => {
    if (target === 'inbound') {
      patchDeviceConfig({ inboundVoiceModelId: modelId });
      return;
    }
    if (target === 'outbound') {
      patchDeviceConfig({ outboundVoiceModelId: modelId });
      return;
    }
    patchDeviceConfig({ textToSpeechModelId: modelId });
    updateSpeechDraft({ textToSpeechModelId: modelId, status: 'draft' });
  };

  const selectModelWithCapabilityCheck = (target: RoutingModelTarget, modelId: string, options: RoutingModelSelectOption[], title: string) => {
    const selected = options.find((option) => option.model === modelId);
    if (!selected || selected.mismatchMessages.length === 0) {
      commitModelSelection(target, modelId);
      return;
    }
    setPendingModelSelection({ target, modelId, title, messages: selected.mismatchMessages });
  };

  const handleProcessingToggle = (
    key: 'aecEnabled' | 'ansEnabled' | 'agcEnabled',
    processingKey: keyof Pick<AudioInputProcessingContract, 'echoCancellationEnabled' | 'noiseSuppressionEnabled' | 'autoGainControlEnabled'>,
    enabled: boolean,
  ) => {
    const processing = buildInputProcessing(configDraft.devices, { [processingKey]: enabled });
    patchDeviceConfig({
      [key]: enabled,
      outboundRoute: {
        ...configDraft.devices.outboundRoute,
        input: {
          ...configDraft.devices.outboundRoute.input,
          processing,
        },
      },
    });
  };

  const handleSpeechOutputToggle = (enabled: boolean) => {
    patchDeviceConfig({
      outputSpeechEnabled: enabled,
      outboundRoute: {
        ...configDraft.devices.outboundRoute,
        mixControl: {
          ...configDraft.devices.outboundRoute.mixControl,
          translatedAudioEnabled: enabled,
        },
      },
    });
    const speechPatch: Partial<SpeechDraft> = { enabled, status: 'draft' };
    if (!enabled) speechPatch.dispatchState = 'idle';
    updateSpeechDraft(speechPatch);
  };

  const handleSubtitleOutputToggle = (enabled: boolean) => {
    patchDeviceConfig({
      outputSubtitlesEnabled: enabled,
      inboundRoute: {
        ...configDraft.devices.inboundRoute,
        outputs: updateOutputTargetEnabled(configDraft.devices, 'subtitle-engine', enabled),
      },
    });
  };

  const handleVirtualMicToggle = (enabled: boolean) => {
    patchDeviceConfig({
      virtualMicOutputEnabled: enabled,
      outboundRoute: {
        ...configDraft.devices.outboundRoute,
        outputs: updateOutboundTargetEnabled(configDraft.devices, 'virtual-mic', enabled),
      },
    });
    updateSpeechDraft({ outputTarget: enabled ? 'virtual-mic' : 'speaker', virtualMicOutputEnabled: enabled, status: 'draft' });
  };

  const handleFeedbackLoopPreventionChange = (feedbackLoopPrevention: Exclude<FeedbackLoopPrevention, 'none'>) => {
    if (feedbackLoopPrevention === 'virtual-driver' && !virtualDriverReady) return;
    patchDeviceConfig({ feedbackLoopPrevention });
    if (feedbackLoopPrevention === 'virtual-driver') {
      updateSpeechDraft({ localPlaybackEnabled: true, virtualMicOutputEnabled: true, outputTarget: 'virtual-mic', status: 'draft' });
    }
  };

  const handleInputDeviceChange = (deviceId: string) => {
    patchDeviceConfig({
      inputDeviceId: deviceId,
      outboundRoute: {
        ...configDraft.devices.outboundRoute,
        input: { ...configDraft.devices.outboundRoute.input, deviceId },
      },
    });
  };

  const handleOutputDeviceChange = (deviceId: string) => {
    patchDeviceConfig({
      outputDeviceId: deviceId,
      inboundRoute: {
        ...configDraft.devices.inboundRoute,
        outputs: configDraft.devices.inboundRoute.outputs.map((target) => (target.kind === 'speaker' ? { ...target, deviceId } : target)),
      },
      outboundRoute: {
        ...configDraft.devices.outboundRoute,
        outputs: configDraft.devices.outboundRoute.outputs.map((target) => (target.kind === 'monitor' ? { ...target, deviceId } : target)),
      },
    });
  };

  const handleMicTest = () => {
    setMicTesting(true);
    setMicTestResult(null);
    window.setTimeout(() => {
      setMicTesting(false);
      setMicTestResult('mic ok');
    }, 900);
  };

  const handleSpeakerTest = () => {
    setSpeakerTesting(true);
    setSpeakerTestResult(null);
    window.setTimeout(() => {
      setSpeakerTesting(false);
      setSpeakerTestResult('speaker ok');
    }, 900);
  };

  return (
    <div className="routing-workspace">
      <section className="routing-overview" aria-label="audio routing overview">
        <div className="routing-overview-main">
          <div className="routing-overview-node">
            <span>输出</span>
            <strong>{selectedOutputDevice?.label ?? labels.speaker}</strong>
          </div>
          <div className="routing-overview-arrow routing-overview-arrow-output-to-model" aria-hidden="true">→</div>
          <div className="routing-overview-node routing-overview-node-model">
            <span>{labels.voiceModels}</span>
            <strong>{inboundModelLabel}</strong>
            <small>{outboundModelLabel}</small>
          </div>
          <div className="routing-overview-arrow routing-overview-arrow-input-to-model" aria-hidden="true">←</div>
          <div className="routing-overview-node">
            <span>输入</span>
            <strong>{selectedInputDevice?.label ?? labels.microphone}</strong>
          </div>
          <div className="routing-overview-arrow routing-overview-arrow-model-to-output" aria-hidden="true">←</div>
        </div>
        <StatusBadge label={labels.ready} tone="ready" />
      </section>

      <section className="routing-topology">
        <article className="routing-panel">
          <div className="routing-panel-head">
            <div>
              <h3>{labels.outputDevice}</h3>
            </div>
            <StatusBadge label={labels.ready} tone={renderDevices.length > 0 ? 'ready' : 'risk'} />
          </div>

          <label className="field-stack field-span-full">
            <span>{labels.speaker}</span>
            <select className="select-input" onChange={(event) => handleOutputDeviceChange(event.target.value)} value={configDraft.devices.outputDeviceId}>
              {renderDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
              ))}
            </select>
          </label>

          <label className="routing-slider">
            <span>{labels.outputVolume}</span>
            <input max={100} min={0} onChange={(event) => patchDeviceConfig({ outputLevel: Number(event.target.value) })} type="range" value={configDraft.devices.outputLevel} />
            <strong>{configDraft.devices.outputLevel}%</strong>
          </label>

          <div className="routing-action-row">
            <button className="icon-button" disabled={speakerTesting || renderDevices.length === 0} onClick={handleSpeakerTest} type="button">
              <AppIcon name="headphones" size={15} />
              {speakerTesting ? labels.testing : labels.testSpeaker}
            </button>
            {speakerTestResult ? <span className="routing-inline-result">{speakerTestResult}</span> : null}
          </div>

          <div className="routing-output-feedback">
            <div className="routing-panel-head routing-panel-subhead">
              <div>
                <h4>{labels.feedback}</h4>
              </div>
              <StatusBadge
                label={configDraft.devices.feedbackLoopPrevention === 'none' ? labels.needsSetup : labels.current}
                tone={configDraft.devices.feedbackLoopPrevention === 'none' ? 'warning' : 'ready'}
              />
            </div>
            <div className="routing-mode-grid routing-feedback-options">
              <button
                className={configDraft.devices.feedbackLoopPrevention === 'echo-cancel' ? 'routing-mode-card routing-mode-card-active' : 'routing-mode-card'}
                onClick={() => handleFeedbackLoopPreventionChange('echo-cancel')}
                type="button"
              >
                <div>
                  <strong>{labels.echoCancel}</strong>
                  <p>{labels.echoCancelDesc}</p>
                </div>
              </button>
              <button
                className={configDraft.devices.feedbackLoopPrevention === 'virtual-driver' ? 'routing-mode-card routing-mode-card-active' : 'routing-mode-card'}
                disabled={!virtualDriverReady}
                onClick={() => handleFeedbackLoopPreventionChange('virtual-driver')}
                type="button"
              >
                <div>
                  <strong>{labels.virtualDriver}</strong>
                  <p>{virtualDriverReady ? labels.virtualDriverDesc : labels.virtualDriverDisabled}</p>
                </div>
              </button>
            </div>
          </div>
        </article>

        <article className="routing-panel routing-panel-emphasis">
          <div className="routing-panel-head">
            <div>
              <h3>{labels.voiceModels}</h3>
            </div>
            <StatusBadge label={voiceModelOptions.length > 0 ? '可用' : labels.needsSetup} tone={voiceModelOptions.length > 0 ? 'ready' : 'warning'} />
          </div>

          <RoutingModelSelect
            emptyText={labels.noModels}
            label={labels.inboundModel}
            onSelect={(modelId) => selectModelWithCapabilityCheck('inbound', modelId, inboundModelOptions, labels.unsupportedInboundTitle)}
            options={inboundModelOptions}
            value={inboundVoiceModelId}
          />

          <div className="routing-toggle-grid routing-output-toggle-grid">
            <label className="routing-toggle routing-toggle-strong">
              <input checked={configDraft.devices.outputSpeechEnabled} onChange={(event) => handleSpeechOutputToggle(event.target.checked)} type="checkbox" />
              <span>{labels.outputSpeech}</span>
            </label>
            <label className="routing-toggle routing-toggle-strong">
              <input checked={configDraft.devices.outputSubtitlesEnabled} onChange={(event) => handleSubtitleOutputToggle(event.target.checked)} type="checkbox" />
              <span>{labels.outputSubtitles}</span>
            </label>
          </div>

          <RoutingModelSelect
            emptyText={labels.noModels}
            label={labels.outboundModel}
            onSelect={(modelId) => selectModelWithCapabilityCheck('outbound', modelId, outboundModelOptions, labels.unsupportedOutboundTitle)}
            options={outboundModelOptions}
            value={outboundVoiceModelId}
          />

          <RoutingModelSelect
            emptyText={labels.noModels}
            label={labels.ttsModel}
            onSelect={(modelId) => selectModelWithCapabilityCheck('speech', modelId, speechModelOptions, labels.unsupportedInboundTitle)}
            options={speechModelOptions}
            value={speechModelId}
          />

          <div className="routing-toggle-grid routing-output-toggle-grid">
            <label className="routing-toggle routing-toggle-strong">
              <input checked={configDraft.devices.virtualMicOutputEnabled} onChange={(event) => handleVirtualMicToggle(event.target.checked)} type="checkbox" />
              <span>{labels.sendVoiceToVirtualMic}</span>
            </label>
          </div>
        </article>

        <article className="routing-panel">
          <div className="routing-panel-head">
            <div>
              <h3>{labels.inputDevice}</h3>
            </div>
            <StatusBadge label="空闲" tone={captureDevices.length > 0 ? 'ready' : 'risk'} />
          </div>

          <label className="field-stack field-span-full">
            <span>{labels.microphone}</span>
            <select className="select-input" onChange={(event) => handleInputDeviceChange(event.target.value)} value={configDraft.devices.inputDeviceId}>
              {captureDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
              ))}
            </select>
          </label>

          <label className="routing-slider">
            <span>{labels.inputLevel}</span>
            <input max={100} min={0} onChange={(event) => patchDeviceConfig({ inputLevel: Number(event.target.value) })} type="range" value={configDraft.devices.inputLevel} />
            <strong>{configDraft.devices.inputLevel}%</strong>
          </label>

          <div className="routing-toggle-grid">
            <label className="routing-toggle">
              <input checked={configDraft.devices.aecEnabled} onChange={(event) => handleProcessingToggle('aecEnabled', 'echoCancellationEnabled', event.target.checked)} type="checkbox" />
              <span>{labels.aec}</span>
            </label>
            <label className="routing-toggle">
              <input checked={configDraft.devices.ansEnabled} onChange={(event) => handleProcessingToggle('ansEnabled', 'noiseSuppressionEnabled', event.target.checked)} type="checkbox" />
              <span>{labels.ans}</span>
            </label>
            <label className="routing-toggle">
              <input checked={configDraft.devices.agcEnabled} onChange={(event) => handleProcessingToggle('agcEnabled', 'autoGainControlEnabled', event.target.checked)} type="checkbox" />
              <span>{labels.agc}</span>
            </label>
          </div>

          <div className="routing-action-row">
            <button className="icon-button" disabled={micTesting || captureDevices.length === 0} onClick={handleMicTest} type="button">
              <AppIcon name="wave" size={15} />
              {micTesting ? labels.testing : labels.testMic}
            </button>
            {micTestResult ? <span className="routing-inline-result">{micTestResult}</span> : null}
          </div>
        </article>
      </section>

      <section className="routing-lower-grid">
        <article className="routing-panel">
          <div className="routing-panel-head">
            <div>
              <h3>{labels.subtitleTranslationMode}</h3>
            </div>
          </div>
          <div className="routing-mode-grid">
            <button
              className={[
                'routing-mode-card',
                configDraft.devices.subtitleTranslationMode === 'native' ? 'routing-mode-card-active' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => patchDeviceConfig({ subtitleTranslationMode: 'native' })}
              type="button"
            >
              <div>
                <strong>{labels.nativeMode}</strong>
                <p>{labels.nativeModeDescription}</p>
              </div>
            </button>
            <button
              className={[
                'routing-mode-card',
                configDraft.devices.subtitleTranslationMode === 'secondary' ? 'routing-mode-card-active' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => patchDeviceConfig({ subtitleTranslationMode: 'secondary' })}
              type="button"
            >
              <div>
                <strong>{labels.secondaryTranslation}</strong>
                <p>{labels.secondaryTranslationDescription}</p>
              </div>
            </button>
          </div>
          {configDraft.devices.subtitleTranslationMode === 'secondary' ? (
            <RoutingModelSelect
              allowEmpty
              emptyText={labels.noModels}
              label={labels.textTranslationModel}
              onSelect={(modelId) => patchDeviceConfig({ subtitleTranslationModelId: modelId })}
              options={subtitleTranslationModelOptions}
              placeholder={labels.notSelected}
              value={configDraft.devices.subtitleTranslationModelId}
            />
          ) : null}
        </article>

        <article className="routing-panel">
          <div className="routing-panel-head">
            <div>
              <h3>{labels.runtimeStatus}</h3>
            </div>
            <StatusBadge label={labels.ready} tone="ready" />
          </div>
          <div className="routing-metric-grid">
            <div><span>输入缓冲</span><strong>{audioRuntimeSnapshot.inbound.bufferAheadMs} ms</strong></div>
            <div><span>已采集帧</span><strong>{audioRuntimeSnapshot.inbound.framesCaptured}</strong></div>
            <div><span>字幕队列</span><strong>{audioRuntimeSnapshot.subtitleOverlay.queueDepth}</strong></div>
            <div><span>语音队列</span><strong>{audioRuntimeSnapshot.speech.queueDepth}</strong></div>
          </div>
        </article>
      </section>

      {pendingModelSelection ? (
        <div className="routing-modal-backdrop" onClick={() => setPendingModelSelection(null)} role="presentation">
          <div aria-modal="true" className="routing-modal" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="routing-modal-head">
              <h3>{pendingModelSelection.title}</h3>
            </div>
            <div className="routing-modal-body">
              <p>model unsupported</p>
              <ul>
                {pendingModelSelection.messages.map((message) => <li key={message}>{message}</li>)}
              </ul>
            </div>
            <div className="routing-modal-actions">
              <button className="action-button" onClick={() => {
                commitModelSelection(pendingModelSelection.target, pendingModelSelection.modelId);
                setPendingModelSelection(null);
              }} type="button">
                {labels.keepSelection}
              </button>
              <button className="icon-button" onClick={() => setPendingModelSelection(null)} type="button">
                {labels.cancelSelection}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const audioRoutingPageHelpers = {
  buildInputProcessing,
  updateOutputTargetEnabled,
  updateOutboundTargetEnabled,
  hasCapability,
  isVoiceModel,
  resolveSelectedModel,
  sortRoutingModelOptions,
  RoutingModelSelect,
};

export default AudioRoutingPage;
