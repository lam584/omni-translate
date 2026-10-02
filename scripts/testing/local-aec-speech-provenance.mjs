import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSpeechSynthesisPlan, extract24kMonoPcm } from './generate-local-aec-speech-fixture.mjs';
import { normalizeStreamingWavHeader, inspectPcm16MonoWav } from './fixtures/wav-fixture-utils.mjs';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const check = (ok, why) => { if (!ok) throw Error(`API speech provenance: ${why}`); };
function read(root, name, limit = 16 * 1024 * 1024) {
  check(path.basename(name) === name, 'untrusted evidence path');
  const file = path.join(root, name), stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit
    && fs.realpathSync.native(file) === file, 'unsafe/empty evidence file');
  return fs.readFileSync(file);
}
/** Verifies the recorded API calls and exact returned bytes; not a vendor signature. */
export function verifyApiSpeechProvenance({ fixture, renderBytes, synthesisDirectory, expectedUsageSha256, expectedPlanFileSha256 }) {
  const root = path.resolve(synthesisDirectory);
  check(fs.realpathSync.native(root) === root && !fs.lstatSync(root).isSymbolicLink(), 'redirected generation root');
  check([expectedUsageSha256, expectedPlanFileSha256].every(h => /^[a-f0-9]{64}$/u.test(h)), 'explicit campaign generation hashes required');
  const usageBytes = read(root, 'synthesis-usage.json', 1024 * 1024), planBytes = read(root, 'synthesis-plan.json', 1024 * 1024);
  check(sha(usageBytes) === expectedUsageSha256 && sha(planBytes) === expectedPlanFileSha256
    && fixture.synthesisUsageSha256 === expectedUsageSha256, 'campaign generation identity mismatch');
  const usage = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(usageBytes));
  const plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(planBytes));
  const { planSha256, ...payload } = plan;
  check(sha(Buffer.from(JSON.stringify(payload))) === planSha256 && usage.planSha256 === planSha256
    && fixture.synthesisPlanSha256 === planSha256, 'plan digest mismatch');
  const expectedPlan = createSpeechSynthesisPlan(plan.segments.map(s => s.text).join('\n\n'));
  const { textSha256: _expectedText, planSha256: _expectedDigest, ...expectedFields } = expectedPlan;
  const { textSha256: rawTextSha256, planSha256: _actualDigest, ...actualFields } = plan;
  check(/^[a-f0-9]{64}$/u.test(rawTextSha256) && JSON.stringify(expectedFields) === JSON.stringify(actualFields),
    'model/voice/text/budget plan differs from generator');
  check(usage.schemaVersion === 1 && usage.artifactKind === 'local-aec-speech-synthesis-usage'
    && usage.provider === 'dashscope' && usage.model === plan.model && usage.status === 'completed'
    && usage.providerCalls === 6 && usage.translationProviderCalls === 0 && usage.automaticRetries === 0
    && usage.entries?.length === 6 && plan.segments.length === 6, 'six completed API calls not recorded');
  check(sha(renderBytes) === fixture.translation.sha256 && renderBytes.length === fixture.translation.frames * 2, 'assembled PCM identity');
  let coveredFrames = 0;
  for (const segment of fixture.segments) {
    check(Number.isSafeInteger(segment.startFrame) && Number.isSafeInteger(segment.endFrame)
      && segment.startFrame === coveredFrames && segment.endFrame > segment.startFrame
      && segment.endFrame <= fixture.translation.frames
      && ['speech', 'explicit-model-output-pause', 'chunk-alignment-tail-silence'].includes(segment.kind),
    'segment map gap/overlap/invalid range');
    if (segment.kind !== 'speech') check(segment.frames === segment.endFrame - segment.startFrame, 'silence span accounting');
    coveredFrames = segment.endFrame;
  }
  check(coveredFrames === fixture.translation.frames, 'segment map omits final PCM');
  const speech = fixture.segments.filter(s => s.kind === 'speech'), requestIds = new Set(), files = [];
  check(speech.length === 6, 'complete six-cue mapping required');
  let previousEnd = 0, previousCompleted = 0;
  for (const [i, e] of usage.entries.entries()) {
    const p = plan.segments[i], s = speech[i];
    const start = Date.parse(e.dispatchedAt), end = Date.parse(e.completedAt);
    check(e.status === 'completed' && e.httpStatus === 200 && Number.isFinite(start) && Number.isFinite(end)
      && end >= start && start >= previousCompleted && end <= Date.parse(fixture.generatedAt)
      && /^[a-f0-9-]{36}$/iu.test(e.responseRequestId ?? '') && !requestIds.has(e.responseRequestId), 'API response/time identity');
    requestIds.add(e.responseRequestId); previousCompleted = end;
    check(e.segmentId === p.id && s.cueId === p.id && e.inputTextSha256 === p.textSha256
      && s.textSha256 === p.textSha256 && e.requestedCharacters === p.characters, 'cue/text attribution');
    check(e.originalAudioFile === `${p.id}.api-audio.bin` && e.wavFile === `${p.id}.wav` && e.pcmFile === `${p.id}.s16le`, 'cue artifact path');
    const original = read(root, e.originalAudioFile), wav = read(root, e.wavFile), pcm = read(root, e.pcmFile);
    check(sha(original) === e.originalAudioSha256 && original.length === e.originalAudioBytes
      && sha(wav) === e.wavSha256 && sha(pcm) === e.pcmSha256, 'raw API artifact changed');
    check(normalizeStreamingWavHeader(Buffer.from(original)).equals(wav), 'API-to-WAV derivation mismatch');
    const facts = inspectPcm16MonoWav(wav);
    const extracted = extract24kMonoPcm(wav);
    check(facts.sampleRate === 24000 && extracted.length / 2 === e.pcmFrames && facts.channels === 1
      && facts.bitsPerSample === 16 && extracted.equals(pcm), 'WAV-to-PCM derivation mismatch');
    check(s.originalPcmSha256 === e.pcmSha256 && s.sourceFrameCount === extracted.length / 2
      && s.endFrame - s.startFrame === extracted.length / 2 && s.startFrame >= previousEnd
      && renderBytes.subarray(s.startFrame * 2, s.endFrame * 2).equals(pcm), 'full generated cue not preserved');
    previousEnd = s.endFrame;
    for (const [file, bytes] of [[e.originalAudioFile, original], [e.wavFile, wav], [e.pcmFile, pcm]]) files.push({ path: path.join(root, file), sha256: sha(bytes) });
  }
  check(usage.requestedCharacters === plan.maximumCharacters, 'character usage mismatch');
  for (const s of fixture.segments.filter(s => s.kind !== 'speech')) {
    check(['explicit-model-output-pause', 'chunk-alignment-tail-silence'].includes(s.kind)
      && renderBytes.subarray(s.startFrame * 2, s.endFrame * 2).every(b => b === 0), 'non-cue PCM is not explicit silence');
  }
  return { schemaVersion: 1, complete: true, claim: 'recorded-api-calls-and-returned-audio-custody', vendorAttestation: false,
    synthesisDirectory: root, planFileSha256: expectedPlanFileSha256, usageSha256: expectedUsageSha256,
    synthesisRequests: 6, translationProviderCalls: 0, requestIds: [...requestIds], files };
}
