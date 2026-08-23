import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TRACKED_FILE_LIMIT_BYTES = 5 * 1024 * 1024;
export const AUTHORIZED_WATCH_AUDIO_LIMIT_BYTES = 8 * 1024 * 1024;

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

export function loadAuthorizedWatchAudioFixtures({ workspaceRoot = process.cwd() } = {}) {
  const authorized = new Map();
  for (const definition of WATCH_AUDIO_MANIFESTS) {
    const manifestPath = path.join(workspaceRoot, ...definition.manifest.split('/'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
      throw new Error(`${definition.manifest}: fixtures must be a non-empty array`);
    }
    for (const fixture of manifest.fixtures) {
      const audio = normalizeRepositoryPath(String(fixture?.audio ?? ''));
      const sha256 = String(fixture?.sha256 ?? '').toLowerCase();
      if (!/^[^/]+\.wav$/i.test(audio) || !/^[a-f0-9]{64}$/.test(sha256)) {
        throw new Error(`${definition.manifest}: every authorized fixture requires a basename-only WAV path and SHA256`);
      }
      const repositoryPath = path.posix.join(definition.audioRoot, audio);
      if (authorized.has(repositoryPath)) {
        throw new Error(`${definition.manifest}: duplicate authorized fixture ${repositoryPath}`);
      }
      authorized.set(repositoryPath, sha256);
    }
  }
  return authorized;
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
