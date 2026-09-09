function normalizeChineseTens(value) {
  const digits = new Map([
    ['', 0], ['一', 1], ['二', 2], ['三', 3], ['四', 4],
    ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9],
  ]);
  return value.replace(/([一二三四五六七八九]?)十([一二三四五六七八九]?)/gu, (_match, tens, ones) => (
    String((tens ? digits.get(tens) : 1) * 10 + (ones ? digits.get(ones) : 0))
  ));
}

export function normalizeWatchContentText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeWatchContentPair(left, right) {
  const normalizedLeft = normalizeWatchContentText(left);
  const normalizedRight = normalizeWatchContentText(right);
  return [
    /\d/u.test(normalizedRight) ? normalizeChineseTens(normalizedLeft) : normalizedLeft,
    /\d/u.test(normalizedLeft) ? normalizeChineseTens(normalizedRight) : normalizedRight,
  ];
}

function watchContentNumericSequence(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .match(/\d+|[一二三四五六七八九]十[一二三四五六七八九]?|十[一二三四五六七八九]/gu)
    ?.map((token) => normalizeChineseTens(token)) ?? [];
}

export function splitWatchContentClauses(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .split(/[。！？；，!?;,?.\r\n]+/u)
    .map((value) => normalizeWatchContentText(value))
    .filter((value) => value.length >= 2);
}

export function watchContentCharacterOverlap(left, right) {
  const [normalizedLeft, normalizedRight] = normalizeWatchContentPair(left, right);
  if (!normalizedLeft || !normalizedRight) return 0;
  const leftNumbers = watchContentNumericSequence(left);
  const rightNumbers = watchContentNumericSequence(right);
  if (leftNumbers.length > 0 && rightNumbers.length > 0
    && JSON.stringify(leftNumbers) !== JSON.stringify(rightNumbers)) return 0;
  const counts = new Map();
  for (const character of normalizedRight) counts.set(character, (counts.get(character) ?? 0) + 1);
  let overlap = 0;
  for (const character of normalizedLeft) {
    const count = counts.get(character) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(character, count - 1);
    }
  }
  return overlap / Math.max(1, Math.min([...normalizedLeft].length, [...normalizedRight].length));
}

export function watchContentCanonicalFinalCueEvidence(cues) {
  const rawCues = (Array.isArray(cues) ? cues : [])
    .map((cue) => String(cue ?? ''))
    .filter((cue) => cue.trim().length > 0);
  const adjacentVersionContinuations = [];
  for (let index = 0; index + 1 < rawCues.length; index += 1) {
    const previous = rawCues[index].trim();
    const next = rawCues[index + 1].trim();
    if (!/^版本\s*\d+(?:\.\d+)+$/u.test(previous)) continue;
    if (!/^\.\d+(?=\s|[^\d.]|$)/u.test(next)) continue;
    adjacentVersionContinuations.push(previous + (next.startsWith('.') ? '' : ' ') + next);
  }
  return {
    rawCues,
    adjacentVersionContinuations,
    comparisonText: [...rawCues, ...adjacentVersionContinuations].join('\n'),
  };
}

export function uniqueWatchContentEvidence(parts) {
  const evidenceParts = parts.map((part) => watchContentCanonicalFinalCueEvidence(
    String(part ?? '').normalize('NFKC').split(/\r?\n/u),
  ));
  return [...new Set(evidenceParts.flatMap((evidence) => [
    ...evidence.rawCues.flatMap(splitWatchContentClauses),
    ...evidence.adjacentVersionContinuations.flatMap(splitWatchContentClauses),
  ]))].join('\n');
}

