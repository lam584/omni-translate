import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { AUTHORITY_RUNTIME_BINARY_FILES } from './watch-mode-evidence-authority.mjs';
import {
  buildProbePowerShell, executeProbePowerShell, parsePhysicalSourceProbeArgs,
  runPhysicalSourceProbe, verifyProbeRuntime, PHYSICAL_SOURCE_PROBE_SUPPORT_FILES,
} from './watch-mode-physical-source-probe.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value), 'utf8');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const resign = (value) => {
  const core = { ...value }; delete core.distributionDigest;
  return { ...core, distributionDigest: sha(JSON.stringify(canonicalize(core))) };
};
const successfulCustody = () => ({ schemaVersion: 1, artifactKind: 'watch-mode-physical-source-probe-process-custody',
  passed: true, ownedTreeExited: true, streamsDrained: true, errors: [], providerCalls: 0 });

// All artifacts below are temporary TOOLING FIXTURES, not hardware/release evidence.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "physical probe ' \u6d4b\u8bd5 "));
  const outputParent = path.join(root, 'out'); fs.mkdirSync(outputParent);
  const canonical = path.join(root, 'scripts/testing/fixtures/watch-mode-en-original.wav');
  fs.mkdirSync(path.dirname(canonical), { recursive: true }); fs.writeFileSync(canonical, 'tooling-fixture-only', 'utf8');
  const files = [...AUTHORITY_RUNTIME_BINARY_FILES, ...PHYSICAL_SOURCE_PROBE_SUPPORT_FILES].map((relative) => {
    const absolute = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const bytes = Buffer.from(`non-executable tooling fixture: ${relative}`); fs.writeFileSync(absolute, bytes);
    return { path: relative, bytes: bytes.length, sha256: sha(bytes) };
  });
  const manifest = path.join(root, 'runtime-distribution.json');
  json(manifest, resign({ schemaVersion: 1, artifactKind: 'watch-mode-local-isolation-runtime-distribution', files }));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const options = { workspaceRoot: root, outputParent, runtimeManifestPath: manifest,
    distributionDigest: read(manifest).distributionDigest,
    virtualRenderEndpointId: 'virtual-id', physicalPlaybackDeviceId: 'physical-id', deadlineSeconds: 180 };
  return { root, outputParent, canonical, manifest, options };
}

// Shape/hash tests deliberately select each adversarial manifest's digest so
// they exercise the independent validation, not just the pinned-digest check.
const verifySelectedFixture = (f) => verifyProbeRuntime({ ...f.options, distributionDigest: read(f.manifest).distributionDigest });

function writeObservation(f, outputDirectory) {
  const runMarker = `watch_mode_physical_source_probe.run_id=${path.basename(outputDirectory)}`;
  const observation = { schemaVersion: 1, artifactKind: 'watch-mode-physical-source-probe-route-observation',
    runMarker, providerCalls: 0, recordSeconds: 136,
    virtualEndpoint: { resolvedDeviceId: 'virtual-id', resolvedDeviceName: 'Omni Translate Virtual Speaker' },
    initRequest: { type: 'bridge.init', sessionId: runMarker, sourceCaptureMode: 'virtual-driver',
      physicalPlaybackDeviceId: 'physical-id', mixControl: { keepOriginalAudio: true } },
    init: { type: 'bridge.state.snapshot', bridgeState: 'running', sourceCaptureMode: 'virtual-driver',
      resolvedPhysicalPlaybackDeviceId: 'physical-id', sourceFramesCaptured: 0 },
    stateAfter: { type: 'bridge.state.snapshot', bridgeState: 'running', sourceCaptureMode: 'virtual-driver',
      resolvedPhysicalPlaybackDeviceId: 'physical-id', sourceFramesCaptured: 100 },
    playback: { playbackMode: 'wasapi-media-injector', endpointId: 'virtual-id', sourceGainDb: -5,
      postrollSilenceSeconds: 3, renderedFrames: 1, mediaPath: f.canonical, mediaSha256: sha(fs.readFileSync(f.canonical)),
      referencePcmPath: path.join(outputDirectory, 'source-media-reference-16k-mono.pcm') },
    recording: { passed: true, skipped: false, probeKind: 'physical-output-recording',
      physicalPlaybackDeviceId: 'physical-id', resolvedPhysicalPlaybackDeviceId: 'physical-id',
      recordingPath: path.join(outputDirectory, 'physical-output-recording.wav'),
      transcriptionPcmPath: path.join(outputDirectory, 'physical-output-recording-16k-mono.pcm') } };
  json(path.join(outputDirectory, 'route-observation.json'), observation);
  json(path.join(outputDirectory, 'cleanup.json'), { schemaVersion: 1,
    artifactKind: 'watch-mode-physical-source-probe-cleanup', passed: true, errors: [], providerCalls: 0 });
  return observation;
}

