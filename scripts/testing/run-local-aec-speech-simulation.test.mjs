import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createLocalSpeechRequest,inspectSpeechOperation,parseLocalSpeechArgs,finalizeSpeechOutcome,LOCAL_SPEECH_BUDGETS,localSpeechJobDeadline,collectLocalSpeechRunEvidence} from './run-local-aec-speech-simulation.mjs';
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
 streamEvidence:{streamStartCount:1,streamDrained:true,aborted:false,mediaEndVoicedPhysicalFrames:96000},sourceMediaComplete:{passed:true,endpointId:endpoint,mediaPlaybackComplete:true,
 sourceEvidenceValidationPassed:true,sourceEvidenceValidationError:null,exitCode:0,
 receipt:{passed:true,mediaPlaybackComplete:true,naturalRenderDrained:true,sourceClockValidationPassed:true,
 sourceClockValidationError:null,detail:null,diagnosticOnly:false}}});
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
 const source=fs.readFileSync(new URL('./run-local-aec-speech-simulation.mjs',import.meta.url),'utf8');assert.match(source,/timeout:LOCAL_SPEECH_BUDGETS\.outerMs,maxBuffer:4\*1024\*1024,env:windowsPowerShellEnvironment\(\)/u);
});

test("native input budget stays 180s and cleanup remains within the original 195s outer cap",()=>{
 const now=Date.UTC(2026,9,2);
 assert.equal(LOCAL_SPEECH_BUDGETS.inputMs,180000);
 assert.equal(LOCAL_SPEECH_BUDGETS.outerMs,195000);
 assert.equal(Date.parse(localSpeechJobDeadline(now))-now,190000);
 assert.equal(LOCAL_SPEECH_BUDGETS.outerMs-LOCAL_SPEECH_BUDGETS.ownedJobMs,5000);
 assert.equal(request().speechSimulation.deadlineMs,180000);
 assert.equal(Object.isFrozen(LOCAL_SPEECH_BUDGETS),true);
 for(const invalid of [-1,0.5,NaN,Infinity,8640000000000000])assert.throws(()=>localSpeechJobDeadline(invalid),/launch time/u);
});

const acceptedQuality=()=>({passed:true,status:'passed',scope:'local-aec-speech-simulation',providerCalls:0,
 releaseEligible:false,modelInputLeakageVerified:false,semanticLeakageChainVerified:false});
