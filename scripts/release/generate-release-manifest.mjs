import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const projectDocsDir = path.join('docs', '项目');

const readText = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(readText(relativePath));
const readCargoVersion = (relativePath) => {
  const match = readText(relativePath).match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`Unable to read Cargo package version from ${relativePath}`);
  }
  return match[1];
};

const rootPackage = readJson('package.json');
const desktopPackage = readJson(path.join('apps', 'desktop', 'package.json'));
const nativeBridgeVersion = readCargoVersion(path.join('apps', 'bridge-service-native', 'Cargo.toml'));
const releaseDocs = [
  path.join(projectDocsDir, 'Watch Mode 真实链路自动化测试.md'),
  path.join(projectDocsDir, '架构说明.md'),
  path.join(projectDocsDir, '测试与质量门禁.md'),
  path.join(projectDocsDir, '社区术语包格式规范.md'),
];

const manifest = {
  generatedAt: new Date().toISOString(),
  version: rootPackage.version,
  releaseChannel: 'stable',
  packageNaming: {
    portableBundle: `OmniTranslate-${rootPackage.version}-windows-x64-portable.zip`,
    installerLayout: `artifacts/installer/${rootPackage.version}`,
  },
  packages: {
    root: {
      name: rootPackage.name,
      version: rootPackage.version,
    },
    desktop: {
      name: desktopPackage.name,
      version: desktopPackage.version,
    },
    nativeBridge: {
      name: 'omni-bridge-service',
      version: nativeBridgeVersion,
    },
  },
  commands: {
    qualityGate: 'npm run quality:gate',
    contractGate: 'npm run test:contracts',
    releaseVerify: 'npm run release:verify',
    releaseManifest: 'npm run release:manifest',
    releasePackage: 'npm run release:package',
    releaseSigningManifest: 'npm run release:signing-manifest',
    desktopVerify: 'npm run verify:desktop',
    desktopShellTest: 'npm run test:desktop-shell',
    nativeBridgeCheck: 'npm run check:bridge-service-native',
    nativeBridgeBuild: 'npm run build:bridge-service-native',
    nativeBridgeTest: 'npm run test:bridge-service-native',
    watchModeReportTest: 'npm run test:watch-mode-report',
    installerPrepare: 'npm run installer:prepare',
  },
  installer: {
    layoutScript: 'scripts/release/prepare-installer-layout.mjs',
    scriptsDir: 'scripts/installer',
    layoutOutput: `artifacts/installer/${rootPackage.version}`,
    nativeBridgeExecutable: 'bridge-service-native/omni-bridge-service.exe',
  },
  docs: ['README.md', path.join('i18n', 'README_en.md'), ...releaseDocs],
};

const outputDir = path.join(rootDir, 'artifacts', 'release', rootPackage.version);
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'release-manifest.json');
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(rootDir, 'artifacts', 'release', 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`Generated release manifest at ${path.relative(rootDir, outputPath)}`);
