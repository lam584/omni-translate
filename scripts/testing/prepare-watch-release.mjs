import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMain, repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import { prepareStrictRuntimeAuthority, verifyStrictRuntimeAuthority } from './watch-mode-strict-runtime-authority.mjs';
import { readProductionWorkerConfig, validateProductionWorkerConfig, windowsPowerShellEnvironment } from './run-watch-mode-live-production-coordinator.mjs';
import { buildStrictSshArgs, validateWorkerPins, verifyPinnedKnownHost } from './watch-worker-bootstrap.mjs';
import { runLocalIsolationProcess } from './watch-mode-local-isolation-distributed.mjs';

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const encoded = (body) => ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')];
const defaults = {
  provenance: ({ workspaceRoot }) => currentGitProvenance({ cwd: workspaceRoot }),
  preflight: preflightWatchRelease,
  prepareStrictRuntimeAuthority: (options) => prepareStrictRuntimeAuthority({ ...options,
    run: (command, args, settings) => spawnSync(command, args, { ...settings, env: { ...settings.env, CARGO_BUILD_JOBS: '2' } }),
  }),
  verifyStrictRuntimeAuthority,
  distributeWatchRuntime: async (options) => {
    const { distributeWatchRuntime } = await import('./distribute-watch-runtime.mjs');
    return distributeWatchRuntime(options);
  },
};

/** Every invocation owns fresh records; reuse requires an explicit completed authority. */
export async function prepareWatchRelease({ workersConfig, runtimeAuthorityPath, releaseId,
  workspaceRoot = repoRoot, operations = {} } = {}) {
  if (!workersConfig) throw new Error('--workers-config is required');
  workspaceRoot = path.resolve(workspaceRoot);
  const ops = { ...defaults, ...operations };
  const executionId = `prepare-${crypto.randomUUID()}`;
  const parent = path.join(workspaceRoot, 'artifacts/testing/watch-release-prepare');
  fs.mkdirSync(parent, { recursive: true });
  const operationRoot = path.join(parent, executionId);
  fs.mkdirSync(operationRoot);
  const recordPath = path.join(operationRoot, 'outcome.json');
  const record = { schemaVersion: 1, executionId, releaseId: releaseId ?? null,
    outcome: 'running', started: new Date().toISOString(), completed: null, durationMs: null,
    reuse: Boolean(runtimeAuthorityPath), cache: runtimeAuthorityPath ? 'explicit-authority-verification-required' : 'none',
    cargoBuildJobs: 2, providerInvocations: 0, stages: [], failures: [] };
  const started = performance.now();
  const save = () => fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  save();
  const stage = async (name, action) => {
    const entry = { name, started: new Date().toISOString(), completed: null, durationMs: null, outcome: 'running' };
    record.stages.push(entry); save();
    const start = performance.now();
    try { const result = await action(); entry.outcome = 'passed'; return result; }
    catch (error) {
      entry.outcome = 'failed';
      record.failures.push({ stage: name, name: error.name, message: error.message,
        code: error.code ?? null, rootCause: 'undetermined', automaticRetry: false });
      throw error;
    } finally { entry.completed = new Date().toISOString(); entry.durationMs = performance.now() - start; save(); }
  };
  try {
    const provenance = await stage('clean-head', async () => {
      const value = await ops.provenance({ workspaceRoot }); assertClean(value); return value;
    });
    record.preflight = await stage('transport-preflight', async () => {
      const result = await ops.preflight({ workersConfig, workspaceRoot, provenance, operationRoot });
      if (result?.schemaVersion !== 1 || result?.verified !== true || !result.workers?.length
          || result.workers.some((w) => w.verified !== true || w.headCommit !== provenance.headCommit)) {
        throw new Error('transport preflight did not return verified schema-v1 worker evidence');
      }
      return result;
    });
    const runtime = await stage(runtimeAuthorityPath ? 'verify-runtime-authority' : 'build-runtime-authority', async () => {
      const result = runtimeAuthorityPath
        ? await ops.verifyStrictRuntimeAuthority(runtimeAuthorityPath, { workspaceRoot, provenance })
        : await ops.prepareStrictRuntimeAuthority({ workspaceRoot, ...(releaseId ? { releaseId } : {}) });
      if (!result?.authorityPath) throw new Error('runtime preparation did not return authorityPath');
      return result;
    });
    record.runtimeAuthorityPath = runtime.authorityPath;
    record.cache = runtimeAuthorityPath ? 'verified-completed-authority' : 'built-once';
    const distribution = await stage('distribute-runtime', async () => {
      const result = await ops.distributeWatchRuntime({ runtimeAuthorityPath: runtime.authorityPath, workersConfig, workspaceRoot });
      // Resolving the distributor contract means all remote verification completed.
      if (result?.schemaVersion !== 1 || result?.artifactKind !== 'watch-runtime-distribution' || result?.status !== 'success'
          || !Array.isArray(result.workers) || result.workers.length !== record.preflight.workers.length
          || record.preflight.workers.some((worker) => result.workers.filter((entry) => entry.workerId === worker.workerId).length !== 1)) {
        throw new Error('runtime distribution reported failure');
      }
      return result;
    });
    record.outcome = 'ready';
    return { ready: true, executionId, operationRoot, recordPath, runtimeAuthorityPath: runtime.authorityPath, distribution };
  } catch (error) {
    record.outcome = 'failed'; error.recordPath = recordPath; throw error;
  } finally {
    record.completed = new Date().toISOString(); record.durationMs = performance.now() - started; save();
  }
}

