import type {
  WatchIssueRuntime,
  WatchSessionReportRuntime,
  WatchTimelineEventRuntime,
} from '../../schema/audio-runtime';
import { writeExportArtifactRuntime, type ExportArtifactReceipt } from '../../runtime/export-artifact-runtime';

const ISSUE_CATEGORY_ORDER: WatchIssueRuntime['category'][] = [
  'model',
  'output',
  'publish',
  'render',
  'content',
  'timing',
  'session',
  'data',
];

export function formatReportMs(value: number | null | undefined): string {
  return value == null ? '—' : `${Math.round(value)} ms`;
}

function eventLabel(event: WatchTimelineEventRuntime): string {
  return `${event.stage} · ${event.kind}`;
}

function issueLabel(issue: WatchIssueRuntime): string {
  const cue = issue.cueId ? ` cue=${issue.cueId}` : '';
  return `[${issue.category}] ${issue.severity}/${issue.code} x${issue.occurrenceCount}${cue}: ${issue.message}`;
}

function timelineEventLine(event: WatchTimelineEventRuntime, indent = ''): string {
  const correlation = [
    `event=${event.eventId}`,
    event.callId ? `call=${event.callId}` : null,
    event.attemptId ? `attempt=${event.attemptId}` : null,
  ].filter(Boolean).join(' ');
  return `${indent}+${event.elapsedMs}ms ${eventLabel(event)} ${correlation} accepted=${event.accepted} final=${event.finalEvent} visible=${event.visible ?? '-'}${event.text ? ` text=${event.text}` : ''}${event.detail ? ` | ${event.detail}` : ''}`;
}

function allReportIssues(report: WatchSessionReportRuntime): WatchIssueRuntime[] {
  return [
    ...report.issues,
    ...report.cues.flatMap((cue) => cue.issues),
  ];
}

function issueGroupCount(report: WatchSessionReportRuntime): number {
  return new Set(allReportIssues(report).map((issue) => `${issue.category}\u0000${issue.code}`)).size;
}

function issueCategoryLines(report: WatchSessionReportRuntime): string[] {
  const totals = new Map<WatchIssueRuntime['category'], { groupKeys: Set<string>; occurrences: number }>();
  allReportIssues(report).forEach((issue) => {
    const current = totals.get(issue.category) ?? { groupKeys: new Set<string>(), occurrences: 0 };
    current.groupKeys.add(issue.code);
    current.occurrences += issue.occurrenceCount;
    totals.set(issue.category, current);
  });
  if (totals.size === 0) {
    return ['Issue categories: none'];
  }
  return [
    'Issue categories:',
    ...ISSUE_CATEGORY_ORDER.flatMap((category) => {
      const total = totals.get(category);
      return total
        ? [`  ${category}: ${total.groupKeys.size} group(s), ${total.occurrences} occurrence(s)`]
        : [];
    }),
  ];
}

export function formatWatchSessionReportJson(report: WatchSessionReportRuntime): string {
  return JSON.stringify(report, null, 2);
}

