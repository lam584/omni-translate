import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLooseArgs } from '../lib/testing-common.mjs';
import {
  WATCH_MODE_RUN_COLLECTION_SCHEMA,
  writeWatchModeRunCollection,
} from './watch-mode-run-collection.mjs';

export const WATCH_MODE_LIVE_FIXTURE_FILES = [
  'run-collection.json',
  'run-metadata.json',
  'fixture-evidence.raw.json',
  'app.log',
  'bridge-service.log',
];

const healthyDriver = {
  Endpoint: 'Omni Translate Synthetic Virtual Speaker',
  RootDeviceStatus: 'OK',
  DriverHealth: 'running',
  ToneFrames: 48000,
  TonePeak: 0.5,
  ToneRms: 0.2,
  InvalidSamples: 0,
};

const healthyBridge = {
  probePassed: true,
  bridgeState: 'running',
  driverHealth: 'running',
  sourceSubscriberActive: true,
  sourceReadCalls: 12,
  sourceFramePayloadBytes: 23040,
  droppedFrameCount: 0,
};

const healthyPhysicalOutput = {
  passed: true,
  physicalPlaybackDeviceId: 'synthetic-default',
  resolvedPhysicalPlaybackDeviceId: 'synthetic-speaker-1',
  resolvedPhysicalPlaybackDeviceName: 'Synthetic Speakers',
  playbackFramesWrittenBefore: 0,
  playbackFramesWrittenAfter: 96000,
  capturedFrames: 96000,
  rms: 0.08,
  toneComponent: 0.07,
  invalidSamples: 0,
};

const healthyPhysicalOutputContent = {
  passed: true,
  source: 'synthetic watch mode fixture',
  translation: 'synthetic watch mode fixture',
  subtitleText: 'synthetic watch mode fixture',
  recording: {
    passed: true,
    recordingPath: 'synthetic-physical-output-recording.wav',
    transcriptionPcmPath: 'synthetic-physical-output-recording-16k-mono.pcm',
    capturedFrames: 96000,
    rms: 0.08,
  },
};

