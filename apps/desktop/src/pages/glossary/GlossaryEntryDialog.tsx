import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon from '../../components/icons/AppIcon';
import type { GlossaryEntryStrategy, GlossaryPackageEntry } from '../../schema/glossary-package';

type EntryState = {
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

type ConflictResolution = 'overwrite' | 'skip' | 'keep-all';
type Props = {
  state: EntryState;
  setState: Dispatch<SetStateAction<EntryState>>;
  conflicts: GlossaryPackageEntry[];
  clearConflicts: () => void;
  conflictResolution: ConflictResolution;
  setConflictResolution: (resolution: ConflictResolution) => void;
  onSave: () => void;
  onClose: () => void;
};

const languages = ['auto', 'zh-CN', 'en-US', 'ja-JP', 'ko-KR'] as const;

export default function GlossaryEntryDialog(props: Props) {
  const { t } = useTranslation();
  const patch = (next: Partial<EntryState>) => props.setState((current) => ({ ...current, ...next }));
  return <div className="glossary-modal-backdrop" onClick={props.onClose}>
    <div className="glossary-modal" onClick={(event) => event.stopPropagation()}>
      <div className="glossary-panel-head"><div><h3>{props.state.id ? t('glossary.dialog.editEntryTitle') : t('glossary.dialog.addEntryTitle')}</h3></div><button className="icon-button" onClick={props.onClose} type="button"><AppIcon name="close" size={16} /></button></div>
      <div className="glossary-dialog-grid">
        <label className="field-stack"><span>{t('glossary.dialog.sourceLanguage')}</span><select className="select-input" onChange={(event) => patch({ sourceLang: event.target.value })} value={props.state.sourceLang}>{languages.map((language) => <option key={language} value={language}>{language}</option>)}</select></label>
        <label className="field-stack"><span>{t('glossary.dialog.targetLanguage')}</span><select className="select-input" onChange={(event) => patch({ targetLang: event.target.value })} value={props.state.targetLang}>{languages.filter((language) => language !== 'auto').map((language) => <option key={language} value={language}>{language}</option>)}</select></label>
        <label className="field-stack field-span-full"><span>{t('glossary.table.sourceTerm')}</span><input className="text-input" onChange={(event) => { patch({ sourceTerm: event.target.value }); props.clearConflicts(); }} value={props.state.sourceTerm} /></label>
        <label className="field-stack field-span-full"><span>{t('glossary.table.targetTerm')}</span><input className="text-input" onChange={(event) => patch({ targetTerm: event.target.value })} value={props.state.targetTerm} /></label>
        <div className="field-stack field-span-full"><span>{t('glossary.table.strategy')}</span><div className="glossary-segmented">{(['force', 'suggest', 'keep'] as const).map((strategy) => <button className={props.state.strategy === strategy ? 'glossary-segment glossary-segment-active' : 'glossary-segment'} key={strategy} onClick={() => patch({ strategy })} type="button">{t(`glossary.strategy.${strategy}`)}</button>)}</div></div>
        <div className="glossary-dialog-toggles field-span-full">{([['important', 'glossary.dialog.markAsImportant'], ['caseSensitive', 'glossary.labels.caseSensitive'], ['wholeWord', 'glossary.labels.wholeWord']] as const).map(([field, key]) => <label className="routing-toggle" key={field}><input checked={props.state[field]} onChange={(event) => patch({ [field]: event.target.checked })} type="checkbox" /><span>{t(key)}</span></label>)}</div>
        {props.conflicts.length ? <div className="glossary-conflict-box field-span-full"><strong>{t('glossary.dialog.conflictCount', { count: props.conflicts.length })}</strong><div className="glossary-preview-result">{props.conflicts.map((entry) => <span className="chip" key={entry.id}>{entry.sourceTerm} → {entry.targetTerm}</span>)}</div><div className="glossary-segmented">{(['overwrite', 'skip', 'keep-all'] as const).map((resolution) => <button className={props.conflictResolution === resolution ? 'glossary-segment glossary-segment-active' : 'glossary-segment'} key={resolution} onClick={() => props.setConflictResolution(resolution)} type="button">{t(`glossary.conflictResolution.${resolution}`)}</button>)}</div></div> : null}
      </div>
      <div className="routing-action-row"><button className="icon-button routing-primary-action" onClick={props.onSave} type="button">{t('common.save')}</button><button className="icon-button" onClick={props.onClose} type="button">{t('common.cancel')}</button></div>
    </div>
  </div>;
}
