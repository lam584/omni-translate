// Offline fixture preparation and native-result presentation. Never executes a backend.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {verifyApiSpeechProvenance} from './local-aec-speech-provenance.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
export const REPO=path.resolve(HERE,'../..');
export const ARTIFACT_ROOT=path.join(REPO,'artifacts/testing/aec-offline-benchmark/v1');
export const DEFINITION_PATH=path.join(HERE,'fixtures/aec-production-offline-benchmark-v1.json');
export const FIXTURE_DIR='E:/oaec-c03-temp/evidence-custody-20261003/native-render-capacity/local-speech-fixture-20261003-v1';
export const THRESHOLDS=Object.freeze({echoAttenuationDb:20,sourceGainToleranceDb:3,sourceCoverage:0.95,windowMs:100,minimumEchoWindows:3,minimumReferenceRms:0.0001,maximumReferenceCorrelation:0.98,maximumUnexplainedEnergyRatio:0.20});
const check=(ok,why)=>{if(!ok)throw Error(why);};
export const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const parse=b=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b).replace(/^\uFEFF/,''));
const writeOnce=(p,b)=>fs.writeFileSync(p,b,{flag:'wx'});
const json=x=>JSON.stringify(x,null,2)+'\n';
const equal=(a,b,why)=>check(isDeepStrictEqual(a,b),why);
export function validateDefinition(d){
  check(d.schemaVersion===1&&d.artifactKind==='production-aec-offline-benchmark-definition','definition identity');
  equal(d.thresholds,THRESHOLDS,'unchanged core thresholds required');
  equal([d.sampleRateHz,d.channelCount,d.frameSamples,d.workerStereoSamplesPerFrame,d.sourceRateHz,d.sourceEndSample,d.renderEndSample,d.totalSamples],
    [48000,1,480,960,24000,6039136,6624000,6768000],'frozen complete timeline/rates');
  equal([d.seed,d.sourceGain,d.renderGain,d.noiseGain,d.delayHintMs,d.wrongReferenceShiftSamples],[715779,1,1,0,0,816000],'no alternate gain/noise/seed/oracle');
  equal(d.echoFir,[{offsetFrames:0,gain:0.6},{offsetFrames:336,gain:0.18},{offsetFrames:816,gain:-0.08}],'frozen FIR');
  equal(d.convergence,{consecutiveWindows:10,windowSamples:4800,changeWindowSamples:240000,startupSamples:96000,requireActiveSourceWhenEnabled:true,noWarmupExclusion:true},'frozen convergence');
  equal(d.cases.map(c=>c.id),['echo-only','source-only','double-talk','dynamic-80','nonlinear-160','tail-window','c03-three-stage','wrong-reference'],'eight frozen cases');
  const phase=(s,delay,nonlinear)=>({startSample:s,delaySamples:delay,nonlinear});
  const expected=[[phase(0,0,false)],[phase(0,0,false)],[phase(0,0,false)],[phase(0,0,false),phase(2208000,3840,false)],
    [phase(0,7680,true)],[phase(0,0,false)],[phase(0,0,false),phase(2208000,3840,false),phase(4416000,7680,true)],[phase(0,0,false)]];
  d.cases.forEach((c,i)=>{equal(c.phases,expected[i],'frozen phase definition');equal([c.sourceEnabled,c.renderEnabled],[i!==0,i!==1],'case reference enablement');equal(c.negativeControl===true,i===7,'negative-control identity');});
  equal(d.windowEnergyConvention,'sum','explicit energy convention');return d;
}
export function pcm16(bytes){
  check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length%2===0,'PCM16 byte alignment');
  const a=new Float32Array(bytes.length/2);for(let i=0;i<a.length;i++)a[i]=Math.fround(bytes.readInt16LE(i*2)/32768);return a;
}
export function readPcm16Wav(b){
  check(Buffer.isBuffer(b)&&b.length>=44&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE'&&b.readUInt32LE(4)+8===b.length,'RIFF integrity');
  let fmt=null,data=null,offset=12;
  while(offset<b.length){check(offset+8<=b.length,'truncated chunk');const id=b.toString('ascii',offset,offset+4),size=b.readUInt32LE(offset+4),start=offset+8;check(start+size<=b.length,'chunk beyond RIFF');
    if(id==='fmt '){check(!fmt&&size>=16,'duplicate/short fmt');fmt={tag:b.readUInt16LE(start),channels:b.readUInt16LE(start+2),rate:b.readUInt32LE(start+4),byteRate:b.readUInt32LE(start+8),align:b.readUInt16LE(start+12),bits:b.readUInt16LE(start+14)};}
    if(id==='data'){check(!data,'duplicate data');data=b.subarray(start,start+size);}offset=start+size+(size%2);
  }
  check(offset===b.length&&fmt&&data&&fmt.tag===1&&fmt.channels===1&&fmt.bits===16&&fmt.align===2&&fmt.byteRate===fmt.rate*2,'mono PCM16 WAVE required');
  return {sampleRateHz:fmt.rate,samples:pcm16(data)};
}
export function linear24to48(a){
  check(a instanceof Float32Array&&a.length>0,'finite source PCM');const out=new Float32Array(a.length*2);
  for(let i=0;i<a.length;i++){const x=a[i],next=a[Math.min(i+1,a.length-1)];check(Number.isFinite(x)&&Number.isFinite(next)&&Math.abs(x)<=1&&Math.abs(next)<=1,'source amplitude');out[i*2]=x;out[i*2+1]=Math.fround(x+Math.fround(Math.fround(next-x)*0.5));}return out;
}
export function monoFrameToStereo(a){check(a instanceof Float32Array&&a.length===480,'one exact 10ms mono frame required');const b=new Float32Array(960);for(let i=0;i<480;i++){b[2*i]=a[i];b[2*i+1]=a[i];}return b;}
export function softclip(x){const driven=Math.fround(x*2.4);const soft=Math.fround(Math.fround(driven/Math.fround(1+Math.abs(driven)))*1.35);return Math.fround(Math.max(-0.92,Math.min(0.92,soft)));}
export function floatBytes(a){const b=Buffer.allocUnsafe(a.length*4);for(let i=0;i<a.length;i++){check(Number.isFinite(a[i])&&Math.abs(a[i])<=1,'finite unclipped f32 required');b.writeFloatLE(a[i],i*4);}return b;}
export function readFloats(b){check(b.length>0&&b.length%4===0,'f32 alignment');const a=new Float32Array(b.length/4);for(let i=0;i<a.length;i++){a[i]=b.readFloatLE(i*4);check(Number.isFinite(a[i])&&Math.abs(a[i])<=1,'invalid native f32');}return a;}
export function floatWav(a,rate=48000){const data=floatBytes(a),b=Buffer.allocUnsafe(44+data.length);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(3,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*4,28);b.writeUInt16LE(4,32);b.writeUInt16LE(32,34);b.write('data',36);b.writeUInt32LE(data.length,40);data.copy(b,44);return b;}
export function verifyFixtureBytes({definition:d,fixtureBytes,sourceBytes,renderBytes}){
  const p=d.provenance;check(sha256(fixtureBytes)===p.fixtureSha256&&sha256(sourceBytes)===p.sourceSha256&&sha256(renderBytes)===p.renderSha256,'fixture/source/Chinese provenance SHA256');
  const f=parse(fixtureBytes);check(f.schemaVersion===1&&f.artifactKind==='local-aec-api-speech-fixture'&&f.sampleRateHz===24000&&f.channelCount===1&&f.bitsPerSample===16,'fixture format');
  equal([f.englishSource.file,f.englishSource.sha256,f.translation.file,f.translation.sha256],[p.sourceFile,p.sourceSha256,p.renderFile,p.renderSha256],'receipt material identity');
  check(f.synthesisPlanSha256===p.synthesisPlanSha256&&f.synthesisUsageSha256===p.synthesisUsageSha256&&f.noSpeechTrimmed===true,'recorded synthesis/no-trim identity');
  let cursor=0;for(const s of f.segments){check(integer(s.startFrame)&&integer(s.endFrame)&&s.startFrame===cursor&&s.endFrame>s.startFrame,'full cue/pause timeline');cursor=s.endFrame;}
  check(cursor===f.translation.frames&&f.segments.filter(s=>s.kind==='speech').length===6,'all six cues and final tail');
  const source24=readPcm16Wav(sourceBytes),render24=pcm16(renderBytes);check(source24.sampleRateHz===24000&&source24.samples.length*2===d.sourceEndSample&&render24.length*2===d.renderEndSample,'complete original durations');
  check(f.translation.frames===render24.length&&f.translation.durationSeconds===render24.length/24000&&f.englishSource.durationSeconds===Math.round(source24.samples.length/24000*1000)/1000,'descriptive rounded duration receipt; PCM frame count is authoritative');
  return {fixture:f,source:linear24to48(source24.samples),correctRender:linear24to48(render24)};
}
export function makeSegments(d,c){
  const pieces=[];let cursor=0;
  const push=(name,end)=>{if(end>cursor){pieces.push({name,startSample:cursor,endSample:end});cursor=end;}};
  push('startup',Math.min(d.convergence.startupSamples,d.sourceEndSample));
  const changes=c.phases.slice(1).map(p=>p.startSample);
  for(const [index,s] of changes.entries()){push(index?'recovered-'+index:'steady-before-change',s);push('change-'+(index+1),Math.min(s+d.convergence.changeWindowSamples,d.sourceEndSample));}
  push(changes.length?'recovered-to-source-end':'steady-to-source-end',d.sourceEndSample);
  push('tail-ended-source-continuing-render',d.renderEndSample);
  const last=c.phases.at(-1),ringout=Math.min(d.totalSamples,d.renderEndSample+last.delaySamples+Math.max(...d.echoFir.map(t=>t.offsetFrames)));
  push('natural-ringout',ringout);push('quiet',d.totalSamples);
  check(cursor===d.totalSamples,'segments must cover full capture');return pieces;
}
export function synthesizeCase(d,c,english,chinese){
  check(english.length===d.sourceEndSample&&chinese.length===d.renderEndSample&&d.totalSamples>=chinese.length,'no trim/extra material');
  const source=new Float32Array(d.totalSamples),correctRender=new Float32Array(d.totalSamples),echo=new Float32Array(d.totalSamples),input=new Float32Array(d.totalSamples);
  if(c.sourceEnabled)source.set(english);if(c.renderEnabled)correctRender.set(chinese);
  const physicalRender=new Float32Array(d.renderEndSample);let emissionPhase=0;
  for(let k=0;k<physicalRender.length;k++){while(emissionPhase+1<c.phases.length&&k>=c.phases[emissionPhase+1].startSample)emissionPhase++;physicalRender[k]=c.phases[emissionPhase].nonlinear?softclip(correctRender[k]):correctRender[k];}
  let phase=0,peak=0;
  for(let n=0;n<d.totalSamples;n++){
    while(phase+1<c.phases.length&&n>=c.phases[phase+1].startSample)phase++;
    const p=c.phases[phase];let value=0;
    for(const tap of d.echoFir){const index=n-p.delaySamples-tap.offsetFrames;if(index>=0&&index<d.renderEndSample)value=Math.fround(value+Math.fround(physicalRender[index]*tap.gain));}
    echo[n]=value;
    const mixed=source[n]+echo[n];check(Number.isFinite(mixed)&&Math.abs(mixed)<=1,'mixed peak exceeds 1: stop, never globally normalize');input[n]=Math.fround(mixed);peak=Math.max(peak,Math.abs(mixed));
  }
  let render=correctRender;
  if(c.negativeControl){render=new Float32Array(d.totalSamples);for(let n=0;n<d.renderEndSample;n++)render[n]=correctRender[(n+d.wrongReferenceShiftSamples)%d.renderEndSample];}
  return {render,source,echo,input,correctRender,peak};
}
function inside(root,p){const rel=path.relative(path.resolve(root),path.resolve(p));check(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'path outside artifact root');return path.resolve(p);}
function noRedirect(p){const a=path.resolve(p);let cursor=path.parse(a).root;for(const part of a.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);check(!fs.lstatSync(cursor).isSymbolicLink(),'symlink/reparse redirect');}equal(fs.realpathSync.native(a).toLowerCase(),a.toLowerCase(),'canonical redirect');}
function readFile(p){noRedirect(p);check(fs.statSync(p).isFile(),'not a regular file');return fs.readFileSync(p);}
function freshDirectory(out){const p=inside(ARTIFACT_ROOT,out);check(!fs.existsSync(p),'write-once artifact directory already exists');let ancestor=path.dirname(p);while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);noRedirect(ancestor);fs.mkdirSync(path.dirname(p),{recursive:true});noRedirect(path.dirname(p));fs.mkdirSync(p);return p;}
function writePcm(root,id,lane,samples){const folder=path.join(root,id);fs.mkdirSync(folder,{recursive:true});const bytes=floatBytes(samples),wav=floatWav(samples);const file=path.join(folder,lane+'.f32le'),wave=path.join(folder,lane+'.wav');writeOnce(file,bytes);writeOnce(wave,wav);return {raw:{path:file,sha256:sha256(bytes),bytes:bytes.length,sampleCount:samples.length,channelCount:1,sampleRateHz:48000,format:'f32le'},wav:{path:wave,sha256:sha256(wav),bytes:wav.length,sampleCount:samples.length,channelCount:1,sampleRateHz:48000,format:'ieee-float32-wav'}};}
export function prepare({fixtureDir=FIXTURE_DIR,synthesisDir,outputDir=path.join(ARTIFACT_ROOT,'inputs'),benchmarkId=crypto.randomUUID()}={}){
  const definitionBytes=readFile(DEFINITION_PATH),d=validateDefinition(parse(definitionBytes));const root=path.resolve(fixtureDir);
  const fixtureBytes=readFile(path.join(root,d.provenance.fixtureFile)),sourceBytes=readFile(path.join(root,d.provenance.sourceFile)),renderBytes=readFile(path.join(root,d.provenance.renderFile));
  const audio=verifyFixtureBytes({definition:d,fixtureBytes,sourceBytes,renderBytes});
  const provenance=verifyApiSpeechProvenance({fixture:audio.fixture,renderBytes,synthesisDirectory:synthesisDir??d.provenance.synthesisDirectory,expectedUsageSha256:d.provenance.synthesisUsageSha256,expectedPlanFileSha256:d.provenance.synthesisPlanFileSha256});
  check(typeof benchmarkId==='string'&&/^[a-f0-9-]{36}$/i.test(benchmarkId),'fresh benchmark UUID required');
  const out=freshDirectory(outputDir);writeOnce(path.join(out,'definition.json'),definitionBytes);
  const generatorBytes=readFile(fileURLToPath(import.meta.url));writeOnce(path.join(out,'generator-source.mjs'),generatorBytes);
  const manifest={schemaVersion:1,artifactKind:'production-aec-offline-benchmark-inputs',benchmarkId,sampleRateHz:48000,channelCount:1,frameSamples:480,
    sampleCount:d.totalSamples,seed:d.seed,delayHintMs:0,sourceGain:1,renderGain:1,definitionSha256:sha256(definitionBytes),definitionPath:path.join(out,'definition.json'),
    generatorSha256:sha256(generatorBytes),generatorPath:path.join(out,'generator-source.mjs'),provenance,fixtureReceiptSha256:sha256(fixtureBytes),fixtureDir:root,
    thresholds:d.thresholds,windowEnergyConvention:d.windowEnergyConvention,cases:[],releaseEligible:false,qualityAcceptance:false};
  for(const c of d.cases){const generated=synthesizeCase(d,c,audio.source,audio.correctRender),files={},wavFiles={};
    for(const lane of ['render','source','echo','input']){const saved=writePcm(out,c.id,lane,generated[lane]);files[lane]=saved.raw;wavFiles[lane]=saved.wav;}
    const entry={...c,sampleCount:d.totalSamples,files,wavFiles,delayHintMs:0,sourceEndSample:audio.source.length,renderEndSample:audio.correctRender.length,
      actualSourceEndSample:c.sourceEnabled?d.sourceEndSample:0,actualRenderEndSample:c.renderEnabled?d.renderEndSample:0,
      segments:makeSegments(d,c),changes:c.phases.slice(1).map(p=>p.startSample),
      negativeControl:c.negativeControl===true,peakInput:generated.peak,seed:d.seed,qualityAcceptance:false};
    if(c.negativeControl){const saved=writePcm(out,c.id,'correct-render-audit',generated.correctRender);entry.auditFiles={correctRender:saved.raw};entry.auditWavFiles={correctRender:saved.wav};entry.wrongReferenceShiftSamples=d.wrongReferenceShiftSamples;}
    manifest.cases.push(entry);
  }
  writeOnce(path.join(out,'manifest.json'),json(manifest));return {path:path.join(out,'manifest.json'),sha256:sha256(fs.readFileSync(path.join(out,'manifest.json'))),manifest};
}
const na=reason=>({status:'not-applicable',value:null,reason});
const unknown=reason=>({status:'indeterminate',value:null,reason});
export function summarizeWindow(core,raw,sampleCount){
  check(integer(core.startSample)&&core.sampleCount===4800&&core.startSample+core.sampleCount<=sampleCount,'exact complete 100ms windows required');
  equal([raw.startSample,raw.sampleCount],[core.startSample,core.sampleCount],'diagnostic/core window identity');
  for(const [key,wanted] of [['metricsValid',core.valid],['sourceActive',core.sourceActive],['echoActive',core.echoActive]])if(Object.hasOwn(raw,key))equal(raw[key],wanted,'native diagnostic/core validity identity');
  const energyKeys=['preEchoEnergy','postCoherentEchoEnergy','postUnexplainedEnergy','postEchoUpperEnergy','preSourceEnergy','postCoherentSourceEnergy'];
  const energyOK=energyKeys.every(k=>finite(raw[k])&&raw[k]>=0);
  const upperOK=energyOK&&raw.postEchoUpperEnergy+Number.EPSILON*Math.max(raw.postEchoUpperEnergy,raw.postCoherentEchoEnergy+raw.postUnexplainedEnergy)>=raw.postCoherentEchoEnergy+raw.postUnexplainedEnergy;
  const valid=core.valid===true&&energyOK&&upperOK;
  let echo=na('no active echo'),gain=na('no active source'),coverage=na('no active source');
  if(core.echoActive){
    if(!valid||raw.preEchoEnergy<=0)echo=unknown('invalid/unidentifiable core or energy split');
    else if(raw.postEchoUpperEnergy===0){echo=raw.echoUpperExactlyZero===true?{status:'exact-zero-upper-energy',value:null,meetsGate:true}:unknown('missing exact-zero witness');}
    else {const value=10*Math.log10(raw.preEchoEnergy/raw.postEchoUpperEnergy);echo={status:'measured',value,meetsGate:value>=THRESHOLDS.echoAttenuationDb};}
  }
  if(core.sourceActive){
    gain=valid&&finite(core.sourceGainDb)?{status:'measured',value:core.sourceGainDb,meetsGate:Math.abs(core.sourceGainDb)<=THRESHOLDS.sourceGainToleranceDb}:unknown('invalid core/zero or unknown coherent source gain');
    const value=raw.sourceWindowCoverage;coverage=valid&&finite(value)&&value>=0&&value<=1?{status:'measured',value,meetsGate:value>=THRESHOLDS.sourceCoverage}:unknown('missing per-window coherent coverage; global coverage is not a substitute');
  }
  const applicable=[echo,gain,coverage].filter(v=>v.status!=='not-applicable');
  const gates=!valid?'indeterminate':applicable.length===0?'not-applicable':applicable.some(v=>v.status==='indeterminate')?'indeterminate':applicable.every(v=>v.meetsGate===true)?'meets-applicable-window-gates':'does-not-meet-window-gates';
  return {startSample:core.startSample,sampleCount:core.sampleCount,sourceActive:core.sourceActive,echoActive:core.echoActive,valid,
    coreValid:core.valid,corePassed:core.passed,energySplitValid:upperOK,echoAttenuationDb:echo,sourceGainDb:gain,sourceWindowCoverage:coverage,gateStatus:gates,
    activeSourceSamples:integer(raw.activeSourceSamples)&&raw.activeSourceSamples<=core.sampleCount?raw.activeSourceSamples:null,
    energies:Object.fromEntries(energyKeys.map(k=>[k,finite(raw[k])?raw[k]:null])),
    inputCenteredEnergy:finite(raw.inputCenteredEnergy)?raw.inputCenteredEnergy:null,sourceCenteredEnergy:finite(raw.sourceCenteredEnergy)?raw.sourceCenteredEnergy:null,echoCenteredEnergy:finite(raw.echoCenteredEnergy)?raw.echoCenteredEnergy:null,postRawEnergy:finite(raw.postRawEnergy)?raw.postRawEnergy:null,postRms:finite(raw.postRms)?raw.postRms:null,
    sourceDistortionRatioReported:finite(raw.sourceDistortionRatio)?raw.sourceDistortionRatio:null,
    sourceRawErrorEnergy:finite(raw.sourceRawErrorEnergy)?raw.sourceRawErrorEnergy:null,sourceRawErrorRms:finite(raw.sourceRawErrorRms)?raw.sourceRawErrorRms:null,
    rawErrorMeaning:'descriptive source difference includes residual echo/unexplained energy; not pure source distortion',
    unexplainedResidualSplit:'postEchoUpperEnergy conservatively includes all unexplained residual; coherent source gain remains separate'};
}
export function convergence(windows,start,end,{requireSource=true,requireEcho=true}={}){
  let run=[];
  for(const w of windows){if(w.startSample<start||w.startSample+w.sampleCount>end)continue;
    const good=w.valid&&w.gateStatus==='meets-applicable-window-gates'&&(!requireSource||w.sourceActive)&&(!requireEcho||w.echoActive)&&w.sampleCount===4800;
    if(!good){run=[];continue;}if(run.length&&run.at(-1).startSample+4800!==w.startSample)run=[];run.push(w);
    if(run.length===10)return {qualifyingStartSample:run[0].startSample,completionSample:w.startSample+4800,secondsFromPhaseStart:(w.startSample+4800-start)/48000,consecutiveValidWindows:10};
  }return null;
}
function aggregate(windows,segment){
  const ww=windows.filter(w=>w.startSample<segment.endSample&&w.startSample+w.sampleCount>segment.startSample);
  const active=ww.filter(w=>w.sourceActive),echo=ww.filter(w=>w.echoActive);
  const knownCoverage=active.length>0&&active.every(w=>w.sourceWindowCoverage.status==='measured'&&w.activeSourceSamples!==null),denom=knownCoverage?active.reduce((a,w)=>a+w.activeSourceSamples,0):0;
  const coverage=knownCoverage&&denom>0?active.reduce((a,w)=>a+w.sourceWindowCoverage.value*w.activeSourceSamples,0)/denom:null;
  const gain=active.filter(w=>w.sourceGainDb.status==='measured').map(w=>w.sourceGainDb.value);
  const attenuation=echo.filter(w=>w.echoAttenuationDb.status==='measured').map(w=>w.echoAttenuationDb.value);
  const energies={};for(const key of ['preEchoEnergy','postCoherentEchoEnergy','postUnexplainedEnergy','postEchoUpperEnergy','preSourceEnergy','postCoherentSourceEnergy'])energies[key]=ww.length&&ww.every(w=>w.valid&&finite(w.energies[key]))?ww.reduce((a,w)=>a+w.energies[key],0)/ww.reduce((a,w)=>a+w.sampleCount,0):null;
  return {...segment,windowCount:ww.length,validWindows:ww.filter(w=>w.valid).length,indeterminateWindows:ww.filter(w=>w.gateStatus==='indeterminate').length,
    boundariesIncludeWholeOverlappingWindows:true,boundaryStraddlers:ww.filter(w=>w.startSample<segment.startSample||w.startSample+w.sampleCount>segment.endSample).map(w=>w.startSample),
    sourceActiveWindows:active.length,echoActiveWindows:echo.length,sourceCoverage:coverage,coverageWeight:'native activeSourceSamples; null when unavailable; never global substituted',
    sourceGainDbRange:gain.length?[Math.min(...gain),Math.max(...gain)]:null,minimumEchoAttenuationDb:attenuation.length?Math.min(...attenuation):null,
    exactZeroEchoUpperWindows:echo.filter(w=>w.echoAttenuationDb.status==='exact-zero-upper-energy').length,meanSquareEnergies:energies,
    rawDescriptiveMeanSquares:Object.fromEntries(['inputCenteredEnergy','sourceCenteredEnergy','echoCenteredEnergy','postRawEnergy','sourceRawErrorEnergy'].map(k=>[k,ww.length&&ww.every(w=>finite(w[k]))?ww.reduce((a,w)=>a+w[k],0)/ww.reduce((a,w)=>a+w.sampleCount,0):null])),
    sourceDistortionRatioRange:ww.filter(w=>finite(w.sourceDistortionRatioReported)).length?[Math.min(...ww.filter(w=>finite(w.sourceDistortionRatioReported)).map(w=>w.sourceDistortionRatioReported)),Math.max(...ww.filter(w=>finite(w.sourceDistortionRatioReported)).map(w=>w.sourceDistortionRatioReported))]:null,
    rawErrorIncludesEchoAndUnexplainedResidual:true,
    postRmsRange:ww.filter(w=>finite(w.postRms)).length?[Math.min(...ww.filter(w=>finite(w.postRms)).map(w=>w.postRms)),Math.max(...ww.filter(w=>finite(w.postRms)).map(w=>w.postRms))]:null};
}
export function summarizeBackend(caseInput,backend){
  const metrics=backend.metrics;check(metrics?.profile==='aec-closed-loop-dual-reference/v1','existing shared dual-reference core required');equal(metrics.thresholds,THRESHOLDS,'native thresholds changed');
  check(metrics.sampleRateHz===48000&&metrics.sampleCount===caseInput.sampleCount&&Array.isArray(metrics.windows)&&Array.isArray(backend.windowDiagnostics),'native full sample count');
  check(metrics.windows.length===caseInput.sampleCount/4800&&backend.windowDiagnostics.length===metrics.windows.length,'missing windows (warmup/quiet must remain)');
  const windows=metrics.windows.map((w,i)=>{check(w.startSample===i*4800,'full contiguous native windows');return summarizeWindow(w,backend.windowDiagnostics[i],caseInput.sampleCount);});
  const full=aggregate(windows,{name:'full-capture',startSample:0,endSample:caseInput.sampleCount});
  const segments=caseInput.segments.map(s=>aggregate(windows,s));
  const phases=caseInput.phases.map((p,i)=>({...p,endSample:caseInput.phases[i+1]?.startSample??caseInput.sampleCount,
    convergence:caseInput.renderEnabled?convergence(windows,p.startSample,caseInput.phases[i+1]?.startSample??caseInput.sampleCount,{requireSource:caseInput.sourceEnabled,requireEcho:true}):null,
    convergenceMeaning:caseInput.renderEnabled?'ten consecutive valid active-reference 100ms windows':'echo N/A, source preservation is evaluated separately'}));
  const applicable=windows.filter(w=>w.gateStatus!=='not-applicable');
  const allMeet=applicable.length>0&&applicable.every(w=>w.gateStatus==='meets-applicable-window-gates');
  return {id:backend.id,coreMetrics:metrics,windows,fullCapture:full,segments,phases,
    applicableWindowOutcome:allMeet?'observed-meets-all-applicable-window-gates':applicable.some(w=>w.gateStatus==='does-not-meet-window-gates')?'observed-window-failure':'indeterminate',
    coreSourceCoverage:metrics.sourceCoverage??null,corePassed:metrics.passed,corePassedIsNotEnglishVerdict:caseInput.id==='source-only',negativeControl:caseInput.negativeControl===true,
    negativeControlObservedFalsePositive:caseInput.negativeControl===true?allMeet:null,qualityAcceptance:false,overallPassed:false,releaseEligible:false};
}
function descriptor(root,f){
  check(f&&typeof f.path==='string'&&/^[a-f0-9]{64}$/.test(f.sha256??''),'hash-bound file descriptor');
  const p=inside(root,path.isAbsolute(f.path)?f.path:path.resolve(root,f.path)),b=readFile(p);
  check(sha256(b)===f.sha256&&(!integer(f.bytes)||f.bytes===b.length),'audio bytes/hash identity');return b;
}
const audioIdentity=files=>Object.fromEntries(['render','source','echo','input'].map(k=>[k,{path:files?.[k]?.path,sha256:files?.[k]?.sha256}]));
export function validateResults(manifest,results,expected){
  check(manifest.schemaVersion===1&&manifest.artifactKind==='production-aec-offline-benchmark-inputs'&&results.schemaVersion===1&&results.artifactKind==='production-aec-offline-benchmark-results','input/result artifact identities');
  equal(results.manifestSha256??results.inputManifestSha256,expected.manifestSha256??expected.inputManifestSha256,'external expected manifest hash');
  const identity=results.identity??(results.build?{runId:results.runId,build:results.build}:null);
  equal(identity?.runId,expected.runId,'expected new worker run identity');equal(identity?.build,expected.build,'externally frozen build identity');
  check(typeof expected.runId==='string'&&expected.runId.length>0&&/^[a-f0-9]{40}$/.test(expected.build?.sourceCommit??'')&&/^[a-f0-9]{64}$/.test(expected.build?.executableSha256??'')&&/^[a-f0-9]{64}$/.test(expected.build?.aecLibrarySha256??'')&&expected.build.linkedAec3===true&&expected.build.shimFallbackUsed===false,'real linked build identity required');
  if(results.benchmarkId!==undefined)equal(results.benchmarkId,manifest.benchmarkId,'old/different benchmark identity');
  if(results.definitionSha256!==undefined)equal(results.definitionSha256,manifest.definitionSha256,'frozen definition');
  equal([results.sampleRateHz,results.channelCount,results.frameSamples],[48000,1,480],'worker rate/frame identity');
  equal([results.externalCaptureQueueSamples,results.externalReferenceLeadSamples],[0,0],'no external oracle timing');
  equal(results.windowEnergyConvention,'sum-of-squares','native energy units must be centered SUM');
  check(results.formalAcceptance===false,'not formal acceptance');
  const controlIds=['bypass','silence','gain-0.1'];
  check(Array.isArray(results.negativeControls)&&results.negativeControls.length===controlIds.length&&
    results.negativeControls.every(c=>c&&c.caseId==='double-talk'&&controlIds.includes(c.id))&&
    new Set(results.negativeControls.map(c=>c.id)).size===controlIds.length,'exact unique negative-control inventory required');
  equal(results.cases.map(c=>c.id),manifest.cases.map(c=>c.id),'exact case inventory');
  for(const [i,c] of results.cases.entries()){
    const m=manifest.cases[i];equal(audioIdentity(c.files??c.inputFiles),audioIdentity(m.files),'worker input audio identity (path/hash projection)');
    equal([c.sampleCount,c.delayHintMs,c.sourceEndSample,c.renderEndSample,c.negativeControl],[m.sampleCount,0,m.sourceEndSample,m.renderEndSample,m.negativeControl],'worker case timeline');
    equal(c.changes,m.changes,'worker changes');equal(c.segments,m.segments,'worker segments');
    check(c.backends.some(b=>b.id==='production')&&c.backends.some(b=>b.id==='linked-direct')&&new Set(c.backends.map(b=>b.id)).size===c.backends.length,'production + linked-direct required, no duplicate outputs');
    for(const b of c.backends){check(/^[a-z0-9-]+$/.test(b.id)&&b.role==='real-linked-algorithm-output','real backend role');
      const frames=m.sampleCount/480;check(b.frameCounters?.renderFrames===frames&&b.frameCounters?.captureFrames===frames,'worker frame continuity');
      if(b.id==='production')check(b.frameCounters.backend==='webrtc-aec3'&&b.frameCounters.resetCount===0&&b.frameCounters.rejectedFrameCount===0,'production backend no fallback/reset/rejection');
    }
  }return true;
}
const esc=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const fmt=x=>finite(x)?x.toFixed(4):'N/A / indeterminate';
export function curvesSvg(summary,caseInput){
  const width=1100,height=690,left=65,right=25,plotWidth=width-left-right,duration=caseInput.sampleCount/48000;
  const panels=[{key:'sourceGainDb',title:'Coherent source gain (dB)',min:-24,max:12,gate:[-3,3]},
    {key:'echoAttenuationDb',title:'Echo attenuation (dB), coherent echo + ALL unexplained residual',min:-20,max:60,gate:[20]},
    {key:'sourceWindowCoverage',title:'Per-window coherent source coverage (not global coverage)',min:0,max:1,gate:[0.95]}];
  let s=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/><text x="20" y="24" font-family="sans-serif">${esc(caseInput.id)} / ${esc(summary.id)} — N/A/invalid gaps retained; exact zero echo upper not plotted as 999</text>`;
  panels.forEach((p,index)=>{const top=55+index*200,h=150,y=v=>top+h-(Math.max(p.min,Math.min(p.max,v))-p.min)/(p.max-p.min)*h,x=t=>left+t/duration*plotWidth;
    s+=`<text x="20" y="${top-10}" font-family="sans-serif">${esc(p.title)}</text><path d="M${left},${top}V${top+h}H${width-right}" fill="none" stroke="#777"/>`;
    for(const threshold of p.gate)s+=`<path d="M${left},${y(threshold)}H${width-right}" stroke="#c33" stroke-dasharray="4 4"/><text x="4" y="${y(threshold)}" font-size="11">${threshold}</text>`;
    for(const phase of caseInput.phases.slice(1))s+=`<path d="M${x(phase.startSample/48000)},${top}V${top+h}" stroke="#999" stroke-dasharray="2 3"/>`;
    for(const [label,t] of [['source end',caseInput.sourceEndSample/48000],['render end',caseInput.renderEndSample/48000]])s+=`<path d="M${x(t)},${top}V${top+h}" stroke="#ab7"/><text x="${x(t)-50}" y="${top+h+15}" font-size="10">${label}: ${t}s</text>`;
    let d='',open=false;for(const w of summary.windows){const measure=w[p.key];if(!w.valid||measure.status!=='measured'||!finite(measure.value)){open=false;continue;}d+=`${open?'L':'M'}${x(w.startSample/48000).toFixed(2)},${y(measure.value).toFixed(2)} `;open=true;}s+=`<path d="${d}" stroke="#1675a9" fill="none"/>`;
  });return s+'<text x="480" y="675" font-family="sans-serif">Capture time (seconds); view range clipping only, never audio normalization</text></svg>';
}
export function markdownReport(report){let s='# Production linked-AEC offline benchmark\n\nDiagnostic benchmark only; overallPassed=false, releaseEligible=false. No warmup trim, oracle hints, audio gain normalization, or clock fit.\n\n';
  s+='| Case | Backend | Window outcome | Core passed (not quality acceptance) | Full core source coverage | Min conservative echo dB | Source gain dB range |\n|---|---|---|---|---|---|---|\n';
  for(const c of report.cases)for(const b of c.backends)s+=`| ${c.id} | ${b.id} | ${b.applicableWindowOutcome} | ${b.corePassed} | ${fmt(b.coreSourceCoverage)} | ${fmt(b.fullCapture.minimumEchoAttenuationDb)} | ${b.fullCapture.sourceGainDbRange?.map(fmt).join(' … ')??'N/A'} |\n`;
  if(report.negativeControls?.length){s+='\n## Native negative controls (not real algorithm outputs)\n\n| Control | Window outcome | Observed false positive | Coherent source coverage |\n|---|---|---|---|\n';for(const c of report.negativeControls)s+=`| ${c.id} | ${c.applicableWindowOutcome} | ${c.observedFalsePositive} | ${fmt(c.coreSourceCoverage)} |\n`;}
  for(const c of report.cases){s+=`\n## ${c.id}\n`;if(c.sameAudioAs)s+=`Intentional repeated audio: ${c.sameAudioAs}; evaluates a different tail emphasis, not new material.\n`;
    for(const b of c.backends){s+=`\n### ${b.id}\n`;for(const p of b.phases)s+=`- Phase ${p.startSample/48000}–${p.endSample/48000}s: convergence/recovery ${p.convergence?`${p.convergence.secondsFromPhaseStart}s (completion ${p.convergence.completionSample/48000}s)`:'null — not established / not applicable'}, with all startup windows retained.\n`;
      if(b.negativeControl)s+=`- Wrong-reference observed false positive: ${b.negativeControlObservedFalsePositive} (not forced to fail).\n`;
      s+='- Source raw error includes residual/unexplained energy, not pure distortion. No-source/no-echo windows retain N/A; invalid windows are indeterminate.\n';
      s+='\n| Segment | Windows / valid | Active source / echo | Coherent coverage | Conservative echo dB minimum | Unexplained mean-square | Post RMS range |\n|---|---|---|---|---|---|---|\n';
      for(const a of b.segments)s+=`| ${a.name} | ${a.windowCount} / ${a.validWindows} | ${a.sourceActiveWindows} / ${a.echoActiveWindows} | ${fmt(a.sourceCoverage)} | ${fmt(a.minimumEchoAttenuationDb)} | ${fmt(a.meanSquareEnergies.postUnexplainedEnergy)} | ${a.postRmsRange?.map(fmt).join(' … ')??'N/A'} |\n`;
    }
  }return s+'\nBoundary-straddling 100ms windows remain whole, explicitly flagged in JSON. Convergence requires ten consecutive valid active-reference windows; missing results/coverage are never zero latency or a pass.\n';
}