export function generateWatchModeLiveFixture({ root, fixture = 'pass' }) {
  if (fixture !== 'pass') {
    throw new Error(`Only the built-in 'pass' fixture can be generated; received '${fixture}'.`);
  }
  if (!root) {
    throw new Error('A fixture root is required.');
  }

  const fixtureDirectory = path.resolve(root, fixture);
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  const snapshots = {
    schemaVersion: 1,
    feedbackLoopPrevention: 'virtual-driver',
    translationRoute: 'native',
    driver: healthyDriver,
    wasapi: healthyDriver,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContentRaw: healthyPhysicalOutputContent,
    speechSegmentation: {
      queuedSegments: 1,
      playedSegments: 1,
      maxSourceChars: 28,
      maxTranslatedChars: 28,
    },
    app: {
      routeState: 'capturing',
      overlayVisible: true,
      subtitleCueCount: 1,
    },
    provider: {
      totalCalls: 1,
      failedCalls: 0,
    },
  };
  const steps = [
    { schemaVersion: 'watch-mode-step/v2', id: 'synthetic-driver-probe', phase: 'driverProbe', status: 'passed', startedAt: null, endedAt: null, durationMs: 0, data: healthyDriver, error: null },
    { schemaVersion: 'watch-mode-step/v2', id: 'synthetic-watch-route', phase: 'readiness', status: 'passed', startedAt: null, endedAt: null, durationMs: 0, data: { routeState: 'capturing' }, error: null },
  ];
  // Lines carry the trailing ` sid=<value>` session token appended by the
  // unified logging pipeline; load-bearing markers stay verbatim before it.
  const appLog = [
    'watch_mode.route_start | direction=inbound routeMode=watch sid=0198fixturesid',
    'watch_mode.omni_session_config | model=synthetic-model realtimeAudioMode=server_vad outputMode=text-and-audio inputAudioFormat=pcm16 isLivetranslate=false subtitleTranslateActive=false sid=0198fixturesid',
    '[AUDIO] playback request received: cue_id=synthetic-audio-1 samples=24000 sample_rate_hz=24000 duration_ms=1000 enabled=true local_playback=true virtual_mic=false sid=0198fixturesid',
    '[AUDIO] speaker playback completed: cue_id=synthetic-audio-1 frames=24000 sample_rate_hz=24000 sid=0198fixturesid',
    'event=echo_cancel_backend | backend=webrtc-aec3 frameMs=10 renderSubmitFormat=48000-f32-stereo renderClock=wasapi-submit-position endpointRenderPadding=same-client-get-current-padding webRtcAec3Ready=true msvcBuildVerified=true linkedBackendPresent=true fixtureVerified=true sid=0198fixturesid',
    'event=echo_cancel_reset | direction=inbound reason=route-start renderDiscontinuityId=0 sid=0198fixturesid',
    'event=echo_cancel_summary | direction=inbound backend=webrtc-aec3 render10msFrames=100 capture10msFrames=100 processedCapture10msFrames=100 resetCount=1 rejectedFrames=0 statsReadFailures=0 renderUnderruns=0 captureUnderruns=0 erleDb=20.0 residualEchoLikelihood=0.02 reportedDelayMs=125 doubleTalkFrames=12 avgProcessingUs=120.0 maxProcessingUs=250 captureChunks=100 intervalCaptureChunks=100 playbackActiveChunks=90 asrForwardedChunks=100 asrDeletedChunks=0 avgPreDb=-40.0 avgPostDb=-60.0 avgRemovedDb=20.0 sid=0198fixturesid',
    'watch route ensured subtitle overlay visible detail=label=subtitle-overlay visible=true sid=0198fixturesid',
    'subtitle cue appended id=synthetic-cue-1 sid=0198fixturesid',
    'model_trace finished status=ok elapsedMs=100 sid=0198fixturesid',
  ].join('\n');
  // Mirrors the unified bridge log line format emitted by omni-logging:
  // `{timestamp} [{LEVEL}] [bridge] {source} - {message}` with the original
  // pacer summary message kept verbatim after the prefix and the bridge
  // session id (`bridge-{appSid}-{startMs}`) as the trailing token.
  const bridgeLog = '2026-01-01 00:00:00.000 [NORMAL] [bridge] - - source pacer summary: releasedFrames=12 queuedFrames=0 pendingBytes=0 underruns=0 droppedFrames=0 driverBufferedBytes=0 driverDroppedBytes=0 monitorQueuedFrames=0 staleSourceFramesDropped=0 sid=bridge-0198fixturesid-1000';

  fs.writeFileSync(path.join(fixtureDirectory, 'fixture-evidence.raw.json'), `${JSON.stringify(snapshots, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(fixtureDirectory, 'run-metadata.json'), `${JSON.stringify({
    schemaVersion: 'watch-mode-run-metadata/v1',
    runMarker: null,
    startedAtLocal: null,
    modelId: snapshots.modelId,
    feedbackMode: snapshots.feedbackLoopPrevention,
  }, null, 2)}\n`, 'utf8');
  writeWatchModeRunCollection(fixtureDirectory, {
    schemaVersion: WATCH_MODE_RUN_COLLECTION_SCHEMA,
    artifactKind: 'watch-mode-run-collection',
    request: { schemaVersion: 'watch-mode-run-request/v1', runMode: 'fixture' },
    collectionStatus: 'completed',
    steps,
    ownedProcesses: [],
    artifacts: {
      appLog: 'app.log',
      bridgeLog: 'bridge-service.log',
      runMetadata: 'run-metadata.json',
      fixtureEvidence: 'fixture-evidence.raw.json',
    },
    primaryError: null,
    cleanupErrors: [],
  });
  fs.writeFileSync(path.join(fixtureDirectory, 'app.log'), `${appLog}\n`, 'utf8');
  fs.writeFileSync(path.join(fixtureDirectory, 'bridge-service.log'), `${bridgeLog}\n`, 'utf8');
  return fixtureDirectory;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseLooseArgs(process.argv.slice(2));
    const root = String(args.root ?? 'scripts/testing/fixtures/watch-mode-live');
    const fixture = String(args.fixture ?? 'pass');
    console.log(generateWatchModeLiveFixture({ root, fixture }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
