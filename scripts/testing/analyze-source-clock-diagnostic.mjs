import { describeSourceClockInterpolation } from './source-clock-interpolation-diagnostic.mjs';
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;
export const ARTIFACT_KIND = "aec-source-playback-clock-raw-diagnostic";
export const LEGACY_ARTIFACT_KIND = "aec-source-playback-clock";
export const SCOPE = "diagnostic-only-not-c03";

const TICKS_PER_SECOND = 10000000n; // 100ns units per second
const ONE_MS_TICKS = 10000n; // 1ms in 100ns units
const MAX_CLI_INPUT_BYTES = 32 * 1024 * 1024; // 32MB bounded CLI input

function isSafeNonNegativeInteger(val) {
  if (typeof val === "bigint") return val >= 0n;
  return Number.isSafeInteger(val) && val >= 0;
}

function parseBigIntSafe(val, label) {
  if (typeof val === "bigint") {
    if (val < 0n) throw new Error(label + " cannot be negative: " + val);
    return val;
  }
  if (typeof val === "number") {
    if (!Number.isSafeInteger(val) || val < 0) {
      throw new Error(label + " is not a non-negative safe integer: " + val);
    }
    return BigInt(val);
  }
  if (typeof val === "string" && /^[0-9]+$/u.test(val)) {
    return BigInt(val);
  }
  throw new Error(label + " is not a valid non-negative integer representation: " + val);
}

export function computeOriginQpc(position, frequency, qpc) {
  const p = parseBigIntSafe(position, "clockPosition");
  const f = parseBigIntSafe(frequency, "clockFrequency");
  const q = parseBigIntSafe(qpc, "qpc100ns");
  if (f === 0n) throw new Error("clockFrequency cannot be 0");
  const offset = (p * TICKS_PER_SECOND) / f;
  if (q < offset) {
    throw new Error("source render origin underflow: qpc is less than computed offset");
  }
  return q - offset;
}

export function parseDiagnosticTraceJsonl(content) {
  const lines = content.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error("JSONL parse error on line " + (idx + 1) + ": " + err.message);
    }
  });
}

function verifyNoSymlink(filePath) {
  const resolved = path.resolve(filePath);
  const lstat = fs.lstatSync(resolved);
  if (lstat.isSymbolicLink()) {
    throw new Error("Symlink inputs are rejected: " + resolved);
  }
  const real = fs.realpathSync.native(resolved);
  if (real.toLowerCase() !== resolved.toLowerCase()) {
    throw new Error("Path traverses a symlink/reparse redirect: " + resolved + " -> " + real);
  }
}

