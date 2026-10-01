import { describe, expect, it } from 'vitest';
import {
  extractSessionErrorCode,
  isSessionErrorCode,
  sessionErrorPresentation,
  sessionLaunchErrorCode,
} from './session-error-presentation';
import type { SessionErrorCode } from '../schema/audio-runtime';

const ALL_CODES: SessionErrorCode[] = [
  'session.credential-invalid',
  'session.quota-exceeded',
  'session.voice-unsupported',
  'session.model-reference-invalid',
  'session.launch-precheck-failed',
  'session.launch-stage-failed',
  'session.launch-timeout',
  'session.network-unreachable',
  'session.provider-internal',
  'audio.device-lost',
  'audio.capture-failed',
  'audio.flow-stalled',
];

describe('sessionErrorPresentation', () => {
  it('maps every session error code to a message key and action', () => {
    for (const code of ALL_CODES) {
      const presentation = sessionErrorPresentation(code);
      expect(presentation, code).not.toBeNull();
      expect(presentation!.messageKey.startsWith('session.errorCode.'), code).toBe(true);
      if (presentation!.action === 'open-providers') {
        expect(presentation!.actionKey, code).toBe('session.errorAction.openProviders');
      }
    }
  });

  it('routes credential and quota errors to the providers workspace', () => {
    expect(sessionErrorPresentation('session.credential-invalid')?.action).toBe('open-providers');
    expect(sessionErrorPresentation('session.quota-exceeded')?.action).toBe('open-providers');
  });

  it('does not infer a secondary model role from the shared model-reference code', () => {
    expect(sessionErrorPresentation('session.model-reference-invalid')).toMatchObject({
      action: 'open-providers', useRawMessage: true,
    });
  });

  it('returns null for unknown codes and empty values', () => {
    expect(sessionErrorPresentation('driver.install-failed')).toBeNull();
    expect(sessionErrorPresentation(null)).toBeNull();
    expect(sessionErrorPresentation(undefined)).toBeNull();
    expect(isSessionErrorCode('session.unknown')).toBe(false);
  });
});

describe('extractSessionErrorCode', () => {
  it('recovers the code from a fully tagged worker error', () => {
    const message = 'API Key 无效或已失效，请更新平台凭据: Invalid api-key provided (code=InvalidApiKey)'
      + ' | code: session.credential-invalid | recommended: update-provider-credentials';
    expect(extractSessionErrorCode(message)).toBe('session.credential-invalid');
  });

  it('recovers the code when no recommended marker follows', () => {
    expect(extractSessionErrorCode('boom | code: session.network-unreachable')).toBe('session.network-unreachable');
  });

  it('returns null for legacy strings without a code marker', () => {
    expect(extractSessionErrorCode('设备初始化失败 | recommended: switch-device')).toBeNull();
    expect(extractSessionErrorCode('plain error text')).toBeNull();
  });

  it('returns null for codes outside the session/audio domains', () => {
    expect(extractSessionErrorCode('bridge down | code: driver.bridge-lost | recommended: restart-bridge')).toBeNull();
  });
});


describe('sessionLaunchErrorCode', () => {
  it('classifies a structured ServiceError, including Error objects with metadata', () => {
    const error = Object.assign(new Error('no authority'), { code: 'model_protocol.model_not_registered' });
    expect(sessionLaunchErrorCode(error, error.message)).toBe('session.model-reference-invalid');
    expect(sessionLaunchErrorCode({ code: 'model_protocol.operation_not_supported', message: 'unsupported' }, 'unsupported')).toBe('session.model-reference-invalid');
  });
  it('classifies provider manifest authority failures without discarding their domain', () => {
    const code = 'provider_manifest.profile_unimplemented';
    const error = Object.assign(new Error('profile is not implemented'), { code });
    expect(sessionLaunchErrorCode(error, error.message)).toBe('session.model-reference-invalid');
    expect(sessionLaunchErrorCode({ code, message: error.message }, error.message)).toBe('session.model-reference-invalid');
    expect(sessionLaunchErrorCode(new Error(code), code)).toBe('session.model-reference-invalid');
    expect(sessionErrorPresentation(sessionLaunchErrorCode(error, error.message))?.action).toBe('open-providers');
  });
  it('preserves existing classifications and does not guess unknown errors', () => {
    expect(sessionLaunchErrorCode({ code: 'session.credential-invalid' }, 'unauthorized')).toBe('session.credential-invalid');
    expect(sessionLaunchErrorCode(new Error('model_protocol.model_not_registered'), 'model_protocol.model_not_registered')).toBe('session.model-reference-invalid');
    expect(sessionLaunchErrorCode(new Error('unknown'), 'unknown')).toBe('session.launch-precheck-failed');
  });
});