function retainedRun(t,nativeProbe=probe()){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aec-speech-retained-run-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const original=Buffer.from(JSON.stringify(nativeProbe)+'\n');
 fs.writeFileSync(path.join(root,'local-aec-probe-result.json'),original);
 return {root,original,request:{...request(),outputDirectory:root}};
}
const launch=(patch={})=>({status:0,signal:null,stdout:JSON.stringify({ownedJobExited:true,exitCode:0,stdout:'native output',stderr:''})+'\n',stderr:'',...patch});
function failedClockProbe(){
 const p=probe();
 p.status='failed';p.failure='source alignment evidence rejected after complete collection';
 p.sourceMediaComplete={...p.sourceMediaComplete,passed:false,mediaPlaybackComplete:true,
  sourceEvidenceValidationPassed:false,sourceEvidenceValidationError:'source IAudioClock drift/false onset',exitCode:1,
  receipt:{passed:false,mediaPlaybackComplete:true,naturalRenderDrained:true,diagnosticOnly:false,
   sourceClockValidationPassed:false,sourceClockValidationError:'source IAudioClock drift/false onset',
   detail:'source IAudioClock drift/false onset',renderedFrames:144000,zeroPaddingUnderrunCount:0}};
 return p;
}
test('launcher exit1 retains exact failed custody, raw source/probe/clock/PCM evidence and never promotes failure',t=>{
 const native=failedClockProbe(),f=retainedRun(t,native);
 const rawSource=Buffer.from(JSON.stringify(native.sourceMediaComplete.receipt)+'\n');
 const rawClock=Buffer.from('{"rawClockHresult":1,"diagnosticOnly":true}\n');
 const rawPcm=Buffer.from([0,1,2,3,4,5,6,7]);
 fs.writeFileSync(path.join(f.root,'local-aec-source-media-receipt.json'),rawSource);
 fs.writeFileSync(path.join(f.root,'aec-source-playback-clock.raw.jsonl'),rawClock);
 fs.writeFileSync(path.join(f.root,'aec-pre.pcm'),rawPcm);
 const originalCustody={ownedJobExited:true,exitCode:1,stdout:'failed native output',stderr:'clock rejected'};
 const r=launch({status:1,stdout:'launcher preamble\n'+JSON.stringify(originalCustody)+'\n',stderr:'launcher exit1'});
 const result=collectLocalSpeechRunEvidence(f.root,f.request,r);
 assert.equal(result.readyForAnalysis,false);assert.equal(result.overallPassed,false);assert.equal(result.releaseEligible,false);
 assert.equal(result.launcher.exitCode,1);assert.equal(result.launcher.passed,false);
 assert.deepEqual(result.custody,originalCustody);assert.equal(result.custodyValidation.passed,false);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'process-custody.json'),'utf8')),originalCustody);
 assert.equal(fs.readFileSync(path.join(f.root,'launcher.stdout.log'),'utf8'),r.stdout);
 assert.equal(fs.readFileSync(path.join(f.root,'launcher.stderr.log'),'utf8'),r.stderr);
 assert.deepEqual(fs.readFileSync(path.join(f.root,'local-aec-probe-result.json')),f.original);
 assert.deepEqual(fs.readFileSync(path.join(f.root,'local-aec-source-media-receipt.json')),rawSource);
 assert.deepEqual(fs.readFileSync(path.join(f.root,'aec-source-playback-clock.raw.jsonl')),rawClock);
 assert.deepEqual(fs.readFileSync(path.join(f.root,'aec-pre.pcm')),rawPcm);
 assert.deepEqual(result.nativeReceipt,native);
 assert.equal(result.operation.passed,false);
 assert.ok(result.failures.some(f=>f.area==='launcher'));
 assert.ok(result.failures.some(f=>f.area==='native-operation'&&/source clock/u.test(f.detail)));
 const sealed=JSON.parse(fs.readFileSync(path.join(f.root,'local-speech-evidence-collection.json'),'utf8'));
 assert.equal(sealed.overallPassed,false);assert.equal(sealed.readyForAnalysis,false);assert.equal(sealed.nativeReceiptRetained,true);
 assert.equal(finalizeSpeechOutcome(result.operation,{passed:true},acceptedQuality(),result).overallPassed,false);
 // Even pretending the operation/metrics passed cannot erase launcher/custody failure.
 assert.equal(finalizeSpeechOutcome({passed:true},{passed:true},acceptedQuality(),result).overallPassed,false);
});

test('launcher failure with apparently healthy custody/probe still cannot authorize analyzer or acceptance',t=>{
 const f=retainedRun(t),result=collectLocalSpeechRunEvidence(f.root,f.request,launch({status:1}));
 assert.equal(result.custody.exitCode,0);assert.equal(result.operation.passed,true);
 assert.equal(result.custodyValidation.passed,false);assert.equal(result.readyForAnalysis,false);
 assert.equal(finalizeSpeechOutcome(result.operation,{passed:true},acceptedQuality(),result).overallPassed,false);
});

test('successful launcher cannot hide failed native job custody or source clock evidence',t=>{
 const f=retainedRun(t,failedClockProbe());
 const result=collectLocalSpeechRunEvidence(f.root,f.request,launch({stdout:JSON.stringify({ownedJobExited:true,exitCode:1})}));
 assert.equal(result.launcher.passed,true);assert.equal(result.custodyValidation.passed,false);
 assert.equal(result.operation.passed,false);assert.equal(result.readyForAnalysis,false);
 assert.equal(finalizeSpeechOutcome(result.operation,{passed:true},acceptedQuality(),result).overallPassed,false);
});

