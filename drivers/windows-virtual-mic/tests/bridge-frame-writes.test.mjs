// Boundary 2 from tests/README.md: bridge frame writes.
// User-mode contract tests for include/omni_bridge_ioctl.h — ioctl codes, the
// OMNI_BRIDGE_STATUS layout, and simulated ring frame-write semantics. The
// ioctl contract is exercised entirely in user mode; no driver is required.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accessMask,
  BridgeRingSimulator,
  ctlCode,
  METHOD_BUFFERED,
  readFixture,
  readRepoText,
} from './driver-boundary-helpers.mjs';

const contract = readFixture('bridge-ioctl-contract.json');
const header = readRepoText('drivers', 'windows-virtual-mic', 'include', 'omni_bridge_ioctl.h');
const bridgeMod = readRepoText('apps', 'bridge-service-native', 'src', 'windows', 'mod.rs');
// The ioctl codes, device path and status base size live in probe_support
// (src/lib.rs) since the bridge/probe dedup refactor.
const bridgeProbeSupport = readRepoText('apps', 'bridge-service-native', 'src', 'lib.rs');

function headerHex(name) {
  const match = header.match(new RegExp(`#define ${name} (0x[0-9A-Fa-f]+)`));
  assert.ok(match, `omni_bridge_ioctl.h no longer defines ${name}`);
  return match[1];
}

