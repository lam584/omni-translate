import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  compactTimestamp,
  ensureDir,
  isMain,
  parseCliArgs,
  readJson,
  repoRoot,
  writeJson,
} from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  absentInstallStateIssues,
  assertCleanInstallReleaseProvenance,
  canonicalSignedPackagePaths,
  hashJsonAuthority,
  healthyInstallStateIssues,
  implementationAuthority,
  inspectCanonicalInstallReleasePackage,
  INSTALL_RELEASE_COLLECTOR_ID,
  INSTALL_RELEASE_COLLECTOR_VERSION,
  INSTALL_RELEASE_EVIDENCE_SCHEMA_VERSION,
  INSTALL_RELEASE_SCENARIO_ACTIONS,
  INSTALL_RELEASE_SCENARIOS,
  sha256File,
  validateInstallReleaseEvidencePayload,
} from './install-release-evidence.mjs';

const DEFAULT_OUTPUT_ROOT = 'artifacts/testing/install-release-evidence';
const DEFAULT_COLLECTOR_OUTPUT_ROOT = 'artifacts/testing/release-manual-collector';
const DEFAULT_RUNTIME_ROOT = 'artifacts/testing/install-release-runtime';
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const STATE_COLLECTOR = 'scripts/testing/collect-install-release-state.ps1';

const portable = (value) => String(value).split(path.sep).join('/');

const packageInventoryEntry = (packageAuthority, relativePath) => {
  const entry = packageAuthority.inventory.find((candidate) => candidate.path === relativePath);
  if (!entry) throw new Error(`canonical package inventory is missing ${relativePath}`);
  return entry;
};

const readCurrentVersion = (workspaceRoot) => readJson(path.join(workspaceRoot, 'package.json')).version;

