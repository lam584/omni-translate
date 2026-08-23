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
const multilingualRoot = path.join(fixtureRoot, 'multilingual');
const repoRoot = path.resolve(fixtureRoot, '..', '..', '..');
const integrationConfigPath = path.join(repoRoot, 'scripts', 'testing', 'llm-integration.config.json');
const dashscopeTtsEndpoint = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const dashscopeChatEndpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const translationModel = process.env.OMNI_FIXTURE_TRANSLATION_MODEL ?? 'qwen3.6-flash';
const ttsModel = 'qwen-audio-3.0-tts-plus';
const ttsVoice = 'longanlingxin';

const languages = Object.freeze([
  { code: 'zh-CN', name: 'Simplified Chinese', hint: 'zh', rate: 0.95 },
  { code: 'es', name: 'Spanish', hint: 'es', rate: 1.1 },
  { code: 'ar', name: 'Modern Standard Arabic', hint: 'ar', rate: 1.3 },
  { code: 'pt', name: 'Portuguese', hint: 'pt', rate: 1.15 },
  { code: 'ru', name: 'Russian', hint: 'ru', rate: 1.05 },
  { code: 'hi', name: 'Hindi' },
  { code: 'bn', name: 'Bengali (India)' },
  { code: 'de', name: 'German', hint: 'de', rate: 1.05 },
  { code: 'id', name: 'Indonesian', hint: 'id', rate: 1.15 },
  { code: 'ko', name: 'Korean', hint: 'ko', rate: 1.1 },
  { code: 'fr', name: 'French', hint: 'fr' },
  { code: 'vi', name: 'Vietnamese', hint: 'vi' },
  { code: 'ja', name: 'Japanese', hint: 'ja', rate: 1.15 },
  { code: 'te', name: 'Telugu', rate: 1.4 },
  { code: 'ta', name: 'Tamil', rate: 2 },
  { code: 'mr', name: 'Marathi' },
  { code: 'th', name: 'Thai', hint: 'th', rate: 1.3 },
  { code: 'fil', name: 'Filipino', hint: 'fil', rate: 1.2 },
  { code: 'tr', name: 'Turkish', rate: 1.1 },
]);

function parseArgs(argv) {
  const languageIndex = argv.indexOf('--languages');
  const selected = languageIndex === -1 || argv[languageIndex + 1] === 'all'
    ? null
    : new Set(argv[languageIndex + 1].split(',').map((item) => item.trim()).filter(Boolean));
  const unknown = selected
    ? [...selected].filter((code) => !languages.some((language) => language.code === code))
    : [];
  if (unknown.length) throw new Error(`Unsupported language codes: ${unknown.join(', ')}`);
  return {
    selectedLanguages: selected ? languages.filter((language) => selected.has(language.code)) : languages,
    refreshText: argv.includes('--refresh-text'),
    textOnly: argv.includes('--text-only'),
    audioOnly: argv.includes('--audio-only'),
  };
}

async function readApiKey() {
  const direct = process.env.DASHSCOPE_API_KEY ?? process.env.OMNI_TEST_DASHSCOPE_API_KEY;
  if (direct?.trim()) return direct.trim();
  const config = JSON.parse(await fs.readFile(integrationConfigPath, 'utf8'));
  const configuredName = config?.audio?.apiKeyEnv;
  const apiKey = (configuredName ? config?.environment?.[configuredName] : undefined)
    ?? config?.environment?.OMNI_TEST_DASHSCOPE_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('No DashScope API key was found in the environment or integration config.');
  }
  return apiKey.trim();
}

function textPath(language) {
  return path.join(multilingualRoot, `watch-mode-general.${language.code}.txt`);
}

function audioPath(language) {
  return path.join(multilingualRoot, `watch-mode-general.${language.code}.wav`);
}

async function translateText(apiKey, sourceText, language) {
  if (language.code === 'zh-CN') {
    return (await fs.readFile(path.join(fixtureRoot, 'watch-mode-en-original.zh-CN.txt'), 'utf8')).trim();
  }
  const response = await fetch(dashscopeChatEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: translationModel,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a professional ${language.name} translator preparing a speech-recognition benchmark. Return valid JSON only.`,
        },
        {
          role: 'user',
          content: [
            `Translate the English benchmark below into natural spoken ${language.name}.`,
            'Preserve every fact, proper name, number, date, amount, unit, quoted question, abbreviation, and paragraph.',
            language.code === 'te'
              ? 'Use concise natural phrasing, preserve all benchmark facts, and keep the translation near 1,250 Telugu characters.'
              : 'Do not summarize, explain, add headings, or add content. Aim for roughly two minutes at a normal native speaking pace.',
            'Return exactly one JSON object with a single string field named "translation".',
            '',
            sourceText,
          ].join('\n'),
        },
      ],
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Translation for ${language.code} failed (${response.status}): ${body.slice(0, 500)}`);
  const payload = JSON.parse(body);
  const content = payload?.choices?.[0]?.message?.content;
  const translated = JSON.parse(content)?.translation;
  if (typeof translated !== 'string' || translated.trim().length < 300) {
    throw new Error(`Translation for ${language.code} was missing or unexpectedly short.`);
  }
  return translated.trim();
}

