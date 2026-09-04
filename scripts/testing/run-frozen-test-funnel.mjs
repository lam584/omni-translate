import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { compactTimestamp, isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  TEST_RECEIPT_CANONICAL_INDEX,
  createTestReceipt,
} from './watch-mode-test-receipts.mjs';
import { verifyStrictRuntimeAuthority } from './watch-mode-strict-runtime-authority.mjs';
import { fileAuthorityEntry } from './watch-mode-evidence-authority.mjs';
import {
  collectFrozenFunnelWorkers, createFrozenFunnelAuthority, createFrozenFunnelPlan,
  createFrozenFunnelTransport, frozenFunnelFile, verifyFrozenFunnelAuthority,
} from './frozen-test-funnel-distributed.mjs';

const PARALLEL_SAFE_STEPS = Object.freeze([
  { name: 'contracts', command: 'npm run test:contracts' },
  { name: 'powershell-tooling', command: 'npm run test:powershell-tooling' },
  { name: 'audit-powershell-boundaries', command: 'npm run audit:powershell-boundaries:strict' },
  { name: 'audit-architecture', command: 'npm run audit:architecture' },
  { name: 'watch-mode-coordinator-tooling', command: 'npm run test:watch-mode-coordinator-tooling' },
]);

const SERIAL_STEPS = Object.freeze([
  { name: 'integration-bridge-contract', command: 'npm run test:integration:bridge-contract' },
  { name: 'check-bridge-service-native', command: 'npm run check:bridge-service-native' },
  { name: 'test-bridge-service-native', command: 'npm run test:bridge-service-native' },
  { name: 'check-desktop-shell', command: 'npm run check:desktop-shell' },
  { name: 'test-desktop-shell', command: 'npm run test:desktop-shell' },
  { name: 'verify-desktop', command: 'npm run verify:desktop' },
  { name: 'watch-mode-tooling', command: 'npm run test:watch-mode-report' },
  { name: 'benchmark-core-tests', command: 'npm run test:benchmark-core' },
  { name: 'diagnostics-benchmark-tests', command: 'npm run test:diagnostics-benchmark' },
]);

