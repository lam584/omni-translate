import fs from 'node:fs';
import path from 'node:path';

export const WATCH_MODE_RUN_COLLECTION_SCHEMA = 'watch-mode-run-collection/v2';
export const WATCH_MODE_RUN_COLLECTION_FILE = 'run-collection.json';
export const WATCH_MODE_RUN_COLLECTION_KIND = 'watch-mode-run-collection';

const topLevelKeys = new Set([
  'schemaVersion', 'artifactKind', 'request', 'collectionStatus', 'steps',
  'ownedProcesses', 'artifacts', 'primaryError', 'cleanupErrors',
]);
const collectionStatuses = new Set(['completed', 'failed']);
const stepStatuses = new Set(['passed', 'failed', 'blocked', 'skipped']);

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function validateRelativeArtifactPath(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty relative path or null`);
  }
  const normalized = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`${label} must stay inside the run directory`);
  }
  return normalized;
}

export function validateWatchModeRunCollection(input) {
  const collection = structuredClone(requireObject(input, 'run collection'));
  const unknownKeys = Object.keys(collection).filter((key) => !topLevelKeys.has(key));
  if (unknownKeys.length > 0) throw new Error(`run collection has unknown fields: ${unknownKeys.join(', ')}`);
  if (collection.schemaVersion !== WATCH_MODE_RUN_COLLECTION_SCHEMA) {
    throw new Error(`schemaVersion must be ${WATCH_MODE_RUN_COLLECTION_SCHEMA}`);
  }
  if (collection.artifactKind !== WATCH_MODE_RUN_COLLECTION_KIND) {
    throw new Error(`artifactKind must be ${WATCH_MODE_RUN_COLLECTION_KIND}`);
  }
  requireObject(collection.request, 'request');
  if (!collectionStatuses.has(collection.collectionStatus)) {
    throw new Error(`collectionStatus must be one of: ${[...collectionStatuses].join(', ')}`);
  }
  if (!Array.isArray(collection.steps)) throw new Error('steps must be an array');
  for (const [index, step] of collection.steps.entries()) {
    requireObject(step, `steps[${index}]`);
    if (!stepStatuses.has(step.status)) throw new Error(`steps[${index}].status is invalid`);
  }
  if (!Array.isArray(collection.ownedProcesses)) throw new Error('ownedProcesses must be an array');
  if (!Array.isArray(collection.cleanupErrors)) throw new Error('cleanupErrors must be an array');
  if (collection.primaryError !== null) requireObject(collection.primaryError, 'primaryError');
  collection.artifacts = requireObject(collection.artifacts, 'artifacts');
  const seenPaths = new Set();
  for (const [name, artifactPath] of Object.entries(collection.artifacts)) {
    const normalized = validateRelativeArtifactPath(artifactPath, `artifacts.${name}`);
    collection.artifacts[name] = normalized;
    if (normalized !== null && seenPaths.has(normalized)) {
      throw new Error(`artifact path is duplicated: ${normalized}`);
    }
    if (normalized !== null) seenPaths.add(normalized);
  }
  return collection;
}

export function readWatchModeRunCollection(runDirectory) {
  const collectionPath = path.join(runDirectory, WATCH_MODE_RUN_COLLECTION_FILE);
  if (!fs.existsSync(collectionPath)) {
    throw new Error(`missing ${WATCH_MODE_RUN_COLLECTION_FILE}: ${collectionPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(collectionPath, 'utf8').replace(/^\uFEFF/, ''));
  return { collection: validateWatchModeRunCollection(parsed), collectionPath };
}

export function writeWatchModeRunCollection(runDirectory, collection) {
  const validated = validateWatchModeRunCollection(collection);
  const collectionPath = path.join(runDirectory, WATCH_MODE_RUN_COLLECTION_FILE);
  fs.writeFileSync(collectionPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  return collectionPath;
}
