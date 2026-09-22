import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let builtWorkspace = null;

function executablePath(workspaceRoot, configuration = 'debug') {
  return path.join(workspaceRoot, 'target', configuration, process.platform === 'win32' ? 'omni-benchmark.exe' : 'omni-benchmark');
}

function pinnedReleaseAnalyzer({ workspaceRoot, releaseExecutablePath, releaseExecutableSha256 }) {
  if (typeof releaseExecutableSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(releaseExecutableSha256)) {
    throw new Error('pinned release analyzer requires an explicit lowercase SHA-256');
  }
  if (typeof releaseExecutablePath !== 'string' || !path.isAbsolute(releaseExecutablePath)) {
    throw new Error('pinned release analyzer requires an explicit absolute executable path');
  }
  const requestedRoot = path.resolve(workspaceRoot);
  const rootStat = fs.lstatSync(requestedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('release analyzer workspace must be a non-symlink directory');
  const root = fs.realpathSync.native(requestedRoot);
  const expected = executablePath(root, 'release');
  const identity = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (identity(path.resolve(releaseExecutablePath)) !== identity(expected)) {
    throw new Error('pinned release analyzer must be the workspace target/release/omni-benchmark executable');
  }
  let current = root;
  const parts = path.relative(root, expected).split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('pinned release analyzer requires regular non-symlink ancestry');
    }
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(expected)).digest('hex');
  if (actual !== releaseExecutableSha256) throw new Error('pinned release analyzer SHA-256 mismatch');
  return expected;
}

export function ensureRustAudioAnalyzer({ workspaceRoot = path.resolve('.'),
  releaseExecutablePath, releaseExecutableSha256, noBuild = false } = {}) {
  if (typeof noBuild !== 'boolean') throw new Error('noBuild must be a boolean');
  if (noBuild || releaseExecutablePath !== undefined || releaseExecutableSha256 !== undefined) {
    if (!noBuild) throw new Error('explicit release analyzer parameters require noBuild: true');
    // Deliberately before the debug cache: rehash every pinned invocation and
    // never fall back to an existing debug binary or an implicit Cargo build.
    return pinnedReleaseAnalyzer({ workspaceRoot, releaseExecutablePath, releaseExecutableSha256 });
  }
  const root = path.resolve(workspaceRoot);
  const executable = executablePath(root);
  if (builtWorkspace === root && fs.existsSync(executable)) return executable;
  const build = spawnSync('cargo', [
    'build', '--locked', '--manifest-path',
    path.join(root, 'scripts', 'diagnostics', 'omni-benchmark', 'Cargo.toml'),
  ], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CARGO_TARGET_DIR: path.join(root, 'target') },
  });
  if (build.status !== 0 || !fs.existsSync(executable)) {
    throw new Error(`Rust audio analyzer build failed: ${build.stderr || build.stdout}`);
  }
  builtWorkspace = root;
  return executable;
}

