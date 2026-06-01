import type { GlossaryScenario } from './glossary-template';

export type GlossaryPackageManifestVersion = '1.0';

export type GlossaryPackageKind = 'user' | 'community' | 'game-dictionary';

export type GlossaryPackageSource = 'local-export' | 'community-curated' | 'community-contributed' | 'official-template';

export type GlossaryConflictPolicy = 'merge' | 'replace' | 'keep-user-entry';

export type GlossaryEntryStrategy = 'force' | 'suggest' | 'keep';

export type GlossaryPackageEntry = {
  id: string;
  sourceLang: string;
  targetLang: string;
  sourceTerm: string;
  targetTerm: string;
  strategy: GlossaryEntryStrategy;
  important: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  aliases?: string[];
  note?: string;
  tags?: string[];
};

export type GlossaryLibrary = {
  id: string;
  name: string;
  entries: GlossaryPackageEntry[];
  enabled: boolean;
  priority: number;
};

export type GlossaryPackageCompatibility = {
  minReaderVersion: GlossaryPackageManifestVersion;
  backwardsCompatible: boolean;
  upgradeNotes: string[];
};

export type GlossaryPackageContract = {
  manifestVersion: GlossaryPackageManifestVersion;
  packageId: string;
  version: string;
  kind: GlossaryPackageKind;
  scenario: GlossaryScenario;
  label: string;
  description: string;
  source: GlossaryPackageSource;
  author: string;
  updatedAt: string;
  exportFormat: 'json';
  conflictPolicy: GlossaryConflictPolicy;
  localePair: {
    source: string;
    target: string;
  };
  compatibility: GlossaryPackageCompatibility;
  entries: GlossaryPackageEntry[];
};
