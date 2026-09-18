import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildPhysicalSourceWaveformAuthority } from './watch-mode-canonical-source-authority.mjs';
import { AUTHORITY_RUNTIME_BINARY_FILES } from './watch-mode-evidence-authority.mjs';
import { LOCAL_ISOLATION_DISTRIBUTION_KIND } from './watch-mode-local-isolation-distributed.mjs';
import { checkWatchDiskSpace } from './watch-mode-disk-lifecycle.mjs';

export const PHYSICAL_SOURCE_PROBE_KIND = 'watch-mode-physical-source-probe';
export const PHYSICAL_SOURCE_PROBE_REFERENCE_SECONDS = 24.010;
const CANONICAL_MEDIA_RELATIVE = 'scripts/testing/fixtures/watch-mode-en-original.wav';
const RECORD_SECONDS = 136;
const CUSTODY_KIND = 'watch-mode-physical-source-probe-process-custody';
const ACCOUNTING_RECEIPTS = ['process-custody.json', 'cleanup.json', 'route-observation.json'];
const MAX_ACCOUNTING_RECEIPT_BYTES = 512 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
export const PHYSICAL_SOURCE_PROBE_SUPPORT_FILES = Object.freeze([
  'scripts/testing/watch-mode-physical-source-probe.mjs',
  'scripts/testing/watch-mode-canonical-source-authority.mjs',
  'scripts/testing/watch-mode-rust-audio-analysis.mjs',
  'scripts/testing/watch-mode-evidence-authority.mjs',
  'scripts/testing/watch-mode-local-isolation-distributed.mjs',
  ...['Omni.Testing.WatchMode.InteractiveFinalizer.psm1', 'Omni.Testing.WatchMode.AudioPlayback.psm1',
    'Omni.Testing.WatchMode.Bridge.psm1', 'Omni.Testing.WatchMode.Configuration.psm1',
    'Omni.Testing.WatchMode.AudioAnalysis.psm1', 'Omni.Testing.Windows.Audio.psm1',
    'Omni.Testing.Process.psm1', 'Omni.Testing.IO.psm1'].map((name) => `scripts/testing/lib/powershell/${name}`),
  ...['watch-mode-en-original.wav', 'watch-mode-en-original.sha256', 'watch-mode-audio-fixtures.json',
    'watch-mode-en-original.txt', 'watch-mode-en-original.zh-CN.txt'].map((name) => `scripts/testing/fixtures/${name}`),
  'scripts/installer/virtual-speaker-device.ps1',
]);

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};
const authorityDigest = (value) => digest(Buffer.from(JSON.stringify(canonicalize(value))));
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const writeJson = (filePath, value, flag = 'w') => fs.writeFileSync(
  filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag },
);
const readJson = (filePath) => JSON.parse(fs.readFileSync(regularFile(filePath, 'probe JSON'), 'utf8').replace(/^\uFEFF/u, ''));

function providerObservation(source, phase, receipt) {
  const present = receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt)
    && Object.hasOwn(receipt, 'providerCalls');
  const value = present ? receipt.providerCalls : null;
  const type = !present ? 'missing' : value === null ? 'null' : typeof value;
  return { source, phase, receiptStatus: 'parsed',
    providerCalls: ['bigint', 'function', 'symbol'].includes(type)
      || (type === 'number' && !Number.isFinite(value)) ? String(value) : value,
    providerCallsType: type, providerCallsPresent: present,
    providerCallsValid: present && Number.isSafeInteger(value) && value >= 0,
    artifactKind: receipt?.artifactKind ?? null, runMarker: receipt?.runMarker ?? null };
}

