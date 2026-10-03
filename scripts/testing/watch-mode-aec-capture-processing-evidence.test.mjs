import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectPcmSamples,
  verifyCaptureProcessingRecord,
} from './watch-mode-aec-capture-processing-evidence.mjs';

function validProcessing(overrides = {}) {
  return {
    schemaVersion: 1,
    inputFrames: 960,
    native10msFrames: 2,
    mathPaddingFrames: 0,
    allInputProcessed: true,
    resetBeforeResumeRequired: false,
    tailAdmission: null,
    ...overrides,
  };
}

function validTail(overrides = {}) {
  const realFrames = 480;
  return {
    schemaVersion: 1,
    queueGeneration: 3,
    captureOwnerId: 101,
    captureResetGeneration: 2,
    byteLen: realFrames * 8,
    lastEmptyQueryId: 15,
    emptyPolls: 25,
    quietObservationSpanMs: 2050.0,
    maximumEmptyPollGapMs: 90.0,
    lastNonemptyAgeAtLastQueryMs: 2100.0,
    allZero: true,
    zeroSamples: realFrames * 2,
    nonzeroSamples: 0,
    realFrames,
    ...overrides,
  };
}

function validCaptureEvent(overrides = {}, processingOverrides = {}) {
  const preSampleCount = 960 * 2;
  return {
    schemaVersion: 3,
    sequence: 5,
    kind: 'capture',
    preSampleCount,
    postSampleCount: preSampleCount,
    resetGeneration: 1,
    continuityId: 1,
    aecProcessing: validProcessing(processingOverrides),
    ...overrides,
  };
}

test('inspectPcmSamples accurately counts finite zeroes and non-zeroes', () => {
  const samples = new Float32Array([0.0, -0.0, 1.0, -0.5, 0.0]);
  const res = inspectPcmSamples(samples);
  assert.equal(res.sampleCount, 5);
  assert.equal(res.zeroCount, 3);
  assert.equal(res.nonzeroCount, 2);
  assert.equal(res.allZero, false);

  const zeros = new Float32Array([0.0, -0.0, 0.0]);
  assert.equal(inspectPcmSamples(zeros).allZero, true);
});

test('inspectPcmSamples rejects non-finite samples (NaN and Infinity) and empty array standalone', () => {
  assert.throws(() => inspectPcmSamples(new Float32Array([0.0, NaN])), /non-finite/);
  assert.throws(() => inspectPcmSamples(new Float32Array([0.0, Infinity])), /non-finite/);
  assert.throws(() => inspectPcmSamples(new Float32Array([0.0, -Infinity])), /non-finite/);
  assert.throws(() => inspectPcmSamples(new Float32Array([])), /samples array cannot be empty/);
  assert.throws(() => inspectPcmSamples(null), /samples must be array-like/);
});

test('verifyCaptureProcessingRecord requires options.strict to be boolean if passed', () => {
  assert.throws(
    () => verifyCaptureProcessingRecord(validCaptureEvent(), null, null, { strict: 'false' }),
    /options\.strict must be a boolean/
  );
  assert.throws(
    () => verifyCaptureProcessingRecord(validCaptureEvent(), null, null, { strict: 1 }),
    /options\.strict must be a boolean/
  );
});

test('strict mode rejects receipt with missing or undefined tailAdmission field', () => {
  const procWithoutTail = validProcessing();
  delete procWithoutTail.tailAdmission;
  const event = validCaptureEvent({ aecProcessing: procWithoutTail });
  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }),
    /strict mode requires explicit tailAdmission field/
  );
});

test('verifyCaptureProcessingRecord passes for normal full 20ms frame without tail', () => {
  const event = validCaptureEvent();
  const pre = new Float32Array(1920);
  const post = new Float32Array(1920);
  const res = verifyCaptureProcessingRecord(event, pre, post, { strict: true });
  assert.equal(res.hasReceipt, true);
  assert.equal(res.partial, false);
  assert.equal(res.tailAdmission, null);
  assert.equal(res.passed, true);
  assert.equal(res.strictValidated, true);
  assert.equal(res.diagnosticOnly, true);
});

test('verifyCaptureProcessingRecord backward compatibility: missing receipt passes in non-strict mode but fails in strict mode', () => {
  const event = validCaptureEvent({ aecProcessing: undefined });
  const nonStrictRes = verifyCaptureProcessingRecord(event, null, null, { strict: false });
  assert.equal(nonStrictRes.hasReceipt, false);
  assert.equal(nonStrictRes.passed, true);
  assert.equal(nonStrictRes.strictValidated, false);
  assert.equal(nonStrictRes.diagnosticOnly, true);

  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }),
    /missing aecProcessing receipt in strict mode/
  );
});

