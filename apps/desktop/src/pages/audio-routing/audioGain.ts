export const MIN_AUDIO_GAIN_DB = -60;
export const MAX_TRANSLATED_VOLUME_PERCENT = 200;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function gainDbToVolumePercent(gainDb: number, maximumPercent = 100): number {
  if (!Number.isFinite(gainDb)) return 0;
  const linearPercent = 100 * (10 ** (gainDb / 20));
  return Math.round(clamp(linearPercent, 0, maximumPercent));
}

export function volumePercentToGainDb(volumePercent: number, maximumPercent = 100): number {
  if (!Number.isFinite(volumePercent)) return MIN_AUDIO_GAIN_DB;
  const boundedPercent = clamp(volumePercent, 0, maximumPercent);
  if (boundedPercent === 0) return MIN_AUDIO_GAIN_DB;
  return Math.max(MIN_AUDIO_GAIN_DB, 20 * Math.log10(boundedPercent / 100));
}