export function parsePrepareWatchReleaseArgs(argv) {
  const names = { '--workers-config': 'workersConfig', '--runtime-authority': 'runtimeAuthorityPath', '--release-id': 'releaseId' };
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = names[argv[i]];
    if (!name || options[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`invalid argument: ${argv[i]}`);
    options[name] = argv[i + 1];
  }
  if (!options.workersConfig) throw new Error('--workers-config is required');
  return options;
}

if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await prepareWatchRelease(parsePrepareWatchReleaseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(`${error.message}${error.recordPath ? `; records: ${error.recordPath}` : ''}`); process.exitCode = 1; }
}
function assertClean(p) {
  if (p?.captureStatus !== 'captured' || p.worktreeClean !== true || p.dirtyEntryCount !== 0 || !/^[a-f0-9]{40}$/iu.test(p.headCommit ?? '')) {
    throw new Error('watch release requires clean HEAD; source sync is a prerequisite (no reset or dirty repair)');
  }
}

/** Only transport probes; never invoke runtime, driver, audio or Provider. */
export async function preflightWatchRelease({ workersConfig, workspaceRoot, provenance, operationRoot, run = runLocalIsolationProcess }) {
  const env = windowsPowerShellEnvironment();
  if (process.platform === 'win32') {
    // Preserve caller PATH priority; Git for Windows also ships SSH/SCP in usr/bin.
    const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
    const entries = (env[pathKeys[0]] ?? '').split(';').filter(Boolean);
    const candidates = [path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin'),
      ...entries.filter((entry) => /[\\/]git[\\/]cmd$/iu.test(entry))
        .map((entry) => path.win32.join(entry, '..', 'usr', 'bin'))];
    for (const candidate of candidates) {
      if (!entries.some((entry) => entry.toLowerCase() === candidate.toLowerCase())
          && ['ssh.exe', 'scp.exe'].every((file) => fs.existsSync(path.join(candidate, file)))) entries.push(candidate);
    }
    for (const key of pathKeys) delete env[key];
    env.Path = entries.join(';');
  }
  const config = typeof workersConfig === 'string'
    ? readProductionWorkerConfig(path.resolve(workspaceRoot, workersConfig))
    : validateProductionWorkerConfig(workersConfig, { configDirectory: workspaceRoot });
  const remotes = config.workers.filter((w) => w.transport.kind === 'ssh');
  if (remotes.length) validateWorkerPins(remotes);
  const settled = await Promise.allSettled(config.workers.map(async (worker, index) => {
    const workerRecord = path.join(operationRoot, `worker-${index}.json`);
    const started = new Date().toISOString(); const start = performance.now();
    try {
    const local = worker.transport.kind === 'local';
    if (!local) verifyPinnedKnownHost(worker);
    const args = local ? [] : buildStrictSshArgs({ worker });
    if (!local) args.unshift('-F', 'none', '-o', 'GlobalKnownHostsFile=none', '-o', 'UpdateHostKeys=no');
    const ssh = (body) => local
      ? run('powershell.exe', encoded(body).slice(1), { cwd: worker.workspaceRoot, env })
      : run(config.sshExecutable, [...args, ...encoded(body)], { cwd: workspaceRoot, env });
    // Bounded Git clean guard, not an adversarial byte proof against preserved-mtime edits.
    // Frozen implementation bytes remain the responsibility of subsequent authority hash verification.
    const source = `$ErrorActionPreference='Stop'; Set-Location -LiteralPath ${quote(worker.workspaceRoot)};
$head=(& git.exe rev-parse --verify HEAD); if($LASTEXITCODE -ne 0 -or $head -cne ${quote(provenance.headCommit)}){throw 'HEAD mismatch: source sync prerequisite; no reset or dirty repair'};
$bios=([string](Get-CimInstance Win32_ComputerSystemProduct).UUID).ToLowerInvariant(); if($bios -cne ${quote(worker.vmIdentity.uuidBios.toLowerCase())}){throw 'BIOS mismatch'};
$flags=@(& git.exe ls-files -v); if($LASTEXITCODE -ne 0 -or @($flags | Where-Object { $_ -cmatch '^[a-zS] ' }).Count -ne 0){throw 'masked source content cannot be verified'};
$dirty=@(& git.exe -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all); if($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0){throw 'source is dirty'};
& git.exe -c core.fsmonitor=false diff --no-ext-diff --quiet HEAD --; if($LASTEXITCODE -ne 0){throw 'source content differs from HEAD'};`;
    const remoteRoot = path.win32.join(worker.guestExecutionRoot || worker.workspaceRoot, 'artifacts/testing/watch-release-preflight', path.basename(operationRoot));
    const remoteFile = path.win32.join(remoteRoot, 'tiny.txt');
    const payload = Buffer.from(`watch-release-transport:${crypto.randomUUID()}\n`);
    const localFile = path.join(operationRoot, `tiny-${index}.txt`);
    const readback = path.join(operationRoot, `readback-${index}.txt`);
    fs.writeFileSync(localFile, payload, { flag: 'wx' });
    await ssh(`${source}\nif(Test-Path -LiteralPath ${quote(remoteRoot)}){throw 'preflight execution already exists'}; New-Item -ItemType Directory -Path ${quote(remoteRoot)} | Out-Null`);
    const scpArgs = args.slice(0, -1); if (!local) scpArgs[scpArgs.indexOf('-p')] = '-P';
    const remote = local ? null : `${worker.user}@${worker.transport.host}:${remoteFile.replaceAll('\\', '/')}`;
    if (local) fs.copyFileSync(localFile, remoteFile, fs.constants.COPYFILE_EXCL);
    else await run(config.scpExecutable, [...scpArgs, localFile.replaceAll('\\', '/'), remote], { cwd: workspaceRoot, env });
    const response = await ssh(`$ErrorActionPreference='Stop'; $p=${quote(remoteFile)}; $h=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant(); if($h -cne ${quote(hash(payload))}){throw 'tiny upload hash mismatch'}; [Console]::Write($h)`);
    if (response.stdout.trim() !== hash(payload)) throw new Error(`worker ${worker.workerId}: tiny execution hash mismatch`);
    if (local) fs.copyFileSync(remoteFile, readback, fs.constants.COPYFILE_EXCL);
    else await run(config.scpExecutable, [...scpArgs, remote, readback.replaceAll('\\', '/')], { cwd: workspaceRoot, env });
    if (!fs.readFileSync(readback).equals(payload)) throw new Error(`worker ${worker.workerId}: tiny readback mismatch`);
    const receipt = { schemaVersion: 1, workerId: worker.workerId, headCommit: provenance.headCommit, uuidBios: worker.vmIdentity.uuidBios, remoteFile, sha256: hash(payload), verified: true,
      started, completed: new Date().toISOString(), durationMs: performance.now() - start };
    fs.writeFileSync(workerRecord, JSON.stringify(receipt, null, 2), { encoding: 'utf8', flag: 'wx' });
    return receipt;
    } catch (error) {
      fs.writeFileSync(workerRecord, JSON.stringify({ schemaVersion: 1, workerId: worker.workerId, verified: false,
        started, completed: new Date().toISOString(), durationMs: performance.now() - start,
        failure: { message: error.message, rootCause: 'undetermined' } }, null, 2), { encoding: 'utf8', flag: 'wx' });
      throw error;
    }
  }));
  const failures = settled.filter((r) => r.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((r) => r.reason), `transport preflight failed: ${failures.map((r) => r.reason.message).join('; ')}`);
  return { schemaVersion: 1, verified: true, workers: settled.map((r) => r.value) };
}
