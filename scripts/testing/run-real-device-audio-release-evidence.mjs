import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  compactTimestamp,
  ensureDir,
  isMain,
  parseCliArgs,
  repoRoot,
  writeJson,
} from '../lib/testing-common.mjs';
import {
  currentGitProvenance,
  gitProvenanceShapeFailure,
} from './git-provenance.mjs';
import {
  REAL_DEVICE_AUDIO_EMITTER_ID,
  REAL_DEVICE_AUDIO_EMITTER_VERSION,
  REAL_DEVICE_AUDIO_SCHEMA_VERSION,
  REAL_DEVICE_AUDIO_AUTHORITY_COLLECTOR_ID,
  REAL_DEVICE_AUDIO_AUTHORITY_COLLECTOR_VERSION,
  canonicalRealDeviceAudioManifestPath,
  fileReceipt,
  inspectAuthorizedRealDeviceCell,
  resolveCanonicalRealDeviceAudioAuthority,
  sha256File,
  validateRealDeviceAudioEvidence,
} from './real-device-audio-release-evidence.mjs';

const DEFAULT_OUTPUT_ROOT = 'artifacts/testing/real-device-audio-release-evidence';
const DEFAULT_COLLECTOR_OUTPUT_ROOT = 'artifacts/testing/release-manual-collector';
const DEFAULT_MAX_AGE_DAYS = 14;

const portable = (value) => String(value).split(path.sep).join('/');
const valueFrom = (object, camel, snake) => object?.[camel] ?? object?.[snake];

export function parseRealDeviceAudioReleaseArgs(argv) {
  return parseCliArgs(argv, {
    defaults: {
      outputRoot: DEFAULT_OUTPUT_ROOT,
      collectorOutputRoot: DEFAULT_COLLECTOR_OUTPUT_ROOT,
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    },
  });
}

export function buildRealDeviceAudioReleasePlan({
  workspaceRoot = repoRoot,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  collectorOutputRoot = DEFAULT_COLLECTOR_OUTPUT_ROOT,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  now = new Date(),
  suffix = crypto.randomUUID().slice(0, 8),
  source,
  manifestPath,
  dryRun,
  simulated,
  skip,
} = {}) {
  if ([source, manifestPath, dryRun, simulated, skip].some((value) => value !== undefined)) {
    throw new Error('real-device audio production emitter does not accept source/manifest/dry-run/simulated/skip overrides');
  }
  const provenanceFailure = gitProvenanceShapeFailure(provenance, 'real-device source provenance');
  if (provenanceFailure) throw new Error(provenanceFailure);
  const parsedAge = Number(maxAgeDays);
  if (!Number.isFinite(parsedAge) || parsedAge < 0 || parsedAge > 14) {
    throw new Error('--max-age-days must be between 0 and 14');
  }
  const absoluteWorkspace = path.resolve(workspaceRoot);
  const canonicalManifestPath = canonicalRealDeviceAudioManifestPath(absoluteWorkspace);
  const outputBase = path.resolve(absoluteWorkspace, outputRoot);
  const collectorBase = path.resolve(absoluteWorkspace, collectorOutputRoot);
  const evidenceRoot = path.dirname(canonicalManifestPath);
  if (outputBase === evidenceRoot || outputBase.startsWith(`${evidenceRoot}${path.sep}`)) {
    throw new Error('real-device emitter output root may not be inside canonical Watch Mode authority');
  }
  const runDirectory = path.join(
    outputBase,
    provenance.headCommit.slice(0, 12),
    `${compactTimestamp(now)}-process-exclusion-default-speaker-${suffix}`,
  );
  return {
    workspaceRoot: absoluteWorkspace,
    provenance,
    canonicalManifestPath,
    outputRoot: outputBase,
    collectorOutputRoot: collectorBase,
    runDirectory,
    maxAgeDays: parsedAge,
    startedAt: now.toISOString(),
    invocationId: crypto.randomUUID(),
  };
}

const copyFile = (from, to) => {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
};

const copyAuthorizedCellRaw = (resolved, targetRoot) => {
  const artifactByPath = new Map(resolved.receipt.artifacts.map((artifact) => [artifact.path, artifact]));
  for (const [relativePath, authority] of artifactByPath) {
    const from = path.join(resolved.runDirectory, ...relativePath.split('/'));
    const to = path.join(targetRoot, ...relativePath.split('/'));
    copyFile(from, to);
    const actual = fileReceipt(to);
    if (actual.sha256 !== authority.sha256 || actual.bytes !== Number(authority.bytes)) {
      throw new Error(`copied raw artifact does not match cell receipt: ${relativePath}`);
    }
  }
};

const aliasAuthorizedArtifact = (runDirectory, alias, rawPath) => copyFile(
  path.join(runDirectory, 'cell-raw', ...rawPath.split('/')),
  path.join(runDirectory, alias),
);

