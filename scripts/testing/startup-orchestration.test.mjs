import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DRIVER_PORT,
  DEFAULT_NATIVE_DRIVER_PORT,
  IPC_NEVER_CONNECTED_MARKER,
  OVERLAY_WINDOW_LABEL,
  REQUIRED_DRIVER_TOOLS,
  buildExecuteAsyncRequest,
  buildInvokeScript,
  buildOverlayDriverSmokePlan,
  buildOverlayDriverSmokeReport,
  buildOverlayStepPlan,
  buildSessionTeardownRequest,
  buildTauriDriverArgs,
  buildWebDriverSessionRequest,
  describeMissingTools,
  evaluateOverlayDriverSmoke,
  formatOverlayDriverSmokePlanText,
  formatSkipBanner,
  overlayDriverSmokeExitCode,
  overlayWindowStateFromSnapshot,
  releaseExecutableCandidates,
  resolveReleaseExecutable,
} from './overlay-driver-smoke.mjs';

import {
  DEFAULT_PING_TIMEOUT_MS,
  IPC_BRIDGE_READY_MARKER,
  IPC_PING_LOG_MARKER,
  IPC_WATCHDOG_GRACE_MS,
  buildStartupIpcStressPlan,
  buildStartupIpcStressReport,
  buildStressRunRecord,
  detectNeverConnected,
  findIpcPingEvidence,
  formatStartupIpcStressPlanText,
  parseIpcPingLogLine,
  startupIpcStressExitCode,
  summarizeStartupIpcStressRuns,
} from './startup-ipc-stress.mjs';

// ---------------------------------------------------------------------------
// overlay driver smoke — argument building

test('tauri-driver arguments carry both ports and the native driver path', () => {
  const driver = buildTauriDriverArgs({ nativeDriverPath: 'C:/tools/msedgedriver.exe' });

  assert.equal(driver.command, 'tauri-driver');
  assert.deepEqual(driver.args, [
    '--port',
    String(DEFAULT_DRIVER_PORT),
    '--native-port',
    String(DEFAULT_NATIVE_DRIVER_PORT),
    '--native-driver',
    'C:/tools/msedgedriver.exe',
  ]);
  assert.equal(driver.endpoint, `http://127.0.0.1:${DEFAULT_DRIVER_PORT}`);
});

test('tauri-driver arguments reject a port collision and non-numeric ports', () => {
  assert.throws(
    () => buildTauriDriverArgs({ port: 4444, nativePort: 4444, nativeDriverPath: 'msedgedriver.exe' }),
    /port and native port must differ/,
  );
  assert.throws(
    () => buildTauriDriverArgs({ port: 'not-a-port', nativeDriverPath: 'msedgedriver.exe' }),
    /port must be a positive integer/,
  );
  assert.throws(() => buildTauriDriverArgs({ nativeDriverPath: '' }), /native driver path/);
});

test('the new-session request targets the release build with the wry capability', () => {
  const request = buildWebDriverSessionRequest({
    endpoint: 'http://127.0.0.1:4444',
    applicationPath: 'target/release/omni-desktop-shell.exe',
  });

  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'http://127.0.0.1:4444/session');
  const alwaysMatch = request.body.capabilities.alwaysMatch;
  assert.equal(alwaysMatch.browserName, 'wry');
  assert.equal(alwaysMatch['tauri:options'].application, 'target/release/omni-desktop-shell.exe');
  assert.deepEqual(alwaysMatch['tauri:options'].args, []);
});

test('session and window-handle requests refuse to build without a session id', () => {
  assert.throws(() => buildSessionTeardownRequest({ endpoint: 'http://x' }), /sessionId/);
  assert.equal(
    buildSessionTeardownRequest({ endpoint: 'http://127.0.0.1:4444', sessionId: 'abc' }).url,
    'http://127.0.0.1:4444/session/abc',
  );
});

