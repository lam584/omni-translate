import type { WatchIssueRuntime, WatchSessionReportRuntime } from '../../schema/audio-runtime';

export type IssueCategory = WatchIssueRuntime['category'];

export type IssueGroup = {
  category: IssueCategory;
  code: string;
  severity: WatchIssueRuntime['severity'];
  message: string;
  occurrenceCount: number;
  cueIds: string[];
};

export const ISSUE_CATEGORY_ORDER: IssueCategory[] = [
  'model', 'output', 'publish', 'render', 'content', 'timing', 'session', 'data',
];

export function groupWatchReportIssues(report: WatchSessionReportRuntime): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  const issues = [
    ...report.issues,
    ...report.cues.flatMap((cue) => cue.issues),
  ];
  issues.forEach((issue) => {
    const key = `${issue.category}\u0000${issue.code}`;
    const existing = groups.get(key);
    if (existing) {
      existing.occurrenceCount += Math.max(1, issue.occurrenceCount);
      if (issue.severity === 'error') existing.severity = 'error';
      if (issue.message) existing.message = issue.message;
      if (issue.cueId && !existing.cueIds.includes(issue.cueId)) existing.cueIds.push(issue.cueId);
      return;
    }
    groups.set(key, {
      category: issue.category,
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      occurrenceCount: Math.max(1, issue.occurrenceCount),
      cueIds: issue.cueId ? [issue.cueId] : [],
    });
  });
  return Array.from(groups.values()).sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === 'error' ? -1 : 1;
    const categoryOrder = ISSUE_CATEGORY_ORDER.indexOf(left.category)
      - ISSUE_CATEGORY_ORDER.indexOf(right.category);
    if (categoryOrder !== 0) return categoryOrder;
    return right.occurrenceCount - left.occurrenceCount;
  });
}
