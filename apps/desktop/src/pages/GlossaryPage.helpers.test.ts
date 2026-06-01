import { describe, expect, it, vi } from 'vitest';
import { glossaryPageDataHelpers, glossaryPageHelpers } from './GlossaryPage';

const packageContract = {
  manifestVersion: '1',
  packageId: 'games',
  label: 'Games',
  entries: [
    {
      id: 'entry-1',
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      sourceTerm: 'GG',
      targetTerm: '好局',
      strategy: 'force',
      important: true,
      caseSensitive: false,
      wholeWord: true,
    },
  ],
} as const;

describe('glossary page helpers', () => {
  it('formats every strategy and processing mode', () => {
    expect(['force', 'suggest', 'keep'].map((value) => glossaryPageHelpers.formatStrategyLabel(value as never))).toEqual(['强制', '建议', '保留原文']);
    expect(['force', 'suggest', 'keep'].map((value) => glossaryPageHelpers.formatStrategyTone(value as never))).toEqual(['ready', 'warning', 'pending']);
    expect(['inject-all', 'inject-important', 'post-calibrate'].map((value) => glossaryPageHelpers.formatProcessingModeLabel(value as never))).toEqual(['全量注入', '仅重要术语', '不注入术语']);
    expect(glossaryPageHelpers.describeProcessingMode('inject-all', 3, 1)).toContain('3');
    expect(glossaryPageHelpers.describeProcessingMode('inject-important', 3, 1)).toContain('1');
    expect(glossaryPageHelpers.describeProcessingMode('post-calibrate', 3, 1)).toContain('不向 prompt 注入');
  });

  it('validates imported package and library contracts defensively', () => {
    expect(glossaryPageHelpers.isPackageContract(packageContract)).toBe(true);
    expect(glossaryPageHelpers.isPackageContract(null)).toBe(false);
    expect(glossaryPageHelpers.isPackageContract({})).toBe(false);
    expect(glossaryPageHelpers.isPackageContract({ ...packageContract, manifestVersion: 1 })).toBe(false);
    expect(glossaryPageHelpers.isPackageContract({ ...packageContract, packageId: 1 })).toBe(false);
    expect(glossaryPageHelpers.isPackageContract({ ...packageContract, entries: null })).toBe(false);

    expect(glossaryPageHelpers.isGlossaryLibrary({ id: 'lib', name: 'Library', entries: [] })).toBe(true);
    expect(glossaryPageHelpers.isGlossaryLibrary(undefined)).toBe(false);
    expect(glossaryPageHelpers.isGlossaryLibrary({ name: 'Library', entries: [] })).toBe(false);
    expect(glossaryPageHelpers.isGlossaryLibrary({ id: 'lib', entries: [] })).toBe(false);
    expect(glossaryPageHelpers.isGlossaryLibrary({ id: 'lib', name: 'Library', entries: null })).toBe(false);
  });

  it('creates ids and converts package entries without sharing references', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(glossaryPageHelpers.generateEntryId()).toContain('term-123-');
    expect(glossaryPageHelpers.generateLibraryId()).toContain('lib-123-');
    const library = glossaryPageHelpers.packageContractToLibrary(packageContract as never, 2);
    expect(library).toMatchObject({ id: 'lib-imported-games-123', name: 'Games', enabled: true, priority: 2 });
    expect(library.entries[0]).not.toBe(packageContract.entries[0]);
  });

  it('filters entries by text, strategy and importance', () => {
    const library = glossaryPageHelpers.packageContractToLibrary(packageContract as never, 0);
    expect(glossaryPageDataHelpers.filterGlossaryEntries(null, '', '', false)).toEqual([]);
    expect(glossaryPageDataHelpers.filterGlossaryEntries(library, '', '', false)).toHaveLength(1);
    expect(glossaryPageDataHelpers.filterGlossaryEntries(library, 'gg', '', false)).toHaveLength(1);
    expect(glossaryPageDataHelpers.filterGlossaryEntries(library, '好局', '', false)).toHaveLength(1);
    expect(glossaryPageDataHelpers.filterGlossaryEntries(library, 'missing', '', false)).toHaveLength(0);
    expect(glossaryPageDataHelpers.filterGlossaryEntries(library, '', 'force', true)).toHaveLength(1);
    expect(glossaryPageDataHelpers.filterGlossaryEntries(library, '', 'suggest', false)).toHaveLength(0);
  });

  it('moves, toggles and removes libraries while preserving stable no-op references', () => {
    const first = glossaryPageHelpers.packageContractToLibrary(packageContract as never, 0);
    const second = { ...first, id: 'second', name: 'Second', priority: 1 };
    const libraries = [first, second];
    expect(glossaryPageDataHelpers.moveGlossaryLibrary(libraries, first.id, first.id)).toBe(libraries);
    expect(glossaryPageDataHelpers.moveGlossaryLibrary(libraries, 'missing', second.id)).toBe(libraries);
    expect(glossaryPageDataHelpers.moveGlossaryLibrary(libraries, first.id, 'missing')).toBe(libraries);
    expect(glossaryPageDataHelpers.moveGlossaryLibrary(libraries, second.id, first.id).map((item) => item.id)).toEqual(['second', first.id]);
    expect(glossaryPageDataHelpers.toggleGlossaryLibrary(libraries, first.id)[0]?.enabled).toBe(false);
    expect(glossaryPageDataHelpers.toggleGlossaryLibrary(libraries, 'missing')[0]).toBe(first);
    expect(glossaryPageDataHelpers.removeGlossaryLibrary(libraries, first.id)).toMatchObject([{ id: 'second', priority: 0 }]);
  });

  it('finds conflicts and applies overwrite, skip, keep-all, update, delete and importance strategies', () => {
    const entry = { ...packageContract.entries[0] };
    const updated = { ...entry, id: 'entry-new', targetTerm: 'Good game' };
    const selected = { id: 'selected', name: 'Selected', entries: [], enabled: true, priority: 0 };
    const other = { id: 'other', name: 'Other', entries: [entry], enabled: true, priority: 1 };
    const disabled = { id: 'disabled', name: 'Disabled', entries: [entry], enabled: false, priority: 2 };
    const libraries = [selected, other, disabled];
    const conflicts = glossaryPageDataHelpers.findGlossaryConflicts(libraries, selected.id, ' gg ', null);
    expect(conflicts).toEqual([entry]);
    expect(glossaryPageDataHelpers.findGlossaryConflicts(libraries, selected.id, 'gg', entry.id)).toEqual([]);

    expect(glossaryPageDataHelpers.upsertGlossaryEntry(libraries, selected.id, updated, 'skip', conflicts)).toEqual({ libraries, skipped: true });
    const overwrite = glossaryPageDataHelpers.upsertGlossaryEntry(libraries, selected.id, updated, 'overwrite', conflicts);
    expect(overwrite.skipped).toBe(false);
    expect(overwrite.libraries.find((item) => item.id === 'other')?.entries).toEqual([]);
    expect(overwrite.libraries.find((item) => item.id === 'selected')?.entries).toEqual([updated]);
    const kept = glossaryPageDataHelpers.upsertGlossaryEntry(libraries, selected.id, updated, 'keep-all', conflicts);
    expect(kept.libraries.find((item) => item.id === 'other')?.entries).toEqual([entry]);

    const selectedWithEntry = { ...selected, entries: [entry] };
    const edited = { ...entry, targetTerm: 'Good game' };
    expect(glossaryPageDataHelpers.upsertGlossaryEntry([selectedWithEntry, other], selected.id, edited, 'keep-all', []).libraries[0]?.entries).toEqual([edited]);
    expect(glossaryPageDataHelpers.removeGlossaryEntry([selectedWithEntry, other], selected.id, entry.id)[0]?.entries).toEqual([]);
    expect(glossaryPageDataHelpers.toggleGlossaryEntryImportant([selectedWithEntry, other], selected.id, entry.id)[0]?.entries[0]?.important).toBe(false);
  });

  it('formats export filenames and calibrates matched preview text', () => {
    const library = { id: 'lib', name: 'Game Terms!', entries: [], enabled: true, priority: 0 };
    expect(glossaryPageDataHelpers.resolveGlossaryExportFilename([library])).toBe('glossary-all-libraries.json');
    expect(glossaryPageDataHelpers.resolveGlossaryExportFilename([library], ['lib'])).toBe('glossary-Game_Terms_.json');
    expect(glossaryPageDataHelpers.resolveGlossaryExportFilename([library], ['missing'])).toBe('glossary-library-missing.json');
    expect(glossaryPageDataHelpers.resolveGlossaryExportFilename([library], ['lib', 'missing'])).toBe('glossary-all-libraries.json');
    expect(glossaryPageDataHelpers.calibrateGlossaryPreview('GG, GG', [{ ...packageContract.entries[0] }] as never)).toBe('好局, 好局');
  });

  it('imports library and package formats while reporting skipped items and duplicate names', () => {
    const existing = [{ id: 'existing', name: 'Games', entries: [], enabled: true, priority: 0 }];
    const direct = {
      id: 'direct',
      name: 'Direct',
      entries: [{ ...packageContract.entries[0] }],
      enabled: true,
      priority: 99,
    };
    const result = glossaryPageDataHelpers.importGlossaryLibraries(existing, [direct, packageContract, { invalid: true }]);
    expect(result).toMatchObject({ importedCount: 2, skippedCount: 1 });
    expect(result.libraries).toMatchObject([
      { id: 'existing', priority: 0 },
      { id: 'direct', name: 'Direct', priority: 1 },
      { name: 'Games (导入)', priority: 2 },
    ]);
    expect(result.libraries[1]?.entries[0]).not.toBe(direct.entries[0]);
    expect(glossaryPageDataHelpers.importGlossaryLibraries([], { invalid: true })).toMatchObject({
      importedCount: 0,
      libraries: [],
      skippedCount: 1,
    });
  });
});
