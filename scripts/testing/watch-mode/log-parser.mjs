export function textAfterMarker(text, marker) {
  if (!text || !marker) return text ?? '';
  const index = text.indexOf(marker);
  return index >= 0 ? text.slice(index) : '';
}

export function textAfterLocalTimestamp(text, localTimestamp) {
  if (!text || !localTimestamp) return text ?? '';
  const normalized = String(localTimestamp).replace('T', ' ').slice(0, 19);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) return text;
  const lines = text.split(/\r?\n/);
  const firstCurrentLine = lines.findIndex((line) => {
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    return match && match[1] >= normalized;
  });
  return firstCurrentLine >= 0 ? lines.slice(firstCurrentLine).join('\n') : '';
}

export function parseTranslationRoute(appLogText) {
  const configured = [...appLogText.matchAll(/subtitleTranslationMode=(native|secondary)/g)].at(-1);
  if (configured) return configured[1];
  return /speech\.segment_tts_queued|speech\.segment_playback_written|speech\.bridge-playback-queued|event=translation_playback_status/.test(appLogText)
    ? 'secondary'
    : 'native';
}

export function parseSpeechSegmentation(appLogText) {
  const queuedLocal = [...appLogText.matchAll(/speech\.segment_tts_queued[^\r\n]*/g)];
  const queuedBridge = [...appLogText.matchAll(/event=translation_playback_status[^\r\n]*\bstatus=queued\b[^\r\n]*\breason=accepted\b/g)];
  const playedLocal = [...appLogText.matchAll(/speech\.segment_playback_written[^\r\n]*/g)];
  const playedBridge = [...appLogText.matchAll(/event=translation_playback_status[^\r\n]*\bstatus=started\b[^\r\n]*\breason=physical-playback(?:-stream)?-started\b/g)];
  let maxSourceChars = 0;
  let maxTranslatedChars = 0;
  for (const [line] of queuedLocal) {
    maxSourceChars = Math.max(maxSourceChars, Number(line.match(/sourceChars=(\d+)/)?.[1] ?? 0));
    maxTranslatedChars = Math.max(maxTranslatedChars, Number(line.match(/translatedChars=(\d+)/)?.[1] ?? 0));
  }
  return {
    queuedSegments: queuedLocal.length + queuedBridge.length,
    playedSegments: playedLocal.length + playedBridge.length,
    maxSourceChars,
    maxTranslatedChars,
  };
}

function decodeLoggedText(value) {
  try { return JSON.parse(`"${value}"`); } catch { return value; }
}

export function parseRecentSubtitleText(appLogText) {
  const values = [];
  for (const pattern of [/translated="((?:\\.|[^"\\])*)"/g, /"translatedText"\s*:\s*"((?:\\.|[^"\\])*)"/g]) {
    for (const match of appLogText.matchAll(pattern)) {
      const decoded = decodeLoggedText(match[1]);
      if (decoded.length >= 2) values.push(decoded);
    }
  }
  return values.slice(-12).join('\n');
}

export function parseRecentFinalSegmentTranslationText(appLogText) {
  const values = [];
  for (const match of appLogText.matchAll(/^[^\r\n]*rank=(?:Final|Replacement|Forced)[^\r\n]*translated="((?:\\.|[^"\\])*)"/gm)) {
    const decoded = decodeLoggedText(match[1]);
    if (decoded.length >= 2) values.push(decoded);
  }
  return values.slice(-12).join('\n');
}
