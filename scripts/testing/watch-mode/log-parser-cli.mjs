import fs from 'node:fs';

import {
  parseRecentFinalSegmentTranslationText,
  parseRecentSubtitleText,
  parseSpeechSegmentation,
  parseTranslationRoute,
  textAfterMarker,
} from './log-parser.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) continue;
    result[name.slice(2)] = argv[++index] ?? '';
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.operation) throw new Error('--input and --operation are required');
const rawText = fs.existsSync(args.input) ? fs.readFileSync(args.input, 'utf8') : '';
const text = textAfterMarker(rawText, args.marker || null);
const value = (() => {
  switch (args.operation) {
    case 'text-after-marker': return text;
    case 'translation-route': return parseTranslationRoute(text);
    case 'speech-segmentation': return parseSpeechSegmentation(text);
    case 'recent-subtitle-text': return parseRecentSubtitleText(text);
    case 'recent-final-segment-translation': return parseRecentFinalSegmentTranslationText(text);
    default: throw new Error(`unknown log parser operation: ${args.operation}`);
  }
})();
process.stdout.write(`${JSON.stringify({ value })}\n`);
