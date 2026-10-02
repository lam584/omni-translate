import assert from 'node:assert/strict';
import test from 'node:test';
import { describeSourceClockInterpolation } from './source-clock-interpolation-diagnostic.mjs';

function rows(positions, qpcs = positions.map((p) => p * 10000000n / 384000n), frequency = 384000n) {
  return positions.map((p, i) => ({ sequence: i, clockPosition: p, clockFrequency: frequency, qpc100ns: 100000000n + qpcs[i] }));
}
test('nominal byte-clock units are not mistaken for sample frames; startup zero is not an anchor', () => {
  const r = describeSourceClockInterpolation(rows([0n, 384000n, 768000n, 1152000n]));
  assert.equal(r.heldOutCount, 1); assert.equal(r.exceedsFrozen1msCount, 0);
  assert.equal(r.nominalPositionSpanSeconds, 2); assert.equal(r.qpcSpanSeconds, 2);
  assert.equal(r.formalSourceClockAcceptance, false);
});
test('each middle sample is withheld: fitting all points cannot hide nonlinear clock residual', () => {
  const r = describeSourceClockInterpolation(rows([384000n, 768000n, 1200000n, 1536000n]));
  // Timestamp's own rate matches all points; use a clock observation deviation independently.
  const altered = rows([384000n, 768000n, 1200000n, 1536000n], [0n, 10000000n, 20000000n, 30000000n]);
  const d = describeSourceClockInterpolation(altered);
  assert.equal(r.exceedsFrozen1msCount, 0); assert.equal(d.heldOutCount, 2);
  assert.equal(d.exceedsFrozen1msCount, 2); assert.equal(d.maxHeldOutPositionError.errorMs, 125);
});
test('1 ms boundary is exact with huge cumulative positions and non-frame frequency', () => {
  const base = 100000000000000000n;
  const p = [base, base + 384000n + 384n, base + 768000n];
  const r = describeSourceClockInterpolation(rows(p, [0n, 10000000n, 20000000n]));
  assert.equal(r.exceedsFrozen1msCount, 0); assert.equal(r.maxHeldOutPositionError.errorMs, 1);
  p[1] += 1n;
  assert.equal(describeSourceClockInterpolation(rows(p, [0n, 10000000n, 20000000n])).exceedsFrozen1msCount, 1);
});
test('linear drift can be interpolable yet is never accepted as native accuracy or a global bound proof', () => {
  const r = describeSourceClockInterpolation(rows([384000n, 768000n, 1152000n], [0n, 9000000n, 18000000n]));
  assert.equal(r.exceedsFrozen1msCount, 0); assert.equal(r.nominalPositionSpanSeconds, 2);
  assert.equal(r.qpcSpanSeconds, 1.8); assert.equal(r.formalSourceClockAcceptance, false);
  assert.equal(r.interpolationErrorIsNotNativeAccuracyProof, true);
});
test('missing, retreated, equal-QPC or changed-unit observations cannot be bridged', () => {
  for (const mutate of [
    (r) => { r[1].sequence += 3; }, (r) => { r[1].qpc100ns = r[0].qpc100ns; },
    (r) => { r[1].clockPosition = r[0].clockPosition - 1n; }, (r) => { r[1].clockFrequency = 48000n; },
  ]) {
    const r = rows([384000n, 768000n, 1152000n]); mutate(r);
    const d = describeSourceClockInterpolation(r); assert.equal(d.heldOutCount, 0); assert.equal(d.nonInterpolableTriples, 1);
  }
  assert.equal(describeSourceClockInterpolation(rows([0n])).maxHeldOutPositionError, null);
});
