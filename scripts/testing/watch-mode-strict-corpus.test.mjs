import assert from 'node:assert/strict';
import test from 'node:test';

import { STRICT_EN_ZH_CORPUS } from './watch-mode-provider-preflight-authority.mjs';

const normalize = (value) => value
  .toLowerCase()
  .replace(/[.?!,;:]+/gu, '')
  .replace(/\s+/gu, ' ')
  .trim();

test('strict paid corpus keeps version and latency requirements without a compositional overlap', () => {
  const entries = Object.entries(STRICT_EN_ZH_CORPUS);
  const version = entries.find(([source]) => normalize(source) === 'version 362');
  const latency = entries.find(([source]) => (
    normalize(source) === 'reduced average response time from 920 milliseconds to 315 milliseconds'
  ));

  assert.deepEqual(version, ['Version 3.6.2', '3.6.2版本']);
  assert.deepEqual(latency, [
    'reduced average response time from 920 milliseconds to 315 milliseconds',
    '把平均响应时间从920毫秒降至315毫秒',
  ]);

  const versionSource = normalize(version[0]);
  const latencySource = normalize(latency[0]);
  const overlappingCompounds = entries.filter(([source]) => {
    const normalized = normalize(source);
    return normalized !== versionSource
      && normalized !== latencySource
      && normalized.includes(versionSource)
      && normalized.includes(latencySource);
  });

  assert.deepEqual(
    overlappingCompounds,
    [],
    'a compound version+latency hint can make an isolated “Point two” expand beyond its cue',
  );
});
