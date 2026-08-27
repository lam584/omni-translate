// Boundary 1 from tests/README.md: install state creation.
// User-mode contract tests for driver-install-state.json — the file written by
// scripts/installer/install-development-driver.ps1 and consumed by the native
// bridge and the desktop shell. No installed driver is required.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  classifyDriverHealth,
  isVirtualDriverWindowsBuildSupported,
  readFixture,
  readRepoText,
  repoRoot,
} from './driver-boundary-helpers.mjs';

const installState = readFixture('driver-install-state.sample.json');
const manifest = JSON.parse(
  readRepoText('drivers', 'windows-virtual-mic', 'src', 'driver_manifest.json'),
);
const kernelImportMinimumBuilds = readFixture('kernel-import-minimum-builds.json');
const driverPackageMetadata = JSON.parse(
  readRepoText('drivers', 'windows-virtual-mic', 'src', 'driver_package_contract.json'),
);

test('driver package separates the tracked source contract from the generated signer receipt', () => {
  const buildScript = readRepoText('scripts', 'installer', 'build-sysvad-driver.ps1');
  const gitignore = readRepoText('.gitignore');
  const attributes = readRepoText('.gitattributes');

  assert.match(buildScript, /\$stagedMetadata = Join-Path \$packageRoot 'driver-package\.json'/);
  assert.match(gitignore, /^drivers\/windows-virtual-mic\/package\/driver-package\.json$/m);
  assert.match(
    attributes,
    /^drivers\/windows-virtual-mic\/src\/driver_package_contract\.json text eol=lf$/m,
  );
  assert.equal(Object.hasOwn(driverPackageMetadata, 'signerThumbprint'), false);
});

// Fields the desktop shell deserializes (DriverInstallStateFile) plus the
// backend/device identity fields the bridge and probe script rely on.
const requiredFields = [
  'protocolVersion',
  'installChannel',
  'driverVersion',
  'bridgeVersion',
  'driverHealth',
  'installedAt',
  'targetDeviceId',
  'virtualRenderDeviceId',
  'virtualCaptureDeviceId',
  'driverBackend',
  'deviceName',
];

test('install state fixture carries every consumer-required field', () => {
  for (const field of requiredFields) {
    assert.ok(
      typeof installState[field] === 'string' && installState[field].length > 0,
      `driver-install-state.sample.json is missing a non-empty "${field}"`,
    );
  }
});

test('installer script writes every field declared by the fixture', () => {
  const installer = readRepoText('scripts', 'installer', 'install-development-driver.ps1');
  const stateBlock = installer.match(/\$state = \[ordered\]@\{([\s\S]*?)\n\}/);
  assert.ok(stateBlock, 'install-development-driver.ps1 no longer builds the $state block');
  const writtenKeys = [...stateBlock[1].matchAll(/^\s*(\w+) =/gm)].map((match) => match[1]);
  for (const field of Object.keys(installState)) {
    assert.ok(
      writtenKeys.includes(field),
      `installer no longer writes install-state field "${field}"`,
    );
  }
});

test('install state identity matches the omni driver manifest', () => {
  assert.equal(installState.deviceName, manifest.deviceName);
  assert.equal(manifest.captureDeviceName, 'Omni Translate Virtual Microphone');
  assert.deepEqual(manifest.endpointDirections, ['render', 'capture']);
  assert.equal(installState.driverVersion, manifest.version);
  assert.equal(installState.targetDeviceId, manifest.deviceId);
  assert.equal(installState.driverBackend, 'sysvad-wave-rt');
});

test('install state protocol version matches the bridge protocol constant', () => {
  // The constant moved into the shared omni-bridge-protocol crate (the bridge
  // lib.rs only re-exports it), so read it from the authoritative source.
  const protocolLib = readRepoText('crates', 'omni-bridge-protocol', 'src', 'lib.rs');
  const constant = protocolLib.match(/BRIDGE_PROTOCOL_VERSION: &str = "([^"]+)"/);
  assert.ok(constant, 'BRIDGE_PROTOCOL_VERSION constant not found in omni-bridge-protocol lib.rs');
  assert.equal(installState.protocolVersion, constant[1]);
});

test('driver health classification covers the full install-state contract', () => {
  const expected = {
    expectedDriverVersion: installState.driverVersion,
    expectedBridgeVersion: installState.bridgeVersion,
  };

  assert.equal(classifyDriverHealth({ ...expected }), 'not-installed');
  assert.equal(
    classifyDriverHealth({ ...expected, controlDeviceAvailable: true }),
    'running',
  );
  assert.equal(
    classifyDriverHealth({
      ...expected,
      installState: { ...installState, driverBackend: 'placeholder' },
    }),
    'damaged',
  );
  assert.equal(
    classifyDriverHealth({
      ...expected,
      installState: { ...installState, driverVersion: '0.0.1-dev' },
    }),
    'version-mismatch',
  );
  assert.equal(
    classifyDriverHealth({
      ...expected,
      installState: { ...installState, bridgeVersion: '9.9.9' },
    }),
    'version-mismatch',
  );
  assert.equal(classifyDriverHealth({ ...expected, installState }), 'running');
});