test('the invoke script sends the command over the real Tauri IPC internals', () => {
  const script = buildInvokeScript('diagnostics_v2', { command: { action: 'overlaySelfCheck' } });

  assert.match(script, /window\.__TAURI_INTERNALS__/);
  assert.match(script, /internals\.invoke\("diagnostics_v2", \{"command":\{"action":"overlaySelfCheck"\}\}\)/);
  // The WebDriver callback must always be resolved, including on rejection,
  // otherwise a failed invoke degrades into an opaque script timeout.
  assert.match(script, /\.catch\(function \(error\) \{ done\(\{ ok: false, error: String\(error\) \}\); \}\)/);
  assert.throws(() => buildInvokeScript(''), /command name is required/);
});

test('a payload-free command emits an undefined payload rather than null', () => {
  const script = buildInvokeScript('toggle_subtitle_overlay');
  assert.match(script, /internals\.invoke\("toggle_subtitle_overlay", undefined\)/);
});

test('execute-async requests are addressed to the session and carry the script', () => {
  const request = buildExecuteAsyncRequest({
    endpoint: 'http://127.0.0.1:4444',
    sessionId: 'session-1',
    command: 'toggle_subtitle_overlay',
  });

  assert.equal(request.url, 'http://127.0.0.1:4444/session/session-1/execute/async');
  assert.deepEqual(request.body.args, []);
  assert.match(request.body.script, /toggle_subtitle_overlay/);
});

test('the overlay step plan proves hidden -> visible -> hidden, not just visible', () => {
  const steps = buildOverlayStepPlan({ showMode: 'self-check' });

  assert.deepEqual(steps.map((step) => step.name), ['before', 'show', 'hide']);
  assert.deepEqual(steps[0].payload, { command: { action: 'selfCheck' } });
  assert.equal(steps[1].command, 'diagnostics_v2');
  assert.deepEqual(steps[1].payload, { command: { action: 'overlaySelfCheck' } });
  assert.equal(steps[2].command, 'toggle_subtitle_overlay');
  for (const step of steps) {
    assert.match(step.script, /__TAURI_INTERNALS__/);
  }
});

test('the toggle show mode uses the toggle command instead of the diagnostics self check', () => {
  const steps = buildOverlayStepPlan({ showMode: 'toggle' });

  assert.equal(steps[1].command, 'toggle_subtitle_overlay');
  assert.equal(steps[1].payload, undefined);
  assert.throws(() => buildOverlayStepPlan({ showMode: 'nope' }), /self-check\/toggle/);
});

// ---------------------------------------------------------------------------
// overlay driver smoke — release executable resolution

test('release executable candidates prefer the workspace target directory', () => {
  const candidates = releaseExecutableCandidates('root', { version: '0.1.0' }).map((item) =>
    item.replace(/\\/g, '/'),
  );

  assert.deepEqual(candidates, [
    'root/target/release/omni-desktop-shell.exe',
    'root/apps/desktop/src-tauri/target/release/omni-desktop-shell.exe',
    'root/artifacts/installer/0.1.0/desktop/omni-desktop-shell.exe',
  ]);
});

test('release executable resolution falls back to the legacy crate target directory', () => {
  const legacy = releaseExecutableCandidates('root')[1];
  const resolved = resolveReleaseExecutable({
    workspaceRoot: 'root',
    exists: (candidate) => candidate === legacy,
  });

  assert.equal(resolved.found, true);
  assert.equal(resolved.path, legacy);
});

test('an unbuilt release shell reports the canonical path plus the build command', () => {
  const resolved = resolveReleaseExecutable({ workspaceRoot: 'root', exists: () => false });

  assert.equal(resolved.found, false);
  assert.equal(resolved.path.replace(/\\/g, '/'), 'root/target/release/omni-desktop-shell.exe');
  assert.equal(resolved.buildHint, 'npm run build:desktop-shell');
});

test('an explicit executable path is honoured and still existence-checked', () => {
  const resolved = resolveReleaseExecutable({ explicitPath: 'D:/build/shell.exe', exists: () => false });

  assert.equal(resolved.explicit, true);
  assert.equal(resolved.path, 'D:/build/shell.exe');
  assert.equal(resolved.found, false);
});

test('missing tools are described with their exact install command', () => {
  const described = describeMissingTools([{ name: 'tauri-driver' }, REQUIRED_DRIVER_TOOLS[1]]);

  assert.match(described, /tauri-driver: cargo install tauri-driver --locked/);
  assert.match(described, /msedgedriver: download the Microsoft Edge WebDriver/);
});

