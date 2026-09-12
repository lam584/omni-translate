// Boundary 3 from tests/README.md: endpoint isolation.
// User-mode selection tests proving the Omni Translate Virtual Speaker is the
// loopback capture source but is never chosen as a monitor or physical
// playback endpoint, even when Windows reports it as the default WASAPI render
// device. Runs against the shared endpoint fixture; no driver is required.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isOmniVirtualSpeakerName,
  readFixture,
  readRepoText,
  resolveMonitorPlaybackEndpoint,
  selectLoopbackCaptureEndpoint,
  selectPhysicalPlaybackEndpoints,
} from './driver-boundary-helpers.mjs';

const fixture = readFixture('render-endpoints.sample.json');
const manifest = JSON.parse(
  readRepoText('drivers', 'windows-virtual-mic', 'src', 'driver_manifest.json'),
);
const virtualEndpoint = fixture.renderEndpoints.find((endpoint) =>
  isOmniVirtualSpeakerName(endpoint.friendlyName),
);

test('fixture names the virtual speaker exactly as the driver manifest does', () => {
  assert.equal(fixture.virtualSpeakerFriendlyName, manifest.deviceName);
  assert.ok(virtualEndpoint, 'endpoint fixture lost its virtual speaker entry');
  assert.ok(virtualEndpoint.friendlyName.includes(manifest.deviceName));
});

test('virtual speaker name matching accepts localized endpoint names', () => {
  assert.ok(isOmniVirtualSpeakerName('扬声器 (Omni Translate Virtual Speaker)'));
  assert.ok(isOmniVirtualSpeakerName('Speakers (Omni Translate Virtual Speaker)'));
  assert.ok(!isOmniVirtualSpeakerName('USB Audio Device'));
  assert.ok(!isOmniVirtualSpeakerName('Speakers (Realtek(R) Audio)'));
});

test('loopback capture resolves the virtual speaker by id or by name', () => {
  const byId = selectLoopbackCaptureEndpoint(fixture.renderEndpoints, virtualEndpoint.id);
  assert.equal(byId?.id, virtualEndpoint.id);

  const byName = selectLoopbackCaptureEndpoint(fixture.renderEndpoints, 'stale-device-id');
  assert.equal(byName?.id, virtualEndpoint.id);

  const withoutDriver = selectLoopbackCaptureEndpoint(
    fixture.renderEndpoints.filter((endpoint) => endpoint.id !== virtualEndpoint.id),
    'stale-device-id',
  );
  assert.equal(withoutDriver, null);
});

test('physical playback candidates never include the virtual speaker', () => {
  const candidates = selectPhysicalPlaybackEndpoints(fixture.renderEndpoints);
  assert.equal(candidates.length, fixture.renderEndpoints.length - 1);
  assert.ok(candidates.every((endpoint) => !isOmniVirtualSpeakerName(endpoint.friendlyName)));
});

test('monitor playback falls back to a physical device when the default is the virtual speaker', () => {
  const physicalDefault = resolveMonitorPlaybackEndpoint(
    fixture.renderEndpoints,
    fixture.defaultRenderDeviceId,
  );
  assert.equal(physicalDefault?.id, fixture.defaultRenderDeviceId);

  const virtualDefault = resolveMonitorPlaybackEndpoint(
    fixture.renderEndpoints,
    virtualEndpoint.id,
  );
  assert.ok(virtualDefault, 'no physical fallback endpoint was selected');
  assert.ok(!isOmniVirtualSpeakerName(virtualDefault.friendlyName));

  const onlyVirtual = resolveMonitorPlaybackEndpoint([virtualEndpoint], virtualEndpoint.id);
  assert.equal(onlyVirtual, null);
});

test('bridge selectors pin the same friendly-name isolation contract', () => {
  const capture = readRepoText('apps', 'bridge-service-native', 'src', 'windows', 'capture.rs');
  const playback = readRepoText('apps', 'bridge-service-native', 'src', 'windows', 'playback.rs');
  assert.ok(
    capture.includes(`"${manifest.deviceName}"`),
    'capture.rs no longer matches the virtual speaker friendly name',
  );
  assert.ok(
    playback.includes(`name.contains("${manifest.deviceName}")`),
    'playback.rs no longer rejects the virtual speaker as a playback device',
  );
});