const buildEvidenceSummary = (plan, resolved, facts, capturedAt) => {
  const fingerprint = facts.fingerprint;
  const physicalProbe = JSON.parse(fs.readFileSync(
    path.join(resolved.runDirectory, 'physical-output-probe.json'),
    'utf8',
  ).replace(/^\uFEFF/, ''));
  const physicalWav = fileReceipt(path.join(plan.runDirectory, 'real-device-audio.wav'));
  const physicalPcm = fileReceipt(path.join(plan.runDirectory, 'real-device-audio-16k-mono.pcm'));
  const sourcePcm = fileReceipt(path.join(plan.runDirectory, 'real-device-source-16k-mono.pcm'));
  const referencePcm = fileReceipt(path.join(plan.runDirectory, 'real-device-reference-16k-mono.pcm'));
  const fingerprintPhysical = fileReceipt(
    path.join(plan.runDirectory, 'process-exclusion-physical-output.wav'),
  );
  const fingerprintSource = fileReceipt(
    path.join(plan.runDirectory, 'process-exclusion-source-pipe.wav'),
  );
  return {
    schemaVersion: REAL_DEVICE_AUDIO_SCHEMA_VERSION,
    artifactKind: 'real-device-audio-production-probe',
    collectorId: REAL_DEVICE_AUDIO_AUTHORITY_COLLECTOR_ID,
    collectorVersion: REAL_DEVICE_AUDIO_AUTHORITY_COLLECTOR_VERSION,
    invocationId: plan.invocationId,
    capturedAt,
    productionMode: true,
    passed: true,
    simulated: false,
    dryRun: false,
    skipped: false,
    selectedCell: facts.cell,
    authority: {
      sourceHeadCommit: plan.provenance.headCommit,
      canonicalManifestPath: portable(path.relative(plan.workspaceRoot, resolved.manifestPath)),
      canonicalManifestSha256: sha256File(resolved.manifestPath),
      cellReceiptPath: portable(path.relative(plan.workspaceRoot, resolved.receiptPath)),
      cellReceiptSha256: sha256File(resolved.receiptPath),
      rawInventoryCount: resolved.receipt.artifacts.length,
    },
    endpoint: {
      requestedId: facts.device.requestedDeviceId,
      id: facts.device.resolvedDeviceId,
      name: facts.device.resolvedDeviceName,
      deviceClass: facts.device.deviceClass,
      profileId: facts.device.profileId,
      classificationSource: facts.device.classificationSource,
      classificationSignals: facts.device.classificationSignals,
      routeEvidenceSource: facts.device.routeEvidenceSource,
    },
    processes: {
      desktopProcessId: facts.desktopProcessId,
      physicalRecorderProcessId: facts.physicalRecorderProcessId,
      mediaInjectorProcessId: facts.mediaInjectorProcessId,
      oldBridgeProcessId: facts.oldBridgeProcessId,
      newBridgeProcessId: facts.newBridgeProcessId,
      fingerprintBridgeProcessId: Number(valueFrom(fingerprint, 'bridgeProcessId', 'bridge_process_id')),
      fingerprintExternalPlaybackProcessId: Number(valueFrom(
        fingerprint,
        'externalPlayerProcessId',
        'external_player_process_id',
      )),
      fingerprintBridgeChildPlaybackProcessId: Number(valueFrom(
        fingerprint,
        'bridgeChildPlayerProcessId',
        'bridge_child_player_process_id',
      )),
    },
    session: {
      sessionId: facts.watch.sessionId,
      durationMs: Number(facts.watch.summary.durationMs),
      status: facts.watch.status,
      controlledBridgeRestartCompleted: true,
      oldFramesAfterRestart: 0,
    },
    subtitles: {
      expectedCueCount: facts.expectedCueCount,
      acceptedCueCount: facts.acceptedCueCount,
      acceptancePercent: 100,
      acceptedCueIds: facts.acceptedCueIds,
      unrenderedCueCount: 0,
      droppedCueCount: 0,
    },
    playback: {
      completedCueCount: facts.playbackSummary.completedCueCount,
      failedCueCount: facts.playbackSummary.failedCueCount,
      completedCueIds: facts.playbackSummary.completedCueIds,
      playbackFramesWrittenBefore: Number(physicalProbe.playbackFramesWrittenBefore),
      playbackFramesWrittenAfter: Number(physicalProbe.playbackFramesWrittenAfter),
    },
    audio: {
      physicalFrames: facts.physicalPcmFrames,
      sourceFrames: facts.providerInputFrames,
      translatedFrames: facts.translatedFrames,
      translatedFrameBasis: 'bridge-completed-estimated-duration-48khz',
      referenceFrames: facts.sourceReferenceFrames,
      physicalWav: {
        path: 'real-device-audio.wav',
        ...physicalWav,
        capturedFrames: facts.recording.frames,
        durationSeconds: facts.recording.durationSeconds,
        rms: facts.recording.rms,
        peak: facts.recording.peak,
      },
      physicalPcm16k: { path: 'real-device-audio-16k-mono.pcm', ...physicalPcm },
      sourcePcm16k: { path: 'real-device-source-16k-mono.pcm', ...sourcePcm },
      referencePcm16k: { path: 'real-device-reference-16k-mono.pcm', ...referencePcm },
      fingerprintPhysicalWav: {
        path: 'process-exclusion-physical-output.wav',
        ...fingerprintPhysical,
      },
      fingerprintSourceWav: {
        path: 'process-exclusion-source-pipe.wav',
        ...fingerprintSource,
      },
    },
    content: {
      physicalSttPassed: facts.content.passed,
      contentConsistencyPassed: facts.content.contentConsistency.passed,
      sourceChars: String(facts.content.source ?? '').trim().length,
      translatedChars: [
        facts.content.translation,
        facts.content.subtitleText,
        facts.content.segmentTranslationText,
      ].map((value) => String(value ?? '').trim()).join('\n').trim().length,
      queuedSegments: Number(facts.content.translatedSpeech.queuedSegments),
      playedSegments: Number(facts.content.translatedSpeech.playedSegments),
    },
    route: {
      sourceCaptureMode: valueFrom(fingerprint, 'sourceCaptureMode', 'source_capture_mode'),
      captureBackend: valueFrom(fingerprint, 'captureBackend', 'capture_backend'),
      processLoopbackStatus: valueFrom(
        fingerprint,
        'processLoopbackStatus',
        'process_loopback_status',
      ),
      excludedProcessId: Number(valueFrom(fingerprint, 'excludedProcessId', 'excluded_process_id')),
    },
    fingerprint: {
      translationFrequencyHz: Number(valueFrom(
        fingerprint,
        'translationFrequencyHz',
        'translation_frequency_hz',
      )),
      externalFrequencyHz: Number(valueFrom(
        fingerprint,
        'externalFrequencyHz',
        'external_frequency_hz',
      )),
      bridgeChildFrequencyHz: Number(valueFrom(
        fingerprint,
        'bridgeChildFrequencyHz',
        'bridge_child_frequency_hz',
      )),
      physicalTranslationComponent: Number(valueFrom(
        fingerprint,
        'physicalTranslationComponent',
        'physical_translation_component',
      )),
      sourceTranslationComponent: Number(valueFrom(
        fingerprint,
        'sourceTranslationComponent',
        'source_translation_component',
      )),
      physicalExternalComponent: Number(valueFrom(
        fingerprint,
        'physicalExternalComponent',
        'physical_external_component',
      )),
      sourceExternalComponent: Number(valueFrom(
        fingerprint,
        'sourceExternalComponent',
        'source_external_component',
      )),
    },
    zeroErrors: {
      routeFailures: facts.playbackSummary.failedCueCount,
      cueDrops: Number(facts.watch.droppedCueCount),
      invalidSamples: Number(physicalProbe.invalidSamples ?? 0),
    },
  };
};

