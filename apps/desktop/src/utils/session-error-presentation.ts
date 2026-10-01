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
  /** Preserve the native reason when a shared code does not identify a model role. */
  useRawMessage?: boolean;
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
    useRawMessage: true,
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

/** Only established native reasons prove a session identity/handoff conflict. */
function isSessionIdentityConflict(code: string | null, detail: string): boolean {
  return code === 'model_protocol.authorization_identity_mismatch'
    && /(?:^|:\s*)Watch report (?:protocol identity changed during one session|protocol identity changed while another route still owns the session|previous provider owner could not be retired)(?:$|\s*\|)/u.test(detail);
}

/** Resolve preflight service errors using the existing session and authority domains. */
export function sessionLaunchErrorCode(error: unknown, detail: string): SessionErrorCode {
  const parsed = parseModelContext(error, detail);
  if (isSessionIdentityConflict(parsed.modelProtocolCode, parsed.cleanedDetail)) {
    return 'session.launch-precheck-failed';
  }
  const tagged = extractSessionErrorCode(detail);
  if (tagged) return tagged;
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : null;
  if (typeof code === 'string' && isSessionErrorCode(code)) return code;
  // The authorization boundary reports these established error domains as either
  // ServiceError.code or a plain Error message. Do not infer a wire protocol.
  if ((typeof code === 'string' && (code.startsWith('model_protocol.') || code.startsWith('provider_manifest.')))
    || /\b(?:model_protocol|provider_manifest)\.[a-z_]+\b/u.test(detail)) return 'session.model-reference-invalid';
  return 'session.launch-precheck-failed';
}

export type ModelRoleKind = "primary-audio" | "primary-text" | "secondary-subtitle" | "speech-output";

export type ParsedModelContext = {
  modelRole?: ModelRoleKind;
  modelId?: string;
  providerId?: string;
  modelReference?: string;
  direction?: string;
  [key: string]: unknown;
};

/**
 * Extracts structured modelContext and detail markers from error strings or ServiceError details.
 */
export function parseModelContext(error: unknown, detail?: string): {
  context: ParsedModelContext | null;
  modelProtocolCode: string | null;
  cleanedDetail: string;
} {
  let context: ParsedModelContext | null = null;
  let modelProtocolCode: string | null = null;

  if (error && typeof error === "object") {
    const errObj = error as { code?: unknown; details?: unknown; message?: unknown };
    if (typeof errObj.code === "string" && (errObj.code.startsWith("model_protocol.") || errObj.code.startsWith("provider_manifest."))) {
      modelProtocolCode = errObj.code;
    }
    if (errObj.details && typeof errObj.details === "object") {
      const d = errObj.details as Record<string, unknown>;
      if (d.modelRole || d.modelId || d.providerId || d.modelReference) {
        context = {
          modelRole: d.modelRole as ModelRoleKind | undefined,
          modelId: typeof d.modelId === "string" ? d.modelId : undefined,
          providerId: typeof d.providerId === "string" ? d.providerId : undefined,
          modelReference: typeof d.modelReference === "string" ? d.modelReference : undefined,
          direction: typeof d.direction === "string" ? d.direction : undefined,
          ...d,
        };
      }
    }
  }

  const objectMessage = error && typeof error === "object" && "message" in error
    && typeof error.message === "string" ? error.message : "";
  const text = detail || (typeof error === "string" ? error : objectMessage);

  if (!modelProtocolCode) {
    const codeMatch = text.match(/\b(model_protocol\.[a-z0-9_]+|provider_manifest\.[a-z0-9_]+)\b/);
    if (codeMatch) {
      modelProtocolCode = codeMatch[1];
    }
  }

  const contextMarker = " | modelContext: ";
  let cleanedDetail = text;
  const contextIndex = text.indexOf(contextMarker);
  if (contextIndex >= 0) {
    const afterContext = text.slice(contextIndex + contextMarker.length);
    const endContextIndex = afterContext.indexOf(" | code:");
    const jsonStr = endContextIndex >= 0 ? afterContext.slice(0, endContextIndex).trim() : afterContext.trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed && typeof parsed === "object") {
        context = { ...context, ...parsed };
      }
    } catch {
      // ignore json parse error
    }
    cleanedDetail = text.slice(0, contextIndex) + (endContextIndex >= 0 ? afterContext.slice(endContextIndex) : "");
  }

  if (!context?.modelRole) {
    if (text.includes("primary-audio") || text.includes("主音频模型") || text.includes("Primary audio model") || text.includes("inboundVoiceModelId") || text.includes("outboundVoiceModelId") || text.includes("Conversation output model") || text.includes("对话输出模型")) {
      context = { ...context, modelRole: "primary-audio" };
    } else if (text.includes("primary-text") || text.includes("主文本模型") || text.includes("Primary text model")) {
      context = { ...context, modelRole: "primary-text" };
    } else if (text.includes("secondary-subtitle") || text.includes("二次字幕模型") || text.includes("secondary subtitle") || text.includes("subtitleTranslationModelId")) {
      context = { ...context, modelRole: "secondary-subtitle" };
    } else if (text.includes("speech-output") || text.includes("语音播报模型")) {
      context = { ...context, modelRole: "speech-output" };
    }
  }

  return { context, modelProtocolCode, cleanedDetail };
}

