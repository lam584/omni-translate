import fs from 'node:fs';
import path from 'node:path';

import { bundleName, collectFiles, compressArchive, readJson, releasePaths, repoRoot, sha256 } from '../lib/release-common.mjs';

const rootDir = repoRoot;

const rootPackage = readJson('package.json');
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

fs.rmSync(signedBundleZip, { force: true });
compressArchive(signedBundleDir, signedBundleZip);

const signedFiles = collectFiles(signedBundleDir).map((filePath) => ({
  path: path.relative(rootDir, filePath),
  sha256: sha256(filePath),
}));

const signedChecksums = {
  generatedAt: new Date().toISOString(),
  version,
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
  signedWorkingDir: path.relative(rootDir, signedBundleDir),
  signedBundle: path.relative(rootDir, signedBundleZip),
  signedChecksums: path.relative(rootDir, signedChecksumsPath),
};
fs.writeFileSync(signedSummaryPath, `${JSON.stringify(signedSummary, null, 2)}\n`, 'utf8');

console.log(`Created signed release package at ${path.relative(rootDir, signedBundleZip)}`);