test('bridge crate pins the same health states and backend literal', () => {
  const bridgeLib = readRepoText('apps', 'bridge-service-native', 'src', 'lib.rs');
  for (const literal of ['"not-installed"', '"damaged"', '"version-mismatch"', '"running"', '"sysvad-wave-rt"']) {
    assert.ok(
      bridgeLib.includes(literal),
      `bridge lib.rs no longer pins install-state literal ${literal}`,
    );
  }
});

test('virtual driver install boundary is Windows build 19041 across INF and installer', () => {
  const minimumBuild = kernelImportMinimumBuilds.minimumSupportedWindowsBuild;
  const inf = readRepoText(
    'drivers',
    'windows-virtual-mic',
    'sysvad',
    'TabletAudioSample',
    'ComponentizedAudioSample.inx',
  );
  const installerHelpers = readRepoText('scripts', 'installer', 'virtual-speaker-device.ps1');
  const frontendCapability = readRepoText(
    'apps', 'desktop', 'src', 'utils', 'virtual-driver-capability.ts',
  );
  const probe = readRepoText('scripts', 'installer', 'probe-development-driver.ps1');

  assert.equal(minimumBuild, 19041);
  assert.equal(driverPackageMetadata.minimumWindowsBuild, minimumBuild);
  assert.equal(driverPackageMetadata.kernelImportMinimumWindowsBuild, minimumBuild);
  assert.match(inf, /%MfgName%=OMNI,NT\$ARCH\$\.10\.0\.\.\.19041/);
  assert.match(inf, /\[OMNI\.NT\$ARCH\$\.10\.0\.\.\.19041\]/);
  assert.doesNotMatch(inf, /\.\.\.22621/);
  assert.match(installerHelpers, /\$script:OmniVirtualDriverMinimumWindowsBuild = 19041/);
  assert.match(frontendCapability, /VIRTUAL_DRIVER_MINIMUM_WINDOWS_BUILD = 19041/);
  assert.match(probe, /virtualDriverMinimumWindowsBuild = \$script:OmniVirtualDriverMinimumWindowsBuild/);
  assert.match(probe, /virtualDriverWindowsBuildSupported = \$virtualDriverWindowsBuildSupported/);
  assert.equal(isVirtualDriverWindowsBuildSupported(19040, minimumBuild), false);
  assert.equal(isVirtualDriverWindowsBuildSupported(19041, minimumBuild), true);
});

test('WDK build audits every imported symbol against the minimum-build fixture', () => {
  const builds = Object.values(kernelImportMinimumBuilds.modules)
    .flatMap((symbols) => Object.values(symbols));
  const buildScript = readRepoText('scripts', 'installer', 'build-sysvad-driver.ps1');

  assert.equal(Math.max(...builds), kernelImportMinimumBuilds.minimumSupportedWindowsBuild);
  assert.equal(kernelImportMinimumBuilds.modules['ntoskrnl.exe'].ExAllocatePool2, 19041);
  assert.match(buildScript, /kernel-import-minimum-builds\.json/);
  assert.match(buildScript, /does not declare .*Audit its minimum Windows build before shipping/);
  assert.match(buildScript, /minimumWindowsBuild -gt \$declaredMinimumWindowsBuild/);
});

test('explicit development DevCon authority is workspace-bound and Microsoft-signed', () => {
  const installer = readRepoText('scripts', 'installer', 'install-development-driver.ps1');
  const authority = readRepoText('scripts', 'installer', 'devcon-authority.ps1');

  assert.match(installer, /\[string\]\$DevconPath = ''/);
  assert.match(installer, /Release installs do not accept an explicit DevCon path/);
  assert.match(installer, /Resolve-OmniDevconPath -WorkspaceRoot \$workspacePath -ExplicitPath \$DevconPath/);
  assert.match(authority, /Explicit DevCon path escapes WorkspaceRoot/);
  assert.match(authority, /Resolved DevCon path escapes WorkspaceRoot/);
  assert.match(authority, /Test-Path -LiteralPath \$candidatePath -PathType Leaf/);
  assert.match(authority, /Get-AuthenticodeSignature -LiteralPath \$Path/);
  assert.match(authority, /\$signature\.Status -ne 'Valid'/);
  assert.match(authority, /O=Microsoft Corporation/);
  assert.match(authority, /DevCon must have a valid Microsoft Authenticode signature/);
});

