import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { DriverBridgeCommand, DriverBridgeEvent, DriverInstallState } from '../protocol.js';
import {
  bridgeServiceScaffold,
  describeBridgeBootstrap,
  resolveBridgePaths,
  resolvePipePath,
  startBridgeService,
} from './bridge-service.js';

async function sendRaw(pipePath: string, raw: string) {
  return new Promise<DriverBridgeEvent>((resolve, reject) => {
    const socket = net.createConnection(pipePath, () => {
      socket.write(`${raw}\n`);
    });

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      const line = lines.find((item) => item.trim().length > 0);

      if (!line) {
        return;
      }

      socket.end();
      resolve(JSON.parse(line) as DriverBridgeEvent);
    });
    socket.on('error', reject);
  });
}

async function sendCommand(pipePath: string, command: DriverBridgeCommand) {
  return sendRaw(pipePath, JSON.stringify(command));
}

function makeInstallState(overrides: Partial<DriverInstallState> = {}): DriverInstallState {
  return {
    protocolVersion: bridgeServiceScaffold.protocolVersion,
    installChannel: 'development',
    driverVersion: '0.9.0-dev',
    bridgeVersion: '0.1.0',
    driverHealth: 'running',
    installedAt: new Date().toISOString(),
    targetDeviceId: 'virtual-mic-default',
    ...overrides,
  };
}

function makeInitCommand(sessionId = 'session-1'): DriverBridgeCommand {
  return {
    type: 'bridge.init',
    requestId: `bridge-init-${sessionId}`,
    protocolVersion: bridgeServiceScaffold.protocolVersion,
    sessionId,
    installChannel: 'development',
    targetDeviceId: 'virtual-mic-default',
    expectedDriverVersion: '0.9.0-dev',
    expectedBridgeVersion: '0.1.0',
  };
}

function makeFrameCommand(payloadRef: string, sessionId = 'session-1'): DriverBridgeCommand {
  return {
    type: 'bridge.frame.write',
    requestId: `frame-write-${sessionId}`,
    sessionId,
    frame: {
      frameId: `frame-${sessionId}`,
      streamId: 'stream-1',
      encoding: 'pcm16le',
      channelLayout: 'mono',
      sampleRateHz: 24000,
      channelCount: 1,
      frameCount: 480,
      timestampMs: Date.now(),
      payloadRef,
    },
  };
}

