import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isMain, isWindows, repoRoot } from '../lib/testing-common.mjs';

const imageName = 'omni-desktop-shell';

// Root workspace target directory first; legacy per-crate target directory
// second. Only processes running from these build outputs may be stopped —
// a user-installed copy of the app must survive a dev rebuild.
const releaseExecutables = [
  path.join(repoRoot, 'target', 'release', `${imageName}.exe`),
  path.join(repoRoot, 'apps', 'desktop', 'src-tauri', 'target', 'release', `${imageName}.exe`),
];

const runCapture = (command, args) => spawnSync(command, args, { encoding: 'utf8', windowsHide: true });

const normalizePath = (value) => path.normalize(value ?? '').toLowerCase();

// tasklist cannot report executable paths, so the release-path filter needs a
// CIM query; powershell.exe is the stable interface for that on Windows. The
// query is read-only — the kill itself goes through process.kill below.
const findWindowsReleasePids = () => {
  const query =
    `Get-CimInstance Win32_Process -Filter "Name='${imageName}.exe'" | ` +
    "ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.ExecutablePath }";
  const encoded = Buffer.from(query, 'utf16le').toString('base64');
  const result = runCapture('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded]);
  if (result.error || result.status !== 0 || !result.stdout) {
    return [];
  }
  const allowed = new Set(releaseExecutables.map(normalizePath));
  const pids = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const separatorIndex = line.indexOf('|');
    if (separatorIndex === -1) {
      continue;
    }
    const pid = Number(line.slice(0, separatorIndex).trim());
    const executablePath = line.slice(separatorIndex + 1).trim();
    if (Number.isInteger(pid) && pid > 0 && allowed.has(normalizePath(executablePath))) {
      pids.push(pid);
    }
  }
  return pids;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findPosixReleasePids = () => {
  const pids = new Set();
  for (const executable of releaseExecutables) {
    const commandPath = executable.replace(/\.exe$/i, '').split(path.sep).join('/');
    const result = runCapture('pgrep', ['-f', `^${escapeRegExp(commandPath)}(\\s|$)`]);
    if (result.error || !result.stdout) {
      continue;
    }
    for (const token of result.stdout.split(/\s+/)) {
      const pid = Number(token);
      if (token && Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
  }
  return [...pids];
};

export const findStaleReleasePids = () => (isWindows ? findWindowsReleasePids() : findPosixReleasePids());

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const stopDesktopRelease = async () => {
  const pids = findStaleReleasePids();
  for (const pid of pids) {
    console.error(`Stopping stale desktop release process ${pid}...`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }
  }
  const deadline = Date.now() + 5000;
  for (const pid of pids) {
    while (isAlive(pid)) {
      if (Date.now() > deadline) {
        throw new Error(`Process ${pid} (${imageName}) is still running after Stop.`);
      }
      await delay(100);
    }
  }
};

if (isMain(import.meta.url)) {
  try {
    await stopDesktopRelease();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
