import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateDefinition,DEFINITION_PATH,THRESHOLDS,pcm16,readPcm16Wav,linear24to48,monoFrameToStereo,softclip,floatBytes,readFloats,floatWav,
  synthesizeCase,makeSegments,verifyFixtureBytes,sha256,summarizeWindow,convergence,summarizeBackend,curvesSvg,markdownReport,cli,validateResults,validateOutputArtifacts,floatWavPayload,listeningHtml,ARTIFACT_ROOT} from './aec-production-offline-benchmark.mjs';
const def=()=>JSON.parse(fs.readFileSync(DEFINITION_PATH,'utf8').replace(/^\uFEFF/,''));
const clone=x=>structuredClone(x);
function wav(a){const b=Buffer.alloc(44+a.length*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(a.length*2,40);a.forEach((n,i)=>b.writeInt16LE(n,44+i*2));return b;}
function miniature(){const d=def();d.sourceEndSample=64;d.renderEndSample=128;d.totalSamples=1200;d.wrongReferenceShiftSamples=34;d.convergence={...d.convergence,startupSamples:16,changeWindowSamples:20};return d;}
function refs(d){return {en:Float32Array.from({length:d.sourceEndSample},(_,i)=>Math.sin(i*.7)*.03),zh:Float32Array.from({length:d.renderEndSample},(_,i)=>Math.sin(i*.3)*.2)};}
function window(i=0,{source=true,echo=true,valid=true,gain=0,coverage=.99,upper=.001,residue=0}={}){
  const core={startSample:i*4800,sampleCount:4800,sourceActive:source,echoActive:echo,valid,passed:true,sourceGainDb:source?gain:null};
  const raw={startSample:i*4800,sampleCount:4800,preEchoEnergy:echo?1:0,postCoherentEchoEnergy:echo?upper-residue:0,postUnexplainedEnergy:residue,
    postEchoUpperEnergy:upper,preSourceEnergy:source?1:0,postCoherentSourceEnergy:source?1:0,sourceWindowCoverage:source?coverage:null,
    activeSourceSamples:source?4800:0,echoUpperExactlyZero:echo&&upper===0,postRms:.05,sourceRawErrorEnergy:.02,sourceRawErrorRms:.01};return {core,raw};
}
function nativeFixture(options={}){const count=options.count??12,windows=[],diags=[];for(let i=0;i<count;i++){const w=window(i,options);windows.push(w.core);diags.push(w.raw);}
  const c={id:'double-talk',sourceEnabled:true,renderEnabled:true,negativeControl:false,sampleCount:count*4800,sourceEndSample:count*4800,renderEndSample:count*4800,
    phases:[{startSample:0,delaySamples:0,nonlinear:false}],segments:[{name:'full',startSample:0,endSample:count*4800}]};
  const b={id:'production',metrics:{profile:'aec-closed-loop-dual-reference/v1',thresholds:clone(THRESHOLDS),sampleRateHz:48000,sampleCount:c.sampleCount,sourceCoverage:1,passed:true,windows},windowDiagnostics:diags};return {c,b};
}
test('frozen definition: eight cases, full 141s, 46/92 boundaries and untouched thresholds',()=>{const d=validateDefinition(def());assert.equal(d.totalSamples,48000*141);assert.deepEqual(d.cases[6].phases.map(p=>p.startSample),[0,48000*46,48000*92]);for(const mutate of [x=>x.delayHintMs=80,x=>x.sourceGain=.9,x=>x.thresholds.sourceCoverage=.9,x=>x.cases.pop(),x=>x.totalSamples-=480]){const x=def();mutate(x);assert.throws(()=>validateDefinition(x));}});
test('PCM16 exact signed float scale, RIFF bounds and format reject malformed material',()=>{const b=Buffer.alloc(8);[-32768,0,32767,8192].forEach((n,i)=>b.writeInt16LE(n,i*2));assert.deepEqual([...pcm16(b)],[-1,0,32767/32768,.25]);const w=wav([0,100,-100]);assert.equal(readPcm16Wav(w).sampleRateHz,24000);assert.equal(readPcm16Wav(w).samples.length,3);assert.throws(()=>readPcm16Wav(w.subarray(0,w.length-1)));const wrong=Buffer.from(w);wrong.writeUInt16LE(2,22);assert.throws(()=>readPcm16Wav(wrong));assert.throws(()=>pcm16(Buffer.alloc(3)));});
test('specified float32 linear 24->48 retains final sample; 480 mono -> 960 duplicated stereo',()=>{assert.deepEqual([...linear24to48(new Float32Array([0,.5,1]))],[0,.25,.5,.75,1,1]);const a=Float32Array.from({length:480},(_,i)=>i/480),b=monoFrameToStereo(a);assert.equal(b.length,960);for(let i=0;i<480;i++){assert.equal(b[2*i],a[i]);assert.equal(b[2*i+1],a[i]);}assert.throws(()=>monoFrameToStereo(a.subarray(1)));});
test('f32LE and float WAV preserve amplitude without normalization',()=>{const a=new Float32Array([-.7,.001,.6]);assert.deepEqual(readFloats(floatBytes(a)),a);const w=floatWav(a);assert.equal(w.readUInt16LE(20),3);assert.equal(w.readUInt32LE(40),12);assert.equal(w.readFloatLE(44),a[0]);assert.throws(()=>floatBytes(new Float32Array([1.01])));assert.throws(()=>readFloats(Buffer.from([0])));});
test('deterministic FIR/source+actualEcho capture, no oracle / no echo-as-render',()=>{const d=miniature(),{en,zh}=refs(d),c={...d.cases[2]};const a=synthesizeCase(d,c,en,zh),b=synthesizeCase(d,c,en,zh);assert.equal(sha256(floatBytes(a.input)),sha256(floatBytes(b.input)));assert.deepEqual(a.render.subarray(0,zh.length),zh);assert.notDeepEqual(a.render,a.echo);for(let n=0;n<d.totalSamples;n++)assert.equal(a.input[n],Math.fround(a.source[n]+a.echo[n]));assert.equal(d.delayHintMs,0);});
test('source-zero/render-zero cases do not synthesize different materials',()=>{const d=miniature(),{en,zh}=refs(d);const echo=synthesizeCase(d,d.cases[0],en,zh),source=synthesizeCase(d,d.cases[1],en,zh);assert.ok(echo.source.every(x=>x===0));assert.ok(source.render.every(x=>x===0));assert.ok(source.echo.every(x=>x===0));assert.deepEqual(source.input,source.source);});
test('wrong reference is cyclic shift of original Chinese; real capture equals double-talk',()=>{const d=miniature(),{en,zh}=refs(d),right=synthesizeCase(d,d.cases[2],en,zh),wrong=synthesizeCase(d,d.cases[7],en,zh);assert.deepEqual(wrong.input,right.input);assert.deepEqual(wrong.echo,right.echo);assert.deepEqual(wrong.correctRender,right.render);for(let n=0;n<zh.length;n++)assert.equal(wrong.render[n],zh[(n+34)%zh.length]);assert.ok(wrong.render.subarray(zh.length).every(x=>x===0));});
test('FIR ringout and >=2s quiet retained; full segments have no warmup gaps',()=>{const d=def();for(const c of d.cases){const s=makeSegments(d,c);assert.equal(s[0].startSample,0);assert.equal(s.at(-1).endSample,d.totalSamples);for(let i=1;i<s.length;i++)assert.equal(s[i-1].endSample,s[i].startSample);assert.ok(s.at(-1).endSample-s.at(-1).startSample>=96000);}const mini=miniature(),en=new Float32Array(64),zh=new Float32Array(128);zh[127]=.5;const a=synthesizeCase(mini,mini.cases[2],en,zh);assert.notEqual(a.echo[127+816],0);assert.ok(a.source.subarray(64).every(x=>x===0));assert.ok(a.input.subarray(944).every(x=>x===0));});
test('dynamic delay and nonlinear transform change ONLY actual echo, never reference',()=>{const d=miniature(),{en,zh}=refs(d),c={...d.cases[2],phases:[{startSample:0,delaySamples:0,nonlinear:false},{startSample:48,delaySamples:8,nonlinear:true}]};const a=synthesizeCase(d,c,en,zh);assert.equal(a.echo[48],Math.fround(zh[40]*.6));assert.equal(a.echo[56],Math.fround(softclip(zh[48])*.6));assert.deepEqual(a.render.subarray(0,zh.length),zh);});
test('peak >1 fails without overall gain rescue',()=>{const d=miniature(),en=new Float32Array(64).fill(.95),zh=new Float32Array(128).fill(.8);assert.throws(()=>synthesizeCase(d,d.cases[2],en,zh),/peak exceeds/);});
test('fixture digest/receipt provenance checked; plan file hash is distinct from payload',()=>{const d=def();assert.notEqual(d.provenance.synthesisPlanFileSha256,d.provenance.synthesisPlanSha256);assert.throws(()=>verifyFixtureBytes({definition:d,fixtureBytes:Buffer.from('{}'),sourceBytes:Buffer.from('x'),renderBytes:Buffer.from('y')}),/SHA256/);});
test('convergence is ten consecutive actual windows, never empty => zero latency',()=>{const {c,b}=nativeFixture(),s=summarizeBackend(c,b);assert.equal(s.phases[0].convergence.secondsFromPhaseStart,1);assert.equal(convergence([],0,48000),null);const short=nativeFixture({count:9});assert.equal(summarizeBackend(short.c,short.b).phases[0].convergence,null);const gaps=s.windows.slice();gaps[5]={...gaps[5],valid:false};assert.equal(convergence(gaps,0,c.sampleCount),null);});
test('bypass/silence/0.1-gain controls cannot falsely pass via low output or global coverage',()=>{for(const o of [{upper:1},{gain:null,coverage:0,upper:0},{gain:-20,coverage:1,upper:.01}]){const {c,b}=nativeFixture(o),s=summarizeBackend(c,b);assert.notEqual(s.applicableWindowOutcome,'observed-meets-all-applicable-window-gates');assert.equal(s.phases[0].convergence,null);assert.equal(s.overallPassed,false);}});
test('missing per-window coverage is indeterminate even with global coverage 100%',()=>{const {c,b}=nativeFixture();for(const w of b.windowDiagnostics)delete w.sourceWindowCoverage;const s=summarizeBackend(c,b);assert.equal(s.coreSourceCoverage,1);assert.equal(s.applicableWindowOutcome,'indeterminate');assert.equal(s.phases[0].convergence,null);});
test('source-only insufficient echo core failure does not imply failed English',()=>{const {c,b}=nativeFixture({echo:false});c.id='source-only';c.renderEnabled=false;b.metrics.passed=false;const s=summarizeBackend(c,b);assert.equal(s.applicableWindowOutcome,'observed-meets-all-applicable-window-gates');assert.equal(s.corePassedIsNotEnglishVerdict,true);assert.equal(s.phases[0].convergence,null);});
test('exact-zero upper gives null attenuation, not 999; invalid energy/zero coherent gain unknown',()=>{const w=window(0,{upper:0});const s=summarizeWindow(w.core,w.raw,4800);assert.equal(s.echoAttenuationDb.value,null);assert.equal(s.echoAttenuationDb.status,'exact-zero-upper-energy');const invalid=window(0,{valid:false,gain:null});assert.equal(summarizeWindow(invalid.core,invalid.raw,4800).gateStatus,'indeterminate');const bad=window();bad.raw.postUnexplainedEnergy=.1;assert.equal(summarizeWindow(bad.core,bad.raw,4800).valid,false);});
test('wrong-reference false positive honestly retained; never forced to fail',()=>{const {c,b}=nativeFixture();c.negativeControl=true;c.id='wrong-reference';const s=summarizeBackend(c,b);assert.equal(s.negativeControlObservedFalsePositive,true);assert.equal(s.qualityAcceptance,false);});
test('missing/reordered windows or changed core thresholds rejected',()=>{for(const edit of [b=>b.metrics.windows.pop(),b=>b.metrics.windows[0].startSample=4800,b=>b.metrics.thresholds.sourceCoverage=.8]){const {c,b}=nativeFixture();edit(b);assert.throws(()=>summarizeBackend(c,b));}});
test('SVG gaps retained, no 999; markdown latency null explicit',()=>{const {c,b}=nativeFixture({count:9}),s=summarizeBackend(c,b);assert.match(curvesSvg(s,c),/Per-window coherent source coverage/);assert.match(markdownReport({cases:[{id:c.id,backends:[s]}]}),/null — not established/);});
test('CLI never accepts alternate oracle gain/threshold or backend execution',()=>{for(const args of [[],['--prepare','--report'],['--prepare','--gain','0.1'],['--build'],['--report']])assert.throws(()=>cli(args));});

test('rounded 125.815s receipt never truncates the final eight 24k PCM samples',()=>{
  const d=def(),samples=Array(3019568).fill(0);samples[samples.length-1]=8192;const sourceBytes=wav(samples),renderBytes=Buffer.alloc(24);
  d.renderEndSample=24;d.provenance.sourceSha256=sha256(sourceBytes);d.provenance.renderSha256=sha256(renderBytes);
  const fixture={schemaVersion:1,artifactKind:'local-aec-api-speech-fixture',sampleRateHz:24000,channelCount:1,bitsPerSample:16,noSpeechTrimmed:true,
    synthesisPlanSha256:d.provenance.synthesisPlanSha256,synthesisUsageSha256:d.provenance.synthesisUsageSha256,
    englishSource:{file:'source.wav',sha256:d.provenance.sourceSha256,durationSeconds:125.815},translation:{file:'translation-stream.s16le',sha256:d.provenance.renderSha256,frames:12,durationSeconds:12/24000},
    segments:Array.from({length:6},(_,i)=>({kind:'speech',startFrame:i*2,endFrame:i*2+2}))};
  const fixtureBytes=Buffer.from(JSON.stringify(fixture));d.provenance.fixtureSha256=sha256(fixtureBytes);
  const actual=verifyFixtureBytes({definition:d,fixtureBytes,sourceBytes,renderBytes});assert.equal(actual.source.length,6039136);assert.equal(actual.source.at(-1),.25);
  const rounded=clone(d);rounded.sourceEndSample=6039120;assert.throws(()=>verifyFixtureBytes({definition:rounded,fixtureBytes,sourceBytes,renderBytes}),/complete original/);
});

test('centered SUM energies convert once: mean-square = sum / samples, not extra multiply',()=>{
  const {c,b}=nativeFixture();for(const d of b.windowDiagnostics){d.preEchoEnergy=4800;d.postCoherentEchoEnergy=4.8;d.postEchoUpperEnergy=4.8;d.inputCenteredEnergy=9600;d.postRawEnergy=480;}
  const s=summarizeBackend(c,b);assert.equal(s.fullCapture.meanSquareEnergies.preEchoEnergy,1);assert.ok(Math.abs(s.fullCapture.meanSquareEnergies.postCoherentEchoEnergy-.001)<1e-12);assert.equal(s.fullCapture.rawDescriptiveMeanSquares.inputCenteredEnergy,2);assert.equal(s.fullCapture.rawDescriptiveMeanSquares.postRawEnergy,.1);
});
test('source raw error descriptive, invalid inactive windows remain indeterminate not quiet pass',()=>{
  const w=window(0,{source:false,echo:false,valid:false}),r=summarizeWindow(w.core,w.raw,4800);assert.equal(r.gateStatus,'indeterminate');assert.match(r.rawErrorMeaning,/not pure source distortion/);
  const mismatch=window();mismatch.raw.metricsValid=false;assert.throws(()=>summarizeWindow(mismatch.core,mismatch.raw,4800));
});
function identityFixture(){
  const {c,b}=nativeFixture(),files=Object.fromEntries(['render','source','echo','input'].map(k=>[k,{path:'C:/fake/'+k,sha256:'a'.repeat(64),bytes:230400,sampleRateHz:48000,channelCount:1}]));
  Object.assign(c,{files,changes:[],negativeControl:false});
  const manifest={schemaVersion:1,artifactKind:'production-aec-offline-benchmark-inputs',benchmarkId:'11111111-1111-4111-8111-111111111111',definitionSha256:'d'.repeat(64),cases:[c]};
  const expected={runId:'22222222-2222-4222-8222-222222222222',inputManifestSha256:'e'.repeat(64),build:{sourceCommit:'c'.repeat(40),executableSha256:'b'.repeat(64),aecLibrarySha256:'a'.repeat(64),linkedAec3:true,shimFallbackUsed:false}};
  const project=Object.fromEntries(Object.entries(files).map(([k,v])=>[k,{path:v.path,sha256:v.sha256}]));
  const backend=id=>({...clone(b),id,role:'real-linked-algorithm-output',frameCounters:{renderFrames:c.sampleCount/480,captureFrames:c.sampleCount/480,...(id==='production'?{backend:'webrtc-aec3',resetCount:0,rejectedFrameCount:0}:{})}});
  const results={schemaVersion:1,artifactKind:'production-aec-offline-benchmark-results',manifestSha256:expected.inputManifestSha256,benchmarkId:manifest.benchmarkId,runId:expected.runId,build:clone(expected.build),definitionSha256:manifest.definitionSha256,
    sampleRateHz:48000,channelCount:1,frameSamples:480,externalCaptureQueueSamples:0,externalReferenceLeadSamples:0,windowEnergyConvention:'sum-of-squares',formalAcceptance:false,
    negativeControls:['bypass','silence','gain-0.1'].map(id=>({caseId:'double-talk',id,role:'negative-control-not-algorithm-output'})),
    cases:[{id:c.id,sampleCount:c.sampleCount,delayHintMs:0,sourceEndSample:c.sourceEndSample,renderEndSample:c.renderEndSample,negativeControl:false,files:project,changes:[],segments:c.segments,backends:[backend('production'),backend('linked-direct')]}]};return {manifest,results,expected};
}
test('actual Rust aliases and path/hash projection accept metadata-rich Node inputs',()=>{const f=identityFixture();assert.equal(validateResults(f.manifest,f.results,f.expected),true);f.results.inputManifestSha256=f.results.manifestSha256;assert.equal(validateResults(f.manifest,f.results,f.expected),true);});
test('exact unique negative-control inventory accepts any order without asserting outcomes',()=>{
  const f=identityFixture();f.results.negativeControls.reverse();
  for(const c of f.results.negativeControls)c.observedFalsePositive=true;
  assert.equal(validateResults(f.manifest,f.results,f.expected),true);
});
test('negative-control inventory rejects absent, malformed, missing, duplicate, extra and wrong identities',()=>{
  const edits=[
    r=>delete r.negativeControls,
    r=>r.negativeControls=null,
    r=>r.negativeControls={},
    r=>r.negativeControls=[],
    r=>r.negativeControls.pop(),
    r=>r.negativeControls[1]=clone(r.negativeControls[0]),
    r=>r.negativeControls=r.negativeControls.map(()=>clone(r.negativeControls[0])),
    r=>r.negativeControls.push(clone(r.negativeControls[0])),
    r=>r.negativeControls.push({caseId:'double-talk',id:'extra'}),
    r=>r.negativeControls[0].caseId='source-only',
    r=>r.negativeControls[0].id='extra',
    r=>delete r.negativeControls[0].id,
    r=>r.negativeControls[0]=null,
    r=>r.negativeControls[0]='bypass',
  ];
  for(const edit of edits){const f=identityFixture();edit(f.results);
    assert.throws(()=>validateResults(f.manifest,f.results,f.expected),/exact unique negative-control inventory required/);
  }
});
test('old output/identity, fake build/audio/fallback/oracle/altered frame counts rejected',()=>{
  const edits=[f=>f.results.runId='old',f=>f.results.benchmarkId='old',f=>f.results.manifestSha256='0'.repeat(64),f=>f.results.build.executableSha256='0'.repeat(64),
    f=>f.results.cases[0].files.input.sha256='0'.repeat(64),f=>f.results.cases[0].delayHintMs=80,f=>f.results.externalReferenceLeadSamples=1,
    f=>f.results.cases[0].backends[0].frameCounters.backend='shim',f=>f.results.cases[0].backends[0].frameCounters.captureFrames--,
    f=>f.results.cases[0].backends[0].role='negative-control-not-algorithm-output'];
  for(const edit of edits){const f=identityFixture();edit(f);assert.throws(()=>validateResults(f.manifest,f.results,f.expected));}
});
test('native relative output descriptors: PCM/WAV hash identity and no postnormalize',()=>{
  const parent=path.join(ARTIFACT_ROOT,'node-tests');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'outputs-'));
  try{const mono=new Float32Array([.1,-.3,.002]),stereo=new Float32Array([.1,.1,-.3,-.3,.002,.002]),files={};
    for(const [k,a,ch,encoding] of [['rawMono',mono,1,'f32le'],['rawStereo',stereo,2,'f32le'],['wavMono',mono,1,'wav-float32'],['wavStereo',stereo,2,'wav-float32']]){
      let bytes=encoding==='f32le'?floatBytes(a):floatWav(a);if(ch===2&&encoding!=='f32le'){bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000*8,28);bytes.writeUInt16LE(8,32);}const name=k+'.bin';fs.writeFileSync(path.join(root,name),bytes,{flag:'wx'});files[k]={path:name,sha256:sha256(bytes),channelCount:ch,sampleCount:3,encoding,sampleRateHz:48000};
    }
    assert.equal(validateOutputArtifacts(root,files,3).rawMono.length,12);assert.deepEqual(readFloats(floatWavPayload(floatWav(mono))),mono);
    const tamper=clone(files);tamper.rawMono.sha256='0'.repeat(64);assert.throws(()=>validateOutputArtifacts(root,tamper,3));const escape=clone(files);escape.rawMono.path='../outside';assert.throws(()=>validateOutputArtifacts(root,escape,3));const gain=clone(files);gain.wavMono=clone(files.wavStereo);assert.throws(()=>validateOutputArtifacts(root,gain,3));
  }finally{const relative=path.relative(parent,root);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(root,{recursive:true});}
});
test('offline player has no autoplay/normalization, user A/B preserves capture time',()=>{const h=listeningHtml([{id:'double-talk',before:'before.wav',after:'actual.wav',curve:'actual.svg'}]);assert.doesNotMatch(h,/<audio[^>]*autoplay/);assert.match(h,/active.currentTime/);assert.match(h,/preload="none"/);assert.match(h,/No autoplay or post-normalization/);});


