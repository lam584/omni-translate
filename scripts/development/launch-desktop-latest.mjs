import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, '..', '..');
const desktopRoot = join(workspaceRoot, 'apps', 'desktop');
const targetDirectory = join(desktopRoot, 'src-tauri', 'target-shortcut');
const executablePath = join(targetDirectory, 'release', 'omni-desktop-shell.exe');
const canonicalExecutablePath = join(desktopRoot, 'src-tauri', 'target', 'release', 'omni-desktop-shell.exe');

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

// The desktop shell is single-instance. Stop every stale copy before building,
// otherwise a newly built executable hands control back to an older elevated
// process and exits immediately. The shortcut runs this launcher as admin.
const stopExitCode = run('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  'Get-Process -Name omni-desktop-shell -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Milliseconds 500; if (Get-Process -Name omni-desktop-shell -ErrorAction SilentlyContinue) { exit 1 }',
]);
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

console.log('[Omni Translate] Build complete. Updating the canonical release executable...');
mkdirSync(dirname(canonicalExecutablePath), { recursive: true });
let copyError;
for (let attempt = 1; attempt <= 20; attempt += 1) {
  try {
    copyFileSync(executablePath, canonicalExecutablePath);
    copyError = undefined;
    break;
  } catch (error) {
    copyError = error;
    if (attempt < 20) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
}
if (copyError) throw copyError;

const builtHash = sha256(executablePath);
const canonicalHash = sha256(canonicalExecutablePath);
if (builtHash !== canonicalHash) {
  console.error('[Omni Translate] Refusing to launch: copied executable hash does not match this build.');
  process.exit(4);
}

console.log(`[Omni Translate] Verified latest build (${builtHash.slice(0, 12)}). Starting the application as the desktop user...`);
// The launcher is elevated only so it can retire stale elevated builds. Route
// the final launch through the existing Explorer shell so the app itself runs
// at the normal desktop integrity level.
const child = spawn('explorer.exe', [canonicalExecutablePath], {
  cwd: workspaceRoot,
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
});
child.unref();
