import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ensureDir,
  readJson,
  repoRoot,
  writeJson,
} from '../lib/testing-common.mjs';
import { bundleName } from '../lib/release-common.mjs';
import { archiveReleaseManualEvidence } from './archive-release-manual-evidence.mjs';
import {
  canonicalSignedPackagePaths,
  hashJsonAuthority,
  healthProbeIssues,
  implementationAuthority,
  inspectCanonicalInstallReleasePackage,
  INSTALL_RELEASE_COLLECTOR_ID,
  INSTALL_RELEASE_COLLECTOR_VERSION,
  INSTALL_RELEASE_PROTOCOL_VERSION,
  sha256File,
  validateInstallReleaseEvidencePayload,
  validateInstallReleaseRunDirectory,
} from './install-release-evidence.mjs';
import {
  testOnlyCollectReleaseManualEvidence,
  validateReleaseManualCollectorPackage,
} from './release-manual-collector.mjs';
import {
  buildInstallReleaseEvidencePlan,
  isInstallReleaseAdministrator,
  parseInstallReleaseEvidenceArgs,
  runInstallReleaseEvidence,
  runInstallReleaseEvidenceAndCollect,
} from './run-install-release-evidence.mjs';
import { validateVirtualMicCaptureArtifacts } from './virtual-mic-fingerprint-authority.mjs';

const TEST_HEAD = '7'.repeat(40);
const TEST_NOW = new Date('2026-08-10T12:00:00.000Z');
const SIGNER = 'A'.repeat(40);
const TIMESTAMPER = 'B'.repeat(40);
const provenance = Object.freeze({
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: TEST_HEAD,
  worktreeClean: true,
  dirtyEntryCount: 0,
});
const historicalProvenance = Object.freeze({
  ...provenance,
  headCommit: '6'.repeat(40),
});

const REQUIRED_IMPLEMENTATION_FILES = [
  'scripts/testing/request-elevated-install-release-evidence.ps1',
  'scripts/testing/run-install-release-evidence.mjs',
  'scripts/testing/install-release-evidence.mjs',
  'scripts/testing/collect-install-release-state.ps1',
  'scripts/testing/powershell-script-authority.ps1',
  'scripts/testing/virtual-mic-capture-authority.ps1',
  'scripts/testing/virtual-mic-fingerprint-authority.mjs',
];

const INSTALLER_FILES = [
  'request-elevated-driver-operation.ps1',
  'invoke-elevated-driver-operation.ps1',
  'driver-operation-common.ps1',
  'install-development-driver.ps1',
  'uninstall-development-driver.ps1',
  'repair-driver.ps1',
  'probe-development-driver.ps1',
  'test-development-driver.ps1',
  'virtual-speaker-device.ps1',
  'stop-stale-bridge-service.ps1',
];

const portable = (value) => String(value).split(path.sep).join('/');
const temporaryRoot = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `omni-install-release-${name}-`));

const writeText = (candidate, value) => {
  ensureDir(path.dirname(candidate));
  fs.writeFileSync(candidate, String(value), 'utf8');
};

const fileInventory = (root, current = root) => fs
  .readdirSync(current, { withFileTypes: true })
  .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  .flatMap((entry) => {
    const candidate = path.join(current, entry.name);
    if (entry.isDirectory()) return fileInventory(root, candidate);
    return [{
      path: portable(path.relative(root, candidate)),
      bytes: fs.statSync(candidate).size,
      sha256: sha256File(candidate),
    }];
  });

const copyImplementationAuthorityFiles = (workspaceRoot) => {
  for (const relativePath of REQUIRED_IMPLEMENTATION_FILES) {
    const target = path.join(workspaceRoot, relativePath);
    ensureDir(path.dirname(target));
    fs.copyFileSync(path.join(repoRoot, relativePath), target);
  }
};

