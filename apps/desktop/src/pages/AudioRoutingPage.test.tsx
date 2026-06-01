import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { useAppStore } from '../stores/app-store';
import AudioRoutingPage from './AudioRoutingPage';

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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

function inputText(input: Element | null) {
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Expected input element');
  }
  return input;
}

function clickCheckbox(container: HTMLElement, label: string) {
  const input = inputText(Array.from(container.querySelectorAll('label')).find((item) => item.textContent?.includes(label))?.querySelector('input') ?? null);
  input.click();
}

function findButtonByText(root: HTMLElement, text: string) {
  return Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes(text));
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

function modelSelectByLabel(container: HTMLElement, label: string) {
  const select = Array.from(container.querySelectorAll<HTMLElement>('.routing-model-select')).find((item) => item.textContent?.includes(label));
  if (!select) {
    throw new Error(`Expected model select ${label}`);
  }
  return select;
}

function modelOptionTexts(container: HTMLElement, label: string) {
  const select = modelSelectByLabel(container, label);
  return Array.from(select.querySelectorAll('.routing-model-select-option')).map((option) => option.textContent ?? '');
}

async function openModelSelect(container: HTMLElement, label: string) {
  const select = modelSelectByLabel(container, label);
  await act(async () => {
    select.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return select;
}

async function modelSelectOptionValues(container: HTMLElement, label: string) {
  const select = await openModelSelect(container, label);
  return Array.from(select.querySelectorAll<HTMLElement>('.routing-model-select-option')).map((option) => ({
    text: option.textContent ?? '',
    value: option.dataset.value ?? '',
  }));
}

async function chooseModel(container: HTMLElement, label: string, modelText: string) {
  const select = await openModelSelect(container, label);
  const option = Array.from(select.querySelectorAll('button')).find((button) => button.textContent?.includes(modelText));
  if (!option) {
    throw new Error(`Expected model option ${modelText}`);
  }
  await act(async () => {
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('AudioRoutingPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
    configDraft.devices.textToSpeechModelId = 'template-dashscope-realtime::qwen3.5-omni-plus-realtime';
    configDraft.speech.textToSpeechModelId = 'template-dashscope-realtime::qwen3.5-omni-plus-realtime';
    configDraft.providers.push(linkedDashscope);

    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot: structuredClone(audioRuntimeSnapshotMock),
      configDraft,
    }));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders the pipeline layout without language summary cards', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const headings = Array.from(container.querySelectorAll('h3')).map((heading) => heading.textContent);
    expect(headings).toEqual(expect.arrayContaining(['输入设备', '语音模型', '输出设备', '字幕翻译模式', '运行状态']));
    const overviewArrows = Array.from(container.querySelectorAll('.routing-overview-arrow')).map((arrow) => arrow.textContent);
    expect(overviewArrows).toEqual(['→', '←', '←']);
    expect(container.querySelector('.routing-kicker')).toBeNull();
    expect(container.textContent).not.toContain('源语言');
    expect(container.textContent).not.toContain('目标语言');
  });

  it('shows only enabled subtitle translation text models for secondary subtitle translation', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const options = await modelSelectOptionValues(container, '文本翻译模型');
    const optionText = options.map((option) => option.text).join(' ');

    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('Qwen3.6 Flash'),
          value: 'template-dashscope-realtime::qwen3.6-flash-2026-04-16',
        }),
      ]),
    );
    expect(optionText).not.toContain('STT Model');
    expect(optionText).not.toContain('TTS Model');
    expect(optionText).not.toContain('S2S Model');
    expect(optionText).not.toContain('Qwen Omni');
  });

  it('shows mode descriptions and hides the text translation model in native mode', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        devices: {
          ...state.configDraft.devices,
          subtitleTranslationMode: 'native',
        },
      },
    }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain('使用语音模型的原生字幕翻译。');
    expect(container.textContent).toContain('先显示原文，再用文本模型逐句翻译。');
    expect(container.textContent).not.toContain('文本翻译模型');
  });

  it('stores inbound and outbound voice model selections independently', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    await chooseModel(container, '翻译对方声音的模型', 'STT Model');
    await act(async () => {
      findButtonByText(container, '仍然选择')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await chooseModel(container, '翻译我的麦克风的模型', 'S2S Model');

    const { devices } = useAppStore.getState().configDraft;
    expect(devices.inboundVoiceModelId).toBe('template-dashscope-realtime::stt-model');
    expect(devices.outboundVoiceModelId).toBe('template-dashscope-realtime::s2s-model');
  });

  it('writes input processing toggles into the outbound route contract', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    await act(async () => {
      clickCheckbox(container, 'AEC 回声消除');
      clickCheckbox(container, 'ANS 噪声抑制');
      clickCheckbox(container, 'AGC 自动增益');
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

  it('writes output toggles into speech and route contracts', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    await act(async () => {
      clickCheckbox(container, '输出翻译语音');
      clickCheckbox(container, '输出翻译字幕');
    });

    const { devices, speech } = useAppStore.getState().configDraft;
    expect(devices.outputSpeechEnabled).toBe(false);
    expect(devices.outboundRoute.mixControl.translatedAudioEnabled).toBe(false);
    expect(speech.enabled).toBe(false);
    expect(devices.outputSubtitlesEnabled).toBe(false);
    expect(devices.inboundRoute.outputs.find((target) => target.kind === 'subtitle-engine')?.enabled).toBe(false);
  });

  it('shows voice models only and prioritizes capability matches in routing selectors', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    await openModelSelect(container, '翻译对方声音的模型');
    const inboundOptions = modelOptionTexts(container, '翻译对方声音的模型');
    expect(inboundOptions.join(' ')).toContain('STT Model');
    expect(inboundOptions.join(' ')).toContain('S2S Model');
    expect(inboundOptions.join(' ')).toContain('TTS Model');
    expect(inboundOptions.join(' ')).not.toContain('Qwen3.6 Flash');
    expect(inboundOptions.findIndex((text) => text.includes('TTS Model'))).toBeGreaterThan(
      inboundOptions.findIndex((text) => text.includes('STT Model')),
    );

    await openModelSelect(container, '将文字转换为语音的模型');
    const ttsOptions = modelOptionTexts(container, '将文字转换为语音的模型');
    expect(ttsOptions[0]).toContain('Qwen Omni');
    expect(ttsOptions[1]).toContain('S2S Model');
  });

  it('hides models from disabled provider templates', async () => {
    providerCatalogPreferencesMock.value = [
      { templateId: 'template-openai-compatible-realtime', enabled: true, order: 0 },
      { templateId: 'template-dashscope-realtime', enabled: false, order: 1 },
    ];

    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    expect(modelSelectByLabel(container, '翻译对方声音的模型').textContent).toContain('当前服务商没有可用模型');
    expect((await modelSelectOptionValues(container, '文本翻译模型')).map((option) => option.text).join(' ')).not.toContain('Qwen3.6 Flash');
    expect(container.textContent).not.toContain('STT Model');
    expect(container.textContent).not.toContain('Qwen Omni');
  });

  it('hides models from locally hidden provider templates', async () => {
    providerCatalogPreferencesMock.value = [
      { templateId: 'template-openai-compatible-realtime', enabled: true, order: 0 },
      { templateId: 'template-dashscope-realtime', enabled: true, hidden: true, order: 1 },
    ];

    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    expect((await modelSelectOptionValues(container, '文本翻译模型')).map((option) => option.text).join(' ')).not.toContain('Qwen3.6 Flash');
    expect(container.textContent).not.toContain('Qwen Omni');
  });

  it('refreshes routing model lists when a provider template is disabled in the same window', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    expect(modelSelectByLabel(container, '翻译对方声音的模型').textContent).toContain('Qwen Omni');

    providerCatalogPreferencesMock.value = [
      { templateId: 'template-openai-compatible-realtime', enabled: true, order: 0 },
      { templateId: 'template-dashscope-realtime', enabled: false, order: 1 },
    ];

    await act(async () => {
      window.dispatchEvent(new Event('omni.providerTemplateCatalogPrefs.updated'));
    });

    expect(modelSelectByLabel(container, '翻译对方声音的模型').textContent).toContain('当前服务商没有可用模型');
    expect((await modelSelectOptionValues(container, '文本翻译模型')).map((option) => option.text).join(' ')).not.toContain('Qwen3.6 Flash');
    expect(container.textContent).not.toContain('Qwen Omni');
  });

  it('confirms mismatched model selection without changing output toggles', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    await chooseModel(container, '翻译对方声音的模型', 'TTS Model');
    expect(container.textContent).toContain('模型可能不支持对方声音翻译输出');

    await act(async () => {
      findButtonByText(container, '仍然选择')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    let { devices } = useAppStore.getState().configDraft;
    expect(devices.inboundVoiceModelId).toBe('template-dashscope-realtime::tts-model');
    expect(devices.outputSpeechEnabled).toBe(true);
    expect(devices.outputSubtitlesEnabled).toBe(true);

    await chooseModel(container, '翻译我的麦克风的模型', 'STT Model');
    expect(container.textContent).toContain('模型可能不支持麦克风译音输出');

    await act(async () => {
      findButtonByText(container, '取消选择')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    devices = useAppStore.getState().configDraft.devices;
    expect(devices.outboundVoiceModelId).toBe('template-dashscope-realtime::qwen3.5-omni-plus-realtime');
    expect(devices.virtualMicOutputEnabled).toBe(true);
  });

  it('stores text-to-speech model selections into devices and speech drafts', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    await chooseModel(container, '将文字转换为语音的模型', 'S2S Model');

    const { devices, speech } = useAppStore.getState().configDraft;
    expect(devices.textToSpeechModelId).toBe('template-dashscope-realtime::s2s-model');
    expect(speech.textToSpeechModelId).toBe('template-dashscope-realtime::s2s-model');
  });

  it('places the virtual microphone output toggle inside the voice model card', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const virtualMicToggle = Array.from(container.querySelectorAll('label')).find((item) =>
      item.textContent?.includes('将翻译后的语音发送到虚拟麦克风'),
    );
    const owningPanel = virtualMicToggle?.closest('article');

    expect(owningPanel?.querySelector('h3')?.textContent).toBe('语音模型');
  });

  it('places feedback loop prevention inside the output device card and stores echo cancellation', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const feedbackControls = container.querySelector('.routing-output-feedback');
    expect(feedbackControls).toBeTruthy();
    expect(container.querySelector('.routing-feedback-panel')).toBeNull();
    expect(feedbackControls?.closest('article')?.querySelector('h3')?.textContent).toBe('输出设备');
    expect(container.textContent).toContain('音频反馈循环抑制');
    expect(container.textContent).not.toContain('不进行反馈抑制');
    const echoButton = findButtonByText(container, '回声消除');
    expect(echoButton).toBeTruthy();

    await act(async () => {
      echoButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(useAppStore.getState().configDraft.devices.feedbackLoopPrevention).toBe('echo-cancel');
  });

  it('disables virtual driver feedback prevention until the driver is running', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const virtualDriverButton = findButtonByText(container, '虚拟音频驱动') as HTMLButtonElement | undefined;
    expect(virtualDriverButton?.disabled).toBe(true);

    await act(async () => {
      virtualDriverButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useAppStore.getState().configDraft.devices.feedbackLoopPrevention).toBe('none');
  });

  it('allows virtual driver feedback prevention when the driver is running', async () => {
    useAppStore.setState((state) => ({
      ...state,
      runtimeSnapshot: {
        ...state.runtimeSnapshot,
        bridge: {
          ...state.runtimeSnapshot.bridge,
          driverHealth: 'running',
        },
      },
    }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const virtualDriverButton = findButtonByText(container, '虚拟音频驱动') as HTMLButtonElement | undefined;
    expect(virtualDriverButton?.disabled).toBe(false);

    await act(async () => {
      virtualDriverButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useAppStore.getState().configDraft.devices.feedbackLoopPrevention).toBe('virtual-driver');
    expect(useAppStore.getState().configDraft.speech.localPlaybackEnabled).toBe(true);
    expect(useAppStore.getState().configDraft.speech.virtualMicOutputEnabled).toBe(true);
    expect(useAppStore.getState().configDraft.speech.outputTarget).toBe('virtual-mic');
  });

  it('updates devices, levels, virtual microphone output and subtitle mode controls', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const deviceSelects = container.querySelectorAll<HTMLSelectElement>('select.select-input');
    const levels = container.querySelectorAll<HTMLInputElement>('input[type="range"]');
    await changeValue(deviceSelects[0], audioRuntimeSnapshotMock.renderDevices[0].deviceId);
    await changeValue(deviceSelects[1], audioRuntimeSnapshotMock.captureDevices[0].deviceId);
    await changeValue(levels[0], '66');
    await changeValue(levels[1], '44');
    await act(async () => {
      const voiceToggles = container.querySelectorAll<HTMLInputElement>('.routing-panel-emphasis input[type="checkbox"]');
      voiceToggles[voiceToggles.length - 1].click();
    });

    const testButtons = container.querySelectorAll<HTMLButtonElement>('.routing-action-row button');
    await act(async () => {
      testButtons[0].click();
      testButtons[1].click();
      await vi.advanceTimersByTimeAsync(900);
    });

    const subtitleModeButtons = container.querySelectorAll<HTMLButtonElement>('.routing-lower-grid .routing-mode-card');
    await act(async () => {
      subtitleModeButtons[0].click();
      subtitleModeButtons[1].click();
    });
    const subtitleSelect = container.querySelector<HTMLElement>('.routing-lower-grid .routing-model-select')!;
    await act(async () => {
      subtitleSelect.querySelector('button')?.click();
    });
    await act(async () => {
      Array.from(subtitleSelect.querySelectorAll('button')).find((button) => button.textContent?.includes('Qwen3.6 Flash'))?.click();
    });

    const { devices, speech } = useAppStore.getState().configDraft;
    expect(devices.outputLevel).toBe(66);
    expect(devices.inputLevel).toBe(44);
    expect(devices.virtualMicOutputEnabled).toBe(false);
    expect(speech.outputTarget).toBe('speaker');
    expect(devices.subtitleTranslationMode).toBe('secondary');
    expect(devices.subtitleTranslationModelId).toBe('template-dashscope-realtime::qwen3.6-flash-2026-04-16');
    expect(container.textContent).toContain('speaker ok');
    expect(container.textContent).toContain('mic ok');
    vi.useRealTimers();
  });

  it('dismisses an unsupported model warning by clicking its backdrop', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const inboundSelect = container.querySelector<HTMLElement>('.routing-panel-emphasis .routing-model-select')!;
    await act(async () => {
      inboundSelect.querySelector('button')?.click();
    });
    await act(async () => {
      Array.from(inboundSelect.querySelectorAll('button')).find((button) => button.textContent?.includes('TTS Model'))?.click();
    });
    expect(container.querySelector('.routing-modal-backdrop')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLElement>('.routing-modal-backdrop')?.click();
    });
    expect(container.querySelector('.routing-modal-backdrop')).toBeNull();
  });

  it('shows microphone and speaker test buttons plus save and reset actions', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const buttons = Array.from(container.querySelectorAll('button')).map((button) => button.textContent ?? '');
    expect(buttons).toEqual(expect.arrayContaining([expect.stringContaining('测试麦克风'), expect.stringContaining('测试扬声器')]));
  });
});