// ---------------------------------------------------------------------------
// overlay driver smoke — plan shaping

test('the smoke plan wires the driver endpoint into the session request', () => {
  const plan = buildOverlayDriverSmokePlan({
    workspaceRoot: 'root',
    port: 5555,
    nativePort: 5556,
    nativeDriverPath: 'msedgedriver.exe',
    exists: () => true,
  });

  assert.equal(plan.driver.endpoint, 'http://127.0.0.1:5555');
  assert.equal(plan.session.request.url, 'http://127.0.0.1:5555/session');
  assert.equal(
    plan.session.request.body.capabilities.alwaysMatch['tauri:options'].application,
    plan.releaseExecutable.path,
  );
  assert.equal(plan.overlay.windowLabel, OVERLAY_WINDOW_LABEL);
  assert.equal(plan.requiredTools.length, REQUIRED_DRIVER_TOOLS.length);
});

test('the printed dry-run plan names the tools, the endpoint and the assertions', () => {
  const text = formatOverlayDriverSmokePlanText(
    buildOverlayDriverSmokePlan({ workspaceRoot: 'root', exists: () => false }),
  );

  assert.match(text, /tauri-driver/);
  assert.match(text, /msedgedriver/);
  assert.match(text, /driver endpoint: http:\/\/127\.0\.0\.1:4444/);
  assert.match(text, /build it with: npm run build:desktop-shell/);
  assert.match(text, /invoke diagnostics_v2 \{"command":\{"action":"overlaySelfCheck"\}\}/);
  assert.match(text, new RegExp(IPC_NEVER_CONNECTED_MARKER));
});

// ---------------------------------------------------------------------------
// overlay driver smoke — snapshot reading and evaluation

test('overlay window state is read through the ServiceResult envelope', () => {
  const state = overlayWindowStateFromSnapshot({
    data: {
      windows: [
        { label: 'main', visible: true },
        { label: OVERLAY_WINDOW_LABEL, visible: true, kind: 'subtitle-overlay' },
      ],
    },
    requestId: 'abc',
  });

  assert.deepEqual(state, {
    present: true,
    visible: true,
    kind: 'subtitle-overlay',
    windowLabels: ['main', OVERLAY_WINDOW_LABEL],
  });
});

test('overlay window state reports absent when the overlay window does not exist', () => {
  const state = overlayWindowStateFromSnapshot({ windows: [{ label: 'main', visible: true }] });

  assert.equal(state.present, false);
  assert.equal(state.visible, false);
});

const passingSmokeEvidence = (overrides = {}) => ({
  runId: 'overlay-driver-smoke-20260727-120000',
  tools: [
    { name: 'tauri-driver', found: true, path: 'C:/cargo/bin/tauri-driver.exe' },
    { name: 'msedgedriver', found: true, path: 'C:/tools/msedgedriver.exe' },
  ],
  releaseExecutable: { found: true, path: 'target/release/omni-desktop-shell.exe' },
  driverProcess: { started: true, listening: true, pid: 1234, endpoint: 'http://127.0.0.1:4444' },
  session: { created: true, sessionId: 'session-1' },
  overlay: {
    showMode: 'self-check',
    before: { ok: true, result: { data: { windows: [{ label: 'main', visible: true }] } } },
    show: {
      ok: true,
      result: {
        data: {
          windows: [
            { label: 'main', visible: true },
            { label: OVERLAY_WINDOW_LABEL, visible: true },
          ],
        },
      },
    },
    hide: {
      ok: true,
      result: {
        windows: [
          { label: 'main', visible: true },
          { label: OVERLAY_WINDOW_LABEL, visible: false },
        ],
      },
    },
  },
  teardown: { sessionDeleted: true, driverStopped: true, appStopped: true },
  appLogDelta: '2026-07-27 12:00:01.000 [INFO] [omni] runtime - Tauri setup done\n',
  ...overrides,
});

