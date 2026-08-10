import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { ensureDir, writeJson } from '../lib/testing-common.mjs';
import {
  OVERLAY_CLICK_THROUGH_ARTIFACTS,
  OVERLAY_CLICK_THROUGH_COLLECTOR_ID,
  OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION,
  OVERLAY_CLICK_THROUGH_RUNNER,
  OVERLAY_CLICK_THROUGH_SCENARIO_ID,
  OVERLAY_CLICK_THROUGH_VALIDATOR,
  OVERLAY_CLICK_TARGET_COLLECTOR_ID,
  OVERLAY_CLICK_TARGET_COLLECTOR_VERSION,
  OVERLAY_PROCESS_AUTHORITY_HELPER,
  OVERLAY_OS_TIMELINE,
  OVERLAY_RUNNER_TIMELINE,
  OVERLAY_TOOLING_RELATIVE_ROOT,
  PINNED_TAURI_DRIVER_VERSION,
  fileReceipt,
  sha256Bytes,
  sha256File,
} from './overlay-click-through-release-evidence.mjs';

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

const chunk = (type, data) => {
  const typeBytes = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
};

const writePng = (candidate, width, height) => {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 4;
      row[offset] = (x + y) % 256;
      row[offset + 1] = (x * 3) % 256;
      row[offset + 2] = (y * 5) % 256;
      row[offset + 3] = 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const bytes = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(candidate, bytes);
  return bytes;
};

const ensureFile = (candidate, content) => {
  if (fs.existsSync(candidate)) return;
  ensureDir(path.dirname(candidate));
  fs.writeFileSync(candidate, content);
};

const minimalPe = (label) => {
  const prefix = Buffer.alloc(128);
  prefix.write('MZ', 0, 'ascii');
  prefix.writeUInt32LE(64, 0x3c);
  prefix.write('PE\0\0', 64, 'binary');
  return Buffer.concat([prefix, Buffer.from(label, 'utf8')]);
};

const timelineClock = (now) => {
  let value = now.getTime() - 60_000;
  return () => {
    value += 100;
    return new Date(value).toISOString();
  };
};

