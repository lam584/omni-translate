import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { forbiddenCellArtifactPaths } from './watch-mode-evidence-authority.mjs';
import { buildCanonicalReferencePcm } from './watch-mode-canonical-source-authority.mjs';
import { validateWatchModeRunRequest } from './watch-mode-run-request.mjs';

// This suite executes the runner instead of grepping its source. Earlier
// versions asserted on string positions inside the .ps1, which validated
// wording rather than behavior (a reworded script broke the tests, a broken
// script with intact wording passed them). Coverage now comes from three
// executable layers:
//   1. PowerShell parser check — the script must stay syntactically valid.
//   2. -DryRun smoke — the dry-run path runs end to end and its artifacts
//      (config-injection.json, run-collection.json, report.json) are asserted on
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
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Report.psm1'))} -Force -DisableNameChecking; `;
}

function extractedAppReadinessFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Readiness.psm1'))} -Force; `;
}

function extractedElevationGuardFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.Windows.Elevation.psm1'))} -Force; `;
}

function extractedSpeechSegmentationFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Evidence.psm1'))} -Force -DisableNameChecking; `;
}

function extractedStrictPaidSourceAuthorityFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Stt.psm1'))} -Force -DisableNameChecking; `;
}

function extractedLocalSmokeProviderSessionAuthorityFunction() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.EvidenceCollection.psm1'))} -Force -DisableNameChecking; `;
}

function extractedMediaReferenceFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.AudioCapture.psm1'))} -Force -DisableNameChecking; `;
}

function extractedStrictPaidProviderFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Provider.psm1'))} -Force -DisableNameChecking; `;
}

function extractedCuePlaybackAuthorityFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.RawContent.psm1'))} -Force -DisableNameChecking; `;
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

