import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon from '../components/icons/AppIcon';
import PageSectionHeader from '../components/page/PageSectionHeader';
import StatusBadge from '../components/page/StatusBadge';
import i18n from '../i18n/config';
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
  if (strategy === 'force') return i18n.t('glossary.strategy.force');
  if (strategy === 'suggest') return i18n.t('glossary.strategy.suggest');
  return i18n.t('glossary.strategy.keep');
}

function formatStrategyTone(strategy: GlossaryEntryStrategy) {
  if (strategy === 'force') return 'ready' as const;
  if (strategy === 'suggest') return 'warning' as const;
  return 'pending' as const;
}

function formatProcessingModeLabel(mode: GlossaryProcessingMode) {
  if (mode === 'inject-all') return i18n.t('glossary.processingMode.injectAll');
  if (mode === 'inject-important') return i18n.t('glossary.processingMode.injectImportant');
  return i18n.t('glossary.processingMode.postCalibrate');
}

function describeProcessingMode(mode: GlossaryProcessingMode, totalEntries: number, importantCount: number) {
  if (mode === 'inject-all') return i18n.t('glossary.processingDescription.injectAll', { count: totalEntries });
  if (mode === 'inject-important') return i18n.t('glossary.processingDescription.injectImportant', { count: importantCount });
  return i18n.t('glossary.processingDescription.postCalibrate');
}

function generateEntryId() {
  return `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateLibraryId() {
  return `lib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Detects the preset glossary package shape. */
function isPackageContract(obj: unknown): obj is GlossaryPackageContract {
  if (!obj || typeof obj !== 'object') return false;
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.manifestVersion === 'string' &&
    typeof candidate.packageId === 'string' &&
    Array.isArray(candidate.entries)
  );
}

/** Detects the editable glossary library shape. */
function isGlossaryLibrary(obj: unknown): obj is GlossaryLibrary {
  if (!obj || typeof obj !== 'object') return false;
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.entries)
  );
}

