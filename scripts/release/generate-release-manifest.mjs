import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();

const readJson = (relativePath) => {
  const fullPath = path.join(rootDir, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
};

const rootPackage = readJson('package.json');
const desktopPackage = readJson(path.join('apps', 'desktop', 'package.json'));
const bridgePackage = readJson(path.join('apps', 'bridge-service', 'package.json'));
const releaseNotesPath = `docs/项目/发布说明-${rootPackage.version}.md`;
const releaseDocs = [
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
    bridgeService: {
      name: bridgePackage.name,
      version: bridgePackage.version,
    },
  },
  commands: {
    qualityGate: 'npm run quality:gate',
    releaseVerify: 'npm run release:verify',
    releaseManifest: 'npm run release:manifest',
    releasePackage: 'npm run release:package',
    releaseSigningManifest: 'npm run release:signing-manifest',
    desktopVerify: 'npm run verify:desktop',
    desktopShellTest: 'npm run test:desktop-shell',
    bridgeCheck: 'npm run check:bridge-service',
    bridgeTest: 'npm run test:bridge-service',
    nativeBridgeCheck: 'npm run check:bridge-service-native',
    nativeBridgeBuild: 'npm run build:bridge-service-native',
    nativeBridgeTest: 'npm run test:bridge-service-native',
    installerPrepare: 'npm run installer:prepare',
  },
  installer: {
    layoutScript: 'scripts/release/prepare-installer-layout.mjs',
    scriptsDir: 'scripts/installer',
    layoutOutput: `artifacts/installer/${rootPackage.version}`,
  },
  docs: ['CONTRIBUTING.md', 'docs/项目/社区术语包格式规范.md', 'docs/项目/OBS集成边界.md', ...releaseDocs],
};

const outputDir = path.join(rootDir, 'artifacts', 'release', rootPackage.version);
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'release-manifest.json');
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(rootDir, 'artifacts', 'release', 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`Generated release manifest at ${path.relative(rootDir, outputPath)}`);
