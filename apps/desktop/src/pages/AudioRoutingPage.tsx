import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AudioLevelMeter from '../components/audio/AudioLevelMeter';
import AppIcon from '../components/icons/AppIcon';
import type { AppIconName } from '../components/icons/AppIcon';
import StatusBadge from '../components/page/StatusBadge';
import { providerTemplates } from '../mocks/provider-templates';
import type { AudioInputProcessingContract } from '../schema/audio-contract';
import type { DeviceDraft, FeedbackLoopPrevention, ProviderDraft, SpeechDraft, SubtitleTranslationMode } from '../schema/config';
import { useAppStore } from '../stores/app-store';
import { buildAudioRuntimeBadges } from '../utils/audio-runtime-badges';
import { readCustomProviderTemplates } from '../utils/custom-provider-templates';
import { resolveProviderModelCapabilities } from '../utils/provider-model-capabilities';
import { PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT, buildProviderTemplateCatalogEntries, readProviderTemplateCatalogPreferences } from '../utils/provider-template-catalog';
import type { ModelPreset } from '../schema/provider-template';

type ScenarioId = 'inbound' | 'inboundSecondary' | 'subtitle' | 'outbound' | 'tts';
type ScenarioCapability = 'stt' | 'translation' | 'subtitle' | 'speech' | 'tts';

