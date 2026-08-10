import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { ensureDir, readJson, writeJson } from '../lib/testing-common.mjs';
import {
  OVERLAY_CLICK_THROUGH_ARTIFACTS,
  OVERLAY_CLICK_THROUGH_COLLECTOR_ID,
  OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION,
  OVERLAY_CLICK_THROUGH_RUNNER,
  OVERLAY_CLICK_THROUGH_SCENARIO_ID,
  OVERLAY_CLICK_THROUGH_VALIDATOR,
  OVERLAY_CLICK_TARGET_COLLECTOR_ID,
  OVERLAY_CLICK_TARGET_COLLECTOR_VERSION,
  OVERLAY_OS_TIMELINE,
  OVERLAY_RUNNER_TIMELINE,
  PINNED_TAURI_DRIVER_VERSION,
  fileReceipt,
  sha256File,
  validateOverlayClickThroughEvidence,
} from './overlay-click-through-release-evidence.mjs';
import {
  buildOverlayClickThroughReleasePlan,
  createOverlayClickThroughTestOnlySeam,
  parseOverlayClickThroughReleaseArgs,
  pinnedTauriDriverInstallCommand,
  runOverlayClickThroughReleaseEvidence,
} from './run-overlay-click-through-release-evidence.mjs';
import {
  materializeOverlayClickThroughRawFixture,
} from './overlay-click-through-release-evidence-test-helpers.mjs';

const TEST_HEAD = 'a'.repeat(40);
const TEST_INVOCATION = 'df3e2979-94c8-4a13-9fc3-f4862cfed7a1';
const TEST_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: TEST_HEAD,
  worktreeClean: true,
  dirtyEntryCount: 0,
});

const temporaryRoot = (name) => fs.mkdtempSync(
  path.join(os.tmpdir(), `omni-overlay-release-${name}-`),
);

const sha256Bytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const typeBytes = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
};

const writePng = (candidate, width = 400, height = 200) => {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
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
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(candidate, png);
  return png;
};

const touch = (candidate, content) => {
  ensureDir(path.dirname(candidate));
  fs.writeFileSync(candidate, content);
};

const prepareWorkspace = (name) => {
  const workspaceRoot = temporaryRoot(name);
  const desktopExecutable = path.join(workspaceRoot, 'target', 'release', 'omni-desktop-shell.exe');
  const targetExecutable = path.join(workspaceRoot, 'target', 'release', 'omni-overlay-click-target.exe');
  const tauriDriver = path.join(workspaceRoot, 'tools', 'tauri-driver.exe');
  const nativeDriver = path.join(workspaceRoot, 'tools', 'msedgedriver.exe');
  const runner = path.join(workspaceRoot, ...OVERLAY_CLICK_THROUGH_RUNNER.split('/'));
  const validator = path.join(workspaceRoot, ...OVERLAY_CLICK_THROUGH_VALIDATOR.split('/'));
  const processAuthorityHelper = path.join(
    workspaceRoot,
    'scripts',
    'testing',
    'windows-overlay-process-authority.ps1',
  );
  for (const [candidate, content] of [
    [desktopExecutable, 'release desktop'],
    [targetExecutable, 'overlay target'],
    [tauriDriver, 'tauri driver'],
    [nativeDriver, 'native driver'],
    [runner, 'production runner'],
    [validator, 'production validator'],
    [processAuthorityHelper, 'process authority helper'],
  ]) touch(candidate, content);
  return {
    workspaceRoot,
    desktopExecutable,
    targetExecutable,
    tauriDriver,
    nativeDriver,
  };
};

const buildPlan = (workspace, suffix = 'fixture') => buildOverlayClickThroughReleasePlan({
  workspaceRoot: workspace.workspaceRoot,
  outputRoot: 'artifacts/testing/overlay-output',
  operator: 'Release Operator',
  operatorNotes: 'Observed the target receive the click while the overlay stayed passive.',
  testOnlySeam: createOverlayClickThroughTestOnlySeam({
    tauriDriverPath: workspace.tauriDriver,
    nativeDriverPath: workspace.nativeDriver,
  }),
  provenance: TEST_PROVENANCE,
  now: new Date('2026-08-10T10:00:00.000Z'),
  invocationId: TEST_INVOCATION,
  suffix,
});