test('repair forwards explicit DevCon only to package validation and install', () => {
  const repair = readRepoText('scripts', 'installer', 'repair-driver.ps1');
  const forwarded = repair.match(/-DevconPath \$DevconPath/g) ?? [];

  assert.match(repair, /\[string\]\$DevconPath = ''/);
  assert.equal(forwarded.length, 2);
  assert.doesNotMatch(
    repair,
    /uninstall-development-driver\.ps1[^\n]*-DevconPath/,
  );
});

function invokeDevconAuthority({ workspaceRoot, explicitPath, signature = null }) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const authorityPath = path.join(repoRoot, 'scripts', 'installer', 'devcon-authority.ps1');
  const signatureMock = signature
    ? `function Get-AuthenticodeSignature { param([string]$LiteralPath) [pscustomobject]@{ Status = ${quote(signature.status)}; SignerCertificate = $(${signature.subject ? `[pscustomobject]@{ Subject = ${quote(signature.subject)} }` : '$null'}) } }`
    : '';
  const command = [
    "$ErrorActionPreference = 'Stop'",
    signatureMock,
    `. ${quote(authorityPath)}`,
    `Resolve-OmniDevconPath -WorkspaceRoot ${quote(workspaceRoot)} -ExplicitPath ${quote(explicitPath)}`,
  ].filter(Boolean).join('; ');
  return spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' },
  );
}