const T_DEFAULTS: Record<string, string> = {
  'audioRouting.pageTitle': 'Audio Routing',
  'audioRouting.pageSubtitle': 'White surface · embedded flow · single model entry · live save · mobile-friendly',
  'audioRouting.capturePanelTitle': 'Capture',
  'audioRouting.capturePanelSubtitle': 'Microphone, noise reduction, gain',
  'audioRouting.outputPanelTitle': 'Output',
  'audioRouting.outputPanelSubtitle': 'Speaker, volume, feedback suppression',
  'audioRouting.inboundModelsPanelTitle': 'Listening models',
  'audioRouting.inboundModelsPanelSubtitle': "Models for the peer's audio · 3 scenarios · subtitle mode toggles affected cards",
  'audioRouting.outboundModelsPanelTitle': 'Replying models',
  'audioRouting.outboundModelsPanelSubtitle': 'Models for your translated voice · 2 scenarios',
  'audioRouting.inboundKicker': 'Listening',
  'audioRouting.outboundKicker': 'Replying',
  'audioRouting.autoSaved': 'Changes saved automatically',
  'audioRouting.savedJustNow': 'Saved just now',
  'audioRouting.chainInbound': 'Speak',
  'audioRouting.chainOutbound': 'Listen',
  'audioRouting.chainSystemAudio': 'System / peer audio',
  'audioRouting.chainInboundModel': 'Listening model',
  'audioRouting.chainSubtitleTranslated': 'Subtitle + translation',
  'audioRouting.chainLocalPlayback': 'Local playback',
  'audioRouting.chainMicrophone': 'Microphone',
  'audioRouting.chainOutboundModel': 'Replying model',
  'audioRouting.chainVirtualMicSpeaker': 'Virtual mic / speaker',
  'audioRouting.chainReturnToPeer': 'Return to peer',
  'audioRouting.scenarioInboundTitle': 'Listen to them',
  'audioRouting.scenarioInboundCaption': 'Peer audio → subtitle + translation (Omni full pipeline)',
  'audioRouting.scenarioInboundRole': 'Inbound listening',
  'audioRouting.scenarioInboundSubtitleSecondary': 'Inbound listening · secondary',
  'audioRouting.scenarioInboundSecondaryTitle': 'Listen to them · secondary audio',
  'audioRouting.scenarioInboundSecondaryCaption': 'Peer audio → source text (fast STT, optional Omni replacement)',
  'audioRouting.scenarioInboundSecondaryRole': 'Inbound secondary TTS',
  'audioRouting.scenarioSubtitleTitle': 'Subtitle translation',
  'audioRouting.scenarioSubtitleCaption': 'Source text → target text (shares source with "Secondary TTS")',
  'audioRouting.scenarioSubtitleRole': 'Subtitle translation',
  'audioRouting.scenarioOutboundTitle': 'Speak to them',
  'audioRouting.scenarioOutboundCaption': 'My microphone → translated speech',
  'audioRouting.scenarioOutboundRole': 'Outbound speaking',
  'audioRouting.scenarioTtsTitle': 'Type-to-speech TTS',
  'audioRouting.scenarioTtsCaption': 'Typed text → translated speech (no-mic scenarios)',
  'audioRouting.scenarioTtsRole': 'Standalone TTS',
  'audioRouting.outputChannelsHeader': 'Output channels · decide where the model output goes',
  'audioRouting.outputChannelsTitle': 'Output channels',
  'audioRouting.subtitleModeToggleLabel': 'Subtitle translation mode',
  'audioRouting.subtitleModeNativeShort': '⚡ Native',
  'audioRouting.subtitleModeSecondaryShort': '📋 Secondary',
  'audioRouting.cardDisabledHint': 'This card is disabled · enable it to edit the model',
  'audioRouting.secondaryAudioCardToggle': 'Enable secondary audio',
  'audioRouting.subtitleTranslationCardToggle': 'Enable subtitle translation',
  'audioRouting.outputTranslatedSpeech': 'Output translated speech',
  'audioRouting.outputTranslatedSubtitles': 'Output translated subtitles',
  'audioRouting.sendVoiceToVirtualMic': 'Send translated voice to virtual microphone',
  'audioRouting.unsupportedNativeAudio': 'Current model does not support Omni native audio; session will keep source audio and subtitles only.',
  'audioRouting.speaker': 'Speaker',
  'audioRouting.microphone': 'Microphone',
  'audioRouting.inputLevel': 'Input level',
  'audioRouting.outputVolume': 'Output volume',
  'audioRouting.aecEchoCancellation': 'AEC echo cancellation',
  'audioRouting.ansNoiseSuppression': 'ANS noise suppression',
  'audioRouting.agcAutoGain': 'AGC auto gain',
  'audioRouting.testMic': 'Test mic',
  'audioRouting.testSpeaker': 'Test speaker',
  'audioRouting.testing': 'Testing...',
  'audioRouting.speakerTestPassed': 'Speaker test passed',
  'audioRouting.micTestPassed': 'Mic test passed',
  'audioRouting.noProviderModels': 'Current provider has no available models',
  'audioRouting.subtitleTranslationMode': 'Subtitle translation mode',
  'audioRouting.nativeMode': 'Native mode',
  'audioRouting.secondaryTranslation': 'Secondary translation',
  'audioRouting.textTranslationModel': 'Text translation model',
  'audioRouting.notSelected': 'Not selected',
  'audioRouting.feedbackTitle': 'Feedback suppression',
  'audioRouting.feedbackSubtitle': 'Prevent translated speech from being re-captured',
  'audioRouting.feedbackEchoLabel': 'Echo cancellation',
  'audioRouting.feedbackVirtualDriverLabel': 'Virtual driver',
  'audioRouting.feedbackEchoDesc': 'Subtract played audio from the captured signal in real time. No extra driver required.',
  'audioRouting.feedbackVirtualDriverDesc': 'Set the player or Windows output to Omni Translate Virtual Speaker. Bridge captures the original audio there, mixes translated speech, and plays the result on the selected physical speaker.',
  'audioRouting.tagStt': 'STT',
  'audioRouting.tagTranslation': 'Translation',
  'audioRouting.tagSubtitle': 'Subtitle',
  'audioRouting.tagSpeech': 'Speech',
  'audioRouting.tagTts': 'TTS',
  'audioRouting.status.ready': 'Ready',
  'audioRouting.status.needsSetup': 'Needs setup',
  'audioRouting.status.available': 'Available',
  'audioRouting.status.preview': 'Preview',
  'audioRouting.status.capturing': 'Capturing',
  'audioRouting.status.capturingReady': 'Live',
  'audioRouting.status.playingReady': 'Live',
  'audioRouting.status.armed': 'Armed',
  'audioRouting.status.idle': 'Idle',
  'audioRouting.status.error': 'Error',
  'audioRouting.status.degraded': 'Degraded',
  'audioRouting.status.missing': 'Not connected',
};

function tWithDefault(t: (key: string, options?: { defaultValue?: string }) => string, key: string): string {
  return t(key, { defaultValue: T_DEFAULTS[key] ?? key });
}

type RoutingModelOption = ModelPreset & {
  providerTemplateId: string;
  rawModelId: string;
};

function isVoiceModel(model: Pick<ModelPreset, 'capabilities'>) {
  return model.capabilities.some((capability) => capability === 'speech-to-text' || capability === 'text-to-speech' || capability === 'speech-to-speech');
}

