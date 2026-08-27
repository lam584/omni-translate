import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IPC_TESTS = [
  { name: 'debug_ipc_ping', args: ['tauri', 'invoke', 'debug_ipc_ping'], accepts: /pong/i },
  { name: 'bootstrap_storage', args: ['tauri', 'invoke', 'bootstrap_storage'], accepts: /status/i },
  { name: 'debug_cred_direct', args: ['tauri', 'invoke', 'debug_cred_direct', '--args',
    JSON.stringify({ reference: 'test/ipc-direct', secret: 'ipc-test-secret' })], accepts: /written/i },
];

export function evaluateIpcInvocation(test, result) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { name: test.name, passed: result.status === 0 && test.accepts.test(output),
    exitCode: result.status, output: output.trim() };
}

export function runIpcDiagnostics({ exePath, invoke = spawnSync } = {}) {
  return IPC_TESTS.map((test) => evaluateIpcInvocation(test,
    invoke(exePath, test.args, { encoding: 'utf8', windowsHide: true })));
}

function parseArgs(argv) {
  const index = argv.indexOf('--exe-path');
  return { exePath: index >= 0 ? argv[index + 1] : '' };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const exePath = path.resolve(args.exePath || path.join(repoRoot, 'artifacts/installer/0.1.0/desktop/omni-desktop-shell.exe'));
  if (!fs.existsSync(exePath)) {
    console.error(`desktop shell executable not found: ${exePath}`);
    process.exit(1);
  }
  console.log('=== IPC Diagnostic Test ===');
  // Start only an owned process. The diagnostic never searches for or kills by process name.
  const ownedProcess = spawn(exePath, [], { cwd: path.dirname(exePath), detached: false, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const results = runIpcDiagnostics({ exePath });
  for (const result of results) {
    console.log(`[${result.passed ? 'PASS' : 'FAIL'}] ${result.name}: exit=${result.exitCode}\n${result.output}`);
  }
  if (ownedProcess.exitCode === null) ownedProcess.unref();
  process.exit(results.every((result) => result.passed) ? 0 : 1);
}
