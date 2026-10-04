import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNativePumpDecisionReceipt, PUMP_DECISION_KEYS} from './local-aec-pump-decision-receipt.mjs';
import {nativePumpDecisionFixture} from './fixtures/local-aec-pump-decision-receipt.mjs';
const identity = {renderSessionId:1, ownerGeneration:2, endpointId:'endpoint', rendererInstanceId:'renderer'};
const inspect = r => validateNativePumpDecisionReceipt(r, identity);
test('all 11 decision keys and diagnostic-only authority remain fixed', () => {
  const r = inspect(nativePumpDecisionFixture(identity)); assert.equal(PUMP_DECISION_KEYS.length, 11);
  assert.equal(r.valid, true); assert.equal(r.knownUnderrunDecisionCount, 0);
  assert.equal(r.qualityAcceptance, false); assert.equal(r.releaseEligible, false); assert.equal(r.diagnosticOnly, true);
});
test('early underrun survives complete recent eviction and remains stage attributable', () => {
  const rows = [{decision:'underrun', paddingFrames:0, stageIndex:1},
    ...Array.from({length:1024}, () => ({decision:'device-full', stageIndex:2}))];
  const receipt = nativePumpDecisionFixture(identity, rows), r = inspect(receipt);
  assert.equal(receipt.recentObservations.some(x => x.decision === 'underrun'), false);
  assert.equal(r.valid, true); assert.equal(r.knownUnderrunDecisionCount, 1);
  assert.deepEqual(r.stageKnownUnderrunDecisionCounts, [0, 1, 0]); assert.equal(r.evictedRecentDecisionCount, 513);
  assert.equal(r.qualityAcceptance, false);
});
test('zero padding at startup, transition and physical drain is not an underrun decision', () => {
  const receipt = nativePumpDecisionFixture(identity, [
    {decision:'startup-buffering', paddingFrames:null, started:false, stageIndex:0, paddingQpc100ns:null},
    {decision:'stage-transition', paddingFrames:0, stageIndex:0},
    {decision:'physical-drained', paddingFrames:0, stageIndex:2},
    {decision:'device-full', paddingFrames:0, stageIndex:99},
  ]);
  const r = inspect(receipt); assert.equal(r.valid, true); assert.equal(r.knownUnderrunDecisionCount, 0);
  assert.equal(r.otherStageDecisionCount, 1);
});
test('all decisions sum across all fixed stages and explicit other bucket', () => {
  const rows = Array.from({length:4}, (_, stageIndex) => PUMP_DECISION_KEYS.map(decision => ({decision, stageIndex,
    paddingFrames:decision === 'underrun' ? 0 : 480}))).flat();
  const r = inspect(nativePumpDecisionFixture(identity, rows)); assert.equal(r.valid, true);
  assert.equal(r.observedDecisionCount, 44); assert.equal(r.knownUnderrunDecisionCount, 4);
});
const mutations = [
  ['missing full-run evidence', r => {delete r.fullRunDecisionCounts;}],
  ['legacy empty counters', r => {r.fullRunDecisionCounts = null;}],
  ['foreign session', r => {r.renderSessionId += 1;}],
  ['foreign owner', r => {r.ownerGeneration += 1;}],
  ['foreign endpoint', r => {r.endpointId = 'other';}],
  ['foreign renderer', r => {r.rendererInstanceId = 'other';}],
  ['parent quality authority', r => {r.qualityAcceptance = true;}],
  ['parent release authority', r => {r.releaseEligible = true;}],
  ['non-diagnostic parent', r => {r.diagnosticOnly = false;}],
  ['full-run unknown quality flag', r => {r.fullRunDecisionCounts.qualityAcceptance = true;}],
  ['counter overflow', r => {r.fullRunDecisionCounts.counterOverflowed = true;}],
  ['wrong coverage claim', r => {r.fullRunDecisionCounts.coverage = 'physical-output-verified';}],
  ['unknown full-run version', r => {r.fullRunDecisionCounts.schemaVersion = 2;}],
  ['negative counter', r => {r.fullRunDecisionCounts.decisionCounts.underrun = -1;}],
  ['fractional counter', r => {r.fullRunDecisionCounts.decisionCounts.underrun = 0.1;}],
  ['unsafe counter', r => {r.fullRunDecisionCounts.decisionCounts.underrun = Number.MAX_SAFE_INTEGER + 1;}],
  ['numeric string counter', r => {r.fullRunDecisionCounts.decisionCounts.underrun = '0';}],
  ['missing decision key', r => {delete r.fullRunDecisionCounts.decisionCounts.underrun;}],
  ['extra decision key', r => {r.fullRunDecisionCounts.decisionCounts.unknown = 0;}],
  ['wrong overall sum', r => {r.fullRunDecisionCounts.observedDecisionCount += 1;}],
  ['legacy/full total disagreement', r => {r.observedPollCount += 1;}],
  ['stage/global disagreement', r => {r.fullRunDecisionCounts.stages[2].decisionCounts['physical-drained'] = 0;}],
  ['missing stage', r => {r.fullRunDecisionCounts.stages.pop();}],
  ['duplicate stage identity', r => {r.fullRunDecisionCounts.stages[1].stageIndex = 0;}],
  ['zero-padding exceeds decision count', r => {r.fullRunDecisionCounts.zeroPaddingDecisionCounts.underrun = 1;}],
  ['wrong retention limit', r => {r.retainedObservationLimit = 1000;}],
  ['wrong eviction count', r => {r.evictedOldDiagnosticObservations = 1;}],
  ['dropped recent row', r => {r.recentObservations.pop();}],
  ['duplicate/replayed sequence', r => {r.recentObservations[0].sequence = 4;}],
  ['invalid QPC hidden', r => {r.recentObservations[0].paddingQpc100ns = null;}],
  ['padding overflow', r => {r.recentObservations[0].paddingFrames = 961;}],
  ['invented stage counter', r => {r.recentObservations[0].stageIndex = 1;}],
  ['invented underrun identity', r => {r.recentObservations[0].decision = 'underrun';}],
  ['negative buffer', r => {r.recentObservations[0].bufferFrames = -1;}],
  ['unavailable source QPC disguised as string', r => {r.recentObservations[0].paddingQpc100ns = '1';}],
  ['recent status disguised as string', r => {r.recentObservations[0].started = 'true';}],
];
for (const [name, mutate] of mutations) test('reject ' + name, () => {
  const r = nativePumpDecisionFixture(identity); mutate(r); const result = inspect(r);
  assert.equal(result.valid, false); assert.equal(result.qualityAcceptance, false); assert.equal(result.releaseEligible, false);
  assert.ok(result.failures.length > 0);
});
test('safe individual counters whose sum overflows are rejected, never rounded to acceptance', () => {
  const r = nativePumpDecisionFixture(identity), full = r.fullRunDecisionCounts;
  full.observedDecisionCount = Number.MAX_SAFE_INTEGER; r.observedPollCount = Number.MAX_SAFE_INTEGER;
  full.decisionCounts['startup-buffering'] = Number.MAX_SAFE_INTEGER;
  full.decisionCounts['physical-drained'] = 1;
  assert.equal(inspect(r).valid, false);
});
test('recent-only legacy report cannot meet the new full-run contract', () => {
  const r = nativePumpDecisionFixture(identity); delete r.fullRunDecisionCounts;
  assert.match(inspect(r).failures[0], /exact fields/u);
});

test('supported 257-frame device truthfully records unclamped 480-frame no-write demand', () => {
  const r = nativePumpDecisionFixture(identity, [{decision:'device-full', bufferFrames:257,
    paddingFrames:257, requestedFrames:480, stageIndex:1}]);
  assert.equal(inspect(r).valid, true);
});
test('257-frame device actual write admissions remain clamped to capacity', () => {
  const r = nativePumpDecisionFixture(identity, [{decision:'write-requested', bufferFrames:257,
    paddingFrames:0, requestedFrames:257, stageIndex:1}]);
  assert.equal(inspect(r).valid, true);
  const invalid = nativePumpDecisionFixture(identity, [{decision:'write-requested', bufferFrames:257,
    paddingFrames:0, requestedFrames:480, stageIndex:1}]);
  assert.equal(inspect(invalid).valid, false);
});
test('raw no-write demand cannot exceed the unchanged 480-frame pump block', () => {
  const r = nativePumpDecisionFixture(identity, [{decision:'device-full', bufferFrames:257,
    paddingFrames:257, requestedFrames:481, stageIndex:1}]);
  assert.equal(inspect(r).valid, false);
});
