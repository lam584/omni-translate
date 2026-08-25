import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

import {
  compactTimestamp,
  ensureDir,
  isMain,
  parseCliArgs,
  readJson,
  repoRoot,
  writeJson,
} from '../lib/testing-common.mjs';
import {
  buildExecuteAsyncRequest,
  buildSessionTeardownRequest,
  buildTauriDriverArgs,
  buildWebDriverSessionRequest,
  resolveReleaseExecutable,
} from './overlay-driver-smoke.mjs';
import {
  currentGitProvenance,
  exactGitProvenanceFailure,
  gitProvenanceShapeFailure,
} from './git-provenance.mjs';
import {
  OVERLAY_CLICK_THROUGH_ARTIFACTS,
  OVERLAY_CLICK_THROUGH_COLLECTOR_ID,
  OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION,
  OVERLAY_CLICK_THROUGH_RUNNER,
  OVERLAY_CLICK_THROUGH_SCENARIO_ID,
  OVERLAY_CLICK_THROUGH_SCHEMA_VERSION,
  OVERLAY_CLICK_THROUGH_VALIDATOR,
  OVERLAY_PROCESS_AUTHORITY_HELPER,
  OVERLAY_RUNNER_TIMELINE,
  OVERLAY_TOOLING_RELATIVE_ROOT,
  PINNED_TAURI_DRIVER_VERSION,
  assertOverlayClickThroughEvidence,
  fileReceipt,
  sha256File,
} from './overlay-click-through-release-evidence.mjs';

const DEFAULT_OUTPUT_ROOT = 'artifacts/testing/overlay-click-through-release-evidence';
const DEFAULT_COLLECTOR_OUTPUT_ROOT = 'artifacts/testing/release-manual-collector';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_DRIVER_HOST = '127.0.0.1';
const DEFAULT_DRIVER_PORT = 4544;
const DEFAULT_NATIVE_DRIVER_PORT = 4545;
const TARGET_EXECUTABLE_NAME = 'omni-overlay-click-target.exe';
const DESKTOP_EXECUTABLE_NAME = 'omni-desktop-shell.exe';
const NATIVE_DRIVER_EXECUTABLE_NAME = 'msedgedriver.exe';
const WEBVIEW_RUNTIME_EXECUTABLE_NAME = 'msedgewebview2.exe';
const MICROSOFT_SIGNER_PATTERN = /(?:^|,)\s*CN=Microsoft Corporation(?:,|$)/i;
const FOUR_PART_VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
const preparedToolingAuthorities = new WeakSet();
const TEST_ONLY_SEAM = Symbol('overlay-click-through-test-only-seam');
const PRODUCTION_PLAN_AUTHORITY = Symbol('overlay-click-through-production-plan-authority');
const PRODUCTION_COLLECTOR_AUTHORITY = Symbol('overlay-click-through-production-collector-authority');

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const assertCleanProvenance = (provenance) => {
  const failure = gitProvenanceShapeFailure(provenance, 'overlay source provenance');
  if (failure) throw new Error(failure);
};

const targetExecutableCandidates = (workspaceRoot) => [
  path.join(workspaceRoot, 'target', 'release', TARGET_EXECUTABLE_NAME),
  path.join(
    workspaceRoot,
    'apps',
    'desktop',
    'src-tauri',
    'target',
    'release',
    TARGET_EXECUTABLE_NAME,
  ),
];

const samePath = (left, right) => {
  const resolvedLeft = path.resolve(String(left ?? ''));
  const resolvedRight = path.resolve(String(right ?? ''));
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
};

const assertPortableExecutable = (candidate, subject) => {
  const bytes = fs.readFileSync(candidate);
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`${subject} is not a Windows PE executable`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset + 4 > bytes.length
    || bytes.subarray(peOffset, peOffset + 4).toString('hex') !== '50450000') {
    throw new Error(`${subject} has no valid PE signature`);
  }
};

const resolveTargetExecutable = (workspaceRoot, exists = fs.existsSync) => {
  const candidates = targetExecutableCandidates(workspaceRoot);
  const candidate = candidates.find((entry) => exists(entry));
  if (!candidate) {
    throw new Error(`overlay target release executable is missing: ${candidates.join(', ')}`);
  }
  return path.resolve(candidate);
};

const authorityHelperPath = (workspaceRoot) => path.join(
  workspaceRoot,
  ...OVERLAY_PROCESS_AUTHORITY_HELPER.split('/'),
);

const toolingRoot = (workspaceRoot) => path.join(
  workspaceRoot,
  ...OVERLAY_TOOLING_RELATIVE_ROOT.split('/'),
);

export const canonicalTauriDriverPath = (workspaceRoot) => path.join(
  toolingRoot(path.resolve(workspaceRoot)),
  'tauri-driver',
  PINNED_TAURI_DRIVER_VERSION,
  'bin',
  'tauri-driver.exe',
);

export const canonicalNativeDriverPath = (workspaceRoot, browserVersion) => {
  if (!FOUR_PART_VERSION_PATTERN.test(String(browserVersion ?? ''))) {
    throw new Error('WebView2 runtime version must have four numeric components');
  }
  return path.join(
    toolingRoot(path.resolve(workspaceRoot)),
    'msedgedriver',
    browserVersion,
    NATIVE_DRIVER_EXECUTABLE_NAME,
  );
};

export const pinnedTauriDriverInstallCommand = (workspaceRoot) => {
  const installRoot = path.dirname(path.dirname(canonicalTauriDriverPath(workspaceRoot)));
  return {
    command: 'cargo',
    args: [
      'install',
      'tauri-driver',
      '--version',
      `=${PINNED_TAURI_DRIVER_VERSION}`,
      '--locked',
      '--force',
      '--root',
      installRoot,
    ],
    installRoot,
  };
};

const powershellExecutable = () => process.platform === 'win32'
  ? 'powershell.exe'
  : 'pwsh';

export function inspectWindowsOverlayAuthority({
  helperPath,
  action,
  literalPath,
  processId,
  rootProcessId,
  run = spawnSync,
} = {}) {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-Action',
    action,
  ];
  if (literalPath) args.push('-LiteralPath', literalPath);
  if (processId) args.push('-ProcessId', String(processId));
  if (rootProcessId) args.push('-RootProcessId', String(rootProcessId));
  const result = run(powershellExecutable(), args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `Windows overlay authority ${action} failed: ${String(result.stderr ?? result.stdout ?? '').trim()}`,
    );
  }
  try {
    return JSON.parse(String(result.stdout ?? '').replace(/^\uFEFF/, '').trim());
  } catch (error) {
    throw new Error(`Windows overlay authority ${action} returned invalid JSON: ${error.message}`);
  }
}

