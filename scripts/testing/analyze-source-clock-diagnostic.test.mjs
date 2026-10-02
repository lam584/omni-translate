import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_VERSION,
  ARTIFACT_KIND,
  LEGACY_ARTIFACT_KIND,
  SCOPE,
  computeOriginQpc,
  parseDiagnosticTraceJsonl,
  analyzeSourceClockTrace
} from "./analyze-source-clock-diagnostic.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(currentDir, "analyze-source-clock-diagnostic.mjs");

test("computeOriginQpc: exact integer origin qpc-floor(pos*1e7/freq)", () => {
  const origin = computeOriginQpc(40n, 384000n, 3066304583946n);
  // 40 * 10000000 / 384000 = 1041.6666... floor is 1041
  // 3066304583946 - 1041 = 3066304582905
  assert.equal(origin, 3066304582905n);

  // Large values without overflow
  const bigPos = 3840000000000000n;
  const bigFreq = 384000n;
  const bigQpc = 100000000000000000n;
  const expectedOffset = (bigPos * 10000000n) / bigFreq;
  assert.equal(computeOriginQpc(bigPos, bigFreq, bigQpc), bigQpc - expectedOffset);

  // Underflow throws
  assert.throws(() => computeOriginQpc(48n, 384000n, 1n), /source render origin underflow/);
  // Zero freq throws
  assert.throws(() => computeOriginQpc(48n, 0n, 10000000n), /clockFrequency cannot be 0/);
});

test("startup zero records: excluded from validOrigins, not used for firstAnchor; all-zero produces no origin evidence", () => {
  const recordsWithStartupZero = [
    {
      schemaVersion: 1,
      artifactKind: ARTIFACT_KIND,
      sequence: 0,
      endpointId: "ep-1",
      processId: 1234,
      sampleRateHz: 48000,
      clockPosition: 0, // startup-zero
      clockFrequency: 384000,
      qpc100ns: 10000000,
      submittedFrames: 480,
      paddingFrames: 480,
      rawClockHresult: null,
      rawClockAccuracyAvailable: false,
      scope: SCOPE,
      releaseEligible: false
    },
    {
      schemaVersion: 1,
      artifactKind: ARTIFACT_KIND,
      sequence: 1,
      endpointId: "ep-1",
      processId: 1234,
      sampleRateHz: 48000,
      clockPosition: 40,
      clockFrequency: 384000,
      qpc100ns: 10001041, // origin = 10001041 - 1041 = 10000000
      submittedFrames: 960,
      paddingFrames: 480,
      rawClockHresult: null,
      rawClockAccuracyAvailable: false,
      scope: SCOPE,
      releaseEligible: false
    },
    {
      schemaVersion: 1,
      artifactKind: ARTIFACT_KIND,
      sequence: 2,
      endpointId: "ep-1",
      processId: 1234,
      sampleRateHz: 48000,
      clockPosition: 3880,
      clockFrequency: 384000,
      qpc100ns: 10101041, // origin = 10101041 - 101041 = 10000000
      submittedFrames: 1440,
      paddingFrames: 0,
      rawClockHresult: null,
      rawClockAccuracyAvailable: false,
      scope: SCOPE,
      releaseEligible: false
    }
  ];

  const report = analyzeSourceClockTrace(recordsWithStartupZero);
  assert.equal(report.totalRecords, 3);
  assert.equal(report.startupZeroCount, 1);
  assert.equal(report.validOriginsCount, 2);
  assert.equal(report.firstAnchorDeviations[0].sequence, 1); // firstAnchor comes from sequence 1 (first non-zero)
  assert.equal(report.firstAnchorDeviations[0].deviationTicks, 0);
  assert.equal(report.firstAnchorRulePasses, true);
  assert.equal(report.allPositionsZero, false);
  assert.equal(report.formalSourceClockAcceptance, false); // Stays false!

  // All zeros trace
  const allZeros = [
    { schemaVersion: 1, artifactKind: ARTIFACT_KIND, sequence: 0, clockPosition: 0, clockFrequency: 384000, qpc100ns: 10000000 }
  ];
  const allZerosReport = analyzeSourceClockTrace(allZeros);
  assert.equal(allZerosReport.allPositionsZero, true);
  assert.equal(allZerosReport.validOriginsCount, 0);
  assert.equal(allZerosReport.diagnosticPassedWithoutErrors, false); // No origin evidence
});