async function ensureTranslation(apiKey, sourceText, language, refreshText) {
  const target = textPath(language);
  if (!refreshText) {
    try {
      const existing = (await fs.readFile(target, 'utf8')).trim();
      if (existing) return existing;
    } catch {
      // Missing translations are generated below.
    }
  }
  process.stdout.write(`Translating general template to ${language.code}...\n`);
  const translated = await translateText(apiKey, sourceText, language);
  await fs.writeFile(target, `${translated}\n`, 'utf8');
  return translated;
}

async function requestQwenAudio(apiKey, text, language) {
  const input = {
    text,
    voice: ttsVoice,
    format: 'wav',
    sample_rate: 24000,
    volume: 65,
    rate: language.rate ?? 0.95,
    pitch: 1,
    seed: 5200,
    instruction: `Natural neutral ${language.name} news-style delivery at a normal human speaking pace.`,
  };
  if (language.hint) input.language_hints = [language.hint];
  const response = await fetch(dashscopeTtsEndpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ttsModel,
      input,
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Qwen TTS for ${language.code} failed (${response.status}): ${body.slice(0, 500)}`);
  const payload = JSON.parse(body);
  const url = payload?.output?.audio?.url;
  if (!url) throw new Error(`Qwen TTS for ${language.code} returned no audio URL.`);
  const download = await fetch(url);
  if (!download.ok) throw new Error(`Qwen audio download for ${language.code} failed (${download.status}).`);
  return Buffer.from(await download.arrayBuffer());
}

async function writeChecksum(targetPath, buffer) {
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  await fs.writeFile(`${targetPath}.sha256`, `${digest}  ${path.basename(targetPath)}\n`, 'ascii');
  return digest;
}

async function generateAudio(apiKey, text, language) {
  const target = audioPath(language);
  process.stdout.write(`Generating ${language.code} with ${ttsModel}/${ttsVoice}...\n`);
  const providerBuffer = await requestQwenAudio(apiKey, text, language);
  normalizeStreamingWavHeader(providerBuffer);
  const buffer = resamplePcm16MonoWav(providerBuffer);
  const audio = inspectPcm16MonoWav(buffer);
  await fs.writeFile(target, buffer);
  const sha256 = await writeChecksum(target, buffer);
  process.stdout.write(`Generated ${path.basename(target)}: ${audio.durationSeconds}s\n`);
  return {
    code: language.code,
    language: language.name,
    source: path.basename(textPath(language)),
    audio: path.basename(target),
    provider: 'Alibaba Cloud Model Studio',
    model: ttsModel,
    voice: ttsVoice,
    rate: language.rate ?? 0.95,
    languageHint: language.hint ?? null,
    distribution: 'generated-on-demand',
    sha256,
    ...audio,
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.textOnly && args.audioOnly) throw new Error('--text-only and --audio-only cannot be combined.');
  await fs.mkdir(multilingualRoot, { recursive: true });
  const apiKey = await readApiKey();
  const sourceText = (await fs.readFile(path.join(fixtureRoot, 'watch-mode-en-original.txt'), 'utf8')).trim();
  const textByCode = new Map();
  if (!args.audioOnly) {
    const translations = await mapWithConcurrency(
      args.selectedLanguages,
      4,
      (language) => ensureTranslation(apiKey, sourceText, language, args.refreshText),
    );
    args.selectedLanguages.forEach((language, index) => textByCode.set(language.code, translations[index]));
  } else {
    const translations = await Promise.all(args.selectedLanguages.map((language) => fs.readFile(textPath(language), 'utf8')));
    args.selectedLanguages.forEach((language, index) => textByCode.set(language.code, translations[index].trim()));
  }
  if (args.textOnly) return;

  const generated = await mapWithConcurrency(
    args.selectedLanguages,
    3,
    (language) => generateAudio(apiKey, textByCode.get(language.code), language),
  );
  const manifestPath = path.join(multilingualRoot, 'manifest.json');
  let previous = [];
  try {
    previous = JSON.parse(await fs.readFile(manifestPath, 'utf8')).fixtures ?? [];
  } catch {
    // The first audio generation creates the manifest.
  }
  const byCode = new Map(previous.map((fixture) => [fixture.code, fixture]));
  generated.forEach((fixture) => byCode.set(fixture.code, fixture));
  const manifest = {
    generatedAt: new Date().toISOString(),
    template: '../watch-mode-en-original.txt',
    englishAudio: '../watch-mode-en-original.wav',
    audioDistribution: 'generated-on-demand',
    translationModel,
    fixtures: languages.map((language) => {
      const fixture = byCode.get(language.code);
      return fixture ? {
        ...fixture,
        rate: language.rate ?? 0.95,
        languageHint: language.hint ?? null,
      } : null;
    }).filter(Boolean),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
