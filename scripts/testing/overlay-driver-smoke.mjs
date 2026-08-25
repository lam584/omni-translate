/**
 * Pure logic for the tauri-driver overlay smoke.
 *
 * Nothing in this module launches a process, opens a socket, or talks to a
 * running app: the PowerShell runner (scripts/testing/run-overlay-driver-smoke.ps1)
 * owns every side effect and hands the collected evidence back as JSON. Keeping
 * the argument building, the pass/fail evaluation and the report shaping here is
 * what makes the smoke unit-testable without a desktop session — see
 * scripts/testing/startup-orchestration.test.mjs.
 *
 * The smoke drives the *real* IPC boundary: tauri-driver starts the release
 * shell under WebDriver, and every overlay command is issued from inside the
 * main webview via `window.__TAURI_INTERNALS__.invoke`. The desktop shell has no
 * CLI argument handling (no tauri-plugin-cli, no std::env::args reader), so
 * "<exe> tauri invoke <command>" would only launch a second app instance — the
 * WebDriver execute-async path is the only out-of-process way to reach a command.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  asPositiveInteger,
  isMain,
  sortableTimestamp,
} from '../lib/testing-common.mjs';
import { currentGitCommit } from './watch-mode-report.mjs';
import {
  emitPlanArtifacts,
  parseSmokeCliArgs,
  readPackageVersion,
  releaseExecutablePlanLines,
  resolveSmokeDirs,
  smokeExitCode,
  writeReportFromEvidence,
} from './lib/smoke-common.mjs';

export const DEFAULT_OUTPUT_ROOT = 'artifacts/testing/overlay-driver-smoke';
export const DEFAULT_DRIVER_HOST = '127.0.0.1';
export const DEFAULT_DRIVER_PORT = 4444;
export const DEFAULT_NATIVE_DRIVER_PORT = 4445;
export const DEFAULT_NATIVE_DRIVER = 'msedgedriver.exe';
export const DEFAULT_SESSION_TIMEOUT_SECONDS = 120;
export const RELEASE_EXECUTABLE_NAME = 'omni-desktop-shell.exe';

/** Window label the Rust side gives the subtitle overlay (runtime/events.rs). */
export const OVERLAY_WINDOW_LABEL = 'subtitle-overlay';
/** Passive startup watchdog marker (main.rs IPC_WATCHDOG_GRACE branch). */
export const IPC_NEVER_CONNECTED_MARKER = 'startup.ipc_never_connected';

export const OVERLAY_SHOW_MODES = ['self-check', 'toggle'];

/**
 * External tools the real (non-dry-run) smoke cannot fake. Each carries the
 * exact command that installs it, so a missing tool fails with something the
 * operator can act on instead of "not found".
 */
export const REQUIRED_DRIVER_TOOLS = [
  {
    name: 'tauri-driver',
    executable: 'tauri-driver.exe',
    installHint:
      'cargo install tauri-driver --locked (then reopen the shell so the cargo bin directory is on PATH)',
  },
  {
    name: 'msedgedriver',
    executable: 'msedgedriver.exe',
    installHint:
      'download the Microsoft Edge WebDriver whose version matches the installed WebView2 runtime from '
      + 'https://developer.microsoft.com/microsoft-edge/tools/webdriver/ , then put msedgedriver.exe on PATH '
      + 'or pass -NativeDriverPath <path-to-msedgedriver.exe>',
  },
];

const RELEASE_BUILD_HINT = 'npm run build:desktop-shell';

/** Install hint for a tool name, or null when the tool is not a known requirement. */
export function installHintFor(toolName) {
  return REQUIRED_DRIVER_TOOLS.find((tool) => tool.name === toolName)?.installHint ?? null;
}

/** One actionable line per missing tool: "<name>: <install command>". */
export function describeMissingTools(tools = []) {
  return tools
    .map((tool) => `${tool?.name ?? '(unknown tool)'}: ${tool?.installHint ?? installHintFor(tool?.name) ?? 'no install hint recorded'}`)
    .join(' | ');
}

/**
 * Where a release `omni-desktop-shell.exe` can legitimately live, most
 * canonical first: the root Cargo workspace target dir, the legacy per-crate
 * target dir, then the prepared installer layout.
 */