function createCanonicalSignedPackage(workspaceRoot, {
  version,
  driverVersion,
  sysContent = `sys-${version}`,
  signingMode = 'release-injected',
  timestampMode = 'rfc3161',
  sourceProvenance = provenance,
  binaryBuildSourceCommit = sourceProvenance.headCommit,
} = {}) {
  const paths = canonicalSignedPackagePaths({ workspaceRoot, version });
  ensureDir(paths.packageRoot);
  const packageFile = (relativePath) => path.join(paths.packageRoot, relativePath);

  for (const [relativePath, content] of [
    ['bridge-service-native/omni-bridge-service.exe', `bridge-${version}`],
    ['bridge-service-native/omni-driver-audio-probe.exe', `audio-probe-${version}`],
    ['bridge-service-native/omni-virtual-mic-target-capture.exe', `vmic-capture-${version}`],
    ['desktop/omni-desktop-shell.exe', `desktop-${version}`],
    ['drivers/windows-virtual-mic/package/omni-virtual-speaker.inf', `[Version]\nSignature="$WINDOWS NT$"\nProvider="Omni Translate"\nDriverVer=08/10/2026,${driverVersion}\n`],
    ['drivers/windows-virtual-mic/package/omni-virtual-speaker.sys', sysContent],
    ['drivers/windows-virtual-mic/package/omni-virtual-speaker.cat', `catalog-${version}`],
  ]) writeText(packageFile(relativePath), content);

  for (const installerFile of INSTALLER_FILES) {
    const installerTarget = packageFile(path.join('scripts', 'installer', installerFile));
    ensureDir(path.dirname(installerTarget));
    fs.copyFileSync(
      path.join(repoRoot, 'scripts', 'installer', installerFile),
      installerTarget,
    );
  }

  writeJson(packageFile('drivers/windows-virtual-mic/package/driver-package.json'), {
    sourceCommit: sourceProvenance.headCommit,
    sourceProvenance,
    protocolVersion: INSTALL_RELEASE_PROTOCOL_VERSION,
    configuration: 'Release',
    platform: 'x64',
    minimumWindowsBuild: 20348,
    signingMode,
    signerThumbprint: SIGNER,
    timestampMode,
    timestampUrl: timestampMode === 'rfc3161' ? 'https://timestamp.example.test' : null,
  });
  const buildBinaries = [
    ['desktop-shell', 'desktop/omni-desktop-shell.exe', 'embedded-commit'],
    ['native-bridge', 'bridge-service-native/omni-bridge-service.exe', '--build-commit'],
    ['audio-probe', 'bridge-service-native/omni-driver-audio-probe.exe', '--build-commit'],
    ['virtual-mic-target-capture', 'bridge-service-native/omni-virtual-mic-target-capture.exe', '--build-commit'],
  ].map(([role, relativePath, verification]) => ({
    role,
    path: relativePath,
    bytes: fs.statSync(packageFile(relativePath)).size,
    sha256: sha256File(packageFile(relativePath)),
    sourceCommit: binaryBuildSourceCommit,
    verification,
  }));
  writeJson(packageFile('installer-layout.json'), {
    version,
    generatedAt: TEST_NOW.toISOString(),
    sourceCommit: sourceProvenance.headCommit,
    sourceProvenance,
    buildAuthority: {
      schemaVersion: 1,
      artifactKind: 'omni-release-build-authority',
      sourceCommit: binaryBuildSourceCommit,
      cargoTargetDirectory: `artifacts/release-build/${binaryBuildSourceCommit}/target`,
      forcedCleanBuild: true,
      binaries: buildBinaries,
    },
    naming: {
      packageBaseName: bundleName(version),
      channel: 'stable',
      platform: 'windows-x64',
    },
    packages: { desktop: version, nativeBridge: version },
    upgradePolicy: { keepBackups: 2, cleanup: ['installed-driver', 'payloads'] },
  });
  writeJson(packageFile('release-package.json'), {
    generatedAt: TEST_NOW.toISOString(),
    version,
    sourceCommit: sourceProvenance.headCommit,
    sourceProvenance,
    packageName: `${bundleName(version)}.zip`,
    channel: 'stable',
    platform: 'windows-x64',
    installEntry: 'scripts/installer/install-development-driver.ps1',
    uninstallEntry: 'scripts/installer/uninstall-development-driver.ps1',
    repairEntry: 'scripts/installer/repair-driver.ps1',
    nativeBridgeExecutable: 'bridge-service-native/omni-bridge-service.exe',
    audioProbeExecutable: 'bridge-service-native/omni-driver-audio-probe.exe',
    virtualMicTargetCaptureExecutable: 'bridge-service-native/omni-virtual-mic-target-capture.exe',
  });

  const releaseManifest = {
    generatedAt: TEST_NOW.toISOString(),
    version,
    sourceCommit: sourceProvenance.headCommit,
    sourceProvenance,
    releaseChannel: 'stable',
    packages: {
      root: { name: 'omni-translate', version },
      desktop: { name: 'omni-translate-desktop', version },
      nativeBridge: { name: 'omni-bridge-service', version },
    },
    installer: {
      nativeBridgeExecutable: 'bridge-service-native/omni-bridge-service.exe',
      audioProbeExecutable: 'bridge-service-native/omni-driver-audio-probe.exe',
      virtualMicTargetCaptureExecutable: 'bridge-service-native/omni-virtual-mic-target-capture.exe',
    },
  };
  writeJson(paths.releaseManifestPath, releaseManifest);
  writeJson(packageFile('release-manifest.json'), releaseManifest);
  ensureDir(path.dirname(paths.packageZip));
  writeText(paths.packageZip, `signed-zip-${version}`);

  const inventory = fileInventory(paths.packageRoot);
  const packageRootRelative = portable(path.relative(workspaceRoot, paths.packageRoot));
  writeJson(paths.signedChecksumsPath, {
    generatedAt: TEST_NOW.toISOString(),
    version,
    sourceCommit: sourceProvenance.headCommit,
    sourceProvenance,
    bundle: {
      path: portable(path.relative(workspaceRoot, paths.packageZip)),
      sha256: sha256File(paths.packageZip),
    },
    files: inventory.map((entry) => ({
      path: `${packageRootRelative}/${entry.path}`,
      sha256: entry.sha256,
    })),
  });
  const signable = inventory
    .filter((entry) => ['.exe', '.dll', '.sys', '.cat', '.ps1'].includes(path.extname(entry.path).toLowerCase()))
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right, 'en'));
  writeJson(paths.signingManifestPath, {
    generatedAt: TEST_NOW.toISOString(),
    version,
    sourceCommit: sourceProvenance.headCommit,
    sourceProvenance,
    signTargets: signable.map((relativePath) => ({
      path: `${packageRootRelative}/${relativePath}`,
      expectedSignatureStatus: 'pending',
    })),
  });
  const signatures = {
    schemaVersion: 1,
    artifactKind: 'omni-release-package-signature-inventory',
    capturedAt: TEST_NOW.toISOString(),
    packageRoot: paths.packageRoot,
    signatures: signable.map((relativePath) => ({
      path: relativePath,
      status: 'Valid',
      signerThumbprint: SIGNER,
      signerSubject: 'CN=Omni Translate Release',
      timeStamperThumbprint: TIMESTAMPER,
      timeStamperSubject: 'CN=RFC3161 Test Authority',
    })),
  };
  const authority = inspectCanonicalInstallReleasePackage({
    workspaceRoot,
    version,
    signatureInventory: signatures,
    expectedProvenance: sourceProvenance,
    now: TEST_NOW,
  });
  return { authority, paths, signatures };
}

function createWorkspace({
  currentVersion = '2.0.0',
  currentDriverVersion = '2.0.0.0',
  previousVersion = '1.0.0',
  previousDriverVersion = '1.0.0.0',
  previousSysContent = `sys-${previousVersion}`,
} = {}) {
  const workspaceRoot = temporaryRoot('workspace');
  writeJson(path.join(workspaceRoot, 'package.json'), { name: 'omni-translate', version: currentVersion });
  copyImplementationAuthorityFiles(workspaceRoot);
  const current = createCanonicalSignedPackage(workspaceRoot, {
    version: currentVersion,
    driverVersion: currentDriverVersion,
  });
  const previous = previousVersion ? createCanonicalSignedPackage(workspaceRoot, {
    version: previousVersion,
    driverVersion: previousDriverVersion,
    sysContent: previousSysContent,
    sourceProvenance: historicalProvenance,
  }) : null;
  return { workspaceRoot, current, previous };
}

const absentState = () => ({
  schemaVersion: 1,
  artifactKind: 'omni-install-system-state',
  capturedAt: TEST_NOW.toISOString(),
  isAdministrator: true,
  rootDevices: [],
  renderEndpoints: [],
  captureEndpoints: [],
  driverPackages: [],
  installedDriverAuthority: null,
  pnpDriverStoreAuthorityCount: 0,
  signedDrivers: [],
  signedDriverCandidates: [],
  wmiSignedDriverObservation: {
    probeStatus: 'not-applicable-clean-or-noncanonical-topology',
    rowCount: 0,
  },
  signedDriverResolutionStatus: 'clean',
  rootDriverBindings: [],
  services: [],
  runtimeStatePresent: false,
  runtimeState: null,
  bridgeProcesses: [],
});

