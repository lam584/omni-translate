// Counters cover recorded pump decisions, not independent physical-output proof.
// Validating this diagnostic never grants source-clock/acoustic/release authority.
export const PUMP_DECISION_KEYS = Object.freeze(['startup-buffering', 'stage-draining', 'stage-transition',
  'write-requested', 'write-accepted', 'start-requested', 'device-full', 'awaiting-reference-block',
  'physical-draining', 'physical-drained', 'underrun']);
const safe = n => Number.isSafeInteger(n) && n >= 0;
const plain = o => o !== null && typeof o === 'object' && !Array.isArray(o)
  && Object.getPrototypeOf(o) === Object.prototype;
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
function keys(o, expected, label) {
  requireValue(plain(o) && Reflect.ownKeys(o).length === expected.length
    && expected.every(k => Object.hasOwn(o, k)), label + ' exact fields required');
}
function map(o, label) {
  keys(o, PUMP_DECISION_KEYS, label);
  for (const k of PUMP_DECISION_KEYS) requireValue(safe(o[k]), label + ' unsafe/negative count: ' + k);
}
const total = o => PUMP_DECISION_KEYS.reduce((n, k) => n + BigInt(o[k]), 0n);
function bucket(o, label, stageIndex) {
  keys(o, stageIndex === undefined ? ['observedDecisionCount', 'decisionCounts', 'zeroPaddingDecisionCounts']
    : ['stageIndex', 'observedDecisionCount', 'decisionCounts', 'zeroPaddingDecisionCounts'], label);
  if (stageIndex !== undefined) requireValue(o.stageIndex === stageIndex, label + ' stage index/order mismatch');
  requireValue(safe(o.observedDecisionCount), label + ' unsafe observed count');
  map(o.decisionCounts, label + ' decisions'); map(o.zeroPaddingDecisionCounts, label + ' zero padding');
  requireValue(total(o.decisionCounts) === BigInt(o.observedDecisionCount), label + ' decision sum mismatch');
  for (const k of PUMP_DECISION_KEYS) requireValue(o.zeroPaddingDecisionCounts[k] <= o.decisionCounts[k], label + ' zero-padding subset mismatch');
}
const emptyMap = () => Object.fromEntries(PUMP_DECISION_KEYS.map(k => [k, 0]));
/** New evidence is mandatory. A legacy receipt remains diagnostic custody only. */
export function validateNativePumpDecisionReceipt(receipt, identity) {
  try {
    keys(receipt, ['schemaVersion', 'artifactKind', 'diagnosticOnly', 'qualityAcceptance', 'releaseEligible',
      'retainedObservationLimit', 'observedPollCount', 'evictedOldDiagnosticObservations', 'invalidQpcObservations',
      'sampleRateHz', 'samePaddingSampleAsDecision', 'writeRequestedIsNotPhysicalOutput', 'recentObservations',
      'fullRunDecisionCounts', 'renderSessionId', 'ownerGeneration', 'endpointId', 'rendererInstanceId'], 'pump receipt');
    requireValue(receipt.schemaVersion === 1 && receipt.artifactKind === 'native-desktop-pump-decision-diagnostic'
      && receipt.diagnosticOnly === true && receipt.qualityAcceptance === false && receipt.releaseEligible === false,
    'pump diagnostic authority/version mismatch');
    for (const k of ['renderSessionId', 'ownerGeneration']) requireValue(safe(identity?.[k]) && identity[k] > 0
      && receipt[k] === identity[k], 'pump owner/session binding mismatch: ' + k);
    for (const k of ['endpointId', 'rendererInstanceId']) requireValue(typeof identity?.[k] === 'string'
      && identity[k].trim().length > 0 && receipt[k] === identity[k], 'pump endpoint/renderer binding mismatch: ' + k);
    requireValue(receipt.retainedObservationLimit === 512 && receipt.sampleRateHz === 48000
      && receipt.samePaddingSampleAsDecision === true && receipt.writeRequestedIsNotPhysicalOutput === true,
    'pump retention/rate/observation contract mismatch');
    requireValue(safe(receipt.observedPollCount) && receipt.observedPollCount > 0
      && safe(receipt.evictedOldDiagnosticObservations) && safe(receipt.invalidQpcObservations)
      && receipt.invalidQpcObservations <= receipt.observedPollCount, 'pump unsafe/empty counts');
    const full = receipt.fullRunDecisionCounts;
    keys(full, ['schemaVersion', 'coverage', 'counterOverflowed', 'observedDecisionCount', 'decisionCounts',
      'zeroPaddingDecisionCounts', 'stages', 'otherStage'], 'full-run counters');
    requireValue(full.schemaVersion === 1 && full.coverage === 'all-recorded-decisions-before-recent-eviction'
      && full.counterOverflowed === false, 'full-run coverage/version/overflow indeterminate');
    bucket({observedDecisionCount:full.observedDecisionCount, decisionCounts:full.decisionCounts,
      zeroPaddingDecisionCounts:full.zeroPaddingDecisionCounts}, 'full-run');
    requireValue(full.observedDecisionCount === receipt.observedPollCount, 'full-run/legacy total mismatch');
    requireValue(Array.isArray(full.stages) && full.stages.length === 3, 'three fixed stage buckets required');
    full.stages.forEach((s, i) => bucket(s, 'stage ' + i, i)); bucket(full.otherStage, 'other stage');
    const buckets = [...full.stages, full.otherStage];
    for (const field of ['decisionCounts', 'zeroPaddingDecisionCounts']) for (const k of PUMP_DECISION_KEYS) {
      requireValue(buckets.reduce((n, s) => n + BigInt(s[field][k]), 0n) === BigInt(full[field][k]),
        'stage/global sum mismatch: ' + field + ':' + k);
    }
    requireValue(Array.isArray(receipt.recentObservations)
      && receipt.recentObservations.length === Math.min(512, receipt.observedPollCount)
      && receipt.evictedOldDiagnosticObservations === receipt.observedPollCount - receipt.recentObservations.length,
    'recent retention/eviction count mismatch');
    const recent = buckets.map(() => ({decisionCounts:emptyMap(), zeroPaddingDecisionCounts:emptyMap()}));
    let recentInvalidQpc = 0;
    receipt.recentObservations.forEach((row, i) => {
      keys(row, ['sequence', 'paddingQpc100ns', 'bufferFrames', 'paddingFrames', 'referenceBufferedFrames',
        'pendingPrefixFrames', 'submittedFrames', 'requestedFrames', 'started', 'ended', 'stageIndex', 'decision'], 'recent row');
      requireValue(row.sequence === receipt.evictedOldDiagnosticObservations + i, 'recent sequence mismatch');
      for (const k of ['bufferFrames', 'referenceBufferedFrames', 'pendingPrefixFrames', 'submittedFrames',
        'requestedFrames', 'stageIndex']) requireValue(safe(row[k]), 'recent unsafe integer: ' + k);
      // No-write DeviceFull records raw demand (at most the 480-frame pump block),
      // not device admission. Only actual write decisions clamp to device capacity.
      const writing = ['write-requested', 'write-accepted', 'start-requested'].includes(row.decision);
      requireValue(row.bufferFrames > 0 && row.bufferFrames <= 0xffffffff && row.requestedFrames <= 480
        && (!writing || row.requestedFrames <= row.bufferFrames)
        && (row.paddingFrames === null || (safe(row.paddingFrames) && row.paddingFrames <= row.bufferFrames)),
      'recent padding/request outside device buffer');
      requireValue((row.paddingQpc100ns === null || safe(row.paddingQpc100ns))
        && typeof row.started === 'boolean' && typeof row.ended === 'boolean'
        && PUMP_DECISION_KEYS.includes(row.decision), 'recent QPC/state/decision mismatch');
      if (row.paddingQpc100ns === null || row.paddingQpc100ns === 0) recentInvalidQpc += 1;
      const b = recent[row.stageIndex < 3 ? row.stageIndex : 3]; b.decisionCounts[row.decision] += 1;
      if (row.paddingFrames === 0) b.zeroPaddingDecisionCounts[row.decision] += 1;
    });
    requireValue(recentInvalidQpc <= receipt.invalidQpcObservations
      && (receipt.evictedOldDiagnosticObservations > 0 || recentInvalidQpc === receipt.invalidQpcObservations),
    'recent/full invalid-QPC count mismatch');
    recent.forEach((b, i) => { for (const field of ['decisionCounts', 'zeroPaddingDecisionCounts']) {
      for (const k of PUMP_DECISION_KEYS) requireValue(b[field][k] <= buckets[i][field][k]
        && (receipt.evictedOldDiagnosticObservations > 0 || b[field][k] === buckets[i][field][k]),
      'recent/full stage counter mismatch');
    }});
    return {valid:true, schemaVersion:1, diagnosticOnly:true, qualityAcceptance:false, releaseEligible:false,
      coverage:full.coverage, observedDecisionCount:full.observedDecisionCount,
      knownUnderrunDecisionCount:full.decisionCounts.underrun,
      stageKnownUnderrunDecisionCounts:full.stages.map(s => s.decisionCounts.underrun),
      otherStageDecisionCount:full.otherStage.observedDecisionCount,
      evictedRecentDecisionCount:receipt.evictedOldDiagnosticObservations,
      caution:'Counts of recorded decisions do not independently prove physical continuity or absence of acoustic echo.'};
  } catch (error) {
    return {valid:false, failures:[error.message], diagnosticOnly:true, qualityAcceptance:false, releaseEligible:false};
  }
}