export function releaseExecutableCandidates(workspaceRoot = '.', { version = null } = {}) {
  const candidates = [
    path.join(workspaceRoot, 'target', 'release', RELEASE_EXECUTABLE_NAME),
    path.join(workspaceRoot, 'apps', 'desktop', 'src-tauri', 'target', 'release', RELEASE_EXECUTABLE_NAME),
  ];
  if (version) {
    candidates.push(path.join(workspaceRoot, 'artifacts', 'installer', version, 'desktop', RELEASE_EXECUTABLE_NAME));
  }
  return candidates;
}

/**
 * Resolve the release executable without touching the filesystem directly:
 * `exists` is injected so this stays pure and testable. Returns the preferred
 * candidate (plus a build hint) when nothing is built yet, so error messages
 * name the canonical path instead of an empty string.
 */
export function resolveReleaseExecutable({
  workspaceRoot = '.',
  version = null,
  explicitPath = '',
  exists = () => false,
} = {}) {
  if (explicitPath) {
    return {
      path: explicitPath,
      found: exists(explicitPath),
      explicit: true,
      candidates: [explicitPath],
      buildHint: RELEASE_BUILD_HINT,
    };
  }
  const candidates = releaseExecutableCandidates(workspaceRoot, { version });
  const match = candidates.find((candidate) => exists(candidate));
  return {
    path: match ?? candidates[0],
    found: Boolean(match),
    explicit: false,
    candidates,
    buildHint: RELEASE_BUILD_HINT,
  };
}

/** Argument vector for `tauri-driver`, plus the WebDriver endpoint it exposes. */
export function buildTauriDriverArgs({
  host = DEFAULT_DRIVER_HOST,
  port = DEFAULT_DRIVER_PORT,
  nativePort = DEFAULT_NATIVE_DRIVER_PORT,
  nativeDriverPath = DEFAULT_NATIVE_DRIVER,
} = {}) {
  const resolvedPort = asPositiveInteger(port, null);
  const resolvedNativePort = asPositiveInteger(nativePort, null);
  if (resolvedPort === null) {
    throw new Error(`tauri-driver port must be a positive integer; got ${port}`);
  }
  if (resolvedNativePort === null) {
    throw new Error(`tauri-driver native port must be a positive integer; got ${nativePort}`);
  }
  if (resolvedPort === resolvedNativePort) {
    throw new Error(`tauri-driver port and native port must differ; both are ${resolvedPort}`);
  }
  if (!nativeDriverPath) {
    throw new Error('tauri-driver requires a native driver path (msedgedriver.exe)');
  }
  return {
    command: 'tauri-driver',
    args: [
      '--port',
      String(resolvedPort),
      '--native-port',
      String(resolvedNativePort),
      '--native-driver',
      nativeDriverPath,
    ],
    host,
    port: resolvedPort,
    nativePort: resolvedNativePort,
    nativeDriverPath,
    endpoint: `http://${host}:${resolvedPort}`,
  };
}

/** W3C new-session payload for tauri-driver (browserName `wry` + tauri:options). */
export function buildWebDriverSessionRequest({
  endpoint,
  applicationPath,
  applicationArgs = [],
} = {}) {
  if (!endpoint) {
    throw new Error('a WebDriver endpoint is required to build the new-session request');
  }
  if (!applicationPath) {
    throw new Error('a release application path is required to build the new-session request');
  }
  return {
    method: 'POST',
    url: `${endpoint}/session`,
    body: {
      capabilities: {
        alwaysMatch: {
          browserName: 'wry',
          'tauri:options': {
            application: applicationPath,
            args: [...applicationArgs],
          },
        },
        firstMatch: [{}],
      },
    },
  };
}

export function buildSessionTeardownRequest({ endpoint, sessionId } = {}) {
  if (!endpoint || !sessionId) {
    throw new Error('endpoint and sessionId are required to build the session teardown request');
  }
  return { method: 'DELETE', url: `${endpoint}/session/${sessionId}`, body: null };
}

export function buildWindowHandlesRequest({ endpoint, sessionId } = {}) {
  if (!endpoint || !sessionId) {
    throw new Error('endpoint and sessionId are required to build the window handles request');
  }
  return { method: 'GET', url: `${endpoint}/session/${sessionId}/window/handles`, body: null };
}

/**
 * Script body handed to WebDriver `execute/async`. It resolves the WebDriver
 * callback with a discriminated result so a rejected invoke surfaces as
 * evidence instead of a generic script timeout.
 */
