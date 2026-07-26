import fs from 'node:fs';
import path from 'node:path';

import { bundleName, readCargoVersion, readJson, releasePaths, repoRoot } from '../lib/release-common.mjs';

const rootDir = repoRoot;

const rootPackage = readJson('package.json');
const desktopPackage = readJson(path.join('apps', 'desktop', 'package.json'));
const nativeBridgeVersion = readCargoVersion(path.join('apps', 'bridge-service-native', 'Cargo.toml'));

const copyTree = (source, target) => {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
};

// Release binaries land in the root workspace target directory; the per-crate
// target directories are kept as fallbacks for artifacts built before the root
// Cargo workspace existed.
const resolveBuiltExecutable = (candidates, missingMessage) => {
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (!existing) {
    throw new Error(missingMessage);
  }
  return existing;
};

const nativeBridgeExecutable = resolveBuiltExecutable(
  [
    path.join(rootDir, 'target', 'release', 'omni-bridge-service.exe'),
    path.join(rootDir, 'apps', 'bridge-service-native', 'target', 'release', 'omni-bridge-service.exe'),
  ],
  'Native Bridge Service executable is missing. Run npm run build:bridge-service-native first.',
);

const audioProbeExecutable = resolveBuiltExecutable(
  [
    path.join(rootDir, 'target', 'release', 'omni-driver-audio-probe.exe'),
    path.join(rootDir, 'apps', 'bridge-service-native', 'target', 'release', 'omni-driver-audio-probe.exe'),
  ],
  'WASAPI audio probe executable is missing. Run npm run build:bridge-service-native first.',
);

const desktopDist = path.join(rootDir, 'apps', 'desktop', 'dist');
if (!fs.existsSync(desktopDist)) {
  throw new Error('Desktop dist is missing. Run npm run verify:desktop first.');
}

const desktopExecutable = resolveBuiltExecutable(
  [
    path.join(rootDir, 'target', 'release', 'omni-desktop-shell.exe'),
    path.join(rootDir, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'omni-desktop-shell.exe'),
  ],
  'Desktop executable is missing. Run npm run build:desktop-shell first.',
);

const driverPackageDir = path.join(rootDir, 'drivers', 'windows-virtual-mic', 'package');
const developmentDriverCertificate = path.join(driverPackageDir, 'omni-translate-development-driver.cer');
if (fs.existsSync(developmentDriverCertificate)) {
  throw new Error(
    'The staged SYSVAD package uses the development test-signing credential. Rebuild it with scripts/installer/build-sysvad-driver.ps1 -Configuration Release -SigningPfxPath <release.pfx> -SigningPfxPasswordPath <password.txt> before preparing a stable installer.',
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
