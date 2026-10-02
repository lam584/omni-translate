/**
 * Offline PRE-only acoustic landmark adapter. No metric executable, Provider,
 * device, post PCM, resampling, QPC origin, interpolation or AEC acceptance.
 *
 * analyzeLocalAecPreAlignmentDiagnostic(absoluteRunRoot, {landmarks:[{
 *   id:'source-1', referenceKind:'source'|'render', referenceStartFrame:400,
 *   frameCount:4800, preSearch:{fileStartFrame:200,frameCount:6200,
 *     range:{minFrame:100,maxFrame:800}}, captureDomain:{resetGeneration:0,continuityId:0}
 * }]})
 *
 * referenceStartFrame is a frame in the sealed SOURCE/PHYSICAL PCM FILE, not
 * a global source timestamp or linear-reference frame. preSearch uses PRE FILE
 * frames; range uses candidate starts relative to that search segment. An explicit
 * caller-selected pre segment is required; no global/default search. Device
 * indexes are mapped from queueHeadDeviceFrameIndex, never from packet/QPC or
 * appended-file assumptions. Capture and render device indexes are independent
 * domains and are NOT subtracted to manufacture a clock/latency measurement.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Absolute Windows filesystem paths are not ESM specifiers; use a file URL.
const { diagnoseAcousticAlignment, ACOUSTIC_ALIGNMENT_LIMITS: ALIGNMENT } = await import(pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'local-aec-acoustic-alignment-diagnostic.mjs')).href);
const RATE = 48_000, SCOPE = 'local-aec-speech-simulation';
export const PRE_ALIGNMENT_ADAPTER_LIMITS = Object.freeze({
  maxPcmBytes: RATE * 8 * 300, maxJsonBytes: 2 * 1024 * 1024,
  maxMetadataBytes: 32 * 1024 * 1024, maxRows: 100_000, maxRowBytes: 64 * 1024,
  maxLandmarks: 16, maxMappingBlocks: 4096,
});
const LIMIT = PRE_ALIGNMENT_ADAPTER_LIMITS;
const PRE = 'aec-pre-capture-48k-stereo.f32le', META = 'aec-frame-metadata.jsonl';
const integer = n => Number.isSafeInteger(n) && n >= 0;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (ok, message) => { if (!ok) throw Error(message); };
const boundary = () => ({ diagnosticOnly: true, qualityAcceptance: false, aecQualityAcceptance: false,
  releaseEligible: false, overallPassed: false, providerCalls: 0, deviceCalls: 0, formalMetrics: null,
  nativeClockAccuracyEstablished: false, sourceCoverageAtLeast95PercentEstablished: false });
const samePath = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function noRedirect(absolute) {
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    check(!part.includes(':'), 'alternate-stream evidence path forbidden');
    cursor = path.join(cursor, part);
    check(!fs.lstatSync(cursor).isSymbolicLink(), 'redirected evidence path');
  }
  check(samePath(fs.realpathSync.native(absolute), absolute), 'noncanonical evidence path');
}
function read(root, name, limit, expectedHash) {
  check(typeof name === 'string' && name.length > 0 && !name.includes('\0'), 'missing evidence path');
  const absolute = path.resolve(root, name), relative = path.relative(root, absolute);
  check(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'evidence path escapes run');
  noRedirect(absolute);
  const stat = fs.lstatSync(absolute);
  check(stat.isFile() && stat.size > 0 && stat.size <= limit, 'empty/oversized/nonfile evidence');
  const bytes = fs.readFileSync(absolute), after = fs.lstatSync(absolute);
  noRedirect(absolute);
  check(bytes.length === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs, 'evidence changed during read');
  if (expectedHash !== undefined) check(/^[a-f0-9]{64}$/u.test(expectedHash) && sha(bytes) === expectedHash, 'evidence SHA256 mismatch');
  return bytes;
}
const text = bytes => new TextDecoder('utf-8', {fatal:true}).decode(bytes).replace(/^\uFEFF/u, '');
const parse = bytes => JSON.parse(text(bytes));
function rows(bytes) {
  const lines = text(bytes).trim().split(/\r?\n/u);
  check(lines.length > 0 && lines.length <= LIMIT.maxRows, 'metadata row limit');
  return lines.map(line => { check(line.length > 0 && Buffer.byteLength(line) <= LIMIT.maxRowBytes, 'empty/oversized metadata row'); return JSON.parse(line); });
}
function sealed(root, descriptor, channels) {
  check(descriptor?.flushed === true && descriptor.synced === true && descriptor.error == null
    && descriptor.format === 'f32le' && descriptor.sampleRateHz === RATE && descriptor.channelCount === channels
    && integer(descriptor.frameCount) && descriptor.frameCount > 0 && descriptor.sampleCount === descriptor.frameCount * channels
    && descriptor.bytes === descriptor.sampleCount * 4, 'unsealed/unsupported PCM descriptor');
  const bytes = read(root, descriptor.path, LIMIT.maxPcmBytes, descriptor.sha256);
  check(bytes.length === descriptor.bytes, 'PCM descriptor size mismatch');
  finitePcm(bytes, channels);
  return bytes;
}
function finitePcm(bytes, channels) {
  check(bytes.length % (4 * channels) === 0, 'PCM frame alignment');
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const value = bytes.readFloatLE(offset);
    check(Number.isFinite(value) && Math.abs(value) <= ALIGNMENT.maxAbsoluteSample, 'nonfinite/extreme PCM');
  }
}
function mono(bytes, channels, start, length) {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const offset = (start + i) * channels * 4;
    samples[i] = channels === 1 ? bytes.readFloatLE(offset)
      : Math.fround((bytes.readFloatLE(offset) + bytes.readFloatLE(offset + 4)) * 0.5);
  }
  return samples;
}
const captureDomain = row => ({resetGeneration:row.resetGeneration, continuityId:row.continuityId,
  renderSessionId:row.renderSessionId ?? null, ownerGeneration:row.ownerGeneration ?? null});
function spanMap(blocks, initialGaps = []) {
  const spans = [], gaps = [...initialGaps];
  for (const block of blocks) {
    const previous = spans.at(-1), last = previous?.blocks.at(-1);
    const continuous = block.valid && last && !block.barrier && isDeepStrictEqual(block.domain, last.domain)
      && block.fileStartFrame === last.fileEndFrame && block.deviceStartFrame === last.deviceEndFrame;
    if (!block.valid) { gaps.push({reason:'invalid-index-or-discontinuity',fileStartFrame:block.fileStartFrame,fileEndFrame:block.fileEndFrame,sequence:block.sequence}); continue; }
    if (continuous) { previous.fileEndFrame = block.fileEndFrame; previous.deviceEndFrame = block.deviceEndFrame; previous.blocks.push(block); }
    else {
      if (last) gaps.push({reason:block.barrier?'reset-barrier':'domain-or-device-frame-gap',
        beforeSequence:last.sequence,afterSequence:block.sequence,preFileBoundaryFrame:block.fileStartFrame,
        previousDeviceEndFrame:last.deviceEndFrame,nextDeviceStartFrame:block.deviceStartFrame,
        previousDomain:last.domain,nextDomain:block.domain});
      spans.push({fileStartFrame:block.fileStartFrame,fileEndFrame:block.fileEndFrame,
        deviceStartFrame:block.deviceStartFrame,deviceEndFrame:block.deviceEndFrame,domain:block.domain,blocks:[block]});
    }
  }
  return {spans,gaps};
}
function preEvidence(root, probe) {
  const terminalBytes = read(root, 'aec-terminal.json', LIMIT.maxJsonBytes), terminal = parse(terminalBytes);
  check(!fs.existsSync(path.join(root,'aec-terminal.json.partial')) && terminal.schemaVersion === 2 && terminal.kind === 'terminal'
    && terminal.status === 'complete' && terminal.complete === true && terminal.countsFinal === true
    && terminal.hashAlgorithm === 'sha256' && terminal.terminalFile === 'aec-terminal.json'
    && Array.isArray(terminal.errors) && terminal.errors.length === 0 && terminal.droppedEvents === 0
    && isDeepStrictEqual(probe.tap,terminal), 'old/incomplete/error/unbound tap terminal');
  const lanes = {};
  for (const [key,name,limit] of [['pre',PRE,LIMIT.maxPcmBytes],['metadata',META,LIMIT.maxMetadataBytes]]) {
    const entry = terminal.files?.[key];
    check(entry?.name === name && entry.flushed === true && entry.synced === true && entry.unwrittenBufferedBytes === 0, 'unsealed/wrong pre or metadata lane');
    lanes[key] = read(root,name,limit,entry.sha256);
    check(entry.byteLength === lanes[key].length, 'tap lane size mismatch');
  }
  finitePcm(lanes.pre,2);
  const metadata = rows(lanes.metadata), preFrames = lanes.pre.length / 8;
  check(terminal.writtenEvents === metadata.length && terminal.attemptedEvents === metadata.length
    && terminal.acceptedEvents === metadata.length && terminal.lastWrittenSequence === metadata.length - 1
    && terminal.sampleCounts?.pre === preFrames * 2, 'tap sealed accounting mismatch');
  let previousFileEnd = 0, barrier = false, captures = 0, resets = 0;
  const blocks = [], gaps = [];
  for (const [i,row] of metadata.entries()) {
    check(row?.schemaVersion === 3 && row.sequence === i && integer(row.resetGeneration) && integer(row.continuityId), 'old/invalid frame metadata schema/index');
    if (row.kind === 'reset') { barrier = true; resets++; continue; }
    if (row.kind === 'render-reference') continue; // Never read the linear tap PCM.
    check(row.kind === 'capture' && row.sampleRateHz === RATE && row.channelCount === 2
      && integer(row.preSampleOffset) && row.preSampleOffset % 2 === 0 && integer(row.preSampleCount)
      && row.preSampleCount > 0 && row.preSampleCount % 2 === 0, 'capture PCM/rate/index metadata unsupported');
    const start = row.preSampleOffset / 2, end = start + row.preSampleCount / 2;
    check(start >= previousFileEnd && end <= preFrames, 'capture pre-file overlap/out-of-bounds');
    if (start > previousFileEnd) gaps.push({reason:'unmapped-pre-file-gap',fileStartFrame:previousFileEnd,fileEndFrame:start});
    const valid = row.queueHeadClockValid === true && integer(row.queueHeadDeviceFrameIndex)
      && integer(row.queueHeadDeviceFrameIndex + end - start)
      && (row.renderSessionId == null || integer(row.renderSessionId)) && (row.ownerGeneration == null || integer(row.ownerGeneration))
      && row.timestampError === false && row.dataDiscontinuity === false;
    blocks.push({sequence:row.sequence,fileStartFrame:start,fileEndFrame:end,
      deviceStartFrame:valid?row.queueHeadDeviceFrameIndex:null,deviceEndFrame:valid?row.queueHeadDeviceFrameIndex+end-start:null,
      domain:captureDomain(row),valid,barrier,metadata:row});
    previousFileEnd = end; barrier = !valid; captures++;
  }
  if (previousFileEnd < preFrames) gaps.push({reason:'unmapped-pre-file-tail',fileStartFrame:previousFileEnd,fileEndFrame:preFrames});
  check(captures > 0 && terminal.eventCounts?.capture === captures && terminal.eventCounts?.reset === resets, 'tap capture/reset accounting mismatch');
  return {bytes:lanes.pre,terminalSha256:sha(terminalBytes),preSha256:sha(lanes.pre),metadataSha256:sha(lanes.metadata),...spanMap(blocks,gaps)};
}
function referenceEvidence(root, probe, events) {
  const complete = probe.sourceMediaComplete, start = probe.sourceMediaStarted ?? probe.sourceMediaStart;
  check(complete?.spawnedByNative === true && complete.providerCalls === 0 && [0,1].includes(complete.exitCode)
    && start?.executionId === probe.executionId && start.physicalDeviceId === probe.capture.effectiveDeviceId
    && integer(start.processId) && start.processId > 0, 'source is not same-run native-owned media');
  check(events.filter(e=>e.kind==='source-media-started').length === 1
    && isDeepStrictEqual(events.find(e=>e.kind==='source-media-started').boundStart,start)
    && events.filter(e=>e.kind==='source-media-complete').length === 1
    && isDeepStrictEqual(events.find(e=>e.kind==='source-media-complete').boundReceipt,complete), 'source receipt not bound to native journal');
  const receiptBytes = read(root,'local-aec-source-media-receipt.json',LIMIT.maxJsonBytes,complete.sha256), receipt = parse(receiptBytes);
  check(isDeepStrictEqual(receipt,complete.receipt) && receipt.processId === start.processId
    && receipt.endpointId === start.physicalDeviceId && complete.endpointId === receipt.endpointId
    && receipt.renderSampleRateHz === RATE && receipt.diagnosticOnly === false
    && receipt.mediaPlaybackComplete === true && receipt.naturalRenderDrained === true && complete.mediaPlaybackComplete === true
    && typeof receipt.passed === 'boolean' && typeof receipt.sourceClockValidationPassed === 'boolean'
    && typeof complete.sourceEvidenceValidationPassed === 'boolean', 'old/incomplete/foreign source receipt');
  check(complete.sourcePcmFormat === 'f32le' && complete.sourcePcmSampleRateHz === RATE && complete.sourcePcmChannelCount === 1
    && integer(complete.sourcePcmFrames) && complete.sourcePcmFrames > 0 && complete.sourcePcmBytes === complete.sourcePcmFrames * 4
    && integer(receipt.renderedFrames) && receipt.renderedFrames > 0 && integer(receipt.postrollSilenceFrames)
    && receipt.renderedFrames + receipt.postrollSilenceFrames === complete.sourcePcmFrames, 'source PCM format/frame authority missing');
  const sourceBytes = read(root,receipt.sourcePcm48kMonoPath,LIMIT.maxPcmBytes,complete.sourcePcmSha256);
  check(sourceBytes.length === complete.sourcePcmBytes, 'source PCM size mismatch'); finitePcm(sourceBytes,1);
  const physicalBytes = sealed(root,probe.streamEvidence?.physical,2);
  const physicalRows = events.filter(e=>e.kind==='physical-render'), physicalBlocks = [];
  let fileFrame = 0;
  check(physicalRows.length > 0 && probe.streamEvidence.streamStartCount === 1, 'unsupported/missing physical render ownership');
  for (const row of physicalRows) {
    check(row.endpointId === receipt.endpointId && row.sampleRateHz === RATE && row.channelCount === 2
      && integer(row.physicalStartFrame) && integer(row.physicalEndFrame) && row.physicalEndFrame > row.physicalStartFrame
      && integer(row.renderSessionId) && integer(row.ownerGeneration) && typeof row.rendererInstanceId === 'string'
      && row.rendererInstanceId.length > 0, 'physical render frame/domain metadata missing');
    const frames = row.physicalEndFrame - row.physicalStartFrame, next = fileFrame + frames;
    check(next <= physicalBytes.length / 8 && sha(physicalBytes.subarray(fileFrame*8,next*8)) === row.physicalPcmSha256, 'wrong physical reference chunk/hash');
    physicalBlocks.push({sequence:row.sequence,fileStartFrame:fileFrame,fileEndFrame:next,
      deviceStartFrame:row.physicalStartFrame,deviceEndFrame:row.physicalEndFrame,
      domain:{renderSessionId:row.renderSessionId,ownerGeneration:row.ownerGeneration,rendererInstanceId:row.rendererInstanceId,
        resetGeneration:row.resetGeneration ?? null,continuityId:row.continuityId ?? null},
      valid:row.dataDiscontinuity!==true,barrier:row.kind==='reset',metadata:row});
    fileFrame = next;
  }
  check(fileFrame * 8 === physicalBytes.length, 'unmapped physical reference frames');
  return {sourceBytes,physicalBytes,physicalMap:spanMap(physicalBlocks),sourceAuthority:{
    executionId:probe.executionId,endpointId:receipt.endpointId,processId:receipt.processId,
    receiptSha256:sha(receiptBytes),pcmSha256:sha(sourceBytes),pcmFrames:complete.sourcePcmFrames,
    exitCode:complete.exitCode,passed:complete.passed,sourceEvidenceValidationPassed:complete.sourceEvidenceValidationPassed,
    sourceEvidenceValidationError:complete.sourceEvidenceValidationError ?? null,
    receiptPassed:receipt.passed,sourceClockValidationPassed:receipt.sourceClockValidationPassed,
    sourceClockValidationError:receipt.sourceClockValidationError ?? null,detail:receipt.detail ?? null,
    physicalCompletionIsNotClockAcceptance:true}};
}
function compact(map) { return {spans:map.spans.map(({blocks,...span})=>({...span,sequences:blocks.map(b=>b.sequence)})),gaps:map.gaps}; }
function contained(map,start,end) { return map.spans.find(s=>start>=s.fileStartFrame&&end<=s.fileEndFrame); }
function mapping(span,start,end) {
  const blocks = span.blocks.filter(b=>b.fileEndFrame>start&&b.fileStartFrame<end);
  check(blocks.length <= LIMIT.maxMappingBlocks, 'mapping block budget exceeded');
  return {fileStartFrame:start,fileEndFrame:end,deviceStartFrame:span.deviceStartFrame+start-span.fileStartFrame,
    deviceEndFrame:span.deviceStartFrame+end-span.fileStartFrame,domain:span.domain,blocks};
}
function landmark(request,pre,reference) {
  const base = {...boundary(),request,status:'indeterminate',reason:'unsupported-landmark',location:null};
  try {
    check(request && typeof request.id === 'string' && /^[a-zA-Z0-9._-]{1,64}$/u.test(request.id)
      && ['source','render'].includes(request.referenceKind) && integer(request.referenceStartFrame)
      && integer(request.frameCount) && request.frameCount >= RATE * 0.1 && request.frameCount <= ALIGNMENT.maxTemplateFrames, 'unsupported landmark kind/start/size');
    const physical = request.referenceKind === 'render', bytes = physical?reference.physicalBytes:reference.sourceBytes;
    check(request.referenceStartFrame+request.frameCount <= bytes.length/(physical?8:4), 'reference landmark out-of-bounds');
    let referenceMapping;
    if (physical) {
      const span = contained(reference.physicalMap,request.referenceStartFrame,request.referenceStartFrame+request.frameCount);
      check(span, 'physical landmark crosses domain/gap/discontinuity');
      referenceMapping = mapping(span,request.referenceStartFrame,request.referenceStartFrame+request.frameCount);
      if (request.renderDomain) check(isDeepStrictEqual(request.renderDomain,span.domain), 'wrong physical reference domain');
    } else referenceMapping = {fileStartFrame:request.referenceStartFrame,fileEndFrame:request.referenceStartFrame+request.frameCount,
      deviceStartFrame:null,deviceEndFrame:null,domain:reference.sourceAuthority};
    const search = request.preSearch;
    check(search && typeof search === 'object', 'explicit caller pre search window required');
    check(integer(search.fileStartFrame)&&integer(search.frameCount)&&search.frameCount<=ALIGNMENT.maxCaptureFrames
      &&search.frameCount>=request.frameCount+2, 'pre search size/start unsupported');
    const span = contained(pre,search.fileStartFrame,search.fileStartFrame+search.frameCount);
    check(span, 'pre search crosses domain/gap/discontinuity');
    if (request.captureDomain) {
      check(request.captureDomain.resetGeneration===span.domain.resetGeneration&&request.captureDomain.continuityId===span.domain.continuityId
        && (request.captureDomain.renderSessionId===undefined||request.captureDomain.renderSessionId===span.domain.renderSessionId)
        && (request.captureDomain.ownerGeneration===undefined||request.captureDomain.ownerGeneration===span.domain.ownerGeneration), 'wrong capture search domain');
    }
    const range = search.range ?? {minFrame:0,maxFrame:search.frameCount-request.frameCount};
    const preMapping = mapping(span,search.fileStartFrame,search.fileStartFrame+search.frameCount);
    const result = diagnoseAcousticAlignment({template:mono(bytes,physical?2:1,request.referenceStartFrame,request.frameCount),
      preCapture:mono(pre.bytes,2,search.fileStartFrame,search.frameCount),sampleRate:RATE,referenceKind:request.referenceKind,range});
    return {...base,status:result.status,reason:result.reason,alignment:result,referenceMapping,preMapping,search:{...search,range},
      location:result.status==='located'?{segmentOffsetFrames:result.offsetFrames,
        preFileFrameIndex:search.fileStartFrame+result.offsetFrames,
        queueHeadDeviceFrameIndex:preMapping.deviceStartFrame+result.offsetFrames,captureDomain:span.domain}:null};
  } catch (error) { return {...base,reason:error.message}; }
}
export function analyzeLocalAecPreAlignmentDiagnostic(runRoot,options={}) {
  const report = {...boundary(),artifactKind:'local-aec-pre-alignment-diagnostic',schemaVersion:1,
    status:'indeterminate',runRoot,landmarks:[],unknown:[]};
  try {
    check(typeof runRoot==='string'&&path.isAbsolute(runRoot), 'absolute run root required');
    const root = path.resolve(runRoot); noRedirect(root); check(fs.statSync(root).isDirectory(), 'run root is not a directory');
    check(Array.isArray(options.landmarks)&&options.landmarks.length>0&&options.landmarks.length<=LIMIT.maxLandmarks
      &&new Set(options.landmarks.map(l=>l?.id)).size===options.landmarks.length, 'bounded unique caller landmarks required');
    const probeBytes = read(root,'local-aec-probe-result.json',LIMIT.maxJsonBytes), probe = parse(probeBytes);
    check(probe?.schemaVersion===2&&probe.artifactKind==='watch-mode-local-aec-probe'&&probe.scope===SCOPE
      &&probe.executionId===path.basename(root)&&probe.providerCalls===0&&probe.recognitionSenderAttached===false&&probe.releaseEligible===false
      &&probe.capture?.countsFinal===true&&probe.capture.sampleRateHz===RATE&&probe.capture.channelCount===2
      &&typeof probe.capture.effectiveDeviceId==='string'&&probe.capture.effectiveDeviceId.length>0
      &&probe.render?.effectiveDeviceId===probe.capture.effectiveDeviceId, 'old/incomplete/foreign native run receipt');
    const eventSeal = probe.streamEvidence?.events;
    check(eventSeal?.flushed===true&&eventSeal.synced===true&&eventSeal.error==null, 'unsealed native stream journal');
    const eventBytes = read(root,eventSeal.path,LIMIT.maxMetadataBytes,eventSeal.sha256), events = rows(eventBytes);
    check(events.length===eventSeal.eventCount&&events.every((e,i)=>e.sequence===i&&e.scope===SCOPE), 'native stream journal sequence/scope/count');
    const pre = preEvidence(root,probe), reference = referenceEvidence(root,probe,events);
    report.evidence={probeSha256:sha(probeBytes),terminalSha256:pre.terminalSha256,preSha256:pre.preSha256,
      metadataSha256:pre.metadataSha256,physicalSha256:sha(reference.physicalBytes),eventsSha256:sha(eventBytes),source:reference.sourceAuthority};
    report.preTopology=compact(pre);report.physicalTopology=compact(reference.physicalMap);
    report.landmarks=options.landmarks.map(request=>landmark(request,pre,reference));
    report.status=report.landmarks.every(l=>l.status==='located')?'diagnostic-located':'indeterminate';
  } catch(error) { report.unknown.push(error.message); }
  return report;
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args=process.argv.slice(2);
    check(args.length===4&&args[0]==='--run-root'&&args[2]==='--landmarks-json'&&Buffer.byteLength(args[3])<=64*1024,
      'usage: --run-root ABSOLUTE_RUN_DIRECTORY --landmarks-json JSON_ARRAY');
    console.log(JSON.stringify(analyzeLocalAecPreAlignmentDiagnostic(args[1],{landmarks:JSON.parse(args[3])}),null,2));
  } catch(error) { console.log(JSON.stringify({...boundary(),status:'indeterminate',unknown:[error.message]})); process.exitCode=1; }
}