test('explicit DevCon rejects a path outside WorkspaceRoot before signature validation', {
  skip: process.platform !== 'win32',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-devcon-authority-'));
  const workspaceRoot = path.join(root, 'workspace');
  const escapedPath = path.join(root, 'outside.exe');
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(escapedPath, 'fixture');
  try {
    const result = invokeDevconAuthority({
      workspaceRoot,
      explicitPath: escapedPath,
      signature: { status: 'Valid', subject: 'CN=Microsoft Corporation, O=Microsoft Corporation' },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /escapes WorkspaceRoot/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit DevCon rejects a nonexistent or unsigned executable', {
  skip: process.platform !== 'win32',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-devcon-authority-'));
  const missingPath = path.join(root, 'missing.exe');
  const unsignedPath = path.join(root, 'unsigned.exe');
  fs.writeFileSync(unsignedPath, 'not a signed executable');
  try {
    const missing = invokeDevconAuthority({
      workspaceRoot: root,
      explicitPath: missingPath,
      signature: { status: 'Valid', subject: 'CN=Microsoft Corporation, O=Microsoft Corporation' },
    });
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}\n${missing.stderr}`, /was not found/);

    const unsigned = invokeDevconAuthority({ workspaceRoot: root, explicitPath: unsignedPath });
    assert.notEqual(unsigned.status, 0);
    assert.match(`${unsigned.stdout}\n${unsigned.stderr}`, /valid Microsoft Authenticode signature/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit DevCon rejects a valid non-Microsoft signer', {
  skip: process.platform !== 'win32',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-devcon-authority-'));
  const candidatePath = path.join(root, 'devcon.exe');
  fs.writeFileSync(candidatePath, 'fixture');
  try {
    const result = invokeDevconAuthority({
      workspaceRoot: root,
      explicitPath: candidatePath,
      signature: { status: 'Valid', subject: 'CN=Contoso Tools, O=Contoso Corporation' },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /valid Microsoft Authenticode signature/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit DevCon accepts a workspace-local valid Microsoft signer', {
  skip: process.platform !== 'win32',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-devcon-authority-'));
  const candidatePath = path.join(root, 'devcon.exe');
  fs.writeFileSync(candidatePath, 'fixture');
  try {
    const result = invokeDevconAuthority({
      workspaceRoot: root,
      explicitPath: candidatePath,
      signature: { status: 'Valid', subject: 'CN=Microsoft Corporation, O=Microsoft Corporation' },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.trim(), candidatePath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function invokeJsonPowerShellAuthority(scriptBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-json-ps-authority-'));
  const producerPath = path.join(root, 'producer.ps1');
  const authorityPath = path.join(repoRoot, 'scripts', 'testing', 'powershell-script-authority.ps1');
  fs.writeFileSync(producerPath, scriptBody, 'utf8');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellQuote(authorityPath)}`,
    'Remove-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue',
    `$result = Invoke-OmniJsonPowerShellScript -ScriptPath ${powershellQuote(producerPath)} -Label 'fixture producer'`,
    '$result | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' },
  );
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

test('JSON PowerShell authority accepts valid JSON when LASTEXITCODE is null', {
  skip: process.platform !== 'win32',
}, () => {
  const result = invokeJsonPowerShellAuthority(`
Remove-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$localizedStatus = -join @([char]0x7B7E,[char]0x540D,[char]0x5DF2,[char]0x901A,[char]0x8FC7,[char]0x9A8C,[char]0x8BC1,[char]0x3002)
[pscustomobject]@{ schemaVersion = 1; status = 'ready'; localizedStatus = $localizedStatus } | ConvertTo-Json -Compress
`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    status: 'ready',
    localizedStatus: '签名已通过验证。',
  });
});

test('JSON PowerShell authority rejects nonzero, throw, empty, and invalid JSON producers', {
  skip: process.platform !== 'win32',
}, () => {
  const cases = [
    {
      body: `Write-Output '{"schemaVersion":1}'; exit 7`,
      error: /unsuccessful PowerShell invocation/,
    },
    { body: "throw 'fixture boom'", error: /unsuccessful PowerShell invocation[\s\S]*fixture boom/ },
    { body: '# intentionally empty', error: /returned no JSON output/ },
    { body: "Write-Output 'not-json'", error: /returned invalid JSON/ },
  ];
  for (const fixture of cases) {
    const result = invokeJsonPowerShellAuthority(fixture.body);
    assert.notEqual(result.status, 0, fixture.body);
    assert.match(`${result.stdout}\n${result.stderr}`, fixture.error);
  }
});

function buildVirtualMicFingerprintWav() {
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
  const frameCount = 153_600;
  const startFrame = 5_184;
  const dataBytes = frameCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(96_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < 24_000; frame += 1) {
    const expected = expectedPcm.readInt16LE(frame * 2);
    const delta = frame % 4 === 0 ? 1 : frame % 4 === 1 ? -1 : 0;
    wav.writeInt16LE(expected + delta, 44 + (startFrame + frame) * 2);
  }
  return { wav, expectedPcm, startFrame };
}

function virtualMicCaptureAuthorityFixture(wav, expectedPcm, startFrame) {
  const cueId = 'virtual-mic-target-cue-fixture';
  const sessionId = 'virtual-mic-target-session-fixture';
  const endpointId = '{0.0.1.00000000}.{11111111-2222-3333-4444-555555555555}';
  const endpointName = 'Omni Translate Virtual Microphone (Omni Translate Virtual Speaker)';
  const capturedFrames = (wav.length - 44) / 2;
  const captureWavSha256 = crypto.createHash('sha256').update(wav).digest('hex');
  const cueStatusTimeline = ['queued', 'started', 'completed'].map((playbackStatus, index) => ({
    type: 'bridge.translation.status',
    statusId: `status-${index + 1}`,
    requestId: `request-${index + 1}`,
    sessionId,
    cueId,
    playbackStatus,
    reason: `fixture-${playbackStatus}`,
    timestampMs: 1_786_379_405_403,
    collectorReceivedAtMonotonicNs: (index + 1) * 1000,
  }));
  const shared = {
    capturedAt: '2026-08-10T16:30:08.609Z',
    collectorId: 'omni-virtual-mic-target-capture',
    collectorVersion: '0.1.0',
    parentCollectorProcessId: 101,
    captureChildProcessId: 202,
    bridgeProtocolVersion: '2026-08-27-audio-routing-v8',
    bridgeProcessId: 303,
    bridgeInstanceId: 'bridge-instance-fixture',
    bridgeSessionId: sessionId,
    captureEndpointId: endpointId,
    captureEndpointName: endpointName,
    rawCountersBefore: { virtualMicFramesWritten: 10, playbackFramesWritten: 20 },
    rawCountersAfter: { virtualMicFramesWritten: 33_610, playbackFramesWritten: 20 },
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
    captureWav: 'virtual-mic-capture.wav',
    captureWavSha256,
    capturedFrames,
    fingerprint: {
      id: 'virtual-mic-fingerprint-fixture',
      detected: true,
      frequencyHz: 997,
      startFrame,
      frameCount: 24_000,
      expectedPcmHex: expectedPcm.toString('hex'),
      expectedPcmSha256: crypto.createHash('sha256').update(expectedPcm).digest('hex'),
    },
  };
  return {
    probe: {
      schemaVersion: 1,
      artifactKind: 'virtual-mic-real-capture-probe',
      ...structuredClone(shared),
      targetCaptureApplication: {
        classification: 'real-target',
        name: 'Omni Translate Virtual Microphone Target Capture',
        processId: 202,
        captureApi: 'WASAPI',
        openedEndpoint: true,
        endpointId,
        endpointName,
      },
      format: { sampleRateHz: 48_000, channelCount: 1, bitsPerSample: 16, encoding: 'pcm16' },
    },
    snapshot: {
      schemaVersion: 1,
      artifactKind: 'virtual-mic-runtime-snapshot',
      ...structuredClone(shared),
      virtualMicOutputSupported: true,
      virtualMicOutputStatus: 'ready',
      virtualMicFormat: '48000Hz/mono/pcm16',
      virtualMicFramesWritten: 33_610,
      virtualMicFramesWrittenBefore: 10,
      virtualMicFramesWrittenAfter: 33_610,
      virtualMicFramesWrittenForCue: 33_600,
      physicalPlaybackFramesWrittenBefore: 20,
      physicalPlaybackFramesWrittenAfter: 20,
      physicalPlaybackFramesWrittenForCue: 0,
    },
  };
}

function invokeVirtualMicCaptureAuthority({ mutate, mutateWav } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-vmic-capture-authority-'));
  const wavPath = path.join(root, 'virtual-mic-capture.wav');
  const { wav, expectedPcm, startFrame } = buildVirtualMicFingerprintWav();
  const fixture = virtualMicCaptureAuthorityFixture(wav, expectedPcm, startFrame);
  mutate?.(fixture);
  const writtenWav = Buffer.from(wav);
  mutateWav?.(writtenWav);
  fs.writeFileSync(wavPath, writtenWav);
  const probePath = path.join(root, 'virtual-mic-capture-probe.json');
  const snapshotPath = path.join(root, 'runtime-snapshot.json');
  fs.writeFileSync(probePath, JSON.stringify(fixture.probe), 'utf8');
  fs.writeFileSync(snapshotPath, JSON.stringify(fixture.snapshot), 'utf8');
  const helperPath = path.join(repoRoot, 'scripts', 'testing', 'virtual-mic-capture-authority.ps1');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellQuote(helperPath)}`,
    `$probe = Get-Content -LiteralPath ${powershellQuote(probePath)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
    `$snapshot = Get-Content -LiteralPath ${powershellQuote(snapshotPath)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
    `$result = Assert-OmniVirtualMicCaptureAuthority -CaptureProbe $probe -RuntimeSnapshot $snapshot -CaptureWavPath ${powershellQuote(wavPath)}`,
    '$result | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' },
  );
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

test('VMic health authority is recomputed from raw v6 endpoint/counter/timeline/WAV evidence', {
  skip: process.platform !== 'win32',
}, () => {
  const result = invokeVirtualMicCaptureAuthority();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const projection = JSON.parse(result.stdout);
  assert.equal(projection.passed, true);
  assert.equal(projection.protocolVersion, '2026-08-27-audio-routing-v8');
  assert.equal(projection.bridgeProcessId, 303);
  assert.equal(projection.fingerprintAuthority.algorithm, 'omni-vmic-fingerprint-pcm16-v1');
  assert.equal(projection.fingerprintAuthority.maxSampleDelta, 1);
});

test('VMic health authority rejects missing or divergent raw proof instead of trusting passed', {
  skip: process.platform !== 'win32',
}, () => {
  const cases = [
    ['missing protocol', (value) => { delete value.probe.bridgeProtocolVersion; }],
    ['same PID', (value) => { value.probe.bridgeProcessId = value.probe.captureChildProcessId; value.snapshot.bridgeProcessId = value.snapshot.captureChildProcessId; }],
    ['render endpoint', (value) => { value.probe.captureEndpointId = '{0.0.0.00000000}.{bad}'; value.snapshot.captureEndpointId = value.probe.captureEndpointId; value.probe.targetCaptureApplication.endpointId = value.probe.captureEndpointId; }],
    ['counter mismatch', (value) => { value.probe.recomputedCounterDelta.virtualMicFramesWritten += 1; value.snapshot.recomputedCounterDelta.virtualMicFramesWritten += 1; }],
    ['legacy eventType', (value) => { value.probe.cueStatusTimeline[0].eventType = value.probe.cueStatusTimeline[0].type; delete value.probe.cueStatusTimeline[0].type; value.snapshot.cueStatusTimeline = structuredClone(value.probe.cueStatusTimeline); }],
    ['failed terminal status', (value) => { value.probe.cueStatusTimeline[2].playbackStatus = 'route-failed'; value.snapshot.cueStatusTimeline = structuredClone(value.probe.cueStatusTimeline); }],
    ['target not opened', (value) => { value.probe.targetCaptureApplication.openedEndpoint = false; }],
    ['fingerprint missing', (value) => { value.probe.fingerprint.detected = false; value.snapshot.fingerprint.detected = false; }],
    ['fingerprint hash forged', (value) => { value.probe.fingerprint.expectedPcmSha256 = '0'.repeat(64); value.snapshot.fingerprint.expectedPcmSha256 = '0'.repeat(64); }],
    ['runtime counter missing', (value) => { delete value.snapshot.virtualMicFramesWrittenForCue; }],
    ['cross-document divergence', (value) => { value.snapshot.bridgeInstanceId = 'other-bridge'; }],
  ];
  for (const [label, mutate] of cases) {
    const result = invokeVirtualMicCaptureAuthority({ mutate });
    assert.notEqual(result.status, 0, label);
    assert.match(`${result.stdout}\n${result.stderr}`, /Virtual microphone capture authority failed/, label);
  }
  const wavTamper = invokeVirtualMicCaptureAuthority({
    mutateWav: (wav) => { wav[100] ^= 0x01; },
  });
  assert.notEqual(wavTamper.status, 0);
  assert.match(`${wavTamper.stdout}\n${wavTamper.stderr}`, /WAV SHA-256/);
});

function invokeEndpointClassification(endpoint) {
  const helperPath = path.join(repoRoot, 'scripts', 'installer', 'virtual-speaker-device.ps1');
  const encoded = Buffer.from(JSON.stringify(endpoint), 'utf8').toString('base64');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellQuote(helperPath)}`,
    `$endpoint = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellQuote(encoded)})) | ConvertFrom-Json`,
    "$render = Test-OmniVirtualAudioEndpoint -Endpoint $endpoint -Direction render -ExpectedEndpointName 'Omni Translate Virtual Speaker'",
    "$capture = Test-OmniVirtualAudioEndpoint -Endpoint $endpoint -Direction capture -ExpectedEndpointName 'Omni Translate Virtual Microphone'",
    '[pscustomobject]@{ render = $render; capture = $capture } | ConvertTo-Json -Compress',
  ].join('; ');
  return spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' },
  );
}

