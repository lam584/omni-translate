import { Link } from 'react-router-dom';
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
  const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioRuntimeSnapshot);
  const overall = getOverallReadiness(scenes);

  return (
    <Link className="icon-button" title="查看诊断修复页" to="/diagnostics">
      <AppIcon name="search" size={14} />
      {showOverallBadge ? <StatusBadge label={overall.label} tone={overall.tone} /> : null}
    </Link>
  );
}

export default DiagnosticsQuickLink;