const assertMicrosoftAuthority = (authority, subject, expectedExecutableName) => {
  if (!authority || !path.isAbsolute(String(authority.executablePath ?? ''))
    || !/^[a-f0-9]{64}$/i.test(String(authority.sha256 ?? ''))) {
    throw new Error(`${subject} has no absolute path/SHA-256 authority`);
  }
  if (path.basename(authority.executablePath).toLowerCase()
    !== expectedExecutableName.toLowerCase()) {
    throw new Error(`${subject} executable name is not ${expectedExecutableName}`);
  }
  if (authority.signature?.status !== 'Valid'
    || !MICROSOFT_SIGNER_PATTERN.test(String(authority.signature?.signerSubject ?? ''))
    || String(authority.companyName ?? '') !== 'Microsoft Corporation') {
    throw new Error(`${subject} must have a valid Microsoft Corporation Authenticode signature`);
  }
  if (!FOUR_PART_VERSION_PATTERN.test(String(authority.productVersion ?? ''))) {
    throw new Error(`${subject} must expose an exact four-part product version`);
  }
};

const assertToolingPath = (candidate, expected, subject) => {
  if (!samePath(candidate, expected)) throw new Error(`${subject} is not at its canonical tooling path`);
};

const findFileRecursively = (root, basename) => {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.toLowerCase() === basename.toLowerCase()) return candidate;
    }
  }
  return '';
};

const safeRemoveToolingStaging = (candidate, expectedRoot) => {
  const resolved = path.resolve(candidate);
  const root = path.resolve(expectedRoot);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`refusing to remove overlay tooling staging outside ${root}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
};

const ensureCanonicalNativeDriver = ({
  workspaceRoot,
  runtime,
  helperPath,
  run = spawnSync,
  inspect = inspectWindowsOverlayAuthority,
  exists = fs.existsSync,
}) => {
  const expected = canonicalNativeDriverPath(workspaceRoot, runtime.productVersion);
  if (!exists(expected)) {
    const root = toolingRoot(workspaceRoot);
    ensureDir(path.dirname(expected));
    const staging = path.join(root, `.msedgedriver-${runtime.productVersion}-${crypto.randomUUID()}`);
    const archive = path.join(staging, 'edgedriver_win64.zip');
    ensureDir(staging);
    try {
      const download = run(
        'curl.exe',
        [
          '--fail',
          '--location',
          '--silent',
          '--show-error',
          '--output',
          archive,
          `https://msedgedriver.microsoft.com/${runtime.productVersion}/edgedriver_win64.zip`,
        ],
        { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true },
      );
      if (download.status !== 0) {
        throw new Error(`Microsoft Edge WebDriver download failed: ${String(download.stderr ?? '').trim()}`);
      }
      const listing = run('tar.exe', ['-tf', archive], {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (listing.status !== 0) {
        throw new Error(`Microsoft Edge WebDriver archive listing failed: ${String(listing.stderr ?? '').trim()}`);
      }
      const archiveEntries = String(listing.stdout ?? '')
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      const unsafeEntry = archiveEntries.find((entry) => {
        const normalized = entry.replaceAll('\\', '/');
        return path.posix.isAbsolute(normalized)
          || /^[a-z]:/i.test(normalized)
          || normalized.split('/').includes('..');
      });
      const driverEntries = archiveEntries.filter(
        (entry) => path.posix.basename(entry.replaceAll('\\', '/')).toLowerCase()
          === NATIVE_DRIVER_EXECUTABLE_NAME,
      );
      if (unsafeEntry || driverEntries.length !== 1) {
        throw new Error('official Edge WebDriver archive inventory is unsafe or ambiguous');
      }
      const extractRoot = path.join(staging, 'extracted');
      ensureDir(extractRoot);
      const extract = run('tar.exe', ['-xf', archive, '-C', extractRoot], {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (extract.status !== 0) {
        throw new Error(`Microsoft Edge WebDriver extraction failed: ${String(extract.stderr ?? '').trim()}`);
      }
      const extracted = findFileRecursively(extractRoot, NATIVE_DRIVER_EXECUTABLE_NAME);
      if (!extracted) throw new Error('official Edge WebDriver archive has no msedgedriver.exe');
      const stagedAuthority = inspect({ helperPath, action: 'File', literalPath: extracted, run });
      assertMicrosoftAuthority(stagedAuthority, 'downloaded Microsoft Edge WebDriver', NATIVE_DRIVER_EXECUTABLE_NAME);
      if (stagedAuthority.productVersion !== runtime.productVersion) {
        throw new Error('downloaded Microsoft Edge WebDriver does not exactly match WebView2 runtime');
      }
      fs.renameSync(extracted, expected);
    } finally {
      safeRemoveToolingStaging(staging, root);
    }
  }
  const authority = inspect({ helperPath, action: 'File', literalPath: expected, run });
  assertToolingPath(authority.executablePath, expected, 'Microsoft Edge WebDriver');
  assertMicrosoftAuthority(authority, 'Microsoft Edge WebDriver', NATIVE_DRIVER_EXECUTABLE_NAME);
  if (authority.productVersion !== runtime.productVersion) {
    throw new Error(
      `Microsoft Edge WebDriver ${authority.productVersion} does not exactly match WebView2 ${runtime.productVersion}`,
    );
  }
  return authority;
};

const readPinnedTauriDriverInstallReceipt = (installRoot) => {
  const receiptPath = path.join(installRoot, '.crates2.json');
  if (!fs.existsSync(receiptPath)) {
    throw new Error(`cargo install receipt is missing: ${receiptPath}`);
  }
  const packageId = `tauri-driver ${PINNED_TAURI_DRIVER_VERSION} (registry+https://github.com/rust-lang/crates.io-index)`;
  const installed = readJson(receiptPath)?.installs?.[packageId];
  if (!installed || installed.version_req !== `=${PINNED_TAURI_DRIVER_VERSION}`
    || !isDeepStrictEqual(installed.bins, ['tauri-driver.exe'])
    || installed.target !== 'x86_64-pc-windows-msvc') {
    throw new Error('cargo install receipt does not bind the exact pinned tauri-driver package');
  }
  return {
    path: receiptPath,
    sha256: sha256File(receiptPath),
    packageId,
    versionRequirement: installed.version_req,
    bins: installed.bins,
    target: installed.target,
    rustcSha256: crypto.createHash('sha256').update(String(installed.rustc ?? '')).digest('hex'),
  };
};

export function prepareCanonicalOverlayTooling({
  workspaceRoot = repoRoot,
} = {}) {
  if (process.platform !== 'win32') {
    throw new Error('canonical overlay tooling can only be prepared on Windows');
  }
  const absoluteWorkspace = path.resolve(workspaceRoot);
  const run = spawnSync;
  const inspect = inspectWindowsOverlayAuthority;
  const exists = fs.existsSync;
  const helperPath = authorityHelperPath(absoluteWorkspace);
  if (!exists(helperPath)) throw new Error(`overlay process authority helper is missing: ${helperPath}`);
  const runtime = inspect({ helperPath, action: 'WebViewRuntime', run });
  assertMicrosoftAuthority(runtime, 'installed WebView2 runtime', WEBVIEW_RUNTIME_EXECUTABLE_NAME);
  if (runtime.runtimeVersion !== runtime.productVersion) {
    throw new Error('WebView2 runtime directory version does not match its signed product version');
  }

  const tauriPath = canonicalTauriDriverPath(absoluteWorkspace);
  const installCommand = pinnedTauriDriverInstallCommand(absoluteWorkspace);
  const { installRoot } = installCommand;
  ensureDir(installRoot);
  const install = run(
    installCommand.command,
    installCommand.args,
    { cwd: absoluteWorkspace, stdio: 'inherit', windowsHide: true },
  );
  if (install.status !== 0) throw new Error('pinned locked-source tauri-driver installation failed');
  if (!exists(tauriPath)) throw new Error(`cargo did not publish canonical tauri-driver: ${tauriPath}`);
  assertPortableExecutable(tauriPath, 'canonical tauri-driver');
  const tauriDriver = {
    ...inspect({ helperPath, action: 'File', literalPath: tauriPath, run }),
    installReceipt: readPinnedTauriDriverInstallReceipt(installRoot),
  };
  assertToolingPath(tauriDriver.executablePath, tauriPath, 'tauri-driver');
  const nativeDriver = ensureCanonicalNativeDriver({
    workspaceRoot: absoluteWorkspace,
    runtime,
    helperPath,
    run,
    inspect,
    exists,
  });
  const authority = {
    supplyChain: {
      tauriDriverCrate: 'tauri-driver',
      tauriDriverVersion: PINNED_TAURI_DRIVER_VERSION,
      cargoLocked: true,
      cargoForcedInstall: true,
      nativeDriverSource: `https://msedgedriver.microsoft.com/${runtime.productVersion}/edgedriver_win64.zip`,
    },
    tauriDriver,
    nativeDriver,
    webViewRuntime: runtime,
  };
  deepFreeze(authority);
  preparedToolingAuthorities.add(authority);
  return authority;
}

export function createOverlayClickThroughTestOnlySeam({
  tauriDriverPath,
  nativeDriverPath,
  webViewRuntimePath = nativeDriverPath,
} = {}) {
  for (const [candidate, subject] of [
    [tauriDriverPath, 'test tauri-driver'],
    [nativeDriverPath, 'test native driver'],
    [webViewRuntimePath, 'test WebView runtime'],
  ]) {
    if (!path.isAbsolute(String(candidate ?? '')) || !fs.existsSync(candidate)) {
      throw new Error(`${subject} must be an existing absolute fixture path`);
    }
  }
  const fixtureAuthority = (candidate, extra = {}) => ({
    executablePath: path.resolve(candidate),
    sha256: sha256File(candidate),
    byteCount: fs.statSync(candidate).size,
    fileVersion: extra.productVersion ?? '',
    productVersion: extra.productVersion ?? '',
    originalFilename: path.basename(candidate),
    companyName: extra.companyName ?? '',
    signature: extra.signature ?? {
      status: 'NotSigned',
      signerSubject: null,
      signerThumbprint: null,
      timeStamperSubject: null,
      timeStamperThumbprint: null,
    },
    ...extra,
  });
  return Object.freeze({
    [TEST_ONLY_SEAM]: true,
    tooling: {
      supplyChain: {
        tauriDriverCrate: 'test-fixture',
        tauriDriverVersion: '0.0.0-test',
        cargoLocked: false,
        cargoForcedInstall: false,
        nativeDriverSource: 'test-fixture',
      },
      tauriDriver: fixtureAuthority(tauriDriverPath),
      nativeDriver: fixtureAuthority(nativeDriverPath),
      webViewRuntime: fixtureAuthority(webViewRuntimePath, { runtimeVersion: '0.0.0.0' }),
    },
  });
}

const asPort = (value, subject) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) {
    throw new Error(`${subject} must be an integer between 1024 and 65535`);
  }
  return parsed;
};

