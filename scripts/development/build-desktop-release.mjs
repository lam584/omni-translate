import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDirectory, '..', '..');
const desktopRoot = path.join(workspaceRoot, 'apps', 'desktop');

const findExecutable = (root, fileName) => {
  if (!existsSync(root)) return null;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return candidate;
      }
    }
  }
  return null;
};

const watchModeEnvironmentKeys = [
  'OMNI_WATCH_MODE_AUTOSTART',
  'OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS',
  'OMNI_WATCH_MODE_EXPIRES_AT_MS',
  'OMNI_WATCH_MODE_EXIT_AFTER_REPORT',
  'OMNI_WATCH_MODE_REPORT_PATH',
  'OMNI_WATCH_MODE_REALTIME_PROTOCOL',
  'OMNI_WATCH_MODE_RUN_MARKER',
  'VITE_OMNI_WATCH_MODE_AUTOSTART',
  'VITE_OMNI_WATCH_MODE_EXPIRES_AT_MS',
  'VITE_OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID',
  'VITE_OMNI_WATCH_MODE_MODEL_ID',
  'VITE_OMNI_WATCH_MODE_OUTPUT_DEVICE_ID',
  'VITE_OMNI_WATCH_MODE_OUTPUT_LEVEL',
  'VITE_OMNI_WATCH_MODE_RUN_MARKER',
  'VITE_OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID',
  'VITE_OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE',
];

const releaseEnvironment = { ...process.env };
for (const key of watchModeEnvironmentKeys) {
  releaseEnvironment[key] = key.endsWith('_AUTOSTART') ? '0' : '';
}
const gitHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  windowsHide: true,
});
const buildCommit = String(gitHead.stdout ?? '').trim();
if (gitHead.status !== 0 || !/^[a-f0-9]{40}$/i.test(buildCommit)) {
  console.error(`Failed to resolve the Desktop build commit: ${gitHead.stderr ?? ''}`);
  process.exit(1);
}
releaseEnvironment.OMNI_BUILD_COMMIT = buildCommit;
if (!releaseEnvironment.CMAKE) {
  const acquiredCmake = findExecutable(
    path.join(workspaceRoot, 'target', 'aec3-msvc-vcpkg-downloads', 'tools'),
    'cmake.exe',
  );
  if (acquiredCmake) releaseEnvironment.CMAKE = acquiredCmake;
}
releaseEnvironment.VCPKG_ROOT ||= path.join(workspaceRoot, 'target', 'aec3-msvc-vcpkg');
releaseEnvironment.VCPKG_INSTALLED_ROOT ||= path.join(
  workspaceRoot,
  'target',
  'aec3-msvc-vcpkg-installed',
);
// Clean scheduled-task shells do not have Ninja or cl.exe on PATH. Match the
// AEC3 release gate's explicit MSVC generator so the tested dependency and
// the shipped Desktop executable cannot diverge by launch environment.
releaseEnvironment.CMAKE_GENERATOR ||= 'Visual Studio 17 2022';
releaseEnvironment.CMAKE_GENERATOR_PLATFORM ||= 'x64';

const isWindows = process.platform === 'win32';
const executable = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npx';
const arguments_ = isWindows
  ? ['/d', '/s', '/c', 'npx tauri build --no-bundle --features webrtc-aec3']
  : ['tauri', 'build', '--no-bundle', '--features', 'webrtc-aec3'];
const child = spawn(executable, arguments_, {
  cwd: desktopRoot,
  env: releaseEnvironment,
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(`Failed to start the Tauri release build: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`Tauri release build terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