test('header device names match the ioctl contract fixture', () => {
  const devicePath = header.match(/#define OMNI_BRIDGE_DEVICE_PATH L"([^"]+)"/);
  assert.ok(devicePath, 'OMNI_BRIDGE_DEVICE_PATH not found in omni_bridge_ioctl.h');
  assert.equal(devicePath[1].replaceAll('\\\\', '\\'), contract.devicePath);

  const kernelName = header.match(/#define OMNI_BRIDGE_KERNEL_DEVICE_NAME L"([^"]+)"/);
  assert.equal(kernelName[1].replaceAll('\\\\', '\\'), contract.kernelDeviceName);

  const dosName = header.match(/#define OMNI_BRIDGE_DOS_DEVICE_NAME L"([^"]+)"/);
  assert.equal(dosName[1].replaceAll('\\\\', '\\'), contract.dosDeviceName);
});

test('header ioctl codes resolve to the pinned contract values', () => {
  assert.equal(headerHex('FILE_DEVICE_OMNI_TRANSLATE'), contract.deviceType);
  assert.equal(headerHex('OMNI_BRIDGE_ABI_VERSION'), contract.abiVersion);

  const declared = {
    readPcm: header.match(
      /IOCTL_OMNI_BRIDGE_READ_PCM \\\s*\n\s*CTL_CODE\(FILE_DEVICE_OMNI_TRANSLATE, (0x[0-9A-Fa-f]+), METHOD_BUFFERED, FILE_(READ|WRITE)_DATA\)/,
    ),
    queryStatus: header.match(
      /IOCTL_OMNI_BRIDGE_QUERY_STATUS \\\s*\n\s*CTL_CODE\(FILE_DEVICE_OMNI_TRANSLATE, (0x[0-9A-Fa-f]+), METHOD_BUFFERED, FILE_(READ|WRITE)_DATA\)/,
    ),
    reset: header.match(
      /IOCTL_OMNI_BRIDGE_RESET \\\s*\n\s*CTL_CODE\(FILE_DEVICE_OMNI_TRANSLATE, (0x[0-9A-Fa-f]+), METHOD_BUFFERED, FILE_(READ|WRITE)_DATA\)/,
    ),
  };

  for (const [name, expected] of Object.entries(contract.ioctls)) {
    const declaration = declared[name];
    assert.ok(declaration, `omni_bridge_ioctl.h no longer declares the ${name} ioctl`);
    assert.equal(declaration[1], expected.function, `${name} function number drifted`);
    assert.equal(declaration[2].toLowerCase(), expected.access, `${name} access drifted`);

    const computed = ctlCode(
      Number(contract.deviceType),
      Number(declaration[1]),
      METHOD_BUFFERED,
      accessMask(expected.access),
    );
    assert.equal(computed, Number(expected.code), `${name} CTL_CODE drifted`);
  }
});

test('bridge service reimplements the exact same ioctl codes in user mode', () => {
  assert.ok(bridgeProbeSupport.includes('r"\\\\.\\OmniTranslateVirtualAudio"'));
  assert.ok(bridgeProbeSupport.includes(`FILE_DEVICE_OMNI_TRANSLATE: u32 = ${contract.deviceType}`));
  for (const [name, expected] of Object.entries(contract.ioctls)) {
    assert.ok(
      bridgeProbeSupport.includes(`(${expected.function} << 2)`),
      `bridge lib.rs no longer derives the ${name} function ${expected.function}`,
    );
  }
});

test('status struct layout matches the header field-for-field', () => {
  const structBody = header.match(/typedef struct _OMNI_BRIDGE_STATUS\s*\{([\s\S]*?)\}/);
  assert.ok(structBody, 'OMNI_BRIDGE_STATUS struct not found in omni_bridge_ioctl.h');
  const headerFields = [...structBody[1].matchAll(/^\s*(ULONGLONG|ULONG) (\w+);/gm)].map(
    (match) => ({ type: match[1], name: match[2] }),
  );

  assert.deepEqual(
    headerFields,
    contract.statusStruct.fields.map((field) => ({ type: field.type, name: field.name })),
  );

  const sizeBytes = contract.statusStruct.fields.reduce((total, field) => total + field.bytes, 0);
  assert.equal(sizeBytes, contract.statusStruct.sizeBytes);
  // The bridge reads this struct as a 40-byte base prefix.
  assert.ok(
    bridgeProbeSupport.includes(`DRIVER_STATUS_BASE_SIZE: u32 = ${contract.statusStruct.sizeBytes}`),
    'bridge lib.rs no longer pins the 40-byte OMNI_BRIDGE_STATUS base size',
  );
});

test('frame geometry matches the bridge source chunk constant', () => {
  const { sampleRateHz, channelCount, bytesPerSample, frameIntervalMs, chunkBytes } =
    contract.frameGeometry;
  const framesPerChunk = (sampleRateHz * frameIntervalMs) / 1000;
  assert.equal(framesPerChunk * channelCount * bytesPerSample, chunkBytes);
  assert.ok(
    bridgeMod.includes(`${framesPerChunk} * INTERNAL_CHANNEL_COUNT as usize * 2`),
    'bridge mod.rs no longer derives OMNI_SOURCE_CHUNK_BYTES from 20 ms at 48 kHz stereo',
  );
});

test('simulated ring preserves the status counter conservation invariant', () => {
  const { chunkBytes } = contract.frameGeometry;
  const ring = new BridgeRingSimulator(chunkBytes * 4, Number(contract.abiVersion));

  const assertConserved = () => {
    const status = ring.queryStatus();
    assert.equal(
      status.CapturedBytes,
      status.DeliveredBytes + status.BufferedBytes + status.DroppedBytes,
      'CapturedBytes must equal DeliveredBytes + BufferedBytes + DroppedBytes',
    );
  };

  // Steady state: writes are drained through IOCTL_OMNI_BRIDGE_READ_PCM.
  ring.writeFrame(chunkBytes);
  ring.writeFrame(chunkBytes);
  assert.equal(ring.readPcm(chunkBytes), chunkBytes);
  assertConserved();

  // Overflow: the ring evicts the oldest frames and accounts for them as drops.
  for (let index = 0; index < 6; index += 1) {
    ring.writeFrame(chunkBytes);
  }
  const overflowed = ring.queryStatus();
  assert.equal(overflowed.BufferedBytes, chunkBytes * 4);
  assert.equal(overflowed.MaxBufferedBytes, chunkBytes * 4);
  assert.ok(overflowed.DroppedBytes >= chunkBytes * 2);
  assertConserved();

  // A frame larger than the ring can never be buffered.
  ring.writeFrame(chunkBytes * 5);
  assert.equal(ring.queryStatus().BufferedBytes, chunkBytes * 4);
  assertConserved();

  // IOCTL_OMNI_BRIDGE_RESET empties the ring without losing accounting.
  ring.reset();
  const reset = ring.queryStatus();
  assert.equal(reset.BufferedBytes, 0);
  assert.equal(reset.AbiVersion, Number(contract.abiVersion));
  assert.equal(reset.RingCapacityBytes, chunkBytes * 4);
  assertConserved();

  // Reads never deliver partial frames beyond the requested budget.
  ring.writeFrame(chunkBytes);
  assert.equal(ring.readPcm(chunkBytes - 1), 0);
  assert.equal(ring.readPcm(chunkBytes), chunkBytes);
  assertConserved();
});