export function runFrozenTestCommand(step, logPath, { spawnCommand = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = new Date();
    const output = fs.createWriteStream(logPath, { flags: 'wx' });
    const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', step.command]
      : ['-lc', step.command];
    const child = spawnCommand(shell, args, { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(output, { end: false });
    child.stderr.pipe(output, { end: false });
    child.once('error', (error) => { output.end(); reject(error); });
    child.once('close', (code, signal) => {
      output.end(() => {
        if (code !== 0) reject(new Error(`${step.name} failed with exit ${code}${signal ? ` (signal ${signal})` : ''}`));
        else resolve({ name: step.name, command: step.command, logPath, startedAt, completedAt: new Date() });
      });
    });
  });
}

export async function runFrozenTestFunnel({ workspaceRoot = repoRoot, runtimeAuthorityPath, workersConfig } = {}) {
  const provenance = currentGitProvenance({ cwd: workspaceRoot });
  if (provenance.worktreeClean !== true || Number(provenance.dirtyEntryCount) !== 0) {
    throw new Error('frozen test funnel requires the exact clean HEAD');
  }
  if (!runtimeAuthorityPath) throw new Error('frozen test funnel requires --runtime-authority');
  const frozenRuntime = verifyStrictRuntimeAuthority(runtimeAuthorityPath, { workspaceRoot, provenance });
  const root = path.resolve(workspaceRoot, 'artifacts', 'testing', 'test-receipts', compactTimestamp());
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root, { recursive: false });
  let results; let distributedAuthority;
  if (workersConfig) {
    const { readProductionWorkerConfig } = await import('./run-watch-mode-live-production-coordinator.mjs');
    const config = readProductionWorkerConfig(path.resolve(workspaceRoot, workersConfig));
    const runtimeRoot = path.dirname(frozenRuntime.authorityPath);
    const publicKeyPath = frozenFunnelFile(runtimeRoot, frozenRuntime.authority.coordinatorSigning.publicKeyAuthority.path);
    const publicKeyPem = fs.readFileSync(publicKeyPath, 'utf8');
    const privateKeyPem = fs.readFileSync(frozenFunnelFile(runtimeRoot, frozenRuntime.authority.coordinatorSigning.privateKeyAuthority.path), 'utf8');
    const plan = createFrozenFunnelPlan({ workers: config.workers, provenance, runtimeAuthority: frozenRuntime.authority, publicKeyPem, privateKeyPem });
    const planPath = path.join(root, 'funnel-plan.json');
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await collectFrozenFunnelWorkers({
      plan, outputRoot: root,
      executeWorker: createFrozenFunnelTransport({ config, plan, planPath, publicKeyPath, outputRoot: root }),
    });
    const authority = createFrozenFunnelAuthority({ plan, outputRoot: root, publicKeyPem, privateKeyPem });
    const workerResults = verifyFrozenFunnelAuthority(authority, {
      publicKeyPem, provenance, runtimeAuthority: frozenRuntime.authority, artifactRoot: root,
    });
    const authorityPath = path.join(root, 'funnel-authority.json');
    fs.writeFileSync(authorityPath, `${JSON.stringify(authority, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    distributedAuthority = { ...fileAuthorityEntry(authorityPath, 'funnel-authority.json'), planDigest: plan.digest };
    results = plan.steps.map((step) => {
      const result = workerResults.find((worker) => worker.workerId === step.workerId).results.find((entry) => entry.name === step.name);
      const logPath = path.join(root, `${step.name}.log`);
      fs.copyFileSync(path.join(root, 'workers', step.workerId, result.log.path), logPath, fs.constants.COPYFILE_EXCL);
      return { ...result, logPath, startedAt: new Date(result.startedAt), completedAt: new Date(result.completedAt),
        distributedAuthority: { ...distributedAuthority, workerId: step.workerId } };
    });
  } else {
    results = await Promise.all(PARALLEL_SAFE_STEPS.map((step) => (
      runFrozenTestCommand(step, path.join(root, `${step.name}.log`))
    )));
    for (const step of SERIAL_STEPS) {
      results.push(await runFrozenTestCommand(step, path.join(root, `${step.name}.log`)));
    }
  }
  const finalRuntime = verifyStrictRuntimeAuthority(frozenRuntime.authorityPath, {
    workspaceRoot, provenance: currentGitProvenance({ cwd: workspaceRoot }),
  });
  if (finalRuntime.authority.authorityDigest !== frozenRuntime.authority.authorityDigest) {
    throw new Error('frozen runtime authority changed while running the test funnel');
  }
  const receipts = results.map((result) => {
    const receipt = createTestReceipt({ ...result, provenance, runtimeAuthority: frozenRuntime.authority });
    const receiptPath = path.join(root, `${result.name}.receipt.json`);
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return { name: result.name, command: result.command, receiptPath };
  });
  const canonicalPath = path.resolve(workspaceRoot, TEST_RECEIPT_CANONICAL_INDEX);
  const index = {
    schemaVersion: distributedAuthority ? 2 : 1,
    artifactKind: 'clean-head-test-receipt-index',
    generatedAt: new Date().toISOString(),
    provenance,
    ...(distributedAuthority ? { distributedAuthority } : {}),
    runtimeAuthority: {
      authorityDigest: frozenRuntime.authority.authorityDigest,
      ...fileAuthorityEntry(
        frozenRuntime.authorityPath,
        path.relative(path.dirname(canonicalPath), frozenRuntime.authorityPath).split(path.sep).join('/'),
      ),
    },
    receipts: receipts.map((receipt) => ({
      name: receipt.name,
      command: receipt.command,
      path: path.relative(path.dirname(canonicalPath), receipt.receiptPath).split(path.sep).join('/'),
    })),
  };
  fs.writeFileSync(canonicalPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return canonicalPath;
}

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), { defaults: { runtimeAuthority: '', workersConfig: '' } });
    if (!args.runtimeAuthority) throw new Error('--runtime-authority is required');
    console.log(await runFrozenTestFunnel({ runtimeAuthorityPath: path.resolve(repoRoot, args.runtimeAuthority), workersConfig: args.workersConfig }));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