function argumentsFor(argv){const o={};for(let i=0;i<argv.length;i++){const k=argv[i];check(/^--[a-z][a-z0-9-]*$/.test(k)&&!Object.hasOwn(o,k),'unknown/duplicate argument');if(k==='--prepare'||k==='--report')o[k]=true;else{check(i+1<argv.length&&!argv[i+1].startsWith('--'),'argument value required');o[k]=argv[++i];}}return o;}
export function cli(argv){const a=argumentsFor(argv);const allowed=['--prepare','--report','--fixture-dir','--synthesis-dir','--out','--benchmark-id','--manifest','--results','--results-sha256','--expected-identity','--expected-identity-sha256'];check(Object.keys(a).every(k=>allowed.includes(k))&&Boolean(a['--prepare'])!==Boolean(a['--report']),'choose exactly --prepare or --report');
  if(a['--prepare'])return prepare({fixtureDir:a['--fixture-dir'],synthesisDir:a['--synthesis-dir'],outputDir:a['--out'],benchmarkId:a['--benchmark-id']});
  for(const k of ['--manifest','--results','--results-sha256','--expected-identity','--expected-identity-sha256'])check(a[k],`required ${k}`);
  return report({manifestPath:a['--manifest'],resultsPath:a['--results'],resultsSha256:a['--results-sha256'],expectedIdentityPath:a['--expected-identity'],expectedIdentitySha256:a['--expected-identity-sha256'],outputDir:a['--out']});
}




