import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACOUSTIC_ALIGNMENT_LIMITS as LIMIT, diagnoseAcousticAlignment } from './local-aec-acoustic-alignment-diagnostic.mjs';

// Independent seeded noise surrogates labelled source/translation, NOT speech,
// native-clock evidence or acoustic AEC acceptance. No file/audio/API activity.
function random(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
}
function noise(length, seed, gain = 0.4) {
  const next = random(seed);
  return Float32Array.from({ length }, () => (next() * 2 - 1) * gain);
}
function add(capture, template, offset, gain = 1) {
  for (let i = 0; i < template.length && offset + i < capture.length; i++) capture[offset + i] += template[i] * gain;
}
function fixture(length = 1600, offset = 311) {
  const template = noise(length, 197), preCapture = noise(length + 1000, 913, 0.025);
  add(preCapture, template, offset, 0.7);
  return { template, preCapture, sampleRate: 8000, range: { minFrame: 100, maxFrame: 600 } };
}
function diagnosticFlags(result) {
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.aecQualityAcceptance, false);
  assert.equal(result.releaseEligible, false);
  assert.equal(result.nativeClockAccuracyEstablished, false);
  assert.equal(result.sourceCoverageAtLeast95PercentEstablished, false);
  assert.equal(result.retainedSourceCoverage, null);
  assert.equal(result.waveformTransformValidated, false);
  assert.equal(result.confidence, 'diagnostic-only');
  assert.equal(result.integrity, 'not-established');
}
function indeterminate(result, reason) {
  diagnosticFlags(result);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.offsetFrames, null);
  assert.equal(result.offsetMilliseconds, null);
  if (reason) assert.equal(result.reason, reason);
}
function directCorrelation(template, capture, offset) {
  let a = 0, b = 0, aa = 0, bb = 0, ab = 0;
  for (let i = 0; i < template.length; i++) {
    const x = template[i], y = capture[offset + i];
    a += x; b += y; aa += x * x; bb += y * y; ab += x * y;
  }
  const n = template.length;
  return (ab - a * b / n) / Math.sqrt((aa - a * a / n) * (bb - b * b / n));
}

test('independent English/source + translation numerical surrogates: known gains and offsets in mixed PRE', () => {
  const source = noise(1600, 11), render = noise(1600, 22);
  const preCapture = noise(2600, 33, 0.01);
  add(preCapture, source, 311, 0.65); add(preCapture, render, 389, 0.65);
  for (const [referenceKind, template, offset] of [['source', source, 311], ['render', render, 389]]) {
    const result = diagnoseAcousticAlignment({ template, preCapture, sampleRate: 8000,
      range: { minFrame: 100, maxFrame: 600 }, referenceKind });
    diagnosticFlags(result);
    assert.equal(result.status, 'located', JSON.stringify(result));
    assert.equal(result.offsetFrames, offset);
    assert.ok(result.correlation > 0.65 && result.correlation < 0.85);
    assert.equal(result.ambiguity.ambiguous, false);
    assert.equal(result.heldOut.trainingOffsetFrames, offset);
    assert.equal(result.heldOut.validationOffsetFrames, offset);
    assert.equal(result.heldOut.consistent, true);
    assert.equal(result.localIntegrity.status, 'block-consistent-not-coverage');
    assert.ok(Math.abs(result.localIntegrity.medianGain - 0.65) < 0.12);
  }
});

test('soft-clipped translation uses transformed template; incorrect linear reference is not high confidence', () => {
  const next = random(501);
  const linear = Float32Array.from({ length: 1600 }, () => (next() < 0.1 ? 0.8 : 0.02) * (next() < 0.5 ? -1 : 1));
  const transformed = Float32Array.from(linear, x => 0.7 * Math.tanh(x * 40));
  const source = noise(1600, 15, 0.15), preCapture = new Float32Array(2600);
  add(preCapture, source, 291, 0.8); add(preCapture, transformed, 389, 0.75);
  const input = { preCapture, sampleRate: 8000, range: { minFrame: 100, maxFrame: 600 }, referenceKind: 'render' };
  const actual = diagnoseAcousticAlignment({ ...input, template: transformed });
  assert.equal(actual.status, 'located', JSON.stringify(actual));
  assert.equal(actual.offsetFrames, 389); diagnosticFlags(actual);
  const wrong = diagnoseAcousticAlignment({ ...input, template: linear });
  indeterminate(wrong, 'insufficient-correlation');
  assert.ok(wrong.correlation < LIMIT.minimumCorrelation);
});

