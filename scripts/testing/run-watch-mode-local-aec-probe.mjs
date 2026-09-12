import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMain } from '../lib/testing-common.mjs';
import { AUTHORITY_RUNTIME_BINARY_FILES } from './watch-mode-evidence-authority.mjs';
import { verifyDistributedRuntimeDistribution } from './watch-mode-local-isolation-distributed.mjs';
import { windowsPowerShellEnvironment } from './run-watch-mode-live-production-coordinator.mjs';
import { verifyAecTapEvidence } from './watch-mode-aec-tap-evidence.mjs';
import { checkWatchDiskSpace } from './watch-mode-disk-lifecycle.mjs';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const writeJson = (name, value) => fs.writeFileSync(name, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
export const AEC_PROBE_JOB_HELPER = 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveFinalizer.psm1';
// Compiled into the opt-in startup implementation and its producer receipt.
// This is a non-executing version guard, not a substitute for selecting the
// trusted signed distribution digest. NEVER run an old EXE to query support:
// it could ignore the opt-in and preconnect a persisted Provider at startup.
export const AEC_PROBE_CAPABILITY_ID = 'omni-local-aec-probe/no-provider-startup/v1/20260912';

function readProbeReceipt(outputDirectory) {
  const file = path.join(outputDirectory, 'local-aec-probe-result.json');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024
      || fs.realpathSync.native(file) !== file) throw new Error('invalid or unbounded local AEC producer receipt');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
}

export function verifyLocalAecProbeRuntime(runtimeRoot, expectedDistributionDigest) {
  if (!/^[a-f0-9]{64}$/u.test(expectedDistributionDigest ?? '')) throw new Error('expected distribution digest is required');
  const root = fs.realpathSync.native(runtimeRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime-distribution.json'), 'utf8'));
  if (manifest.distributionDigest !== expectedDistributionDigest || !Array.isArray(manifest.files)) {
    throw new Error('local AEC runtime does not match the explicitly selected distribution');
  }
  const names = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.includes(':')
        || file.path.split('/').some((part) => !part || part === '.' || part === '..')
        || names.has(file.path.toLowerCase())) throw new Error('unsafe or duplicate distribution file');
    names.add(file.path.toLowerCase());
    const candidate = path.join(root, ...file.path.split('/'));
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(candidate) !== candidate) {
      throw new Error(`distribution entry must be a regular local file: ${file.path}`);
    }
  }
  for (const name of AUTHORITY_RUNTIME_BINARY_FILES) {
    if (!names.has(name.toLowerCase())) throw new Error(`incomplete 15-file runtime: ${name}`);
  }
  verifyDistributedRuntimeDistribution({ workspaceRoot: root, manifest });
  const desktop = manifest.files.find((file) => file.path === 'target/release/omni-desktop-shell.exe');
  if (!desktop) throw new Error('desktop runtime entry must use its canonical path');
  if (!fs.readFileSync(path.join(root, desktop.path)).includes(Buffer.from(AEC_PROBE_CAPABILITY_ID))) {
    throw new Error('selected Desktop lacks the compiled zero-Provider local-AEC capability; refusing normal launch');
  }
  const helper = manifest.files.find((file) => file.path === AEC_PROBE_JOB_HELPER);
  if (!helper) throw new Error('selected runtime does not freeze the local AEC process-custody helper');
  return { root, executable: path.join(root, desktop.path), executableSha256: desktop.sha256,
    helperSha256: helper.sha256, probeCapabilityId: AEC_PROBE_CAPABILITY_ID,
    distributionDigest: manifest.distributionDigest };
}

export function localAecProbePowerShell({ runtime, outputDirectory, requestPath, deadlineUtc, workspaceRoot }) {
  return `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$OutputEncoding=[System.Text.Encoding]::UTF8
$helper=${quote(path.join(workspaceRoot, AEC_PROBE_JOB_HELPER))}
if((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${quote(runtime.helperSha256)}) {throw 'process-custody helper changed after preflight'}
Import-Module $helper -Force
# This generic native job launches suspended, owns all descendants, and closes
# its kill-on-close handle on every exit. No PID/name-based cleanup is used.
foreach($variable in @(Get-ChildItem Env: | Where-Object {$_.Name -match '^OMNI_WATCH_MODE_|^OMNI_RELEASE_EVIDENCE_'})) {
  [Environment]::SetEnvironmentVariable($variable.Name,$null,'Process')
}
$env:OMNI_WATCH_MODE_LOCAL_AEC_PROBE_REQUEST=${quote(requestPath)}
$env:OMNI_WATCH_MODE_AEC_DIAGNOSTIC_TAP_DIRECTORY=${quote(outputDirectory)}
$exe=${quote(runtime.executable)}
if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${quote(runtime.executableSha256)}) {throw 'desktop bytes changed after preflight'}
$result=[OmniInteractiveFinalizerJob]::Run($exe,'',${quote(runtime.root)},[DateTime]::Parse(${quote(deadlineUtc)}).ToUniversalTime())
[pscustomobject]@{exitCode=$result.ExitCode;stdout=$result.Stdout;stderr=$result.Stderr;ownedJobExited=$true} | ConvertTo-Json -Depth 4 -Compress
`;
}