function readAccountingReceipt(outputDirectory, source, phase, observations) {
  const observation = { ...providerObservation(source, phase, null), receiptStatus: 'invalid' };
  observations.push(observation);
  let fd;
  try {
    fd = fs.openSync(regularFile(path.join(outputDirectory, source), 'accounting receipt'), 'r');
    if (fs.fstatSync(fd).size > MAX_ACCOUNTING_RECEIPT_BYTES) throw new Error('accounting receipt exceeds 512 KiB');
    // A failed launcher may have left a partial writer. Bound growth while
    // reading the same handle; never repair a truncated JSON counter by regex.
    const buffer = Buffer.alloc(MAX_ACCOUNTING_RECEIPT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_ACCOUNTING_RECEIPT_BYTES) throw new Error('accounting receipt exceeds 512 KiB');
    const bytes = buffer.subarray(0, length);
    observation.byteLength = length;
    observation.sha256 = digest(bytes);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) { observation.rawBytesBase64 = bytes.toString('base64'); throw error; }
    let receipt;
    try { receipt = JSON.parse(text); }
    catch (error) { observation.rawText = text; throw error; }
    Object.assign(observation, providerObservation(source, phase, receipt));
    // Keep the original numeric spelling/type when it cannot be used as a
    // safe count (including JSON numbers outside JavaScript's exact range).
    if (!observation.providerCallsValid) observation.rawText = text;
    return receipt;
  } catch (error) {
    observation.receiptStatus = error.code === 'ENOENT' ? 'missing' : 'invalid';
    observation.readError = error.message;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function providerAccounting(launchAttempted, observations, receiptsValidated = false) {
  if (!launchAttempted) return { launchAttempted, providerCalls: 0,
    providerAccounting: 'not-launched', observedProviderAccounting: observations };
  const nonzero = [...new Set(observations.filter((entry) => entry.providerCallsValid
    && entry.providerCalls > 0).map((entry) => entry.providerCalls))];
  if (!nonzero.length && receiptsValidated && observations.length > 0
    && observations.every((entry) => entry.receiptStatus === 'parsed' && entry.providerCallsValid && entry.providerCalls === 0)) {
    return { launchAttempted, providerCalls: 0, providerAccounting: 'validated-receipts-reported-zero', observedProviderAccounting: observations };
  }
  // These receipts can describe the same calls. Do not sum them, pick a
  // maximum, or let a later zero overwrite an earlier nonzero observation.
  return { launchAttempted, providerCalls: nonzero.length === 1 ? nonzero[0] : null,
    providerAccounting: nonzero.length > 1 ? 'conflicting-producer-reports'
      : nonzero.length === 1 ? 'unverified-producer-report' : 'unknown',
    observedProviderAccounting: observations };
}

function verifyProcessCustody(custody) {
  if (custody?.schemaVersion !== 1 || custody.artifactKind !== CUSTODY_KIND || custody.passed !== true
      || custody.ownedTreeExited !== true || custody.streamsDrained !== true || custody.providerCalls !== 0
      || !Array.isArray(custody.errors) || custody.errors.length) {
    throw new Error('native process custody is missing or failed');
  }
  return custody;
}

// Reject Windows aliases before normalization, including ADS and device names.
function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f<>:"\\|?*]/u.test(value)
      || value.split('/').some((part) => !part || part === '.' || part === '..'
        || /[.\s]$/u.test(part) || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(part))) {
    throw new Error(`runtime distribution manifest contains an unsafe path: ${JSON.stringify(value)}`);
  }
  return value;
}

function confinedFile(root, relativePath) {
  let current = root;
  const parts = relativePath.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`runtime path must have regular non-symlink ancestry: ${relativePath}`);
    }
  }
  const relative = path.relative(root, fs.realpathSync.native(current));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`runtime path escapes workspace root: ${relativePath}`);
  }
  return current;
}

function regularFile(filePath, label) {
  const absolute = path.resolve(filePath ?? '');
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${absolute}`);
  return absolute;
}

function realDirectory(directoryPath, label) {
  if (typeof directoryPath !== 'string' || !directoryPath.trim()) throw new Error(`${label} is required`);
  const absolute = path.resolve(directoryPath ?? '');
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${absolute}`);
  return fs.realpathSync.native(absolute);
}

function canonicalMedia(workspaceRoot, requestedPath) {
  const expected = regularFile(path.join(workspaceRoot, CANONICAL_MEDIA_RELATIVE), 'canonical media');
  const actual = regularFile(requestedPath ?? expected, 'requested media');
  if (fs.realpathSync.native(actual).toLowerCase() !== fs.realpathSync.native(expected).toLowerCase()) {
    throw new Error('physical source probe accepts only the canonical fixed media');
  }
  return expected;
}