export function isInstallReleaseAdministrator({ run = spawnSync } = {}) {
  const probe = [
    '$identity=[Security.Principal.WindowsIdentity]::GetCurrent();',
    '$principal=New-Object Security.Principal.WindowsPrincipal($identity);',
    '$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  ].join('');
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return !result.error
    && result.status === 0
    && String(result.stdout ?? '').trim().toLowerCase() === 'true';
}

export function parseInstallReleaseEvidenceArgs(argv) {
  return parseCliArgs(argv, {
    defaults: {
      scenarioId: '',
      previousVersion: '',
      outputRoot: DEFAULT_OUTPUT_ROOT,
      collectorOutputRoot: DEFAULT_COLLECTOR_OUTPUT_ROOT,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  });
}

export function buildInstallReleaseEvidencePlan({
  scenarioId,
  previousVersion = '',
  outputRoot = DEFAULT_OUTPUT_ROOT,
  collectorOutputRoot = DEFAULT_COLLECTOR_OUTPUT_ROOT,
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  now = new Date(),
  suffix = crypto.randomUUID().slice(0, 8),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  source,
  packageRoot,
  dryRun,
  simulated,
  skip,
} = {}) {
  if ([source, packageRoot, dryRun, simulated, skip].some((value) => value !== undefined)) {
    throw new Error('install release production emitter does not accept source/package-root/dry-run/simulated/skip overrides');
  }
  if (!INSTALL_RELEASE_SCENARIOS.includes(scenarioId)) {
    throw new Error(`--scenario-id must be one of: ${INSTALL_RELEASE_SCENARIOS.join(', ')}`);
  }
  assertCleanInstallReleaseProvenance(provenance);
  const version = readCurrentVersion(workspaceRoot);
  if (scenarioId === 'INSTALL-UPGRADE' && !String(previousVersion).trim()) {
    throw new Error('INSTALL-UPGRADE requires --previous-version');
  }
  if (scenarioId !== 'INSTALL-UPGRADE' && String(previousVersion).trim()) {
    throw new Error('--previous-version is accepted only for INSTALL-UPGRADE');
  }
  const parsedTimeout = Number(timeoutMs);
  if (!Number.isInteger(parsedTimeout) || parsedTimeout < 60_000 || parsedTimeout > 3_600_000) {
    throw new Error('--timeout-ms must be an integer between 60000 and 3600000');
  }
  const runDirectory = path.resolve(
    workspaceRoot,
    outputRoot,
    provenance.headCommit.slice(0, 12),
    `${compactTimestamp(now)}-${scenarioId.toLowerCase()}-${suffix}`,
  );
  const collectorBase = path.resolve(workspaceRoot, collectorOutputRoot);
  if (collectorBase === runDirectory || collectorBase.startsWith(`${runDirectory}${path.sep}`)) {
    throw new Error('collector output root may not be inside the install release raw run directory');
  }
  return {
    scenarioId,
    action: INSTALL_RELEASE_SCENARIO_ACTIONS[scenarioId],
    workspaceRoot: path.resolve(workspaceRoot),
    provenance,
    version,
    previousVersion: String(previousVersion).trim() || null,
    packagePaths: canonicalSignedPackagePaths({ workspaceRoot, version }),
    previousPackagePaths: previousVersion
      ? canonicalSignedPackagePaths({ workspaceRoot, version: String(previousVersion).trim() })
      : null,
    runDirectory,
    collectorOutputRoot: collectorBase,
    runtimeRoot: path.resolve(workspaceRoot, DEFAULT_RUNTIME_ROOT),
    timeoutMs: parsedTimeout,
    now,
    operationId: crypto.randomUUID(),
  };
}

const runPowerShellCollector = ({
  plan,
  mode,
  packageRoot,
  outputPath,
  evidenceOutputDirectory = '',
  run = spawnSync,
}) => {
  const collectorPath = path.resolve(plan.workspaceRoot, STATE_COLLECTOR);
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', collectorPath,
    '-Mode', mode,
    '-WorkspaceRoot', packageRoot,
    '-RuntimeRoot', plan.runtimeRoot,
    '-OutputPath', outputPath,
  ];
  if (evidenceOutputDirectory) args.push('-EvidenceOutputDirectory', evidenceOutputDirectory);
  const result = run('powershell.exe', args, {
    cwd: plan.workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: plan.timeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`install release ${mode} collector failed (${result.status}): ${result.stderr ?? result.stdout ?? ''}`);
  }
  if (!fs.existsSync(outputPath)) throw new Error(`install release ${mode} collector did not write ${outputPath}`);
  return readJson(outputPath);
};

export const captureInstallPackageSignatures = ({ plan, packageRoot, outputPath, run }) => (
  runPowerShellCollector({ plan, mode: 'signatures', packageRoot, outputPath, run })
);

export const captureInstallSystemState = ({ plan, packageRoot, outputPath, run }) => (
  runPowerShellCollector({ plan, mode: 'system', packageRoot, outputPath, run })
);

export const captureInstallHealth = ({
  plan,
  packageRoot,
  outputPath,
  evidenceOutputDirectory,
  run,
}) => runPowerShellCollector({
  plan,
  mode: 'health',
  packageRoot,
  outputPath,
  evidenceOutputDirectory,
  run,
});

export function invokeProductionElevatedInstallOperation({
  plan,
  packageAuthority,
  outputPath,
  run = spawnSync,
}) {
  const requestScript = path.join(
    plan.packagePaths.packageRoot,
    'scripts',
    'installer',
    'request-elevated-driver-operation.ps1',
  );
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', requestScript,
    '-Action', plan.action,
    '-OperationId', plan.operationId,
    '-ResultPath', outputPath,
    '-WorkspaceRoot', plan.packagePaths.packageRoot,
    '-RuntimeRoot', plan.runtimeRoot,
    '-InstallChannel', 'release',
    '-DriverVersion', packageAuthority.driverVersion,
    '-BridgeVersion', packageAuthority.bridgeVersion,
    '-TargetDeviceId', 'virtual-mic-default',
    '-VirtualRenderDeviceId', 'omni-virtual-speaker-default',
  ];
  const result = run('powershell.exe', args, {
    cwd: plan.workspaceRoot,
    encoding: 'utf8',
    windowsHide: false,
    timeout: plan.timeoutMs,
  });
  if (result.error) throw result.error;
  if (!fs.existsSync(outputPath)) {
    throw new Error(`production elevated operation did not write ${outputPath}; exit=${result.status}`);
  }
  return readJson(outputPath);
}