test('actual Node CLI dispatches prepare/report, fails closed and import is side-effect free',()=>{
  const script=fileURLToPath(new URL('./aec-production-offline-benchmark.mjs',import.meta.url));
  const run=args=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:10000});
  const empty=run([]);assert.equal(empty.status,1);assert.match(empty.stderr,/choose exactly --prepare or --report/);assert.equal(empty.stdout,'');
  // Deliberately missing custody inputs exercise each real command without generating audio.
  const missing=path.join(ARTIFACT_ROOT,'cli-missing-'+process.pid);
  assert.equal(fs.existsSync(missing),false);
  const prepared=run(['--prepare','--fixture-dir',missing,'--out',path.join(missing,'prepared')]);
  assert.equal(prepared.status,1);assert.match(prepared.stderr,/ENOENT/);assert.equal(prepared.stdout,'');
  const reported=run(['--report','--manifest',path.join(missing,'manifest.json'),'--results',path.join(missing,'results.json'),
    '--results-sha256','a'.repeat(64),'--expected-identity',path.join(missing,'identity.json'),
    '--expected-identity-sha256','b'.repeat(64),'--out',path.join(missing,'reported')]);
  assert.equal(reported.status,1);assert.match(reported.stderr,/ENOENT/);assert.equal(reported.stdout,'');
  assert.equal(fs.existsSync(missing),false);
  const imported=spawnSync(process.execPath,['--input-type=module','--eval',
    'await import('+JSON.stringify(new URL('./aec-production-offline-benchmark.mjs',import.meta.url).href)+')'],{encoding:'utf8',timeout:10000});
  assert.equal(imported.status,0);assert.equal(imported.stdout,'');assert.equal(imported.stderr,'');
});
