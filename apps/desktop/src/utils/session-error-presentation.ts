import type { SessionErrorCode } from '../schema/audio-runtime';

/**
 * Marker embedded in worker error strings by the Rust session error
 * classifier (`session_errors.rs`). Launch failures surface the raw tagged
 * string to the frontend, so the code must be recoverable here too.
 */
export const SESSION_ERROR_CODE_MARKER = ' | code: ';

export type SessionErrorAction = 'open-providers' | 'restart-session' | 'check-audio-device';

export type SessionErrorPresentation = {
  /** i18n key for the user-facing message; raw Rust text stays a fallback. */
  messageKey: string;
  action: SessionErrorAction;
  /** i18n key for the action link/button label, when the action needs one. */
  actionKey: string | null;
};

const SESSION_ERROR_PRESENTATIONS: Record<SessionErrorCode, SessionErrorPresentation> = {
  'session.credential-invalid': {
    messageKey: 'session.errorCode.credentialInvalid',
    action: 'open-providers',
    actionKey: 'session.errorAction.openProviders',
  },
  'session.quota-exceeded': {
    messageKey: 'session.errorCode.quotaExceeded',
    action: 'open-providers',
    actionKey: 'session.errorAction.openProviders',
  },
  'session.voice-unsupported': {
    messageKey: 'session.errorCode.voiceUnsupported',
    action: 'open-providers',
    actionKey: 'session.errorAction.openProviders',
  },
  'session.model-reference-invalid': {
    messageKey: 'session.errorCode.modelReferenceInvalid',
    action: 'open-providers',
    actionKey: 'session.errorAction.openProviders',
  },
  'session.launch-precheck-failed': {
    messageKey: 'session.errorCode.providerInternal',
    action: 'restart-session',
    actionKey: null,
  },
  'session.launch-stage-failed': {
    messageKey: 'session.errorCode.providerInternal',
    action: 'restart-session',
    actionKey: null,
  },
  'session.launch-timeout': {
    messageKey: 'session.errorCode.networkUnreachable',
    action: 'restart-session',
    actionKey: null,
  },
  'session.network-unreachable': {
    messageKey: 'session.errorCode.networkUnreachable',
    action: 'restart-session',
    actionKey: null,
  },
  'session.provider-internal': {
    messageKey: 'session.errorCode.providerInternal',
    action: 'restart-session',
    actionKey: null,
  },
  'audio.device-lost': {
    messageKey: 'session.errorCode.audioDeviceLost',
    action: 'check-audio-device',
    actionKey: null,
  },
  'audio.capture-failed': {
    messageKey: 'session.errorCode.audioCaptureFailed',
    action: 'check-audio-device',
    actionKey: null,
  },
  'audio.flow-stalled': {
    messageKey: 'session.errorCode.audioFlowStalled',
    action: 'check-audio-device',
    actionKey: null,
  },
};

export function isSessionErrorCode(value: string): value is SessionErrorCode {
  return Object.prototype.hasOwnProperty.call(SESSION_ERROR_PRESENTATIONS, value);
}

export function sessionErrorPresentation(code: string | null | undefined): SessionErrorPresentation | null {
  if (!code || !isSessionErrorCode(code)) {
    return null;
  }
  return SESSION_ERROR_PRESENTATIONS[code];
}

/**
 * Recovers a session error code from a raw worker error string carrying the
 * `| code:` / `| recommended:` markers. Returns null for legacy strings and
 * codes from other domains.
 */
export function extractSessionErrorCode(message: string): SessionErrorCode | null {
  const markerIndex = message.lastIndexOf(SESSION_ERROR_CODE_MARKER);
  if (markerIndex < 0) {
    return null;
  }
  const tail = message.slice(markerIndex + SESSION_ERROR_CODE_MARKER.length);
  const code = tail.split(' | ')[0]?.trim() ?? '';
  return isSessionErrorCode(code) ? code : null;
}
