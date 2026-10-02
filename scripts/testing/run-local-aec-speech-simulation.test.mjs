import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createLocalSpeechRequest,inspectSpeechOperation,parseLocalSpeechArgs,finalizeSpeechOutcome} from './run-local-aec-speech-simulation.mjs';
import {assembleLocalSpeechFixture} from './local-aec-speech-fixture.mjs';
import {createSpeechSynthesisPlan} from './generate-local-aec-speech-fixture.mjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const endpoint='{0.0.0.00000000}.{ff6138b0-3914-409e-90cd-04f03dbba46e}';
const executionId='local-aec-speech-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const request=()=>createLocalSpeechRequest({executionId,outputDirectory:path.resolve('artifacts',executionId),physicalDeviceId:endpoint,
 renderPcmPath:path.resolve('p.pcm'),renderPcmSha256:'1'.repeat(64),injectorExecutable:path.resolve('injector.exe'),injectorExecutableSha256:'2'.repeat(64),
 sourceWavPath:path.resolve('source.wav'),sourceWavSha256:'3'.repeat(64),tailStartFrame:3069600});
const probe=()=>({schemaVersion:2,executionId,scope:'local-aec-speech-simulation',providerCalls:0,recognitionSenderAttached:false,releaseEligible:false,status:'completed',
 capture:{effectiveDeviceId:endpoint,countsFinal:true,framesCaptured:9000000,lastError:null,lastErrorCode:null},render:{effectiveDeviceId:endpoint},
 captureDrain:{captureRemainedOpen:true,continuousQuietMs:2000,quietStartFrame:100,quietEndFrame:96100},
 streamEvidence:{streamStartCount:1,streamDrained:true,aborted:false,mediaEndVoicedPhysicalFrames:96000},sourceMediaComplete:{passed:true,endpointId:endpoint}});
