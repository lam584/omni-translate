import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { RELEASE_DOCS, readCargoVersion, readJson, readText, repoRoot } from '../lib/release-common.mjs';
import { formatSkipBanner } from '../testing/overlay-driver-smoke.mjs';

const rootDir = repoRoot;
const legacyBridgeName = ['bridge', 'service'].join('-');

const requiredFiles = [
  'README.md',
  path.join('i18n', 'README_en.md'),
  ...RELEASE_DOCS,
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
  'scripts/testing/overlay-driver-smoke.mjs',
  'scripts/testing/run-overlay-driver-smoke.ps1',
  'scripts/testing/startup-ipc-stress.mjs',
  'scripts/testing/run-startup-ipc-stress.ps1',
];

// Repo-root-relative path of the smoke this script executes at the end.
const overlayDriverSmokeScript = 'scripts/testing/run-overlay-driver-smoke.ps1';

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
  'test:startup-readiness',
  'test:desktop-shell',
  'smoke:overlay-driver',
  'test:startup-ipc-stress',
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

// ---------------------------------------------------------------------------
// tauri-driver overlay smoke. The static checks above only prove the files
// exist; this proves the shipped overlay still opens through a real WebDriver
// session against the release build. Every non-executing path below prints the
// LOUD banner — a skipped smoke must never be mistakable for a passed one.
function runOverlayDriverSmoke() {
  // The banner goes to stderr and a single-line marker to stdout, so neither a
  // stdout-only nor a stderr-only capture of this chain can lose the skip.
  const loud = (reason) => {
    console.error(formatSkipBanner({ reason }));
    console.log(`SKIPPED overlay driver smoke: ${reason}`);
  };

  if (process.env.OMNI_SKIP_DRIVER_SMOKE === '1') {
    loud('OMNI_SKIP_DRIVER_SMOKE=1 was set in the environment');
    return 0;
  }

  if (process.platform !== 'win32') {
    loud(
      `platform ${process.platform} cannot drive the Windows WebView2 release build; `
      + 'run npm run smoke:overlay-driver on Windows before shipping this release',
    );
    return 0;
  }

  console.log(`Running the overlay driver smoke: ${overlayDriverSmokeScript}`);
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `./${overlayDriverSmokeScript}`],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (result.error) {
    console.error(`Overlay driver smoke could not be started: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const smokeExitCode = runOverlayDriverSmoke();
if (smokeExitCode !== 0) {
  console.error(
    'Overlay driver smoke failed. Install tauri-driver + msedgedriver and build the release shell '
    + '(npm run build:desktop-shell), or set OMNI_SKIP_DRIVER_SMOKE=1 to skip it with a recorded, loud gap.',
  );
  process.exit(smokeExitCode);
}