function healthyState(packageAuthority) {
  const rootId = `ROOT\\OMNITRANSLATE\\${packageAuthority.version}`;
  const renderId = `SWD\\MMDEVAPI\\RENDER-${packageAuthority.version}`;
  const captureId = `SWD\\MMDEVAPI\\CAPTURE-${packageAuthority.version}`;
  const infName = `oem-${packageAuthority.version}.inf`;
  const service = {
    name: 'omni_translate_virtual_speaker',
    state: 'Running',
    status: 'OK',
    startMode: 'Manual',
    binaryPath: `C:\\Windows\\System32\\DriverStore\\${infName}\\omni-virtual-speaker.sys`,
    binaryPresent: true,
    binarySha256: packageAuthority.driver.sys.sha256,
    signature: {
      status: 'Valid',
      signerThumbprint: packageAuthority.driver.metadata.signerThumbprint,
      timeStamperThumbprint: TIMESTAMPER,
    },
  };
  const signedStoreFile = (sha256) => ({
    present: true,
    sha256,
    signature: {
      status: 'Valid',
      signerThumbprint: packageAuthority.driver.metadata.signerThumbprint,
      timeStamperThumbprint: TIMESTAMPER,
    },
  });
  return {
    schemaVersion: 1,
    artifactKind: 'omni-install-system-state',
    capturedAt: TEST_NOW.toISOString(),
    isAdministrator: true,
    rootDevices: [{
      instanceId: rootId,
      status: 'OK',
      problem: 0,
      friendlyName: 'Omni Translate Virtual Speaker',
    }],
    renderEndpoints: [{
      instanceId: renderId,
      status: 'OK',
      friendlyName: 'Omni Translate Virtual Speaker',
    }],
    captureEndpoints: [{
      instanceId: captureId,
      status: 'OK',
      friendlyName: 'Omni Translate Virtual Microphone',
    }],
    driverPackages: [{
      publishedName: infName,
      originalFileName: 'omni-virtual-speaker.inf',
      providerName: 'Omni Translate',
      className: 'MEDIA',
      version: packageAuthority.driverVersion,
    }],
    installedDriverAuthority: {
      deviceId: rootId,
      deviceName: 'Omni Translate Virtual Speaker',
      matchingDeviceId: 'Root\\OmniTranslateVirtualSpeaker',
      infName,
      driverVersion: packageAuthority.driverVersion,
      driverProviderName: 'Omni Translate',
      serviceName: 'omni_translate_virtual_speaker',
      driverStore: {
        publishedName: infName,
        originalFileName: `C:\\Windows\\System32\\DriverStore\\${infName}\\omni-virtual-speaker.inf`,
        root: `C:\\Windows\\System32\\DriverStore\\${infName}`,
        providerName: 'Omni Translate',
        className: 'MEDIA',
        version: packageAuthority.driverVersion,
        inf: {
          present: true,
          sha256: packageAuthority.driver.inf.sha256,
          signature: { status: 'NotSigned' },
        },
        cat: signedStoreFile(packageAuthority.driver.cat.sha256),
        sys: signedStoreFile(packageAuthority.driver.sys.sha256),
      },
      service,
      wmiObservation: { probeStatus: 'not-exposed-yet', candidate: null },
    },
    pnpDriverStoreAuthorityCount: 1,
    signedDrivers: [],
    signedDriverCandidates: [],
    wmiSignedDriverObservation: { probeStatus: 'not-exposed-yet', rowCount: 0 },
    signedDriverResolutionStatus: 'ready-pnp-driverstore-service-files',
    rootDriverBindings: [{
      instanceId: rootId,
      matchingDeviceId: 'Root\\OmniTranslateVirtualSpeaker',
      infName,
      driverVersion: packageAuthority.driverVersion,
      driverProvider: 'Omni Translate',
      service: 'omni_translate_virtual_speaker',
    }],
    services: [service],
    runtimeStatePresent: true,
    runtimeState: {
      protocolVersion: INSTALL_RELEASE_PROTOCOL_VERSION,
      installChannel: 'release',
      driverVersion: packageAuthority.driverVersion,
      requestedDriverVersion: packageAuthority.driverVersion,
      packageVersion: packageAuthority.version,
      bridgeVersion: packageAuthority.bridgeVersion,
      pnpInstanceId: rootId,
      endpointInstanceId: renderId,
      captureEndpointInstanceId: captureId,
    },
    bridgeProcesses: [],
  };
}

function healthyProbe(packageAuthority, afterState) {
  const cueId = 'install-health-cue';
  const bridgeSessionId = 'bridge-session-install-release-test';
  const captureEndpointId = afterState.captureEndpoints[0].instanceId.replace(/^SWD\\MMDEVAPI\\/i, '');
  const cueStatusTimeline = ['queued', 'started', 'completed'].map((playbackStatus, index) => ({
    type: 'bridge.translation.status',
    statusId: `install-health-status-${index}`,
    requestId: `install-health-request-${index}`,
    cueId,
    sessionId: bridgeSessionId,
    playbackStatus,
    reason: `install-health-${playbackStatus}`,
    timestampMs: 1_754_824_800_000 + index,
    collectorReceivedAtMonotonicNs: 1_000 + index,
  }));
  const virtualMicAuthority = {
    collectorId: 'omni-virtual-mic-target-capture',
    collectorVersion: packageAuthority.bridgeVersion,
    parentCollectorProcessId: 4100,
    captureChildProcessId: 4101,
    bridgeProtocolVersion: INSTALL_RELEASE_PROTOCOL_VERSION,
    bridgeProcessId: 4200,
    bridgeInstanceId: 'bridge-install-release-test',
    bridgeSessionId,
    captureEndpointId,
    captureEndpointName: 'Omni Translate Virtual Microphone',
    rawCountersBefore: { virtualMicFramesWritten: 100, playbackFramesWritten: 200 },
    rawCountersAfter: { virtualMicFramesWritten: 33_700, playbackFramesWritten: 200 },
    recomputedCounterDelta: { virtualMicFramesWritten: 33_600, playbackFramesWritten: 0 },
    cueId,
    cueStatusTimeline,
    cueLifecycle: {
      cueId,
      queuedCount: 1,
      startedCount: 1,
      completedCount: 1,
      staleDroppedCount: 0,
      routeFailedCount: 0,
      terminalEventCount: 1,
      terminalStatus: 'completed',
    },
  };
  return {
    schemaVersion: 1,
    artifactKind: 'omni-install-release-health-probe',
    capturedAt: TEST_NOW.toISOString(),
    driverProbe: {
      driverHealth: 'running',
      errorCode: null,
      rootDeviceCount: 1,
      virtualMicOutputSupported: true,
      virtualMicOutputStatus: 'ready',
      virtualMicFormat: '48000Hz/mono/pcm16',
      abiVersion: '0X20260810',
      ioctlAvailable: true,
      installedDriverVersion: packageAuthority.driverVersion,
      packageSigningMode: 'release-injected',
    },
    installedDriverAuthority: {
      installedSysSha256: packageAuthority.driver.sys.sha256,
      packageSysSha256: packageAuthority.driver.sys.sha256,
      packageCatSha256: packageAuthority.driver.cat.sha256,
      packageInfSha256: packageAuthority.driver.inf.sha256,
      driverStoreInfSha256: packageAuthority.driver.inf.sha256,
      driverStoreCatSha256: packageAuthority.driver.cat.sha256,
      driverStoreSysSha256: packageAuthority.driver.sys.sha256,
      installedDriverVersion: packageAuthority.driverVersion,
      installedInfName: afterState.installedDriverAuthority.infName,
      driverStorePublishedName: afterState.installedDriverAuthority.driverStore.publishedName,
      pnpDriverInfName: afterState.installedDriverAuthority.infName,
      pnpDriverProvider: 'Omni Translate',
      pnpService: 'omni_translate_virtual_speaker',
      installedSysSignatureStatus: 'Valid',
      packageCatalogSignatureStatus: 'Valid',
      driverStoreCatSignatureStatus: 'Valid',
      driverStoreSysSignatureStatus: 'Valid',
      driverStoreCatSignerThumbprint: packageAuthority.driver.metadata.signerThumbprint,
      driverStoreSysSignerThumbprint: packageAuthority.driver.metadata.signerThumbprint,
    },
    audioProbe: {
      passed: true,
      detail: null,
      endpointId: afterState.renderEndpoints[0].instanceId,
      toneFrames: 48_000,
      toneRms: 0.1,
      invalidSamples: 0,
      droppedBytes: 213_120,
      virtualMicDroppedBytes: 0,
      virtualMicRejectedWrites: 0,
    },
    bridgeHandshake: {
      passed: true,
      protocolVersion: INSTALL_RELEASE_PROTOCOL_VERSION,
      bridgeProcessId: 4200,
      bridgeInstanceId: 'bridge-install-release-test',
      bridgeSessionId,
      captureEndpointId,
    },
    virtualMicProbe: {
      schemaVersion: 1,
      artifactKind: 'virtual-mic-real-capture-probe',
      capturedAt: TEST_NOW.toISOString(),
      ...virtualMicAuthority,
      targetCaptureApplication: {
        classification: 'real-target',
        name: 'Omni Translate Virtual Microphone Target Capture',
        processId: 4101,
        captureApi: 'WASAPI shared capture',
        openedEndpoint: true,
        endpointId: captureEndpointId,
        endpointName: 'Omni Translate Virtual Microphone',
      },
      format: { sampleRateHz: 48_000, channelCount: 1, bitsPerSample: 16, encoding: 'pcm16' },
      captureWav: 'virtual-mic-capture.wav',
      captureWavSha256: '',
      capturedFrames: 153_600,
      fingerprint: {
        id: 'install-health-fingerprint',
        detected: true,
        frequencyHz: 997,
        startFrame: 5_184,
        frameCount: 24_000,
        expectedPcmHex: '',
        expectedPcmSha256: '',
      },
    },
    virtualMicRuntimeSnapshot: {
      schemaVersion: 1,
      artifactKind: 'virtual-mic-runtime-snapshot',
      capturedAt: TEST_NOW.toISOString(),
      ...virtualMicAuthority,
      virtualMicOutputSupported: true,
      virtualMicOutputStatus: 'ready',
      virtualMicFormat: '48000Hz/mono/pcm16',
      captureWav: 'virtual-mic-capture.wav',
      captureWavSha256: '',
      capturedFrames: 153_600,
      fingerprint: {
        id: 'install-health-fingerprint',
        detected: true,
        frequencyHz: 997,
        startFrame: 5_184,
        frameCount: 24_000,
        expectedPcmHex: '',
        expectedPcmSha256: '',
      },
      virtualMicFramesWritten: 33_700,
      virtualMicFramesWrittenBefore: 100,
      virtualMicFramesWrittenAfter: 33_700,
      virtualMicFramesWrittenForCue: 33_600,
      physicalPlaybackFramesWrittenBefore: 200,
      physicalPlaybackFramesWrittenAfter: 200,
      physicalPlaybackFramesWrittenForCue: 0,
    },
  };
}