export function materializeOverlayClickThroughRawFixture({
  rawDirectory,
  workspaceRoot,
  provenance,
  now = new Date(),
  invocationId = 'df3e2979-94c8-4a13-9fc3-f4862cfed7a1',
} = {}) {
  ensureDir(rawDirectory);
  const nextTime = timelineClock(now);
  const runnerPath = path.join(workspaceRoot, ...OVERLAY_CLICK_THROUGH_RUNNER.split('/'));
  const validatorPath = path.join(workspaceRoot, ...OVERLAY_CLICK_THROUGH_VALIDATOR.split('/'));
  const desktopExecutable = path.join(workspaceRoot, 'target', 'release', 'omni-desktop-shell.exe');
  const targetExecutable = path.join(workspaceRoot, 'target', 'release', 'omni-overlay-click-target.exe');
  const runtimeVersion = '151.0.4129.72';
  const tauriDriver = path.join(
    workspaceRoot,
    ...OVERLAY_TOOLING_RELATIVE_ROOT.split('/'),
    'tauri-driver',
    PINNED_TAURI_DRIVER_VERSION,
    'bin',
    'tauri-driver.exe',
  );
  const nativeDriver = path.join(
    workspaceRoot,
    ...OVERLAY_TOOLING_RELATIVE_ROOT.split('/'),
    'msedgedriver',
    runtimeVersion,
    'msedgedriver.exe',
  );
  const webViewRuntime = path.join(
    workspaceRoot,
    'fixtures',
    'Microsoft',
    'EdgeWebView',
    'Application',
    runtimeVersion,
    'msedgewebview2.exe',
  );
  const processAuthorityHelper = path.join(
    workspaceRoot,
    ...OVERLAY_PROCESS_AUTHORITY_HELPER.split('/'),
  );
  const tauriInstallReceiptPath = path.join(
    workspaceRoot,
    ...OVERLAY_TOOLING_RELATIVE_ROOT.split('/'),
    'tauri-driver',
    PINNED_TAURI_DRIVER_VERSION,
    '.crates2.json',
  );
  for (const [candidate, content] of [
    [runnerPath, 'overlay production runner fixture'],
    [validatorPath, 'overlay production validator fixture'],
    [desktopExecutable, minimalPe('release Desktop fixture')],
    [targetExecutable, minimalPe('overlay target fixture')],
    [tauriDriver, minimalPe('tauri-driver fixture')],
    [nativeDriver, minimalPe('native driver fixture')],
    [webViewRuntime, minimalPe('WebView runtime fixture')],
    [processAuthorityHelper, 'overlay process authority helper fixture'],
  ]) ensureFile(candidate, content);
  const tauriPackageId = `tauri-driver ${PINNED_TAURI_DRIVER_VERSION} (registry+https://github.com/rust-lang/crates.io-index)`;
  if (!fs.existsSync(tauriInstallReceiptPath)) {
    writeJson(tauriInstallReceiptPath, {
      installs: {
        [tauriPackageId]: {
          version_req: `=${PINNED_TAURI_DRIVER_VERSION}`,
          bins: ['tauri-driver.exe'],
          features: [],
          all_features: false,
          no_default_features: false,
          profile: 'release',
          target: 'x86_64-pc-windows-msvc',
          rustc: 'rustc fixture authority',
        },
      },
    });
  }

  const runnerProcessId = 51_001;
  const driverProcessId = 51_002;
  const desktopProcessId = 51_003;
  const targetProcessId = 51_004;
  const nativeDriverProcessId = 51_005;
  const mainHwnd = 101_001;
  const overlayHwnd = 101_002;
  const targetHwnd = 202_001;
  const targetBounds = { left: 240, top: 220, width: 760, height: 420 };
  const targetClientBounds = { left: 248, top: 250, width: 744, height: 382 };
  const overlayBounds = { left: 420, top: 330, width: 400, height: 200 };
  const clickPoint = { x: 553, y: 430 };
  const sourceHeadCommit = provenance.headCommit;
  const ready = {
    schemaVersion: 1,
    artifactKind: 'overlay-click-target-ready',
    collectorId: OVERLAY_CLICK_TARGET_COLLECTOR_ID,
    collectorVersion: OVERLAY_CLICK_TARGET_COLLECTOR_VERSION,
    invocationId,
    sourceHeadCommit,
    buildCommit: sourceHeadCommit,
    capturedAt: nextTime(),
    processId: targetProcessId,
    hwnd: targetHwnd,
    windowTitle: 'Omni Overlay Click Target df3e2979',
    windowBounds: targetBounds,
    executablePath: targetExecutable,
    executableSha256: sha256File(targetExecutable),
  };
  const transcriptStartedAt = nextTime();
  const showResponseReceivedAt = nextTime();
  const authorityRequestedAt = nextTime();
  const eventTimes = OVERLAY_OS_TIMELINE.map(() => nextTime());
  const click = {
    schemaVersion: 1,
    artifactKind: 'overlay-click-target-receipt',
    collectorId: OVERLAY_CLICK_TARGET_COLLECTOR_ID,
    collectorVersion: OVERLAY_CLICK_TARGET_COLLECTOR_VERSION,
    invocationId,
    sourceHeadCommit,
    buildCommit: sourceHeadCommit,
    receivedAt: eventTimes[6],
    processId: targetProcessId,
    hwnd: targetHwnd,
    windowTitle: ready.windowTitle,
    windowBounds: targetBounds,
    message: 'WM_LBUTTONDOWN',
    messageCode: 0x0201,
    clickCount: 1,
    clientPoint: {
      x: clickPoint.x - targetClientBounds.left,
      y: clickPoint.y - targetClientBounds.top,
    },
    screenPoint: clickPoint,
    foregroundHwndAtReceipt: targetHwnd,
  };
  writeJson(path.join(rawDirectory, 'target-ready.json'), ready);
  writeJson(path.join(rawDirectory, 'target-click.json'), click);
  const png = writePng(
    path.join(rawDirectory, 'overlay-click-through.png'),
    overlayBounds.width,
    overlayBounds.height,
  );
  const screenshotSha256 = sha256Bytes(png);
  const details = [
    { invocationId },
    { processId: targetProcessId, hwnd: targetHwnd },
    { hwnd: overlayHwnd, bounds: overlayBounds },
    {
      message: 'WM_NCHITTEST',
      result: 'HTTRANSPARENT',
      resultCode: -1,
      windowFromPointHwnd: targetHwnd,
    },
    { hwnd: targetHwnd },
    { requested: 3, inserted: 3, point: clickPoint },
    { message: 'WM_LBUTTONDOWN', clickCount: 1 },
    { hwnd: targetHwnd, overlayActivated: false },
    { sha256: screenshotSha256, width: overlayBounds.width, height: overlayBounds.height },
  ];
  const eventTimeline = OVERLAY_OS_TIMELINE.map((event, index) => ({
    sequence: index + 1,
    event,
    observedAt: eventTimes[index],
    detail: details[index],
  }));
  const rawProbe = {
    schemaVersion: 1,
    artifactKind: 'overlay-os-click-through-probe',
    collectorId: OVERLAY_CLICK_THROUGH_COLLECTOR_ID,
    collectorVersion: OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION,
    productionMode: true,
    passed: true,
    capturedAt: nextTime(),
    invocationId,
    sourceHeadCommit,
    desktopBuildCommit: sourceHeadCommit,
    desktopProcessId,
    desktopExecutable,
    desktopExecutableSha256: sha256File(desktopExecutable),
    mainHwnd,
    mainBounds: { left: 100, top: 100, width: 900, height: 700 },
    overlayHwnd,
    overlayBounds,
    overlayLocked: true,
    overlayVisible: true,
    targetProcessId,
    targetHwnd,
    targetBounds,
    targetClientBounds,
    hitTestMessage: 'WM_NCHITTEST',
    hitTestResult: 'HTTRANSPARENT',
    hitTestResultCode: -1,
    windowFromPointHwnd: targetHwnd,
    clickPoint,
    sendInput: { requested: 3, inserted: 3 },
    foregroundBeforeHwnd: targetHwnd,
    foregroundAfterHwnd: targetHwnd,
    overlayActivatedAfterClick: false,
    targetReady: ready,
    targetClick: click,
    screenshot: 'overlay-click-through.png',
    screenshotSha256,
    screenshotByteCount: png.length,
    screenshotWidth: overlayBounds.width,
    screenshotHeight: overlayBounds.height,
    eventTimeline,
  };
  const authorityResponseReceivedAt = nextTime();
  const operatorObservation = {
    result: 'passed',
    operator: 'QA Operator',
    notes: 'Observed the target receive the click while the locked overlay remained passive.',
    observedAt: nextTime(),
    screenshotSha256,
    targetHwnd,
    overlayHwnd,
  };
  writeJson(path.join(rawDirectory, 'overlay-click-through-probe.json'), {
    ...rawProbe,
    operatorObservation,
  });
  const transcript = {
    schemaVersion: 1,
    artifactKind: 'overlay-webdriver-transcript',
    collectorId: OVERLAY_CLICK_THROUGH_COLLECTOR_ID,
    collectorVersion: OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION,
    invocationId,
    sourceHeadCommit,
    startedAt: transcriptStartedAt,
    completedAt: nextTime(),
    driverProcessId,
    driverEndpoint: 'http://127.0.0.1:4544',
    sessionId: 'fixture-webdriver-session',
    scriptTimeoutMs: 180_000,
    calls: [
      {
        sequence: 1,
        command: 'diagnostics_v2',
        payload: { command: { action: 'overlaySelfCheck' } },
        requestedAt: transcriptStartedAt,
        responseReceivedAt: showResponseReceivedAt,
        result: { ok: true, value: { overlaySelfCheck: 'shown' } },
      },
      {
        sequence: 2,
        command: 'collect_overlay_click_through_release_evidence',
        payload: { targetProcessId, targetHwnd },
        requestedAt: authorityRequestedAt,
        responseReceivedAt: authorityResponseReceivedAt,
        result: { ok: true, value: rawProbe },
      },
    ],
  };
  writeJson(path.join(rawDirectory, 'webdriver-transcript.json'), transcript);
  const startedAt = new Date(now.getTime() - 90_000).toISOString();
  const runnerTimeline = OVERLAY_RUNNER_TIMELINE.map((event, index) => ({
    sequence: index + 1,
    event,
    invocationId,
    observedAt: nextTime(),
  }));
  const unsignedSignature = {
    status: 'NotSigned',
    statusMessage: 'Not signed fixture',
    signerSubject: null,
    signerThumbprint: null,
    timeStamperSubject: null,
    timeStamperThumbprint: null,
  };
  const microsoftSignature = {
    status: 'Valid',
    statusMessage: 'Signature verified.',
    signerSubject: 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US',
    signerThumbprint: 'A'.repeat(40),
    timeStamperSubject: 'CN=Microsoft Time-Stamp Service, O=Microsoft Corporation, C=US',
    timeStamperThumbprint: 'B'.repeat(40),
  };
  const fileAuthority = (candidate, {
    productVersion = '',
    originalFilename = path.basename(candidate),
    companyName = '',
    signature = unsignedSignature,
    runtimeVersion: recordedRuntimeVersion,
  } = {}) => ({
    executablePath: candidate,
    sha256: sha256File(candidate),
    byteCount: fs.statSync(candidate).size,
    fileVersion: productVersion,
    productVersion,
    originalFilename,
    companyName,
    signature,
    ...(recordedRuntimeVersion ? { runtimeVersion: recordedRuntimeVersion } : {}),
  });
  const tauriDriverAuthority = {
    ...fileAuthority(tauriDriver),
    installReceipt: {
      path: tauriInstallReceiptPath,
      sha256: sha256File(tauriInstallReceiptPath),
      packageId: tauriPackageId,
      versionRequirement: `=${PINNED_TAURI_DRIVER_VERSION}`,
      bins: ['tauri-driver.exe'],
      target: 'x86_64-pc-windows-msvc',
      rustcSha256: sha256Bytes(Buffer.from('rustc fixture authority', 'utf8')),
    },
  };
  const nativeDriverAuthority = fileAuthority(nativeDriver, {
    productVersion: runtimeVersion,
    companyName: 'Microsoft Corporation',
    signature: microsoftSignature,
  });
  const webViewRuntimeAuthority = fileAuthority(webViewRuntime, {
    productVersion: runtimeVersion,
    companyName: 'Microsoft Corporation',
    signature: microsoftSignature,
    runtimeVersion,
  });
  const runnerAuthority = fileAuthority(runnerPath);
  const desktopAuthority = fileAuthority(desktopExecutable);
  const targetAuthority = fileAuthority(targetExecutable);
  const liveProcessAuthority = {
    runner: {
      processId: runnerProcessId,
      parentProcessId: 50_999,
      ...runnerAuthority,
    },
    tauriDriver: {
      processId: driverProcessId,
      parentProcessId: runnerProcessId,
      ...tauriDriverAuthority,
    },
    nativeDriver: {
      processId: nativeDriverProcessId,
      parentProcessId: driverProcessId,
      ...nativeDriverAuthority,
    },
    desktop: {
      processId: desktopProcessId,
      parentProcessId: nativeDriverProcessId,
      ...desktopAuthority,
      buildCommit: sourceHeadCommit,
    },
    target: {
      processId: targetProcessId,
      parentProcessId: runnerProcessId,
      ...targetAuthority,
      buildCommit: sourceHeadCommit,
    },
  };
  const result = {
    schemaVersion: 1,
    artifactKind: 'overlay-click-through-emitter-result',
    collectorId: OVERLAY_CLICK_THROUGH_COLLECTOR_ID,
    collectorVersion: OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION,
    scenarioId: OVERLAY_CLICK_THROUGH_SCENARIO_ID,
    invocationId,
    status: 'completed',
    error: null,
    startedAt,
    completedAt: nextTime(),
    sourceHeadCommit,
    sourceProvenance: provenance,
    testOnly: false,
    runnerProcessId,
    driverProcessId,
    nativeDriverProcessId,
    desktopProcessId,
    targetProcessId,
    sessionId: transcript.sessionId,
    scriptTimeoutMs: transcript.scriptTimeoutMs,
    driverEndpoint: transcript.driverEndpoint,
    desktopExecutable,
    desktopExecutableSha256: sha256File(desktopExecutable),
    targetExecutable,
    targetExecutableSha256: sha256File(targetExecutable),
    runner: { path: runnerPath, sha256: sha256File(runnerPath) },
    validator: { path: validatorPath, sha256: sha256File(validatorPath) },
    processAuthorityHelper: {
      path: processAuthorityHelper,
      sha256: sha256File(processAuthorityHelper),
    },
    tooling: {
      supplyChain: {
        tauriDriverCrate: 'tauri-driver',
        tauriDriverVersion: PINNED_TAURI_DRIVER_VERSION,
        cargoLocked: true,
        cargoForcedInstall: true,
        nativeDriverSource:
          `https://msedgedriver.microsoft.com/${runtimeVersion}/edgedriver_win64.zip`,
      },
      tauriDriver: tauriDriverAuthority,
      nativeDriver: nativeDriverAuthority,
      webViewRuntime: webViewRuntimeAuthority,
    },
    processAuthority: {
      capturedBeforeOsAuthority: liveProcessAuthority,
      capturedAfterOsAuthority: liveProcessAuthority,
    },
    timeline: runnerTimeline,
    artifacts: OVERLAY_CLICK_THROUGH_ARTIFACTS
      .filter(({ path: relativePath }) => relativePath !== 'emitter-result.json')
      .map(({ role, path: relativePath }) => ({
        role,
        path: relativePath,
        ...fileReceipt(path.join(rawDirectory, relativePath)),
      })),
  };
  writeJson(path.join(rawDirectory, 'emitter-result.json'), result);
  return { result, probe: { ...rawProbe, operatorObservation }, transcript, ready, click };
}