/**
 * Explains model_protocol.* or provider_manifest.* failures in a localized, user-friendly manner.
 */
export function explainModelProtocolError(
  code: string | null,
  t: (key: string) => string,
  detail = "",
): { reasonKey: string; reasonText: string } | null {
  if (!code) return null;

  if (isSessionIdentityConflict(code, detail)) {
    return {
      reasonKey: "session.modelReason.session-identity-conflict",
      reasonText: t("session.modelReason.session-identity-conflict"),
    };
  }

  if (
    code.includes("endpoint_host_region_mismatch") ||
    code.includes("endpoint_host_required") ||
    code.includes("region_not_supported") ||
    code.includes("endpoint_family_mismatch")
  ) {
    return {
      reasonKey: "session.modelReason.endpoint-invalid",
      reasonText: t("session.modelReason.endpoint-invalid"),
    };
  }

  if (
    code.includes("adapter_unavailable") ||
    code.includes("profile_unimplemented") ||
    code.includes("wire_dialect_mismatch") ||
    code.includes("transport_mismatch") ||
    code.includes("operation_not_supported") ||
    code.includes("frame_kind_mismatch") ||
    code.includes("codec_not_supported") ||
    code.includes("sample_rate_not_supported") ||
    code.includes("channels_not_supported")
  ) {
    return {
      reasonKey: "session.modelReason.adapter-unavailable",
      reasonText: t("session.modelReason.adapter-unavailable"),
    };
  }

  if (
    code.includes("not_registered") ||
    code.includes("profile_id_mismatch") ||
    code.includes("dialect_not_registered") ||
    code.includes("registry_version_mismatch") ||
    code.includes("profile_ambiguous") ||
    code.includes("profile_version_mismatch")
  ) {
    return {
      reasonKey: "session.modelReason.missing-protocol",
      reasonText: t("session.modelReason.missing-protocol"),
    };
  }

  if (code.includes("authorization_identity_mismatch") || code.includes("provider_owner_mismatch")) {
    return {
      reasonKey: "session.modelReason.authorization-identity-mismatch",
      reasonText: t("session.modelReason.authorization-identity-mismatch"),
    };
  }

  if (code.includes("not_authorized")) {
    return { reasonKey: "session.modelReason.reference-invalid", reasonText: t("session.modelReason.reference-invalid") };
  }

  if (code.includes("provider_disabled")) {
    return {
      reasonKey: "session.modelReason.provider-disabled",
      reasonText: t("session.modelReason.provider-disabled"),
    };
  }

  return null;
}

/**
 * Formats a uniform, human-readable model error summary for session screens and toast notifications.
 * Never outputs raw JSON to the user.
 */
export function formatModelErrorSummary(
  error: unknown,
  detail: string,
  t: (key: string) => string,
): string {
  const { context, modelProtocolCode, cleanedDetail } = parseModelContext(error, detail);
  const role = context?.modelRole;
  const roleName = role ? t("session.modelRole." + role) : null;
  const explanation = explainModelProtocolError(modelProtocolCode, t, cleanedDetail);
  if (explanation?.reasonKey === "session.modelReason.session-identity-conflict") {
    return explanation.reasonText;
  }

  const modelIdentifier = context?.modelId || context?.modelReference;
  const modelPart = modelIdentifier ? " (" + modelIdentifier + ")" : "";

  if (roleName && explanation) {
    return roleName + modelPart + ": " + explanation.reasonText;
  }
  if (explanation) {
    return explanation.reasonText;
  }
  // Unknown reasons must not assert a disabled provider or an invalid model.
  // Keep only the parsed diagnostic code in the summary; raw detail (including
  // modelContext) remains available to callers for their technical-detail view.
  const diagnostic = modelProtocolCode ? " [" + modelProtocolCode + "]" : "";
  const fallback = t("session.modelReason.unknown") + diagnostic;
  return roleName ? roleName + modelPart + ": " + fallback : fallback;
}