test("null/undefined/string/malformed rows do not throw BigInt exception but failclosed and record error", () => {
  const badRows = [
    null,
    undefined,
    { schemaVersion: 1, artifactKind: ARTIFACT_KIND, sequence: 2, clockPosition: "not-a-number", clockFrequency: "abc", qpc100ns: null },
    {
      schemaVersion: 1,
      artifactKind: ARTIFACT_KIND,
      sequence: 3,
      clockPosition: -10,
      clockFrequency: 0,
      qpc100ns: "999999999999999999999999999999999999999999999999", // valid bigint string, but freq 0
      callStartQpc100ns: "bad-start",
      callEndQpc100ns: 12345
    }
  ];

  // Must not throw uncaught error!
  let report = null;
  assert.doesNotThrow(() => {
    report = analyzeSourceClockTrace(badRows);
  });
  assert.ok(report);
  assert.equal(report.diagnosticPassedWithoutErrors, false);
  assert.equal(report.stickyFailureTriggered, true);
  assert.ok(report.issues.length >= 3);
});

test("identity consistency: endpointId, processId, sampleRateHz, independentQpcFrequency, and qpc monotonicity", () => {
  // endpointId mismatch
  const epTrace = [
    { schemaVersion: 1, artifactKind: ARTIFACT_KIND, sequence: 0, endpointId: "ep-A", processId: 100, sampleRateHz: 48000, clockPosition: 40, clockFrequency: 384000, qpc100ns: 10001000 },
    { schemaVersion: 1, artifactKind: ARTIFACT_KIND, sequence: 1, endpointId: "ep-B", processId: 100, sampleRateHz: 48000, clockPosition: 80, clockFrequency: 384000, qpc100ns: 10002000 }
  ];
  const epReport = analyzeSourceClockTrace(epTrace);
  assert.equal(epReport.diagnosticPassedWithoutErrors, false);
  assert.match(epReport.stickyFailureReason, /endpointId changed/);

  // independentQpcFrequency change
  const qpcFreqTrace = [
    { schemaVersion: 1, artifactKind: ARTIFACT_KIND, sequence: 0, independentQpcFrequency: 10000000, clockPosition: 40, clockFrequency: 384000, qpc100ns: 10001000 },
    { schemaVersion: 1, artifactKind: ARTIFACT_KIND, sequence: 1, independentQpcFrequency: 24000000, clockPosition: 80, clockFrequency: 384000, qpc100ns: 10002000 }
  ];
  const qpcFreqReport = analyzeSourceClockTrace(qpcFreqTrace);
  assert.equal(qpcFreqReport.diagnosticPassedWithoutErrors, false);
  assert.match(qpcFreqReport.stickyFailureReason, /independentQpcFrequency changed/);

  // raw QPC retreated
  const qpcRetreatTrace = [
    { schemaVersion: 1, artifactKind: ARTIFACT_KIND, sequence: 0, clockPosition: 40, clockFrequency: 384000, qpc100ns: 10002000 },
    { schemaVersion: 1, artifactKind: ARTIFACT_KIND, sequence: 1, clockPosition: 80, clockFrequency: 384000, qpc100ns: 10001000 }
  ];
  const qpcRetreatReport = analyzeSourceClockTrace(qpcRetreatTrace);
  assert.equal(qpcRetreatReport.diagnosticPassedWithoutErrors, false);
  assert.match(qpcRetreatReport.stickyFailureReason, /qpc100ns retreated/);

  // paddingFrames exceeds submittedFrames
  const paddingTrace = [
    { schemaVersion: 1, artifactKind: ARTIFACT_KIND, sequence: 0, clockPosition: 40, clockFrequency: 384000, qpc100ns: 10001000, submittedFrames: 480, paddingFrames: 960 }
  ];
  const paddingReport = analyzeSourceClockTrace(paddingTrace);
  assert.equal(paddingReport.diagnosticPassedWithoutErrors, false);
  assert.match(paddingReport.stickyFailureReason, /paddingFrames \(960\) exceeds submittedFrames \(480\)/);
});

