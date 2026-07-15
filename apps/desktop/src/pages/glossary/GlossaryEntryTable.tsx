import { useTranslation } from 'react-i18next';
import AppIcon from '../../components/icons/AppIcon';
import StatusBadge from '../../components/page/StatusBadge';
import type { GlossaryEntryStrategy, GlossaryLibrary, GlossaryPackageEntry } from '../../schema/glossary-package';

function strategyTone(strategy: GlossaryEntryStrategy) {
  if (strategy === 'force') return 'ready' as const;
  if (strategy === 'suggest') return 'warning' as const;
  return 'pending' as const;
}

type Props = {
  selectedLibrary: GlossaryLibrary | null;
  entries: GlossaryPackageEntry[];
  page: number;
  totalPages: number;
  onEdit: (entry: GlossaryPackageEntry) => void;
  onRemove: (id: string) => void;
  onToggleImportant: (id: string) => void;
  onAddEntry: () => void;
  onCreateLibrary: () => void;
  onPageChange: (page: number) => void;
};

export default function GlossaryEntryTable(props: Props) {
  const { t } = useTranslation();
  const strategyLabel = (strategy: GlossaryEntryStrategy) => t(`glossary.strategy.${strategy}`);

  if (!props.selectedLibrary || !props.entries.length) {
    return <div className="glossary-empty">
      <div className="glossary-empty-icon"><AppIcon name="search" size={22} /></div>
      <strong>{props.selectedLibrary ? t('glossary.empty.noMatchesTitle') : t('glossary.empty.selectOrCreateTitle')}</strong>
      <p>{props.selectedLibrary ? t('glossary.empty.noMatchesDescription') : t('glossary.empty.selectOrCreateDescription')}</p>
      <button className="icon-button routing-primary-action" onClick={props.selectedLibrary ? props.onAddEntry : props.onCreateLibrary} type="button"><AppIcon name={props.selectedLibrary ? 'spark' : 'book'} size={14} />{props.selectedLibrary ? t('glossary.actions.addFirstEntry') : t('glossary.actions.newLibrary')}</button>
    </div>;
  }

  return <>
    <div className="glossary-table-wrap"><table className="glossary-table">
      <thead><tr><th>{t('glossary.table.sourceTerm')}</th><th>{t('glossary.table.targetTerm')}</th><th>{t('glossary.table.strategy')}</th><th>{t('glossary.table.important')}</th><th>{t('glossary.table.actions')}</th></tr></thead>
      <tbody>{props.entries.map((entry) => <tr key={entry.id}>
        <td><span className="glossary-cell-term">{entry.sourceTerm}</span><div className="glossary-entry-meta">{entry.caseSensitive ? <span className="chip">{t('glossary.labels.caseSensitive')}</span> : null}{entry.wholeWord ? <span className="chip">{t('glossary.labels.wholeWord')}</span> : null}</div></td>
        <td><span className="glossary-cell-term">{entry.targetTerm}</span></td>
        <td><StatusBadge label={strategyLabel(entry.strategy)} tone={strategyTone(entry.strategy)} /></td>
        <td><button aria-label={entry.important ? t('glossary.actions.unmarkImportant') : t('glossary.actions.markImportant')} aria-pressed={entry.important} className={entry.important ? 'glossary-star glossary-star-active' : 'glossary-star'} onClick={() => props.onToggleImportant(entry.id)} title={entry.important ? t('glossary.actions.unmarkImportant') : t('glossary.actions.markImportant')} type="button"><AppIcon name={entry.important ? 'star-fill' : 'star'} size={16} /></button></td>
        <td><div className="glossary-row-actions"><button aria-label={t('glossary.actions.editEntryNamed', { name: entry.sourceTerm })} className="glossary-mini-button" onClick={() => props.onEdit(entry)} title={t('common.edit')} type="button"><AppIcon name="settings" size={14} /></button><button aria-label={t('glossary.actions.deleteEntryNamed', { name: entry.sourceTerm })} className="glossary-mini-button glossary-mini-button-danger" onClick={() => props.onRemove(entry.id)} title={t('common.delete')} type="button"><AppIcon name="trash" size={14} /></button></div></td>
      </tr>)}</tbody>
    </table></div>
    {props.totalPages > 1 ? <div className="glossary-pagination"><button className="icon-button" disabled={props.page <= 1} onClick={() => props.onPageChange(props.page - 1)} type="button">{t('common.previous')}</button><span className="chip">{props.page} / {props.totalPages}</span><button className="icon-button" disabled={props.page >= props.totalPages} onClick={() => props.onPageChange(props.page + 1)} type="button">{t('common.next')}</button></div> : null}
  </>;
}
