import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertExactReleaseProvenance,
  captureCleanReleaseProvenance,
} from '../lib/release-common.mjs';

const runGit = (root, args) => execFileSync('git', args, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

test('stable release provenance captures exact clean HEAD and rejects dirty source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-release-provenance-'));
  runGit(root, ['init']);
  runGit(root, ['config', 'user.email', 'release-test@example.test']);
  runGit(root, ['config', 'user.name', 'Omni Release Test']);
  fs.writeFileSync(path.join(root, 'source.txt'), 'release source\n', 'utf8');
  runGit(root, ['add', 'source.txt']);
  runGit(root, ['commit', '-m', 'release source']);

  const provenance = captureCleanReleaseProvenance(root);
  assert.match(provenance.headCommit, /^[a-f0-9]{40}$/);
  assert.equal(provenance.worktreeClean, true);
  assert.equal(provenance.dirtyEntryCount, 0);
  assert.deepEqual(assertExactReleaseProvenance(provenance, provenance), provenance);

  fs.writeFileSync(path.join(root, 'dirty.txt'), 'not releasable\n', 'utf8');
  assert.throws(() => captureCleanReleaseProvenance(root), /require a clean worktree/);
});

test('release provenance rejects an old or self-reported clean commit', () => {
  const current = {
    schemaVersion: 1,
    source: 'git',
    captureStatus: 'captured',
    headCommit: 'a'.repeat(40),
    worktreeClean: true,
    dirtyEntryCount: 0,
  };
  assert.throws(() => assertExactReleaseProvenance({
    ...current,
    headCommit: 'b'.repeat(40),
  }, current, 'signed package'), /exact current clean HEAD/);
  assert.throws(() => assertExactReleaseProvenance({
    ...current,
    worktreeClean: false,
    dirtyEntryCount: 1,
  }, current, 'signed package'), /exact current clean HEAD/);
});
