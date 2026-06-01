import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const rootDir = process.cwd();
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
const rootPackage = readJson('package.json');

const version = rootPackage.version;
const releaseNotesPath = `docs/项目/发布说明-${version}.md`;
const installerLayoutDir = path.join(rootDir, 'artifacts', 'installer', version);
if (!fs.existsSync(installerLayoutDir)) {
  throw new Error(`Installer layout is missing at artifacts/installer/${version}. Run npm run installer:prepare first.`);
}

const releaseDir = path.join(rootDir, 'artifacts', 'release', version);
const packageRoot = path.join(releaseDir, 'packages');
const unsignedDir = path.join(packageRoot, 'unsigned');
const signedDir = path.join(packageRoot, 'signed');
const docsDir = path.join(releaseDir, 'docs');
const bundleName = `OmniTranslate-${version}-windows-x64-portable`;
const bundleDir = path.join(unsignedDir, bundleName);
const bundleZip = path.join(unsignedDir, `${bundleName}.zip`);
const signedBundleDir = path.join(signedDir, bundleName);
const signedBundleZip = path.join(signedDir, `${bundleName}.zip`);
const checksumPath = path.join(releaseDir, 'checksums.sha256.json');
const summaryPath = path.join(releaseDir, 'release-package-summary.json');
const manifestPath = path.join(releaseDir, 'release-manifest.json');

const docsToCopy = [
  'docs/项目/发布自动化.md',
  'docs/项目/测试与质量门禁.md',
  'docs/项目/正式版签名流程.md',
  releaseNotesPath,
  'docs/项目/安装手册.md',
  'docs/项目/支持手册.md',
  'docs/项目/故障排查手册.md',
  'docs/项目/灰度发布与问题收敛.md',
  'docs/项目/发布检查清单.md',
];

const copyTree = (source, target) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
};

const sha256 = (filePath) => {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

const collectFiles = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(fullPath);
    }
    return [fullPath];
  });
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
for (const relativeDoc of docsToCopy) {
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
  packageName: `${bundleName}.zip`,
  channel: 'stable',
  platform: 'windows-x64',
  manifest: fs.existsSync(manifestPath) ? path.relative(rootDir, manifestPath) : null,
  installEntry: 'scripts/installer/install-development-driver.ps1',
  uninstallEntry: 'scripts/installer/uninstall-development-driver.ps1',
  repairEntry: 'scripts/installer/repair-driver.ps1',
  docs: docsToCopy.map((relativePath) => path.basename(relativePath)),
};
fs.writeFileSync(path.join(bundleDir, 'release-package.json'), `${JSON.stringify(packageMetadata, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(signedBundleDir, 'release-package.json'), `${JSON.stringify(packageMetadata, null, 2)}\n`, 'utf8');

const psCommand = `Compress-Archive -Path '${bundleDir.replace(/'/g, "''")}\\*' -DestinationPath '${bundleZip.replace(/'/g, "''")}' -Force`;
execFileSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { stdio: 'inherit' });

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