test('bridge service handles init, frame write and shutdown through named pipe IPC', async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'omni-bridge-service-'));
  const pipeName = `omni-bridge-test-${process.pid}-${Date.now()}`;
  const pipePath = resolvePipePath(pipeName);
  const paths = resolveBridgePaths({ runtimeRoot });

  await mkdir(runtimeRoot, { recursive: true });
  const installState: DriverInstallState = {
    protocolVersion: bridgeServiceScaffold.protocolVersion,
    installChannel: 'development',
    driverVersion: '0.9.0-dev',
    bridgeVersion: '0.1.0',
    driverHealth: 'running',
    installedAt: new Date().toISOString(),
    targetDeviceId: 'virtual-mic-default',
  };
  await writeFile(paths.driverStatePath, JSON.stringify(installState, null, 2), 'utf8');

  const service = await startBridgeService({ pipeName, runtimeRoot, bridgeVersion: '0.1.0' });

  try {
    const initEvent = await sendCommand(pipePath, {
      type: 'bridge.init',
      requestId: 'bridge-init-1',
      protocolVersion: bridgeServiceScaffold.protocolVersion,
      sessionId: 'session-1',
      installChannel: 'development',
      targetDeviceId: 'virtual-mic-default',
      expectedDriverVersion: '0.9.0-dev',
      expectedBridgeVersion: '0.1.0',
    });
    assert.equal(initEvent.type, 'bridge.init.ack');
    assert.equal(initEvent.bridgeState, 'running');
    assert.equal(initEvent.driverHealth, 'running');

    const payloadPath = path.join(runtimeRoot, 'payloads', 'frame-1.pcm');
    await mkdir(path.dirname(payloadPath), { recursive: true });
    await writeFile(payloadPath, Buffer.alloc(480 * 2));

    const frameAck = await sendCommand(pipePath, {
      type: 'bridge.frame.write',
      requestId: 'frame-write-1',
      sessionId: 'session-1',
      frame: {
        frameId: 'frame-1',
        streamId: 'stream-1',
        encoding: 'pcm16le',
        channelLayout: 'mono',
        sampleRateHz: 24000,
        channelCount: 1,
        frameCount: 480,
        timestampMs: Date.now(),
        payloadRef: payloadPath,
      },
    });
    assert.equal(frameAck.type, 'bridge.frame.ack');
    assert.equal(frameAck.frameId, 'frame-1');
    assert.equal((await readFile(paths.driverSinkPath)).length, 480 * 2);

    const stateSnapshot = await sendCommand(pipePath, {
      type: 'bridge.state.query',
      requestId: 'bridge-state-1',
    });
    assert.equal(stateSnapshot.type, 'bridge.state.snapshot');
    assert.equal(stateSnapshot.bridgeState, 'running');
    assert.equal(stateSnapshot.driverHealth, 'running');

    const shutdownSnapshot = await sendCommand(pipePath, {
      type: 'bridge.shutdown',
      requestId: 'bridge-stop-1',
      sessionId: 'session-1',
      reason: 'manual-stop',
    });
    assert.equal(shutdownSnapshot.type, 'bridge.state.snapshot');
    assert.equal(shutdownSnapshot.bridgeState, 'stopped');
  } finally {
    await service.close().catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('bridge service accepts driver install state files with utf-8 bom', async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'omni-bridge-bom-'));
  const pipeName = `omni-bridge-bom-${process.pid}-${Date.now()}`;
  const pipePath = resolvePipePath(pipeName);
  const paths = resolveBridgePaths({ runtimeRoot });

  await mkdir(runtimeRoot, { recursive: true });
  const installState: DriverInstallState = {
    protocolVersion: bridgeServiceScaffold.protocolVersion,
    installChannel: 'development',
    driverVersion: '0.9.0-dev',
    bridgeVersion: '0.1.0',
    driverHealth: 'running',
    installedAt: new Date().toISOString(),
    targetDeviceId: 'virtual-mic-default',
  };
  await writeFile(paths.driverStatePath, `\uFEFF${JSON.stringify(installState, null, 2)}`, 'utf8');

  const service = await startBridgeService({ pipeName, runtimeRoot, bridgeVersion: '0.1.0' });

  try {
    const initEvent = await sendCommand(pipePath, {
      type: 'bridge.init',
      requestId: 'bridge-init-bom',
      protocolVersion: bridgeServiceScaffold.protocolVersion,
      sessionId: 'session-bom',
      installChannel: 'development',
      targetDeviceId: 'virtual-mic-default',
      expectedDriverVersion: '0.9.0-dev',
      expectedBridgeVersion: '0.1.0',
    });

    assert.equal(initEvent.type, 'bridge.init.ack');
    assert.equal(initEvent.bridgeState, 'running');
    assert.equal(initEvent.driverHealth, 'running');
  } finally {
    await service.close().catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('bridge service exposes stable bootstrap defaults', () => {
  assert.equal(describeBridgeBootstrap(), bridgeServiceScaffold.startupSequence);
  assert.equal(resolvePipePath(), '\\\\.\\pipe\\omni-bridge-ipc');
  assert.match(resolveBridgePaths().runtimeRoot, /artifacts[\\/]diagnostics[\\/]logs$/);
});

test('bridge service reports unavailable and incompatible driver states', async () => {
  const cases: Array<{
    name: string;
    state?: DriverInstallState;
    expectedHealth: 'not-installed' | 'damaged' | 'version-mismatch';
    expectedError: 'driver.not-installed' | 'driver.version-mismatch';
  }> = [
    {
      name: 'not-installed',
      expectedHealth: 'not-installed',
      expectedError: 'driver.not-installed',
    },
    {
      name: 'damaged',
      state: makeInstallState({ driverHealth: 'damaged' }),
      expectedHealth: 'damaged',
      expectedError: 'driver.version-mismatch',
    },
    {
      name: 'version-mismatch',
      state: makeInstallState({ driverVersion: '0.8.0-dev' }),
      expectedHealth: 'version-mismatch',
      expectedError: 'driver.version-mismatch',
    },
  ];

  for (const item of cases) {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), `omni-bridge-${item.name}-`));
    const pipeName = `omni-bridge-${item.name}-${process.pid}-${Date.now()}-${Math.random()}`;
    const pipePath = resolvePipePath(pipeName);
    const paths = resolveBridgePaths({ runtimeRoot });
    if (item.state) {
      await writeFile(paths.driverStatePath, JSON.stringify(item.state), 'utf8');
    }
    const service = await startBridgeService({ pipeName, runtimeRoot });

    try {
      const initEvent = await sendCommand(pipePath, makeInitCommand(item.name));
      assert.equal(initEvent.type, 'bridge.init.ack');
      assert.equal(initEvent.bridgeState, 'degraded');
      assert.equal(initEvent.driverHealth, item.expectedHealth);

      const snapshot = await sendCommand(pipePath, {
        type: 'bridge.state.query',
        requestId: `state-${item.name}`,
      });
      assert.equal(snapshot.type, 'bridge.state.snapshot');
      assert.equal(snapshot.lastErrorCode, item.expectedError);
    } finally {
      await service.close().catch(() => undefined);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }
});

