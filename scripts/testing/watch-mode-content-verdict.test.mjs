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

test('content overlap treats equivalent Chinese and Arabic numerals as equal without losing value or order', () => {
  const reference = '它能区分十五与五十，或者十三与三十吗';
  assert.equal(watchContentCharacterOverlap('十五', '15'), 1);
  assert.ok(watchContentCharacterOverlap(reference, '它能否区分15和50，或13和30吗') >= 0.45);
  assert.equal(
    watchContentCharacterOverlap(reference, '它能否区分50和15，或30和13吗'),
    0,
  );
  assert.equal(
    watchContentCharacterOverlap('十五与五十，十三与三十', '五十与十五，三十与十三'),
    0,
  );
  assert.equal(
    watchContentCharacterOverlap('十五与五十，十三与三十', '15与50，13与30'),
    1,
  );
  assert.equal(watchContentCharacterOverlap('十五', '50'), 0);
  assert.deepEqual(
    compareWatchContentText(reference, '它能否区分15和50，或13和30吗').missingClauses,
    [],
  );
  assert.deepEqual(
    compareWatchContentText(reference, '它能否区分50和15，或30和13吗').missingClauses,
    ['它能区分十五与五十', '或者十三与三十吗'],
  );
  assert.ok(watchContentCharacterOverlap('这个结果十分稳定', '这个结果非常稳定') > 0.7);
  assert.ok(watchContentCharacterOverlap('第2版已经修复主要问题', '新版已经修复主要问题') > 0.7);
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
