import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  bundleName,
  assertExactReleaseProvenance,
  captureCleanReleaseProvenance,
  readWorkspaceVersions,
  releasePaths,
  repoRoot,
  sha256,
} from '../lib/release-common.mjs';

const rootDir = repoRoot;

const { rootPackage, desktopPackage, nativeBridgeVersion } = readWorkspaceVersions();
const sourceProvenance = captureCleanReleaseProvenance(rootDir);

const releaseTargetDir = path.join(
  rootDir,
  'artifacts',
  'release-build',
  sourceProvenance.headCommit,
  'target',
);
const normalizedReleaseTarget = path.resolve(releaseTargetDir);
const normalizedReleaseBuildRoot = path.resolve(rootDir, 'artifacts', 'release-build');
if (!normalizedReleaseTarget.startsWith(`${normalizedReleaseBuildRoot}${path.sep}`)) {
  throw new Error('Refusing to clean a release build target outside artifacts/release-build.');
}
fs.rmSync(normalizedReleaseTarget, { recursive: true, force: true });

const releaseEnvironment = {
  ...process.env,
  CARGO_TARGET_DIR: normalizedReleaseTarget,
  OMNI_BUILD_COMMIT: sourceProvenance.headCommit,
};
const runReleaseBuild = (command, args, label) => {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: releaseEnvironment,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
};
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
runReleaseBuild(npmExecutable, ['run', 'build:desktop-shell'], 'current-HEAD Desktop release build');
runReleaseBuild('cargo', [
  'build',
  '--release',
  '--manifest-path',
  'apps/bridge-service-native/Cargo.toml',
  '--bins',
], 'current-HEAD Bridge release build');
assertExactReleaseProvenance(
  captureCleanReleaseProvenance(rootDir),
  sourceProvenance,
  'post-build release source',
);

const copyTree = (source, target) => {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
};

const resolveBuiltExecutable = (fileName, missingMessage) => {
  const candidate = path.join(normalizedReleaseTarget, 'release', fileName);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile() || fs.statSync(candidate).size <= 0) {
    throw new Error(missingMessage);
  }
  return candidate;
};

const nativeBridgeExecutable = resolveBuiltExecutable(
  'omni-bridge-service.exe',
  'The forced current-HEAD build did not emit omni-bridge-service.exe.',
);

const audioProbeExecutable = resolveBuiltExecutable(
  'omni-driver-audio-probe.exe',
  'The forced current-HEAD build did not emit omni-driver-audio-probe.exe.',
);

const virtualMicTargetCaptureExecutable = resolveBuiltExecutable(
  'omni-virtual-mic-target-capture.exe',
  'The forced current-HEAD build did not emit omni-virtual-mic-target-capture.exe.',
);

const desktopDist = path.join(rootDir, 'apps', 'desktop', 'dist');
if (!fs.existsSync(desktopDist)) {
  throw new Error('Desktop dist is missing. Run npm run verify:desktop first.');
}

const desktopExecutable = resolveBuiltExecutable(
  'omni-desktop-shell.exe',
  'The forced current-HEAD build did not emit omni-desktop-shell.exe.',
);

