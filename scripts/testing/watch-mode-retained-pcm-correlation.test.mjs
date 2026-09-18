import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { analyzeRetainedPcmCorrelation } from './watch-mode-retained-pcm-correlation.mjs';

const RATE = 16_000;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function pcm(samples) {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), index * 2));
  return bytes;
}
function tone(seconds, hz, gain = 0.4, phase = 0) {
  return Array.from({ length: seconds * RATE }, (_, i) => Math.sin(2 * Math.PI * hz * i / RATE + phase) * gain);
}
function fixture(t, { provider, source, translated, cueStartMs = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-pcm-correlation-'));
  const translatedRoot = path.join(root, 'translated-cue-pcm');
  const cueRoot = path.join(translatedRoot, 'cue-pcm');
  fs.mkdirSync(cueRoot, { recursive: true });
  const startedAtMs = 1_800_000_000_000;
  const sourceBytes = pcm(source ?? tone(4, 311));
  const providerBytes = pcm(provider ?? source ?? tone(4, 311));
  const translatedBytes = pcm(translated ?? tone(4, 733));
  fs.writeFileSync(path.join(root, 'source-media-reference-16k-mono.pcm'), sourceBytes);
  fs.writeFileSync(path.join(root, 'provider-input-16k-mono.pcm'), providerBytes);
  fs.writeFileSync(path.join(root, 'playback.json'), JSON.stringify({ passed: true, startedAtMs, mediaSha256: 'a'.repeat(64) }));
  const relativePath = 'cue-pcm/cue-0001.pcm';
  fs.writeFileSync(path.join(translatedRoot, relativePath), translatedBytes);
  fs.writeFileSync(path.join(translatedRoot, 'translated-cue-pcm-summary.json'), JSON.stringify({
    schemaVersion: 2, artifactKind: 'watch-mode-translated-cue-pcm-authority', finalized: true,
    activeStreamCount: 0, pcmFormat: 's16le', maxProviderInputSamples: providerBytes.length / 2,
    cellId: 'c03', leaseId: 'lease', runMarker: 'run', acceptedCues: [{ sequence: 1, cueId: 'cue-1',
      createdAtMs: startedAtMs + cueStartMs, sampleRateHz: RATE, channelCount: 1,
      sampleCount: translatedBytes.length / 2, bytes: translatedBytes.length,
      sha256: sha(translatedBytes), relativePath }]
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, authority: path.join(translatedRoot, 'translated-cue-pcm-summary.json'), cue: path.join(translatedRoot, relativePath) };
}

const options = root => ({ runDirectory: root, windowMs: 1000, hopMs: 1000, maxLagMs: 100,
  lagStepMs: 10, confidenceFloor: 0.2, dominanceMargin: 0.1 });

test('classifies source-dominant and translated-render-dominant retained windows', (t) => {
  const source = tone(4, 311);
  const translated = tone(4, 733);
  const provider = [...source.slice(0, 2 * RATE), ...translated.slice(2 * RATE)];
  const f = fixture(t, { source, translated, provider });
  const result = analyzeRetainedPcmCorrelation(options(f.root));
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.gateEligible, false);
  assert.equal(result.timelineAuthority, 'approximate-createdAtMs-relative-to-playback-start');
  assert.deepEqual(result.windows.map(window => window.classification), [
    'source-dominant', 'source-dominant', 'translation-dominant', 'translation-dominant'
  ]);
  assert.equal(result.counts['source-dominant'], 2);
  assert.equal(result.counts['translation-dominant'], 2);
  assert.match(result.receipts.provider.sha256, /^[a-f0-9]{64}$/u);
});

test('reports silence and low-confidence evidence without turning either into a verdict', (t) => {
  const source = tone(3, 311), translated = tone(3, 733);
  const unrelated = tone(1, 1091, 0.4, 0.37);
  const provider = [...new Array(RATE).fill(0), ...unrelated, ...source.slice(2 * RATE, 3 * RATE).map((v, i) => (v + translated[2 * RATE + i]) * 0.5)];
  const f = fixture(t, { source, translated, provider });
  const result = analyzeRetainedPcmCorrelation(options(f.root));
  assert.equal(result.windows[0].classification, 'silence');
  assert.equal(result.windows[0].silent, true);
  assert.equal(result.windows[1].classification, 'inconclusive');
  assert.equal(result.windows[1].lowConfidence, true);
  assert.equal(result.windows[1].inconclusive, true);
  assert.equal(result.windows[2].classification, 'inconclusive', 'near-equal competing references remain inconclusive');
});

test('bounded lag finds a delayed translated reference and reports the lag', (t) => {
  const translated = tone(3, 733); const source = tone(3, 311);
  const delay = 80 * RATE / 1000;
  const provider = [...new Array(delay).fill(0), ...translated].slice(0, 3 * RATE);
  const f = fixture(t, { source, translated, provider });
  const result = analyzeRetainedPcmCorrelation(options(f.root));
  assert.equal(result.windows[1].classification, 'translation-dominant');
  assert.ok(Math.abs(result.windows[1].translationLagMs + 80) <= 10);
});

test('fails closed on translated cue hash, traversal, PCM format and provider budget violations', (t) => {
  const cases = [
    f => fs.appendFileSync(f.cue, Buffer.from([0, 0])),
    f => { const value = JSON.parse(fs.readFileSync(f.authority, 'utf8')); value.acceptedCues[0].relativePath = '../escaped.pcm'; fs.writeFileSync(f.authority, JSON.stringify(value)); },
    f => { const value = JSON.parse(fs.readFileSync(f.authority, 'utf8')); value.acceptedCues[0].channelCount = 2; fs.writeFileSync(f.authority, JSON.stringify(value)); },
    f => { const value = JSON.parse(fs.readFileSync(f.authority, 'utf8')); value.maxProviderInputSamples -= 1; fs.writeFileSync(f.authority, JSON.stringify(value)); }
  ];
  for (const mutate of cases) {
    const f = fixture(t); mutate(f);
    assert.throws(() => analyzeRetainedPcmCorrelation(options(f.root)), /evidence invalid/u);
  }
});

test('rejects odd-length PCM and unsafe analysis bounds', (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.root, 'provider-input-16k-mono.pcm'), Buffer.from([1]));
  assert.throws(() => analyzeRetainedPcmCorrelation(options(f.root)), /frame-aligned/u);
  assert.throws(() => analyzeRetainedPcmCorrelation({ ...options(f.root), windowMs: 20_000 }), /windowMs/u);
  assert.throws(() => analyzeRetainedPcmCorrelation({ ...options(f.root), runDirectory: 'relative' }), /absolute/u);
});
