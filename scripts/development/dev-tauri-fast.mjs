import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isMain, isWindows, repoRoot, runCommand } from '../lib/testing-common.mjs';

const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const devUrl = 'http://127.0.0.1:4173';
const configOverride = '{"build":{"beforeDevCommand":""}}';

const log = (message) => console.error(`[dev:tauri:fast] ${message}`);

// On Windows the command must go through `shell: true` as a single string:
// passing it as an argv element to cmd.exe would let Node re-quote it and
// mangle embedded quotes (e.g. around a --config path with spaces).
const spawnShell = (command, { cwd, stdio }) => isWindows
  ? spawn(command, { shell: true, cwd, stdio, windowsHide: true })
  : spawn('sh', ['-c', command], { cwd, stdio, detached: true });

// npm wraps Vite in its own launcher process, so terminating only the direct
// child would leave the dev server running; the whole tree has to go.
const stopProcessTree = (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
};

const waitForExit = (child) => new Promise((resolve) => {
  child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  child.once('error', () => resolve(1));
});

export const runDevTauriFast = async () => {
  log('Starting Tauri dev without rebuilding the release Native Bridge...');
  log('Starting and warming Vite before opening the desktop WebView...');

  const predevExit = runCommand('npm run predev', { cwd: desktopRoot });
  if (predevExit !== 0) {
    return predevExit;
  }

  const vite = spawnShell('npm run dev', { cwd: desktopRoot, stdio: 'ignore' });
  let viteExit = null;
  vite.once('exit', (code, signal) => {
    viteExit = signal ? 1 : (code ?? 1);
  });
  vite.once('error', () => {
    viteExit = 1;
  });

  const onSignal = () => {
    stopProcessTree(vite);
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (viteExit !== null) {
        throw new Error(`Vite exited before the development server became ready (exit code ${viteExit}).`);
      }
      try {
        const response = await fetch(`${devUrl}/src/main.tsx`, { signal: AbortSignal.timeout(2000) });
        await response.arrayBuffer().catch(() => {});
        if (response.status === 200) {
          ready = true;
          break;
        }
        await delay(250);
      } catch {
        await delay(250);
      }
    }
    if (!ready) {
      throw new Error(`Timed out waiting for Vite at ${devUrl}.`);
    }

    log('Vite is warm; starting Tauri with the Cargo incremental cache...');
    // The override JSON travels via a file because cmd.exe mangles quoted
    // inline JSON arguments; `tauri dev --config` accepts either form.
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-tauri-dev-config-'));
    const overridePath = path.join(overrideDir, 'tauri-dev-override.json');
    fs.writeFileSync(overridePath, configOverride);
    try {
      const tauri = isWindows
        ? spawnShell(`npx tauri dev --config "${overridePath}"`, { cwd: desktopRoot, stdio: 'inherit' })
        : spawn('npx', ['tauri', 'dev', '--config', overridePath], { cwd: desktopRoot, stdio: 'inherit' });
      return await waitForExit(tauri);
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  } finally {
    stopProcessTree(vite);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
};

if (isMain(import.meta.url)) {
  try {
    process.exit(await runDevTauriFast());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
