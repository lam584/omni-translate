import type { WatchSessionReportRuntime } from '../schema/audio-runtime';
import { activeDesktopApi } from './desktop-api';

export async function getWatchSessionReportRuntime(): Promise<WatchSessionReportRuntime | null> {
  return activeDesktopApi().diagnostics.watchSessionReport<WatchSessionReportRuntime | null>();
}

export async function clearWatchSessionReportRuntime(): Promise<void> {
  await activeDesktopApi().diagnostics.clearWatchSessionReport();
}