const asTimeout = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 30_000 || parsed > 600_000) {
    throw new Error('--timeout-ms must be an integer between 30000 and 600000');
  }
  return parsed;
};

const meaningfulOperator = (operator, notes) => {
  if (typeof operator !== 'string' || operator.trim().length < 2) {
    throw new Error('--operator must name the human who observed the real click-through run');
  }
  if (typeof notes !== 'string' || notes.trim().length < 8) {
    throw new Error('--operator-notes must describe the observed target click and overlay behavior');
  }
  return { operator: operator.trim(), notes: notes.trim() };
};

export function parseOverlayClickThroughReleaseArgs(argv) {
  return parseCliArgs(argv, {
    defaults: {
      outputRoot: DEFAULT_OUTPUT_ROOT,
      collectorOutputRoot: DEFAULT_COLLECTOR_OUTPUT_ROOT,
      operator: '',
      operatorNotes: '',
      driverHost: DEFAULT_DRIVER_HOST,
      driverPort: DEFAULT_DRIVER_PORT,
      nativeDriverPort: DEFAULT_NATIVE_DRIVER_PORT,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  });
}

export function buildOverlayClickThroughReleasePlan({
  workspaceRoot = repoRoot,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  collectorOutputRoot = DEFAULT_COLLECTOR_OUTPUT_ROOT,
  operator,
  operatorNotes,
  driverHost = DEFAULT_DRIVER_HOST,
  driverPort = DEFAULT_DRIVER_PORT,
  nativeDriverPort = DEFAULT_NATIVE_DRIVER_PORT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  now = new Date(),
  invocationId = crypto.randomUUID(),
  suffix = crypto.randomUUID().slice(0, 8),
  exists = fs.existsSync,
  preparedTooling,
  testOnlySeam,
  tauriDriverPath,
  nativeDriverPath,
  source,
  dryRun,
  skip,
  simulated,
} = {}) {
  if ([source, dryRun, skip, simulated, tauriDriverPath, nativeDriverPath]
    .some((value) => value !== undefined)) {
    throw new Error(
      'overlay production emitter does not accept source/dry-run/skip/simulated/executable overrides',
    );
  }
  assertCleanProvenance(provenance);
  const observation = meaningfulOperator(operator, operatorNotes);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(invocationId))) {
    throw new Error('overlay invocationId must be a UUID');
  }
  const absoluteWorkspace = path.resolve(workspaceRoot);
  const release = resolveReleaseExecutable({ workspaceRoot: absoluteWorkspace, exists });
  if (!release.found) {
    throw new Error(`release Desktop executable is missing: ${release.path}; run ${release.buildHint}`);
  }
  const desktopExecutable = path.resolve(release.path);
  if (path.basename(desktopExecutable).toLowerCase() !== DESKTOP_EXECUTABLE_NAME) {
    throw new Error('overlay authority requires the canonical release Desktop executable');
  }
  const targetExecutable = resolveTargetExecutable(absoluteWorkspace, exists);
  const testOnly = testOnlySeam?.[TEST_ONLY_SEAM] === true;
  const tooling = testOnly ? testOnlySeam.tooling : preparedTooling;
  if (!testOnly && !preparedToolingAuthorities.has(tooling)) {
    throw new Error(
      'overlay production plan requires tooling prepared by the pinned locked-source authority',
    );
  }
  const resolvedTauriDriver = path.resolve(tooling?.tauriDriver?.executablePath ?? '');
  const resolvedNativeDriver = path.resolve(tooling?.nativeDriver?.executablePath ?? '');
  if (!testOnly) {
    assertPortableExecutable(desktopExecutable, 'release Desktop executable');
    assertPortableExecutable(targetExecutable, 'overlay target executable');
    assertToolingPath(
      resolvedTauriDriver,
      canonicalTauriDriverPath(absoluteWorkspace),
      'tauri-driver',
    );
    assertToolingPath(
      resolvedNativeDriver,
      canonicalNativeDriverPath(absoluteWorkspace, tooling.webViewRuntime.productVersion),
      'Microsoft Edge WebDriver',
    );
    assertMicrosoftAuthority(
      tooling.nativeDriver,
      'Microsoft Edge WebDriver',
      NATIVE_DRIVER_EXECUTABLE_NAME,
    );
    assertMicrosoftAuthority(
      tooling.webViewRuntime,
      'installed WebView2 runtime',
      WEBVIEW_RUNTIME_EXECUTABLE_NAME,
    );
  }
  for (const [candidate, subject] of [
    [resolvedTauriDriver, 'tauri-driver'],
    [resolvedNativeDriver, 'Microsoft Edge WebDriver'],
  ]) {
    if (!candidate || !exists(candidate) || !fs.statSync(candidate).isFile()) {
      throw new Error(`${subject} canonical executable is missing: ${candidate}`);
    }
  }
  const port = asPort(driverPort, '--driver-port');
  const nativePort = asPort(nativeDriverPort, '--native-driver-port');
  if (port === nativePort) throw new Error('driver and native driver ports must differ');
  const driver = buildTauriDriverArgs({
    host: driverHost,
    port,
    nativePort,
    nativeDriverPath: resolvedNativeDriver,
  });
  const outputBase = path.resolve(absoluteWorkspace, outputRoot);
  const collectorOutputBase = path.resolve(absoluteWorkspace, collectorOutputRoot);
  const allowedOutputBase = path.join(absoluteWorkspace, 'artifacts', 'testing');
  const comparableOutput = process.platform === 'win32' ? outputBase.toLowerCase() : outputBase;
  const comparableAllowed = process.platform === 'win32'
    ? allowedOutputBase.toLowerCase()
    : allowedOutputBase;
  const comparableCollector = process.platform === 'win32'
    ? collectorOutputBase.toLowerCase()
    : collectorOutputBase;
  if ([comparableOutput, comparableCollector].some((candidate) => (
    candidate !== comparableAllowed
    && !candidate.startsWith(`${comparableAllowed}${path.sep}`)
  ))) {
    throw new Error('overlay authority and collector output roots must stay under artifacts/testing');
  }
  const runDirectory = path.resolve(
    outputBase,
    provenance.headCommit.slice(0, 12),
    `${compactTimestamp(now)}-overlay-click-through-${suffix}`,
  );
  const runnerPath = path.join(absoluteWorkspace, ...OVERLAY_CLICK_THROUGH_RUNNER.split('/'));
  const validatorPath = path.join(absoluteWorkspace, ...OVERLAY_CLICK_THROUGH_VALIDATOR.split('/'));
  const processAuthorityPath = authorityHelperPath(absoluteWorkspace);
  for (const [candidate, subject] of [
    [runnerPath, 'overlay runner'],
    [validatorPath, 'overlay validator'],
    [processAuthorityPath, 'overlay process authority helper'],
  ]) {
    if (!exists(candidate)) throw new Error(`${subject} is missing: ${candidate}`);
  }
  return {
    [TEST_ONLY_SEAM]: testOnly,
    [PRODUCTION_PLAN_AUTHORITY]: !testOnly,
    scenarioId: OVERLAY_CLICK_THROUGH_SCENARIO_ID,
    invocationId,
    workspaceRoot: absoluteWorkspace,
    outputRoot: outputBase,
    collectorOutputRoot: collectorOutputBase,
    runDirectory,
    provenance,
    observation,
    timeoutMs: asTimeout(timeoutMs),
    testOnly,
    desktopExecutable,
    desktopExecutableSha256: sha256File(desktopExecutable),
    targetExecutable,
    targetExecutableSha256: sha256File(targetExecutable),
    runner: { path: runnerPath, sha256: sha256File(runnerPath) },
    validator: { path: validatorPath, sha256: sha256File(validatorPath) },
    processAuthorityHelper: {
      path: processAuthorityPath,
      sha256: sha256File(processAuthorityPath),
    },
    tooling,
    driver: {
      ...driver,
      executablePath: resolvedTauriDriver,
      executableSha256: tooling.tauriDriver.sha256,
      nativeDriverSha256: tooling.nativeDriver.sha256,
    },
    desktopEnvironment: {
      OMNI_OVERLAY_RELEASE_EVIDENCE: '1',
      OMNI_OVERLAY_RELEASE_EVIDENCE_OUTPUT_DIRECTORY: runDirectory,
      OMNI_OVERLAY_RELEASE_EVIDENCE_INVOCATION_ID: invocationId,
      OMNI_RELEASE_EVIDENCE_HEAD_COMMIT: provenance.headCommit,
      OMNI_LOG_LEVEL: 'debug',
    },
    targetArguments: [
      '--output-directory',
      runDirectory,
      '--invocation-id',
      invocationId,
      '--source-head-commit',
      provenance.headCommit,
    ],
  };
}

