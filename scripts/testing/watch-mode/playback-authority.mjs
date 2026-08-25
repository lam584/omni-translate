import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { textAfterMarker } from './log-parser.mjs';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export function deriveTranslatedCuePlaybackAuthority({ watchReport, device, appLogText, runMarker }) {
  const completeCueIds = [...new Set((watchReport.cues ?? [])
    .filter((cue) => ['exact', 'formatting-only'].includes(cue.comparisonStatus)
      && String(cue.llmText ?? '').trim() && String(cue.publishedText ?? '').trim()
      && String(cue.renderedText ?? '').trim())
    .map((cue) => String(cue.cueId)))];
  const events = [];
  for (const line of textAfterMarker(appLogText, runMarker).split(/\r?\n/)) {
    if (!line.includes('event=translation_playback_status')) continue;
    const cueId = line.match(/\bcueId=([A-Za-z0-9._:-]+)/)?.[1];
    const status = line.match(/\bstatus=(queued|started|completed)\b/)?.[1];
    if (cueId && status) events.push({ cueId, status, eventIndex: events.length + 1 });
  }
  const matchedCueIds = [];
  const invalidCues = [];
  for (const cueId of completeCueIds) {
    const cueEvents = events.filter((event) => event.cueId === cueId);
    const byStatus = Object.fromEntries(['queued', 'started', 'completed']
      .map((status) => [status, cueEvents.filter((event) => event.status === status)]));
    const exactlyOnce = Object.values(byStatus).every((items) => items.length === 1);
    const ordered = exactlyOnce
      && byStatus.queued[0].eventIndex < byStatus.started[0].eventIndex
      && byStatus.started[0].eventIndex < byStatus.completed[0].eventIndex;
    if (exactlyOnce && ordered) matchedCueIds.push(cueId);
    else invalidCues.push({
      cueId,
      queuedCount: byStatus.queued.length,
      startedCount: byStatus.started.length,
      completedCount: byStatus.completed.length,
      ordered,
    });
  }
  const uniqueCount = (status) => new Set(events.filter((event) => event.status === status).map((event) => event.cueId)).size;
  const deviceVerified = device?.verified === true;
  return {
    passed: completeCueIds.length > 0 && matchedCueIds.length === completeCueIds.length && invalidCues.length === 0 && deviceVerified,
    completeCueCount: completeCueIds.length,
    queuedCueCount: uniqueCount('queued'),
    startedCueCount: uniqueCount('started'),
    completedCueCount: uniqueCount('completed'),
    matchedCueIds,
    matchedCueCount: matchedCueIds.length,
    invalidCues,
    resolvedPhysicalDeviceId: device?.resolvedDeviceId ?? null,
    resolvedPhysicalDeviceName: device?.resolvedDeviceName ?? null,
    deviceVerified,
    detail: completeCueIds.length === 0
      ? 'no fully published/rendered native cue was available'
      : invalidCues.length > 0
        ? 'every complete native cue must have exactly one ordered queued, started, and completed physical playback event'
        : !deviceVerified ? 'physical playback endpoint authority is missing or unverified' : null,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    args[argv[index].slice(2)] = argv[++index] ?? '';
  }
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const authority = deriveTranslatedCuePlaybackAuthority({
    watchReport: readJson(args['watch-report']),
    device: fs.existsSync(args.device) ? readJson(args.device) : null,
    appLogText: fs.existsSync(args['app-log']) ? fs.readFileSync(args['app-log'], 'utf8') : '',
    runMarker: args.marker || null,
  });
  process.stdout.write(`${JSON.stringify(authority)}\n`);
}
