import type { RuntimeNotification } from '../../schema/runtime-core';
import { extractSessionErrorCode, sessionErrorPresentation } from '../../utils/session-error-presentation';

/**
 * Warning sources that require cross-page visibility. Every error is a toast
 * regardless of source, so writing an error notification can never leave it
 * without a rendering outlet. Info stays page-local; warnings are global only
 * for session/startup chains, while dedicated pages retain their banners.
 */
const SESSION_TOAST_SOURCES = new Set(['session', 'omni', 'audio-engine', 'desktop-runtime']);

export const WARNING_AUTO_DISMISS_MS = 5000;
export const MAX_VISIBLE_TOASTS = 4;

export type UnifiedErrorPresentation = {
  code: string;
  title: string;
  summary: string;
  technicalDetail: string | null;
  recoveryActions: string[];
  source: string;
};

export function isSessionToastNotification(notification: RuntimeNotification): boolean {
  return notification.level === 'error'
    || (notification.level === 'warning' && SESSION_TOAST_SOURCES.has(notification.source));
}

/**
 * Localized toast text: session error codes embedded in the message resolve
 * through the presentation table (code appended for support reports); the
 * raw Rust message stays the fallback for untagged notifications.
 */
export function toastDisplayText(message: string, t: (key: string) => string): string {
  const code = extractSessionErrorCode(message);
  const presentation = sessionErrorPresentation(code);
  return presentation ? `${t(presentation.messageKey)} [${code}]` : message;
}

/** Normalizes native and local notifications into the single UI error shape. */
export function runtimeErrorPresentation(
  notification: RuntimeNotification,
  t: (key: string) => string,
): UnifiedErrorPresentation {
  const code = extractSessionErrorCode(notification.message);
  const presentation = sessionErrorPresentation(code);
  return {
    code: code ?? notification.id,
    title: notification.source,
    summary: presentation ? `${t(presentation.messageKey)} [${code}]` : notification.message,
    technicalDetail: code ? notification.message.split(' | code: ')[0] ?? null : null,
    recoveryActions: presentation ? [presentation.action] : [],
    source: notification.source,
  };
}