export function verifyProbeRuntime({ workspaceRoot, runtimeManifestPath, distributionDigest }) {
  if (typeof distributionDigest !== 'string' || !SHA256.test(distributionDigest)) {
    throw new Error('an explicitly selected distribution digest is required');
  }
  const root = realDirectory(workspaceRoot, 'workspace root');
  const manifestPath = regularFile(runtimeManifestPath, 'runtime distribution manifest');
  const manifest = readJson(manifestPath);
  if (manifest?.schemaVersion !== 1 || manifest?.artifactKind !== LOCAL_ISOLATION_DISTRIBUTION_KIND
      || !Array.isArray(manifest.files) || !SHA256.test(manifest.distributionDigest ?? '')) {
    throw new Error('runtime distribution manifest is unsupported');
  }
  const core = { ...manifest }; delete core.distributionDigest;
  if (authorityDigest(core) !== manifest.distributionDigest) throw new Error('runtime distribution manifest digest mismatch');
  if (manifest.distributionDigest !== distributionDigest) throw new Error('runtime does not match the explicitly selected distribution digest');
  const inventory = new Map();
  const identities = new Set();
  // Validate all paths before reading any manifest-controlled file.
  for (const entry of manifest.files) {
    const relativePath = safeRelativePath(entry?.path);
    const identity = relativePath.toLowerCase();
    if (identities.has(identity)) throw new Error('runtime distribution manifest contains duplicate paths');
    identities.add(identity);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      throw new Error(`invalid runtime hash/size authority: ${relativePath}`);
    }
    inventory.set(relativePath, entry);
  }
  for (const relativePath of [...AUTHORITY_RUNTIME_BINARY_FILES, ...PHYSICAL_SOURCE_PROBE_SUPPORT_FILES]) {
    if (!inventory.has(relativePath)) {
      throw new Error(`runtime manifest does not authorize ${relativePath}`);
    }
  }
  const verified = new Map();
  for (const [relativePath, expected] of inventory) {
    const absolute = confinedFile(root, relativePath);
    const bytes = fs.readFileSync(absolute);
    const actualDigest = digest(bytes);
    if (bytes.length !== expected.bytes || actualDigest !== expected.sha256) {
      throw new Error(`runtime file differs from its distribution authority: ${relativePath}`);
    }
    verified.set(relativePath, { path: relativePath, bytes: bytes.length, sha256: actualDigest });
  }
  return { manifestPath, distributionDigest: manifest.distributionDigest,
    files: AUTHORITY_RUNTIME_BINARY_FILES.map((relativePath) => verified.get(relativePath)),
    supportFiles: PHYSICAL_SOURCE_PROBE_SUPPORT_FILES.map((relativePath) => verified.get(relativePath)),
    verifiedDistributionFileCount: verified.size };
}

function windowsArguments(values) {
  return values.map((value) => `"${String(value).replace(/(\\*)("|$)/gu,
    (_match, slashes, quote) => `${slashes}${slashes}${quote ? '\\"' : ''}`)}"`).join(' ');
}

