import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon from '../../components/icons/AppIcon';

// Shared compact heading used by the provider dialogs: title, optional
// description and the close icon button.
export function ProviderDialogHeader({ closeTitle, description, onClose, title }: {
  closeTitle: string;
  description?: ReactNode;
  onClose: () => void;
  title: ReactNode;
}) {
  return (
    <div className="provider-panel-heading provider-panel-heading-compact">
      <div>
        <h3>{title}</h3>
        {description != null ? <p>{description}</p> : null}
      </div>
      <button className="provider-header-icon" onClick={onClose} title={closeTitle} type="button">
        <AppIcon name="close" size={13} />
      </button>
    </div>
  );
}

// Shared auth-scheme <option> set for the custom-provider and advanced dialogs.
export function ProviderAuthSchemeOptions() {
  const { t } = useTranslation();
  return (
    <>
      <option value="bearer">Bearer</option>
      <option value="api-key">API Key</option>
      <option value="none">{t('providers.common.none')}</option>
    </>
  );
}
