import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  auditPowerShellSources,
  auditTestingDspBoundaries,
  collectPowerShellSources,
  runPowerShellBoundaryAudit,
} from './audit-powershell-boundaries.mjs';

test('current PowerShell inventory satisfies its ratcheted boundary policy', () => {
  const result = runPowerShellBoundaryAudit({ strict: true });
  assert.ok(result.files >= 23);
});

test('worker bootstrap and generation collector registrations retain exact budgets and least capabilities', () => {
  const policy = JSON.parse(fs.readFileSync(new URL('./powershell-boundaries.json', import.meta.url), 'utf8'));
  const records = collectPowerShellSources();
  const expected = [
    ['scripts/testing/bootstrap-watch-worker.ps1', 101, ['elevation', 'fileDeletion']],
    ['scripts/testing/request-watch-worker-bootstrap-elevated.ps1', 17, ['elevation']],
    ['scripts/testing/collect-watch-mode-interactive-process-authority.ps1', 235, []],
  ];
  for (const [file, maxLines, capabilities] of expected) {
    assert.equal(policy.scripts[file].maxLines, maxLines);
    assert.deepEqual(policy.scripts[file].capabilities, capabilities);
    const changedRecords = records.map((record) => record.path === file
      ? { ...record, lines: maxLines + 1 }
      : record);
    assert.ok(auditPowerShellSources(changedRecords, policy, { strict: true })
      .some((issue) => issue === `${file}: ${maxLines + 1} lines exceeds registered maximum ${maxLines}`));
  }
  const bootstrap = records.find((record) => record.path === expected[0][0]);
  const noDeletion = structuredClone(policy);
  noDeletion.scripts[bootstrap.path].capabilities = ['elevation'];
  assert.ok(auditPowerShellSources(records, noDeletion, { strict: true })
    .some((issue) => issue === `${bootstrap.path}: undeclared fileDeletion capability`));
});

test('Watch report and verifier layers contain no PCM/DSP implementation', () => {
  assert.equal(auditTestingDspBoundaries().files, 2);
});

test('unregistered files and new unsafe process cleanup fail the audit', () => {
  const policy = {
    defaultEntrypointMaxLines: 500,
    defaultModuleMaxLines: 800,
    scripts: {},
    duplicateFunctionExemptions: {},
    unsafeProcessExemptions: {},
    implicitStateExemptions: {},
    watchPolicyExemptions: {},
  };
  const records = [{
    path: 'scripts/testing/new-runner.ps1',
    lines: 2,
    source: "Get-Process -Name 'omni-desktop-shell' | Stop-Process -Force\n",
  }];
  const issues = auditPowerShellSources(records, policy);
  assert.ok(issues.some((issue) => issue.includes('not registered')));
});

test('module imports cannot pollute the caller global scope', () => {
  const path = 'scripts/testing/lib/powershell/Example.psm1';
  const policy = {
    defaultEntrypointMaxLines: 500,
    defaultModuleMaxLines: 800,
    scripts: { [path]: { role: 'module', maxLines: 2, allowedImports: ['Dependency.psm1'], capabilities: [] } },
    duplicateFunctionExemptions: {},
    unsafeProcessExemptions: {},
    implicitStateExemptions: {},
    watchPolicyExemptions: {},
  };
  const issues = auditPowerShellSources([
    {
      path,
      lines: 2,
      source: "Import-Module (Join-Path $PSScriptRoot 'Dependency.psm1') -Force -Global\n",
    },
  ], policy);
  assert.ok(issues.some((issue) => issue.includes('module imports must remain local')));
});