export function buildProbePowerShell({ workspaceRoot, outputDirectory, mediaPath,
  virtualRenderEndpointId, physicalPlaybackDeviceId, deadlineSeconds, runMarker }) {
  const moduleRoot = path.join(workspaceRoot, 'scripts/testing/lib/powershell');
  const bridgeExe = path.join(workspaceRoot, 'target/release/omni-bridge-service.exe');
  const resetExe = path.join(workspaceRoot, 'target/release/omni-driver-audio-probe.exe');
  const recorderExe = path.join(workspaceRoot, 'target/release/omni-physical-output-probe.exe');
  const pipeSuffix = digest(Buffer.from(runMarker)).slice(0, 20);
  const pipeName = `omni-physical-source-${pipeSuffix}`;
  const bridgeArgs = windowsArguments(['--pipe-name', pipeName, '--runtime-root',
    path.join(outputDirectory, 'bridge-runtime'), '--bridge-version', '0.1.0']);
  // Bounded diagnostic recording, NOT the desktop terminal-authority protocol.
  const recorderArgs = windowsArguments(['--record-only', '--record-seconds', RECORD_SECONDS,
    '--physical-playback-device-id', physicalPlaybackDeviceId,
    '--record-path', path.join(outputDirectory, 'physical-output-recording.wav'),
    '--transcription-pcm-path', path.join(outputDirectory, 'physical-output-recording-16k-mono.pcm')]);
  return `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
Import-Module ${psQuote(path.join(moduleRoot, 'Omni.Testing.WatchMode.AudioPlayback.psm1'))} -Force
Import-Module ${psQuote(path.join(moduleRoot, 'Omni.Testing.Windows.Audio.psm1'))} -Force
# AudioPlayback reloads Bridge in its private module scope; expose Bridge last.
Import-Module ${psQuote(path.join(moduleRoot, 'Omni.Testing.WatchMode.Bridge.psm1'))} -Force
$output=${psQuote(outputDirectory)}
$runtime=Join-Path $output 'bridge-runtime'
New-Item -ItemType Directory -Path $runtime | Out-Null
$state=[ordered]@{protocolVersion='2026-08-27-audio-routing-v8';installChannel='development';driverVersion='0.10.0-dev';bridgeVersion='0.1.0';driverHealth='running';installedAt=(Get-Date -Format s);targetDeviceId='virtual-mic-default';virtualRenderDeviceId='virtual-speaker-default';driverBackend='sysvad-wave-rt'} | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $runtime 'driver-install-state.json'),$state,[Text.UTF8Encoding]::new($false))
$deadline=[DateTime]::UtcNow.AddSeconds(${deadlineSeconds})
$ownedTools=[Collections.Generic.List[object]]::new()
$cleanupErrors=[Collections.Generic.List[string]]::new()
$failure=$null
function Start-OwnedTool([string]$Label,[string]$Executable,[string]$Arguments){
  $info=[Diagnostics.ProcessStartInfo]::new()
  $info.FileName=$Executable;$info.Arguments=$Arguments;$info.WorkingDirectory=${psQuote(workspaceRoot)}
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $info.StandardOutputEncoding=[Text.Encoding]::UTF8;$info.StandardErrorEncoding=[Text.Encoding]::UTF8
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$process.EnableRaisingEvents=$true
  $tool=[pscustomobject]@{label=$Label;process=$process;stdout=$null;stderr=$null;drained=$false}
  $ownedTools.Add($tool)
  if(-not $process.Start()){throw "failed to start $Label"}
  $tool.stdout=$process.StandardOutput.ReadToEndAsync();$tool.stderr=$process.StandardError.ReadToEndAsync()
  return $tool
}
function Drain-OwnedTool($Tool,[DateTime]$Until){
  if($Tool.drained){return}
  $remaining=[int][Math]::Max(0,($Until-[DateTime]::UtcNow).TotalMilliseconds)
  if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($Tool.stdout,$Tool.stderr),$remaining)){
    throw "output drain unconfirmed: $($Tool.label)"
  }
  [IO.File]::WriteAllText((Join-Path $output ($Tool.label+'.stdout.log')),$Tool.stdout.Result,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $output ($Tool.label+'.stderr.log')),$Tool.stderr.Result,[Text.UTF8Encoding]::new($false))
  $Tool.drained=$true
}
function Wait-OwnedTool($Tool){
  $remaining=[int][Math]::Max(0,($deadline-[DateTime]::UtcNow).TotalMilliseconds)
  if(-not $Tool.process.WaitForExit($remaining)){throw "absolute deadline expired while waiting for $($Tool.label)"}
  Drain-OwnedTool $Tool $deadline
  if($Tool.process.ExitCode -ne 0){throw "$($Tool.label) failed with exit code $($Tool.process.ExitCode)"}
}
function Read-LastJson([string]$Path,[string]$Label){
  $lines=@(Get-Content -LiteralPath $Path -Encoding UTF8 | Where-Object {$_.Trim().StartsWith('{')})
  if($lines.Count -eq 0){throw "$Label returned no JSON"}
  try{return $lines[-1] | ConvertFrom-Json}catch{throw "$Label returned invalid JSON: $($_.Exception.Message)"}
}
try {
  $virtualEndpoint=Get-RenderEndpointRegistryIdentity -RequestedDeviceId ${psQuote(virtualRenderEndpointId)}
  if($virtualEndpoint.resolvedDeviceId -cne ${psQuote(virtualRenderEndpointId)} -or $virtualEndpoint.resolvedDeviceName -notlike '*Omni Translate Virtual Speaker*'){
    throw 'requested virtual endpoint is not the exact Omni virtual speaker render endpoint'
  }
  $resetOutput=& ${psQuote(resetExe)} --reset-only
  if($LASTEXITCODE -ne 0){throw "virtual-driver ring reset failed: $resetOutput"}
  $pipe=${psQuote(pipeName)}
  $bridge=Start-OwnedTool 'bridge' ${psQuote(bridgeExe)} ${psQuote(bridgeArgs)}
  $initRequest=New-BridgeSourceProbeInitPayload 'virtual-driver' ${psQuote(runMarker)} ${psQuote(physicalPlaybackDeviceId)}
  if($initRequest.mixControl.keepOriginalAudio -ne $true -or $initRequest.sourceCaptureMode -cne 'virtual-driver'){
    throw 'bridge helper changed the c02 original-audio route'
  }
  $init=Write-NamedPipeJsonLine $pipe $initRequest
  if(-not $init -or $init.type -cne 'bridge.state.snapshot' -or $init.bridgeState -cne 'running' -or $init.sourceCaptureMode -cne 'virtual-driver' -or $init.resolvedPhysicalPlaybackDeviceId -cne ${psQuote(physicalPlaybackDeviceId)}){
    throw 'bridge did not acknowledge the virtual-driver route'
  }
  $recorder=Start-OwnedTool 'physical-output-recorder' ${psQuote(recorderExe)} ${psQuote(recorderArgs)}
  Start-Sleep -Milliseconds 250
  $playback=Start-TestMediaPlayback -PathToMedia ${psQuote(mediaPath)} -PlaybackEndpointId ${psQuote(virtualRenderEndpointId)} -OutputDirectory $output -WorkspaceRoot ${psQuote(workspaceRoot)} -PlaybackSeconds 0
  if($playback.playbackMode -cne 'wasapi-media-injector' -or $playback.sourceGainDb -ne -5 -or $playback.postrollSilenceSeconds -ne 3 -or $playback.endpointId -cne ${psQuote(virtualRenderEndpointId)}){
    throw 'injector route, exact endpoint, signed gain, or postroll differed from c02'
  }
  Wait-OwnedTool $recorder
  $recording=Read-LastJson (Join-Path $output 'physical-output-recorder.stdout.log') 'physical output recorder'
  if($recording.passed -ne $true -or $recording.probeKind -cne 'physical-output-recording' -or $recording.resolvedPhysicalPlaybackDeviceId -cne ${psQuote(physicalPlaybackDeviceId)}){
    throw "physical output recorder route failed: $($recording.detail)"
  }
  if($bridge.process.HasExited){throw 'bridge exited before capture finished'}
  $stateAfter=Write-NamedPipeJsonLine $pipe ([ordered]@{type='bridge.state.query';requestId=${psQuote(`${runMarker}-after`)}})
  if($stateAfter.type -cne 'bridge.state.snapshot' -or $stateAfter.sourceCaptureMode -cne 'virtual-driver' -or $stateAfter.bridgeState -cne 'running' -or $stateAfter.resolvedPhysicalPlaybackDeviceId -cne ${psQuote(physicalPlaybackDeviceId)} -or $stateAfter.sourceFramesCaptured -le $init.sourceFramesCaptured){
    throw 'bridge did not capture source frames on the c02 route'
  }
  $route=[ordered]@{schemaVersion=1;artifactKind='watch-mode-physical-source-probe-route-observation';runMarker=${psQuote(runMarker)};providerCalls=0;recordSeconds=${RECORD_SECONDS};virtualEndpoint=$virtualEndpoint;initRequest=$initRequest;init=$init;stateAfter=$stateAfter;playback=$playback;recording=$recording}
  [IO.File]::WriteAllText((Join-Path $output 'route-observation.json'),($route|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
} catch { $failure=$_.Exception.Message } finally {
  foreach($tool in @($ownedTools.ToArray()) | Sort-Object label -Descending){
    try {
      if(-not $tool.process.HasExited){$tool.process.Kill()}
      if(-not $tool.process.WaitForExit(5000)){throw "owned handle exit unconfirmed: $($tool.label)"}
      Drain-OwnedTool $tool ([DateTime]::UtcNow.AddSeconds(5))
    } catch { $cleanupErrors.Add("$($tool.label): $($_.Exception.Message)") }
    try {$tool.process.Dispose()} catch {$cleanupErrors.Add("dispose $($tool.label): $($_.Exception.Message)")}
  }
  # This is local role cleanup only. The outer native job must also confirm all
  # descendants exited and both redirected streams drained before Node settles.
  $cleanup=[ordered]@{schemaVersion=1;artifactKind='watch-mode-physical-source-probe-cleanup';passed=($cleanupErrors.Count -eq 0);errors=@($cleanupErrors);providerCalls=0}
  try {
    [IO.File]::WriteAllText((Join-Path $output 'cleanup.json'),($cleanup|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
  } catch { $cleanupErrors.Add("cleanup evidence write: $($_.Exception.Message)") }
}
if($failure -or $cleanupErrors.Count -gt 0){throw "probe failure: $failure | cleanup: $($cleanupErrors -join '; ')"}`;
}

