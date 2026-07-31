import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mixOpacity, withAlpha } from '../utils/color-alpha';

const stylesDirectory = resolve(process?.cwd() ?? '.', 'src/styles');
const modalCss = readFileSync(resolve(stylesDirectory, 'components/modal.css'), 'utf8');
const diagnosticsCss = readFileSync(resolve(stylesDirectory, 'pages/diagnostics.css'), 'utf8');
const watchReportCss = readFileSync(resolve(stylesDirectory, 'pages/watch-session-report.css'), 'utf8');

function cssHexVariable(name: string): string {
  const match = watchReportCss.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  expect(match, `missing CSS color variable --${name}`).not.toBeNull();
  return match![1];
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

describe('watch report contrast palette', () => {
  it('keeps primary, secondary, and semantic text readable on their surfaces', () => {
    const background = cssHexVariable('watch-report-bg');
    expect(contrastRatio(cssHexVariable('watch-report-ink'), background)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(cssHexVariable('watch-report-muted'), background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(
      cssHexVariable('watch-report-success'),
      cssHexVariable('watch-report-success-bg'),
    )).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(
      cssHexVariable('watch-report-warning'),
      cssHexVariable('watch-report-warning-bg'),
    )).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(
      cssHexVariable('watch-report-danger'),
      cssHexVariable('watch-report-danger-bg'),
    )).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps form-control boundaries distinguishable from the report background', () => {
    expect(contrastRatio(
      cssHexVariable('watch-report-border-strong'),
      cssHexVariable('watch-report-bg'),
    )).toBeGreaterThanOrEqual(3);
  });

  it('keeps native select options on the same readable light palette', () => {
    expect(watchReportCss).toMatch(
      /--color-select-menu-surface:\s*var\(--watch-report-bg\)/,
    );
    expect(watchReportCss).toMatch(
      /\.watch-report-controls option,[\s\S]*?background:\s*var\(--watch-report-bg,[\s\S]*?color:\s*var\(--watch-report-ink/,
    );
    expect(contrastRatio(
      cssHexVariable('watch-report-ink'),
      cssHexVariable('watch-report-bg'),
    )).toBeGreaterThanOrEqual(7);
  });

  it('keeps the report as a viewport-sized modal with internal scrolling', () => {
    expect(watchReportCss).toMatch(
      /\.benchmark-modal\.watch-report-modal\s*\{[\s\S]*?width:\s*min\(1360px,\s*calc\(100vw - 32px\)\);[\s\S]*?height:\s*calc\(100vh - 32px\);[\s\S]*?overflow:\s*hidden;/,
    );
    expect(watchReportCss).toMatch(
      /\.watch-report-modal\s*>\s*\.watch-report\s*\{[\s\S]*?overflow-y:\s*auto;/,
    );
  });

  it('pins every white benchmark-style modal to dark text instead of inherited root tokens', () => {
    expect(diagnosticsCss).toMatch(/\.benchmark-modal\s*\{[\s\S]*?background:#fff;\s*color:#0f172a;/);
    expect(modalCss).toMatch(/\.modal-panel--benchmark\s*\{[\s\S]*?background:#fff;\s*color:#0f172a;/);
  });
});

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
