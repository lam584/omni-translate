import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { isMain, repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import { createVm3TestEnvironment } from './run-with-vm3-test-environment.mjs';
import { buildStrictSshArgs, verifyPinnedKnownHost } from './watch-worker-bootstrap.mjs';
import {
  canonicalJson, sha256Canonical, signCoordinatorAuthority, verifyCoordinatorAuthority,
} from './watch-mode-shard-authority.mjs';

export const FROZEN_FUNNEL_RUNNER = 'scripts/testing/frozen-test-funnel-distributed.mjs';
export const FROZEN_FUNNEL_STEPS = Object.freeze([
  ['contracts', 'test:contracts', 0],
  ['powershell-tooling', 'test:powershell-tooling', 0],
  ['audit-powershell-boundaries', 'audit:powershell-boundaries:strict', 0],
  ['audit-architecture', 'audit:architecture', 0],
  ['watch-mode-coordinator-tooling', 'test:watch-mode-coordinator-tooling', 0],
  ['integration-bridge-contract', 'test:integration:bridge-contract', 1],
  ['check-bridge-service-native', 'check:bridge-service-native', 1],
  ['test-bridge-service-native', 'test:bridge-service-native', 1],
  ['check-desktop-shell', 'check:desktop-shell', 2],
  ['test-desktop-shell', 'test:desktop-shell', 2],
  ['verify-desktop', 'verify:desktop', 0],
  ['watch-mode-tooling', 'test:watch-mode-report', 0],
  ['benchmark-core-tests', 'test:benchmark-core', 2],
  ['diagnostics-benchmark-tests', 'test:diagnostics-benchmark', 2],
].map(([name, script, group]) => Object.freeze({ name, command: `npm run ${script}`, script, group })));

const PLAN_KIND = 'frozen-test-funnel-plan';
const RESULT_KIND = 'frozen-test-funnel-worker-result';
const AUTHORITY_KIND = 'frozen-test-funnel-authority';
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/iu;
const HEAD = /^[a-f0-9]{40}$/iu;
const SHA = /^[a-f0-9]{64}$/iu;
const MAX_WORKER_MS = 60 * 60 * 1000;
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

export function frozenFunnelFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\')
      || relative.split('/').some((part) => !part || part === '..' || part === '.')
      || path.posix.isAbsolute(relative) || /^[a-z]:/iu.test(relative)) throw new Error('funnel artifact path is unsafe');
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relative.split('/'));
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('funnel artifact escapes root');
  for (let current = target; ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('funnel artifact has reparse ancestry');
    if (current === path.dirname(current)) break;
  }
  return target;
}

export function frozenFunnelFileEntry(root, relative) {
  const candidate = frozenFunnelFile(root, relative);
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile()) throw new Error('funnel artifact must be a regular file');
  return { path: relative, bytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex') };
}

