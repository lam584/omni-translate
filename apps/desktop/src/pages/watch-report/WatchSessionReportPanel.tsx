import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  WatchCueComparisonRuntime,
  WatchSessionReportRuntime,
  WatchTimelineEventRuntime,
} from '../../schema/audio-runtime';
import type { ExportArtifactReceipt } from '../../runtime/export-artifact-runtime';
import { openExportDirectoryRuntime } from '../../runtime/diagnostics-runtime';
import { exportWatchSessionReport, formatReportMs } from './watchSessionReportFormat';
import {
  groupWatchReportIssues,
  ISSUE_CATEGORY_ORDER,
  type IssueCategory,
} from './watchReportIssues';

type CueFilter = 'all' | 'issues' | 'different';
type CueSort = 'sequence' | 'issues' | 'latency';
type IssueCategoryFilter = 'all' | IssueCategory;

type Props = {
  report: WatchSessionReportRuntime | null;
  loading?: boolean;
  error?: string | null;
  onClear?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  onExported?: (receipt: ExportArtifactReceipt) => void;
  lastExportReceipt?: ExportArtifactReceipt | null;
};

function cueStatusKey(status: WatchCueComparisonRuntime['comparisonStatus']): string {
  switch (status) {
    case 'exact': return 'watchReport.status.exact';
    case 'formatting-only': return 'watchReport.status.formattingOnly';
    case 'different': return 'watchReport.status.different';
    case 'not-published': return 'watchReport.status.notPublished';
    case 'not-rendered': return 'watchReport.status.notRendered';
    case 'model-error': return 'watchReport.status.modelError';
    case 'superseded': return 'watchReport.status.superseded';
    default: return 'watchReport.status.pending';
  }
}

function statusTone(status: WatchCueComparisonRuntime['comparisonStatus']): string {
  if (status === 'exact') return 'ready';
  if (status === 'formatting-only' || status === 'pending' || status === 'superseded') return 'pending';
  return 'warning';
}

function issueCategoryKey(category: IssueCategory): string {
  return `watchReport.issueCategories.${category}`;
}

function eventLabel(event: WatchTimelineEventRuntime): string {
  return `${event.stage} · ${event.kind}`;
}

function TimelineDetails({
  className = '',
  events,
  summary,
}: {
  className?: string;
  events: WatchTimelineEventRuntime[];
  summary: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className={`watch-report-events ${className}`.trim()}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      {expanded ? <div className="watch-report-event-list">
        {events.map((event) => (
          <div key={event.eventId} className={`watch-report-event watch-report-event-${event.stage}`}>
            <time>+{event.elapsedMs} ms</time>
            <strong>{eventLabel(event)}</strong>
            <span>{event.accepted ? t('watchReport.accepted') : t('watchReport.rejected')}</span>
            {event.visible != null ? <span>{event.visible ? t('watchReport.visible') : t('watchReport.hidden')}</span> : null}
            {event.callId ? <span>call={event.callId}</span> : null}
            {event.attemptId ? <span>attempt={event.attemptId}</span> : null}
            {event.text ? <pre>{event.text}</pre> : null}
            {event.detail ? <p>{event.detail}</p> : null}
          </div>
        ))}
      </div> : null}
    </details>
  );
}

function cueLatency(cue: WatchCueComparisonRuntime): number {
  return cue.sourceToRenderMs ?? -1;
}

function sortedCues(
  cues: WatchCueComparisonRuntime[],
  filter: CueFilter,
  sort: CueSort,
  category: IssueCategoryFilter,
): WatchCueComparisonRuntime[] {
  const filtered = cues.filter((cue) => {
    if (category !== 'all' && !cue.issues.some((issue) => issue.category === category)) {
      return false;
    }
    if (filter === 'issues') {
      return cue.issues.length > 0
        || !['exact', 'formatting-only', 'pending', 'superseded'].includes(cue.comparisonStatus);
    }
    if (filter === 'different') {
      return cue.comparisonStatus === 'different'
        || cue.comparisonStatus === 'formatting-only';
    }
    return true;
  });
  return filtered.sort((left, right) => {
    if (sort === 'issues') {
      const leftCount = left.issues.reduce((total, issue) => total + issue.occurrenceCount, 0);
      const rightCount = right.issues.reduce((total, issue) => total + issue.occurrenceCount, 0);
      return rightCount - leftCount || cueLatency(right) - cueLatency(left);
    }
    if (sort === 'latency') {
      return cueLatency(right) - cueLatency(left);
    }
    return left.sourceAtMs === right.sourceAtMs
      ? left.revision - right.revision
      : (left.sourceAtMs ?? 0) - (right.sourceAtMs ?? 0);
  });
}

