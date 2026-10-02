import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { analyzeLocalAecNativePumpTimingDiagnostic as analyze, NATIVE_PUMP_TIMING_PARTS as PARTS, NATIVE_RENDER_WAKES as WAKES } from './analyze-local-aec-native-pump-timing-diagnostic.mjs';

function fixture(entries = []) {
  const parts = PARTS.map(part => ({part, totals: {count: 0, rejected: 0, unwound: 0,
    invalidQpc: 0, totalMicros: 0, maximumMicros: 0, maximumSpan: null}}));
  const wakeTotals = {notStarted: 0, signaled: 0, timedOut: 0};
  const spans = entries.map(([part, durationMicros, outcome = 'completed', valid = true, explicitWake = undefined], sequence) => {
    let nativeRenderWake = null;
    if (part === 'nativeRenderWait' && outcome === 'completed') {
      nativeRenderWake = explicitWake !== undefined ? explicitWake : 'signaled';
      if (nativeRenderWake in wakeTotals) {
        wakeTotals[nativeRenderWake]++;
      }
    } else if (explicitWake !== undefined) {
      nativeRenderWake = explicitWake;
    }
    const value = {part, sequence, startElapsedMicros: sequence * 3000,
      endElapsedMicros: sequence * 3000 + durationMicros, durationMicros,
      startQpc100ns: valid ? 100 : null, endQpc100ns: valid ? 100 + durationMicros * 10 : null,
      qpcValid: valid, outcome, nativeRenderWake};
    const total = parts.find(entry => entry.part === part).totals;
    total.count++;
    total.rejected += Number(outcome === 'rejected'); total.unwound += Number(outcome === 'unwound');
    total.invalidQpc += Number(!valid); total.totalMicros += durationMicros;
    if (!total.maximumSpan || durationMicros > total.maximumMicros) {
      total.maximumMicros = durationMicros; total.maximumSpan = structuredClone(value);
    }
    return value;
  });
  return {schemaVersion: 2, wakeIdentityPolicy: 'returned-native-result/v1',
    artifactKind: 'local-aec-pump-timing-diagnostic',
    nativeRenderWakeTotals: wakeTotals,
    diagnosticOnly: true, qualityAcceptance: false, releaseEligible: false,
    monotonicDurationUnit: 'microseconds', qpcUnit: '100ns', requestedSleepMs: 2,
    nativeRenderWaitTimeoutMs: 2, retainedSpanLimit: 512, completedSpanCount: spans.length,
    activeSpanCount: 0, evictedOldDiagnosticSpans: Math.max(0, spans.length - 512),
    nestedSpansMayOverlap: true, sumAcrossPartsIsNotLoopDuration: true,
    parts, recentSpans: spans.slice(-512)};
}

test('native event wait is never ordinary sleep, even on rejection', () => {
  const value = fixture([['nativeRenderWait', 2000], ['nativeRenderWait', 50, 'rejected'],
    ['requestedSleep', 2100], ['nativeRenderWait', 10, 'unwound', false]]);
  const before = structuredClone(value), result = analyze(value);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.nativeRenderWait.count, 3);
  assert.equal(result.nativeRenderWait.rejected, 1);
  assert.equal(result.nativeRenderWait.unwound, 1);
  assert.equal(result.nativeRenderWait.invalidQpc, 1);
  assert.equal(result.requestedSleep.count, 1);
  assert.equal(result.requestedSleep.totalMicros, 2100);
  assert.equal(result.nativeRenderWait.totalMicros, 2060);
  assert.equal(result.nativeRenderWakeTotals.signaled, 1);
  assert.equal(result.nativeRenderWakeTotals.notStarted, 0);
  assert.equal(result.nativeRenderWakeTotals.timedOut, 0);
  assert.equal(result.qualityAcceptance, false); assert.equal(result.aecQualityAcceptance, false);
  assert.equal(result.releaseEligible, false); assert.equal(result.overallPassed, false);
  assert.equal(result.nativeClockAccuracyEstablished, false);
  assert.equal(result.deviceCalls, 0); assert.equal(result.providerCalls, 0);
  assert.deepEqual(value, before);
});

