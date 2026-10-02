import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { inspectPcm16MonoWav, normalizeStreamingWavHeader } from './fixtures/wav-fixture-utils.mjs';

export const SPEECH_SYNTHESIS_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export const SPEECH_FIXTURE_LIMITS = Object.freeze({ requests: 6, characters: 1600, charactersPerRequest: 512, audioBytes: 32 * 1024 * 1024 });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

export function createSpeechSynthesisPlan(text, { model = 'qwen3-tts-flash', voice = 'Cherry' } = {}) {
  const segments = text.trim().split(/\r?\n\s*\r?\n/u).map(s => s.trim()).filter(Boolean);
  if (!segments.length || segments.length > SPEECH_FIXTURE_LIMITS.requests
    || segments.some(s => [...s].length > SPEECH_FIXTURE_LIMITS.charactersPerRequest)
    || segments.reduce((n, s) => n + [...s].length, 0) > SPEECH_FIXTURE_LIMITS.characters) {
    throw new Error('speech fixture text exceeds the frozen synthesis request/character budget');
  }
  if (model !== 'qwen3-tts-flash' || voice !== 'Cherry') throw new Error('speech fixture model/voice are fixed for this generation profile');
  const plan = { schemaVersion: 1, artifactKind: 'local-aec-speech-synthesis-plan', model, voice,
    endpoint: SPEECH_SYNTHESIS_ENDPOINT, language: 'Chinese', maximumRequests: segments.length,
    maximumCharacters: segments.reduce((n, s) => n + [...s].length, 0), textSha256: sha(Buffer.from(text, 'utf8')),
    segments: segments.map((text, index) => ({ id: `zh-${index + 1}`, text, textSha256: sha(Buffer.from(text, 'utf8')), characters: [...text].length })) };
  return { ...plan, planSha256: sha(Buffer.from(JSON.stringify(plan), 'utf8')) };
}

export function extract24kMonoPcm(wav) {
  const facts = inspectPcm16MonoWav(wav);
  if (facts.sampleRate !== 24000 || facts.channels !== 1 || facts.bitsPerSample !== 16) throw new Error('generated speech must be 24kHz mono PCM16 WAV');
  let data;
  for (let i = 12; i + 8 <= wav.length;) {
    const size = wav.readUInt32LE(i + 4);
    if (wav.toString('ascii', i, i + 4) === 'data') data = wav.subarray(i + 8, i + 8 + size);
    i += 8 + size + size % 2;
  }
  if (!data?.length || !data.some(byte => byte !== 0)) throw new Error('generated speech is empty or entirely silent');
  return Buffer.from(data);
}

