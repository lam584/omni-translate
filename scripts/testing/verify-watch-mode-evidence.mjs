import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseLooseArgs } from '../lib/testing-common.mjs';
import {
  currentGitProvenance,
  exactGitProvenanceFailure,
} from './git-provenance.mjs';
import { derivePhysicalOutputContent, rebuildReportFromDirectory } from './watch-mode-report.mjs';
import { readWatchModeRunCollection } from './watch-mode-run-collection.mjs';
import { analyzeAudioWithRust } from './watch-mode-rust-audio-analysis.mjs';
import {
  CELL_AUTHORITY_ARTIFACT_KIND,
  CELL_AUTHORITY_FILE,
  CELL_AUTHORITY_SCHEMA_VERSION,
  LIVE_RUN_COLLECTOR_ID,
  MATRIX_RUNNER_ID,
  STRICT_MATRIX_ARTIFACT_KIND,
  STRICT_MATRIX_SCHEMA_VERSION,
  canonicalJson,
  currentAuthorityImplementationHashes,
  currentPaidAuthorityImplementationHashes,
  currentAuthorityRuntimeBinaryHashes,
  fileAuthorityEntry,
  forbiddenCellArtifactPaths,
  requiredCellArtifactPaths,
  resolveAuthorityPath,
  sameAuthorityInventory,
  validateFileAuthorityEntry,
} from './watch-mode-evidence-authority.mjs';
import {
  BALANCED_RELEASE_PLAN,
  LIVE_LLM_CELLS,
  PROCESS_EXCLUSION_RESTART_AFTER_SECONDS,
  PROCESS_EXCLUSION_RESTART_QUIET_SECONDS,
  RELEASE_DEVICE_CLASSES,
  RELEASE_MODELS,
  balancedReleasePlanFailure,
} from './watch-mode-balanced-release-plan.mjs';
import {
  deriveWatchModelProtocolIdentity,
  watchModelProtocolIdentityFailure,
} from './watch-mode-model-protocol-authority.mjs';
import {
  MATRIX_EXTERNAL_PROVIDER_BUDGET_FILE,
  STRICT_PAID_MATRIX_MAX_INPUT_SAMPLES,
  STRICT_PAID_MODEL_PROTOCOLS,
  STRICT_PAID_PROVIDER_IDENTITY,
  assertCellExternalProviderBudget,
  assertMatrixExternalProviderBudget,
} from './watch-mode-external-provider-budget.mjs';
import {
  SHARD_CELL_RESULT_FILE,
  SHARD_AUTHORITY_SCHEMA_VERSION,
  SHARD_EXECUTION_PLAN_FILE,
  SHARD_ALLOWED_WORKER_COUNTS,
  SHARD_MANIFEST_FILE,
  SHARD_MATRIX_CELL_COUNT,
  SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
  authorityInventoryDigest,
  currentShardOrchestrationImplementationHashes,
  sameAuthorityInventory as sameShardAuthorityInventory,
  sha256Canonical,
  validateShardManifest,
  validateWorkerReadinessRequest,
  validateWorkerZeroProviderReadinessAuthority,
  verifyCellLease,
  verifySignedExecutionPlan,
} from './watch-mode-shard-authority.mjs';
import {
  COORDINATOR_AGGREGATE_FILE,
  COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT,
  COORDINATOR_PROVIDER_PREFLIGHT_FILE,
  COORDINATOR_PROVIDER_PREFLIGHT_INVENTORY_FILE,
  COORDINATOR_PROVIDER_PREFLIGHT_INVENTORY_KIND,
  COORDINATOR_PROVIDER_PREFLIGHT_KIND,
  validateCoordinatorAggregate,
} from './run-watch-mode-live-coordinator.mjs';
import { buildTranslatedPcmLoopbackAuthority } from './watch-mode-translated-pcm-loopback.mjs';
import {
  loadCanonicalFixtureAuthority,
  validateRunCanonicalSourceAuthority,
} from './watch-mode-canonical-source-authority.mjs';
import { verifyLocalIsolationManifest } from './watch-mode-local-isolation.mjs';
import { validateProviderPreflightRawAuthority } from './watch-mode-provider-preflight-authority.mjs';
import {
  PROVIDER_PREFLIGHT_COMPLETION_FILE,
  PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
  PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_KIND,
  PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE,
  PROVIDER_PREFLIGHT_GRANT_FILE,
  PROVIDER_PREFLIGHT_INPUT_MODE,
  PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
  PROVIDER_PREFLIGHT_LIFECYCLE_BUDGET,
  PROVIDER_PREFLIGHT_MODEL,
  PROVIDER_PREFLIGHT_OPERATION,
  PROVIDER_PREFLIGHT_PROTOCOL,
  PROVIDER_PREFLIGHT_PROVIDER_INPUT_MODE,
  PROVIDER_PREFLIGHT_PROVIDER_ID,
  PROVIDER_PREFLIGHT_RESPONSE_MODE,
  PROVIDER_PREFLIGHT_TERMINAL_EVENT,
  providerPreflightReservationFileName,
  validateProviderPreflightAuthorizationAuthorities,
  verifyProviderPreflightCompletion,
} from './watch-mode-provider-preflight-authorization.mjs';

export const STRICT_MATRIX_VERIFICATION_ARTIFACT_KIND = 'watch-mode-strict-matrix-verification';

const strictPaidCellTimingProjection = (cell) => ({
  inputCompletionWatchdogSeconds: cell.inputCompletionWatchdogSeconds,
  processExclusionRestartAfterSeconds: cell.processExclusionRestartAfterSeconds,
  processExclusionRestartQuietSeconds: cell.processExclusionRestartQuietSeconds,
  providerFinishTimeoutSeconds: cell.providerFinishTimeoutSeconds,
  localPlaybackDrainTimeoutSeconds: cell.localPlaybackDrainTimeoutSeconds,
  reportWriteTimeoutSeconds: cell.reportWriteTimeoutSeconds,
  cellHardWatchdogSeconds: cell.cellHardWatchdogSeconds,
  authoritativeTransformedReferenceFrames: cell.authoritativeTransformedReferenceFrames,
  boundedCaptureGraceFrames: cell.boundedCaptureGraceFrames,
  maxExternalAudioSamples: cell.maxExternalAudioSamples,
  auxiliaryExternalAudioSeconds: cell.auxiliaryExternalAudioSeconds,
  subtitleTranslationMode: cell.subtitleTranslationMode,
});

const EVIDENCE_DRIVEN_REQUIRED_TERMINAL_STAGES = Object.freeze([
  'mediaPlaybackCompleted',
  'inputCompleteSignaled',
  'inputCompleteObserved',
  'sessionUpdatedReceived',
  'lastProviderAppend',
  'sessionFinishSent',
  'sessionFinishedReceived',
  'localPlaybackQuiescent',
  'finalRendererAck',
  'reportWritten',
]);
const EVIDENCE_DRIVEN_RESPONSE_TERMINAL_STAGES = Object.freeze([
  'lastResponseAudioDone',
  'responseDone',
]);

const runtimeBundleDigest = (entries) => (
  Array.isArray(entries) && entries.length === 0
    ? sha256Canonical([])
    : authorityInventoryDigest(entries)
);

export function validateEvidenceDrivenTerminal(runDirectory, plannedCell, expectedIdentity) {
  const readAuthoritySnapshot = (name) => {
    const filePath = path.join(path.resolve(runDirectory), name);
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
      throw new Error(`${name} must be a non-empty regular non-symlink file`);
    }
    const bytes = fs.readFileSync(filePath);
    return {
      bytes,
      json: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  };
  const marker = readAuthoritySnapshot('input-complete.json').json;
  const terminal = readAuthoritySnapshot('evidence-driven-terminal.json').json;
  const identity = {
    runMarker: expectedIdentity.runMarker,
    cellId: plannedCell.cellId,
    leaseId: expectedIdentity.leaseId,
  };
  if (marker.schemaVersion !== 1 || marker.artifactKind !== 'watch-mode-input-complete') {
    throw new Error('input-complete authority schema/kind mismatch');
  }
  if (terminal.schemaVersion !== 2
    || terminal.artifactKind !== 'watch-mode-evidence-driven-terminal'
    || terminal.status !== 'completed') {
    throw new Error('evidence-driven terminal schema/kind/status mismatch');
  }
  for (const [key, value] of Object.entries(identity)) {
    if (marker[key] !== value || terminal[key] !== value) {
      throw new Error(`evidence-driven terminal ${key} identity mismatch`);
    }
  }
  const expectedSourceHeadCommit = String(expectedIdentity.sourceHeadCommit ?? '');
  const expectedRuntimeBundleDigest = String(expectedIdentity.runtimeBundleDigest ?? '');
  const expectedLaunchId = String(expectedIdentity.launchId ?? '');
  const expectedProducerProcessId = Number(expectedIdentity.producerProcessId);
  const expectedProducerStartTimeUtcTicks = String(expectedIdentity.producerStartTimeUtcTicks ?? '');
  const expectedProducerExecutableSha256 = String(expectedIdentity.producerExecutableSha256 ?? '');
  const expectedProducerStartedAtUnixMs = /^\d{18}$/u.test(expectedProducerStartTimeUtcTicks)
    ? Number((BigInt(expectedProducerStartTimeUtcTicks) - 621_355_968_000_000_000n) / 10_000n)
    : Number.NaN;
  if (!/^[a-f0-9]{40}$/u.test(expectedSourceHeadCommit)
    || !/^[a-f0-9]{64}$/u.test(expectedRuntimeBundleDigest)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(expectedLaunchId)
    || !Number.isSafeInteger(expectedProducerProcessId)
    || expectedProducerProcessId <= 0
    || !/^\d{18}$/u.test(expectedProducerStartTimeUtcTicks)
    || BigInt(expectedProducerStartTimeUtcTicks) <= 621_355_968_000_000_000n
    || !/^[a-f0-9]{64}$/u.test(expectedProducerExecutableSha256)
    || terminal.sourceHeadCommit !== expectedSourceHeadCommit
    || terminal.runtimeBundleDigest !== expectedRuntimeBundleDigest
    || terminal.launchId !== expectedLaunchId
    || Number(terminal.producerProcessId) !== expectedProducerProcessId
    || String(terminal.producerStartTimeUtcTicks ?? '') !== expectedProducerStartTimeUtcTicks
    || terminal.producerExecutableSha256 !== expectedProducerExecutableSha256
    || !Number.isSafeInteger(Number(terminal.producerStartedAtUnixMs))
    || Number(terminal.producerStartedAtUnixMs) <= 0
    || Number(terminal.producerStartedAtUnixMs) !== expectedProducerStartedAtUnixMs
    || Number(terminal.startedAtUnixMs) < expectedProducerStartedAtUnixMs) {
    throw new Error('evidence-driven terminal producer/process/source/runtime identity mismatch');
  }
  if (
    Number(marker.authoritativeTransformedReferenceFrames)
      !== Number(plannedCell.authoritativeTransformedReferenceFrames)
    || Number(marker.boundedCaptureGraceFrames) !== Number(plannedCell.boundedCaptureGraceFrames)
    || Number(marker.maxExternalAudioSamples) !== Number(plannedCell.maxExternalAudioSamples)
    || Number(marker.authoritativeTransformedReferenceFrames)
      + Number(marker.boundedCaptureGraceFrames) !== Number(marker.maxExternalAudioSamples)
  ) throw new Error('input-complete sample authority does not match the mode-derived release cell');
  const events = Array.isArray(terminal.events) ? terminal.events : [];
  if (events.length !== EVIDENCE_DRIVEN_REQUIRED_TERMINAL_STAGES.length + 1) {
    throw new Error('evidence-driven terminal event inventory is incomplete');
  }
  const mediaPlaybackCompletedAt = Number(marker.mediaPlaybackCompletedAtUnixMs);
  const inputCompleteSignaledAt = Number(marker.signaledAtUnixMs);
  const markerCompletedAt = Number(marker.completedAtUnixMs);
  if (!Number.isSafeInteger(mediaPlaybackCompletedAt) || mediaPlaybackCompletedAt <= 0
    || !Number.isSafeInteger(inputCompleteSignaledAt)
    || inputCompleteSignaledAt < mediaPlaybackCompletedAt
    || !Number.isSafeInteger(markerCompletedAt)
    || markerCompletedAt < inputCompleteSignaledAt) {
    throw new Error('input-complete media/signal/completion timestamps are invalid');
  }
  let previousAt = Number(terminal.startedAtUnixMs);
  const completedAt = Number(terminal.completedAtUnixMs);
  if (!Number.isSafeInteger(previousAt) || previousAt <= 0
    || !Number.isSafeInteger(completedAt) || completedAt < previousAt) {
    throw new Error('evidence-driven terminal startedAtUnixMs/completedAtUnixMs boundary is invalid');
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const observedAt = Number(event?.observedAtUnixMs);
    if (Number(event?.sequence) !== index + 1
      || !Number.isSafeInteger(observedAt)
      || observedAt < previousAt
      || observedAt > completedAt) {
      throw new Error(`evidence-driven terminal event ${index + 1} is missing or non-monotonic`);
    }
    previousAt = observedAt;
  }
  const eventsByStage = new Map();
  for (const event of events) {
    if (!event?.stage || eventsByStage.has(event.stage)) {
      throw new Error('evidence-driven terminal contains a missing or duplicate raw stage');
    }
    eventsByStage.set(event.stage, event);
  }
  for (const stage of EVIDENCE_DRIVEN_REQUIRED_TERMINAL_STAGES) {
    if (!eventsByStage.has(stage)) {
      throw new Error(`evidence-driven terminal is missing raw stage ${stage}`);
    }
  }
  const responseStages = EVIDENCE_DRIVEN_RESPONSE_TERMINAL_STAGES
    .filter((stage) => eventsByStage.has(stage));
  if (responseStages.length !== 1) {
    throw new Error('evidence-driven terminal requires exactly one last response audio/done raw stage');
  }
  const permittedStages = new Set([
    ...EVIDENCE_DRIVEN_REQUIRED_TERMINAL_STAGES,
    ...EVIDENCE_DRIVEN_RESPONSE_TERMINAL_STAGES,
  ]);
  if (events.some((event) => !permittedStages.has(event.stage))) {
    throw new Error('evidence-driven terminal contains a non-authoritative aggregate/unknown stage');
  }

  const mediaEvent = eventsByStage.get('mediaPlaybackCompleted');
  const signalEvent = eventsByStage.get('inputCompleteSignaled');
  const observedEvent = eventsByStage.get('inputCompleteObserved');
  const inputClosedSourceSequence = Number(observedEvent.detail?.sourceSequence);
  if (Number(mediaEvent.observedAtUnixMs) !== mediaPlaybackCompletedAt
    || Number(signalEvent.observedAtUnixMs) !== inputCompleteSignaledAt
    || Number(observedEvent.observedAtUnixMs) < inputCompleteSignaledAt
    || Number(observedEvent.detail?.markerSignaledAtUnixMs) !== inputCompleteSignaledAt
    || observedEvent.detail?.acceptedExactlyOnce !== true
    || observedEvent.detail?.captureProducerFenced !== true
    || observedEvent.detail?.providerInputSenderReleased !== true
    || !Number.isSafeInteger(inputClosedSourceSequence)
    || inputClosedSourceSequence <= 0) {
    throw new Error('input-complete signal/desktop observation raw authorities do not bind the immutable marker');
  }

  const updatedEvent = eventsByStage.get('sessionUpdatedReceived');
  const appendEvent = eventsByStage.get('lastProviderAppend');
  const finishEvent = eventsByStage.get('sessionFinishSent');
  const responseEvent = eventsByStage.get(responseStages[0]);
  const finishedEvent = eventsByStage.get('sessionFinishedReceived');
  const updated = updatedEvent.detail ?? {};
  const append = appendEvent.detail ?? {};
  const finish = finishEvent.detail ?? {};
  const response = responseEvent.detail ?? {};
  const finished = finishedEvent.detail ?? {};
  const updatedSourceSequence = Number(updated.sourceSequence);
  const appendSourceSequence = Number(append.sourceSequence);
  const finishSourceSequence = Number(finish.sourceSequence);
  const responseSourceSequence = Number(response.sourceSequence);
  const finishedSourceSequence = Number(finished.sourceSequence);
  const sha256Pattern = /^[0-9a-f]{64}$/u;
  if (!Number.isSafeInteger(updatedSourceSequence) || updatedSourceSequence <= 0
    || updated.authority !== 'desktop-livetranslate-typed-session-owner'
    || !sha256Pattern.test(updated.sessionIdentitySha256 ?? '')
    || !sha256Pattern.test(updated.sentSessionConfigSha256 ?? '')
    || updated.echoedSessionConfigSha256 !== updated.sentSessionConfigSha256
    || Number(updatedEvent.observedAtUnixMs) > Number(appendEvent.observedAtUnixMs)) {
    throw new Error('session.updated typed authority does not bind the exact sent and echoed session configuration before Provider input');
  }
  if (!Number.isSafeInteger(appendSourceSequence)
    || appendSourceSequence <= updatedSourceSequence
    || !Number.isSafeInteger(Number(append.appendIndex)) || Number(append.appendIndex) <= 0
    || !Number.isSafeInteger(Number(append.samples)) || Number(append.samples) <= 0
    || !Number.isSafeInteger(Number(append.acceptedSamplesTotal))
    || Number(append.acceptedSamplesTotal) < Number(append.samples)
    || Number(append.acceptedSamplesTotal) > Number(marker.maxExternalAudioSamples)
    || !Number.isSafeInteger(finishSourceSequence)
    || finishSourceSequence <= appendSourceSequence
    || Number(finish.lastProviderAppendSourceSequence) !== appendSourceSequence
    || Number(finish.providerInputClosedSourceSequence) !== inputClosedSourceSequence
    || finishSourceSequence <= inputClosedSourceSequence
    || Number(finish.finishCount) !== 1
    || Number(finish.providerWritesAfterFinish) !== 0
    || Number(finishEvent.observedAtUnixMs) < Number(appendEvent.observedAtUnixMs)) {
    throw new Error('session.finish is not exactly-once and strictly ordered after the last legal Provider append');
  }
  if (!Number.isSafeInteger(responseSourceSequence)
    || responseSourceSequence <= 0
    || typeof response.responseId !== 'string'
    || !response.responseId.trim()
    || !Number.isSafeInteger(finishedSourceSequence)
    || finishedSourceSequence <= responseSourceSequence
    || finishedSourceSequence <= finishSourceSequence
    || Number(finished.finishCount) !== 1
    || Number(finished.providerWritesAfterFinish) !== 0
    || Number(finishedEvent.observedAtUnixMs) < Number(finishEvent.observedAtUnixMs)
    || Number(finishedEvent.observedAtUnixMs) - Number(finishEvent.observedAtUnixMs) > 15_000) {
    throw new Error('Provider terminal authority is missing a pre-session.finished response completion, session.finished, or exceeds the 15s finish phase');
  }

  const providerSourceSequences = [
    updatedSourceSequence,
    appendSourceSequence,
    inputClosedSourceSequence,
    finishSourceSequence,
    responseSourceSequence,
    finishedSourceSequence,
  ];
  if (new Set(providerSourceSequences).size !== providerSourceSequences.length) {
    throw new Error('Provider terminal authority reuses a raw source sequence across distinct lifecycle events');
  }

  const ackEvent = eventsByStage.get('finalRendererAck');
  const ack = ackEvent.detail ?? {};
  const ackSourceSequence = Number(ack.sourceSequence);
  if (!Number.isSafeInteger(ackSourceSequence) || ackSourceSequence <= 0
    || providerSourceSequences.includes(ackSourceSequence)
    || typeof ack.cueId !== 'string' || !ack.cueId.trim()
    || typeof ack.responseId !== 'string' || ack.responseId !== response.responseId
    || !Number.isSafeInteger(Number(ack.cueSequence)) || Number(ack.cueSequence) <= 0
    || Number(ack.cueSequence) !== Number(ack.lastCueSequence)
    || ack.coversLastCue !== true
    || typeof ack.receiptAuthority !== 'string' || !ack.receiptAuthority.trim()
    || typeof ack.receiptId !== 'string' || !ack.receiptId.trim()) {
    throw new Error('final renderer ACK identity does not cover the last cue/Provider response lineage');
  }

  const drainEvent = eventsByStage.get('localPlaybackQuiescent');
  const drainDetail = drainEvent?.detail;
  const stableForMs = Number(drainDetail?.stableForMs);
  const drainBudgetMs = Number(drainDetail?.drainBudgetMs);
  if (!Number.isSafeInteger(stableForMs) || stableForMs < 500 || stableForMs > 1_000
    || !Number.isSafeInteger(drainBudgetMs) || drainBudgetMs <= 0 || drainBudgetMs > 30_000
    || drainDetail?.speakerPlaybackActive !== false
    || typeof drainDetail?.usedFallbackCap !== 'boolean') {
    throw new Error('local playback drain is missing its bounded frame/rate authority');
  }
  if (drainDetail.usedFallbackCap) {
    if (drainBudgetMs < 15_000
      || drainDetail.initialPendingAudioFrames != null
      || drainDetail.outputSampleRateHz != null) {
      throw new Error('local playback drain fallback authority is not fail-closed within 15-30 seconds');
    }
  } else {
    const pendingFrames = Number(drainDetail.initialPendingAudioFrames);
    const outputRateHz = Number(drainDetail.outputSampleRateHz);
    if (!Number.isSafeInteger(pendingFrames) || pendingFrames < 0
      || !Number.isSafeInteger(outputRateHz) || outputRateHz <= 0) {
      throw new Error('local playback drain frame/rate authority is invalid');
    }
    const derivedBudgetMs = Math.min(
      Math.ceil((pendingFrames * 1_000) / outputRateHz) + 2_000 + stableForMs,
      30_000,
    );
    if (drainBudgetMs !== derivedBudgetMs) {
      throw new Error('local playback drain budget does not match pending frames/output rate');
    }
  }
  if (Number(drainEvent.observedAtUnixMs) < Number(finishedEvent.observedAtUnixMs)
    || Number(drainEvent.observedAtUnixMs) < Number(ackEvent.observedAtUnixMs)) {
    throw new Error('local playback quiescence was claimed before Provider/renderer terminal evidence');
  }
  const reportEvent = eventsByStage.get('reportWritten');
  if (events.at(-1) !== reportEvent
    || Number(reportEvent.observedAtUnixMs) < Number(drainEvent.observedAtUnixMs)
    || Number(terminal.completedAtUnixMs) < Number(reportEvent.observedAtUnixMs)) {
    throw new Error('reportWritten must be the final monotonic terminal stage');
  }
  const reportDetail = reportEvent.detail ?? {};
  if (reportDetail.reportPath !== 'watch-session-report.json') {
    throw new Error('reportWritten reportPath must be the canonical Watch session report path');
  }
  const reportPath = path.join(path.resolve(runDirectory), reportDetail.reportPath);
  const reportStats = fs.lstatSync(reportPath);
  if (!reportStats.isFile() || reportStats.isSymbolicLink() || reportStats.size <= 0) {
    throw new Error('reportWritten must bind a non-empty regular non-symlink report');
  }
  const reportSnapshot = readAuthoritySnapshot(reportDetail.reportPath);
  const reportAuthority = {
    path: reportDetail.reportPath,
    bytes: reportSnapshot.bytes.length,
    sha256: reportSnapshot.sha256,
  };
  if (!Number.isSafeInteger(Number(reportDetail.byteLength))
    || Number(reportDetail.byteLength) !== reportAuthority.bytes
    || !/^[a-f0-9]{64}$/u.test(String(reportDetail.sha256 ?? ''))
    || reportDetail.sha256 !== reportAuthority.sha256) {
    throw new Error('reportWritten byte length/hash does not match the immutable report bytes');
  }
  const report = reportSnapshot.json;
  if (report.status !== 'completed') {
    throw new Error('reportWritten immutable report is not completed');
  }
  return { marker, terminal, reportAuthority };
}

export function strictMatrixVerificationReceiptPath(manifestPath) {
  return `${path.resolve(manifestPath)}.verified.json`;
}

function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