export function buildInvokeScript(command, payload = undefined) {
  if (!command) {
    throw new Error('an IPC command name is required to build the invoke script');
  }
  const payloadLiteral = payload === undefined ? 'undefined' : JSON.stringify(payload);
  return [
    'var done = arguments[arguments.length - 1];',
    'try {',
    '  var internals = window.__TAURI_INTERNALS__;',
    '  if (!internals || typeof internals.invoke !== "function") {',
    '    done({ ok: false, error: "window.__TAURI_INTERNALS__.invoke is unavailable" });',
    '  } else {',
    `    Promise.resolve(internals.invoke(${JSON.stringify(command)}, ${payloadLiteral}))`,
    '      .then(function (value) { done({ ok: true, value: value }); })',
    '      .catch(function (error) { done({ ok: false, error: String(error) }); });',
    '  }',
    '} catch (error) {',
    '  done({ ok: false, error: String(error) });',
    '}',
  ].join('\n');
}

export function buildExecuteAsyncRequest({ endpoint, sessionId, command, payload } = {}) {
  if (!endpoint || !sessionId) {
    throw new Error('endpoint and sessionId are required to build an execute request');
  }
  return {
    method: 'POST',
    url: `${endpoint}/session/${sessionId}/execute/async`,
    body: { script: buildInvokeScript(command, payload), args: [] },
  };
}

/**
 * The three ordered overlay steps the smoke drives over the real IPC boundary.
 * `before` proves the overlay starts hidden, `show` proves the documented show
 * path makes the native window visible, `hide` proves teardown puts it back —
 * a single "it is visible" assertion would also pass on an overlay that was
 * already stuck open.
 */
export function buildOverlayStepPlan({ showMode = 'self-check' } = {}) {
  if (!OVERLAY_SHOW_MODES.includes(showMode)) {
    throw new Error(`overlay show mode must be one of ${OVERLAY_SHOW_MODES.join('/')}; got ${showMode}`);
  }
  const show = showMode === 'self-check'
    ? { command: 'diagnostics_v2', payload: { command: { action: 'overlaySelfCheck' } } }
    : { command: 'toggle_subtitle_overlay', payload: undefined };
  // `script` is carried in the plan so the PowerShell runner never has to
  // rebuild the invoke body: the only thing it adds is the session id in the URL.
  return [
    {
      name: 'before',
      command: 'diagnostics_v2',
      payload: { command: { action: 'selfCheck' } },
      expectation: `overlay window '${OVERLAY_WINDOW_LABEL}' is not visible yet`,
    },
    {
      name: 'show',
      ...show,
      expectation: `overlay window '${OVERLAY_WINDOW_LABEL}' becomes visible`,
    },
    {
      name: 'hide',
      command: 'toggle_subtitle_overlay',
      payload: undefined,
      expectation: `overlay window '${OVERLAY_WINDOW_LABEL}' is hidden again`,
    },
  ].map((step) => ({ ...step, script: buildInvokeScript(step.command, step.payload) }));
}

/**
 * Native overlay window state as the Rust runtime snapshot reports it.
 * Tolerates the `ServiceResult` envelope (`{ data, requestId }`) that the
 * *_v2 commands wrap their payload in, and the bare snapshot that
 * `toggle_subtitle_overlay` returns.
 */
export function overlayWindowStateFromSnapshot(raw) {
  const unwrapped = raw && typeof raw === 'object' && 'value' in raw && raw.ok !== undefined ? raw.value : raw;
  const snapshot = unwrapped && typeof unwrapped === 'object' && unwrapped.data !== undefined
    ? unwrapped.data
    : unwrapped;
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  const overlay = windows.find((window) => window?.label === OVERLAY_WINDOW_LABEL) ?? null;
  return {
    present: overlay !== null,
    visible: overlay?.visible === true,
    kind: overlay?.kind ?? null,
    windowLabels: windows.map((window) => String(window?.label ?? '')),
  };
}

