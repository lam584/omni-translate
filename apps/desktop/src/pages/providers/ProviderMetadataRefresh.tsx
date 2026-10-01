import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon from '../../components/icons/AppIcon';
import { fetchProviderModelMetadata } from '../../runtime/provider-runtime';
import type { ProviderDraft } from '../../schema/config';

type Props = {
  provider: ProviderDraft;
  onChange: (patch: Partial<ProviderDraft>) => void;
};

export default function ProviderMetadataRefresh({ provider, onChange }: Props) {
  const { t } = useTranslation();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (provider.kind !== 'dashscope') return null;

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await fetchProviderModelMetadata(provider);
      if (result.error) throw new Error(result.error.message);
      if (result.providerId !== provider.providerId) throw new Error('Provider metadata response identity mismatch');
      if (mounted.current) onChange({ modelMetadataCache: { source: 'bailian-api', fetchedAt: result.fetchedAt, endpoint: result.endpoint, models: result.models } });
    } catch (cause) {
      // Leave the last successful cache untouched when a manual refresh fails.
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return <div className="provider-setting-block provider-setting-block-compact">
    <div className="provider-setting-header provider-setting-header-compact"><div><strong>{t('providers.metadata.title')}</strong></div>
      <button className="icon-button" disabled={busy} onClick={() => void refresh()} type="button"><AppIcon name="refresh" size={14} />{busy ? t('providers.metadata.refreshing') : t('providers.metadata.refresh')}</button>
    </div>
    {provider.modelMetadataCache ? <p className="provider-setting-footnote">{t('providers.metadata.lastUpdated', { date: provider.modelMetadataCache.fetchedAt, count: provider.modelMetadataCache.models.length })}</p> : <p className="provider-setting-footnote">{t('providers.metadata.notFetched')}</p>}
    {error ? <p className="provider-setting-footnote" role="alert">{t('providers.metadata.refreshFailed', { error })}</p> : null}
  </div>;
}