export function writeStrictMatrixVerificationReceipt({
  manifestPath,
  manifest,
  authority,
  currentProvenance,
  now = new Date(),
}) {
  const sourceManifest = fileAuthorityEntry(
    path.resolve(manifestPath),
    path.basename(manifestPath),
  );
  const receipt = {
    schemaVersion: 1,
    artifactKind: STRICT_MATRIX_VERIFICATION_ARTIFACT_KIND,
    verifiedAt: now.toISOString(),
    verifier: 'scripts/testing/verify-watch-mode-evidence.mjs',
    provenance: currentProvenance,
    sourceManifestPath: sourceManifest.path,
    sourceManifestBytes: sourceManifest.bytes,
    sourceManifestSha256: sourceManifest.sha256,
    implementationHashes: authority.implementationHashes,
    paidImplementationHashes: authority.paidImplementationHashes,
    runtimeBinaryHashes: authority.runtimeBinaryHashes,
    externalProviderBudget: manifest.externalProviderBudget,
    ...(manifest.shardExecution ? { shardExecution: manifest.shardExecution } : {}),
    ...(manifest.matrixIntegration ? { matrixIntegration: manifest.matrixIntegration } : {}),
    cells: manifest.cells.map((cell) => ({
      cellId: cell.cellId,
      tier: cell.tier,
      providerMode: cell.providerMode,
      ...strictPaidCellTimingProjection(cell),
      modelId: cell.modelId,
      feedbackLoopPrevention: cell.feedbackLoopPrevention,
      deviceClass: cell.deviceClass,
      deviceProfileId: cell.deviceProfileId,
      runDirectory: cell.runDirectory,
      receiptPath: cell.receiptPath,
      receiptBytes: cell.receiptBytes,
      receiptSha256: cell.receiptSha256,
      ...(cell.shardAuthority ? { shardAuthority: cell.shardAuthority } : {}),
    })),
    verdict: 'passed',
  };
  const receiptPath = strictMatrixVerificationReceiptPath(manifestPath);
  atomicWriteJson(receiptPath, receipt);
  return { receiptPath, receipt };
}

export function validateStrictMatrixVerificationReceipt({
  receiptPath,
  manifestPath,
  manifest,
  currentProvenance,
  implementationHashes,
  paidImplementationHashes = currentPaidAuthorityImplementationHashes(),
  runtimeBinaryHashes,
}) {
  const resolvedReceiptPath = path.resolve(receiptPath);
  const expectedReceiptPath = strictMatrixVerificationReceiptPath(manifestPath);
  if (resolvedReceiptPath !== expectedReceiptPath) {
    throw new Error(`strict verification receipt path mismatch: expected ${expectedReceiptPath}; got ${resolvedReceiptPath}`);
  }
  const receipt = readJson(resolvedReceiptPath);
  if (
    receipt.schemaVersion !== 1
    || receipt.artifactKind !== STRICT_MATRIX_VERIFICATION_ARTIFACT_KIND
    || receipt.verifier !== 'scripts/testing/verify-watch-mode-evidence.mjs'
    || receipt.verdict !== 'passed'
  ) {
    throw new Error('strict matrix verification receipt is missing or was not emitted by the production verifier');
  }
  const sourceManifest = fileAuthorityEntry(
    path.resolve(manifestPath),
    path.basename(manifestPath),
  );
  if (
    receipt.sourceManifestPath !== sourceManifest.path
    || receipt.sourceManifestBytes !== sourceManifest.bytes
    || receipt.sourceManifestSha256 !== sourceManifest.sha256
  ) {
    throw new Error('strict matrix verification receipt does not bind the current source manifest bytes');
  }
  const provenanceFailure = exactGitProvenanceFailure(
    receipt.provenance,
    currentProvenance,
    {
      recordedSubject: 'strict verification receipt provenance',
      currentSubject: 'current checkout provenance',
    },
  );
  if (provenanceFailure) throw new Error(provenanceFailure);
  if (
    !sameAuthorityInventory(receipt.implementationHashes, implementationHashes)
    || !sameAuthorityInventory(receipt.paidImplementationHashes, paidImplementationHashes)
    || !sameAuthorityInventory(receipt.runtimeBinaryHashes, runtimeBinaryHashes)
  ) {
    throw new Error('strict matrix verification receipt implementation/paid/runtime authority mismatch');
  }
  assertExactObject(
    receipt.externalProviderBudget,
    manifest.externalProviderBudget,
    'strict matrix verification receipt external provider budget',
  );
  assertExactObject(
    receipt.shardExecution,
    manifest.shardExecution,
    'strict matrix verification receipt shard execution',
  );
  assertExactObject(
    receipt.matrixIntegration,
    manifest.matrixIntegration,
    'strict matrix verification receipt shard matrix integration',
  );
  const expectedCells = manifest.cells.map((cell) => ({
    cellId: cell.cellId,
    tier: cell.tier,
    providerMode: cell.providerMode,
    ...strictPaidCellTimingProjection(cell),
    modelId: cell.modelId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceClass: cell.deviceClass,
    deviceProfileId: cell.deviceProfileId,
    runDirectory: cell.runDirectory,
    receiptPath: cell.receiptPath,
    receiptBytes: cell.receiptBytes,
    receiptSha256: cell.receiptSha256,
    ...(cell.shardAuthority ? { shardAuthority: cell.shardAuthority } : {}),
  }));
  assertExactObject(receipt.cells, expectedCells, 'strict matrix verification receipt cells');
  return { receiptPath: resolvedReceiptPath, receipt };
}

export const REQUIRED_LAYERS = [
  'driver',
  'wasapi',
  'bridge',
  'physicalOutput',
  'physicalOutputContent',
  'speechSegmentation',
  'strictContent',
  'app',
  'provider',
];

export const BASE_REQUIRED_LAYERS = REQUIRED_LAYERS.filter((layer) => layer !== 'strictContent');

export const ECHO_CANCEL_REQUIRED_LAYERS = [
  'aec',
  'app',
  'provider',
];

export const PROCESS_EXCLUSION_REQUIRED_LAYERS = REQUIRED_LAYERS.filter(
  (layer) => !['driver', 'wasapi'].includes(layer),
);

const DEFAULT_ROOT = 'artifacts/testing/watch-mode-live';
const DEFAULT_STRICT_MODELS = RELEASE_MODELS;
export const DEFAULT_STRICT_DEVICE_CLASSES = RELEASE_DEVICE_CLASSES;
const EXCLUDED_DIRECTORY_PATTERNS = [
  /^cache$/i,
  /^physical-output-smoke-/i,
  /^reference-pcm-smoke-/i,
];
const INVALID_CANDIDATE_PRINT_LIMIT = 12;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

export function normalizeRunDirectories(value, { baseDirectory = process.cwd() } = {}) {
  let entries = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    entries = Array.isArray(parsed) ? parsed : parsed?.runDirectories;
  }
  if (!Array.isArray(entries)) {
    throw new Error('runDirectories must be a JSON array or an object containing runDirectories');
  }
  return entries.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`runDirectories[${index}] must be a non-empty path string`);
    }
    return path.resolve(baseDirectory, entry.trim());
  });
}

export function readRunManifest(manifestPath, { baseDirectory = process.cwd() } = {}) {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) {
    throw new Error('--run-manifest requires a non-empty file path');
  }
  const resolvedManifestPath = path.resolve(baseDirectory, manifestPath.trim());
  if (!fs.existsSync(resolvedManifestPath)) {
    throw new Error(`run manifest does not exist: ${resolvedManifestPath}; complete the strict live matrix first`);
  }
  const manifest = readJson(resolvedManifestPath);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`run manifest must contain a JSON object: ${resolvedManifestPath}`);
  }
  if (
    manifest.artifactKind === 'watch-mode-non-authoritative-smoke'
    || manifest.smokeOnly === true
  ) {
    throw new Error(`smoke manifest is non-authoritative and cannot be used as Watch Mode evidence: ${resolvedManifestPath}`);
  }
  if (![1, STRICT_MATRIX_SCHEMA_VERSION].includes(manifest.schemaVersion)) {
    throw new Error(`unsupported run manifest schemaVersion=${manifest.schemaVersion ?? 'missing'}: ${resolvedManifestPath}`);
  }
  const runDirectories = normalizeRunDirectories(manifest.runDirectories, {
    baseDirectory: path.dirname(resolvedManifestPath),
  });
  if (runDirectories.length === 0) {
    throw new Error(`run manifest has no runDirectories: ${resolvedManifestPath}`);
  }
  return { manifestPath: resolvedManifestPath, manifest, runDirectories };
}

function reportAuthorityProjection(report) {
  if (!report || typeof report !== 'object') return report;
  const {
    generatedAt: _generatedAt,
    commit: _commit,
    provenance: _provenance,
    artifacts: _artifacts,
    ...stable
  } = report;
  return stable;
}

function assertExactObject(left, right, label) {
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new Error(`${label} does not match the independently rebuilt raw evidence`);
  }
}

function assertCellIdentity(receiptCell, manifestCell, report, index) {
  assertExactObject(receiptCell, {
    cellId: manifestCell.cellId,
    tier: manifestCell.tier,
    providerMode: manifestCell.providerMode,
    ...strictPaidCellTimingProjection(manifestCell),
    modelId: manifestCell.modelId,
    modelProtocolProfileIdentity: manifestCell.modelProtocolProfileIdentity,
    feedbackLoopPrevention: manifestCell.feedbackLoopPrevention,
    deviceClass: manifestCell.deviceClass,
    deviceProfileId: manifestCell.deviceProfileId,
  }, `strict matrix cell ${index} receipt identity`);
  if (report.modelId !== manifestCell.modelId) {
    throw new Error(`strict matrix cell ${index} model mismatch: expected ${manifestCell.modelId}; raw report has ${report.modelId ?? 'missing'}`);
  }
  if (report.feedbackLoopPrevention !== manifestCell.feedbackLoopPrevention) {
    throw new Error(`strict matrix cell ${index} route mismatch: expected ${manifestCell.feedbackLoopPrevention}; raw report has ${report.feedbackLoopPrevention ?? 'missing'}`);
  }
  if (report.deviceEvidence?.deviceClass !== manifestCell.deviceClass) {
    throw new Error(`strict matrix cell ${index} device class mismatch: expected ${manifestCell.deviceClass}; raw report has ${report.deviceEvidence?.deviceClass ?? 'missing'}`);
  }
  if (report.deviceEvidence?.profileId !== manifestCell.deviceProfileId) {
    throw new Error(`strict matrix cell ${index} device profile mismatch: expected ${manifestCell.deviceProfileId}; raw report has ${report.deviceEvidence?.profileId ?? 'missing'}`);
  }
}

function assertVirtualDriverBinaryAuthority(runDirectory, runtimeBinaryHashes, index) {
  const driver = readJson(path.join(runDirectory, 'driver.json'));
  const authority = driver.InstalledDriverAuthority ?? driver.installedDriverAuthority;
  if (!authority || typeof authority !== 'object') {
    throw new Error(`strict matrix cell ${index} virtual-driver evidence is missing InstalledDriverAuthority`);
  }
  const packageSys = runtimeBinaryHashes.find(
    (entry) => entry.path === 'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
  );
  const packageCat = runtimeBinaryHashes.find(
    (entry) => entry.path === 'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat',
  );
  const packageInf = runtimeBinaryHashes.find(
    (entry) => entry.path === 'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf',
  );
  if (!packageSys || !packageCat || !packageInf) {
    throw new Error(`strict matrix cell ${index} runtime authority is missing the current-HEAD driver SYS/CAT/INF`);
  }
  const installedHash = String(authority.installedSysSha256 ?? '').toLowerCase();
  const packageHash = String(authority.packageSysSha256 ?? '').toLowerCase();
  if (!installedHash || installedHash !== packageHash || packageHash !== packageSys.sha256) {
    throw new Error(`strict matrix cell ${index} installed driver SYS does not match the current-HEAD package`);
  }
  if (
    String(authority.packageCatSha256 ?? '').toLowerCase() !== packageCat.sha256
    || String(authority.packageInfSha256 ?? '').toLowerCase() !== packageInf.sha256
  ) {
    throw new Error(`strict matrix cell ${index} driver CAT/INF identity does not match the current-HEAD package`);
  }
  if (!authority.installedSysPath || !authority.installedInfName || !authority.installedDriverVersion) {
    throw new Error(`strict matrix cell ${index} installed driver identity is incomplete`);
  }
  if (String(authority.installedServiceState ?? '').toLowerCase() !== 'running') {
    throw new Error(`strict matrix cell ${index} installed driver service is not running`);
  }
  if (
    String(authority.installedSysSignatureStatus ?? '').toLowerCase() !== 'valid'
    || String(authority.packageCatalogSignatureStatus ?? '').toLowerCase() !== 'valid'
    || !authority.installedSysSignerThumbprint
    || !authority.packageCatalogSignerThumbprint
    || String(authority.installedSysSignerThumbprint).toLowerCase()
      !== String(authority.packageCatalogSignerThumbprint).toLowerCase()
  ) {
    throw new Error(`strict matrix cell ${index} installed driver/package signature identity is missing or invalid`);
  }
}

function assertRawMediaAuthority(runDirectory, implementationHashes, cell, index, workspaceRoot) {
  const playback = readJson(path.join(runDirectory, 'playback.json'));
  const canonicalMedia = implementationHashes.find(
    (entry) => entry.path === 'scripts/testing/fixtures/watch-mode-en-original.wav',
  );
  if (!canonicalMedia || playback.mediaSha256 !== canonicalMedia.sha256) {
    throw new Error(`strict matrix cell ${index} playback media hash is not the canonical Watch reference WAV`);
  }
  const playbackStartedAtMs = Number(playback.startedAtMs);
  const playbackFinishedAtMs = Number(playback.finishedAtMs);
  if (
    playback.playbackMode !== 'wasapi-media-injector'
    || Number(playback.sourceGainDb) !== -5
    || Number(playback.postrollSilenceSeconds) !== 3
    || !Number.isInteger(Number(playback.postrollSilenceFrames))
    || Number(playback.postrollSilenceFrames) <= 0
    || !Number.isInteger(Number(playback.injectorProcessId))
    || Number(playback.injectorProcessId) <= 0
    || !Number.isFinite(playbackStartedAtMs)
    || !Number.isFinite(playbackFinishedAtMs)
    || playbackFinishedAtMs <= playbackStartedAtMs
  ) {
    throw new Error(`strict matrix cell ${index} playback.json is not a completed production media-injector timeline`);
  }
  const restartQuietWindowExpected = cell.feedbackLoopPrevention === 'process-exclusion';
  const renderSampleRateHz = Number(playback.renderSampleRateHz);
  if (
    !Number.isInteger(renderSampleRateHz)
    || renderSampleRateHz <= 0
    ||
    (restartQuietWindowExpected && (
      Number(playback.restartQuietWindowAfterSeconds) !== 90
      || Number(playback.restartQuietWindowSeconds) !== 45
      || !Number.isInteger(Number(playback.restartQuietWindowFrames))
      || Number(playback.restartQuietWindowFrames) !== 45 * renderSampleRateHz
    ))
    || (!restartQuietWindowExpected && (
      Number(playback.restartQuietWindowAfterSeconds ?? 0) !== 0
      || Number(playback.restartQuietWindowFrames ?? 0) !== 0
      || Number(playback.restartQuietWindowSeconds ?? 0) !== 0
    ))
  ) {
    throw new Error(`strict matrix cell ${index} media-injector restart quiet-window authority is invalid`);
  }
  const referencePcmBytes = fs.statSync(path.join(runDirectory, 'source-media-reference-16k-mono.pcm')).size;
  const providerInputBytes = fs.statSync(path.join(runDirectory, 'provider-input-16k-mono.pcm')).size;
  const canonicalReferenceBytes = loadCanonicalFixtureAuthority({ workspaceRoot }).referencePcm.bytes;
  const expectedReferenceBytes = canonicalReferenceBytes
    + (restartQuietWindowExpected ? 45 * 16_000 * 2 : 0);
  if (referencePcmBytes !== expectedReferenceBytes || referencePcmBytes % 2 !== 0) {
    throw new Error(`strict matrix cell ${index} source reference PCM does not have the exact canonical quiet-window duration`);
  }
  if (providerInputBytes < referencePcmBytes || providerInputBytes % 2 !== 0) {
    throw new Error(`strict matrix cell ${index} provider input PCM does not contain the complete reference-media duration`);
  }
  const renderedSeconds = Number(playback.renderedSeconds);
  if (Number.isFinite(renderedSeconds)) {
    const referenceSeconds = referencePcmBytes / (16_000 * 2);
    if (Math.abs(referenceSeconds - renderedSeconds) > 1) {
      throw new Error(`strict matrix cell ${index} source reference PCM duration does not match media-injector renderedSeconds`);
    }
  }
  const device = readJson(path.join(runDirectory, 'physical-playback-device.json'));
  if (device.deviceClass !== cell.deviceClass || device.profileId !== cell.deviceProfileId) {
    throw new Error(`strict matrix cell ${index} raw physical device identity does not match the requested matrix cell`);
  }
  if (cell.feedbackLoopPrevention !== 'echo-cancel') {
    const probe = readJson(path.join(runDirectory, 'physical-output-probe.json'));
    const resolvedProbeId = probe.resolvedPhysicalPlaybackDeviceId
      ?? probe.resolved_physical_playback_device_id;
    if (!resolvedProbeId || resolvedProbeId !== device.resolvedDeviceId) {
      throw new Error(`strict matrix cell ${index} physical-output probe endpoint does not match physical-playback-device.json`);
    }
  }
}

function assertSystemMetricsAuthority(
  runDirectory,
  index,
  terminalAuthority,
) {
  const steps = readWatchModeRunCollection(runDirectory).collection.steps;
  const desktopStep = Array.isArray(steps)
    ? steps.find((step) => step?.id === 'start-desktop-shell')
    : null;
  const desktopProcessId = Number(desktopStep?.data?.pid);
  const samplerRootProcessId = Number(desktopStep?.data?.systemMetricsSampler?.rootProcessId);
  if (
    desktopStep?.status !== 'passed'
    || !Number.isInteger(desktopProcessId)
    || desktopProcessId <= 0
    || samplerRootProcessId !== desktopProcessId
  ) {
    throw new Error(`strict matrix cell ${index} run collection does not bind the production Desktop launch PID to its metrics sampler`);
  }

  const metrics = readJson(path.join(runDirectory, 'system-metrics.json'));
  const samples = Array.isArray(metrics.samples) ? metrics.samples : [];
  const startedAtMs = Date.parse(metrics.startedAt ?? '');
  const finishedAtMs = Date.parse(metrics.finishedAt ?? '');
  const mediaPlaybackCompletedAtMs = Number(
    terminalAuthority?.marker?.mediaPlaybackCompletedAtUnixMs,
  );
  const reportWrittenAtMs = Number(
    terminalAuthority?.terminal?.events?.find((event) => event?.stage === 'reportWritten')
      ?.observedAtUnixMs,
  );
  if (
    metrics.artifactKind !== 'watch-mode-system-metrics'
    || metrics.collector !== 'scripts/testing/collect-watch-mode-system-metrics.ps1'
    || metrics.scope !== 'process-tree'
    || metrics.completionReason !== 'root-process-exited'
    || Number(metrics.rootProcessId) !== desktopProcessId
    || Number(metrics.sampleCount) !== samples.length
    || samples.length < 2
    || !Array.isArray(metrics.collectionErrors)
    || metrics.collectionErrors.length !== 0
    || !Number.isFinite(startedAtMs)
    || !Number.isFinite(finishedAtMs)
    || !Number.isSafeInteger(mediaPlaybackCompletedAtMs)
    || !Number.isSafeInteger(reportWrittenAtMs)
    || startedAtMs > mediaPlaybackCompletedAtMs
    || finishedAtMs < reportWrittenAtMs
  ) {
    throw new Error(
      `strict matrix cell ${index} system metrics do not prove the complete production Desktop process-tree lifetime `
      + `(started=${startedAtMs} mediaCompleted=${mediaPlaybackCompletedAtMs} `
      + `finished=${finishedAtMs} reportWritten=${reportWrittenAtMs} samples=${samples.length})`,
    );
  }

  let previousElapsedMs = -1;
  let previousTimestampMs = startedAtMs - 1;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex];
    const elapsedMs = Number(sample?.elapsedMs);
    const timestampMs = Date.parse(sample?.timestamp ?? '');
    const processIds = Array.isArray(sample?.processIds) ? sample.processIds.map(Number) : [];
    const processNamesById = sample?.processNamesById ?? {};
    const bridgeProcessIds = Array.isArray(sample?.bridgeProcessIds)
      ? sample.bridgeProcessIds.map(Number)
      : [];
    const desktopProcessName = String(
      processNamesById[String(desktopProcessId)]
        ?? processNamesById[desktopProcessId]
        ?? '',
    ).toLowerCase();
    if (
      !Number.isFinite(elapsedMs)
      || elapsedMs <= previousElapsedMs
      || !Number.isFinite(timestampMs)
      || timestampMs <= previousTimestampMs
      || !processIds.includes(desktopProcessId)
      || desktopProcessName !== 'omni-desktop-shell'
      || Number(sample.processCount) !== processIds.length
      || !Number.isFinite(Number(sample.workingSetMb))
      || Number(sample.workingSetMb) <= 0
      || !Number.isFinite(Number(sample.cpuPercent))
      || Number(sample.cpuPercent) < 0
      || bridgeProcessIds.some((processId) => (
        !processIds.includes(processId)
        || String(processNamesById[String(processId)] ?? '').toLowerCase() !== 'omni-bridge-service'
      ))
    ) {
      throw new Error(`strict matrix cell ${index} system metrics sample ${sampleIndex} is not a valid production Desktop process-tree snapshot`);
    }
    previousElapsedMs = elapsedMs;
    previousTimestampMs = timestampMs;
  }
  const firstSampleAtMs = Date.parse(samples[0]?.timestamp ?? '');
  if (firstSampleAtMs > mediaPlaybackCompletedAtMs + 15_000
    || previousTimestampMs < reportWrittenAtMs - 15_000) {
    throw new Error(`strict matrix cell ${index} system metrics samples do not cover media completion through terminal report authority`);
  }
}

function readPcm16Wav(filePath, frequencies = []) {
  const profile = frequencies.length > 0 ? 'fingerprint-components-v1' : 'watch-physical-output/v1';
  const metrics = analyzeAudioWithRust({ inputPath: filePath, format: 'wav', profile, frequencies });
  return {
    sampleRate: metrics.sampleRateHz,
    frames: metrics.sampleCount,
    durationSeconds: metrics.durationSeconds,
    rms: metrics.rms,
    peak: metrics.peak,
    components: Object.fromEntries((metrics.components ?? []).map((entry) => [entry.frequencyHz, entry.amplitude])),
  };
}

function assertPhysicalRecordingAuthority(runDirectory, index) {
  const wav = readPcm16Wav(path.join(runDirectory, 'physical-output-recording.wav'));
  if (wav.durationSeconds < 60 || wav.rms <= 0.0001 || wav.peak <= 0.001) {
    throw new Error(`strict matrix cell ${index} physical-output WAV is too short or silent`);
  }
  const recording = readJson(path.join(runDirectory, 'physical-output-recording.json'));
  const rawContent = readJson(path.join(runDirectory, 'physical-output-content.raw.json'));
  const content = derivePhysicalOutputContent(rawContent);
  if (recording.passed !== true || content.passed !== true) {
    throw new Error(`strict matrix cell ${index} physical-output recording/content raw evidence did not pass`);
  }
  const capturedFrames = Number(recording.capturedFrames);
  const timelineOutputFrames = Number(recording.captureTimeline?.outputFrameCount);
  if (
    !Number.isSafeInteger(wav.frames)
    || !Number.isSafeInteger(capturedFrames)
    || !Number.isSafeInteger(timelineOutputFrames)
    || wav.frames !== capturedFrames
    || capturedFrames !== timelineOutputFrames
  ) {
    throw new Error(
      `strict matrix cell ${index} physical-output WAV, recording, and capture timeline frame counts must match exactly`,
    );
  }
}

