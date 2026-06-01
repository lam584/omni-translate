import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AudioInputProcessingContract } from '../schema/audio-contract';
import { appConfigDraftMock } from '../mocks/app-config';
import { audioRoutingPageHelpers } from './AudioRoutingPage';

const {
  RoutingModelSelect,
  buildInputProcessing,
  hasCapability,
  isVoiceModel,
  resolveSelectedModel,
  sortRoutingModelOptions,
  updateOutboundTargetEnabled,
  updateOutputTargetEnabled,
} = audioRoutingPageHelpers;

function option(overrides: Record<string, unknown> = {}): any {
  return {
    model: 'provider::model-a',
    rawModelId: 'model-a',
    displayName: 'Model A',
    ownedBy: null,
    createdAt: null,
    capabilities: ['text-generation'],
    providerTemplateId: 'template-a',
    scenarios: ['watch'],
    mismatchMessages: [],
    preferred: false,
    ...overrides,
  };
}

describe('audioRoutingPageHelpers', () => {
  it('builds legacy processing defaults and updates matching route targets only', () => {
    const devices = structuredClone(appConfigDraftMock.devices);
    (devices.outboundRoute.input as { processing: AudioInputProcessingContract | undefined }).processing = undefined;

    expect(buildInputProcessing(devices, { inputLevel: 77 })).toMatchObject({
      inputLevel: 77,
      echoCancellationEnabled: devices.aecEnabled,
      noiseSuppressionEnabled: devices.ansEnabled,
      autoGainControlEnabled: devices.agcEnabled,
    });
    expect(updateOutputTargetEnabled(devices, 'subtitle-engine', true).some((target) => target.kind === 'subtitle-engine' && target.enabled)).toBe(true);
    expect(updateOutboundTargetEnabled(devices, 'virtual-mic', true).some((target) => target.kind === 'virtual-mic' && target.enabled)).toBe(true);
  });

  it('resolves model capabilities, raw ids and all sort tie breakers', () => {
    const alpha = option({ displayName: 'Alpha', model: 'provider::alpha', rawModelId: 'alpha' });
    const beta = option({ displayName: 'Beta', model: 'provider::beta', rawModelId: 'beta', mismatchMessages: ['missing'] });
    const preferred = option({ displayName: 'Preferred', model: 'provider::preferred', rawModelId: 'preferred', preferred: true });

    expect(hasCapability(undefined, 'text-generation')).toBe(false);
    expect(hasCapability(alpha, 'text-generation')).toBe(true);
    expect(isVoiceModel(alpha)).toBe(false);
    expect(isVoiceModel(option({ capabilities: ['speech-to-text'] }))).toBe(true);
    expect(resolveSelectedModel([alpha], 'alpha')).toBe(alpha);
    expect(resolveSelectedModel([alpha], 'missing')).toBeUndefined();
    expect(sortRoutingModelOptions([beta, alpha, preferred])).toEqual([preferred, alpha, beta]);
    expect(sortRoutingModelOptions([option({ displayName: 'Zulu' }), option({ displayName: 'Alpha' })])[0]?.displayName).toBe('Alpha');
  });

  it('renders and selects the explicit empty model option', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSelect = vi.fn();

    await act(async () => {
      root.render(<RoutingModelSelect allowEmpty emptyText="none" label="model" onSelect={onSelect} options={[option()]} placeholder="pick" value="" />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.routing-model-select-button')?.click();
    });

    const emptyOption = container.querySelector<HTMLButtonElement>('[data-value=""]');
    expect(emptyOption?.textContent).toContain('pick');
    expect(emptyOption?.querySelector('.routing-model-select-check')).not.toBeNull();
    await act(async () => {
      emptyOption?.click();
    });
    expect(onSelect).toHaveBeenCalledWith('');

    await act(async () => root.unmount());
    container.remove();
  });
});
