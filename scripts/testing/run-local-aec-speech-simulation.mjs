import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { localAecProbeDesktopPowerShell, AEC_PROBE_JOB_HELPER, AEC_PROBE_CAPABILITY_ID } from './run-watch-mode-local-aec-probe.mjs';
import { analyzeLocalAecSpeech } from './local-aec-speech-analysis.mjs';
import { verifyApiSpeechProvenance } from './local-aec-speech-provenance.mjs';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const EXPECTED_BIOS = '4FCA4D56-0439-2E76-E21B-8F067FF78FBE';
const exactEndpoint = value => /^\{0\.0\.0\.00000000\}\.\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}$/iu.test(value);
function bytes(file, limit) {
 const resolved=fs.realpathSync.native(file),stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>limit||resolved!==path.resolve(file))throw Error('unsafe, empty or oversized local speech input');
 return fs.readFileSync(file);
}
function json(file,limit=1024*1024){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes(file,limit)));}
function write(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx'});}
export function createLocalSpeechRequest({executionId,outputDirectory,physicalDeviceId,renderPcmPath,renderPcmSha256,
 injectorExecutable,injectorExecutableSha256,sourceWavPath,sourceWavSha256,tailStartFrame}){
 if(!/^local-aec-speech-[a-f0-9-]{36}$/u.test(executionId)||path.basename(outputDirectory)!==executionId
  ||!exactEndpoint(physicalDeviceId)||![renderPcmSha256,injectorExecutableSha256,sourceWavSha256].every(s=>/^[a-f0-9]{64}$/u.test(s))
  ||!Number.isSafeInteger(tailStartFrame)||tailStartFrame<24000*80||tailStartFrame%2400!==0)throw Error('local speech request identity/hash/endpoint/tail mismatch');
 if(![outputDirectory,renderPcmPath,injectorExecutable,sourceWavPath].every(p=>path.isAbsolute(p)))throw Error('local speech request needs absolute paths');
 return {schemaVersion:2,executionId,outputDirectory,physicalDeviceId,renderPcmPath,renderPcmSha256,speechSimulation:{
  injectorExecutable,injectorExecutableSha256,sourceWavPath,sourceWavSha256,chunkFrames:2400,chunkIntervalMs:100,
  stageDurationMs:40000,deadlineMs:180000,tailStartFrame}};
}
export function inspectSpeechOperation(probe, request) {
 const failures=[];
 const check=(ok,message)=>{if(!ok)failures.push(message);};
 check(probe.schemaVersion===2&&probe.executionId===request.executionId,'schema2/execution identity');
 check(probe.scope==='local-aec-speech-simulation','not speech simulation scope');
 check(probe.providerCalls===0&&probe.recognitionSenderAttached===false&&probe.releaseEligible===false,'no-provider diagnostic boundary');
 check(probe.status==='completed','native operation failed');
 check(probe.capture?.effectiveDeviceId===request.physicalDeviceId&&probe.render?.effectiveDeviceId===request.physicalDeviceId,'actual endpoint identity');
 check(probe.capture?.countsFinal===true&&probe.capture?.framesCaptured>0&&!probe.capture?.lastError&&!probe.capture?.lastErrorCode,'final joined capture');
 check(probe.captureDrain?.captureRemainedOpen===true&&probe.captureDrain?.continuousQuietMs===2000
  &&probe.captureDrain?.quietEndFrame-probe.captureDrain?.quietStartFrame>=96000,'capture did not stay open through drain');
 check(probe.streamEvidence?.streamStartCount===1&&probe.streamEvidence?.streamDrained===true&&probe.streamEvidence?.aborted===false,'not one completed continuous stream');
 check(probe.streamEvidence?.mediaEndVoicedPhysicalFrames>=48000,'missing actually voiced media-end tail');
 check(probe.sourceMediaComplete?.passed===true&&probe.sourceMediaComplete?.endpointId===request.physicalDeviceId,'source media authority');
 check(!probe.primaryError&&!probe.cleanupError&&!probe.tapError&&!probe.streamEvidenceSealError&&!probe.sourceInjectorCleanupError,'native failure/custody/seal error');
 return {passed:failures.length===0,failures,scope:'local-aec-speech-simulation',releaseEligible:false};
}
export function finalizeSpeechOutcome(operation,tap,quality){
 const overallPassed=operation?.passed===true&&tap?.passed===true&&quality?.passed===true&&quality?.status==='passed'
  &&quality?.scope==='local-aec-speech-simulation'&&quality?.releaseEligible===false&&quality?.providerCalls===0
  &&quality?.modelInputLeakageVerified===false&&quality?.semanticLeakageChainVerified===false;
 return {overallPassed,status:overallPassed?'local-acoustic-simulation-passed':'failed',releaseEligible:false,
  realTranslationLifecycleVerified:false,semanticLeakageChainVerified:false};
}
export const parseLocalSpeechArgs=argv=>parseCliArgs(argv,{defaults:{desktopExecutable:'',desktopSha256:'',injectorExecutable:'',injectorSha256:'',fixtureDirectory:'',synthesisDirectory:'',synthesisUsageSha256:'',synthesisPlanFileSha256:'',analyzerExecutable:'',analyzerSha256:'',physicalDeviceId:'',outputRoot:'artifacts/testing/aec-iteration/local-speech-runs'}});
export async function runLocalAecSpeechSimulation(options){
 if(process.platform!=='win32')throw Error('local speech hardware test requires Windows');
 const fixtureRoot=fs.realpathSync.native(path.resolve(options.fixtureDirectory));
 const fixture=json(path.join(fixtureRoot,'fixture.json'));
 if(fixture.artifactKind!=='local-aec-api-speech-fixture'||fixture.noLocalTts!==true||fixture.noSpeechTrimmed!==true
  ||fixture.noTranslationLlmCalls!==true||fixture.sampleRateHz!==24000||fixture.chunkFrames!==2400||fixture.chunkIntervalMs!==100)throw Error('fresh API fixture contract is missing');
 const sourcePath=path.join(fixtureRoot,'source.wav'),renderPath=path.join(fixtureRoot,'translation-stream.s16le');
 if(sha(bytes(sourcePath,32*1024*1024))!==fixture.englishSource.sha256||sha(bytes(renderPath,24000*2*180))!==fixture.translation.sha256)throw Error('fixture PCM or English changed');
 const apiProvenance=verifyApiSpeechProvenance({fixture,renderBytes:bytes(renderPath,24000*2*180),synthesisDirectory:options.synthesisDirectory,
  expectedUsageSha256:options.synthesisUsageSha256,expectedPlanFileSha256:options.synthesisPlanFileSha256});
 const canonicalEnglishSha=fs.readFileSync(path.join(repoRoot,'scripts/testing/fixtures/watch-mode-en-original.sha256'),'utf8').trim().split(/\s/u)[0].toLowerCase();
 if(fixture.englishSource.sha256!==canonicalEnglishSha)throw Error('local speech source is not the unchanged canonical English fixture');
 const desktop=path.resolve(options.desktopExecutable),injector=path.resolve(options.injectorExecutable);
 const desktopBytes=bytes(desktop,200*1024*1024),injectorBytes=bytes(injector,100*1024*1024);
 if(sha(desktopBytes)!==options.desktopSha256||sha(injectorBytes)!==options.injectorSha256)throw Error('explicitly selected native executable hash mismatch');
 if(!desktopBytes.includes(Buffer.from(AEC_PROBE_CAPABILITY_ID)))throw Error('selected desktop has no guarded no-provider startup capability');
 const localIdentity=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  '[ordered]@{uuidBios=(Get-CimInstance Win32_ComputerSystemProduct).UUID;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;user=[Environment]::UserName}|ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true,timeout:10000}).replace(/^\uFEFF/u,''));
 if(localIdentity.uuidBios.toUpperCase()!==EXPECTED_BIOS||localIdentity.sessionId===0||localIdentity.user.toLowerCase()!=='vmuser')throw Error('this execution is not the bound interactive vm171 worker');
 const analyzer=path.resolve(options.analyzerExecutable);
 if(analyzer!==path.join(repoRoot,'target','release','omni-benchmark.exe')||sha(bytes(analyzer,512*1024*1024))!==options.analyzerSha256)throw Error('explicitly selected workspace release analyzer hash mismatch');
 const buildCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8',windowsHide:true}).trim();
 const compiledCommit=execFileSync(desktop,['--build-commit'],{encoding:'utf8',windowsHide:true,timeout:10000}).trim();
 if(compiledCommit!==buildCommit)throw Error('desktop compiled build commit differs from frozen source');
 if(execFileSync('git',['status','--porcelain'],{cwd:repoRoot,encoding:'utf8',windowsHide:true}).trim())throw Error('local speech run requires a clean frozen source commit');
 const sourceFiles=['scripts/testing/run-local-aec-speech-simulation.mjs','scripts/testing/local-aec-speech-analysis.mjs',
  'scripts/testing/local-aec-speech-provenance.mjs','scripts/testing/generate-local-aec-speech-fixture.mjs','scripts/testing/fixtures/wav-fixture-utils.mjs',
  'scripts/testing/watch-mode-aec-tap-evidence.mjs','scripts/testing/watch-mode-aec-closed-loop-evidence.mjs',
  'scripts/testing/run-watch-mode-local-aec-probe.mjs',AEC_PROBE_JOB_HELPER];
 const sourceHashes=Object.fromEntries(sourceFiles.map(file=>[file,sha(bytes(path.join(repoRoot,file),2*1024*1024))]));
 const executionId=`local-aec-speech-${crypto.randomUUID()}`,outputRoot=path.resolve(repoRoot,options.outputRoot);
 const evidenceRoot=path.resolve(repoRoot,'artifacts/testing/aec-iteration');
 if(!outputRoot.startsWith(evidenceRoot+path.sep))throw Error('local speech output must stay in independent AEC evidence root');
 fs.mkdirSync(outputRoot,{recursive:true});if(fs.realpathSync.native(outputRoot)!==outputRoot)throw Error('local speech output root is redirected');const outputDirectory=path.join(outputRoot,executionId);fs.mkdirSync(outputDirectory);
 const lastSpeech=fixture.segments.filter(s=>s.kind==='speech').at(-1);
 const request=createLocalSpeechRequest({executionId,outputDirectory,physicalDeviceId:options.physicalDeviceId,
  renderPcmPath:renderPath,renderPcmSha256:fixture.translation.sha256,injectorExecutable:injector,injectorExecutableSha256:options.injectorSha256,
  sourceWavPath:sourcePath,sourceWavSha256:fixture.englishSource.sha256,tailStartFrame:lastSpeech.startFrame});
 const requestPath=path.join(outputDirectory,'request.json');write(requestPath,request);
 const freeze={schemaVersion:1,artifactKind:'local-aec-speech-run-freeze',executionId,workerId:'vm171',localIdentity,scope:'local-aec-speech-simulation',releaseEligible:false,
  providerCalls:0,translationProviderCalls:0,requestSha256:sha(fs.readFileSync(requestPath)),fixtureSha256:sha(bytes(path.join(fixtureRoot,'fixture.json'),1024*1024)),
  desktopSha256:options.desktopSha256,injectorSha256:options.injectorSha256,analyzerSha256:options.analyzerSha256,buildCommit,sourceHashes,thresholds:{echoAttenuationDb:20,sourceGainToleranceDb:3,sourceCoverage:.95},
  apiProvenance,inputWatchdogMs:180000,frozenAt:new Date().toISOString()};write(path.join(outputDirectory,'run-freeze.json'),freeze);
 let outcome={schemaVersion:1,artifactKind:'local-aec-speech-simulation-result',executionId,workerId:'vm171',scope:'local-aec-speech-simulation',releaseEligible:false,
  providerCalls:0,translationProviderCalls:0,overallPassed:false,status:'failed',quality:{status:'not-run'},outputDirectory};
 try{
  const helper=path.resolve(repoRoot,AEC_PROBE_JOB_HELPER),deadlineUtc=new Date(Date.now()+180000).toISOString();
  const script=localAecProbeDesktopPowerShell({executable:desktop,executableSha256:options.desktopSha256,runtimeRoot:repoRoot,outputDirectory,requestPath,
   deadlineUtc,helperPath:helper,helperSha256:sha(bytes(helper,1024*1024))});
  write(path.join(outputDirectory,'process-launch-authority.json'),{schemaVersion:1,executionId,helperSha256:sha(bytes(helper,1024*1024)),deadlineUtc,scriptSha256:sha(Buffer.from(script,'utf8'))});
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
   {encoding:'utf8',windowsHide:true,cwd:repoRoot,timeout:195000,maxBuffer:4*1024*1024});
  fs.writeFileSync(path.join(outputDirectory,'launcher.stdout.log'),r.stdout??'','utf8');fs.writeFileSync(path.join(outputDirectory,'launcher.stderr.log'),r.stderr??'','utf8');
  if(r.error||r.status!==0)throw Error(r.error?.message??`local desktop job failed: exit ${r.status}`);
  const line=r.stdout.trim().split(/\r?\n/u).at(-1),custody=JSON.parse(line);
  write(path.join(outputDirectory,'process-custody.json'),custody);
  if(custody.ownedJobExited!==true||custody.exitCode!==0)throw Error('native owned job did not exit cleanly');
  const probe=json(path.join(outputDirectory,'local-aec-probe-result.json'));
  outcome.operation=inspectSpeechOperation(probe,request);
  if(!outcome.operation.passed)throw Error('native operation validation failed');
  outcome.quality=analyzeLocalAecSpeech(outputDirectory,{nativeReceipt:probe,expectedExecutionId:executionId,expectedPhysicalDeviceId:request.physicalDeviceId,
   analyzer:{workspaceRoot:repoRoot,releaseExecutablePath:analyzer,releaseExecutableSha256:options.analyzerSha256,noBuild:true}});
  write(path.join(outputDirectory,'local-speech-quality.json'),outcome.quality);
  outcome.tap={...outcome.quality.tapEvidence,passed:outcome.quality.tapEvidence?.complete===true,verification:'schema2-native-clock-and-PCM-seal'};
  for(const [file,digest] of Object.entries(sourceHashes))if(sha(bytes(path.join(repoRoot,file),2*1024*1024))!==digest)throw Error('frozen run source changed');
  if(sha(bytes(desktop,200*1024*1024))!==options.desktopSha256||sha(bytes(injector,100*1024*1024))!==options.injectorSha256
   ||sha(bytes(analyzer,512*1024*1024))!==options.analyzerSha256)throw Error('frozen run executable changed');
  verifyApiSpeechProvenance({fixture,renderBytes:bytes(renderPath,24000*2*180),synthesisDirectory:options.synthesisDirectory,
   expectedUsageSha256:options.synthesisUsageSha256,expectedPlanFileSha256:options.synthesisPlanFileSha256});
  if(execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8',windowsHide:true}).trim()!==buildCommit
   ||execFileSync('git',['status','--porcelain'],{cwd:repoRoot,encoding:'utf8',windowsHide:true}).trim())throw Error('source commit/worktree changed during run');
  Object.assign(outcome,finalizeSpeechOutcome(outcome.operation,outcome.tap,outcome.quality));
 }catch(error){outcome.failure=error.message;}
 write(path.join(outputDirectory,'local-speech-result.json'),outcome);return outcome;
}
if(isMain(import.meta.url)){
 try{const o=parseLocalSpeechArgs(process.argv.slice(2));const r=await runLocalAecSpeechSimulation(o);console.log(JSON.stringify(r,null,2));if(!r.overallPassed)process.exitCode=1;}
 catch(error){console.error(error.message);process.exitCode=1;}
}
