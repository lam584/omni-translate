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

  it('renders two top panels, two model panels, and five scenario cards', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const headings = Array.from(container.querySelectorAll('h3')).map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(['Capture', 'Output', 'Listening models', 'Replying models']));

    expect(container.querySelectorAll('.routing-top-grid > article')).toHaveLength(2);
    expect(container.querySelector('.routing-models-grid')).toBeTruthy();
    expect(container.querySelectorAll('.routing-models-grid > article')).toHaveLength(2);
    expect(container.querySelectorAll('.scenario-card')).toHaveLength(5);
    expect(container.querySelectorAll('.chain-flow-outbound')).toHaveLength(1);
    expect(container.querySelectorAll('.chain-flow-inbound')).toHaveLength(1);
    expect(container.querySelector('.routing-page-header')).toBeNull();
  });

  it('filters the subtitle translation scenario to non-voice models only', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const options = await scenarioOptionTexts(container, 'Subtitle translation');
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

    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const subtitleCard = scenarioCardByTitle(container, 'Subtitle translation');
    expect(subtitleCard.classList.contains('scenario-card-muted')).toBe(true);
    expect(container.textContent).toContain('This card is disabled');
  });

  it('writes independent selections to inbound, outbound, secondary, subtitle, and tts fields', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    await chooseScenarioModel(container, 'Listen to them', 'STT Model');
    await chooseScenarioModel(container, 'Speak to them', 'S2S Model');
    await chooseScenarioModel(container, 'Listen to them · secondary audio', 'Qwen Omni');
    await chooseScenarioModel(container, 'Subtitle translation', 'Qwen3.6 Flash');
    await chooseScenarioModel(container, 'Type-to-speech TTS', 'TTS Model');

    const { devices, speech } = useAppStore.getState().configDraft;
    expect(devices.inboundVoiceModelId).toBe('template-dashscope-realtime::stt-model');
    expect(devices.outboundVoiceModelId).toBe('template-dashscope-realtime::s2s-model');
    expect(devices.inboundSecondaryAudioModelId).toBe('template-dashscope-realtime::qwen3.5-omni-plus-realtime');
    expect(devices.subtitleTranslationModelId).toBe('template-dashscope-realtime::qwen3.6-flash-2026-04-16');
    expect(devices.textToSpeechModelId).toBe('template-dashscope-realtime::tts-model');
    expect(speech.textToSpeechModelId).toBe('template-dashscope-realtime::tts-model');
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
      clickCheckbox(container, 'AEC echo cancellation');
      clickCheckbox(container, 'ANS noise suppression');
      clickCheckbox(container, 'AGC auto gain');
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

  it('writes output toggles into speech and route contracts from the output channels section', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    await act(async () => {
      clickCheckbox(container, 'Output translated speech');
    });

    const { devices, speech } = useAppStore.getState().configDraft;
    expect(devices.outputSpeechEnabled).toBe(false);
    expect(devices.outboundRoute.mixControl.translatedAudioEnabled).toBe(false);
    expect(speech.enabled).toBe(false);
  });

  it('toggles the secondary audio output channel in the unified section', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const section = container.querySelector('.routing-channel-section-unified');
    expect(section).toBeTruthy();
    const secondaryToggle = section?.querySelector('input[type="checkbox"]') as HTMLInputElement;
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

  it('toggles the per-card enable switch for the subtitle translation card', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const subtitleCard = scenarioCardByTitle(container, 'Subtitle translation');
    const toggle = inputText(subtitleCard.querySelector('input[type="checkbox"]'));
    expect(toggle.checked).toBe(true);
    expect(useAppStore.getState().configDraft.devices.subtitleTranslationMode).toBe('secondary');

    await act(async () => {
      toggle.click();
    });

    expect(useAppStore.getState().configDraft.devices.subtitleTranslationMode).toBe('native');
    expect(subtitleCard.classList.contains('scenario-card-muted')).toBe(true);

    await act(async () => {
      toggle.click();
    });

    expect(useAppStore.getState().configDraft.devices.subtitleTranslationMode).toBe('secondary');
    expect(subtitleCard.classList.contains('scenario-card-muted')).toBe(false);
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

    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const subtitleCard = scenarioCardByTitle(container, 'Subtitle translation');
    const selector = subtitleCard.querySelector<HTMLButtonElement>('button.scenario-card-selector');
    expect(selector?.disabled).toBe(true);
  });

  it('places the virtual microphone output toggle inside the unified output channel section', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const virtualMicToggle = Array.from(container.querySelectorAll('label')).find((item) =>
      item.textContent?.includes('Send translated voice to virtual microphone'),
    );
    const owningSection = virtualMicToggle?.closest('.routing-channel-section-unified');
    const owningChannel = virtualMicToggle?.closest('.routing-channel-section');

    expect(owningSection).toBeTruthy();
    expect(owningChannel).toBeTruthy();
  });

  it('places the speech output toggle inside the unified output channel section', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const speechToggle = Array.from(container.querySelectorAll('label')).find((item) =>
      item.textContent?.includes('Output translated speech'),
    );
    const owningSection = speechToggle?.closest('.routing-channel-section-unified');
    const owningChannel = speechToggle?.closest('.routing-channel-section');

    expect(owningSection).toBeTruthy();
    expect(owningChannel).toBeTruthy();
  });

  it('places the subtitle translation model inside the inbound model panel', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const subtitleCard = scenarioCardByTitle(container, 'Subtitle translation');
    const owningSection = subtitleCard.closest('.routing-models-inbound-panel');
    expect(owningSection).toBeTruthy();
  });

  it('places the secondary audio toggle in the unified section instead of the card', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const secondaryCard = scenarioCardByTitle(container, 'Listen to them · secondary audio');
    const cardToggle = secondaryCard.querySelector('input[type="checkbox"]');
    expect(cardToggle).toBeNull();
    const section = container.querySelector('.routing-channel-section-unified');
    const sectionToggles = Array.from(section?.querySelectorAll('input[type="checkbox"]') ?? []);
    expect(sectionToggles.length).toBe(3);
  });

  it('places the subtitle translation card enable toggle inside the listening model panel', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const subtitleCard = scenarioCardByTitle(container, 'Subtitle translation');
    const subtitleToggle = inputText(subtitleCard.querySelector('input[type="checkbox"]'));
    const owningSection = subtitleCard.closest('.routing-models-inbound-panel');
    expect(owningSection).toBeTruthy();
    expect(subtitleToggle.checked).toBe(true);
  });

  it('places feedback loop prevention options in the output panel', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

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

    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    expect((await scenarioOptionTexts(container, 'Subtitle translation')).join(' ')).not.toContain('Qwen3.6 Flash');
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

    expect((await scenarioOptionTexts(container, 'Subtitle translation')).join(' ')).not.toContain('Qwen3.6 Flash');
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

    expect(scenarioCardByTitle(container, 'Listen to them').textContent).toContain('Qwen Omni');

    providerCatalogPreferencesMock.value = [
      { templateId: 'template-openai-compatible-realtime', enabled: true, order: 0 },
      { templateId: 'template-dashscope-realtime', enabled: false, order: 1 },
    ];

    await act(async () => {
      window.dispatchEvent(new Event('omni.providerTemplateCatalogPrefs.updated'));
    });

    expect((await scenarioOptionTexts(container, 'Subtitle translation')).join(' ')).not.toContain('Qwen3.6 Flash');
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

    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const outputSelect = Array.from(container.querySelectorAll<HTMLSelectElement>('select.select-input'))
      .find((select) => Array.from(select.options).some((option) => option.textContent?.includes('扬声器')));
    expect(outputSelect).toBeTruthy();
    expect(
      Array.from(outputSelect!.options).some((option) =>
        option.textContent?.includes('Omni Translate Virtual Speaker'),
      ),
    ).toBe(false);
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
    await changeValue(deviceSelects[0], audioRuntimeSnapshotMock.captureDevices[0].deviceId);
    await changeValue(deviceSelects[1], audioRuntimeSnapshotMock.renderDevices[0].deviceId);
    await changeValue(levels[0], '44');
    await changeValue(levels[1], '66');
    await act(async () => {
      const voiceToggles = container.querySelectorAll<HTMLInputElement>('.routing-channel input[type="checkbox"]');
      voiceToggles[voiceToggles.length - 1].click();
    });

    const testButtons = container.querySelectorAll<HTMLButtonElement>('.routing-test-row button');
    await act(async () => {
      testButtons[0].click();
      testButtons[1].click();
      await vi.advanceTimersByTimeAsync(900);
    });

    const subtitleModeCheckbox = inputText(
      scenarioCardByTitle(container, 'Subtitle translation').querySelector('input[type="checkbox"]') ?? null,
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
    expect(container.textContent).toContain('Speaker test passed');
    expect(container.textContent).toContain('Mic test passed');
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
        },
        speech: {
          ...state.configDraft.speech,
          textToSpeechModelId: 'template-dashscope-realtime::tts-model',
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

    expect(container.textContent).toContain('Current model does not support Omni native audio');

    const subtitleCard = scenarioCardByTitle(container, 'Subtitle translation');
    const toggle = inputText(subtitleCard.querySelector('input[type="checkbox"]') ?? null);
    await act(async () => {
      toggle.click();
    });

    expect(useAppStore.getState().configDraft.devices.subtitleTranslationMode).toBe('secondary');
    expect(container.textContent).not.toContain('Current model does not support Omni native audio');
  });

  it('shows microphone and speaker test buttons with audio level meters', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const buttons = Array.from(container.querySelectorAll('button')).map((button) => button.textContent ?? '');
    expect(buttons).toEqual(expect.arrayContaining([expect.stringContaining('Test mic'), expect.stringContaining('Test speaker')]));
    expect(container.querySelectorAll('.audio-level-meter')).toHaveLength(2);
  });

  it('saves model selections immediately without a save button', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('.routing-saved-indicator')).toBeTruthy();
    expect(container.textContent).toContain('Changes saved automatically');

    await chooseScenarioModel(container, 'Listen to them', 'S2S Model');
    expect(useAppStore.getState().configDraft.devices.inboundVoiceModelId).toBe('template-dashscope-realtime::s2s-model');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(container.querySelector('.routing-saved-indicator')?.textContent).toContain('Saved just now');
  });

  it('renders embedded chain flow segments with model and device labels', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const outboundFlow = container.querySelector('.chain-flow-outbound');
    const inboundFlow = container.querySelector('.chain-flow-inbound');
    expect(outboundFlow).toBeTruthy();
    expect(inboundFlow).toBeTruthy();
    expect(container.textContent).toContain('System / peer audio');
    expect(container.textContent).toContain('Local playback');
    expect(container.textContent).toContain('Return to peer');
  });

  it('exposes scenario toggles as ARIA switches with aria-checked', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const switches = Array.from(container.querySelectorAll('input[role="switch"]'));
    expect(switches.length).toBeGreaterThan(0);
    for (const node of switches) {
      expect(node.getAttribute('aria-checked')).toBe('true');
    }
  });

  it('supports keyboard navigation inside scenario listboxes', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AudioRoutingPage />
        </MemoryRouter>,
      );
    });

    const cards = Array.from(container.querySelectorAll('.scenario-card'));
    const firstCard = cards[0] as HTMLElement;
    const selector = firstCard.querySelector('.scenario-card-selector') as HTMLButtonElement;
    selector.focus();
    await act(async () => {
      selector.click();
    });
    const list = firstCard.querySelector('[role="listbox"]') as HTMLElement;
    expect(list).toBeTruthy();

    const initialActive = list.getAttribute('aria-activedescendant');
    expect(initialActive).toBeTruthy();

    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const nextActive = list.getAttribute('aria-activedescendant');
    expect(nextActive).toBeTruthy();
    expect(nextActive).not.toBe(initialActive);

    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(useAppStore.getState().configDraft.devices.inboundVoiceModelId).toBeTruthy();
  });
});
