import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();

const requiredFiles = [
  'README.md',
  'CONTRIBUTING.md',
  'docs/项目/社区术语包格式规范.md',
  'docs/项目/发布自动化.md',
  'docs/项目/测试与质量门禁.md',
  'docs/项目/正式版签名流程.md',
  'docs/项目/发布说明-0.1.0.md',
  'docs/项目/安装手册.md',
  'docs/项目/支持手册.md',
  'docs/项目/故障排查手册.md',
  'docs/项目/灰度发布与问题收敛.md',
  'docs/项目/发布检查清单.md',
  'docs/项目/OBS集成边界.md',
  'apps/desktop/package.json',
  'apps/bridge-service/package.json',
  'apps/bridge-service-native/Cargo.toml',
  'scripts/release/prepare-installer-layout.mjs',
  'scripts/release/create-release-package.mjs',
  'scripts/release/generate-signing-manifest.mjs',
  'scripts/release/finalize-signed-package.mjs',
  'scripts/installer/install-development-driver.ps1',
  'scripts/installer/uninstall-development-driver.ps1',
  'scripts/installer/repair-driver.ps1',
];

const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));

const rootPackage = readJson('package.json');
const desktopPackage = readJson(path.join('apps', 'desktop', 'package.json'));
const bridgePackage = readJson(path.join('apps', 'bridge-service', 'package.json'));
const versionedReleaseNotes = `docs/项目/发布说明-${rootPackage.version}.md`;

if (!requiredFiles.includes(versionedReleaseNotes)) {
  requiredFiles.push(versionedReleaseNotes);
}

const missingFiles = requiredFiles.filter((relativePath) => !fs.existsSync(path.join(rootDir, relativePath)));

const requiredRootScripts = [
  'build:desktop',
  'check:desktop',
  'verify:desktop',
  'quality:gate',
  'check:bridge-service',
  'test:bridge-service',
  'check:bridge-service-native',
  'build:bridge-service-native',
  'test:bridge-service-native',
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

const versionMismatch = [desktopPackage.version, bridgePackage.version].some((version) => version !== rootPackage.version);

if (missingFiles.length || missingRootScripts.length || versionMismatch) {
  if (missingFiles.length) {
    console.error(`Missing files: ${missingFiles.join(', ')}`);
  }

  if (missingRootScripts.length) {
    console.error(`Missing root scripts: ${missingRootScripts.join(', ')}`);
  }

  if (versionMismatch) {
    console.error(
      `Version mismatch: root=${rootPackage.version}, desktop=${desktopPackage.version}, bridge-service=${bridgePackage.version}`,
    );
  }

  process.exit(1);
}

console.log('Release automation and support baseline is present.');