function verifyOperationReceipt(probe, request, tap, sourceFrames) {
  const render = probe.render;
  const capture = probe.capture;
  const config = probe.requestedConfig;
  const validCounter = (value) => Number.isSafeInteger(value) && value > 0;
  if (probe.sourcePcmFrames !== sourceFrames || probe.stimulusPreambleFrames !== 16_000
      || probe.stimulusSampleRateHz !== 16_000 || probe.stimulusChannelCount !== 1
      || probe.stimulusFrames !== sourceFrames + 16_000 || !render || !capture
      || !Array.isArray(config?.providers) || config.providers.length !== 0
      || config.devices?.feedbackLoopPrevention !== 'echo-cancel' || config.devices.aecEnabled !== true
      || config.devices.outputDeviceId !== request.physicalDeviceId
      || config.devices.inboundRoute?.input?.deviceId !== request.physicalDeviceId
      || capture.routeId !== config.devices.inboundRoute?.routeId
      || render.deviceId !== request.physicalDeviceId || render.sampleRateHz !== 48_000
      || render.requestedDeviceId !== request.physicalDeviceId || render.effectiveDeviceId !== request.physicalDeviceId
      || render.sourcePcmFrames !== sourceFrames || render.stimulusFrames !== sourceFrames + 16_000
      || render.stimulusPreambleFrames !== 16_000 || render.stimulusSampleRateHz !== 16_000
      || render.stimulusChannelCount !== 1
      || render.channelCount !== 2 || !validCounter(render.renderedFrames)
      || render.renderedFrames !== (sourceFrames + 16_000) * 3
      || typeof render.rendererInstanceId !== 'string' || !render.rendererInstanceId
      || !validCounter(render.ownerGeneration)
      || capture.direction !== 'inbound' || capture.requestedDeviceId !== request.physicalDeviceId
      || capture.effectiveDeviceId !== request.physicalDeviceId || capture.streamBound !== false
      || capture.captureState !== 'idle' || !validCounter(capture.framesCaptured)
      || capture.countsFinal !== true || capture.sampleRateHz !== 48_000 || capture.channelCount !== 2
      || capture.lastError !== null || capture.lastErrorCode !== null
      || tap.sampleCounts.render !== render.renderedFrames * 2
      || tap.sampleCounts.pre !== capture.framesCaptured * 2
      || tap.sampleCounts.post !== capture.framesCaptured * 2) {
    throw new Error('local AEC operation receipt contradicts stimulus, endpoint, final capture or tap accounting');
  }
}