export function materializeRealDeviceAudioReleaseEvidence({
  plan,
  resolved,
  completedAt = new Date().toISOString(),
} = {}) {
  if (!plan || !resolved) throw new Error('real-device materialization requires plan and authority');
  const inspected = inspectAuthorizedRealDeviceCell(resolved);
  if (inspected.issues.length > 0) {
    throw new Error(`authorized real-device cell failed E2E validation:\n- ${inspected.issues.join('\n- ')}`);
  }
  if (fs.existsSync(plan.runDirectory)) {
    throw new Error(`real-device audio output directory already exists: ${plan.runDirectory}`);
  }
  ensureDir(plan.runDirectory);
  try {
    copyFile(resolved.manifestPath, path.join(plan.runDirectory, 'canonical-matrix-manifest.json'));
    copyFile(resolved.receiptPath, path.join(plan.runDirectory, 'matrix-cell-authority.json'));
    copyAuthorizedCellRaw(resolved, path.join(plan.runDirectory, 'cell-raw'));
    for (const [alias, rawPath] of [
      ['real-device-audio.wav', 'physical-output-recording.wav'],
      ['real-device-audio-16k-mono.pcm', 'physical-output-recording-16k-mono.pcm'],
      ['real-device-source-16k-mono.pcm', 'provider-input-16k-mono.pcm'],
      ['real-device-reference-16k-mono.pcm', 'source-media-reference-16k-mono.pcm'],
      ['process-exclusion-physical-output.wav', 'physical-output-probe-runtime/process-exclusion-physical-output.wav'],
      ['process-exclusion-source-pipe.wav', 'physical-output-probe-runtime/process-exclusion-source-pipe.wav'],
    ]) aliasAuthorizedArtifact(plan.runDirectory, alias, rawPath);

    const capturedAt = resolved.report.generatedAt;
    const timeline = {
      schemaVersion: REAL_DEVICE_AUDIO_SCHEMA_VERSION,
      artifactKind: 'real-device-audio-authorized-timeline',
      invocationId: plan.invocationId,
      sessionId: inspected.facts.watch.sessionId,
      selectedCell: resolved.cell,
      watchEvents: inspected.facts.watch.events,
      translationPlaybackEvents: inspected.facts.playbackTimeline,
    };
    writeJson(path.join(plan.runDirectory, 'real-device-audio-timeline.json'), timeline);
    const evidence = buildEvidenceSummary(plan, resolved, inspected.facts, capturedAt);
    writeJson(path.join(plan.runDirectory, 'real-device-audio-probe.json'), evidence);
    const emitter = {
      schemaVersion: REAL_DEVICE_AUDIO_SCHEMA_VERSION,
      artifactKind: 'real-device-audio-release-evidence-emitter-result',
      emitterId: REAL_DEVICE_AUDIO_EMITTER_ID,
      emitterVersion: REAL_DEVICE_AUDIO_EMITTER_VERSION,
      scenarioId: 'E2E-REAL-DEVICE-AUDIO',
      invocationId: plan.invocationId,
      status: 'completed',
      productionMode: true,
      simulated: false,
      dryRun: false,
      skipped: false,
      startedAt: plan.startedAt,
      completedAt,
      sourceProvenance: plan.provenance,
      sourceHeadCommit: plan.provenance.headCommit,
      canonicalManifestSha256: sha256File(
        path.join(plan.runDirectory, 'canonical-matrix-manifest.json'),
      ),
      cellReceiptSha256: sha256File(path.join(plan.runDirectory, 'matrix-cell-authority.json')),
      evidenceSha256: sha256File(path.join(plan.runDirectory, 'real-device-audio-probe.json')),
      timelineSha256: sha256File(path.join(plan.runDirectory, 'real-device-audio-timeline.json')),
    };
    writeJson(path.join(plan.runDirectory, 'emitter-result.json'), emitter);
    const checked = validateRealDeviceAudioEvidence(plan.runDirectory, {
      workspaceRoot: plan.workspaceRoot,
      currentProvenance: plan.provenance,
      now: Date.parse(completedAt),
      maxAgeDays: plan.maxAgeDays,
      authorityResolver: () => resolved,
    });
    if (checked.issues.length > 0 || !checked.summary) {
      throw new Error(`assembled real-device evidence failed self-validation:\n- ${checked.issues.join('\n- ')}`);
    }
    return { checked, emitter, evidence, timeline };
  } catch (error) {
    fs.rmSync(plan.runDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function runRealDeviceAudioReleaseEvidence({
  plan,
  authorityResolver = resolveCanonicalRealDeviceAudioAuthority,
  collectEvidence,
  now = () => new Date(),
} = {}) {
  if (!plan) throw new Error('real-device audio release evidence plan is required');
  if (typeof collectEvidence !== 'function') {
    throw new Error('real-device raw packaging is private; invoke the canonical production runner entrypoint');
  }
  const resolved = authorityResolver({
    workspaceRoot: plan.workspaceRoot,
    manifestPath: plan.canonicalManifestPath,
    currentProvenance: plan.provenance,
    now: Date.parse(plan.startedAt),
    maxAgeDays: plan.maxAgeDays,
  });
  const completedAt = now().toISOString();
  materializeRealDeviceAudioReleaseEvidence({ plan, resolved, completedAt });
  try {
    const collected = await collectEvidence({
      source: plan.runDirectory,
      scenarioId: 'E2E-REAL-DEVICE-AUDIO',
      outputRoot: plan.collectorOutputRoot,
      workspaceRoot: plan.workspaceRoot,
      provenance: plan.provenance,
      now: new Date(completedAt),
    });
    return {
      scenarioId: 'E2E-REAL-DEVICE-AUDIO',
      invocationId: plan.invocationId,
      selectedCell: resolved.cell,
      rawDirectory: plan.runDirectory,
      canonicalManifestPath: plan.canonicalManifestPath,
      packageDirectory: collected.packageDirectory,
      manifestPath: collected.manifestPath,
    };
  } catch (error) {
    fs.rmSync(plan.runDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (isMain(import.meta.url)) {
  setImmediate(async () => {
    try {
      const args = parseRealDeviceAudioReleaseArgs(process.argv.slice(2));
      const { collectRealDeviceAudioReleaseManualEvidence } = await import(
        './release-manual-collector.mjs'
      );
      const result = await collectRealDeviceAudioReleaseManualEvidence({
        scenarioId: 'E2E-REAL-DEVICE-AUDIO',
        ...args,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  });
}