/** Converts a preset package into an editable library. */
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
      library = { ...library, name: `${library.name} (imported)` };
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
  const { t } = useTranslation();
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

  const [libraryDialogOpen, setLibraryDialogOpen] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState('');
  const [libraryNameError, setLibraryNameError] = useState('');

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

  const openLibraryDialog = () => {
    setNewLibraryName('');
    setLibraryNameError('');
    setLibraryDialogOpen(true);
  };

  const saveNewLibrary = () => {
    const trimmed = newLibraryName.trim();
    if (!trimmed) {
      setLibraryNameError(t('glossary.errors.libraryNameRequired'));
      return;
    }
    const nameExists = libraries.some((lib) => lib.name === trimmed);
    if (nameExists) {
      setLibraryNameError(t('glossary.errors.libraryNameDuplicate'));
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

  const handleAddEntryClick = () => {
    if (libraries.length === 0) {
      setReminderMessage(t('glossary.messages.createLibraryBeforeEntry'));
      return;
    }
    openAddDialog();
  };

  const triggerFileImport = () => {
    fileInputRef.current?.click();
  };

  const handleFileImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (event.target) event.target.value = '';
    if (!file) return;

    setImportMessage(null);

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string);
        const { importedCount, libraries: nextLibraries, skippedCount } = importGlossaryLibraries(libraries, raw);

        if (importedCount === 0) {
          setImportMessage({ text: t('glossary.messages.importNoRecognizedLibraries'), tone: 'warning' });
          return;
        }

        commitLibraries(nextLibraries);

        setImportMessage({ text: t('glossary.messages.importSuccess', { count: importedCount, skipped: skippedCount }), tone: 'success' });
      } catch {
        setImportMessage({ text: t('glossary.messages.importParseFailed'), tone: 'error' });
      }
    };

    reader.onerror = () => {
      setImportMessage({ text: t('glossary.messages.importReadFailed'), tone: 'error' });
    };

    reader.readAsText(file);
  };

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
      calibrated: t('glossary.preview.calibratedSuffix', { text: original }),
      matches: previewMatches,
      elapsedMs: Math.floor(Math.random() * 80 + 120),
    });
  };

  return (
    <div className="glossary-workspace">
      {/* Hidden file picker */}
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
              <StatusBadge label={t('glossary.labels.enabledLibraryCount', { count: enabledLibraries.length })} tone={enabledLibraries.length > 0 ? 'ready' : 'warning'} />
              <button className="icon-button" onClick={triggerFileImport} type="button">
                <AppIcon name="layers" size={15} />
                {t('glossary.actions.importFile')}
              </button>
              <button className="icon-button routing-primary-action" onClick={openLibraryDialog} type="button">
                <AppIcon name="book" size={15} />
                {t('glossary.actions.newLibrary')}
              </button>
            </div>
          }
          description={
            <span className="glossary-hero-summary">
              {t('glossary.hero.summary', { total: totalEntries, important: importantCount })}
              <span className="glossary-hero-mode">{t('glossary.hero.currentMode', { mode: formatProcessingModeLabel(processingMode) })}</span>
            </span>
          }
          title={t('glossary.title')}
          titleLevel="h2"
        />
      </section>

      <section className="glossary-studio">
        <aside className="glossary-library-panel">
          <div className="glossary-panel-head">
            <div>
              <h3>{t('glossary.library.title')}</h3>
            </div>
          </div>

          {/* Import result toast */}
          {importMessage ? (
            <div className={`glossary-toast glossary-toast-${importMessage.tone}`} role="status">
              <div className="glossary-toast-body">
                <strong>
                  {t(`glossary.importTone.${importMessage.tone}`)}
                </strong>
                <p>{importMessage.text}</p>
              </div>
              <button
                aria-label={t('glossary.actions.closeNotice')}
                className="glossary-toast-close"
                onClick={() => setImportMessage(null)}
                type="button"
              >
                <AppIcon name="close" size={14} />
              </button>
            </div>
          ) : null}

          {libraries.length === 0 ? (
            <div className="glossary-empty">
              <strong>{t('glossary.empty.noLibrariesTitle')}</strong>
              <p>{t('glossary.empty.noLibrariesDescription')}</p>
              <button className="icon-button routing-primary-action" onClick={openLibraryDialog} type="button" style={{ justifySelf: 'start', marginTop: 4 }}>
                <AppIcon name="book" size={14} />
                {t('glossary.actions.newLibrary')}
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
                    <span>{t('glossary.labels.libraryMeta', { count: library.entries.length, priority: index + 1 })}</span>
                  </div>
                  <div className="glossary-library-actions" onClick={(event) => event.stopPropagation()}>
                    <button
                      aria-label={library.enabled ? t('glossary.actions.disableLibraryNamed', { name: library.name }) : t('glossary.actions.enableLibraryNamed', { name: library.name })}
                      aria-pressed={library.enabled}
                      className="glossary-mini-button"
                      onClick={() => toggleLibrary(library.id)}
                      title={library.enabled ? t('glossary.actions.disable') : t('glossary.actions.enable')}
                      type="button"
                    >
                      <AppIcon name={library.enabled ? 'eye' : 'eye-off'} size={14} />
                    </button>
                    <button
                      aria-label={t('glossary.actions.exportLibraryNamed', { name: library.name })}
                      className="glossary-mini-button"
                      onClick={() => exportLibraries([library.id])}
                      title={t('glossary.actions.exportThisLibrary')}
                      type="button"
                    >
                      <AppIcon name="cloud" size={14} />
                    </button>
                    <button
                      aria-label={t('glossary.actions.deleteLibraryNamed', { name: library.name })}
                      className="glossary-mini-button glossary-mini-button-danger"
                      onClick={() => removeLibrary(library.id)}
                      title={t('common.delete')}
                      type="button"
                    >
                      <AppIcon name="trash" size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <button className="icon-button" disabled={libraries.length === 0} onClick={() => exportLibraries()} type="button">
            <AppIcon name="cloud" size={15} />
            {t('glossary.actions.exportAll')}
          </button>
        </aside>

        <article className="glossary-table-panel">
          <div className="glossary-panel-head">
            <div className="glossary-table-title">
              <h3>{selectedLibrary ? selectedLibrary.name : t('glossary.table.fallbackTitle')}</h3>
              {selectedLibrary ? (
                <>
                  <StatusBadge label={selectedLibrary.enabled ? t('glossary.labels.enabled') : t('glossary.labels.disabled')} tone={selectedLibrary.enabled ? 'ready' : 'pending'} />
                  <span className="glossary-table-meta">{t('glossary.labels.entryCount', { count: selectedLibrary.entries.length })}</span>
                </>
              ) : null}
            </div>
            <div className="routing-hero-actions">
              <button className="icon-button routing-primary-action" onClick={handleAddEntryClick} type="button">
                <AppIcon name="spark" size={15} />
                {t('glossary.actions.addEntry')}
              </button>
            </div>
          </div>

          {/* Empty-library reminder */}
          {reminderMessage ? (
            <div className="glossary-warning">
              <strong>{t('glossary.labels.notice')}</strong>
              <p>{reminderMessage}</p>
              {libraries.length === 0 ? (
                <button className="icon-button routing-primary-action" onClick={() => { setReminderMessage(null); openLibraryDialog(); }} type="button" style={{ justifySelf: 'start' }}>
                  <AppIcon name="book" size={14} />
                  {t('glossary.actions.createLibraryNow')}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="glossary-filter-row">
            <div className="glossary-search">
              <AppIcon name="search" size={15} />
              <input onChange={(event) => { setSearchQuery(event.target.value); setPage(1); }} placeholder={t('glossary.searchPlaceholder')} type="text" value={searchQuery} />
            </div>
            <div className="glossary-filter-group" role="group" aria-label={t('glossary.filter.groupLabel')}>
              <span className="glossary-filter-group-label">{t('glossary.filter.label')}</span>
              <select aria-label={t('glossary.filter.strategyAria')} className="select-input" onChange={(event) => { setFilterStrategy(event.target.value as GlossaryEntryStrategy | ''); setPage(1); }} value={filterStrategy}>
                <option value="">{t('glossary.filter.allStrategies')}</option>
                <option value="force">{formatStrategyLabel('force')}</option>
                <option value="suggest">{formatStrategyLabel('suggest')}</option>
                <option value="keep">{formatStrategyLabel('keep')}</option>
              </select>
              <label className="routing-toggle">
                <input checked={filterImportant} onChange={(event) => { setFilterImportant(event.target.checked); setPage(1); }} type="checkbox" />
                <span>{t('glossary.filter.importantOnly')}</span>
              </label>
            </div>
          </div>

          {selectedLibrary && pageEntries.length > 0 ? (
            <div className="glossary-table-wrap">
              <table className="glossary-table">
                <thead>
                  <tr>
                    <th>{t('glossary.table.sourceTerm')}</th>
                    <th>{t('glossary.table.targetTerm')}</th>
                    <th>{t('glossary.table.strategy')}</th>
                    <th>{t('glossary.table.important')}</th>
                    <th>{t('glossary.table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <span className="glossary-cell-term">{entry.sourceTerm}</span>
                        <div className="glossary-entry-meta">
                          {entry.caseSensitive ? <span className="chip">{t('glossary.labels.caseSensitive')}</span> : null}
                          {entry.wholeWord ? <span className="chip">{t('glossary.labels.wholeWord')}</span> : null}
                        </div>
                      </td>
                      <td>
                        <span className="glossary-cell-term">{entry.targetTerm}</span>
                      </td>
                      <td>
                        <StatusBadge label={formatStrategyLabel(entry.strategy)} tone={formatStrategyTone(entry.strategy)} />
                      </td>
                      <td>
                        <button
                          aria-label={entry.important ? t('glossary.actions.unmarkImportant') : t('glossary.actions.markImportant')}
                          aria-pressed={entry.important}
                          className={entry.important ? 'glossary-star glossary-star-active' : 'glossary-star'}
                          onClick={() => toggleImportant(entry.id)}
                          title={entry.important ? t('glossary.actions.unmarkImportant') : t('glossary.actions.markImportant')}
                          type="button"
                        >
                          <AppIcon name={entry.important ? 'star-fill' : 'star'} size={16} />
                        </button>
                      </td>
                      <td>
                        <div className="glossary-row-actions">
                          <button
                            aria-label={t('glossary.actions.editEntryNamed', { name: entry.sourceTerm })}
                            className="glossary-mini-button"
                            onClick={() => openEditDialog(entry)}
                            title={t('common.edit')}
                            type="button"
                          >
                            <AppIcon name="settings" size={14} />
                          </button>
                          <button
                            aria-label={t('glossary.actions.deleteEntryNamed', { name: entry.sourceTerm })}
                            className="glossary-mini-button glossary-mini-button-danger"
                            onClick={() => removeEntry(entry.id)}
                            title={t('common.delete')}
                            type="button"
                          >
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
              <strong>{selectedLibrary ? t('glossary.empty.noMatchesTitle') : t('glossary.empty.selectOrCreateTitle')}</strong>
              <p>{selectedLibrary ? t('glossary.empty.noMatchesDescription') : t('glossary.empty.selectOrCreateDescription')}</p>
              {selectedLibrary ? (
                <button className="icon-button routing-primary-action" onClick={openAddDialog} type="button">
                  <AppIcon name="spark" size={14} />
                  {t('glossary.actions.addFirstEntry')}
                </button>
              ) : (
                <button className="icon-button routing-primary-action" onClick={openLibraryDialog} type="button">
                  <AppIcon name="book" size={14} />
                  {t('glossary.actions.newLibrary')}
                </button>
              )}
            </div>
          )}

          {selectedLibrary && totalPages > 1 ? (
            <div className="glossary-pagination">
              <button className="icon-button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} type="button">{t('common.previous')}</button>
              <span className="chip">{safePage} / {totalPages}</span>
              <button className="icon-button" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} type="button">{t('common.next')}</button>
            </div>
          ) : null}
        </article>
      </section>

      <section className="glossary-bottom-grid">
        <article className="glossary-config-panel">
          <div className="glossary-panel-head">
            <div>
              <h3>{t('glossary.processing.title')}</h3>
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
              <span>{t('glossary.calibration.modelLabel')}</span>
              <select className="select-input" onChange={(event) => updateGlossaryDraft({ calibrationModelId: event.target.value, status: 'draft' })} value={calibrationModelId}>
                <option value="">{t('common.notSelected')}</option>
                {subtitleTranslationModels.length === 0 ? (
                  <option disabled value="">
                    {t('glossary.calibration.noModels')}
                  </option>
                ) : (
                  subtitleTranslationModels.map((model) => (
                    <option key={model.modelId} value={model.modelId}>
                      {model.displayName} ({model.providerName})
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
              <h3>{t('glossary.preview.title')}</h3>
            </div>
          </div>
          <label className="field-stack">
            <span>{t('glossary.preview.testTextLabel')}</span>
            <textarea className="textarea-input" onChange={(event) => setPreviewText(event.target.value)} placeholder={t('glossary.preview.placeholder')} rows={4} value={previewText} />
          </label>
          <div className="routing-action-row">
            <button className="icon-button routing-primary-action" disabled={!previewText.trim()} onClick={runTestTranslation} type="button">
              <AppIcon name="play" size={15} />
              {t('glossary.actions.testCalibration')}
            </button>
          </div>
          {testResult ? (
            <div className="glossary-test-result">
              <div className="glossary-preview-result">
                <strong>{t('glossary.preview.matchedTerms')}</strong>
                <div className="glossary-preview-chips">
                  {testResult.matches.map((entry) => (
                    <span className="chip" key={entry.id}>{entry.sourceTerm} → {entry.targetTerm}</span>
                  ))}
                </div>
              </div>
              <div className="glossary-preview-result">
                <strong>{t('glossary.preview.calibratedResult')}</strong>
                <p>{testResult.calibrated}</p>
              </div>
              <span className="chip">{testResult.elapsedMs}ms</span>
            </div>
          ) : null}
        </article>
      </section>

      {/* Add/edit entry dialog */}
      {dialogOpen ? (
        <div className="glossary-modal-backdrop" onClick={() => setDialogOpen(false)}>
          <div className="glossary-modal" onClick={(e) => e.stopPropagation()}>
            <div className="glossary-panel-head">
              <div>
                <h3>{dialogState.id ? t('glossary.dialog.editEntryTitle') : t('glossary.dialog.addEntryTitle')}</h3>
              </div>
              <button className="icon-button" onClick={() => setDialogOpen(false)} type="button">
                <AppIcon name="close" size={16} />
              </button>
            </div>
            <div className="glossary-dialog-grid">
              <label className="field-stack">
                <span>{t('glossary.dialog.sourceLanguage')}</span>
                <select className="select-input" onChange={(event) => setDialogState((current) => ({ ...current, sourceLang: event.target.value }))} value={dialogState.sourceLang}>
                  {LANG_OPTIONS.map((lang) => (
                    <option key={lang} value={lang}>{lang}</option>
                  ))}
                </select>
              </label>
              <label className="field-stack">
                <span>{t('glossary.dialog.targetLanguage')}</span>
                <select className="select-input" onChange={(event) => setDialogState((current) => ({ ...current, targetLang: event.target.value }))} value={dialogState.targetLang}>
                  {LANG_OPTIONS.filter((l) => l !== 'auto').map((lang) => (
                    <option key={lang} value={lang}>{lang}</option>
                  ))}
                </select>
              </label>
              <label className="field-stack field-span-full">
                <span>{t('glossary.table.sourceTerm')}</span>
                <input className="text-input" onChange={(event) => { setDialogState((current) => ({ ...current, sourceTerm: event.target.value })); setConflictEntries([]); }} value={dialogState.sourceTerm} />
              </label>
              <label className="field-stack field-span-full">
                <span>{t('glossary.table.targetTerm')}</span>
                <input className="text-input" onChange={(event) => setDialogState((current) => ({ ...current, targetTerm: event.target.value }))} value={dialogState.targetTerm} />
              </label>
              <div className="field-stack field-span-full">
                <span>{t('glossary.table.strategy')}</span>
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
                  <span>{t('glossary.dialog.markAsImportant')}</span>
                </label>
                <label className="routing-toggle">
                  <input checked={dialogState.caseSensitive} onChange={(event) => setDialogState((current) => ({ ...current, caseSensitive: event.target.checked }))} type="checkbox" />
                  <span>{t('glossary.labels.caseSensitive')}</span>
                </label>
                <label className="routing-toggle">
                  <input checked={dialogState.wholeWord} onChange={(event) => setDialogState((current) => ({ ...current, wholeWord: event.target.checked }))} type="checkbox" />
                  <span>{t('glossary.labels.wholeWord')}</span>
                </label>
              </div>
              {conflictEntries.length > 0 ? (
                <div className="glossary-conflict-box field-span-full">
                  <strong>{t('glossary.dialog.conflictCount', { count: conflictEntries.length })}</strong>
                  <div className="glossary-preview-result">
                    {conflictEntries.map((entry) => <span className="chip" key={entry.id}>{entry.sourceTerm} → {entry.targetTerm}</span>)}
                  </div>
                  <div className="glossary-segmented">
                    {(['overwrite', 'skip', 'keep-all'] as const).map((resolution) => (
                      <button className={conflictResolution === resolution ? 'glossary-segment glossary-segment-active' : 'glossary-segment'} key={resolution} onClick={() => setConflictResolution(resolution)} type="button">
                        {t(`glossary.conflictResolution.${resolution}`)}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="routing-action-row">
              <button className="icon-button routing-primary-action" onClick={checkConflicts} type="button">
                {t('common.save')}
              </button>
              <button className="icon-button" onClick={() => setDialogOpen(false)} type="button">{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* New library dialog */}
      {libraryDialogOpen ? (
        <div className="glossary-modal-backdrop" onClick={() => setLibraryDialogOpen(false)}>
          <div className="glossary-modal glossary-library-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="glossary-panel-head">
              <div>
                <h3>{t('glossary.actions.newLibrary')}</h3>
              </div>
              <button aria-label={t('common.close')} className="glossary-modal-close" onClick={() => setLibraryDialogOpen(false)} type="button">
                <AppIcon name="close" size={16} />
              </button>
            </div>
            <div className="glossary-library-dialog-body">
              <label className="field-stack field-span-full">
                <span>{t('glossary.dialog.libraryName')}</span>
                <input
                  autoFocus
                  className="text-input glossary-library-name-input"
                  onChange={(event) => { setNewLibraryName(event.target.value); setLibraryNameError(''); }}
                  onKeyDown={handleLibraryDialogKeyDown}
                  placeholder={t('glossary.dialog.libraryNamePlaceholder')}
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
                {t('common.create')}
              </button>
              <button className="icon-button glossary-library-secondary-action" onClick={() => setLibraryDialogOpen(false)} type="button">{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
