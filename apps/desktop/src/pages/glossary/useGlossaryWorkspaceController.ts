import { useState } from 'react';
import type { GlossaryEntryStrategy, GlossaryLibrary, GlossaryPackageEntry } from '../../schema/glossary-package';
import type { EntryDialogState } from './glossaryEditorModel';

export function useGlossaryWorkspaceController(
  libraries: GlossaryLibrary[],
  initialDialogState: EntryDialogState,
) {
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(libraries[0]?.id ?? null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStrategy, setFilterStrategy] = useState<GlossaryEntryStrategy | ''>('');
  const [filterImportant, setFilterImportant] = useState(false);
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogState, setDialogState] = useState<EntryDialogState>(initialDialogState);
  const [conflictEntries, setConflictEntries] = useState<GlossaryPackageEntry[]>([]);
  const [conflictResolution, setConflictResolution] = useState<'overwrite' | 'skip' | 'keep-all'>('overwrite');
  const [previewText, setPreviewText] = useState('');
  const [testResult, setTestResult] = useState<{
    original: string;
    calibrated: string;
    matches: GlossaryPackageEntry[];
    elapsedMs: number;
  } | null>(null);
  const [importMessage, setImportMessage] = useState<{ text: string; tone: 'success' | 'warning' | 'error' } | null>(null);
  const [draggedLibraryId, setDraggedLibraryId] = useState<string | null>(null);
  const [libraryDialogOpen, setLibraryDialogOpen] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState('');
  const [libraryNameError, setLibraryNameError] = useState('');
  const [reminderMessage, setReminderMessage] = useState<string | null>(null);

  return {
    selectedLibraryId, setSelectedLibraryId, searchQuery, setSearchQuery,
    filterStrategy, setFilterStrategy, filterImportant, setFilterImportant,
    page, setPage, dialogOpen, setDialogOpen, dialogState, setDialogState,
    conflictEntries, setConflictEntries, conflictResolution, setConflictResolution,
    previewText, setPreviewText, testResult, setTestResult, importMessage, setImportMessage,
    draggedLibraryId, setDraggedLibraryId, libraryDialogOpen, setLibraryDialogOpen,
    newLibraryName, setNewLibraryName, libraryNameError, setLibraryNameError,
    reminderMessage, setReminderMessage,
  };
}
