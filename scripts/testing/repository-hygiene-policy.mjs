import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TRACKED_FILE_LIMIT_BYTES = 5 * 1024 * 1024;
export const AUTHORIZED_WATCH_AUDIO_LIMIT_BYTES = 8 * 1024 * 1024;
export const EXPECTED_WATCH_AUDIO_FIXTURE_COUNTS = Object.freeze({
  total: 22,
  bundled: 1,
  generatedOnDemand: 21,
});
const WATCH_AUDIO_DISTRIBUTIONS = new Set(['bundled', 'generated-on-demand']);
const WATCH_AUDIO_RECEIPT_FIELDS = Object.freeze([
  'sha256',
  'durationSeconds',
  'sampleRate',
  'channels',
  'bitsPerSample',
]);

const WATCH_AUDIO_MANIFESTS = Object.freeze([
  Object.freeze({
    manifest: 'scripts/testing/fixtures/watch-mode-audio-fixtures.json',
    audioRoot: 'scripts/testing/fixtures',
  }),
  Object.freeze({
    manifest: 'scripts/testing/fixtures/multilingual/manifest.json',
    audioRoot: 'scripts/testing/fixtures/multilingual',
  }),
]);

const normalizeRepositoryPath = (value) => value.replace(/\\/g, '/');

export function containsRetiredWorkspacePath(content) {
  return /(?:^|[^A-Za-z0-9])E:\\+omni-translate(?=$|[\\/"'\s])/iu.test(content);
}

export function loadWatchAudioFixtureInventory({ workspaceRoot = process.cwd() } = {}) {
  const authorized = new Map();
  const counts = { total: 0, bundled: 0, generatedOnDemand: 0 };
  for (const definition of WATCH_AUDIO_MANIFESTS) {
    const manifestPath = path.join(workspaceRoot, ...definition.manifest.split('/'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
      throw new Error(`${definition.manifest}: fixtures must be a non-empty array`);
    }
    for (const fixture of manifest.fixtures) {
      const distribution = String(fixture?.distribution ?? manifest.audioDistribution ?? '');
      const audio = normalizeRepositoryPath(String(fixture?.audio ?? ''));
      const sha256 = String(fixture?.sha256 ?? '').toLowerCase();
      if (!WATCH_AUDIO_DISTRIBUTIONS.has(distribution)) {
        throw new Error(`${definition.manifest}: every fixture requires a supported distribution`);
      }
      if (!/^[^/]+\.wav$/i.test(audio)) {
        throw new Error(`${definition.manifest}: every fixture requires a basename-only WAV path`);
      }
      counts.total += 1;
      if (distribution === 'generated-on-demand') {
        counts.generatedOnDemand += 1;
        const receiptFields = WATCH_AUDIO_RECEIPT_FIELDS.filter((field) => Object.hasOwn(fixture, field));
        if (receiptFields.length > 0) {
          throw new Error(
            `${definition.manifest}: generated-on-demand fixture ${audio} must not store receipt fields: ${receiptFields.join(', ')}`,
          );
        }
        const missingRecipeFields = ['source', 'model', 'voice']
          .filter((field) => typeof fixture?.[field] !== 'string' || fixture[field].trim() === '');
        if (missingRecipeFields.length > 0) {
          throw new Error(
            `${definition.manifest}: generated-on-demand fixture ${audio} is missing recipe fields: ${missingRecipeFields.join(', ')}`,
          );
        }
        continue;
      }
      counts.bundled += 1;
      if (!/^[a-f0-9]{64}$/.test(sha256)) {
        throw new Error(`${definition.manifest}: bundled fixture ${audio} requires a SHA256 receipt`);
      }
      const repositoryPath = path.posix.join(definition.audioRoot, audio);
      if (authorized.has(repositoryPath)) {
        throw new Error(`${definition.manifest}: duplicate authorized fixture ${repositoryPath}`);
      }
      authorized.set(repositoryPath, sha256);
    }
  }
  for (const [key, expected] of Object.entries(EXPECTED_WATCH_AUDIO_FIXTURE_COUNTS)) {
    if (counts[key] !== expected) {
      throw new Error(`Watch Mode audio fixture invariant failed: expected ${key}=${expected}, received ${counts[key]}`);
    }
  }
  return { authorized, counts };
}

export function loadAuthorizedWatchAudioFixtures(options) {
  return loadWatchAudioFixtureInventory(options).authorized;
}

export function trackedFileSizeViolation(file, size, authorizedWatchAudio) {
  if (size <= DEFAULT_TRACKED_FILE_LIMIT_BYTES) return null;
  if (!authorizedWatchAudio.has(file)) return `${file}: tracked file exceeds 5 MiB`;
  if (size > AUTHORIZED_WATCH_AUDIO_LIMIT_BYTES) {
    return `${file}: authorized Watch Mode audio fixture exceeds 8 MiB`;
  }
  return null;
}

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
