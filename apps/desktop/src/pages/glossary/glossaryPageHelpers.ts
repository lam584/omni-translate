import {
  calibrateGlossaryPreview, filterGlossaryEntries, findGlossaryConflicts, generateEntryId,
  generateLibraryId, importGlossaryLibraries, isGlossaryLibrary, isPackageContract,
  moveGlossaryLibrary, packageContractToLibrary, removeGlossaryEntry, removeGlossaryLibrary,
  resolveGlossaryExportFilename, toggleGlossaryEntryImportant, toggleGlossaryLibrary, upsertGlossaryEntry,
} from './glossaryDomain';
import { describeProcessingMode, formatProcessingModeLabel, formatStrategyLabel, formatStrategyTone } from './glossaryPresentation';

export const glossaryPageHelpers = {
  formatStrategyLabel, formatStrategyTone, formatProcessingModeLabel, describeProcessingMode,
  generateEntryId, generateLibraryId, isPackageContract, isGlossaryLibrary, packageContractToLibrary,
};

export const glossaryPageDataHelpers = {
  filterGlossaryEntries, moveGlossaryLibrary, removeGlossaryLibrary, toggleGlossaryLibrary,
  findGlossaryConflicts, upsertGlossaryEntry, removeGlossaryEntry, toggleGlossaryEntryImportant,
  resolveGlossaryExportFilename, calibrateGlossaryPreview, importGlossaryLibraries,
};
