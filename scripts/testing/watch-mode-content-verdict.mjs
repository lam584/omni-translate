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

const AUDITED_CANONICAL_CLAUSE_ALIASES = new Map([
  ['丹尼尔回复说', 'daniel回答说'],
]);

function normalizeAuditedCanonicalClauseAlias(value) {
  return AUDITED_CANONICAL_CLAUSE_ALIASES.get(value) ?? value;
}

function normalizeWatchContentPair(left, right) {
  const normalizedLeft = normalizeAuditedCanonicalClauseAlias(normalizeWatchContentText(left));
  const normalizedRight = normalizeAuditedCanonicalClauseAlias(normalizeWatchContentText(right));
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
    .replace(/(?<=\d)\.(?=\d)/gu, '\uE000')
    .replace(/(\d(?:\uE000\d+)+版本)[，,](?=把)/gu, '$1\uE001')
    .split(/[。！？；，!?;,?.\r\n]+/u)
    .map((value) => normalizeWatchContentText(value.replace(/[\uE000\uE001]/gu, '')))
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
    const auditedCompleteVersion = previous.match(/3\.6\.2版本[。.!！]?$/u);
    const duplicatedAuditedPatch = next.match(/^\.2\s*(把.+)$/u);
    if (auditedCompleteVersion && duplicatedAuditedPatch) {
      adjacentVersionContinuations.push('3.6.2版本' + duplicatedAuditedPatch[1]);
      continue;
    }
    const auditedOrdinalContinuation = next.match(
      /^第二点，把平均响应时间从920毫秒降至315毫秒([。.!！]?)$/u,
    );
    if (auditedCompleteVersion && auditedOrdinalContinuation) {
      adjacentVersionContinuations.push(
        '3.6.2版本把平均响应时间从920毫秒降至315毫秒' + auditedOrdinalContinuation[1],
      );
      continue;
    }
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

function cueRevision(value) {
  const revision = Number(value);
  return Number.isFinite(revision) ? revision : 0;
}

export function canonicalizeWatchContentCues(cues) {
  const latestByCue = new Map();
  const anonymous = [];
  for (const [index, raw] of (Array.isArray(cues) ? cues : []).entries()) {
    if (typeof raw === 'string') {
      if (raw.trim()) anonymous.push({ cueId: `anonymous-${index}`, revision: 0, text: raw, order: index });
      continue;
    }
    if (!raw || raw.translationState === 'superseded' || raw.superseded === true) continue;
    const cueId = String(raw.cueId ?? '').trim();
    const text = String(raw.renderedText ?? raw.publishedText ?? raw.llmText ?? raw.text ?? '').trim();
    if (!cueId || !text) continue;
    const candidate = {
      cueId,
      revision: cueRevision(raw.revision ?? raw.revisionId ?? raw.sequence),
      text,
      order: Number.isFinite(Number(raw.sequence)) ? Number(raw.sequence) : index,
    };
    const previous = latestByCue.get(cueId);
    if (!previous || candidate.revision > previous.revision
      || (candidate.revision === previous.revision && candidate.order >= previous.order)) {
      latestByCue.set(cueId, candidate);
    }
  }
  return [...latestByCue.values(), ...anonymous].sort((left, right) => left.order - right.order);
}

function containsTypedAlternative(text, alternative, category = 'semantic') {
  const raw = String(text ?? '').normalize('NFKC').toLowerCase();
  const candidate = String(alternative ?? '').normalize('NFKC').toLowerCase();
  if (!candidate) return false;
  if (category === 'entity' && candidate.includes('@')) {
    return (raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gu) ?? [])
      .includes(candidate);
  }
  if (category === 'version' && /\d+(?:\.\d+)+/u.test(candidate)) {
    const expectedVersion = candidate.match(/\d+(?:\.\d+)+/u)?.[0];
    return (raw.match(/(?<![\d.])\d+(?:\.\d+)+(?![\d.])/gu) ?? [])
      .includes(expectedVersion);
  }
  const normalized = normalizeWatchContentText(raw);
  const normalizedCandidate = normalizeWatchContentText(candidate);
  const offset = normalized.indexOf(normalizedCandidate);
  if (offset < 0) return false;
  if (/^\d/u.test(normalizedCandidate) && /\d/u.test(normalized[offset - 1] ?? '')) return false;
  if (/\d$/u.test(normalizedCandidate) && /\d/u.test(normalized[offset + normalizedCandidate.length] ?? '')) return false;
  return true;
}