function resolveSelectedModel(options: RoutingModelOption[], modelId: string) {
  return options.find((model) => model.model === modelId);
}

function detectScenarioCapabilities(model: ModelPreset | undefined, scenario: ScenarioId): ScenarioCapability[] {
  if (!model) return [];
  const caps = new Set(model.capabilities);
  const tags: ScenarioCapability[] = [];
  switch (scenario) {
    case 'inbound':
      if (caps.has('speech-to-text')) tags.push('stt');
      if (caps.has('speech-to-text') || caps.has('speech-to-speech')) tags.push('translation');
      if (caps.has('speech-to-text') || caps.has('speech-to-speech')) tags.push('subtitle');
      return tags;
    case 'inboundSecondary':
      if (caps.has('speech-to-text')) return ['stt'];
      return [];
    case 'subtitle':
      if (caps.has('text-generation') || caps.has('speech-to-text') || caps.has('speech-to-speech')) return ['translation'];
      return [];
    case 'outbound':
      if (caps.has('speech-to-text')) tags.push('stt');
      if (caps.has('speech-to-text') || caps.has('speech-to-speech')) tags.push('translation');
      if (caps.has('speech-to-speech') || caps.has('text-to-speech')) tags.push('speech');
      return tags;
    case 'tts':
      if (caps.has('text-to-speech') || caps.has('speech-to-speech')) return ['tts'];
      return [];
    default:
      return [];
  }
}

function ChainFlow({
  direction,
  inboundLabel,
  modelLabel,
  outboundLabel,
  modelSubtitle,
  outboundSubtitle,
}: {
  direction: 'inbound' | 'outbound';
  inboundLabel: string;
  modelLabel: string;
  outboundLabel: string;
  modelSubtitle?: string;
  outboundSubtitle?: string;
}) {
  return (
    <div className={['chain-flow', direction === 'outbound' ? 'chain-flow-outbound' : 'chain-flow-inbound'].join(' ')}>
      <div className="chain-flow-direction">{direction === 'inbound' ? '听' : '说'}</div>
      <div className="chain-flow-segment">
        <div className="chain-flow-segment-label">{inboundLabel}</div>
        {modelSubtitle ? <div className="chain-flow-segment-sub">{modelSubtitle}</div> : null}
      </div>
      <span className="chain-flow-arrow" aria-hidden="true">—</span>
      <div className="chain-flow-segment">
        <div className="chain-flow-segment-label">{modelLabel}</div>
        {modelSubtitle ? <div className="chain-flow-segment-sub">{modelSubtitle}</div> : null}
      </div>
      <span className="chain-flow-arrow" aria-hidden="true">—</span>
      <div className="chain-flow-segment">
        <div className="chain-flow-segment-label">{outboundLabel}</div>
        {outboundSubtitle ? <div className="chain-flow-segment-sub">{outboundSubtitle}</div> : null}
      </div>
    </div>
  );
}

