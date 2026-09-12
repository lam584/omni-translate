import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let builtWorkspace = null;

function executablePath(workspaceRoot) {
  return path.join(workspaceRoot, 'target', 'debug', process.platform === 'win32' ? 'omni-benchmark.exe' : 'omni-benchmark');
}

export function ensureRustAudioAnalyzer({ workspaceRoot = path.resolve('.') } = {}) {
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
}) {
  const executable = ensureRustAudioAnalyzer({ workspaceRoot });
  const args = [
    'audio', 'analyze', '--input', path.resolve(inputPath), '--format', format, '--profile', profile,
    ...frequencies.flatMap((frequency) => ['--frequency', String(frequency)]),
  ];
  if (sampleRateHz !== undefined) args.push('--sample-rate', String(sampleRateHz));
  const result = spawnSync(executable, args, { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Rust audio analysis failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout.trim());
  if (parsed.schemaVersion !== 'omni-audio-analysis/v1' || parsed.profile !== profile) {
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
}) {
  const executable = ensureRustAudioAnalyzer({ workspaceRoot });
  const result = spawnSync(executable, [
    'audio', 'compare',
    '--reference', path.resolve(referencePath),
    '--recorded', path.resolve(recordedPath),
    '--format', 'pcm16le',
    '--sample-rate', String(sampleRateHz),
    '--profile', profile,
    ...wrongReferencePaths.flatMap((filePath) => ['--wrong-reference', path.resolve(filePath)]),
  ], { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Rust audio compare failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout.trim());
  if (parsed.schemaVersion !== 'omni-audio-analysis/v1' || parsed.profile !== profile) {
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
}) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('Rust translated loopback batch requires at least one request');
  }
  const executable = ensureRustAudioAnalyzer({ workspaceRoot });
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
