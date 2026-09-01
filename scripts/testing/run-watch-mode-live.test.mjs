import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { forbiddenCellArtifactPaths } from './watch-mode-evidence-authority.mjs';
import { buildCanonicalReferencePcm } from './watch-mode-canonical-source-authority.mjs';
import { deriveWatchModelProtocolIdentity } from './watch-mode-model-protocol-authority.mjs';
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
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.Process.psm1'))} -Force -DisableNameChecking; ` +
    `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Report.psm1'))} -Force -DisableNameChecking; `;
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

function extractedPhysicalCaptureFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.PhysicalCapture.psm1'))} -Force -DisableNameChecking; `;
}

function extractedExecutionContextFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.ExecutionContext.psm1'))} -Force -DisableNameChecking; `;
}

function extractedRunLifecycleFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.RunLifecycle.psm1'))} -Force -DisableNameChecking; `;
}

test('physical probe retries only narrow identity-bound incomplete windows', { skip: !isWindows }, () => {
  const base = {
    passed: false,
    detail: 'external fingerprint did not survive process loopback: component=0.006 minimum=0.010',
    processExclusionFingerprint: {
      sourceCaptureMode: 'process-exclusion',
      captureBackend: 'wasapi-process-exclusion',
      processLoopbackStatus: 'ready',
      bridgeProcessId: 42,
      excludedProcessId: 42,
      physicalExternalComponent: 0.02,
      physicalBridgeChildComponent: 0.03,
      sourceCapturedFrames: 50_000,
    },
  };
  const cases = [
    [base, 'process-exclusion', true],
    [{ ...base, detail: 'Bridge source pipe captured only 39360 frame(s)', processExclusionFingerprint: { ...base.processExclusionFingerprint, sourceCapturedFrames: 39_360 } }, 'process-exclusion', true],
    [{ ...base, detail: `${base.detail}; translation fingerprint was not physically detectable` }, 'process-exclusion', false],
    [{ ...base, detail: `${base.detail}; leaked into source pipe` }, 'process-exclusion', false],
    [{ ...base, processExclusionFingerprint: { ...base.processExclusionFingerprint, excludedProcessId: 43 } }, 'process-exclusion', false],
    [{ ...base, processExclusionFingerprint: { ...base.processExclusionFingerprint, physicalExternalComponent: 0.009 } }, 'process-exclusion', false],
    [base, 'virtual-driver', false],
  ];
  for (const [payload, mode, expected] of cases) {
    const command = extractedPhysicalCaptureFunctions() +
      `$value = ${quotePowerShell(JSON.stringify(payload))} | ConvertFrom-Json; ` +
      `Test-RetryablePhysicalOutputProbeFailure -Result $value -FeedbackMode ${quotePowerShell(mode)}`;
    const result = runPowerShell(['-Command', command]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), expected ? 'True' : 'False');
  }
});

