import { useEffect, useMemo, useRef, useState } from 'react';
import AppIcon from '../components/icons/AppIcon';
import PageSectionHeader from '../components/page/PageSectionHeader';
import StatusBadge from '../components/page/StatusBadge';
import type { GlossaryEntryStrategy, GlossaryLibrary, GlossaryPackageContract, GlossaryPackageEntry } from '../schema/glossary-package';
import type { GlossaryProcessingMode } from '../schema/glossary-template';
import type { ProviderDraft } from '../schema/config';
import { useAppStore } from '../stores/app-store';
import { providerTemplates } from '../mocks/provider-templates';
import { readCustomProviderTemplates } from '../utils/custom-provider-templates';
import {
  buildProviderTemplateCatalogEntries,
  readProviderTemplateCatalogPreferences,
  PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT,
} from '../utils/provider-template-catalog';

const PAGE_SIZE = 12;
const LANG_OPTIONS = ['auto', 'zh-CN', 'en-US', 'ja-JP', 'ko-KR'] as const;

function formatStrategyLabel(strategy: GlossaryEntryStrategy) {
  if (strategy === 'force') return '强制';
  if (strategy === 'suggest') return '建议';
  return '保留原文';
}

function formatStrategyTone(strategy: GlossaryEntryStrategy) {
  if (strategy === 'force') return 'ready' as const;
  if (strategy === 'suggest') return 'warning' as const;
  return 'pending' as const;
}

function formatProcessingModeLabel(mode: GlossaryProcessingMode) {
  if (mode === 'inject-all') return '全量注入';
  if (mode === 'inject-important') return '仅重要术语';
  return '不注入术语';
}

function describeProcessingMode(mode: GlossaryProcessingMode, totalEntries: number, importantCount: number) {
  if (mode === 'inject-all') return `所有启用库的 ${totalEntries} 条术语进入 prompt。`;
  if (mode === 'inject-important') return `只把 ${importantCount} 条重要术语注入 prompt。`;
  return '翻译后按术语库校准，不向 prompt 注入术语。';
}

function generateEntryId() {
  return `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateLibraryId() {
  return `lib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 检测一个对象是否属于 GlossaryPackageContract（预设包）格式 */
function isPackageContract(obj: unknown): obj is GlossaryPackageContract {
  if (!obj || typeof obj !== 'object') return false;
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.manifestVersion === 'string' &&
    typeof candidate.packageId === 'string' &&
    Array.isArray(candidate.entries)
  );
}

/** 检测一个对象是否属于 GlossaryLibrary（术语库）格式 */
function isGlossaryLibrary(obj: unknown): obj is GlossaryLibrary {
  if (!obj || typeof obj !== 'object') return false;
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.entries)
  );
}

/** 将 GlossaryPackageContract 转换为 GlossaryLibrary */
function packageContractToLibrary(pkg: GlossaryPackageContract, priority: number): GlossaryLibrary {
  return {
    id: `lib-imported-${pkg.packageId}-${Date.now()}`,
    name: pkg.label,
    entries: pkg.entries.map((entry) => ({ ...entry })),
    enabled: true,
    priority,
  };
}

export const glossaryPageHelpers = {
  formatStrategyLabel,
  formatStrategyTone,
  formatProcessingModeLabel,
  describeProcessingMode,
  generateEntryId,
  generateLibraryId,
  isPackageContract,
  isGlossaryLibrary,
  packageContractToLibrary,
};

type EntryDialogState = {
  id: string | null;
  sourceLang: string;
  targetLang: string;
  sourceTerm: string;
  targetTerm: string;
  strategy: GlossaryEntryStrategy;
  important: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
};

const emptyDialogState: EntryDialogState = {
  id: null,
  sourceLang: 'auto',
  targetLang: 'zh-CN',
  sourceTerm: '',
  targetTerm: '',
  strategy: 'force',
  important: false,
  caseSensitive: false,
  wholeWord: false,
};

function filterGlossaryEntries(
  library: GlossaryLibrary | null,
  searchQuery: string,
  strategy: GlossaryEntryStrategy | '',
  importantOnly: boolean,
) {
  if (!library) return [];
  const normalizedQuery = searchQuery.trim().toLowerCase();
  return library.entries.filter((entry) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      entry.sourceTerm.toLowerCase().includes(normalizedQuery) ||
      entry.targetTerm.toLowerCase().includes(normalizedQuery);
    return matchesQuery && (!strategy || entry.strategy === strategy) && (!importantOnly || entry.important);
  });
}

