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
const EVENT_ONLY_WAKES = Object.freeze(['notStarted', 'signaled', 'timedOut']);
export const NATIVE_RENDER_WAKES = Object.freeze([...EVENT_ONLY_WAKES, 'deadlineSignaled']);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const check = (ok, message) => { if (!ok) throw Error(`native pump timing: ${message}`); };
function span(value, completed, wakes) {
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
  if (value.part === 'nativeRenderWait' && value.outcome === 'completed') {
    check(wakes.has(value.nativeRenderWake), 'invalid nativeRenderWake for completed nativeRenderWait');
  } else {
    check(value.nativeRenderWake === null, 'non-null nativeRenderWake on non-wait or incomplete span');
  }
}
export function analyzeLocalAecNativePumpTimingDiagnostic(timing) {
  check([2, 3].includes(timing?.schemaVersion) && timing.artifactKind === 'local-aec-pump-timing-diagnostic', 'unsupported receipt');
  check(timing.wakeIdentityPolicy === 'returned-native-result/v1', 'unsupported wake identity policy');
  const wakeNames = timing.schemaVersion === 2 ? EVENT_ONLY_WAKES : NATIVE_RENDER_WAKES;
  const wakeKinds = new Set(wakeNames);
  if (timing.schemaVersion === 3) {
    check(timing.nativeRenderWaitMechanism === 'event-or-local-high-resolution-deadline/v1', 'unsupported wait mechanism');
  } else {
    check(timing.nativeRenderWaitMechanism === undefined, 'v2 cannot claim a timer mechanism');
  }
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
      span(total.maximumSpan, completed, wakeKinds);
      check(total.maximumSpan.part === entry.part && total.maximumSpan.durationMicros === total.maximumMicros, 'inconsistent maximum span');
    }
    byPart.set(entry.part, total);
    count += total.count;
  }
  const wakes = timing.nativeRenderWakeTotals;
  check(wakes && Object.keys(wakes).length === wakeNames.length && wakeNames.every(key => integer(wakes[key])), 'invalid wake totals');
  const waitTotals = byPart.get('nativeRenderWait');
  check(wakeNames.reduce((sum, key) => sum + wakes[key], 0) === waitTotals.count - waitTotals.rejected - waitTotals.unwound, 'wake total mismatch');
  check(Number.isSafeInteger(count) && count === completed, 'completed total mismatch');
  check(Array.isArray(timing.recentSpans) && timing.recentSpans.length === Math.min(completed, 512), 'invalid retained spans');
  check(timing.evictedOldDiagnosticSpans === completed - timing.recentSpans.length, 'eviction mismatch');
  const retained = new Map();
  const retainedBySequence = new Map();
  const retainedWakes = Object.fromEntries(wakeNames.map(kind => [kind, 0]));
  let latestRetainedNativeWaitSpan = null;
  for (const [index, value] of timing.recentSpans.entries()) {
    span(value, completed, wakeKinds);
    check(value.sequence === timing.evictedOldDiagnosticSpans + index, 'noncontiguous retained sequence');
    retainedBySequence.set(value.sequence, value);
    const total = byPart.get(value.part);
    check(value.durationMicros <= total.maximumMicros, 'retained span exceeds maximum');
    const row = retained.get(value.part) ?? {count: 0, rejected: 0, unwound: 0, invalidQpc: 0, totalMicros: 0};
    row.count++;
    row.rejected += Number(value.outcome === 'rejected');
    row.unwound += Number(value.outcome === 'unwound');
    row.invalidQpc += Number(!value.qpcValid);
    row.totalMicros += value.durationMicros;
    retained.set(value.part, row);
    if (value.part === 'nativeRenderWait') {
      latestRetainedNativeWaitSpan = value;
      if (value.outcome === 'completed') {
        retainedWakes[value.nativeRenderWake]++;
      }
    }
  }
  for (const kind of wakeNames) {
    check(timing.evictedOldDiagnosticSpans === 0
      ? retainedWakes[kind] === wakes[kind]
      : retainedWakes[kind] <= wakes[kind], `retained wake ${kind} mismatch`);
  }
  for (const [part, total] of byPart) {
    const maximum = total.maximumSpan;
    if (maximum) {
      const sameSequence = retainedBySequence.get(maximum.sequence);
      if (sameSequence) {
        for (const key of ['sequence', 'part', 'startElapsedMicros', 'endElapsedMicros', 'durationMicros',
          'startQpc100ns', 'endQpc100ns', 'qpcValid', 'outcome', 'nativeRenderWake']) {
          check(maximum[key] === sameSequence[key], `maximum vs retained span ${key} mismatch`);
        }
      }
      if (maximum.nativeRenderWake !== null) {
        check(wakes[maximum.nativeRenderWake] > 0, 'maximum wake absent from global totals');
        if (!sameSequence) {
          check(wakes[maximum.nativeRenderWake] - retainedWakes[maximum.nativeRenderWake] > 0,
            'evicted maximum wake absent from evicted totals');
        }
      }
    }
    const row = retained.get(part) ?? {count: 0, rejected: 0, unwound: 0, invalidQpc: 0, totalMicros: 0};
    for (const key of Object.keys(row)) {
      check(Number.isSafeInteger(row[key]) && (timing.evictedOldDiagnosticSpans === 0
        ? row[key] === total[key] : row[key] <= total[key]), `retained ${part} ${key} mismatch`);
    }
  }
  // Preserve classification, including rejected waits. A timeout is a completed
  // wait, not a rejection or ordinary sleep; no scheduling/quality thresholds.
  return {
    schemaVersion: timing.schemaVersion, nativeRenderWaitMechanism: timing.nativeRenderWaitMechanism ?? 'native-event-only/v1', artifactKind: 'local-aec-native-pump-timing-analysis-diagnostic',
    diagnosticOnly: true, qualityAcceptance: false, aecQualityAcceptance: false,
    releaseEligible: false, overallPassed: false, providerCalls: 0, deviceCalls: 0,
    nativeClockAccuracyEstablished: false, sumAcrossPartsIsNotLoopDuration: true,
    completedSpanCount: completed, evictedOldDiagnosticSpans: timing.evictedOldDiagnosticSpans,
    nativeRenderWait: {...byPart.get('nativeRenderWait')},
    nativeRenderWakeTotals: {...wakes},
    latestRetainedNativeWaitSpan: latestRetainedNativeWaitSpan ? {
      sequence: latestRetainedNativeWaitSpan.sequence,
      part: latestRetainedNativeWaitSpan.part,
      outcome: latestRetainedNativeWaitSpan.outcome,
      nativeRenderWake: latestRetainedNativeWaitSpan.nativeRenderWake,
      durationMicros: latestRetainedNativeWaitSpan.durationMicros,
    } : null,
    requestedSleep: {...byPart.get('requestedSleep')},
    parts: timing.parts.map(({part, totals}) => ({part, totals: {...totals}})),
  };
}
