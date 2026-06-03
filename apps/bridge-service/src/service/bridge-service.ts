import { createServer, type Server, type Socket } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  BridgeInitRequest,
  BridgeInitResponse,
  BridgeLifecycleState,
  BridgeRuntimeState,
  BridgeStateSnapshot,
  BridgeWriteFrameRequest,
  BridgeWriteFrameAck,
  DriverBridgeCommand,
  DriverBridgeErrorCode,
  DriverBridgeErrorEvent,
  DriverBridgeEvent,
  DriverBridgeProtocolVersion,
  DriverHealthState,
  DriverInstallState,
  DriverRepairAction,
} from '../protocol.js';

export type BridgeServiceScaffold = {
  serviceName: string;
  executableName: string;
  defaultPipeName: string;
  logDirectory: string;
  startupSequence: string[];
  protocolVersion: DriverBridgeProtocolVersion;
};

export type BridgeServiceOptions = {
  pipeName?: string;
  runtimeRoot?: string;
  bridgeVersion?: string;
};

type BridgeRuntimeContext = {
  sessionId: string | null;
  bridgeState: BridgeRuntimeState;
  lifecycleState: BridgeLifecycleState;
  driverHealth: DriverHealthState;
  driverVersion?: string;
  bridgeVersion: string;
  queuedFrames: number;
  sourceFramesCaptured: number;
  translatedFramesAccepted: number;
  playbackFramesWritten: number;
  underrunCount: number;
  droppedFrameCount: number;
  monitorPlaybackState: string;
  lastFrameTimestampMs?: number;
  lastErrorCode?: DriverBridgeErrorCode;
};

type BridgePaths = {
  runtimeRoot: string;
  driverStatePath: string;
  frameLogPath: string;
  driverSinkPath: string;
  logFilePath: string;
};

export const bridgeServiceScaffold: BridgeServiceScaffold = {
  serviceName: 'OmniBridgeService',
  executableName: 'omni-bridge-service.exe',
  defaultPipeName: 'omni-bridge-ipc',
  logDirectory: 'AppData/Local/OmniTranslate/logs/bridge-service',
  protocolVersion: '2026-06-01',
  startupSequence: [
    '加载本地配置与日志路径。',
    '等待桌面应用通过 Driver Bridge Contract 发起初始化。',
    '确认驱动状态可用后再接收音频帧写入请求。',
  ],
};

export function describeBridgeBootstrap() {
  return bridgeServiceScaffold.startupSequence;
}

export function resolvePipePath(pipeName = bridgeServiceScaffold.defaultPipeName) {
  return `\\\\.\\pipe\\${pipeName}`;
}

export function resolveBridgePaths(options: BridgeServiceOptions = {}): BridgePaths {
  const runtimeRoot = options.runtimeRoot ?? path.resolve(import.meta.dirname, '..', '..', '..', '..', 'artifacts', 'diagnostics', 'logs');

  return {
    runtimeRoot,
    driverStatePath: path.join(runtimeRoot, 'driver-install-state.json'),
    frameLogPath: path.join(runtimeRoot, 'frames.jsonl'),
    driverSinkPath: path.join(runtimeRoot, 'virtual-driver-render.pcm'),
    logFilePath: path.join(runtimeRoot, 'app.log'),
  };
}

async function ensureRuntimeRoot(paths: BridgePaths) {
  await mkdir(paths.runtimeRoot, { recursive: true });
}

async function appendLog(paths: BridgePaths, message: string) {
  await ensureRuntimeRoot(paths);
  await writeFile(paths.logFilePath, `${formatLogTimestamp()} [NORMAL] [bridge-service] - - ${message}\n`, { encoding: 'utf8', flag: 'a' });
}

