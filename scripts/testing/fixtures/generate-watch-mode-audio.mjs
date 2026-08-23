import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  inspectPcm16MonoWav,
  normalizeStreamingWavHeader,
  resamplePcm16MonoWav,
} from './wav-fixture-utils.mjs';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(fixtureRoot, '..', '..', '..');
const integrationConfigPath = path.join(repoRoot, 'scripts', 'testing', 'llm-integration.config.json');
const endpoint = process.env.OMNI_TTS_ENDPOINT
  ?? 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const model = process.env.OMNI_TTS_MODEL ?? 'qwen-audio-3.0-tts-plus';

const fixtures = Object.freeze({
  general: {
    id: 'general',
    label: 'General news and project briefing',
    source: 'watch-mode-en-original.txt',
    reference: 'watch-mode-en-original.zh-CN.txt',
    audio: 'watch-mode-en-original.wav',
    checksum: 'watch-mode-en-original.sha256',
    voice: 'longanlingxin',
    seed: 4101,
    instruction: 'Natural neutral American English, normal conversational pace, clear but not exaggerated.',
    distribution: 'bundled',
  },
  conversation: {
    id: 'conversation',
    label: 'Everyday conversation and instructions',
    source: 'watch-mode-en-conversation.txt',
    reference: 'watch-mode-en-conversation.zh-CN.txt',
    audio: 'watch-mode-en-conversation.wav',
    checksum: 'watch-mode-en-conversation.sha256',
    voice: 'longanlufeng',
    seed: 4102,
    instruction: 'Natural friendly American English, normal conversational pace, varied questions and quotations.',
    distribution: 'generated-on-demand',
  },
  technical: {
    id: 'technical',
    label: 'Technical and public-information briefing',
    source: 'watch-mode-en-technical.txt',
    reference: 'watch-mode-en-technical.zh-CN.txt',
    audio: 'watch-mode-en-technical.wav',
    checksum: 'watch-mode-en-technical.sha256',
    voice: 'longanlingxin',
    seed: 4103,
    instruction: 'Natural professional American English, normal speaking pace, precise units and abbreviations.',
    distribution: 'generated-on-demand',
  },
});

function parseFixtureArg(argv) {
  const index = argv.indexOf('--fixture');
  const value = index === -1 ? 'all' : argv[index + 1];
  if (value === 'all') return Object.values(fixtures);
  if (!fixtures[value]) {
    throw new Error(`Unknown fixture '${value}'. Choose all, general, conversation, or technical.`);
  }
  return [fixtures[value]];
}

async function readApiKey() {
  const direct = process.env.DASHSCOPE_API_KEY ?? process.env.OMNI_TEST_DASHSCOPE_API_KEY;
  if (direct?.trim()) return direct.trim();

  let config;
  try {
    config = JSON.parse(await fs.readFile(integrationConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Set DASHSCOPE_API_KEY or provide ${integrationConfigPath}: ${error.message}`,
      { cause: error },
    );
  }
  const configuredName = config?.audio?.apiKeyEnv;
  const configuredValue = configuredName ? config?.environment?.[configuredName] : undefined;
  const fallbackValue = config?.environment?.OMNI_TEST_DASHSCOPE_API_KEY;
  const apiKey = configuredValue ?? fallbackValue;
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('No DashScope API key was found in the environment or integration config.');
  }
  return apiKey.trim();
}

async function requestAudio(apiKey, fixture) {
  const text = (await fs.readFile(path.join(fixtureRoot, fixture.source), 'utf8')).trim();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: {
        text,
        voice: fixture.voice,
        format: 'wav',
        sample_rate: 24000,
        volume: 65,
        rate: 0.95,
        pitch: 1.0,
        seed: fixture.seed,
        language_hints: ['en'],
        instruction: fixture.instruction,
      },
    }),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`DashScope returned HTTP ${response.status}: ${responseText.slice(0, 800)}`);
  }
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`DashScope returned invalid JSON: ${responseText.slice(0, 300)}`, { cause: error });
  }
  const encoded = payload?.output?.audio?.data;
  const audioUrl = payload?.output?.audio?.url;
  if (encoded) return Buffer.from(encoded, 'base64');
  if (!audioUrl) {
    throw new Error(`DashScope response did not include audio data or a URL: ${responseText.slice(0, 800)}`);
  }
  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) {
    throw new Error(`Audio download returned HTTP ${audioResponse.status}.`);
  }
  return Buffer.from(await audioResponse.arrayBuffer());
}

async function writeAtomically(targetPath, buffer) {
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, buffer);
  try {
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function generateFixture(apiKey, fixture) {
  process.stdout.write(`Generating ${fixture.id} with ${model}/${fixture.voice}...\n`);
  const providerBuffer = await requestAudio(apiKey, fixture);
  normalizeStreamingWavHeader(providerBuffer);
  const buffer = fixture.distribution === 'bundled'
    ? providerBuffer
    : resamplePcm16MonoWav(providerBuffer);
  let wav;
  try {
    wav = inspectPcm16MonoWav(buffer);
  } catch (error) {
    const header = buffer.subarray(0, 96);
    throw new Error(
      `${error.message} Payload bytes=${buffer.length}, header=${header.toString('hex')}`,
      { cause: error },
    );
  }
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  await writeAtomically(path.join(fixtureRoot, fixture.audio), buffer);
  await fs.writeFile(
    path.join(fixtureRoot, fixture.checksum),
    `${digest}  ${fixture.audio}\n`,
    'ascii',
  );
  process.stdout.write(`Generated ${fixture.audio}: ${wav.durationSeconds}s, ${wav.sampleRate} Hz\n`);
  return {
    ...fixture,
    model,
    sha256: digest,
    ...wav,
  };
}

async function main() {
  const selectedFixtures = parseFixtureArg(process.argv.slice(2));
  const apiKey = await readApiKey();
  const results = await Promise.all(selectedFixtures.map((fixture) => generateFixture(apiKey, fixture)));
  const manifestPath = path.join(fixtureRoot, 'watch-mode-audio-fixtures.json');
  let manifest = { generatedAt: null, fixtures: [] };
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    // The first successful generation creates the manifest.
  }
  const byId = new Map((manifest.fixtures ?? []).map((fixture) => [fixture.id, fixture]));
  for (const result of results) byId.set(result.id, result);
  manifest = {
    generatedAt: new Date().toISOString(),
    generator: 'Alibaba Cloud Model Studio',
    model,
    fixtures: Object.keys(fixtures).map((id) => byId.get(id)).filter(Boolean),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
