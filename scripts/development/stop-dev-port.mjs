import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isMain, isWindows, parseCliArgs } from '../lib/testing-common.mjs';

const DEFAULT_PORT = 4173;

const runCapture = (command, args) => spawnSync(command, args, { encoding: 'utf8', windowsHide: true });

export const findListenerPids = (port) => {
  const pids = new Set();
  if (isWindows) {
    const result = runCapture('netstat', ['-ano']);
    if (result.error || result.status !== 0 || !result.stdout) {
      return [];
    }
    for (const line of result.stdout.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      // netstat localizes the state column (LISTENING/ABHÖREN/...), so filter
      // on the local-address port and a nonzero PID instead: dev-server ports
      // sit outside the ephemeral range, so any owning process is the server.
      if (columns.length < 5 || columns[0] !== 'TCP') {
        continue;
      }
      const localAddress = columns[1];
      if (localAddress.slice(localAddress.lastIndexOf(':') + 1) !== String(port)) {
        continue;
      }
      const pid = Number(columns[4]);
      if (Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
    return [...pids];
  }
  const result = runCapture('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error(`[dev:port] lsof is unavailable; assuming port ${port} is free.`);
      return [];
    }
    throw result.error;
  }
  for (const token of (result.stdout ?? '').split(/\s+/)) {
    const pid = Number(token);
    if (token && Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
};

export const processName = (pid) => {
  if (isWindows) {
    const result = runCapture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const match = /^"([^"]+)"/.exec((result.stdout ?? '').trim());
    return match ? match[1].replace(/\.exe$/i, '') : 'unknown';
  }
  const result = runCapture('ps', ['-p', String(pid), '-o', 'comm=']);
  return (result.stdout ?? '').trim() || 'unknown';
};

export const stopDevPort = async (port) => {
  const listeners = findListenerPids(port);
  if (listeners.length === 0) {
    console.error(`[dev:port] Port ${port} is available.`);
    return;
  }
  for (const pid of listeners) {
    console.error(`[dev:port] Stopping PID ${pid} (${processName(pid)}) listening on port ${port}...`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }
  }
  await delay(300);
  if (findListenerPids(port).length > 0) {
    throw new Error(`Port ${port} is still occupied after stopping its listener.`);
  }
  console.error(`[dev:port] Port ${port} has been released.`);
};

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), { defaults: { port: DEFAULT_PORT } });
    const port = Number(args.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid --port value: ${args.port}`);
    }
    await stopDevPort(port);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
