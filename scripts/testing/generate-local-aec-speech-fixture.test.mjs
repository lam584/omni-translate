import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSpeechSynthesisPlan, extract24kMonoPcm, generateSpeechFixture, parseSpeechFixtureArgs, SPEECH_SYNTHESIS_ENDPOINT } from './generate-local-aec-speech-fixture.mjs';
function wav(zero = false) {
  const b = Buffer.alloc(44 + 48000); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(48000, 40);
  if (!zero) for (let i = 0; i < 24000; i++) b.writeInt16LE(Math.round(9000 * Math.sin(i * .12)), 44 + i * 2);
  return b;
}
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-speech-synthesis-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return path.join(root, 'output'); }
const good = () => ({ ok: true, status: 200, json: async () => ({ request_id: 'test-request', usage: { input_tokens: 23, output_tokens: 42 }, output: { audio: { data: wav().toString('base64') } } }) });
test('freeze six bounded Chinese segments and reject budget overflow', () => {
 const p = createSpeechSynthesisPlan('one\n\ntwo'); assert.equal(p.maximumRequests, 2); assert.equal(p.maximumCharacters, 6);
 assert.match(p.planSha256, /^[a-f0-9]{64}$/); assert.throws(() => createSpeechSynthesisPlan('x'.repeat(513)), /budget/);
 assert.throws(() => createSpeechSynthesisPlan(Array(7).fill('x').join('\n\n')), /budget/);
 assert.throws(() => createSpeechSynthesisPlan('x', { voice: 'unknown' }), /fixed/);
});
test('requires paid confirmation before directory creation or dispatch', async t => {
 const out = fixture(t); let calls = 0; await assert.rejects(generateSpeechFixture({ plan: createSpeechSynthesisPlan('text'), outputDirectory: out, apiKey: 'secret' }, { fetchImpl: async () => {calls++;return good();} }), /confirmation/);
 assert.equal(calls, 0); assert.equal(fs.existsSync(out), false);
});
test('plan tampering fails before any request', async t => {
 const out = fixture(t), plan = createSpeechSynthesisPlan('text'); plan.segments[0].characters = 1;
 await assert.rejects(generateSpeechFixture({ plan, outputDirectory: out, apiKey: 'secret', confirmPaidGeneration: true }), /digest/);
 assert.equal(fs.existsSync(out), false);
});
test('one request per segment creates hashed PCM, WAV and separate synthesis usage', async t => {
 const out = fixture(t); const requests = [];
 const ledger = await generateSpeechFixture({ plan: createSpeechSynthesisPlan('first\n\nsecond'), outputDirectory: out, apiKey: 'secret', confirmPaidGeneration: true }, { fetchImpl: async (url, o) => { assert.equal(url, SPEECH_SYNTHESIS_ENDPOINT); requests.push(JSON.parse(o.body)); return good(); } });
 assert.equal(ledger.providerCalls, 2); assert.equal(ledger.automaticRetries, 0); assert.equal(ledger.translationProviderCalls, 0);
 assert.equal(ledger.status, 'completed'); assert.equal(ledger.actualBilledCurrencyAmount, null);
 assert.deepEqual(requests.map(r => r.input.text), ['first', 'second']); assert.equal(requests[0].input.language_type, 'Chinese');
 assert.equal(ledger.entries[1].pcmFrames, 24000); assert.equal(fs.statSync(path.join(out, 'zh-2.s16le')).size, 48000);
 assert.equal(fs.readFileSync(path.join(out, 'synthesis-usage.json'), 'utf8').includes('secret'), false);
});
test('HTTP failure remains charged/unknown, stops immediately and is never retried', async t => {
 const out = fixture(t); let calls = 0;
 await assert.rejects(generateSpeechFixture({ plan: createSpeechSynthesisPlan('first\n\nsecond'), outputDirectory: out, apiKey: 'secret', confirmPaidGeneration: true }, { fetchImpl: async () => { calls++; return { ok: false, status: 401 }; } }), /401/);
 const usage = JSON.parse(fs.readFileSync(path.join(out, 'synthesis-usage.json'))); assert.equal(calls, 1); assert.equal(usage.providerCalls, 1); assert.equal(usage.status, 'failed'); assert.equal(usage.entries[0].status, 'failed');
});
test('silent/invalid generated audio cannot become a usable fixture', () => {
 assert.throws(() => extract24kMonoPcm(wav(true)), /silent/); assert.throws(() => extract24kMonoPcm(Buffer.from('bad')), /RIFF/);
 const bad = wav(); bad.writeUInt32LE(16000, 24); bad.writeUInt32LE(32000, 28); assert.throws(() => extract24kMonoPcm(bad), /24kHz/);
});
test('untrusted artifact host is rejected without a download', async t => {
 const out = fixture(t); let calls = 0; await assert.rejects(generateSpeechFixture({ plan: createSpeechSynthesisPlan('text'), outputDirectory: out, apiKey: 'secret', confirmPaidGeneration: true }, { fetchImpl: async () => { calls++;return { ok: true, status: 200, json: async () => ({ output: { audio: {url: 'https://attacker.invalid/a.wav'} } }) }; } }), /allowed/);
 assert.equal(calls, 1);
});
test('failure evidence redacts the key and numeric usage excludes secret strings', async t => {
 const out = fixture(t); await assert.rejects(generateSpeechFixture({ plan: createSpeechSynthesisPlan('text'), outputDirectory: out, apiKey: 'sensitive-value', confirmPaidGeneration: true }, { fetchImpl: async () => { throw Error('failure sensitive-value'); } }), /REDACTED/);
 assert.equal(fs.readFileSync(path.join(out, 'synthesis-usage.json'), 'utf8').includes('sensitive-value'), false);
});