test('runtime integrity checks every one of the 15 required authority files', (t) => {
  const f = fixture(t);
  const verified = verifyProbeRuntime(f.options);
  assert.equal(verified.files.length, 15);
  assert.deepEqual(verified.files.map((entry) => entry.path), [...AUTHORITY_RUNTIME_BINARY_FILES]);
  for (const entry of verified.files) {
    const file = path.join(f.root, entry.path); const before = fs.readFileSync(file);
    const changed = Buffer.from(before); changed[0] ^= 1; fs.writeFileSync(file, changed);
    assert.throws(() => verifyProbeRuntime(f.options), /runtime file differs/, entry.path);
    fs.writeFileSync(file, before);
  }
});

test('omitting any required binary is rejected even with a valid recomputed manifest digest', (t) => {
  const f = fixture(t); const original = read(f.manifest);
  for (const required of AUTHORITY_RUNTIME_BINARY_FILES) {
    json(f.manifest, resign({ ...original, files: original.files.filter((entry) => entry.path !== required) }));
    assert.throws(() => verifySelectedFixture(f), /does not authorize/, required);
  }
});

test('kind, schema and recomputed digest are checked independently', (t) => {
  const f = fixture(t); const original = read(f.manifest);
  for (const invalid of [resign({ ...original, artifactKind: 'wrong-kind' }), resign({ ...original, schemaVersion: 2 }),
    { ...original, distributionDigest: 'f'.repeat(64) }, { ...original, extra: 'digest must cover extra fields' }]) {
    json(f.manifest, invalid);
    assert.throws(() => verifyProbeRuntime(f.options), /unsupported|digest mismatch/);
  }
});

