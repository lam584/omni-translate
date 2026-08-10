import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readJson } from '../lib/testing-common.mjs';
import {
  exactGitProvenanceFailure,
  gitProvenanceShapeFailure,
} from './git-provenance.mjs';

export const OVERLAY_CLICK_THROUGH_SCHEMA_VERSION = 1;
export const OVERLAY_CLICK_THROUGH_COLLECTOR_ID =
  'omni-overlay-click-through-release-evidence';
export const OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION = '0.1.0';
export const OVERLAY_CLICK_TARGET_COLLECTOR_ID = 'omni-overlay-click-target';
export const OVERLAY_CLICK_TARGET_COLLECTOR_VERSION = '0.1.0';
export const OVERLAY_CLICK_THROUGH_SCENARIO_ID = 'E2E-OVERLAY-CLICK-THROUGH';
export const OVERLAY_CLICK_THROUGH_RUNNER =
  'scripts/testing/run-overlay-click-through-release-evidence.mjs';
export const OVERLAY_CLICK_THROUGH_VALIDATOR =
  'scripts/testing/overlay-click-through-release-evidence.mjs';
export const OVERLAY_PROCESS_AUTHORITY_HELPER =
  'scripts/testing/windows-overlay-process-authority.ps1';
export const OVERLAY_TOOLING_RELATIVE_ROOT = 'artifacts/tooling/overlay-click-through';
export const PINNED_TAURI_DRIVER_VERSION = '2.0.6';

export const OVERLAY_CLICK_THROUGH_ARTIFACTS = Object.freeze([
  Object.freeze({ role: 'overlay-emitter-result', path: 'emitter-result.json' }),
  Object.freeze({ role: 'overlay-os-probe', path: 'overlay-click-through-probe.json' }),
  Object.freeze({ role: 'overlay-screenshot', path: 'overlay-click-through.png' }),
  Object.freeze({ role: 'overlay-target-ready', path: 'target-ready.json' }),
  Object.freeze({ role: 'overlay-target-click', path: 'target-click.json' }),
  Object.freeze({ role: 'overlay-webdriver-transcript', path: 'webdriver-transcript.json' }),
]);

export const OVERLAY_OS_TIMELINE = Object.freeze([
  'authority-started',
  'target-validated',
  'overlay-shown-locked',
  'hit-test-observed',
  'target-foreground-before-click',
  'send-input-click',
  'target-click-received',
  'target-foreground-confirmed',
  'screenshot-captured',
]);

export const OVERLAY_RUNNER_TIMELINE = Object.freeze([
  'runner-started',
  'release-binaries-verified',
  'target-started',
  'target-ready',
  'driver-started',
  'webdriver-session-created',
  'overlay-shown',
  'os-authority-completed',
  'operator-observation-recorded',
  'raw-artifacts-validated',
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_SIGNATURE = '89504e470d0a1a0a';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MICROSOFT_SIGNER_PATTERN = /(?:^|,)\s*CN=Microsoft Corporation(?:,|$)/i;
const FOUR_PART_VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

export const sha256Bytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const sha256File = (candidate) => sha256Bytes(fs.readFileSync(candidate));

export function fileReceipt(candidate) {
  const bytes = fs.readFileSync(candidate);
  return { bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

export function inspectPng(candidate) {
  const bytes = fs.readFileSync(candidate);
  if (bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw new Error('overlay-click-through.png is not a PNG file');
  }
  let offset = 8;
  let width = null;
  let height = null;
  let bitDepth = null;
  let colorType = null;
  let sawIdat = false;
  let sawIend = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (crcOffset + 4 > bytes.length) throw new Error(`PNG ${type} chunk is truncated`);
    const expectedCrc = bytes.readUInt32BE(crcOffset);
    const actualCrc = crc32(bytes.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) throw new Error(`PNG ${type} CRC is invalid`);
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13 || width !== null) {
        throw new Error('PNG must contain one leading IHDR chunk');
      }
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      if (bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0
        || bytes[dataStart + 12] !== 0) {
        throw new Error('PNG uses an unsupported compression/filter/interlace method');
      }
    } else if (type === 'IDAT') {
      sawIdat = true;
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error('PNG IEND chunk must be empty');
      sawIend = true;
      offset = crcOffset + 4;
      break;
    }
    offset = crcOffset + 4;
  }
  if (!sawIend || offset !== bytes.length || !sawIdat || width === null || height === null) {
    throw new Error('PNG has no complete IHDR/IDAT/IEND stream');
  }
  if (width < 320 || height < 180 || width > 4096 || height > 2160
    || bitDepth !== 8 || colorType !== 6) {
    throw new Error('overlay screenshot must be an 8-bit RGBA PNG between 320x180 and 4096x2160');
  }
  return { bytes, width, height, bitDepth, colorType, sha256: sha256Bytes(bytes) };
}

const readJsonSafe = (candidate, subject, issues) => {
  try {
    return readJson(candidate);
  } catch (error) {
    issues.push(`${subject} is missing or invalid JSON: ${error.message}`);
    return null;
  }
};

const positiveInteger = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

const requirePositiveInteger = (issues, value, subject) => {
  if (!positiveInteger(value)) issues.push(`${subject} must be a positive safe integer`);
};

const requireString = (issues, value, subject, minLength = 1) => {
  if (typeof value !== 'string' || value.trim().length < minLength) {
    issues.push(`${subject} must be a non-empty string`);
  }
};

const requireSha256 = (issues, value, subject) => {
  if (!SHA256_PATTERN.test(String(value ?? ''))) issues.push(`${subject} must be SHA-256`);
};

const parseTimestamp = (value) => {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : NaN;
};

const timestampIssue = (value, subject, nowMs, maxAgeMs) => {
  const parsed = parseTimestamp(value);
  if (!Number.isFinite(parsed)) return `${subject} must be an ISO timestamp`;
  if (parsed > nowMs + 60_000) return `${subject} is in the future`;
  if (nowMs - parsed > maxAgeMs) return `${subject} is older than the release evidence window`;
  return null;
};

const rectFailure = (rect, subject) => {
  if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0) {
    return `${subject} must contain finite positive bounds`;
  }
  return null;
};

