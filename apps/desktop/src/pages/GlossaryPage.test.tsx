import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { useAppStore } from '../stores/app-store';
import GlossaryPage from './GlossaryPage';

async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes(text));
}

async function inputText(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function selectValue(element: HTMLSelectElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  await act(async () => {
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function changeChecked(element: HTMLInputElement, checked: boolean) {
  const checkedSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
  await act(async () => {
    checkedSetter?.call(element, checked);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function clickBySelector<T extends HTMLElement = HTMLElement>(container: HTMLElement, selector: string, index = 0) {
  return Array.from(container.querySelectorAll<T>(selector))[index];
}

describe('GlossaryPage compact labels', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.glossary.processingMode = 'post-calibrate';

    useAppStore.setState((state) => ({
      ...state,
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders localized section titles without redundant English kickers', async () => {
    await act(async () => {
      root.render(<GlossaryPage />);
    });

    expect(container.querySelector('.routing-kicker')).toBeNull();
    expect(container.textContent).not.toContain('Libraries');
    expect(container.textContent).not.toContain('Preview');
    expect(container.textContent).not.toContain('Policy');
  });

  it('labels post-calibration mode as no term injection', async () => {
    await act(async () => {
      root.render(<GlossaryPage />);
    });

    expect(container.textContent).toContain('不注入术语');
    expect(container.textContent).toContain('翻译后按术语库校准，不向 prompt 注入术语。');
    expect(container.textContent).not.toContain('翻译后校准');
  });

  it('guides an empty workspace through validation and keyboard library creation', async () => {
    await act(async () => root.render(<GlossaryPage />));
    await click(buttonByText(container, '添加术语'));
    expect(container.textContent).toContain('请先新建术语库');
    await click(buttonByText(container, '立即新建术语库'));
    await click(buttonByText(container, '创建'));
    expect(container.textContent).toContain('请输入术语库名称');

    const nameInput = container.querySelector<HTMLInputElement>('.glossary-library-name-input')!;
    await inputText(nameInput, '影视字幕');
    await act(async () => {
      nameInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
    expect(useAppStore.getState().configDraft.glossary.libraries[0]?.name).toBe('影视字幕');

    await click(buttonByText(container, '新建术语库'));
    const secondNameInput = container.querySelector<HTMLInputElement>('.glossary-library-name-input')!;
    await inputText(secondNameInput, '影视字幕');
    await click(buttonByText(container, '创建'));
    expect(container.textContent).toContain('已存在同名术语库');
    await act(async () => {
      secondNameInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });
    expect(container.querySelector('.glossary-library-dialog')).toBeNull();
  });

  it('renders populated libraries and runs filters, preview, entry and library actions', async () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.glossary.libraries = [
      {
        id: 'watch',
        name: 'Watch Terms',
        enabled: true,
        priority: 0,
        entries: [
          { id: 'gg', sourceLang: 'en-US', targetLang: 'zh-CN', sourceTerm: 'GG', targetTerm: '好局', strategy: 'force', important: true, caseSensitive: false, wholeWord: true },
          { id: 'npc', sourceLang: 'en-US', targetLang: 'zh-CN', sourceTerm: 'NPC', targetTerm: '角色', strategy: 'suggest', important: false, caseSensitive: false, wholeWord: false },
        ],
      },
      { id: 'secondary', name: 'Secondary', enabled: true, priority: 1, entries: [] },
    ];
    useAppStore.setState((state) => ({ ...state, configDraft }));
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await act(async () => root.render(<GlossaryPage />));
    expect(container.textContent).toContain('Watch Terms');
    expect(container.textContent).toContain('GG');
    expect(container.textContent).toContain('强制');
    expect(container.textContent).toContain('建议');

    await inputText(container.querySelector<HTMLInputElement>('input[placeholder="搜索术语……"]')!, 'NPC');
    expect(container.textContent).not.toContain('GG');
    await inputText(container.querySelector<HTMLInputElement>('input[placeholder="搜索术语……"]')!, '');
    await selectValue(container.querySelector<HTMLSelectElement>('.glossary-filter-row select')!, 'suggest');
    expect(container.textContent).toContain('NPC');
    await selectValue(container.querySelector<HTMLSelectElement>('.glossary-filter-row select')!, '');
    await changeChecked(container.querySelector<HTMLInputElement>('.glossary-filter-row input[type="checkbox"]')!, true);
    expect(container.textContent).toContain('GG');

    await inputText(container.querySelector<HTMLTextAreaElement>('textarea')!, 'GG is good');
    await click(buttonByText(container, '测试校准'));
    expect(container.textContent).toContain('好局 is good');

    await click(buttonByText(container, '全量注入'));
    expect(useAppStore.getState().configDraft.glossary.processingMode).toBe('inject-all');
    await click(buttonByText(container, '仅重要术语'));
    expect(useAppStore.getState().configDraft.glossary.processingMode).toBe('inject-important');

    await click(container.querySelector<HTMLButtonElement>('[title="取消重要标记"]'));
    await click(container.querySelector<HTMLButtonElement>('[title="导出此库"]'));
    expect(URL.createObjectURL).toHaveBeenCalled();
    await click(container.querySelector<HTMLButtonElement>('[title="禁用"]'));
    expect(useAppStore.getState().configDraft.glossary.libraries[0]?.enabled).toBe(false);

    await click(buttonByText(container, '添加术语'));
    const dialogInputs = container.querySelectorAll<HTMLInputElement>('.glossary-dialog-grid .text-input');
    await inputText(dialogInputs[0]!, 'Boss');
    await inputText(dialogInputs[1]!, '首领');
    await click(buttonByText(container, '保留原文'));
    await click(buttonByText(container, '保存'));
    expect(useAppStore.getState().configDraft.glossary.libraries[0]?.entries.some((entry) => entry.sourceTerm === 'Boss')).toBe(true);

    await click(container.querySelectorAll<HTMLButtonElement>('[title="删除"]')[0]);
    expect(useAppStore.getState().configDraft.glossary.libraries).toHaveLength(1);
  });

  it('imports recognized glossary JSON and reports parse, read and empty-file failures', async () => {
    let readerResult = JSON.stringify([
      { id: 'direct', name: 'Direct', entries: [], enabled: true, priority: 0 },
      { invalid: true },
    ]);
    let readerFails = false;
    class MockFileReader {
      result: string | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;

      readAsText() {
        if (readerFails) {
          this.onerror?.();
          return;
        }
        this.result = readerResult;
        this.onload?.();
      }
    }
    vi.stubGlobal('FileReader', MockFileReader);
    await act(async () => root.render(<GlossaryPage />));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const clickSpy = vi.spyOn(input, 'click');
    await click(buttonByText(container, '导入文件'));
    expect(clickSpy).toHaveBeenCalled();

    const dispatchFile = async (files: File[]) => {
      Object.defineProperty(input, 'files', { configurable: true, value: files });
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    await dispatchFile([new File(['test'], 'terms.json', { type: 'application/json' })]);
    expect(container.textContent).toContain('成功导入 1 个术语库，1 个条目被跳过。');

    readerResult = '{';
    await dispatchFile([new File(['test'], 'bad.json', { type: 'application/json' })]);
    expect(container.textContent).toContain('文件解析失败');

    readerFails = true;
    await dispatchFile([new File(['test'], 'unreadable.json', { type: 'application/json' })]);
    expect(container.textContent).toContain('文件读取失败');

    await dispatchFile([]);
    expect(container.textContent).toContain('文件读取失败');
  });

  it('edits, deletes, paginates, reorders and resolves conflicting entries', async () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const entries = Array.from({ length: 14 }, (_, index) => ({
      id: `term-${index}`,
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      sourceTerm: `Term ${index}`,
      targetTerm: `术语 ${index}`,
      strategy: 'force' as const,
      important: false,
      caseSensitive: false,
      wholeWord: true,
    }));
    configDraft.glossary.libraries = [
      { id: 'watch', name: 'Watch Terms', enabled: true, priority: 0, entries },
      {
        id: 'secondary',
        name: 'Secondary',
        enabled: true,
        priority: 1,
        entries: [{ ...entries[0], id: 'boss-conflict', sourceTerm: 'Boss', targetTerm: '旧译名' }],
      },
    ];
    useAppStore.setState((state) => ({ ...state, configDraft }));
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await act(async () => root.render(<GlossaryPage />));

    await click(buttonByText(container, '下一页'));
    expect(container.textContent).toContain('Term 13');
    await click(buttonByText(container, '上一页'));
    await click(buttonByText(container, '导出全部'));
    expect(URL.createObjectURL).toHaveBeenCalled();

    const cards = container.querySelectorAll<HTMLElement>('.glossary-library-item');
    const transfer = {
      effectAllowed: '',
      value: '',
      getData() { return this.value; },
      setData(_type: string, value: string) { this.value = value; },
    };
    const dragStart = new Event('dragstart', { bubbles: true });
    Object.defineProperty(dragStart, 'dataTransfer', { value: transfer });
    await act(async () => {
      cards[1]?.dispatchEvent(dragStart);
    });
    const dragOver = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(dragOver, 'dataTransfer', { value: transfer });
    await act(async () => {
      cards[0]?.dispatchEvent(dragOver);
    });
    await act(async () => {
      cards[1]?.dispatchEvent(new Event('dragend', { bubbles: true }));
    });
    expect(useAppStore.getState().configDraft.glossary.libraries[0]?.id).toBe('secondary');

    await click(Array.from(container.querySelectorAll<HTMLElement>('.glossary-library-item')).find((item) => item.textContent?.includes('Watch Terms')));
    await click(buttonByText(container, '添加术语'));
    let dialogInputs = container.querySelectorAll<HTMLInputElement>('.glossary-dialog-grid .text-input');
    await inputText(dialogInputs[0]!, 'Boss');
    await inputText(dialogInputs[1]!, '新译名');
    await click(buttonByText(container, '保存'));
    expect(container.textContent).toContain('检测到 1 条同源术语冲突');
    await click(buttonByText(container, '跳过'));
    await click(buttonByText(container, '保存'));
    expect(container.querySelector('.glossary-modal')).toBeNull();

    await click(buttonByText(container, '添加术语'));
    dialogInputs = container.querySelectorAll<HTMLInputElement>('.glossary-dialog-grid .text-input');
    await inputText(dialogInputs[0]!, 'Boss');
    await inputText(dialogInputs[1]!, '新译名');
    await click(buttonByText(container, '保存'));
    await click(buttonByText(container, '覆盖'));
    await click(buttonByText(container, '保存'));
    expect(useAppStore.getState().configDraft.glossary.libraries.find((library) => library.id === 'secondary')?.entries).toEqual([]);

    await click(container.querySelector<HTMLButtonElement>('.glossary-table [title="编辑"]'));
    const selects = container.querySelectorAll<HTMLSelectElement>('.glossary-dialog-grid select');
    await selectValue(selects[0]!, 'ja-JP');
    await selectValue(selects[1]!, 'ko-KR');
    await click(buttonByText(container, '建议'));
    const checks = container.querySelectorAll<HTMLInputElement>('.glossary-dialog-grid input[type="checkbox"]');
    await click(checks[0]);
    await click(checks[1]);
    await click(checks[2]);
    await click(buttonByText(container, '保存'));
    expect(useAppStore.getState().configDraft.glossary.libraries.find((library) => library.id === 'watch')?.entries[0]).toMatchObject({
      sourceLang: 'ja-JP',
      targetLang: 'ko-KR',
      strategy: 'suggest',
      important: true,
      caseSensitive: true,
      wholeWord: false,
    });

    await click(container.querySelector<HTMLButtonElement>('.glossary-table [title="删除"]'));
    expect(useAppStore.getState().configDraft.glossary.libraries.find((library) => library.id === 'watch')?.entries).toHaveLength(14);
    await act(async () => {
      window.dispatchEvent(new Event('provider-template-catalog-updated'));
    });
  });

  it('covers import warning, toast close and no-source drag fallback branches', async () => {
    const readerResult = JSON.stringify({ invalid: true });
    class MockFileReader {
      result: string | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;

      readAsText() {
        this.result = readerResult;
        this.onload?.();
      }
    }
    vi.stubGlobal('FileReader', MockFileReader);

    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.glossary.libraries = [
      { id: 'first', name: 'First', enabled: true, priority: 0, entries: [] },
      { id: 'second', name: 'Second', enabled: true, priority: 1, entries: [] },
    ];
    useAppStore.setState((state) => ({ ...state, configDraft }));

    await act(async () => root.render(<GlossaryPage />));

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['test'], 'invalid.json', { type: 'application/json' })] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('.glossary-toast-warning')).toBeTruthy();
    await click(container.querySelector<HTMLButtonElement>('.glossary-toast-close'));
    expect(container.querySelector('.glossary-toast-warning')).toBeNull();

    const cards = container.querySelectorAll<HTMLElement>('.glossary-library-item');
    const transfer = {
      effectAllowed: '',
      getData: vi.fn(() => 'second'),
      setData: vi.fn(),
    };
    const dragOver = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(dragOver, 'dataTransfer', { value: transfer });
    await act(async () => {
      cards[0]?.dispatchEvent(dragOver);
    });
    expect(transfer.getData).toHaveBeenCalledWith('text/plain');
    expect(useAppStore.getState().configDraft.glossary.libraries[0]?.id).toBe('second');

    const noSourceDragOver = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(noSourceDragOver, 'dataTransfer', { value: { getData: vi.fn(() => ''), setData: vi.fn(), effectAllowed: '' } });
    await act(async () => {
      container.querySelector<HTMLElement>('.glossary-library-item')?.dispatchEvent(noSourceDragOver);
    });
    expect(useAppStore.getState().configDraft.glossary.libraries.map((library) => library.id)).toEqual(['second', 'first']);
  });

  it('closes entry and library dialogs from each dismiss target and blocks empty entry saves', async () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.glossary.libraries = [
      { id: 'watch', name: 'Watch Terms', enabled: true, priority: 0, entries: [] },
    ];
    useAppStore.setState((state) => ({ ...state, configDraft }));

    await act(async () => root.render(<GlossaryPage />));

    await click(container.querySelector<HTMLButtonElement>('.glossary-table-panel .routing-primary-action'));
    expect(container.querySelector('.glossary-modal')).toBeTruthy();
    await click(container.querySelector<HTMLButtonElement>('.glossary-modal .routing-primary-action'));
    expect(container.querySelector('.glossary-modal')).toBeTruthy();
    await click(container.querySelector<HTMLButtonElement>('.glossary-modal .routing-action-row .icon-button:not(.routing-primary-action)'));
    expect(container.querySelector('.glossary-modal')).toBeNull();

    await click(container.querySelector<HTMLButtonElement>('.glossary-table-panel .routing-primary-action'));
    await click(container.querySelector<HTMLButtonElement>('.glossary-modal .glossary-panel-head .icon-button'));
    expect(container.querySelector('.glossary-modal')).toBeNull();

    await click(container.querySelector<HTMLButtonElement>('.glossary-table-panel .routing-primary-action'));
    await act(async () => {
      container.querySelector<HTMLElement>('.glossary-modal-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.glossary-modal')).toBeNull();

    await click(container.querySelector<HTMLButtonElement>('.routing-hero-actions .routing-primary-action'));
    expect(container.querySelector('.glossary-library-dialog')).toBeTruthy();
    await click(container.querySelector<HTMLButtonElement>('.glossary-library-secondary-action'));
    expect(container.querySelector('.glossary-library-dialog')).toBeNull();

    await click(container.querySelector<HTMLButtonElement>('.routing-hero-actions .routing-primary-action'));
    await click(container.querySelector<HTMLButtonElement>('.glossary-modal-close'));
    expect(container.querySelector('.glossary-library-dialog')).toBeNull();

    await click(container.querySelector<HTMLButtonElement>('.routing-hero-actions .routing-primary-action'));
    await act(async () => {
      container.querySelector<HTMLElement>('.glossary-modal-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.glossary-library-dialog')).toBeNull();
  });

  it('lists subtitle translation calibration models and saves the selection', async () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.providers[0] = {
      ...configDraft.providers[0],
      sceneModelAssignments: [
        ...(configDraft.providers[0]?.sceneModelAssignments ?? []).filter((assignment) => assignment.scenario !== 'subtitle-translate'),
        { scenario: 'subtitle-translate', modelIds: ['subtitle-main', 'subtitle-main', 'subtitle-backup'] },
      ],
      modelCatalogCache: {
        signature: 'models',
        source: 'runtime',
        endpoint: null,
        fetchedAt: '2026-06-07T00:00:00.000Z',
        error: null,
        models: [
          {
            id: 'subtitle-main',
            displayName: 'Subtitle Main',
            ownedBy: null,
            createdAt: null,
            capabilities: [],
            providerTemplateId: configDraft.providers[0].templateId,
            providerTemplateName: configDraft.providers[0].displayName,
          },
          {
            id: 'subtitle-backup',
            displayName: 'Subtitle Backup',
            ownedBy: null,
            createdAt: null,
            capabilities: [],
            providerTemplateId: configDraft.providers[0].templateId,
            providerTemplateName: configDraft.providers[0].displayName,
          },
        ],
      },
    };
    useAppStore.setState((state) => ({ ...state, configDraft }));

    await act(async () => root.render(<GlossaryPage />));

    const calibrationSelect = clickBySelector<HTMLSelectElement>(container, '.glossary-calibration-row select');
    expect(Array.from(calibrationSelect.options).map((option) => option.value)).toEqual(['', 'subtitle-main', 'subtitle-backup']);
    expect(calibrationSelect.textContent).toContain('Subtitle Main');
    await selectValue(calibrationSelect, 'subtitle-backup');
    expect(useAppStore.getState().configDraft.glossary.calibrationModelId).toBe('subtitle-backup');

    await act(async () => {
      window.dispatchEvent(new Event('provider-template-catalog-updated'));
    });
  });

  it('keeps shared routing classes available after CSS cleanup', async () => {
    await act(async () => root.render(<GlossaryPage />));

    expect(container.querySelector('.routing-hero-actions')).toBeTruthy();
    expect(container.querySelector('.routing-primary-action')).toBeTruthy();
    expect(container.querySelector('.routing-toggle')).toBeTruthy();
    expect(container.querySelector('.routing-action-row')).toBeTruthy();
  });
});