test('a complete overlay smoke run passes every check', () => {
  const evaluation = evaluateOverlayDriverSmoke(passingSmokeEvidence());

  assert.deepEqual(evaluation.failures, []);
  assert.equal(evaluation.passed, true);
  assert.deepEqual(
    evaluation.checks.map((check) => check.name),
    [
      'driver-tooling',
      'release-executable',
      'driver-process',
      'webdriver-session',
      'overlay-hidden-before-show',
      'overlay-show-command',
      'overlay-window-visible',
      'overlay-hidden-after-teardown',
      'session-teardown',
      'ipc-watchdog-quiet',
    ],
  );
});

test('a missing tool fails the smoke with the install hint in the failure text', () => {
  const evaluation = evaluateOverlayDriverSmoke(
    passingSmokeEvidence({
      tools: [
        { name: 'tauri-driver', found: true, path: 'C:/cargo/bin/tauri-driver.exe' },
        { name: 'msedgedriver', found: false, path: null, installHint: REQUIRED_DRIVER_TOOLS[1].installHint },
      ],
    }),
  );

  assert.equal(evaluation.passed, false);
  assert.match(evaluation.failures.join('\n'), /driver-tooling: missing msedgedriver/);
  assert.match(evaluation.failures.join('\n'), /developer\.microsoft\.com/);
});

test('an overlay that never becomes visible fails even when the command returned ok', () => {
  const evidence = passingSmokeEvidence();
  evidence.overlay.show.result.data.windows = [
    { label: 'main', visible: true },
    { label: OVERLAY_WINDOW_LABEL, visible: false },
  ];

  const evaluation = evaluateOverlayDriverSmoke(evidence);

  assert.equal(evaluation.passed, false);
  assert.match(evaluation.failures.join('\n'), /overlay-window-visible: overlay present=true visible=false/);
});

test('an overlay that was already visible before the show command fails the smoke', () => {
  const evidence = passingSmokeEvidence();
  evidence.overlay.before.result.data.windows = [
    { label: 'main', visible: true },
    { label: OVERLAY_WINDOW_LABEL, visible: true },
  ];

  const evaluation = evaluateOverlayDriverSmoke(evidence);

  assert.equal(evaluation.passed, false);
  assert.match(evaluation.failures.join('\n'), /overlay-hidden-before-show/);
});

test('a rejected invoke surfaces the IPC error instead of a generic failure', () => {
  const evidence = passingSmokeEvidence();
  evidence.overlay.show = { ok: false, error: 'window.__TAURI_INTERNALS__.invoke is unavailable' };

  const evaluation = evaluateOverlayDriverSmoke(evidence);

  assert.equal(evaluation.passed, false);
  assert.match(
    evaluation.failures.join('\n'),
    /overlay-show-command: the overlay show command failed: window\.__TAURI_INTERNALS__\.invoke is unavailable/,
  );
});

test('the startup IPC watchdog line fails the overlay smoke', () => {
  const evaluation = evaluateOverlayDriverSmoke(
    passingSmokeEvidence({
      appLogDelta:
        `2026-07-27 12:01:10.000 [ERROR] [omni] runtime - ${IPC_NEVER_CONNECTED_MARKER} | graceSecs=65 note=frontend never reached debug_ipc_ping\n`,
    }),
  );

  assert.equal(evaluation.passed, false);
  assert.match(evaluation.failures.join('\n'), /ipc-watchdog-quiet: app\.log recorded 1 startup\.ipc_never_connected/);
});

test('an aborted runner names the root cause on every unreached stage', () => {
  const evaluation = evaluateOverlayDriverSmoke({
    tools: [
      { name: 'tauri-driver', found: false, installHint: REQUIRED_DRIVER_TOOLS[0].installHint },
      { name: 'msedgedriver', found: false, installHint: REQUIRED_DRIVER_TOOLS[1].installHint },
    ],
    releaseExecutable: { found: false, path: 'target/release/omni-desktop-shell.exe' },
    driverProcess: { started: false },
    session: { created: false },
    overlay: {},
    teardown: { sessionDeleted: false, driverStopped: false, appStopped: true },
    runnerError: 'overlay driver smoke requires tauri-driver, msedgedriver on PATH',
    appLogDelta: '',
  });

  assert.equal(evaluation.passed, false);
  const driverProcessCheck = evaluation.checks.find((check) => check.name === 'driver-process');
  const sessionCheck = evaluation.checks.find((check) => check.name === 'webdriver-session');
  assert.match(driverProcessCheck.detail, /not reached; the runner aborted: overlay driver smoke requires tauri-driver/);
  assert.match(sessionCheck.detail, /not reached; the runner aborted:/);
  // The genuinely independent signals keep their own wording.
  assert.match(
    evaluation.checks.find((check) => check.name === 'release-executable').detail,
    /build it with npm run build:desktop-shell/,
  );
});

