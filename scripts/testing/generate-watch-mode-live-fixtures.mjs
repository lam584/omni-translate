import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WATCH_MODE_LIVE_FIXTURE_FILES = [
  'snapshots.json',
  'steps.json',
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

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    args[arg.slice(2)] = argv[index + 1]?.startsWith('--') ? true : argv[++index] ?? true;
  }
  return args;
}

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
    physicalOutputContent: healthyPhysicalOutputContent,
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
    { name: 'synthetic driver probe', ok: true, result: healthyDriver, error: null },
    { name: 'synthetic watch route', ok: true, result: { routeState: 'capturing' }, error: null },
  ];
  const appLog = [
    'watch_mode.route_start | direction=inbound routeMode=watch',
    'watch route ensured subtitle overlay visible detail=label=subtitle-overlay visible=true',
    'subtitle cue appended id=synthetic-cue-1',
    'model_trace finished status=ok elapsedMs=100',
  ].join('\n');
  const bridgeLog = 'source pacer summary: releasedFrames=12 queuedFrames=0 pendingBytes=0 underruns=0 droppedFrames=0 driverBufferedBytes=0 driverDroppedBytes=0 monitorQueuedFrames=0 staleSourceFramesDropped=0';

  fs.writeFileSync(path.join(fixtureDirectory, 'snapshots.json'), `${JSON.stringify(snapshots, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(fixtureDirectory, 'steps.json'), `${JSON.stringify(steps, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(fixtureDirectory, 'app.log'), `${appLog}\n`, 'utf8');
  fs.writeFileSync(path.join(fixtureDirectory, 'bridge-service.log'), `${bridgeLog}\n`, 'utf8');
  return fixtureDirectory;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = String(args.root ?? 'scripts/testing/fixtures/watch-mode-live');
    const fixture = String(args.fixture ?? 'pass');
    console.log(generateWatchModeLiveFixture({ root, fixture }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