for(const [name,patch] of [
 ['timeout',{status:null,signal:'SIGTERM',error:Object.assign(new Error('spawn ETIMEDOUT'),{code:'ETIMEDOUT'})}],
 ['signal',{status:0,signal:'SIGTERM'}],
 ['missing stdout',{stdout:''}],
 ['malformed custody',{stdout:'not custody json'}],
 ['array custody',{stdout:'[]'}],
 ['null custody',{stdout:'null'}],
 ['missing owned job proof',{stdout:'{}'}],
 ['oversized custody',{stdout:JSON.stringify({padding:'a'.repeat(1024*1024)})}],
])test(`retain native probe independently of ${name}, fail closed`,t=>{
 const f=retainedRun(t),result=collectLocalSpeechRunEvidence(f.root,f.request,launch(patch));
 assert.equal(result.nativeReceiptRetained,true);assert.deepEqual(result.nativeReceipt,probe());
 assert.equal(result.readyForAnalysis,false);assert.equal(result.overallPassed,false);
 assert.ok(result.failures.length>0);
 assert.deepEqual(fs.readFileSync(path.join(f.root,'local-aec-probe-result.json')),f.original);
 assert.equal(finalizeSpeechOutcome({passed:true},{passed:true},acceptedQuality(),result).overallPassed,false);
});

test('missing or malformed native probe preserves custody without fabricating a receipt',t=>{
 for(const contents of [undefined,'{broken','null','[]']){
  const f=retainedRun(t);
  if(contents===undefined)fs.unlinkSync(path.join(f.root,'local-aec-probe-result.json'));
  else fs.writeFileSync(path.join(f.root,'local-aec-probe-result.json'),contents,'utf8');
  const result=collectLocalSpeechRunEvidence(f.root,f.request,launch());
  assert.equal(result.custody.exitCode,0);assert.equal(result.readyForAnalysis,false);
  assert.equal(result.overallPassed,false);
  if(contents!==undefined)assert.equal(fs.readFileSync(path.join(f.root,'local-aec-probe-result.json'),'utf8'),contents);
  assert.equal(finalizeSpeechOutcome({passed:true},{passed:true},acceptedQuality(),result).overallPassed,false);
 }
});

test('successful collection retains all strict gates and is not by itself acceptance',t=>{
 const f=retainedRun(t),result=collectLocalSpeechRunEvidence(f.root,f.request,launch());
 assert.equal(result.readyForAnalysis,true);assert.equal(result.custodyValidation.passed,true);
 assert.equal(result.overallPassed,false);assert.equal(result.releaseEligible,false);
 assert.equal(finalizeSpeechOutcome(result.operation,{passed:true},undefined,result).overallPassed,false);
 assert.equal(finalizeSpeechOutcome(result.operation,{passed:true},acceptedQuality(),result).overallPassed,true);
 for(const quality of [{...acceptedQuality(),passed:false},{...acceptedQuality(),providerCalls:1},
  {...acceptedQuality(),status:'indeterminate'},{...acceptedQuality(),releaseEligible:true}]){
  assert.equal(finalizeSpeechOutcome(result.operation,{passed:true},quality,result).overallPassed,false);
 }
});

test('evidence write collision preserves existing bytes and blocks acceptance rather than overwriting custody',t=>{
 const f=retainedRun(t),existing='preexisting custody: do not overwrite';
 fs.writeFileSync(path.join(f.root,'process-custody.json'),existing,'utf8');
 const result=collectLocalSpeechRunEvidence(f.root,f.request,launch());
 assert.equal(result.readyForAnalysis,false);
 assert.equal(fs.readFileSync(path.join(f.root,'process-custody.json'),'utf8'),existing);
 assert.equal(result.nativeReceiptRetained,true);
 assert.ok(result.failures.some(f=>f.area==='process-custody'));
});

