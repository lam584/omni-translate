import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isMain, repoRoot } from '../lib/testing-common.mjs';
import {
  WATCH_MODE_SMOKE_ARTIFACT_KIND,
  WATCH_MODE_SMOKE_BUDGET_SECONDS,
  createWatchModeSmokePlan,
} from './watch-mode-smoke-plan.mjs';

export const SMOKE_OUTPUT_ROOT = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-smoke');
export const SMOKE_MANIFEST_FILE = 'smoke-manifest.json';
export const SMOKE_FAILURE_CLASSES = Object.freeze([
  'product', 'device', 'orchestration', 'ci', 'provider-external',
]);

function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function selectWorker(cell, workers, occupied) {
  const candidates = workers.filter((worker) => !occupied.has(worker.workerId) && worker.deviceClasses.includes(cell.deviceClass));
  if (candidates.length === 0) return null;
  return candidates.sort((left, right) => left.assignments - right.assignments || left.workerId.localeCompare(right.workerId))[0];
}

/** Assigns independent cells in bounded waves. Every worker needs an explicit device capability. */
export function createSmokeAssignments(cells, workerCapabilities) {
  if (!Array.isArray(workerCapabilities) || workerCapabilities.length !== 1) {
    throw new Error('single-VM smoke coordinator requires exactly one worker');
  }
  const workers = workerCapabilities.map((worker) => ({
    workerId: String(worker.workerId ?? ''),
    deviceClasses: [...new Set(worker.deviceClasses ?? [])].sort(), assignments: 0,
  }));
  if (workers.some((worker) => !/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(worker.workerId))) throw new Error('smoke workerId is invalid');
  if (new Set(workers.map((worker) => worker.workerId)).size !== workers.length) throw new Error('smoke workerId is duplicated');
  const remaining = cells.map((entry) => ({ ...entry }));
  const assignments = [];
  let waveIndex = 0;
  while (remaining.length > 0) {
    const occupied = new Set();
    let scheduled = 0;
    for (let index = 0; index < remaining.length;) {
      const cell = remaining[index];
      const worker = selectWorker(cell, workers, occupied);
      if (!worker) { index += 1; continue; }
      worker.assignments += 1;
      occupied.add(worker.workerId);
      assignments.push({ cellId: cell.cellId, workerId: worker.workerId, waveIndex });
      remaining.splice(index, 1);
      scheduled += 1;
    }
    if (scheduled === 0) throw new Error(`no smoke worker can run remaining device class ${remaining[0].deviceClass}`);
    waveIndex += 1;
  }
  return assignments;
}

export async function runWatchModeSmoke({
  executionId,
  workerCapabilities,
  outputRoot = SMOKE_OUTPUT_ROOT,
  runCell,
  runPreflight = async () => ({ passed: true, providerCalls: 0 }),
  now = () => new Date(),
}) {
  if (typeof runCell !== 'function') throw new Error('smoke coordinator requires a runCell adapter');
  const plan = createWatchModeSmokePlan({ executionId });
  const startedAt = now().toISOString();
  const assignments = createSmokeAssignments(plan.cells, workerCapabilities);
  const executionRoot = path.resolve(outputRoot, plan.executionId);
  if (fs.existsSync(executionRoot)) throw new Error(`smoke execution directory already exists: ${executionRoot}`);
  fs.mkdirSync(executionRoot, { recursive: true });
  const preflight = await runPreflight({ plan, executionRoot });
  if (preflight?.passed !== true || Number(preflight?.providerCalls ?? 0) !== 0) {
    throw new Error('smoke zero-cost preflight failed or made a Provider call');
  }
  const outcomes = [];
  for (const waveIndex of [...new Set(assignments.map((entry) => entry.waveIndex))]) {
    const wave = assignments.filter((entry) => entry.waveIndex === waveIndex);
    const settled = await Promise.allSettled(wave.map(async (assignment) => {
      const cell = plan.cells.find((entry) => entry.cellId === assignment.cellId);
      const result = await runCell({ plan, cell, assignment, executionRoot });
      return { ...assignment, result };
    }));
    // Continue independent waves, retaining all failure evidence for one diagnostic pass.
    outcomes.push(...settled.map((entry, index) => {
      if (entry.status === 'rejected') {
        return { ...wave[index], status: 'failed', classification: 'orchestration', error: String(entry.reason?.message ?? entry.reason) };
      }
      const passed = entry.value.result?.passed === true;
      const classification = entry.value.result?.classification;
      if (!passed && !SMOKE_FAILURE_CLASSES.includes(classification)) {
        return { ...entry.value, status: 'failed', classification: 'orchestration', error: 'runner returned a failed cell without a valid failure classification' };
      }
      return { ...entry.value, status: passed ? 'passed' : 'failed', ...(passed ? {} : { classification }) };
    }));
  }
  const completedAt = now().toISOString();
  const manifest = {
    schemaVersion: 1,
    artifactKind: WATCH_MODE_SMOKE_ARTIFACT_KIND,
    smokeOnly: true,
    executionId: plan.executionId,
    startedAt,
    completedAt,
    totalBudgetSeconds: WATCH_MODE_SMOKE_BUDGET_SECONDS,
    plan,
    assignments,
    preflight,
    outcomes,
    passed: outcomes.length === plan.cells.length && outcomes.every((entry) => entry.status === 'passed'),
    blocksAuthoritativeRun: outcomes.some((entry) => (
      entry.status === 'failed' && entry.classification !== 'provider-external'
    )),
    nonAuthoritativeReason: 'Smoke artifacts cannot be used for release, closeout, or PR merge evidence.',
  };
  atomicWriteJson(path.join(executionRoot, SMOKE_MANIFEST_FILE), manifest);
  return { executionRoot, manifestPath: path.join(executionRoot, SMOKE_MANIFEST_FILE), manifest };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const adapterFlag = args.indexOf('--adapter');
  const executionFlag = args.indexOf('--execution-id');
  if (args.includes('--plan')) {
    if (args.length !== 1) throw new Error('--plan cannot be combined with other smoke coordinator flags');
    console.log(JSON.stringify(createWatchModeSmokePlan(), null, 2));
  } else {
    if (adapterFlag < 0 || !args[adapterFlag + 1] || args.some((arg, index) => (
      arg.startsWith('--') && !['--adapter', '--execution-id'].includes(arg)
    ))) {
      throw new Error('Usage: run-watch-mode-smoke.mjs --plan | --adapter <vm-aware-adapter.mjs> [--execution-id <id>]');
    }
    const adapterPath = path.resolve(repoRoot, args[adapterFlag + 1]);
    const adapter = await import(`${pathToFileURL(adapterPath).href}?execution=${Date.now()}`);
    if (!Array.isArray(adapter.workerCapabilities) || typeof adapter.runCell !== 'function') {
      throw new Error('smoke adapter must export workerCapabilities and runCell');
    }
    const result = await runWatchModeSmoke({
      executionId: executionFlag < 0 ? undefined : args[executionFlag + 1],
      workerCapabilities: adapter.workerCapabilities,
      runCell: adapter.runCell,
      ...(typeof adapter.runPreflight === 'function' ? { runPreflight: adapter.runPreflight } : {}),
    });
    console.log(JSON.stringify({ manifestPath: result.manifestPath, passed: result.manifest.passed }, null, 2));
    process.exitCode = result.manifest.passed ? 0 : 1;
  }
}
