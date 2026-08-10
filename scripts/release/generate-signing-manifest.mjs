import fs from 'node:fs';
import path from 'node:path';

import {
  assertExactReleaseProvenance,
  bundleName,
  captureCleanReleaseProvenance,
  collectFiles,
  readJson,
  releasePaths,
  repoRoot,
  sha256,
} from '../lib/release-common.mjs';

const rootDir = repoRoot;

const rootPackage = readJson('package.json');
const sourceProvenance = captureCleanReleaseProvenance(rootDir);
const version = rootPackage.version;
const { signedDir, signingDir } = releasePaths(version);
const docsPath = 'docs/项目/正式版签名流程.md';
const signingWorkDir = path.join(signedDir, bundleName(version));

if (!fs.existsSync(signingWorkDir)) {
  throw new Error(`Signing work directory is missing at ${path.relative(rootDir, signingWorkDir)}. Run npm run release:package first.`);
}
for (const relativePath of [
  'release-manifest.json',
  'release-package.json',
  'installer-layout.json',
  'drivers/windows-virtual-mic/package/driver-package.json',
]) {
  const metadata = JSON.parse(fs.readFileSync(path.join(signingWorkDir, relativePath), 'utf8'));
  assertExactReleaseProvenance(metadata.sourceProvenance, sourceProvenance, `signed package ${relativePath}`);
  if (metadata.sourceCommit !== sourceProvenance.headCommit) {
    throw new Error(`Signed package ${relativePath} sourceCommit does not match the exact current clean HEAD.`);
  }
}
const signedLayout = JSON.parse(fs.readFileSync(path.join(signingWorkDir, 'installer-layout.json'), 'utf8'));
const releaseBuildContract = [
  ['desktop-shell', 'desktop/omni-desktop-shell.exe', 'embedded-commit'],
  ['native-bridge', 'bridge-service-native/omni-bridge-service.exe', '--build-commit'],
  ['audio-probe', 'bridge-service-native/omni-driver-audio-probe.exe', '--build-commit'],
  ['virtual-mic-target-capture', 'bridge-service-native/omni-virtual-mic-target-capture.exe', '--build-commit'],
];
if (
  signedLayout?.buildAuthority?.sourceCommit !== sourceProvenance.headCommit
  || signedLayout?.buildAuthority?.forcedCleanBuild !== true
  || !Array.isArray(signedLayout?.buildAuthority?.binaries)
  || signedLayout.buildAuthority.binaries.length !== releaseBuildContract.length
) throw new Error('Signing work directory has no exact current-HEAD forced-build authority.');
for (const [index, [role, relativePath, verification]] of releaseBuildContract.entries()) {
  const recorded = signedLayout.buildAuthority.binaries[index];
  const candidate = path.join(signingWorkDir, relativePath);
  if (
    recorded?.role !== role
    || recorded?.path !== relativePath
    || recorded?.verification !== verification
    || recorded?.sourceCommit !== sourceProvenance.headCommit
    || Number(recorded?.bytes) !== fs.statSync(candidate).size
    || recorded?.sha256 !== sha256(candidate)
  ) throw new Error(`Signing work directory build authority does not match ${relativePath}.`);
}

const signableExtensions = new Set(['.exe', '.msi', '.dll', '.sys', '.cat', '.ps1']);

const signTargets = collectFiles(signingWorkDir)
  .filter((filePath) => signableExtensions.has(path.extname(filePath).toLowerCase()))
  .map((fullPath) => ({
    fileName: path.basename(fullPath),
    path: path.relative(rootDir, fullPath),
    sha256: sha256(fullPath),
    expectedSignatureStatus: 'pending',
    signatureEvidencePath: null,
    verificationCommand: `Get-AuthenticodeSignature -FilePath \"${fullPath}\" | Format-List`,
  }));

fs.mkdirSync(signingDir, { recursive: true });

const manifest = {
  generatedAt: new Date().toISOString(),
  version,
  sourceCommit: sourceProvenance.headCommit,
  sourceProvenance,
  certificatePolicy: {
    owner: 'Release Manager',
    certificateType: 'EV Code Signing certificate for installer/archive; WHQL-compatible evidence for driver package when applicable',
    privateKeyHandling: 'Certificate private key must stay in the managed signing workstation or HSM-backed store.',
    timestampAuthority: 'RFC3161 trusted timestamp service required for all externally distributed artifacts.',
  },
  signTargets,
  verificationSteps: [
    'Confirm the SHA256 of each unsigned target matches this manifest before signing.',
    'Use the managed signing workstation to sign each target in packages/signed and record the output path under signatureEvidencePath.',
    'Run Get-AuthenticodeSignature for each signed target and archive the output in the same release directory.',
    'After sign-off, run npm run release:finalize-signed to assemble the signed delivery zip from packages/signed.',
    'Do not publish artifacts whose signature status is not valid and timestamped.',
  ],
  documentation: docsPath,
};

const outputPath = path.join(signingDir, 'signing-manifest.json');
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`Generated signing manifest at ${path.relative(rootDir, outputPath)}`);
