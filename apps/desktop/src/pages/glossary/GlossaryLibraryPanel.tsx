import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon from '../../components/icons/AppIcon';
import type { GlossaryLibrary } from '../../schema/glossary-package';

type ImportMessage = { text: string; tone: 'success' | 'warning' | 'error'; outputPath?: string };
type Props = {
  libraries: GlossaryLibrary[];
  selectedLibraryId: string | null;
  draggedLibraryId: string | null;
  importMessage: ImportMessage | null;
  onDismissImport: () => void;
  onOpenExportDirectory: (path: string) => void;
  onCreateLibrary: () => void;
  onSelect: (id: string) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>, id: string) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>, id: string) => void;
  onDragEnd: () => void;
  onToggle: (id: string) => void;
  onExport: (ids?: string[]) => void;
  onRemove: (id: string) => void;
};

export default function GlossaryLibraryPanel(props: Props) {
  const { t } = useTranslation();
  return <aside className="glossary-library-panel">
    <div className="glossary-panel-head"><div><h3>{t('glossary.library.title')}</h3></div></div>
    {props.importMessage ? <div className={`glossary-toast glossary-toast-${props.importMessage.tone}`} role="status"><div className="glossary-toast-body"><strong>{t(`glossary.importTone.${props.importMessage.tone}`)}</strong><p>{props.importMessage.text}</p>{props.importMessage.outputPath ? <button className="text-button" onClick={() => props.onOpenExportDirectory(props.importMessage!.outputPath!)} type="button">{t('diagnostics.actions.openExportDirectory')}</button> : null}</div><button aria-label={t('glossary.actions.closeNotice')} className="glossary-toast-close" onClick={props.onDismissImport} type="button"><AppIcon name="close" size={14} /></button></div> : null}
    {!props.libraries.length ? <div className="glossary-empty"><strong>{t('glossary.empty.noLibrariesTitle')}</strong><p>{t('glossary.empty.noLibrariesDescription')}</p><button className="icon-button routing-primary-action" onClick={props.onCreateLibrary} type="button" style={{ justifySelf: 'start', marginTop: 4 }}><AppIcon name="book" size={14} />{t('glossary.actions.newLibrary')}</button></div> : <div className="glossary-library-list">{props.libraries.map((library, index) => <div
      className={['glossary-library-item', library.id === props.selectedLibraryId ? 'glossary-library-item-active' : '', library.id === props.draggedLibraryId ? 'glossary-library-item-dragging' : ''].filter(Boolean).join(' ')}
      draggable
      key={library.id}
      onClick={() => props.onSelect(library.id)}
      onDragEnd={props.onDragEnd}
      onDragOver={(event) => props.onDragOver(event, library.id)}
      onDragStart={(event) => props.onDragStart(event, library.id)}
      role="button"
      tabIndex={0}
    ><div className="glossary-library-main"><strong>{library.name}</strong><span>{t('glossary.labels.libraryMeta', { count: library.entries.length, priority: index + 1 })}</span></div><div className="glossary-library-actions" onClick={(event) => event.stopPropagation()}><button aria-label={library.enabled ? t('glossary.actions.disableLibraryNamed', { name: library.name }) : t('glossary.actions.enableLibraryNamed', { name: library.name })} aria-pressed={library.enabled} className="glossary-mini-button" onClick={() => props.onToggle(library.id)} title={library.enabled ? t('glossary.actions.disable') : t('glossary.actions.enable')} type="button"><AppIcon name={library.enabled ? 'eye' : 'eye-off'} size={14} /></button><button aria-label={t('glossary.actions.exportLibraryNamed', { name: library.name })} className="glossary-mini-button" onClick={() => props.onExport([library.id])} title={t('glossary.actions.exportThisLibrary')} type="button"><AppIcon name="cloud" size={14} /></button><button aria-label={t('glossary.actions.deleteLibraryNamed', { name: library.name })} className="glossary-mini-button glossary-mini-button-danger" onClick={() => props.onRemove(library.id)} title={t('common.delete')} type="button"><AppIcon name="trash" size={14} /></button></div></div>)}</div>}
    <button className="icon-button" disabled={!props.libraries.length} onClick={() => props.onExport()} type="button"><AppIcon name="cloud" size={15} />{t('glossary.actions.exportAll')}</button>
  </aside>;
}