export function runningDesktopProcesses({ run = spawnSync } = {}) {
  if (process.platform !== 'win32') return [];
  const result = run(
    'tasklist',
    ['/FI', `IMAGENAME eq ${DESKTOP_EXECUTABLE_NAME}`, '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) throw new Error('tasklist failed while checking Desktop ownership');
  return String(result.stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => /^"omni-desktop-shell\.exe"/i.test(line.trim()))
    .map((line) => Number(line.match(/^"[^"]+","(\d+)"/)?.[1]))
    .filter((processId) => Number.isInteger(processId) && processId > 0);
}

export function buildOverlayReleaseBinaries({
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  run = spawnSync,
} = {}) {
  assertCleanProvenance(provenance);
  const npmCommand = process.platform === 'win32'
    ? {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', 'run', 'build:desktop-shell'],
    }
    : { command: 'npm', args: ['run', 'build:desktop-shell'] };
  const desktop = run(npmCommand.command, npmCommand.args, {
    cwd: workspaceRoot,
    env: { ...process.env, OMNI_BUILD_COMMIT: provenance.headCommit },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (desktop.status !== 0) {
    const detail = desktop.error?.message
      || String(desktop.stderr ?? desktop.stdout ?? '').trim()
      || `exit code ${desktop.status}`;
    throw new Error(`release Desktop build failed: ${detail}`);
  }
  const target = run(
    'cargo',
    [
      'build',
      '--locked',
      '--release',
      '--manifest-path',
      'apps/desktop/src-tauri/Cargo.toml',
      '--bin',
      'omni-overlay-click-target',
    ],
    {
      cwd: workspaceRoot,
      env: { ...process.env, OMNI_BUILD_COMMIT: provenance.headCommit },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (target.status !== 0) throw new Error('overlay target release build failed');
  const after = currentGitProvenance({ cwd: workspaceRoot });
  const failure = exactGitProvenanceFailure(provenance, after, {
    recordedSubject: 'pre-build source provenance',
    currentSubject: 'post-build checkout',
  });
  if (failure) throw new Error(failure);
  const preparedTooling = prepareCanonicalOverlayTooling({ workspaceRoot });
  const toolingAfter = currentGitProvenance({ cwd: workspaceRoot });
  const toolingFailure = exactGitProvenanceFailure(after, toolingAfter, {
    recordedSubject: 'post-build source provenance',
    currentSubject: 'post-tooling checkout',
  });
  if (toolingFailure) throw new Error(toolingFailure);
  return { provenance: toolingAfter, preparedTooling };
}

const tcpConnects = (host, port, timeoutMs = 250) => new Promise((resolve) => {
  const socket = net.createConnection({ host, port });
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(timeoutMs, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

const waitForTcp = async (host, port, timeoutMs, child) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`tauri-driver exited before listening (code=${child.exitCode})`);
    }
    if (await tcpConnects(host, port)) return;
    await sleep(100);
  }
  throw new Error(`tauri-driver did not listen on ${host}:${port} within ${timeoutMs}ms`);
};

const waitForJson = async (candidate, timeoutMs, child, subject) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(candidate)) return readJson(candidate);
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`${subject} exited before publishing its receipt (code=${child.exitCode})`);
    }
    await sleep(25);
  }
  throw new Error(`${subject} did not publish ${path.basename(candidate)} within ${timeoutMs}ms`);
};

const webDriverRequest = async ({ method, url, body }, timeoutMs) => {
  const response = await fetch(url, {
    method,
    headers: body === null || body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === null || body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`WebDriver ${method} ${url} returned invalid JSON (${response.status})`);
  }
  if (!response.ok) {
    const detail = parsed?.value?.message ?? parsed?.message ?? text;
    throw new Error(`WebDriver ${method} ${url} failed (${response.status}): ${detail}`);
  }
  return parsed;
};

const invokeDesktop = async (plan, sessionId, command, payload, request = webDriverRequest) => {
  const response = await request(
    buildExecuteAsyncRequest({
      endpoint: plan.driver.endpoint,
      sessionId,
      command,
      payload,
    }),
    plan.timeoutMs,
  );
  const result = response?.value;
  if (result?.ok !== true) {
    throw new Error(`Desktop invoke ${command} failed: ${result?.error ?? 'no result'}`);
  }
  return { response, result };
};

const terminateTree = (child) => {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } else child.kill('SIGKILL');
};

const writeJsonExclusive = (candidate, value) => {
  if (fs.existsSync(candidate)) throw new Error(`authority artifact already exists: ${candidate}`);
  writeJson(candidate, value);
};

const payloadReceipts = (runDirectory) => OVERLAY_CLICK_THROUGH_ARTIFACTS
  .filter(({ path: relativePath }) => relativePath !== 'emitter-result.json')
  .map(({ role, path: relativePath }) => ({
    role,
    path: relativePath,
    ...fileReceipt(path.join(runDirectory, relativePath)),
  }));

const processIdFromSessionValue = (value) => Number(
  value?.desktopProcessId ?? value?.value?.desktopProcessId ?? 0,
);

const assertFileHash = (candidate, expectedSha256, subject) => {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new Error(`${subject} disappeared during the overlay authority run`);
  }
  if (sha256File(candidate) !== expectedSha256) {
    throw new Error(`${subject} changed during the overlay authority run`);
  }
};

