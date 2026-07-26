import type { RuntimeNotification } from '../../schema/runtime-core';
import { extractSessionErrorCode, sessionErrorPresentation } from '../../utils/session-error-presentation';

/**
 * Runtime notification sources owned by the realtime session chain. Only
 * these surface as global toasts; bridge/driver/diagnostics sources keep
 * their existing dedicated surfaces.
 */
const SESSION_TOAST_SOURCES = new Set(['session', 'omni', 'audio-engine']);

export const WARNING_AUTO_DISMISS_MS = 5000;
export const MAX_VISIBLE_TOASTS = 4;

export function isSessionToastNotification(notification: RuntimeNotification): boolean {
  return SESSION_TOAST_SOURCES.has(notification.source) && notification.level !== 'info';
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
