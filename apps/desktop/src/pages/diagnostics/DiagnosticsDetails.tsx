import { type ReactNode, useState } from 'react';
import AppIcon from '../../components/icons/AppIcon';
import i18n from '../../i18n/config';
import type { BenchmarkProgressEvent, BenchmarkReport } from '../../runtime/benchmark-runtime';
import type { LiveSessionEvents } from '../../runtime/live-session-events-runtime';
import { writeExportArtifactRuntime, type ExportArtifactReceipt } from '../../runtime/export-artifact-runtime';

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

export function BenchmarkReportDetail({ report }: { report: BenchmarkReport }) {
  const run = report.runs[0];
  if (!run) {
    return <div className="benchmark-empty">{i18n.t('diagnostics.benchmark.waitingFirstData')}</div>;
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
  static exportBenchmark(report: BenchmarkReport, basename: string, format: 'json' | 'txt') {
    if (format === 'json') {
      return exportJson(report, `${basename}.json`);
    }
    return exportFile(formatBenchmarkTxt(report), `${basename}.txt`, 'text/plain');
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

export function formatBenchmarkTxt(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`=== Benchmark Report ===`);
  lines.push(`Model: ${report.model}`);
  lines.push(`Audio File: ${report.audioFile}`);
  lines.push(`Audio Duration: ${report.audioDurationSecs.toFixed(1)}s`);
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
