import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { analyzeLocalAecNativePumpTimingDiagnostic as analyze, NATIVE_PUMP_TIMING_PARTS as PARTS } from './analyze-local-aec-native-pump-timing-diagnostic.mjs';

function fixture(entries = []) {
  const parts = PARTS.map(part => ({part, totals: {count: 0, rejected: 0, unwound: 0,
    invalidQpc: 0, totalMicros: 0, maximumMicros: 0, maximumSpan: null}}));
  const spans = entries.map(([part, durationMicros, outcome = 'completed', valid = true], sequence) => {
    const value = {part, sequence, startElapsedMicros: sequence * 3000,
      endElapsedMicros: sequence * 3000 + durationMicros, durationMicros,
      startQpc100ns: valid ? 100 : null, endQpc100ns: valid ? 100 + durationMicros * 10 : null,
      qpcValid: valid, outcome};
    const total = parts.find(entry => entry.part === part).totals;
    total.count++;
    total.rejected += Number(outcome === 'rejected'); total.unwound += Number(outcome === 'unwound');
    total.invalidQpc += Number(!valid); total.totalMicros += durationMicros;
    if (!total.maximumSpan || durationMicros > total.maximumMicros) {
      total.maximumMicros = durationMicros; total.maximumSpan = structuredClone(value);
    }
    return value;
  });
  return {schemaVersion: 1, artifactKind: 'local-aec-pump-timing-diagnostic',
    nativeRenderWakeTotals: {notStarted: 0, signaled: entries.filter(e => e[0] === 'nativeRenderWait' && (e[2] ?? 'completed') === 'completed').length, timedOut: 0},
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
  assert.equal(result.nativeRenderWait.count, 3);
  assert.equal(result.nativeRenderWait.rejected, 1);
  assert.equal(result.nativeRenderWait.unwound, 1);
  assert.equal(result.nativeRenderWait.invalidQpc, 1);
  assert.equal(result.requestedSleep.count, 1);
  assert.equal(result.requestedSleep.totalMicros, 2100);
  assert.equal(result.nativeRenderWait.totalMicros, 2060);
  assert.equal(result.qualityAcceptance, false); assert.equal(result.aecQualityAcceptance, false);
  assert.equal(result.releaseEligible, false); assert.equal(result.overallPassed, false);
  assert.equal(result.nativeClockAccuracyEstablished, false);
  assert.equal(result.deviceCalls, 0); assert.equal(result.providerCalls, 0);
  assert.deepEqual(value, before);
});
test('zero-count and bounded evicted receipts remain diagnostic', () => {
  assert.equal(analyze(fixture()).nativeRenderWait.count, 0);
  const result = analyze(fixture(Array.from({length: 1024}, () => ['nativeRenderWait', 2000])));
  assert.equal(result.nativeRenderWait.count, 1024);
  assert.equal(result.evictedOldDiagnosticSpans, 512);
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
    v => { v.recentSpans[0].endElapsedMicros++; },
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
test('Rust PARTS and analyzer stay aligned; consumer waits only in running branch', () => {
  const base = new URL('../../apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/', import.meta.url);
  const rust = fs.readFileSync(new URL('pump_timing.rs', base), 'utf8');
  const table = rust.match(/const PARTS: \[Part; PART_COUNT\] = \[([^\]]+)\]/u)[1];
  assert.deepEqual([...table.matchAll(/Part::(\w+)/gu)].map(([, part]) => part[0].toLowerCase() + part.slice(1)), PARTS);
  assert.equal(Number(rust.match(/const PART_COUNT: usize = (\d+)/u)[1]), PARTS.length);
  const consumer = fs.readFileSync(new URL('speech_simulation.rs', base), 'utf8');
  assert.match(consumer, /if stream_receipt\.is_none\(\) && stream\.device_started\(\) \{\s*let wake = pump_timing::measure\(&timing, pump_timing::Part::NativeRenderWait,\s*\|\| stream\.wait_for_device\(Duration::from_millis\(2\)\)\)\?;\s*timing\.borrow_mut\(\)\.record_native_render_wake\(wake\);\s*\} else \{\s*pump_timing::measure\(&timing, pump_timing::Part::RequestedSleep, \|\| \{\s*std::thread::sleep\(Duration::from_millis\(2\)\); Ok\(\(\)\)\s*\}\)\?;\s*\}/u);
  assert.equal([...consumer.matchAll(/stream\.wait_for_device/gu)].length, 1);
  assert.ok(consumer.indexOf('injector.stop_and_join()') < consumer.indexOf('timing.borrow().receipt()'));
});
