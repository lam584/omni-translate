import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareWatchContentText,
  evaluateWatchContentConsistency,
  normalizeWatchContentText,
  watchContentCanonicalFinalCueEvidence,
  watchContentCharacterOverlap,
} from './watch-mode-content-verdict.mjs';

test('content overlap is normalized and multiplicity-aware', () => {
  assert.equal(watchContentCharacterOverlap('Hello，世界!', 'hello 世界'), 1);
  assert.equal(watchContentCharacterOverlap('aaaa', 'a'), 1);
});

test('strict content accepts the fixed Daniel reply synonym without relaxing identity or numbers', () => {
  assert.ok(watchContentCharacterOverlap('Daniel回答说', '丹尼尔回复说') >= 0.45);
  assert.deepEqual(compareWatchContentText('Daniel回答说', '丹尼尔回复说').missingClauses, []);

  assert.equal(
    watchContentCharacterOverlap(
      'Daniel回答说，A-17号货物将于下午6点30分出发',
      '丹尼尔回复说，8-17号批次将于下午6点30分出发',
    ),
    0,
  );
  assert.equal(watchContentCharacterOverlap('CPU使用率下降了18%', 'CPU下降80%'), 0);
  assert.equal(watchContentCharacterOverlap('CPU使用率下降了18%', 'CPU下降20%'), 0);

  assert.equal(normalizeWatchContentText('丹尼尔回复说'), '丹尼尔回复说');
  assert.equal(normalizeWatchContentText('项目负责人回复说'), '项目负责人回复说');
  assert.ok(watchContentCharacterOverlap(
    'Daniel回答说计划继续',
    '丹尼尔回复说计划继续',
  ) < 1);
  assert.ok(watchContentCharacterOverlap(
    '项目负责人回答说',
    '项目负责人回复说',
  ) < 1);
});

test('decimal version punctuation remains inside one strict-content clause', () => {
  const reference = '3.6.2版本把平均响应时间从920毫秒降至315毫秒';
  const exactCue = '3.6.2版本，把平均响应时间从920毫秒降至315毫秒。';
  assert.deepEqual(compareWatchContentText(reference, exactCue).missingClauses, []);
  assert.equal(compareWatchContentText(reference, exactCue).passed, true);

  const wrongVersion = compareWatchContentText(
    reference,
    '3.6.5版本，把平均响应时间从920毫秒降至315毫秒。',
  );
  assert.equal(wrongVersion.passed, false);
  assert.deepEqual(wrongVersion.missingClauses, [
    '362版本把平均响应时间从920毫秒降至315毫秒',
  ]);
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

test('canonical final cue evidence narrowly rejoins an adjacent dotted version continuation', () => {
  const reference = '3.6.2版本把平均响应时间从920毫秒降至315毫秒';
  const joined = watchContentCanonicalFinalCueEvidence([
    ' 版本 3.6  ',
    ' .2 平均响应时间从920毫秒降至315毫秒 ',
  ]);
  assert.deepEqual(joined.rawCues, [
    ' 版本 3.6  ',
    ' .2 平均响应时间从920毫秒降至315毫秒 ',
  ]);
  assert.deepEqual(joined.adjacentVersionContinuations, [
    '版本 3.6.2 平均响应时间从920毫秒降至315毫秒',
  ]);
  assert.deepEqual(compareWatchContentText(reference, joined.comparisonText).missingClauses, []);

  const wrongPatch = watchContentCanonicalFinalCueEvidence([
    '版本 3.6',
    '.5 平均响应时间从920毫秒降至315毫秒',
  ]);
  const wrongPatchVerdict = compareWatchContentText(reference, wrongPatch.comparisonText);
  assert.equal(wrongPatchVerdict.passed, false);
  assert.ok(wrongPatchVerdict.missingClauses.includes('362版本把平均响应时间从920毫秒降至315毫秒'));

  const nonAdjacent = watchContentCanonicalFinalCueEvidence([
    '版本 3.6',
    '这是独立文本',
    '.2 平均响应时间从920毫秒降至315毫秒',
  ]);
  assert.deepEqual(nonAdjacent.adjacentVersionContinuations, []);
  const arbitrary = watchContentCanonicalFinalCueEvidence([
    '发布说明 3.6',
    '.2 平均响应时间从920毫秒降至315毫秒',
  ]);
  assert.deepEqual(arbitrary.adjacentVersionContinuations, []);
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
