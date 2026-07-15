import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const projectDocsDir = path.join('docs', '项目');
const legacyBridgeName = ['bridge', 'service'].join('-');

const requiredFiles = [
  'README.md',
  path.join('i18n', 'README_en.md'),
  path.join(projectDocsDir, 'Watch Mode 真实链路自动化测试.md'),
  path.join(projectDocsDir, '架构说明.md'),
  path.join(projectDocsDir, '测试与质量门禁.md'),
  path.join(projectDocsDir, '社区术语包格式规范.md'),
  'apps/desktop/package.json',
  'apps/bridge-service-native/Cargo.toml',
  'scripts/release/prepare-installer-layout.mjs',
  'scripts/release/create-release-package.mjs',
  'scripts/release/generate-release-manifest.mjs',
  'scripts/release/generate-signing-manifest.mjs',
  'scripts/release/finalize-signed-package.mjs',
  'scripts/installer/install-development-driver.ps1',
  'scripts/installer/uninstall-development-driver.ps1',
  'scripts/installer/repair-driver.ps1',
  'scripts/testing/verify-contracts.mjs',
];

const readText = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(readText(relativePath));

function readCargoVersion(relativePath) {
  const match = readText(relativePath).match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`Unable to read Cargo package version from ${relativePath}`);
  }
  return match[1];
}

const rootPackage = readJson('package.json');
const desktopPackage = readJson(path.join('apps', 'desktop', 'package.json'));
const nativeBridgeVersion = readCargoVersion(path.join('apps', 'bridge-service-native', 'Cargo.toml'));

const missingFiles = requiredFiles.filter((relativePath) => !fs.existsSync(path.join(rootDir, relativePath)));

const requiredRootScripts = [
  'build:desktop',
  'check:desktop',
  'verify:desktop',
  'quality:gate',
  'test:contracts',
  'check:bridge-service-native',
  'build:bridge-service-native',
  'test:bridge-service-native',
  'test:watch-mode-report',
  'test:desktop-shell',
  'release:manifest',
  'release:verify',
  'release:package',
  'release:signing-manifest',
  'release:finalize-signed',
  'release:prepare',
  'installer:prepare',
];
const missingRootScripts = requiredRootScripts.filter((scriptName) => !rootPackage.scripts?.[scriptName]);

const removedLegacyScripts = ['check', 'build', 'test', 'test:coverage'].map((prefix) => `${prefix}:${legacyBridgeName}`);
const staleLegacyScripts = removedLegacyScripts.filter((scriptName) => rootPackage.scripts?.[scriptName]);
const legacyWorkspacePath = path.join(rootDir, 'apps', legacyBridgeName);
const legacyWorkspacePresent = fs.existsSync(legacyWorkspacePath);
const installerLayoutScript = readText('scripts/release/prepare-installer-layout.mjs');
const installerStillCopiesLegacyBridge =
  new RegExp(`path\\.join\\(['"]apps['"],\\s*['"]${legacyBridgeName}['"]\\)`).test(installerLayoutScript) ||
  installerLayoutScript.includes(['bridge', 'Dist'].join('')) ||
  installerLayoutScript.includes(['bridge', 'Package'].join(''));
const versionMismatch = [desktopPackage.version, nativeBridgeVersion].some((version) => version !== rootPackage.version);

if (
  missingFiles.length ||
  missingRootScripts.length ||
  staleLegacyScripts.length ||
  legacyWorkspacePresent ||
  installerStillCopiesLegacyBridge ||
  versionMismatch
) {
  if (missingFiles.length) {
    console.error(`Missing files: ${missingFiles.join(', ')}`);
  }

  if (missingRootScripts.length) {
    console.error(`Missing root scripts: ${missingRootScripts.join(', ')}`);
  }

  if (staleLegacyScripts.length) {
    console.error(`Removed legacy bridge scripts are still present: ${staleLegacyScripts.join(', ')}`);
  }

  if (legacyWorkspacePresent) {
    console.error(`Legacy bridge workspace still exists: ${path.relative(rootDir, legacyWorkspacePath)}`);
  }

  if (installerStillCopiesLegacyBridge) {
    console.error('Installer layout script still contains legacy bridge copy logic.');
  }

  if (versionMismatch) {
    console.error(
      `Version mismatch: root=${rootPackage.version}, desktop=${desktopPackage.version}, nativeBridge=${nativeBridgeVersion}`,
    );
  }

  process.exit(1);
}

console.log('Release automation and native bridge baseline is present.');