function assertProcessExclusionAudioAuthority(runDirectory, index) {
  const probe = readJson(path.join(runDirectory, 'physical-output-probe.json'));
  const evidence = probe.processExclusionFingerprint ?? probe.process_exclusion_fingerprint;
  if (!evidence || typeof evidence !== 'object') {
    throw new Error(`strict matrix cell ${index} process-exclusion fingerprint evidence is missing`);
  }
  const frequencies = [997, 1_733, 2_449];
  const physical = readPcm16Wav(
    path.join(runDirectory, 'physical-output-probe-runtime', 'process-exclusion-physical-output.wav'),
    frequencies,
  );
  const source = readPcm16Wav(
    path.join(runDirectory, 'physical-output-probe-runtime', 'process-exclusion-source-pipe.wav'),
    frequencies,
  );
  if (
    physical.sampleRate !== 48_000
    || source.sampleRate !== 48_000
    || physical.durationSeconds < 1
    || source.durationSeconds < 1
  ) {
    throw new Error(`strict matrix cell ${index} process-exclusion fingerprint WAV format/duration is invalid`);
  }
  const translationHz = Number(evidence.translationFrequencyHz ?? evidence.translation_frequency_hz);
  const externalHz = Number(evidence.externalFrequencyHz ?? evidence.external_frequency_hz);
  const childHz = Number(evidence.bridgeChildFrequencyHz ?? evidence.bridge_child_frequency_hz);
  if (translationHz !== 997 || externalHz !== 1_733 || childHz !== 2_449) {
    throw new Error(`strict matrix cell ${index} process-exclusion fingerprint frequencies are not the production 997/1733/2449 Hz triplet`);
  }
  const physicalTranslation = physical.components[translationHz] ?? 0;
  const physicalExternal = physical.components[externalHz] ?? 0;
  const physicalChild = physical.components[childHz] ?? 0;
  const sourceTranslation = source.components[translationHz] ?? 0;
  const sourceExternal = source.components[externalHz] ?? 0;
  const sourceChild = source.components[childHz] ?? 0;
  const leakLimit = Math.max(0.006, Number(evidence.translationComponentLimit ?? 0.003) * 2);
  if (Math.min(physicalTranslation, physicalExternal, physicalChild, sourceExternal) < 0.005) {
    throw new Error(`strict matrix cell ${index} raw fingerprint WAVs do not prove physical translation/external/child playback and source preservation`);
  }
  if (
    sourceTranslation > leakLimit
    || sourceChild > leakLimit
    || sourceTranslation / physicalTranslation > 0.1
    || sourceChild / physicalChild > 0.1
  ) {
    throw new Error(`strict matrix cell ${index} raw source-pipe WAV contains an excluded Bridge/child fingerprint`);
  }
  const bridgePid = Number(evidence.bridgeProcessId ?? evidence.bridge_process_id);
  const excludedPid = Number(evidence.excludedProcessId ?? evidence.excluded_process_id);
  const externalPid = Number(evidence.externalPlayerProcessId ?? evidence.external_player_process_id);
  const childPid = Number(evidence.bridgeChildPlayerProcessId ?? evidence.bridge_child_player_process_id);
  const childParentPid = Number(evidence.bridgeChildParentProcessId ?? evidence.bridge_child_parent_process_id);
  if (
    !Number.isInteger(bridgePid)
    || bridgePid <= 0
    || excludedPid !== bridgePid
    || childParentPid !== bridgePid
    || externalPid === bridgePid
    || childPid === bridgePid
    || externalPid === childPid
  ) {
    throw new Error(`strict matrix cell ${index} process-exclusion raw PID/parent/excluded identity is invalid`);
  }
  if (
    (evidence.captureBackend ?? evidence.capture_backend) !== 'wasapi-process-exclusion'
    || (evidence.sourceCaptureMode ?? evidence.source_capture_mode) !== 'process-exclusion'
    || (evidence.processLoopbackStatus ?? evidence.process_loopback_status) !== 'ready'
  ) {
    throw new Error(`strict matrix cell ${index} process-exclusion raw probe did not stay on the WASAPI exclusion backend`);
  }
}

function assertCanonicalVerificationBinding({
  manifest,
  evidenceRoot,
  currentProvenance,
  implementationHashes,
  paidImplementationHashes,
  runtimeBinaryHashes,
}) {
  if (manifest.verification !== 'passed') return;
  const receiptPath = validateFileAuthorityEntry(
    evidenceRoot,
    {
      path: manifest.verificationReceiptPath,
      bytes: manifest.verificationReceiptBytes,
      sha256: manifest.verificationReceiptSha256,
    },
    manifest.verificationReceiptPath,
    'canonical strict verification receipt',
  );
  validateFileAuthorityEntry(
    evidenceRoot,
    {
      path: manifest.sourceManifest,
      bytes: manifest.sourceManifestBytes,
      sha256: manifest.sourceManifestSha256,
    },
    manifest.sourceManifest,
    'canonical strict source manifest',
  );
  const receipt = readJson(receiptPath);
  if (
    receipt.schemaVersion !== 1
    || receipt.artifactKind !== STRICT_MATRIX_VERIFICATION_ARTIFACT_KIND
    || receipt.verdict !== 'passed'
    || receipt.sourceManifestPath !== manifest.sourceManifest
    || receipt.sourceManifestBytes !== manifest.sourceManifestBytes
    || receipt.sourceManifestSha256 !== manifest.sourceManifestSha256
    || receipt.verifiedAt !== manifest.verifiedAt
  ) {
    throw new Error('canonical strict verification receipt/source-manifest binding is invalid');
  }
  const provenanceFailure = exactGitProvenanceFailure(
    receipt.provenance,
    currentProvenance,
    {
      recordedSubject: 'canonical strict verification receipt provenance',
      currentSubject: 'current checkout provenance',
    },
  );
  if (provenanceFailure) throw new Error(provenanceFailure);
  if (
    !sameAuthorityInventory(receipt.implementationHashes, implementationHashes)
    || !sameAuthorityInventory(receipt.paidImplementationHashes, paidImplementationHashes)
    || !sameAuthorityInventory(receipt.runtimeBinaryHashes, runtimeBinaryHashes)
  ) {
    throw new Error('canonical strict verification receipt implementation/paid/runtime authority mismatch');
  }
  assertExactObject(
    receipt.externalProviderBudget,
    manifest.externalProviderBudget,
    'canonical strict verification receipt external provider budget',
  );
  assertExactObject(
    receipt.shardExecution,
    manifest.shardExecution,
    'canonical strict verification receipt shard execution',
  );
  assertExactObject(
    receipt.matrixIntegration,
    manifest.matrixIntegration,
    'canonical strict verification receipt shard matrix integration',
  );
  const expectedCells = manifest.cells.map((cell) => ({
    cellId: cell.cellId,
    tier: cell.tier,
    providerMode: cell.providerMode,
    ...strictPaidCellTimingProjection(cell),
    modelId: cell.modelId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceClass: cell.deviceClass,
    deviceProfileId: cell.deviceProfileId,
    runDirectory: cell.runDirectory,
    receiptPath: cell.receiptPath,
    receiptBytes: cell.receiptBytes,
    receiptSha256: cell.receiptSha256,
    ...(cell.shardAuthority ? { shardAuthority: cell.shardAuthority } : {}),
  }));
  assertExactObject(receipt.cells, expectedCells, 'canonical strict verification receipt cells');
}

function assertStrictMatrixExternalProviderBudget({
  manifest,
  evidenceRoot,
  releaseCells,
  cellLedgers,
}) {
  if (!manifest.externalProviderBudget || typeof manifest.externalProviderBudget !== 'object') {
    throw new Error('strict authority manifest is missing the external provider budget authority');
  }
  const ledgerPath = validateFileAuthorityEntry(
    evidenceRoot,
    {
      path: manifest.externalProviderBudget.ledgerPath,
      bytes: manifest.externalProviderBudget.ledgerBytes,
      sha256: manifest.externalProviderBudget.ledgerSha256,
    },
    MATRIX_EXTERNAL_PROVIDER_BUDGET_FILE,
    'strict matrix external provider budget ledger',
  );
  let recorded;
  try {
    recorded = assertMatrixExternalProviderBudget(ledgerPath, cellLedgers, {
      expectedCells: releaseCells,
    });
  } catch (error) {
    throw new Error(`strict matrix external provider budget authority failed: ${error.message}`);
  }
  const manifestProjection = { ...manifest.externalProviderBudget };
  delete manifestProjection.ledgerPath;
  delete manifestProjection.ledgerBytes;
  delete manifestProjection.ledgerSha256;
  assertExactObject(
    manifestProjection,
    recorded,
    'strict matrix external provider budget manifest projection',
  );

  const expectedReservedInputSamples = releaseCells.reduce(
    (total, cell) => total + Number(cell.maxExternalAudioSamples),
    0,
  );
  const expectedCellMaxInputSamples = Math.max(
    ...releaseCells.map((cell) => Number(cell.maxExternalAudioSamples)),
  );
  if (
    recorded.passed !== true
    || Number(recorded.matrixInputSampleCeiling) !== expectedReservedInputSamples
    || Number(recorded.cellMaxInputSamples) !== expectedCellMaxInputSamples
    || Number(recorded.cellCount) !== releaseCells.length
    || Number(recorded.reservedInputSamples) !== expectedReservedInputSamples
    || expectedReservedInputSamples > STRICT_PAID_MATRIX_MAX_INPUT_SAMPLES
    || !Number.isInteger(Number(recorded.actualProviderInputSamples))
    || Number(recorded.actualProviderInputSamples) <= 0
    || Number(recorded.actualProviderInputSamples) > expectedReservedInputSamples
    || Number(recorded.auxiliaryExternalAudioSeconds) !== 0
    || !Array.isArray(recorded.violations)
    || recorded.violations.length !== 0
  ) {
    throw new Error(
      `strict matrix external provider budget must bind ${releaseCells.length} ordered cells, `
      + `${expectedReservedInputSamples} reserved samples, and at most `
      + `${expectedReservedInputSamples} actual 16 kHz samples`,
    );
  }
  const expectedCellIds = releaseCells.map((cell) => cell.cellId);
  const recordedCellIds = recorded.cells?.map((cell) => cell.cellId);
  const leaseIds = recorded.cells?.map((cell) => cell.leaseId);
  if (canonicalJson(recordedCellIds) !== canonicalJson(expectedCellIds)) {
    throw new Error('strict matrix external provider budget cell ids/order do not match the release plan');
  }
  if (
    !Array.isArray(leaseIds)
    || leaseIds.length !== releaseCells.length
    || leaseIds.some((leaseId) => typeof leaseId !== 'string' || !leaseId.trim())
    || new Set(leaseIds).size !== releaseCells.length
  ) {
    throw new Error('strict matrix external provider budget requires one unique non-empty Rust leaseId per cell');
  }
  return recorded;
}

export function assertStrictTranslatedPcmLoopbackAuthority({
  runDirectory,
  cell,
  cellExternalProviderBudget,
  index,
  evidenceDrivenTerminal = null,
}) {
  const recordingAuthority = readJson(path.join(runDirectory, 'physical-output-recording.json'));
  const rebuilt = buildTranslatedPcmLoopbackAuthority({
    runDirectory,
    appLogPath: path.join(runDirectory, 'app.log'),
    runMarker: cellExternalProviderBudget.runMarker,
    recordingStartedAtEpochMs: Number(recordingAuthority.recordingStartedAtEpochMs),
    cellId: cell.cellId,
    leaseId: cellExternalProviderBudget.providerSendBoundary?.leaseId,
    modelId: cell.modelId,
    protocol: cellExternalProviderBudget.providerSendBoundary?.protocol,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
  });
  if (rebuilt.passed !== true) {
    throw new Error(
      `strict matrix cell ${index} translated PCM loopback authority failed raw reconstruction: `
      + rebuilt.violations.join('; '),
    );
  }
  const matcherOutput = readJson(path.join(runDirectory, 'translated-pcm-loopback.stdout.json'));
  const physicalAuthority = readJson(path.join(runDirectory, 'physical-output-content.raw.json'));
  assertExactObject(
    matcherOutput,
    rebuilt,
    `strict matrix cell ${index} translated PCM matcher output`,
  );
  assertExactObject(
    physicalAuthority.translatedSpeech?.acousticAuthority,
    rebuilt,
    `strict matrix cell ${index} physical translated PCM acoustic authority`,
  );
  if (evidenceDrivenTerminal) {
    const finalMatch = rebuilt.matches.find(
      (entry) => entry.cueId === rebuilt.finalRequiredCueId && entry.passed === true,
    );
    const finalRendererAck = evidenceDrivenTerminal.terminal.events.find(
      (event) => event.stage === 'finalRendererAck',
    )?.detail;
    const expectedReceiptAuthority = finalMatch?.rendererKind === 'desktop-speaker'
      ? 'speaker-render-completed'
      : 'bridge-translation-status-ack';
    if (!finalMatch
      || finalRendererAck?.cueId !== finalMatch.cueId
      || finalRendererAck?.responseId !== finalMatch.responseId
      || finalRendererAck?.receiptAuthority !== expectedReceiptAuthority
      || (finalMatch.rendererKind === 'desktop-speaker'
        && finalRendererAck?.receiptId !== finalMatch.renderAttemptId)) {
      throw new Error(
        `strict matrix cell ${index} terminal renderer ACK does not bind the final acoustically passed translated cue`,
      );
    }
  }
  return rebuilt;
}

const portableAuthorityPath = (...parts) => parts
  .map((part) => String(part ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''))
  .filter(Boolean)
  .join('/');