test('audio device ACL admits Windows Audio without restoring broad device access', () => {
  const inx = readRepoText(
    'drivers',
    'windows-virtual-mic',
    'sysvad',
    'TabletAudioSample',
    'ComponentizedAudioSample.inx',
  );
  const securityLine = inx.match(/^HKR,,Security,,"([^"]+)"$/m)?.[1] ?? '';
  assert.match(securityLine, /\(A;;GA;;;SY\)/, 'LocalSystem must retain full access');
  assert.match(securityLine, /\(A;;GRGWGX;;;BA\)/, 'administrators must retain device access');
  assert.match(securityLine, /\(A;;GRGWGX;;;IU\)/, 'interactive clients must retain device access');
  assert.match(
    securityLine,
    /\(A;;GRGWGX;;;LS\)/,
    'Windows Audio runs as LocalService and must be able to open the audio device',
  );
  assert.doesNotMatch(securityLine, /;;;WD\)/, 'Everyone access must remain removed');
  assert.doesNotMatch(securityLine, /;;;RC\)/, 'Restricted Code access must remain removed');
});

test('SYSVAD package registers a selectable virtual microphone capture endpoint', () => {
  const miniPairs = readRepoText(
    'drivers',
    'windows-virtual-mic',
    'sysvad',
    'TabletAudioSample',
    'minipairs.h',
  );
  const inx = readRepoText(
    'drivers',
    'windows-virtual-mic',
    'sysvad',
    'TabletAudioSample',
    'ComponentizedAudioSample.inx',
  );
  const stream = readRepoText(
    'drivers',
    'windows-virtual-mic',
    'sysvad',
    'EndpointsCommon',
    'minwavertstream.cpp',
  );

  assert.ok(miniPairs.includes('&MicInMiniports'));
  assert.ok(miniPairs.includes('g_CaptureEndpoints[]'));
  assert.ok(inx.includes('KSCATEGORY_CAPTURE'));
  assert.ok(inx.includes('Omni Translate Virtual Microphone'));
  assert.ok(stream.includes('OmniBridgeReadVirtualMicPcm'));
});

test('installed-route target capture uses Bridge v6 and a separate WASAPI process', () => {
  const targetCapture = readRepoText(
    'apps',
    'bridge-service-native',
    'src',
    'bin',
    'omni-virtual-mic-target-capture.rs',
  );
  const ipc = readRepoText(
    'apps',
    'bridge-service-native',
    'src',
    'bin',
    'virtual_mic_target_capture',
    'ipc.rs',
  );
  const artifacts = readRepoText(
    'apps',
    'bridge-service-native',
    'src',
    'bin',
    'virtual_mic_target_capture',
    'artifacts.rs',
  );
  const captureChild = readRepoText(
    'apps',
    'bridge-service-native',
    'src',
    'bin',
    'virtual_mic_target_capture',
    'capture_child.rs',
  );

  assert.ok(targetCapture.includes('Command::new(current_exe)'));
  assert.ok(targetCapture.includes('.arg("--capture-child")'));
  assert.ok(targetCapture.includes('mod capture_child'));
  assert.ok(captureChild.includes('open_capture_stream(device, &format)'));
  assert.ok(targetCapture.includes('virtualMicOutputRequested'));
  assert.ok(targetCapture.includes('physical_delta != 0'));
  assert.ok(ipc.includes('TranslationAudioSink::VirtualMic'));
  assert.ok(ipc.includes('AudioRouteDirection::Outbound'));
  assert.ok(ipc.includes('TranslationPlaybackStatusAck'));
  assert.ok(artifacts.includes('virtual-mic-capture.wav'));
  assert.ok(artifacts.includes('virtual-mic-capture-probe.json'));
  assert.ok(artifacts.includes('runtime-snapshot.json'));
});

test('driver test and release layouts ship the real target-capture evidence command', () => {
  const driverTest = readRepoText('scripts', 'installer', 'test-development-driver.ps1');
  const helpers = readRepoText('scripts', 'installer', 'virtual-speaker-device.ps1');
  const tauriInstaller = readRepoText('apps', 'desktop', 'src-tauri', 'tauri.installer.conf.json');
  const releaseLayout = readRepoText('scripts', 'release', 'prepare-installer-layout.mjs');

  assert.ok(driverTest.includes('Invoke-OmniVirtualMicTargetCaptureProbe'));
  assert.ok(driverTest.includes('VirtualMicEvidenceOutputDirectory'));
  assert.ok(helpers.includes('omni-virtual-mic-target-capture.exe'));
  assert.ok(tauriInstaller.includes('omni-virtual-mic-target-capture.exe'));
  assert.ok(releaseLayout.includes('omni-virtual-mic-target-capture.exe'));
});