const assertAuthorityFileMatches = (actual, expected, subject) => {
  if (!actual || !expected
    || !samePath(actual.executablePath, expected.executablePath)
    || actual.sha256 !== expected.sha256
    || Number(actual.byteCount) !== Number(expected.byteCount)
    || actual.productVersion !== expected.productVersion
    || actual.signature?.status !== expected.signature?.status
    || actual.signature?.signerThumbprint !== expected.signature?.signerThumbprint) {
    throw new Error(`${subject} file authority changed during the overlay run`);
  }
};

const revalidatePlanFiles = (plan, inspectFile) => {
  for (const [candidate, sha256, subject] of [
    [plan.desktopExecutable, plan.desktopExecutableSha256, 'release Desktop executable'],
    [plan.targetExecutable, plan.targetExecutableSha256, 'overlay target executable'],
    [plan.runner.path, plan.runner.sha256, 'overlay production runner'],
    [plan.validator.path, plan.validator.sha256, 'overlay production validator'],
    [
      plan.processAuthorityHelper.path,
      plan.processAuthorityHelper.sha256,
      'overlay process authority helper',
    ],
  ]) assertFileHash(candidate, sha256, subject);
  if (!plan.testOnly) {
    assertFileHash(
      plan.tooling.tauriDriver.installReceipt.path,
      plan.tooling.tauriDriver.installReceipt.sha256,
      'tauri-driver cargo install receipt',
    );
  }
  for (const [expected, subject] of [
    [plan.tooling.tauriDriver, 'tauri-driver'],
    [plan.tooling.nativeDriver, 'Microsoft Edge WebDriver'],
    [plan.tooling.webViewRuntime, 'WebView2 runtime'],
  ]) {
    const actual = inspectFile(plan, expected.executablePath);
    assertAuthorityFileMatches(actual, expected, subject);
  }
};

const assertProcessImage = ({ snapshot, processId, expectedFile, subject, parentProcessId }) => {
  if (!snapshot || Number(snapshot.processId) !== Number(processId)
    || !samePath(snapshot.executablePath, expectedFile.executablePath)
    || snapshot.sha256 !== expectedFile.sha256
    || Number(snapshot.byteCount) !== Number(expectedFile.byteCount)) {
    throw new Error(`${subject} PID does not map to the expected executable path/hash`);
  }
  if (parentProcessId !== undefined
    && Number(snapshot.parentProcessId) !== Number(parentProcessId)) {
    throw new Error(`${subject} is not owned by the expected parent process`);
  }
};

const selectOneDescendant = (descendants, expectedPath, subject, expectedProcessId = 0) => {
  const matches = descendants.filter((entry) => samePath(entry?.executablePath, expectedPath));
  if (matches.length !== 1) {
    throw new Error(`${subject} must be exactly one descendant of the launched tauri-driver`);
  }
  if (expectedProcessId && Number(matches[0].processId) !== Number(expectedProcessId)) {
    throw new Error(`${subject} descendant PID does not match the OS authority receipt`);
  }
  return matches[0];
};

