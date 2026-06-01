import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const rootDir = process.cwd();
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const collectFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(fullPath);
    }
    return [fullPath];
  });

const rootPackage = readJson('package.json');
const version = rootPackage.version;
const bundleName = `OmniTranslate-${version}-windows-x64-portable`;
const releaseDir = path.join(rootDir, 'artifacts', 'release', version);
const signedDir = path.join(releaseDir, 'packages', 'signed');
const signedBundleDir = path.join(signedDir, bundleName);
const signedBundleZip = path.join(signedDir, `${bundleName}.zip`);
const signedChecksumsPath = path.join(releaseDir, 'signed-checksums.sha256.json');
const signedSummaryPath = path.join(releaseDir, 'signed-package-summary.json');

if (!fs.existsSync(signedBundleDir)) {
  throw new Error(`Signed working directory is missing at ${path.relative(rootDir, signedBundleDir)}. Run npm run release:package first.`);
}

fs.rmSync(signedBundleZip, { force: true });
const psCommand = `Compress-Archive -Path '${signedBundleDir.replace(/'/g, "''")}\\*' -DestinationPath '${signedBundleZip.replace(/'/g, "''")}' -Force`;
execFileSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { stdio: 'inherit' });

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
