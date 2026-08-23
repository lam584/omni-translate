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
export const SMOKE_PREFLIGHT_RESULT_FILE = 'preflight-result.json';
export const VM3_SMOKE_STOP_MIN_C_FREE_BYTES = 5 * 1024 ** 3;
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
  sampleDiskSpace,
  stopMinFreeBytes = VM3_SMOKE_STOP_MIN_C_FREE_BYTES,
  cellIds,
  selectionReason,
  now = () => new Date(),
}) {
  if (typeof runCell !== 'function') throw new Error('smoke coordinator requires a runCell adapter');
  const plan = createWatchModeSmokePlan({ executionId });
  const selectedCellIds = cellIds === undefined
    ? plan.cells.map((cell) => cell.cellId)
    : [...new Set(cellIds.map((cellId) => String(cellId)))];
  if (selectedCellIds.length === 0) throw new Error('smoke targeted execution requires at least one cell');
  const unknownCellId = selectedCellIds.find((cellId) => !plan.cells.some((cell) => cell.cellId === cellId));
  if (unknownCellId) throw new Error(`smoke targeted execution selected an unknown cell: ${unknownCellId}`);
  const selectedCells = plan.cells.filter((cell) => selectedCellIds.includes(cell.cellId));
  const startedAt = now().toISOString();
  const assignments = createSmokeAssignments(selectedCells, workerCapabilities);
  const executionRoot = path.resolve(outputRoot, plan.executionId);
  if (fs.existsSync(executionRoot)) throw new Error(`smoke execution directory already exists: ${executionRoot}`);
  fs.mkdirSync(executionRoot, { recursive: true });
  const outcomes = [];
  const diskSpace = {
    monitoringEnabled: typeof sampleDiskSpace === 'function',
    drive: 'C:',
    stopMinFreeBytes,
    samples: [],
    minimumFreeBytes: null,
  };
  const recordDiskSpace = async (stage) => {
    if (typeof sampleDiskSpace !== 'function') return null;
    let value;
    try {
      value = await sampleDiskSpace({ stage, plan, executionRoot });
    } catch (error) {
      value = { error: String(error?.message ?? error) };
    }
    const freeBytes = Number(typeof value === 'number' ? value : value?.freeBytes);
    const sample = {
      stage,
      sampledAt: now().toISOString(),
      freeBytes: Number.isFinite(freeBytes) ? freeBytes : null,
      ...(typeof value === 'object' && value?.error ? { error: String(value.error) } : {}),
    };
    diskSpace.samples.push(sample);
    if (Number.isFinite(freeBytes)) {
      diskSpace.minimumFreeBytes = diskSpace.minimumFreeBytes === null
        ? freeBytes
        : Math.min(diskSpace.minimumFreeBytes, freeBytes);
    }
    if (!Number.isFinite(freeBytes)) return `C: free-space sample failed before ${stage}`;
    if (freeBytes <= stopMinFreeBytes) {
      return `C: free space is at or below the smoke stop floor before ${stage} (${freeBytes} bytes)`;
    }
    return null;
  };
  let preflight;
  let stopReason = await recordDiskSpace('preflight');
  if (stopReason) {
    preflight = { passed: false, providerCalls: 0, failure: stopReason, classification: 'orchestration' };
  } else {
    try {
      preflight = await runPreflight({ plan, executionRoot });
    } catch (error) {
      // A preflight crash is still an execution result. Persisting it prevents
      // a stalled build from being mistaken for an unrecorded smoke run.
      preflight = { passed: false, providerCalls: 0, failure: String(error?.message ?? error), classification: 'orchestration' };
    }
  }
  atomicWriteJson(path.join(executionRoot, SMOKE_PREFLIGHT_RESULT_FILE), {
    schemaVersion: 1,
    artifactKind: WATCH_MODE_SMOKE_ARTIFACT_KIND,
    smokeOnly: true,
    executionId: plan.executionId,
    completedAt: now().toISOString(),
    result: preflight,
  });
  const preflightPassed = preflight?.passed === true && Number(preflight?.providerCalls ?? 0) === 0;
  if (preflightPassed && !stopReason) stopReason = await recordDiskSpace('first-cell');

  const selection = {
    mode: selectedCells.length === plan.cells.length ? 'full' : 'targeted',
    cellIds: selectedCellIds,
    reason: String(selectionReason ?? '').trim()
      || (selectedCells.length === plan.cells.length ? 'full 17-cell VM3 smoke' : 'unspecified'),
  };
  const manifestPath = path.join(executionRoot, SMOKE_MANIFEST_FILE);
  const writeManifest = ({ executionStatus, completedAt = null, activeCellId = null } = {}) => {
    const providerCalls = outcomes.reduce((sum, entry) => sum + Number(entry.providerCalls ?? 0), 0);
    const allSelectedCellsCompleted = outcomes.length === selectedCells.length;
    const manifest = {
      schemaVersion: 1,
      artifactKind: WATCH_MODE_SMOKE_ARTIFACT_KIND,
      smokeOnly: true,
      executionId: plan.executionId,
      executionStatus,
      startedAt,
      completedAt,
      totalBudgetSeconds: WATCH_MODE_SMOKE_BUDGET_SECONDS,
      plan,
      selection,
      assignments,
      preflight,
      provenance: {
        git: preflight?.provenance ?? null,
        deviceProfile: preflight?.deviceProfile ?? null,
        runtimeAuthority: preflight?.runtimeAuthority ?? null,
        buildSettings: preflight?.buildSettings ?? null,
      },
      diskSpace,
      outcomes,
      providerCalls,
      dispatch: {
        completedCount: outcomes.length,
        duplicateCellIds: outcomes
          .map((entry) => entry.cellId)
          .filter((cellId, index, values) => values.indexOf(cellId) !== index),
      },
      ...(activeCellId ? { activeCellId } : {}),
      ...(stopReason ? { stopReason } : {}),
      passed: executionStatus === 'completed'
        && preflightPassed
        && !stopReason
        && allSelectedCellsCompleted
        && outcomes.every((entry) => entry.status === 'passed'),
      blocksAuthoritativeRun: executionStatus !== 'completed'
        || !preflightPassed
        || Boolean(stopReason)
        || !allSelectedCellsCompleted
        || outcomes.some((entry) => entry.status !== 'passed'),
      nonAuthoritativeReason: 'Smoke artifacts cannot be used for release, closeout, or PR merge evidence.',
    };
    atomicWriteJson(manifestPath, manifest);
    return manifest;
  };
  writeManifest({ executionStatus: 'in-progress' });

  if (preflightPassed && !stopReason) {
    for (const waveIndex of [...new Set(assignments.map((entry) => entry.waveIndex))]) {
      const wave = assignments.filter((entry) => entry.waveIndex === waveIndex);
      const activeCellId = wave[0]?.cellId ?? null;
      writeManifest({ executionStatus: 'in-progress', activeCellId });
      const settled = await Promise.allSettled(wave.map(async (assignment) => {
        const cell = selectedCells.find((entry) => entry.cellId === assignment.cellId);
        const result = await runCell({ plan, cell, assignment, executionRoot });
        return { ...assignment, result };
      }));
      // Continue independent waves, retaining all failure evidence for one diagnostic pass.
      outcomes.push(...settled.map((entry, index) => {
        if (entry.status === 'rejected') {
          return { ...wave[index], status: 'failed', classification: 'orchestration', providerCalls: 0, error: String(entry.reason?.message ?? entry.reason) };
        }
        const passed = entry.value.result?.passed === true;
        const classification = entry.value.result?.classification;
        const expectedProviderCalls = selectedCells.find((cell) => cell.cellId === entry.value.cellId)?.providerMode === 'disabled' ? 0 : 1;
        const providerCalls = Number(entry.value.result?.providerCalls);
        if (!Number.isInteger(providerCalls) || providerCalls !== expectedProviderCalls) {
          return {
            ...entry.value,
            status: 'failed',
            classification: 'orchestration',
            providerCalls: Number.isInteger(providerCalls) ? providerCalls : 0,
            error: `runner recorded ${Number.isInteger(providerCalls) ? providerCalls : 'no'} Provider calls; expected ${expectedProviderCalls}`,
          };
        }
        if (!passed && !SMOKE_FAILURE_CLASSES.includes(classification)) {
          return { ...entry.value, status: 'failed', classification: 'orchestration', providerCalls, error: 'runner returned a failed cell without a valid failure classification' };
        }
        return { ...entry.value, providerCalls, status: passed ? 'passed' : 'failed', ...(passed ? {} : { classification }) };
      }));
      writeManifest({ executionStatus: 'in-progress' });
      stopReason = await recordDiskSpace(`cell:${activeCellId}:complete`);
      if (stopReason) break;
    }
  }
  const completedAt = now().toISOString();
  const manifest = writeManifest({ executionStatus: 'completed', completedAt });
  return { executionRoot, manifestPath, manifest };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const adapterFlag = args.indexOf('--adapter');
  const executionFlag = args.indexOf('--execution-id');
  const cellsFlag = args.indexOf('--cells');
  const selectionReasonFlag = args.indexOf('--selection-reason');
  if (args.includes('--plan')) {
    if (args.length !== 1) throw new Error('--plan cannot be combined with other smoke coordinator flags');
    console.log(JSON.stringify(createWatchModeSmokePlan(), null, 2));
  } else {
    if (adapterFlag < 0 || !args[adapterFlag + 1] || args.some((arg, index) => (
      arg.startsWith('--') && !['--adapter', '--execution-id', '--cells', '--selection-reason'].includes(arg)
    ))) {
      throw new Error('Usage: run-watch-mode-smoke.mjs --plan | --adapter <vm-aware-adapter.mjs> [--execution-id <id>] [--cells <id,id>] [--selection-reason <text>]');
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
      ...(cellsFlag < 0 ? {} : { cellIds: String(args[cellsFlag + 1] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean) }),
      ...(selectionReasonFlag < 0 ? {} : { selectionReason: args[selectionReasonFlag + 1] }),
      ...(typeof adapter.runPreflight === 'function' ? { runPreflight: adapter.runPreflight } : {}),
      ...(typeof adapter.sampleDiskSpace === 'function' ? { sampleDiskSpace: adapter.sampleDiskSpace } : {}),
    });
    console.log(JSON.stringify({ manifestPath: result.manifestPath, passed: result.manifest.passed }, null, 2));
    process.exitCode = result.manifest.passed ? 0 : 1;
  }
}
