import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { analyzeLocalAecPreAlignmentDiagnostic as analyze, PRE_ALIGNMENT_ADAPTER_LIMITS as LIMIT } from './analyze-local-aec-pre-alignment-diagnostic.mjs';
const RATE=48000, PRE='aec-pre-capture-48k-stereo.f32le', META='aec-frame-metadata.jsonl';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const json=b=>Buffer.from(JSON.stringify(b)+'\n');
const jsonl=rows=>Buffer.from(rows.map((row,i)=>JSON.stringify({...row,sequence:i})).join('\n')+'\n');
function noise(n,seed){let x=seed;return Float32Array.from({length:n},()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return ((x>>>0)/2**32*2-1)*0.4;});}
function pcm(values,channels){const b=Buffer.alloc(values.length*channels*4);for(let i=0;i<values.length;i++)for(let c=0;c<channels;c++)b.writeFloatLE(values[i],(i*channels+c)*4);return b;}
function fixture(t,failed=false){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'local-aec-pre-adapter-'));
 t.after(()=>{assert.ok(path.dirname(root)===path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const endpoint='native-owned-render-endpoint',source=noise(6000,177),linear=noise(6000,211);
 const physical=Float32Array.from(linear,x=>0.8*(x*2.4)/(1+Math.abs(x*2.4)));
 const pre=new Float32Array(8000);
 for(let i=0;i<4800;i++){pre[611+i]+=source[400+i]*0.65;pre[689+i]+=physical[400+i]*0.65;}
 const f={root,source,physical,pre,sourceBytes:pcm(source,1),physicalBytes:pcm(physical,2),preBytes:pcm(pre,2)};
 const write=(name,b)=>fs.writeFileSync(path.join(root,name),b);
 const sourcePath=path.join(root,'native-source.f32le'),physicalPath=path.join(root,'native-physical.f32le');
 const executionId=path.basename(root),start={executionId,physicalDeviceId:endpoint,processId:77,spawnedByNative:true,startedAtMs:10};
 f.sourceReceipt={endpointId:endpoint,processId:77,passed:!failed,mediaPlaybackComplete:true,naturalRenderDrained:true,
  diagnosticOnly:false,renderSampleRateHz:RATE,renderedFrames:6000,postrollSilenceFrames:0,zeroPaddingUnderrunCount:0,
  sourcePcm48kMonoPath:sourcePath,sourceClockValidationPassed:!failed,sourceClockValidationError:failed?'clock rejected':null,
  detail:failed?'clock rejected':null};
 f.complete={receipt:f.sourceReceipt,endpointId:endpoint,processId:77,spawnedByNative:true,providerCalls:0,
  exitCode:failed?1:0,passed:!failed,sourceEvidenceValidationPassed:!failed,sourceEvidenceValidationError:failed?'clock rejected':null,
  mediaPlaybackComplete:true,sourcePcmFormat:'f32le',sourcePcmSampleRateHz:RATE,sourcePcmChannelCount:1,sourcePcmFrames:6000,sourcePcmBytes:24000};
 f.metadata=Array.from({length:20},(_,i)=>({schemaVersion:3,kind:'capture',sequence:i,resetGeneration:0,continuityId:7,
  sampleRateHz:RATE,channelCount:2,preSampleOffset:i*800,preSampleCount:800,
  queueHeadClockValid:true,queueHeadDeviceFrameIndex:50000+i*400,queueHeadQpc100ns:100000+i*83000,
  // Deliberately unrelated packet index: the adapter must map QUEUE HEAD.
  packetDeviceFrameIndex:900000+i*400,timestampError:false,dataDiscontinuity:false}));
 const owner={renderSessionId:12,ownerGeneration:2,rendererInstanceId:'native-renderer',endpointId:endpoint};
 f.events=[{kind:'source-media-started',boundStart:start},...Array.from({length:10},(_,i)=>({kind:'physical-render',...owner,
  physicalStartFrame:10000+i*600,physicalEndFrame:10000+(i+1)*600,sampleRateHz:RATE,channelCount:2,
  referenceStartFrame:i*600,referenceEndFrame:(i+1)*600,nonlinearity:'soft-clip',qpc100ns:99999999})),
  {kind:'source-media-complete',boundReceipt:f.complete}];
 f.probe={schemaVersion:2,artifactKind:'watch-mode-local-aec-probe',scope:'local-aec-speech-simulation',executionId,
  providerCalls:0,recognitionSenderAttached:false,releaseEligible:false,status:failed?'failed':'completed',failure:failed?'clock rejected':null,
  capture:{countsFinal:true,sampleRateHz:RATE,channelCount:2,effectiveDeviceId:endpoint},render:{effectiveDeviceId:endpoint,...owner},
  sourceMediaStarted:start,sourceMediaComplete:f.complete,streamEvidence:{streamStartCount:1}};
 f.seal=()=>{
  write(PRE,f.preBytes);write('native-source.f32le',f.sourceBytes);write('native-physical.f32le',f.physicalBytes);
  f.metadata.forEach((row,i)=>row.sequence=i);const meta=jsonl(f.metadata);write(META,meta);
  const raw=f.sourceReceiptOverride??json(f.sourceReceipt);write('local-aec-source-media-receipt.json',raw);
  f.complete.sha256=sha(raw);f.complete.sourcePcmSha256=sha(f.sourceBytes);
  const physicalRows=f.events.filter(e=>e.kind==='physical-render');
  let cursor=0;for(const row of physicalRows){const count=row.physicalEndFrame-row.physicalStartFrame;row.physicalPcmSha256=sha(f.physicalBytes.subarray(cursor*8,(cursor+count)*8));cursor+=count;}
  f.events.forEach((row,i)=>{row.sequence=i;row.scope='local-aec-speech-simulation';});
  const events=jsonl(f.events);write('native-events.jsonl',events);
  f.probe.streamEvidence.events={path:path.join(root,'native-events.jsonl'),sha256:sha(events),eventCount:f.events.length,flushed:true,synced:true,error:null};
  f.probe.streamEvidence.physical={path:physicalPath,sha256:sha(f.physicalBytes),format:'f32le',sampleRateHz:RATE,channelCount:2,
   frameCount:6000,sampleCount:12000,bytes:48000,flushed:true,synced:true};
  f.terminal={schemaVersion:2,kind:'terminal',status:'complete',complete:true,countsFinal:true,hashAlgorithm:'sha256',terminalFile:'aec-terminal.json',
   errors:[],droppedEvents:0,writtenEvents:f.metadata.length,attemptedEvents:f.metadata.length,acceptedEvents:f.metadata.length,
   lastWrittenSequence:f.metadata.length-1,sampleCounts:{pre:16000},eventCounts:{capture:f.metadata.filter(r=>r.kind==='capture').length,reset:f.metadata.filter(r=>r.kind==='reset').length},
   files:{pre:{name:PRE,sha256:sha(f.preBytes),byteLength:f.preBytes.length,flushed:true,synced:true,unwrittenBufferedBytes:0},
    metadata:{name:META,sha256:sha(meta),byteLength:meta.length,flushed:true,synced:true,unwrittenBufferedBytes:0},
    // Poison/missing post and linear lanes prove neither is read or fitted.
    post:{name:'../must-never-read-post',sha256:'bad'},render:{name:'../must-never-read-linear',sha256:'bad'}}};
  f.writeTerminalProbe();
 };
 f.writeProbe=()=>write('local-aec-probe-result.json',json(f.probe));
 f.writeTerminalProbe=()=>{f.probe.tap=f.terminal;write('aec-terminal.json',json(f.terminal));f.writeProbe();};
 f.landmarks=['source','render'].map(referenceKind=>({id:referenceKind+'-1',referenceKind,referenceStartFrame:400,frameCount:4800,
  preSearch:{fileStartFrame:200,frameCount:6200,range:{minFrame:100,maxFrame:800}},captureDomain:{resetGeneration:0,continuityId:7}}));
 f.run=landmarks=>analyze(root,{landmarks:landmarks??f.landmarks});f.seal();return f;
}
function boundary(r){assert.equal(r.diagnosticOnly,true);assert.equal(r.qualityAcceptance,false);assert.equal(r.aecQualityAcceptance,false);
 assert.equal(r.releaseEligible,false);assert.equal(r.overallPassed,false);assert.equal(r.formalMetrics,null);
 assert.equal(r.providerCalls,0);assert.equal(r.deviceCalls,0);assert.equal(r.nativeClockAccuracyEstablished,false);}
function unknown(r,pattern){boundary(r);assert.equal(r.status,'indeterminate');assert.match(JSON.stringify(r.unknown.length?r.unknown:r.landmarks.map(l=>l.reason)),pattern);}

test('sealed mixed PRE locates native source and ACTUAL transformed physical reference; preserves independent indexes',t=>{
 const f=fixture(t),r=f.run();boundary(r);assert.equal(r.status,'diagnostic-located',JSON.stringify(r.unknown));
 for(const [i,fileFrame] of [[0,611],[1,689]]){const l=r.landmarks[i];boundary(l);assert.equal(l.status,'located',l.reason);
  assert.equal(l.location.preFileFrameIndex,fileFrame);assert.equal(l.location.queueHeadDeviceFrameIndex,50000+fileFrame);
  assert.equal(l.location.segmentOffsetFrames,fileFrame-200);assert.equal(l.preMapping.fileStartFrame,200);
  assert.equal(l.preMapping.blocks[0].metadata.packetDeviceFrameIndex,900000);assert.equal(l.alignment.heldOut.consistent,true);}
 assert.equal(r.landmarks[0].referenceMapping.deviceStartFrame,null);
 assert.equal(r.landmarks[1].referenceMapping.deviceStartFrame,10400);
 assert.equal(r.landmarks[1].referenceMapping.blocks[0].metadata.nonlinearity,'soft-clip');
 assert.equal(r.preTopology.spans.length,1);assert.equal(r.evidence.source.sourceEvidenceValidationPassed,true);
});

test('failed-but-physically-complete original source receipt allowed only for diagnosis, flags never healed',t=>{
 const f=fixture(t,true),before=fs.readFileSync(path.join(f.root,'local-aec-source-media-receipt.json')),r=f.run();
 boundary(r);assert.equal(r.status,'diagnostic-located',JSON.stringify(r.unknown));
 assert.equal(r.evidence.source.exitCode,1);assert.equal(r.evidence.source.passed,false);
 assert.equal(r.evidence.source.sourceClockValidationPassed,false);assert.equal(r.evidence.source.sourceEvidenceValidationPassed,false);
 assert.equal(r.evidence.source.detail,'clock rejected');assert.deepEqual(fs.readFileSync(path.join(f.root,'local-aec-source-media-receipt.json')),before);
});

test('QPC warp is preserved as metadata but never alters the acoustic/pre-file/queue-head location',t=>{
 const f=fixture(t),before=f.run();for(const row of f.metadata)row.queueHeadQpc100ns+=2500000;
 for(const row of f.events)if(row.qpc100ns!==undefined)row.qpc100ns+=2500000;f.seal();const after=f.run();
 assert.equal(after.status,'diagnostic-located');assert.deepEqual(after.landmarks.map(l=>l.location),before.landmarks.map(l=>l.location));
 assert.equal(after.landmarks[0].preMapping.blocks[0].metadata.queueHeadQpc100ns,before.landmarks[0].preMapping.blocks[0].metadata.queueHeadQpc100ns+2500000);
});

for(const [name,file] of [['pre',PRE],['metadata',META],['source PCM','native-source.f32le'],['raw source receipt','local-aec-source-media-receipt.json'],['physical reference','native-physical.f32le'],['stream journal','native-events.jsonl']]){
 test(`negative sealed ${name} SHA`,t=>{const f=fixture(t);const target=path.join(f.root,file),b=fs.readFileSync(target);b[0]^=1;fs.writeFileSync(target,b);unknown(f.run(),/SHA256 mismatch/u);});
}

test('negative physical chunk SHA: sealed linear substitute is not actual physical evidence',t=>{
 const f=fixture(t),event=f.events.find(e=>e.kind==='physical-render');event.physicalPcmSha256='0'.repeat(64);
 const events=jsonl(f.events);fs.writeFileSync(path.join(f.root,'native-events.jsonl'),events);f.probe.streamEvidence.events.sha256=sha(events);f.writeProbe();
 unknown(f.run(),/physical reference chunk\/hash/u);
});

test('device gap is not healed by contiguous appended pre bytes',t=>{
 const f=fixture(t);for(const row of f.metadata.slice(10))row.queueHeadDeviceFrameIndex+=100;f.seal();const r=f.run();
 unknown(r,/pre search crosses domain\/gap/u);assert.equal(r.preTopology.spans.length,2);assert.equal(r.preTopology.gaps[0].nextDeviceStartFrame-r.preTopology.gaps[0].previousDeviceEndFrame,100);
});

test('explicit window after an indexed gap may locate within that single span, without flattening the gap',t=>{
 const f=fixture(t);for(const row of f.metadata.slice(1))row.queueHeadDeviceFrameIndex+=100;f.seal();
 const landmarks=f.landmarks.map(l=>({...l,preSearch:{...l.preSearch,fileStartFrame:400}})),r=f.run(landmarks);
 assert.equal(r.status,'diagnostic-located',JSON.stringify(r.landmarks.map(l=>l.reason)));assert.equal(r.preTopology.spans.length,2);
 assert.equal(r.landmarks[0].location.preFileFrameIndex,611);assert.equal(r.landmarks[0].location.queueHeadDeviceFrameIndex,50711);
});

for(const kind of ['reset','continuity','discontinuity','unknown queue head','file gap'])test(`negative pre ${kind} boundary`,t=>{
 const f=fixture(t);
 if(kind==='reset'){f.metadata.splice(10,0,{schemaVersion:3,kind:'reset',resetGeneration:1,continuityId:8,reason:'native reset'});for(const row of f.metadata.slice(11)){row.resetGeneration=1;row.continuityId=8;}}
 if(kind==='continuity')for(const row of f.metadata.slice(10))row.continuityId=8;
 if(kind==='discontinuity')f.metadata[10].dataDiscontinuity=true;
 if(kind==='unknown queue head')delete f.metadata[10].queueHeadDeviceFrameIndex;
 if(kind==='file gap'){f.metadata[10].preSampleOffset+=2;f.metadata[10].preSampleCount-=2;}
 f.seal();unknown(f.run(),/pre search crosses domain\/gap/u);
});

for(const kind of ['device gap','owner change'])test(`negative physical landmark ${kind}`,t=>{
 const f=fixture(t),physical=f.events.filter(e=>e.kind==='physical-render');
 for(const row of physical.slice(5)){if(kind==='device gap'){row.physicalStartFrame+=100;row.physicalEndFrame+=100;}else row.ownerGeneration++;}
 f.seal();const r=f.run();unknown(r,/physical landmark crosses domain\/gap/u);assert.equal(r.landmarks[0].status,'located');
});

for(const [name,mutate,reason] of [
 ['old tap',f=>{f.terminal.schemaVersion=1;},/old\/incomplete/u],
 ['incomplete tap',f=>{f.terminal.complete=false;},/old\/incomplete/u],
 ['terminal error',f=>{f.terminal.errors=['write error'];},/old\/incomplete/u],
 ['unflushed pre',f=>{f.terminal.files.pre.flushed=false;},/unsealed/u],
 ['foreign endpoint',f=>{f.probe.capture.effectiveDeviceId='other';},/foreign native/u],
 ['old probe',f=>{f.probe.schemaVersion=1;},/foreign native/u],
])test(`negative ${name}`,t=>{const f=fixture(t);mutate(f);f.writeTerminalProbe();unknown(f.run(),reason);});

for(const [name,mutate,pattern] of [
 ['old frame schema',f=>{f.metadata[0].schemaVersion=2;},/metadata schema/u],
 ['foreign source process',f=>{f.sourceReceipt.processId++;},/foreign source/u],
 ['source not physically complete',f=>{f.sourceReceipt.mediaPlaybackComplete=false;},/incomplete\/foreign source/u],
 ['source not drained',f=>{f.sourceReceipt.naturalRenderDrained=false;},/incomplete\/foreign source/u],
 ['old source receipt',f=>{delete f.sourceReceipt.sourceClockValidationPassed;},/incomplete\/foreign source/u],
 ['source rate mismatch',f=>{f.complete.sourcePcmSampleRateHz=44100;},/format\/frame/u],
 ['source path escape',f=>{f.sourceReceipt.sourcePcm48kMonoPath='../outside-source.f32le';},/path escapes/u],
])test(`negative ${name}`,t=>{const f=fixture(t);mutate(f);f.seal();unknown(f.run(),pattern);});

for(const [name,change] of [
 ['linear reference kind',l=>{l.referenceKind='linear';}],['out-of-bounds reference',l=>{l.referenceStartFrame=100000;}],
 ['missing explicit window',l=>{delete l.preSearch;}],['oversized pre window',l=>{l.preSearch.frameCount=500001;}],
 ['wrong capture domain',l=>{l.captureDomain.continuityId=99;}],['negative candidate range',l=>{l.preSearch.range.minFrame=-1;}],
])test(`negative caller ${name}`,t=>{const f=fixture(t),l=structuredClone(f.landmarks[0]);change(l);const r=f.run([l]);boundary(r);assert.equal(r.status,'indeterminate');assert.equal(r.landmarks[0].location,null);});

test('nonfinite/extreme PCM, invalid UTF8 and absolute-root/landmark budgets fail closed',t=>{
 for(const value of [NaN,Infinity,9]){const f=fixture(t);f.preBytes.writeFloatLE(value,0);f.seal();unknown(f.run(),/nonfinite\/extreme/u);}
 const f=fixture(t);f.sourceReceiptOverride=Buffer.from([0xff]);f.seal();unknown(f.run(),/encoded data/u);
 unknown(analyze('relative-root',{landmarks:f.landmarks}),/absolute run root/u);
 unknown(analyze(f.root,{landmarks:[]}),/caller landmarks/u);
 unknown(analyze(f.root,{landmarks:Array.from({length:LIMIT.maxLandmarks+1},(_,i)=>({...f.landmarks[0],id:'id'+i}))}),/caller landmarks/u);
});

test('periodic ambiguity and zero capture never yield a usable location',t=>{
 const f=fixture(t);f.sourceBytes=pcm(Float32Array.from({length:6000},(_,i)=>0.4*Math.sin(2*Math.PI*i/80)),1);
 f.preBytes=pcm(Float32Array.from({length:8000},(_,i)=>0.4*Math.sin(2*Math.PI*(i-611+400)/80)),2);f.seal();
 const periodic=f.run([f.landmarks[0]]);unknown(periodic,/ambiguous-peaks/u);assert.equal(periodic.landmarks[0].alignment.ambiguity.ambiguous,true);
 f.preBytes.fill(0);f.seal();unknown(f.run([f.landmarks[0]]),/silent-capture/u);
});
