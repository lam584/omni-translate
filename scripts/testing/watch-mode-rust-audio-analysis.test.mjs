import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { analyzeAudioWithRust, compareAudioWithRust, ensureRustAudioAnalyzer, matchTranslatedLoopbackBatchWithRust } from './watch-mode-rust-audio-analysis.mjs';
import { buildPhysicalSourceWaveformAuthority } from './watch-mode-canonical-source-authority.mjs';

const realSpawnSync = childProcess.spawnSync;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const executableName = process.platform === 'win32' ? 'omni-benchmark.exe' : 'omni-benchmark';
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value), 'utf8');

function fixture(t, { nodeExecutable = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinned analyzer ' \u6d4b\u8bd5 "));
  const releaseExecutablePath = path.join(root, 'target/release', executableName);
  fs.mkdirSync(path.dirname(releaseExecutablePath), { recursive: true });
  if (nodeExecutable) fs.copyFileSync(process.execPath, releaseExecutablePath);
  else fs.writeFileSync(releaseExecutablePath, 'non-executable tooling fixture', 'utf8');
  const run = path.join(root, 'run'); fs.mkdirSync(run);
  const referencePath = path.join(run, 'source-media-reference-16k-mono.pcm');
  const recordedPath = path.join(run, 'physical-output-recording-16k-mono.pcm');
  fs.writeFileSync(referencePath, Buffer.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]));
  fs.writeFileSync(recordedPath, Buffer.from([2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0]));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, run, referencePath, recordedPath,
    options: { workspaceRoot: root, releaseExecutablePath,
      releaseExecutableSha256: sha(fs.readFileSync(releaseExecutablePath)), noBuild: true } };
}

// Builtin interception is confined to each test. In particular, a regression to
// the legacy branch cannot accidentally run Cargo during this no-build suite.
function interceptSpawn(t, implementation) {
  const spy = t.mock.method(childProcess, 'spawnSync', implementation);
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  return spy;
}

function compare(f, options = {}) {
  return compareAudioWithRust({ ...f.options, referencePath: f.referencePath, recordedPath: f.recordedPath,
    profile: 'canonical-waveform-v1', ...options });
}

test('noBuild rejects a wrong or missing pin before any executable or Cargo launch', (t) => {
  const f = fixture(t); const spy = interceptSpawn(t, () => assert.fail('no process may launch with an invalid pin'));
  for (const change of [{ releaseExecutableSha256: 'f'.repeat(64) }, { releaseExecutableSha256: undefined },
    { releaseExecutableSha256: 'F'.repeat(64) }, { releaseExecutablePath: undefined }]) {
    assert.throws(() => compare(f, change), /release analyzer|SHA-256/);
  }
  assert.equal(spy.mock.callCount(), 0);
});

test('pinned analysis respects an absolute deadline without Cargo fallback', (t) => {
  const f = fixture(t);
  const spy = interceptSpawn(t, (_exe, _args, options) => {
    assert.ok(options.timeout > 0 && options.timeout <= 5000);
    assert.equal(options.killSignal, 'SIGKILL');
    return { status: null, error: new Error('ETIMEDOUT'), stdout: '', stderr: '' };
  });
  assert.throws(() => compare(f, { deadlineUtcMs: Date.now() - 1 }), /deadline has expired/u);
  assert.equal(spy.mock.callCount(), 0);
  assert.throws(() => compare(f, { deadlineUtcMs: Date.now() + 5000 }), /ETIMEDOUT/u);
  assert.equal(spy.mock.callCount(), 1);
});

test('noBuild requires the canonical release executable and rejects missing files or junction ancestry', (t) => {
  const f = fixture(t); interceptSpawn(t, () => assert.fail('invalid release path must not launch'));
  for (const releaseExecutablePath of [path.join(f.root, 'target/debug', executableName), process.execPath,
    path.relative(f.root, f.options.releaseExecutablePath)]) {
    assert.throws(() => compare(f, { releaseExecutablePath }), /release analyzer/);
  }
  const otherRoot = path.join(f.root, 'junction-workspace'); fs.mkdirSync(path.join(otherRoot, 'target'), { recursive: true });
  fs.symlinkSync(path.dirname(f.options.releaseExecutablePath), path.join(otherRoot, 'target/release'),
    process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => compare(f, { workspaceRoot: otherRoot,
    releaseExecutablePath: path.join(otherRoot, 'target/release', executableName) }), /non-symlink/);
  fs.unlinkSync(f.options.releaseExecutablePath);
  assert.throws(() => compare(f), /ENOENT/);
});

