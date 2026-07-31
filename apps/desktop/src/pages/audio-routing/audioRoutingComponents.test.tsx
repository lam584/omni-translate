import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { registerDomHarness } from '../../test-utils/component-test-harness';
import ChainFlow from './ChainFlow';
import ScenarioCard, { resolveChineseFallback } from './ScenarioCard';
import { detectScenarioCapabilities, supportsRoutingScenario, type RoutingModelOption, type ScenarioId } from './routingModelCatalog';

const options: RoutingModelOption[] = [
  { id: 'first', model: 'first/model', displayName: 'First', description: 'One', capabilities: [], providerTemplateId: 'p', rawModelId: 'first/model' },
  { id: 'second', model: 'second/model', displayName: 'Second', description: 'Two', capabilities: [], providerTemplateId: 'p', rawModelId: 'second/model' },
];

describe('audio-routing components', () => {
  const view = registerDomHarness();

  it('renders both chain directions and every optional subtitle', async () => {
    await view.render(<>
      <ChainFlow direction="inbound" inboundLabel="in" modelLabel="model" outboundLabel="out" />
      <ChainFlow direction="outbound" inboundLabel="in" modelLabel="model" outboundLabel="out" />
      <ChainFlow direction="outbound" directionLabel="custom" inboundLabel="in" inboundSubtitle="i" modelLabel="model" modelSubtitle="m" outboundLabel="out" outboundSubtitle="o" />
    </>);
    expect(view.container.textContent).toContain('custom');
    expect(view.container.querySelector('.chain-flow-outbound')).toBeInstanceOf(HTMLElement);
    expect(resolveChineseFallback('audioRouting')).toBe('audioRouting');
    expect(resolveChineseFallback('missing.path')).toBe('missing.path');
  });

  it('covers empty selection, toggle callbacks and every keyboard path', async () => {
    const onSelect = vi.fn();
    const onEnabledChange = vi.fn();
    const render = async (modelOptions: RoutingModelOption[], value = 'missing') => view.render(
      <ScenarioCard icon="settings" title="Scenario" caption="Caption" modelName="" modelProvider="Provider"
        tags={[]} modelOptions={modelOptions} value={value} onSelect={onSelect}
        onEnabledChange={onEnabledChange} enableChecked={false} />,
    );
    await render([], '');
    const selector = view.container.querySelector<HTMLButtonElement>('.scenario-card-selector')!;
    await act(async () => selector.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    const emptyList = view.container.querySelector<HTMLElement>('[role="listbox"]')!;
    await act(async () => emptyList.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => emptyList.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    await render(options);
    const nextSelector = view.container.querySelector<HTMLButtonElement>('.scenario-card-selector')!;
    await act(async () => nextSelector.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true })));
    await act(async () => nextSelector.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    const list = view.container.querySelector<HTMLElement>('[role="listbox"]')!;
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'x']) {
      await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    }
    await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
    expect(onSelect).toHaveBeenCalled();

    await act(async () => nextSelector.click());
    await act(async () => nextSelector.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => view.container.querySelector<HTMLInputElement>('[role="switch"]')!.click());
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it('keeps the menu open for inside clicks and closes it for outside clicks', async () => {
    await view.render(
      <ScenarioCard icon="settings" title="Scenario" caption="Caption" modelName="Model" modelProvider="Provider"
        tags={['stt']} modelOptions={options} value="first/model" onSelect={vi.fn()} active />,
    );
    const selector = view.container.querySelector<HTMLButtonElement>('.scenario-card-selector')!;
    await act(async () => selector.click());
    await act(async () => selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(view.container.querySelector('[role="listbox"]')).toBeInstanceOf(HTMLElement);
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
  });

  describe('routing model catalog exhaustiveness', () => {
    it('returns safe defaults for a future scenario id', () => {
      const model = { capabilities: ['speech-to-text'] } as never;
      expect(supportsRoutingScenario(model, 'future' as ScenarioId)).toBe(false);
      expect(detectScenarioCapabilities(model as never, 'future' as ScenarioId)).toEqual([]);
    });

    it('keeps outbound speech capability absent for STT-only models', () => {
      expect(detectScenarioCapabilities({ capabilities: ['speech-to-text'] } as never, 'outbound')).toEqual([
        'stt',
        'translation',
      ]);
    });
  });
});
