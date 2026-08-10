#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '..', '..');
const localeDir = path.join(workspaceRoot, 'apps', 'desktop', 'src', 'i18n', 'locales');
const sourceLocale = 'en';
const sourceFile = `${sourceLocale}.json`;

const args = new Set(process.argv.slice(2));
const failOnWarnings = args.has('--fail-on-warnings');
const jsonOutput = args.has('--json');
const ratchet = args.has('--ratchet');
const updateRatchetBaseline = args.has('--update-ratchet-baseline');
const ratchetBaselinePath = path.join(__dirname, 'i18n-coverage-baseline.json');
const minTranslationCoverageArg = process.argv
  .slice(2)
  .find((arg) => arg.startsWith('--min-translation-coverage='));
const minTranslationCoverage = minTranslationCoverageArg
  ? Number(minTranslationCoverageArg.split('=')[1])
  : null;

if (minTranslationCoverage !== null && (!Number.isFinite(minTranslationCoverage) || minTranslationCoverage < 0 || minTranslationCoverage > 100)) {
  console.error('--min-translation-coverage must be a number from 0 to 100.');
  process.exit(1);
}

const placeholderPattern = /{{\s*[\w.]+\s*}}/g;
// Exact machine-translation failure markers leaked by the MyMemory API, e.g.
// "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY. ...
// VISIT HTTPS://MYMEMORY.TRANSLATED.NET/DOC/USAGELIMITS.PHP ...". A superset
// of REJECTED_TRANSLATION_MARKERS in apps/desktop/src/i18n/config.ts; keep
// each pattern narrow enough that legitimate provider mentions (a "MyMemory"
// label or a generic translated.net help link) do not trip this blocking
// gate — only the usage-limits leak URL itself still matches.
const rejectedTranslationPatterns = [
  /MYMEMORY WARNING:/i,
  /MYMEMORY[\s.]TRANSLATED\.NET\/DOC\/USAGELIMITS/i,
  /YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY/i,
];
const allowedSameAsSourceKeys = new Set([
  'audioRouting.tagStt',
  'audioRouting.tagTts',
  'common.appName',
  'diagnostics.liveEvents.stash',
  'providers.auth.apiUrl',
  'welcome.apiBaseUrlLabel',
]);
const allowedSameAsSourceValues = new Set([
  'AEC',
  'AGC',
  'ANS',
  'API URL',
  'ASR',
  'Bridge Service',
  'HTTP',
  'Omni Translate',
  'STT',
  'TTS',
  'VAD',
  'WebSocket',
]);
const allowedSameAsSourceValuePatterns = [
  /^(?:GPT|Qwen|DashScope|Gemini|OpenAI|Omni)[\w.-]*$/u,
  /^(?:gpt|qwen|gemini|dashscope|openai)[a-z0-9._-]*$/u,
];
// The public benchmark-score/v1 report deliberately has an English fallback
// outside English and Simplified Chinese. `withEnglishFallback()` in the
// runtime deep-merges that bundle before rendering, so treating these keys as
// missing would reject the documented fallback policy rather than a broken
// user-visible translation. Keep this exceptionally narrow: all other keys,
// including the EN/ZH v1 copy itself, retain the normal coverage gate.
const intentionalEnglishFallbackPrefixes = [
  'diagnostics.benchmark.score',
  'diagnostics.benchmark.history',
];
const intentionalEnglishFallbackKeys = new Set([
  'diagnostics.benchmark.clearHistory',
  'diagnostics.benchmark.clearHistoryConfirm',
  'diagnostics.benchmark.deleteHistory',
  'diagnostics.benchmark.deleteHistoryConfirm',
  'diagnostics.benchmark.loadMoreHistory',
  'diagnostics.benchmark.openHistory',
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function flatten(value, prefix = '', output = {}) {
  for (const [key, item] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      flatten(item, fullKey, output);
    } else {
      output[fullKey] = item;
    }
  }
  return output;
}

function placeholders(value) {
  if (typeof value !== 'string') {
    return [];
  }
  return Array.from(value.matchAll(placeholderPattern), (match) => match[0].replace(/\s+/g, ''));
}

function sameMembers(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  const remaining = [...right];
  for (const item of left) {
    const index = remaining.indexOf(item);
    if (index === -1) {
      return false;
    }
    remaining.splice(index, 1);
  }
  return true;
}

function isEmptyValue(value) {
  return typeof value === 'string' && value.trim().length === 0;
}

function isRejectedTranslationValue(value) {
  return typeof value === 'string' && rejectedTranslationPatterns.some((pattern) => pattern.test(value));
}

function withoutPlaceholders(value) {
  return value.replace(placeholderPattern, '').trim();
}

function isAllowedSameAsSourceValue(value) {
  const normalized = value.trim();
  const literal = withoutPlaceholders(normalized);

  if (allowedSameAsSourceValues.has(normalized) || allowedSameAsSourceValues.has(literal)) {
    return true;
  }
  if (/^[\s:;,.()[\]/+~-]*$/u.test(literal)) {
    return true;
  }
  return allowedSameAsSourceValuePatterns.some((pattern) => pattern.test(literal));
}

function isSameAsSource(locale, key, value, sourceValue) {
  if (locale === sourceLocale || allowedSameAsSourceKeys.has(key)) {
    return false;
  }
  if (typeof value !== 'string' || typeof sourceValue !== 'string') {
    return false;
  }
  if (isAllowedSameAsSourceValue(sourceValue)) {
    return false;
  }
  if (isEmptyValue(value) && isEmptyValue(sourceValue)) {
    return false;
  }
  return value === sourceValue;
}

function usesIntentionalEnglishFallback(locale, key) {
  if (locale === sourceLocale || locale === 'zh-CN') {
    return false;
  }
  return intentionalEnglishFallbackKeys.has(key)
    || intentionalEnglishFallbackPrefixes.some((prefix) => key.startsWith(prefix));
}

function percent(numerator, denominator) {
  return denominator === 0 ? 100 : (numerator / denominator) * 100;
}

const source = flatten(readJson(path.join(localeDir, sourceFile)));
const sourceKeys = Object.keys(source).sort();
const localeFiles = fs
  .readdirSync(localeDir)
  .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
  .sort();

const results = localeFiles.map((file) => {
  const locale = path.basename(file, '.json');
  const values = flatten(readJson(path.join(localeDir, file)));
  const keys = new Set(Object.keys(values));
  const checkedSourceKeys = sourceKeys.filter((key) => !usesIntentionalEnglishFallback(locale, key));
  const intentionalEnglishFallback = sourceKeys.filter((key) => usesIntentionalEnglishFallback(locale, key));
  const missing = checkedSourceKeys.filter((key) => !keys.has(key));
  const extra = Object.keys(values).filter((key) => !Object.hasOwn(source, key)).sort();
  const empty = checkedSourceKeys.filter((key) => keys.has(key) && !isEmptyValue(source[key]) && isEmptyValue(values[key]));
  const sameAsSource = checkedSourceKeys.filter((key) => isSameAsSource(locale, key, values[key], source[key]));
  const placeholderMismatch = checkedSourceKeys.filter((key) => {
    if (!keys.has(key)) {
      return false;
    }
    return !sameMembers(placeholders(source[key]), placeholders(values[key]));
  });
  const rejected = checkedSourceKeys.filter((key) => keys.has(key) && isRejectedTranslationValue(values[key]));
  const translated = checkedSourceKeys.length - missing.length - empty.length - sameAsSource.length - rejected.length;

  return {
    locale,
    file,
    total: checkedSourceKeys.length,
    keys: keys.size,
    translated,
    structuralCoverage: percent(checkedSourceKeys.length - missing.length, checkedSourceKeys.length),
    translationCoverage: percent(translated, checkedSourceKeys.length),
    missing,
    extra,
    empty,
    sameAsSource,
    rejected,
    placeholderMismatch,
    intentionalEnglishFallback,
  };
});

if (jsonOutput) {
  console.log(JSON.stringify({ sourceLocale, sourceKeys: sourceKeys.length, results }, null, 2));
} else {
  console.log(`i18n coverage source: ${sourceFile} (${sourceKeys.length} keys)`);
  console.log('');
  console.log('locale  structural  translated  missing  empty  same-as-en  rejected  placeholders');
  console.log('------  ----------  ----------  -------  -----  ----------  --------  ------------');
  for (const result of results) {
    console.log(
      `${result.locale.padEnd(6)}  ${result.structuralCoverage.toFixed(1).padStart(9)}%  ${result.translationCoverage
        .toFixed(1)
        .padStart(9)}%  ${String(result.missing.length).padStart(7)}  ${String(result.empty.length).padStart(
        5,
      )}  ${String(result.sameAsSource.length).padStart(10)}  ${String(result.rejected.length).padStart(8)}  ${String(result.placeholderMismatch.length).padStart(
        12,
      )}`,
    );
  }

  const issueResults = results.filter(
    (result) =>
      result.missing.length > 0 ||
      result.empty.length > 0 ||
      result.sameAsSource.length > 0 ||
      result.rejected.length > 0 ||
      result.placeholderMismatch.length > 0,
  );

  if (issueResults.length > 0 && !ratchet) {
    console.log('');
    console.log('Top samples:');
    for (const result of issueResults) {
      const samples = [
        ...result.missing.slice(0, 3).map((key) => `missing:${key}`),
        ...result.empty.slice(0, 3).map((key) => `empty:${key}`),
        ...result.sameAsSource.slice(0, 3).map((key) => `same:${key}`),
        ...result.rejected.slice(0, 3).map((key) => `rejected:${key}`),
        ...result.placeholderMismatch.slice(0, 3).map((key) => `placeholder:${key}`),
      ];
      console.log(`${result.locale}: ${samples.join(', ')}`);
    }
    console.log('');
    console.log('Same-as-source keys:');
    for (const result of issueResults.filter((result) => result.sameAsSource.length > 0)) {
      console.log(`${result.locale}:`);
      for (const key of result.sameAsSource) {
        console.log(`  ${key}`);
      }
    }
  }
}

const blockingFailures = results.filter(
  (result) =>
    result.missing.length > 0 ||
    result.extra.length > 0 ||
    result.placeholderMismatch.length > 0 ||
    result.rejected.length > 0,
);
const warningFailures = results.filter(
  (result) => result.empty.length > 0 || result.sameAsSource.length > 0,
);
const thresholdFailures =
  minTranslationCoverage === null
    ? []
    : results.filter((result) => result.translationCoverage < minTranslationCoverage);

let ratchetFailures = [];
if (updateRatchetBaseline) {
  const baseline = {
    comment: 'Translation coverage ratchet. New English keys must be translated in every locale except documented benchmark-score/v1 English fallbacks.',
    sourceKeys,
    translationCoverage: Object.fromEntries(
      results.filter(({ locale }) => locale !== sourceLocale).map(({ locale, translationCoverage }) => [locale, translationCoverage]),
    ),
  };
  fs.writeFileSync(ratchetBaselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  console.log(`i18n ratchet baseline updated: ${path.relative(workspaceRoot, ratchetBaselinePath)}`);
} else if (ratchet) {
  const baseline = readJson(ratchetBaselinePath);
  const previousKeys = new Set(baseline.sourceKeys ?? []);
  const newKeys = sourceKeys.filter((key) => !previousKeys.has(key));
  for (const result of results.filter(({ locale }) => locale !== sourceLocale)) {
    const minimum = baseline.translationCoverage?.[result.locale];
    if (typeof minimum !== 'number') {
      ratchetFailures.push(`${result.locale}: missing coverage baseline`);
    } else if (result.translationCoverage + Number.EPSILON < minimum) {
      ratchetFailures.push(`${result.locale}: coverage ${result.translationCoverage.toFixed(4)}% < baseline ${minimum.toFixed(4)}%`);
    }
    const untranslatedNew = newKeys.filter((key) => !usesIntentionalEnglishFallback(result.locale, key) && (
      result.missing.includes(key)
      || result.empty.includes(key)
      || result.sameAsSource.includes(key)
      || result.rejected.includes(key)));
    if (untranslatedNew.length > 0) {
      ratchetFailures.push(`${result.locale}: untranslated new keys: ${untranslatedNew.join(', ')}`);
    }
  }
  if (ratchetFailures.length > 0) {
    console.error(`i18n ratchet failed:\n${ratchetFailures.map((failure) => `- ${failure}`).join('\n')}`);
  } else {
    console.log(`i18n ratchet passed (${newKeys.length} new source key(s)).`);
  }
}

if (blockingFailures.length > 0 || thresholdFailures.length > 0 || ratchetFailures.length > 0 || (failOnWarnings && warningFailures.length > 0)) {
  process.exitCode = 1;
}
