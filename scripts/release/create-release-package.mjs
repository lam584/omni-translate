import fs from 'node:fs';
import path from 'node:path';

import {
  RELEASE_DOCS,
  assertExactReleaseProvenance,
  bundleName,
  captureCleanReleaseProvenance,
  collectFiles,
  compressArchive,
  readJson,
  releasePaths,
  repoRoot,
  sha256,
} from '../lib/release-common.mjs';

const rootDir = repoRoot;
const rootPackage = readJson('package.json');
const sourceProvenance = captureCleanReleaseProvenance(rootDir);

const version = rootPackage.version;
const { releaseDir, packageRoot, unsignedDir, signedDir, installerLayoutDir } = releasePaths(version);
if (!fs.existsSync(installerLayoutDir)) {
  throw new Error(`Installer layout is missing at artifacts/installer/${version}. Run npm run installer:prepare first.`);
}

const docsDir = path.join(releaseDir, 'docs');
const bundleBase = bundleName(version);
const bundleDir = path.join(unsignedDir, bundleBase);
const bundleZip = path.join(unsignedDir, `${bundleBase}.zip`);
const signedBundleDir = path.join(signedDir, bundleBase);
const signedBundleZip = path.join(signedDir, `${bundleBase}.zip`);
const checksumPath = path.join(releaseDir, 'checksums.sha256.json');
const summaryPath = path.join(releaseDir, 'release-package-summary.json');
const manifestPath = path.join(releaseDir, 'release-manifest.json');
if (!fs.existsSync(manifestPath)) {
  throw new Error(`Release manifest is missing at ${path.relative(rootDir, manifestPath)}. Run npm run release:manifest first.`);
}
const releaseManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assertExactReleaseProvenance(releaseManifest.sourceProvenance, sourceProvenance, 'release manifest');
if (releaseManifest.sourceCommit !== sourceProvenance.headCommit) {
  throw new Error('Release manifest sourceCommit does not match the exact current clean HEAD.');
}
const layoutMetadataPath = path.join(installerLayoutDir, 'installer-layout.json');
if (!fs.existsSync(layoutMetadataPath)) {
  throw new Error('Installer layout metadata is missing. Run npm run installer:prepare first.');
}
const layoutMetadata = JSON.parse(fs.readFileSync(layoutMetadataPath, 'utf8'));
assertExactReleaseProvenance(layoutMetadata.sourceProvenance, sourceProvenance, 'installer layout');
if (layoutMetadata.sourceCommit !== sourceProvenance.headCommit) {
  throw new Error('Installer layout sourceCommit does not match the exact current clean HEAD.');
}
const releaseBuildContract = [
  ['desktop-shell', 'desktop/omni-desktop-shell.exe', 'embedded-commit'],
  ['native-bridge', 'bridge-service-native/omni-bridge-service.exe', '--build-commit'],
  ['audio-probe', 'bridge-service-native/omni-driver-audio-probe.exe', '--build-commit'],
  ['virtual-mic-target-capture', 'bridge-service-native/omni-virtual-mic-target-capture.exe', '--build-commit'],
];
if (
  layoutMetadata?.buildAuthority?.schemaVersion !== 1
  || layoutMetadata?.buildAuthority?.artifactKind !== 'omni-release-build-authority'
  || layoutMetadata?.buildAuthority?.sourceCommit !== sourceProvenance.headCommit
  || layoutMetadata?.buildAuthority?.forcedCleanBuild !== true
  || !String(layoutMetadata?.buildAuthority?.cargoTargetDirectory ?? '')
    .includes(sourceProvenance.headCommit)
  || !Array.isArray(layoutMetadata?.buildAuthority?.binaries)
  || layoutMetadata.buildAuthority.binaries.length !== releaseBuildContract.length
) throw new Error('Installer layout does not contain exact current-HEAD forced-build authority.');
for (const [index, [role, relativePath, verification]] of releaseBuildContract.entries()) {
  const recorded = layoutMetadata.buildAuthority.binaries[index];
  const candidate = path.join(installerLayoutDir, relativePath);
  if (
    recorded?.role !== role
    || recorded?.path !== relativePath
    || recorded?.verification !== verification
    || recorded?.sourceCommit !== sourceProvenance.headCommit
    || Number(recorded?.bytes) !== fs.statSync(candidate).size
    || recorded?.sha256 !== sha256(candidate)
  ) throw new Error(`Installer layout build authority does not match ${relativePath}.`);
}
const driverMetadataPath = path.join(
  installerLayoutDir,
  'drivers',
  'windows-virtual-mic',
  'package',
  'driver-package.json',
);
const driverMetadata = JSON.parse(fs.readFileSync(driverMetadataPath, 'utf8'));
assertExactReleaseProvenance(driverMetadata.sourceProvenance, sourceProvenance, 'installer layout driver package');
if (driverMetadata.sourceCommit !== sourceProvenance.headCommit) {
  throw new Error('Installer layout driver sourceCommit does not match the exact current clean HEAD.');
}

