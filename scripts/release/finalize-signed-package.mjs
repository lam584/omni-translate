import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
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
const bundleBase = bundleName(version);
const { releaseDir, signedDir } = releasePaths(version);
const signedBundleDir = path.join(signedDir, bundleBase);
const signedBundleZip = path.join(signedDir, `${bundleBase}.zip`);
const signedChecksumsPath = path.join(releaseDir, 'signed-checksums.sha256.json');
const signedSummaryPath = path.join(releaseDir, 'signed-package-summary.json');

if (!fs.existsSync(signedBundleDir)) {
  throw new Error(`Signed working directory is missing at ${path.relative(rootDir, signedBundleDir)}. Run npm run release:package first.`);
}
const signingManifestPath = path.join(releaseDir, 'signing', 'signing-manifest.json');
for (const candidate of [
  signingManifestPath,
  path.join(signedBundleDir, 'release-manifest.json'),
  path.join(signedBundleDir, 'release-package.json'),
  path.join(signedBundleDir, 'installer-layout.json'),
  path.join(signedBundleDir, 'drivers', 'windows-virtual-mic', 'package', 'driver-package.json'),
]) {
  const metadata = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  assertExactReleaseProvenance(metadata.sourceProvenance, sourceProvenance, path.relative(rootDir, candidate));
  if (metadata.sourceCommit !== sourceProvenance.headCommit) {
    throw new Error(`${path.relative(rootDir, candidate)} sourceCommit does not match the exact current clean HEAD.`);
  }
}

const signedLayoutPath = path.join(signedBundleDir, 'installer-layout.json');
const signedLayout = JSON.parse(fs.readFileSync(signedLayoutPath, 'utf8'));
const releaseBuildContract = [
  ['desktop-shell', 'desktop/omni-desktop-shell.exe', 'embedded-commit'],
  ['native-bridge', 'bridge-service-native/omni-bridge-service.exe', '--build-commit'],
  ['audio-probe', 'bridge-service-native/omni-driver-audio-probe.exe', '--build-commit'],
  ['virtual-mic-target-capture', 'bridge-service-native/omni-virtual-mic-target-capture.exe', '--build-commit'],
];
if (
  signedLayout?.buildAuthority?.schemaVersion !== 1
  || signedLayout?.buildAuthority?.artifactKind !== 'omni-release-build-authority'
  || signedLayout?.buildAuthority?.sourceCommit !== sourceProvenance.headCommit
  || signedLayout?.buildAuthority?.forcedCleanBuild !== true
  || !Array.isArray(signedLayout?.buildAuthority?.binaries)
  || signedLayout.buildAuthority.binaries.length !== releaseBuildContract.length
) throw new Error('Signed package has no exact current-HEAD forced-build authority.');
for (const [index, [role, relativePath, verification]] of releaseBuildContract.entries()) {
  const recorded = signedLayout.buildAuthority.binaries[index];
  const candidate = path.join(signedBundleDir, relativePath);
  if (
    recorded?.role !== role
    || recorded?.path !== relativePath
    || recorded?.verification !== verification
    || recorded?.sourceCommit !== sourceProvenance.headCommit
    || !fs.existsSync(candidate)
  ) throw new Error(`Signed package build authority is invalid for ${relativePath}.`);
  if (verification === 'embedded-commit') {
    if (!fs.readFileSync(candidate).includes(Buffer.from(sourceProvenance.headCommit, 'ascii'))) {
      throw new Error(`${relativePath} does not embed the exact current clean HEAD commit.`);
    }
  } else {
    const result = spawnSync(candidate, ['--build-commit'], {
      cwd: rootDir,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (
      result.error
      || result.status !== 0
      || String(result.stdout ?? '').trim() !== sourceProvenance.headCommit
    ) throw new Error(`${relativePath} does not report the exact current clean HEAD compile commit.`);
  }
  recorded.bytes = fs.statSync(candidate).size;
  recorded.sha256 = sha256(candidate);
}
fs.writeFileSync(signedLayoutPath, `${JSON.stringify(signedLayout, null, 2)}\n`, 'utf8');

fs.rmSync(signedBundleZip, { force: true });
compressArchive(signedBundleDir, signedBundleZip);

const signedFiles = collectFiles(signedBundleDir).map((filePath) => ({
  path: path.relative(rootDir, filePath),
  sha256: sha256(filePath),
}));

const signedChecksums = {
  generatedAt: new Date().toISOString(),
  version,
  sourceCommit: sourceProvenance.headCommit,
  sourceProvenance,
  bundle: {
    path: path.relative(rootDir, signedBundleZip),
    sha256: sha256(signedBundleZip),
  },
  files: signedFiles,
};
fs.writeFileSync(signedChecksumsPath, `${JSON.stringify(signedChecksums, null, 2)}\n`, 'utf8');

const signedSummary = {
  generatedAt: new Date().toISOString(),
  version,
  sourceCommit: sourceProvenance.headCommit,
  sourceProvenance,
  signedWorkingDir: path.relative(rootDir, signedBundleDir),
  signedBundle: path.relative(rootDir, signedBundleZip),
  signedChecksums: path.relative(rootDir, signedChecksumsPath),
};
fs.writeFileSync(signedSummaryPath, `${JSON.stringify(signedSummary, null, 2)}\n`, 'utf8');

console.log(`Created signed release package at ${path.relative(rootDir, signedBundleZip)}`);