import {
  explainModelProtocolError,
  formatModelErrorSummary,
  parseModelContext,
} from "./session-error-presentation";

describe("parseModelContext & explainModelProtocolError & formatModelErrorSummary", () => {
  const t = (k: string) => "t:" + k;

  it("parses modelContext json from detail string and preserves diagnostic details", () => {
    const raw = "model_protocol.adapter_unavailable: LiveTranslate adapter is not authorized | modelContext: {\"modelRole\":\"primary-audio\",\"modelId\":\"qwen3.8-flash\",\"providerId\":\"p1\"} | code: session.model-reference-invalid";
    const parsed = parseModelContext(null, raw);
    expect(parsed.context).toMatchObject({
      modelRole: "primary-audio",
      modelId: "qwen3.8-flash",
      providerId: "p1",
    });
    expect(parsed.modelProtocolCode).toBe("model_protocol.adapter_unavailable");
    expect(parsed.cleanedDetail).not.toContain("modelContext:");
  });

  it("parses context from error object details", () => {
    const errorObj = {
      code: "model_protocol.endpoint_host_region_mismatch",
      details: {
        modelRole: "speech-output",
        modelId: "cosyvoice-v1",
      },
    };
    const parsed = parseModelContext(errorObj);
    expect(parsed.context).toMatchObject({
      modelRole: "speech-output",
      modelId: "cosyvoice-v1",
    });
    expect(parsed.modelProtocolCode).toBe("model_protocol.endpoint_host_region_mismatch");
  });

  it("explains missing protocol, adapter unavailable, endpoint invalid, and provider disabled", () => {
    expect(explainModelProtocolError("model_protocol.model_not_registered", t)?.reasonKey).toBe("session.modelReason.missing-protocol");
    expect(explainModelProtocolError("model_protocol.adapter_unavailable", t)?.reasonKey).toBe("session.modelReason.adapter-unavailable");
    expect(explainModelProtocolError("model_protocol.endpoint_host_region_mismatch", t)?.reasonKey).toBe("session.modelReason.endpoint-invalid");
    expect(explainModelProtocolError("model_protocol.authorization_identity_mismatch", t)?.reasonKey).toBe("session.modelReason.authorization-identity-mismatch");
    expect(explainModelProtocolError("provider_manifest.provider_disabled", t)?.reasonKey).toBe("session.modelReason.provider-disabled");
    expect(explainModelProtocolError(null, t)).toBeNull();
  });

  it("distinguishes outbound audio from independent speech synthesis", () => {
    expect(parseModelContext(null, "outboundVoiceModelId=platform::audio").context?.modelRole).toBe("primary-audio");
    expect(parseModelContext(null, "speech-output failed").context?.modelRole).toBe("speech-output");
  });

  it("formats model error summary without leaking JSON", () => {
    const raw = "model_protocol.model_not_registered: no authority | modelContext: {\"modelRole\":\"primary-audio\",\"modelId\":\"qwen-audio\"} | code: session.model-reference-invalid";
    const formatted = formatModelErrorSummary(null, raw, t);
    expect(formatted).not.toContain("{");
    expect(formatted).not.toContain("modelContext");
    expect(formatted).toBe("t:session.modelRole.primary-audio (qwen-audio): t:session.modelReason.missing-protocol");
  });

  it("falls back gracefully when role or explanation are partial", () => {
    expect(formatModelErrorSummary(null, "unknown model failure", t)).toBe("t:session.modelReason.unknown");
    expect(formatModelErrorSummary(null, "primary-audio failed unexpectedly", t)).toBe("t:session.modelRole.primary-audio: t:session.modelReason.unknown");
    expect(formatModelErrorSummary(null, "model_protocol.endpoint_host_required", t)).toBe("t:session.modelReason.endpoint-invalid");
  });
});


