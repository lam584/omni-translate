import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { forbiddenCellArtifactPaths } from './watch-mode-evidence-authority.mjs';
import { buildCanonicalReferencePcm } from './watch-mode-canonical-source-authority.mjs';

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

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function extractedReportWaitFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -in @(` +
        `'Assert-WatchSessionReportFile',` +
        `'Wait-WatchSessionReportAndDesktopExit',` +
        `'Get-WatchSessionReportDeadlineUtc'` +
      `) ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

function extractedProviderSummaryFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -in @('Get-LogTextAfterMarker','Read-RecentProviderSummary') ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

function extractedAppReadinessFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -in @(` +
        `'Get-LogTextAfterMarker',` +
        `'Get-DiagnosticLogLines',` +
        `'Format-DiagnosticLogLines',` +
        `'Get-WatchModeRunSessionId',` +
        `'Get-OptionalDiagnosticFileTail',` +
        `'Wait-WatchModeAppReadiness'` +
      `) ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

function extractedAppLogWaitFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -in @(` +
        `'Get-LogTextAfterMarker',` +
        `'Get-DiagnosticLogLines',` +
        `'Format-DiagnosticLogLines',` +
        `'Wait-AppLogPattern'` +
      `) ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

function extractedElevationGuardFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -in @(` +
        `'New-ParentGuardedPowerShellCommand',` +
        `'ConvertTo-PowerShellSingleQuotedLiteral',` +
        `'New-ElevatedDesktopGuardianCommand'` +
      `) ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

function extractedSpeechSegmentationFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -in @('Get-LogTextAfterMarker','Read-SpeechSegmentationSummary') ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

function extractedStrictPaidSourceAuthorityFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -in @('Invoke-CanonicalSourceAuthorityNode','Get-CanonicalSourceMediaReference','Get-SourceMediaReferenceTranscript') ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

function extractedStrictPaidProviderFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -in @(` +
        `'Enter-StrictPaidProviderEnvironment',` +
        `'Exit-StrictPaidProviderEnvironment',` +
        `'Set-WatchModelOnConfig'` +
      `) ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

function extractedCuePlaybackAuthorityFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -in @('Get-LogTextAfterMarker','Read-TranslatedCuePlaybackAuthority') ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