function CueComparison({ cue }: { cue: WatchCueComparisonRuntime }) {
  const { t } = useTranslation();
  return (
    <article className={`watch-report-cue watch-report-cue-${statusTone(cue.comparisonStatus)}`}>
      <div className="watch-report-cue-head">
        <div>
          <strong>{cue.cueId}</strong>
          <span>{t('watchReport.revision', { revision: cue.revision })} · {cue.translationPath || t('watchReport.unknownPath')}</span>
        </div>
        <span className={`watch-report-status watch-report-status-${statusTone(cue.comparisonStatus)}`}>
          {t(cueStatusKey(cue.comparisonStatus))}
        </span>
      </div>

      {cue.sourceText ? <p className="watch-report-source"><span>{t('watchReport.labels.source')}</span>{cue.sourceText}</p> : null}
      <div className="watch-report-comparison-grid">
        <div>
          <span>{t('watchReport.labels.llm')}</span>
          <pre>{cue.llmText || '—'}</pre>
        </div>
        <div>
          <span>{t('watchReport.labels.published')}</span>
          <pre>{cue.publishedText || '—'}</pre>
        </div>
        <div>
          <span>{t('watchReport.labels.rendered')}</span>
          <pre>{cue.renderedText || '—'}</pre>
        </div>
      </div>

      <div className="watch-report-timing-grid">
        <span>{t('watchReport.timing.sourceToLlm')} <strong>{formatReportMs(cue.sourceToLlmFirstMs)}</strong></span>
        <span>{t('watchReport.timing.sourceToRender')} <strong>{formatReportMs(cue.sourceToRenderMs)}</strong></span>
        <span>{t('watchReport.timing.llmToPublish')} <strong>{formatReportMs(cue.llmFirstToPublishMs)}</strong></span>
        <span>{t('watchReport.timing.publishToRender')} <strong>{formatReportMs(cue.publishToRenderMs)}</strong></span>
        <span>{t('watchReport.timing.llmToRender')} <strong>{formatReportMs(cue.llmFirstToRenderMs)}</strong></span>
        <span>{t('watchReport.timing.finalToPublish')} <strong>{formatReportMs(cue.llmFinalToPublishMs)}</strong></span>
        <span>{t('watchReport.timing.finalPublishToRender')} <strong>{formatReportMs(cue.publishedFinalToRenderMs)}</strong></span>
      </div>

      {cue.issues.length ? (
        <div className="watch-report-issues">
          {cue.issues.map((issue, index) => (
            <div className={`watch-report-issue watch-report-issue-${issue.severity}`} key={`${issue.code}-${index}`}>
              <div>
                <span>{t(issueCategoryKey(issue.category))}</span>
                <strong>{issue.code}</strong>
                <small>{t('watchReport.issueOccurrences', { count: issue.occurrenceCount })}</small>
              </div>
              <p>{issue.message}</p>
            </div>
          ))}
        </div>
      ) : null}

      <TimelineDetails
        events={cue.events}
        summary={t('watchReport.technicalDetails', { count: cue.events.length })}
      />
    </article>
  );
}

