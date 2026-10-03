const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const requireProcessing = (condition, detail) => {
  if (!condition) throw new Error(`AEC capture processing evidence invalid: ${detail}`);
};

/**
 * Validate that an array of floats are all finite, and count zero vs nonzero.
 * - Signed zero (+0.0, -0.0) counts as zero.
 * - NaN / Infinity are strictly rejected.
 * - Empty samples arrays are rejected standalone (AEC input/output cannot be 0 samples).
 */
export function inspectPcmSamples(samples) {
  requireProcessing(samples && typeof samples.length === 'number', 'samples must be array-like with length');
  requireProcessing(samples.length > 0, 'samples array cannot be empty');
  let zeroCount = 0;
  let nonzeroCount = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    requireProcessing(Number.isFinite(s), `non-finite sample at index ${i}`);
    if (s === 0) {
      zeroCount += 1;
    } else {
      nonzeroCount += 1;
    }
  }
  return {
    sampleCount: samples.length,
    zeroCount,
    nonzeroCount,
    allZero: nonzeroCount === 0,
  };
}

/**
 * Validate `aecProcessing` receipt on a capture tap event.
 * Also cross-checks actual pre-capture PCM floats read from disk.
 *
 * @param {object} event - The parsed capture event from metadata jsonl
 * @param {Float32Array|Array<number>} actualPreSamples - The actual raw f32le stereo samples read from pre PCM file
 * @param {Float32Array|Array<number>} actualPostSamples - The actual raw f32le stereo samples read from post PCM file
 * @param {object} [options]
 * @param {boolean} [options.strict=false] - Enforce receipt existence and reject unproven partial capture. Must be boolean if provided.
 * @param {object} [context] - Running state across consecutive events
 */