const preconditionIssues = ({ scenarioId, beforeState, packageAuthority, previousPackageAuthority }) => {
  if (scenarioId === 'INSTALL-FRESH') {
    return absentInstallStateIssues(beforeState, 'fresh before-state');
  }
  if (scenarioId === 'INSTALL-UPGRADE') {
    return previousPackageAuthority
      ? healthyInstallStateIssues(beforeState, previousPackageAuthority, 'upgrade before-state')
      : ['upgrade previous package authority is missing'];
  }
  return healthyInstallStateIssues(beforeState, packageAuthority, `${scenarioId.toLowerCase()} before-state`);
};

const normalizeHealthEvidencePaths = (health, runDirectory) => {
  const normalized = structuredClone(health);
  const raw = normalized?.rawEvidence;
  if (!raw) return normalized;
  for (const field of ['captureProbePath', 'runtimeSnapshotPath', 'captureWavPath']) {
    const candidate = path.resolve(String(raw[field] ?? ''));
    const relative = path.relative(runDirectory, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`health raw evidence escapes the install run directory: ${candidate}`);
    }
    raw[field] = portable(relative);
  }
  return normalized;
};

const operationAuthority = ({ plan, packageAuthority, operationResult, beforeState, afterState, healthProbe }) => ({
  action: plan.action,
  operationId: plan.operationId,
  requestScript: 'scripts/installer/request-elevated-driver-operation.ps1',
  requestScriptSha256: packageInventoryEntry(
    packageAuthority,
    'scripts/installer/request-elevated-driver-operation.ps1',
  ).sha256,
  invokeScriptSha256: packageInventoryEntry(
    packageAuthority,
    'scripts/installer/invoke-elevated-driver-operation.ps1',
  ).sha256,
  operationScriptSha256: packageInventoryEntry(
    packageAuthority,
    plan.action === 'uninstall'
      ? 'scripts/installer/uninstall-development-driver.ps1'
      : plan.action === 'reinstall'
        ? 'scripts/installer/repair-driver.ps1'
        : 'scripts/installer/install-development-driver.ps1',
  ).sha256,
  installChannel: 'release',
  elevatedProductionRequest: true,
  resultSha256: hashJsonAuthority(operationResult),
  operationLogSha256: operationResult.logSha256,
  beforeStateSha256: hashJsonAuthority(beforeState),
  afterStateSha256: hashJsonAuthority(afterState),
  healthProbeSha256: healthProbe ? hashJsonAuthority(healthProbe) : null,
});

const buildAuthority = ({
  plan,
  packageAuthority,
  signatureInventory,
  previousPackageAuthority,
  previousSignatureInventory,
  operationResult,
  beforeState,
  afterState,
  healthProbe,
}) => ({
  schemaVersion: INSTALL_RELEASE_EVIDENCE_SCHEMA_VERSION,
  artifactKind: 'omni-install-release-run-authority',
  collectorId: INSTALL_RELEASE_COLLECTOR_ID,
  collectorVersion: INSTALL_RELEASE_COLLECTOR_VERSION,
  scenarioId: plan.scenarioId,
  generatedAt: plan.now.toISOString(),
  provenance: plan.provenance,
  implementation: implementationAuthority(plan.workspaceRoot),
  packageAuthoritySha256: hashJsonAuthority(packageAuthority),
  signatureInventorySha256: hashJsonAuthority(signatureInventory),
  previousPackageAuthoritySha256: previousPackageAuthority
    ? hashJsonAuthority(previousPackageAuthority)
    : null,
  previousSignatureInventorySha256: previousSignatureInventory
    ? hashJsonAuthority(previousSignatureInventory)
    : null,
  operation: plan.action ? operationAuthority({
    plan,
    packageAuthority,
    operationResult,
    beforeState,
    afterState,
    healthProbe,
  }) : null,
});

const assertNoValidationIssues = (issues) => {
  if (issues.length > 0) throw new Error(`install release evidence failed authority validation:\n- ${issues.join('\n- ')}`);
};