test('MMDevice dataflow prevents the parenthesized capture name from entering render evidence', {
  skip: process.platform !== 'win32',
}, () => {
  const capture = invokeEndpointClassification({
    InstanceId: 'SWD\\MMDEVAPI\\{0.0.1.00000000}.{CAPTURE-FIXTURE}',
    FriendlyName: 'Omni Translate Virtual Microphone (Omni Translate Virtual Speaker)',
  });
  assert.equal(capture.status, 0, `${capture.stdout}\n${capture.stderr}`);
  assert.deepEqual(JSON.parse(capture.stdout), { render: false, capture: true });

  const render = invokeEndpointClassification({
    InstanceId: 'SWD\\MMDEVAPI\\{0.0.0.00000000}.{RENDER-FIXTURE}',
    FriendlyName: 'Speakers (Omni Translate Virtual Speaker)',
  });
  assert.equal(render.status, 0, `${render.stdout}\n${render.stderr}`);
  assert.deepEqual(JSON.parse(render.stdout), { render: true, capture: false });
});

function invokeSignedDriverAuthority(authority) {
  const helperPath = path.join(repoRoot, 'scripts', 'installer', 'virtual-speaker-device.ps1');
  const encoded = Buffer.from(JSON.stringify(authority), 'utf8').toString('base64');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellQuote(helperPath)}`,
    `$fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellQuote(encoded)})) | ConvertFrom-Json`,
    '$valid = Test-OmniInstalledDriverAuthorityRecord -Candidate $fixture.candidate -Binding $fixture.binding -Package $fixture.package -ExpectedDriverVersion $fixture.package.Version',
    "if ($valid) { Write-Output 'true' } else { Write-Output 'false' }",
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim() === 'true';
}

function invokePnpDriverStoreAuthority(authority) {
  const helperPath = path.join(repoRoot, 'scripts', 'installer', 'virtual-speaker-device.ps1');
  const encoded = Buffer.from(JSON.stringify(authority), 'utf8').toString('base64');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellQuote(helperPath)}`,
    `$fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellQuote(encoded)})) | ConvertFrom-Json`,
    '$valid = Test-OmniPnpDriverStoreAuthorityRecord -Binding $fixture.binding -Package $fixture.package -ExpectedDriverVersion $fixture.package.Version',
    "if ($valid) { Write-Output 'true' } else { Write-Output 'false' }",
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim() === 'true';
}