export function compareWatchContentText(referenceText, outputText) {
  const referenceClauses = splitWatchContentClauses(referenceText);
  const outputClauses = splitWatchContentClauses(outputText);
  const missingClauses = referenceClauses.filter((clause) => (
    Math.max(0, ...outputClauses.map((candidate) => watchContentCharacterOverlap(clause, candidate))) < 0.45
  ));
  const extraClauses = outputClauses.filter((clause) => (
    clause.length >= 4
    && Math.max(0, ...referenceClauses.map((candidate) => watchContentCharacterOverlap(clause, candidate))) < 0.35
  ));
  const referenceChars = normalizeWatchContentText(referenceText).length;
  const outputChars = normalizeWatchContentText(outputText).length;
  const coverage = referenceClauses.length > 0
    ? (referenceClauses.length - missingClauses.length) / referenceClauses.length
    : 0;
  const lengthRatio = referenceChars > 0 ? outputChars / referenceChars : 0;
  return {
    passed: referenceClauses.length > 0
      && coverage >= 0.72
      && missingClauses.length <= 1
      && extraClauses.length <= 2
      && lengthRatio <= 2.2,
    coverage: Number(coverage.toFixed(3)),
    lengthRatio: Number(lengthRatio.toFixed(3)),
    referenceClauseCount: referenceClauses.length,
    outputClauseCount: outputClauses.length,
    missingClauses,
    extraClauses,
    referenceChars,
    outputChars,
  };
}

export function evaluateWatchContentConsistency(content) {
  const sourceReferenceText = String(content?.sourceReference?.source ?? '');
  const translationCandidate = String(content?.sourceReference?.translation ?? '');
  const translationReferenceText = translationCandidate.trim().length >= 200 ? translationCandidate : '';
  if (!sourceReferenceText && !translationReferenceText) {
    return { passed: false, error: 'source media reference transcript was empty' };
  }
  const physicalSourceText = uniqueWatchContentEvidence([content?.source]);
  const physicalTranslationText = uniqueWatchContentEvidence([content?.translation]);
  const structuredText = uniqueWatchContentEvidence([content?.subtitleText, content?.segmentTranslationText]);
  const translationEvidenceText = uniqueWatchContentEvidence([physicalTranslationText, structuredText]);
  const canonicalSourceWaveform = content?.authorityMode === 'local-pcm-cue-playback-v1'
    && content?.originalPassthrough?.passed === true
    && content?.originalPassthrough?.authority === 'canonical-source-signed-waveform-v1';
  const physicalTranscript = sourceReferenceText && !canonicalSourceWaveform
    ? compareWatchContentText(sourceReferenceText, physicalSourceText)
    : null;
  const physicalTranslation = translationReferenceText
    ? compareWatchContentText(translationReferenceText, physicalTranslationText)
    : null;
  const structuredEvidence = translationReferenceText
    ? compareWatchContentText(translationReferenceText, structuredText)
    : null;
  const combinedEvidence = translationReferenceText
    ? compareWatchContentText(translationReferenceText, translationEvidenceText)
    : null;
  const sourceCoverage = physicalTranscript?.coverage ?? (canonicalSourceWaveform ? 1 : 1);
  const translationCoverage = combinedEvidence?.coverage ?? 1;
  const missingClauses = [
    ...(physicalTranscript?.missingClauses ?? []),
    ...(combinedEvidence?.missingClauses ?? []),
  ];
  const extraClauses = [
    ...(physicalTranscript?.extraClauses ?? []),
    ...(physicalTranslation?.extraClauses ?? []),
  ];
  const sourceSevereRepetition = (physicalTranscript?.lengthRatio ?? 0) > 2.2;
  const translationSevereRepetition = (physicalTranslation?.lengthRatio ?? 0) > 2.2;
  const passed = sourceCoverage >= 0.85
    && translationCoverage >= 0.72
    && missingClauses.length <= 2
    && extraClauses.length <= 2
    && !sourceSevereRepetition
    && !translationSevereRepetition;
  const referenceChars = (physicalTranscript?.referenceChars ?? 0) + (combinedEvidence?.referenceChars ?? 0);
  const outputChars = (physicalTranscript?.outputChars ?? 0) + (physicalTranslation?.outputChars ?? 0);
  return {
    passed,
    coverage: Number(Math.min(sourceCoverage, translationCoverage).toFixed(3)),
    lengthRatio: referenceChars > 0 ? Number((outputChars / referenceChars).toFixed(3)) : 0,
    referenceClauseCount: (physicalTranscript?.referenceClauseCount ?? 0) + (combinedEvidence?.referenceClauseCount ?? 0),
    outputClauseCount: (physicalTranscript?.outputClauseCount ?? 0) + (combinedEvidence?.outputClauseCount ?? 0),
    missingClauses,
    extraClauses,
    referenceChars,
    outputChars,
    physicalTranscript,
    physicalTranslation,
    structuredEvidence,
    combinedEvidence,
    evidenceSource: 'node-report-v2',
  };
}