function moveGlossaryLibrary(libraries: GlossaryLibrary[], libraryId: string, targetLibraryId: string) {
  if (libraryId === targetLibraryId) return libraries;
  const index = libraries.findIndex((library) => library.id === libraryId);
  const targetIndex = libraries.findIndex((library) => library.id === targetLibraryId);
  if (index < 0 || targetIndex < 0) return libraries;
  const nextLibraries = [...libraries];
  const [movedLibrary] = nextLibraries.splice(index, 1);
  nextLibraries.splice(targetIndex, 0, movedLibrary);
  return nextLibraries.map((library, nextIndex) => ({ ...library, priority: nextIndex }));
}

function removeGlossaryLibrary(libraries: GlossaryLibrary[], libraryId: string) {
  return libraries
    .filter((library) => library.id !== libraryId)
    .map((library, index) => ({ ...library, priority: index }));
}

function toggleGlossaryLibrary(libraries: GlossaryLibrary[], libraryId: string) {
  return libraries.map((library) => (library.id === libraryId ? { ...library, enabled: !library.enabled } : library));
}

function findGlossaryConflicts(libraries: GlossaryLibrary[], selectedLibraryId: string, sourceTerm: string, entryId: string | null) {
  return libraries
    .filter((library) => library.enabled && library.id !== selectedLibraryId)
    .flatMap((library) => library.entries)
    .filter((entry) => entry.sourceTerm.toLowerCase() === sourceTerm.trim().toLowerCase() && entry.id !== entryId);
}

function upsertGlossaryEntry(
  libraries: GlossaryLibrary[],
  selectedLibraryId: string,
  entry: GlossaryPackageEntry,
  conflictResolution: 'overwrite' | 'skip' | 'keep-all',
  conflictEntries: GlossaryPackageEntry[],
) {
  if (conflictResolution === 'skip' && conflictEntries.length > 0) {
    return { libraries, skipped: true };
  }

  let nextLibraries = libraries;
  if (conflictResolution === 'overwrite' && conflictEntries.length > 0) {
    nextLibraries = nextLibraries.map((library) => ({
      ...library,
      entries: library.entries.filter((item) => item.sourceTerm.toLowerCase() !== entry.sourceTerm.toLowerCase() || item.id === entry.id),
    }));
  }

  return {
    skipped: false,
    libraries: nextLibraries.map((library) => {
      if (library.id !== selectedLibraryId) return library;
      const existingIndex = library.entries.findIndex((item) => item.id === entry.id);
      if (existingIndex < 0) return { ...library, entries: [...library.entries, entry] };
      const entries = [...library.entries];
      entries[existingIndex] = entry;
      return { ...library, entries };
    }),
  };
}

function removeGlossaryEntry(libraries: GlossaryLibrary[], selectedLibraryId: string, entryId: string) {
  return libraries.map((library) => (
    library.id === selectedLibraryId
      ? { ...library, entries: library.entries.filter((entry) => entry.id !== entryId) }
      : library
  ));
}

function toggleGlossaryEntryImportant(libraries: GlossaryLibrary[], selectedLibraryId: string, entryId: string) {
  return libraries.map((library) => (
    library.id === selectedLibraryId
      ? { ...library, entries: library.entries.map((entry) => (entry.id === entryId ? { ...entry, important: !entry.important } : entry)) }
      : library
  ));
}

function resolveGlossaryExportFilename(libraries: GlossaryLibrary[], libraryIds?: string[]) {
  if (!libraryIds || libraryIds.length !== 1) return 'glossary-all-libraries.json';
  const library = libraries.find((item) => item.id === libraryIds[0]);
  return library
    ? `glossary-${library.name.replace(/[^a-zA-Z0-9_\-.\\u4e00-\\u9fff]/g, '_')}.json`
    : `glossary-library-${libraryIds[0]}.json`;
}

function calibrateGlossaryPreview(previewText: string, matches: GlossaryPackageEntry[]) {
  return matches.reduce((text, entry) => text.split(entry.sourceTerm).join(entry.targetTerm), previewText);
}

function importGlossaryLibraries(libraries: GlossaryLibrary[], raw: unknown) {
  const items: unknown[] = Array.isArray(raw) ? raw : [raw];
  const nextLibraries = [...libraries];
  let importedCount = 0;
  let skippedCount = 0;

  for (const item of items) {
    let library: GlossaryLibrary | null = null;

    if (isGlossaryLibrary(item)) {
      library = {
        ...item,
        entries: item.entries.map((entry) => ({ ...entry })),
        priority: nextLibraries.length,
      };
    } else if (isPackageContract(item)) {
      library = packageContractToLibrary(item, nextLibraries.length);
    } else {
      skippedCount += 1;
      continue;
    }

    if (nextLibraries.some((existing) => existing.name === library!.name)) {
      library = { ...library, name: `${library.name} (导入)` };
    }

    nextLibraries.push(library);
    importedCount += 1;
  }

  return { importedCount, libraries: nextLibraries, skippedCount };
}