function invokeOptionalSignedDriverQuery({ throws = false } = {}) {
  const helperPath = path.join(repoRoot, 'scripts', 'installer', 'virtual-speaker-device.ps1');
  const query = throws
    ? "{ throw [System.InvalidOperationException]::new('fixture WMI unavailable') }"
    : "{ @([pscustomobject]@{ DeviceID = 'ROOT\\MEDIA\\0000'; InfName = 'oem9.inf' }) }";
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellQuote(helperPath)}`,
    `$result = Get-OmniOptionalSignedDriverQuery -Query ${query}`,
    '$result | ConvertTo-Json -Depth 8 -Compress',
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function invokeRequiredNonNegativeCounter(record, propertyName) {
  const helperPath = path.join(repoRoot, 'scripts', 'testing', 'powershell-script-authority.ps1');
  const encoded = Buffer.from(JSON.stringify(record), 'utf8').toString('base64');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellQuote(helperPath)}`,
    `$record = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellQuote(encoded)})) | ConvertFrom-Json`,
    `$value = Get-OmniRequiredNonNegativeInt64Property -Record $record -PropertyName ${powershellQuote(propertyName)} -Label 'fixture probe'`,
    'Write-Output $value',
  ].join('; ');
  return spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' },
  );
}

test('optional Win32_PnPSignedDriver query records provider failure without fabricating rows', {
  skip: process.platform !== 'win32',
}, () => {
  const unavailable = invokeOptionalSignedDriverQuery({ throws: true });
  assert.equal(unavailable.probeStatus, 'query-unavailable');
  assert.deepEqual(unavailable.rows, []);
  assert.equal(unavailable.queryDiagnostic.exceptionType, 'System.InvalidOperationException');
  assert.match(unavailable.queryDiagnostic.message, /fixture WMI unavailable/);
  assert.ok(unavailable.queryDiagnostic.fullyQualifiedErrorId);
  assert.ok(unavailable.queryDiagnostic.category);

  const available = invokeOptionalSignedDriverQuery();
  assert.equal(available.probeStatus, 'query-succeeded');
  assert.equal(available.rows.length, 1);
  assert.equal(available.queryDiagnostic, null);
});

