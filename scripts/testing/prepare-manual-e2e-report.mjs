import {
  isMain,
  repoRoot,
  runPrepareReportCli,
  writeText,
  writeTimestampedReport,
} from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  MANUAL_E2E_SCENARIOS,
  RELEASE_MANUAL_SCHEMA_VERSION,
} from './release-manual-evidence.mjs';

const defaultOutputRoot = 'artifacts/testing/manual-e2e';

const scenario = (id, description, structuredFields = []) => [
  `### ${id}`,
  '',
  description,
  '',
  ...structuredFields,
  '- [ ] PASS',
  '- [ ] FAIL',
  '- EvidenceReceipt: TODO',
  '- EvidenceReceiptSha256: TODO',
  '- Result: TODO',
  '',
];

const reportLines = (generatedAt, provenance) => [
  '# Desktop E2E Smoke Report',
  '',
  `- SchemaVersion: ${RELEASE_MANUAL_SCHEMA_VERSION}`,
  '- ArtifactKind: manual-e2e',
  `- GeneratedAt: ${generatedAt}`,
  '- Operator: TODO',
  `- Build: ${provenance.headCommit ?? 'TODO'}`,
  `- GitHead: ${provenance.headCommit ?? 'TODO'}`,
  `- WorktreeClean: ${provenance.worktreeClean === true}`,
  `- DirtyEntryCount: ${provenance.dirtyEntryCount ?? 'unknown'}`,
  '- Environment: Windows desktop shell',
  '',
  '## Preflight',
  '',
  '1. Run npm run verify:desktop.',
  '2. Run npm run quality:desktop-shell.',
  '3. Run npm run test:bridge-service-native.',
  '',
  '## Automated Coverage',
  '',
  'The former manual scenarios below are now automated by the fake-bridge contract',
  'integration suite (apps/desktop/src/runtime/bridge-contract.integration.test.tsx),',
  'executed by the quality gate step integration-bridge-contract:',
  '',
  '- Subtitle display (inbound capture surfaces translated cues in the overlay).',
  '- Locked subtitle overlay input (click-through, unlock hotspot, unlock restore).',
  '- TTS dispatch lifecycle and Bridge-owned physical playback accounting.',
  '',
  'The fake Bridge does not prove that a real target application can open and capture from the',
  'virtual microphone endpoint. Stable release acceptance requires a receipt-backed real capture',
  'WAV, capture probe JSON, and runtime snapshot from the supported+ready v6 backend.',
  '',
  'collect-release-manual-evidence.mjs is fail-closed; raw authority packaging is private to each canonical production runner.',
  'Provider configuration, Provider probe, and diagnostics export must be collected by the controlled',
  'same-process Desktop startup runner; it launches one production Desktop and calls the existing handlers',
  'after that process renderer completes debug_ipc_ping. Arbitrary --source JSON remains forbidden:',
  '',
  'node ./scripts/testing/run-desktop-release-evidence.mjs --scenario-id E2E-PROVIDER-CONFIG',
  'node ./scripts/testing/run-desktop-release-evidence.mjs --scenario-id E2E-PROVIDER-PROBE',
  'node ./scripts/testing/run-desktop-release-evidence.mjs --scenario-id E2E-DIAGNOSTICS-EXPORT',
  'npm run collect:release-evidence:real-device-audio',
  'node ./scripts/testing/archive-release-manual-evidence.mjs --scenario-id <ID> --source <collector-package-directory>',
  '',
  '## Scenario Checklist',
  '',
  ...scenario(
    MANUAL_E2E_SCENARIOS[0],
    'Run the controlled production Desktop startup emitter. It calls the existing load/save handlers in-process, reloads the persisted Provider configuration, checks only the Windows Credential Manager reference status, and binds the result to the same invocation full diagnostics export without exposing the secret value.',
    [
      '- CollectorProfile: omni.release.provider-config/v1',
      '- AuthorityStatus: ready (same-process production Desktop emitter)',
      '- ProductionCommand: node ./scripts/testing/run-desktop-release-evidence.mjs --scenario-id E2E-PROVIDER-CONFIG',
      '- RequiredArtifacts: emitter-result.json, provider-config-snapshot.json, diagnostics-bundle/',
    ],
  ),
  ...scenario(
    MANUAL_E2E_SCENARIOS[1],
    'Run the controlled production Desktop startup emitter. It calls the existing Provider probe handler in-process with the persisted credential reference and binds the available verdict, measured latency, transport, and raw probe result to the same invocation full diagnostics export.',
    [
      '- CollectorProfile: omni.release.provider-probe/v1',
      '- AuthorityStatus: ready (same-process production Desktop emitter; requires live credential/provider)',
      '- ProductionCommand: node ./scripts/testing/run-desktop-release-evidence.mjs --scenario-id E2E-PROVIDER-PROBE',
      '- RequiredArtifacts: emitter-result.json, provider-probe-result.json, diagnostics-bundle/',
    ],
  ),
  ...scenario(
    MANUAL_E2E_SCENARIOS[2],
    'Use the fixed qwen3.5-omni/process-exclusion/default-speaker cell from the current canonical strict Watch Mode schema-v2 authority. The assembler re-verifies the complete release matrix, copies the selected cell receipt and fixed raw inventory, and proves that Desktop-generated translated cues completed through Bridge-owned physical playback on the actual Windows MMDevice endpoint.',
    [
      '- CollectorProfile: omni.release.real-device-audio/v1',
      '- AuthorityStatus: ready (canonical strict-v2 Watch Mode authority; requires the complete current-HEAD live matrix)',
      '- ProductionCommand: npm run collect:release-evidence:real-device-audio',
      '- SelectedCell: qwen3.5-omni-flash-realtime/process-exclusion/default-speaker',
      '- RequiredArtifacts: emitter-result.json, real-device-audio-probe.json, real-device-audio-timeline.json, canonical-matrix-manifest.json, matrix-cell-authority.json, real-device-audio.wav, real-device-audio-16k-mono.pcm, real-device-source-16k-mono.pcm, real-device-reference-16k-mono.pcm, process-exclusion-physical-output.wav, process-exclusion-source-pipe.wav, cell-raw/',
    ],
  ),
  ...scenario(
    MANUAL_E2E_SCENARIOS[3],
    'Run the dedicated Windows x64 overlay authority. It builds the current clean-HEAD release Desktop and native target helper, opens a real tauri-driver session, locks the production overlay over the separate target HWND, observes WM_NCHITTEST/HTTRANSPARENT, sends one real SendInput click, verifies the target WM_LBUTTONDOWN/foreground state, and captures the actual screen for named operator review.',
    [
      '- CollectorProfile: omni.release.overlay-click-through/v1',
      '- AuthorityStatus: ready (real Windows OS/WebDriver authority; requires an interactive desktop session)',
      '- ProductionCommand: node ./scripts/testing/run-overlay-click-through-release-evidence.mjs --operator "<name>" --operator-notes "<observed target click and passive overlay behavior>"',
      '- RequiredArtifacts: emitter-result.json, overlay-click-through-probe.json, overlay-click-through.png, target-ready.json, target-click.json, webdriver-transcript.json',
    ],
  ),
  ...scenario(
    MANUAL_E2E_SCENARIOS[4],
    'Run the controlled production Desktop startup emitter and call the existing full diagnostics export handler in-process. The canonical export, packaged copy, invocation log marker, Desktop PID, manifest, and directory hashes must agree.',
    [
      '- CollectorProfile: omni.release.diagnostics-export/v1',
      '- AuthorityStatus: ready (same-process production Desktop emitter)',
      '- ProductionCommand: node ./scripts/testing/run-desktop-release-evidence.mjs --scenario-id E2E-DIAGNOSTICS-EXPORT',
      '- RequiredArtifacts: emitter-result.json, diagnostics-export-receipt.json, diagnostics-bundle/',
    ],
  ),
  ...scenario(
    MANUAL_E2E_SCENARIOS[5],
    'With capability supported+ready, have a real target capture application open the named 48 kHz mono PCM16 endpoint. Route one uniquely fingerprinted cue and prove captured frames and Bridge virtualMicFramesWritten are positive, physical playback frames are zero, and that cue completes exactly once.',
    [
      '- ExpectedOutcome: supported-ready-real-capture',
      '- CollectorProfile: omni.release.virtual-mic-v6/v1 (dedicated rebuild runner + native authority omni-virtual-mic-target-capture/0.1.0)',
      '- AuthorityStatus: ready (current-clean-HEAD rebuild runner with native v6 target-capture emitter)',
      '- ProductionCommand: npm run collect:release-evidence:virtual-mic',
      '- RequiredArtifacts: emitter-result.json, virtual-mic-capture.wav, virtual-mic-capture-probe.json, runtime-snapshot.json',
      '- CapabilitySupported: TODO',
      '- CapabilityStatus: TODO',
      '- CaptureEndpointName: TODO',
      '- VirtualMicFormat: TODO',
      '- CapturedFrames: TODO',
      '- BridgeVirtualMicFramesWritten: TODO',
      '- PhysicalPlaybackFrames: TODO',
      '- CueCompletedCount: TODO',
    ],
  ),
  '## Final Verdict',
  '',
  '- [ ] PASS',
  '- [ ] FAIL',
  '- Notes:',
];

export const prepareManualE2eReport = ({ outputRoot = defaultOutputRoot } = {}) =>
  writeTimestampedReport({
    outputRoot,
    filePrefix: 'desktop-e2e',
    extension: 'md',
    render: (reportPath, generatedAt) => writeText(
      reportPath,
      reportLines(generatedAt, currentGitProvenance({ cwd: repoRoot })).join('\n'),
    ),
  });

if (isMain(import.meta.url)) {
  runPrepareReportCli(prepareManualE2eReport, { outputRoot: defaultOutputRoot });
}