/** Full plan: what the runner will start, call and assert. Pure and printable. */
export function buildOverlayDriverSmokePlan({
  workspaceRoot = '.',
  version = null,
  host = DEFAULT_DRIVER_HOST,
  port = DEFAULT_DRIVER_PORT,
  nativePort = DEFAULT_NATIVE_DRIVER_PORT,
  nativeDriverPath = DEFAULT_NATIVE_DRIVER,
  showMode = 'self-check',
  sessionTimeoutSeconds = DEFAULT_SESSION_TIMEOUT_SECONDS,
  releaseExecutablePath = '',
  outputRoot = DEFAULT_OUTPUT_ROOT,
  exists = () => false,
} = {}) {
  const driver = buildTauriDriverArgs({ host, port, nativePort, nativeDriverPath });
  const releaseExecutable = resolveReleaseExecutable({
    workspaceRoot,
    version,
    explicitPath: releaseExecutablePath,
    exists,
  });
  return {
    workspaceRoot,
    outputRoot,
    requiredTools: REQUIRED_DRIVER_TOOLS.map((tool) => ({ ...tool })),
    driver,
    releaseExecutable,
    session: {
      request: buildWebDriverSessionRequest({
        endpoint: driver.endpoint,
        applicationPath: releaseExecutable.path,
      }),
      timeoutSeconds: asPositiveInteger(sessionTimeoutSeconds, DEFAULT_SESSION_TIMEOUT_SECONDS),
    },
    overlay: {
      showMode,
      windowLabel: OVERLAY_WINDOW_LABEL,
      steps: buildOverlayStepPlan({ showMode }),
    },
    teardown: [
      'DELETE the WebDriver session (closes the release shell tauri-driver started)',
      'stop the tauri-driver process tree',
      'force-stop any surviving omni-desktop-shell process',
    ],
    assertions: [
      `overlay window '${OVERLAY_WINDOW_LABEL}' is not visible before the show command`,
      `overlay window '${OVERLAY_WINDOW_LABEL}' is present and visible after the show command`,
      `overlay window '${OVERLAY_WINDOW_LABEL}' is hidden again after teardown toggle`,
      `no '${IPC_NEVER_CONNECTED_MARKER}' line appears in the app.log delta`,
    ],
  };
}

/** Human-readable plan for `-DryRun`. */
export function formatOverlayDriverSmokePlanText(plan) {
  const lines = [
    '=== tauri-driver overlay smoke (plan) ===',
    `workspaceRoot: ${plan.workspaceRoot}`,
    `outputRoot:    ${plan.outputRoot}`,
    '',
    'required tools:',
    ...plan.requiredTools.map((tool) => `  - ${tool.name} (${tool.executable}) :: ${tool.installHint}`),
    '',
    `driver command: ${plan.driver.command} ${plan.driver.args.join(' ')}`,
    `driver endpoint: ${plan.driver.endpoint}`,
    '',
    ...releaseExecutablePlanLines(plan.releaseExecutable),
    '',
    `new session: POST ${plan.session.request.url}`,
    `  capabilities: ${JSON.stringify(plan.session.request.body.capabilities.alwaysMatch)}`,
    `  session timeout: ${plan.session.timeoutSeconds}s`,
    '',
    `overlay show mode: ${plan.overlay.showMode}`,
    'overlay steps (executed inside the main webview over the real IPC boundary):',
    ...plan.overlay.steps.map(
      (step) => `  ${step.name}: invoke ${step.command}${step.payload ? ` ${JSON.stringify(step.payload)}` : ''} -> ${step.expectation}`,
    ),
    '',
    'assertions:',
    ...plan.assertions.map((assertion) => `  - ${assertion}`),
    '',
    'teardown:',
    ...plan.teardown.map((step) => `  - ${step}`),
  ];
  return lines.join('\n');
}

/**
 * LOUD, never-silent skip banner. Used by scripts/release/verify-release.mjs and
 * the runner itself so an escape hatch can never be mistaken for a pass.
 */
export function formatSkipBanner({ reason, envVar = 'OMNI_SKIP_DRIVER_SMOKE', step = 'overlay driver smoke' } = {}) {
  const border = '!'.repeat(78);
  return [
    border,
    `!! SKIPPED: ${step}`,
    `!! reason: ${reason ?? 'no reason recorded'}`,
    `!! escape hatch: ${envVar}=1`,
    '!! This run did NOT verify the overlay against a real WebDriver session.',
    '!! Unset the escape hatch and rerun before treating this as release evidence.',
    border,
  ].join('\n');
}

