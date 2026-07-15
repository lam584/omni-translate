import type { GlossaryEntryStrategy } from '../../schema/glossary-package';

export type EntryDialogState = {
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

export const emptyDialogState: EntryDialogState = {
  id: null, sourceLang: 'auto', targetLang: 'zh-CN', sourceTerm: '', targetTerm: '',
  strategy: 'force', important: false, caseSensitive: false, wholeWord: false,
};