test('zero-count and bounded evicted receipts remain diagnostic', () => {
  const empty = fixture();
  const emptyResult = analyze(empty);
  assert.equal(emptyResult.nativeRenderWait.count, 0);
  assert.equal(emptyResult.latestRetainedNativeWaitSpan, null);
  const result = analyze(fixture(Array.from({length: 1024}, () => ['nativeRenderWait', 2000])));
  assert.equal(result.nativeRenderWait.count, 1024);
  assert.equal(result.evictedOldDiagnosticSpans, 512);
  assert.equal(result.latestRetainedNativeWaitSpan?.nativeRenderWake, 'signaled');
});

test('parts table requires typed wait exactly once, including zero-count', () => {
  for (const edit of [
    v => v.parts.pop(),
    v => { v.parts.find(p => p.part === 'nativeRenderWait').part = 'requestedSleep'; },
    v => { v.parts.find(p => p.part === 'nativeRenderWait').part = 'unknownWait'; },
    v => { v.nativeRenderWaitTimeoutMs = 4; },
  ]) {
    const value = fixture(); edit(value); assert.throws(() => analyze(value), /native pump timing/u);
  }
});

test('reject malformed spans, totals, retention and unsealed/acceptance receipts', () => {
  for (const edit of [
    v => { v.activeSpanCount = 1; },
    v => { v.nativeRenderWakeTotals.signaled++; },
    v => { v.qualityAcceptance = true; },
    v => { v.releaseEligible = true; },
    v => { v.sumAcrossPartsIsNotLoopDuration = false; },
    v => { v.completedSpanCount++; },
    v => { v.recentSpans[0].part = 'sleep'; },
    v => { v.recentSpans[0].outcome = 'timedOut'; },
    v => { v.recentSpans[0].qpcValid = false; },
    v => { v.recentSpans[0].endElapsedMicros += 2; }, // +1 can be legitimate independent flooring.
    v => { v.parts.find(p => p.part === 'nativeRenderWait').totals.rejected = 3; },
    v => { v.parts.find(p => p.part === 'nativeRenderWait').totals.maximumSpan.part = 'requestedSleep'; },
    v => { v.evictedOldDiagnosticSpans = 1; },
    v => { v.recentSpans.length = 0; },
    v => { v.parts.find(p => p.part === 'nativeRenderWait').totals.count = NaN; },
  ]) {
    const value = fixture([['nativeRenderWait', 2000]]); edit(value);
    assert.throws(() => analyze(value), /native pump timing/u);
  }
});

test('v1 receipts must be rejected as insufficient per-wake identity', () => {
  const value = fixture([['nativeRenderWait', 2000]]);
  value.schemaVersion = 1;
  delete value.wakeIdentityPolicy;
  delete value.recentSpans[0].nativeRenderWake;
  delete value.parts.find(p => p.part === 'nativeRenderWait').totals.maximumSpan.nativeRenderWake;
  assert.throws(() => analyze(value), /unsupported receipt/u);

  // Missing wakeIdentityPolicy on v2 also rejected
  const valueNoPolicy = fixture([['nativeRenderWait', 2000]]);
  delete valueNoPolicy.wakeIdentityPolicy;
  assert.throws(() => analyze(valueNoPolicy), /unsupported wake identity policy/u);
});

