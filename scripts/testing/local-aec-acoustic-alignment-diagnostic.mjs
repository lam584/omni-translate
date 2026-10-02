/**
 * Pure numerical, pre-AEC-only acoustic-template location diagnostic.
 * No files, devices, post-AEC PCM, QPC, providers, or native clock inputs.
 *
 * Offset is an INTEGER mono-frame index into the supplied preCapture search
 * segment, not an absolute stream timestamp. Call separately for source and
 * render references. A render template must describe the ACTUAL rendered
 * waveform (including known soft clipping/resampling), not its linear input.
 *
 * PCM integration must separately preserve: segment start frame, template
 * start frame, declared/verified sample rates, channel/downmix convention,
 * resampling/transform provenance, tap identity = pre, stream/session/owner/
 * reset/continuity generations, dropped-frame/discontinuity spans, hashes and
 * frame counts. Never bridge discontinuities or infer those indices from QPC.
 * Neither matching nor block consistency proves native-clock accuracy, >=95%
 * English-source coverage, 20 dB AEC attenuation, or release eligibility. Those
 * require the formal evidence tool, not this diagnostic. Synthetic tests are
 * numerical calibration, not English intelligibility or real acoustic tests.
 */
export const ACOUSTIC_ALIGNMENT_LIMITS = Object.freeze({
  maxCaptureFrames: 500_000,
  maxTemplateFrames: 128_000,
  maxCandidates: 128_000,
  minTemplateMilliseconds: 100,
  maxAbsoluteSample: 8,
  minRms: 1e-6,
  minimumCorrelation: 0.65,
  minimumBlockCorrelation: 0.5,
  minimumPeakMargin: 0.08,
  maximumCompetitorRatio: 0.92,
  consistencyMilliseconds: 1,
});
const SAMPLE_RATES = new Set([8_000, 16_000, 24_000, 32_000, 44_100, 48_000, 96_000]);
const LIMIT = ACOUSTIC_ALIGNMENT_LIMITS;
const disclaimers = () => ({
  diagnosticOnly: true,
  aecQualityAcceptance: false,
  releaseEligible: false,
  nativeClockAccuracyEstablished: false,
  sourceCoverageAtLeast95PercentEstablished: false,
  retainedSourceCoverage: null,
  waveformTransformValidated: false,
  confidence: 'diagnostic-only',
  integrity: 'not-established',
});

// Radix-2 FFT convolution evaluates EVERY integer lag, without stride/phase
// loss. Zero padding >= capture + template - 1 prevents circular aliasing.
// Hard bounds above cap time at O(N log N), memory at O(N); N <= 2^20.
function fft(real, imaginary, inverse = false) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const stepReal = Math.cos(angle), stepImaginary = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < size / 2; j++) {
        const a = start + j, b = a + size / 2;
        const br = real[b] * wr - imaginary[b] * wi;
        const bi = real[b] * wi + imaginary[b] * wr;
        real[b] = real[a] - br;
        imaginary[b] = imaginary[a] - bi;
        real[a] += br;
        imaginary[a] += bi;
        const nextReal = wr * stepReal - wi * stepImaginary;
        wi = wr * stepImaginary + wi * stepReal;
        wr = nextReal;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imaginary[i] /= n; }
}

function stats(pcm, start = 0, length = pcm.length) {
  let sum = 0, energy = 0;
  for (let i = start; i < start + length; i++) sum += pcm[i];
  const mean = sum / length;
  // Two-pass centering avoids cancellation near the activity floor with DC.
  for (let i = start; i < start + length; i++) energy += (pcm[i] - mean) ** 2;
  return { sum, energy };
}