test("supports legacy accepted artifactKind (aec-source-playback-clock) but remains formalSourceClockAcceptance: false", () => {
  const legacyRows = [
    { artifactKind: LEGACY_ARTIFACT_KIND, schemaVersion: 1, sequence: 0, clockFrequency: 384000, clockPosition: 40, qpc100ns: 3066304583946, submittedFrames: 97440, paddingFrames: 95520 },
    { artifactKind: LEGACY_ARTIFACT_KIND, schemaVersion: 1, sequence: 1, clockFrequency: 384000, clockPosition: 3864, qpc100ns: 3066304675778, submittedFrames: 97920, paddingFrames: 95520 }
  ];
  const report = analyzeSourceClockTrace(legacyRows);
  assert.equal(report.validOriginsCount, 2);
  assert.equal(report.releaseEligible, false);
  assert.equal(report.aecQualityAcceptance, false);
  assert.equal(report.formalSourceClockAcceptance, false); // Legacy support does not grant formal acceptance
});

test("prior exact 5-point counterexample: firstAnchor rule must fail, but unknown fixed origin interval feasible", () => {
  const readings = [
    { pos: 40n, qpc: 3066304583946n },
    { pos: 3864n, qpc: 3066304675778n },
    { pos: 7712n, qpc: 3066304779540n },
    { pos: 11544n, qpc: 3066304879188n },
    { pos: 15392n, qpc: 3066304971078n }
  ];

  const records = readings.map((r, i) => ({
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sequence: i,
    clockPosition: r.pos,
    clockFrequency: 384000n,
    qpc100ns: r.qpc,
    submittedFrames: 97440 + i * 480,
    paddingFrames: 95520,
    rawClockHresult: null,
    rawClockAccuracyAvailable: false,
    strictValidationFailure: i === 4 ? "source render clock origin drift exceeds frozen 1ms bound" : null,
    nativeApiError: null
  }));

  const report = analyzeSourceClockTrace(records);

  assert.equal(report.scope, SCOPE);
  assert.equal(report.releaseEligible, false);
  assert.equal(report.aecQualityAcceptance, false);
  assert.equal(report.thresholdsChanged, false);
  assert.equal(report.formalSourceClockAcceptance, false);
  assert.equal(report.firstAnchorRulePasses, false); // Fifth point fails frozen 1ms!
  assert.equal(report.firstAnchorDeviations[4].exceedsFrozen1ms, true);
  assert.equal(report.firstAnchorDeviations[4].deviationTicks, -12660);
  assert.equal(report.firstAnchorDeviations[4].deviationMs, -1.266);

  // Unknown fixed origin interval must be feasible mathematically, but NOT grant acceptance
  assert.equal(report.unknownFixedOriginFeasible, true);
  assert.equal(report.unknownFixedOriginFeasibilityDoesNotGrantAcceptance, true);
  assert.ok(report.intersectionInterval);
  assert.equal(report.intersectionInterval.widthTicks, 7340);
  assert.equal(report.intersectionInterval.widthMs, 0.734);

  // Sticky failure was triggered by strictValidationFailure on row 4
  assert.equal(report.stickyFailureTriggered, true);
  assert.match(report.stickyFailureReason, /source render clock origin drift exceeds frozen 1ms bound/);

  // Hypotheses remain Unknown
  assert.equal(report.hypothesisConclusions.deviceOrQpcFaultProven, false);
  assert.equal(report.hypothesisConclusions.constantOriginModelFaultProven, false);
  assert.match(report.hypothesisConclusions.reasoning, /Unknown unless evidence unique/);
});