const pointInside = (point, rect) => point
  && Number.isFinite(point.x)
  && Number.isFinite(point.y)
  && point.x >= rect.left
  && point.x < rect.left + rect.width
  && point.y >= rect.top
  && point.y < rect.top + rect.height;

const rectInside = (inner, outer) => inner.left >= outer.left
  && inner.top >= outer.top
  && inner.left + inner.width <= outer.left + outer.width
  && inner.top + inner.height <= outer.top + outer.height;

const validateTimeline = (issues, timeline, expected, subject, invocationId) => {
  if (!Array.isArray(timeline) || timeline.length !== expected.length) {
    issues.push(`${subject} must contain exactly ${expected.join(' -> ')}`);
    return;
  }
  let previousTimestamp = -Infinity;
  for (const [index, expectedEvent] of expected.entries()) {
    const entry = timeline[index];
    if (entry?.event !== expectedEvent || Number(entry?.sequence) !== index + 1) {
      issues.push(`${subject} event ${index + 1} must be ${expectedEvent} with matching sequence`);
    }
    if (entry?.invocationId !== undefined && entry.invocationId !== invocationId) {
      issues.push(`${subject} event ${index + 1} has the wrong invocationId`);
    }
    const timestamp = parseTimestamp(entry?.observedAt);
    if (!Number.isFinite(timestamp) || timestamp < previousTimestamp) {
      issues.push(`${subject} timestamps must be ordered`);
      break;
    }
    previousTimestamp = timestamp;
  }
};

const identityFailure = (value, artifactKind) => value?.schemaVersion !== 1
  || value?.artifactKind !== artifactKind;

const expectedPayloadReceipts = (root) => OVERLAY_CLICK_THROUGH_ARTIFACTS
  .filter(({ path: relativePath }) => relativePath !== 'emitter-result.json')
  .map(({ role, path: relativePath }) => ({
    role,
    path: relativePath,
    ...fileReceipt(path.join(root, relativePath)),
  }));

const verifyFileBinding = (issues, candidate, recordedPath, recordedHash, subject) => {
  if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    issues.push(`${subject} path does not exist`);
    return;
  }
  if (path.resolve(recordedPath ?? '') !== path.resolve(candidate)) {
    issues.push(`${subject} path is not the authority path`);
  }
  if (sha256File(candidate) !== recordedHash) issues.push(`${subject} SHA-256 does not match`);
};

const samePath = (left, right) => {
  const resolvedLeft = path.resolve(String(left ?? ''));
  const resolvedRight = path.resolve(String(right ?? ''));
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
};

const portableExecutableFailure = (candidate, subject) => {
  try {
    const bytes = fs.readFileSync(candidate);
    if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
      return `${subject} is not a Windows PE executable`;
    }
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset + 4 > bytes.length
      || bytes.subarray(peOffset, peOffset + 4).toString('hex') !== '50450000') {
      return `${subject} has no valid PE signature`;
    }
    return null;
  } catch (error) {
    return `${subject} PE inspection failed: ${error.message}`;
  }
};

const microsoftAuthorityFailure = (authority, subject, expectedName) => {
  if (!authority || !path.isAbsolute(String(authority.executablePath ?? ''))
    || !SHA256_PATTERN.test(String(authority.sha256 ?? ''))
    || !positiveInteger(authority.byteCount)) {
    return `${subject} has no absolute executable path/hash/byte authority`;
  }
  if (path.basename(authority.executablePath).toLowerCase() !== expectedName.toLowerCase()) {
    return `${subject} executable name must be ${expectedName}`;
  }
  if (authority.signature?.status !== 'Valid'
    || !MICROSOFT_SIGNER_PATTERN.test(String(authority.signature?.signerSubject ?? ''))
    || authority.companyName !== 'Microsoft Corporation') {
    return `${subject} must have a valid Microsoft Corporation Authenticode signature`;
  }
  if (!FOUR_PART_VERSION_PATTERN.test(String(authority.productVersion ?? ''))) {
    return `${subject} must expose an exact four-part product version`;
  }
  return null;
};