function correlationSearch(template, capture, minFrame, maxFrame, toleranceFrames) {
  const length = template.length;
  const segment = capture.subarray(minFrame, maxFrame + length);
  let n = 1;
  while (n < segment.length + length - 1) n *= 2;
  const xr = new Float64Array(n), xi = new Float64Array(n);
  const tr = new Float64Array(n), ti = new Float64Array(n);
  const sums = new Float64Array(segment.length + 1), squares = new Float64Array(segment.length + 1);
  const segmentMean = stats(segment).sum / segment.length;
  for (let i = 0; i < segment.length; i++) {
    const centered = segment[i] - segmentMean;
    xr[i] = centered;
    sums[i + 1] = sums[i] + centered;
    squares[i + 1] = squares[i] + centered ** 2;
  }
  const ts = stats(template);
  if (ts.energy / length < LIMIT.minRms ** 2) return { usable: false, reason: 'silent-template-block' };
  const mean = ts.sum / length;
  for (let i = 0; i < length; i++) tr[length - 1 - i] = template[i] - mean;
  fft(xr, xi); fft(tr, ti);
  for (let i = 0; i < n; i++) {
    const r = xr[i] * tr[i] - xi[i] * ti[i];
    xi[i] = xr[i] * ti[i] + xi[i] * tr[i];
    xr[i] = r;
  }
  fft(xr, xi, true);
  const scores = new Float64Array(maxFrame - minFrame + 1);
  let best = -1, bestIndex = 0;
  for (let i = 0; i < scores.length; i++) {
    const sum = sums[i + length] - sums[i];
    const energy = Math.max(0, squares[i + length] - squares[i] - sum * sum / length);
    // Signed positive-gain Pearson correlation. Silence/DC cannot match.
    const value = energy / length < LIMIT.minRms ** 2 ? 0
      : Math.max(-1, Math.min(1, xr[i + length - 1] / Math.sqrt(ts.energy * energy)));
    scores[i] = value;
    if (value > best) { best = value; bestIndex = i; }
  }
  let competitor = 0, competitorFrame = null;
  for (let i = 0; i < scores.length; i++) {
    if (i === bestIndex) continue;
    // The 1ms consistency tolerance MUST NOT hide distinct periodic peaks.
    // Compare every competing local maximum even inside the main-lobe region;
    // outside that region also compare its slopes and endpoints conservatively.
    const localMaximum = scores[i] >= (scores[i - 1] ?? -Infinity)
      && scores[i] >= (scores[i + 1] ?? -Infinity);
    if ((localMaximum || Math.abs(i - bestIndex) > toleranceFrames) && scores[i] > competitor) {
      competitor = scores[i]; competitorFrame = minFrame + i;
    }
  }
  const margin = best - competitor;
  const ambiguous = competitor >= best * LIMIT.maximumCompetitorRatio || margin < LIMIT.minimumPeakMargin;
  return {
    usable: true, peakFrame: minFrame + bestIndex, correlation: best,
    boundaryPeak: bestIndex === 0 || bestIndex === scores.length - 1,
    ambiguity: { ambiguous, competitorCorrelation: competitor, competitorFrame, peakMargin: margin,
      mainLobeNeighborhoodFrames: toleranceFrames, localMaximaComparedWithinNeighborhood: true },
  };
}

function blockEvidence(template, capture, offset) {
  const blocks = [];
  for (let block = 0; block < 16; block++) {
    const start = Math.floor(template.length * block / 16);
    const end = Math.floor(template.length * (block + 1) / 16);
    const length = end - start;
    const a = stats(template, start, length), b = stats(capture, offset + start, length);
    let dot = 0;
    const am = a.sum / length, bm = b.sum / length;
    for (let i = start; i < end; i++) dot += (template[i] - am) * (capture[offset + i] - bm);
    const active = a.energy / length >= LIMIT.minRms ** 2 && b.energy / length >= LIMIT.minRms ** 2;
    const correlation = active ? Math.max(-1, Math.min(1, dot / Math.sqrt(a.energy * b.energy))) : null;
    blocks.push({ startFrame: start, frameCount: length, correlation,
      fittedGain: active ? dot / a.energy : null,
      supported: active && correlation >= LIMIT.minimumBlockCorrelation });
  }
  const gains = blocks.filter(b => b.supported).map(b => b.fittedGain).sort((a, b) => a - b);
  const medianGain = gains.length ? gains[Math.floor(gains.length / 2)] : null;
  // A small surviving high-energy excerpt must not imply full template support.
  // Even all supported blocks do NOT establish sample-level source coverage.
  const consistent = blocks.every(b => b.supported && b.fittedGain >= medianGain * 0.5 && b.fittedGain <= medianGain * 2);
  return { status: consistent ? 'block-consistent-not-coverage' : 'weak-or-incomplete',
    supportedBlocks: blocks.filter(b => b.supported).length, totalBlocks: blocks.length, medianGain, blocks };
}

/**
 * range.minFrame/maxFrame are inclusive candidate template-start frame indices
 * relative to preCapture. Only complete overlap is admitted. Search-boundary
 * maxima are conservatively indeterminate: acquire a wider pre PCM window.
 * Optional rate declarations catch metadata mismatch; a falsely labelled rate
 * is inherently undetectable from bare arrays. Unknown extra properties (even
 * QPC getters) are never read. There is intentionally no post/QPC argument.
 */
