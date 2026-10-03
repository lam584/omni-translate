import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { localAecProbeDesktopPowerShell, AEC_PROBE_JOB_HELPER, AEC_PROBE_CAPABILITY_ID } from './run-watch-mode-local-aec-probe.mjs';
import { analyzeLocalAecSpeech } from './local-aec-speech-analysis.mjs';
import { verifyApiSpeechProvenance } from './local-aec-speech-provenance.mjs';
import { windowsPowerShellEnvironment } from './run-watch-mode-live-production-coordinator.mjs';
import { validateProbeMmcssAudio } from './local-aec-mmcss-receipt.mjs';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const EXPECTED_BIOS = '4FCA4D56-0439-2E76-E21B-8F067FF78FBE';
// The original 195s outer cap includes native startup and failure evidence sealing.
// Keep the native 180s input watchdog separate; reserve 5s for JobObject cleanup.
export const LOCAL_SPEECH_BUDGETS = Object.freeze({ inputMs:180000, ownedJobMs:190000, outerMs:195000 });
export function localSpeechJobDeadline(nowMs) {
 if(!Number.isSafeInteger(nowMs)||nowMs<0||nowMs>8640000000000000-LOCAL_SPEECH_BUDGETS.ownedJobMs)throw Error("invalid local speech launch time");
 return new Date(nowMs+LOCAL_SPEECH_BUDGETS.ownedJobMs).toISOString();
}
export const LOCAL_SPEECH_FROZEN_SOURCE_FILES=Object.freeze(["apps/desktop/src-tauri/src/audio/aec_diagnostic_tap/closed_loop.rs","apps/desktop/src-tauri/src/audio/aec_diagnostic_tap/closed_loop_packet_tests.rs","scripts/testing/watch-mode-aec-closed-loop-evidence.test.mjs",'apps/desktop/src-tauri/src/audio/state/echo_backend_capture_tail_tests.rs','apps/desktop/src-tauri/src/audio/aec_diagnostic_tap/tests.rs','scripts/testing/watch-mode-aec-capture-processing-evidence.mjs','scripts/testing/watch-mode-aec-capture-processing-evidence.test.mjs','scripts/testing/watch-mode-aec-tap-evidence.test.mjs','scripts/testing/local-aec-speech-analysis.test.mjs',"apps/desktop/src-tauri/src/audio/aec_diagnostic_tap.rs",
  "apps/desktop/src-tauri/src/audio/echo_cancel/production.rs",
  "apps/desktop/src-tauri/src/audio/echo_cancel/partial_capture_tests.rs",
  "apps/desktop/src-tauri/src/audio/engine/mod.rs",
  "apps/desktop/src-tauri/src/audio/engine/workers/capture_diagnostics.rs",
  "apps/desktop/src-tauri/src/audio/engine/workers/capture_pipeline.rs",
  "apps/desktop/src-tauri/src/audio/engine/workers/capture_pipeline_tests.rs",
  "apps/desktop/src-tauri/src/audio/engine/workers/capture_tail.rs",
  "apps/desktop/src-tauri/src/audio/engine/workers/capture_tail_tests.rs",
  "apps/desktop/src-tauri/src/audio/engine/workers/capture_tail_owner.rs",
  "apps/desktop/src-tauri/src/audio/engine/workers/capture_tail_owner_tests.rs",
  "apps/bridge-service-native/Cargo.toml",
  "apps/bridge-service-native/src/bin/injector/source_clock/independent_observation.rs",
  'scripts/testing/run-local-aec-speech-simulation.mjs','scripts/testing/run-local-aec-speech-simulation.test.mjs',
  'scripts/testing/local-aec-mmcss-receipt.mjs','scripts/testing/local-aec-mmcss-receipt.test.mjs',
  'apps/desktop/src-tauri/src/audio/speech/output/native_streaming/mmcss_audio.rs',
  'apps/desktop/src-tauri/src/audio/speech/output/native_streaming/mmcss_audio_tests.rs',
  'apps/desktop/src-tauri/src/audio/speech/output/native_streaming/mmcss_lifecycle_tests.rs',
  'apps/desktop/src-tauri/src/audio/speech/output/native_streaming/capacity_topup_tests.rs',
  'apps/desktop/src-tauri/src/audio/state/echo_backend.rs',
  'apps/desktop/src-tauri/src/audio/state/echo_backend_delay_mapping_tests.rs',
  'apps/desktop/src-tauri/src/audio/engine/aec_timing.rs',
  'apps/desktop/src-tauri/src/audio/speech/reference_rate_matcher.rs',
  'apps/desktop/src-tauri/src/audio/state.rs',
  'apps/desktop/src-tauri/src/audio/state/native_capture_start.rs',
  'apps/desktop/src-tauri/src/audio/state/native_capture_start/health.rs',
  'apps/desktop/src-tauri/src/audio/state/native_capture_start/tests.rs',
  'apps/desktop/src-tauri/src/audio/engine/workers.rs',
  'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/drain.rs',
  'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/drain_tests.rs',
  'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/drain_observation.rs',
  'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/failure_scope.rs',
  'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/failure_scope_tests.rs',
  'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/injector.rs',
  'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/injector_collection_tests.rs',
  'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/owned_collection.rs',
  'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/drain_failure_tests.rs',
 'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/SCHEMA2-CONTRACT.md',
  'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/tests.rs',
  'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/render_reference_tests.rs',
  'apps/bridge-service-native/src/bin/omni-watch-media-injector.rs',
  'apps/bridge-service-native/src/bin/injector/render.rs',
  'apps/bridge-service-native/src/bin/injector/tests.rs',
  'apps/bridge-service-native/src/bin/injector/source_clock.rs',
  'apps/bridge-service-native/src/bin/injector/source_clock/raw_trace.rs',
  'apps/bridge-service-native/src/bin/injector/source_clock/tests.rs',
  'apps/desktop/src-tauri/src/audio/playback_ownership.rs',
  'apps/desktop/src-tauri/src/audio/speech/output/native_streaming.rs',
  'apps/desktop/src-tauri/src/watch_mode_diagnostic/local_aec_probe/speech_simulation.rs',
  'apps/desktop/src-tauri/src/audio/omni/protocol/native_desktop_stream.rs',
  'scripts/testing/local-aec-speech-analysis.mjs',
  'scripts/testing/local-aec-speech-provenance.mjs','scripts/testing/generate-local-aec-speech-fixture.mjs','scripts/testing/fixtures/wav-fixture-utils.mjs',
  'scripts/testing/watch-mode-aec-tap-evidence.mjs','scripts/testing/watch-mode-aec-closed-loop-evidence.mjs',
  'scripts/testing/run-watch-mode-local-aec-probe.mjs','scripts/testing/run-watch-mode-live-production-coordinator.mjs',AEC_PROBE_JOB_HELPER]);