test('schema2 request pins single local scenario cadence, three phases and original watchdog',()=>{
 const r=request();assert.equal(r.schemaVersion,2);assert.equal(r.speechSimulation.deadlineMs,180000);assert.equal(r.speechSimulation.stageDurationMs,40000);
 assert.equal(r.speechSimulation.chunkFrames,2400);assert.equal(r.speechSimulation.chunkIntervalMs,100);
});
test('reject automatic endpoint, unaligned tail and changed hash',()=>{
 const r=request();assert.throws(()=>createLocalSpeechRequest({...r,...r.speechSimulation,physicalDeviceId:'default'}),/endpoint/);
 assert.throws(()=>createLocalSpeechRequest({...r,...r.speechSimulation,tailStartFrame:3069601}),/tail/);
 assert.throws(()=>createLocalSpeechRequest({...r,...r.speechSimulation,renderPcmSha256:'wrong'}),/hash/);
});
test('operation completion never grants release/quality acceptance',()=>{
 const r=inspectSpeechOperation(probe(),request());assert.equal(r.passed,true);assert.equal(r.releaseEligible,false);assert.equal(r.scope,'local-aec-speech-simulation');
 assert.equal(r.qualityPassed,undefined);
});
for(const [name,change] of [
 ['old pure-echo receipt',p=>{p.schemaVersion=1;p.scope='pure-echo';}],
 ['capture closed at media completion',p=>{p.captureDrain.captureRemainedOpen=false;}],
 ['fake quiet snapshot',p=>{p.captureDrain.quietEndFrame=101;}],
 ['missing actually played final voice',p=>{p.streamEvidence.mediaEndVoicedPhysicalFrames=0;}],
 ['reopened endpoint per chunk',p=>{p.streamEvidence.streamStartCount=100;}],
 ['hidden provider invocation',p=>{p.providerCalls=1;}],
 ['wrong endpoint',p=>{p.capture.effectiveDeviceId='other';}],
 ['failed PCM evidence seal',p=>{p.streamEvidenceSealError='write failed';}],
 ['watchdog fake-success cleanup',p=>{p.cleanupError='deadline exceeded';}]
])test(`reject ${name}`,()=>{const p=probe();change(p);assert.equal(inspectSpeechOperation(p,request()).passed,false);});
test('unknown CLI flags cannot widen thresholds or impersonate remote worker',()=>{
 assert.throws(()=>parseLocalSpeechArgs(['--worker-id','vm131']),/Unknown/);assert.throws(()=>parseLocalSpeechArgs(['--echo-attenuation-db','5']),/Unknown/);
});
function syntheticWav(){const b=Buffer.alloc(44+24000*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(48000,40);return b;}
function assets(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'aec-speech-fixture-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=path.join(root,'source.wav');fs.writeFileSync(source,syntheticWav());const synthesis=path.join(root,'api');fs.mkdirSync(synthesis);const plan=createSpeechSynthesisPlan(Array.from({length:6},(_,i)=>`paragraph ${i+1}`).join('\n\n'));const entries=plan.segments.map((s,i)=>{const pcm=Buffer.alloc(48000);for(let j=0;j<24000;j++)pcm.writeInt16LE((i+1)*100,j*2);const file=s.id+'.s16le';fs.writeFileSync(path.join(synthesis,file),pcm);return {segmentId:s.id,inputTextSha256:s.textSha256,status:'completed',pcmFile:file,pcmSha256:sha(pcm),pcmFrames:24000,sampleRate:24000,channels:1,bitsPerSample:16};});fs.writeFileSync(path.join(synthesis,'synthesis-plan.json'),JSON.stringify(plan));fs.writeFileSync(path.join(synthesis,'synthesis-usage.json'),JSON.stringify({status:'completed',translationProviderCalls:0,providerCalls:6,planSha256:plan.planSha256,entries}));return {root,source,synthesis,entries};}
test('assembler preserves each complete API speech segment and only adds explicit silence',t=>{
 const a=assets(t),out=path.join(a.root,'assembled');const r=assembleLocalSpeechFixture({synthesisDirectory:a.synthesis,sourceWavPath:a.source,outputDirectory:out});
 const pcm=fs.readFileSync(path.join(out,r.translation.file));assert.equal(r.translation.frames%2400,0);assert.equal(r.noSpeechTrimmed,true);assert.equal(r.noLocalTts,true);
 const speech=r.segments.filter(s=>s.kind==='speech');assert.equal(speech.length,6);for(let i=0;i<6;i++){assert.deepEqual(pcm.subarray(speech[i].startFrame*2,speech[i].endFrame*2),fs.readFileSync(path.join(a.synthesis,a.entries[i].pcmFile)));}
 assert.deepEqual(fs.readFileSync(path.join(out,'source.wav')),fs.readFileSync(a.source));
});
test('assembler refuses altered PCM and incomplete synthesis without dropping a cue',t=>{
 const a=assets(t);fs.appendFileSync(path.join(a.synthesis,a.entries[5].pcmFile),Buffer.from([1,2]));assert.throws(()=>assembleLocalSpeechFixture({synthesisDirectory:a.synthesis,sourceWavPath:a.source,outputDirectory:path.join(a.root,'bad')}),/PCM changed/);
});

test('final outcome requires independent quality and cannot claim a Provider or release pass',()=>{
 const quality={passed:true,status:'passed',scope:'local-aec-speech-simulation',providerCalls:0,releaseEligible:false,modelInputLeakageVerified:false,semanticLeakageChainVerified:false};
 const result=finalizeSpeechOutcome({passed:true},{passed:true},quality);assert.equal(result.overallPassed,true);assert.equal(result.releaseEligible,false);
 assert.equal(result.realTranslationLifecycleVerified,false);
 for(const patch of [{passed:false},{status:'indeterminate'},{scope:'pure-echo'},{releaseEligible:true},{providerCalls:1},{modelInputLeakageVerified:true},{semanticLeakageChainVerified:true}])
  assert.equal(finalizeSpeechOutcome({passed:true},{passed:true},{...quality,...patch}).overallPassed,false);
 assert.equal(finalizeSpeechOutcome({passed:true},{passed:true},undefined).overallPassed,false);
});

test('actual Windows PowerShell 5.1 boundary restores builtin hashing under a foreign PS7 module path', {skip:process.platform!=='win32'}, async()=>{
 const {spawnSync}=await import('node:child_process');const {windowsPowerShellEnvironment}=await import('./run-watch-mode-live-production-coordinator.mjs');
 const environment=windowsPowerShellEnvironment({...process.env,PSModulePath:'Z:\\nonexistent-ps7-modules'});
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';(Get-FileHash -LiteralPath 'package.json' -Algorithm SHA256).Hash"],{cwd:process.cwd(),encoding:'utf8',windowsHide:true,timeout:10000,env:environment});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim().toLowerCase(),sha(fs.readFileSync('package.json')));
 const source=fs.readFileSync(new URL('./run-local-aec-speech-simulation.mjs',import.meta.url),'utf8');assert.match(source,/timeout:195000,maxBuffer:4\*1024\*1024,env:windowsPowerShellEnvironment\(\)/u);
});
