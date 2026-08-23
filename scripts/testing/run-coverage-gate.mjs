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

export const runCoverageStep = (outputDir, name, command) => {
  const logPath = path.join(outputDir, `${name}.log`);
  console.error(`>>> ${name}: ${command}`);
  const exitCode = runLoggedStep(command, logPath);
  echoLogTail(logPath);
  if (exitCode !== 0) {
    throw new Error(`Coverage gate step failed: ${name}`);
  }
};

export const assertRustCoverage = (name, reportPath, thresholds = { lines: 100, functions: 100, branches: 100 }) => {
  const totals = readJson(reportPath).data[0].totals;
  const metrics = {
    lines: Number(totals.lines.percent),
    functions: Number(totals.functions.percent),
    branches: Number(totals.branches.percent),
  };
  const violations = Object.entries(metrics)
    .filter(([metric, value]) => value < thresholds[metric])
    .map(([metric, value]) => `${metric}=${value}% (minimum ${thresholds[metric]}%)`);
  if (violations.length > 0) {
    throw new Error(`${name} coverage is below baseline: ${violations.join('; ')}`);
  }
};

export const runCoverageGate = ({ outputRoot = defaultOutputRoot, full = false } = {}) => {
  // POSIX has no UAC, so the elevation requirement only exists on Windows.
  if (full && isWindows && !isElevated()) {
    throw new Error('coverage:gate --full must run from an administrator PowerShell because the desktop-shell test executable requires elevation.');
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
    assertRustCoverage(
      'desktop-shell-rust',
      desktopShellReport,
      coverageBaseline['desktop-shell-rust'],
    );
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