function formatLogTimestamp() {
  const now = new Date();
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

async function loadDriverInstallState(paths: BridgePaths): Promise<DriverInstallState | null> {
  try {
    const raw = await readFile(paths.driverStatePath, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(normalized) as DriverInstallState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function createContext(bridgeVersion: string): BridgeRuntimeContext {
  return {
    sessionId: null,
    bridgeState: 'stopped',
    lifecycleState: 'idle',
    driverHealth: 'not-installed',
    bridgeVersion,
    queuedFrames: 0,
    sourceFramesCaptured: 0,
    translatedFramesAccepted: 0,
    playbackFramesWritten: 0,
    underrunCount: 0,
    droppedFrameCount: 0,
    monitorPlaybackState: 'idle',
  };
}

function determineDriverHealth(init: BridgeInitRequest, installState: DriverInstallState | null): DriverHealthState {
  if (!installState) {
    return 'not-installed';
  }

  if (installState.driverHealth === 'damaged') {
    return 'damaged';
  }

  if (installState.driverVersion !== init.expectedDriverVersion || installState.bridgeVersion !== init.expectedBridgeVersion) {
    return 'version-mismatch';
  }

  return 'running';
}

function determineSuggestedAction(code: DriverBridgeErrorCode): DriverRepairAction | undefined {
  switch (code) {
    case 'driver.not-installed':
      return 'reinstall-driver';
    case 'driver.version-mismatch':
      return 'rollback-driver';
    case 'bridge.not-ready':
      return 'restart-bridge';
    default:
      return 'open-diagnostics';
  }
}

function buildStateSnapshot(context: BridgeRuntimeContext, requestId: string): BridgeStateSnapshot {
  return {
    type: 'bridge.state.snapshot',
    requestId,
    protocolVersion: bridgeServiceScaffold.protocolVersion,
    bridgeState: context.bridgeState,
    lifecycleState: context.lifecycleState,
    driverHealth: context.driverHealth,
    driverVersion: context.driverVersion,
    bridgeVersion: context.bridgeVersion,
    queuedFrames: context.queuedFrames,
    sourceFramesCaptured: context.sourceFramesCaptured,
    translatedFramesAccepted: context.translatedFramesAccepted,
    playbackFramesWritten: context.playbackFramesWritten,
    underrunCount: context.underrunCount,
    droppedFrameCount: context.droppedFrameCount,
    monitorPlaybackState: context.monitorPlaybackState,
    lastFrameTimestampMs: context.lastFrameTimestampMs,
    lastErrorCode: context.lastErrorCode,
  };
}

function buildError(
  context: BridgeRuntimeContext,
  code: DriverBridgeErrorCode,
  message: string,
  requestId?: string,
  retriable = true,
): DriverBridgeErrorEvent {
  context.bridgeState = code === 'bridge.not-ready' ? 'starting' : 'degraded';
  context.lifecycleState = 'error';
  context.lastErrorCode = code;

  return {
    type: 'bridge.error',
    requestId,
    code,
    message,
    retriable,
    bridgeState: context.bridgeState,
    driverHealth: context.driverHealth,
    suggestedAction: determineSuggestedAction(code),
  };
}

async function appendFrameLog(paths: BridgePaths, request: BridgeWriteFrameRequest) {
  await ensureRuntimeRoot(paths);
  await writeFile(
    paths.frameLogPath,
    `${JSON.stringify({ acceptedAt: new Date().toISOString(), requestId: request.requestId, sessionId: request.sessionId, frame: request.frame })}\n`,
    { encoding: 'utf8', flag: 'a' },
  );
}

async function writeFrameToVirtualDriver(paths: BridgePaths, request: BridgeWriteFrameRequest) {
  const payload = await readFile(request.frame.payloadRef);
  const bytesPerSample = request.frame.encoding === 'pcm16le' ? 2 : 0;
  const expectedBytes = request.frame.frameCount * request.frame.channelCount * bytesPerSample;

  if (bytesPerSample === 0 || payload.length < expectedBytes) {
    throw new Error(`invalid frame payload: expected at least ${expectedBytes} bytes, got ${payload.length}`);
  }

  await ensureRuntimeRoot(paths);
  await writeFile(paths.driverSinkPath, payload.subarray(0, expectedBytes), { flag: 'a' });
}

async function handleCommand(
  command: DriverBridgeCommand,
  context: BridgeRuntimeContext,
  paths: BridgePaths,
  closeServer: () => Promise<void>,
): Promise<DriverBridgeEvent> {
  switch (command.type) {
    case 'bridge.init': {
      context.lifecycleState = 'initializing';
      context.bridgeState = 'starting';
      context.sessionId = command.sessionId;
      const installState = await loadDriverInstallState(paths);
      context.driverHealth = determineDriverHealth(command, installState);
      context.driverVersion = installState?.driverVersion;
      context.bridgeVersion = installState?.bridgeVersion ?? context.bridgeVersion;

      if (context.driverHealth === 'running') {
        context.lifecycleState = 'ready';
        context.bridgeState = 'running';
      } else {
        context.lifecycleState = 'error';
        context.bridgeState = 'degraded';
        context.lastErrorCode = context.driverHealth === 'not-installed' ? 'driver.not-installed' : 'driver.version-mismatch';
      }

      return {
        type: 'bridge.init.ack',
        requestId: command.requestId,
        protocolVersion: bridgeServiceScaffold.protocolVersion,
        bridgeState: context.bridgeState,
        driverHealth: context.driverHealth,
        activeDriverVersion: context.driverVersion,
      } satisfies BridgeInitResponse;
    }
    case 'bridge.state.query':
      return buildStateSnapshot(context, command.requestId);
    case 'bridge.frame.write': {
      if (context.bridgeState !== 'running' || context.lifecycleState === 'error') {
        return buildError(context, 'bridge.not-ready', 'Bridge Service 尚未进入可写状态。', command.requestId);
      }

      if (context.sessionId && context.sessionId !== command.sessionId) {
        return buildError(context, 'bridge.permission-denied', '会话标识不匹配，拒绝写入音频帧。', command.requestId, false);
      }

      context.lifecycleState = 'writing';
      context.queuedFrames += 1;
      context.lastFrameTimestampMs = command.frame.timestampMs;

      try {
        await writeFrameToVirtualDriver(paths, command);
        await appendFrameLog(paths, command);
      } catch {
        return buildError(context, 'driver.write-failed', '写入驱动桥接日志失败。', command.requestId);
      } finally {
        context.queuedFrames = Math.max(0, context.queuedFrames - 1);
        context.lifecycleState = 'ready';
      }

      return {
        type: 'bridge.frame.ack',
        requestId: command.requestId,
        frameId: command.frame.frameId,
        acceptedAt: new Date().toISOString(),
        queueDepth: context.queuedFrames,
      } satisfies BridgeWriteFrameAck;
    }
    case 'bridge.shutdown': {
      context.sessionId = null;
      context.lifecycleState = 'stopped';
      context.bridgeState = 'stopped';
      await appendLog(paths, `shutdown reason=${command.reason}`);
      queueMicrotask(() => {
        void closeServer();
      });
      return buildStateSnapshot(context, command.requestId);
    }
  }
}

function parseCommand(raw: string): DriverBridgeCommand | null {
  try {
    return JSON.parse(raw) as DriverBridgeCommand;
  } catch {
    return null;
  }
}

async function writeEvent(socket: Socket, event: DriverBridgeEvent): Promise<void> {
  const data = `${JSON.stringify(event)}\n`;
  if (!socket.write(data)) {
    await new Promise<void>((resolve) => socket.once('drain', resolve));
  }
}

async function removePipe(pipePath: string) {
  if (process.platform === 'win32') {
    return;
  }

  await rm(pipePath, { force: true });
}

export async function startBridgeService(options: BridgeServiceOptions = {}) {
  const bridgeVersion = options.bridgeVersion ?? '0.1.0';
  const context = createContext(bridgeVersion);
  const paths = resolveBridgePaths(options);
  const pipePath = resolvePipePath(options.pipeName);
  let server: Server | null = null;

  const closeServer = async () => {
    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    server = null;
    await removePipe(pipePath);
  };

  await ensureRuntimeRoot(paths);
  await appendLog(paths, `bridge-service starting pipe=${pipePath}`);

  server = createServer((socket) => {
    let buffer = '';

    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        const command = parseCommand(trimmed);
        if (!command) {
          await writeEvent(socket, buildError(context, 'bridge.timeout', '请求不是合法 JSON 命令。', undefined, false));
          continue;
        }

        try {
          const event = await handleCommand(command, context, paths, closeServer);
          await writeEvent(socket, event);
        } catch (error) {
          await writeEvent(
            socket,
            buildError(context, 'bridge.timeout', error instanceof Error ? error.message : 'Bridge Service 处理请求失败。', command.requestId),
          );
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(pipePath, () => {
      server?.off('error', reject);
      resolve();
    });
  });

  return {
    pipePath,
    runtimeRoot: paths.runtimeRoot,
    close: closeServer,
    snapshot: () => buildStateSnapshot(context, 'bridge-state-local'),
  };
}
