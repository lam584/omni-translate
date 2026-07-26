import { describe, expect, it } from 'vitest';
import {
  extractSessionErrorCode,
  isSessionErrorCode,
  sessionErrorPresentation,
} from './session-error-presentation';
import type { SessionErrorCode } from '../schema/audio-runtime';

const ALL_CODES: SessionErrorCode[] = [
  'session.credential-invalid',
  'session.quota-exceeded',
  'session.voice-unsupported',
  'session.network-unreachable',
  'session.provider-internal',
  'audio.device-lost',
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