test('explicit release parameters never silently fall back to a build; pins are rehashed on every call', (t) => {
  const f = fixture(t); interceptSpawn(t, () => assert.fail('ensure must not spawn in pinned mode'));
  for (const noBuild of [false, undefined, 'true']) {
    assert.throws(() => ensureRustAudioAnalyzer({ ...f.options, noBuild }), /noBuild/);
  }
  assert.equal(ensureRustAudioAnalyzer(f.options), f.options.releaseExecutablePath);
  fs.appendFileSync(f.options.releaseExecutablePath, 'changed', 'utf8');
  assert.throws(() => ensureRustAudioAnalyzer(f.options), /SHA-256/);
});

test('legacy API still builds/caches debug only when no explicit release options are supplied (mocked Cargo)', (t) => {
  const f = fixture(t); const debug = path.join(f.root, 'target/debug', executableName);
  const spy = interceptSpawn(t, (command, args) => {
    if (command === 'cargo') {
      assert.deepEqual(args.slice(0, 3), ['build', '--locked', '--manifest-path']);
      fs.mkdirSync(path.dirname(debug), { recursive: true }); fs.writeFileSync(debug, 'tooling debug fixture', 'utf8');
      return { status: 0, stdout: '', stderr: '' };
    }
    assert.equal(command, debug);
    return { status: 0, stdout: JSON.stringify({ schemaVersion: 'omni-audio-analysis/v1', profile: 'canonical-waveform-v1' }) };
  });
  assert.equal(ensureRustAudioAnalyzer({ workspaceRoot: f.root }), debug);
  assert.equal(ensureRustAudioAnalyzer({ workspaceRoot: f.root }), debug);
  assert.equal(spy.mock.callCount(), 1);
  assert.equal(ensureRustAudioAnalyzer(f.options), f.options.releaseExecutablePath, 'debug cache cannot bypass the release pin');
  assert.equal(compareAudioWithRust({ workspaceRoot: f.root, referencePath: f.referencePath,
    recordedPath: f.recordedPath, profile: 'canonical-waveform-v1' }).schemaVersion, 'omni-audio-analysis/v1');
  assert.equal(spy.mock.callCount(), 2);
});

test('real pinned tooling executable receives the release compare codec and canonical authority uses the explicit workspace', (t) => {
  const f = fixture(t, { nodeExecutable: true });
  // Copying Node under the pinned release name exercises a real executable
  // launch, not Rust analysis. This temporary "audio" script returns explicitly
  // failing tooling metrics; these are never physical or release evidence.
  writeJson(path.join(f.root, 'package.json'), { type: 'commonjs' });
  const metrics = { schemaVersion: 'omni-audio-analysis/v1', profile: 'canonical-waveform-v1',
    operation: 'compare', inputFormat: 'pcm16le', globalLagSamples: 0, globalPolarity: 1,
    candidates: [0, 2, 4].map((start) => ({ referenceStartSample: start, recordedStartSample: start,
      samples: 1, waveformCorrelation: 0.001, derivativeCorrelation: 0.001, energyRatio: 1 })),
    wrongReferences: [{ label: 'tooling-negative-control', score: 0.4 }] };
  writeJson(path.join(f.root, 'tooling-metrics.json'), metrics);
  fs.writeFileSync(path.join(f.root, 'audio'), `const fs=require('node:fs');
const argv=process.argv.slice(2);
if(argv[0]!=='compare'){process.stderr.write('unsupported audio command');process.exit(2);}
fs.writeFileSync('tooling-invocation.json',JSON.stringify({argv,cwd:process.cwd()}));
process.stdout.write(fs.readFileSync('tooling-metrics.json','utf8'));`, 'utf8');
  const spy = interceptSpawn(t, (command, args, options) => {
    assert.equal(command, f.options.releaseExecutablePath, 'no Cargo/debug fallback is permitted');
    assert.deepEqual(args.slice(0, 2), ['audio', 'compare']);
    assert.equal(options.cwd, f.root);
    return realSpawnSync(command, args, options);
  });
  const wrong = path.join(f.run, 'wrong reference.pcm'); fs.writeFileSync(wrong, Buffer.from([4, 0]));
  assert.deepEqual(compare(f, { wrongReferencePaths: [wrong] }), metrics);
  const invocation = JSON.parse(fs.readFileSync(path.join(f.root, 'tooling-invocation.json'), 'utf8'));
  assert.deepEqual(invocation, { cwd: f.root, argv: ['compare', '--reference', f.referencePath, '--recorded', f.recordedPath,
    '--format', 'pcm16le', '--sample-rate', '16000', '--profile', 'canonical-waveform-v1', '--wrong-reference', wrong] });
  const authority = buildPhysicalSourceWaveformAuthority({ ...f.options, runDirectory: f.run,
    referencePcmPath: f.referencePath, sourceWindowPath: f.recordedPath, physicalRecordingPcmPath: f.recordedPath });
  assert.equal(authority.passed, false);
  assert.equal(authority.globalWaveformCorrelation, 0.001);
  assert.equal(spy.mock.callCount(), 2, 'canonical helper must forward noBuild, release path, hash and workspace');
  assert.throws(() => buildPhysicalSourceWaveformAuthority({ ...f.options, runDirectory: f.run,
    sourceWindowPath: f.recordedPath, releaseExecutableSha256: 'f'.repeat(64) }), /SHA-256/);
  assert.equal(spy.mock.callCount(), 2, 'hash mismatch must stop before executable invocation');

  fs.writeFileSync(path.join(f.root, 'audio'), "process.stderr.write('unsupported audio compare codec');process.exit(2);", 'utf8');
  assert.throws(() => compare(f), /unsupported audio compare codec/);
  assert.equal(spy.mock.callCount(), 3, 'unsupported release command must fail rather than retry/build');
});