export default function WatchSessionReportPanel({
  report,
  loading = false,
  error = null,
  onClear,
  onRefresh,
  onExported,
  lastExportReceipt = null,
}: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<CueFilter>('issues');
  const [sort, setSort] = useState<CueSort>('issues');
  const [categoryFilter, setCategoryFilter] = useState<IssueCategoryFilter>('all');
  const [actionError, setActionError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [localExport, setLocalExport] = useState<{
    sessionId: string;
    receipt: ExportArtifactReceipt;
  } | null>(null);
  const [exportPathCopied, setExportPathCopied] = useState(false);
  const handleUnexpectedActionError = (actionError: unknown) => {
    setActionError(actionError instanceof Error ? actionError.message : String(actionError));
    setExporting(false);
  };
  const cues = useMemo(
    () => report ? sortedCues([...report.cues], filter, sort, categoryFilter) : [],
    [categoryFilter, filter, report, sort],
  );
  const issueGroups = useMemo(() => report ? groupWatchReportIssues(report) : [], [report]);
  const issueCategories = useMemo(() => ISSUE_CATEGORY_ORDER
    .map((category) => ({
      category,
      groups: issueGroups.filter((issue) => issue.category === category),
    }))
    .filter((entry) => entry.groups.length > 0), [issueGroups]);

  const runExport = async (format: 'json' | 'txt') => {
    if (!report) return;
    const confirmed = window.confirm(t('watchReport.exportWarning'));
    if (!confirmed) return;
    setExporting(true);
    setActionError(null);
    setExportPathCopied(false);
    try {
      const receipt = await exportWatchSessionReport(report, format);
      setLocalExport({ sessionId: report.sessionId, receipt });
      onExported?.(receipt);
    } catch (exportError) {
      setActionError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(false);
    }
  };

  const exportReceipt = lastExportReceipt
    ?? (localExport && report && localExport.sessionId === report.sessionId ? localExport.receipt : null);

  const copyExportPath = async () => {
    if (!exportReceipt) return;
    setActionError(null);
    try {
      await navigator.clipboard.writeText(exportReceipt.outputPath);
      setExportPathCopied(true);
    } catch (copyError) {
      setActionError(`${t('diagnostics.status.failed')}：${copyError instanceof Error ? copyError.message : String(copyError)}`);
    }
  };

  const openExportFolder = async () => {
    if (!exportReceipt) return;
    setActionError(null);
    try {
      await openExportDirectoryRuntime(exportReceipt.outputPath);
    } catch (openError) {
      setActionError(`${t('diagnostics.status.failed')}：${openError instanceof Error ? openError.message : String(openError)}`);
    }
  };

  if (loading && !report) return <div className="watch-report-empty">{t('watchReport.loading')}</div>;
  if (error) return <div className="watch-report-empty watch-report-error" role="alert">{error}</div>;
  if (!report) return <div className="watch-report-empty">{t('watchReport.empty')}</div>;

  const summary = report.summary;
  return (
    <section className="watch-report" data-session-id={report.sessionId}>
      <div className="watch-report-head">
        <div>
          <span>{t('watchReport.currentTitle')} · {report.status === 'completed' ? t('watchReport.completed') : t('watchReport.active')}</span>
          <h3>{report.model || t('watchReport.modelFallback')}</h3>
          <p>{t('watchReport.meta', {
            provider: report.providerId || '—',
            seconds: (summary.durationMs / 1000).toFixed(1),
            count: summary.cueCount,
          })}</p>
        </div>
        <div className="watch-report-actions">
          {onRefresh ? <button onClick={() => void Promise.resolve().then(onRefresh).catch(handleUnexpectedActionError)} type="button">{t('watchReport.refresh')}</button> : null}
          <button disabled={exporting} onClick={() => void runExport('json').catch(handleUnexpectedActionError)} type="button">JSON</button>
          <button disabled={exporting} onClick={() => void runExport('txt').catch(handleUnexpectedActionError)} type="button">TXT</button>
          {onClear ? <button className="watch-report-clear" onClick={() => void Promise.resolve().then(onClear).catch(handleUnexpectedActionError)} type="button">{t('watchReport.clear')}</button> : null}
        </div>
      </div>

      {actionError ? <p className="watch-report-action-error" role="alert">{actionError}</p> : null}
      {exportReceipt ? (
        <div className="watch-report-export-result" role="status">
          <strong>{t('watchReport.exportLocation')}</strong>
          <label>
            <span>{t('watchReport.exportPath')}</span>
            <input
              aria-label={t('watchReport.exportPath')}
              className="watch-report-export-path"
              onClick={(event) => event.currentTarget.select()}
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={exportReceipt.outputPath}
            />
          </label>
          <div className="watch-report-export-result-actions">
            <button onClick={() => void copyExportPath().catch(handleUnexpectedActionError)} type="button">
              {exportPathCopied ? t('watchReport.pathCopied') : t('watchReport.copyPath')}
            </button>
            <button onClick={() => void openExportFolder().catch(handleUnexpectedActionError)} type="button">
              {t('diagnostics.actions.openExportDirectory')}
            </button>
          </div>
        </div>
      ) : null}
      <div className="watch-report-summary">
        <div><span>{t('watchReport.metrics.firstToken')}</span><strong>{formatReportMs(summary.averageSourceToLlmFirstMs)}</strong></div>
        <div><span>{t('watchReport.metrics.endToEnd')}</span><strong>{formatReportMs(summary.averageSourceToRenderMs)}</strong></div>
        <div><span>{t('watchReport.metrics.p95Max')}</span><strong>{formatReportMs(summary.p95SourceToRenderMs)} / {formatReportMs(summary.maxSourceToRenderMs)}</strong></div>
        <div><span>{t('watchReport.metrics.llmToRender')}</span><strong>{formatReportMs(summary.averageLlmFirstToRenderMs)}</strong></div>
        <div><span>{t('watchReport.metrics.complete')}</span><strong>{summary.completeCueCount} / {summary.cueCount}</strong></div>
        <div><span>{t('watchReport.metrics.notRendered')}</span><strong>{summary.unrenderedCueCount}</strong></div>
        <div><span>{t('watchReport.metrics.issues')}</span><strong>{issueGroups.length} / {summary.issueOccurrenceCount}</strong></div>
      </div>

      {issueCategories.length ? (
        <section className="watch-report-issue-overview">
          <div className="watch-report-issue-overview-head">
            <h4>{t('watchReport.issueOverview')}</h4>
            <span>{t('watchReport.issueSummary', {
              groups: issueGroups.length,
              occurrences: summary.issueOccurrenceCount,
            })}</span>
          </div>
          <div className="watch-report-issue-categories">
            {issueCategories.map(({ category, groups }) => {
              const occurrences = groups.reduce((total, issue) => total + issue.occurrenceCount, 0);
              return (
                <details className="watch-report-issue-category" key={category} open={groups.some((issue) => issue.severity === 'error')}>
                  <summary>
                    <strong>{t(issueCategoryKey(category))}</strong>
                    <span>{t('watchReport.issueCategorySummary', { groups: groups.length, occurrences })}</span>
                  </summary>
                  <div>
                    {groups.map((issue) => (
                      <article className={`watch-report-issue-group watch-report-issue-${issue.severity}`} key={issue.code}>
                        <header>
                          <strong>{issue.code}</strong>
                          <span>{t('watchReport.issueOccurrences', { count: issue.occurrenceCount })}</span>
                          {issue.cueIds.length ? <span>{t('watchReport.affectedCues', { count: issue.cueIds.length })}</span> : null}
                        </header>
                        <p>{issue.message}</p>
                      </article>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      ) : null}

      {report.events.length ? (
        <TimelineDetails
          className="watch-report-session-events"
          events={report.events}
          summary={t('watchReport.sessionTechnicalDetails', { count: report.events.length })}
        />
      ) : null}

      <div className="watch-report-controls">
        <label>{t('watchReport.controls.display')}
          <select onChange={(event) => setFilter(event.target.value as CueFilter)} value={filter}>
            <option value="issues">{t('watchReport.controls.issueFirst')}</option>
            <option value="different">{t('watchReport.controls.differences')}</option>
            <option value="all">{t('watchReport.controls.all')}</option>
          </select>
        </label>
        <label>{t('watchReport.controls.sort')}
          <select onChange={(event) => setSort(event.target.value as CueSort)} value={sort}>
            <option value="issues">{t('watchReport.controls.issueCount')}</option>
            <option value="latency">{t('watchReport.controls.latency')}</option>
            <option value="sequence">{t('watchReport.controls.sequence')}</option>
          </select>
        </label>
        <label>{t('watchReport.controls.category')}
          <select onChange={(event) => setCategoryFilter(event.target.value as IssueCategoryFilter)} value={categoryFilter}>
            <option value="all">{t('watchReport.issueCategories.all')}</option>
            {ISSUE_CATEGORY_ORDER.map((category) => (
              <option key={category} value={category}>{t(issueCategoryKey(category))}</option>
            ))}
          </select>
        </label>
      </div>

      {cues.length
        ? <div className="watch-report-cues">{cues.map((cue) => <CueComparison cue={cue} key={`${cue.cueId}-${cue.revision}`} />)}</div>
        : <div className="watch-report-empty">{t('watchReport.controls.noCues')}</div>}
    </section>
  );
}