/** Concrete pass/fail evaluation from collected evidence. */
export function evaluateOverlayDriverSmoke(evidence = {}) {
  const checks = [];
  const addCheck = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail: detail ?? null });
  };
  // When the runner aborted (missing tooling, no release build, driver refused
  // to start), every later stage is unreached rather than independently broken.
  // Naming the root cause on each of them keeps the report from reading like
  // nine unrelated failures.
  const runnerError = evidence.runnerError ? String(evidence.runnerError) : null;
  const unreached = (fallback) => (runnerError ? `not reached; the runner aborted: ${runnerError}` : fallback);

  const tools = Array.isArray(evidence.tools) ? evidence.tools : [];
  const missingTools = tools.filter((tool) => tool?.found !== true);
  addCheck(
    'driver-tooling',
    tools.length > 0 && missingTools.length === 0,
    tools.length === 0
      ? `no WebDriver tooling probe was recorded; expected ${REQUIRED_DRIVER_TOOLS.map((tool) => tool.name).join(' and ')}`
      : missingTools.length > 0
        ? `missing ${missingTools.map((tool) => tool.name).join(', ')} -> ${describeMissingTools(missingTools)}`
        : `resolved ${tools.map((tool) => `${tool.name}=${tool.path}`).join(', ')}`,
  );

  const releaseExecutable = evidence.releaseExecutable ?? {};
  addCheck(
    'release-executable',
    releaseExecutable.found === true && Boolean(releaseExecutable.path),
    releaseExecutable.found === true
      ? `using ${releaseExecutable.path}`
      : `release shell was not built at ${releaseExecutable.path ?? '(no candidate recorded)'}; build it with ${releaseExecutable.buildHint ?? RELEASE_BUILD_HINT}`,
  );

  const driverProcess = evidence.driverProcess ?? {};
  addCheck(
    'driver-process',
    driverProcess.started === true && driverProcess.listening === true,
    driverProcess.started === true
      ? driverProcess.listening === true
        ? `tauri-driver is listening on ${driverProcess.endpoint ?? '(endpoint not recorded)'} (pid=${driverProcess.pid ?? '-'})`
        : `tauri-driver started (pid=${driverProcess.pid ?? '-'}) but never accepted connections on ${driverProcess.endpoint ?? '(endpoint not recorded)'}`
      : `tauri-driver did not start: ${driverProcess.error ?? unreached('no error recorded')}`,
  );

  const session = evidence.session ?? {};
  addCheck(
    'webdriver-session',
    session.created === true && Boolean(session.sessionId),
    session.created === true && session.sessionId
      ? `session ${session.sessionId} created against the release build`
      : `WebDriver session was not created: ${session.error ?? unreached('no error recorded')}`,
  );

  const overlay = evidence.overlay ?? {};
  const stepState = (name) => {
    const step = overlay[name] ?? {};
    return {
      ok: step.ok === true,
      error: step.error ?? null,
      state: overlayWindowStateFromSnapshot(step.result ?? step.snapshot ?? null),
    };
  };
  const before = stepState('before');
  const show = stepState('show');
  const hide = stepState('hide');

  addCheck(
    'overlay-hidden-before-show',
    before.ok && before.state.visible === false,
    before.ok
      ? `overlay visible=${before.state.visible} present=${before.state.present} windows=[${before.state.windowLabels.join(', ')}]`
      : `the pre-show runtime snapshot invoke failed: ${before.error ?? unreached('no error recorded')}`,
  );

  addCheck(
    'overlay-show-command',
    show.ok,
    show.ok
      ? `${overlay.showMode ?? 'self-check'} show command returned a runtime snapshot`
      : `the overlay show command failed: ${show.error ?? unreached('no error recorded')}`,
  );

  addCheck(
    'overlay-window-visible',
    show.ok && show.state.present === true && show.state.visible === true,
    show.ok
      ? `overlay present=${show.state.present} visible=${show.state.visible} windows=[${show.state.windowLabels.join(', ')}]`
      : 'the overlay show command did not return a runtime snapshot to assert on',
  );

  addCheck(
    'overlay-hidden-after-teardown',
    hide.ok && hide.state.visible === false,
    hide.ok
      ? `overlay visible=${hide.state.visible} after the teardown toggle`
      : `the teardown toggle failed: ${hide.error ?? unreached('no error recorded')}`,
  );

  const teardown = evidence.teardown ?? {};
  addCheck(
    'session-teardown',
    teardown.sessionDeleted === true && teardown.driverStopped === true && teardown.appStopped === true,
    `sessionDeleted=${teardown.sessionDeleted === true} driverStopped=${teardown.driverStopped === true} appStopped=${teardown.appStopped === true}`,
  );

  const appLogDelta = String(evidence.appLogDelta ?? '');
  const watchdogLines = appLogDelta
    .split(/\r?\n/)
    .filter((line) => line.includes(IPC_NEVER_CONNECTED_MARKER));
  addCheck(
    'ipc-watchdog-quiet',
    watchdogLines.length === 0,
    watchdogLines.length === 0
      ? `no ${IPC_NEVER_CONNECTED_MARKER} line in the app.log delta`
      : `app.log recorded ${watchdogLines.length} ${IPC_NEVER_CONNECTED_MARKER} line(s): ${watchdogLines.at(-1)}`,
  );

  const failures = checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`);
  return { passed: failures.length === 0, checks, failures };
}

export function buildOverlayDriverSmokeReport({
  evidence = {},
  generatedAt = sortableTimestamp(),
  gitCommit = null,
  artifacts = {},
} = {}) {
  const dryRun = evidence.dryRun === true;
  const evaluation = dryRun
    ? { passed: true, checks: [], failures: [] }
    : evaluateOverlayDriverSmoke(evidence);
  return {
    schemaVersion: 1,
    kind: 'overlay-driver-smoke',
    generatedAt,
    gitCommit,
    runId: evidence.runId ?? null,
    dryRun,
    verdict: dryRun ? 'dry-run' : evaluation.passed ? 'passed' : 'failed',
    startedAt: evidence.startedAt ?? null,
    finishedAt: evidence.finishedAt ?? null,
    plan: evidence.plan ?? null,
    tools: Array.isArray(evidence.tools) ? evidence.tools : [],
    releaseExecutable: evidence.releaseExecutable ?? null,
    driverProcess: evidence.driverProcess ?? null,
    session: evidence.session ?? null,
    overlay: evidence.overlay ?? null,
    teardown: evidence.teardown ?? null,
    runnerError: evidence.runnerError ?? null,
    checks: evaluation.checks,
    failures: evaluation.failures,
    artifacts,
  };
}

export const overlayDriverSmokeExitCode = smokeExitCode;

// ---------------------------------------------------------------------------
// Thin CLI seam: reads/writes JSON only. The PowerShell runner calls
//   --mode plan   (writes plan.json, prints the plan text)
//   --mode report (reads evidence.json, writes report.json, sets the exit code)

if (isMain(import.meta.url)) {
  try {
    const args = parseSmokeCliArgs(process.argv.slice(2), {
      reason: '',
      driverHost: DEFAULT_DRIVER_HOST,
      driverPort: String(DEFAULT_DRIVER_PORT),
      nativeDriverPort: String(DEFAULT_NATIVE_DRIVER_PORT),
      nativeDriverPath: DEFAULT_NATIVE_DRIVER,
      showMode: 'self-check',
      sessionTimeoutSeconds: String(DEFAULT_SESSION_TIMEOUT_SECONDS),
      outputRoot: DEFAULT_OUTPUT_ROOT,
    });

    // Single source for the escape-hatch banner so the PowerShell runner and
    // scripts/release/verify-release.mjs cannot drift into a quieter wording.
    if (args.mode === 'skip-banner') {
      console.log(formatSkipBanner({ reason: args.reason || 'no reason recorded' }));
      process.exit(0);
    }

    const { workspaceRoot, outputDir } = resolveSmokeDirs(args, DEFAULT_OUTPUT_ROOT);

    if (args.mode === 'plan') {
      const plan = buildOverlayDriverSmokePlan({
        workspaceRoot,
        version: readPackageVersion(workspaceRoot),
        host: args.driverHost,
        port: Number(args.driverPort),
        nativePort: Number(args.nativeDriverPort),
        nativeDriverPath: args.nativeDriverPath,
        showMode: args.showMode,
        sessionTimeoutSeconds: Number(args.sessionTimeoutSeconds),
        releaseExecutablePath: args.releaseExecutablePath,
        outputRoot: args.outputRoot,
        exists: (candidate) => fs.existsSync(candidate),
      });
      emitPlanArtifacts({
        outputDir,
        plan,
        planText: formatOverlayDriverSmokePlanText(plan),
        dryRun: args.dryRun,
        buildReport: buildOverlayDriverSmokeReport,
      });
      process.exit(0);
    }

    if (args.mode !== 'report') {
      throw new Error(`Unknown --mode ${args.mode}; expected plan, report or skip-banner`);
    }

    const report = writeReportFromEvidence({
      inputDir: args.input || outputDir,
      outputDir,
      label: 'overlay driver smoke',
      buildReport: buildOverlayDriverSmokeReport,
    });
    for (const check of report.checks) {
      console.log(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
    }
    if (report.verdict === 'failed') {
      console.error(`overlay driver smoke FAILED (${report.failures.length} check(s)):`);
      for (const failure of report.failures) {
        console.error(`- ${failure}`);
      }
    }
    process.exit(overlayDriverSmokeExitCode(report));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
