import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const rootPackage = readJson('package.json');
const version = rootPackage.version;
const releaseDir = path.join(rootDir, 'artifacts', 'release', version);
const signedDir = path.join(releaseDir, 'packages', 'signed');
const signingDir = path.join(releaseDir, 'signing');
const docsPath = 'docs/项目/正式版签名流程.md';
const bundleName = `OmniTranslate-${version}-windows-x64-portable`;
const signingWorkDir = path.join(signedDir, bundleName);

if (!fs.existsSync(signingWorkDir)) {
  throw new Error(`Signing work directory is missing at ${path.relative(rootDir, signingWorkDir)}. Run npm run release:package first.`);
}

const signableExtensions = new Set(['.exe', '.msi', '.dll', '.sys', '.cat', '.ps1']);
const collectFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(fullPath);
    }
    return [fullPath];
  });

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