test('rejects rehashed duplicates including Windows case aliases and malformed hash/size entries', (t) => {
  const f = fixture(t); const original = read(f.manifest);
  for (const entry of [original.files[0], { ...original.files[0], path: original.files[0].path.toUpperCase() }]) {
    json(f.manifest, resign({ ...original, files: [...original.files, entry] }));
    assert.throws(() => verifySelectedFixture(f), /duplicate paths/);
  }
  for (const change of [{ bytes: '1' }, { bytes: -1 }, { bytes: 1.5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { sha256: 'f'.repeat(63) }, { sha256: 'F'.repeat(64) }, { sha256: null }]) {
    const value = structuredClone(original); Object.assign(value.files[0], change);
    json(f.manifest, resign(value)); assert.throws(() => verifySelectedFixture(f), /hash\/size/);
  }
});

test('all manifest paths fail closed before reading traversal, ADS, devices, or ambiguous Windows aliases', (t) => {
  const f = fixture(t); const original = read(f.manifest);
  for (const unsafe of ['../outside', '/absolute', 'E:/absolute', 'E:relative', '\\\\server\\share',
    'target\\release\\alias', 'target//alias', './alias', 'target/../alias', 'target/file:stream',
    'target/file.', 'target/file ', 'target/CON', 'target/NUL.exe', 'target/COM1.txt', 'target/COM\u00b2.txt',
    'target/CONOUT$', 'target/a\0b', null]) {
    json(f.manifest, resign({ ...original, files: [...original.files, { ...original.files[0], path: unsafe }] }));
    assert.throws(() => verifySelectedFixture(f), /unsafe path/, String(unsafe));
  }
});

test('verifies extra distribution files and refuses junction ancestry even inside the workspace', (t) => {
  const f = fixture(t); const original = read(f.manifest); const extra = path.join(f.root, 'extra.txt');
  fs.writeFileSync(extra, 'original', 'utf8');
  json(f.manifest, resign({ ...original, files: [...original.files, { path: 'extra.txt', bytes: 8, sha256: sha('original') }] }));
  assert.equal(verifySelectedFixture(f).verifiedDistributionFileCount, original.files.length + 1);
  fs.writeFileSync(extra, 'modified', 'utf8');
  assert.throws(() => verifySelectedFixture(f), /runtime file differs/);
  fs.symlinkSync(path.join(f.root, 'target/release'), path.join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const source = original.files[0];
  json(f.manifest, resign({ ...original, files: [...original.files, { ...source, path: `alias/${path.basename(source.path)}` }] }));
  assert.throws(() => verifySelectedFixture(f), /non-symlink ancestry/);
});

test('explicitly selected distribution digest is mandatory and cannot be replaced by a self-hashed manifest', (t) => {
  const f = fixture(t); const original = read(f.manifest);
  for (const distributionDigest of [undefined, '', 'f'.repeat(64)]) {
    assert.throws(() => verifyProbeRuntime({ ...f.options, distributionDigest }), /selected distribution digest/);
  }
  json(f.manifest, resign({ ...original, unrelated: 'otherwise valid distribution' }));
  assert.throws(() => verifyProbeRuntime(f.options), /selected distribution digest/);
});

test('requires every probe helper and canonical media dependency in the selected inventory', (t) => {
  const f = fixture(t); const original = read(f.manifest);
  for (const required of PHYSICAL_SOURCE_PROBE_SUPPORT_FILES) {
    json(f.manifest, resign({ ...original, files: original.files.filter((entry) => entry.path !== required) }));
    assert.throws(() => verifySelectedFixture(f), /does not authorize/, required);
  }
});

test('generated route uses the production playback helper and bounded diagnostic recorder, never a fabricated terminal', (t) => {
  const f = fixture(t);
  const script = buildProbePowerShell({ ...f.options, outputDirectory: f.outputParent, mediaPath: f.canonical, runMarker: 'run' });
  assert.match(script, /New-BridgeSourceProbeInitPayload 'virtual-driver'/);
  assert.match(script, /Start-TestMediaPlayback -PathToMedia .* -PlaybackEndpointId 'virtual-id'/);
  assert.match(script, /keepOriginalAudio -ne \$true/);
  assert.match(script, /sourceGainDb -ne -5/);
  assert.match(script, /postrollSilenceSeconds -ne 3/);
  assert.match(script, /Get-RenderEndpointRegistryIdentity -RequestedDeviceId 'virtual-id'/);
  assert.match(script, /sourceFramesCaptured -le \$init.sourceFramesCaptured/);
  assert.match(script, /\$init.type -cne 'bridge.state.snapshot'/);
  assert.match(script, /omni-physical-output-probe\.exe/);
  assert.match(script, /"--record-seconds" "136"/);
  assert.match(script, /"--physical-playback-device-id" "physical-id"/);
  assert.ok(script.indexOf('OutputEncoding=') < script.indexOf('Import-Module'));
  assert.doesNotMatch(script, /terminal\.json|--terminal-|cellId|leaseId|taskkill|GetProcessById|Stop-Process|Start-TestMediaPlaybackViaDefaultEndpoint/);
  assert.doesNotMatch(script, /catch\s*\{\s*\}/);
  if (process.platform === 'win32') {
    const parse = `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$tokens=$null;$errors=$null
[Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors)|Out-Null
$errors|ForEach-Object {[Console]::Error.WriteLine($_.ToString())}
if($errors.Count){exit 1}`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(parse, 'utf16le').toString('base64')], { input: script, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('orchestration reports signed waveform diagnostics at 24.010s, never content/release approval', async (t) => {
  const f = fixture(t);
  for (const passed of [false, true]) {
    const result = await runPhysicalSourceProbe(f.options, { allowNonWindows: true,
      executePowerShell: async (_script, options) => {
        assert.equal(options.deadlineSeconds, 180);
        writeObservation(f, options.outputDirectory); return successfulCustody();
      },
      buildWaveformAuthority: (options) => {
        assert.equal(options.sourceWindowPath, path.join(options.runDirectory, 'physical-output-recording-16k-mono.pcm'));
        assert.equal(options.workspaceRoot, f.root);
        assert.equal(options.noBuild, true);
        assert.equal(options.releaseExecutablePath, path.join(f.root, 'target/release/omni-benchmark.exe'));
        assert.equal(options.releaseExecutableSha256, read(f.manifest).files.find((entry) => entry.path === 'target/release/omni-benchmark.exe').sha256);
        return { passed, sampleRateHz: 16000, candidates: [{ referenceStartSample: 384160, derivativeCorrelation: 0.023 }] };
      },
    });
    assert.equal(result.passed, passed);
    assert.equal(result.providerCalls, 0);
    assert.equal(result.routeMatchedC02, true);
    assert.equal(result.diagnosticOnly, true);
    assert.equal(result.contentVerdict, 'not-evaluated');
    assert.equal(result.publicationVerdict, 'not-applicable');
    assert.equal(result.analyzerAuthority.path, 'target/release/omni-benchmark.exe');
    assert.equal(result.referenceSegment.requestedOffsetSeconds, 24.010);
    assert.equal(result.referenceSegment.observed.referenceStartSample, 384160);
    assert.equal(fs.existsSync(path.join(f.outputParent, result.executionId, 'terminal.json')), false);
  }
});

test('route observations must actually match every c02 identity, gain and recorder result', async (t) => {
  const f = fixture(t);
  for (const mutate of [
    (o) => { o.runMarker = 'unrelated'; }, (o) => { o.initRequest.mixControl.keepOriginalAudio = false; },
    (o) => { o.init.type = 'bridge.ready'; }, (o) => { o.virtualEndpoint.resolvedDeviceName = 'physical speaker'; },
    (o) => { o.stateAfter.sourceFramesCaptured = 0; },
    (o) => { o.initRequest.physicalPlaybackDeviceId = 'other'; }, (o) => { o.playback.endpointId = 'other'; },
    (o) => { o.playback.sourceGainDb = 5; }, (o) => { o.playback.postrollSilenceSeconds = 0; },
    (o) => { o.playback.mediaSha256 = 'f'.repeat(64); }, (o) => { o.recording.resolvedPhysicalPlaybackDeviceId = 'virtual-id'; },
    (o) => { o.recording.skipped = true; }, (o) => { o.recording.transcriptionPcmPath = f.canonical; },
  ]) {
    await assert.rejects(runPhysicalSourceProbe(f.options, { allowNonWindows: true,
      executePowerShell: async (_script, options) => {
        const observation = writeObservation(f, options.outputDirectory); mutate(observation);
        json(path.join(options.outputDirectory, 'route-observation.json'), observation); return successfulCustody();
      }, buildWaveformAuthority: () => assert.fail('bad route must not reach waveform analysis'),
    }), /does not match the c02 request/);
  }
});

test('capture and no-build analysis share one absolute deadline without renewing its budget', async (t) => {
  const f = fixture(t);
  const started = Date.now();
  let now = started;
  t.mock.method(Date, 'now', () => now);
  let custodyDeadline;
  let analyses = 0;
  const result = await runPhysicalSourceProbe(f.options, { allowNonWindows: true,
    executePowerShell: async (_script, options) => {
      custodyDeadline = options.deadlineUtcMs;
      assert.equal(custodyDeadline, started + f.options.deadlineSeconds * 1000);
      now += 136_000;
      writeObservation(f, options.outputDirectory);
      return successfulCustody();
    },
    buildWaveformAuthority: (options) => {
      analyses += 1;
      assert.equal(options.noBuild, true);
      assert.equal(options.deadlineUtcMs, custodyDeadline);
      assert.equal(options.deadlineUtcMs - Date.now(), 44_000);
      assert.equal(options.releaseExecutablePath, path.join(f.root, 'target/release/omni-benchmark.exe'));
      return { passed: false, sampleRateHz: 16000, candidates: [] };
    },
  });
  assert.equal(analyses, 1);
  assert.equal(result.passed, false);
  assert.equal(result.publicationVerdict, 'not-applicable');
});

test('expired custody deadline rejects before spawning or creating the PowerShell launch script', async (t) => {
  const f = fixture(t);
  await assert.rejects(executeProbePowerShell('throw "must not execute"', {
    outputDirectory: f.outputParent, workspaceRoot: f.root,
    deadlineSeconds: 180, deadlineUtcMs: Date.now() - 1,
    spawnImpl: () => assert.fail('expired deadline must not launch PowerShell'),
  }), /deadline expired before launch/);
  assert.equal(fs.existsSync(path.join(f.outputParent, 'probe.ps1')), false);
  assert.equal(fs.existsSync(path.join(f.outputParent, 'process-custody.json')), false);
});

test('pinned analyzer deadline failure remains failed without retrying capture or analysis', async (t) => {
  const f = fixture(t);
  let captures = 0;
  let analyses = 0;
  await assert.rejects(runPhysicalSourceProbe(f.options, { allowNonWindows: true,
    executePowerShell: async (_script, options) => {
      captures += 1;
      writeObservation(f, options.outputDirectory);
      return successfulCustody();
    },
    buildWaveformAuthority: (options) => {
      analyses += 1;
      assert.equal(options.noBuild, true);
      assert.ok(Number.isFinite(options.deadlineUtcMs));
      throw new Error('pinned release audio analyzer deadline has expired');
    },
  }), (error) => {
    const result = read(error.resultPath);
    assert.equal(result.passed, false);
    assert.match(result.error, /analyzer deadline has expired/);
    assert.equal(result.waveform, undefined);
    assert.equal(result.publicationVerdict, 'not-applicable');
    return true;
  });
  assert.equal(captures, 1);
  assert.equal(analyses, 1);
});

const accountingReceiptFiles = ['process-custody.json', 'cleanup.json', 'route-observation.json'];

function writeAccountingReceipts(f, outputDirectory) {
  writeObservation(f, outputDirectory);
  json(path.join(outputDirectory, 'process-custody.json'), successfulCustody());
}

for (const source of accountingReceiptFiles) {
  test(`accounting retains nonzero ${source} with its original source`, async (t) => {
    const f = fixture(t);
    await assert.rejects(runPhysicalSourceProbe(f.options, { allowNonWindows: true,
      executePowerShell: async (_script, options) => {
        writeAccountingReceipts(f, options.outputDirectory);
        const file = path.join(options.outputDirectory, source);
        json(file, { ...read(file), providerCalls: 2 });
        return read(path.join(options.outputDirectory, 'process-custody.json'));
      },
      buildWaveformAuthority: () => assert.fail('nonzero accounting must stop before analysis'),
    }), (error) => {
      const result = read(error.resultPath);
      assert.equal(result.passed, false);
      assert.equal(result.providerCalls, 2);
      assert.equal(result.providerAccounting, 'unverified-producer-report');
      const observed = result.observedProviderAccounting.find((entry) => entry.source === source
        && entry.phase === 'failure-recovery');
      assert.equal(observed.providerCalls, 2);
      assert.equal(observed.providerCallsPresent, true);
      assert.equal(observed.providerCallsValid, true);
      assert.equal(result.publicationVerdict, 'not-applicable');
      return true;
    });
  });
}

test('accounting stays unknown after a launch failure without any receipt', async (t) => {
  const f = fixture(t);
  await assert.rejects(runPhysicalSourceProbe(f.options, { allowNonWindows: true,
    executePowerShell: async () => { throw new Error('launch failure sentinel'); },
    buildWaveformAuthority: () => assert.fail('launch failure must stop before analysis'),
  }), (error) => {
    const result = read(error.resultPath);
    assert.equal(result.providerCalls, null);
    assert.equal(result.providerAccounting, 'unknown');
    assert.equal(result.launchAttempted, true);
    assert.match(result.error, /launch failure sentinel/);
    assert.deepEqual(result.observedProviderAccounting.map((entry) => entry.source), accountingReceiptFiles);
    assert.ok(result.observedProviderAccounting.every((entry) => entry.receiptStatus === 'missing'
      && entry.providerCalls === null && entry.readError));
    return true;
  });
});

for (const [name, bodies, expected, status] of [
  ['duplicate counts', ['{"providerCalls":2}', '{"providerCalls":2}'], 2, 'unverified-producer-report'],
  ['conflicting counts', ['{"providerCalls":2}', '{"providerCalls":3}'], null, 'conflicting-producer-reports'],
  ['missing count', ['{}', '{"providerCalls":0}'], null, 'unknown'],
  ['invalid count type', ['{"providerCalls":"2"}', '{"providerCalls":0}'], null, 'unknown'],
  ['negative count', ['{"providerCalls":-1}', '{"providerCalls":0}'], null, 'unknown'],
  ['truncated JSON', ['{"providerCalls":2', '{"providerCalls":0}'], null, 'unknown'],
  ['invalid UTF8', [Buffer.from([0xff, 0xfe, 0xff]), '{"providerCalls":0}'], null, 'unknown'],
  ['oversized receipt', [Buffer.alloc(513 * 1024, 32), '{"providerCalls":0}'], null, 'unknown'],
]) {
  test(`failed accounting preserves ${name} without repairs, sums or maxima`, async (t) => {
    const f = fixture(t);
    await assert.rejects(runPhysicalSourceProbe(f.options, {
      executePowerShell: async (_script, { outputDirectory }) => {
        fs.writeFileSync(path.join(outputDirectory, 'cleanup.json'), bodies[0]);
        fs.writeFileSync(path.join(outputDirectory, 'route-observation.json'), bodies[1]);
        throw new Error('original launch sentinel');
      }, buildWaveformAuthority: () => assert.fail('failed accounting cannot authorize analysis'),
    }), (error) => {
      assert.equal(error.message, 'original launch sentinel');
      const result = read(error.resultPath);
      assert.equal(result.providerCalls, expected);
      assert.equal(result.providerAccounting, status);
      assert.equal(result.observedProviderAccounting.length, 3);
      assert.equal(result.passed, false); return true;
    });
  });
}

test('prelaunch zero and completed receipt-validated zero have different accounting provenance', async (t) => {
  const f = fixture(t);
  await assert.rejects(runPhysicalSourceProbe({ ...f.options, deadlineSeconds: 1 }, {
    executePowerShell: () => assert.fail('invalid deadline must not launch'),
  }), (error) => {
    const result = read(error.resultPath);
    assert.equal(result.providerCalls, 0); assert.equal(result.providerAccounting, 'not-launched'); return true;
  });
  const result = await runPhysicalSourceProbe(f.options, {
    executePowerShell: async (_script, { outputDirectory }) => { writeObservation(f, outputDirectory); return successfulCustody(); },
    buildWaveformAuthority: async () => ({ passed: true, candidates: [], sampleRateHz: 16000 }),
  });
  assert.equal(result.providerCalls, 0);
  assert.equal(result.providerAccounting, 'validated-receipts-reported-zero');
});

test('a later zero receipt cannot overwrite a nonzero launch-return observation', async (t) => {
  const f = fixture(t);
  await assert.rejects(runPhysicalSourceProbe(f.options, {
    executePowerShell: async (_script, { outputDirectory }) => {
      writeAccountingReceipts(f, outputDirectory);
      return { ...successfulCustody(), providerCalls: 2 };
    }, buildWaveformAuthority: () => assert.fail('nonzero observation must stop before analysis'),
  }), (error) => {
    const result = read(error.resultPath);
    assert.equal(result.providerCalls, 2);
    assert.equal(result.providerAccounting, 'unverified-producer-report');
    assert.ok(result.observedProviderAccounting.some((entry) => entry.source === 'process-custody-return' && entry.providerCalls === 2));
    assert.ok(result.observedProviderAccounting.some((entry) => entry.phase === 'failure-recovery' && entry.providerCalls === 0));
    return true;
  });
});

test('missing native custody, cleanup errors and changed runtime prevent any waveform verdict', async (t) => {
  const f = fixture(t);
  for (const kind of ['custody', 'cleanup', 'runtime']) {
    let output;
    await assert.rejects(runPhysicalSourceProbe(f.options, { allowNonWindows: true,
      executePowerShell: async (_script, options) => {
        output = options.outputDirectory; writeObservation(f, output);
        if (kind === 'custody') return undefined;
        if (kind === 'cleanup') json(path.join(output, 'cleanup.json'), { schemaVersion: 1,
          artifactKind: 'watch-mode-physical-source-probe-cleanup', passed: true, errors: ['cleanup sentinel'], providerCalls: 0 });
        if (kind === 'runtime') fs.appendFileSync(path.join(f.root, AUTHORITY_RUNTIME_BINARY_FILES.at(-1)), 'changed');
        return successfulCustody();
      }, buildWaveformAuthority: () => assert.fail('unconfirmed cleanup/runtime must not produce analysis'),
    }), /custody|cleanup sentinel|runtime file differs/);
    const result = read(path.join(output, 'result.json'));
    assert.equal(result.passed, false); assert.equal(result.routeMatchedC02, undefined);
    assert.equal(result.publicationVerdict, 'not-applicable');
  }
});

test('invalid media, endpoints and deadlines fail before any child launch; CLI rejects duplicates', async (t) => {
  const f = fixture(t); const other = path.join(f.root, 'other.wav'); fs.writeFileSync(other, 'other', 'utf8');
  for (const change of [{ mediaPath: other }, { physicalPlaybackDeviceId: '' }, { physicalPlaybackDeviceId: 'virtual-id' },
    { virtualRenderEndpointId: ' virtual-id' }, { virtualRenderEndpointId: 'default' },
    { deadlineSeconds: 149 }, { deadlineSeconds: 301 }, { deadlineSeconds: 180.5 }]) {
    await assert.rejects(runPhysicalSourceProbe({ ...f.options, ...change }, { allowNonWindows: true,
      executePowerShell: () => assert.fail('preflight failure launched a process'),
    }), /canonical fixed media|endpoint identities|deadlineSeconds/);
  }
  const args = ['--workspace-root', f.root, '--output-parent', f.outputParent, '--runtime-manifest', f.manifest,
    '--distribution-digest', f.options.distributionDigest,
    '--virtual-render-endpoint-id', 'v', '--physical-playback-device-id', 'p'];
  assert.equal(parsePhysicalSourceProbeArgs(args).physicalPlaybackDeviceId, 'p');
  assert.throws(() => parsePhysicalSourceProbeArgs([...args, '--physical-playback-device-id', 'other']), /duplicate/);
  assert.throws(() => parsePhysicalSourceProbeArgs(args.slice(0, 4)), /runtimeManifestPath is required/);
});

function processFixture(t) {
  const f = fixture(t);
  const relative = 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveFinalizer.psm1';
  const modulePath = path.join(f.root, relative);
  fs.copyFileSync(path.join(repoRoot, relative), modulePath);
  return { ...f, modulePath, execution: { outputDirectory: f.outputParent, workspaceRoot: f.root,
    deadlineSeconds: 15, finalizerSha256: sha(fs.readFileSync(modulePath)) } };
}

function nodeProgram(f, source) {
  const file = path.join(f.root, 'zero-provider-tooling-child.cjs');
  fs.writeFileSync(file, source, 'utf8');
  return `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
& ${psQuote(process.execPath)} ${psQuote(file)}
exit $LASTEXITCODE`;
}

const windowsOnly = { skip: process.platform !== 'win32' };

test('real PowerShell imports the route dependency closure and constructs the bridge payload without touching audio', windowsOnly, async (t) => {
  const f = processFixture(t);
  for (const relative of PHYSICAL_SOURCE_PROBE_SUPPORT_FILES.filter((name) => name.endsWith('.psm1'))) {
    fs.copyFileSync(path.join(repoRoot, relative), path.join(f.root, relative));
  }
  const route = buildProbePowerShell({ ...f.options, outputDirectory: f.outputParent, mediaPath: f.canonical, runMarker: 'tooling-only' });
  const imports = route.split('\n').filter((line) => line.startsWith('Import-Module ')).join('\n');
  await executeProbePowerShell(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$ErrorActionPreference='Stop'
${imports}
Get-Command Start-TestMediaPlayback,Get-RenderEndpointRegistryIdentity -ErrorAction Stop | Out-Null
$payload=New-BridgeSourceProbeInitPayload 'virtual-driver' 'tooling-only' 'physical-id'
[Console]::Out.WriteLine(($payload|ConvertTo-Json -Depth 8 -Compress))`, f.execution);
  const stdout = fs.readFileSync(path.join(f.outputParent, 'probe.stdout.log'), 'utf8');
  const payload = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
  assert.equal(payload.sourceCaptureMode, 'virtual-driver');
  assert.equal(payload.mixControl.keepOriginalAudio, true);
  assert.equal(payload.physicalPlaybackDeviceId, 'physical-id');
});

test('real native custody executes Node with EOF stdin and drains large UTF-8 stdout/stderr before returning', windowsOnly, async (t) => {
  const f = processFixture(t);
  const script = nodeProgram(f, `const fs=require('node:fs');
const input=fs.readFileSync(0);
process.stdout.write('o'.repeat(131072)+'\\nstdin='+input.length+'\\n\\u4e2d\\u6587 stdout-tail\\n');
process.stderr.write('e'.repeat(98304)+'\\nstderr-tail\\n');`);
  const custody = await executeProbePowerShell(script, f.execution);
  assert.deepEqual(custody, successfulCustody());
  const stdout = fs.readFileSync(path.join(f.outputParent, 'probe.stdout.log'), 'utf8');
  const stderr = fs.readFileSync(path.join(f.outputParent, 'probe.stderr.log'), 'utf8');
  assert.ok(stdout.includes('o'.repeat(131072)));
  assert.match(stdout, /stdin=0/); assert.match(stdout, /\u4e2d\u6587 stdout-tail/);
  assert.ok(stderr.includes('e'.repeat(98304))); assert.match(stderr, /stderr-tail/);
});

for (const inheritedStreams of [true, false]) {
  test(`real custody waits for descendants after root exit (inherited streams=${inheritedStreams})`, windowsOnly, async (t) => {
    const f = processFixture(t); const completed = path.join(f.root, 'descendant-completed');
    const script = nodeProgram(f, `const fs=require('node:fs');const {spawn}=require('node:child_process');
if(process.argv[2]==='descendant'){
  setTimeout(()=>{fs.writeFileSync(${JSON.stringify(completed)},'real descendant exited');
    process.stdout.write('descendant-stdout-tail\\n');process.stderr.write('descendant-stderr-tail\\n');},900);
}else{
  spawn(process.execPath,[__filename,'descendant'],{windowsHide:true,detached:true,stdio:${inheritedStreams ? "['ignore','inherit','inherit']" : "'ignore'"}}).unref();
  process.stdout.write('root-exited\\n');
}`);
    const custody = await executeProbePowerShell(script, f.execution);
    assert.equal(custody.ownedTreeExited, true); assert.equal(custody.streamsDrained, true);
    assert.equal(fs.readFileSync(completed, 'utf8'), 'real descendant exited');
    if (inheritedStreams) {
      assert.match(fs.readFileSync(path.join(f.outputParent, 'probe.stdout.log'), 'utf8'), /descendant-stdout-tail/);
      assert.match(fs.readFileSync(path.join(f.outputParent, 'probe.stderr.log'), 'utf8'), /descendant-stderr-tail/);
    }
  });
}

for (const failure of ['nonzero-root', 'deadline']) {
  test(`real custody ${failure} rejects only after its running descendant is stopped`, windowsOnly, async (t) => {
    const f = processFixture(t); const heartbeat = path.join(f.root, 'descendant-heartbeat');
    const script = nodeProgram(f, `const fs=require('node:fs');const {spawn}=require('node:child_process');
if(process.argv[2]==='descendant'){
  fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now()));
  const timer=setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20);
  setTimeout(()=>{clearInterval(timer);},10000);
}else{
  spawn(process.execPath,[__filename,'descendant'],{windowsHide:true,detached:true,stdio:'ignore'}).unref();
  const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(heartbeat)})){clearInterval(ready);process.exit(${failure === 'nonzero-root' ? 23 : 0});}},20);
}`);
    const start = Date.now();
    await assert.rejects(executeProbePowerShell(script, { ...f.execution, deadlineSeconds: failure === 'deadline' ? 4 : 15 }), (error) => {
      assert.match(error.message, failure === 'deadline' ? /timed out/ : /exitCode=23/);
      assert.doesNotMatch(error.message, /cleanup incomplete|drain incomplete/);
      return true;
    });
    assert.ok(Date.now() - start < 9500, 'must not wait for the descendant self-expiry');
    const lastHeartbeat = fs.readFileSync(heartbeat, 'utf8');
    await delay(180);
    assert.equal(fs.readFileSync(heartbeat, 'utf8'), lastHeartbeat, 'a descendant survived executor settlement');
    assert.equal(read(path.join(f.outputParent, 'process-custody.json')).passed, false);
  });
}

test('real native executor does not swallow cleanup failure or accept success-looking stdout', windowsOnly, async (t) => {
  const f = processFixture(t);
  await assert.rejects(executeProbePowerShell(`[Console]::Out.WriteLine('{"passed":true}')
try { throw 'operation sentinel' } finally { throw 'cleanup sentinel' }`, f.execution), /cleanup sentinel/);
  const custody = read(path.join(f.outputParent, 'process-custody.json'));
  assert.equal(custody.passed, false); assert.match(custody.errors.join('\n'), /cleanup sentinel/);
});

test('log-open failure cannot launch a process and a changed native helper is rejected before import', windowsOnly, async (t) => {
  const f = processFixture(t);
  fs.mkdirSync(path.join(f.outputParent, 'probe.stderr.log'));
  await assert.rejects(executeProbePowerShell('throw "must never launch"', {
    ...f.execution, spawnImpl: () => assert.fail('redirection failure must prevent process launch'),
  }), /EISDIR|EEXIST|EPERM/);
  const otherOutput = path.join(f.root, 'changed-helper-output'); fs.mkdirSync(otherOutput);
  fs.appendFileSync(f.modulePath, '\n# changed after verification\n', 'utf8');
  await assert.rejects(executeProbePowerShell('throw "must never launch"', {
    ...f.execution, outputDirectory: otherOutput,
  }), /process-custody helper changed after preflight/);
});