test('paid source authorities use canonical hashes, fixture texts, and injector PCM without remote STT', { skip: !isWindows }, () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-canonical-source-'));
  const referencePcmPath = path.join(outputDirectory, 'source-media-reference-16k-mono.pcm');
  fs.writeFileSync(referencePcmPath, buildCanonicalReferencePcm({ workspaceRoot: path.resolve('.') }));
  try {
    const canonicalMedia = path.resolve('scripts/testing/fixtures/watch-mode-en-original.wav');
    for (const authorityMode of [
      'strict-paid',
      'incident-replay-plus',
      'local-canonical-smoke',
    ]) {
      const command = `${extractedStrictPaidSourceAuthorityFunctions()} ` +
        `$context = [pscustomobject]@{ paths=[pscustomobject]@{ workspaceRoot=${quotePowerShell(path.resolve('.'))} }; request=[pscustomobject]@{ authorityMode=${quotePowerShell(authorityMode)}; media=[pscustomobject]@{ playbackSeconds=0 } } }; ` +
        `function Get-PhysicalOutputSttApiKey { throw 'remote credential path must not execute' }; ` +
        `function Build-OmniRealtimeDiagnostic { throw 'remote diagnostic path must not execute' }; ` +
        `Get-SourceMediaReferenceTranscript ${quotePowerShell(outputDirectory)} ${quotePowerShell(canonicalMedia)} $context | ConvertTo-Json -Depth 4 -Compress`;
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
    }

    const forged = fs.readFileSync(referencePcmPath);
    forged.writeInt16LE(forged.readInt16LE(0) ^ 1, 0);
    fs.writeFileSync(referencePcmPath, forged);
    const command = `${extractedStrictPaidSourceAuthorityFunctions()} ` +
      `$context = [pscustomobject]@{ paths=[pscustomobject]@{ workspaceRoot=${quotePowerShell(path.resolve('.'))} }; request=[pscustomobject]@{ authorityMode='incident-replay-plus'; media=[pscustomobject]@{ playbackSeconds=0 } } }; ` +
      `function Get-PhysicalOutputSttApiKey { throw 'remote credential path must not execute' }; ` +
      `function Build-OmniRealtimeDiagnostic { throw 'remote diagnostic path must not execute' }; ` +
      `Get-SourceMediaReferenceTranscript ${quotePowerShell(outputDirectory)} ${quotePowerShell(canonicalMedia)} $context | ConvertTo-Json -Depth 4 -Compress`;
    const rejected = runPowerShell(['-Command', command]);
    assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
    const rejectedAuthority = JSON.parse(rejected.stdout.trim());
    assert.equal(rejectedAuthority.passed, false);
    assert.match(rejectedAuthority.error, /not byte-for-byte the injector reconstruction/);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('local smoke Provider-session authority binds one non-authoritative session and zero auxiliary calls', { skip: !isWindows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-smoke-provider-authority-'));
  const writeInputs = (directory, feedbackMode) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'smoke-provider-session-lease.json'), JSON.stringify({
      schemaVersion: 1,
      artifactKind: 'watch-mode-smoke-provider-session-lease',
      nonAuthoritative: true,
      cellId: 'smoke-cell',
      leaseId: 'smoke-lease',
      runMarker: 'smoke-marker',
      maxSamples: 2_880_000,
    }));
    fs.writeFileSync(path.join(directory, 'smoke-provider-session-ledger.json'), JSON.stringify({
      schemaVersion: 1,
      artifactKind: 'watch-mode-smoke-provider-session-ledger',
      nonAuthoritative: true,
      localSingleSessionAuthority: true,
      strictPaidAuthority: false,
      incidentReplayAuthority: false,
      cellId: 'smoke-cell',
      leaseId: 'smoke-lease',
      runMarker: 'smoke-marker',
      maxSamples: 2_880_000,
      sessionGeneration: 7,
      totalAttemptedSamples: 2_000_000,
      appendAttempts: 2_000,
      initialConnectAttempts: 1,
      reconnects: 0,
      sendFailures: 0,
      budgetExceeded: false,
      finalized: true,
      terminalReason: 'worker-completed',
      direction: 'inbound',
      providerId: 'provider-dashscope',
      templateId: 'template-dashscope-realtime',
      providerKind: 'dashscope',
      endpointHost: 'dashscope.aliyuncs.com',
      credentialReference: 'credential://provider/dashscope/default',
      authHeaderName: 'Authorization',
      authScheme: 'bearer',
      customHeaderCount: 0,
      model: 'qwen3.5-omni-plus-realtime',
      protocol: 'dashscope-omni',
    }));
    if (feedbackMode !== 'echo-cancel') {
      fs.writeFileSync(path.join(directory, 'source-media-transcript.json'), JSON.stringify({
        schemaVersion: 2,
        authorityMode: 'canonical-fixture-local-v2',
        passed: true,
        remoteProviderCalls: 0,
        externalAudioSeconds: 0,
      }));
      fs.writeFileSync(path.join(directory, 'physical-output-content.raw.json'), JSON.stringify({
        schemaVersion: 1,
        authorityMode: 'local-pcm-cue-playback-v1',
        passed: true,
        remoteProviderCalls: 0,
        externalAudioSeconds: 0,
      }));
    }
  };
  try {
    for (const feedbackMode of ['virtual-driver', 'echo-cancel']) {
      const directory = path.join(root, feedbackMode);
      writeInputs(directory, feedbackMode);
      const command = extractedLocalSmokeProviderSessionAuthorityFunction() +
        `$context = [pscustomobject]@{ request=[pscustomobject]@{ feedbackMode='${feedbackMode}'; matrix=[pscustomobject]@{ cellId='smoke-cell' }; timeouts=[pscustomobject]@{ sessionSeconds=180 }; model=[pscustomobject]@{ id='qwen3.5-omni-plus-realtime'; protocol='dashscope-omni' } } }; ` +
        `Write-LocalSmokeProviderSessionAuthority ${quotePowerShell(directory)} 'smoke-marker' $context | ConvertTo-Json -Depth 5 -Compress`;
      const result = runPowerShell(['-Command', command]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const authority = readJsonArtifact(path.join(directory, 'smoke-provider-session-authority.json'));
      assert.equal(authority.passed, true);
      assert.equal(authority.nonAuthoritative, true);
      assert.equal(authority.providerSessions, 1);
      assert.equal(authority.auxiliaryProviderSessions, 0);
    }
    const retryDirectory = path.join(root, 'retry-forbidden');
    writeInputs(retryDirectory, 'virtual-driver');
    const retryLedgerPath = path.join(retryDirectory, 'smoke-provider-session-ledger.json');
    const retryLedger = readJsonArtifact(retryLedgerPath);
    retryLedger.terminalReason = 'initial-connect-retry-forbidden';
    fs.writeFileSync(retryLedgerPath, JSON.stringify(retryLedger));
    const retryCommand = extractedLocalSmokeProviderSessionAuthorityFunction() +
      `$context = [pscustomobject]@{ request=[pscustomobject]@{ feedbackMode='virtual-driver'; matrix=[pscustomobject]@{ cellId='smoke-cell' }; timeouts=[pscustomobject]@{ sessionSeconds=180 }; model=[pscustomobject]@{ id='qwen3.5-omni-plus-realtime'; protocol='dashscope-omni' } } }; ` +
      `try { Write-LocalSmokeProviderSessionAuthority ${quotePowerShell(retryDirectory)} 'smoke-marker' $context | Out-Null; exit 2 } catch { exit 0 }`;
    const retryResult = runPowerShell(['-Command', retryCommand]);
    assert.equal(retryResult.status, 0, retryResult.stderr || retryResult.stdout);
    const rejected = readJsonArtifact(path.join(retryDirectory, 'smoke-provider-session-authority.json'));
    assert.equal(rejected.passed, false);
    assert.match(rejected.violations.join(' '), /normal completion terminal/);

    const incompleteDirectory = path.join(root, 'incomplete-local-content');
    writeInputs(incompleteDirectory, 'virtual-driver');
    const incompleteSourcePath = path.join(incompleteDirectory, 'source-media-transcript.json');
    const incompleteSource = readJsonArtifact(incompleteSourcePath);
    delete incompleteSource.remoteProviderCalls;
    fs.writeFileSync(incompleteSourcePath, JSON.stringify(incompleteSource));
    const incompleteCommand = extractedLocalSmokeProviderSessionAuthorityFunction() +
      `$context = [pscustomobject]@{ request=[pscustomobject]@{ feedbackMode='virtual-driver'; matrix=[pscustomobject]@{ cellId='smoke-cell' }; timeouts=[pscustomobject]@{ sessionSeconds=180 }; model=[pscustomobject]@{ id='qwen3.5-omni-plus-realtime'; protocol='dashscope-omni' } } }; ` +
      `try { Write-LocalSmokeProviderSessionAuthority ${quotePowerShell(incompleteDirectory)} 'smoke-marker' $context | Out-Null; exit 2 } catch { exit 0 }`;
    const incompleteResult = runPowerShell(['-Command', incompleteCommand]);
    assert.equal(incompleteResult.status, 0, incompleteResult.stderr || incompleteResult.stdout);
    const incompleteAuthority = readJsonArtifact(path.join(incompleteDirectory, 'smoke-provider-session-authority.json'));
    assert.equal(incompleteAuthority.passed, false);
    assert.match(incompleteAuthority.violations.join(' '), /canonical source authority/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default-endpoint playback materializes reference PCM without opening a render stream', { skip: !isWindows }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-reference-only-'));
  const mediaPath = path.join(tempRoot, 'source.wav');
  const fakeInjector = path.join(tempRoot, 'fake-injector.cmd');
  const argsPath = path.join(tempRoot, 'injector-args.txt');
  fs.writeFileSync(mediaPath, 'fixture');
  fs.writeFileSync(fakeInjector, [
    '@echo off',
    `echo %* > "${argsPath}"`,
    ':loop',
    'if "%~1"=="" goto done',
    'if /I "%~1"=="--reference-pcm16k-mono-path" (',
    '  > "%~2" echo pcm',
    '  shift',
    ')',
    'shift',
    'goto loop',
    ':done',
    'echo {"passed":true,"detail":"reference-only"}',
    'exit /b 0',
  ].join('\r\n'));
  try {
    const command = `${extractedMediaReferenceFunctions()} ` +
      `$path = Write-TestMediaReferencePcm ${quotePowerShell(mediaPath)} ${quotePowerShell(tempRoot)} ${quotePowerShell(path.resolve('.'))} 0 ${quotePowerShell(fakeInjector)}; ` +
      `[pscustomobject]@{ path = $path; bytes = (Get-Item -LiteralPath $path).Length } | ConvertTo-Json -Compress`;
    const result = runPowerShell(['-Command', command]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout.trim());
    assert.equal(receipt.path, path.join(tempRoot, 'source-media-reference-16k-mono.pcm'));
    assert(receipt.bytes > 0);
    const args = fs.readFileSync(argsPath, 'utf8');
    assert.match(args, /--reference-only/);
    assert.match(args, /--reference-pcm16k-mono-path/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
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

test('paid and local smoke provider environments are exact, elevation-forwardable, inert when disabled, and restored', { skip: !isWindows }, () => {
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
    `$local = Enter-StrictPaidProviderEnvironment $false $false $true; ` +
    `$localValues = @{}; foreach ($name in $local.names) { $localValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }; ` +
    `Exit-StrictPaidProviderEnvironment $local; ` +
    `$restored = @{}; foreach ($name in $names) { $restored[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }; ` +
    `[pscustomobject]@{ names=@($strict.names); expected=$strict.values; nonStrict=$nonStrictValues; normal=$normal; elevated=$elevatedLaunchEnvironment; restored=$restored; localNames=@($local.names); localExpected=$local.values; local=$localValues } | ConvertTo-Json -Depth 8 -Compress`;
  const result = runPowerShell(['-Command', command]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const authority = JSON.parse(result.stdout.trim());
  assert.equal(authority.names.length, 6);
  assert.deepEqual(authority.normal, authority.expected);
  assert.deepEqual(authority.elevated, authority.expected);
  assert.equal(authority.localNames.length, 6);
  assert.deepEqual(authority.local, authority.localExpected);
  assert.equal(authority.local.OMNI_WATCH_MODE_LOCAL_SINGLE_SESSION_AUTHORITY, '1');
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
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Configuration.psm1'))} -Force; `;
}

function extractedSaveWatchModeRunArtifactsFunction() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.EvidenceCollection.psm1'))} -Force -DisableNameChecking; `;
}

function extractedPhysicalOutputSttCredentialFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Stt.psm1'))} -Force -DisableNameChecking; `;
}

function extractedBridgeProbePolicyFunctions() {
  return (
    `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Bridge.psm1'))} -Force; ` +
    `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Configuration.psm1'))} -Force; `
  );
}

function extractedPhysicalDeviceEvidenceFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.Windows.Audio.psm1'))} -Force; `;
}

function extractedLiveScenarioEnvironmentFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Provider.psm1'))} -Force -DisableNameChecking; `;
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

test('run request accepts the 30-second smoke floor and rejects shorter or oversized runs', () => {
  const request = readJsonArtifact(path.join('scripts', 'testing', 'fixtures', 'watch-mode-run-request-dry-run.json'));
  request.timeouts.sessionSeconds = 30;
  assert.doesNotThrow(() => validateWatchModeRunRequest(request));

  const shorter = structuredClone(request);
  shorter.timeouts.sessionSeconds = 29;
  assert.throws(() => validateWatchModeRunRequest(shorter), /30\.\.7200/);

  const oversized = structuredClone(request);
  oversized.timeouts.sessionSeconds = 7201;
  assert.throws(() => validateWatchModeRunRequest(oversized), /30\.\.7200/);
});

test('run context keeps the paid input ceiling separate from local playback drain lifetime', { skip: !isWindows }, () => {
  const requestPath = path.resolve('scripts', 'testing', 'fixtures', 'watch-mode-run-request-dry-run.json');
  const configModule = path.resolve('scripts', 'testing', 'lib', 'powershell', 'Omni.Testing.WatchMode.Config.psm1');
  const workspaceRoot = path.resolve('.');
  const probe = runPowerShell([
    '-Command',
    `Import-Module '${configModule}' -Force; ` +
      `$request = Get-Content -LiteralPath '${requestPath}' -Raw -Encoding UTF8 | ConvertFrom-Json; ` +
      `$request.authorityMode = 'strict-paid'; ` +
      `$context = New-OmniWatchModeContext -Request $request -WorkspaceRoot '${workspaceRoot}'; ` +
      `$context.lifecycle | ConvertTo-Json -Compress`,
  ]);

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.deepEqual(JSON.parse(probe.stdout.trim()), {
    providerInputSeconds: 180,
    desktopAutoStopSeconds: 300,
  });
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
        `function Build-WatchModeEvidence { return [pscustomobject]@{} }; ` +
        `function Invoke-ReportGenerator { }; ` +
        `$runRequest = [pscustomobject]@{}; ` +
        `$context = [pscustomobject]@{ audioRoute = 'echo-cancel'; paths = [pscustomobject]@{ runtimeRoot = ${quotePowerShell(root)} }; model = [pscustomobject]@{ id = $null } }; ` +
        `$steps = [System.Collections.ArrayList]::new(); [void]$steps.Add([pscustomobject]@{ ` +
          `schemaVersion = 'watch-mode-step/v2'; ` +
          `id = 'transcribe-and-compare-physical-output-content'; ` +
          `phase = 'contentCapture'; status = 'passed'; ` +
          `startedAt = '2026-08-13T00:00:00Z'; endedAt = '2026-08-13T00:00:01Z'; durationMs = 1000; ` +
          `data = [pscustomobject]@{ skipped = $true; reason = 'policy skip' }; ` +
          `error = $null ` +
        `}); $state = [pscustomobject]@{ steps = $steps; ownedProcesses = @(); primaryError = $null; cleanupErrors = @() }; ` +
        `$FeedbackLoopPrevention = 'echo-cancel'; ` +
        `Save-WatchModeRunArtifacts ` +
          `-OutputDirectory ${quotePowerShell(echoDirectory)} ` +
          `-PlaybackStep $null -State $state ` +
          `-RunMarker 'echo-marker' -StartedAtLocal '2026-08-13 00:00:00' -Context $context -Request $runRequest; ` +
        `$FeedbackLoopPrevention = 'virtual-driver'; ` +
        `$context.audioRoute = 'virtual-driver'; ` +
        `Save-WatchModeRunArtifacts ` +
          `-OutputDirectory ${quotePowerShell(virtualDirectory)} ` +
          `-PlaybackStep $null -State $state ` +
          `-RunMarker 'virtual-marker' -StartedAtLocal '2026-08-13 00:00:00' -Context $context -Request $runRequest`,
    ]);

    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    assert.ok(
      forbiddenCellArtifactPaths('echo-cancel').includes('physical-output-content.json'),
      'the collector test must stay aligned with the strict authority exclusion',
    );
    assert.equal(
      fs.existsSync(path.join(echoDirectory, 'physical-output-content.raw.json')),
      false,
      'echo-cancel must not emit an artifact forbidden by strict authority',
    );
    const virtualArtifact = readJsonArtifact(path.join(virtualDirectory, 'physical-output-content.raw.json'));
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
        `Remove-Item Env:OMNI_TEST_DASHSCOPE_API_KEY -ErrorAction SilentlyContinue; ` +
        `function global:Add-Type { param([Parameter(ValueFromRemainingArguments=$true)]$Arguments) throw 'unexpected native credential invocation' }; ` +
        `function global:OmniWatchCredentialReader { }; ` +
        `class OmniWatchCredentialReader { static [string] ReadGenericSecret([string]$target) { if ($target -ne 'OmniTranslate:credential___provider_dashscope_default') { throw 'unexpected target' }; return 'vault-only-test-key' } }; ` +
        `$result = Get-PhysicalOutputSttApiKey ${quotePowerShell(directory)}; ` +
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
      `$virtualFailure = Get-VirtualDriverPreflightFailure 'virtual-driver' ([pscustomobject]@{ status = 'failed'; error = [pscustomobject]@{ message = 'installed driver hash differs from package' } }); ` +
      `$virtualSuccess = Get-VirtualDriverPreflightFailure 'virtual-driver' ([pscustomobject]@{ status = 'passed'; error = $null }); ` +
      `$processFailure = Get-VirtualDriverPreflightFailure 'process-exclusion' ([pscustomobject]@{ status = 'failed'; error = [pscustomobject]@{ message = 'not relevant' } }); ` +
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
  assert.equal(result.payload.protocolVersion, '2026-08-27-audio-routing-v8');
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

test('app readiness accepts only matching structured component readiness', { skip: !isWindows }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-app-readiness-pass-'));
  const readinessPath = path.join(directory, 'watch-runtime-status.json');
  const marker = 'watch_mode_diagnostic.run_id=readiness-pass';
  const component = { status: 'ready', atMs: Date.now(), error: null };
  fs.writeFileSync(readinessPath, JSON.stringify({
    schemaVersion: 'watch-mode-readiness/v2',
    runMarker: marker,
    processId: 0,
    state: 'ready',
    frontendIpc: component,
    provider: component,
    bridge: component,
    route: component,
    failure: null,
  }));
  try {
    const probe = runPowerShell([
      '-Command',
      extractedAppReadinessFunctions() +
        `$status = Get-Content -Raw -Encoding UTF8 ${quotePowerShell(readinessPath)} | ConvertFrom-Json; ` +
        `$status.processId = $PID; $status | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 ${quotePowerShell(readinessPath)}; ` +
        `Wait-WatchModeAppReadiness ` +
          `-ReadinessPath ${quotePowerShell(readinessPath)} ` +
          `-RunMarker ${quotePowerShell(marker)} ` +
          `-ProcessId $PID ` +
          `-DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1)) | ConvertTo-Json -Depth 4 -Compress`,
    ]);
    assert.equal(probe.status, 0, `structured readiness should pass:\n${probe.stderr}`);
    const result = JSON.parse(probe.stdout.trim());
    assert.equal(result.providerReady, true);
    assert.equal(result.frontendIpcReady, true);
    assert.equal(result.bridgeReady, true);
    assert.equal(result.routeReady, true);
    assert.equal(result.pid > 0, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('partial structured readiness cannot start playback and preserves process diagnostics', { skip: !isWindows }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-app-readiness-no-ipc-'));
  const readinessPath = path.join(directory, 'watch-runtime-status.json');
  const stdoutPath = path.join(directory, 'desktop.stdout.log');
  const stderrPath = path.join(directory, 'desktop.stderr.log');
  const marker = 'watch_mode_diagnostic.run_id=readiness-no-ipc';
  fs.writeFileSync(stdoutPath, 'desktop stdout: renderer navigation started');
  fs.writeFileSync(stderrPath, 'desktop stderr: frontend resource unavailable');
  try {
    const startedAt = Date.now();
    const probe = runPowerShell([
      '-Command',
      extractedAppReadinessFunctions() +
        `$component = [pscustomobject]@{ status='pending'; atMs=$null; error=$null }; ` +
        `[pscustomobject]@{ schemaVersion='watch-mode-readiness/v2'; runMarker=${quotePowerShell(marker)}; ` +
          `processId=$PID; state='waiting-frontend-ipc'; frontendIpc=$component; provider=$component; ` +
          `bridge=$component; route=$component; failure=$null } | ConvertTo-Json -Depth 5 | ` +
          `Set-Content -Encoding UTF8 ${quotePowerShell(readinessPath)}; ` +
        `Wait-WatchModeAppReadiness ` +
          `-ReadinessPath ${quotePowerShell(readinessPath)} ` +
          `-RunMarker ${quotePowerShell(marker)} ` +
          `-ProcessId $PID ` +
          `-DeadlineUtc ([DateTime]::UtcNow.AddMilliseconds(300)) ` +
          `-DesktopStdoutPath ${quotePowerShell(stdoutPath)} ` +
          `-DesktopStderrPath ${quotePowerShell(stderrPath)} | Out-Null`,
    ]);
    assert.notEqual(probe.status, 0, 'partial readiness must fail before playback');
    assert.match(probe.stderr, /timed out waiting for structured Watch readiness/i);
    assert.match(probe.stderr, /State=waiting-frontend-ipc/i);
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
    const requestPath = path.join(outputRoot, 'request.json');
    const request = readJsonArtifact(path.join('scripts', 'testing', 'fixtures', 'watch-mode-run-request-dry-run.json'));
    request.paths.outputRoot = outputRoot;
    fs.writeFileSync(requestPath, JSON.stringify(request));
    const run = runPowerShell(['-File', scriptPath, '-RequestPath', requestPath]);
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

    // The raw fixture evidence must be indexed by the collection and stamped
    // with the selected feedback mode so variants cannot mask each other.
    const collection = readJsonArtifact(path.join(runDirectory, 'run-collection.json'));
    const snapshots = readJsonArtifact(path.join(runDirectory, collection.artifacts.fixtureEvidence));
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

    for (const artifact of ['run-collection.json', 'app.log', 'bridge-service.log']) {
      assert.ok(fs.existsSync(path.join(runDirectory, artifact)), `dry-run must persist ${artifact}`);
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('matrix runner executes both strict watch models and verifies strict evidence', async () => {
  const matrix = await import('./run-watch-mode-live-matrix.mjs');

  assert.deepEqual(matrix.DEFAULT_MODELS, ['qwen3.5-omni-flash-realtime', 'qwen3.5-livetranslate-flash-realtime']);
  assert.deepEqual(matrix.DEFAULT_FEEDBACK_MODES, ['process-exclusion', 'virtual-driver', 'echo-cancel']);

  const request = matrix.buildRunnerRequest({
    model: 'qwen3.5-omni-flash-realtime',
    feedbackMode: 'virtual-driver',
    physicalPlaybackDeviceClass: 'usb',
    physicalPlaybackDeviceProfileId: 'usb-dac',
    allowElevatedDesktopLaunch: true,
  });
  assert.equal(request.model.id, 'qwen3.5-omni-flash-realtime');
  assert.equal(request.feedbackMode, 'virtual-driver');
  assert.equal(request.media.playbackSeconds, 0);
  assert.equal(request.physicalDevice.class, 'usb');
  assert.equal(request.physicalDevice.profileId, 'usb-dac');
  assert.equal(request.desktop.elevation, 'allow');

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