export function collectLocalSpeechSourceHashes(root) {
 return Object.fromEntries(LOCAL_SPEECH_FROZEN_SOURCE_FILES.map(file=>[file,sha(bytes(path.join(root,file),2*1024*1024))]));
}
export function verifyLocalSpeechSourceHashes(root, hashes) {
 for(const file of LOCAL_SPEECH_FROZEN_SOURCE_FILES){
  if(!hashes||!Object.hasOwn(hashes,file)||!/^[a-f0-9]{64}$/u.test(hashes[file]))throw Error('missing frozen run source: '+file);
  if(sha(bytes(path.join(root,file),2*1024*1024))!==hashes[file])throw Error('frozen run source changed: '+file);
 }
 for(const [file,digest] of Object.entries(hashes)){
  if(!LOCAL_SPEECH_FROZEN_SOURCE_FILES.includes(file)||sha(bytes(path.join(root,file),2*1024*1024))!==digest)throw Error('frozen run source changed: '+file);
 }
}
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
  stageDurationMs:40000,deadlineMs:LOCAL_SPEECH_BUDGETS.inputMs,tailStartFrame}};
}
// Versioned native operation evidence only; NOT acoustic/source-clock quality.
function validCaptureDrain(drain, finalCapture) {
 const safe=n=>Number.isSafeInteger(n)&&n>=0;
 const health=drain?.nativeHealth,packet=health?.latestPacket;
 const coherent=drain?.schemaVersion===2&&drain.ownerContinuity===true
  &&safe(drain.captureOwnerId)&&drain.captureOwnerId>0&&drain.nativeStartAcknowledged===true
  &&drain.captureRemainedOpen===true&&['capturing','buffering'].includes(drain.captureStateAtDrain)&&drain.continuousQuietMs===2000
  &&drain.quietEnergyCeilingDb===-60&&drain.deadlineIsFailureOnly===true
  &&[drain.quietStartFrame,drain.quietEndFrame,health?.capturedFrames,health?.aecCompletedFrames,
   health?.dispatchCompletedFrames,health?.residualBytes,health?.successfulQueryStart,
   health?.successfulQueryEnd,health?.emptyPollCount,health?.rawActivityGeneration,
   health?.emptyEpoch,health?.progressEpoch,health?.quiescenceEpoch,health?.aecResetGeneration].every(safe)
  &&drain.quietEndFrame>=drain.quietStartFrame&&health.capturedFrames>0
  &&health.capturedFrames===health.aecCompletedFrames&&health.aecCompletedFrames===health.dispatchCompletedFrames
  &&health.residualBytes===0&&health.latestQuery?.kind==='empty'
  &&health.successfulQueryStart>0&&health.successfulQueryEnd>=health.successfulQueryStart+20
  &&health.dispatchCompletedFrames===drain.quietEndFrame&&finalCapture>=health.capturedFrames
  &&(health.lastRawActivityAgeMs===null ? health.rawActivityGeneration===0
   : safe(health.lastRawActivityAgeMs)&&health.lastRawActivityAgeMs>=2000)
  &&health.workPending===false&&health.terminal===false&&health.fault===null&&safe(health.maximumProducerPollGapMs)
  &&health.maximumProducerPollGapMs>0&&health.maximumProducerPollGapMs<=100&&safe(health.maximumConsumerObservationGapMs)
  &&health.maximumConsumerObservationGapMs>0&&health.maximumConsumerObservationGapMs<=100
  &&safe(packet?.frames)&&packet.frames>0&&safe(packet.deviceFrameIndex)&&safe(packet.qpc100ns)
  &&Number.isFinite(packet.rawEnergyDb)&&['silent','dataDiscontinuity','timestampError'].every(k=>typeof packet[k]==='boolean');
 if(!coherent)return false;
 if(drain.completionMode==='pcm-frames')return drain.minimumQuietCaptureFrames===96000
  &&drain.quietEndFrame-drain.quietStartFrame>=96000;
 if(drain.completionMode!=='native-empty-polls')return false;
 return drain.minimumQuietCaptureFrames===null&&drain.quietStartFrame===drain.quietEndFrame
  &&health.latestQuery?.kind==='empty'&&health.capturedFrames===health.aecCompletedFrames&&health.residualBytes===0
  &&health.successfulQueryStart>0&&health.successfulQueryEnd>health.successfulQueryStart
  &&health.emptyPollCount===health.successfulQueryEnd-health.successfulQueryStart+1
  &&health.emptyPollCount>=21&&health.maximumProducerPollGapMs>0;
}
export function inspectSpeechOperation(probe, request) {
 const failures=[];
 const check=(ok,message)=>{if(!ok)failures.push(message);};
 check(probe.schemaVersion===2&&probe.executionId===request.executionId,'schema2/execution identity');
 check(probe.scope==='local-aec-speech-simulation','not speech simulation scope');
 check(probe.providerCalls===0&&probe.recognitionSenderAttached===false&&probe.releaseEligible===false,'no-provider diagnostic boundary');
 check(probe.status==='completed','native operation failed');
 // Pre-cleanup failure evidence cannot authorize completion, even with forged success.
 check(probe.captureDrainFailureObservation===undefined||probe.captureDrainFailureObservation===null,
  'retained capture drain failure observation');
 check(probe.capture?.effectiveDeviceId===request.physicalDeviceId&&probe.render?.effectiveDeviceId===request.physicalDeviceId,'actual endpoint identity');
 check(probe.capture?.countsFinal===true&&probe.capture?.framesCaptured>0&&!probe.capture?.lastError&&!probe.capture?.lastErrorCode,'final joined capture');
 check(validCaptureDrain(probe.captureDrain,probe.capture?.framesCaptured),'capture did not stay open through versioned native drain');
 check(probe.streamEvidence?.streamStartCount===1&&probe.streamEvidence?.streamDrained===true&&probe.streamEvidence?.aborted===false,'not one completed continuous stream');
 check(probe.streamEvidence?.mediaEndVoicedPhysicalFrames>=48000,'missing actually voiced media-end tail');
 check(probe.sourceMediaComplete?.passed===true&&probe.sourceMediaComplete?.endpointId===request.physicalDeviceId,'source media authority');
 const source=probe.sourceMediaComplete,receipt=source?.receipt;
 // Physical completion is collection authority only. Typed clock failures and
 // failed injector exits remain sticky even if outer status/passed are forged.
 check(source?.mediaPlaybackComplete===true&&source?.sourceEvidenceValidationPassed===true
  &&source?.sourceEvidenceValidationError===null&&source?.exitCode===0&&receipt?.passed===true
  &&receipt?.mediaPlaybackComplete===true&&receipt?.naturalRenderDrained===true
  &&receipt?.sourceClockValidationPassed===true&&receipt?.sourceClockValidationError===null
  &&receipt?.detail===null&&receipt?.diagnosticOnly===false,
 'source clock evidence rejected or failed injector receipt');
 check(probe.sourceEvidenceValidationPassed!==false&&!probe.sourceEvidenceValidationError,'retained source evidence rejection');
 check(!probe.failure&&!probe.primaryError&&!probe.cleanupError&&!probe.tapError&&!probe.streamEvidenceSealError&&!probe.sourceInjectorCleanupError&&!probe.streamAbortError,'native failure/custody/seal error');
 const mmcssVal=validateProbeMmcssAudio(probe,request);if(!mmcssVal.valid){for(const f of mmcssVal.failures)failures.push(f);}
 return {passed:failures.length===0,failures,scope:'local-aec-speech-simulation',releaseEligible:false};
}
export function finalizeSpeechOutcome(operation,tap,quality,collection){
 const processingVerified=tap?.captureProcessingVersion===1&&tap?.processingVerified===true
  &&Number.isSafeInteger(tap?.verifiedProcessingCount)&&tap.verifiedProcessingCount>0
  &&/^[a-f0-9]{64}$/u.test(tap?.terminalSha256??'')
  &&quality?.tapEvidence?.captureProcessingVersion===1&&quality?.tapEvidence?.processingVerified===true
  &&quality?.tapEvidence?.verifiedProcessingCount===tap.verifiedProcessingCount
  &&quality?.tapEvidence?.terminalSha256===tap.terminalSha256;
 const overallPassed=processingVerified&&operation?.passed===true&&tap?.passed===true&&quality?.passed===true&&quality?.status==='passed'
  &&quality?.scope==='local-aec-speech-simulation'&&quality?.releaseEligible===false&&quality?.providerCalls===0
  &&quality?.modelInputLeakageVerified===false&&quality?.semanticLeakageChainVerified===false
  &&(collection===undefined||(collection.readyForAnalysis===true&&collection.launcher?.passed===true
   &&collection.custodyValidation?.passed===true&&collection.failures?.length===0));
 return {overallPassed,status:overallPassed?'local-acoustic-simulation-passed':'failed',releaseEligible:false,
  realTranslationLifecycleVerified:false,semanticLeakageChainVerified:false};
}
/** Retain native evidence BEFORE interpreting launcher/process/operation success.
 * No device/provider/analyzer invocation. Original native files and receipt
 * bytes remain untouched; custody is parsed without adding healthy defaults.
 * Malformed/missing artifacts are failures, never synthesized receipts.
 */