const captureLiveProcessAuthority = ({
  plan,
  adapters,
  targetProcessId,
  driverProcessId,
  expectedDesktopProcessId = 0,
}) => {
  const runner = adapters.inspectProcess(plan, process.pid);
  if (Number(runner?.processId) !== process.pid) {
    throw new Error('overlay runner process authority does not match the current Node process');
  }
  const tauriDriver = adapters.inspectProcess(plan, driverProcessId);
  const target = adapters.inspectProcess(plan, targetProcessId);
  assertProcessImage({
    snapshot: tauriDriver,
    processId: driverProcessId,
    expectedFile: plan.tooling.tauriDriver,
    subject: 'tauri-driver',
    parentProcessId: process.pid,
  });
  assertProcessImage({
    snapshot: target,
    processId: targetProcessId,
    expectedFile: {
      executablePath: plan.targetExecutable,
      sha256: plan.targetExecutableSha256,
      byteCount: fs.statSync(plan.targetExecutable).size,
    },
    subject: 'overlay target',
    parentProcessId: process.pid,
  });
  const descendantsValue = adapters.inspectDescendants(plan, driverProcessId);
  const descendants = Array.isArray(descendantsValue) ? descendantsValue : [descendantsValue];
  const nativeDriver = selectOneDescendant(
    descendants,
    plan.tooling.nativeDriver.executablePath,
    'Microsoft Edge WebDriver',
  );
  const desktop = selectOneDescendant(
    descendants,
    plan.desktopExecutable,
    'release Desktop',
    expectedDesktopProcessId,
  );
  assertProcessImage({
    snapshot: nativeDriver,
    processId: nativeDriver.processId,
    expectedFile: plan.tooling.nativeDriver,
    subject: 'Microsoft Edge WebDriver',
  });
  assertProcessImage({
    snapshot: desktop,
    processId: desktop.processId,
    expectedFile: {
      executablePath: plan.desktopExecutable,
      sha256: plan.desktopExecutableSha256,
      byteCount: fs.statSync(plan.desktopExecutable).size,
    },
    subject: 'release Desktop',
  });
  const ids = [
    runner.processId,
    tauriDriver.processId,
    nativeDriver.processId,
    desktop.processId,
    target.processId,
  ].map(Number);
  if (ids.some((value) => !Number.isSafeInteger(value) || value <= 0)
    || new Set(ids).size !== ids.length) {
    throw new Error('runner/tauri-driver/native-driver/Desktop/target PIDs must be real and distinct');
  }
  return {
    runner,
    tauriDriver,
    nativeDriver,
    desktop: { ...desktop, buildCommit: plan.provenance.headCommit },
    target: { ...target, buildCommit: plan.provenance.headCommit },
  };
};

const processAuthorityStable = (before, after) => isDeepStrictEqual(before, after);

const assertProductionPlanAuthority = (plan) => {
  if (plan.testOnly === true) return;
  if (plan[PRODUCTION_PLAN_AUTHORITY] !== true
    || !preparedToolingAuthorities.has(plan.tooling)) {
    throw new Error('overlay production run requires an unforgeable prepared-tooling plan');
  }
  const runtimeVersion = plan.tooling.webViewRuntime.productVersion;
  const canonicalDesktop = resolveReleaseExecutable({
    workspaceRoot: plan.workspaceRoot,
    exists: fs.existsSync,
  });
  if (!canonicalDesktop.found || !samePath(plan.desktopExecutable, canonicalDesktop.path)
    || !samePath(plan.targetExecutable, resolveTargetExecutable(plan.workspaceRoot))
    || !samePath(
      plan.processAuthorityHelper.path,
      authorityHelperPath(plan.workspaceRoot),
    )) {
    throw new Error('overlay Desktop/target/process-helper paths are not canonical current-workspace paths');
  }
  assertToolingPath(
    plan.tooling.tauriDriver.executablePath,
    canonicalTauriDriverPath(plan.workspaceRoot),
    'tauri-driver',
  );
  assertToolingPath(
    plan.tooling.nativeDriver.executablePath,
    canonicalNativeDriverPath(plan.workspaceRoot, runtimeVersion),
    'Microsoft Edge WebDriver',
  );
  if (!samePath(plan.driver.executablePath, plan.tooling.tauriDriver.executablePath)
    || !samePath(plan.driver.nativeDriverPath, plan.tooling.nativeDriver.executablePath)
    || plan.driver.executableSha256 !== plan.tooling.tauriDriver.sha256
    || plan.driver.nativeDriverSha256 !== plan.tooling.nativeDriver.sha256) {
    throw new Error('overlay driver launch arguments do not match prepared canonical tooling');
  }
  assertMicrosoftAuthority(
    plan.tooling.nativeDriver,
    'Microsoft Edge WebDriver',
    NATIVE_DRIVER_EXECUTABLE_NAME,
  );
  assertMicrosoftAuthority(
    plan.tooling.webViewRuntime,
    'installed WebView2 runtime',
    WEBVIEW_RUNTIME_EXECUTABLE_NAME,
  );
  if (plan.tooling.nativeDriver.productVersion !== runtimeVersion
    || plan.tooling.webViewRuntime.runtimeVersion !== runtimeVersion) {
    throw new Error('prepared Microsoft Edge WebDriver does not exactly match WebView2 runtime');
  }
  const receipt = plan.tooling.tauriDriver.installReceipt;
  if (receipt?.packageId
      !== `tauri-driver ${PINNED_TAURI_DRIVER_VERSION} (registry+https://github.com/rust-lang/crates.io-index)`
    || receipt?.versionRequirement !== `=${PINNED_TAURI_DRIVER_VERSION}`
    || !isDeepStrictEqual(receipt?.bins, ['tauri-driver.exe'])
    || receipt?.target !== 'x86_64-pc-windows-msvc') {
    throw new Error('prepared tauri-driver cargo receipt is not the pinned registry package');
  }
};

const defaultAdapters = Object.freeze({
  listRunning: () => runningDesktopProcesses(),
  portInUse: tcpConnects,
  launchTarget: (plan) => spawn(plan.targetExecutable, plan.targetArguments, {
    cwd: path.dirname(plan.targetExecutable),
    env: { ...process.env, OMNI_BUILD_COMMIT: plan.provenance.headCommit },
    stdio: 'ignore',
    windowsHide: false,
  }),
  launchDriver: (plan) => spawn(plan.driver.executablePath, plan.driver.args, {
    cwd: plan.workspaceRoot,
    env: { ...process.env, ...plan.desktopEnvironment },
    stdio: 'ignore',
    windowsHide: true,
  }),
  waitForTargetReady: (plan, child) => waitForJson(
    path.join(plan.runDirectory, 'target-ready.json'),
    Math.min(plan.timeoutMs, 30_000),
    child,
    'overlay target',
  ),
  waitForDriver: (plan, child) => waitForTcp(
    plan.driver.host,
    plan.driver.port,
    Math.min(plan.timeoutMs, 30_000),
    child,
  ),
  request: webDriverRequest,
  terminate: terminateTree,
  inspectFile: (plan, candidate) => inspectWindowsOverlayAuthority({
    helperPath: plan.processAuthorityHelper.path,
    action: 'File',
    literalPath: candidate,
  }),
  inspectProcess: (plan, processId) => inspectWindowsOverlayAuthority({
    helperPath: plan.processAuthorityHelper.path,
    action: 'Process',
    processId,
  }),
  inspectDescendants: (plan, rootProcessId) => inspectWindowsOverlayAuthority({
    helperPath: plan.processAuthorityHelper.path,
    action: 'Descendants',
    rootProcessId,
  }),
  now: () => new Date(),
  currentProvenance: (workspaceRoot) => currentGitProvenance({ cwd: workspaceRoot }),
});

const pushTimeline = (timeline, event, invocationId, now) => {
  timeline.push({
    sequence: timeline.length + 1,
    event,
    invocationId,
    observedAt: now().toISOString(),
  });
};

