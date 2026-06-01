import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();

const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));

const rootPackage = readJson('package.json');
const desktopPackage = readJson(path.join('apps', 'desktop', 'package.json'));
const bridgePackage = readJson(path.join('apps', 'bridge-service', 'package.json'));

const copyTree = (source, target) => {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
};

const bridgeDist = path.join(rootDir, 'apps', 'bridge-service', 'dist');
if (!fs.existsSync(bridgeDist)) {
  throw new Error('Bridge Service dist is missing. Run npm run build:bridge-service first.');
}

const nativeBridgeExecutable = path.join(rootDir, 'apps', 'bridge-service-native', 'target', 'release', 'omni-bridge-service.exe');
if (!fs.existsSync(nativeBridgeExecutable)) {
  throw new Error('Native Bridge Service executable is missing. Run npm run build:bridge-service-native first.');
}

const desktopDist = path.join(rootDir, 'apps', 'desktop', 'dist');
if (!fs.existsSync(desktopDist)) {
  throw new Error('Desktop dist is missing. Run npm run verify:desktop first.');
}

const desktopExecutable = path.join(rootDir, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'omni-desktop-shell.exe');
if (!fs.existsSync(desktopExecutable)) {
  throw new Error('Desktop executable is missing. Run npm run build:desktop-shell first.');
}

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

const versionDir = path.join(rootDir, 'artifacts', 'installer', rootPackage.version);
fs.rmSync(versionDir, { recursive: true, force: true });
const layout = {
  version: rootPackage.version,
  generatedAt: new Date().toISOString(),
  naming: {
    packageBaseName: `OmniTranslate-${rootPackage.version}-windows-x64-portable`,
    channel: 'stable',
    platform: 'windows-x64',
  },
  packages: {
    desktop: desktopPackage.version,
    bridgeService: bridgePackage.version,
  },
  upgradePolicy: {
    keepBackups: 2,
    cleanup: ['installed-driver', 'payloads'],
  },
};

copyTree(bridgeDist, path.join(versionDir, 'bridge-service'));
fs.mkdirSync(path.join(versionDir, 'bridge-service-native'), { recursive: true });
fs.copyFileSync(nativeBridgeExecutable, path.join(versionDir, 'bridge-service-native', 'omni-bridge-service.exe'));
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