test('pinned mode rejects mismatched or malformed release responses without build/retry', (t) => {
  const f = fixture(t);
  let response;
  const spy = interceptSpawn(t, (command) => {
    assert.equal(command, f.options.releaseExecutablePath);
    return { status: 0, stdout: typeof response === 'string' ? response : JSON.stringify(response) };
  });
  const valid = { schemaVersion: 'omni-audio-analysis/v1', profile: 'canonical-waveform-v1', operation: 'compare', inputFormat: 'pcm16le' };
  for (const invalid of [{ ...valid, schemaVersion: 'wrong' }, { ...valid, profile: 'wrong' },
    { ...valid, operation: 'analyze' }, { ...valid, inputFormat: 'wav' }, 'not JSON']) {
    response = invalid;
    assert.throws(() => compare(f), /unexpected schema\/profile|JSON|Unexpected token/);
  }
  assert.equal(spy.mock.callCount(), 5);
});


test('strict analyze and translated batch use only the hash-pinned release analyzer', (t) => {
  const f = fixture(t);
  const calls = [];
  const spy = interceptSpawn(t, (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, f.options.releaseExecutablePath);
    assert.ok(options.timeout > 0);
    if (args[1] === 'analyze') {
      return { status: 0, stdout: JSON.stringify({
        schemaVersion: 'omni-audio-analysis/v1', profile: 'watch-physical-output/v1',
        operation: 'analyze', inputFormat: 'wav', sampleRateHz: 48_000, sampleCount: 1,
        durationSeconds: 1, rms: 0.1, peak: 0.2, components: [],
      }) };
    }
    assert.deepEqual(args.slice(0, 2), ['audio', 'translated-loopback-batch']);
    return { status: 0, stdout: JSON.stringify({
      schemaVersion: 'omni-audio-analysis/v1', profile: 'translated-loopback-v1',
      operation: 'translated-loopback-batch', results: [{ requestId: 'r1', metrics: { score: 1 } }],
    }) };
  });
  const analyzed = analyzeAudioWithRust({ ...f.options, inputPath: f.recordedPath, format: 'wav' });
  assert.equal(analyzed.operation, 'analyze');
  const batch = matchTranslatedLoopbackBatchWithRust({ ...f.options, recordingPath: f.recordedPath,
    requests: [{ requestId: 'r1', referencePath: f.referencePath, referenceSampleRateHz: 16_000,
      referenceChannels: 1, expectedStartSamples: 0 }] });
  assert.equal(batch.get('r1').score, 1);
  assert.equal(spy.mock.callCount(), 2);
  assert.ok(calls.every((call) => call.command !== 'cargo'));
});

test('strict analyze rejects auto format before process launch while explicit wav remains pinned', (t) => {
  const f = fixture(t);
  const spy = interceptSpawn(t, () => assert.fail('auto format must fail before analyzer or Cargo launch'));
  assert.throws(() => analyzeAudioWithRust({ ...f.options, inputPath: f.recordedPath }),
    /explicit input format/);
  assert.equal(spy.mock.callCount(), 0);
});

test('strict analyze and translated batch reject hash mismatch before process launch', (t) => {
  const f = fixture(t);
  const spy = interceptSpawn(t, () => assert.fail('hash mismatch must not launch Cargo or analyzer'));
  assert.throws(() => analyzeAudioWithRust({ ...f.options, inputPath: f.recordedPath, format: 'wav',
    releaseExecutableSha256: 'f'.repeat(64) }), /SHA-256/);
  assert.throws(() => matchTranslatedLoopbackBatchWithRust({ ...f.options, recordingPath: f.recordedPath,
    releaseExecutableSha256: 'f'.repeat(64), requests: [{ requestId: 'r1', referencePath: f.referencePath }] }), /SHA-256/);
  assert.equal(spy.mock.callCount(), 0);
});