test('verifyCaptureProcessingRecord rejects schema mismatch or non-object', () => {
  assert.throws(
    () => verifyCaptureProcessingRecord(validCaptureEvent({}, { schemaVersion: 3 }), null, null, { strict: true }),
    /unsupported aecProcessing schemaVersion/
  );
  assert.throws(
    () => verifyCaptureProcessingRecord(validCaptureEvent({ aecProcessing: 'invalid' }), null, null, { strict: true }),
    /aecProcessing must be an object/
  );
});

test('verifyCaptureProcessingRecord rejects frame math inconsistencies', () => {
  // preSampleCount = 1920 -> inputFrames = 960. Claimed inputFrames = 480
  assert.throws(
    () => verifyCaptureProcessingRecord(validCaptureEvent({}, { inputFrames: 480 }), null, null, { strict: true }),
    /inputFrames mismatch/
  );
  // native10msFrames mismatch
  assert.throws(
    () => verifyCaptureProcessingRecord(validCaptureEvent({}, { native10msFrames: 3 }), null, null, { strict: true }),
    /native10msFrames mismatch/
  );
  // mathPaddingFrames mismatch
  assert.throws(
    () => verifyCaptureProcessingRecord(validCaptureEvent({}, { mathPaddingFrames: 10 }), null, null, { strict: true }),
    /mathPaddingFrames mismatch/
  );
  // allInputProcessed must be true
  assert.throws(
    () => verifyCaptureProcessingRecord(validCaptureEvent({}, { allInputProcessed: false }), null, null, { strict: true }),
    /allInputProcessed must be true/
  );
});

test('verifyCaptureProcessingRecord requires resetBeforeResumeRequired when mathPaddingFrames > 0', () => {
  // Partial frame of 240 frames -> inputFrames: 240, native10msFrames: 1, mathPaddingFrames: 240
  const preSampleCount = 240 * 2;
  const event = validCaptureEvent({
    preSampleCount,
    postSampleCount: preSampleCount,
  }, {
    inputFrames: 240,
    native10msFrames: 1,
    mathPaddingFrames: 240,
    resetBeforeResumeRequired: false, // INVALID: must be true when mathPadding > 0
    tailAdmission: validTail({ realFrames: 240, byteLen: 240 * 8, zeroSamples: 480 }),
  });
  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }),
    /resetBeforeResumeRequired must be true when mathPaddingFrames > 0/
  );
});

test('strict mode rejects mathPaddingFrames > 0 with tailAdmission: null (anonymous computational padding)', () => {
  const preSampleCount = 240 * 2;
  const event = validCaptureEvent({
    preSampleCount,
    postSampleCount: preSampleCount,
  }, {
    inputFrames: 240,
    native10msFrames: 1,
    mathPaddingFrames: 240,
    resetBeforeResumeRequired: true,
    tailAdmission: null, // INVALID in strict mode!
  });
  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }),
    /strict mode rejects mathPaddingFrames > 0 without an authorized tailAdmission/
  );
});

test('verifyCaptureProcessingRecord validates tailAdmission completely', () => {
  const realFrames = 480;
  const preSampleCount = realFrames * 2;
  const tail = validTail({ realFrames });
  const event = validCaptureEvent({
    preSampleCount,
    postSampleCount: preSampleCount,
  }, {
    inputFrames: realFrames,
    native10msFrames: 1,
    mathPaddingFrames: 0,
    resetBeforeResumeRequired: false,
    tailAdmission: tail,
  });

  const prePcm = new Float32Array(preSampleCount); // all zero
  const postPcm = new Float32Array(preSampleCount);
  const context = { ownerResetGenerations: new Map() };

  const res = verifyCaptureProcessingRecord(event, prePcm, postPcm, { strict: true }, context);
  assert.equal(res.passed, true);
  assert.equal(res.partial, true);
  assert.equal(res.strictValidated, true);
  assert.equal(res.diagnosticOnly, true);
  assert.deepEqual(res.tailAdmission, tail);
});

test('tailAdmission rejects single Empty query (emptyPolls < 2 cannot observe 2s quiet span)', () => {
  const tail = validTail({
    emptyPolls: 1, // Single empty query cannot claim 2s continuous quiet
    quietObservationSpanMs: 2000.0,
    maximumEmptyPollGapMs: 10.0,
  });
  const event = validCaptureEvent({
    preSampleCount: 960,
    postSampleCount: 960,
  }, {
    inputFrames: 480,
    native10msFrames: 1,
    mathPaddingFrames: 0,
    tailAdmission: tail,
  });
  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }),
    /emptyPolls must be at least 2/
  );
});

