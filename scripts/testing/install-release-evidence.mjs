import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readJson, repoRoot } from '../lib/testing-common.mjs';
import { bundleName } from '../lib/release-common.mjs';
import {
  exactGitProvenanceFailure,
  gitProvenanceShapeFailure,
} from './git-provenance.mjs';
import { validateVirtualMicCaptureArtifacts } from './virtual-mic-fingerprint-authority.mjs';

export const INSTALL_RELEASE_EVIDENCE_SCHEMA_VERSION = 1;
export const INSTALL_RELEASE_COLLECTOR_ID = 'omni.release.install-authority';
export const INSTALL_RELEASE_COLLECTOR_VERSION = '1.0.0';
export const INSTALL_RELEASE_PROTOCOL_VERSION = '2026-08-27-audio-routing-v8';
export const INSTALL_RELEASE_SCENARIOS = Object.freeze([
  'INSTALL-FRESH',
  'INSTALL-REPAIR',
  'INSTALL-UNINSTALL',
  'INSTALL-UPGRADE',
  'INSTALL-RELEASE-LAYOUT',
]);

export const INSTALL_RELEASE_SCENARIO_ACTIONS = Object.freeze({
  'INSTALL-FRESH': 'install',
  'INSTALL-REPAIR': 'reinstall',
  'INSTALL-UNINSTALL': 'uninstall',
  'INSTALL-UPGRADE': 'install',
  'INSTALL-RELEASE-LAYOUT': null,
});

const artifact = (role, artifactPath, kind = 'file') => Object.freeze({ role, path: artifactPath, kind });
const COMMON_INSTALL_ARTIFACTS = Object.freeze([
  artifact('signature-inventory', 'signature-inventory.json'),
  artifact('package-authority', 'package-authority.json'),
  artifact('runner-authority', 'authority.json'),
]);
const MUTATING_INSTALL_ARTIFACTS = Object.freeze([
  artifact('before-system-state', 'before-state.json'),
  artifact('elevated-operation-result', 'operation-result.json'),
  artifact('elevated-operation-log', 'operation-result.log'),
  artifact('after-system-state', 'after-state.json'),
]);
const INSTALL_HEALTH_ARTIFACTS = Object.freeze([
  artifact('install-health-probe', 'health-probe.json'),
  artifact('install-health-raw', 'health-artifacts', 'directory'),
]);

export const INSTALL_RELEASE_ARTIFACTS_BY_SCENARIO = Object.freeze({
  'INSTALL-FRESH': Object.freeze([
    ...COMMON_INSTALL_ARTIFACTS,
    ...MUTATING_INSTALL_ARTIFACTS,
    ...INSTALL_HEALTH_ARTIFACTS,
  ]),
  'INSTALL-REPAIR': Object.freeze([
    ...COMMON_INSTALL_ARTIFACTS,
    ...MUTATING_INSTALL_ARTIFACTS,
    ...INSTALL_HEALTH_ARTIFACTS,
  ]),
  'INSTALL-UNINSTALL': Object.freeze([
    ...COMMON_INSTALL_ARTIFACTS,
    ...MUTATING_INSTALL_ARTIFACTS,
  ]),
  'INSTALL-UPGRADE': Object.freeze([
    ...COMMON_INSTALL_ARTIFACTS,
    artifact('previous-signature-inventory', 'previous-signature-inventory.json'),
    artifact('previous-package-authority', 'previous-package-authority.json'),
    ...MUTATING_INSTALL_ARTIFACTS,
    ...INSTALL_HEALTH_ARTIFACTS,
  ]),
  'INSTALL-RELEASE-LAYOUT': COMMON_INSTALL_ARTIFACTS,
});

export const INSTALL_RELEASE_REQUIRED_IMPLEMENTATION_FILES = Object.freeze([
  'scripts/testing/request-elevated-install-release-evidence.ps1',
  'scripts/testing/run-install-release-evidence.mjs',
  'scripts/testing/install-release-evidence.mjs',
  'scripts/testing/collect-install-release-state.ps1',
  'scripts/testing/powershell-script-authority.ps1',
  'scripts/testing/virtual-mic-capture-authority.ps1',
  'scripts/testing/virtual-mic-fingerprint-authority.mjs',
]);

const REQUIRED_PACKAGE_FILES = Object.freeze([
  'release-package.json',
  'release-manifest.json',
  'installer-layout.json',
  'bridge-service-native/omni-bridge-service.exe',
  'bridge-service-native/omni-driver-audio-probe.exe',
  'bridge-service-native/omni-virtual-mic-target-capture.exe',
  'desktop/omni-desktop-shell.exe',
  'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf',
  'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
  'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat',
  'drivers/windows-virtual-mic/package/driver-package.json',
  'scripts/installer/request-elevated-driver-operation.ps1',
  'scripts/installer/invoke-elevated-driver-operation.ps1',
  'scripts/installer/driver-operation-common.ps1',
  'scripts/installer/install-development-driver.ps1',
  'scripts/installer/uninstall-development-driver.ps1',
  'scripts/installer/repair-driver.ps1',
  'scripts/installer/probe-development-driver.ps1',
  'scripts/installer/test-development-driver.ps1',
  'scripts/installer/virtual-speaker-device.ps1',
  'scripts/installer/stop-stale-bridge-service.ps1',
]);

const SIGNABLE_EXTENSIONS = new Set(['.exe', '.dll', '.sys', '.cat', '.ps1']);
const RELEASE_BUILD_BINARY_CONTRACT = Object.freeze([
  Object.freeze({ role: 'desktop-shell', path: 'desktop/omni-desktop-shell.exe', verification: 'embedded-commit' }),
  Object.freeze({ role: 'native-bridge', path: 'bridge-service-native/omni-bridge-service.exe', verification: '--build-commit' }),
  Object.freeze({ role: 'audio-probe', path: 'bridge-service-native/omni-driver-audio-probe.exe', verification: '--build-commit' }),
  Object.freeze({ role: 'virtual-mic-target-capture', path: 'bridge-service-native/omni-virtual-mic-target-capture.exe', verification: '--build-commit' }),
]);

const portable = (value) => String(value).split(path.sep).join('/');
const normalizedPathIdentity = (candidate) => {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export const sha256File = (candidate) => crypto
  .createHash('sha256')
  .update(fs.readFileSync(candidate))
  .digest('hex');

const sha256Json = (value) => crypto
  .createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');

const requireFile = (candidate, label) => {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile() || fs.statSync(candidate).size <= 0) {
    throw new Error(`${label} is missing or empty: ${candidate}`);
  }
  return candidate;
};

const walkFiles = (root, current = root) => fs
  .readdirSync(current, { withFileTypes: true })
  .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  .flatMap((entry) => {
    const fullPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`release package must not contain symbolic links: ${fullPath}`);
    }
    if (entry.isDirectory()) return walkFiles(root, fullPath);
    if (!entry.isFile()) throw new Error(`release package contains an unsupported entry: ${fullPath}`);
    return [{
      path: portable(path.relative(root, fullPath)),
      bytes: fs.statSync(fullPath).size,
      sha256: sha256File(fullPath),
    }];
  });

const fileAuthority = (candidate, workspaceRoot) => ({
  path: portable(path.relative(workspaceRoot, candidate)),
  bytes: fs.statSync(candidate).size,
  sha256: sha256File(candidate),
});

export const canonicalSignedPackagePaths = ({ workspaceRoot = repoRoot, version }) => {
  if (typeof version !== 'string' || !version.trim()) throw new Error('release package version is required');
  const bundle = bundleName(version.trim());
  const releaseRoot = path.resolve(workspaceRoot, 'artifacts', 'release', version.trim());
  return {
    version: version.trim(),
    bundle,
    releaseRoot,
    packageRoot: path.join(releaseRoot, 'packages', 'signed', bundle),
    packageZip: path.join(releaseRoot, 'packages', 'signed', `${bundle}.zip`),
    releaseManifestPath: path.join(releaseRoot, 'release-manifest.json'),
    signedChecksumsPath: path.join(releaseRoot, 'signed-checksums.sha256.json'),
    signingManifestPath: path.join(releaseRoot, 'signing', 'signing-manifest.json'),
  };
};

