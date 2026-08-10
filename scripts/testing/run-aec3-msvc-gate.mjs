import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const BASELINE = 'ea1a7396b05637a53bf23c078647ecc0edee4b80';
const TRIPLET = 'x64-windows-static-md';
const workspace = resolve(import.meta.dirname, '..', '..');
const vcpkgRoot = resolve(
  process.env.OMNI_AEC3_VCPKG_ROOT ?? join(workspace, 'target', 'aec3-msvc-vcpkg'),
);
const installedRoot = resolve(
  process.env.OMNI_AEC3_VCPKG_INSTALLED_ROOT
    ?? join(workspace, 'target', 'aec3-msvc-vcpkg-installed'),
);
const downloadsRoot = resolve(
  process.env.OMNI_AEC3_VCPKG_DOWNLOADS
    ?? join(workspace, 'target', 'aec3-msvc-vcpkg-downloads'),
);

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('AEC3 MSVC gate requires Windows x64');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} failed with exit code ${result.status}`);
  }
  return result.stdout.trim();
}

function findExecutable(root, fileName) {
  if (!existsSync(root)) return null;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return candidate;
      }
    }
  }
  return null;
}

mkdirSync(resolve(workspace, 'target'), { recursive: true });
if (!existsSync(join(vcpkgRoot, '.git'))) {
  run('git', ['clone', 'https://github.com/microsoft/vcpkg.git', vcpkgRoot]);
}
run('git', ['-C', vcpkgRoot, 'checkout', '--detach', BASELINE]);
const actualBaseline = output('git', ['-C', vcpkgRoot, 'rev-parse', 'HEAD']);
if (actualBaseline !== BASELINE) {
  throw new Error(`vcpkg baseline mismatch: expected=${BASELINE} actual=${actualBaseline}`);
}

const bootstrap = join(vcpkgRoot, 'bootstrap-vcpkg.bat');
run(process.env.ComSpec ?? 'cmd.exe', [
  '/d',
  '/c',
  'call',
  bootstrap,
  '-disableMetrics',
]);
run(join(vcpkgRoot, 'vcpkg.exe'), [
  'install',
  `webrtc:${TRIPLET}`,
  `--x-install-root=${installedRoot}`,
], { env: { ...process.env, VCPKG_DOWNLOADS: downloadsRoot } });

const cmake = findExecutable(join(downloadsRoot, 'tools'), 'cmake.exe');
if (!cmake) {
  throw new Error(`vcpkg completed without an acquired cmake.exe under ${downloadsRoot}`);
}

const buildEnvironment = {
  ...process.env,
  VCPKG_ROOT: vcpkgRoot,
  VCPKG_INSTALLED_ROOT: installedRoot,
  CMAKE: cmake,
  // build.rs watches this nonce. A repeated local/CI gate therefore reruns
  // the native deterministic CTest instead of trusting Cargo's cached build
  // script output; failure prevents the linked feature from compiling.
  OMNI_AEC3_LINKED_GATE_RUN: `${Date.now()}-${process.pid}`,
};
run('cargo', [
  'test',
  '-p',
  'omni-webrtc-aec3',
  '--features',
  'linked',
], { env: buildEnvironment });
run('cargo', [
  'test',
  '--manifest-path',
  'apps/desktop/src-tauri/Cargo.toml',
  '--features',
  'webrtc-aec3',
], { env: buildEnvironment });

console.log(`AEC3 MSVC gate passed (baseline=${BASELINE}, triplet=${TRIPLET}).`);
