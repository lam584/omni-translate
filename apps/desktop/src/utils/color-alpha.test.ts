import { describe, expect, it } from 'vitest';

import { mixOpacity, withAlpha } from './color-alpha';

describe('color alpha helpers', () => {
  it('normalizes short, long, invalid and whitespace-wrapped colors', () => {
    expect(withAlpha('#abc', 0.5)).toBe('rgba(170, 187, 204, 0.5)');
    expect(withAlpha(' 112233 ', 2)).toBe('rgba(17, 34, 51, 1)');
    expect(withAlpha('bad-color', -1)).toBe('rgba(255, 255, 255, 0)');
  });

  it('clamps both opacity inputs before multiplying', () => {
    expect(mixOpacity(2, 0.5)).toBe(0.5);
    expect(mixOpacity(-1, 0.5)).toBe(0);
  });
});
