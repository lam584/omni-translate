import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { useAppStore } from '../stores/app-store';
import { mountTestRoot, type TestRootHandle } from '../test-utils';
import type { ProviderCapability } from '../schema/provider-contract';
import AudioRoutingPage, { audioRoutingPageHelpers } from './AudioRoutingPage';

const { ChainFlow, ScenarioCard, tWithDefault } = audioRoutingPageHelpers;

const providerCatalogPreferencesMock = vi.hoisted(() => ({
  value: [] as Array<{ templateId: string; enabled: boolean; order: number; hidden?: boolean }>,
}));

vi.mock('../utils/custom-provider-templates', async () => {
  const actual = await vi.importActual<typeof import('../utils/custom-provider-templates')>('../utils/custom-provider-templates');
  return {
    ...actual,
    readCustomProviderTemplates: () => [],
  };
});

vi.mock('../utils/provider-template-catalog', async () => {
  const actual = await vi.importActual<typeof import('../utils/provider-template-catalog')>('../utils/provider-template-catalog');
  return {
    ...actual,
    readProviderTemplateCatalogPreferences: () => providerCatalogPreferencesMock.value,
  };
});

vi.mock('react-i18next', async () => (await import('../test-utils/i18n-stub')).reactI18nextStub({ passthroughDefault: true }));

function inputText(input: Element | null) {
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Expected input element');
  }
  return input;
}

function rangeInputByLabel(container: HTMLElement, label: string) {
  const input = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'))
    .find((candidate) => candidate.getAttribute('aria-label') === label);
  if (!input) {
    throw new Error(`Expected range input ${label}`);
  }
  return input;
}

function clickCheckbox(container: HTMLElement, label: string) {
  const input = inputText(Array.from(container.querySelectorAll('label')).find((item) => item.textContent?.includes(label))?.querySelector('input') ?? null);
  input.click();
}

