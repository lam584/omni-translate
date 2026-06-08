import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppIcon from '../icons/AppIcon';
import type { AudioRuntimeSnapshot } from '../../schema/audio-runtime';
import type { AppConfigDraft } from '../../schema/config';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import { getAllSceneReadiness, getOverallReadiness } from '../../utils/scene-readiness';
import StatusBadge from './StatusBadge';

type DiagnosticsQuickLinkProps = {
  configDraft: AppConfigDraft;
  runtimeSnapshot: RuntimeSnapshot;
  audioRuntimeSnapshot: AudioRuntimeSnapshot;
  showOverallBadge?: boolean;
};

function DiagnosticsQuickLink({ configDraft, runtimeSnapshot, audioRuntimeSnapshot, showOverallBadge = true }: DiagnosticsQuickLinkProps) {
  const { t } = useTranslation();
  const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioRuntimeSnapshot);
  const overall = getOverallReadiness(scenes);

  return (
    <Link className="icon-button" title={t('diagnostics.quickLinkTitle')} to="/diagnostics">
      <AppIcon name="search" size={14} />
      {showOverallBadge ? <StatusBadge label={overall.label} tone={overall.tone} /> : null}
    </Link>
  );
}

export default DiagnosticsQuickLink;