test('an incomplete teardown fails the smoke so leaked sessions are visible', () => {
  const evaluation = evaluateOverlayDriverSmoke(
    passingSmokeEvidence({ teardown: { sessionDeleted: true, driverStopped: false, appStopped: true } }),
  );

  assert.equal(evaluation.passed, false);
  assert.match(evaluation.failures.join('\n'), /session-teardown: sessionDeleted=true driverStopped=false appStopped=true/);
});

test('the smoke report verdict drives the process exit code', () => {
  const passing = buildOverlayDriverSmokeReport({ evidence: passingSmokeEvidence(), generatedAt: 'now' });
  const failing = buildOverlayDriverSmokeReport({
    evidence: passingSmokeEvidence({ session: { created: false, error: 'connection refused' } }),
    generatedAt: 'now',
  });

  assert.equal(passing.verdict, 'passed');
  assert.equal(overlayDriverSmokeExitCode(passing), 0);
  assert.equal(failing.verdict, 'failed');
  assert.equal(overlayDriverSmokeExitCode(failing), 1);
  assert.match(failing.failures.join('\n'), /webdriver-session: WebDriver session was not created: connection refused/);
});

test('a dry-run report never claims a pass and never evaluates checks', () => {
  const report = buildOverlayDriverSmokeReport({ evidence: { dryRun: true, runId: 'dry' }, generatedAt: 'now' });

  assert.equal(report.verdict, 'dry-run');
  assert.deepEqual(report.checks, []);
  assert.equal(overlayDriverSmokeExitCode(report), 0);
});

test('the skip banner is loud, names the escape hatch and warns about the gap', () => {
  const banner = formatSkipBanner({ reason: 'OMNI_SKIP_DRIVER_SMOKE=1 was set in the environment' });

  assert.match(banner, /^!{78}$/m);
  assert.match(banner, /SKIPPED: overlay driver smoke/);
  assert.match(banner, /escape hatch: OMNI_SKIP_DRIVER_SMOKE=1/);
  assert.match(banner, /did NOT verify the overlay/);
});

// ---------------------------------------------------------------------------
// startup IPC stress — marker detection

test('the ping log line yields the storage status and the native elapsed time', () => {
  const parsed = parseIpcPingLogLine(
    '2026-07-27 12:00:03.120 [DEBUG] [omni] runtime - debug_ipc_ping | status=ready elapsedMs=7 sid=abc',
  );

  assert.equal(parsed.storageStatus, 'ready');
  assert.equal(parsed.nativeElapsedMs, 7);
});

test('a successful ping line counts as connected', () => {
  const evidence = findIpcPingEvidence(
    [
      '2026-07-27 12:00:01.000 [INFO] [omni] runtime - Tauri setup done',
      '2026-07-27 12:00:03.120 [DEBUG] [omni] runtime - debug_ipc_ping | status=ready elapsedMs=7',
    ].join('\n'),
  );

  assert.equal(evidence.connected, true);
  assert.equal(evidence.marker, IPC_PING_LOG_MARKER);
  assert.equal(evidence.storageStatus, 'ready');
});

test('a forwarded "debug_ipc_ping failed" line is never treated as a connection', () => {
  const evidence = findIpcPingEvidence(
    '2026-07-27 12:00:20.000 [ERROR] [omni] runtime - debug_ipc_ping failed | invoke timeout after 750ms',
  );

  assert.equal(evidence.connected, false);
  assert.equal(evidence.marker, null);
});