function verifyInventory(root, entries) {
  if (!Array.isArray(entries) || !entries.length || new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new Error('funnel inventory is empty or duplicated');
  for (const entry of entries) {
    if (!same(frozenFunnelFileEntry(root, entry.path), entry)) throw new Error(`funnel artifact hash mismatch: ${entry.path}`);
  }
}

function cleanHead(provenance, expectedHead) {
  if (provenance?.worktreeClean !== true || Number(provenance?.dirtyEntryCount) !== 0
      || !HEAD.test(provenance?.headCommit ?? '') || (expectedHead && provenance.headCommit !== expectedHead)) {
    throw new Error('funnel requires the exact clean HEAD');
  }
}

function workerProjection(worker) {
  return {
    workerId: worker.workerId, user: worker.user, workspaceRoot: worker.workspaceRoot,
    uuidBios: String(worker.vmIdentity?.uuidBios ?? '').toLowerCase(),
    transportAuthority: worker.transport?.kind === 'local' ? { kind: 'local' } : {
      kind: 'ssh', hostKeyAlias: worker.transport?.hostKeyAlias,
      hostKeyAlgorithm: worker.transport?.hostKeyAlgorithm, hostKeySha256: worker.transport?.hostKeySha256,
    },
  };
}

function assignments(workers) {
  return FROZEN_FUNNEL_STEPS.map(({ name, command, group }) => ({ name, command, workerId: workers[group % workers.length].workerId }));
}

export function createFrozenFunnelPlan({ workers, provenance, runtimeAuthority, privateKeyPem, publicKeyPem, executionId = `funnel-${crypto.randomUUID()}` }) {
  cleanHead(provenance);
  const plan = signCoordinatorAuthority({
    schemaVersion: 1, artifactKind: PLAN_KIND, executionId, providerCalls: 0,
    headCommit: provenance.headCommit, runtimeAuthorityDigest: runtimeAuthority.authorityDigest,
    implementationHashes: runtimeAuthority.implementationHashes, runtimeBinaryHashes: runtimeAuthority.runtimeBinaryHashes,
    workers: workers.map(workerProjection), steps: assignments(workers), workerTimeoutMs: MAX_WORKER_MS,
  }, privateKeyPem, publicKeyPem);
  return verifyFrozenFunnelPlan(plan, { publicKeyPem, provenance, runtimeAuthority });
}

export function verifyFrozenFunnelPlan(plan, { publicKeyPem, provenance, runtimeAuthority } = {}) {
  verifyCoordinatorAuthority(plan, publicKeyPem, 'frozen funnel plan');
  if (plan.schemaVersion !== 1 || plan.artifactKind !== PLAN_KIND || !SAFE_ID.test(plan.executionId)
      || plan.providerCalls !== 0 || !HEAD.test(plan.headCommit) || !SHA.test(plan.runtimeAuthorityDigest)
      || plan.workerTimeoutMs !== MAX_WORKER_MS || !Array.isArray(plan.workers) || plan.workers.length < 1 || plan.workers.length > 3) throw new Error('funnel plan schema is invalid');
  const ids = new Set(); const bios = new Set(); const pins = new Set();
  for (const worker of plan.workers) {
    if (!SAFE_ID.test(worker.workerId) || !worker.user || !path.win32.isAbsolute(worker.workspaceRoot)
        || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(worker.uuidBios)
        || ids.has(worker.workerId) || bios.has(worker.uuidBios.toLowerCase())) throw new Error('funnel worker identity is invalid or duplicated');
    ids.add(worker.workerId); bios.add(worker.uuidBios.toLowerCase());
    const trust = worker.transportAuthority;
    if (trust?.kind !== 'local' && (trust?.kind !== 'ssh' || !trust.hostKeyAlias || !trust.hostKeyAlgorithm
        || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(trust.hostKeySha256) || pins.has(trust.hostKeySha256))) throw new Error('funnel worker SSH pin is invalid or duplicated');
    if (trust.kind === 'ssh') pins.add(trust.hostKeySha256);
  }
  if (!same(plan.steps, assignments(plan.workers))) throw new Error('funnel steps do not match the fixed complete allowlist');
  if (!Array.isArray(plan.implementationHashes) || !plan.implementationHashes.some((entry) => entry.path === FROZEN_FUNNEL_RUNNER)
      || !Array.isArray(plan.runtimeBinaryHashes) || !plan.runtimeBinaryHashes.length) throw new Error('funnel plan lacks frozen implementation/runtime inventory');
  for (const inventory of [plan.implementationHashes, plan.runtimeBinaryHashes]) {
    if (new Set(inventory.map((entry) => entry.path)).size !== inventory.length) throw new Error('funnel plan inventory is duplicated');
    for (const entry of inventory) {
      if (typeof entry.path !== 'string' || !/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/iu.test(entry.path)
          || entry.path.split('/').some((part) => part === '.' || part === '..')
          || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !SHA.test(entry.sha256)) throw new Error('funnel plan inventory entry is invalid');
    }
  }
  if (provenance) cleanHead(provenance, plan.headCommit);
  if (runtimeAuthority && (runtimeAuthority.authorityDigest !== plan.runtimeAuthorityDigest
      || !same(runtimeAuthority.implementationHashes, plan.implementationHashes)
      || !same(runtimeAuthority.runtimeBinaryHashes, plan.runtimeBinaryHashes))) throw new Error('funnel plan runtime binding mismatch');
  return plan;
}

export async function runFrozenFunnelPipelines({ plan, executeStep }) {
  const settled = await Promise.allSettled(plan.workers.map(async (worker) => {
    const results = [];
    for (const step of plan.steps.filter((entry) => entry.workerId === worker.workerId)) {
      try { results.push(await executeStep({ worker, step })); }
      catch { results.push({ name: step.name, command: step.command, workerId: worker.workerId, verdict: 'failed', errorCode: 'funnel.step.failed' }); }
    }
    return { workerId: worker.workerId, results };
  }));
  return settled.map((entry, index) => entry.status === 'fulfilled' ? entry.value : {
    workerId: plan.workers[index].workerId, results: [], errorCode: 'funnel.worker.failed',
  });
}

function observeWorker(workspaceRoot) {
  const identity = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::Write((Get-CimInstance Win32_ComputerSystemProduct).UUID)'], { encoding: 'utf8', windowsHide: true });
  if (identity.error || identity.status !== 0) throw new Error('funnel BIOS identity query failed');
  return { uuidBios: identity.stdout.trim().toLowerCase(), provenance: currentGitProvenance({ cwd: workspaceRoot }) };
}

function validateObservation(observation, worker, plan) {
  cleanHead(observation?.provenance, plan.headCommit);
  if (observation?.uuidBios !== worker.uuidBios) throw new Error('funnel actual BIOS UUID mismatch');
}

export function runFrozenFunnelStep(step, logPath, { workspaceRoot = repoRoot, timeoutMs = MAX_WORKER_MS, spawnCommand = spawn, createOutputStream = fs.createWriteStream } = {}) {
  const allowed = FROZEN_FUNNEL_STEPS.find((entry) => entry.name === step.name && entry.command === step.command);
  if (!allowed) throw new Error('funnel command is not allowlisted');
  fs.mkdirSync(path.join(workspaceRoot, 'artifacts/testing/temp'), { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(workspaceRoot, 'artifacts/testing/temp/frozen-funnel-'));
  const environment = createVm3TestEnvironment({ temporaryRoot });
  // A worker executes only one test layer at a time; never consume all guest RAM.
  environment.CARGO_BUILD_JOBS = '2';
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const output = createOutputStream(logPath, { flags: 'wx' });
    const child = spawnCommand(process.execPath, [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), 'run', allowed.script], {
      cwd: workspaceRoot, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false; let flushing = false;
    const finish = (result, discard = false) => {
      if (settled) return;
      child.stdout.unpipe(output); child.stderr.unpipe(output);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      if (discard) {
        settled = true; clearTimeout(timer); output.destroy(); resolve(result);
      } else if (!flushing) {
        flushing = true;
        // Keep the deadline armed while the final log bytes are flushing. A
        // stream error or timeout may still replace this provisional success.
        output.end((error) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          resolve(error ? failed('funnel.step.log-failed') : result);
        });
      }
    };
    const failed = (errorCode) => ({
      name: step.name, command: step.command, workerId: step.workerId, startedAt,
      completedAt: new Date().toISOString(), exitCode: null, signal: null,
      verdict: 'failed', errorCode, cleanupComplete: false,
    });
    const timer = setTimeout(() => {
      child.kill(); finish(failed('funnel.step.timeout'), true);
    }, timeoutMs);
    output.once('error', () => { child.kill(); finish(failed('funnel.step.log-failed'), true); });
    child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
    child.once('error', () => finish(failed('funnel.step.spawn-failed'), true));
    child.once('close', (code, signal) => {
      finish({
        name: step.name, command: step.command, workerId: step.workerId, startedAt, completedAt: new Date().toISOString(),
        exitCode: code, signal: signal ?? null, verdict: code === 0 ? 'passed' : 'failed',
      });
    });
  });
}