async function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

  await act(async () => {
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function scenarioCardByTitle(container: HTMLElement, title: string) {
  const card = Array.from(container.querySelectorAll<HTMLElement>('.scenario-card')).find((item) => item.textContent?.includes(title));
  if (!card) {
    throw new Error(`Expected scenario card ${title}`);
  }
  return card;
}

async function openScenarioSelect(container: HTMLElement, title: string) {
  const card = scenarioCardByTitle(container, title);
  await act(async () => {
    card.querySelector('button.scenario-card-selector')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return card;
}

async function scenarioOptionTexts(container: HTMLElement, title: string) {
  const card = await openScenarioSelect(container, title);
  return Array.from(card.querySelectorAll('.scenario-card-option')).map((option) => option.textContent ?? '');
}

async function chooseScenarioModel(container: HTMLElement, title: string, modelText: string) {
  const card = await openScenarioSelect(container, title);
  const option = Array.from(card.querySelectorAll('button.scenario-card-option')).find((button) => button.textContent?.includes(modelText));
  if (!option) {
    throw new Error(`Expected scenario option ${modelText} in ${title}`);
  }
  await act(async () => {
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('AudioRoutingPage', () => {
  let view: TestRootHandle;
  let container: HTMLDivElement;

  async function renderPage() {
    await view.render(
      <MemoryRouter>
        <AudioRoutingPage />
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    providerCatalogPreferencesMock.value = [];
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.providers[0].templateId = 'template-openai-compatible-realtime';
    configDraft.providers[0].providerId = 'provider-openai';
    configDraft.providers[0].displayName = 'OpenAI API';
    configDraft.providers[0].kind = 'openai-compatible';
    configDraft.providers[0].model = 'gpt-4o';
    configDraft.providers[0].baseUrl = 'https://api.openai.com/v1';
    configDraft.providers[0].transport = 'streaming-http';
    configDraft.providers[0].authRef = {
      kind: 'credential-ref',
      reference: 'credential://provider/openai/default',
      headerName: 'Authorization',
      scheme: 'bearer',
    };
    configDraft.providers[0].sceneModelAssignments = [
      { scenario: 'watch', modelIds: ['gpt-4o'] },
      { scenario: 'game', modelIds: [] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: [] },
    ];

    const linkedDashscope = structuredClone(configDraft.providers[0]);
    linkedDashscope.templateId = 'template-dashscope-realtime';
    linkedDashscope.providerId = 'provider-dashscope';
    linkedDashscope.displayName = 'DashScope';
    linkedDashscope.kind = 'dashscope';
    linkedDashscope.model = 'qwen3.5-omni-plus-realtime';
    linkedDashscope.baseUrl = 'https://dashscope.aliyuncs.com/api/v1';
    linkedDashscope.transport = 'websocket';
    linkedDashscope.authRef = {
      kind: 'credential-ref',
      reference: 'credential://provider/dashscope/default',
      headerName: 'Authorization',
      scheme: 'bearer',
    };
    linkedDashscope.sceneModelAssignments = [
      { scenario: 'watch', modelIds: ['stt-model', 'qwen3.5-omni-plus-realtime'] },
      { scenario: 'game', modelIds: ['tts-model'] },
      { scenario: 'voice-room', modelIds: ['s2s-model', 'qwen3.5-omni-plus-realtime'] },
      { scenario: 'subtitle-translate', modelIds: ['qwen3.6-flash-2026-04-16'] },
    ];
    linkedDashscope.modelCatalogCache = {
      signature: 'dashscope',
      source: 'runtime',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
      fetchedAt: 'unix:1',
      error: null,
      models: [
        {
          id: 'stt-model',
          displayName: 'STT Model',
          ownedBy: 'dashscope',
          createdAt: null,
          capabilities: ['speech-to-text'],
          providerTemplateId: 'template-dashscope-realtime',
          providerTemplateName: 'DashScope',
        },
        {
          id: 'tts-model',
          displayName: 'TTS Model',
          ownedBy: 'dashscope',
          createdAt: null,
          capabilities: ['text-to-speech'],
          providerTemplateId: 'template-dashscope-realtime',
          providerTemplateName: 'DashScope',
        },
        {
          id: 's2s-model',
          displayName: 'S2S Model',
          ownedBy: 'dashscope',
          createdAt: null,
          capabilities: ['speech-to-speech'],
          providerTemplateId: 'template-dashscope-realtime',
          providerTemplateName: 'DashScope',
        },
        {
          id: 'qwen3.5-omni-plus-realtime',
          displayName: 'Qwen Omni',
          ownedBy: 'dashscope',
          createdAt: null,
          capabilities: ['speech-to-text', 'text-to-speech', 'speech-to-speech'],
          providerTemplateId: 'template-dashscope-realtime',
          providerTemplateName: 'DashScope',
        },
        {
          id: 'qwen3.6-flash-2026-04-16',
          displayName: 'Qwen3.6 Flash',
          ownedBy: 'dashscope',
          createdAt: null,
          capabilities: ['text-generation'],
          providerTemplateId: 'template-dashscope-realtime',
          providerTemplateName: 'DashScope',
        },
      ],
    };

    configDraft.devices.subtitleTranslationMode = 'secondary';
    configDraft.devices.subtitleTranslationModelId = 'template-dashscope-realtime::qwen3.6-flash-2026-04-16';
    configDraft.devices.inboundVoiceModelId = 'template-dashscope-realtime::qwen3.5-omni-plus-realtime';
    configDraft.devices.outboundVoiceModelId = 'template-dashscope-realtime::qwen3.5-omni-plus-realtime';
    configDraft.devices.inboundSecondaryAudioModelId = 'template-dashscope-realtime::qwen3.5-omni-plus-realtime';
    configDraft.devices.textToSpeechModelId = 'template-dashscope-realtime::qwen3.5-omni-plus-realtime';
    configDraft.devices.outputSubtitlesEnabled = true;
    configDraft.devices.feedbackLoopPrevention = 'echo-cancel';
    configDraft.speech.textToSpeechModelId = 'template-dashscope-realtime::qwen3.5-omni-plus-realtime';
    configDraft.providers.push(linkedDashscope);

    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot: structuredClone(audioRuntimeSnapshotMock),
      configDraft,
    }));

    view = mountTestRoot();
    ({ container } = view);
  });

  afterEach(async () => {
    await view.cleanup();
  });

  it('renders two top panels, two model panels, and five scenario cards', async () => {
    await renderPage();

    const headings = Array.from(container.querySelectorAll('h3')).map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(['采集', '输出', '听译模型', '回复模型']));

    expect(container.querySelectorAll('.routing-top-grid > article')).toHaveLength(2);
    expect(container.querySelector('.routing-models-grid')).toBeInstanceOf(HTMLElement);
    expect(container.querySelectorAll('.routing-models-grid > article')).toHaveLength(2);
    expect(container.querySelectorAll('.scenario-card')).toHaveLength(5);
    expect(container.querySelectorAll('.chain-flow-outbound')).toHaveLength(1);
    expect(container.querySelectorAll('.chain-flow-inbound')).toHaveLength(1);
    expect(container.querySelector('.routing-page-header')).toBeNull();
  });

  it('shows inbound original and translated volume with physical-loopback restrictions', async () => {
    await renderPage();

    const originalVolume = rangeInputByLabel(container, '原声音量');
    const translatedVolume = rangeInputByLabel(container, 'LLM 译声音量');

    expect(originalVolume.value).toBe('63');
    expect(originalVolume.disabled).toBe(true);
    expect(originalVolume.getAttribute('aria-describedby')).toBe('original-audio-volume-virtual-driver-hint');
    expect(translatedVolume.value).toBe('100');
    expect(translatedVolume.max).toBe('200');
    expect(translatedVolume.disabled).toBe(false);
    const smartGain = inputText(Array.from(container.querySelectorAll('label')).find((item) => item.textContent?.includes('智能增响'))?.querySelector('input') ?? null);
    expect(smartGain.checked).toBe(true);
    expect(container.textContent).toContain('原声音量仅在虚拟驱动模式下可调');
  });

  it('stores 200 percent translated gain and can disable smart loudness', async () => {
    await renderPage();

    await changeValue(rangeInputByLabel(container, 'LLM 译声音量'), '200');
    await act(async () => clickCheckbox(container, '智能增响'));

    const mixControl = useAppStore.getState().configDraft.devices.inboundRoute.mixControl;
    expect(mixControl.translatedAudioGainDb).toBeCloseTo(6.0206, 4);
    expect(mixControl.translatedAudioAutoGainEnabled).toBe(false);
  });

  it('stores both virtual-driver mix sliders as independent dB gains', async () => {
    useAppStore.setState((state) => ({
      configDraft: {
        ...state.configDraft,
        devices: {
          ...state.configDraft.devices,
          feedbackLoopPrevention: 'virtual-driver',
        },
      },
    }));

    await renderPage();

    const originalVolume = rangeInputByLabel(container, '原声音量');
    expect(originalVolume.disabled).toBe(false);
    await changeValue(originalVolume, '50');
    await changeValue(rangeInputByLabel(container, 'LLM 译声音量'), '75');

    const mixControl = useAppStore.getState().configDraft.devices.inboundRoute.mixControl;
    expect(mixControl.originalAudioGainDb).toBeCloseTo(-6.0206, 4);
    expect(mixControl.translatedAudioGainDb).toBeCloseTo(-2.4988, 4);
    expect(mixControl.keepOriginalAudio).toBe(true);
    expect(mixControl.translatedAudioEnabled).toBe(true);
    expect(mixControl.duckingEnabled).toBe(true);
    expect(container.querySelector('#original-audio-volume-virtual-driver-hint')).toBeNull();
  });

  it('filters the subtitle translation scenario to non-voice models only', async () => {
    await renderPage();

    const options = await scenarioOptionTexts(container, '字幕翻译');
    const joined = options.join(' ');
    expect(joined).toContain('Qwen3.6 Flash');
    expect(joined).not.toContain('STT Model');
    expect(joined).not.toContain('TTS Model');
    expect(joined).not.toContain('S2S Model');
    expect(joined).not.toContain('Qwen Omni');
  });

  it('mutes the subtitle scenario card in native subtitle mode', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: {
          ...state.configDraft.devices,
          subtitleTranslationMode: 'native',
          outputSubtitlesEnabled: false,
        },
      },
    }));

    await renderPage();

    const subtitleCard = scenarioCardByTitle(container, '字幕翻译');
    expect(subtitleCard.classList.contains('scenario-card-muted')).toBe(true);
    expect(container.textContent).toContain('此卡已停用');
  });

  it('writes independent selections to inbound, outbound, secondary, subtitle, and tts fields', async () => {
    await renderPage();

    await chooseScenarioModel(container, '听对方', 'STT Model');
    await chooseScenarioModel(container, '说给对方', 'S2S Model');
    await chooseScenarioModel(container, '听对方 · 二次语音识别', 'Qwen Omni');
    await chooseScenarioModel(container, '字幕翻译', 'Qwen3.6 Flash');
    await chooseScenarioModel(container, '打字 TTS', 'TTS Model');

    const { devices, speech } = useAppStore.getState().configDraft;
    expect(devices.inboundVoiceModelId).toBe('template-dashscope-realtime::stt-model');
    expect(devices.outboundVoiceModelId).toBe('template-dashscope-realtime::s2s-model');
    expect(devices.inboundSecondaryAudioModelId).toBe('template-dashscope-realtime::qwen3.5-omni-plus-realtime');
    expect(devices.subtitleTranslationModelId).toBe('template-dashscope-realtime::qwen3.6-flash-2026-04-16');
    expect(devices.textToSpeechModelId).toBe('template-dashscope-realtime::tts-model');
    expect(speech.textToSpeechModelId).toBe('template-dashscope-realtime::tts-model');
  });

  it('writes input processing toggles into the outbound route contract', async () => {
    await renderPage();

    await act(async () => {
      clickCheckbox(container, '回声消除');
      clickCheckbox(container, '噪声抑制');
      clickCheckbox(container, '自动增益');
    });

    const { devices } = useAppStore.getState().configDraft;
    expect(devices.aecEnabled).toBe(false);
    expect(devices.ansEnabled).toBe(false);
    expect(devices.agcEnabled).toBe(false);
    expect(devices.outboundRoute.input.processing).toEqual(expect.objectContaining({
      autoGainControlEnabled: false,
      echoCancellationEnabled: false,
      noiseSuppressionEnabled: false,
    }));
  });

  it('writes the TTS card toggle into speech preferences', async () => {
    await renderPage();

    await act(async () => {
      clickCheckbox(container, '独立 TTS');
    });

    const { speech } = useAppStore.getState().configDraft;
    expect(speech.enabled).toBe(false);
    await act(async () => clickCheckbox(container, '独立 TTS'));
    expect(useAppStore.getState().configDraft.speech.enabled).toBe(true);
  });

  it('toggles the subtitle translation card switch', async () => {
    await renderPage();

    const subtitleCard = scenarioCardByTitle(container, '字幕翻译');
    const secondaryToggle = inputText(subtitleCard.querySelector('input[type="checkbox"]'));
    expect(secondaryToggle.checked).toBe(true);

    await act(async () => {
      secondaryToggle.click();
    });

    expect(useAppStore.getState().configDraft.devices.outputSubtitlesEnabled).toBe(false);
    expect(useAppStore.getState().configDraft.devices.inboundRoute.outputs.find((target) => target.kind === 'subtitle-engine')?.enabled).toBe(false);

    await act(async () => {
      secondaryToggle.click();
    });

    expect(useAppStore.getState().configDraft.devices.outputSubtitlesEnabled).toBe(true);
  });

  it('derives secondary translation mode from the two secondary card switches', async () => {
    await renderPage();

    const subtitleCard = scenarioCardByTitle(container, '字幕翻译');
    const subtitleToggle = inputText(subtitleCard.querySelector('input[type="checkbox"]'));
    const secondaryAudioToggle = inputText(scenarioCardByTitle(container, '听对方 · 二次语音识别').querySelector('input[type="checkbox"]'));
    expect(subtitleToggle.checked).toBe(true);
    expect(secondaryAudioToggle.checked).toBe(true);
    expect(useAppStore.getState().configDraft.devices.subtitleTranslationMode).toBe('secondary');

    await act(async () => {
      subtitleToggle.click();
    });

    expect(useAppStore.getState().configDraft.devices.subtitleTranslationMode).toBe('secondary');
    expect(subtitleCard.classList.contains('scenario-card-muted')).toBe(true);

    await act(async () => {
      secondaryAudioToggle.click();
    });

    expect(useAppStore.getState().configDraft.devices.subtitleTranslationMode).toBe('native');
    expect(useAppStore.getState().configDraft.speech.translationAudioSource).toBe('auto');

    await act(async () => {
      secondaryAudioToggle.click();
    });

    expect(useAppStore.getState().configDraft.devices.subtitleTranslationMode).toBe('secondary');
    expect(useAppStore.getState().configDraft.speech.translationAudioSource).toBe('subtitle-tts');
  });

  it('disables the model selector on a muted scenario card', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: {
          ...state.configDraft.devices,
          subtitleTranslationMode: 'native',
          outputSubtitlesEnabled: false,
        },
      },
    }));

    await renderPage();

    const subtitleCard = scenarioCardByTitle(container, '字幕翻译');
    const selector = subtitleCard.querySelector<HTMLButtonElement>('button.scenario-card-selector');
    expect(selector?.disabled).toBe(true);
  });

  it('places the virtual microphone output toggle inside the replying model card', async () => {
    await renderPage();

    const virtualMicToggle = Array.from(container.querySelectorAll('label')).find((item) =>
      item.textContent?.includes('将翻译语音发送到虚拟麦克风'),
    );
    const owningSection = virtualMicToggle?.closest('.routing-models-outbound-panel');
    const owningCard = virtualMicToggle?.closest('.scenario-card');

    expect(owningSection).toBeInstanceOf(HTMLElement);
    expect(owningCard?.textContent).toContain('说给对方');
  });

  it('places the secondary audio toggle inside the secondary audio card', async () => {
    await renderPage();

    const speechToggle = Array.from(container.querySelectorAll('label')).find((item) =>
      item.textContent?.includes('用二次字幕生成译音'),
    );
    const owningSection = speechToggle?.closest('.routing-models-inbound-panel');
    const owningCard = speechToggle?.closest('.scenario-card');

    expect(owningSection).toBeInstanceOf(HTMLElement);
    expect(owningCard?.textContent).toContain('听对方 · 二次语音识别');
  });

  it('highlights replying model cards only while their card switches are enabled', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: {
          ...state.configDraft.devices,
          virtualMicOutputEnabled: true,
        },
        speech: {
          ...state.configDraft.speech,
          enabled: true,
        },
      },
    }));

    await renderPage();

    const outboundCard = scenarioCardByTitle(container, '说给对方');
    const ttsCard = scenarioCardByTitle(container, '打字 TTS');
    expect(outboundCard.classList.contains('scenario-card-active')).toBe(true);
    expect(ttsCard.classList.contains('scenario-card-active')).toBe(true);

    await act(async () => {
      inputText(outboundCard.querySelector('input[type="checkbox"]')).click();
      inputText(ttsCard.querySelector('input[type="checkbox"]')).click();
    });

    expect(outboundCard.classList.contains('scenario-card-active')).toBe(false);
    expect(ttsCard.classList.contains('scenario-card-active')).toBe(false);
  });

  it('places the subtitle translation model inside the inbound model panel', async () => {
    await renderPage();

    const subtitleCard = scenarioCardByTitle(container, '字幕翻译');
    const owningSection = subtitleCard.closest('.routing-models-inbound-panel');
    expect(owningSection).toBeInstanceOf(HTMLElement);
  });

  it('toggles the secondary audio switch from the scenario card', async () => {
    await renderPage();

    const secondaryGroup = container.querySelector('.routing-secondary-group');
    const cardToggle = inputText(scenarioCardByTitle(container, '听对方 · 二次语音识别').querySelector('input[type="checkbox"]'));
    expect(cardToggle.getAttribute('role')).toBe('switch');
    expect(cardToggle.checked).toBe(true);

    await act(async () => {
      cardToggle.click();
    });

    expect(useAppStore.getState().configDraft.devices.subtitleTranslationMode).toBe('secondary');
    expect(useAppStore.getState().configDraft.devices.outputSpeechEnabled).toBe(false);
    expect(useAppStore.getState().configDraft.devices.inboundRoute.mixControl.translatedAudioEnabled).toBe(false);
    expect(useAppStore.getState().configDraft.devices.outboundRoute.mixControl.translatedAudioEnabled).toBe(false);

    await act(async () => {
      cardToggle.click();
    });

    expect(useAppStore.getState().configDraft.devices.outputSpeechEnabled).toBe(true);
    expect(useAppStore.getState().configDraft.devices.inboundRoute.mixControl.translatedAudioEnabled).toBe(true);
    expect(useAppStore.getState().configDraft.devices.outboundRoute.mixControl.translatedAudioEnabled).toBe(true);
    const secondaryCards = Array.from(secondaryGroup?.querySelectorAll('.scenario-card') ?? []);
    expect(secondaryCards).toHaveLength(2);
  });

  it('places the subtitle translation card enable toggle inside the listening model panel', async () => {
    await renderPage();

    const subtitleCard = scenarioCardByTitle(container, '字幕翻译');
    const subtitleToggle = inputText(subtitleCard.querySelector('input[type="checkbox"]'));
    const owningSection = subtitleCard.closest('.routing-models-inbound-panel');
    expect(owningSection).toBeInstanceOf(HTMLElement);
    expect(subtitleToggle.checked).toBe(true);
  });

  it('places feedback loop prevention options in the output panel', async () => {
    await renderPage();

    const outputPanel = container.querySelector('.routing-output-panel');
    const radioGroup = outputPanel?.querySelector('.routing-feedback-options');
    expect(radioGroup?.getAttribute('role')).toBe('radiogroup');
    const radios = Array.from(outputPanel?.querySelectorAll<HTMLButtonElement>('.routing-feedback-option') ?? []);
    expect(radios).toHaveLength(2);
    expect(radios[0]?.getAttribute('role')).toBe('radio');
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true');
    expect(radios[1]?.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      radios[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useAppStore.getState().configDraft.devices.feedbackLoopPrevention).toBe('virtual-driver');
    expect(radios[1]?.getAttribute('aria-checked')).toBe('true');
    expect(radios[0]?.getAttribute('aria-checked')).toBe('false');
  });

  it('hides models from disabled provider templates', async () => {
    providerCatalogPreferencesMock.value = [
      { templateId: 'template-openai-compatible-realtime', enabled: true, order: 0 },
      { templateId: 'template-dashscope-realtime', enabled: false, order: 1 },
    ];

    await renderPage();

    expect((await scenarioOptionTexts(container, '字幕翻译')).join(' ')).not.toContain('Qwen3.6 Flash');
    expect(container.textContent).not.toContain('Qwen Omni');
  });

  it('hides models from locally hidden provider templates', async () => {
    providerCatalogPreferencesMock.value = [
      { templateId: 'template-openai-compatible-realtime', enabled: true, order: 0 },
      { templateId: 'template-dashscope-realtime', enabled: true, hidden: true, order: 1 },
    ];

    await renderPage();

    expect((await scenarioOptionTexts(container, '字幕翻译')).join(' ')).not.toContain('Qwen3.6 Flash');
    expect(container.textContent).not.toContain('Qwen Omni');
  });

  it('refreshes routing model lists when a provider template is disabled in the same window', async () => {
    await renderPage();

    expect(scenarioCardByTitle(container, '听对方').textContent).toContain('Qwen Omni');

    providerCatalogPreferencesMock.value = [
      { templateId: 'template-openai-compatible-realtime', enabled: true, order: 0 },
      { templateId: 'template-dashscope-realtime', enabled: false, order: 1 },
    ];

    await act(async () => {
      window.dispatchEvent(new Event('omni.providerTemplateCatalogPrefs.updated'));
    });

    expect((await scenarioOptionTexts(container, '字幕翻译')).join(' ')).not.toContain('Qwen3.6 Flash');
    expect(container.textContent).not.toContain('Qwen Omni');
  });

  it('excludes the Omni virtual speaker from physical output choices', async () => {
    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot: {
        ...state.audioRuntimeSnapshot,
        renderDevices: [
          ...state.audioRuntimeSnapshot.renderDevices,
          {
            deviceId: 'omni-virtual-speaker-default',
            label: 'Speakers (Omni Translate Virtual Speaker)',
            interfaceName: 'Omni Translate Virtual Speaker',
            direction: 'render',
            isDefault: false,
            state: 'active',
          },
        ],
      },
    }));

    await renderPage();

    const outputSelect = Array.from(container.querySelectorAll<HTMLSelectElement>('select.select-input'))
      .find((select) => Array.from(select.options).some((option) => option.textContent?.includes('扬声器')));
    expect(outputSelect).toBeInstanceOf(HTMLSelectElement);
    expect(
      Array.from(outputSelect!.options).some((option) =>
        option.textContent?.includes('Omni Translate Virtual Speaker'),
      ),
    ).toBe(false);
  });

  it('updates devices, levels, virtual microphone output and subtitle mode controls', async () => {
    vi.useFakeTimers();
    await renderPage();

    const deviceSelects = container.querySelectorAll<HTMLSelectElement>('select.select-input');
    const levels = container.querySelectorAll<HTMLInputElement>('input[type="range"]');
    await changeValue(deviceSelects[0], audioRuntimeSnapshotMock.captureDevices[0].deviceId);
    await changeValue(deviceSelects[1], audioRuntimeSnapshotMock.renderDevices[0].deviceId);
    await changeValue(levels[0], '44');
    await changeValue(levels[1], '66');
    await act(async () => {
      inputText(scenarioCardByTitle(container, '说给对方').querySelector('input[type="checkbox"]')).click();
    });

    const testButtons = container.querySelectorAll<HTMLButtonElement>('.routing-test-row button');
    await act(async () => {
      testButtons[0].click();
      testButtons[1].click();
      await vi.advanceTimersByTimeAsync(900);
    });

    const subtitleModeCheckbox = inputText(
      container.querySelector('.routing-secondary-group input[type="checkbox"]') ?? null,
    );
    await act(async () => {
      subtitleModeCheckbox.click();
      subtitleModeCheckbox.click();
    });

    const { devices, speech } = useAppStore.getState().configDraft;
    expect(devices.outputLevel).toBe(66);
    expect(devices.inputLevel).toBe(44);
    expect(devices.virtualMicOutputEnabled).toBe(false);
    expect(speech.outputTarget).toBe('speaker');
    expect(devices.subtitleTranslationMode).toBe('secondary');
    expect(container.textContent).toContain('当前桌面运行时不支持麦克风测试');
    expect(container.textContent).toContain('AudioContext is not defined');
    expect(container.textContent).not.toContain('扬声器测试通过');
    expect(container.textContent).not.toContain('麦克风测试通过');
    vi.useRealTimers();
  });

  it('warns about unsupported native audio when both per-card toggles are off and the TTS model cannot do speech-to-speech', async () => {
    useAppStore.setState((state) => ({
      configDraft: {
        ...state.configDraft,
        devices: {
          ...state.configDraft.devices,
          textToSpeechModelId: 'template-dashscope-realtime::tts-model',
          subtitleTranslationMode: 'native',
          outputSubtitlesEnabled: false,
          outputSpeechEnabled: false,
        },
        speech: {
          ...state.configDraft.speech,
          textToSpeechModelId: 'template-dashscope-realtime::tts-model',
        },
      },
    }));
    await renderPage();

    expect(container.textContent).toContain('当前模型不支持 Omni 直接译音');

    const toggle = inputText(container.querySelector('.routing-secondary-group input[type="checkbox"]') ?? null);
    await act(async () => {
      toggle.click();
    });

    expect(useAppStore.getState().configDraft.devices.subtitleTranslationMode).toBe('secondary');
    expect(container.textContent).not.toContain('当前模型不支持 Omni 直接译音');
  });

  it('shows microphone and speaker test buttons with audio level meters', async () => {
    await renderPage();

    const buttons = Array.from(container.querySelectorAll('button')).map((button) => button.textContent ?? '');
    expect(buttons).toEqual(expect.arrayContaining([expect.stringContaining('测试麦克风'), expect.stringContaining('测试扬声器')]));
    expect(container.querySelectorAll('.audio-level-meter')).toHaveLength(2);
  });

  it('uses speech and outbound model fallbacks, shows a stale input device, and enables virtual microphone output', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: { ...state.configDraft.devices, inputDeviceId: 'missing-input', textToSpeechModelId: '', subtitleTranslationMode: 'native', virtualMicOutputEnabled: false },
        speech: { ...state.configDraft.speech, virtualMicOutputEnabled: false },
      },
    }));
    await renderPage();
    expect(Array.from(container.querySelectorAll('option')).some((option) => option.value === 'missing-input')).toBe(true);

    useAppStore.setState((state) => ({ ...state, configDraft: {
      ...state.configDraft,
      devices: { ...state.configDraft.devices, textToSpeechModelId: '' },
      speech: { ...state.configDraft.speech, textToSpeechModelId: '' },
    } }));
    await act(async () => Promise.resolve());
    const outboundCard = scenarioCardByTitle(container, '说给对方');
    await act(async () => outboundCard.querySelector<HTMLInputElement>('input[role="switch"]')?.click());
    expect(useAppStore.getState().configDraft.devices.virtualMicOutputEnabled).toBe(true);
    expect(useAppStore.getState().configDraft.speech.outputTarget).toBe('virtual-mic');
  });

  it('publishes successful microphone and speaker labels through the page callback', async () => {
    vi.useFakeTimers();
    useAppStore.setState((state) => ({
      ...state,
      configDraft: { ...state.configDraft, devices: { ...state.configDraft.devices,
        inputDeviceId: state.audioRuntimeSnapshot.captureDevices[0]!.deviceId,
        outputDeviceId: state.audioRuntimeSnapshot.renderDevices[0]!.deviceId } },
    }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
    });
    const oscillator = {
      frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn(),
      addEventListener: vi.fn((_name: string, listener: () => void) => listener()),
    };
    const gain = { gain: { value: 0 }, connect: vi.fn() };
    oscillator.connect.mockReturnValue(gain);
    gain.connect.mockReturnValue(gain);
    const audioContext = {
      currentTime: 0, destination: {}, close: vi.fn().mockResolvedValue(undefined),
      createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData: (values: Float32Array) => values.fill(0.25) }),
      createMediaStreamSource: () => ({ connect: vi.fn() }), createOscillator: () => oscillator, createGain: () => gain,
    };
    vi.stubGlobal('AudioContext', vi.fn(function AudioContextMock() { return audioContext; }));
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(901);
    await renderPage();
    const testButtons = container.querySelectorAll<HTMLButtonElement>('.routing-test-row button');
    await act(async () => {
      testButtons[0]!.click();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
    });
    await act(async () => testButtons[1]!.click());
    expect(container.textContent).toContain('麦克风测试通过');
    expect(container.textContent).toContain('扬声器测试通过');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sorts multiple text-only provider models', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        providers: state.configDraft.providers.map((provider) => ({
          ...provider,
          sceneModelAssignments: [{ scenario: 'subtitle-translate', modelIds: ['z-text', 'a-text'] }],
          modelCatalogCache: { ...provider.modelCatalogCache, models: [
            { id: 'z-text', displayName: 'Zulu', ownedBy: null, createdAt: null, capabilities: ['text-generation'], providerTemplateId: provider.templateId, providerTemplateName: provider.displayName },
            { id: 'a-text', displayName: 'Alpha', ownedBy: null, createdAt: null, capabilities: ['text-generation'], providerTemplateId: provider.templateId, providerTemplateName: provider.displayName },
          ] },
        })),
      },
    }));
    await renderPage();
    const texts = await scenarioOptionTexts(container, '字幕翻译');
    expect(texts.join(' ')).toContain('Alpha');
  });

  it('marks the microphone level meter active while inbound capture is bound', async () => {
    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot: {
        ...state.audioRuntimeSnapshot,
        inbound: {
          ...state.audioRuntimeSnapshot.inbound,
          captureState: 'capturing',
          streamBound: true,
        },
      },
    }));

    await renderPage();

    expect(container.querySelector('.routing-capture-panel .audio-level-meter')?.classList.contains('audio-level-meter-active')).toBe(true);
  });

  it('saves model selections immediately without showing an auto-save indicator', async () => {
    await renderPage();

    expect(container.querySelector('.routing-saved-indicator')).toBeNull();
    expect(container.textContent).not.toContain('已自动保存');
    expect(container.textContent).not.toContain('更改会自动保存');

    await chooseScenarioModel(container, '听对方', 'S2S Model');
    expect(useAppStore.getState().configDraft.devices.inboundVoiceModelId).toBe('template-dashscope-realtime::s2s-model');
    expect(container.textContent).not.toContain('刚刚已保存');
  });

  it('renders embedded chain flow segments with model and device labels', async () => {
    await renderPage();

    const outboundFlow = container.querySelector('.chain-flow-outbound');
    const inboundFlow = container.querySelector('.chain-flow-inbound');
    expect(outboundFlow).toBeInstanceOf(HTMLElement);
    expect(inboundFlow).toBeInstanceOf(HTMLElement);
    expect(inboundFlow?.textContent).toContain('系统/对方声音');
    expect(inboundFlow?.textContent).toContain('本地播放');
    expect(outboundFlow?.textContent).toContain('返回对方');
  });

  it('exposes scenario toggles as ARIA switches with aria-checked', async () => {
    await renderPage();

    const switches = Array.from(container.querySelectorAll('input[role="switch"]'));
    expect(switches.length).toBeGreaterThan(0);
    for (const node of switches) {
      expect(node.getAttribute('aria-checked')).toBe('true');
    }
  });

  it('supports keyboard navigation inside scenario listboxes', async () => {
    await renderPage();

    const outboundCard = scenarioCardByTitle(container, '说给对方');
    const selector = outboundCard.querySelector('.scenario-card-selector') as HTMLButtonElement;
    selector.focus();
    await act(async () => {
      selector.click();
    });
    const list = outboundCard.querySelector('[role="listbox"]') as HTMLElement;
    expect(list).not.toBeNull();

    // aria-activedescendant must reference a real option in the open list.
    const optionIds = Array.from(list.querySelectorAll('[role="option"]')).map((option) => option.id);
    expect(optionIds.length).toBeGreaterThan(1);
    const initialActive = list.getAttribute('aria-activedescendant');
    expect(optionIds).toContain(initialActive);

    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const nextActive = list.getAttribute('aria-activedescendant');
    expect(optionIds).toContain(nextActive);
    expect(nextActive).not.toBe(initialActive);

    const focused = list.querySelector<HTMLButtonElement>(`[id="${nextActive}"]`);
    const before = useAppStore.getState().configDraft.devices.outboundVoiceModelId;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    // Enter must commit exactly the highlighted option into the draft field
    // this card owns, not just leave any truthy value behind.
    const committed = useAppStore.getState().configDraft.devices.outboundVoiceModelId;
    expect(committed).not.toBe(before);
    expect(committed).toBe(focused?.getAttribute('data-value'));
  });

  it('handles scenario selector keyboard open, close and boundary navigation', async () => {
    await renderPage();

    const card = scenarioCardByTitle(container, '说给对方');
    const selector = card.querySelector<HTMLButtonElement>('button.scenario-card-selector')!;
    await act(async () => {
      selector.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    let list = card.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(list).not.toBeNull();
    const optionIds = Array.from(list.querySelectorAll('[role="option"]')).map((option) => option.id);
    expect(optionIds.length).toBeGreaterThan(1);

    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    // End → ArrowUp → Home lands on the FIRST option and stays inside the
    // list; a broken boundary clamp would leave a dangling descendant id.
    expect(list.getAttribute('aria-activedescendant')).toBe(optionIds[0]);

    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(card.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => {
      selector.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(card.querySelector('[role="listbox"]')).not.toBeNull();
    await act(async () => {
      selector.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(card.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => {
      selector.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    list = card.querySelector<HTMLElement>('[role="listbox"]')!;
    const option = Array.from(list.querySelectorAll<HTMLButtonElement>('.scenario-card-option')).at(-1)!;
    await act(async () => {
      option.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(card.querySelector('[role="listbox"]')).toBeNull();
  });

  it('covers helper-rendered scenario fallback branches', async () => {
    const onSelect = vi.fn();
    const onEnabledChange = vi.fn();
    const modelOptions = [
      {
        id: 'template-a::model-a',
        model: 'template-a::model-a',
        displayName: 'Alpha Model',
        description: 'Provider A',
        capabilities: ['speech-to-text'] satisfies ProviderCapability[],
        providerTemplateId: 'template-a',
        rawModelId: 'model-a',
      },
      {
        id: 'template-a::model-b',
        model: 'template-a::model-b',
        displayName: 'Beta Model',
        description: 'Provider A',
        capabilities: ['speech-to-speech'] satisfies ProviderCapability[],
        providerTemplateId: 'template-a',
        rawModelId: 'model-b',
      },
    ];

    expect(tWithDefault((_key, options) => options?.defaultValue ?? '', 'audioRouting.unknownKey')).toBe('audioRouting.unknownKey');

    await act(async () => {
      view.root.render(
        <MemoryRouter>
          <ChainFlow
            direction="inbound"
            inboundLabel="Input"
            inboundSubtitle="System audio"
            modelLabel="Model"
            outboundLabel="Output"
          />
          <ScenarioCard
            caption="Fallback caption"
            enableChecked={false}
            icon="headphones"
            modelName=""
            modelOptions={modelOptions}
            modelProvider="Fallback provider"
            onEnabledChange={onEnabledChange}
            onSelect={onSelect}
            tags={[]}
            title="Fallback scenario"
            value="missing-model"
          />
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('.chain-flow-segment-sub')?.textContent).toBe('System audio');
    const card = scenarioCardByTitle(container, 'Fallback scenario');
    expect(card.querySelector('strong')?.textContent).toBe('—');
    expect(card.querySelector('.scenario-card-toggle span')?.textContent).toBe('');

    const selector = card.querySelector<HTMLButtonElement>('button.scenario-card-selector')!;
    await act(async () => {
      selector.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    let list = card.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(list.getAttribute('aria-activedescendant')).toContain('model-a');

    const secondOption = Array.from(list.querySelectorAll<HTMLButtonElement>('.scenario-card-option'))[1]!;
    await act(async () => {
      secondOption.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(list.getAttribute('aria-activedescendant')).toContain('model-b');

    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      list.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('template-a::model-b');

    await act(async () => {
      selector.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    list = card.querySelector<HTMLElement>('[role="listbox"]')!;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('template-a::model-b');
  });

  it('uses legacy outbound processing values and turns virtual microphone output off', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: {
          ...state.configDraft.devices,
          inputLevel: 42,
          aecEnabled: true,
          ansEnabled: false,
          agcEnabled: true,
          virtualMicOutputEnabled: true,
          outboundRoute: {
            ...state.configDraft.devices.outboundRoute,
            input: {
              ...state.configDraft.devices.outboundRoute.input,
              processing: undefined as never,
            },
          },
        },
        speech: {
          ...state.configDraft.speech,
          outputTarget: 'virtual-mic',
          virtualMicOutputEnabled: true,
        },
      },
    }));

    await renderPage();

    const aecToggle = inputText(container.querySelector('.routing-toggle-stack input[type="checkbox"]'));
    await act(async () => {
      aecToggle.click();
    });
    const processing = useAppStore.getState().configDraft.devices.outboundRoute.input.processing;
    expect(processing).toEqual({
      inputLevel: 42,
      echoCancellationEnabled: false,
      noiseSuppressionEnabled: false,
      autoGainControlEnabled: true,
    });

    const outboundCard = scenarioCardByTitle(container, '说给对方');
    const virtualMicSwitch = outboundCard.querySelector<HTMLInputElement>('input[role="switch"]')!;
    await act(async () => {
      virtualMicSwitch.click();
    });

    const state = useAppStore.getState();
    expect(state.configDraft.devices.virtualMicOutputEnabled).toBe(false);
    expect(state.configDraft.speech.outputTarget).toBe('speaker');
    expect(state.configDraft.speech.virtualMicOutputEnabled).toBe(false);
  });

  it('falls back when optional provider model metadata is absent', async () => {
    providerCatalogPreferencesMock.value = [
      { templateId: 'template-openai-compatible-realtime', enabled: true, order: 0 },
      { templateId: 'template-dashscope-realtime', enabled: true, order: 1 },
    ];
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        providers: [
          {
            ...state.configDraft.providers[0]!,
            displayName: 'Fallback Provider',
            sceneModelAssignments: [
              { scenario: 'subtitle-translate', modelIds: ['fallback-text'] },
            ],
            modelCatalogCache: undefined as never,
            localModelCapabilityRegistry: undefined as never,
          },
          {
            ...state.configDraft.providers[1]!,
            sceneModelAssignments: undefined as never,
            modelCatalogCache: undefined as never,
            localModelCapabilityRegistry: undefined as never,
          },
        ],
        devices: {
          ...state.configDraft.devices,
          subtitleTranslationModelId: 'template-openai-compatible-realtime::fallback-text',
        },
      },
    }));

    await renderPage();

    const card = await openScenarioSelect(container, '字幕翻译');
    const optionTexts = Array.from(card.querySelectorAll('.scenario-card-option')).map((option) => option.textContent ?? '');
    expect(optionTexts.some((text) => text.includes('Fallback Provider'))).toBe(true);
    expect(optionTexts.some((text) => text.includes('DashScope'))).toBe(false);
  });

  it('shows an empty model selector state when no provider models are available', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        providers: state.configDraft.providers.map((provider) => ({
          ...provider,
          model: '',
          modelCatalogCache: { ...provider.modelCatalogCache, models: [] },
          sceneModelAssignments: [],
          localModelCapabilityRegistry: [],
        })),
        devices: {
          ...state.configDraft.devices,
          inboundVoiceModelId: '',
        },
      },
    }));

    await renderPage();

    const card = scenarioCardByTitle(container, '听对方');
    await act(async () => {
      card.querySelector<HTMLButtonElement>('button.scenario-card-selector')?.click();
    });
    const list = card.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(list.textContent).toContain('当前提供商没有可用模型');
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(useAppStore.getState().configDraft.devices.inboundVoiceModelId).toBe('');
  });

  it('switches feedback loop prevention back to echo cancellation', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: {
          ...state.configDraft.devices,
          feedbackLoopPrevention: 'virtual-driver',
        },
      },
    }));

    await renderPage();

    const outputPanel = container.querySelector('.routing-output-panel')!;
    const radios = Array.from(outputPanel.querySelectorAll<HTMLButtonElement>('.routing-feedback-option'));
    await act(async () => {
      radios[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useAppStore.getState().configDraft.devices.feedbackLoopPrevention).toBe('echo-cancel');
  });
});

