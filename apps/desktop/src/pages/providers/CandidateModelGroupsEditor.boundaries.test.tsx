import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import CandidateModelGroupsEditor from './CandidateModelGroupsEditor';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => `${key}${options?.modalities ? ': ' + options.modalities : ''}` }) }));

describe('candidate model reorder and advisory metadata boundaries', () => {
  const view = registerDomHarness();
  function provider() {
    const draft = structuredClone(appConfigDraftMock.providers[0]);
    draft.candidateModelGroups = [{ group: 'audio-understanding', modelIds: ['first', 'second'] }, { group: 'text-processing', modelIds: ['text'] }];
    return draft;
  }
  function row(id: string) { return Array.from(view.container.querySelectorAll('[draggable]')).find((element) => element.querySelector('strong')?.textContent === id)!; }
  async function drag(element: Element, event: string) {
    await act(async () => { element.dispatchEvent(new Event(event, { bubbles: true, cancelable: true })); });
  }

  it('ignores drops without a drag, across groups or onto the source model', async () => {
    const draft = provider(); const onChange = vi.fn();
    await view.render(<CandidateModelGroupsEditor provider={draft} modelLookup={new Map()} localModelCapabilityRegistry={[]} onChange={onChange} />);
    const rows = view.container.querySelectorAll('[draggable]');
    expect(rows).toHaveLength(3);
    await drag(row('second'), 'drop');
    await drag(row('first'), 'dragstart');
    await drag(row('first'), 'drop');
    await drag(row('text'), 'drop');
    expect(onChange).not.toHaveBeenCalled();
    await drag(row('first'), 'dragend');
    await drag(row('second'), 'drop');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores a stale drag source removed by a concurrent provider update', async () => {
    const draft = provider(); const onChange = vi.fn();
    const render = () => view.render(<CandidateModelGroupsEditor provider={draft} modelLookup={new Map()} localModelCapabilityRegistry={[]} onChange={onChange} />);
    await render();
    await drag(row('first'), 'dragstart');
    draft.candidateModelGroups![0].modelIds = ['second'];
    await render();
    await drag(row('second'), 'drop');
    expect(onChange).not.toHaveBeenCalled();
    expect(row('second').textContent).toContain('second');
  });

  it('shows missing directory modalities explicitly and hides expired advisory rows', async () => {
    const draft = provider(); const onChange = vi.fn();
    draft.modelMetadataCache = { source: 'bailian-api', fetchedAt: new Date().toISOString(), models: [{ modelId: 'first', categories: [], requestModalities: [], responseModalities: [] }] };
    const render = () => view.render(<CandidateModelGroupsEditor provider={draft} modelLookup={new Map()} localModelCapabilityRegistry={[]} onChange={onChange} />);
    await render();
    expect(view.container.textContent).toContain('providers.candidateModels.inputModalities: —');
    expect(view.container.textContent).toContain('providers.candidateModels.outputModalities: —');
    draft.modelMetadataCache.fetchedAt = '2000-01-01T00:00:00Z';
    await render();
    expect(view.container.textContent).not.toContain('providers.candidateModels.inputModalities');
    expect(view.container.querySelectorAll('[draggable]')).toHaveLength(3);
    expect(onChange).not.toHaveBeenCalled();
  });
});
