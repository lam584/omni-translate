import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, '..', '..');
const desktopRoot = join(workspaceRoot, 'apps', 'desktop');
const targetDirectory = join(workspaceRoot, 'target');
const executablePath = join(targetDirectory, 'release', 'omni-desktop-shell.exe');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    stdio: 'inherit',
    windowsHide: false,
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function desktopProcessStillRunning() {
  if (process.platform === 'win32') {
    const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq omni-desktop-shell.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return (result.stdout ?? '').toLowerCase().includes('omni-desktop-shell.exe');
  }
  const result = spawnSync('pgrep', ['-x', 'omni-desktop-shell'], { stdio: 'ignore' });
  return result.status === 0;
}

// The desktop shell is single-instance. Stop every stale copy before building,
// otherwise a newly built executable hands control back to an older elevated
// process and exits immediately. The shortcut runs this launcher as admin.
function stopStaleDesktopProcesses() {
  let exitCode;
  if (process.platform === 'win32') {
    // taskkill exits 128 when no process matches the image name.
    exitCode = run('taskkill', ['/F', '/IM', 'omni-desktop-shell.exe'], { stdio: 'ignore' });
    if (exitCode === 128) return 0;
  } else {
    try {
      // pkill exits 1 when no process matches.
      exitCode = run('pkill', ['-x', 'omni-desktop-shell'], { stdio: 'ignore' });
      if (exitCode === 1) return 0;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }
  if (exitCode !== 0) return exitCode;
  // A forced kill can leave an elevated process lingering briefly; confirm the
  // image is really gone before handing the build a stale single-instance peer.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!desktopProcessStillRunning()) return 0;
    sleepMs(250);
  }
  return 1;
}

const stopExitCode = stopStaleDesktopProcesses();
if (stopExitCode !== 0) {
  console.error('[Omni Translate] Unable to stop an older desktop process. Run this shortcut as administrator.');
  process.exit(stopExitCode);
}

console.log('[Omni Translate] Building the latest desktop release...');
// Delete the isolated old artifact so it can never be mistaken for this build.
if (existsSync(executablePath)) unlinkSync(executablePath);
const buildStartedAt = Date.now();
const buildExitCode = run(
  process.env.ComSpec || 'cmd.exe',
  ['/d', '/s', '/c', 'npx tauri build --no-bundle'],
  {
    cwd: desktopRoot,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: targetDirectory,
      OMNI_WATCH_MODE_AUTOSTART: '0',
      VITE_OMNI_WATCH_MODE_AUTOSTART: '0',
    },
  },
);

if (buildExitCode !== 0) {
  console.error(`[Omni Translate] Build failed with exit code ${buildExitCode}.`);
  process.exit(buildExitCode);
}

if (!existsSync(executablePath)) {
  console.error('[Omni Translate] Build reported success but did not create a new executable.');
  process.exit(2);
}
const builtExecutable = statSync(executablePath);
if (builtExecutable.mtimeMs + 1_000 < buildStartedAt) {
  console.error('[Omni Translate] Refusing to launch: the build artifact predates this build attempt.');
  process.exit(3);
}

const builtHash = sha256(executablePath);
console.log(`[Omni Translate] Verified latest build (${builtHash.slice(0, 12)}). Starting the application as the desktop user...`);
// The launcher is elevated only so it can retire stale elevated builds. Route
// the final launch through the existing Explorer shell so the app itself runs
// at the normal desktop integrity level.
const child = spawn('explorer.exe', [executablePath], {
  cwd: workspaceRoot,
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
});
child.unref();
