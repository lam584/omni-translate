import { spawn } from 'node:child_process';

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

const isWindows = process.platform === 'win32';
const executable = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npx';
const arguments_ = isWindows
  ? ['/d', '/s', '/c', 'npx tauri build --no-bundle']
  : ['tauri', 'build', '--no-bundle'];
const child = spawn(executable, arguments_, {
  cwd: process.cwd(),
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
