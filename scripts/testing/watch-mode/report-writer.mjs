import fs from 'node:fs';
import path from 'node:path';

import { loadWatchModeArtifacts } from './artifact-loader.mjs';

export function collectReportInput(inputDir, mode = 'live', options = {}) {
  const loaded = loadWatchModeArtifacts(inputDir);
  const { collection, collectionPath, paths, snapshots, appLogText, bridgeLogText } = loaded;
  return {
    mode,
    snapshots,
    provenance: options.provenance,
    feedbackLoopPrevention: snapshots.feedbackLoopPrevention ?? null,
    driver: snapshots.driver,
    wasapi: snapshots.wasapi ?? snapshots.driver,
    bridge: snapshots.bridge,
    physicalOutput: snapshots.physicalOutput,
    physicalOutputContent: snapshots.physicalOutputContentRaw,
    app: snapshots.app,
    provider: snapshots.provider,
    speechSegmentation: snapshots.speechSegmentation,
    deviceEvidence: snapshots.deviceEvidence,
    watchSessionReport: snapshots.watchSessionReport,
    playback: snapshots.playback,
    systemMetrics: snapshots.systemMetrics ?? null,
    failure: collection.primaryError,
    steps: collection.steps,
    appLogText,
    bridgeLogText,
    artifacts: {
      appLog: paths.appLog,
      bridgeLog: paths.bridgeLog,
      collection: collectionPath,
      physicalOutputRecording: paths.physicalOutputRecording,
      physicalOutputContentRaw: paths.physicalOutputContentRaw,
      diagnosticsBundle: snapshots.diagnosticsBundle ?? null,
      watchSessionReport: paths.watchSessionReport,
      systemMetrics: paths.systemMetrics,
    },
  };
}

export function rebuildStoredReport(inputDir, { mode = 'live', provenance } = {}, classify) {
  return classify(collectReportInput(inputDir, mode, { provenance }));
}

export function writeStoredReport({ inputDir, outputDir, mode = 'live' }, policy) {
  fs.mkdirSync(outputDir, { recursive: true });
  const collected = collectReportInput(inputDir, mode);
  const physicalOutputContent = policy.derivePhysicalOutputContent(collected.physicalOutputContent, {
    speechSegmentation: collected.speechSegmentation,
  });
  if (physicalOutputContent) {
    fs.writeFileSync(
      path.join(outputDir, 'physical-output-content.json'),
      `${JSON.stringify(physicalOutputContent, null, 2)}\n`,
      'utf8',
    );
  }
  const report = policy.classifyWatchModeRun({ ...collected, physicalOutputContent });
  const reportJsonPath = path.join(outputDir, 'report.json');
  const reportMarkdownPath = path.join(outputDir, 'report.md');
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(reportMarkdownPath, policy.renderMarkdownReport(report), 'utf8');
  return { report, reportJsonPath, reportMarkdownPath };
}