export function parseInfDriverVersion(infText) {
  const match = String(infText).match(/^\s*DriverVer\s*=\s*[^,]+,\s*([0-9]+(?:\.[0-9]+){1,3})\s*$/im);
  if (!match) throw new Error('driver INF has no valid DriverVer');
  return match[1];
}

const exactInventoryFailure = (actual, recorded, label) => {
  if (!Array.isArray(recorded) || recorded.length !== actual.length) {
    return `${label} file count does not match the canonical package`;
  }
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index];
    const right = recorded[index];
    if (
      right?.path !== left.path
      || Number(right?.bytes) !== left.bytes
      || right?.sha256 !== left.sha256
    ) return `${label} entry ${index} does not match ${left.path}`;
  }
  return null;
};

const signatureMap = (signatureInventory) => new Map(
  (Array.isArray(signatureInventory?.signatures) ? signatureInventory.signatures : [])
    .map((entry) => [portable(entry?.path ?? ''), entry]),
);

const compareStringSets = (left, right) => (
  left.length === right.length && left.every((entry, index) => entry === right[index])
);

/**
 * Rebuilds package authority from the fixed signed release directory. The
 * caller may supply only signature observations emitted by the read-only
 * production PowerShell collector; all hashes and manifests are read here.
 */
export function inspectCanonicalInstallReleasePackage({
  workspaceRoot = repoRoot,
  version,
  packageRoot,
  signatureInventory,
  expectedProvenance,
  allowHistoricalProvenance = false,
  now = new Date(),
} = {}) {
  const paths = canonicalSignedPackagePaths({ workspaceRoot, version });
  const resolvedPackageRoot = path.resolve(packageRoot ?? paths.packageRoot);
  if (normalizedPathIdentity(resolvedPackageRoot) !== normalizedPathIdentity(paths.packageRoot)) {
    throw new Error(`install release authority must use canonical signed package ${paths.packageRoot}`);
  }
  if (!fs.existsSync(resolvedPackageRoot) || !fs.statSync(resolvedPackageRoot).isDirectory()) {
    throw new Error(`canonical signed package is missing: ${resolvedPackageRoot}`);
  }
  for (const [candidate, label] of [
    [paths.packageZip, 'signed release zip'],
    [paths.releaseManifestPath, 'release manifest'],
    [paths.signedChecksumsPath, 'signed checksum manifest'],
    [paths.signingManifestPath, 'signing manifest'],
  ]) requireFile(candidate, label);
  for (const relativePath of REQUIRED_PACKAGE_FILES) {
    requireFile(path.join(resolvedPackageRoot, relativePath), `signed package ${relativePath}`);
  }
  const developmentCertificate = path.join(
    resolvedPackageRoot,
    'drivers/windows-virtual-mic/package/omni-translate-development-driver.cer',
  );
  if (fs.existsSync(developmentCertificate)) {
    throw new Error('stable signed package contains the development driver trust certificate');
  }

  const inventory = walkFiles(resolvedPackageRoot);
  const releaseManifest = readJson(paths.releaseManifestPath);
  const signedChecksums = readJson(paths.signedChecksumsPath);
  const signingManifest = readJson(paths.signingManifestPath);
  const releasePackage = readJson(path.join(resolvedPackageRoot, 'release-package.json'));
  const packagedReleaseManifest = readJson(path.join(resolvedPackageRoot, 'release-manifest.json'));
  const layout = readJson(path.join(resolvedPackageRoot, 'installer-layout.json'));
  const driverMetadata = readJson(path.join(
    resolvedPackageRoot,
    'drivers/windows-virtual-mic/package/driver-package.json',
  ));
  const infPath = path.join(
    resolvedPackageRoot,
    'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf',
  );
  const driverVersion = parseInfDriverVersion(fs.readFileSync(infPath, 'utf8'));
  const expectedPackageBaseName = bundleName(paths.version);
  const packageSourceProvenance = releaseManifest?.sourceProvenance;
  const packageProvenanceFailure = allowHistoricalProvenance
    ? gitProvenanceShapeFailure(packageSourceProvenance, 'historical release package provenance')
    : exactGitProvenanceFailure(packageSourceProvenance, expectedProvenance, {
      recordedSubject: 'release package provenance',
      currentSubject: 'install runner provenance',
    });
  if (packageProvenanceFailure) {
    throw new Error(packageProvenanceFailure);
  }
  for (const [subject, metadata] of [
    ['release manifest', releaseManifest],
    ['packaged release manifest', packagedReleaseManifest],
    ['release package metadata', releasePackage],
    ['installer layout metadata', layout],
    ['signed checksum manifest', signedChecksums],
    ['signing manifest', signingManifest],
    ['driver package metadata', driverMetadata],
  ]) {
    const provenanceFailure = exactGitProvenanceFailure(metadata?.sourceProvenance, packageSourceProvenance, {
      recordedSubject: subject,
      currentSubject: 'release package provenance',
    });
    if (metadata?.sourceCommit !== packageSourceProvenance?.headCommit || provenanceFailure) {
      throw new Error(`${subject} does not match the exact current clean HEAD: ${provenanceFailure ?? 'sourceCommit mismatch'}`);
    }
  }
  if (!isDeepStrictEqual(packagedReleaseManifest, releaseManifest)) {
    throw new Error('packaged release-manifest.json does not exactly match the canonical outer release manifest');
  }

  if (
    releaseManifest?.version !== paths.version
    || releaseManifest?.releaseChannel !== 'stable'
    || releaseManifest?.packages?.root?.version !== paths.version
    || releaseManifest?.packages?.desktop?.version !== paths.version
    || releaseManifest?.packages?.nativeBridge?.version !== paths.version
    || signedChecksums?.version !== paths.version
    || signingManifest?.version !== paths.version
    || releasePackage?.version !== paths.version
    || releasePackage?.packageName !== `${expectedPackageBaseName}.zip`
    || releasePackage?.channel !== 'stable'
    || releasePackage?.platform !== 'windows-x64'
    || layout?.version !== paths.version
    || layout?.naming?.packageBaseName !== expectedPackageBaseName
    || layout?.naming?.channel !== 'stable'
    || layout?.naming?.platform !== 'windows-x64'
    || layout?.packages?.desktop !== paths.version
    || layout?.packages?.nativeBridge !== paths.version
    || path.basename(resolvedPackageRoot) !== expectedPackageBaseName
  ) throw new Error('release/layout/package metadata does not identify one stable Windows x64 version');
  const buildAuthority = layout?.buildAuthority;
  if (
    buildAuthority?.schemaVersion !== 1
    || buildAuthority?.artifactKind !== 'omni-release-build-authority'
    || buildAuthority?.sourceCommit !== packageSourceProvenance?.headCommit
    || buildAuthority?.forcedCleanBuild !== true
    || !String(buildAuthority?.cargoTargetDirectory ?? '').includes(packageSourceProvenance?.headCommit)
    || !Array.isArray(buildAuthority?.binaries)
    || buildAuthority.binaries.length !== RELEASE_BUILD_BINARY_CONTRACT.length
  ) throw new Error('installer layout has no exact current-HEAD forced-build authority');
  for (const [index, contract] of RELEASE_BUILD_BINARY_CONTRACT.entries()) {
    const recorded = buildAuthority.binaries[index];
    const candidate = path.join(resolvedPackageRoot, contract.path);
    if (
      recorded?.role !== contract.role
      || recorded?.path !== contract.path
      || recorded?.verification !== contract.verification
      || recorded?.sourceCommit !== packageSourceProvenance.headCommit
      || Number(recorded?.bytes) !== fs.statSync(candidate).size
      || recorded?.sha256 !== sha256File(candidate)
    ) throw new Error(`installer layout build authority does not match ${contract.path}`);
  }
  if (
    releasePackage?.installEntry !== 'scripts/installer/install-development-driver.ps1'
    || releasePackage?.uninstallEntry !== 'scripts/installer/uninstall-development-driver.ps1'
    || releasePackage?.repairEntry !== 'scripts/installer/repair-driver.ps1'
    || releasePackage?.nativeBridgeExecutable !== 'bridge-service-native/omni-bridge-service.exe'
    || releasePackage?.audioProbeExecutable !== 'bridge-service-native/omni-driver-audio-probe.exe'
    || releasePackage?.virtualMicTargetCaptureExecutable !== 'bridge-service-native/omni-virtual-mic-target-capture.exe'
    || releaseManifest?.installer?.nativeBridgeExecutable !== 'bridge-service-native/omni-bridge-service.exe'
    || releaseManifest?.installer?.audioProbeExecutable !== 'bridge-service-native/omni-driver-audio-probe.exe'
    || releaseManifest?.installer?.virtualMicTargetCaptureExecutable !== 'bridge-service-native/omni-virtual-mic-target-capture.exe'
  ) throw new Error('release package entrypoints do not match the production installer contract');
  if (
    driverMetadata?.protocolVersion !== INSTALL_RELEASE_PROTOCOL_VERSION
    || driverMetadata?.configuration !== 'Release'
    || driverMetadata?.platform !== 'x64'
    || driverMetadata?.signingMode !== 'release-injected'
    || driverMetadata?.timestampMode !== 'rfc3161'
    || typeof driverMetadata?.signerThumbprint !== 'string'
    || !driverMetadata.signerThumbprint.trim()
  ) throw new Error('stable driver package must be Release/x64/release-injected and RFC3161 timestamped');

  const packageRootRelative = portable(path.relative(workspaceRoot, resolvedPackageRoot));
  const recordedInventory = (Array.isArray(signedChecksums?.files) ? signedChecksums.files : [])
    .filter((entry) => portable(entry?.path ?? '').startsWith(`${packageRootRelative}/`))
    .map((entry) => {
      const relativePath = portable(entry.path).slice(packageRootRelative.length + 1);
      const actual = inventory.find((candidate) => candidate.path === relativePath);
      return {
        path: relativePath,
        bytes: actual?.bytes ?? -1,
        sha256: entry.sha256,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const inventoryFailure = exactInventoryFailure(inventory, recordedInventory, 'signed-checksums');
  if (inventoryFailure) throw new Error(inventoryFailure);
  if (
    normalizedPathIdentity(path.resolve(workspaceRoot, signedChecksums?.bundle?.path ?? ''))
      !== normalizedPathIdentity(paths.packageZip)
    || signedChecksums?.bundle?.sha256 !== sha256File(paths.packageZip)
  ) throw new Error('signed release zip does not match signed-checksums.sha256.json');

  if (
    signatureInventory?.schemaVersion !== 1
    || signatureInventory?.artifactKind !== 'omni-release-package-signature-inventory'
    || normalizedPathIdentity(signatureInventory?.packageRoot ?? '') !== normalizedPathIdentity(resolvedPackageRoot)
  ) throw new Error('package signature inventory was not emitted for the canonical signed package');
  const expectedSignable = inventory
    .filter((entry) => SIGNABLE_EXTENSIONS.has(path.extname(entry.path).toLowerCase()))
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const signatures = signatureMap(signatureInventory);
  const actualSignable = [...signatures.keys()].sort((left, right) => left.localeCompare(right, 'en'));
  if (!compareStringSets(expectedSignable, actualSignable)) {
    throw new Error('signature inventory does not cover the exact signed package executable/script set');
  }
  for (const relativePath of expectedSignable) {
    const signature = signatures.get(relativePath);
    if (
      signature?.status !== 'Valid'
      || typeof signature?.signerThumbprint !== 'string'
      || !signature.signerThumbprint.trim()
      || typeof signature?.timeStamperThumbprint !== 'string'
      || !signature.timeStamperThumbprint.trim()
    ) throw new Error(`signed package artifact is invalid or untimestamped: ${relativePath}`);
  }
  for (const relativePath of [
    'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
    'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat',
  ]) {
    if (signatures.get(relativePath)?.signerThumbprint !== driverMetadata.signerThumbprint) {
      throw new Error(`${relativePath} signer does not match driver-package.json`);
    }
  }

  const signTargetPrefix = `${packageRootRelative}/`;
  const declaredSignTargets = (Array.isArray(signingManifest?.signTargets) ? signingManifest.signTargets : [])
    .map((target) => portable(target?.path ?? ''))
    .filter((candidate) => candidate.startsWith(signTargetPrefix))
    .map((candidate) => candidate.slice(signTargetPrefix.length))
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (!compareStringSets(expectedSignable, declaredSignTargets)) {
    throw new Error('signing manifest target set does not match the canonical signed package');
  }

  const signatureEvidence = expectedSignable.map((relativePath) => ({
    path: relativePath,
    status: signatures.get(relativePath).status,
    signerThumbprint: signatures.get(relativePath).signerThumbprint,
    timeStamperThumbprint: signatures.get(relativePath).timeStamperThumbprint,
  }));
  const fileByPath = new Map(inventory.map((entry) => [entry.path, entry]));
  return {
    schemaVersion: INSTALL_RELEASE_EVIDENCE_SCHEMA_VERSION,
    artifactKind: 'omni-release-package-authority',
    inspectedAt: now.toISOString(),
    version: paths.version,
    sourceCommit: packageSourceProvenance.headCommit,
    sourceProvenance: packageSourceProvenance,
    driverVersion,
    bridgeVersion: String(layout?.packages?.nativeBridge ?? ''),
    protocolVersion: INSTALL_RELEASE_PROTOCOL_VERSION,
    packageRoot: packageRootRelative,
    packageZip: fileAuthority(paths.packageZip, workspaceRoot),
    releaseManifest: fileAuthority(paths.releaseManifestPath, workspaceRoot),
    signedChecksums: fileAuthority(paths.signedChecksumsPath, workspaceRoot),
    signingManifest: fileAuthority(paths.signingManifestPath, workspaceRoot),
    inventory,
    inventorySha256: sha256Json(inventory),
    signatures: signatureEvidence,
    driver: {
      metadata: driverMetadata,
      inf: fileByPath.get('drivers/windows-virtual-mic/package/omni-virtual-speaker.inf'),
      sys: fileByPath.get('drivers/windows-virtual-mic/package/omni-virtual-speaker.sys'),
      cat: fileByPath.get('drivers/windows-virtual-mic/package/omni-virtual-speaker.cat'),
    },
  };
}

const array = (value) => (Array.isArray(value) ? value : []);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const sameHash = (left, right) => /^[a-f0-9]{64}$/.test(String(left ?? '')) && left === right;
const packageAuthorityProjection = (authority) => {
  if (!authority || typeof authority !== 'object') return authority;
  const { inspectedAt: _inspectedAt, ...stable } = authority;
  return stable;
};

export function absentInstallStateIssues(state, label = 'system state') {
  const issues = [];
  if (state?.schemaVersion !== 1 || state?.artifactKind !== 'omni-install-system-state') {
    issues.push(`${label} schema/artifactKind is invalid`);
  }
  if (state?.isAdministrator !== true) issues.push(`${label} was not captured from an elevated authority process`);
  if (
    array(state?.rootDevices).length !== 0
    || array(state?.renderEndpoints).length !== 0
    || array(state?.captureEndpoints).length !== 0
    || array(state?.driverPackages).length !== 0
    || state?.installedDriverAuthority != null
    || Number(state?.pnpDriverStoreAuthorityCount ?? 0) !== 0
    || array(state?.services).length !== 0
    || state?.runtimeStatePresent !== false
    || state?.runtimeState != null
    || array(state?.bridgeProcesses).length !== 0
  ) issues.push(`${label} must prove complete device/endpoint/DriverStore/service/runtime/process absence`);
  return issues;
}

export function healthyInstallStateIssues(state, packageAuthority, label = 'system state') {
  const issues = [];
  if (state?.schemaVersion !== 1 || state?.artifactKind !== 'omni-install-system-state') {
    issues.push(`${label} schema/artifactKind is invalid`);
  }
  if (state?.isAdministrator !== true) issues.push(`${label} was not captured from an elevated authority process`);
  const roots = array(state?.rootDevices);
  const renders = array(state?.renderEndpoints);
  const captures = array(state?.captureEndpoints);
  const packages = array(state?.driverPackages);
  const wmiRows = array(state?.signedDrivers);
  const wmiCandidates = array(state?.signedDriverCandidates);
  const services = array(state?.services);
  if (roots.length !== 1 || roots[0]?.status !== 'OK' || !nonEmpty(roots[0]?.instanceId)) {
    issues.push(`${label} must contain exactly one running ROOT device`);
  }
  if (
    renders.length !== 1
    || renders[0]?.status !== 'OK'
    || !String(renders[0]?.friendlyName ?? '').includes('Omni Translate Virtual Speaker')
    || captures.length !== 1
    || captures[0]?.status !== 'OK'
    || !String(captures[0]?.friendlyName ?? '').includes('Omni Translate Virtual Microphone')
  ) issues.push(`${label} must contain exactly one ready render and capture endpoint`);
  const installed = state?.installedDriverAuthority;
  if (
    state?.signedDriverResolutionStatus !== 'ready-pnp-driverstore-service-files'
    || Number(state?.pnpDriverStoreAuthorityCount) !== 1
    || installed?.deviceId !== roots[0]?.instanceId
    || installed?.matchingDeviceId !== 'Root\\OmniTranslateVirtualSpeaker'
    || installed?.infName !== installed?.driverStore?.publishedName
    || installed?.driverVersion !== packageAuthority?.driverVersion
    || installed?.driverProviderName !== 'Omni Translate'
    || installed?.serviceName !== 'omni_translate_virtual_speaker'
  ) issues.push(`${label} PnP/DriverStore installed-driver authority does not match the release package`);
  const installedPackage = packages.find((entry) => entry?.publishedName === installed?.infName);
  if (
    packages.length < 1
    || packages.length > 3
    || !installedPackage
    || installedPackage?.providerName !== 'Omni Translate'
    || installedPackage?.version !== packageAuthority?.driverVersion
  ) issues.push(`${label} DriverStore inventory does not contain the exact current package or exceeds two backups`);
  const store = installed?.driverStore;
  const expectedSigner = packageAuthority?.driver?.metadata?.signerThumbprint;
  const storeInf = store?.inf;
  const storeCat = store?.cat;
  const storeSys = store?.sys;
  if (
    store?.providerName !== 'Omni Translate'
    || store?.className !== 'MEDIA'
    || store?.version !== packageAuthority?.driverVersion
    || storeInf?.present !== true
    || !sameHash(storeInf?.sha256, packageAuthority?.driver?.inf?.sha256)
    || storeCat?.present !== true
    || !sameHash(storeCat?.sha256, packageAuthority?.driver?.cat?.sha256)
    || storeCat?.signature?.status !== 'Valid'
    || storeCat?.signature?.signerThumbprint !== expectedSigner
    || !nonEmpty(storeCat?.signature?.timeStamperThumbprint)
    || storeSys?.present !== true
    || !sameHash(storeSys?.sha256, packageAuthority?.driver?.sys?.sha256)
    || storeSys?.signature?.status !== 'Valid'
    || storeSys?.signature?.signerThumbprint !== expectedSigner
    || !nonEmpty(storeSys?.signature?.timeStamperThumbprint)
  ) issues.push(`${label} installed DriverStore INF/CAT/SYS bytes or signatures do not match the canonical package`);
  const wmiProbeStatus = state?.wmiSignedDriverObservation?.probeStatus;
  const wmiCandidate = installed?.wmiObservation?.candidate;
  const wmiQueryDiagnostic = state?.wmiSignedDriverObservation?.queryDiagnostic;
  const installedWmiQueryDiagnostic = installed?.wmiObservation?.queryDiagnostic;
  if (
    !['not-exposed-yet', 'query-unavailable', 'exposed-consistent'].includes(wmiProbeStatus)
    || installed?.wmiObservation?.probeStatus !== wmiProbeStatus
    || typeof state?.wmiSignedDriverObservation?.rowCount !== 'number'
    || !Number.isSafeInteger(state.wmiSignedDriverObservation.rowCount)
    || state.wmiSignedDriverObservation.rowCount !== wmiRows.length
    || !isDeepStrictEqual(wmiRows, wmiCandidates)
    || (wmiProbeStatus === 'not-exposed-yet' && (wmiRows.length !== 0 || wmiCandidate != null))
    || (
      wmiProbeStatus !== 'query-unavailable'
      && (wmiQueryDiagnostic != null || installedWmiQueryDiagnostic != null)
    )
    || (
      wmiProbeStatus === 'query-unavailable'
      && (
        wmiRows.length !== 0
        || wmiCandidate != null
        || !nonEmpty(wmiQueryDiagnostic?.exceptionType)
        || !nonEmpty(wmiQueryDiagnostic?.message)
        || !nonEmpty(wmiQueryDiagnostic?.fullyQualifiedErrorId)
        || !nonEmpty(wmiQueryDiagnostic?.category)
        || !isDeepStrictEqual(wmiQueryDiagnostic, installedWmiQueryDiagnostic)
      )
    )
    || (
      wmiProbeStatus === 'exposed-consistent'
      && (
        wmiRows.length !== 1
        || wmiCandidate?.infName !== installed?.infName
        || wmiCandidate?.driverVersion !== installed?.driverVersion
        || wmiCandidate?.driverProviderName !== 'Omni Translate'
        || wmiRows[0]?.infName !== installed?.infName
        || wmiRows[0]?.driverVersion !== installed?.driverVersion
        || wmiRows[0]?.driverProviderName !== 'Omni Translate'
      )
    )
  ) issues.push(`${label} optional Win32_PnPSignedDriver diagnostic is conflicting, duplicated, or self-inconsistent`);
  if (services.length !== 1) issues.push(`${label} must contain exactly one Omni kernel service`);
  const service = services[0];
  if (
    service?.name !== 'omni_translate_virtual_speaker'
    || service?.state !== 'Running'
    || service?.binaryPresent !== true
    || !sameHash(service?.binarySha256, packageAuthority?.driver?.sys?.sha256)
    || service?.signature?.status !== 'Valid'
    || service?.signature?.signerThumbprint !== packageAuthority?.driver?.metadata?.signerThumbprint
    || !nonEmpty(service?.signature?.timeStamperThumbprint)
  ) issues.push(`${label} running service SYS/signature does not match the canonical package`);
  if (
    installed?.service?.name !== service?.name
    || installed?.service?.binaryPath !== service?.binaryPath
    || !sameHash(installed?.service?.binarySha256, service?.binarySha256)
    || !sameHash(installed?.service?.binarySha256, storeSys?.sha256)
    || installed?.service?.signature?.signerThumbprint !== expectedSigner
  ) issues.push(`${label} installed authority does not bind the running service binary to DriverStore SYS`);
  const runtime = state?.runtimeState;
  if (
    state?.runtimeStatePresent !== true
    || runtime?.protocolVersion !== INSTALL_RELEASE_PROTOCOL_VERSION
    || runtime?.installChannel !== 'release'
    || runtime?.driverVersion !== packageAuthority?.driverVersion
    || runtime?.requestedDriverVersion !== packageAuthority?.driverVersion
    || runtime?.packageVersion !== packageAuthority?.version
    || runtime?.pnpInstanceId !== roots[0]?.instanceId
    || runtime?.endpointInstanceId !== renders[0]?.instanceId
    || runtime?.captureEndpointInstanceId !== captures[0]?.instanceId
  ) issues.push(`${label} runtime install state does not match actual PnP/package identity`);
  if (array(state?.bridgeProcesses).length !== 0) {
    issues.push(`${label} contains a leaked Bridge/probe process after collection`);
  }
  return issues;
}

const resolveEvidenceFile = (evidenceRoot, relativePath) => {
  if (!nonEmpty(evidenceRoot) || !nonEmpty(relativePath) || path.isAbsolute(relativePath)) return null;
  const root = path.resolve(evidenceRoot);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink()) return null;
  return candidate;
};

const normalizedAudioEndpointId = (value) => String(value ?? '')
  .replace(/^SWD\\MMDEVAPI\\/i, '')
  .toLowerCase();

const virtualMicAuthorityProjection = (value) => Object.fromEntries([
  'collectorId',
  'collectorVersion',
  'parentCollectorProcessId',
  'captureChildProcessId',
  'bridgeProtocolVersion',
  'bridgeProcessId',
  'bridgeInstanceId',
  'bridgeSessionId',
  'captureEndpointId',
  'captureEndpointName',
  'rawCountersBefore',
  'rawCountersAfter',
  'recomputedCounterDelta',
  'cueId',
  'cueStatusTimeline',
  'cueLifecycle',
].map((field) => [field, value?.[field]]));

const validVirtualMicCueTimeline = (probe) => {
  const timeline = array(probe?.cueStatusTimeline);
  const seen = new Map();
  const statuses = [];
  let previousReceipt = -1;
  for (const event of timeline) {
    const receivedAt = Number(event?.collectorReceivedAtMonotonicNs);
    if (!Number.isFinite(receivedAt) || receivedAt <= previousReceipt) return false;
    previousReceipt = receivedAt;
    if (
      event?.type !== 'bridge.translation.status'
      || !nonEmpty(event?.statusId)
      || !nonEmpty(event?.requestId)
      || event?.cueId !== probe?.cueId
      || event?.sessionId !== probe?.bridgeSessionId
      || !nonEmpty(event?.reason)
      || !Number.isFinite(Number(event?.timestampMs))
    ) return false;
    const rawEvent = { ...event };
    delete rawEvent.collectorReceivedAtMonotonicNs;
    const serialized = JSON.stringify(rawEvent);
    if (seen.has(event.statusId)) {
      if (seen.get(event.statusId) !== serialized) return false;
      continue;
    }
    seen.set(event.statusId, serialized);
    statuses.push(event.playbackStatus);
  }
  return JSON.stringify(statuses) === JSON.stringify(['queued', 'started', 'completed']);
};

export function healthProbeIssues(health, packageAuthority, afterState, { evidenceRoot = '' } = {}) {
  const issues = [];
  if (health?.schemaVersion !== 1 || health?.artifactKind !== 'omni-install-release-health-probe') {
    issues.push('health probe schema/artifactKind is invalid');
    return issues;
  }
  const driver = health?.driverProbe;
  if (
    driver?.driverHealth !== 'running'
    || driver?.errorCode != null
    || Number(driver?.rootDeviceCount) !== 1
    || driver?.virtualMicOutputSupported !== true
    || driver?.virtualMicOutputStatus !== 'ready'
    || driver?.virtualMicFormat !== '48000Hz/mono/pcm16'
    || driver?.abiVersion !== '0X20260810'
    || driver?.ioctlAvailable !== true
    || driver?.installedDriverVersion !== packageAuthority?.driverVersion
    || driver?.packageSigningMode !== 'release-injected'
  ) issues.push('health driver probe does not prove the release v6 driver is ready');
  const installed = health?.installedDriverAuthority;
  if (
    !sameHash(installed?.installedSysSha256, packageAuthority?.driver?.sys?.sha256)
    || !sameHash(installed?.packageSysSha256, packageAuthority?.driver?.sys?.sha256)
    || !sameHash(installed?.packageCatSha256, packageAuthority?.driver?.cat?.sha256)
    || !sameHash(installed?.packageInfSha256, packageAuthority?.driver?.inf?.sha256)
    || !sameHash(installed?.driverStoreInfSha256, packageAuthority?.driver?.inf?.sha256)
    || !sameHash(installed?.driverStoreCatSha256, packageAuthority?.driver?.cat?.sha256)
    || !sameHash(installed?.driverStoreSysSha256, packageAuthority?.driver?.sys?.sha256)
    || installed?.installedDriverVersion !== packageAuthority?.driverVersion
    || installed?.installedInfName !== afterState?.installedDriverAuthority?.infName
    || installed?.driverStorePublishedName !== afterState?.installedDriverAuthority?.driverStore?.publishedName
    || installed?.pnpDriverInfName !== afterState?.installedDriverAuthority?.infName
    || installed?.pnpDriverProvider !== 'Omni Translate'
    || installed?.pnpService !== 'omni_translate_virtual_speaker'
    || installed?.installedSysSignatureStatus !== 'Valid'
    || installed?.packageCatalogSignatureStatus !== 'Valid'
    || installed?.driverStoreCatSignatureStatus !== 'Valid'
    || installed?.driverStoreSysSignatureStatus !== 'Valid'
    || installed?.driverStoreCatSignerThumbprint !== packageAuthority?.driver?.metadata?.signerThumbprint
    || installed?.driverStoreSysSignerThumbprint !== packageAuthority?.driver?.metadata?.signerThumbprint
  ) issues.push('health installed-driver authority does not match SYS/CAT/INF and actual PnP version');
  const audio = health?.audioProbe;
  const invalidSamples = Number(audio?.invalidSamples);
  const diagnosticDroppedBytes = Number(audio?.droppedBytes);
  const virtualMicDroppedBytes = Number(audio?.virtualMicDroppedBytes);
  const virtualMicRejectedWrites = Number(audio?.virtualMicRejectedWrites);
  if (
    audio?.passed !== true
    || (audio?.detail != null && String(audio.detail).trim() !== '')
    || !nonEmpty(audio?.endpointId)
    || normalizedAudioEndpointId(audio?.endpointId)
      !== normalizedAudioEndpointId(afterState?.renderEndpoints?.[0]?.instanceId)
    || Number(audio?.toneFrames) <= 0
    || Number(audio?.toneRms) <= 0.01
    || typeof audio?.invalidSamples !== 'number'
    || !Number.isSafeInteger(invalidSamples)
    || invalidSamples !== 0
    || typeof audio?.droppedBytes !== 'number'
    || !Number.isSafeInteger(diagnosticDroppedBytes)
    || diagnosticDroppedBytes < 0
    || typeof audio?.virtualMicDroppedBytes !== 'number'
    || !Number.isSafeInteger(virtualMicDroppedBytes)
    || virtualMicDroppedBytes !== 0
    || typeof audio?.virtualMicRejectedWrites !== 'number'
    || !Number.isSafeInteger(virtualMicRejectedWrites)
    || virtualMicRejectedWrites !== 0
  ) issues.push('health WASAPI tone probe did not pass native validity and virtual-mic overflow/rejection checks');
  const handshake = health?.bridgeHandshake;
  if (
    handshake?.passed !== true
    || handshake?.protocolVersion !== INSTALL_RELEASE_PROTOCOL_VERSION
    || !Number.isInteger(Number(handshake?.bridgeProcessId))
    || Number(handshake.bridgeProcessId) <= 0
    || !nonEmpty(handshake?.bridgeInstanceId)
    || !nonEmpty(handshake?.bridgeSessionId)
    || normalizedAudioEndpointId(handshake?.captureEndpointId)
      !== normalizedAudioEndpointId(afterState?.captureEndpoints?.[0]?.instanceId)
  ) issues.push('health Bridge handshake does not prove a production v6 session on the installed endpoint');
  const virtualMic = health?.virtualMicProbe;
  const runtimeSnapshot = health?.virtualMicRuntimeSnapshot;
  const rawBefore = virtualMic?.rawCountersBefore ?? {};
  const rawAfter = virtualMic?.rawCountersAfter ?? {};
  const counterDelta = virtualMic?.recomputedCounterDelta ?? {};
  const beforeVirtual = Number(rawBefore.virtualMicFramesWritten);
  const afterVirtual = Number(rawAfter.virtualMicFramesWritten);
  const beforePhysical = Number(rawBefore.playbackFramesWritten);
  const afterPhysical = Number(rawAfter.playbackFramesWritten);
  const virtualDelta = Number(counterDelta.virtualMicFramesWritten);
  const physicalDelta = Number(counterDelta.playbackFramesWritten);
  const pids = [
    Number(virtualMic?.parentCollectorProcessId),
    Number(virtualMic?.captureChildProcessId),
    Number(virtualMic?.bridgeProcessId),
  ];
  const lifecycle = virtualMic?.cueLifecycle ?? {};
  if (
    virtualMic?.schemaVersion !== 1
    || virtualMic?.artifactKind !== 'virtual-mic-real-capture-probe'
    || virtualMic?.collectorId !== 'omni-virtual-mic-target-capture'
    || virtualMic?.collectorVersion !== packageAuthority?.bridgeVersion
    || virtualMic?.bridgeProtocolVersion !== INSTALL_RELEASE_PROTOCOL_VERSION
    || !pids.every((pid) => Number.isInteger(pid) && pid > 0)
    || new Set(pids).size !== 3
    || virtualMic?.targetCaptureApplication?.classification !== 'real-target'
    || virtualMic?.targetCaptureApplication?.name !== 'Omni Translate Virtual Microphone Target Capture'
    || virtualMic?.targetCaptureApplication?.openedEndpoint !== true
    || Number(virtualMic?.targetCaptureApplication?.processId) !== Number(virtualMic?.captureChildProcessId)
    || virtualMic?.targetCaptureApplication?.endpointId !== virtualMic?.captureEndpointId
    || virtualMic?.format?.sampleRateHz !== 48_000
    || virtualMic?.format?.channelCount !== 1
    || virtualMic?.format?.bitsPerSample !== 16
    || virtualMic?.format?.encoding !== 'pcm16'
    || Number(virtualMic?.capturedFrames) <= 0
    || virtualMic?.fingerprint?.detected !== true
    || !pids.every(Number.isInteger)
    || ![beforeVirtual, afterVirtual, beforePhysical, afterPhysical, virtualDelta, physicalDelta]
      .every(Number.isInteger)
    || afterVirtual <= beforeVirtual
    || virtualDelta !== afterVirtual - beforeVirtual
    || physicalDelta !== afterPhysical - beforePhysical
    || physicalDelta !== 0
    || !validVirtualMicCueTimeline(virtualMic)
    || lifecycle?.queuedCount !== 1
    || lifecycle?.startedCount !== 1
    || lifecycle?.completedCount !== 1
    || lifecycle?.staleDroppedCount !== 0
    || lifecycle?.routeFailedCount !== 0
    || lifecycle?.terminalEventCount !== 1
    || lifecycle?.terminalStatus !== 'completed'
    || !isDeepStrictEqual(
      virtualMicAuthorityProjection(virtualMic),
      virtualMicAuthorityProjection(runtimeSnapshot),
    )
    || runtimeSnapshot?.schemaVersion !== 1
    || runtimeSnapshot?.artifactKind !== 'virtual-mic-runtime-snapshot'
    || runtimeSnapshot?.virtualMicOutputSupported !== true
    || runtimeSnapshot?.virtualMicOutputStatus !== 'ready'
    || runtimeSnapshot?.virtualMicFormat !== '48000Hz/mono/pcm16'
    || Number(runtimeSnapshot?.capturedFrames) !== Number(virtualMic?.capturedFrames)
    || Number(runtimeSnapshot?.virtualMicFramesWrittenBefore) !== beforeVirtual
    || Number(runtimeSnapshot?.virtualMicFramesWrittenAfter) !== afterVirtual
    || Number(runtimeSnapshot?.virtualMicFramesWrittenForCue) !== virtualDelta
    || Number(runtimeSnapshot?.physicalPlaybackFramesWrittenBefore) !== beforePhysical
    || Number(runtimeSnapshot?.physicalPlaybackFramesWrittenAfter) !== afterPhysical
    || Number(runtimeSnapshot?.physicalPlaybackFramesWrittenForCue) !== 0
    || handshake?.bridgeProcessId !== virtualMic?.bridgeProcessId
    || handshake?.bridgeInstanceId !== virtualMic?.bridgeInstanceId
    || handshake?.bridgeSessionId !== virtualMic?.bridgeSessionId
    || handshake?.captureEndpointId !== virtualMic?.captureEndpointId
  ) issues.push('health virtual-mic probe did not prove isolated real capture');
  const raw = health?.rawEvidence;
  const rawBindings = [
    ['captureProbePath', 'captureProbeSha256', 'capture probe'],
    ['runtimeSnapshotPath', 'runtimeSnapshotSha256', 'runtime snapshot'],
    ['captureWavPath', 'captureWavSha256', 'capture WAV'],
  ];
  const resolvedRaw = {};
  for (const [pathField, hashField, label] of rawBindings) {
    const candidate = resolveEvidenceFile(evidenceRoot, raw?.[pathField]);
    resolvedRaw[pathField] = candidate;
    if (!candidate || !sameHash(raw?.[hashField], sha256File(candidate))) {
      issues.push(`health raw ${label} is missing, escapes the run, or fails its SHA256 binding`);
    }
  }
  try {
    if (
      resolvedRaw.captureProbePath
      && !isDeepStrictEqual(readJson(resolvedRaw.captureProbePath), health?.virtualMicProbe)
    ) issues.push('health raw capture probe does not match the validated virtual-mic counters');
  } catch {
    issues.push('health raw capture probe is not valid JSON');
  }
  try {
    if (
      resolvedRaw.runtimeSnapshotPath
      && !isDeepStrictEqual(readJson(resolvedRaw.runtimeSnapshotPath), health?.virtualMicRuntimeSnapshot)
    ) issues.push('health raw runtime snapshot does not match the validated Bridge runtime identity');
  } catch {
    issues.push('health raw runtime snapshot is not valid JSON');
  }
  if (resolvedRaw.captureWavPath) {
    const wav = fs.readFileSync(resolvedRaw.captureWavPath);
    if (
      wav.length <= 44
      || wav.subarray(0, 4).toString('ascii') !== 'RIFF'
      || wav.subarray(8, 12).toString('ascii') !== 'WAVE'
      || wav.readUInt16LE(20) !== 1
      || wav.readUInt16LE(22) !== 1
      || wav.readUInt32LE(24) !== 48_000
      || wav.readUInt16LE(34) !== 16
      || !sameHash(raw?.captureWavSha256, virtualMic?.captureWavSha256)
      || !sameHash(raw?.captureWavSha256, runtimeSnapshot?.captureWavSha256)
      || Number(virtualMic?.capturedFrames) !== (wav.length - 44) / 2
    ) {
      issues.push('health raw capture WAV is not a non-empty RIFF/WAVE capture');
    }
  }
  if (
    resolvedRaw.captureProbePath
    && resolvedRaw.runtimeSnapshotPath
    && resolvedRaw.captureWavPath
  ) {
    const fingerprintAuthority = validateVirtualMicCaptureArtifacts({
      captureWavPath: resolvedRaw.captureWavPath,
      captureProbe: virtualMic,
      runtimeSnapshot,
    });
    issues.push(...fingerprintAuthority.issues.map((issue) => `health ${issue}`));
    if (
      fingerprintAuthority.authority
      && !isDeepStrictEqual(handshake?.fingerprintAuthority, fingerprintAuthority.authority)
    ) {
      issues.push('health PowerShell fingerprint authority does not match the independently recomputed WAV authority');
    }
  }
  return issues;
}

const validCompletedOperation = (operation, authority, expectedAction) => {
  if (
    operation?.schemaVersion !== 1
    || operation?.operationId !== authority?.operation?.operationId
    || operation?.action !== expectedAction
    || operation?.succeeded !== true
    || operation?.phase !== 'completed'
    || operation?.errorCode != null
    || operation?.elevated !== true
    || !Number.isInteger(Number(operation?.requestProcessId))
    || Number(operation.requestProcessId) <= 0
    || !Number.isInteger(Number(operation?.elevatedProcessId))
    || Number(operation.elevatedProcessId) <= 0
    || !['already-elevated', 'uac-runas'].includes(operation?.elevationMode)
    || (operation.elevationMode === 'already-elevated'
      && Number(operation.requestProcessId) !== Number(operation.elevatedProcessId))
    || (operation.elevationMode === 'uac-runas'
      && Number(operation.requestProcessId) === Number(operation.elevatedProcessId))
    || operation?.installChannel !== 'release'
    || !nonEmpty(operation?.startedAt)
    || !nonEmpty(operation?.finishedAt)
    || Date.parse(operation.finishedAt) < Date.parse(operation.startedAt)
  ) return 'production elevated operation did not complete successfully';
  return null;
};

const semanticVersionParts = (version) => String(version).split('.').map((part) => Number(part));
const isOlderVersion = (previous, current) => {
  const left = semanticVersionParts(previous);
  const right = semanticVersionParts(current);
  if (left.some((part) => !Number.isInteger(part)) || right.some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
};

export function validateInstallReleaseEvidencePayload({
  scenarioId,
  authority,
  packageAuthority,
  signatureInventory,
  currentPackageAuthority,
  previousPackageAuthority = null,
  previousSignatureInventory = null,
  currentPreviousPackageAuthority = null,
  beforeState = null,
  operationResult = null,
  afterState = null,
  healthProbe = null,
  currentProvenance,
  currentImplementationAuthority = null,
  evidenceRoot = '',
} = {}) {
  const issues = [];
  if (!INSTALL_RELEASE_SCENARIOS.includes(scenarioId)) issues.push(`unsupported install scenario ${scenarioId}`);
  if (
    authority?.schemaVersion !== INSTALL_RELEASE_EVIDENCE_SCHEMA_VERSION
    || authority?.artifactKind !== 'omni-install-release-run-authority'
    || authority?.collectorId !== INSTALL_RELEASE_COLLECTOR_ID
    || authority?.collectorVersion !== INSTALL_RELEASE_COLLECTOR_VERSION
    || authority?.scenarioId !== scenarioId
  ) issues.push('install runner authority identity is invalid');
  const provenanceFailure = exactGitProvenanceFailure(authority?.provenance, currentProvenance, {
    recordedSubject: 'install runner provenance',
    currentSubject: 'current checkout provenance',
  });
  if (provenanceFailure) issues.push(provenanceFailure);
  if (
    !Array.isArray(currentImplementationAuthority)
    || JSON.stringify(authority?.implementation) !== JSON.stringify(currentImplementationAuthority)
  ) issues.push('install runner implementation hashes do not match the current checkout');
  if (packageAuthority?.inventorySha256 !== sha256Json(packageAuthority?.inventory ?? [])) {
    issues.push('package authority inventory hash does not match its raw inventory');
  }
  if (
    JSON.stringify(packageAuthorityProjection(packageAuthority))
      !== JSON.stringify(packageAuthorityProjection(currentPackageAuthority))
  ) {
    issues.push('archived package authority does not match the freshly recomputed canonical signed package');
  }
  if (authority?.packageAuthoritySha256 !== sha256Json(packageAuthority)) {
    issues.push('runner authority does not bind package-authority.json');
  }
  if (!signatureInventory || authority?.signatureInventorySha256 !== sha256Json(signatureInventory)) {
    issues.push('runner authority does not bind signature-inventory.json');
  }

  if (scenarioId === 'INSTALL-RELEASE-LAYOUT') {
    if (
      authority?.operation != null
      || authority?.previousPackageAuthoritySha256 != null
      || authority?.previousSignatureInventorySha256 != null
    ) {
      issues.push('release layout authority must not claim an install operation or previous package');
    }
    return [...new Set(issues)];
  }
  if (scenarioId !== 'INSTALL-UPGRADE' && (
    previousPackageAuthority != null
    || previousSignatureInventory != null
    || currentPreviousPackageAuthority != null
    || authority?.previousPackageAuthoritySha256 != null
    || authority?.previousSignatureInventorySha256 != null
  )) issues.push('only upgrade evidence may bind a previous release package');
  const expectedAction = INSTALL_RELEASE_SCENARIO_ACTIONS[scenarioId];
  if (
    authority?.operation?.action !== expectedAction
    || authority?.operation?.requestScript !== 'scripts/installer/request-elevated-driver-operation.ps1'
    || authority?.operation?.installChannel !== 'release'
    || authority?.operation?.elevatedProductionRequest !== true
  ) issues.push('runner did not invoke the production elevated release operation');
  const operationScript = expectedAction === 'uninstall'
    ? 'scripts/installer/uninstall-development-driver.ps1'
    : expectedAction === 'reinstall'
      ? 'scripts/installer/repair-driver.ps1'
      : 'scripts/installer/install-development-driver.ps1';
  const packageFileHashes = new Map(array(packageAuthority?.inventory)
    .map((entry) => [entry?.path, entry?.sha256]));
  if (
    authority?.operation?.requestScriptSha256
      !== packageFileHashes.get('scripts/installer/request-elevated-driver-operation.ps1')
    || authority?.operation?.invokeScriptSha256
      !== packageFileHashes.get('scripts/installer/invoke-elevated-driver-operation.ps1')
    || authority?.operation?.operationScriptSha256 !== packageFileHashes.get(operationScript)
  ) issues.push('runner operation script hashes do not match the canonical signed package');
  const operationFailure = validCompletedOperation(operationResult, authority, expectedAction);
  if (operationFailure) issues.push(operationFailure);
  if (
    operationResult?.driverVersion !== packageAuthority?.driverVersion
    || operationResult?.bridgeVersion !== packageAuthority?.bridgeVersion
  ) issues.push('production elevated operation version fields do not match the canonical package');
  if (authority?.operation?.resultSha256 !== sha256Json(operationResult)) {
    issues.push('runner authority does not bind operation-result.json');
  }
  const operationLog = resolveEvidenceFile(evidenceRoot, 'operation-result.log');
  if (
    operationResult?.logPath !== 'operation-result.log'
    || !operationLog
    || !sameHash(operationResult?.logSha256, sha256File(operationLog))
    || authority?.operation?.operationLogSha256 !== operationResult?.logSha256
  ) issues.push('runner authority does not bind the production elevated operation log');
  for (const [field, value] of [
    ['beforeStateSha256', beforeState],
    ['afterStateSha256', afterState],
  ]) {
    if (authority?.operation?.[field] !== sha256Json(value)) {
      issues.push(`runner authority does not bind ${field}`);
    }
  }
  if (scenarioId !== 'INSTALL-UNINSTALL' && authority?.operation?.healthProbeSha256 !== sha256Json(healthProbe)) {
    issues.push('runner authority does not bind health-probe.json');
  }
  if (scenarioId === 'INSTALL-UNINSTALL' && (
    authority?.operation?.healthProbeSha256 != null
    || healthProbe != null
  )) issues.push('uninstall evidence must not claim a post-install health probe');

  if (scenarioId === 'INSTALL-FRESH') {
    issues.push(...absentInstallStateIssues(beforeState, 'fresh before-state'));
    issues.push(...healthyInstallStateIssues(afterState, packageAuthority, 'fresh after-state'));
    issues.push(...healthProbeIssues(healthProbe, packageAuthority, afterState, { evidenceRoot }));
  } else if (scenarioId === 'INSTALL-REPAIR') {
    issues.push(...healthyInstallStateIssues(beforeState, packageAuthority, 'repair before-state'));
    issues.push(...healthyInstallStateIssues(afterState, packageAuthority, 'repair after-state'));
    issues.push(...healthProbeIssues(healthProbe, packageAuthority, afterState, { evidenceRoot }));
  } else if (scenarioId === 'INSTALL-UNINSTALL') {
    issues.push(...healthyInstallStateIssues(beforeState, packageAuthority, 'uninstall before-state'));
    issues.push(...absentInstallStateIssues(afterState, 'uninstall after-state'));
  } else if (scenarioId === 'INSTALL-UPGRADE') {
    if (!previousPackageAuthority) {
      issues.push('upgrade requires a canonical previous signed package authority');
    } else {
      if (
        !currentPreviousPackageAuthority
        || JSON.stringify(packageAuthorityProjection(previousPackageAuthority))
          !== JSON.stringify(packageAuthorityProjection(currentPreviousPackageAuthority))
      ) issues.push('archived previous package authority does not match the freshly recomputed canonical signed package');
      if (authority?.previousPackageAuthoritySha256 !== sha256Json(previousPackageAuthority)) {
        issues.push('runner authority does not bind previous-package-authority.json');
      }
      if (
        !previousSignatureInventory
        || authority?.previousSignatureInventorySha256 !== sha256Json(previousSignatureInventory)
      ) {
        issues.push('runner authority does not bind previous-signature-inventory.json');
      }
      if (!isOlderVersion(previousPackageAuthority.version, packageAuthority.version)) {
        issues.push('upgrade previous package version must be older than the current package');
      }
      if (
        !nonEmpty(previousPackageAuthority?.sourceCommit)
        || previousPackageAuthority.sourceCommit === packageAuthority?.sourceCommit
      ) issues.push('upgrade previous package must carry its distinct historical clean source commit');
      if (previousPackageAuthority.protocolVersion !== packageAuthority.protocolVersion) {
        issues.push('upgrade previous package must use the same v6 protocol/ABI contract');
      }
      if (previousPackageAuthority.driver?.sys?.sha256 === packageAuthority.driver?.sys?.sha256) {
        issues.push('upgrade must replace a different previous SYS, not relabel the current binary');
      }
      issues.push(...healthyInstallStateIssues(beforeState, previousPackageAuthority, 'upgrade before-state'));
    }
    issues.push(...healthyInstallStateIssues(afterState, packageAuthority, 'upgrade after-state'));
    issues.push(...healthProbeIssues(healthProbe, packageAuthority, afterState, { evidenceRoot }));
  }
  return [...new Set(issues)];
}

export function assertCleanInstallReleaseProvenance(provenance) {
  const failure = gitProvenanceShapeFailure(provenance, 'install release evidence provenance');
  if (failure) throw new Error(failure);
}

export function implementationAuthority(workspaceRoot = repoRoot) {
  return INSTALL_RELEASE_REQUIRED_IMPLEMENTATION_FILES.map((relativePath) => {
    const candidate = requireFile(path.resolve(workspaceRoot, relativePath), relativePath);
    return {
      path: relativePath,
      bytes: fs.statSync(candidate).size,
      sha256: sha256File(candidate),
    };
  });
}

export function hashJsonAuthority(value) {
  return sha256Json(value);
}

/**
 * Production archive/collector entrypoint. It accepts only a directory emitted
 * by run-install-release-evidence.mjs, reloads every scenario artifact, and
 * recomputes package/signature/implementation authority from the current
 * checkout before returning a ready payload.
 */
export function validateInstallReleaseRunDirectory({
  runDirectory,
  workspaceRoot = repoRoot,
  currentProvenance,
  now = new Date(),
} = {}) {
  const issues = [];
  const root = path.resolve(String(runDirectory ?? ''));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    return { issues: ['install release run directory is missing, not a directory, or a symbolic link'] };
  }
  let authority;
  try {
    authority = readJson(path.join(root, 'authority.json'));
  } catch (error) {
    return { issues: [`install release authority.json is missing or invalid: ${error.message}`] };
  }
  const scenarioId = authority?.scenarioId;
  const expectedArtifacts = INSTALL_RELEASE_ARTIFACTS_BY_SCENARIO[scenarioId];
  if (!expectedArtifacts) return { issues: [`unsupported install scenario ${scenarioId}`] };
  const expectedTopLevel = [...new Set(expectedArtifacts.map((entry) => entry.path.split('/')[0]))]
    .sort((left, right) => left.localeCompare(right, 'en'));
  const actualTopLevel = fs.readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      if (entry.isSymbolicLink()) issues.push(`install release run contains symbolic link ${entry.name}`);
      return entry.name;
    })
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (!compareStringSets(expectedTopLevel, actualTopLevel)) {
    issues.push('install release run top-level artifact inventory is missing files or contains unowned extras');
  }

  const load = (relativePath) => {
    try {
      return readJson(requireFile(path.join(root, relativePath), `install evidence ${relativePath}`));
    } catch (error) {
      issues.push(error.message);
      return null;
    }
  };
  const packageAuthority = load('package-authority.json');
  const signatureInventory = load('signature-inventory.json');
  const previousPackageAuthority = scenarioId === 'INSTALL-UPGRADE'
    ? load('previous-package-authority.json')
    : null;
  const previousSignatureInventory = scenarioId === 'INSTALL-UPGRADE'
    ? load('previous-signature-inventory.json')
    : null;
  const beforeState = INSTALL_RELEASE_SCENARIO_ACTIONS[scenarioId] ? load('before-state.json') : null;
  const operationResult = INSTALL_RELEASE_SCENARIO_ACTIONS[scenarioId] ? load('operation-result.json') : null;
  const afterState = INSTALL_RELEASE_SCENARIO_ACTIONS[scenarioId] ? load('after-state.json') : null;
  const healthProbe = !['INSTALL-UNINSTALL', 'INSTALL-RELEASE-LAYOUT'].includes(scenarioId)
    ? load('health-probe.json')
    : null;

  let currentPackageAuthority = null;
  let currentPreviousPackageAuthority = null;
  try {
    currentPackageAuthority = inspectCanonicalInstallReleasePackage({
      workspaceRoot,
      version: packageAuthority?.version,
      signatureInventory,
      expectedProvenance: currentProvenance,
      now,
    });
    if (scenarioId === 'INSTALL-UPGRADE') {
      currentPreviousPackageAuthority = inspectCanonicalInstallReleasePackage({
        workspaceRoot,
        version: previousPackageAuthority?.version,
        signatureInventory: previousSignatureInventory,
        expectedProvenance: currentProvenance,
        allowHistoricalProvenance: true,
        now,
      });
    }
  } catch (error) {
    issues.push(`canonical signed package recomputation failed: ${error.message}`);
  }
  let currentImplementationAuthority = null;
  try {
    currentImplementationAuthority = implementationAuthority(workspaceRoot);
  } catch (error) {
    issues.push(`install runner implementation authority failed: ${error.message}`);
  }

  if (healthProbe?.rawEvidence) {
    const expectedHealthFiles = [
      healthProbe.rawEvidence.captureProbePath,
      healthProbe.rawEvidence.runtimeSnapshotPath,
      healthProbe.rawEvidence.captureWavPath,
    ].map((entry) => portable(entry)).sort((left, right) => left.localeCompare(right, 'en'));
    const healthRoot = path.join(root, 'health-artifacts');
    try {
      const actualHealthFiles = walkFiles(root, healthRoot).map((entry) => entry.path);
      if (!compareStringSets(expectedHealthFiles, actualHealthFiles)) {
        issues.push('install health raw artifact inventory is missing files or contains unowned extras');
      }
    } catch (error) {
      issues.push(`install health raw artifact inventory failed: ${error.message}`);
    }
  }

  if (
    typeof authority?.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(authority.generatedAt))
  ) issues.push('install runner authority generatedAt is missing or invalid');
  issues.push(...validateInstallReleaseEvidencePayload({
    scenarioId,
    authority,
    packageAuthority,
    signatureInventory,
    currentPackageAuthority,
    previousPackageAuthority,
    previousSignatureInventory,
    currentPreviousPackageAuthority,
    beforeState,
    operationResult,
    afterState,
    healthProbe,
    currentProvenance,
    currentImplementationAuthority,
    evidenceRoot: root,
  }));
  return {
    issues: [...new Set(issues)],
    scenarioId,
    authority,
    packageAuthority,
    signatureInventory,
    previousPackageAuthority,
    previousSignatureInventory,
    beforeState,
    operationResult,
    afterState,
    healthProbe,
  };
}