test('wake attribution validation rejects false, missing, unknown, wrong-part, rejected, and unwound wake', () => {
  // 1. Missing nativeRenderWake on completed nativeRenderWait
  {
    const value = fixture([['nativeRenderWait', 2000]]);
    value.recentSpans[0].nativeRenderWake = null;
    value.parts.find(p => p.part === 'nativeRenderWait').totals.maximumSpan.nativeRenderWake = null;
    assert.throws(() => analyze(value), /invalid nativeRenderWake for completed nativeRenderWait/u);
  }
  // 2. Unknown wake identity kind
  {
    const value = fixture([['nativeRenderWait', 2000]]);
    value.recentSpans[0].nativeRenderWake = 'interrupted';
    value.parts.find(p => p.part === 'nativeRenderWait').totals.maximumSpan.nativeRenderWake = 'interrupted';
    assert.throws(() => analyze(value), /invalid nativeRenderWake for completed nativeRenderWait/u);
  }
  // 3. Wrong-part carrying wake (e.g. requestedSleep carrying 'signaled')
  {
    const value = fixture([['requestedSleep', 2000]]);
    value.recentSpans[0].nativeRenderWake = 'signaled';
    value.parts.find(p => p.part === 'requestedSleep').totals.maximumSpan.nativeRenderWake = 'signaled';
    assert.throws(() => analyze(value), /non-null nativeRenderWake on non-wait or incomplete span/u);
  }
  // 4. Rejected wait carrying wake
  {
    const value = fixture([['nativeRenderWait', 2000, 'rejected', true, 'signaled']]);
    value.parts.find(p => p.part === 'nativeRenderWait').totals.maximumSpan.nativeRenderWake = 'signaled';
    assert.throws(() => analyze(value), /non-null nativeRenderWake on non-wait or incomplete span/u);
  }
  // 5. Unwound wait carrying wake
  {
    const value = fixture([['nativeRenderWait', 2000, 'unwound', true, 'timedOut']]);
    value.parts.find(p => p.part === 'nativeRenderWait').totals.maximumSpan.nativeRenderWake = 'timedOut';
    assert.throws(() => analyze(value), /non-null nativeRenderWake on non-wait or incomplete span/u);
  }
  // 6. False boolean or non-null wake on another span
  {
    const value = fixture([['loopGap', 100]]);
    value.recentSpans[0].nativeRenderWake = false;
    value.parts.find(p => p.part === 'loopGap').totals.maximumSpan.nativeRenderWake = false;
    assert.throws(() => analyze(value), /non-null nativeRenderWake on non-wait or incomplete span/u);
  }
});

test('maximumSpan must match same-span wake identity', () => {
  // maximumSpan has conflicting wake identity with what it recorded
  const value = fixture([['nativeRenderWait', 2000, 'completed', true, 'signaled']]);
  value.parts.find(p => p.part === 'nativeRenderWait').totals.maximumSpan.nativeRenderWake = 'timedOut';
  assert.throws(() => analyze(value), /maximum vs retained span nativeRenderWake mismatch/u);
  // Missing wake identity is independently rejected.
  const value2 = fixture([['nativeRenderWait', 2000, 'completed', true, 'signaled']]);
  value2.parts.find(p => p.part === 'nativeRenderWait').totals.maximumSpan.nativeRenderWake = null;
  assert.throws(() => analyze(value2), /invalid nativeRenderWake for completed nativeRenderWait/u);
});

test('retained maximum binds all span identity fields, not only wake and duration', () => {
  for (const mutate of [
    v => { v.startQpc100ns++; v.endQpc100ns++; },
    v => { v.startElapsedMicros++; v.endElapsedMicros++; },
    v => { v.outcome = 'rejected'; },
    v => { v.startQpc100ns = null; v.qpcValid = false; },
  ]) {
    const value = fixture([['nativePump', 2000]]);
    mutate(value.parts.find(p => p.part === 'nativePump').totals.maximumSpan);
    assert.throws(() => analyze(value), /maximum vs retained span/u);
  }
});

test('evicted maximum cannot claim a wake absent from global totals', () => {
  const value = fixture([['nativeRenderWait', 3000, 'completed', true, 'signaled'],
    ...Array.from({length: 512}, () => ['nativeRenderWait', 2000, 'completed', true, 'signaled'])]);
  value.parts.find(p => p.part === 'nativeRenderWait').totals.maximumSpan.nativeRenderWake = 'timedOut';
  assert.throws(() => analyze(value), /maximum wake absent from global totals/u);
});

test('evicted maximum needs its own residual wake witness, not a retained wake', () => {
  const value = fixture([['nativeRenderWait', 3000, 'completed', true, 'timedOut'],
    ...Array.from({length: 511}, () => ['nativeRenderWait', 2000, 'completed', true, 'timedOut']),
    ['nativeRenderWait', 2000, 'completed', true, 'signaled']]);
  value.parts.find(p => p.part === 'nativeRenderWait').totals.maximumSpan.nativeRenderWake = 'signaled';
  assert.throws(() => analyze(value), /evicted maximum wake absent from evicted totals/u);
  const genuine = fixture([['nativeRenderWait', 3000, 'completed', true, 'signaled'],
    ...Array.from({length: 512}, () => ['nativeRenderWait', 2000, 'completed', true, 'timedOut'])]);
  assert.equal(analyze(genuine).nativeRenderWait.maximumSpan.nativeRenderWake, 'signaled');
});