export function analyzeSourceClockTrace(records) {
  if (!Array.isArray(records)) {
    throw new Error("Trace input must be an array of records");
  }

  const analysisTime = new Date().toISOString();
  const issues = [];
  const parsedRecords = [];

  let previousPosition = null;
  let previousQpc = null;
  let previousSubmittedFrames = null;
  let expectedFrequency = null;
  let expectedEndpointId = null;
  let expectedProcessId = null;
  let expectedSampleRateHz = null;
  let expectedIndependentQpcFrequency = null;
  let stickyFailureTriggered = false;
  let stickyFailureReason = null;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const rowErrors = [];

    if (!row || typeof row !== "object") {
      rowErrors.push("Record " + i + " is not an object");
      if (!stickyFailureTriggered) {
        stickyFailureTriggered = true;
        stickyFailureReason = rowErrors.join("; ");
      }
      issues.push({ sequence: i, errors: rowErrors });
      parsedRecords.push({
        sequence: i,
        clockPosition: null,
        clockFrequency: null,
        qpc100ns: null,
        isStartupZero: false,
        originQpc: null,
        hasErrors: true,
        errors: rowErrors
      });
      continue;
    }

    if (row.schemaVersion !== 1) {
      rowErrors.push("Invalid schemaVersion: expected 1, got " + row.schemaVersion);
    }

    const isRawDiagnostic = row.artifactKind === ARTIFACT_KIND;
    const isLegacyAccepted = row.artifactKind === LEGACY_ARTIFACT_KIND;

    if (!isRawDiagnostic && !isLegacyAccepted) {
      rowErrors.push("Invalid artifactKind: expected \"" + ARTIFACT_KIND + "\" or \"" + LEGACY_ARTIFACT_KIND + "\", got \"" + row.artifactKind + "\"");
    }

    if (row.sequence !== i) {
      rowErrors.push("Sequence gap or invalid sequence: expected " + i + ", got " + row.sequence);
    }

    // Identity checks: endpointId, processId, sampleRateHz
    if (row.endpointId !== undefined) {
      if (typeof row.endpointId !== "string" || row.endpointId.length === 0) {
        rowErrors.push("endpointId invalid string");
      } else if (expectedEndpointId === null) {
        expectedEndpointId = row.endpointId;
      } else if (expectedEndpointId !== row.endpointId) {
        rowErrors.push("endpointId changed across trace: original " + expectedEndpointId + ", current " + row.endpointId);
      }
    }

    if (row.processId !== undefined) {
      if (!isSafeNonNegativeInteger(row.processId) || row.processId === 0) {
        rowErrors.push("processId invalid positive integer");
      } else if (expectedProcessId === null) {
        expectedProcessId = row.processId;
      } else if (expectedProcessId !== row.processId) {
        rowErrors.push("processId changed across trace: original " + expectedProcessId + ", current " + row.processId);
      }
    }

    if (row.sampleRateHz !== undefined) {
      if (!isSafeNonNegativeInteger(row.sampleRateHz) || row.sampleRateHz === 0) {
        rowErrors.push("sampleRateHz invalid positive integer");
      } else if (expectedSampleRateHz === null) {
        expectedSampleRateHz = row.sampleRateHz;
      } else if (expectedSampleRateHz !== row.sampleRateHz) {
        rowErrors.push("sampleRateHz changed across trace: original " + expectedSampleRateHz + ", current " + row.sampleRateHz);
      }
    }

    // independentQpcFrequency positive & constant check
    if (row.independentQpcFrequency !== undefined) {
      let indFreqVal = null;
      try {
        indFreqVal = parseBigIntSafe(row.independentQpcFrequency, "independentQpcFrequency");
        if (indFreqVal <= 0n) throw new Error("must be positive");
      } catch (err) {
        rowErrors.push("invalid independentQpcFrequency: " + err.message);
      }
      if (indFreqVal !== null) {
        if (expectedIndependentQpcFrequency === null) {
          expectedIndependentQpcFrequency = indFreqVal;
        } else if (expectedIndependentQpcFrequency !== indFreqVal) {
          rowErrors.push("independentQpcFrequency changed across trace: original " + expectedIndependentQpcFrequency + ", current " + indFreqVal);
        }
      }
    }

    // Safe clockFrequency parsing
    let parsedFreq = null;
    try {
      parsedFreq = parseBigIntSafe(row.clockFrequency, "clockFrequency");
      if (parsedFreq === 0n) throw new Error("clockFrequency cannot be zero");
      if (expectedFrequency === null) {
        expectedFrequency = parsedFreq;
      } else if (expectedFrequency !== parsedFreq) {
        rowErrors.push("clockFrequency changed across trace: original " + expectedFrequency + ", current " + parsedFreq);
      }
    } catch (err) {
      rowErrors.push("Invalid clockFrequency: " + err.message);
    }

    // Safe clockPosition parsing
    let parsedPos = null;
    try {
      parsedPos = parseBigIntSafe(row.clockPosition, "clockPosition");
      if (previousPosition !== null && parsedPos < previousPosition) {
        rowErrors.push("clockPosition retreated (non-monotonic): previous " + previousPosition + ", current " + parsedPos);
      }
      previousPosition = parsedPos;
    } catch (err) {
      rowErrors.push("Invalid clockPosition: " + err.message);
    }

    // Safe qpc100ns parsing & raw QPC monotonic check
    let parsedQpc = null;
    try {
      parsedQpc = parseBigIntSafe(row.qpc100ns, "qpc100ns");
      if (parsedQpc === 0n) throw new Error("qpc100ns cannot be zero");
      if (previousQpc !== null && parsedQpc < previousQpc) {
        rowErrors.push("qpc100ns retreated (non-monotonic): previous " + previousQpc + ", current " + parsedQpc);
      }
      previousQpc = parsedQpc;
    } catch (err) {
      rowErrors.push("Invalid qpc100ns: " + err.message);
    }

    // submittedFrames / paddingFrames bounds & monotonicity
    let parsedSubmitted = null;
    if (row.submittedFrames !== undefined) {
      try {
        parsedSubmitted = parseBigIntSafe(row.submittedFrames, "submittedFrames");
        if (previousSubmittedFrames !== null && parsedSubmitted < previousSubmittedFrames) {
          rowErrors.push("submittedFrames retreated: previous " + previousSubmittedFrames + ", current " + parsedSubmitted);
        }
        previousSubmittedFrames = parsedSubmitted;
      } catch (err) {
        rowErrors.push("Invalid submittedFrames: " + err.message);
      }
    }

    let parsedPadding = null;
    if (row.paddingFrames !== undefined && row.paddingFrames !== null) {
      try {
        parsedPadding = parseBigIntSafe(row.paddingFrames, "paddingFrames");
        if (parsedSubmitted !== null && parsedPadding > parsedSubmitted) {
          rowErrors.push("paddingFrames (" + parsedPadding + ") exceeds submittedFrames (" + parsedSubmitted + ")");
        }
      } catch (err) {
        rowErrors.push("Invalid paddingFrames: " + err.message);
      }
    }

    // callStartQpc100ns / callEndQpc100ns safe parsing
    let callStartVal = null;
    let callEndVal = null;
    let callDuration100ns = null;
    let callDurationAnomaly = false;

    if (row.callStartQpc100ns !== undefined && row.callEndQpc100ns !== undefined) {
      try {
        callStartVal = parseBigIntSafe(row.callStartQpc100ns, "callStartQpc100ns");
        callEndVal = parseBigIntSafe(row.callEndQpc100ns, "callEndQpc100ns");
        if (callEndVal < callStartVal) {
          rowErrors.push("callEndQpc100ns is earlier than callStartQpc100ns");
        } else {
          callDuration100ns = callEndVal - callStartVal;
          if (callDuration100ns > 50000n) {
            callDurationAnomaly = true;
          }
        }
      } catch (err) {
        rowErrors.push("Call duration QPC invalid: " + err.message);
      }
    }

    // New native trace row contracts:
    // scope: "diagnostic-only-not-c03", releaseEligible: false
    // rawClockHresult: null, rawClockAccuracyAvailable: false (or boolean)
    if (isRawDiagnostic) {
      if (row.scope !== undefined && row.scope !== SCOPE) {
        rowErrors.push("Row scope mismatch: expected \"" + SCOPE + "\", got \"" + row.scope + "\"");
      }
      if (row.releaseEligible !== undefined && row.releaseEligible !== false) {
        rowErrors.push("Row releaseEligible must be false in raw diagnostic trace");
      }
      if (row.rawClockAccuracyAvailable === true) {
        if (!Number.isInteger(row.rawClockHresult) || row.rawClockHresult < -2147483648 || row.rawClockHresult > 2147483647) {
          rowErrors.push("native clock HRESULT must be an actual signed 32-bit status");
        } else if (row.rawClockHresult !== 0) {
          rowErrors.push("native clock did not return precise S_OK: HRESULT " + row.rawClockHresult);
        }
      } else if (row.rawClockHresult != null) {
        rowErrors.push("native clock status contradicts unavailable accuracy metadata");
      }
    }

    if (row.nativeApiError !== undefined && row.nativeApiError !== null && typeof row.nativeApiError === "string" && row.nativeApiError.length > 0) {
      rowErrors.push("nativeApiError reported: " + row.nativeApiError);
    }

    if (row.strictValidationFailure !== undefined && row.strictValidationFailure !== null && typeof row.strictValidationFailure === "string" && row.strictValidationFailure.length > 0) {
      rowErrors.push("strictValidationFailure reported: " + row.strictValidationFailure);
    }

    const isStartupZero = parsedPos === 0n;

    // Origin calculation: startup-zero records (position === 0) do NOT produce a valid playback origin!
    let originQpc = null;
    if (parsedPos !== null && parsedFreq !== null && parsedQpc !== null) {
      if (!isStartupZero) {
        try {
          originQpc = computeOriginQpc(parsedPos, parsedFreq, parsedQpc);
        } catch (err) {
          rowErrors.push("Failed to compute origin: " + err.message);
        }
      }
    }

    if (rowErrors.length > 0) {
      if (!stickyFailureTriggered) {
        stickyFailureTriggered = true;
        stickyFailureReason = rowErrors.join("; ");
      }
      issues.push({ sequence: i, errors: rowErrors });
    }

    parsedRecords.push({
      sequence: row.sequence,
      clockPosition: parsedPos,
      clockFrequency: parsedFreq,
      qpc100ns: parsedQpc,
      isStartupZero,
      submittedFrames: parsedSubmitted,
      paddingFrames: parsedPadding,
      originQpc,
      callDuration100ns,
      callDurationAnomaly,
      qpcWithinNativeCallBracket: callStartVal !== null && callEndVal !== null && parsedQpc !== null
        ? callStartVal <= parsedQpc && parsedQpc <= callEndVal : null,
      rawClockHresult: row.rawClockAccuracyAvailable === true && Number.isInteger(row.rawClockHresult)
        && row.rawClockHresult >= -2147483648 && row.rawClockHresult <= 2147483647 ? row.rawClockHresult : null,
      rawClockAccuracyAvailable: row.rawClockAccuracyAvailable === true,
      hasErrors: rowErrors.length > 0,
      errors: rowErrors
    });
  }

  // Math on origins: ONLY position > 0 samples are valid origins for firstAnchor and span!
  const nonZeroRecords = parsedRecords.filter((r) => !r.isStartupZero && r.originQpc !== null);
  const validOrigins = nonZeroRecords.map((r) => r.originQpc);

  let firstAnchorDeviations = [];
  let adjacentOriginDeltas = [];
  let globalOriginSpanTicks = null;
  let globalOriginSpanMs = null;
  let unknownFixedOriginFeasible = false;
  let intersectionInterval = null;
  let firstAnchorRulePasses = false;

  if (validOrigins.length > 0) {
    const firstAnchor = validOrigins[0];
    firstAnchorDeviations = nonZeroRecords.map((r) => {
      const orig = r.originQpc;
      const dev = Number(orig - firstAnchor);
      return {
        sequence: r.sequence,
        deviationTicks: dev,
        deviationMs: dev / 10000.0,
        exceedsFrozen1ms: (orig > firstAnchor ? orig - firstAnchor : firstAnchor - orig) > ONE_MS_TICKS
      };
    });

    firstAnchorRulePasses = !firstAnchorDeviations.some((d) => d.exceedsFrozen1ms);

    for (let j = 1; j < nonZeroRecords.length; j++) {
      const delta = nonZeroRecords[j].originQpc - nonZeroRecords[j - 1].originQpc;
      adjacentOriginDeltas.push({
        fromSequence: nonZeroRecords[j - 1].sequence,
        toSequence: nonZeroRecords[j].sequence,
        deltaTicks: Number(delta),
        deltaMs: Number(delta) / 10000.0
      });
    }

    let minOrigin = validOrigins[0];
    let maxOrigin = validOrigins[0];
    for (const orig of validOrigins) {
      if (orig < minOrigin) minOrigin = orig;
      if (orig > maxOrigin) maxOrigin = orig;
    }
    globalOriginSpanTicks = Number(maxOrigin - minOrigin);
    globalOriginSpanMs = globalOriginSpanTicks / 10000.0;

    let maxLow = validOrigins[0] - ONE_MS_TICKS;
    let minHigh = validOrigins[0] + ONE_MS_TICKS;
    for (let k = 1; k < validOrigins.length; k++) {
      const low = validOrigins[k] - ONE_MS_TICKS;
      const high = validOrigins[k] + ONE_MS_TICKS;
      if (low > maxLow) maxLow = low;
      if (high < minHigh) minHigh = high;
    }

    if (maxLow <= minHigh) {
      unknownFixedOriginFeasible = true;
      intersectionInterval = {
        minOriginQpc: maxLow.toString(),
        maxOriginQpc: minHigh.toString(),
        widthTicks: Number(minHigh - maxLow),
        widthMs: Number(minHigh - maxLow) / 10000.0
      };
    } else {
      unknownFixedOriginFeasible = false;
      intersectionInterval = null;
    }
  }

  // Front-half vs back-half prediction on non-startup points
  let frontModelPredictionError = null;
  const nonZeroValidForModel = parsedRecords.filter((r) => !r.isStartupZero && r.clockPosition !== null && r.qpc100ns !== null);
  if (nonZeroValidForModel.length >= 4 && expectedFrequency !== null && expectedFrequency > 0n) {
    const half = Math.floor(nonZeroValidForModel.length / 2);
    const frontHalf = nonZeroValidForModel.slice(0, half);
    const backHalf = nonZeroValidForModel.slice(half);

    if (frontHalf.length >= 2 && backHalf.length >= 1) {
      const p0 = frontHalf[0].clockPosition;
      const q0 = frontHalf[0].qpc100ns;
      const pLast = frontHalf[frontHalf.length - 1].clockPosition;
      const qLast = frontHalf[frontHalf.length - 1].qpc100ns;

      const deltaP = pLast - p0;
      const deltaQ = qLast - q0;

      const predictions = backHalf.map((b) => {
        let predictedQpc = null;
        let errorTicks = null;
        let errorMs = null;
        if (deltaP > 0n) {
          predictedQpc = q0 + ((b.clockPosition - p0) * deltaQ) / deltaP;
          const err = b.qpc100ns - predictedQpc;
          errorTicks = Number(err);
          errorMs = errorTicks / 10000.0;
        } else {
          predictedQpc = q0 + ((b.clockPosition - p0) * TICKS_PER_SECOND) / expectedFrequency;
          const err = b.qpc100ns - predictedQpc;
          errorTicks = Number(err);
          errorMs = errorTicks / 10000.0;
        }
        return {
          sequence: b.sequence,
          actualQpc: b.qpc100ns.toString(),
          predictedQpc: predictedQpc ? predictedQpc.toString() : null,
          errorTicks,
          errorMs
        };
      });

      frontModelPredictionError = {
        frontHalfSamples: frontHalf.length,
        backHalfSamples: backHalf.length,
        predictions
      };
    }
  }

  const callDurationAnomalies = parsedRecords.filter((r) => r.callDurationAnomaly).map((r) => ({
    sequence: r.sequence,
    duration100ns: r.callDuration100ns !== null ? Number(r.callDuration100ns) : null,
    durationMs: r.callDuration100ns !== null ? Number(r.callDuration100ns) / 10000.0 : null
  }));

  const accuracyMissingCount = parsedRecords.filter((r) => !r.rawClockAccuracyAvailable).length;

  let naturalDrainReached = false;
  if (parsedRecords.length > 0) {
    const last = parsedRecords[parsedRecords.length - 1];
    if (last.paddingFrames === 0n && last.submittedFrames !== null) {
      naturalDrainReached = true;
    }
  }

  const startupZeroCount = parsedRecords.filter((r) => r.isStartupZero).length;

  // Hypothesis conclusions: Unknown unless evidence unique
  const hypothesisConclusions = {
    deviceOrQpcFaultProven: false,
    constantOriginModelFaultProven: false,
    reasoning: "Unknown unless evidence unique. Raw observations alone cannot distinguish between device clock inaccuracy and constant stream origin model mismatch."
  };

  // If entire trace is position-zero, there is NO origin evidence at all
  const allPositionsZero = parsedRecords.length > 0 && startupZeroCount === parsedRecords.length;

  const formalSourceClockAcceptance = false; // Formal source clock acceptance stays false!
  const diagnosticPassedWithoutErrors = !stickyFailureTriggered && issues.length === 0 && validOrigins.length >= 2 && !allPositionsZero;

  return {
    schemaVersion: 1,
    artifactKind: "source-clock-diagnostic-analysis-report",
    analyzedAt: analysisTime,
    scope: SCOPE,
    releaseEligible: false,
    aecQualityAcceptance: false,
    thresholdsChanged: false,
    formalSourceClockAcceptance,
    diagnosticPassedWithoutErrors,
    stickyFailureTriggered,
    stickyFailureReason,
    totalRecords: records.length,
    startupZeroCount,
    validOriginsCount: validOrigins.length,
    allPositionsZero,
    firstAnchorRulePasses,
    firstAnchorDeviations,
    adjacentOriginDeltas,
    globalOriginSpanTicks,
    globalOriginSpanMs,
    unknownFixedOriginFeasible,
    unknownFixedOriginFeasibilityDoesNotGrantAcceptance: true,
    intersectionInterval,
    frontModelPredictionError,
    callDurationAnomalies,
    localInterpolationDiagnostic: describeSourceClockInterpolation(parsedRecords),
    nativeStatusCounts: {
      sOk: parsedRecords.filter((r) => r.rawClockHresult === 0).length,
      sFalse: parsedRecords.filter((r) => r.rawClockHresult === 1).length,
      failed: parsedRecords.filter((r) => r.rawClockHresult < 0).length,
      unexpectedSuccess: parsedRecords.filter((r) => r.rawClockHresult > 1).length,
      missingOrMalformed: parsedRecords.filter((r) => r.rawClockHresult == null).length
    },
    independentQpcBracketCounts: {
      within: parsedRecords.filter((r) => r.qpcWithinNativeCallBracket === true).length,
      outside: parsedRecords.filter((r) => r.qpcWithinNativeCallBracket === false).length,
      unknown: parsedRecords.filter((r) => r.qpcWithinNativeCallBracket == null).length,
      bracketMembershipIsNotClockAccuracyProof: true
    },
    accuracyStatusMissing: accuracyMissingCount > 0,
    accuracyMissingCount,
    naturalDrainReached,
    hypothesisConclusions,
    issues
  };
}