export function floatWavPayload(b,channels=1){
  check(b.length>=44&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE'&&b.readUInt32LE(4)+8===b.length,'float WAV RIFF');let data=null,valid=false;
  for(let o=12;o<b.length;){check(o+8<=b.length,'WAV truncated');const n=b.readUInt32LE(o+4),start=o+8;check(start+n<=b.length,'WAV chunk bounds');const id=b.toString('ascii',o,o+4);
    if(id==='fmt '){check(!valid&&n>=16,'WAV fmt');valid=b.readUInt16LE(start)===3&&b.readUInt16LE(start+2)===channels&&b.readUInt32LE(start+4)===48000&&b.readUInt16LE(start+14)===32;check(valid,'float32/rate/channel WAV');}
    if(id==='data'){check(!data,'duplicate WAV data');data=b.subarray(start,start+n);}o=start+n+(n%2);
  }check(valid&&data,'WAV data/format');return data;
}
export function validateOutputArtifacts(root,files,count){
  const bytes={};for(const [key,channels,encoding] of [['rawMono',1,'f32le'],['rawStereo',2,'f32le'],['wavMono',1,'wav-float32'],['wavStereo',2,'wav-float32']]){
    const f=files?.[key];check(f&&f.channelCount===channels&&f.sampleCount===count&&f.encoding===encoding&&(f.sampleRateHz===undefined||f.sampleRateHz===48000),'native output count/channel/encoding');bytes[key]=descriptor(root,f);
    if(encoding==='f32le')check(bytes[key].length===count*channels*4,'native raw output length');
  }
  equal(floatWavPayload(bytes.wavMono,1),bytes.rawMono,'native mono WAV must equal unnormalized output PCM');equal(floatWavPayload(bytes.wavStereo,2),bytes.rawStereo,'native stereo WAV must equal unnormalized PCM');
  const mono=readFloats(bytes.rawMono),stereo=readFloats(bytes.rawStereo);
  for(let n=0;n<count;n++)check(mono[n]===Math.fround((stereo[n*2]+stereo[n*2+1])*0.5),'native mono must equal actual stereo downmix');
  return bytes;
}
export function listeningHtml(entries){return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Actual unnormalized production A/B</title><body><h1>Mixed input / actual production output</h1><p>No autoplay or post-normalization. Shared capture time, user initiated playback. Device volume is outside this benchmark.</p>${entries.map(e=>`<section><h2>${esc(e.id)}</h2><p>Before</p><audio controls preload="none" data-lane="before" src="${esc(e.before)}"></audio><p>After actual production</p><audio controls preload="none" data-lane="after" src="${esc(e.after)}"></audio><button type="button" data-play="before">Before at shared time</button><button type="button" data-play="after">After at shared time</button><label>Seconds <input type="number" min="0" max="141" step="0.1" value="0"></label><p><img src="${esc(e.curve)}" width="1100" alt="Source gain, echo attenuation, window coverage"></p></section>`).join('')}<script>for(const s of document.querySelectorAll('section')){const a=s.querySelector('[data-lane="before"]'),b=s.querySelector('[data-lane="after"]'),t=s.querySelector('input');let active=null;for(const button of s.querySelectorAll('button'))button.addEventListener('click',()=>{const at=active?active.currentTime:Number(t.value);a.pause();b.pause();active=button.dataset.play==='before'?a:b;active.volume=1;active.currentTime=at;active.play().catch(console.error);});t.addEventListener('change',()=>{a.currentTime=Number(t.value);b.currentTime=Number(t.value);});for(const lane of [a,b])lane.addEventListener('timeupdate',()=>{if(lane===active)t.value=lane.currentTime.toFixed(1);});}</script></body></html>`;}
export function report({manifestPath,resultsPath,resultsSha256,expectedIdentityPath,expectedIdentitySha256,outputDir=path.join(ARTIFACT_ROOT,'report')}){
  inside(ARTIFACT_ROOT,manifestPath);inside(ARTIFACT_ROOT,resultsPath);inside(ARTIFACT_ROOT,outputDir);inside(path.join(REPO,'artifacts/testing'),expectedIdentityPath);
  const manifestBytes=readFile(manifestPath),manifest=parse(manifestBytes),inputRoot=path.dirname(path.resolve(manifestPath)),resultRoot=path.dirname(path.resolve(resultsPath));
  const resultBytes=readFile(resultsPath),expectedBytes=readFile(expectedIdentityPath);check(sha256(resultBytes)===resultsSha256&&sha256(expectedBytes)===expectedIdentitySha256,'externally supplied result/expected-build hash');
  const results=parse(resultBytes),expected=parse(expectedBytes);check((expected.inputManifestSha256??expected.manifestSha256)===sha256(manifestBytes),'expected manifest hash');
  const definitionBytes=descriptor(inputRoot,{path:manifest.definitionPath,sha256:manifest.definitionSha256}),definition=validateDefinition(parse(definitionBytes));
  descriptor(inputRoot,{path:manifest.generatorPath,sha256:manifest.generatorSha256});
  equal(manifest.thresholds,THRESHOLDS,'manifest thresholds');equal(manifest.windowEnergyConvention,'sum','centered SUM native diagnostic convention');equal(manifest.cases.map(c=>c.id),definition.cases.map(c=>c.id),'frozen cases');validateResults(manifest,results,expected);
  // Native independently checked current_exe. This optional read checks recorded file bytes,
  // not loaded-image attestation or an embedded source/library signature.
  if(expected.build.executablePath){inside(REPO,expected.build.executablePath);check(sha256(readFile(expected.build.executablePath))===expected.build.executableSha256,'expected executable file hash');}
  const prepared=[],controls=[];
  for(const [index,c] of manifest.cases.entries()){
    check(c.sampleCount===definition.totalSamples&&c.delayHintMs===0,'complete zero-hint case');equal(c.phases,definition.cases[index].phases,'input phase freeze');equal(c.segments,makeSegments(definition,definition.cases[index]),'input segment freeze');
    for(const f of Object.values(c.files)){const b=descriptor(inputRoot,f);check(b.length===c.sampleCount*4&&f.sampleRateHz===48000&&f.channelCount===1&&f.format==='f32le','input float inventory');}
    if(c.negativeControl)descriptor(inputRoot,c.auditFiles.correctRender);
    const before=descriptor(inputRoot,c.wavFiles.input);equal(floatWavPayload(before),descriptor(inputRoot,c.files.input),'before WAV equals frozen input PCM');
    const backends=[];let productionWav=null;
    for(const backend of results.cases[index].backends){const audio=validateOutputArtifacts(resultRoot,backend.outputFiles,c.sampleCount),summary=summarizeBackend(c,backend);summary.outputFiles=backend.outputFiles;summary.frameCounters=backend.frameCounters;summary.independentEnglish=backend.independentEnglish;summary.nativeDiagnosticPassed=backend.diagnosticPassed;backends.push(summary);if(backend.id==='production')productionWav=audio.wavMono;}
    prepared.push({input:c,summary:{id:c.id,sameAudioAs:c.sameAudioAs??null,negativeControl:c.negativeControl,backends},before,productionWav});
  }
  for(const control of results.negativeControls??[]){check(control.role==='negative-control-not-algorithm-output'&&['bypass','silence','gain-0.1'].includes(control.id)&&control.caseId==='double-talk','official negative control role/case');const c=manifest.cases.find(c=>c.id===control.caseId);validateOutputArtifacts(resultRoot,control.outputFiles,c.sampleCount);const summary=summarizeBackend(c,control);controls.push({caseId:control.caseId,...summary,role:control.role,outputFiles:control.outputFiles,notAlgorithmOutput:true,observedFalsePositive:summary.applicableWindowOutcome==='observed-meets-all-applicable-window-gates'});}
  const out=freshDirectory(outputDir),audioDir=path.join(out,'audio'),svgDir=path.join(out,'curves');fs.mkdirSync(audioDir);fs.mkdirSync(svgDir);const listening=[];
  for(const p of prepared){const before=path.join(audioDir,p.input.id+'-before.wav'),after=path.join(audioDir,p.input.id+'-production-after.wav');writeOnce(before,p.before);writeOnce(after,p.productionWav);
    p.summary.listenFiles={before:{path:before,sha256:sha256(p.before)},after:{path:after,sha256:sha256(p.productionWav)},normalization:false,autoplay:false};
    for(const b of p.summary.backends)writeOnce(path.join(svgDir,p.input.id+'-'+b.id+'.svg'),curvesSvg(b,p.input));
    listening.push({id:p.input.id,before:'audio/'+path.basename(before),after:'audio/'+path.basename(after),curve:'curves/'+p.input.id+'-production.svg'});
  }
  const output={schemaVersion:1,artifactKind:'production-aec-offline-benchmark-report',benchmarkId:manifest.benchmarkId,runId:expected.runId,build:expected.build,
    hashes:{inputManifestSha256:sha256(manifestBytes),definitionSha256:manifest.definitionSha256,nativeResultsSha256:resultsSha256,expectedIdentitySha256,reportToolSha256:sha256(readFile(fileURLToPath(import.meta.url)))},
    thresholds:THRESHOLDS,convergence:definition.convergence,windowEnergyConvention:'centered sum; display mean-square=sum/number-of-samples',cases:prepared.map(p=>p.summary),negativeControls:controls,
    qualityAcceptance:false,overallPassed:false,releaseEligible:false,
    limitations:['Native shared-core metrics/window diagnostics presented; no new regression, lag fit or clock alignment.','Source/library build digests are caller binding, not embedded native attestation; current_exe validated by worker receipt.','Source-only insufficient echo windows is not an English failure.','Unknown/invalid/no-source never becomes coverage=1 or latency=0.','Only verified actual unnormalized production output is used for listening.']};
  writeOnce(path.join(out,'report.json'),json(output));writeOnce(path.join(out,'report.md'),markdownReport(output));writeOnce(path.join(out,'listen.html'),listeningHtml(listening));return {path:path.join(out,'report.json'),report:output};
}

// Execute only when invoked as the CLI, after module initialization.
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{const r=cli(process.argv.slice(2));console.log(json({path:r.path,sha256:r.sha256??null,scope:'offline-only-not-AEC-acceptance'}));}catch(e){console.error(e.message);process.exitCode=1;}}
