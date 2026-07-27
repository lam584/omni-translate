import { describe, expect, it } from 'vitest';
import type { RuntimeNotification } from '../../schema/runtime-core';
import { runtimeErrorPresentation } from './runtime-toast-helpers';

describe('runtimeErrorPresentation', () => {
  it('normalizes a tagged native failure into the unified error shape', () => {
    const notification: RuntimeNotification = {
      id: 'worker-1',
      level: 'error',
      source: 'session',
      message: 'socket refused | code: session.network-unreachable | recommended: restart-session',
      emittedAt: '2026-07-27T00:00:00.000Z',
    };

    expect(runtimeErrorPresentation(notification, (key) => `translated:${key}`)).toEqual({
      code: 'session.network-unreachable',
      title: 'session',
      summary: 'translated:session.errorCode.networkUnreachable [session.network-unreachable]',
      technicalDetail: 'socket refused',
      recoveryActions: ['restart-session'],
      source: 'session',
    });
  });
});
