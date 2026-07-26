import fs from 'node:fs';
import path from 'node:path';

import {
  RELEASE_DOCS,
  bundleName,
  collectFiles,
  compressArchive,
  readJson,
  releasePaths,
  repoRoot,
  sha256,
} from '../lib/release-common.mjs';

const rootDir = repoRoot;
const rootPackage = readJson('package.json');

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
  packageName: `${bundleBase}.zip`,
  channel: 'stable',
  platform: 'windows-x64',
  manifest: fs.existsSync(manifestPath) ? path.relative(rootDir, manifestPath) : null,
  installEntry: 'scripts/installer/install-development-driver.ps1',
  uninstallEntry: 'scripts/installer/uninstall-development-driver.ps1',
  repairEntry: 'scripts/installer/repair-driver.ps1',
  nativeBridgeExecutable: 'bridge-service-native/omni-bridge-service.exe',
  audioProbeExecutable: 'bridge-service-native/omni-driver-audio-probe.exe',
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
