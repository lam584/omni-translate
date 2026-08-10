import { type ReactNode, useState } from 'react';
import AppIcon from '../../components/icons/AppIcon';
import i18n from '../../i18n/config';
import type { BenchmarkProgressEvent, BenchmarkReport, BenchmarkAudioFileInfo } from '../../runtime/benchmark-runtime';
import type { LiveSessionEvents } from '../../runtime/live-session-events-runtime';
import { writeExportArtifactRuntime, type ExportArtifactReceipt } from '../../runtime/export-artifact-runtime';
import {
  scoreBenchmarkReport,
  type BenchmarkRunState,
  type BenchmarkScoreV1,
} from './benchmarkReportScore';
import type { BenchmarkJudgeModel, BenchmarkSemanticJudgeResult } from './benchmarkSemanticJudge';
import { resolveBenchmarkReferenceTranslation, resolveBenchmarkSourceText } from './benchmarkReferenceText';

type BenchmarkProgressView = Pick<BenchmarkProgressEvent, 'status' | 'phase' | 'message' | 'audioChunksSent' | 'totalAudioChunks' | 'error'>;

const EMPTY_PIPELINE_MILESTONES: LiveSessionEvents['pipelineMilestones'] = {
  preconnectStartedMs: null, sessionReadyMs: null, routeStartedMs: null,
  firstAudioSentMs: null, firstSpeechStartedMs: null, queuedAudioChunks: null,
  droppedBeforeReady: null, firstAudibleChunkMs: null,
  silenceSkippedBeforeAudible: null, totalInputChunksAtSpeech: null,
};

// Shared building blocks for the metric grids and delta tables below.
function BenchmarkMetric({ hint, label, value }: { hint?: ReactNode; label: ReactNode; value: ReactNode }) {
  return (
    <div className="benchmark-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint !== undefined ? <small>{hint}</small> : null}
    </div>
  );
}