function ScenarioCard({
  icon,
  title,
  caption,
  modelName,
  modelProvider,
  tags,
  modelOptions,
  value,
  onSelect,
  muted,
  mutedHint,
  active,
  enabled,
  onEnabledChange,
  enableLabel,
}: {
  icon: AppIconName;
  title: string;
  caption: string;
  modelName: string;
  modelProvider: string;
  tags: ScenarioCapability[];
  modelOptions: RoutingModelOption[];
  value: string;
  onSelect: (modelId: string) => void;
  muted?: boolean;
  mutedHint?: string;
  active?: boolean;
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  enableLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = resolveSelectedModel(modelOptions, value);
  const displayName = selectedOption?.displayName ?? modelName;
  const subtitle = selectedOption?.description ?? modelProvider;
  const emptyText = 'Current provider has no available models';

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (event: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const cardEnabled = enabled ?? true;

  return (
    <div
      className={['scenario-card', !cardEnabled || muted ? 'scenario-card-muted' : '', active ? 'scenario-card-active' : '', open ? 'scenario-card-open' : ''].filter(Boolean).join(' ')}
      ref={cardRef}
    >
      <div className="scenario-card-head">
        <div className="scenario-card-icon" aria-hidden="true">
          <AppIcon name={icon} size={16} />
        </div>
        <div className="scenario-card-titles">
          <h4>{title}</h4>
          <span>{caption}</span>
        </div>
        {onEnabledChange ? (
          <label className={['scenario-card-toggle', cardEnabled ? 'scenario-card-toggle-on' : ''].join(' ')}>
            <input
              checked={cardEnabled}
              onChange={(event) => onEnabledChange(event.target.checked)}
              type="checkbox"
            />
            <span>{enableLabel ?? ''}</span>
          </label>
        ) : null}
      </div>
      <div className="scenario-card-control">
        <button
          aria-expanded={open}
          className="scenario-card-selector"
          disabled={!cardEnabled || muted}
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <div className="scenario-card-model">
            <strong>{displayName || '—'}</strong>
            <small>{subtitle}</small>
          </div>
          <span className="scenario-card-caret" aria-hidden="true">▾</span>
        </button>
        {open && cardEnabled && !muted ? (
          <div className="scenario-card-list" role="listbox">
            {modelOptions.length === 0 ? (
              <div className="routing-empty">{emptyText}</div>
            ) : (
              modelOptions.map((option) => (
                <button
                  className={['scenario-card-option', option.model === value ? 'scenario-card-option-active' : ''].filter(Boolean).join(' ')}
                  data-value={option.model}
                  key={option.model}
                  onClick={() => {
                    onSelect(option.model);
                    setOpen(false);
                  }}
                  role="option"
                  type="button"
                >
                  <AppIcon className="scenario-card-option-check" name="check" size={12} />
                  <span className="scenario-card-option-name">{option.displayName}</span>
                </button>
              ))
            )}
          </div>
        ) : null}
        {(!cardEnabled || muted) && mutedHint ? <p className="scenario-card-hint">{mutedHint}</p> : null}
        {tags.length > 0 ? (
          <div className="scenario-card-tags">
            {tags.map((tag) => (
              <span className={['scenario-card-tag', 'scenario-card-tag-' + tag, !cardEnabled || muted ? 'scenario-card-tag-muted' : ''].join(' ')} key={tag}>
                <AppIcon name="check" size={11} />
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AudioRoutingPage() {
  const { t } = useTranslation();
  const configDraft = useAppStore((state) => state.configDraft);
  const audioRuntimeSnapshot = useAppStore((state) => state.audioRuntimeSnapshot);
  const updateDeviceDraft = useAppStore((state) => state.updateDeviceDraft);
  const updateSpeechDraft = useAppStore((state) => state.updateSpeechDraft);
  const [customTemplates] = useState(() => readCustomProviderTemplates());
  const [catalogPreferences, setCatalogPreferences] = useState(() => readProviderTemplateCatalogPreferences());
  const [micTesting, setMicTesting] = useState(false);
  const [micTestResult, setMicTestResult] = useState<string | null>(null);
  const [speakerTesting, setSpeakerTesting] = useState(false);
  const [speakerTestResult, setSpeakerTestResult] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [micEnergyDb, setMicEnergyDb] = useState(-54);
  const [speakerEnergyDb, setSpeakerEnergyDb] = useState(-90);

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

  const inboundModelOption = resolveSelectedModel(voiceModelOptions, configDraft.devices.inboundVoiceModelId);
  const outboundModelOption = resolveSelectedModel(voiceModelOptions, configDraft.devices.outboundVoiceModelId);
  const subtitleModelOption = resolveSelectedModel(textModelOptions, configDraft.devices.subtitleTranslationModelId);
  const ttsModelOption = resolveSelectedModel(voiceModelOptions, configDraft.devices.textToSpeechModelId);

  const subtitleMode = configDraft.devices.subtitleTranslationMode;
  const isNativeSubtitle = subtitleMode === 'native';
  const mutedHint = tWithDefault(t, 'audioRouting.cardDisabledHint');
  const nativeAudioUnsupported =
    isNativeSubtitle
    && !resolveSelectedModel(voiceModelOptions, configDraft.devices.textToSpeechModelId || configDraft.speech.textToSpeechModelId || configDraft.devices.outboundVoiceModelId)?.capabilities.includes('speech-to-speech');

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

  const markSaved = () => setSavedAt(Date.now());

  const patchDeviceConfig = (patch: Partial<DeviceDraft>) => {
    updateDeviceDraft({ ...patch, status: 'ready' });
    markSaved();
  };

  const patchSpeechDraft = (patch: Partial<SpeechDraft>) => {
    updateSpeechDraft({ ...patch, status: 'draft' });
    markSaved();
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
    const speechPatch: Partial<SpeechDraft> = { enabled, status: 'draft' };
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
    setMicEnergyDb(-32);
    window.setTimeout(() => {
      setMicTesting(false);
      setMicTestResult(tWithDefault(t, 'audioRouting.micTestPassed'));
      setMicEnergyDb(-54);
    }, 900);
  };

  const handleSpeakerTest = () => {
    setSpeakerTesting(true);
    setSpeakerTestResult(null);
    setSpeakerEnergyDb(-18);
    window.setTimeout(() => {
      setSpeakerTesting(false);
      setSpeakerTestResult(tWithDefault(t, 'audioRouting.speakerTestPassed'));
      setSpeakerEnergyDb(-90);
    }, 900);
  };

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

  const setSubtitleMode = (mode: SubtitleTranslationMode) => {
    patchDeviceConfig({ subtitleTranslationMode: mode });
  };

  const setFeedbackMode = (mode: Exclude<FeedbackLoopPrevention, 'none'>) => {
    patchDeviceConfig({ feedbackLoopPrevention: mode });
  };

  const savedIndicator = savedAt ? tWithDefault(t, 'audioRouting.savedJustNow') : tWithDefault(t, 'audioRouting.autoSaved');

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
            direction="inbound"
            inboundLabel={tWithDefault(t, 'audioRouting.chainSystemAudio')}
            modelLabel={tWithDefault(t, 'audioRouting.chainInboundModel')}
            modelSubtitle={inboundModelOption ? 'STT · 翻译' : '—'}
            outboundLabel={tWithDefault(t, 'audioRouting.chainSubtitleTranslated')}
            outboundSubtitle={tWithDefault(t, 'audioRouting.chainLocalPlayback')}
          />

          <label className="field-stack field-span-full">
            <span>{tWithDefault(t, 'audioRouting.microphone')}</span>
            <select className="select-input" onChange={(event) => handleInputDeviceChange(event.target.value)} value={configDraft.devices.inputDeviceId}>
              {captureDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
              ))}
            </select>
          </label>

          <div className="routing-test-row">
            <div className="routing-test-row-controls">
              <button className="icon-button" disabled={micTesting || captureDevices.length === 0} onClick={handleMicTest} type="button">
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
            direction="outbound"
            inboundLabel={tWithDefault(t, 'audioRouting.chainMicrophone')}
            modelLabel={tWithDefault(t, 'audioRouting.chainOutboundModel')}
            modelSubtitle={outboundModelOption ? 'STT · 翻译 · 语音' : '—'}
            outboundLabel={tWithDefault(t, 'audioRouting.chainVirtualMicSpeaker')}
            outboundSubtitle={tWithDefault(t, 'audioRouting.chainReturnToPeer')}
          />

          <label className="field-stack field-span-full">
            <span>{tWithDefault(t, 'audioRouting.speaker')}</span>
            <select className="select-input" onChange={(event) => handleOutputDeviceChange(event.target.value)} value={configDraft.devices.outputDeviceId}>
              {physicalRenderDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
              ))}
            </select>
          </label>

          <div className="routing-test-row">
            <div className="routing-test-row-controls">
              <button className="icon-button" disabled={speakerTesting || physicalRenderDevices.length === 0} onClick={handleSpeakerTest} type="button">
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

          <div className="scenario-grid scenario-grid-three">
            <ScenarioCard
              active
              caption={tWithDefault(t, 'audioRouting.scenarioInboundCaption')}
              icon="headphones"
              modelName={inboundModelOption?.displayName ?? '—'}
              modelOptions={voiceModelOptions}
              modelProvider={inboundModelOption?.description ?? ''}
              onSelect={(modelId) => selectModel('inbound', modelId)}
              tags={detectScenarioCapabilities(inboundModelOption, 'inbound')}
              title={tWithDefault(t, 'audioRouting.scenarioInboundTitle')}
              value={configDraft.devices.inboundVoiceModelId}
            />
            <ScenarioCard
              caption={tWithDefault(t, 'audioRouting.scenarioInboundSecondaryCaption')}
              enableLabel={tWithDefault(t, 'audioRouting.secondaryAudioCardToggle')}
              enabled={configDraft.devices.outputSubtitlesEnabled}
              icon="subtitles"
              modelName={resolveSelectedModel(voiceModelOptions, configDraft.devices.inboundSecondaryAudioModelId)?.displayName ?? '—'}
              modelOptions={voiceModelOptions}
              modelProvider={resolveSelectedModel(voiceModelOptions, configDraft.devices.inboundSecondaryAudioModelId)?.description ?? ''}
              mutedHint={mutedHint}
              onEnabledChange={(enabled) => handleSubtitleOutputToggle(enabled)}
              onSelect={(modelId) => selectModel('inboundSecondary', modelId)}
              tags={detectScenarioCapabilities(resolveSelectedModel(voiceModelOptions, configDraft.devices.inboundSecondaryAudioModelId), 'inboundSecondary')}
              title={tWithDefault(t, 'audioRouting.scenarioInboundSecondaryTitle')}
              value={configDraft.devices.inboundSecondaryAudioModelId}
            />
            <ScenarioCard
              caption={tWithDefault(t, 'audioRouting.scenarioSubtitleCaption')}
              enableLabel={tWithDefault(t, 'audioRouting.subtitleTranslationCardToggle')}
              enabled={!isNativeSubtitle}
              icon="book"
              modelName={subtitleModelOption?.displayName ?? '—'}
              modelOptions={textModelOptions}
              modelProvider={subtitleModelOption?.description ?? ''}
              mutedHint={mutedHint}
              onEnabledChange={(enabled) => setSubtitleMode(enabled ? 'secondary' : 'native')}
              onSelect={(modelId) => selectModel('subtitle', modelId)}
              tags={detectScenarioCapabilities(subtitleModelOption, 'subtitle')}
              title={tWithDefault(t, 'audioRouting.scenarioSubtitleTitle')}
              value={configDraft.devices.subtitleTranslationModelId}
            />
          </div>

          <div className="routing-channel-section">
            <label className={['routing-channel', configDraft.devices.outputSpeechEnabled ? 'routing-channel-on' : ''].join(' ')}>
              <input checked={configDraft.devices.outputSpeechEnabled} onChange={(event) => handleSpeechOutputToggle(event.target.checked)} type="checkbox" />
              <span className="routing-channel-icon" aria-hidden="true">🎙</span>
              <span className="routing-channel-text">{tWithDefault(t, 'audioRouting.outputTranslatedSpeech')}</span>
            </label>
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

          <div className="scenario-grid">
            <ScenarioCard
              active
              caption={tWithDefault(t, 'audioRouting.scenarioOutboundCaption')}
              icon="mic"
              modelName={outboundModelOption?.displayName ?? '—'}
              modelOptions={voiceModelOptions}
              modelProvider={outboundModelOption?.description ?? ''}
              onSelect={(modelId) => selectModel('outbound', modelId)}
              tags={detectScenarioCapabilities(outboundModelOption, 'outbound')}
              title={tWithDefault(t, 'audioRouting.scenarioOutboundTitle')}
              value={configDraft.devices.outboundVoiceModelId}
            />
            <ScenarioCard
              caption={tWithDefault(t, 'audioRouting.scenarioTtsCaption')}
              icon="spark"
              modelName={ttsModelOption?.displayName ?? '—'}
              modelOptions={voiceModelOptions}
              modelProvider={ttsModelOption?.description ?? ''}
              onSelect={(modelId) => selectModel('tts', modelId)}
              tags={detectScenarioCapabilities(ttsModelOption, 'tts')}
              title={tWithDefault(t, 'audioRouting.scenarioTtsTitle')}
              value={configDraft.devices.textToSpeechModelId}
            />
          </div>

          <div className="routing-channel-section">
            <label className={['routing-channel', configDraft.devices.virtualMicOutputEnabled ? 'routing-channel-on' : ''].join(' ')}>
              <input checked={configDraft.devices.virtualMicOutputEnabled} onChange={(event) => handleVirtualMicToggle(event.target.checked)} type="checkbox" />
              <span className="routing-channel-icon" aria-hidden="true">🎤</span>
              <span className="routing-channel-text">{tWithDefault(t, 'audioRouting.sendVoiceToVirtualMic')}</span>
            </label>
          </div>

          <div className="routing-saved-indicator" aria-live="polite">{savedIndicator}</div>
        </article>
      </section>
    </div>
  );
}

export const audioRoutingPageHelpers = {
  isVoiceModel,
  resolveSelectedModel,
  detectScenarioCapabilities,
};

export default AudioRoutingPage;
