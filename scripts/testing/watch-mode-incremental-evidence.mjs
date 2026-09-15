import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { evaluateLayeredWatchContent } from './watch-mode-content-verdict.mjs';
import { isMain, parseCliArgs } from '../lib/testing-common.mjs';

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const auditedFixture = JSON.parse(fs.readFileSync(
  new URL('./fixtures/watch-mode-content-facts.json', import.meta.url), 'utf8',
));
const auditedFacts = auditedFixture.facts;
const auditedMediaSha256 = auditedFixture.mediaSha256;

export function evaluateAuditedCueForEarlyStop(cue, facts = auditedFacts) {
  const contradictionOnlyFacts = facts.map((fact) => ({ ...fact, required: false }));
  const verdict = evaluateLayeredWatchContent({
    referenceText: '', outputText: cue?.renderedText ?? '', cues: [cue], facts: contradictionOnlyFacts,
  });
  const hardFailures = verdict.dimensions.facts
    .filter((fact) => fact.status === 'failed' && fact.matchedForbidden.length > 0)
    .map((fact) => fact.factId);
  return {
    status: hardFailures.length > 0 ? 'failed' : 'inconclusive',
    deterministic: hardFailures.length > 0,
    hardFailures,
    evidence: verdict.evidence,
  };
}

export function validateIncrementalCueEvent(event, expectedIdentity = null) {
  const violations = [];
  if (event?.schemaVersion !== 1 || event?.artifactKind !== 'watch-mode-incremental-cue-event') {
    violations.push('incremental cue event schema');
  }
  for (const field of ['sessionId', 'cueId', 'stage']) {
    if (!nonEmpty(event?.[field])) violations.push(`${field} is missing`);
  }
  for (const field of ['eventSequence', 'revision', 'sequence']) {
    if (!Number.isSafeInteger(Number(event?.[field])) || Number(event?.[field]) < 0) {
      violations.push(`${field} is invalid`);
    }
  }
  if (expectedIdentity) {
    for (const field of ['runMarker', 'cellId', 'leaseId', 'launchId']) {
      if (event?.identity?.[field] !== expectedIdentity[field]) violations.push(`identity.${field} mismatch`);
    }
    const expectedMediaSha256 = expectedIdentity.mediaSha256 ?? auditedMediaSha256;
    if (event?.mediaSha256 !== expectedMediaSha256) violations.push('mediaSha256 mismatch');
  }
  return violations;
}

export function validateIncrementalTerminal(terminal, cueEvents, expectedIdentity = null) {
  const violations = [];
  if (!terminal) return { complete: false, violations: ['incremental terminal is missing'] };
  if (terminal.schemaVersion !== 1 || terminal.artifactKind !== 'watch-mode-incremental-terminal') {
    violations.push('incremental terminal schema');
  }
  if (terminal.complete !== true) violations.push('incremental terminal is incomplete');
  if (terminal.writerError != null) violations.push('incremental writer error');
  if (!Number.isSafeInteger(Number(terminal.droppedEventCount)) || Number(terminal.droppedEventCount) !== 0) {
    violations.push('incremental events were dropped');
  }
  for (const field of ['lastProducedSequence', 'lastPersistedSequence']) {
    if (!Number.isSafeInteger(Number(terminal[field])) || Number(terminal[field]) < 0) violations.push(`${field} is invalid`);
  }
  if (Number(terminal.lastProducedSequence) !== Number(terminal.lastPersistedSequence)) {
    violations.push('incremental terminal sequence mismatch');
  }
  const observedLast = cueEvents.reduce((maximum, event) => Math.max(maximum, Number(event?.eventSequence) || 0), 0);
  if (observedLast !== Number(terminal.lastPersistedSequence)) violations.push('persisted sequence does not match cue evidence');
  if (expectedIdentity) {
    for (const field of ['runMarker', 'cellId', 'leaseId', 'launchId']) {
      if (terminal?.identity?.[field] !== expectedIdentity[field]) violations.push(`terminal identity.${field} mismatch`);
    }
    const expectedMediaSha256 = expectedIdentity.mediaSha256 ?? auditedMediaSha256;
    if (terminal?.mediaSha256 !== expectedMediaSha256) violations.push('terminal mediaSha256 mismatch');
  }
  return { complete: violations.length === 0, violations };
}

