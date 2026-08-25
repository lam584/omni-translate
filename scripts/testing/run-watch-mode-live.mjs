import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadWatchModeRunRequest } from './watch-mode-run-request.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

export function buildPowerShellArguments(requestPath) {
  return [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.resolve('scripts/testing/run-watch-mode-live.ps1'),
    '-RequestPath', path.resolve(requestPath),
  ];
}

export async function main() {
  const requestPath = option('--request');
  if (!requestPath) throw new Error('Usage: node scripts/testing/run-watch-mode-live.mjs --request <run-request.json>');
  loadWatchModeRunRequest(requestPath);
  const child = spawn('powershell.exe', buildPowerShellArguments(requestPath), {
    cwd: process.cwd(),
    env: { ...process.env, npm_lifecycle_event: '' },
    stdio: 'inherit',
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