describe('native identity failure presentation', () => {
  const code = 'model_protocol.authorization_identity_mismatch';
  const raw = code + ': Watch report protocol identity changed during one session';
  const t = (key: string) => key;

  it.each([
    raw,
    raw + ' | code: session.model-reference-invalid | recommended: update-model-selection',
    raw + ' | modelContext: {"modelRole":"primary-audio","modelId":"qwen"} | code: session.model-reference-invalid',
  ])('recognizes the actual session conflict without claiming the model is invalid: %s', (detail) => {
    expect(formatModelErrorSummary(null, detail, t)).toBe('session.modelReason.session-identity-conflict');
    const launchCode = sessionLaunchErrorCode(new Error(detail), detail);
    expect(launchCode).toBe('session.launch-precheck-failed');
    expect(sessionErrorPresentation(launchCode)?.action).toBe('restart-session');
    expect(parseModelContext(null, detail).cleanedDetail).toContain(raw);
  });

  it.each([
    'Watch report protocol identity changed while another route still owns the session',
    'Watch report previous provider owner could not be retired',
  ])('recognizes an explicitly rejected session handoff: %s', (reason) => {
    const rawDetail = code + ': ' + reason;
    const tagged = rawDetail + ' | modelContext: {"modelRole":"primary-audio","modelId":"qwen"} | code: session.model-reference-invalid';
    const retirementDetail = rawDetail + ' | retirementContext: direction=inbound reason=watch_model_handoff; parked sender has no joinable owner';
    for (const detail of [rawDetail, tagged, retirementDetail]) {
      expect(formatModelErrorSummary(null, detail, t)).toBe('session.modelReason.session-identity-conflict');
      const launchCode = sessionLaunchErrorCode(new Error(detail), detail);
      expect(launchCode).toBe('session.launch-precheck-failed');
      expect(sessionErrorPresentation(launchCode)?.action).toBe('restart-session');
      expect(parseModelContext(null, detail).cleanedDetail).toContain(rawDetail);
    }
    const error = { code, message: reason };
    expect(formatModelErrorSummary(error, '', t)).toBe('session.modelReason.session-identity-conflict');
    expect(sessionLaunchErrorCode(error, '')).toBe('session.launch-precheck-failed');
  });

  it('uses the message from structured errors even when detail is empty', () => {
    const error = { code, message: 'Watch report protocol identity changed during one session' };
    expect(formatModelErrorSummary(error, '', t)).toBe('session.modelReason.session-identity-conflict');
    expect(sessionLaunchErrorCode(error, '')).toBe('session.launch-precheck-failed');
  });

  it.each([
    code,
    code + ': unknown Watch report identity mismatch',
    code + ': Watch report previous provider owner could not be retired unexpectedly',
    code + ": Watch report model 'qwen-audio' does not match authorized exactModelId 'qwen-livetranslate'",
    code + ": provider model 'qwen-audio' does not match invocation model 'qwen-livetranslate'",
    code + ': signed Watch identity does not match the Desktop-authorized Provider send boundary',
    'provider_manifest.provider_owner_mismatch: Workspace template cannot claim runtime owner',
  ])('does not mislabel other identity/ownership failures as a session conflict: %s', (detail) => {
    expect(formatModelErrorSummary(null, detail, t)).toBe('session.modelReason.authorization-identity-mismatch');
    expect(sessionLaunchErrorCode(null, detail)).toBe('session.model-reference-invalid');
    expect(parseModelContext(null, detail).cleanedDetail).toBe(detail);
  });

  it('does not match diagnostic keywords appearing only in modelContext JSON', () => {
    const detail = code + ': unknown identity failure | modelContext: {"modelId":"Watch report protocol identity changed during one session"}';
    expect(formatModelErrorSummary(null, detail, t)).not.toBe('session.modelReason.session-identity-conflict');
  });

  it('keeps unknown diagnostic codes without inventing a provider problem or exposing raw JSON', () => {
    const detail = 'model_protocol.new_failure: secret detail | modelContext: {"providerId":"p1"}';
    expect(formatModelErrorSummary(null, detail, t)).toBe('session.modelReason.unknown [model_protocol.new_failure]');
    expect(formatModelErrorSummary(null, 'provider_manifest.provider_disabled', t)).toBe('session.modelReason.provider-disabled');
    expect(formatModelErrorSummary(null, 'model_protocol.not_authorized', t)).toBe('session.modelReason.reference-invalid');
  });

  it('provides the same reason keys in every locale, with accurate Chinese and English copy', () => {
    const locales = import.meta.glob('../i18n/locales/*.json', { eager: true, import: 'default' }) as Record<string, { session: { modelReason: Record<string, string> } }>;
    const expectedKeys = Object.keys(locales['../i18n/locales/en.json'].session.modelReason).sort();
    for (const [path, locale] of Object.entries(locales)) {
      expect(Object.keys(locale.session.modelReason).sort(), path).toEqual(expectedKeys);
      for (const key of ['session-identity-conflict', 'authorization-identity-mismatch', 'reference-invalid', 'unknown']) {
        expect(typeof locale.session.modelReason[key], path + ':' + key).toBe('string');
        expect(locale.session.modelReason[key], path + ':' + key).not.toBe('');
      }
    }
    const en = locales['../i18n/locales/en.json'].session.modelReason;
    const zh = locales['../i18n/locales/zh-CN.json'].session.modelReason;
    expect(en['session-identity-conflict']).toContain('same session');
    expect(zh['session-identity-conflict']).toContain('同一会话');
    expect(zh['authorization-identity-mismatch']).toContain('授权信息不一致');
    expect(en.unknown).not.toMatch(/disabled|invalid/);
    expect(zh.unknown).not.toMatch(/失效|禁用/);
  });
  it('keeps the generic model-check fallback neutral in every language', () => {
    const locales = import.meta.glob('../i18n/locales/*.json', { eager: true, import: 'default' }) as Record<string, { session: { errorCode: { modelReferenceInvalid: string } } }>;
    const expected: Record<string, string> = {
    "zh-CN": "模型调用检查未通过，请查看具体原因及技术详情。",
    "en": "The model invocation check failed. Please review the specific reason and technical details.",
    "ar": "لم يجتز استدعاء النموذج التحقق. يرجى مراجعة السبب المحدد والتفاصيل التقنية.",
    "bn": "মডেল আহ্বানের যাচাই ব্যর্থ হয়েছে। নির্দিষ্ট কারণ ও প্রযুক্তিগত বিবরণ দেখুন।",
    "de": "Die Prüfung des Modellaufrufs ist fehlgeschlagen. Bitte prüfen Sie den konkreten Grund und die technischen Details.",
    "es": "La comprobación de la invocación del modelo falló. Consulte el motivo específico y los detalles técnicos.",
    "fil": "Hindi pumasa sa pagsusuri ang pagtawag sa modelo. Tingnan ang tiyak na dahilan at mga teknikal na detalye.",
    "fr": "La vérification de l’appel au modèle a échoué. Consultez la cause précise et les détails techniques.",
    "hi": "मॉडल कॉल की जाँच विफल हुई। कृपया विशिष्ट कारण और तकनीकी विवरण देखें।",
    "id": "Pemeriksaan pemanggilan model gagal. Silakan lihat alasan spesifik dan detail teknis.",
    "ja": "モデル呼び出しのチェックに失敗しました。具体的な原因と技術的な詳細を確認してください。",
    "ko": "모델 호출 검사에 실패했습니다. 구체적인 원인과 기술 세부 정보를 확인하세요.",
    "mr": "मॉडेल कॉलची तपासणी अयशस्वी झाली. कृपया नेमके कारण आणि तांत्रिक तपशील पहा.",
    "pt": "A verificação da chamada ao modelo falhou. Consulte o motivo específico e os detalhes técnicos.",
    "ru": "Проверка вызова модели не пройдена. Ознакомьтесь с конкретной причиной и техническими подробностями.",
    "ta": "மாதிரி அழைப்பின் சரிபார்ப்பு தோல்வியடைந்தது. குறிப்பிட்ட காரணத்தையும் தொழில்நுட்ப விவரங்களையும் பார்க்கவும்.",
    "te": "మోడల్ కాల్ తనిఖీ విఫలమైంది. నిర్దిష్ట కారణం మరియు సాంకేతిక వివరాలను చూడండి.",
    "th": "การตรวจสอบการเรียกใช้โมเดลไม่ผ่าน โปรดดูสาเหตุที่เฉพาะเจาะจงและรายละเอียดทางเทคนิค",
    "tr": "Model çağrısı denetimi başarısız oldu. Lütfen belirli nedeni ve teknik ayrıntıları inceleyin.",
    "vi": "Kiểm tra lời gọi mô hình không thành công. Vui lòng xem nguyên nhân cụ thể và chi tiết kỹ thuật."
};
    expect(Object.keys(locales).length).toBe(Object.keys(expected).length);
    for (const [locale, copy] of Object.entries(expected)) {
      expect(locales['../i18n/locales/' + locale + '.json'].session.errorCode.modelReferenceInvalid, locale).toBe(copy);
    }
  });

});
