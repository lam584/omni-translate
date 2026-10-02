import { describe, expect, it } from 'vitest';
import { calculateChrF2, relativeResponseLatency, scoreLatencyRamp } from './benchmarkReportScore';

describe('benchmark metric numeric boundary evidence', () => {
  it.each([null, NaN, Infinity, -Infinity])('rejects nonfinite response timestamps and latency %s', (value) => {
    expect(relativeResponseLatency(value, 10)).toBeNull();
    expect(relativeResponseLatency(10, value)).toBeNull();
    expect(scoreLatencyRamp(value, 10, 100)).toBeNull();
  });
  it('uses relative latency, floors reversed timestamps, and preserves zero', () => {
    expect(relativeResponseLatency(100, 130)).toBe(30);
    expect(relativeResponseLatency(100, 99)).toBe(0);
    expect(relativeResponseLatency(0, 0)).toBe(0);
  });
  it('does not compute semantic similarity against an empty normalized reference', () => {
    expect(calculateChrF2('translation', ' \n\t')).toBeNull();
    expect(calculateChrF2('', 'reference')).toBeNull();
    expect(calculateChrF2('a', 'z')?.score).toBe(0);
  });
});