const attachRawHealthEvidence = (probe, evidenceOutputDirectory) => {
  const captureProbePath = path.join(evidenceOutputDirectory, 'virtual-mic-capture-probe.json');
  const runtimeSnapshotPath = path.join(evidenceOutputDirectory, 'runtime-snapshot.json');
  const captureWavPath = path.join(evidenceOutputDirectory, 'virtual-mic-capture.wav');
  const capturedFrames = probe.virtualMicProbe.capturedFrames;
  const expectedPcm = Buffer.alloc(24_000 * 2);
  let seed = 0x4d595df4;
  for (let frame = 0; frame < 24_000; frame += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const watermark = 0.88 + ((seed >>> 0) & 0xffff) / 0xffff * 0.12;
    const sample = Math.round(
      Math.sin((2 * Math.PI * 997 * frame) / 48_000) * 0.24 * watermark * 32_767,
    );
    expectedPcm.writeInt16LE(sample, frame * 2);
  }
  const wav = Buffer.alloc(44 + capturedFrames * 2);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(96_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(capturedFrames * 2, 40);
  const fingerprintStartFrame = 5_184;
  for (let frame = 0; frame < 24_000; frame += 1) {
    const expected = expectedPcm.readInt16LE(frame * 2);
    const delta = frame % 4 === 0 ? 1 : frame % 4 === 1 ? -1 : 0;
    wav.writeInt16LE(expected + delta, 44 + (fingerprintStartFrame + frame) * 2);
  }
  fs.writeFileSync(captureWavPath, wav);
  const captureWavSha256 = sha256File(captureWavPath);
  const fingerprint = {
    id: 'install-health-fingerprint',
    detected: true,
    frequencyHz: 997,
    startFrame: fingerprintStartFrame,
    frameCount: 24_000,
    expectedPcmHex: expectedPcm.toString('hex'),
    expectedPcmSha256: crypto.createHash('sha256').update(expectedPcm).digest('hex'),
  };
  probe.virtualMicProbe.captureWavSha256 = captureWavSha256;
  probe.virtualMicProbe.fingerprint = fingerprint;
  probe.virtualMicRuntimeSnapshot.captureWavSha256 = captureWavSha256;
  probe.virtualMicRuntimeSnapshot.fingerprint = structuredClone(fingerprint);
  const recomputed = validateVirtualMicCaptureArtifacts({
    captureWavPath,
    captureProbe: probe.virtualMicProbe,
    runtimeSnapshot: probe.virtualMicRuntimeSnapshot,
  });
  assert.deepEqual(recomputed.issues, []);
  probe.bridgeHandshake.fingerprintAuthority = recomputed.authority;
  writeJson(captureProbePath, probe.virtualMicProbe);
  writeJson(runtimeSnapshotPath, probe.virtualMicRuntimeSnapshot);
  return {
    ...probe,
    rawEvidence: {
      captureProbePath,
      captureProbeSha256: sha256File(captureProbePath),
      runtimeSnapshotPath,
      runtimeSnapshotSha256: sha256File(runtimeSnapshotPath),
      captureWavPath,
      captureWavSha256: sha256File(captureWavPath),
    },
  };
};

const completedOperation = (plan, outputPath) => ({
  schemaVersion: 1,
  operationId: plan.operationId,
  action: plan.action,
  succeeded: true,
  phase: 'completed',
  errorCode: null,
  summary: `${plan.action} completed`,
  requestProcessId: 5000,
  elevatedProcessId: 5001,
  elevated: true,
  elevationMode: 'uac-runas',
  installChannel: 'release',
  driverVersion: plan.version === '2.0.0' ? '2.0.0.0' : `${plan.version}.0`,
  bridgeVersion: plan.version,
  logPath: path.join(path.dirname(outputPath), 'operation-result.log'),
  startedAt: '2026-08-10T12:00:01.000Z',
  finishedAt: '2026-08-10T12:00:02.000Z',
});

async function executeScenario(scenarioId, {
  fixture = createWorkspace(),
  beforeState,
  afterState,
  invokeResult,
  mutateBefore,
  mutateAfter,
  invokeCounter = { count: 0 },
  collect = false,
  collectEvidence,
} = {}) {
  const previousVersion = scenarioId === 'INSTALL-UPGRADE' ? fixture.previous.authority.version : '';
  const plan = buildInstallReleaseEvidencePlan({
    scenarioId,
    previousVersion,
    outputRoot: 'artifacts/testing/install-release-fixture',
    workspaceRoot: fixture.workspaceRoot,
    provenance,
    now: TEST_NOW,
    suffix: `fixture-${scenarioId.toLowerCase()}`,
  });
  const before = beforeState ?? (
    scenarioId === 'INSTALL-FRESH'
      ? absentState()
      : scenarioId === 'INSTALL-UPGRADE'
        ? healthyState(fixture.previous.authority)
        : healthyState(fixture.current.authority)
  );
  const after = afterState ?? (
    scenarioId === 'INSTALL-UNINSTALL'
      ? absentState()
      : healthyState(fixture.current.authority)
  );
  if (mutateBefore) mutateBefore(before);
  if (mutateAfter) mutateAfter(after);
  let stateIndex = 0;
  const stateSequence = [before, after];
  const signatureByRoot = new Map([
    [path.resolve(fixture.current.paths.packageRoot), fixture.current.signatures],
    ...(fixture.previous ? [[path.resolve(fixture.previous.paths.packageRoot), fixture.previous.signatures]] : []),
  ]);
  const dependencies = {
    captureSignatures: async ({ packageRoot }) => structuredClone(signatureByRoot.get(path.resolve(packageRoot))),
    captureState: async () => structuredClone(stateSequence[stateIndex++]),
    captureHealth: async ({ evidenceOutputDirectory }) => attachRawHealthEvidence(
      healthyProbe(fixture.current.authority, after),
      evidenceOutputDirectory,
    ),
    invokeOperation: async ({ plan: operationPlan, outputPath }) => {
      invokeCounter.count += 1;
      writeText(path.join(path.dirname(outputPath), 'operation-result.log'), `${operationPlan.action} completed\n`);
      return structuredClone(invokeResult ?? completedOperation(operationPlan, outputPath));
    },
  };
  const result = await (collect ? runInstallReleaseEvidenceAndCollect : runInstallReleaseEvidence)({
    plan,
    ...dependencies,
    ...(collectEvidence ? { collectEvidence } : {}),
  });
  return { fixture, plan, result, before, after, invokeCounter };
}

const readRunArtifacts = ({ plan, fixture }) => {
  const read = (name) => readJson(path.join(plan.runDirectory, name));
  return {
    authority: read('authority.json'),
    packageAuthority: read('package-authority.json'),
    signatureInventory: read('signature-inventory.json'),
    previousPackageAuthority: fs.existsSync(path.join(plan.runDirectory, 'previous-package-authority.json'))
      ? read('previous-package-authority.json')
      : null,
    previousSignatureInventory: fs.existsSync(path.join(plan.runDirectory, 'previous-signature-inventory.json'))
      ? read('previous-signature-inventory.json')
      : null,
    beforeState: fs.existsSync(path.join(plan.runDirectory, 'before-state.json')) ? read('before-state.json') : null,
    operationResult: fs.existsSync(path.join(plan.runDirectory, 'operation-result.json'))
      ? read('operation-result.json')
      : null,
    afterState: fs.existsSync(path.join(plan.runDirectory, 'after-state.json')) ? read('after-state.json') : null,
    healthProbe: fs.existsSync(path.join(plan.runDirectory, 'health-probe.json')) ? read('health-probe.json') : null,
    currentImplementationAuthority: implementationAuthority(fixture.workspaceRoot),
  };
};

const validationIssues = (run, overrides = {}) => {
  const artifacts = readRunArtifacts(run);
  return validateInstallReleaseEvidencePayload({
    scenarioId: run.plan.scenarioId,
    ...artifacts,
    currentPackageAuthority: run.fixture.current.authority,
    currentPreviousPackageAuthority: run.plan.scenarioId === 'INSTALL-UPGRADE'
      ? run.fixture.previous?.authority ?? null
      : null,
    currentProvenance: provenance,
    evidenceRoot: run.plan.runDirectory,
    ...overrides,
  });
};

test('canonical release package rejects development signing, invalid signatures, and missing timestamps', () => {
  const fixture = createWorkspace({ previousVersion: null });
  const metadataPath = path.join(
    fixture.current.paths.packageRoot,
    'drivers/windows-virtual-mic/package/driver-package.json',
  );
  const validMetadata = readJson(metadataPath);
  writeJson(metadataPath, { ...validMetadata, signingMode: 'development-test' });
  assert.throws(() => inspectCanonicalInstallReleasePackage({
    workspaceRoot: fixture.workspaceRoot,
    version: fixture.current.authority.version,
    signatureInventory: fixture.current.signatures,
    expectedProvenance: provenance,
  }), /release-injected/);
  writeJson(metadataPath, validMetadata);
  writeJson(metadataPath, { ...validMetadata, timestampMode: 'none' });
  assert.throws(() => inspectCanonicalInstallReleasePackage({
    workspaceRoot: fixture.workspaceRoot,
    version: fixture.current.authority.version,
    signatureInventory: fixture.current.signatures,
    expectedProvenance: provenance,
  }), /RFC3161/);
  writeJson(metadataPath, validMetadata);

  const unsigned = structuredClone(fixture.current.signatures);
  unsigned.signatures[0].status = 'NotSigned';
  assert.throws(() => inspectCanonicalInstallReleasePackage({
    workspaceRoot: fixture.workspaceRoot,
    version: fixture.current.authority.version,
    signatureInventory: unsigned,
    expectedProvenance: provenance,
  }), /invalid or untimestamped/);

  const untimestamped = structuredClone(fixture.current.signatures);
  untimestamped.signatures[0].timeStamperThumbprint = null;
  assert.throws(() => inspectCanonicalInstallReleasePackage({
    workspaceRoot: fixture.workspaceRoot,
    version: fixture.current.authority.version,
    signatureInventory: untimestamped,
    expectedProvenance: provenance,
  }), /invalid or untimestamped/);
  writeText(path.join(fixture.current.paths.packageRoot, 'bridge-service-native/omni-bridge-service.exe'), 'tampered');
  assert.throws(() => inspectCanonicalInstallReleasePackage({
    workspaceRoot: fixture.workspaceRoot,
    version: fixture.current.authority.version,
    signatureInventory: fixture.current.signatures,
    expectedProvenance: provenance,
  }), /build authority|signed-checksums/);
});

test('current release package refuses a same-version signed artifact from an older source commit', () => {
  const workspaceRoot = temporaryRoot('stale-current-package');
  writeJson(path.join(workspaceRoot, 'package.json'), { name: 'omni-translate', version: '2.0.0' });
  const stale = createCanonicalSignedPackage(workspaceRoot, {
    version: '2.0.0',
    driverVersion: '2.0.0.0',
    sourceProvenance: historicalProvenance,
  });
  assert.throws(() => inspectCanonicalInstallReleasePackage({
    workspaceRoot,
    version: '2.0.0',
    signatureInventory: stale.signatures,
    expectedProvenance: provenance,
  }), /does not exactly match current HEAD/);
});

test('canonical package refuses stale Desktop, Bridge, probe, or VMic build authority', () => {
  const workspaceRoot = temporaryRoot('stale-binary-build');
  writeJson(path.join(workspaceRoot, 'package.json'), { name: 'omni-translate', version: '2.0.0' });
  assert.throws(() => createCanonicalSignedPackage(workspaceRoot, {
    version: '2.0.0',
    driverVersion: '2.0.0.0',
    binaryBuildSourceCommit: historicalProvenance.headCommit,
  }), /forced-build authority|build authority/);
});

test('release layout emitter binds exact canonical inventory/signatures without invoking UAC', async () => {
  const fixture = createWorkspace({ previousVersion: null });
  const plan = buildInstallReleaseEvidencePlan({
    scenarioId: 'INSTALL-RELEASE-LAYOUT',
    outputRoot: 'artifacts/testing/install-release-fixture',
    workspaceRoot: fixture.workspaceRoot,
    provenance,
    now: TEST_NOW,
    suffix: 'layout',
  });
  let operationCalls = 0;
  const result = await runInstallReleaseEvidence({
    plan,
    captureSignatures: async () => structuredClone(fixture.current.signatures),
    captureState: async () => { throw new Error('layout must not inspect installed state'); },
    captureHealth: async () => { throw new Error('layout must not run audio health probes'); },
    invokeOperation: async () => { operationCalls += 1; throw new Error('layout must not invoke UAC'); },
  });
  assert.equal(result.scenarioId, 'INSTALL-RELEASE-LAYOUT');
  assert.equal(operationCalls, 0);
  const authority = readJson(path.join(plan.runDirectory, 'authority.json'));
  const packageAuthority = readJson(path.join(plan.runDirectory, 'package-authority.json'));
  assert.equal(authority.collectorId, INSTALL_RELEASE_COLLECTOR_ID);
  assert.equal(authority.collectorVersion, INSTALL_RELEASE_COLLECTOR_VERSION);
  assert.equal(authority.operation, null);
  assert.equal(packageAuthority.inventorySha256, hashJsonAuthority(packageAuthority.inventory));
  assert.deepEqual(validationIssues({ fixture, plan }), []);
});

test('private install wrapper accepts only a fully recomputable production runner directory', async () => {
  const run = await executeScenario('INSTALL-REPAIR', {
    collect: true,
    collectEvidence: (options) => testOnlyCollectReleaseManualEvidence({
      ...options,
      testOnlyAllowSyntheticAuthority: true,
    }),
  });
  try {
    const manifest = readJson(run.result.manifestPath);
    assert.equal(manifest.authority.kind, 'test-fixture');
    assert.equal(manifest.authority.emitterId, 'scripts/testing/run-quality-gate.test.mjs');
    assert.equal(manifest.authority.emitterVersion, 1);
    assert.deepEqual(validateReleaseManualCollectorPackage(
      run.result.packageDirectory,
      run.plan.scenarioId,
      {
        workspaceRoot: run.fixture.workspaceRoot,
        currentProvenance: provenance,
        now: TEST_NOW.getTime(),
        testOnlyAllowSyntheticAuthority: true,
      },
    ).issues, []);
    const archived = archiveReleaseManualEvidence({
      source: run.result.packageDirectory,
      scenarioId: run.plan.scenarioId,
      outputRoot: 'artifacts/testing/release-manual-evidence-fixture',
      workspaceRoot: run.fixture.workspaceRoot,
      provenance,
      now: TEST_NOW,
      suffix: 'private-runner',
      testOnlyAllowSyntheticAuthority: true,
    });
    const receipt = readJson(archived.receiptPath);
    assert.equal(receipt.collector.collectorId, 'omni.release.install-repair');
    assert.equal(receipt.collector.scenarioId, 'INSTALL-REPAIR');
    assert.match(archived.receiptSha256, /^[a-f0-9]{64}$/);

    const operationLog = path.join(run.result.packageDirectory, 'artifacts', 'operation-result.log');
    fs.appendFileSync(operationLog, 'caller tamper\n', 'utf8');
    assert.ok(validateReleaseManualCollectorPackage(
      run.result.packageDirectory,
      run.plan.scenarioId,
      {
        workspaceRoot: run.fixture.workspaceRoot,
        currentProvenance: provenance,
        now: TEST_NOW.getTime(),
      },
    ).issues.some((issue) => /hash|operation-result\.log|authority/i.test(issue)));
  } finally {
    fs.rmSync(run.fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('fresh, repair, uninstall, and upgrade emit production operation/state/health authority', async () => {
  for (const scenarioId of ['INSTALL-FRESH', 'INSTALL-REPAIR', 'INSTALL-UNINSTALL', 'INSTALL-UPGRADE']) {
    const run = await executeScenario(scenarioId);
    assert.equal(run.invokeCounter.count, 1, scenarioId);
    const artifacts = readRunArtifacts(run);
    assert.equal(artifacts.authority.operation.installChannel, 'release', scenarioId);
    assert.equal(artifacts.authority.operation.elevatedProductionRequest, true, scenarioId);
    assert.equal(artifacts.operationResult.action, run.plan.action, scenarioId);
    assert.equal(artifacts.healthProbe == null, scenarioId === 'INSTALL-UNINSTALL', scenarioId);
    assert.deepEqual(validationIssues(run), [], scenarioId);
    assert.deepEqual(validateInstallReleaseRunDirectory({
      runDirectory: run.plan.runDirectory,
      workspaceRoot: run.fixture.workspaceRoot,
      currentProvenance: provenance,
      now: TEST_NOW,
    }).issues, [], scenarioId);
  }
});

test('WMI signed-driver rows are optional diagnostics but conflicts and duplicates fail closed', async () => {
  const absent = await executeScenario('INSTALL-FRESH');
  assert.equal(absent.after.wmiSignedDriverObservation.probeStatus, 'not-exposed-yet');
  assert.deepEqual(validationIssues(absent), []);

  const exposeQueryUnavailable = (state) => {
    const queryDiagnostic = {
      exceptionType: 'Microsoft.Management.Infrastructure.CimException',
      message: 'The CIM provider is temporarily unavailable.',
      fullyQualifiedErrorId: 'HRESULT 0x80041013',
      category: 'ResourceUnavailable',
    };
    state.signedDrivers = [];
    state.signedDriverCandidates = [];
    state.wmiSignedDriverObservation = {
      probeStatus: 'query-unavailable',
      rowCount: 0,
      queryDiagnostic,
    };
    state.installedDriverAuthority.wmiObservation = {
      probeStatus: 'query-unavailable',
      candidate: null,
      queryDiagnostic: structuredClone(queryDiagnostic),
    };
  };
  const unavailable = await executeScenario('INSTALL-FRESH', { mutateAfter: exposeQueryUnavailable });
  assert.deepEqual(validationIssues(unavailable), []);

  await assert.rejects(() => executeScenario('INSTALL-FRESH', {
    mutateAfter: (state) => {
      exposeQueryUnavailable(state);
      delete state.wmiSignedDriverObservation.queryDiagnostic;
    },
  }), /optional Win32_PnPSignedDriver diagnostic is conflicting/);

  await assert.rejects(() => executeScenario('INSTALL-FRESH', {
    mutateAfter: (state) => {
      exposeQueryUnavailable(state);
      state.installedDriverAuthority.wmiObservation.queryDiagnostic.message = 'different failure';
    },
  }), /optional Win32_PnPSignedDriver diagnostic is conflicting/);

  const exposeConsistent = (state) => {
    const installed = state.installedDriverAuthority;
    const row = {
      deviceId: 'SWD\\MMDEVAPI\\OPTIONAL-WMI-PROJECTION',
      deviceName: installed.deviceName,
      infName: installed.infName,
      driverVersion: installed.driverVersion,
      driverProviderName: installed.driverProviderName,
      signer: '',
      isSigned: false,
    };
    state.signedDrivers = [row];
    state.signedDriverCandidates = [structuredClone(row)];
    state.wmiSignedDriverObservation = { probeStatus: 'exposed-consistent', rowCount: 1 };
    installed.wmiObservation = {
      probeStatus: 'exposed-consistent',
      candidate: structuredClone(row),
    };
  };
  const consistent = await executeScenario('INSTALL-FRESH', { mutateAfter: exposeConsistent });
  assert.deepEqual(validationIssues(consistent), []);

  await assert.rejects(() => executeScenario('INSTALL-FRESH', {
    mutateAfter: (state) => {
      exposeConsistent(state);
      state.signedDrivers[0].infName = 'oem-conflict.inf';
    },
  }), /optional Win32_PnPSignedDriver diagnostic is conflicting/);

  await assert.rejects(() => executeScenario('INSTALL-FRESH', {
    mutateAfter: (state) => {
      exposeConsistent(state);
      state.signedDrivers.push(structuredClone(state.signedDrivers[0]));
      state.signedDriverCandidates.push(structuredClone(state.signedDriverCandidates[0]));
      state.wmiSignedDriverObservation.rowCount = 2;
    },
  }), /optional Win32_PnPSignedDriver diagnostic is conflicting/);
});

test('health authority accepts native diagnostic render drops but rejects invalid samples and virtual-mic overflow', async () => {
  const run = await executeScenario('INSTALL-FRESH');
  const artifacts = readRunArtifacts(run);
  assert.equal(artifacts.healthProbe.audioProbe.droppedBytes, 213_120);
  assert.deepEqual(validationIssues(run), []);

  const cases = [
    ['native failure', (audio) => { audio.passed = false; audio.detail = 'native probe failure'; }],
    ['invalid sample', (audio) => { audio.invalidSamples = 1; }],
    ['missing invalid-sample counter', (audio) => { audio.invalidSamples = null; }],
    ['virtual-mic ring overflow', (audio) => { audio.virtualMicDroppedBytes = 2; }],
    ['missing virtual-mic overflow counter', (audio) => { delete audio.virtualMicDroppedBytes; }],
    ['virtual-mic rejected write', (audio) => { audio.virtualMicRejectedWrites = 1; }],
    ['invalid diagnostic drop counter', (audio) => { audio.droppedBytes = -1; }],
  ];
  for (const [label, mutate] of cases) {
    const healthProbe = structuredClone(artifacts.healthProbe);
    mutate(healthProbe.audioProbe);
    assert.match(
      validationIssues(run, { healthProbe }).join('\n'),
      /native validity and virtual-mic overflow\/rejection checks/,
      label,
    );
  }
});

test('install health recomputes VMic WAV fingerprint and rejects two-LSB, duplicate, truncation, and forged hash', async () => {
  const runCase = async (mutate) => {
    const run = await executeScenario('INSTALL-FRESH');
    const artifacts = readRunArtifacts(run);
    const health = structuredClone(artifacts.healthProbe);
    const wavPath = path.join(run.plan.runDirectory, health.rawEvidence.captureWavPath);
    const probePath = path.join(run.plan.runDirectory, health.rawEvidence.captureProbePath);
    const snapshotPath = path.join(run.plan.runDirectory, health.rawEvidence.runtimeSnapshotPath);
    let wav = fs.readFileSync(wavPath);
    ({ wav } = mutate({ wav, health }) ?? { wav });
    fs.writeFileSync(wavPath, wav);
    const wavSha256 = sha256File(wavPath);
    health.rawEvidence.captureWavSha256 = wavSha256;
    health.virtualMicProbe.captureWavSha256 = wavSha256;
    health.virtualMicRuntimeSnapshot.captureWavSha256 = wavSha256;
    writeJson(probePath, health.virtualMicProbe);
    writeJson(snapshotPath, health.virtualMicRuntimeSnapshot);
    health.rawEvidence.captureProbeSha256 = sha256File(probePath);
    health.rawEvidence.runtimeSnapshotSha256 = sha256File(snapshotPath);
    return healthProbeIssues(
      health,
      artifacts.packageAuthority,
      artifacts.afterState,
      { evidenceRoot: run.plan.runDirectory },
    ).join('\n');
  };

  const twoLsb = await runCase(({ wav, health }) => {
    const changed = Buffer.from(wav);
    const offset = 44 + (health.virtualMicProbe.fingerprint.startFrame + 100) * 2;
    changed.writeInt16LE(changed.readInt16LE(offset) + 2, offset);
    return { wav: changed };
  });
  assert.match(twoLsb, /does not contain.*one-LSB/i);

  const duplicate = await runCase(({ wav, health }) => {
    const changed = Buffer.from(wav);
    const source = 44 + health.virtualMicProbe.fingerprint.startFrame * 2;
    changed.copy(changed, 44 + 80_000 * 2, source, source + 24_000 * 2);
    return { wav: changed };
  });
  assert.match(duplicate, /more than once/i);

  const truncated = await runCase(({ wav }) => ({ wav: wav.subarray(0, wav.length - 2) }));
  assert.match(truncated, /RIFF size|truncated|frame authority/i);

  const forgedHash = await runCase(({ wav, health }) => {
    health.virtualMicProbe.fingerprint.expectedPcmSha256 = '0'.repeat(64);
    health.virtualMicRuntimeSnapshot.fingerprint.expectedPcmSha256 = '0'.repeat(64);
    return { wav };
  });
  assert.match(forgedHash, /expectedPcmSha256 does not bind the pre-injection PCM/i);
});

test('runner refuses duplicate devices before UAC and uninstall residue after the operation', async () => {
  const counter = { count: 0 };
  await assert.rejects(() => executeScenario('INSTALL-REPAIR', {
    invokeCounter: counter,
    mutateBefore: (state) => {
      state.rootDevices.push(structuredClone(state.rootDevices[0]));
      state.renderEndpoints.push(structuredClone(state.renderEndpoints[0]));
    },
  }), /exactly one running ROOT device|exactly one ready render/);
  assert.equal(counter.count, 0);

  const residues = [
    (state) => state.driverPackages.push({ publishedName: 'oem-residue.inf' }),
    (state) => state.services.push({ name: 'omni_translate_virtual_speaker', state: 'Stopped' }),
    (state) => {
      state.runtimeStatePresent = true;
      state.runtimeState = { protocolVersion: INSTALL_RELEASE_PROTOCOL_VERSION };
    },
    (state) => state.bridgeProcesses.push({ processId: 9001, name: 'omni-bridge-service.exe' }),
  ];
  for (const mutateAfter of residues) {
    await assert.rejects(() => executeScenario('INSTALL-UNINSTALL', { mutateAfter }),
      /complete device\/endpoint\/DriverStore\/service\/runtime\/process absence/);
  }
});

test('runner rejects UAC cancellation and does not emit caller-authored PASS authority', async () => {
  const fixture = createWorkspace();
  const plan = buildInstallReleaseEvidencePlan({
    scenarioId: 'INSTALL-FRESH',
    outputRoot: 'artifacts/testing/install-release-fixture',
    workspaceRoot: fixture.workspaceRoot,
    provenance,
    now: TEST_NOW,
    suffix: 'cancelled',
  });
  await assert.rejects(() => runInstallReleaseEvidence({
    plan,
    captureSignatures: async () => structuredClone(fixture.current.signatures),
    captureState: async () => absentState(),
    invokeOperation: async () => ({
      ...completedOperation(plan, path.join(plan.runDirectory, 'operation-result.json')),
      succeeded: false,
      phase: 'failed',
      errorCode: 'driver.elevation-cancelled',
    }),
  }), /driver\.elevation-cancelled/);
  assert.equal(fs.existsSync(path.join(plan.runDirectory, 'authority.json')), false);
});

test('upgrade refuses non-older and same-binary packages even when ABI is v6', async () => {
  const sameVersionFixture = createWorkspace({
    previousVersion: '2.1.0',
    previousDriverVersion: '2.1.0.0',
  });
  await assert.rejects(() => executeScenario('INSTALL-UPGRADE', { fixture: sameVersionFixture }), /older than the current package/);

  const sameSysFixture = createWorkspace({ previousSysContent: 'sys-2.0.0' });
  await assert.rejects(() => executeScenario('INSTALL-UPGRADE', { fixture: sameSysFixture }), /different previous SYS/);
});

test('validator rejects wrong scenario/action/operation IDs and package/receipt tampering', async () => {
  const run = await executeScenario('INSTALL-FRESH');
  const artifacts = readRunArtifacts(run);

  const wrongActionAuthority = structuredClone(artifacts.authority);
  wrongActionAuthority.operation.action = 'reinstall';
  assert.match(validationIssues(run, { authority: wrongActionAuthority }).join('\n'), /production elevated release operation/);
  assert.match(validationIssues(run, { scenarioId: 'INSTALL-REPAIR' }).join('\n'), /runner authority identity/);

  const wrongOperation = structuredClone(artifacts.operationResult);
  wrongOperation.operationId = 'caller-authored-operation';
  assert.match(validationIssues(run, { operationResult: wrongOperation }).join('\n'), /did not complete successfully|does not bind/);

  const tamperedPackage = structuredClone(artifacts.packageAuthority);
  tamperedPackage.inventory[0].sha256 = '0'.repeat(64);
  assert.match(validationIssues(run, { packageAuthority: tamperedPackage }).join('\n'), /inventory hash|canonical signed package|package-authority/);

  const tamperedReceipt = structuredClone(artifacts.authority);
  tamperedReceipt.operation.resultSha256 = 'f'.repeat(64);
  assert.match(validationIssues(run, { authority: tamperedReceipt }).join('\n'), /does not bind operation-result/);

  const tamperedSignatures = structuredClone(artifacts.signatureInventory);
  tamperedSignatures.signatures[0].status = 'NotSigned';
  assert.match(validationIssues(run, { signatureInventory: tamperedSignatures }).join('\n'), /does not bind signature-inventory/);

  const legacyTimelineHealth = structuredClone(artifacts.healthProbe);
  for (const target of [
    legacyTimelineHealth.virtualMicProbe,
    legacyTimelineHealth.virtualMicRuntimeSnapshot,
  ]) {
    target.cueStatusTimeline = target.cueStatusTimeline.map(({ type, ...event }) => ({
      ...event,
      eventType: type,
    }));
  }
  assert.match(
    validationIssues(run, { healthProbe: legacyTimelineHealth }).join('\n'),
    /health virtual-mic probe did not prove isolated real capture/,
  );

  fs.appendFileSync(path.join(run.plan.runDirectory, artifacts.healthProbe.rawEvidence.captureWavPath), 'tamper');
  assert.match(validationIssues(run).join('\n'), /capture WAV.*SHA256 binding|non-empty RIFF\/WAVE/);

  writeText(path.join(run.plan.runDirectory, 'caller-authored-pass.json'), '{"passed":true}');
  assert.match(validateInstallReleaseRunDirectory({
    runDirectory: run.plan.runDirectory,
    workspaceRoot: run.fixture.workspaceRoot,
    currentProvenance: provenance,
    now: TEST_NOW,
  }).issues.join('\n'), /unowned extras/);
});

test('upgrade validator binds freshly recomputed previous package authority', async () => {
  const run = await executeScenario('INSTALL-UPGRADE');
  const artifacts = readRunArtifacts(run);
  const callerAuthoredPrevious = structuredClone(artifacts.previousPackageAuthority);
  callerAuthoredPrevious.inspectedAt = '2026-08-10T11:59:59.000Z';
  callerAuthoredPrevious.driverVersion = '0.0.0.0';
  assert.match(validationIssues(run, {
    previousPackageAuthority: callerAuthoredPrevious,
  }).join('\n'), /freshly recomputed canonical signed package|does not bind previous-package-authority/);
});

test('production CLI rejects package/workspace overrides, dry-run, and skip-signing flags', () => {
  for (const args of [
    ['--workspace-root', 'caller-repo'],
    ['--package-root', 'caller-package'],
    ['--dry-run'],
    ['--skip-uac'],
    ['--skip-signature-validation'],
  ]) assert.throws(() => parseInstallReleaseEvidenceArgs(args), /Unknown flag/);
  assert.equal(isInstallReleaseAdministrator({
    run: () => ({ status: 0, stdout: 'True\r\n' }),
  }), true);
  assert.equal(isInstallReleaseAdministrator({
    run: () => ({ status: 0, stdout: 'False\r\n' }),
  }), false);
});

test('stable installer PowerShell validates the local self-signed package before all system mutations', () => {
  const install = fs.readFileSync(path.join(repoRoot, 'scripts/installer/install-development-driver.ps1'), 'utf8');
  const repair = fs.readFileSync(path.join(repoRoot, 'scripts/installer/repair-driver.ps1'), 'utf8');
  const invoke = fs.readFileSync(path.join(repoRoot, 'scripts/installer/invoke-elevated-driver-operation.ps1'), 'utf8');
  const build = fs.readFileSync(path.join(repoRoot, 'scripts/installer/build-sysvad-driver.ps1'), 'utf8');
  const prepareLayout = fs.readFileSync(path.join(repoRoot, 'scripts/release/prepare-installer-layout.mjs'), 'utf8');
  const finalizeSigned = fs.readFileSync(path.join(repoRoot, 'scripts/release/finalize-signed-package.mjs'), 'utf8');

  assert.ok(install.indexOf('Assert-OmniStableReleasePackage') < install.indexOf('stop-stale-bridge-service.ps1'));
  assert.ok(install.indexOf('-ValidatePackageOnly') === -1, 'install preflight is selected by its switch, not recursive invocation');
  assert.ok(repair.indexOf('-ValidatePackageOnly') < repair.indexOf('uninstall-development-driver.ps1'));
  assert.ok(invoke.indexOf('-ValidatePackageOnly') < invoke.indexOf("if ($Action -eq 'reinstall')"));
  assert.ok(build.includes("$signingArguments += @('/tr', $SigningTimestampUrl, '/td', 'SHA256')"));
  assert.ok(build.includes("signingMode = if ($isDevelopmentTestSigner) { 'development-test' } else { 'local-self-signed' }"));
  assert.ok(build.includes("timestampMode = if ([string]::IsNullOrWhiteSpace($SigningTimestampUrl)) { 'none' } else { 'rfc3161' }"));
  assert.ok(build.includes('$useDevelopmentSigningCredential = -not $SigningPfxPath'));
  assert.ok(install.includes("$releaseSignableExtensions = @('.exe', '.dll', '.sys', '.cat', '.ps1')"));
  assert.ok(install.includes('Release install refuses an unsigned production artifact'));
  assert.ok(install.includes('Release package does not contain exact current-HEAD forced-build authority'));
  assert.doesNotMatch(install, /Get-CimInstance Win32_PnPSignedDriver/);
  assert.ok(install.includes('$testResult.InstalledDriverAuthority'));
  assert.ok(install.includes('$installedDriverAuthority.driverStoreVersion'));
  assert.ok(install.includes("driverVersion = if ($InstallChannel -eq 'release') { [string]$installedDriverAuthority.installedDriverVersion }"));
  assert.ok(prepareLayout.indexOf('fs.rmSync(normalizedReleaseTarget') < prepareLayout.indexOf("['run', 'build:desktop-shell']"));
  assert.ok(prepareLayout.indexOf("['run', 'build:desktop-shell']") < prepareLayout.indexOf("'omni-desktop-shell.exe'"));
  assert.ok(prepareLayout.includes("CARGO_TARGET_DIR: normalizedReleaseTarget"));
  assert.ok(prepareLayout.includes("['--build-commit']"));
  assert.doesNotMatch(prepareLayout, /apps', 'bridge-service-native', 'target', 'release/);
  assert.doesNotMatch(prepareLayout, /apps', 'desktop', 'src-tauri', 'target', 'release/);
  assert.ok(finalizeSigned.includes('recorded.sha256 = sha256(candidate)'));
  const elevationLauncher = fs.readFileSync(
    path.join(repoRoot, 'scripts/testing/request-elevated-install-release-evidence.ps1'),
    'utf8',
  );
  assert.match(elevationLauncher, /ValidateSet\('INSTALL-FRESH'.*'INSTALL-RELEASE-LAYOUT'\)/s);
  assert.match(elevationLauncher, /Start-Process[\s\S]*-Verb RunAs[\s\S]*-Wait[\s\S]*-PassThru/);
  assert.doesNotMatch(elevationLauncher, /WorkspaceRoot|PackageRoot|DryRun|SkipSigning/);
});
