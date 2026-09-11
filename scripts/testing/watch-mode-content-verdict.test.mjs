import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  compareWatchContentText,
  canonicalizeWatchContentCues,
  evaluateLayeredWatchContent,
  evaluateWatchContentConsistency,
  normalizeWatchContentText,
  uniqueWatchContentEvidence,
  watchContentCanonicalFinalCueEvidence,
  watchContentCharacterOverlap,
} from './watch-mode-content-verdict.mjs';

const retainedFacts = JSON.parse(fs.readFileSync(
  new URL('./fixtures/watch-mode-content-facts.json', import.meta.url),
  'utf8',
)).facts;

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

test('canonical final cue evidence removes a duplicated .2 patch after an already complete audited version', () => {
  const reference = '3.6.2版本把平均响应时间从920毫秒降至315毫秒';
  const duplicatedPatch = watchContentCanonicalFinalCueEvidence([
    '最后一个主题是软件，3.6.2版本。',
    '.2 把平均响应时间从920毫秒降至315毫秒。',
  ]);
  assert.deepEqual(duplicatedPatch.adjacentVersionContinuations, [
    '3.6.2版本把平均响应时间从920毫秒降至315毫秒。',
  ]);
  assert.deepEqual(compareWatchContentText(reference, duplicatedPatch.comparisonText).missingClauses, []);

  const wrongVersion = watchContentCanonicalFinalCueEvidence([
    '最后一个主题是软件，3.6.5版本。',
    '.2 把平均响应时间从920毫秒降至315毫秒。',
  ]);
  assert.deepEqual(wrongVersion.adjacentVersionContinuations, []);
  assert.equal(compareWatchContentText(reference, wrongVersion.comparisonText).passed, false);

  const wrongNumbers = watchContentCanonicalFinalCueEvidence([
    '最后一个主题是软件，3.6.2版本。',
    '.2 把平均响应时间从920毫秒降至351毫秒。',
  ]);
  assert.equal(compareWatchContentText(reference, wrongNumbers.comparisonText).passed, false);

  const nonAdjacent = watchContentCanonicalFinalCueEvidence([
    '最后一个主题是软件，3.6.2版本。',
    '这是另一条final cue。',
    '.2 把平均响应时间从920毫秒降至315毫秒。',
  ]);
  assert.deepEqual(nonAdjacent.adjacentVersionContinuations, []);

  const crossSourceEvidence = uniqueWatchContentEvidence([
    '最后一个主题是软件，3.6.2版本。',
    '.2 把平均响应时间从920毫秒降至315毫秒。',
  ]);
  assert.equal(compareWatchContentText(reference, crossSourceEvidence).passed, false);
});