export async function runFrozenFunnelWorker({ plan, workerId, publicKeyPem, workspaceRoot = repoRoot, outputRoot, observe = observeWorker, runStep = runFrozenFunnelStep }) {
  verifyFrozenFunnelPlan(plan, { publicKeyPem });
  const worker = plan.workers.find((entry) => entry.workerId === workerId);
  if (!worker || path.win32.resolve(workspaceRoot).toLowerCase() !== path.win32.resolve(worker.workspaceRoot).toLowerCase()) throw new Error('funnel worker workspace does not match signed plan');
  const canonicalOutput = path.resolve(workspaceRoot, 'artifacts/testing/frozen-funnel-workers', plan.executionId, workerId);
  if (path.resolve(outputRoot) !== canonicalOutput) throw new Error('funnel worker output root is not canonical');
  frozenFunnelFile(workspaceRoot, `artifacts/testing/frozen-funnel-workers/${plan.executionId}/${workerId}`);
  const before = observe(workspaceRoot); validateObservation(before, worker, plan);
  verifyInventory(workspaceRoot, plan.implementationHashes); verifyInventory(workspaceRoot, plan.runtimeBinaryHashes);
  fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: false });
  write(path.join(outputRoot, 'execution-claim.json'), { executionId: plan.executionId, planDigest: plan.digest, workerId });
  const results = []; const deadline = Date.now() + plan.workerTimeoutMs;
  for (const step of plan.steps.filter((entry) => entry.workerId === workerId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || results.some((entry) => entry.cleanupComplete === false)) {
      results.push({ ...step, verdict: 'failed', errorCode: 'funnel.worker.deadline' }); continue;
    }
    try {
      const logPath = path.join(outputRoot, `${step.name}.log`);
      const result = await runStep(step, logPath, { workspaceRoot, timeoutMs: remaining });
      results.push({ ...result, log: frozenFunnelFileEntry(outputRoot, `${step.name}.log`) });
    } catch { results.push({ ...step, verdict: 'failed', errorCode: 'funnel.step.failed', cleanupComplete: false }); }
  }
  const after = observe(workspaceRoot); validateObservation(after, worker, plan);
  verifyInventory(workspaceRoot, plan.implementationHashes); verifyInventory(workspaceRoot, plan.runtimeBinaryHashes);
  const result = {
    schemaVersion: 1, artifactKind: RESULT_KIND, executionId: plan.executionId, planDigest: plan.digest,
    workerId, providerCalls: 0, before, after, results,
    verdict: results.every((entry) => entry.verdict === 'passed') ? 'passed' : 'failed',
  };
  write(path.join(outputRoot, 'worker-result.json'), result);
  return result;
}

