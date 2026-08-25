import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  WATCH_MODE_RUN_COLLECTION_SCHEMA,
  readWatchModeRunCollection,
  validateWatchModeRunCollection,
  writeWatchModeRunCollection,
} from './watch-mode-run-collection.mjs';

function collection() {
  return {
    schemaVersion: WATCH_MODE_RUN_COLLECTION_SCHEMA,
    artifactKind: 'watch-mode-run-collection',
    request: { schemaVersion: 'watch-mode-run-request/v1' },
    collectionStatus: 'completed',
    steps: [],
    ownedProcesses: [],
    artifacts: {},
    primaryError: null,
    cleanupErrors: [],
  };
}

test('run collection v2 is the only accepted aggregate artifact', () => {
  assert.doesNotThrow(() => validateWatchModeRunCollection(collection()));
  assert.throws(
    () => validateWatchModeRunCollection({ ...collection(), snapshots: {} }),
    /unknown fields: snapshots/,
  );
  assert.throws(
    () => validateWatchModeRunCollection({ ...collection(), schemaVersion: 'watch-mode-run-collection/v1' }),
    /watch-mode-run-collection\/v2/,
  );
});

test('reader does not migrate snapshots, steps, or failure artifacts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-run-collection-'));
  try {
    for (const name of ['snapshots.json', 'steps.json', 'failure.json']) {
      fs.writeFileSync(path.join(directory, name), '{}');
    }
    assert.throws(() => readWatchModeRunCollection(directory), /missing run-collection\.json/);
    writeWatchModeRunCollection(directory, collection());
    assert.equal(readWatchModeRunCollection(directory).collection.collectionStatus, 'completed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('artifact inventory rejects duplicate and escaping paths without legacy migration', () => {
  assert.throws(
    () => validateWatchModeRunCollection({ ...collection(), artifacts: { appLog: '../app.log' } }),
    /stay inside the run directory/,
  );
  assert.throws(
    () => validateWatchModeRunCollection({ ...collection(), artifacts: { appLog: 'app.log', copy: 'app.log' } }),
    /duplicated/,
  );
});
