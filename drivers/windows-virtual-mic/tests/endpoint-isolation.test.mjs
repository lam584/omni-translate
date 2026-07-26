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
