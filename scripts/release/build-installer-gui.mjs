import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDirectory, '..', '..');
const desktopRoot = path.join(workspaceRoot, 'apps', 'desktop');

const findExecutable = (root, fileName) => {
  if (!fs.existsSync(root)) return null;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return candidate;
      }
    }
  }
  return null;
};

const findOwnedVcpkgTool = (toolsRoot, toolName, fileName) => {
  if (!fs.existsSync(toolsRoot)) return null;
  const ownedRoots = fs.readdirSync(toolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(toolName.toLowerCase() + '-'))
    .map((entry) => path.join(toolsRoot, entry.name));
  for (const ownedRoot of ownedRoots) {
    const executable = findExecutable(ownedRoot, fileName);
    if (executable) return executable;
  }
  return null;
};

console.log('=== Step 1: Preparing build environment ===');
const buildEnvironment = { ...process.env };

const gitHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  windowsHide: true,
});
const buildCommit = String(gitHead.stdout ?? '').trim();
if (gitHead.status !== 0 || !/^[a-f0-9]{40}$/i.test(buildCommit)) {
  console.error('Failed to resolve Git build commit: ' + (gitHead.stderr ?? ''));
  process.exit(1);
}
buildEnvironment.OMNI_BUILD_COMMIT = buildCommit;

if (!buildEnvironment.CMAKE) {
  const acquiredCmake = findOwnedVcpkgTool(
    path.join(workspaceRoot, 'target', 'aec3-msvc-vcpkg-downloads', 'tools'),
    'cmake',
    'cmake.exe',
  );
  if (acquiredCmake) buildEnvironment.CMAKE = acquiredCmake;
}
buildEnvironment.VCPKG_ROOT ||= path.join(workspaceRoot, 'target', 'aec3-msvc-vcpkg');
buildEnvironment.VCPKG_INSTALLED_ROOT ||= path.join(workspaceRoot, 'target', 'aec3-msvc-vcpkg-installed');
buildEnvironment.CMAKE_GENERATOR ||= 'Visual Studio 17 2022';
buildEnvironment.CMAKE_GENERATOR_PLATFORM ||= 'x64';

const runCommand = (command, args, cwd = workspaceRoot) => {
  console.log('> ' + command + ' ' + args.join(' '));
  const isWindows = process.platform === 'win32';
  const executable = isWindows && ['npm', 'npx'].includes(command) ? command + '.cmd' : command;
  const result = spawnSync(executable, args, {
    cwd,
    env: buildEnvironment,
    stdio: 'inherit',
    windowsHide: true,
    shell: isWindows,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error('Command failed with exit code ' + result.status);
    process.exit(result.status ?? 1);
  }
};

console.log('\n=== Step 2: Building Frontend & Native Bridge Binaries ===');
runCommand('npm', ['run', 'build', '--workspace', '@omni/desktop']);
runCommand('cargo', [
  'build',
  '--release',
  '--manifest-path',
  'apps/bridge-service-native/Cargo.toml',
  '--bins',
]);

console.log('\n=== Step 3: Packaging NSIS Graphical Installer via Tauri ===');
runCommand(
  'npx',
  [
    'tauri',
    'build',
    '--config',
    'src-tauri/tauri.installer.conf.json',
    '--bundles',
    'nsis',
    '--features',
    'webrtc-aec3',
  ],
  desktopRoot,
);

const nsisDir = path.join(workspaceRoot, 'target', 'release', 'nsis', 'x64');
const nsisOutputFile = path.join(nsisDir, 'nsis-output.exe');
const bundleDir = path.join(workspaceRoot, 'target', 'release', 'bundle', 'nsis');
const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
const finalInstallerPath = path.join(bundleDir, 'Omni Translate_' + pkg.version + '_x64-setup.exe');

if (fs.existsSync(nsisOutputFile)) {
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.copyFileSync(nsisOutputFile, finalInstallerPath);
}

if (!fs.existsSync(finalInstallerPath)) {
  console.error('Installer was not found at ' + finalInstallerPath);
  process.exit(1);
}

const stats = fs.statSync(finalInstallerPath);
console.log('\n=== Build Successful! ===');
console.log('GUI Installer generated at: ' + path.relative(workspaceRoot, finalInstallerPath));
console.log('File size: ' + (stats.size / (1024 * 1024)).toFixed(2) + ' MB (' + stats.size + ' bytes)');