test('native Bridge queued and started statuses count as physical speech evidence', { skip: !isWindows }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-native-speech-evidence-'));
  const logPath = path.join(tempRoot, 'app.log');
  fs.writeFileSync(logPath, [
    'before marker event=translation_playback_status | cueId=old status=started reason=physical-playback-started',
    'run-marker-native',
    'event=translation_playback_status | cueId=cue-1 status=queued reason=accepted',
    'event=translation_playback_status | cueId=cue-1 status=started reason=physical-playback-started',
  ].join('\n'));
  try {
    const command = `${extractedSpeechSegmentationFunctions()} ` +
      `Read-SpeechSegmentationSummary ${quotePowerShell(logPath)} 'run-marker-native' | ConvertTo-Json -Compress`;
    const result = runPowerShell(['-Command', command]);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout.trim());
    assert.equal(summary.queuedSegments, 1);
    assert.equal(summary.playedSegments, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('strict paid source authority uses canonical hashes, fixture texts, and injector PCM without remote STT', { skip: !isWindows }, () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-canonical-source-'));
  const referencePcmPath = path.join(outputDirectory, 'source-media-reference-16k-mono.pcm');
  fs.writeFileSync(referencePcmPath, buildCanonicalReferencePcm({ workspaceRoot: path.resolve('.') }));
  try {
    const canonicalMedia = path.resolve('scripts/testing/fixtures/watch-mode-en-original.wav');
    const command = `${extractedStrictPaidSourceAuthorityFunctions()} ` +
      `$workspaceRoot = ${quotePowerShell(path.resolve('.'))}; ` +
      `$StrictPaidAuthority = $true; ` +
      `function Get-PhysicalOutputSttApiKey { throw 'remote credential path must not execute' }; ` +
      `function Build-OmniRealtimeDiagnostic { throw 'remote diagnostic path must not execute' }; ` +
      `Get-SourceMediaReferenceTranscript ${quotePowerShell(outputDirectory)} ${quotePowerShell(canonicalMedia)} | ConvertTo-Json -Depth 4 -Compress`;
    const result = runPowerShell(['-Command', command]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const authority = JSON.parse(result.stdout.trim());
    assert.equal(authority.passed, true);
    assert.equal(authority.authorityMode, 'canonical-fixture-local-v2');
    assert.equal(authority.remoteProviderCalls, 0);
    assert.equal(authority.externalAudioSeconds, 0);
    assert.equal(authority.mediaPath, 'scripts/testing/fixtures/watch-mode-en-original.wav');
    assert.equal(authority.referencePcm.path, 'source-media-reference-16k-mono.pcm');
    assert.equal(authority.mediaSha256, 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f');
    assert.equal(authority.referencePcm.samples, 2_013_045);
    assert.equal(typeof authority.source, 'string', JSON.stringify(authority.source));
    assert.equal(typeof authority.translation, 'string', JSON.stringify(authority.translation));
    assert.equal(
      authority.source.replaceAll('\r\n', '\n'),
      fs.readFileSync(path.resolve('scripts/testing/fixtures/watch-mode-en-original.txt'), 'utf8').replaceAll('\r\n', '\n'),
    );
    assert.equal(
      authority.translation.replaceAll('\r\n', '\n'),
      fs.readFileSync(path.resolve('scripts/testing/fixtures/watch-mode-en-original.zh-CN.txt'), 'utf8').replaceAll('\r\n', '\n'),
    );

    const forged = fs.readFileSync(referencePcmPath);
    forged.writeInt16LE(forged.readInt16LE(0) ^ 1, 0);
    fs.writeFileSync(referencePcmPath, forged);
    const rejected = runPowerShell(['-Command', command]);
    assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
    const rejectedAuthority = JSON.parse(rejected.stdout.trim());
    assert.equal(rejectedAuthority.passed, false);
    assert.match(rejectedAuthority.error, /not byte-for-byte the injector reconstruction/);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('strict paid provider selection ignores a preceding alternate and rejects forged canonical identity', { skip: !isWindows }, () => {
  const providers = [{
    providerId: 'provider-alternate',
    templateId: 'template-alternate',
    kind: 'dashscope',
    model: 'alternate-before-canonical',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    streamEnabled: true,
    authRef: {
      kind: 'credential-ref', reference: 'credential://provider/dashscope/default',
      headerName: 'Authorization', scheme: 'bearer',
    },
    customHeaders: [],
    systemPromptTemplate: 'game-live-translation-cn',
    timeoutMs: 12_000,
    temperature: 0.2,
    maxOutputTokens: 256,
    responseModalities: ['text'],
    localModelCapabilityRegistry: [],
  }, {
    providerId: 'provider-dashscope',
    templateId: 'template-dashscope-realtime',
    kind: 'dashscope',
    model: 'persisted-model',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    streamEnabled: true,
    authRef: {
      kind: 'credential-ref', reference: 'credential://provider/dashscope/default',
      headerName: 'Authorization', scheme: 'bearer',
    },
    customHeaders: [],
    systemPromptTemplate: 'game-live-translation-cn',
    timeoutMs: 12_000,
    temperature: 0.2,
    maxOutputTokens: 256,
    responseModalities: ['text'],
    localModelCapabilityRegistry: [],
  }];
  const run = (strict, mutate = '') => {
    const command = `${extractedStrictPaidProviderFunctions()} ` +
      `$config = ${quotePowerShell(JSON.stringify({ providers }))} | ConvertFrom-Json; ` +
      `${mutate} ` +
      `Set-WatchModelOnConfig $config 'qwen3.5-omni-flash-realtime' 'dashscope-omni' $${strict ? 'true' : 'false'}; ` +
      `$config | ConvertTo-Json -Depth 10 -Compress`;
    return runPowerShell(['-Command', command]);
  };
  const strict = run(true);
  assert.equal(strict.status, 0, strict.stderr || strict.stdout);
  const strictConfig = JSON.parse(strict.stdout.trim());
  assert.equal(strictConfig.providers[0].model, 'alternate-before-canonical');
  assert.equal(strictConfig.providers[1].model, 'qwen3.5-omni-flash-realtime');

  const legacy = run(false);
  assert.equal(legacy.status, 0, legacy.stderr || legacy.stdout);
  const legacyConfig = JSON.parse(legacy.stdout.trim());
  // Non-strict mode retains the prior best-effort selection semantics. This
  // test only locks that strict provider pinning does not mutate that branch.
  assert.equal(legacyConfig.providers[0].model, 'alternate-before-canonical');
  assert.equal(legacyConfig.providers[1].model, 'persisted-model');

  const forged = run(true, `$config.providers[1].authRef.reference = 'credential://provider/attacker/default';`);
  assert.notEqual(forged.status, 0, 'forged strict provider credential reference must fail');
  assert.match(forged.stderr, /identity, endpoint, or credential reference/);
  const streamDisabled = run(true, '$config.providers[1].streamEnabled = $false;');
  assert.notEqual(streamDisabled.status, 0, 'strict provider must reject disabled streaming');
  for (const mutation of [
    `$config.providers[1].authRef.headerName = 'X-Api-Key';`,
    `$config.providers[1].authRef.scheme = 'Basic';`,
    `$config.providers[1].customHeaders = @([pscustomobject]@{ name='Authorization'; value='caller' });`,
    `$config.providers[1].systemPromptTemplate = 'caller-authored';`,
    `$config.providers[1].timeoutMs = 30000;`,
    `$config.providers[1].temperature = 0.8;`,
    `$config.providers[1].maxOutputTokens = 1024;`,
    `$config.providers[1].responseModalities = @('text','audio');`,
  ]) {
    const invalid = run(true, mutation);
    assert.notEqual(invalid.status, 0, `strict provider must reject ${mutation}`);
    assert.match(invalid.stderr, /identity, endpoint, or credential reference/);
  }
  for (const baseUrl of [
    'http://dashscope.aliyuncs.com/api/v1',
    'https://dashscope.aliyuncs.com:80/api/v1',
    'https://attacker@dashscope.aliyuncs.com/api/v1',
  ]) {
    const escaped = baseUrl.replaceAll("'", "''");
    const invalid = run(true, `$config.providers[1].baseUrl = '${escaped}';`);
    assert.notEqual(invalid.status, 0, `strict provider must reject ${baseUrl}`);
    assert.match(invalid.stderr, /identity, endpoint, or credential reference/);
  }
});

test('strict paid provider environment is exact, elevation-forwardable, non-strict inert, and restored', { skip: !isWindows }, () => {
  const command = `${extractedStrictPaidProviderFunctions()} ` +
    `$names = @(` +
      `'OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY',` +
      `'OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID',` +
      `'OMNI_WATCH_MODE_EXPECTED_PROVIDER_TEMPLATE_ID',` +
      `'OMNI_WATCH_MODE_EXPECTED_PROVIDER_KIND',` +
      `'OMNI_WATCH_MODE_EXPECTED_PROVIDER_ENDPOINT_HOST',` +
      `'OMNI_WATCH_MODE_EXPECTED_PROVIDER_CREDENTIAL_REFERENCE'` +
    `); ` +
    `foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, ('before-' + $name), 'Process') }; ` +
    `$nonStrict = Enter-StrictPaidProviderEnvironment $false; ` +
    `$nonStrictValues = @{}; foreach ($name in $names) { $nonStrictValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }; ` +
    `Exit-StrictPaidProviderEnvironment $nonStrict; ` +
    `$strict = Enter-StrictPaidProviderEnvironment $true; ` +
    `$normal = @{}; foreach ($name in $strict.names) { $normal[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }; ` +
    `$elevatedLaunchEnvironment = @{}; foreach ($name in $strict.names) { $elevatedLaunchEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }; ` +
    `Exit-StrictPaidProviderEnvironment $strict; ` +
    `$restored = @{}; foreach ($name in $names) { $restored[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }; ` +
    `[pscustomobject]@{ names=@($strict.names); expected=$strict.values; nonStrict=$nonStrictValues; normal=$normal; elevated=$elevatedLaunchEnvironment; restored=$restored } | ConvertTo-Json -Depth 8 -Compress`;
  const result = runPowerShell(['-Command', command]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const authority = JSON.parse(result.stdout.trim());
  assert.equal(authority.names.length, 6);
  assert.deepEqual(authority.normal, authority.expected);
  assert.deepEqual(authority.elevated, authority.expected);
  for (const name of authority.names) {
    assert.equal(authority.nonStrict[name], `before-${name}`);
    assert.equal(authority.restored[name], `before-${name}`);
  }
});

test('local translated-audio lifecycle requires each rendered cue to reach queued, started, and completed exactly once in order', { skip: !isWindows }, () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-cue-playback-'));
  const appLogPath = path.join(outputDirectory, 'app.log');
  const marker = 'run-marker-local-cue';
  fs.writeFileSync(path.join(outputDirectory, 'watch-session-report.json'), JSON.stringify({
    cues: [{
      cueId: 'omni-cue-123',
      comparisonStatus: 'exact',
      llmText: '译文',
      publishedText: '译文',
      renderedText: '译文',
    }],
  }), 'utf8');
  fs.writeFileSync(path.join(outputDirectory, 'physical-playback-device.json'), JSON.stringify({
    verified: true,
    resolvedDeviceId: 'endpoint-1',
    resolvedDeviceName: 'Speakers',
  }), 'utf8');
  try {
    const run = (cueId, extraLines = []) => {
      fs.writeFileSync(appLogPath, [
        marker,
        `event=translation_playback_status | cueId=${cueId} status=queued reason=accepted`,
        `event=translation_playback_status | cueId=${cueId} status=started reason=physical-playback-started`,
        `event=translation_playback_status | cueId=${cueId} status=completed reason=physical-playback-completed`,
        ...extraLines,
      ].join('\n'), 'utf8');
      const command = `${extractedCuePlaybackAuthorityFunctions()} ` +
        `Read-TranslatedCuePlaybackAuthority ${quotePowerShell(outputDirectory)} ${quotePowerShell(appLogPath)} ${quotePowerShell(marker)} | ConvertTo-Json -Depth 8 -Compress`;
      const result = runPowerShell(['-Command', command]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.ok(result.stdout.trim(), result.stderr || 'PowerShell returned no cue lifecycle JSON');
      return JSON.parse(result.stdout.trim());
    };
    const passed = run('omni-cue-123');
    assert.equal(passed.passed, true);
    assert.deepEqual(passed.matchedCueIds, ['omni-cue-123']);
    assert.equal(passed.resolvedPhysicalDeviceId, 'endpoint-1');

    const mismatched = run('omni-cue-other');
    assert.equal(mismatched.passed, false);
    assert.equal(mismatched.matchedCueCount, 0);

    const duplicated = run('omni-cue-123', [
      'event=translation_playback_status | cueId=omni-cue-123 status=completed reason=duplicate',
    ]);
    assert.equal(duplicated.passed, false);
    assert.equal(duplicated.invalidCues[0].completedCount, 2);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

function extractedPhysicalOutputContentPolicyFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -eq 'Get-PhysicalOutputContentSkipReason' ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

function extractedSaveWatchModeRunArtifactsFunction() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$function = $ast.Find({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -eq 'Save-WatchModeRunArtifacts' ` +
    `}, $true); ` +
    `. ([scriptblock]::Create($function.Extent.Text)); `
  );
}

function extractedPhysicalOutputSttCredentialFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -eq 'Get-PhysicalOutputSttApiKey' ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

function extractedBridgeProbePolicyFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -in @(` +
        `'Test-UsesVirtualDriverBackend',` +
        `'New-BridgeSourceProbeInitPayload',` +
        `'Get-WatchModeDriverProbeArguments',` +
        `'Get-VirtualDriverPreflightFailure'` +
      `) ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

function extractedPhysicalDeviceEvidenceFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -in @(` +
        `'Get-PhysicalPlaybackDeviceClassFromSignals',` +
        `'New-PhysicalPlaybackDeviceEvidence'` +
      `) ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
}

function extractedLiveScenarioEnvironmentFunctions() {
  return (
    `$errors = $null; ` +
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
      `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
    `$functions = $ast.FindAll({ param($node) ` +
      `$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and ` +
      `$node.Name -eq 'Get-WatchModeLiveScenarioEnvironment' ` +
    `}, $true); ` +
    `foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }; `
  );
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

test('physical endpoint evidence accepts USB and Bluetooth signals and rejects a mismatched class', { skip: !isWindows }, () => {
  const probe = runPowerShell([
    '-Command',
    extractedPhysicalDeviceEvidenceFunctions() +
      `$usb = New-PhysicalPlaybackDeviceEvidence ` +
        `-ProfileId 'usb-dac' -ExpectedDeviceClass 'usb' -RequestedDeviceId 'usb-requested' ` +
        `-ResolvedDeviceId 'USB\\VID_1234&PID_5678\\endpoint' -ResolvedDeviceName 'USB DAC' ` +
        `-ClassificationSignals @('USB Audio Device','VID_1234') -RouteEvidenceSource 'test'; ` +
      `$bluetooth = New-PhysicalPlaybackDeviceEvidence ` +
        `-ProfileId 'bt-headset' -ExpectedDeviceClass 'bluetooth' -RequestedDeviceId 'bt-requested' ` +
        `-ResolvedDeviceId 'BTHENUM\\DEV_001' -ResolvedDeviceName 'Headphones' ` +
        `-ClassificationSignals @('Bluetooth','A2DP') -RouteEvidenceSource 'test'; ` +
      `$mismatchRejected = $false; ` +
      `try { ` +
        `New-PhysicalPlaybackDeviceEvidence ` +
          `-ProfileId 'wrong' -ExpectedDeviceClass 'usb' -RequestedDeviceId 'wrong' ` +
          `-ResolvedDeviceId 'BTHENUM\\DEV_002' -ResolvedDeviceName 'Bluetooth Headset' ` +
          `-ClassificationSignals @('Bluetooth','A2DP') -RouteEvidenceSource 'test' -ErrorAction Stop | Out-Null ` +
      `} catch { $mismatchRejected = $true }; ` +
      `[pscustomobject]@{ usb = $usb; bluetooth = $bluetooth; mismatchRejected = $mismatchRejected } | ConvertTo-Json -Depth 6`,
  ]);
  assert.equal(probe.status, 0, `device evidence probe failed:\n${probe.stderr}`);
  const result = JSON.parse(probe.stdout.trim());
  assert.equal(result.usb.deviceClass, 'usb');
  assert.equal(result.usb.verified, true);
  assert.equal(result.usb.fixtureOnly, false);
  assert.equal(result.bluetooth.deviceClass, 'bluetooth');
  assert.equal(result.bluetooth.verified, true);
  assert.equal(result.mismatchRejected, true);
});

test('live runner duration binder accepts the 180-second pairwise floor and rejects shorter or oversized runs', { skip: !isWindows }, () => {
  const probe = runPowerShell([
    '-Command',
    `$errors = $null; ` +
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile(` +
        `${quotePowerShell(path.resolve(scriptPath))}, [ref]$null, [ref]$errors); ` +
      `if ($errors.Count -gt 0) { exit 2 }; ` +
      `$durationProbe = [scriptblock]::Create(` +
        `$ast.ParamBlock.Extent.Text + [Environment]::NewLine + '$WatchAutoStopAfterSeconds'` +
      `); ` +
      `$accepted = & $durationProbe -WatchAutoStopAfterSeconds 180; ` +
      `$shortRejected = $false; ` +
      `try { & $durationProbe -WatchAutoStopAfterSeconds 179 -ErrorAction Stop | Out-Null } ` +
      `catch { $shortRejected = $true }; ` +
      `$oversizedRejected = $false; ` +
      `try { & $durationProbe -WatchAutoStopAfterSeconds 7201 -ErrorAction Stop | Out-Null } ` +
      `catch { $oversizedRejected = $true }; ` +
      `if ($accepted -eq 180 -and $shortRejected -and $oversizedRejected) { exit 0 }; ` +
      `Write-Error "duration validation mismatch: accepted=$accepted shortRejected=$shortRejected oversizedRejected=$oversizedRejected"; exit 1`,
  ]);

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
});

test('live runner schedules a midpoint process restart and does not truncate 1800 seconds to five minutes', { skip: !isWindows }, () => {
  const probe = runPowerShell([
    '-Command',
    extractedLiveScenarioEnvironmentFunctions() +
      `$process = Get-WatchModeLiveScenarioEnvironment -FeedbackMode 'process-exclusion' -AutoStopAfterMs 1800000; ` +
      `$aec = Get-WatchModeLiveScenarioEnvironment -FeedbackMode 'echo-cancel' -AutoStopAfterMs 1800000; ` +
      `$virtual = Get-WatchModeLiveScenarioEnvironment -FeedbackMode 'virtual-driver' -AutoStopAfterMs 1800000; ` +
      `[pscustomobject]@{ process = $process; aec = $aec; virtual = $virtual } | ConvertTo-Json -Depth 4 -Compress`,
  ]);

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const result = JSON.parse(probe.stdout.trim());
  assert.equal(result.process.autoStopAfterMs, '1800000');
  assert.equal(result.process.processExclusionRestartAfterMs, '900000');
  assert.equal(result.process.aecLiveScenario, null);
  assert.equal(result.aec.autoStopAfterMs, '1800000');
  assert.equal(result.aec.processExclusionRestartAfterMs, null);
  assert.equal(result.aec.aecLiveScenario, '1');
  assert.equal(result.virtual.autoStopAfterMs, '1800000');
  assert.equal(result.virtual.processExclusionRestartAfterMs, null);
  assert.equal(result.virtual.aecLiveScenario, null);
});

test('watch report deadline includes readiness, 30-minute capture, and atomic-write grace', { skip: !isWindows }, () => {
  const probe = runPowerShell([
    '-Command',
    extractedReportWaitFunctions() +
      `$launched = [DateTime]::SpecifyKind([DateTime]::Parse('2026-08-10T00:00:00'), [DateTimeKind]::Utc); ` +
      `$deadline = Get-WatchSessionReportDeadlineUtc ` +
        `-LaunchedAtUtc $launched -ReadyTimeoutSeconds 90 -AutoStopAfterSeconds 1800; ` +
      `[int]($deadline - $launched).TotalSeconds`,
  ]);

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.equal(Number(probe.stdout.trim()), 2_010);
});

test('echo-cancel skips virtual-driver physical-output content recording', { skip: !isWindows }, () => {
  const policy = runPowerShell([
    '-Command',
    `${extractedPhysicalOutputContentPolicyFunctions()} ` +
      `$echo = Get-PhysicalOutputContentSkipReason -FeedbackMode 'echo-cancel' -SkipContentStt $false; ` +
      `$process = Get-PhysicalOutputContentSkipReason -FeedbackMode 'process-exclusion' -SkipContentStt $false; ` +
      `$explicit = Get-PhysicalOutputContentSkipReason -FeedbackMode 'virtual-driver' -SkipContentStt $true; ` +
      `$normal = Get-PhysicalOutputContentSkipReason -FeedbackMode 'virtual-driver' -SkipContentStt $false; ` +
      `if ($echo -and $explicit -and -not $normal -and -not $process) { exit 0 }; exit 1`,
  ]);

  assert.equal(policy.status, 0, policy.stderr || policy.stdout);
});

test('artifact saving omits echo-cancel physical-content placeholders but preserves non-echo skip diagnostics', { skip: !isWindows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-content-artifact-policy-'));
  const echoDirectory = path.join(root, 'echo-cancel');
  const virtualDirectory = path.join(root, 'virtual-driver');
  fs.mkdirSync(echoDirectory);
  fs.mkdirSync(virtualDirectory);
  try {
    const probe = runPowerShell([
      '-Command',
      extractedSaveWatchModeRunArtifactsFunction() +
        `$RuntimeRoot = ${quotePowerShell(root)}; ` +
        `function Copy-IfExists { return $null }; ` +
        `function Build-SnapshotsFile { return $null }; ` +
        `function Invoke-ReportGenerator { }; ` +
        `$steps = @([pscustomobject]@{ ` +
          `name = 'transcribe and compare physical output content'; ` +
          `ok = $true; ` +
          `result = [pscustomobject]@{ skipped = $true; reason = 'policy skip' }; ` +
          `error = $null ` +
        `}); ` +
        `$FeedbackLoopPrevention = 'echo-cancel'; ` +
        `Save-WatchModeRunArtifacts ` +
          `-OutputDirectory ${quotePowerShell(echoDirectory)} ` +
          `-DriverProbe $null -PlaybackStep $null -Steps $steps ` +
          `-RunMarker 'echo-marker' -StartedAtLocal '2026-08-13 00:00:00'; ` +
        `$FeedbackLoopPrevention = 'virtual-driver'; ` +
        `Save-WatchModeRunArtifacts ` +
          `-OutputDirectory ${quotePowerShell(virtualDirectory)} ` +
          `-DriverProbe $null -PlaybackStep $null -Steps $steps ` +
          `-RunMarker 'virtual-marker' -StartedAtLocal '2026-08-13 00:00:00'`,
    ]);

    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    assert.ok(
      forbiddenCellArtifactPaths('echo-cancel').includes('physical-output-content.json'),
      'the collector test must stay aligned with the strict authority exclusion',
    );
    assert.equal(
      fs.existsSync(path.join(echoDirectory, 'physical-output-content.json')),
      false,
      'echo-cancel must not emit an artifact forbidden by strict authority',
    );
    const virtualArtifact = readJsonArtifact(path.join(virtualDirectory, 'physical-output-content.json'));
    assert.equal(virtualArtifact.skipped, true);
    assert.equal(virtualArtifact.reason, 'policy skip');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('physical output STT falls back to the current-user DashScope credential without persisting it', { skip: !isWindows }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-output-stt-credential-'));
  try {
    const probe = runPowerShell([
      '-Command',
      `${extractedPhysicalOutputSttCredentialFunctions()} ` +
        `$workspaceRoot = ${quotePowerShell(directory)}; ` +
        `Remove-Item Env:OMNI_TEST_DASHSCOPE_API_KEY -ErrorAction SilentlyContinue; ` +
        `function global:Add-Type { param([Parameter(ValueFromRemainingArguments=$true)]$Arguments) throw 'unexpected native credential invocation' }; ` +
        `function global:OmniWatchCredentialReader { }; ` +
        `class OmniWatchCredentialReader { static [string] ReadGenericSecret([string]$target) { if ($target -ne 'OmniTranslate:credential___provider_dashscope_default') { throw 'unexpected target' }; return 'vault-only-test-key' } }; ` +
        `$result = Get-PhysicalOutputSttApiKey; ` +
        `if ($result -ne 'vault-only-test-key') { exit 1 }`,
    ]);
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bridge probe policy uses v6 init fields and blocks a failed virtual-driver probe before a model session', { skip: !isWindows }, () => {
  const probe = runPowerShell([
    '-Command',
    extractedBridgeProbePolicyFunctions() +
      `$payload = New-BridgeSourceProbeInitPayload -FeedbackMode 'process-exclusion' -SessionId 'probe-session'; ` +
      `$driverArgs = Get-WatchModeDriverProbeArguments -WorkspaceRoot 'E:\\workspace' -RequestedDevconPath 'E:\\workspace\\tools\\devcon.exe'; ` +
      `$virtualFailure = Get-VirtualDriverPreflightFailure 'virtual-driver' ([pscustomobject]@{ ok = $false; error = 'installed driver hash differs from package' }); ` +
      `$virtualSuccess = Get-VirtualDriverPreflightFailure 'virtual-driver' ([pscustomobject]@{ ok = $true; error = $null }); ` +
      `$processFailure = Get-VirtualDriverPreflightFailure 'process-exclusion' ([pscustomobject]@{ ok = $false; error = 'not relevant' }); ` +
      `$result = [pscustomobject]@{ ` +
        `payload = $payload; ` +
        `processUsesDriver = Test-UsesVirtualDriverBackend 'process-exclusion'; ` +
        `echoUsesDriver = Test-UsesVirtualDriverBackend 'echo-cancel'; ` +
        `virtualUsesDriver = Test-UsesVirtualDriverBackend 'virtual-driver'; ` +
        `driverProbeArguments = $driverArgs; ` +
        `virtualFailure = $virtualFailure; ` +
        `virtualSuccess = $virtualSuccess; ` +
        `processFailure = $processFailure ` +
      `}; $result | ConvertTo-Json -Depth 8 -Compress`,
  ]);

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const result = JSON.parse(probe.stdout.trim());
  assert.equal(result.payload.protocolVersion, '2026-08-13-audio-routing-v7');
  assert.equal(result.payload.sourceCaptureMode, 'process-exclusion');
  assert.equal(result.payload.sessionId, 'probe-session');
  assert.equal(result.payload.monitorPlaybackEnabled, false);
  assert.equal(result.payload.translationPlaybackEnabled, true);
  assert.equal(result.processUsesDriver, false);
  assert.equal(result.echoUsesDriver, false);
  assert.equal(result.virtualUsesDriver, true);
  assert.equal(result.driverProbeArguments.WorkspaceRoot, 'E:\\workspace');
  assert.equal(result.driverProbeArguments.DevconPath, 'E:\\workspace\\tools\\devcon.exe');
  assert.match(result.virtualFailure, /before the Desktop\/LLM session/i);
  assert.match(result.virtualFailure, /installed driver hash differs/i);
  assert.equal(result.virtualSuccess, null);
  assert.equal(result.processFailure, null);
});

test('app readiness wait fails immediately on diagnostic IPC infrastructure error', { skip: !isWindows }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-ipc-infrastructure-failure-'));
  const logPath = path.join(directory, 'app.log');
  const runMarker = 'watch-ipc-gate-test-marker';
  fs.writeFileSync(
    logPath,
    [
      'old unrelated log line',
      runMarker,
      'ERROR watch_mode.diagnostic_autostart_infrastructure_failed category=infrastructure code=frontend-ipc-not-ready',
    ].join('\n'),
    'utf8',
  );
  try {
    const probe = runPowerShell([
      '-Command',
      extractedAppLogWaitFunctions() +
        `$stopwatch = [System.Diagnostics.Stopwatch]::StartNew(); ` +
        `try { ` +
          `Wait-AppLogPattern ` +
            `-Path ${quotePowerShell(logPath)} ` +
            `-RunMarker ${quotePowerShell(runMarker)} ` +
            `-Pattern 'watch_mode\.omni_session_ready' ` +
            `-TimeoutSeconds 30 | Out-Null; ` +
          `throw 'expected infrastructure failure' ` +
        `} catch { ` +
          `if ($_.Exception.Message -notmatch 'watch-mode infrastructure failure.*frontend-ipc-not-ready') { throw }; ` +
          `if ($stopwatch.ElapsedMilliseconds -gt 5000) { throw "infrastructure failure was not surfaced promptly: $($stopwatch.ElapsedMilliseconds)ms" } ` +
        `}; ` +
        `exit 0`,
    ]);
    assert.equal(
      probe.status,
      0,
      `IPC infrastructure failure probe failed:\nstdout=${probe.stdout}\nstderr=${probe.stderr}\nerror=${probe.error?.message ?? '-'}`,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('elevated command guard refuses a delayed launch after its runner identity is gone', { skip: !isWindows }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-elevation-stale-parent-'));
  const markerPath = path.join(directory, 'must-not-launch.txt');
  try {
    const body = `Set-Content -LiteralPath ${quotePowerShell(markerPath)} -Value 'launched' -Encoding UTF8`;
    const probe = runPowerShell([
      '-Command',
      extractedElevationGuardFunctions() +
        `$encoded = New-ParentGuardedPowerShellCommand ` +
          `-ParentProcessId 2147483647 -ParentStartTimeUtcTicks 1 ` +
          `-CommandBody ${quotePowerShell(body)}; ` +
        `$child = Start-Process -FilePath 'powershell.exe' ` +
          `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded) ` +
          `-WindowStyle Hidden -Wait -PassThru; ` +
        `if ($child.ExitCode -ne 125) { throw "expected stale-parent exit 125; got $($child.ExitCode)" }`,
    ]);
    assert.equal(probe.status, 0, `stale-parent guard probe failed:\n${probe.stderr}`);
    assert.equal(fs.existsSync(markerPath), false, 'a delayed elevated command must not execute after its runner is gone');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('elevated desktop guardian command is syntactically valid for quoted Windows paths', { skip: !isWindows }, () => {
  const directory = path.join(os.tmpdir(), "watch guardian's quoted path");
  const probe = runPowerShell([
    '-Command',
    extractedElevationGuardFunctions() +
      `$encoded = New-ElevatedDesktopGuardianCommand ` +
        `-ParentProcessId $PID ` +
        `-ParentStartTimeUtcTicks ([System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks) ` +
        `-LeasePath ${quotePowerShell(path.join(directory, 'launch.lease'))} ` +
        `-EnvironmentPath ${quotePowerShell(path.join(directory, 'environment.json'))} ` +
        `-ReceiptPath ${quotePowerShell(path.join(directory, 'receipt.json'))} ` +
        `-ExecutablePath ${quotePowerShell(path.join(directory, 'desktop shell.exe'))} ` +
        `-WorkingDirectory ${quotePowerShell(directory)} ` +
        `-StdoutPath ${quotePowerShell(path.join(directory, 'stdout.log'))} ` +
        `-StderrPath ${quotePowerShell(path.join(directory, 'stderr.log'))}; ` +
      `$generated = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded)); ` +
      `$generatedErrors = $null; ` +
      `[void][System.Management.Automation.Language.Parser]::ParseInput($generated, [ref]$null, [ref]$generatedErrors); ` +
      `foreach ($error in $generatedErrors) { Write-Error $error.Message }; ` +
      `if ($generatedErrors.Count -gt 0) { exit $generatedErrors.Count }; ` +
      `if ($generated -match '(?m)^\\s+-WorkingDirectory\\b') { ` +
        `throw 'generated guardian contains a detached Start-Process parameter' ` +
      `}`,
  ]);
  assert.equal(probe.status, 0, `generated elevated guardian has syntax errors:\n${probe.stderr}`);
  assert.match(probe.stdout + probe.stderr, /^$/);
});

test('elevated desktop guardian refuses to launch when its lease was cancelled', { skip: !isWindows }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-elevation-cancelled-lease-'));
  const environmentPath = path.join(directory, 'environment.json');
  const receiptPath = path.join(directory, 'receipt.json');
  const leasePath = path.join(directory, 'cancelled.lease');
  fs.writeFileSync(environmentPath, '{}');
  try {
    const probe = runPowerShell([
      '-Command',
      extractedElevationGuardFunctions() +
        `$encoded = New-ElevatedDesktopGuardianCommand ` +
          `-ParentProcessId $PID ` +
          `-ParentStartTimeUtcTicks ([System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks) ` +
          `-LeasePath ${quotePowerShell(leasePath)} ` +
          `-EnvironmentPath ${quotePowerShell(environmentPath)} ` +
          `-ReceiptPath ${quotePowerShell(receiptPath)} ` +
          `-ExecutablePath ${quotePowerShell(path.join(directory, 'must-not-launch.exe'))} ` +
          `-WorkingDirectory ${quotePowerShell(directory)} ` +
          `-StdoutPath ${quotePowerShell(path.join(directory, 'stdout.log'))} ` +
          `-StderrPath ${quotePowerShell(path.join(directory, 'stderr.log'))}; ` +
        `$guardian = Start-Process -FilePath 'powershell.exe' ` +
          `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded) ` +
          `-WindowStyle Hidden -Wait -PassThru; ` +
        `if ($guardian.ExitCode -ne 125) { throw "expected cancelled-lease exit 125; got $($guardian.ExitCode)" }`,
    ]);
    assert.equal(probe.status, 0, `cancelled-lease guardian probe failed:\n${probe.stderr}`);
    assert.equal(fs.existsSync(receiptPath), false, 'a cancelled guardian must exit before launching or writing a receipt');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('provider summary ignores successful credential lifecycle lines after the run marker', { skip: !isWindows }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-provider-summary-success-'));
  const appLogPath = path.join(directory, 'app.log');
  const marker = 'watch-summary-marker';
  fs.writeFileSync(appLogPath, [
    'provider HTTP 401 invalid api key from a stale run',
    marker,
    '[storage] [omni][credential] start action=读取 API Key timeoutMs=5000',
    '[storage] [omni][credential] finish action=读取 API Key outcome=ok',
    '[storage] [omni][credential] CredReadW succeeded target=provider-dashscope',
    '[provider-dashscope] realtime profile timeoutBudgetMs=95000',
    '[provider-dashscope] realtime session ready',
  ].join('\n'));
  try {
    const probe = runPowerShell([
      '-Command',
      extractedProviderSummaryFunctions() +
        `Read-RecentProviderSummary -AppLog ${quotePowerShell(appLogPath)} ` +
        `-RunMarker ${quotePowerShell(marker)} | ConvertTo-Json -Compress`,
    ]);
    assert.equal(probe.status, 0, `provider summary probe failed:\n${probe.stderr}`);
    const summary = JSON.parse(probe.stdout.trim());
    assert.equal(summary.totalCalls, 5);
    assert.equal(summary.failedCalls, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('provider summary still counts credential failures and rate-limit responses', { skip: !isWindows }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-provider-summary-failure-'));
  const appLogPath = path.join(directory, 'app.log');
  const marker = 'watch-failure-marker';
  fs.writeFileSync(appLogPath, [
    marker,
    '[storage] [omni][credential] CredReadW failed: credential access denied',
    '[provider-dashscope] HTTP 429 rate limit exceeded',
    '[provider-dashscope] request timeout: upstream timed out',
    '[storage] [omni][credential] finish action=读取 API Key outcome=ok',
  ].join('\n'));
  try {
    const probe = runPowerShell([
      '-Command',
      extractedProviderSummaryFunctions() +
        `Read-RecentProviderSummary -AppLog ${quotePowerShell(appLogPath)} ` +
        `-RunMarker ${quotePowerShell(marker)} | ConvertTo-Json -Compress`,
    ]);
    assert.equal(probe.status, 0, `provider summary probe failed:\n${probe.stderr}`);
    const summary = JSON.parse(probe.stdout.trim());
    assert.equal(summary.totalCalls, 4);
    assert.equal(summary.failedCalls, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('app readiness requires provider and frontend IPC evidence from the run-marker session', { skip: !isWindows }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-app-readiness-pass-'));
  const appLogPath = path.join(directory, 'app.log');
  const nativeIpcLogPath = path.join(directory, 'app-native-ipc.log');
  const marker = 'watch_mode_diagnostic.run_id=readiness-pass';
  const sessionId = '019fb-ready-pass';
  fs.writeFileSync(appLogPath, [
    marker,
    `[runtime] watch_mode.diagnostic_autostart_requested | runMarker=${marker} sid=${sessionId}`,
    `[omni] watch_mode.omni_session_ready | event=session.created sid=${sessionId}`,
    `[runtime] startup.step check-ipc=done | 31ms sid=${sessionId}`,
  ].join('\n'));
  fs.writeFileSync(nativeIpcLogPath, [
    marker,
    `[runtime] watch_mode.diagnostic_autostart_requested | runMarker=${marker} sid=${sessionId}`,
    `[runtime] watch_mode.diagnostic_autostart_ipc_ready | runMarker=${marker} waitedMs=41 sid=${sessionId}`,
    `[omni] watch_mode.omni_session_ready | event=session.created sid=${sessionId}`,
  ].join('\n'));
  try {
    const probe = runPowerShell([
      '-Command',
      extractedAppReadinessFunctions() +
        `$startupStepResult = Wait-WatchModeAppReadiness ` +
          `-Path ${quotePowerShell(appLogPath)} ` +
          `-RunMarker ${quotePowerShell(marker)} ` +
          `-ProcessId $PID ` +
          `-DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1)); ` +
        `$nativeIpcResult = Wait-WatchModeAppReadiness ` +
          `-Path ${quotePowerShell(nativeIpcLogPath)} ` +
          `-RunMarker ${quotePowerShell(marker)} ` +
          `-ProcessId $PID ` +
          `-DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1)); ` +
        `[pscustomobject]@{ startupStep = $startupStepResult; nativeIpc = $nativeIpcResult } | ConvertTo-Json -Depth 4 -Compress`,
    ]);
    assert.equal(probe.status, 0, `same-session readiness should pass:\n${probe.stderr}`);
    const result = JSON.parse(probe.stdout.trim());
    for (const evidence of [result.startupStep, result.nativeIpc]) {
      assert.equal(evidence.sessionId, sessionId);
      assert.equal(evidence.providerReady, true);
      assert.equal(evidence.frontendIpcReady, true);
      assert.equal(evidence.pid > 0, true);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('provider readiness alone cannot start playback and reports actionable frontend diagnostics', { skip: !isWindows }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-app-readiness-no-ipc-'));
  const appLogPath = path.join(directory, 'app.log');
  const stdoutPath = path.join(directory, 'desktop.stdout.log');
  const stderrPath = path.join(directory, 'desktop.stderr.log');
  const marker = 'watch_mode_diagnostic.run_id=readiness-no-ipc';
  const sessionId = '019fb-ready-no-ipc';
  fs.writeFileSync(appLogPath, [
    marker,
    `[runtime] watch_mode.diagnostic_autostart_requested | runMarker=${marker} sid=${sessionId}`,
    `[omni] watch_mode.omni_session_ready | event=session.created sid=${sessionId}`,
    '[runtime] startup.step check-ipc=done | stale renderer from another process sid=wrong-session',
  ].join('\n'));
  fs.writeFileSync(stdoutPath, 'desktop stdout: renderer navigation started');
  fs.writeFileSync(stderrPath, 'desktop stderr: frontend resource unavailable');
  try {
    const startedAt = Date.now();
    const probe = runPowerShell([
      '-Command',
      extractedAppReadinessFunctions() +
        `Wait-WatchModeAppReadiness ` +
          `-Path ${quotePowerShell(appLogPath)} ` +
          `-RunMarker ${quotePowerShell(marker)} ` +
          `-ProcessId $PID ` +
          `-DeadlineUtc ([DateTime]::UtcNow.AddMilliseconds(300)) ` +
          `-DesktopStdoutPath ${quotePowerShell(stdoutPath)} ` +
          `-DesktopStderrPath ${quotePowerShell(stderrPath)} | Out-Null`,
    ]);
    assert.notEqual(probe.status, 0, 'provider-only readiness must fail before playback');
    assert.match(probe.stderr, /infrastructure\/frontend not ready before playback/i);
    assert.match(probe.stderr, /ProviderReady=True/i);
    assert.match(probe.stderr, /FrontendIpcReady=False/i);
    assert.match(probe.stderr, /startup\.step check-ipc=done/i);
    assert.match(probe.stderr, /frontend resource unavailable/i);
    assert.ok(Date.now() - startedAt < 10_000, 'frontend readiness failure must honor its absolute deadline');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('same-process report wait accepts only completed JSON and has an absolute deadline', { skip: !isWindows }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-report-wait-'));
  const completedPath = path.join(directory, 'completed.json');
  const activePath = path.join(directory, 'active.json');
  const missingPath = path.join(directory, 'missing.json');
  fs.writeFileSync(completedPath, JSON.stringify({ sessionId: 'watch-complete', status: 'completed' }));
  fs.writeFileSync(activePath, JSON.stringify({ sessionId: 'watch-active', status: 'active' }));
  try {
    const completed = runPowerShell([
      '-Command',
      extractedReportWaitFunctions() +
        `Wait-WatchSessionReportAndDesktopExit -Path ${quotePowerShell(completedPath)} ` +
        `-ProcessId 2147483647 -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1)) | Out-Null`,
    ]);
    assert.equal(completed.status, 0, `completed report should pass:\n${completed.stderr}`);

    const active = runPowerShell([
      '-Command',
      extractedReportWaitFunctions() +
        `Wait-WatchSessionReportAndDesktopExit -Path ${quotePowerShell(activePath)} ` +
        `-ProcessId 2147483647 -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1)) | Out-Null`,
    ]);
    assert.notEqual(active.status, 0, 'an active report must fail the completed-report contract');
    assert.match(active.stderr, /report is not completed/i);

    const startedAt = Date.now();
    const missing = runPowerShell([
      '-Command',
      extractedReportWaitFunctions() +
        `Wait-WatchSessionReportAndDesktopExit -Path ${quotePowerShell(missingPath)} ` +
        `-ProcessId $PID -DeadlineUtc ([DateTime]::UtcNow.AddMilliseconds(300)) | Out-Null`,
    ]);
    assert.notEqual(missing.status, 0, 'a missing report must fail at the absolute deadline');
    assert.match(missing.stderr, /timed out waiting for same-process Watch report/i);
    // powershell.exe process startup can take several seconds on a busy Windows
    // CI/dev host; the function-level deadline above remains 300 ms.
    assert.ok(Date.now() - startedAt < 10_000, 'absolute-deadline wait should remain bounded');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

    // Feedback config injection must be probed for all modes and each probe
    // must have landed the requested mode in the effective config.
    const injection = readJsonArtifact(path.join(runDirectory, 'config-injection.json'));
    assert.equal(injection.selectedFeedbackLoopPrevention, 'virtual-driver');
    assert.deepEqual(
      injection.variants.map((variant) => variant.requested).sort(),
      ['echo-cancel', 'process-exclusion', 'virtual-driver'],
    );
    for (const variant of injection.variants) {
      assert.equal(variant.injected, variant.requested, `feedback injection drifted for ${variant.requested}`);
      assert.equal(variant.monitorMode, 'original-and-translated');
    }

    // The fixture snapshots must be stamped with the selected feedback mode
    // so evidence from different modes can never mask each other.
    const snapshots = readJsonArtifact(path.join(runDirectory, 'snapshots.json'));
    assert.equal(snapshots.feedbackLoopPrevention, 'virtual-driver');
    assert.deepEqual(
      {
        profileId: snapshots.deviceEvidence.profileId,
        deviceClass: snapshots.deviceEvidence.deviceClass,
        requestedDeviceId: snapshots.deviceEvidence.requestedDeviceId,
        verified: snapshots.deviceEvidence.verified,
        fixtureOnly: snapshots.deviceEvidence.fixtureOnly,
      },
      {
        profileId: 'default-speaker',
        deviceClass: 'default-speaker',
        requestedDeviceId: 'default',
        verified: false,
        fixtureOnly: true,
      },
    );
    assert.match(snapshots.deviceEvidence.resolvedDeviceId, /HDAUDIO/i);

    // The generated report must classify the healthy fixture as passed; a
    // report-pipeline regression turns this into a hard failure.
    const report = readJsonArtifact(path.join(runDirectory, 'report.json'));
    assert.equal(report.verdict, 'passed', `dry-run fixture report failed: ${JSON.stringify(report, null, 2)}`);
    assert.equal(report.failureLayer, null);
    assert.equal(report.deviceEvidence.deviceClass, 'default-speaker');
    assert.equal(report.deviceEvidence.fixtureOnly, true);

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
  assert.deepEqual(matrix.DEFAULT_FEEDBACK_MODES, ['process-exclusion', 'virtual-driver', 'echo-cancel']);

  const argv = matrix.buildRunnerArgv({
    model: 'qwen3.5-omni-flash-realtime',
    feedbackMode: 'virtual-driver',
    physicalPlaybackDeviceClass: 'usb',
    physicalPlaybackDeviceProfileId: 'usb-dac',
    allowElevatedDesktopLaunch: true,
    runnerArgs: ['-DryRun'],
  });
  assert.equal(argv[argv.indexOf('-WatchModelId') + 1], 'qwen3.5-omni-flash-realtime');
  assert.equal(argv[argv.indexOf('-FeedbackLoopPrevention') + 1], 'virtual-driver');
  assert.equal(argv[argv.indexOf('-PlaybackSeconds') + 1], '0');
  assert.equal(argv[argv.indexOf('-PhysicalPlaybackDeviceClass') + 1], 'usb');
  assert.equal(argv[argv.indexOf('-PhysicalPlaybackDeviceProfileId') + 1], 'usb-dac');
  assert.ok(argv.includes('-AllowElevatedDesktopLaunch'));
  assert.deepEqual(argv.slice(-1), ['-DryRun'], 'runner passthrough args must stay appended verbatim');

  const verifyArgv = matrix.buildVerifyArgv(
    'artifacts/testing/watch-mode-live',
    matrix.DEFAULT_MODELS,
    matrix.DEFAULT_FEEDBACK_MODES,
    matrix.SUPPORTED_DEVICE_CLASSES,
    'E:\\artifacts\\watch-mode-current-manifest.json',
  );
  assert.equal(verifyArgv[0], './scripts/testing/verify-watch-mode-evidence.mjs');
  assert.ok(verifyArgv.includes('--strict'));
  assert.equal(verifyArgv[verifyArgv.indexOf('--models') + 1], matrix.DEFAULT_MODELS.join(','));
  assert.equal(verifyArgv[verifyArgv.indexOf('--feedback-modes') + 1], matrix.DEFAULT_FEEDBACK_MODES.join(','));
  assert.equal(verifyArgv[verifyArgv.indexOf('--device-classes') + 1], matrix.SUPPORTED_DEVICE_CLASSES.join(','));
  assert.equal(
    verifyArgv[verifyArgv.indexOf('--run-manifest') + 1],
    'E:\\artifacts\\watch-mode-current-manifest.json',
  );
});