if (!fs.readFileSync(desktopExecutable).includes(Buffer.from(sourceProvenance.headCommit, 'ascii'))) {
  throw new Error('Desktop release executable does not embed the exact current clean HEAD commit.');
}
const assertBridgeBuildCommit = (candidate, label) => {
  const result = spawnSync(candidate, ['--build-commit'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (
    result.error
    || result.status !== 0
    || String(result.stdout ?? '').trim() !== sourceProvenance.headCommit
  ) {
    throw new Error(`${label} does not report the exact current clean HEAD compile commit.`);
  }
};
assertBridgeBuildCommit(nativeBridgeExecutable, 'Native Bridge Service');
assertBridgeBuildCommit(audioProbeExecutable, 'WASAPI audio probe');
assertBridgeBuildCommit(virtualMicTargetCaptureExecutable, 'Virtual microphone target capture');

const binaryAuthority = [
  ['desktop-shell', 'desktop/omni-desktop-shell.exe', desktopExecutable, 'embedded-commit'],
  ['native-bridge', 'bridge-service-native/omni-bridge-service.exe', nativeBridgeExecutable, '--build-commit'],
  ['audio-probe', 'bridge-service-native/omni-driver-audio-probe.exe', audioProbeExecutable, '--build-commit'],
  ['virtual-mic-target-capture', 'bridge-service-native/omni-virtual-mic-target-capture.exe', virtualMicTargetCaptureExecutable, '--build-commit'],
].map(([role, binaryPath, sourcePath, verification]) => ({
  role,
  path: binaryPath,
  bytes: fs.statSync(sourcePath).size,
  sha256: sha256(sourcePath),
  sourceCommit: sourceProvenance.headCommit,
  verification,
}));

const driverPackageDir = path.join(rootDir, 'drivers', 'windows-virtual-mic', 'package');
const developmentDriverCertificate = path.join(driverPackageDir, 'omni-translate-development-driver.cer');
if (fs.existsSync(developmentDriverCertificate)) {
  throw new Error(
    'The staged SYSVAD package uses the development test-signing credential. Rebuild it with scripts/installer/build-sysvad-driver.ps1 -Configuration Release -SigningPfxPath <release.pfx> -SigningPfxPasswordPath <password.txt> -SigningTimestampUrl <rfc3161-url> before preparing a stable installer.',
  );
}
const driverMetadataPath = path.join(driverPackageDir, 'driver-package.json');
if (!fs.existsSync(driverMetadataPath)) {
  throw new Error('Driver package metadata is missing. Rebuild the SYSVAD package before preparing a stable installer.');
}
const driverPackageMetadata = JSON.parse(fs.readFileSync(driverMetadataPath, 'utf8'));
if (driverPackageMetadata.signingMode !== 'release-injected') {
  throw new Error(`Stable installer requires a release-injected driver signature, received: ${driverPackageMetadata.signingMode}`);
}
assertExactReleaseProvenance(driverPackageMetadata.sourceProvenance, sourceProvenance, 'driver package');
if (driverPackageMetadata.sourceCommit !== sourceProvenance.headCommit) {
  throw new Error('Stable installer driver package sourceCommit does not match the exact current clean HEAD.');
}
const driverPackageFiles = [
  'omni-virtual-speaker.inf',
  'omni-virtual-speaker.sys',
  'omni-virtual-speaker.cat',
  'driver-package.json',
];
for (const fileName of driverPackageFiles) {
  if (!fs.existsSync(path.join(driverPackageDir, fileName))) {
    throw new Error(`Driver package file is missing: drivers/windows-virtual-mic/package/${fileName}`);
  }
}

const versionDir = releasePaths(rootPackage.version).installerLayoutDir;
fs.rmSync(versionDir, { recursive: true, force: true });
const layout = {
  version: rootPackage.version,
  generatedAt: new Date().toISOString(),
  sourceCommit: sourceProvenance.headCommit,
  sourceProvenance,
  buildAuthority: {
    schemaVersion: 1,
    artifactKind: 'omni-release-build-authority',
    sourceCommit: sourceProvenance.headCommit,
    cargoTargetDirectory: path.relative(rootDir, normalizedReleaseTarget).split(path.sep).join('/'),
    forcedCleanBuild: true,
    binaries: binaryAuthority,
  },
  naming: {
    packageBaseName: bundleName(rootPackage.version),
    channel: 'stable',
    platform: 'windows-x64',
  },
  packages: {
    desktop: desktopPackage.version,
    nativeBridge: nativeBridgeVersion,
  },
  upgradePolicy: {
    keepBackups: 2,
    cleanup: ['installed-driver', 'payloads'],
  },
};

fs.mkdirSync(path.join(versionDir, 'bridge-service-native'), { recursive: true });
fs.copyFileSync(nativeBridgeExecutable, path.join(versionDir, 'bridge-service-native', 'omni-bridge-service.exe'));
fs.copyFileSync(audioProbeExecutable, path.join(versionDir, 'bridge-service-native', 'omni-driver-audio-probe.exe'));
fs.copyFileSync(virtualMicTargetCaptureExecutable, path.join(versionDir, 'bridge-service-native', 'omni-virtual-mic-target-capture.exe'));
copyTree(desktopDist, path.join(versionDir, 'desktop', 'web-assets'));
fs.mkdirSync(path.join(versionDir, 'desktop'), { recursive: true });
fs.copyFileSync(desktopExecutable, path.join(versionDir, 'desktop', 'omni-desktop-shell.exe'));
copyTree(path.join(rootDir, 'apps', 'desktop', 'src-tauri', 'icons'), path.join(versionDir, 'desktop', 'icons'));
fs.copyFileSync(
  path.join(rootDir, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'),
  path.join(versionDir, 'desktop', 'tauri.conf.json'),
);
const targetDriverPackageDir = path.join(versionDir, 'drivers', 'windows-virtual-mic', 'package');
fs.mkdirSync(targetDriverPackageDir, { recursive: true });
for (const fileName of driverPackageFiles) {
  fs.copyFileSync(path.join(driverPackageDir, fileName), path.join(targetDriverPackageDir, fileName));
}
copyTree(path.join(rootDir, 'scripts', 'installer'), path.join(versionDir, 'scripts', 'installer'));
fs.writeFileSync(path.join(versionDir, 'installer-layout.json'), `${JSON.stringify(layout, null, 2)}\n`, 'utf8');

console.log(`Prepared installer layout at ${path.relative(rootDir, versionDir)}`);
