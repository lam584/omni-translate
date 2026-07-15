import i18n from '../../i18n/config';
import type { GlossaryEntryStrategy } from '../../schema/glossary-package';
import type { GlossaryProcessingMode } from '../../schema/glossary-template';

export function formatStrategyLabel(strategy: GlossaryEntryStrategy) {
  if (strategy === 'force') return i18n.t('glossary.strategy.force');
  if (strategy === 'suggest') return i18n.t('glossary.strategy.suggest');
  return i18n.t('glossary.strategy.keep');
}

export function formatStrategyTone(strategy: GlossaryEntryStrategy) {
  if (strategy === 'force') return 'ready' as const;
  if (strategy === 'suggest') return 'warning' as const;
  return 'pending' as const;
}

export function formatProcessingModeLabel(mode: GlossaryProcessingMode) {
  if (mode === 'inject-all') return i18n.t('glossary.processingMode.injectAll');
  if (mode === 'inject-important') return i18n.t('glossary.processingMode.injectImportant');
  return i18n.t('glossary.processingMode.postCalibrate');
}

export function describeProcessingMode(mode: GlossaryProcessingMode, totalEntries: number, importantCount: number) {
  if (mode === 'inject-all') return i18n.t('glossary.processingDescription.injectAll', { count: totalEntries });
  if (mode === 'inject-important') return i18n.t('glossary.processingDescription.injectImportant', { count: importantCount });
  return i18n.t('glossary.processingDescription.postCalibrate');
}