test('tailAdmission rejects maximumEmptyPollGapMs <= 0 under 2s quiet span', () => {
  const tail = validTail({
    emptyPolls: 25,
    quietObservationSpanMs: 2000.0,
    maximumEmptyPollGapMs: 0.0,
  });
  const event = validCaptureEvent({
    preSampleCount: 960,
    postSampleCount: 960,
  }, {
    inputFrames: 480,
    native10msFrames: 1,
    mathPaddingFrames: 0,
    tailAdmission: tail,
  });
  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }),
    /maximumEmptyPollGapMs must be in \(0, 100\] ms/
  );
});

test('tailAdmission rejects quiet observation span exceeding (emptyPolls - 1) * maximumEmptyPollGapMs', () => {
  // If emptyPolls = 20, maxGap = 50ms, maximum possible observable span is 19 * 50 = 950ms.
  // But claimed quiet span is 2000ms.
  const tail = validTail({
    emptyPolls: 20,
    maximumEmptyPollGapMs: 50.0,
    quietObservationSpanMs: 2000.0, // Exceeds 19 * 50ms = 950ms!
  });
  const event = validCaptureEvent({
    preSampleCount: 960,
    postSampleCount: 960,
  }, {
    inputFrames: 480,
    native10msFrames: 1,
    mathPaddingFrames: 0,
    tailAdmission: tail,
  });
  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }),
    /exceeds \(emptyPolls - 1\) \* maximumEmptyPollGapMs/
  );
});

test('tailAdmission rejects realFrames >= 960 (must be short tail)', () => {
  const realFrames = 960;
  const tail = validTail({ realFrames, byteLen: realFrames * 8 });
  const event = validCaptureEvent({
    preSampleCount: realFrames * 2,
    postSampleCount: realFrames * 2,
  }, {
    inputFrames: realFrames,
    native10msFrames: 2,
    mathPaddingFrames: 0,
    tailAdmission: tail,
  });
  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }),
    /tailAdmission is only permitted for short tail/
  );
});

test('tailAdmission rejects captureOwnerId <= 0', () => {
  const tail = validTail({ captureOwnerId: 0 });
  const event = validCaptureEvent({
    preSampleCount: 960,
    postSampleCount: 960,
  }, {
    inputFrames: 480,
    native10msFrames: 1,
    mathPaddingFrames: 0,
    tailAdmission: tail,
  });
  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }),
    /captureOwnerId must be positive integer/
  );
});

test('tailAdmission rejects quiet observation span < 2000 ms', () => {
  const tail = validTail({ quietObservationSpanMs: 1999.0 });
  const event = validCaptureEvent({
    preSampleCount: 960,
    postSampleCount: 960,
  }, {
    inputFrames: 480,
    native10msFrames: 1,
    mathPaddingFrames: 0,
    tailAdmission: tail,
  });
  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }),
    /quietObservationSpanMs must be >= 2000 ms/
  );
});

test('tailAdmission rejects maximum empty poll gap > 100 ms', () => {
  const tail = validTail({ maximumEmptyPollGapMs: 100.1 });
  const event = validCaptureEvent({
    preSampleCount: 960,
    postSampleCount: 960,
  }, {
    inputFrames: 480,
    native10msFrames: 1,
    mathPaddingFrames: 0,
    tailAdmission: tail,
  });
  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }),
    /maximumEmptyPollGapMs must be in \(0, 100\] ms/
  );
});

test('tailAdmission rejects byteLen mismatch', () => {
  const tail = validTail({ byteLen: 480 * 8 - 1 });
  const event = validCaptureEvent({
    preSampleCount: 960,
    postSampleCount: 960,
  }, {
    inputFrames: 480,
    native10msFrames: 1,
    mathPaddingFrames: 0,
    tailAdmission: tail,
  });
  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }),
    /byteLen mismatch/
  );
});

test('tailAdmission rejects sample accounting mismatch with actual PCM', () => {
  const realFrames = 480;
  // Actual PCM has 1 non-zero sample
  const prePcm = new Float32Array(realFrames * 2);
  prePcm[10] = 0.5;

  // But receipt claims allZero = true and nonzeroSamples = 0
  const tail = validTail({
    realFrames,
    allZero: true,
    zeroSamples: realFrames * 2,
    nonzeroSamples: 0,
  });
  const event = validCaptureEvent({
    preSampleCount: realFrames * 2,
    postSampleCount: realFrames * 2,
  }, {
    inputFrames: realFrames,
    native10msFrames: 1,
    mathPaddingFrames: 0,
    tailAdmission: tail,
  });

  assert.throws(
    () => verifyCaptureProcessingRecord(event, prePcm, null, { strict: true }),
    /tail zeroSamples mismatch with actual disk PCM/
  );
});