export async function runInstallReleaseEvidence({
  plan,
  captureSignatures = captureInstallPackageSignatures,
  captureState = captureInstallSystemState,
  captureHealth = captureInstallHealth,
  invokeOperation = invokeProductionElevatedInstallOperation,
  inspectPackage = inspectCanonicalInstallReleasePackage,
} = {}) {
  if (!plan) throw new Error('install release evidence plan is required');
  if (fs.existsSync(plan.runDirectory)) throw new Error(`install release run directory already exists: ${plan.runDirectory}`);
  ensureDir(plan.runDirectory);
  ensureDir(plan.runtimeRoot);

  const signaturePath = path.join(plan.runDirectory, 'signature-inventory.json');
  const signatures = await captureSignatures({
    plan,
    packageRoot: plan.packagePaths.packageRoot,
    outputPath: signaturePath,
  });
  if (!fs.existsSync(signaturePath)) writeJson(signaturePath, signatures);
  const packageAuthority = inspectPackage({
    workspaceRoot: plan.workspaceRoot,
    version: plan.version,
    packageRoot: plan.packagePaths.packageRoot,
    signatureInventory: signatures,
    expectedProvenance: plan.provenance,
    now: plan.now,
  });
  writeJson(path.join(plan.runDirectory, 'package-authority.json'), packageAuthority);

  let previousPackageAuthority = null;
  let previousSignatures = null;
  if (plan.previousPackagePaths) {
    const previousSignaturePath = path.join(plan.runDirectory, 'previous-signature-inventory.json');
    previousSignatures = await captureSignatures({
      plan,
      packageRoot: plan.previousPackagePaths.packageRoot,
      outputPath: previousSignaturePath,
    });
    if (!fs.existsSync(previousSignaturePath)) writeJson(previousSignaturePath, previousSignatures);
    previousPackageAuthority = inspectPackage({
      workspaceRoot: plan.workspaceRoot,
      version: plan.previousVersion,
      packageRoot: plan.previousPackagePaths.packageRoot,
      signatureInventory: previousSignatures,
      expectedProvenance: plan.provenance,
      allowHistoricalProvenance: true,
      now: plan.now,
    });
    writeJson(path.join(plan.runDirectory, 'previous-package-authority.json'), previousPackageAuthority);
  }

  if (plan.scenarioId === 'INSTALL-RELEASE-LAYOUT') {
    const authority = buildAuthority({ plan, packageAuthority, signatureInventory: signatures });
    const currentImplementationAuthority = implementationAuthority(plan.workspaceRoot);
    assertNoValidationIssues(validateInstallReleaseEvidencePayload({
      scenarioId: plan.scenarioId,
      authority,
      packageAuthority,
      signatureInventory: signatures,
      currentPackageAuthority: packageAuthority,
      currentProvenance: plan.provenance,
      currentImplementationAuthority,
    }));
    const authorityPath = writeJson(path.join(plan.runDirectory, 'authority.json'), authority);
    return { scenarioId: plan.scenarioId, runDirectory: plan.runDirectory, authorityPath };
  }

  const beforePath = path.join(plan.runDirectory, 'before-state.json');
  const beforeState = await captureState({
    plan,
    packageRoot: plan.packagePaths.packageRoot,
    outputPath: beforePath,
  });
  if (!fs.existsSync(beforePath)) writeJson(beforePath, beforeState);
  assertNoValidationIssues(preconditionIssues({
    scenarioId: plan.scenarioId,
    beforeState,
    packageAuthority,
    previousPackageAuthority,
  }));

  const operationPath = path.join(plan.runDirectory, 'operation-result.json');
  const rawOperationResult = await invokeOperation({ plan, packageAuthority, outputPath: operationPath });
  if (!fs.existsSync(operationPath)) writeJson(operationPath, rawOperationResult);
  if (
    rawOperationResult?.operationId !== plan.operationId
    || rawOperationResult?.action !== plan.action
    || rawOperationResult?.succeeded !== true
    || rawOperationResult?.phase !== 'completed'
    || rawOperationResult?.errorCode != null
  ) {
    throw new Error(
      `production elevated ${plan.action} failed: ${rawOperationResult?.errorCode ?? rawOperationResult?.summary ?? 'unknown failure'}`,
    );
  }
  const operationLogPath = path.join(plan.runDirectory, 'operation-result.log');
  if (
    path.resolve(String(rawOperationResult?.logPath ?? '')) !== path.resolve(operationLogPath)
    || !fs.existsSync(operationLogPath)
    || !fs.statSync(operationLogPath).isFile()
    || fs.statSync(operationLogPath).size <= 0
  ) throw new Error('production elevated operation did not emit its owned operation-result.log');
  const operationResult = {
    ...rawOperationResult,
    logPath: 'operation-result.log',
    logSha256: sha256File(operationLogPath),
  };
  writeJson(operationPath, operationResult);

  let healthProbe = null;
  if (plan.scenarioId !== 'INSTALL-UNINSTALL') {
    const healthPath = path.join(plan.runDirectory, 'health-probe.json');
    const evidenceOutputDirectory = ensureDir(path.join(plan.runDirectory, 'health-artifacts'));
    healthProbe = normalizeHealthEvidencePaths(await captureHealth({
      plan,
      packageRoot: plan.packagePaths.packageRoot,
      outputPath: healthPath,
      evidenceOutputDirectory,
    }), plan.runDirectory);
    writeJson(healthPath, healthProbe);
  }
  // Capture the authoritative after-state last so a Bridge/probe process leak
  // created by health validation cannot be hidden by an earlier snapshot.
  const afterPath = path.join(plan.runDirectory, 'after-state.json');
  const afterState = await captureState({
    plan,
    packageRoot: plan.packagePaths.packageRoot,
    outputPath: afterPath,
  });
  if (!fs.existsSync(afterPath)) writeJson(afterPath, afterState);

  const authority = buildAuthority({
    plan,
    packageAuthority,
    signatureInventory: signatures,
    previousPackageAuthority,
    previousSignatureInventory: previousSignatures,
    operationResult,
    beforeState,
    afterState,
    healthProbe,
  });
  const currentImplementationAuthority = implementationAuthority(plan.workspaceRoot);
  assertNoValidationIssues(validateInstallReleaseEvidencePayload({
    scenarioId: plan.scenarioId,
    authority,
    packageAuthority,
    signatureInventory: signatures,
    currentPackageAuthority: packageAuthority,
    previousPackageAuthority,
    previousSignatureInventory: previousSignatures,
    currentPreviousPackageAuthority: previousPackageAuthority,
    beforeState,
    operationResult,
    afterState,
    healthProbe,
    currentProvenance: plan.provenance,
    currentImplementationAuthority,
    evidenceRoot: plan.runDirectory,
  }));
  const authorityPath = writeJson(path.join(plan.runDirectory, 'authority.json'), authority);
  return {
    scenarioId: plan.scenarioId,
    runDirectory: plan.runDirectory,
    authorityPath,
    operationId: plan.operationId,
  };
}

