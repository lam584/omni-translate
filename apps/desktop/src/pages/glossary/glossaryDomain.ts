import type { GlossaryEntryStrategy, GlossaryLibrary, GlossaryPackageContract, GlossaryPackageEntry } from '../../schema/glossary-package';

export function generateEntryId() { return `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
export function generateLibraryId() { return `lib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

export function isPackageContract(obj: unknown): obj is GlossaryPackageContract {
  if (!obj || typeof obj !== 'object') return false;
  const candidate = obj as Record<string, unknown>;
  return typeof candidate.manifestVersion === 'string' && typeof candidate.packageId === 'string' && Array.isArray(candidate.entries);
}

export function isGlossaryLibrary(obj: unknown): obj is GlossaryLibrary {
  if (!obj || typeof obj !== 'object') return false;
  const candidate = obj as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.name === 'string' && Array.isArray(candidate.entries);
}

export function packageContractToLibrary(pkg: GlossaryPackageContract, priority: number): GlossaryLibrary {
  return { id: `lib-imported-${pkg.packageId}-${Date.now()}`, name: pkg.label, entries: pkg.entries.map((entry) => ({ ...entry })), enabled: true, priority };
}

export function filterGlossaryEntries(library: GlossaryLibrary | null, searchQuery: string, strategy: GlossaryEntryStrategy | '', importantOnly: boolean) {
  if (!library) return [];
  const query = searchQuery.trim().toLowerCase();
  return library.entries.filter((entry) => {
    const matches = !query || entry.sourceTerm.toLowerCase().includes(query) || entry.targetTerm.toLowerCase().includes(query);
    return matches && (!strategy || entry.strategy === strategy) && (!importantOnly || entry.important);
  });
}

export function moveGlossaryLibrary(libraries: GlossaryLibrary[], libraryId: string, targetLibraryId: string) {
  if (libraryId === targetLibraryId) return libraries;
  const index = libraries.findIndex((library) => library.id === libraryId);
  const targetIndex = libraries.findIndex((library) => library.id === targetLibraryId);
  if (index < 0 || targetIndex < 0) return libraries;
  const next = [...libraries];
  const [moved] = next.splice(index, 1);
  next.splice(targetIndex, 0, moved);
  return next.map((library, priority) => ({ ...library, priority }));
}

export function removeGlossaryLibrary(libraries: GlossaryLibrary[], libraryId: string) {
  return libraries.filter((library) => library.id !== libraryId).map((library, priority) => ({ ...library, priority }));
}

export function toggleGlossaryLibrary(libraries: GlossaryLibrary[], libraryId: string) {
  return libraries.map((library) => library.id === libraryId ? { ...library, enabled: !library.enabled } : library);
}

export function findGlossaryConflicts(libraries: GlossaryLibrary[], selectedLibraryId: string, sourceTerm: string, entryId: string | null) {
  return libraries.filter((library) => library.enabled && library.id !== selectedLibraryId).flatMap((library) => library.entries)
    .filter((entry) => entry.sourceTerm.toLowerCase() === sourceTerm.trim().toLowerCase() && entry.id !== entryId);
}

export function upsertGlossaryEntry(libraries: GlossaryLibrary[], selectedLibraryId: string, entry: GlossaryPackageEntry, resolution: 'overwrite' | 'skip' | 'keep-all', conflicts: GlossaryPackageEntry[]) {
  if (resolution === 'skip' && conflicts.length) return { libraries, skipped: true };
  let next = libraries;
  if (resolution === 'overwrite' && conflicts.length) {
    next = next.map((library) => ({ ...library, entries: library.entries.filter((item) => item.sourceTerm.toLowerCase() !== entry.sourceTerm.toLowerCase() || item.id === entry.id) }));
  }
  return { skipped: false, libraries: next.map((library) => {
    if (library.id !== selectedLibraryId) return library;
    const index = library.entries.findIndex((item) => item.id === entry.id);
    if (index < 0) return { ...library, entries: [...library.entries, entry] };
    const entries = [...library.entries]; entries[index] = entry; return { ...library, entries };
  }) };
}

export function removeGlossaryEntry(libraries: GlossaryLibrary[], selectedLibraryId: string, entryId: string) {
  return libraries.map((library) => library.id === selectedLibraryId ? { ...library, entries: library.entries.filter((entry) => entry.id !== entryId) } : library);
}

export function toggleGlossaryEntryImportant(libraries: GlossaryLibrary[], selectedLibraryId: string, entryId: string) {
  return libraries.map((library) => library.id === selectedLibraryId ? { ...library, entries: library.entries.map((entry) => entry.id === entryId ? { ...entry, important: !entry.important } : entry) } : library);
}

export function resolveGlossaryExportFilename(libraries: GlossaryLibrary[], libraryIds?: string[]) {
  if (!libraryIds || libraryIds.length !== 1) return 'glossary-all-libraries.json';
  const library = libraries.find((item) => item.id === libraryIds[0]);
  return library ? `glossary-${library.name.replace(/[^a-zA-Z0-9_\-.\\u4e00-\\u9fff]/g, '_')}.json` : `glossary-library-${libraryIds[0]}.json`;
}

export function calibrateGlossaryPreview(text: string, matches: GlossaryPackageEntry[]) {
  return matches.reduce((value, entry) => value.split(entry.sourceTerm).join(entry.targetTerm), text);
}

export function importGlossaryLibraries(libraries: GlossaryLibrary[], raw: unknown) {
  const next = [...libraries]; let importedCount = 0; let skippedCount = 0;
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    let library: GlossaryLibrary | null = isGlossaryLibrary(item)
      ? { ...item, entries: item.entries.map((entry) => ({ ...entry })), priority: next.length }
      : isPackageContract(item) ? packageContractToLibrary(item, next.length) : null;
    if (!library) { skippedCount += 1; continue; }
    if (next.some((existing) => existing.name === library!.name)) library = { ...library, name: `${library.name} (imported)` };
    next.push(library); importedCount += 1;
  }
  return { importedCount, libraries: next, skippedCount };
}
