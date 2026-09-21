import fs from 'node:fs';
import { projectBailianModule } from '../../provider-modules/bailian/build-manifest.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { loadProviderManifests, verifyProviderManifests } from './verify-provider-manifests.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputPath = path.join(repositoryRoot, 'contracts', 'provider-manifests.compiled.v1.json');

const compatibilityPath = path.join(repositoryRoot, 'contracts', 'model-protocol-profiles.v1.json');

export function buildBailianCompatibilityRegistry() {
  return projectBailianModule(repositoryRoot).manifest.bailianModelProtocolRegistry;
}

function manifestDigest(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function buildProviderManifestBundle() {
  verifyProviderManifests();
  const { manifests } = loadProviderManifests();
  const sorted = [...manifests].sort((left, right) => left.providerId.localeCompare(right.providerId));
  return {
    $schema: './provider-manifest-bundle.schema.json',
    schemaVersion: 'provider-manifest-bundle/v1',
    sources: sorted.map(({ manifest, providerId, relativePath }) => ({
      providerId,
      path: relativePath,
      manifestVersion: manifest.manifestVersion,
      checkedAt: manifest.checkedAt,
      sha256: manifestDigest(manifest),
    })),
    manifests: sorted.map(({ manifest }) => manifest),
  };
}

export function writeProviderManifestBundle() {
  for (const [relative, value] of projectBailianModule(repositoryRoot).files) {
    fs.writeFileSync(path.join(repositoryRoot, relative), JSON.stringify(value, null, 2) + '\n', 'utf8');
  }
  const bundle = buildProviderManifestBundle();
  fs.writeFileSync(compatibilityPath, `${JSON.stringify(buildBailianCompatibilityRegistry(), null, 2)}\n`, 'utf8');
  fs.writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return { outputPath, providerCount: bundle.manifests.length };
}

export function verifyProviderManifestBundle() {
  for (const [relative, value] of projectBailianModule(repositoryRoot).files) {
    if (fs.readFileSync(path.join(repositoryRoot, relative), 'utf8') !== JSON.stringify(value, null, 2) + '\n') {
      throw new Error('generated Bailian module projection is stale: ' + relative);
    }
  }
  const compatibility = JSON.stringify(buildBailianCompatibilityRegistry(), null, 2) + '\n';
  if (!fs.existsSync(compatibilityPath) || fs.readFileSync(compatibilityPath, 'utf8') !== compatibility) {
    throw new Error('generated Bailian compatibility registry is stale; run node scripts/testing/build-provider-manifest-bundle.mjs');
  }
  const expected = `${JSON.stringify(buildProviderManifestBundle(), null, 2)}\n`;
  if (!fs.existsSync(outputPath)) {
    throw new Error(`generated provider manifest bundle is missing: ${path.relative(repositoryRoot, outputPath)}`);
  }
  const actual = fs.readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, '');
  if (actual !== expected) {
    throw new Error('generated provider manifest bundle is stale; run node scripts/testing/build-provider-manifest-bundle.mjs');
  }
  return { outputPath, providerCount: JSON.parse(actual).manifests.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const checkOnly = process.argv.includes('--check');
    const result = checkOnly ? verifyProviderManifestBundle() : writeProviderManifestBundle();
    console.log(
      `provider manifest bundle ${checkOnly ? 'verified' : 'generated'}: ${result.providerCount} -> ${path.relative(repositoryRoot, result.outputPath)}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