test('CLI has an explicit paid flag and bounded known options', () => {
 const a = parseSpeechFixtureArgs(['--confirm-paid-generation', '--credential-helper', 'helper.exe', '--output-directory', 'new-dir']);
 assert.equal(a.confirmPaidGeneration, true); assert.equal(a.outputDirectory, 'new-dir'); assert.equal(a.credentialHelper, 'helper.exe');
 assert.match(a.text, /zh-CN/); assert.throws(() => parseSpeechFixtureArgs(['--allow-unlimited']), /Unknown flag/);
});

test('prefer vendor WAV URL over bare inline PCM and retain original bytes', async t => {
 const out = fixture(t); let paid = 0, downloads = 0;
 const result = await generateSpeechFixture({plan:createSpeechSynthesisPlan('text'),outputDirectory:out,apiKey:'secret',confirmPaidGeneration:true}, {fetchImpl:async (url) => {
  if (url === SPEECH_SYNTHESIS_ENDPOINT) {paid++;return {ok:true,status:200,json:async()=>({output:{audio:{data:Buffer.from('bare-PCM').toString('base64'),url:'https://speech.oss-cn-beijing.aliyuncs.com/audio.wav'}},usage:{characters:12,secret:'secret'}})};}
  downloads++;return {ok:true,status:200,headers:new Headers({'content-length':String(wav().length)}),arrayBuffer:async()=>wav()};
 }});
 assert.equal(paid,1);assert.equal(downloads,1);assert.equal(result.providerCalls,1);assert.equal(result.entries[0].pcmFrames,24000);
 assert.deepEqual(result.entries[0].usage,{characters:12});assert.ok(fs.existsSync(path.join(out,'zh-1.api-audio.bin')));
});
test('unsupported audio retains original evidence rather than consuming another request', async t => {
 const out=fixture(t);await assert.rejects(generateSpeechFixture({plan:createSpeechSynthesisPlan('text'),outputDirectory:out,apiKey:'secret',confirmPaidGeneration:true},{fetchImpl:async()=>({ok:true,status:200,json:async()=>({output:{audio:{data:Buffer.from('not-a-wav').toString('base64')}}})})}),/RIFF/);
 assert.equal(fs.readFileSync(path.join(out,'zh-1.api-audio.bin'),'utf8'),'not-a-wav');
 const ledger=JSON.parse(fs.readFileSync(path.join(out,'synthesis-usage.json')));assert.equal(ledger.providerCalls,1);assert.equal(ledger.entries[0].originalAudioBytes,9);
});

test('official empty inline data and HTTP OSS URL are downloaded over TLS only', async t => {
 const out=fixture(t);let requests=0;
 await generateSpeechFixture({plan:createSpeechSynthesisPlan('text'),outputDirectory:out,apiKey:'secret',confirmPaidGeneration:true},{fetchImpl:async(url,o)=>{
  requests++;if(url===SPEECH_SYNTHESIS_ENDPOINT)return {ok:true,status:200,json:async()=>({output:{audio:{data:'',url:'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav?Signature=signed'}},usage:{characters:12}})};
  assert.equal(url.protocol,'https:');assert.equal(url.hostname,'dashscope-result-bj.oss-cn-beijing.aliyuncs.com');assert.equal(o.headers,undefined);
  return {ok:true,status:200,headers:new Headers(),arrayBuffer:async()=>wav()};
 }});assert.equal(requests,2);assert.equal(JSON.parse(fs.readFileSync(path.join(out,'synthesis-usage.json'))).providerCalls,1);
});