export function main() {
  const args = process.argv.slice(2);
  let tracePath = null;
  let outputPath = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--trace") {
      if (i + 1 >= args.length) {
        console.error("Missing value for --trace");
        process.exit(1);
      }
      tracePath = args[++i];
    } else if (arg === "--out") {
      if (i + 1 >= args.length) {
        console.error("Missing value for --out");
        process.exit(1);
      }
      outputPath = args[++i];
    } else {
      console.error("Unknown flag: " + arg);
      process.exit(1);
    }
  }

  if (!tracePath) {
    console.error("Usage: node analyze-source-clock-diagnostic.mjs --trace <trace.jsonl> [--out <output.json>]");
    process.exit(1);
  }

  const resolvedTrace = path.resolve(tracePath);
  verifyNoSymlink(resolvedTrace);

  const stat = fs.statSync(resolvedTrace);
  if (!stat.isFile()) {
    console.error("Trace path is not a regular file: " + resolvedTrace);
    process.exit(1);
  }
  if (stat.size > MAX_CLI_INPUT_BYTES) {
    console.error("Trace file exceeds 32MB limit: " + stat.size + " bytes");
    process.exit(1);
  }

  const content = fs.readFileSync(resolvedTrace, "utf-8");
  const records = parseDiagnosticTraceJsonl(content);
  const report = analyzeSourceClockTrace(records);

  const jsonReport = JSON.stringify(report, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

  if (outputPath) {
    const resolvedOut = path.resolve(outputPath);
    verifyNoSymlink(path.dirname(resolvedOut));
    // Never overwrite raw evidence, an existing report, or a link target.
    fs.writeFileSync(resolvedOut, jsonReport, { encoding: "utf-8", flag: "wx" });
  } else {
    console.log(jsonReport);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  main();
}
