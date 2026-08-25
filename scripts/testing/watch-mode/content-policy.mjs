import { evaluateWatchContentConsistency } from '../watch-mode-content-verdict.mjs';

export function derivePhysicalOutputContent(collected) {
  if (!collected?.sourceReference || collected.skipped === true) return collected ?? null;

  const similarity = collected.originalPassthrough?.sourceSimilarity;
  const canonicalSimilarity = collected.originalPassthrough?.authority === 'canonical-source-signed-waveform-v1'
    && similarity?.passed === true;
  const envelopeSimilarity = similarity?.error == null
    && Number(similarity?.envelopeCorrelation) >= 0.35
    && Number(similarity?.levelRatio) >= 0.05
    && Number(similarity?.levelRatio) <= 8;
  const sttSucceeded = collected.sttSucceeded === true
    || String(collected.source ?? '').trim().length > 0
    || canonicalSimilarity;
  const originalPassthrough = {
    ...collected.originalPassthrough,
    passed: sttSucceeded && (canonicalSimilarity || envelopeSimilarity || similarity == null),
  };
  const translatedSpeech = {
    ...collected.translatedSpeech,
    passed: Number(collected.translatedSpeech?.playedSegments) > 0
      && collected.translatedSpeech?.playbackAuthority?.passed !== false
      && collected.translatedSpeech?.acousticAuthority?.passed !== false,
  };
  const mixedOutput = {
    ...collected.mixedOutput,
    passed: Number(collected.mixedOutput?.rms ?? collected.recording?.rms) >= 0.003
      && Number(collected.mixedOutput?.peak ?? collected.recording?.peak) >= 0.01,
  };
  const audioQuality = collected.audioQuality ? {
    ...collected.audioQuality,
    passed: collected.audioQuality.error == null
      && Number(collected.audioQuality.clippingRatio ?? 0) <= 0.01
      && Number(collected.audioQuality.peak ?? 0) < 0.9999
      && Number(collected.audioQuality.discontinuityRate ?? 0) <= 0.005,
  } : null;
  const normalized = { ...collected, originalPassthrough, translatedSpeech, mixedOutput, audioQuality };
  const contentConsistency = evaluateWatchContentConsistency(normalized);
  const acquisitionPassed = normalized.error == null
    && normalized.recording?.passed !== false
    && normalized.audioQuality?.passed !== false
    && originalPassthrough.passed
    && translatedSpeech.passed
    && mixedOutput.passed;
  return {
    ...normalized,
    collectorPassed: collected.passed ?? null,
    passed: acquisitionPassed && contentConsistency.passed,
    contentConsistency,
    verdictSource: 'watch-mode-content-verdict/v2',
  };
}
