import path from 'node:path';

import {
  compactTimestamp,
  ensureDir,
  isMain,
  parseCliArgs,
  repoRoot,
  sortableTimestamp,
  writeText,
} from '../lib/testing-common.mjs';

const defaultOutputRoot = 'artifacts/testing/manual-e2e';

const reportLines = (generatedAt) => [
  '# Desktop E2E Smoke Report',
  '',
  `- GeneratedAt: ${generatedAt}`,
  '- Operator: TODO',
  '- Build: TODO',
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
  '- TTS outbound (speaker / virtual-mic counters advance on speech dispatch).',
  '',
  'This checklist keeps only scenarios that require a real machine.',
  '',
  '## Scenario Checklist',
  '',
  '1. Provider configuration',
  '- [ ] Save Provider config and secret reference successfully.',
  '- Result:',
  '',
  '2. Provider probe',
  '- [ ] Run probe and confirm verdict, transport, and guidance are populated.',
  '- Result:',
  '',
  '3. Real-device audio endpoints',
  '- [ ] On physical hardware, confirm inbound/outbound capture binds real audio devices and speech dispatch is audible on the speaker or visible on the virtual mic endpoint.',
  '- [ ] With the overlay locked, confirm OS-level click-through by activating a real application window behind the overlay center.',
  '- Result:',
  '',
  '4. Diagnostics export',
  '- [ ] Run diagnostics self-check and export a full diagnostics bundle.',
  '- Result:',
  '',
  '## Artifacts',
  '',
  '- Diagnostics bundle path:',
  '- Screenshot or notes:',
  '',
  '## Final Verdict',
  '',
  '- [ ] PASS',
  '- [ ] FAIL',
  '- Notes:',
];

export const prepareManualE2eReport = ({ outputRoot = defaultOutputRoot } = {}) => {
  const targetDir = ensureDir(path.resolve(repoRoot, outputRoot));
  const reportPath = path.join(targetDir, `desktop-e2e-${compactTimestamp()}.md`);
  writeText(reportPath, reportLines(sortableTimestamp()).join('\n'));
  return reportPath;
};

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), { defaults: { outputRoot: defaultOutputRoot } });
    console.log(prepareManualE2eReport(args));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
