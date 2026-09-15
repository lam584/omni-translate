import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PCM_RATE = 16_000;
const MAX_SECONDS = 300;
const MAX_CUES = 512;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(detail) { throw new Error(`retained PCM correlation evidence invalid: ${detail}`); }
function requireEvidence(condition, detail) { if (!condition) fail(detail); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function regularContainedFile(root, relativePath, label) {
  requireEvidence(typeof relativePath === 'string' && relativePath.length > 0 && !path.isAbsolute(relativePath), `${label} path`);
  const normalized = path.normalize(relativePath);
  requireEvidence(normalized !== '..' && !normalized.startsWith(`..${path.sep}`), `${label} escapes authority root`);
  const candidate = path.resolve(root, normalized);
  const relative = path.relative(root, candidate);
  requireEvidence(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${label} escapes authority root`);
  const stat = fs.lstatSync(candidate);
  requireEvidence(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular file`);
  requireEvidence(fs.realpathSync.native(candidate) === candidate, `${label} traverses a link`);
  return { candidate, stat };
}

function readJson(file, label) {
  const stat = fs.lstatSync(file);
  requireEvidence(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_JSON_BYTES, `${label} size/type`);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
}

function readPcm16(file, label, expectedHash = null, maxSeconds = MAX_SECONDS, sampleRateHz = PCM_RATE) {
  const stat = fs.lstatSync(file);
  requireEvidence(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync.native(file) === file, `${label} is not a regular local file`);
  requireEvidence(stat.size > 0 && stat.size % 2 === 0, `${label} is not frame-aligned s16le mono`);
  requireEvidence(stat.size <= maxSeconds * sampleRateHz * 2, `${label} exceeds bounded duration`);
  const bytes = fs.readFileSync(file);
  if (expectedHash !== null) requireEvidence(SHA256.test(expectedHash) && sha256(bytes) === expectedHash, `${label} SHA-256 mismatch`);
  const samples = new Float64Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readInt16LE(i * 2) / 32768;
  return { samples, byteLength: bytes.length, sha256: sha256(bytes) };
}

function resampleLinear(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;
  const output = new Float64Array(Math.floor(input.length * targetRate / sourceRate));
  for (let i = 0; i < output.length; i += 1) {
    const position = i * sourceRate / targetRate;
    const left = Math.floor(position);
    const fraction = position - left;
    const a = input[Math.min(left, input.length - 1)] ?? 0;
    const b = input[Math.min(left + 1, input.length - 1)] ?? a;
    output[i] = a + (b - a) * fraction;
  }
  return output;
}

function validateAuthority(authorityPath, playbackStartedAtMs, maxSeconds) {
  const authority = readJson(authorityPath, 'translated cue authority');
  requireEvidence(authority.schemaVersion === 2 && authority.artifactKind === 'watch-mode-translated-cue-pcm-authority', 'translated authority identity');
  requireEvidence(authority.finalized === true && authority.activeStreamCount === 0 && authority.pcmFormat === 's16le', 'translated authority is not finalized s16le');
  requireEvidence(Array.isArray(authority.acceptedCues) && authority.acceptedCues.length > 0 && authority.acceptedCues.length <= MAX_CUES, 'translated cue inventory');
  requireEvidence(integer(playbackStartedAtMs), 'playback startedAtMs');
  const root = fs.realpathSync.native(path.dirname(authorityPath));
  let priorSequence = 0;
  const cues = authority.acceptedCues.map((cue, index) => {
    requireEvidence(integer(cue.sequence) && cue.sequence === priorSequence + 1, `cue sequence ${index}`); priorSequence = cue.sequence;
    requireEvidence(typeof cue.cueId === 'string' && cue.cueId.length > 0, `cueId ${index}`);
    requireEvidence(integer(cue.createdAtMs) && cue.createdAtMs >= playbackStartedAtMs - 30_000, `createdAtMs ${index}`);
    requireEvidence(integer(cue.sampleRateHz) && cue.sampleRateHz >= 8_000 && cue.sampleRateHz <= 96_000, `sampleRateHz ${index}`);
    requireEvidence(cue.channelCount === 1 && integer(cue.sampleCount) && cue.sampleCount > 0, `PCM format/count ${index}`);
    requireEvidence(typeof cue.sha256 === 'string' && SHA256.test(cue.sha256), `SHA-256 ${index}`);
    const { candidate, stat } = regularContainedFile(root, cue.relativePath, `cue PCM ${index}`);
    requireEvidence(stat.size === cue.sampleCount * 2 && cue.bytes === stat.size, `cue PCM byte count ${index}`);
    const pcm = readPcm16(candidate, `cue PCM ${index}`, cue.sha256, maxSeconds, cue.sampleRateHz);
    return { cueId: cue.cueId, sequence: cue.sequence, startSample: Math.max(0, Math.round((cue.createdAtMs - playbackStartedAtMs) * PCM_RATE / 1000)), samples: resampleLinear(pcm.samples, cue.sampleRateHz, PCM_RATE) };
  });
  return { authority, cues };
}

function mixTimeline(cues, length) {
  const mixed = new Float64Array(length);
  const active = new Uint16Array(length);
  for (const cue of cues) for (let i = 0; i < cue.samples.length && cue.startSample + i < length; i += 1) {
    const at = cue.startSample + i; mixed[at] += cue.samples[i]; active[at] += 1;
  }
  for (let i = 0; i < mixed.length; i += 1) if (active[i] > 1) mixed[i] /= active[i];
  return mixed;
}

function rms(samples, start, length) {
  let energy = 0; for (let i = 0; i < length; i += 1) { const value = samples[start + i] ?? 0; energy += value * value; }
  return Math.sqrt(energy / Math.max(1, length));
}

function correlation(a, aStart, b, bStart, length) {
  const stride = 8; // 2 kHz analysis is sufficient for bounded speech-waveform lag diagnostics.
  let sumA = 0, sumB = 0, count = 0;
  for (let i = 0; i < length; i += stride) { const ai = aStart + i, bi = bStart + i; if (ai < 0 || bi < 0 || ai >= a.length || bi >= b.length) continue; sumA += a[ai]; sumB += b[bi]; count += 1; }
  if (count < Math.floor(length / stride) * 0.8) return null;
  const meanA = sumA / count, meanB = sumB / count; let cross = 0, ea = 0, eb = 0;
  for (let i = 0; i < length; i += stride) { const ai = aStart + i, bi = bStart + i; if (ai < 0 || bi < 0 || ai >= a.length || bi >= b.length) continue; const x = a[ai] - meanA, y = b[bi] - meanB; cross += x * y; ea += x * x; eb += y * y; }
  return ea > 1e-12 && eb > 1e-12 ? cross / Math.sqrt(ea * eb) : null;
}

function bestCorrelation(provider, reference, start, length, maxLag, lagStep) {
  let best = { score: null, lagSamples: null };
  for (let lag = -maxLag; lag <= maxLag; lag += lagStep) {
    const score = correlation(provider, start, reference, start + lag, length);
    if (score !== null && (best.score === null || Math.abs(score) > Math.abs(best.score))) best = { score, lagSamples: lag };
  }
  return best;
}

export function analyzeRetainedPcmCorrelation({ runDirectory, windowMs = 2000, hopMs = 1000, maxLagMs = 1500, lagStepMs = 10, silenceRms = 0.0008, confidenceFloor = 0.12, dominanceMargin = 0.08, maxSeconds = MAX_SECONDS } = {}) {
  requireEvidence(typeof runDirectory === 'string' && path.isAbsolute(runDirectory), 'runDirectory must be absolute');
  const root = fs.realpathSync.native(runDirectory);
  const sourcePath = path.join(root, 'source-media-reference-16k-mono.pcm');
  const providerPath = path.join(root, 'provider-input-16k-mono.pcm');
  const playbackPath = path.join(root, 'playback.json');
  const authorityPath = path.join(root, 'translated-cue-pcm', 'translated-cue-pcm-summary.json');
  for (const [value, name, min, max] of [[windowMs, 'windowMs', 200, 10_000], [hopMs, 'hopMs', 100, windowMs], [maxLagMs, 'maxLagMs', 0, 5_000], [lagStepMs, 'lagStepMs', 1, Math.max(1, maxLagMs || 1)]]) requireEvidence(integer(value) && value >= min && value <= max, name);
  requireEvidence(Number.isFinite(silenceRms) && silenceRms > 0 && Number.isFinite(confidenceFloor) && confidenceFloor >= 0 && confidenceFloor <= 1 && Number.isFinite(dominanceMargin) && dominanceMargin >= 0 && dominanceMargin <= 1, 'thresholds');
  const playback = readJson(playbackPath, 'playback');
  requireEvidence(playback.passed === true && integer(playback.startedAtMs) && typeof playback.mediaSha256 === 'string' && SHA256.test(playback.mediaSha256), 'playback authority');
  const source = readPcm16(sourcePath, 'source PCM', null, maxSeconds).samples;
  const providerReceipt = readPcm16(providerPath, 'provider PCM', null, maxSeconds);
  const provider = providerReceipt.samples;
  const { authority, cues } = validateAuthority(authorityPath, playback.startedAtMs, maxSeconds);
  requireEvidence(authority.maxProviderInputSamples >= provider.length, 'provider PCM exceeds signed authority sample budget');
  const translated = mixTimeline(cues, provider.length + Math.round(maxLagMs * PCM_RATE / 1000));
  const windowSamples = Math.round(windowMs * PCM_RATE / 1000), hopSamples = Math.round(hopMs * PCM_RATE / 1000), maxLag = Math.round(maxLagMs * PCM_RATE / 1000), lagStep = Math.max(1, Math.round(lagStepMs * PCM_RATE / 1000));
  const windows = [];
  for (let start = 0; start + windowSamples <= provider.length; start += hopSamples) {
    const providerRms = rms(provider, start, windowSamples), sourceRms = rms(source, start, windowSamples), translationRms = rms(translated, start, windowSamples);
    const silent = providerRms < silenceRms;
    const sourceMatch = silent || sourceRms < silenceRms ? { score: null, lagSamples: null } : bestCorrelation(provider, source, start, windowSamples, maxLag, lagStep);
    const translationMatch = silent || translationRms < silenceRms ? { score: null, lagSamples: null } : bestCorrelation(provider, translated, start, windowSamples, maxLag, lagStep);
    const sourceScore = sourceMatch.score === null ? null : Math.abs(sourceMatch.score), translationScore = translationMatch.score === null ? null : Math.abs(translationMatch.score);
    const bestScore = Math.max(sourceScore ?? 0, translationScore ?? 0);
    const lowConfidence = !silent && bestScore < confidenceFloor;
    let classification = 'inconclusive';
    if (silent) classification = 'silence';
    else if (!lowConfidence && sourceScore !== null && translationScore !== null) {
      if (sourceScore - translationScore >= dominanceMargin) classification = 'source-dominant';
      else if (translationScore - sourceScore >= dominanceMargin) classification = 'translation-dominant';
    }
    windows.push({ startMs: Math.round(start * 1000 / PCM_RATE), endMs: Math.round((start + windowSamples) * 1000 / PCM_RATE), sourceScore, translationScore, sourceLagMs: sourceMatch.lagSamples === null ? null : Math.round(sourceMatch.lagSamples * 1000 / PCM_RATE), translationLagMs: translationMatch.lagSamples === null ? null : Math.round(translationMatch.lagSamples * 1000 / PCM_RATE), providerRms, sourceRms, translationRms, silent, lowConfidence, inconclusive: classification === 'inconclusive', classification });
  }
  const counts = Object.fromEntries(['source-dominant', 'translation-dominant', 'silence', 'inconclusive'].map(key => [key, windows.filter(window => window.classification === key).length]));
  return { schemaVersion: 1, artifactKind: 'watch-mode-retained-pcm-dual-reference-correlation', diagnosticOnly: true, gateEligible: false, timelineAuthority: 'approximate-createdAtMs-relative-to-playback-start', runDirectory: root, mediaSha256: playback.mediaSha256, format: { sampleRateHz: PCM_RATE, channelCount: 1, pcmFormat: 's16le' }, parameters: { windowMs, hopMs, maxLagMs, lagStepMs, silenceRms, confidenceFloor, dominanceMargin, maxSeconds }, receipts: { source: { samples: source.length }, provider: { samples: provider.length, byteLength: providerReceipt.byteLength, sha256: providerReceipt.sha256 }, translatedAuthority: { cueCount: cues.length, cellId: authority.cellId, leaseId: authority.leaseId, runMarker: authority.runMarker } }, counts, windows };
}

function parseArgs(argv) {
  const options = {}; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === '--run-directory') options.runDirectory = path.resolve(argv[++i] ?? ''); else if (arg === '--output') options.output = path.resolve(argv[++i] ?? ''); else if (arg.startsWith('--')) { const key = arg.slice(2).replace(/-([a-z])/gu, (_, c) => c.toUpperCase()); options[key] = Number(argv[++i]); } else fail(`unknown argument ${arg}`); }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const { output, ...options } = parseArgs(process.argv.slice(2)); const result = analyzeRetainedPcmCorrelation(options); const text = `${JSON.stringify(result, null, 2)}\n`; if (output) fs.writeFileSync(output, text, { encoding: 'utf8', flag: 'wx' }); else process.stdout.write(text); } catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
}