const copyTree = (source, target) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
};

fs.mkdirSync(unsignedDir, { recursive: true });
fs.mkdirSync(signedDir, { recursive: true });
fs.mkdirSync(docsDir, { recursive: true });
fs.rmSync(bundleDir, { recursive: true, force: true });
fs.rmSync(bundleZip, { force: true });
fs.rmSync(signedBundleDir, { recursive: true, force: true });
fs.rmSync(signedBundleZip, { force: true });

copyTree(installerLayoutDir, bundleDir);
copyTree(installerLayoutDir, signedBundleDir);
fs.copyFileSync(manifestPath, path.join(bundleDir, 'release-manifest.json'));
fs.copyFileSync(manifestPath, path.join(signedBundleDir, 'release-manifest.json'));
for (const relativeDoc of RELEASE_DOCS) {
  const source = path.join(rootDir, relativeDoc);
  const target = path.join(docsDir, path.basename(relativeDoc));
  fs.copyFileSync(source, target);
  fs.mkdirSync(path.join(bundleDir, 'docs'), { recursive: true });
  fs.copyFileSync(source, path.join(bundleDir, 'docs', path.basename(relativeDoc)));
  fs.mkdirSync(path.join(signedBundleDir, 'docs'), { recursive: true });
  fs.copyFileSync(source, path.join(signedBundleDir, 'docs', path.basename(relativeDoc)));
}

const packageMetadata = {
  generatedAt: new Date().toISOString(),
  version,
  sourceCommit: sourceProvenance.headCommit,
  sourceProvenance,
  packageName: `${bundleBase}.zip`,
  channel: 'stable',
  platform: 'windows-x64',
  manifest: fs.existsSync(manifestPath) ? path.relative(rootDir, manifestPath) : null,
  installEntry: 'scripts/installer/install-development-driver.ps1',
  uninstallEntry: 'scripts/installer/uninstall-development-driver.ps1',
  repairEntry: 'scripts/installer/repair-driver.ps1',
  nativeBridgeExecutable: 'bridge-service-native/omni-bridge-service.exe',
  audioProbeExecutable: 'bridge-service-native/omni-driver-audio-probe.exe',
  virtualMicTargetCaptureExecutable: 'bridge-service-native/omni-virtual-mic-target-capture.exe',
  docs: RELEASE_DOCS.map((relativePath) => path.basename(relativePath)),
};
fs.writeFileSync(path.join(bundleDir, 'release-package.json'), `${JSON.stringify(packageMetadata, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(signedBundleDir, 'release-package.json'), `${JSON.stringify(packageMetadata, null, 2)}\n`, 'utf8');

compressArchive(bundleDir, bundleZip);

const bundleFiles = collectFiles(bundleDir).map((filePath) => ({
  path: path.relative(rootDir, filePath),
  sha256: sha256(filePath),
}));
const checksums = {
  generatedAt: new Date().toISOString(),
  version,
  sourceCommit: sourceProvenance.headCommit,
  sourceProvenance,
  bundle: {
    path: path.relative(rootDir, bundleZip),
    sha256: sha256(bundleZip),
  },
  files: bundleFiles,
};
fs.writeFileSync(checksumPath, `${JSON.stringify(checksums, null, 2)}\n`, 'utf8');

const summary = {
  generatedAt: new Date().toISOString(),
  version,
  sourceCommit: sourceProvenance.headCommit,
  sourceProvenance,
  packageRoot: path.relative(rootDir, packageRoot),
  unsignedBundle: path.relative(rootDir, bundleZip),
  unsignedBundleDir: path.relative(rootDir, bundleDir),
  signedWorkingDir: path.relative(rootDir, signedBundleDir),
  signedBundle: path.relative(rootDir, signedBundleZip),
  signedOutputDir: path.relative(rootDir, signedDir),
  checksumManifest: path.relative(rootDir, checksumPath),
  docsDir: path.relative(rootDir, docsDir),
};
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

console.log(`Created release package at ${path.relative(rootDir, bundleZip)}`);