export function collectLocalSpeechRunEvidence(outputDirectory,request,launchResult){
 const failures=[];
 const attempt=(area,action)=>{try{return action();}catch(error){failures.push({area,detail:error.message});return undefined;}};
 const r=launchResult??{};
 const stdout=r.stdout??'',stderr=r.stderr??'';
 attempt('launcher-stdout',()=>fs.writeFileSync(path.join(outputDirectory,'launcher.stdout.log'),stdout,{encoding:'utf8',flag:'wx'}));
 attempt('launcher-stderr',()=>fs.writeFileSync(path.join(outputDirectory,'launcher.stderr.log'),stderr,{encoding:'utf8',flag:'wx'}));
 const launcher={exitCode:r.status??null,signal:r.signal??null,error:r.error?{message:r.error.message,code:r.error.code??null}:null,
  passed:!r.error&&r.status===0&&!r.signal};
 if(!launcher.passed)failures.push({area:'launcher',detail:r.error?.message??('local desktop job failed: exit '+launcher.exitCode)});
 attempt('launcher-result',()=>write(path.join(outputDirectory,'launcher-result.json'),launcher));
 const custody=attempt('process-custody',()=>{
  if(typeof stdout!=='string')throw Error('launcher stdout is not text');
  const line=stdout.trim().split(/\r?\n/u).at(-1).replace(/^\uFEFF/u,'');
  if(Buffer.byteLength(line,'utf8')>1024*1024)throw Error('oversized process custody');
  const value=JSON.parse(line);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('process custody is not an object');
  write(path.join(outputDirectory,'process-custody.json'),value);
  return value;
 });
 const custodyValidation={passed:launcher.passed&&custody?.ownedJobExited===true&&custody?.exitCode===0,
  overallPassed:false,releaseEligible:false,validation:'launcher-and-native-owned-job-exit'};
 if(!custodyValidation.passed)failures.push({area:'owned-job',detail:'launcher/native owned job did not exit cleanly'});
 attempt('custody-validation',()=>write(path.join(outputDirectory,'process-custody-validation.json'),custodyValidation));
 const nativeReceipt=attempt('native-probe',()=>{
  const value=json(path.join(outputDirectory,'local-aec-probe-result.json'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('native probe is not an object');
  return value;
 });
 const operation=nativeReceipt&&attempt('native-operation',()=>inspectSpeechOperation(nativeReceipt,request));
 if(operation&&!operation.passed)for(const detail of operation.failures)failures.push({area:'native-operation',detail});
 const readyForAnalysis=failures.length===0&&operation?.passed===true;
 const collection={launcher,custody,custodyValidation,operation,failures,readyForAnalysis,
  overallPassed:false,releaseEligible:false,nativeReceiptRetained:nativeReceipt!==undefined};
 attempt('collection-summary',()=>write(path.join(outputDirectory,'local-speech-evidence-collection.json'),collection));
 // A failure to seal the summary must itself block analysis/acceptance.
 collection.readyForAnalysis=failures.length===0&&operation?.passed===true;
 return {...collection,nativeReceipt};
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
  '[ordered]@{uuidBios=(Get-CimInstance Win32_ComputerSystemProduct).UUID;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;user=[Environment]::UserName}|ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true,timeout:10000,env:windowsPowerShellEnvironment()}).replace(/^\uFEFF/u,''));
 if(localIdentity.uuidBios.toUpperCase()!==EXPECTED_BIOS||localIdentity.sessionId===0||localIdentity.user.toLowerCase()!=='vmuser')throw Error('this execution is not the bound interactive vm171 worker');
 const analyzer=path.resolve(options.analyzerExecutable);
 if(analyzer!==path.join(repoRoot,'target','release','omni-benchmark.exe')||sha(bytes(analyzer,512*1024*1024))!==options.analyzerSha256)throw Error('explicitly selected workspace release analyzer hash mismatch');
 const buildCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8',windowsHide:true}).trim();
 const compiledCommit=execFileSync(desktop,['--build-commit'],{encoding:'utf8',windowsHide:true,timeout:10000}).trim();
 if(compiledCommit!==buildCommit)throw Error('desktop compiled build commit differs from frozen source');
 if(execFileSync('git',['status','--porcelain'],{cwd:repoRoot,encoding:'utf8',windowsHide:true}).trim())throw Error('local speech run requires a clean frozen source commit');
 const sourceHashes=collectLocalSpeechSourceHashes(repoRoot);
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
  apiProvenance,inputWatchdogMs:LOCAL_SPEECH_BUDGETS.inputMs,ownedJobWatchdogMs:LOCAL_SPEECH_BUDGETS.ownedJobMs,outerWatchdogMs:LOCAL_SPEECH_BUDGETS.outerMs,frozenAt:new Date().toISOString()};write(path.join(outputDirectory,'run-freeze.json'),freeze);
 let outcome={schemaVersion:1,artifactKind:'local-aec-speech-simulation-result',executionId,workerId:'vm171',scope:'local-aec-speech-simulation',releaseEligible:false,
  providerCalls:0,translationProviderCalls:0,overallPassed:false,status:'failed',quality:{status:'not-run'},outputDirectory};
 try{
  const helper=path.resolve(repoRoot,AEC_PROBE_JOB_HELPER),deadlineUtc=localSpeechJobDeadline(Date.now());
  const script=localAecProbeDesktopPowerShell({executable:desktop,executableSha256:options.desktopSha256,runtimeRoot:repoRoot,outputDirectory,requestPath,
   deadlineUtc,helperPath:helper,helperSha256:sha(bytes(helper,1024*1024))});
  write(path.join(outputDirectory,'process-launch-authority.json'),{schemaVersion:1,executionId,helperSha256:sha(bytes(helper,1024*1024)),deadlineUtc,scriptSha256:sha(Buffer.from(script,'utf8'))});
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
   {encoding:'utf8',windowsHide:true,cwd:repoRoot,timeout:LOCAL_SPEECH_BUDGETS.outerMs,maxBuffer:4*1024*1024,env:windowsPowerShellEnvironment()});
  const collection=collectLocalSpeechRunEvidence(outputDirectory,request,r);
  const {nativeReceipt:probe,...evidenceCollection}=collection;
  outcome.evidenceCollection=evidenceCollection;outcome.operation=collection.operation;
  if(!collection.readyForAnalysis)throw Error(collection.failures.map(f=>f.area+': '+f.detail).join('; ')||'native evidence collection failed');
  outcome.quality=analyzeLocalAecSpeech(outputDirectory,{nativeReceipt:probe,expectedExecutionId:executionId,expectedPhysicalDeviceId:request.physicalDeviceId,
   analyzer:{workspaceRoot:repoRoot,releaseExecutablePath:analyzer,releaseExecutableSha256:options.analyzerSha256,noBuild:true}});
  write(path.join(outputDirectory,'local-speech-quality.json'),outcome.quality);
  outcome.tap={...outcome.quality.tapEvidence,passed:outcome.quality.tapEvidence?.complete===true&&outcome.quality.tapEvidence?.processingVerified===true&&outcome.quality.tapEvidence?.captureProcessingVersion===1,verification:'schema2-native-clock-PCM-seal-and-capture-processing-v1'};
  verifyLocalSpeechSourceHashes(repoRoot,sourceHashes);
  if(sha(bytes(desktop,200*1024*1024))!==options.desktopSha256||sha(bytes(injector,100*1024*1024))!==options.injectorSha256
   ||sha(bytes(analyzer,512*1024*1024))!==options.analyzerSha256)throw Error('frozen run executable changed');
  verifyApiSpeechProvenance({fixture,renderBytes:bytes(renderPath,24000*2*180),synthesisDirectory:options.synthesisDirectory,
   expectedUsageSha256:options.synthesisUsageSha256,expectedPlanFileSha256:options.synthesisPlanFileSha256});
  if(execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8',windowsHide:true}).trim()!==buildCommit
   ||execFileSync('git',['status','--porcelain'],{cwd:repoRoot,encoding:'utf8',windowsHide:true}).trim())throw Error('source commit/worktree changed during run');
  Object.assign(outcome,finalizeSpeechOutcome(outcome.operation,outcome.tap,outcome.quality,collection));
 }catch(error){outcome.failure=error.message;}
 write(path.join(outputDirectory,'local-speech-result.json'),outcome);return outcome;
}
if(isMain(import.meta.url)){
 try{const o=parseLocalSpeechArgs(process.argv.slice(2));const r=await runLocalAecSpeechSimulation(o);console.log(JSON.stringify(r,null,2));if(!r.overallPassed)process.exitCode=1;}
 catch(error){console.error(error.message);process.exitCode=1;}
}