test("cumulative small interval drift (40+3840i, qpc10001250+99000i): adjacent delta is 0.1ms, but accumulates and must fail", () => {
  const records = [];
  for (let i = 0; i <= 11; i++) {
    const position = 40 + 3840 * i;
    const qpc = 10001250 + 99000 * i;
    records.push({
      schemaVersion: 1,
      artifactKind: ARTIFACT_KIND,
      sequence: i,
      clockPosition: position,
      clockFrequency: 384000,
      qpc100ns: qpc,
      submittedFrames: 960 * (i + 1),
      paddingFrames: 144,
      rawClockHresult: null,
      rawClockAccuracyAvailable: false,
      strictValidationFailure: i > 10 ? "source render clock origin drift exceeds frozen 1ms bound" : null,
      nativeApiError: null
    });
  }

  const report = analyzeSourceClockTrace(records);
  assert.equal(report.firstAnchorRulePasses, false);
  assert.equal(report.firstAnchorDeviations[11].exceedsFrozen1ms, true);
  assert.equal(report.adjacentOriginDeltas.every(d => Math.abs(d.deltaTicks) === 1000), true); // 0.1ms each interval
  assert.equal(report.globalOriginSpanTicks, 11000);
  assert.equal(report.globalOriginSpanMs, 1.1);
  assert.equal(report.unknownFixedOriginFeasible, true);
  assert.equal(report.intersectionInterval.widthMs, 0.9);
  assert.equal(report.formalSourceClockAcceptance, false);
});

test("CLI security bounds: rejects unknown flags, enforces 32MB limit, no symlinks", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "src-clock-sec-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const traceFile = path.join(tmpDir, "trace.jsonl");
  fs.writeFileSync(traceFile, JSON.stringify({ schemaVersion: 1, artifactKind: ARTIFACT_KIND, sequence: 0, clockPosition: 40, clockFrequency: 384000, qpc100ns: 10001000 }) + "\n", "utf-8");

  // Unknown flag rejected with exit code 1
  assert.throws(() => {
    execFileSync(process.execPath, [scriptPath, "--unknown-flag"], { encoding: "utf-8" });
  }, /Unknown flag/);

  // Normal execution works
  const outFile = path.join(tmpDir, "out.json");
  execFileSync(process.execPath, [scriptPath, "--trace", traceFile, "--out", outFile], { encoding: "utf-8" });
  assert.ok(fs.existsSync(outFile));
  const res = JSON.parse(fs.readFileSync(outFile, "utf-8"));
  assert.equal(res.scope, "diagnostic-only-not-c03");
  assert.equal(res.releaseEligible, false);
  const originalTrace = fs.readFileSync(traceFile);
  assert.throws(() => execFileSync(process.execPath, [scriptPath, "--trace", traceFile, "--out", traceFile], { encoding: "utf-8" }), /EEXIST/);
  assert.deepEqual(fs.readFileSync(traceFile), originalTrace);
  assert.throws(() => execFileSync(process.execPath, [scriptPath, "--trace", traceFile, "--out", outFile], { encoding: "utf-8" }), /EEXIST/);
  const oversized = path.join(tmpDir, "oversized.jsonl");
  const fd = fs.openSync(oversized, "wx"); fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1); fs.closeSync(fd);
  assert.throws(() => execFileSync(process.execPath, [scriptPath, "--trace", oversized], { encoding: "utf-8" }), /32MB/);
  const data = path.join(tmpDir, "data"); fs.mkdirSync(data); fs.copyFileSync(traceFile, path.join(data, "trace.jsonl"));
  const linked = path.join(tmpDir, "junction"); fs.symlinkSync(data, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => execFileSync(process.execPath, [scriptPath, "--trace", path.join(linked, "trace.jsonl")], { encoding: "utf-8" }), /symlink|reparse|symbolic/i);
});