export async function executeProbePowerShell(script, {
  outputDirectory, workspaceRoot, deadlineSeconds, deadlineUtcMs, finalizerSha256, spawnImpl = spawn,
}) {
  if (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0 || deadlineSeconds > 300) {
    throw new Error('process custody requires a bounded positive deadline');
  }
  const absoluteDeadline = deadlineUtcMs ?? Date.now() + deadlineSeconds * 1000;
  if (!Number.isFinite(absoluteDeadline) || absoluteDeadline <= Date.now()) throw new Error('physical source probe deadline expired before launch');
  const deadline = new Date(absoluteDeadline).toISOString();
  const scriptPath = path.join(outputDirectory, 'probe.ps1');
  const custodyPath = path.join(outputDirectory, 'process-custody.json');
  if (fs.existsSync(custodyPath)) throw new Error('process custody output already exists');
  // A file avoids double-base64 Windows command-line limits. PS 5.1 needs a BOM
  // to decode non-ASCII UTF-8 source independently of the machine ANSI locale.
  fs.writeFileSync(scriptPath, `\uFEFF${script}`, { encoding: 'utf8', flag: 'wx' });
  const finalizerModule = path.join(workspaceRoot, 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveFinalizer.psm1');
  const windowsPowerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const childArguments = windowsArguments(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]);
  const launcher = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$custody=[ordered]@{schemaVersion=1;artifactKind=${psQuote(CUSTODY_KIND)};passed=$false;ownedTreeExited=$null;streamsDrained=$null;errors=@();providerCalls=0}
$exitCode=1
try {
${finalizerSha256 ? `if((Get-FileHash -LiteralPath ${psQuote(finalizerModule)} -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${psQuote(finalizerSha256)}){throw 'process-custody helper changed after preflight'}` : ''}
Import-Module ${psQuote(finalizerModule)} -Force
$deadline=[DateTime]::Parse(${psQuote(deadline)},[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)
$result=[OmniInteractiveFinalizerJob]::Run(${psQuote(windowsPowerShell)},${psQuote(childArguments)},${psQuote(workspaceRoot)},$deadline)
[Console]::Out.Write($result.Stdout)
[Console]::Error.Write($result.Stderr)
if($result.ExitCode -ne 0){throw "owned job failed: $($result.ExitCode)"}
$custody.passed=$true;$custody.ownedTreeExited=$true;$custody.streamsDrained=$true;$exitCode=0
} catch {
  $custody.errors=@($_.Exception.ToString())
  [Console]::Error.WriteLine($_.Exception.ToString())
}
[IO.File]::WriteAllText(${psQuote(custodyPath)},($custody|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
exit $exitCode`;
  const descriptors = [];
  const errors = [];
  let outcome;
  try {
    // Open logs before launch; failed redirection must not leave a running job.
    descriptors.push(fs.openSync(path.join(outputDirectory, 'probe.stdout.log'), 'wx'));
    descriptors.push(fs.openSync(path.join(outputDirectory, 'probe.stderr.log'), 'wx'));
    const child = spawnImpl(windowsPowerShell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64')],
      { cwd: workspaceRoot, windowsHide: true, stdio: ['ignore', ...descriptors],
        // A pwsh 7 parent can shadow PS 5.1 cmdlets (notably Get-FileHash).
        // Repo modules are absolute imports; no user module discovery is needed.
        env: { ...process.env, PSModulePath: path.join(path.dirname(windowsPowerShell), 'Modules') } });
    outcome = await new Promise((resolve) => {
      let launchError;
      child.once('error', (error) => { launchError = error; });
      // Never settle at a JS timeout or the root's exit event. The native job
      // owns cancellation, descendant exit, and its redirected-stream drain.
      child.once('close', (code, signal) => resolve({ code, signal, launchError }));
    });
  } catch (error) {
    errors.push(error);
  } finally {
    // There are no asynchronous Node log pipes left to race result.json.
    for (const descriptor of descriptors) {
      try { fs.fsyncSync(descriptor); } catch (error) { errors.push(new Error(`probe log flush failed: ${error.message}`, { cause: error })); }
      try { fs.closeSync(descriptor); } catch (error) { errors.push(new Error(`probe log close failed: ${error.message}`, { cause: error })); }
    }
  }
  if (outcome?.launchError) errors.push(outcome.launchError);
  if (outcome && (outcome.code !== 0 || outcome.signal)) {
    let detail = '';
    try { detail = fs.readFileSync(path.join(outputDirectory, 'probe.stderr.log'), 'utf8').slice(-16_384); }
    catch (error) { errors.push(error); }
    errors.unshift(new Error(`physical source probe failed: exit=${outcome.code} signal=${outcome.signal ?? 'none'}; ${detail}`));
  }
  if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join('\n'));
  return verifyProcessCustody(readAccountingReceipt(outputDirectory, 'process-custody.json', 'native-exit', []));
}

function verifyRouteObservation(observation, { runMarker, mediaPath, outputDirectory,
  virtualRenderEndpointId, physicalPlaybackDeviceId }) {
  const samePath = (actual, expected) => typeof actual === 'string'
    && path.resolve(actual).toLowerCase() === path.resolve(expected).toLowerCase();
  const init = observation?.initRequest;
  const before = observation?.init;
  const after = observation?.stateAfter;
  const playback = observation?.playback;
  const recording = observation?.recording;
  if (observation?.schemaVersion !== 1 || observation.artifactKind !== 'watch-mode-physical-source-probe-route-observation'
      || observation.runMarker !== runMarker || observation.providerCalls !== 0 || observation.recordSeconds !== RECORD_SECONDS
      || init?.type !== 'bridge.init' || init.sessionId !== runMarker || init.sourceCaptureMode !== 'virtual-driver'
      || init.physicalPlaybackDeviceId !== physicalPlaybackDeviceId || init.mixControl?.keepOriginalAudio !== true
      || observation.virtualEndpoint?.resolvedDeviceId !== virtualRenderEndpointId
      || !String(observation.virtualEndpoint?.resolvedDeviceName).includes('Omni Translate Virtual Speaker')
      || [before, after].some((state) => state?.type !== 'bridge.state.snapshot' || state.bridgeState !== 'running'
        || state.sourceCaptureMode !== 'virtual-driver' || state.resolvedPhysicalPlaybackDeviceId !== physicalPlaybackDeviceId
        || !Number.isSafeInteger(state.sourceFramesCaptured) || state.sourceFramesCaptured < 0)
      || after.sourceFramesCaptured <= before.sourceFramesCaptured
      || playback?.playbackMode !== 'wasapi-media-injector' || playback.endpointId !== virtualRenderEndpointId
      || playback.sourceGainDb !== -5 || playback.postrollSilenceSeconds !== 3 || !(playback.renderedFrames > 0)
      || !samePath(playback.mediaPath, mediaPath) || playback.mediaSha256 !== digest(fs.readFileSync(mediaPath))
      || !samePath(playback.referencePcmPath, path.join(outputDirectory, 'source-media-reference-16k-mono.pcm'))
      || recording?.passed !== true || recording.skipped !== false || recording.probeKind !== 'physical-output-recording'
      || recording.physicalPlaybackDeviceId !== physicalPlaybackDeviceId
      || recording.resolvedPhysicalPlaybackDeviceId !== physicalPlaybackDeviceId
      || !samePath(recording.recordingPath, path.join(outputDirectory, 'physical-output-recording.wav'))
      || !samePath(recording.transcriptionPcmPath, path.join(outputDirectory, 'physical-output-recording-16k-mono.pcm'))) {
    throw new Error('observed physical source route does not match the c02 request');
  }
  return observation;
}

export async function runPhysicalSourceProbe(options, dependencies = {}) {
  const workspaceRoot = realDirectory(options.workspaceRoot, 'workspace root');
  const outputParent = realDirectory(options.outputParent, 'output parent');
  const executionId = `physical-source-probe-${dependencies.randomUUID?.() ?? crypto.randomUUID()}`;
  const outputDirectory = path.join(outputParent, executionId);
  fs.mkdirSync(outputDirectory, { recursive: false });
  const resultPath = path.join(outputDirectory, 'result.json');
  const base = { schemaVersion: 1, artifactKind: PHYSICAL_SOURCE_PROBE_KIND, executionId,
    startedAt: new Date().toISOString(), completedAt: null, providerCalls: 0,
    diagnosticOnly: true, contentVerdict: 'not-evaluated', publicationVerdict: 'not-applicable', passed: false };
  writeJson(path.join(outputDirectory, 'request.json'), { ...base, request: options }, 'wx');
  let launchAttempted = false;
  let receiptsValidated = false;
  const accountingObservations = [];
  try {
    if (process.platform !== 'win32' && !dependencies.allowNonWindows) throw new Error('physical source probe requires Windows');
    const endpoints = [options.virtualRenderEndpointId, options.physicalPlaybackDeviceId];
    if (endpoints.some((value) => typeof value !== 'string' || !value.trim() || value !== value.trim()
      || value.toLowerCase() === 'default' || /[\u0000-\u001f]/u.test(value)) || endpoints[0].toLowerCase() === endpoints[1].toLowerCase()) {
      throw new Error('two distinct explicit c02 endpoint identities are required');
    }
    const deadlineSeconds = Number(options.deadlineSeconds ?? 180);
    if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 150 || deadlineSeconds > 300) throw new Error('deadlineSeconds must be an integer between 150 and 300');
    (dependencies.checkDiskSpace ?? checkWatchDiskSpace)({ receiptPath: path.join(outputDirectory, 'disk-space.json') });
    const mediaPath = canonicalMedia(workspaceRoot, options.mediaPath);
    const deadlineUtcMs = Date.now() + deadlineSeconds * 1000;
    const runtimeAuthority = verifyProbeRuntime({ workspaceRoot, runtimeManifestPath: options.runtimeManifestPath,
      distributionDigest: options.distributionDigest });
    const runMarker = `watch_mode_physical_source_probe.run_id=${executionId}`;
    const script = buildProbePowerShell({ workspaceRoot, outputDirectory, mediaPath,
      virtualRenderEndpointId: options.virtualRenderEndpointId, physicalPlaybackDeviceId: options.physicalPlaybackDeviceId,
      deadlineSeconds, runMarker });
    writeJson(path.join(outputDirectory, 'route-request.json'), { schemaVersion: 1,
      artifactKind: 'watch-mode-physical-source-probe-route-request', providerCalls: 0,
      sourceGainDb: -5, postrollSilenceSeconds: 3, mediaPath, virtualRenderEndpointId: options.virtualRenderEndpointId,
      physicalPlaybackDeviceId: options.physicalPlaybackDeviceId, runtimeAuthority }, 'wx');
    launchAttempted = true;
    const processCustody = await (dependencies.executePowerShell ?? executeProbePowerShell)(script, {
      outputDirectory, workspaceRoot, deadlineSeconds, deadlineUtcMs, spawnImpl: dependencies.spawnImpl,
      finalizerSha256: runtimeAuthority.supportFiles.find((entry) => entry.path.endsWith('/Omni.Testing.WatchMode.InteractiveFinalizer.psm1')).sha256,
    });
    accountingObservations.push(providerObservation('process-custody-return', 'launch-return', processCustody));
    verifyProcessCustody(processCustody);
    const cleanup = readAccountingReceipt(outputDirectory, 'cleanup.json', 'verification', accountingObservations);
    if (cleanup?.schemaVersion !== 1 || cleanup.artifactKind !== 'watch-mode-physical-source-probe-cleanup' || cleanup.passed !== true
        || cleanup.providerCalls !== 0 || !Array.isArray(cleanup.errors) || cleanup.errors.length !== 0) {
      throw new Error(`physical source probe cleanup authority is missing or failed: ${JSON.stringify(cleanup)}`);
    }
    const route = verifyRouteObservation(readAccountingReceipt(outputDirectory, 'route-observation.json', 'verification', accountingObservations), {
      runMarker, mediaPath, outputDirectory, virtualRenderEndpointId: options.virtualRenderEndpointId,
      physicalPlaybackDeviceId: options.physicalPlaybackDeviceId,
    });
    receiptsValidated = true;
    if (providerAccounting(launchAttempted, accountingObservations, receiptsValidated).providerCalls !== 0) {
      throw new Error('physical source probe contains nonzero or unknown Provider accounting');
    }
    if (verifyProbeRuntime({ workspaceRoot, runtimeManifestPath: options.runtimeManifestPath,
      distributionDigest: options.distributionDigest }).distributionDigest !== runtimeAuthority.distributionDigest) {
      throw new Error('runtime distribution authority changed during the probe');
    }
    // Use the complete unmodified WASAPI capture as the diagnostic source window;
    // do not fabricate a desktop terminal or synthesize a "clean" reference crop.
    const analyzerAuthority = runtimeAuthority.files.find((entry) => entry.path === 'target/release/omni-benchmark.exe');
    const waveform = await (dependencies.buildWaveformAuthority ?? buildPhysicalSourceWaveformAuthority)({
      runDirectory: outputDirectory, sourceWindowPath: path.join(outputDirectory, 'physical-output-recording-16k-mono.pcm'), workspaceRoot,
      releaseExecutablePath: path.join(workspaceRoot, analyzerAuthority.path),
      releaseExecutableSha256: analyzerAuthority.sha256,
      noBuild: true,
      deadlineUtcMs,
    });
    const observed = waveform.candidates?.find((entry) => Math.abs(
      entry.referenceStartSample / waveform.sampleRateHz - PHYSICAL_SOURCE_PROBE_REFERENCE_SECONDS,
    ) < 0.001) ?? null;
    const result = { ...base, ...providerAccounting(launchAttempted, accountingObservations, receiptsValidated),
      completedAt: new Date().toISOString(), passed: waveform.passed === true,
      routeMatchedC02: true, route, processCustody, analyzerAuthority, waveform,
      referenceSegment: { requestedOffsetSeconds: PHYSICAL_SOURCE_PROBE_REFERENCE_SECONDS, observed } };
    writeJson(resultPath, result); return result;
  } catch (error) {
    if (launchAttempted) {
      for (const source of ['process-custody.json', 'cleanup.json', 'route-observation.json']) {
        try { readAccountingReceipt(outputDirectory, source, 'failure-recovery', accountingObservations); }
        catch { /* Independent, bounded recovery: unknown is recorded, never zeroed. */ }
      }
    }
    writeJson(resultPath, { ...base, ...providerAccounting(launchAttempted, accountingObservations, receiptsValidated), completedAt: new Date().toISOString(),
      failureCode: error.code ?? 'watch.physical-source-probe.failed', error: error.message });
    error.resultPath = resultPath; throw error;
  }
}

export function parsePhysicalSourceProbeArgs(argv) {
  const names = new Map([['--workspace-root', 'workspaceRoot'], ['--output-parent', 'outputParent'],
    ['--media', 'mediaPath'], ['--runtime-manifest', 'runtimeManifestPath'],
    ['--distribution-digest', 'distributionDigest'],
    ['--virtual-render-endpoint-id', 'virtualRenderEndpointId'],
    ['--physical-playback-device-id', 'physicalPlaybackDeviceId'], ['--deadline-seconds', 'deadlineSeconds']]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]); const value = argv[index + 1];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(result, key)) throw new Error(`invalid, duplicate, or missing argument: ${argv[index]}`);
    result[key] = key === 'deadlineSeconds' ? Number(value) : value;
  }
  for (const key of ['workspaceRoot', 'outputParent', 'runtimeManifestPath', 'distributionDigest', 'virtualRenderEndpointId', 'physicalPlaybackDeviceId']) {
    if (!result[key]) throw new Error(`${key} is required`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhysicalSourceProbe(parsePhysicalSourceProbeArgs(process.argv.slice(2)))
    .then((result) => { console.log(JSON.stringify(result)); process.exitCode = result.passed ? 0 : 1; })
    .catch((error) => { console.error(`${error.message}${error.resultPath ? `; result=${error.resultPath}` : ''}`); process.exitCode = 1; });
}