const assertRawAuthorityReturn = (plan, ready, raw) => {
  if (raw?.collectorId !== OVERLAY_CLICK_THROUGH_COLLECTOR_ID
    || raw?.collectorVersion !== OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION
    || raw?.invocationId !== plan.invocationId
    || String(raw?.sourceHeadCommit ?? '').toLowerCase()
      !== plan.provenance.headCommit.toLowerCase()
    || Number(raw?.targetProcessId) !== Number(ready?.processId)
    || Number(raw?.targetHwnd) !== Number(ready?.hwnd)
    || raw?.passed !== true || raw?.productionMode !== true) {
    throw new Error('Desktop OS authority result does not match the launched target/current build');
  }
  for (const relativePath of [
    'overlay-click-through.png',
    'target-ready.json',
    'target-click.json',
  ]) {
    if (!fs.existsSync(path.join(plan.runDirectory, relativePath))) {
      throw new Error(`Desktop OS authority did not publish ${relativePath}`);
    }
  }
};

export async function runOverlayClickThroughReleaseEvidence({
  plan,
  adapters: overrides = {},
  collectEvidence,
  productionCollectorAuthority,
} = {}) {
  if (!plan) throw new Error('overlay click-through release plan is required');
  if (typeof collectEvidence !== 'function') {
    throw new Error('overlay raw packaging is private; invoke the production release collector entrypoint');
  }
  const productionCollectorAccepted = productionCollectorAuthority === PRODUCTION_COLLECTOR_AUTHORITY;
  const usesTestOverrides = Object.keys(overrides).length > 0 || !productionCollectorAccepted;
  if (usesTestOverrides && (plan.testOnly !== true || plan[TEST_ONLY_SEAM] !== true)) {
    throw new Error('production overlay authority rejects adapter and collector overrides');
  }
  if (plan.testOnly === true && plan[TEST_ONLY_SEAM] !== true) {
    throw new Error('forged overlay test-only plan is rejected');
  }
  assertProductionPlanAuthority(plan);
  const adapters = { ...defaultAdapters, ...overrides };
  const timeline = [];
  let target = null;
  let driver = null;
  let sessionId = '';
  let desktopProcessId = 0;
  let processAuthorityBefore = null;
  let completed = false;
  const startedAt = adapters.now().toISOString();
  pushTimeline(timeline, 'runner-started', plan.invocationId, adapters.now);
  try {
    const running = adapters.listRunning();
    if (running.length > 0) {
      throw new Error(
        `close every existing ${DESKTOP_EXECUTABLE_NAME}; running PIDs: ${running.join(', ')}`,
      );
    }
    if (fs.existsSync(plan.runDirectory)) {
      throw new Error(`overlay authority run directory already exists: ${plan.runDirectory}`);
    }
    if (await adapters.portInUse(plan.driver.host, plan.driver.port)
      || await adapters.portInUse(plan.driver.host, plan.driver.nativePort)) {
      throw new Error('overlay authority driver port is already in use');
    }
    ensureDir(plan.runDirectory);
    revalidatePlanFiles(plan, adapters.inspectFile);
    pushTimeline(timeline, 'release-binaries-verified', plan.invocationId, adapters.now);

    target = adapters.launchTarget(plan);
    if (!Number.isInteger(target?.pid) || target.pid <= 0) {
      throw new Error('failed to launch the real overlay target process');
    }
    pushTimeline(timeline, 'target-started', plan.invocationId, adapters.now);
    const ready = await adapters.waitForTargetReady(plan, target);
    if (Number(ready?.processId) !== target.pid
      || ready?.invocationId !== plan.invocationId
      || ready?.executableSha256 !== plan.targetExecutableSha256
      || !samePath(ready?.executablePath, plan.targetExecutable)) {
      throw new Error('target-ready.json does not match the launched target process/binary');
    }
    pushTimeline(timeline, 'target-ready', plan.invocationId, adapters.now);

    driver = adapters.launchDriver(plan);
    if (!Number.isInteger(driver?.pid) || driver.pid <= 0 || driver.pid === target.pid) {
      throw new Error('failed to launch a distinct tauri-driver process');
    }
    await adapters.waitForDriver(plan, driver);
    pushTimeline(timeline, 'driver-started', plan.invocationId, adapters.now);

    const sessionResponse = await adapters.request(
      buildWebDriverSessionRequest({
        endpoint: plan.driver.endpoint,
        applicationPath: plan.desktopExecutable,
      }),
      plan.timeoutMs,
    );
    sessionId = String(
      sessionResponse?.value?.sessionId ?? sessionResponse?.sessionId ?? '',
    );
    if (!sessionId) throw new Error('tauri-driver returned no WebDriver sessionId');
    await adapters.request(
      {
        method: 'POST',
        url: `${plan.driver.endpoint}/session/${sessionId}/timeouts`,
        body: { script: plan.timeoutMs },
      },
      30_000,
    );
    pushTimeline(timeline, 'webdriver-session-created', plan.invocationId, adapters.now);
    const transcriptStartedAt = adapters.now().toISOString();

    const showRequestedAt = adapters.now().toISOString();
    const show = await invokeDesktop(
      plan,
      sessionId,
      'diagnostics_v2',
      { command: { action: 'overlaySelfCheck' } },
      adapters.request,
    );
    const showReceivedAt = adapters.now().toISOString();
    pushTimeline(timeline, 'overlay-shown', plan.invocationId, adapters.now);
    processAuthorityBefore = captureLiveProcessAuthority({
      plan,
      adapters,
      targetProcessId: target.pid,
      driverProcessId: driver.pid,
    });
    desktopProcessId = Number(processAuthorityBefore.desktop.processId);

    const authorityPayload = {
      targetProcessId: Number(ready.processId),
      targetHwnd: Number(ready.hwnd),
    };
    const authorityRequestedAt = adapters.now().toISOString();
    const authority = await invokeDesktop(
      plan,
      sessionId,
      'collect_overlay_click_through_release_evidence',
      authorityPayload,
      adapters.request,
    );
    const authorityReceivedAt = adapters.now().toISOString();
    const rawProbe = authority.result.value;
    assertRawAuthorityReturn(plan, ready, rawProbe);
    const desktopProcessIdFromProbe = processIdFromSessionValue(rawProbe);
    if (desktopProcessIdFromProbe !== desktopProcessId) {
      throw new Error('Desktop PID from Rust authority does not match the live driver process tree');
    }
    if (!Number.isInteger(desktopProcessId) || desktopProcessId <= 0
      || new Set([
        process.pid,
        driver.pid,
        processAuthorityBefore.nativeDriver.processId,
        target.pid,
        desktopProcessId,
      ]).size !== 5) {
      throw new Error('runner/driver/native-driver/Desktop/target processes must be real and distinct');
    }
    if (rawProbe.desktopBuildCommit !== plan.provenance.headCommit
      || ready.buildCommit !== plan.provenance.headCommit
      || rawProbe.targetReady?.buildCommit !== plan.provenance.headCommit
      || rawProbe.targetClick?.buildCommit !== plan.provenance.headCommit) {
      throw new Error('Desktop/target live receipts do not expose the current compiled build commit');
    }
    const processAuthorityAfter = captureLiveProcessAuthority({
      plan,
      adapters,
      targetProcessId: target.pid,
      driverProcessId: driver.pid,
      expectedDesktopProcessId: desktopProcessId,
    });
    if (!processAuthorityStable(processAuthorityBefore, processAuthorityAfter)) {
      throw new Error('overlay process PID/image authority changed during the live OS probe');
    }
    revalidatePlanFiles(plan, adapters.inspectFile);
    pushTimeline(timeline, 'os-authority-completed', plan.invocationId, adapters.now);

    const observation = {
      result: 'passed',
      operator: plan.observation.operator,
      notes: plan.observation.notes,
      observedAt: adapters.now().toISOString(),
      screenshotSha256: rawProbe.screenshotSha256,
      targetHwnd: Number(rawProbe.targetHwnd),
      overlayHwnd: Number(rawProbe.overlayHwnd),
    };
    const probe = { ...rawProbe, operatorObservation: observation };
    writeJsonExclusive(path.join(plan.runDirectory, 'overlay-click-through-probe.json'), probe);
    pushTimeline(timeline, 'operator-observation-recorded', plan.invocationId, adapters.now);

    const transcript = {
      schemaVersion: OVERLAY_CLICK_THROUGH_SCHEMA_VERSION,
      artifactKind: 'overlay-webdriver-transcript',
      collectorId: OVERLAY_CLICK_THROUGH_COLLECTOR_ID,
      collectorVersion: OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION,
      invocationId: plan.invocationId,
      sourceHeadCommit: plan.provenance.headCommit,
      startedAt: transcriptStartedAt,
      completedAt: adapters.now().toISOString(),
      driverProcessId: driver.pid,
      driverEndpoint: plan.driver.endpoint,
      sessionId,
      scriptTimeoutMs: plan.timeoutMs,
      calls: [
        {
          sequence: 1,
          command: 'diagnostics_v2',
          payload: { command: { action: 'overlaySelfCheck' } },
          requestedAt: showRequestedAt,
          responseReceivedAt: showReceivedAt,
          result: show.result,
        },
        {
          sequence: 2,
          command: 'collect_overlay_click_through_release_evidence',
          payload: authorityPayload,
          requestedAt: authorityRequestedAt,
          responseReceivedAt: authorityReceivedAt,
          result: authority.result,
        },
      ],
    };
    writeJsonExclusive(path.join(plan.runDirectory, 'webdriver-transcript.json'), transcript);
    const finalProvenance = adapters.currentProvenance(plan.workspaceRoot);
    const provenanceFailure = exactGitProvenanceFailure(plan.provenance, finalProvenance, {
      recordedSubject: 'overlay run source provenance',
      currentSubject: 'post-capture checkout',
    });
    if (provenanceFailure) throw new Error(provenanceFailure);
    pushTimeline(timeline, 'raw-artifacts-validated', plan.invocationId, adapters.now);

    const completedAt = adapters.now().toISOString();
    const result = {
      schemaVersion: OVERLAY_CLICK_THROUGH_SCHEMA_VERSION,
      artifactKind: 'overlay-click-through-emitter-result',
      collectorId: OVERLAY_CLICK_THROUGH_COLLECTOR_ID,
      collectorVersion: OVERLAY_CLICK_THROUGH_COLLECTOR_VERSION,
      scenarioId: OVERLAY_CLICK_THROUGH_SCENARIO_ID,
      invocationId: plan.invocationId,
      status: 'completed',
      error: null,
      startedAt,
      completedAt,
      sourceHeadCommit: plan.provenance.headCommit,
      sourceProvenance: plan.provenance,
      testOnly: plan.testOnly === true,
      runnerProcessId: process.pid,
      driverProcessId: driver.pid,
      nativeDriverProcessId: Number(processAuthorityBefore.nativeDriver.processId),
      desktopProcessId,
      targetProcessId: target.pid,
      sessionId,
      scriptTimeoutMs: plan.timeoutMs,
      driverEndpoint: plan.driver.endpoint,
      desktopExecutable: plan.desktopExecutable,
      desktopExecutableSha256: plan.desktopExecutableSha256,
      targetExecutable: plan.targetExecutable,
      targetExecutableSha256: plan.targetExecutableSha256,
      runner: plan.runner,
      validator: plan.validator,
      processAuthorityHelper: plan.processAuthorityHelper,
      tooling: plan.tooling,
      processAuthority: {
        capturedBeforeOsAuthority: processAuthorityBefore,
        capturedAfterOsAuthority: processAuthorityAfter,
      },
      timeline,
      artifacts: payloadReceipts(plan.runDirectory),
    };
    writeJsonExclusive(path.join(plan.runDirectory, 'emitter-result.json'), result);
    const checked = assertOverlayClickThroughEvidence(plan.runDirectory, {
      workspaceRoot: plan.workspaceRoot,
      currentProvenance: plan.provenance,
      now: adapters.now(),
      allowTestOnly: plan.testOnly === true,
    });
    const collected = await collectEvidence({
      source: plan.runDirectory,
      scenarioId: OVERLAY_CLICK_THROUGH_SCENARIO_ID,
      outputRoot: plan.collectorOutputRoot,
      workspaceRoot: plan.workspaceRoot,
      provenance: plan.provenance,
      now: adapters.now(),
    });
    completed = true;
    return {
      scenarioId: OVERLAY_CLICK_THROUGH_SCENARIO_ID,
      invocationId: plan.invocationId,
      rawDirectory: plan.runDirectory,
      desktopProcessId,
      targetProcessId: target.pid,
      screenshotSha256: checked.summary.screenshotSha256,
      operator: checked.summary.operator,
      packageDirectory: collected.packageDirectory,
      manifestPath: collected.manifestPath,
    };
  } finally {
    if (sessionId) {
      try {
        await adapters.request(
          buildSessionTeardownRequest({ endpoint: plan.driver.endpoint, sessionId }),
          30_000,
        );
      } catch {
        // Targeted process-tree teardown below remains authoritative.
      }
    }
    adapters.terminate(driver);
    adapters.terminate(target);
    if (!completed && fs.existsSync(plan.runDirectory)) {
      fs.rmSync(plan.runDirectory, { recursive: true, force: true });
    }
  }
}

export const runOverlayClickThroughReleaseEvidenceFromProductionCollector = (options = {}) => (
  runOverlayClickThroughReleaseEvidence({
    ...options,
    productionCollectorAuthority: PRODUCTION_COLLECTOR_AUTHORITY,
  })
);

if (isMain(import.meta.url)) {
  setImmediate(async () => {
    try {
      if (process.platform !== 'win32' || process.arch !== 'x64') {
        throw new Error('overlay click-through release evidence requires Windows x64');
      }
      const args = parseOverlayClickThroughReleaseArgs(process.argv.slice(2));
      const { collectOverlayReleaseManualEvidence } = await import('./release-manual-collector.mjs');
      const result = await collectOverlayReleaseManualEvidence({
        scenarioId: OVERLAY_CLICK_THROUGH_SCENARIO_ID,
        ...args,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  });
}
