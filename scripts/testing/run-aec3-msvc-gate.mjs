import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const BASELINE = 'ea1a7396b05637a53bf23c078647ecc0edee4b80';
const TRIPLET = 'x64-windows-static-md';
const VCPKG_TOOL_VERSION = '2026-07-27-98d7cb0cf1f4686a3e43aa5672b6230c1d56bce8';
const VCPKG_TOOL_SHA256 = '13b8175e99a884c5ad34249218754b45541a1a63f216e92603aee57a285ac741';
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

function runWithRetries(command, args, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      run(command, args, options);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      // Tool archives are fetched from GitHub on clean Windows VMs. The
      // downloader can lose a single long-lived TLS stream; a fresh vcpkg
      // invocation verifies the archive hash before it is ever used.
      console.warn(`attempt ${attempt}/${attempts} failed; retrying: ${error.message}`);
    }
  }
  throw lastError;
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

function successful(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
  });
  return !result.error && result.status === 0;
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

function loadMsvcEnvironment() {
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const vswhereCandidates = [
    join(programFilesX86, 'Microsoft', 'Visual Studio', 'Installer', 'vswhere.exe'),
    // Some development VMs install the bootstrapper under this legacy
    // single-directory layout. GitHub-hosted runners use the standard path.
    join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
  ];
  const vswhere = vswhereCandidates.find((candidate) => existsSync(candidate));
  if (!vswhere) {
    throw new Error(`vswhere.exe was not found in: ${vswhereCandidates.join(', ')}`);
  }
  const installationPath = output(vswhere, [
    '-latest',
    '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ]);
  if (!installationPath) {
    throw new Error('vswhere found no Visual Studio installation with the MSVC x64 toolchain');
  }
  const developerShell = join(installationPath, 'Common7', 'Tools', 'VsDevCmd.bat');
  if (!existsSync(developerShell)) {
    throw new Error(`Visual Studio developer shell was not found at ${developerShell}`);
  }
  const result = spawnSync(
    `call "${developerShell}" -arch=x64 -host_arch=x64 >nul && set`,
    [],
    {
      cwd: workspace,
      env: process.env,
      encoding: 'utf8',
      shell: process.env.ComSpec ?? 'cmd.exe',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `failed to initialize the MSVC developer environment (exit ${result.status})`);
  }
  const environment = { ...process.env };
  for (const line of result.stdout.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
}

function assertPinnedVcpkgTool(executable) {
  if (!existsSync(executable)) return false;
  const sha256 = crypto.createHash('sha256').update(readFileSync(executable)).digest('hex');
  if (sha256 !== VCPKG_TOOL_SHA256) return false;
  const version = output(executable, ['version', '--disable-metrics']);
  if (!version.includes(`version ${VCPKG_TOOL_VERSION}`)) {
    throw new Error(`vcpkg tool version mismatch: expected=${VCPKG_TOOL_VERSION} actual=${version}`);
  }
  return true;
}

mkdirSync(resolve(workspace, 'target'), { recursive: true });
// vcpkg's history is large and a full clone can spend many minutes unpacking
// commits that the pinned AEC3 gate never reads. Fetch just the approved
// baseline. A failed clone leaves a .git directory behind, so require a real
// HEAD before reusing the directory.
if (!successful('git', ['-C', vcpkgRoot, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) {
  rmSync(vcpkgRoot, { recursive: true, force: true });
  mkdirSync(vcpkgRoot, { recursive: true });
  run('git', ['-C', vcpkgRoot, 'init']);
  run('git', ['-C', vcpkgRoot, 'remote', 'add', 'origin', 'https://github.com/microsoft/vcpkg.git']);
}
const localBaseline = successful('git', ['-C', vcpkgRoot, 'cat-file', '-e', `${BASELINE}^{commit}`]);
if (!localBaseline) {
  run('git', ['-C', vcpkgRoot, 'fetch', '--depth', '1', 'origin', BASELINE]);
}
run('git', ['-C', vcpkgRoot, 'checkout', '--detach', BASELINE]);
const actualBaseline = output('git', ['-C', vcpkgRoot, 'rev-parse', 'HEAD']);
if (actualBaseline !== BASELINE) {
  throw new Error(`vcpkg baseline mismatch: expected=${BASELINE} actual=${actualBaseline}`);
}

const vcpkgExecutable = join(vcpkgRoot, 'vcpkg.exe');
if (!assertPinnedVcpkgTool(vcpkgExecutable)) {
  const bootstrap = join(vcpkgRoot, 'bootstrap-vcpkg.bat');
  run(process.env.ComSpec ?? 'cmd.exe', [
    '/d',
    '/c',
    'call',
    bootstrap,
    '-disableMetrics',
  ]);
  if (!assertPinnedVcpkgTool(vcpkgExecutable)) {
    throw new Error(`bootstrapped vcpkg tool does not match pinned SHA-256 ${VCPKG_TOOL_SHA256}`);
  }
}
const vcpkgInstallEnvironment = { ...process.env, VCPKG_DOWNLOADS: downloadsRoot };
runWithRetries(vcpkgExecutable, [
  'install',
  `webrtc:${TRIPLET}`,
  `--x-install-root=${installedRoot}`,
], { env: vcpkgInstallEnvironment });

function requireVcpkgTool(toolName, fileName) {
  const toolsRoot = join(downloadsRoot, 'tools');
  let executable = findExecutable(toolsRoot, fileName);
  if (!executable) {
    // A restored installed-tree cache can make `vcpkg install` a no-op while
    // the downloads/tools cache is absent. Fetch build tools explicitly so a
    // clean VM and a partially restored CI cache have identical behavior.
    run(vcpkgExecutable, ['fetch', toolName, '--x-stderr-status'], {
      env: { ...process.env, VCPKG_DOWNLOADS: downloadsRoot },
    });
    executable = findExecutable(toolsRoot, fileName);
  }
  if (!executable) {
    throw new Error(`vcpkg did not acquire ${fileName} under ${downloadsRoot}`);
  }
  return executable;
}

const cmake = requireVcpkgTool('cmake', 'cmake.exe');
const ninja = requireVcpkgTool('ninja', 'ninja.exe');
const msvcEnvironment = loadMsvcEnvironment();
const buildEnvironment = {
  ...msvcEnvironment,
  // The linked Desktop test graph is large enough that full PDBs exhaust
  // small clean Windows validation VMs. Debug symbols are not evidence for
  // this execution gate; disable them without changing test/runtime behavior.
  CARGO_PROFILE_DEV_DEBUG: '0',
  CARGO_PROFILE_TEST_DEBUG: '0',
  VCPKG_ROOT: vcpkgRoot,
  VCPKG_INSTALLED_ROOT: installedRoot,
  CMAKE: cmake,
  // windows-latest may move to a newer Visual Studio major version. The
  // discovered developer environment plus Ninja avoids coupling this gate to
  // a versioned CMake Visual Studio generator name.
  CMAKE_GENERATOR: 'Ninja',
  CMAKE_MAKE_PROGRAM: ninja,
  // build.rs watches this nonce. A repeated local/CI gate therefore reruns
  // the native deterministic CTest instead of trusting Cargo's cached build
  // script output; failure prevents the linked feature from compiling.
  OMNI_AEC3_LINKED_GATE_RUN: `${Date.now()}-${process.pid}`,
};
delete buildEnvironment.CMAKE_GENERATOR_PLATFORM;
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