const validateProcessImage = (
  issues,
  snapshot,
  {
    processId,
    expectedPath,
    expectedSha256,
    expectedByteCount,
    subject,
    parentProcessId,
    buildCommit,
  },
) => {
  if (!snapshot || Number(snapshot.processId) !== Number(processId)
    || !positiveInteger(snapshot.processId)
    || !positiveInteger(snapshot.parentProcessId)
    || !path.isAbsolute(String(snapshot.executablePath ?? ''))
    || !samePath(snapshot.executablePath, expectedPath)
    || snapshot.sha256 !== expectedSha256
    || !positiveInteger(snapshot.byteCount)
    || (expectedByteCount !== undefined
      && Number(snapshot.byteCount) !== Number(expectedByteCount))) {
    issues.push(`${subject} PID/image path/SHA authority is invalid`);
    return;
  }
  if (parentProcessId !== undefined
    && Number(snapshot.parentProcessId) !== Number(parentProcessId)) {
    issues.push(`${subject} parent process authority is invalid`);
  }
  if (buildCommit !== undefined
    && String(snapshot.buildCommit ?? '').toLowerCase() !== String(buildCommit).toLowerCase()) {
    issues.push(`${subject} live image buildCommit authority is invalid`);
  }
};

const canonicalReleaseBinary = (workspaceRoot, executableName) => {
  const candidates = [
    path.join(workspaceRoot, 'target', 'release', executableName),
    path.join(
      workspaceRoot,
      'apps',
      'desktop',
      'src-tauri',
      'target',
      'release',
      executableName,
    ),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
};

export function validateOverlayClickThroughEvidence(root, {
  workspaceRoot = process.cwd(),
  currentProvenance,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  verifyAuthorityFiles = true,
  allowTestOnly = false,
} = {}) {
  const issues = [];
  const absoluteRoot = path.resolve(root);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const expectedNames = OVERLAY_CLICK_THROUGH_ARTIFACTS.map(({ path: relativePath }) => relativePath).sort();
  let actualNames = [];
  try {
    actualNames = fs.readdirSync(absoluteRoot).sort();
  } catch (error) {
    return { issues: [`overlay authority directory is unavailable: ${error.message}`], summary: null };
  }
  if (!isDeepStrictEqual(actualNames, expectedNames)) {
    issues.push(`overlay authority artifact set must be exactly: ${expectedNames.join(', ')}`);
  }

  const result = readJsonSafe(path.join(absoluteRoot, 'emitter-result.json'), 'emitter-result.json', issues);
  const probe = readJsonSafe(
    path.join(absoluteRoot, 'overlay-click-through-probe.json'),
    'overlay-click-through-probe.json',
    issues,
  );
  const ready = readJsonSafe(path.join(absoluteRoot, 'target-ready.json'), 'target-ready.json', issues);
  const click = readJsonSafe(path.join(absoluteRoot, 'target-click.json'), 'target-click.json', issues);
  const transcript = readJsonSafe(
    path.join(absoluteRoot, 'webdriver-transcript.json'),
    'webdriver-transcript.json',
    issues,
  );
  let screenshot = null;
  try {
    screenshot = inspectPng(path.join(absoluteRoot, 'overlay-click-through.png'));
  } catch (error) {
    issues.push(error.message);
  }
  if ([result, probe, ready, click, transcript].some((value) => !value)) {
    return { issues, summary: null, result, probe, ready, click, transcript };
  }

  if (identityFailure(result, 'overlay-click-through-emitter-result')
    || identityFailure(probe, 'overlay-os-click-through-probe')
    || identityFailure(ready, 'overlay-click-target-ready')
    || identityFailure(click, 'overlay-click-target-receipt')
    || identityFailure(transcript, 'overlay-webdriver-transcript')) {
    issues.push('overlay authority artifact identity/schema is invalid');
  }
  for (const [value, subject, expectedCollector] of [
    [result, 'emitter result', OVERLAY_CLICK_THROUGH_COLLECTOR_ID],
    [probe, 'OS probe', OVERLAY_CLICK_THROUGH_COLLECTOR_ID],
    [transcript, 'WebDriver transcript', OVERLAY_CLICK_THROUGH_COLLECTOR_ID],
    [ready, 'target ready receipt', OVERLAY_CLICK_TARGET_COLLECTOR_ID],
    [click, 'target click receipt', OVERLAY_CLICK_TARGET_COLLECTOR_ID],
  ]) {
    const expectedVersion = expectedCollector === OVERLAY_CLICK_TARGET_COLLECTOR_ID
      ? OVERLAY_CLICK_TARGET_COLLECTOR_VERSION
      : OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION;
    if (value?.collectorId !== expectedCollector || value?.collectorVersion !== expectedVersion) {
      issues.push(`${subject} collector identity is invalid`);
    }
  }
  if (result?.scenarioId !== OVERLAY_CLICK_THROUGH_SCENARIO_ID
    || result?.status !== 'completed' || result?.error != null
    || probe?.productionMode !== true || probe?.passed !== true) {
    issues.push('overlay authority must be one completed production scenario run');
  }
  const testOnly = result?.testOnly === true;
  if ((testOnly && allowTestOnly !== true) || (!testOnly && result?.testOnly !== false)) {
    issues.push('overlay production evidence rejects test-only or ambiguous runner authority');
  }
  const invocationId = result?.invocationId;
  if (!UUID_PATTERN.test(String(invocationId ?? ''))
    || [probe, ready, click, transcript].some((value) => value?.invocationId !== invocationId)) {
    issues.push('all overlay authority artifacts must share one UUID invocationId');
  }

  const recordedProvenanceFailure = gitProvenanceShapeFailure(
    result?.sourceProvenance,
    'overlay emitter source provenance',
  );
  if (recordedProvenanceFailure) issues.push(recordedProvenanceFailure);
  if (currentProvenance) {
    const exactFailure = exactGitProvenanceFailure(result?.sourceProvenance, currentProvenance, {
      recordedSubject: 'overlay emitter source provenance',
      currentSubject: 'current checkout',
    });
    if (exactFailure) issues.push(exactFailure);
  }
  const sourceHeadCommit = String(result?.sourceHeadCommit ?? '').toLowerCase();
  if (!COMMIT_PATTERN.test(sourceHeadCommit)
    || sourceHeadCommit !== String(result?.sourceProvenance?.headCommit ?? '').toLowerCase()
    || [probe, ready, click, transcript].some(
      (value) => String(value?.sourceHeadCommit ?? '').toLowerCase() !== sourceHeadCommit,
    )) {
    issues.push('all overlay artifacts must bind the exact source HEAD commit');
  }

  for (const [value, subject] of [
    [result?.startedAt, 'emitter startedAt'],
    [result?.completedAt, 'emitter completedAt'],
    [probe?.capturedAt, 'OS probe capturedAt'],
    [ready?.capturedAt, 'target ready capturedAt'],
    [click?.receivedAt, 'target click receivedAt'],
    [probe?.operatorObservation?.observedAt, 'operator observation observedAt'],
    [transcript?.startedAt, 'WebDriver transcript startedAt'],
    [transcript?.completedAt, 'WebDriver transcript completedAt'],
  ]) {
    const issue = timestampIssue(value, subject, nowMs, Number(maxAgeMs));
    if (issue) issues.push(issue);
  }
  const timeOrder = [
    result?.startedAt,
    ready?.capturedAt,
    transcript?.startedAt,
    click?.receivedAt,
    probe?.capturedAt,
    probe?.operatorObservation?.observedAt,
    transcript?.completedAt,
    result?.completedAt,
  ].map(parseTimestamp);
  if (timeOrder.some((value) => !Number.isFinite(value))
    || timeOrder.some((value, index) => index > 0 && value < timeOrder[index - 1])) {
    issues.push('overlay target/WebDriver/probe/operator/emitter timestamps are not ordered');
  }

  const processFields = [
    ['runner processId', result?.runnerProcessId],
    ['driver processId', result?.driverProcessId],
    ['native driver processId', result?.nativeDriverProcessId],
    ['desktop processId', result?.desktopProcessId],
    ['target processId', result?.targetProcessId],
  ];
  for (const [subject, value] of processFields) requirePositiveInteger(issues, value, subject);
  const processIds = processFields.map(([, value]) => Number(value));
  if (new Set(processIds).size !== processIds.length) {
    issues.push('runner, driver, Desktop, and target process IDs must be distinct');
  }
  for (const [subject, value] of [
    ['main HWND', probe?.mainHwnd],
    ['overlay HWND', probe?.overlayHwnd],
    ['target HWND', probe?.targetHwnd],
  ]) requirePositiveInteger(issues, value, subject);
  if (new Set([Number(probe?.mainHwnd), Number(probe?.overlayHwnd), Number(probe?.targetHwnd)]).size !== 3) {
    issues.push('Desktop main, overlay, and target HWNDs must be distinct');
  }
  if (Number(result?.desktopProcessId) !== Number(probe?.desktopProcessId)
    || Number(result?.targetProcessId) !== Number(probe?.targetProcessId)
    || Number(ready?.processId) !== Number(probe?.targetProcessId)
    || Number(click?.processId) !== Number(probe?.targetProcessId)
    || Number(ready?.hwnd) !== Number(probe?.targetHwnd)
    || Number(click?.hwnd) !== Number(probe?.targetHwnd)) {
    issues.push('Desktop/target PID and HWND authority does not cross-match');
  }
  if (probe?.desktopBuildCommit !== sourceHeadCommit
    || ready?.buildCommit !== sourceHeadCommit
    || click?.buildCommit !== sourceHeadCommit
    || probe?.targetReady?.buildCommit !== sourceHeadCommit
    || probe?.targetClick?.buildCommit !== sourceHeadCommit) {
    issues.push('Desktop and target live receipts must expose the exact compiled buildCommit');
  }

  for (const [rect, subject] of [
    [probe?.mainBounds, 'main bounds'],
    [probe?.overlayBounds, 'overlay bounds'],
    [probe?.targetBounds, 'target bounds'],
    [probe?.targetClientBounds, 'target client bounds'],
  ]) {
    const failure = rectFailure(rect, subject);
    if (failure) issues.push(failure);
  }
  if (![probe?.overlayBounds, probe?.targetBounds, probe?.targetClientBounds]
    .some((rect) => rectFailure(rect, 'bounds'))) {
    if (!rectInside(probe.overlayBounds, probe.targetClientBounds)) {
      issues.push('overlay bounds must be fully inside the real target client bounds');
    }
    if (!pointInside(probe?.clickPoint, probe.overlayBounds)
      || !pointInside(probe?.clickPoint, probe.targetClientBounds)) {
      issues.push('real click point must be inside both overlay and target client bounds');
    }
  }
  if (probe?.overlayLocked !== true || probe?.overlayVisible !== true
    || probe?.hitTestMessage !== 'WM_NCHITTEST'
    || probe?.hitTestResult !== 'HTTRANSPARENT'
    || Number(probe?.hitTestResultCode) !== -1) {
    issues.push('locked visible overlay must return WM_NCHITTEST/HTTRANSPARENT (-1)');
  }
  if (Number(probe?.sendInput?.requested) !== 3
    || Number(probe?.sendInput?.inserted) !== 3) {
    issues.push('SendInput must insert the real move/down/up sequence exactly once');
  }
  if (Number(probe?.foregroundBeforeHwnd) !== Number(probe?.targetHwnd)
    || Number(probe?.foregroundAfterHwnd) !== Number(probe?.targetHwnd)
    || probe?.overlayActivatedAfterClick !== false
    || Number(click?.foregroundHwndAtReceipt) !== Number(probe?.targetHwnd)) {
    issues.push('foreground must be the target before/during/after click and never the overlay');
  }
  if (click?.message !== 'WM_LBUTTONDOWN' || Number(click?.messageCode) !== 0x0201
    || Number(click?.clickCount) !== 1
    || Number(click?.screenPoint?.x) !== Number(probe?.clickPoint?.x)
    || Number(click?.screenPoint?.y) !== Number(probe?.clickPoint?.y)
    || Number(click?.clientPoint?.x)
      !== Number(probe?.clickPoint?.x) - Number(probe?.targetClientBounds?.left)
    || Number(click?.clientPoint?.y)
      !== Number(probe?.clickPoint?.y) - Number(probe?.targetClientBounds?.top)) {
    issues.push('target receipt must prove exactly one WM_LBUTTONDOWN at the SendInput point');
  }
  if (!isDeepStrictEqual(ready?.windowBounds, probe?.targetBounds)
    || !isDeepStrictEqual(click?.windowBounds, probe?.targetBounds)
    || ready?.windowTitle !== click?.windowTitle) {
    issues.push('target ready/click window identity and raw bounds must match the OS probe');
  }
  if (!isDeepStrictEqual(probe?.targetReady, ready) || !isDeepStrictEqual(probe?.targetClick, click)) {
    issues.push('OS probe must embed the exact raw target ready/click receipts');
  }
  validateTimeline(issues, probe?.eventTimeline, OVERLAY_OS_TIMELINE, 'OS authority timeline', invocationId);
  validateTimeline(
    issues,
    result?.timeline,
    OVERLAY_RUNNER_TIMELINE,
    'overlay runner timeline',
    invocationId,
  );
  if (Array.isArray(probe?.eventTimeline) && probe.eventTimeline.length === OVERLAY_OS_TIMELINE.length) {
    const details = probe.eventTimeline.map((entry) => entry?.detail ?? {});
    if (details[0]?.invocationId !== invocationId
      || Number(details[1]?.processId) !== Number(probe?.targetProcessId)
      || Number(details[1]?.hwnd) !== Number(probe?.targetHwnd)
      || Number(details[2]?.hwnd) !== Number(probe?.overlayHwnd)
      || !isDeepStrictEqual(details[2]?.bounds, probe?.overlayBounds)
      || details[3]?.message !== 'WM_NCHITTEST'
      || details[3]?.result !== 'HTTRANSPARENT'
      || Number(details[3]?.resultCode) !== -1
      || Number(details[4]?.hwnd) !== Number(probe?.targetHwnd)
      || Number(details[5]?.requested) !== 3
      || Number(details[5]?.inserted) !== 3
      || !isDeepStrictEqual(details[5]?.point, probe?.clickPoint)
      || details[6]?.message !== 'WM_LBUTTONDOWN'
      || Number(details[6]?.clickCount) !== 1
      || Number(details[7]?.hwnd) !== Number(probe?.targetHwnd)
      || details[7]?.overlayActivated !== false
      || details[8]?.sha256 !== probe?.screenshotSha256
      || Number(details[8]?.width) !== Number(probe?.screenshotWidth)
      || Number(details[8]?.height) !== Number(probe?.screenshotHeight)) {
      issues.push('OS authority timeline raw detail does not cross-match PID/HWND/input/screenshot facts');
    }
  }

  if (screenshot) {
    if (probe?.screenshot !== 'overlay-click-through.png'
      || probe?.screenshotSha256 !== screenshot.sha256
      || Number(probe?.screenshotByteCount) !== screenshot.bytes.length
      || Number(probe?.screenshotWidth) !== screenshot.width
      || Number(probe?.screenshotHeight) !== screenshot.height
      || screenshot.width !== Number(probe?.overlayBounds?.width)
      || screenshot.height !== Number(probe?.overlayBounds?.height)) {
      issues.push('real screenshot dimensions/hash/bytes must match the captured overlay bounds');
    }
  }
  const observation = probe?.operatorObservation;
  if (observation?.result !== 'passed'
    || typeof observation?.operator !== 'string' || observation.operator.trim().length < 2
    || typeof observation?.notes !== 'string' || observation.notes.trim().length < 8
    || observation?.screenshotSha256 !== probe?.screenshotSha256
    || Number(observation?.targetHwnd) !== Number(probe?.targetHwnd)
    || Number(observation?.overlayHwnd) !== Number(probe?.overlayHwnd)) {
    issues.push('a named operator must observe and bind the exact real screenshot/target/overlay');
  }

  if (transcript?.sessionId !== result?.sessionId
    || transcript?.driverEndpoint !== result?.driverEndpoint
    || Number(transcript?.driverProcessId) !== Number(result?.driverProcessId)
    || Number(transcript?.scriptTimeoutMs) !== Number(result?.scriptTimeoutMs)
    || Number(transcript?.scriptTimeoutMs) < 30_000
    || Number(transcript?.scriptTimeoutMs) > 600_000
    || !Array.isArray(transcript?.calls) || transcript.calls.length !== 2) {
    issues.push('WebDriver transcript is not bound to the launched driver/session');
  } else {
    const [show, authority] = transcript.calls;
    if (show?.sequence !== 1 || show?.command !== 'diagnostics_v2'
      || show?.payload?.command?.action !== 'overlaySelfCheck' || show?.result?.ok !== true
      || authority?.sequence !== 2
      || authority?.command !== 'collect_overlay_click_through_release_evidence'
      || Number(authority?.payload?.targetProcessId) !== Number(probe?.targetProcessId)
      || Number(authority?.payload?.targetHwnd) !== Number(probe?.targetHwnd)
      || authority?.result?.ok !== true) {
      issues.push('WebDriver transcript must contain the real overlay show and OS authority invokes');
    }
    const probeWithoutObservation = { ...probe };
    delete probeWithoutObservation.operatorObservation;
    if (!isDeepStrictEqual(authority?.result?.value, probeWithoutObservation)) {
      issues.push('OS probe was not derived unchanged from the WebDriver command result');
    }
    const transcriptTimes = [
      transcript?.startedAt,
      show?.requestedAt,
      show?.responseReceivedAt,
      authority?.requestedAt,
      authority?.responseReceivedAt,
      transcript?.completedAt,
    ].map(parseTimestamp);
    if (transcriptTimes.some((value) => !Number.isFinite(value))
      || transcriptTimes.some(
        (value, index) => index > 0 && value < transcriptTimes[index - 1],
      )) {
      issues.push('WebDriver raw request/response timeline is not ordered');
    }
    const osStart = parseTimestamp(probe?.eventTimeline?.[0]?.observedAt);
    const osEnd = parseTimestamp(probe?.eventTimeline?.at(-1)?.observedAt);
    if (!Number.isFinite(osStart) || !Number.isFinite(osEnd)
      || osStart < parseTimestamp(authority?.requestedAt)
      || osEnd > parseTimestamp(authority?.responseReceivedAt)) {
      issues.push('OS authority timeline must occur inside the WebDriver authority invoke');
    }
  }

  try {
    const expectedArtifacts = expectedPayloadReceipts(absoluteRoot);
    if (!isDeepStrictEqual(result?.artifacts, expectedArtifacts)) {
      issues.push('emitter artifact roles/hashes/bytes do not match the fixed raw payload');
    }
  } catch (error) {
    issues.push(`fixed payload receipt calculation failed: ${error.message}`);
  }

  const expectedRunner = path.join(workspaceRoot, ...OVERLAY_CLICK_THROUGH_RUNNER.split('/'));
  const expectedValidator = path.join(workspaceRoot, ...OVERLAY_CLICK_THROUGH_VALIDATOR.split('/'));
  const expectedProcessHelper = path.join(
    workspaceRoot,
    ...OVERLAY_PROCESS_AUTHORITY_HELPER.split('/'),
  );
  const runtimeVersion = String(result?.tooling?.webViewRuntime?.productVersion ?? '');
  const expectedTauriDriver = path.join(
    workspaceRoot,
    ...OVERLAY_TOOLING_RELATIVE_ROOT.split('/'),
    'tauri-driver',
    PINNED_TAURI_DRIVER_VERSION,
    'bin',
    'tauri-driver.exe',
  );
  const expectedNativeDriver = path.join(
    workspaceRoot,
    ...OVERLAY_TOOLING_RELATIVE_ROOT.split('/'),
    'msedgedriver',
    runtimeVersion,
    'msedgedriver.exe',
  );
  const expectedDesktopExecutable = canonicalReleaseBinary(
    workspaceRoot,
    'omni-desktop-shell.exe',
  );
  const expectedTargetExecutable = canonicalReleaseBinary(
    workspaceRoot,
    'omni-overlay-click-target.exe',
  );
  const supplyChain = result?.tooling?.supplyChain;
  if (!testOnly && (supplyChain?.tauriDriverCrate !== 'tauri-driver'
    || supplyChain?.tauriDriverVersion !== PINNED_TAURI_DRIVER_VERSION
    || supplyChain?.cargoLocked !== true
    || supplyChain?.cargoForcedInstall !== true
    || supplyChain?.nativeDriverSource
      !== `https://msedgedriver.microsoft.com/${runtimeVersion}/edgedriver_win64.zip`)) {
    issues.push('overlay production tooling must come from the pinned locked-source supply chain');
  }
  const tauriReceipt = result?.tooling?.tauriDriver?.installReceipt;
  const expectedTauriPackageId = `tauri-driver ${PINNED_TAURI_DRIVER_VERSION} (registry+https://github.com/rust-lang/crates.io-index)`;
  if (!testOnly && (tauriReceipt?.packageId !== expectedTauriPackageId
    || tauriReceipt?.versionRequirement !== `=${PINNED_TAURI_DRIVER_VERSION}`
    || !isDeepStrictEqual(tauriReceipt?.bins, ['tauri-driver.exe'])
    || tauriReceipt?.target !== 'x86_64-pc-windows-msvc'
    || !SHA256_PATTERN.test(String(tauriReceipt?.rustcSha256 ?? '')))) {
    issues.push('canonical tauri-driver cargo receipt must bind the exact pinned registry package');
  }
  if (!testOnly && (!samePath(result?.tooling?.tauriDriver?.executablePath, expectedTauriDriver)
    || !samePath(result?.tooling?.nativeDriver?.executablePath, expectedNativeDriver))) {
    issues.push('tauri-driver and Microsoft Edge WebDriver must use canonical tooling paths');
  }
  if (!testOnly) {
    for (const [authority, subject, expectedName] of [
      [result?.tooling?.nativeDriver, 'Microsoft Edge WebDriver', 'msedgedriver.exe'],
      [result?.tooling?.webViewRuntime, 'WebView2 runtime', 'msedgewebview2.exe'],
    ]) {
      const failure = microsoftAuthorityFailure(authority, subject, expectedName);
      if (failure) issues.push(failure);
    }
    if (result?.tooling?.nativeDriver?.productVersion !== runtimeVersion
      || result?.tooling?.webViewRuntime?.runtimeVersion !== runtimeVersion) {
      issues.push('Microsoft Edge WebDriver must exactly match the installed WebView2 runtime version');
    }
  }
  if (verifyAuthorityFiles) {
    verifyFileBinding(
      issues,
      expectedRunner,
      result?.runner?.path,
      result?.runner?.sha256,
      'overlay production runner',
    );
    verifyFileBinding(
      issues,
      expectedValidator,
      result?.validator?.path,
      result?.validator?.sha256,
      'overlay production validator',
    );
    verifyFileBinding(
      issues,
      expectedProcessHelper,
      result?.processAuthorityHelper?.path,
      result?.processAuthorityHelper?.sha256,
      'overlay process authority helper',
    );
    if (!testOnly) {
      const expectedInstallReceipt = path.join(
        workspaceRoot,
        ...OVERLAY_TOOLING_RELATIVE_ROOT.split('/'),
        'tauri-driver',
        PINNED_TAURI_DRIVER_VERSION,
        '.crates2.json',
      );
      verifyFileBinding(
        issues,
        expectedInstallReceipt,
        tauriReceipt?.path,
        tauriReceipt?.sha256,
        'tauri-driver cargo install receipt',
      );
    }
    verifyFileBinding(
      issues,
      expectedDesktopExecutable,
      result?.desktopExecutable,
      result?.desktopExecutableSha256,
      'release Desktop executable',
    );
    verifyFileBinding(
      issues,
      expectedTargetExecutable,
      result?.targetExecutable,
      result?.targetExecutableSha256,
      'overlay target executable',
    );
    for (const [tool, subject] of [
      [result?.tooling?.tauriDriver, 'tauri-driver executable'],
      [result?.tooling?.nativeDriver, 'native WebDriver executable'],
      [result?.tooling?.webViewRuntime, 'WebView2 runtime executable'],
    ]) {
      verifyFileBinding(
        issues,
        String(tool?.executablePath ?? ''),
        tool?.executablePath,
        tool?.sha256,
        subject,
      );
    }
    if (!testOnly) {
      for (const [candidate, subject] of [
        [result?.desktopExecutable, 'release Desktop executable'],
        [result?.targetExecutable, 'overlay target executable'],
        [result?.tooling?.tauriDriver?.executablePath, 'tauri-driver executable'],
        [result?.tooling?.nativeDriver?.executablePath, 'native WebDriver executable'],
        [result?.tooling?.webViewRuntime?.executablePath, 'WebView2 runtime executable'],
      ]) {
        const failure = portableExecutableFailure(String(candidate ?? ''), subject);
        if (failure) issues.push(failure);
      }
    }
  } else {
    for (const [value, subject] of [
      [result?.runner?.sha256, 'runner hash'],
      [result?.validator?.sha256, 'validator hash'],
      [result?.processAuthorityHelper?.sha256, 'process authority helper hash'],
      [result?.desktopExecutableSha256, 'Desktop executable hash'],
      [result?.targetExecutableSha256, 'target executable hash'],
      [result?.tooling?.tauriDriver?.sha256, 'tauri-driver hash'],
      [tauriReceipt?.sha256, 'tauri-driver cargo receipt hash'],
      [result?.tooling?.nativeDriver?.sha256, 'native driver hash'],
      [result?.tooling?.webViewRuntime?.sha256, 'WebView runtime hash'],
    ]) requireSha256(issues, value, subject);
  }
  if (!samePath(ready?.executablePath, result?.targetExecutable)
    || ready?.executableSha256 !== result?.targetExecutableSha256
    || probe?.desktopExecutableSha256 !== result?.desktopExecutableSha256
    || !samePath(probe?.desktopExecutable, result?.desktopExecutable)) {
    issues.push('target/Desktop executable paths and hashes do not cross-match raw OS receipts');
  }

  const beforeAuthority = result?.processAuthority?.capturedBeforeOsAuthority;
  const afterAuthority = result?.processAuthority?.capturedAfterOsAuthority;
  if (!beforeAuthority || !afterAuthority || !isDeepStrictEqual(beforeAuthority, afterAuthority)) {
    issues.push('live PID/image authority must be captured unchanged before and after the OS probe');
  } else {
    const expectedRoles = ['desktop', 'nativeDriver', 'runner', 'target', 'tauriDriver'];
    if (!isDeepStrictEqual(Object.keys(beforeAuthority).sort(), expectedRoles)) {
      issues.push('live process authority must contain exactly runner/driver/native/Desktop/target');
    }
    const fileSize = (candidate) => {
      try {
        return fs.statSync(candidate).size;
      } catch {
        return undefined;
      }
    };
    validateProcessImage(issues, beforeAuthority.runner, {
      processId: result?.runnerProcessId,
      expectedPath: beforeAuthority.runner?.executablePath,
      expectedSha256: beforeAuthority.runner?.sha256,
      expectedByteCount: beforeAuthority.runner?.byteCount,
      subject: 'runner process',
    });
    validateProcessImage(issues, beforeAuthority.tauriDriver, {
      processId: result?.driverProcessId,
      expectedPath: result?.tooling?.tauriDriver?.executablePath,
      expectedSha256: result?.tooling?.tauriDriver?.sha256,
      expectedByteCount: result?.tooling?.tauriDriver?.byteCount,
      parentProcessId: result?.runnerProcessId,
      subject: 'tauri-driver process',
    });
    validateProcessImage(issues, beforeAuthority.nativeDriver, {
      processId: result?.nativeDriverProcessId,
      expectedPath: result?.tooling?.nativeDriver?.executablePath,
      expectedSha256: result?.tooling?.nativeDriver?.sha256,
      expectedByteCount: result?.tooling?.nativeDriver?.byteCount,
      subject: 'native WebDriver process',
    });
    validateProcessImage(issues, beforeAuthority.desktop, {
      processId: result?.desktopProcessId,
      expectedPath: result?.desktopExecutable,
      expectedSha256: result?.desktopExecutableSha256,
      expectedByteCount: fileSize(String(result?.desktopExecutable ?? '')),
      buildCommit: sourceHeadCommit,
      subject: 'release Desktop process',
    });
    validateProcessImage(issues, beforeAuthority.target, {
      processId: result?.targetProcessId,
      expectedPath: result?.targetExecutable,
      expectedSha256: result?.targetExecutableSha256,
      expectedByteCount: fileSize(String(result?.targetExecutable ?? '')),
      parentProcessId: result?.runnerProcessId,
      buildCommit: sourceHeadCommit,
      subject: 'overlay target process',
    });
    if (beforeAuthority.nativeDriver?.productVersion
        !== result?.tooling?.nativeDriver?.productVersion
      || !isDeepStrictEqual(
        beforeAuthority.nativeDriver?.signature,
        result?.tooling?.nativeDriver?.signature,
      )
      || beforeAuthority.tauriDriver?.productVersion
        !== result?.tooling?.tauriDriver?.productVersion) {
      issues.push('live driver process version/signature authority does not match prepared tooling');
    }
  }

  return {
    issues,
    result,
    probe,
    ready,
    click,
    transcript,
    summary: issues.length === 0 ? {
      invocationId,
      desktopProcessId: Number(probe.desktopProcessId),
      targetProcessId: Number(probe.targetProcessId),
      overlayHwnd: Number(probe.overlayHwnd),
      targetHwnd: Number(probe.targetHwnd),
      screenshotSha256: probe.screenshotSha256,
      operator: observation.operator,
    } : null,
  };
}

export function assertOverlayClickThroughEvidence(root, options) {
  const checked = validateOverlayClickThroughEvidence(root, options);
  if (checked.issues.length > 0 || !checked.summary) {
    throw new Error(`overlay click-through evidence failed:\n- ${checked.issues.join('\n- ')}`);
  }
  return checked;
}