export function readSpeechApiKey({ environment = process.env, credentialHelper } = {}) {
  const direct = environment.DASHSCOPE_API_KEY ?? environment.OMNI_TEST_DASHSCOPE_API_KEY;
  if (direct?.trim()) return direct.trim();
  if (!credentialHelper) throw new Error('speech synthesis credential is unavailable');
  try {
    // Capture in memory only: never expose the export output to a terminal or file.
    const bytes = execFileSync(credentialHelper, ['export'], { windowsHide: true, timeout: 10000,
      maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
    const key = bytes.toString('utf8').trim(); bytes.fill(0);
    if (!key || key.length > 2560) throw new Error('invalid credential');
    return key;
  } catch { throw new Error('the selected Credential Manager helper could not supply the synthesis credential'); }
}

async function responseAudio(payload, fetchAudio) {
  const encoded = payload?.output?.audio?.data;
  // Inline data may be bare PCM even when a downloadable WAV URL is present.
  // Prefer the vendor file; never guess that arbitrary inline bytes are a WAV.
  if (typeof encoded === 'string' && !payload?.output?.audio?.url) {
    if (encoded.length > SPEECH_FIXTURE_LIMITS.audioBytes * 4 / 3 + 4) throw new Error('generated audio exceeds byte budget');
    return Buffer.from(encoded, 'base64');
  }
  const url = new URL(payload?.output?.audio?.url ?? '');
  // The official synchronous response may use an HTTP OSS URL. Upgrade the
  // same vendor host/path/query to TLS; credentials are never sent to this download.
  if (url.protocol === 'http:' && /(?:^|\.)(?:aliyuncs\.com|alicdn\.com)$/iu.test(url.hostname)) url.protocol = 'https:';
  if (url.protocol !== 'https:' || !/(?:^|\.)(?:aliyuncs\.com|alicdn\.com)$/iu.test(url.hostname)
    || url.username || url.password) throw new Error('synthesis audio URL is not an allowed HTTPS vendor artifact');
  const response = await fetchAudio(url, { signal: AbortSignal.timeout(40000) });
  if (!response.ok) throw new Error(`synthesis artifact download returned HTTP ${response.status}`);
  if (Number(response.headers?.get('content-length') ?? 0) > SPEECH_FIXTURE_LIMITS.audioBytes) throw new Error('generated audio exceeds byte budget');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > SPEECH_FIXTURE_LIMITS.audioBytes) throw new Error('generated audio exceeds byte budget');
  return bytes;
}

export async function generateSpeechFixture({ plan, outputDirectory, apiKey, confirmPaidGeneration = false }, { fetchImpl = fetch } = {}) {
  if (confirmPaidGeneration !== true) throw new Error('explicit paid speech generation confirmation is required');
  const { planSha256, ...frozen } = plan;
  if (sha(Buffer.from(JSON.stringify(frozen), 'utf8')) !== planSha256) throw new Error('speech synthesis plan digest changed');
  const recalculated = createSpeechSynthesisPlan(plan.segments.map(s => s.text).join('\n\n'));
  if (plan.model !== recalculated.model || plan.voice !== recalculated.voice || plan.segments.length !== recalculated.segments.length
    || plan.maximumCharacters !== recalculated.maximumCharacters || plan.maximumRequests !== plan.segments.length
    || plan.segments.some((s, i) => s.id !== recalculated.segments[i].id || s.textSha256 !== recalculated.segments[i].textSha256 || s.characters !== recalculated.segments[i].characters)) {
    throw new Error('speech synthesis plan identity/budget changed');
  }
  if (!apiKey?.trim()) throw new Error('speech synthesis credential is unavailable');
  fs.mkdirSync(outputDirectory, { recursive: false });
  write(path.join(outputDirectory, 'synthesis-plan.json'), plan);
  const ledger = { schemaVersion: 1, artifactKind: 'local-aec-speech-synthesis-usage', provider: 'dashscope', model: plan.model,
    planSha256: plan.planSha256, status: 'running', providerCalls: 0, requestedCharacters: 0, automaticRetries: 0,
    translationProviderCalls: 0, actualBilledCurrencyAmount: null, entries: [] };
  const persist = () => fs.writeFileSync(path.join(outputDirectory, 'synthesis-usage.json'), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  persist();
  try {
    for (const segment of plan.segments) {
      const entry = { segmentId: segment.id, inputTextSha256: segment.textSha256, requestedCharacters: segment.characters,
        status: 'dispatched', dispatchedAt: new Date().toISOString(), responseRequestId: null, usage: null };
      ledger.entries.push(entry); ledger.providerCalls += 1; ledger.requestedCharacters += segment.characters; persist();
      const response = await fetchImpl(SPEECH_SYNTHESIS_ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(90000),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: plan.model, input: { text: segment.text, voice: plan.voice, language_type: 'Chinese' }, parameters: {} }) });
      entry.httpStatus = response.status;
      if (!response.ok) throw new Error(`speech synthesis returned HTTP ${response.status}; no automatic retry`);
      const payload = await response.json();
      entry.responseRequestId = typeof payload.request_id === 'string' ? payload.request_id : null;
      entry.usage = payload.usage && typeof payload.usage === 'object'
        ? Object.fromEntries(Object.entries(payload.usage).filter(([k, v]) => /^[a-z0-9_]{1,64}$/iu.test(k) && Number.isFinite(v) && v >= 0)) : null;
      entry.responseAudioShape = { hasInlineData: typeof payload?.output?.audio?.data === 'string',
        hasArtifactUrl: typeof payload?.output?.audio?.url === 'string',
        metadataKeys: Object.keys(payload?.output?.audio ?? {}).sort(),
        artifactProtocol: payload?.output?.audio?.url ? new URL(payload.output.audio.url).protocol : null,
        artifactHost: payload?.output?.audio?.url ? new URL(payload.output.audio.url).hostname : null };
      persist();
      const originalAudio = await responseAudio(payload, fetchImpl);
      entry.originalAudioFile = segment.id + '.api-audio.bin';
      entry.originalAudioSha256 = sha(originalAudio); entry.originalAudioBytes = originalAudio.length;
      fs.writeFileSync(path.join(outputDirectory, entry.originalAudioFile), originalAudio, { flag: 'wx' }); persist();
      const wav = normalizeStreamingWavHeader(Buffer.from(originalAudio));
      if (wav.length > SPEECH_FIXTURE_LIMITS.audioBytes) throw new Error('generated audio exceeds byte budget');
      const pcm = extract24kMonoPcm(wav);
      const wavFile = `${segment.id}.wav`, pcmFile = `${segment.id}.s16le`;
      fs.writeFileSync(path.join(outputDirectory, wavFile), wav, { flag: 'wx' });
      fs.writeFileSync(path.join(outputDirectory, pcmFile), pcm, { flag: 'wx' });
      Object.assign(entry, { status: 'completed', completedAt: new Date().toISOString(), wavFile, pcmFile,
        wavSha256: sha(wav), pcmSha256: sha(pcm), pcmFrames: pcm.length / 2, ...inspectPcm16MonoWav(wav) });
      persist();
    }
    ledger.status = 'completed'; persist(); return ledger;
  } catch (error) {
    ledger.status = 'failed'; ledger.failure = { message: String(error.message).replaceAll(apiKey, '[REDACTED]') };
    if (ledger.entries.at(-1)?.status === 'dispatched') ledger.entries.at(-1).status = 'failed';
    persist(); throw new Error(ledger.failure.message);
  }
}

export const parseSpeechFixtureArgs = argv => parseCliArgs(argv, {
  booleans: ['confirm-paid-generation'], defaults: { credentialHelper: '', outputDirectory: '',
    text: 'scripts/testing/fixtures/watch-mode-en-original.zh-CN.txt' },
});

if (isMain(import.meta.url)) {
  try {
    const args = parseSpeechFixtureArgs(process.argv.slice(2));
    if (args.confirmPaidGeneration !== true && args.confirmPaidGeneration !== 'true') throw new Error('--confirm-paid-generation is required');
    if (!args.outputDirectory || !args.credentialHelper) throw new Error('--output-directory and --credential-helper are required');
    const source = path.resolve(repoRoot, args.text ?? 'scripts/testing/fixtures/watch-mode-en-original.zh-CN.txt');
    const plan = createSpeechSynthesisPlan(fs.readFileSync(source, 'utf8'));
    const apiKey = readSpeechApiKey({ credentialHelper: path.resolve(args.credentialHelper) });
    const result = await generateSpeechFixture({ plan, outputDirectory: path.resolve(repoRoot, args.outputDirectory), apiKey, confirmPaidGeneration: true });
    console.log(JSON.stringify({ status: result.status, providerCalls: result.providerCalls, requestedCharacters: result.requestedCharacters,
      translationProviderCalls: 0, outputDirectory: path.resolve(repoRoot, args.outputDirectory) }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