test('250ms QPC warp changes no sample offset, and even QPC/post getters are never read', () => {
  const input = fixture();
  const first = diagnoseAcousticAlignment({ ...input, qpcOriginMilliseconds: 0 });
  const warped = diagnoseAcousticAlignment({ ...input, qpcOriginMilliseconds: 250 });
  assert.deepEqual(first, warped); assert.equal(warped.offsetFrames, 311);
  Object.defineProperty(input, 'qpc', { get() { throw new Error('QPC must not be read'); } });
  Object.defineProperty(input, 'postCapture', { get() { throw new Error('post must not be read'); } });
  assert.deepEqual(diagnoseAcousticAlignment(input), first);
});

test('FFT agrees with exhaustive direct Pearson oracle, all integer phases, DC and gain', () => {
  for (const offset of [11, 12, 13, 14, 15, 61, 93, 147]) {
    const template = noise(801, offset + 701, 0.3);
    for (let i = 0; i < template.length; i++) template[i] += 0.35;
    const preCapture = noise(1100, offset + 133, 0.02);
    for (let i = 0; i < preCapture.length; i++) preCapture[i] += 0.22;
    add(preCapture, template, offset, 0.5);
    const result = diagnoseAcousticAlignment({ template, preCapture, sampleRate: 8000,
      range: { minFrame: 5, maxFrame: 155 } });
    let best = -Infinity, bestOffset;
    for (let lag = 5; lag <= 155; lag++) {
      const score = directCorrelation(template, preCapture, lag);
      if (score > best) { best = score; bestOffset = lag; }
    }
    assert.equal(result.status, 'located', result.reason);
    assert.equal(result.offsetFrames, bestOffset);
    assert.equal(bestOffset, offset);
    assert.ok(Math.abs(result.correlation - best) < 1e-9);
  }
});

test('periodic material with equal separated peaks is rejected', () => {
  const template = Float32Array.from({ length: 1600 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * i / 80));
  const preCapture = Float32Array.from({ length: 2600 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * (i - 311) / 80));
  const result = diagnoseAcousticAlignment({ template, preCapture, sampleRate: 8000,
    range: { minFrame: 100, maxFrame: 600 } });
  indeterminate(result, 'ambiguous-peaks');
  assert.equal(result.ambiguity.ambiguous, true);
  assert.ok(result.ambiguity.competitorCorrelation > 0.999);
});

test('two identical nonperiodic excerpts at equal peaks also reject ambiguity', () => {
  const template = noise(800, 78), preCapture = new Float32Array(3000);
  add(preCapture, template, 200); add(preCapture, template, 1500);
  const result = diagnoseAcousticAlignment({ template, preCapture, sampleRate: 8000,
    range: { minFrame: 10, maxFrame: 2000 } });
  indeterminate(result, 'ambiguous-peaks');
  assert.ok(result.ambiguity.competitorCorrelation > 0.999);
});

test('zero and constant/DC templates/captures are rejected, never a fabricated lag', () => {
  for (const value of [0, 0.5]) {
    indeterminate(diagnoseAcousticAlignment({ ...fixture(), template: new Float32Array(1600).fill(value) }), 'silent-template');
    indeterminate(diagnoseAcousticAlignment({ ...fixture(), preCapture: new Float32Array(2600).fill(value) }), 'silent-capture');
  }
  indeterminate(diagnoseAcousticAlignment({ ...fixture(), template: noise(1600, 11, 1e-8) }), 'silent-template');
});

test('wrong independent template cannot locate; clipped capture cannot locate', () => {
  indeterminate(diagnoseAcousticAlignment({ ...fixture(), template: noise(1600, 99) }), 'insufficient-correlation');
  const input = fixture();
  input.preCapture.fill(0); add(input.preCapture, input.template.subarray(0, 900), 311);
  indeterminate(diagnoseAcousticAlignment(input));
});

test('search endpoint maxima and invalid full-overlap range are conservatively unknown', () => {
  const input = fixture();
  indeterminate(diagnoseAcousticAlignment({ ...input, range: { minFrame: 311, maxFrame: 600 } }), 'search-boundary-peak');
  indeterminate(diagnoseAcousticAlignment({ ...input, range: { minFrame: 100, maxFrame: 311 } }), 'search-boundary-peak');
  indeterminate(diagnoseAcousticAlignment({ ...input, range: { minFrame: 100, maxFrame: 1001 } }), 'invalid-search-range');
});

