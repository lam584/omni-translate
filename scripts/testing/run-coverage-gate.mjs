import path from 'node:path';
import {
  compactTimestamp,
  echoLogTail,
  ensureDir,
  isElevated,
  isMain,
  isWindows,
  parseCliArgs,
  readJson,
  repoRoot,
  runLoggedStep,
} from '../lib/testing-common.mjs';

const defaultOutputRoot = 'artifacts/logs/testing/coverage';
const nightlyToolchain = 'nightly-2026-06-01';
const coverageBaseline = readJson(path.join(repoRoot, 'scripts/testing/coverage-baseline.json'));
const rustCoverageMetrics = ['lines', 'functions', 'branches'];

export const validateRustCoverageThresholds = (name, thresholds) => {
  if (thresholds === null || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    throw new Error(`${name} coverage baseline must be an object with lines, functions, and branches.`);
  }

  for (const metric of rustCoverageMetrics) {
    if (!Object.hasOwn(thresholds, metric)) {
      throw new Error(`${name} coverage baseline is missing ${metric}.`);
    }
    const threshold = thresholds[metric];
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      throw new Error(`${name} ${metric} coverage baseline must be a finite number between 0 and 100.`);
    }
  }

  return thresholds;
};

export const runCoverageStep = (outputDir, name, command) => {
  const logPath = path.join(outputDir, `${name}.log`);
  console.error(`>>> ${name}: ${command}`);
  const exitCode = runLoggedStep(command, logPath);
  echoLogTail(logPath);
  if (exitCode !== 0) {
    throw new Error(`Coverage gate step failed: ${name}`);
  }
};

export const assertRustCoverage = (name, reportPath, thresholds) => {
  validateRustCoverageThresholds(name, thresholds);
  const totals = readJson(reportPath)?.data?.[0]?.totals;
  if (totals === null || typeof totals !== 'object' || Array.isArray(totals)) {
    throw new Error(`${name} coverage report must contain data[0].totals.`);
  }
  const metrics = Object.fromEntries(rustCoverageMetrics.map((metric) => {
    const value = totals[metric]?.percent;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`${name} ${metric} coverage report must be a finite number between 0 and 100.`);
    }
    return [metric, value];
  }));
  const failures = Object.entries(metrics)
    .filter(([metric, value]) => value < thresholds[metric])
    .map(([metric, value]) => `${metric} coverage is ${value}%, below ${thresholds[metric]}%`);
  if (failures.length > 0) {
    throw new Error(`${name} coverage failed: ${failures.join('; ')}.`);
  }
};

export const runCoverageGate = ({ outputRoot = defaultOutputRoot, full = false } = {}) => {
  // POSIX has no UAC, so the elevation requirement only exists on Windows.
  if (full && isWindows && !isElevated()) {
    throw new Error('coverage:gate --full must run from an administrator PowerShell because the desktop-shell test executable requires elevation.');
  }

  const activeRustBaselines = full
    ? ['desktop-shell-rust', 'native-bridge-rust', 'shared-crates-rust']
    : ['native-bridge-rust', 'shared-crates-rust'];
  for (const name of activeRustBaselines) {
    validateRustCoverageThresholds(name, coverageBaseline[name]);
  }

  const outputDir = ensureDir(path.resolve(repoRoot, outputRoot, compactTimestamp()));

  runCoverageStep(outputDir, 'desktop-frontend', 'npm run test:desktop-coverage');

  if (full) {
    const desktopShellReport = path.join(outputDir, 'desktop-shell.json');
    runCoverageStep(
      outputDir,
      'desktop-shell-rust',
      `cargo +${nightlyToolchain} llvm-cov --manifest-path apps/desktop/src-tauri/Cargo.toml --branch --json --output-path "${desktopShellReport}"`,
    );
    assertRustCoverage('desktop-shell-rust', desktopShellReport, coverageBaseline['desktop-shell-rust']);
  }

  const nativeBridgeReport = path.join(outputDir, 'native-bridge.json');
  runCoverageStep(
    outputDir,
    'native-bridge-rust',
    `cargo +${nightlyToolchain} llvm-cov --manifest-path apps/bridge-service-native/Cargo.toml --branch --json --output-path "${nativeBridgeReport}"`,
  );
  assertRustCoverage('native-bridge-rust', nativeBridgeReport, coverageBaseline['native-bridge-rust']);

  // Shared workspace crates (audio-dsp / bridge-protocol / logging) were
  // previously outside every coverage gate. Keep their measured baseline in
  // the shared manifest so local and CI gates use the same ratchet. Raise it
  // when coverage improves; never lower it.
  const sharedCratesReport = path.join(outputDir, 'shared-crates.json');
  runCoverageStep(
    outputDir,
    'shared-crates-rust',
    `cargo +${nightlyToolchain} llvm-cov -p omni-audio-dsp -p omni-bridge-protocol -p omni-logging --branch --json --output-path "${sharedCratesReport}"`,
  );
  assertRustCoverage('shared-crates-rust', sharedCratesReport, coverageBaseline['shared-crates-rust']);

  return outputDir;
};

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), {
      booleans: ['full'],
      defaults: { outputRoot: defaultOutputRoot },
    });
    console.log(runCoverageGate(args));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
