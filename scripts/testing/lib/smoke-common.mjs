/**
 * Shared CLI-seam helpers for the plan/report smoke modules
 * (overlay-driver-smoke.mjs, startup-ipc-stress.mjs).
 *
 * Everything here stays as side-effect-light as the callers: JSON in, JSON
 * out, plus the exact console lines the PowerShell runners already parse.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseCliArgs, readJson, repoRoot, writeJson } from '../../lib/testing-common.mjs';
import { currentGitCommit } from '../watch-mode-report.mjs';

/** CLI flags both smokes share; callers layer their own defaults on top. */
export function parseSmokeCliArgs(argv, defaults) {
  return parseCliArgs(argv, {
    booleans: ['dry-run'],
    defaults: {
      mode: 'plan',
      output: '',
      input: '',
      workspaceRoot: '',
      releaseExecutablePath: '',
      ...defaults,
    },
  });
}

/** Resolve the workspace root and create the output directory. */
export function resolveSmokeDirs(args, defaultOutputRoot) {
  const workspaceRoot = args.workspaceRoot || repoRoot;
  const outputDir = args.output || path.join(workspaceRoot, defaultOutputRoot);
  fs.mkdirSync(outputDir, { recursive: true });
  return { workspaceRoot, outputDir };
}

/** Nonzero only when the written report's verdict is failed. */
export const smokeExitCode = (report) => (report?.verdict === 'failed' ? 1 : 0);

/** package.json version, used to locate versioned installer-layout executables. */
export function readPackageVersion(workspaceRoot) {
  try {
    return readJson(path.join(workspaceRoot, 'package.json')).version ?? null;
  } catch {
    return null;
  }
}

/** Plan-text lines describing the resolved release executable. */
export function releaseExecutablePlanLines(releaseExecutable) {
  return [
    `release executable: ${releaseExecutable.path}`,
    `release executable found: ${releaseExecutable.found}`,
    ...(releaseExecutable.found ? [] : [`  build it with: ${releaseExecutable.buildHint}`]),
  ];
}

/**
 * `--mode plan` output contract: write plan.json, print the human plan text,
 * then print the report path (with a dry-run report written) on --dry-run or
 * the plan path otherwise. The caller still owns process.exit.
 */
export function emitPlanArtifacts({ outputDir, plan, planText, dryRun, buildReport }) {
  const planPath = path.join(outputDir, 'plan.json');
  writeJson(planPath, plan);
  console.log(planText);
  if (dryRun) {
    const reportPath = path.join(outputDir, 'report.json');
    writeJson(
      reportPath,
      buildReport({
        evidence: { dryRun: true, plan, runId: path.basename(outputDir) },
        gitCommit: currentGitCommit(),
        artifacts: { plan: planPath, report: reportPath },
      }),
    );
    console.log(reportPath);
  } else {
    console.log(planPath);
  }
}

/**
 * `--mode report` input contract: read evidence.json from inputDir (throwing
 * the caller's historical "<label> evidence was not written" message when it
 * is missing), build and write report.json, print its path, return the report.
 */
export function writeReportFromEvidence({ inputDir, outputDir, label, buildReport }) {
  const evidencePath = path.join(inputDir, 'evidence.json');
  if (!fs.existsSync(evidencePath)) {
    throw new Error(`${label} evidence was not written: ${evidencePath}`);
  }
  const reportPath = path.join(outputDir, 'report.json');
  const report = buildReport({
    evidence: readJson(evidencePath),
    gitCommit: currentGitCommit(),
    artifacts: { evidence: evidencePath, report: reportPath, plan: path.join(inputDir, 'plan.json') },
  });
  writeJson(reportPath, report);
  console.log(reportPath);
  return report;
}
