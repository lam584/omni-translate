/**
 * Offline structural analysis of the simulator's sealed pumpTiming receipt.
 * No devices, providers, PCM, clock reconstruction or quality acceptance.
 * Nested timings overlap: never sum parts to infer loop duration or latency.
 */
export const NATIVE_PUMP_TIMING_PARTS = Object.freeze([
  'loopGap', 'healthyCapture', 'mediaPoll', 'deltaAdmission', 'nativePump',
  'referenceCallback', 'physicalCallback', 'lifecycleCallback', 'drainCheck',
  'requestedSleep', 'nativeRenderWait', 'abort', 'sourceCleanup',
]);
const PARTS = new Set(NATIVE_PUMP_TIMING_PARTS);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const check = (ok, message) => { if (!ok) throw Error(`native pump timing: ${message}`); };
function span(value, completed) {
  check(value && PARTS.has(value.part), 'unknown span part');
  for (const key of ['sequence', 'startElapsedMicros', 'endElapsedMicros', 'durationMicros']) {
    check(integer(value[key]), `invalid span ${key}`);
  }
  check(value.sequence < completed, 'span sequence outside completed range');
  // Rust floors each Instant offset and Duration independently to microseconds.
  // For E = S + D, floor(E) - floor(S) = floor(D) + carry, carry in {0, 1}.
  // This is a one-sided quantization identity, NOT a +/-1us data tolerance.
  const elapsedMicros = value.endElapsedMicros - value.startElapsedMicros;
  check(elapsedMicros >= 0 && value.durationMicros <= elapsedMicros
    && elapsedMicros - value.durationMicros <= 1, 'inconsistent span duration');
  check(['completed', 'rejected', 'unwound'].includes(value.outcome), 'invalid span outcome');
  for (const key of ['startQpc100ns', 'endQpc100ns']) {
    check(value[key] === null || integer(value[key]), `invalid span ${key}`);
  }
  const valid = value.startQpc100ns !== null && value.endQpc100ns !== null
    && value.startQpc100ns > 0 && value.endQpc100ns >= value.startQpc100ns;
  check(value.qpcValid === valid, 'inconsistent QPC validity');
}
export function analyzeLocalAecNativePumpTimingDiagnostic(timing) {
  check(timing?.schemaVersion === 1 && timing.artifactKind === 'local-aec-pump-timing-diagnostic', 'unsupported receipt');
  check(timing.diagnosticOnly === true && timing.qualityAcceptance === false
    && timing.releaseEligible === false, 'diagnostic boundary missing');
  check(timing.monotonicDurationUnit === 'microseconds' && timing.qpcUnit === '100ns', 'unsupported units');
  check(timing.requestedSleepMs === 2 && timing.nativeRenderWaitTimeoutMs === 2, 'invalid wait contract');
  check(timing.nestedSpansMayOverlap === true && timing.sumAcrossPartsIsNotLoopDuration === true, 'overlap boundary missing');
  check(timing.retainedSpanLimit === 512, 'unsupported retention limit');
  for (const key of ['completedSpanCount', 'activeSpanCount', 'evictedOldDiagnosticSpans']) {
    check(integer(timing[key]), `invalid ${key}`);
  }
  check(timing.activeSpanCount === 0, 'receipt contains active spans');
  const completed = timing.completedSpanCount;
  check(Array.isArray(timing.parts) && timing.parts.length === PARTS.size, 'incomplete parts table');
  const byPart = new Map();
  let count = 0;
  for (const entry of timing.parts) {
    check(entry && PARTS.has(entry.part) && !byPart.has(entry.part), 'unknown or duplicate part');
    const total = entry.totals;
    check(total && typeof total === 'object', 'missing totals');
    for (const key of ['count', 'rejected', 'unwound', 'invalidQpc', 'totalMicros', 'maximumMicros']) {
      check(integer(total[key]), `invalid ${entry.part} ${key}`);
    }
    check(total.rejected + total.unwound <= total.count && total.invalidQpc <= total.count, 'inconsistent outcome counts');
    check(total.maximumMicros <= total.totalMicros, 'maximum exceeds total');
    if (total.count === 0) {
      check(total.maximumSpan === null && total.totalMicros === 0 && total.maximumMicros === 0, 'nonempty zero-count totals');
    } else {
      span(total.maximumSpan, completed);
      check(total.maximumSpan.part === entry.part && total.maximumSpan.durationMicros === total.maximumMicros, 'inconsistent maximum span');
    }
    byPart.set(entry.part, total);
    count += total.count;
  }
  const wakes = timing.nativeRenderWakeTotals;
  check(wakes && ['notStarted', 'signaled', 'timedOut'].every(key => integer(wakes[key])), 'invalid wake totals');
  const waitTotals = byPart.get('nativeRenderWait');
  check(wakes.notStarted + wakes.signaled + wakes.timedOut === waitTotals.count - waitTotals.rejected - waitTotals.unwound, 'wake total mismatch');
  check(Number.isSafeInteger(count) && count === completed, 'completed total mismatch');
  check(Array.isArray(timing.recentSpans) && timing.recentSpans.length === Math.min(completed, 512), 'invalid retained spans');
  check(timing.evictedOldDiagnosticSpans === completed - timing.recentSpans.length, 'eviction mismatch');
  const retained = new Map();
  for (const [index, value] of timing.recentSpans.entries()) {
    span(value, completed);
    check(value.sequence === timing.evictedOldDiagnosticSpans + index, 'noncontiguous retained sequence');
    const total = byPart.get(value.part);
    check(value.durationMicros <= total.maximumMicros, 'retained span exceeds maximum');
    const row = retained.get(value.part) ?? {count: 0, rejected: 0, unwound: 0, invalidQpc: 0, totalMicros: 0};
    row.count++;
    row.rejected += Number(value.outcome === 'rejected');
    row.unwound += Number(value.outcome === 'unwound');
    row.invalidQpc += Number(!value.qpcValid);
    row.totalMicros += value.durationMicros;
    retained.set(value.part, row);
  }
  for (const [part, total] of byPart) {
    const row = retained.get(part) ?? {count: 0, rejected: 0, unwound: 0, invalidQpc: 0, totalMicros: 0};
    for (const key of Object.keys(row)) {
      check(Number.isSafeInteger(row[key]) && (timing.evictedOldDiagnosticSpans === 0
        ? row[key] === total[key] : row[key] <= total[key]), `retained ${part} ${key} mismatch`);
    }
  }
  // Preserve classification, including rejected waits. A timeout is a completed
  // wait, not a rejection or ordinary sleep; no scheduling/quality thresholds.
  return {
    schemaVersion: 1, artifactKind: 'local-aec-native-pump-timing-analysis-diagnostic',
    diagnosticOnly: true, qualityAcceptance: false, aecQualityAcceptance: false,
    releaseEligible: false, overallPassed: false, providerCalls: 0, deviceCalls: 0,
    nativeClockAccuracyEstablished: false, sumAcrossPartsIsNotLoopDuration: true,
    completedSpanCount: completed, evictedOldDiagnosticSpans: timing.evictedOldDiagnosticSpans,
    nativeRenderWait: {...byPart.get('nativeRenderWait')},
    nativeRenderWakeTotals: {...wakes},
    requestedSleep: {...byPart.get('requestedSleep')},
    parts: timing.parts.map(({part, totals}) => ({part, totals: {...totals}})),
  };
}