function strictAuthorityTimestamp(value, label) {
  const text = String(value ?? '').trim();
  const timestamp = /^unix-ms:\d+$/.test(text)
    ? Number(text.slice('unix-ms:'.length))
    : /^unix:\d+$/.test(text)
      ? Number(text.slice('unix:'.length)) * 1_000
      : Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is missing or invalid`);
  return timestamp;
}

function strictAuthorityTimestampInterval(value, label) {
  const text = String(value ?? '').trim();
  if (/^unix:\d+$/.test(text)) {
    const start = Number(text.slice('unix:'.length)) * 1_000;
    return { start, end: start + 999 };
  }
  const timestamp = strictAuthorityTimestamp(value, label);
  return { start: timestamp, end: timestamp };
}

function strictZeroInputPreflightUsage(value, label) {
  const inputTokens = value?.inputTokens ?? null;
  const outputTokens = value?.outputTokens ?? null;
  const audioSeconds = value?.audioSeconds ?? null;
  if (
    inputTokens != null
    || outputTokens != null
    || (audioSeconds !== null && audioSeconds !== 0)
  ) {
    throw new Error(`${label} must bind no synthetic token counters and null|0 audioSeconds`);
  }
  return { inputTokens, outputTokens, audioSeconds };
}

function assertPhysicalSourceWindowPrefix(runDirectory, canonicalAuthority, index) {
  const recordingPath = path.join(runDirectory, 'physical-output-recording-16k-mono.pcm');
  const sourceWindowPath = path.join(
    runDirectory,
    'physical-output-recording-source-window-16k-mono.pcm',
  );
  const recording = fs.readFileSync(recordingPath);
  const sourceWindow = fs.readFileSync(sourceWindowPath);
  const physicalContent = readJson(path.join(runDirectory, 'physical-output-content.raw.json'));
  const rebuiltWindow = canonicalAuthority?.physicalSourceWaveform?.sourceWindowPcm;
  if (
    sourceWindow.length === 0
    || sourceWindow.length > recording.length
    || !sourceWindow.equals(recording.subarray(0, sourceWindow.length))
    || rebuiltWindow?.path !== 'physical-output-recording-source-window-16k-mono.pcm'
    || Number(rebuiltWindow?.bytes) !== sourceWindow.length
    || physicalContent.sttSourceWindow?.sampleRateHz !== 16_000
    || Number(physicalContent.sttSourceWindow?.bytes) !== sourceWindow.length
    || !path.win32.isAbsolute(String(physicalContent.sttSourceWindow?.path ?? ''))
    || path.win32.basename(String(physicalContent.sttSourceWindow?.path ?? ''))
      !== path.basename(sourceWindowPath)
  ) {
    throw new Error(
      `strict matrix cell ${index} physical source window is not the exact bound prefix of the raw recording PCM`,
    );
  }
}

function resolveStrictAuthorityDirectory(parentDirectory, relativePath, label) {
  const resolved = resolveAuthorityPath(parentDirectory, relativePath, label);
  const normalized = String(relativePath ?? '').replaceAll('\\', '/');
  let cursor = path.resolve(parentDirectory);
  for (const component of normalized.split('/').filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stats;
    try {
      stats = fs.lstatSync(cursor);
    } catch {
      throw new Error(`${label} is missing: ${cursor}`);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`${label} must contain only real, non-symlink directories: ${cursor}`);
    }
  }
  return resolved;
}

function strictRecursiveFileInventory(rootDirectory, label) {
  const root = path.resolve(rootDirectory);
  const rootStats = fs.lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`${label} must be a real non-symlink directory`);
  }
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stats = fs.lstatSync(candidate);
      const relativePath = path.relative(root, candidate).replaceAll('\\', '/');
      if (stats.isSymbolicLink()) {
        throw new Error(`${label} may not contain symlinks: ${relativePath}`);
      }
      if (stats.isDirectory()) visit(candidate);
      else if (stats.isFile()) entries.push(fileAuthorityEntry(candidate, relativePath));
      else throw new Error(`${label} contains an unsupported filesystem entry: ${relativePath}`);
    }
  };
  visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length === 0) throw new Error(`${label} may not be empty`);
  return entries;
}

export function verifyStrictShardProviderPreflightAuthorization({
  plan,
  executionRoot,
  executionRootRelative,
  evidenceRoot,
  workspaceRoot = process.cwd(),
  shardExecution,
  matrixIntegration,
  currentImplementationHashes,
  currentRuntimeBinaryHashes,
  currentShardImplementationHashes,
  validationAt,
}) {
  const authorization = validateProviderPreflightAuthorizationAuthorities({
    root: executionRoot,
    grantAuthority: plan.providerPreflightGrant,
    leaseReservationAuthorities: plan.providerPreflightLeaseReservations,
    authorizationDigest: plan.providerPreflightAuthorization?.authorizationDigest,
    expected: {
      executionId: plan.executionId,
      provenance: plan.provenance,
      authorityImplementationHashes: currentImplementationHashes,
      runtimeBinaryHashes: currentRuntimeBinaryHashes,
      shardOrchestrationImplementationHashes: currentShardImplementationHashes,
    },
  });
  const { grant, leaseReservations, consumption } = authorization;
  const claimAuthority = plan.providerPreflightAuthorization?.consumptionClaim;
  const claimPath = validateFileAuthorityEntry(
    executionRoot,
    claimAuthority,
    PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
    'strict shard provider preflight consumption claim',
  );
  const claim = readJson(claimPath);
  const expectedClaimKeys = [
    'artifactKind',
    'authorizationDigest',
    'claimedAt',
    'coordinatorKeyId',
    'desktopExecutableBytes',
    'desktopExecutablePath',
    'desktopExecutableRelativePath',
    'desktopExecutableSha256',
    'desktopProcessId',
    'executionId',
    'grantDigest',
    'retryPolicy',
    'schemaVersion',
  ].sort();
  if (canonicalJson(Object.keys(claim).sort()) !== canonicalJson(expectedClaimKeys)) {
    throw new Error('strict shard provider preflight consumption claim has unexpected or missing fields');
  }
  const expectedDesktopPath = path.resolve(
    workspaceRoot,
    ...PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE.split('/'),
  );
  const recordedDesktop = currentRuntimeBinaryHashes.find(
    (entry) => entry.path === PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE,
  );
  const latestReservationAtMs = Math.max(...leaseReservations.map((entry) => (
    strictAuthorityTimestamp(
      entry.issuedAt,
      'strict shard provider preflight reservation issuedAt',
    )
  )));
  const claimAtMs = strictAuthorityTimestamp(
    claim.claimedAt,
    'strict shard provider preflight consumption claim claimedAt',
  );
  if (
    claim.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || claim.artifactKind !== PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_KIND
    || claim.executionId !== plan.executionId
    || claim.grantDigest !== grant.digest
    || claim.authorizationDigest !== authorization.authorizationDigest
    || claim.coordinatorKeyId !== grant.signature?.keyId
    || claimAtMs <= latestReservationAtMs
    || !Number.isInteger(Number(claim.desktopProcessId))
    || Number(claim.desktopProcessId) <= 0
    || claim.desktopExecutableRelativePath !== PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE
    || !path.isAbsolute(String(claim.desktopExecutablePath ?? ''))
    || path.resolve(String(claim.desktopExecutablePath)) !== expectedDesktopPath
    || Number(claim.desktopExecutableBytes) !== Number(recordedDesktop?.bytes)
    || claim.desktopExecutableSha256 !== recordedDesktop?.sha256
    || claim.retryPolicy !== 'new-execution-required'
  ) {
    throw new Error('strict shard provider preflight consumption claim does not bind the signed authorization/runtime');
  }
  const claimProjection = {
    ...claim,
    ...fileAuthorityEntry(claimPath, PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE),
  };
  assertExactObject(
    claimAuthority,
    claimProjection,
    'strict shard signed-plan provider preflight consumption claim',
  );
  const expectedPlanAuthorization = {
    grantDigest: grant.digest,
    leaseReservationDigests: leaseReservations.map((entry) => entry.digest),
    authorizationDigest: authorization.authorizationDigest,
    inputMode: consumption.inputMode,
    providerInputMode: consumption.providerInputMode,
    responseMode: consumption.responseMode,
    terminalEvent: consumption.terminalEvent,
    lifecycleBudget: structuredClone(consumption.lifecycleBudget),
    modelProtocolProfileIdentity: structuredClone(
      consumption.modelProtocolProfileIdentity,
    ),
    consumptionClaim: claimProjection,
  };
  assertExactObject(
    plan.providerPreflightAuthorization,
    expectedPlanAuthorization,
    'strict shard signed-plan provider preflight authorization',
  );
  if (
    canonicalJson(grant.localIsolationAuthority) !== canonicalJson(plan.localIsolationAuthority)
    || canonicalJson(grant.workerReadinessRequest) !== canonicalJson(plan.workerReadinessRequest)
  ) {
    throw new Error('strict shard provider preflight grant does not bind the signed plan prerequisites');
  }
  const expectedGrantWorkers = plan.workers.map((worker) => ({
    workerId: worker.workerId,
    ...(String(worker.interactiveUser ?? '').trim()
      ? { interactiveUser: String(worker.interactiveUser).trim() }
      : {}),
    vmIdentity: worker.vmIdentity,
    vmIdentityDigest: worker.vmIdentityDigest,
    deviceProfileInstances: worker.deviceProfileInstances,
  }));
  assertExactObject(
    grant.workers,
    expectedGrantWorkers,
    'strict shard provider preflight grant workers',
  );
  const expectedGrantCells = plan.cells.map((cell) => ({
    cellIndex: cell.cellIndex,
    cellId: cell.cellId,
    providerId: PROVIDER_PREFLIGHT_PROVIDER_ID,
    modelId: cell.modelId,
    protocol: STRICT_PAID_MODEL_PROTOCOLS[cell.modelId],
    modelProtocolProfileIdentity: structuredClone(cell.modelProtocolProfileIdentity),
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceClass: cell.deviceClass,
    workerId: cell.workerId,
    waveIndex: cell.waveIndex,
    deviceProfileInstanceId: cell.deviceProfileInstance.instanceId,
    leaseId: cell.leaseId,
    maxExternalAudioSamples: cell.maxExternalAudioSamples,
  }));
  assertExactObject(
    grant.cells,
    expectedGrantCells,
    'strict shard provider preflight grant paid cells',
  );

  const requestPath = validateFileAuthorityEntry(
    executionRoot,
    grant.workerReadinessRequestAuthority,
    'worker-readiness-request.json',
    'strict shard preflight worker readiness request',
  );
  const request = readJson(requestPath);
  validateWorkerReadinessRequest(request, {
    executionId: plan.executionId,
    provenance: plan.provenance,
    runtimeBinaryHashes: currentRuntimeBinaryHashes,
    workers: plan.workers,
    assignments: plan.cells,
  });
  assertExactObject(
    request,
    plan.workerReadinessRequest,
    'strict shard staged worker readiness request',
  );
  const grantGeneratedAtMs = strictAuthorityTimestamp(
    grant.generatedAt,
    'strict shard provider preflight grant generatedAt',
  );
  resolveStrictAuthorityDirectory(
    executionRoot,
    'worker-readiness',
    'strict shard staged worker readiness directory',
  );
  const stagedWorkerReadiness = [];
  for (let index = 0; index < plan.workers.length; index += 1) {
    const worker = plan.workers[index];
    const recorded = grant.workerReadinessAuthorities[index];
    const expectedInternalPath = `worker-readiness/${worker.workerId}.json`;
    const readinessPath = validateFileAuthorityEntry(
      executionRoot,
      recorded,
      expectedInternalPath,
      `strict shard preflight worker ${worker.workerId} readiness`,
    );
    const validated = validateWorkerZeroProviderReadinessAuthority({
      receiptPath: readinessPath,
      plan,
      workerId: worker.workerId,
      now: validationAt,
      authorityPath: expectedInternalPath,
    });
    if (
      recorded.workerId !== worker.workerId
      || Number(recorded.providerCalls) !== 0
      || recorded.driverRequired !== Boolean(
        plan.workerReadinessRequest.workers[index].driverRequired,
      )
      || validated.receipt.credentialStatus?.blobNonEmpty !== true
      || !Number.isInteger(
        validated.receipt.credentialStatus?.credentialBlobBytes,
      )
      || Number(validated.receipt.credentialStatus?.credentialBlobBytes) <= 0
      || Number(validated.receipt.credentialStatus?.credentialBlobBytes) > 2_560
      || strictAuthorityTimestamp(
        validated.receipt.generatedAt,
        `strict shard worker ${worker.workerId} readiness generatedAt`,
      ) >= grantGeneratedAtMs
    ) {
      throw new Error(`strict shard worker ${worker.workerId} readiness was not completed before the paid grant`);
    }
    stagedWorkerReadiness.push({
      ...recorded,
      ...fileAuthorityEntry(
        readinessPath,
        portableAuthorityPath(executionRootRelative, expectedInternalPath),
      ),
    });
  }

  const completionPath = validateFileAuthorityEntry(
    executionRoot,
    plan.providerPreflightCompletion,
    PROVIDER_PREFLIGHT_COMPLETION_FILE,
    'strict shard provider preflight completion',
  );
  const completion = readJson(completionPath);
  verifyProviderPreflightCompletion(completion, grant, leaseReservations);
  assertExactObject(
    completion.consumptionClaim,
    claimProjection,
    'strict shard provider preflight completion consumption claim',
  );
  if (canonicalJson(completion.preflightAuthority) !== canonicalJson(plan.providerPreflightAuthority)) {
    throw new Error('strict shard provider preflight completion does not bind the exact staged receipt authority');
  }
  const completionGeneratedAtMs = strictAuthorityTimestamp(
    completion.generatedAt,
    'strict shard provider preflight completion generatedAt',
  );
  const planGeneratedAtMs = strictAuthorityTimestamp(
    plan.generatedAt,
    'strict shard signed plan generatedAt',
  );
  if (completionGeneratedAtMs >= planGeneratedAtMs) {
    throw new Error('strict shard signed plan was not generated after provider preflight completion');
  }

  const stagedGrantPath = path.join(executionRoot, PROVIDER_PREFLIGHT_GRANT_FILE);
  assertExactObject(
    plan.providerPreflightGrant,
    {
      ...fileAuthorityEntry(stagedGrantPath, PROVIDER_PREFLIGHT_GRANT_FILE),
      digest: grant.digest,
    },
    'strict shard signed-plan provider preflight grant authority',
  );
  assertExactObject(
    plan.providerPreflightLeaseReservations,
    authorization.leaseReservationAuthorities,
    'strict shard signed-plan provider preflight reservation authorities',
  );
  assertExactObject(
    plan.providerPreflightCompletion,
    {
      ...fileAuthorityEntry(completionPath, PROVIDER_PREFLIGHT_COMPLETION_FILE),
      digest: completion.digest,
      grantDigest: completion.grantDigest,
      authorizationDigest: completion.authorizationDigest,
      inputMode: completion.preflightAuthority.inputMode,
      providerInputMode: completion.preflightAuthority.providerInputMode,
      responseMode: completion.preflightAuthority.responseMode,
      terminalEvent: completion.preflightAuthority.terminalEvent,
      lifecycleBudget: structuredClone(completion.preflightAuthority.lifecycleBudget),
      modelProtocolProfileIdentity: structuredClone(
        completion.modelProtocolProfileIdentity,
      ),
      evidenceOutcome: completion.preflightAuthority.evidenceOutcome,
      firstServerEvent: structuredClone(completion.preflightAuthority.firstServerEvent),
      sessionAuthority: structuredClone(completion.preflightAuthority.sessionAuthority),
      rawTrace: structuredClone(completion.preflightAuthority.rawTrace),
      audioSeconds: completion.preflightAuthority.audioSeconds,
      consumptionClaim: claimProjection,
    },
    'strict shard signed-plan provider preflight completion authority',
  );
  const stagedGrant = {
    ...fileAuthorityEntry(
      stagedGrantPath,
      portableAuthorityPath(executionRootRelative, PROVIDER_PREFLIGHT_GRANT_FILE),
    ),
    digest: grant.digest,
  };
  const stagedReservations = leaseReservations.map((reservation, index) => {
    const fileName = providerPreflightReservationFileName(reservation, index);
    const reservationPath = path.join(
      executionRoot,
      PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
      fileName,
    );
    return {
      cellId: reservation.cellId,
      leaseId: reservation.leaseId,
      digest: reservation.digest,
      modelProtocolProfileIdentity: structuredClone(
        reservation.modelProtocolProfileIdentity,
      ),
      ...fileAuthorityEntry(
        reservationPath,
        portableAuthorityPath(
          executionRootRelative,
          PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
          fileName,
        ),
      ),
    };
  });
  const stagedCompletion = {
    ...fileAuthorityEntry(
      completionPath,
      portableAuthorityPath(executionRootRelative, PROVIDER_PREFLIGHT_COMPLETION_FILE),
    ),
    digest: completion.digest,
    grantDigest: completion.grantDigest,
    authorizationDigest: completion.authorizationDigest,
    inputMode: completion.preflightAuthority.inputMode,
    providerInputMode: completion.preflightAuthority.providerInputMode,
    responseMode: completion.preflightAuthority.responseMode,
    terminalEvent: completion.preflightAuthority.terminalEvent,
    lifecycleBudget: structuredClone(completion.preflightAuthority.lifecycleBudget),
    modelProtocolProfileIdentity: structuredClone(
      completion.modelProtocolProfileIdentity,
    ),
    evidenceOutcome: completion.preflightAuthority.evidenceOutcome,
    firstServerEvent: structuredClone(completion.preflightAuthority.firstServerEvent),
    sessionAuthority: structuredClone(completion.preflightAuthority.sessionAuthority),
    rawTrace: structuredClone(completion.preflightAuthority.rawTrace),
    audioSeconds: completion.preflightAuthority.audioSeconds,
    consumptionClaim: {
      ...claim,
      ...fileAuthorityEntry(
        claimPath,
        portableAuthorityPath(
          executionRootRelative,
          PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
        ),
      ),
    },
  };
  const stagedAuthorization = {
    ...expectedPlanAuthorization,
    consumptionClaim: stagedCompletion.consumptionClaim,
  };
  const stagedRequest = fileAuthorityEntry(
    requestPath,
    portableAuthorityPath(executionRootRelative, 'worker-readiness-request.json'),
  );
  const expectedProjection = {
    providerPreflightGrant: stagedGrant,
    providerPreflightLeaseReservations: stagedReservations,
    providerPreflightAuthorization: stagedAuthorization,
    providerPreflightCompletion: stagedCompletion,
    workerReadinessRequest: stagedRequest,
    workerReadiness: stagedWorkerReadiness,
  };
  for (const [key, value] of Object.entries(expectedProjection)) {
    assertExactObject(
      shardExecution?.[key],
      value,
      `strict shard execution ${key}`,
    );
    assertExactObject(
      matrixIntegration?.[key],
      value,
      `strict shard matrixIntegration ${key}`,
    );
  }
  return {
    ...authorization,
    completion,
    consumption,
    claim,
    claimProjection,
    stagedClaimProjection: stagedCompletion.consumptionClaim,
    projection: expectedProjection,
  };
}

export function verifyStrictShardProviderPreflightAuthority({
  plan,
  executionRoot,
  executionRootRelative,
  evidenceRoot,
  currentProvenance,
  workspaceRoot,
  validationAt,
  authorization,
  validateEvidence = validateProviderPreflightRawAuthority,
}) {
  if (typeof validateEvidence !== 'function') {
    throw new Error('strict shard provider preflight requires an independent raw evidence validator');
  }
  const validatedConsumption = authorization?.consumption;
  const expectedClaim = authorization?.claimProjection;
  if (!validatedConsumption || !expectedClaim) {
    throw new Error('strict shard provider preflight is missing its validated signed authorization');
  }
  const expectedAuthorization = {
    ...validatedConsumption,
    consumptionClaim: expectedClaim,
  };
  const expectedReceiptPath = portableAuthorityPath(
    executionRootRelative,
    COORDINATOR_PROVIDER_PREFLIGHT_FILE,
  );
  const receiptPath = validateFileAuthorityEntry(
    evidenceRoot,
    {
      ...plan.providerPreflightAuthority,
      path: expectedReceiptPath,
    },
    expectedReceiptPath,
    'strict shard single provider preflight receipt',
  );
  const receipt = readJson(receiptPath);
  const inventoryPath = validateFileAuthorityEntry(
    executionRoot,
    receipt.evidenceAuthority,
    COORDINATOR_PROVIDER_PREFLIGHT_INVENTORY_FILE,
    'strict shard provider preflight raw inventory',
  );
  const inventory = readJson(inventoryPath);
  const rawRoot = resolveStrictAuthorityDirectory(
    executionRoot,
    COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT,
    'strict shard provider preflight raw evidence root',
  );
  const rebuiltEntries = strictRecursiveFileInventory(
    rawRoot,
    'strict shard provider preflight raw evidence',
  );
  const rebuiltDigest = sha256Canonical(rebuiltEntries);
  if (
    inventory.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || inventory.artifactKind !== COORDINATOR_PROVIDER_PREFLIGHT_INVENTORY_KIND
    || inventory.executionId !== plan.executionId
    || inventory.scenarioId !== 'E2E-PROVIDER-PROBE'
    || inventory.providerId !== expectedAuthorization.providerId
    || inventory.model !== expectedAuthorization.model
    || inventory.protocol !== expectedAuthorization.protocol
    || Number(inventory.invocationCount) !== expectedAuthorization.invocationCount
    || inventory.operation !== expectedAuthorization.operation
    || inventory.inputMode !== expectedAuthorization.inputMode
    || inventory.providerInputMode !== expectedAuthorization.providerInputMode
    || inventory.responseMode !== expectedAuthorization.responseMode
    || inventory.terminalEvent !== expectedAuthorization.terminalEvent
    || canonicalJson(inventory.lifecycleBudget)
      !== canonicalJson(expectedAuthorization.lifecycleBudget)
    || inventory.evidenceOutcome !== 'livetranslate-session-finished'
    || inventory.firstServerEvent?.type !== 'session.created'
    || canonicalJson(inventory.sessionAuthority)
      !== canonicalJson(plan.providerPreflightAuthority.sessionAuthority)
    || canonicalJson(inventory.rawTrace)
      !== canonicalJson(plan.providerPreflightAuthority.rawTrace)
    || Number(inventory.externalAudioSamples) !== expectedAuthorization.externalAudioSamples
    || inventory.grantDigest !== expectedAuthorization.grantDigest
    || canonicalJson(inventory.leaseReservationDigests)
      !== canonicalJson(expectedAuthorization.leaseReservationDigests)
    || inventory.authorizationDigest !== expectedAuthorization.authorizationDigest
    || canonicalJson(inventory.consumptionClaim) !== canonicalJson(expectedClaim)
    || inventory.tokenBudget != null
    || inventory.inputTokens != null
    || inventory.outputTokens != null
    || inventory.rawEvidenceRoot !== COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT
    || Number(inventory.entryCount) !== rebuiltEntries.length
    || inventory.inventoryDigest !== rebuiltDigest
  ) {
    throw new Error('strict shard provider preflight inventory identity/digest is invalid');
  }
  assertExactObject(
    inventory.entries,
    rebuiltEntries,
    'strict shard provider preflight exact raw inventory',
  );

  const providerProbeResult = readJson(path.join(rawRoot, 'provider-probe-result.json'));
  if (
    receipt.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || receipt.artifactKind !== COORDINATOR_PROVIDER_PREFLIGHT_KIND
    || receipt.executionId !== plan.executionId
    || receipt.scenarioId !== 'E2E-PROVIDER-PROBE'
    || Number(receipt.invocationCount) !== 1
    || receipt.operation !== PROVIDER_PREFLIGHT_OPERATION
    || receipt.inputMode !== PROVIDER_PREFLIGHT_INPUT_MODE
    || receipt.providerInputMode !== PROVIDER_PREFLIGHT_PROVIDER_INPUT_MODE
    || receipt.responseMode !== PROVIDER_PREFLIGHT_RESPONSE_MODE
    || receipt.terminalEvent !== PROVIDER_PREFLIGHT_TERMINAL_EVENT
    || canonicalJson(receipt.lifecycleBudget)
      !== canonicalJson(PROVIDER_PREFLIGHT_LIFECYCLE_BUDGET)
    || receipt.evidenceOutcome !== 'livetranslate-session-finished'
    || receipt.firstServerEvent?.type !== 'session.created'
    || canonicalJson(receipt.sessionAuthority)
      !== canonicalJson(plan.providerPreflightAuthority.sessionAuthority)
    || canonicalJson(receipt.rawTrace)
      !== canonicalJson(plan.providerPreflightAuthority.rawTrace)
    || receipt.status !== 'completed'
    || Number(receipt.externalAudioSamples) !== 0
    || receipt.providerId !== PROVIDER_PREFLIGHT_PROVIDER_ID
    || receipt.providerId !== expectedAuthorization.providerId
    || receipt.model !== PROVIDER_PREFLIGHT_MODEL
    || receipt.model !== expectedAuthorization.model
    || receipt.protocol !== PROVIDER_PREFLIGHT_PROTOCOL
    || receipt.protocol !== expectedAuthorization.protocol
    || receipt.grantDigest !== expectedAuthorization.grantDigest
    || canonicalJson(receipt.leaseReservationDigests)
      !== canonicalJson(expectedAuthorization.leaseReservationDigests)
    || receipt.authorizationDigest !== expectedAuthorization.authorizationDigest
    || canonicalJson(receipt.consumptionClaim) !== canonicalJson(expectedClaim)
    || receipt.tokenBudget != null
    || receipt.inputTokens != null
    || receipt.outputTokens != null
    || receipt.rawEvidenceRoot !== COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT
    || Number(receipt.rawEvidenceCount) !== rebuiltEntries.length
    || receipt.rawEvidenceDigest !== rebuiltDigest
    || providerProbeResult.providerId !== expectedAuthorization.providerId
    || providerProbeResult.model !== expectedAuthorization.model
    || providerProbeResult.protocol !== expectedAuthorization.protocol
    || providerProbeResult.operation !== expectedAuthorization.operation
    || providerProbeResult.inputMode !== expectedAuthorization.inputMode
    || providerProbeResult.providerInputMode !== expectedAuthorization.providerInputMode
    || providerProbeResult.responseMode !== expectedAuthorization.responseMode
    || providerProbeResult.terminalEvent !== expectedAuthorization.terminalEvent
    || Number(providerProbeResult.externalAudioSamples)
      !== expectedAuthorization.externalAudioSamples
    || Number(providerProbeResult.providerInvocationCount)
      !== expectedAuthorization.invocationCount
  ) {
    throw new Error('strict shard provider preflight is not exactly one completed zero-input LiveTranslate lifecycle');
  }

  const emitterResult = readJson(path.join(rawRoot, 'emitter-result.json'));
  const rawProbeResult = providerProbeResult.rawProbeResult;
  const diagnosticsProbeSummary = readJson(path.join(
    rawRoot,
    'diagnostics-bundle',
    'snapshots',
    'extra',
    'provider-probe-summary.json',
  ));
  const diagnosticsConfig = readJson(path.join(
    rawRoot,
    'diagnostics-bundle',
    'snapshots',
    'config.json',
  ));
  const configuredProviders = Array.isArray(diagnosticsConfig?.providers)
    ? diagnosticsConfig.providers.filter((provider) => (
      provider?.providerId === PROVIDER_PREFLIGHT_PROVIDER_ID
      && provider?.templateId === STRICT_PAID_PROVIDER_IDENTITY.templateId
    ))
    : [];
  const configuredProvider = configuredProviders[0];
  const preflightUsages = [
    [providerProbeResult, 'strict shard provider preflight top-level probe'],
    [rawProbeResult, 'strict shard provider preflight raw provider result'],
    [diagnosticsProbeSummary, 'strict shard provider preflight diagnostics summary'],
    [emitterResult, 'strict shard provider preflight emitter'],
  ].map(([value, label]) => strictZeroInputPreflightUsage(value, label));
  if (preflightUsages.some((usage) => (
    canonicalJson(usage) !== canonicalJson(preflightUsages[0])
  ))) {
    throw new Error('strict shard provider preflight token/audio usage differs across raw layers');
  }
  for (const [candidate, label] of [
    [inventory, 'strict shard provider preflight inventory'],
    [receipt, 'strict shard provider preflight receipt'],
  ]) {
    const usage = strictZeroInputPreflightUsage(candidate, label);
    if (canonicalJson(usage) !== canonicalJson(preflightUsages[0])) {
      throw new Error(`${label} token/audio usage does not match the independently rebuilt raw evidence`);
    }
  }
  const authorizationObservedAt = providerProbeResult.preflightAuthorization
    ?.authorizationObservedAt;
  const observedAuthorization = {
    ...expectedAuthorization,
    leaseReservations: authorization.leaseReservations.map((reservation, index) => ({
      cellIndex: index,
      cellId: reservation.cellId,
      workerId: reservation.workerId,
      waveIndex: reservation.waveIndex,
      leaseId: reservation.leaseId,
      maxExternalAudioSamples: reservation.maxExternalAudioSamples,
      digest: reservation.digest,
      issuedAt: reservation.issuedAt,
    })),
    grantGeneratedAt: authorization.grant.generatedAt,
    reservationIssuedAts: authorization.leaseReservations.map((reservation) => (
      reservation.issuedAt
    )),
    authorizationObservedAt,
  };
  const observedConfiguredModel = String(providerProbeResult.configuredModel ?? '').trim();
  const connectStartedAt = providerProbeResult.providerConnectStartedAt;
  const connectCompletedAt = providerProbeResult.providerConnectCompletedAt;
  if (
    !observedConfiguredModel
    || configuredProviders.length !== 1
    || configuredProvider?.model !== observedConfiguredModel
    || configuredProvider?.kind !== STRICT_PAID_PROVIDER_IDENTITY.providerKind
    || configuredProvider?.transport !== 'websocket'
    || configuredProvider?.streamEnabled !== true
    || configuredProvider?.authRef?.kind !== 'credential-ref'
    || configuredProvider?.authRef?.headerName !== 'Authorization'
    || String(configuredProvider?.authRef?.scheme ?? '').toLowerCase() !== 'bearer'
    || !Array.isArray(configuredProvider?.customHeaders)
    || configuredProvider.customHeaders.length !== 0
    || configuredProvider?.systemPromptTemplate !== 'game-live-translation-cn'
    || Number(configuredProvider?.timeoutMs) !== 12_000
    || Number(configuredProvider?.temperature) !== 0.2
    || Number(configuredProvider?.maxOutputTokens) !== 256
    || canonicalJson(configuredProvider?.responseModalities) !== canonicalJson(['text'])
    || configuredProvider?.authRef?.reference
      !== STRICT_PAID_PROVIDER_IDENTITY.credentialReference
    || providerProbeResult.templateId !== STRICT_PAID_PROVIDER_IDENTITY.templateId
    || providerProbeResult.endpointHost !== STRICT_PAID_PROVIDER_IDENTITY.endpointHost
    || providerProbeResult.transportRequested !== 'websocket'
    || providerProbeResult.effectiveTransport !== 'websocket'
    || rawProbeResult?.transportRequested !== 'websocket'
    || rawProbeResult?.transportEffective !== 'websocket'
    || rawProbeResult?.fallbackApplied !== false
    || diagnosticsProbeSummary?.transportEffective !== 'websocket'
    || providerProbeResult.credentialStatus?.backend !== 'windows-credential-manager'
    || providerProbeResult.credentialStatus?.exists !== true
    || providerProbeResult.credentialStatus?.reference
      !== STRICT_PAID_PROVIDER_IDENTITY.credentialReference
    || Number(providerProbeResult.connectionAttempts) !== 1
    || Number(providerProbeResult.connectionCount) !== 1
    || providerProbeResult.connectionOpened !== true
    || providerProbeResult.connectionClosed !== true
    || !String(providerProbeResult.connectionOwner ?? '').includes(expectedAuthorization.executionId)
    || !Number.isSafeInteger(Number(providerProbeResult.connectionGeneration))
    || Number(providerProbeResult.connectionGeneration) < 1
    || Number(rawProbeResult?.connectionAttempts) !== 1
    || Number(rawProbeResult?.connectionCount) !== 1
    || rawProbeResult?.connectionOpened !== true
    || rawProbeResult?.connectionClosed !== true
    || rawProbeResult?.connectionOwner !== providerProbeResult.connectionOwner
    || Number(rawProbeResult?.connectionGeneration) !== Number(providerProbeResult.connectionGeneration)
  ) {
    throw new Error('strict shard provider preflight configured provider identity is invalid');
  }
  try {
    const configuredEndpoint = new URL(configuredProvider.baseUrl);
    if (
      configuredEndpoint.protocol !== 'https:'
      || configuredEndpoint.hostname !== STRICT_PAID_PROVIDER_IDENTITY.endpointHost
      || configuredEndpoint.port
      || configuredEndpoint.username
      || configuredEndpoint.password
    ) {
      throw new Error('endpoint mismatch');
    }
  } catch {
    throw new Error('strict shard provider preflight configured endpoint is invalid');
  }
  assertExactObject(
    providerProbeResult.preflightAuthorization,
    observedAuthorization,
    'strict shard provider preflight consumed authorization',
  );
  for (const [candidate, label] of [
    [rawProbeResult, 'raw provider result'],
    [diagnosticsProbeSummary, 'diagnostics provider summary'],
  ]) {
    if (
      candidate?.configuredModel !== observedConfiguredModel
      || candidate?.model !== expectedAuthorization.model
      || candidate?.protocol !== expectedAuthorization.protocol
      || candidate?.providerConnectStartedAt !== connectStartedAt
      || candidate?.providerConnectCompletedAt !== connectCompletedAt
      || Number(candidate?.connectionAttempts) !== 1
      || Number(candidate?.connectionCount) !== 1
      || candidate?.connectionOpened !== true
      || candidate?.connectionClosed !== true
      || candidate?.connectionOwner !== providerProbeResult.connectionOwner
      || Number(candidate?.connectionGeneration) !== Number(providerProbeResult.connectionGeneration)
    ) {
      throw new Error(`strict shard provider preflight ${label} model/protocol/connect authority mismatch`);
    }
    assertExactObject(
      candidate.preflightAuthorization,
      observedAuthorization,
      `strict shard provider preflight ${label} consumed authorization`,
    );
  }
  if (
    emitterResult.preflightAuthorization == null
    || emitterResult.providerConnectStartedAt !== connectStartedAt
    || emitterResult.providerConnectCompletedAt !== connectCompletedAt
    || Number(emitterResult.desktopProcessId) !== Number(expectedClaim.desktopProcessId)
    || emitterResult.desktopExecutable !== expectedClaim.desktopExecutablePath
    || emitterResult.desktopExecutableSha256 !== expectedClaim.desktopExecutableSha256
  ) {
    throw new Error('strict shard provider preflight emitter does not bind the provider connect authority');
  }
  assertExactObject(
    emitterResult.preflightAuthorization,
    observedAuthorization,
    'strict shard provider preflight emitter consumed authorization',
  );
  const lastReservationAtMs = Math.max(...authorization.leaseReservations.map((entry) => (
    strictAuthorityTimestamp(entry.issuedAt, 'strict shard provider preflight reservation issuedAt')
  )));
  const authorizationObservedAtMs = strictAuthorityTimestamp(
    authorizationObservedAt,
    'strict shard provider preflight authorizationObservedAt',
  );
  const connectStartedAtMs = strictAuthorityTimestamp(
    connectStartedAt,
    'strict shard provider preflight providerConnectStartedAt',
  );
  const checkedAtInterval = strictAuthorityTimestampInterval(
    providerProbeResult.checkedAt,
    'strict shard provider preflight checkedAt',
  );
  const connectCompletedAtMs = strictAuthorityTimestamp(
    connectCompletedAt,
    'strict shard provider preflight providerConnectCompletedAt',
  );
  if (
    authorizationObservedAtMs <= lastReservationAtMs
    || authorizationObservedAtMs >= strictAuthorityTimestamp(
      expectedClaim.claimedAt,
      'strict shard provider preflight consumption claim claimedAt',
    )
    || strictAuthorityTimestamp(
      expectedClaim.claimedAt,
      'strict shard provider preflight consumption claim claimedAt',
    ) >= connectStartedAtMs
    || checkedAtInterval.end < connectStartedAtMs
    || checkedAtInterval.start > connectCompletedAtMs
    || connectCompletedAtMs > strictAuthorityTimestamp(
      emitterResult.completedAt,
      'strict shard provider preflight emitter completedAt',
    )
  ) {
    throw new Error('strict shard provider preflight authorization/connect timeline is invalid');
  }
  for (const key of [
    'providerId',
    'model',
    'protocol',
    'operation',
    'inputMode',
    'providerInputMode',
    'responseMode',
    'terminalEvent',
    'status',
    'externalAudioSamples',
    'invocationCount',
    'scenarioId',
    'rawEvidenceRoot',
    'rawEvidenceCount',
    'rawEvidenceDigest',
    'executionId',
    'grantDigest',
    'leaseReservationDigests',
    'authorizationDigest',
    'consumptionClaim',
    'lifecycleBudget',
    'evidenceOutcome',
    'firstServerEvent',
    'sessionAuthority',
    'rawTrace',
    'audioSeconds',
    'generatedAt',
  ]) {
    if (canonicalJson(plan.providerPreflightAuthority?.[key]) !== canonicalJson(receipt[key])) {
      throw new Error(`strict shard signed plan provider preflight ${key} mismatch`);
    }
  }

  const validationAtMs = Number(
    validationAt instanceof Date ? validationAt.getTime() : validationAt,
  );
  const raw = validateEvidence(rawRoot, {
    now: validationAtMs,
    workspaceRoot,
    implementationRoot: workspaceRoot,
    currentProvenance,
    expectedAuthorization,
  });
  if (
    !raw.summary
    || !Array.isArray(raw.issues)
    || raw.issues.length !== 0
    || raw.summary.providerId !== receipt.providerId
    || raw.summary.model !== receipt.model
    || raw.summary.protocol !== receipt.protocol
    || raw.summary.executionId !== receipt.executionId
    || raw.summary.grantDigest !== receipt.grantDigest
    || canonicalJson(raw.summary.leaseReservationDigests)
      !== canonicalJson(receipt.leaseReservationDigests)
    || raw.summary.authorizationDigest !== receipt.authorizationDigest
    || raw.summary.providerInputMode !== receipt.providerInputMode
    || raw.summary.responseMode !== receipt.responseMode
    || raw.summary.terminalEvent !== receipt.terminalEvent
    || canonicalJson(raw.summary.lifecycleBudget)
      !== canonicalJson(expectedAuthorization.lifecycleBudget)
    || raw.summary.evidenceOutcome !== receipt.evidenceOutcome
    || canonicalJson(raw.summary.firstServerEvent) !== canonicalJson(receipt.firstServerEvent)
    || canonicalJson(raw.summary.sessionAuthority) !== canonicalJson(receipt.sessionAuthority)
    || canonicalJson(raw.summary.rawTrace) !== canonicalJson(receipt.rawTrace)
    || raw.summary.inputTokens != null
    || raw.summary.outputTokens != null
    || raw.summary.audioSeconds !== preflightUsages[0].audioSeconds
    || raw.summary.operation !== receipt.operation
    || raw.summary.inputMode !== receipt.inputMode
    || Number(raw.summary.externalAudioSamples) !== Number(receipt.externalAudioSamples)
    || Number(raw.summary.providerInvocationCount) !== Number(receipt.invocationCount)
  ) {
    throw new Error(
      `strict shard provider preflight production raw authority failed: `
      + `${raw.issues?.join('; ') || 'summary/provider/model mismatch'}`,
    );
  }
  const evidenceTimes = raw.evidenceTimes ?? [];
  const receiptGeneratedAtMs = strictAuthorityTimestamp(
    receipt.generatedAt,
    'strict shard provider preflight receipt generatedAt',
  );
  if (
    evidenceTimes.length === 0
    || evidenceTimes.some((value) => (
      strictAuthorityTimestamp(value, 'strict shard provider preflight raw evidence timestamp')
        <= lastReservationAtMs
    ))
    || Math.max(...evidenceTimes.map((value) => strictAuthorityTimestamp(
      value,
      'strict shard provider preflight raw evidence timestamp',
    ))) >= receiptGeneratedAtMs
    || receiptGeneratedAtMs >= strictAuthorityTimestamp(
      authorization.completion.generatedAt,
      'strict shard provider preflight completion generatedAt',
    )
  ) {
    throw new Error('strict shard provider preflight authorization/raw/receipt/completion order is invalid');
  }
  return { receipt, inventory, raw, rawRoot, authorization };
}

export function buildStrictShardCellAuthorityProjection({
  matrixCell,
  planCell,
  shardBinding,
  shardManifest,
  shardManifestAuthority,
  resultBinding,
  result,
}) {
  return {
    origin: 'guest-shard-result',
    executionId: result.executionId,
    planDigest: result.planDigest,
    cellIndex: planCell.cellIndex,
    cellId: planCell.cellId,
    workerId: planCell.workerId,
    vmIdentityDigest: planCell.vmIdentityDigest,
    waveIndex: planCell.waveIndex,
    leaseId: result.leaseId,
    leaseDigest: result.leaseDigest,
    shardRoot: shardBinding.shardRoot,
    shardManifest: {
      ...shardManifestAuthority,
      manifestDigest: shardManifest.manifestDigest,
    },
    result: {
      ...resultBinding.result,
      resultDigest: result.resultDigest,
    },
    guestRunDirectory: result.runDirectory,
    runDirectory: matrixCell.runDirectory,
    runtimeBinaryHashes: result.authority.runtimeBinaryHashes,
    ...(result.workerReadinessAuthority
      ? { workerReadinessAuthority: result.workerReadinessAuthority }
      : {}),
    ...(result.interactiveSessionAuthority
      ? { interactiveSessionAuthority: result.interactiveSessionAuthority }
      : {}),
    usageAuthority: result.usageAuthority,
    deviceAuthority: result.deviceAuthority,
  };
}

export function verifyStrictShardMatrixAuthority({
  manifest,
  evidenceRoot,
  releaseCells = LIVE_LLM_CELLS,
  cellReceipts,
  currentProvenance,
  currentImplementationHashes,
  currentRuntimeBinaryHashes,
  externalProviderBudget = manifest.externalProviderBudget,
  workspaceRoot = process.cwd(),
  validationAt = new Date(manifest.generatedAt),
  validatePreflightEvidence = validateProviderPreflightRawAuthority,
}) {
  const resolvedRoot = path.resolve(evidenceRoot);
  const rootStats = fs.lstatSync(resolvedRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('strict shard evidence root must be a real non-symlink directory');
  }
  const shardExecution = manifest.shardExecution;
  const matrixIntegration = manifest.matrixIntegration;
  if (!shardExecution || typeof shardExecution !== 'object') {
    throw new Error('strict paid matrix is missing shardExecution guest authority');
  }
  if (!matrixIntegration || typeof matrixIntegration !== 'object') {
    throw new Error('strict paid matrix is missing shard matrixIntegration authority');
  }
  if (!Array.isArray(cellReceipts) || cellReceipts.length !== releaseCells.length) {
    throw new Error('strict shard verification requires one validated production cell receipt per release cell');
  }
  const currentShardImplementationHashes = currentShardOrchestrationImplementationHashes({
    workspaceRoot,
  });
  if (
    !sameShardAuthorityInventory(
      shardExecution.shardOrchestrationImplementationHashes,
      currentShardImplementationHashes,
    )
    || !sameShardAuthorityInventory(
      matrixIntegration.shardOrchestrationImplementationHashes,
      currentShardImplementationHashes,
    )
  ) {
    throw new Error('strict shard orchestration implementation hashes do not match the current checkout');
  }

  const executionRootRelative = String(shardExecution.executionRoot ?? '').replaceAll('\\', '/');
  const executionRoot = resolveStrictAuthorityDirectory(
    resolvedRoot,
    executionRootRelative,
    'strict shard execution root',
  );
  const expectedPlanPath = portableAuthorityPath(
    executionRootRelative,
    SHARD_EXECUTION_PLAN_FILE,
  );
  const planPath = validateFileAuthorityEntry(
    resolvedRoot,
    shardExecution.plan,
    expectedPlanPath,
    'strict shard signed execution plan',
  );
  const plan = readJson(planPath);
  verifySignedExecutionPlan(plan, {
    now: validationAt,
    currentProvenance,
    currentAuthorityImplementationHashes: currentImplementationHashes,
    currentRuntimeBinaryHashes,
    currentShardImplementationHashes,
  });
  if (
    !sameShardAuthorityInventory(
      plan.authority?.shardOrchestrationImplementationHashes,
      currentShardImplementationHashes,
    )
  ) {
    throw new Error('strict shard execution plan does not bind current shard implementation hashes');
  }
  if (!plan.workerReadinessRequest) {
    throw new Error('strict production shard execution plan does not bind pre-provider worker readiness');
  }
  const expectedWorkerCount = Array.isArray(plan.workers) ? plan.workers.length : 0;
  if (!SHARD_ALLOWED_WORKER_COUNTS.includes(expectedWorkerCount)) {
    throw new Error('strict execution plan must bind exactly one local worker');
  }
  const preflightAuthorization = verifyStrictShardProviderPreflightAuthorization({
    plan,
    executionRoot,
    executionRootRelative,
    evidenceRoot: resolvedRoot,
    workspaceRoot,
    shardExecution,
    matrixIntegration,
    currentImplementationHashes,
    currentRuntimeBinaryHashes,
    currentShardImplementationHashes,
    validationAt,
  });
  const preflightAuthority = verifyStrictShardProviderPreflightAuthority({
    plan,
    executionRoot,
    executionRootRelative,
    evidenceRoot: resolvedRoot,
    currentProvenance,
    workspaceRoot,
    validationAt,
    authorization: preflightAuthorization,
    validateEvidence: validatePreflightEvidence,
  });

  if (!Array.isArray(shardExecution.leases) || shardExecution.leases.length !== SHARD_MATRIX_CELL_COUNT) {
    throw new Error(`strict shard execution requires exactly ${SHARD_MATRIX_CELL_COUNT} signed cell leases`);
  }
  const leases = [];
  const leasePaths = new Set();
  for (let index = 0; index < shardExecution.leases.length; index += 1) {
    const leaseAuthority = shardExecution.leases[index];
    const planCell = plan.cells[index];
    const leasePathValue = String(leaseAuthority?.path ?? '').replaceAll('\\', '/');
    const expectedLeasePrefix = `${portableAuthorityPath(executionRootRelative, 'leases')}/`;
    if (!leasePathValue.startsWith(expectedLeasePrefix) || !leasePathValue.endsWith('.json')) {
      throw new Error(`strict shard lease ${index} is outside the immutable execution lease directory`);
    }
    if (leasePaths.has(leasePathValue)) {
      throw new Error(`strict shard execution reuses lease authority path ${leasePathValue}`);
    }
    leasePaths.add(leasePathValue);
    const leasePath = validateFileAuthorityEntry(
      resolvedRoot,
      leaseAuthority,
      leasePathValue,
      `strict shard signed cell lease ${index}`,
    );
    const lease = readJson(leasePath);
    const validatedCell = verifyCellLease(lease, plan, { now: validationAt });
    if (
      leaseAuthority.cellId !== planCell.cellId
      || leaseAuthority.leaseId !== planCell.leaseId
      || validatedCell.cellId !== planCell.cellId
      || lease.leaseId !== planCell.leaseId
    ) {
      throw new Error(`strict shard signed cell lease ${index} does not match canonical plan order`);
    }
    leases.push(lease);
  }

  const expectedAggregatePath = portableAuthorityPath(
    executionRootRelative,
    COORDINATOR_AGGREGATE_FILE,
  );
  const aggregatePath = validateFileAuthorityEntry(
    resolvedRoot,
    shardExecution.coordinatorAggregate,
    expectedAggregatePath,
    'strict shard coordinator aggregate',
  );
  const aggregate = validateCoordinatorAggregate(readJson(aggregatePath));
  const validationAtMs = Number(validationAt instanceof Date ? validationAt.getTime() : validationAt);
  if (!Number.isFinite(validationAtMs)) {
    throw new Error('strict shard validationAt is missing or invalid');
  }
  const aggregateGeneratedAtMs = strictAuthorityTimestamp(
    aggregate.generatedAt,
    'strict shard coordinator aggregate generatedAt',
  );
  if (
    aggregate.executionId !== plan.executionId
    || aggregate.planDigest !== plan.planDigest
    || canonicalJson(aggregate.provenance) !== canonicalJson(plan.provenance)
    || canonicalJson(aggregate.providerPreflightAuthority)
      !== canonicalJson(plan.providerPreflightAuthority)
    || canonicalJson(aggregate.localIsolationAuthority)
      !== canonicalJson(plan.localIsolationAuthority)
    || !sameShardAuthorityInventory(
      aggregate.authority?.implementationHashes,
      currentImplementationHashes,
    )
    || !sameShardAuthorityInventory(
      aggregate.authority?.runtimeBinaryHashes,
      currentRuntimeBinaryHashes,
    )
    || !sameShardAuthorityInventory(
      aggregate.authority?.shardOrchestrationImplementationHashes,
      currentShardImplementationHashes,
    )
    || Number(aggregate.budget?.actualExternalAudioSamples) <= 0
    || Number(aggregate.budget?.actualExternalAudioSamples)
      > SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES
    || Number(aggregate.budget?.actualExternalAudioSamples)
      !== Number(externalProviderBudget?.actualProviderInputSamples)
    || aggregateGeneratedAtMs > validationAtMs
  ) {
    throw new Error('strict shard coordinator aggregate does not bind the signed plan/current runtime budget');
  }

  if (!Array.isArray(shardExecution.shards) || shardExecution.shards.length !== expectedWorkerCount) {
    throw new Error(`strict shard execution requires exactly ${expectedWorkerCount} guest shard manifests for its signed plan`);
  }
  const shardRoots = new Set();
  const workers = new Set();
  const validatedByCell = new Map();
  for (let index = 0; index < shardExecution.shards.length; index += 1) {
    const shardBinding = shardExecution.shards[index];
    const shardRootRelative = String(shardBinding?.shardRoot ?? '').replaceAll('\\', '/');
    const expectedShardPrefix = `${portableAuthorityPath(executionRootRelative, 'shards')}/`;
    if (!shardRootRelative.startsWith(expectedShardPrefix)) {
      throw new Error(`strict shard guest root ${index} is outside the staged execution shard directory`);
    }
    if (shardRoots.has(shardRootRelative)) {
      throw new Error(`strict shard execution reuses guest shard root ${shardRootRelative}`);
    }
    shardRoots.add(shardRootRelative);
    const shardRoot = resolveStrictAuthorityDirectory(
      resolvedRoot,
      shardRootRelative,
      `strict shard guest root ${index}`,
    );
    const expectedManifestPath = portableAuthorityPath(shardRootRelative, SHARD_MANIFEST_FILE);
    const shardManifestPath = validateFileAuthorityEntry(
      resolvedRoot,
      shardBinding.manifest,
      expectedManifestPath,
      `strict shard guest manifest ${index}`,
    );
    const validatedShard = validateShardManifest({
      manifestPath: shardManifestPath,
      shardRoot,
      plan,
      leases,
      now: validationAt,
    });
    const workerId = validatedShard.manifest.workerId;
    if (shardBinding.workerId !== workerId || workers.has(workerId)) {
      throw new Error(`strict shard guest manifest ${index} has a duplicate or mismatched worker identity`);
    }
    workers.add(workerId);
    const shardManifestGeneratedAtMs = strictAuthorityTimestamp(
      validatedShard.manifest.generatedAt,
      `strict shard guest manifest ${index} generatedAt`,
    );
    if (
      shardManifestGeneratedAtMs > aggregateGeneratedAtMs
      || validatedShard.manifest.manifestDigest
        !== aggregate.shards.find((entry) => entry.workerId === workerId)?.manifestDigest
    ) {
      throw new Error(`strict shard guest manifest ${index} is not the manifest consumed by the coordinator aggregate`);
    }
    for (const validatedResult of validatedShard.validatedResults) {
      const cellId = validatedResult.cell.cellId;
      if (validatedByCell.has(cellId)) {
        throw new Error(`strict shard guest manifests contain duplicate cell ${cellId}`);
      }
      const resultBinding = validatedShard.manifest.results.find((entry) => entry.cellId === cellId);
      validatedByCell.set(cellId, {
        shardBinding,
        shardManifest: validatedShard.manifest,
        shardManifestAuthority: shardBinding.manifest,
        resultBinding,
        ...validatedResult,
      });
    }
  }
  if (workers.size !== expectedWorkerCount || validatedByCell.size !== SHARD_MATRIX_CELL_COUNT) {
    throw new Error(
      `strict shard guest manifests do not contain the signed ${expectedWorkerCount} workers `
      + `and ${SHARD_MATRIX_CELL_COUNT} unique cells`,
    );
  }

  const shardCellAuthorities = [];
  for (let index = 0; index < releaseCells.length; index += 1) {
    const matrixCell = manifest.cells[index];
    const planCell = plan.cells[index];
    const receipt = cellReceipts[index];
    const validated = validatedByCell.get(planCell.cellId);
    const aggregateCell = aggregate.cells[index];
    if (!validated || planCell.cellId !== releaseCells[index].cellId) {
      throw new Error(`strict shard cell ${index} does not match the canonical paid release order`);
    }
    const finalRunDirectory = resolveStrictAuthorityDirectory(
      resolvedRoot,
      matrixCell.runDirectory,
      `strict shard cell ${index} final run directory`,
    );
    if (path.resolve(validated.runDirectory) !== finalRunDirectory) {
      throw new Error(`strict shard cell ${index} matrix run directory is not its staged guest result directory`);
    }
    const grantedReadiness = preflightAuthorization.projection.workerReadiness.find((entry) => (
      entry.workerId === planCell.workerId
    ));
    if (
      !grantedReadiness
      || validated.result.workerReadinessAuthority?.bytes !== grantedReadiness.bytes
      || validated.result.workerReadinessAuthority?.sha256 !== grantedReadiness.sha256
    ) {
      throw new Error(`strict shard cell ${index} does not reuse its pre-provider signed worker readiness bytes`);
    }
    if (
      !sameShardAuthorityInventory(validated.result.authority?.runtimeBinaryHashes, currentRuntimeBinaryHashes)
      || !sameShardAuthorityInventory(validated.result.authority?.runtimeBinaryHashes, receipt.runtimeBinaryHashes)
      || !sameShardAuthorityInventory(validated.result.authority?.implementationHashes, receipt.implementationHashes)
      || canonicalJson(validated.result.provenance) !== canonicalJson(receipt.provenance)
      || strictAuthorityTimestamp(
        validated.result.generatedAt,
        `strict shard cell ${index} guest result generatedAt`,
      ) > strictAuthorityTimestamp(
        validated.shardManifest.generatedAt,
        `strict shard cell ${index} guest manifest generatedAt`,
      )
      || strictAuthorityTimestamp(
        validated.shardManifest.generatedAt,
        `strict shard cell ${index} guest manifest generatedAt`,
      ) > strictAuthorityTimestamp(
        receipt.generatedAt,
        `strict shard cell ${index} receipt generatedAt`,
      )
    ) {
      throw new Error(`strict shard cell ${index} guest result/runtime authority does not match its downstream cell receipt`);
    }
    if (
      aggregateCell.cellId !== planCell.cellId
      || aggregateCell.workerId !== planCell.workerId
      || aggregateCell.vmIdentityDigest !== planCell.vmIdentityDigest
      || aggregateCell.waveIndex !== planCell.waveIndex
      || aggregateCell.leaseId !== validated.result.leaseId
      || aggregateCell.leaseDigest !== validated.result.leaseDigest
      || aggregateCell.shardManifestDigest !== validated.shardManifest.manifestDigest
      || aggregateCell.resultDigest !== validated.result.resultDigest
      || aggregateCell.runDirectory !== validated.result.runDirectory
      || canonicalJson(aggregateCell.usageAuthority) !== canonicalJson(validated.result.usageAuthority)
      || canonicalJson(aggregateCell.deviceAuthority) !== canonicalJson(validated.result.deviceAuthority)
    ) {
      throw new Error(`strict shard cell ${index} coordinator aggregate does not match the guest result`);
    }
    const stagedResultPath = path.join(validated.runDirectory, SHARD_CELL_RESULT_FILE);
    const stagedResultRelativePath = portableAuthorityPath(
      validated.shardBinding.shardRoot,
      validated.result.runDirectory,
      SHARD_CELL_RESULT_FILE,
    );
    const projection = buildStrictShardCellAuthorityProjection({
      matrixCell,
      planCell,
      ...validated,
      resultBinding: {
        result: fileAuthorityEntry(stagedResultPath, stagedResultRelativePath),
      },
    });
    assertExactObject(
      matrixCell.shardAuthority,
      projection,
      `strict shard matrix cell ${index} guest authority`,
    );
    assertExactObject(
      receipt.shardAuthority,
      projection,
      `strict shard cell receipt ${index} guest authority`,
    );
    shardCellAuthorities.push(projection);
  }

  const expectedMatrixIntegration = {
    provenance: plan.provenance,
    authorityImplementationHashes: plan.authority.implementationHashes,
    authorityRuntimeBinaryHashes: plan.authority.runtimeBinaryHashes,
    shardOrchestrationImplementationHashes:
      plan.authority.shardOrchestrationImplementationHashes,
    localIsolationAuthority: plan.localIsolationAuthority,
    providerPreflightAuthority: plan.providerPreflightAuthority,
    ...preflightAuthorization.projection,
    releaseCells,
    coordinatorAggregateDigest: aggregate.aggregateDigest,
    cells: shardCellAuthorities,
    externalProviderBudget: aggregate.budget,
  };
  assertExactObject(
    matrixIntegration,
    expectedMatrixIntegration,
    'strict shard matrixIntegration',
  );
  return {
    plan,
    preflightAuthority,
    leases,
    aggregate,
    shardCellAuthorities,
    shardOrchestrationImplementationHashes: currentShardImplementationHashes,
    executionRoot,
  };
}

export function verifyStrictMatrixAuthority({
  manifestPath,
  manifest,
  evidenceRoot,
  currentProvenance,
  workspaceRoot = process.cwd(),
  now = Date.now(),
  maxAgeDays = DEFAULT_MAX_EVIDENCE_AGE_DAYS,
  currentRuntimeBinaryHashes = currentAuthorityRuntimeBinaryHashes({ workspaceRoot }),
  releaseCells = LIVE_LLM_CELLS,
  requireLocalIsolation = true,
  validatePreflightEvidence = validateProviderPreflightRawAuthority,
}) {
  const resolvedRoot = path.resolve(evidenceRoot);
  const resolvedManifestPath = path.resolve(manifestPath);
  if (path.dirname(resolvedManifestPath) !== resolvedRoot) {
    throw new Error(`strict authority manifest must be stored directly in the evidence root: manifest=${resolvedManifestPath} root=${resolvedRoot}`);
  }
  if (
    manifest.schemaVersion !== STRICT_MATRIX_SCHEMA_VERSION
    || manifest.artifactKind !== STRICT_MATRIX_ARTIFACT_KIND
  ) {
    throw new Error(`strict evidence requires ${STRICT_MATRIX_ARTIFACT_KIND} schemaVersion=${STRICT_MATRIX_SCHEMA_VERSION}`);
  }
  const planFailure = balancedReleasePlanFailure(manifest.validationPlan);
  if (planFailure) throw new Error(planFailure);
  if (requireLocalIsolation && (!manifest.localIsolation || typeof manifest.localIsolation !== 'object')) {
    throw new Error('strict evidence requires the zero-LLM local isolation authority');
  }
  if (requireLocalIsolation) {
    const localManifestPath = path.resolve(workspaceRoot, manifest.localIsolation.manifestPath ?? '');
    const localManifest = JSON.parse(fs.readFileSync(localManifestPath, 'utf8').replace(/^\uFEFF/u, ''));
    const localRuntimeAuthorityPath = path.resolve(
      path.dirname(localManifestPath),
      localManifest.runtimeAuthority?.authority?.path ?? '',
    );
    const localManifestAuthority = fileAuthorityEntry(
      localManifestPath,
      path.basename(localManifestPath),
    );
    if (
      localManifestAuthority.bytes !== manifest.localIsolation.bytes
      || localManifestAuthority.sha256 !== manifest.localIsolation.sha256
    ) throw new Error('strict local isolation manifest hash/size binding mismatch');
    verifyLocalIsolationManifest({
      manifestPath: localManifestPath,
      workspaceRoot,
      provenance: currentProvenance,
      runtimeBinaryHashes: currentRuntimeBinaryHashes,
      runtimeAuthorityPath: localRuntimeAuthorityPath,
    });
  }
  if (
    manifest.collectAll
    && (
      manifest.collectAll.verdict !== 'passed'
      || !Array.isArray(manifest.collectAll.attempted)
      || !Array.isArray(manifest.collectAll.completed)
      || !Array.isArray(manifest.collectAll.passed)
      || !Array.isArray(manifest.collectAll.failed)
      || manifest.collectAll.attempted.length !== LIVE_LLM_CELLS.length
      || manifest.collectAll.completed.length !== LIVE_LLM_CELLS.length
      || manifest.collectAll.passed.length !== LIVE_LLM_CELLS.length
      || manifest.collectAll.failed.length !== 0
    )
  ) throw new Error('strict collect-all matrix contains failed or incomplete cells');
  if (manifest.collectAll) {
    validateFileAuthorityEntry(
      resolvedRoot,
      manifest.collectAll.failureFingerprintAuthority,
      manifest.collectAll.failureFingerprintAuthority?.path,
      'strict collect-all failure fingerprints',
    );
  }
  if (manifest.authority?.runner !== MATRIX_RUNNER_ID) {
    throw new Error(`strict authority runner must be ${MATRIX_RUNNER_ID}`);
  }
  if (manifest.authority?.collector !== LIVE_RUN_COLLECTOR_ID) {
    throw new Error(`strict authority collector must be ${LIVE_RUN_COLLECTOR_ID}`);
  }
  const currentImplementationHashes = currentAuthorityImplementationHashes({ workspaceRoot });
  const currentPaidImplementationHashes = currentPaidAuthorityImplementationHashes({ workspaceRoot });
  if (!sameAuthorityInventory(manifest.authority?.implementationHashes, currentImplementationHashes)) {
    throw new Error('strict authority runner/collector implementation hashes do not match the current checkout');
  }
  if (!sameAuthorityInventory(manifest.authority?.paidImplementationHashes, currentPaidImplementationHashes)) {
    throw new Error('strict authority paid implementation hashes do not match the current checkout');
  }
  if (!sameAuthorityInventory(manifest.authority?.runtimeBinaryHashes, currentRuntimeBinaryHashes)) {
    throw new Error('strict authority runtime binary hashes do not match the current release build');
  }
  if (!Array.isArray(manifest.cells) || manifest.cells.length === 0) {
    throw new Error('strict authority manifest has no cells');
  }
  if (manifest.cells.length !== manifest.runDirectories?.length) {
    throw new Error('strict authority cells/runDirectories length mismatch');
  }
  if (manifest.cells.length !== releaseCells.length) {
    throw new Error(`strict authority manifest must contain exactly ${releaseCells.length} paid live cells`);
  }
  const requiresShardAuthority = releaseCells.length === SHARD_MATRIX_CELL_COUNT
    && canonicalJson(releaseCells.map((cell) => cell.cellId))
      === canonicalJson(LIVE_LLM_CELLS.map((cell) => cell.cellId));
  if (requiresShardAuthority && !manifest.collectAll) {
    throw new Error('strict shard matrix requires collect-all completion authority');
  }
  if (
    requiresShardAuthority
    && (!manifest.shardExecution || !manifest.matrixIntegration)
  ) {
    throw new Error(
      `strict ${SHARD_MATRIX_CELL_COUNT}-cell paid matrix requires `
      + 'guest shardExecution/matrixIntegration authority',
    );
  }
  const manifestGeneratedAtMs = Date.parse(manifest.generatedAt ?? '');
  if (!Number.isFinite(manifestGeneratedAtMs)) {
    throw new Error('strict authority manifest generatedAt is missing or invalid');
  }
  if (manifestGeneratedAtMs > now + 300_000) {
    throw new Error(`strict authority manifest generatedAt is in the future: ${manifest.generatedAt}`);
  }
  const maxAgeMs = Number(maxAgeDays) * 86_400_000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error(`strict authority maxAgeDays must be a non-negative number; got ${maxAgeDays}`);
  }
  if (now - manifestGeneratedAtMs > maxAgeMs) {
    throw new Error(`strict authority manifest is stale: generatedAt=${manifest.generatedAt}`);
  }
  if (manifest.verification === 'passed') {
    const verifiedAtMs = Date.parse(manifest.verifiedAt ?? '');
    if (!Number.isFinite(verifiedAtMs) || verifiedAtMs < manifestGeneratedAtMs || verifiedAtMs > now + 300_000) {
      throw new Error('canonical strict authority verifiedAt must be between manifest generation and the current verification time');
    }
  }
  assertCanonicalVerificationBinding({
    manifest,
    evidenceRoot: resolvedRoot,
    currentProvenance,
    implementationHashes: currentImplementationHashes,
    paidImplementationHashes: currentPaidImplementationHashes,
    runtimeBinaryHashes: currentRuntimeBinaryHashes,
  });

  const authorizedReports = new Map();
  const cellExternalProviderBudgets = [];
  const translatedPcmLoopbackAuthorities = [];
  const cellAuthorityReceipts = [];
  const runDirectories = [];
  const seenDirectories = new Set();
  const seenProviderLeaseIds = new Set();
  for (let index = 0; index < manifest.cells.length; index += 1) {
    const cell = manifest.cells[index];
    const plannedCell = releaseCells[index];
    for (const key of [
      'cellId',
      'tier',
      'providerMode',
      'inputCompletionWatchdogSeconds',
      'processExclusionRestartAfterSeconds',
      'processExclusionRestartQuietSeconds',
      'providerFinishTimeoutSeconds',
      'localPlaybackDrainTimeoutSeconds',
      'reportWriteTimeoutSeconds',
      'cellHardWatchdogSeconds',
      'authoritativeTransformedReferenceFrames',
      'boundedCaptureGraceFrames',
      'maxExternalAudioSamples',
      'auxiliaryExternalAudioSeconds',
      'subtitleTranslationMode',
      'modelId',
      'feedbackLoopPrevention',
      'deviceClass',
    ]) {
      if (cell?.[key] !== plannedCell?.[key]) {
        throw new Error(`strict matrix cell ${index} does not match balanced release plan field ${key}`);
      }
    }
    const matrixIdentityFailure = watchModelProtocolIdentityFailure(
      cell?.modelProtocolProfileIdentity,
      plannedCell?.modelProtocolProfileIdentity,
      `strict matrix cell ${index} model protocol profile identity`,
    );
    if (matrixIdentityFailure) throw new Error(matrixIdentityFailure);
    if (cell.runDirectory !== manifest.runDirectories[index]) {
      throw new Error(`strict matrix cell ${index} runDirectory does not match the manifest scope`);
    }
    const runDirectory = resolveAuthorityPath(resolvedRoot, cell.runDirectory, `strict matrix cell ${index} run directory`);
    const directoryIdentity = process.platform === 'win32' ? runDirectory.toLowerCase() : runDirectory;
    if (seenDirectories.has(directoryIdentity)) {
      throw new Error(`strict matrix cell ${index} reuses run directory ${runDirectory}`);
    }
    seenDirectories.add(directoryIdentity);
    const expectedReceiptPath = `${cell.runDirectory.replaceAll('\\', '/')}/${CELL_AUTHORITY_FILE}`;
    const receiptPath = validateFileAuthorityEntry(
      resolvedRoot,
      { path: cell.receiptPath, bytes: cell.receiptBytes, sha256: cell.receiptSha256 },
      expectedReceiptPath,
      `strict matrix cell ${index} receipt`,
    );
    const receipt = readJson(receiptPath);
    if (
      receipt.schemaVersion !== CELL_AUTHORITY_SCHEMA_VERSION
      || receipt.artifactKind !== CELL_AUTHORITY_ARTIFACT_KIND
      || receipt.runner !== MATRIX_RUNNER_ID
      || receipt.collector !== LIVE_RUN_COLLECTOR_ID
    ) {
      throw new Error(`strict matrix cell ${index} receipt was not emitted by the production matrix runner/collector`);
    }
    if (receipt.runDirectory !== cell.runDirectory) {
      throw new Error(`strict matrix cell ${index} receipt runDirectory mismatch`);
    }
    const receiptGeneratedAtMs = Date.parse(receipt.generatedAt ?? '');
    if (!Number.isFinite(receiptGeneratedAtMs) || receiptGeneratedAtMs > manifestGeneratedAtMs) {
      throw new Error(`strict matrix cell ${index} receipt generatedAt must not be later than the matrix manifest`);
    }
    if (now - receiptGeneratedAtMs > maxAgeMs) {
      throw new Error(`strict matrix cell ${index} authority receipt is stale: generatedAt=${receipt.generatedAt}`);
    }
    const provenanceFailure = exactGitProvenanceFailure(
      receipt.provenance,
      currentProvenance,
      {
        recordedSubject: `strict matrix cell ${index} receipt provenance`,
        currentSubject: 'current checkout provenance',
      },
    );
    if (provenanceFailure) throw new Error(provenanceFailure);
    if (!sameAuthorityInventory(receipt.implementationHashes, currentImplementationHashes)) {
      throw new Error(`strict matrix cell ${index} implementation hashes do not match the current checkout`);
    }
    if (!sameAuthorityInventory(receipt.paidImplementationHashes, currentPaidImplementationHashes)) {
      throw new Error(`strict matrix cell ${index} paid implementation hashes do not match the current checkout`);
    }
    if (!sameAuthorityInventory(receipt.runtimeBinaryHashes, currentRuntimeBinaryHashes)) {
      throw new Error(`strict matrix cell ${index} runtime binary hashes do not match the current release build`);
    }
    const expectedArtifactPaths = requiredCellArtifactPaths(cell.feedbackLoopPrevention);
    if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== expectedArtifactPaths.length) {
      throw new Error(`strict matrix cell ${index} raw inventory is incomplete; expected ${expectedArtifactPaths.length} fixed artifacts`);
    }
    for (let artifactIndex = 0; artifactIndex < expectedArtifactPaths.length; artifactIndex += 1) {
      const expectedPath = expectedArtifactPaths[artifactIndex];
      validateFileAuthorityEntry(
        runDirectory,
        receipt.artifacts[artifactIndex],
        expectedPath,
        `strict matrix cell ${index} raw artifact ${expectedPath}`,
      );
    }
    for (const forbiddenPath of forbiddenCellArtifactPaths(cell.feedbackLoopPrevention)) {
      const resolvedForbiddenPath = resolveAuthorityPath(
        runDirectory,
        forbiddenPath,
        `strict matrix cell ${index} forbidden artifact`,
      );
      if (fs.existsSync(resolvedForbiddenPath)) {
        throw new Error(`strict matrix cell ${index} contains forbidden/unbound artifact ${forbiddenPath}`);
      }
    }
    let cellExternalProviderBudget;
    try {
      cellExternalProviderBudget = assertCellExternalProviderBudget(runDirectory, {
        cellId: plannedCell.cellId,
        modelId: plannedCell.modelId,
        modelProtocolProfileIdentity: plannedCell.modelProtocolProfileIdentity,
        feedbackLoopPrevention: plannedCell.feedbackLoopPrevention,
        inputCeilingSamples: plannedCell.maxExternalAudioSamples,
      });
    } catch (error) {
      throw new Error(`strict matrix cell ${index} external provider budget authority failed: ${error.message}`);
    }
    const expectedProtocol = STRICT_PAID_MODEL_PROTOCOLS[plannedCell.modelId];
    const leaseId = cellExternalProviderBudget.providerSendBoundary?.leaseId;
    const cellSampleCap = Number(plannedCell.maxExternalAudioSamples);
    if (
      cellExternalProviderBudget.calls?.mainRealtime !== 1
      || cellExternalProviderBudget.providerSendBoundary?.protocol !== expectedProtocol
      || !Number.isInteger(Number(cellExternalProviderBudget.actualProviderInputSamples))
      || Number(cellExternalProviderBudget.actualProviderInputSamples) <= 0
      || Number(cellExternalProviderBudget.actualProviderInputSamples) > cellSampleCap
    ) {
      throw new Error(
        `strict matrix cell ${index} external provider authority does not bind the approved `
        + `model/protocol or ${cellSampleCap}-sample Rust send ceiling`,
      );
    }
    if (typeof leaseId !== 'string' || !leaseId.trim()) {
      throw new Error(`strict matrix cell ${index} external provider authority is missing its Rust leaseId`);
    }
    if (seenProviderLeaseIds.has(leaseId)) {
      throw new Error(`strict matrix cell ${index} reuses Rust provider leaseId ${leaseId}`);
    }
    const desktopLaunchStep = readWatchModeRunCollection(runDirectory).collection.steps
      ?.find((step) => step?.id === 'start-desktop-shell');
    let evidenceDrivenTerminal;
    try {
      evidenceDrivenTerminal = validateEvidenceDrivenTerminal(runDirectory, plannedCell, {
        runMarker: cellExternalProviderBudget.runMarker,
        leaseId,
        sourceHeadCommit: receipt.provenance?.headCommit,
        runtimeBundleDigest: runtimeBundleDigest(receipt.runtimeBinaryHashes),
        launchId: desktopLaunchStep?.data?.launchId,
        producerProcessId: desktopLaunchStep?.data?.pid,
        producerStartTimeUtcTicks: desktopLaunchStep?.data?.processStartTimeUtcTicks,
        producerExecutableSha256: desktopLaunchStep?.data?.processExecutableSha256,
      });
    } catch (error) {
      throw new Error(`strict matrix cell ${index} evidence-driven terminal failed: ${error.message}`);
    }
    seenProviderLeaseIds.add(leaseId);
    cellExternalProviderBudgets.push(cellExternalProviderBudget);
    try {
      const canonicalAuthority = validateRunCanonicalSourceAuthority({
        runDirectory,
        workspaceRoot,
      });
      assertPhysicalSourceWindowPrefix(runDirectory, canonicalAuthority, index);
    } catch (error) {
      throw new Error(
        `strict matrix cell ${index} canonical source/physical waveform authority failed: `
        + error.message,
      );
    }
    translatedPcmLoopbackAuthorities.push(assertStrictTranslatedPcmLoopbackAuthority({
      runDirectory,
      cell,
      cellExternalProviderBudget,
      index,
      evidenceDrivenTerminal,
    }));
    cellAuthorityReceipts.push(receipt);
    const rebuiltReport = rebuildReportFromDirectory(runDirectory, {
      mode: 'live',
      provenance: receipt.provenance,
    });
    const rawReportIdentityFailure = strictWatchSessionReportFailure(
      rebuiltReport,
      plannedCell.modelProtocolProfileIdentity,
    );
    if (rawReportIdentityFailure) {
      throw new Error(`strict matrix cell ${index} raw Desktop report failed: ${rawReportIdentityFailure}`);
    }
    assertSystemMetricsAuthority(runDirectory, index, evidenceDrivenTerminal);
    assertRawMediaAuthority(runDirectory, currentImplementationHashes, cell, index, workspaceRoot);
    if (cell.feedbackLoopPrevention === 'virtual-driver') {
      assertVirtualDriverBinaryAuthority(runDirectory, currentRuntimeBinaryHashes, index);
    }
    assertPhysicalRecordingAuthority(runDirectory, index);
    if (cell.feedbackLoopPrevention === 'process-exclusion') {
      assertProcessExclusionAudioAuthority(runDirectory, index);
    }
    const storedReport = readJson(path.join(runDirectory, 'report.json'));
    assertExactObject(
      reportAuthorityProjection(storedReport),
      reportAuthorityProjection(rebuiltReport),
      `strict matrix cell ${index} report.json`,
    );
    const reportGeneratedAtMs = Date.parse(storedReport.generatedAt ?? '');
    if (!Number.isFinite(reportGeneratedAtMs) || reportGeneratedAtMs > receiptGeneratedAtMs) {
      throw new Error(`strict matrix cell ${index} report generatedAt must not be later than its authority receipt`);
    }
    const systemMetrics = readJson(path.join(runDirectory, 'system-metrics.json'));
    const metricsStartedAtMs = Date.parse(systemMetrics.startedAt ?? '');
    const metricsFinishedAtMs = Date.parse(systemMetrics.finishedAt ?? '');
    if (
      !Number.isFinite(metricsStartedAtMs)
      || !Number.isFinite(metricsFinishedAtMs)
      || metricsFinishedAtMs < metricsStartedAtMs
      || metricsFinishedAtMs > receiptGeneratedAtMs + 300_000
    ) {
      throw new Error(`strict matrix cell ${index} system-metrics time window is missing, inverted, or later than collection`);
    }
    // Reclassification is intentionally fresh, but evidence age must remain
    // anchored to the immutable report/receipt timeline rather than Date.now().
    rebuiltReport.generatedAt = storedReport.generatedAt;
    rebuiltReport.commit = storedReport.commit;
    rebuiltReport.provenance = storedReport.provenance;
    assertCellIdentity(receipt.matrixCell, cell, rebuiltReport, index);
    runDirectories.push(runDirectory);
    authorizedReports.set(directoryIdentity, rebuiltReport);
  }
  const externalProviderBudget = assertStrictMatrixExternalProviderBudget({
    manifest,
    evidenceRoot: resolvedRoot,
    releaseCells,
    cellLedgers: cellExternalProviderBudgets,
  });
  const hasShardAuthority = Boolean(manifest.shardExecution || manifest.matrixIntegration);
  const shardAuthority = (requiresShardAuthority || hasShardAuthority)
    ? verifyStrictShardMatrixAuthority({
        manifest,
        evidenceRoot: resolvedRoot,
        releaseCells,
        cellReceipts: cellAuthorityReceipts,
        currentProvenance,
        currentImplementationHashes,
        currentRuntimeBinaryHashes,
        externalProviderBudget,
        workspaceRoot,
        // Re-verification may happen days later. Validate that every signed
        // guest result was valid at immutable matrix collection time rather
        // than incorrectly treating a completed execution lease as reusable.
        validationAt: new Date(manifestGeneratedAtMs),
        validatePreflightEvidence,
      })
    : null;
  return {
    runDirectories,
    authorizedReports,
    implementationHashes: currentImplementationHashes,
    paidImplementationHashes: currentPaidImplementationHashes,
    runtimeBinaryHashes: currentRuntimeBinaryHashes,
    externalProviderBudget,
    translatedPcmLoopbackAuthorities,
    shardAuthority,
  };
}

function parseDirectoryTimestamp(name) {
  const match = name.match(/^(\d{8})-(\d{6})(?:-.+)?$/);
  if (!match) return null;
  const [, date, time] = match;
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6)),
  );
}

function evidenceSortTime(entry) {
  const generatedAtMs = Date.parse(entry.report.generatedAt ?? '');
  if (Number.isFinite(generatedAtMs)) return generatedAtMs;
  const directoryTimestamp = parseDirectoryTimestamp(entry.directoryName);
  if (directoryTimestamp !== null) return directoryTimestamp;
  return entry.reportMtimeMs;
}

function isExcludedDirectory(directoryName) {
  return EXCLUDED_DIRECTORY_PATTERNS.some((pattern) => pattern.test(directoryName));
}

function reportFeedbackMode(report) {
  const mode = report?.feedbackLoopPrevention;
  return mode === 'echo-cancel' || mode === 'process-exclusion' ? mode : 'virtual-driver';
}

function requiredLayersFor(options = {}, feedbackMode = 'virtual-driver') {
  if (feedbackMode === 'echo-cancel') return ECHO_CANCEL_REQUIRED_LAYERS;
  if (feedbackMode === 'process-exclusion') {
    return options.strict
      ? PROCESS_EXCLUSION_REQUIRED_LAYERS
      : PROCESS_EXCLUSION_REQUIRED_LAYERS.filter((layer) => layer !== 'strictContent');
  }
  return options.strict ? REQUIRED_LAYERS : BASE_REQUIRED_LAYERS;
}

function hasRequiredLayerShape(report, options = {}) {
  return missingRequiredLayers(report, options).length === 0;
}

function missingRequiredLayers(report, options = {}) {
  return requiredLayersFor(options, reportFeedbackMode(report)).filter((layer) => !report.layers?.[layer]?.status);
}

function reportModelId(report) {
  return report.modelId ?? report.layers?.strictContent?.data?.modelId ?? null;
}

function strictContentFailure(report) {
  const strict = report.layers?.strictContent;
  if (!strict) return 'strictContent layer is missing';
  if (strict.status !== 'passed') return strict.reason ?? 'strictContent layer did not pass';
  if (strict.data?.applicable !== true) return 'strictContent gate was not applicable to this report';
  if (strict.data?.passed !== true) return strict.data?.reason ?? 'strictContent data did not pass';
  return null;
}

export function strictWatchSessionReportFailure(
  report,
  expectedModelProtocolProfileIdentity = deriveWatchModelProtocolIdentity(RELEASE_MODELS[0]),
) {
  const watch = report?.watchSessionReport;
  if (!watch) return 'strict evidence requires a saved watchSessionReport';
  if (report?.realtimeSession?.readinessEvent !== 'session.updated') {
    return `strict LiveTranslate readiness must be session.updated, observed ${report?.realtimeSession?.readinessEvent ?? 'missing'}`;
  }
  if (expectedModelProtocolProfileIdentity) {
    const modelProtocolFailure = watchModelProtocolIdentityFailure(
      watch.modelProtocolProfileIdentity,
      expectedModelProtocolProfileIdentity,
      'watchSessionReport model protocol profile identity',
    );
    if (modelProtocolFailure) return modelProtocolFailure;
  }
  if (watch.status !== 'completed') {
    return `watchSessionReport status is ${watch.status ?? 'unknown'}, expected completed`;
  }
  const elapsedMs = Number(watch.elapsedMs);
  const summaryDurationMs = Number(watch.summary?.durationMs);
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(summaryDurationMs)) {
    return 'watchSessionReport must include numeric elapsedMs and summary.durationMs';
  }
  if (elapsedMs <= 0 || summaryDurationMs <= 0) {
    return `watchSessionReport duration must be positive: elapsedMs=${elapsedMs} summary.durationMs=${summaryDurationMs}`;
  }
  if (Math.abs(elapsedMs - summaryDurationMs) > 1_000) {
    return `watchSessionReport duration fields disagree: elapsedMs=${elapsedMs} summary.durationMs=${summaryDurationMs}`;
  }
  const cues = Array.isArray(watch.cues) ? watch.cues : [];
  const completeCues = cues.filter((cue) => (
    cue.comparisonStatus !== 'superseded'
    && Number.isFinite(Number(cue.llmFirstAtMs))
    && Number.isFinite(Number(cue.publishedFirstAtMs))
    && Number.isFinite(Number(cue.renderedFirstAtMs))
    && Number(cue.llmFirstToRenderMs) >= 0
    && Number(cue.publishToRenderMs) >= 0
  ));
  if (completeCues.length === 0) {
    return 'watchSessionReport has no complete model → publish → visible-render cue';
  }
  if (Number(watch.summary?.unrenderedCueCount ?? 0) > 0) {
    return `watchSessionReport has ${watch.summary.unrenderedCueCount} published cue(s) without visible rendering`;
  }
  const invalid = cues.find((cue) => {
    // Superseded revisions remain in the report as diagnostic history. Only
    // the selected logical revision can determine the strict app verdict;
    // retain the older retry/error events without treating them as active
    // output failures.
    if (cue?.comparisonStatus === 'superseded') return false;
    const issues = Array.isArray(cue.issues) ? cue.issues : [];
    const recoveredRetryOnly = ['exact', 'formatting-only'].includes(cue?.comparisonStatus)
      && Number.isFinite(Number(cue?.llmFirstAtMs))
      && Number.isFinite(Number(cue?.publishedFirstAtMs))
      && Number.isFinite(Number(cue?.renderedFirstAtMs))
      && issues.length > 0
      && issues.every((issue) => issue?.code === 'retry-exhausted');
    if (recoveredRetryOnly) return false;
    // A capture may stop while the provider still has an unfinished source
    // hypothesis. Keep that interruption explicit in the exported report,
    // but do not treat it as a model/publish/render failure in the strict
    // long-chain gate. The report builder only emits this code when it has no
    // completed source evidence (or the update landed immediately before
    // stop), so real no-output errors remain blocking.
    const interruptedSourceTail = cue.comparisonStatus === 'not-published'
      && issues.length > 0
      && issues.every((issue) => (
        issue?.category === 'session'
        && issue?.code === 'session-ended-before-model-output'
        && issue?.severity === 'warning'
      ));
    if (interruptedSourceTail) return false;
    return ['different', 'not-published', 'not-rendered', 'model-error'].includes(cue.comparisonStatus)
      || issues.length > 0;
  });
  if (invalid) {
    return `watchSessionReport has an explicit issue for cue=${invalid.cueId ?? '-'} comparison=${invalid.comparisonStatus ?? '-'}`;
  }
  return null;
}

export function strictAecScenarioFailure(report) {
  if (report?.mode !== 'live') return 'AEC strict evidence must come from a live run';
  const aec = report?.layers?.aec?.data;
  if (!aec) return 'AEC strict evidence is missing layers.aec.data';
  if (report.layers.aec.status !== 'passed') {
    return report.layers.aec.reason ?? 'AEC layer did not pass';
  }
  const scenario = aec.liveScenario;
  if (!scenario || scenario.completed !== true) {
    return 'AEC strict evidence requires a completed live double-talk, dynamic-delay, and nonlinear scenario';
  }
  if (scenario.evidenceMode !== 'live' || scenario.fixtureOnly !== false) {
    return 'AEC strict scenario is fixture/simulated evidence rather than live physical-render evidence';
  }
  if (scenario.timelineBoundToPlayback !== true) {
    return 'AEC strict scenario is not bound to the real reference-media playback timeline';
  }
  const playback = scenario.playback ?? {};
  if (
    playback.actualPlayback !== true
    || String(playback.mediaSha256 ?? '').toLowerCase()
      !== 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f'
    || !Number.isInteger(Number(playback.processId))
    || Number(playback.processId) <= 0
    || !Number.isFinite(Number(playback.startedAtMs))
    || !Number.isFinite(Number(playback.finishedAtMs))
    || Number(playback.finishedAtMs) <= Number(playback.startedAtMs)
  ) {
    return 'AEC strict scenario lacks the actual reference-media injector identity, hash, and playback timestamps';
  }
  const stages = scenario.stages ?? {};
  const expectedStages = [
    ['doubleTalk', 'double-talk', 1, 0, 'none', false],
    ['dynamicDelay', 'dynamic-delay', 2, 80, 'none', false],
    ['nonlinear', 'nonlinear', 3, 160, 'soft-clip', true],
  ];
  for (const [key, name, ordinal, delayMs, nonlinearity, nonlinearExpected] of expectedStages) {
    const stage = stages[key];
    const referenceFrames = Number(stage?.referenceFrames);
    const physicalFrames = Number(stage?.physicalFrames);
    const changedSamples = Number(stage?.changedSamples);
    const changedRatio = Number(stage?.changedRatio);
    const expectedPrefixFrames = Math.round(delayMs * 48_000 / 1_000);
    const physicalPcmMatchesStage = (
      physicalFrames - referenceFrames === expectedPrefixFrames
      && (nonlinearExpected
        ? changedSamples > 0 && changedRatio > 0 && changedRatio <= 1
        : changedSamples === 0 && changedRatio === 0)
    );
    if (
      stage?.status !== 'completed'
      || stage.stage !== name
      || Number(stage.ordinal) !== ordinal
      || Number(stage.delayMs) !== delayMs
      || stage.nonlinearity !== nonlinearity
      || stage.source !== 'runtime-physical-render'
      || !['native-omni', 'subtitle-tts'].includes(stage.playbackSource)
      || String(stage.started) !== 'true'
      || String(stage.completed) !== 'true'
      || referenceFrames <= 0
      || physicalFrames <= 0
      || !physicalPcmMatchesStage
      || !Number.isFinite(Number(stage.startedAtMs))
      || Number(stage.completedAtMs) < Number(stage.startedAtMs)
    ) {
      return `AEC strict scenario stage ${name} is missing real physical-render lifecycle evidence`;
    }
  }
  if (!Number.isFinite(Number(aec.maxDoubleTalkFrames)) || Number(aec.maxDoubleTalkFrames) <= 0) {
    return `AEC strict double-talk telemetry did not increase: doubleTalkFrames=${aec.maxDoubleTalkFrames ?? 'missing'}`;
  }
  if (
    !Number.isFinite(Number(aec.minReportedDelayMs))
    || !Number.isFinite(Number(aec.maxReportedDelayMs))
    || Number(aec.minReportedDelayMs) < 0
    || Number(aec.maxReportedDelayMs) > 1000
    || Number(aec.reportedDelaySpanMs) < 10
  ) {
    return `AEC strict delay telemetry did not prove a bounded dynamic change: minimum=${aec.minReportedDelayMs ?? 'missing'} maximum=${aec.maxReportedDelayMs ?? 'missing'} span=${aec.reportedDelaySpanMs ?? 'missing'}`;
  }
  if (Number(aec.asrDeletedChunkMetricCount) <= 0) {
    return 'AEC strict evidence is missing the explicit asrDeletedChunks metric';
  }
  if (Number(aec.maxAsrDeletedChunks) !== 0) {
    return `AEC strict evidence deleted ASR capture chunks: asrDeletedChunks=${aec.maxAsrDeletedChunks ?? 'missing'}`;
  }
  const expectedSubtitles = scenario.expectedSubtitles ?? {};
  if (
    expectedSubtitles.referenceSource !== 'watch-mode-en-original-transcript'
    || expectedSubtitles.acceptedSource !== 'watch-session-report-cues'
    || !String(expectedSubtitles.watchSessionId ?? '')
    || !Array.isArray(expectedSubtitles.acceptedCueIds)
    || expectedSubtitles.acceptedCueIds.length !== Number(expectedSubtitles.acceptedCueCount)
    || Number(expectedSubtitles.acceptedCueCount) <= 0
    || Number(expectedSubtitles.expectedSegmentCount) <= 0
    || Number(expectedSubtitles.acceptedSegmentCount) !== Number(expectedSubtitles.expectedSegmentCount)
    || Number(expectedSubtitles.acceptanceRate) !== 1
  ) {
    return `AEC strict evidence did not accept 100% of expected subtitle segments: accepted=${expectedSubtitles.acceptedSegmentCount ?? 0}/${expectedSubtitles.expectedSegmentCount ?? 0}`;
  }
  return null;
}

export function strictProcessExclusionRestartFailure(report) {
  if (report?.mode !== 'live') return 'process-exclusion restart evidence must come from a live run';
  const restart = report?.layers?.bridge?.data?.processExclusionRestart;
  if (!restart || restart.completed !== true) {
    return 'process-exclusion strict evidence requires a completed controlled Bridge restart';
  }
  if (restart.evidenceMode !== 'live' || restart.fixtureOnly !== false) {
    return 'process-exclusion Bridge restart is fixture/simulated evidence rather than live evidence';
  }
  if (
    restart.identityChanged !== true
    || Number(restart.oldBridgeProcessId) <= 0
    || Number(restart.newBridgeProcessId) <= 0
    || Number(restart.oldBridgeProcessId) === Number(restart.newBridgeProcessId)
    || !restart.oldBridgeInstanceId
    || !restart.newBridgeInstanceId
    || restart.oldBridgeInstanceId === restart.newBridgeInstanceId
    || !restart.oldSessionId
    || !restart.newSessionId
    || restart.oldSessionId === restart.newSessionId
    || !String(restart.oldSourceGeneration ?? '')
    || !String(restart.newSourceGeneration ?? '')
    || String(restart.oldSourceGeneration) === String(restart.newSourceGeneration)
    || !restart.oldSourceGenerationToken
    || !restart.newSourceGenerationToken
    || restart.oldSourceGenerationToken === restart.newSourceGenerationToken
  ) {
    return 'process-exclusion restart did not prove a new Bridge PID, session, generation, and generation token';
  }
  if (
    restart.frameContinuity !== true
    || Number(restart.sourceFramesBefore) <= 0
    || Number(restart.sourceFramesAfter) <= 0
    || Number(restart.newFirstFrameTimestampMs) <= Number(restart.oldLastFrameTimestampMs)
    || Number(restart.newFirstFrameReadTimestampMs) <= Number(restart.oldLastFrameReadTimestampMs)
    || Number(restart.oldFramesAfterRestart) !== 0
  ) {
    return 'process-exclusion restart did not prove continuous new-source frames and zero old-generation frames';
  }
  if (
    restart.runtimeReady !== true
    || restart.captureBackend !== 'wasapi-process-exclusion'
    || restart.processLoopbackStatus !== 'ready'
    || restart.sourceSubscriberActive !== true
    || Number(restart.excludedProcessId) !== Number(restart.newBridgeProcessId)
  ) {
    return 'process-exclusion restart did not restore ready WASAPI exclusion targeting the new Bridge PID';
  }
  if (
    restart.playbackRebound !== true
    || restart.physicalPlaybackStatus !== 'ready'
    || Number(restart.oldPlaybackOwnerGeneration) <= 0
    || Number(restart.newPlaybackOwnerGeneration) <= Number(restart.oldPlaybackOwnerGeneration)
    || !restart.oldPhysicalPlaybackDeviceId
    || restart.newPhysicalPlaybackDeviceId !== restart.oldPhysicalPlaybackDeviceId
    || Number(restart.physicalPlaybackRebindDurationMs) < 0
    || Number(restart.physicalPlaybackRebindDurationMs) > 15_000
  ) {
    return 'process-exclusion restart did not rebind a newer playback owner to the same explicit physical endpoint';
  }
  if (
    restart.timingValid !== true
    || !Number.isFinite(Number(restart.startedAtMs))
    || !Number.isFinite(Number(restart.restartTriggeredAtMs))
    || !Number.isFinite(Number(restart.recoveredAtMs))
    || Number(restart.startedAtMs) > Number(restart.oldLastFrameReadTimestampMs)
    || Number(restart.oldLastFrameReadTimestampMs) > Number(restart.restartTriggeredAtMs)
    || Number(restart.restartTriggeredAtMs) > Number(restart.newFirstFrameReadTimestampMs)
    || Number(restart.newFirstFrameReadTimestampMs) > Number(restart.recoveredAtMs)
    || Number(restart.recoveredAtMs) < Number(restart.restartTriggeredAtMs)
    || Number(restart.downtimeMs) > 15_000
  ) {
    return 'process-exclusion restart timing is missing, invalid, or exceeded 15 seconds';
  }
  const metrics = restart.systemMetrics ?? {};
  const metricsStartedAtMs = Date.parse(metrics.startedAt ?? '');
  const metricsFinishedAtMs = Date.parse(metrics.finishedAt ?? '');
  const metricsWallDurationMs = metricsFinishedAtMs - metricsStartedAtMs;
  const restartOffsetMs = Number(restart.restartTriggeredAtMs) - metricsStartedAtMs;
  const postRestartEvidenceMs = metricsFinishedAtMs - Number(restart.restartTriggeredAtMs);
  const expectedRestartOffsetMs = PROCESS_EXCLUSION_RESTART_AFTER_SECONDS * 1_000;
  const requiredPostRestartEvidenceMs = PROCESS_EXCLUSION_RESTART_QUIET_SECONDS * 1_000;
  if (
    restart.metricsProveTransition !== true
    || metrics.valid !== true
    || !Number.isFinite(metricsWallDurationMs)
    || metricsWallDurationMs <= 0
    || Math.abs(Number(metrics.durationMs) - metricsWallDurationMs) > 1_000
    || Number(metrics.samplesWithOldPid) <= 0
    || Number(metrics.samplesWithNewPid) <= 0
    || metrics.oldPidAbsentAfterNew !== true
    || restartOffsetMs < expectedRestartOffsetMs - 5_000
    || restartOffsetMs > expectedRestartOffsetMs + 5_000
    || postRestartEvidenceMs < requiredPostRestartEvidenceMs
  ) {
    return 'process-exclusion restart metrics do not cover the frozen 90-second trigger and 45-second post-restart evidence window';
  }
  return null;
}

function inferredDeviceClass(deviceEvidence) {
  const classificationText = [
    deviceEvidence?.resolvedDeviceId,
    deviceEvidence?.resolvedDeviceName,
    ...(Array.isArray(deviceEvidence?.classificationSignals)
      ? deviceEvidence.classificationSignals
      : []),
  ].filter(Boolean).join(' ').toLowerCase();
  if (/bluetooth|\bbth(?:enum|hf|a2dp)?\b|a2dp|hands[ -]?free/.test(classificationText)) {
    return 'bluetooth';
  }
  if (/\busb\b|usb[\\#_-]|vid_[0-9a-f]{4}/.test(classificationText)) {
    return 'usb';
  }
  return classificationText.trim() ? 'default-speaker' : null;
}

export function strictDeviceEvidenceFailure(report, expectedDeviceClass = null) {
  const evidence = report?.deviceEvidence;
  if (!evidence || typeof evidence !== 'object') {
    return 'strict device matrix requires report.deviceEvidence';
  }
  const requiredStrings = [
    'profileId',
    'deviceClass',
    'requestedDeviceId',
    'resolvedDeviceId',
    'resolvedDeviceName',
    'classificationSource',
    'routeEvidenceSource',
  ];
  const missing = requiredStrings.filter((field) => (
    typeof evidence[field] !== 'string' || !evidence[field].trim()
  ));
  if (missing.length > 0) {
    return `deviceEvidence is missing required field(s): ${missing.join(',')}`;
  }
  if (!DEFAULT_STRICT_DEVICE_CLASSES.includes(evidence.deviceClass)) {
    return `deviceEvidence has unsupported deviceClass=${evidence.deviceClass}`;
  }
  if (evidence.verified !== true || evidence.fixtureOnly === true) {
    return `deviceEvidence is not verified live endpoint evidence: verified=${evidence.verified} fixtureOnly=${evidence.fixtureOnly}`;
  }
  const inferred = inferredDeviceClass(evidence);
  if (inferred !== evidence.deviceClass) {
    return `deviceEvidence classification mismatch: declared=${evidence.deviceClass} inferred=${inferred ?? 'unknown'}`;
  }
  if (expectedDeviceClass && evidence.deviceClass !== expectedDeviceClass) {
    return `deviceEvidence class mismatch: expected=${expectedDeviceClass} actual=${evidence.deviceClass}`;
  }
  return null;
}

/** Strict evidence must be recent and produced from the exact clean HEAD. */
export const DEFAULT_MAX_EVIDENCE_AGE_DAYS = 14;

/**
 * Strict-mode latency gate. Audio-origin p95s come only from cues whose
 * origin is provider offset, an explicit manual audible boundary, or the
 * local 20 ms RMS>=0.002 onset detector. Provider-event fallback samples are
 * intentionally excluded by the Watch report producer.
 * firstTtsQueued/firstPlayback only have a non-representative 12s short
 * sample (1s/2s) as history, so they default to null and are asserted only
 * when configured via --latency-thresholds.
 */
export const DEFAULT_STRICT_LATENCY_THRESHOLDS = {
  audioToRenderFirstSeconds: 8,
  audioToRenderFinalSeconds: 15,
  firstTtsQueuedLatencySeconds: null,
  firstPlaybackLatencySeconds: null,
};

export function normalizeLatencyThresholds(value) {
  const thresholds = { ...DEFAULT_STRICT_LATENCY_THRESHOLDS };
  if (value == null || value === true) return thresholds;
  const entries = typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.split('=').map((part) => part.trim()))
    : Object.entries(value);
  for (const [field, raw] of entries) {
    if (!(field in thresholds)) {
      throw new Error(`unknown latency threshold field: ${field}; expected one of ${Object.keys(thresholds).join(', ')}`);
    }
    if (raw == null || raw === 'off' || raw === 'none') {
      thresholds[field] = null;
      continue;
    }
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new Error(`invalid latency threshold for ${field}: ${raw} (expected a non-negative number of seconds, or off)`);
    }
    thresholds[field] = numeric;
  }
  return thresholds;
}

/**
 * Rejects a passed report whose produced latency fields exceed the configured
 * thresholds. Fields that the run did not produce are not asserted; the
 * failure reason always carries the measured value.
 */
export function strictLatencyFailure(report, options = {}) {
  const thresholds = normalizeLatencyThresholds(options.latencyThresholds);
  const subtitleQueue = report.layers?.app?.data?.subtitleQueue;
  const layerWatchReport = report.layers?.app?.data?.watchSessionReport;
  const watchReport = report.watchSessionReport ?? layerWatchReport;
  const layerWatchSummary = layerWatchReport?.summary;
  const watchSummary = watchReport?.summary;
  if (!subtitleQueue && !watchSummary && !layerWatchSummary) return null;
  const requiresAudioOriginEvidence = watchReport?.status === 'completed'
    && (Number(watchSummary?.cueCount) > 0 || (Array.isArray(watchReport?.cues) && watchReport.cues.length > 0));
  const violations = [];
  for (const [field, threshold] of Object.entries(thresholds)) {
    if (threshold == null) continue;
    const rawMeasured = field === 'audioToRenderFirstSeconds'
      ? layerWatchSummary?.p95AudioToRenderFirstMs ?? watchSummary?.p95AudioToRenderFirstMs
      : field === 'audioToRenderFinalSeconds'
        ? layerWatchSummary?.p95AudioToRenderFinalMs ?? watchSummary?.p95AudioToRenderFinalMs
        : subtitleQueue?.[field];
    const measured = rawMeasured == null
      ? Number.NaN
      : Number(rawMeasured) / (field.startsWith('audioToRender') ? 1_000 : 1);
    if (!Number.isFinite(measured)) {
      if (requiresAudioOriginEvidence && field.startsWith('audioToRender')) {
        violations.push(`${field}=missing high-confidence audio-origin latency evidence`);
      }
      continue;
    }
    if (measured > threshold) {
      violations.push(`${field}=${measured}s exceeds the ${threshold}s threshold`);
    }
  }
  if (violations.length === 0) return null;
  return `latency evidence exceeded threshold(s): ${violations.join('; ')} (adjust with --latency-thresholds field=seconds)`;
}

/**
 * Strict-mode provenance gate: a passed report is still rejected when it is
 * older than the age budget or was not produced by the exact clean checkout
 * currently being verified. Ancestor commits and dirty/untracked source state
 * are intentionally insufficient release evidence.
 */
export function strictProvenanceFailure(report, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeDays = Number(options.maxAgeDays ?? DEFAULT_MAX_EVIDENCE_AGE_DAYS);
  const generatedAtMs = Date.parse(report.generatedAt ?? '');
  if (!Number.isFinite(generatedAtMs)) {
    return 'strict evidence requires a parseable generatedAt timestamp';
  }
  const ageDays = (now - generatedAtMs) / 86_400_000;
  if (ageDays > maxAgeDays) {
    return `evidence is stale: generatedAt=${report.generatedAt} age=${ageDays.toFixed(1)}d exceeds the ${maxAgeDays}d budget; re-run the live matrix`;
  }
  const currentProvenance = options.currentProvenance ?? currentGitProvenance({
    cwd: options.workspaceRoot ?? process.cwd(),
  });
  const provenanceFailure = exactGitProvenanceFailure(
    report.provenance,
    currentProvenance,
    {
      recordedSubject: 'report.provenance',
      currentSubject: 'current checkout provenance',
    },
  );
  if (provenanceFailure) return provenanceFailure;
  const legacyCommit = typeof report.commit === 'string' && report.commit.trim()
    ? report.commit.trim()
    : null;
  if (legacyCommit && legacyCommit !== report.provenance.headCommit.trim()) {
    return `report.commit ${legacyCommit} disagrees with report.provenance.headCommit ${report.provenance.headCommit.trim()}`;
  }
  return null;
}

export function strictManifestProvenanceFailure(manifest, options = {}) {
  const currentProvenance = options.currentProvenance ?? currentGitProvenance({
    cwd: options.workspaceRoot ?? process.cwd(),
  });
  const sourceFailure = exactGitProvenanceFailure(
    manifest?.provenance,
    currentProvenance,
    {
      recordedSubject: 'run manifest provenance',
      currentSubject: 'current checkout provenance',
    },
  );
  if (sourceFailure) return sourceFailure;
  if (manifest?.verification === 'passed') {
    return exactGitProvenanceFailure(
      manifest.verificationProvenance,
      currentProvenance,
      {
        recordedSubject: 'canonical manifest verificationProvenance',
        currentSubject: 'current checkout provenance',
      },
    );
  }
  return null;
}

function basicFailure(entry, options = {}) {
  const feedbackMode = entry.feedbackMode ?? reportFeedbackMode(entry.report);
  const failedLayers = requiredLayersFor(options, feedbackMode).filter(
    (layer) => entry.report.layers?.[layer]?.status !== 'passed',
  );
  const latestFailure = describeLatestFailure(entry, failedLayers, options);
  if (entry.report.verdict !== 'passed' || failedLayers.length > 0) {
    return {
      failedLayers,
      latestFailure,
      reason: [
        `verdict=${entry.report.verdict ?? 'unknown'}`,
        `failureLayer=${entry.report.failureLayer ?? '-'}`,
        `failureReason=${latestFailure.failureReason ?? '-'}`,
        `failedLayers=${failedLayers.join(',') || '-'}`,
      ].join(' '),
    };
  }
  if (options.strict && feedbackMode !== 'echo-cancel') {
    const reason = strictContentFailure(entry.report);
    if (reason) {
      return {
        failedLayers: ['strictContent'],
        latestFailure: describeLatestFailure(entry, ['strictContent'], options, reason),
        reason,
      };
    }
  }
  if (options.strict) {
    const watchReportReason = strictWatchSessionReportFailure(
      entry.report,
      options.expectedModelProtocolProfileIdentity,
    );
    if (watchReportReason) {
      return {
        failedLayers: ['watchSessionReport'],
        latestFailure: describeLatestFailure(entry, ['watchSessionReport'], options, watchReportReason),
        reason: watchReportReason,
      };
    }
    const scenarioReason = feedbackMode === 'echo-cancel'
      ? strictAecScenarioFailure(entry.report)
      : feedbackMode === 'process-exclusion'
        ? strictProcessExclusionRestartFailure(entry.report)
        : null;
    if (scenarioReason) {
      const failedLayer = feedbackMode === 'echo-cancel' ? 'aecScenario' : 'processExclusionRestart';
      return {
        failedLayers: [failedLayer],
        latestFailure: describeLatestFailure(entry, [failedLayer], options, scenarioReason),
        reason: scenarioReason,
      };
    }
    if (options.expectedDeviceClass) {
      const deviceReason = strictDeviceEvidenceFailure(
        entry.report,
        options.expectedDeviceClass,
      );
      if (deviceReason) {
        return {
          failedLayers: ['deviceEvidence'],
          latestFailure: describeLatestFailure(entry, ['deviceEvidence'], options, deviceReason),
          reason: deviceReason,
        };
      }
    }
    const provenanceReason = strictProvenanceFailure(entry.report, options);
    if (provenanceReason) {
      return {
        failedLayers: ['provenance'],
        latestFailure: describeLatestFailure(entry, ['provenance'], options, provenanceReason),
        reason: provenanceReason,
      };
    }
    const latencyReason = strictLatencyFailure(entry.report, options);
    if (latencyReason) {
      return {
        failedLayers: ['latency'],
        latestFailure: describeLatestFailure(entry, ['latency'], options, latencyReason),
        reason: latencyReason,
      };
    }
  }
  return { failedLayers: [], reason: null, latestFailure: null };
}

function invalidCandidateReason(entry) {
  if (!entry) return null;
  if (entry.scopeError) {
    return `scoped Watch Mode report is invalid: ${entry.scopeError} reportPath=${entry.reportPath}`;
  }
  if (entry.parseError) {
    return `latest live report could not be parsed: ${entry.parseError} reportPath=${entry.reportPath}`;
  }
  if (entry.incomplete) {
    const deviceDetail = entry.deviceEvidenceFailure
      ? ` deviceEvidenceFailure=${entry.deviceEvidenceFailure}`
      : '';
    return `latest live report is incomplete: missingLayers=${entry.missingLayers.join(',')}${deviceDetail} reportPath=${entry.reportPath}`;
  }
  return null;
}

function uniqueTail(lines, limit = 12) {
  const output = [];
  const seen = new Set();
  for (const line of lines.filter(Boolean).reverse()) {
    const key = String(line);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(key);
    if (output.length >= limit) break;
  }
  return output.reverse();
}

function describeLatestFailure(entry, failedLayers = [], options = {}, fallbackReason = null) {
  const report = entry.report ?? {};
  const diagnostics = report.diagnostics ?? {};
  const evidence = diagnostics.evidence ?? {};
  const strict = report.layers?.strictContent?.data;
  return {
    reportPath: entry.reportPath,
    directoryName: entry.directoryName,
    modelId: entry.modelId ?? null,
    failureLayer: report.failureLayer ?? null,
    failureReason: report.failureReason
      ?? fallbackReason
      ?? report.layers?.[report.failureLayer]?.reason
      ?? null,
    failedLayers,
    failedSteps: diagnostics.failedSteps ?? [],
    checkFailures: diagnostics.checkFailures ?? [],
    keyEvidence: uniqueTail([
      ...(evidence.appErrors ?? []),
      ...(evidence.providerErrors ?? evidence.appProviderErrors ?? []),
      ...(evidence.appOmniPreconnect ?? []),
      ...(evidence.appReadiness ?? []),
      ...(evidence.bridgeErrors ?? []),
      ...(evidence.bridgeSourceSummary ?? []),
      ...(evidence.bridgeWatchdog ?? []),
      ...(strict?.failures ?? []),
    ], 16),
  };
}

function describeInvalidCandidate(entry) {
  const failureReason = invalidCandidateReason(entry);
  const diagnostics = entry.report?.diagnostics ?? {};
  return {
    reportPath: entry.reportPath,
    directoryName: entry.directoryName,
    modelId: entry.modelId ?? null,
    failureLayer: entry.report?.failureLayer ?? 'evidence',
    failureReason,
    failedLayers: entry.missingLayers ?? [],
    failedSteps: diagnostics.failedSteps ?? [],
    checkFailures: diagnostics.checkFailures ?? [],
    keyEvidence: uniqueTail([
      entry.scopeError ? `scopeError=${entry.scopeError}` : null,
      entry.parseError ? `parseError=${entry.parseError}` : null,
      entry.incomplete ? `missingLayers=${entry.missingLayers.join(',')}` : null,
      ...(diagnostics.evidence?.appErrors ?? []),
      ...(diagnostics.evidence?.providerErrors ?? diagnostics.evidence?.appProviderErrors ?? []),
      ...(diagnostics.evidence?.appOmniPreconnect ?? []),
      ...(diagnostics.evidence?.appReadiness ?? []),
    ], 16),
  };
}

function invalidScopedCandidate(directoryPath, reportPath, options, scopeError) {
  return {
    directoryName: path.basename(directoryPath),
    reportPath,
    report: {
      verdict: 'failed',
      failureLayer: 'evidence',
      generatedAt: null,
      translationRoute: null,
      layers: {},
    },
    reportMtimeMs: fs.existsSync(reportPath) ? fs.statSync(reportPath).mtimeMs : 0,
    modelId: null,
    feedbackMode: 'virtual-driver',
    deviceClass: null,
    deviceEvidenceFailure: null,
    complete: false,
    incomplete: false,
    missingLayers: requiredLayersFor(options),
    scopeError,
  };
}

function loadCandidateDirectory(root, directoryPath, options, scoped) {
  const directoryName = path.relative(root, directoryPath) || path.basename(directoryPath);
  const reportPath = path.join(directoryPath, 'report.json');
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    return scoped
      ? invalidScopedCandidate(directoryPath, reportPath, options, 'run directory does not exist')
      : null;
  }
  if (!fs.existsSync(reportPath)) {
    return scoped
      ? invalidScopedCandidate(directoryPath, reportPath, options, 'run directory is missing report.json')
      : null;
  }
  try {
    const directoryIdentity = process.platform === 'win32'
      ? path.resolve(directoryPath).toLowerCase()
      : path.resolve(directoryPath);
    const report = options.authorizedReports?.get(directoryIdentity) ?? readJson(reportPath);
    const stats = fs.statSync(reportPath);
    if (report.mode !== 'live') {
      return scoped
        ? invalidScopedCandidate(
            directoryPath,
            reportPath,
            options,
            `report mode=${report.mode ?? 'missing'} is non-live and cannot satisfy live evidence`,
          )
        : null;
    }
    const missingLayers = missingRequiredLayers(report, options);
    const deviceEvidenceFailure = options.requireDeviceEvidence
      ? strictDeviceEvidenceFailure(report)
      : null;
    if (deviceEvidenceFailure) missingLayers.push('deviceEvidence');
    return {
      directoryName,
      reportPath,
      report,
      reportMtimeMs: stats.mtimeMs,
      modelId: reportModelId(report),
      feedbackMode: reportFeedbackMode(report),
      deviceClass: report.deviceEvidence?.deviceClass ?? null,
      deviceEvidenceFailure,
      complete: missingLayers.length === 0,
      incomplete: missingLayers.length > 0,
      missingLayers,
    };
  } catch (error) {
    return {
      ...invalidScopedCandidate(directoryPath, reportPath, options, null),
      directoryName,
      parseError: error instanceof Error ? error.message : String(error),
      scopeError: undefined,
    };
  }
}

function loadCandidates(root, options = {}) {
  if (!fs.existsSync(root)) return [];
  const scoped = Array.isArray(options.runDirectories);
  const directories = scoped
    ? options.runDirectories
    : fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => !isExcludedDirectory(entry.name))
        .map((entry) => path.join(root, entry.name));
  return directories
    .map((directoryPath) => loadCandidateDirectory(root, directoryPath, options, scoped))
    .filter(Boolean)
    .sort((left, right) => {
      const timeDiff = evidenceSortTime(right) - evidenceSortTime(left);
      return timeDiff || right.directoryName.localeCompare(left.directoryName);
    });
}

function normalizeModels(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function normalizeDeviceClasses(value) {
  const classes = normalizeModels(value);
  for (const deviceClass of classes) {
    if (!DEFAULT_STRICT_DEVICE_CLASSES.includes(deviceClass)) {
      throw new Error(
        `unsupported device class '${deviceClass}'; expected ${DEFAULT_STRICT_DEVICE_CLASSES.join(',')}`,
      );
    }
  }
  return classes.filter((value, index, list) => list.indexOf(value) === index);
}

function applyMatrixIdentityFailures(modelResults) {
  const failResults = (entries, reason) => {
    for (const entry of entries) {
      entry.ok = false;
      entry.failedLayers = [...new Set([...entry.failedLayers, 'deviceEvidence'])];
      entry.reason = reason;
      entry.latestFailure = entry.latest
        ? describeLatestFailure(entry.latest, ['deviceEvidence'], {}, reason)
        : entry.latestFailure;
    }
  };

  const bySessionId = new Map();
  for (const result of modelResults.filter((entry) => entry.latest)) {
    const sessionId = result.latest.report?.watchSessionReport?.sessionId;
    if (!sessionId) continue;
    const entries = bySessionId.get(sessionId) ?? [];
    entries.push(result);
    bySessionId.set(sessionId, entries);
  }
  for (const [sessionId, entries] of bySessionId) {
    if (entries.length > 1) {
      failResults(
        entries,
        `duplicate live artifact/session reused by multiple matrix cells: sessionId=${sessionId}`,
      );
    }
  }

  const byResolvedDeviceId = new Map();
  for (const result of modelResults.filter((entry) => entry.latest)) {
    const resolvedDeviceId = result.latest.report?.deviceEvidence?.resolvedDeviceId;
    const deviceClass = result.latest.report?.deviceEvidence?.deviceClass;
    if (!resolvedDeviceId || !deviceClass) continue;
    const key = String(resolvedDeviceId).trim().toLowerCase();
    const entries = byResolvedDeviceId.get(key) ?? [];
    entries.push(result);
    byResolvedDeviceId.set(key, entries);
  }
  for (const [resolvedDeviceId, entries] of byResolvedDeviceId) {
    const classes = [...new Set(entries.map((entry) => entry.deviceClass).filter(Boolean))];
    if (classes.length > 1) {
      failResults(
        entries,
        `one physical endpoint cannot satisfy multiple device classes: resolvedDeviceId=${resolvedDeviceId} classes=${classes.join(',')}`,
      );
    }
  }
}

function resolveScopedRunDirectories(root, runDirectories) {
  if (!Array.isArray(runDirectories)) return null;
  if (runDirectories.length === 0) {
    throw new Error('explicit runDirectories scope is empty');
  }
  const seen = new Set();
  return runDirectories.map((directory, index) => {
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new Error(`runDirectories[${index}] must be a non-empty path string`);
    }
    const resolved = path.resolve(root, directory.trim());
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`run directory must be a child of evidence root: ${resolved}`);
    }
    const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(identity)) {
      throw new Error(`duplicate run directory in explicit evidence scope: ${resolved}`);
    }
    seen.add(identity);
    return resolved;
  });
}

export function findWatchModeEvidence(options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  const strict = Boolean(options.strict);
  const currentProvenance = strict
    ? (options.currentProvenance ?? currentGitProvenance({
      cwd: options.workspaceRoot ?? process.cwd(),
    }))
    : null;
  const requestedModels = normalizeModels(options.models);
  const models = requestedModels.length > 0 ? requestedModels : [];
  const requestedFeedbackModes = normalizeModels(options.feedbackModes);
  const feedbackModes = requestedFeedbackModes.length > 0 ? requestedFeedbackModes : ['virtual-driver'];
  const deviceClasses = normalizeDeviceClasses(options.deviceClasses);
  const releaseCells = Array.isArray(options.releaseCells) ? options.releaseCells : null;
  let runDirectories;
  try {
    runDirectories = resolveScopedRunDirectories(root, options.runDirectories);
  } catch (error) {
    return {
      ok: false,
      reason: `invalid explicit Watch Mode run scope: ${error instanceof Error ? error.message : error}`,
      root,
      latest: null,
      candidates: [],
      invalidCandidates: [],
      modelResults: [],
    };
  }
  if (strict && runDirectories === null) {
    return {
      ok: false,
      reason: `strict Watch Mode evidence requires the schema-v${STRICT_MATRIX_SCHEMA_VERSION} budget-balanced authority manifest emitted by run-watch-mode-live-production-coordinator.mjs; scanning outputRoot and --run-directories are disabled`,
      root,
      latest: null,
      candidates: [],
      invalidCandidates: [],
      modelResults: [],
    };
  }
  if (strict && runDirectories && releaseCells) {
    if (runDirectories.length !== releaseCells.length) {
      return {
        ok: false,
        reason: `strict Watch Mode run scope has ${runDirectories.length} run directories; expected exactly ${releaseCells.length} for the balanced paid-live plan`,
        root,
        latest: null,
        candidates: [],
        invalidCandidates: [],
        modelResults: [],
      };
    }
  } else if (strict && runDirectories && models.length > 0) {
    const expectedRunCount = models.length
      * feedbackModes.length
      * (deviceClasses.length > 0 ? deviceClasses.length : 1);
    if (runDirectories.length !== expectedRunCount) {
      return {
        ok: false,
        reason: `strict Watch Mode run scope has ${runDirectories.length} run directories; expected exactly ${expectedRunCount} for the requested model x route x device matrix`,
        root,
        latest: null,
        candidates: [],
        invalidCandidates: [],
        modelResults: [],
      };
    }
  }
  if (!fs.existsSync(root)) {
    return {
      ok: false,
      reason: `watch-mode evidence root does not exist: ${root}`,
      root,
      latest: null,
      candidates: [],
      modelResults: [],
    };
  }

  const candidates = loadCandidates(root, {
    strict,
    requireDeviceEvidence: deviceClasses.length > 0,
    runDirectories,
    authorizedReports: options.authorizedReports,
  });
  const invalidCandidates = candidates.filter(
    (entry) => entry.scopeError || entry.parseError || entry.incomplete,
  );
  const completeCandidates = candidates.filter((entry) => entry.complete);
  const latestCandidate = candidates[0] ?? null;
  if (latestCandidate && !latestCandidate.complete) {
    const reason = invalidCandidateReason(latestCandidate);
    return {
      ok: false,
      reason,
      root,
      latest: null,
      latestFailure: describeInvalidCandidate(latestCandidate),
      candidates,
      invalidCandidates,
      modelResults: [],
    };
  }
  if (completeCandidates.length === 0) {
    const latestInvalid = invalidCandidates[0] ?? null;
    const invalidReason = invalidCandidateReason(latestInvalid);
    return {
      ok: false,
      reason: invalidReason ?? `no complete live watch-mode report found under ${root}`,
      root,
      latest: null,
      latestFailure: latestInvalid ? describeInvalidCandidate(latestInvalid) : null,
      candidates,
      invalidCandidates,
      modelResults: [],
    };
  }

  if (releaseCells) {
    const byDirectory = new Map(completeCandidates.map((entry) => {
      const directory = path.resolve(path.dirname(entry.reportPath));
      return [process.platform === 'win32' ? directory.toLowerCase() : directory, entry];
    }));
    const modelResults = releaseCells.map((plannedCell, index) => {
      const runDirectory = path.resolve(runDirectories[index]);
      const identity = process.platform === 'win32' ? runDirectory.toLowerCase() : runDirectory;
      const latest = byDirectory.get(identity) ?? null;
      if (!latest) {
        return {
          cellId: plannedCell.cellId,
          tier: plannedCell.tier,
          modelId: plannedCell.modelId,
          feedbackMode: plannedCell.feedbackLoopPrevention,
          deviceClass: plannedCell.deviceClass,
          ok: false,
          latest: null,
          failedLayers: [],
          reason: `no complete live watch-mode report found for balanced cell ${plannedCell.cellId}`,
        };
      }
      if (
        latest.modelId !== plannedCell.modelId
        || latest.feedbackMode !== plannedCell.feedbackLoopPrevention
        || latest.deviceClass !== plannedCell.deviceClass
      ) {
        return {
          cellId: plannedCell.cellId,
          tier: plannedCell.tier,
          modelId: plannedCell.modelId,
          feedbackMode: plannedCell.feedbackLoopPrevention,
          deviceClass: plannedCell.deviceClass,
          ok: false,
          latest,
          failedLayers: ['identity'],
          reason: `balanced cell identity mismatch for ${plannedCell.cellId}`,
        };
      }
      const failure = basicFailure(latest, {
        strict,
        expectedDeviceClass: plannedCell.deviceClass,
        expectedModelProtocolProfileIdentity: plannedCell.modelProtocolProfileIdentity,
        now: options.now,
        maxAgeDays: options.maxAgeDays,
        currentProvenance,
        latencyThresholds: options.latencyThresholds,
      });
      return {
        cellId: plannedCell.cellId,
        tier: plannedCell.tier,
        modelId: plannedCell.modelId,
        feedbackMode: plannedCell.feedbackLoopPrevention,
        deviceClass: plannedCell.deviceClass,
        ok: failure.reason == null,
        latest,
        failedLayers: failure.failedLayers,
        reason: failure.reason,
        latestFailure: failure.latestFailure,
      };
    });
    applyMatrixIdentityFailures(modelResults);
    const failed = modelResults.filter((item) => !item.ok);
    return {
      ok: failed.length === 0,
      reason: failed.length === 0
        ? null
        : `balanced Watch Mode evidence failed: ${failed.map((item) => `${item.cellId}: ${item.reason}`).join('; ')}`,
      root,
      latest: modelResults[0]?.latest ?? null,
      failedLayers: [...new Set(modelResults.flatMap((item) => item.failedLayers))],
      candidates: completeCandidates,
      invalidCandidates,
      modelResults,
    };
  }

  if (models.length > 0) {
    const requiredDeviceClasses = deviceClasses.length > 0 ? deviceClasses : [null];
    const modelResults = models.flatMap((model) => feedbackModes.flatMap((feedbackMode) => (
      requiredDeviceClasses.map((deviceClass) => {
      const latest = completeCandidates.find(
        (entry) => entry.modelId === model
          && entry.feedbackMode === feedbackMode
          && (deviceClass === null || entry.deviceClass === deviceClass),
      );
      if (!latest) {
        const deviceLabel = deviceClass ? ` deviceClass ${deviceClass}` : '';
        return {
          modelId: model,
          feedbackMode,
          deviceClass,
          ok: false,
          latest: null,
          failedLayers: [],
          reason: `no complete live watch-mode report found for model ${model} feedbackLoopPrevention ${feedbackMode}${deviceLabel}`,
        };
      }
      const failure = basicFailure(latest, {
        strict,
        expectedDeviceClass: deviceClass,
        expectedModelProtocolProfileIdentity: RELEASE_MODELS.includes(model)
          ? deriveWatchModelProtocolIdentity(model)
          : null,
        now: options.now,
        maxAgeDays: options.maxAgeDays,
        currentProvenance,
        latencyThresholds: options.latencyThresholds,
      });
      return {
        modelId: model,
        feedbackMode,
        deviceClass,
        ok: failure.reason == null,
        latest,
        failedLayers: failure.failedLayers,
        reason: failure.reason,
        latestFailure: failure.latestFailure,
      };
      })
    )));
    if (deviceClasses.length > 0) applyMatrixIdentityFailures(modelResults);
    const failed = modelResults.filter((item) => !item.ok);
    return {
      ok: failed.length === 0,
      reason: failed.length === 0
        ? null
        : `watch-mode evidence failed for model(s): ${failed.map((item) => `${item.modelId}[${item.feedbackMode}][${item.deviceClass ?? 'single-device'}]: ${item.reason}`).join('; ')}`,
      root,
      latest: modelResults[0]?.latest ?? null,
      failedLayers: [...new Set(modelResults.flatMap((item) => item.failedLayers))],
      candidates: completeCandidates,
      invalidCandidates,
      modelResults,
    };
  }

  const eligibleCandidates = completeCandidates.filter((entry) => feedbackModes.includes(entry.feedbackMode));
  const latest = eligibleCandidates[0];
  if (!latest) {
    return {
      ok: false,
      reason: `no complete live watch-mode report found for feedbackLoopPrevention ${feedbackModes.join(',')} under ${root}`,
      root,
      latest: null,
      candidates: completeCandidates,
      invalidCandidates,
      modelResults: [],
    };
  }
  const failure = basicFailure(latest, {
    strict,
    now: options.now,
    maxAgeDays: options.maxAgeDays,
    currentProvenance,
    latencyThresholds: options.latencyThresholds,
  });
  return {
    ok: failure.reason == null,
    reason: failure.reason == null
      ? null
      : `latest live watch-mode report is not passed: ${failure.reason}`,
    root,
    latest,
    failedLayers: failure.failedLayers,
    latestFailure: failure.latestFailure,
    candidates: completeCandidates,
    invalidCandidates,
    modelResults: [],
  };
}

function printEntry(entry, label = 'Latest Watch Mode report') {
  if (!entry) return;
  const report = entry.report;
  console.log(`${label}: ${entry.reportPath}`);
  console.log(`ModelId: ${entry.modelId ?? '-'}`);
  console.log(`FeedbackLoopPrevention: ${entry.feedbackMode ?? '-'}`);
  console.log(`DeviceClass: ${entry.deviceClass ?? report.deviceEvidence?.deviceClass ?? '-'}`);
  console.log(`ResolvedDeviceId: ${report.deviceEvidence?.resolvedDeviceId ?? '-'}`);
  console.log(`GeneratedAt: ${report.generatedAt ?? '-'}`);
  console.log(`TranslationRoute: ${report.translationRoute ?? '-'}`);
  console.log(`Verdict: ${report.verdict ?? '-'}`);
  console.log(`FailureLayer: ${report.failureLayer ?? '-'}`);
  console.log(`FailureReason: ${report.failureReason ?? '-'}`);
  const strict = report.layers?.strictContent?.data;
  if (strict) {
    console.log(`StrictContent: applicable=${strict.applicable ?? '-'} passed=${strict.passed ?? '-'} coverage=${strict.coverage ?? '-'}`);
  }
}

function printFailureDetails(failure, label = 'Failure details') {
  if (!failure) return;
  console.error(`${label}: ${failure.failureReason ?? '-'}`);
  if (failure.reportPath) console.error(`ReportPath: ${failure.reportPath}`);
  for (const step of failure.failedSteps ?? []) {
    console.error(`FailedStep: ${step.name}: ${step.error ?? '-'}`);
  }
  for (const evidence of failure.keyEvidence ?? []) {
    console.error(`Evidence: ${evidence}`);
  }
}

function printEvidence(result) {
  if (result.modelResults?.length > 0) {
    for (const model of result.modelResults) {
      const label = model.feedbackMode
        ? `${model.modelId} [${model.feedbackMode}] [${model.deviceClass ?? 'single-device'}]`
        : model.modelId;
      if (model.latest) printEntry(model.latest, `Latest Watch Mode report for ${label}`);
      if (!model.ok) {
        console.error(`Model ${label} failed evidence gate: ${model.reason}`);
        printFailureDetails(model.latestFailure, `Failure details for ${label}`);
      }
    }
  } else if (result.latest) {
    printEntry(result.latest);
  }
  if (result.ok) {
    console.log('Watch Mode live evidence gate passed.');
    return;
  }
  console.error(`Watch Mode live evidence gate failed: ${result.reason}`);
  printFailureDetails(result.latestFailure);
  const invalidCandidates = result.invalidCandidates ?? [];
  for (const invalid of invalidCandidates.slice(0, INVALID_CANDIDATE_PRINT_LIMIT)) {
    if (invalid.scopeError) {
      console.error(`InvalidScopedReport: ${invalid.reportPath}: ${invalid.scopeError}`);
    } else if (invalid.parseError) {
      console.error(`InvalidReport: ${invalid.reportPath}: ${invalid.parseError}`);
    } else if (invalid.incomplete) {
      console.error(`IncompleteReport: ${invalid.reportPath}: missingLayers=${invalid.missingLayers.join(',')}`);
    }
  }
  if (invalidCandidates.length > INVALID_CANDIDATE_PRINT_LIMIT) {
    console.error(`InvalidReportSummary: ${invalidCandidates.length - INVALID_CANDIDATE_PRINT_LIMIT} older incomplete/invalid report(s) omitted; newest ${INVALID_CANDIDATE_PRINT_LIMIT} shown.`);
  }
  console.error('Next step: npm run test:watch-mode-live:matrix');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseLooseArgs(process.argv.slice(2));
  const strict = args.strict === true || args.strict === 'true';
  const currentProvenance = strict ? currentGitProvenance() : null;
  const models = normalizeModels(args.models)
    .concat(strict && !args.models ? DEFAULT_STRICT_MODELS : [])
    .filter((value, index, list) => list.indexOf(value) === index);
  const feedbackModes = normalizeModels(args['feedback-modes']);
  let deviceClasses;
  try {
    deviceClasses = normalizeDeviceClasses(args['device-classes'])
      .concat(strict && !args['device-classes'] ? DEFAULT_STRICT_DEVICE_CLASSES : [])
      .filter((value, index, list) => list.indexOf(value) === index);
  } catch (error) {
    console.error(`Invalid --device-classes: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    process.exit();
  }
  let latencyThresholds;
  try {
    latencyThresholds = normalizeLatencyThresholds(args['latency-thresholds']);
  } catch (error) {
    console.error(`Invalid --latency-thresholds: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    process.exit();
  }
  let runDirectories;
  let runManifestResolution;
  let verifiedAuthority;
  let authorizedReports;
  try {
    if (args['run-manifest'] && args['run-directories']) {
      throw new Error('provide exactly one of --run-manifest or --run-directories, not both');
    }
    if (args['run-manifest']) {
      const resolved = readRunManifest(String(args['run-manifest']));
      runManifestResolution = resolved;
      if (strict && resolved.manifest.evidenceMode !== 'live') {
        throw new Error(`strict evidence requires a live manifest; evidenceMode=${resolved.manifest.evidenceMode ?? 'missing'}`);
      }
      if (strict && resolved.manifest.strict !== true) {
        throw new Error('strict evidence requires a manifest produced by a strict matrix run');
      }
      if (strict) {
        const provenanceFailure = strictManifestProvenanceFailure(resolved.manifest, {
          currentProvenance,
        });
        if (provenanceFailure) {
          throw new Error(`strict run manifest provenance failed: ${provenanceFailure}`);
        }
        const authority = verifyStrictMatrixAuthority({
          manifestPath: resolved.manifestPath,
          manifest: resolved.manifest,
          evidenceRoot: path.resolve(args.root ?? DEFAULT_ROOT),
          currentProvenance,
          workspaceRoot: process.cwd(),
          maxAgeDays: args['max-age-days'],
        });
        verifiedAuthority = authority;
        runDirectories = authority.runDirectories;
        authorizedReports = authority.authorizedReports;
      }
      if (!strict) runDirectories = resolved.runDirectories;
    } else if (args['run-directories']) {
      if (strict) {
        throw new Error(`strict evidence does not accept --run-directories; use the schema-v${STRICT_MATRIX_SCHEMA_VERSION} authority manifest emitted by run-watch-mode-live-production-coordinator.mjs`);
      }
      runDirectories = normalizeRunDirectories(String(args['run-directories']), {
        baseDirectory: path.resolve(args.root ?? DEFAULT_ROOT),
      });
    }
  } catch (error) {
    console.error(`Invalid explicit run scope: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    process.exit();
  }
  const result = findWatchModeEvidence({
    root: args.root ?? DEFAULT_ROOT,
    strict,
    models,
    feedbackModes,
    deviceClasses,
    runDirectories,
    authorizedReports,
    releaseCells: strict ? LIVE_LLM_CELLS : null,
    currentProvenance,
    maxAgeDays: args['max-age-days'],
    latencyThresholds,
  });
  printEvidence(result);
  if (
    result.ok
    && strict
    && runManifestResolution
    && runManifestResolution.manifest.verification !== 'passed'
  ) {
    const verification = writeStrictMatrixVerificationReceipt({
      manifestPath: runManifestResolution.manifestPath,
      manifest: runManifestResolution.manifest,
      authority: verifiedAuthority,
      currentProvenance,
    });
    console.log(`StrictMatrixVerificationReceipt: ${verification.receiptPath}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}
