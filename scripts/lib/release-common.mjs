import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isWindows } from './testing-common.mjs';

// Repository root derived from this file's location (scripts/lib/ -> repo root),
// so release scripts no longer depend on being launched from the repo root.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const projectDocsDir = path.join('docs', '项目');

// The four project docs shipped with every release (relative to the repo root).
export const RELEASE_DOCS = [
  path.join(projectDocsDir, 'Watch Mode 真实链路自动化测试.md'),
  path.join(projectDocsDir, '架构说明.md'),
  path.join(projectDocsDir, '测试与质量门禁.md'),
  path.join(projectDocsDir, '社区术语包格式规范.md'),
];

export const readText = (relativePath, rootDir = repoRoot) =>
  fs.readFileSync(path.join(rootDir, relativePath), 'utf8');

export const readJson = (relativePath, rootDir = repoRoot) => JSON.parse(readText(relativePath, rootDir));

export const readCargoVersion = (relativePath, rootDir = repoRoot) => {
  const match = readText(relativePath, rootDir).match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`Unable to read Cargo package version from ${relativePath}`);
  }
  return match[1];
};

// The three workspace version sources every release script starts from.
export const readWorkspaceVersions = (rootDir = repoRoot) => ({
  rootPackage: readJson('package.json', rootDir),
  desktopPackage: readJson(path.join('apps', 'desktop', 'package.json'), rootDir),
  nativeBridgeVersion: readCargoVersion(path.join('apps', 'bridge-service-native', 'Cargo.toml'), rootDir),
});

export const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

export const collectFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(fullPath);
    }
    return [fullPath];
  });

// Base name (without extension) of the portable release bundle.
export const bundleName = (version) => `OmniTranslate-${version}-windows-x64-portable`;

// Absolute release/installer directories for a given version.
export const releasePaths = (version) => {
  const releaseDir = path.join(repoRoot, 'artifacts', 'release', version);
  const packageRoot = path.join(releaseDir, 'packages');
  return {
    releaseDir,
    packageRoot,
    unsignedDir: path.join(packageRoot, 'unsigned'),
    signedDir: path.join(packageRoot, 'signed'),
    signingDir: path.join(releaseDir, 'signing'),
    installerLayoutDir: path.join(repoRoot, 'artifacts', 'installer', version),
  };
};

// Zip a directory's contents into zipPath. Windows must keep the PowerShell
// Compress-Archive byte stream because release artifacts are hashed downstream.
export const compressArchive = (sourceDir, zipPath) => {
  if (isWindows) {
    const psCommand = `Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { stdio: 'inherit' });
    return;
  }
  const absoluteZipPath = path.resolve(zipPath);
  // Compress-Archive -Force overwrites, while zip(1) updates an existing archive.
  fs.rmSync(absoluteZipPath, { force: true });
  try {
    execFileSync('zip', ['-r', absoluteZipPath, '.'], { cwd: sourceDir, stdio: 'inherit' });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('compressArchive requires the "zip" command on this platform. Install zip and retry.');
    }
    throw error;
  }
};
