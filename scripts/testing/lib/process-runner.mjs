import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function fileLength(filePath) {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

export function readUtf8Delta(filePath, offset = 0) {
  try {
    const bytes = fs.readFileSync(filePath);
    return bytes.subarray(bytes.length < offset ? 0 : offset).toString('utf8');
  } catch { return ''; }
}

export function resolveCommand(command, { env = process.env } = {}) {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return fs.existsSync(command) ? path.resolve(command) : null;
  }
  const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(resolver, [command], { encoding: 'utf8', env, windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean) ?? null : null;
}

export function isTcpPortOpen(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function waitForTcpPort({ host, port, timeoutMs, pollIntervalMs = 250, child = null }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTcpPortOpen(host, port)) return true;
    if (child?.exitCode !== null) return false;
    await delay(pollIntervalMs);
  }
  return false;
}

export function spawnLogged(command, args, { cwd, env, stdoutPath, stderrPath } = {}) {
  fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
  const stdout = fs.openSync(stdoutPath, 'a');
  const stderr = fs.openSync(stderrPath, 'a');
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', stdout, stderr], windowsHide: true });
  child.once('close', () => { fs.closeSync(stdout); fs.closeSync(stderr); });
  return child;
}

export async function stopOwnedProcess(child, { graceMs = 1_000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill();
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(graceMs).then(() => false),
  ]);
  if (exited) return true;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(graceMs)]);
  return child.exitCode !== null || child.signalCode !== null;
}

export async function requestJson(url, { method = 'GET', body, timeoutMs = 60_000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}
