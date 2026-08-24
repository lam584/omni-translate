import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertRustCoverage,
  validateRustCoverageThresholds,
} from './run-coverage-gate.mjs';

const fixtureThresholds = {
  lines: 61.47,
  functions: 52.34,
  branches: 40.12,
};

const writeCoverageReport = (t, metrics = fixtureThresholds) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reportPath = path.join(dir, 'coverage.json');
  const totals = Object.fromEntries(
    Object.entries(metrics).map(([metric, percent]) => [metric, { percent }]),
  );
  fs.writeFileSync(reportPath, JSON.stringify({ data: [{ totals }] }), 'utf8');
  return reportPath;
};

test('Rust coverage equal to every configured threshold passes', (t) => {
  const reportPath = writeCoverageReport(t);
  assert.doesNotThrow(() => assertRustCoverage('desktop-shell-rust', reportPath, fixtureThresholds));
});

for (const metric of Object.keys(fixtureThresholds)) {
  test(`Rust ${metric} coverage below its configured threshold fails`, (t) => {
    const reportPath = writeCoverageReport(t, {
      ...fixtureThresholds,
      [metric]: fixtureThresholds[metric] - 0.01,
    });
    assert.throws(
      () => assertRustCoverage('desktop-shell-rust', reportPath, fixtureThresholds),
      new RegExp(`desktop-shell-rust coverage failed: ${metric} coverage is .* below ${fixtureThresholds[metric]}%`),
    );
  });
}

test('Rust coverage reports every failing metric in one diagnostic', (t) => {
  const reportPath = writeCoverageReport(t, {
    lines: fixtureThresholds.lines - 0.01,
    functions: fixtureThresholds.functions - 0.01,
    branches: fixtureThresholds.branches - 0.01,
  });
  assert.throws(
    () => assertRustCoverage('desktop-shell-rust', reportPath, fixtureThresholds),
    (error) => ['lines', 'functions', 'branches'].every((metric) =>
      error.message.includes(`${metric} coverage is`)),
  );
});

test('Rust coverage rejects a missing baseline and missing metrics', (t) => {
  const reportPath = writeCoverageReport(t);
  assert.throws(
    () => assertRustCoverage('desktop-shell-rust', reportPath, undefined),
    /desktop-shell-rust coverage baseline must be an object/,
  );
  assert.throws(
    () => assertRustCoverage('desktop-shell-rust', reportPath, {
      lines: fixtureThresholds.lines,
      functions: fixtureThresholds.functions,
    }),
    /desktop-shell-rust coverage baseline is missing branches/,
  );
});

test('Rust coverage rejects non-finite, non-numeric, and out-of-range baseline values', () => {
  for (const invalid of [null, '61.47', Number.NaN, Number.POSITIVE_INFINITY, -0.01, 100.01]) {
    assert.throws(
      () => validateRustCoverageThresholds('desktop-shell-rust', {
        ...fixtureThresholds,
        lines: invalid,
      }),
      /desktop-shell-rust lines coverage baseline must be a finite number between 0 and 100/,
    );
  }
});

test('Rust coverage rejects missing, non-finite, non-numeric, and out-of-range report values', (t) => {
  for (const invalid of [undefined, null, '61.47', Number.NaN, Number.POSITIVE_INFINITY, -0.01, 100.01]) {
    const reportPath = writeCoverageReport(t, {
      ...fixtureThresholds,
      lines: invalid,
    });
    assert.throws(
      () => assertRustCoverage('desktop-shell-rust', reportPath, fixtureThresholds),
      /desktop-shell-rust lines coverage report must be a finite number between 0 and 100/,
    );
  }
});