export function analyzeAudioWithRust({
  inputPath,
  format = 'auto',
  sampleRateHz,
  profile = 'watch-physical-output/v1',
  frequencies = [],
  workspaceRoot = path.resolve('.'),
  releaseExecutablePath,
  releaseExecutableSha256,
  noBuild = false,
  deadlineUtcMs,
}) {
  if (noBuild && format === 'auto') {
    throw new Error('pinned release audio analysis requires an explicit input format');
  }
  const deadline = noBuild ? (deadlineUtcMs ?? Date.now() + 30_000) : null;
  if (noBuild && (!Number.isFinite(deadline) || deadline <= Date.now())) {
    throw new Error('pinned release audio analyzer deadline has expired');
  }
  const executable = ensureRustAudioAnalyzer({ workspaceRoot, releaseExecutablePath, releaseExecutableSha256, noBuild });
  const args = [
    'audio', 'analyze', '--input', path.resolve(inputPath), '--format', format, '--profile', profile,
    ...frequencies.flatMap((frequency) => ['--frequency', String(frequency)]),
  ];
  if (sampleRateHz !== undefined) args.push('--sample-rate', String(sampleRateHz));
  const remaining = deadline === null ? null : Math.ceil(deadline - Date.now());
  if (remaining !== null && remaining <= 0) throw new Error('pinned release audio analyzer deadline expired during verification');
  const result = spawnSync(executable, args, { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true,
    ...(remaining === null ? {} : { timeout: remaining, killSignal: 'SIGKILL' }) });
  if (result.status !== 0) throw new Error(`Rust audio analysis failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout.trim());
  if (parsed.schemaVersion !== 'omni-audio-analysis/v1' || parsed.profile !== profile
      || (noBuild && (parsed.operation !== 'analyze' || parsed.inputFormat !== format))) {
    throw new Error(`Rust audio analysis returned an unexpected schema/profile: ${result.stdout}`);
  }
  return parsed;
}

export function compareAudioWithRust({
  referencePath,
  recordedPath,
  sampleRateHz = 16_000,
  profile,
  wrongReferencePaths = [],
  workspaceRoot = path.resolve('.'),
  releaseExecutablePath,
  releaseExecutableSha256,
  noBuild = false,
  deadlineUtcMs,
}) {
  const deadline = noBuild ? (deadlineUtcMs ?? Date.now() + 30_000) : null;
  if (noBuild && (!Number.isFinite(deadline) || deadline <= Date.now())) {
    throw new Error('pinned release audio analyzer deadline has expired');
  }
  const executable = ensureRustAudioAnalyzer({ workspaceRoot, releaseExecutablePath, releaseExecutableSha256, noBuild });
  const remaining = deadline === null ? null : Math.ceil(deadline - Date.now());
  if (remaining !== null && remaining <= 0) throw new Error('pinned release audio analyzer deadline expired during verification');
  const result = spawnSync(executable, [
    'audio', 'compare',
    '--reference', path.resolve(referencePath),
    '--recorded', path.resolve(recordedPath),
    '--format', 'pcm16le',
    '--sample-rate', String(sampleRateHz),
    '--profile', profile,
    ...wrongReferencePaths.flatMap((filePath) => ['--wrong-reference', path.resolve(filePath)]),
  ], { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true,
    ...(remaining === null ? {} : { timeout: remaining, killSignal: 'SIGKILL' }) });
  if (result.status !== 0) throw new Error(`Rust audio compare failed: ${result.error?.message || result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout.trim());
  if (parsed.schemaVersion !== 'omni-audio-analysis/v1' || parsed.profile !== profile
      || (noBuild && (parsed.operation !== 'compare' || parsed.inputFormat !== 'pcm16le'))) {
    throw new Error(`Rust audio compare returned an unexpected schema/profile: ${result.stdout}`);
  }
  return parsed;
}

export function matchTranslatedLoopbackWithRust({
  referencePath,
  recordingPath,
  referenceSampleRateHz,
  referenceChannels,
  referenceOffsetSamples = 0,
  referenceSampleCount,
  expectedStartSamples,
  workspaceRoot = path.resolve('.'),
}) {
  const executable = ensureRustAudioAnalyzer({ workspaceRoot });
  const args = [
    'audio', 'compare',
    '--reference', path.resolve(referencePath),
    '--recorded', path.resolve(recordingPath),
    '--format', 'pcm16le',
    '--sample-rate', '16000',
    '--profile', 'translated-loopback-v1',
    '--reference-sample-rate', String(referenceSampleRateHz),
    '--reference-channels', String(referenceChannels),
    '--reference-offset-samples', String(referenceOffsetSamples),
    '--expected-start-samples', String(expectedStartSamples),
  ];
  if (referenceSampleCount !== undefined) args.push('--reference-sample-count', String(referenceSampleCount));
  const result = spawnSync(executable, args, { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Rust translated loopback analysis failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout.trim());
  if (parsed.schemaVersion !== 'omni-audio-analysis/v1' || parsed.profile !== 'translated-loopback-v1') {
    throw new Error(`Rust translated loopback analysis returned an unexpected schema/profile: ${result.stdout}`);
  }
  return parsed;
}

export function matchTranslatedLoopbackBatchWithRust({
  recordingPath,
  requests,
  workspaceRoot = path.resolve('.'),
  releaseExecutablePath,
  releaseExecutableSha256,
  noBuild = false,
  deadlineUtcMs,
}) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('Rust translated loopback batch requires at least one request');
  }
  const deadline = noBuild ? (deadlineUtcMs ?? Date.now() + 30_000) : null;
  if (noBuild && (!Number.isFinite(deadline) || deadline <= Date.now())) {
    throw new Error('pinned release audio analyzer deadline has expired');
  }
  const executable = ensureRustAudioAnalyzer({ workspaceRoot, releaseExecutablePath, releaseExecutableSha256, noBuild });
  const remaining = deadline === null ? null : Math.ceil(deadline - Date.now());
  if (remaining !== null && remaining <= 0) throw new Error('pinned release audio analyzer deadline expired during verification');
  const result = spawnSync(executable, [
    'audio', 'translated-loopback-batch',
    '--recorded', path.resolve(recordingPath),
    '--format', 'pcm16le',
    '--sample-rate', '16000',
  ], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    input: JSON.stringify(requests.map((request) => ({
      ...request,
      referencePath: path.resolve(request.referencePath),
    }))),
    maxBuffer: 64 * 1024 * 1024,
    ...(remaining === null ? {} : { timeout: remaining, killSignal: 'SIGKILL' }),
  });
  if (result.status !== 0) {
    throw new Error(`Rust translated loopback batch analysis failed: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout.trim());
  if (
    parsed.schemaVersion !== 'omni-audio-analysis/v1'
    || parsed.profile !== 'translated-loopback-v1'
    || parsed.operation !== 'translated-loopback-batch'
    || !Array.isArray(parsed.results)
  ) {
    throw new Error(`Rust translated loopback batch analysis returned an unexpected schema/profile: ${result.stdout}`);
  }
  return new Map(parsed.results.map((entry) => [entry.requestId, entry.metrics]));
}
