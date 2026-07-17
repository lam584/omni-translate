import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCallback } from 'react';
import { useAudioDeviceTestController } from './audio-routing/useAudioDeviceTestController';
import ChainFlow from './audio-routing/ChainFlow';
import {
  detectScenarioCapabilities,
  isVoiceModel,
  resolveSelectedModel,
  supportsRoutingScenario,
  type RoutingModelOption,
  type ScenarioId,
} from './audio-routing/routingModelCatalog';
import AudioLevelMeter from '../components/audio/AudioLevelMeter';
import AppIcon from '../components/icons/AppIcon';
import StatusBadge from '../components/page/StatusBadge';
import { providerTemplates } from '../mocks/provider-templates';
import type { AudioInputProcessingContract } from '../schema/audio-contract';
import type { DeviceDraft, FeedbackLoopPrevention, ProviderDraft, SpeechDraft } from '../schema/config';
import { useAppStore } from '../stores/app-store';
import { buildAudioRuntimeBadges } from '../utils/audio-runtime-badges';
import { readCustomProviderTemplates } from '../utils/custom-provider-templates';
import { resolveProviderModelCapabilities } from '../utils/provider-model-capabilities';
import { PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT, buildProviderTemplateCatalogEntries, readProviderTemplateCatalogPreferences } from '../utils/provider-template-catalog';
import ScenarioCard, { tWithDefault, type ScenarioCardProps } from './audio-routing/ScenarioCard';



