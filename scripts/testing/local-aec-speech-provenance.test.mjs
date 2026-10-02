import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyApiSpeechProvenance } from './local-aec-speech-provenance.mjs';
import { createSpeechSynthesisPlan } from './generate-local-aec-speech-fixture.mjs';
import { assembleLocalSpeechFixture } from './local-aec-speech-fixture.mjs';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function wav(i=1){const b=Buffer.alloc(44+4800);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(4800,40);for(let n=44;n<b.length;n+=2)b.writeInt16LE(i*200,n);return b;}
function sample(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'aec-api-custody-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const dir=path.join(root,'api');fs.mkdirSync(dir);const plan=createSpeechSynthesisPlan(Array.from({length:6},(_,i)=>`test segment ${i}`).join('\n\n'));const entries=plan.segments.map((s,i)=>{const raw=wav(i+1),pcm=raw.subarray(44),id=s.id;for(const [file,data]of [[id+'.api-audio.bin',raw],[id+'.wav',raw],[id+'.s16le',pcm]])fs.writeFileSync(path.join(dir,file),data);return {status:'completed',httpStatus:200,segmentId:id,inputTextSha256:s.textSha256,requestedCharacters:s.characters,responseRequestId:`aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa${i}`,dispatchedAt:`2026-10-02T00:00:0${i}.000Z`,completedAt:`2026-10-02T00:00:0${i}.500Z`,originalAudioFile:id+'.api-audio.bin',originalAudioSha256:sha(raw),originalAudioBytes:raw.length,wavFile:id+'.wav',wavSha256:sha(raw),pcmFile:id+'.s16le',pcmSha256:sha(pcm),pcmFrames:2400,sampleRate:24000,channels:1,bitsPerSample:16};});const ledger={schemaVersion:1,artifactKind:'local-aec-speech-synthesis-usage',provider:'dashscope',model:plan.model,planSha256:plan.planSha256,status:'completed',providerCalls:6,translationProviderCalls:0,automaticRetries:0,requestedCharacters:plan.maximumCharacters,entries};fs.writeFileSync(path.join(dir,'synthesis-plan.json'),JSON.stringify(plan));const persist=()=>fs.writeFileSync(path.join(dir,'synthesis-usage.json'),JSON.stringify(ledger));persist();const source=path.join(root,'source.wav');fs.writeFileSync(source,wav());const out=path.join(root,'fixture');const fixture=assembleLocalSpeechFixture({synthesisDirectory:dir,sourceWavPath:source,outputDirectory:out});const args={fixture,renderBytes:fs.readFileSync(path.join(out,'translation-stream.s16le')),synthesisDirectory:dir,expectedUsageSha256:sha(fs.readFileSync(path.join(dir,'synthesis-usage.json'))),expectedPlanFileSha256:sha(fs.readFileSync(path.join(dir,'synthesis-plan.json')))};return {args,ledger,persist,dir,repin(){persist();args.expectedUsageSha256=sha(fs.readFileSync(path.join(dir,'synthesis-usage.json')));fixture.synthesisUsageSha256=args.expectedUsageSha256;}};}
test('six recorded API responses, raw audio/WAV/PCM and every complete cue bound to campaign hashes',t=>{const f=sample(t),r=verifyApiSpeechProvenance(f.args);assert.equal(r.complete,true);assert.equal(r.synthesisRequests,6);assert.equal(r.files.length,18);assert.equal(r.requestIds.length,6);assert.equal(r.vendorAttestation,false);});
for(const [name,mutate] of [
 ['ledger changed after campaign pin',f=>{f.ledger.providerCalls=0;f.persist();}],
 ['missing sixth call',f=>{f.ledger.entries.pop();f.repin();}],
 ['failed generation reported complete',f=>{f.ledger.entries[5].status='failed';f.repin();}],
 ['missing cue mapping',f=>{f.args.fixture.segments=f.args.fixture.segments.filter(s=>s.cueId!=='zh-6');}],
 ['undeclared nonzero prefix despite preserved six cues',f=>{f.args.renderBytes=Buffer.concat([Buffer.from([1,0]),f.args.renderBytes]);for(const s of f.args.fixture.segments){s.startFrame+=1;s.endFrame+=1;}f.args.fixture.translation.frames+=1;f.args.fixture.translation.sha256=sha(f.args.renderBytes);}],
 ['overlapping cue map',f=>{f.args.fixture.segments[1].startFrame-=1;}],
 ['fractional cue position',f=>{f.args.fixture.segments[0].startFrame=.5;}],
 ['missing explicit pause record',f=>{f.args.fixture.segments=f.args.fixture.segments.filter(s=>s.kind!=='explicit-model-output-pause');}],
 ['out-of-range final span',f=>{f.args.fixture.segments.at(-1).endFrame+=1;}],
 ['no API calls relabelled as new',f=>{f.ledger.providerCalls=0;f.repin();}],
 ['duplicate response identity',f=>{f.ledger.entries[5].responseRequestId=f.ledger.entries[0].responseRequestId;f.repin();}],
 ['missing recorded response',f=>{f.ledger.entries[5].responseRequestId=null;f.repin();}],
 ['synthetic success without HTTP response',f=>{delete f.ledger.entries[0].httpStatus;f.repin();}],
 ['generation after fixture assembly',f=>{f.ledger.entries[5].completedAt='2100-01-01T00:00:00Z';f.repin();}],
 ['missing original API bytes',f=>fs.unlinkSync(path.join(f.dir,'zh-6.api-audio.bin'))],
 ['tampered returned audio',f=>fs.appendFileSync(path.join(f.dir,'zh-6.api-audio.bin'),Buffer.from([0]))],
 ['relabelled original bytes not deriving PCM',f=>{const b=wav(7);fs.writeFileSync(path.join(f.dir,'zh-6.api-audio.bin'),b);f.ledger.entries[5].originalAudioSha256=sha(b);f.repin();}],
 ['cut final generated cue',f=>{f.args.fixture.segments.filter(s=>s.kind==='speech').at(-1).endFrame-=1;}],
 ['wrong source text attribution',f=>{f.ledger.entries[5].inputTextSha256='0'.repeat(64);f.repin();}],
 ['missing explicit generation pin',f=>{delete f.args.expectedUsageSha256;}]
])test(`reject ${name}`,t=>{const f=sample(t);mutate(f);assert.throws(()=>verifyApiSpeechProvenance(f.args));});