test('global vs retained counter mismatches are rejected', () => {
  // Unevicted receipt with mismatch between retained wake and global nativeRenderWakeTotals
  const value = fixture([['nativeRenderWait', 2000, 'completed', true, 'signaled']]);
  value.nativeRenderWakeTotals.signaled = 2;
  value.parts.find(p => p.part === 'nativeRenderWait').totals.count = 2; // to keep count sum consistent if needed
  assert.throws(() => analyze(value), /native pump timing/u);

  // Evicted receipt with retained wake exceeding global wake total
  const valueEvicted = fixture(Array.from({length: 600}, () => ['nativeRenderWait', 2000, 'completed', true, 'timedOut']));
  valueEvicted.nativeRenderWakeTotals.timedOut = 100; // smaller than retained (512)
  valueEvicted.nativeRenderWakeTotals.signaled = 500;
  assert.throws(() => analyze(valueEvicted), /retained wake timedOut mismatch/u);
});

test('analysis exposes latest retained native wait span with concrete kind and no successful wake for failures', () => {
  // 1. Success with signaled
  const val1 = fixture([['requestedSleep', 1000], ['nativeRenderWait', 2000, 'completed', true, 'signaled']]);
  const res1 = analyze(val1);
  assert.deepEqual(res1.latestRetainedNativeWaitSpan, {
    sequence: 1,
    part: 'nativeRenderWait',
    outcome: 'completed',
    nativeRenderWake: 'signaled',
    durationMicros: 2000,
  });

  // 2. Success with timedOut followed by requestedSleep
  const val2 = fixture([['nativeRenderWait', 2000, 'completed', true, 'timedOut'], ['requestedSleep', 1000]]);
  const res2 = analyze(val2);
  assert.deepEqual(res2.latestRetainedNativeWaitSpan, {
    sequence: 0,
    part: 'nativeRenderWait',
    outcome: 'completed',
    nativeRenderWake: 'timedOut',
    durationMicros: 2000,
  });

  // 3. Failure (rejected) wait has concrete outcome but nativeRenderWake is null (no successful wake)
  const val3 = fixture([['nativeRenderWait', 500, 'rejected']]);
  const res3 = analyze(val3);
  assert.deepEqual(res3.latestRetainedNativeWaitSpan, {
    sequence: 0,
    part: 'nativeRenderWait',
    outcome: 'rejected',
    nativeRenderWake: null,
    durationMicros: 500,
  });
});

// Quantize independently from integer nanoseconds, matching Duration::as_micros.
// Never derive duration from the already-floored elapsed offsets.
function quantizedReceipt(startNs, endNs) {
  const durationMicros = Number((endNs - startNs) / 1000n);
  const value = fixture([['nativeRenderWait', durationMicros]]);
  const span = value.recentSpans[0];
  span.startElapsedMicros = Number(startNs / 1000n);
  span.endElapsedMicros = Number(endNs / 1000n);
  value.parts.find(p => p.part === 'nativeRenderWait').totals.maximumSpan = structuredClone(span);
  return value;
}

test('independent floors accept submicrosecond carry without rewriting diagnostic values', () => {
  for (const [startNs, endNs, expectedCarry] of [
    [100n, 900n, 0],       // Duration zero, no boundary crossed.
    [900n, 1100n, 1],      // 0.2us duration, endpoints in adjacent buckets.
    [1900n, 2100n, 1],
    [100n, 2100n, 0],      // Exact 2us duration.
    [900n, 2100n, 1],      // 1.2us duration, floored endpoint difference 2us.
    [2000n, 2000n, 0],
  ]) {
    const value = quantizedReceipt(startNs, endNs), before = structuredClone(value);
    const span = value.recentSpans[0];
    assert.equal(span.endElapsedMicros - span.startElapsedMicros - span.durationMicros, expectedCarry);
    const result = analyze(value);
    assert.deepEqual(value, before);
    assert.equal(result.nativeRenderWait.totalMicros, Number((endNs - startNs) / 1000n));
    assert.equal(result.nativeRenderWait.maximumSpan.durationMicros, span.durationMicros);
    assert.equal(result.qualityAcceptance, false);
    assert.equal(result.aecQualityAcceptance, false);
    assert.equal(result.overallPassed, false);
    assert.equal(result.releaseEligible, false);
    assert.equal(result.nativeClockAccuracyEstablished, false);
  }
});

