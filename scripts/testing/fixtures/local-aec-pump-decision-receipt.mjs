// Unit-test fixture only; never hardware evidence or an acceptance receipt.
import {PUMP_DECISION_KEYS} from '../local-aec-pump-decision-receipt.mjs';
const counts = () => Object.fromEntries(PUMP_DECISION_KEYS.map(k => [k, 0]));
const bucket = () => ({observedDecisionCount:0, decisionCounts:counts(), zeroPaddingDecisionCounts:counts()});
export function nativePumpDecisionFixture(identity, input = [{decision:'physical-drained', paddingFrames:0, stageIndex:2}]) {
  const full = {schemaVersion:1, coverage:'all-recorded-decisions-before-recent-eviction', counterOverflowed:false,
    ...bucket(), stages:[0, 1, 2].map(stageIndex => ({stageIndex, ...bucket()})), otherStage:bucket()};
  const rows = input.map((fields, sequence) => ({sequence, paddingQpc100ns:sequence + 1, bufferFrames:960,
    paddingFrames:480, referenceBufferedFrames:0, pendingPrefixFrames:0, submittedFrames:960,
    requestedFrames:0, started:true, ended:true, stageIndex:0, decision:'device-full', ...fields}));
  for (const row of rows) {
    for (const b of [full, full.stages[row.stageIndex] ?? full.otherStage]) {
      b.observedDecisionCount += 1; b.decisionCounts[row.decision] += 1;
      if (row.paddingFrames === 0) b.zeroPaddingDecisionCounts[row.decision] += 1;
    }
  }
  return {schemaVersion:1, artifactKind:'native-desktop-pump-decision-diagnostic', diagnosticOnly:true,
    qualityAcceptance:false, releaseEligible:false, retainedObservationLimit:512, observedPollCount:rows.length,
    evictedOldDiagnosticObservations:Math.max(0, rows.length - 512),
    invalidQpcObservations:rows.filter(r => r.paddingQpc100ns === null || r.paddingQpc100ns === 0).length,
    sampleRateHz:48000, samePaddingSampleAsDecision:true, writeRequestedIsNotPhysicalOutput:true,
    recentObservations:rows.slice(-512), fullRunDecisionCounts:full, ...identity};
}
