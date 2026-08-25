import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { repoRoot } from '../lib/testing-common.mjs';
import {
  AUTHORIZED_WATCH_AUDIO_LIMIT_BYTES,
  containsRetiredWorkspacePath,
  DEFAULT_TRACKED_FILE_LIMIT_BYTES,
  EXPECTED_WATCH_AUDIO_FIXTURE_COUNTS,
  loadWatchAudioFixtureInventory,
  sha256File,
  trackedFileSizeViolation,
} from './repository-hygiene-policy.mjs';

const windowsSeparator = String.fromCharCode(92);

test('Watch Mode audio policy keeps 22 recipes, one bundled receipt, and 21 on-demand recipes', () => {
  const { authorized, counts } = loadWatchAudioFixtureInventory({ workspaceRoot: repoRoot });
  assert.deepEqual(counts, EXPECTED_WATCH_AUDIO_FIXTURE_COUNTS);
  assert.deepEqual([...authorized.keys()], [
    'scripts/testing/fixtures/watch-mode-en-original.wav',
  ]);
  for (const [repositoryPath, expectedSha256] of authorized) {
    const absolutePath = path.join(repoRoot, ...repositoryPath.split('/'));
    const size = fs.statSync(absolutePath).size;
    assert.equal(trackedFileSizeViolation(repositoryPath, size, authorized), null);
    assert.ok(size <= AUTHORIZED_WATCH_AUDIO_LIMIT_BYTES);
    assert.equal(sha256File(absolutePath), expectedSha256);
  }
  assert.equal(authorized.has('scripts/testing/fixtures/watch-mode-en-conversation.wav'), false);
  assert.equal(authorized.has('scripts/testing/fixtures/multilingual/watch-mode-general.zh-CN.wav'), false);
});

test('an unlisted tracked file remains limited to 5 MiB', () => {
  const authorized = new Map();
  assert.equal(
    trackedFileSizeViolation('fixtures/unlisted.wav', DEFAULT_TRACKED_FILE_LIMIT_BYTES + 1, authorized),
    'fixtures/unlisted.wav: tracked file exceeds 5 MiB',
  );
});

test('a manifest-bound Watch Mode fixture cannot exceed 8 MiB', () => {
  const repositoryPath = 'scripts/testing/fixtures/watch-mode-en-original.wav';
  const authorized = new Map([[repositoryPath, '0'.repeat(64)]]);
  assert.equal(
    trackedFileSizeViolation(repositoryPath, AUTHORIZED_WATCH_AUDIO_LIMIT_BYTES + 1, authorized),
    `${repositoryPath}: authorized Watch Mode audio fixture exceeds 8 MiB`,
  );
});

test('retired workspace detection covers direct and JSON-escaped Windows paths', () => {
  const retiredRoot = ['E:', windowsSeparator, 'omni-translate'].join('');
  const jsonEscapedRoot = ['E:', windowsSeparator.repeat(2), 'omni-translate'].join('');

  assert.equal(containsRetiredWorkspacePath(`${retiredRoot}${windowsSeparator}scripts`), true);
  assert.equal(containsRetiredWorkspacePath(`{"audio_file":"${jsonEscapedRoot}${windowsSeparator.repeat(2)}sample.wav"}`), true);
  assert.equal(containsRetiredWorkspacePath(retiredRoot.toLowerCase()), true);
});

test('retired workspace detection ignores fictional lookalikes', () => {
  const otherDrive = ['Q:', windowsSeparator, 'omni-translate', windowsSeparator, 'fixture.json'].join('');
  const otherProject = ['E:', windowsSeparator, 'omni-translate-example', windowsSeparator, 'fixture.json'].join('');

  assert.equal(containsRetiredWorkspacePath(otherDrive), false);
  assert.equal(containsRetiredWorkspacePath(otherProject), false);
  assert.equal(containsRetiredWorkspacePath('The fixture uses a synthetic workspace path.'), false);
});