test('declared import and capability boundaries reject privilege expansion', () => {
  const path = 'scripts/testing/new-collector.ps1';
  const policy = {
    defaultEntrypointMaxLines: 500,
    defaultModuleMaxLines: 800,
    scripts: { [path]: { role: 'collector', maxLines: 3, allowedImports: [], capabilities: [] } },
    duplicateFunctionExemptions: {},
    unsafeProcessExemptions: {},
    implicitStateExemptions: {},
    watchPolicyExemptions: {},
  };
  const issues = auditPowerShellSources([{
    path,
    lines: 2,
    source: "Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1')\nRemove-Item -LiteralPath $file\n",
  }], policy);
  assert.ok(issues.some((issue) => issue.includes('undeclared module import')));
  assert.ok(issues.some((issue) => issue.includes('undeclared fileDeletion capability')));
});

test('Watch readiness cannot regress to a log-text API', () => {
  const path = 'scripts/testing/watch-mode-probe.ps1';
  const records = [{ path, lines: 1, source: "$ready = $text -match 'watch_mode.omni_session_ready'\n" }];
  const policy = {
    defaultEntrypointMaxLines: 500,
    defaultModuleMaxLines: 800,
    scripts: { [path]: { role: 'entrypoint', maxLines: 500 } },
    duplicateFunctionExemptions: {},
    unsafeProcessExemptions: {},
    implicitStateExemptions: {},
    watchPolicyExemptions: {},
  };
  assert.ok(auditPowerShellSources(records, policy).some((issue) => issue.includes('log text')));
});

test('Startup PowerShell cannot regain threshold or verdict authority', () => {
  const path = 'scripts/testing/lib/powershell/Omni.Testing.Startup.Policy.psm1';
  const records = [{ path, lines: 1, source: "$verdict = 'passed'\n" }];
  const policy = {
    defaultEntrypointMaxLines: 500,
    defaultModuleMaxLines: 800,
    scripts: { [path]: { role: 'module', maxLines: 1, allowedImports: [], capabilities: [] } },
    duplicateFunctionExemptions: {},
    unsafeProcessExemptions: {},
    implicitStateExemptions: {},
    watchPolicyExemptions: {},
  };
  assert.ok(auditPowerShellSources(records, policy).some((issue) => issue.includes('Node report engine')));
});

test('Watch PowerShell cannot write the Node-owned derived content artifact', () => {
  const path = 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.Bad.psm1';
  const records = [{
    path,
    lines: 1,
    source: '$path = Join-Path $OutputDirectory "physical-output-content.json"\n',
  }];
  const policy = {
    defaultEntrypointMaxLines: 500,
    defaultModuleMaxLines: 800,
    scripts: { [path]: { role: 'module', maxLines: 1, allowedImports: [], capabilities: [] } },
    duplicateFunctionExemptions: {},
    unsafeProcessExemptions: {},
    implicitStateExemptions: {},
    watchPolicyExemptions: {},
  };
  assert.ok(auditPowerShellSources(records, policy).some((issue) => issue.includes('derived content artifact')));
});

test('strict mode stays clean after temporary exemptions are removed', () => {
  const records = collectPowerShellSources();
  const policy = {
    defaultEntrypointMaxLines: 10_000,
    defaultModuleMaxLines: 10_000,
    scripts: Object.fromEntries(records.map((record) => [record.path, { role: 'entrypoint', maxLines: 10_000 }])),
    duplicateFunctionExemptions: { 'Get-Sha256': { removalStage: 1 } },
    unsafeProcessExemptions: Object.fromEntries(records.map((record) => [record.path, { removalStage: 2 }])),
    implicitStateExemptions: Object.fromEntries(records.map((record) => [record.path, { removalStage: 3 }])),
    watchPolicyExemptions: Object.fromEntries(records.map((record) => [record.path, { removalStage: 6 }])),
  };
  const issues = auditPowerShellSources(records, policy, { strict: true });
  assert.ok(!issues.some((issue) => issue.includes('unsafe process termination')));
  assert.ok(!issues.some((issue) => issue.includes('implicit $global:/$script:')));
  assert.ok(!issues.some((issue) => issue.includes('verdict/DSP policy')));
});