export const glossaryPageDataHelpers = {
  filterGlossaryEntries,
  moveGlossaryLibrary,
  removeGlossaryLibrary,
  toggleGlossaryLibrary,
  findGlossaryConflicts,
  upsertGlossaryEntry,
  removeGlossaryEntry,
  toggleGlossaryEntryImportant,
  resolveGlossaryExportFilename,
  calibrateGlossaryPreview,
  importGlossaryLibraries,
};

export default function GlossaryPage() {
  const configDraft = useAppStore((state) => state.configDraft);
  const updateGlossaryDraft = useAppStore((state) => state.updateGlossaryDraft);
  const libraries = configDraft.glossary.libraries;
  const processingMode = configDraft.glossary.processingMode;
  const calibrationModelId = configDraft.glossary.calibrationModelId;

  const [catalogVersion, setCatalogVersion] = useState(0);

  useEffect(() => {
    const handler = () => setCatalogVersion((v) => v + 1);
    window.addEventListener(PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT, handler);
    return () => window.removeEventListener(PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT, handler);
  }, []);

  const subtitleTranslationModels = useMemo(() => {
    const customTemplates = readCustomProviderTemplates();
    const preferences = readProviderTemplateCatalogPreferences();
    const allTemplates = [...providerTemplates, ...customTemplates];
    const entries = buildProviderTemplateCatalogEntries(allTemplates, preferences);
    const enabledTemplateIds = new Set(
      entries.filter((e) => e.enabled).map((e) => e.template.id),
    );

    const allProviderDrafts: ProviderDraft[] = configDraft.providers;

    const models: Array<{ modelId: string; displayName: string; providerName: string }> = [];
    const seen = new Set<string>();

    for (const draft of allProviderDrafts) {
      if (!enabledTemplateIds.has(draft.templateId)) continue;

      const subtitleAssignment = draft.sceneModelAssignments?.find(
        (a) => a.scenario === 'subtitle-translate',
      );
      if (!subtitleAssignment || subtitleAssignment.modelIds.length === 0) continue;

      const modelNameMap = new Map<string, string>();
      if (draft.modelCatalogCache?.models) {
        for (const m of draft.modelCatalogCache.models) {
          modelNameMap.set(m.id, m.displayName);
        }
      }

      for (const modelId of subtitleAssignment.modelIds) {
        if (seen.has(modelId)) continue;
        seen.add(modelId);

        models.push({
          modelId,
          displayName: modelNameMap.get(modelId) ?? modelId,
          providerName: draft.displayName,
        });
      }
    }

    return models;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configDraft.providers, catalogVersion]);

  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(libraries[0]?.id ?? null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStrategy, setFilterStrategy] = useState<GlossaryEntryStrategy | ''>('');
  const [filterImportant, setFilterImportant] = useState(false);
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogState, setDialogState] = useState<EntryDialogState>(emptyDialogState);
  const [conflictEntries, setConflictEntries] = useState<GlossaryPackageEntry[]>([]);
  const [conflictResolution, setConflictResolution] = useState<'overwrite' | 'skip' | 'keep-all'>('overwrite');
  const [previewText, setPreviewText] = useState('');
  const [testResult, setTestResult] = useState<{ original: string; calibrated: string; matches: GlossaryPackageEntry[]; elapsedMs: number } | null>(null);
  const [importMessage, setImportMessage] = useState<{ text: string; tone: 'success' | 'warning' | 'error' } | null>(null);
  const [draggedLibraryId, setDraggedLibraryId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── 新建术语库弹窗 ─────────────────────────────────────────────
  const [libraryDialogOpen, setLibraryDialogOpen] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState('');
  const [libraryNameError, setLibraryNameError] = useState('');

  // ─── 提示消息（无术语库时提醒） ──────────────────────────────────
  const [reminderMessage, setReminderMessage] = useState<string | null>(null);

  const effectiveSelectedLibraryId = libraries.some((library) => library.id === selectedLibraryId)
    ? selectedLibraryId
    : libraries[0]?.id ?? null;
  const selectedLibrary = libraries.find((library) => library.id === effectiveSelectedLibraryId) ?? null;
  const enabledLibraries = libraries.filter((library) => library.enabled);
  const totalEntries = enabledLibraries.reduce((sum, library) => sum + library.entries.length, 0);
  const importantCount = enabledLibraries.reduce((sum, library) => sum + library.entries.filter((entry) => entry.important).length, 0);

  const filteredEntries = useMemo(() => {
    return filterGlossaryEntries(selectedLibrary, searchQuery, filterStrategy, filterImportant);
  }, [filterImportant, filterStrategy, searchQuery, selectedLibrary]);

  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageEntries = filteredEntries.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const allEnabledEntries = useMemo(() => enabledLibraries.flatMap((library) => library.entries), [enabledLibraries]);
  const previewMatches = useMemo(() => {
    const normalized = previewText.toLowerCase();
    if (!normalized.trim()) return [];
    return allEnabledEntries.filter((entry) => normalized.includes(entry.sourceTerm.toLowerCase()));
  }, [allEnabledEntries, previewText]);

  const commitLibraries = (nextLibraries: GlossaryLibrary[]) => {
    updateGlossaryDraft({ libraries: nextLibraries, status: 'draft' });
  };

  // ─── 新建术语库（打开自定义弹窗） ─────────────────────────────────
  const openLibraryDialog = () => {
    setNewLibraryName('');
    setLibraryNameError('');
    setLibraryDialogOpen(true);
  };

  const saveNewLibrary = () => {
    const trimmed = newLibraryName.trim();
    if (!trimmed) {
      setLibraryNameError('请输入术语库名称');
      return;
    }
    // 检查同名库
    const nameExists = libraries.some((lib) => lib.name === trimmed);
    if (nameExists) {
      setLibraryNameError('已存在同名术语库，请使用其他名称');
      return;
    }
    const nextLibrary: GlossaryLibrary = {
      id: generateLibraryId(),
      name: trimmed,
      entries: [],
      enabled: true,
      priority: libraries.length,
    };
    commitLibraries([...libraries, nextLibrary]);
    setSelectedLibraryId(nextLibrary.id);
    setLibraryDialogOpen(false);
  };

  const handleLibraryDialogKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') saveNewLibrary();
    if (event.key === 'Escape') setLibraryDialogOpen(false);
  };

  // ─── 添加术语按钮 ──────────────────────────────────────────────
  const handleAddEntryClick = () => {
    if (libraries.length === 0) {
      // 没有术语库时，提示用户先新建
      setReminderMessage('请先新建术语库，再添加术语。');
      return;
    }
    openAddDialog();
  };

  // ─── 文件导入 ────────────────────────────────────────────────
  const triggerFileImport = () => {
    fileInputRef.current?.click();
  };

  const handleFileImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 重置 input 值，以便再次选择同一文件时仍能触发 change 事件
    if (event.target) event.target.value = '';
    if (!file) return;

    setImportMessage(null);

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string);
        const { importedCount, libraries: nextLibraries, skippedCount } = importGlossaryLibraries(libraries, raw);

        if (importedCount === 0) {
          setImportMessage({ text: '文件中未找到可识别的术语库格式。支持的格式：GlossaryLibrary 或 GlossaryPackageContract。', tone: 'warning' });
          return;
        }

        commitLibraries(nextLibraries);

        const messageParts: string[] = [`成功导入 ${importedCount} 个术语库`];
        if (skippedCount > 0) messageParts.push(`，${skippedCount} 个条目被跳过`);
        messageParts.push('。');
        setImportMessage({ text: messageParts.join(''), tone: 'success' });
      } catch {
        setImportMessage({ text: '文件解析失败，请确认是有效的 JSON 文件。', tone: 'error' });
      }
    };

    reader.onerror = () => {
      setImportMessage({ text: '文件读取失败，请重试。', tone: 'error' });
    };

    reader.readAsText(file);
  };

  // ─── 导出 ────────────────────────────────────────────────────
  const exportLibraries = (libraryIds?: string[]) => {
    const data = libraryIds ? libraries.filter((library) => libraryIds.includes(library.id)) : libraries;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = resolveGlossaryExportFilename(libraries, libraryIds);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const removeLibrary = (libraryId: string) => {
    const nextLibraries = removeGlossaryLibrary(libraries, libraryId);
    commitLibraries(nextLibraries);
    if (effectiveSelectedLibraryId === libraryId) setSelectedLibraryId(nextLibraries[0]?.id ?? null);
  };

  const toggleLibrary = (libraryId: string) => {
    commitLibraries(toggleGlossaryLibrary(libraries, libraryId));
  };

  const moveLibrary = (libraryId: string, targetLibraryId: string) => {
    const nextLibraries = moveGlossaryLibrary(libraries, libraryId, targetLibraryId);
    if (nextLibraries !== libraries) commitLibraries(nextLibraries);
  };

  const handleLibraryDragStart = (event: React.DragEvent<HTMLDivElement>, libraryId: string) => {
    setDraggedLibraryId(libraryId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', libraryId);
  };

  const handleLibraryDragOver = (event: React.DragEvent<HTMLDivElement>, targetLibraryId: string) => {
    event.preventDefault();
    const sourceLibraryId = draggedLibraryId ?? event.dataTransfer.getData('text/plain');
    if (sourceLibraryId) moveLibrary(sourceLibraryId, targetLibraryId);
  };

  const handleLibraryDragEnd = () => {
    setDraggedLibraryId(null);
  };

  const openAddDialog = () => {
    setDialogState(emptyDialogState);
    setConflictEntries([]);
    setConflictResolution('overwrite');
    setReminderMessage(null);
    setDialogOpen(true);
  };

  const openEditDialog = (entry: GlossaryPackageEntry) => {
    setDialogState({
      id: entry.id,
      sourceLang: entry.sourceLang,
      targetLang: entry.targetLang,
      sourceTerm: entry.sourceTerm,
      targetTerm: entry.targetTerm,
      strategy: entry.strategy,
      important: entry.important,
      caseSensitive: entry.caseSensitive,
      wholeWord: entry.wholeWord,
    });
    setConflictEntries([]);
    setConflictResolution('overwrite');
    setDialogOpen(true);
  };

  const saveEntry = () => {
    if (!dialogState.sourceTerm.trim() || !dialogState.targetTerm.trim()) return;

    const entry: GlossaryPackageEntry = {
      id: dialogState.id ?? generateEntryId(),
      sourceLang: dialogState.sourceLang,
      targetLang: dialogState.targetLang,
      sourceTerm: dialogState.sourceTerm.trim(),
      targetTerm: dialogState.targetTerm.trim(),
      strategy: dialogState.strategy,
      important: dialogState.important,
      caseSensitive: dialogState.caseSensitive,
      wholeWord: dialogState.wholeWord,
    };

    const result = upsertGlossaryEntry(libraries, selectedLibrary!.id, entry, conflictResolution, conflictEntries);
    if (result.skipped) {
      setDialogOpen(false);
      return;
    }
    commitLibraries(result.libraries);
    setDialogOpen(false);
  };

  const checkConflicts = () => {
    const conflicts = findGlossaryConflicts(enabledLibraries, selectedLibrary!.id, dialogState.sourceTerm, dialogState.id);
    setConflictEntries(conflicts);
    if (conflicts.length === 0 || conflictEntries.length > 0) saveEntry();
  };

  const removeEntry = (entryId: string) => {
    commitLibraries(removeGlossaryEntry(libraries, selectedLibrary!.id, entryId));
  };

  const toggleImportant = (entryId: string) => {
    commitLibraries(toggleGlossaryEntryImportant(libraries, selectedLibrary!.id, entryId));
  };

  const runTestTranslation = () => {
    const original = calibrateGlossaryPreview(previewText, previewMatches);
    setTestResult({
      original,
      calibrated: `${original}（已按术语策略校准）`,
      matches: previewMatches,
      elapsedMs: Math.floor(Math.random() * 80 + 120),
    });
  };

  return (
    <div className="glossary-workspace">
      {/* 隐藏的文件选择器 */}
      <input
        accept=".json"
        onChange={handleFileImport}
        ref={fileInputRef}
        style={{ display: 'none' }}
        type="file"
      />

      <section className="glossary-hero">
        <PageSectionHeader
          actions={
            <div className="routing-hero-actions">
              <StatusBadge label={`${enabledLibraries.length} 个启用库`} tone={enabledLibraries.length > 0 ? 'ready' : 'warning'} />
              <button className="icon-button" onClick={triggerFileImport} type="button">
                <AppIcon name="layers" size={15} />
                导入文件
              </button>
              <button className="icon-button routing-primary-action" onClick={openLibraryDialog} type="button">
                <AppIcon name="book" size={15} />
                新建术语库
              </button>
            </div>
          }
          description={
            <span className="glossary-hero-summary">
              <strong>{totalEntries}</strong> 条生效术语 · <strong>{importantCount}</strong> 条重要 · 模式：<strong>{formatProcessingModeLabel(processingMode)}</strong>
            </span>
          }
          title="术语策略"
          titleLevel="h2"
        />
      </section>

      <section className="glossary-studio">
        <aside className="glossary-library-panel">
          <div className="glossary-panel-head">
            <div>
              <h3>术语库</h3>
            </div>
          </div>

          {/* 导入结果提示 */}
          {importMessage ? (
            <div className="glossary-warning" style={{ marginBottom: importMessage ? 8 : 0 }}>
              <strong>{importMessage.tone === 'success' ? '✓' : importMessage.tone === 'warning' ? '⚠' : '✗'} {importMessage.tone === 'success' ? '导入成功' : importMessage.tone === 'warning' ? '导入提醒' : '导入失败'}</strong>
              <p>{importMessage.text}</p>
            </div>
          ) : null}

          {libraries.length === 0 ? (
            <div className="glossary-empty">
              <strong>暂无术语库</strong>
              <p>新建空库，或从 JSON 文件导入术语库后开始编辑。</p>
              <button className="icon-button routing-primary-action" onClick={openLibraryDialog} type="button" style={{ justifySelf: 'start', marginTop: 4 }}>
                <AppIcon name="book" size={14} />
                新建术语库
              </button>
            </div>
          ) : (
            <div className="glossary-library-list">
              {libraries.map((library, index) => (
                <div
                  className={[
                    'glossary-library-item',
                    library.id === effectiveSelectedLibraryId ? 'glossary-library-item-active' : '',
                    library.id === draggedLibraryId ? 'glossary-library-item-dragging' : '',
                  ].filter(Boolean).join(' ')}
                  draggable
                  key={library.id}
                  onClick={() => { setSelectedLibraryId(library.id); setPage(1); setReminderMessage(null); }}
                  onDragEnd={handleLibraryDragEnd}
                  onDragOver={(event) => handleLibraryDragOver(event, library.id)}
                  onDragStart={(event) => handleLibraryDragStart(event, library.id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="glossary-library-main">
                    <strong>{library.name}</strong>
                    <span>{library.entries.length} 条术语 · 优先级 {index + 1}</span>
                  </div>
                  <div className="glossary-library-actions" onClick={(event) => event.stopPropagation()}>
                    <button className="glossary-mini-button" onClick={() => toggleLibrary(library.id)} title={library.enabled ? '禁用' : '启用'} type="button">
                      <AppIcon name={library.enabled ? 'eye' : 'eye-off'} size={14} />
                    </button>
                    <button className="glossary-mini-button" onClick={() => exportLibraries([library.id])} title="导出此库" type="button">
                      <AppIcon name="cloud" size={14} />
                    </button>
                    <button className="glossary-mini-button glossary-mini-button-danger" onClick={() => removeLibrary(library.id)} title="删除" type="button">
                      <AppIcon name="trash" size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <button className="icon-button" disabled={libraries.length === 0} onClick={() => exportLibraries()} type="button">
            <AppIcon name="cloud" size={15} />
            导出全部
          </button>
        </aside>

        <article className="glossary-table-panel">
          <div className="glossary-panel-head">
            <div>
              <h3>{selectedLibrary ? selectedLibrary.name : '术语表'}</h3>
            </div>
            <div className="routing-hero-actions">
              {selectedLibrary ? <StatusBadge label={selectedLibrary.enabled ? '已启用' : '已禁用'} tone={selectedLibrary.enabled ? 'ready' : 'pending'} /> : null}
              <button className="icon-button routing-primary-action" onClick={handleAddEntryClick} type="button">
                <AppIcon name="spark" size={15} />
                添加术语
              </button>
            </div>
          </div>

          {/* 无术语库时的提醒 */}
          {reminderMessage ? (
            <div className="glossary-warning">
              <strong>⚠ 提示</strong>
              <p>{reminderMessage}</p>
              {libraries.length === 0 ? (
                <button className="icon-button routing-primary-action" onClick={() => { setReminderMessage(null); openLibraryDialog(); }} type="button" style={{ justifySelf: 'start' }}>
                  <AppIcon name="book" size={14} />
                  立即新建术语库
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="glossary-filter-row">
            <div className="glossary-search">
              <AppIcon name="search" size={15} />
              <input onChange={(event) => { setSearchQuery(event.target.value); setPage(1); }} placeholder="搜索术语……" type="text" value={searchQuery} />
            </div>
            <select className="select-input" onChange={(event) => { setFilterStrategy(event.target.value as GlossaryEntryStrategy | ''); setPage(1); }} value={filterStrategy}>
              <option value="">全部策略</option>
              <option value="force">强制</option>
              <option value="suggest">建议</option>
              <option value="keep">保留原文</option>
            </select>
            <label className="routing-toggle">
              <input checked={filterImportant} onChange={(event) => { setFilterImportant(event.target.checked); setPage(1); }} type="checkbox" />
              <span>仅重要</span>
            </label>
          </div>

          {selectedLibrary && pageEntries.length > 0 ? (
            <div className="glossary-table-wrap">
              <table className="glossary-table">
                <thead>
                  <tr>
                    <th>源术语</th>
                    <th>目标术语</th>
                    <th>策略</th>
                    <th>重要</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pageEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <strong>{entry.sourceTerm}</strong>
                        <div className="glossary-entry-meta">
                          {entry.caseSensitive ? <span className="chip">区分大小写</span> : null}
                          {entry.wholeWord ? <span className="chip">全词匹配</span> : null}
                        </div>
                      </td>
                      <td>{entry.targetTerm}</td>
                      <td>
                        <StatusBadge label={formatStrategyLabel(entry.strategy)} tone={formatStrategyTone(entry.strategy)} />
                      </td>
                      <td>
                        <button className={entry.important ? 'glossary-star glossary-star-active' : 'glossary-star'} onClick={() => toggleImportant(entry.id)} title={entry.important ? '取消重要标记' : '标记为重要'} type="button">
                          ★
                        </button>
                      </td>
                      <td>
                        <div className="glossary-row-actions">
                          <button className="glossary-mini-button" onClick={() => openEditDialog(entry)} title="编辑" type="button">
                            <AppIcon name="settings" size={14} />
                          </button>
                          <button className="glossary-mini-button glossary-mini-button-danger" onClick={() => removeEntry(entry.id)} title="删除" type="button">
                            <AppIcon name="trash" size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="glossary-empty">
              <div className="glossary-empty-icon">
                <AppIcon name="search" size={22} />
              </div>
              <strong>{selectedLibrary ? '没有匹配的术语' : '请选择或创建术语库'}</strong>
              <p>{selectedLibrary ? '调整搜索条件，或添加第一条术语。' : '在左侧新建术语库，或点击上方「导入文件」导入 JSON 术语库。'}</p>
              {selectedLibrary ? (
                <button className="icon-button routing-primary-action" onClick={openAddDialog} type="button">
                  <AppIcon name="spark" size={14} />
                  添加第一条术语
                </button>
              ) : (
                <button className="icon-button routing-primary-action" onClick={openLibraryDialog} type="button">
                  <AppIcon name="book" size={14} />
                  新建术语库
                </button>
              )}
            </div>
          )}

          {selectedLibrary && totalPages > 1 ? (
            <div className="glossary-pagination">
              <button className="icon-button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} type="button">上一页</button>
              <span className="chip">{safePage} / {totalPages}</span>
              <button className="icon-button" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} type="button">下一页</button>
            </div>
          ) : null}
        </article>
      </section>

      <section className="glossary-bottom-grid">
        <article className="glossary-config-panel">
          <div className="glossary-panel-head">
            <div>
              <h3>术语处理方式</h3>
            </div>
          </div>
          <div className="glossary-mode-grid">
            {(['inject-all', 'inject-important', 'post-calibrate'] as const).map((mode) => (
              <button className={processingMode === mode ? 'glossary-mode-card glossary-mode-card-active' : 'glossary-mode-card'} key={mode} onClick={() => updateGlossaryDraft({ processingMode: mode, status: 'draft' })} type="button">
                <strong>{formatProcessingModeLabel(mode)}</strong>
                <p>{describeProcessingMode(mode, totalEntries, importantCount)}</p>
              </button>
            ))}
          </div>
          <div className="glossary-calibration-row">
            <label className="field-stack field-span-full">
              <span>校准小模型</span>
              <select className="select-input" onChange={(event) => updateGlossaryDraft({ calibrationModelId: event.target.value, status: 'draft' })} value={calibrationModelId}>
                <option value="">未选择</option>
                {subtitleTranslationModels.length === 0 ? (
                  <option disabled value="">
                    暂无可用字幕翻译模型，请先在"模型接入"页为已启用的平台添加字幕翻译场景模型
                  </option>
                ) : (
                  subtitleTranslationModels.map((model) => (
                    <option key={model.modelId} value={model.modelId}>
                      {model.displayName}（{model.providerName}）
                    </option>
                  ))
                )}
              </select>
            </label>
          </div>
        </article>

        <article className="glossary-config-panel">
          <div className="glossary-panel-head">
            <div>
              <h3>术语命中预览</h3>
            </div>
          </div>
          <label className="field-stack">
            <span>测试文本</span>
            <textarea className="textarea-input" onChange={(event) => setPreviewText(event.target.value)} placeholder="输入一段待翻译的文本，预览哪些术语会被命中……" rows={4} value={previewText} />
          </label>
          <div className="routing-action-row">
            <button className="icon-button routing-primary-action" disabled={!previewText.trim()} onClick={runTestTranslation} type="button">
              <AppIcon name="play" size={15} />
              测试校准
            </button>
          </div>
          {testResult ? (
            <div className="glossary-test-result">
              <div className="glossary-preview-result">
                <strong>命中术语</strong>
                <div className="glossary-preview-chips">
                  {testResult.matches.map((entry) => (
                    <span className="chip" key={entry.id}>{entry.sourceTerm} → {entry.targetTerm}</span>
                  ))}
                </div>
              </div>
              <div className="glossary-preview-result">
                <strong>校准结果</strong>
                <p>{testResult.calibrated}</p>
              </div>
              <span className="chip">{testResult.elapsedMs}ms</span>
            </div>
          ) : null}
        </article>
      </section>

      {/* 添加/编辑术语弹窗 */}
      {dialogOpen ? (
        <div className="glossary-modal-backdrop" onClick={() => setDialogOpen(false)}>
          <div className="glossary-modal" onClick={(e) => e.stopPropagation()}>
            <div className="glossary-panel-head">
              <div>
                <h3>{dialogState.id ? '编辑术语' : '添加术语'}</h3>
              </div>
              <button className="icon-button" onClick={() => setDialogOpen(false)} type="button">
                <AppIcon name="close" size={16} />
              </button>
            </div>
            <div className="glossary-dialog-grid">
              <label className="field-stack">
                <span>源语言</span>
                <select className="select-input" onChange={(event) => setDialogState((current) => ({ ...current, sourceLang: event.target.value }))} value={dialogState.sourceLang}>
                  {LANG_OPTIONS.map((lang) => (
                    <option key={lang} value={lang}>{lang}</option>
                  ))}
                </select>
              </label>
              <label className="field-stack">
                <span>目标语言</span>
                <select className="select-input" onChange={(event) => setDialogState((current) => ({ ...current, targetLang: event.target.value }))} value={dialogState.targetLang}>
                  {LANG_OPTIONS.filter((l) => l !== 'auto').map((lang) => (
                    <option key={lang} value={lang}>{lang}</option>
                  ))}
                </select>
              </label>
              <label className="field-stack field-span-full">
                <span>源术语</span>
                <input className="text-input" onChange={(event) => { setDialogState((current) => ({ ...current, sourceTerm: event.target.value })); setConflictEntries([]); }} value={dialogState.sourceTerm} />
              </label>
              <label className="field-stack field-span-full">
                <span>目标术语</span>
                <input className="text-input" onChange={(event) => setDialogState((current) => ({ ...current, targetTerm: event.target.value }))} value={dialogState.targetTerm} />
              </label>
              <div className="field-stack field-span-full">
                <span>策略</span>
                <div className="glossary-segmented">
                  {(['force', 'suggest', 'keep'] as const).map((strategy) => (
                    <button className={dialogState.strategy === strategy ? 'glossary-segment glossary-segment-active' : 'glossary-segment'} key={strategy} onClick={() => setDialogState((current) => ({ ...current, strategy }))} type="button">
                      {formatStrategyLabel(strategy)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="glossary-dialog-toggles field-span-full">
                <label className="routing-toggle">
                  <input checked={dialogState.important} onChange={(event) => setDialogState((current) => ({ ...current, important: event.target.checked }))} type="checkbox" />
                  <span>标记为重要术语</span>
                </label>
                <label className="routing-toggle">
                  <input checked={dialogState.caseSensitive} onChange={(event) => setDialogState((current) => ({ ...current, caseSensitive: event.target.checked }))} type="checkbox" />
                  <span>区分大小写</span>
                </label>
                <label className="routing-toggle">
                  <input checked={dialogState.wholeWord} onChange={(event) => setDialogState((current) => ({ ...current, wholeWord: event.target.checked }))} type="checkbox" />
                  <span>全词匹配</span>
                </label>
              </div>
              {conflictEntries.length > 0 ? (
                <div className="glossary-conflict-box field-span-full">
                  <strong>检测到 {conflictEntries.length} 条同源术语冲突</strong>
                  <div className="glossary-preview-result">
                    {conflictEntries.map((entry) => <span className="chip" key={entry.id}>{entry.sourceTerm} → {entry.targetTerm}</span>)}
                  </div>
                  <div className="glossary-segmented">
                    {(['overwrite', 'skip', 'keep-all'] as const).map((resolution) => (
                      <button className={conflictResolution === resolution ? 'glossary-segment glossary-segment-active' : 'glossary-segment'} key={resolution} onClick={() => setConflictResolution(resolution)} type="button">
                        {resolution === 'overwrite' ? '覆盖' : resolution === 'skip' ? '跳过' : '保留全部'}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="routing-action-row">
              <button className="icon-button routing-primary-action" onClick={checkConflicts} type="button">
                保存
              </button>
              <button className="icon-button" onClick={() => setDialogOpen(false)} type="button">取消</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 新建术语库弹窗 */}
      {libraryDialogOpen ? (
        <div className="glossary-modal-backdrop" onClick={() => setLibraryDialogOpen(false)}>
          <div className="glossary-modal glossary-library-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="glossary-panel-head">
              <div>
                <h3>新建术语库</h3>
              </div>
              <button aria-label="关闭" className="glossary-modal-close" onClick={() => setLibraryDialogOpen(false)} type="button">
                <AppIcon name="close" size={16} />
              </button>
            </div>
            <div className="glossary-library-dialog-body">
              <label className="field-stack field-span-full">
                <span>术语库名称</span>
                <input
                  autoFocus
                  className="text-input glossary-library-name-input"
                  onChange={(event) => { setNewLibraryName(event.target.value); setLibraryNameError(''); }}
                  onKeyDown={handleLibraryDialogKeyDown}
                  placeholder="例如：游戏术语、影视字幕、专业词汇……"
                  value={newLibraryName}
                />
              </label>
              {libraryNameError ? (
                <p className="glossary-dialog-error">{libraryNameError}</p>
              ) : null}
            </div>
            <div className="routing-action-row glossary-library-actions">
              <button className="icon-button glossary-library-primary-action" onClick={saveNewLibrary} type="button">
                <AppIcon name="power" size={15} />
                创建
              </button>
              <button className="icon-button glossary-library-secondary-action" onClick={() => setLibraryDialogOpen(false)} type="button">取消</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