test('all 1000 nanosecond origin residues obey the one-sided floor identity', () => {
  const carries = new Set();
  for (let residue = 0n; residue < 1000n; residue++) {
    for (const durationNs of [0n, 1n, 99n, 500n, 999n, 1000n, 1001n, 1999n, 2000n, 2500n]) {
      const startNs = 10000n + residue, endNs = startNs + durationNs;
      const expectedCarry = Number((residue + durationNs % 1000n) / 1000n);
      const value = quantizedReceipt(startNs, endNs), span = value.recentSpans[0];
      assert.equal(span.endElapsedMicros - span.startElapsedMicros - span.durationMicros, expectedCarry);
      carries.add(expectedCarry);
      assert.doesNotThrow(() => analyze(value));
    }
  }
  assert.deepEqual([...carries].sort(), [0, 1]);
});

test('both maximum and retained spans reject impossible floor relationships', () => {
  for (const location of ['maximum', 'recent']) {
    for (const corrupt of [
      span => { span.durationMicros = span.endElapsedMicros - span.startElapsedMicros + 1; }, // Wrong direction, even 1us.
      span => { span.durationMicros = span.endElapsedMicros - span.startElapsedMicros - 2; }, // Exceeds carry bound.
      span => { span.endElapsedMicros = span.startElapsedMicros - 1; }, // Reversed monotonic endpoints.
    ]) {
      const value = quantizedReceipt(19900n, 21100n);
      corrupt(location === 'maximum'
        ? value.parts.find(p => p.part === 'nativeRenderWait').totals.maximumSpan
        : value.recentSpans[0]);
      assert.throws(() => analyze(value), /inconsistent span duration/u);
    }
  }
});

test('floor compatibility does not grant a 1us tolerance to aggregate or QPC errors', () => {
  for (const corrupt of [
    value => { value.parts.find(p => p.part === 'nativeRenderWait').totals.maximumMicros++; },
    value => { value.parts.find(p => p.part === 'nativeRenderWait').totals.totalMicros++; },
    value => { value.recentSpans[0].qpcValid = false; },
    value => { value.nativeRenderWakeTotals.signaled++; },
  ]) {
    const value = quantizedReceipt(900n, 2100n);
    corrupt(value);
    assert.throws(() => analyze(value), /native pump timing/u);
  }
});

test('Rust PARTS and analyzer stay aligned; consumer waits only in running branch', () => {
  const base = new URL('../../apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/', import.meta.url);
  const rust = fs.readFileSync(new URL('pump_timing.rs', base), 'utf8');
  const table = rust.match(/const PARTS: \[Part; PART_COUNT\] = \[([^\]]+)\]/u)[1];
  assert.deepEqual([...table.matchAll(/Part::(\w+)/gu)].map(([, part]) => part[0].toLowerCase() + part.slice(1)), PARTS);
  assert.equal(Number(rust.match(/const PART_COUNT: usize = (\d+)/u)[1]), PARTS.length);
  const consumer = fs.readFileSync(new URL('speech_simulation.rs', base), 'utf8');
  assert.match(consumer, /if stream_receipt\.is_none\(\) && stream\.device_started\(\) \{\s*pump_timing::measure_native_render_wait\(&timing,\s*\|\| stream\.wait_for_device\(Duration::from_millis\(2\)\)\)\?;\s*\} else \{\s*pump_timing::measure\(&timing, pump_timing::Part::RequestedSleep, \|\| \{\s*std::thread::sleep\(Duration::from_millis\(2\)\); Ok\(\(\)\)\s*\}\)\?;\s*\}/u);
  assert.equal([...consumer.matchAll(/stream\.wait_for_device/gu)].length, 1);
  assert.ok(consumer.indexOf('injector.stop_and_join()') < consumer.indexOf('timing.borrow().receipt()'));
});
