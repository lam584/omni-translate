import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateMmcssAudioReceipt, validateProbeMmcssAudio } from './local-aec-mmcss-receipt.mjs';

function validReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    taskName: 'Audio',
    ownerThreadId: 41,
    registrationAttempted: true,
    registrationSucceeded: true,
    taskIndex: 0,
    registrationErrorCode: null,
    cleanupAttempted: true,
    revertAttempted: true,
    revertSucceeded: true,
    revertThreadId: 41,
    revertErrorCode: null,
    restoreFailureKind: null,
    cleanupPath: 'explicit',
    state: 'restored',
    ...overrides,
  };
}

function validActiveReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    taskName: 'Audio',
    ownerThreadId: 41,
    registrationAttempted: true,
    registrationSucceeded: true,
    taskIndex: 0,
    registrationErrorCode: null,
    cleanupAttempted: false,
    revertAttempted: false,
    revertSucceeded: false,
    revertThreadId: null,
    revertErrorCode: null,
    restoreFailureKind: null,
    cleanupPath: null,
    state: 'active',
    ...overrides,
  };
}

const endpoint = '{0.0.0.00000000}.{ff6138b0-3914-409e-90cd-04f03dbba46e}';
const defaultRequest = { physicalDeviceId: endpoint };

function validProbe(overrides = {}) {
  const finalReceipt = validReceipt();
  const activeReceipt = validActiveReceipt();
  return {
    render: {
      renderSessionId: 101,
      ownerGeneration: 1,
      rendererInstanceId: 'renderer-inst-1',
      effectiveDeviceId: endpoint,
      deviceId: endpoint,
    },
    mmcssAudio: finalReceipt,
    mmcssAudioEvents: [activeReceipt, finalReceipt],
    mmcssAudioIdentity: {
      renderSessionId: 101,
      ownerGeneration: 1,
      rendererInstanceId: 'renderer-inst-1',
      endpointId: endpoint,
    },
    ...overrides,
  };
}

test('valid MmcssAudioReceipt restored passes', () => {
  const res = validateMmcssAudioReceipt(validReceipt(), 'restored');
  assert.equal(res.valid, true);
  assert.deepEqual(res.failures, []);
});

test('valid MmcssAudioReceipt active passes', () => {
  const res = validateMmcssAudioReceipt(validActiveReceipt(), 'active');
  assert.equal(res.valid, true);
  assert.deepEqual(res.failures, []);
});

test('valid probe MMCSS passes full validation', () => {
  const p = validProbe();
  const res = validateProbeMmcssAudio(p, defaultRequest);
  assert.equal(res.valid, true);
  assert.deepEqual(res.failures, []);
});

test('event key reordering passes deep strict equal', () => {
  const finalReceipt = validReceipt();
  // Construct restored event with keys in reverse order
  const reorderedEvent = {};
  for (const key of Object.keys(finalReceipt).reverse()) {
    reorderedEvent[key] = finalReceipt[key];
  }
  const p = validProbe({
    mmcssAudioEvents: [validActiveReceipt(), reorderedEvent],
  });
  const res = validateProbeMmcssAudio(p, defaultRequest);
  assert.equal(res.valid, true);
  assert.deepEqual(res.failures, []);
});

test('reject missing or primitive probe / mmcssAudio / mmcssAudioEvents / mmcssAudioIdentity / render', () => {
  assert.equal(validateProbeMmcssAudio(null).valid, false);
  assert.equal(validateProbeMmcssAudio('not-an-obj').valid, false);
  assert.equal(validateProbeMmcssAudio([]).valid, false);

  let p = validProbe();
  delete p.mmcssAudio;
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);

  p = validProbe({ mmcssAudio: 'string-receipt' });
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);

  p = validProbe({ mmcssAudio: [validReceipt()] });
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);

  p = validProbe();
  delete p.mmcssAudioEvents;
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);

  p = validProbe({ mmcssAudioEvents: 'not-an-array' });
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);

  p = validProbe();
  delete p.mmcssAudioIdentity;
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);

  p = validProbe({ mmcssAudioIdentity: 'primitive' });
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);

  p = validProbe({ mmcssAudioIdentity: [] });
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);

  p = validProbe();
  delete p.render;
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);

  p = validProbe({ render: 'primitive' });
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);

  p = validProbe({ render: [] });
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);
});

test('reject both missing identity fields (prevent undefined === undefined false pass)', () => {
  const p = validProbe();
  delete p.mmcssAudioIdentity.renderSessionId;
  delete p.render.renderSessionId;
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);

  const p2 = validProbe();
  delete p2.mmcssAudioIdentity.ownerGeneration;
  delete p2.render.ownerGeneration;
  assert.equal(validateProbeMmcssAudio(p2, defaultRequest).valid, false);

  const p3 = validProbe();
  delete p3.mmcssAudioIdentity.rendererInstanceId;
  delete p3.render.rendererInstanceId;
  assert.equal(validateProbeMmcssAudio(p3, defaultRequest).valid, false);

  const p4 = validProbe();
  delete p4.mmcssAudioIdentity.endpointId;
  delete p4.render.effectiveDeviceId;
  delete p4.render.deviceId;
  assert.equal(validateProbeMmcssAudio(p4, defaultRequest).valid, false);
});

test('reject zero / unsafe integer / negative identities', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 10]) {
    const p1 = validProbe();
    p1.mmcssAudioIdentity.renderSessionId = bad;
    p1.render.renderSessionId = bad;
    assert.equal(validateProbeMmcssAudio(p1, defaultRequest).valid, false);

    const p2 = validProbe();
    p2.mmcssAudioIdentity.ownerGeneration = bad;
    p2.render.ownerGeneration = bad;
    assert.equal(validateProbeMmcssAudio(p2, defaultRequest).valid, false);
  }
});

