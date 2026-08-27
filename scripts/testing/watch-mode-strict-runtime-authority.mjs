import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  currentAuthorityImplementationHashes,
  currentAuthorityRuntimeBinaryHashes,
  fileAuthorityEntry,
  resolveAuthorityPath,
} from './watch-mode-evidence-authority.mjs';

export const STRICT_RUNTIME_AUTHORITY_SCHEMA_VERSION = 1;
export const STRICT_RUNTIME_AUTHORITY_KIND = 'watch-mode-strict-runtime-authority';
export const STRICT_RUNTIME_AUTHORITY_FILE = 'strict-runtime-authority.json';
export const STRICT_RUNTIME_ROOT = 'artifacts/testing/watch-mode-strict-runtime';

const SAFE_RELEASE_ID = /^[a-z0-9][a-z0-9._-]{7,79}$/iu;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function writeJsonExclusive(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

function assertCleanHead(provenance) {
  if (
    provenance?.captureStatus !== 'captured'
    || provenance?.worktreeClean !== true
    || Number(provenance?.dirtyEntryCount) !== 0
    || !/^[a-f0-9]{40}$/iu.test(String(provenance?.headCommit ?? ''))
  ) throw new Error('strict runtime preparation requires the exact current clean HEAD');
}

function runChecked(executable, args, { workspaceRoot, environment, run = spawnSync, logPath = null } = {}) {
  const result = run(executable, args, {
    cwd: workspaceRoot,
    env: environment,
    encoding: logPath ? 'utf8' : undefined,
    stdio: logPath ? 'pipe' : 'inherit',
    windowsHide: true,
  });
  if (logPath) fs.writeFileSync(logPath, `${result.stdout ?? ''}\n${result.stderr ?? ''}`, 'utf8');
  if (result.error || Number(result.status) !== 0) {
    throw new Error(`strict runtime command failed: ${executable} ${args.join(' ')}: ${result.error?.message ?? `exit ${result.status ?? 1}`}`);
  }
  return result;
}

export function verifyStrictRuntimeAuthority(authorityPath, {
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
} = {}) {
  const resolved = path.resolve(workspaceRoot, authorityPath);
  const authorityRoot = path.resolve(workspaceRoot, STRICT_RUNTIME_ROOT);
  if (!resolved.startsWith(`${authorityRoot}${path.sep}`) || path.basename(resolved) !== STRICT_RUNTIME_AUTHORITY_FILE) {
    throw new Error('strict runtime authority path escapes the canonical strict-runtime evidence root');
  }
  const authority = JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/u, ''));
  assertCleanHead(provenance);
  if (
    authority?.schemaVersion !== STRICT_RUNTIME_AUTHORITY_SCHEMA_VERSION
    || authority?.artifactKind !== STRICT_RUNTIME_AUTHORITY_KIND
    || authority?.provenance?.headCommit !== provenance.headCommit
    || authority?.provenance?.worktreeClean !== true
    || authority?.certificate?.keyAlgorithm !== 'RSA'
    || Number(authority?.certificate?.keyLength) !== 3072
    || authority?.certificate?.hashAlgorithm !== 'SHA256'
    || authority?.certificate?.enhancedKeyUsage !== 'Code Signing'
    || authority?.certificate?.signingMode !== 'local-self-signed'
    || authority?.certificate?.trustScope !== 'vmware-testsigning-only'
    || authority?.certificate?.publicProductionTrust !== false
    || authority?.aec3Gate?.verdict !== 'passed'
    || !Array.isArray(authority?.runtimeBinaryHashes)
    || !Array.isArray(authority?.implementationHashes)
  ) throw new Error('strict runtime authority has an unsupported or incomplete schema');
  const { authorityDigest, ...unsigned } = authority;
  if (authorityDigest !== digest(unsigned)) throw new Error('strict runtime authority digest mismatch');
  const expectedRuntime = currentAuthorityRuntimeBinaryHashes({ workspaceRoot });
  if (canonical(expectedRuntime) !== canonical(authority.runtimeBinaryHashes)) {
    throw new Error('strict runtime authority binary inventory does not match the frozen workspace runtime');
  }
  const expectedImplementation = currentAuthorityImplementationHashes({ workspaceRoot });
  if (canonical(expectedImplementation) !== canonical(authority.implementationHashes)) {
    throw new Error('strict runtime authority implementation inventory does not match the current HEAD');
  }
  for (const entry of [authority.certificate.certificateAuthority, authority.aec3Gate.authority]) {
    const candidate = resolveAuthorityPath(path.dirname(resolved), entry.path, 'strict runtime authority artifact');
    const actual = fileAuthorityEntry(candidate, entry.path);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new Error(`strict runtime authority artifact changed: ${entry.path}`);
    }
  }
  const packagedCertificate = expectedRuntime.find((entry) => entry.path.endsWith('/omni-translate-development-driver.cer'));
  if (packagedCertificate?.sha256 !== authority.certificate.certificateAuthority.sha256) {
    throw new Error('strict runtime packaged driver certificate does not match the per-release certificate');
  }
  return { authorityPath: resolved, authority };
}