export function diagnoseAcousticAlignment(input) {
  const base = { ...disclaimers(), status: 'indeterminate', offsetFrames: null, offsetMilliseconds: null,
    correlation: null, ambiguity: null, reason: 'invalid-input' };
  if (!input || typeof input !== 'object') return base;
  const { template, preCapture, sampleRate, range, referenceKind = 'source',
    templateSampleRate = sampleRate, captureSampleRate = sampleRate } = input;
  const result = { ...base, referenceKind };
  const fail = reason => ({ ...result, reason });
  if (!['source', 'render'].includes(referenceKind)) return fail('invalid-reference-kind');
  if (!Number.isInteger(sampleRate) || !SAMPLE_RATES.has(sampleRate)) return fail('unsupported-sample-rate');
  if (templateSampleRate !== sampleRate || captureSampleRate !== sampleRate) return fail('sample-rate-mismatch');
  if (!(template instanceof Float32Array) || !(preCapture instanceof Float32Array)) return fail('requires-float32-pcm');
  if (template.length < Math.ceil(sampleRate * LIMIT.minTemplateMilliseconds / 1000)
      || template.length > LIMIT.maxTemplateFrames || preCapture.length > LIMIT.maxCaptureFrames) return fail('pcm-size-limit');
  if (!range || !Number.isSafeInteger(range.minFrame) || !Number.isSafeInteger(range.maxFrame)
      || range.minFrame < 0 || range.maxFrame - range.minFrame < 2
      || range.maxFrame - range.minFrame + 1 > LIMIT.maxCandidates
      || range.maxFrame + template.length > preCapture.length) return fail('invalid-search-range');
  for (const pcm of [template, preCapture]) for (const value of pcm) {
    if (!Number.isFinite(value) || Math.abs(value) > LIMIT.maxAbsoluteSample) return fail('nonfinite-or-extreme-pcm');
  }
  if (stats(template).energy / template.length < LIMIT.minRms ** 2) return fail('silent-template');
  if (stats(preCapture).energy / preCapture.length < LIMIT.minRms ** 2) return fail('silent-capture');
  const toleranceFrames = Math.floor(sampleRate / 1000); // frozen <=1 ms; no interpolation or rate-dependent relaxation
  const full = correlationSearch(template, preCapture, range.minFrame, range.maxFrame, toleranceFrames);
  const split = Math.floor(template.length / 2);
  const train = correlationSearch(template.subarray(0, split), preCapture, range.minFrame, range.maxFrame, toleranceFrames);
  const heldOut = correlationSearch(template.subarray(split), preCapture, range.minFrame + split, range.maxFrame + split, toleranceFrames);
  const heldOutOffset = heldOut.usable ? heldOut.peakFrame - split : null;
  const consistent = train.usable && heldOut.usable && full.usable
    && Math.max(full.peakFrame, train.peakFrame, heldOutOffset) - Math.min(full.peakFrame, train.peakFrame, heldOutOffset) <= toleranceFrames;
  const evidence = {
    ...result, sampleRate, algorithm: 'all-integer-lags-fft-pearson-v1',
    candidateCount: range.maxFrame - range.minFrame + 1,
    correlation: full.correlation ?? null, ambiguity: full.ambiguity ?? null,
    peakCandidateFrames: full.peakFrame ?? null, // NOT a usable offset when indeterminate
    heldOut: { training: train, validation: heldOut, validationTemplateOffsetFrames: split,
      trainingOffsetFrames: train.peakFrame ?? null, validationOffsetFrames: heldOutOffset,
      consistencyToleranceFrames: toleranceFrames, consistencyMilliseconds: LIMIT.consistencyMilliseconds, consistent },
    localIntegrity: full.usable ? blockEvidence(template, preCapture, full.peakFrame) : null,
  };
  const unknown = reason => ({ ...evidence, reason });
  if (![full, train, heldOut].every(b => b.usable)) return unknown('inactive-training-or-validation');
  if ([full, train, heldOut].some(b => b.correlation < LIMIT.minimumCorrelation)) return unknown('insufficient-correlation');
  if ([full, train, heldOut].some(b => b.ambiguity.ambiguous)) return unknown('ambiguous-peaks');
  if ([full, train, heldOut].some(b => b.boundaryPeak)) return unknown('search-boundary-peak');
  if (!consistent) return unknown('held-out-offset-inconsistent');
  if (evidence.localIntegrity.status === 'weak-or-incomplete') return unknown('weak-local-integrity');
  return { ...evidence, status: 'located', reason: 'diagnostic-location-only', offsetFrames: full.peakFrame,
    offsetMilliseconds: full.peakFrame * 1000 / sampleRate };
}