test('only a tiny surviving high-energy source excerpt cannot imply >=95% coverage', () => {
  const template = noise(1600, 671, 0.0001), preCapture = new Float32Array(2600);
  const energetic = noise(120, 123, 0.7);
  for (let i = 0; i < 60; i++) { template[i] = energetic[i]; template[800 + i] = energetic[60 + i]; }
  add(preCapture, template.subarray(0, 60), 311);
  add(preCapture, template.subarray(800, 860), 1111);
  const result = diagnoseAcousticAlignment({ template, preCapture, sampleRate: 8000,
    range: { minFrame: 100, maxFrame: 600 } });
  indeterminate(result, 'weak-local-integrity');
  assert.ok(result.correlation > 0.99);
  assert.ok(result.localIntegrity.supportedBlocks <= 2);
});

test('training and held-out blocks independently matched at inconsistent offsets reject', () => {
  const input = fixture(); input.preCapture.fill(0);
  add(input.preCapture, input.template.subarray(0, 800), 311);
  add(input.preCapture, input.template.subarray(800), 1143); // validation says 343, 4ms away
  const result = diagnoseAcousticAlignment(input);
  indeterminate(result);
  assert.equal(result.heldOut.trainingOffsetFrames, 311);
  assert.equal(result.heldOut.validationOffsetFrames, 343);
  assert.equal(result.heldOut.consistent, false);
  assert.equal(result.heldOut.consistencyToleranceFrames, 8);
});

test('frozen <=1ms tolerance including 44.1kHz, no rounding up to 45 frames', () => {
  for (const sampleRate of [8000, 16000, 24000, 32000, 44100, 48000, 96000]) {
    const template = noise(Math.ceil(sampleRate * 0.1), sampleRate), preCapture = new Float32Array(template.length + 600);
    add(preCapture, template, 211, 0.8);
    const result = diagnoseAcousticAlignment({ template, preCapture, sampleRate, range: { minFrame: 10, maxFrame: 400 } });
    assert.equal(result.status, 'located', result.reason);
    assert.equal(result.offsetFrames, 211);
    assert.equal(result.heldOut.consistencyToleranceFrames, Math.floor(sampleRate / 1000));
    assert.ok(result.heldOut.consistencyToleranceFrames / sampleRate <= 0.001);
  }
});

test('strict types, metadata rates, sizes, finite/amplitude and integer inclusive candidate boundaries', () => {
  const input = fixture();
  for (const sampleRate of [0, -8000, 8000.5, 12345, NaN, Infinity, '8000']) {
    indeterminate(diagnoseAcousticAlignment({ ...input, sampleRate }), 'unsupported-sample-rate');
  }
  for (const field of ['templateSampleRate', 'captureSampleRate']) {
    indeterminate(diagnoseAcousticAlignment({ ...input, [field]: 48000 }), 'sample-rate-mismatch');
  }
  for (const template of [Array.from(input.template), new Float64Array(input.template), null]) {
    indeterminate(diagnoseAcousticAlignment({ ...input, template }), 'requires-float32-pcm');
  }
  for (const template of [new Float32Array(799), new Float32Array(128001)]) {
    indeterminate(diagnoseAcousticAlignment({ ...input, template }), 'pcm-size-limit');
  }
  indeterminate(diagnoseAcousticAlignment({ ...input, preCapture: new Float32Array(500001) }), 'pcm-size-limit');
  for (const range of [null, {}, { minFrame: -1, maxFrame: 100 }, { minFrame: 1.5, maxFrame: 100 },
    { minFrame: 100, maxFrame: 100 }, { minFrame: 100, maxFrame: 99 },
    { minFrame: 0, maxFrame: Infinity }, { minFrame: 0, maxFrame: Number.MAX_SAFE_INTEGER + 1 }]) {
    indeterminate(diagnoseAcousticAlignment({ ...input, range }), 'invalid-search-range');
  }
  const large = { ...input, template: noise(800, 91), preCapture: new Float32Array(129000), range: { minFrame: 0, maxFrame: 128000 } };
  indeterminate(diagnoseAcousticAlignment(large), 'invalid-search-range');
  for (const field of ['template', 'preCapture']) for (const value of [NaN, Infinity, -Infinity, 8.01, -8.01, 3.4e38]) {
    const changed = { ...input, [field]: input[field].slice() }; changed[field][changed[field].length - 1] = value;
    indeterminate(diagnoseAcousticAlignment(changed), 'nonfinite-or-extreme-pcm');
  }
  indeterminate(diagnoseAcousticAlignment({ ...input, referenceKind: 'post' }), 'invalid-reference-kind');
  for (const invalid of [null, undefined, 'pcm']) indeterminate(diagnoseAcousticAlignment(invalid), 'invalid-input');
});

