import {
  isMain,
  repoRoot,
  runPrepareReportCli,
  writeText,
  writeTimestampedReport,
} from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import { INSTALL_RELEASE_ARTIFACTS_BY_SCENARIO } from './install-release-evidence.mjs';
import {
  INSTALL_REGRESSION_SCENARIOS,
  RELEASE_MANUAL_SCHEMA_VERSION,
} from './release-manual-evidence.mjs';

const defaultOutputRoot = 'artifacts/testing/install-regression';

const requiredInstallArtifacts = (scenarioId) => INSTALL_RELEASE_ARTIFACTS_BY_SCENARIO[scenarioId]
  .map((artifact) => `${artifact.path}${artifact.kind === 'directory' ? '/' : ''}`)
  .join(', ');

const scenario = (id, description, commands, collectorProfile, requiredArtifacts, authorityStatus) => [
  `### ${id}`,
  '',
  description,
  '',
  ...commands.map((command) => `- Command: ${command}`),
  `- CollectorProfile: ${collectorProfile}`,
  `- RequiredArtifacts: ${requiredArtifacts}`,
  `- AuthorityStatus: ${authorityStatus}`,
  '- [ ] PASS',
  '- [ ] FAIL',
  '- EvidenceReceipt: TODO',
  '- EvidenceReceiptSha256: TODO',
  '- Result: TODO',
  '',
];

const reportLines = (generatedAt, provenance) => [
  '# Install Regression Report',
  '',
  `- SchemaVersion: ${RELEASE_MANUAL_SCHEMA_VERSION}`,
  '- ArtifactKind: install-regression',
  `- GeneratedAt: ${generatedAt}`,
  '- Operator: TODO',
  `- Build: ${provenance.headCommit ?? 'TODO'}`,
  `- GitHead: ${provenance.headCommit ?? 'TODO'}`,
  `- WorktreeClean: ${provenance.worktreeClean === true}`,
  `- DirtyEntryCount: ${provenance.dirtyEntryCount ?? 'unknown'}`,
  '- RuntimeRoot: ./artifacts/diagnostics/logs',
  '',
  '## Checklist',
  '',
  'Run these commands only on a designated Windows x64 release test machine. Mutating scenarios use',
  'the signed package UAC entrypoint and must complete the real elevation prompt; cancellation, skip,',
  'dry-run, development signing, or caller-authored JSON cannot produce a release receipt. Each command',
  'runs the production emitter and fixed collector; archive the returned package directory to obtain',
  'the immutable EvidenceReceipt recorded below.',
  '',
  ...scenario(
    INSTALL_REGRESSION_SCENARIOS[0],
    'Fresh-install the canonical signed package from a completely absent state, then prove one healthy device pair, DriverStore/service identity, Bridge v6 handshake, tone playback, and real virtual-mic capture.',
    ['npm run collect:release-evidence:install:fresh'],
    'omni.release.install-fresh/v1',
    requiredInstallArtifacts('INSTALL-FRESH'),
    'ready (signed-package production UAC runner; no generic source assembly)',
  ),
  ...scenario(
    INSTALL_REGRESSION_SCENARIOS[1],
    'Repair the already-installed canonical version and prove the package, active SYS, endpoints, service, Bridge v6 handshake, and audio paths remain exact and healthy.',
    ['npm run collect:release-evidence:install:repair'],
    'omni.release.install-repair/v1',
    requiredInstallArtifacts('INSTALL-REPAIR'),
    'ready (signed-package production UAC runner; no generic source assembly)',
  ),
  ...scenario(
    INSTALL_REGRESSION_SCENARIOS[2],
    'Uninstall and prove complete ROOT/render/capture endpoint, DriverStore package, signed PnP identity, kernel service, runtime state, and Bridge/probe process absence.',
    ['npm run collect:release-evidence:install:uninstall'],
    'omni.release.install-uninstall/v1',
    requiredInstallArtifacts('INSTALL-UNINSTALL'),
    'ready (signed-package production UAC runner; no generic source assembly)',
  ),
  ...scenario(
    INSTALL_REGRESSION_SCENARIOS[3],
    'Exercise an actual in-place upgrade from an older canonical signed package; prove the source commit and SYS changed, ABI remains v6, only one device pair remains, backup retention is bounded, and both audio paths work.',
    ['npm run collect:release-evidence:install:upgrade -- -PreviousVersion <older-signed-version>'],
    'omni.release.install-upgrade/v1',
    requiredInstallArtifacts('INSTALL-UPGRADE'),
    'ready (two canonical signed packages plus production UAC runner; no generic source assembly)',
  ),
  ...scenario(
    INSTALL_REGRESSION_SCENARIOS[4],
    'Verify the already-finalized canonical stable package layout, exact inventory/checksums/signing targets, timestamps, package version, and clean current source commit without changing the machine.',
    ['npm run collect:release-evidence:install:release-layout'],
    'omni.release.installer-layout/v1',
    requiredInstallArtifacts('INSTALL-RELEASE-LAYOUT'),
    'ready (read-only canonical signed-layout authority runner; no generic source assembly)',
  ),
  '## Final Verdict',
  '',
  '- [ ] PASS',
  '- [ ] FAIL',
  '- Notes:',
];

export const prepareInstallRegressionReport = ({ outputRoot = defaultOutputRoot } = {}) =>
  writeTimestampedReport({
    outputRoot,
    filePrefix: 'install-regression',
    extension: 'md',
    render: (reportPath, generatedAt) => writeText(
      reportPath,
      reportLines(generatedAt, currentGitProvenance({ cwd: repoRoot })).join('\n'),
    ),
  });

if (isMain(import.meta.url)) {
  runPrepareReportCli(prepareInstallRegressionReport, { outputRoot: defaultOutputRoot });
}