function DeltaTableSection({ finalText, headers, rows, title }: {
  finalText?: string | null;
  headers: string[];
  rows: ReactNode;
  title: string;
}) {
  return (
    <div className="benchmark-section">
      <h4>{title}</h4>
      {finalText ? <p className="benchmark-translation">{finalText}</p> : null}
      <div className="benchmark-delta-table-wrap">
        <table className="benchmark-delta-table">
          <thead>
            <tr>
              {headers.map((header) => (
                <th key={header}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
    </div>
  );
}

function LiveDeltaRow({ delta, position, text }: {
  delta: { elapsedMs: number; eventType: string; stash?: string | null };
  position: number;
  text?: string | null;
}) {
  return (
    <tr>
      <td className="benchmark-delta-idx">{position}</td>
      <td className="benchmark-delta-time">{delta.elapsedMs.toFixed(1)}ms</td>
      <td className="benchmark-delta-event">{delta.eventType}</td>
      <td className="benchmark-delta-stash">{delta.stash || '—'}</td>
      <td className="benchmark-delta-committed">{text || '—'}</td>
    </tr>
  );
}

export function BenchmarkProgressBanner({
  error,
  progress,
}: {
  error: string | null;
  progress: BenchmarkProgressView | null;
}) {
  if (!progress && !error) {
    return null;
  }

  const total = progress?.totalAudioChunks ?? 0;
  const sent = progress?.audioChunksSent ?? 0;
  const percent = total > 0 ? Math.min(100, Math.max(0, (sent / total) * 100)) : 0;
  const status = error ? 'error' : progress?.status ?? 'running';

  return (
    <div className={`benchmark-progress-card benchmark-progress-${status}`}>
      <div className="benchmark-progress-head">
        <span>{status === 'completed' ? i18n.t('diagnostics.status.completed') : status === 'error' ? i18n.t('diagnostics.status.failed') : i18n.t('diagnostics.status.running')}</span>
        <strong>{progress?.phase ?? 'starting'}</strong>
      </div>
      <p>{error || progress?.message || i18n.t('diagnostics.benchmark.waitingProgress')}</p>
      <div className="benchmark-progress-track" aria-label="benchmark progress">
        <div className="benchmark-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <small>{total > 0 ? `${sent} / ${total} chunks` : i18n.t('diagnostics.benchmark.waitingAudioChunks')}</small>
    </div>
  );
}

export function isBinaryAudioOutputEvent(eventType: string) {
  return ['response.audio.delta', 'response.output_audio.delta', 'response.audio.done', 'response.output_audio.done'].includes(eventType);
}

export function isTextOutputEvent(eventType: string) {
  return !isBinaryAudioOutputEvent(eventType);
}

export function textLength(value: string) {
  return [...value].length;
}

export function shouldUseCandidate(current: string, candidate: string) {
  return !!candidate && textLength(candidate) >= textLength(current);
}

export function buildOutputSegments(deltas: BenchmarkReport['runs'][number]['outputDeltas']) {
  const segments: string[] = [];
  let current = '';

  for (const delta of deltas) {
    const candidate = delta.rawText || delta.stash || delta.committedText;
    if (delta.eventType.endsWith('.delta')) {
      current += candidate;
      continue;
    }
    if (delta.eventType === 'response.audio_transcript.text') {
      if (shouldUseCandidate(current, candidate)) {
        current = candidate;
      }
      continue;
    }
    if (delta.eventType.endsWith('.done') || delta.eventType === 'response.done') {
      const finalText = shouldUseCandidate(current, candidate) ? candidate : current;
      if (finalText) {
        segments.push(finalText);
      }
      current = '';
      continue;
    }
    if (shouldUseCandidate(current, candidate)) {
      current = candidate;
    }
  }

  if (current) {
    segments.push(current);
  }

  return segments;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function AudioFileInfoSection({ info }: { info: BenchmarkAudioFileInfo }) {
  const channelLabel = info.channels === 1
    ? i18n.t('diagnostics.benchmark.audioMono')
    : info.channels === 2
      ? i18n.t('diagnostics.benchmark.audioStereo')
      : `${info.channels}`;
  return (
    <div className="benchmark-section">
      <h4>{i18n.t('diagnostics.benchmark.audioFileInfo')}</h4>
      <div className="benchmark-metrics-grid">
        <BenchmarkMetric label={i18n.t('diagnostics.benchmark.audioFileName')} value={info.fileName} />
        <BenchmarkMetric label={i18n.t('diagnostics.benchmark.audioFormat')} value={info.format.toUpperCase()} />
        <BenchmarkMetric label={i18n.t('diagnostics.benchmark.audioFileSize')} value={formatFileSize(info.fileSizeBytes)} />
        <BenchmarkMetric label={i18n.t('diagnostics.benchmark.audioSampleRate')} value={`${info.originalSampleRate} Hz`} />
        <BenchmarkMetric label={i18n.t('diagnostics.benchmark.audioChannels')} value={channelLabel} />
        <BenchmarkMetric label={i18n.t('diagnostics.benchmark.audioDecodedSamples')} value={`${info.decodedSamples.toLocaleString()} @ 16kHz`} />
        <BenchmarkMetric label={i18n.t('diagnostics.benchmark.audioDecodedDuration')} value={`${info.durationSecs.toFixed(2)}s`} />
      </div>
    </div>
  );
}

function formatScoreValue(value: number | null): string {
  return value == null ? '—' : value.toFixed(1);
}

function scoreStatusLabel(status: BenchmarkScoreV1['status']): string {
  return i18n.t(`diagnostics.benchmark.scoreStatus.${status}`);
}

function missingEvidenceLabel(value: string): string {
  const labels: Record<string, string> = {
    'source-text': i18n.t('diagnostics.benchmark.scoreMissingSource'),
    'reference-translation': i18n.t('diagnostics.benchmark.scoreMissingReference'),
    'completed-translation': i18n.t('diagnostics.benchmark.scoreMissingTranslation'),
    'judge-result-for-each-completed-run': i18n.t('diagnostics.benchmark.scoreMissingJudge'),
    'judge-model-unavailable': i18n.t('diagnostics.benchmark.scoreMissingJudgeModel'),
    'judge-credential-unavailable': i18n.t('diagnostics.benchmark.scoreMissingJudgeCredential'),
    'chrF2-for-each-completed-run': 'chrF2',
    'declared-runs': i18n.t('diagnostics.benchmark.scoreMissingRuns'),
    'run-record-for-each-declared-run': i18n.t('diagnostics.benchmark.scoreMissingRunRecord'),
  };
  return labels[value] ?? value.replace(/-/gu, ' ');
}

function scoreDimensionSummary(score: BenchmarkScoreV1, dimension: keyof BenchmarkScoreV1['dimensions']): string {
  const incompleteSummary = (detail: { score: number | null; missingEvidence: string[] }) => {
    if (detail.score != null) return null;
    return detail.missingEvidence.length
      ? detail.missingEvidence.map(missingEvidenceLabel).join(' · ')
      : i18n.t('diagnostics.benchmark.scoreEvidencePending');
  };
  switch (dimension) {
    case 'semantic': {
      const detail = score.dimensions.semantic;
      const missing = incompleteSummary(detail);
      if (missing) return missing;
      const weakestJudgeRun = [...detail.evidence.judge.runs]
        .sort((left, right) => left.score - right.score || left.runIndex - right.runIndex)[0];
      const runLabel = weakestJudgeRun
        ? `${i18n.t('diagnostics.benchmark.scoreRun', { run: weakestJudgeRun.runIndex + 1 })}: `
        : '';
      const keyError = weakestJudgeRun?.criticalErrors[0];
      if (keyError) return `${runLabel}${keyError.category}: ${keyError.description}`;
      if (weakestJudgeRun?.rationale) return `${runLabel}${weakestJudgeRun.rationale}`;
      return i18n.t('diagnostics.benchmark.scoreSemanticSummary', {
        reference: formatScoreValue(detail.evidence.referenceAverage),
        judge: formatScoreValue(detail.evidence.judge.average),
      });
    }
    case 'latency': {
      const detail = score.dimensions.latency;
      const missing = incompleteSummary(detail);
      if (missing) return missing;
      const slowest = detail.evidence.signals
        .filter((signal) => signal.score != null)
        .sort((left, right) => (left.score ?? 0) - (right.score ?? 0))[0];
      return slowest
        ? i18n.t('diagnostics.benchmark.scoreLatencySummary', {
          run: slowest.runIndex + 1,
          signal: slowest.signal === 'firstToken'
            ? i18n.t('diagnostics.benchmark.scoreFirstToken')
            : i18n.t('diagnostics.benchmark.scoreFirstCommitted'),
          latency: (slowest.latencyMs ?? 0).toFixed(1),
        })
        : i18n.t('diagnostics.benchmark.scoreEvidencePending');
    }
    case 'completeness': {
      const detail = score.dimensions.completeness;
      const missing = incompleteSummary(detail);
      if (missing) return missing;
      return i18n.t('diagnostics.benchmark.scoreCompletenessSummary', {
        completed: detail.evidence.completedRuns,
        declared: detail.evidence.declaredRuns,
      });
    }
    case 'stability': {
      const detail = score.dimensions.stability;
      const missing = incompleteSummary(detail);
      if (missing) return missing;
      return i18n.t('diagnostics.benchmark.scoreStabilitySummary', {
        successful: detail.evidence.successfulRuns,
        declared: detail.evidence.declaredRuns,
        deduction: detail.evidence.totalDeduction,
      });
    }
  }
}

function ScoreFormula({ children }: { children: ReactNode }) {
  return <p className="benchmark-score-formula"><strong>{i18n.t('diagnostics.benchmark.scoreFormula')}:</strong> {children}</p>;
}

function BenchmarkScoreCard({ score }: { score: BenchmarkScoreV1 }) {
  const semantic = score.dimensions.semantic;
  const latency = score.dimensions.latency;
  const completeness = score.dimensions.completeness;
  const stability = score.dimensions.stability;
  const dimensions: Array<{ key: keyof BenchmarkScoreV1['dimensions']; label: string }> = [
    { key: 'semantic', label: i18n.t('watchReport.score.semantic') },
    { key: 'latency', label: i18n.t('watchReport.score.latency') },
    { key: 'completeness', label: i18n.t('watchReport.score.completeness') },
    { key: 'stability', label: i18n.t('diagnostics.benchmark.scoreStability') },
  ];

  return (
    <section className="benchmark-result-score benchmark-result-score-v1" aria-label={i18n.t('diagnostics.benchmark.scoreTitle')}>
      <div className="benchmark-result-score-total">
        <span>{i18n.t('diagnostics.benchmark.scoreTitle')}</span>
        <small>{score.version} · {scoreStatusLabel(score.status)}</small>
        <strong>{formatScoreValue(score.total)}</strong>
        <b>{score.grade ?? '—'}</b>
      </div>
      <div className="benchmark-result-score-dimensions">
        {dimensions.map(({ key, label }) => {
          const dimension = score.dimensions[key];
          return (
            <BenchmarkMetric
              hint={scoreDimensionSummary(score, key)}
              key={key}
              label={`${label} · ${dimension.weight}%`}
              value={formatScoreValue(dimension.score)}
            />
          );
        })}
      </div>
      <p>{scoreStatusLabel(score.status)}</p>
      <div className="benchmark-score-details">
        <details>
          <summary>{i18n.t('watchReport.score.semantic')} · {formatScoreValue(semantic.score)}</summary>
          <ScoreFormula>{semantic.formula}</ScoreFormula>
          <div className="benchmark-score-evidence-grid">
            <BenchmarkMetric label="chrF2" value={formatScoreValue(semantic.evidence.referenceAverage)} />
            <BenchmarkMetric label={i18n.t('diagnostics.benchmark.scoreJudgeAverage')} value={formatScoreValue(semantic.evidence.judge.average)} />
            <BenchmarkMetric label={i18n.t('diagnostics.benchmark.scoreCompletedRuns')} value={semantic.evidence.completedRunIndexes.length} />
            <BenchmarkMetric label={i18n.t('diagnostics.benchmark.scoreJudgeModel')} value={semantic.evidence.judge.model ?? '—'} />
            <BenchmarkMetric label="rubricVersion" value={semantic.evidence.judge.rubricVersion ?? '—'} />
          </div>
          {semantic.missingEvidence.length ? (
            <p className="benchmark-score-missing"><strong>{i18n.t('diagnostics.benchmark.scoreMissingEvidence')}:</strong> {semantic.missingEvidence.map(missingEvidenceLabel).join(' · ')}</p>
          ) : null}
          {semantic.evidence.referenceByRun.length ? (
            <ul className="benchmark-score-list">
              {semantic.evidence.referenceByRun.map(({ runIndex, chrF2 }) => (
                <li key={`reference-${runIndex}`}>
                  <span>{i18n.t('diagnostics.benchmark.scoreRun', { run: runIndex + 1 })}: chrF2 {formatScoreValue(chrF2.score)} (P {formatScoreValue(chrF2.precision)}, R {formatScoreValue(chrF2.recall)})</span>
                  <details className="benchmark-score-chrf-raw">
                    <summary>chrF2 raw n-gram evidence</summary>
                    <p className="benchmark-score-formula">{chrF2.normalization}; n = 1–{chrF2.characterNgramOrder}; β = {chrF2.beta}</p>
                    <div className="benchmark-score-signal-table-wrap">
                      <table className="benchmark-score-signal-table">
                        <thead><tr><th>n</th><th>candidate n-grams</th><th>reference n-grams</th><th>matches</th><th>P</th><th>R</th></tr></thead>
                        <tbody>
                          {chrF2.orders.map((order) => (
                            <tr key={order.order}>
                              <td>{order.order}</td>
                              <td>{order.candidateNgrams}</td>
                              <td>{order.referenceNgrams}</td>
                              <td>{order.matchedNgrams}</td>
                              <td>{formatScoreValue(order.precision)}</td>
                              <td>{formatScoreValue(order.recall)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          ) : null}
          {semantic.evidence.judge.runs.length ? (
            <ul className="benchmark-score-list">
              {semantic.evidence.judge.runs.map((run) => (
                <li key={`judge-${run.runIndex}`}>
                  <strong>{i18n.t('diagnostics.benchmark.scoreRun', { run: run.runIndex + 1 })}: {formatScoreValue(run.score)}</strong>
                  <span>{` ${i18n.t('diagnostics.benchmark.scoreSubscores')}: ${i18n.t('diagnostics.benchmark.scoreAdequacy')} ${formatScoreValue(run.subscores.adequacy)}, ${i18n.t('diagnostics.benchmark.scoreFactsTerminology')} ${formatScoreValue(run.subscores.factsTerminology)}, ${i18n.t('diagnostics.benchmark.scoreOmissionsAdditions')} ${formatScoreValue(run.subscores.omissionsAdditions)}, ${i18n.t('diagnostics.benchmark.scoreFluency')} ${formatScoreValue(run.subscores.fluency)}`}</span>
                  {run.rationale ? <span className="benchmark-score-rationale">{run.rationale}</span> : null}
                  {run.criticalErrors.map((error, index) => (
                    <span className="benchmark-score-critical-error" key={`${error.category}-${index}`}>{error.category}: {error.description}{error.sourceEvidence ? ` [${error.sourceEvidence}]` : ''}{error.candidateEvidence ? ` → ${error.candidateEvidence}` : ''}</span>
                  ))}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
        <details>
          <summary>{i18n.t('watchReport.score.latency')} · {formatScoreValue(latency.score)}</summary>
          <ScoreFormula>{latency.formula}</ScoreFormula>
          {latency.missingEvidence.length ? <p className="benchmark-score-missing"><strong>{i18n.t('diagnostics.benchmark.scoreMissingEvidence')}:</strong> {latency.missingEvidence.map(missingEvidenceLabel).join(' · ')}</p> : null}
          <div className="benchmark-score-signal-table-wrap">
            <table className="benchmark-score-signal-table">
              <thead><tr><th>{i18n.t('diagnostics.benchmark.scoreRun')}</th><th>{i18n.t('diagnostics.benchmark.scoreSignal')}</th><th>{i18n.t('diagnostics.benchmark.scoreObserved')}</th><th>{i18n.t('diagnostics.benchmark.scoreThreshold')}</th><th>{i18n.t('diagnostics.benchmark.scoreContribution')}</th></tr></thead>
              <tbody>
                {latency.evidence.signals.map((signal) => (
                  <tr key={`${signal.runIndex}-${signal.signal}`}>
                    <td>{signal.runIndex + 1}</td>
                    <td>{signal.signal === 'firstToken' ? i18n.t('diagnostics.benchmark.scoreFirstToken') : i18n.t('diagnostics.benchmark.scoreFirstCommitted')}</td>
                    <td>{signal.latencyMs == null ? '—' : `${signal.latencyMs.toFixed(1)}ms`}</td>
                    <td>≤{signal.threshold.good}ms = 100; ≥{signal.threshold.bad}ms = 0</td>
                    <td>{formatScoreValue(signal.score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
        <details>
          <summary>{i18n.t('watchReport.score.completeness')} · {formatScoreValue(completeness.score)}</summary>
          <ScoreFormula>{completeness.formula}</ScoreFormula>
          <p>{i18n.t('diagnostics.benchmark.scoreCompletenessSummary', { completed: completeness.evidence.completedRuns, declared: completeness.evidence.declaredRuns })}</p>
          {completeness.evidence.incompleteRuns.length ? (
            <ul className="benchmark-score-list">
              {completeness.evidence.incompleteRuns.map((run) => <li key={`incomplete-${run.runIndex}`}>{i18n.t('diagnostics.benchmark.scoreRun', { run: run.runIndex + 1 })}: {run.missing.map(missingEvidenceLabel).join(', ')}</li>)}
            </ul>
          ) : null}
        </details>
        <details>
          <summary>{i18n.t('diagnostics.benchmark.scoreStability')} · {formatScoreValue(stability.score)}</summary>
          <ScoreFormula>{stability.formula}</ScoreFormula>
          <p>{i18n.t('diagnostics.benchmark.scoreStabilitySummary', { successful: stability.evidence.successfulRuns, declared: stability.evidence.declaredRuns, deduction: stability.evidence.totalDeduction })}</p>
          {stability.evidence.deductions.length ? (
            <ul className="benchmark-score-list">
              {stability.evidence.deductions.map((deduction) => <li key={`${deduction.runIndex}-${deduction.responseOrdinal}`}>{i18n.t('diagnostics.benchmark.scoreRun', { run: deduction.runIndex + 1 })}: {i18n.t('diagnostics.benchmark.scoreExtraResponse', { response: deduction.responseOrdinal, deduction: deduction.amount })}</li>)}
            </ul>
          ) : <p className="benchmark-score-no-deductions">{i18n.t('diagnostics.benchmark.scoreNoDeductions')}</p>}
        </details>
      </div>
    </section>
  );
}

export function BenchmarkReportDetail({
  report,
  semanticJudgeModels = [],
  semanticJudgeModelId = '',
  semanticJudgeRunning = false,
  semanticJudgeError = null,
  semanticJudgeResult = null,
  benchmarkState,
  score,
  onSemanticJudgeModelChange,
  onRunSemanticJudge,
}: {
  report: BenchmarkReport;
  semanticJudgeModels?: BenchmarkJudgeModel[];
  semanticJudgeModelId?: string;
  semanticJudgeRunning?: boolean;
  semanticJudgeError?: string | null;
  semanticJudgeResult?: BenchmarkSemanticJudgeResult | null;
  benchmarkState?: BenchmarkRunState;
  score?: BenchmarkScoreV1;
  onSemanticJudgeModelChange?: (modelId: string) => void;
  onRunSemanticJudge?: () => void;
}) {
  const benchmarkScore = score ?? scoreBenchmarkReport(report, {
    benchmarkState,
    judgeError: semanticJudgeError,
    judgeState: semanticJudgeRunning ? 'running' : semanticJudgeError ? 'failed' : semanticJudgeResult ? 'completed' : 'idle',
    semanticJudge: semanticJudgeResult,
    sourceText: resolveBenchmarkSourceText(report.audioFile),
    referenceTranslation: resolveBenchmarkReferenceTranslation(report.audioFile),
  });
  const run = report.runs[0];
  if (!run) {
    return (
      <div className="benchmark-detail">
        <BenchmarkScoreCard score={benchmarkScore} />
        <div className="benchmark-empty">{i18n.t('diagnostics.benchmark.waitingFirstData')}</div>
      </div>
    );
  }

  const fmt = (value: number | null | undefined, unit = 'ms') => (value == null ? 'N/A' : `${value.toFixed(1)}${unit}`);
  const textOutputDeltas = run.outputDeltas.filter((delta) => isTextOutputEvent(delta.eventType));
  const outputSegments = buildOutputSegments(textOutputDeltas);
  const segmentedOutput = outputSegments.join('');
  const asrFinal = run.asrFinal;
  const asrEventCount = run.asrDeltas.length;
  const fullTranslation = run.translationFinal || segmentedOutput || textOutputDeltas.map((delta) => delta.committedText || delta.stash || delta.rawText).join('');
  const isManualMode = (report.realtimeAudioMode ?? 'server_vad') === 'manual';
  const vadModeLabel = isManualMode ? i18n.t('diagnostics.benchmark.manualFullAudioMode') : i18n.t('diagnostics.benchmark.serverVadMode');
  const timeRangeEnd = Math.max(run.audioSendMs, run.responseDoneMs ?? 0, run.firstOutputMs ?? 0, run.responseCreatedMs ?? 0, 1);
  const pct = (value: number | null | undefined) => (value == null ? null : Math.max(0, Math.min(100, (value / timeRangeEnd) * 100)));
  const summary = report.summary;
  const translationChars = [...fullTranslation].length;
  const outputDuration = run.totalOutputDurationMs ?? (
    run.responseDoneMs != null && run.firstOutputMs != null
      ? run.responseDoneMs - run.firstOutputMs
      : run.responseDoneMs != null && run.responseCreatedMs != null ? run.responseDoneMs - run.responseCreatedMs : null
  );
  const modelTTFT = run.firstOutputMs != null && run.responseCreatedMs != null ? run.firstOutputMs - run.responseCreatedMs : null;
  const responseToFirst = modelTTFT;
  const translationThroughput = outputDuration && outputDuration > 0 && translationChars > 0
    ? translationChars / (outputDuration / 1000)
    : null;
  const intervalValues = textOutputDeltas.slice(1).map((delta, index) => delta.elapsedMs - textOutputDeltas[index]!.elapsedMs).filter((gap) => gap >= 0);
  const avgInterval = intervalValues.length > 0 ? intervalValues.reduce((sum, gap) => sum + gap, 0) / intervalValues.length : null;
  const hasTranscriptOnly = textOutputDeltas.length === 0 && !fullTranslation && !!asrFinal;
  const isSparse = textOutputDeltas.length > 0 && textOutputDeltas.length <= 3 && run.audioDurationSecs > 5;
  const responseDoneAudioChunksSent = run.responseDoneAudioChunksSent ?? null;
  const responseDoneAudioSentSecs = run.responseDoneAudioSentSecs ?? null;
  const responseDoneAudioPct = responseDoneAudioSentSecs == null || run.audioDurationSecs <= 0
    ? null
    : Math.min(100, Math.max(0, (responseDoneAudioSentSecs / run.audioDurationSecs) * 100));
  const responseDoneEarlyThresholdSecs = Math.max(1.5, run.audioDurationSecs * 0.1);
  const responseDoneBeforeFullAudio = responseDoneAudioSentSecs != null
    && responseDoneAudioSentSecs + responseDoneEarlyThresholdSecs < run.audioDurationSecs;
  const latestOutputDeltas = textOutputDeltas
    .map((delta, index) => ({ delta, index }))
    .reverse();
  const latestAsrDeltas = run.asrDeltas
    .map((delta, index) => ({ delta, index }))
    .reverse();
  return (
    <div className="benchmark-detail">
      <BenchmarkScoreCard score={benchmarkScore} />
      {onSemanticJudgeModelChange && onRunSemanticJudge ? (
        <section className="benchmark-semantic-judge">
          <label>
            <span>{i18n.t('runtime.benchmark.semanticJudgeModel')}</span>
            <select disabled={semanticJudgeRunning || semanticJudgeModels.length === 0} onChange={(event) => onSemanticJudgeModelChange(event.target.value)} value={semanticJudgeModelId}>
              <option value="">{i18n.t('runtime.benchmark.semanticJudgeChooseModel')}</option>
              {semanticJudgeModels.map((model) => <option key={model.modelId} value={model.modelId}>{model.displayName}</option>)}
            </select>
          </label>
          <button disabled={semanticJudgeRunning || !semanticJudgeModelId || !report.runs.length} onClick={onRunSemanticJudge} type="button">
            {semanticJudgeRunning ? i18n.t('runtime.benchmark.semanticJudgeRunning') : i18n.t('runtime.benchmark.semanticJudgeRun')}
          </button>
          {semanticJudgeError ? <p className="benchmark-warning" role="alert">{semanticJudgeError}</p> : null}
          {semanticJudgeResult ? <p className="benchmark-semantic-judge-result">{i18n.t('runtime.benchmark.semanticJudgeResult', { model: semanticJudgeResult.model, score: semanticJudgeResult.score, count: semanticJudgeResult.runs.length })}</p> : null}
        </section>
      ) : null}
      {(isSparse || responseDoneBeforeFullAudio) ? (
        <div className="benchmark-warning">
          <strong>{i18n.t('diagnostics.benchmark.outputDiagnosticHint')}</strong>
          {isSparse ? <span>{i18n.t('diagnostics.benchmark.sparseOutputHint', { count: textOutputDeltas.length })}</span> : null}
          {responseDoneBeforeFullAudio ? <span>{i18n.t('diagnostics.benchmark.responseDoneBeforeFullAudio', { seconds: responseDoneAudioSentSecs?.toFixed(1), percent: responseDoneAudioPct?.toFixed(1) })}</span> : null}
        </div>
      ) : null}
      {hasTranscriptOnly ? (
        <div className="benchmark-warning">
          <strong>{i18n.t('diagnostics.benchmark.modelEventHint')}</strong>
          <span>{i18n.t('diagnostics.benchmark.transcriptOnlyHint')}</span>
        </div>
      ) : null}

      {report.audioInfo ? <AudioFileInfoSection info={report.audioInfo} /> : null}

      <div className="benchmark-section">
        <h4>{i18n.t('diagnostics.benchmark.timeline')}</h4>
        <div className="benchmark-timeline-track">
          <div className="benchmark-timeline-audio" style={{ width: `${pct(run.audioSendMs)}%` }} title={i18n.t('diagnostics.benchmark.audioSendWithTime', { time: fmt(run.audioSendMs) })} />
          {pct(run.responseCreatedMs) != null ? <span className="benchmark-timeline-marker benchmark-timeline-response" style={{ left: `${pct(run.responseCreatedMs)}%` }} title={`${i18n.t('diagnostics.benchmark.responseCreated')} ${fmt(run.responseCreatedMs)}`} /> : null}
          {pct(run.firstOutputMs) != null ? <span className="benchmark-timeline-marker benchmark-timeline-first" style={{ left: `${pct(run.firstOutputMs)}%` }} title={i18n.t('diagnostics.benchmark.firstTokenWithTime', { time: fmt(run.firstOutputMs) })} /> : null}
          {pct(run.responseDoneMs) != null ? <span className="benchmark-timeline-marker benchmark-timeline-done" style={{ left: `${pct(run.responseDoneMs)}%` }} title={`${i18n.t('diagnostics.benchmark.responseDone')} ${fmt(run.responseDoneMs)}`} /> : null}
        </div>
        <div className="benchmark-timeline-legend">
          <span><i className="benchmark-legend-audio" />{i18n.t('diagnostics.benchmark.audioSend')}</span>
          <span><i className="benchmark-legend-response" />{i18n.t('diagnostics.benchmark.responseLegend')}</span>
          <span><i className="benchmark-legend-first" />{i18n.t('diagnostics.benchmark.firstToken')}</span>
        </div>
      </div>

      <div className="benchmark-section">
        <h4>{i18n.t('diagnostics.benchmark.stageDurations')}</h4>
        <div className="benchmark-metrics-grid">
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.websocketConnect')} value={fmt(run.connectMs)} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.sessionReady')} value={fmt(run.sessionReadyMs)} />
          <BenchmarkMetric hint={i18n.t('diagnostics.benchmark.audioChunksDuration', { chunks: run.audioChunksSent, seconds: run.audioDurationSecs.toFixed(1) })} label={i18n.t('diagnostics.benchmark.audioSend')} value={fmt(run.audioSendMs)} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.firstAsr')} value={fmt(run.firstAsrMs)} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.firstToken')} value={fmt(run.firstOutputMs)} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.responseDone')} value={fmt(run.responseDoneMs)} />
          <BenchmarkMetric hint={responseDoneAudioChunksSent == null ? i18n.t('diagnostics.benchmark.noChunkRecorded') : `${responseDoneAudioChunksSent} chunks · ${responseDoneAudioPct?.toFixed(1) ?? 'N/A'}%`} label={i18n.t('diagnostics.benchmark.audioSentAtDone')} value={responseDoneAudioSentSecs == null ? 'N/A' : `${responseDoneAudioSentSecs.toFixed(1)}s`} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.firstTokenAfterResponse')} value={modelTTFT == null ? 'N/A' : modelTTFT < 0 ? i18n.t('diagnostics.benchmark.beforeResponse') : fmt(modelTTFT)} />
        </div>
      </div>

      <div className="benchmark-section">
        <h4>{i18n.t('diagnostics.benchmark.vadAndAsr')}</h4>
        <div className="benchmark-metrics-grid">
          <BenchmarkMetric hint={isManualMode ? i18n.t('diagnostics.benchmark.manualModeNoServerVad') : i18n.t('diagnostics.benchmark.serverDecidesSpeechBoundaries')} label={i18n.t('diagnostics.benchmark.vadMode')} value={vadModeLabel} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.vadSpeechStart')} value={isManualMode ? i18n.t('diagnostics.benchmark.notApplicable') : fmt(run.speechStartedMs)} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.vadSpeechEnd')} value={isManualMode ? i18n.t('diagnostics.benchmark.notApplicable') : fmt(run.speechStoppedMs)} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.streamingAsrEvents')} value={asrEventCount} />
          <div className="benchmark-metric benchmark-metric-wide">
            <span>{i18n.t('diagnostics.benchmark.asrFinalText')}</span>
            <small className="benchmark-text-preview">{asrFinal || i18n.t('diagnostics.benchmark.none')}</small>
          </div>
        </div>
      </div>
      <div className="benchmark-section">
        <h4>{i18n.t('diagnostics.benchmark.outputTimingStats')}</h4>
        <div className="benchmark-metrics-grid">
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.responseCreated')} value={fmt(run.responseCreatedMs)} />
          <BenchmarkMetric hint={responseToFirst == null ? 'N/A' : responseToFirst < 0 ? i18n.t('diagnostics.benchmark.beforeResponseWithTime', { time: fmt(Math.abs(responseToFirst)) }) : i18n.t('diagnostics.benchmark.afterResponseWithTime', { time: fmt(responseToFirst) })} label={i18n.t('diagnostics.benchmark.firstToken')} value={fmt(run.firstOutputMs)} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.firstCommit')} value={fmt(run.firstCommittedMs)} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.totalOutputDuration')} value={fmt(outputDuration)} />
          <BenchmarkMetric hint={i18n.t('diagnostics.benchmark.responseDoneCount', { count: run.responseCount })} label={i18n.t('diagnostics.benchmark.outputEventCount')} value={textOutputDeltas.length} />
          <BenchmarkMetric hint={isManualMode ? i18n.t('diagnostics.benchmark.manualUsuallyOneSegment') : i18n.t('diagnostics.benchmark.serverVadMultiSegment')} label={i18n.t('diagnostics.benchmark.responseSegments')} value={Math.max(run.responseCount, outputSegments.length)} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.outputCharacters')} value={translationChars} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.throughput')} value={translationThroughput == null ? 'N/A' : i18n.t('diagnostics.benchmark.charactersPerSecond', { value: translationThroughput.toFixed(1) })} />
        </div>
      </div>

      <div className="benchmark-section">
        <h4>{i18n.t('diagnostics.benchmark.deltaIntervalStats')}</h4>
        <div className="benchmark-metrics-grid">
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.averageInterval')} value={fmt(summary.avgOutputDeltaIntervalMs ?? avgInterval)} />
          <BenchmarkMetric label="P50" value={fmt(summary.p50DeltaIntervalMs)} />
          <BenchmarkMetric label="P90" value={fmt(summary.p90DeltaIntervalMs)} />
          <BenchmarkMetric label="P99" value={fmt(summary.p99DeltaIntervalMs)} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.minInterval')} value={fmt(summary.minDeltaIntervalMs)} />
          <BenchmarkMetric label={i18n.t('diagnostics.benchmark.maxInterval')} value={fmt(summary.maxDeltaIntervalMs)} />
        </div>
      </div>

      <div className="benchmark-section">
        <h4>{i18n.t('diagnostics.benchmark.liveAndFinalOutput', { count: translationChars })}</h4>
        <div className="benchmark-translation">{fullTranslation || i18n.t('diagnostics.benchmark.waitingOutput')}</div>
      </div>
      {outputSegments.length > 0 ? (
        <div className="benchmark-section">
          <h4>{i18n.t('diagnostics.benchmark.segmentedOutput', { count: outputSegments.length })}</h4>
          <div className="benchmark-translation">{segmentedOutput}</div>
        </div>
      ) : null}

      {textOutputDeltas.length > 0 ? (
        <DeltaTableSection
          headers={['#', i18n.t('diagnostics.benchmark.timeMs'), i18n.t('diagnostics.benchmark.event'), 'Stash / Delta', i18n.t('diagnostics.benchmark.committedText')]}
          rows={latestOutputDeltas.map(({ delta, index }) => (
            <tr key={`${delta.elapsedMs}-${index}`}>
              <td className="benchmark-delta-idx">{index + 1}</td>
              <td className="benchmark-delta-time">{delta.elapsedMs.toFixed(1)}</td>
              <td className="benchmark-delta-type">{delta.eventType.replace('response.', '')}</td>
              <td className="benchmark-delta-stash">{delta.stash || (!delta.committedText ? delta.rawText : '') || '—'}</td>
              <td className="benchmark-delta-committed">{delta.committedText || (!delta.stash ? delta.rawText : '') || '—'}</td>
            </tr>
          ))}
          title={i18n.t('diagnostics.benchmark.outputEventDetails', { count: textOutputDeltas.length })}
        />
      ) : null}

      {run.asrDeltas.length > 0 ? (
        <DeltaTableSection
          headers={['#', i18n.t('diagnostics.benchmark.timeMs'), 'Stash', i18n.t('diagnostics.benchmark.text')]}
          rows={latestAsrDeltas.map(({ delta, index }) => (
            <tr key={`${delta.elapsedMs}-${index}`}>
              <td className="benchmark-delta-idx">{index + 1}</td>
              <td className="benchmark-delta-time">{delta.elapsedMs.toFixed(1)}</td>
              <td className="benchmark-delta-stash">{delta.stash || '—'}</td>
              <td className="benchmark-delta-committed">{delta.text || '—'}</td>
            </tr>
          ))}
          title={i18n.t('diagnostics.benchmark.asrEventDetails', { count: run.asrDeltas.length })}
        />
      ) : null}
    </div>
  );
}

export function fmtMs(value: number | null | undefined): string {
  if (value == null) return 'N/A';
  return `${value.toFixed(0)}ms`;
}

export function exportFile(content: string, filename: string, mimeType: string): Promise<ExportArtifactReceipt> {
  return writeExportArtifactRuntime(filename, content, mimeType);
}

export function exportJson(data: unknown, filename: string): Promise<ExportArtifactReceipt> {
  return exportFile(JSON.stringify(data, null, 2), filename, 'application/json');
}

// eslint-disable-next-line react-refresh/only-export-components -- static download facade is shared by the diagnostics screen and export tests.
export class DiagnosticsReportExporter {
  static exportBenchmark(report: BenchmarkReport, basename: string, format: 'json' | 'txt', score?: BenchmarkScoreV1) {
    const benchmarkScore = score ?? scoreBenchmarkReport(report, {
      sourceText: resolveBenchmarkSourceText(report.audioFile),
      referenceTranslation: resolveBenchmarkReferenceTranslation(report.audioFile),
    });
    if (format === 'json') {
      return exportJson({ report, benchmarkScore }, `${basename}.json`);
    }
    return exportFile(formatBenchmarkTxt(report, benchmarkScore), `${basename}.txt`, 'text/plain');
  }

  static exportLiveEvents(events: LiveSessionEvents, basename: string, format: 'json' | 'txt') {
    if (format === 'json') {
      return exportJson(events, `${basename}.json`);
    }
    return exportFile(formatLiveEventsTxt(events), `${basename}.txt`, 'text/plain');
  }
}

export function formatLiveEventsTxt(events: LiveSessionEvents): string {
  const lines: string[] = [];
  lines.push(`=== Live Session Events ===`);
  lines.push(`Model: ${events.model}`);
  lines.push(`Session Started: ${events.sessionStartedAt}`);
  lines.push(`Elapsed: ${events.elapsedMs}ms`);
  lines.push('');
  lines.push('--- Pipeline Milestones ---');
  const m = events.pipelineMilestones ?? EMPTY_PIPELINE_MILESTONES;
  lines.push(`  Preconnect:        ${fmtMs(m.preconnectStartedMs)}`);
  lines.push(`  Session Ready:     ${fmtMs(m.sessionReadyMs)}`);
  lines.push(`  Route Started:     ${fmtMs(m.routeStartedMs)}`);
  lines.push(`  First Audio Sent:  ${fmtMs(m.firstAudioSentMs)}`);
  lines.push(`  First Speech:      ${fmtMs(m.firstSpeechStartedMs)}`);
  lines.push(`  Queued Chunks:     ${m.queuedAudioChunks ?? 'N/A'}`);
  lines.push(`  Dropped Before Ready: ${m.droppedBeforeReady ?? 'N/A'}`);
  lines.push('');
  lines.push('--- Audio Diagnostics ---');
  lines.push(`  First Audible Chunk:       ${fmtMs(m.firstAudibleChunkMs)}`);
  lines.push(`  Silence Skipped (pre-audible): ${m.silenceSkippedBeforeAudible ?? 'N/A'}`);
  lines.push(`  Total Input Chunks (at speech): ${m.totalInputChunksAtSpeech ?? 'N/A'}`);
  // Computed timing analysis
  if (m.firstAudioSentMs != null && m.firstAudibleChunkMs != null) {
    lines.push(`  Audio Sent -> Audible:     ${m.firstAudibleChunkMs - m.firstAudioSentMs}ms`);
  }
  if (m.firstAudioSentMs != null && m.firstSpeechStartedMs != null) {
    lines.push(`  Audio Sent -> VAD Speech:  ${m.firstSpeechStartedMs - m.firstAudioSentMs}ms`);
  }
  if (m.firstAudibleChunkMs != null && m.firstSpeechStartedMs != null) {
    lines.push(`  Audible -> VAD Speech:     ${m.firstSpeechStartedMs - m.firstAudibleChunkMs}ms`);
  }
  if (m.totalInputChunksAtSpeech != null && m.firstSpeechStartedMs != null) {
    lines.push(`  Chunks sent to server (at speech): ~${m.totalInputChunksAtSpeech} input chunks`);
  }
  lines.push('');
  if (events.asrDeltas.length > 0) {
    lines.push(`--- ASR Events (${events.asrDeltas.length}) ---`);
    lines.push(`  #\tTime\tEventType\tStash\tText`);
    events.asrDeltas.forEach((d, i) => {
      lines.push(`  ${i + 1}\t${d.elapsedMs.toFixed(1)}ms\t${d.eventType}\t${d.stash || '-'}\t${d.text || '-'}`);
    });
    if (events.asrFinal) lines.push(`  Final: ${events.asrFinal}`);
    lines.push('');
  }
  if (events.outputDeltas.length > 0) {
    lines.push(`--- Output Events (${events.outputDeltas.length}) ---`);
    lines.push(`  #\tTime\tEventType\tStash\tCommitted`);
    events.outputDeltas.forEach((d, i) => {
      lines.push(`  ${i + 1}\t${d.elapsedMs.toFixed(1)}ms\t${d.eventType}\t${d.stash || '-'}\t${d.committedText || '-'}`);
    });
    if (events.translationFinal) lines.push(`  Final: ${events.translationFinal}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function formatBenchmarkTxt(report: BenchmarkReport, score?: BenchmarkScoreV1): string {
  const lines: string[] = [];
  lines.push(`=== Benchmark Report ===`);
  lines.push(`Model: ${report.model}`);
  lines.push(`Audio File: ${report.audioFile}`);
  lines.push(`Audio Duration: ${report.audioDurationSecs.toFixed(1)}s`);
  const benchmarkScore = score ?? scoreBenchmarkReport(report, {
    sourceText: resolveBenchmarkSourceText(report.audioFile),
    referenceTranslation: resolveBenchmarkReferenceTranslation(report.audioFile),
  });
  lines.push('');
  lines.push('--- Public Benchmark Score ---');
  lines.push(`  Version: ${benchmarkScore.version}`);
  lines.push(`  Status: ${benchmarkScore.status}`);
  lines.push(`  Total: ${benchmarkScore.total ?? 'N/A'}${benchmarkScore.grade ? ` (${benchmarkScore.grade})` : ''}`);
  lines.push(`  Weights: semantic ${benchmarkScore.weights.semantic}%, latency ${benchmarkScore.weights.latency}%, completeness ${benchmarkScore.weights.completeness}%, stability ${benchmarkScore.weights.stability}%`);
  Object.entries(benchmarkScore.dimensions).forEach(([name, dimension]) => {
    lines.push(`  ${name}: ${dimension.score ?? 'N/A'} (${dimension.status})`);
    lines.push(`    Formula: ${dimension.formula}`);
    if (dimension.missingEvidence.length) lines.push(`    Missing evidence: ${dimension.missingEvidence.join(', ')}`);
  });
  if (benchmarkScore.deductions.length) {
    lines.push('  Stability deductions:');
    benchmarkScore.deductions.forEach((deduction) => lines.push(`    Run #${deduction.runIndex + 1}, response #${deduction.responseOrdinal}: -${deduction.amount}`));
  }
  if (benchmarkScore.judge.model) {
    lines.push(`  Judge: ${benchmarkScore.judge.model} (${benchmarkScore.judge.rubricVersion ?? 'unknown rubric'})`);
    benchmarkScore.judge.runs.forEach((run) => {
      lines.push(`    Run #${run.runIndex + 1}: ${run.score}; adequacy ${run.subscores.adequacy}, facts/terms ${run.subscores.factsTerminology}, omissions/additions ${run.subscores.omissionsAdditions}, fluency ${run.subscores.fluency}`);
      if (run.rationale) lines.push(`      Rationale: ${run.rationale}`);
      run.criticalErrors.forEach((error) => lines.push(`      Critical error [${error.category}]: ${error.description}`));
    });
  }
  if (report.audioInfo) {
    const ai = report.audioInfo;
    lines.push('');
    lines.push('--- Audio File Info ---');
    lines.push(`  File Name: ${ai.fileName}`);
    lines.push(`  Format: ${ai.format.toUpperCase()}`);
    lines.push(`  File Size: ${formatFileSize(ai.fileSizeBytes)}`);
    lines.push(`  Original Sample Rate: ${ai.originalSampleRate} Hz`);
    lines.push(`  Channels: ${ai.channels}`);
    lines.push(`  Decoded Samples: ${ai.decodedSamples} @ 16kHz`);
    lines.push(`  Decoded Duration: ${ai.durationSecs.toFixed(2)}s`);
  }
  lines.push('');
  const s = report.summary;
  lines.push('--- Summary ---');
  lines.push(`  Runs: ${s.runCount}, Successful: ${s.successfulRuns}`);
  lines.push(`  Avg Connect: ${s.avgConnectMs.toFixed(0)}ms`);
  lines.push(`  Avg Session Ready: ${s.avgSessionReadyMs.toFixed(0)}ms`);
  lines.push(`  Avg TTFT: ${s.avgTimeToFirstTokenMs?.toFixed(0) ?? 'N/A'}ms`);
  lines.push(`  Avg TTFC: ${s.avgTimeToFirstCommittedMs?.toFixed(0) ?? 'N/A'}ms`);
  lines.push(`  Avg Delta Interval: ${s.avgOutputDeltaIntervalMs?.toFixed(1) ?? 'N/A'}ms`);
  lines.push(`  P50/P90/P99 Delta: ${s.p50DeltaIntervalMs?.toFixed(1) ?? 'N/A'} / ${s.p90DeltaIntervalMs?.toFixed(1) ?? 'N/A'} / ${s.p99DeltaIntervalMs?.toFixed(1) ?? 'N/A'}ms`);
  lines.push(`  Min/Max Delta: ${s.minDeltaIntervalMs?.toFixed(1) ?? 'N/A'} / ${s.maxDeltaIntervalMs?.toFixed(1) ?? 'N/A'}ms`);
  lines.push('');
  report.runs.forEach((run) => {
    lines.push(`--- Run #${run.runIndex} ---`);
    lines.push(`  Connect: ${run.connectMs}ms | Session Ready: ${run.sessionReadyMs}ms | Audio Send: ${run.audioSendMs}ms`);
    lines.push(`  Audio Chunks: ${run.audioChunksSent} (${run.audioDurationSecs.toFixed(1)}s)`);
    lines.push(`  First ASR: ${run.firstAsrMs?.toFixed(0) ?? 'N/A'}ms | First Output: ${run.firstOutputMs?.toFixed(0) ?? 'N/A'}ms`);
    lines.push(`  Response Done: ${run.responseDoneMs?.toFixed(0) ?? 'N/A'}ms`);
    lines.push(`  Speech Started: ${run.speechStartedMs?.toFixed(0) ?? 'N/A'}ms | Speech Stopped: ${run.speechStoppedMs?.toFixed(0) ?? 'N/A'}ms`);
    if (run.asrFinal) lines.push(`  ASR Final: ${run.asrFinal}`);
    if (run.translationFinal) lines.push(`  Translation Final: ${run.translationFinal}`);
    if (run.outputDeltas.length > 0) {
      lines.push(`  Output Deltas (${run.outputDeltas.length}):`);
      lines.push(`    #\tTime\tEventType\tStash\tCommitted`);
      run.outputDeltas.forEach((d, i) => {
        lines.push(`    ${i + 1}\t${d.elapsedMs.toFixed(1)}ms\t${d.eventType}\t${d.stash || '-'}\t${d.committedText || '-'}`);
      });
    }
    lines.push('');
  });
  // Keep the readable report above, then include both source objects intact
  // so a TXT export is as auditable and reproducible as its JSON sibling.
  lines.push('--- Raw Benchmark Report JSON ---');
  lines.push(JSON.stringify(report, null, 2));
  lines.push('');
  lines.push('--- BenchmarkScoreV1 JSON ---');
  lines.push(JSON.stringify(benchmarkScore, null, 2));
  return lines.join('\n');
}

export function ExportButton({ onExport }: { onExport: (format: 'json' | 'txt') => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button className="icon-button" onClick={() => setOpen((v) => !v)} type="button" title={i18n.t('diagnostics.export.title')}>
        <AppIcon name="download" size={14} />
      </button>
      {open ? (
        <div style={{
          position: 'absolute', right: 0, top: '100%', marginTop: 4,
          background: 'var(--surface-bg, #fff)', border: '1px solid var(--border, #ccc)',
          borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 10,
          minWidth: 80, padding: '4px 0',
        }}>
          {(['json', 'txt'] as const).map((format) => (
            <button key={format} type="button" onClick={() => { onExport(format); setOpen(false); }}
              style={{ display: 'block', width: '100%', padding: '6px 12px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 13 }}>
              {format.toUpperCase()}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function PipelineMilestonesGrid({ milestones }: { milestones?: LiveSessionEvents['pipelineMilestones'] }) {
  const safeMilestones = milestones ?? EMPTY_PIPELINE_MILESTONES;
  return (
    <div className="benchmark-section">
      <h4>{i18n.t('diagnostics.liveEvents.pipelineTitle')}</h4>
      <div className="benchmark-metrics-grid">
        <BenchmarkMetric label={i18n.t('diagnostics.liveEvents.preconnect')} value={fmtMs(safeMilestones.preconnectStartedMs)} />
        <BenchmarkMetric label={i18n.t('diagnostics.liveEvents.sessionReady')} value={fmtMs(safeMilestones.sessionReadyMs)} />
        <BenchmarkMetric label={i18n.t('diagnostics.liveEvents.routeStarted')} value={fmtMs(safeMilestones.routeStartedMs)} />
        <BenchmarkMetric label={i18n.t('diagnostics.liveEvents.firstAudioSent')} value={fmtMs(safeMilestones.firstAudioSentMs)} />
        <BenchmarkMetric label={i18n.t('diagnostics.liveEvents.firstSpeechStarted')} value={fmtMs(safeMilestones.firstSpeechStartedMs)} />
        <BenchmarkMetric label={i18n.t('diagnostics.liveEvents.queuedChunks')} value={safeMilestones.queuedAudioChunks ?? 'N/A'} />
        <BenchmarkMetric label={i18n.t('diagnostics.liveEvents.droppedBeforeReady')} value={safeMilestones.droppedBeforeReady ?? 'N/A'} />
        <BenchmarkMetric label={i18n.t('diagnostics.liveEvents.firstAudibleChunk')} value={fmtMs(safeMilestones.firstAudibleChunkMs)} />
        <BenchmarkMetric label={i18n.t('diagnostics.liveEvents.silenceSkipped')} value={safeMilestones.silenceSkippedBeforeAudible ?? 'N/A'} />
        <BenchmarkMetric label={i18n.t('diagnostics.liveEvents.totalInputChunks')} value={safeMilestones.totalInputChunksAtSpeech ?? 'N/A'} />
      </div>
    </div>
  );
}

export function LiveSessionEventDetail({ error = null, events, loading }: { error?: string | null; events: LiveSessionEvents | null; loading: boolean }) {
  if (loading && !events) {
    return <div className="benchmark-empty">{i18n.t('diagnostics.liveEvents.loading')}</div>;
  }

  if (error) {
    return (
      <div className="benchmark-empty benchmark-empty-error" role="alert">
        <strong>{i18n.t('diagnostics.liveEvents.title')} · {i18n.t('diagnostics.status.failed')}</strong>
        <p>{error}</p>
      </div>
    );
  }

  if (!events) {
    return <div className="benchmark-empty">{i18n.t('diagnostics.liveEvents.empty')}</div>;
  }

  const asrDeltas = [...events.asrDeltas].reverse();
  const outputDeltas = [...events.outputDeltas].reverse();
  const hasEvents = asrDeltas.length > 0 || outputDeltas.length > 0;

  if (!hasEvents) {
    return <div className="benchmark-empty">{i18n.t('diagnostics.liveEvents.empty')}</div>;
  }

  return (
    <div className="benchmark-report">
      <PipelineMilestonesGrid milestones={events.pipelineMilestones} />

      {asrDeltas.length > 0 ? (
        <DeltaTableSection
          finalText={events.asrFinal}
          headers={['#', i18n.t('diagnostics.liveEvents.time'), i18n.t('diagnostics.liveEvents.eventType'), i18n.t('diagnostics.liveEvents.stash'), i18n.t('diagnostics.liveEvents.text')]}
          rows={asrDeltas.map((delta, index) => (
            <LiveDeltaRow delta={delta} key={`asr-${index}`} position={events.asrDeltas.length - index} text={delta.text} />
          ))}
          title={`${i18n.t('diagnostics.liveEvents.asrTable')} (${events.asrDeltas.length})`}
        />
      ) : null}

      {outputDeltas.length > 0 ? (
        <DeltaTableSection
          finalText={events.translationFinal}
          headers={['#', i18n.t('diagnostics.liveEvents.time'), i18n.t('diagnostics.liveEvents.eventType'), i18n.t('diagnostics.liveEvents.stash'), i18n.t('diagnostics.liveEvents.committedText')]}
          rows={outputDeltas.map((delta, index) => (
            <LiveDeltaRow delta={delta} key={`out-${index}`} position={events.outputDeltas.length - index} text={delta.committedText} />
          ))}
          title={`${i18n.t('diagnostics.liveEvents.outputTable')} (${events.outputDeltas.length})`}
        />
      ) : null}
    </div>
  );
}