test('bridge service returns explicit errors for invalid requests and bad payloads', async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'omni-bridge-invalid-'));
  const pipeName = `omni-bridge-invalid-${process.pid}-${Date.now()}`;
  const pipePath = resolvePipePath(pipeName);
  const paths = resolveBridgePaths({ runtimeRoot });
  const payloadPath = path.join(runtimeRoot, 'payloads', 'frame.pcm');
  await mkdir(path.dirname(payloadPath), { recursive: true });
  await writeFile(paths.driverStatePath, JSON.stringify(makeInstallState()), 'utf8');
  await writeFile(payloadPath, Buffer.alloc(480 * 2));
  const service = await startBridgeService({ pipeName, runtimeRoot });

  try {
    const notReady = await sendCommand(pipePath, makeFrameCommand(payloadPath));
    assert.equal(notReady.type, 'bridge.error');
    assert.equal(notReady.code, 'bridge.not-ready');
    assert.equal(notReady.suggestedAction, 'restart-bridge');

    await sendCommand(pipePath, makeInitCommand());
    const wrongSession = await sendCommand(pipePath, makeFrameCommand(payloadPath, 'other-session'));
    assert.equal(wrongSession.type, 'bridge.error');
    assert.equal(wrongSession.code, 'bridge.permission-denied');
    assert.equal(wrongSession.retriable, false);
    assert.equal(wrongSession.suggestedAction, 'open-diagnostics');

    await sendCommand(pipePath, makeInitCommand());
    const unsupportedEncoding = makeFrameCommand(payloadPath);
    if (unsupportedEncoding.type !== 'bridge.frame.write') {
      throw new Error('unexpected command type');
    }
    unsupportedEncoding.frame.encoding = 'wav' as 'pcm16le';
    const badEncoding = await sendCommand(pipePath, unsupportedEncoding);
    assert.equal(badEncoding.type, 'bridge.error');
    assert.equal(badEncoding.code, 'driver.write-failed');

    await sendCommand(pipePath, makeInitCommand());
    await writeFile(payloadPath, Buffer.alloc(2));
    const shortPayload = await sendCommand(pipePath, makeFrameCommand(payloadPath));
    assert.equal(shortPayload.type, 'bridge.error');
    assert.equal(shortPayload.code, 'driver.write-failed');

    const invalidJson = await sendRaw(pipePath, '{broken-json');
    assert.equal(invalidJson.type, 'bridge.error');
    assert.equal(invalidJson.code, 'bridge.timeout');
    assert.equal(invalidJson.retriable, false);

    await writeFile(paths.driverStatePath, '{broken-json', 'utf8');
    const invalidState = await sendCommand(pipePath, makeInitCommand('invalid-state'));
    assert.equal(invalidState.type, 'bridge.error');
    assert.equal(invalidState.code, 'bridge.timeout');
  } finally {
    await service.close().catch(() => undefined);
    await service.close().catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('bridge service rejects frame writes with missing payload files', async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'omni-bridge-missing-payload-'));
  const pipeName = `omni-bridge-missing-${process.pid}-${Date.now()}`;
  const pipePath = resolvePipePath(pipeName);
  const paths = resolveBridgePaths({ runtimeRoot });

  await mkdir(runtimeRoot, { recursive: true });
  const installState: DriverInstallState = {
    protocolVersion: bridgeServiceScaffold.protocolVersion,
    installChannel: 'development',
    driverVersion: '0.9.0-dev',
    bridgeVersion: '0.1.0',
    driverHealth: 'running',
    installedAt: new Date().toISOString(),
    targetDeviceId: 'virtual-mic-default',
  };
  await writeFile(paths.driverStatePath, JSON.stringify(installState, null, 2), 'utf8');

  const service = await startBridgeService({ pipeName, runtimeRoot, bridgeVersion: '0.1.0' });

  try {
    await sendCommand(pipePath, {
      type: 'bridge.init',
      requestId: 'bridge-init-missing',
      protocolVersion: bridgeServiceScaffold.protocolVersion,
      sessionId: 'session-missing',
      installChannel: 'development',
      targetDeviceId: 'virtual-mic-default',
      expectedDriverVersion: '0.9.0-dev',
      expectedBridgeVersion: '0.1.0',
    });

    const error = await sendCommand(pipePath, {
      type: 'bridge.frame.write',
      requestId: 'frame-write-missing',
      sessionId: 'session-missing',
      frame: {
        frameId: 'frame-missing',
        streamId: 'stream-missing',
        encoding: 'pcm16le',
        channelLayout: 'mono',
        sampleRateHz: 24000,
        channelCount: 1,
        frameCount: 480,
        timestampMs: Date.now(),
        payloadRef: path.join(runtimeRoot, 'payloads', 'missing.pcm'),
      },
    });

    assert.equal(error.type, 'bridge.error');
    assert.equal(error.code, 'driver.write-failed');
  } finally {
    await service.close().catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