export function prepareStrictRuntimeAuthority({
  workspaceRoot = repoRoot,
  outputRoot = STRICT_RUNTIME_ROOT,
  releaseId = `watch-${new Date().toISOString().replace(/[-:.TZ]/gu, '')}-${crypto.randomBytes(4).toString('hex')}`,
  run = spawnSync,
} = {}) {
  if (process.platform !== 'win32') throw new Error('strict runtime preparation requires Windows');
  if (!SAFE_RELEASE_ID.test(releaseId)) throw new Error('strict runtime releaseId is not portable');
  if (path.resolve(workspaceRoot, outputRoot) !== path.resolve(workspaceRoot, STRICT_RUNTIME_ROOT)) {
    throw new Error('strict runtime preparation requires the canonical strict-runtime evidence root');
  }
  const provenance = currentGitProvenance({ cwd: workspaceRoot });
  assertCleanHead(provenance);
  const root = path.resolve(workspaceRoot, outputRoot, releaseId);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root, { recursive: false });
  const environment = { ...process.env, CARGO_TARGET_DIR: path.join(workspaceRoot, 'target') };
  environment.OMNI_BUILD_COMMIT = provenance.headCommit;
  delete environment.CARGO_BUILD_TARGET;
  const command = process.env.ComSpec || 'cmd.exe';
  const npm = (...args) => runChecked(command, ['/d', '/s', '/c', 'npm.cmd', ...args], {
    workspaceRoot, environment, run,
  });
  runChecked('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(workspaceRoot, 'scripts', 'release', 'new-local-release-certificate.ps1'),
    '-WorkspaceRoot', workspaceRoot, '-ReleaseId', releaseId,
  ], { workspaceRoot, environment, run });
  const certificateMetadataPath = path.join(workspaceRoot, 'artifacts', 'release-signing', releaseId, 'certificate.json');
  const certificate = JSON.parse(fs.readFileSync(certificateMetadataPath, 'utf8'));
  const aecLog = path.join(root, 'aec3-msvc-gate.log');
  runChecked(command, ['/d', '/s', '/c', 'npm.cmd', 'run', 'test:aec3-msvc'], {
    workspaceRoot,
    environment: { ...environment, CARGO_TARGET_DIR: path.join(workspaceRoot, 'target', 'strict-runtime-aec-gate') },
    run,
    logPath: aecLog,
  });
  npm('run', 'build:desktop-shell');
  npm('run', 'build:bridge-service-native');
  runChecked('cargo.exe', ['build', '--manifest-path', 'scripts/diagnostics/omni-realtime/Cargo.toml'], {
    workspaceRoot, environment, run,
  });
  runChecked('cargo.exe', ['build', '--locked', '--release', '--manifest-path', 'scripts/diagnostics/omni-benchmark/Cargo.toml'], {
    workspaceRoot, environment, run,
  });
  runChecked('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(workspaceRoot, 'scripts', 'installer', 'build-sysvad-driver.ps1'),
    '-WorkspaceRoot', workspaceRoot,
    '-Configuration', 'Release',
    '-SigningPfxPath', certificate.pfxPath,
    '-SigningPfxPasswordPath', certificate.passwordPath,
  ], { workspaceRoot, environment, run });
  const finalProvenance = currentGitProvenance({ cwd: workspaceRoot });
  assertCleanHead(finalProvenance);
  if (finalProvenance.headCommit !== provenance.headCommit) throw new Error('strict runtime source changed during preparation');
  const copiedCertificate = path.join(root, 'release-code-signing.cer');
  fs.copyFileSync(certificate.certificatePath, copiedCertificate, fs.constants.COPYFILE_EXCL);
  const unsigned = {
    schemaVersion: STRICT_RUNTIME_AUTHORITY_SCHEMA_VERSION,
    artifactKind: STRICT_RUNTIME_AUTHORITY_KIND,
    generatedAt: new Date().toISOString(),
    releaseId,
    provenance,
    implementationHashes: currentAuthorityImplementationHashes({ workspaceRoot }),
    runtimeBinaryHashes: currentAuthorityRuntimeBinaryHashes({ workspaceRoot }),
    certificate: {
      signingMode: certificate.signingMode,
      trustScope: 'vmware-testsigning-only',
      publicProductionTrust: false,
      subject: certificate.subject,
      thumbprint: certificate.thumbprint,
      hashAlgorithm: certificate.hashAlgorithm,
      keyAlgorithm: certificate.keyAlgorithm,
      keyLength: certificate.keyLength,
      enhancedKeyUsage: certificate.enhancedKeyUsage,
      notBefore: certificate.notBefore,
      notAfter: certificate.notAfter,
      certificateAuthority: fileAuthorityEntry(copiedCertificate, 'release-code-signing.cer'),
    },
    aec3Gate: {
      verdict: 'passed',
      command: 'npm run test:aec3-msvc',
      authority: fileAuthorityEntry(aecLog, 'aec3-msvc-gate.log'),
    },
  };
  const authority = { ...unsigned, authorityDigest: digest(unsigned) };
  const authorityPath = path.join(root, STRICT_RUNTIME_AUTHORITY_FILE);
  writeJsonExclusive(authorityPath, authority);
  verifyStrictRuntimeAuthority(authorityPath, { workspaceRoot, provenance });
  return { authorityPath, authority };
}

if (isMain(import.meta.url)) {
  try {
    const options = parseCliArgs(process.argv.slice(2), {
      defaults: { outputRoot: STRICT_RUNTIME_ROOT, releaseId: '' },
    });
    const result = prepareStrictRuntimeAuthority({
      outputRoot: options.outputRoot,
      ...(options.releaseId ? { releaseId: options.releaseId } : {}),
    });
    console.log(result.authorityPath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
