// Boundary 1 from tests/README.md: install state creation.
// User-mode contract tests for driver-install-state.json — the file written by
// scripts/installer/install-development-driver.ps1 and consumed by the native
// bridge and the desktop shell. No installed driver is required.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDriverHealth,
  readFixture,
  readRepoText,
} from './driver-boundary-helpers.mjs';

const installState = readFixture('driver-install-state.sample.json');
const manifest = JSON.parse(
  readRepoText('drivers', 'windows-virtual-mic', 'src', 'driver_manifest.json'),
);

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
  assert.equal(installState.driverVersion, manifest.version);
  assert.equal(installState.targetDeviceId, manifest.deviceId);
  assert.equal(installState.driverBackend, 'sysvad-wave-rt');
});

test('install state protocol version matches the bridge protocol constant', () => {
  const bridgeLib = readRepoText('apps', 'bridge-service-native', 'src', 'lib.rs');
  const constant = bridgeLib.match(/BRIDGE_PROTOCOL_VERSION: &str = "([^"]+)"/);
  assert.ok(constant, 'BRIDGE_PROTOCOL_VERSION constant not found in bridge lib.rs');
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