export function formatWatchSessionReportTxt(report: WatchSessionReportRuntime): string {
  const supersededRevisionCount = report.cues.filter(
    (cue) => cue.comparisonStatus === 'superseded',
  ).length;
  const lines = [
    '=== Watch Session Report ===',
    `Session: ${report.sessionId}`,
    `Status: ${report.status}`,
    `Provider / model: ${report.providerId || '-'} / ${report.model || '-'}`,
    `Started: ${report.startedAt}`,
    `Ended: ${report.endedAt ?? '-'}`,
    `Duration: ${report.summary.durationMs}ms`,
    `Logical cues: ${report.summary.cueCount}`,
    `Cue revisions retained: ${report.cues.length}`,
    `Superseded revisions retained: ${supersededRevisionCount}`,
    `Complete logical cues: ${report.summary.completeCueCount}`,
    `Visible logical cues: ${report.summary.visibleRenderCueCount}`,
    `Published logical cues without visible render: ${report.summary.unrenderedCueCount}`,
    `Issue groups: ${issueGroupCount(report)}`,
    `Issue records retained: ${report.summary.issueCount}`,
    `Issue occurrences: ${report.summary.issueOccurrenceCount}`,
    ...issueCategoryLines(report),
    `Average source -> LLM first: ${formatReportMs(report.summary.averageSourceToLlmFirstMs)}`,
    `Average source -> visible render (end-to-end): ${formatReportMs(report.summary.averageSourceToRenderMs)}`,
    `P95 / max source -> visible render (end-to-end): ${formatReportMs(report.summary.p95SourceToRenderMs)} / ${formatReportMs(report.summary.maxSourceToRenderMs)}`,
    `Average LLM first -> visible render (application pipeline): ${formatReportMs(report.summary.averageLlmFirstToRenderMs)}`,
    `P95 / max LLM first -> visible render (application pipeline): ${formatReportMs(report.summary.p95LlmFirstToRenderMs)} / ${formatReportMs(report.summary.maxLlmFirstToRenderMs)}`,
    `Average LLM final -> visible render: ${formatReportMs(report.summary.averageLlmFinalToRenderMs)}`,
    `P95 / max LLM final -> visible render: ${formatReportMs(report.summary.p95LlmFinalToRenderMs)} / ${formatReportMs(report.summary.maxLlmFinalToRenderMs)}`,
    `Slowest logical cue: ${report.summary.slowestCueId ?? '-'}`,
    `Dropped cues / events: ${report.droppedCueCount} / ${report.droppedEventCount}`,
    '',
  ];
  report.cues.forEach((cue, index) => {
    lines.push(`--- Cue revision ${index + 1}: ${cue.cueId} rev ${cue.revision} [${cue.comparisonStatus}] ---`);
    if (cue.comparisonStatus === 'superseded') {
      lines.push('Disposition: superseded by a later revision; excluded from logical-cue summary metrics');
    }
    lines.push(`Direction / path: ${cue.routeDirection} / ${cue.translationPath || '-'}`);
    lines.push(`Source: ${cue.sourceText || '-'}`);
    lines.push(`LLM: ${cue.llmText || '-'}`);
    lines.push(`Published: ${cue.publishedText || '-'}`);
    lines.push(`Rendered: ${cue.renderedText || '-'}`);
    lines.push(`Source->LLM first: ${formatReportMs(cue.sourceToLlmFirstMs)}; Source->render (end-to-end): ${formatReportMs(cue.sourceToRenderMs)}; LLM first->publish: ${formatReportMs(cue.llmFirstToPublishMs)}; publish->render: ${formatReportMs(cue.publishToRenderMs)}; LLM first->render (application pipeline): ${formatReportMs(cue.llmFirstToRenderMs)}`);
    lines.push(`LLM final->publish: ${formatReportMs(cue.llmFinalToPublishMs)}; final publish->render: ${formatReportMs(cue.publishedFinalToRenderMs)}; LLM final->render: ${formatReportMs(cue.llmFinalToRenderMs)}`);
    cue.issues.forEach((issue) => lines.push(`Issue ${issueLabel(issue)}`));
    cue.events.forEach((event) => lines.push(timelineEventLine(event, '  ')));
    if (cue.droppedEventCount > 0) {
      lines.push(`Dropped cue events: ${cue.droppedEventCount}`);
    }
    lines.push('');
  });
  if (report.events.length > 0) {
    lines.push(`--- Session timeline events (${report.events.length}) ---`);
    report.events.forEach((event) => lines.push(timelineEventLine(event)));
    lines.push('');
  }
  report.issues.forEach((issue) => lines.push(`Session issue ${issueLabel(issue)}`));
  return lines.join('\n');
}

export async function exportWatchSessionReport(
  report: WatchSessionReportRuntime,
  format: 'json' | 'txt',
): Promise<ExportArtifactReceipt> {
  const safeModel = (report.model || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `watch-session-report-${safeModel}-${timestamp}.${format}`;
  const content = format === 'json'
    ? formatWatchSessionReportJson(report)
    : formatWatchSessionReportTxt(report);
  return writeExportArtifactRuntime(
    filename,
    content,
    format === 'json' ? 'application/json' : 'text/plain',
  );
}
