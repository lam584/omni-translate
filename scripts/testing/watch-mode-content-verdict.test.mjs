import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareWatchContentText,
  evaluateWatchContentConsistency,
  watchContentCharacterOverlap,
} from './watch-mode-content-verdict.mjs';

test('content overlap is normalized and multiplicity-aware', () => {
  assert.equal(watchContentCharacterOverlap('Hello，世界!', 'hello 世界'), 1);
  assert.equal(watchContentCharacterOverlap('aaaa', 'a'), 1);
});

test('text verdict reports missing and extra clauses from one policy', () => {
  const result = compareWatchContentText('1111. 2222.', '1111. 9999.');
  assert.equal(result.passed, false);
  assert.deepEqual(result.missingClauses, ['2222']);
  assert.deepEqual(result.extraClauses, ['9999']);
});

test('physical content consistency is derived from raw evidence and ignores supplied verdicts', () => {
  const source = 'one two three. four five six.';
  const translation = `${'translated concept sentence. '.repeat(12)}final concept.`;
  const result = evaluateWatchContentConsistency({
    source,
    translation,
    subtitleText: translation,
    sourceReference: { source, translation, passed: true },
    contentConsistency: { passed: false, coverage: 0 },
  });
  assert.equal(result.passed, true);
  assert.equal(result.evidenceSource, 'node-report-v2');
});
