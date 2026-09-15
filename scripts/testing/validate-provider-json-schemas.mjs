import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/, ''));
}

function dateFormat(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().startsWith(value);
}

function uriFormat(value) {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol);
  } catch {
    return false;
  }
}

function validationFailure(label, validate) {
  const details = (validate.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
  throw new Error(`provider-json-schema: ${label}: ${details}`);
}

export function validateProviderJsonSchemas() {
  const manifestSchema = readJson('contracts/provider-manifest.schema.json');
  const fixtureSchema = readJson('contracts/provider-wire-fixture.schema.json');
  const bundleSchema = readJson('contracts/provider-manifest-bundle.schema.json');
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat('date', { type: 'string', validate: dateFormat });
  ajv.addFormat('uri', { type: 'string', validate: uriFormat });
  ajv.addSchema(manifestSchema);
  ajv.addSchema(fixtureSchema);
  ajv.addSchema(bundleSchema);

  const validateManifest = ajv.getSchema(manifestSchema.$id);
  const validateFixture = ajv.getSchema(fixtureSchema.$id);
  const validateBundle = ajv.getSchema(bundleSchema.$id);
  if (!validateManifest || !validateFixture || !validateBundle) {
    throw new Error('provider-json-schema: failed to compile provider schemas');
  }

  let manifestCount = 0;
  let fixtureCount = 0;
  const moduleDirectories = fs.readdirSync(path.join(repositoryRoot, 'provider-modules'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const directory of moduleDirectories) {
    const manifestPath = `provider-modules/${directory.name}/manifest.json`;
    const absoluteManifestPath = path.join(repositoryRoot, manifestPath);
    if (!fs.existsSync(absoluteManifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (!validateManifest(manifest)) validationFailure(manifestPath, validateManifest);
    manifestCount += 1;
    for (const fixture of manifest.fixtures) {
      const fixtureDocument = readJson(fixture.path);
      if (!validateFixture(fixtureDocument)) validationFailure(fixture.path, validateFixture);
      fixtureCount += 1;
    }
  }

  const bundlePath = 'contracts/provider-manifests.compiled.v1.json';
  const bundle = readJson(bundlePath);
  if (!validateBundle(bundle)) validationFailure(bundlePath, validateBundle);
  return { manifestCount, fixtureCount };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validateProviderJsonSchemas();
    console.log(`provider JSON schemas validated: ${result.manifestCount} manifests, ${result.fixtureCount} fixtures`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