test('paid cell finalizes a zero-call budget before desktop launch', { skip: !isWindows }, () => {
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-pre-desktop-budget-'));
  const runMarker = 'watch_mode_diagnostic.run_id=pre_desktop_budget';
  try {
    const context = {
      paths: { workspaceRoot: path.resolve('.') },
      request: {
        authorityMode: 'strict-paid',
        feedbackMode: 'process-exclusion',
        matrix: { cellId: 'c01' },
        model: {
          id: 'qwen3.5-livetranslate-flash-realtime',
          subtitleTranslationMode: 'native',
        },
        timeouts: { sessionSeconds: 180 },
      },
    };
    const command = extractedLocalSmokeProviderSessionAuthorityFunction() +
      `$env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID = 'coordinator-pre-desktop-lease'; ` +
      `$env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES = '2877045'; ` +
      `$context = ${quotePowerShell(JSON.stringify(context))} | ConvertFrom-Json; ` +
      `Write-StrictPaidCellBudget ${quotePowerShell(runDirectory)} $null ${quotePowerShell(runMarker)} $context | ConvertTo-Json -Depth 4 -Compress`;
    const result = runPowerShell(['-Command', command]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const budget = readJsonArtifact(path.join(runDirectory, 'external-provider-budget.json'));
    assert.equal(budget.passed, true);
    assert.equal(budget.calls.mainRealtime, 0);
    assert.equal(budget.providerSendBoundary.terminalReason, 'runner-failed-before-provider-session');
    assert.equal(fs.statSync(path.join(runDirectory, 'provider-input-16k-mono.pcm')).size, 0);
    assert.match(fs.readFileSync(path.join(runDirectory, 'app.log'), 'utf8'), new RegExp(runMarker));
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
});

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
      assert.equal(authority.referencePcm.transformation, 'none');
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
    assert.match(
      rejectedAuthority.error,
      /neither the byte-for-byte injector reconstruction nor its exact 90s\/45s restart quiet-window variant/,
    );
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('local smoke Provider-session authority binds one non-authoritative session and zero auxiliary calls', { skip: !isWindows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-smoke-provider-authority-'));
  const writeInputs = (directory) => {
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
  };
  try {
    for (const feedbackMode of ['virtual-driver', 'echo-cancel']) {
      const directory = path.join(root, feedbackMode);
      writeInputs(directory);
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
    writeInputs(retryDirectory);
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
    writeInputs(incompleteDirectory);
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
    const model = strict
      ? 'qwen3.5-livetranslate-flash-realtime'
      : 'qwen3.5-omni-flash-realtime';
    const protocol = strict ? 'dashscope-livetranslate' : 'dashscope-omni';
    const command = `${extractedStrictPaidProviderFunctions()} ` +
      `$config = ${quotePowerShell(JSON.stringify({ providers }))} | ConvertFrom-Json; ` +
      `${mutate} ` +
      `Set-WatchModelOnConfig $config '${model}' '${protocol}' $${strict ? 'true' : 'false'}; ` +
      `$config | ConvertTo-Json -Depth 10 -Compress`;
    return runPowerShell(['-Command', command]);
  };
  const strict = run(true);
  assert.equal(strict.status, 0, strict.stderr || strict.stdout);
  const strictConfig = JSON.parse(strict.stdout.trim());
  assert.equal(strictConfig.providers[0].model, 'alternate-before-canonical');
  assert.equal(strictConfig.providers[1].model, 'qwen3.5-livetranslate-flash-realtime');

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

test('strict Watch mix does not apply a second source attenuation after injector gain', { skip: !isWindows }, () => {
  const command = `${extractedStrictPaidProviderFunctions()} ` +
    `$native = [pscustomobject]@{}; ` +
    `Set-WatchModeSecondaryConfig $native '' '' 'virtual-driver' 'native'; ` +
    `$secondary = [pscustomobject]@{}; ` +
    `Set-WatchModeSecondaryConfig $secondary '' 'qwen3.5-livetranslate-flash-realtime' 'process-exclusion' 'secondary'; ` +
    `[pscustomobject]@{ native=$native.devices.inboundRoute.mixControl; secondary=$secondary.devices.inboundRoute.mixControl } | ConvertTo-Json -Depth 6 -Compress`;
  const result = runPowerShell(['-Command', command]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const mixes = JSON.parse(result.stdout.trim());
  assert.equal(mixes.native.originalAudioGainDb, 0);
  assert.equal(mixes.secondary.originalAudioGainDb, 0);
  assert.equal(mixes.native.translatedAudioGainDb, 0);
  assert.equal(mixes.secondary.translatedAudioGainDb, 0);
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

function extractedRunnerPolicyFunctions() {
  return `Import-Module ${quotePowerShell(path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.Runner.psm1'))} -Force -DisableNameChecking; `;
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

test('Desktop lifecycle resolves its hash dependency in an isolated module scope', { skip: !isWindows }, () => {
  const modulePath = path.resolve(
    'scripts/testing/lib/powershell/Omni.Testing.WatchMode.DesktopLifecycle.psm1',
  );
  const probe = runPowerShell([
    '-Command',
    `$module = Import-Module ${quotePowerShell(modulePath)} -Force -DisableNameChecking -PassThru; `
      + `& $module { Get-Command Get-OmniSha256 -ErrorAction Stop | Out-Null }`,
  ]);
  assert.equal(probe.status, 0, `Desktop lifecycle hash dependency is unavailable:\n${probe.stderr}`);
});

test('Desktop lifecycle binds strict paid lease receipts to schema 2 model protocol identity', { skip: !isWindows }, () => {
  const modulePath = path.resolve(
    'scripts/testing/lib/powershell/Omni.Testing.WatchMode.DesktopLifecycle.psm1',
  );
  const identity = deriveWatchModelProtocolIdentity('qwen3.5-livetranslate-flash-realtime');
  const probe = runPowerShell([
    '-Command',
    `$ErrorActionPreference = 'Stop'; `
      + `$module = Import-Module ${quotePowerShell(modulePath)} -Force -DisableNameChecking -PassThru; `
      + `$identity = ${quotePowerShell(JSON.stringify(identity))} | ConvertFrom-Json; `
      + `& $module { `
      + `param($identity); `
      + `$strictRequest = [pscustomobject]@{ authorityMode = 'strict-paid'; model = [pscustomobject]@{ protocolProfileIdentity = $identity } }; `
      + `$incidentRequest = [pscustomobject]@{ authorityMode = 'incident-replay-plus' }; `
      + `$smokeRequest = [pscustomobject]@{ authorityMode = 'local-canonical-smoke' }; `
      + `$strict = New-WatchModeProviderLeaseReceipt -Request $strictRequest `
      + `-LeaseArtifactKind 'watch-mode-provider-input-budget-lease' -CellId 'strict-cell' -LeaseId 'strict-lease' `
      + `-RunMarker 'strict-run' -MaxSamples 2877045; `
      + `$incident = New-WatchModeProviderLeaseReceipt -Request $incidentRequest `
      + `-LeaseArtifactKind 'watch-mode-provider-input-budget-lease' -CellId 'incident-cell' -LeaseId 'incident-lease' `
      + `-RunMarker 'incident-run' -MaxSamples 16000; `
      + `$smoke = New-WatchModeProviderLeaseReceipt -Request $smokeRequest `
      + `-LeaseArtifactKind 'watch-mode-smoke-provider-session-lease' -CellId 'smoke-cell' -LeaseId 'smoke-lease' `
      + `-RunMarker 'smoke-run' -MaxSamples 32000; `
      + `$missingIdentityRejected = $false; `
      + `try { New-WatchModeProviderLeaseReceipt -Request ([pscustomobject]@{ authorityMode = 'strict-paid'; model = [pscustomobject]@{} }) `
      + `-LeaseArtifactKind 'watch-mode-provider-input-budget-lease' -CellId 'missing-cell' -LeaseId 'missing-lease' `
      + `-RunMarker 'missing-run' -MaxSamples 1 | Out-Null } catch { $missingIdentityRejected = $true }; `
      + `[pscustomobject]@{ strict = $strict; incident = $incident; smoke = $smoke; missingIdentityRejected = $missingIdentityRejected } `
      + `| ConvertTo-Json -Depth 8 -Compress `
      + `} $identity`,
  ]);
  assert.equal(probe.status, 0, `Desktop lifecycle lease receipt probe failed:\n${probe.stderr}`);
  const result = JSON.parse(probe.stdout.trim());
  assert.equal(result.strict.schemaVersion, 2);
  assert.deepEqual(result.strict.modelProtocolProfileIdentity, identity);
  assert.equal(result.missingIdentityRejected, true);
  assert.deepEqual(result.incident, {
    schemaVersion: 1,
    artifactKind: 'watch-mode-provider-input-budget-lease',
    nonAuthoritative: false,
    cellId: 'incident-cell',
    leaseId: 'incident-lease',
    runMarker: 'incident-run',
    maxSamples: 16000,
  });
  assert.deepEqual(result.smoke, {
    schemaVersion: 1,
    artifactKind: 'watch-mode-smoke-provider-session-lease',
    nonAuthoritative: true,
    cellId: 'smoke-cell',
    leaseId: 'smoke-lease',
    runMarker: 'smoke-run',
    maxSamples: 32000,
  });
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
    sessionWatchdogSeconds: 180,
    inputCompletionWatchdogSeconds: 180,
    processExclusionRestartAfterSeconds: 0,
    processExclusionRestartQuietSeconds: 0,
    providerFinishTimeoutSeconds: 15,
    localPlaybackDrainTimeoutSeconds: 30,
    reportWriteTimeoutSeconds: 10,
    cellHardWatchdogSeconds: 235,
    physicalRecorderTailSeconds: 2,
  });
});

test('live runner keeps process restart explicit at 90 seconds regardless of the session watchdog', { skip: !isWindows }, () => {
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
  assert.equal(result.process.processExclusionRestartAfterMs, '90000');
  assert.equal(result.process.aecLiveScenario, null);
  assert.equal(result.aec.autoStopAfterMs, '1800000');
  assert.equal(result.aec.processExclusionRestartAfterMs, null);
  assert.equal(result.aec.aecLiveScenario, '1');
  assert.equal(result.virtual.autoStopAfterMs, '1800000');
  assert.equal(result.virtual.processExclusionRestartAfterMs, null);
  assert.equal(result.virtual.aecLiveScenario, null);
});

test('formal process restart is the explicit 90-second contract, not half of the paid watchdog', { skip: !isWindows }, () => {
  const probe = runPowerShell([
    '-Command',
    extractedLiveScenarioEnvironmentFunctions() +
      `$scenario = Get-WatchModeLiveScenarioEnvironment -FeedbackMode 'process-exclusion' ` +
        `-AutoStopAfterMs 300000 -ProcessExclusionRestartAfterMs 90000; ` +
      `$scenario | ConvertTo-Json -Compress`,
  ]);

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const scenario = JSON.parse(probe.stdout.trim());
  assert.equal(scenario.autoStopAfterMs, '300000');
  assert.equal(scenario.processExclusionRestartAfterMs, '90000');
});

test('formal process-exclusion playback consumes the explicit signed 90/45 restart window', { skip: !isWindows }, () => {
  const probe = runPowerShell([
    '-Command',
    extractedRunnerPolicyFunctions() +
      `$process = Get-WatchModeRestartQuietWindow -FeedbackMode 'process-exclusion' -ProviderInputSeconds 180 -StrictPaidAuthority $true; ` +
      `$signed = Get-WatchModeRestartQuietWindow -FeedbackMode 'process-exclusion' -ProviderInputSeconds 225 -StrictPaidAuthority $true -RestartAfterSeconds 90 -RestartQuietSeconds 45; ` +
      `$virtual = Get-WatchModeRestartQuietWindow -FeedbackMode 'virtual-driver' -ProviderInputSeconds 180 -StrictPaidAuthority $true; ` +
      `$smoke = Get-WatchModeRestartQuietWindow -FeedbackMode 'process-exclusion' -ProviderInputSeconds 180 -StrictPaidAuthority $false; ` +
      `[pscustomobject]@{ process = $process; signed = $signed; virtual = $virtual; smoke = $smoke } | ConvertTo-Json -Depth 4 -Compress`,
  ]);

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const result = JSON.parse(probe.stdout.trim());
  assert.deepEqual(result.process, { afterSeconds: 90, durationSeconds: 45 });
  assert.deepEqual(result.signed, { afterSeconds: 90, durationSeconds: 45 });
  assert.deepEqual(result.virtual, { afterSeconds: 0, durationSeconds: 0 });
  assert.deepEqual(result.smoke, { afterSeconds: 0, durationSeconds: 0 });
});

test('input-complete marker is request-path bound, atomically published, and create-once', { skip: !isWindows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-input-complete-'));
  const referencePath = path.join(root, 'reference.pcm');
  const markerPath = path.join(root, 'input-complete.json');
  fs.writeFileSync(referencePath, Buffer.from([1, 0, 2, 0]));
  const probe = runPowerShell([
    '-Command',
    extractedRunnerPolicyFunctions() +
      `$env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES = '4'; ` +
      `$playback = [pscustomobject]@{ referencePcmPath = ${quotePowerShell(referencePath)}; finishedAtMs = 1000 }; ` +
      `$first = Write-WatchModeInputCompleteMarker -Path ${quotePowerShell(markerPath)} ` +
        `-RunMarker 'run-1' -CellId 'cell-1' -LeaseId 'lease-1' -Playback $playback; ` +
      `$before = [System.IO.File]::ReadAllBytes(${quotePowerShell(markerPath)}); ` +
      `$secondFailed = $false; ` +
      `try { Write-WatchModeInputCompleteMarker -Path ${quotePowerShell(markerPath)} ` +
        `-RunMarker 'run-1' -CellId 'cell-1' -LeaseId 'lease-1' -Playback $playback | Out-Null } ` +
      `catch { $secondFailed = $_.Exception.Message -match 'immutable JSON publish failed' }; ` +
      `$after = [System.IO.File]::ReadAllBytes(${quotePowerShell(markerPath)}); ` +
      `$marker = Get-Content -LiteralPath ${quotePowerShell(markerPath)} -Raw | ConvertFrom-Json; ` +
      `[pscustomobject]@{ first = [int64]$first; secondFailed = $secondFailed; unchanged = ` +
        `[Convert]::ToBase64String($before) -ceq [Convert]::ToBase64String($after); marker = $marker } ` +
      `| ConvertTo-Json -Depth 6 -Compress`,
  ]);

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const result = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.secondFailed, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.marker.signaledAtUnixMs, result.marker.completedAtUnixMs);
  assert.equal(result.marker.runMarker, 'run-1');
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);
});

test('strict execution context rejects signed terminal paths outside their canonical directory', { skip: !isWindows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-execution-path-'));
  const outputRoot = path.join(root, 'cell');
  const canonicalHash = fs.readFileSync(
    path.resolve('scripts/testing/fixtures/watch-mode-en-original.sha256'),
    'utf8',
  ).trim().split(/\s+/u)[0];
  const baseRequest = {
    runMode: 'live',
    authorityMode: 'strict-paid',
    feedbackMode: 'virtual-driver',
    desktop: { elevation: 'forbid' },
    driverPolicy: 'probe-only',
    physicalContentMode: 'remote-stt',
    model: {
      id: 'qwen3.5-livetranslate-flash-realtime',
      protocol: 'dashscope-livetranslate',
      subtitleTranslationMode: 'native',
      subtitleModelId: null,
      secondaryAudioModelId: null,
    },
    media: {
      path: path.resolve('scripts/testing/fixtures/watch-mode-en-original.wav'),
      playbackSeconds: 0,
    },
    physicalDevice: { id: 'default', class: 'default-speaker', profileId: 'default-speaker' },
    timeouts: {
      warmupSeconds: 12, readinessSeconds: 90, sessionSeconds: 180,
      inputCompletionWatchdogSeconds: 180, providerFinishTimeoutSeconds: 15,
      localPlaybackDrainTimeoutSeconds: 30, reportWriteTimeoutSeconds: 10,
      cellHardWatchdogSeconds: 235, physicalRecorderTailSeconds: 2,
    },
    paths: {
      outputRoot,
      runtimeRoot: path.join(root, 'runtime'),
      workerReadinessReceipt: null,
      inputComplete: path.join(outputRoot, 'input-complete.json'),
      terminalAuthority: path.join(outputRoot, 'evidence-driven-terminal.json'),
    },
    matrix: { cellId: 'formal-cell-1' },
  };
  const cases = [
    { inputComplete: path.join(root, 'outside-input.json') },
    { terminalAuthority: path.join(root, 'outside-terminal.json') },
    { inputComplete: path.join(outputRoot, 'forged-input.json') },
    { terminalAuthority: path.join(outputRoot, 'forged-terminal.json') },
  ];
  for (const mutation of cases) {
    const request = structuredClone(baseRequest);
    Object.assign(request.paths, mutation);
    const context = { paths: { workspaceRoot: path.resolve('.') }, request };
    const probe = runPowerShell([
      '-Command',
      extractedExecutionContextFunctions() +
        `function global:Get-FileHash { [pscustomobject]@{ Hash = ${quotePowerShell(canonicalHash)} } }; ` +
        `$env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID = 'lease-path-test'; ` +
        `$request = ${quotePowerShell(JSON.stringify(request))} | ConvertFrom-Json; ` +
        `$context = ${quotePowerShell(JSON.stringify(context))} | ConvertFrom-Json; ` +
        `New-WatchModeExecutionContext -Context $context -Request $request | Out-Null`,
    ]);
    assert.notEqual(probe.status, 0, 'forged signed authority path unexpectedly passed');
    assert.match(`${probe.stderr}\n${probe.stdout}`, /canonical files directly under paths\.outputRoot/i);
  }
});

test('physical recorder stops immediately on failure but lets terminal success flush naturally', { skip: !isWindows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-recorder-stop-'));
  const probe = runPowerShell([
    '-Command',
    extractedPhysicalCaptureFunctions() +
      `function New-FakeRecorder([string]$name, [bool]$terminal) { ` +
        `$dir = Join-Path ${quotePowerShell(root)} $name; [void](New-Item -ItemType Directory -Path $dir); ` +
        `$stdout = Join-Path $dir 'stdout.log'; $stderr = Join-Path $dir 'stderr.log'; ` +
        `$command = if ($terminal) { 'Start-Sleep -Milliseconds 1200; Write-Output ''{"passed":true}''' } else { 'Start-Sleep -Seconds 30' }; ` +
        `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command',$command) ` +
          `-RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru; ` +
        `$terminalPath = Join-Path $dir 'evidence-driven-terminal.json'; if ($terminal) { Set-Content -LiteralPath $terminalPath -Value '{}' -Encoding utf8 }; ` +
        `return [pscustomobject]@{ pid=$process.Id; process=$process; recordSeconds=30; startedAtEpochMs=1; ` +
          `recordingPath=(Join-Path $dir 'recording.wav'); transcriptionPcmPath=(Join-Path $dir 'recording.pcm'); ` +
          `stdout=$stdout; stderr=$stderr; terminalTailSeconds=1; terminalAuthorityPath=$terminalPath } ` +
      `}; ` +
      `$failed = New-FakeRecorder 'failed' $false; $failedWatch = [Diagnostics.Stopwatch]::StartNew(); ` +
      `try { Complete-PhysicalOutputContentRecorder $failed ${quotePowerShell(process.cwd())} | Out-Null } catch {}; ` +
      `$failedWatch.Stop(); $failed.process.Refresh(); ` +
      `$success = New-FakeRecorder 'success' $true; $successWatch = [Diagnostics.Stopwatch]::StartNew(); ` +
      `$successResult = Complete-PhysicalOutputContentRecorder $success ${quotePowerShell(process.cwd())} -TerminalSucceeded; ` +
      `$successWatch.Stop(); $success.process.Refresh(); ` +
      `[pscustomobject]@{ failedExited=$failed.process.HasExited; failedMs=$failedWatch.ElapsedMilliseconds; ` +
        `successExited=$success.process.HasExited; successMs=$successWatch.ElapsedMilliseconds; successPassed=$successResult.passed } | ConvertTo-Json -Compress`,
  ]);

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const result = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.failedExited, true);
  assert.ok(result.failedMs < 5_000, `failure cleanup took ${result.failedMs}ms`);
  assert.equal(result.successExited, true);
  assert.ok(result.successMs >= 1_100, `recorder did not receive time to flush naturally: ${result.successMs}ms`);
  assert.equal(result.successPassed, true, 'recorder JSON was lost before graceful exit');
});

test('recorder cleanup retains terminal tail when a later runner step has failed', { skip: !isWindows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-recorder-terminal-cleanup-'));
  const probe = runPowerShell([
    '-Command',
    extractedRunLifecycleFunctions() +
      `$terminalPath = Join-Path ${quotePowerShell(root)} 'evidence-driven-terminal.json'; ` +
      `Set-Content -LiteralPath $terminalPath -Value '{}' -Encoding utf8; ` +
      `$stdout = Join-Path ${quotePowerShell(root)} 'stdout.log'; $stderr = Join-Path ${quotePowerShell(root)} 'stderr.log'; ` +
      `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Milliseconds 1200; Write-Output ''{"passed":true}''') ` +
        `-RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru; ` +
      `$recorder = [pscustomobject]@{ pid=$process.Id; process=$process; recordSeconds=30; startedAtEpochMs=1; ` +
        `recordingPath=(Join-Path ${quotePowerShell(root)} 'recording.wav'); transcriptionPcmPath=(Join-Path ${quotePowerShell(root)} 'recording.pcm'); ` +
        `stdout=$stdout; stderr=$stderr; ` +
        `terminalTailSeconds=1; terminalAuthorityPath=$terminalPath }; ` +
      `$laterStepFailed = $true; $watch = [Diagnostics.Stopwatch]::StartNew(); ` +
      `try { Complete-WatchModePhysicalRecorderAfterRun $recorder ${quotePowerShell(process.cwd())} $terminalPath | Out-Null } catch {}; ` +
      `$watch.Stop(); $process.Refresh(); ` +
      `[pscustomobject]@{ laterStepFailed=$laterStepFailed; exited=$process.HasExited; elapsedMs=$watch.ElapsedMilliseconds } | ConvertTo-Json -Compress`,
  ]);
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const result = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.laterStepFailed, true);
  assert.equal(result.exited, true);
  assert.ok(result.elapsedMs >= 1_100, `recorder was killed before its terminal flush: ${result.elapsedMs}ms`);
});

test('watch report deadline uses the slower launch-clock phase plus receipt grace', { skip: !isWindows }, () => {
  const probe = runPowerShell([
    '-Command',
    extractedReportWaitFunctions() +
      `$launched = [DateTime]::SpecifyKind([DateTime]::Parse('2026-08-10T00:00:00'), [DateTimeKind]::Utc); ` +
      `$process = Get-WatchSessionReportDeadlineUtc -LaunchedAtUtc $launched ` +
        `-ReadyTimeoutSeconds 90 -AutoStopAfterSeconds 280 -CompletionGraceSeconds 30; ` +
      `$ordinary = Get-WatchSessionReportDeadlineUtc -LaunchedAtUtc $launched ` +
        `-ReadyTimeoutSeconds 90 -AutoStopAfterSeconds 235 -CompletionGraceSeconds 30; ` +
      `$readinessBound = Get-WatchSessionReportDeadlineUtc -LaunchedAtUtc $launched ` +
        `-ReadyTimeoutSeconds 120 -AutoStopAfterSeconds 40 -CompletionGraceSeconds 30; ` +
      `@([int]($process - $launched).TotalSeconds, ` +
        `[int]($ordinary - $launched).TotalSeconds, ` +
        `[int]($readinessBound - $launched).TotalSeconds) | ConvertTo-Json -Compress`,
  ]);

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.deepEqual(JSON.parse(probe.stdout.trim()), [310, 265, 150]);
});

test('every paid route records physical output unless content capture is explicitly disabled', { skip: !isWindows }, () => {
  const policy = runPowerShell([
    '-Command',
    `${extractedPhysicalOutputContentPolicyFunctions()} ` +
      `$echo = Get-PhysicalOutputContentSkipReason -FeedbackMode 'echo-cancel' -SkipContentStt $false; ` +
      `$process = Get-PhysicalOutputContentSkipReason -FeedbackMode 'process-exclusion' -SkipContentStt $false; ` +
      `$explicit = Get-PhysicalOutputContentSkipReason -FeedbackMode 'virtual-driver' -SkipContentStt $true; ` +
      `$normal = Get-PhysicalOutputContentSkipReason -FeedbackMode 'virtual-driver' -SkipContentStt $false; ` +
      `if (-not $echo -and $explicit -and -not $normal -and -not $process) { exit 0 }; exit 1`,
  ]);

  assert.equal(policy.status, 0, policy.stderr || policy.stdout);
});

test('artifact saving preserves explicit physical-content skip diagnostics for every route', { skip: !isWindows }, () => {
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
    assert.equal(forbiddenCellArtifactPaths('echo-cancel').length, 0);
    const echoArtifact = readJsonArtifact(path.join(echoDirectory, 'physical-output-content.raw.json'));
    assert.equal(echoArtifact.skipped, true);
    assert.equal(echoArtifact.reason, 'policy skip');
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
      `$payload = New-BridgeSourceProbeInitPayload -FeedbackMode 'process-exclusion' -SessionId 'probe-session' -PhysicalPlaybackDeviceId '{explicit-hda-endpoint}'; ` +
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
  assert.equal(result.payload.physicalPlaybackDeviceId, '{explicit-hda-endpoint}');
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

test('virtual-driver media preflight binds the explicit physical playback endpoint', () => {
  const source = fs.readFileSync(
    path.resolve('scripts/testing/lib/powershell/Omni.Testing.WatchMode.VirtualDriverCapture.psm1'),
    'utf8',
  );
  assert.match(source, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$PhysicalPlaybackDeviceId/);
  assert.match(source, /New-BridgeSourceProbeInitPayload "virtual-driver" \$sessionId \$PhysicalPlaybackDeviceId/);
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

test('same-process report wait requires launch custody, terminal identity, and exit code zero', { skip: !isWindows }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-report-wait-'));
  const helperPath = path.join(directory, 'desktop-helper.ps1');
  fs.writeFileSync(helperPath, `param(
  [string]$ReportPath, [string]$TerminalPath, [string]$ReleasePath, [string]$RunMarker,
  [string]$CellId, [string]$LeaseId, [string]$LaunchId, [string]$TerminalLeaseId, [int]$RequestedExitCode,
  [string]$ReportStatus = 'completed', [string]$TerminalStatus = 'completed',
  [string]$TerminalErrorCode = 'none', [string]$TerminalIdentityMode = 'exact'
)
$releaseDeadlineUtc = [DateTime]::UtcNow.AddSeconds(10)
while (-not (Test-Path -LiteralPath $ReleasePath -PathType Leaf)) {
  if ([DateTime]::UtcNow -ge $releaseDeadlineUtc) { [Environment]::Exit(124) }
  Start-Sleep -Milliseconds 10
}
$custody = Get-Content -LiteralPath $ReleasePath -Raw -Encoding UTF8 | ConvertFrom-Json
$report = @{ sessionId = 'watch-helper'; status = $ReportStatus }
[System.IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
$reportItem = Get-Item -LiteralPath $ReportPath
$stream = [System.IO.File]::OpenRead($ReportPath)
$algorithm = [System.Security.Cryptography.SHA256]::Create()
try { $reportHash = ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
finally { $algorithm.Dispose(); $stream.Dispose() }
if ([string]::IsNullOrWhiteSpace($TerminalLeaseId)) { $TerminalLeaseId = $LeaseId }
$producerStartTimeUtcTicks = [string]$custody.startTimeUtcTicks
$producerStartedAtUnixMs = [DateTimeOffset]::new([DateTime]::new([long]$producerStartTimeUtcTicks, [DateTimeKind]::Utc)).ToUnixTimeMilliseconds()
$producerExecutableSha256 = [string]$custody.executableSha256
if ($TerminalIdentityMode -ceq 'old-start') { $producerStartedAtUnixMs = 1 }
if ($TerminalIdentityMode -ceq 'wrong-hash') { $producerExecutableSha256 = ('f' * 64) }
$terminalStartedAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$terminal = @{ artifactKind = 'watch-mode-evidence-driven-terminal'; schemaVersion = 2
  runMarker = $RunMarker; cellId = $CellId; leaseId = $TerminalLeaseId; status = $TerminalStatus
  startedAtUnixMs = $terminalStartedAtUnixMs; completedAtUnixMs = ($terminalStartedAtUnixMs + 20); launchId = $LaunchId
  producerProcessId = $PID; producerStartTimeUtcTicks = $producerStartTimeUtcTicks
  producerStartedAtUnixMs = $producerStartedAtUnixMs; producerExecutableSha256 = $producerExecutableSha256
  sourceHeadCommit = ('a' * 40); runtimeBundleDigest = ('b' * 64)
  events = @(
    @{ sequence = 1; stage = 'mediaPlaybackCompleted'; observedAtUnixMs = ($terminalStartedAtUnixMs + 1); detail = @{} },
    @{ sequence = 2; stage = 'inputCompleteSignaled'; observedAtUnixMs = ($terminalStartedAtUnixMs + 2); detail = @{} },
    @{ sequence = 3; stage = 'inputCompleteObserved'; observedAtUnixMs = ($terminalStartedAtUnixMs + 3); detail = @{} },
    @{ sequence = 4; stage = 'sessionUpdatedReceived'; observedAtUnixMs = ($terminalStartedAtUnixMs + 4); detail = @{} },
    @{ sequence = 5; stage = 'lastProviderAppend'; observedAtUnixMs = ($terminalStartedAtUnixMs + 5); detail = @{} },
    @{ sequence = 6; stage = 'sessionFinishSent'; observedAtUnixMs = ($terminalStartedAtUnixMs + 6); detail = @{} },
    @{ sequence = 7; stage = 'lastResponseAudioDone'; observedAtUnixMs = ($terminalStartedAtUnixMs + 7); detail = @{} },
    @{ sequence = 8; stage = 'sessionFinishedReceived'; observedAtUnixMs = ($terminalStartedAtUnixMs + 8); detail = @{} },
    @{ sequence = 9; stage = 'finalRendererAck'; observedAtUnixMs = ($terminalStartedAtUnixMs + 9); detail = @{} },
    @{ sequence = 10; stage = 'localPlaybackQuiescent'; observedAtUnixMs = ($terminalStartedAtUnixMs + 10); detail = @{} },
    @{ sequence = 11; stage = 'reportWritten'; observedAtUnixMs = ($terminalStartedAtUnixMs + 11)
      detail = @{ reportPath = 'watch-session-report.json'
        byteLength = [int64]$reportItem.Length; sha256 = $reportHash } }
  ) }
if ($TerminalIdentityMode -ceq 'gapped-sequence') { $terminal.events[10].sequence = 12 }
if ($TerminalIdentityMode -ceq 'completed-before-last') { $terminal.completedAtUnixMs = $terminalStartedAtUnixMs + 5 }
if ($TerminalIdentityMode -ceq 'report-not-final') {
  $reportEvent = $terminal.events[10]
  $terminal.events[10] = $terminal.events[9]
  $terminal.events[9] = $reportEvent
  $terminal.events[9].sequence = 10
  $terminal.events[10].sequence = 11
}
if ($TerminalErrorCode -cne 'none') {
  $terminal['errorCode'] = $TerminalErrorCode
  $terminal['error'] = "terminal phase failed: $TerminalErrorCode"
}
[System.IO.File]::WriteAllText($TerminalPath, ($terminal | ConvertTo-Json -Depth 8 -Compress), [System.Text.UTF8Encoding]::new($false))
[Environment]::Exit($RequestedExitCode)
`, 'utf8');
  const runMarker = 'run-custody-1';
  const cellId = 'cell-custody-1';
  const leaseId = 'provider-lease-custody-1';
  const invokeHelper = (
    name,
    exitCode,
    reportStatus = 'completed',
    terminalLeaseId = leaseId,
    terminalStatus = 'completed',
    terminalErrorCode = 'none',
    terminalIdentityMode = 'exact',
  ) => {
    const helperDirectory = path.join(directory, name);
    fs.mkdirSync(helperDirectory);
    const reportPath = path.join(helperDirectory, 'watch-session-report.json');
    const terminalPath = path.join(helperDirectory, 'evidence-driven-terminal.json');
    const releasePath = path.join(helperDirectory, 'custody-ready.marker');
    const helperStderrPath = path.join(helperDirectory, 'desktop-helper.stderr.log');
    const command = extractedReportWaitFunctions() +
      `$launchId = [guid]::NewGuid().ToString(); ` +
      `$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',` +
        `${quotePowerShell(helperPath)},'-ReportPath',${quotePowerShell(reportPath)},'-TerminalPath',${quotePowerShell(terminalPath)},` +
        `'-ReleasePath',${quotePowerShell(releasePath)},` +
        `'-RunMarker',${quotePowerShell(runMarker)},'-CellId',${quotePowerShell(cellId)},'-LeaseId',${quotePowerShell(leaseId)},` +
        `'-LaunchId',$launchId,'-TerminalLeaseId',${quotePowerShell(terminalLeaseId)},` +
        `'-RequestedExitCode','${exitCode}','-ReportStatus',${quotePowerShell(reportStatus)},` +
        `'-TerminalStatus',${quotePowerShell(terminalStatus)},'-TerminalErrorCode',${quotePowerShell(terminalErrorCode)},` +
        `'-TerminalIdentityMode',${quotePowerShell(terminalIdentityMode)}) ` +
        `-WindowStyle Hidden -RedirectStandardError ${quotePowerShell(helperStderrPath)} -PassThru; ` +
      `$lease = Get-OmniProcessIdentity -ProcessId $child.Id -Ownership managed -LaunchId $launchId -ProcessHandle $child; ` +
      `[System.IO.File]::WriteAllText(${quotePowerShell(releasePath)}, ($lease | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false)); ` +
      `try { Wait-WatchSessionReportAndDesktopExit -Path ${quotePowerShell(reportPath)} -ProcessLease $lease ` +
          `-TerminalAuthorityPath ${quotePowerShell(terminalPath)} -RunMarker ${quotePowerShell(runMarker)} ` +
          `-CellId ${quotePowerShell(cellId)} -LeaseId ${quotePowerShell(leaseId)} ` +
          `-SourceHeadCommit ('a' * 40) -RuntimeBundleDigest ('b' * 64) ` +
          `-DeadlineUtc ([DateTime]::UtcNow.AddSeconds(5)) | Out-Null ` +
        `} catch { $helperError = if (Test-Path -LiteralPath ${quotePowerShell(helperStderrPath)}) { ` +
            `Get-Content -LiteralPath ${quotePowerShell(helperStderrPath)} -Raw ` +
          `} else { '<missing helper stderr>' }; throw "$($_.Exception.Message) helperStderr=$helperError" }`;
    return runPowerShell(['-Command', command]);
  };
  try {
    const forgedReportPath = path.join(directory, 'forged-report.json');
    const forgedTerminalPath = path.join(directory, 'forged-terminal.json');
    fs.writeFileSync(forgedReportPath, JSON.stringify({ sessionId: 'watch-forged', status: 'completed' }));
    fs.writeFileSync(forgedTerminalPath, JSON.stringify({
      artifactKind: 'watch-mode-evidence-driven-terminal', schemaVersion: 2,
      runMarker, cellId, leaseId, status: 'completed',
    }));
    const forged = runPowerShell([
      '-Command',
      extractedReportWaitFunctions() +
        `$forgedLease = [pscustomobject]@{ schemaVersion='omni-process-lease/v1'; custodyId='not-launched-here'; ` +
          `pid=2147483647; startTimeUtcTicks=1; executablePath='C:\\forged.exe'; executableSha256=('0' * 64); ownership='managed' }; ` +
        `Wait-WatchSessionReportAndDesktopExit -Path ${quotePowerShell(forgedReportPath)} -ProcessLease $forgedLease ` +
          `-TerminalAuthorityPath ${quotePowerShell(forgedTerminalPath)} -RunMarker ${quotePowerShell(runMarker)} ` +
          `-CellId ${quotePowerShell(cellId)} -LeaseId ${quotePowerShell(leaseId)} ` +
          `-SourceHeadCommit ('a' * 40) -RuntimeBundleDigest ('b' * 64) ` +
          `-DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1)) | Out-Null`,
    ]);
    assert.notEqual(forged.status, 0, 'a handwritten report and nonexistent PID must not establish launch custody');
    assert.match(`${forged.stderr}\n${forged.stdout}`, /launch custody|custody lease/i);

    const nonzero = invokeHelper('nonzero', 7);
    assert.notEqual(nonzero.status, 0, 'a custodied desktop exit code 7 must fail');
    assert.match(`${nonzero.stderr}\n${nonzero.stdout}`, /exit code 7/i);

    const preciseFailure = invokeHelper(
      'precise-terminal-failure',
      1,
      'completed',
      leaseId,
      'failed',
      'provider-finish-timeout',
    );
    assert.notEqual(preciseFailure.status, 0, 'a failed terminal must remain fail-closed');
    assert.match(
      `${preciseFailure.stderr}\n${preciseFailure.stdout}`,
      /terminalErrorCode=provider-finish-timeout/,
    );

    const active = invokeHelper('active', 0, 'active');
    assert.notEqual(active.status, 0, 'an active report must fail the completed-report contract');
    assert.match(`${active.stderr}\n${active.stdout}`, /report is not completed/i);

    const wrongIdentity = invokeHelper('wrong-identity', 0, 'completed', 'another-provider-lease');
    assert.notEqual(wrongIdentity.status, 0, 'terminal identity from another lease must fail');
    assert.match(`${wrongIdentity.stderr}\n${wrongIdentity.stdout}`, /terminal leaseId does not match this launch/i);

    for (const [name, mode] of [['old-producer-start', 'old-start'], ['wrong-executable-hash', 'wrong-hash']]) {
      const mismatchedProducer = invokeHelper(name, 0, 'completed', leaseId, 'completed', 'none', mode);
      assert.notEqual(mismatchedProducer.status, 0, `${mode} must not match launch custody`);
      assert.match(`${mismatchedProducer.stderr}\n${mismatchedProducer.stdout}`, /producer identity/i);
    }

    for (const [name, mode] of [
      ['gapped-terminal-sequence', 'gapped-sequence'],
      ['completed-before-last-event', 'completed-before-last'],
      ['report-written-not-final', 'report-not-final'],
    ]) {
      const malformedTerminal = invokeHelper(name, 0, 'completed', leaseId, 'completed', 'none', mode);
      assert.notEqual(malformedTerminal.status, 0, `${mode} must fail the strict terminal boundary`);
      assert.match(`${malformedTerminal.stderr}\n${malformedTerminal.stdout}`, /terminal event|reportWritten/i);
    }

    const completed = invokeHelper('completed', 0);
    assert.equal(completed.status, 0, `custodied zero-exit completed report should pass:\n${completed.stderr}`);
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

test('matrix runner defaults to the exact release model and preserves explicit diagnostic routing', async () => {
  const matrix = await import('./run-watch-mode-live-matrix.mjs');

  assert.deepEqual(matrix.DEFAULT_MODELS, ['qwen3.5-livetranslate-flash-realtime']);
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