test('tailAdmission rejects non-finite sample in actual pre or post PCM', () => {
  const realFrames = 480;
  const prePcm = new Float32Array(realFrames * 2);
  prePcm[5] = NaN;

  const tail = validTail({
    realFrames,
    allZero: false,
    zeroSamples: realFrames * 2 - 1,
    nonzeroSamples: 1,
  });
  const event = validCaptureEvent({
    preSampleCount: realFrames * 2,
    postSampleCount: realFrames * 2,
  }, {
    inputFrames: realFrames,
    native10msFrames: 1,
    mathPaddingFrames: 0,
    tailAdmission: tail,
  });

  assert.throws(
    () => verifyCaptureProcessingRecord(event, prePcm, null, { strict: true }),
    /non-finite sample/
  );
});

test('tailAdmission rejects owner captureResetGeneration regression in context', () => {
  const context = { ownerResetGenerations: new Map([[101, 5]]) };
  const tail = validTail({ captureOwnerId: 101, captureResetGeneration: 4 });
  const event = validCaptureEvent({
    preSampleCount: 960,
    postSampleCount: 960,
  }, {
    inputFrames: 480,
    native10msFrames: 1,
    mathPaddingFrames: 0,
    tailAdmission: tail,
  });
  assert.throws(
    () => verifyCaptureProcessingRecord(event, null, null, { strict: true }, context),
    /captureResetGeneration regressed for owner 101/
  );
});

function validBoundaryProcessingEvent(frames=480) {
  return validCaptureEvent({preSampleCount:frames*2,postSampleCount:frames*2}, {
    schemaVersion:2,inputFrames:frames,native10msFrames:Math.ceil(frames/480),mathPaddingFrames:Math.ceil(frames/480)*480-frames,
    resetBeforeResumeRequired:true,tailAdmission:null,boundaryAdmission:{schemaVersion:1,captureOwnerId:101,
      queueGeneration:2,boundaryId:1,closedSegmentId:1,nextSegmentId:2,byteLen:frames*8,realFrames:frames,
      boundaryReason:'device-frame-gap',oldSegmentStartDeviceFrameIndex:0,oldSegmentStartQpc100ns:10000000,
      oldSegmentEndDeviceFrameIndex:frames,nextPacketDeviceFrameIndex:2000,nextPacketQpc100ns:11000000,
      nextPacketDataDiscontinuity:false,nextPacketTimestampError:false,previousPacketTimestampError:false}});
}
test('schema2 boundary accepts real voiced short PCM, including unpadded 480 frames, not quietTail',()=>{
  for(const frames of [1,96,480,700,959]) {
    const e=validBoundaryProcessingEvent(frames);const actual=new Float32Array(frames*2).fill(0.25);
    const r=verifyCaptureProcessingRecord(e,actual,actual,{strict:true});
    assert.equal(r.partial,true);assert.equal(r.tailAdmission,null);assert.equal(r.boundaryAdmission.realFrames,frames);
  }
});
test('schema2 boundary typed receipt/real PCM guards fail closed',()=>{
  for(const mutate of [
    e=>{e.aecProcessing.resetBeforeResumeRequired=false;},e=>{e.aecProcessing.tailAdmission=validTail();},
    e=>{e.aecProcessing.schemaVersion=1;},e=>{delete e.aecProcessing.boundaryAdmission;},
    e=>{e.aecProcessing.boundaryAdmission.boundaryReason='quiet-tail';},
    e=>{e.aecProcessing.boundaryAdmission.nextSegmentId=1;},e=>{e.aecProcessing.boundaryAdmission.queueGeneration=0;},
    e=>{e.aecProcessing.boundaryAdmission.byteLen-=8;},e=>{e.aecProcessing.boundaryAdmission.oldSegmentEndDeviceFrameIndex++;},
    e=>{e.aecProcessing.boundaryAdmission.boundaryReason='timestamp-error';},
    e=>{e.aecProcessing.boundaryAdmission.boundaryReason='data-discontinuity';},
    e=>{e.aecProcessing.boundaryAdmission.nextPacketDeviceFrameIndex=480;},
    e=>{e.aecProcessing.boundaryAdmission.nextPacketTimestampError=null;},
  ]) {const e=validBoundaryProcessingEvent();mutate(e);assert.throws(()=>verifyCaptureProcessingRecord(e,null,null,{strict:true}));}
  assert.throws(()=>verifyCaptureProcessingRecord(validBoundaryProcessingEvent(960),null,null,{strict:true}),/boundaryAdmission/);
  const e=validBoundaryProcessingEvent(96);const actual=new Float32Array(192).fill(0.1);actual[0]=NaN;
  assert.throws(()=>verifyCaptureProcessingRecord(e,actual,new Float32Array(192),{strict:true}),/non-finite/);
  assert.throws(()=>verifyCaptureProcessingRecord(e,new Float32Array(190),new Float32Array(192),{strict:true}),/length mismatch/);
});
