// Diagnostic only: held-out native observations cannot certify interpolation
// between observations, sample-clock accuracy, or any AEC quality criterion.
export function describeSourceClockInterpolation(rows) {
  const thresholdTicks = 10000n; // Frozen 1 ms, never fitted to a measured run.
  const samples = rows.filter((r) => r.clockPosition !== null && r.clockFrequency !== null
    && r.qpc100ns !== null && r.clockPosition > 0n && r.clockFrequency > 0n);
  const errors = [];
  let nonInterpolableTriples = 0;
  for (let i = 1; i + 1 < samples.length; i += 1) {
    const [a, b, c] = [samples[i - 1], samples[i], samples[i + 1]];
    // Never bridge missing rows, changed units, or a failed/non-monotonic clock.
    if (b.sequence !== a.sequence + 1 || c.sequence !== b.sequence + 1
      || a.clockFrequency !== b.clockFrequency || b.clockFrequency !== c.clockFrequency
      || !(a.qpc100ns < b.qpc100ns && b.qpc100ns < c.qpc100ns)
      || !(a.clockPosition <= b.clockPosition && b.clockPosition <= c.clockPosition)) {
      nonInterpolableTriples += 1; continue;
    }
    const dq = c.qpc100ns - a.qpc100ns;
    const predictedNumerator = (c.clockPosition - a.clockPosition) * (b.qpc100ns - a.qpc100ns);
    const measuredNumerator = (b.clockPosition - a.clockPosition) * dq;
    const difference = predictedNumerator >= measuredNumerator
      ? predictedNumerator - measuredNumerator : measuredNumerator - predictedNumerator;
    // Keep threshold decisions rational/exact even for large cumulative positions.
    const exceeds = difference * 10000000n > thresholdTicks * dq * b.clockFrequency;
    errors.push({ sequence: b.sequence, errorMs: Number(difference) * 1000 / Number(dq * b.clockFrequency),
      supportIntervalMs: Number(dq) / 10000, exceedsFrozen1ms: exceeds });
  }
  const sorted = errors.map((e) => e.errorMs).sort((a, b) => a - b);
  const maximum = errors.reduce((old, e) => old === null || e.errorMs > old.errorMs ? e : old, null);
  const first = samples[0]; const last = samples.at(-1);
  return { diagnosticOnly: true, formalSourceClockAcceptance: false,
    interpolationErrorIsNotNativeAccuracyProof: true, frozenBoundMs: 1,
    method: 'every-consecutive-triple-middle-held-out-position-from-QPC',
    heldOutCount: errors.length, nonInterpolableTriples,
    exceedsFrozen1msCount: errors.filter((e) => e.exceedsFrozen1ms).length,
    maxHeldOutPositionError: maximum,
    p99HeldOutPositionErrorMs: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : null,
    // Diagnostic durations retain original position/frequency units, not frames.
    nominalPositionSpanSeconds: samples.length >= 2 ? Number(last.clockPosition - first.clockPosition) / Number(first.clockFrequency) : null,
    qpcSpanSeconds: samples.length >= 2 ? Number(last.qpc100ns - first.qpc100ns) / 10000000 : null,
    failedHeldOutSamples: errors.filter((e) => e.exceedsFrozen1ms) };
}
