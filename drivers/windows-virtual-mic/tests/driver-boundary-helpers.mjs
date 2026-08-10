// User-mode contract helpers shared by the omni driver boundary tests and the
// integration test plan. These helpers simulate the omni-owned contracts
// (install state, omni_bridge_ioctl.h, endpoint isolation) without requiring
// the development driver to be installed. Vendored sysvad sources are exempt
// and must never be imported here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(testsDir, '..', '..', '..');
export const driverRoot = path.join(repoRoot, 'drivers', 'windows-virtual-mic');
export const fixturesDir = path.join(testsDir, 'fixtures');

export function readRepoText(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

export function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

export function isVirtualDriverWindowsBuildSupported(windowsBuild, minimumWindowsBuild = 19041) {
  return Number.isInteger(windowsBuild) && windowsBuild >= minimumWindowsBuild;
}

// Mirrors CTL_CODE from winioctl.h for METHOD_BUFFERED contracts.
export const METHOD_BUFFERED = 0;
export const FILE_READ_DATA = 0x0001;
export const FILE_WRITE_DATA = 0x0002;

export function ctlCode(deviceType, functionNumber, method, access) {
  return ((deviceType << 16) | (access << 14) | (functionNumber << 2) | method) >>> 0;
}

export function accessMask(access) {
  if (access === 'read') {
    return FILE_READ_DATA;
  }
  if (access === 'write') {
    return FILE_WRITE_DATA;
  }
  throw new Error(`unknown ioctl access: ${access}`);
}

// User-mode mirror of classify_driver_health_with_device_evidence in
// apps/bridge-service-native/src/lib.rs. The status strings are part of the
// install-state boundary consumed by the desktop shell.
export function classifyDriverHealth({
  installState = null,
  expectedDriverVersion,
  expectedBridgeVersion,
  controlDeviceAvailable = false,
}) {
  if (!installState) {
    return controlDeviceAvailable ? 'running' : 'not-installed';
  }
  if (installState.driverBackend !== 'sysvad-wave-rt') {
    return 'damaged';
  }
  if (
    installState.driverVersion !== expectedDriverVersion ||
    installState.bridgeVersion !== expectedBridgeVersion
  ) {
    return 'version-mismatch';
  }
  return 'running';
}

// Endpoint-isolation naming contract shared by the bridge capture selector
// and the physical playback selectors.
export function isOmniVirtualSpeakerName(friendlyName) {
  return friendlyName.includes('Omni Translate Virtual Speaker');
}

export function selectLoopbackCaptureEndpoint(endpoints, requestedDeviceId) {
  return (
    endpoints.find(
      (endpoint) =>
        endpoint.id === requestedDeviceId || isOmniVirtualSpeakerName(endpoint.friendlyName),
    ) ?? null
  );
}

export function selectPhysicalPlaybackEndpoints(endpoints) {
  return endpoints.filter((endpoint) => !isOmniVirtualSpeakerName(endpoint.friendlyName));
}

export function resolveMonitorPlaybackEndpoint(endpoints, defaultRenderDeviceId) {
  const defaultEndpoint = endpoints.find((endpoint) => endpoint.id === defaultRenderDeviceId);
  if (defaultEndpoint && !isOmniVirtualSpeakerName(defaultEndpoint.friendlyName)) {
    return defaultEndpoint;
  }
  return selectPhysicalPlaybackEndpoints(endpoints)[0] ?? null;
}

// User-mode simulation of the driver ring that backs IOCTL_OMNI_BRIDGE_READ_PCM
// frame delivery. Counter semantics follow OMNI_BRIDGE_STATUS: CapturedBytes is
// everything written by the render endpoint, DeliveredBytes is everything read
// through the ioctl, DroppedBytes is everything discarded by overflow or reset,
// and BufferedBytes is the remainder still held by the ring.
export class BridgeRingSimulator {
  constructor(ringCapacityBytes, abiVersion) {
    this.ringCapacityBytes = ringCapacityBytes;
    this.abiVersion = abiVersion;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.maxBufferedBytes = 0;
    this.capturedBytes = 0;
    this.deliveredBytes = 0;
    this.droppedBytes = 0;
  }

  writeFrame(frameBytes) {
    this.capturedBytes += frameBytes;
    if (frameBytes > this.ringCapacityBytes) {
      this.droppedBytes += frameBytes;
      return;
    }
    this.buffered.push(frameBytes);
    this.bufferedBytes += frameBytes;
    while (this.bufferedBytes > this.ringCapacityBytes) {
      const evicted = this.buffered.shift();
      this.bufferedBytes -= evicted;
      this.droppedBytes += evicted;
    }
    this.maxBufferedBytes = Math.max(this.maxBufferedBytes, this.bufferedBytes);
  }

  readPcm(maxBytes) {
    let delivered = 0;
    while (this.buffered.length > 0 && delivered + this.buffered[0] <= maxBytes) {
      const frame = this.buffered.shift();
      this.bufferedBytes -= frame;
      delivered += frame;
    }
    this.deliveredBytes += delivered;
    return delivered;
  }

  reset() {
    this.droppedBytes += this.bufferedBytes;
    this.buffered = [];
    this.bufferedBytes = 0;
  }

  queryStatus() {
    return {
      AbiVersion: this.abiVersion,
      RingCapacityBytes: this.ringCapacityBytes,
      BufferedBytes: this.bufferedBytes,
      MaxBufferedBytes: this.maxBufferedBytes,
      CapturedBytes: this.capturedBytes,
      DeliveredBytes: this.deliveredBytes,
      DroppedBytes: this.droppedBytes,
    };
  }
}

export class VirtualMicRingSimulator {
  constructor(maxBufferedBytes) {
    this.maxBufferedBytes = maxBufferedBytes;
    this.generation = 0;
    this.active = false;
    this.owner = null;
    this.bufferedBytes = 0;
    this.writtenBytes = 0;
    this.consumedBytes = 0;
    this.droppedBytes = 0;
    this.underrunBytes = 0;
    this.rejectedWrites = 0;
  }

  begin(owner, generation) {
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error('invalid generation');
    if (this.owner !== null && this.owner !== owner) {
      this.rejectedWrites += 1;
      return false;
    }
    if (generation !== this.generation) {
      this.generation = generation;
      this.bufferedBytes = 0;
      this.writtenBytes = 0;
      this.consumedBytes = 0;
      this.droppedBytes = 0;
      this.underrunBytes = 0;
      this.rejectedWrites = 0;
    }
    this.owner = owner;
    this.active = true;
    return true;
  }

  write(owner, generation, byteCount) {
    if (
      !this.active ||
      this.owner !== owner ||
      generation !== this.generation ||
      byteCount <= 0 ||
      byteCount % 2 !== 0
    ) {
      this.rejectedWrites += 1;
      return false;
    }
    this.writtenBytes += byteCount;
    const retained = Math.min(byteCount, this.maxBufferedBytes);
    const skipped = byteCount - retained;
    const overflow = Math.max(0, this.bufferedBytes + retained - this.maxBufferedBytes);
    this.droppedBytes += skipped + overflow;
    this.bufferedBytes = this.bufferedBytes + retained - overflow;
    return true;
  }

  end(owner, generation) {
    if (generation !== this.generation || (this.owner !== null && this.owner !== owner)) {
      this.rejectedWrites += 1;
      return false;
    }
    this.active = false;
    this.owner = null;
    return true;
  }

  close(owner) {
    if (this.owner !== owner) return false;
    this.active = false;
    this.owner = null;
    return true;
  }

  capture(byteCount) {
    const consumed = Math.min(byteCount, this.bufferedBytes);
    const trackUnderrun = this.active || this.bufferedBytes > 0;
    this.bufferedBytes -= consumed;
    this.consumedBytes += consumed;
    if (trackUnderrun) this.underrunBytes += byteCount - consumed;
    return consumed;
  }
}
