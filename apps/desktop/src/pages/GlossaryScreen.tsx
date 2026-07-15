import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon from '../components/icons/AppIcon';
import PageSectionHeader from '../components/page/PageSectionHeader';
import StatusBadge from '../components/page/StatusBadge';
import type { GlossaryEntryStrategy, GlossaryLibrary, GlossaryPackageEntry } from '../schema/glossary-package';
import type { ProviderDraft } from '../schema/config';
import { useAppStore } from '../stores/app-store';
import { useGlossaryWorkspaceController } from './glossary/useGlossaryWorkspaceController';
import GlossaryLibraryPanel from './glossary/GlossaryLibraryPanel';
import GlossaryEntryTable from './glossary/GlossaryEntryTable';
import GlossaryEntryDialog from './glossary/GlossaryEntryDialog';
import { emptyDialogState } from './glossary/glossaryEditorModel';
import { describeProcessingMode, formatProcessingModeLabel, formatStrategyLabel } from './glossary/glossaryPresentation';
import {
  calibrateGlossaryPreview, filterGlossaryEntries, findGlossaryConflicts, generateEntryId,
  generateLibraryId, importGlossaryLibraries,
  moveGlossaryLibrary, removeGlossaryEntry, removeGlossaryLibrary,
  resolveGlossaryExportFilename, toggleGlossaryEntryImportant, toggleGlossaryLibrary,
  upsertGlossaryEntry,
} from './glossary/glossaryDomain';
import { providerTemplates } from '../mocks/provider-templates';
import { readCustomProviderTemplates } from '../utils/custom-provider-templates';
import {
  buildProviderTemplateCatalogEntries,
  readProviderTemplateCatalogPreferences,
  PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT,
} from '../utils/provider-template-catalog';

const PAGE_SIZE = 12;

export { glossaryPageDataHelpers, glossaryPageHelpers } from './glossary/glossaryPageHelpers';

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

  const {
    selectedLibraryId, setSelectedLibraryId, searchQuery, setSearchQuery,
    filterStrategy, setFilterStrategy, filterImportant, setFilterImportant,
    page, setPage, dialogOpen, setDialogOpen, dialogState, setDialogState,
    conflictEntries, setConflictEntries, conflictResolution, setConflictResolution,
    previewText, setPreviewText, testResult, setTestResult, importMessage, setImportMessage,
    draggedLibraryId, setDraggedLibraryId, libraryDialogOpen, setLibraryDialogOpen,
    newLibraryName, setNewLibraryName, libraryNameError, setLibraryNameError,
    reminderMessage, setReminderMessage,
  } = useGlossaryWorkspaceController(libraries, emptyDialogState);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const allEnabledEntries = useMemo(
    () => libraries.filter((library) => library.enabled).flatMap((library) => library.entries),
    [libraries],
  );
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
        <GlossaryLibraryPanel
          libraries={libraries}
          selectedLibraryId={effectiveSelectedLibraryId}
          draggedLibraryId={draggedLibraryId}
          importMessage={importMessage}
          onDismissImport={() => setImportMessage(null)}
          onCreateLibrary={openLibraryDialog}
          onSelect={(id) => { setSelectedLibraryId(id); setPage(1); setReminderMessage(null); }}
          onDragStart={handleLibraryDragStart}
          onDragOver={handleLibraryDragOver}
          onDragEnd={handleLibraryDragEnd}
          onToggle={toggleLibrary}
          onExport={exportLibraries}
          onRemove={removeLibrary}
        />

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

          <GlossaryEntryTable
            selectedLibrary={selectedLibrary}
            entries={pageEntries}
            page={safePage}
            totalPages={totalPages}
            onEdit={openEditDialog}
            onRemove={removeEntry}
            onToggleImportant={toggleImportant}
            onAddEntry={openAddDialog}
            onCreateLibrary={openLibraryDialog}
            onPageChange={setPage}
          />
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
        <GlossaryEntryDialog
          state={dialogState}
          setState={setDialogState}
          conflicts={conflictEntries}
          clearConflicts={() => setConflictEntries([])}
          conflictResolution={conflictResolution}
          setConflictResolution={setConflictResolution}
          onSave={checkConflicts}
          onClose={() => setDialogOpen(false)}
        />
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