export async function runInstallReleaseEvidenceAndCollect({
  plan,
  collectEvidence,
  ...runnerDependencies
} = {}) {
  if (typeof collectEvidence !== 'function') {
    throw new Error('install raw packaging is private; invoke the canonical production runner entrypoint');
  }
  const raw = await runInstallReleaseEvidence({ plan, ...runnerDependencies });
  try {
    const collected = await collectEvidence({
      source: raw.runDirectory,
      scenarioId: raw.scenarioId,
      outputRoot: plan.collectorOutputRoot,
      workspaceRoot: plan.workspaceRoot,
      provenance: plan.provenance,
      now: plan.now,
    });
    return {
      ...raw,
      rawDirectory: raw.runDirectory,
      packageDirectory: collected.packageDirectory,
      manifestPath: collected.manifestPath,
    };
  } catch (error) {
    fs.rmSync(raw.runDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (isMain(import.meta.url)) {
  setImmediate(async () => {
    try {
      if (process.platform !== 'win32' || process.arch !== 'x64') {
        throw new Error('install release evidence requires Windows x64 and real release packages');
      }
      const args = parseInstallReleaseEvidenceArgs(process.argv.slice(2));
      if (
        args.scenarioId !== 'INSTALL-RELEASE-LAYOUT'
        && !isInstallReleaseAdministrator()
      ) {
        throw new Error(
          'mutating install release evidence must be launched through '
          + 'scripts/testing/request-elevated-install-release-evidence.ps1',
        );
      }
      const { collectInstallReleaseManualEvidence } = await import(
        './release-manual-collector.mjs'
      );
      const result = await collectInstallReleaseManualEvidence(args);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  });
}