test('the info-level bootstrap notification is accepted when the debug line is absent', () => {
  const evidence = findIpcPingEvidence(
    '2026-07-27 12:00:04.000 [INFO] [omni] runtime - runtime-bootstrap | rust-core channel established',
  );

  assert.equal(evidence.connected, true);
  assert.equal(evidence.marker, IPC_BRIDGE_READY_MARKER);
});

test('the never-connected watchdog line is detected and never read as a ping', () => {
  const delta = `2026-07-27 12:01:10.000 [ERROR] [omni] runtime - ${IPC_NEVER_CONNECTED_MARKER} | graceSecs=65 note=frontend never reached debug_ipc_ping; native IPC channel did not initialize`;

  assert.equal(findIpcPingEvidence(delta).connected, false);
  const watchdog = detectNeverConnected(delta);
  assert.equal(watchdog.detected, true);
  assert.equal(watchdog.lines.length, 1);
});

// ---------------------------------------------------------------------------
// startup IPC stress — plan, records and summary

test('the stress plan defaults to 10 runs and a timeout above the watchdog grace', () => {
  const plan = buildStartupIpcStressPlan({ workspaceRoot: 'root', exists: () => true });

  assert.equal(plan.runs, 10);
  assert.equal(plan.pingTimeoutMs, DEFAULT_PING_TIMEOUT_MS);
  assert.equal(plan.watchdogGraceMs, IPC_WATCHDOG_GRACE_MS);
  assert.equal(plan.timeoutCoversWatchdogGrace, true);
  assert.equal(plan.environment.OMNI_LOG_LEVEL, 'debug');
  assert.deepEqual(plan.ipcConnectedMarkers, [IPC_PING_LOG_MARKER, IPC_BRIDGE_READY_MARKER]);
});

test('the stress plan flags a timeout that cannot observe the watchdog', () => {
  const plan = buildStartupIpcStressPlan({ workspaceRoot: 'root', pingTimeoutMs: 20_000, exists: () => true });

  assert.equal(plan.timeoutCoversWatchdogGrace, false);
  assert.match(formatStartupIpcStressPlanText(plan), /covered=false/);
  assert.throws(() => buildStartupIpcStressPlan({ runs: 0 }), /positive integer/);
});

test('a run record derives connectivity from the log delta, not from the caller', () => {
  const record = buildStressRunRecord({
    index: 3,
    latencyMs: 4200,
    waitedMs: 4200,
    logDelta: '2026-07-27 12:00:03.120 [DEBUG] [omni] runtime - debug_ipc_ping | status=ready elapsedMs=7',
  });

  assert.equal(record.connected, true);
  assert.equal(record.latencyMs, 4200);
  assert.equal(record.marker, IPC_PING_LOG_MARKER);
  assert.equal(record.neverConnected, false);
});

test('a run with no ping evidence drops the reported latency', () => {
  const record = buildStressRunRecord({ index: 4, latencyMs: 90_000, waitedMs: 90_000, logDelta: 'nothing useful' });

  assert.equal(record.connected, false);
  assert.equal(record.latencyMs, null);
});

const connectedRun = (index, latencyMs) =>
  buildStressRunRecord({
    index,
    latencyMs,
    waitedMs: latencyMs,
    logDelta: `2026-07-27 12:00:0${index}.000 [DEBUG] [omni] runtime - debug_ipc_ping | status=ready elapsedMs=5`,
  });

test('ten healthy runs summarize to a pass with latency percentiles', () => {
  const runs = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 5000].map((latency, offset) =>
    connectedRun(offset + 1, latency),
  );

  const summary = summarizeStartupIpcStressRuns(runs, { requestedRuns: 10 });

  assert.equal(summary.passed, true);
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.totalRuns, 10);
  assert.equal(summary.connectedRuns, 10);
  assert.equal(summary.latencyMs.min, 1000);
  assert.equal(summary.latencyMs.max, 5000);
  assert.equal(summary.latencyMs.p50, 1800);
  assert.equal(summary.latencyMs.p95, 5000);
});