export function verifyCaptureProcessingRecord(event, actualPreSamples, actualPostSamples, options = {}, context = {}) {
  requireProcessing(typeof options === 'object' && options !== null, 'options must be an object');
  if (options.strict !== undefined) {
    requireProcessing(typeof options.strict === 'boolean', 'options.strict must be a boolean');
  }
  const strict = Boolean(options.strict);
  const processing = event?.aecProcessing;

  if (processing === undefined || processing === null) {
    if (strict) {
      throw new Error(`AEC capture processing evidence invalid: missing aecProcessing receipt in strict mode at sequence ${event?.sequence}`);
    }
    // Backward compatibility: legacy captures without aecProcessing pass in default/non-strict mode
    return {
      hasReceipt: false,
      partial: false,
      tailAdmission: null,
      passed: true,
      strictValidated: false,
      diagnosticOnly: true,
    };
  }

  requireProcessing(typeof processing === 'object' && !Array.isArray(processing), `aecProcessing must be an object at sequence ${event.sequence}`);
  requireProcessing(processing.schemaVersion === 1, `unsupported aecProcessing schemaVersion: ${processing.schemaVersion}`);

  // In strict mode, tailAdmission must be explicitly declared (either null or object).
  // Missing or undefined field is rejected to avoid ambiguous partial interpretation.
  if (strict) {
    requireProcessing(Object.prototype.hasOwnProperty.call(processing, 'tailAdmission')
      && (processing.tailAdmission === null || typeof processing.tailAdmission === 'object'),
      'strict mode requires explicit tailAdmission field (must be null or object, missing prohibited)');
  }

  // Frame math:
  // preSampleCount is stereo samples (channelCount=2) -> inputFrames = preSampleCount / 2
  const preSampleCount = event.preSampleCount;
  const postSampleCount = event.postSampleCount;
  requireProcessing(integer(preSampleCount) && preSampleCount % 2 === 0, 'preSampleCount must be positive even integer');
  requireProcessing(integer(postSampleCount) && postSampleCount === preSampleCount, 'preSampleCount and postSampleCount mismatch');

  const expectedInputFrames = preSampleCount / 2;
  requireProcessing(processing.inputFrames === expectedInputFrames,
    `inputFrames mismatch: expected ${expectedInputFrames}, got ${processing.inputFrames}`);

  const expectedNative10msFrames = Math.ceil(expectedInputFrames / 480);
  requireProcessing(processing.native10msFrames === expectedNative10msFrames,
    `native10msFrames mismatch: expected ${expectedNative10msFrames}, got ${processing.native10msFrames}`);

  const expectedMathPaddingFrames = (expectedNative10msFrames * 480) - expectedInputFrames;
  requireProcessing(processing.mathPaddingFrames === expectedMathPaddingFrames,
    `mathPaddingFrames mismatch: expected ${expectedMathPaddingFrames}, got ${processing.mathPaddingFrames}`);

  requireProcessing(processing.allInputProcessed === true, 'allInputProcessed must be true');
  requireProcessing(typeof processing.resetBeforeResumeRequired === 'boolean', 'resetBeforeResumeRequired must be boolean');

  // Math padding requires reset before resume
  if (processing.mathPaddingFrames > 0) {
    requireProcessing(processing.resetBeforeResumeRequired === true,
      'resetBeforeResumeRequired must be true when mathPaddingFrames > 0');
  }

  // Cross-check actual PCM length and sample finiteness on disk
  if (actualPreSamples) {
    requireProcessing(actualPreSamples.length === preSampleCount,
      `actual pre PCM length mismatch: expected ${preSampleCount}, got ${actualPreSamples.length}`);
    inspectPcmSamples(actualPreSamples);
  }
  if (actualPostSamples) {
    requireProcessing(actualPostSamples.length === postSampleCount,
      `actual post PCM length mismatch: expected ${postSampleCount}, got ${actualPostSamples.length}`);
    inspectPcmSamples(actualPostSamples);
  }

  // Strict mode: any mathPaddingFrames > 0 must have an authorized tailAdmission (no anonymous computational padding)
  if (strict && processing.mathPaddingFrames > 0) {
    requireProcessing(processing.tailAdmission !== null && processing.tailAdmission !== undefined,
      'strict mode rejects mathPaddingFrames > 0 without an authorized tailAdmission (anonymous computational padding prohibited)');
  }

  const isPartial = processing.mathPaddingFrames > 0 || (processing.tailAdmission !== null && processing.tailAdmission !== undefined);

  // Tail admission validation
  const tail = processing.tailAdmission;
  if (tail !== null && tail !== undefined) {
    requireProcessing(typeof tail === 'object' && !Array.isArray(tail), 'tailAdmission must be object');
    requireProcessing(tail.schemaVersion === 1, `unsupported tailAdmission schemaVersion: ${tail.schemaVersion}`);
    requireProcessing(integer(tail.queueGeneration), 'queueGeneration must be integer');
    requireProcessing(positiveInteger(tail.captureOwnerId), 'captureOwnerId must be positive integer (>0)');
    requireProcessing(integer(tail.captureResetGeneration), 'captureResetGeneration must be integer');

    // Tail admission only allowed for < 960 real frames (< 20ms)
    requireProcessing(tail.realFrames === expectedInputFrames,
      `tailAdmission.realFrames mismatch: expected ${expectedInputFrames}, got ${tail.realFrames}`);
    requireProcessing(tail.realFrames > 0 && tail.realFrames < 960,
      `tailAdmission is only permitted for short tail (< 960 real frames), got ${tail.realFrames}`);

    // byteLen = realFrames * 8 (f32 stereo = 2 samples * 4 bytes = 8 bytes per frame)
    const expectedByteLen = tail.realFrames * 8;
    requireProcessing(tail.byteLen === expectedByteLen,
      `tailAdmission.byteLen mismatch: expected ${expectedByteLen}, got ${tail.byteLen}`);

    requireProcessing(positiveInteger(tail.lastEmptyQueryId), 'lastEmptyQueryId must be positive integer');
    
    // A single Empty query cannot claim a continuous quiet window.
    // tail.emptyPolls must be at least 2.
    requireProcessing(integer(tail.emptyPolls) && tail.emptyPolls >= 2,
      `emptyPolls must be at least 2 to observe an elapsed quiet window, got ${tail.emptyPolls}`);

    // Thresholds:
    // quietObservationSpanMs >= 2000 ms (>= 2s continuous empty)
    requireProcessing(typeof tail.quietObservationSpanMs === 'number' && Number.isFinite(tail.quietObservationSpanMs)
      && tail.quietObservationSpanMs >= 2000.0,
      `quietObservationSpanMs must be >= 2000 ms, got ${tail.quietObservationSpanMs}`);

    // maximumEmptyPollGapMs <= 100 ms and must be > 0 under a >= 2s quiet observation span
    requireProcessing(typeof tail.maximumEmptyPollGapMs === 'number' && Number.isFinite(tail.maximumEmptyPollGapMs)
      && tail.maximumEmptyPollGapMs > 0.0 && tail.maximumEmptyPollGapMs <= 100.0,
      `maximumEmptyPollGapMs must be in (0, 100] ms under positive quiet span, got ${tail.maximumEmptyPollGapMs}`);

    // Consistency check between quiet observation span, poll count, and max gap:
    // Over emptyPolls polls, there are (emptyPolls - 1) intervals, each <= maximumEmptyPollGapMs.
    // Thus quietObservationSpanMs <= (emptyPolls - 1) * maximumEmptyPollGapMs (+ floating epsilon).
    const maxPossibleSpanMs = (tail.emptyPolls - 1) * tail.maximumEmptyPollGapMs;
    requireProcessing(tail.quietObservationSpanMs <= maxPossibleSpanMs + (Number.EPSILON * 1024),
      `quietObservationSpanMs (${tail.quietObservationSpanMs} ms) exceeds (emptyPolls - 1) * maximumEmptyPollGapMs (${maxPossibleSpanMs} ms)`);

    // lastNonemptyAgeAtLastQueryMs >= quietObservationSpanMs
    requireProcessing(typeof tail.lastNonemptyAgeAtLastQueryMs === 'number' && Number.isFinite(tail.lastNonemptyAgeAtLastQueryMs)
      && tail.lastNonemptyAgeAtLastQueryMs >= tail.quietObservationSpanMs,
      `lastNonemptyAgeAtLastQueryMs must be >= quietObservationSpanMs, got ${tail.lastNonemptyAgeAtLastQueryMs}`);

    // finite PCM counting and allZero consistency
    const totalSamples = tail.realFrames * 2;
    requireProcessing(integer(tail.zeroSamples) && integer(tail.nonzeroSamples), 'sample counts must be integers');
    requireProcessing(tail.zeroSamples + tail.nonzeroSamples === totalSamples,
      `zeroSamples + nonzeroSamples (${tail.zeroSamples}+${tail.nonzeroSamples}) must equal total real samples (${totalSamples})`);
    requireProcessing(tail.allZero === (tail.nonzeroSamples === 0),
      'allZero must strictly match nonzeroSamples === 0');

    // Check actual samples from pre PCM if provided
    if (actualPreSamples) {
      const inspected = inspectPcmSamples(actualPreSamples);
      requireProcessing(inspected.zeroCount === tail.zeroSamples,
        `tail zeroSamples mismatch with actual disk PCM: receipt claimed ${tail.zeroSamples}, disk has ${inspected.zeroCount}`);
      requireProcessing(inspected.nonzeroCount === tail.nonzeroSamples,
        `tail nonzeroSamples mismatch with actual disk PCM: receipt claimed ${tail.nonzeroSamples}, disk has ${inspected.nonzeroCount}`);
      requireProcessing(inspected.allZero === tail.allZero,
        `tail allZero mismatch with actual disk PCM: receipt claimed ${tail.allZero}, disk has ${inspected.allZero}`);
    }

    // Owner monotonicity check in context:
    // Same captureOwnerId cannot have regressing captureResetGeneration
    if (context.ownerResetGenerations) {
      const prevResetGen = context.ownerResetGenerations.get(tail.captureOwnerId);
      if (prevResetGen !== undefined) {
        requireProcessing(tail.captureResetGeneration >= prevResetGen,
          `captureResetGeneration regressed for owner ${tail.captureOwnerId}: was ${prevResetGen}, got ${tail.captureResetGeneration}`);
      }
      context.ownerResetGenerations.set(tail.captureOwnerId, tail.captureResetGeneration);
    }
  }

  return {
    hasReceipt: true,
    partial: isPartial,
    tailAdmission: tail ?? null,
    passed: true,
    strictValidated: strict,
    diagnosticOnly: true,
  };
}