test('raw audio counters must exist and be non-negative Int64 values before collector conversion', {
  skip: process.platform !== 'win32',
}, () => {
  const valid = invokeRequiredNonNegativeCounter({ InvalidSamples: 213_120 }, 'InvalidSamples');
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
  assert.equal(valid.stdout.trim(), '213120');

  for (const record of [
    {},
    { InvalidSamples: null },
    { InvalidSamples: -1 },
    { InvalidSamples: 'NaN' },
    { InvalidSamples: 1.5 },
  ]) {
    const invalid = invokeRequiredNonNegativeCounter(record, 'InvalidSamples');
    assert.notEqual(invalid.status, 0, JSON.stringify(record));
    assert.match(`${invalid.stdout}\n${invalid.stderr}`, /required non-negative integer|not a valid non-negative Int64/);
  }
});

test('installed driver authority cross-binds the real VM PnP, DriverStore, and WMI fields', {
  skip: process.platform !== 'win32',
}, () => {
  const fixture = readFixture('signed-driver-authority.sample.json');
  assert.equal(fixture.candidate.IsSigned, false, 'WMI IsSigned is diagnostic, not package authority');
  assert.equal(invokeSignedDriverAuthority(fixture), true);

  const mutations = [
    (value) => { value.candidate.DeviceID = ''; },
    (value) => { value.candidate.InfName = 'oem10.inf'; },
    (value) => { value.binding.driverVersion = '19.28.55.595'; },
    (value) => { value.binding.driverProvider = 'Contoso'; },
    (value) => { value.binding.service = 'wrong_service'; },
    (value) => { value.binding.matchingDeviceId = 'Root\\OtherDevice'; },
    (value) => { value.package.Driver = 'oem10.inf'; },
    (value) => { value.package.ProviderName = 'Contoso'; },
    (value) => { value.package.ClassName = 'System'; },
    (value) => { value.package.Version = '19.28.55.595'; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(fixture);
    mutate(candidate);
    assert.equal(invokeSignedDriverAuthority(candidate), false);
  }

  const alternateWmiDeviceId = structuredClone(fixture);
  alternateWmiDeviceId.candidate.DeviceID = 'SWD\\MMDEVAPI\\WMI-PROJECTION';
  assert.equal(invokeSignedDriverAuthority(alternateWmiDeviceId), true);
});

test('PnP and DriverStore remain authoritative while WMI publication is explicitly unavailable', {
  skip: process.platform !== 'win32',
}, () => {
  const fixture = readFixture('signed-driver-authority.sample.json');
  assert.equal(invokePnpDriverStoreAuthority(fixture), true);

  const mutations = [
    (value) => { value.binding.infName = ''; },
    (value) => { value.binding.driverVersion = ''; },
    (value) => { value.binding.driverProvider = 'Contoso'; },
    (value) => { value.binding.service = 'wrong_service'; },
    (value) => { value.binding.matchingDeviceId = 'Root\\OtherDevice'; },
    (value) => { value.package.Driver = 'oem10.inf'; },
    (value) => { value.package.ProviderName = 'Contoso'; },
    (value) => { value.package.ClassName = 'System'; },
    (value) => { value.package.Version = '19.28.55.595'; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(fixture);
    mutate(candidate);
    assert.equal(invokePnpDriverStoreAuthority(candidate), false);
  }
});

test('install health collector is fail-closed on structured probe readiness and retains raw driver candidates', () => {
  const collector = readRepoText('scripts', 'testing', 'collect-install-release-state.ps1');
  assert.doesNotMatch(collector, /Driver release probe failed\. ExitCode=|\$LASTEXITCODE/);
  assert.match(collector, /Invoke-OmniJsonPowerShellScript/);
  assert.match(collector, /\$driverProbe\.schemaVersion -ne 1/);
  assert.match(collector, /\$driverProbe\.driverHealth -ne 'running'/);
  assert.match(collector, /\$driverProbe\.virtualMicOutputStatus -ne 'ready'/);
  assert.match(collector, /signedDriverCandidates = @\(\$signedDriverCandidates/);
  assert.match(collector, /signedDriverResolutionStatus = \$signedDriverResolutionStatus/);
  assert.match(collector, /ready-pnp-driverstore-service-files/);
  assert.match(collector, /'not-exposed-yet'/);
  assert.match(collector, /'exposed-consistent'/);
  assert.match(collector, /exposed-conflicting/);
  assert.match(collector, /Get-DriverStoreFileEvidence/);
  assert.match(collector, /installedDriverAuthority = \$installedDriverAuthority/);
  assert.match(collector, /passed = \[bool\]\$testResult\.AudioProbePassed/);
  assert.match(collector, /detail = \$testResult\.AudioProbeDetail/);
  for (const property of [
    'InvalidSamples',
    'DroppedBytesAfterTone',
    'VirtualMicProbeDroppedBytes',
    'VirtualMicProbeRejectedWrites',
  ]) {
    assert.match(collector, new RegExp(`Get-OmniRequiredNonNegativeInt64Property[\\s\\S]*?-PropertyName '${property}'`));
  }
  assert.match(collector, /virtualMicDroppedBytes = \$virtualMicProbeDroppedBytes/);
  assert.match(collector, /virtualMicRejectedWrites = \$virtualMicProbeRejectedWrites/);
  assert.doesNotMatch(collector, /passed = \$true\s*\r?\n\s*endpointId = \[string\]\$testResult\.WasapiEndpointId/);
  assert.match(collector, /\$signedDriverQuery = Get-OmniOptionalSignedDriverQuery/);
  assert.match(collector, /'query-unavailable'/);
  assert.doesNotMatch(collector, /Get-CimInstance Win32_PnPSignedDriver -ErrorAction Stop/);
  assert.doesNotMatch(collector, /did not expose|after 10 seconds/);
  const driverTest = readRepoText('scripts', 'installer', 'test-development-driver.ps1');
  assert.doesNotMatch(driverTest, /did not expose .* within 10 seconds/);
  assert.match(driverTest, /wmiProbeStatus = if \(\$signedDriver\) \{ 'exposed-consistent' \} else \{ 'not-exposed-yet' \}/);
  assert.match(driverTest, /driverStoreInfSha256/);
  assert.match(driverTest, /driverStoreCatSignatureStatus/);
  assert.match(driverTest, /driverStoreSysSignatureStatus/);
  assert.match(driverTest, /AudioProbePassed = \[bool\]\$audioProbe\.passed/);
  assert.match(driverTest, /AudioProbeDetail = \$audioProbe\.detail/);
  assert.match(collector, /pnpDriverStoreAuthorityCount = \$pnpDriverStoreAuthorities\.Count/);
  assert.match(collector, /rootDriverBindings = @\(\$rootDriverBindings\)/);
  assert.match(collector, /Get-Content -LiteralPath \$runtimeStatePath -Raw -Encoding UTF8/);
});

test('release installer consumes PnP and DriverStore authority while WMI remains optional diagnostics', () => {
  const install = readRepoText('scripts', 'installer', 'install-development-driver.ps1');
  assert.match(install, /\$testResult\.InstalledDriverAuthority/);
  assert.match(install, /\$installedDriverAuthority\.installedDriverVersion -ne \[string\]\$stablePackageAuthority\.DriverVersion/);
  assert.match(install, /\$installedDriverAuthority\.pnpDriverVersion -ne \[string\]\$stablePackageAuthority\.DriverVersion/);
  assert.match(install, /\$installedDriverAuthority\.driverStoreVersion -ne \[string\]\$stablePackageAuthority\.DriverVersion/);
  assert.match(install, /driverVersion = if \(\$InstallChannel -eq 'release'\) \{ \[string\]\$installedDriverAuthority\.installedDriverVersion \}/);
  assert.doesNotMatch(install, /Get-CimInstance Win32_PnPSignedDriver/);
  assert.doesNotMatch(install, /installedSignedDriver/);
});