test('reject empty or non-string rendererInstanceId and endpointId', () => {
  for (const bad of ['', '   ', null, 123, true]) {
    const p1 = validProbe();
    p1.mmcssAudioIdentity.rendererInstanceId = bad;
    p1.render.rendererInstanceId = bad;
    assert.equal(validateProbeMmcssAudio(p1, defaultRequest).valid, false);

    const p2 = validProbe();
    p2.mmcssAudioIdentity.endpointId = bad;
    p2.render.effectiveDeviceId = bad;
    p2.render.deviceId = bad;
    assert.equal(validateProbeMmcssAudio(p2, defaultRequest).valid, false);
  }
});

test('reject request endpoint mismatch', () => {
  const p = validProbe();
  assert.equal(validateProbeMmcssAudio(p, { physicalDeviceId: '{0.0.0.00000000}.{00000000-0000-0000-0000-000000000000}' }).valid, false);
});

test('reject non-Audio taskName or invalid schemaVersion', () => {
  assert.equal(validateMmcssAudioReceipt(validReceipt({ taskName: 'ProAudio' })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ schemaVersion: 2 })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ schemaVersion: 0 })).valid, false);
});

test('reject invalid ownerThreadId (0, negative, non-integer, string)', () => {
  assert.equal(validateMmcssAudioReceipt(validReceipt({ ownerThreadId: 0 })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ ownerThreadId: -1 })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ ownerThreadId: 1.5 })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ ownerThreadId: '41' })).valid, false);
});

test('reject taskIndex non-u32 (negative, float, string)', () => {
  assert.equal(validateMmcssAudioReceipt(validReceipt({ taskIndex: -1 })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ taskIndex: 0.5 })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ taskIndex: '0' })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ taskIndex: 0 })).valid, true);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ taskIndex: 17 })).valid, true);
});

test('reject registrationFailed receipt', () => {
  const failed = {
    schemaVersion: 1,
    taskName: 'Audio',
    ownerThreadId: 41,
    registrationAttempted: true,
    registrationSucceeded: false,
    taskIndex: null,
    registrationErrorCode: 5,
    cleanupAttempted: false,
    revertAttempted: false,
    revertSucceeded: false,
    revertThreadId: null,
    revertErrorCode: null,
    restoreFailureKind: null,
    cleanupPath: null,
    state: 'registrationFailed',
  };
  assert.equal(validateMmcssAudioReceipt(failed, 'restored').valid, false);
  const p = validProbe({ mmcssAudio: failed, mmcssAudioEvents: [failed] });
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);
});

test('reject silent fallback / non-explicit cleanupPath / dropFallback', () => {
  assert.equal(validateMmcssAudioReceipt(validReceipt({ cleanupPath: 'dropFallback' })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ cleanupPath: null })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ cleanupPath: 'silent' })).valid, false);
});

test('reject owner thread mismatch between owner and revert', () => {
  assert.equal(validateMmcssAudioReceipt(validReceipt({ revertThreadId: 42 })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({
    revertThreadId: 42,
    restoreFailureKind: 'ownerThreadMismatch',
    state: 'restoreFailed'
  })).valid, false);
});

test('reject restore failure kind or failed revert', () => {
  assert.equal(validateMmcssAudioReceipt(validReceipt({ revertSucceeded: false })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ restoreFailureKind: 'nativeError' })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ revertErrorCode: 5 })).valid, false);
  assert.equal(validateMmcssAudioReceipt(validReceipt({ state: 'restoreFailed' })).valid, false);
});

test('reject probe.mmcssAudioEvents not strictly 2 items [active, restored]', () => {
  const p1 = validProbe({ mmcssAudioEvents: [validReceipt()] });
  assert.equal(validateProbeMmcssAudio(p1, defaultRequest).valid, false);

  const p3 = validProbe({ mmcssAudioEvents: [validActiveReceipt(), validReceipt(), validReceipt()] });
  assert.equal(validateProbeMmcssAudio(p3, defaultRequest).valid, false);

  const pEmpty = validProbe({ mmcssAudioEvents: [] });
  assert.equal(validateProbeMmcssAudio(pEmpty, defaultRequest).valid, false);
});

test('reject active event with cleanup fields set', () => {
  const badActive = validActiveReceipt({ cleanupAttempted: true });
  const p = validProbe({ mmcssAudioEvents: [badActive, validReceipt()] });
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);
});

test('reject event identity mismatch between active and restored', () => {
  const mismatchedActive = validActiveReceipt({ ownerThreadId: 99 });
  const p = validProbe({ mmcssAudioEvents: [mismatchedActive, validReceipt()] });
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);
});

test('reject extra or unexpected field on final event causing deep strict equal failure', () => {
  const finalWithExtra = validReceipt({ unknownExtraField: true });
  const p = validProbe({
    mmcssAudio: validReceipt(),
    mmcssAudioEvents: [validActiveReceipt(), finalWithExtra],
  });
  assert.equal(validateProbeMmcssAudio(p, defaultRequest).valid, false);
});

test('MMCSS identity binding rejects missing or invalid request rather than skipping endpoint authority', () => {
  for (const request of [undefined, null, {}, [], 1, { physicalDeviceId: '' }, { physicalDeviceId: '   ' }]) {
    assert.equal(validateProbeMmcssAudio(validProbe(), request).valid, false);
  }
});
