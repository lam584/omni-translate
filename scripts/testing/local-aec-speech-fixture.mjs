import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inspectPcm16MonoWav } from './fixtures/wav-fixture-utils.mjs';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function assembleLocalSpeechFixture({ synthesisDirectory, sourceWavPath, outputDirectory }) {
  const synthesis = JSON.parse(fs.readFileSync(path.join(synthesisDirectory, 'synthesis-usage.json'), 'utf8'));
  const plan = JSON.parse(fs.readFileSync(path.join(synthesisDirectory, 'synthesis-plan.json'), 'utf8'));
  if (synthesis.status !== 'completed' || synthesis.translationProviderCalls !== 0
    || synthesis.entries.length !== 6 || synthesis.providerCalls !== 6 || plan.segments.length !== 6
    || synthesis.entries.some(e => e.status !== 'completed')) throw new Error('six newly API-generated, completed Chinese segments are required');
  const {planSha256,...payload}=plan;
  if(hash(Buffer.from(JSON.stringify(payload)))!==planSha256 || synthesis.planSha256!==planSha256)throw Error('synthesis plan identity changed');
  const source=fs.readFileSync(sourceWavPath);const facts=inspectPcm16MonoWav(source);
  if(facts.sampleRate!==24000)throw Error('original English fixture must be 24k mono PCM16');
  const rate=24000,pieces=[],segments=[];let offset=0;
  for (const [i,entry] of synthesis.entries.entries()) {
    if(entry.segmentId!==plan.segments[i].id||entry.inputTextSha256!==plan.segments[i].textSha256
      || !/^zh-[1-6]\.s16le$/u.test(entry.pcmFile)) throw Error('synthesis cue identity/path changed');
    const pcm=fs.readFileSync(path.join(synthesisDirectory,entry.pcmFile));
    if(hash(pcm)!==entry.pcmSha256||pcm.length!==entry.pcmFrames*2||pcm.length%2||entry.sampleRate!==rate
      ||entry.channels!==1||entry.bitsPerSample!==16)throw Error('synthesis PCM changed or wrong format');
    if(i===5){
      // Represent a delayed final model cue, NOT closed or muted capture. Feed
      // these explicit silence samples through the same continuous render stream.
      const target=Math.ceil((facts.durationSeconds+2)*rate/2400)*2400;
      if(offset<target){const frames=target-offset;pieces.push(Buffer.alloc(frames*2));segments.push({kind:'explicit-model-output-pause',startFrame:offset,endFrame:target,frames});offset=target;}
    }
    pieces.push(pcm);segments.push({kind:'speech',cueId:entry.segmentId,startFrame:offset,endFrame:offset+pcm.length/2,
      originalPcmSha256:entry.pcmSha256,textSha256:entry.inputTextSha256,sourceFrameCount:pcm.length/2});offset+=pcm.length/2;
  }
  if(offset/rate>=170)throw Error('fixture leaves insufficient room inside the unchanged 180s input watchdog');
  if(offset%2400){const frames=2400-offset%2400;pieces.push(Buffer.alloc(frames*2));segments.push({kind:'chunk-alignment-tail-silence',startFrame:offset,endFrame:offset+frames,frames});offset+=frames;}
  const pcm=Buffer.concat(pieces);
  fs.mkdirSync(outputDirectory,{recursive:false});
  fs.writeFileSync(path.join(outputDirectory,'source.wav'),source,{flag:'wx'});
  fs.writeFileSync(path.join(outputDirectory,'translation-stream.s16le'),pcm,{flag:'wx'});
  const receipt={schemaVersion:1,artifactKind:'local-aec-api-speech-fixture',scope:'local-aec-speech-simulation',releaseEligible:false,
    sampleRateHz:rate,channelCount:1,bitsPerSample:16,synthesisModel:plan.model,synthesisVoice:plan.voice,
    synthesisPlanSha256:planSha256,synthesisUsageSha256:hash(fs.readFileSync(path.join(synthesisDirectory,'synthesis-usage.json'))),
    englishSource:{file:'source.wav',sha256:hash(source),durationSeconds:facts.durationSeconds},
    translation:{file:'translation-stream.s16le',sha256:hash(pcm),frames:offset,durationSeconds:offset/rate},
    segments,chunkFrames:2400,chunkIntervalMs:100,noSpeechTrimmed:true,noLocalTts:true,noTranslationLlmCalls:true,
    thresholds:{echoAttenuationDb:20,sourceGainToleranceDb:3,sourceCoverage:.95},generatedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(outputDirectory,'fixture.json'),JSON.stringify(receipt,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  return receipt;
}