export function verifyFrozenFunnelWorkerResult(result, { plan, workerId, artifactRoot }) {
  const worker = plan.workers.find((entry) => entry.workerId === workerId);
  if (!worker || result?.schemaVersion !== 1 || result?.artifactKind !== RESULT_KIND || result.executionId !== plan.executionId
      || result.planDigest !== plan.digest || result.workerId !== workerId || result.providerCalls !== 0 || !Array.isArray(result.results)) throw new Error('funnel worker result binding mismatch');
  validateObservation(result.before, worker, plan); validateObservation(result.after, worker, plan);
  const expected = plan.steps.filter((entry) => entry.workerId === workerId);
  if (!same(result.results.map(({ name, command, workerId: id }) => ({ name, command, workerId: id })), expected)) throw new Error('funnel worker result step coverage mismatch');
  let previousCompleted = -Infinity;
  for (const entry of result.results) {
    if (entry.verdict !== 'passed' || entry.exitCode !== 0 || entry.signal !== null
        || !Number.isFinite(Date.parse(entry.startedAt)) || !Number.isFinite(Date.parse(entry.completedAt))
        || Date.parse(entry.completedAt) < Date.parse(entry.startedAt)
        || Date.parse(entry.completedAt) - Date.parse(entry.startedAt) > plan.workerTimeoutMs
        || Date.parse(entry.startedAt) < previousCompleted
        || !entry.log || entry.log.path !== `${entry.name}.log`) throw new Error('funnel worker step did not pass');
    if (!same(frozenFunnelFileEntry(artifactRoot, entry.log.path), entry.log)) throw new Error('funnel worker log changed');
    previousCompleted = Date.parse(entry.completedAt);
  }
  if (result.verdict !== 'passed') throw new Error('funnel worker did not pass');
  return result;
}

export async function collectFrozenFunnelWorkers({ plan, executeWorker, outputRoot }) {
  const settled = await Promise.allSettled(plan.workers.map((worker) => Promise.resolve().then(() => executeWorker(worker))));
  const collected = settled.map((entry, index) => ({
    workerId: plan.workers[index].workerId, status: entry.status,
    ...(entry.status === 'fulfilled' ? { result: entry.value } : { errorCode: 'funnel.worker.failed' }),
  }));
  write(path.join(outputRoot, 'worker-collection.json'), collected);
  if (collected.some((entry) => entry.status !== 'fulfilled')) throw new Error('funnel worker collection incomplete; all independent workers have settled');
  return collected.map((entry) => entry.result);
}

