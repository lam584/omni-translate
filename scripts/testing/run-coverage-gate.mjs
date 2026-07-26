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

export const runCoverageStep = (outputDir, name, command) => {
  const logPath = path.join(outputDir, `${name}.log`);
  console.error(`>>> ${name}: ${command}`);
  const exitCode = runLoggedStep(command, logPath);
  echoLogTail(logPath);
  if (exitCode !== 0) {
    throw new Error(`Coverage gate step failed: ${name}`);
  }
};

export const assertRustCoverage = (name, reportPath) => {
  const totals = readJson(reportPath).data[0].totals;
  const metrics = {
    lines: Number(totals.lines.percent),
    functions: Number(totals.functions.percent),
    branches: Number(totals.branches.percent),
  };
  for (const [metric, value] of Object.entries(metrics)) {
    if (value < 100) {
      throw new Error(`${name} ${metric} coverage is ${value}%, below 100%.`);
    }
  }
};

export const runCoverageGate = ({ outputRoot = defaultOutputRoot } = {}) => {
  // POSIX has no UAC, so the elevation requirement only exists on Windows.
  if (isWindows && !isElevated()) {
    throw new Error('coverage:gate must run from an administrator PowerShell because the desktop-shell test executable requires elevation.');
  }

  const outputDir = ensureDir(path.resolve(repoRoot, outputRoot, compactTimestamp()));

  runCoverageStep(outputDir, 'desktop-frontend', 'npm run test:desktop-coverage');

  const desktopShellReport = path.join(outputDir, 'desktop-shell.json');
  runCoverageStep(
    outputDir,
    'desktop-shell-rust',
    `cargo +${nightlyToolchain} llvm-cov --manifest-path apps/desktop/src-tauri/Cargo.toml --branch --json --output-path "${desktopShellReport}"`,
  );
  assertRustCoverage('desktop-shell-rust', desktopShellReport);

  const nativeBridgeReport = path.join(outputDir, 'native-bridge.json');
  runCoverageStep(
    outputDir,
    'native-bridge-rust',
    `cargo +${nightlyToolchain} llvm-cov --manifest-path apps/bridge-service-native/Cargo.toml --branch --json --output-path "${nativeBridgeReport}"`,
  );
  assertRustCoverage('native-bridge-rust', nativeBridgeReport);

  return outputDir;
};

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), { defaults: { outputRoot: defaultOutputRoot } });
    console.log(runCoverageGate(args));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