export async function runLocalAecProbe(options, dependencies = {}) {
  const outputParent = path.resolve(options.outputParent);
  const parentStat = fs.lstatSync(outputParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('probe output parent must be a real directory');
  const executionId = `local-aec-${crypto.randomUUID()}`;
  const outputDirectory = path.join(fs.realpathSync.native(outputParent), executionId);
  fs.mkdirSync(outputDirectory);
  const base = { schemaVersion: 1, artifactKind: 'watch-mode-local-aec-probe-runner', executionId,
    startedAt: new Date().toISOString(), status: 'failed', releaseEligible: false, providerCalls: 0,
    ownedJobExited: false };
  let nativeResult = null;
  let launchAttempted = false;
  let probe = null;
  try {
    (dependencies.checkDiskSpace ?? checkWatchDiskSpace)({ receiptPath: path.join(outputDirectory, 'disk-space.json') });
    const timeoutSeconds = Number(options.timeoutSeconds ?? 300);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 300) throw new Error('probe timeout must be 30-300 seconds');
    const deadline = Date.now() + timeoutSeconds * 1000;
    if (!/^\{0\.0\.0\.00000000\}\.\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}$/iu.test(options.physicalDeviceId ?? '')) {
      throw new Error('an exact physical render endpoint ID is required');
    }
    const runtime = verifyLocalAecProbeRuntime(path.resolve(options.runtimeRoot), options.distributionDigest);
    const renderPcmPath = fs.realpathSync.native(options.renderPcmPath);
    const bytes = fs.readFileSync(renderPcmPath);
    if (!bytes.length || bytes.length % 2 || bytes.length > 16_000 * 2 * 180) throw new Error('invalid bounded s16le/16k/mono stimulus');
    const request = { schemaVersion: 1, executionId, outputDirectory, renderPcmPath,
      renderPcmSha256: hash(bytes), physicalDeviceId: options.physicalDeviceId };
    const requestPath = path.join(outputDirectory, 'request.json');
    writeJson(requestPath, request);
    writeJson(path.join(outputDirectory, 'selected-runtime.json'), runtime);
    const workspaceRoot = fs.realpathSync.native(options.workspaceRoot ?? runtime.root);
    const helperPath = path.join(workspaceRoot, AEC_PROBE_JOB_HELPER);
    if (!fs.lstatSync(helperPath).isFile() || fs.realpathSync.native(helperPath) !== helperPath
        || hash(fs.readFileSync(helperPath)) !== runtime.helperSha256) {
      throw new Error('process-custody helper differs from the selected distribution');
    }
    const script = localAecProbePowerShell({ runtime, outputDirectory, requestPath,
      deadlineUtc: new Date(deadline).toISOString(), workspaceRoot });
    fs.writeFileSync(path.join(outputDirectory, 'launch.ps1'), script, { encoding: 'utf8', flag: 'wx' });
    const execute = dependencies.execute ?? ((source) => {
      if (process.platform !== 'win32') throw new Error('local AEC hardware probe requires Windows');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
        windowsHide: true, encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()) + 12_000,
        maxBuffer: 8 * 1024 * 1024, env: windowsPowerShellEnvironment(),
      });
      fs.writeFileSync(path.join(outputDirectory, 'launcher.stdout.log'), result.stdout ?? '', { flag: 'wx' });
      fs.writeFileSync(path.join(outputDirectory, 'launcher.stderr.log'), result.stderr ?? '', { flag: 'wx' });
      if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `owned local probe failed: ${result.stderr}`);
      return JSON.parse(result.stdout.trim());
    });
    launchAttempted = true;
    nativeResult = await execute(script, { outputDirectory, request, deadline });
    writeJson(path.join(outputDirectory, 'owned-launch-result.json'), nativeResult ?? null);
    if (nativeResult?.exitCode !== 0 || nativeResult?.ownedJobExited !== true) throw new Error('local probe process/descendant cleanup not confirmed');
    probe = readProbeReceipt(outputDirectory);
    if (probe.schemaVersion !== 1 || probe.artifactKind !== 'watch-mode-local-aec-probe'
        || probe.executionId !== executionId || probe.status !== 'completed'
        || probe.probeCapabilityId !== AEC_PROBE_CAPABILITY_ID
        || probe.providerCalls !== 0 || probe.releaseEligible !== false || probe.recognitionSenderAttached !== false
        || probe.sourcePcmSha256 !== request.renderPcmSha256 || !probe.tap || probe.failure || probe.tapError || probe.cleanupError) {
      throw new Error('local AEC probe evidence is missing, incomplete, or mismatched');
    }
    const tapIntegrity = verifyAecTapEvidence(outputDirectory, probe.tap);
    verifyOperationReceipt(probe, request, tapIntegrity, bytes.length / 2);
    const result = { ...base, status: 'completed', completedAt: new Date().toISOString(), ownedJobExited: true,
      providerAccounting: 'supported-probe-reported-zero',
      outputDirectory, probe, tapIntegrity, distributionDigest: runtime.distributionDigest };
    writeJson(path.join(outputDirectory, 'result.json'), result);
    return result;
  } catch (error) {
    // A nonzero native exit can throw before execute returns. Retain any
    // producer accounting already committed, without trusting it as a pass.
    let producerReadError = null;
    if (launchAttempted && probe === null) {
      try { probe = readProbeReceipt(outputDirectory); }
      catch (readError) { producerReadError = readError.message; }
    }
    const reportedCalls = probe?.executionId === executionId && Number.isSafeInteger(probe?.providerCalls)
      && probe.providerCalls >= 0 ? probe.providerCalls : null;
    writeJson(path.join(outputDirectory, 'result.json'), { ...base, completedAt: new Date().toISOString(),
      providerCalls: launchAttempted ? reportedCalls : 0,
      providerAccounting: !launchAttempted ? 'not-launched' : reportedCalls === null ? 'unknown' : 'unverified-producer-report',
      observedProducerAccounting: probe ? { executionId: probe.executionId, providerCalls: probe.providerCalls ?? null } : null,
      producerReadError,
      ownedJobExited: nativeResult?.ownedJobExited === true, failure: error.message });
    error.outputDirectory = outputDirectory;
    throw error;
  }
}

export function parseLocalAecProbeArgs(argv) {
  const flags = new Map([['--runtime-root','runtimeRoot'], ['--distribution-digest','distributionDigest'],
    ['--output-parent','outputParent'], ['--render-pcm','renderPcmPath'], ['--physical-device-id','physicalDeviceId'],
    ['--workspace-root','workspaceRoot'], ['--timeout-seconds','timeoutSeconds']]);
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!flags.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`invalid local AEC argument: ${argv[i]}`);
    const key = flags.get(argv[i]);
    if (Object.hasOwn(result, key)) throw new Error(`duplicate local AEC argument: ${argv[i]}`);
    result[key] = argv[i + 1];
  }
  for (const key of ['runtimeRoot','distributionDigest','outputParent','renderPcmPath','physicalDeviceId']) {
    if (!result[key]) throw new Error(`${key} is required`);
  }
  return result;
}

if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await runLocalAecProbe(parseLocalAecProbeArgs(process.argv.slice(2))))); }
  catch (error) { console.error(`${error.message}; output=${error.outputDirectory ?? 'not-created'}`); process.exitCode = 1; }
}
