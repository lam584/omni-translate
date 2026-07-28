import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// This suite executes the runner instead of grepping its source. Earlier
// versions asserted on string positions inside the .ps1, which validated
// wording rather than behavior (a reworded script broke the tests, a broken
// script with intact wording passed them). Coverage now comes from three
// executable layers:
//   1. PowerShell parser check — the script must stay syntactically valid.
//   2. -DryRun smoke — the dry-run path runs end to end and its artifacts
//      (config-injection.json, snapshots.json, report.json) are asserted on
//      content, including both feedback-mode injection probes.
//   3. Matrix argv construction — real exported functions from the matrix
//      orchestrator.
// The live (non-dry-run) chain is intentionally out of scope here: it needs a
// desktop shell, audio hardware and credentials, and is guarded by
// verify-watch-mode-evidence.mjs plus the dev-machine live matrix.

const scriptPath = path.join('scripts', 'testing', 'run-watch-mode-live.ps1');
const isWindows = process.platform === 'win32';

// PowerShell's Set-Content -Encoding UTF8 writes a BOM; strip it before parsing.
function readJsonArtifact(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function runPowerShell(args, { env } = {}) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8',
    env: { ...process.env, npm_lifecycle_event: '', ...env },
    // Fixture generation + report generation are node subprocesses; give the
    // whole dry run a generous ceiling so a hang fails loudly, not silently.
    timeout: 300_000,
  });
}

test('run-watch-mode-live.ps1 parses without PowerShell syntax errors', { skip: !isWindows }, () => {
  const probe = runPowerShell([
    '-Command',
    `$errors = $null; ` +
    `[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path '${scriptPath}').Path, [ref]$null, [ref]$errors); ` +
    `foreach ($e in $errors) { Write-Error ("{0}:{1} {2}" -f $e.Extent.StartLineNumber, $e.Extent.StartColumnNumber, $e.Message) }; ` +
    `exit $errors.Count`,
  ]);
  assert.equal(probe.status, 0, `runner has PowerShell syntax errors:\n${probe.stderr}`);
});

test('dry-run executes end to end and produces passing, content-checked artifacts', { skip: !isWindows }, () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-dry-run-'));
  try {
    const run = runPowerShell(['-File', scriptPath, '-DryRun', '-OutputRoot', outputRoot]);
    assert.equal(
      run.status,
      0,
      `dry-run failed (exit ${run.status}).\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );

    const runDirectories = fs.readdirSync(outputRoot).filter((entry) =>
      fs.statSync(path.join(outputRoot, entry)).isDirectory(),
    );
    assert.equal(runDirectories.length, 1, `expected exactly one dry-run output directory, got: ${runDirectories.join(', ')}`);
    const runDirectory = path.join(outputRoot, runDirectories[0]);

    // Feedback config injection must be probed for BOTH modes and each probe
    // must have landed the requested mode in the effective config.
    const injection = readJsonArtifact(path.join(runDirectory, 'config-injection.json'));
    assert.equal(injection.selectedFeedbackLoopPrevention, 'virtual-driver');
    assert.deepEqual(
      injection.variants.map((variant) => variant.requested).sort(),
      ['echo-cancel', 'virtual-driver'],
    );
    for (const variant of injection.variants) {
      assert.equal(variant.injected, variant.requested, `feedback injection drifted for ${variant.requested}`);
      assert.equal(variant.monitorMode, 'original-and-translated');
    }

    // The fixture snapshots must be stamped with the selected feedback mode
    // so evidence from different modes can never mask each other.
    const snapshots = readJsonArtifact(path.join(runDirectory, 'snapshots.json'));
    assert.equal(snapshots.feedbackLoopPrevention, 'virtual-driver');

    // The generated report must classify the healthy fixture as passed; a
    // report-pipeline regression turns this into a hard failure.
    const report = readJsonArtifact(path.join(runDirectory, 'report.json'));
    assert.equal(report.verdict, 'passed', `dry-run fixture report failed: ${JSON.stringify(report, null, 2)}`);
    assert.equal(report.failureLayer, null);

    for (const artifact of ['steps.json', 'app.log', 'bridge-service.log']) {
      assert.ok(fs.existsSync(path.join(runDirectory, artifact)), `dry-run must persist ${artifact}`);
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('npm lifecycle guard rejects swallowed single-dash options with actionable guidance', { skip: !isWindows }, () => {
  // npm 11 forwards "-FeedbackLoopPrevention echo-cancel" as a bare value that
  // binds positionally to -Fixture; the runner must fail fast instead of
  // running with silently misbound arguments.
  const run = runPowerShell(
    ['-File', scriptPath, 'echo-cancel'],
    { env: { npm_lifecycle_event: 'test:watch-mode-live:dry-run' } },
  );
  assert.notEqual(run.status, 0, 'runner must reject orphaned positional values under npm lifecycles');
  assert.match(run.stderr, /npm 11 swallows single-dash options/, 'rejection must explain the npm forwarding pitfall');
  assert.match(run.stderr, /OMNI_WATCH_MODE_LIVE_FEEDBACK_LOOP_PREVENTION/, 'rejection must offer the env-variable alternative');
});

test('matrix runner executes both strict watch models and verifies strict evidence', async () => {
  const matrix = await import('./run-watch-mode-live-matrix.mjs');

  assert.deepEqual(matrix.DEFAULT_MODELS, ['qwen3.5-omni-flash-realtime', 'qwen3.5-livetranslate-flash-realtime']);
  assert.deepEqual(matrix.DEFAULT_FEEDBACK_MODES, ['virtual-driver', 'echo-cancel']);

  const argv = matrix.buildRunnerArgv({
    model: 'qwen3.5-omni-flash-realtime',
    feedbackMode: 'virtual-driver',
    allowElevatedDesktopLaunch: true,
    runnerArgs: ['-DryRun'],
  });
  assert.equal(argv[argv.indexOf('-WatchModelId') + 1], 'qwen3.5-omni-flash-realtime');
  assert.equal(argv[argv.indexOf('-FeedbackLoopPrevention') + 1], 'virtual-driver');
  assert.equal(argv[argv.indexOf('-PlaybackSeconds') + 1], '0');
  assert.ok(argv.includes('-AllowElevatedDesktopLaunch'));
  assert.deepEqual(argv.slice(-1), ['-DryRun'], 'runner passthrough args must stay appended verbatim');

  const verifyArgv = matrix.buildVerifyArgv(
    'artifacts/testing/watch-mode-live',
    matrix.DEFAULT_MODELS,
    matrix.DEFAULT_FEEDBACK_MODES,
  );
  assert.equal(verifyArgv[0], './scripts/testing/verify-watch-mode-evidence.mjs');
  assert.ok(verifyArgv.includes('--strict'));
  assert.equal(verifyArgv[verifyArgv.indexOf('--models') + 1], matrix.DEFAULT_MODELS.join(','));
  assert.equal(verifyArgv[verifyArgv.indexOf('--feedback-modes') + 1], matrix.DEFAULT_FEEDBACK_MODES.join(','));
});