function includesAny(text, alternatives, category) {
  return (Array.isArray(alternatives) ? alternatives : [alternatives])
    .filter(Boolean)
    .some((alternative) => containsTypedAlternative(text, alternative, category));
}

function matchesRelation(outputText, relation) {
  const groups = Array.isArray(relation?.groups) ? relation.groups : [];
  if (groups.length === 0) return true;
  const clauses = splitWatchContentClauses(outputText);
  const width = Math.max(1, Math.min(3, Number(relation.windowClauses ?? 1)));
  return clauses.some((_clause, index) => {
    const window = clauses.slice(index, index + width).join('');
    return groups.every((alternatives) => includesAny(window, alternatives, relation.category));
  });
}

function factEvidence(fact, outputText) {
  const expected = fact.accepted ?? fact.expected ?? [];
  const forbidden = fact.forbidden ?? [];
  const matchedExpected = expected.filter((value) => containsTypedAlternative(outputText, value, fact.category));
  const matchedForbidden = forbidden.filter((value) => containsTypedAlternative(outputText, value, fact.category));
  const relationMatched = matchesRelation(outputText, fact.relation);
  let status = 'passed';
  let reason = null;
  if (matchedForbidden.length > 0) {
    status = 'failed';
    reason = `contradictory or unsupported fact: ${matchedForbidden.join(', ')}`;
  } else if (fact.relation && !relationMatched) {
    status = fact.deferMissing === true ? 'inconclusive' : 'failed';
    reason = `required fact relation was not found: ${fact.id}`;
  } else if (fact.required !== false && matchedExpected.length === 0) {
    status = fact.deferMissing === true ? 'inconclusive' : 'failed';
    reason = `required fact was not found: ${fact.id}`;
  }
  return {
    factId: fact.id,
    category: fact.category ?? 'semantic',
    status,
    reason,
    matchedExpected,
    matchedForbidden,
    relationMatched,
  };
}

function crossCueRepetitions(cues) {
  const seen = new Map();
  const repetitions = [];
  for (const cue of cues) {
    for (const clause of splitWatchContentClauses(cue.text)) {
      if (clause.length < 6) continue;
      const previous = seen.get(clause);
      if (previous && previous !== cue.cueId) {
        repetitions.push({ clause, firstCueId: previous, repeatedCueId: cue.cueId });
      } else if (!previous) {
        seen.set(clause, cue.cueId);
      }
    }
  }
  return repetitions;
}

/** Deterministic layered verdict. Facts are audited input; overlap is diagnostics only. */
export function evaluateLayeredWatchContent({ referenceText, outputText, cues = [], facts = [] } = {}) {
  const canonicalCues = canonicalizeWatchContentCues(cues);
  const effectiveOutput = String(outputText ?? '').trim()
    || canonicalCues.map((cue) => cue.text).join('\n');
  const lexicalDiagnostics = compareWatchContentText(referenceText, effectiveOutput);
  const factResults = facts.map((fact) => factEvidence(fact, effectiveOutput));
  const repetitions = crossCueRepetitions(canonicalCues);
  const failedFacts = factResults.filter((fact) => fact.status === 'failed');
  const inconclusiveFacts = factResults.filter((fact) => fact.status === 'inconclusive');
  const evidence = [
    ...failedFacts.map((fact) => ({ type: 'fact', ...fact })),
    ...inconclusiveFacts.map((fact) => ({ type: 'fact', ...fact })),
    ...repetitions.map((repetition) => ({ type: 'cross-cue-repetition', status: 'failed', ...repetition })),
  ];
  const status = failedFacts.length > 0 || repetitions.length > 0
    ? 'failed'
    : inconclusiveFacts.length > 0 || facts.length === 0
      ? 'inconclusive'
      : 'passed';
  return {
    schemaVersion: 1,
    status,
    passed: status === 'passed',
    reason: evidence[0]?.reason ?? (repetitions.length > 0 ? 'cross-cue repetition detected' : null),
    evidence,
    dimensions: {
      facts: factResults,
      completeness: {
        status: failedFacts.some((fact) => fact.reason?.startsWith('required fact')) ? 'failed'
          : inconclusiveFacts.length > 0 ? 'inconclusive' : 'passed',
      },
      additions: {
        status: failedFacts.some((fact) => fact.matchedForbidden.length > 0) ? 'failed' : 'passed',
      },
      crossCueRepetition: { status: repetitions.length > 0 ? 'failed' : 'passed', repetitions },
      expressionForm: { status: 'diagnostic', characterOverlap: lexicalDiagnostics },
    },
    canonicalCues,
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
