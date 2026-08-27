import fs from 'node:fs';
import path from 'node:path';

import { compactTimestamp, isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { scoreRun } from './watch-mode-score.mjs';
import { writeReport } from './watch-mode-report.mjs';

function parseRunDirectories(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('--run-directories is required');
  const parsed = text.startsWith('[') ? JSON.parse(text) : text.split(',');
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('--run-directories must contain at least one directory');
  return parsed.map((candidate) => path.resolve(repoRoot, String(candidate).trim()));
}

export async function replayWatchModeFailures({ runDirectories, outputRoot }) {
  const root = path.resolve(repoRoot, outputRoot ?? 'artifacts/testing/watch-mode-offline-replay', compactTimestamp());
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root, { recursive: false });
  const results = [];
  for (let index = 0; index < runDirectories.length; index += 1) {
    const input = runDirectories[index];
    const output = path.join(root, `${String(index + 1).padStart(2, '0')}-${path.basename(input)}`);
    fs.mkdirSync(output);
    const report = writeReport({ inputDir: input, outputDir: output, mode: 'live' });
    const score = await scoreRun({
      input,
      report: report.reportJsonPath,
      output: path.join(output, 'benchmark-score.json'),
      noLlmJudge: true,
    });
    results.push({
      input,
      output,
      verdict: report.report.verdict,
      failureLayer: report.report.failureLayer,
      scoreStatus: score.result.status,
    });
  }
  const summaryPath = path.join(root, 'offline-replay-summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: 'watch-mode-offline-development-replay',
    releaseEvidence: false,
    generatedAt: new Date().toISOString(),
    results,
  }, null, 2)}\n`, 'utf8');
  return summaryPath;
}

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), { defaults: { runDirectories: '', outputRoot: '' } });
    console.log(await replayWatchModeFailures({
      runDirectories: parseRunDirectories(args.runDirectories),
      outputRoot: args.outputRoot || undefined,
    }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