test('a single never-connected run fails the whole stress run', () => {
  const runs = [
    connectedRun(1, 1500),
    buildStressRunRecord({ index: 2, waitedMs: 90_000, logDelta: '' }),
    connectedRun(3, 1700),
  ];

  const summary = summarizeStartupIpcStressRuns(runs, { requestedRuns: 3, pingTimeoutMs: 90_000 });

  assert.equal(summary.passed, false);
  assert.equal(summary.connectedRuns, 2);
  assert.equal(summary.neverConnectedRuns, 1);
  assert.match(
    summary.failures.join('\n'),
    /run 2 never reached a successful IPC ping within 90000ms \(waited 90000ms\)/,
  );
  // The healthy runs still contribute their latencies to the report.
  assert.equal(summary.latencyMs.samples, 2);
});

test('the watchdog marker is reported separately from the missing ping', () => {
  const runs = [
    buildStressRunRecord({
      index: 1,
      waitedMs: 90_000,
      logDelta: `2026-07-27 12:01:10.000 [ERROR] [omni] runtime - ${IPC_NEVER_CONNECTED_MARKER} | graceSecs=65`,
    }),
  ];

  const summary = summarizeStartupIpcStressRuns(runs, { requestedRuns: 1 });

  assert.equal(summary.watchdogRuns, 1);
  assert.equal(summary.failures.length, 2);
  assert.match(summary.failures[0], /never reached a successful IPC ping/);
  assert.match(summary.failures[1], /run 1 logged startup\.ipc_never_connected/);
});

test('a launch failure is reported instead of a bogus never-connected verdict', () => {
  const runs = [buildStressRunRecord({ index: 1, launched: false, launchError: 'os error 740', logDelta: '' })];

  const summary = summarizeStartupIpcStressRuns(runs, { requestedRuns: 1 });

  assert.equal(summary.launchFailures, 1);
  assert.deepEqual(summary.failures, ['run 1 failed to launch the release shell: os error 740']);
});

test('fewer executed runs than requested is itself a failure', () => {
  const summary = summarizeStartupIpcStressRuns([connectedRun(1, 1200)], { requestedRuns: 10 });

  assert.equal(summary.passed, false);
  assert.match(summary.failures.join('\n'), /only 1 of 10 requested runs were executed/);
});

test('zero runs never passes silently', () => {
  const summary = summarizeStartupIpcStressRuns([], { requestedRuns: null });

  assert.equal(summary.passed, false);
  assert.deepEqual(summary.failures, ['no startup IPC stress runs were executed']);
});

test('the stress report verdict drives the process exit code', () => {
  const failing = buildStartupIpcStressReport({
    evidence: {
      runId: 'stress',
      plan: { runs: 2, pingTimeoutMs: 90_000 },
      runs: [
        { index: 1, latencyMs: 1200, waitedMs: 1200, logDelta: 'runtime - debug_ipc_ping | status=ready elapsedMs=4' },
        { index: 2, waitedMs: 90_000, logDelta: `runtime - ${IPC_NEVER_CONNECTED_MARKER} | graceSecs=65` },
      ],
    },
    generatedAt: 'now',
  });

  assert.equal(failing.verdict, 'failed');
  assert.equal(startupIpcStressExitCode(failing), 1);
  assert.equal(failing.summary.connectedRuns, 1);
  assert.equal(failing.runs.length, 2);

  const passing = buildStartupIpcStressReport({
    evidence: {
      runId: 'stress',
      plan: { runs: 1, pingTimeoutMs: 90_000 },
      runs: [{ index: 1, latencyMs: 900, waitedMs: 900, logDelta: 'runtime - debug_ipc_ping | status=ready elapsedMs=3' }],
    },
    generatedAt: 'now',
  });

  assert.equal(passing.verdict, 'passed');
  assert.equal(startupIpcStressExitCode(passing), 0);
});

test('a dry-run stress report never claims a pass over zero launches', () => {
  const report = buildStartupIpcStressReport({ evidence: { dryRun: true, plan: { runs: 10 } }, generatedAt: 'now' });

  assert.equal(report.verdict, 'dry-run');
  assert.equal(report.summary.totalRuns, 0);
  assert.equal(startupIpcStressExitCode(report), 0);
});