test('canonical final cue evidence narrowly rejoins the audited adjacent 第二点 continuation', () => {
  const reference = '3.6.2版本把平均响应时间从920毫秒降至315毫秒';
  const actualAdjacentCues = watchContentCanonicalFinalCueEvidence([
    '最后一个话题是软件，3.6.2版本。',
    '第二点，把平均响应时间从920毫秒降至315毫秒。',
  ]);
  assert.deepEqual(actualAdjacentCues.adjacentVersionContinuations, [
    '3.6.2版本把平均响应时间从920毫秒降至315毫秒。',
  ]);
  assert.deepEqual(
    compareWatchContentText(reference, actualAdjacentCues.comparisonText).missingClauses,
    [],
  );

  const rejectedPairs = [
    ['最后一个话题是软件，3.6.5版本。', '第二点，把平均响应时间从920毫秒降至315毫秒。'],
    ['最后一个话题是软件，3.6.2版本。', '第二点，把平均响应时间从920毫秒降至351毫秒。'],
    ['最后一个话题是软件，3.6.2版本。', '第二点，把平均响应时间从820毫秒降至315毫秒。'],
    ['最后一个话题是软件，3.6.2版本。', '第二点，任意其他内容。'],
  ];
  for (const pair of rejectedPairs) {
    const evidence = watchContentCanonicalFinalCueEvidence(pair);
    assert.deepEqual(evidence.adjacentVersionContinuations, []);
    assert.equal(compareWatchContentText(reference, evidence.comparisonText).passed, false);
  }

  const nonAdjacent = watchContentCanonicalFinalCueEvidence([
    '最后一个话题是软件，3.6.2版本。',
    '这是无关的相邻final cue。',
    '第二点，把平均响应时间从920毫秒降至315毫秒。',
  ]);
  assert.deepEqual(nonAdjacent.adjacentVersionContinuations, []);
  assert.equal(compareWatchContentText(reference, nonAdjacent.comparisonText).passed, false);
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

test('layered content accepts formatting, segmentation, synonyms, and Chinese/Arabic number forms', () => {
  const facts = [
    { id: 'delivery.count', category: 'number-unit', accepted: ['1250台', '一千二百五十台'] },
    { id: 'delivery.condition', category: 'condition', accepted: ['如果时间表有变', '若日程发生变化'] },
    { id: 'meeting.datetime', category: 'date-time', accepted: ['9月17日周二上午8点45分', '周二上午8点45分9月17日'] },
  ];
  const result = evaluateLayeredWatchContent({
    referenceText: '9月17日周二上午8点45分。若日程发生变化，交付一千二百五十台设备。',
    outputText: '周二上午8点45分，9月17日。\n如果时间表有变，将交付1250台设备。',
    facts,
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.dimensions.expressionForm.status, 'diagnostic');
});

test('retained facts accept scoped temperature units and common schedule wording', () => {
  const outputText = [
    '室外温度从21摄氏度降至零下4度，但每个传感器都保持在线状态。',
    '他要求团队向support@example.com发送邮件，如果行程有变。',
    '它能区分15和50，或13和30吗？',
  ].join('');
  const selectedFacts = retainedFacts.filter((fact) => [
    'temperature.range',
    'temperature.sensor-online',
    'shipment.condition',
    'numeric.contrast-pairs',
  ].includes(fact.id));
  const result = evaluateLayeredWatchContent({ referenceText: 'audited fixture', outputText, facts: selectedFacts });
  assert.equal(result.status, 'passed');
});

test('retained facts reject sensor substitution and a broken thirteen-to-thirty relation', () => {
  const selectedFacts = retainedFacts.filter((fact) => [
    'temperature.sensor-online',
    'numeric.contrast-pairs',
  ].includes(fact.id));
  for (const [outputText, factId] of [
    ['室外温度下降，但每一个答案一直在线。它能区分15和50，或13和30吗？', 'temperature.sensor-online'],
    ['所有传感器始终在线。它能区分十五和五十，或者十三？从三十开始。', 'numeric.contrast-pairs'],
  ]) {
    const result = evaluateLayeredWatchContent({ referenceText: 'audited fixture', outputText, facts: selectedFacts });
    assert.equal(result.status, 'failed');
    assert.ok(result.dimensions.facts.some((fact) => fact.factId === factId && fact.status === 'failed'));
  }
});

test('layered content rejects retained factual substitutions and omissions', () => {
  const rejected = [
    ['潜艇，额定功率为72.5千瓦时', 'prototype.solar-battery'],
    ['运输距离为800英里，联系support@example.com。', 'shipment.distance'],
    ['运输距离为842英里，联系support@google.com。', 'shipment.email'],
    ['即使日程没有变化也交付。', 'shipment.condition'],
    ['软件为3.6.5版本。', 'software.version'],
    ['太阳能电池额定72.5千瓦时，运输842英里，联系support@example.com，如果时间表有变，软件3.6.2版本，从920毫秒降至315毫秒，9月17日周二上午8点45分。', 'temperature.range'],
  ];
  for (const [outputText, factId] of rejected) {
    const result = evaluateLayeredWatchContent({ referenceText: 'audited fixture', outputText, facts: retainedFacts });
    assert.equal(result.status, 'failed');
    assert.ok(result.dimensions.facts.some((fact) => fact.factId === factId && fact.status === 'failed'));
  }
});

test('typed fact matching does not collide with longer numbers or version sequences', () => {
  const result = evaluateLayeredWatchContent({
    referenceText: 'audited fixture',
    outputText: '运输距离为1800英里，软件为13.6.20版本。',
    facts: [
      { id: 'distance', category: 'number-unit', accepted: ['1800英里'], forbidden: ['800英里'] },
      { id: 'version', category: 'version', accepted: ['13.6.20版本'], forbidden: ['3.6.2版本'] },
    ],
  });
  assert.equal(result.status, 'passed');
});

test('scoped fact relations reject correct tokens attached to unrelated propositions', () => {
  const result = evaluateLayeredWatchContent({
    referenceText: 'audited fixture',
    outputText: '潜艇使用普通电池。另一个太阳能电池额定20千瓦时。系统日志单独出现72.5千瓦时。',
    facts: [{
      id: 'prototype.capacity-relation',
      category: 'number-unit',
      accepted: ['72.5千瓦时'],
      relation: {
        category: 'number-unit',
        windowClauses: 1,
        groups: [['太阳能电池'], ['72.5千瓦时', '72.5kWh']],
      },
    }],
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.dimensions.facts.some((fact) => fact.factId === 'prototype.capacity-relation'
    && fact.status === 'failed' && fact.relationMatched === false));
});

test('cue canonicalization excludes superseded revisions and preserves cross-cue repetition', () => {
  const cues = [
    { cueId: 'a', revision: 1, text: '错误旧稿', translationState: 'superseded', sequence: 1 },
    { cueId: 'a', revision: 2, text: '太阳能电池', sequence: 2 },
    { cueId: 'b', revision: 1, text: '平均响应时间从920毫秒降至315毫秒', sequence: 3 },
    { cueId: 'c', revision: 1, text: '平均响应时间从920毫秒降至315毫秒', sequence: 4 },
  ];
  assert.deepEqual(canonicalizeWatchContentCues(cues).map((cue) => cue.text), [
    '太阳能电池',
    '平均响应时间从920毫秒降至315毫秒',
    '平均响应时间从920毫秒降至315毫秒',
  ]);
  const result = evaluateLayeredWatchContent({
    referenceText: '太阳能电池。平均响应时间从920毫秒降至315毫秒。',
    cues,
    facts: [
      { id: 'entity', accepted: ['太阳能电池'] },
      { id: 'latency', accepted: ['从920毫秒降至315毫秒'] },
    ],
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.dimensions.crossCueRepetition.repetitions.length, 1);
});

test('missing deferred facts produce inconclusive rather than pass', () => {
  const result = evaluateLayeredWatchContent({
    referenceText: '后续会给出温度。',
    outputText: '仍在流式处理中。',
    facts: [{ id: 'temperature', accepted: ['21摄氏度'], deferMissing: true }],
  });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.passed, false);
});