for(const [name,mutate] of [
 ['bound rejection',s=>{s.sourceEvidenceValidationPassed=false;}],
 ['bound rejection error',s=>{s.sourceEvidenceValidationError='clock rejected';}],
 ['injector exit1',s=>{s.exitCode=1;}],
 ['nested failed receipt',s=>{s.receipt.passed=false;}],
 ['nested clock rejection',s=>{s.receipt.sourceClockValidationPassed=false;}],
 ['nested clock error',s=>{s.receipt.sourceClockValidationError='clock rejected';}],
 ['retained failure detail',s=>{s.receipt.detail='clock rejected';}],
 ['diagnostic-only receipt',s=>{s.receipt.diagnosticOnly=true;}],
 ['untyped clock status',s=>{s.receipt.sourceClockValidationPassed='true';}],
])test(`physically complete/drained with ${name} cannot satisfy formal operation/final gates`,()=>{
 const p=probe();
 p.sourceMediaComplete={...p.sourceMediaComplete,mediaPlaybackComplete:true,sourceEvidenceValidationPassed:true,
  sourceEvidenceValidationError:null,exitCode:0,receipt:{passed:true,mediaPlaybackComplete:true,naturalRenderDrained:true,
   sourceClockValidationPassed:true,sourceClockValidationError:null,detail:null,diagnosticOnly:false}};
 mutate(p.sourceMediaComplete);
 const operation=inspectSpeechOperation(p,request());
 assert.equal(p.status,'completed');assert.equal(p.sourceMediaComplete.passed,true);
 assert.equal(p.sourceMediaComplete.mediaPlaybackComplete,true);
 assert.equal(p.sourceMediaComplete.receipt.naturalRenderDrained,true);
 assert.equal(operation.passed,false);
 assert.match(operation.failures.join(';'),/source clock evidence/u);
 assert.equal(finalizeSpeechOutcome(operation,{passed:true},acceptedQuality()).overallPassed,false);
});

test('healthy launcher and custody cannot promote fully collected failed native operation',t=>{
 const f=retainedRun(t,failedClockProbe()),result=collectLocalSpeechRunEvidence(f.root,f.request,launch());
 assert.equal(result.launcher.passed,true);assert.equal(result.custodyValidation.passed,true);
 assert.equal(result.nativeReceipt.sourceMediaComplete.mediaPlaybackComplete,true);
 assert.equal(result.operation.passed,false);assert.equal(result.readyForAnalysis,false);
 assert.equal(finalizeSpeechOutcome({passed:true},{passed:true},acceptedQuality(),result).overallPassed,false);
});

test('failure to persist collection summary blocks acceptance and retains preexisting summary',t=>{
 const f=retainedRun(t),existing='preexisting collection summary';
 fs.writeFileSync(path.join(f.root,'local-speech-evidence-collection.json'),existing,'utf8');
 const result=collectLocalSpeechRunEvidence(f.root,f.request,launch());
 assert.equal(result.launcher.passed,true);assert.equal(result.custodyValidation.passed,true);
 assert.equal(result.operation.passed,true);assert.equal(result.readyForAnalysis,false);
 assert.ok(result.failures.some(f=>f.area==='collection-summary'));
 assert.equal(fs.readFileSync(path.join(f.root,'local-speech-evidence-collection.json'),'utf8'),existing);
 assert.equal(finalizeSpeechOutcome(result.operation,{passed:true},acceptedQuality(),result).overallPassed,false);
});

for(const field of ['mediaPlaybackComplete','sourceEvidenceValidationPassed','sourceEvidenceValidationError','exitCode','receipt'])
 test('old report missing typed source '+field+' cannot pass new collection',()=>{
  const p=probe();delete p.sourceMediaComplete[field];
  assert.equal(inspectSpeechOperation(p,request()).passed,false);
 });
for(const field of ['passed','mediaPlaybackComplete','naturalRenderDrained','sourceClockValidationPassed','sourceClockValidationError','detail','diagnosticOnly'])
 test('source receipt missing typed '+field+' cannot pass new collection',()=>{
  const p=probe();delete p.sourceMediaComplete.receipt[field];
  assert.equal(inspectSpeechOperation(p,request()).passed,false);
 });