export function createFrozenFunnelAuthority({ plan, outputRoot, privateKeyPem, publicKeyPem }) {
  verifyFrozenFunnelPlan(plan, { publicKeyPem });
  const workers = plan.workers.map((worker) => {
    const relative = `workers/${worker.workerId}/worker-result.json`;
    const result = json(frozenFunnelFile(outputRoot, relative));
    verifyFrozenFunnelWorkerResult(result, { plan, workerId: worker.workerId, artifactRoot: path.join(outputRoot, 'workers', worker.workerId) });
    return { workerId: worker.workerId, result: frozenFunnelFileEntry(outputRoot, relative) };
  });
  return signCoordinatorAuthority({ schemaVersion: 1, artifactKind: AUTHORITY_KIND, plan, workers, verdict: 'passed', providerCalls: 0 }, privateKeyPem, publicKeyPem);
}

export function verifyFrozenFunnelAuthority(authority, { publicKeyPem, provenance, runtimeAuthority, artifactRoot }) {
  verifyCoordinatorAuthority(authority, publicKeyPem, 'frozen funnel authority');
  verifyFrozenFunnelPlan(authority.plan, { publicKeyPem, provenance, runtimeAuthority });
  if (authority.schemaVersion !== 1 || authority.artifactKind !== AUTHORITY_KIND || authority.verdict !== 'passed' || authority.providerCalls !== 0
      || !same(authority.workers?.map((entry) => entry.workerId), authority.plan.workers.map((entry) => entry.workerId))) throw new Error('funnel aggregate worker coverage mismatch');
  const results = [];
  for (const worker of authority.workers) {
    const relative = `workers/${worker.workerId}/worker-result.json`;
    if (worker.result.path !== relative || !same(frozenFunnelFileEntry(artifactRoot, relative), worker.result)) throw new Error('funnel worker result inventory changed');
    results.push(verifyFrozenFunnelWorkerResult(json(frozenFunnelFile(artifactRoot, relative)), {
      plan: authority.plan, workerId: worker.workerId, artifactRoot: path.join(artifactRoot, 'workers', worker.workerId),
    }));
  }
  return results;
}

const psEncoded = (body) => ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')];
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function runFrozenFunnelTransportProcess(command, args, { timeoutMs = 120_000, spawnCommand = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let bytes = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      if (error) reject(error); else resolve(output);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('funnel transport timeout; remote cleanup is unconfirmed')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes < 1024 * 1024) output += chunk; });
    child.stderr.resume();
    child.once('error', () => finish(new Error('funnel transport spawn failed')));
    child.once('close', (code) => finish(code === 0 ? null : new Error('funnel transport failed')));
  });
}

