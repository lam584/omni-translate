import type { MouseEvent, MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';

import AppIcon from '../../components/icons/AppIcon';
import type { ProviderDraft } from '../../schema/config';
import type { ProviderTemplateCatalogEntry } from '../../utils/provider-template-catalog';
import { providersPageHelpers } from './providersPageHelpers';

type ProviderTemplateCatalogProps = {
  activeProvider: ProviderDraft;
  entries: ProviderTemplateCatalogEntry[];
  draggingTemplateId: string | null;
  modelCatalogOpen: boolean;
  query: string;
  onAddProvider: () => void;
  onApplyTemplate: (templateId: string) => void;
  onMouseDown: (event: MouseEvent<HTMLButtonElement>, templateId: string) => void;
  onMouseOver: (event: MouseEvent<HTMLButtonElement>, templateId: string) => void;
  onMouseUp: () => void;
  onQueryChange: (query: string) => void;
  onToggleEnabled: (templateId: string) => void;
  templateDragMovedRef: MutableRefObject<boolean>;
};

const {
  formatProviderLabel,
  resolveTemplateIconName,
} = providersPageHelpers;

export default function ProviderTemplateCatalog({
  activeProvider,
  entries,
  draggingTemplateId,
  modelCatalogOpen,
  query,
  onAddProvider,
  onApplyTemplate,
  onMouseDown,
  onMouseOver,
  onMouseUp,
  onQueryChange,
  onToggleEnabled,
  templateDragMovedRef,
}: ProviderTemplateCatalogProps) {
  const { t } = useTranslation();

  return (
    <aside className="provider-directory content-card page-card compact-card">
      <div className="provider-directory-header provider-directory-header-compact">
        <div>
          <span className="provider-directory-title">{t('providers.templateCatalog.title')}</span>
        </div>
      </div>

      <div className="provider-directory-search provider-directory-search-compact">
        <AppIcon name="search" size={14} />
        <input
          className="provider-directory-search-input"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('providers.templateCatalog.searchPlaceholder')}
          type="search"
          value={query}
        />
      </div>

      <div className="provider-directory-list" role="list">
        {entries.map((entry) => {
          const { enabled, template } = entry;

          return (
            <button
              className={`provider-directory-item provider-directory-item-compact${draggingTemplateId === template.id ? ' provider-directory-item-dragging' : ''}${activeProvider.templateId === template.id ? ' provider-directory-item-active' : ''}`}
              key={template.id}
              onClick={() => {
                if (templateDragMovedRef.current) {
                  templateDragMovedRef.current = false;
                  return;
                }

                onApplyTemplate(template.id);
              }}
              onMouseDown={(event) => onMouseDown(event, template.id)}
              onMouseOver={(event) => onMouseOver(event, template.id)}
              onMouseUp={onMouseUp}
              title={t('providers.templateCatalog.itemTitle')}
              type="button"
            >
              <span className="provider-directory-item-icon" aria-hidden="true">
                <AppIcon name={resolveTemplateIconName(template.defaultDraft.kind)} size={15} />
              </span>
              <span className="provider-directory-item-copy">
                <strong>{formatProviderLabel(template.displayName)}</strong>
              </span>
              <span
                className={enabled ? 'provider-directory-item-state provider-directory-item-state-active' : 'provider-directory-item-state'}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleEnabled(template.id);
                }}
                title={t('providers.templateCatalog.toggleTitle')}
              >
                {enabled ? 'ON' : 'OFF'}
              </span>
            </button>
          );
        })}

        {entries.length === 0 ? (
          <div className="provider-directory-empty">
            <strong>{t('providers.templateCatalog.emptyTitle')}</strong>
            <p>{t('providers.templateCatalog.emptyDescription')}</p>
          </div>
        ) : null}
      </div>

      {!modelCatalogOpen ? (
        <button className="provider-directory-add provider-directory-add-compact" onClick={onAddProvider} type="button">
          <AppIcon name="cloud" size={14} />
          {t('common.add')}
        </button>
      ) : null}
    </aside>
  );
}