export function canonicalIncrementalFinalCues(events, expectedIdentity = null) {
  const violations = [];
  const latestByCue = new Map();
  let priorEventSequence = -1;
  for (const event of Array.isArray(events) ? events : []) {
    const eventViolations = validateIncrementalCueEvent(event, expectedIdentity);
    if (eventViolations.length > 0) {
      violations.push(...eventViolations);
      continue;
    }
    const eventSequence = Number(event.eventSequence);
    if (eventSequence <= priorEventSequence) violations.push('eventSequence is not strictly increasing');
    priorEventSequence = Math.max(priorEventSequence, eventSequence);
    const current = latestByCue.get(event.cueId);
    if (current && Number(event.revision) < Number(current.revision)) continue;
    if (current && Number(event.revision) === Number(current.revision)
      && Number(event.sequence) < Number(current.sequence)) continue;
    latestByCue.set(event.cueId, event);
  }
  const cues = [...latestByCue.values()]
    .filter((event) => event.stage === 'render-final'
      && event.modelFinal === true && event.publishFinal === true && event.renderFinal === true
      && nonEmpty(event.renderedText))
    .sort((left, right) => Number(left.eventSequence) - Number(right.eventSequence));
  return { cues, violations: [...new Set(violations)] };
}

export function evaluateIncrementalEarlyStop({ events, terminal = null, expectedIdentity, evaluateCue }) {
  const canonical = canonicalIncrementalFinalCues(events, expectedIdentity);
  const authority = validateIncrementalTerminal(terminal, events, expectedIdentity);
  const findings = canonical.cues.map((cue) => ({ cue, verdict: evaluateCue(cue) }));
  const trigger = authority.complete && findings.find(({ verdict }) => verdict?.status === 'failed'
    && verdict?.deterministic === true && Array.isArray(verdict?.hardFailures)
    && verdict.hardFailures.length > 0);
  return {
    status: trigger ? 'failed' : canonical.violations.length > 0 || !authority.complete ? 'inconclusive' : 'observing',
    shouldStop: Boolean(trigger),
    trigger: trigger ? {
      cueId: trigger.cue.cueId,
      revision: trigger.cue.revision,
      sequence: trigger.cue.sequence,
      eventSequence: trigger.cue.eventSequence,
      hardFailures: trigger.verdict.hardFailures,
    } : null,
    candidates: findings.filter(({ verdict }) => verdict?.status !== 'passed'),
    violations: [...canonical.violations, ...authority.violations],
  };
}

export function createEarlyStopRequest({ evaluation, identity, observedAtMs = Date.now() }) {
  if (evaluation?.shouldStop !== true || !evaluation.trigger) return null;
  const payload = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-early-stop-request',
    disposition: 'failed-incomplete',
    reason: 'watch.strict-content.deterministic-fact-mismatch',
    identity,
    observedAtMs,
    trigger: evaluation.trigger,
  };
  const canonical = JSON.stringify(payload);
  return { ...payload, digest: crypto.createHash('sha256').update(canonical).digest('hex') };
}

export function parseIncrementalJsonLines(text) {
  const events = [];
  let terminal = null;
  const violations = [];
  const lines = String(text ?? '').split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.artifactKind === 'watch-mode-incremental-terminal') {
        if (terminal) violations.push('multiple incremental terminal records');
        terminal = record;
      } else {
        events.push(record);
      }
    } catch {
      if (index < lines.length - 1) violations.push(`invalid complete JSONL line ${index + 1}`);
    }
  }
  return { events, terminal, violations };
}

export function inspectIncrementalEvidenceFile({ evidencePath, expectedIdentity }) {
  if (!fs.existsSync(evidencePath)) return { status: 'inconclusive', shouldStop: false, trigger: null, candidates: [], violations: ['incremental evidence file is missing'] };
  const parsed = parseIncrementalJsonLines(fs.readFileSync(evidencePath, 'utf8'));
  const evaluated = evaluateIncrementalEarlyStop({
    events: parsed.events, terminal: parsed.terminal, expectedIdentity, evaluateCue: evaluateAuditedCueForEarlyStop,
  });
  return { ...evaluated, violations: [...parsed.violations, ...evaluated.violations] };
}

if (isMain(import.meta.url)) {
  const options = parseCliArgs(process.argv.slice(2));
  const evidencePath = path.resolve(String(options.evidence ?? ''));
  const requestPath = path.resolve(String(options.request ?? ''));
  const expectedIdentity = { ...JSON.parse(String(options.identityJson ?? '{}')), mediaSha256: auditedMediaSha256 };
  const deadlineMs = Date.now() + Number(options.watchMs ?? 0);
  let evaluation;
  do {
    evaluation = inspectIncrementalEvidenceFile({ evidencePath, expectedIdentity });
    if (evaluation.shouldStop || Date.now() >= deadlineMs) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (true);
  if (evaluation.shouldStop) {
    const request = createEarlyStopRequest({ evaluation, identity: expectedIdentity });
    fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    process.stdout.write(`${requestPath}\n`);
    process.exitCode = 3;
  } else {
    process.stdout.write(`${JSON.stringify(evaluation)}\n`);
  }
}