export function createFrozenFunnelTransport({ config, plan, planPath, publicKeyPath, outputRoot, run = runFrozenFunnelTransportProcess }) {
  return async (signedWorker) => {
    const worker = config.workers.find((entry) => entry.workerId === signedWorker.workerId);
    if (!worker || !same(workerProjection(worker), signedWorker)) throw new Error('funnel transport identity differs from signed worker');
    const localRoot = path.join(outputRoot, 'workers', worker.workerId);
    const workerOutput = path.win32.join(worker.workspaceRoot, 'artifacts/testing/frozen-funnel-workers', plan.executionId, worker.workerId);
    const invokeArgs = [FROZEN_FUNNEL_RUNNER, '--worker-plan', planPath, '--worker-id', worker.workerId, '--public-key', publicKeyPath, '--output-root', workerOutput];
    fs.mkdirSync(path.dirname(localRoot), { recursive: true });
    if (worker.transport.kind === 'local') {
      await run(process.execPath, invokeArgs, { timeoutMs: MAX_WORKER_MS + 120_000 });
      fs.cpSync(workerOutput, localRoot, { recursive: true, errorOnExist: true, force: false });
    } else {
      verifyPinnedKnownHost(worker);
      const ssh = (body, options) => run(config.sshExecutable, [...buildStrictSshArgs({ worker }), ...psEncoded(body)], options);
      const scpArgs = buildStrictSshArgs({ worker }).slice(0, -1);
      scpArgs[scpArgs.indexOf('-p')] = '-P';
      const remote = (file) => `${worker.user}@${worker.transport.host}:${file.replaceAll('\\', '/')}`;
      const requestRoot = path.win32.join(worker.workspaceRoot, 'artifacts/testing/frozen-funnel-requests', plan.executionId, worker.workerId);
      const remotePlan = path.win32.join(requestRoot, 'plan.json');
      const remoteKey = path.win32.join(requestRoot, 'public.pem');
      const assertSource = `$ErrorActionPreference='Stop'; Set-Location -LiteralPath ${psQuote(worker.workspaceRoot)}; if(([string](Get-CimInstance Win32_ComputerSystemProduct).UUID).ToLowerInvariant() -cne ${psQuote(signedWorker.uuidBios)}){throw 'funnel BIOS mismatch'}; $head=(& git.exe rev-parse HEAD); if($LASTEXITCODE -ne 0 -or $head -cne ${psQuote(plan.headCommit)}){throw 'funnel HEAD mismatch'}; $dirty=@(& git.exe status --porcelain=v1 --untracked-files=all); if($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0){throw 'funnel workspace is dirty'};`;
      const implementationState = async (entries) => {
        const states = [];
        for (let offset = 0; offset < entries.length; offset += 8) {
          const chunk = entries.slice(offset, offset + 8);
          const rows = chunk.map((entry, index) => {
            const destination = path.win32.join(worker.workspaceRoot, ...entry.path.split('/'));
            return `@(${offset + index},${psQuote(destination)},${entry.bytes},${psQuote(entry.sha256)})`;
          }).join(',');
          const body = `$ErrorActionPreference='Stop'; $rows=@(${rows}); foreach($row in $rows){$p=[string]$row[1];$match=$false;if(Test-Path -LiteralPath $p -PathType Leaf){$item=Get-Item -LiteralPath $p -Force;if(-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $item.Length -eq [long]$row[2]){$stream=[IO.File]::OpenRead($p);try{$hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose()};$match=$hash -ceq [string]$row[3]}};[Console]::WriteLine(([string]$row[0])+'|'+$(if($match){'MATCH'}else{'MISMATCH'}))}`;
          const output = await ssh(body);
          for (const line of output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
            const match = /^(\d+)\|(MATCH|MISMATCH)$/u.exec(line);
            if (!match) throw new Error('funnel implementation inventory probe returned invalid output');
            states[Number(match[1])] = match[2];
          }
        }
        if (states.length !== entries.length || entries.some((_, index) => states[index] !== 'MATCH' && states[index] !== 'MISMATCH')) {
          throw new Error('funnel implementation inventory probe was incomplete');
        }
        return states;
      };
      await ssh(`${assertSource} if(Test-Path -LiteralPath ${psQuote(requestRoot)}){throw 'funnel request already exists'}; New-Item -ItemType Directory -Path ${psQuote(requestRoot)} | Out-Null`);
      await run(config.scpExecutable, [...scpArgs, planPath, remote(remotePlan)]);
      await run(config.scpExecutable, [...scpArgs, publicKeyPath, remote(remoteKey)]);
      const implementationStates = await implementationState(plan.implementationHashes);
      for (const [index, entry] of plan.implementationHashes.entries()) {
        if (implementationStates[index] === 'MATCH') continue;
        const source = frozenFunnelFile(repoRoot, entry.path);
        if (!same(frozenFunnelFileEntry(repoRoot, entry.path), entry)) throw new Error('funnel signed implementation source changed during distribution');
        const stage = path.win32.join(requestRoot, `implementation-${index}.bin`);
        const destination = path.win32.join(worker.workspaceRoot, ...entry.path.split('/'));
        await run(config.scpExecutable, [...scpArgs, source, remote(stage)]);
        await ssh(`$ErrorActionPreference='Stop'; $stage=${psQuote(stage)}; $destination=${psQuote(destination)}; if(-not (Test-Path -LiteralPath $stage -PathType Leaf)){throw 'funnel implementation stage missing'}; for($p=$stage; $p; $p=[IO.Path]::GetDirectoryName($p)){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'funnel implementation stage reparse path'}}; $item=Get-Item -LiteralPath $stage -Force;if($item.Length -ne ${entry.bytes}){throw 'funnel implementation transfer mismatch'};$stream=[IO.File]::OpenRead($stage);try{$hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose()};if($hash -cne ${psQuote(entry.sha256)}){throw 'funnel implementation transfer mismatch'};for($p=$destination; $p; $p=[IO.Path]::GetDirectoryName($p)){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'funnel implementation reparse path'}};New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null;Move-Item -LiteralPath $stage -Destination $destination -Force`);
      }
      await ssh(assertSource);
      if ((await implementationState(plan.implementationHashes)).some((state) => state !== 'MATCH')) {
        throw new Error('funnel implementation inventory remains mismatched after repair');
      }
      // Only the signed runtime inventory may be replaced. Source synchronisation
      // remains a separate clean-HEAD operation, never an implicit checkout.
      for (const [index, entry] of plan.runtimeBinaryHashes.entries()) {
        const source = frozenFunnelFile(repoRoot, entry.path);
        if (!same(frozenFunnelFileEntry(repoRoot, entry.path), entry)) throw new Error('funnel source runtime changed during distribution');
        const stage = path.win32.join(requestRoot, `runtime-${index}.bin`);
        const destination = path.win32.join(worker.workspaceRoot, ...entry.path.split('/'));
        await run(config.scpExecutable, [...scpArgs, source, remote(stage)]);
        await ssh(`$ErrorActionPreference='Stop'; $stage=${psQuote(stage)}; $destination=${psQuote(destination)}; if((Get-Item -LiteralPath $stage).Length -ne ${entry.bytes} -or (Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${psQuote(entry.sha256)}){throw 'funnel runtime transfer mismatch'}; for($p=$destination; $p; $p=[IO.Path]::GetDirectoryName($p)){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'funnel runtime reparse path'}}; New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null; Move-Item -LiteralPath $stage -Destination $destination -Force`);
      }
      const runnerHash = plan.implementationHashes.find((entry) => entry.path === FROZEN_FUNNEL_RUNNER).sha256;
      const runnerPath = path.win32.join(worker.workspaceRoot, FROZEN_FUNNEL_RUNNER);
      let launchError;
      try {
        await ssh(`${assertSource} if((Get-FileHash -LiteralPath ${psQuote(runnerPath)} -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${psQuote(runnerHash)}){throw 'funnel runner hash mismatch'}; & node.exe ${psQuote(runnerPath)} '--worker-plan' ${psQuote(remotePlan)} '--worker-id' ${psQuote(worker.workerId)} '--public-key' ${psQuote(remoteKey)} '--output-root' ${psQuote(workerOutput)}; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`, { timeoutMs: MAX_WORKER_MS + 120_000 });
      } catch (error) { launchError = error; }
      const outputExists = (await ssh(`if(Test-Path -LiteralPath ${psQuote(workerOutput)} -PathType Container){[Console]::Write('EXISTS')}else{[Console]::Write('MISSING')}`)).trim();
      if (outputExists !== 'EXISTS') {
        if (launchError) throw launchError;
        throw new Error('funnel worker output is missing after launch');
      }
      try { await run(config.scpExecutable, [...scpArgs, '-r', remote(workerOutput), localRoot]); }
      catch (error) { if (launchError) throw launchError; throw error; }
      if (launchError) throw launchError;
    }
    return verifyFrozenFunnelWorkerResult(json(path.join(localRoot, 'worker-result.json')), { plan, workerId: worker.workerId, artifactRoot: localRoot });
  };
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const take = (flag) => args[args.indexOf(flag) + 1];
    if (!args.includes('--worker-plan') || !args.includes('--worker-id') || !args.includes('--public-key') || !args.includes('--output-root')) throw new Error('funnel worker arguments are incomplete');
    const plan = json(take('--worker-plan'));
    const workerId = take('--worker-id');
    const outputRoot = path.resolve(take('--output-root'));
    const expected = path.resolve(repoRoot, 'artifacts/testing/frozen-funnel-workers', plan.executionId, workerId);
    if (outputRoot !== expected) throw new Error('funnel worker output root is not canonical');
    await runFrozenFunnelWorker({ plan, workerId, outputRoot, publicKeyPem: fs.readFileSync(take('--public-key'), 'utf8') });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