test('hard upper bound is executable: 500k capture and 128k candidates, no stride omissions', () => {
  const template = noise(800, 993), preCapture = noise(500000, 996, 0.001);
  add(preCapture, template, 127991, 0.8);
  const result = diagnoseAcousticAlignment({ template, preCapture, sampleRate: 8000,
    range: { minFrame: 0, maxFrame: 127999 } });
  assert.equal(result.status, 'located', result.reason);
  assert.equal(result.offsetFrames, 127991);
  assert.equal(result.candidateCount, 128000);
  diagnosticFlags(result);
});

test('near-silent variation on large DC has stable centered correlation; subfloor/DC remains unknown', () => {
  const raw = noise(1600, 667, 0.00003);
  const template = Float32Array.from(raw, x => 7 + x);
  const preCapture = new Float32Array(2600).fill(6);
  for (let i = 0; i < raw.length; i++) preCapture[311 + i] = 6 + raw[i] * 0.8;
  const result = diagnoseAcousticAlignment({ template, preCapture, sampleRate: 8000,
    range: { minFrame: 100, maxFrame: 600 } });
  assert.equal(result.status, 'located', result.reason);
  assert.equal(result.offsetFrames, 311);
  assert.ok(result.correlation > 0.999);
  diagnosticFlags(result);
});

test('held-out tolerance accepts exactly 1ms only when independent peaks and local evidence remain usable', () => {
  const next = random(707), template = new Float32Array(1600);
  for (let half = 0; half < 2; half++) {
    const raw = Float32Array.from({ length: 800 }, () => (next() * 2 - 1) * (half === 0 ? 0.3 : 0.15));
    for (let i = 0; i < 800; i++) template[half * 800 + i] = raw[i] + (raw[i - 8] ?? 0) + (raw[i - 16] ?? 0);
  }
  for (const shift of [8, 9]) {
    const preCapture = new Float32Array(2600);
    add(preCapture, template.subarray(0, 800), 311);
    add(preCapture, template.subarray(800), 1111 + shift);
    const result = diagnoseAcousticAlignment({ template, preCapture, sampleRate: 8000,
      range: { minFrame: 100, maxFrame: 600 } });
    assert.equal(result.heldOut.trainingOffsetFrames, 311);
    assert.equal(result.heldOut.validationOffsetFrames, 311 + shift);
    assert.equal(result.heldOut.consistent, shift === 8);
    if (shift === 8) { assert.equal(result.status, 'located', result.reason); diagnosticFlags(result); }
    else indeterminate(result);
  }
});

test('two equal periodic peaks WITHIN 1ms are not hidden by held-out consistency tolerance', () => {
  const template = Float32Array.from({ length: 800 }, (_, i) => 0.5 * Math.sin(Math.PI * i / 2));
  const preCapture = Float32Array.from({ length: 900 }, (_, i) => 0.5 * Math.sin(Math.PI * (i - 1) / 2));
  const result = diagnoseAcousticAlignment({ template, preCapture, sampleRate: 8000,
    range: { minFrame: 0, maxFrame: 6 } });
  indeterminate(result, 'ambiguous-peaks');
  assert.ok(Math.abs(result.ambiguity.competitorFrame - result.peakCandidateFrames) <= 8);
  assert.ok(result.ambiguity.competitorCorrelation > 0.999);
});

test('maximum legal template length with maximum candidates stays bounded and locates', () => {
  const template = noise(128000, 998), preCapture = new Float32Array(256000);
  add(preCapture, template, 63113, 0.6);
  const result = diagnoseAcousticAlignment({ template, preCapture, sampleRate: 48000,
    range: { minFrame: 0, maxFrame: 127999 } });
  assert.equal(result.status, 'located', result.reason);
  assert.equal(result.offsetFrames, 63113);
  assert.equal(result.candidateCount, 128000);
  assert.equal(result.localIntegrity.supportedBlocks, 16);
  diagnosticFlags(result);
});
