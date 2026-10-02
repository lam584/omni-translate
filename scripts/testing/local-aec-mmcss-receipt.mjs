/**
 * Strict validation for MMCSS Audio RAII receipts.
 * SchemaVersion 1, deterministic typed fields, no silent fallback.
 */

import { isDeepStrictEqual } from 'node:util';

const U32_MAX = 0xFFFF_FFFF;

function isU32(val, { allowZero = true } = {}) {
  if (typeof val !== 'number' || !Number.isInteger(val)) return false;
  if (allowZero) {
    return val >= 0 && val <= U32_MAX;
  }
  return val > 0 && val <= U32_MAX;
}

function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

function isPositiveSafeInteger(val) {
  return typeof val === 'number' && Number.isSafeInteger(val) && val > 0;
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

/**
 * Validates a single MmcssAudioReceipt object.
 *
 * @param {any} receipt
 * @param {'active' | 'restored' | 'registrationFailed' | 'restoreFailed'} expectedPhase
 * @returns {{ valid: boolean, failures: string[] }}
 */
export function validateMmcssAudioReceipt(receipt, expectedPhase = 'restored') {
  const failures = [];
  const check = (ok, msg) => {
    if (!ok) failures.push(msg);
  };

  if (!isPlainObject(receipt)) {
    return { valid: false, failures: ['receipt is not an object'] };
  }

  check(receipt.schemaVersion === 1, 'schemaVersion must be 1');
  check(receipt.taskName === 'Audio', 'taskName must be "Audio"');
  check(isU32(receipt.ownerThreadId, { allowZero: false }), 'ownerThreadId must be u32 > 0');
  check(receipt.registrationAttempted === true, 'registrationAttempted must be true');

  if (expectedPhase === 'restored') {
    check(receipt.registrationSucceeded === true, 'registrationSucceeded must be true');
    check(isU32(receipt.taskIndex, { allowZero: true }), 'taskIndex must be u32 >= 0');
    check(receipt.registrationErrorCode === null, 'registrationErrorCode must be null');
    check(receipt.cleanupAttempted === true, 'cleanupAttempted must be true');
    check(receipt.revertAttempted === true, 'revertAttempted must be true');
    check(receipt.revertSucceeded === true, 'revertSucceeded must be true');
    check(isU32(receipt.revertThreadId, { allowZero: false }) && receipt.revertThreadId === receipt.ownerThreadId, 'revertThreadId must match ownerThreadId');
    check(receipt.revertErrorCode === null, 'revertErrorCode must be null');
    check(receipt.restoreFailureKind === null, 'restoreFailureKind must be null');
    check(receipt.cleanupPath === 'explicit', 'cleanupPath must be "explicit"');
    check(receipt.state === 'restored', 'state must be "restored"');
  } else if (expectedPhase === 'active') {
    check(receipt.registrationSucceeded === true, 'registrationSucceeded must be true');
    check(isU32(receipt.taskIndex, { allowZero: true }), 'taskIndex must be u32 >= 0');
    check(receipt.registrationErrorCode === null, 'registrationErrorCode must be null');
    check(receipt.cleanupAttempted === false, 'cleanupAttempted must be false in active state');
    check(receipt.revertAttempted === false, 'revertAttempted must be false in active state');
    check(receipt.revertSucceeded === false, 'revertSucceeded must be false in active state');
    check(receipt.revertThreadId === null, 'revertThreadId must be null in active state');
    check(receipt.revertErrorCode === null, 'revertErrorCode must be null in active state');
    check(receipt.restoreFailureKind === null, 'restoreFailureKind must be null in active state');
    check(receipt.cleanupPath === null, 'cleanupPath must be null in active state');
    check(receipt.state === 'active', 'state must be "active"');
  } else if (expectedPhase === 'registrationFailed') {
    check(receipt.registrationSucceeded === false, 'registrationSucceeded must be false');
    check(receipt.taskIndex === null, 'taskIndex must be null');
    check(isU32(receipt.registrationErrorCode, { allowZero: true }), 'registrationErrorCode must be u32');
    check(receipt.cleanupAttempted === false, 'cleanupAttempted must be false');
    check(receipt.revertAttempted === false, 'revertAttempted must be false');
    check(receipt.revertSucceeded === false, 'revertSucceeded must be false');
    check(receipt.revertThreadId === null, 'revertThreadId must be null');
    check(receipt.revertErrorCode === null, 'revertErrorCode must be null');
    check(receipt.restoreFailureKind === null, 'restoreFailureKind must be null');
    check(receipt.cleanupPath === null, 'cleanupPath must be null');
    check(receipt.state === 'registrationFailed', 'state must be "registrationFailed"');
  } else if (expectedPhase === 'restoreFailed') {
    check(receipt.registrationSucceeded === true, 'registrationSucceeded must be true');
    check(isU32(receipt.taskIndex, { allowZero: true }), 'taskIndex must be u32 >= 0');
    check(receipt.cleanupAttempted === true, 'cleanupAttempted must be true');
    check(receipt.revertSucceeded === false, 'revertSucceeded must be false');
    check(receipt.restoreFailureKind !== null, 'restoreFailureKind must be set');
    check(receipt.state === 'restoreFailed', 'state must be "restoreFailed"');
  }

  return { valid: failures.length === 0, failures };
}

/**
 * Validates MMCSS Audio receipts and events on a probe object.
 *
 * @param {any} probe
 * @param {any} request
 * @returns {{ valid: boolean, failures: string[] }}
 */
export function validateProbeMmcssAudio(probe, request) {
  const failures = [];
  const check = (ok, msg) => {
    if (!ok) failures.push(msg);
  };

  if (!isPlainObject(probe)) {
    return { valid: false, failures: ['probe is not a valid object'] };
  }

  const finalReceipt = probe.mmcssAudio;
  const events = probe.mmcssAudioEvents;
  const identity = probe.mmcssAudioIdentity;
  const render = probe.render;

  if (!isPlainObject(finalReceipt)) {
    failures.push('probe.mmcssAudio must be a valid object');
  }
  if (!Array.isArray(events)) {
    failures.push('probe.mmcssAudioEvents must be an array');
  }
  if (!isPlainObject(identity)) {
    failures.push('probe.mmcssAudioIdentity must be a valid object');
  }
  if (!isPlainObject(render)) {
    failures.push('probe.render must be a valid object');
  }

  if (failures.length > 0) {
    return { valid: false, failures };
  }

  // 1. Validate final receipt
  const finalVal = validateMmcssAudioReceipt(finalReceipt, 'restored');
  if (!finalVal.valid) {
    failures.push(...finalVal.failures.map(f => `probe.mmcssAudio: ${f}`));
  }

  // 2. Validate events array: strictly two items [active, restored]
  if (events.length !== 2) {
    failures.push(`probe.mmcssAudioEvents must be an array of exactly 2 items, got length ${events.length}`);
  } else {
    const [activeEvt, restoredEvt] = events;
    const activeVal = validateMmcssAudioReceipt(activeEvt, 'active');
    if (!activeVal.valid) {
      failures.push(...activeVal.failures.map(f => `probe.mmcssAudioEvents[0]: ${f}`));
    }
    const restoredVal = validateMmcssAudioReceipt(restoredEvt, 'restored');
    if (!restoredVal.valid) {
      failures.push(...restoredVal.failures.map(f => `probe.mmcssAudioEvents[1]: ${f}`));
    }

    if (isPlainObject(activeEvt) && isPlainObject(restoredEvt)) {
      // Identity consistency across events
      check(activeEvt.ownerThreadId === restoredEvt.ownerThreadId, 'events ownerThreadId mismatch');
      check(activeEvt.taskName === restoredEvt.taskName, 'events taskName mismatch');
      check(activeEvt.taskIndex === restoredEvt.taskIndex, 'events taskIndex mismatch');
      check(activeEvt.registrationAttempted === restoredEvt.registrationAttempted, 'events registrationAttempted mismatch');
      check(activeEvt.registrationSucceeded === restoredEvt.registrationSucceeded, 'events registrationSucceeded mismatch');
      check(activeEvt.registrationErrorCode === restoredEvt.registrationErrorCode, 'events registrationErrorCode mismatch');

      // Final receipt deep strict equality with the last event (order-independent of object keys)
      check(isDeepStrictEqual(finalReceipt, restoredEvt), 'probe.mmcssAudio must strictly equal final event in probe.mmcssAudioEvents');
    }
  }

  // 3. Identity validation:
  // probe.mmcssAudioIdentity = { renderSessionId, ownerGeneration, endpointId, rendererInstanceId }
  // Both sides must be checked strictly:
  // - renderSessionId: positive safe integer
  // - ownerGeneration: positive safe integer
  // - rendererInstanceId: non-empty string
  // - endpointId: must match request.physicalDeviceId and probe.render effectiveDeviceId/deviceId
  check(isPositiveSafeInteger(identity.renderSessionId), 'mmcssAudioIdentity.renderSessionId must be a positive safe integer');
  check(isPositiveSafeInteger(render.renderSessionId), 'probe.render.renderSessionId must be a positive safe integer');
  check(identity.renderSessionId === render.renderSessionId, `renderSessionId mismatch: ${identity.renderSessionId} !== ${render.renderSessionId}`);

  check(isPositiveSafeInteger(identity.ownerGeneration), 'mmcssAudioIdentity.ownerGeneration must be a positive safe integer');
  check(isPositiveSafeInteger(render.ownerGeneration), 'probe.render.ownerGeneration must be a positive safe integer');
  check(identity.ownerGeneration === render.ownerGeneration, `ownerGeneration mismatch: ${identity.ownerGeneration} !== ${render.ownerGeneration}`);

  check(isNonEmptyString(identity.rendererInstanceId), 'mmcssAudioIdentity.rendererInstanceId must be a non-empty string');
  check(isNonEmptyString(render.rendererInstanceId), 'probe.render.rendererInstanceId must be a non-empty string');
  check(identity.rendererInstanceId === render.rendererInstanceId, `rendererInstanceId mismatch: ${identity.rendererInstanceId} !== ${render.rendererInstanceId}`);

  check(isNonEmptyString(identity.endpointId), 'mmcssAudioIdentity.endpointId must be a non-empty string');
  check(isNonEmptyString(render.effectiveDeviceId), 'probe.render.effectiveDeviceId must be a non-empty string');
  check(isNonEmptyString(render.deviceId), 'probe.render.deviceId must be a non-empty string');

  check(isPlainObject(request) && isNonEmptyString(request?.physicalDeviceId), 'request.physicalDeviceId is required for MMCSS identity binding');
  check(identity.endpointId === request?.physicalDeviceId, `mmcssAudioIdentity.endpointId must match request.physicalDeviceId: ${identity.endpointId} !== ${request?.physicalDeviceId}`);
  check(identity.endpointId === render.effectiveDeviceId, `mmcssAudioIdentity.endpointId must match render.effectiveDeviceId: ${identity.endpointId} !== ${render.effectiveDeviceId}`);
  check(identity.endpointId === render.deviceId, `mmcssAudioIdentity.endpointId must match render.deviceId: ${identity.endpointId} !== ${render.deviceId}`);

  return { valid: failures.length === 0, failures };
}