const increasingClock = (start = Date.parse('2026-08-10T10:00:00.000Z')) => {
  let current = start;
  return () => {
    current += 100;
    return new Date(current);
  };
};

const buildAuthorityAdapters = (plan) => {
  const now = increasingClock();
  const targetPid = 84_104;
  const driverPid = 84_102;
  const nativeDriverPid = 84_105;
  const desktopPid = 84_103;
  const targetHwnd = 220_001;
  const mainHwnd = 110_001;
  const overlayHwnd = 110_002;
  const targetBounds = { left: 240, top: 220, width: 760, height: 420 };
  const targetClientBounds = { left: 248, top: 250, width: 744, height: 382 };
  const overlayBounds = { left: 420, top: 330, width: 400, height: 200 };
  const clickPoint = { x: 553, y: 430 };
  let ready;
  let requestCount = 0;
  const terminated = [];
  return {
    identities: {
      targetPid,
      driverPid,
      nativeDriverPid,
      desktopPid,
      targetHwnd,
      mainHwnd,
      overlayHwnd,
    },
    terminated,
    adapters: {
      now,
      currentProvenance: () => TEST_PROVENANCE,
      listRunning: () => [],
      portInUse: async () => false,
      launchTarget: () => ({ pid: targetPid, exitCode: null }),
      waitForTargetReady: async () => {
        ready = {
          schemaVersion: 1,
          artifactKind: 'overlay-click-target-ready',
          collectorId: OVERLAY_CLICK_TARGET_COLLECTOR_ID,
          collectorVersion: OVERLAY_CLICK_TARGET_COLLECTOR_VERSION,
          invocationId: TEST_INVOCATION,
           sourceHeadCommit: TEST_HEAD,
          buildCommit: TEST_HEAD,
          capturedAt: now().toISOString(),
          processId: targetPid,
          hwnd: targetHwnd,
          windowTitle: 'Omni Overlay Click Target df3e2979',
          windowBounds: targetBounds,
          executablePath: plan.targetExecutable,
          executableSha256: plan.targetExecutableSha256,
        };
        writeJson(path.join(plan.runDirectory, 'target-ready.json'), ready);
        return ready;
      },
      launchDriver: () => ({ pid: driverPid, exitCode: null }),
      waitForDriver: async () => {},
      inspectFile: (_plan, candidate) => {
        for (const authority of [
          plan.tooling.tauriDriver,
          plan.tooling.nativeDriver,
          plan.tooling.webViewRuntime,
        ]) {
          if (path.resolve(authority.executablePath) === path.resolve(candidate)) return authority;
        }
        throw new Error(`unexpected file authority request: ${candidate}`);
      },
      inspectProcess: (_plan, processId) => {
        const fileSnapshot = (authority, parentProcessId) => ({
          processId,
          parentProcessId,
          executablePath: authority.executablePath,
          sha256: authority.sha256,
          byteCount: authority.byteCount,
          fileVersion: authority.fileVersion,
          productVersion: authority.productVersion,
          originalFilename: authority.originalFilename,
          companyName: authority.companyName,
          signature: authority.signature,
        });
        if (processId === process.pid) {
          return {
            processId,
            parentProcessId: 1,
            executablePath: process.execPath,
            sha256: sha256File(process.execPath),
            byteCount: fs.statSync(process.execPath).size,
            fileVersion: '',
            productVersion: '',
            originalFilename: path.basename(process.execPath),
            companyName: '',
            signature: { status: 'NotSigned' },
          };
        }
        if (processId === driverPid) {
          return fileSnapshot(plan.tooling.tauriDriver, process.pid);
        }
        if (processId === targetPid) {
          return {
            processId,
            parentProcessId: process.pid,
            executablePath: plan.targetExecutable,
            sha256: plan.targetExecutableSha256,
            byteCount: fs.statSync(plan.targetExecutable).size,
            fileVersion: '',
            productVersion: '',
            originalFilename: path.basename(plan.targetExecutable),
            companyName: '',
            signature: { status: 'NotSigned' },
          };
        }
        throw new Error(`unexpected process authority request: ${processId}`);
      },
      inspectDescendants: () => [
        {
          processId: nativeDriverPid,
          parentProcessId: driverPid,
          ...plan.tooling.nativeDriver,
        },
        {
          processId: desktopPid,
          parentProcessId: nativeDriverPid,
          executablePath: plan.desktopExecutable,
          sha256: plan.desktopExecutableSha256,
          byteCount: fs.statSync(plan.desktopExecutable).size,
          fileVersion: '',
          productVersion: '',
          originalFilename: path.basename(plan.desktopExecutable),
          companyName: '',
          signature: { status: 'NotSigned' },
        },
      ],
      request: async (request) => {
        requestCount += 1;
        if (request.method === 'DELETE') return { value: null };
        if (request.url.endsWith('/session')) {
          return { value: { sessionId: 'real-session-fixture' } };
        }
        if (request.url.endsWith('/timeouts')) return { value: null };
        const script = String(request.body?.script ?? '');
        if (script.includes('diagnostics_v2')) {
          return { value: { ok: true, value: { overlaySelfCheck: 'shown' } } };
        }
        if (!script.includes('collect_overlay_click_through_release_evidence')) {
          throw new Error(`unexpected WebDriver request ${requestCount}`);
        }
        const clickReceivedAt = now().toISOString();
        const click = {
          schemaVersion: 1,
          artifactKind: 'overlay-click-target-receipt',
          collectorId: OVERLAY_CLICK_TARGET_COLLECTOR_ID,
          collectorVersion: OVERLAY_CLICK_TARGET_COLLECTOR_VERSION,
          invocationId: TEST_INVOCATION,
           sourceHeadCommit: TEST_HEAD,
          buildCommit: TEST_HEAD,
          receivedAt: clickReceivedAt,
          processId: targetPid,
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
        writeJson(path.join(plan.runDirectory, 'target-click.json'), click);
        const png = writePng(path.join(plan.runDirectory, 'overlay-click-through.png'));
        const eventDetails = [
          { invocationId: TEST_INVOCATION },
          { processId: targetPid, hwnd: targetHwnd },
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
          { sha256: sha256Bytes(png), width: 400, height: 200 },
        ];
        const eventTimeline = OVERLAY_OS_TIMELINE.map((event, index) => ({
          event,
          sequence: index + 1,
          observedAt: now().toISOString(),
          detail: eventDetails[index],
        }));
        const rawProbe = {
          schemaVersion: 1,
          artifactKind: 'overlay-os-click-through-probe',
          collectorId: OVERLAY_CLICK_THROUGH_COLLECTOR_ID,
          collectorVersion: OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION,
          productionMode: true,
          passed: true,
          capturedAt: now().toISOString(),
          invocationId: TEST_INVOCATION,
          sourceHeadCommit: TEST_HEAD,
          desktopBuildCommit: TEST_HEAD,
          desktopProcessId: desktopPid,
          desktopExecutable: plan.desktopExecutable,
          desktopExecutableSha256: plan.desktopExecutableSha256,
          mainHwnd,
          mainBounds: { left: 100, top: 100, width: 900, height: 700 },
          overlayHwnd,
          overlayBounds,
          overlayLocked: true,
          overlayVisible: true,
          targetProcessId: targetPid,
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
          screenshotSha256: sha256Bytes(png),
          screenshotByteCount: png.length,
          screenshotWidth: overlayBounds.width,
          screenshotHeight: overlayBounds.height,
          eventTimeline,
        };
        return { value: { ok: true, value: rawProbe } };
      },
      terminate: (child) => {
        if (child?.pid) terminated.push(child.pid);
      },
    },
  };
};

const collectValidFixture = async (name = 'valid') => {
  const workspace = prepareWorkspace(name);
  const plan = buildPlan(workspace, name);
  const authority = buildAuthorityAdapters(plan);
  const result = await runOverlayClickThroughReleaseEvidence({
    plan,
    adapters: authority.adapters,
    collectEvidence: async () => ({
      packageDirectory: path.join(workspace.workspaceRoot, 'collector-package'),
      manifestPath: path.join(workspace.workspaceRoot, 'collector-package', 'collector-manifest.json'),
    }),
  });
  return { workspace, plan, authority, result };
};

const validate = (fixture) => validateOverlayClickThroughEvidence(fixture.plan.runDirectory, {
  workspaceRoot: fixture.workspace.workspaceRoot,
  currentProvenance: TEST_PROVENANCE,
  now: Date.parse('2026-08-10T10:10:00.000Z'),
  allowTestOnly: true,
});

const productionFixture = (name) => {
  const workspaceRoot = temporaryRoot(`production-${name}`);
  const rawDirectory = path.join(workspaceRoot, 'artifacts', 'testing', 'overlay-raw');
  materializeOverlayClickThroughRawFixture({
    rawDirectory,
    workspaceRoot,
    provenance: TEST_PROVENANCE,
    now: new Date('2026-08-10T10:10:00.000Z'),
  });
  const validateProduction = () => validateOverlayClickThroughEvidence(rawDirectory, {
    workspaceRoot,
    currentProvenance: TEST_PROVENANCE,
    now: Date.parse('2026-08-10T10:10:00.000Z'),
  });
  assert.deepEqual(validateProduction().issues, []);
  return {
    workspaceRoot,
    rawDirectory,
    resultPath: path.join(rawDirectory, 'emitter-result.json'),
    validateProduction,
  };
};

test('production CLI rejects caller-authored source, dry-run, skip, and simulated inputs', () => {
  for (const argv of [
    ['--source', 'forged'],
    ['--dry-run'],
    ['--skip'],
    ['--simulated'],
    ['--workspace-root', 'forged'],
    ['--desktop-executable', 'forged.exe'],
    ['--tauri-driver-path', 'C:\\forged\\tauri-driver.exe'],
    ['--native-driver-path', 'C:\\forged\\msedgedriver.exe'],
  ]) assert.throws(() => parseOverlayClickThroughReleaseArgs(argv), /Unknown flag/);
  const workspace = prepareWorkspace('forbidden-plan');
  assert.throws(() => buildOverlayClickThroughReleasePlan({
    workspaceRoot: workspace.workspaceRoot,
    provenance: TEST_PROVENANCE,
    operator: 'QA',
    operatorNotes: 'Observed click-through.',
    testOnlySeam: createOverlayClickThroughTestOnlySeam({
      tauriDriverPath: workspace.tauriDriver,
      nativeDriverPath: workspace.nativeDriver,
    }),
    source: 'forged',
  }), /does not accept source/);
});

test('real runner seam invokes show then OS authority and emits the exact fixed payload', async () => {
  const fixture = await collectValidFixture('runner');
  assert.equal(fixture.result.scenarioId, OVERLAY_CLICK_THROUGH_SCENARIO_ID);
  assert.equal(fixture.result.targetProcessId, fixture.authority.identities.targetPid);
  assert.deepEqual(
    fs.readdirSync(fixture.plan.runDirectory).sort(),
    OVERLAY_CLICK_THROUGH_ARTIFACTS.map(({ path: relativePath }) => relativePath).sort(),
  );
  assert.deepEqual(
    fixture.authority.terminated.sort((left, right) => left - right),
    [fixture.authority.identities.driverPid, fixture.authority.identities.targetPid],
  );
  assert.deepEqual(validate(fixture).issues, []);
  const transcript = readJson(path.join(fixture.plan.runDirectory, 'webdriver-transcript.json'));
  assert.deepEqual(
    transcript.calls.map(({ command }) => command),
    ['diagnostics_v2', 'collect_overlay_click_through_release_evidence'],
  );
  assert.deepEqual(
    readJson(path.join(fixture.plan.runDirectory, 'emitter-result.json')).timeline
      .map(({ event }) => event),
    OVERLAY_RUNNER_TIMELINE,
  );
});

test('same PID or HWND, out-of-bounds click, and wrong foreground fail closed', async () => {
  for (const [name, mutate, expected] of [
    ['same-pid', (probe) => { probe.targetProcessId = probe.desktopProcessId; }, /PID and HWND|process IDs/],
    ['same-hwnd', (probe) => { probe.targetHwnd = probe.overlayHwnd; }, /HWNDs must be distinct|PID and HWND/],
    ['outside', (probe) => { probe.clickPoint.x = probe.overlayBounds.left - 1; }, /click point/],
    ['foreground', (probe) => { probe.foregroundAfterHwnd = probe.overlayHwnd; }, /foreground must be the target/],
  ]) {
    const fixture = await collectValidFixture(name);
    const probePath = path.join(fixture.plan.runDirectory, 'overlay-click-through-probe.json');
    const probe = readJson(probePath);
    mutate(probe);
    writeJson(probePath, probe);
    assert.match(validate(fixture).issues.join('\n'), expected);
  }
});

test('tampered screenshot and an updated self-reported screenshot hash are rejected', async () => {
  const fixture = await collectValidFixture('screenshot');
  const screenshotPath = path.join(fixture.plan.runDirectory, 'overlay-click-through.png');
  const probePath = path.join(fixture.plan.runDirectory, 'overlay-click-through-probe.json');
  const probe = readJson(probePath);
  const replacement = writePng(screenshotPath, 400, 200);
  replacement[replacement.length - 1] ^= 0xff;
  fs.writeFileSync(screenshotPath, replacement);
  probe.screenshotSha256 = sha256Bytes(replacement);
  probe.operatorObservation.screenshotSha256 = probe.screenshotSha256;
  writeJson(probePath, probe);
  assert.match(
    validate(fixture).issues.join('\n'),
    /PNG IEND CRC is invalid|artifact roles\/hashes|WebDriver command result/,
  );
});

test('OS and runner timeline reordering cannot be normalized into a PASS', async () => {
  for (const [name, file, field] of [
    ['os-timeline', 'overlay-click-through-probe.json', 'eventTimeline'],
    ['runner-timeline', 'emitter-result.json', 'timeline'],
  ]) {
    const fixture = await collectValidFixture(name);
    const candidate = path.join(fixture.plan.runDirectory, file);
    const value = readJson(candidate);
    [value[field][2], value[field][3]] = [value[field][3], value[field][2]];
    writeJson(candidate, value);
    assert.match(validate(fixture).issues.join('\n'), /event 3 must be|event 4 must be/);
  }
});

test('fake target receipt, missing operator, and stale/dirty provenance are rejected', async () => {
  const fixture = await collectValidFixture('identity');
  const clickPath = path.join(fixture.plan.runDirectory, 'target-click.json');
  const click = readJson(clickPath);
  click.processId = 4242;
  writeJson(clickPath, click);
  let issues = validate(fixture).issues.join('\n');
  assert.match(issues, /PID and HWND authority|exact raw target ready\/click/);

  const probePath = path.join(fixture.plan.runDirectory, 'overlay-click-through-probe.json');
  const probe = readJson(probePath);
  delete probe.operatorObservation;
  writeJson(probePath, probe);
  issues = validate(fixture).issues.join('\n');
  assert.match(issues, /named operator/);

  const dirty = { ...TEST_PROVENANCE, worktreeClean: false, dirtyEntryCount: 1 };
  issues = validateOverlayClickThroughEvidence(fixture.plan.runDirectory, {
    workspaceRoot: fixture.workspace.workspaceRoot,
    currentProvenance: dirty,
    now: Date.parse('2026-08-10T10:10:00.000Z'),
  }).issues.join('\n');
  assert.match(issues, /dirty worktree/);
});

test('emitter hashes bind runner, binaries, WebDriver tools, and every payload role', async () => {
  const fixture = await collectValidFixture('hash-binding');
  const resultPath = path.join(fixture.plan.runDirectory, 'emitter-result.json');
  const result = readJson(resultPath);
  assert.equal(result.runner.sha256, sha256File(result.runner.path));
  assert.equal(result.desktopExecutableSha256, sha256File(result.desktopExecutable));
  assert.deepEqual(
    result.artifacts,
    OVERLAY_CLICK_THROUGH_ARTIFACTS
      .filter(({ path: relativePath }) => relativePath !== 'emitter-result.json')
      .map(({ role, path: relativePath }) => ({
        role,
        path: relativePath,
        ...fileReceipt(path.join(fixture.plan.runDirectory, relativePath)),
      })),
  );
  fs.appendFileSync(result.runner.path, '\ntampered');
  assert.match(validate(fixture).issues.join('\n'), /production runner SHA-256/);
});

test('production plan rejects arbitrary executable overrides and unprepared tooling', () => {
  const workspace = prepareWorkspace('production-tool-rejection');
  const install = pinnedTauriDriverInstallCommand(workspace.workspaceRoot);
  assert.deepEqual(install.args.slice(0, 7), [
    'install',
    'tauri-driver',
    '--version',
    `=${PINNED_TAURI_DRIVER_VERSION}`,
    '--locked',
    '--force',
    '--root',
  ]);
  assert.match(install.installRoot.replaceAll('\\', '/'), /artifacts\/tooling\/overlay-click-through/);
  for (const override of [
    { tauriDriverPath: workspace.tauriDriver },
    { nativeDriverPath: workspace.nativeDriver },
  ]) {
    assert.throws(() => buildOverlayClickThroughReleasePlan({
      workspaceRoot: workspace.workspaceRoot,
      operator: 'Release Operator',
      operatorNotes: 'Observed a real click-through run.',
      provenance: TEST_PROVENANCE,
      ...override,
    }), /does not accept .*executable overrides/);
  }
  assert.throws(() => buildOverlayClickThroughReleasePlan({
    workspaceRoot: workspace.workspaceRoot,
    operator: 'Release Operator',
    operatorNotes: 'Observed a real click-through run.',
    provenance: TEST_PROVENANCE,
    preparedTooling: {
      tauriDriver: { executablePath: workspace.tauriDriver },
      nativeDriver: { executablePath: workspace.nativeDriver },
    },
  }), /pinned locked-source authority/);
});

test('production runner and validator reject the explicit fake-adapter seam', async () => {
  const workspace = prepareWorkspace('fake-adapter-rejection');
  const plan = buildPlan(workspace, 'fake-adapter-rejection');
  plan.testOnly = false;
  await assert.rejects(
    runOverlayClickThroughReleaseEvidence({
      plan,
      adapters: { listRunning: () => [] },
      collectEvidence: async () => ({}),
    }),
    /rejects adapter and collector overrides/,
  );
  const fixture = await collectValidFixture('test-only-validator-rejection');
  const issues = validateOverlayClickThroughEvidence(fixture.plan.runDirectory, {
    workspaceRoot: fixture.workspace.workspaceRoot,
    currentProvenance: TEST_PROVENANCE,
    now: Date.parse('2026-08-10T10:10:00.000Z'),
  }).issues.join('\n');
  assert.match(issues, /rejects test-only/);
});

test('production validator rejects plaintext tooling and unsigned Microsoft Edge WebDriver', () => {
  for (const [name, mutate, expected] of [
    ['plaintext', (result) => {
      const candidate = result.tooling.tauriDriver.executablePath;
      fs.writeFileSync(candidate, 'fake tauri-driver');
      const hash = sha256File(candidate);
      const bytes = fs.statSync(candidate).size;
      result.tooling.tauriDriver.sha256 = hash;
      result.tooling.tauriDriver.byteCount = bytes;
      for (const capture of Object.values(result.processAuthority)) {
        capture.tauriDriver.sha256 = hash;
        capture.tauriDriver.byteCount = bytes;
      }
    }, /not a Windows PE executable/],
    ['unsigned', (result) => {
      const signature = {
        ...result.tooling.nativeDriver.signature,
        status: 'NotSigned',
        signerSubject: null,
      };
      result.tooling.nativeDriver.signature = signature;
      for (const capture of Object.values(result.processAuthority)) {
        capture.nativeDriver.signature = signature;
      }
    }, /valid Microsoft Corporation Authenticode signature/],
  ]) {
    const fixture = productionFixture(name);
    const result = readJson(fixture.resultPath);
    mutate(result);
    writeJson(fixture.resultPath, result);
    assert.match(fixture.validateProduction().issues.join('\n'), expected);
  }
});

test('production validator rejects mismatched browser version and noncanonical driver path', () => {
  for (const [name, mutate, expected] of [
    ['version', (result) => {
      result.tooling.nativeDriver.productVersion = '150.0.0.1';
      for (const capture of Object.values(result.processAuthority)) {
        capture.nativeDriver.productVersion = '150.0.0.1';
      }
    }, /exactly match the installed WebView2 runtime version/],
    ['path', (result) => {
      const forged = result.targetExecutable;
      const hash = result.targetExecutableSha256;
      const bytes = fs.statSync(forged).size;
      result.tooling.tauriDriver.executablePath = forged;
      result.tooling.tauriDriver.sha256 = hash;
      result.tooling.tauriDriver.byteCount = bytes;
      for (const capture of Object.values(result.processAuthority)) {
        capture.tauriDriver.executablePath = forged;
        capture.tauriDriver.sha256 = hash;
        capture.tauriDriver.byteCount = bytes;
      }
    }, /canonical tooling paths/],
    ['tauri-receipt', (result) => {
      result.tooling.tauriDriver.installReceipt.versionRequirement = '^2';
    }, /cargo receipt must bind the exact pinned registry package/],
  ]) {
    const fixture = productionFixture(name);
    const result = readJson(fixture.resultPath);
    mutate(result);
    writeJson(fixture.resultPath, result);
    assert.match(fixture.validateProduction().issues.join('\n'), expected);
  }
});

test('production validator rejects forged PID, image path, hash, and pre/post process drift', () => {
  for (const [name, mutate, expected] of [
    ['pid', (result) => {
      for (const capture of Object.values(result.processAuthority)) {
        capture.desktop.processId += 100;
      }
    }, /Desktop process PID\/image path\/SHA authority/],
    ['driver-pid', (result) => {
      result.nativeDriverProcessId += 100;
    }, /native WebDriver process PID\/image path\/SHA authority/],
    ['image', (result) => {
      for (const capture of Object.values(result.processAuthority)) {
        capture.desktop.executablePath = result.targetExecutable;
      }
    }, /Desktop process PID\/image path\/SHA authority/],
    ['hash', (result) => {
      for (const capture of Object.values(result.processAuthority)) {
        capture.nativeDriver.sha256 = 'f'.repeat(64);
      }
    }, /native WebDriver process PID\/image path\/SHA authority/],
    ['drift', (result) => {
      result.processAuthority.capturedAfterOsAuthority.tauriDriver.sha256 = 'e'.repeat(64);
    }, /captured unchanged before and after/],
  ]) {
    const fixture = productionFixture(name);
    const result = readJson(fixture.resultPath);
    mutate(result);
    writeJson(fixture.resultPath, result);
    assert.match(fixture.validateProduction().issues.join('\n'), expected);
  }
});
