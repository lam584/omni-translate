import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import { ConsoleDock, ConsoleLane, scrollToConsoleSection, useConsoleDock, type ConsoleDockSection } from './ConsoleDock';

const sections: ConsoleDockSection[] = [
  { id: 'first', token: '01', label: 'First' },
  { id: 'second', token: '02', label: 'Second' },
];

let observerCallback: IntersectionObserverCallback | undefined;
const observe = vi.fn();
const disconnect = vi.fn();

class IntersectionObserverMock {
  constructor(callback: IntersectionObserverCallback) {
    observerCallback = callback;
  }

  observe = observe;
  disconnect = disconnect;
}

function HookHarness({ items = sections }: { items?: ConsoleDockSection[] }) {
  const dock = useConsoleDock(items);
  return (
    <div>
      <output>{dock.activeSectionId}:{JSON.stringify(dock.collapsedSections)}</output>
      <button onClick={() => dock.selectSection('first')}>select-first</button>
      <button onClick={() => dock.selectSection('missing')}>select-missing</button>
      <button onClick={() => dock.toggleSection('first')}>toggle-first</button>
      <button onClick={() => dock.expandSection('first')}>expand-first</button>
      <button onClick={dock.expandAllSections}>expand-all</button>
      <button onClick={dock.collapseAllSections}>collapse-all</button>
      {items.map((item) => <section id={item.id} key={item.id} />)}
    </div>
  );
}

function MissingElementsHarness() {
  useConsoleDock(sections);
  return null;
}

describe('ConsoleDock', () => {
  const view = registerDomHarness({
    setup: () => {
      observerCallback = undefined;
      observe.mockReset();
      disconnect.mockReset();
      vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
      HTMLElement.prototype.scrollIntoView = vi.fn();
    },
    cleanup: () => {
      vi.unstubAllGlobals();
    },
  });

  it('renders dock controls and both lane layouts', async () => {
    const onExpandAll = vi.fn();
    const onCollapseAll = vi.fn();
    const onSelectSection = vi.fn();
    const onToggleSection = vi.fn();
    await view.render(
      <>
        <ConsoleDock
          activeSectionId="first"
          collapsedSections={{ second: true }}
          onCollapseAll={onCollapseAll}
          onExpandAll={onExpandAll}
          onSelectSection={onSelectSection}
          onToggleSection={onToggleSection}
          sections={sections}
          title="Dock"
        />
        <ConsoleLane collapsed={false} id="open" label="Open" layoutClassName="layout" onExpand={vi.fn()} token="03">content</ConsoleLane>
        <ConsoleLane collapsed id="closed" label="Closed" layoutClassName="layout" onExpand={onExpandAll} token="04">hidden</ConsoleLane>
      </>,
    );
    const buttons = Array.from(view.container.querySelectorAll<HTMLButtonElement>('button'));
    await act(async () => buttons.find((button) => button.textContent === '全部展开')?.click());
    await act(async () => buttons.find((button) => button.textContent === '全部折叠')?.click());
    await act(async () => buttons.find((button) => button.textContent?.includes('First'))?.click());
    await act(async () => buttons.find((button) => button.textContent === '折叠')?.click());
    await act(async () => buttons.find((button) => button.textContent === '展开分区')?.click());
    expect(onExpandAll).toHaveBeenCalledTimes(2);
    expect(onCollapseAll).toHaveBeenCalled();
    expect(onSelectSection).toHaveBeenCalledWith('first');
    expect(onToggleSection).toHaveBeenCalledWith('first');
    expect(view.container.textContent).toContain('content');
  });

  it('tracks section visibility, scrolling, collapse and expansion', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    await view.render(<HookHarness />);
    expect(observe).toHaveBeenCalledTimes(2);

    await act(async () => {
      observerCallback?.([
        { isIntersecting: true, intersectionRatio: 0.2, target: document.getElementById('first')! },
        { isIntersecting: true, intersectionRatio: 0.8, target: document.getElementById('second')! },
      ] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver);
    });
    expect(view.container.querySelector('output')?.textContent).toContain('second');

    const click = async (label: string) => act(async () => {
      Array.from(view.container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === label)?.click();
    });
    await click('toggle-first');
    expect(view.container.querySelector('output')?.textContent).toContain('"first":true');
    await click('expand-first');
    await click('collapse-all');
    expect(view.container.querySelector('output')?.textContent).toContain('"second":true');
    await click('expand-all');
    expect(view.container.querySelector('output')?.textContent).toContain('"second":false');
    await click('select-first');
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith(null, '', '#first');
    await click('select-missing');

    await act(async () => {
      observerCallback?.([
        { isIntersecting: false, intersectionRatio: 0, target: document.getElementById('first')! },
      ] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver);
    });

    const expandedSections = [...sections, { id: 'third', token: '03', label: 'Third' }];
    await view.render(<HookHarness items={expandedSections} />);
    expect(view.container.querySelector('output')?.textContent).toContain('"third":false');
  });

  it('handles empty dock sections without installing an observer', async () => {
    await view.render(<HookHarness items={[]} />);
    expect(view.container.querySelector('output')?.textContent).toBe(':{}');
    expect(observe).not.toHaveBeenCalled();
  });

  it('skips observer setup when configured sections are absent from the document', async () => {
    await view.render(<MissingElementsHarness />);
    expect(observe).not.toHaveBeenCalled();
  });

  it('skips section scrolling without browser dependencies or a matching target', () => {
    expect(scrollToConsoleSection('first', null as unknown as Window, null as unknown as Document)).toBe(false);
    expect(scrollToConsoleSection('missing', window, document)).toBe(false);
  });
});