function AudioRoutingPage() {
  const { t } = useTranslation();
  const configDraft = useAppStore((state) => state.configDraft);
  const audioRuntimeSnapshot = useAppStore((state) => state.audioRuntimeSnapshot);
  const updateDeviceDraft = useAppStore((state) => state.updateDeviceDraft);
  const updateSpeechDraft = useAppStore((state) => state.updateSpeechDraft);
  const [customTemplates] = useState(() => readCustomProviderTemplates());
  const [catalogPreferences, setCatalogPreferences] = useState(() => readProviderTemplateCatalogPreferences());
  const resolveDeviceTestLabel = useCallback(
    (kind: 'microphone' | 'speaker') => tWithDefault(t, kind === 'microphone' ? 'audioRouting.micTestPassed' : 'audioRouting.speakerTestPassed'),
    [t],
  );
  const deviceTests = useAudioDeviceTestController(resolveDeviceTestLabel);

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
          if (existing) continue;
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
  const inboundModelOptions = useMemo(() => voiceModelOptions.filter((model) => supportsRoutingScenario(model, 'inbound')), [voiceModelOptions]);
  const outboundModelOptions = useMemo(() => voiceModelOptions.filter((model) => supportsRoutingScenario(model, 'outbound')), [voiceModelOptions]);
  const secondarySttModelOptions = useMemo(() => voiceModelOptions.filter((model) => supportsRoutingScenario(model, 'inboundSecondary')), [voiceModelOptions]);
  const ttsModelOptions = useMemo(() => voiceModelOptions.filter((model) => supportsRoutingScenario(model, 'tts')), [voiceModelOptions]);
  const textModelOptions = useMemo(
    () => allModelOptions
      .filter((model) => !isVoiceModel(model))
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [allModelOptions],
  );

  const captureDevices = audioRuntimeSnapshot.captureDevices;
  const renderDevices = audioRuntimeSnapshot.renderDevices;
  const physicalRenderDevices = renderDevices.filter((device) => ![
    device.deviceId,
    device.label,
    device.interfaceName,
  ].some((value) => value.includes('Omni Translate Virtual Speaker')));
  const selectedInputAvailable = captureDevices.some((device) => device.deviceId === configDraft.devices.inputDeviceId);
  const selectedOutputAvailable = physicalRenderDevices.some((device) => device.deviceId === configDraft.devices.outputDeviceId);
  const unavailableDeviceLabel = `${tWithDefault(t, 'audioRouting.status.missing')}: ${tWithDefault(t, 'audioRouting.notSelected')}`;

  const inboundModelOption = resolveSelectedModel(inboundModelOptions, configDraft.devices.inboundVoiceModelId);
  const outboundModelOption = resolveSelectedModel(outboundModelOptions, configDraft.devices.outboundVoiceModelId);
  const subtitleModelOption = resolveSelectedModel(textModelOptions, configDraft.devices.subtitleTranslationModelId);
  const ttsModelOption = resolveSelectedModel(ttsModelOptions, configDraft.devices.textToSpeechModelId);

  const subtitleMode = configDraft.devices.subtitleTranslationMode;
  const isNativeSubtitle = subtitleMode === 'native';
  const mutedHint = tWithDefault(t, 'audioRouting.cardDisabledHint');
  const nativeAudioUnsupported =
    isNativeSubtitle
    && !resolveSelectedModel(ttsModelOptions, configDraft.devices.textToSpeechModelId || configDraft.speech.textToSpeechModelId || configDraft.devices.outboundVoiceModelId)?.capabilities.includes('speech-to-speech');

  const runtimeBadges = useMemo(() => buildAudioRuntimeBadges(
    audioRuntimeSnapshot,
    Boolean(inboundModelOption),
    Boolean(outboundModelOption),
    {
      capture: {
        ready: tWithDefault(t, 'audioRouting.status.capturingReady'),
        capturing: tWithDefault(t, 'audioRouting.status.capturing'),
        error: tWithDefault(t, 'audioRouting.status.error'),
        armed: tWithDefault(t, 'audioRouting.status.armed'),
        idle: tWithDefault(t, 'audioRouting.status.idle'),
        preview: tWithDefault(t, 'audioRouting.status.preview'),
      },
      output: {
        ready: tWithDefault(t, 'audioRouting.status.playingReady'),
        error: tWithDefault(t, 'audioRouting.status.error'),
        degraded: tWithDefault(t, 'audioRouting.status.degraded'),
        preview: tWithDefault(t, 'audioRouting.status.preview'),
        missing: tWithDefault(t, 'audioRouting.status.missing'),
      },
      inboundModels: {
        ready: tWithDefault(t, 'audioRouting.status.ready'),
        degraded: tWithDefault(t, 'audioRouting.status.degraded'),
        preview: tWithDefault(t, 'audioRouting.status.preview'),
        missing: tWithDefault(t, 'audioRouting.status.missing'),
      },
      outboundModels: {
        ready: tWithDefault(t, 'audioRouting.status.ready'),
        degraded: tWithDefault(t, 'audioRouting.status.degraded'),
        preview: tWithDefault(t, 'audioRouting.status.preview'),
        missing: tWithDefault(t, 'audioRouting.status.missing'),
      },
    },
  ), [audioRuntimeSnapshot, inboundModelOption, outboundModelOption, t]);

  const patchDeviceConfig = (patch: Partial<DeviceDraft>) => {
    updateDeviceDraft({ ...patch, status: 'ready' });
  };

  const patchSpeechDraft = (patch: Partial<SpeechDraft>) => {
    updateSpeechDraft({ ...patch, status: 'draft' });
  };

  const handleProcessingToggle = (
    key: 'aecEnabled' | 'ansEnabled' | 'agcEnabled',
    processingKey: keyof Pick<AudioInputProcessingContract, 'echoCancellationEnabled' | 'noiseSuppressionEnabled' | 'autoGainControlEnabled'>,
    enabled: boolean,
  ) => {
    const processing: AudioInputProcessingContract = {
      inputLevel: configDraft.devices.outboundRoute.input.processing?.inputLevel ?? configDraft.devices.inputLevel,
      echoCancellationEnabled: configDraft.devices.outboundRoute.input.processing?.echoCancellationEnabled ?? configDraft.devices.aecEnabled,
      noiseSuppressionEnabled: configDraft.devices.outboundRoute.input.processing?.noiseSuppressionEnabled ?? configDraft.devices.ansEnabled,
      autoGainControlEnabled: configDraft.devices.outboundRoute.input.processing?.autoGainControlEnabled ?? configDraft.devices.agcEnabled,
      [processingKey]: enabled,
    };
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
    const speechPatch: Partial<SpeechDraft> = {
      enabled,
      status: 'draft',
      translationAudioSource: enabled ? 'subtitle-tts' : 'auto',
    };
    if (!enabled) speechPatch.dispatchState = 'idle';
    patchSpeechDraft(speechPatch);
  };

  const handleSubtitleOutputToggle = (enabled: boolean) => {
    patchDeviceConfig({
      outputSubtitlesEnabled: enabled,
      inboundRoute: {
        ...configDraft.devices.inboundRoute,
        outputs: configDraft.devices.inboundRoute.outputs.map((target) => (target.kind === 'subtitle-engine' ? { ...target, enabled } : target)),
      },
    });
  };

  const handleVirtualMicToggle = (enabled: boolean) => {
    patchDeviceConfig({
      virtualMicOutputEnabled: enabled,
      outboundRoute: {
        ...configDraft.devices.outboundRoute,
        outputs: configDraft.devices.outboundRoute.outputs.map((target) => (target.kind === 'virtual-mic' ? { ...target, enabled } : target)),
      },
    });
    patchSpeechDraft({ outputTarget: enabled ? 'virtual-mic' : 'speaker', virtualMicOutputEnabled: enabled });
  };

  const handleTtsEnabledToggle = (enabled: boolean) => {
    const speechPatch: Partial<SpeechDraft> = { enabled, status: 'draft' };
    if (!enabled) speechPatch.dispatchState = 'idle';
    patchSpeechDraft(speechPatch);
  };

  const setSecondaryTranslationModeFromCards = (subtitleEnabled: boolean, secondaryAudioEnabled: boolean) => {
    patchDeviceConfig({
      subtitleTranslationMode: subtitleEnabled || secondaryAudioEnabled ? 'secondary' : 'native',
    });
  };

  const handleSubtitleCardEnabledToggle = (enabled: boolean) => {
    handleSubtitleOutputToggle(enabled);
    setSecondaryTranslationModeFromCards(enabled, configDraft.devices.outputSpeechEnabled);
  };

  const handleSecondaryAudioCardEnabledToggle = (enabled: boolean) => {
    handleSpeechOutputToggle(enabled);
    setSecondaryTranslationModeFromCards(configDraft.devices.outputSubtitlesEnabled, enabled);
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

  const handleMicTest = deviceTests.testMicrophone;
  const handleSpeakerTest = deviceTests.testSpeaker;
  const micTesting = deviceTests.microphone.testing;
  const micTestResult = deviceTests.microphone.result;
  const micEnergyDb = deviceTests.microphone.energyDb;
  const speakerTesting = deviceTests.speaker.testing;
  const speakerTestResult = deviceTests.speaker.result;
  const speakerEnergyDb = deviceTests.speaker.energyDb;

  const selectModel = (scenario: ScenarioId, modelId: string) => {
    switch (scenario) {
      case 'inbound':
        patchDeviceConfig({ inboundVoiceModelId: modelId });
        return;
      case 'inboundSecondary':
        patchDeviceConfig({ inboundSecondaryAudioModelId: modelId });
        return;
      case 'subtitle':
        patchDeviceConfig({ subtitleTranslationModelId: modelId });
        return;
      case 'outbound':
        patchDeviceConfig({ outboundVoiceModelId: modelId });
        return;
      case 'tts':
        patchDeviceConfig({ textToSpeechModelId: modelId });
        patchSpeechDraft({ textToSpeechModelId: modelId });
        return;
      default:
        return;
    }
  };

  const setFeedbackMode = (mode: Exclude<FeedbackLoopPrevention, 'none'>) => {
    patchDeviceConfig({ feedbackLoopPrevention: mode });
  };

  const inboundSecondaryModelOption = resolveSelectedModel(
    secondarySttModelOptions,
    configDraft.devices.inboundSecondaryAudioModelId,
  );
  const inboundScenarioCards: ScenarioCardProps[] = [{
    active: true, caption: tWithDefault(t, 'audioRouting.scenarioInboundCaption'), icon: 'headphones',
    modelName: inboundModelOption?.displayName ?? '—', modelOptions: inboundModelOptions, modelProvider: inboundModelOption?.description ?? '',
    onSelect: (modelId) => selectModel('inbound', modelId),
    tags: detectScenarioCapabilities(inboundModelOption, 'inbound'), title: tWithDefault(t, 'audioRouting.scenarioInboundTitle'), value: configDraft.devices.inboundVoiceModelId,
  }];
  const secondaryScenarioCards: ScenarioCardProps[] = [
    {
      caption: tWithDefault(t, 'audioRouting.scenarioSubtitleCaption'), enabled: configDraft.devices.outputSubtitlesEnabled,
      enableLabel: tWithDefault(t, 'audioRouting.subtitleTranslationCardToggle'), icon: 'book',
      modelName: subtitleModelOption?.displayName ?? '—', modelOptions: textModelOptions, modelProvider: subtitleModelOption?.description ?? '', mutedHint,
      onEnabledChange: handleSubtitleCardEnabledToggle,
      onSelect: (modelId) => selectModel('subtitle', modelId),
      tags: detectScenarioCapabilities(subtitleModelOption, 'subtitle'), title: tWithDefault(t, 'audioRouting.scenarioSubtitleTitle'), value: configDraft.devices.subtitleTranslationModelId,
    },
    {
      caption: tWithDefault(t, 'audioRouting.scenarioInboundSecondaryCaption'), enabled: configDraft.devices.outputSpeechEnabled,
      enableLabel: tWithDefault(t, 'audioRouting.secondaryAudioCardToggle'), icon: 'subtitles',
      modelName: inboundSecondaryModelOption?.displayName ?? '—', modelOptions: secondarySttModelOptions, modelProvider: inboundSecondaryModelOption?.description ?? '', mutedHint,
      onEnabledChange: handleSecondaryAudioCardEnabledToggle,
      onSelect: (modelId) => selectModel('inboundSecondary', modelId),
      tags: detectScenarioCapabilities(inboundSecondaryModelOption, 'inboundSecondary'), title: tWithDefault(t, 'audioRouting.scenarioInboundSecondaryTitle'), value: configDraft.devices.inboundSecondaryAudioModelId,
    },
  ];
  const outboundScenarioCards: ScenarioCardProps[] = [
    {
      active: configDraft.devices.virtualMicOutputEnabled, caption: tWithDefault(t, 'audioRouting.scenarioOutboundCaption'),
      enableChecked: configDraft.devices.virtualMicOutputEnabled, enableLabel: tWithDefault(t, 'audioRouting.sendVoiceToVirtualMic'), icon: 'mic',
      modelName: outboundModelOption?.displayName ?? '—', modelOptions: outboundModelOptions, modelProvider: outboundModelOption?.description ?? '',
      onEnabledChange: handleVirtualMicToggle,
      onSelect: (modelId) => selectModel('outbound', modelId),
      tags: detectScenarioCapabilities(outboundModelOption, 'outbound'), title: tWithDefault(t, 'audioRouting.scenarioOutboundTitle'), value: configDraft.devices.outboundVoiceModelId,
    },
    {
      active: configDraft.speech.enabled, caption: tWithDefault(t, 'audioRouting.scenarioTtsCaption'),
      enableChecked: configDraft.speech.enabled, enableLabel: tWithDefault(t, 'audioRouting.scenarioTtsRole'), icon: 'spark',
      modelName: ttsModelOption?.displayName ?? '—', modelOptions: ttsModelOptions, modelProvider: ttsModelOption?.description ?? '',
      onEnabledChange: handleTtsEnabledToggle,
      onSelect: (modelId) => selectModel('tts', modelId),
      tags: detectScenarioCapabilities(ttsModelOption, 'tts'), title: tWithDefault(t, 'audioRouting.scenarioTtsTitle'), value: configDraft.devices.textToSpeechModelId,
    },
  ];

  return (
    <div className="routing-workspace-v9">
      <section className="routing-top-grid">
        <article className="routing-panel routing-capture-panel">
          <div className="routing-panel-head">
            <div>
              <div className="routing-panel-kicker">{tWithDefault(t, 'audioRouting.chainOutbound')}</div>
              <h3>{tWithDefault(t, 'audioRouting.capturePanelTitle')}</h3>
              <p className="routing-panel-subtitle">{tWithDefault(t, 'audioRouting.capturePanelSubtitle')}</p>
            </div>
            <StatusBadge label={runtimeBadges.capture.label} pulse={runtimeBadges.capture.pulse} tone={runtimeBadges.capture.tone} />
          </div>
          <ChainFlow
            direction="outbound"
            directionLabel={tWithDefault(t, 'audioRouting.chainOutbound')}
            inboundLabel={tWithDefault(t, 'audioRouting.chainMicrophone')}
            modelLabel={tWithDefault(t, 'audioRouting.chainOutboundModel')}
            modelSubtitle={outboundModelOption ? tWithDefault(t, 'audioRouting.modelSubtitleSttTranslationSpeech') : '—'}
            outboundLabel={tWithDefault(t, 'audioRouting.chainVirtualMicSpeaker')}
            outboundSubtitle={tWithDefault(t, 'audioRouting.chainReturnToPeer')}
          />

          <label className="field-stack field-span-full">
            <span>{tWithDefault(t, 'audioRouting.microphone')}</span>
            <select className="select-input" onChange={(event) => handleInputDeviceChange(event.target.value)} value={configDraft.devices.inputDeviceId}>
              {!selectedInputAvailable && <option disabled value={configDraft.devices.inputDeviceId}>{unavailableDeviceLabel}</option>}
              {captureDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
              ))}
            </select>
          </label>

          <div className="routing-test-row">
            <div className="routing-test-row-controls">
              <button className="icon-button" disabled={micTesting || !selectedInputAvailable} onClick={handleMicTest} type="button">
                <AppIcon name="wave" size={15} />
                {micTesting ? tWithDefault(t, 'audioRouting.testing') : tWithDefault(t, 'audioRouting.testMic')}
              </button>
              {micTestResult ? <span className="routing-inline-result">{micTestResult}</span> : null}
            </div>
            <div className="routing-test-meter">
              <AudioLevelMeter energyDb={micEnergyDb} label="" vadState="speech" captureActive={audioRuntimeSnapshot.inbound.captureState === 'capturing' && audioRuntimeSnapshot.inbound.streamBound} />
            </div>
          </div>

          <div className="routing-slider-row">
            <div className="routing-slider-head">
              <span className="routing-slider-label">{tWithDefault(t, 'audioRouting.inputLevel')}</span>
              <strong>{configDraft.devices.inputLevel}%</strong>
            </div>
            <input className="routing-slider-input" max={100} min={0} onChange={(event) => patchDeviceConfig({ inputLevel: Number(event.target.value) })} type="range" value={configDraft.devices.inputLevel} />
          </div>

          <div className="routing-toggle-stack">
            <label className={['routing-toggle-pill', configDraft.devices.aecEnabled ? 'routing-toggle-pill-on' : ''].join(' ')}>
              <input checked={configDraft.devices.aecEnabled} onChange={(event) => handleProcessingToggle('aecEnabled', 'echoCancellationEnabled', event.target.checked)} type="checkbox" />
              <span>{tWithDefault(t, 'audioRouting.aecEchoCancellation')}</span>
            </label>
            <label className={['routing-toggle-pill', configDraft.devices.ansEnabled ? 'routing-toggle-pill-on' : ''].join(' ')}>
              <input checked={configDraft.devices.ansEnabled} onChange={(event) => handleProcessingToggle('ansEnabled', 'noiseSuppressionEnabled', event.target.checked)} type="checkbox" />
              <span>{tWithDefault(t, 'audioRouting.ansNoiseSuppression')}</span>
            </label>
            <label className={['routing-toggle-pill', configDraft.devices.agcEnabled ? 'routing-toggle-pill-on' : ''].join(' ')}>
              <input checked={configDraft.devices.agcEnabled} onChange={(event) => handleProcessingToggle('agcEnabled', 'autoGainControlEnabled', event.target.checked)} type="checkbox" />
              <span>{tWithDefault(t, 'audioRouting.agcAutoGain')}</span>
            </label>
          </div>
        </article>

        <article className="routing-panel routing-output-panel">
          <div className="routing-panel-head">
            <div>
              <div className="routing-panel-kicker">{tWithDefault(t, 'audioRouting.chainInbound')}</div>
              <h3>{tWithDefault(t, 'audioRouting.outputPanelTitle')}</h3>
              <p className="routing-panel-subtitle">{tWithDefault(t, 'audioRouting.outputPanelSubtitle')}</p>
            </div>
            <StatusBadge label={runtimeBadges.output.label} pulse={runtimeBadges.output.pulse} tone={runtimeBadges.output.tone} />
          </div>
          <ChainFlow
            direction="inbound"
            directionLabel={tWithDefault(t, 'audioRouting.chainInbound')}
            inboundLabel={tWithDefault(t, 'audioRouting.chainSystemAudio')}
            modelLabel={tWithDefault(t, 'audioRouting.chainInboundModel')}
            modelSubtitle={inboundModelOption ? tWithDefault(t, 'audioRouting.modelSubtitleSttTranslation') : '—'}
            outboundLabel={tWithDefault(t, 'audioRouting.chainSubtitleTranslated')}
            outboundSubtitle={tWithDefault(t, 'audioRouting.chainLocalPlayback')}
          />

          <label className="field-stack field-span-full">
            <span>{tWithDefault(t, 'audioRouting.speaker')}</span>
            <select className="select-input" onChange={(event) => handleOutputDeviceChange(event.target.value)} value={configDraft.devices.outputDeviceId}>
              {!selectedOutputAvailable && <option disabled value={configDraft.devices.outputDeviceId}>{unavailableDeviceLabel}</option>}
              {physicalRenderDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
              ))}
            </select>
          </label>

          <div className="routing-test-row">
            <div className="routing-test-row-controls">
              <button className="icon-button" disabled={speakerTesting || !selectedOutputAvailable} onClick={handleSpeakerTest} type="button">
                <AppIcon name="headphones" size={15} />
                {speakerTesting ? tWithDefault(t, 'audioRouting.testing') : tWithDefault(t, 'audioRouting.testSpeaker')}
              </button>
              {speakerTestResult ? <span className="routing-inline-result">{speakerTestResult}</span> : null}
            </div>
            <div className="routing-test-meter">
              <AudioLevelMeter energyDb={speakerEnergyDb} label="" vadState={speakerTesting ? 'speech' : 'silence'} />
            </div>
          </div>

          <div className="routing-slider-row">
            <div className="routing-slider-head">
              <span className="routing-slider-label">{tWithDefault(t, 'audioRouting.outputVolume')}</span>
              <strong>{configDraft.devices.outputLevel}%</strong>
            </div>
            <input className="routing-slider-input" max={100} min={0} onChange={(event) => patchDeviceConfig({ outputLevel: Number(event.target.value) })} type="range" value={configDraft.devices.outputLevel} />
          </div>

          <div className="routing-feedback">
            <div className="routing-feedback-head">
              <h4>{tWithDefault(t, 'audioRouting.feedbackTitle')}</h4>
              <p>{tWithDefault(t, 'audioRouting.feedbackSubtitle')}</p>
            </div>
            <div className="routing-feedback-options" role="radiogroup" aria-label={tWithDefault(t, 'audioRouting.feedbackTitle')}>
              <button
                aria-checked={configDraft.devices.feedbackLoopPrevention === 'echo-cancel'}
                className={['routing-feedback-option', configDraft.devices.feedbackLoopPrevention === 'echo-cancel' ? 'routing-feedback-option-active' : ''].join(' ')}
                onClick={() => setFeedbackMode('echo-cancel')}
                role="radio"
                type="button"
              >
                <span className="routing-feedback-radio" aria-hidden="true">
                  {configDraft.devices.feedbackLoopPrevention === 'echo-cancel' ? <AppIcon name="check" size={11} /> : null}
                </span>
                <strong>{tWithDefault(t, 'audioRouting.feedbackEchoLabel')}</strong>
              </button>
              <button
                aria-checked={configDraft.devices.feedbackLoopPrevention === 'virtual-driver'}
                className={['routing-feedback-option', configDraft.devices.feedbackLoopPrevention === 'virtual-driver' ? 'routing-feedback-option-active' : ''].join(' ')}
                onClick={() => setFeedbackMode('virtual-driver')}
                role="radio"
                type="button"
              >
                <span className="routing-feedback-radio" aria-hidden="true">
                  {configDraft.devices.feedbackLoopPrevention === 'virtual-driver' ? <AppIcon name="check" size={11} /> : null}
                </span>
                <strong>{tWithDefault(t, 'audioRouting.feedbackVirtualDriverLabel')}</strong>
              </button>
            </div>
            <p className="routing-feedback-desc">
              {configDraft.devices.feedbackLoopPrevention === 'virtual-driver'
                ? tWithDefault(t, 'audioRouting.feedbackVirtualDriverDesc')
                : tWithDefault(t, 'audioRouting.feedbackEchoDesc')}
            </p>
          </div>
        </article>
      </section>

      <section className="routing-models-grid">
        <article className="routing-panel routing-models-inbound-panel">
          <div className="routing-panel-head">
            <div>
              <div className="routing-panel-kicker">{tWithDefault(t, 'audioRouting.inboundKicker')}</div>
              <h3>{tWithDefault(t, 'audioRouting.inboundModelsPanelTitle')}</h3>
              <p className="routing-panel-subtitle">{tWithDefault(t, 'audioRouting.inboundModelsPanelSubtitle')}</p>
            </div>
            <StatusBadge label={runtimeBadges.inboundModels.label} pulse={runtimeBadges.inboundModels.pulse} tone={runtimeBadges.inboundModels.tone} />
          </div>

          {nativeAudioUnsupported ? <p className="routing-inline-result">{tWithDefault(t, 'audioRouting.unsupportedNativeAudio')}</p> : null}

          <div className="scenario-grid scenario-grid-routing">
            {inboundScenarioCards.map((card) => <ScenarioCard key={card.title} {...card} />)}
            <section className={['routing-secondary-group', !isNativeSubtitle ? 'routing-secondary-group-on' : ''].join(' ')}>
              <header className="routing-secondary-group-head">
                <div>
                  <div className="routing-panel-kicker">{tWithDefault(t, 'audioRouting.secondaryTranslation')}</div>
                  <h4>{tWithDefault(t, 'audioRouting.secondaryTranslationDescription')}</h4>
                </div>
              </header>
              <div className="scenario-grid scenario-grid-routing routing-secondary-group-grid">
                {secondaryScenarioCards.map((card) => <ScenarioCard key={card.title} {...card} />)}
              </div>
            </section>
          </div>
        </article>

        <article className="routing-panel routing-models-outbound-panel">
          <div className="routing-panel-head">
            <div>
              <div className="routing-panel-kicker">{tWithDefault(t, 'audioRouting.outboundKicker')}</div>
              <h3>{tWithDefault(t, 'audioRouting.outboundModelsPanelTitle')}</h3>
              <p className="routing-panel-subtitle">{tWithDefault(t, 'audioRouting.outboundModelsPanelSubtitle')}</p>
            </div>
            <StatusBadge label={runtimeBadges.outboundModels.label} pulse={runtimeBadges.outboundModels.pulse} tone={runtimeBadges.outboundModels.tone} />
          </div>

          <div className="scenario-grid scenario-grid-routing">
            {outboundScenarioCards.map((card) => <ScenarioCard key={card.title} {...card} />)}
          </div>
        </article>
      </section>

    </div>
  );
}

export const audioRoutingPageHelpers = {
  ChainFlow,
  ScenarioCard,
  tWithDefault,
  isVoiceModel,
  resolveSelectedModel,
  detectScenarioCapabilities,
  supportsRoutingScenario,
};

export default AudioRoutingPage;
